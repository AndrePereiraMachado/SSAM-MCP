using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public sealed class NativeFrozenCSharpPipelineTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ProductionExecutorUsesFrozenCompilationForPlanProofReloadMergeAndRepeat(bool usesRuntime)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeFrozenCSharpPipelineTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-frozen-pipeline-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var sourcePath = Path.Combine(work, "Source.cs");
        var source = usesRuntime
            ? "#nullable enable\npublic static class Words { public static int Compare(string? left, string? right) => string.CompareOrdinal(left, right); }"
            : "public static class Pricing { public static int Price(int quantity) => checked(quantity * 3); }";
        File.WriteAllText(sourcePath, source);
        var authored = new JsonObject { ["csharpSource"] = SourceBundle.Read(sourcePath) };
        var compiled = CSharpCompiler.Compile(SourceBundle.From(authored["csharpSource"]!));
        var host = new ModelHost(work); var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var target = host.Inspect(basis); FrozenFrameworkDependencies? runtime = null;
        if (usesRuntime)
        {
            var original = Path.Combine(root, "tests/contracts/native-reference/ordinal-primitive.avsig");
            var path = Path.Combine(work, "Runtime.avsig"); File.Copy(original, path);
            var envelope = JsonNode.Parse(File.ReadAllText(path))!; var requirement = Assert.Single(compiled.RequiredIntrinsics!);
            var entry = Assert.Single(envelope["Elements"]!.AsArray(), item => item!["Name"]!.ToString() == "CSharpTextCompareOrdinal")!;
            runtime = FrozenFrameworkDependencies.Create(compiled.SourceHash, compiled.RequiredIntrinsics!, "fixture.invalid", target.Key,
                new("FixtureOnly", "interface-test", new string('a', 64)),
                [new("Runtime", path, DeliveryReceipt.Hash(path), envelope["ModuleKey"]!.ToString(), envelope["SignatureHash"]!.ToString())],
                [new(requirement.Reference, "Runtime", entry["Name"]!.ToString(), entry["Key"]!.ToString(), requirement.Inputs, requirement.Output)]);
        }
        var frozen = FrozenCSharpCompilation.Create(authored["csharpSource"]!, "fixture.invalid", target.Key, runtime);
        var lockPath = Path.Combine(work, "compilation.json"); frozen.Write(lockPath);
        frozen = FrozenCSharpCompilation.Read(lockPath, frozen.Fingerprint);
        var request = new DeliveryRequest(target.Name, sourcePath, work, [], Specification: authored);
        var executor = new CSharpRuntimeDelivery(request, "unused-registration");
        var output = Path.Combine(work, "producer.oml");
        var applied = executor.ApplyCompilation(basis, sourcePath, output, frozen, runtime);
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        var before = executor.InspectCompilation(output, authored, null, frozen, runtime);
        Assert.True(before["accepted"]!.GetValue<bool>(), before["differences"]!.ToJsonString());
        if (usesRuntime) Assert.True(before["runtimeDependencies"]!["accepted"]!.GetValue<bool>());
        var reload = host.RoundTrip(File.ReadAllBytes(output)); Assert.True(reload.SameValidation && reload.SameObjectCount && reload.SameKey);
        Assert.Equal(0, reload.Reloaded.Validation.Total);
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(output), merged);
        Assert.False(merge.HasConflicts); Assert.True(merge.LocalIsValid);
        var after = executor.InspectCompilation(merged, authored, before["expectedTypes"]!.AsObject(), frozen, runtime);
        Assert.True(after["accepted"]!.GetValue<bool>(), after["differences"]!.ToJsonString());
        Assert.Empty(host.PlanFrozenCSharp(merged, authored, frozen, runtime));
        var changed = new JsonObject { ["csharpSource"] = source + "\n// later source\n" };
        Assert.Throws<InvalidOperationException>(() => host.PlanFrozenCSharp(merged, changed, frozen, runtime));
        Assert.Equal(frozen.Fingerprint, FrozenCSharpCompilation.Read(lockPath, frozen.Fingerprint).Fingerprint);
        File.WriteAllText(Path.Combine(work, "proof.json"), after.ToJsonString());
        File.WriteAllText(Path.Combine(work, "summary.json"), JsonSerializer.Serialize(new { passed = true, usesRuntime,
            frozen.Fingerprint, frozen.SourceHash, assertions = after["count"]!.GetValue<int>(), reload = true, merge = true, repeatOps = 0,
            scope = "Production frozen executor with original source, independent native proof/reload/merge/idempotence; offline fixture only, no publication or default graph activation." }));
    }
}
