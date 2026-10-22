using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public sealed class ScreenJavaScriptExceptionTests
{
    private const string Script = "action Admin.JS_Save\n  InvokeSave = javascript\n    | $actions.Save();\n  end\n";
    private static JsonObject Op() => JsonNode.Parse("""
        {"op":"logic","allowScreenJavaScript":{"module":"OfficePet","screen":"Admin","actions":["JS_Save"],"why":"User explicitly requested JS click routing"},"data":{"flow":""}}
        """)!.AsObject();

    [Fact]
    public void DefaultStillRefusesAndOnlyTheNamedScreenActionIsAllowed()
    {
        var action = ModuleFlow.Read(Script);
        var op = Op();
        Assert.NotNull(ScreenJavaScriptException.Allowed(op, action, "OfficePet"));
        Assert.Null(ScreenJavaScriptException.Allowed(op, action, "OtherModule"));
        Assert.Null(ScreenJavaScriptException.Allowed(null, action, "OfficePet"));
        Assert.Null(ScreenJavaScriptException.Allowed(op, ModuleFlow.Read(Script.Replace("Admin.", "Other.")), "OfficePet"));
        Assert.Null(ScreenJavaScriptException.Allowed(op, ModuleFlow.Read(Script.Replace("JS_Save", "JS_Delete")), "OfficePet"));
        Assert.Contains(FlowDiff.Compute(null, new Dictionary<string, string>(), action).Problems, p => p.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED");
        Assert.DoesNotContain(FlowDiff.Compute(null, new Dictionary<string, string>(), action, allowScreenJavaScript: true).Problems, p => p.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED");
        var server = ModuleFlow.Read(Script.Replace("action Admin.", "server action "));
        Assert.Null(ScreenJavaScriptException.Allowed(op, server, "OfficePet"));
        Assert.Contains(FlowDiff.Compute(null, new Dictionary<string, string>(), server, allowScreenJavaScript: true).Problems, p => p.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED");
    }

    [Theory]
    [InlineData("why", "short")]
    [InlineData("module", "")]
    [InlineData("screen", "")]
    public void IncompleteExceptionsAreRejected(string field, string value)
    {
        var op = Op();
        op["allowScreenJavaScript"]![field] = value;
        Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(op));
    }

    [Fact]
    public void WildcardActionScopeIsRejected()
    {
        var op = Op(); op["allowScreenJavaScript"]!["actions"] = new JsonArray("*");
        Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(op));
    }
}
