using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 R1: a pre-probe refusal (nothing sent) never rewrites what the task knows about its write. The real
/// Delivery.Run and the real BridgeClient against a loopback fake Studio whose error report is the ownerless web form
/// (DialogWindow, isModal false). Synthetic values only.</summary>
public class DeliveryStallTruthTests
{
    [Fact]
    public void AResumeRefusedByThePreProbeKeepsTheUnknownMergeAndItsPendingJournal()
    {
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        Assert.Equal("unknown", first["writeState"]!.ToString());
        Assert.Equal("merge_from_oml", first["pendingBridgeOperation"]!["method"]!.ToString());
        var resumed = test.Resume(first);
        Assert.Equal("unknown", resumed["writeState"]!.ToString());
        Assert.Null(resumed["code"]);
        Assert.Equal("merge_from_oml", resumed["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(first["operationId"]!.ToString(), resumed["pendingBridgeOperation"]!["operationId"]!.ToString());
        Assert.Equal("open_module", resumed["stalled"]!["method"]!.ToString());
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        Assert.True(test.ReservationHeld(resumed));
    }

    [Fact]
    public void AnAppliedMergeWithVerifyErrorsKeepsItsRefusalWhenTheTabCloseIsRefusedBeforeSending()
    {
        using var test = new StallCase();
        test.Studio.NewErrors = 1;
        test.Studio.OnMerge = s => { s.ReportVisible = true; return new JsonObject { ["merged"] = true, ["result"] = "merged" }; };
        var result = test.Run();
        Assert.Equal("applied", result["writeState"]!.ToString());
        Assert.Null(result["code"]);
        Assert.Null(result["stalled"]);
        Assert.Null(result["pendingBridgeOperation"]);
        Assert.Contains("Ctrl+Z", result["error"]!.ToString());
        Assert.Contains("dialog-before", result["closedTab"]!["reason"]!.ToString());
        Assert.Equal(0, test.Studio.Count("close_module"));
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        Assert.True(test.ReservationHeld(result));
    }

    [Fact]
    public void AConfirmedDeliveryStaysDeliveredWhenTheTabCloseIsRefusedBeforeSending()
    {
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return new JsonObject { ["merged"] = true, ["result"] = "merged" }; };
        var result = test.Run();
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Null(result["code"]); Assert.Null(result["stalled"]); Assert.Null(result["pendingBridgeOperation"]);
        Assert.False(result["closedTab"]!["closed"]!.GetValue<bool>());
    }

    [Fact]
    public void AValidationRefusalKeepsItsOwnAnswerWhenTheTabCloseIsRefusedBeforeSending()
    {
        using var test = new StallCase(valid: false);
        test.Studio.OnSnapshot = s => s.ReportVisible = true;
        var result = test.Run();
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Null(result["code"]);
        Assert.Null(result["stalled"]);
        Assert.Contains("validation contract", result["error"]!.ToString());
        Assert.Contains("dialog-before", result["closedTab"]!["reason"]!.ToString());
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        Assert.False(test.ReservationHeld(result));
    }

    [Fact]
    public void AMergeRefusedByThePreProbeIsNotSentAndKeepsItsOwnEvidence()
    {
        using var test = new StallCase();
        test.Studio.OnSnapshot = s => s.ReportVisible = true;
        var result = test.Run();
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Equal("STUDIO_ERROR_DIALOG_OPEN", result["code"]!.ToString());
        Assert.Equal("merge_from_oml", result["stalled"]!["method"]!.ToString());
        Assert.Equal("dialog-before", result["stalled"]!["verdict"]!.ToString());
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        Assert.False(test.ReservationHeld(result));
    }

    internal static JsonObject Valid(string _, string __, string output) { File.WriteAllText(output, "candidate"); return new() { ["isValid"] = true, ["accepted"] = true }; }
    internal static JsonObject Invalid(string _, string __, string output) { File.WriteAllText(output, "candidate"); return new() { ["isValid"] = false, ["accepted"] = false, ["expectedValid"] = true }; }
}

/// <summary>One delivery work folder with its own authority folder and a loopback fake Studio.</summary>
internal sealed class StallCase : IDisposable
{
    private readonly string? authority = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
    private readonly bool valid;
    public string Work { get; }
    public string Job { get; }
    public LoopbackStudio Studio { get; private set; } = new();
    public StallCase(bool valid = true)
    {
        this.valid = valid;
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(StallCase).Assembly.Location)!)!;
        Work = Path.Combine(root, ".local", "cx14-r2-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Work);
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Work, "authority"));
        Job = Path.Combine(Work, "job.json"); File.WriteAllText(Job, "{\"ops\":[]}");
    }
    public BridgeClient Client() => new(Studio.Port, probeMs: 100);
    public JsonObject Run(bool closeOpenedTab = true) => Delivery.Run(Client(), new("Probe", Job, Work, Array.Empty<string>(), CloseOpenedTab: closeOpenedTab),
        valid ? DeliveryStallTruthTests.Valid : DeliveryStallTruthTests.Invalid);
    public JsonObject Resume(JsonObject first, bool closeOpenedTab = true)
        => Delivery.Run(Client(), DeliveryTask.ResumeRequest(Work, first["taskId"]!.ToString()) with { CloseOpenedTab = closeOpenedTab },
            valid ? DeliveryStallTruthTests.Valid : DeliveryStallTruthTests.Invalid);
    public JsonObject Close(JsonObject first) => DeliveryTask.CloseKnownFailure(Work, first["taskId"]!.ToString(), "revise", Client());
    /// <summary>A Studio restart: the same port answers for another process identity (pid, start).</summary>
    public void Restart(int pid, string startedUtc)
    {
        var next = new LoopbackStudio { Pid = pid, StartedUtc = startedUtc, Key = Studio.Key };
        Studio.Dispose(); Studio = next;
    }
    public bool ReservationHeld(JsonObject result)
    {
        try
        {
            using var other = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), result["environment"]?.ToString() ?? "env-synthetic",
                result["moduleKey"]?.ToString() ?? Studio.Key, "someone-else");
            other.Release(); return false;
        }
        catch (InvalidOperationException) { return true; }
    }
    public void Dispose()
    {
        Studio.Dispose();
        Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(authority));
    }
}

/// <summary>A loopback fake Studio bridge: one JSON line per connection, probes answered at once, a hung call keeps its
/// socket open and never answers. The error report is the ownerless web form unless another window is set.</summary>
internal sealed class LoopbackStudio : IDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentQueue<string> calls = new();
    private readonly ConcurrentBag<TcpClient> held = new();
    public int Port { get; }
    public volatile bool ReportVisible;
    public JsonObject Report = new() { ["type"] = "OutSystems.Studio.DialogWindow", ["title"] = "Unexpected Error", ["isVisible"] = true, ["isModal"] = false, ["texts"] = new JsonArray() };
    public int NewErrors;
    public int Pid = Environment.ProcessId;
    public string StartedUtc = "2026-10-15T00:00:00Z#S1";
    public string Key = "K" + Guid.NewGuid().ToString("N");
    public string MergeStatus = "unknown";
    public string LiveBytes = "base-oml-synthetic";
    public bool UiAlive = true;
    public Func<LoopbackStudio, JsonObject?>? OnMerge;
    public Func<LoopbackStudio, JsonObject?>? OnClose;
    public Func<LoopbackStudio, JsonObject?>? OnOpen;
    public Func<LoopbackStudio, JsonObject?>? OnRefresh;
    /// <summary>CX14 N7: the bridge's own answer to merge_status (e.g. a watch that stayed with the merge, dialogWatch).</summary>
    public Func<LoopbackStudio, JsonObject?>? OnMergeStatus;
    public Action<LoopbackStudio>? OnSnapshot;
    public LoopbackStudio()
    {
        listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        _ = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync(stop.Token); }
                catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException) { return; }
                _ = Task.Run(() => Serve(client));
            }
        });
    }
    public IReadOnlyList<string> Calls => calls.ToArray();
    public IReadOnlyList<string> Writes => calls.Where(c => c is not ("ping" or "windows" or "bridge_manifest" or "ui_alive" or "list_open_modules")).ToArray();
    public int Count(string method) => calls.Count(c => c == method);
    public void Clear() { while (calls.TryDequeue(out _)) { } }
    private async Task Serve(TcpClient client)
    {
        try
        {
            var stream = client.GetStream();
            var reader = new StreamReader(stream, new UTF8Encoding(false));
            var line = await reader.ReadLineAsync(stop.Token);
            if (line == null) { client.Dispose(); return; }
            var request = JsonNode.Parse(line)!.AsObject();
            var method = request["method"]!.ToString(); var p = request["params"] as JsonObject ?? new JsonObject();
            calls.Enqueue(method);
            JsonObject? data = method switch
            {
                "ping" => new() { ["pid"] = Pid, ["startedUtc"] = StartedUtc, ["revisionSha256"] = "synthetic" },
                "bridge_manifest" => new() { ["capabilities"] = new JsonArray() },
                "windows" => Windows(),
                "ui_alive" => new() { ["alive"] = UiAlive },
                "list_open_modules" => new() { ["modules"] = new JsonArray(new JsonObject { ["name"] = "Probe", ["serverSilentMode"] = false, ["hasOpenedActiveESpace"] = true }) },
                "open_module" => OnOpen != null ? OnOpen(this) : Open(),
                "get_active_module" => new() { ["name"] = "Probe", ["key"] = Key, ["environment"] = "env-synthetic" },
                "snapshot_module" => Snapshot(p),
                "merge_from_oml" => OnMerge?.Invoke(this),
                "merge_status" => OnMergeStatus != null ? OnMergeStatus(this) : new() { ["state"] = MergeStatus, ["operation_id"] = p["operation_id"]?.DeepClone(),
                    ["receipt"] = MergeStatus == "unknown" ? null : new JsonObject { ["merged"] = MergeStatus == "applied", ["reason"] = MergeStatus == "not-applied" ? "not applied" : null } },
                "get_errors" => new() { ["newErrors"] = NewErrors, ["new"] = new JsonArray() },
                "close_module" => OnClose != null ? OnClose(this) : CloseTab(),
                "refresh_references" => OnRefresh != null ? OnRefresh(this) : new() { ["changed"] = false, ["refreshed"] = new JsonArray(), ["upToDate"] = new JsonArray() },
                _ => new JsonObject(),
            };
            if (data == null) { held.Add(client); return; }
            var bytes = Encoding.UTF8.GetBytes(new JsonObject { ["success"] = true, ["data"] = data }.ToJsonString() + "\n");
            await stream.WriteAsync(bytes, stop.Token);
            client.Dispose();
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { client.Dispose(); }
    }
    /// <summary>The module's tab: opened by the first open_module, already open after it until a close_module answers.</summary>
    public volatile bool TabOpen;
    public JsonObject Open()
    {
        if (TabOpen) return new() { ["opened"] = false, ["alreadyOpen"] = true };
        TabOpen = true; return new() { ["opened"] = true, ["alreadyOpen"] = false };
    }
    public JsonObject CloseTab() { TabOpen = false; return new() { ["closed"] = true }; }
    private JsonObject Snapshot(JsonObject p)
    {
        OnSnapshot?.Invoke(this);
        var path = p["path"]!.ToString(); File.WriteAllText(path, LiveBytes);
        return new() { ["key"] = Key, ["snapshot_id"] = "snap-" + Guid.NewGuid().ToString("N"), ["path"] = path };
    }
    private JsonObject Windows()
    {
        var list = new JsonArray(new JsonObject { ["type"] = "MainWindow", ["title"] = "Service Studio 11", ["isVisible"] = true, ["isModal"] = false });
        if (ReportVisible) list.Add(Report.DeepClone());
        return new() { ["windows"] = list };
    }
    public void Dispose()
    {
        stop.Cancel(); listener.Stop();
        foreach (var client in held) client.Dispose();
    }
}
