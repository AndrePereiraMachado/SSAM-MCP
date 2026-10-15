using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The raw delete with consumers (contract of docs/INTEGRACOES-GITSSAM.md, lane restsoap): a REST method with a caller is
/// refused with DELETE_HAS_CONSUMERS naming the caller's path; deleting the caller earlier in the same job lets it go;
/// `breaks` equal to the consumers accepts them, a different list is CONSUMERS_CHANGED with nothing deleted. A deleted
/// SOAP method takes the client's structures no remaining method uses.
/// </summary>
public class DeleteBreaksTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static string? _withCaller;

    /// <summary>The module of tests/jobs/rest-consume-call.json: ViaCepApi.GetAddressByCep called by Cep_Lookup.</summary>
    private static string WithCaller()
    {
        if (_withCaller != null && File.Exists(_withCaller)) return _withCaller;
        var dir = Work();
        var output = Path.Combine(dir, "rest-consume-call.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), null, Path.Combine(Root, "tests", "jobs", "rest-consume-call.json"), output))!;
        Assert.True(result["accepted"]!.GetValue<bool>());
        return _withCaller = output;
    }

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "delete-breaks-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>Applies ops over a base module through the job runner: its results, or the refusal it threw.</summary>
    internal static (JsonNode? Result, Exception? Error, string Output) Run(string? basePath, JsonArray ops, bool expectValid = false)
    {
        var dir = Work();
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "tests/fixtures/blank-service.oml", ["expectValid"] = expectValid, ["ops"] = ops }.ToJsonString());
        var output = Path.Combine(dir, "out.oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "model")), basePath, job, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

    [Fact]
    public void AMethodWithACallerIsRefusedNamingIt()
    {
        if (!StudioAvailable()) return;
        var (_, error, output) = Run(WithCaller(), Ops("""[{"op":"delete","target":"IRestAction:GetAddressByCep"}]"""));
        var coded = Errors.FindCoded(error!)!;
        Assert.Equal("DELETE_HAS_CONSUMERS", coded.Code);
        Assert.NotEmpty(coded.Problems!);
        Assert.All(coded.Problems!, problem =>
        {
            Assert.Contains("ServerAction:Cep_Lookup/", problem!["pointer"]!.ToString());
            Assert.Contains("breaks", problem["fix"]!.ToString());
        });
        Assert.Contains("refused", Errors.Text(error!));
        Assert.False(File.Exists(output));
    }

    [Fact]
    public void DeletingTheCallerFirstInTheSameJobLetsTheMethodGo()
    {
        if (!StudioAvailable()) return;
        var (result, error, _) = Run(WithCaller(), Ops("""[{"op":"delete","target":"IServerAction:Cep_Lookup"},{"op":"delete","target":"IRestAction:GetAddressByCep"}]"""), expectValid: true);
        Assert.Null(error);
        Assert.Equal(0, result!["results"]![1]!["result"]!["brokenConsumers"]!.GetValue<int>());
    }

    [Fact]
    public void BreaksEqualToTheConsumersIsAcceptedAndADifferentListIsConsumersChanged()
    {
        if (!StudioAvailable()) return;
        var (_, refusal, _) = Run(WithCaller(), Ops("""[{"op":"delete","target":"IRestAction:GetAddressByCep"}]"""));
        var paths = Errors.FindCoded(refusal!)!.Problems!.Select(p => p!["pointer"]!.ToString()).ToList();
        var path = paths[0];
        var (_, changed, changedOutput) = Run(WithCaller(), Ops("""[{"op":"delete","target":"IRestAction:GetAddressByCep","breaks":["ServerAction:Someone/ExecuteServerAction:Else"]}]"""));
        Assert.Equal("CONSUMERS_CHANGED", Errors.FindCoded(changed!)!.Code);
        Assert.Contains(path, Errors.Text(changed!));
        Assert.False(File.Exists(changedOutput));
        var accepted = new JsonArray(new JsonObject { ["op"] = "delete", ["target"] = "IRestAction:GetAddressByCep", ["breaks"] = new JsonArray(paths.Select(p => (JsonNode)p).ToArray()) },
            new JsonObject { ["op"] = "find", ["type"] = "IRestAction" });
        var (result, error, _) = Run(WithCaller(), accepted);
        Assert.Null(error);
        var deleted = result!["results"]![0]!["result"]!;
        Assert.Equal(paths.Count, deleted["brokenConsumers"]!.GetValue<int>());
        Assert.Equal(paths.Order(), deleted["breaks"]!.AsArray().Select(b => b!.ToString()).Order());
        Assert.Empty(result["results"]![1]!["result"]!.AsArray());
        Assert.False(result["isValid"]!.GetValue<bool>()); // the broken caller is the error the job accepted to have
    }

    [Fact]
    public void ADeletedSoapMethodTakesTheStructuresNoRemainingMethodUses()
    {
        if (!StudioAvailable()) return;
        var (result, error, _) = Run(null, Ops("""
        [{"op":"create","parent":"@espace","type":"ISOAPClient","name":"Calculator","as":"$c","allowSoapWithoutImport":{"why":"the imported client as the importer leaves it, built by verbs for the test"}},
         {"op":"create","parent":"$c","type":"ISOAPStructure","name":"tOnlySubtract","as":"$s1"},
         {"op":"create","parent":"$s1","type":"ISOAPStructureAttribute","name":"A","as":"$s1a"},
         {"op":"set","target":"$s1a","prop":"DataType","value":"Integer"},
         {"op":"create","parent":"$c","type":"ISOAPStructure","name":"tShared","as":"$s2"},
         {"op":"create","parent":"$s2","type":"ISOAPStructureAttribute","name":"B","as":"$s2a"},
         {"op":"set","target":"$s2a","prop":"DataType","value":"Integer"},
         {"op":"create","parent":"$c","type":"ISOAPAction","name":"Subtract","as":"$m1"},
         {"op":"create","parent":"$m1","type":"ISOAPActionInput","name":"Operands","as":"$m1in"},
         {"op":"set","target":"$m1in","prop":"DataType","value":"tOnlySubtract"},
         {"op":"create","parent":"$m1","type":"ISOAPActionOutput","name":"Shared","as":"$m1out"},
         {"op":"set","target":"$m1out","prop":"DataType","value":"tShared"},
         {"op":"create","parent":"$c","type":"ISOAPAction","name":"Add","as":"$m2"},
         {"op":"create","parent":"$m2","type":"ISOAPActionOutput","name":"Shared","as":"$m2out"},
         {"op":"set","target":"$m2out","prop":"DataType","value":"tShared"},
         {"op":"delete","target":"$m1"},
         {"op":"find","type":"ISOAPStructure"}]
        """));
        Assert.Null(error);
        var rows = result!["results"]!.AsArray();
        var deleted = rows.Single(r => r!["op"]!.ToString() == "delete" && r["generated"] == null)!["result"]!;
        Assert.Equal(["tOnlySubtract"], deleted["removedStructures"]!.AsArray().Select(s => s!.ToString()));
        var left = rows.Single(r => r!["op"]!.ToString() == "find")!["result"]!.AsArray().Select(s => s!["name"]!.ToString());
        Assert.Equal(["tShared"], left);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
