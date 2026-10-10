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

namespace Anvil.Tests
{
    public sealed class NativeCSharpSourceCallTests
    {
        [Fact]
        public void PublicApiCannotPromoteAnUnverifiedCatalog()
        {
            Assert.Empty(typeof(NativeCSharpSourceReadResult).GetConstructors());
            Assert.True(typeof(NativeCSharpSourceReadResult).IsSealed);
            Assert.All(typeof(NativeCSharpSourceReadResult).GetProperties(), property => Assert.Null(property.SetMethod));
            var factory = Assert.Single(typeof(NativeCSharpSourceCall).GetMethods(BindingFlags.Public | BindingFlags.Static));
            Assert.Equal(typeof(NativeCSharpSourceReadResult), factory.GetParameters()[0].ParameterType);
        }

        [Fact]
        public void ReaderCreatedPortableCatalogSuppliesExactCallsAndPreservesCallerIdentityOnCompletion()
        {
            StudioAssemblies.Bind(); Run();
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Run()
        {
            var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeCSharpSourceCallTests).Assembly.Location)!)!;
            var work = Path.Combine(root, ".local/data-logic-translator/native-source-call-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work); var host = new ModelHost(work);
            var files = new Dictionary<string, string> { ["Source.cs"] = Source };
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
            NativeDependencyRequirement Requirement(string symbol, string name) => new(symbol, NativeDependencyKind.ServerAction, producer.ProducerName, name);
            var requests = new[] { Requirement("caller::mutate", "Mutate"), Requirement("caller::alias", "Mutate"),
                Requirement("caller::fail", "Fail"), Requirement("caller::plain", "Plain") };
            var paths = new Dictionary<string, string> { [producer.Binding] = snapshot };
            var bundle = new JsonObject { ["files"] = new JsonObject { ["Source.cs"] = Source } };
            var frozen = FrozenCSharpCompilation.Capture(bundle, compiled, FrozenCSharpCompilation.GraphProfile,
                producer.Environment, producer.ProducerKey, null);
            var source = new NativeCSharpProducerSource(producer.Binding,
                CSharpProducerExportFixture.WriteReceipt(frozen, null, snapshot, Path.Combine(work, "export")));
            var verified = NativeCSharpSourceReader.Read(host, requests, [producer], paths, [source]);
            var catalogFile = Path.Combine(work, "catalog.json");
            File.WriteAllText(catalogFile, verified.Catalog.ToJson().ToJsonString());
            var persisted = NativeDependencyCatalog.FromJson(JsonNode.Parse(File.ReadAllText(catalogFile))!.AsObject());
            Assert.Equal(verified.Catalog.Fingerprint, persisted.Fingerprint);
            // The result's constructor crosses the same portable catalog representation.
            // JSON alone is deliberately not accepted by the caller factory as proof.
            Assert.Equal(persisted.Resolve(requests[0]).NativeReference, verified.Catalog.Resolve(requests[0]).NativeReference);
            var assembly = typeof(SourceCall.Node).Assembly;
            var first = NativeCSharpSourceCall.Create(verified, requests[0], assembly);
            var alias = NativeCSharpSourceCall.Create(verified, requests[1], assembly);
            var node = new SourceCall.Node { Count = 4 }; node.Next = node;
            var transports = new List<string>();
            // This recording peer proves caller transport/reconciliation, not O11 execution.
            JsonObject Reply(string action, JsonObject request, int increment, bool failure = false)
            {
                transports.Add(action);
                var graph = request["AvGraphIn"]!.DeepClone().AsObject();
                var cell = Assert.Single(Assert.Single(graph).Value!.AsArray())!.AsObject();
                cell["Count"] = cell["Count"]!.GetValue<int>() + increment;
                return new JsonObject { ["AvGraphOut"] = graph, ["AvResult"] = new JsonObject { ["Index"] = 1 },
                    ["AvCompletion"] = new JsonObject { ["Kind"] = failure ? 2 : 1, ["ExceptionRef"] = failure ? 1 : 0 },
                    ["AvErrors"] = failure ? new JsonArray(new JsonObject { ["TypeName"] = "System.InvalidOperationException",
                        ["Message"] = "after mutation", ["InnerRef"] = 0 }) : new JsonArray() };
            }
            JsonObject Mutate(string action, JsonObject request)
            {
                Assert.True(JsonNode.DeepEquals(request["Arg_left"], request["Arg_right"]));
                return Reply(action, request, 3);
            }
            Assert.Same(node, first.Invoke([node, node], Mutate));
            Assert.Equal(7, node.Count); Assert.Same(node, node.Next);
            Assert.Same(node, alias.Invoke([node, node], Mutate));
            Assert.Equal(10, node.Count); Assert.Equal(transports[0], transports[1]);
            Assert.Equal(persisted.Resolve(requests[0]).NativeReference, transports[0]);
            var fail = NativeCSharpSourceCall.Create(verified, requests[2], assembly);
            var error = Assert.Throws<InvalidOperationException>(() => fail.Invoke([node], (action, request) => Reply(action, request, 7, true)));
            Assert.Equal("after mutation", error.Message); Assert.Equal(17, node.Count); Assert.Same(node, node.Next);
            Assert.Equal(persisted.Resolve(requests[2]).NativeReference, transports[2]);

            var count = transports.Count;
            Assert.Throws<NotSupportedException>(() => NativeCSharpSourceCall.Create(verified, requests[3], assembly).Invoke([1], Mutate));
            Assert.Throws<ArgumentException>(() => NativeCSharpSourceCall.Create(verified,
                requests[0] with { OriginalElementPath = "Fail" }, assembly).Invoke([node], Mutate));
            Assert.Throws<InvalidDataException>(() => NativeCSharpSourceCall.Create(verified, requests[0], typeof(string).Assembly).Invoke([node], Mutate));
            var noSource = NativeCSharpSourceReader.Read(host, requests, [producer], paths, []);
            Assert.Throws<NotSupportedException>(() => NativeCSharpSourceCall.Create(noSource, requests[0], assembly).Invoke([node], Mutate));
            foreach (var mode in new[] { "unknown-id", "unknown-version", "invalid-payload" })
            {
                // Simulate a future controller/reader codec; reflection is test-only and
                // demonstrates no public construction/deserialization bypass exists.
                var bindings = verified.Catalog.Bindings.Select(binding => {
                    if (binding.Requirement.OriginalElementPath != "Mutate") return binding;
                    var payload = binding.SourceAbi!.Payload;
                    if (mode == "invalid-payload") payload["version"] = 99;
                    return binding with { SourceAbi = new NativeSourceAbi(mode == "unknown-id" ? "unknown" : binding.SourceAbi.Id,
                        mode == "unknown-version" ? 99 : binding.SourceAbi.Version, payload) };
                });
                var futureCatalog = new NativeDependencyCatalog(verified.Catalog.Producers, bindings);
                var constructor = typeof(NativeCSharpSourceReadResult).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single();
                var future = (NativeCSharpSourceReadResult)constructor.Invoke([futureCatalog, verified.SourceProofs]);
                if (mode == "invalid-payload") Assert.Throws<InvalidDataException>(() => NativeCSharpSourceCall.Create(future, requests[0], assembly).Invoke([node], Mutate));
                else Assert.Throws<NotSupportedException>(() => NativeCSharpSourceCall.Create(future, requests[0], assembly).Invoke([node], Mutate));
            }
            Assert.Equal(count, transports.Count);
            var proofs = verified.SourceProofs; proofs[0]!["modelProof"]!["accepted"] = false; proofs.Clear();
            Assert.True(verified.SourceProofs[0]!["modelProof"]!["accepted"]!.GetValue<bool>());
            var exported = verified.Catalog.ToJson(); exported.Clear();
            Assert.Equal(persisted.Fingerprint, verified.Catalog.Fingerprint);
            File.WriteAllText(Path.Combine(work, "source-proof.json"), verified.SourceProofs.ToJsonString());
            File.WriteAllText(Path.Combine(work, "summary.json"), new JsonObject { ["passed"] = true,
                ["catalogFingerprint"] = verified.Catalog.Fingerprint, ["nativeSnapshotSha256"] = Hash(bytes),
                ["recordedCalls"] = transports.Count, ["callerCountAfterException"] = node.Count,
                ["nativeModelProved"] = true, ["managedCallerTransportProved"] = true,
                ["nativeActionExecutionProved"] = false, ["defaultControllerEnabled"] = false }.ToJsonString());
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
            namespace Anvil.Tests.SourceCall;
            public sealed class Node { public int Count; public Node? Next; }
            public static class Work {
                public static Node Mutate(Node left, Node right) { left.Count += 1; right.Count += 2; return left; }
                public static Node Fail(Node value) { value.Count += 7; throw new System.InvalidOperationException("after mutation"); }
                public static int Plain(int value) => value + 1;
            }
            """;
    }
}

namespace Anvil.Tests.SourceCall
{
    // Ordinary caller objects already loaded in the test assembly. Neither the factory
    // nor this test needs to compile/load/execute a source assembly for binding.
    public sealed class Node { public int Count; public Node? Next; }
}
