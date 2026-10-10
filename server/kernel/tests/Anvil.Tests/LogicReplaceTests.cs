using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class LogicReplaceTests
{
    private static readonly string Root = FindRoot();
    private static JsonObject Spec() => JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", "logic-call-order.json")))!["ops"]![0]!["data"]!.DeepClone().AsObject();

    [Fact]
    public void CallsToSiblingsCompileInDependencyOrderEvenWithoutModelReferences()
    {
        var ops = LogicExpander.Expand(Spec(), _ => null);
        var actions = ops.Where(o => o["op"]!.ToString() == "create" && o["type"]?.ToString() == "IServerAction").Select(o => o["name"]!.ToString());
        Assert.Equal(new[] { "ReplaceTarget", "ReplaceCaller" }, actions);
    }

    [Fact]
    public void ReplacementFlagDoesNotChangeGeneratedOps()
    {
        var spec = Spec();
        var plain = JsonSerializer.Serialize(LogicExpander.Expand(spec));
        foreach (var action in spec["actions"]!.AsArray()) action!["replace"] = true;
        Assert.Equal(plain, JsonSerializer.Serialize(LogicExpander.Expand(spec)));
    }

    [Fact]
    public void RecursiveDeclarationsPrecedeTheirCalls()
    {
        var spec = JsonNode.Parse("""{"actions":[{"name":"A","steps":[{"call":"B","as":"RunB"}]},{"name":"B","steps":[{"call":"A","as":"RunA"}]}]}""")!.AsObject();
        var ops = LogicExpander.Expand(spec, _ => null);
        var declarations = ops.Select((op, ordinal) => (op, ordinal)).Where(pair => pair.op["type"]?.ToString() == "IServerAction").ToArray();
        Assert.Equal(new[] { "A", "B" }, declarations.Select(pair => pair.op["name"]!.ToString()));
        Assert.All(ops.Select((op, ordinal) => (op, ordinal)).Where(pair => pair.op["prop"]?.ToString() == "Action"),
            call => Assert.True(call.ordinal > declarations.Max(pair => pair.ordinal)));
    }

    [Fact]
    public void ClientCallsUseClientExecuteNodes()
    {
        var spec = JsonNode.Parse("""{"actions":[{"name":"A","kind":"client","steps":[{"call":"B","as":"RunB"}]},{"name":"B","kind":"client","steps":[]}]}""")!.AsObject();
        Assert.Contains(LogicExpander.Expand(spec, _ => null), o => o["type"]?.ToString() == "IExecuteClientActionNode");
    }

    [Fact]
    public void ReplacementPreservesConsumerKeysAndArgumentExpression()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "replace-tests", Guid.NewGuid().ToString("N"));
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null,
            Path.Combine(Root, "tests", "jobs", "logic-spec-replace.json"), Path.Combine(work, "replaced.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString() + result["policyMessages"]);
        var rows = result["results"]!.AsArray();
        var usages = rows.Where(r => r!["op"]!.ToString() == "usages").Select(r => r!["result"]!).ToArray();
        Assert.NotEmpty(usages[0]["entries"]!.AsArray());
        Assert.Equal(Keys(usages[0]), Keys(usages[1]));
        var dumps = rows.Where(r => r!["op"]!.ToString() == "dump").Select(r => r!["result"]!).ToArray();
        Assert.Equal(dumps[0]["key"]!.ToString(), dumps[1]["key"]!.ToString());
        Assert.Equal(Texts(dumps[0]), Texts(dumps[1]));
        var replacement = rows.Single(r => r!["op"]!.ToString() == "logic")!["result"]!;
        Assert.True(replacement["replaced"]!.GetValue<bool>());
        Assert.True(replacement["healedConsumers"]!.GetValue<int>() > 0);
    }

    [Fact]
    public void RawCreateAlsoRefusesDuplicateActionNames()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "replace-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "duplicate.json");
        File.WriteAllText(job, """{"base":"job:logic-call-order","ops":[{"op":"create","parent":"@espace","type":"IServerAction","name":"ReplaceTarget"}]}""");
        var output = Path.Combine(work, "duplicate.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(work), null, job, output));
        Assert.Contains("already exists", Errors.Text(error));
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void ReplacingBothActionsPreservesOnlyConsumersOutsideTheirBodies()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "replace-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var spec = Spec();
        spec["actions"]!.AsArray().Add(JsonNode.Parse("""{"name":"ReplaceFacade","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"call":"ReplaceCaller","as":"FacadeCall","args":{"N":"N"}},{"assign":{"Result":"FacadeCall.Result"}}]}"""));
        var seed = Path.Combine(work, "seed.json");
        File.WriteAllText(seed, new JsonObject { ["base"] = "blank-service.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = spec }) }.ToJsonString());
        var basePath = Path.Combine(work, "seed.oml");
        JobRunner.Run(host, null, seed, basePath);
        var replacements = Spec();
        foreach (var action in replacements["actions"]!.AsArray()) action!["replace"] = true;
        var job = Path.Combine(work, "both.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = replacements }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, Path.Combine(work, "both.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Equal(1, result["results"]![0]!["result"]!["healedConsumers"]!.GetValue<int>());
    }

    [Fact]
    public void ClientSiblingCallsVerifyOnReactiveFixture()
    {
        if (!StudioAvailable()) return;
        var work = Path.Combine(Root, ".local", "replace-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "client.json");
        var spec = Spec();
        foreach (var action in spec["actions"]!.AsArray()) action!["kind"] = "client";
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = spec }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "client.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
    }

    private static string[] Keys(JsonNode usage) => usage["entries"]!.AsArray().Select(e => e!["key"]!.ToString()).OrderBy(x => x).ToArray();
    private static string[] Texts(JsonNode node)
    {
        var list = new List<string>();
        void Walk(JsonNode n) { if (n["text"] != null) list.Add(n["text"]!.ToString()); foreach (var c in n["children"]?.AsArray() ?? new JsonArray()) Walk(c!); }
        Walk(node); return list.OrderBy(x => x).ToArray();
    }
    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(LogicReplaceTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
