using System.Text.Json.Nodes;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: C2 of the plan "Texto do SSAM" (ScreenHtmlEdit) over a module through the reader contract
// and a writer of the same model. An edit of the reading (the changed elements with their k) is merged into the text, checked
// at once (every refusal in one answer, with its patch when there is one), written with the few native moves it needs and read
// back: the module reads the edited text, every element the edit kept keeps its key.
public sealed class ScreenHtmlEditTests
{
    private sealed class Node(string key, string kind, string name = "", params string[] kinds)
    {
        public string Key = key, Kind = kind, Name = name;
        public readonly HashSet<string> Kinds = [.. kinds.Append(kind).SelectMany(k => new[] { k, "I" + k })];
        public Node? Parent;
        public List<Node> Children = [];
        public List<Node> UsedBy = [];
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; if (property == "Name" && value is string s) Name = s; return this; }
    }
    private sealed record Code(string Text);
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => n.UsedBy;
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => null;
        protected override IReadOnlySet<string> KindNames(Node n) => n.Kinds;
        protected override string? Expression(object value) => (value as Code)?.Text;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.ToList().Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }

    private static int keys;
    private static Node N(string kind, string name = "", params string[] kinds)
    {
        var node = new Node("K" + (++keys).ToString("D4"), kind, name, kinds);
        if (name.Length > 0) node.Props["Name"] = name;
        return node;
    }
    private static Node W(string kind, string name = "") => N(kind, name, "Widget");
    private static Node Event(Node widget, string property)
    {
        var e = widget.Add(N("UILifeCycleEvent"));
        widget.Set(property, e);
        return e;
    }

    // The writer of this model: what the kernel's writer does over the Model API (ModelSession), on these nodes.
    private sealed class Writer : IScreenHtmlWriter<Node>
    {
        public readonly List<string> Log = [];
        public Node Create(Node parent, string kind, Node? block, string? name = null)
        {
            Log.Add("create " + kind + (name != null ? " '" + name + "'" : ""));
            if (name != null && Refuses?.Invoke(parent, "create " + kind + " " + name) is { } refused) throw new InvalidOperationException(refused);
            var node = kind is "ExtendedProperty" or "Event" or "LocalVariable" or "InputParameter" or "Argument" ? N(kind, name ?? "") : W(kind, name ?? "");
            parent.Add(node);
            switch (kind) {
                case "IfWidget": node.Set("TrueBranch", node.Add(W("IfBranchWidget"))).Set("FalseBranch", node.Add(W("IfBranchWidget"))); break;
                case "Link" or "Button": Event(node, "OnClick"); break;
                case "Input": Event(node, "OnChange"); break;
                // A native Table is born with its HeaderRow and Row (O11: a MobileWidget each, widgets of the Table).
                case "TableRecords": node.Set("HeaderRow", node.Add(W("MobileWidget", "headerRow"))).Set("Row", node.Add(W("MobileWidget", "row"))); break;
                case "ExtendedProperty":
                    node.Set("Property", "").Set("Value", new Code(""));
                    if (parent.Props.GetValueOrDefault("ExtendedProperties") is not List<Node> list) parent.Set("ExtendedProperties", list = []);
                    list.Add(node);
                    break;
                case "MobileBlockInstanceWidget":
                    node.Set("SourceBlock", block);
                    // The platform names each slot after its placeholder (read-only: see Set).
                    foreach (var holder in Descendants(block!).Where(d => d.Kind == "PlaceholderWidget")) node.Add(W("PlaceholderContentWidget", holder.Name)).Set("Placeholder", holder);
                    break;
            }
            return node;
        }
        // The platform's refusal of a write (its own words), when a test asks for one.
        public Func<Node, string, string?>? Refuses;
        public void Set(Node node, string property, ScreenHtmlValue<Node> value)
        {
            Log.Add("set " + property);
            if (property == "Name" && node.Kind == "PlaceholderContentWidget") throw new InvalidOperationException("Widget does not support name changing");
            if (Refuses?.Invoke(node, property) is { } why) throw new InvalidOperationException(why);
            object? written = value.Type switch {
                'e' => new Code(value.Text), 'b' => value.Text == "True", '?' => null, 'r' => value.Target ?? (object)new Node("~", "Outside", value.Name ?? ""),
                'l' => value.Targets?.ToList(), _ => value.Text };
            if (written == null) node.Props.Remove(property); else node.Set(property, written);
            // An event that gets a destination gets one argument per input of it (the platform's own).
            if (property == "Destination" && written is Node target)
                foreach (var input in target.Children.Where(c => c.Kind == "InputParameter"))
                    if (!node.Children.Any(a => a.Props.GetValueOrDefault("Parameter") == input)) node.Add(N("Argument")).Set("Parameter", input);
        }
        public void Rename(Node node, string name) { Log.Add("rename"); node.Set("Name", name); }
        public void Delete(Node node)
        {
            Log.Add("delete " + node.Kind);
            node.Parent!.Children.Remove(node);
            if (node.Parent.Props.GetValueOrDefault("ExtendedProperties") is List<Node> list) list.Remove(node);
        }
        public Node Move(Node node, Node parent) { Log.Add("move"); node.Parent!.Children.Remove(node); parent.Add(node); return node; }
        public void Place(Node node, Node? after)
        {
            Log.Add("place");
            var siblings = node.Parent!.Children;
            siblings.Remove(node);
            siblings.Insert(after == null ? 0 : siblings.IndexOf(after) + 1, node);
        }
        public Node? Replacement(Node node) => null;
        private static IEnumerable<Node> Descendants(Node node) { foreach (var c in node.Children) { yield return c; foreach (var d in Descendants(c)) yield return d; } }
    }

    // A module with a block and a screen: the constructions of the page (data, a container with an input and its event, an If
    // with a list and a link with an argument, an HTML element with extended properties, a block instance with its slot, a
    // Visible that is not True, a table).
    private static Node Module()
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var text = new Node("T-Text", "BasicType", "Text"); var id = new Node("T-Id", "BasicType", "Long Integer");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var block = flow.Add(N("MobileBlock", "Card"));
        var title = block.Add(N("InputParameter", "Title")).Set("DataType", text);
        block.Set("InputParameters", new List<Node> { title });
        block.Add(W("PlaceholderWidget", "Content"));
        var screen = flow.Add(N("MobileScreen", "Orders"));
        var search = screen.Add(N("LocalVariable", "Search")).Set("DataType", text);
        var page = screen.Add(N("LocalVariable", "Page")).Set("DataType", id);
        screen.Set("LocalVariables", new List<Node> { search, page });
        var refresh = screen.Add(N("ScreenAction", "Refresh"));
        var open = screen.Add(N("ScreenAction", "Open"));
        var openId = open.Add(N("InputParameter", "Id")).Set("DataType", id);
        screen.Add(N("ScreenAction", "Clear"));
        var toolbar = screen.Add(W("Container", "Toolbar")).Set("Style", new Code("\"toolbar\""));
        var input = toolbar.Add(W("Input")).Set("Variable", new Code("Search"));
        Event(input, "OnChange").Set("Destination", refresh);
        toolbar.Add(W("TextWidget")).Set("Text", "Find");
        toolbar.Add(W("Expression")).Set("Value", new Code("Search"));
        var empty = screen.Add(W("IfWidget")).Set("Condition", new Code("Page = 0"));
        var yes = empty.Add(W("IfBranchWidget")); var no = empty.Add(W("IfBranchWidget"));
        empty.Set("TrueBranch", yes).Set("FalseBranch", no);
        yes.Add(W("TextWidget")).Set("Text", "No orders.");
        var list = no.Add(W("List", "Rows")).Set("Source", new Code("GetOrders.List"));
        var link = list.Add(W("Link")).Set("Style", new Code("\"row\""));
        Event(link, "OnClick").Set("Destination", open).Add(N("Argument")).Set("Parameter", openId).Set("Value", new Code("Page"));
        link.Add(W("Expression")).Set("Value", new Code("Search"));
        var section = screen.Add(W("AdvancedHtml")).Set("Tag", "section");
        var role = section.Add(N("ExtendedProperty")).Set("Property", "role").Set("Value", new Code("\"region\""));
        section.Set("ExtendedProperties", new List<Node> { role });
        section.Add(W("Container")).Set("Style", new Code("\"a\""));
        section.Add(W("Container")).Set("Style", new Code("\"b\""));
        var card = screen.Add(W("MobileBlockInstanceWidget")).Set("SourceBlock", block);
        card.Add(N("Argument")).Set("Parameter", title).Set("Value", new Code("\"Total\""));
        card.Add(W("PlaceholderContentWidget")).Set("Placeholder", block.Children.Last()).Add(W("TextWidget")).Set("Text", "Body");
        screen.Add(W("Container", "Hidden")).Set("Visible", new Code("Page > 0"));
        // An opaque node with children (a generic MobileWidget: the language has no row for it).
        screen.Add(W("MobileWidget", "Grid")).Add(W("Container")).Add(W("TextWidget")).Set("Text", "Header");
        // A native Table of two columns over the page's list (its HeaderRow and Row as O11 has them).
        var lines = screen.Add(W("TableRecords", "Lines")).Set("Source", new Code("GetOrders.List"));
        var head = lines.Add(W("MobileWidget", "headerRow"));
        var row = lines.Add(W("MobileWidget", "row"));
        lines.Set("HeaderRow", head).Set("Row", row);
        foreach (var (label, value) in new[] { ("Name", "GetOrders.List.Current.Order.Name"), ("Total", "GetOrders.List.Current.Order.Total") })
        {
            head.Add(W("HeaderCell")).Add(W("TextWidget")).Set("Text", label);
            row.Add(W("RowCell")).Add(W("Expression")).Set("Value", new Code(value));
        }
        // A container with a List of cards (where the battery writes a new data table, beside it).
        screen.Add(W("Container", "Panel")).Add(W("List", "Cards")).Set("Source", new Code("GetOrders.List")).Add(W("TextWidget")).Set("Text", "Card");
        return module;
    }

    private static ScreenHtml.Node TableOf(ScreenHtml.Node tree, string id) =>
        ScreenHtmlText.Elements(tree).Select(x => x.Node).Single(n => n.Tag == "table" && n.Get("id") == id);

    // B1 of the review of round 1: a new native Table in an edit keeps its rows (the Order of a new element took O11's
    // MobileWidget rows for widgets the edit did not write, and deleted them); the page reads back with it.
    [Fact]
    public void AnEditAddsANativeTableToAPageAndItKeepsItsRows()
    {
        var module = Module();
        var (_, document) = Read(module);
        var table = "<table list=\"GetOrders.List\" class=\"added\"><thead><tr><th>Item</th><th>Page</th></tr></thead>"
            + "<tbody><tr><td>{{ GetOrders.List.Current.Order.Name }}</td><td>{{ Page }}</td></tr></tbody></table>\n";
        var tree = ScreenHtml.Parse(document.Html);
        var section = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Tag == "section");
        section.Children.Add(ScreenHtml.Parse(table).Children[0]);
        var (result, after, _) = Apply(module, [ScreenHtmlText.Write(section)]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        var read = ScreenHtml.Parse(after);
        var added = ScreenHtmlText.Elements(read).Select(x => x.Node).Single(n => n.Tag == "table" && n.Get("class") == "added");
        Assert.Equal("GetOrders.List", added.Get("list"));
        Assert.Equal(["Item", "Page"], ScreenHtmlText.Elements(added).Select(x => x.Node).Where(n => n.Tag == "th").Select(n => string.Concat(n.Children.Where(c => c.IsText).Select(c => c.Text)).Trim()));
        Assert.Equal(2, ScreenHtmlText.Elements(added).Count(x => x.Node.Tag == "td"));
        var again = ScreenHtml.Module(module, new Reader()).Read("Orders");
        Assert.Empty(again.Compare(again.Html));
    }

    // M1 of the review of round 1: half a column of a native Table is refused once, with the Table's k, the pointer of the edit and
    // the patch that removes the other half (the whole column); the patch plans and applies.
    [Fact]
    public void HalfAColumnOfANativeTableIsRefusedOnceWithThePatchThatRemovesTheWholeColumn()
    {
        foreach (var cell in new[] { "th", "td" })
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var half = ScreenHtmlText.Elements(table).Select(x => x.Node).Where(n => n.Tag == cell).Last();
            ScreenHtmlText.Parents(tree)[half].Children.Remove(half);
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            Assert.True(plan.Refused);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_COLUMN", problem["code"]!.ToString());
            Assert.Equal(table.Get("k"), problem["k"]!.ToString());
            Assert.False(string.IsNullOrEmpty(problem["pointer"]?.ToString()));
            Assert.Contains("remove the whole column", problem["fix"]!.ToString());
            var patched = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            var lines = TableOf(ScreenHtml.Parse(after), "Lines");
            Assert.Single(ScreenHtmlText.Elements(lines), x => x.Node.Tag == "th");
            Assert.Single(ScreenHtmlText.Elements(lines), x => x.Node.Tag == "td");
            Assert.DoesNotContain(">Total<", after);
        }
    }

    // M-A of the review of round 2: colspan in an edit follows the document's rule (HTML_TABLE_COLSPAN), refused once with the
    // Table's k, the pointer and the patch that writes the cell without colspan and one empty cell per column it spanned. A column of
    // the reading keeps its own cell, emptied, with its k (the platform deletes the whole column with either of its cells): the patch never
    // removes a column of data (it removed the other cell and left the colspan: a header one column wider than the rows).
    [Fact]
    public void ColspanOfANativeTableInAnEditIsRefusedOnceWithThePatchThatWritesTheColumnsItSpannedAsEmptyCells()
    {
        foreach (var tag in new[] { "th", "td" })
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var cells = ScreenHtmlText.Elements(table).Select(x => x.Node).Where(n => n.Tag == tag).ToList();
            var spanned = cells[1].Get("k");
            Assert.NotNull(spanned);
            cells[0].Attributes.Add(new("colspan", "2"));
            ScreenHtmlText.Parents(tree)[cells[1]].Children.Remove(cells[1]);
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            Assert.True(plan.Refused);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_COLSPAN", problem["code"]!.ToString());
            Assert.Equal(table.Get("k"), problem["k"]!.ToString());
            Assert.False(string.IsNullOrEmpty(problem["pointer"]?.ToString()));
            var patched = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            var written = ScreenHtmlText.Elements(ScreenHtml.Parse(Assert.Single(patched))).Select(x => x.Node).Where(n => n.Tag == tag).ToList();
            Assert.Equal(2, written.Count);
            Assert.All(written, c => Assert.Null(c.Get("colspan")));
            Assert.Equal(spanned, written[1].Get("k"));
            Assert.DoesNotContain(written[1].Children, c => !c.IsText || c.Text!.Trim().Length > 0);
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            var lines = TableOf(ScreenHtml.Parse(after), "Lines");
            Assert.Equal(2, ScreenHtmlText.Elements(lines).Count(x => x.Node.Tag == "th"));
            Assert.Equal(2, ScreenHtmlText.Elements(lines).Count(x => x.Node.Tag == "td"));
            Assert.DoesNotContain("colspan", after);
        }
        // A new data table in an edit: the columns it spanned are new empty cells, the document's patch.
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var section = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Tag == "section");
            section.Children.Add(ScreenHtml.Parse("<table list=\"GetOrders.List\" class=\"added\"><thead><tr><th colspan=\"2\">Item</th></tr></thead>"
                + "<tbody><tr><td>{{ GetOrders.List.Current.Order.Name }}</td><td>{{ Page }}</td></tr></tbody></table>").Children[0]);
            var plan = reading.Edit(document, [ScreenHtmlText.Write(section)]);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_COLSPAN", problem["code"]!.ToString());
            var patched = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            Assert.Contains("<th>Item</th>", Assert.Single(patched).Replace("\n", "").Replace(" ", ""));
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            var added = ScreenHtmlText.Elements(ScreenHtml.Parse(after)).Select(x => x.Node).Single(n => n.Tag == "table" && n.Get("class") == "added");
            Assert.Equal(2, ScreenHtmlText.Elements(added).Count(x => x.Node.Tag == "th"));
            Assert.Equal(2, ScreenHtmlText.Elements(added).Count(x => x.Node.Tag == "td"));
        }
    }

    // The family of M1 the colspan patch of round 3 relies on (its probes C1, C3 and C4): a cell of the reading written again without
    // its k while the other cell of its column stays, the rows as many. The platform deletes the whole column with either of its cells,
    // so the Verify found a cell short and kept nothing; the plan refuses it once (HTML_TABLE_COLUMN) with the patch that gives the new
    // cell of that column the k of the column's own, its content the edit's (it plans and applies).
    [Fact]
    public void ACellWrittenAgainWithoutItsKWhileTheOtherCellOfItsColumnStaysIsRefusedWithThePatchThatKeepsTheColumnsOwn()
    {
        foreach (var (tag, text) in new[] { ("th", "<th>Amount</th>"), ("td", "<td>{{ Page }}</td>") })
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var cells = ScreenHtmlText.Elements(table).Select(x => x.Node).Where(n => n.Tag == tag).ToList();
            var own = cells[1].Get("k")!;
            var row = ScreenHtmlText.Parents(tree)[cells[1]];
            row.Children[row.Children.IndexOf(cells[1])] = ScreenHtml.Parse(text).Children[0];
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_COLUMN", problem["code"]!.ToString());
            Assert.Equal(table.Get("k"), problem["k"]!.ToString());
            Assert.Contains("<" + tag + " k=\"" + own + "\">", problem["message"]!.ToString());
            var patched = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            var written = ScreenHtmlText.Elements(ScreenHtml.Parse(Assert.Single(patched))).Select(x => x.Node).Where(n => n.Tag == tag).ToList();
            Assert.Equal(own, written[1].Get("k"));
            Assert.Equal(ScreenHtmlText.Write(ScreenHtml.Parse(text).Children[0]).Replace("<" + tag, "<" + tag + " k=\"" + own + "\""), ScreenHtmlText.Write(written[1]));
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            var lines = TableOf(ScreenHtml.Parse(after), "Lines");
            Assert.Equal(2, ScreenHtmlText.Elements(lines).Count(x => x.Node.Tag == "th"));
            Assert.Equal(2, ScreenHtmlText.Elements(lines).Count(x => x.Node.Tag == "td"));
            Assert.Contains(tag == "th" ? "Amount" : "{{ Page }}", ScreenHtmlText.Write(lines));
        }
    }

    // The owner's decision of 2026-10-19 (round 4): a cell of a native Table spans one column and one row. colspan with the rows as
    // many cells (the header one column wider than the rows) and rowspan (on the template row it pushes the next record's row; on
    // the header row too), in any case and with ext:, written new are refused (HTML_TABLE_COLSPAN, the Table's k, the pointer), every
    // cell of every table of the edit in one refusal with the other rules of the table, and one patch that removes them all, which
    // plans and applies: the table reads back as it was.
    [Fact]
    public void ACellOfANativeTableThatSpansAColumnOrARowWrittenNewIsOneRefusalWhosePatchRemovesTheSpan()
    {
        foreach (var (tag, at, attribute, value) in new[] { ("th", 0, "colspan", "2"), ("td", 1, "colspan", "3"), ("td", 0, "rowspan", "2"), ("th", 1, "rowspan", "2"),
                     ("th", 1, "COLSPAN", "2"), ("td", 1, "ext:rowspan", "2") })
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            ScreenHtmlText.Elements(table).Select(x => x.Node).Where(n => n.Tag == tag).ElementAt(at).Attributes.Add(new(attribute, value));
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            Assert.True(plan.Refused, attribute + " on a " + tag);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_COLSPAN", problem["code"]!.ToString());
            Assert.Equal(table.Get("k"), problem["k"]!.ToString());
            Assert.Contains(attribute + "=\"" + value + "\"", problem["message"]!.ToString());
            Assert.False(string.IsNullOrEmpty(problem["pointer"]?.ToString()));
            var patched = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            Assert.DoesNotContain("span=", Assert.Single(patched), StringComparison.OrdinalIgnoreCase);
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            Assert.Equal(document.Html, after);
        }
        // Every cell of every table in one refusal, beside the other rules of a table: colspan on a header cell and rowspan on a row
        // cell of the reading's Table with an attribute of its <tbody>, and a new data table with rowspan on its header and colspan
        // on its template row, in one edit list.
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var parts = ScreenHtmlText.Elements(table).Select(x => x.Node).ToList();
            parts.First(n => n.Tag == "th").Attributes.Add(new("colspan", "2"));
            parts.Last(n => n.Tag == "td").Attributes.Add(new("rowspan", "2"));
            parts.First(n => n.Tag == "tbody").Attributes.Add(new("data-x", "1"));
            var section = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Tag == "section");
            section.Children.Add(ScreenHtml.Parse("<table list=\"GetOrders.List\" class=\"added\"><thead><tr><th rowspan=\"2\">Item</th><th>Page</th></tr></thead>"
                + "<tbody><tr><td colspan=\"2\">{{ GetOrders.List.Current.Order.Name }}</td><td>{{ Page }}</td></tr></tbody></table>").Children[0]);
            var plan = reading.Edit(document, [ScreenHtmlText.Write(section), ScreenHtmlText.Write(table)]);
            Assert.True(plan.Refused);
            Assert.Equal(["HTML_TABLE_COLSPAN", "HTML_TABLE_COLSPAN", "HTML_TABLE_COLSPAN", "HTML_TABLE_COLSPAN", "HTML_TABLE_PART"],
                plan.Result.Problems.Select(p => p["code"]!.ToString()).Order(StringComparer.Ordinal));
            Assert.Equal(2, plan.Result.Problems.Count(p => p["k"]?.ToString() == table.Get("k") && p["code"]!.ToString() == "HTML_TABLE_COLSPAN"));
            var patches = plan.Result.Problems.Select(p => p["patch"]![0]!["value"]!.ToJsonString()).Distinct().ToList();
            var patched = JsonNode.Parse(Assert.Single(patches))!.AsArray().Select(e => e!.ToString()).ToList();
            Assert.All(patched, p => Assert.DoesNotContain("span=", p, StringComparison.Ordinal));
            Assert.All(patched, p => Assert.DoesNotContain("data-x", p, StringComparison.Ordinal));
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            var read = ScreenHtml.Parse(after);
            Assert.Equal(ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(TableOf(ScreenHtml.Parse(document.Html), "Lines"))), ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(TableOf(read, "Lines"))));
            var added = ScreenHtmlText.Elements(read).Select(x => x.Node).Single(n => n.Tag == "table" && n.Get("class") == "added");
            Assert.Equal(2, ScreenHtmlText.Elements(added).Count(x => x.Node.Tag == "th"));
            Assert.Equal(2, ScreenHtmlText.Elements(added).Count(x => x.Node.Tag == "td"));
            Assert.DoesNotContain("span=", after, StringComparison.Ordinal);
        }
    }

    // What the reading has stays (as the Visible): a cell of a native Table the Studio gave colspan or rowspan (an extended property)
    // reads with it at the fixed point, and an edit that keeps it (the table written again with a text changed, the whole page sent
    // back) is no refusal and reads back as written. A new value of it is written new: refused, the patch removes it.
    [Fact]
    public void ASpanACellOfANativeTableHasInTheReadingStaysAndANewValueOfItIsRefused()
    {
        static Node Spanned()
        {
            var module = Module();
            var lines = Find(module, n => n.Kind == "TableRecords" && n.Name == "Lines");
            var head = lines.Children.Single(c => c.Name == "headerRow").Children.First(c => c.Kind == "HeaderCell");
            var row = lines.Children.Single(c => c.Name == "row").Children.Last(c => c.Kind == "RowCell");
            foreach (var (cell, property) in new[] { (head, "colspan"), (row, "rowspan") })
                cell.Set("ExtendedProperties", new List<Node> { cell.Add(N("ExtendedProperty")).Set("Property", property).Set("Value", new Code("\"2\"")) });
            return module;
        }
        {
            var (_, document) = Read(Spanned());
            var lines = ScreenHtmlText.Write(TableOf(ScreenHtml.Parse(document.Html), "Lines"));
            Assert.Contains("colspan=\"2\"", lines);
            Assert.Contains("rowspan=\"2\"", lines);
            Assert.Empty(document.Compare(document.Html));
        }
        // The table written again, a header text changed beside the spans.
        {
            var module = Spanned();
            var (_, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var name = Texts(table).First(t => t.Text!.Trim() == "Name");
            name.Text = name.Text!.Replace("Name", "Order", StringComparison.Ordinal);
            var (result, after, _) = Apply(module, [ScreenHtmlText.Write(table)]);
            Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
            var lines = ScreenHtmlText.Write(TableOf(ScreenHtml.Parse(after), "Lines"));
            Assert.Contains("colspan=\"2\"", lines);
            Assert.Contains("rowspan=\"2\"", lines);
            Assert.Contains("Order", lines);
            var again = ScreenHtml.Module(module, new Reader()).Read("Orders");
            Assert.Empty(again.Compare(again.Html));
        }
        // The whole page sent back as the edit (the html form).
        {
            var module = Spanned();
            var (_, document) = Read(module);
            var (result, after, _) = Apply(module, [document.Html]);
            Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
            Assert.Equal(document.Html, after);
        }
        // A new value of the reading's colspan: refused, the patch removes it; the reading's rowspan stays.
        {
            var module = Spanned();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var th = ScreenHtmlText.Elements(table).Select(x => x.Node).First(n => n.Tag == "th");
            th.Attributes[th.Attributes.FindIndex(a => a.Key == "colspan")] = new("colspan", "3");
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_COLSPAN", problem["code"]!.ToString());
            Assert.Contains("colspan=\"3\"", problem["message"]!.ToString());
            var (result, after, _) = Apply(module, problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList());
            Assert.False(result.Refused, Codes(result));
            var lines = ScreenHtmlText.Write(TableOf(ScreenHtml.Parse(after), "Lines"));
            Assert.DoesNotContain("colspan", lines);
            Assert.Contains("rowspan=\"2\"", lines);
        }
    }

    // M-B and L1 of the review of round 2: what an edit writes on the parts of a native Table follows the document's rule. An
    // attribute of a <thead>, <tbody> or <tr> the Table has no property for is refused once each (HTML_TABLE_PART), with the Table's
    // k, the pointer and the patch that removes them all (it plans and applies); the class of a section joins its row's, said in
    // normalized (TABLE_NATIVE), never in silence.
    [Fact]
    public void AnAttributeOfAPartOfANativeTableInAnEditIsRefusedOnceWithItsPatchAndASectionClassJoinsItsRowAndIsSaid()
    {
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var parts = ScreenHtmlText.Elements(table).Select(x => x.Node).ToList();
            parts.First(n => n.Tag == "tbody").Attributes.Add(new("data-x", "1"));
            parts.First(n => n.Tag == "tr").Attributes.Add(new("aria-label", "head"));
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            Assert.Equal(["HTML_TABLE_PART", "HTML_TABLE_PART"], plan.Result.Problems.Select(p => p["code"]!.ToString()));
            Assert.All(plan.Result.Problems, p => { Assert.Equal(table.Get("k"), p["k"]!.ToString()); Assert.False(string.IsNullOrEmpty(p["pointer"]?.ToString())); });
            var patched = plan.Result.Problems[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            Assert.Equal(patched, plan.Result.Problems[1]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()));
            Assert.DoesNotContain("data-x", patched[0]);
            Assert.DoesNotContain("aria-label", patched[0]);
            var (result, after, _) = Apply(module, patched);
            Assert.False(result.Refused, Codes(result));
            Assert.Equal(document.Html, after);
        }
        // The List's attribute on a <tbody> while the list is on the <table> (no List there): refused with its patch; the class of
        // that <tbody> joins the row's, said.
        {
            var module = Module();
            var (reading, document) = Read(module);
            var tree = ScreenHtml.Parse(document.Html);
            var table = TableOf(tree, "Lines");
            var body = ScreenHtmlText.Elements(table).Select(x => x.Node).First(n => n.Tag == "tbody");
            body.Attributes.Add(new("class", "zebra")); body.Attributes.Add(new("os-Mode", "Custom"));
            var plan = reading.Edit(document, [ScreenHtmlText.Write(table)]);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal("HTML_TABLE_PART", problem["code"]!.ToString());
            Assert.Contains("os-Mode", problem["message"]!.ToString());
            var (result, after, _) = Apply(module, problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList());
            Assert.False(result.Refused, Codes(result));
            Assert.Contains(result.Normalized, n => n["code"]?.ToString() == "TABLE_NATIVE" && n["note"]!.ToString().Contains("<tbody class> joins the class of its <tr> (StyleRow)", StringComparison.Ordinal));
            Assert.Contains("zebra", TableOf(ScreenHtml.Parse(after), "Lines").Children.Where(c => !c.IsText).Select(ScreenHtmlText.Write).Last());
        }
        // The class of a <thead>: accepted, the header row's class (StyleHeader), said.
        {
            var module = Module();
            var tree = ScreenHtml.Parse(Read(module).Document.Html);
            var table = TableOf(tree, "Lines");
            ScreenHtmlText.Elements(table).Select(x => x.Node).First(n => n.Tag == "thead").Attributes.Add(new("class", "dark"));
            var (result, after, _) = Apply(module, [ScreenHtmlText.Write(table)]);
            Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
            var note = Assert.Single(result.Normalized, n => n["code"]?.ToString() == "TABLE_NATIVE");
            Assert.Equal(table.Get("k"), note["k"]!.ToString());
            Assert.Contains("<thead class> joins the class of its <tr> (StyleHeader)", note["note"]!.ToString());
            var head = ScreenHtmlText.Elements(TableOf(ScreenHtml.Parse(after), "Lines")).Select(x => x.Node).First(n => n.Tag == "tr");
            Assert.Contains("dark", head.Get("class") ?? "");
        }
    }

    // B1 of the review of round 2: the three-way merge matches the parts of a native Table (its thead, tbody and their one row, which
    // carry no k) by their owner, and the parts of any other table as elements. A new static table of two rows, of two header rows or
    // of two bodies, written on an older reading, merges, and what the Studio changed since stays (the two new rows had one identity:
    // no merge, and the edit's whole text replaced the screen).
    [Fact]
    public void ANewStaticTableOfTwoRowsWrittenOnAnOlderReadingMergesThreeWaysBesideANativeTable()
    {
        foreach (var table in new[] {
            "<table class=\"detail\"><tbody><tr><th>Name</th><td>{{ Search }}</td></tr><tr><th>Page</th><td>{{ Page }}</td></tr></tbody></table>",
            "<table class=\"detail\"><thead><tr><th>A</th></tr><tr><th>B</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>",
            "<table class=\"detail\"><tbody><tr><td>a</td></tr></tbody><tbody><tr><td>b</td></tr></tbody></table>" })
        {
            var module = Module();
            var (_, older) = Read(module);
            Find(module, n => n.Name == "Toolbar").Set("Style", new Code("\"toolbar dark\""));
            var (reading, current) = Read(module);
            var tree = ScreenHtml.Parse(older.Html);
            var section = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Tag == "section");
            section.Children.Add(ScreenHtml.Parse(table).Children[0]);
            // The native Table's first header text, in the same edit: its parts are still matched by their owner.
            var lines = TableOf(tree, "Lines");
            var name = Texts(lines).First(t => t.Text!.Trim() == "Name");
            name.Text = name.Text!.Replace("Name", "Order", StringComparison.Ordinal);
            var merged = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), current.Html, Keys(current), [ScreenHtmlText.Write(section), ScreenHtmlText.Write(lines)]);
            Assert.NotNull(merged.Document);
            Assert.Empty(merged.Conflicts);
            Assert.Empty(merged.Missing);
            Assert.Contains("class=\"toolbar dark\"", merged.Document);
            var plan = reading.Edit(current, [merged.Document!]);
            Assert.False(plan.Refused, Codes(plan.Result) + " " + string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
            plan.Apply(new Writer());
            plan.Verify(reading.Refresh(current.RootKey).Read("Orders"));
            Assert.False(plan.Refused, string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
            var after = ScreenHtml.Module(module, new Reader()).Read("Orders").Html;
            Assert.Contains("class=\"toolbar dark\"", after);
            Assert.Contains("class=\"detail\"", after);
            Assert.Contains("Order", Texts(TableOf(ScreenHtml.Parse(after), "Lines")).Select(t => t.Text!.Trim()));
        }
    }

    private static IEnumerable<ScreenHtml.Node> Texts(ScreenHtml.Node node)
    {
        foreach (var child in node.Children)
            if (child.IsText) yield return child;
            else foreach (var inner in Texts(child)) yield return inner;
    }

    // The ODC builder compiles ScreenHtmlModule.cs without ScreenVisual (Builder.csproj, BuilderLinkClosureTests): the markers of
    // the engine a part of a native Table leaves to their own rule are ScreenVisual's, in every spelling.
    [Fact]
    public void TheMarkersAPartOfANativeTableLeavesToTheirOwnRuleAreTheEngines()
    {
        foreach (var marker in Anvil.Core.ScreenVisual.EngineMarkers)
            foreach (var spelling in new[] { marker, marker.ToUpperInvariant(), "ext:" + marker, "EXT:" + marker.ToUpperInvariant() })
                Assert.True(ScreenHtmlTables.IsEngineMarker(spelling), spelling);
        foreach (var other in new[] { "data-ssam", "data-ssam-pages", "data-x", "class", "list", "ext:data-x" })
            Assert.Equal(Anvil.Core.ScreenVisual.MarkerOf(other) != null, ScreenHtmlTables.IsEngineMarker(other));
    }

    // M4 of the review of round 1: the synthetic battery edits whole columns of a native Table and writes new data tables, and
    // each of those edits reads back as written.
    [Fact]
    public void TheBatteryEditsWholeColumnsAndAddsDataTablesAndEachReadsBack()
    {
        var kinds = new HashSet<string>();
        for (var seed = 1; seed <= 12; seed++)
        {
            var (reading, document) = Read(Module());
            foreach (var edit in ScreenHtmlEditBattery.Generate(document, seed, 1, k => !reading.UsedOutside(document, k), reading.ActionNames(document)).Where(e => e.Kind is "column" or "table"))
            {
                kinds.Add(edit.Kind + ":" + edit.Note.Split(' ')[0]);
                var (result, after, _) = Apply(Module(), edit.Edits);
                Assert.False(result.Refused, edit.Note + ": " + Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
                Assert.Equal(edit.Expected, ScreenHtmlText.WithoutKeys(after));
            }
        }
        Assert.Contains("table:new", kinds);
        Assert.True(kinds.Count(k => k.StartsWith("column:", StringComparison.Ordinal)) >= 2, string.Join(", ", kinds));
    }

    private static (ScreenHtmlModule<Node> Reading, ScreenHtmlDocument Document) Read(Node module, string target = "Orders")
    {
        var reading = ScreenHtml.Module(module, new Reader());
        return (reading, reading.Read(target));
    }

    // Plan, apply and read back; the answer of the edit and the text read after it.
    private static (ScreenHtmlEditResult Result, string After, Writer Writer) Apply(Node module, IReadOnlyList<string> edits, string target = "Orders")
    {
        var (reading, document) = Read(module, target);
        var plan = reading.Edit(document, edits);
        var writer = new Writer();
        if (!plan.Refused) plan.Apply(writer);
        if (!plan.Refused) plan.Verify(reading.Refresh(document.RootKey).Read(target));
        return (plan.Result, ScreenHtml.Module(module, new Reader()).Read(target).Html, writer);
    }

    private static string Line(string html, string k) => html.Split('\n').First(l => l.Contains(" k=\"" + k + "\"", StringComparison.Ordinal)).Trim();
    private static string Codes(ScreenHtmlEditResult result) => string.Join(", ", result.Problems.Select(p => p["code"]!.ToString()));

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void RemovingWrapperPreservesMovedReferencesButRejectsActualReferencedDeletion(bool deleteTarget, bool consumerMoves)
    {
        var module = N("ESpace", "Shop");
        var screen = module.Add(N("MobileFlow", "MainFlow")).Add(N("MobileScreen", "Orders"));
        var wrapper = screen.Add(W("Container", "Wrapper"));
        var target = wrapper.Add(W("Container", "Result"));
        var retained = wrapper.Add(W("Container", "Retained"));
        var consumer = consumerMoves ? retained : screen.Add(N("ScreenAction", "Refresh")).Add(N("AjaxRefreshNode"));
        target.UsedBy.Add(consumer);
        var (_, before) = Read(module);
        var root = before.Html.Split('\n').First(l => l.StartsWith("<screen"));
        var targetKey = before.Keys.Single(p => p.Value == target.Key).Key;
        var retainedKey = before.Keys.Single(p => p.Value == retained.Key).Key;
        var html = root + "\n" + (deleteTarget ? "" : Line(before.Html, targetKey) + "\n")
            + Line(before.Html, retainedKey) + "\n</screen>\n";
        var (result, _, writer) = Apply(module, [html]);
        Assert.Equal(deleteTarget, result.Refused);
        if (deleteTarget) {
            Assert.Contains("HTML_DELETE_IN_USE", Codes(result));
            Assert.Empty(writer.Log);
            Assert.Same(wrapper, target.Parent);
        } else {
            Assert.Same(screen, target.Parent);
            Assert.Same(consumer, Assert.Single(target.UsedBy));
            Assert.DoesNotContain(wrapper, screen.Children);
            Assert.Contains("move", writer.Log);
        }
    }

    [Fact]
    public void EverySyntheticEditOfTheScreenAndTheBlockReadsBackAsTheEditedText()
    {
        var count = 0;
        foreach (var target in new[] { "Orders", "Card" })
            foreach (var seed in Enumerable.Range(1, 4)) {
                var (_, document) = Read(Module(), target);
                foreach (var edit in ScreenHtmlEditBattery.Generate(document, seed, perKind: 2)) {
                    var module = Module();
                    var (result, after, _) = Apply(module, edit.Edits, target);
                    Assert.False(result.Refused, edit.Kind + " " + edit.Note + ": " + string.Join(" | ", result.Problems.Select(p => p["message"])));
                    Assert.Equal(edit.Expected, ScreenHtmlText.WithoutKeys(after));
                    count++;
                }
            }
        Assert.True(count >= 20, "edits " + count);
    }

    [Fact]
    public void AClassChangeIsOneSetAndEveryKeyStays()
    {
        var module = Module();
        var (_, before) = Read(module);
        var edited = Line(before.Html, "w3").Replace("class=\"toolbar\"", "class=\"toolbar compact\"");
        var toolbar = before.Html.Split('\n').SkipWhile(l => !l.Contains("k=\"w3\"")).TakeWhile(l => !l.StartsWith("</div>")).ToList();
        var edit = string.Join("\n", toolbar.Skip(1).Prepend(edited)) + "\n</div>\n";
        var (result, after, writer) = Apply(module, [edit]);
        Assert.False(result.Refused, Codes(result));
        Assert.Equal(["set Style"], writer.Log);
        Assert.Equal(before.Html.Replace("class=\"toolbar\"", "class=\"toolbar compact\""), after);
        Assert.Equal(before.Keys, ScreenHtml.Module(module, new Reader()).Read("Orders").Keys);
    }

    // Meta de 20/10/2026, item 7 (relatos 6bd23d43, 9540e92c): "the platform refused set Name: Widget does not support name
    // changing" named no element. The refusal now says the element (kind, k) and what to do with a kind that takes no name.
    [Fact]
    public void ARefusalOfThePlatformNamesTheElementAndWhatToDo()
    {
        var module = Module();
        var (reading, before) = Read(module);
        // The first container of the section (k=w9, class "a") gets a Name (the id attribute of ssam-html; a name attribute is
        // an HTML attribute of the tag); the platform of this test refuses to name that kind.
        var line = Line(before.Html, "w9");
        Assert.DoesNotContain("id=", line);
        var edit = line.Replace("k=\"w9\"", "k=\"w9\" id=\"Total\"") + "\n";
        var plan = reading.Edit(before, [edit]);
        Assert.False(plan.Refused, Codes(plan.Result) + " " + string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
        var writer = new Writer { Refuses = (node, property) => property == "Name" && node.Kind == "Container" ? "Widget does not support name changing" : null };
        plan.Apply(writer);
        Assert.Contains("set Name", writer.Log);
        var problem = Assert.Single(plan.Result.Problems);
        Assert.Equal("HTML_EDIT_NOT_APPLIED", problem["code"]!.ToString());
        Assert.Equal("w9", problem["k"]!.ToString());
        var message = problem["message"]!.ToString();
        Assert.Contains("set Name on Container 'Total' k=\"w9\"", message);
        Assert.Contains("Widget does not support name changing", message);
        // L3d (24/10): no kind of the fixtures refuses the rename of a widget of the reading; when one does, the fix keeps the name
        // read, or creates the widget again with the name when nothing outside the page uses it (it never says the kind takes no
        // name: an Expression, a Text and an Icon take one).
        var fix = problem["fix"]!.ToString();
        Assert.Contains("the platform does not rename this widget: keep the name the reading shows: send k=\"w9\" without id", fix);
        Assert.Contains("create it again with the name (write it without k and with id=\"Total\"", fix);
        Assert.DoesNotContain("takes no name", fix);
    }

    [Fact]
    public void ANewChildARemovalASwapAndAnEventAreTheirOwnMoves()
    {
        var module = Module();
        var (_, before) = Read(module);
        // The section: a new paragraph between its two containers, swapped, its role removed.
        var section = "<section k=\"w8\">\n <div k=\"w10\" class=\"b\"/>\n <p class=\"new\">{{ \"x\" }}</p>\n <div k=\"w9\" class=\"a\"/>\n</section>\n";
        // The link: another destination (no argument).
        var link = Line(before.Html, "w7").Replace("onclick=\"Open(Id = Page)\"", "onclick=\"Clear\"");
        var (result, after, writer) = Apply(module, [section, link + "\n"]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        Assert.Contains("<section k=\"w8\">\n <div k=\"w9\" class=\"b\"/>\n <p k=\"w10\" class=\"new\">{{ \"x\" }}</p>\n <div k=\"w11\" class=\"a\"/>\n</section>\n", after);
        Assert.Contains("onclick=\"Clear\"", after);
        Assert.Contains("delete ExtendedProperty", writer.Log);
        Assert.Contains("create AdvancedHtml", writer.Log);
        Assert.Contains("place", writer.Log);
        Assert.DoesNotContain(writer.Log, l => l.StartsWith("delete Container", StringComparison.Ordinal));
    }

    [Fact]
    public void AnElementWrappedInANewIfMovesIntoItsBranch()
    {
        var module = Module();
        var (_, before) = Read(module);
        var section = "<section k=\"w8\" role=\"region\">\n <div if=\"Page > 1\">\n  <div k=\"w9\" class=\"a\"/>\n </div>\n <div k=\"w10\" class=\"b\"/>\n</section>\n";
        var (result, after, writer) = Apply(module, [section]);
        Assert.False(result.Refused, Codes(result));
        Assert.Contains("<section k=\"w8\" role=\"region\">\n <div k=\"w9\" if=\"Page > 1\">\n  <div k=\"w10\" class=\"a\"/>\n </div>\n <div k=\"w11\" class=\"b\"/>\n</section>\n", after);
        Assert.Equal(["create IfWidget", "move"], writer.Log.Where(l => l is "create IfWidget" or "move"));
    }

    // Live on 20/10 (SSAM_DumpProbe, item 7 of the meta): a new Web Block instance with an id was created and then named, and
    // the platform refused "Widget does not support name changing" (21 tasks of the survey). The name goes with the creation.
    [Fact]
    public void ANewWidgetIsNamedAtItsCreation()
    {
        var module = Module();
        var (_, before) = Read(module);
        var section = "<section k=\"w8\" role=\"region\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n <div id=\"Total\"/>\n</section>\n";
        var (result, after, writer) = Apply(module, [section]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        Assert.Contains("create Container 'Total'", writer.Log);
        Assert.DoesNotContain("set Name", writer.Log);
        Assert.Contains("<div k=\"w11\" id=\"Total\"/>", after);
    }

    // 793ca579 (live, 20/10): a new <Block name="Modal"> of OutSystemsUIWeb resolved the producer's folder Modal (nearest
    // tier) and the platform refused "IFolderSignature, not IWebBlockSignature". A folder named like the block here: the new
    // block takes the block.
    [Theory, InlineData(false), InlineData(true)]
    public void ANewBlockTakesTheBlockWhenAFolderHasItsName(bool folder)
    {
        var module = Module();
        if (folder) module.Add(N("Folder", "Card"));
        // A second placeholder the edit will not write: the platform creates its slot, empty (Modal's Title, Icon, Footer).
        module.Children.First(c => c.Kind == "MobileFlow").Children.First(c => c.Kind == "MobileBlock").Add(W("PlaceholderWidget", "Footer"));
        var (_, before) = Read(module);
        Assert.Contains("k=\"w8\"", before.Html);
        var section = "<section k=\"w8\" role=\"region\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n <Block name=\"Card\">\n  <slot name=\"Content\"/>\n </Block>\n</section>\n";
        var (result, after, writer) = Apply(module, [section]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        Assert.Contains("create MobileBlockInstanceWidget", writer.Log);
        Assert.DoesNotContain("set Placeholder", writer.Log);
        Assert.Contains(result.Normalized, n => n["property"]?.ToString() == "slots" && n["value"]?.ToString() == "Footer");
        Assert.Contains("<slot name=\"Footer\"/>", after);
        Assert.Contains(folder ? "<Block k=\"w11\" name=\"MobileBlock:Card\">\n  <slot name=\"Content\"/>" : "<Block k=\"w11\" name=\"Card\">\n  <slot name=\"Content\"/>", after);
    }

    [Fact]
    public void AnIfIsEditedWithItsElseAndTheStyleIsTheStyleSheet()
    {
        var module = Module();
        var (_, before) = Read(module);
        var lines = before.Html.Split('\n');
        var start = Array.FindIndex(lines, l => l.Contains("k=\"w5\""));
        var end = Array.FindIndex(lines, Array.FindIndex(lines, start, l => l == "<div else>"), l => l == "</div>");
        var ifElse = string.Join("\n", lines[start..(end + 1)]).Replace("No orders.", "Nothing yet.") + "\n";
        var (result, after, _) = Apply(module, [ifElse, "<style>.x { color: red; }</style>"]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        Assert.Contains("Nothing yet.", after);
        Assert.Contains("<style>.x { color: red; }</style>", after);
    }

    [Fact]
    public void EveryProblemOfAnEditComesInOneAnswerWithItsFix()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var html = document.Html;
        var plan = reading.Edit(document, [
            "<div class=\"no-key\"/>",                                                           // no k
            "<div k=\"w99\"/>",                                                                   // a k the reading never wrote
            Line(html, "w13").Replace("kind=\"MobileWidget\"", "kind=\"Container\"") + "</os-opaque>\n",  // an opaque node changed
            Line(html, "w7").Replace("onclick=\"Open(Id = Page)\"", "onclick=\"Refrsh\"") + "\n",  // a name that names nothing
            Line(html, "w9").Replace("/>", " os-Visible=\"Page = 1\"/>", StringComparison.Ordinal) + "\n",
        ]);
        Assert.True(plan.Refused);
        var codes = plan.Result.Problems.Select(p => p["code"]!.ToString()).ToList();
        foreach (var code in new[] { ScreenHtmlEdit.NoKey, ScreenHtmlEdit.KeyForeign }) Assert.Contains(code, codes);
        // The merge stops at its own problems; the rest come once the edits merge.
        var second = reading.Edit(document, [
            Line(html, "w13").Replace("kind=\"MobileWidget\"", "kind=\"Container\"").Replace("\">", "\"/>") + "\n",
            Line(html, "w7").Replace("onclick=\"Open(Id = Page)\"", "onclick=\"Refrsh\"") + "\n",
            Line(html, "w9").Replace("/>", " os-Visible=\"Page = 1\"/>") + "\n",
            Line(html, "w10").Replace("/>", " data-x='{{ JSONSerialize(Page) }}'/>") + "\n",
        ]);
        var problems = second.Result.Problems.GroupBy(p => p["code"]!.ToString()).ToDictionary(g => g.Key, g => g.First());
        Assert.Contains(ScreenHtmlEdit.OpaqueTouched, problems.Keys);
        Assert.Equal("write 'Refresh'", problems[ScreenHtmlEdit.NameUnknown]["fix"]!.ToString());
        Assert.Contains(ScreenHtmlEdit.Json, problems.Keys);
        // Visible is never written new: the patch is the edit with an If around the element, and it plans clean.
        var visible = problems[ScreenHtmlEdit.Visible];
        var patched = visible["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.Contains(patched, e => e.Contains("<div if=\"Page = 1\">", StringComparison.Ordinal) && !e.Contains("os-Visible", StringComparison.Ordinal));
    }

    [Fact]
    public void AVisibleTheReadingHadIsKeptAndListed()
    {
        var module = Module();
        var (_, before) = Read(module);
        var hidden = Line(before.Html, "w12").Replace("os-Visible", "class=\"kept\" os-Visible") + "\n";
        var (result, after, _) = Apply(module, [hidden]);
        Assert.False(result.Refused, Codes(result));
        Assert.Equal("w12", result.VisiblePreserved.Single()["k"]!.ToString());
        Assert.Contains("class=\"kept\" os-Visible=\"Page > 0\"", after);
    }

    [Fact]
    public void TheActionsAndAScriptAreRefusedAndTheParserSaysWhere()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var first = document.Html.Split('\n')[0];
        var whole = document.Html.Replace(first, first.Replace("actions=\"Clear, Open, Refresh\"", "actions=\"Clear, Open, Refresh, Save\""));
        Assert.Contains(ScreenHtmlEdit.ActionsListed, Codes(reading.Edit(document, [whole]).Result));
        var script = reading.Edit(document, [Line(document.Html, "w9").Replace("/>", " onclick=\"alert('x'); return false\"/>") + "\n"]);
        Assert.Contains(ScreenHtmlEdit.Script, Codes(script.Result));
        var broken = reading.Edit(document, ["<div k=\"w9\" class=\"a\">"]);
        Assert.Contains("unclosed <div>", broken.Result.Problems.Single()["message"]!.ToString());
        // Without the module: the shape and the text of the op, every problem at once.
        var error = Assert.ThrowsAny<Exception>(() => ScreenHtmlEdit.Preflight(new JsonObject { ["edit"] = new JsonArray("<div class=\"x\"/>", "<p>") }));
        var preflight = (JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!;
        Assert.Equal(["/screen", "/basedOn", "/edit/0", "/edit/1"], preflight.Select(p => p!["pointer"]!.ToString()).ToArray());
    }

    [Fact]
    public void TheScriptsAndAForeignIterationOfAnEditComeOnceWithOneCheckedPatch()
    {
        // B3 (conferência of 2026-10-12): HTML_SCRIPT had no patch and v-for passed as an attribute. A <script> goes, a javascript:
        // event goes back to the reading's, an event that is no call goes, a v-for over a list of the page becomes the List; one
        // corrected edit list on each of them, and it plans clean.
        var module = Module();
        var screen = module.Children[0].Children.First(c => c.Kind == "MobileScreen");
        var tags = screen.Add(N("LocalVariable", "Tags")).Set("DataType", new Node("T-TextList", "ListType", "Text List"));
        ((List<Node>)screen.Props["LocalVariables"]!).Add(tags);
        var (reading, document) = Read(module);
        var html = document.Html;
        Assert.Contains("<var k=\"w3\" name=\"Tags\" type=\"Text List\"/>", html);
        var edited = html.Replace("onclick=\"Open(Id = Page)\"", "onclick=\"javascript:go()\"")
            .Replace("</screen>", "<ul class=\"tags\"><li v-for=\"t in Tags\">{{ t }}</li></ul>\n<span onclick=\"this.x = 1; go()\">y</span>\n<script>alert(1)</script>\n</screen>");
        var plan = reading.Edit(document, [edited]);
        Assert.True(plan.Refused);
        var problems = plan.Result.Problems;
        Assert.Equal(3, problems.Count(p => p["code"]!.ToString() == ScreenHtmlEdit.Script));
        Assert.Single(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.ForEach);
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.Invalid);   // the javascript: event said once, as a script
        Assert.All(problems, p => Assert.NotNull(p["patch"]));
        Assert.Single(problems.Select(p => p["patch"]!.ToJsonString()).Distinct());
        var corrected = problems[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        var text = string.Join("\n", corrected);
        Assert.Contains("onclick=\"Open(Id = Page)\"", text);
        Assert.Contains("<li list=\"Tags\">{{ Tags.Current }}</li>", text);
        Assert.DoesNotContain("<script", text);
        Assert.DoesNotContain("javascript:", text);
        Assert.DoesNotContain("this.x", text);
        Assert.False(reading.Edit(document, corrected).Refused, Codes(reading.Edit(document, corrected).Result));
        // A v-for over a name the page does not have: no certain List; the scripts keep their patch.
        var unknown = reading.Edit(document, [edited.Replace("v-for=\"t in Tags\"", "v-for=\"t in Labels\"")]).Result.Problems;
        Assert.Null(unknown.Single(p => p["code"]!.ToString() == ScreenHtmlEdit.ForEach)["patch"]);
        Assert.All(unknown.Where(p => p["code"]!.ToString() == ScreenHtmlEdit.Script), p => Assert.NotNull(p["patch"]));
        // Without the module (the preflight of the job): a new element's iteration and script event are said with the <script>.
        var error = Assert.ThrowsAny<Exception>(() => ScreenHtmlEdit.Preflight(new JsonObject { ["screen"] = "Orders",
            ["basedOn"] = new JsonObject { ["capture"] = "a", ["html"] = "b" }, ["edit"] = new JsonArray(edited) }));
        var preflight = ((JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!).Select(p => p!["code"]!.ToString()).ToList();
        Assert.Equal([ScreenHtmlEdit.ForEach, ScreenHtmlEdit.Script, ScreenHtmlEdit.Script], preflight.Order());
    }

    // The review of rounds 1 and 2 (k1, k2): an edit inside the element a later edit writes again was lost with the old subtree
    // (the new Visible of w9 gone, the job accepted); in the other order it was already HTML_EDIT_OVERLAP. Now both orders.
    [Fact]
    public void AnEditInsideAnElementALaterEditWritesAgainIsRefusedInEitherOrder()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var visible = Line(document.Html, "w9").Replace("/>", " os-Visible=\"Page = 1\"/>") + "\n";
        var section = "<section k=\"w8\" role=\"region\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n</section>\n";
        foreach (var edits in new[] { new[] { visible, section }, new[] { section, visible } }) {
            var plan = reading.Edit(document, edits);
            Assert.True(plan.Refused);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal(ScreenHtmlEdit.Overlap, problem["code"]!.ToString());
            Assert.Equal("w9", problem["k"]!.ToString());
        }
        // Made inside the outer edit, the change goes with it: the new Visible is refused with its If patch, never lost.
        var together = reading.Edit(document, [section.Replace("<div k=\"w9\" class=\"a\"/>", "<div k=\"w9\" class=\"a\" os-Visible=\"Page = 1\"/>")]);
        Assert.Contains(ScreenHtmlEdit.Visible, Codes(together.Result));
    }

    // L5 judged on what an attribute is in the browser (reviews r1 and r2): ext:onmouseover, OnMouseOver, an iframe src written
    // as a constant {{ "javascript:..." }} and srcdoc went in. Each is HTML_SCRIPT with the patch that removes it, in the edit, in
    // the preflight of a new element and in the document form; the corrected edit list plans clean.
    [Fact]
    public void AScriptByExtAnotherCaseAnExpressionUrlOrSrcdocIsRefusedWithItsPatch()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var w9 = Line(document.Html, "w9");
        var section = "<section k=\"w8\" role=\"region\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n"
            + " <iframe src='{{ \"javascript:alert(1)\" }}'/>\n <iframe srcdoc=\"&lt;script&gt;alert(1)&lt;/script&gt;\"/>\n</section>\n";
        foreach (var attribute in new[] { "ext:onmouseover=\"alert(1)\"", "OnMouseOver=\"alert(1)\"", "ONMOUSEOVER=\"alert(1)\"" }) {
            var plan = reading.Edit(document, [w9.Replace("/>", " " + attribute + "/>") + "\n"]);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal(ScreenHtmlEdit.Script, problem["code"]!.ToString());
            var corrected = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            Assert.DoesNotContain("alert", string.Join("\n", corrected));
            Assert.False(reading.Edit(document, corrected).Refused);
        }
        var page = reading.Edit(document, [section]);
        var scripts = page.Result.Problems.Where(p => p["code"]!.ToString() == ScreenHtmlEdit.Script).ToList();
        Assert.Equal(2, scripts.Count);
        Assert.All(scripts, p => Assert.NotNull(p["patch"]));
        var fixedPage = scripts[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.DoesNotContain("javascript:", string.Join("\n", fixedPage));
        Assert.DoesNotContain("srcdoc", string.Join("\n", fixedPage));
        // Without the module: the new elements of the edit (the preflight of the job).
        var error = Assert.ThrowsAny<Exception>(() => ScreenHtmlEdit.Preflight(new JsonObject { ["screen"] = "Orders",
            ["basedOn"] = new JsonObject { ["capture"] = "a", ["html"] = "b" }, ["edit"] = new JsonArray(section) }));
        Assert.Equal(2, ((JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!).Count(p => p!["code"]!.ToString() == ScreenHtmlEdit.Script));
        // The document form: the same four, each with the correction that removes it.
        var doc = DocumentProblems("<screen name=\"VerifScripts\">\n <span ext:onmouseover=\"alert(1)\">a</span>\n <span OnMouseOver=\"alert(1)\">b</span>\n"
            + " <iframe src='{{ \"javascript:alert(1)\" }}'/>\n <iframe srcdoc=\"&lt;script&gt;x&lt;/script&gt;\"/>\n</screen>\n");
        Assert.Equal(4, doc.Count(p => p!["code"]!.ToString() == "HTML_SCRIPT"));
    }

    // os-Visible in another case (review r2: he1, he2, he9, hd1, hd8): OS-VISIBLE and Os-Visible were kept as inert attributes (the
    // condition lost), os-visible failed at the setter with no patch and held back the other patches. Each is the new Visible it
    // means: HTML_VISIBLE with the If patch, with the patches of the other problems.
    [Fact]
    public void AVisibleInAnotherCaseIsTheNewVisibleWithItsIfPatch()
    {
        var module = Module();
        var (reading, document) = Read(module);
        foreach (var attribute in new[] { "OS-VISIBLE", "Os-Visible", "os-visible" }) {
            var plan = reading.Edit(document, [Line(document.Html, "w9").Replace("/>", " " + attribute + "=\"Page = 1\"/>") + "\n",
                Line(document.Html, "w10").Replace("/>", " onclick=\"this.x = 1; go()\"/>") + "\n"]);
            var problems = plan.Result.Problems;
            Assert.Contains(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.Visible && p["message"]!.ToString().Contains(attribute, StringComparison.Ordinal));
            Assert.Contains(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.Script);
            Assert.All(problems, p => Assert.NotNull(p["patch"]));
            var corrected = problems[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            var text = string.Join("\n", corrected);
            Assert.Contains("<div if=\"Page = 1\">", text);
            Assert.DoesNotContain(attribute + "=", text);
            Assert.False(reading.Edit(document, corrected).Refused, Codes(reading.Edit(document, corrected).Result));
        }
        var doc = DocumentProblems("<screen name=\"VerifCase\">\n <div OS-VISIBLE=\"1 = 1\">a</div>\n <div os-visible=\"2 = 2\">b</div>\n</screen>\n");
        Assert.Equal(2, doc.Count(p => p!["code"]!.ToString() == "HTML_VISIBLE"));
    }

    // The document form without a module (check-job): the problems of its refusal.
    private static JsonArray DocumentProblems(string html)
    {
        var error = Assert.ThrowsAny<Exception>(() => Anvil.Core.ScreenDocument.Preflight(html, "/html"));
        return (JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!;
    }

    private static Node Find(Node node, Func<Node, bool> match) =>
        match(node) ? node : node.Children.Select(c => FindOrNull(c, match)).FirstOrDefault(n => n != null) ?? throw new InvalidOperationException("not found");
    private static Node? FindOrNull(Node node, Func<Node, bool> match) =>
        match(node) ? node : node.Children.Select(c => FindOrNull(c, match)).FirstOrDefault(n => n != null);
    private static Dictionary<string, string> Keys(ScreenHtmlDocument document) => document.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);

    // Plan 3.4: an edit written on an older reading, after the Studio changed the screen. Base = that reading, local = the
    // screen now, foreign = the base with the edit: what only the Studio changed stays (the toolbar's class, a new container),
    // what only the edit changed is written (the input's event), the same attribute changed on both sides keeps the edit's and is
    // listed; an element the Studio removed and the edit changed is Missing (HTML_KEY_FOREIGN).
    [Fact]
    public void AnEditOfAnOlderReadingMergesThreeWaysAndKeepsWhatOnlyTheStudioChanged()
    {
        var module = Module();
        var (_, older) = Read(module);
        // The Studio, after that reading: the toolbar's class, the section's role, a new container at the end of the section.
        Find(module, n => n.Name == "Toolbar").Set("Style", new Code("\"toolbar dark\""));
        var section = Find(module, n => n.Kind == "AdvancedHtml");
        section.Children.First(c => c.Kind == "ExtendedProperty").Set("Value", new Code("\"complementary\""));
        section.Add(W("Container")).Set("Style", new Code("\"c\""));
        var (reading, current) = Read(module);
        Assert.NotEqual(older.HtmlSha256, current.HtmlSha256);
        // The edit, written on the older text: the toolbar whole (its old class) with another event on the input; the role.
        var toolbar = string.Join("\n", older.Html.Split('\n').SkipWhile(l => !l.Contains("k=\"w3\"")).TakeWhile(l => l != "</div>")) + "\n</div>\n";
        var edits = new[] { toolbar.Replace("onchange=\"Refresh\"", "onchange=\"Clear\""), "<section k=\"w8\" role=\"main\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n</section>\n" };
        var merged = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), current.Html, Keys(current), edits);
        Assert.Empty(merged.Missing);
        Assert.NotNull(merged.Document);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("role", conflict["what"]!.ToString());
        var plan = reading.Edit(current, [merged.Document!]);
        Assert.False(plan.Refused, Codes(plan.Result) + " " + string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
        var writer = new Writer();
        plan.Apply(writer);
        plan.Verify(reading.Refresh(current.RootKey).Read("Orders"));
        Assert.False(plan.Refused, string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
        var after = ScreenHtml.Module(module, new Reader()).Read("Orders").Html;
        Assert.Contains("<div k=\"w3\" id=\"Toolbar\" class=\"toolbar dark\">", after);
        Assert.Contains("onchange=\"Clear\"", after);
        Assert.Contains("<section k=\"w8\" role=\"main\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n <div k=\"w11\" class=\"c\"/>\n</section>\n", after);
        // Only what the edit changed was written: the event's destination and the role, nothing recreated.
        Assert.Equal(["set Destination", "set Value"], writer.Log);

        // The Studio removed the hidden container; the older edit changed it: it cannot come back with its key.
        var hidden = Find(module, n => n.Name == "Hidden");
        hidden.Parent!.Children.Remove(hidden);
        var (_, now) = Read(module);
        var lost = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), now.Html, Keys(now), [Line(older.Html, "w12").Replace("os-Visible", "class=\"x\" os-Visible") + "\n"]);
        Assert.Equal(["w12"], lost.Missing);
        // An edit of an element the Studio did not touch, after another change elsewhere: a plain merge, no conflict.
        var plain = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), now.Html, Keys(now), [Line(older.Html, "w7").Replace("class=\"row\"", "class=\"row wide\"") + "\n"]);
        Assert.Empty(plain.Conflicts); Assert.Empty(plain.Missing);
        Assert.Contains("class=\"row wide\"", plain.Document);
        Assert.Contains("class=\"toolbar dark\"", plain.Document);
        Assert.DoesNotContain("id=\"Hidden\"", plain.Document);
    }

    [Fact]
    public void TheCanonicalWriterGivesTheTextItParsed()
    {
        foreach (var target in new[] { "Orders", "Card" }) {
            var (_, document) = Read(Module(), target);
            Assert.Equal(document.Html, ScreenHtmlText.Write(ScreenHtml.Parse(document.Html)));
        }
    }

    // The re-check of the 24.1 fixes (w1-nel-document): the space before a document and after its tag is the .NET \s (\t \n \v \f
    // \r, U+0085 and the separators), which the facade writes out as the same class (text-routes.mjs KERNEL_SPACE; its test pins
    // the facade to this table): a route set to false holds what the kernel runs as a document.
    [Fact]
    public void TheSpaceOfADocumentIsTheClassTheFacadeWritesOut()
    {
        static bool Space(char c) => "\t\n\v\f\r\u0085".Contains(c) || char.GetUnicodeCategory(c) is System.Globalization.UnicodeCategory.SpaceSeparator
            or System.Globalization.UnicodeCategory.LineSeparator or System.Globalization.UnicodeCategory.ParagraphSeparator;
        var wrong = new List<string>();
        for (var code = 0; code <= 0xFFFF; code++) {
            var c = (char)code;
            if (char.IsSurrogate(c)) continue;
            if (Anvil.Core.ScreenDocument.IsDocument(c + "<screen name=\"A\"></screen>") != Space(c)) wrong.Add("before U+" + code.ToString("X4"));
            if (Anvil.Core.ScreenDocument.IsDocument("<screen" + c + "name=\"A\"></screen>") != (Space(c) || c is '/' or '>')) wrong.Add("after U+" + code.ToString("X4"));
        }
        Assert.True(wrong.Count == 0, string.Join(", ", wrong.Take(20)));
        Assert.True(Anvil.Core.ScreenDocument.IsDocument("\u0085<screen name=\"A\"></screen>"));
        Assert.False(Anvil.Core.ScreenDocument.IsDocument("﻿<screen name=\"A\"></screen>"));
    }
}
