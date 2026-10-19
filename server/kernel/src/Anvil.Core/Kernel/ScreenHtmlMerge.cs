using System.Text.Json.Nodes;

namespace Anvil.Reading;

// C2 of the plan "Texto do SSAM" (section 3.4): the three-way merge of an edit written on an older reading of a screen. The base
// is the reading the edit names (basedOn: its text and its k -> ObjectKey table, kept by ssam_map view html), the local side
// is the screen as the module reads now (changed in the Studio since), the foreign side is the base with the edit in place.
// Elements are matched by ObjectKey (never by k, which renumbers), structural parts by their owner (a slot by name, the else
// of an If by its If), text runs by value. For every attribute, parent and list of children: what only one side changed is
// taken from that side; what both changed is a conflict, and the delivery's version (the edit) wins, as the owner's rule says,
// listed in the answer. An element removed in the Studio that the edit changed cannot come back with its key: it is returned
// in Missing (HTML_KEY_FOREIGN with the current text). The result is the whole document in the current reading's k, which the
// edit plan then diffs against the current reading: only what the edit changed is written. Free of Studio types.
public static class ScreenHtmlMerge
{
    public sealed class Result
    {
        // The merged document (null when the edit could not be laid over its base: the caller never plans a whole document
        // written on that base in its place, Verbs.ScreenHtml.Rebase).
        public string? Document;
        // Why Document is null: the part of a reading the merge could not match, or the edit it could not lay (said in the
        // refusal, so a part the merge does not know yet is named).
        public string? Why;
        public List<JsonObject> Conflicts = [];
        // The k (of the base reading) of elements the edit changed that are no longer in the screen.
        public List<string> Missing = [];
    }

    private const string Root = "root", Style = "style";

    // One side: every identity with its node, container (parent identity + segment) and the children of every container.
    private sealed class Side
    {
        public readonly Dictionary<string, ScreenHtml.Node> Nodes = new(StringComparer.Ordinal);
        public readonly Dictionary<string, (string Parent, string Segment)> Parent = new(StringComparer.Ordinal);
        public readonly Dictionary<(string Id, string Segment), List<string>> Children = [];
        public readonly Dictionary<string, string> K = new(StringComparer.Ordinal);
        public string? StyleText;
        public bool Has(string id) => Nodes.ContainsKey(id);
        public List<string> Sequence(string id, string segment) => Children.TryGetValue((id, segment), out var list) ? list : [];
    }

    public static Result ThreeWay(string baseHtml, IReadOnlyDictionary<string, string> baseKeys, string currentHtml, IReadOnlyDictionary<string, string> currentKeys,
        IReadOnlyList<string> edits)
    {
        var result = new Result();
        ScreenHtml.Node baseTree, foreignTree, localTree;
        try {
            baseTree = ScreenHtml.Parse(baseHtml);
            localTree = ScreenHtml.Parse(currentHtml);
            foreignTree = Overlay(baseHtml, edits);
        } catch (FormatException error) { result.Why = "a text does not parse: " + error.Message; return result; }
        if (foreignTree is null) { result.Why = "the edit could not be laid over the reading it was written on (one element per edit, each with a k of that reading)"; return result; }
        var news = 0;
        string? why = null;
        var b = Index(baseTree, baseKeys, ref news, foreign: false, ref why, "the reading the edit was written on");
        var f = why == null ? Index(foreignTree, baseKeys, ref news, foreign: true, ref why, "the edit") : null;
        var l = why == null ? Index(localTree, currentKeys, ref news, foreign: false, ref why, "the screen now") : null;
        if (b == null || f == null || l == null) { result.Why = why ?? "a side could not be indexed"; return result; }

        // Which identities the merged screen has.
        var exists = new HashSet<string>(StringComparer.Ordinal) { Root };
        foreach (var id in b.Nodes.Keys.Union(f.Nodes.Keys).Union(l.Nodes.Keys)) {
            if (id == Root) continue;
            bool inB = b.Has(id), inF = f.Has(id), inL = l.Has(id);
            if (inL && inB && inF) exists.Add(id);
            else if (inL && inB) { if (Changed(id, l, b)) Conflict(result, l, id, "removed", "removed by the edit, changed in the Studio since the reading: removed (the delivery's version)"); }
            else if (inL) exists.Add(id);
            else if (inF && !inB) exists.Add(id);
            else if (inF && inB && Changed(id, f, b)) result.Missing.Add(b.K.GetValueOrDefault(id) ?? id);
        }
        if (result.Missing.Count > 0) return result;

        // The container of each: one side's change wins over no change, the edit's over the Studio's.
        var parent = new Dictionary<string, (string Parent, string Segment)>(StringComparer.Ordinal);
        foreach (var id in exists) {
            if (id == Root) continue;
            var pB = b.Parent.TryGetValue(id, out var x) ? x : ((string, string)?)null;
            var pF = f.Parent.TryGetValue(id, out var y) ? y : ((string, string)?)null;
            var pL = l.Parent.TryGetValue(id, out var z) ? z : ((string, string)?)null;
            var chosen = Pick(pF, pB, pL, out var clash);
            if (chosen is not { } c) continue;
            if (clash) Conflict(result, l, id, "parent", "moved by the edit and in the Studio: the edit's place");
            parent[id] = c;
        }
        // An element whose container is gone goes with it.
        bool Alive(string id) { for (var p = id; p != Root; p = parent.TryGetValue(p, out var up) ? up.Parent : "") { if (p.Length == 0 || !exists.Contains(p) || !parent.ContainsKey(p)) return false; } return true; }
        foreach (var id in exists.ToList()) if (id != Root && !Alive(id)) { exists.Remove(id); if (l.Has(id) && !f.Has(id)) Conflict(result, l, id, "lost", "added or moved in the Studio under an element the edit removed"); }

        var members = new Dictionary<(string, string), HashSet<string>>();
        foreach (var (id, c) in parent) if (exists.Contains(id)) { if (!members.TryGetValue(c, out var set)) members[c] = set = new(StringComparer.Ordinal); set.Add(id); }

        var top = Build(Root, b, f, l, exists, members, result);
        if (top == null) return result;
        var style = Pick(f.StyleText, b.StyleText, l.StyleText, out var styleClash);
        if (styleClash) Conflict(result, l, Root, "style", "the <style> changed in the edit and in the Studio: the edit's");
        if (style != null) {
            var sheet = new ScreenHtml.Node { Tag = "style" };
            sheet.Children.Add(new ScreenHtml.Node { Text = style });
            top.Children.Insert(0, sheet);
        }
        var document = new ScreenHtml.Node { Tag = "#document" };
        document.Children.Add(top);
        result.Document = ScreenHtmlText.Write(document);
        return result;
    }

    // ---- the foreign side: the base text with every edit in place of the element it names -------------------------------
    private static ScreenHtml.Node? Overlay(string baseHtml, IReadOnlyList<string> edits)
    {
        var tree = ScreenHtml.Parse(baseHtml);
        var edited = new HashSet<ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        // The elements the edits put in by k: an earlier one a later edit wrote again around it is gone with the old subtree, and
        // the edit is not laid (null): the plan then refuses the two edits (HTML_EDIT_OVERLAP), never a change lost in silence.
        var placed = new List<ScreenHtml.Node>();
        ScreenHtml.Node Top() => tree.Children.First(c => !c.IsText);
        foreach (var text in edits) {
            var parsed = ScreenHtml.Parse(text);
            var roots = parsed.Children.Where(c => !c.IsText || c.Text!.Trim().Length > 0).ToList();
            ScreenHtml.Node? elsePart = null;
            if (roots.Count == 2 && ScreenHtmlEdit.IsIfElse(roots[0], roots[1])) { elsePart = roots[1]; roots.RemoveAt(1); }
            if (roots.Count != 1 || roots[0].IsText) return null;
            var e = roots[0];
            Mark(edited, e); if (elsePart != null) Mark(edited, elsePart);
            if (e.Tag is "screen" or "block") {
                if (edits.Count > 1 || e.Tag != Top().Tag) return null;
                tree.Children[tree.Children.IndexOf(Top())] = e;
                continue;
            }
            if (e.Tag == "style") {
                var t = Top();
                var old = t.Children.FindIndex(c => c.Tag == "style");
                if (old >= 0) t.Children[old] = e; else t.Children.Insert(0, e);
                continue;
            }
            if (e.Get("k") is not { } key) return null;
            var hits = ScreenHtmlText.Elements(tree).Where(x => x.Node.Get("k") == key && x.Parent != null && !edited.Contains(x.Node)).ToList();
            if (hits.Count != 1) return null;
            var (node, holder) = hits[0];
            var at = holder!.Children.IndexOf(node);
            holder.Children[at] = e;
            placed.Add(e);
            if (elsePart != null) {
                var next = NextElement(holder, at);
                if (next >= 0 && IsElse(holder.Children[next])) holder.Children[next] = elsePart; else holder.Children.Insert(at + 1, elsePart);
            } else if (e.Get("if") == null && NextElement(holder, at) is var after and >= 0 && IsElse(holder.Children[after]) && node.Get("if") != null) {
                // An If edited into another element: its old else goes with it.
                holder.Children.RemoveAt(after);
            }
        }
        // A k written in an edit and still in the part no edit replaced: the element moved into the edit.
        foreach (var group in ScreenHtmlText.Elements(tree).Where(x => x.Node.Get("k") != null).GroupBy(x => x.Node.Get("k")!).Where(g => g.Count() > 1).ToList()) {
            if (group.Count(x => edited.Contains(x.Node)) != 1) return null;
            foreach (var (node, holder) in group.Where(x => !edited.Contains(x.Node))) holder?.Children.Remove(node);
        }
        var present = new HashSet<ScreenHtml.Node>(ScreenHtmlText.Elements(tree).Select(x => x.Node), ReferenceEqualityComparer.Instance);
        if (placed.Any(e => !present.Contains(e))) return null;
        return tree;
    }

    private static void Mark(HashSet<ScreenHtml.Node> set, ScreenHtml.Node root) { foreach (var (node, _) in ScreenHtmlText.Elements(root)) set.Add(node); }
    private static bool IsElse(ScreenHtml.Node node) => !node.IsText && node.Tag == "div" && node.Attributes is [{ Key: "else" }];
    private static int NextElement(ScreenHtml.Node parent, int at)
    {
        for (var i = at + 1; i < parent.Children.Count; i++) {
            if (parent.Children[i].IsText) { if (parent.Children[i].Text!.Trim().Length > 0) return -1; continue; }
            return i;
        }
        return -1;
    }

    // ---- identities --------------------------------------------------------------------------------------------------------
    // Null when a k of the side has no ObjectKey in its table (an edit naming an element that is not of its reading: the plan
    // refuses that with its own words).
    private static Side? Index(ScreenHtml.Node tree, IReadOnlyDictionary<string, string> keys, ref int news, bool foreign, ref string? why, string what)
    {
        var side = new Side();
        var top = tree.Children.FirstOrDefault(c => !c.IsText);
        if (top == null || top.Tag is not ("screen" or "block")) { why = what + " is not one <screen> or <block>"; return null; }
        string? failed = null;
        side.Nodes[Root] = top;
        var ok = true; var counter = news;
        // The children of one container: an element's own (segment self) or the false branch of an If (segment else, the
        // <div else> right after it). The same walk for both, so an If inside an else has its own else (an else-if chain, as the
        // reading writes it: the Audit screen of 2026-10-18 has several, and the merge could not index it, which made the edit
        // replace the screen with the reading's actions=).
        void Walk(ScreenHtml.Node node, string id, string segment = "self")
        {
            var list = Container(id, segment);
            string? lastIf = null;
            var lines = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var child in node.Children) {
                if (child.IsText) {
                    foreach (var run in RunsOf(node, child)) { list.Add(Line(run, lines)); lastIf = null; }
                    continue;
                }
                if (child.Tag == "style" && id == Root && segment == "self") { side.StyleText = string.Concat(child.Children.Select(c => c.Text)); continue; }
                if (IsElse(child) && lastIf != null) {
                    Walk(child, lastIf, "else");
                    lastIf = null;
                    continue;
                }
                if (child.Tag == "text" && child.Get("k") == null) { list.Add(Line("<text>" + string.Concat(child.Children.Select(c => c.Text)), lines)); lastIf = null; continue; }
                var cid = IdOf(child, id);
                if (cid == null) { ok = false; failed ??= "<" + child.Tag + "> at line " + child.Line.ToString(System.Globalization.CultureInfo.InvariantCulture) + (child.Get("k") is { } unkeyed ? " has k=\"" + unkeyed + "\", which its key table does not have" : " has no k and is no part the merge matches by its owner"); return; }
                if (side.Nodes.ContainsKey(cid)) { ok = false; failed ??= "<" + child.Tag + "> at line " + child.Line.ToString(System.Globalization.CultureInfo.InvariantCulture) + " is the same element twice"; return; }
                side.Nodes[cid] = child; side.Parent[cid] = (id, segment);
                if (child.Get("k") is { } k) side.K[cid] = k;
                list.Add(cid);
                Walk(child, cid);
                lastIf = child.Get("if") != null && child.Tag == "div" ? cid : null;
            }
        }
        List<string> Container(string id, string segment)
        {
            if (!side.Children.TryGetValue((id, segment), out var list)) side.Children[(id, segment)] = list = [];
            return list;
        }
        // The parts of the native Tables of this side (ScreenHtmlTables.NativeTable: the thead and the tbody, and the one row of
        // each), taken when the walk meets their table.
        var tableParts = new HashSet<ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        string? IdOf(ScreenHtml.Node node, string parentId)
        {
            if (node.Tag == "table" && ScreenHtmlTables.NativeTable(node) is { } table) tableParts.UnionWith([table.Head, table.HeadRow, table.Body, table.BodyRow]);
            if (node.Get("k") is { } k) return keys.TryGetValue(k, out var objectKey) ? "o:" + objectKey : null;
            if (node.Tag == "slot") return parentId + "/slot:" + (node.Get("name") ?? "");
            if (node.Tag == "content") return parentId + "/content:" + (node.Get("name") ?? "");
            // The parts of a native Table are its structure, as a slot is a block instance's: never keyed, matched by their owner.
            // The parts of any other table are elements, new without k (the review of round 2, B1: the two rows of a new static
            // table had one identity, the merge gave up and the edit's whole text replaced the screen).
            if (tableParts.Contains(node)) return parentId + "/" + node.Tag;
            // An element without k is new: only the edit writes one.
            return foreign ? "new:" + (++counter).ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
        }
        Walk(top, Root);
        news = counter;
        if (!ok) why = failed + " in " + what;
        return ok ? side : null;
    }

    // The runs of one text child as merge lines (ScreenHtml.Runs, the whitespace beside an inline element kept): a run with spaces
    // at its ends is the <text> or {{ }} line that reads back as the same run (ScreenHtml.RunForm).
    private static IEnumerable<string> RunsOf(ScreenHtml.Node parent, ScreenHtml.Node text)
    {
        foreach (var run in ScreenHtml.Runs(parent).Where(r => ReferenceEquals(r.Source, text))) {
            var (form, value) = ScreenHtml.RunForm(run.Text);
            yield return form switch { 'p' => value, 'x' => "{{ " + value + " }}", _ => "<text>" + value };
        }
    }

    private static string Line(string text, Dictionary<string, int> seen)
    {
        var n = seen.GetValueOrDefault(text);
        seen[text] = n + 1;
        return "line:" + n.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + text;
    }
    private static bool IsLine(string item) => item.StartsWith("line:", StringComparison.Ordinal);
    private static string LineText(string item) { var cut = item.IndexOf(':', 5); return item[(cut + 1)..]; }

    // Whether one side changed an element against the base: its tag, attributes, container or the list of its children.
    private static bool Changed(string id, Side side, Side b)
    {
        var a = side.Nodes[id]; var o = b.Nodes[id];
        if (a.Tag != o.Tag || !Attributes(a).OrderBy(p => p.Key, StringComparer.Ordinal).SequenceEqual(Attributes(o).OrderBy(p => p.Key, StringComparer.Ordinal))) return true;
        if (side.Parent.GetValueOrDefault(id) != b.Parent.GetValueOrDefault(id)) return true;
        foreach (var segment in new[] { "self", "else" })
            if (!side.Sequence(id, segment).SequenceEqual(b.Sequence(id, segment), StringComparer.Ordinal)) return true;
        return false;
    }

    private static IEnumerable<KeyValuePair<string, string>> Attributes(ScreenHtml.Node node) => node.Attributes.Where(a => a.Key != "k");

    private static T? Pick<T>(T? foreign, T? baseValue, T? local, out bool conflict)
    {
        conflict = false;
        if (Equals(foreign, baseValue)) return local;
        if (Equals(local, baseValue) || Equals(local, foreign)) return foreign;
        conflict = true;
        return foreign;
    }

    // ---- the merged tree ---------------------------------------------------------------------------------------------------
    private static ScreenHtml.Node? Build(string id, Side b, Side f, Side l, HashSet<string> exists, Dictionary<(string, string), HashSet<string>> members, Result result)
    {
        var fn = f.Nodes.GetValueOrDefault(id); var bn = b.Nodes.GetValueOrDefault(id); var ln = l.Nodes.GetValueOrDefault(id);
        var source = fn ?? ln!;
        var node = new ScreenHtml.Node { Tag = source.Tag, Line = source.Line, Column = source.Column };
        // The tag and the attributes, one by one.
        if (fn != null && ln != null && bn != null) {
            node.Tag = Pick(fn.Tag, bn.Tag, ln.Tag, out var tagClash)!;
            if (tagClash) Conflict(result, l, id, "tag", "the element changed in the edit and in the Studio: the edit's");
        } else if (ln != null && fn == null) node.Tag = ln.Tag;
        if (ln?.Get("k") is { } k) node.Attributes.Add(new("k", k));
        var fa = fn == null ? null : Attributes(fn).ToList();
        var ba = bn == null ? null : Attributes(bn).ToDictionary(a => a.Key, a => a.Value, StringComparer.Ordinal);
        var la = ln == null ? null : Attributes(ln).ToList();
        if (fa != null && la != null && ba != null) {
            var fd = fa.ToDictionary(a => a.Key, a => a.Value, StringComparer.Ordinal);
            var ld = la.ToDictionary(a => a.Key, a => a.Value, StringComparer.Ordinal);
            foreach (var name in fa.Select(a => a.Key).Concat(la.Select(a => a.Key).Where(n => !fd.ContainsKey(n))).Concat(ba.Keys.Where(n => !fd.ContainsKey(n) && !ld.ContainsKey(n))).Distinct().ToList()) {
                var value = Pick(fd.GetValueOrDefault(name), ba.GetValueOrDefault(name), ld.GetValueOrDefault(name), out var clash);
                if (clash) Conflict(result, l, id, name, name + " changed in the edit and in the Studio: the edit's");
                if (value != null) node.Attributes.Add(new(name, value));
            }
        } else foreach (var a in fa ?? la ?? []) node.Attributes.Add(a);

        Fill(node, Order(id, "self", b, f, l, exists, members, result), b, f, l, exists, members, result);
        return node;
    }

    // The children of a container, in order; an If is followed by its <div else> when its false branch has anything.
    private static void Fill(ScreenHtml.Node holder, List<string> order, Side b, Side f, Side l, HashSet<string> exists, Dictionary<(string, string), HashSet<string>> members, Result result)
    {
        foreach (var item in order) {
            if (IsLine(item)) {
                var text = LineText(item);
                if (text.StartsWith("<text>", StringComparison.Ordinal)) {
                    var t = new ScreenHtml.Node { Tag = "text" }; t.Children.Add(new ScreenHtml.Node { Text = text[6..] }); holder.Children.Add(t);
                } else holder.Children.Add(new ScreenHtml.Node { Text = text + "\n" });
                continue;
            }
            var child = Build(item, b, f, l, exists, members, result);
            if (child == null) continue;
            holder.Children.Add(child);
            var falseBranch = Order(item, "else", b, f, l, exists, members, result);
            if (falseBranch.Count == 0) continue;
            var elseNode = new ScreenHtml.Node { Tag = "div" };
            elseNode.Attributes.Add(new("else", ""));
            Fill(elseNode, falseBranch, b, f, l, exists, members, result);
            holder.Children.Add(elseNode);
        }
    }

    // The children of one container: the side that changed the list gives the order (the edit's when both did, with what the
    // Studio added kept after the element it followed); elements that live elsewhere now are left out, and the ones that moved
    // in by the other side come after.
    private static List<string> Order(string id, string segment, Side b, Side f, Side l, HashSet<string> exists, Dictionary<(string, string), HashSet<string>> members,
        Result result, bool record = true)
    {
        var sb = b.Sequence(id, segment); var sf = f.Has(id) ? f.Sequence(id, segment) : sb; var sl = l.Has(id) ? l.Sequence(id, segment) : sb;
        if (!f.Has(id) && !b.Has(id)) sf = []; // added in the Studio: its children are the Studio's
        if (!l.Has(id)) sl = [];               // new in the edit
        var mine = members.GetValueOrDefault((id, segment)) ?? new HashSet<string>(StringComparer.Ordinal);
        bool Keep(string item) => IsLine(item) || mine.Contains(item);
        List<string> order;
        if (sf.SequenceEqual(sb, StringComparer.Ordinal)) order = sl.Where(Keep).ToList();
        else if (sl.SequenceEqual(sb, StringComparer.Ordinal)) order = sf.Where(Keep).ToList();
        else {
            if (record) Conflict(result, l, id, "children", "the children changed in the edit and in the Studio: the edit's order, with what the Studio added");
            var removedLocally = new HashSet<string>(sb.Where(x => !sl.Contains(x)), StringComparer.Ordinal);
            order = sf.Where(x => Keep(x) && !(IsLine(x) && removedLocally.Contains(x))).ToList();
            var baseSet = new HashSet<string>(sb, StringComparer.Ordinal);
            for (var i = 0; i < sl.Count; i++) {
                var item = sl[i];
                // A widget the Studio added stays; a text the Studio wrote where the edit wrote another is the edit's.
                if (baseSet.Contains(item) || order.Contains(item) || !Keep(item) || IsLine(item)) continue;
                var at = -1;
                for (var j = i - 1; j >= 0 && at < 0; j--) at = order.IndexOf(sl[j]);
                order.Insert(at + 1, item);
            }
        }
        foreach (var item in mine.Where(m => !order.Contains(m)).OrderBy(m => sl.IndexOf(m) is var p and >= 0 ? p : int.MaxValue).ThenBy(m => sf.IndexOf(m)).ToList()) order.Add(item);
        return order;
    }

    private static void Conflict(Result result, Side l, string id, string what, string note)
    {
        var k = id == Root ? "" : l.Nodes.TryGetValue(id, out var node) ? node.Get("k") : null;
        if (result.Conflicts.Any(c => c["k"]?.ToString() == k && c["what"]?.ToString() == what && k != null)) return;
        result.Conflicts.Add(new JsonObject { ["k"] = k, ["what"] = what, ["note"] = note });
    }
}
