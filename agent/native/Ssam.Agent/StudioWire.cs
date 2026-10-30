using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal static class StudioWire
{
    private static readonly UnixStudioPipe UnixPipe = new(MacPlatform.SocketIdentity);
    internal static int ReplyTimeout(string[] words)
    {
        var wait = 600000d;
        if (words[0] == "wait" && double.TryParse(words[^1], out var seconds)) wait = Math.Max(wait, seconds * 1000 + 60000);
        var index = Array.IndexOf(words, "--wait");
        if (words[0] == "publish" && index >= 0 && index + 1 < words.Length && double.TryParse(words[index + 1], out var minutes)) wait = Math.Max(wait, minutes * 60000 + 60000);
        return (int)Math.Clamp(wait, 1, int.MaxValue);
    }
    public static async Task<string> Pipe(int pid, string version, string[] words, int connectMs, CancellationToken token, int? timeout = null)
    {
        if (OperatingSystem.IsMacOS())
        {
            var endpoint = MacPlatform.Endpoint(pid);
            var folders = endpoint == null ? MacPlatform.TempFolders() : new[] { Path.GetDirectoryName(endpoint.Value.Path)! }.Concat(MacPlatform.TempFolders()).Distinct().ToArray();
            return await UnixPipe.Call(folders.Select(dir => Path.Combine(dir, $"CoreFxPipe_ODC3-Bridge-{version}-{pid}")).ToArray(), words, connectMs, timeout ?? ReplyTimeout(words), token);
        }
        using var pipe = new NamedPipeClientStream(".", $"ODC3-Bridge-{version}-{pid}", PipeDirection.InOut, PipeOptions.Asynchronous);
        var sent = false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        try
        {
            deadline.CancelAfter(connectMs);
            await pipe.ConnectAsync(deadline.Token);
            deadline.CancelAfter(timeout ?? ReplyTimeout(words));
            sent = true;
            await pipe.WriteAsync(Encoding.UTF8.GetBytes(string.Join(' ', words) + "\n"), deadline.Token);
            return (await new BoundedLines(pipe, 256 * 1024 * 1024).ReadAsync(deadline.Token))?.TrimEnd('\r')
                ?? throw new AgentFault("PIPE_NO_REPLY", "The bridge closed without a reply; inspect its evidence before retrying", null) { Sent = true };
        }
        catch (OperationCanceledException) { throw new AgentFault(sent ? "PIPE_REPLY_TIMEOUT" : "PIPE_CONNECT_TIMEOUT", sent ? "The Studio may still be executing; inspect its evidence before retrying" : "The bridge did not accept the connection", sent ? null : false) { Sent = sent }; }
        catch (IOException) { throw new AgentFault("PIPE_TRANSPORT", "The Studio pipe failed", sent ? null : false) { Sent = sent }; }
    }

    public static int Timeout(string method, JsonObject p)
    {
        double Number(string key, double fallback) => p[key] is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : fallback;
        var value = method switch {
            "ping" or "bridge_manifest" => 5000, "ui_alive" => Number("timeout_ms", 5000) + 5000,
            "open_module" => Number("timeout", 120) * 1000 + 60000,
            "close_module" => 90000 + Number("idle_timeout_ms", 30000),
            "snapshot_module" or "get_errors" or "sc_api" or "sc_web" => 300000,
            "merge_from_oml" => 900000, "merge_status" or "sc_session" => 60000,
            "windows" or "close_dialog" => 30000, "publish" => Number("timeout", 300) * 1000 + 105000,
            "studio_login" => Number("waitMs", 3000) + 30000,
            "refresh_references" => Number("timeout", 600) * 1000 + 60000, _ => 120000
        };
        return (int)Math.Clamp(value, 1, 3600000);
    }

    public static async Task<JsonNode?> Bridge(int port, string? key, string method, JsonObject p, CancellationToken token, int? timeout = null)
    {
        var socket = new TcpClient();
        var sent = false;
        var retained = false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(timeout ?? Timeout(method, p));
        try
        {
            await socket.ConnectAsync(IPAddress.Loopback, port, deadline.Token);
            var request = new JsonObject { ["method"] = method, ["params"] = p.DeepClone() };
            if (key != null) request["authorization"] = key;
            sent = true;
            await socket.GetStream().WriteAsync(Encoding.UTF8.GetBytes(request.ToJsonString() + "\n"), deadline.Token);
            // The reply read has its own lifetime: timing out the caller must not close a
            // connection on which the Studio may still be completing a native write.
            var reply = new BoundedLines(socket.GetStream(), 100 * 1024 * 1024).ReadAsync(CancellationToken.None);
            string? line;
            try { line = await reply.WaitAsync(deadline.Token); }
            catch (OperationCanceledException) { retained = true; _ = Drain(socket, reply); throw; }
            if (line == null) throw new AgentFault("BRIDGE_NO_REPLY", "The bridge closed without a reply", null);
            try { return JsonNode.Parse(line); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("BRIDGE_PROTOCOL", "Unexpected service on the local bridge port", null); }
        }
        catch (OperationCanceledException) { throw new AgentFault(token.IsCancellationRequested ? "CANCELLED" : "BRIDGE_TIMEOUT", "The bridge did not answer; a sent operation may still be executing", sent ? null : false); }
        catch (SocketException e) { throw new AgentFault(e.SocketErrorCode == SocketError.ConnectionRefused ? "BRIDGE_NOT_LISTENING" : "BRIDGE_TRANSPORT", "The local Studio bridge is unavailable", sent ? null : false); }
        catch (IOException) { throw new AgentFault("BRIDGE_TRANSPORT", "The local Studio bridge connection failed", sent ? null : false); }
        finally { if (!retained) socket.Dispose(); }
    }
    private static async Task Drain(TcpClient socket, Task<string?> reply)
    {
        try { await reply.WaitAsync(TimeSpan.FromMinutes(30)); } catch { }
        finally { socket.Dispose(); }
    }
}
