using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// C2 of the plan "Texto do SSAM" (ScreenHtmlEdit): the edit of one reading, planned over this module and applied through an
// IScreenHtmlWriter. The plan is the difference element by element (k) between the reading's canonical form and the edited
// text's; nothing outside the elements the edit changed is written, but the markers of the engine on a screen of the op (CX17
// review 3, M6: the gap marker follows the parent's space, decided again on every link, button and form of the page).
public sealed partial class ScreenHtmlModule<T>
{
    // The same module after a change confined to the root of `rootKey`: only that root's subtree is walked again.
    public ScreenHtmlModule<T> Refresh(string rootKey)
    {
        var dirty = RootIndexes().FirstOrDefault(i => key[i] == rootKey, -1);
        return dirty < 0 ? new ScreenHtmlModule<T>(module, r) : new ScreenHtmlModule<T>(module, r, this, dirty);
    }

    // The plan of an edit of `reading` (read from this module): merged, decoded and checked. Refused when it has problems;
    // otherwise Apply writes it and Verify compares what the module reads back with the edited text.
    // theme: the theme the page shows (CX17 review 3, M6/M7), which lets the plan decide the markers of the engine again on a
    // screen of the op; null: no marker is decided (as before).
    public EditPlan Edit(ScreenHtmlDocument reading, IReadOnlyList<string> edits, string pointer = "/edit", Anvil.Core.ScreenVisual.PageTheme? theme = null)
        => new(this, reading, edits, pointer, theme: theme);

    // What uses the element at `index` (or anything under it) from outside the removed set `gone`: the paths, for
    // HTML_DELETE_IN_USE (and the battery, which removes only what nothing uses).
    internal List<string> UsesOutside(int index, HashSet<int> gone, int rootIndex)
    {
        var uses = new List<string>();
        foreach (var d in Descendants(index).Append(index)) {
            if (!gone.Contains(d)) continue;
            if (role[d] is not ("widget" or "variable" or "parameter")) continue;
            IEnumerable<T> referrers;
            try { referrers = r.ReferrersOf(nodes[d]).ToList(); } catch { continue; }
            foreach (var referrer in referrers) {
                if (at.TryGetValue(referrer, out var ri) && gone.Contains(ri)) continue;
                if (!at.TryGetValue(referrer, out ri) && InsideGone(referrer, gone)) continue;
                var path = PathOf(referrer, rootIndex);
                if (!uses.Contains(path)) uses.Add(path);
            }
        }
        return uses;
    }

    // Whether anything outside it uses the element k of a reading (its subtree included).
    public bool UsedOutside(ScreenHtmlDocument reading, string k)
    {
        var objectKey = reading.Keys.FirstOrDefault(p => p.Key == k).Value;
        var state = (ReadingState)reading.State!;
        if (objectKey == null) return true;
        if (keyIndex == null) {
            keyIndex = new Dictionary<(int, string), int>();
            for (var i = 0; i < nodes.Count; i++) if (key[i].Length > 0) keyIndex.TryAdd((root[i] >= 0 ? root[i] : i, key[i]), i);
        }
        if (!keyIndex.TryGetValue((state.Root, objectKey), out var index)) return true;
        var gone = new HashSet<int>(Descendants(index).Append(index));
        return UsesOutside(index, gone, state.Root).Count > 0;
    }

    // The screen actions of a reading's root, each as the reading writes a reference to it (the battery's event edits name
    // them this way, so the text read back is the text written).
    public List<string> ActionNames(ScreenHtmlDocument reading)
    {
        var state = (ReadingState)reading.State!;
        // The ones the actions attribute lists (screen actions; data actions are not destinations).
        var listed = new HashSet<string>((reading.Canon.Elements.GetValueOrDefault("")?.Facts.GetValueOrDefault("actions") ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries), StringComparer.Ordinal);
        var names = new List<string>();
        for (var i = 0; i < nodes.Count; i++)
            if (root[i] == state.Root && role[i] == "action" && listed.Contains(display[i])) names.Add(NameOf(id[i], state.Scope));
        return names;
    }

    // Whether an entity, static entity or structure of the module (or of a reference) named `record` has an attribute named
    // `member` (an iteration's row read as Source.Current.Member, checked before the patch is offered).
    internal bool HasMember(string record, string member) =>
        byName.TryGetValue(record, out var hits) && hits.Any(i => role[i] is "entity" or "staticEntity" or "structure"
            && childrenOf[i].Any(c => role[c] == "attribute" && string.Equals(display[c], member, StringComparison.Ordinal)));

    private Dictionary<(int Root, string Key), int>? keyIndex;
    private bool InsideGone(T node, HashSet<int> gone)
    {
        var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        for (var up = r.ParentOf(node); up != null && seen.Add(up); up = r.ParentOf(up))
            if (at.TryGetValue(up, out var i)) return gone.Contains(i);
        return false;
    }
    private string PathOf(T node, int rootIndex)
    {
        var parts = new List<string>();
        var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        for (T? up = node; up != null && seen.Add(up) && parts.Count < 6; up = r.ParentOf(up)) {
            var name = r.DisplayOf(up); var k = r.KindOf(up);
            parts.Add(name.Length > 0 ? k + ":" + name : k);
            if (at.TryGetValue(up, out var i) && (i == rootIndex || role[i] is "screen" or "block")) break;
        }
        parts.Reverse();
        return string.Join("/", parts);
    }

    public sealed class EditPlan
    {
        private readonly ScreenHtmlModule<T> m;
        private readonly ReadingState state;
        private readonly ScreenHtmlDocument reading;
        private readonly IReadOnlyList<string> edits;
        private readonly string pointer;
        public readonly ScreenHtmlEditResult Result = new();
        public bool Refused => Result.Problems.Count > 0;
        /// <summary>The page as the plan writes it carries a marker of the engine (CX17 review 4, N2: every edit of such a page puts the
        /// native layout block in the theme the page shows now, whoever wrote the markers; not only a marker the plan adds).</summary>
        public bool CarriesMarkers { get; private set; }
        // The merged text: the reading with every edit in place of the element it names.
        private ScreenHtml.Node merged = new();
        private readonly HashSet<ScreenHtml.Node> editedNodes = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<ScreenHtml.Node, int> editOf = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<string, string> keys = new(StringComparer.Ordinal);
        private readonly Dictionary<string, int> byKey = new(StringComparer.Ordinal);
        private ScreenHtmlCanon model = new(), edited = new();
        private Dictionary<ScreenHtml.Node, string> nodeIds = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<string, ScreenHtml.Node> idNodes = new(StringComparer.Ordinal);
        private Dictionary<string, (string Parent, string Segment)> modelParents = [], editedParents = [];
        private readonly HashSet<string> recreated = new(StringComparer.Ordinal), deleted = new(StringComparer.Ordinal), moved = new(StringComparer.Ordinal);
        private readonly HashSet<string> namedAtCreation = new(StringComparer.Ordinal);
        private readonly bool patches;
        private readonly Anvil.Core.ScreenVisual.PageTheme? theme;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        // The defaults of the page edited: those of the UI flow it is in (what a fresh element is born with there).
        private ScreenDefaults? defaults;
        private ScreenDefaults Defaults => defaults ??= m.DefaultsOfRoot(state.Root);

        internal EditPlan(ScreenHtmlModule<T> m, ScreenHtmlDocument reading, IReadOnlyList<string> edits, string pointer, bool patches = true, Anvil.Core.ScreenVisual.PageTheme? theme = null)
        {
            this.m = m; this.reading = reading; this.edits = edits; this.pointer = pointer; this.patches = patches; this.theme = theme;
            state = reading.State as ReadingState ?? throw new InvalidOperationException("ssam-html edit: the reading has no state of this module");
            Result.Root = reading.Root; Result.RootKey = reading.RootKey; Result.RootKind = reading.RootKind; Result.BasedOnHtml = reading.HtmlSha256;
            foreach (var (k, objectKey) in reading.Keys) keys[k] = objectKey;
            for (var i = 0; i < m.nodes.Count; i++)
                if ((m.root[i] == state.Root || i == state.Root) && m.key[i].Length > 0) byKey.TryAdd(m.key[i], i);
            model = reading.Canon;
            if (reading.Problems.Count > 0) { Problem(ScreenHtmlEdit.Invalid, null, null, "the reading of " + reading.Root + " has problems of its own: " + string.Join("; ", reading.Problems.Take(5)), "edit another screen; this one is read only"); return; }
            // Without the installed Studio's defaults a property the text leaves out has no value to take (a Visible would be
            // written empty): refused with the reason, before anything is planned.
            if (Defaults.Note.Length > 0) { Problem(ScreenHtmlEdit.DefaultsMissing, null, null, "the installed Studio's defaults could not be measured in " + m.ModuleName + ": " + Defaults.Note, "an ssam-html edit needs them; read the module where the Studio creates pages (a UI module), or fix what the reason names"); return; }
            Merge();
            if (Refused) { Result.PlanMs = clock.Elapsed.TotalMilliseconds; return; }
            Normalize();
            if (Refused) { Result.PlanMs = clock.Elapsed.TotalMilliseconds; return; }
            // CX17 review 3, M6: the markers of the engine decided again on the merged page (a screen of the op only), written in
            // the text the plan decodes and writes, then taken out again: the checks and the patches read the author's text.
            engineMarks = DecideMarkers();
            EngineText(true);
            Decode(state.Shapes);
            Result.EditedHtml = ScreenHtmlText.Write(merged);
            EngineText(false);
            Check();
            Result.PlanMs = clock.Elapsed.TotalMilliseconds;
        }

        // ---- problems ---------------------------------------------------------------------------------------------------
        private JsonObject? Problem(string code, string? at, string? k, string message, string fix, JsonArray? patch = null)
        {
            if (Result.Problems.Any(p => p["code"]?.ToString() == code && p["k"]?.ToString() == k && k != null)) return null;
            var problem = new JsonObject { ["code"] = code, ["severity"] = "error", ["pointer"] = at, ["k"] = k, ["message"] = message, ["fix"] = fix, ["patch"] = patch };
            Result.Problems.Add(problem);
            return problem;
        }
        // The platform rules of an edit (CheckPlatformProperties) over F2: an attribute F2 already judged keeps F2's problem, which
        // then also carries this rule's certain patch; otherwise this rule's own problem.
        private JsonObject? PlatformOnce(JsonObject? judged, string code, string? at, string? k, string message, string fix) => judged ?? ProblemOnce(code, at, k, message, fix);
        // The same, once per message: two attributes of one element are two problems.
        private JsonObject? ProblemOnce(string code, string? at, string? k, string message, string fix)
        {
            if (Result.Problems.Any(p => p["code"]?.ToString() == code && p["k"]?.ToString() == k && p["message"]?.ToString() == message)) return null;
            var problem = new JsonObject { ["code"] = code, ["severity"] = "error", ["pointer"] = at, ["k"] = k, ["message"] = message, ["fix"] = fix, ["patch"] = null };
            Result.Problems.Add(problem);
            return problem;
        }
        // "event onclick is not Destination(...): javascript:alert(1)" (the decoder's word on an event): the attribute and its value.
        private static readonly System.Text.RegularExpressions.Regex EventProblem = new(@"^event (\S+) is not Destination\(.*?\): (.*)$", System.Text.RegularExpressions.RegexOptions.Singleline);

        // The certain fixes of the rules on new elements (PatchCertain): what each problem's fix is, and what it acts on.
        private readonly Dictionary<JsonObject, string> corrections = new(ReferenceEqualityComparer.Instance);
        private readonly List<ScreenHtml.Node> scriptElements = [];
        private readonly List<(ScreenHtml.Node Node, string Attribute, string? Restore)> scriptAttributes = [];
        // A marker of the engine an edit wrote (CX17 review 2, M4): removed, or put back to the reading's value.
        private readonly List<(ScreenHtml.Node Node, string Attribute, string? Restore)> markerAttributes = [];
        private readonly List<(ScreenHtml.Node Node, string Attribute, string Source, string? Alias)> iterations = [];
        // An attribute of a property the platform cannot write there (L3d): removed, renamed to the one it certainly means, or put
        // back to the reading's value.
        private readonly List<(ScreenHtml.Node Node, string Attribute, string? Restore, string? Rename)> attributeFixes = [];
        // os-Visible written in another case: the element, the attribute as written and its condition (null: True, removed only).
        private readonly List<(ScreenHtml.Node Node, string Attribute, string? Condition)> visibleVariants = [];
        private Dictionary<string, ScreenHtml.Node>? readNodes;
        // The element of the reading with that k (what it had: kept, never refused).
        private ScreenHtml.Node? ReadNode(string k)
        {
            if (readNodes == null) {
                readNodes = new Dictionary<string, ScreenHtml.Node>(StringComparer.Ordinal);
                try { foreach (var (node, _) in ScreenHtmlText.Elements(ScreenHtml.Parse(reading.Html))) if (node.Get("k") is { } key) readNodes.TryAdd(key, node); } catch (FormatException) { }
            }
            return readNodes.GetValueOrDefault(k);
        }
        private string At(int edit) => edits.Count == 1 && pointer != "/edit" ? pointer : pointer + "/" + edit.ToString(CultureInfo.InvariantCulture);
        private string? AtNode(ScreenHtml.Node? node) => node != null && editOf.TryGetValue(node, out var j) ? At(j) : null;
        private string? AtId(string id) => idNodes.TryGetValue(id, out var node) ? AtNode(node) : null;

        // ---- merge ------------------------------------------------------------------------------------------------------
        private void Merge()
        {
            merged = ScreenHtml.Parse(reading.Html);
            var original = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (node, _) in ScreenHtmlText.Elements(merged)) if (node.Get("k") is { } k) original.Add(k);
            ScreenHtml.Node Top() => merged.Children.First(c => !c.IsText);
            // Every edit placed by its k: a later edit that writes again an element around it would swallow it.
            var placed = new List<(int Edit, ScreenHtml.Node Root, string Key)>();
            for (var j = 0; j < edits.Count; j++) {
                var at = At(j);
                ScreenHtml.Node parsed;
                try { parsed = ScreenHtml.Parse(edits[j]); }
                catch (FormatException error) { Problem(ScreenHtmlEdit.Invalid, at, null, error.Message, "every element closes (or is <x/>), every attribute value is quoted, & is written &amp; and < inside text &lt;"); continue; }
                var roots = parsed.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
                // An If is edited with its else: <div if k> and the <div else> right after it, one edit.
                ScreenHtml.Node? elsePart = null;
                if (roots.Count == 2 && ScreenHtmlEdit.IsIfElse(roots[0], roots[1])) { elsePart = roots[1]; roots.RemoveAt(1); }
                if (roots.Count != 1 || roots[0].IsText) {
                    Problem(ScreenHtmlEdit.Invalid, at, null, "an edit is one element of the reading with its k (children included), the <style> of the page or the whole document; this one has " + roots.Count + " top-level nodes",
                        "send each changed element as its own string, or their common parent (with its k) as one");
                    continue;
                }
                var e = roots[0];
                if (e.Tag is "screen" or "block") {
                    if (edits.Count > 1) { Problem(ScreenHtmlEdit.Invalid, at, null, "the whole document is the only edit of its op", "send the whole document alone, or only the changed elements"); continue; }
                    if (e.Tag != Top().Tag) { Problem(ScreenHtmlEdit.Invalid, at, null, "the reading is a <" + Top().Tag + ">, the edit a <" + e.Tag + ">", "keep the root element of the reading"); continue; }
                    Mark(e, j);
                    merged.Children[merged.Children.IndexOf(Top())] = e;
                    continue;
                }
                if (e.Tag == "style") {
                    Mark(e, j);
                    var top = Top();
                    var old = top.Children.FindIndex(c => c.Tag == "style");
                    if (old >= 0) top.Children[old] = e; else top.Children.Insert(0, e);
                    continue;
                }
                if (e.Get("k") is not { } key) {
                    Problem(ScreenHtmlEdit.NoKey, at, null, "<" + e.Tag + "> has no k: an edit names the element of the reading it replaces by its k; a new element goes inside the edit of its parent",
                        "send the parent of the new element (with its k), the new element inside it without k");
                    continue;
                }
                if (!original.Contains(key)) {
                    Problem(ScreenHtmlEdit.KeyForeign, at, key, "k=\"" + key + "\" is not an element of the reading " + reading.HtmlSha256[..12] + " of " + reading.Root,
                        "use a k of that reading (read the screen again if it changed), or drop the k: an element without k is new");
                    continue;
                }
                var hits = ScreenHtmlText.Elements(merged).Where(x => x.Node.Get("k") == key).ToList();
                var inside = hits.Where(x => editedNodes.Contains(x.Node)).ToList();
                var outside = hits.Where(x => !editedNodes.Contains(x.Node) && x.Parent != null).ToList();
                if (inside.Count > 0 || outside.Count == 0) {
                    var other = inside.Count > 0 && editOf.TryGetValue(inside[0].Node, out var o) ? o : -1;
                    Problem(ScreenHtmlEdit.Overlap, at, key, "k=\"" + key + "\" is " + (other >= 0 ? "also inside edit #" + other : "inside or removed by another edit") + ": one edit per element",
                        "keep only the outer edit and make this change inside it");
                    continue;
                }
                Mark(e, j);
                placed.Add((j, e, key));
                var (_, parent) = outside[0];
                var index = parent!.Children.IndexOf(outside[0].Node);
                parent.Children[index] = e;
                if (elsePart != null) {
                    Mark(elsePart, j);
                    var next = NextElementIndex(parent, index);
                    if (next >= 0 && parent.Children[next].Get("else") != null && parent.Children[next].Attributes.Count == 1) parent.Children[next] = elsePart;
                    else parent.Children.Insert(index + 1, elsePart);
                }
            }
            // An earlier edit inside the element a later edit writes again is gone with the old subtree (its new Visible, its
            // text...): one edit per element, whatever their order (the review of rounds 1 and 2: k1 was accepted and lost the
            // Visible of w64; in the other order, k2, it was already HTML_EDIT_OVERLAP).
            var present = new HashSet<ScreenHtml.Node>(ScreenHtmlText.Elements(merged).Select(x => x.Node), ReferenceEqualityComparer.Instance);
            foreach (var (j, root, key) in placed) {
                if (present.Contains(root)) continue;
                var later = placed.Where(p => p.Edit > j && present.Contains(p.Root) && ScreenHtmlText.Elements(p.Root).Any(x => x.Node.Get("k") == key)).Select(p => (int?)p.Edit).FirstOrDefault()
                    ?? placed.Where(p => p.Edit > j && present.Contains(p.Root)).Select(p => (int?)p.Edit).FirstOrDefault();
                Problem(ScreenHtmlEdit.Overlap, At(j), key, "k=\"" + key + "\" of edit #" + j + " is inside the element edit #" + (later?.ToString(CultureInfo.InvariantCulture) ?? "?")
                    + " writes again, which replaces it (the change of edit #" + j + " would be lost): one edit per element",
                    "keep only the outer edit (#" + (later?.ToString(CultureInfo.InvariantCulture) ?? "?") + ") and make this change inside it");
            }
            if (Refused) return;
            // A k written in an edit and still in the part of the page no edit replaced: the element moved there.
            foreach (var group in ScreenHtmlText.Elements(merged).Where(x => x.Node.Get("k") != null).GroupBy(x => x.Node.Get("k")!).Where(g => g.Count() > 1)) {
                var inEdits = group.Where(x => editedNodes.Contains(x.Node)).ToList();
                if (inEdits.Count != 1) {
                    Problem(ScreenHtmlEdit.KeyTwice, AtNode(inEdits.FirstOrDefault().Node), group.Key, "k=\"" + group.Key + "\" is written " + inEdits.Count + " times in the edits",
                        "write each element once: in its new place when it moves");
                    continue;
                }
                foreach (var (node, parent) in group.Where(x => !editedNodes.Contains(x.Node))) {
                    if (ScreenHtmlText.Elements(node).Any(x => editedNodes.Contains(x.Node))) {
                        Problem(ScreenHtmlEdit.Invalid, AtNode(inEdits[0].Node), group.Key, "k=\"" + group.Key + "\" moves inside its own subtree", "move it beside its descendants, never inside them");
                        continue;
                    }
                    parent?.Children.Remove(node);
                }
            }
        }

        private static int NextElementIndex(ScreenHtml.Node parent, int at)
        {
            for (var i = at + 1; i < parent.Children.Count; i++) {
                if (parent.Children[i].IsText) { if (parent.Children[i].Text!.Trim().Length > 0) return -1; continue; }
                return i;
            }
            return -1;
        }

        private void Mark(ScreenHtml.Node root, int edit)
        {
            foreach (var (node, _) in ScreenHtmlText.Elements(root)) { editedNodes.Add(node); editOf[node] = edit; }
            foreach (var text in Texts(root)) editOf[text] = edit;
        }
        private static IEnumerable<ScreenHtml.Node> Texts(ScreenHtml.Node node)
        {
            foreach (var child in node.Children) {
                if (child.IsText) yield return child;
                else foreach (var t in Texts(child)) yield return t;
            }
        }

        // ---- normalize: what the edits write in HTML that has one native reading (ScreenHtmlNative) ----------------------
        /// <summary>The svg, image, style rules of ScreenHtmlNative over the elements of the edits (an element of the reading keeps
        /// what it had): listed in normalized; the mask rules go to the page's &lt;style&gt; (its svg and span selectors widened to
        /// the icons), which joins the edits.</summary>
        public bool IconsConverted { get; private set; }
        private void Normalize()
        {
            var top = merged.Children.First(c => !c.IsText);
            NormalizeNewElements(top);
            var style = top.Children.FirstOrDefault(c => c.Tag == "style");
            var sheet = style == null ? null : string.Concat(style.Children.Select(c => c.Text));
            var outcome = ScreenHtmlNative.Apply(top, node => editedNodes.Contains(node), node => node.Get("k") is { } k ? ReadNode(k) : null,
                form => m.TryResolve(form, state.Scope, out _), sheet);
            foreach (var note in outcome.Normalized) Result.Normalized.Add(note);
            foreach (var (code, line, column, message, fix) in outcome.Problems)
                ProblemOnce(code, AtNode(editedNodes.FirstOrDefault(n => n.Line == line && n.Column == column)), null, "line " + line + " col " + column + ": " + message, fix);
            IconsConverted = outcome.Normalized.Any(n => n["code"]?.ToString() == ScreenHtmlNative.SvgMask);
            if (outcome.Css.Count == 0 && !IconsConverted) return;
            // The page's own style sheet: its selectors svg and span widened to the icon spans, then the mask rules.
            var css = ScreenHtmlNative.WidenIconSelectors(sheet ?? "");
            foreach (var rule in outcome.Css) css = css.Length == 0 || css.EndsWith('\n') ? css + rule + "\n" : css + "\n" + rule + "\n";
            if (css == (sheet ?? "")) return;
            var edit = editedNodes.Where(n => editOf.ContainsKey(n)).Select(n => editOf[n]).DefaultIfEmpty(0).Min();
            var written = new ScreenHtml.Node { Tag = "style", Line = style?.Line ?? top.Line, Column = style?.Column ?? top.Column };
            written.Children.Add(new ScreenHtml.Node { Text = css });
            if (style != null) top.Children[top.Children.IndexOf(style)] = written; else top.Children.Insert(0, written);
            Mark(written, edit);
            Result.Normalized.Add(new JsonObject { ["code"] = ScreenHtmlNative.SvgMask, ["element"] = "style", ["note"] = outcome.Css.Count + " mask rule(s) in the page's style sheet" + (IconsConverted ? "; its svg and span selectors also match the icon spans (:is(svg, :where(.ssam-icon)), span:not(:where(.ssam-icon)))" : "") });
        }

        /// <summary>L3d: what a new element of an edit writes that the platform of this lane has no property for, normalized as the
        /// document form normalizes it (one rule of the forms that create widgets) and listed in normalized: the class of a new If
        /// goes on a container around what it shows (IF_CLASS_MOVED; the If of O11 has no Style: "set Style on IfWidget (new)",
        /// 4 refusals of 15-22/10), the weight of an &lt;i&gt; is dropped where the Icon has none (ICON_WEIGHT_DROPPED, O11;
        /// relato e2891d6b). An element of the reading keeps what it had: a class written on an If of the reading is
        /// HTML_PROPERTY_UNKNOWN, with the fix (its children would move).</summary>
        private void NormalizeNewElements(ScreenHtml.Node top)
        {
            // The inputs and variables of the root in the order the reading writes them: the inputs, then the variables, and a new
            // one after those of its kind, where the platform creates it (at the end of the owner's list). A new <var> written
            // before an <input> of a block read back as that input (receipt 82bf05af of 22/10, "LocalVariable read back as
            // InputParameter"); one written before the variables of the screen read back as the first of them (092b8162 and
            // 645face7 of 18/10, "p:DataType is ..., the edit says ...": the type was right, the variable another).
            static bool Input(ScreenHtml.Node n) => !n.IsText && n.Tag == "input" && n.Get("name") != null && n.Get("bind") == null;
            var slots = top.Children.Select((n, i) => (n, i)).Where(x => Input(x.n) || !x.n.IsText && x.n.Tag == "var").ToList();
            var sorted = slots.Select(x => x.n).OrderBy(n => Input(n) ? 0 : 1).ThenBy(n => n.Get("k") == null ? 1 : 0).ToList();
            if (slots.Any(x => x.n.Get("k") == null && editedNodes.Contains(x.n)) && !sorted.SequenceEqual(slots.Select(x => x.n))) {
                for (var j = 0; j < slots.Count; j++) top.Children[slots[j].i] = sorted[j];
                Result.Normalized.Add(new JsonObject { ["code"] = "DATA_ORDER", ["note"] = "the inputs of " + reading.Root + " come before its variables, and a new one after those of its kind, as the platform creates them and the reading writes them" });
            }
            // The literal text of a new <upload filename>: the platform turns it into an expression when FileName is set, and the
            // plan no longer found the text it created (receipts 2d984f9a and 9671c951 of 22/10, "does not hold a TextWidget the edit
            // puts there"). The same text as the expression of its literal is what the platform keeps.
            foreach (var (upload, _) in ScreenHtmlText.Elements(top).ToList()) {
                if (!editedNodes.Contains(upload) || upload.Tag != "upload" || upload.Get("k") != null || upload.Get("filename") == null) continue;
                for (var c = 0; c < upload.Children.Count; c++) {
                    var child = upload.Children[c];
                    // A run as text, or as <text> (the form of a run with literal braces or the space beside an inline element).
                    string text;
                    if (child.IsText && child.Text!.Trim().Length > 0 && !child.Text.Contains("{{", StringComparison.Ordinal)) text = child.Text.Contains('\n') ? child.Text.Trim() : child.Text;
                    else if (!child.IsText && child.Tag == "text" && child.Attributes.Count == 0) text = string.Concat(child.Children.Select(t => t.Text));
                    else continue;
                    upload.Children[c] = new ScreenHtml.Node { Text = "{{ " + ScreenHtml.Literal(text) + " }}", Line = child.Line, Column = child.Column };
                    Result.Normalized.Add(new JsonObject { ["code"] = "UPLOAD_TEXT_EXPRESSION", ["element"] = "a new <upload> at line " + upload.Line.ToString(CultureInfo.InvariantCulture), ["from"] = text.Trim(), ["to"] = "{{ " + ScreenHtml.Literal(text) + " }}",
                        ["note"] = "an Upload with filename keeps its text as an expression: the same text, written as its literal" });
                }
            }
            bool Lacks(string kind, string property) => SampleOf(kind) is { } sample && WaysToWrite(sample) is { } ways && !ways.Has(property);
            var ifTakesNoClass = Lacks("IfWidget", "Style");
            var iconTakesNoWeight = Lacks("Icon", "Weight");
            if (!ifTakesNoClass && !iconTakesNoWeight) return;
            foreach (var (node, _) in ScreenHtmlText.Elements(top).ToList()) {
                if (!editedNodes.Contains(node)) continue;
                var line = node.Line.ToString(CultureInfo.InvariantCulture);
                if (iconTakesNoWeight && node.Tag == "i" && node.Get("icon") != null && node.Get("weight") is { } weight
                    && (node.Get("k") is not { } read || ReadNode(read)?.Get("weight") == null)) {
                    node.Attributes.RemoveAll(a => a.Key == "weight");
                    Result.Normalized.Add(new JsonObject { ["code"] = Anvil.Core.Preflight.HtmlDocumentRules.IconWeight, ["k"] = node.Get("k"),
                        ["element"] = node.Get("k") is { } ik ? "k=\"" + ik + "\"" : "a new <i icon=\"" + node.Get("icon") + "\"> at line " + line,
                        ["from"] = "weight=\"" + weight + "\"", ["note"] = "the O11 Icon has no Weight (the ODC one has); the weight is dropped" });
                }
                if (node.Get("k") != null) continue;
                if (ifTakesNoClass && node.Tag == "div" && node.Get("if") != null && node.Get("class") is { } cls) {
                    node.Attributes.RemoveAll(a => a.Key == "class");
                    var inner = new ScreenHtml.Node { Tag = "div", Line = node.Line, Column = node.Column };
                    inner.Attributes.Add(new("class", cls));
                    inner.Children.AddRange(node.Children);
                    node.Children.Clear();
                    node.Children.Add(inner);
                    Mark(inner, editOf[node]);
                    Result.Normalized.Add(new JsonObject { ["code"] = Anvil.Core.Preflight.ScopePhase.IfClassRule, ["element"] = "a new If at line " + line, ["from"] = "<div if=\"...\" class=\"" + cls + "\">",
                        ["to"] = "<div if=\"...\"><div class=\"" + cls + "\">...</div></div>", ["note"] = "the If of this module has no Style, so the class goes on a container of what it shows" });
                }
            }
        }

        // ---- the markers of the engine, decided again (CX17 review 3, M6) -----------------------------------------------
        /// <summary>On a screen of the op (its reading carries a marker of the engine; a screen made in the Studio carries none
        /// and nothing is marked there, review 1, A1), F3 decided again on every link, button and form of the merged page, by
        /// the one reading of the parent's space (ScreenVisual.SpacingReader over OutSystems UI, the themes the page shows and
        /// the page's style sheet as edited): the gap marker written or removed where the decision is not the text's, a gutter
        /// note for each element the edit wrote or whose marker changes, and HTML_MARKER_DECIDED for each element with k whose
        /// marker is not the one of its text or of its reading. Answers the elements whose attributes it changed, with the
        /// author's attributes to put back once the plan is decoded.</summary>
        private List<(ScreenHtml.Node Node, List<KeyValuePair<string, string>> Author, List<KeyValuePair<string, string>> Engine)> engineMarks = [];
        // The merged text with the markers the engine decided (what is decoded and written), or with the author's (what is checked
        // and patched).
        private void EngineText(bool engine)
        {
            foreach (var (node, author, decided) in engineMarks) { node.Attributes.Clear(); node.Attributes.AddRange(engine ? decided : author); }
        }

        private List<(ScreenHtml.Node Node, List<KeyValuePair<string, string>> Author, List<KeyValuePair<string, string>> Engine)> DecideMarkers()
        {
            var changed = new List<(ScreenHtml.Node, List<KeyValuePair<string, string>>, List<KeyValuePair<string, string>>)>();
            if (theme == null || !OpRoot()) return changed;
            var top = merged.Children.First(c => !c.IsText);
            var style = top.Children.FirstOrDefault(c => c.Tag == "style");
            var sheet = style == null ? null : string.Concat(style.Children.Select(c => c.Text));
            var map = new Dictionary<ScreenHtml.Node, Anvil.Core.DomNode>(ReferenceEqualityComparer.Instance);
            Anvil.Core.ScreenVisual.AuthorDom(top, map);
            // One spacing reader per theme the page is shown with (a block: each theme of the screens that show it, review 4, N1).
            var readers = new Dictionary<Anvil.Core.ScreenVisual.PageTheme, Anvil.Core.ScreenVisual.SpacingReader>(ReferenceEqualityComparer.Instance);
            var spacing = new Dictionary<(Anvil.Core.ScreenVisual.PageTheme, Anvil.Core.DomNode), Anvil.Core.ScreenVisual.Spacing>();
            Anvil.Core.ScreenVisual.Spacing SpacingOf(Anvil.Core.ScreenVisual.PageTheme shown, Anvil.Core.DomNode parent)
            {
                if (spacing.TryGetValue((shown, parent), out var s)) return s;
                if (!readers.TryGetValue(shown, out var reader)) readers[shown] = reader = Anvil.Core.ScreenVisual.PageSpacing(shown, [sheet]);
                return spacing[(shown, parent)] = reader.Of(parent);
            }
            var notes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            JsonObject? decided = null;
            foreach (var (node, element) in map) {
                var k = node.Get("k");
                // Review 4, N2: where no theme the page shows carries the block (a theme of another module, set after the marks),
                // the page and rows markers have no effect: decided again (removed), said.
                var dropped = theme.Reachable ? [] : new[] { Anvil.Core.ScreenVisual.PageMarker, Anvil.Core.ScreenVisual.RowsMarker }.Where(m => Anvil.Core.ScreenVisual.CarriesMarker(node, m)).ToList();
                foreach (var marker in dropped) {
                    if (decided == null) { decided = Anvil.Core.ScreenVisual.MarkerDecidedNote(); Result.Normalized.Add(decided); }
                    Anvil.Core.ScreenVisual.AddDecided(decided, k != null ? "k=\"" + k + "\"" : "a new <" + node.Tag + "> at line " + node.Line.ToString(CultureInfo.InvariantCulture), marker, false,
                        $"the theme the page shows ({theme.Name}) carries no native layout block: {theme.Why}");
                }
                var kind = node.Tag switch { "a" => "Link", "button" => "Button", "form" => "Form", _ => null };
                if (kind == null) {
                    if (dropped.Count > 0) changed.Add((node, node.Attributes.ToList(), node.Attributes.Where(a => !dropped.Contains(Anvil.Core.ScreenVisual.MarkerOf(a.Key) ?? "")).ToList()));
                    continue;
                }
                var gap = Anvil.Core.ScreenVisual.GapDecision(element, SpacingOf, theme);
                if (gap?.Diverge is { } pages)
                    Problem(Anvil.Core.ScreenVisual.BlockPagesDiverge, AtNode(node), k, Anvil.Core.ScreenVisual.DivergeMessage(kind, reading.Root, pages), Anvil.Core.ScreenVisual.DivergeFix);
                var marked = gap is { Marked: true };
                var text = Anvil.Core.ScreenVisual.CarriesMarker(node, Anvil.Core.ScreenVisual.GapMarker);
                var read = k != null && ReadNode(k) is { } was && Anvil.Core.ScreenVisual.CarriesMarker(was, Anvil.Core.ScreenVisual.GapMarker);
                if (marked != text || dropped.Count > 0) {
                    var decidedAttributes = node.Attributes.Where(a => Anvil.Core.ScreenVisual.MarkerOf(a.Key) is not { } m || (m == Anvil.Core.ScreenVisual.GapMarker ? marked == text : !dropped.Contains(m))).ToList();
                    if (marked && !text) decidedAttributes.Add(new(Anvil.Core.ScreenVisual.GapMarker, "1"));
                    changed.Add((node, node.Attributes.ToList(), decidedAttributes));
                }
                // The note of the gutter: for what the edit wrote, and for an element whose marker changes.
                if (gap is { } d && (editedNodes.Contains(node) || marked != read)) {
                    var code = Anvil.Core.ScreenVisual.GutterCode(d);
                    if (!notes.TryGetValue(code + "|" + kind, out var note)) {
                        notes[code + "|" + kind] = note = new JsonObject { ["code"] = code, ["element"] = kind, ["count"] = 0, ["lines"] = new JsonArray(),
                            ["note"] = Anvil.Core.ScreenVisual.GutterNote(code, kind, theme.Name) };
                        // Review 4, N1: a block shown on pages without the native layout block (or on none yet) says them.
                        if (d.Marked) Anvil.Core.ScreenVisual.Caveat(note, theme);
                        Result.Normalized.Add(note);
                    }
                    note["count"] = note["count"]!.GetValue<int>() + 1;
                    if (note["lines"]!.AsArray().Count < 10) note["lines"]!.AsArray().Add(k != null ? "k=\"" + k + "\"" : "a new " + kind + " at line " + node.Line.ToString(CultureInfo.InvariantCulture));
                    if (d.Spacing.Always.Horizontal) {
                        if (note["gaps"] is not JsonArray gaps) note["gaps"] = gaps = new JsonArray();
                        var from = d.Spacing.Always.Describe();
                        if (gaps.Count < 10 && !gaps.Any(x => x!.ToString() == from)) gaps.Add(from);
                    }
                }
                // An element with k whose marker is not its text's or its reading's: said, never in silence.
                if (k != null && (marked != text || marked != read)) {
                    if (decided == null) { decided = Anvil.Core.ScreenVisual.MarkerDecidedNote(); Result.Normalized.Add(decided); }
                    Anvil.Core.ScreenVisual.AddDecided(decided, "k=\"" + k + "\"", Anvil.Core.ScreenVisual.GapMarker, marked,
                        Anvil.Core.ScreenVisual.GapWhy(gap, theme) + (marked != text ? (text ? "; the edit's text had it" : "; the edit's text did not have it") : "")
                        + (marked != read ? (read ? "; the reading had it" : "; the reading did not have it") : ""));
                }
            }
            // Reparented retained widgets must use the same page-root rule as creation.
            // Removing a marked wrapper must not silently remove the page's min-width fix.
            // Only a widget the edit moves (its parent in the merged text is not its parent in the reading): an untouched
            // widget keeps the marker its reading has, whatever it is.
            var readAnchors = Anchors(ScreenHtml.Parse(reading.Html));
            var mergedAnchors = Anchors(merged);
            if (top.Tag == "screen" && theme.Reachable) foreach (var (node, element) in map) {
                var k = node.Get("k");
                if (k == null || !readAnchors.TryGetValue(k, out var wasUnder) || !mergedAnchors.TryGetValue(k, out var isUnder) || wasUnder == isUnder) continue;
                if (!keys.TryGetValue(k,out var key) || !byKey.TryGetValue(key,out var index)
                    || m.r.PropertyOf(m.nodes[index],"ExtendedProperties") == null) continue;
                var pageRoot = map[top]; var parent = element.ParentElement;
                var wanted = ReferenceEquals(parent,pageRoot) || parent?.Tag == "slot" && parent.ParentElement is { } block && ReferenceEquals(block.ParentElement,pageRoot);
                var position = changed.FindIndex(c=>ReferenceEquals(c.Item1,node));
                var attributes = (position >= 0 ? changed[position].Item3 : node.Attributes).ToList();
                var had = attributes.Any(a=>Anvil.Core.ScreenVisual.MarkerOf(a.Key)==Anvil.Core.ScreenVisual.PageMarker);
                if (wanted == had) continue;
                attributes.RemoveAll(a=>Anvil.Core.ScreenVisual.MarkerOf(a.Key)==Anvil.Core.ScreenVisual.PageMarker);
                if (wanted) attributes.Add(new(Anvil.Core.ScreenVisual.PageMarker,"1"));
                var change=(node,node.Attributes.ToList(),attributes);
                if (position >= 0) changed[position]=change; else changed.Add(change);
                if (decided == null) { decided=Anvil.Core.ScreenVisual.MarkerDecidedNote(); Result.Normalized.Add(decided); }
                Anvil.Core.ScreenVisual.AddDecided(decided,"k=\""+k+"\"",Anvil.Core.ScreenVisual.PageMarker,wanted,
                    wanted ? "retained widget moved to the top of the page" : "retained widget is no longer at the top of the page");
            }
            // Review 4, N2: the page as written carries a marker of the engine (the theme it shows needs the block).
            var engineOf = new Dictionary<ScreenHtml.Node, List<KeyValuePair<string, string>>>(ReferenceEqualityComparer.Instance);
            foreach (var (node, _, engine) in changed) engineOf[node] = engine;
            CarriesMarkers = map.Keys.Any(n => (engineOf.TryGetValue(n, out var attributes) ? attributes : n.Attributes).Any(a => Anvil.Core.ScreenVisual.MarkerOf(a.Key) != null));
            return changed;
        }

        // Where each element with k sits in a text: the nearest element with k above it (the root is ""), with the slots, the
        // else and the elements without k between them (an element under a new wrapper sits elsewhere than in its reading).
        private static Dictionary<string, string> Anchors(ScreenHtml.Node tree)
        {
            var anchors = new Dictionary<string, string>(StringComparer.Ordinal);
            var top = tree.Children.FirstOrDefault(c => !c.IsText);
            if (top == null) return anchors;
            void Walk(ScreenHtml.Node parent, string under)
            {
                var position = 0;
                string? previous = null;
                foreach (var child in parent.Children) {
                    if (child.IsText) continue;
                    position++;
                    if (child.Get("k") is { } k) { anchors.TryAdd(k, under); Walk(child, "k:" + k); previous = k; continue; }
                    var step = child.Tag == "slot" ? "slot:" + child.Get("name")
                        : child.Get("else") != null ? "else:" + previous
                        : child.Tag + (child.Get("name") is { } name ? ":" + name : "#" + position.ToString(CultureInfo.InvariantCulture));
                    Walk(child, under + "/" + step);
                    previous = null;
                }
            }
            Walk(top, "");
            return anchors;
        }

        // A screen or block of the op: its reading carries a marker of the engine (only the html op writes them, review 2, M4).
        private bool OpRoot()
        {
            ReadNode("");
            return readNodes!.Values.Any(n => Anvil.Core.ScreenVisual.EngineMarkers.Any(marker => Anvil.Core.ScreenVisual.CarriesMarker(n, marker)));
        }

        // ---- decode -----------------------------------------------------------------------------------------------------
        // The actions= and data-actions= the text wrote, when Decode took the module's list for them.
        private readonly Dictionary<string, string?> listedInText = new(StringComparer.Ordinal);
        private void Decode(Dictionary<string, Shape> shapes)
        {
            var decoder = new Decoder(m, state.Scope, shapes);
            edited = decoder.Run(merged);
            // The actions the text lists, all of them the module's, are the module's list (an action created since the reading
            // stays listed; Check says it in normalized and refuses only a name the module lacks).
            if (edited.Elements.GetValueOrDefault("") is { } root && model.Elements.GetValueOrDefault("") is { } read)
                foreach (var list in new[] { "actions", "data-actions" })
                    if (read.Facts.TryGetValue(list, out var has) && root.Facts.GetValueOrDefault(list) is var says && says != has
                        && (says ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries).All(n => has.Split('\n').Contains(n, StringComparer.Ordinal))) {
                        listedInText[list] = says;
                        root.Facts[list] = has;
                    }
            nodeIds = decoder.NodeIds;
            idNodes.Clear();
            foreach (var (node, id) in nodeIds) idNodes[id] = node;
            modelParents = Parents(model); editedParents = Parents(edited);
        }

        private static Dictionary<string, (string Parent, string Segment)> Parents(ScreenHtmlCanon canon)
        {
            var parents = new Dictionary<string, (string, string)>(StringComparer.Ordinal);
            foreach (var (id, element) in canon.Elements) {
                var segment = element.Kind == "IfWidget" ? "true" : "self";
                foreach (var token in element.Children) {
                    if (token == "else") { segment = "false"; continue; }
                    if (token.StartsWith("k:", StringComparison.Ordinal)) parents[token[2..]] = (id, segment);
                    else if (token.StartsWith("s:", StringComparison.Ordinal)) parents[id + "/" + token[2..]] = (id, "slot");
                    else if (token.StartsWith("c:", StringComparison.Ordinal)) parents[id + "/content:" + token[2..]] = (id, "content");
                }
            }
            return parents;
        }

        private static bool IsStructural(string id) => id.Contains('/');
        // New: written without k, or an element the edit recreates (its kind or block changed), or a slot of one of them.
        private bool IsNew(string id)
        {
            if (id.StartsWith('+') || recreated.Contains(id)) return true;
            var slash = id.IndexOf('/');
            return slash > 0 && IsNew(id[..slash]);
        }
        private static readonly HashSet<string> DataKinds = new(StringComparer.Ordinal) { "InputParameter", "LocalVariable", "ScreenAggregate", "DataAction", "BlockEvent", "ScreenAction" };
        private bool IsData(string kind) => DataKinds.Contains(kind) || kind.StartsWith("os-", StringComparison.Ordinal) && kind != "os-opaque" || !ScreenHtml.WidgetTags.ContainsKey(kind) && kind is not ("List" or "AdvancedHtml" or "os-opaque" or "PlaceholderContentWidget" or "Content" or "MobileScreen" or "MobileBlock" or "WebScreen" or "WebBlock");

        // ---- checks: every problem of the edit at once, before anything is written -------------------------------------
        private void Check()
        {
            // The owner's rules on what an edited element writes new (L5, decision 5), each with its certain fix: a <script> goes;
            // a javascript: URL or an event that is not Destination(...) goes back to what the reading had (or goes, when the
            // element did not have it); a foreign iteration (v-for...) becomes the List. What the reading had stays as it was.
            var scriptEvents = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (node, _) in ScreenHtmlText.Elements(merged).Where(x => editedNodes.Contains(x.Node))) {
                if (node.Tag == "script") {
                    if (Problem(ScreenHtmlEdit.Script, AtNode(node), null, "<script> is not part of a page", "the patch removes it; behavior is a native event naming a screen action (onclick=\"Save\")") is { } p)
                        corrections[p] = "script";
                    scriptElements.Add(node);
                    continue;
                }
                if (node.Tag == "table" && ScreenHtmlTables.NativeTable(node) is { } table) TableRules(node, table);
                var read = node.Get("k") is { } k ? ReadNode(k) : null;
                // CX17 review 2, M4: the markers of the native layout block are the engine's (ScreenVisual.AuthorMarkers, the one
                // rule of the three text forms): one the reading did not have on this element goes, or goes back to the reading's.
                foreach (var (name, value, restore) in Anvil.Core.ScreenVisual.AuthorMarkers(node, read)) {
                    if (ProblemOnce(Anvil.Core.ScreenVisual.ReservedMarker, AtNode(node), node.Get("k"), Anvil.Core.ScreenVisual.ReservedMarkerMessage(name, value, false, read != null),
                            Anvil.Core.ScreenVisual.ReservedMarkerFix(name, restore)) is { } markerProblem)
                        corrections[markerProblem] = "marker";
                    markerAttributes.Add((node, name, restore));
                }
                foreach (var (name, value) in node.Attributes.ToList()) {
                    // os-Visible in another case (OS-VISIBLE, Os-Visible, os-visible): the new Visible it means, with its If patch,
                    // never an inert attribute nor a setter error without a patch (the review of round 2: he1, he2, he9).
                    if (Anvil.Core.ScreenDocument.VisibleInAnotherCase(name)) {
                        if (read?.Get(name) == value) continue;   // the reading had it: kept
                        var condition = value.Trim() == "True" ? null : value;
                        if (ProblemOnce(ScreenHtmlEdit.Visible, AtNode(node), node.Get("k"),
                                name + "=\"" + Clip(value) + "\" is os-Visible in another case (an attribute name has no case in HTML): "
                                + (condition == null ? "the Visible every element has, written as an attribute" : "Visible is never written new (U1); a condition is an If around the element"),
                                condition == null ? "remove " + name : "remove " + name + " and write <div if=\"" + Clip(value) + "\"> around the element") is { } visibleProblem)
                            corrections[visibleProblem] = "visible";
                        visibleVariants.Add((node, name, condition));
                        continue;
                    }
                    // L5 on what the attribute is in the browser: ext:on* and another case of on* (the event the browser runs), srcdoc,
                    // and a javascript: URL written literally or as a constant of an expression (Anvil.Core.ScreenDocument.ScriptAttribute).
                    var foreign = Anvil.Core.ScreenDocument.ScriptAttribute(name, value);
                    var eventAttribute = name.StartsWith("on", StringComparison.Ordinal) || name.StartsWith('@') || name.StartsWith("html:on", StringComparison.Ordinal);
                    if (foreign != null || eventAttribute && !name.Contains('.') && !ScreenHtml.TryCall(value, out _, out _) && !Anvil.Core.ScreenDocument.ParseCall(value, out _, out _)) {
                        if (read?.Get(name) == value) continue;   // the reading had it: kept
                        scriptEvents.Add(name + "\u0001" + value);
                        var before = read?.Get(name);
                        // What the reading had under that name goes back: an event as Destination(...), or (an attribute the browser runs
                        // as it is: ext:on*, another case, srcdoc) the reading's own value, kept as it was.
                        var restore = before == null ? null
                            : foreign is "event" or "srcdoc" ? before
                            : Anvil.Core.ScreenDocument.ScriptAttribute(name, before) == null && ScreenHtml.TryCall(before, out _, out _) ? before : null;
                        var what = foreign switch {
                            "event" => name + "=\"" + Clip(value) + "\" is the browser's event " + (name.StartsWith("ext:", StringComparison.Ordinal) ? name[4..] : name).ToLowerInvariant()
                                + " (ext: and another case write the attribute as it is, and HTML reads its name without case): JavaScript (L5); an event is written onclick=\"Save\"",
                            "srcdoc" => name + "=\"" + Clip(value) + "\" writes a page inside the page, whose scripts run (L5)",
                            _ => name + "=\"" + Clip(value) + "\" is JavaScript (L5): an event names its destination, onclick=\"Save\" or onclick=\"Open(Id = Row.Id)\"" };
                        // The click of a Button or a Link with nothing to put back: the widget needs its On Click (the review of
                        // 2026-10-12: the patch that removed it left a button the Verify refuses), so the fix is written, no patch.
                        if (restore == null && foreign is null or "url" && Anvil.Core.ScreenDocument.NeedsItsClick(node, name)) {
                            ProblemOnce(ScreenHtmlEdit.Script, AtNode(node), node.Get("k"), what, Anvil.Core.ScreenDocument.ClickFix(node));
                            continue;
                        }
                        if (ProblemOnce(ScreenHtmlEdit.Script, AtNode(node), node.Get("k"), what,
                                restore != null ? "the patch puts back " + name + "=\"" + restore + "\", the reading's" : "the patch removes it; name a screen action or a screen: onclick=\"Save\"") is { } p)
                            corrections[p] = "script";
                        scriptAttributes.Add((node, name, restore));
                        continue;
                    }
                    if (Anvil.Core.ScreenDocument.IsIterationAttribute(name) && read?.Get(name) != value) {
                        var (source, alias, plain) = Anvil.Core.ScreenDocument.ParseIteration(value);
                        if (ProblemOnce(ScreenHtmlEdit.ForEach, AtNode(node), node.Get("k"), name + "=\"" + Clip(value) + "\" is the iteration of another framework: a repetition is a List",
                                plain ? "list=\"" + source + "\"" + (alias != null ? ", and the row " + alias + ".X is " + source + ".Current.X inside it" : "") + " (the patch, when it compiles)"
                                    : "list=\"<Aggregate>.List\", the row is <Aggregate>.List.Current inside") is { } p && plain)
                            corrections[p] = "iteration";
                        if (plain) iterations.Add((node, name, source, alias));
                    }
                }
            }
            foreach (var problem in edited.Problems) {
                // Half a column of a native Table or an attribute of its parts, said above with the Table's k and its patch (TableRules).
                if (ScreenHtmlTables.IsTableProblem(problem) && Result.Problems.Any(p => p["code"]?.ToString() is ScreenHtmlEdit.TableColumn or Anvil.Core.ScreenDocument.TableColspan or Anvil.Core.ScreenDocument.TablePart)) continue;
                // The same event, said above with its element, its k and its fix.
                if (EventProblem.Match(problem) is { Success: true } said && scriptEvents.Contains(said.Groups[1].Value + "\u0001" + said.Groups[2].Value)) continue;
                var script = problem.Contains("is not Destination(", StringComparison.Ordinal) && LooksLikeScript(problem);
                Problem(script ? ScreenHtmlEdit.Script : ScreenHtmlEdit.Invalid, null, null, problem,
                    script ? "an event names its destination: onclick=\"Save\" or onclick=\"Open(Id = Row.Id)\"; JavaScript is not written in the page (logic is native)"
                    : "write the element as the reading writes it (ScreenHtml.Contract: elements, attributes, events)");
            }
            // Root: the actions are the logic text's; the page lists them. The list as read is accepted as it is: an action the
            // module has now and the text does not list (created since the reading, by an earlier op of the job or in the Studio, or
            // left out by the text) stays, said in normalized (the page never removes one; the note says no more than that, the
            // plan cannot know which of the two it was: review of round 2, A8), so the edit of 2026-10-18 written before its job's
            // logic op created ShowChainPage is no refusal. A name the module does not have is the one refusal, with the logic op as
            // its fix.
            var root = edited.Elements.GetValueOrDefault("");
            if (root != null)
                foreach (var list in new[] { "actions", "data-actions" }) {
                    var has = (model.Elements[""].Facts.GetValueOrDefault(list) ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    var says = ((listedInText.TryGetValue(list, out var text) ? text : root.Facts.GetValueOrDefault(list)) ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    var unknown = says.Except(has, StringComparer.Ordinal).ToList();
                    if (unknown.Count > 0) {
                        Problem(ScreenHtmlEdit.ActionsListed, AtId(""), null, list + "=\"…\" of " + reading.Root + " names " + string.Join(", ", unknown) + ", which " + reading.Root + " does not have; the page lists the "
                            + (list == "actions" ? "screen actions" : "data actions") + ", the logic op creates, renames and removes them",
                            "create " + string.Join(", ", unknown) + " with a logic op placed before this html op in the same job (" + (list == "actions" ? "action " : "data action ") + reading.Root + "." + unknown[0]
                            + "), or take " + (unknown.Count == 1 ? "it" : "them") + " out of " + list + "=");
                        continue;
                    }
                    var kept = has.Except(says, StringComparer.Ordinal).ToList();
                    if (kept.Count == 0) continue;
                    Result.Normalized.Add(new JsonObject { ["k"] = null, ["property"] = list, ["kept"] = new JsonArray(kept.Select(n => (JsonNode)n).ToArray()),
                        ["note"] = "listed as the module has them now: the text did not list " + string.Join(", ", kept) + ", which " + (kept.Count == 1 ? "stays" : "stay") + " (the page never removes an action; the logic op does)" });
                }
            foreach (var (id, element) in edited.Elements) {
                var before = model.Elements.GetValueOrDefault(id);
                if (!id.StartsWith('+') && before == null && !IsStructural(id))
                    Problem(ScreenHtmlEdit.KeyForeign, AtId(id), id, "k=\"" + id + "\" is not an element of the reading", "drop the k (a new element) or use a k of the reading");
                if (before != null && before.Kind != element.Kind) {
                    if (before.Kind == "os-opaque" || element.Kind == "os-opaque") continue;
                    if (IsData(before.Kind) || IsData(element.Kind) || IsStructural(id))
                        Problem(ScreenHtmlEdit.KindChanged, AtId(id), id, "k=\"" + id + "\" was " + before.Kind + " and is now " + element.Kind, "keep its tag; to replace a data element remove it and write a new one without k");
                    else recreated.Add(id);
                }
                else if (before != null && element.Kind is "MobileBlockInstanceWidget" or "WebBlockInstanceWidget" && before.Facts.GetValueOrDefault("p:SourceBlock") != element.Facts.GetValueOrDefault("p:SourceBlock")) recreated.Add(id);
            }
            // Slots of a block instance are its block's placeholders.
            foreach (var (id, element) in edited.Elements.Where(e => e.Value.Kind == "PlaceholderContentWidget" && IsStructural(e.Key))) {
                var owner = id[..id.LastIndexOf('/')];
                if (IsNew(owner) || model.Elements.ContainsKey(id)) continue;
                var names = model.Elements.Where(e => e.Key.StartsWith(owner + "/", StringComparison.Ordinal) && e.Value.Kind == "PlaceholderContentWidget").Select(e => e.Key[(owner.Length + 1)..]).ToList();
                Problem(ScreenHtmlEdit.SlotUnknown, AtId(owner), owner, "<slot name=\"" + id[(owner.Length + 1)..] + "\"> is not a placeholder of the block of k=\"" + owner + "\"",
                    "the slots of that instance are: " + string.Join(", ", names));
            }
            CheckOpaque();
            CheckVisible();
            CheckNames();
            CheckFixedNames();
            CheckDestinations();
            CheckBlocks();
            CheckArguments();
            CheckLiterals();
            CheckDefaults();
            CheckProperties();
            CheckPlatformProperties();
            CheckNewData();
            PatchVisible();
            if (Refused) return;
            foreach (var (id, element) in model.Elements) {
                if (IsStructural(id) || id.Length == 0) continue;
                if (!edited.Elements.ContainsKey(id) || recreated.Contains(id)) deleted.Add(id);
            }
            foreach (var (id, _) in edited.Elements) {
                if (IsNew(id) || IsStructural(id) || id.Length == 0 || !model.Elements.ContainsKey(id)) continue;
                if (!modelParents.TryGetValue(id, out var was) || !editedParents.TryGetValue(id, out var now)) continue;
                if (was != now || ParentRecreated(now.Parent)) moved.Add(id);
            }
            CheckDeletes();
            CheckNesting();
        }

        // An input written or moved inside a link or a button: the platform refuses it at the create, so the plan refuses it
        // first, with every case at once.
        private static readonly HashSet<string> InputKinds = new(StringComparer.Ordinal) { "Input", "TextArea", "Dropdown", "Checkbox", "Switch", "RadioGroup", "ButtonGroup", "Upload" };
        private void CheckNesting()
        {
            foreach (var (id, element) in edited.Elements) {
                if (!InputKinds.Contains(element.Kind) || !(IsNew(id) || moved.Contains(id))) continue;
                for (var p = editedParents.GetValueOrDefault(id).Parent; p is { Length: > 0 }; p = editedParents.TryGetValue(p, out var up) ? up.Parent : null) {
                    var kind = edited.Elements.GetValueOrDefault(p)?.Kind;
                    if (kind is not ("Link" or "Button")) continue;
                    Problem(ScreenHtmlEdit.Invalid, AtId(id), id.StartsWith('+') ? null : id,
                        "a new or moved " + element.Kind + " inside the " + kind + (p.StartsWith('+') ? " the edit adds" : " k=\"" + p + "\"") + ": the platform takes no input inside a link or a button",
                        "put it beside the " + kind.ToLowerInvariant() + ", inside their common container");
                    break;
                }
            }
        }

        // HTML_NAME_FIXED (the session of 2026-10-18: "the platform refused set Name: Widget does not support name changing"): a
        // name the Studio gives and never lets change (ScreenHtmlTables.FixedName) is never written. A slot's name is its
        // placeholder's: a text that writes another one (os-Name on a <slot>, of an instance with k or of a new one) is refused here,
        // before anything is written, once per slot, with the patch that writes the slot as read; a <content name> of an element
        // with k is one of the Contents it has. The other names follow one rule in Facts: an element whose text writes no name keeps
        // the one it has.
        private readonly List<(ScreenHtml.Node Node, string Attribute, string? Restore)> nameAttributes = [];
        // The elements whose name the edit lets go (id=""), cleared before any name is written (Apply).
        private readonly HashSet<string> namesLetGo = new(StringComparer.Ordinal);
        private void CheckFixedNames()
        {
            foreach (var (id, element) in edited.Elements) {
                if (!ScreenHtmlTables.FixedName(element.Kind) || !IsStructural(id)) continue;
                var cut = element.Kind == "Content" ? id.IndexOf("/content:", StringComparison.Ordinal) : id.LastIndexOf('/');
                if (cut <= 0) continue;
                var owner = id[..cut];
                var ofOwner = IsNew(owner) ? "the new <" + (idNodes.TryGetValue(owner, out var made) ? made.Tag : edited.Elements.GetValueOrDefault(owner)?.Kind) + ">" + (made != null ? " at line " + made.Line.ToString(CultureInfo.InvariantCulture) : "")
                    : "k=\"" + owner + "\"";
                if (element.Kind == "Content") {
                    if (IsNew(owner) || model.Elements.ContainsKey(id)) continue;
                    var name = id[(cut + "/content:".Length)..];
                    var names = model.Elements.Keys.Where(e => e.StartsWith(owner + "/content:", StringComparison.Ordinal)).Select(e => e[(owner.Length + "/content:".Length)..]).Order(StringComparer.Ordinal).ToList();
                    ProblemOnce(ScreenHtmlEdit.NameFixed, AtId(owner), owner,
                        "<content name=\"" + name + "\"> is not a Content of " + ofOwner + ": " + (names.Count == 0 ? "its widgets are written without <content>" : "its Contents are " + string.Join(", ", names))
                        + "; the Studio names a Content and does not let the name change",
                        names.Count == 0 ? "write the widgets inside " + ofOwner + " without <content>" : "keep <content name> as read: " + string.Join(", ", names.Select(n => "<content name=\"" + n + "\">")));
                    continue;
                }
                if (!element.Facts.TryGetValue("p:Name", out var value)) continue;
                var slot = id[(cut + 1)..];
                var given = IsNew(id) ? null : model.Elements.GetValueOrDefault(id)?.Facts.GetValueOrDefault("p:Name");
                // The name it has, its placeholder's, or none (os-Name="", as the reading writes a slot whose Name is null): the name
                // stays the Studio's, never written (review of round 2, A4: the copy of a block read with os-Name="" slots).
                if (value == given || value == "t:" + slot || value == "?:") continue;
                var node = idNodes.TryGetValue(owner, out var block) ? block.Children.FirstOrDefault(c => !c.IsText && c.Tag == "slot" && c.Get("name") == slot) : null;
                var restore = IsNew(owner) ? null : ReadNode(owner)?.Children.FirstOrDefault(c => !c.IsText && c.Tag == "slot" && c.Get("name") == slot)?.Get("os-Name");
                var written = node?.Get("os-Name") ?? (value.Length > 2 ? value[2..] : "");
                if (ProblemOnce(ScreenHtmlEdit.NameFixed, AtId(owner), IsNew(owner) ? null : owner,
                        "os-Name=\"" + written + "\" on <slot name=\"" + slot + "\"> of " + ofOwner + ": the name of a slot is its placeholder's (" + slot + "), which the Studio does not let change (Widget does not support name changing)",
                        restore != null ? "the patch puts back os-Name=\"" + restore + "\", the reading's" : "write the slot without os-Name; the patch writes it as read") is { } problem && node != null) {
                    corrections[problem] = "name";
                    nameAttributes.Add((node, "os-Name", restore));
                }
            }
        }

        private bool ParentRecreated(string parent)
        {
            for (var p = parent; p.Length > 0; p = p.Contains('/') ? p[..p.LastIndexOf('/')] : "") {
                if (recreated.Contains(p) || p.StartsWith('+')) return true;
                if (!p.Contains('/')) break;
            }
            return false;
        }

        private static bool LooksLikeScript(string text) =>
            text.Contains(';') || text.Contains("=>", StringComparison.Ordinal) || text.Contains("function", StringComparison.Ordinal) || text.Contains('{') || text.Contains("()", StringComparison.Ordinal);

        private void CheckOpaque()
        {
            foreach (var (id, before) in model.Elements.Where(e => e.Value.Kind == "os-opaque")) {
                var line = "<os-opaque k=\"" + id + "\" kind=\"" + before.Facts["kind"] + "\"" + (before.Facts["name"].Length > 0 ? " name=\"" + before.Facts["name"] + "\"" : "") + ">";
                if (!edited.Elements.TryGetValue(id, out var now)) { Problem(ScreenHtmlEdit.OpaqueTouched, null, id, "the " + before.Facts["kind"] + " k=\"" + id + "\" was removed; it has no form in ssam-html/1 yet and stays as it is", "write it back as read: " + line); continue; }
                if (now.Kind != "os-opaque" || !now.Facts.OrderBy(f => f.Key).SequenceEqual(before.Facts.OrderBy(f => f.Key)))
                    Problem(ScreenHtmlEdit.OpaqueTouched, AtId(id), id, "the " + before.Facts["kind"] + " k=\"" + id + "\" changed; it has no form in ssam-html/1 yet", "write it back as read: " + line);
                else if (modelParents.GetValueOrDefault(id) != editedParents.GetValueOrDefault(id))
                    Problem(ScreenHtmlEdit.OpaqueTouched, AtId(id), id, "the " + before.Facts["kind"] + " k=\"" + id + "\" moved", "keep it where it was read");
                else if (!OpaqueChildren(model, before).SequenceEqual(OpaqueChildren(edited, now)))
                    Problem(ScreenHtmlEdit.OpaqueTouched, AtId(id), id, "the rows and cells of the " + before.Facts["kind"] + " k=\"" + id + "\" changed", "keep its os-opaque children as read; the widgets inside a cell can change");
            }
            foreach (var (id, element) in edited.Elements.Where(e => e.Key.StartsWith('+') && e.Value.Kind == "os-opaque"))
                Problem(ScreenHtmlEdit.OpaqueTouched, AtId(id), null, "a new <os-opaque> has no meaning: os-opaque only keeps a widget that has no form yet", "write the element with its own tag");
        }
        private static IEnumerable<string> OpaqueChildren(ScreenHtmlCanon canon, ScreenHtmlCanon.Element element) =>
            element.Children.Where(t => t.StartsWith("k:", StringComparison.Ordinal) && canon.Elements.TryGetValue(t[2..], out var c) && c.Kind == "os-opaque");

        // U1: Visible that is not True is never written new; the one the reading had is kept and listed.
        private void CheckVisible()
        {
            var wrap = new List<string>();
            foreach (var (id, element) in edited.Elements) {
                if (!element.Facts.TryGetValue("p:Visible", out var value) || value == "e:True") continue;
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id)?.Facts.GetValueOrDefault("p:Visible");
                if (before == value) { Result.VisiblePreserved.Add(new JsonObject { ["k"] = id, ["visible"] = value[2..] }); continue; }
                wrap.Add(id);
            }
            if (wrap.Count == 0) return;
            visibleWraps = wrap;
            foreach (var id in wrap) {
                var condition = edited.Elements[id].Facts["p:Visible"][2..];
                Problem(ScreenHtmlEdit.Visible, AtId(id), id.StartsWith('+') ? null : id,
                    "os-Visible=\"" + condition + "\" on " + (id.StartsWith('+') ? "a new element" : "k=\"" + id + "\"") + ": Visible is never written new (U1); a condition is an If around the element",
                    "remove os-Visible and write <div if=\"" + condition + "\"> around the element");
            }
        }
        private List<string>? visibleWraps;

        // After every check: the patch of the problems whose fix is certain (a new Visible wrapped in its If, a script removed, an
        // event put back or removed, a foreign iteration turned into the List), all in one corrected edit list, attached only when
        // it plans with no problem but the ones this edit has for other reasons (checked, never a guess). When the iterations make
        // it fail (a source the module does not have), the rest goes without them.
        private void PatchVisible()
        {
            if (!patches || visibleWraps == null && visibleVariants.Count == 0 && scriptElements.Count == 0 && scriptAttributes.Count == 0 && iterations.Count == 0 && markerAttributes.Count == 0 && columnCells.Count == 0 && nameAttributes.Count == 0 && attributeFixes.Count == 0) return;
            var withIterations = iterations.Count > 0;
            var corrected = WrapVisible(visibleWraps ?? [], withIterations);
            if (corrected == null && withIterations) { withIterations = false; corrected = WrapVisible(visibleWraps ?? [], false); }
            if (corrected == null) return;
            foreach (var problem in Result.Problems.Where(p => p["code"]?.ToString() == ScreenHtmlEdit.Visible
                         || corrections.TryGetValue(p, out var kind) && (kind is "script" or "visible" or "marker" or "column" or "name" or "property" || kind == "iteration" && withIterations))) {
                problem["fix"] = problem["fix"] + " (the patch replaces the edit list with that)";
                problem["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = corrected.DeepClone() });
                problem["patchRule"] = "OWNER_RULE_REWRITE";
            }
        }
        // Half a column of a native Table (a header cell without its row cell, or the other way): the platform removes and adds the
        // two together (deleting a header cell deletes its column), so the edit is refused once, with the Table's k. When the reading
        // pairs every cell the edit kept by its k, the patch removes the other half of each column the edit removed: the whole
        // column goes. A new cell without its pair has no certain patch (the fix says what to write).
        private void TableColumns(ScreenHtml.Node node, ScreenHtmlTables.NativeTableShape table)
        {
            var k = node.Get("k");
            List<ScreenHtml.Node>? others = null;
            if (k != null && ReadNode(k) is { } readTable && ScreenHtmlTables.NativeTable(readTable) is { } before && before.HeaderCells.Count == before.RowCells.Count) {
                var kept = new HashSet<string>(table.HeaderCells.Concat(table.RowCells).Select(c => c.Get("k")).OfType<string>(), StringComparer.Ordinal);
                var gone = Enumerable.Range(0, before.HeaderCells.Count).Where(i => !kept.Contains(before.HeaderCells[i].Get("k") ?? "") || !kept.Contains(before.RowCells[i].Get("k") ?? "")).ToList();
                var pairs = gone.SelectMany(i => new[] { before.HeaderCells[i].Get("k"), before.RowCells[i].Get("k") }).OfType<string>().ToHashSet(StringComparer.Ordinal);
                others = table.HeaderCells.Concat(table.RowCells).Where(c => c.Get("k") is { } key && pairs.Contains(key)).ToList();
                if (others.Count == 0 || table.HeaderCells.Count(c => !others.Contains(c)) != table.RowCells.Count(c => !others.Contains(c))) others = null;
            }
            var message = "the native Table" + (k != null ? " k=\"" + k + "\"" : "") + " has " + table.HeaderCells.Count + " header cells and " + table.RowCells.Count
                + " row cells: a column of a Table is one <th> in the header row and one <td> in the template row, removed and added together (the platform deletes the whole column with either of its cells)";
            var fix = others != null
                ? "remove the whole column: the patch removes " + string.Join(", ", others.Select(c => "<" + c.Tag + " k=\"" + c.Get("k") + "\">")) + " too"
                : "write one <th> and one <td> per column: remove or add both cells of a column";
            if (ProblemOnce(ScreenHtmlEdit.TableColumn, AtNode(node), k, message, fix) is { } p && others != null) {
                corrections[p] = "column";
                columnCells.AddRange(others.Select(c => (c, (string?)null, (List<ScreenHtml.Node>?)null, (string?)null)));
            }
        }
        // The certain corrections of the rules of a native Table (TableRules, TableColumns, CellsLeftOut), which the patch makes: a
        // cell removed (no attribute: the other half of a column the edit removed), an attribute of a part removed, colspan removed
        // from a cell with the cells of the columns it spanned written after it, or an attribute written (Value: the k of a column's
        // own cell on the new one in its place).
        private readonly List<(ScreenHtml.Node Node, string? Attribute, List<ScreenHtml.Node>? After, string? Value)> columnCells = [];

        // The family of half a column with the rows still as many (probes C1, C3, C4 of round 3): a cell of the reading the edit leaves
        // out while the other cell of its column stays, a new one written in its place. The platform deletes the whole column with
        // either of its cells, so the other one went too and the Verify kept nothing ("2 children read back, the edit has 3"). Refused
        // once per column, with the patch that gives the new cell of that column (in the same place of its row) the k of the
        // column's own: the same column, its content the edit's.
        private void CellsLeftOut(ScreenHtml.Node node, ScreenHtmlTables.NativeTableShape table)
        {
            var k = node.Get("k");
            if (k == null || ReadNode(k) is not { } readTable || ScreenHtmlTables.NativeTable(readTable) is not { } before || before.HeaderCells.Count != before.RowCells.Count) return;
            var written = new HashSet<string>(table.HeaderCells.Concat(table.RowCells).Select(c => c.Get("k")).OfType<string>(), StringComparer.Ordinal);
            var heads = table.HeaderCells.Select(c => c.Get("k")).ToList();
            var rows = table.RowCells.Select(c => c.Get("k")).ToList();
            for (var i = 0; i < before.HeaderCells.Count; i++) {
                if (before.HeaderCells[i].Get("k") is not { } head || before.RowCells[i].Get("k") is not { } row || written.Contains(head) == written.Contains(row)) continue;
                var headGone = written.Contains(row);
                var (gone, kept) = headGone ? (head, row) : (row, head);
                var (tag, keptTag) = headGone ? ("th", "td") : ("td", "th");
                var at = headGone ? rows.IndexOf(row) : heads.IndexOf(head);
                var cells = headGone ? table.HeaderCells : table.RowCells;
                var cell = at >= 0 && at < cells.Count && cells[at].Get("k") == null ? cells[at] : null;
                if (ProblemOnce(ScreenHtmlEdit.TableColumn, AtNode(node), k,
                        "<" + tag + " k=\"" + gone + "\"> of the native Table k=\"" + k + "\" is left out while its column's <" + keptTag + " k=\"" + kept + "\"> stays: "
                        + "the platform deletes the whole column with either of its cells",
                        cell != null ? "keep the column's own cell: the patch writes k=\"" + gone + "\" on the new <" + tag + "> of that column (its content the edit's)"
                            : "keep <" + tag + " k=\"" + gone + "\"> (its content can change) or remove the whole column, both cells") is { } p && cell != null) {
                    corrections[p] = "column";
                    columnCells.Add((cell, "k", null, gone));
                }
            }
        }

        // The rules of a native Table the edit writes, the document's (ScreenDocument.TableProblems) with the Table's k and the patch
        // of the edit list (the review of round 2, M-A, M-B, L1): an attribute of its <thead>, <tbody> or <tr> it has no property for
        // is refused with the patch that removes it; the class of a section joins its row's and the List's own classes and attributes
        // where the list is are left out, said in normalized; half a column that colspan explains is refused with the patch that
        // writes the cell without colspan and one empty cell per column it spanned, where a column the reading has keeps its own cell,
        // emptied, with its k (the platform deletes the whole column with either of its cells: a new one in its place would take
        // the column of data with it); any other half a column is TableColumns. A cell spans one column and one row (the owner's
        // decision of 2026-10-19, ScreenHtmlTables.Spans): each other colspan and rowspan it writes new is refused with the patch that
        // removes it; what the reading has (the cell's own, by its k) stays, as the Visible.
        private void TableRules(ScreenHtml.Node node, ScreenHtmlTables.NativeTableShape table)
        {
            var k = node.Get("k");
            var what = k != null ? "the native Table k=\"" + k + "\"" : "the new native Table at line " + node.Line.ToString(CultureInfo.InvariantCulture);
            if (ScreenHtmlTables.Folded(table) is { Count: > 0 } folded)
                Result.Normalized.Add(new JsonObject { ["code"] = "TABLE_NATIVE", ["k"] = k, ["element"] = "TableRecords", ["note"] = what + ": " + string.Join("; ", folded) });
            foreach (var header in new[] { true, false })
                foreach (var (part, attribute) in ScreenHtmlTables.PartAttributes(table, header)) {
                    if (ProblemOnce(Anvil.Core.ScreenDocument.TablePart, AtNode(node), k, "<" + part.Tag + " " + attribute + "=\"" + Clip(part.Get(attribute) ?? "") + "\"> of " + what + ": "
                            + ScreenHtmlTables.PartAttributeWhy, "the patch removes it") is { } p)
                        corrections[p] = "column";
                    columnCells.Add((part, attribute, null, null));
                }
            foreach (var (cells, row) in new[] { (table.HeaderCells, "header row"), (table.RowCells, "template row") })
                for (var i = 0; i < cells.Count; i++) {
                    var cell = cells[i];
                    var read = cell.Get("k") is { } ck ? ReadNode(ck) : null;
                    foreach (var (attribute, value) in ScreenHtmlTables.Spans(cell).ToList()) {
                        if (ScreenHtmlTables.SpanExplained(table, cell, attribute) || read?.Get(attribute) == value) continue;
                        if (ProblemOnce(Anvil.Core.ScreenDocument.TableColspan, AtNode(node), k,
                                "<" + cell.Tag + (cell.Get("k") is { } ek ? " k=\"" + ek + "\"" : "") + " " + attribute + "=\"" + Clip(value) + "\">, cell " + (i + 1).ToString(CultureInfo.InvariantCulture)
                                + " of the " + row + " of " + what + ": " + ScreenHtmlTables.SpanWhy(attribute, cell.Tag), "the patch removes " + attribute) is { } p)
                            corrections[p] = "column";
                        columnCells.Add((cell, attribute, null, null));
                    }
                }
            if (table.HeaderCells.Count == table.RowCells.Count) { CellsLeftOut(node, table); return; }
            if (!ScreenHtmlTables.SpanExplains(table)) { TableColumns(node, table); return; }
            // The reading's Table, its columns paired (header cell i with row cell i): the cell of a column whose other cell the edit
            // keeps, and that the edit writes nowhere, is that column's own.
            var before = k != null && ReadNode(k) is { } readTable && ScreenHtmlTables.NativeTable(readTable) is { } b && b.HeaderCells.Count == b.RowCells.Count ? b : null;
            var written = new HashSet<string>(table.HeaderCells.Concat(table.RowCells).Select(c => c.Get("k")).OfType<string>(), StringComparer.Ordinal);
            var spansHeader = table.HeaderCells.Count < table.RowCells.Count;
            var (fewer, more) = spansHeader ? (table.HeaderCells, table.RowCells) : (table.RowCells, table.HeaderCells);
            var position = 0;
            foreach (var cell in fewer) {
                var span = ScreenHtmlTables.Span(cell);
                if (span > 1) {
                    var cells = new List<ScreenHtml.Node>();
                    for (var column = position + 1; column < position + span; column++) {
                        var empty = new ScreenHtml.Node { Tag = cell.Tag, Line = cell.Line, Column = cell.Column };
                        if (before != null && more[column].Get("k") is { } pair) {
                            var index = (spansHeader ? before.RowCells : before.HeaderCells).ToList().FindIndex(c => c.Get("k") == pair);
                            if (index >= 0 && (spansHeader ? before.HeaderCells : before.RowCells)[index] is var own && own.Get("k") is { } ownK && !written.Contains(ownK))
                                empty.Attributes.AddRange(own.Attributes);
                        }
                        cells.Add(empty);
                    }
                    if (ProblemOnce(Anvil.Core.ScreenDocument.TableColspan, AtNode(node), k,
                            "<" + cell.Tag + (cell.Get("k") is { } ck ? " k=\"" + ck + "\"" : "") + " colspan=\"" + cell.Get("colspan") + "\"> of " + what + ": " + Anvil.Core.ScreenDocument.ColspanWhy,
                            "the patch writes the <" + cell.Tag + "> without colspan and after it one empty cell per column it spanned: "
                            + string.Concat(cells.Select(c => "<" + c.Tag + (c.Get("k") is { } ek ? " k=\"" + ek + "\"" : "") + "></" + c.Tag + ">"))
                            + (cells.Any(c => c.Get("k") != null) ? " (a column of the reading keeps its own cell, emptied: the platform deletes the whole column with either of its cells)" : "")) is { } p)
                        corrections[p] = "column";
                    columnCells.Add((cell, "colspan", cells, null));
                }
                position += span;
            }
        }

        private static string Signature(JsonObject problem) => problem["code"] + "|" + (problem["k"]?.ToString() ?? problem["message"]?.ToString());

        // The corrected edits: each element with a new Visible wrapped in <div if>, the edit widened to the element's parent when
        // the element was the edit itself; each new script removed, each script event put back or removed, each foreign iteration
        // turned into the List (with iterations). Returned only when the corrected edits plan without a problem of what they
        // corrected and without any problem this edit does not have already (checked).
        private JsonArray? WrapVisible(List<string> ids, bool withIterations = false)
        {
            try {
                var copy = ScreenHtmlText.Clone(merged);
                var map = new Dictionary<ScreenHtml.Node, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
                void Pair(ScreenHtml.Node a, ScreenHtml.Node b) { map[a] = b; for (var i = 0; i < a.Children.Count; i++) Pair(a.Children[i], b.Children[i]); }
                Pair(merged, copy);
                var parents = ScreenHtmlText.Parents(copy);
                var roots = new HashSet<ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
                foreach (var (node, _) in ScreenHtmlText.Elements(merged)) if (editedNodes.Contains(node) && (!parents.TryGetValue(map[node], out var p) || !editedNodes.Contains(Original(p)))) roots.Add(map[node]);
                ScreenHtml.Node Original(ScreenHtml.Node c) => map.First(x => ReferenceEquals(x.Value, c)).Key;
                foreach (var (node, attribute, restore) in scriptAttributes.Concat(markerAttributes).Concat(nameAttributes)) {
                    var target = map[node];
                    var at = target.Attributes.FindIndex(a => a.Key == attribute);
                    // A name let go (id="" on the element that keeps it, HTML_NAME_TAKEN of a moved name): written where it was not.
                    if (at < 0) { if (restore != null && nameAttributes.Any(x => ReferenceEquals(x.Node, node) && x.Attribute == attribute)) target.Attributes.Add(new(attribute, restore)); continue; }
                    if (restore != null) target.Attributes[at] = new(attribute, restore); else target.Attributes.RemoveAt(at);
                }
                foreach (var (node, attribute, restore, rename) in attributeFixes) {
                    var target = map[node];
                    var at = target.Attributes.FindIndex(a => a.Key == attribute);
                    if (at < 0) continue;
                    if (rename != null) target.Attributes[at] = new(rename, target.Attributes[at].Value);
                    else if (restore != null) target.Attributes[at] = new(attribute, restore);
                    else target.Attributes.RemoveAt(at);
                }
                foreach (var node in scriptElements) {
                    var target = map[node];
                    if (roots.Contains(target) || !parents.TryGetValue(target, out var parent)) return null;   // the edit was the script alone
                    parent.Children.Remove(target);
                }
                // The corrections of the rules of a native Table: the other half of each column the edit removed, an attribute of a
                // part, colspan with the cells of the columns it spanned after the cell, the k of a column's own header cell.
                foreach (var (node, attribute, after, value) in columnCells) {
                    var target = map[node];
                    if (attribute == null) {
                        if (roots.Contains(target) || !parents.TryGetValue(target, out var row)) return null;
                        row.Children.Remove(target);
                        continue;
                    }
                    target.Attributes.RemoveAll(a => a.Key == attribute);
                    if (value != null) { target.Attributes.Insert(0, new(attribute, value)); continue; }
                    if (after == null) continue;
                    if (!parents.TryGetValue(target, out var holder)) return null;
                    holder.Children.InsertRange(holder.Children.IndexOf(target) + 1, after.Select(c => { var made = new ScreenHtml.Node { Tag = c.Tag }; made.Attributes.AddRange(c.Attributes); return made; }));
                }
                if (withIterations)
                    foreach (var (node, attribute, source, alias) in iterations)
                    {
                        // The plan reads names, not expressions: the List is certain only when its source is data of the page and
                        // its row reads what that data has (a list of values whole; a record's attributes, by the module; the
                        // attributes of an output of a data action of the page, whose record the reading does not write, the Verify's).
                        if (Anvil.Core.ScreenDocument.IterateInTree(map[node], attribute, source, alias, copy) is not { Declared: true } use) return null;
                        if (use.Output ? use.Whole
                            : use.Values ? use.Members.Count > 0
                            : use.Record == null || use.Whole || use.Members.Any(x => x != use.Record && !m.HasMember(use.Record, x))) return null;
                    }
                // The element inside <div if="condition">; the edit that was the element itself becomes its parent with a k (a slot
                // is its block instance's). False: no parent with a k to send.
                bool Wrap(ScreenHtml.Node target, string condition)
                {
                    var parent = parents[target];
                    var wrapper = new ScreenHtml.Node { Tag = "div" };
                    wrapper.Attributes.Add(new("if", condition));
                    wrapper.Children.Add(target);
                    parent.Children[parent.Children.IndexOf(target)] = wrapper;
                    parents[wrapper] = parent; parents[target] = wrapper;
                    if (!roots.Remove(target)) return true;
                    var up = parent;
                    while (up.Get("k") == null && parents.TryGetValue(up, out var next)) up = next;
                    if (up.Get("k") == null) return false;
                    roots.Add(up);
                    return true;
                }
                foreach (var id in ids) {
                    var target = map[idNodes[id]];
                    var condition = edited.Elements[id].Facts["p:Visible"][2..];
                    target.Attributes.RemoveAll(a => a.Key == "os-Visible");
                    if (!Wrap(target, condition)) return null;
                }
                // os-Visible in another case: removed, and its condition an If around the element.
                foreach (var (node, attribute, condition) in visibleVariants) {
                    var target = map[node];
                    target.Attributes.RemoveAll(a => a.Key == attribute);
                    if (condition != null && !Wrap(target, condition)) return null;
                }
                var outer = roots.Where(r => !roots.Any(o => !ReferenceEquals(o, r) && ScreenHtmlText.Elements(o).Any(x => ReferenceEquals(x.Node, r)))).ToList();
                var ordered = ScreenHtmlText.Elements(copy).Select(x => x.Node).Where(n => outer.Contains(n)).ToList();
                var texts = ordered.Select(ScreenHtmlText.Write).ToList();
                var check = new EditPlan(m, reading, texts, pointer, patches: false, theme: theme);
                bool Fixed(JsonObject p) => p["code"]?.ToString() == ScreenHtmlEdit.Visible
                    || corrections.TryGetValue(p, out var kind) && (kind is "script" or "visible" or "marker" or "column" or "name" or "property" || kind == "iteration" && withIterations);
                var known = new HashSet<string>(Result.Problems.Where(p => !Fixed(p)).Select(Signature), StringComparer.Ordinal);
                return check.Result.Problems.Any(p => p["code"]?.ToString() == ScreenHtmlEdit.Visible || !known.Contains(Signature(p))) ? null
                    : new JsonArray(texts.Select(t => (JsonNode)t).ToArray());
            } catch (Exception) { return null; }
        }

        // L3d (HTML_EDIT_NOT_APPLIED of 11-24/10, the sets the platform refused after the build): what an edit writes on a property
        // is judged before anything is written, on a model object of the element's kind (the element itself, else another of its
        // kind in the module, else the one the create made) by the writer's own rule, and by the defaults the Studio was measured
        // with.
        // - A property the element's kind does not have here (HTML_PROPERTY_UNKNOWN: weight of an O11 <i>, enabled of an O11
        //   <upload>, class of an If; "has no writable property or setter" in 9 deliveries): the fix names what the kind writes;
        //   the patch renames the attribute to the one it certainly means, or removes it (nothing of it could be written). An If
        //   takes no class: the fix writes it on a container inside it (a new If has it moved there already, IF_CLASS_MOVED).
        // - An empty value (HTML_VALUE_EMPTY): of a property that takes a number, an option or a boolean the platform refuses it
        //   (os-GridColumns="", relato 9540e92c, "The input string '' was not in a correct format"); an empty expression is none,
        //   and the module reads back without the attribute. The patch leaves the attribute out (the Studio's default); the fix
        //   names the reading's value. The type is the reading's or, for a new element, the one the Studio was measured with;
        //   after the create the new elements are judged again with their own types. An attribute that makes the element what it
        //   is (if, list, bind, options, content) is not one of these.
        // Only what the edit writes new is judged: an attribute the reading wrote stays as it was.
        public const string PropertyUnknown = "HTML_PROPERTY_UNKNOWN", ValueEmpty = "HTML_VALUE_EMPTY";
        private void CheckPlatformProperties(bool created = false)
        {
            foreach (var (id, element) in edited.Elements) {
                if (element.Kind is "os-opaque" or "Content" or "PlaceholderContentWidget" || IsStructural(id) || created && !IsNew(id)) continue;
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id);
                if (!IsNew(id) && before == null || !idNodes.TryGetValue(id, out var node)) continue;
                var mode = IsData(element.Kind) ? ScreenHtmlModuleMode.Data : ScreenHtmlModuleMode.Widget;
                T? sample = null; var looked = false;
                foreach (var (fact, value) in element.Facts.ToList()) {
                    if (!fact.StartsWith("p:", StringComparison.Ordinal) || fact is "p:SourceBlock" or "p:Name" or "p:Tag" || value.Length < 2 || value[1] != ':') continue;
                    if (before != null && before.Facts.GetValueOrDefault(fact) == value) continue;
                    var property = fact[2..];
                    if (AttributeIn(node, element.Kind, property, mode) is not { } attribute) continue;
                    // F2 judged this attribute first (CheckProperties, the one property model): its problem is the one of this
                    // attribute (T16: one problem per attribute, never two codes for one value), and the certain patch this rule
                    // knows goes on it (PlatformOnce), so nothing of either rule is lost.
                    var judged = Result.Problems.FirstOrDefault(p => p["attribute"]?.ToString() == attribute && (id.StartsWith('+') ? p["k"] == null && p["kind"]?.ToString() == element.Kind : p["k"]?.ToString() == id));
                    var written = Clip(node.Get(attribute) ?? value[2..]);
                    var where = id.StartsWith('+') ? "a new " + element.Kind + " (line " + node.Line.ToString(CultureInfo.InvariantCulture) + ")" : element.Kind + " k=\"" + id + "\"";
                    var k = id.StartsWith('+') ? null : id;
                    // A property the reading never writes (a setting of the Studio's canvas, a computed one: os-DesignMode of an If,
                    // receipt 6da32953 of 22/10): written, the module could never read back as the text.
                    if (ScreenHtml.NotFacts.Contains(property) || ModelReader<T>.IsNoise(property)) {
                        if (PlatformOnce(judged, PropertyUnknown, AtId(id), k, attribute + "=\"" + written + "\" on " + where + ": " + property + " is not part of ssam-html/1 (the reading never writes it, so the module could not read back as the edit)",
                                "remove " + attribute) is { } unread && !created) {
                            corrections[unread] = "property";
                            attributeFixes.Add((node, attribute, null, null));
                        }
                        continue;
                    }
                    if (!looked) { sample = created ? objects.GetValueOrDefault(id) : IsNew(id) ? SampleOf(element.Kind) : Existing(id); looked = true; }
                    if (sample != null && WaysToWrite(sample) is { } ways && !ways.Has(property)) {
                        if (element.Kind == "IfWidget" && property is "Style" or "StyleClasses") {
                            PlatformOnce(judged, PropertyUnknown, AtId(id), k, attribute + "=\"" + written + "\" on " + where + ": an If shows no element of its own, so it takes no class here",
                                "write the class on a container inside it: <div k=\"" + id + "\" if=\"...\"><div class=\"" + written + "\">...</div></div>, with the If's children inside that container");
                            continue;
                        }
                        var writable = ways.Writable;
                        var certain = ScreenHtmlEdit.Certain(property, writable);
                        var renamed = certain != null ? ScreenHtmlTables.AttributeOf(element.Kind, certain, mode, element.Facts.ContainsKey("p:StyleClasses")) : null;
                        if (PlatformOnce(judged, PropertyUnknown, AtId(id), k, attribute + "=\"" + written + "\" on " + where + ": " + element.Kind + " has no " + property + " in " + Anvil.Core.KernelLane.Current.ToUpperInvariant()
                                + " (the platform would refuse the set after the build)",
                                (renamed != null ? "write " + renamed : "remove " + attribute) + "; " + element.Kind + " writes " + string.Join(", ", ScreenHtmlEdit.Closest(property, writable, 8))) is { } unknown && !created) {
                            corrections[unknown] = "property";
                            attributeFixes.Add((node, attribute, null, renamed));
                        }
                        continue;
                    }
                    // An empty value: where the platform parses a number, an option or a boolean it refuses it; an empty expression is
                    // no expression, which reads back as the attribute left out.
                    if (value.Length > 2 || node.Get(attribute) is not "" || attribute is "if" or "list" or "bind" or "options" or "content") continue;
                    // A new element is decoded before it exists (an expression, unless the reading has its kind): the type the
                    // Studio was measured with, when it has the property.
                    var type = IsNew(id) && !created && Defaults.Of(element.Kind)?.GetValueOrDefault(property) is { Length: > 1 } born ? born[0] : value[0];
                    // integ/proto-into-product: an empty expression of a property whose default is empty (a placeholder, a url) is
                    // the default written explicitly, which F2 (the candidate's round trip) accepts and reads back as the text that
                    // left it out; an empty expression of a property with another default (Enabled: True) is refused, as a number, an
                    // option or a boolean the platform refuses empty.
                    var bornValue = Defaults.Of(element.Kind)?.GetValueOrDefault(property);
                    if (type == 'e' && (bornValue == null || bornValue.Length <= 2)) continue;
                    if (type is not ('v' or 'b' or 'e')) continue;
                    var read = k != null ? ReadNode(k)?.Get(attribute) : null;
                    if (PlatformOnce(judged, ValueEmpty, AtId(id), k, attribute + "=\"\" on " + where + ": " + property
                            + (type == 'e' ? " takes an expression, and an empty one is none (the module would read back without " + attribute + ")"
                                : " takes " + (type == 'b' ? "True or False" : "a value (a number or one of its options)") + ", never an empty one (the platform would refuse it after the build)"),
                            "write the value, or leave " + attribute + " out for the Studio's default (the patch removes it)" + (read != null ? "; the reading has " + attribute + "=\"" + read + "\"" : "")) is { } empty && !created) {
                        corrections[empty] = "property";
                        attributeFixes.Add((node, attribute, null, null));
                    }
                }
                // An attribute that is no property of the kind is an extended property: on an element that holds none (an
                // os-ActionConnector of a Traditional screen) the platform refuses its create after the build.
                foreach (var (fact, value) in element.Facts) {
                    if (!fact.StartsWith("x:", StringComparison.Ordinal) || before?.Facts.Values.Contains(value) == true) continue;
                    // A control attribute of the language (enabled, disabled, required) on a widget that has no such property (no
                    // Upload has Enabled, in either lane) is no HTML attribute to keep: refused, never an extended property.
                    if (value[..value.IndexOf('\n')] is "enabled" or "disabled" or "required" && mode == ScreenHtmlModuleMode.Widget && element.Kind != "AdvancedHtml"
                        && !ScreenHtmlTables.Reverse(element.Kind, mode).ContainsValue(value.StartsWith("required\n", StringComparison.Ordinal) ? "Mandatory" : "Enabled")) {
                        var control = value[..value.IndexOf('\n')];
                        var at = node.Attributes.FirstOrDefault(a => a.Key == control).Key;
                        if (at != null && ProblemOnce(PropertyUnknown, AtId(id), id.StartsWith('+') ? null : id, control + "=\"" + Clip(node.Get(control) ?? "") + "\" on "
                                + (id.StartsWith('+') ? "a new " + element.Kind : element.Kind + " k=\"" + id + "\"") + ": " + element.Kind + " has no " + (control == "required" ? "Mandatory" : "Enabled")
                                + " (the platform would keep it as an HTML attribute that does nothing)", "remove " + control) is { } inert && !created) {
                            corrections[inert] = "property";
                            attributeFixes.Add((node, control, null, null));
                        }
                        continue;
                    }
                    if (!looked) { sample = created ? objects.GetValueOrDefault(id) : IsNew(id) ? SampleOf(element.Kind) : Existing(id); looked = true; }
                    if (sample == null || WaysToWrite(sample) is not { Extended: false }) break;
                    var name = value[..value.IndexOf('\n')];
                    var attribute = node.Attributes.FirstOrDefault(a => a.Key == name || a.Key == "ext:" + name).Key ?? name;
                    if (ProblemOnce(PropertyUnknown, AtId(id), id.StartsWith('+') ? null : id, attribute + "=\"" + Clip(node.Get(attribute) ?? value[(value.IndexOf('\n') + 1)..]) + "\" on " + (id.StartsWith('+') ? "a new " + element.Kind : element.Kind + " k=\"" + id + "\"")
                            + ": " + element.Kind + " has no property " + name + " and holds no extended property (the platform would refuse it after the build)",
                            "remove " + attribute) is { } extended && !created) {
                        corrections[extended] = "property";
                        attributeFixes.Add((node, attribute, null, null));
                    }
                }
            }
        }
        // L3d: a new <Block name> that names no block of the module or of its references, or several, was refused by the platform at
        // its create, after the build ("no block named 'BottomSheet' for a new <Block>", 3 receipts of 12-22/10). The plan says it
        // first: the block it certainly means (the patch writes it), or the closest ones; a block of a producer the module does not
        // reference yet comes with a reference op of the same job; one of several is named Owner.Name, Kind:Name or @key.
        private void CheckBlocks()
        {
            List<(string Name, string Qualified)>? blocks = null;
            foreach (var (id, element) in edited.Elements) {
                if (!IsNew(id) || IsStructural(id) || element.Kind is not ("MobileBlockInstanceWidget" or "WebBlockInstanceWidget") || !idNodes.TryGetValue(id, out var node)) continue;
                var name = node.Get("name") ?? "";
                if (m.TryResolveBlock(name, state.Scope, out _)) continue;
                blocks ??= BlockNames();
                var bare = name[(name.LastIndexOfAny([':', '.']) + 1)..];
                var same = blocks.Where(b => string.Equals(b.Name, bare, StringComparison.OrdinalIgnoreCase)).Select(b => b.Qualified).Distinct(StringComparer.Ordinal).ToList();
                var where = "the new <Block name=\"" + name + "\"> (line " + node.Line.ToString(CultureInfo.InvariantCulture) + ")";
                if (same.Count > 1) {
                    Problem(ScreenHtmlEdit.NameUnknown, AtId(id), null, where + " names " + same.Count + " blocks of " + m.ModuleName + " and its references",
                        "name one of them: " + string.Join(", ", same.Take(6)));
                    continue;
                }
                var certain = same.Count == 1 ? blocks.First(b => string.Equals(b.Name, bare, StringComparison.OrdinalIgnoreCase)).Name
                    : ScreenHtmlEdit.Certain(bare, blocks.Select(b => b.Name));
                if (certain != null && !m.TryResolveBlock(certain, state.Scope, out _)) certain = null;
                if (Problem(ScreenHtmlEdit.NameUnknown, AtId(id), null, where + (same.Count == 1 ? " is not how " + m.ModuleName + " names its block " + bare : " names no block of " + m.ModuleName + " or of its references"),
                        certain != null ? "write <Block name=\"" + certain + "\">"
                        : "reference it in the same job (a reference op of its producer, before the html op), or write one of: " + string.Join(", ", ScreenHtmlEdit.Closest(bare, blocks.Select(b => b.Name), 5))) is { } unknown && certain != null) {
                    corrections[unknown] = "property";
                    attributeFixes.Add((node, "name", certain, null));
                }
            }
        }
        // L3d: an event runs a screen action of its page or opens a screen. A name that resolves to anything else (a server or a
        // client action of the module or of a reference, a role, nearer than the screen of that name) was refused by the platform
        // at the set, after the build ("A OutSystems.Model.IObject cannot be used as the value for the ...Destination property",
        // 15/10, and onclick="Login" on the fixtures today). The plan says it first, with the screen or screen action of that
        // name as the patch when there is one, written as the reading writes it.
        private void CheckDestinations()
        {
            foreach (var (id, element) in edited.Elements) {
                if (!idNodes.TryGetValue(id, out var node)) continue;
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id);
                foreach (var (fact, value) in element.Facts) {
                    // A new element's events are its HTML events until it exists (hev:, the native ones known only after the create).
                    if (!(fact.StartsWith("ev:", StringComparison.Ordinal) || fact.StartsWith("h:", StringComparison.Ordinal) || fact.StartsWith("hev:", StringComparison.Ordinal)) || fact.Contains(":a:", StringComparison.Ordinal)
                        || fact.Contains(":p:", StringComparison.Ordinal) || value.Length == 0 || value[0] == '?' || before?.Facts.GetValueOrDefault(fact) == value) continue;
                    if (m.IndexOf(value) is not (var i and >= 0) || Runs(i)) continue;
                    var written = node.Attributes.FirstOrDefault(a => (a.Key.StartsWith("on", StringComparison.Ordinal) && !a.Key.Contains('.') || a.Key.StartsWith('@'))
                        && ScreenHtml.TryCall(a.Value, out var called, out _) && m.TryResolveDestination(called.Trim(), state.Scope, out var hit) && hit == value);
                    if (written.Key == null || !ScreenHtml.TryCall(written.Value, out var name, out _)) continue;
                    name = name.Trim();
                    var bare = name[(name.LastIndexOfAny([':', '.']) + 1)..];
                    // What the name may mean here: a screen, or a screen action of this page.
                    var meant = new List<string>();
                    for (var j = 0; j < m.nodes.Count; j++)
                        if (Runs(j) && string.Equals(m.display[j], bare, StringComparison.OrdinalIgnoreCase)
                            && m.TryResolveDestination(m.kind[j] + ":" + m.display[j], state.Scope, out var back) && back == m.id[j])
                            meant.Add(m.kind[j] + ":" + m.display[j]);
                    var where = id.StartsWith('+') ? "a new " + element.Kind + " (line " + node.Line.ToString(CultureInfo.InvariantCulture) + ")" : element.Kind + " k=\"" + id + "\"";
                    if (ProblemOnce(ScreenHtmlEdit.NameUnknown, AtId(id), id.StartsWith('+') ? null : id,
                            written.Key + "=\"" + Clip(written.Value) + "\" on " + where + ": '" + name + "' is the " + m.kind[i] + " " + m.display[i] + ", which an event cannot run (an event runs a screen action of " + reading.Root + " or opens a screen)",
                            meant.Count == 1 ? "write " + written.Key + "=\"" + meant[0] + written.Value[written.Value.IndexOf(name, StringComparison.Ordinal)..][name.Length..] + "\""
                            : meant.Count > 1 ? "name one of: " + string.Join(", ", meant) : "name a screen action of " + reading.Root + " (a logic op in the same job creates it) or a screen") is { } wrong && meant.Count == 1) {
                        corrections[wrong] = "property";
                        attributeFixes.Add((node, written.Key, meant[0] + written.Value[written.Value.IndexOf(name, StringComparison.Ordinal)..][name.Length..], null));
                    }
                }
            }
            // What an event runs: a screen (of the module or of a reference), or a screen action of this page.
            bool Runs(int j) => m.role[j] == "screen" || m.kind[j].EndsWith("ScreenSignature", StringComparison.Ordinal) || m.role[j] == "action" && m.root[j] == state.Root;
        }

        // L3d: an argument (:Name) of a block instance that is no input of its block was refused by the platform after the build
        // ("the block of k=\"+2\" has no input Title", the SSAM_DumpProbe of 20/10: Title is a placeholder of Modal). Judged on the
        // instance (of the reading, another of the same block in the module, or the one the create just made, before its facts are
        // written): the inputs it has, the input it certainly means as the patch, and the slot when the name is a placeholder.
        private void CheckArguments(bool created = false)
        {
            foreach (var (id, element) in edited.Elements) {
                if (element.Kind is not ("MobileBlockInstanceWidget" or "WebBlockInstanceWidget") || IsStructural(id) || created && !IsNew(id) || !idNodes.TryGetValue(id, out var node)) continue;
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id);
                var written = element.Facts.Keys.Where(f => f.StartsWith("a:", StringComparison.Ordinal) && before?.Facts.ContainsKey(f) != true).Select(f => f[2..]).ToList();
                if (written.Count == 0) continue;
                var instance = created ? objects.GetValueOrDefault(id) : IsNew(id) ? InstanceOf(element.Kind, node.Get("name") ?? "") : Existing(id);
                if (instance == null) continue;
                var inputs = m.r.ChildrenOf(instance).Where(c => m.r.KindOf(c) == "Argument").Select(ArgumentName).Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
                var slots = m.r.ChildrenOf(instance).Where(c => m.r.KindOf(c) == "PlaceholderContentWidget").Select(c => m.r.DisplayOf(c)).ToList();
                var where = id.StartsWith('+') ? "a new <Block name=\"" + node.Get("name") + "\"> (line " + node.Line.ToString(CultureInfo.InvariantCulture) + ")" : "the <Block> k=\"" + id + "\"";
                foreach (var name in written.Where(n => !inputs.Contains(n, StringComparer.Ordinal))) {
                    var slot = slots.FirstOrDefault(s => string.Equals(s, name, StringComparison.OrdinalIgnoreCase));
                    var certain = slot == null ? ScreenHtmlEdit.Certain(name, inputs) : null;
                    if (ProblemOnce(ScreenHtmlEdit.NameUnknown, AtId(id), id.StartsWith('+') ? null : id, ":" + name + " on " + where + ": its block has no input " + name
                            + " (inputs: " + (inputs.Count > 0 ? string.Join(", ", inputs) : "none") + (slots.Count > 0 ? "; placeholders: " + string.Join(", ", slots) : "") + ")",
                            slot != null ? slot + " is a placeholder of the block: write what goes there as <slot name=\"" + slot + "\">...</slot> inside the <Block>, without :" + name
                            : certain != null ? "write :" + certain : "remove :" + name + (inputs.Count > 0 ? ", or write one of: " + string.Join(", ", ScreenHtmlEdit.Closest(name, inputs, 5)) : "")) is { } unknown
                        && certain != null && !created) {
                        corrections[unknown] = "property";
                        attributeFixes.Add((node, ":" + name, null, ":" + certain));
                    }
                }
            }
        }
        // An instance in the module of the block a new <Block name> names (its arguments and slots are the block's), or null.
        private T? InstanceOf(string kind, string name)
        {
            if (!m.TryResolveBlock(name, state.Scope, out var block)) return null;
            for (var i = 0; i < m.nodes.Count; i++)
                if (m.kind[i] == kind && m.r.PropertyOf(m.nodes[i], "SourceBlock")?.Invoke() is T source && m.IdOf(source) == block) return m.nodes[i];
            return null;
        }

        // The blocks a <Block name> can name: those of the module and of its references, by name and as Owner.Name.
        private List<(string Name, string Qualified)> BlockNames()
        {
            var names = new List<(string, string)>();
            for (var i = 0; i < m.nodes.Count; i++)
                if (IsBlockKind(m.kind[i]) && m.display[i].Length > 0)
                    names.Add((m.display[i], (m.parent[i] >= 0 && m.display[m.parent[i]].Length > 0 ? m.display[m.parent[i]] + "." : "") + m.display[i]));
            foreach (var (name, ids) in m.outsideByName)
                if (ids.Any(o => m.outside.TryGetValue(o, out var x) && IsBlockKind(x.Kind))) names.Add((name, name));
            return names;
        }

        // A node of the module of that kind (the class a create of that kind makes here), or null.
        private readonly Dictionary<string, T?> samples = new(StringComparer.Ordinal);
        private T? SampleOf(string kind)
        {
            if (samples.TryGetValue(kind, out var sample)) return sample;
            for (var i = 0; i < m.nodes.Count && sample == null; i++) if (m.kind[i] == kind) sample = m.nodes[i];
            return samples[kind] = sample;
        }

        // What the writer can write on a model object (ModelSession.CanSet: a property of a Model API interface of its class, a
        // Set<X> or From<X>(text) method; Style also where the widget keeps its classes, StyleClasses or the extended property),
        // and the names it writes. Null for an object that answers to no Model API interface (a test model): nothing is judged.
        private sealed record Ways(Func<string, bool> Has, List<string> Writable, bool Extended);
        private static Ways? WaysToWrite(object node)
        {
            var properties = Anvil.Core.ModelApiMetadata.Properties(node.GetType());
            var methods = Anvil.Core.ModelApiMetadata.Methods(node.GetType());
            if (properties.Length == 0 && methods.Length == 0) return null;
            bool Member(string name) => properties.Any(p => p.Name == name)
                || methods.Any(x => x.GetParameters().Length == 1 && (x.Name == "Set" + name || x.Name == "From" + name));
            var extended = methods.Any(x => x.Name.StartsWith("Create", StringComparison.Ordinal) && x.ReturnType.Name == "IExtendedProperty");
            static bool Expression(Type t) => t.Name == "IExpression" || t.GetInterfaces().Any(i => i.Name == "IExpression");
            var writable = properties.Where(p => p.CanWrite || Expression(p.PropertyType)).Select(p => p.Name)
                .Concat(methods.Where(x => x.Name.StartsWith("Set", StringComparison.Ordinal) && x.Name.Length > 3 && x.GetParameters().Length == 1).Select(x => x.Name[3..]))
                .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
            return new Ways(name => Member(name) || name == "Style" && (Member("StyleClasses") || extended), writable, extended);
        }

        // The attribute of the element that wrote a property (as the decoder read it): its name in the table, or os-<Property>.
        private static string? AttributeIn(ScreenHtml.Node node, string kind, string property, ScreenHtmlModuleMode mode)
        {
            var named = ScreenHtmlTables.AttributeOf(kind, property, mode, node.Attributes.Any(a => a.Key == "os-Style"));
            if (node.Attributes.Any(a => a.Key == named)) return named;
            var reverse = ScreenHtmlTables.Reverse(kind, mode);
            foreach (var (key, _) in node.Attributes) if (reverse.GetValueOrDefault(key) == property || key == "os-" + property) return key;
            return null;
        }

        // Names that resolve to nothing; JSON in a changed expression (L6).
        private void CheckNames()
        {
            foreach (var (id, element) in edited.Elements) {
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id);
                // A run {{ expression }} the reading did not have (a run is a child, not a fact).
                foreach (var run in element.Children.Where(t => t.StartsWith("x:", StringComparison.Ordinal) && (t.Contains("JSONSerialize(", StringComparison.Ordinal) || t.Contains("JSONDeserialize(", StringComparison.Ordinal))))
                    if (before?.Children.Contains(run) != true)
                        ProblemOnce(ScreenHtmlEdit.Json, AtId(id), id.StartsWith('+') ? null : id, "JSONSerialize/JSONDeserialize in a page binding (L6): " + run[2..], "pass the record or the list itself");
                foreach (var (fact, value) in element.Facts) {
                    if (before != null && before.Facts.TryGetValue(fact, out var was) && was == value) continue;
                    var text = fact.StartsWith("x:", StringComparison.Ordinal) ? value[(value.IndexOf('\n') + 1)..] : value.Length > 1 && value[1] == ':' ? value[2..] : value;
                    if (value.StartsWith("e:", StringComparison.Ordinal) || fact.Contains(":a:", StringComparison.Ordinal) || fact.StartsWith("a:", StringComparison.Ordinal) || fact.StartsWith("x:", StringComparison.Ordinal))
                        if (text.Contains("JSONSerialize(", StringComparison.Ordinal) || text.Contains("JSONDeserialize(", StringComparison.Ordinal))
                            Problem(ScreenHtmlEdit.Json, AtId(id), id.StartsWith('+') ? null : id, "JSONSerialize/JSONDeserialize in a page binding (L6): " + text, "pass the record or the list itself");
                    var unresolved = fact.StartsWith("p:", StringComparison.Ordinal) ? value.StartsWith("r:?", StringComparison.Ordinal) ? value[3..] : null
                        : (fact.StartsWith("ev:", StringComparison.Ordinal) || fact.StartsWith("h:", StringComparison.Ordinal) || fact.StartsWith("hev:", StringComparison.Ordinal))
                          && !fact.Contains(":a:", StringComparison.Ordinal) && !fact.Contains(":p:", StringComparison.Ordinal) && value.StartsWith('?') ? value[1..] : null;
                    if (unresolved == null) continue;
                    var candidates = Candidates(fact);
                    var certain = ScreenHtmlEdit.Certain(unresolved, candidates);
                    Problem(ScreenHtmlEdit.NameUnknown, AtId(id), id.StartsWith('+') ? null : id,
                        "'" + unresolved + "' names nothing " + (fact.StartsWith("p:", StringComparison.Ordinal) ? "for " + fact[2..] : "as the destination of " + fact) + " from " + reading.Root,
                        certain != null ? "write '" + certain + "'" : "closest: " + string.Join(", ", ScreenHtmlEdit.Closest(unresolved, candidates)));
                }
            }
        }

        // A property that takes a literal (its type in the model is text, a number or an enum, never an expression) written with a
        // binding: the literal of a constant binding ({{ "abc" }} is abc, listed), else refused (the page would show the braces). What
        // the reading had is kept. The type is the model's: the reading's shapes, and after the create the new elements' own.

        // F2: what an edit writes on a property is judged by the one property model of the element (ScreenHtmlModule.PropertiesOf,
        // the native model of its concrete type), before anything is written: a property the page does not keep (editor state such
        // as DesignMode, a value the platform derives, a property without a setter, one the kind does not have) and a value its
        // property does not take (a member outside its enumeration, a boolean that is neither True nor False). What the reading
        // had stays as it was. An element with k is judged on its node before the first write; a new one right after it is
        // created (its model is the one of the node the platform made), before its facts are written.
        private void CheckProperties(bool created = false)
        {
            foreach (var (id, element) in edited.Elements) {
                if (id.Length == 0 || IsStructural(id) || element.Kind is "os-opaque" or "Content" || IsData(element.Kind) || IsNew(id) != created) continue;
                var node = created ? objects.GetValueOrDefault(id) : Existing(id);
                if (node == null) continue;
                var properties = m.PropertiesOf(node);
                var before = created ? null : model.Elements.GetValueOrDefault(id);
                foreach (var (fact, value) in element.Facts) {
                    if (!fact.StartsWith("p:", StringComparison.Ordinal) || fact is "p:Name" or "p:Tag" or "p:SourceBlock" || value.Length < 2 || value[1] != ':') continue;
                    if (before != null && before.Facts.TryGetValue(fact, out var was) && was == value) continue;
                    var property = fact[2..]; var text = value[2..];
                    var attribute = ScreenHtmlTables.AttributeOf(element.Kind, property, ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                    var reading = before?.Facts.GetValueOrDefault(fact);
                    var expected = reading == null ? "absent (the reading leaves " + attribute + " out)" : "'" + Clip(reading[2..]) + "' (the reading's)";
                    // Only an os- attribute names a property the kind may not have (a named attribute is the table's); the rule is the one
                    // the reading's own facts are held to (ScreenHtmlModule.Refusal).
                    if (!properties.ContainsKey(property) && !attribute.StartsWith("os-", StringComparison.Ordinal)) continue;
                    if (ScreenHtmlModule<T>.Refusal(properties, property, value, m.ListsEveryProperty) is not { } refusal) continue;
                    if (!properties.ContainsKey(property)) {
                        var close = ScreenHtmlEdit.Closest(property, properties.Values.Where(x => x.NotOfThePage == null && x.Writable).Select(x => x.Name));
                        PropertyProblem(refusal.Code, id, element.Kind, property, attribute, expected, text, element.Kind + " has no property " + property,
                            "remove " + attribute + (close.Count > 0 ? " (the closest properties of " + element.Kind + ": " + string.Join(", ", close) + ")" : ""));
                    }
                    else if (refusal.Code == ScreenHtmlEdit.PropertyNotKept)
                        PropertyProblem(refusal.Code, id, element.Kind, property, attribute, expected, text, refusal.Why, "remove " + attribute + " and send the edit again");
                    else {
                        var members = refusal.Takes!.Split(", ");
                        // The closest member only when one is certain (ScreenHtmlEdit.Certain); otherwise the members, and no guess.
                        var certain = ScreenHtmlEdit.Certain(text, members);
                        PropertyProblem(refusal.Code, id, element.Kind, property, attribute, "one of " + refusal.Takes, text, refusal.Why,
                            certain != null ? "write " + attribute + "=\"" + certain + "\" (the closest member; it takes one of " + refusal.Takes + ")"
                                : "write " + attribute + " as one of " + refusal.Takes);
                    }
                }
            }
        }
        // A refusal of F2: the element (its k, or a new one), its kind, the property and its attribute, what was expected and what the
        // edit (or the module read again) has, and the one call that goes on.
        private JsonObject? PropertyProblem(string code, string id, string kind, string property, string attribute, string expected, string? actual, string why, string next)
        {
            var element = id.StartsWith('+') ? "a new " + kind : "k=\"" + id + "\" (" + kind + ")";
            var message = attribute + " on " + element + ": " + why + "; expected " + expected + ", actual " + (actual == null ? "absent" : "'" + Clip(actual) + "'");
            if (ProblemOnce(code, id.StartsWith('+') ? null : AtId(id), id.StartsWith('+') ? null : id, message, next) is not { } problem) return null;
            problem["kind"] = kind; problem["property"] = property; problem["attribute"] = attribute;
            problem["expected"] = expected; problem["actual"] = actual; problem["next"] = next;
            return problem;
        }
        private void CheckLiterals(bool created = false)
        {
            foreach (var (id, element) in edited.Elements) {
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id);
                // T1: a literal run of the text that holds the brace pair of a binding (<text>{{ x }}</text>) would show the braces:
                // refused before anything is written, with the run its binding stands for (BindingText); the reading's own print of
                // such a run (braces as &#123;) is the same run, kept.
                if (!created)
                    foreach (var child in element.Children)
                        if (child.StartsWith("t:", StringComparison.Ordinal) && BindingText.HoldsPair(child[2..]) && !(before?.Children.Contains(child) ?? false))
                            PropertyProblem(BindingText.Remnant, id, element.Kind, "Text", "<text>", "a literal run without the braces of a binding", child[2..],
                                "a literal run of the text holds the binding " + Clip(child[2..]) + ": the page would show the braces",
                                "write the run as " + BindingText.TextFixOf(child[2..]) + " (a constant binding is its text, any other binding an Expression); braces the page must show are written &#123; in <text>, or split in an expression");
                foreach (var (fact, value) in element.Facts.ToList()) {
                    // T1: a text literal of an expression that holds a binding ("{{ ""Search"" }}": the literal of a placeholder written
                    // with one) would show its braces: refused before anything is written, with the expression it stands for. What the
                    // element already had is kept (the reading prints it whole, {{ "{{ ...}}" }}).
                    if ((created || !IsNew(id)) && (fact.StartsWith("p:", StringComparison.Ordinal) && value.StartsWith("e:", StringComparison.Ordinal) || fact.StartsWith("x:", StringComparison.Ordinal))
                        && !(before != null && before.Facts.TryGetValue(fact, out var had) && had == value)
                        && (fact[0] == 'x' ? value[(value.IndexOf('\n') + 1)..] : value[2..]) is var expression && BindingText.Remnants(expression).FirstOrDefault() is { } remnant) {
                        var attribute = fact[0] == 'x' ? value[..Math.Max(0, value.IndexOf('\n'))]
                            : ScreenHtmlTables.AttributeOf(element.Kind, fact[2..], IsData(element.Kind) ? ScreenHtmlModuleMode.Data : ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                        PropertyProblem(BindingText.Remnant, id, element.Kind, fact[0] == 'x' ? "ExtendedProperty" : fact[2..], attribute, "an expression whose text literals hold no binding", expression,
                            "a text literal of the expression holds the binding " + Clip(remnant) + ": the page would show the braces",
                            "write " + attribute + "='" + BindingText.FixOf(remnant) + "' (the expression the binding stands for); braces the page must show are split in the expression ({{ \"{\" + \"{\" }})");
                        continue;
                    }
                    // Prose where an expression goes (two operands with no operator, …?!;): the platform never parses it; the
                    // attribute is named, with its string literal as the fix, before anything is written.
                    // (A new element's types are the model's only once it exists: its facts are judged after the create.)
                    // T1: braces inside the expression's text literals no longer skip the check (only braces of its code do: a record).
                    if ((created || !IsNew(id)) && fact.StartsWith("p:", StringComparison.Ordinal) && value.StartsWith("e:", StringComparison.Ordinal) && !BindingText.BracesInCode(value[2..])
                        && ScreenHtml.NotAnExpression(value[2..]) && !(before != null && before.Facts.TryGetValue(fact, out var said) && said == value)) {
                        var attribute = ScreenHtmlTables.AttributeOf(element.Kind, fact[2..], IsData(element.Kind) ? ScreenHtmlModuleMode.Data : ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                        ProblemOnce(ScreenHtmlEdit.Invalid, AtId(id), id.StartsWith('+') ? null : id,
                            attribute + "=\"" + Clip(value[2..]) + "\" on " + (id.StartsWith('+') ? "a new " + element.Kind : "k=\"" + id + "\"") + " is no expression (two words with no operator between them, a character no expression has, a ':' or a number mask): " + fact[2..] + " takes an expression",
                            "as text, write its string literal: " + attribute + "='" + ScreenHtml.Literal(value[2..]) + "'");
                        continue;
                    }
                    // Integration 24-1 familias (review): an expression typed wrong (a parenthesis or a quote not closed, an operator
                    // at the end, a name and its '(' left open) has two readings, the expression meant and the text; it is refused
                    // before anything is written with what its syntax lacks, never written as its literal.
                    if ((created || !IsNew(id)) && fact.StartsWith("p:", StringComparison.Ordinal) && value.StartsWith("e:", StringComparison.Ordinal) && !BindingText.BracesInCode(value[2..])
                        && Anvil.Core.Preflight.ExpressionSyntax.Check(value[2..]) is { } syntax && !(before != null && before.Facts.TryGetValue(fact, out var kept) && kept == value)) {
                        var attribute = ScreenHtmlTables.AttributeOf(element.Kind, fact[2..], IsData(element.Kind) ? ScreenHtmlModuleMode.Data : ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                        ProblemOnce(ScreenHtmlEdit.Invalid, AtId(id), id.StartsWith('+') ? null : id,
                            attribute + "=\"" + Clip(value[2..]) + "\" on " + (id.StartsWith('+') ? "a new " + element.Kind : "k=\"" + id + "\"") + " is an expression its syntax refuses: " + syntax.Problem,
                            syntax.Fix + " (no patch: the expression meant and the text are two readings; a text goes in quotes)");
                        continue;
                    }
                    if (!fact.StartsWith("p:", StringComparison.Ordinal) || value.Length < 2 || value[0] is not ('t' or 'v') || value[1] != ':' || fact == "p:StyleSheet") continue;
                    if (before != null && before.Facts.TryGetValue(fact, out var was) && was == value) continue;
                    var text = value[2..];
                    if (!ScreenHtml.HoldsBraces(text)) continue;
                    if (BindingText.Literal(text) is { } constant) {
                        element.Facts[fact] = value[0] + ":" + constant;
                        Result.Normalized.Add(new JsonObject { ["code"] = "LITERAL_CONSTANT", ["k"] = id.StartsWith('+') ? null : id, ["property"] = fact[2..], ["from"] = text, ["to"] = constant,
                            ["note"] = fact[2..] + " takes a literal: the constant binding is its value" });
                        continue;
                    }
                    ProblemOnce(Anvil.Core.ScreenDocument.BindingLiteral, AtId(id), id.StartsWith('+') ? null : id,
                        "'" + Clip(text) + "' in " + fact[2..] + " of " + (id.StartsWith('+') ? "a new " + element.Kind : "k=\"" + id + "\"") + ": " + fact[2..] + " takes a literal, never an expression (the page would show the braces)",
                        "write the " + fact[2..] + " itself, or put the expression in an attribute that takes one (an extended property, {{ }} in the text)");
                }
            }
        }

        // The names a reference of this fact can take: actions of this root and screens for an event, every name of the module
        // otherwise (the decoder resolves in the same scope).
        private List<string> Candidates(string fact)
        {
            var names = new List<string>();
            var events = !fact.StartsWith("p:", StringComparison.Ordinal);
            for (var i = 0; i < m.nodes.Count; i++) {
                if (m.display[i].Length == 0) continue;
                if (events ? m.root[i] == state.Root && m.role[i] == "action" || m.role[i] == "screen" : m.root[i] == state.Root || m.root[i] < 0) names.Add(m.display[i]);
            }
            return names;
        }

        // DEFAULT_NOT_LITERAL on an edit (the rule of the preflight, HtmlDocumentRules.EditDefaults, with the reading of the
        // module): an input or a variable whose default the edit writes new or changed and that is no literal. A default the
        // reading had stays (the runtime accepted it); a Traditional root takes expression defaults.
        private void CheckDefaults()
        {
            if (Anvil.Core.Preflight.HtmlDocumentRules.TakesExpressionDefaults(reading.RootKind)) return;
            foreach (var (id, element) in edited.Elements) {
                if (element.Kind is not ("LocalVariable" or "InputParameter") || !idNodes.TryGetValue(id, out var node) || node.Get("default") is not { } value) continue;
                if (!Anvil.Core.Preflight.HtmlDocumentRules.MovableDefault(value, node.Get("type"))) continue;
                var before = !IsNew(id) && node.Get("k") is { } k ? ReadNode(k)?.Get("default") : null;
                if (before != null && before.Trim() == value.Trim()) continue;
                var (message, fix) = Anvil.Core.Preflight.HtmlDocumentRules.EditDefaultRefusal(element.Kind == "LocalVariable" ? "variable" : "input", node.Get("name") ?? id, reading.Root, value.Trim(), before);
                ProblemOnce("DEFAULT_NOT_LITERAL", AtId(id), id.StartsWith('+') ? null : id, message, fix);
            }
        }

        private void CheckNewData()
        {
            foreach (var (id, element) in edited.Elements.Where(e => e.Key.StartsWith('+'))) {
                // A variable or an input belongs to the screen or block itself: written inside an element, the platform refuses its
                // create after the build ("cannot create ILocalVariable (no Create method in the API)").
                if (element.Kind is "InputParameter" or "LocalVariable" && editedParents.TryGetValue(id, out var holder) && holder.Parent.Length > 0) {
                    var tag = idNodes.TryGetValue(id, out var data) ? data.Tag : element.Kind;
                    Problem(ScreenHtmlEdit.Invalid, AtId(id), null, "a new <" + tag + (data?.Get("name") is { } named ? " name=\"" + named + "\"" : "") + "> inside " + (holder.Parent.StartsWith('+') ? "a new element" : "k=\"" + holder.Parent + "\"")
                        + ": a " + (tag == "var" ? "variable" : "input") + " belongs to the " + (reading.RootKind.EndsWith("Block", StringComparison.Ordinal) ? "block" : "screen") + " itself, never to an element of it",
                        "write it as a child of the <" + (reading.RootKind.EndsWith("Block", StringComparison.Ordinal) ? "block" : "screen") + "> (with edits: {\"into\":\"/\",\"insert\":\"<" + tag + " .../>\",\"at\":\"first\"})");
                    continue;
                }
                if (!IsData(element.Kind) || element.Kind is "InputParameter" or "LocalVariable") continue;
                Problem(ScreenHtmlEdit.DataNew, AtId(id), null, "a new <" + (idNodes.TryGetValue(id, out var n) ? n.Tag : element.Kind) + "> in an edit: aggregates, data actions and screen actions are created by the logic op",
                    "create it with a logic op in the same job; the page then names it");
            }
            // A widget name is unique in its screen: a new or renamed one takes a free name (the platform would rename it in silence).
            // An element whose text writes no name keeps its own, which stays taken. The name of a slot, an If branch or a Content is
            // the Studio's (a slot's is its placeholder's, the same in every instance of the block): never a widget name of the
            // screen (the review of round 2, A4: a copy of a block whose slots read os-Name="" was refused id="" twice). No name
            // (id="") is no name taken.
            var taken = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var keptUnwritten = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (id, element) in model.Elements)
                if (!IsData(element.Kind) && !ScreenHtmlTables.FixedName(element.Kind) && element.Facts.TryGetValue("p:Name", out var name) && name.Length > 2
                    && edited.Elements.TryGetValue(id, out var still) && !IsNew(id) && (still.Facts.GetValueOrDefault("p:Name") ?? name) == name) {
                    taken[name[2..]] = id;
                    if (!still.Facts.ContainsKey("p:Name")) keptUnwritten.Add(id);
                }
            foreach (var (id, element) in edited.Elements) {
                if (IsData(element.Kind) || ScreenHtmlTables.FixedName(element.Kind) || !element.Facts.TryGetValue("p:Name", out var value) || value.Length <= 2) continue;
                var name = value[2..];
                if (!IsNew(id) && model.Elements.GetValueOrDefault(id)?.Facts.GetValueOrDefault("p:Name") == value) continue;
                if (taken.TryGetValue(name, out var owner) && owner != id) {
                    var free = name; for (var n = 2; taken.ContainsKey(free); n++) free = name + n.ToString(CultureInfo.InvariantCulture);
                    // The review of round 2, A2: a name moved from one element to another (A written without its id, B with A's name).
                    // A text that leaves an id out keeps the name (the session of 2026-10-18 left every id out of the elements it
                    // edited, eb863ad2): that alone never says A lets the name go, so the move is refused, once, saying why A still has
                    // the name, with the patch that lets it go (id="" on A, checked) and the other way out (another id here).
                    if (keptUnwritten.Contains(owner) && idNodes.TryGetValue(owner, out var ownerNode)) {
                        var attribute = ScreenHtmlTables.AttributeOf(model.Elements[owner].Kind, "Name", ScreenHtmlModuleMode.Widget, model.Elements[owner].Facts.ContainsKey("p:StyleClasses"));
                        if (Problem(ScreenHtmlEdit.NameTaken, AtId(id), id.StartsWith('+') ? null : id,
                                "id=\"" + name + "\" is the name k=\"" + owner + "\" keeps in " + reading.Root + ": its text writes no " + attribute + ", and an element with k whose text leaves its "
                                + attribute + " out keeps the name it has (" + attribute + "=\"\" clears it)",
                                "to move the name here, write " + attribute + "=\"\" on k=\"" + owner + "\" (the patch); to leave it there, give this element another one: id=\"" + free + "\"") is { } taking) {
                            corrections[taking] = "name";
                            nameAttributes.Add((ownerNode, attribute, ""));
                        }
                    }
                    else Problem(ScreenHtmlEdit.NameTaken, AtId(id), id.StartsWith('+') ? null : id, "id=\"" + name + "\" is already the name of k=\"" + owner + "\" in " + reading.Root, "id=\"" + free + "\"");
                }
                taken[name] = id;
            }
        }

        // HTML_DELETE_IN_USE: an element removed while something outside the removed elements uses it.
        private void CheckDeletes()
        {
            var gone = new HashSet<int>();
            foreach (var id in deleted) if (Index(id) is var i and >= 0) foreach (var d in m.Descendants(i).Append(i)) gone.Add(d);
            // Moves are applied before deletes. A retained descendant (and its internal records)
            // leaves the removed wrapper; its external consumers remain valid.
            var authored = model.Elements.Keys.Select(id => (Id: id, Index: Index(id))).Where(p => p.Index >= 0)
                .GroupBy(p => p.Index).ToDictionary(g => g.Key, g => g.First().Id);
            foreach (var index in gone.ToArray()) {
                for (var owner = index; owner >= 0; owner = m.parent[owner]) {
                    if (!authored.TryGetValue(owner, out var id)) continue;
                    if (!deleted.Contains(id)) gone.Remove(index);
                    break;
                }
            }
            foreach (var id in deleted) {
                if (recreated.Contains(id) || TopDeleted(id) != id) continue;
                var i = Index(id);
                if (i < 0) continue;
                var uses = m.UsesOutside(i, gone, state.Root);
                if (uses.Count > 0)
                    Problem(ScreenHtmlEdit.DeleteInUse, AtId(modelParents.GetValueOrDefault(id).Parent ?? ""), id, "k=\"" + id + "\" (" + model.Elements[id].Kind + ") is removed but used by: " + string.Join("; ", uses.Take(6)),
                        "keep it, or change those uses in the same job first");
            }
        }

        private string TopDeleted(string id)
        {
            var top = id;
            for (var p = modelParents.GetValueOrDefault(id).Parent; p != null && p.Length > 0; p = modelParents.TryGetValue(p, out var up) ? up.Parent : null)
                if (deleted.Contains(p)) top = p;
            return top;
        }
        private int Index(string id) => keys.TryGetValue(id, out var objectKey) && byKey.TryGetValue(objectKey, out var i) ? i : -1;
        // The node of an element of the reading, or what replaced it when a move took it (the platform's move gives a moved subtree
        // new objects: an element kept inside a moved one is ordered by its replacement; receipts 8c6b8a09, 957a76d6, eb130d25 and
        // four more of 12-19/10, "k=\"w19\" holds a widget the edit does not write").
        private T? Existing(string keyId) => Index(keyId) is var i and >= 0 ? movedNodes.GetValueOrDefault(i) ?? m.nodes[i] : null;

        // ---- apply ------------------------------------------------------------------------------------------------------
        private readonly Dictionary<string, T> objects = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Shape> newShapes = new(StringComparer.Ordinal);
        // The runs of the edited page by container (element id + segment) and position among its tokens: their nodes.
        private readonly Dictionary<(string Id, int Token), T> runs = [];
        // The runs of the reading kept in place (set or unchanged): edited (id, token) -> the k~n of the reading.
        private readonly Dictionary<(string Id, int Token), string> keptRuns = [];
        private IScreenHtmlWriter<T> w = null!;

        // Writes the plan. Every native move runs in order; the first one that fails stops the plan with its problem (the caller
        // rolls the model back).
        public void Apply(IScreenHtmlWriter<T> writer)
        {
            if (Refused) throw new InvalidOperationException("ssam-html edit: a refused plan is not applied");
            w = new Scoped(writer, this);
            var sw = Stopwatch.StartNew();
            try {
                Create("");
                StudioClasses();    // F2 (D1 of 2026-10-17): the class of every new widget without class, read on the widget just created
                // The facts of new elements are decoded with the shapes of what was created (types, native events, slots).
                EngineText(true);   // CX17 review 3, M6: what the plan writes is the text with the markers the engine decided
                if (newShapes.Count > 0) {
                    var shapes = new Dictionary<string, Shape>(state.Shapes, StringComparer.Ordinal);
                    foreach (var (id, shape) in newShapes) shapes[id] = shape;
                    Decode(shapes);
                    CheckNames();
                    CheckLiterals(created: true);
                    CheckProperties(created: true);
                    CheckPlatformProperties(created: true);
                    CheckArguments(created: true);
                    if (Refused) { EngineText(false); return; }
                }
                Result.EditedHtml = ScreenHtmlText.Write(merged);
                EngineText(false);
                // A name let go (id="") is cleared before any element takes a name: a name moved to another element is free when
                // that one takes it, whatever their order in the text (the platform renames a duplicate in silence, which the Verify
                // then refuses: the move of the review of round 2, A2).
                foreach (var (id, element) in edited.Elements)
                    if (!IsNew(id) && !recreated.Contains(id) && element.Facts.GetValueOrDefault("p:Name") == "t:" && !IsData(element.Kind) && !ScreenHtmlTables.FixedName(element.Kind)
                        && element.Kind is not ("os-opaque" or "Content") && model.Elements.GetValueOrDefault(id)?.Facts.GetValueOrDefault("p:Name") is { Length: > 2 }) {
                        current = id;
                        SetFact(id, element.Kind, "p:Name", "t:", element);
                        namesLetGo.Add(id);
                    }
                foreach (var (id, element) in edited.Elements) Facts(id, element);
                foreach (var (id, element) in edited.Elements) if (!IsNew(id) && model.Elements.ContainsKey(id)) Runs(id, element);
                foreach (var id in edited.Elements.Keys.Where(moved.Contains).OrderBy(Depth)) Move(id);
                foreach (var id in deleted.Where(id => TopDeleted(id) == id).OrderBy(id => id, StringComparer.Ordinal)) Delete(id);
                foreach (var (id, element) in edited.Elements) Order(id, element);
                // A widget placed in a grid takes the width and margin the platform gives it there: what the edit created or
                // moved is read again and its properties written once more where they are not the edit's.
                // F2: the platform's move recreates the moved element and its subtree (ModelServices.MoveObject), which takes the
                // properties it gives a widget where it now sits (a Width, a MarginLeft): everything inside a moved element is settled
                // to what the edit says too, so the module read again is the edited text (the effective value of every property).
                foreach (var (id, element) in edited.Elements)
                    if ((IsNew(id) || moved.Contains(id) || InsideMoved(id) || factsWritten.Contains(id) && id.Length > 0) && element.Kind is not ("os-opaque" or "Content" or "PlaceholderContentWidget") && !IsData(element.Kind)) Settle(id, element);
                // Every widget created or moved, and what moved with it, has its events at the default of where it now sits.
                foreach (var (id, element) in edited.Elements)
                    if ((IsNew(id) || InsideMoved(id)) && element.Kind is not ("os-opaque" or "Content" or "PlaceholderContentWidget") && !IsData(element.Kind) && id.Length > 0) SettleEvents(id, element);
            } catch (Exception error) when (error is not OutOfMemoryException) {
                // Goal list of 2026-10-20, item 7 (reports 6bd23d43, 9540e92c; 25 HTML_EDIT_NOT_APPLIED in 21 deliveries) and F2: the
                // element the platform refused, by its k, kind and name, the property (a set), what the platform said, and what to
                // do when the refusal is one it knows.
                var element = current != null && edited.Elements.TryGetValue(current, out var e) ? e : null;
                var where = currentElement != null && edited.Elements.TryGetValue(currentElement, out var at)
                    ? " on " + Describe(currentElement, at) : current != null ? " on k=\"" + current + "\"" : " on a new element";
                var reason = error.GetBaseException().Message;
                var next = "nothing was kept; " + (NameRefused(reason) ? NameFix(currentElement) : Hint(error, currentOp, currentElement));
                var refused = Problem(ScreenHtmlEdit.NotApplied, null, current, "the platform refused " + (currentOp ?? "a move") + where + ": " + reason, next);
                if (refused != null) {
                    if (currentOp is { } op && op.StartsWith("set ", StringComparison.Ordinal) && element != null) {
                        // The attribute as the edit wrote it and as the reading has it (the readable text, never a key nor the
                        // platform's words, which the message carries).
                        var property = op[4..];
                        var attribute = ScreenHtmlTables.AttributeOf(element.Kind, property, IsData(element.Kind) ? ScreenHtmlModuleMode.Data : ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                        refused["property"] = property; refused["attribute"] = attribute;
                        refused["expected"] = (current != null && idNodes.TryGetValue(current, out var written) ? written.Get(attribute) : null) ?? "absent (the default)";
                        refused["actual"] = (current != null ? ReadNode(current)?.Get(attribute) : null) ?? "absent (the default)";
                    }
                    if (element != null) refused["kind"] = element.Kind;
                    refused["next"] = next;
                }
            } finally { Result.ApplyMs = sw.Elapsed.TotalMilliseconds; }
        }
        private string? current, currentOp, currentElement;
        private static string Describe(string id, ScreenHtmlCanon.Element element)
        {
            var name = element.Facts.GetValueOrDefault("p:Name");
            return element.Kind + (name != null && name.Length > 2 ? " '" + name[2..] + "'" : "") + (id.StartsWith('+') ? " (new)" : " k=\"" + id + "\"");
        }

        // Every native move goes through this: the node it writes is an element of the edited root (or one the plan created,
        // or a part of one, such as an argument or an event), never anything outside the screen or block. A write that would
        // leave it stops the plan (nothing is kept): an edit changes its own screen only, so no ObjectKey elsewhere moves.
        private sealed class Scoped(IScreenHtmlWriter<T> inner, EditPlan plan) : IScreenHtmlWriter<T>
        {
            private readonly HashSet<T> made = new(ReferenceEqualityComparer.Instance);
            private T Mine(T node, string what)
            {
                if (made.Contains(node)) return node;
                var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
                for (T? up = node; up != null && seen.Add(up); up = plan.m.r.ParentOf(up)) {
                    if (made.Contains(up)) return node;
                    if (plan.m.at.TryGetValue(up, out var i)) {
                        if (i == plan.state.Root || plan.m.root[i] == plan.state.Root) return node;
                        // A node the walk knows outside this root (another screen, the module): refused.
                        if (plan.m.role[i] is not ("action" or "event")) break;
                    }
                }
                throw new InvalidOperationException("the edit would " + what + " " + plan.m.r.KindOf(node) + " '" + plan.m.r.DisplayOf(node) + "' outside " + plan.reading.Root);
            }
            public T Create(T parent, string kind, T? block, string? name = null) { var node = inner.Create(Mine(parent, "create under"), kind, block, name); made.Add(node); foreach (var c in plan.m.r.ChildrenOf(node)) made.Add(c); return node; }
            public void Set(T node, string property, ScreenHtmlValue<T> value) => inner.Set(Mine(node, "set " + property + " of"), property, value);
            public void Rename(T node, string name) => inner.Rename(Mine(node, "rename"), name);
            public void Delete(T node) => inner.Delete(Mine(node, "delete"));
            public T Move(T node, T parent) { var moved = inner.Move(Mine(node, "move"), Mine(parent, "move into")); made.Add(moved); return moved; }
            public void Place(T node, T? after) => inner.Place(Mine(node, "reorder"), after);
            public T? Replacement(T node) => inner.Replacement(node);
        }

        private static string Hint(Exception error, string? op = null, string? id = null)
        {
            var reason = error.GetBaseException().Message;
            if (error.GetBaseException() is KeyNotFoundException) return "check the names the edit uses";
            if (op != null && op.StartsWith("set ", StringComparison.Ordinal) && reason.Contains("read-only", StringComparison.OrdinalIgnoreCase))
                return "that property is read-only on this element: leave it as the reading shows it";
            return "correct that element and send the edit again";
        }

        // L3d, relato 6bd23d43 ("Widget does not support name changing"): the platform names some widgets only at their creation
        // or by itself. The edit names every new widget at its creation and never names a slot (20/10); no kind of the fixtures
        // (O11 Reactive and Traditional, ODC) refuses the rename of a widget of the reading (24/10). When one does: the name it
        // has stays, or the widget is created again with the name, which is safe only when nothing outside the page uses it.
        private static bool NameRefused(string reason) => reason.Contains("does not support name", StringComparison.OrdinalIgnoreCase);
        private string NameFix(string? id)
        {
            var element = id != null ? edited.Elements.GetValueOrDefault(id) : null;
            var name = element?.Facts.GetValueOrDefault("p:Name") is { Length: > 2 } named ? named[2..] : null;
            if (id == null || id.StartsWith('+') || IsStructural(id))
                return "the platform names this widget itself: send it without id" + (name != null ? " (\"" + name + "\")" : "") + "; a new widget takes the name the edit gives it at its creation";
            var read = model.Elements.GetValueOrDefault(id)?.Facts.GetValueOrDefault("p:Name") is { Length: > 2 } was ? was[2..] : null;
            var keep = "keep the name the reading shows: send k=\"" + id + "\" " + (read != null ? "with id=\"" + read + "\"" : "without id");
            return m.UsedOutside(reading, id)
                ? "the platform does not rename this widget, and something outside the page uses it: " + keep
                : "the platform does not rename this widget: " + keep + ", or create it again with the name (write it without k and with id=\"" + name + "\" in its place: a new widget takes its name at its creation; nothing outside the page uses k=\"" + id + "\")";
        }

        private int Depth(string id) { var d = 0; for (var p = editedParents.GetValueOrDefault(id).Parent; p != null && p.Length > 0; p = editedParents.TryGetValue(p, out var up) ? up.Parent : null) d++; return d; }

        private T Obj(string id) => objects.TryGetValue(id, out var o) ? o : Existing(id) ?? throw new InvalidOperationException("no node for " + id);

        // The node that holds the widgets of an element (segment self, true, false) or a slot or content group.
        private T Container(string id, string segment)
        {
            if (segment is "slot" or "content") return Obj(id);
            if (!IsNew(id)) {
                if (id.Length == 0) return Existing("")!;
                if (segment == "true" && Existing(id + ".true") is { } yes) return yes;
                if (segment == "false" && Existing(id + ".false") is { } no) return no;
                if (Existing(id + ".content") is { } content) return content;
                // An HTML Element of O11 keeps its widgets in its Content, which the reading does not list (the API lists
                // them as its children).
                var own = Obj(id);
                if (m.r.PropertyOf(own, "Content")?.Invoke() is T held && !ReferenceEquals(held, own)) return held;
                return own;
            }
            var node = Obj(id);
            if (segment is "true" or "false") return m.r.PropertyOf(node, segment == "true" ? "TrueBranch" : "FalseBranch")?.Invoke() as T ?? throw new InvalidOperationException("the new If has no " + segment + " branch");
            // The widgets of an element live in its Content when it has one (an HTML Element in O11, most containers in ODC).
            if (m.r.PropertyOf(node, "Content")?.Invoke() is T inner && !ReferenceEquals(inner, node)) return inner;
            var contents = m.r.ChildrenOf(node).Where(c => m.r.KindOf(c) == "Content").ToList();
            return contents.Count == 1 ? contents[0] : node;
        }

        // New elements, from the root down, with the runs they hold.
        private void Create(string id)
        {
            if (!edited.Elements.TryGetValue(id, out var element)) return;
            var segment = element.Kind == "IfWidget" ? "true" : "self";
            for (var t = 0; t < element.Children.Count; t++) {
                var token = element.Children[t];
                if (token == "else") { segment = "false"; continue; }
                if (token.StartsWith("s:", StringComparison.Ordinal)) { Create(id + "/" + token[2..]); continue; }
                if (token.StartsWith("c:", StringComparison.Ordinal)) { Create(id + "/content:" + token[2..]); continue; }
                if (token.StartsWith("t:", StringComparison.Ordinal) || token.StartsWith("x:", StringComparison.Ordinal)) {
                    if (IsNew(id)) runs[(id, t)] = NewRun(Container(id, segment), token, id);
                    continue;
                }
                var child = token[2..];
                if (IsNew(child)) {
                    current = child.StartsWith('+') ? null : child; currentElement = child;
                    var kind = edited.Elements[child].Kind;
                    T? block = null;
                    if (kind is "MobileBlockInstanceWidget" or "WebBlockInstanceWidget") {
                        var name = idNodes[child].Get("name") ?? "";
                        if (!m.TryResolveBlock(name, state.Scope, out var target) || m.IndexOf(target) is not (var bi and >= 0))
                            throw new InvalidOperationException("no block named '" + name + "' for a new <Block> (several: name it Kind:Name, Owner.Name or @key)");
                        block = m.nodes[bi];
                    }
                    currentOp = "create " + kind;
                    // The name the edit gives a new widget goes with its creation (a block instance refuses a later set Name:
                    // "Widget does not support name changing", 21 tasks of the survey of 19/10, live again on 20/10).
                    var given = edited.Elements[child].Facts.GetValueOrDefault("p:Name") is { Length: > 2 } named && named[1] == ':' && named[0] != '?' ? named[2..] : null;   // the fact's type is the shape's (a new element: 'e')
                    var node = w.Create(Container(id, segment), kind, block, given);
                    if (given != null) namedAtCreation.Add(child);
                    objects[child] = node;
                    // The rows of a new native Table (its HeaderRow and Row, whatever the platform calls them): the groups of its text.
                    if (kind == "TableRecords")
                        foreach (var row in new[] { "HeaderRow", "Row" })
                            if (m.r.PropertyOf(node, row)?.Invoke() is T held) objects[child + "/content:" + row] = held;
                    var created = new JsonObject { ["op"] = "create", ["k"] = child.StartsWith('+') ? null : child, ["kind"] = kind, ["parent"] = id.Length == 0 ? reading.Root : id };
                    if (given != null) created["name"] = given;   // the name it was created with (namedAtCreation), said in the plan
                    Result.Ops.Add(created);
                    if (recreated.Contains(child)) Result.KeyChanged.Add(new JsonObject { ["k"] = child, ["from"] = keys.GetValueOrDefault(child), ["why"] = "its element changed (" + model.Elements[child].Kind + " -> " + kind + ")" });
                    newShapes[child] = ShapeOfNew(node, kind);
                    if (kind is "MobileBlockInstanceWidget" or "WebBlockInstanceWidget") Slots(child, node);
                }
                Create(child);
            }
        }

        private T NewRun(T container, string token, string owner)
        {
            var expression = token[0] == 'x';
            currentOp = "create " + (expression ? "Expression" : "TextWidget");
            var run = w.Create(container, expression && reading.RootKind is "WebScreen" or "WebBlock" ? "ExpressionWidget" : expression ? "Expression" : "TextWidget", null);
            w.Set(run, expression ? "Value" : "Text", new ScreenHtmlValue<T>(expression ? 'e' : 't', token[2..]));
            Result.Ops.Add(new JsonObject { ["op"] = "create", ["kind"] = expression ? "Expression" : "TextWidget", ["parent"] = owner.Length == 0 ? reading.Root : owner, ["value"] = token[2..] });
            return run;
        }

        // The role a node created by the edit is read with, as the reading reads it: a new <var>, <input> or <aggregate> is not a
        // widget, so its derived Type is no fact of it (relatos e2891d6b, e21fa130 of 22-23/10: read as a widget, the new variable
        // carried a Type the text does not write, and the plan "reset" it with a set Type the platform has no setter for).
        private string RoleOfNew(T node)
        {
            var role = ModuleIndex.Roles[ModuleIndex.RoleOf(m.r.KindOf(node), new HashSet<string>(m.r.KindNamesOf(node), StringComparer.Ordinal))];
            return role is "parameter" or "variable" or "aggregate" ? role : "widget";
        }

        // The shape of a node created by the edit: what the decoder needs to read its attributes back (types, native events).
        private Shape ShapeOfNew(T node, string kind)
        {
            var shape = new Shape { Kind = kind };
            var children = new HashSet<T>(m.r.ChildrenOf(node), ReferenceEqualityComparer.Instance);
            var facts = m.FactsOf(node, RoleOfNew(node), "new " + kind, children, m.r.ParentOf(node), _ => false, shape, [], out var pointers);
            foreach (var (property, target) in pointers) {
                var targetKind = m.r.KindOf(target);
                var role = ModuleIndex.Roles[ModuleIndex.RoleOf(targetKind, new HashSet<string>(m.r.KindNamesOf(target), StringComparer.Ordinal))];
                if (role != "event") continue;
                shape.NativeEvents[EventAttribute(property)] = property;
                var eventShape = new Shape { Kind = targetKind };
                m.FactsOf(target, "event", "new event", new HashSet<T>(m.r.ChildrenOf(target), ReferenceEqualityComparer.Instance), node, _ => false, eventShape, [], out _);
                shape.EventTypes["ev:" + property] = eventShape.Types;
            }
            return shape;
        }

        // The slots of a new block instance: a node and a shape for each placeholder of its block, by name.
        private void Slots(string id, T instance)
        {
            foreach (var slot in m.r.ChildrenOf(instance).Where(c => m.r.KindOf(c) == "PlaceholderContentWidget")) {
                var shape = new Shape { Kind = "PlaceholderContentWidget" };
                var facts = m.FactsOf(slot, "widget", "new slot", new HashSet<T>(m.r.ChildrenOf(slot), ReferenceEqualityComparer.Instance), instance, _ => false, shape, [], out _);
                var placeholder = facts.FirstOrDefault(f => f.Name == "Placeholder").Text ?? "";
                var name = m.IndexOf(placeholder) is var p and >= 0 ? m.display[p] : placeholder.StartsWith('~') ? placeholder[(placeholder.IndexOf(':') + 1)..] : m.r.DisplayOf(slot);
                if (name.Contains('@')) name = name[..name.IndexOf('@')];
                shape.SlotName = name; shape.SlotPlaceholder = placeholder;
                objects[id + "/" + name] = slot;
                newShapes[id + "/" + name] = shape;
            }
        }

        // ---- F2 on the widgets the edit creates (the owner's decision D1 of 2026-10-17; M1 of the review of the CX17 merge) ------
        /// <summary>Every widget the edit creates without k and without class is born with the class the Studio gave the widget it
        /// just created, or with its trimmed form: ScreenVisual.StudioClassOf, the one rule of the forms that create a widget (the
        /// document form, these edit forms, the fragment; not the page form). The class goes in the text the plan decodes and writes as an attribute of
        /// the engine (as the markers: the checks and the patches read the author's text), so a trim is written once, a kept class
        /// not at all, the Verify reads it back and the edited text carries it; each is said in normalized (STYLE_STUDIO_CLASS_KEPT /
        /// STYLE_STUDIO_CLASS_TRIMMED, counted per kind). An element with k keeps the class its text says, the author's class
        /// always wins, and no marker comes with it (a screen made in the Studio gets the class of the new widget only).</summary>
        private void StudioClasses()
        {
            var notes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            foreach (var (id, _) in objects.ToList()) {
                if (!id.StartsWith('+') || IsStructural(id) || !idNodes.TryGetValue(id, out var node) || !edited.Elements.TryGetValue(id, out var element)) continue;
                var kind = element.Kind;
                if (Anvil.Core.ScreenVisual.DecisionFor(kind) == null) continue;
                var reverse = ScreenHtmlTables.Reverse(kind, ScreenHtmlModuleMode.Widget);
                if (node.Attributes.Any(a => a.Key == "os-Style" || reverse.GetValueOrDefault(a.Key) == "Style")) continue;   // the author's class
                var born = CurrentFacts(id, kind).GetValueOrDefault("p:Style") is { Length: > 1 } fact && fact[0] == 'e' ? fact[2..] : "";
                if (Anvil.Core.ScreenVisual.StudioClassOf(kind, born) is not { } studio) continue;
                var attribute = new KeyValuePair<string, string>(ScreenHtmlTables.AttributeOf(kind, "Style", ScreenHtmlModuleMode.Widget, false), ScreenHtml.Sugar(studio.Expression));
                var at = engineMarks.FindIndex(e => ReferenceEquals(e.Node, node));
                if (at >= 0) {
                    var engine = new List<KeyValuePair<string, string>>(engineMarks[at].Engine) { attribute };
                    engineMarks[at] = (node, engineMarks[at].Author, engine);
                }
                else engineMarks.Add((node, node.Attributes.ToList(), new List<KeyValuePair<string, string>>(node.Attributes) { attribute }));
                if (Anvil.Core.ScreenVisual.CountStudioClass(notes, studio, "a new " + studio.Kind + " at line " + node.Line.ToString(CultureInfo.InvariantCulture)) is { } note)
                    Result.Normalized.Add(note);
            }
        }

        // ---- facts --------------------------------------------------------------------------------------------------------
        private void Facts(string id, ScreenHtmlCanon.Element element)
        {
            if (element.Kind is "os-opaque" or "Content") return;
            var isNew = IsNew(id);
            var before = isNew ? CurrentFacts(id, element.Kind) : model.Elements.GetValueOrDefault(id)?.Facts ?? new SortedDictionary<string, string>(StringComparer.Ordinal);
            if (!isNew && !model.Elements.ContainsKey(id)) return;
            if (element.Kind == "PlaceholderContentWidget" && IsStructural(id)) {
                // A slot: its own properties only (os-*), never its placeholder, and never its name, the placeholder's (the Studio
                // names the slots of a new instance after their placeholders; a text that changes one is HTML_NAME_FIXED). The facts
                // a new slot is born with are read as the reading reads a slot (WriteSlot): its Placeholder and its Name are no
                // property of the text, so neither is written back empty.
                current = id.StartsWith('+') ? null : id; currentElement = id;   // a refusal of a slot names the slot
                foreach (var fact in element.Facts.Keys.Union(before.Keys).Where(f => f.StartsWith("p:", StringComparison.Ordinal) && f is not ("p:Name" or "p:Placeholder")).ToList())
                    if (element.Facts.GetValueOrDefault(fact) != before.GetValueOrDefault(fact)) SetFact(id, element.Kind, fact, element.Facts.GetValueOrDefault(fact), element);
                return;
            }
            var node = Obj(id);
            current = id.StartsWith('+') ? null : id; currentElement = id;
            // Plain properties (p:), text, block arguments (a:), extended properties (x:), events (ev:, h:, hev:).
            foreach (var fact in element.Facts.Keys.Union(before.Keys).Where(f => f.StartsWith("p:", StringComparison.Ordinal) || f == "text").Distinct().OrderBy(PropertyOrder).ThenBy(f => f, StringComparer.Ordinal).ToList()) {
                var now = element.Facts.GetValueOrDefault(fact); var was = before.GetValueOrDefault(fact);
                if (now == was) continue;
                // F2: a value the element already has, by its effective value (the default written explicitly where the reading
                // leaves it out, the class names of the same class), is no change: nothing is written, so the native value stays
                // as it is (an element never set keeps no value, never the Studio's default written over it).
                if (!isNew && fact.StartsWith("p:", StringComparison.Ordinal) && SameEffective(id, element.Kind, fact, now, was)) continue;
                if (fact == "p:SourceBlock" && isNew) continue;
                // An element keeps the name it has when its text writes none: the one the platform gives a new widget it must name (an
                // input), the one an element with k was read with (Div16, the name the html op generated: the edit of 2026-10-18 that
                // left the ids out wrote Name ""). A name the Studio does not let change is never written (HTML_NAME_FIXED).
                if (fact == "p:Name" && (now == null || ScreenHtmlTables.FixedName(element.Kind) || namesLetGo.Contains(id) || namedAtCreation.Contains(id))) continue;   // one given at creation is already there (the read-back verifies it)
                SetFact(id, element.Kind, fact, now, element);
            }
            var arguments = element.Facts.Keys.Union(before.Keys).Where(f => f.StartsWith("a:", StringComparison.Ordinal)).Distinct().ToList();
            foreach (var fact in arguments) {
                var now = element.Facts.GetValueOrDefault(fact) ?? ""; var was = before.GetValueOrDefault(fact) ?? "";
                if (now == was) continue;
                currentOp = "argument " + fact[2..];
                var argument = Child(node, "Argument", a => ArgumentName(a) == fact[2..]) ?? throw new InvalidOperationException("the block of k=\"" + id + "\" has no input " + fact[2..] + " (inputs: " + string.Join(", ", m.r.ChildrenOf(node).Where(c => m.r.KindOf(c) == "Argument").Select(ArgumentName).Where(n => n.Length > 0).Order(StringComparer.Ordinal)) + ")");
                Write(argument, "Value", new ScreenHtmlValue<T>('e', now), id, fact);
            }
            Extended(id, node, element, before);
            foreach (var prefix in Prefixes(element.Facts).Union(Prefixes(before)).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList()) Event(id, node, prefix, element.Facts, before);
        }
        private void Settle(string id, ScreenHtmlCanon.Element element)
        {
            // An element that moved with its parent: its node now is the replacement the move gave it; one that stayed, its own.
            if (!objects.ContainsKey(id) && Index(id) is var at and >= 0 && movedNodes.TryGetValue(at, out var replacement)) objects[id] = replacement;
            var node = objects.TryGetValue(id, out var made) ? made : Existing(id);
            if (node == null) return;
            var now = CurrentFacts(id, element.Kind, node);
            foreach (var fact in element.Facts.Keys.Where(f => f.StartsWith("p:", StringComparison.Ordinal)).Union(now.Keys.Where(f => f.StartsWith("p:", StringComparison.Ordinal))).ToList()) {
                // The stylesheet of a root is the root's (never settled: the platform formats it, which the Verify allows).
                if (fact is "p:SourceBlock" or "p:StyleSheet" || fact == "p:Placeholder" && element.Kind == "PlaceholderContentWidget" || fact == "p:Name" && (!element.Facts.ContainsKey(fact) || namedAtCreation.Contains(id)) || element.Facts.GetValueOrDefault(fact) == now.GetValueOrDefault(fact)) continue;
                // F2: a reference of what moved (a label's for=, a destination) is the platform's to rewire: its move points every
                // consumer at the recreated object (Reparent proves each one follows), so the edit never writes the old target back.
                if (!IsNew(id) && (element.Facts.GetValueOrDefault(fact) ?? now.GetValueOrDefault(fact)) is { Length: >= 2 } reference && reference[0] is 'r' or 'l') continue;
                if (SameEffective(id, element.Kind, fact, element.Facts.GetValueOrDefault(fact), now.GetValueOrDefault(fact))) continue;
                current = id.StartsWith('+') ? null : id;
                SetFact(id, element.Kind, fact, element.Facts.GetValueOrDefault(fact), element);
            }
        }
        private static int PropertyOrder(string fact) => fact switch { "p:Tag" => 0, "p:SourceBlock" => 1, "p:Name" => 2, _ => 5 };

        // F2: the elements whose properties the plan wrote. A property of one may move another one of the same element (a Width
        // the platform answers with the MarginLeft it gives that width): they are settled to the edit's effective values at the end.
        private readonly HashSet<string> factsWritten = new(StringComparer.Ordinal);
        private void SetFact(string id, string kind, string fact, string? value, ScreenHtmlCanon.Element element)
        {
            factsWritten.Add(id);
            var node = Obj(id);
            if (fact == "text") { Write(node, "Text", new ScreenHtmlValue<T>('t', value ?? ""), id, fact); return; }
            var property = fact[2..];
            if (property == "Name" && IsData(kind)) {
                currentOp = "rename " + kind;
                w.Rename(node, value?[2..] ?? "");
                Result.Ops.Add(new JsonObject { ["op"] = "rename", ["k"] = id, ["to"] = value?[2..] });
                return;
            }
            Write(node, property, Value(value, kind, property, element.Raw.GetValueOrDefault(fact)), id, fact);
        }

        // The value to write for a fact (type:text), or the default of the property when the edit dropped it.
        private ScreenHtmlValue<T> Value(string? fact, string kind, string property, string? raw, bool inPopup = false)
        {
            if (fact == null) {
                var type = model.Elements.Values.SelectMany(e => e.Facts).Where(f => f.Key == "p:" + property).Select(f => f.Value[0]).FirstOrDefault('e');
                var shapeType = state.Shapes.Values.FirstOrDefault(s => s.Kind == kind && s.Types.ContainsKey(property))?.Types[property] ?? type;
                if (property == "Transition") shapeType = 'v';
                if (shapeType is 'r' or '?') return new ScreenHtmlValue<T>('?', "");
                if (shapeType == 'l') return new ScreenHtmlValue<T>('l', "", Targets: []);
                return new ScreenHtmlValue<T>(shapeType, Defaults.DefaultOf(kind, property, shapeType, inPopup));
            }
            var t = fact[0]; var text = fact.Length > 2 ? fact[2..] : "";
            if (t == 'r') return Reference(text, raw);
            if (t == 'l') {
                var targets = new List<T>(); var names = new List<string>();
                foreach (var one in text.Split('\n', StringSplitOptions.RemoveEmptyEntries)) {
                    if (m.IndexOf(one) is var i and >= 0) targets.Add(m.nodes[i]); else names.Add(OutsideName(one));
                }
                return new ScreenHtmlValue<T>('l', text, Targets: targets, Name: names.Count > 0 ? string.Join("\n", names) : null);
            }
            return new ScreenHtmlValue<T>(t, text);
        }
        private ScreenHtmlValue<T> Reference(string id, string? raw)
        {
            if (id.StartsWith('?')) throw new InvalidOperationException("'" + id[1..] + "' names nothing");
            if (m.IndexOf(id) is var i and >= 0) return new ScreenHtmlValue<T>('r', id, m.nodes[i], Name: raw ?? m.display[i]);
            return new ScreenHtmlValue<T>('r', id, Name: raw ?? OutsideName(id));
        }
        private static string OutsideName(string id)
        {
            var name = id.StartsWith('~') ? id[(id.IndexOf(':') + 1)..] : id;
            return name.Contains('@') ? name[..name.IndexOf('@')] : name;
        }

        private void Write(T node, string property, ScreenHtmlValue<T> value, string id, string fact)
        {
            currentOp = "set " + property;
            w.Set(node, property, value);
            Result.Ops.Add(new JsonObject { ["op"] = "set", ["k"] = id.StartsWith('+') ? null : id, ["property"] = fact.StartsWith("p:", StringComparison.Ordinal) ? fact[2..] : fact,
                ["value"] = value.Type == '?' ? null : value.Name != null && value.Type is 'r' ? value.Name : value.Text });
        }

        // What a node created by the edit carries before its facts are written (the platform's defaults it was born with).
        private SortedDictionary<string, string> CurrentFacts(string id, string kind, T? of = null)
        {
            var facts = new SortedDictionary<string, string>(StringComparer.Ordinal);
            if ((of ?? objects.GetValueOrDefault(id)) is not { } node) return facts;
            var shape = new Shape { Kind = kind };
            var read = m.FactsOf(node, RoleOfNew(node), "new " + kind, new HashSet<T>(m.r.ChildrenOf(node), ReferenceEqualityComparer.Instance), m.r.ParentOf(node), _ => false, shape, [], out _);
            if (kind == "TextWidget") { var text = read.FirstOrDefault(f => f.Name == "Text"); read.RemoveAll(f => f.Name == "Value" && text.Name != null && f.Text == text.Text); }
            foreach (var f in read) {
                if (ScreenHtmlModule<T>.IsDefault(Defaults, kind, f) || f.Name == "Style" && f.Type == 't' && Writer.Redundant(read, f)) continue;
                if (kind == "TextWidget" && f.Name == "Text") { facts["text"] = f.Text; continue; }
                if (kind == "List" && f.Name == "Tag") { if (f.Text != "div") facts["p:Tag"] = "t:" + f.Text; continue; }
                facts["p:" + f.Name] = f.Type + ":" + f.Text;
            }
            if (kind == "AdvancedHtml" && !facts.ContainsKey("p:Tag")) facts["p:Tag"] = "t:";
            return facts;
        }

        private T? Child(T node, string kind, Func<T, bool> accept) => m.r.ChildrenOf(node).FirstOrDefault(c => m.r.KindOf(c) == kind && accept(c));
        private string ArgumentName(T argument)
        {
            var parameter = m.r.PropertyOf(argument, "Parameter")?.Invoke();
            return parameter is T p ? m.r.DisplayOf(p) : parameter?.ToString() ?? "";
        }

        // Extended properties: an ordered list, written in place.
        private void Extended(string id, T node, ScreenHtmlCanon.Element element, SortedDictionary<string, string> before)
        {
            var now = element.Facts.Where(f => f.Key.StartsWith("x:", StringComparison.Ordinal)).OrderBy(f => f.Key, StringComparer.Ordinal).Select(f => f.Value).ToList();
            var was = before.Where(f => f.Key.StartsWith("x:", StringComparison.Ordinal)).OrderBy(f => f.Key, StringComparer.Ordinal).Select(f => f.Value).ToList();
            if (now.SequenceEqual(was)) return;
            var existing = ExtendedNodes(node);
            for (var i = 0; i < Math.Max(now.Count, was.Count); i++) {
                var (np, nv) = i < now.Count ? Split(now[i]) : (null, null);
                var (op, ov) = i < was.Count ? Split(was[i]) : (null, null);
                if (np != null && op != null) {
                    if (np != op) Write(existing[i], "Property", new ScreenHtmlValue<T>('t', np), id, "x:" + np);
                    if (nv != ov) Write(existing[i], "Value", new ScreenHtmlValue<T>('e', nv!), id, "x:" + np);
                } else if (np != null) {
                    currentOp = "create ExtendedProperty";
                    var created = w.Create(node, "ExtendedProperty", null);
                    Result.Ops.Add(new JsonObject { ["op"] = "create", ["k"] = id.StartsWith('+') ? null : id, ["kind"] = "ExtendedProperty", ["property"] = np });
                    Write(created, "Property", new ScreenHtmlValue<T>('t', np), id, "x:" + np);
                    Write(created, "Value", new ScreenHtmlValue<T>('e', nv!), id, "x:" + np);
                } else {
                    currentOp = "delete ExtendedProperty";
                    w.Delete(existing[i]);
                    Result.Ops.Add(new JsonObject { ["op"] = "delete", ["k"] = id.StartsWith('+') ? null : id, ["kind"] = "ExtendedProperty", ["property"] = op });
                }
            }
            static (string, string) Split(string value) { var nl = value.IndexOf('\n'); return (value[..nl], value[(nl + 1)..]); }
        }
        private List<T> ExtendedNodes(T node)
        {
            var children = m.r.ChildrenOf(node).Where(c => m.r.KindOf(c) == "ExtendedProperty").ToList();
            if (m.r.PropertyOf(node, "ExtendedProperties")?.Invoke() is IEnumerable ordered and not string) {
                var list = ordered.OfType<T>().Where(children.Contains).ToList();
                return [.. list, .. children.Where(c => !list.Contains(c))];
            }
            return children;
        }

        // Events: a native event (ev:<Property>, the event object the widget points at), a block handler (h:<Event>) or an HTML
        // event (hev:<name>, created and removed with its attribute): the destination, then the arguments and properties.
        private static IEnumerable<string> Prefixes(IDictionary<string, string> facts)
        {
            foreach (var fact in facts.Keys) {
                if (!(fact.StartsWith("ev:", StringComparison.Ordinal) || fact.StartsWith("h:", StringComparison.Ordinal) || fact.StartsWith("hev:", StringComparison.Ordinal))) continue;
                var cut = fact.IndexOf(":a:", StringComparison.Ordinal); if (cut < 0) cut = fact.IndexOf(":p:", StringComparison.Ordinal);
                yield return cut < 0 ? fact : fact[..cut];
            }
        }

        private void Event(string id, T node, string prefix, IDictionary<string, string> now, IDictionary<string, string> was)
        {
            var mine = now.Where(f => f.Key == prefix || f.Key.StartsWith(prefix + ":", StringComparison.Ordinal)).OrderBy(f => f.Key, StringComparer.Ordinal).ToList();
            var old = was.Where(f => f.Key == prefix || f.Key.StartsWith(prefix + ":", StringComparison.Ordinal)).OrderBy(f => f.Key, StringComparer.Ordinal).ToList();
            if (mine.SequenceEqual(old)) return;
            var name = prefix[(prefix.IndexOf(':') + 1)..];
            T? evt = prefix.StartsWith("ev:", StringComparison.Ordinal) ? m.r.PropertyOf(node, name)?.Invoke() as T
                : prefix.StartsWith("h:", StringComparison.Ordinal) ? Child(node, "EventHandler", h => HandlerEventName(h) == name)
                : Child(node, "Event", e => (m.r.PropertyOf(e, "Event")?.Invoke() as string) == name);
            if (mine.Count == 0 && prefix.StartsWith("hev:", StringComparison.Ordinal) && evt != null) {
                currentOp = "delete event " + name;
                w.Delete(evt);
                Result.Ops.Add(new JsonObject { ["op"] = "delete", ["k"] = id.StartsWith('+') ? null : id, ["kind"] = "Event", ["event"] = name });
                return;
            }
            if (evt == null && prefix.StartsWith("hev:", StringComparison.Ordinal)) {
                currentOp = "create event " + name;
                evt = w.Create(node, "Event", null);
                Result.Ops.Add(new JsonObject { ["op"] = "create", ["k"] = id.StartsWith('+') ? null : id, ["kind"] = "Event", ["event"] = name });
                Write(evt, "Event", new ScreenHtmlValue<T>('t', name), id, prefix);
            }
            if (evt == null) throw new InvalidOperationException((IsNew(id) ? "the new element" : "k=\"" + id + "\"") + " has no event " + name);
            var destinationProperty = m.r.PropertyOf(evt, "Destination") != null ? "Destination" : "Handler";
            var destination = now.TryGetValue(prefix, out var d) ? d : "";
            var previous = was.TryGetValue(prefix, out var pd) ? pd : "";
            if (destination != previous)
                Write(evt, destinationProperty, destination.Length == 0 ? new ScreenHtmlValue<T>('?', "") : Reference(destination, null), id, prefix);
            // Every argument: the ones the edit gives, and the ones it dropped emptied (a new destination may have kept them).
            var given = mine.Where(f => f.Key.StartsWith(prefix + ":a:", StringComparison.Ordinal)).ToDictionary(f => f.Key[(prefix.Length + 3)..], f => f.Value, StringComparer.Ordinal);
            var arguments = m.r.ChildrenOf(evt).Where(c => m.r.KindOf(c) == "Argument").ToList();
            foreach (var argument in arguments) {
                var parameter = ArgumentName(argument);
                var value = given.GetValueOrDefault(parameter) ?? "";
                var written = Expression(argument);
                if (value != written) Write(argument, "Value", new ScreenHtmlValue<T>('e', value), id, prefix + ":a:" + parameter);
            }
            foreach (var parameter in given.Keys.Where(p => !arguments.Any(a => ArgumentName(a) == p)))
                throw new InvalidOperationException("the destination of " + prefix + " on " + (IsNew(id) ? "the new element" : "k=\"" + id + "\"") + " has no input " + parameter);
            foreach (var (fact, value) in mine.Where(f => f.Key.StartsWith(prefix + ":p:", StringComparison.Ordinal)))
                if (old.FirstOrDefault(o => o.Key == fact).Value != value) Write(evt, fact[(prefix.Length + 3)..], Value(value, m.r.KindOf(evt), fact[(prefix.Length + 3)..], null), id, fact);
            // A property the edit dropped goes back to its default where the element sits (inside a Popup: the Popup's Transition).
            foreach (var (fact, _) in old.Where(f => f.Key.StartsWith(prefix + ":p:", StringComparison.Ordinal) && !now.ContainsKey(f.Key)))
                Write(evt, fact[(prefix.Length + 3)..], Value(null, m.r.KindOf(evt), fact[(prefix.Length + 3)..], null, InPopup(id)), id, fact);
        }

        // Whether a fact the edit wrote (a property of the element, p:X, or of one of its events, ev:E:p:X) holds the default of that
        // property where the element sits (ScreenDefaults: inside a Popup an event's Transition is what the Studio gives it there).
        private bool WrittenDefault(string id, string kind, string fact, string? value)
        {
            if (value is not { Length: > 1 } || value[1] != ':') return false;
            if (fact.StartsWith("p:", StringComparison.Ordinal))
                return Defaults.DefaultOf(kind, fact[2..], value[0], false) == value[2..];
            if (fact.StartsWith("ev:", StringComparison.Ordinal) && fact.IndexOf(":p:", 3, StringComparison.Ordinal) is var at and > 3)
                return Defaults.DefaultOf(EventKind(id, fact[3..at]), fact[(at + 3)..], value[0], InPopup(id)) == value[2..];
            return false;
        }

        // The kind of the native event an element holds under that property (OnClick: a BuiltinEvent on ODC, a UILifeCycleEvent on
        // O11), as the model has it; "" when the element or the event is gone.
        private string EventKind(string id, string property)
        {
            try { return m.r.PropertyOf(Obj(id), property)?.Invoke() is T evt ? m.r.KindOf(evt) : ""; }
            catch (Exception) { return ""; }
        }

        // Whether an element of the edited page is a Popup or sits inside one (through slots and contents).
        private bool InPopup(string id)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (string? p = id; p != null && seen.Add(p); p = editedParents.TryGetValue(p, out var up) ? up.Parent : null)
                if (edited.Elements.TryGetValue(p, out var e) && e.Kind == "Popup") return true;
            return false;
        }

        // The native events of a widget the edit created or moved, at the default of where it now sits (a Transition the edit does
        // not write: inside a Popup the Popup's, elsewhere the table's), as a widget the Studio creates there has them.
        private void SettleEvents(string id, ScreenHtmlCanon.Element element)
        {
            var node = objects.TryGetValue(id, out var made) ? made : Index(id) is var at and >= 0 ? movedNodes.GetValueOrDefault(at) ?? m.nodes[at] : null;
            if (node == null) return;
            var inPopup = InPopup(id);
            var shape = new Shape();
            m.FactsOf(node, "widget", "settle", new HashSet<T>(m.r.ChildrenOf(node), ReferenceEqualityComparer.Instance), m.r.ParentOf(node), _ => false, shape, [], out var pointers);
            foreach (var (property, evt) in pointers) {
                var eventKind = m.r.KindOf(evt);
                var role = ModuleIndex.Roles[ModuleIndex.RoleOf(eventKind, new HashSet<string>(m.r.KindNamesOf(evt), StringComparer.Ordinal))];
                if (role != "event") continue;
                var fact = "ev:" + property + ":p:Transition";
                if (element.Facts.ContainsKey(fact)) continue;
                var eventShape = new Shape();
                var facts = m.FactsOf(evt, "event", "settle event", new HashSet<T>(m.r.ChildrenOf(evt), ReferenceEqualityComparer.Instance), node, _ => false, eventShape, [], out _);
                if (!eventShape.Types.ContainsKey("Transition")) continue;
                var now = facts.FirstOrDefault(f => f.Name == "Transition");
                var wanted = Defaults.DefaultOf(eventKind, "Transition", 'v', inPopup);
                if ((now.Name == null ? "" : now.Text) == wanted || now.Name == null && wanted.Length == 0) continue;
                current = id.StartsWith('+') ? null : id;
                Write(evt, "Transition", new ScreenHtmlValue<T>('v', wanted), id, fact);
            }
        }
        private string HandlerEventName(T handler)
        {
            var target = m.r.PropertyOf(handler, "Event")?.Invoke();
            return target is T t ? m.r.DisplayOf(t) : target?.ToString() ?? "";
        }
        private string Expression(T node)
        {
            var value = m.r.PropertyOf(node, "Value")?.Invoke();
            return value == null ? "" : m.r.ExpressionText(value) ?? value.ToString() ?? "";
        }

        // ---- runs of an element that stays ------------------------------------------------------------------------------
        // The runs of each segment: equal runs stay; a changed one in the same place (same kind) is set; the rest are removed
        // and created. A kept run keeps its key.
        private void Runs(string id, ScreenHtmlCanon.Element element)
        {
            var before = model.Elements[id];
            foreach (var segment in Segments(element.Kind)) {
                var old = RunTokens(before, segment, true); var now = RunTokens(element, segment, false);
                if (old.Count == 0 && now.Count == 0) continue;
                var lcs = Lcs(old.Select(o => o.Token).ToList(), now.Select(n => n.Token).ToList());
                var keptOld = new HashSet<int>(lcs.Select(p => p.A)); var keptNew = new HashSet<int>(lcs.Select(p => p.B));
                foreach (var (a, b) in lcs) keptRuns[(id, now[b].Index)] = id + "~" + old[a].Ordinal.ToString(CultureInfo.InvariantCulture);
                // Between two kept runs, the unmatched old and new runs pair up in order when they are of the same kind: set.
                var gapsOld = Gaps(old.Count, lcs.Select(p => p.A).ToList()); var gapsNew = Gaps(now.Count, lcs.Select(p => p.B).ToList());
                for (var g = 0; g < gapsOld.Count; g++) {
                    var go = gapsOld[g]; var gn = gapsNew[g];
                    for (var i = 0; i < Math.Min(go.Count, gn.Count); i++) {
                        var o = old[go[i]]; var n = now[gn[i]];
                        if (o.Token[0] != n.Token[0]) continue;
                        var runKey = id + "~" + o.Ordinal.ToString(CultureInfo.InvariantCulture);
                        var node = Existing(runKey) ?? throw new InvalidOperationException("no run " + runKey);
                        Write(node, n.Token[0] == 'x' ? "Value" : "Text", new ScreenHtmlValue<T>(n.Token[0] == 'x' ? 'e' : 't', n.Token[2..]), id, "run");
                        keptOld.Add(go[i]); keptNew.Add(gn[i]);
                        keptRuns[(id, n.Index)] = runKey;
                    }
                }
                for (var i = 0; i < old.Count; i++) {
                    if (keptOld.Contains(i)) continue;
                    var runKey = id + "~" + old[i].Ordinal.ToString(CultureInfo.InvariantCulture);
                    currentOp = "delete run";
                    w.Delete(Existing(runKey) ?? throw new InvalidOperationException("no run " + runKey));
                    Result.Ops.Add(new JsonObject { ["op"] = "delete", ["k"] = id.Length == 0 ? null : id, ["kind"] = old[i].Token[0] == 'x' ? "Expression" : "TextWidget", ["value"] = old[i].Token[2..] });
                }
                for (var i = 0; i < now.Count; i++) {
                    if (keptNew.Contains(i)) continue;
                    runs[(id, now[i].Index)] = NewRun(Container(id, segment), now[i].Token, id);
                }
            }
        }
        private static string[] Segments(string kind) => kind == "IfWidget" ? ["true", "false"] : ["self"];
        // The runs of one segment: their token, their position among the element's tokens and, in the reading, their ordinal k~n.
        private static List<(string Token, int Index, int Ordinal)> RunTokens(ScreenHtmlCanon.Element element, string segment, bool reading)
        {
            var list = new List<(string, int, int)>();
            var current = element.Kind == "IfWidget" ? "true" : "self";
            var ordinal = 0;
            for (var t = 0; t < element.Children.Count; t++) {
                var token = element.Children[t];
                if (token == "else") { current = "false"; continue; }
                if (!(token.StartsWith("t:", StringComparison.Ordinal) || token.StartsWith("x:", StringComparison.Ordinal))) continue;
                if (current == segment) list.Add((token, t, ordinal));
                ordinal++;
            }
            return list;
        }
        private static List<(int A, int B)> Lcs(List<string> a, List<string> b)
        {
            var table = new int[a.Count + 1, b.Count + 1];
            for (var i = a.Count - 1; i >= 0; i--)
                for (var j = b.Count - 1; j >= 0; j--)
                    table[i, j] = a[i] == b[j] ? table[i + 1, j + 1] + 1 : Math.Max(table[i + 1, j], table[i, j + 1]);
            var pairs = new List<(int, int)>();
            for (int i = 0, j = 0; i < a.Count && j < b.Count;) {
                if (a[i] == b[j]) { pairs.Add((i, j)); i++; j++; }
                else if (table[i + 1, j] >= table[i, j + 1]) i++; else j++;
            }
            return pairs;
        }
        private static List<List<int>> Gaps(int count, List<int> anchors)
        {
            var gaps = new List<List<int>> { new() };
            var next = 0;
            for (var i = 0; i < count; i++) {
                if (next < anchors.Count && anchors[next] == i) { gaps.Add([]); next++; continue; }
                gaps[^1].Add(i);
            }
            return gaps;
        }

        // ---- moves and deletes --------------------------------------------------------------------------------------------
        private void Move(string id)
        {
            current = id;
            var node = Obj(id);
            var (parent, segment) = editedParents[id];
            var target = Container(parent, segment);
            var subtree = new List<T> { node };
            var stack = new Stack<T>(); stack.Push(node);
            while (stack.TryPop(out var n)) foreach (var c in m.r.ChildrenOf(n)) { subtree.Add(c); stack.Push(c); }
            currentOp = "move";
            var now = w.Move(node, target);
            var replaced = new Dictionary<T, T>(ReferenceEqualityComparer.Instance);
            foreach (var old in subtree) if (w.Replacement(old) is { } replacement && !ReferenceEquals(replacement, old)) replaced[old] = replacement;
            if (!ReferenceEquals(now, node)) replaced[node] = now;
            foreach (var key in objects.Keys.ToList()) if (replaced.TryGetValue(objects[key], out var r)) objects[key] = r;
            foreach (var key in runs.Keys.ToList()) if (replaced.TryGetValue(runs[key], out var r)) runs[key] = r;
            foreach (var (old, replacement) in replaced) {
                if (m.at.TryGetValue(old, out var i)) movedNodes[i] = replacement;
                // A reference to a moved object (a label's TargetWidget, an event's destination) follows it to its new key.
                if (m.r.KeyOf(old) is { Length: > 0 } was && m.r.KeyOf(replacement) is { Length: > 0 } now2 && was != now2) replacedKeys[was] = now2;
            }
            objects[id] = now;
            Result.Ops.Add(new JsonObject { ["op"] = "move", ["k"] = id, ["into"] = parent.Length == 0 ? reading.Root : parent, ["segment"] = segment });
            if (replaced.Count > 0) Result.KeyChanged.Add(new JsonObject { ["k"] = id, ["from"] = keys.GetValueOrDefault(id), ["to"] = m.r.KeyOf(now), ["why"] = "moved into another parent (the platform's move gives it and its subtree new keys)", ["objects"] = replaced.Count });
        }
        // Nodes of the reading replaced by a move (their reading index -> the new object), and their keys (old -> new).
        private readonly Dictionary<int, T> movedNodes = [];
        private readonly Dictionary<string, string> replacedKeys = new(StringComparer.Ordinal);

        // A fact of the edit with every reference to an object a move replaced written with the new key.
        private string? Followed(string? fact)
        {
            if (fact == null || replacedKeys.Count == 0) return fact;
            if (fact.StartsWith("r:", StringComparison.Ordinal)) return "r:" + replacedKeys.GetValueOrDefault(fact[2..], fact[2..]);
            if (fact.StartsWith("l:", StringComparison.Ordinal))
                return "l:" + string.Join("\n", fact[2..].Split('\n').Select(id => replacedKeys.GetValueOrDefault(id, id)).Order(StringComparer.Ordinal));
            return replacedKeys.GetValueOrDefault(fact, fact);
        }

        private void Delete(string id)
        {
            current = id;
            if (Index(id) is not (var i and >= 0)) throw new InvalidOperationException("no node for " + id);
            var node = movedNodes.GetValueOrDefault(i) ?? m.nodes[i];
            currentOp = "delete " + model.Elements[id].Kind;
            w.Delete(node);
            Result.Ops.Add(new JsonObject { ["op"] = "delete", ["k"] = id, ["kind"] = model.Elements[id].Kind });
        }

        // ---- order: each container holds exactly the edited children, in the edited order --------------------------------
        private void Order(string id, ScreenHtmlCanon.Element element)
        {
            if (element.Kind is "os-opaque") return;
            current = id.StartsWith('+') ? null : id; currentElement = id;
            var isNew = IsNew(id) || id.StartsWith('+');
            var before = model.Elements.GetValueOrDefault(id);
            var segment = element.Kind == "IfWidget" ? "true" : "self";
            var desired = new Dictionary<string, List<T>> { [segment] = [] };
            var touched = isNew || before == null || !before.Children.SequenceEqual(element.Children, StringComparer.Ordinal)
                || element.Children.Any(t => t.StartsWith("k:", StringComparison.Ordinal) && (moved.Contains(t[2..]) || IsNew(t[2..])));
            if (!touched) return;
            for (var t = 0; t < element.Children.Count; t++) {
                var token = element.Children[t];
                if (token == "else") { segment = "false"; desired[segment] = []; continue; }
                if (token.StartsWith("s:", StringComparison.Ordinal) || token.StartsWith("c:", StringComparison.Ordinal)) continue;
                T node;
                if (token.StartsWith("k:", StringComparison.Ordinal)) {
                    var child = token[2..];
                    if (IsData(edited.Elements[child].Kind)) continue;
                    node = Obj(child);
                } else if (runs.TryGetValue((id, t), out var run)) node = run;
                else if (keptRuns.TryGetValue((id, t), out var runKey)) node = Index(runKey) is var ri and >= 0 ? movedNodes.GetValueOrDefault(ri) ?? m.nodes[ri] : throw new InvalidOperationException("no run " + runKey);
                else throw new InvalidOperationException("no node for a run of " + (id.Length == 0 ? reading.Root : id));
                desired[segment].Add(node);
            }
            if (element.Kind == "IfWidget" && !desired.ContainsKey("false")) desired["false"] = [];
            foreach (var (seg, list) in desired) {
                var container = Container(id, seg);
                var children = m.r.ChildrenOf(container).Where(c => IsWidget(c)).ToList();
                var wanted = new HashSet<T>(list, ReferenceEqualityComparer.Instance);
                foreach (var extra in children.Where(c => !wanted.Contains(c)).ToList()) {
                    if (!isNew) throw new InvalidOperationException((id.Length == 0 ? reading.Root : "k=\"" + id + "\"") + " holds a widget the edit does not write (" + m.r.KindOf(extra) + ")");
                    currentOp = "delete " + m.r.KindOf(extra);
                    w.Delete(extra);
                    Result.Ops.Add(new JsonObject { ["op"] = "delete", ["kind"] = m.r.KindOf(extra), ["why"] = "created with the new element, not in the edit" });
                    children.Remove(extra);
                }
                foreach (var missing in list.Where(n => !children.Contains(n)))
                    throw new InvalidOperationException((id.Length == 0 ? reading.Root : "k=\"" + id + "\"") + " does not hold a " + m.r.KindOf(missing) + " the edit puts there");
                var positions = list.Select(n => children.IndexOf(n)).ToList();
                var keep = Increasing(positions);
                for (var i = 0; i < list.Count; i++) {
                    if (keep.Contains(i)) continue;
                    currentOp = "place";
                    w.Place(list[i], i == 0 ? null : list[i - 1]);
                    Result.Ops.Add(new JsonObject { ["op"] = "place", ["kind"] = m.r.KindOf(list[i]), ["in"] = id.Length == 0 ? reading.Root : id, ["at"] = i });
                }
            }
        }
        private bool IsWidget(T node)
        {
            var kindName = m.r.KindOf(node);
            if (kindName is "Content" or "IfBranchWidget" or "PlaceholderContentWidget" or "ExtendedProperty" or "Argument" or "EventHandler" or "Event") return false;
            // The rows of a native Table (O11 lists its HeaderRow and Row as MobileWidgets of it): its contents, as a Content is.
            if (IsTableRow(node)) return false;
            var role = ModuleIndex.Roles[ModuleIndex.RoleOf(kindName, new HashSet<string>(m.r.KindNamesOf(node), StringComparer.Ordinal))];
            return role == "widget";
        }
        private bool IsTableRow(T node) =>
            m.r.ParentOf(node) is T table && m.r.KindOf(table) == "TableRecords"
            && (ReferenceEquals(m.r.PropertyOf(table, "HeaderRow")?.Invoke(), node) || ReferenceEquals(m.r.PropertyOf(table, "Row")?.Invoke(), node));
        // The positions of the longest increasing subsequence: the children that stay where they are.
        private static HashSet<int> Increasing(List<int> values)
        {
            var n = values.Count; var length = new int[n]; var previous = new int[n]; var best = -1;
            for (var i = 0; i < n; i++) {
                length[i] = 1; previous[i] = -1;
                for (var j = 0; j < i; j++) if (values[j] < values[i] && length[j] + 1 > length[i]) { length[i] = length[j] + 1; previous[i] = j; }
                if (best < 0 || length[i] > length[best]) best = i;
            }
            var keep = new HashSet<int>();
            for (var i = best; i >= 0; i = previous[i]) keep.Add(i);
            return keep;
        }

        // ---- verify: the module read again gives the edited text -----------------------------------------------------------
        // Element by element from the root: kinds, facts, children (runs by value) and the keys of everything the edit kept.
        public void Verify(ScreenHtmlDocument after)
        {
            var sw = Stopwatch.StartNew();
            Result.After = after;
            try {
                var read = after.Canon;
                afterReading = after;
                var readKeys = after.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
                var differences = new List<string>();
                var queue = new Queue<(string E, string R)>(); queue.Enqueue(("", ""));
                var keyed = new HashSet<string>(StringComparer.Ordinal);
                while (queue.TryDequeue(out var pair) && differences.Count < 20) {
                    var (e, r) = pair;
                    if (!edited.Elements.TryGetValue(e, out var want)) { differences.Add("no element " + e + " in the edit"); continue; }
                    if (!read.Elements.TryGetValue(r, out var got)) { differences.Add(Where(e) + ": not read back"); continue; }
                    if (want.Kind != got.Kind) { differences.Add(Where(e) + ": " + want.Kind + " read back as " + got.Kind); continue; }
                    foreach (var fact in want.Facts.Keys.Union(got.Facts.Keys).Distinct()) {
                        var a = want.Facts.GetValueOrDefault(fact); var b = got.Facts.GetValueOrDefault(fact);
                        if (a == b || Followed(a) == b) continue;
                        // The name of a slot (an If branch, a Content) is the Studio's: Facts never writes it, and a text that asks for
                        // another one was refused before anything was written (HTML_NAME_FIXED). Its placeholder's name, written or not,
                        // reads back absent (review of round 2, A3: os-Name="Previous" passed the plan and failed here); os-Name="" (a
                        // lane whose slots have a null Name) reads back as the name the Studio gave, said in normalized.
                        if (fact == "p:Name" && ScreenHtmlTables.FixedName(want.Kind)) {
                            var slotName = e[(e.LastIndexOf('/') + 1)..];
                            string? Own(string? v) => v == "t:" + slotName ? null : v;
                            if (Own(a) != Own(b))
                                Result.Normalized.Add(new JsonObject { ["k"] = e.StartsWith('+') ? null : e, ["property"] = "Name", ["value"] = b is { Length: > 2 } ? b[2..] : slotName,
                                    ["note"] = "the name of a slot is the Studio's (its placeholder's): never written" });
                            continue;
                        }
                        // A value the edit wrote that is the default where the element sits reads back absent (a reading writes no
                        // default): the same value (os-onclick.Transition="Fade" inside a Popup, os-Visible="True").
                        if (b == null && WrittenDefault(e, want.Kind, fact, a)) continue;
                        // F2: the effective value, both ways: an absent property is its default where the element sits, and the type
                        // letter of a value is the decoder's (a number the reading had null decodes as an expression, 'e:51', and reads
                        // back as the value it is, 'v:51'). The same rule the reading writes with (ScreenHtmlModule.IsDefault).
                        if (SameEffective(e, want.Kind, fact, a, b)) continue;
                        // A new widget the platform must name (an input) takes the name it gives when the edit wrote none.
                        if (fact == "p:Name" && a == null && b != null && IsNew(e)) {
                            Result.Normalized.Add(new JsonObject { ["k"] = null, ["property"] = "Name", ["value"] = b[2..], ["note"] = "the platform named the new " + want.Kind + " (an id the edit did not write)" });
                            continue;
                        }
                        // An element with k whose text writes no name keeps the one it was read with (Facts writes none).
                        if (fact == "p:Name" && a == null && b != null && model.Elements.GetValueOrDefault(e)?.Facts.GetValueOrDefault("p:Name") == b) {
                            Result.Normalized.Add(new JsonObject { ["k"] = e, ["property"] = "Name", ["value"] = b.Length > 2 ? b[2..] : "", ["note"] = "kept the name it has: the edit wrote no id for it (an element with k keeps its name)" });
                            continue;
                        }
                        // The click of a new widget on a screen action takes the validations the platform gives it (ValidateAndContinue)
                        // when the edit wrote none: the fix the refusal of a script asks for (onclick="Save") is then written as is.
                        if (a == null && b != null && IsNew(e) && fact.StartsWith("ev:", StringComparison.Ordinal) && fact.EndsWith(":p:BuiltInValidations", StringComparison.Ordinal)) {
                            Result.Normalized.Add(new JsonObject { ["k"] = null, ["property"] = fact, ["value"] = b[2..], ["note"] = "the platform's validations of the new " + want.Kind + "'s event (the edit wrote none)" });
                            continue;
                        }
                        // A name in an expression has no case in OutSystems: the platform writes it as the module names it
                        // (Entities.ValuesType.DateTime is read back Entities.ValuesType.Datetime; receipts 1efb50cf, 3c3ec56b and
                        // b75f1c3e of 19/10). The same expression, said; a text literal keeps its case.
                        if (a != null && b != null && IsExpressionFact(fact, a) && SameButNameCase(a, b)) {
                            Result.Normalized.Add(new JsonObject { ["code"] = "NAME_CASE", ["k"] = IsNew(e) ? null : e, ["property"] = fact, ["from"] = a, ["to"] = b,
                                ["note"] = "the platform writes a name of an expression as the module names it (a name has no case)" });
                            continue;
                        }
                        if (fact == "p:StyleSheet" && a != null && b != null && Squeeze(a) == Squeeze(b)) { Result.Normalized.Add(new JsonObject { ["k"] = e, ["property"] = "StyleSheet", ["note"] = "the CSS was formatted (spaces and lines only)" }); continue; }
                        differences.Add(Difference(e, r, want.Kind, fact, a, b));
                    }
                    // Identity: what the edit kept keeps its key.
                    if (!IsNew(e) && !moved.Contains(e) && !InsideMoved(e) && !e.StartsWith('+') && keys.TryGetValue(e, out var was) && readKeys.TryGetValue(r, out var now) && was != now)
                        differences.Add(Where(e) + ": its ObjectKey changed (" + was + " -> " + now + ")");
                    var gotChildren = got.Children;
                    if (IsNew(e) && want.Kind is "MobileBlockInstanceWidget" or "WebBlockInstanceWidget") {
                        // The slots of a new block instance the edit did not write: the platform creates one per placeholder,
                        // empty (OutSystemsUIWeb's Modal has Title, Icon, Content and Footer; the edit of 20/10 wrote Content).
                        var written = new HashSet<string>(want.Children.Where(c => c.StartsWith("s:", StringComparison.Ordinal)), StringComparer.Ordinal);
                        var empty = got.Children.Where(c => c.StartsWith("s:", StringComparison.Ordinal) && !written.Contains(c)
                            && read.Elements.TryGetValue(r + "/" + c[2..], out var slot) && slot.Children.Count == 0).ToList();
                        if (empty.Count > 0) {
                            gotChildren = got.Children.Except(empty, StringComparer.Ordinal).ToList();
                            Result.Normalized.Add(new JsonObject { ["k"] = null, ["property"] = "slots", ["value"] = string.Join(", ", empty.Select(c => c[2..])),
                                ["note"] = "the empty slots of the new " + want.Kind + " the edit did not write (the platform creates one per placeholder)" });
                        }
                    }
                    if (want.Children.Count != gotChildren.Count) { differences.Add(Where(e) + ": " + gotChildren.Count + " children read back, the edit has " + want.Children.Count + " (" + Clip(string.Join(" ", gotChildren)) + ")"); continue; }
                    var ordinal = 0;
                    for (var i = 0; i < want.Children.Count; i++) {
                        string a = want.Children[i], b = gotChildren[i];
                        var run = a.StartsWith("t:", StringComparison.Ordinal) || a.StartsWith("x:", StringComparison.Ordinal);
                        if (run) {
                            if (a != b && a.StartsWith("x:", StringComparison.Ordinal) && b.StartsWith("x:", StringComparison.Ordinal) && SameButNameCase(a, b))
                                Result.Normalized.Add(new JsonObject { ["code"] = "NAME_CASE", ["k"] = IsNew(e) ? null : e, ["property"] = "run", ["from"] = a[2..], ["to"] = b[2..],
                                    ["note"] = "the platform writes a name of an expression as the module names it (a name has no case)" });
                            else if (a != b) differences.Add(Where(e) + ": run " + Show(b) + " read back, the edit has " + Show(a));
                            else if (keptRuns.TryGetValue((e, i), out var runKey) && !InsideMoved(e) && keys.TryGetValue(runKey, out var runWas)
                                && readKeys.TryGetValue(r + "~" + ordinal.ToString(CultureInfo.InvariantCulture), out var runNow) && runWas != runNow)
                                differences.Add(Where(e) + ": the run " + Show(a) + " changed its ObjectKey");
                            ordinal++;
                            continue;
                        }
                        if (a.StartsWith("k:", StringComparison.Ordinal) && b.StartsWith("k:", StringComparison.Ordinal)) { queue.Enqueue((a[2..], b[2..])); continue; }
                        // F2: an Expression or a Text with k whose edit left it nothing of its own but its value is the run the reading
                        // writes for it (an expression with nothing else is one line of its parent): the same element.
                        if (a.StartsWith("k:", StringComparison.Ordinal) && RunOf(a[2..]) is { } asRun && asRun == b) {
                            Result.Normalized.Add(new JsonObject { ["k"] = a[2..], ["note"] = "nothing of its own is left but its value: the reading writes it as a run of its parent (" + Clip(b) + ")" });
                            ordinal++;
                            continue;
                        }
                        if (a != b) { differences.Add(Where(e) + ": " + b + " read back, the edit has " + a); continue; }
                        if (a.StartsWith("s:", StringComparison.Ordinal)) queue.Enqueue((e + "/" + a[2..], r + "/" + a[2..]));
                        else if (a.StartsWith("c:", StringComparison.Ordinal)) queue.Enqueue((e + "/content:" + a[2..], r + "/content:" + a[2..]));
                    }
                }
                if (differences.Count > 0) {
                    // F2: every difference names its element, its property, what the edit expected and what the module has; when they
                    // are all properties the platform kept another value for, the one next call is the edit with those values.
                    // Only a value the edit may write (ScreenHtmlModule.Refusal) and that the text can say goes in it.
                    var kept = differenceFacts.Where(d => d["writable"]?.GetValue<bool>() == true).ToList();
                    var next = kept.Count == differences.Count
                        ? "nothing was kept; the platform keeps another value where the edit wrote one: send the edit again with " + string.Join(", ", kept.Take(6).Select(d =>
                            d["element"] + " " + (d["actual"] is JsonValue v && v.TryGetValue<string>(out var shown) ? d["attribute"] + "=\"" + shown + "\"" : "without " + d["attribute"])))
                        : "nothing was kept; this is a fault of the engine for this construction (report it with the edit)";
                    var problem = Problem(ScreenHtmlEdit.NotApplied, null, differenceFacts.FirstOrDefault()?["k"]?.ToString(), "the module read again is not the edited text: " + string.Join("; ", differences.Take(8)), next);
                    if (problem != null) {
                        problem["differences"] = new JsonArray(differenceFacts.Take(20).Select(d => (JsonNode)d.DeepClone()).ToArray());
                        problem["next"] = next;
                    }
                }
            } finally { Result.VerifyMs = sw.Elapsed.TotalMilliseconds; }
        }
        // F2: the facts of the differences the Verify found (element, kind, property, expected, actual).
        private readonly List<JsonObject> differenceFacts = [];
        private ScreenHtmlDocument? afterReading;
        private Dictionary<string, ScreenHtml.Node>? afterNodes;
        // The element of the module read again with that k (what the reading prints of it).
        private ScreenHtml.Node? AfterNode(string k)
        {
            if (afterNodes == null) {
                afterNodes = new Dictionary<string, ScreenHtml.Node>(StringComparer.Ordinal);
                try { if (afterReading != null) foreach (var (node, _) in ScreenHtmlText.Elements(ScreenHtml.Parse(afterReading.Html))) if (node.Get("k") is { } key) afterNodes.TryAdd(key, node); } catch (FormatException) { }
            }
            return afterNodes.GetValueOrDefault(k);
        }
        // A difference of the Verify in the reading's terms: the attribute as the edit wrote it and as the module read again prints it
        // (null: absent, the default), never a key, an outside name or a raw expression of the canonical form.
        private string Difference(string id, string readId, string kind, string fact, string? want, string? got)
        {
            if (!fact.StartsWith("p:", StringComparison.Ordinal)) return Where(id) + ": " + fact + " is " + Show(got) + ", the edit says " + Show(want);
            var property = fact[2..];
            var attribute = ScreenHtmlTables.AttributeOf(kind, property, IsData(kind) ? ScreenHtmlModuleMode.Data : ScreenHtmlModuleMode.Widget,
                edited.Elements.GetValueOrDefault(id)?.Facts.ContainsKey("p:StyleClasses") == true);
            var expected = idNodes.TryGetValue(id, out var written) ? written.Get(attribute) : null;
            var actual = AfterNode(readId)?.Get(attribute);
            // Whether the next may name it: the edit may write that value (the one rule of CheckProperties).
            var node = objects.TryGetValue(id, out var made) ? made : Index(id) is var at and >= 0 ? movedNodes.GetValueOrDefault(at) ?? m.nodes[at] : null;
            var writable = node != null && (got == null || ScreenHtmlModule<T>.Refusal(m.PropertiesOf(node), property, got, m.ListsEveryProperty) == null);
            static string Value(string? v) => v == null ? "absent (the default)" : "'" + Clip(v) + "'";
            differenceFacts.Add(new JsonObject { ["k"] = id.StartsWith('+') ? null : id, ["element"] = Where(id), ["kind"] = kind, ["property"] = property, ["attribute"] = attribute,
                ["expected"] = expected, ["actual"] = actual, ["writable"] = writable });
            return Where(id) + " (" + kind + "): " + attribute + " expected " + Value(expected) + ", actual " + Value(actual);
        }
        private bool SameEffective(string id, string kind, string fact, string? a, string? b)
        {
            // The class of an element is its list of class names: the F1 stylesheet touch (StyleSheetTouch: a trailing space toggled
            // in a Traditional Style, + "" on a reactive Style Classes) and the spaces between names change no class.
            if (fact is "p:Style" or "p:StyleClasses" && ClassTokens(a) is { } x && ClassTokens(b) is { } y && x == y) return true;
            if (fact.StartsWith("p:", StringComparison.Ordinal)) {
                var type = (a ?? b ?? "e:")[0];
                var @default = Defaults.DefaultOf(kind, fact[2..], type, false);
                return (a is { Length: >= 2 } ? a[2..] : @default) == (b is { Length: >= 2 } ? b[2..] : @default);
            }
            return a == null && b != null && WrittenDefault(id, kind, fact, b) || b == null && WrittenDefault(id, kind, fact, a);
        }
        // The class names of a Style fact (a text, or an expression that is one string literal, with the F1 touch's + "" taken off),
        // joined by one space; null for any other expression (compared as it is).
        internal static string? ClassTokens(string? fact)
        {
            if (fact == null) return "";
            if (fact.Length < 2 || fact[1] != ':') return null;
            var text = fact[2..].Trim();
            if (fact[0] == 'e') {
                while (text.EndsWith(" + \"\"", StringComparison.Ordinal)) text = text[..^5].TrimEnd();
                if (text.Length == 0) return "";
                if (text.Length < 2 || text[0] != '"' || text[^1] != '"' || text[1..^1].Contains('"')) return null;
                text = text[1..^1];
            } else if (fact[0] != 't') return null;
            return string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        }

        // The run an element of the edit reads back as when nothing of its own is left but its value (null: it keeps its element).
        private string? RunOf(string id)
        {
            if (!edited.Elements.TryGetValue(id, out var element) || element.Kind is not ("Expression" or "TextWidget") || element.Children.Count > 0) return null;
            var own = element.Facts.Where(f => !(f.Key is "p:Value" or "text" or "p:Text" or "p:Name" && (f.Key != "p:Name" || f.Value == "t:"))).ToList();
            if (own.Any(f => !SameEffective(id, element.Kind, f.Key, f.Value, null))) return null;
            if (element.Kind == "Expression") return element.Facts.TryGetValue("p:Value", out var v) && v.Length >= 2 ? "x:" + v[2..] : null;
            return element.Facts.TryGetValue("text", out var t) ? "t:" + t : null;
        }

        private bool InsideMoved(string id)
        {
            for (var p = id; p.Length > 0; p = editedParents.TryGetValue(p, out var up) ? up.Parent : "") {
                if (moved.Contains(p) || recreated.Contains(p)) return true;
                if (!editedParents.ContainsKey(p)) break;
            }
            return false;
        }
        private static string Squeeze(string text) => new(text.Where(c => !char.IsWhiteSpace(c)).ToArray());
        // An expression fact: an argument (a:, an event's :a:) or a property whose value is an expression (e:).
        private static bool IsExpressionFact(string fact, string value) =>
            fact.StartsWith("a:", StringComparison.Ordinal) || fact.Contains(":a:", StringComparison.Ordinal) || value.StartsWith("e:", StringComparison.Ordinal);
        // The same text but for the case of what is outside its text literals ("..." with "" inside).
        private static bool SameButNameCase(string a, string b)
        {
            if (a.Length != b.Length || a == b) return a == b;
            var literal = false;
            for (var i = 0; i < a.Length; i++) {
                if (a[i] == '"') literal = !literal;
                if (a[i] == b[i]) continue;
                if (literal || char.ToUpperInvariant(a[i]) != char.ToUpperInvariant(b[i])) return false;
            }
            return true;
        }
        private static string Where(string id) => id.Length == 0 ? "the root" : id.StartsWith('+') ? "a new element" : "k=\"" + id + "\"";
        private static string Show(string? value) => value == null ? "absent" : "'" + Clip(value) + "'";
        private static string Clip(string text) => text.Length > 80 ? text[..80] + "…" : text;
    }
}
