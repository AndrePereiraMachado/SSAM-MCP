using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Preflight;

namespace Anvil.Reading;

// CX16 (2026-10-15): a few elements of a read screen or block changed without sending the document again. The model names
// what changes on the READING (ssam-html/1, canonical: ScreenHtmlText) and the kernel writes the whole document from it; the
// document then goes the way of today (the edit form with the whole document as its only edit: plan, three-way merge when the
// screen changed, write, Verify). Pure: positions over the base text (Preflight.HtmlText, never re-serialized), the result read
// with the strict parser (ScreenHtml.Parse). Every problem of every edit comes in one list.
//
//   {find:"exact text", with:"text"}                  the ONLY occurrence of the text in the base (with "" removes it)
//   {set:"w17", attributes:{"class":"a b","x":null}}  the open tag only: a value replaces (in place), null removes, a new one
//                                                     is appended; never k; the children stay
//   {replace:"w17", with:"<div ...>...</div>"}        the element whole (an If with its <div else>); a root without k is w17
//   {delete:"w17"}                                    the element (and its else)
//   {after|before:"w17", insert:"..."}                new elements (no k) as siblings
//   {into:"w5"|"w5/Content"|"w23.true"|"w23.false"|"/", insert:"...", at:"first"|"last"}   new children (last by default)
//   {move:"w9", after|before|into:"..."}              the same element (its k kept) somewhere else
// An address is a k of the reading, a slot k/Name, a branch k.true / k.false, the root "/", or @ObjectKey (the key table).
// R1 every edit addresses the BASE (a find first, on the base text; a target whose text a find changes is an overlap);
// R2 inserted and replaced text is written in the canonical form at its depth (one element a line, +1 space a level), the
// rest of the base byte for byte; R3 set and replace keep the element (its k); R5 an edit that changes nothing gives the base;
// R6 (CX16 r3) a k of the reading written again (find/with, replace) names its own element: a reorder moves each element with
// its own text, and a set goes with the move of its element.
public static class HtmlElementEdits
{
    public const string TargetUnknown = "HTML_EDIT_TARGET_UNKNOWN", TextNotUnique = "HTML_EDIT_TEXT_NOT_UNIQUE";
    public const int MaxEdits = 500;

    private static readonly string[] AddressKeys = ["find", "set", "replace", "delete", "after", "before", "into", "move"];
    private static readonly string[] Destinations = ["after", "before", "into"];
    private static readonly HashSet<string> Known = new(StringComparer.Ordinal)
        { "find", "with", "set", "attributes", "replace", "delete", "after", "before", "into", "insert", "at", "move" };
    private const string Forms = "an edit is {find, with}, {set, attributes}, {replace, with}, {delete}, {after|before|into, insert[, at]} or {move, after|before|into}";

    private sealed class Edit
    {
        public int Index; public string Kind = ""; public string Address = "";
        public string? With, Insert, At, Destination, DestinationKind;
        public JsonObject? Attributes;
    }

    // ---- the shape (no base) -------------------------------------------------------------------------------------------

    /// <summary>The problems of the shape of an edit list, without the base (the preflight of a job whose reading is not
    /// kept here): every problem at once, pointers /edits/j relative to op.data.</summary>
    public static List<JsonObject> Shape(JsonNode? edits)
    {
        var problems = new List<JsonObject>();
        Read(edits, problems);
        return problems;
    }

    private static List<Edit?> Read(JsonNode? node, List<JsonObject> problems)
    {
        var list = new List<Edit?>();
        if (node is not JsonArray edits) {
            problems.Add(Problem("/edits", ScreenHtmlEdit.Invalid, "html edits: 'edits' is a list of edits (" + Forms + ")", Example));
            return list;
        }
        if (edits.Count == 0) problems.Add(Problem("/edits", ScreenHtmlEdit.Invalid, "html edits: 'edits' is empty", Example));
        if (edits.Count > MaxEdits) problems.Add(Problem("/edits", ScreenHtmlEdit.Invalid, $"html edits: {edits.Count} edits, at most {MaxEdits} in one op", "split the change in two ops of the same screen, or send the whole document"));
        for (var j = 0; j < edits.Count; j++) list.Add(ReadOne(edits[j], j, problems));
        return list;
    }

    private const string Example = "\"edits\": [{\"set\": \"w7\", \"attributes\": {\"class\": \"card\"}}, {\"find\": \"<exact text of the reading>\", \"with\": \"<new text>\"}]";

    private static Edit? ReadOne(JsonNode? node, int j, List<JsonObject> problems)
    {
        var at = "/edits/" + j;
        var before = problems.Count;
        void Bad(string message, string? fix = null) => problems.Add(Problem(at, ScreenHtmlEdit.Invalid, message, fix ?? Example));
        if (node is not JsonObject o) { Bad("an edit is an object: " + Forms); return null; }
        string? Text(string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        var unknown = o.Select(p => p.Key).Where(k => !Known.Contains(k)).ToList();
        if (unknown.Count > 0) Bad("unknown key" + (unknown.Count > 1 ? "s " : " ") + string.Join(", ", unknown) + ": " + Forms);
        var edit = new Edit { Index = j };
        if (o.ContainsKey("move")) {
            edit.Kind = "move";
            var others = AddressKeys.Where(k => k is not ("move" or "after" or "before" or "into") && o.ContainsKey(k)).ToList();
            if (others.Count > 0) Bad("one address per edit: move and " + string.Join(", ", others));
            var destinations = Destinations.Where(o.ContainsKey).ToList();
            if (destinations.Count != 1) Bad("move needs exactly one destination: after, before or into", "{\"move\": \"w9\", \"after\": \"w3\"}");
            else {
                edit.DestinationKind = destinations[0];
                edit.Destination = Text(destinations[0]);
                if (string.IsNullOrWhiteSpace(edit.Destination)) Bad(destinations[0] + " of a move is an address (a k, k/Slot, k.true, k.false, / or @ObjectKey)");
            }
            foreach (var key in new[] { "with", "insert", "attributes" }) if (o.ContainsKey(key)) Bad("move takes no " + key + ": it moves the element as it is");
            if (o.ContainsKey("at") && edit.DestinationKind != "into") Bad("at goes with into");
        } else {
            var addresses = AddressKeys.Where(o.ContainsKey).ToList();
            if (addresses.Count != 1) { Bad(addresses.Count == 0 ? "an edit names one address: " + Forms : "one address per edit, this one has " + string.Join(", ", addresses)); return null; }
            edit.Kind = addresses[0];
        }
        edit.Address = Text(edit.Kind) ?? "";
        if (o[edit.Kind] is not JsonValue || Text(edit.Kind) == null) Bad(edit.Kind + " is a string" + (edit.Kind == "find" ? " (the exact text of the reading)" : " (a k, k/Slot, k.true, k.false, / or @ObjectKey)"));
        else if (edit.Address.Length == 0) Bad(edit.Kind + " is empty");
        void Not(params string[] keys) { foreach (var key in keys) if (o.ContainsKey(key)) Bad(edit.Kind + " takes no " + key + ": " + Forms); }
        switch (edit.Kind) {
            case "find":
                edit.With = Text("with");
                if (o["with"] is not JsonValue || edit.With == null) Bad("find needs with (the text in its place; \"\" removes it)", "{\"find\": \"class=\\\"btn\\\"\", \"with\": \"class=\\\"btn btn-primary\\\"\"}");
                Not("attributes", "insert", "at");
                break;
            case "set":
                if (o["attributes"] is not JsonObject attributes || attributes.Count == 0) Bad("set needs attributes: an object of attribute -> new value (null removes it)", "{\"set\": \"w7\", \"attributes\": {\"class\": \"card\"}}");
                else {
                    edit.Attributes = attributes;
                    foreach (var (name, value) in attributes) {
                        if (name == "k") Bad("set never changes k: the element keeps its key");
                        else if (!ValidName(name)) Bad("\"" + name + "\" is not an attribute name");
                        if (value != null && (value is not JsonValue v || !v.TryGetValue<string>(out _))) Bad("the value of " + name + " is a string (or null to remove it)");
                    }
                }
                Not("with", "insert", "at");
                break;
            case "replace":
                edit.With = Text("with");
                if (string.IsNullOrWhiteSpace(edit.With)) Bad("replace needs with: the element whole (delete removes it)");
                Not("attributes", "insert", "at");
                break;
            case "delete":
                Not("with", "attributes", "insert", "at");
                break;
            case "after": case "before": case "into":
                edit.Insert = Text("insert");
                if (string.IsNullOrWhiteSpace(edit.Insert)) Bad(edit.Kind + " needs insert: the new element(s), without k");
                Not("with", "attributes");
                if (edit.Kind != "into" && o.ContainsKey("at")) Bad("at goes with into");
                break;
        }
        if (o.ContainsKey("at")) {
            edit.At = Text("at");
            if (edit.At is not ("first" or "last")) Bad("at is \"first\" or \"last\"");
        }
        return problems.Count == before ? edit : null;
    }

    private static bool ValidName(string name) => name.Length > 0 && name.All(c => !char.IsWhiteSpace(c) && c is not ('=' or '>' or '<' or '"' or '\'' or '/'));

    // ---- the apply (on the base) -------------------------------------------------------------------------------------

    private sealed record Span(int Start, int End, string Text, int Edit, int Order);
    // What an edit holds of the base: a region [Start, End) or a point (Start == End, Point); Element: the element it changes
    // itself (set, replace, delete, move) or addresses (after, before, into), for the rule of one change per element.
    // CX16 r3 (M5): Moves marks the claim of a move on its element, BesideMove the set that goes with that move (one change).
    private sealed record Claim(int Edit, int Start, int End, bool Point, HtmlText.Element? Element, bool Changes, bool Whole = false, bool Moves = false, bool BesideMove = false);

    private sealed class Base
    {
        public required string Source;
        public required HtmlText Text;
        public required HtmlText.Element Root;
        public readonly Dictionary<string, HtmlText.Element> ByK = new(StringComparer.Ordinal);
        public readonly Dictionary<HtmlText.Element, ScreenHtml.Node> Node = new(ReferenceEqualityComparer.Instance);
        public readonly Dictionary<string, string> AddressOfObjectKey = new(StringComparer.Ordinal);
    }

    /// <summary>The document a list of edits makes of a reading: (the whole document, every problem, the k touched). With
    /// problems the document is the base. <paramref name="keyTable"/>: k -> ObjectKey of the reading (@ObjectKey addresses).</summary>
    public static (string Document, List<JsonObject> Problems, List<string> Touched) Apply(string baseText, JsonArray edits, IReadOnlyDictionary<string, string>? keyTable)
    {
        var (document, problems, touched) = Apply(baseText, edits, keyTable, out _);
        return (document, problems, touched);
    }

    /// <summary><see cref="Apply(string, JsonArray, IReadOnlyDictionary{string, string}?)"/> with the edit that touched each k
    /// (<paramref name="editOf"/>: k of the base -> index of the edit), for the problems of the plan that name a k.</summary>
    public static (string Document, List<JsonObject> Problems, List<string> Touched) Apply(string baseText, JsonArray edits, IReadOnlyDictionary<string, string>? keyTable, out Dictionary<string, int> editOf)
    {
        var problems = new List<JsonObject>();
        var read = Read(edits, problems);
        var touched = new List<string>();
        editOf = new Dictionary<string, int>(StringComparer.Ordinal);
        Base b;
        try { b = Load(baseText, keyTable); }
        catch (FormatException error) {
            problems.Add(Problem("/basedOn", ScreenHtmlEdit.Invalid, "the reading the edits were written on does not read as ssam-html/1: " + error.Message, "read the screen again (ssam_map view html)"));
            return (baseText, problems, touched);
        }
        var spans = new List<Span>();
        var claims = new List<Claim>();
        var keysWritten = new List<(int Edit, string K)>();
        var setBesideMove = SetsBesideMoves(b, read);
        foreach (var edit in read) {
            if (edit == null) continue;
            var before = problems.Count;
            var mark = touched.Count;
            try { Plan(b, edit, spans, claims, keysWritten, touched, problems, setBesideMove); }
            catch (FormatException error) {
                problems.Add(Problem(At(edit), ScreenHtmlEdit.Invalid, error.Message, "every element closes (or is <x/>), every attribute value is quoted, & is written &amp; and < inside text &lt;"));
            }
            if (problems.Count > before) { spans.RemoveAll(s => s.Edit == edit.Index); claims.RemoveAll(c => c.Edit == edit.Index); touched.RemoveRange(mark, touched.Count - mark); }
            else foreach (var k in touched.Skip(mark)) editOf.TryAdd(k, edit.Index);
        }
        Overlaps(b, claims, problems);
        // A k written by an insert or a replace that the base has elsewhere: the element would be there twice.
        foreach (var group in keysWritten.GroupBy(x => x.K)) {
            var editsOf = group.Select(x => x.Edit).Distinct().ToList();
            if (editsOf.Count > 1)
                foreach (var j in editsOf) problems.Add(Problem("/edits/" + j, ScreenHtmlEdit.KeyTwice, "k=\"" + group.Key + "\" is written by edits " + string.Join(", ", editsOf.Select(e => "#" + e)) + ": an element is written once",
                    "keep it in one edit; to put it elsewhere, move it"));
        }
        if (problems.Count > 0) return (baseText, Sorted(problems), touched);
        var document = Compose(baseText, spans);
        try { ScreenHtml.Parse(document); }
        catch (FormatException error) {
            // Which edit breaks it: each one alone; else the combination.
            var blamed = false;
            foreach (var j in spans.Select(s => s.Edit).Distinct()) {
                try { ScreenHtml.Parse(Compose(baseText, spans.Where(s => s.Edit == j).ToList())); }
                catch (FormatException alone) { problems.Add(Problem("/edits/" + j, ScreenHtmlEdit.Invalid, "the document with this edit does not read: " + alone.Message, "every element closes (or is <x/>), every attribute value is quoted, & is written &amp;")); blamed = true; }
            }
            if (!blamed) problems.Add(Problem("/edits", ScreenHtmlEdit.Invalid, "the document with the edits does not read: " + error.Message, "check the find/with texts against the reading"));
            return (baseText, Sorted(problems), touched);
        }
        return (document, problems, touched.Distinct(StringComparer.Ordinal).ToList());
    }

    // In the order of the edits (a problem of the whole list first), as found within one edit.
    private static List<JsonObject> Sorted(List<JsonObject> problems) => problems
        .Select((p, n) => (p, n, j: p["pointer"]?.ToString() is { } at && at.StartsWith("/edits/", StringComparison.Ordinal) && int.TryParse(at["/edits/".Length..], out var index) ? index : -1))
        .OrderBy(x => x.j).ThenBy(x => x.n).Select(x => x.p).ToList();

    private static string At(Edit edit) => "/edits/" + edit.Index;

    private static Base Load(string source, IReadOnlyDictionary<string, string>? keyTable)
    {
        var parsed = ScreenHtml.Parse(source);
        var text = HtmlText.Parse(source);
        var root = text.Root.Children.FirstOrDefault() ?? throw new FormatException("ssam-html: the reading is empty");
        var b = new Base { Source = source, Text = text, Root = root };
        // The two readings of the same text, element by element in document order (the strict tree for the values).
        var positions = text.Elements().ToList();
        var nodes = ScreenHtmlText.Elements(parsed).Select(x => x.Node).Where(n => n.Tag != "#document").ToList();
        if (positions.Count != nodes.Count || positions.Zip(nodes).Any(p => !p.First.Tag.Equals(p.Second.Tag, StringComparison.OrdinalIgnoreCase)))
            throw new FormatException("ssam-html: the reading's elements could not be paired by position");
        for (var i = 0; i < positions.Count; i++) {
            b.Node[positions[i]] = nodes[i];
            if (positions[i].Get("k") is { Length: > 0 } k) b.ByK.TryAdd(k, positions[i]);
        }
        if (keyTable != null)
            foreach (var (k, objectKey) in keyTable) {
                if (string.IsNullOrEmpty(objectKey) || k.Contains('~') || k.Contains(':')) continue;
                b.AddressOfObjectKey.TryAdd(objectKey, k.Length == 0 ? "/" : k);
            }
        return b;
    }

    // ---- addresses ------------------------------------------------------------------------------------------------------

    // A resolved address: the element (or the If, for a branch), what part of it (element, slot, true, false, root) and,
    // for a slot or a false branch that the reading does not write, the element that would hold it.
    private sealed record Target(string Address, HtmlText.Element? Element, string Part, string? SlotName, HtmlText.Element Holder);

    private static Target? Resolve(Base b, string address, Edit edit, string role, List<JsonObject> problems)
    {
        var original = address;
        if (address.StartsWith('@')) {
            if (!b.AddressOfObjectKey.TryGetValue(address[1..], out var mapped)) {
                problems.Add(Unknown(edit, role, original, "@" + address[1..] + " is not in the key table of this reading" + (b.AddressOfObjectKey.Count == 0 ? " (no key table is kept for it: address the element by its k)" : ""), []));
                return null;
            }
            address = mapped;
        }
        if (address == "/") return new Target(original, b.Root, "root", null, b.Root);
        string k = address, part = "element"; string? slot = null;
        var slash = address.IndexOf('/');
        if (slash > 0) { k = address[..slash]; slot = address[(slash + 1)..]; part = "slot"; }
        else if (address.EndsWith(".true", StringComparison.Ordinal)) { k = address[..^5]; part = "true"; }
        else if (address.EndsWith(".false", StringComparison.Ordinal)) { k = address[..^6]; part = "false"; }
        if (!b.ByK.TryGetValue(k, out var element)) {
            problems.Add(Unknown(edit, role, original, "k=\"" + k + "\" is not an element of this reading", NearKeys(b, k)));
            return null;
        }
        if (part is "true" or "false" && !IsIf(element)) {
            problems.Add(Problem(At(edit), TargetUnknown, original + ": " + k + " is not an If (<div if>), it has no " + part + " branch", "address the element (" + k + ") or the branch of an If", Line(b, element)));
            return null;
        }
        if (part == "slot") {
            var slots = element.Children.Where(c => c.Tag == "slot").ToList();
            var found = slots.FirstOrDefault(s => s.Get("name") == slot);
            if (found != null) return new Target(original, found, "slot", slot, element);
            if (role != "into" || !element.Tag.Equals("Block", StringComparison.Ordinal) || slot!.Length == 0 || !ValidName(slot)) {
                var problem = Unknown(edit, role, original, "k=\"" + k + "\" has no slot \"" + slot + "\"", slots.Select(s => k + "/" + s.Get("name")).ToList());
                problem["element"] = Line(b, element);
                problems.Add(problem);
                return null;
            }
            // A placeholder the reading does not write (it is empty): into creates it; the plan judges its name (HTML_SLOT_UNKNOWN).
            return new Target(original, null, "slot", slot, element);
        }
        if (part == "false") {
            var elsePart = ElseOf(element);
            return new Target(original, elsePart, "false", null, element);
        }
        return new Target(original, element, part, null, element);
    }

    private static JsonObject Unknown(Edit edit, string role, string address, string message, List<string> candidates)
    {
        var problem = Problem(At(edit), TargetUnknown, (role == edit.Kind ? edit.Kind : edit.Kind + " " + role) + " \"" + address + "\": " + message,
            candidates.Count > 0 ? "use one of " + string.Join(", ", candidates) + " (read the screen again if it changed)" : "address an element by the k of the reading (ssam_map view html), k/Slot, k.true, k.false or /");
        if (candidates.Count > 0) problem["candidates"] = new JsonArray(candidates.Select(c => (JsonNode)c).ToArray());
        return problem;
    }

    // The k nearest to an unknown one: the closest numbers, with the parent of the nearest.
    private static List<string> NearKeys(Base b, string k)
    {
        static int? Number(string key) => key.Length > 1 && key[0] == 'w' && int.TryParse(key[1..], out var n) ? n : null;
        var target = Number(k);
        var keys = b.ByK.Keys.ToList();
        var near = target is { } t
            ? keys.Where(x => Number(x) != null).OrderBy(x => Math.Abs(Number(x)!.Value - t)).ThenBy(x => Number(x)).Take(3).ToList()
            : ScreenHtmlEdit.Closest(k, keys);
        if (near.Count > 0 && b.ByK[near[0]].Parent is { } parent && parent.Get("k") is { } pk && !near.Contains(pk)) near.Add(pk);
        return near;
    }

    private static bool IsIf(HtmlText.Element e) => e.Tag == "div" && e.Find("if") != null;
    private static bool IsElse(HtmlText.Element e) => e.Tag == "div" && e.Attributes.Count == 1 && e.Attributes[0].Name == "else";

    private static HtmlText.Element? ElseOf(HtmlText.Element element)
    {
        if (!IsIf(element) || element.Parent == null) return null;
        var siblings = element.Parent.Children;
        var i = siblings.IndexOf(element);
        return i >= 0 && i + 1 < siblings.Count && IsElse(siblings[i + 1]) ? siblings[i + 1] : null;
    }

    private static int Depth(HtmlText.Element e)
    {
        var depth = 0;
        for (var p = e.Parent; p != null && p.Tag.Length > 0; p = p.Parent) depth++;
        return depth;
    }

    private static string Indent(int depth) => depth <= 1 ? "" : new string(' ', depth - 1);

    private static int LineStart(string s, int at) { var nl = at <= 0 ? -1 : s.LastIndexOf('\n', at - 1); return nl + 1; }
    private static int LineEnd(string s, int at) { var nl = s.IndexOf('\n', Math.Min(Math.Max(at, 0), s.Length)); return nl < 0 ? s.Length : nl + 1; }

    // The open tag line of an element, as the reading has it (the evidence of a problem).
    private static string Line(Base b, HtmlText.Element e)
    {
        var start = LineStart(b.Source, e.OpenStart);
        var end = b.Source.IndexOf('\n', e.OpenStart);
        var line = b.Source[start..(end < 0 ? b.Source.Length : end)].Trim();
        return line.Length > 200 ? line[..200] + "…" : line;
    }

    private static bool SelfClosed(Base b, HtmlText.Element e) => e.OpenEnd >= 2 && b.Source[e.OpenEnd - 2] == '/' && b.Source[e.OpenEnd - 1] == '>';
    // Where the open tag's > (or />) starts.
    private static int TagClose(Base b, HtmlText.Element e) => SelfClosed(b, e) ? e.OpenEnd - 2 : e.OpenEnd - 1;
    private static string CloseTag(HtmlText.Element e) => "</" + e.Tag + ">";
    private static int CloseStart(Base b, HtmlText.Element e) => b.Source.LastIndexOf("</", e.End - 1, StringComparison.Ordinal);
    // Whether the element's closing tag is on its own line (children one a line), as the reading writes an element with children.
    private static bool MultiLine(Base b, HtmlText.Element e) => !SelfClosed(b, e) && e.Tag != "style" && b.Source.IndexOf('\n', e.OpenEnd, Math.Max(0, CloseStart(b, e) - e.OpenEnd)) >= 0;

    // The lines an element takes (with its else, for an If): [line start of the open tag, after the line of its end).
    private static (int Start, int End) Lines(Base b, HtmlText.Element e)
    {
        var last = ElseOf(e) ?? e;
        return (LineStart(b.Source, e.OpenStart), LineEnd(b.Source, last.End - 1));
    }

    // ---- the plan of one edit -------------------------------------------------------------------------------------------

    private static void Plan(Base b, Edit edit, List<Span> spans, List<Claim> claims, List<(int, string)> keysWritten, List<string> touched, List<JsonObject> problems,
        Dictionary<HtmlText.Element, Edit> setBesideMove)
    {
        var j = edit.Index;
        var order = 0;
        void Emit(int start, int end, string text) => spans.Add(new Span(start, end, text, j, order++));
        void Bad(string message, string fix, HtmlText.Element? element = null)
        {
            var problem = Problem(At(edit), ScreenHtmlEdit.Invalid, message, fix);
            if (element != null) problem["element"] = Line(b, element);
            problems.Add(problem);
        }
        switch (edit.Kind) {
            case "find": {
                var find = edit.Address.Replace("\r\n", "\n");
                var with = edit.With!.Replace("\r\n", "\n");
                var found = new List<int>();
                for (var at = b.Source.IndexOf(find, StringComparison.Ordinal); at >= 0; at = b.Source.IndexOf(find, at + 1, StringComparison.Ordinal)) found.Add(at);
                if (found.Count != 1) {
                    var problem = Problem(At(edit), TextNotUnique, found.Count == 0 ? "find: the text is not in the reading" : "find: the text is " + found.Count + " times in the reading",
                        found.Count == 0 ? "copy the text exactly as the reading has it (spaces and quotes included), or address the element by its k" : "take more of the text around it (until it is once in the reading), or address the element by its k");
                    problem["lines"] = new JsonArray(found.Take(10).Select(at => (JsonNode)new JsonObject { ["line"] = b.Text.Position(at).Line, ["text"] = Clip(LineText(b.Source, at)) }).ToArray());
                    if (found.Count > 10) problem["occurrences"] = found.Count;
                    problems.Add(problem);
                    return;
                }
                // CX16 r2 (M2): the k of an element is its identity. A with that drops, adds or changes a k of the text it replaces
                // would make a new element (another ObjectKey: a change the Studio made there is lost on a rebase). CX16 r3 (M5): the
                // same k in another order is a reorder only when each element goes with its own text (Identity, below).
                var before = KeysIn(find); var after = KeysIn(with);
                if (!before.SequenceEqual(after, StringComparer.Ordinal)) {
                    var lost = before.Except(after, StringComparer.Ordinal).ToList(); var added = after.Except(before, StringComparer.Ordinal).ToList();
                    Bad("find/with: the text found has " + (before.Count == 0 ? "no k" : "k " + string.Join(", ", before)) + " and with has " + (after.Count == 0 ? "none" : string.Join(", ", after))
                        + ": a k is the identity of its element (dropped or changed, the element would be a new one and a change the Studio made to it would be lost)",
                        (lost.Count > 0 ? "keep k=\"" + string.Join("\", k=\"", lost) + "\" in with" : "take k=\"" + string.Join("\", k=\"", added) + "\" out of with")
                        + ", or change the element by set (attributes), replace (the element whole, with its k) or move");
                    return;
                }
                if (!Identity(b, edit, found[0], found[0] + find.Length, with, problems)) return;
                Emit(found[0], found[0] + find.Length, with);
                claims.Add(new Claim(j, found[0], found[0] + find.Length, false, null, true));
                touched.Add(KeyAround(b, found[0]));
                return;
            }
            case "set": {
                if (Resolve(b, edit.Address, edit, edit.Kind, problems) is not { } target) return;
                if (target.Part is not ("element" or "root") || target.Element == null) { Bad("set changes the attributes of an element or of the root (/), not of a slot or a branch", "set the element itself (" + KeyOf(target.Holder) + ")", target.Holder); return; }
                var e = target.Element;
                var node = b.Node[e];
                var close = TagClose(b, e);
                if (setBesideMove.TryGetValue(e, out var paired) && ReferenceEquals(paired, edit)) {
                    // CX16 r3 (M5): the move of this element writes it with these attributes (Plan "move"); one change of it.
                    claims.Add(new Claim(j, e.OpenStart, close, false, e, true, BesideMove: true));
                    touched.Add(KeyOf(e));
                    return;
                }
                foreach (var (name, value) in edit.Attributes!) {
                    var written = e.Attributes.FirstOrDefault(a => a.Name == name);
                    var now = node.Get(name);
                    var next = value?.GetValue<string>();
                    if (next == null) {
                        if (written == null) continue;   // nothing to remove: no effect (R5)
                        var from = written.Start;
                        while (from > e.OpenStart && char.IsWhiteSpace(b.Source[from - 1])) from--;
                        Emit(from, written.End, "");
                    } else if (written == null) Emit(close, close, " " + ScreenHtml.Attribute(name, next));
                    else if (now != next) Emit(written.Start, written.End, ScreenHtml.Attribute(name, next));
                }
                claims.Add(new Claim(j, e.OpenStart, close, false, e, true));
                touched.Add(KeyOf(e));
                return;
            }
            case "replace": {
                if (Resolve(b, edit.Address, edit, edit.Kind, problems) is not { } target) return;
                if (target.Part == "root") {
                    var whole = Fragment(edit.With!);
                    if (whole.Count != 1 || whole[0].IsText || whole[0].Tag != b.Root.Tag) { Bad("replace of / is the whole document: one <" + b.Root.Tag + "> (the edit form with the document)", "send the whole document, or replace the elements that change", b.Root); return; }
                    var document = ScreenHtmlText.Write(whole[0]);
                    if (!Identity(b, edit, 0, b.Source.Length, document, problems)) return;
                    Emit(0, b.Source.Length, document);
                    claims.Add(new Claim(j, 0, b.Source.Length, false, b.Root, true, true));
                    touched.Add("");
                    return;
                }
                if (target.Part != "element" || target.Element == null) { Bad("replace takes an element (k), not a slot or a branch: replace the Block or the If whole", "replace " + KeyOf(target.Holder), target.Holder); return; }
                var e = target.Element;
                var k = KeyOf(e);
                var roots = Fragment(edit.With!);
                var pair = roots.Count == 2 && !roots[0].IsText && !roots[1].IsText && ScreenHtmlEdit.IsIfElse(roots[0], roots[1]);
                if (!(roots.Count == 1 || pair) || roots[0].IsText) { Bad("with is the element whole: one element (an If with its <div else>), " + roots.Count + " top-level nodes here", "send the element with its children, or one edit per element", e); return; }
                var root = roots[0];
                if (root.Tag is "screen" or "block") { Bad("with is an element of the page, not a <" + root.Tag + ">", "replace / with the whole document", e); return; }
                var rootK = root.Get("k");
                if (rootK == null) root.Attributes.Insert(0, new("k", k));
                else if (rootK != k) {
                    problems.Add(Problem(At(edit), b.ByK.ContainsKey(rootK) ? ScreenHtmlEdit.KeyTwice : ScreenHtmlEdit.Invalid,
                        "replace keeps the element: the root of with has k=\"" + rootK + "\", the target is " + k + (b.ByK.ContainsKey(rootK) ? " (another element of the reading)" : ""),
                        "drop the k of the root of with (it is " + k + "), or move the element with {move}", Line(b, e)));
                    return;
                }
                var inside = new HashSet<HtmlText.Element>(e.Descendants().Prepend(e).Concat(ElseOf(e) is { } elseOf ? elseOf.Descendants().Prepend(elseOf) : []), ReferenceEqualityComparer.Instance);
                if (!KeysOf(b, edit, roots, inside, keysWritten, problems, skipRoot: true)) return;
                var (start, end) = Lines(b, e);
                var rendered = RenderAt(roots, Depth(e));
                if (!Identity(b, edit, start, end, rendered, problems)) return;
                Emit(start, end, rendered);
                claims.Add(new Claim(j, start, end, false, e, true, true));
                touched.Add(k);
                return;
            }
            case "delete": {
                if (Resolve(b, edit.Address, edit, edit.Kind, problems) is not { } target) return;
                if (target.Part == "root") { Bad("the root is not deleted by an edit", "delete its elements, or the screen with its own op"); return; }
                if (target.Part is "true") { Bad("delete takes an element; the true branch of an If is its children: delete them, or the If", "delete " + KeyOf(target.Holder), target.Holder); return; }
                if (target.Element == null) { Bad(target.Part == "false" ? edit.Address + ": the If has no <div else>" : edit.Address + ": the reading has no such slot", "nothing to delete", target.Holder); return; }
                var e = target.Element;
                var (start, end) = target.Part is "false" or "slot" ? (LineStart(b.Source, e.OpenStart), LineEnd(b.Source, e.End - 1)) : Lines(b, e);
                Emit(start, end, "");
                claims.Add(new Claim(j, start, end, false, e, true, true));
                touched.Add(target.Part == "element" ? KeyOf(e) : edit.Address);
                return;
            }
            case "after": case "before": case "into": {
                if (Resolve(b, edit.Address, edit, edit.Kind, problems) is not { } target) return;
                var nodes = Fragment(edit.Insert!);
                if (nodes.Count == 0) { Bad(edit.Kind + ": insert holds nothing", "the new element(s), without k"); return; }
                if (nodes.Any(n => !n.IsText && n.Tag is "screen" or "block")) { Bad("insert holds elements of the page, not a <screen> or <block>", "replace / with the whole document"); return; }
                if (!KeysOf(b, edit, nodes, null, keysWritten, problems, skipRoot: false)) return;
                Place(b, edit, edit.Kind, target, nodes, Emit, claims, touched, problems);
                return;
            }
            case "move": {
                if (Resolve(b, edit.Address, edit, edit.Kind, problems) is not { } source) return;
                if (source.Part != "element" || source.Element == null) { Bad("move takes an element (k)", "move the element itself", source.Holder); return; }
                if (Resolve(b, edit.Destination!, edit, edit.DestinationKind!, problems) is not { } destination) return;
                var e = source.Element;
                var (start, end) = Lines(b, e);
                // CX16 r3 (M5): a set of the same element in the list goes with the move (the element written with its attributes).
                var moved = new List<ScreenHtml.Node> { setBesideMove.TryGetValue(e, out var set) ? WithAttributes(b.Node[e], set.Attributes!) : b.Node[e] };
                if (ElseOf(e) is { } elsePart) moved.Add(b.Node[elsePart]);
                var before = claims.Count;
                Emit(start, end, "");
                if (!Place(b, edit, edit.DestinationKind!, destination, moved, Emit, claims, touched, problems)) return;
                if (claims.Skip(before).Any(c => c.Point ? c.Start > start && c.Start < end : c.Start < end && start < c.End)) {
                    Bad("move puts the element inside itself", "move it after, before or into an element outside it", e); return;
                }
                claims.Add(new Claim(j, start, end, false, e, true, true, Moves: true));
                touched.Add(KeyOf(e));
                return;
            }
        }
    }

    // ---- identity by k (CX16 r3, M5) -------------------------------------------------------------------------------------

    // The set that goes with the move of its element: exactly one move and one set address it (any other combination is
    // judged as before: two changes of one element overlap).
    private static Dictionary<HtmlText.Element, Edit> SetsBesideMoves(Base b, List<Edit?> read)
    {
        var scratch = new List<JsonObject>();
        HtmlText.Element? Of(Edit edit) => edit.Address.Length > 0 && Resolve(b, edit.Address, edit, edit.Kind, scratch) is { Part: "element", Element: { } element } ? element : null;
        var moves = read.OfType<Edit>().Where(e => e.Kind == "move").Select(Of).OfType<HtmlText.Element>()
            .GroupBy(e => e, ReferenceEqualityComparer.Instance).Where(g => g.Count() == 1).Select(g => (HtmlText.Element)g.Key).ToHashSet(ReferenceEqualityComparer.Instance);
        var pairs = new Dictionary<HtmlText.Element, Edit>(ReferenceEqualityComparer.Instance);
        if (moves.Count == 0) return pairs;
        foreach (var group in read.OfType<Edit>().Where(e => e.Kind == "set" && e.Attributes != null).Select(e => (Edit: e, Element: Of(e)))
                     .Where(x => x.Element != null && moves.Contains(x.Element)).GroupBy(x => x.Element!, ReferenceEqualityComparer.Instance))
            if (group.Count() == 1) pairs[(HtmlText.Element)group.Key] = group.Single().Edit;
        return pairs;
    }

    // An element of the reading with the attributes of a set: a value replaces in place, null removes, a new one is appended.
    private static ScreenHtml.Node WithAttributes(ScreenHtml.Node node, JsonObject attributes)
    {
        var copy = ScreenHtmlText.Clone(node);
        foreach (var (name, value) in attributes) {
            var at = copy.Attributes.FindIndex(a => a.Key == name);
            var next = value?.GetValue<string>();
            if (next == null) { if (at >= 0) copy.Attributes.RemoveAt(at); }
            else if (at >= 0) copy.Attributes[at] = new(name, next);
            else copy.Attributes.Add(new(name, next));
        }
        return copy;
    }

    // CX16 r3 (M5): the k of the reading an edit writes again (find/with, replace/with, replace /) keep their identity. When
    // their order changes (a reorder), the elements that move are the ones outside the longest run kept in order (the run
    // that keeps the most elements, and among those the most of the changed ones in place); each of them must go with its own
    // text (children included, compared in the canonical form): a pure relocation, which the plan places again. An element
    // that changes place AND text is refused: with the k of another element's content (two k swapped, the content in place)
    // the plan would move the children of each into the other with new ObjectKeys for a screen that reads the same, and a
    // rebase would lose what the Studio changed there. The fix: move each element whole with its own text (or {move}), and
    // change it with {set} (a set goes with the move of its element) or where it is.
    private static bool Identity(Base b, Edit edit, int start, int end, string text, List<JsonObject> problems)
    {
        // The k in the order the texts write them: the same order (of the k both have) is no reorder, and costs no parse.
        var written = OrderedKeys(b.Source[start..end]); var rewritten = OrderedKeys(text);
        var both = new HashSet<string>(written.Intersect(rewritten, StringComparer.Ordinal), StringComparer.Ordinal);
        if (written.Where(both.Contains).SequenceEqual(rewritten.Where(both.Contains), StringComparer.Ordinal)) return true;
        bool Inside(HtmlText.Element e, int from, int to) => e.Find("k") is { Value.Length: > 0 } k && k.Start >= from && k.End <= to;
        var before = b.Text.Elements().Where(e => Inside(e, start, end)).ToList();
        if (before.Count < 2) return true;
        Base after;
        try { after = Load(b.Source[..start] + text + b.Source[end..], null); }
        catch (FormatException) { return true; }   // the read of the result names the edit that breaks it
        var now = after.Text.Elements().Where(e => Inside(e, start, start + text.Length)).ToList();
        var kept = new HashSet<string>(now.Select(e => e.Get("k")!), StringComparer.Ordinal);
        var common = new HashSet<string>(before.Select(e => e.Get("k")!).Where(kept.Contains), StringComparer.Ordinal);
        var order = before.Select(e => e.Get("k")!).Where(common.Contains).Distinct(StringComparer.Ordinal).ToList();
        var next = now.Select(e => e.Get("k")!).Where(common.Contains).Distinct(StringComparer.Ordinal).ToList();
        if (order.Count < 2 || order.Count != next.Count || order.SequenceEqual(next, StringComparer.Ordinal)) return true;
        var was = before.GroupBy(e => e.Get("k")!, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var @is = now.GroupBy(e => e.Get("k")!, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var changed = order.ToDictionary(k => k, k => Canonical(b, was[k]) != Canonical(after, @is[k]), StringComparer.Ordinal);
        // The longest common subsequence of the two orders, weighted: every element counts n + 1, a changed one 1 more.
        var n = order.Count;
        long Weight(string k) => n + 1L + (changed[k] ? 1 : 0);
        var best = new long[n + 1, n + 1];
        for (var x = n - 1; x >= 0; x--)
            for (var y = n - 1; y >= 0; y--)
                best[x, y] = order[x] == next[y] ? Weight(order[x]) + best[x + 1, y + 1] : Math.Max(best[x + 1, y], best[x, y + 1]);
        var stay = new HashSet<string>(StringComparer.Ordinal);
        for (int x = 0, y = 0; x < n && y < n;) {
            if (order[x] == next[y] && best[x, y] == Weight(order[x]) + best[x + 1, y + 1]) { stay.Add(order[x]); x++; y++; }
            else if (best[x + 1, y] >= best[x, y + 1]) x++;
            else y++;
        }
        var moved = order.Where(k => !stay.Contains(k) && changed[k]).ToList();
        if (moved.Count == 0) return true;
        var problem = Problem(At(edit), ScreenHtmlEdit.Invalid,
            edit.Kind + ": k " + string.Join(", ", moved) + (moved.Count == 1 ? " changes" : " change") + " place and text at once: a k is the identity of its element, and with puts it where another element of the reading was, with other text"
            + " (the plan would move children between them with new ObjectKeys, and a rebase would lose what the Studio changed there)",
            "to reorder, move each element whole with its own k and text (or {move} it); to change one, {set} it (a set goes with the move of its element) or change it where it is",
            Line(b, was[moved[0]]));
        problem["keys"] = new JsonArray(moved.Select(k => (JsonNode)k).ToArray());
        problems.Add(problem);
        return false;
    }

    // An element (an If with its else) in the canonical form: the same text whatever its indentation or quotes.
    private static string Canonical(Base b, HtmlText.Element e) =>
        ScreenHtmlText.Write(b.Node[e]) + (ElseOf(e) is { } elsePart ? ScreenHtmlText.Write(b.Node[elsePart]) : "");

    // Where new or moved elements go (after, before or into a target) and the text they are written in there.
    private static bool Place(Base b, Edit edit, string kind, Target target, List<ScreenHtml.Node> nodes, Action<int, int, string> emit, List<Claim> claims, List<string> touched, List<JsonObject> problems)
    {
        var j = edit.Index;
        void Bad(string message, string fix, HtmlText.Element? element)
        {
            var problem = Problem(At(edit), ScreenHtmlEdit.Invalid, message, fix);
            if (element != null) problem["element"] = Line(b, element);
            problems.Add(problem);
        }
        if (kind is "after" or "before") {
            if (target.Part != "element" || target.Element == null) { Bad(kind + " takes an element (k); for the first or last child of a slot, a branch or the root use into", "into \"" + target.Address + "\" with at first or last", target.Holder); return false; }
            var e = target.Element;
            var (start, end) = Lines(b, e);
            var at = kind == "before" ? start : end;
            emit(at, at, RenderAt(nodes, Depth(e)));
            claims.Add(new Claim(j, at, at, true, e, false));
            touched.Add(KeyOf(e));
            return true;
        }
        var first = edit.At == "first";
        HtmlText.Element holder;
        int depth;
        List<ScreenHtml.Node> written = nodes;
        if (target.Element == null) {
            // A slot or an else the reading does not write: created with the new children.
            var wrapper = target.Part == "slot" ? new ScreenHtml.Node { Tag = "slot", Attributes = [new("name", target.SlotName!)] } : new ScreenHtml.Node { Tag = "div", Attributes = [new("else", "")] };
            wrapper.Children.AddRange(nodes);
            written = [wrapper];
            if (target.Part == "false") {
                var e = target.Holder;
                var at = LineEnd(b.Source, e.End - 1);
                emit(at, at, RenderAt(written, Depth(e)));
                claims.Add(new Claim(j, at, at, true, e, false));
                touched.Add(KeyOf(e) + ".false");
                return true;
            }
            holder = target.Holder; first = false;
        } else holder = target.Element;
        if (holder.Tag is "style" or "text" || holder.Tag is "var" or "aggregate" or "event" || holder.Tag == "input" && holder.Get("bind") == null && holder.Get("name") != null) {
            Bad("into <" + holder.Tag + ">: it holds no elements", "into the element that holds the new ones", holder);
            return false;
        }
        depth = Depth(holder) + 1;
        var text = RenderAt(written, depth);
        if (SelfClosed(b, holder)) {
            var close = TagClose(b, holder);
            emit(close, holder.OpenEnd, ">\n" + text + Indent(depth - 1) + CloseTag(holder));
            claims.Add(new Claim(j, close, holder.OpenEnd, false, holder, false));
        } else if (MultiLine(b, holder)) {
            var at = first ? LineEnd(b.Source, holder.OpenEnd - 1) : LineStart(b.Source, CloseStart(b, holder));
            emit(at, at, text);
            claims.Add(new Claim(j, at, at, true, holder, false));
        } else {
            // One line with its one run (<div>{{ X }}</div>): the run goes to its own line, as the reading writes an element
            // with children.
            var closeStart = CloseStart(b, holder);
            var run = b.Source[holder.OpenEnd..closeStart];
            var runLine = run.Length > 0 ? Indent(depth) + run + "\n" : "";
            emit(holder.OpenEnd, holder.End, "\n" + (first ? text + runLine : runLine + text) + Indent(depth - 1) + CloseTag(holder));
            claims.Add(new Claim(j, holder.OpenEnd, holder.End, false, holder, false));
        }
        touched.Add(target.Part == "root" ? "" : target.Address.StartsWith('@') ? KeyOf(holder) : target.Address);
        return true;
    }

    // The k written by an insert or a with: an element of the reading inside the replaced one keeps its k (a replace sends it
    // with its children); any other k of the reading would be there twice; a k the reading does not have is no k of it.
    private static bool KeysOf(Base b, Edit edit, List<ScreenHtml.Node> roots, HashSet<HtmlText.Element>? inside, List<(int, string)> keysWritten, List<JsonObject> problems, bool skipRoot)
    {
        var ok = true;
        foreach (var root in roots)
            foreach (var (node, _) in ScreenHtmlText.Elements(root)) {
                if (skipRoot && ReferenceEquals(node, roots[0])) continue;
                if (node.Get("k") is not { } k) continue;
                if (b.ByK.TryGetValue(k, out var element)) {
                    if (inside != null && inside.Contains(element)) { keysWritten.Add((edit.Index, k)); continue; }
                    var problem = Problem(At(edit), ScreenHtmlEdit.KeyTwice, "k=\"" + k + "\" is an element of the reading outside this edit: it would be there twice",
                        inside == null ? "a new element has no k; to put an element of the reading here, move it" : "drop it from with, or move it", Line(b, element));
                    problems.Add(problem);
                } else problems.Add(Problem(At(edit), inside == null ? ScreenHtmlEdit.Invalid : ScreenHtmlEdit.KeyForeign,
                    "k=\"" + k + "\" is not an element of the reading" + (inside == null ? ": a new element has no k" : ""), "drop the k (a new element) or use a k of the reading"));
                ok = false;
            }
        return ok;
    }

    // The top-level nodes of a text (the whitespace between them dropped). Throws FormatException when it does not read.
    private static List<ScreenHtml.Node> Fragment(string text)
    {
        var parsed = ScreenHtml.Parse(text.Replace("\r\n", "\n"));
        return parsed.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0)
            .Select(c => c.IsText ? new ScreenHtml.Node { Text = c.Text!.Trim('\n', '\r', ' ', '\t'), Line = c.Line, Column = c.Column } : c).ToList();
    }

    /// <summary>Nodes written as the reading writes them at <paramref name="depth"/> (1: the children of the root, column
    /// 0; +1 space a level): the canonical writer (ScreenHtmlText) over a frame of depth - 1 wrappers, whose lines are dropped.</summary>
    internal static string RenderAt(IReadOnlyList<ScreenHtml.Node> nodes, int depth)
    {
        depth = Math.Max(1, depth);
        var top = new ScreenHtml.Node { Tag = "x" };
        var inner = top;
        for (var d = 1; d < depth; d++) { var wrapper = new ScreenHtml.Node { Tag = "x" }; inner.Children.Add(wrapper); inner = wrapper; }
        inner.Children.AddRange(nodes);
        inner.Children.Add(new ScreenHtml.Node { Tag = "x" });   // keeps the frame on lines of its own
        var lines = ScreenHtmlText.Write(top).Split('\n');
        var total = lines.Length - 1;                           // the text ends with \n
        var body = lines.Skip(depth).Take(total - 2 * depth - 1);
        return string.Concat(body.Select(l => l + "\n"));
    }

    // ---- overlaps -------------------------------------------------------------------------------------------------------

    private static void Overlaps(Base b, List<Claim> claims, List<JsonObject> problems)
    {
        var reported = new HashSet<(int, int)>();
        for (var x = 0; x < claims.Count; x++)
            for (var y = x + 1; y < claims.Count; y++) {
                var a = claims[x]; var c = claims[y];
                if (a.Edit == c.Edit) continue;
                // CX16 r3 (M5): the set that goes with the move of its element is part of that move.
                if (a.Element != null && ReferenceEquals(a.Element, c.Element) && (a.BesideMove && c.Moves || c.BesideMove && a.Moves)) continue;
                var clash =
                    !a.Point && !c.Point && a.Start < c.End && c.Start < a.End
                    || a.Point && !c.Point && c.Start < a.Start && a.Start < c.End
                    || c.Point && !a.Point && a.Start < c.Start && c.Start < a.End
                    // One change of an element per edit list: set twice, or anything beside its replace, delete or move.
                    || a.Element != null && ReferenceEquals(a.Element, c.Element) && (a.Changes && c.Changes || a.Whole || c.Whole);
                if (!clash) continue;
                var (first, second) = a.Edit < c.Edit ? (a.Edit, c.Edit) : (c.Edit, a.Edit);
                if (!reported.Add((first, second))) continue;
                foreach (var (j, other) in new[] { (first, second), (second, first) })
                    problems.Add(Problem("/edits/" + j, ScreenHtmlEdit.Overlap, "edit #" + j + " and edit #" + other + " change the same element or text (every edit addresses the reading, one change per element)",
                        "join them in one edit (a replace of the element, or one set with every attribute), or address elements that do not contain each other"));
            }
    }

    // ---- the result -----------------------------------------------------------------------------------------------------

    // The base with the spans (no two overlap): at one position the inserts first, in edit order, then a replacement.
    private static string Compose(string source, List<Span> spans)
    {
        var sb = new StringBuilder(source.Length + spans.Sum(s => s.Text.Length));
        var at = 0;
        foreach (var span in spans.OrderBy(s => s.Start).ThenBy(s => s.End > s.Start ? 1 : 0).ThenBy(s => s.Edit).ThenBy(s => s.Order)) {
            if (span.Start < at) continue;   // an overlap already refused
            sb.Append(source, at, span.Start - at).Append(span.Text);
            at = span.End;
        }
        return sb.Append(source, at, source.Length - at).ToString();
    }

    /// <summary>The k each edit addresses (set, replace, delete, after, before, into, move and its destination), as written:
    /// a slot or a branch is its element's k; @ObjectKey stays as it is; a find addresses none.</summary>
    public static List<(int Edit, string Address)> Addresses(JsonNode? edits)
    {
        var found = new List<(int, string)>();
        if (edits is not JsonArray list) return found;
        for (var j = 0; j < list.Count; j++) {
            if (list[j] is not JsonObject o) continue;
            foreach (var key in AddressKeys.Where(k => k != "find"))
                if (o[key] is JsonValue v && v.TryGetValue<string>(out var address) && address.Length > 0 && address != "/") {
                    var k = address.StartsWith('@') ? address : address.Split('/')[0];
                    if (k.EndsWith(".true", StringComparison.Ordinal)) k = k[..^5]; else if (k.EndsWith(".false", StringComparison.Ordinal)) k = k[..^6];
                    found.Add((j, k));
                }
        }
        return found;
    }

    /// <summary>The text of the element k of a reading (an If with its else), as the reading has it, or null.</summary>
    public static string? ElementText(string html, string k)
    {
        try {
            var text = HtmlText.Parse(html);
            var e = text.Elements().FirstOrDefault(x => x.Get("k") == k);
            if (e == null) return null;
            var last = ElseOf(e) ?? e;
            return html[LineStart(html, e.OpenStart)..LineEnd(html, last.End - 1)];
        } catch { return null; }
    }

    private static string KeyOf(HtmlText.Element e) => e.Get("k") ?? (e.Parent is { Tag.Length: 0 } ? "" : e.Tag == "slot" && e.Parent?.Get("k") is { } pk ? pk + "/" + e.Get("name") : "");

    // The k values written in a text (attribute k="…" or k='…', also at the very start of the text; never data-k, :k or a.k),
    // sorted: the multiset a find/with keeps (M2).
    private static readonly System.Text.RegularExpressions.Regex KeyAttribute = new(@"(?<![\w:.@-])k\s*=\s*(?:""([^""]*)""|'([^']*)')", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static List<string> KeysIn(string text) => OrderedKeys(text).Order(StringComparer.Ordinal).ToList();
    private static List<string> OrderedKeys(string text) =>
        KeyAttribute.Matches(text).Select(m => m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value).ToList();

    // The k of the innermost element with a k around a position ("" for the root).
    private static string KeyAround(Base b, int at)
    {
        HtmlText.Element? best = null;
        foreach (var e in b.Text.Elements()) if (e.OpenStart <= at && at < e.End && e.Get("k") != null) best = e;
        return best?.Get("k") ?? "";
    }

    private static string LineText(string s, int at)
    {
        var start = LineStart(s, at); var end = s.IndexOf('\n', at);
        return s[start..(end < 0 ? s.Length : end)].Trim();
    }

    private static string Clip(string text) => text.Length > 160 ? text[..160] + "…" : text;

    private static JsonObject Problem(string pointer, string code, string message, string fix, string? element = null)
    {
        var problem = new JsonObject { ["pointer"] = pointer, ["code"] = code, ["severity"] = "error", ["message"] = message, ["fix"] = fix };
        if (element != null) problem["element"] = element;
        return problem;
    }
}
