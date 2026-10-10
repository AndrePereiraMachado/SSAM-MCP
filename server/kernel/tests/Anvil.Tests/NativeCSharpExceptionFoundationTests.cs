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

public sealed class NativeCSharpExceptionFoundationTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("instance-methods", "InstanceMethods", true, 21, 9,
        "705a01e30eea6543a9c1d04bc45bc2af112307973df354b8c738bb8741bef36c")]
    [InlineData("exception-values", "ExceptionValues", false, 16, 7,
        "642fdac638e507a5ac2458eae9c937af9a724865043613d24b655195a6c4aa0d")]
    public void OriginalSourceVerifiesReloadsMergesAndRepeatsWithoutExtraEndpoints(
        string directory, string fixture, bool graph, int methods, int endpoints, string sourceHash)
    {
        StudioAssemblies.Bind();
        Run(directory, fixture, graph, methods, endpoints, sourceHash);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Run(string directory, string fixture, bool graph, int methods, int endpoints, string sourceHash)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeCSharpExceptionFoundationTests).Assembly.Location)!)!;
        var lane = Environment.GetEnvironmentVariable("ANVIL_LANE") ?? "ss4";
        var work = Path.Combine(root, ".local", lane == "ss5" ? "lane-ss5" : "",
            "data-logic-translator", "native-exception-foundation-tests", fixture, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        output.WriteLine("Artifacts: " + work);
        var sourcePath = Path.Combine(root, "tests/csharp", directory, fixture + ".cs.txt");
        var source = File.ReadAllText(sourcePath);
        var files = new Dictionary<string, string> { [fixture + ".cs"] = source };
        var compiled = graph
            ? (CompilationResult)typeof(CSharpCompiler).GetMethod("CompileReferenceGraph", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [files])!
            : CSharpCompiler.Compile(files);
        Assert.Equal(sourceHash, compiled.SourceHash);
        Assert.Empty(compiled.RequiredIntrinsics!);
        var actions = compiled.Specification["logic"]!["actions"]!.AsArray().OfType<JsonObject>().ToArray();
        Assert.Equal(methods, compiled.SourceMap.Count(item => item?["kind"]?.ToString() == "server"));
        Assert.Equal(methods + endpoints, actions.Length);
        Assert.Equal(endpoints, actions.Count(action => action["public"]!.GetValue<bool>()));
        var metadata = graph ? InstanceMetadata(compiled) : ExceptionMetadata(compiled);
        var sourceBundle = new JsonObject { ["files"] = new JsonObject { [fixture + ".cs"] = source } };
        var authored = new JsonObject { ["csharpSource"] = sourceBundle.DeepClone() };
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var target = host.Inspect(basis);
        var frozen = FrozenCSharpCompilation.Capture(sourceBundle, compiled,
            graph ? FrozenCSharpCompilation.GraphProfile : FrozenCSharpCompilation.PublicProfile, "fixture.invalid", target.Key, null);
        var lockPath = Path.Combine(work, "compilation.json");
        frozen.Write(lockPath);
        frozen = FrozenCSharpCompilation.Read(lockPath, frozen.Fingerprint);
        Write("compiled.json", compiled.Specification);
        Write("source-map.json", compiled.SourceMap);
        Write("source-abis.json", compiled.SourceAbis!);
        Write("metadata.json", metadata);
        File.WriteAllText(Path.Combine(work, fixture + ".cs"), source);
        // The immutable exception fixture calls these private failure entries directly
        // from its graph probe. They deliberately have no public/native caller.
        var unusedPrivate = graph ? Array.Empty<string>() : new[] { "AvImpl_ReadNull", "AvImpl_ThrowLiteral", "AvImpl_ThrowNull", "AvImpl_ThrowValue" };
        var expectedMessages = new JsonArray(unusedPrivate.Select(name => (JsonNode)new JsonObject {
            ["id"] = "UnusedUserAction", ["element"] = target.Name + " (ESpace) / " + name + " (ServerAction)",
            ["why"] = "Private failure helper of the preserved source fixture; invoked directly by the separate graph probe and intentionally not exported as a native endpoint." }).ToArray());
        var job = Path.Combine(work, "generated.json");
        Write("generated.json", new JsonObject { ["expectValid"] = true, ["expectedMessages"] = expectedMessages,
            ["ops"] = host.PlanFrozenCSharp(basis, authored, frozen) });
        var module = Path.Combine(work, "compiled.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, module))!;
        Write("apply-result.json", applied);
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["validation"]!.ToJsonString());
        Assert.True(applied["isValid"]!.GetValue<bool>());
        Assert.Equal(unusedPrivate.Length, applied["messages"]!.GetValue<int>());
        var saved = Path.Combine(work, "reloaded.oml");
        var reload = host.RoundTrip(File.ReadAllBytes(module), saved);
        Write("reload.json", JsonSerializer.SerializeToNode(reload)!);
        Assert.True(reload.Original.IsValid && reload.Reloaded.IsValid);
        Assert.True(reload.SameKey && reload.SameObjectCount && reload.SameValidation);
        Assert.Equal(unusedPrivate.Length, reload.Reloaded.Validation.Total);
        var before = host.CheckFrozenCSharp(saved, authored, null, frozen);
        Write("proof.json", before);
        Assert.True(before["accepted"]!.GetValue<bool>(), before.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(saved), merged);
        Write("merge.json", JsonSerializer.SerializeToNode(merge)!);
        Assert.False(merge.HasConflicts);
        Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        var after = host.CheckFrozenCSharp(merged, authored, before["expectedTypes"]!.AsObject(), frozen);
        Write("after-merge-proof.json", after);
        Assert.True(after["accepted"]!.GetValue<bool>(), after.ToJsonString());
        var baselineInventory = Inventory(host, basis, []);
        var inventory = Inventory(host, merged, metadata["inspect"]!.AsArray().Select(item => item!.ToString()));
        Write("native-inventory.json", inventory);
        var originalNames = baselineInventory["actions"]!.AsArray().Select(item => item!["name"]!.ToString()).ToHashSet(StringComparer.Ordinal);
        var added = inventory["actions"]!.AsArray().Where(item => !originalNames.Contains(item!["name"]!.ToString())).ToArray();
        Assert.Equal(actions.Select(item => item["name"]!.ToString()).Order(), added.Select(item => item!["name"]!.ToString()).Order());
        foreach (var action in actions)
        {
            var actual = added.Single(item => item!["name"]!.ToString() == action["name"]!.ToString())!;
            Assert.Equal(action["public"]!.GetValue<bool>(), bool.Parse(actual["properties"]!["Public"]!.ToString()));
        }
        var repeated = host.PlanFrozenCSharp(merged, authored, frozen);
        Write("repeat-plan.json", repeated);
        Assert.Empty(repeated);
        var summary = new JsonObject { ["passed"] = true, ["fixture"] = fixture, ["lane"] = lane,
            ["studioDirectory"] = StudioAssemblies.Directory, ["work"] = work,
            ["sourceHash"] = compiled.SourceHash, ["sourceSha256"] = Hash(sourcePath),
            ["contractSha256"] = Hash(Path.Combine(work, "compiled.json")), ["moduleSha256"] = Hash(merged),
            ["frozenFingerprint"] = frozen.Fingerprint, ["sourceMethods"] = methods,
            ["privateHelpers"] = methods, ["publicEndpoints"] = endpoints,
            ["sourceAbis"] = compiled.SourceAbis!.Count, ["actions"] = actions.Length,
            ["modelAssertions"] = after["count"]!.DeepClone(), ["verifyMessages"] = unusedPrivate.Length,
            ["reloadMessages"] = unusedPrivate.Length, ["verifyErrors"] = 0,
            ["expectedUnusedPrivateHelpers"] = new JsonArray(unusedPrivate.Select(name => (JsonNode)JsonValue.Create(name)!).ToArray()),
            ["nativeMerge"] = true, ["repeatOps"] = 0, ["metadata"] = metadata.DeepClone(),
            ["nativeBusinessExecution"] = false, ["published"] = false,
            ["scope"] = "Original C# source, frozen compiler contract, independent native model proof, Verify, reload, offline merge and idempotence. Business behavior is covered separately by CLR and graph probes; try/search/unwind and an external exception identity codec remain unproved." };
        Write("summary.json", summary);
        output.WriteLine(summary.ToJsonString());
        void Write(string name, JsonNode value) => File.WriteAllText(Path.Combine(work, name), value.ToJsonString());
    }

    private static JsonObject InstanceMetadata(CompilationResult compiled)
    {
        var methods = compiled.SourceMap.OfType<JsonObject>().Where(item => item["source"]!.ToString().StartsWith("Counter.", StringComparison.Ordinal)).ToArray();
        Assert.Equal(8, methods.Length);
        var inspect = new JsonArray();
        string? receiverType = null;
        foreach (var method in methods)
        {
            var name = method["implementation"]!.ToString();
            var helper = compiled.Specification["logic"]!["actions"]!.AsArray().Single(item => item!["name"]!.ToString() == name)!;
            Assert.False(helper["public"]!.GetValue<bool>());
            Assert.Equal("AvThis", helper["inputs"]![1]!["name"]!.ToString());
            receiverType ??= helper["inputs"]![1]!["type"]!.ToString();
            Assert.Equal(receiverType, helper["inputs"]![1]!["type"]!.ToString());
            inspect.Add("IServerAction:" + name + "/AvThis");
        }
        Assert.All(compiled.SourceAbis!, entry => Assert.Equal(2, entry!["abi"]!["version"]!.GetValue<int>()));
        Assert.DoesNotContain(compiled.SourceAbis!, entry => entry!["source"]!.ToString().StartsWith("Counter.", StringComparison.Ordinal));
        inspect.Add("IStructure:" + receiverType);
        inspect.Add("IStructure:" + receiverType + "/Index");
        return new() { ["instanceHelpers"] = methods.Length, ["receiver"] = "AvThis", ["receiverType"] = receiverType,
            ["receiverIdentityField"] = "Index", ["inspect"] = inspect };
    }

    private static JsonObject ExceptionMetadata(CompilationResult compiled)
    {
        Assert.Empty(compiled.SourceAbis!);
        var structures = compiled.Specification["data"]!["structures"]!.AsArray();
        var handle = structures.Single(item => item!["name"]!.ToString() == "AvExceptionRef")!;
        Assert.False(handle["public"]!.GetValue<bool>());
        var index = Assert.Single(handle["attributes"]!.AsArray())!;
        Assert.Equal("Index", index["name"]!.ToString()); Assert.Equal("Integer", index["type"]!.ToString());
        var context = structures.Single(item => item!["name"]!.ToString() == "AvReferenceContext")!;
        var pool = context["attributes"]!.AsArray().Single(item => item!["name"]!.ToString() == "Exceptions")!;
        Assert.Equal("AvReferenceException List", pool["type"]!.ToString());
        foreach (var name in new[] { "AvExceptionRef", "AvReferenceContext", "AvReferenceException", "AvReferenceCompletion" })
            Assert.False(structures.Single(item => item!["name"]!.ToString() == name)!["public"]!.GetValue<bool>());
        return new() { ["handle"] = "AvExceptionRef", ["identityField"] = "Index", ["identityType"] = "Integer",
            ["pool"] = "AvReferenceContext.Exceptions", ["poolType"] = "AvReferenceException List", ["externalCodec"] = false,
            ["inspect"] = new JsonArray("IStructure:AvExceptionRef", "IStructure:AvExceptionRef/Index",
                "IStructure:AvReferenceContext/Exceptions", "IStructure:AvReferenceException/InnerRef",
                "IStructure:AvReferenceException/HResult", "IStructure:AvReferenceCompletion/ExceptionRef",
                "IServerAction:AvImpl_Make/AvResult", "IServerAction:AvImpl_Identity/Arg_value", "IServerAction:AvImpl_ThrowValue/Arg_value") };
    }

    // Keep the ServiceStudio.Framework-only ESpace type at this reflection boundary.
    // These are ordinary model reads, never execution of the compiled business actions.
    private static JsonObject Inventory(ModelHost host, string path, IEnumerable<string> inspect)
    {
        var model = typeof(ModelHost).GetMethod(nameof(ModelHost.Load), [typeof(string)])!.Invoke(host, [path])!;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), model)!;
            var actions = session.ApplyOne(new JsonObject { ["op"] = "find", ["type"] = "IServerAction", ["max"] = 1000 })!.AsArray();
            var details = new JsonArray(actions.Select(item => session.Get(session.Resolve("@" + item!["key"]!.ToString()))).ToArray());
            var fields = new JsonObject();
            foreach (var reference in inspect) fields[reference] = session.Get(session.Resolve(reference));
            return new() { ["actions"] = details, ["fields"] = fields };
        }
        finally { typeof(ModelHost).GetMethod(nameof(ModelHost.Release))!.Invoke(null, [model]); }
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
}
