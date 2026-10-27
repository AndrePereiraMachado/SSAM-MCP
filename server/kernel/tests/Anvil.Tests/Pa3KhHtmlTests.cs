using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane kh of the atritos 3 package: the html-visual compiler names block instances as the Studio does (C05), compiles the
/// markup a prototype writes (C13: a link with children, a screen in onclick, an icon-only link with its title, an external
/// image, a closing tag of a void element, a dynamic class, a Gallery whose slots are filled, a list without its Source, every
/// problem of an element at once) and passes the arguments of an onclick in the order of the callee's inputs (C28, I7).
/// The pure tests read the ops; the model tests run the ops through JobRunner and the Verify over the Reactive fixture.
/// </summary>
public sealed class Pa3KhHtmlTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa3KhHtmlTests).Assembly.Location)!)!;

    private static UiParam Param(string name, string type, bool mandatory = false) => new(name, type, mandatory, null, null);
    private static ScreenContract Signature(string reference, params UiParam[] inputs) => new(reference, inputs, [], [], [], [],
        new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());

    private static HtmlVisualScope Scope(IReadOnlySet<string>? taken = null, IReadOnlySet<string>? earlier = null) => new(
        ["ProductId", "ItemCount", "Selected", "ImageUrl"],
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Chosen"] = "@chosen", ["CellClick"] = "@cell", ["ChangeQuantity"] = "@qty", ["Opaque"] = "@opaque" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Badge"] = "IMobileBlock:Badge", ["Gallery"] = "IMobileBlock:Gallery" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Logo"] = "IImage:Logo" },
        reference => reference switch
        {
            "@chosen" => Signature(reference, Param("Id", "Text")),
            "@cell" => Signature(reference, Param("Index", "Integer", mandatory: true)),
            "@qty" => Signature(reference, Param("LineId", "Line Identifier", mandatory: true), Param("Delta", "Integer", mandatory: true)),
            "@detail" => Signature(reference, Param("ProductId", "Product Identifier", mandatory: true)),
            "@cart" => Signature(reference),
            "IMobileBlock:Badge" => new(reference, [Param("Number", "Integer")], [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
            "IMobileBlock:Gallery" => new(reference, [], [], [], [], [new UiPlaceholder("Content", null, "Content", ["List"])], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
            _ => null,
        })
    {
        Screens = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["ProdutoDetalhe"] = "@detail", ["Carrinho"] = "@cart" },
        Taken = taken, Earlier = earlier,
    };

    private static HtmlVisualFragment Fragment(string html, HtmlVisualScope? scope = null) => HtmlVisual.Expand(html, "$screen", scope ?? Scope());
    private static List<JsonObject> Ops(string html, HtmlVisualScope? scope = null) => Fragment(html, scope).Ops;
    private static bool Is(JsonObject o, string type) => o["op"]?.ToString() == "create" && o["type"]?.ToString() == type;
    private static bool Sets(JsonObject o, string target, string prop, string value) => o["op"]?.ToString() == "set" && o["target"]?.ToString() == target && o["prop"]?.ToString() == prop && o["value"]?.ToString() == value;
    private static List<JsonObject> Problems(Action compile) => (Errors.FindCoded(Assert.ThrowsAny<Exception>(compile))?.Problems ?? []).Select(p => p!.AsObject()).ToList();

    // ---- C05: block instance names --------------------------------------------------------------------------------------

    [Fact]
    public void UnnamedBlockHasNoCustomName()
    {
        // Labs 18, 21, 22, 24, 30 and 38: the kernel named the instance Block1 and the Studio's merge dropped the name
        // (CustomName[] / CustomName[Block1], CustomNameIsSuffix[True] / [False]): MERGE_UNCERTAIN.
        var block = Ops("<Block name=\"Badge\" :Number=\"ItemCount\"></Block>").Single(o => Is(o, "IMobileBlockInstanceWidget"));
        Assert.False(block.ContainsKey("name"), block.ToJsonString());
        Assert.Equal("IMobileBlock:Badge", block["source"]!.ToString());
        // an id is still the name the author chose
        Assert.Equal("CartBadge", Ops("<Block id=\"CartBadge\" name=\"Badge\"></Block>").Single(o => Is(o, "IMobileBlockInstanceWidget"))["name"]!.ToString());
    }

    [Fact]
    public void TwoFragmentsSameScreenNeverCollide()
    {
        // Lab 20: two html ops on the screen Produtos each gave Block1 (CANDIDATE_REFUSED "Duplicated object Block1").
        const string html = "<div class=\"a\"><span>x</span><Block name=\"Badge\"></Block></div>";
        var first = Fragment(html);
        var taken = new HashSet<string>(first.Created, StringComparer.OrdinalIgnoreCase);
        var second = Fragment(html, Scope(taken, taken));
        Assert.Equal(["Div1", "Span1"], first.Created.Order());
        Assert.Empty(second.Created.Intersect(first.Created, StringComparer.OrdinalIgnoreCase));
        Assert.Equal(["Div2", "Span2"], second.Created.Order());
        Assert.All(first.Ops.Concat(second.Ops).Where(o => Is(o, "IMobileBlockInstanceWidget")), o => Assert.False(o.ContainsKey("name")));
        // a generated name never takes an id the fragment writes elsewhere
        Assert.Contains(Ops("<div></div><div id=\"Div1\"></div>"), o => Is(o, "IContainer") && o["name"]?.ToString() == "Div2");
    }

    [Fact]
    public void AnIdRepeatedFromAnEarlierFragmentIsHtmlIdDuplicateAndFromTheBaseNameCollision()
    {
        var taken = new HashSet<string>(["Panel", "Header"], StringComparer.OrdinalIgnoreCase);
        var earlier = new HashSet<string>(["Panel"], StringComparer.OrdinalIgnoreCase);
        var problems = Problems(() => Fragment("<div><div id=\"Panel\"></div><div id=\"Header\"></div></div>", Scope(taken, earlier)));
        var duplicate = Assert.Single(problems, p => p["code"]!.ToString() == "HTML_ID_DUPLICATE");
        Assert.Contains("id=\"Panel2\"", duplicate["fix"]!.ToString());
        var collision = Assert.Single(problems, p => p["code"]!.ToString() == "NAME_COLLISION");
        Assert.Contains("id=\"Header2\"", collision["fix"]!.ToString());
    }

    // ---- C13: prototype markup ----------------------------------------------------------------------------------------

    [Fact]
    public void ALinkWithChildrenIsALinkWithItsContent()
    {
        // Lab 14 as written: no onclick (the job set the Destination with a later op), an icon and an if with a block inside.
        var ops = Ops("<a id=\"CartBadgeLink\" class=\"display-flex gap-xs\"><i icon=\"shopping-cart\" weight=\"regular\"></i><div if=\"ItemCount > 0\"><Block name=\"Badge\" :Number=\"ItemCount\"></Block></div></a>");
        var link = ops.Single(o => Is(o, "ILink"));
        Assert.Equal("CartBadgeLink", link["name"]!.ToString());
        var alias = link["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == alias + "/#ITextWidget");
        Assert.Equal(["IIcon", "IIfWidget"], ops.Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() == alias).Select(o => o["type"]!.ToString()));
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Destination");
        Assert.Contains(ops, o => Sets(o, alias, "Style", "\"display-flex gap-xs\""));
    }

    [Fact]
    public void AnOnclickThatNamesAScreenNavigatesAndPassesTheMandatoryInputOfTheSameName()
    {
        // Lab 15: onclick="ProdutoDetalhe" in the ProductCard block, whose input ProductId the screen needs.
        var fragment = Fragment("<a id=\"ProductCardLink\" onclick=\"ProdutoDetalhe\" class=\"card\"><div class=\"padding-base\">{{ ItemCount }}</div></a>");
        var ops = fragment.Ops;
        var alias = ops.Single(o => Is(o, "ILink"))["as"]!.ToString();
        var destination = ops.FindIndex(o => Sets(o, alias + "/OnClick", "Destination", "@detail"));
        var argument = ops.FindIndex(o => Sets(o, alias + "/OnClick/ProductId", "Value", "ProductId"));
        Assert.True(destination >= 0 && argument > destination, string.Join("\n", ops.Select(o => o.ToJsonString())));
        Assert.Equal("ProductId", fragment.Report["implicitArguments"]![0]!["input"]!.ToString());
        Assert.Equal(["@detail"], fragment.Report["screens"]!.AsArray().Select(s => s!.ToString()));
        // href names a screen too; "#" goes nowhere and is no attribute
        var href = Ops("<a href=\"Carrinho\">Carrinho</a>");
        Assert.Contains(href, o => o["prop"]?.ToString() == "Destination" && o["value"]?.ToString() == "@cart");
        var nowhere = Ops("<a href=\"#\">Ver</a>");
        Assert.DoesNotContain(nowhere, o => o["prop"]?.ToString() is "Destination" or "Property");
    }

    [Fact]
    public void AnIconOnlyLinkTakesItsTitleAsItsAccessibleText()
    {
        var ops = Ops("<a onclick=\"Carrinho\" title=\"Abrir carrinho\"><i icon=\"shopping-cart\" weight=\"regular\"></i></a>");
        var properties = ops.Where(o => o["prop"]?.ToString() == "Property").Select(o => o["value"]!.ToString()).ToList();
        Assert.Contains("aria-label", properties);
        Assert.Contains("title", properties);
        Assert.Equal(2, ops.Count(o => o["prop"]?.ToString() == "Value" && o["value"]?.ToString() == "\"Abrir carrinho\""));
    }

    [Fact]
    public void AnExternalImageIsTypeExternalWithItsUrl()
    {
        var url = Ops("<img src=\"https://cdn.example.com/p.png\" alt=\"Produto\">");
        var alias = url.Single(o => Is(o, "IImage"))["as"]!.ToString();
        Assert.Contains(url, o => Sets(o, alias, "Type", "External"));
        Assert.Contains(url, o => Sets(o, alias, "Url", "\"https://cdn.example.com/p.png\""));
        Assert.DoesNotContain(url, o => o["prop"]?.ToString() == "Image");
        Assert.Contains(Ops("<img src=\"{{ ImageUrl }}\">"), o => o["prop"]?.ToString() == "Url" && o["value"]?.ToString() == "ImageUrl");
        Assert.Contains(Ops("<div list=\"GetProducts.List\" as=\"Row\"><img src=\"{{ Row.ImageUrl }}\"></div>"), o => o["prop"]?.ToString() == "Url" && o["value"]?.ToString() == "GetProducts.List.Current.ImageUrl");
        // a module image stays Static
        Assert.Contains(Ops("<img src=\"Logo\">"), o => o["prop"]?.ToString() == "Image" && o["value"]?.ToString() == "IImage:Logo");
    }

    [Fact]
    public void TheClosingTagOfAnHrIsToleratedWithANote()
    {
        // Lab 23: "</hr> closes a void element" refused the cart screen.
        var fragment = Fragment("<div class=\"card\"><span>Frete</span><hr></hr><span>Total</span></div>");
        Assert.Single(fragment.Ops, o => Sets(o, o["target"]?.ToString() ?? "", "Tag", "hr"));
        Assert.Contains("</hr>", fragment.Report["notes"]![0]!.ToString());
    }

    [Fact]
    public void ADynamicClassIsAnExpressionOnTheStyleOrOnTheClassAttribute()
    {
        var div = Ops("<div class='chip {{ If(Selected, \"on\", \"off\") }}'></div>");
        Assert.Contains(div, o => o["prop"]?.ToString() == "Style" && o["value"]?.ToString() == "\"chip \" + If(Selected, \"on\", \"off\")");
        var span = Ops("<span class='{{ If(Selected, \"badge on\", \"badge\") }}'>{{ ItemCount }}</span>");
        Assert.Contains(span, o => Is(o, "IAdvancedHtml"));
        Assert.Contains(span, o => o["prop"]?.ToString() == "Property" && o["value"]?.ToString() == "class");
        Assert.Contains(span, o => o["prop"]?.ToString() == "Value" && o["value"]?.ToString() == "If(Selected, \"badge on\", \"badge\")");
    }

    [Fact]
    public void GalleryWithSlotHasNoExampleContent()
    {
        // Lab 19: the OSUI Gallery kept its example List (no Source) and Image (no value) next to the slot content.
        var gallery = Ops("<Block name=\"Gallery\"><slot name=\"Content\"><span>x</span></slot></Block>").Single(o => Is(o, "IMobileBlockInstanceWidget"));
        Assert.True(gallery["empty"]?.GetValue<bool>(), gallery.ToJsonString());
        Assert.False(Ops("<Block name=\"Badge\" :Number=\"1\"></Block>").Single(o => Is(o, "IMobileBlockInstanceWidget")).ContainsKey("empty"));
    }

    [Fact]
    public void AListWithoutItsSourceSaysTheSourceBelongsOnTheElement()
        => Assert.Contains("needs its Source on the element", Assert.ThrowsAny<Exception>(() => Ops("<div list=\"\" as=\"Row\"><span>x</span></div>")).Message);

    [Fact]
    public void ALinkWithThreeFaultsGivesThreeProblems()
    {
        var problems = Problems(() => Ops("<a id=\"1x\" onclick=\"Chosen(1, 2)\" :Ghost=\"3\">Go</a>"));
        Assert.Equal(3, problems.Count);
        Assert.Contains(problems, p => p["message"]!.ToString().Contains("not a valid widget name"));
        Assert.Equal(2, problems.Count(p => p["code"]!.ToString() == "ARGUMENT_UNKNOWN"));
    }

    // ---- C28 (html part): event arguments, I7 -------------------------------------------------------------------------

    [Fact]
    public void OnclickWithArgumentsSetsIndex()
    {
        // The tic-tac-toe (labs 03 and 04): onclick="CellClick" had no Index and the job set it by **IButton[n], which was
        // another button. The argument now goes with the Destination, in the order of the inputs.
        var ops = Ops("<button id=\"Cell0\" onclick=\"CellClick(0)\" class=\"cell\">{{ ItemCount }}</button>");
        var alias = ops.Single(o => Is(o, "IButton"))["as"]!.ToString();
        var destination = ops.FindIndex(o => Sets(o, alias + "/OnClick", "Destination", "@cell"));
        var index = ops.FindIndex(o => Sets(o, alias + "/OnClick/Index", "Value", "0"));
        Assert.True(destination >= 0 && index == destination + 1, string.Join("\n", ops.Select(o => o.ToJsonString())));
        // :Input names an argument; two inputs keep the order of the callee, inside a list with the row scope
        var named = Ops("<div list=\"GetLines.List\" as=\"Line\"><button onclick=\"ChangeQuantity\" :Delta=\"-1\" :LineId=\"Line.Id\">-</button></div>");
        var button = named.Single(o => Is(o, "IButton"))["as"]!.ToString();
        var arguments = named.Where(o => o["target"]?.ToString()?.StartsWith(button + "/OnClick/", StringComparison.Ordinal) == true).Select(o => o["target"] + "=" + o["value"]).ToList();
        Assert.Equal([button + "/OnClick/LineId=GetLines.List.Current.Id", button + "/OnClick/Delta=-1"], arguments);
        // an argument list that leaves a mandatory input out is REQUIRED_ARGUMENT; a bare name leaves it to the job and the Verify
        Assert.Equal("REQUIRED_ARGUMENT", Assert.Single(Problems(() => Ops("<button onclick=\"CellClick()\">X</button>")))["code"]!.ToString());
        Assert.DoesNotContain(Ops("<button onclick=\"ChangeQuantity\">+</button>"), o => o["target"]?.ToString()?.Contains("/OnClick/") == true);
    }

    [Fact]
    public void WithoutTheCalleeSignatureANamedArgumentStillGoesAndAPositionIsRefused()
    {
        // The signature cannot be read (Contract answers null): :Input names its input, the Verify judges it; a position names none.
        var named = Ops("<button onclick=\"Opaque\" :Index=\"ItemCount + 1\">X</button>");
        var alias = named.Single(o => Is(o, "IButton"))["as"]!.ToString();
        // an HTML attribute name has no case (the parser lowers it); the kernel resolves the child by name without case
        Assert.Contains(named, o => Sets(o, alias + "/OnClick/index", "Value", "ItemCount + 1"));
        var positional = Assert.Single(Problems(() => Ops("<button onclick=\"Opaque(1)\">X</button>")));
        Assert.Equal("ARGUMENT_UNKNOWN", positional["code"]!.ToString());
        Assert.Contains(":<input1>=\"1\"", positional["fix"]!.ToString());
    }

    // ---- model proofs: the ops pass the Verify ------------------------------------------------------------------------

    [Fact]
    public void TwoFragmentsOnOneScreenGiveUniqueNamesAndAnIdIsAnAliasOfTheJob()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "pa3-kh-html"); Directory.CreateDirectory(work);
        const string fragment = "<div class=\"pa3-row\"><span>Itens</span><Block name=\"Pa3Badge\" :Count=\"Total\"></Block></div>";
        var ops = new JsonArray(
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Pa3Badge","as":"$blk"}"""),
            Op("""{"op":"create","parent":"$blk","type":"IInputParameter","name":"Count","as":"$bin"}"""),
            Op("""{"op":"set","target":"$bin","prop":"DataType","value":"Integer"}"""),
            new JsonObject { ["op"] = "html", ["parent"] = "$blk", ["html"] = "<span class=\"pa3-badge\">{{ Count }}</span>" },
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Names","as":"$scr"}"""),
            Op("""{"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutBlank","empty":true}"""),
            Op("""{"op":"create","parent":"$scr","type":"ILocalVariable","name":"Total","as":"$v"}"""),
            Op("""{"op":"set","target":"$v","prop":"DataType","value":"Integer"}"""),
            new JsonObject { ["op"] = "html", ["parent"] = "$scr", ["html"] = fragment },
            new JsonObject { ["op"] = "html", ["parent"] = "$scr", ["html"] = "<div id=\"Pa3Panel\">" + fragment + "</div>" },
            Op("""{"op":"set","target":"$Pa3Panel","prop":"Style","value":"\"pa3-panel\""}"""),
            Op("""{"op":"dump","target":"IMobileScreen:Pa3Names","depth":12}"""));
        var result = Run(work, "names", ops);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var second = result["results"]!.AsArray()[9]!["result"]!.AsObject();
        Assert.Equal(["$Pa3Panel"], second["aliases"]!.AsArray().Select(a => a!.ToString()));
        var names = new List<string>();
        void Walk(JsonNode? node)
        {
            if (node is JsonObject o)
            {
                if (o["name"] is JsonValue n && o["type"]?.ToString() is { } type && type != "IExtendedProperty" && !type.Contains("Variable")) names.Add(type + ":" + n);
                foreach (var (_, child) in o) Walk(child);
            }
            else if (node is JsonArray a) foreach (var child in a) Walk(child);
        }
        Walk(result["results"]!.AsArray()[11]!["result"]);
        var widgets = names.Where(n => n.StartsWith("IContainer:Div", StringComparison.Ordinal) || n.StartsWith("IAdvancedHtml:Span", StringComparison.Ordinal)).ToList();
        Assert.Equal(widgets.Count, widgets.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.Contains("IContainer:Div2", widgets);
        Assert.DoesNotContain(names, n => n.EndsWith(":Block1", StringComparison.Ordinal));
    }

    [Fact]
    public void ALinkWithContentNavigatesToAScreenWithItsArgumentAndPassesTheVerify()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "pa3-kh-html"); Directory.CreateDirectory(work);
        var ops = new JsonArray(
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Detail","as":"$det"}"""),
            Op("""{"op":"set","target":"$det/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutBlank","empty":true}"""),
            Op("""{"op":"create","parent":"$det","type":"IInputParameter","name":"ItemId","as":"$in"}"""),
            Op("""{"op":"set","target":"$in","prop":"DataType","value":"Integer"}"""),
            Op("""{"op":"set","target":"$in","prop":"IsMandatory","value":true}"""),
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3List","as":"$lst"}"""),
            Op("""{"op":"set","target":"$lst/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutBlank","empty":true}"""),
            Op("""{"op":"create","parent":"$lst","type":"ILocalVariable","name":"ItemId","as":"$v"}"""),
            Op("""{"op":"set","target":"$v","prop":"DataType","value":"Integer"}"""),
            new JsonObject { ["op"] = "html", ["parent"] = "$lst", ["html"] = "<div class=\"pa3-list\"><a id=\"Pa3Card\" onclick=\"Pa3Detail\" class=\"card\"><i icon=\"star\" weight=\"regular\"></i><div class=\"pa3-name\">{{ ItemId }}</div></a><hr></hr><img src=\"https://example.com/a.png\">"
                // lab 39: a span whose class is dynamic, and an icon-only link that says what it does by its title
                + "<span class='pa3-tag {{ If(ItemId > 0, \"on\", \"off\") }}'>{{ ItemId }}</span><a onclick=\"Pa3Detail(ItemId + 1)\" title=\"Abrir\"><i icon=\"star\" weight=\"regular\"></i></a></div>" });
        var result = Run(work, "navigate", ops);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var report = result["results"]!.AsArray()[9]!["result"]!.AsObject();
        Assert.Equal("ItemId", report["implicitArguments"]![0]!["input"]!.ToString());
        Assert.Single(report["implicitArguments"]!.AsArray());
    }

    private static JsonObject Op(string json) => JsonNode.Parse(json)!.AsObject();

    private static JsonObject Run(string work, string name, JsonArray ops)
    {
        var job = Path.Combine(work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), job, Path.Combine(work, name + ".oml")))!.AsObject();
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
