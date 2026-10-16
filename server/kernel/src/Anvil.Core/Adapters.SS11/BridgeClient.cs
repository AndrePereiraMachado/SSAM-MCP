using System.Net.Sockets;
using System.Net;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
namespace Anvil.Core;

/// <summary>Local bridge JSON-lines. One request per connection; uncertain writes are never retried. With
/// ANVIL_BRIDGE_FLAVOR=thin (hosted O11, read per call) every call goes through ThinBridge, which computes on the server
/// what the full bridge computed inside the Studio and sends only primitive requests through Send. The socket deadline of each
/// call is the bridge's own bound for that verb plus a margin, never less than the effective timeout (BridgeDeadlines, F2).
/// CX14: watched UI calls use independent, bounded windows/ping probes. Only positive dialog, connection-refused or
/// process/restart evidence stops waiting; the result remains uncertain and the write is never repeated. A pre-probe
/// refuses an existing error report before sending, unless the bridge advertises automatic closure for that verb.
/// ANVIL_BRIDGE_PROBE_MS=0 disables both probes; slow/refused/malformed probes leave the call's existing behavior intact.
/// The hosted server sets ANVIL_BRIDGE_PROBE_MS=0 (hostedSpawnEnv o11): the Studio pid the probes check lives on the
/// user's machine, never on the server, until an agent package carries CX14.</summary>
public sealed class BridgeClient(int port, int timeoutSeconds = 120, int? probeMs = null) : IBridgeClient, IBridgeProbeReader
{
    private ThinBridge? thin;
    private readonly int probeInterval = probeMs ?? ProbeInterval();
    private readonly object manifestGate = new();
    private Task<ProbeReply>? manifest;

    public JsonObject Call(string method, JsonObject? parameters = null)
    {
        if (ThinBridge.Enabled) return (thin ??= new ThinBridge(Send)).Call(method, parameters);
        // CX14 follow-up (owner rule: fewer rounds): ONE bridge_manifest per client (one kernel command, one Studio), shared
        // by the pre-probe and the kernel's own capability checks (Delivery.HasCapability/Offers). A manifest already read
        // is answered from it; a read that failed (no answer) is read again by the normal call, which throws as before.
        if (method == "bridge_manifest" && (parameters == null || parameters.Count == 0))
        {
            Task<ProbeReply>? known;
            lock (manifestGate) known = manifest;
            if (known != null && known.GetAwaiter().GetResult().Data is { } cached) return cached.DeepClone().AsObject();
            var read = Send(method, parameters);
            lock (manifestGate) if (manifest == null || manifest.IsCompleted && manifest.Result.Data == null) manifest = Task.FromResult(new ProbeReply(read.DeepClone().AsObject()));
            return read;
        }
        return Send(method, parameters);
    }

    /// <summary>The thin bridge's find_element capture, if any, is released (ThinBridge.ReleaseCapture); the client stays
    /// usable.</summary>
    public void ReleaseCapture() => thin?.ReleaseCapture();

    private JsonObject Send(string method, JsonObject? parameters)
    {
        var deadline = BridgeDeadlines.Seconds(method, parameters, ThinBridge.EffectiveTimeout(timeoutSeconds));
        // servidor/fase4-26 (A1): the thin flavor (hosted O11 only) never probes: the windows/ping probes would read the
        // customer's Studio pid on the server, where it never runs, and abandon the call as studio-gone.
        var rule = new BridgeStallRule(method, ThinBridge.Enabled ? 0 : probeInterval, deadline * 1000);
        int? studioPid = null;
        var initialized = false;
        if (rule.NeedsPreProbe)
        {
            var windows = Probe("windows", new() { ["max_texts"] = BridgeStallRule.MaxTexts });
            var ping = Probe("ping");
            Task<ProbeReply> offers;
            lock (manifestGate) offers = manifest ??= Probe("bridge_manifest");
            Task.WhenAll(windows, ping, offers).GetAwaiter().GetResult();
            studioPid = Pid(ping.Result.Data);
            var capabilities = (offers.Result.Data?["capabilities"] as JsonArray)?.Select(c => c?.ToString() ?? "").ToArray();
            var before = rule.Begin(windows.Result.Data?["windows"] as JsonArray, capabilities, studioPid, StartedUtc(ping.Result.Data));
            initialized = true;
            if (before != null) throw Stopped(method, false, before);
        }
        // The main deadline starts after the pre-probe. A probe never borrows the long UI operation's deadline.
        var clock = Stopwatch.StartNew();
        using var client = new TcpClient();
        client.ConnectAsync("127.0.0.1", port).WaitAsync(TimeSpan.FromSeconds(Math.Min(timeoutSeconds, 5))).GetAwaiter().GetResult();
        client.ReceiveTimeout = deadline * 1000; client.SendTimeout = deadline * 1000;
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, new UTF8Encoding(false));
        using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        writer.WriteLine(new JsonObject { ["method"] = method, ["params"] = parameters, ["authorization"] = BridgeAccess.ReadCredential() }.ToJsonString());
        string? line;
        if (!rule.Enabled) line = reader.ReadLine();
        else
        {
            using var probes = new CancellationTokenSource();
            var read = reader.ReadLineAsync();
            long nextProbeAt = probeInterval;
            try
            {
                while (!read.IsCompleted)
                {
                    var remaining = deadline * 1000L - clock.ElapsedMilliseconds;
                    if (remaining <= 0) throw new IOException($"{method}: bridge reply deadline expired; execution outcome may be unknown");
                    Task.WhenAny(read, Task.Delay((int)Math.Min(Math.Max(0, nextProbeAt - clock.ElapsedMilliseconds), remaining), probes.Token)).GetAwaiter().GetResult();
                    if (read.IsCompleted) break;
                    if (clock.ElapsedMilliseconds >= deadline * 1000L) continue;
                    var windows = Probe("windows", new() { ["max_texts"] = BridgeStallRule.MaxTexts }, probes.Token);
                    var ping = Probe("ping", cancel: probes.Token);
                    var sampling = Task.WhenAll(windows, ping);
                    // A slow probe must not delay a completed main response or extend its socket deadline.
                    var winner = Task.WhenAny(read, sampling, Task.Delay((int)Math.Clamp(deadline * 1000L - clock.ElapsedMilliseconds, 1, int.MaxValue), probes.Token)).GetAwaiter().GetResult();
                    if (read.IsCompleted) break;
                    if (winner != sampling) continue;
                    sampling.GetAwaiter().GetResult();
                    // Fixed cadence (2s,4s,...) adds only the last probe's latency to the normal bound. An overrun
                    // starts the next probe when possible; no overlapping probes and no evidence inferred from a timeout.
                    nextProbeAt = Math.Max(nextProbeAt + probeInterval, clock.ElapsedMilliseconds);
                    if (!initialized)
                    {
                        studioPid = Pid(ping.Result.Data);
                        rule.Begin(pid: studioPid, startedUtc: StartedUtc(ping.Result.Data));
                        initialized = true;
                    }
                    var probe = new JsonObject { ["afterMs"] = clock.ElapsedMilliseconds };
                    if (windows.Result.Data?["windows"] is JsonArray visible) probe["windows"] = visible.DeepClone();
                    if (windows.Result.ConnectionRefused) probe["connectionRefused"] = true;
                    if (StartedUtc(ping.Result.Data) is { } started) probe["startedUtc"] = started;
                    if (Alive(studioPid) is { } alive) probe["studioAlive"] = alive;
                    if (rule.Observe(probe) is { } stall) throw Stopped(method, null, stall);
                }
                line = read.GetAwaiter().GetResult();
            }
            finally { probes.Cancel(); }
        }
        if (line == null) throw new IOException($"{method}: bridge closed before replying; execution outcome may be unknown");
        var reply = JsonNode.Parse(line)!.AsObject();
        if (reply["success"]?.GetValue<bool>() != true) throw new BridgeCallException($"{method}: {reply["error"]}", reply["executed"]?.GetValue<bool>());
        return reply["data"]?.DeepClone().AsObject() ?? new JsonObject();
    }

    private static int ProbeInterval() => int.TryParse(Environment.GetEnvironmentVariable("ANVIL_BRIDGE_PROBE_MS"), out var value) && value >= 0 ? value : BridgeStallRule.ProbeMs;
    private static int? Pid(JsonObject? ping) => ping?["pid"] is JsonValue value && value.TryGetValue<int>(out var pid) && pid > 0 ? pid : null;
    private static string? StartedUtc(JsonObject? ping) => ping?["startedUtc"] is JsonValue value && value.TryGetValue<string>(out var started) ? started : null;
    private static bool? Alive(int? pid)
    {
        if (pid == null) return null;
        try { using var process = Process.GetProcessById(pid.Value); return !process.HasExited; }
        catch (ArgumentException) { return false; }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { return null; }
    }
    // CX14 N7: the client knows only its own call, never what else the caller sent (a resume sends its normal steps again
    // after a proven idle): it says what is true of this call, never "nothing was repeated".
    private static BridgeCallException Stopped(string method, bool? executed, JsonObject stall)
        => new($"{method}: Studio call stopped ({stall["verdict"]})" + (stall["blockedBy"]?["title"] is { } title ? $": {title}" : "")
            + "; this call was not retried", executed, stall);

    private sealed record ProbeReply(JsonObject? Data, bool ConnectionRefused = false);
    public async Task<JsonObject?> ReadProbeAsync(string method, JsonObject? parameters = null, int timeoutMs = 250)
    {
        if (method is not ("windows" or "ui_alive" or "list_open_modules" or "ping"))
            throw new ArgumentException("Bounded recovery probes accept only windows, ui_alive, list_open_modules and ping", nameof(method));
        return (await Probe(method, parameters, timeoutMs: Math.Clamp(timeoutMs, 1, BridgeStallRule.ProbeTimeoutMs))).Data;
    }
    private async Task<ProbeReply> Probe(string method, JsonObject? parameters = null, CancellationToken cancel = default, int timeoutMs = BridgeStallRule.ProbeTimeoutMs)
    {
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        bound.CancelAfter(timeoutMs);
        using var client = new TcpClient();
        try
        {
            await client.ConnectAsync(IPAddress.Loopback, port, bound.Token);
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, new UTF8Encoding(false));
            using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
            await writer.WriteLineAsync(new JsonObject { ["method"] = method, ["params"] = parameters, ["authorization"] = BridgeAccess.ReadCredential() }.ToJsonString().AsMemory(), bound.Token);
            var line = await reader.ReadLineAsync(bound.Token);
            var reply = line == null ? null : JsonNode.Parse(line) as JsonObject;
            return new(reply?["success"] is JsonValue success && success.TryGetValue<bool>(out var ok) && ok ? reply["data"]?.DeepClone() as JsonObject : null);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            var socket = ex as SocketException ?? ex.InnerException as SocketException;
            return new(null, socket?.SocketErrorCode is SocketError.ConnectionRefused or SocketError.ConnectionReset);
        }
    }
}

// BridgeCallException lives next to IBridgeClient in Delivery/Delivery.cs since WS1 (the kernel reads Executed).
