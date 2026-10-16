using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
namespace Anvil.Tests;

public sealed class SnapshotRegistryTests
{
    [Fact] public void ProvenanceUsesModuleAndBytesRatherThanPath()
    {
        var registry = new SnapshotRegistry();
        var snapshot = registry.Register("module-A", new byte[] {1,2,3}, Array.Empty<MessageInfo>());
        Assert.Equal(snapshot, registry.RequireBase("module-A", new byte[] {1,2,3}, "moved.oml"));
        Assert.Throws<InvalidOperationException>(() => registry.RequireBase("module-B", new byte[] {1,2,3}, "original.oml"));
        Assert.Throws<InvalidOperationException>(() => registry.RequireBase("module-A", new byte[] {1,2,4}, "original.oml"));
        Assert.Throws<InvalidOperationException>(() => registry.RequireBase("module-A", null, null));
    }
    [Fact] public void SinceCannotCrossModuleOrSession()
    {
        var registry = new SnapshotRegistry(); var snapshot = registry.Register("module-A", new byte[] {1}, Array.Empty<MessageInfo>());
        Assert.Same(snapshot, registry.RequireSince("module-A", snapshot.Id));
        Assert.Throws<InvalidOperationException>(() => registry.RequireSince("module-B", snapshot.Id));
        Assert.Throws<InvalidOperationException>(() => new SnapshotRegistry().RequireSince("module-A", snapshot.Id));
    }
    [Fact] public void ForeignIdentityMustMatchExactly()
    {
        SnapshotRegistry.RequireForeignIdentity("AbC", "AbC");
        Assert.Throws<InvalidOperationException>(() => SnapshotRegistry.RequireForeignIdentity("AbC", "abc"));
    }
}

public sealed class DeliveryTests
{
    [Theory]
    [InlineData("success", true, 1)]
    [InlineData("unchanged", true, 1)]
    [InlineData("blocked", false, 0)]
    [InlineData("wrong-active", false, 0)]
    [InlineData("wrong-snapshot", false, 0)]
    [InlineData("legacy-bridge", false, 0)]
    [InlineData("invalid-apply", false, 0)]
    [InlineData("conflicts", false, 1)]
    [InlineData("new-error", false, 1)]
    [InlineData("new-warning", true, 1)] // A03 (atritos 2): a new warning blocks nothing; it comes back in result.warnings
    [InlineData("missing-check", false, 1)]
    [InlineData("soap-lab", false, 0)] // CompileCheck: a lab that builds a SOAP client by verbs (allowSoapWithoutImport) is never delivered
    public void FullWorkflowUsesOneMergeAndStopsAtTheFailingStage(string scenario, bool delivered, int merges)
    {
        var root = Path.GetDirectoryName(typeof(DeliveryTests).Assembly.Location);
        while (root != null && !File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root);
        var work = Path.Combine(root!, ".local", "delivery-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"base\":\"blank-service.oml\",\"ops\":[]}");
        using var server = new FakeBridge((method, p) => method switch
        {
            "open_module" => scenario == "blocked" ? new() { ["opened"] = false, ["blockedBy"] = new JsonArray("ManageDependencies") } : new() { ["opened"] = true },
            "get_active_module" => new() { ["name"] = scenario == "wrong-active" ? "Other" : "Probe", ["key"] = "module-A" },
            "snapshot_module" => Snapshot(p!, scenario),
            "merge_from_oml" => Merge(p!, scenario),
            "get_errors" => Delta(p!, scenario),
            "find_element" => new() { ["query"] = p!["name"]!.ToString(), ["count"] = scenario == "missing-check" ? 0 : 1 },
            // wrong-active: a bridge whose calls do not target module_key, so another selected tab still stops the delivery.
            "bridge_manifest" when scenario == "wrong-active" => new() { ["capabilities"] = new JsonArray() },
            _ => throw new InvalidOperationException("Unexpected bridge operation: " + method)
        });
        var result = Anvil.Core.Delivery.Delivery.Run(new BridgeClient(server.Port, 10), new("Probe", job, work, new[] { "Requested" }),
            (basePath, jobPath, output) =>
            {
                Assert.Equal("snapshot", File.ReadAllText(basePath)); Assert.Equal(job, jobPath);
                File.WriteAllText(output, "foreign");
                var applied = new JsonObject { ["isValid"] = scenario != "invalid-apply", ["accepted"] = scenario != "invalid-apply" };
                if (scenario == "soap-lab") applied["highWarnings"] = new JsonArray(new JsonObject { ["code"] = CompileCheck.SoapAllowed, ["severity"] = "high", ["message"] = "lab" });
                return applied;
            });
        Assert.Equal(delivered, result["delivered"]!.GetValue<bool>());
        Assert.Equal(merges, server.Calls.Count(c => c == "merge_from_oml"));
        Assert.DoesNotContain("publish", server.Calls);
        Assert.True(File.Exists(Path.Combine(result["work"]!.ToString(), "result.json")));
        if (scenario is "new-error") Assert.Contains("kept for review", result["error"]!.ToString());
        if (scenario is "soap-lab") Assert.Contains("never delivered", result["error"]!.ToString());
        if (scenario is "new-warning")
        {
            var warning = Assert.Single(result["warnings"]!.AsArray())!;
            Assert.Equal("UnusedUserAction", warning["id"]!.ToString());
            Assert.Equal("Probe (ESpace) / A (ClientAction)", warning["path"]!.ToString());
            Assert.False(string.IsNullOrWhiteSpace(warning["fix"]?.ToString()));
        }
    }
    [Fact]
    public void ProofOnlyJobsAreRefusedBeforeAnyTaskOrBridgeCall()
    {
        var root = Path.GetDirectoryName(typeof(DeliveryTests).Assembly.Location);
        while (root != null && !File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Path.GetDirectoryName(root);
        var work = Path.Combine(root!, ".local", "delivery-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var proofs = Path.Combine(root!, "tests", "jobs-live", "hmisjha-k1-dependencies");
        var committed = Directory.GetFiles(proofs, "*.json");
        Assert.Equal(2, committed.Length);
        // A copy outside the proof folder, even without the job's own description, is still refused by the marker its
        // probe action carries.
        var copy = Path.Combine(work, "copied-probe.json");
        var copied = JsonNode.Parse(File.ReadAllText(Path.Combine(proofs, "k1-offline-system-core.json")))!.AsObject();
        Assert.Contains(NonDeliverableJobs.Marker, copied["description"]!.ToString());
        copied.Remove("description"); File.WriteAllText(copy, copied.ToJsonString());
        var topLevel = Path.Combine(work, "top-level.json");
        File.WriteAllText(topLevel, "{\"description\":\"Scratch proof, NEVER DELIVER.\",\"base\":\"blank-service.oml\",\"ops\":[]}");
        var setDescription = Path.Combine(work, "set-description.json");
        File.WriteAllText(setDescription, "{\"base\":\"blank-service.oml\",\"ops\":[{\"op\":\"create\",\"parent\":\"@espace\",\"type\":\"ITimer\",\"name\":\"T\",\"as\":\"$t\"}," +
            "{\"op\":\"set\",\"target\":\"$t\",\"prop\":\"Description\",\"value\":\"Scratch only. NEVER DELIVER\"}]}");
        // The folder rule holds in any checkout, even without the marker.
        var otherCheckout = Path.Combine(work, "tests", "jobs-live", "hmisjha-k1-dependencies", "sub"); Directory.CreateDirectory(otherCheckout);
        var unmarkedInFolder = Path.Combine(otherCheckout, "plain.json");
        File.WriteAllText(unmarkedInFolder, "{\"description\":\"plain\",\"base\":\"blank-service.oml\",\"ops\":[]}");
        // A composite wrapper outside the proof folder does not launder a proof job or a marked part.
        var wrappedProof = Path.Combine(work, "wrapped-proof.json");
        File.WriteAllText(wrappedProof, new JsonObject { ["description"] = "wrapper", ["jobs"] = new JsonArray(committed[0]) }.ToJsonString());
        var wrappedMarked = Path.Combine(work, "wrapped-marked.json");
        File.WriteAllText(wrappedMarked, new JsonObject { ["description"] = "wrapper", ["jobs"] = new JsonArray("top-level.json") }.ToJsonString());
        var bridge = new RecordingBridge();
        foreach (var job in committed.Append(copy).Append(topLevel).Append(setDescription).Append(unmarkedInFolder).Append(wrappedProof).Append(wrappedMarked))
        {
            var refused = Assert.Throws<InvalidOperationException>(() => Anvil.Core.Delivery.Delivery.Run(bridge, new("HMISJHA_CS", job, work, Array.Empty<string>()),
                (_, _, _) => throw new InvalidOperationException("apply must not run")));
            Assert.StartsWith("deliver refuses", refused.Message);
            Assert.Contains(job.StartsWith(proofs, StringComparison.OrdinalIgnoreCase) || job == unmarkedInFolder || job == wrappedProof ? "hmisjha-k1-dependencies" : NonDeliverableJobs.Marker, refused.Message);
            if (job == wrappedProof || job == wrappedMarked) Assert.Contains("(read by '" + job + "')", refused.Message);
        }
        Assert.Empty(bridge.Calls);
        Assert.False(Directory.Exists(Path.Combine(work, "deliver")));
        Assert.Equal("$.ops[2].data.actions[0].description", NonDeliverableJobs.MarkedDescription(copy));
        Assert.All(committed, job => Assert.Equal("$.description", NonDeliverableJobs.MarkedDescription(job)));
        Assert.Equal("$.ops[1].value", NonDeliverableJobs.MarkedDescription(setDescription));
        // Ordinary jobs, prose that is not the marker, and a same-named folder elsewhere pass the rule.
        var prose = Path.Combine(work, "hmisjha-k1-dependencies", "prose.json"); Directory.CreateDirectory(Path.GetDirectoryName(prose)!);
        File.WriteAllText(prose, "{\"description\":\"This timer will never deliver mail.\",\"base\":\"blank-service.oml\",\"ops\":[]}");
        NonDeliverableJobs.Require(prose);
        NonDeliverableJobs.Require(Path.Combine(root!, "tests", "jobs", "consume-reference.json"));
        NonDeliverableJobs.Require(Path.Combine(work, "missing.json"));
    }
    private sealed class RecordingBridge : IBridgeClient
    {
        public List<string> Calls { get; } = new();
        public JsonObject Call(string method, JsonObject? parameters = null) { Calls.Add(method); throw new InvalidOperationException("bridge must not be called"); }
    }
    private static JsonObject Snapshot(JsonObject p, string scenario)
    {
        Assert.True(Path.IsPathFullyQualified(p["path"]!.ToString())); File.WriteAllText(p["path"]!.ToString(), "snapshot");
        var result = new JsonObject { ["key"] = scenario == "wrong-snapshot" ? "module-B" : "module-A" };
        if (scenario != "legacy-bridge") result["snapshot_id"] = "snapshot-A";
        return result;
    }
    private static JsonObject Merge(JsonObject p, string scenario)
    {
        Assert.Equal("auto", p["mode"]!.ToString()); Assert.Equal("foreign", File.ReadAllText(p["foreign_path"]!.ToString()));
        Assert.Equal("snapshot", File.ReadAllText(p["base_path"]!.ToString()));
        return new JsonObject { ["merged"] = scenario is not ("conflicts" or "unchanged"),
            ["reason"] = scenario == "conflicts" ? "conflicts" : scenario == "unchanged" ? "no differences" : null,
            ["newErrors"] = scenario == "new-error" ? 1 : 0 };
    }
    private static JsonObject Delta(JsonObject p, string scenario)
    {
        Assert.Equal("snapshot-A", p["since"]!.ToString());
        var messages = scenario is "new-error" or "new-warning" ? new[] { new MessageInfo("UnusedUserAction", scenario == "new-error" ? "Error" : "Warning", "key", "Probe (ESpace) / A (ClientAction)", "Unexpected") } : Array.Empty<MessageInfo>();
        return new JsonObject { ["newErrors"] = scenario == "new-error" ? 1 : 0, ["new"] = JsonSerializer.SerializeToNode(messages), ["fixed"] = new JsonArray(), ["preexisting"] = new JsonArray() };
    }
    private sealed class FakeBridge : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly Task serving;
        public ConcurrentQueue<string> Calls { get; } = new();
        public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
        public FakeBridge(Func<string, JsonObject?, JsonObject> respond)
        {
            listener.Start();
            serving = Task.Run(async () =>
            {
                try
                {
                    while (!stop.IsCancellationRequested)
                    {
                        using var client = await listener.AcceptTcpClientAsync(stop.Token);
                        using var stream = client.GetStream(); using var reader = new StreamReader(stream, new UTF8Encoding(false));
                        using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
                        var request = JsonNode.Parse((await reader.ReadLineAsync(stop.Token))!)!;
                        var method = request["method"]!.ToString(); Calls.Enqueue(method);
                        JsonObject reply;
                        try { reply = new JsonObject { ["success"] = true, ["data"] = respond(method, request["params"]?.AsObject()) }; }
                        // An older fake may not implement optional probes. Refuse them through the protocol without
                        // terminating its accept loop; every original operation and assertion still uses respond above.
                        catch (InvalidOperationException ex) when (method is "windows" or "ping" or "bridge_manifest")
                        { reply = new JsonObject { ["success"] = false, ["executed"] = false, ["error"] = ex.Message }; }
                        await writer.WriteLineAsync(reply.ToJsonString());
                    }
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
                catch (SocketException) when (stop.IsCancellationRequested) { }
            });
        }
        public void Dispose() { stop.Cancel(); listener.Stop(); serving.GetAwaiter().GetResult(); stop.Dispose(); }
    }
}
