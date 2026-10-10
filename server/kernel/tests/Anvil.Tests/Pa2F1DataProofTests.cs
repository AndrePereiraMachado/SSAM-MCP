using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F1 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md), A12: the data proof compares a reference by its resolved
/// target (the producer element), so the Studio re-keying a theme reference in the consumer is equal and listed in
/// platformRewrites (the SS360_Portal case of 2026-10-06: "BaseTheme expected {key F_65+..} actual {key zeDb..}"); a merge
/// kept for review only because the delivered data differs answers DATA_PROOF_DIFFERS with every difference in the task.
/// </summary>
public sealed class Pa2F1DataProofTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F1DataProofTests).Assembly.Location)!)!;

    [Fact]
    public void AThemeReferenceTheStudioReKeyedIsTheSameValue()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Root, ".local", "pa2-f1-tests", "data-proof", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        DataContractIdentityScenarios.AProducerReferenceReKeyedByTheMergeIsEqual(new ModelHost(work),
            Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), "IMobileTheme:Headless_UI", "BaseTheme");
    }

    [Fact]
    public void AMergeKeptOnlyForDataDifferencesAnswersDataProofDiffersWithEveryDifference()
    {
        var differences = new JsonArray(Enumerable.Range(0, 25).Select(i => (JsonNode)new JsonObject {
            ["element"] = $"Probe (ESpace) / E{i} (ServerEntity)", ["property"] = "Description", ["expected"] = "a" + i, ["actual"] = "b" + i }).ToArray());
        var (work, job) = Pa2F1WarningTests.Job();
        var result = Delivery.Run(new ProofBridge(), new DeliveryRequest("Probe", job, work, []), ApplyWithAssertion,
            inspectData: (_, _) => new JsonObject { ["accepted"] = false, ["count"] = 25, ["differences"] = differences.DeepClone() });
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(Delivery.DataProofDiffersCode, result["code"]!.ToString());
        Assert.Equal("applied", result["writeState"]!.ToString());
        Assert.Equal(25, result["dataProof"]!["differences"]!.AsArray().Count);
        Assert.Contains("25 difference(s)", result["error"]!.ToString());
        // The receipt the evidence continuation reads holds them all at /dataProof/differences.
        var receipt = JsonNode.Parse(File.ReadAllText(Path.Combine(result["work"]!.ToString(), "result.json")))!;
        Assert.Equal(25, receipt["dataProof"]!["differences"]!.AsArray().Count);
    }

    [Fact]
    public void AnotherFailureNextToTheDataProofKeepsItsOwnCode()
    {
        // A requested check that is missing too: the refusal is not only a data difference.
        var (work, job) = Pa2F1WarningTests.Job();
        var result = Delivery.Run(new ProofBridge { Missing = true }, new DeliveryRequest("Probe", job, work, ["Gone"]), ApplyWithAssertion,
            inspectData: (_, _) => new JsonObject { ["accepted"] = false, ["count"] = 1, ["differences"] = new JsonArray(new JsonObject {
                ["element"] = "Probe (ESpace) / E (ServerEntity)", ["property"] = "Description", ["expected"] = "a", ["actual"] = "b" }) });
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Null(result["code"]);
        // A known class of difference (a default the merge dropped) has its repair, not DATA_PROOF_DIFFERS.
        var (work2, job2) = Pa2F1WarningTests.Job();
        var lost = Delivery.Run(new ProofBridge(), new DeliveryRequest("Probe", job2, work2, []), (_, _, output) =>
            {
                File.WriteAllText(output, "foreign");
                return new JsonObject { ["isValid"] = true, ["accepted"] = true, ["dataContract"] = new JsonObject { ["accepted"] = true, ["assertions"] = new JsonArray(
                    new JsonObject { ["key"] = "attr-key", ["element"] = "Probe (ESpace) / Pet (ServerEntity) / Name (EntityAttribute)", ["property"] = "DefaultValue", ["expected"] = "\"Rex\"" }) } };
            },
            inspectData: (_, _) => new JsonObject { ["accepted"] = false, ["count"] = 1, ["differences"] = new JsonArray(new JsonObject {
                ["element"] = "Probe (ESpace) / Pet (ServerEntity) / Name (EntityAttribute)", ["property"] = "DefaultValue", ["expected"] = "\"Rex\"", ["actual"] = "" }) });
        Assert.NotEqual(Delivery.DataProofDiffersCode, lost["code"]?.ToString());
        Assert.NotNull(lost["mergeOrder"]);
    }

    private static readonly Func<string, string, string, JsonObject> ApplyWithAssertion = (_, _, output) =>
    {
        File.WriteAllText(output, "foreign");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true, ["dataContract"] = new JsonObject { ["accepted"] = true,
            ["assertions"] = new JsonArray(new JsonObject { ["key"] = "e-key", ["element"] = "Probe (ESpace) / E (ServerEntity)", ["property"] = "Description", ["expected"] = "a" }) } };
    };

    private sealed class ProofBridge : IBridgeClient
    {
        public bool Missing;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                    return new() { ["key"] = "A", ["snapshot_id"] = "s1" };
                case "merge_from_oml": return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                case "find_element": return new() { ["query"] = parameters!["name"]!.ToString(), ["count"] = Missing ? 0 : 1 };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
