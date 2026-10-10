using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class CSharpReferenceTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("ReferenceJournal", 11)]
    [InlineData("ColdReferenceJournal", 23)]
    [InlineData("OptionalReferenceText", 8)]
    public void JournalReferencesAndCompletionVerifyReloadMergeAndKeepAnEmptyRepeatPlan(string fixture, int expectedMethods)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpReferenceTests).Assembly.Location)!)!;
        var lane = Environment.GetEnvironmentVariable("ANVIL_LANE") ?? "ss4";
        var work = Path.Combine(root, ".local", lane == "ss5" ? "lane-ss5" : "", "data-logic-translator", "native-utf16-reference-members", fixture);
        Directory.CreateDirectory(work);
        var sourcePath = Path.Combine(root, "tests/csharp/" + fixture + ".cs.txt");
        var source = File.ReadAllText(sourcePath);
        var compiled = CSharpCompiler.Compile(new Dictionary<string, string> { [fixture + ".cs"] = source });
        Assert.All(compiled.RequiredIntrinsics ?? [], requirement => Assert.Equal(FrameworkIntrinsic.Utf16Length, requirement));
        var contract = new JsonObject { ["csharpSource"] = source };
        ModuleSpecification.Validate(contract);
        File.WriteAllText(Path.Combine(work, "compiled.json"), compiled.Specification.ToJsonString());
        File.WriteAllText(Path.Combine(work, "source-map.json"), compiled.SourceMap.ToJsonString());
        var sourceMethods = compiled.SourceMap.Where(item => item?["kind"]?.ToString() == "server").ToArray();
        Assert.Equal(expectedMethods, sourceMethods.Length);
        Assert.All(sourceMethods, item => Assert.NotNull(item!["implementation"]));
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var runtime = FrameworkRuntimeFixture.For(host, basis, contract, root);
        var plan = host.PlanModuleSpecification(basis, contract, runtime);
        var job = Path.Combine(work, "journal.json");
        var module = Path.Combine(work, "journal.oml");
        File.WriteAllText(job, new JsonObject { ["expectValid"] = true, ["expectedMessages"] = new JsonArray(), ["ops"] = plan }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, module, bindings: runtime?.ProducerBindings()))!;
        File.WriteAllText(Path.Combine(work, "apply-result.json"), result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"] + " " + result["validation"]);
        Assert.True(result["isValid"]!.GetValue<bool>());
        Assert.Equal(0, result["messages"]!.GetValue<int>());
        var saved = Path.Combine(work, "journal-reloaded.oml");
        var roundTrip = host.RoundTrip(File.ReadAllBytes(module), saved);
        File.WriteAllText(Path.Combine(work, "round-trip.json"), JsonSerializer.Serialize(roundTrip));
        Assert.True(roundTrip.Original.IsValid && roundTrip.Reloaded.IsValid);
        Assert.Equal(0, roundTrip.Reloaded.Validation.Total);
        Assert.True(roundTrip.SameKey && roundTrip.SameObjectCount && roundTrip.SameValidation);
        var proof = host.CheckModuleSpecification(saved, contract, runtime: runtime);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        var merged = Path.Combine(work, "journal-merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(saved), merged);
        File.WriteAllText(Path.Combine(work, "merge.json"), JsonSerializer.Serialize(merge));
        Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        Assert.False(merge.HasConflicts, JsonSerializer.Serialize(merge));
        var after = host.CheckModuleSpecification(merged, contract, proof["expectedTypes"]!.AsObject(), runtime: runtime);
        File.WriteAllText(Path.Combine(work, "after-merge-proof.json"), after.ToJsonString());
        Assert.True(after["accepted"]!.GetValue<bool>(), after["differences"]!.ToJsonString());
        var repeated = host.PlanModuleSpecification(merged, contract, runtime);
        File.WriteAllText(Path.Combine(work, "unchanged-plan.json"), repeated.ToJsonString());
        Assert.Empty(repeated);
        var summary = new JsonObject
        {
            ["lane"] = lane, ["studioDirectory"] = StudioAssemblies.Directory, ["fixture"] = fixture,
            ["sourceSha256"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourcePath))).ToLowerInvariant(),
            ["moduleSha256"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(merged))).ToLowerInvariant(),
            ["sourceMethods"] = sourceMethods.Length, ["actions"] = compiled.Specification["logic"]!["actions"]!.AsArray().Count,
            ["structures"] = compiled.Specification["data"]!["structures"]!.AsArray().Count,
            ["ops"] = result["ops"]!.DeepClone(), ["objects"] = result["objects"]!.DeepClone(),
            ["assertions"] = after["assertions"]!.AsArray().Count,
            ["verifyMessages"] = 0, ["reloadMessages"] = 0, ["differences"] = 0,
            ["nativeMerge"] = true, ["repeatOps"] = 0, ["liveExecution"] = false
        };
        File.WriteAllText(Path.Combine(work, "summary.json"), summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine(summary.ToJsonString());
    }
}
