using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
namespace Anvil.Tests;

/// <summary>The native side of the fidelity measure (docs/PROTOTIPO-NATIVO.md 4.4 step 2): the built module read back and rendered
/// per explored state through the runtime DOM table (wrappers and runtime attributes included), expressions by the evaluator of
/// the closed subset (anything else is an unevaluable node, counted), aggregates over the seed rows with the filters and sorts
/// of the model. A module tree through the reader contract (the same ModelReader the kernel reads the Model API with), and a
/// real module built headless when the Service Studio assemblies are installed.</summary>
public class PrototypeRenderTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PrototypeRenderTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "prototype-render-tests");

    private sealed record Expr(string Text);

    private sealed class Fake(string kind, string name = "", Dictionary<string, object?>? props = null, params Fake[] children)
    {
        public string Kind { get; } = kind;
        public string Name { get; } = name;
        public string Key { get; } = Guid.NewGuid().ToString("N")[..12];
        public Dictionary<string, object?> Props { get; } = props ?? [];
        public List<Fake> Children { get; } = [.. children];
        public Fake? Parent { get; set; }
        public bool Widget => Kind.EndsWith("Widget", StringComparison.Ordinal) || Kind is "Container" or "Link" or "Button" or "Expression" or "AdvancedHtml" or "List"
            or "Popup" or "Checkbox" or "Input" or "Text" or "Label" or "Image" or "Dropdown" or "Form" or "TextArea";
    }

    /// <summary>The ModelReader contract over a hand-built module: kinds, names, properties (an Expr is an expression, a Fake a
    /// reference), children and parents.</summary>
    private sealed class FakeReader : ModelReader<Fake>
    {
        public FakeReader(Fake root) { Link(root); }
        private static void Link(Fake node) { foreach (var child in node.Children) { child.Parent = node; Link(child); } foreach (var value in node.Props.Values) if (value is Fake f && f.Parent == null) { f.Parent = node; Link(f); } }
        protected override IEnumerable<Fake> Children(Fake node) => node.Children;
        protected override Fake? Parent(Fake node) => node.Parent;
        protected override string Key(Fake node) => node.Key;
        protected override string Kind(Fake node) => node.Kind;
        protected override string Name(Fake node) => node.Name;
        protected override string? Label(Fake node) => null;
        protected override IReadOnlySet<string> KindNames(Fake node) =>
            new HashSet<string>(node.Widget ? [node.Kind, "I" + node.Kind, "Widget", "IWidget"] : [node.Kind, "I" + node.Kind]);
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Fake node) => node.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
        protected override string? Expression(object value) => value is Expr e ? e.Text : null;
        protected override IEnumerable<Fake> Referrers(Fake node) => [];
    }

    private static Dictionary<string, object?> P(params (string, object?)[] pairs) => pairs.ToDictionary(p => p.Item1, p => p.Item2);

    private static (Fake Module, Fake Screen) Module()
    {
        var entity = new Fake("Entity", "FarmaVirtualProduto");
        var shellRoot = new Fake("Container", "app", P(("Style", new Expr("\"app\""))),
            new Fake("AdvancedHtml", "Header", P(("Tag", "header")), new Fake("ExtendedProperty", "", P(("Property", "class"), ("Value", new Expr("\"site-header \" + If(View = \"catalogo\", \"on\", \"off\")"))))),
            new Fake("PlaceholderWidget", "Content"));
        var shell = new Fake("MobileBlock", "FarmaVirtualShell", null, new Fake("InputParameter", "View", P(("DataType", "Text"))), shellRoot);
        var aggregate = new Fake("ScreenAggregate", "GetProdutos", null,
            new Fake("AliasedSource", "FarmaVirtualProduto", P(("Source", entity))),
            new Fake("Filter", "", P(("Condition", new Expr("FarmaVirtualProduto.Ativo")))),
            new Fake("Sort", "", P(("Attribute", new Expr("FarmaVirtualProduto.Nome")), ("SortDirection", "Ascending"))));
        var card = new Fake("Container", "", P(("Style", new Expr("\"product-card\" + If(GetProdutos.List.Current.FarmaVirtualProduto.Destaque, \" featured\", \"\")"))),
            new Fake("Expression", "", P(("Value", new Expr("GetProdutos.List.Current.FarmaVirtualProduto.Nome")))),
            new Fake("Expression", "", P(("Value", new Expr("\"R$\" + FormatDecimal(GetProdutos.List.Current.FarmaVirtualProduto.Preco, 2, \".\", \",\")")))),
            new Fake("Checkbox", "", P(("Variable", new Expr("GetProdutos.List.Current.FarmaVirtualProduto.Destaque")))));
        var list = new Fake("List", "Produtos", P(("Source", new Expr("GetProdutos.List")), ("Tag", "div"), ("Style", new Expr("\"product-grid\""))), card);
        var yes = new Fake("IfBranchWidget", "True", null, new Fake("Text", "", P(("Text", "Todos"))));
        var no = new Fake("IfBranchWidget", "False", null, new Fake("Text", "", P(("Text", "Filtrado"))));
        var ifWidget = new Fake("IfWidget", "", P(("Condition", new Expr("Category = 0")), ("TrueBranch", yes), ("FalseBranch", no)), yes, no);
        var unknown = new Fake("Expression", "Clock", P(("Value", new Expr("CurrDateTime()"))));
        var count = new Fake("Expression", "Count", P(("Value", new Expr("IntegerToText(GetProdutos.List.Length) + \" produtos\""))));
        var popup = new Fake("Popup", "DetalhesDoProdutoPopup", P(("ShowPopup", new Expr("DetalhesDoProdutoIsOpen"))),
            new Fake("AdvancedHtml", "modal", P(("Tag", "div")), new Fake("ExtendedProperty", "", P(("Property", "class"), ("Value", new Expr("\"ssam-tag-dialog product-modal\"")))),
                new Fake("ExtendedProperty", "", P(("Property", "open"), ("Value", new Expr("\"open\"")))),
                new Fake("ExtendedProperty", "", P(("Property", "hidden"), ("Value", new Expr("\"\""))))));
        var content = new Fake("PlaceholderContentWidget", "Content", null, list, ifWidget, unknown, count, popup);
        var instance = new Fake("MobileBlockInstanceWidget", "Shell", P(("SourceBlock", shell)),
            new Fake("Argument", "", P(("Parameter", "View"), ("Value", new Expr("\"catalogo\"")))), content);
        var screen = new Fake("MobileScreen", "Catalogo", null,
            new Fake("LocalVariable", "Category", P(("DataType", "Integer"), ("DefaultValue", new Expr("0")))),
            new Fake("LocalVariable", "DetalhesDoProdutoIsOpen", P(("DataType", "Boolean"))),
            aggregate, instance);
        var flow = new Fake("MobileFlow", "FarmaVirtual", null, screen, shell);
        var module = new Fake("ESpace", "Haiku_UI", null, new Fake("ClientVariable", "FarmaVirtualAccountSelect", P(("DataType", "Integer"), ("DefaultValue", new Expr("1")))), entity, flow);
        return (module, screen);
    }

    private static JsonObject Capture() => JsonNode.Parse("""
        {"schema":"ssam-prototype-capture/1","app":{"prefix":"FarmaVirtual"},
         "store":{"collections":[{"name":"Produto","key":"Id","rows":[
            {"Id":1,"Nome":"Sabonete liquido","Ativo":true,"Destaque":false,"Preco":19.9},
            {"Id":2,"Nome":"Hidratante facial","Ativo":true,"Destaque":true,"Preco":49.9},
            {"Id":3,"Nome":"Inativo","Ativo":false,"Destaque":true,"Preco":1}]}]},
         "views":[{"key":"catalogo","route":"#catalogo","template":"catalogo"}],
         "modals":[{"key":"detalhes-do-produto","name":"DetalhesDoProduto"}],
         "explored":[{"id":"v:catalogo@canonical","view":"catalogo","assign":{}},
                     {"id":"m:detalhes-do-produto@canonical","view":"catalogo","modal":"detalhes-do-produto","assign":{}}]}
        """)!.AsObject();

    [Fact]
    public void EachExploredStateRendersThroughTheRuntimeTable()
    {
        var (module, screen) = Module();
        var reader = new FakeReader(module);
        var dom = PrototypeRender.Render(reader, Capture(), "o11", new Dictionary<string, Fake> { ["v:catalogo"] = screen });
        Assert.Equal("ssam-prototype-dom/1", dom["schema"]!.ToString());
        var states = dom["states"]!.AsArray();
        Assert.Equal(2, states.Count);
        var canonical = DomNode.FromJson(states[0]!["root"]);

        // The block instance and the placeholder are runtime elements around the prototype's own: the shell root, the list.
        var cards = CssSelectors.Select(canonical, "div.OSBlockWidget[data-block=FarmaVirtualShell] > div#app[data-container].app > div[data-placeholder] > div#Produtos.product-grid[data-list] > div.product-card[data-container]").ToList();
        Assert.Equal(2, cards.Count);   // Ativo filters out 1 of 3 seed rows
        Assert.True(cards.All(c => c.Runtime == null));
        Assert.Equal("div", canonical.Children[0].Tag);
        Assert.Equal("IMobileBlockInstanceWidget", canonical.Children[0].Runtime);

        // Sorted by Nome (the sort of the aggregate), expressions evaluated, formats of the closed subset.
        var texts = cards.Select(c => string.Join("|", c.Descendants(includeSelf: false).Where(n => n.Text != null && n.Tag == null).Select(n => n.Text))).ToList();
        Assert.Equal(["Hidratante facial|R$49,90", "Sabonete liquido|R$19,90"], texts);
        Assert.Equal("product-card featured", cards[0].Attr("class"));
        Assert.Equal("product-card", cards[1].Attr("class"));

        // The checkbox row: <span><input data-checkbox="" class="" type="checkbox"></span>, checked from the record.
        var inputs = CssSelectors.Select(canonical, ".product-card > span > input[data-checkbox][type=checkbox]").ToList();
        Assert.Equal(2, inputs.Count);
        Assert.NotNull(inputs[0].Attr("checked"));
        Assert.Null(inputs[1].Attr("checked"));
        Assert.Equal("ICheckbox", inputs[0].Parent!.Runtime);

        // Block input passed from the screen and read by an extended property of the block.
        Assert.Single(CssSelectors.Select(canonical, "header.site-header.on[data-advancedhtml]#Header"));
        // If: only the branch that holds.
        Assert.Contains(canonical.Descendants(includeSelf: false), n => n.Text == "Todos");
        Assert.DoesNotContain(canonical.Descendants(includeSelf: false), n => n.Text == "Filtrado");
        // An aggregate count over the seed.
        Assert.Contains(canonical.Descendants(includeSelf: false), n => n.Text == "2 produtos");
        // A function outside the subset: an unevaluable node, counted with the reason.
        Assert.Contains(canonical.Descendants(includeSelf: false), n => n.Unevaluable == "CurrDateTime()");
        var unevaluable = dom["unevaluable"]!.AsArray().Select(u => u!.AsObject()).ToList();
        Assert.Contains(unevaluable, u => u["expression"]!.ToString() == "CurrDateTime()" && u["why"]!.ToString().Contains("outside the evaluated subset") && u["state"]!.ToString() == "v:catalogo@canonical");
        // The popup is closed in the canonical state.
        Assert.Empty(CssSelectors.Select(canonical, ".popup-backdrop"));

        // The modal state opens the popup: backdrop > dialog box > the prototype's dialog as div.ssam-tag-dialog.
        var modal = DomNode.FromJson(states[1]!["root"]);
        var dialog = Assert.Single(CssSelectors.Select(modal, "div.popup-backdrop > div.popup-dialog[data-popup][role=dialog] > div.ssam-tag-dialog.product-modal[open]#modal"));
        Assert.Null(dialog.Runtime);
        // a boolean attribute is present by a value and dropped when empty, as the runtime renders it
        Assert.Equal("", dialog.Attr("open"));
        Assert.Null(dialog.Attr("hidden"));

        // Widgets rendered through inferred rows are counted; evidence rows are not.
        var unverified = dom["runtimeUnverified"]!.AsArray().Select(u => u!["widget"]!.ToString()).ToList();
        // CX17: IList (with IInput, IDropdown and ILabel) was read on the published DemoLATAM_UI (2026-10-14): an evidence row now.
        foreach (var widget in new[] { "IExpression", "IPopup", "IPlaceholderWidget", "IIfWidget" }) Assert.Contains(widget, unverified);
        foreach (var widget in new[] { "IList", "ICheckbox", "IContainer", "IAdvancedHtml", "IMobileBlockInstanceWidget" }) Assert.DoesNotContain(widget, unverified);
    }

    [Fact]
    public void TheStateAssignsDimensionsAndRouteParameters()
    {
        var (module, screen) = Module();
        var capture = Capture();
        capture["dimensions"] = JsonNode.Parse("""[{"key":"category","name":"Category","type":"Integer","scope":"screen"}]""");
        capture["explored"] = JsonNode.Parse("""[{"id":"v:catalogo@category=2","view":"catalogo","assign":{"category":"2"}}]""");
        var dom = PrototypeRender.Render(new FakeReader(module), capture, "o11", new Dictionary<string, Fake> { ["v:catalogo"] = screen });
        var root = DomNode.FromJson(dom["states"]![0]!["root"]);
        Assert.Contains(root.Descendants(includeSelf: false), n => n.Text == "Filtrado");
        Assert.DoesNotContain(root.Descendants(includeSelf: false), n => n.Text == "Todos");
    }

    [Fact]
    public void AModalStateNamedByItsIdOpensThePopup()
    {
        var (module, screen) = Module();
        var capture = Capture();
        capture["explored"] = JsonNode.Parse("""[{"id":"m:detalhes-do-produto@account-select=1","view":"catalogo","assign":{}}]""");
        var dom = PrototypeRender.Render(new FakeReader(module), capture, "o11", new Dictionary<string, Fake> { ["v:catalogo"] = screen });
        Assert.Equal("detalhes-do-produto", dom["states"]![0]!["modal"]!.ToString());
        Assert.Single(CssSelectors.Select(DomNode.FromJson(dom["states"]![0]!["root"]), ".popup-backdrop .ssam-tag-dialog"));
    }

    [Fact]
    public void TheRenderSeamIsRegisteredByTheCssLane()
    {
        Assert.NotNull(PrototypeSeams.Render);
        Assert.NotNull(PrototypeSeams.Css);
    }

    [Fact]
    public void ARealModuleReadBackRendersItsWidgetsThroughTheTable()
    {
        if (!StudioAvailable()) return;
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var output = Path.Combine(Work, "widgets.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Path.Combine(Root, "tests", "jobs", "widgets-reactive.json"), output))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        // The fixture already has a Widgets screen: the job names this one Widgets2; its key is the handle.
        var capture = JsonNode.Parse("""{"schema":"ssam-prototype-capture/1","explored":[{"id":"v:widgets@canonical","view":"widgets","assign":{}}]}""")!.AsObject();
        var dom = PrototypeRender.RenderOml(host, output, capture, "o11", new Dictionary<string, string> { ["v:widgets"] = "@" + result["handles"]!["$scr"] });
        var root = DomNode.FromJson(dom["states"]![0]!["root"]);
        // The layout block of OutSystems UI is a reference here: its contents render in place, inside div.OSBlockWidget.
        var box = Assert.Single(CssSelectors.Select(root, "div.OSBlockWidget div#Box.padding-m[data-container]"));
        var check = Assert.Single(CssSelectors.Select(box, "span > input#ActiveCheck[data-checkbox][type=checkbox]"));
        Assert.Equal("ICheckbox", check.Parent!.Runtime);
        Assert.Contains(box.Descendants(includeSelf: false), n => n.Tag == "label" && n.Descendants(includeSelf: false).Any(t => t.Text == "Active"));
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
