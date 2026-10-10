using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public sealed class NativeTemporalGraphTests(ITestOutputHelper output)
{
    private const string SourceSha256 = "f1f77027e531e40ce6519ebfc8b05f4faa1a05af76efd682d0a56d127e062218";
    private const string SourceHash = "104a2e7416688be609c83bf6e05752d2c9acf7c62f69cfba7589936201d0d151";

    [Fact]
    public void TemporalAuthorshipHasExactNativeTypesAndAbi4ThroughFreezeVerifyReloadMergeAndRepeat()
    {
        StudioAssemblies.Bind(); Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Run()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeTemporalGraphTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-temporal-graph", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine("Artifacts: " + work);
        var sourcePath = Path.Combine(root, "tests/csharp/temporal-graph/TemporalSchedule.cs.txt");
        Assert.Equal(SourceSha256, Hash(sourcePath));
        var source = File.ReadAllText(sourcePath);
        var files = new Dictionary<string, string> { ["TemporalSchedule.cs"] = source };
        var compiled = (CompilationResult)typeof(CSharpCompiler).GetMethod("CompileReferenceGraph", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [files])!;
        Assert.Equal(SourceHash, compiled.SourceHash); Assert.Empty(compiled.RequiredIntrinsics!);
        Assert.Equal(6, compiled.SourceAbis!.Count);
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        Assert.Equal(6, actions.Count(action => action["public"]!.GetValue<bool>()));
        Assert.Equal(6, actions.Count(action => !action["public"]!.GetValue<bool>()));
        Assert.Equal(new[] { "ChooseReview", "ClearOverrides", "Elapsed", "Record", "RecordingPair", "Snapshot" },
            actions.Where(action => action["public"]!.GetValue<bool>()).Select(action => action["name"]!.ToString()).Order(StringComparer.Ordinal));
        foreach (var entry in compiled.SourceAbis)
        {
            var abi = entry!["abi"]!;
            Assert.Equal(4, abi["version"]!.GetValue<int>()); Assert.Equal("Exceptions", abi["exceptionArena"]!.ToString());
            Assert.Contains("\"kind\":\"temporal\"", abi.ToJsonString());
        }
        var structures = compiled.Specification["data"]!["structures"]!.AsArray();
        var fields = new Dictionary<string, (string Name, string Type)[]> {
            ["DateOnly"] = [("DayNumber", "Integer")], ["TimeOnly"] = [("Ticks", "Long Integer")],
            ["TimeSpan"] = [("Ticks", "Long Integer")], ["DateTime"] = [("Ticks", "Long Integer"), ("Kind", "Integer")],
            ["DateTimeOffset"] = [("UtcTicks", "Long Integer"), ("OffsetMinutes", "Integer")]
        };
        foreach (var temporal in fields)
        {
            var declared = structures.Single(item => item!["name"]!.ToString() == "AvTemporal_" + temporal.Key)!;
            Assert.Equal(temporal.Value, declared["attributes"]!.AsArray().Select(item => (item!["name"]!.ToString(), item["type"]!.ToString())).ToArray());
        }
        foreach (var action in actions.Where(action => action["public"]!.GetValue<bool>()))
        {
            Assert.Contains(action["inputs"]!.AsArray(), item => item!["name"]!.ToString() == "AvGraphAbiIn" && item["type"]!.ToString() == "Integer");
            Assert.Contains(action["outputs"]!.AsArray(), item => item!["name"]!.ToString() == "AvGraphAbiOut" && item["type"]!.ToString() == "Integer");
            Assert.DoesNotContain(action["outputs"]!.AsArray(), item => item!["name"]!.ToString() == "AvErrors");
            var completion = action["outputs"]!.AsArray().Single(item => item!["name"]!.ToString() == "AvCompletion")!["type"]!.ToString();
            Assert.Equal(new[] { "Kind", "ExceptionRef" }, structures.Single(item => item!["name"]!.ToString() == completion)!["attributes"]!.AsArray().Select(item => item!["name"]!.ToString()));
        }
        Assert.DoesNotContain("\"type\":\"Date Time\"", compiled.Specification.ToJsonString());
        Assert.DoesNotContain("\"type\":\"Date\"", compiled.Specification.ToJsonString());
        Assert.DoesNotContain("\"type\":\"Time\"", compiled.Specification.ToJsonString());
        Save("contract.json", compiled.Specification); Save("source-map.json", compiled.SourceMap); Save("source-abis.json", compiled.SourceAbis);
        File.WriteAllText(Path.Combine(work, "TemporalSchedule.cs"), source);
        var bundle = new JsonObject { ["files"] = new JsonObject { ["TemporalSchedule.cs"] = source } };
        var authored = new JsonObject { ["csharpSource"] = bundle.DeepClone() };
        var host = new ModelHost(work); var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var target = host.Inspect(basis);
        var frozen = FrozenCSharpCompilation.Capture(bundle, compiled, FrozenCSharpCompilation.GraphProfile, "fixture.invalid", target.Key, null);
        var lockPath = Path.Combine(work, "compilation.json"); frozen.Write(lockPath);
        frozen = FrozenCSharpCompilation.Read(lockPath, frozen.Fingerprint);
        var job = Path.Combine(work, "generated.json"); var module = Path.Combine(work, "compiled.oml");
        Save("generated.json", new JsonObject { ["expectValid"] = true, ["expectedMessages"] = new JsonArray(), ["ops"] = host.PlanFrozenCSharp(basis, authored, frozen) });
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, module))!;
        Save("apply.json", applied);
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["validation"]!.ToJsonString());
        Assert.True(applied["isValid"]!.GetValue<bool>()); Assert.Equal(0, applied["messages"]!.GetValue<int>());
        var reloaded = Path.Combine(work, "reloaded.oml");
        var reload = host.RoundTrip(File.ReadAllBytes(module), reloaded); Save("reload.json", JsonSerializer.SerializeToNode(reload)!);
        Assert.True(reload.Original.IsValid && reload.Reloaded.IsValid && reload.SameKey && reload.SameObjectCount && reload.SameValidation);
        Assert.Equal(0, reload.Reloaded.Validation.Total);
        var before = host.CheckFrozenCSharp(reloaded, authored, null, frozen); Save("proof.json", before);
        Assert.True(before["accepted"]!.GetValue<bool>(), before["differences"]!.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(reloaded), merged);
        Save("merge.json", JsonSerializer.SerializeToNode(merge)!);
        Assert.False(merge.HasConflicts); Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        var after = host.CheckFrozenCSharp(merged, authored, before["expectedTypes"]!.AsObject(), frozen); Save("after-merge-proof.json", after);
        Assert.True(after["accepted"]!.GetValue<bool>(), after["differences"]!.ToJsonString());
        var repeat = host.PlanFrozenCSharp(merged, authored, frozen); Save("repeat-plan.json", repeat); Assert.Empty(repeat);
        Assert.Equal(SourceSha256, Hash(sourcePath));
        Assert.Equal(frozen.Fingerprint, FrozenCSharpCompilation.Read(lockPath, frozen.Fingerprint).Fingerprint);
        var summary = new JsonObject { ["passed"] = true, ["sourceSha256"] = SourceSha256, ["sourceHash"] = SourceHash,
            ["contractSha256"] = Hash(Path.Combine(work, "contract.json")), ["moduleSha256"] = Hash(merged),
            ["compilationFingerprint"] = frozen.Fingerprint, ["sourceAbis"] = 6, ["abiVersion"] = 4,
            ["temporalTypes"] = new JsonArray(fields.Keys.Select(name => (JsonNode)JsonValue.Create(name)!).ToArray()),
            ["publicEndpoints"] = 6, ["privateHelpers"] = 6, ["modelAssertions"] = after["count"]!.DeepClone(),
            ["objects"] = applied["objects"]!.DeepClone(), ["ops"] = applied["ops"]!.DeepClone(),
            ["verifyErrors"] = 0, ["verifyMessages"] = 0, ["reload"] = true, ["merge"] = true, ["repeatOps"] = 0,
            ["nativeBusinessExecution"] = false, ["published"] = false,
            ["scope"] = "Fixed natural temporal C# authoring: all five BCL temporal values, nullable fields/returns, typed state/inline struct/list/array, frozen compiler ABI4, native Verify/reload/independent contract proof/offline merge/idempotence. This gate does not execute business actions on a native server or publish/activate the public workflow." };
        Save("summary.json", summary); output.WriteLine(summary.ToJsonString());
        void Save(string name, JsonNode node) => File.WriteAllText(Path.Combine(work, name), node.ToJsonString());
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
}
