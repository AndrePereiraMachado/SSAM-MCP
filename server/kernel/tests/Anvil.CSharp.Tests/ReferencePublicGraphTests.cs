using System.Reflection;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Anvil.CSharp.Tests;

// Executes the actual emitted graph entry and its original translated business body,
// with native copy semantics in the probe. ANVIL_GRAPH_LIVE_MANIFEST routes the same
// assertions through verified, published personal-lab modules instead.
public class ReferencePublicGraphTests
{
    [Fact]
    public void RecordEchoRetainsTheOriginalCallerIdentity()
    {
        using var call = new Call("public sealed record R(int Value); public static class Rules { public static R Echo(R value) => value; }", "Echo");
        var input = call.New("R", 7); Assert.Same(input, call.Invoke(input)); Assert.Equal(1, call.Invocations);
    }
    [Fact]
    public void NullIsNotInferredFromNonnullableReferenceAnnotations()
    {
        using var call = new Call("public sealed record R(int Value); public static class Rules { public static bool IsNull(R value) => value == null; }", "IsNull");
        Assert.Equal(true, call.Invoke(new object?[] { null })); Assert.Equal(false, call.Invoke(call.New("R", 0)));
    }
    [Fact]
    public void ListEchoRetainsNullEmptyAndExistingIdentity()
    {
        using var call = new Call("public static class Rules { public static List<int> Echo(List<int> value) => value; }", "Echo");
        var list = new List<int> { 1, 2 }; Assert.Same(list, call.Invoke(list));
        var empty = new List<int>(); Assert.Same(empty, call.Invoke(empty)); Assert.Null(call.Invoke(new object?[] { null }));
    }
    [Fact]
    public void SharedRecordMembersKeepTheirCommonIdentity()
    {
        using var call = new Call("public sealed record Leaf(int Value); public sealed record Pair(Leaf Left, Leaf Right); public static class Rules { public static Pair Echo(Pair value) => value; }", "Echo");
        var leaf = call.New("Leaf", 3); var pair = call.New("Pair", leaf, leaf); var result = call.Invoke(pair)!;
        Assert.Same(pair, result); Assert.Same(call.Member(result, "Left"), call.Member(result, "Right"));
    }
    [Fact]
    public void SelfCycleCrossesAFiniteNativeGraphBoundary()
    {
        using var call = new Call("public sealed class Node { public Node? Next { get; set; } } public static class Rules { public static Node Echo(Node value) => value; }", "Echo");
        var node = call.New("Node"); node.GetType().GetProperty("Next")!.SetValue(node, node);
        var result = call.Invoke(node)!; Assert.Same(node, result); Assert.Same(node, call.Member(result, "Next"));
    }
    [Fact]
    public void MutationBeforeThrowCrossesThePublicEntryAndUpdatesTheCaller()
    {
        using var call = new Call("public sealed class Cell { public int Value { get; set; } } public static class Rules { public static void Mutate(Cell value) { value.Value++; throw new InvalidOperationException(\"failed\"); } }", "Mutate");
        var cell = call.New("Cell"); var error = Assert.Throws<InvalidOperationException>(() => call.Invoke(cell));
        Assert.Equal("failed", error.Message); Assert.Equal(1, call.Member(cell, "Value"));
    }

    internal sealed class Call : IDisposable
    {
        private readonly AssemblyLoadContext context = new("native-graph-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        private readonly ReferenceCallerBinding binding;
        private readonly ReferenceGraphProbe probe;
        private readonly string action;
        private readonly JsonObject? liveCase;
        private readonly string? liveRoot;
        internal int Invocations { get; private set; }
        internal JsonObject? LastResponse { get; private set; }
        internal Func<JsonObject, IReadOnlyDictionary<string, object>, Dictionary<string, object>>? DataEffect { set => probe.DataEffect = value; }
        internal Call(string source, string methodName, bool shareNativeListStorage = false)
        {
            var files = new Dictionary<string, string> { ["PublicGraph.cs"] = source };
            var program = SourceProgram.Parse(files); var method = program.Types.Single(t => t.Name == "Rules").GetMembers(methodName).OfType<IMethodSymbol>().Single();
            using var stream = new MemoryStream(); var result = program.Compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics)); stream.Position = 0; assembly = context.LoadFromStream(stream);
            var compiled = CSharpCompiler.CompileReferenceGraph(files);
            if (Environment.GetEnvironmentVariable("ANVIL_GRAPH_PROOF_INPUTS") is { Length: > 0 } proofRoot)
            {
                var folder = Path.Combine(proofRoot, compiled.SourceHash); Directory.CreateDirectory(folder);
                File.WriteAllText(Path.Combine(folder, "source.cs"), source);
                File.WriteAllText(Path.Combine(folder, "contract.json"), compiled.Specification.ToJsonString());
                File.WriteAllText(Path.Combine(folder, "source-map.json"), compiled.SourceMap.ToJsonString());
                File.WriteAllText(Path.Combine(folder, "source-abis.json"), compiled.SourceAbis!.ToJsonString());
                File.WriteAllText(Path.Combine(folder, "source-hash.txt"), compiled.SourceHash);
            }
            action = compiled.SourceMap.Single(m => m?["source"]?.ToString() == method.ToDisplayString())!["native"]!.ToString();
            // A real consumer receives the compiler-produced descriptor. Roundtrip it
            // through JSON; no source analysis supplies fields or graph bindings here.
            var abi = compiled.SourceAbis!.Single(a => a!["native"]!.ToString() == action)!["abi"]!.AsObject();
            binding = new(JsonNode.Parse(abi.ToJsonString())!.AsObject(), assembly);
            if (Environment.GetEnvironmentVariable("ANVIL_GRAPH_LIVE_MANIFEST") is { Length: > 0 } liveManifest)
            {
                liveRoot = Path.GetDirectoryName(Path.GetFullPath(liveManifest))!;
                var manifest = JsonNode.Parse(File.ReadAllText(liveManifest))!.AsObject();
                Assert.Equal("personal-2qqw9srv.outsystemscloud.com", manifest["host"]!.ToString());
                Assert.Equal("ZZReferenceGraphLab", manifest["application"]!.ToString());
                liveCase = manifest["cases"]!.AsArray().Select(c => c!.AsObject()).Single(c => c["sourceHash"]!.ToString() == compiled.SourceHash);
                Assert.True(liveCase["delivered"]!.GetValue<bool>()); Assert.Equal(action, liveCase["action"]!.ToString());
                Assert.Matches("^ZZ(?:Graph|List)[A-Za-z]+_CS$", liveCase["module"]!.ToString());
                var compiledHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(compiled.Specification.ToJsonString())));
                Assert.Equal(liveCase["contractSha256"]!.ToString().ToUpperInvariant(), compiledHash);
                var publication = JsonNode.Parse(File.ReadAllText(manifest["publicationPath"]?.ToString()
                    ?? Path.Combine(liveRoot, "publication", "publication.json")))!.AsObject();
                Assert.True(publication["ok"]!.GetValue<bool>());
                var outcome = publication["cases"]!.AsArray().Single(c => c!["module"]!.ToString() == liveCase["module"]!.ToString())!["publication"]!["Outcome"]!;
                Assert.True(outcome["Completed"]!.GetValue<bool>()); Assert.False(outcome["HasErrors"]!.GetValue<bool>()); Assert.True(outcome["VersionId"]!.GetValue<int>() > 0);
            }
            probe = new(compiled.Specification, shareNativeListStorage);
            Assert.Contains(compiled.Specification["logic"]!["actions"]!.AsArray(), n => n!["name"]!.ToString() == action && n["inputs"]!.AsArray().Any(p => p!["name"]!.ToString() == "AvGraphIn"));
        }
        internal object New(string type, params object?[] values) => Activator.CreateInstance(assembly.GetType(type)!, values)!;
        internal object? Member(object value, string name) => value.GetType().GetProperty(name)!.GetValue(value);
        internal object? Invoke(params object?[] arguments) => binding.Invoke(action, arguments, (name, request) => {
            Invocations++;
            if (liveCase != null) return LastResponse = Remote(request);
            var response = probe.Run(name, request.ToDictionary(p => p.Key, p => Native(p.Value), StringComparer.Ordinal));
            return LastResponse = JsonNode.Parse(JsonSerializer.Serialize(response))!.AsObject();
        });
        private JsonObject Remote(JsonObject request)
        {
            var expectedPath = "/" + liveCase!["module"] + "/rest/CSharpLab/InvokeGraph";
            Assert.Equal(expectedPath, liveCase["path"]!.ToString());
            var secretPath = Path.Combine(Path.GetDirectoryName(liveCase["job"]!.ToString())!, "secrets.json");
            var key = JsonNode.Parse(File.ReadAllText(secretPath))!["key"]!.ToString();
            using var handler = new HttpClientHandler { AllowAutoRedirect = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(90) };
            using var message = new HttpRequestMessage(HttpMethod.Post, "https://personal-2qqw9srv.outsystemscloud.com" + expectedPath);
            message.Headers.Add("LabKey", key); message.Content = new StringContent(request.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = client.Send(message); var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            var directory = Path.Combine(liveRoot!, "execution", liveCase["case"]!.ToString()); Directory.CreateDirectory(directory);
            var receipt = new JsonObject { ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["module"] = liveCase["module"]!.DeepClone(),
                ["sourceHash"] = liveCase["sourceHash"]!.DeepClone(), ["status"] = (int)response.StatusCode,
                ["request"] = request.DeepClone(), ["body"] = body.Replace(key, "[redacted]", StringComparison.Ordinal) };
            File.WriteAllText(Path.Combine(directory, Guid.NewGuid().ToString("N") + ".json"), receipt.ToJsonString());
            Assert.True(response.IsSuccessStatusCode, "Published graph request failed with HTTP " + (int)response.StatusCode + "; see redacted receipt.");
            return JsonNode.Parse(body)!.AsObject();
        }
        private static object Native(JsonNode? node) => node switch {
            JsonObject obj => obj.ToDictionary(p => p.Key, p => Native(p.Value), StringComparer.Ordinal),
            JsonArray list => list.Select(Native).ToList(),
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            JsonValue value => decimal.Parse(value.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture),
            _ => throw new InvalidOperationException("Native graph fields must use explicit presence, not CLR null.") };
        public void Dispose() => context.Unload();
    }
}
