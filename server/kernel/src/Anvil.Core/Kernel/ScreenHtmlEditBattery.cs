using System.Globalization;
using System.Text.RegularExpressions;

namespace Anvil.Reading;

// The synthetic edits of the C2 acceptance (plan, section 8): from the text of a real screen or block, the edits a model makes
// when it corrects a page, each one written as an edit of the reading (the changed element with its k) together with the
// whole text the module must read back after it (without the k of the reading, which renumbers). Kinds: class, text,
// expression, new child, leaf removal, sibling swap, event. Deterministic for a seed.
public static class ScreenHtmlEditBattery
{
    public sealed record Edit(string Kind, List<string> Edits, string Expected, string Note);

    // column: a whole column of a native Table removed, swapped with the next one or added; table: a new data table (the native
    // Table) in a container, over a list the page has (the review of round 1, M4). Last, so the edits of the other kinds stay.
    public static readonly string[] Kinds = ["class", "text", "expression", "child", "remove", "swap", "event", "column", "table"];
    private static readonly HashSet<string> DataTags = new(StringComparer.Ordinal) { "var", "aggregate", "data-action", "action", "event", "style", "slot", "content", "os-opaque" };

    // removable: whether nothing outside uses the element k (a removal of a used element is refused, HTML_DELETE_IN_USE).
    // actionNames: the screen actions as the reading writes a reference to each (ScreenHtmlModule.ActionNames); without it, the
    // names of the actions attribute.
    public static List<Edit> Generate(ScreenHtmlDocument reading, int seed, int perKind = 1, Func<string, bool>? removable = null, IReadOnlyList<string>? actionNames = null)
    {
        var edits = new List<Edit>();
        var tree = ScreenHtml.Parse(reading.Html);
        var top = tree.Children.First(c => !c.IsText);
        var actions = actionNames?.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList()
            ?? (top.Get("actions") ?? "").Split(", ", StringSplitOptions.RemoveEmptyEntries).ToList();
        var parents = ScreenHtmlText.Parents(tree);
        // Widgets the edits may touch: with a k, not data, not opaque nor inside an opaque (a table's cells excepted is not worth it).
        var widgets = ScreenHtmlText.Elements(top).Select(x => x.Node).Where(n => n != top && n.Get("k") != null && IsWidget(n) && !InsideOpaque(n, parents)).ToList();
        var random = new Random(seed ^ StableHash(reading.RootKey));
        foreach (var kind in Kinds) {
            var candidates = kind switch {
                "class" => widgets.Where(n => n.Get("class") is { Length: > 0 } c && !c.Contains("{{", StringComparison.Ordinal)).ToList(),
                "text" => widgets.Where(n => PlainRuns(n).Count > 0).ToList(),
                "expression" => widgets.Where(n => ExpressionRuns(n).Count > 0 || n.Get("if") is { Length: > 0 } || n.Attributes.Any(a => a.Key.StartsWith(':') && a.Value.Length > 0)).ToList(),
                "child" => widgets.Where(n => n.Tag is "div" && n.Get("else") == null || n.Get("html") == null && !ScreenHtml.ReservedTags.Contains(n.Tag) && !ScreenHtml.VoidTags.Contains(n.Tag) && n.Tag != "list" && n.Get("list") == null).ToList(),
                // A cell of a native Table is half of a column (its header cell and its row cell): removing or moving one alone is a
                // column change the edit refuses, never a leaf edit.
                "remove" => widgets.Where(n => !n.Children.Any(c => !c.IsText) && n.Get("else") == null && n.Tag is not ("Block" or "placeholder") && parents.TryGetValue(n, out var p) && p != top
                    && n.NativeKind == null && (removable == null || removable(n.Get("k")!))).ToList(),
                "swap" => widgets.Where(n => n.NativeKind == null && SwapPair(n, parents) != null).ToList(),
                "event" => widgets.Where(n => Event(n, actions) != null).ToList(),
                "column" => widgets.Where(n => n.Tag == "table" && ScreenHtmlTables.NativeTable(n) is { } t && t.HeaderCells.Count > 0 && t.HeaderCells.Count == t.RowCells.Count
                    && t.HeaderCells.Concat(t.RowCells).All(c => c.Get("k") != null)).ToList(),
                // A container that holds a List or a Table already takes a Table (a placeholder of a pattern may refuse one, as
                // in an ODC customer app): the new table goes beside it, over its list.
                "table" => widgets.Where(n => n.Tag == "div" && n.Attributes.All(a => a.Key is "k" or "class" or "id") && SiblingList(n) != null).ToList(),
                _ => [],
            };
            var taken = 0;
            while (candidates.Count > 0 && taken < perKind) {
                var node = candidates[random.Next(candidates.Count)];
                candidates.Remove(node);
                var made = Make(kind, tree, node, parents, actions, random);
                if (made == null) continue;
                edits.Add(made);
                taken++;
            }
        }
        return edits;
    }

    private static Edit? Make(string kind, ScreenHtml.Node tree, ScreenHtml.Node original, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents, List<string> actions, Random random)
    {
        // The edit runs on a copy of the whole text: the same node in the copy, its parents there.
        var copy = ScreenHtmlText.Clone(tree);
        var map = new Dictionary<ScreenHtml.Node, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        void Pair(ScreenHtml.Node a, ScreenHtml.Node b) { map[a] = b; for (var i = 0; i < a.Children.Count; i++) Pair(a.Children[i], b.Children[i]); }
        Pair(tree, copy);
        var copyParents = ScreenHtmlText.Parents(copy);
        var node = map[original];
        ScreenHtml.Node editRoot; string note;
        switch (kind) {
            case "class": {
                var i = node.Attributes.FindIndex(a => a.Key == "class");
                node.Attributes[i] = new("class", node.Attributes[i].Value + " ssam-c2");
                editRoot = node; note = "class of " + node.Get("k");
                break;
            }
            case "text": {
                var (text, line) = PlainRuns(node)[random.Next(PlainRuns(node).Count)];
                var lines = text.Text!.Split('\n');
                lines[line] = lines[line].TrimEnd(' ', '\r', '\t') + " c2";
                text.Text = string.Join('\n', lines);
                editRoot = node; note = "text in " + node.Get("k");
                break;
            }
            case "expression": {
                var runs = ExpressionRuns(node);
                var attributes = node.Attributes.Select((a, i) => (a, i)).Where(x => x.a.Key == "if" && x.a.Value.Length > 0 || x.a.Key.StartsWith(':') && x.a.Value.Length > 0).ToList();
                if (runs.Count > 0 && (attributes.Count == 0 || random.Next(2) == 0)) {
                    var (text, line) = runs[random.Next(runs.Count)];
                    var lines = text.Text!.Split('\n');
                    var trimmed = lines[line].Trim(' ', '\r', '\t');
                    lines[line] = lines[line][..lines[line].IndexOf("{{ ", StringComparison.Ordinal)] + "{{ (" + trimmed[3..^3] + ") }}";
                    text.Text = string.Join('\n', lines);
                    note = "expression run in " + node.Get("k");
                } else {
                    var (attribute, i) = attributes[random.Next(attributes.Count)];
                    node.Attributes[i] = new(attribute.Key, "(" + attribute.Value + ")");
                    note = attribute.Key + " of " + node.Get("k");
                }
                editRoot = node;
                break;
            }
            case "child": {
                // A container with an expression, a run of text, a named container, or an input bound to a Text variable of
                // the screen (a new widget's name and reference are written on properties the platform creates empty).
                var top = copy.Children.First(c => !c.IsText);
                var names = new HashSet<string>(ScreenHtmlText.Elements(top).Select(x => x.Node.Get("id") ?? x.Node.Get("name") ?? ""), StringComparer.OrdinalIgnoreCase);
                var texts = top.Children.Where(c => !c.IsText && c.Tag == "var" && c.Get("type") == "Text" && c.Get("name") is { Length: > 0 }).Select(c => c.Get("name")!).ToList();
                var free = "SsamC2New"; for (var n = 2; names.Contains(free); n++) free = "SsamC2New" + n.ToString(CultureInfo.InvariantCulture);
                var variant = random.Next(4);
                // An input never goes inside a link, a button or a label (the platform refuses interactive content there).
                bool InsideInteractive() { for (var p = node; p != null; p = copyParents.TryGetValue(p, out var up) ? up : null) if (p.Tag is "a" or "button" or "label") return true; return false; }
                if (variant == 3 && (texts.Count == 0 || node.Tag is "p" or "span" or "h1" or "h2" or "h3" or "h4" or "h5" or "h6" || InsideInteractive())) variant = 2;
                var added = variant switch {
                    0 => Element("div", [new("class", "ssam-c2-new")], "{{ \"c2\" }}"),
                    1 => Element("span", [new("class", "ssam-c2-new")], "c2"),
                    2 => Element("div", [new("id", free), new("class", "ssam-c2-new")], "c2"),
                    _ => Element("input", [new("id", free), new("bind", texts[random.Next(texts.Count)]), new("class", "ssam-c2-new")], null),
                };
                // Anywhere among the children, never between an If and its else.
                var places = Enumerable.Range(0, node.Children.Count + 1).Where(i => !(NextElement(node, i - 1) is { } after && after.Get("else") != null && after.Attributes.Count == 1)).ToList();
                node.Children.Insert(places[random.Next(places.Count)], added);
                editRoot = node; note = "new <" + added.Tag + "> in " + node.Get("k");
                break;
            }
            case "remove": {
                var parent = copyParents[node];
                var at = parent.Children.IndexOf(node);
                parent.Children.RemoveAt(at);
                // An If goes with its else; an else left empty is not written.
                if (node.Get("if") != null && NextElement(parent, at - 1) is { } next && next.Get("else") != null) parent.Children.Remove(next);
                if (parent.Get("else") != null && parent.Attributes.Count == 1 && parent.Children.All(c => c.IsText && c.Text!.Trim().Length == 0)
                    && copyParents.TryGetValue(parent, out var holder0)) holder0.Children.Remove(parent);
                editRoot = parent; note = "removed " + node.Get("k");
                break;
            }
            case "swap": {
                var (a, b) = SwapPair(original, parents)!.Value;
                var parent = copyParents[map[a]];
                var ia = parent.Children.IndexOf(map[a]); var ib = parent.Children.IndexOf(map[b]);
                (parent.Children[ia], parent.Children[ib]) = (parent.Children[ib], parent.Children[ia]);
                editRoot = parent; note = "swapped " + a.Get("k") + " and " + b.Get("k");
                break;
            }
            case "event": {
                var (i, value) = Event(original, actions)!.Value;
                var attribute = node.Attributes[i];
                var paren = value.IndexOf('(');
                string changed;
                if (paren > 0 && random.Next(2) == 0) {
                    // An argument: its expression in parentheses.
                    var eq = value.IndexOf(" = ", paren, StringComparison.Ordinal);
                    var end = ArgumentEnd(value, eq + 3);
                    changed = value[..(eq + 3)] + "(" + value[(eq + 3)..end] + ")" + value[end..];
                    note = "argument of " + attribute.Key + " on " + node.Get("k");
                } else {
                    var target = paren > 0 ? value[..paren] : value;
                    var others = actions.Where(a => a != target).ToList();
                    changed = others[random.Next(others.Count)];
                    note = attribute.Key + " of " + node.Get("k") + " -> " + changed;
                }
                node.Attributes[i] = new(attribute.Key, changed);
                editRoot = node;
                break;
            }
            case "column": {
                // A whole column: its header cell and its row cell together (the platform removes and adds them so).
                var table = ScreenHtmlTables.NativeTable(node)!;
                var columns = table.HeaderCells.Count;
                var i = random.Next(columns);
                var variant = columns < 2 ? 2 : random.Next(3);
                var (header, cell) = (table.HeaderCells[i], table.RowCells[i]);
                if (variant == 0) {
                    table.HeadRow.Children.Remove(header); table.BodyRow.Children.Remove(cell);
                    note = "removed the column " + header.Get("k") + "/" + cell.Get("k") + " of " + node.Get("k");
                } else if (variant == 1) {
                    var j = i + 1 < columns ? i + 1 : i - 1;
                    Swap(table.HeadRow, header, table.HeaderCells[j]); Swap(table.BodyRow, cell, table.RowCells[j]);
                    note = "swapped the columns " + i.ToString(CultureInfo.InvariantCulture) + " and " + j.ToString(CultureInfo.InvariantCulture) + " of " + node.Get("k");
                } else {
                    table.HeadRow.Children.Insert(table.HeadRow.Children.IndexOf(header), Element("th", [], "C2"));
                    table.BodyRow.Children.Insert(table.BodyRow.Children.IndexOf(cell), Element("td", [], "c2"));
                    note = "added a column before " + header.Get("k") + " in " + node.Get("k");
                }
                editRoot = node;
                break;
            }
            case "table": {
                // A new data table, its classes written (the Studio's would be the reading's otherwise), over a list of the page.
                for (var p = node; p != null; p = copyParents.TryGetValue(p, out var up) ? up : null) if (p.Tag is "a" or "button" or "label") return null;
                var source = SiblingList(node)!;
                var headRow = Element("tr", [new("class", "ssam-c2-head")], null); headRow.Children.Add(Element("th", [], "C2"));
                var bodyRow = Element("tr", [new("class", "ssam-c2-row")], null); bodyRow.Children.Add(Element("td", [], "c2"));
                var head = Element("thead", [], null); head.Children.Add(headRow);
                // As the reading writes it (its list on the table, before its class): the text read back is the text written.
                var body = Element("tbody", [], null); body.Children.Add(bodyRow);
                var added = Element("table", [new("list", source), new("class", "ssam-c2-new")], null); added.Children.Add(head); added.Children.Add(body);
                var places = Enumerable.Range(0, node.Children.Count + 1).Where(i => !(NextElement(node, i - 1) is { } after && after.Get("else") != null && after.Attributes.Count == 1)).ToList();
                node.Children.Insert(places[random.Next(places.Count)], added);
                editRoot = node; note = "new data table over " + source + " in " + node.Get("k");
                break;
            }
            default: return null;
        }
        // The edit is the element with a k that holds the change (a slot is its block instance's); an If with its else.
        while (editRoot.Get("k") == null || editRoot.Tag == "slot") {
            if (!copyParents.TryGetValue(editRoot, out var up)) return null;
            editRoot = up;
        }
        if (editRoot.Tag is "screen" or "block") return null;
        var text0 = ScreenHtmlText.Write(editRoot);
        if (editRoot.Get("if") != null && copyParents.TryGetValue(editRoot, out var holder) && NextElement(holder, holder.Children.IndexOf(editRoot)) is { } elseNode && elseNode.Get("else") != null)
            text0 += ScreenHtmlText.Write(elseNode);
        return new Edit(kind, [text0], ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(copy)), note);
    }

    private static void Swap(ScreenHtml.Node parent, ScreenHtml.Node a, ScreenHtml.Node b)
    {
        var ia = parent.Children.IndexOf(a); var ib = parent.Children.IndexOf(b);
        (parent.Children[ia], parent.Children[ib]) = (parent.Children[ib], parent.Children[ia]);
    }

    // The list of a List or Table the container holds (its source is in scope there), for a new data table beside it; null without.
    private static string? SiblingList(ScreenHtml.Node container) =>
        container.Children.Where(c => !c.IsText).Select(c => c.Get("list")).FirstOrDefault(l => l is { Length: > 0 });

    private static ScreenHtml.Node Element(string tag, List<KeyValuePair<string, string>> attributes, string? run)
    {
        var node = new ScreenHtml.Node { Tag = tag };
        node.Attributes.AddRange(attributes);
        if (run != null) node.Children.Add(new ScreenHtml.Node { Text = run });
        return node;
    }

    private static ScreenHtml.Node? NextElement(ScreenHtml.Node parent, int at)
    {
        for (var i = at + 1; i < parent.Children.Count; i++) {
            if (parent.Children[i].IsText) { if (parent.Children[i].Text!.Trim().Length > 0) return null; continue; }
            return parent.Children[i];
        }
        return null;
    }

    private static bool IsWidget(ScreenHtml.Node node) =>
        !DataTags.Contains(node.Tag) && !(node.Tag == "input" && node.Get("name") != null && node.Get("bind") == null)
        && !(node.Tag.StartsWith("os-", StringComparison.Ordinal));
    private static bool InsideOpaque(ScreenHtml.Node node, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        for (var p = node; parents.TryGetValue(p, out var up); p = up) if (up.Tag == "os-opaque") return true;
        return false;
    }

    private static List<(ScreenHtml.Node Text, int Line)> PlainRuns(ScreenHtml.Node node) => Lines(node, line => !line.StartsWith("{{", StringComparison.Ordinal));
    private static List<(ScreenHtml.Node Text, int Line)> ExpressionRuns(ScreenHtml.Node node) =>
        Lines(node, line => line.Length >= 6 && line.StartsWith("{{ ", StringComparison.Ordinal) && line.EndsWith(" }}", StringComparison.Ordinal));
    private static List<(ScreenHtml.Node, int)> Lines(ScreenHtml.Node node, Func<string, bool> accept)
    {
        var list = new List<(ScreenHtml.Node, int)>();
        if (node.Tag is "text" or "style") return list;
        foreach (var child in node.Children.Where(c => c.IsText)) {
            var lines = child.Text!.Split('\n');
            for (var i = 0; i < lines.Length; i++) { var line = lines[i].Trim(' ', '\r', '\t'); if (line.Length > 0 && accept(line)) list.Add((child, i)); }
        }
        return list;
    }

    // Two adjacent widgets with a k under the same parent, none of them part of an If pair.
    private static (ScreenHtml.Node, ScreenHtml.Node)? SwapPair(ScreenHtml.Node node, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents)
    {
        if (!parents.TryGetValue(node, out var parent) || node.Get("k") == null || node.Get("if") != null || node.Get("else") != null) return null;
        var at = parent.Children.IndexOf(node);
        if (NextElement(parent, at) is not { } next || next.Get("k") == null || next.Get("if") != null || next.Get("else") != null || !IsWidget(next) || !IsWidget(node)) return null;
        return (node, next);
    }

    // An event attribute whose value is a call: on<event> or @<Event>, never its properties (os-on...) or the html: form.
    private static (int Index, string Value)? Event(ScreenHtml.Node node, List<string> actions)
    {
        if (actions.Count < 2) return null;
        for (var i = 0; i < node.Attributes.Count; i++) {
            var (name, value) = node.Attributes[i];
            if (!(name.StartsWith("on", StringComparison.Ordinal) || name.StartsWith('@')) || name.Contains('.') || value.Length == 0) continue;
            if (!ScreenHtml.TryCall(value, out var target, out _) || !actions.Contains(target)) continue;
            return (i, value);
        }
        return null;
    }

    // Where the argument that starts at `start` ends (its comma at the top level, or the closing parenthesis).
    private static int ArgumentEnd(string call, int start)
    {
        var depth = 0; var inString = false;
        for (var i = start; i < call.Length; i++) {
            var c = call[i];
            if (inString) { if (c == '"') { if (i + 1 < call.Length && call[i + 1] == '"') i++; else inString = false; } continue; }
            if (c == '"') inString = true;
            else if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') { if (depth == 0) return i; depth--; }
            else if (c == ',' && depth == 0) return i;
        }
        return call.Length - 1;
    }

    private static int StableHash(string text) { var h = 17; foreach (var c in text) h = unchecked(h * 31 + c); return h; }
}
