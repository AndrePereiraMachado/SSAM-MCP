using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public sealed class NativeExceptionGraphTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("exception-graph", "ExceptionGraph", 3, 3)]
    [InlineData("exception-control-flow", "ExceptionControlFlow", 11, 3)]
    [InlineData("managed-decimal", "ManagedDecimal", 8, 3)]
    [InlineData("byte-array-graph", "ByteArrayGraph", 4, 2)]
    [InlineData("boundary-composition", "BoundaryComposition", 6, 4)]
    [InlineData("temporal-formatting", "TemporalFormatting", 4, 4)]
    public void ExceptionGraphHasNativeHandshakeAndOneIdentityArenaThroughReloadAndMerge(string directory, string fixture, int endpoints, int abiVersion)
    {
        StudioAssemblies.Bind(); Run(directory, fixture, endpoints, abiVersion);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Run(string directory, string fixture, int endpoints, int abiVersion)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeExceptionGraphTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-exception-graph", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine("Artifacts: " + work);
        var source = File.ReadAllText(Path.Combine(root, "tests/csharp", directory, fixture + ".cs.txt"));
        var files = new Dictionary<string, string> { [fixture + ".cs"] = source };
        var compiled = (CompilationResult)typeof(CSharpCompiler).GetMethod("CompileReferenceGraph", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, [files])!;
        Assert.Empty(compiled.RequiredIntrinsics!);
        Assert.Equal(endpoints, compiled.SourceAbis!.Count);
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray();
        foreach (var entry in compiled.SourceAbis)
        {
            var abi = entry!["abi"]!; Assert.Equal(abiVersion, abi["version"]!.GetValue<int>());
            if (abiVersion >= 3) Assert.Equal("Exceptions", abi["exceptionArena"]!.ToString());
            else Assert.Null(abi["exceptionArena"]);
        }
        foreach (var action in actions.OfType<JsonObject>().Where(a => a["public"]!.GetValue<bool>()))
        {
            var inputs = action["inputs"]!.AsArray(); var outputs = action["outputs"]!.AsArray();
            if (abiVersion >= 3)
            {
                Assert.Contains(inputs, p => p!["name"]!.ToString() == "AvGraphAbiIn" && p["type"]!.ToString() == "Integer");
                Assert.Contains(outputs, p => p!["name"]!.ToString() == "AvGraphAbiOut" && p["type"]!.ToString() == "Integer");
                Assert.DoesNotContain(outputs, p => p!["name"]!.ToString() == "AvErrors");
            }
            else
            {
                Assert.DoesNotContain(inputs, p => p!["name"]!.ToString() == "AvGraphAbiIn");
                Assert.DoesNotContain(outputs, p => p!["name"]!.ToString() == "AvGraphAbiOut");
                Assert.Contains(outputs, p => p!["name"]!.ToString() == "AvErrors");
            }
            Assert.Equal(inputs.Count + outputs.Count, inputs.Concat(outputs).Select(p => p!["name"]!.ToString()).Distinct(StringComparer.OrdinalIgnoreCase).Count());
        }
        var sourceBundle = new JsonObject { ["files"] = new JsonObject { [fixture + ".cs"] = source } };
        var authored = new JsonObject { ["csharpSource"] = sourceBundle.DeepClone() };
        var host = new ModelHost(work); var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var original = host.Inspect(basis);
        var frozen = FrozenCSharpCompilation.Capture(sourceBundle, compiled, FrozenCSharpCompilation.GraphProfile, "fixture.invalid", original.Key, null);
        frozen.Write(Path.Combine(work, "compilation.json"));
        Save("contract.json", compiled.Specification); Save("source-abis.json", compiled.SourceAbis);
        var job = Path.Combine(work, "generated.json"); var module = Path.Combine(work, "compiled.oml");
        Save("generated.json", new JsonObject { ["ops"] = host.PlanFrozenCSharp(basis, authored, frozen) });
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, module))!;
        Save("apply.json", applied);
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["validation"]!.ToJsonString());
        Assert.True(applied["isValid"]!.GetValue<bool>()); Assert.Equal(0, applied["messages"]!.GetValue<int>());
        var reloaded = Path.Combine(work, "reloaded.oml");
        var reload = host.RoundTrip(File.ReadAllBytes(module), reloaded); Save("reload.json", JsonSerializer.SerializeToNode(reload)!);
        Assert.True(reload.Original.IsValid && reload.Reloaded.IsValid && reload.SameKey && reload.SameObjectCount && reload.SameValidation);
        var before = host.CheckFrozenCSharp(reloaded, authored, null, frozen); Save("proof.json", before);
        Assert.True(before["accepted"]!.GetValue<bool>(), before.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(reloaded), merged);
        Save("merge.json", JsonSerializer.SerializeToNode(merge)!); Assert.False(merge.HasConflicts); Assert.True(merge.LocalIsValid);
        var after = host.CheckFrozenCSharp(merged, authored, before["expectedTypes"]!.AsObject(), frozen); Save("after-merge-proof.json", after);
        Assert.True(after["accepted"]!.GetValue<bool>(), after.ToJsonString());
        Assert.Empty(host.PlanFrozenCSharp(merged, authored, frozen));
        Save("summary.json", new JsonObject { ["passed"] = true, ["sourceHash"] = compiled.SourceHash,
            ["sourceAbis"] = compiled.SourceAbis.Count, ["abiVersion"] = abiVersion, ["modelAssertions"] = after["count"]!.DeepClone(),
            ["verifyErrors"] = 0, ["verifyMessages"] = 0, ["reload"] = true, ["merge"] = true,
            ["repeatOps"] = 0, ["nativeBusinessExecution"] = false, ["published"] = false });
        void Save(string name, JsonNode node) => File.WriteAllText(Path.Combine(work, name), node.ToJsonString());
    }
}
