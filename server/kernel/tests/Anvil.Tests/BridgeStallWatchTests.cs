using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class BridgeStallWatchTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AStuckMergeDetectsTheErrorReportWithoutRepeatingTheWrite(bool modal)
    {
        using var server = new FakeBridge();
        server.Windows = () => server.Merged.ElapsedMilliseconds >= 300 ? Dialog(modal: modal) : new JsonArray();
        server.MergeDelayMs = 5000;
        var clock = Stopwatch.StartNew();
        var error = Assert.Throws<BridgeCallException>(() => new BridgeClient(server.Port, probeMs: 100).Call("merge_from_oml"));
        Assert.Null(error.Executed);
        Assert.Equal("dialog", error.Stall!["verdict"]!.ToString());
        Assert.Equal("Unexpected Error", error.Stall["blockedBy"]!["title"]!.ToString());
        Assert.InRange(clock.ElapsedMilliseconds, 300, 1000);
        Assert.Equal(1, server.Count("merge_from_oml"));
        Console.WriteLine($"stall modal={modal}: {clock.ElapsedMilliseconds}ms; pre-probe={server.MergedAtMs}ms; last-probe={server.LastProbeDurationMs}ms");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ASlowMergeWithNoEvidenceOrOnlyProgressReturnsNormally(bool progress)
    {
        using var server = new FakeBridge { MergeDelayMs = 450 };
        server.Windows = () => progress ? Dialog("Publishing… 45%") : new JsonArray();
        var reply = new BridgeClient(server.Port, probeMs: 30).Call("merge_from_oml");
        Assert.True(reply["merged"]!.GetValue<bool>());
        Assert.Equal(1, server.Count("merge_from_oml"));
    }

    [Fact]
    public void AStoppedListenerIsPositiveBridgeGoneEvidence()
    {
        using var server = new FakeBridge { MergeDelayMs = 15000, StopAfterMergeMs = 100 };
        var clock = Stopwatch.StartNew();
        var failure = Record.Exception(() => new BridgeClient(server.Port, probeMs: 100).Call("merge_from_oml"));
        Console.WriteLine($"stopped listener: {clock.ElapsedMilliseconds}ms; {string.Join(", ", server.Timeline)}");
        var error = Assert.IsType<BridgeCallException>(failure);
        Assert.Equal("bridge-gone", error.Stall!["verdict"]!.ToString());
        Assert.Equal(1, server.Count("merge_from_oml"));
    }

    [Fact]
    public void ProbeEofIsNotPositiveEvidenceAndLeavesTheMainReplyAlone()
    {
        using var server = new FakeBridge { MergeDelayMs = 350, CloseProbesAfterMerge = true };
        var clock = Stopwatch.StartNew();
        Assert.True(new BridgeClient(server.Port, probeMs: 100).Call("merge_from_oml")["merged"]!.GetValue<bool>());
        Assert.InRange(clock.ElapsedMilliseconds, 100, 1000);
        Assert.Equal(1, server.Count("merge_from_oml"));
        Assert.True(server.Count("windows") >= 3);
        Console.WriteLine($"EOF probes without positive evidence: {clock.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void RecoveryReadsHaveTheirOwnBoundAndNeverTreatSlowReadsAsIdle()
    {
        using var server = new FakeBridge { RecoveryReadDelayMs = 1500 };
        var bridge = new BridgeClient(server.Port);
        var state = new JsonObject { ["taskId"] = Guid.NewGuid().ToString("N"), ["stalled"] = new JsonObject {
            ["verdict"] = "dialog", ["blockedBy"] = new JsonObject { ["title"] = "Unexpected Error" } } };
        var clock = Stopwatch.StartNew();
        Assert.False(DeliveryTask.InspectPendingUi(state, bridge)["idle"]!.GetValue<bool>());
        Assert.InRange(clock.ElapsedMilliseconds, 400, 1000);
        Assert.Equal(2, server.Count("windows")); Assert.Equal(2, server.Count("ui_alive")); Assert.Equal(2, server.Count("list_open_modules"));
        Assert.NotNull(state["stalled"]!["blockedBy"]);
        Assert.Equal(0, server.Count("merge_from_oml"));
        Console.WriteLine($"two bounded recovery samples against 1500ms reads: {clock.ElapsedMilliseconds}ms");
    }

    [Fact]
    public async Task BoundedProbeReaderRejectsWriteVerbsBeforeConnecting()
    {
        using var server = new FakeBridge();
        await Assert.ThrowsAsync<ArgumentException>(() => ((IBridgeProbeReader)new BridgeClient(server.Port)).ReadProbeAsync("merge_from_oml"));
        Assert.Equal(0, server.Count("merge_from_oml"));
    }

    [Fact]
    public void ADeadStudioPidIsPositiveStudioGoneEvidence()
    {
        using var server = new FakeBridge { MergeDelayMs = 5000, StudioPid = int.MaxValue };
        var error = Assert.Throws<BridgeCallException>(() => new BridgeClient(server.Port, probeMs: 40).Call("merge_from_oml"));
        Assert.Equal("studio-gone", error.Stall!["verdict"]!.ToString());
        Assert.Equal(int.MaxValue, error.Stall["studio"]!["pid"]!.GetValue<int>());
        Assert.Equal(1, server.Count("merge_from_oml"));
    }

    [Fact]
    public void AMalformedInitialStartIdentityCannotBecomeRestartEvidence()
    {
        using var server = new FakeBridge { MergeDelayMs = 450, MalformedInitialStartedUtc = true };
        Assert.True(new BridgeClient(server.Port, probeMs: 50).Call("merge_from_oml")["merged"]!.GetValue<bool>());
        Assert.Equal(1, server.Count("merge_from_oml"));
        Assert.True(server.Count("ping") >= 3);
    }

    [Fact]
    public void PreProbeRefusesBeforeSendingButAnAutoClosingBridgeCanRun()
    {
        using var server = new FakeBridge(); server.Windows = () => Dialog();
        var bridge = new BridgeClient(server.Port, probeMs: 50);
        var error = Assert.Throws<BridgeCallException>(() => bridge.Call("merge_from_oml"));
        Assert.False(error.Executed);
        Assert.Equal("dialog-before", error.Stall!["verdict"]!.ToString());
        Assert.Equal(0, server.Count("merge_from_oml"));
        server.AutoClose = true;
        var fresh = new BridgeClient(server.Port, probeMs: 50);
        Assert.True(fresh.Call("merge_from_oml")["merged"]!.GetValue<bool>());
        Assert.True(fresh.Call("merge_from_oml")["merged"]!.GetValue<bool>());
        Assert.Equal(2, server.Count("bridge_manifest")); // Once per client, never once per write.
    }

    [Fact]
    public void UnsupportedProbesLeaveTheExistingBehaviorUnchanged()
    {
        using var server = new FakeBridge { MergeDelayMs = 350, RejectProbes = true };
        Assert.True(new BridgeClient(server.Port, probeMs: 30).Call("merge_from_oml")["merged"]!.GetValue<bool>());
        Assert.Equal(1, server.Count("merge_from_oml"));
    }

    [Fact]
    public void ASlowProbeCannotDelayACompletedMainReply()
    {
        using var server = new FakeBridge { MergeDelayMs = 180, ProbeDelayAfterMergeMs = 800 };
        var clock = Stopwatch.StartNew();
        Assert.True(new BridgeClient(server.Port, probeMs: 50).Call("merge_from_oml")["merged"]!.GetValue<bool>());
        Assert.True(server.Count("windows") >= 2);
        Assert.InRange(clock.ElapsedMilliseconds, 120, 500);
        Console.WriteLine($"main reply during 800ms probe: {clock.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void ZeroEnvironmentIntervalDisablesAllProbes()
    {
        var previous = Environment.GetEnvironmentVariable("ANVIL_BRIDGE_PROBE_MS");
        try
        {
            Environment.SetEnvironmentVariable("ANVIL_BRIDGE_PROBE_MS", "0");
            using var server = new FakeBridge { MergeDelayMs = 120 }; server.Windows = () => Dialog();
            Assert.True(new BridgeClient(server.Port).Call("merge_from_oml")["merged"]!.GetValue<bool>());
            Assert.Equal(0, server.Count("windows")); Assert.Equal(0, server.Count("ping")); Assert.Equal(0, server.Count("bridge_manifest"));
        }
        finally { Environment.SetEnvironmentVariable("ANVIL_BRIDGE_PROBE_MS", previous); }
    }

    private static JsonArray Dialog(string title = "Unexpected Error", bool modal = true) => new(new JsonObject {
        ["title"] = title, ["type"] = "DialogWindow", ["isVisible"] = true, ["isModal"] = modal });

    private sealed class FakeBridge : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new();
        private readonly string? previousAuthority = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        private readonly ConcurrentDictionary<string, int> seen = new();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        public int Port { get; }
        public int MergeDelayMs, StopAfterMergeMs;
        public int ProbeDelayAfterMergeMs;
        public int RecoveryReadDelayMs;
        public int StudioPid = Environment.ProcessId;
        public bool AutoClose, RejectProbes;
        public bool MalformedInitialStartedUtc;
        public bool CloseProbesAfterMerge;
        public readonly ConcurrentQueue<string> Timeline = new();
        public Func<JsonArray> Windows = () => new();
        public Stopwatch Merged = new();
        public long MergedAtMs;
        public long LastProbeDurationMs;
        public int Count(string method) => seen.GetValueOrDefault(method);
        public FakeBridge()
        {
            Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Path.GetTempPath(), "cx14-client-" + Guid.NewGuid().ToString("N")));
            listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            _ = Task.Run(async () => {
                while (!stop.IsCancellationRequested)
                {
                    TcpClient client;
                    try { client = await listener.AcceptTcpClientAsync(stop.Token); }
                    catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException) { return; }
                    _ = Handle(client);
                }
            });
        }
        private async Task Handle(TcpClient client)
        {
            using (client)
            try
            {
                var stream = client.GetStream();
                var line = await new StreamReader(stream, new UTF8Encoding(false)).ReadLineAsync(stop.Token);
                var method = JsonNode.Parse(line!)!["method"]!.ToString(); seen.AddOrUpdate(method, 1, (_, n) => n + 1);
                Timeline.Enqueue($"{method}@{clock.ElapsedMilliseconds}");
                if (CloseProbesAfterMerge && Merged.IsRunning && method is "windows" or "ping")
                {
                    Timeline.Enqueue($"probe-eof:{method}@{clock.ElapsedMilliseconds}"); return;
                }
                var responseClock = Stopwatch.StartNew();
                if (RecoveryReadDelayMs > 0 && method is "windows" or "ui_alive" or "list_open_modules") await Task.Delay(RecoveryReadDelayMs, stop.Token);
                if (method != "merge_from_oml" && Merged.IsRunning && ProbeDelayAfterMergeMs > 0) await Task.Delay(ProbeDelayAfterMergeMs, stop.Token);
                JsonObject data;
                switch (method)
                {
                    case "merge_from_oml":
                        MergedAtMs = clock.ElapsedMilliseconds; Merged.Restart();
                        if (StopAfterMergeMs > 0) _ = Task.Run(async () => { await Task.Delay(StopAfterMergeMs, stop.Token); Timeline.Enqueue($"listener-stop@{clock.ElapsedMilliseconds}"); listener.Stop(); });
                        await Task.Delay(MergeDelayMs, stop.Token); data = new() { ["merged"] = true }; break;
                    case "windows": data = new() { ["windows"] = Windows() }; break;
                    case "ping": data = new() { ["pid"] = StudioPid, ["startedUtc"] = MalformedInitialStartedUtc && Count("ping") == 1
                        ? JsonValue.Create(123) : JsonValue.Create("2026-10-14T00:00:00Z") }; break;
                    case "bridge_manifest": data = new() { ["capabilities"] = AutoClose ? new JsonArray("dialogs:error_report_auto") : new JsonArray() }; break;
                    case "ui_alive": data = new() { ["alive"] = true }; break;
                    case "list_open_modules": data = new() { ["modules"] = new JsonArray() }; break;
                    default: throw new InvalidOperationException(method);
                }
                var reply = RejectProbes && method is "windows" or "bridge_manifest"
                    ? new JsonObject { ["success"] = false, ["executed"] = false, ["error"] = "Unsupported verb" }
                    : new JsonObject { ["success"] = true, ["data"] = data };
                await stream.WriteAsync(Encoding.UTF8.GetBytes(reply.ToJsonString() + "\n"), stop.Token);
                if (method == "windows") LastProbeDurationMs = responseClock.ElapsedMilliseconds;
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException) { }
        }
        public void Dispose()
        {
            stop.Cancel(); listener.Stop();
            Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(previousAuthority));
        }
    }
}
