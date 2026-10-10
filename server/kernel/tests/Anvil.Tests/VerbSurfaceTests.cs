using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The integration ops in the executed verb contract: `rest`, `rest-expose` and `soap` are verbs of the table pinned to
/// handlers of the dispatcher, the raw `delete` takes `breaks`, and `api --op rest|rest-expose|soap` project their
/// contracts (closed keys, codes, rules). The logic language knows the action kind `rest`.
/// </summary>
public class VerbSurfaceTests
{
    [Fact]
    public void TheIntegrationOpsArePinnedToTheDispatcher()
    {
        foreach (var verb in new[] { "rest", "rest-expose", "soap" })
        {
            var shape = VerbSurface.Verbs.Single(v => v.Verb == verb);
            Assert.Equal("write", shape.Kind);
            Assert.Equal(["data"], shape.Required);
            Assert.Empty(shape.Optional);
            VerbSurface.Check(JsonNode.Parse($"{{\"op\":\"{verb}\",\"data\":{{}}}}")!.AsObject());
            Assert.Contains("unknown key(s) 'client'", Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse($"{{\"op\":\"{verb}\",\"data\":{{}},\"client\":{{}}}}")!.AsObject())).Message);
        }
        if (!File.Exists(Path.Combine(StudioAssemblies.DefaultDirectory, "ServiceStudio.Framework.dll"))) return;
        StudioAssemblies.Bind(null);
        var handlers = typeof(ModelSession).GetMethods(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            .Where(m => m.ReturnType == typeof(JsonNode) && m.GetParameters() is [{ ParameterType: var t }] && t == typeof(JsonObject)).Select(m => m.Name).ToHashSet();
        foreach (var handler in new[] { "Rest", "RestExpose", "Soap" }) Assert.Contains(handler, handlers);
    }

    [Fact]
    public void DeleteAcceptsBreaks()
    {
        var delete = VerbSurface.Verbs.Single(v => v.Verb == "delete");
        Assert.Contains("breaks", delete.Optional);
        Assert.Contains("DELETE_HAS_CONSUMERS", delete.Effect);
        Assert.Contains("CONSUMERS_CHANGED", delete.Effect);
        VerbSurface.Check(JsonNode.Parse("{\"op\":\"delete\",\"target\":\"IRestAction:Get\",\"breaks\":[\"ServerAction:X/ExecuteServerAction:Get\"]}")!.AsObject());
    }

    [Fact]
    public void ApiOpProjectsTheIntegrationContracts()
    {
        foreach (var op in new[] { "rest", "rest-expose", "soap" }) Assert.Contains(op, CommandSurface.OperationNames);
        var rest = CommandSurface.Schema("rest");
        Assert.Equal(RestExpander.RootKeys, rest["data"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("baseUrl", rest["shapes"]!["client"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("REST_CREDENTIALS_NOT_IN_MODEL", rest["codes"]!.AsArray().Select(k => k!.ToString()));
        var expose = CommandSurface.Schema("rest-expose");
        Assert.Contains("action", expose["shapes"]!["method"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("REST_EXPOSE_AUTH_FLOW_UNSUPPORTED", expose["codes"]!.AsArray().Select(k => k!.ToString()));
        var soap = CommandSurface.Schema("soap");
        Assert.Equal(["o11"], soap["lanes"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("wsdl", soap["data"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("SOAP_CONTRACT_TYPE_MISMATCH", soap["codes"]!.AsArray().Select(k => k!.ToString()));
        var logic = CommandSurface.Schema("logic");
        Assert.Contains("rest", logic["actionKinds"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("http", logic["action"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("in", logic["parameter"]!.AsArray().Select(k => k!.ToString()));
    }

    [Fact]
    public void TheLogicKindRestKeepsItsKeysToItself()
    {
        var server = JsonNode.Parse("""{"actions":[{"name":"A","http":"GET","steps":[]}]}""")!.AsObject();
        Assert.Contains("http/path", Assert.ThrowsAny<Exception>(() => LogicExpander.Expand(server, _ => null)).Message);
        var parameter = JsonNode.Parse("""{"actions":[{"name":"A","inputs":[{"name":"X","type":"Text","in":"url"}],"steps":[{"assign":{"Y":"X"}}],"vars":[{"name":"Y","type":"Text"}]}]}""")!.AsObject();
        Assert.Contains("'in' exists only", Assert.ThrowsAny<Exception>(() => LogicExpander.Expand(parameter, _ => null)).Message);
        var unowned = JsonNode.Parse("""{"actions":[{"name":"A","kind":"rest","steps":[]}]}""")!.AsObject();
        Assert.Contains("IRestService:<Service>", Assert.ThrowsAny<Exception>(() => LogicExpander.Expand(unowned, _ => null)).Message);
    }
}
