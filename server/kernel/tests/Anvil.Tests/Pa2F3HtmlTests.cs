using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F3 of the atritos 2 package, A11 and the ButtonGroup of the owner's notes: the HTML translator compiles what the
/// platform accepts (a label around elements, an icon-only button, a line break, the input type of the bound variable, a
/// fragment on a screen lands in its content, a template screen's lifecycle is cleared in the same op, ButtonGroup by the
/// native route) and refuses only what the platform refuses, every problem of a fragment in one coded refusal (I4).
/// The pure tests need no Studio; the two model tests run the ops through JobRunner and the Verify over the Reactive fixture.
/// </summary>
public sealed class Pa2F3HtmlTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F3HtmlTests).Assembly.Location)!)!;

    private static HtmlVisualScope Scope() => new(
        ["Telefone", "Aceite", "Choice", "Quantity", "Perfil", "PinNumber"],
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["RetrySearch"] = "@retry", ["Chosen"] = "@chosen" },
        HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null,
        InputTypes: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Quantity"] = "Number" },
        BindTypes: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Telefone"] = "Text", ["Aceite"] = "Boolean", ["Choice"] = "Text", ["Quantity"] = "Integer", ["Perfil.Telefone"] = "Text", ["PinNumber"] = "Text",
        });

    private static HtmlVisualFragment Fragment(string html, string parent = "$screen") => HtmlVisual.Expand(html, parent, Scope());
    private static List<JsonObject> Ops(string html) => Fragment(html).Ops;
    private static bool Is(JsonObject o, string type, string? name = null) => o["op"]?.ToString() == "create" && o["type"]?.ToString() == type && (name == null || o["name"]?.ToString() == name);
    private static bool Sets(JsonObject o, string prop, string value) => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == prop && o["value"]?.ToString() == value;

    // ---- the label, the icon-only button, the line break ---------------------------------------------------------------

    [Fact]
    public void ALabelAroundElementsIsAnHtmlElementLabelWithThem()
    {
        // The Cardapio BackOffice was refused "<label> takes text, not child elements" twice (2026-10-06 13:32). H6 of
        // docs/PROTOTIPO-NATIVO.md (the one element-to-widget table): the label stays a label (tag label is in the list of both
        // platforms), its text and its elements are its content in the order written, its class and its for its attributes.
        var ops = Ops("<div><label for=\"Tel\" class=\"field\">Telefone <span class=\"req\">*</span></label><input id=\"Tel\" bind=\"Telefone\"></div>");
        var label = ops.Single(o => Is(o, "IAdvancedHtml", "Label1"));
        var alias = label["as"]!.ToString();
        Assert.Contains(ops, o => o["target"]?.ToString() == alias && Sets(o, "Tag", "label"));
        Assert.DoesNotContain(ops, o => Is(o, "ILabel"));
        Assert.Contains(ops, o => Is(o, "ITextWidget") && o["parent"]?.ToString() == alias + "/Content");
        Assert.Contains(ops, o => Sets(o, "Text", "Telefone "));
        Assert.Contains(ops, o => Is(o, "IAdvancedHtml", "Span1") && o["parent"]?.ToString() == alias + "/Content");
        Assert.Contains(ops, o => Sets(o, "Property", "class")); Assert.Contains(ops, o => Sets(o, "Value", "\"field\""));
        Assert.Contains(ops, o => Sets(o, "Property", "for")); Assert.Contains(ops, o => Sets(o, "Value", "\"Tel\""));
        Assert.Single(ops, o => Is(o, "IInput", "Tel"));
    }

    [Fact]
    public void AnIconOnlyButtonIsAllowedAndAnEmptyOneIsNot()
    {
        // "a <button> needs visible text" (Cardapio UI 13:41): the platform accepts a button with only an icon.
        var ops = Ops("<button id=\"Fav\" onclick=\"Chosen\"><i icon=\"star\" weight=\"regular\"></i></button>");
        var button = ops.Single(o => Is(o, "IButton", "Fav"))["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == button + "/#ITextWidget");
        Assert.Contains(ops, o => Is(o, "IIcon") && o["parent"]?.ToString() == button);
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Text");
        Assert.Contains("needs text", Assert.Throws<InvalidOperationException>(() => Ops("<button onclick=\"Chosen\"></button>")).Message);
    }

    // ---- input type ------------------------------------------------------------------------------------------------------

    [Fact]
    public void TheBoundTypeWinsOverTheAuthoredTypeAndTheChangeIsReported()
    {
        // "Input type is a Phone but it should be Text to match Telefone" / "... Perfil.Telefone" (Cardapio BackOffice 13:41).
        var fragment = Fragment("<div><input id=\"Tel\" bind=\"Telefone\" type=\"tel\"><input bind=\"Perfil.Telefone\" type=\"tel\"><input bind=\"PinNumber\" type=\"password\"></div>");
        Assert.Equal(2, fragment.Ops.Count(o => Sets(o, "InputType", "Text")));
        Assert.Contains(fragment.Ops, o => Sets(o, "InputType", "Password"));
        Assert.DoesNotContain(fragment.Ops, o => Sets(o, "InputType", "Phone"));
        var changes = fragment.Report["inputTypes"]!.AsArray();
        Assert.Equal(2, changes.Count);
        Assert.Equal("Phone", changes[0]!["authored"]!.ToString());
        Assert.Equal("Text", changes[0]!["inputType"]!.ToString());
    }

    [Fact]
    public void AnInputOverABooleanIsAMismatchWithTheCheckboxAsTheFix()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Ops("<input bind=\"Aceite\" type=\"text\">"));
        var problem = Errors.FindCoded(ex)!.Problems![0]!;
        Assert.Equal("INPUT_TYPE_MISMATCH", problem["code"]!.ToString());
        Assert.Contains("type=\"checkbox\"", problem["fix"]!.ToString());
    }

    // ---- every problem of a fragment at once ------------------------------------------------------------------------------

    [Fact]
    public void AllTheProblemsOfAFragmentAreOneCodedRefusalWithPointersRelativeToTheOp()
    {
        var op = new JsonObject
        {
            ["op"] = "html", ["parent"] = "$screen",
            ["html"] = "<style>.pa2 { color: color-mix(in srgb, #ff0000 50%, #0000ff); }</style>"
                // a static table compiles now (H9, the one table): a tag outside every list is what is refused
                + "<div class=\"pa2\"><marquee>x</marquee><i icon=\"star\"></i><input bind=\"X\" type=\"color\">"
                + "<div list=\"Items\"><span>x</span></div><label for=\"Ghost\">Ghost</label><div else></div></div>",
        };
        var ex = Assert.Throws<KernelRefusalException>(() => HtmlVisual.PreflightOp(op));
        Assert.Equal("HTML_INVALID", ex.Code);
        var problems = ex.Problems!.Select(p => p!.AsObject()).ToList();
        Assert.True(problems.Count >= 7, string.Join("\n", problems.Select(p => p.ToJsonString())));
        Assert.All(problems, p => Assert.Equal("/html", p["pointer"]!.ToString()));
        var codes = problems.Select(p => p["code"]!.ToString()).ToHashSet();
        Assert.Contains("HTML_TAG_NOT_ALLOWED", codes);
        Assert.Contains("INPUT_TYPE_MISMATCH", codes);
        Assert.Contains("CSS_FUNCTION_UNSUPPORTED", codes);
        var cssFix = problems.Single(p => p["code"]!.ToString() == "CSS_FUNCTION_UNSUPPORTED")["fix"]!.ToString();
        Assert.Contains("#800080", cssFix);
        foreach (var expected in new[] { "needs weight=", "needs as=", "does not name a widget of this fragment", "must immediately follow" })
            Assert.Contains(problems, p => p["message"]!.ToString().Contains(expected, StringComparison.Ordinal));
    }

    // ---- ButtonGroup -----------------------------------------------------------------------------------------------------

    [Fact]
    public void AButtonGroupCompilesToTheOpsOfTheNativeRoute()
    {
        // The FloodQuotes Options screen fell back to native create for its Yes/No ButtonGroup (owner's notes, 2026-10-06).
        var job = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", "widgets-reactive.json")))!["ops"]!.AsArray().Select(o => o!.AsObject()).ToList();
        var first = job.FindIndex(o => o["type"]?.ToString() == "IButtonGroup");
        var native = job.Skip(first).TakeWhile(o => o["op"]?.ToString() is "create" or "set").ToList();
        var fragment = HtmlVisual.Expand(
            "<ButtonGroup id=\"ChoiceGroup\" bind=\"Choice\"><ButtonGroupItem id=\"ChoiceA\" value='\"A\"'>Option A</ButtonGroupItem>"
            + "<ButtonGroupItem id=\"ChoiceB\" value='\"B\"'>Option B</ButtonGroupItem></ButtonGroup>", "$box", Scope()).Ops;
        Assert.Equal(Canonical(native), Canonical(fragment));
    }

    /// <summary>The ops with their aliases numbered in order of appearance, so two routes compare by shape and values.</summary>
    private static string Canonical(IEnumerable<JsonObject> ops)
    {
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        string Map(string? reference)
        {
            if (reference == null) return "";
            var at = reference.IndexOf('/');
            var head = at < 0 ? reference : reference[..at];
            if (!head.StartsWith('$')) return reference;
            if (!aliases.TryGetValue(head, out var mapped)) aliases[head] = mapped = "$" + aliases.Count;
            return mapped + (at < 0 ? "" : reference[at..]);
        }
        return string.Join("\n", ops.Select(o => string.Join("|", o["op"], o["type"], o["name"], Map(o["parent"]?.ToString()), Map(o["target"]?.ToString()), Map(o["as"]?.ToString()),
            o["prop"], o["value"]?.ToJsonString(), o["empty"]?.ToJsonString())));
    }

    // ---- model proofs: the ops pass the Verify ---------------------------------------------------------------------------

    [Fact]
    public void AFragmentOnAScreenLandsInItsContentAndEveryNewFormPassesTheVerify()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "pa2-f3-html"); Directory.CreateDirectory(work);
        var html = "<div class=\"pa2-box\"><label for=\"Tel\">Telefone <span class=\"req\">*</span></label>"
            + "<input id=\"Tel\" bind=\"Telefone\" type=\"tel\"><button id=\"Fav\" onclick=\"RetrySearch\"><i icon=\"star\" weight=\"regular\"></i></button>"
            + "<button id=\"Named\" onclick=\"RetrySearch\">{{ Telefone }}</button><p>a<br>b</p>"
            + "<ButtonGroup id=\"Choices\" bind=\"Choice\"><ButtonGroupItem value='\"A\"'>A</ButtonGroupItem><ButtonGroupItem value='\"B\"'>B</ButtonGroupItem></ButtonGroup>"
            + "<style>.pa2-box { color: light-dark(#111111, #eeeeee); }</style></div>";
        var ops = new JsonArray(
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa2Fragment","as":"$scr"}"""),
            Op("""{"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutBlank","empty":true}"""),
            Op("""{"op":"create","parent":"$scr","type":"ILocalVariable","name":"Telefone","as":"$v1"}"""),
            Op("""{"op":"set","target":"$v1","prop":"DataType","value":"Text"}"""),
            Op("""{"op":"create","parent":"$scr","type":"ILocalVariable","name":"Choice","as":"$v2"}"""),
            Op("""{"op":"set","target":"$v2","prop":"DataType","value":"Text"}"""),
            Op("""{"op":"create","parent":"$scr","type":"IScreenAction","name":"RetrySearch","as":"$act"}"""),
            Op("""{"op":"create","parent":"$act","type":"IStartNode","as":"$a0"}"""),
            Op("""{"op":"create","parent":"$act","type":"IEndNode","as":"$a9"}"""),
            Op("""{"op":"link","from":"$a0","to":"$a9"}"""),
            new JsonObject { ["op"] = "html", ["parent"] = "$scr", ["html"] = html },
            Op("""{"op":"dump","target":"IMobileScreen:Pa2Fragment/#IMobileBlockInstanceWidget/Content","depth":2}"""));
        var result = Run(work, "fragment", ops);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var report = result["results"]!.AsArray()[10]!["result"]!.AsObject();
        Assert.Equal("$scr/#IMobileBlockInstanceWidget/Content", report["parent"]!.ToString());
        Assert.Equal("$scr", report["parentAuthored"]!.ToString());
        Assert.Equal(1, report["css"]!["lightDarkExpanded"]!.GetValue<int>());
        var content = result["results"]!.AsArray()[11]!["result"]!.AsObject();
        Assert.Contains(content["children"]!.AsArray(), c => c!["type"]?.ToString() == "IContainer");
    }

    [Fact]
    public void ATemplateScreensLifecycleHandlerIsClearedInTheSameOpAndNamedInTheReport()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "pa2-f3-html"); Directory.CreateDirectory(work);
        var page = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Pa2Life", ["layout"] = "blank", ["html"] = "<div><p>Antes</p></div>" } };
        var again = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Pa2Life", ["layout"] = "blank", ["html"] = "<div><p>Depois</p></div>" } };
        var ops = new JsonArray(
            page,
            Op("""{"op":"create","parent":"IMobileScreen:Pa2Life","type":"IScreenAction","name":"Init","as":"$init"}"""),
            Op("""{"op":"create","parent":"$init","type":"IStartNode","as":"$i0"}"""),
            Op("""{"op":"create","parent":"$init","type":"IEndNode","as":"$i9"}"""),
            Op("""{"op":"link","from":"$i0","to":"$i9"}"""),
            Op("""{"op":"set","target":"IMobileScreen:Pa2Life/OnInitialize","prop":"Destination","value":"$init"}"""),
            again);
        var result = Run(work, "lifecycle", ops);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var cleared = result["results"]!.AsArray()[6]!["result"]!["delta"]!["removed"]!["lifecycle"]!.AsArray().Single()!;
        Assert.Equal("OnInitialize", cleared["event"]!.ToString());
        Assert.Equal("Init", cleared["handler"]!.ToString());
        Assert.True(cleared["cleared"]!.GetValue<bool>());
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
