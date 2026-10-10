using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class ScreenCoverageTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenCoverageTests).Assembly.Location)!)!;
    public static IEnumerable<object[]> Cases() => Directory.GetFiles(Path.Combine(Root, "tests", "contracts", "screen-coverage"), "*.json").Order().Select(path => new object[] { Path.GetFileNameWithoutExtension(path), Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)))[..12] });
    [Theory]
    [InlineData("ieditrecordwidget")]
    [InlineData("ishowrecordwidget")]
    public void LegacyRecordRowsCannotLoseTheirValueCell(string type)
    {
        var test=JsonNode.Parse(File.ReadAllText(Path.Combine(Root,"tests/contracts/screen-coverage/traditional-ui-"+type+".json")))!;
        var contract=test["contract"]!.AsObject();
        contract["screens"]![0]!["widgets"]![0]!["children"]![0]!["children"]!.AsArray().RemoveAt(1);
        Assert.Contains("caption and value",Assert.Throws<ArgumentException>(()=>ModuleSpecification.Validate(contract)).Message);
    }
    [Theory]
    [MemberData(nameof(Cases))]
    public void EveryMatrixRowHasNativeVerifyReloadMergeAndIndependentProof(string name, string caseKey)
    {
        var test = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "contracts", "screen-coverage", name + ".json")))!.AsObject();
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local", "screen-coverage", name); Directory.CreateDirectory(work);
        File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject { ["case"] = name, ["caseKey"] = caseKey, ["status"] = "running" }.ToJsonString());
        var host = new ModelHost(work); var fixture = Path.Combine(Root, "tests", "fixtures", test["fixture"]!.ToString() + ".oml");
        var contract = test["contract"]!.AsObject(); ModuleSpecification.Validate(contract);
        if (test["setup"] is JsonArray setup)
        {
            var seedJob = Path.Combine(work, "setup.json"); var seedOutput = Path.Combine(work, "base.oml");
            File.WriteAllText(seedJob, new JsonObject { ["ops"] = setup.DeepClone() }.ToJsonString());
            // A fixture may contain deliberately unconnected event bindings until the contract creates their actions.
            JobRunner.Run(host, fixture, seedJob, seedOutput); fixture = seedOutput;
        }
        var plan = host.PlanModuleSpecification(fixture, contract);
        var output = Path.Combine(work, "output.oml"); var job = Path.Combine(work, "case.json");
        if (test["bindings"] is JsonArray bindings) foreach (var binding in bindings) plan.Add(binding!.DeepClone());
        File.WriteAllText(job, new JsonObject { ["ops"] = plan, ["expectedMessages"] = test["expectedMessages"]?.DeepClone() ?? new JsonArray() }.ToJsonString());
        JsonObject result;
        try { result = JsonSerializer.SerializeToNode(JobRunner.Run(host, fixture, job, output))!.AsObject(); }
        catch (Exception ex)
        {
            File.WriteAllText(Path.Combine(work, "failure.txt"), ex.ToString());
            if (test["unsupported"] != null) { Assert.Contains(test["unsupported"]!.ToString(), ex.Message, StringComparison.OrdinalIgnoreCase); RejectedContext(ex.Message); return; }
            throw;
        }
        File.WriteAllText(Path.Combine(work, "apply.json"), result.ToJsonString());
        if (test["unsupported"] != null)
        {
            Assert.False(result["accepted"]!.GetValue<bool>()); Assert.Contains(test["unsupported"]!.ToString(), result.ToJsonString(), StringComparison.OrdinalIgnoreCase); RejectedContext(result["details"]!.ToJsonString()); return;
        }
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"] + " " + result["validation"]);
        var proof = host.CheckModuleSpecification(output, contract);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(fixture), File.ReadAllBytes(output), merged);
        Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge)); Assert.False(merge.HasConflicts, JsonSerializer.Serialize(merge));
        var after = host.CheckModuleSpecification(merged, contract, proof["expectedTypes"]!.AsObject());
        File.WriteAllText(Path.Combine(work, "after-merge-proof.json"), after.ToJsonString());
        Assert.True(after["accepted"]!.GetValue<bool>(), after["differences"]!.ToJsonString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged, contract), op => op?["op"]?.ToString() is "logic" or "screen");
        var negative = false;
        var mutations = test["mutations"] as JsonArray ?? (test["mutation"] is JsonObject singleMutation ? new JsonArray(singleMutation.DeepClone()) : new JsonArray());
        if (mutations.Count > 0)
        {
            var badJob = Path.Combine(work, "mutation.json"); var badOutput = Path.Combine(work, "mutated.oml");
            var mutationOps = new JsonArray();
            foreach (var mutation in mutations.OfType<JsonObject>())
            {
                var operation = mutation.DeepClone().AsObject(); operation["op"] ??= "set"; operation.Remove("element"); mutationOps.Add(operation);
            }
            File.WriteAllText(badJob, new JsonObject { ["ops"] = mutationOps }.ToJsonString());
            var badResult = JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, badJob, badOutput))!;
            Assert.True(badResult["accepted"]!.GetValue<bool>(), "Mutation must remain Verify-valid: " + badResult["details"]);
            var badProof = host.CheckModuleSpecification(badOutput, contract, proof["expectedTypes"]!.AsObject());
            Assert.False(badProof["accepted"]!.GetValue<bool>(), "Verifier accepted changed behavior: " + name);
            foreach (var mutation in mutations.OfType<JsonObject>())
            {
                var owner = mutation["target"]!.ToString().Split(':', 2)[1].Split('/')[0];
                Assert.Contains(badProof["differences"]!.AsArray(), d => d?["element"]?.ToString().StartsWith("screen/" + owner + "/", StringComparison.Ordinal) == true);
            }
            File.WriteAllText(Path.Combine(work, "rejected-mutation.json"), badProof.ToJsonString()); negative = true;
            {
                var repairJob = Path.Combine(work, "repair.json"); var repairOutput = Path.Combine(work, "repaired.oml");
                File.WriteAllText(repairJob, new JsonObject { ["ops"] = host.PlanModuleSpecification(badOutput, contract) }.ToJsonString());
                var repaired = JsonSerializer.SerializeToNode(JobRunner.Run(host, badOutput, repairJob, repairOutput))!;
                Assert.True(repaired["accepted"]!.GetValue<bool>(), repaired["details"]!.ToJsonString());
                var repairedProof = host.CheckModuleSpecification(repairOutput, contract, proof["expectedTypes"]!.AsObject());
                Assert.True(repairedProof["accepted"]!.GetValue<bool>(), repairedProof["differences"]!.ToJsonString());
            }
        }
        File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject { ["case"] = name, ["caseKey"] = caseKey, ["status"] = "passed", ["fixture"] = test["fixture"]!.DeepClone(),
            ["features"] = test["features"]!.DeepClone(), ["verified"] = true, ["reloaded"] = true, ["nativeMerge"] = true,
            ["contractChecks"] = after["count"]!.DeepClone(), ["screens"] = after["screenSummary"]!.DeepClone(), ["validMutationRejected"] = negative, ["remoteRuntime"] = false }.ToJsonString());
        void RejectedContext(string error) => File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject {
            ["case"] = name, ["caseKey"] = caseKey, ["status"] = "passed", ["fixture"] = test["fixture"]!.DeepClone(), ["features"] = test["features"]!.DeepClone(),
            ["invalidContextRejected"] = true, ["positiveSupport"] = false, ["error"] = error }.ToJsonString());
    }


    [Fact]
    public void NativeUiEnumsAreCapturedFromInstalledPublicProperties()
    {
        StudioAssemblies.Bind(null);
        var studio = Environment.GetEnvironmentVariable("ANVIL_STUDIO_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "OutSystems", "Service Studio 11 - Anvil 4516", "Service Studio");
        var catalog = Catalog.Extract(studio);
        var enums = new JsonObject();
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name?.StartsWith("ServiceStudio.Plugin.") == true))
        foreach (var type in assembly.GetExportedTypes().Where(t => t.IsInterface))
        foreach (var property in type.GetProperties().Where(p => p.PropertyType.IsEnum))
            enums[property.PropertyType.FullName!] = new JsonArray(Enum.GetNames(property.PropertyType).Select(v => (JsonNode)v).ToArray());
        var work = Path.Combine(Root, ".local", "screen-contract-dev"); Directory.CreateDirectory(work);
        File.WriteAllText(Path.Combine(work, "native-ui-enums.json"), enums.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.NotEmpty(enums);
    }

}
