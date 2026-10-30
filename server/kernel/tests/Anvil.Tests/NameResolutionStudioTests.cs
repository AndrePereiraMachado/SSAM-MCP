using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using OutSystems.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// R2-A, the correction round (review of 990dce2c): the one rule of names through a real O11 job (JobRunner, the Studio's model,
/// reactive-ui.oml: the screen Login, the server action GetGoogleMapsServerKey of the reference OutSystemsMaps). The apply decides
/// a call with the candidates the preflight counts (the actions the job creates included), writes the canonical form of a name
/// in another case and of Producer.Action in the JSON form, and refuses a client action as an event's destination before the
/// set, with its wrapping. Needs the Service Studio.
/// </summary>
public sealed class NameResolutionStudioTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NameResolutionStudioTests).Assembly.Location)!)!;
    private const string Producer = "OutSystemsMaps", Action = "GetGoogleMapsServerKey";

    private static JsonObject Flow(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } };
    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private (JsonObject Result, string Oml) Run(string tag, params JsonNode[] ops)
    {
        var dir = Path.Combine(Root, ".local", "name-resolution-studio", tag + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(ops.Select(o => o.DeepClone()).ToArray()) }.ToJsonString());
        var oml = Path.Combine(dir, "out.oml");
        JsonObject result;
        try { result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, oml))!.AsObject(); }
        catch (Exception error)
        {
            var coded = Errors.FindCoded(error);
            result = new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["text"] = Errors.Text(error), ["problems"] = coded?.Problems?.DeepClone() };
        }
        var text = result.ToJsonString();
        output.WriteLine(tag + ": " + text[..Math.Min(3000, text.Length)]);
        return (result, oml);
    }

    private static bool Accepted(JsonObject result) => result["accepted"] is JsonValue v && v.TryGetValue<bool>(out var ok) ? ok : result["accepted"] == null && result["code"] == null;

    // What the Execute nodes of the action `caller` call in a saved module: node kind, target kind, its parent and its name.
    private static List<string> Bound(string oml, string caller)
    {
        var found = new List<string>();
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(oml)!, "read"));
        var espace = host.Load(File.ReadAllBytes(oml));
        try
        {
            var reader = new KernelModelReader();
            var action = reader.Walk((IObjectSignature)espace).FirstOrDefault(n => reader.DisplayOf(n) == caller && reader.KindOf(n).EndsWith("Action", StringComparison.Ordinal));
            if (action == null) return ["no action " + caller];
            foreach (var node in reader.Walk(action).Where(n => reader.KindOf(n).Contains("Execute", StringComparison.Ordinal)))
            {
                if (node.GetType().GetProperty("Action")?.GetValue(node) is not IObjectSignature target) { found.Add(reader.KindOf(node) + " -> null"); continue; }
                var parent = reader.ParentOf(target);
                found.Add(reader.KindOf(node) + " -> " + reader.KindOf(target) + " " + (parent == null ? "" : reader.DisplayOf(parent) + ".") + reader.DisplayOf(target));
            }
        }
        finally { ModelHost.Release(espace); }
        return found;
    }

    private static bool Canonical(JsonObject result) => result.ToJsonString().Contains("REFERENCE_CANONICAL", StringComparison.Ordinal);

    // Item 1 (the blocker of the review): a screen action the same op creates, named like an action of a producer, is what a call
    // of that name from its screen binds: the apply counts the actions the job declares, as the preflight does.
    [Fact]
    public void ACallOfAScreenActionTheSameOpCreatesBindsItNeverTheProducersActionOfItsName()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, oml) = Run("same-op", Flow($"/// Login's own {Action}.\naction Login.{Action}\n  end\n", $"/// Calls it.\naction Login.ReviewCaller\n  {Action}()\n  end\n"));
        Assert.True(Accepted(result), result.ToJsonString());
        Assert.False(Canonical(result), result.ToJsonString());
        Assert.Equal(new[] { "ExecuteClientActionNode -> ScreenAction Login." + Action }, Bound(oml, "ReviewCaller"));
    }

    // The same with the screen action made by an op of the JSON form after a text op that gathered the callees of the module.
    [Fact]
    public void ACallOfAScreenActionAnEarlierJsonOpCreatesBindsItAfterATextOpReadTheCallees()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var first = Flow("/// Helper.\nserver action ReviewHelper\n  out Done: Boolean\n  assign Done = True\n  end\n", "/// First.\nserver action ReviewFirst\n  ReviewHelper()\n  end\n");
        var json = JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"ACTION","kind":"screen","owner":"IMobileScreen:Login","steps":[]}]}}""".Replace("ACTION", Action))!;
        var (result, oml) = Run("json-then-text", first, json, Flow($"/// Calls it.\naction Login.ReviewCaller\n  {Action}()\n  end\n"));
        Assert.True(Accepted(result), result.ToJsonString());
        Assert.False(Canonical(result), result.ToJsonString());
        Assert.Equal(new[] { "ExecuteClientActionNode -> ScreenAction Login." + Action }, Bound(oml, "ReviewCaller"));
    }

    // Item 5: a producer's action written in another case is written as the element is named, and listed.
    [Fact]
    public void AProducersActionWrittenInAnotherCaseIsBoundAndListed()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, oml) = Run("case", Flow($"/// Calls it in lower case.\nserver action ReviewCaller\n  {Action.ToLowerInvariant()}()\n  end\n"));
        Assert.True(Accepted(result), result.ToJsonString());
        Assert.True(Canonical(result), result.ToJsonString());
        Assert.Equal(new[] { $"ExecuteServerActionNode -> ServerActionSignature {Producer}.{Action}" }, Bound(oml, "ReviewCaller"));
    }

    // Item 6: Producer.Action is a call of the JSON form (the reference's own signature).
    [Fact]
    public void TheJsonFormCallsProducerActionByItsReference()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var json = JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"ReviewJson","kind":"server","steps":[{"call":"CALL"}]}]}}""".Replace("CALL", Producer + "." + Action))!;
        var (result, oml) = Run("json-qualified", json);
        Assert.True(Accepted(result), result.ToJsonString());
        Assert.Equal(new[] { $"ExecuteServerActionNode -> ServerActionSignature {Producer}.{Action}" }, Bound(oml, "ReviewJson"));
    }

    // Item 7: a client action is no event's destination: the document form refuses it before the set (the platform refused it
    // at the set: "A OutSystems.Model.Logic.IClientAction cannot be used as the value for the ...Destination property"), with the
    // wrapping of a screen action that calls it.
    [Fact]
    public void ADocumentEventNamingAClientActionIsRefusedBeforeTheSetWithItsWrapping()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, _) = Run("client-destination", Flow("/// Goes.\nclient action ReviewGo\n  out Value: Integer\n  assign Value = 1\n  end\n"),
            Html("<screen name=\"ReviewDest\" roles=\"Registered\">\n<a onclick=\"ReviewGo\">Go</a>\n</screen>"));
        Assert.False(Accepted(result), result.ToJsonString());
        var problems = (result["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.DoesNotContain(problems, p => p["code"]?.ToString() == "HTML_INVALID");
        var refused = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_NAME_UNKNOWN");
        Assert.Contains("is the ClientAction ReviewGo, which an event cannot run", refused["message"]!.ToString());
        Assert.Equal("action ReviewDest.ReviewGoClick\n  ReviewGo()\n  end\n", refused["wrap"]!["logic"]!.ToString());
        Assert.Equal("ReviewGoClick", refused["wrap"]!["value"]!.ToString());
    }
}
