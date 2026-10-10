using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public sealed class NativeCSharpSourceRuntimeTests
{
    [Fact]
    public void SourceAbiRequiresTheSameFrozenRuntimeSourceTargetAndNativeReferenceHash()
    {
        StudioAssemblies.Bind(); Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeCSharpSourceRuntimeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-source-runtime-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); var host = new ModelHost(work);
        var files = new Dictionary<string, string> { ["Source.cs"] = Source };
        var compile = typeof(CSharpCompiler).GetMethod("CompileReferenceGraph", BindingFlags.NonPublic | BindingFlags.Static)!;
        var compiled = (CompilationResult)compile.Invoke(null, [files])!;
        var intrinsic = Assert.Single(compiled.RequiredIntrinsics!);
        Assert.Equal(FrameworkIntrinsic.CompareOrdinal, intrinsic);

        var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var moduleKey = host.Inspect(basis).Key;
        var fixture = Path.Combine(root, "tests/contracts/native-reference/ordinal-primitive.avsig");
        var fixtureBytes = File.ReadAllBytes(fixture);
        var runtimePath = Path.Combine(work, "runtime.avsig"); File.WriteAllBytes(runtimePath, fixtureBytes);
        var envelope = JsonNode.Parse(fixtureBytes)!;
        // This existing offline fixture supplies a native interface, not executable package
        // attestation or evidence that a published CompareOrdinal implementation ran.
        FrozenFrameworkDependencies Lock(string path, JsonNode description, string? target = null)
        {
            var element = Assert.Single(description["Elements"]!.AsArray(), item => item!["Name"]!.ToString() == "CSharpTextCompareOrdinal")!;
            return FrozenFrameworkDependencies.Create(compiled.SourceHash, compiled.RequiredIntrinsics!, "fixture.invalid", target ?? moduleKey,
                new("FixtureOnly", "interface-test", new string('a', 64)),
                [new("Runtime", path, Hash(File.ReadAllBytes(path)), description["ModuleKey"]!.ToString(), description["SignatureHash"]!.ToString())],
                [new(intrinsic.Reference, "Runtime", element["Name"]!.ToString(), element["Key"]!.ToString(), intrinsic.Inputs, intrinsic.Output)]);
        }
        var runtime = Lock(runtimePath, envelope);
        var bound = FrameworkIntrinsic.Bind(compiled, runtime.CallBindings());
        var edits = host.PlanModuleSpecification(basis, bound.Specification);
        var ops = new JsonArray(runtime.ReferenceOperations().Concat(edits).Select(op => op!.DeepClone()).ToArray());
        Assert.Equal("reference", ops[0]!["op"]!.ToString());
        Assert.DoesNotContain("IFrameworkIntrinsic:", ops.ToJsonString());
        var job = Path.Combine(work, "fixture.json"); var snapshot = Path.Combine(work, "producer.oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, snapshot, bindings: runtime.ProducerBindings()))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());

        var bytes = File.ReadAllBytes(snapshot); var header = NativeStatic("Oml.Oml", "GetOmlHeader", bytes);
        using var oml = (IDisposable)NativeStatic("Oml.Oml", "LoadWithoutUpgrades", bytes, "");
        var signature = (XElement)NativeCall(oml, "GetSignature");
        string Header(string name) => header.GetType().GetProperty(name)!.GetValue(header)!.ToString()!;
        var producer = new NativeDependencyProducer("Frozen", "fixture.invalid", Header("Key"), Header("Name"), "eSpace", Header("ESpaceType"), 1,
            NativeStatic("Oml.OmlAttrParser", "GetGuid", NativeStatic("Oml.Signatures.SignatureHasher", "CalculateHash", signature)).ToString()!, Hash(bytes));
        var requirement = new NativeDependencyRequirement("page.html::Page::compare", NativeDependencyKind.ServerAction, producer.ProducerName, "Compare");
        var paths = new Dictionary<string, string> { [producer.Binding] = snapshot };
        NativeCSharpProducerSource Export(string original, FrozenFrameworkDependencies? selected)
        {
            var bundle = new JsonObject { ["files"] = new JsonObject { ["Source.cs"] = original } };
            var compilation = (CompilationResult)compile.Invoke(null, [SourceBundle.From(bundle)])!;
            var frozen = FrozenCSharpCompilation.Capture(bundle, compilation, FrozenCSharpCompilation.GraphProfile,
                producer.Environment, producer.ProducerKey, selected);
            return new(producer.Binding, CSharpProducerExportFixture.WriteReceipt(frozen, selected, snapshot,
                Path.Combine(work, "export-" + Guid.NewGuid().ToString("N"))));
        }
        var source = Export(Source, runtime);
        NativeCSharpSourceReadResult Read(NativeCSharpProducerSource selected, NativeDependencyProducer? descriptor = null) =>
            NativeCSharpSourceReader.Read(host, [requirement], [descriptor ?? producer], paths, [selected]);

        var actual = Read(source);
        var sourceProof = Assert.Single(actual.SourceProofs)!;
        var modelProof = sourceProof["modelProof"]!;
        var runtimeProof = modelProof["runtimeDependencies"]!;
        Assert.True(modelProof["accepted"]!.GetValue<bool>());
        Assert.True(runtimeProof["accepted"]!.GetValue<bool>());
        Assert.True(runtimeProof["count"]!.GetValue<int>() > 0);
        Assert.Equal(runtime.Fingerprint, runtimeProof["lockFingerprint"]!.ToString());
        Assert.Contains(runtimeProof["assertions"]!.AsArray(), item => item!["property"]!.ToString() == "signatureHash"
            && item["expected"]!.ToString() == envelope["SignatureHash"]!.ToString());
        Assert.Equal(compiled.SourceHash, sourceProof["sourceHash"]!.ToString());
        Assert.Single(sourceProof["attached"]!.AsArray());
        var abi = actual.Catalog.Resolve(requirement).SourceAbi;
        Assert.NotNull(abi); Assert.Equal("anvil.csharp.reference-graph", abi.Id); Assert.Equal(2, abi.Version);
        var expectedAbi = Assert.Single(compiled.SourceAbis!, item => item!["native"]!.ToString() == "Compare")!["abi"]!;
        Assert.True(JsonNode.DeepEquals(expectedAbi, abi.Payload));
        Assert.Contains(abi.Payload["definitions"]!.AsArray(), item => item!["type"]!["name"]!.ToString() == "Node");
        File.WriteAllText(Path.Combine(work, "source-proof.json"), actual.SourceProofs.ToJsonString());
        File.WriteAllText(Path.Combine(work, "catalog.json"), actual.Catalog.ToJson().ToJsonString());

        var rejected = new JsonObject();
        void Reject(string scenario, string diagnostic, Func<NativeCSharpSourceReadResult> read)
        {
            var error = Assert.Throws<InvalidOperationException>(() => { _ = read(); });
            Assert.Contains(diagnostic, error.Message);
            rejected[scenario] = error.Message;
        }
        Reject("missing-runtime", "requires its frozen runtime choice", () => Read(Export(Source, null)));
        // A comment preserves generated native behavior but changes the frozen source revision.
        Reject("source-revision", "another source revision", () => Read(Export(Source + "\n// another source revision\n", runtime)));
        Reject("target-module", "another target environment/module", () => Read(Export(Source,
            Lock(runtimePath, envelope, Guid.NewGuid().ToString()))));
        Reject("target-environment", "another environment/module", () => Read(source, producer with { Environment = "other-fixture.invalid" }));

        // Freeze a self-consistent alternate descriptor, leaving the actual producer's imported
        // reference unchanged. Model inspection must reject that different ReferenceHash.
        var changedEnvelope = envelope.DeepClone(); changedEnvelope["SignatureHash"] = Guid.NewGuid().ToString();
        var changedPath = Path.Combine(work, "different-runtime.avsig"); File.WriteAllText(changedPath, changedEnvelope.ToJsonString());
        Reject("native-reference-hash", "signatureHash", () => Read(Export(Source, Lock(changedPath, changedEnvelope))));

        Assert.Equal(bytes, File.ReadAllBytes(snapshot));
        Assert.Equal(fixtureBytes, File.ReadAllBytes(fixture));
        Assert.Equal(fixtureBytes, File.ReadAllBytes(runtimePath));
        File.WriteAllText(Path.Combine(work, "summary.json"), new JsonObject {
            ["passed"] = true, ["sourceHash"] = compiled.SourceHash, ["nativeSnapshotSha256"] = producer.SignatureFileSha256,
            ["runtimeLockFingerprint"] = runtime.Fingerprint, ["rejected"] = rejected,
            ["defaultControllerEnabled"] = false, ["publishedRuntimeBehaviorProved"] = false,
            ["scope"] = "Offline frozen runtime source/target checks, imported ReferenceHash and typed callee ABI; no executable-package or runtime-behavior attestation."
        }.ToJsonString());
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static object NativeStatic(string type, string name, params object[] args)
    {
        var target = AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetType("OutSystems.Model.Implementation." + type)).First(value => value != null)!;
        return target.GetMethods(BindingFlags.Static | BindingFlags.Public).Single(method => Matches(method, name, args)).Invoke(null, args)!;
    }
    private static object NativeCall(object instance, string name, params object[] args) => instance.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
        .Single(method => Matches(method, name, args)).Invoke(instance, args)!;
    private static bool Matches(MethodInfo method, string name, object[] args) => method.Name == name
        && method.GetParameters().Length == args.Length && method.GetParameters().Zip(args).All(pair => pair.First.ParameterType.IsInstanceOfType(pair.Second));

    private const string Source = """
        #nullable enable
        using System;
        public sealed class Node { public int Count { get; set; } public Node? Next { get; set; } }
        public static class Work {
            public static Node Compare(Node value, string? left, string? right) {
                value.Count = string.CompareOrdinal(left, right);
                return value;
            }
        }
        """;
}
