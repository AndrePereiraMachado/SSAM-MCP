using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class PerformanceContractTests
{
    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

    [Fact]
    public void PreflightReportsIndependentErrorsTogetherWithoutAStudio()
    {
        var result = JobPreflight.Analyze(Ops("""
        [{"op":"logic","data":{"actions":[
          {"name":"First","inputs":[{"name":"Unused","type":"Text"}],"steps":[{"bogus":"x"}]},
          {"name":"Second","steps":[{"call":"External","as":"Collision0"},{"call":"External","as":"Collision0"}]}
        ]}}]
        """));
        Assert.False(result["valid"]!.GetValue<bool>());
        Assert.Contains("bogus", result["errors"]!.ToJsonString());
        Assert.Single(result["errors"]!.AsArray());
        // C18 (atritos 3): an unused input is the Verify's warning (A03), a note of the compiler, never an error.
        Assert.Contains("LOGIC_UNUSED", result["warnings"]!.ToJsonString());
        // A07.2 (atritos 2): a repeated node name is never refused; the Studio-style suffix is a non-blocking warning.
        Assert.Contains("LOGIC_NODE_RENAMED", result["warnings"]!.ToJsonString());
        Assert.Contains("Collision0", result["warnings"]!.ToJsonString());
    }

    [Fact]
    public void RepeatedNamesAcrossLogicOpsAreRejectedButExplicitReplacementIsAllowed()
    {
        var ops = Ops("""[{"op":"logic","data":{"actions":[{"name":"A","steps":[]}]}},{"op":"logic","data":{"actions":[{"name":"A","steps":[]}]}}]""");
        Assert.False(JobPreflight.Analyze(ops)["valid"]!.GetValue<bool>());
        ops[1]!["data"]!["actions"]![0]!["replace"] = true;
        Assert.True(JobPreflight.Analyze(ops)["valid"]!.GetValue<bool>());
        ops[1]!["data"]!["actions"]![0]!.AsObject().Remove("replace");
        ops.Insert(1, new JsonObject { ["op"] = "delete", ["target"] = "IServerAction:A" });
        Assert.True(JobPreflight.Analyze(ops)["valid"]!.GetValue<bool>());
    }

    [Fact]
    public void AuditSeparatesIdenticalAlwaysRaisingEndpointsFromTypedHelpers()
    {
        var result = JobPreflight.Analyze(Ops("""
        [{"op":"logic","data":{"actions":[
          {"name":"Upload","public":true,"description":"upload","steps":[{"raise":"NotConfigured","message":"\"Configure provider\""}]},
          {"description":"confirm","steps":[{"message":"\"Configure provider\"","raise":"NotConfigured"}],"name":"Confirm","public":true},
          {"name":"Scope","outputs":[{"name":"X","type":"Integer"}],"steps":[{"assign":{"X":"1"}}]}
        ]}}]
        """));
        Assert.True(result["valid"]!.GetValue<bool>());
        Assert.Equal(2, result["alwaysRaises"]!.AsArray().Count);
        Assert.Equal(1, result["helpers"]!.GetValue<int>());
        Assert.Single(result["identicalImplementations"]!.AsArray());
        Assert.Contains("Upload", result["identicalImplementations"]!.ToJsonString());
        Assert.DoesNotContain("Scope", result["identicalImplementations"]!.ToJsonString());
    }

    [Fact]
    public void LogicLookupCachesEndBeforeARenameAndAnotherLogicOp()
    {
        if (!File.Exists(Path.Combine(StudioAssemblies.DefaultDirectory, "ServiceStudio.Framework.dll"))) return;
        var result = Run("lifetime", """
        {"base":"blank-service.oml","ops":[
          {"op":"spec","data":{"structures":[{"name":"Before","public":true,"attributes":[{"name":"Text","type":"Text"}]}]}},
          {"op":"logic","data":{"actions":[{"name":"One","public":true,"outputs":[{"name":"Result","type":"Before"}],"steps":[{"assign":{"Result.Text":"\"one\""}}]}]}},
          {"op":"rename","target":"IStructure:Before","name":"After"},
          {"op":"logic","data":{"actions":[{"name":"Two","public":true,"outputs":[{"name":"Result","type":"After"}],"steps":[{"assign":{"Result.Text":"\"two\""}}]}]}}
        ]}
        """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
    }

    [Theory]
    [InlineData("server", "IServerAction")]
    [InlineData("client", "IClientAction")]
    public void ExistingActionLookupSurvivesRenameReplacementAndAnotherCaller(string kind, string type)
    {
        var result = Run("action-lifetime", """
        {"base":"{{fixture}}","ops":[
          {"op":"logic","data":{"actions":[{"name":"Original","kind":"{{kind}}","public":true,"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"assign":{"Result":"1"}}]}]}},
          {"op":"logic","data":{"actions":[{"name":"First","kind":"{{kind}}","public":true,"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"call":"Original","as":"ReadValue"},{"assign":{"Result":"ReadValue.Result"}}]}]}},
          {"op":"rename","target":"{{type}}:Original","name":"Renamed"},
          {"op":"logic","data":{"actions":[{"name":"Renamed","kind":"{{kind}}","replace":true,"public":true,"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"assign":{"Result":"2"}}]}]}},
          {"op":"logic","data":{"actions":[{"name":"Second","kind":"{{kind}}","public":true,"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"call":"Renamed","as":"ReadValue"},{"assign":{"Result":"ReadValue.Result"}}]}]}},
          {"op":"usages","target":"{{type}}:Renamed"}
        ]}
        """.Replace("{{kind}}", kind).Replace("{{type}}", type)
            .Replace("{{fixture}}", kind == "client" ? "reactive-ui.oml" : "blank-service.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var usages = result["results"]!.AsArray().Last()!["result"]!.ToJsonString();
        Assert.Contains("First", usages);
        Assert.Contains("Second", usages);
    }

    [Fact]
    public void SqlCurrentHintShowsTheActualOutputWrapper()
    {
        if (!File.Exists(Path.Combine(StudioAssemblies.DefaultDirectory, "ServiceStudio.Framework.dll"))) return;
        var result = Run("sql-hint", """
        {"base":"blank-service.oml","expectValid":false,"ops":[
          {"op":"spec","data":{"entities":[{"name":"Item","attributes":[{"name":"Title","type":"Text"}]}]}},
          {"op":"logic","data":{"actions":[{"name":"Search","public":true,"outputs":[{"name":"Title","type":"Text"}],"steps":[
            {"get":"Item","as":"Rows","sql":true,"statement":"SELECT {Item}.* FROM {Item}","max":1},
            {"assign":{"Title":"Rows.List.Current.Title"}}
          ]}]}}
        ]}
        """);
        Assert.False(result["isValid"]!.GetValue<bool>());
        Assert.Contains(result["details"]!.AsArray().Select(x => x!.ToString()), s => s.Contains("Hint Current:") && s.Contains("SQL") && s.Contains("Current has: List"));
    }

    private static JsonNode Run(string name, string json)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PerformanceContractTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/lane-ss5/performance-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var path = Path.Combine(work, name + ".json"); File.WriteAllText(path, json);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, path, Path.Combine(work, name + ".oml")))!;
    }
}
