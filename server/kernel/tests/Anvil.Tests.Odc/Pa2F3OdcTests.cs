using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane F3 of the atritos 2 package on the ODC kernel (the same Kernel sources compiled against the ODC Studio): the logic
/// grammar names what the Studio names and reports every problem at once, the fragment compiles ButtonGroup by the native
/// route and refuses everything it refuses in one coded exception, and the theme CSS is expanded or refused. Pure.
/// </summary>
public sealed class Pa2F3OdcTests
{
    [Fact]
    public void ACallWithoutAsAndARepeatedNodeAreNamedAsTheStudioNamesThem()
    {
        var ops = LogicExpander.Expand(JsonNode.Parse("""
            {"actions":[{"name":"Helper","steps":[]},{"name":"Caller","outputs":[{"name":"X","type":"Integer"}],"steps":[
              {"call":"Helper"},{"call":"Helper"},{"assign":{"X":"1"},"as":"End"}]}]}
            """)!.AsObject());
        Assert.Equal(["Helper", "Helper2"], ops.Where(o => o["type"]?.ToString() == "IExecuteServerActionNode").Select(o => o["name"]!.ToString()));
        Assert.Contains(ops, o => o["type"]?.ToString() == "IEndNode" && o["name"]?.ToString() == "End2");
    }

    [Fact]
    public void TheSameScreenActionOnTwoScreensExpandsAndSortDoesNotThrow()
    {
        var spec = JsonNode.Parse("""
            {"actions":[
              {"name":"OnSave","kind":"screen","owner":"IMobileScreen:A","steps":[]},
              {"name":"OnSave","kind":"screen","owner":"IMobileScreen:B","steps":[]}]}
            """)!.AsObject();
        Assert.Equal(2, LogicOrder.Sort(spec["actions"]!.AsArray()).Count);
        Assert.Equal(2, LogicExpander.Expand(spec).Count(o => o["op"]?.ToString() == "create" && o["name"]?.ToString() == "OnSave"));
    }

    [Fact]
    public void ThreeInvalidStepsAreThreeCodedProblems()
    {
        var spec = JsonNode.Parse("""{"actions":[{"name":"A","steps":[{"get":"X"},{"call":5},{"if":"True","bogus":1}]}]}""")!.AsObject();
        var ex = Assert.Throws<KernelRefusalException>(() => LogicExpander.Expand(spec));
        Assert.Equal(["/actions/0/steps/0/as", "/actions/0/steps/1/call", "/actions/0/steps/2/bogus"], ex.Problems!.Select(p => p!["pointer"]!.ToString()));
    }

    [Fact]
    public void AButtonGroupIsTheNativeGroupItsItemsAndTheirCaptions()
    {
        var scope = new HtmlVisualScope(["Resposta"], HtmlVisualScope.Map(), HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null);
        var ops = HtmlVisual.Expand("<ButtonGroup bind=\"Resposta\"><ButtonGroupItem value=\"True\">Sim</ButtonGroupItem><ButtonGroupItem value=\"False\">Não</ButtonGroupItem></ButtonGroup>", "$scr", scope).Ops;
        var group = ops.Single(o => o["type"]?.ToString() == "IButtonGroup");
        Assert.True(group["empty"]!.GetValue<bool>());
        Assert.Contains(ops, o => o["target"]?.ToString() == group["as"]!.ToString() && o["prop"]?.ToString() == "Variable" && o["value"]?.ToString() == "Resposta");
        var items = ops.Where(o => o["type"]?.ToString() == "IButtonGroupItem").ToList();
        Assert.Equal(2, items.Count);
        Assert.All(items, i => Assert.Equal(group["as"]!.ToString(), i["parent"]!.ToString()));
        Assert.Equal(["True", "False"], items.Select(i => ops.Single(o => o["target"]?.ToString() == i["as"]!.ToString() && o["prop"]?.ToString() == "Value")["value"]!.ToString()));
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Value" && o["value"]?.ToString() == "\"Sim\"");
    }

    [Fact]
    public void EveryProblemOfAFragmentIsInOneCodedRefusal()
    {
        // <video> is a tag of the ODC HTML Element (the one table, ElementWidgetMap): a tag outside every list is what is refused
        var op = new JsonObject { ["op"] = "html", ["parent"] = "$scr", ["html"] = "<div><marquee></marquee><i icon=\"x\"></i><input bind=\"V\" type=\"color\"></div>" };
        var ex = Assert.Throws<KernelRefusalException>(() => HtmlVisual.PreflightOp(op));
        Assert.Equal(["HTML_TAG_NOT_ALLOWED", "HTML_INVALID", "INPUT_TYPE_MISMATCH"], ex.Problems!.Select(p => p!["code"]!.ToString()));
    }

    [Fact]
    public void LightDarkIsExpandedAndColorMixIsRefusedInARawStyleSheet()
    {
        var ops = JsonNode.Parse("""[{"op":"set","target":"IMobileTheme:App","prop":"StyleSheet","value":".a { color: light-dark(#000000, #ffffff); }"}]""")!.AsArray();
        var problem = Assert.Single(StyleSheetRules.Check(ops, "odc"));
        Assert.Contains("@media (prefers-color-scheme: dark)", problem["patch"]![0]!["value"]!.ToString());
        Assert.Equal("#800080", CssCompat.Rewrite(".a { color: color-mix(in srgb, #ff0000, #0000ff); }").Problems.Single().Substitute);
    }
}
