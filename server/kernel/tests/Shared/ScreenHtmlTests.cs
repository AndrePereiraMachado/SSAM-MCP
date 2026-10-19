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
    // A reader over the test model; with a Studio (studio), the defaults it measured: the kernel's adapter gives the installed
    // Studio's (StudioDefaults), this one the test's.
    private sealed class Reader(ScreenDefaults? studio = null) : ModelReader<Node>
    {
        protected internal override ScreenDefaults? DefaultsOf(Node module, Node? flow) => studio;
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
        // A native Table: its HeaderRow and Row (O11 lists each as a MobileWidget of the Table) hold one header cell and one row
        // cell per column.
        var grid = screen.Add(W("TableRecords", "Grid")).Set("Source", new Code("GetOrders.List"));
        var headerRow = grid.Add(W("MobileWidget", "headerRow"));
        var templateRow = grid.Add(W("MobileWidget", "row"));
        grid.Set("HeaderRow", headerRow).Set("Row", templateRow);
        headerRow.Add(W("HeaderCell")).Add(W("TextWidget")).Set("Text", "Header");
        templateRow.Add(W("RowCell")).Add(W("Expression")).Set("Value", new Code("GetOrders.List.Current.Order.Name"));
        // Opaque: a Traditional container hides its whole subtree.
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
        // A native Table is the <table>: its list on it, its header row and its template row, one <th> and one <td> per column.
        Assert.Contains("<table k=\"w13\" id=\"Grid\" list=\"GetOrders.List\">\n <thead>\n  <tr>\n   <th k=\"w14\">Header</th>\n  </tr>\n </thead>\n"
            + " <tbody>\n  <tr>\n   <td k=\"w15\">{{ GetOrders.List.Current.Order.Name }}</td>\n  </tr>\n </tbody>\n</table>\n", html);
        // Opaque: the Traditional container is one untouchable node.
        Assert.Contains("<os-opaque k=\"w16\" kind=\"ContainerWidget\"/>\n", html);
        Assert.EndsWith("</screen>\n", html);
        // Every k of the text maps to the key of its element; "" is the root.
        var keys = doc.Keys.ToDictionary(k => k.Key, k => k.Value);
        Assert.Equal(Module().Screen.Key, keys[""]);
        foreach (Match k in Regex.Matches(html, " k=\"(w\\d+)\"")) Assert.True(keys.ContainsKey(k.Groups[1].Value), k.Value);
        Assert.Equal(16, Regex.Matches(html, " k=\"w\\d+\"").Count);
        // The rows of the Table are groups of the reading, keyed (k/content:HeaderRow, k/content:Row).
        Assert.True(keys.ContainsKey("w13/content:HeaderRow") && keys.ContainsKey("w13/content:Row"));
        // Widgets: every widget below the root; opaque: the container and its text.
        Assert.Equal(2, doc.OpaqueWidgets);
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
        Assert.Equal("set w16 kind", Ops(html.Replace("kind=\"ContainerWidget\"", "kind=\"Container\"")));
        // A column of the native Table is its header cell and its row cell: removing one alone is refused, a class of a row is
        // its StyleRow.
        Assert.StartsWith("invalid", Ops(html.Replace("   <th k=\"w14\">Header</th>\n", "")));
        Assert.Equal("set w13 p:StyleRow", Ops(html.Replace(" <tbody>\n  <tr>\n", " <tbody>\n  <tr class=\"zebra\">\n")));
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
        Assert.Contains("MobileWidget", opaque); Assert.Contains("ContainerWidget", opaque);
        // The native Table has its row (a data table, ScreenHtmlTables.NativeTable).
        Assert.DoesNotContain("TableRecords", opaque);
        Assert.Equal("table", contract["elements"]!["TableRecords"]!.ToString());
        Assert.DoesNotContain("Container", opaque);
        Assert.Equal("bind", contract["named"]!["Input"]!["Variable"]!.ToString());
        Assert.Contains("ObjectKey", contract["notFacts"]!.AsArray().Select(o => o!.ToString()));
        // The defaults are no table of the reading: without a Studio the contract says only the rule; with one, its values.
        Assert.Contains("installed Studio", contract["defaults"]!["rule"]!.ToString());
        Assert.Null(contract["defaults"]!["Container"]);
        var measured = ScreenHtml.Contract(Studio());
        Assert.Equal("fake-studio", measured["defaults"]!["studio"]!.ToString());
        Assert.Equal("True", measured["defaults"]!["Container"]!["Visible"]!.ToString());
        Assert.Equal("8px", measured["defaults"]!["Container"]!["Gap"]!.ToString());
    }

    // A Studio whose fresh Container is born Visible, with a Gap of 8px, 3 grid columns, the class "box" and a name of its own,
    // and whose events are born Inherited on a page and Fade inside a Popup (as StudioBornValues measures a real one).
    private static ScreenDefaults Studio() => ScreenDefaults.FromBorn("fake-studio",
        new Dictionary<string, SortedDictionary<string, string>> {
            ["Container"] = new(StringComparer.Ordinal) { ["Visible"] = "e:True", ["Gap"] = "t:8px", ["GridColumns"] = "v:3", ["Style"] = "e:\"box\"", ["Name"] = "t:Container1" },
            ["UILifeCycleEvent"] = new(StringComparer.Ordinal) { ["Transition"] = "v:Inherited", ["Name"] = "t:OnClick" },
            ["UILifeCycleEvent" + ScreenDefaults.PopupSuffix] = new(StringComparer.Ordinal) { ["Transition"] = "v:Fade", ["Name"] = "t:OnClick" },
        },
        new Dictionary<string, string> { ["Container"] = "widget", ["UILifeCycleEvent"] = "event", ["UILifeCycleEvent" + ScreenDefaults.PopupSuffix] = "event" });

    [Fact]
    public void APropertyIsOmittedExactlyWhenItHoldsTheDefaultTheReadersStudioGivesIt()
    {
        // The settings a fresh element is born with are defaults; its class and its name are the developer's.
        var studio = Studio();
        Assert.Equal("True", studio.DefaultOf("Container", "Visible", 'e'));
        Assert.Equal("8px", studio.DefaultOf("Container", "Gap", 't'));
        Assert.Equal("3", studio.DefaultOf("Container", "GridColumns", 'v'));
        Assert.Equal("", studio.DefaultOf("Container", "Style", 'e'));
        Assert.Equal("", studio.DefaultOf("Container", "Name", 't'));
        Assert.Equal("False", studio.DefaultOf("Container", "Animate", 'b'));
        Assert.Equal("Inherited", studio.DefaultOf("UILifeCycleEvent", "Transition", 'v'));
        Assert.Equal("Fade", studio.DefaultOf("UILifeCycleEvent", "Transition", 'v', inPopup: true));
        // A screen with a container at the Studio's values, one with its own Gap, and one in a Popup with an event at the Popup's
        // Transition: read with that Studio, only what differs from it is written.
        keys = 0;
        var module = N("ESpace", "Shop");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var screen = flow.Add(N("MobileScreen", "Home"));
        var go = screen.Add(N("ScreenAction", "Go"));
        screen.Add(W("Container")).Set("Visible", new Code("True")).Set("Gap", "8px").Set("GridColumns", 3).Set("Style", new Code("\"box\""));
        screen.Add(W("Container")).Set("Visible", new Code("True")).Set("Gap", "12px").Set("GridColumns", 3);
        var popup = screen.Add(W("Popup"));
        var inside = popup.Add(W("Container")).Set("Visible", new Code("True")).Set("Gap", "8px");
        var click = inside.Add(N("UILifeCycleEvent")).Set("Destination", go).Set("Transition", "Fade");
        inside.Set("OnClick", click);
        var read = ScreenHtml.Module(module, new Reader(studio)).Read("Home");
        Assert.Empty(read.Problems);
        var text = Regex.Replace(read.Html, " k=\"w[0-9]+\"", "");
        Assert.Equal("<screen name=\"Home\" actions=\"Go\">\n<div class=\"box\"/>\n<div os-Gap=\"12px\"/>\n<popup>\n <div onclick=\"Go\"/>\n</popup>\n</screen>\n", text);
        Assert.Empty(read.Compare(read.Html));
        // The same module read without a Studio: nothing is a default but the empty value, so every value is written (the reading
        // has no list of its own to fall back on).
        var bare = ScreenHtml.Module(module, new Reader()).Read("Home");
        Assert.Contains("os-Gap=\"8px\"", bare.Html);
        Assert.Contains("os-GridColumns=\"3\"", bare.Html);
        Assert.Contains("os-Visible=\"True\"", bare.Html);
        Assert.Contains("os-onclick.Transition=\"Fade\"", bare.Html);
        Assert.Empty(bare.Compare(bare.Html));
    }

    // A Studio that creates a screen or block input and a block event mandatory (ODC Studio 1.7.28.10873 and Service Studio
    // 11.55.87 do), and whose fresh Input widget would be born required and disabled (no Studio does today).
    private static ScreenDefaults MandatoryStudio() => ScreenDefaults.FromBorn("mandatory-studio",
        new Dictionary<string, SortedDictionary<string, string>> {
            ["InputParameter"] = new(StringComparer.Ordinal) { ["IsMandatory"] = "b:True", ["Name"] = "t:In1" },
            ["BlockEvent"] = new(StringComparer.Ordinal) { ["IsMandatory"] = "b:True", ["Name"] = "t:Event1" },
            ["Input"] = new(StringComparer.Ordinal) { ["Mandatory"] = "e:True", ["Enabled"] = "e:False" },
            ["Input" + ScreenDefaults.PopupSuffix] = new(StringComparer.Ordinal) { ["Mandatory"] = "e:True", ["Enabled"] = "e:False" },
        },
        new Dictionary<string, string> { ["InputParameter"] = "parameter", ["BlockEvent"] = "event", ["Input"] = "widget", ["Input" + ScreenDefaults.PopupSuffix] = "widget" });

    [Fact]
    public void ANamedAttributeLeftOutMeansWhatTheLanguageSaysWhateverTheStudioGivesAFreshElement()
    {
        // <input> and <event> without mandatory are not mandatory; an input widget without required is not required and without
        // enabled is enabled: the language's meaning, whatever the installed Studio gives a fresh element.
        var studio = MandatoryStudio();
        Assert.Equal("False", studio.DefaultOf("InputParameter", "IsMandatory", 'b'));
        Assert.Equal("False", studio.DefaultOf("BlockEvent", "IsMandatory", 'b'));
        Assert.Equal("False", studio.DefaultOf("Input", "Mandatory", 'e'));
        Assert.Equal("True", studio.DefaultOf("Input", "Enabled", 'e'));
        Assert.Equal("False", studio.DefaultOf("Input", "Mandatory", 'e', inPopup: true));
        Assert.Equal("True", studio.DefaultOf("Input", "Enabled", 'e', inPopup: true));
        // The contract an author reads says the same.
        var contract = ScreenHtml.Contract(studio)["defaults"]!;
        Assert.Equal("False", contract["InputParameter"]!["IsMandatory"]!.ToString());
        Assert.Equal("False", contract["BlockEvent"]!["IsMandatory"]!.ToString());
        // The reading writes mandatory only on what is mandatory, and the text decodes back to the same page.
        keys = 0;
        var module = N("ESpace", "Shop");
        var text = new Node("T-Text", "BasicType", "Text");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var screen = flow.Add(N("MobileScreen", "Search"));
        var filter = screen.Add(N("InputParameter", "Filter")).Set("DataType", text).Set("IsMandatory", false).Set("DefaultValue", new Code("\"all\""));
        var term = screen.Add(N("InputParameter", "Term")).Set("DataType", text).Set("IsMandatory", true);
        screen.Set("InputParameters", new List<Node> { filter, term });
        var query = screen.Add(N("LocalVariable", "Query")).Set("DataType", text);
        screen.Add(W("Input")).Set("Variable", query).Set("Mandatory", new Code("False")).Set("Enabled", new Code("True"));
        var block = flow.Add(N("MobileBlock", "Picker"));
        var label = block.Add(N("InputParameter", "Label")).Set("DataType", text).Set("IsMandatory", false);
        block.Set("InputParameters", new List<Node> { label });
        block.Add(N("BlockEvent", "OnPick")).Set("IsMandatory", false);
        block.Add(N("BlockEvent", "OnClose")).Set("IsMandatory", true);
        var reading = ScreenHtml.Module(module, new Reader(studio));
        var page = reading.Read("Search");
        var picker = reading.Read("Picker");
        Assert.Empty(page.Problems); Assert.Empty(picker.Problems);
        string Tag(ScreenHtmlDocument d, string name) => Regex.Match(d.Html, "<(?:input|event) [^>]*name=\"" + name + "\"[^>]*>").Value;
        Assert.DoesNotContain("mandatory", Tag(page, "Filter"));
        Assert.Contains("mandatory=\"True\"", Tag(page, "Term"));
        Assert.DoesNotContain("mandatory", Tag(picker, "Label"));
        Assert.DoesNotContain("mandatory", Tag(picker, "OnPick"));
        Assert.Contains("mandatory=\"True\"", Tag(picker, "OnClose"));
        Assert.DoesNotContain("mandatory=\"False\"", page.Html + picker.Html);
        Assert.DoesNotContain("required=", page.Html);
        Assert.DoesNotContain("enabled=", page.Html);
        Assert.Empty(page.Compare(page.Html));
        Assert.Empty(picker.Compare(picker.Html));
        // mandatory="False" written out names the default (the value the input already has); mandatory="True" left out makes the
        // input optional.
        var written = Assert.Single(page.Compare(page.Html.Replace(Tag(page, "Filter"), Tag(page, "Filter").Replace(" type=", " mandatory=\"False\" type="))));
        Assert.Equal(("p:IsMandatory", "b:False"), (written["fact"]!.ToString(), written["to"]!.ToString()));
        Assert.Equal(studio.DefaultOf("InputParameter", "IsMandatory", 'b'), written["to"]!.ToString()[2..]);
        var dropped = page.Compare(page.Html.Replace(Tag(page, "Term"), Tag(page, "Term").Replace(" mandatory=\"True\"", "")));
        var op = Assert.Single(dropped);
        Assert.Equal(("set", "p:IsMandatory", "b:True"), (op["op"]!.ToString(), op["fact"]!.ToString(), op["from"]!.ToString()));
        Assert.Null(op["to"]);
    }

    private enum IconSize { FontSize, Twotimes }

    // A Studio that creates an Icon twice the font size and a Join of an aggregate inner (ODC Studio 1.7.28.10873 and Service
    // Studio 11.55.87 do).
    private static ScreenDefaults SizedStudio() => ScreenDefaults.FromBorn("sized-studio",
        new Dictionary<string, SortedDictionary<string, string>> {
            ["Icon"] = new(StringComparer.Ordinal) { ["IconSize"] = "v:Twotimes", ["Icon"] = "t:flag" },
            ["Icon" + ScreenDefaults.PopupSuffix] = new(StringComparer.Ordinal) { ["IconSize"] = "v:Twotimes", ["Icon"] = "t:flag" },
            ["Join"] = new(StringComparer.Ordinal) { ["JoinType"] = "v:Inner" },
        },
        new Dictionary<string, string> { ["Icon"] = "widget", ["Icon" + ScreenDefaults.PopupSuffix] = "widget", ["Join"] = "query" });

    [Fact]
    public void AnIconWithoutASizeAndAJoinWithoutATypeKeepTheLanguagesMeaningWhateverTheStudioGivesAFreshOne()
    {
        // <i icon> without size keeps the font size around it, and a join of an aggregate without a type (join= of the short form,
        // os-Join without os-JoinType) is a left join, as the language wrote them before the Studio's defaults were measured.
        var studio = SizedStudio();
        Assert.Equal("FontSize", studio.DefaultOf("Icon", "IconSize", 'v'));
        Assert.Equal("FontSize", studio.DefaultOf("Icon", "IconSize", 'v', inPopup: true));
        Assert.Equal("Left", studio.DefaultOf("Join", "JoinType", 'v'));
        Assert.Equal("Left", ScreenHtml.Contract(studio)["defaults"]!["Join"]!["JoinType"]!.ToString());
        // The reading writes size only on an icon of another size, and the text decodes back to the same page.
        keys = 0;
        var module = N("ESpace", "Shop");
        var screen = module.Add(N("MobileFlow", "MainFlow")).Add(N("MobileScreen", "Icons"));
        screen.Add(W("Icon")).Set("Icon", "lock").Set("IconSize", IconSize.FontSize);
        screen.Add(W("Icon")).Set("Icon", "star").Set("IconSize", IconSize.Twotimes);
        var page = ScreenHtml.Module(module, new Reader(studio)).Read("Icons");
        Assert.Empty(page.Problems);
        var text = Regex.Replace(page.Html, " k=\"w[0-9]+\"", "");
        Assert.Contains("<i icon=\"lock\"/>", text);
        Assert.Contains("<i icon=\"star\" size=\"Twotimes\"/>", text);
        Assert.Empty(page.Compare(page.Html));
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

    // A native Table the Studio holds without Source (dragged, not bound yet; the review of round 1, B2): read as <table list="">,
    // it is the Table again at the fixed point, and an edit of another element plans that element only.
    [Fact]
    public void ANativeTableWithoutSourceReadsAsATableAndStaysOneAtTheFixedPoint()
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var screen = flow.Add(N("MobileScreen", "Orders"));
        screen.Add(W("Container", "Before")).Set("Style", new Code("\"before\""));
        var grid = screen.Add(W("TableRecords", "Grid"));
        var headerRow = grid.Add(W("MobileWidget", "headerRow"));
        var templateRow = grid.Add(W("MobileWidget", "row"));
        grid.Set("HeaderRow", headerRow).Set("Row", templateRow);
        headerRow.Add(W("HeaderCell")).Add(W("TextWidget")).Set("Text", "Header");
        templateRow.Add(W("RowCell")).Add(W("TextWidget")).Set("Text", "Cell");
        var doc = ScreenHtml.Module(module, new Reader()).Read("Orders");
        Assert.Empty(doc.Problems);
        Assert.Contains("<table k=\"w2\" id=\"Grid\" list=\"\">", doc.Html);
        Assert.Empty(doc.Compare(doc.Html));
        var ops = doc.Compare(doc.Html.Replace("class=\"before\"", "class=\"before x\"")).Select(o => o["op"] + " " + o["k"] + " " + (o["fact"] ?? o["kind"])).ToList();
        Assert.Equal(["set w1 p:Style"], ops);
    }
}
