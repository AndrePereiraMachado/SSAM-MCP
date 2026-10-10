using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class ActionCoverageTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ActionCoverageTests).Assembly.Location)!)!;
    public static IEnumerable<object[]> Cases() => Directory.GetFiles(Path.Combine(Root, "tests", "contracts", "action-coverage"), "*.json").Order().Select(path => new object[] { Path.GetFileNameWithoutExtension(path), Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)))[..12] });
    [Theory]
    [MemberData(nameof(Cases))]
    public void EveryMatrixRowHasNativeVerifyReloadMergeAndIndependentProof(string name, string caseKey)
    {
        var test = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "contracts", "action-coverage", name + ".json")))!.AsObject();
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local", "action-coverage", name); Directory.CreateDirectory(work);
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
        Assert.DoesNotContain(host.PlanModuleSpecification(merged, contract), op => op?["op"]?.ToString() == "logic");
        var negative = false;
        if (test["mutation"] is JsonObject mutation)
        {
            var badJob = Path.Combine(work, "mutation.json"); var badOutput = Path.Combine(work, "mutated.oml");
            var operation = mutation.DeepClone().AsObject(); operation["op"] = "set";
            File.WriteAllText(badJob, new JsonObject { ["ops"] = new JsonArray(operation) }.ToJsonString());
            var badResult = JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, badJob, badOutput))!;
            Assert.True(badResult["accepted"]!.GetValue<bool>(), "Mutation must remain Verify-valid: " + badResult["details"]);
            var badProof = host.CheckModuleSpecification(badOutput, contract, proof["expectedTypes"]!.AsObject());
            Assert.False(badProof["accepted"]!.GetValue<bool>(), "Verifier accepted changed behavior: " + name);
            File.WriteAllText(Path.Combine(work, "rejected-mutation.json"), badProof.ToJsonString()); negative = true;
            if (contract["logic"]!["actions"]!.AsArray().Any(action => action?["owner"] != null))
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
            ["contractChecks"] = after["count"]!.DeepClone(), ["actions"] = after["actionSummary"]!.DeepClone(), ["validMutationRejected"] = negative, ["remoteRuntime"] = false }.ToJsonString());
        void RejectedContext(string error) => File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject {
            ["case"] = name, ["caseKey"] = caseKey, ["status"] = "passed", ["fixture"] = test["fixture"]!.DeepClone(), ["features"] = test["features"]!.DeepClone(),
            ["invalidContextRejected"] = true, ["positiveSupport"] = false, ["error"] = error }.ToJsonString());
    }

    [Theory]
    [InlineData("blank-service", "IServerAction")]
    [InlineData("blank-service", "IServiceAction")]
    [InlineData("reactive-ui", "IClientAction")]
    public void BptDecisionOutcomeIsNotAnOrdinaryServerOrClientLogicWidget(string fixture, string type)
    {
        StudioAssemblies.Bind(null); var work = Path.Combine(Root, ".local", "action-coverage", "bpt-context-" + type); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var job = Path.Combine(work, "probe.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = type, ["name"] = "Coverage", ["as"] = "$action" },
            new JsonObject { ["op"] = "create", ["parent"] = "$action", ["type"] = "IDecisionOutcomeNode" }) }.ToJsonString());
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, Path.Combine(Root, "tests", "fixtures", fixture + ".oml"), job, Path.Combine(work, "probe.oml")));
        Assert.Contains("op #1 (create", error.Message);
        File.WriteAllText(Path.Combine(work, "evidence.json"), new JsonObject { ["type"] = "IDecisionOutcomeNode", ["parent"] = type,
            ["invalidContextRejected"] = true, ["positiveSupport"] = false, ["error"] = error.Message }.ToJsonString());
    }

    [Theory]
    [InlineData("target")]
    [InlineData("property")]
    [InlineData("wrong-enum")]
    [InlineData("reference-key")]
    [InlineData("partial-node")]
    [InlineData("unknown-node")]
    [InlineData("ignored-join")]
    [InlineData("swallow-access")]
    [InlineData("refresh-offset")]
    [InlineData("public-local-entity")]
    public void ExtendedVocabularyCannotOpenAnOperationalEscapeOrIgnoreADeclaration(string defect)
    {
        var contract = JsonNode.Parse("""{"logic":{"actions":[{"name":"Coverage","kind":"client","steps":[{"node":"IMessageNode","as":"Notice","properties":{"Message":"\"hello\"","Type":"Info"}}]}]}}""")!.AsObject();
        var action = contract["logic"]!["actions"]![0]!.AsObject(); var step = action["steps"]![0]!.AsObject();
        if (defect == "public-local-entity") contract["data"] = JsonNode.Parse("""{"clientEntities":[{"name":"Local","public":true}]}""");
        if (defect == "refresh-offset") { step["node"] = "IRefreshDataNode"; step["properties"] = new JsonObject { ["DataSource"] = "IMobileScreen:Screen/ReadRows", ["MaxRecords"] = "10", ["StartIndex"] = "2" }; }
        if (defect == "target") step["target"] = "@espace";
        if (defect == "property") step["properties"]!["Target"] = "@elsewhere";
        if (defect == "wrong-enum") step["properties"]!["Type"] = "Information";
        if (defect == "partial-node") step["properties"]!.AsObject().Remove("Message");
        if (defect == "unknown-node") step["node"] = "IExecuteServerActionNode";
        if (defect == "reference-key") { step["node"] = "IDestinationNode"; step["properties"] = new JsonObject { ["Destination"] = "@key", ["Transition"] = "None" }; }
        if (defect == "ignored-join") { action["steps"] = new JsonArray(new JsonObject { ["get"] = "User", ["as"] = "Read", ["joins"] = new JsonArray("ignored") }); }
        if (defect == "swallow-access") { action["kind"] = "server"; action["access"] = new JsonObject { ["authenticated"] = true }; action["handlers"] = new JsonArray(new JsonObject { ["name"] = "Swallow", ["exception"] = "HybridAccessDenied", ["abortTransaction"] = false, ["logError"] = false, ["steps"] = new JsonArray() }); }
        Assert.ThrowsAny<Exception>(() => ModuleSpecification.Validate(contract));
    }

    [Fact]
    public void SystemListSignaturesAreReadFromTheInstalledRuntime()
    {
        StudioAssemblies.Bind(null); var work = Path.Combine(Root, ".local", "action-coverage"); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var load = typeof(ModelHost).GetMethod("Load", [typeof(byte[])])!;
        var model = load.Invoke(host, [File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"))])!;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), model)!;
            var all = session.ApplyOne(new JsonObject { ["op"] = "find", ["type"] = "IActionSignature", ["max"] = 10000 })!.AsArray();
            var result = new JsonArray();
            foreach (var item in all.Where(a => a?["name"]?.ToString().StartsWith("List", StringComparison.Ordinal) == true))
                result.Add(session.ApplyOne(new JsonObject { ["op"] = "dump", ["target"] = "@" + item!["key"], ["depth"] = 3 }));
            File.WriteAllText(Path.Combine(work, "list-signatures.json"), result.ToJsonString()); Assert.True(result.Count >= 5);
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(host, [model]); }
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"logic\":{\"actions\":[]}}")]
    [InlineData("{\"roles\":[],\"exceptions\":[],\"logic\":{\"actions\":[]}}")]
    public void EmptyContractsNeverReceiveAZeroCheckCertificate(string text)
        => Assert.Throws<ArgumentException>(() => ModuleSpecification.Validate(JsonNode.Parse(text)!.AsObject()));

    [Fact]
    public void NativeNodeSchemaMatchesInstalledCatalogAndNeverExposesGraphMutation()
    {
        var catalog = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "catalog", "model-api-11.55.69.json")))!;
        foreach (var (name, shape) in LogicNodes.Shapes)
        {
            var native = catalog["Interfaces"]!.AsArray().Single(n => n!["Name"]!.ToString() == "OutSystems.Model.Logic.Nodes." + name)!;
            var properties = native["Properties"]!.AsArray().ToDictionary(p => p!["Name"]!.ToString());
            foreach (var (property, field) in shape.Fields)
            {
                Assert.True(properties.ContainsKey(property), name + "." + property);
                Assert.DoesNotContain(property, new[] { "Target", "Parent", "ObjectKey", "IsDisabled", "CreatedBy" });
                if (field.Kind == "enum") Assert.Equal(field.Values, catalog["Enums"]!.AsArray().Single(e => e!["Name"]!.ToString() == properties[property]!["Type"]!.ToString().Split('.').Last())!["Values"]!.AsArray().Select(v => v!.ToString()));
            }
        }
    }
}
