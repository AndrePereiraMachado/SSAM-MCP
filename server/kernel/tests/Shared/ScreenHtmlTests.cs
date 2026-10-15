using System.Text.RegularExpressions;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the ssam-html/1 reading (ScreenHtml, C1 of the plan "Texto do SSAM") over a module
// through the reader contract. A screen reads as its source (expressions as text, both branches of an If, events with
// their destination and arguments, block instances with arguments and slots, every other authored property as os-*,
// opaque kinds kept with their keys); the text decodes back to exactly what was read (the fixed point); the text does not
// depend on the order in which the Model API lists the members of a set; every edit of the text is a difference.
public sealed class ScreenHtmlTests
{
    private sealed class Node(string key, string kind, string name = "", params string[] kinds)
    {
        public string Key = key, Kind = kind, Name = name;
        public readonly HashSet<string> Kinds = [.. kinds.Append(kind).SelectMany(k => new[] { k, "I" + k })];
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; return this; }
    }
    private sealed record Code(string Text);
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => null;
        protected override IReadOnlySet<string> KindNames(Node n) => n.Kinds;
        protected override string? Expression(object value) => (value as Code)?.Text;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }

    private static int keys;
    // A named element has its Name property too, as in the Model API.
    private static Node N(string kind, string name = "", params string[] kinds)
    {
        var node = new Node("K" + (++keys).ToString("D3"), kind, name, kinds);
        if (name.Length > 0) node.Props["Name"] = name;
        return node;
    }
    private static Node W(string kind, string name = "") => N(kind, name, "Widget");

    // A module with one screen and one block. reversed lists the members of every set (actions, variables without an
    // ordered list, events, arguments, extended properties) in the opposite order, as another load of the Model API can.
    private static (Node Module, Node Screen, Node Block) Module(bool reversed = false)
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var text = new Node("T-Text", "BasicType", "Text"); var id = new Node("T-Id", "BasicType", "Long Integer");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        // The block: an input and a placeholder.
        var block = flow.Add(N("MobileBlock", "Card"));
        var title = block.Add(N("InputParameter", "Title")).Set("DataType", text);
        var subtitle = block.Add(N("InputParameter", "Subtitle")).Set("DataType", text);
        block.Set("InputParameters", new List<Node> { title, subtitle });
        var holder = block.Add(W("PlaceholderWidget", "Content"));
        // The screen: data, actions and widgets.
        var screen = flow.Add(N("MobileScreen", "Orders")).Set("Title", new Code("\"My orders\""));
        var customer = screen.Add(N("InputParameter", "CustomerId")).Set("DataType", id);
        var page = screen.Add(N("InputParameter", "Page")).Set("DataType", id);
        screen.Set("InputParameters", new List<Node> { customer, page });
        var search = screen.Add(N("LocalVariable", "Search")).Set("DataType", text).Set("DefaultValue", new Code("\"\""));
        var refresh = screen.Add(N("ScreenAction", "Refresh"));
        var open = screen.Add(N("ScreenAction", "Open"));
        var openId = open.Add(N("InputParameter", "Id")).Set("DataType", id);
        var orders = screen.Add(N("ScreenAggregate", "GetOrders", "Aggregate")).Set("MaxRecords", new Code("50"));
        // <div k class="toolbar"><input bind="Search" placeholder onchange="Refresh"/></div>
        var toolbar = screen.Add(W("Container", "Toolbar")).Set("Style", new Code("\"toolbar\""));
        var input = toolbar.Add(W("Input")).Set("Variable", search).Set("Prompt", new Code("\"Search\""));
        var change = input.Add(N("UILifeCycleEvent")).Set("Destination", refresh);
        input.Set("OnChange", change);
        // <div if> "No orders." <div else> the list </div>
        var empty = screen.Add(W("IfWidget")).Set("Condition", new Code("GetOrders.List.Empty"));
        var yes = empty.Add(W("IfBranchWidget")); var no = empty.Add(W("IfBranchWidget"));
        empty.Set("TrueBranch", yes).Set("FalseBranch", no);
        yes.Add(W("TextWidget")).Set("Text", "No orders.");
        var list = no.Add(W("List", "Rows")).Set("Source", new Code("GetOrders.List"));
        var link = list.Add(W("Link")).Set("Style", new Code("If(Search = \"\", \"row\", \"row match\")"));
        var click = link.Add(N("UILifeCycleEvent")).Set("Destination", open);
        link.Set("OnClick", click);
        click.Add(N("Argument")).Set("Parameter", openId).Set("Value", new Code("GetOrders.List.Current.Order.Id"));
        link.Add(W("Expression")).Set("Value", new Code("GetOrders.List.Current.Order.Name"));
        // An HTML element with two extended properties (an ordered list) and an HTML event.
        var section = screen.Add(W("AdvancedHtml")).Set("Tag", "section");
        var role = section.Add(N("ExtendedProperty")).Set("Property", "role").Set("Value", new Code("\"region\""));
        var label = section.Add(N("ExtendedProperty")).Set("Property", "aria-label").Set("Value", new Code("\"Orders \" + Search"));
        section.Set("ExtendedProperties", new List<Node> { role, label });
        section.Add(N("Event")).Set("Event", "onfocus").Set("Destination", refresh);
        // A block instance: two arguments (a set) and the content of its placeholder.
        var card = screen.Add(W("MobileBlockInstanceWidget")).Set("SourceBlock", block);
        card.Add(N("Argument")).Set("Parameter", title).Set("Value", new Code("\"Total\""));
        card.Add(N("Argument")).Set("Parameter", subtitle).Set("Value", new Code("Search"));
        card.Add(W("PlaceholderContentWidget")).Set("Placeholder", holder).Add(W("TextWidget")).Set("Text", "Body");
        // A property outside the table and a Visible that is not True (read and kept: never written new).
        screen.Add(W("Container")).Set("Animate", true).Set("Visible", new Code("Page > 0"));
        // Opaque: a table keeps its cells' widgets inside; a Traditional container hides its whole subtree.
        screen.Add(W("TableRecords", "Grid")).Add(W("HeaderCell")).Add(W("TextWidget")).Set("Text", "Header");
        screen.Add(W("ContainerWidget")).Add(W("TextWidget")).Set("Text", "Legacy");
        if (reversed) Shuffle(module);
        return (module, screen, block);
    }

    // Another load: the members of every set in the opposite order, the widgets (the page) as they are.
    private static void Shuffle(Node node)
    {
        var widgets = node.Children.Where(c => c.Kinds.Contains("IWidget")).ToList();
        var others = node.Children.Where(c => !c.Kinds.Contains("IWidget")).Reverse().ToList();
        node.Children = [.. others, .. widgets];
        foreach (var child in node.Children) Shuffle(child);
    }

    private static ScreenHtmlDocument Read(string target, bool reversed = false)
    {
        var (module, _, _) = Module(reversed);
        return ScreenHtml.Module(module, new Reader()).Read(target);
    }

    [Fact]
    public void AScreenReadsAsItsSourceWithEveryElementKeyed()
    {
        var doc = Read("Orders");
        var html = doc.Html;
        Assert.Equal("ssam-html/1", doc.Schema);
        Assert.Empty(doc.Problems);
        Assert.StartsWith("<screen name=\"Orders\" actions=\"Open, Refresh\" title='\"My orders\"'>\n", html);
        // Data: the inputs in the order of the signature, then the variable, the aggregate.
        Assert.Contains("<input k=\"w1\" name=\"CustomerId\" type=\"Long Integer\"/>\n<input k=\"w2\" name=\"Page\" type=\"Long Integer\"/>\n<var k=\"w3\" name=\"Search\" type=\"Text\" default='\"\"'/>\n<aggregate k=\"w4\" name=\"GetOrders\" max=\"50\"/>\n", html);
        // A plain literal class is bare; bind and events by name.
        Assert.Contains("<div k=\"w5\" id=\"Toolbar\" class=\"toolbar\">\n <input k=\"w6\" bind=\"Search\" placeholder='\"Search\"' onchange=\"Refresh\"/>\n</div>\n", html);
        // Both branches of the If, the condition as text; the list with its template once.
        Assert.Contains("<div k=\"w7\" if=\"GetOrders.List.Empty\">No orders.</div>\n<div else>\n <div k=\"w8\" id=\"Rows\" list=\"GetOrders.List\">\n", html);
        // An expression class, a call with its argument, a run of an expression.
        Assert.Contains("  <a k=\"w9\" class='{{ If(Search = \"\", \"row\", \"row match\") }}' onclick=\"Open(Id = GetOrders.List.Current.Order.Id)\">{{ GetOrders.List.Current.Order.Name }}</a>\n", html);
        // An HTML event; the extended properties in their list's order (a literal bare, any other expression in {{ }}).
        Assert.Contains("<section k=\"w10\" onfocus=\"Refresh\" role=\"region\" aria-label='{{ \"Orders \" + Search }}'/>\n", html);
        // A block instance: arguments by name, the content of its placeholder as a slot (os-Name="": its Name is null).
        Assert.Contains("<Block k=\"w11\" name=\"Card\" :Subtitle=\"Search\" :Title='\"Total\"'>\n <slot name=\"Content\" os-Name=\"\">Body</slot>\n</Block>\n", html);
        // Outside the table: os-<Property>; a Visible that is not True is kept as it is.
        Assert.Contains("<div k=\"w12\" os-Animate=\"True\" os-Visible=\"Page > 0\"/>\n", html);
        // Opaque: the table keeps its cells inside, the Traditional container is one untouchable node.
        Assert.Contains("<os-opaque k=\"w13\" name=\"Grid\" kind=\"TableRecords\">\n <os-opaque k=\"w14\" kind=\"HeaderCell\">Header</os-opaque>\n</os-opaque>\n", html);
        Assert.Contains("<os-opaque k=\"w15\" kind=\"ContainerWidget\"/>\n", html);
        Assert.EndsWith("</screen>\n", html);
        // Every k of the text maps to the key of its element; "" is the root.
        var keys = doc.Keys.ToDictionary(k => k.Key, k => k.Value);
        Assert.Equal(Module().Screen.Key, keys[""]);
        foreach (Match k in Regex.Matches(html, " k=\"(w\\d+)\"")) Assert.True(keys.ContainsKey(k.Groups[1].Value), k.Value);
        Assert.Equal(15, Regex.Matches(html, " k=\"w\\d+\"").Count);
        // Widgets: every widget below the root; opaque: the table, its header cell, the container and its text.
        Assert.Equal(4, doc.OpaqueWidgets);
        Assert.True(doc.Widgets >= 16, "widgets " + doc.Widgets);
    }

    [Fact]
    public void TheTextDecodesBackToWhatWasReadAndTheSameModuleGivesTheSameText()
    {
        foreach (var target in new[] { "Orders", "Card", "MobileBlock:Card" }) {
            var doc = Read(target);
            Assert.Empty(doc.Compare(doc.Html));
            var again = Read(target);
            Assert.Equal(doc.Html, again.Html);
            Assert.Equal(doc.HtmlSha256, again.HtmlSha256);
        }
        // Another load lists actions, arguments, events and the screen's children in another order: the same text.
        Assert.Equal(Read("Orders").Html, Read("Orders", reversed: true).Html);
        Assert.Equal(Read("Card").Html, Read("Card", reversed: true).Html);
        var block = Read("Card").Html;
        Assert.Equal("<block name=\"Card\">\n<input k=\"w1\" name=\"Title\" type=\"Text\"/>\n<input k=\"w2\" name=\"Subtitle\" type=\"Text\"/>\n<placeholder k=\"w3\" name=\"Content\"/>\n</block>\n", block);
    }

    [Fact]
    public void EveryEditOfTheTextIsADifference()
    {
        var doc = Read("Orders");
        var html = doc.Html;
        string Ops(string edited) => string.Join("; ", doc.Compare(edited).Select(o => o["op"] + " " + o["k"] + " " + (o["fact"] ?? o["kind"])));
        Assert.Equal("set w5 p:Style", Ops(html.Replace("class=\"toolbar\"", "class=\"toolbar compact\"")));
        Assert.Equal("set w7 p:Condition", Ops(html.Replace("if=\"GetOrders.List.Empty\"", "if=\"GetOrders.List.Length = 0\"")));
        Assert.Equal("set w9 ev:OnClick:a:Id", Ops(html.Replace("Open(Id = GetOrders.List.Current.Order.Id)", "Open(Id = NullIdentifier())")));
        Assert.Equal("set w11 a:Title", Ops(html.Replace(":Title='\"Total\"'", ":Title='\"Sum\"'")));
        // A new element (no k) and a removed one.
        var created = Ops(html.Replace("<div k=\"w12\"", "<p>New</p>\n<div k=\"w12\""));
        Assert.Contains("create +1", created); Assert.Contains("children ", created);
        var removed = Ops(Regex.Replace(html, "<div k=\"w12\"[^\n]*\n", ""));
        Assert.Contains("delete w12", removed);
        // A k the reading never wrote, and a touched opaque node.
        Assert.Contains("foreign w99", Ops(html.Replace("<div k=\"w12\"", "<div k=\"w99\"")));
        Assert.Equal("set w15 kind", Ops(html.Replace("kind=\"ContainerWidget\"", "kind=\"Container\"")));
        // A moved element changes the children of both parents.
        var moved = Ops(html.Replace(" <input k=\"w6\" bind=\"Search\" placeholder='\"Search\"' onchange=\"Refresh\"/>\n", "")
            .Replace("<div k=\"w12\"", "<input k=\"w6\" bind=\"Search\" placeholder='\"Search\"' onchange=\"Refresh\"/>\n<div k=\"w12\""));
        Assert.Contains("children w5", moved); Assert.Contains("children  ", moved);
    }

    [Fact]
    public void TheParserIsStrictAndSaysWhere()
    {
        FormatException Fails(string html) => Assert.Throws<FormatException>(() => ScreenHtml.Parse(html));
        Assert.Contains("line 2", Fails("<div>\n<span></div>").Message);
        Assert.Contains("bare '&'", Fails("<p>a & b</p>").Message);
        Assert.Contains("unquoted value", Fails("<div class=a></div>").Message);
        Assert.Contains("duplicate attribute", Fails("<div k=\"w1\" k=\"w2\"></div>").Message);
        Assert.Contains("unclosed <div>", Fails("<div><p></p>").Message);
        // Entities, both quotes and raw <style> text.
        var parsed = ScreenHtml.Parse("<screen a='say \"hi\"' b=\"it&#39;s &amp; &lt;\"><style>a > b { x: \"&\" }</style></screen>");
        var screen = Assert.Single(parsed.Children);
        Assert.Equal("say \"hi\"", screen.Get("a")); Assert.Equal("it's & <", screen.Get("b"));
        Assert.Equal("a > b { x: \"&\" }", Assert.Single(Assert.Single(screen.Children).Children).Text);
    }

    [Fact]
    public void TheContractListsTheTablesTheDefaultsAndWhatIsNotAFact()
    {
        var contract = ScreenHtml.Contract();
        Assert.Equal("ssam-html/1", contract["schema"]!.ToString());
        var opaque = contract["opaque"]!.AsArray().Select(o => o!.ToString()).ToList();
        Assert.Contains("TableRecords", opaque); Assert.Contains("MobileWidget", opaque); Assert.Contains("ContainerWidget", opaque);
        Assert.DoesNotContain("Container", opaque);
        Assert.Equal("bind", contract["named"]!["Input"]!["Variable"]!.ToString());
        Assert.Equal("True", contract["defaults"]!["Container"]!["Visible"]!.ToString());
        Assert.Contains("ObjectKey", contract["notFacts"]!.AsArray().Select(o => o!.ToString()));
    }

    [Fact]
    public void AnUnknownOrAmbiguousTargetSaysWhichRootsExist()
    {
        var (module, _, _) = Module();
        var reading = ScreenHtml.Module(module, new Reader());
        Assert.Equal(["Card", "Orders"], reading.Roots.Select(r => r.Name).Order().ToArray());
        var error = Assert.Throws<InvalidOperationException>(() => reading.Read("Ordres"));
        Assert.Contains("No screen or block named 'Ordres'", error.Message);
        Assert.Contains("MobileScreen:Orders", error.Message);
        Assert.Equal(reading.Read("Orders").Html, reading.Read("@" + reading.Roots.Single(r => r.Name == "Orders").Key).Html);
    }
}
