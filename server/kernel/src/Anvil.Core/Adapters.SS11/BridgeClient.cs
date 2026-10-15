using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
namespace Anvil.Core;

/// <summary>Local bridge JSON-lines. One request per connection; uncertain writes are never retried. With
/// ANVIL_BRIDGE_FLAVOR=thin (hosted O11, read per call) every call goes through ThinBridge, which computes on the server
/// what the full bridge computed inside the Studio and sends only primitive requests through Send. The socket deadline of each
/// call is the bridge's own bound for that verb plus a margin, never less than the effective timeout (BridgeDeadlines, F2).</summary>
public sealed class BridgeClient(int port, int timeoutSeconds = 120) : IBridgeClient
{
    private ThinBridge? thin;

    public JsonObject Call(string method, JsonObject? parameters = null)
        => ThinBridge.Enabled ? (thin ??= new ThinBridge(Send)).Call(method, parameters) : Send(method, parameters);

    /// <summary>The thin bridge's find_element capture, if any, is released (ThinBridge.ReleaseCapture); the client stays
    /// usable.</summary>
    public void ReleaseCapture() => thin?.ReleaseCapture();

    private JsonObject Send(string method, JsonObject? parameters)
    {
        var socketTimeout = ThinBridge.EffectiveTimeout(timeoutSeconds);
        using var client = new TcpClient();
        client.ConnectAsync("127.0.0.1", port).WaitAsync(TimeSpan.FromSeconds(Math.Min(timeoutSeconds, 5))).GetAwaiter().GetResult();
        var deadline = BridgeDeadlines.Seconds(method, parameters, socketTimeout);
        client.ReceiveTimeout = deadline * 1000; client.SendTimeout = deadline * 1000;
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, new UTF8Encoding(false));
        using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        writer.WriteLine(new JsonObject { ["method"] = method, ["params"] = parameters, ["authorization"] = BridgeAccess.ReadCredential() }.ToJsonString());
        var line = reader.ReadLine() ?? throw new IOException($"{method}: bridge closed before replying; execution outcome may be unknown");
        var reply = JsonNode.Parse(line)!.AsObject();
        if (reply["success"]?.GetValue<bool>() != true) throw new BridgeCallException($"{method}: {reply["error"]}", reply["executed"]?.GetValue<bool>());
        return reply["data"]?.DeepClone().AsObject() ?? new JsonObject();
    }
}

// BridgeCallException lives next to IBridgeClient in Delivery/Delivery.cs since WS1 (the kernel reads Executed).
