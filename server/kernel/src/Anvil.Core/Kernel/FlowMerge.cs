using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Reading;

// The three-way merge of an edited action text written on an older read (plan "Texto do SSAM", the limit the screens closed
// with ScreenHtmlMerge): base = the read the edit names (basedOn: its text and id table, kept by the store), theirs = the
// action as the module has it now (changed in the Studio since), ours = the edited text. Elements are matched by model key
// (the ids of each text through its own table, never by id: the ids renumber); the parts of a node one by one (an argument by
// its parameter, an assignment by the variable it writes, a source or a column by its name, the others equal first and then
// by their place). For every name, property, connector and part: what only one side changed is taken from that side; what
// both changed differently is a conflict, and the delivery's version wins (the owner's rule), listed in Conflicts with what
// the Studio had and what was delivered. A value both sides changed is merged inside when it can be: a mapping field by
// field, a text of more than one line (SQL, JavaScript, a description, an expression) by its lines, a conflict only where the
// same field or the same lines changed. An element added in the Studio after the read is never deleted because the edit does
// not have it; an element the edit removed that the Studio changed is removed and listed; an element the Studio removed that
// the edit changed or uses is written again as a new element (its key is gone) and listed; an element the edit removed that
// the Studio now uses is refused (FLOW_MERGE_REMOVED_USED). A rename on one side is a rename of the merged action: the other
// side's expressions are read in the final names (what the rename verb rewrites: never the alias of an aggregate's source, the
// field name of a mapping, nor a name a field value of a mapping reads as an attribute of its source; a delivered mapping value
// a Studio rename would make read such an attribute is refused, FLOW_RENAME_CAPTURED). Two elements of one name from the two sides are one when they are the same kind of element
// of the same type (the delivery's values, listed), else refused (FLOW_MERGE_NAME_TAKEN). Two sides that both inserted steps
// after the same node keep both: the delivery's steps first, then the Studio's (listed); steps the Studio inserted after a
// node the edit removed take its place. A step of the Studio the merge would leave out of the flow is never written: the
// merge fails (the caller refuses with the current text). The result is the whole merged text in the ids of the current
// read, which the way back (FlowDiff) then diffs against the action now: only what the edit changed is written. Free of
// Studio types.
public static class FlowMerge
{
    public sealed class Result
    {
        // The merged text in the ids of the current read (null: refused with Problems, or not mergeable: Failure).
        public string? Text;
        public readonly List<FlowProblem> Problems = [];
        public readonly List<JsonObject> Conflicts = [];
        // Elements the Studio added or changed since the read that the merge keeps as the Studio has them.
        public int Kept;
        // Why the merge could not be written as text (the caller refuses as when the read is not kept).
        public string? Failure;
        // The ids of the merged text (+m1, +m2...) of elements of the read written again with a new key (the Studio removed
        // them, the delivery changed or uses them): elements the action had, not new ones (the rules of a new JavaScript, a new
        // For Each or a new query in a loop judge what the delivery writes new, never these).
        public readonly HashSet<string> Rewritten = new(StringComparer.Ordinal);
    }

    /// <summary>The names a field value of a mapping reads before the action's own (the attributes of its source): Exact when
    /// the module typed the source, else every attribute name the module has (a superset: a name outside it is no attribute of
    /// any source).</summary>
    public sealed record MappingScope(IReadOnlySet<string> Names, bool Exact);

    // scope: the names a mapping's field values read first, by the mapping's source as one side writes it (the session types it
    // through the module); null: nothing is known, and a rename never rewrites a field value of a mapping.
    public static Result ThreeWay(FlowReading reading, FlowItem current, FlowDocument currentRead, string edited, Func<string, FlowItem, MappingScope?>? scope = null) =>
        new Merger(reading, current, currentRead, scope).Run(edited);

    private static readonly Regex ReadId = new(@"^[npl][0-9]+$", RegexOptions.CultureInvariant);
    // The nodes whose name the action's expressions read (Name.Output): a rename of one is read in the final name.
    private static readonly HashSet<string> Outputs = new(StringComparer.Ordinal) {
        "Execute", "AggregateNode", "SQLNode", "JavaScriptNode", "JSONSerializeNode", "JSONDeserializeNode", "ExcelToRecordListNode", "RecordListToExcelNode" };
    private static readonly string[] ParameterRoles = ["in", "out", "local"];
    // A text of more lines than this times the other side's is merged whole (a conflict), never by its lines.
    private const long LineCells = 4_000_000;

    private sealed class Merger(FlowReading reading, FlowItem current, FlowDocument currentRead, Func<string, FlowItem, MappingScope?>? scope)
    {
        private readonly Result result = new();
        private FlowItem b = null!, o = null!, t = null!;
        private Dictionary<string, FlowItem> bn = null!, on = null!, tn = null!;
        private readonly Dictionary<string, string> idNow = currentRead.Keys.Where(p => p.Key != "start").GroupBy(p => p.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
        private readonly Dictionary<string, string> idBase = reading.Ids.GroupBy(p => p.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal);
        // Elements the Studio removed that the edit changed or uses (or still goes to): old key -> the key of the new element.
        private readonly Dictionary<string, string> recreated = new(StringComparer.Ordinal);
        // Parameters and locals the Studio removed that the edit uses: written again.
        private readonly HashSet<string> revived = new(StringComparer.Ordinal);
        // Connectors both sides changed differently (of a node or of a case), with the node they belong to.
        private readonly List<(FlowItem Owner, string Edge, string? Ours, string? Base, string? Theirs, string Key, string Element)> clashes = [];
        // A merged part and the part of the read it was merged from (the case of a switch, for its connector).
        private readonly Dictionary<FlowItem, FlowItem> partBase = new(ReferenceEqualityComparer.Instance);
        private string oursText = "";
        private int fresh;
        // The delivery's mapping values a Studio rename made read an attribute of the mapping's source (the value as rewritten,
        // with what was renamed): refused when the merge keeps one of them (Captures).
        private readonly List<(string Value, string From, string To, string Source, bool Exact)> captured = [];

        public Result Run(string edited)
        {
            oursText = edited;
            try { b = FlowParser.Parse(reading.Text, reading.Ids); }
            catch (FormatException error) { result.Failure = "the kept read does not parse: " + error.Message; return result; }
            try { o = FlowParser.Parse(edited, reading.Ids); }
            catch (FormatException error) {
                if (error is FlowRuleFormatException rule) result.Problems.Add(new(rule.Code, error.Message, null, rule.Fix));
                else foreach (var message in error is FlowSyntaxException all ? all.Errors : [error.Message])
                    result.Problems.Add(new("FLOW_SYNTAX", message, null, "write the line in the ssam-flow/1 grammar (docs/TEXTO-LOGICA.md)"));
                return result;
            }
            t = current.Clone();
            if (o.Key.Length > 0 && o.Key != reading.ActionKey) {
                result.Problems.Add(new("FLOW_KEY_FOREIGN", "the header names @" + o.Key + ", the read basedOn names is the action @" + reading.ActionKey, o.Key,
                    "keep the header's @key as it was read"));
                return result;
            }
            Foreign();
            if (result.Problems.Count > 0) return result;
            Normalize();
            bn = Nodes(b); on = Nodes(o); tn = Nodes(t);
            Uses();
            if (result.Problems.Count > 0) return result;
            var merged = Action();
            Collisions(merged);
            if (result.Problems.Count > 0) return result;
            Graph(merged);
            Reach(merged);
            if (result.Failure != null) return result;
            Captures(merged);
            if (result.Problems.Count > 0) return result;
            // Only an element the delivery wrote again as the kind of element the read had there is the action's own: an id of the
            // read on another kind (a JavaScript or a For Each where the Studio removed an assign) is a new element, and the rules
            // of new elements judge it (the review of round 2: the exemption let a new JavaScript and a T1 loop in).
            foreach (var (key, again) in recreated)
                if (SameKindAsRead(key)) result.Rewritten.Add(again);
            Print(merged);
            return result;
        }

        private static Dictionary<string, FlowItem> Nodes(FlowItem action) =>
            action.Items.Where(i => i.Role == "node").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        // Whether the element the merge writes again for a key of the read is, in the delivery, the kind of element the read had
        // there (the same kind of node, opaque or not, the same kind of call); a parameter or local is always its own kind.
        private bool SameKindAsRead(string key)
        {
            if (!bn.TryGetValue(key, out var was)) return true;
            return on.TryGetValue(key, out var mine) && mine.Kind == was.Kind && mine.Opaque == was.Opaque && mine.CallKind == was.CallKind;
        }

        // The element the read had at a key, and what the delivery wrote there when it is another kind of element.
        private string DescribeAgainst(string key, FlowItem mine) =>
            bn.TryGetValue(key, out var was) && (was.Kind != mine.Kind || was.Opaque != mine.Opaque) ? Describe(was) + " of the read (the delivery writes " + Describe(mine) + " on its id)" : Describe(mine);

        private static Dictionary<string, FlowItem> Parameters(FlowItem action) =>
            action.Items.Where(i => i.Role is "in" or "out" or "local").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        // Ids of the read pattern that the read does not have, written on an element or a connector: refused against that read
        // (after the merge they could name another element of the current read).
        private void Foreign()
        {
            void Check(FlowItem item)
            {
                if (FlowItem.Keyed(item.Role) && item.Role != "action" && ReadId.IsMatch(item.Key))
                    result.Problems.Add(new("FLOW_KEY_FOREIGN", "@" + item.Key + " is not an id of the read this text edits (basedOn " + reading.TextSha + ")", item.Key,
                        "a new element is written without an id; an element of the read keeps the id it was read with"));
                foreach (var (edge, to) in item.Edges)
                    if (ReadId.IsMatch(to))
                        result.Problems.Add(new("FLOW_JUMP_UNKNOWN", (edge == "Attached" ? "the comment is attached to @" : "-> @") + to + ": no element of the read or of the text has that id", to,
                            "use the id of a node the text writes"));
                foreach (var child in item.Items) Check(child);
            }
            foreach (var item in o.Items) Check(item);
        }

        // ---- renames: every side's expressions in the final names ------------------------------------------------------------
        private void Normalize()
        {
            var nb = Names(b); var no = Names(o); var nt = Names(t);
            var final = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var key in nb.Keys.Union(no.Keys).Union(nt.Keys)) {
                bool inB = nb.TryGetValue(key, out var x), inO = no.TryGetValue(key, out var y), inT = nt.TryGetValue(key, out var z);
                if (inB && inO && inT) final[key] = Choose(y, x, z, Same, null)!;
                else if (inO) final[key] = y!;
                else if (inT) final[key] = z!;
            }
            foreach (var (side, names) in new[] { (b, nb), (o, no), (t, nt) }) {
                var renames = names.Where(p => final.TryGetValue(p.Key, out var to) && !string.Equals(to, p.Value, StringComparison.Ordinal))
                    .Select(p => (From: p.Value, To: final[p.Key])).ToList();
                // A mapping's source is typed in the side's own names, before its expressions are rewritten.
                var typing = renames.Count > 0 ? side.Clone() : side;
                if (renames.Count > 0) foreach (var item in side.Items) Rewrite(item, renames, null, typing, ReferenceEquals(side, o));
            }
        }

        private static Dictionary<string, string> Names(FlowItem action)
        {
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var item in action.Items) {
                if (item.Name.Length == 0 || !FlowSyntax.IsIdentifier(item.Name)) continue;
                if (item.Role is "in" or "out" or "local" || item.Role == "node" && Outputs.Contains(item.Kind)) names.TryAdd(item.Key, item.Name);
            }
            return names;
        }

        // The parts of an aggregate name its sources by their aliases: a rename of a name an alias also has is not read there
        // (the rename verb leaves the source alone), nor is a field name of a mapping or a record (an attribute of the target).
        // side: the side's action as written (its parameters type a mapping's source); delivered: the side is the delivery's.
        private void Rewrite(FlowItem item, List<(string From, string To)> renames, HashSet<string>? aliases, FlowItem side, bool delivered)
        {
            var own = aliases == null ? renames : renames.Where(r => !aliases.Contains(r.From)).ToList();
            foreach (var (name, value) in item.Props.ToList())
                if (value.Type == 'e') item.Props[name] = new('e', RenamedValue(value.Text, own, side, delivered));
            var inner = item.Role == "node" && item.Kind == "AggregateNode" ? Aliases(item) : aliases;
            foreach (var child in item.Items) Rewrite(child, renames, inner, side, delivered);
        }

        // A value in the final names. A field value of a mapping (Source mapTo { Field: value }) reads the attributes of its
        // source before the action's names (what the rename verb leaves alone there): a renamed name the source has, or may
        // have (the module could not type the source), is left as it is; a renamed element whose final name the source has (or
        // may have) would be read as that attribute: the delivery's value is kept for Captures, which refuses it when the merge
        // keeps it. Without a scope no field value of a mapping is rewritten (a stale name is refused by the Verify; a name read
        // as another element would not be).
        private string RenamedValue(string text, List<(string From, string To)> renames, FlowItem side, bool delivered)
        {
            if (renames.Count == 0) return text;
            var whole = Renamed(text, renames);
            if (whole == text || FlowMapping.Split(text) is not { } mapping) return whole;
            var names = scope?.Invoke(mapping.Source, side);
            var outer = names == null ? [] : renames.Where(r => !names.Names.Contains(r.From)).ToList();
            var fields = mapping.Fields.Select(f => (f.Field, Renamed(f.Value, outer))).ToList();
            if (FlowMapping.Compose(Renamed(mapping.Source, renames), fields) is not { } rewritten) return text;
            if (delivered && names != null)
                foreach (var (from, to) in outer.Where(r => names.Names.Contains(r.To)))
                    if (mapping.Fields.Any(f => FlowEdits.RenamedOutsideFields(f.Value, from, "\u0001") != f.Value))
                        captured.Add((rewritten, from, to, mapping.Source, names.Exact));
            return rewritten;
        }

        // A mapping value of the delivery that a Studio rename made read an attribute of its source, kept by the merge (the
        // Studio's action has no such value): refused (FLOW_RENAME_CAPTURED), with the action now as a ready edit.
        private void Captures(FlowItem merged)
        {
            var kept = new HashSet<string>(Values(merged), StringComparer.Ordinal);
            var studio = new HashSet<string>(Values(t), StringComparer.Ordinal);
            // A mapping value the delivery wrote new or changed (on a read older than the module) that names, in a field value, an
            // element of the action whose name the source of the mapping has as an attribute now (the module types it): written
            // on the older read it may name the element (an attribute renamed in the Studio onto that name since, the review of
            // round 2: o-dr, x-drm), and in the module it would read the attribute. Two readings: refused with the action now.
            if (scope != null) {
                var read = new HashSet<string>(Values(b), StringComparer.Ordinal);
                var elements = Names(merged).Values.ToList();
                // A value a Studio rename of an element of the action captured is said below, with that rename.
                var renamed = captured.Select(c => c.Value).ToHashSet(StringComparer.Ordinal);
                foreach (var value in kept.Where(v => !read.Contains(v) && !studio.Contains(v) && !renamed.Contains(v))) {
                    if (FlowMapping.Split(value) is not { } mapping || scope(mapping.Source, merged) is not { Exact: true } names) continue;
                    var named = elements.FirstOrDefault(e => names.Names.Contains(e) && mapping.Fields.Any(f => FlowEdits.RenamedOutsideFields(f.Value, e, "\u0001") != f.Value));
                    if (named == null) continue;
                    result.Problems.Add(new("FLOW_RENAME_CAPTURED", "the mapping `" + Clip(value) + "` the delivery wrote on an older read names " + named + " in a field value, and " + named
                        + " is both an element of the action and an attribute of its source `" + mapping.Source + "` now: inside a mapping the attribute comes first, and a value written on "
                        + "an older read may mean the element (an attribute renamed in the Studio onto that name since), so it cannot be told which one it reads", null,
                        "if it reads the attribute, write the value on the action now (the edit of this problem) and send it with that basedOn; if it reads the element, assign it to a local of "
                        + "another name before the mapping and read the local", currentRead.Text) { Data = ReadyEdit() });
                }
            }
            if (captured.Count == 0) return;
            foreach (var (value, from, to, source, exact) in captured.Where(c => kept.Contains(c.Value) && !studio.Contains(c.Value)).DistinctBy(c => (c.Value, c.From)))
                result.Problems.Add(new("FLOW_RENAME_CAPTURED", "since the read the Studio renamed " + from + " to " + to + ", and the mapping `" + Clip(value) + "` the delivery wrote names "
                    + from + " in a field value: inside a mapping the attributes of its source `" + source + "` come first, and " + to
                    + (exact ? " is one of them" : " may be one of them (the module could not type the source)") + ", so the value would read that attribute", null,
                    "write the value through a local of another name (assigned before the mapping), or give " + to + " a name no attribute of the source has; the edit of this problem is the action now",
                    currentRead.Text) { Data = ReadyEdit() });
            static IEnumerable<string> Values(FlowItem item) => item.Props.Values.Where(v => v.Type == 'e').Select(v => v.Text).Concat(item.Items.SelectMany(Values));
        }

        private static HashSet<string> Aliases(FlowItem aggregate) =>
            aggregate.Items.Where(p => p.Role == "source" && p.Name.Length > 0).Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Two passes through marks: names that trade places (A -> B, B -> A) are each renamed once.
        private static string Renamed(string text, List<(string From, string To)> renames)
        {
            for (var i = 0; i < renames.Count; i++) text = FlowEdits.RenamedOutsideFields(text, renames[i].From, Mark(i));
            for (var i = 0; i < renames.Count; i++) text = text.Replace(Mark(i), renames[i].To, StringComparison.Ordinal);
            return text;
        }

        private static string Mark(int i) => "\u0001" + i.ToString(CultureInfo.InvariantCulture) + "\u0001";

        // ---- what one side removed and the other side uses -------------------------------------------------------------------

        // Every expression of an item and its parts, with the aliases of the aggregate it is a part of.
        private static IEnumerable<(string Text, HashSet<string>? Aliases)> Expressions(FlowItem item, HashSet<string>? aliases = null)
        {
            foreach (var value in item.Props.Values) if (value.Type == 'e') yield return (value.Text, aliases);
            var inner = item.Role == "node" && item.Kind == "AggregateNode" ? Aliases(item) : aliases;
            foreach (var child in item.Items) foreach (var expression in Expressions(child, inner)) yield return expression;
        }

        // The expressions one side wrote that the read does not have (changed or new, by node; the action's own events too).
        private static List<(string Text, HashSet<string>? Aliases)> Written(FlowItem side, FlowItem read)
        {
            var written = new List<(string, HashSet<string>?)>();
            var before = read.Items.Where(i => i.Role == "node").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            void Compare(IEnumerable<(string Text, HashSet<string>? Aliases)> mine, IEnumerable<(string Text, HashSet<string>? Aliases)> theirs)
            {
                var count = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var (text, _) in theirs) count[text] = count.GetValueOrDefault(text) + 1;
                foreach (var expression in mine) {
                    if (count.GetValueOrDefault(expression.Text) > 0) { count[expression.Text]--; continue; }
                    written.Add(expression);
                }
            }
            foreach (var node in side.Items.Where(i => i.Role == "node"))
                Compare(Expressions(node), before.TryGetValue(node.Key, out var was) ? Expressions(was) : []);
            Compare(side.Items.Where(i => i.Role == "event").SelectMany(e => Expressions(e)), read.Items.Where(i => i.Role == "event").SelectMany(e => Expressions(e)));
            return written;
        }

        private static bool Mentions(IEnumerable<(string Text, HashSet<string>? Aliases)> expressions, string name, out string? where)
        {
            foreach (var (text, aliases) in expressions)
                if (aliases?.Contains(name) != true && FlowEdits.RenamedOutsideFields(text, name, "\u0001") != text) { where = text; return true; }
            where = null;
            return false;
        }

        // A parameter, local or output node removed on one side that the other side's new expressions name: what the Studio
        // removed and the delivery uses is written again (Keyed, NodeItems); what the delivery removed and the Studio uses is
        // refused (its use would be left without it).
        private void Uses()
        {
            var bp = Parameters(b); var op = Parameters(o); var tp = Parameters(t);
            var delivered = Written(o, b); var studio = Written(t, b);
            foreach (var (key, was) in bp) {
                if (op.TryGetValue(key, out var mine) && !tp.ContainsKey(key) && Mentions(delivered, mine.Name, out var use)) {
                    revived.Add(key);
                    Conflict(key, Describe(mine), "removed in the Studio and used by the delivery", "(removed)", use,
                        "removed in the Studio since the read and named by what the delivery wrote: written again as a new element (its key is gone)");
                } else if (tp.TryGetValue(key, out var now) && !op.ContainsKey(key) && Mentions(studio, now.Name, out var used))
                    RemovedUsed(key, Describe(now), used!);
            }
            foreach (var (key, was) in bn.Where(p => Outputs.Contains(p.Value.Kind) && p.Value.Name.Length > 0)) {
                if (on.TryGetValue(key, out var mine) && !tn.ContainsKey(key) && Mentions(delivered, mine.Name, out var use)) {
                    recreated[key] = NewKey();
                    Conflict(key, DescribeAgainst(key, mine), "removed in the Studio and used by the delivery", "(removed)", use,
                        "removed in the Studio since the read and named by what the delivery wrote: written again as a new node (its key is gone)");
                } else if (tn.TryGetValue(key, out var now) && !on.ContainsKey(key) && Mentions(studio, now.Name, out var used))
                    RemovedUsed(key, Describe(now), used!);
            }
        }

        private void RemovedUsed(string key, string element, string use) =>
            result.Problems.Add(new("FLOW_MERGE_REMOVED_USED", "the text removes " + element + " (@" + IdBase(key) + " of the read), and since the read the Studio wrote `"
                + Clip(use) + "`, which names it: removing it would leave that without it", IdBase(key),
                "keep " + element + " in the text, or also change what names it: the action now is in the edit of this problem (edit it and send it with that basedOn)", currentRead.Text) {
                Data = ReadyEdit() });

        private JsonObject ReadyEdit() => new() { ["edit"] = new JsonObject { ["text"] = currentRead.Text, ["basedOn"] = ModuleFlow.TextSha(currentRead.Text) } };

        // ---- elements ---------------------------------------------------------------------------------------------------------

        // What only one side changed comes from that side; both changed differently: the delivery's, and onConflict says so.
        private static T? Choose<T>(T? ours, T? @base, T? theirs, Func<T?, T?, bool> same, Action? onConflict)
        {
            if (same(ours, @base)) return theirs;
            if (same(theirs, @base) || same(theirs, ours)) return ours;
            onConflict?.Invoke();
            return ours;
        }

        private static bool Same(string? x, string? y) => string.Equals(x, y, StringComparison.Ordinal);
        private static bool SameValue(FlowValue? x, FlowValue? y) => x == null ? y == null : y != null && x.Type == y.Type && x.Text == y.Text;
        private static bool Changed(FlowItem now, FlowItem was) => now.Canon() != was.Canon();

        private FlowItem Action()
        {
            var kind = Choose(o.Kind, b.Kind, t.Kind, Same, () => Conflict(t.Key, "action " + t.Name, "kind", t.Kind, o.Kind))!;
            var name = Choose(o.Name, b.Name, t.Name, Same, () => Conflict(t.Key, "action " + t.Name, "name", t.Name, o.Name))!;
            // The owner of a screen, block or data action is not edited by text (FlowDiff refuses a move): the action's owner
            // now (renamed in the Studio, or written as its path), unless the delivery names another one, which FlowDiff judges.
            var m = new FlowItem("action", kind, t.Key, name) { Owner = o.Owner.Length == 0 || FlowOwners.Same(o.Owner, b.Owner) ? t.Owner : o.Owner };
            Props(m, b, o, t, t.Key, "action " + name);
            foreach (var role in ParameterRoles) m.Items.AddRange(Keyed(role, b, o, t, Parameter, "action " + name));
            foreach (var role in o.Items.Concat(t.Items).Concat(b.Items).Select(i => i.Role).Where(r => !FlowItem.Keyed(r)).Distinct().ToList())
                Parts(m, b, o, t, role, t.Key, "action " + name);
            m.Items.AddRange(NodeItems());
            return m;
        }

        // show: how a conflict lists a value of this element (an assignment's value with its variable, as each side writes it).
        private void Props(FlowItem m, FlowItem bi, FlowItem oi, FlowItem ti, string key, string element, string? prefix = null, Func<string, string?, bool, string?>? show = null,
            IReadOnlyCollection<string>? skip = null)
        {
            foreach (var name in oi.Props.Keys.Concat(ti.Props.Keys).Concat(bi.Props.Keys).Distinct().ToList()) {
                if (skip?.Contains(name) == true) continue;
                oi.Props.TryGetValue(name, out var ov); ti.Props.TryGetValue(name, out var tv); bi.Props.TryGetValue(name, out var bv);
                var value = Value(key, element, (prefix != null ? prefix + " " : "") + name, ov, bv, tv, show == null ? null : new Func<string?, bool, string?>((text, studio) => show(name, text, studio)));
                if (value != null) m.Props[name] = value;
            }
        }

        // ---- values ---------------------------------------------------------------------------------------------------------

        // One value: what only one side changed; both changed differently: merged inside when it can be (a mapping or a record
        // by its fields, a text of more than one line by its lines), else the delivery's (listed).
        private FlowValue? Value(string key, string element, string what, FlowValue? ov, FlowValue? bv, FlowValue? tv, Func<string?, bool, string?>? show = null)
        {
            if (SameValue(ov, bv)) return tv;
            if (SameValue(tv, bv) || SameValue(tv, ov)) return ov;
            if (ov != null && bv != null && tv != null && ov.Type == bv.Type && tv.Type == bv.Type && bv.Type is 'e' or 't') {
                if (bv.Type == 'e' && Fields(key, element, what, ov.Text, bv.Text, tv.Text) is { } fields) return new('e', fields);
                if ((ov.Text.Contains('\n') || bv.Text.Contains('\n') || tv.Text.Contains('\n'))
                    && Lines(key, element, what, ov.Text, bv.Text, tv.Text, code: bv.Type == 'e' || what.EndsWith("Statement", StringComparison.Ordinal) || what.EndsWith("JavaScript", StringComparison.Ordinal)) is { } lines)
                    return new(bv.Type, lines);
            }
            Conflict(key, element, what, show?.Invoke(tv?.Text, true) ?? tv?.Text, show?.Invoke(ov?.Text, false) ?? ov?.Text);
            return ov;
        }

        // A mapping (Source mapTo { F: v, ... }) or a record literal ({ F: v, ... }) on the three sides: the source and each field
        // by itself (the field by its name, without case). Null when the value is not one of those on every side, or when the
        // merged one would not read back whole (the value is then merged whole).
        private string? Fields(string key, string element, string what, string ours, string @base, string theirs)
        {
            var pending = new List<(string What, string? Studio, string? Delivered)>();
            string? text = null;
            if (FlowMapping.Split(@base) is { } bm && FlowMapping.Split(ours) is { } om && FlowMapping.Split(theirs) is { } tm) {
                // A field value reads the attributes of its source first: when the two sides end on different sources, a field of
                // one side read on the other's source would read another element. The mapping is then merged whole: the
                // delivery's, listed (correction 2: Label: Code went from Customer.Code to Parsed.Code, Amount to a parameter).
                if (!SameSource(om.Source, tm.Source) && (!SameSource(om.Source, bm.Source) || !SameSource(tm.Source, bm.Source))) return null;
                var source = Choose(om.Source, bm.Source, tm.Source, Same, () => pending.Add((what + " source", tm.Source, om.Source)))!;
                text = FlowMapping.Compose(source, FieldList(what, om.Fields, bm.Fields, tm.Fields, pending));
            } else if (FlowMapping.SplitRecord(@base) is { } br && FlowMapping.SplitRecord(ours) is { } or && FlowMapping.SplitRecord(theirs) is { } tr) {
                var fields = FieldList(what, or, br, tr, pending);
                var record = fields.Count == 0 ? null : "{ " + string.Join(", ", fields.Select(f => f.Field + ": " + f.Value)) + " }";
                text = record != null && FlowMapping.SplitRecord(record) is { } back && back.SequenceEqual(fields) ? record : null;
            }
            if (text == null) return null;
            foreach (var (field, studio, delivered) in pending) Conflict(key, element, field, studio, delivered);
            return text;
        }

        private static bool SameSource(string x, string y) => string.Equals(x.Trim(), y.Trim(), StringComparison.Ordinal);

        private static List<(string Field, string Value)> FieldList(string what, List<(string Field, string Value)> ours, List<(string Field, string Value)> @base,
            List<(string Field, string Value)> theirs, List<(string What, string? Studio, string? Delivered)> pending)
        {
            static string Id(string field) => field.ToLowerInvariant();
            var bm = @base.GroupBy(f => Id(f.Field)).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var om = ours.GroupBy(f => Id(f.Field)).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var tm = theirs.GroupBy(f => Id(f.Field)).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            var merged = new Dictionary<string, (string Field, string Value)>(StringComparer.Ordinal);
            foreach (var id in om.Keys.Concat(tm.Keys).Concat(bm.Keys).Distinct().ToList()) {
                string? Of(Dictionary<string, (string Field, string Value)> side) => side.TryGetValue(id, out var f) ? f.Value : null;
                var value = Choose(Of(om), Of(bm), Of(tm), Same, () => pending.Add((what + " field " + (om.TryGetValue(id, out var f) ? f.Field : tm[id].Field), Of(tm) ?? "(removed)", Of(om) ?? "(removed)")));
                if (value == null) continue;
                var field = om.TryGetValue(id, out var mine) ? mine.Field : tm.TryGetValue(id, out var now) ? now.Field : bm[id].Field;
                merged[id] = (field, value);
            }
            var order = Order(@base.Select(f => Id(f.Field)).ToList(), ours.Select(f => Id(f.Field)).ToList(), theirs.Select(f => Id(f.Field)).ToList(), merged.Keys.ToHashSet(StringComparer.Ordinal), out _);
            return order.Select(id => merged[id]).ToList();
        }

        // A text of lines merged three ways (diff3): the lines only one side changed come from that side (lines next to each
        // other changed one by each side are both kept); the same lines changed differently on both sides keep the delivery's
        // lines, listed. Null when the texts are too long to compare line by line. code: the text is code (SQL, JavaScript, an
        // expression), whose meaning the read back does not judge: changes of the two sides with no line of the read between
        // them are both kept and listed (kept: both), so a script that now names what the other side renamed is not silent.
        private string? Lines(string key, string element, string what, string ours, string @base, string theirs, bool code = false)
        {
            var bl = @base.Split('\n'); var ol = ours.Split('\n'); var tl = theirs.Split('\n');
            if ((long)(bl.Length + 1) * (Math.Max(ol.Length, tl.Length) + 1) > LineCells) return null;
            var all = Hunks(bl, ol).Select(h => (H: h, Ours: true)).Concat(Hunks(bl, tl).Select(h => (H: h, Ours: false)))
                .OrderBy(x => x.H.BaseStart).ThenBy(x => x.H.BaseEnd).ToList();
            var lines = new List<string>();
            var at = 0;
            (int Start, int End, bool Mine, bool Studio)? previous = null;
            void Neighbours(int start, int end)
            {
                if (!code) return;
                var inside = all.Where(x => x.H.BaseStart >= start && x.H.BaseEnd <= end).ToList();
                Conflict(key, element, what + " (lines " + (start + 1).ToString(CultureInfo.InvariantCulture) + "-" + Math.Max(start + 1, end).ToString(CultureInfo.InvariantCulture) + " of the read)",
                    string.Join("\n", Region(bl, tl, inside.Where(x => !x.Ours).Select(x => x.H).ToList(), start, end)),
                    string.Join("\n", Region(bl, ol, inside.Where(x => x.Ours).Select(x => x.H).ToList(), start, end)),
                    "changed in the Studio and by the delivery next to each other since the read (no line of the read between them): both kept, as one text; read it as one", "both");
            }
            for (var i = 0; i < all.Count;) {
                var group = new List<(Hunk H, bool Ours)> { all[i] };
                var start = all[i].H.BaseStart; var end = all[i].H.BaseEnd;
                // A group is the hunks that share a line of the read, or insert where the group inserts: a hunk that only touches
                // it is a group of its own, so one true overlap never takes the other side's lines next to it (correction 2, A7).
                for (i++; i < all.Count && (all[i].H.BaseStart < end || all[i].H.BaseStart == start && end == start); i++) { group.Add(all[i]); end = Math.Max(end, all[i].H.BaseEnd); }
                lines.AddRange(bl[at..start]);
                at = end;
                var mine = group.Where(g => g.Ours).Select(g => g.H).ToList(); var studio = group.Where(g => !g.Ours).Select(g => g.H).ToList();
                // A group of one side right after a group of the other side's (no line of the read between them).
                if (previous is { } before && before.End == start && (before.Mine && studio.Count > 0 || before.Studio && mine.Count > 0))
                    Neighbours(before.Start, end);
                previous = (start, end, mine.Count > 0, studio.Count > 0);
                var delivered = Region(bl, ol, mine, start, end); var kept = Region(bl, tl, studio, start, end);
                if (studio.Count == 0) lines.AddRange(delivered);
                else if (mine.Count == 0) lines.AddRange(kept);
                // Hunks that only lie next to each other (no line of the read changed by both, no insertion at one place by both)
                // are two changes: both are kept (listed in code).
                else if (!Overlap(mine, studio)) { lines.AddRange(Both(bl, ol, tl, mine, studio, start, end)); Neighbours(start, end); }
                else {
                    lines.AddRange(delivered);
                    if (!delivered.SequenceEqual(kept, StringComparer.Ordinal))
                        Conflict(key, element, what + " (lines " + (start + 1).ToString(CultureInfo.InvariantCulture) + "-" + Math.Max(start + 1, end).ToString(CultureInfo.InvariantCulture) + " of the read)",
                            string.Join("\n", kept), string.Join("\n", delivered),
                            "the same lines changed in the Studio and by the delivery since the read: the delivery's lines; every other line as each side left it");
                }
            }
            lines.AddRange(bl[at..]);
            return string.Join("\n", lines);
        }

        private sealed record Hunk(int BaseStart, int BaseEnd, int SideStart, int SideEnd);

        // Whether a hunk of the delivery and one of the Studio change the same lines of the read, or both insert at one place.
        private static bool Overlap(List<Hunk> mine, List<Hunk> studio) =>
            mine.Any(m => studio.Any(s => m.BaseStart < s.BaseEnd && s.BaseStart < m.BaseEnd
                || m.BaseStart == m.BaseEnd && s.BaseStart == s.BaseEnd && m.BaseStart == s.BaseStart));

        // The read's lines start..end with the hunks of both sides (none overlapping), an insertion before a change at its line.
        private static List<string> Both(string[] @base, string[] ours, string[] theirs, List<Hunk> mine, List<Hunk> studio, int start, int end)
        {
            var lines = new List<string>();
            var at = start;
            foreach (var (hunk, side) in mine.Select(h => (h, ours)).Concat(studio.Select(h => (h, theirs))).OrderBy(x => x.h.BaseStart).ThenBy(x => x.h.BaseEnd)) {
                lines.AddRange(@base[at..hunk.BaseStart]);
                lines.AddRange(side[hunk.SideStart..hunk.SideEnd]);
                at = hunk.BaseEnd;
            }
            lines.AddRange(@base[at..end]);
            return lines;
        }

        // The changes from the read's lines to one side's: the runs of lines that are not in their longest common subsequence.
        private static List<Hunk> Hunks(string[] @base, string[] side)
        {
            int n = @base.Length, m = side.Length;
            var common = new int[n + 1, m + 1];
            for (var i = n - 1; i >= 0; i--)
                for (var j = m - 1; j >= 0; j--)
                    common[i, j] = @base[i] == side[j] ? common[i + 1, j + 1] + 1 : Math.Max(common[i + 1, j], common[i, j + 1]);
            var hunks = new List<Hunk>();
            int x = 0, y = 0;
            while (x < n || y < m) {
                if (x < n && y < m && @base[x] == side[y] && common[x, y] == common[x + 1, y + 1] + 1) { x++; y++; continue; }
                var (bs, ss) = (x, y);
                while (x < n || y < m) {
                    if (x < n && y < m && @base[x] == side[y] && common[x, y] == common[x + 1, y + 1] + 1) break;
                    if (y < m && (x == n || common[x, y + 1] >= common[x + 1, y])) y++; else x++;
                }
                hunks.Add(new(bs, x, ss, y));
            }
            return hunks;
        }

        // The lines of one side for the read's lines start..end: the read's lines with that side's hunks applied.
        private static List<string> Region(string[] @base, string[] side, List<Hunk> hunks, int start, int end)
        {
            var lines = new List<string>();
            var at = start;
            foreach (var hunk in hunks.OrderBy(h => h.BaseStart)) {
                lines.AddRange(@base[at..hunk.BaseStart]);
                lines.AddRange(side[hunk.SideStart..hunk.SideEnd]);
                at = hunk.BaseEnd;
            }
            lines.AddRange(@base[at..end]);
            return lines;
        }

        // ---- keyed items ----------------------------------------------------------------------------------------------------

        // Keyed items of one role (the parameters and locals of the action or of a SQL/JavaScript node), in order.
        private List<FlowItem> Keyed(string role, FlowItem bi, FlowItem oi, FlowItem ti, Func<FlowItem, FlowItem, FlowItem, FlowItem> one, string owner)
        {
            var bs = bi.Items.Where(i => i.Role == role).ToList(); var os = oi.Items.Where(i => i.Role == role).ToList(); var ts = ti.Items.Where(i => i.Role == role).ToList();
            var bm = bs.ToDictionary(i => i.Key, StringComparer.Ordinal); var om = os.ToDictionary(i => i.Key, StringComparer.Ordinal); var tm = ts.ToDictionary(i => i.Key, StringComparer.Ordinal);
            var merged = new Dictionary<string, FlowItem>(StringComparer.Ordinal);
            var oursOrder = os.Select(i => i.Key).ToList();
            foreach (var key in oursOrder.Concat(ts.Select(i => i.Key)).Concat(bs.Select(i => i.Key)).Distinct().ToList()) {
                bool inB = bm.TryGetValue(key, out var x), inO = om.TryGetValue(key, out var y), inT = tm.TryGetValue(key, out var z);
                if (inB && inO && inT) { merged[key] = one(x!, y!, z!); if (Changed(z!, x!)) result.Kept++; }
                else if (inB && inT) { if (Changed(z!, x!)) Removed(key, z!); }
                else if (inB && inO) {
                    var used = revived.Contains(key);
                    if (!Changed(y!, x!) && !used) continue;
                    var copy = y!.Clone(); copy.Key = NewKey(); recreated[key] = copy.Key; merged[copy.Key] = copy;
                    oursOrder[oursOrder.IndexOf(key)] = copy.Key;
                    if (!used)
                        Conflict(key, Describe(y), "removed in the Studio", "(removed)", BlockOf(oursText, IdBase(key)),
                            "changed by the delivery and removed in the Studio since the read: written again as a new element (the delivery's version; its key is gone)");
                }
                else if (inT) { merged[key] = inO ? one(z!, y!, z!) : z!.Clone(); result.Kept++; }
                else if (inO) merged[key] = y!.Clone();
            }
            var order = Order(bs.Select(i => i.Key).ToList(), oursOrder, ts.Select(i => i.Key).ToList(), merged.Keys.ToHashSet(StringComparer.Ordinal), out var clash);
            if (clash) Conflict(ti.Key, owner, role + " order", string.Join(", ", ts.Select(i => i.Name)), string.Join(", ", os.Select(i => i.Name)));
            return order.Select(k => merged[k]).ToList();
        }

        // The order of a list: the side that changed the order of the elements all three have gives it (the delivery's when
        // both did), and what the other side added comes after the element it follows there.
        private static List<string> Order(List<string> bk, List<string> ok, List<string> tk, HashSet<string> exists, out bool clash)
        {
            var common = bk.Where(k => ok.Contains(k) && tk.Contains(k)).ToHashSet(StringComparer.Ordinal);
            var bc = bk.Where(common.Contains).ToList(); var oc = ok.Where(common.Contains).ToList(); var tc = tk.Where(common.Contains).ToList();
            List<string> primary, secondary;
            clash = false;
            if (oc.SequenceEqual(bc)) { primary = tk; secondary = ok; }
            else { primary = ok; secondary = tk; clash = !tc.SequenceEqual(bc) && !tc.SequenceEqual(oc); }
            var order = primary.Where(exists.Contains).Distinct().ToList();
            for (var i = 0; i < secondary.Count; i++) {
                var item = secondary[i];
                if (!exists.Contains(item) || order.Contains(item)) continue;
                var at = -1;
                for (var j = i - 1; j >= 0 && at < 0; j--) at = order.IndexOf(secondary[j]);
                order.Insert(at + 1, item);
            }
            foreach (var item in exists.Where(e => !order.Contains(e)).OrderBy(e => e, StringComparer.Ordinal)) order.Add(item);
            return order;
        }

        private FlowItem Parameter(FlowItem bi, FlowItem oi, FlowItem ti)
        {
            var element = Describe(ti);
            var role = Choose(oi.Role, bi.Role, ti.Role, Same, () => Conflict(ti.Key, element, "role", ti.Role, oi.Role))!;
            var kind = Choose(oi.Kind, bi.Kind, ti.Kind, Same, () => Conflict(ti.Key, element, "kind", ti.Kind, oi.Kind))!;
            var name = Choose(oi.Name, bi.Name, ti.Name, Same, () => Conflict(ti.Key, element, "name", ti.Name, oi.Name))!;
            var m = new FlowItem(role, kind, ti.Key, name);
            Props(m, bi, oi, ti, ti.Key, element);
            return m;
        }

        // ---- names: two elements of one name from the two sides ---------------------------------------------------------------

        // The parameters and locals of the action, and its nodes whose names its expressions read, by name without case: two of
        // one name where each side brought one (new on that side, or renamed by it) were each one name in its own side's text,
        // and an expression of either side could not say which it names. They are one element when both are new with the same
        // role, kind and type (the delivery's values on the Studio's element, listed); otherwise refused. A name one side alone
        // repeats is that side's own (a new call named after a call the action has: FlowDiff names it as the Studio would).
        private void Collisions(FlowItem merged)
        {
            var bp = Parameters(b); var op = Parameters(o); var tp = Parameters(t);
            Collide(merged.Items.Where(i => i.Role is "in" or "out" or "local").ToList(), bp, op, tp, unify: true);
            Collide(merged.Items.Where(i => i.Role == "node" && Outputs.Contains(i.Kind) && i.Name.Length > 0).ToList(), bn, on, tn, unify: false);

            void Collide(List<FlowItem> items, Dictionary<string, FlowItem> bs, Dictionary<string, FlowItem> os, Dictionary<string, FlowItem> ts, bool unify)
            {
                bool Renamed(FlowItem item, Dictionary<string, FlowItem> side) => bs.TryGetValue(item.Key, out var was) && side.TryGetValue(item.Key, out var now)
                    && !string.Equals(now.Name, was.Name, StringComparison.OrdinalIgnoreCase) && string.Equals(now.Name, item.Name, StringComparison.OrdinalIgnoreCase);
                bool StudioNew(FlowItem item) => !bs.ContainsKey(item.Key) && ts.ContainsKey(item.Key);
                bool DeliveryNew(FlowItem item) => !bs.ContainsKey(item.Key) && !ts.ContainsKey(item.Key);
                foreach (var group in items.GroupBy(i => i.Name, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1)) {
                    var list = group.ToList();
                    var studio = list.Where(i => StudioNew(i) || Renamed(i, ts)).ToList();
                    var delivered = list.Where(i => DeliveryNew(i) || Renamed(i, os)).ToList();
                    if (studio.Count == 0 || delivered.Count == 0) continue;
                    if (unify && list.Count == 2 && StudioNew(list[0]) != StudioNew(list[1]) && list.All(i => StudioNew(i) || DeliveryNew(i))) {
                        var keep = list.Single(StudioNew); var mine = list.Single(DeliveryNew);
                        if (keep.Role == mine.Role && keep.Kind == mine.Kind && SameValue(keep.Props.GetValueOrDefault("DataType"), mine.Props.GetValueOrDefault("DataType"))) {
                            var before = Show(keep);
                            keep.Name = mine.Name; keep.Props.Clear();
                            foreach (var (name, value) in mine.Props) keep.Props[name] = value;
                            merged.Items.Remove(mine);
                            Conflict(keep.Key, Describe(keep), "created in the Studio and by the delivery", before, Show(mine),
                                "created by the delivery and in the Studio since the read with the same name: one element, the delivery's values");
                            continue;
                        }
                    }
                    NameTaken(list.Select(Describe), delivered[0]);
                }
            }
        }

        private void NameTaken(IEnumerable<string> elements, FlowItem item) =>
            result.Problems.Add(new("FLOW_MERGE_NAME_TAKEN", "since the read the Studio and the text gave one name to two elements (" + string.Join(", ", elements)
                + "): they are not the same element, and an expression could not say which one it names", IdBase(item.Key),
                "give the text's element another name, or write it on the action now (the edit of this problem: the action now, with its basedOn)", currentRead.Text) { Data = ReadyEdit() });

        // ---- nodes --------------------------------------------------------------------------------------------------------------

        private List<FlowItem> NodeItems()
        {
            // A node the Studio removed that the edit changed comes back as a new node (its key is gone): decided before the
            // connectors, which go to it again.
            foreach (var (key, mine) in on)
                if (bn.TryGetValue(key, out var was) && !tn.ContainsKey(key) && !recreated.ContainsKey(key) && Changed(mine, was)) {
                    recreated[key] = NewKey();
                    Conflict(key, DescribeAgainst(key, mine), "removed in the Studio", "(removed)", BlockOf(oursText, IdBase(key)),
                        "changed by the delivery and removed in the Studio since the read: written again as a new node (the delivery's version; its key is gone)");
                }
            var merged = new List<FlowItem>();
            foreach (var key in on.Keys.Concat(tn.Keys).Concat(bn.Keys).Distinct().ToList()) {
                bool inB = bn.TryGetValue(key, out var x), inO = on.TryGetValue(key, out var y), inT = tn.TryGetValue(key, out var z);
                if (inB && inO && inT) { merged.Add(Node(x!, y!, z!)); if (Changed(z!, x!)) result.Kept++; }
                else if (inB && inT) { if (Changed(z!, x!)) Removed(key, z!); }
                else if (inB && inO) {
                    if (recreated.TryGetValue(key, out var again)) { var copy = Remap(y!.Clone()); copy.Key = again; merged.Add(copy); }
                }
                else if (inT) { merged.Add(inO ? Node(z!, y!, z!) : z!.Clone()); result.Kept++; }
                else if (inO) merged.Add(Remap(y!.Clone()));
            }
            return merged;
        }

        // The connectors of a copy of the delivery's node (and of its cases) that go to a node written again go to the new one.
        private FlowItem Remap(FlowItem node)
        {
            foreach (var (edge, to) in node.Edges.ToList()) if (recreated.TryGetValue(to, out var again)) node.Edges[edge] = again;
            foreach (var part in node.Items.Where(p => !FlowItem.Keyed(p.Role))) Remap(part);
            return node;
        }

        private FlowItem Node(FlowItem bi, FlowItem oi, FlowItem ti)
        {
            var key = ti.Key;
            var element = Describe(ti);
            // A node the delivery made another kind of (or an opaque one): the delivery's whole.
            if (oi.Kind != bi.Kind || oi.Opaque != bi.Opaque) {
                if (Changed(ti, bi)) Conflict(key, element, "node", BlockOf(currentRead.Text, IdNow(key)), BlockOf(oursText, IdBase(key)),
                    "replaced by the delivery and changed in the Studio since the read: the delivery's node");
                return Remap(oi.Clone());
            }
            if (ti.Kind != bi.Kind || ti.Opaque != bi.Opaque) {
                if (!Changed(oi, bi)) return ti.Clone();
                Conflict(key, element, "node", BlockOf(currentRead.Text, IdNow(key)), BlockOf(oursText, IdBase(key)), "changed in the Studio and by the delivery: the delivery's node");
                return Remap(oi.Clone());
            }
            var name = Choose(oi.Name, bi.Name, ti.Name, Same, () => Conflict(key, element, "name", ti.Name, oi.Name))!;
            var m = new FlowItem("node", ti.Kind, key, name) { Opaque = ti.Opaque, OpaqueReasons = ti.OpaqueReasons, CallKind = ti.CallKind };
            // A call one side pointed at another action while the other side changed it (its action or its arguments): the
            // arguments of one action are not the arguments of another, so the call is merged whole, the delivery's action and
            // arguments, listed (correction 2: the delivery's value of FaPick's Code went to FaOther's Id, or to no parameter).
            var whole = WholeCall(bi, oi, ti);
            Props(m, bi, oi, ti, key, element, skip: whole ? CallProps : null);
            if (whole) {
                foreach (var prop in CallProps) if (oi.Props.TryGetValue(prop, out var value)) m.Props[prop] = value;
                Conflict(key, element, "call", Call(ti), Call(oi),
                    "pointed at another action on one side and changed on the other since the read: the delivery's call (its action and its arguments)");
            }
            Edges(m, bi, oi, ti, key, element);
            // Parts, one by one; then the node's own parameters (SQL, JavaScript) by key.
            foreach (var role in oi.Items.Concat(ti.Items).Concat(bi.Items).Where(i => !FlowItem.Keyed(i.Role)).Select(i => i.Role).Distinct().ToList()) {
                if (whole && role == "argument") { m.Items.AddRange(oi.Items.Where(i => i.Role == role).Select(i => Remap(i.Clone()))); continue; }
                Parts(m, bi, oi, ti, role, key, element);
            }
            foreach (var role in ParameterRoles) m.Items.AddRange(Keyed(role, bi, oi, ti, Parameter, element));
            return m;
        }

        // The properties that say which action a call runs.
        private static readonly string[] CallProps = ["Action", FlowRules.CallProperty];

        private static bool Retargeted(FlowItem was, FlowItem side) => CallProps.Any(p => !SameValue(was.Props.GetValueOrDefault(p), side.Props.GetValueOrDefault(p)));

        // Whether one side pointed the call at another action and the other side changed the call too (pointed it elsewhere,
        // or changed its arguments).
        private static bool WholeCall(FlowItem bi, FlowItem oi, FlowItem ti)
        {
            if (!CallProps.Any(p => bi.Props.ContainsKey(p) || oi.Props.ContainsKey(p) || ti.Props.ContainsKey(p))) return false;
            bool studio = Retargeted(bi, ti), delivered = Retargeted(bi, oi);
            if (!studio && !delivered) return false;
            static string Arguments(FlowItem item) => string.Concat(item.Items.Where(i => i.Role == "argument").Select(i => i.Canon()).Order(StringComparer.Ordinal));
            if (studio && delivered) return CallProps.Any(p => !SameValue(oi.Props.GetValueOrDefault(p), ti.Props.GetValueOrDefault(p))) || Arguments(oi) != Arguments(ti);
            return studio ? Arguments(oi) != Arguments(bi) : Arguments(ti) != Arguments(bi);
        }

        // A call as a conflict lists it: its action and its arguments.
        private static string Call(FlowItem node) =>
            (node.Prop("Action") ?? "?") + "(" + string.Join(", ", node.Items.Where(i => i.Role == "argument").Select(i => i.Name + "=" + i.Prop("Value"))) + ")";

        // Connectors, one by one: one that goes to a node written again goes there whatever the Studio did.
        private void Edges(FlowItem m, FlowItem bi, FlowItem oi, FlowItem ti, string key, string element)
        {
            foreach (var edge in oi.Edges.Keys.Concat(ti.Edges.Keys).Concat(bi.Edges.Keys).Distinct().ToList()) {
                oi.Edges.TryGetValue(edge, out var ov); bi.Edges.TryGetValue(edge, out var bv); ti.Edges.TryGetValue(edge, out var tv);
                string? to;
                if (ov != null && recreated.TryGetValue(ov, out var again)) to = again;
                else {
                    var clash = false;
                    to = Choose(ov, bv, tv, Same, () => clash = true);
                    if (clash) clashes.Add((m, edge, ov, bv, tv, key, element));
                }
                if (to != null) m.Edges[edge] = to;
            }
        }

        // ---- parts: the parts of a node (or of the action) one by one -------------------------------------------------------------

        // The parts of one role, paired across the three sides (Match), each merged as an element of its own: what one side
        // added stays, what one side removed goes (listed when the other side changed it; written again when the delivery changed
        // what the Studio removed), and the order as the keyed lists merge theirs.
        private void Parts(FlowItem m, FlowItem bi, FlowItem oi, FlowItem ti, string role, string key, string element)
        {
            var bs = bi.Items.Where(i => i.Role == role).ToList(); var os = oi.Items.Where(i => i.Role == role).ToList(); var ts = ti.Items.Where(i => i.Role == role).ToList();
            var ordered = !FlowItem.Unordered(role);
            // Two parts of different identities (another variable, another parameter) are never one part. An argument's parameter
            // is its identity only where the side points the call elsewhere: a rename of the called action's parameter keeps the
            // pairing by place.
            var mo = Match(bs, os, role, ordered, role != "argument" || Retargeted(bi, oi)); var mt = Match(bs, ts, role, ordered, role != "argument" || Retargeted(bi, ti));
            // A part without an identity that the delivery changed a little and the Studio replaced by another (a filter, a case
            // whose text has little left of the read's): the Studio removed it and added its own, and both stay (the delivery's
            // written again, listed), never the Studio's lost as a "conflict" (correction 2, A3).
            for (var i = 0; i < bs.Count; i++) {
                if (mo[i] < 0 || mt[i] < 0 || Identity(bs[i]) != null) continue;
                var x = bs[i]; var y = os[mo[i]]; var z = ts[mt[i]];
                if (!Changed(y, x) || !Changed(z, x) || !Changed(z, y)) continue;
                if (Like(Content(x), Content(z)) < 0.5 && Like(Content(x), Content(y)) >= 0.5) mt[i] = -1;
            }
            var oIds = new string[os.Count]; var tIds = new string[ts.Count];
            for (var i = 0; i < bs.Count; i++) { if (mo[i] >= 0) oIds[mo[i]] = "b" + i; if (mt[i] >= 0) tIds[mt[i]] = "b" + i; }
            for (var j = 0; j < os.Count; j++) oIds[j] ??= "o" + j;
            for (var j = 0; j < ts.Count; j++) tIds[j] ??= "t" + j;
            var merged = new Dictionary<string, FlowItem>(StringComparer.Ordinal);
            for (var i = 0; i < bs.Count; i++) {
                var x = bs[i];
                if (mo[i] >= 0 && mt[i] >= 0) {
                    merged["b" + i] = Part(x, os[mo[i]], ts[mt[i]], key, element);
                    if (Changed(ts[mt[i]], x)) result.Kept++;
                } else if (mt[i] >= 0) {
                    if (Changed(ts[mt[i]], x))
                        Conflict(key, element, Label(x) + " removed by the delivery", Show(ts[mt[i]]), "(removed)",
                            "removed by the delivery and changed in the Studio since the read: removed (the delivery's version)");
                } else if (mo[i] >= 0) {
                    var y = os[mo[i]];
                    if (!Changed(y, x)) continue;
                    merged["b" + i] = Remap(y.Clone());
                    Conflict(key, element, Label(x) + " removed in the Studio", "(removed)", Show(y),
                        "changed by the delivery and removed in the Studio since the read: written again (the delivery's version)");
                }
            }
            var oursAdded = Enumerable.Range(0, os.Count).Where(j => oIds[j][0] == 'o').ToList();
            foreach (var j in oursAdded) merged[oIds[j]] = Remap(os[j].Clone());
            for (var j = 0; j < ts.Count; j++) {
                if (tIds[j][0] != 't') continue;
                var y = ts[j];
                // The same part added on both sides: one. Another part of the same identity added on both sides (an assignment
                // of the same variable): one, the delivery's, listed.
                var twin = oursAdded.FirstOrDefault(k => os[k].Canon() == y.Canon(), -1);
                if (twin < 0 && Identity(y) is { } identity) {
                    twin = oursAdded.FirstOrDefault(k => string.Equals(Identity(os[k]), identity, StringComparison.OrdinalIgnoreCase), -1);
                    if (twin >= 0) Conflict(key, element, Label(y) + " added", Show(y), Show(os[twin]),
                        "added in the Studio and by the delivery since the read: the delivery's");
                }
                if (twin >= 0) { tIds[j] = oIds[twin]; continue; }
                merged[tIds[j]] = y.Clone();
                result.Kept++;
            }
            var exists = merged.Keys.ToHashSet(StringComparer.Ordinal);
            List<string> order;
            if (ordered) {
                order = Order(Enumerable.Range(0, bs.Count).Select(i => "b" + i).ToList(), oIds.ToList(), tIds.ToList(), exists, out var clash);
                if (clash) Conflict(key, element, role + " order", string.Join("\n", ts.Select(Show)), string.Join("\n", os.Select(Show)));
            } else order = oIds.Concat(tIds).Where(exists.Contains).Distinct().Concat(exists.OrderBy(e => e, StringComparer.Ordinal)).Distinct().ToList();
            foreach (var id in order) m.Items.Add(merged[id]);
        }

        // One part on the three sides: its name, values, connectors (a case's) and own parts (an event's arguments).
        private FlowItem Part(FlowItem bi, FlowItem oi, FlowItem ti, string key, string element)
        {
            var label = Label(ti);
            var kind = Choose(oi.Kind, bi.Kind, ti.Kind, Same, () => Conflict(key, element, label + " kind", ti.Kind, oi.Kind))!;
            var name = Choose(oi.Name, bi.Name, ti.Name, Same, () => Conflict(key, element, label + " name", ti.Name, oi.Name))!;
            var m = new FlowItem(ti.Role, kind, ti.Key, name);
            Props(m, bi, oi, ti, key, element, label, ti.Role == "assignment"
                ? new Func<string, string?, bool, string?>((name, text, studio) => name == "Value" && text != null ? (studio ? ti : oi).Prop("Variable") + " = " + text : text) : null);
            Edges(m, bi, oi, ti, key, element);
            foreach (var role in oi.Items.Concat(ti.Items).Concat(bi.Items).Where(i => !FlowItem.Keyed(i.Role)).Select(i => i.Role).Distinct().ToList())
                Parts(m, bi, oi, ti, role, key, element);
            partBase[m] = bi;
            return m;
        }

        // What a part is, where it has an identity of its own: an assignment by the variable it writes, an argument by its
        // parameter, a source or a column by its name, a join by its sources, a sort by what it sorts by, an output by its type.
        private static string? Identity(FlowItem part) => part.Role switch {
            "assignment" => part.Prop("Variable")?.Trim(),
            "argument" or "event" or "source" or "group" or "agg" or "calc" => part.Name.Length > 0 ? part.Name : null,
            "join" => part.Prop("LeftSource") is { } left && part.Prop("RightSource") is { } right ? left + "~" + right : null,
            "sort" => part.Prop("Attribute"),
            "output" => part.Prop("EntityOrStructure"),
            _ => null };

        private static string Label(FlowItem part) => part.Role + (Identity(part) is { } identity ? " " + identity : part.Prop("Condition") is { } condition ? " " + condition
            : part.Prop("Value") is { } value && part.Role == "case" ? " " + value : "");

        // What a part says, without its role and kind (the likeness of two parts' own values).
        private static string Content(FlowItem part) =>
            string.Join("\n", part.Props.Values.Select(v => v.Text).Concat(part.Items.Select(Content)));

        // The parts of one side paired with the read's: equal parts first (in order where the order means something), then by
        // identity (only one of it on each side), then the rest by place (the same number between two pairs, in order, when
        // each pair fits) or by likeness, the closest pair first. map[i] is the side's index of the read's part i, or -1.
        // strict: two parts whose identities differ are never paired (by place or by likeness).
        private static int[] Match(List<FlowItem> bs, List<FlowItem> xs, string role, bool ordered, bool strict = true)
        {
            var map = Enumerable.Repeat(-1, bs.Count).ToArray();
            var used = new bool[xs.Count];
            var bc = bs.Select(p => p.Canon()).ToList(); var xc = xs.Select(p => p.Canon()).ToList();
            if (ordered) {
                foreach (var (i, j) in Common(bc, xc)) { map[i] = j; used[j] = true; }
                // A part the side only moved (equal, outside the common order) is the same part, never one removed and one new.
                for (var i = 0; i < bs.Count; i++) {
                    if (map[i] >= 0) continue;
                    var j = Enumerable.Range(0, xs.Count).FirstOrDefault(k => !used[k] && xc[k] == bc[i], -1);
                    if (j >= 0) { map[i] = j; used[j] = true; }
                }
            } else
                for (var i = 0; i < bs.Count; i++) {
                    var j = Enumerable.Range(0, xs.Count).FirstOrDefault(k => !used[k] && xc[k] == bc[i], -1);
                    if (j >= 0) { map[i] = j; used[j] = true; }
                }
            for (var i = 0; i < bs.Count; i++) {
                if (map[i] >= 0 || Identity(bs[i]) is not { } identity) continue;
                var bases = Enumerable.Range(0, bs.Count).Where(k => map[k] < 0 && string.Equals(Identity(bs[k]), identity, StringComparison.OrdinalIgnoreCase)).ToList();
                var sides = Enumerable.Range(0, xs.Count).Where(k => !used[k] && string.Equals(Identity(xs[k]), identity, StringComparison.OrdinalIgnoreCase)).ToList();
                if (bases.Count == 1 && sides.Count == 1) { map[i] = sides[0]; used[sides[0]] = true; }
            }
            bool Fits(int i, int k) => !strict || Identity(bs[i]) is not { } a || Identity(xs[k]) is not { } c || string.Equals(a, c, StringComparison.OrdinalIgnoreCase);
            void Pair(List<int> left, List<int> right)
            {
                if (left.Count == 0 || right.Count == 0) return;
                if (left.Count == right.Count && Enumerable.Range(0, left.Count).All(k => Fits(left[k], right[k]))) {
                    for (var k = 0; k < left.Count; k++) { map[left[k]] = right[k]; used[right[k]] = true; }
                    return;
                }
                // Else by likeness (at least half alike), the closest pair first: never the read's first part with whatever is
                // closest to it while a closer pair waits (correction 2: a filter or a case the Studio changed was lost when the
                // Studio removed another one).
                var candidates = left.SelectMany(i => right.Where(k => !used[k] && Fits(i, k)).Select(k => (I: i, K: k, Like: Like(bc[i], xc[k]))))
                    .Where(c => c.Like >= 0.5).OrderByDescending(c => c.Like).ThenBy(c => c.I).ThenBy(c => c.K).ToList();
                foreach (var (i, k, _) in candidates) if (map[i] < 0 && !used[k]) { map[i] = k; used[k] = true; }
            }
            if (ordered) {
                // Between two pairs in order (a monotone chain of the pairs), the unpaired ones of each side.
                var anchors = new List<(int I, int J)> { (-1, -1) };
                for (var i = 0; i < bs.Count; i++) if (map[i] >= 0 && map[i] > anchors[^1].J) anchors.Add((i, map[i]));
                anchors.Add((bs.Count, xs.Count));
                for (var a = 0; a + 1 < anchors.Count; a++) {
                    var (i0, j0) = anchors[a]; var (i1, j1) = anchors[a + 1];
                    Pair(Enumerable.Range(i0 + 1, Math.Max(0, i1 - i0 - 1)).Where(i => map[i] < 0).ToList(), Enumerable.Range(j0 + 1, Math.Max(0, j1 - j0 - 1)).Where(j => !used[j]).ToList());
                }
            } else Pair(Enumerable.Range(0, bs.Count).Where(i => map[i] < 0).ToList(), Enumerable.Range(0, xs.Count).Where(j => !used[j]).ToList());
            return map;
        }

        // The pairs of a longest common subsequence of two lists of texts.
        private static List<(int I, int J)> Common(List<string> a, List<string> c)
        {
            var common = new int[a.Count + 1, c.Count + 1];
            for (var i = a.Count - 1; i >= 0; i--)
                for (var j = c.Count - 1; j >= 0; j--)
                    common[i, j] = a[i] == c[j] ? common[i + 1, j + 1] + 1 : Math.Max(common[i + 1, j], common[i, j + 1]);
            var pairs = new List<(int, int)>();
            for (int i = 0, j = 0; i < a.Count && j < c.Count;) {
                if (a[i] == c[j]) { pairs.Add((i, j)); i++; j++; }
                else if (common[i + 1, j] >= common[i, j + 1]) i++; else j++;
            }
            return pairs;
        }

        // How alike two texts are: 1 - their edit distance over the longer one (the first 300 characters).
        private static double Like(string x, string y)
        {
            if (x.Length > 300) x = x[..300];
            if (y.Length > 300) y = y[..300];
            if (x.Length == 0 && y.Length == 0) return 1;
            var previous = new int[y.Length + 1]; var row = new int[y.Length + 1];
            for (var j = 0; j <= y.Length; j++) previous[j] = j;
            for (var i = 1; i <= x.Length; i++) {
                row[0] = i;
                for (var j = 1; j <= y.Length; j++)
                    row[j] = Math.Min(Math.Min(row[j - 1] + 1, previous[j] + 1), previous[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1));
                (previous, row) = (row, previous);
            }
            return 1 - (double)previous[y.Length] / Math.Max(x.Length, y.Length);
        }

        // ---- the graph: steps both sides inserted after the same node, steps after a removed node, connectors to a node gone ----
        private void Graph(FlowItem merged)
        {
            var nodes = Nodes(merged);
            var newOurs = on.Keys.Where(k => !bn.ContainsKey(k)).Concat(recreated.Values).ToHashSet(StringComparer.Ordinal);
            var newTheirs = tn.Keys.Where(k => !bn.ContainsKey(k)).ToHashSet(StringComparer.Ordinal);
            foreach (var (owner, edge, ov, bv, tv, key, element) in clashes) {
                string? note = null;
                if (edge != "Attached" && tv is { Length: > 0 } && newTheirs.Contains(tv) && ov is { Length: > 0 } && nodes.ContainsKey(tv)) {
                    var (theirExits, theirTargets) = Exits(tv, newTheirs, nodes);
                    // The Studio's steps rejoin the flow where the read's connector went (bv): from there on, where the delivery goes.
                    void Rejoin(string to) { foreach (var (from, e) in theirExits) if (from.Edges[e] == bv || theirTargets.Count == 1) from.Edges[e] = to; }
                    if (newOurs.Contains(ov)) {
                        var (ourExits, ourTargets) = Exits(ov, newOurs, nodes);
                        if (ourTargets.Count == 1) {
                            var next = ourTargets.Single();
                            foreach (var (from, e) in ourExits) from.Edges[e] = tv;
                            Rejoin(next);
                            note = "steps inserted here by the delivery and in the Studio since the read: both kept, the delivery's first";
                        }
                    } else {
                        owner.Edges[edge] = tv;
                        Rejoin(ov);
                        note = "the Studio inserted steps here since the read and the delivery goes elsewhere: the Studio's steps kept, then where the delivery goes";
                    }
                }
                Conflict(key, element, "connector " + edge, Target(tv), Target(ov), note ?? "changed in the Studio and by the delivery: the delivery's connector",
                    note != null ? "both" : "delivery");
            }
            Reconnect(merged, nodes, newTheirs);
            // A connector to a node that no longer is: where the side that removed it sends what went to it; else where it went
            // on in the read; else, when the delivery goes to it, it is written again.
            for (var round = 0; round < 64; round++) {
                var changed = false;
                foreach (var node in nodes.Values.ToList()) {
                    if (node.Edges.TryGetValue("Attached", out var attached) && attached.Length > 0 && !nodes.ContainsKey(attached)) {
                        if (recreated.TryGetValue(attached, out var again) && nodes.ContainsKey(again)) node.Edges["Attached"] = again; else node.Edges.Remove("Attached");
                        changed = true;
                    }
                    foreach (var (owner, edge, to) in Out(node).ToList()) {
                        if (to.Length == 0 || nodes.ContainsKey(to)) continue;
                        var instead = recreated.TryGetValue(to, out var again) && nodes.ContainsKey(again) ? again : Substitute(to, node.Key, nodes);
                        if (instead == null && on.TryGetValue(to, out var mine)) {
                            var copy = Remap(mine.Clone());
                            copy.Key = recreated.TryGetValue(to, out var known) ? known : recreated[to] = NewKey();
                            nodes[copy.Key] = copy; merged.Items.Add(copy);
                            Conflict(to, DescribeAgainst(to, mine), "removed in the Studio", "(removed)", BlockOf(oursText, IdBase(to)),
                                "removed in the Studio since the read, and the delivery still goes to it: written again as a new node (its key is gone)");
                            instead = copy.Key;
                        }
                        owner.Edges[edge] = instead ?? "";
                        changed = true;
                    }
                }
                if (!changed) break;
            }
        }

        // Steps the Studio inserted right after a node the delivery removed take its place: what went to that node in the read
        // and the delivery sends elsewhere goes to the Studio's steps, and they go on where the delivery goes (where they went on
        // to the node's own next).
        private void Reconnect(FlowItem merged, Dictionary<string, FlowItem> nodes, HashSet<string> newTheirs)
        {
            foreach (var (gone, was) in bn) {
                if (!tn.TryGetValue(gone, out var now) || on.ContainsKey(gone) || recreated.ContainsKey(gone) || nodes.ContainsKey(gone)) continue;
                var after = Out(now).Where(e => e.Edge != "Attached" && newTheirs.Contains(e.To) && nodes.ContainsKey(e.To)).Select(e => (e.Edge, e.To)).Distinct().ToList();
                if (after.Count != 1) continue;
                var (edge, first) = after[0];
                var next = was.Edges.GetValueOrDefault(edge);
                // The merged connectors that went to the removed node in the read and that the delivery sends elsewhere now.
                var into = new List<(FlowItem Owner, string Edge, string To)>();
                foreach (var node in nodes.Values) {
                    if (bn.TryGetValue(node.Key, out var before))
                        foreach (var (e, to) in node.Edges.ToList())
                            if (e != "Attached" && before.Edges.GetValueOrDefault(e) == gone && to != gone && to != first) into.Add((node, e, to));
                    foreach (var part in node.Items.Where(p => p.Role == "case"))
                        if (partBase.TryGetValue(part, out var readCase) && readCase.Edges.GetValueOrDefault("Target") == gone
                            && part.Edges.GetValueOrDefault("Target") is { } to && to != gone && to != first) into.Add((part, "Target", to));
                }
                var goes = into.Select(i => i.To).Distinct().ToList();
                if (goes.Count != 1) continue;
                foreach (var (owner, e, _) in into) owner.Edges[e] = first;
                var (exits, targets) = Exits(first, newTheirs, nodes);
                foreach (var (owner, e) in exits) if (owner.Edges[e] == next || targets.Count == 1) owner.Edges[e] = goes[0];
                Conflict(gone, Describe(now), "steps inserted after it in the Studio", BlockOf(currentRead.Text, IdNow(first)), "(removed)",
                    "removed by the delivery, and the Studio inserted steps after it since the read: the Studio's steps take its place, then where the delivery goes", "both");
            }
        }

        // Every node the Studio has in its flow (reached from the Start or a handler) that the merged flow no longer reaches, but
        // that the delivery did not take out of its own flow either: the merge fails (the Studio's step would stop running).
        private void Reach(FlowItem merged)
        {
            static HashSet<string> Reached(IEnumerable<FlowItem> items)
            {
                var nodes = items.Where(i => i.Role == "node").GroupBy(i => i.Key).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var pending = new Stack<string>(nodes.Values.Where(n => n.Kind is "StartNode" or "ExceptionHandlerNode").Select(n => n.Key));
                while (pending.TryPop(out var key)) {
                    if (!seen.Add(key) || !nodes.TryGetValue(key, out var node)) continue;
                    foreach (var (_, _, to) in Out(node)) if (to.Length > 0) pending.Push(to);
                }
                return seen;
            }
            var here = Reached(merged.Items); var studio = Reached(t.Items); var delivered = Reached(o.Items);
            var lost = merged.Items.Where(i => i.Role == "node" && i.Kind is not ("CommentNode" or "StartNode" or "ExceptionHandlerNode") && !here.Contains(i.Key)
                && studio.Contains(i.Key) && (!on.ContainsKey(i.Key) || delivered.Contains(i.Key))).ToList();
            if (lost.Count == 0) return;
            result.Failure = "the Studio's steps " + string.Join(", ", lost.Take(4).Select(n => Describe(n) + " @" + IdNow(n.Key)))
                + " would be left out of the flow (no connector would reach them after the merge)";
        }

        private string? Substitute(string gone, string from, Dictionary<string, FlowItem> nodes)
        {
            // The side that removed it sends what went to it elsewhere now.
            var side = bn.ContainsKey(gone) && !on.ContainsKey(gone) ? on : tn;
            foreach (var (key, was) in bn)
                foreach (var (edge, to) in was.Edges)
                    if (to == gone && edge != "Attached" && side.TryGetValue(key, out var now) && now.Edges.TryGetValue(edge, out var instead)
                        && instead.Length > 0 && instead != gone && instead != from && nodes.ContainsKey(instead))
                        return instead;
            // Where it went on in the read (or in the delivery).
            var at = gone;
            for (var i = 0; i < 64; i++) {
                var next = bn.GetValueOrDefault(at)?.Edges.GetValueOrDefault("Target") ?? on.GetValueOrDefault(at)?.Edges.GetValueOrDefault("Target");
                if (string.IsNullOrEmpty(next) || next == from) return null;
                if (nodes.ContainsKey(next)) return next;
                at = next;
            }
            return null;
        }

        private static IEnumerable<(FlowItem Owner, string Edge, string To)> Out(FlowItem node)
        {
            foreach (var (edge, to) in node.Edges.ToList()) if (edge != "Attached") yield return (node, edge, to);
            foreach (var part in node.Items.Where(p => p.Role == "case").ToList())
                if (part.Edges.TryGetValue("Target", out var to)) yield return (part, "Target", to);
        }

        // The connectors that leave the steps one side added (reached from start through its new nodes) and the nodes they go to.
        private static (List<(FlowItem Owner, string Edge)> Exits, HashSet<string> Targets) Exits(string start, HashSet<string> added, Dictionary<string, FlowItem> nodes)
        {
            var exits = new List<(FlowItem, string)>();
            var targets = new HashSet<string>(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var pending = new Stack<string>();
            pending.Push(start);
            while (pending.TryPop(out var key)) {
                if (!seen.Add(key) || !nodes.TryGetValue(key, out var node)) continue;
                foreach (var (owner, edge, to) in Out(node)) {
                    if (to.Length == 0) continue;
                    if (added.Contains(to)) pending.Push(to);
                    else { exits.Add((owner, edge)); targets.Add(to); }
                }
            }
            return (exits, targets);
        }

        private void Print(FlowItem merged)
        {
            var document = FlowPrinter.Print(merged, idNow);
            if (document.Unprintable.Count > 0) { result.Failure = "the merged action does not print: " + string.Join("; ", document.Unprintable.Take(3)); return; }
            // The text reads back as the merged action (its own fixed point, in the ids it was printed with).
            try {
                if (FlowParser.Parse(document.Text, document.Keys).Canon() != merged.Canon()) { result.Failure = "the merged action does not read back from its text"; return; }
            } catch (FormatException error) { result.Failure = "the merged text does not parse: " + error.Message; return; }
            result.Text = document.Text;
        }

        // ---- the answer ----------------------------------------------------------------------------------------------------------

        private string NewKey() => FlowParser.FreshPrefix + "m" + (++fresh).ToString(CultureInfo.InvariantCulture);
        private string IdNow(string key) => idNow.GetValueOrDefault(key) ?? key;
        private string IdBase(string key) => idBase.GetValueOrDefault(key) ?? key;
        private string Target(string? key) => key == null ? "(none)" : key.Length == 0 ? "(no connector)" : "@" + (idNow.GetValueOrDefault(key) ?? idBase.GetValueOrDefault(key) ?? key);

        private void Removed(string key, FlowItem now) =>
            Conflict(key, Describe(now), "removed by the delivery", BlockOf(currentRead.Text, IdNow(key)), "(removed)",
                "removed by the delivery and changed in the Studio since the read: removed (the delivery's version)");

        private static string Describe(FlowItem item) => item.Role switch {
            "node" => item.Name.Length > 0 ? item.Kind + " " + item.Name : item.Kind,
            "action" => "action " + item.Name,
            _ => item.Role + " " + item.Name };

        private static string? Show(FlowItem? item) => item == null ? null : item.Canon().TrimEnd('\n');

        private static string Clip(string text) => text.Length <= 160 ? text : text[..160] + "…";

        // The element as one side's text writes it: its line and the deeper lines under it that are its own (assignments,
        // @{...}, code), not the next elements of a branch (lines with an id of their own).
        private static string? BlockOf(string text, string id)
        {
            var lines = text.Split('\n');
            var at = Array.FindIndex(lines, l => l.EndsWith(" @" + id, StringComparison.Ordinal));
            if (at < 0) return null;
            static int Depth(string l) => l.Length - l.TrimStart(' ').Length;
            var block = new List<string> { lines[at].Trim() };
            for (var i = at + 1; i < lines.Length && lines[i].Length > 0 && Depth(lines[i]) > Depth(lines[at]); i++) {
                if (FlowSyntax.SplitKey(lines[i].Trim(), out _, out _) || lines[i].TrimStart().StartsWith("///", StringComparison.Ordinal)) break;
                block.Add(lines[i].Trim());
            }
            return string.Join("\n", block);
        }

        private void Conflict(string key, string element, string what, string? studio, string? delivered, string? note = null, string kept = "delivery")
        {
            static string? Clip(string? text) => text == null ? null : text.Length <= 400 ? text : text[..400] + "…";
            result.Conflicts.Add(new JsonObject {
                ["key"] = key, ["id"] = idNow.TryGetValue(key, out var now) ? now : idBase.GetValueOrDefault(key),
                ["element"] = element, ["what"] = what, ["studio"] = Clip(studio ?? "(none)"), ["delivered"] = Clip(delivered ?? "(none)"),
                ["kept"] = kept, ["note"] = note ?? "changed in the Studio and by the delivery since the read: the delivery's" });
        }
    }
}
