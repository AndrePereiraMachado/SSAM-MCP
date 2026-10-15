using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// C2 of the plan "Texto do SSAM" (ScreenHtmlEdit): the edit of one reading, planned over this module and applied through an
// IScreenHtmlWriter. The plan is the difference element by element (k) between the reading's canonical form and the edited
// text's; nothing outside the elements the edit changed is written.
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
    public EditPlan Edit(ScreenHtmlDocument reading, IReadOnlyList<string> edits, string pointer = "/edit") => new(this, reading, edits, pointer);

    // What uses the element at `index` (or anything under it) from outside the removed set `gone`: the paths, for
    // HTML_DELETE_IN_USE (and the battery, which removes only what nothing uses).
    internal List<string> UsesOutside(int index, HashSet<int> gone, int rootIndex)
    {
        var uses = new List<string>();
        foreach (var d in Descendants(index).Append(index)) {
            if (role[d] is not ("widget" or "variable" or "parameter")) continue;
            IEnumerable<T> referrers;
            try { referrers = r.ReferrersOf(nodes[d]).ToList(); } catch { continue; }
            foreach (var referrer in referrers) {
                if (at.TryGetValue(referrer, out var ri) && (gone.Contains(ri) || UnderAny(ri, gone))) continue;
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
    private bool UnderAny(int i, HashSet<int> set) { for (var p = parent[i]; p >= 0; p = parent[p]) if (set.Contains(p)) return true; return false; }
    private bool InsideGone(T node, HashSet<int> gone)
    {
        var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        for (var up = r.ParentOf(node); up != null && seen.Add(up); up = r.ParentOf(up))
            if (at.TryGetValue(up, out var i)) return gone.Contains(i) || UnderAny(i, gone);
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
        private readonly bool patches;
        private readonly Stopwatch clock = Stopwatch.StartNew();

        internal EditPlan(ScreenHtmlModule<T> m, ScreenHtmlDocument reading, IReadOnlyList<string> edits, string pointer, bool patches = true)
        {
            this.m = m; this.reading = reading; this.edits = edits; this.pointer = pointer; this.patches = patches;
            state = reading.State as ReadingState ?? throw new InvalidOperationException("ssam-html edit: the reading has no state of this module");
            Result.Root = reading.Root; Result.RootKey = reading.RootKey; Result.RootKind = reading.RootKind; Result.BasedOnHtml = reading.HtmlSha256;
            foreach (var (k, objectKey) in reading.Keys) keys[k] = objectKey;
            for (var i = 0; i < m.nodes.Count; i++)
                if ((m.root[i] == state.Root || i == state.Root) && m.key[i].Length > 0) byKey.TryAdd(m.key[i], i);
            model = reading.Canon;
            if (reading.RootKind is "WebScreen" or "WebBlock") { Problem("HTML_TRADITIONAL", null, null, reading.Root + " is a Traditional Web " + reading.RootKind + ": its widgets have no ssam-html/1 form before the D2 stage (they read as os-opaque)", "use the native verbs (ui.traditional-widget) for it"); return; }
            if (reading.Problems.Count > 0) { Problem(ScreenHtmlEdit.Invalid, null, null, "the reading of " + reading.Root + " has problems of its own: " + string.Join("; ", reading.Problems.Take(5)), "edit another screen; this one is read only"); return; }
            Merge();
            if (Refused) { Result.PlanMs = clock.Elapsed.TotalMilliseconds; return; }
            Normalize();
            if (Refused) { Result.PlanMs = clock.Elapsed.TotalMilliseconds; return; }
            Decode(state.Shapes);
            Result.EditedHtml = ScreenHtmlText.Write(merged);
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
        private readonly List<(ScreenHtml.Node Node, string Attribute, string Source, string? Alias)> iterations = [];
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

        // ---- decode -----------------------------------------------------------------------------------------------------
        private void Decode(Dictionary<string, Shape> shapes)
        {
            var decoder = new Decoder(m, state.Scope, shapes);
            edited = decoder.Run(merged);
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
        private bool IsData(string kind) => DataKinds.Contains(kind) || kind.StartsWith("os-", StringComparison.Ordinal) && kind != "os-opaque" || !ScreenHtml.WidgetTags.ContainsKey(kind) && kind is not ("List" or "AdvancedHtml" or "os-opaque" or "PlaceholderContentWidget" or "Content" or "MobileScreen" or "MobileBlock");

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
                var read = node.Get("k") is { } k ? ReadNode(k) : null;
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
                // The same event, said above with its element, its k and its fix.
                if (EventProblem.Match(problem) is { Success: true } said && scriptEvents.Contains(said.Groups[1].Value + "\u0001" + said.Groups[2].Value)) continue;
                var script = problem.Contains("is not Destination(", StringComparison.Ordinal) && LooksLikeScript(problem);
                Problem(script ? ScreenHtmlEdit.Script : ScreenHtmlEdit.Invalid, null, null, problem,
                    script ? "an event names its destination: onclick=\"Save\" or onclick=\"Open(Id = Row.Id)\"; JavaScript is not written in the page (logic is native)"
                    : "write the element as the reading writes it (ScreenHtml.Contract: elements, attributes, events)");
            }
            // Root: the actions are the logic text's.
            var root = edited.Elements.GetValueOrDefault("");
            if (root != null)
                foreach (var list in new[] { "actions", "data-actions" })
                    if (model.Elements[""].Facts.GetValueOrDefault(list) != root.Facts.GetValueOrDefault(list))
                        Problem(ScreenHtmlEdit.ActionsListed, AtId(""), null, "the " + list + " of " + reading.Root + " changed; the page lists them, the logic op creates, renames and removes them",
                            "leave " + list + " as read; a new screen action is a logic op in the same job (the page names it in its events)");
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
                else if (before != null && element.Kind == "MobileBlockInstanceWidget" && before.Facts.GetValueOrDefault("p:SourceBlock") != element.Facts.GetValueOrDefault("p:SourceBlock")) recreated.Add(id);
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
            CheckLiterals();
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
            if (!patches || visibleWraps == null && visibleVariants.Count == 0 && scriptElements.Count == 0 && scriptAttributes.Count == 0 && iterations.Count == 0) return;
            var withIterations = iterations.Count > 0;
            var corrected = WrapVisible(visibleWraps ?? [], withIterations);
            if (corrected == null && withIterations) { withIterations = false; corrected = WrapVisible(visibleWraps ?? [], false); }
            if (corrected == null) return;
            foreach (var problem in Result.Problems.Where(p => p["code"]?.ToString() == ScreenHtmlEdit.Visible
                         || corrections.TryGetValue(p, out var kind) && (kind is "script" or "visible" || kind == "iteration" && withIterations))) {
                problem["fix"] = problem["fix"] + " (the patch replaces the edit list with that)";
                problem["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = corrected.DeepClone() });
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
                foreach (var (node, attribute, restore) in scriptAttributes) {
                    var target = map[node];
                    var at = target.Attributes.FindIndex(a => a.Key == attribute);
                    if (at < 0) continue;
                    if (restore != null) target.Attributes[at] = new(attribute, restore); else target.Attributes.RemoveAt(at);
                }
                foreach (var node in scriptElements) {
                    var target = map[node];
                    if (roots.Contains(target) || !parents.TryGetValue(target, out var parent)) return null;   // the edit was the script alone
                    parent.Children.Remove(target);
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
                var check = new EditPlan(m, reading, texts, pointer, patches: false);
                bool Fixed(JsonObject p) => p["code"]?.ToString() == ScreenHtmlEdit.Visible
                    || corrections.TryGetValue(p, out var kind) && (kind is "script" or "visible" || kind == "iteration" && withIterations);
                var known = new HashSet<string>(Result.Problems.Where(p => !Fixed(p)).Select(Signature), StringComparer.Ordinal);
                return check.Result.Problems.Any(p => p["code"]?.ToString() == ScreenHtmlEdit.Visible || !known.Contains(Signature(p))) ? null
                    : new JsonArray(texts.Select(t => (JsonNode)t).ToArray());
            } catch (Exception) { return null; }
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
        private void CheckLiterals(bool created = false)
        {
            foreach (var (id, element) in edited.Elements) {
                var before = IsNew(id) ? null : model.Elements.GetValueOrDefault(id);
                foreach (var (fact, value) in element.Facts.ToList()) {
                    // Prose where an expression goes (two operands with no operator, …?!;): the platform never parses it; the
                    // attribute is named, with its string literal as the fix, before anything is written.
                    // (A new element's types are the model's only once it exists: its facts are judged after the create.)
                    if ((created || !IsNew(id)) && fact.StartsWith("p:", StringComparison.Ordinal) && value.StartsWith("e:", StringComparison.Ordinal) && !ScreenHtml.HoldsBraces(value[2..])
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
                    if ((created || !IsNew(id)) && fact.StartsWith("p:", StringComparison.Ordinal) && value.StartsWith("e:", StringComparison.Ordinal) && !ScreenHtml.HoldsBraces(value[2..])
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
                    if (ScreenHtml.HasBinding(text) && ScreenHtml.ConstantText(text) is { } constant) {
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

        private void CheckNewData()
        {
            foreach (var (id, element) in edited.Elements.Where(e => e.Key.StartsWith('+'))) {
                if (!IsData(element.Kind) || element.Kind is "InputParameter" or "LocalVariable") continue;
                Problem(ScreenHtmlEdit.DataNew, AtId(id), null, "a new <" + (idNodes.TryGetValue(id, out var n) ? n.Tag : element.Kind) + "> in an edit: aggregates, data actions and screen actions are created by the logic op",
                    "create it with a logic op in the same job; the page then names it");
            }
            // A widget name is unique in its screen: a new or renamed one takes a free name (the platform would rename it in silence).
            var taken = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (id, element) in model.Elements)
                if (!IsData(element.Kind) && element.Facts.TryGetValue("p:Name", out var name) && edited.Elements.TryGetValue(id, out var still) && !IsNew(id)
                    && still.Facts.GetValueOrDefault("p:Name") == name) taken[name[2..]] = id;
            foreach (var (id, element) in edited.Elements) {
                if (IsData(element.Kind) || !element.Facts.TryGetValue("p:Name", out var value)) continue;
                var name = value[2..];
                if (!IsNew(id) && model.Elements.GetValueOrDefault(id)?.Facts.GetValueOrDefault("p:Name") == value) continue;
                if (taken.TryGetValue(name, out var owner) && owner != id) {
                    var free = name; for (var n = 2; taken.ContainsKey(free); n++) free = name + n.ToString(CultureInfo.InvariantCulture);
                    Problem(ScreenHtmlEdit.NameTaken, AtId(id), id.StartsWith('+') ? null : id, "id=\"" + name + "\" is already the name of k=\"" + owner + "\" in " + reading.Root, "id=\"" + free + "\"");
                }
                taken[name] = id;
            }
        }

        // HTML_DELETE_IN_USE: an element removed while something outside the removed elements uses it.
        private void CheckDeletes()
        {
            var gone = new HashSet<int>();
            foreach (var id in deleted) if (Index(id) is var i and >= 0) foreach (var d in m.Descendants(i).Append(i)) gone.Add(d);
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
        private T? Existing(string keyId) => Index(keyId) is var i and >= 0 ? m.nodes[i] : null;

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
                // The facts of new elements are decoded with the shapes of what was created (types, native events, slots).
                if (newShapes.Count > 0) {
                    var shapes = new Dictionary<string, Shape>(state.Shapes, StringComparer.Ordinal);
                    foreach (var (id, shape) in newShapes) shapes[id] = shape;
                    Decode(shapes);
                    CheckNames();
                    CheckLiterals(created: true);
                    if (Refused) return;
                }
                Result.EditedHtml = ScreenHtmlText.Write(merged);
                foreach (var (id, element) in edited.Elements) Facts(id, element);
                foreach (var (id, element) in edited.Elements) if (!IsNew(id) && model.Elements.ContainsKey(id)) Runs(id, element);
                foreach (var id in edited.Elements.Keys.Where(moved.Contains).OrderBy(Depth)) Move(id);
                foreach (var id in deleted.Where(id => TopDeleted(id) == id).OrderBy(id => id, StringComparer.Ordinal)) Delete(id);
                foreach (var (id, element) in edited.Elements) Order(id, element);
                // A widget placed in a grid takes the width and margin the platform gives it there: what the edit created or
                // moved is read again and its properties written once more where they are not the edit's.
                foreach (var (id, element) in edited.Elements)
                    if ((IsNew(id) || moved.Contains(id)) && element.Kind is not ("os-opaque" or "Content" or "PlaceholderContentWidget") && !IsData(element.Kind)) Settle(id, element);
                // Every widget created or moved, and what moved with it, has its events at the default of where it now sits.
                foreach (var (id, element) in edited.Elements)
                    if ((IsNew(id) || InsideMoved(id)) && element.Kind is not ("os-opaque" or "Content" or "PlaceholderContentWidget") && !IsData(element.Kind) && id.Length > 0) SettleEvents(id, element);
            } catch (Exception error) when (error is not OutOfMemoryException) {
                Problem(ScreenHtmlEdit.NotApplied, null, current, "the platform refused " + (currentOp ?? "a move") + ": " + error.GetBaseException().Message, "nothing was kept; " + Hint(error));
            } finally { Result.ApplyMs = sw.Elapsed.TotalMilliseconds; }
        }
        private string? current, currentOp;

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
            public T Create(T parent, string kind, T? block) { var node = inner.Create(Mine(parent, "create under"), kind, block); made.Add(node); foreach (var c in plan.m.r.ChildrenOf(node)) made.Add(c); return node; }
            public void Set(T node, string property, ScreenHtmlValue<T> value) => inner.Set(Mine(node, "set " + property + " of"), property, value);
            public void Rename(T node, string name) => inner.Rename(Mine(node, "rename"), name);
            public void Delete(T node) => inner.Delete(Mine(node, "delete"));
            public T Move(T node, T parent) { var moved = inner.Move(Mine(node, "move"), Mine(parent, "move into")); made.Add(moved); return moved; }
            public void Place(T node, T? after) => inner.Place(Mine(node, "reorder"), after);
            public T? Replacement(T node) => inner.Replacement(node);
        }

        private static string Hint(Exception error) => error.GetBaseException() is KeyNotFoundException ? "check the names the edit uses" : "correct that element and send the edit again";

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
                    current = child.StartsWith('+') ? null : child;
                    var kind = edited.Elements[child].Kind;
                    T? block = null;
                    if (kind == "MobileBlockInstanceWidget") {
                        var name = idNodes[child].Get("name") ?? "";
                        if (!m.TryResolve(name, state.Scope, out var target) || m.IndexOf(target) is not (var bi and >= 0))
                            throw new InvalidOperationException("no block named '" + name + "' for a new <Block>");
                        block = m.nodes[bi];
                    }
                    currentOp = "create " + kind;
                    var node = w.Create(Container(id, segment), kind, block);
                    objects[child] = node;
                    Result.Ops.Add(new JsonObject { ["op"] = "create", ["k"] = child.StartsWith('+') ? null : child, ["kind"] = kind, ["parent"] = id.Length == 0 ? reading.Root : id });
                    if (recreated.Contains(child)) Result.KeyChanged.Add(new JsonObject { ["k"] = child, ["from"] = keys.GetValueOrDefault(child), ["why"] = "its element changed (" + model.Elements[child].Kind + " -> " + kind + ")" });
                    newShapes[child] = ShapeOfNew(node, kind);
                    if (kind == "MobileBlockInstanceWidget") Slots(child, node);
                }
                Create(child);
            }
        }

        private T NewRun(T container, string token, string owner)
        {
            var expression = token[0] == 'x';
            currentOp = "create " + (expression ? "Expression" : "TextWidget");
            var run = w.Create(container, expression ? "Expression" : "TextWidget", null);
            w.Set(run, expression ? "Value" : "Text", new ScreenHtmlValue<T>(expression ? 'e' : 't', token[2..]));
            Result.Ops.Add(new JsonObject { ["op"] = "create", ["kind"] = expression ? "Expression" : "TextWidget", ["parent"] = owner.Length == 0 ? reading.Root : owner, ["value"] = token[2..] });
            return run;
        }

        // The shape of a node created by the edit: what the decoder needs to read its attributes back (types, native events).
        private Shape ShapeOfNew(T node, string kind)
        {
            var shape = new Shape { Kind = kind };
            var children = new HashSet<T>(m.r.ChildrenOf(node), ReferenceEqualityComparer.Instance);
            var facts = m.FactsOf(node, "widget", "new " + kind, children, m.r.ParentOf(node), _ => false, shape, [], out var pointers);
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

        // ---- facts --------------------------------------------------------------------------------------------------------
        private void Facts(string id, ScreenHtmlCanon.Element element)
        {
            if (element.Kind is "os-opaque" or "Content") return;
            var isNew = IsNew(id);
            var before = isNew ? CurrentFacts(id, element.Kind) : model.Elements.GetValueOrDefault(id)?.Facts ?? new SortedDictionary<string, string>(StringComparer.Ordinal);
            if (!isNew && !model.Elements.ContainsKey(id)) return;
            if (element.Kind == "PlaceholderContentWidget" && IsStructural(id)) {
                // A slot: its own properties only (os-*), never its placeholder.
                foreach (var fact in element.Facts.Keys.Union(before.Keys).Where(f => f.StartsWith("p:", StringComparison.Ordinal)).ToList())
                    if (element.Facts.GetValueOrDefault(fact) != before.GetValueOrDefault(fact)) SetFact(id, element.Kind, fact, element.Facts.GetValueOrDefault(fact), element);
                return;
            }
            var node = Obj(id);
            current = id.StartsWith('+') ? null : id;
            // Plain properties (p:), text, block arguments (a:), extended properties (x:), events (ev:, h:, hev:).
            foreach (var fact in element.Facts.Keys.Union(before.Keys).Where(f => f.StartsWith("p:", StringComparison.Ordinal) || f == "text").Distinct().OrderBy(PropertyOrder).ThenBy(f => f, StringComparer.Ordinal).ToList()) {
                var now = element.Facts.GetValueOrDefault(fact); var was = before.GetValueOrDefault(fact);
                if (now == was) continue;
                if (fact == "p:SourceBlock" && isNew) continue;
                // The name the platform gives a new widget it must name (an input) stays when the edit writes none.
                if (fact == "p:Name" && isNew && now == null) continue;
                SetFact(id, element.Kind, fact, now, element);
            }
            var arguments = element.Facts.Keys.Union(before.Keys).Where(f => f.StartsWith("a:", StringComparison.Ordinal)).Distinct().ToList();
            foreach (var fact in arguments) {
                var now = element.Facts.GetValueOrDefault(fact) ?? ""; var was = before.GetValueOrDefault(fact) ?? "";
                if (now == was) continue;
                var argument = Child(node, "Argument", a => ArgumentName(a) == fact[2..]) ?? throw new InvalidOperationException("the block of k=\"" + id + "\" has no input " + fact[2..]);
                Write(argument, "Value", new ScreenHtmlValue<T>('e', now), id, fact);
            }
            Extended(id, node, element, before);
            foreach (var prefix in Prefixes(element.Facts).Union(Prefixes(before)).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToList()) Event(id, node, prefix, element.Facts, before);
        }
        private void Settle(string id, ScreenHtmlCanon.Element element)
        {
            if (!objects.ContainsKey(id)) return;
            var now = CurrentFacts(id, element.Kind);
            foreach (var fact in element.Facts.Keys.Where(f => f.StartsWith("p:", StringComparison.Ordinal)).Union(now.Keys.Where(f => f.StartsWith("p:", StringComparison.Ordinal))).ToList()) {
                if (fact == "p:SourceBlock" || fact == "p:Name" && !element.Facts.ContainsKey(fact) || element.Facts.GetValueOrDefault(fact) == now.GetValueOrDefault(fact)) continue;
                SetFact(id, element.Kind, fact, element.Facts.GetValueOrDefault(fact), element);
            }
        }
        private static int PropertyOrder(string fact) => fact switch { "p:Tag" => 0, "p:SourceBlock" => 1, "p:Name" => 2, _ => 5 };

        private void SetFact(string id, string kind, string fact, string? value, ScreenHtmlCanon.Element element)
        {
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
                return new ScreenHtmlValue<T>(shapeType, ScreenHtml.DefaultOf(kind, property, shapeType, inPopup));
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
        private SortedDictionary<string, string> CurrentFacts(string id, string kind)
        {
            var facts = new SortedDictionary<string, string>(StringComparer.Ordinal);
            if (!objects.TryGetValue(id, out var node)) return facts;
            var shape = new Shape { Kind = kind };
            var read = m.FactsOf(node, "widget", "new " + kind, new HashSet<T>(m.r.ChildrenOf(node), ReferenceEqualityComparer.Instance), m.r.ParentOf(node), _ => false, shape, [], out _);
            if (kind == "TextWidget") { var text = read.FirstOrDefault(f => f.Name == "Text"); read.RemoveAll(f => f.Name == "Value" && text.Name != null && f.Text == text.Text); }
            foreach (var f in read) {
                if (IsDefault(kind, f) || f.Name == "Style" && f.Type == 't' && Writer.Redundant(read, f)) continue;
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
        // property where the element sits (ScreenHtml.DefaultOf: inside a Popup an event's Transition is Fade).
        private bool WrittenDefault(string id, string kind, string fact, string? value)
        {
            if (value is not { Length: > 1 } || value[1] != ':') return false;
            if (fact.StartsWith("p:", StringComparison.Ordinal))
                return ScreenHtml.DefaultOf(kind, fact[2..], value[0], false) == value[2..];
            if (fact.StartsWith("ev:", StringComparison.Ordinal) && fact.IndexOf(":p:", 3, StringComparison.Ordinal) is var at and > 3)
                return ScreenHtml.DefaultOf("BuiltinEvent", fact[(at + 3)..], value[0], InPopup(id)) == value[2..];
            return false;
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
                var wanted = ScreenHtml.DefaultOf(eventKind, "Transition", 'v', inPopup);
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
            var role = ModuleIndex.Roles[ModuleIndex.RoleOf(kindName, new HashSet<string>(m.r.KindNamesOf(node), StringComparer.Ordinal))];
            return role == "widget";
        }
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
                        // A value the edit wrote that is the default where the element sits reads back absent (a reading writes no
                        // default): the same value (os-onclick.Transition="Fade" inside a Popup, os-Visible="True").
                        if (b == null && WrittenDefault(e, want.Kind, fact, a)) continue;
                        // A new widget the platform must name (an input) takes the name it gives when the edit wrote none.
                        if (fact == "p:Name" && a == null && b != null && IsNew(e)) {
                            Result.Normalized.Add(new JsonObject { ["k"] = null, ["property"] = "Name", ["value"] = b[2..], ["note"] = "the platform named the new " + want.Kind + " (an id the edit did not write)" });
                            continue;
                        }
                        // The click of a new widget on a screen action takes the validations the platform gives it (ValidateAndContinue)
                        // when the edit wrote none: the fix the refusal of a script asks for (onclick="Save") is then written as is.
                        if (a == null && b != null && IsNew(e) && fact.StartsWith("ev:", StringComparison.Ordinal) && fact.EndsWith(":p:BuiltInValidations", StringComparison.Ordinal)) {
                            Result.Normalized.Add(new JsonObject { ["k"] = null, ["property"] = fact, ["value"] = b[2..], ["note"] = "the platform's validations of the new " + want.Kind + "'s event (the edit wrote none)" });
                            continue;
                        }
                        if (fact == "p:StyleSheet" && a != null && b != null && Squeeze(a) == Squeeze(b)) { Result.Normalized.Add(new JsonObject { ["k"] = e, ["property"] = "StyleSheet", ["note"] = "the CSS was formatted (spaces and lines only)" }); continue; }
                        differences.Add(Where(e) + ": " + fact + " is " + Show(b) + ", the edit says " + Show(a));
                    }
                    // Identity: what the edit kept keeps its key.
                    if (!IsNew(e) && !moved.Contains(e) && !InsideMoved(e) && !e.StartsWith('+') && keys.TryGetValue(e, out var was) && readKeys.TryGetValue(r, out var now) && was != now)
                        differences.Add(Where(e) + ": its ObjectKey changed (" + was + " -> " + now + ")");
                    if (want.Children.Count != got.Children.Count) { differences.Add(Where(e) + ": " + got.Children.Count + " children read back, the edit has " + want.Children.Count + " (" + Clip(string.Join(" ", got.Children)) + ")"); continue; }
                    var ordinal = 0;
                    for (var i = 0; i < want.Children.Count; i++) {
                        string a = want.Children[i], b = got.Children[i];
                        var run = a.StartsWith("t:", StringComparison.Ordinal) || a.StartsWith("x:", StringComparison.Ordinal);
                        if (run) {
                            if (a != b) differences.Add(Where(e) + ": run " + Show(b) + " read back, the edit has " + Show(a));
                            else if (keptRuns.TryGetValue((e, i), out var runKey) && !InsideMoved(e) && keys.TryGetValue(runKey, out var runWas)
                                && readKeys.TryGetValue(r + "~" + ordinal.ToString(CultureInfo.InvariantCulture), out var runNow) && runWas != runNow)
                                differences.Add(Where(e) + ": the run " + Show(a) + " changed its ObjectKey");
                            ordinal++;
                            continue;
                        }
                        if (a.StartsWith("k:", StringComparison.Ordinal) && b.StartsWith("k:", StringComparison.Ordinal)) { queue.Enqueue((a[2..], b[2..])); continue; }
                        if (a != b) { differences.Add(Where(e) + ": " + b + " read back, the edit has " + a); continue; }
                        if (a.StartsWith("s:", StringComparison.Ordinal)) queue.Enqueue((e + "/" + a[2..], r + "/" + a[2..]));
                        else if (a.StartsWith("c:", StringComparison.Ordinal)) queue.Enqueue((e + "/content:" + a[2..], r + "/content:" + a[2..]));
                    }
                }
                if (differences.Count > 0)
                    Problem(ScreenHtmlEdit.NotApplied, null, null, "the module read again is not the edited text: " + string.Join("; ", differences.Take(8)),
                        "nothing was kept; this is a fault of the engine for this construction (report it with the edit)");
            } finally { Result.VerifyMs = sw.Elapsed.TotalMilliseconds; }
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
        private static string Where(string id) => id.Length == 0 ? "the root" : id.StartsWith('+') ? "a new element" : "k=\"" + id + "\"";
        private static string Show(string? value) => value == null ? "absent" : "'" + Clip(value) + "'";
        private static string Clip(string text) => text.Length > 80 ? text[..80] + "…" : text;
    }
}
