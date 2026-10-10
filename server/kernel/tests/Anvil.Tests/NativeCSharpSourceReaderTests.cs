using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.Core;
using Anvil.Core.Delivery;
using Anvil.CSharp;
using Xunit;

namespace Anvil.Tests;

public sealed class NativeCSharpSourceReaderTests
{
    [Fact]
    public void OnlySourceThatMatchesTheFrozenNativeModelSuppliesItsDerivedAbi()
    {
        StudioAssemblies.Bind(); Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeCSharpSourceReaderTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/native-source-reader-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); var host = new ModelHost(work);
        var files = new Dictionary<string, string> { ["Source.cs"] = Source };
        // Staged fixture construction freezes the compiler evidence used by the reader.
        var compile = typeof(CSharpCompiler).GetMethod("CompileReferenceGraph", BindingFlags.NonPublic | BindingFlags.Static)!;
        var compiled = (CompilationResult)compile.Invoke(null, [files])!;
        Assert.Empty(compiled.RequiredIntrinsics!);
        var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var fixtureJob = Path.Combine(work, "fixture.json"); var snapshot = Path.Combine(work, "producer.oml");
        File.WriteAllText(fixtureJob, new JsonObject { ["ops"] = host.PlanModuleSpecification(basis, compiled.Specification) }.ToJsonString());
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, fixtureJob, snapshot))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        var bytes = File.ReadAllBytes(snapshot); var header = NativeStatic("Oml.Oml", "GetOmlHeader", bytes);
        using var oml = (IDisposable)NativeStatic("Oml.Oml", "LoadWithoutUpgrades", bytes, "");
        var signature = (XElement)NativeCall(oml, "GetSignature");
        string Header(string name) => header.GetType().GetProperty(name)!.GetValue(header)!.ToString()!;
        var producer = new NativeDependencyProducer("Frozen", "fixture.invalid", Header("Key"), Header("Name"), "eSpace", Header("ESpaceType"), 1,
            NativeStatic("Oml.OmlAttrParser", "GetGuid", NativeStatic("Oml.Signatures.SignatureHasher", "CalculateHash", signature)).ToString()!, Hash(bytes));
        NativeDependencyRequirement Requirement(string symbol, NativeDependencyKind kind, string name) => new(symbol, kind, producer.ProducerName, name);
        var requests = new[] {
            Requirement("page.html::Page::update", NativeDependencyKind.ServerAction, "Bump"),
            Requirement("page.html::Other::alsoUpdate", NativeDependencyKind.ServerAction, "Bump"),
            Requirement("page.html::Page::echo", NativeDependencyKind.ServiceAction, "Echo"),
            Requirement("page.html::Page::plain", NativeDependencyKind.ServerAction, "Plain") };
        var paths = new Dictionary<string, string> { [producer.Binding] = snapshot };
        NativeCSharpProducerSource Export(IReadOnlyDictionary<string, string> original, CompilationResult compilation)
        {
            var bundle = new JsonObject { ["files"] = new JsonObject(original.Select(file =>
                KeyValuePair.Create(file.Key, (JsonNode?)JsonValue.Create(file.Value)))) };
            var frozen = FrozenCSharpCompilation.Capture(bundle, compilation, FrozenCSharpCompilation.GraphProfile,
                producer.Environment, producer.ProducerKey, null);
            return new(producer.Binding, CSharpProducerExportFixture.WriteReceipt(frozen, null, snapshot,
                Path.Combine(work, "export-" + Guid.NewGuid().ToString("N"))));
        }
        var source = Export(files, compiled);
        NativeCSharpSourceReadResult Read(params NativeCSharpProducerSource[] inputs) =>
            NativeCSharpSourceReader.Read(host, requests, [producer], paths, inputs);

        Assert.All(Read().Catalog.Bindings, binding => Assert.Null(binding.SourceAbi));
        var actual = Read(source);
        File.WriteAllText(Path.Combine(work, "source-proof.json"), actual.SourceProofs.ToJsonString());
        File.WriteAllText(Path.Combine(work, "catalog.json"), actual.Catalog.ToJson().ToJsonString());
        Assert.True(actual.SourceProofs[0]!["modelProof"]!["accepted"]!.GetValue<bool>());
        Assert.Equal(compiled.SourceHash, actual.SourceProofs[0]!["sourceHash"]!.ToString());
        Assert.Equal(3, actual.SourceProofs[0]!["attached"]!.AsArray().Count);
        foreach (var requirement in requests.Take(3))
        {
            var binding = actual.Catalog.Resolve(requirement); var abi = binding.SourceAbi;
            Assert.NotNull(abi); Assert.Equal("anvil.csharp.reference-graph", abi.Id); Assert.Equal(2, abi.Version);
            var expected = compiled.SourceAbis!.Single(item => item!["native"]!.ToString() == requirement.OriginalElementPath)!["abi"]!;
            Assert.True(JsonNode.DeepEquals(expected, abi.Payload));
            // A consumer cannot mutate the frozen catalog through a returned payload.
            abi.Payload["version"] = 999; Assert.Equal(2, abi.Payload["version"]!.GetValue<int>());
        }
        Assert.Null(actual.Catalog.Resolve(requests[3]).SourceAbi);
        Assert.Equal(actual.Catalog.Resolve(requests[0]).NativeReference, actual.Catalog.Resolve(requests[1]).NativeReference);
        Assert.Equal(actual.Catalog.Fingerprint, NativeDependencyCatalog.FromJson(actual.Catalog.ToJson()).Fingerprint);
        Assert.Throws<ArgumentException>(() => Read(source, source));
        Assert.Throws<ArgumentException>(() => Read(source with { ProducerBinding = "Missing" }));

        // Same source signature/codec, different business body: a signature-only check would pass.
        var changedFiles = new Dictionary<string, string> { ["Source.cs"] = Source.Replace("value.Count += 1", "value.Count += 2", StringComparison.Ordinal) };
        var changed = (CompilationResult)compile.Invoke(null, [changedFiles])!;
        Assert.True(JsonNode.DeepEquals(compiled.SourceAbis, changed.SourceAbis));
        // Even a fixture claiming that another compiler contract was delivered cannot
        // attach its codec to a native body that does not fulfill that frozen contract.
        var mismatch = Assert.Throws<InvalidOperationException>(() => Read(Export(changedFiles, changed)));
        Assert.Contains("differs from the frozen native model", mismatch.Message);
        // The reader consumes original delivered compiler evidence, not a mutable source dictionary.
        files["Source.cs"] += "\n// later working revision\n";
        Assert.Equal(compiled.SourceHash, Read(source).SourceProofs[0]!["sourceHash"]!.ToString());
        Assert.Equal(producer.SignatureFileSha256, Hash(File.ReadAllBytes(snapshot)));
        File.WriteAllBytes(snapshot, [.. bytes, 0]);
        Assert.Throws<ArgumentException>(() => Read(source));
        File.WriteAllBytes(snapshot, bytes);
        Assert.Equal(producer.SignatureFileSha256, Hash(File.ReadAllBytes(snapshot)));
        File.WriteAllText(Path.Combine(work, "summary.json"), new JsonObject { ["passed"] = true,
            ["sourceHash"] = compiled.SourceHash, ["attachedAliases"] = 3, ["nativeSnapshotSha256"] = producer.SignatureFileSha256,
            ["modelAssertions"] = actual.SourceProofs[0]!["modelProof"]!["count"]!.DeepClone(),
            ["defaultControllerEnabled"] = false, ["publishedBehaviorProved"] = false }.ToJsonString());
    }

    private static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
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
        using Anvil.Authoring;
        public sealed class Node { public int Count { get; set; } public Node? Next { get; set; } }
        public static class Work {
            public static Node Bump(Node value) { value.Count += 1; return value; }
            [ServiceAction] public static Node Echo(Node value) { return value; }
            public static int Plain(int value) { return value + 1; }
        }
        """;
}
