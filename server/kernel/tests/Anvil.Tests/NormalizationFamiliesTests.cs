using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-C (2026-10-29): refusals whose correction is unique, normalized instead and listed, each family at its central point and
/// each with its ambiguous case, which keeps refusing with the readings it has. Synthetic names; the module parts (the compile
/// and the edit of a screen) need the Service Studio and are skipped without it.
/// <list type="bullet">
/// <item>HTML_TEXT_ESCAPED: a loose &amp; or &lt; of the html is text in HTML: written as its entity before the parsers read it.</item>
/// <item>TYPE_SIZE_DROPPED: a size on a kind that keeps none (a site property or setting, a parameter, a local).</item>
/// <item>RECORD_ENTITY_MEMBER_ADDED: N.Record.Attr of a Get&lt;E&gt; node is N.Record.E.Attr.</item>
/// <item>IMG_PATH_IMAGE / IMG_PATH_EXPRESSION: a dotted src is the module image or the expression, when only one exists.</item>
/// <item>TEXT_LITERAL_QUOTED: prose in an expression attribute that shows text is its literal, in the document and the edit.</item>
/// </list>
/// </summary>
public sealed class NormalizationFamiliesTests
{
    public NormalizationFamiliesTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the pure families still run */ } }

    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NormalizationFamiliesTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "normalization-families");

    private static JsonArray Ops(params string[] ops) => new(ops.Select(o => JsonNode.Parse(o)).ToArray());

    private static List<JsonObject> Normalize(JsonArray ops, string lane = "o11") => JobNormalizer.Pure(ops, "/ops", lane);

    private static List<JsonObject> Rule(IEnumerable<JsonObject> entries, string rule)
        => entries.Where(e => (e["rule"]?.ToString() ?? "").Split('+').Contains(rule)).ToList();

    private static string HtmlOp(string html) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }.ToJsonString();

    // ---- HTML_TEXT_ESCAPED -------------------------------------------------------------------------------------------------

    [Fact]
    public void ALooseAmpersandOrLessThanOfTheHtmlIsWrittenAsItsEntityInEveryForm()
    {
        const string html = "<screen name=\"NzTela\"><var name=\"NzCount\" type=\"Integer\"/>\n<div class=\"a\">Terms & conditions</div>\n"
            + "<span>{{ NzCount }} < 5 and 3<4</span>\n<input bind=\"NzCount\" placeholder=\"&quot;Fish & chips&quot;\"/>\n<style>.a > b { color: red; } .b{content:'&'}</style></screen>";
        var ops = Ops(HtmlOp(html),
            """{"op":"html","data":{"screen":"NzTela","basedOn":{"capture":"c","html":"h"},"edit":["<div k=\"w1\">Q & A < 3</div>"]}}""",
            """{"op":"html","data":{"screen":"NzTela","basedOn":{"capture":"c","html":"h"},"edits":[{"find":"a & b","with":"<b>x & y</b>"},{"replace":"w1","with":"<div k=\"w1\">Q & A</div>"},{"into":"/","insert":"<p>1 < 2</p>"}]}}""");
        var entries = Rule(Normalize(ops), "HTML_TEXT_ESCAPED");
        // Whole elements (replace, insert) are HTML; the with of a find lands where the find is, which only the reading says
        // (AFindWithWhoseTextLandsInTheRawTextOfAStyleIsLeftAsWritten).
        Assert.Equal(["/ops/0/data/html", "/ops/1/data/edit/0", "/ops/2/data/edits/1/with", "/ops/2/data/edits/2/insert"], entries.Select(e => e["path"]!.ToString()).ToArray());
        var written = ops[0]!["data"]!["html"]!.ToString();
        Assert.Contains("Terms &amp; conditions", written);
        Assert.Contains("{{ NzCount }} &lt; 5 and 3&lt;4", written);
        Assert.Contains("&quot;Fish &amp; chips&quot;", written);
        // The raw text of the style is as written, and so is every tag.
        Assert.Contains("<style>.a > b { color: red; } .b{content:'&'}</style>", written);
        // The strict parser reads it now, and the page shows the same text.
        var parsed = ScreenHtml.Parse(written);
        var texts = ScreenHtmlText.Elements(parsed).SelectMany(x => x.Node.Children).Where(c => c.IsText).Select(c => c.Text!.Trim()).ToList();
        Assert.Contains("Terms & conditions", texts);
        Assert.Contains("{{ NzCount }} < 5 and 3<4", texts);
        Assert.Equal("<div k=\"w1\">Q &amp; A &lt; 3</div>", ops[1]!["data"]!["edit"]![0]!.ToString());
        Assert.Equal("a & b", ops[2]!["data"]!["edits"]![0]!["find"]!.ToString());   // the reading's own text: never changed
        Assert.Equal("<b>x & y</b>", ops[2]!["data"]!["edits"]![0]!["with"]!.ToString());
        Assert.Equal("<div k=\"w1\">Q &amp; A</div>", ops[2]!["data"]!["edits"]![1]!["with"]!.ToString());
        Assert.Equal("<p>1 &lt; 2</p>", ops[2]!["data"]!["edits"]![2]!["insert"]!.ToString());
        // A fixed point: the text written goes through unchanged.
        Assert.Empty(Rule(Normalize(ops), "HTML_TEXT_ESCAPED"));
    }

    [Fact]
    public void AFindWithWhoseTextLandsInTheRawTextOfAStyleIsLeftAsWritten()
    {
        const string reading = "<screen name=\"NzTela\">\n<style>.a { color: red; }\n@media (min-width: 1px) { .b { color: blue; } }\n.c::after { content: \"x\"; }</style>\n<div k=\"w1\">x</div>\n</screen>";
        var ops = Ops("""
            {"op":"html","data":{"screen":"NzTela","basedOn":{"capture":"c","html":"h"},"edits":[
              {"find":".a { color: red; }","with":".a { color: red; &:hover { color: green; } }"},
              {"find":"(min-width: 1px)","with":"(width < 600px)"},
              {"find":"content: \"x\";","with":"content: \"R & D\";"},
              {"find":"x</div>","with":"Q & A</div>"}]}}
            """);
        // The preflight does not know where a find lands: none of these is rewritten there.
        Assert.DoesNotContain(Rule(Normalize(ops), "HTML_TEXT_ESCAPED"), e => e["path"]!.ToString().StartsWith("/ops/0/data/edits/", StringComparison.Ordinal));
        var edits = ops[0]!["data"]!["edits"]!.AsArray();
        var (document, problems, _) = HtmlElementEdits.Apply(reading, edits, null);
        Assert.Empty(problems);
        // The style keeps the CSS as written (nesting, a range query, a text with &), which HTML reads as raw text.
        var parsed = ScreenHtml.Parse(document);
        var style = ScreenHtmlText.Elements(parsed).Select(x => x.Node).First(n => n.Tag == "style");
        Assert.Equal(".a { color: red; &:hover { color: green; } }\n@media (width < 600px) { .b { color: blue; } }\n.c::after { content: \"R & D\"; }",
            string.Concat(style.Children.Select(c => c.Text)));
        // A with that lands in the text of a <div> is HTML there: written as its entity, and listed with its edit.
        Assert.Contains("<div k=\"w1\">Q &amp; A</div>", document);
        Assert.Equal("Q & A", ScreenHtmlText.Elements(parsed).Select(x => x.Node).First(n => n.Get("k") == "w1").Children.Single(c => c.IsText).Text!.Trim());
        var withEscapes = typeof(HtmlElementEdits).GetMethods().SingleOrDefault(m => m.Name == "Apply" && m.GetParameters().Length == 5);
        Assert.NotNull(withEscapes);
        var arguments = new object?[] { reading, ops[0]!["data"]!["edits"]!.DeepClone().AsArray(), null, null, null };
        withEscapes!.Invoke(null, arguments);
        var escaped = ((System.Collections.IEnumerable)arguments[4]!).Cast<object>().Select(e => (int)e.GetType().GetField("Item1")!.GetValue(e)!).ToList();
        Assert.Equal([3], escaped);
    }

    [Fact]
    public void AnAmpersandBeforeALetterAndALessThanBeforeALetterKeepTheirRefusalWithBothReadings()
    {
        // R&D may be a reference written without its ';' and <b may be a tag: two readings, never rewritten.
        const string html = "<screen name=\"NzTela\"><div>R&D team</div></screen>";
        var ops = Ops(HtmlOp(html));
        Assert.Empty(Rule(Normalize(ops), "HTML_TEXT_ESCAPED"));
        Assert.Equal(html, ops[0]!["data"]!["html"]!.ToString());
        var refused = Assert.ThrowsAny<FormatException>(() => ScreenHtml.Parse(html));
        Assert.Contains("two readings", refused.Message);
        Assert.Contains("&amp;", refused.Message);
        Assert.Contains("&name;", refused.Message);
    }

    // ---- TYPE_SIZE_DROPPED ---------------------------------------------------------------------------------------------------

    private static string Ddl(string text) => new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } }.ToJsonString();

    [Fact]
    public void ASizeOnAKindThatKeepsNoneIsDroppedInEveryForm()
    {
        var ops = Ops(Ddl("site property NzLimit: Decimal(37,8) = 0\nsite property NzLabel: Text(50) = \"x\"\nsite property NzPages: Integer = 10\n"),
            """{"op":"logic","data":{"flow":["server action NzTotal\n  in Amount: Decimal(18, 2)\n  out Total: Decimal(37,8)\n  local Note: Text(200)\n  assign Total = Amount * 2\n  end\n"]}}""",
            """{"op":"logic","data":{"actions":[{"name":"NzSum","inputs":[{"name":"A","type":"Decimal(37,8)"}],"outputs":[{"name":"S","type":"Decimal"}],"vars":[{"name":"T","type":"Text(30)"}],"steps":[{"assign":{"S":"A"}}]}]}}""");
        var entries = Rule(Normalize(ops), "TYPE_SIZE_DROPPED");
        Assert.Equal(2 + 3 + 2, entries.Count);
        Assert.Equal("site property NzLimit: Decimal = 0\nsite property NzLabel: Text = \"x\"\nsite property NzPages: Integer = 10\n", ops[0]!["data"]!["ddl"]!.ToString());
        var flow = ops[1]!["data"]!["flow"]![0]!.ToString();
        Assert.Contains("  in Amount: Decimal\n", flow);
        Assert.Contains("  out Total: Decimal\n", flow);
        Assert.Contains("  local Note: Text\n", flow);
        var action = ops[2]!["data"]!["actions"]![0]!;
        Assert.Equal("Decimal", action["inputs"]![0]!["type"]!.ToString());
        Assert.Equal("Text", action["vars"]![0]!["type"]!.ToString());
        Assert.Contains(entries, e => e["path"]!.ToString() == "/ops/2/data/actions/0/inputs/0/type");
        // ODC: a setting keeps no size either.
        var odc = Ops(Ddl("setting NzBaseUrl: Text(250) = \"https://example.test\"\n"));
        Assert.Single(Rule(Normalize(odc, "odc"), "TYPE_SIZE_DROPPED"));
        Assert.Equal("setting NzBaseUrl: Text = \"https://example.test\"\n", odc[0]!["data"]!["ddl"]!.ToString());
        // Fixed point.
        Assert.Empty(Rule(Normalize(ops), "TYPE_SIZE_DROPPED"));
    }

    [Fact]
    public void AnAttributeKeepsItsSizeAndASizeTheGrammarDoesNotReadIsLeftToItsRefusal()
    {
        const string entity = "create entity NzItem (\n  Id Long Integer identifier auto required,\n  Price Decimal(18,2),\n  Name Text(50)\n);\n";
        var ops = Ops(Ddl(entity), """{"op":"logic","data":{"flow":["server action NzOdd\n  in Count: Integer(5)\n  local Weird: Decimal(a)\n  end\n"]}}""");
        Assert.Empty(Rule(Normalize(ops), "TYPE_SIZE_DROPPED"));
        Assert.Equal(entity, ops[0]!["data"]!["ddl"]!.ToString());
        Assert.Contains("Integer(5)", ops[1]!["data"]!["flow"]![0]!.ToString());
    }

    // ---- RECORD_ENTITY_MEMBER_ADDED -----------------------------------------------------------------------------------------

    private const string Entity = """{"op":"spec","data":{"entities":[{"name":"NzOrder","attributes":[{"name":"Total","type":"Decimal"},{"name":"Code","type":"Text"}]}],"structures":[{"name":"NzShape","attributes":[{"name":"Total","type":"Decimal"}]}]}}""";

    [Fact]
    public void TheRecordOfAGetOfAnEntityIsReadThroughItsEntityInEveryExpression()
    {
        var ops = Ops(Entity,
            """{"op":"logic","data":{"flow":["server action NzPay\n  in OrderId: NzOrder Identifier\n  out Total: Decimal\n  Load = GetNzOrderForUpdate(Id=OrderId)\n  if Load.Record.Total > 0:\n    assign Total = Load.Record.Total + Load.Record.NzOrder.Total\n  end\n"]}}""",
            """{"op":"logic","data":{"actions":[{"name":"NzCode","inputs":[{"name":"OrderId","type":"NzOrder Identifier"}],"outputs":[{"name":"Code","type":"Text"}],"steps":[{"call":"GetNzOrder","as":"Found","args":{"Id":"OrderId"}},{"assign":{"Code":"Found.Record.Code + \"Found.Record.Code\""}}]}]}}""");
        var entries = Rule(Normalize(ops), "RECORD_ENTITY_MEMBER_ADDED");
        Assert.Equal(3, entries.Count);
        var flow = ops[1]!["data"]!["flow"]![0]!.ToString();
        Assert.Contains("  if Load.Record.NzOrder.Total > 0:\n", flow);
        Assert.Contains("assign Total = Load.Record.NzOrder.Total + Load.Record.NzOrder.Total\n", flow);
        // The text literal keeps its text; the expression is written through the entity.
        Assert.Equal("Found.Record.NzOrder.Code + \"Found.Record.Code\"", ops[2]!["data"]!["actions"]![0]!["steps"]![1]!["assign"]!["Code"]!.ToString());
        Assert.Contains(entries, e => e["path"]!.ToString().StartsWith("/ops/2/data/actions/0/steps/1/assign", StringComparison.Ordinal));
        Assert.Empty(Rule(Normalize(ops), "RECORD_ENTITY_MEMBER_ADDED"));
    }

    [Fact]
    public void ARecordThatIsNoGetOfAnEntityOrAnAttributeItDoesNotHaveIsLeftAsWritten()
    {
        var text = "server action NzOther\n  in OrderId: NzOrder Identifier\n  out Total: Decimal\n  Load = GetNzOrder(Id=OrderId)\n  Shape = GetNzShape(Id=OrderId)\n  Mine = GetNzMine(Id=OrderId)\n"
            + "  assign Total = Load.Record.Missing + Shape.Record.Total + Mine.Record.Total\n  end\n";
        // GetNzMine is an action of the job (its Record is its own output), NzShape a structure (no Get), Missing no attribute.
        var ops = Ops(Entity, new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text, "server action GetNzMine\n  in Id: NzOrder Identifier\n  out Record: NzShape\n  end\n") } }.ToJsonString());
        Assert.Empty(Rule(Normalize(ops), "RECORD_ENTITY_MEMBER_ADDED"));
        Assert.Equal(text, ops[1]!["data"]!["flow"]![0]!.ToString());
    }

    /// <summary>A base whose module has a client action GetNzOrder (output Record: NzOrder, its attributes direct) beside the
    /// entity NzOrder.</summary>
    private sealed class NzClientGetBase : IBaseFacts
    {
        public (string Key, string? Text)? OwnAction(string name, string kind) => name == "GetNzOrder" && kind == "ClientAction" ? ("nz-client-get", null) : null;
        public IReadOnlyDictionary<string, string>? Attributes(string record) => record == "NzOrder"
            ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Id"] = "NzOrder Identifier", ["Code"] = "Text" } : null;
        public bool IsClientEntity(string name) => false;
        public CalleeFact? Callee(string target, JsonObject caller) => target == "GetNzOrder"
            ? new CalleeFact("GetNzOrder", [new ParamFact("Id", "NzOrder Identifier", true)], [new ParamFact("Record", "NzOrder", false)]) : null;
        public bool HasName(string name) => name is "GetNzOrder" or "NzOrder";
        public bool NamesOnlyTypes(string name) => name == "NzOrder";
        public bool IsFunction(string name) => false;
        public string? ModuleType => "MobileApplication";
        public RawExpressionFact? RawExpression(string target, string prop) => null;
    }

    private static string CodeAction(string kind) => """{"op":"logic","data":{"actions":[{"name":"NzShowCode","kind":"KIND","inputs":[{"name":"OrderId","type":"NzOrder Identifier"}],"outputs":[{"name":"Code","type":"Text"}],"steps":[{"call":"GetNzOrder","as":"Found","args":{"Id":"OrderId"}},{"assign":{"Code":"Found.Record.Code"}}]}]}}""".Replace("KIND", kind);

    private static string CodeOf(JsonArray ops, int op) => ops[op]!["data"]!["actions"]![0]!["steps"]![1]!["assign"]!["Code"]!.ToString();

    [Fact]
    public void ACallThatIsNoEntityActionKeepsItsRecordAsWritten()
    {
        // (a) The module has a client action GetNzOrder: whoever calls it, its Record is its own output.
        foreach (var kind in new[] { "client", "server" })
        {
            var ops = Ops(CodeAction(kind));
            Assert.Empty(Rule(JobNormalizer.WithBase(ops, "/ops", "o11", new NzClientGetBase()), "RECORD_ENTITY_MEMBER_ADDED"));
            Assert.Equal("Found.Record.Code", CodeOf(ops, 0));
        }
        // (b) A client action of the job never calls the entity action of a server entity (it runs on the server only).
        var client = Ops(Entity, CodeAction("client"));
        Assert.Empty(Rule(Normalize(client), "RECORD_ENTITY_MEMBER_ADDED"));
        Assert.Equal("Found.Record.Code", CodeOf(client, 1));
        // (c) A server action of the job still reads it through its entity.
        var server = Ops(Entity, CodeAction("server"));
        Assert.Single(Rule(Normalize(server), "RECORD_ENTITY_MEMBER_ADDED"));
        Assert.Equal("Found.Record.NzOrder.Code", CodeOf(server, 1));
    }

    [Fact]
    public void ANodeNameOfOneActionIsNotReadInAnotherActionOfTheSameText()
    {
        const string spec = """{"op":"spec","data":{"entities":[{"name":"NzOrder","attributes":[{"name":"Total","type":"Decimal"}]}],"structures":[{"name":"NzShape","attributes":[{"name":"Total","type":"Decimal"}]},{"name":"NzWrap","attributes":[{"name":"Record","type":"NzShape"}]}]}}""";
        var text = "server action NzA\n  in OrderId: NzOrder Identifier\n  out T: Decimal\n  Load = GetNzOrder(Id=OrderId)\n  assign T = Load.Record.Total\n  end\n"
            + "server action NzB\n  in Load: NzWrap\n  out T: Decimal\n  assign T = Load.Record.Total\n  end\n";
        var ops = Ops(spec, new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }.ToJsonString());
        var entries = Rule(Normalize(ops), "RECORD_ENTITY_MEMBER_ADDED");
        var written = ops[1]!["data"]!["flow"]![0]!.ToString();
        var b = written[written.IndexOf("server action NzB", StringComparison.Ordinal)..];
        Assert.Contains("  assign T = Load.Record.Total\n", b);
        Assert.StartsWith("server action NzA\n  in OrderId: NzOrder Identifier\n  out T: Decimal\n  Load = GetNzOrder(Id=OrderId)\n  assign T = Load.Record.NzOrder.Total\n", written);
        Assert.Equal([5], entries.Select(e => e["line"]!.GetValue<int>()).ToArray());
    }

    // ---- IMG_PATH_IMAGE / IMG_PATH_EXPRESSION ---------------------------------------------------------------------------------

    private static (ScreenHtml.Node Top, ScreenHtmlNative.Outcome Outcome) Native(string body, params string[] images)
    {
        var top = ScreenHtml.Parse("<screen name=\"NzTela\" data-actions=\"NzLoad\"><var name=\"NzMe\" type=\"NzProfile\"/>" + body + "</screen>").Children.First(c => !c.IsText);
        IReadOnlyDictionary<string, string>? Records(string name) => name == "NzProfile" ? new Dictionary<string, string> { ["Photo"] = "Binary Data", ["Site"] = "Text" } : null;
        return (top, ScreenHtmlNative.Apply(top, _ => true, _ => null, _ => false, null, () => images, Records));
    }

    private static ScreenHtml.Node Img(ScreenHtml.Node top) => ScreenHtmlText.Elements(top).Select(x => x.Node).First(n => n.Tag == "img");

    [Fact]
    public void ADottedSrcIsTheModuleImageOrTheExpressionWhenOnlyOneOfThemExists()
    {
        // The last name is a module image and the first one no data of the page: that image.
        var (image, imageOutcome) = Native("<img src=\"Images.NzLogo\"/>", "NzLogo");
        Assert.Equal("NzLogo", Img(image).Get("src"));
        Assert.Contains(imageOutcome.Normalized, n => n["code"]!.ToString() == "IMG_PATH_IMAGE");
        Assert.Empty(imageOutcome.Problems);
        // The first name is data of the page and no module image has the last one: the expression, typed (Binary Data).
        var (binary, binaryOutcome) = Native("<img src=\"NzMe.Photo\"/>", "NzLogo");
        Assert.Null(Img(binary).Get("src"));
        Assert.Equal("NzMe.Photo", Img(binary).Get("os-ImageContent"));
        Assert.Equal("Binary", Img(binary).Get("os-Type"));
        Assert.Contains(binaryOutcome.Normalized, n => n["code"]!.ToString() == "IMG_PATH_EXPRESSION");
        // A text is the Url.
        var (text, _) = Native("<img src=\"NzMe.Site\"/>");
        Assert.Equal("NzMe.Site", Img(text).Get("url"));
        Assert.Equal("External", Img(text).Get("os-Type"));
        // A data action of the page is data too; its type is not known here: the binding's own refusal names both forms.
        var (action, actionOutcome) = Native("<img src=\"NzLoad.Photo\"/>");
        Assert.Contains(actionOutcome.Normalized, n => n["code"]!.ToString() == "IMG_PATH_EXPRESSION");
        Assert.Contains(actionOutcome.Problems, p => p.Code == ScreenHtmlNative.ImageBindingType);
    }

    [Fact]
    public void ADottedSrcWithTwoReadingsIsRefusedWithBothAndOneWithNoneIsLeftToTheCompile()
    {
        var (top, outcome) = Native("<img src=\"NzMe.Photo\"/>", "Photo");
        var problem = Assert.Single(outcome.Problems);
        Assert.Equal(ScreenDocument.NameAmbiguous, problem.Code);
        Assert.Contains("the module image Photo", problem.Message);
        Assert.Contains("{{ NzMe.Photo }}", problem.Message);
        Assert.Null(Img(top).Get("os-ImageContent"));
        // Neither an image nor data of the page: as written (the compile names what is unknown, with the nearest names).
        var (none, noneOutcome) = Native("<img src=\"Elsewhere.Thing\"/>", "NzLogo");
        Assert.Equal("Elsewhere.Thing", Img(none).Get("src"));
        Assert.Empty(noneOutcome.Problems);
        Assert.DoesNotContain(noneOutcome.Normalized, n => n["code"]!.ToString().StartsWith("IMG_PATH", StringComparison.Ordinal));
    }

    [Fact]
    public void ADottedSrcThroughAModuleQualifierHasTheExpressionReading()
    {
        // Client.X (a client variable) and Site.X (a site property, O11) are read by an expression of the page: with a module
        // image of the last name, two readings.
        foreach (var qualifier in new[] { "Client", "Site" })
        {
            var (top, outcome) = Native($"<img src=\"{qualifier}.NzLogo\"/>", "NzLogo");
            var problem = Assert.Single(outcome.Problems);
            Assert.Equal(ScreenDocument.NameAmbiguous, problem.Code);
            Assert.Contains("the module image NzLogo", problem.Message);
            Assert.Contains("{{ " + qualifier + ".NzLogo }}", problem.Message);
            Assert.DoesNotContain(outcome.Normalized, n => n["code"]!.ToString() == "IMG_PATH_IMAGE");
            Assert.Null(Img(top).Get("src"));
        }
        // No image of that name: the expression.
        var (_, expression) = Native("<img src=\"Client.NzLogo\"/>");
        var note = Assert.Single(expression.Normalized, n => n["code"]!.ToString() == "IMG_PATH_EXPRESSION");
        Assert.Equal("{{ Client.NzLogo }}", note["to"]?.ToString());
    }

    [Fact]
    public void ADottedSrcThroughAModuleRootIgnoresCaseAndCountsEveryRootOfTheLane()
    {
        // Every root of a value an O11 expression reads, in any case: two readings with an image of the last name.
        foreach (var src in new[] { "client.NzLogo", "CLIENT.NzLogo", "site.NzLogo", "Session.NzLogo", "Entities.NzKinds.NzLogo" })
        {
            var (_, outcome) = Native($"<img src=\"{src}\"/>", "NzLogo");
            Assert.Equal(ScreenDocument.NameAmbiguous, Assert.Single(outcome.Problems).Code);
            Assert.DoesNotContain(outcome.Normalized, n => n["code"]!.ToString() == "IMG_PATH_IMAGE");
        }
        // Images is the image reading; Settings is no root in O11.
        foreach (var src in new[] { "Images.NzLogo", "Settings.NzLogo" })
        {
            var (top, outcome) = Native($"<img src=\"{src}\"/>", "NzLogo");
            Assert.Empty(outcome.Problems);
            Assert.Contains(outcome.Normalized, n => n["code"]!.ToString() == "IMG_PATH_IMAGE");
            Assert.Equal("NzLogo", Img(top).Get("src"));
        }
    }

    // ---- TEXT_LITERAL_QUOTED (the module) -------------------------------------------------------------------------------------

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }

    private static string Job(JsonArray ops)
    {
        var dir = Path.Combine(Work, Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        return path;
    }

    private static ModelHost Host(string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        return new ModelHost(dir);
    }

    private static JsonObject Op(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    [Fact]
    public void ProseWhereAnExpressionThatShowsTextGoesIsItsLiteralInTheDocumentForm()
    {
        if (!StudioAvailable()) return;
        var html = "<screen name=\"NzProse\" roles=\"Registered\">\n<var name=\"NzQuery\" type=\"Text\"/>\n<input class=\"input\" bind=\"NzQuery\" placeholder=\"Pick cosy meadows\"/>\n</screen>";
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(Host("prose-document"), null, Job(new JsonArray(Op(html))), Path.Combine(Work, "prose-document", "out.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        // Written in the compile, listed, never a patch applied after a refusal.
        Assert.True(result["patchesApplied"] is not JsonArray { Count: > 0 }, result["patchesApplied"]?.ToJsonString());
        Assert.Contains("\"code\":\"TEXT_LITERAL_QUOTED\"", result.ToJsonString());
    }

    [Fact]
    public void ProseThatNamesSomethingInScopeKeepsItsRefusalInTheDocumentForm()
    {
        if (!StudioAvailable()) return;
        // Length is a built-in function: the text may be an expression meant, so the literal is a choice.
        var html = "<screen name=\"NzChoice\" roles=\"Registered\">\n<var name=\"NzQuery\" type=\"Text\"/>\n<input class=\"input\" bind=\"NzQuery\" placeholder=\"Length of meadows\"/>\n</screen>";
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(Host("prose-choice"), null, Job(new JsonArray(Op(html))), Path.Combine(Work, "prose-choice", "out.oml")));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().Where(p => p["severity"]?.ToString() != "warning").ToList();
        var problem = Assert.Single(problems);
        Assert.Equal("TEXT_LITERAL_CHOICE", problem["patchRule"]?.ToString());
        Assert.False(problem["patchCertain"]?.GetValue<bool>() ?? false);
    }

    private static (ModelHost Host, byte[] Bytes, JsonObject Read, string Edit) EditOf(string name, string placeholder)
    {
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"));
        var host = Host(name);
        var read = host.HtmlRead(bytes, null, withKeys: false)["documents"]!.AsArray().Select(d => d!.AsObject()).First(d => d["rootKind"]!.ToString() == "MobileScreen" && d["html"]!.ToString().Contains("<div k=", StringComparison.Ordinal));
        var tree = ScreenHtml.Parse(read["html"]!.ToString());
        var container = ScreenHtmlText.Elements(tree).Select(x => x.Node).First(n => n.Tag == "div" && n.Get("k") != null && n.Get("if") == null && n.Get("list") == null);
        var text = ScreenHtmlText.Write(container).TrimEnd('\n');
        var input = "<input placeholder=\"" + placeholder + "\"/>";
        var edit = text.EndsWith("/>", StringComparison.Ordinal) ? text[..^2] + ">" + input + "</div>" : text[..^"</div>".Length] + input + "</div>";
        return (host, bytes, read, edit);
    }

    [Fact]
    public void ProseWhereAnExpressionThatShowsTextGoesIsItsLiteralInTheEditForm()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, edit) = EditOf("prose-edit", "Pick cosy meadows");
        var answer = host.HtmlEdit(bytes, new JsonObject { ["screen"] = "@" + read["rootKey"], ["basedOn"] = new JsonObject { ["html"] = read["htmlSha256"]!.ToString() }, ["edit"] = new JsonArray(edit) });
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        var note = Assert.Single((answer["result"]?["normalized"] as JsonArray ?? []).OfType<JsonObject>(), n => n["code"]?.ToString() == "TEXT_LITERAL_QUOTED");
        Assert.Equal("Prompt", note["property"]!.ToString());
        Assert.Equal("\"Pick cosy meadows\"", note["to"]!.ToString());
    }

    [Fact]
    public void ProseThatNamesSomethingInScopeKeepsItsRefusalInTheEditFormWithBothReadings()
    {
        if (!StudioAvailable()) return;
        var (host, bytes, read, edit) = EditOf("prose-edit-choice", "Length of meadows");
        var answer = host.HtmlEdit(bytes, new JsonObject { ["screen"] = "@" + read["rootKey"], ["basedOn"] = new JsonObject { ["html"] = read["htmlSha256"]!.ToString() }, ["edit"] = new JsonArray(edit) });
        Assert.False(answer["accepted"]!.GetValue<bool>());
        var problem = Assert.Single(answer["problems"]!.AsArray().OfType<JsonObject>(), p => p["severity"]?.ToString() != "warning");
        Assert.StartsWith("placeholder=\"Length of meadows\" on a new Input is no expression", problem["message"]!.ToString());
        var candidates = problem["candidates"]!.AsArray().Select(c => c!.ToString()).ToList();
        Assert.Contains("\"Length of meadows\"", candidates);
        Assert.Contains("an expression that names Length", candidates);
    }
}
