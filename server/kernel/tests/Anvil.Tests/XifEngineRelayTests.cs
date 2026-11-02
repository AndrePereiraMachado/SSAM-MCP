using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifEngineClient on a hosted server (F4 of PLANO-11H): with ANVIL_XIF_ENGINE_RELAY=1 the engine stages of
/// `anvil xif build` go as one line {method:"xif_engine", params, authorization} to the O11 relay of the customer (the
/// relay hands them to the user's SSAM agent, kind o11.xif). A fake relay on loopback stands for the server; no engine
/// process, no Integration Studio and no network beyond 127.0.0.1.</summary>
public sealed class XifEngineRelayTests
{
    private const string Key = "relay-key-of-this-customer";

    /// <summary>A one-connection relay: reads one line, answers what reply gives for the parsed request.</summary>
    private static (int Port, Task<JsonObject?> Seen) FakeRelay(Func<JsonObject, string?> reply)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var seen = Task.Run(async () =>
        {
            try
            {
                using var client = await listener.AcceptTcpClientAsync();
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, new UTF8Encoding(false));
                var line = await reader.ReadLineAsync();
                var request = JsonNode.Parse(line!) as JsonObject;
                var answer = reply(request!);
                if (answer != null) { var bytes = Encoding.UTF8.GetBytes(answer + "\n"); await stream.WriteAsync(bytes); await stream.FlushAsync(); }
                return request;
            }
            finally { listener.Stop(); }
        });
        return (port, seen);
    }

    private static Func<string, string?> Env(int port, string authority, string relay = "1") => name => name switch
    {
        XifEngineClient.RelayVariable => relay,
        "ANVIL_BRIDGE_PORT" => port.ToString(),
        "ANVIL_AUTHORITY_DIR" => authority,
        _ => null,
    };

    private static string Authority()
    {
        var dir = Path.Combine(Path.GetTempPath(), "anvil-xif-relay-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "bridge.key"), Key + "\n");
        return dir;
    }

    [Fact]
    public void WithoutTheRelayVariableTheEngineIsTheLocalProcess()
    {
        Assert.Equal(XifEngineClient.Run, XifEngineClient.Select(_ => null));
        Assert.Equal(XifEngineClient.Run, XifEngineClient.Select(name => name == XifEngineClient.RelayVariable ? "0" : "7"));
        Assert.NotEqual(XifEngineClient.Run, XifEngineClient.Select(Env(1, "x")));
    }

    [Fact]
    public async Task TheModelStageGoesToTheRelayWithTheKeyAndReadsTheXifTheAgentBuilt()
    {
        var authority = Authority();
        var work = Path.Combine(authority, "work");
        try
        {
            var (port, seen) = FakeRelay(request =>
            {
                var p = request["params"]!.AsObject();
                var output = p["output"]!.ToString();
                Directory.CreateDirectory(Path.GetDirectoryName(output)!);
                File.WriteAllBytes(output, XifPackage.Pack(XifSynthetic.Extension("ZZHybridXifLab", "ext-key-1", [],
                    [XifSynthetic.Action("Add", "act-add", false, XifSynthetic.Input("Left", "p-left", "rtInteger"), XifSynthetic.Output("Result", "p-result", "rtInteger"))], [])));
                return new JsonObject { ["ok"] = true, ["xif"] = output, ["studio"] = new JsonObject { ["version"] = "11.14.25.134", ["lastUpgradeVersion"] = "11.0.0.200" }, ["reports"] = new JsonArray() }.ToJsonString();
            });
            var spec = JsonNode.Parse("""{"name":"ZZHybridXifLab","actions":[{"name":"Add","inputs":[{"name":"Left","type":"Integer"}],"outputs":[{"name":"Result","type":"Integer"}],"body":"Result = Left;"}]}""");
            var model = XifBuild.Model(spec, null, work, XifEngineClient.Select(Env(port, authority)));
            var request = (await seen)!;
            Assert.Equal(XifEngineClient.RelayMethod, request["method"]!.ToString());
            Assert.Equal(Key, request["authorization"]!.ToString());
            Assert.Equal("model", request["params"]!["command"]!.ToString());
            Assert.Equal(("model", "ZZHybridXifLab", "ext-key-1"), (model["stage"]!.ToString(), model["name"]!.ToString(), model["key"]!.ToString()));
            Assert.Equal("11.0.0.200", model["engine"]!["lastUpgradeVersion"]!.ToString());
        }
        finally { try { Directory.Delete(authority, true); } catch (IOException) { } }
    }

    [Fact]
    public void AnAgentRefusalKeepsItsCodeAndEveryProblem()
    {
        var (port, _) = FakeRelay(_ => """{"ok":false,"code":"XIF_ENGINE_UNAVAILABLE","error":"Integration Studio 11 is not installed on the machine of the SSAM agent.","problems":[{"code":"XIF_ENGINE_UNAVAILABLE","message":"no Integration Studio","fix":"Install Integration Studio 11."}]}""");
        var refusal = Assert.Throws<XifRefusal>(() => XifEngineClient.RunRelay(new JsonObject { ["command"] = "model" }, port, Key, TimeSpan.FromSeconds(30)));
        Assert.Equal(XifCodes.EngineUnavailable, refusal.Code);
        Assert.Contains("not installed", refusal.Message);
        Assert.Equal("Install Integration Studio 11.", Assert.Single(refusal.Problems).Fix);
    }

    [Fact]
    public void ABuildFailureOfTheAgentIsTheEnginesRefusal()
    {
        var (port, _) = FakeRelay(_ => """{"ok":false,"code":"XIF_VERIFY_FAILED","error":"ProjectVerify reported 1 error.","problems":[{"code":"XIF_VERIFY_FAILED","path":"Add","message":"Invalid name","fix":"Rename it."}]}""");
        var refusal = Assert.Throws<XifRefusal>(() => XifEngineClient.RunRelay(new JsonObject { ["command"] = "final" }, port, Key, TimeSpan.FromSeconds(30)));
        Assert.Equal("XIF_VERIFY_FAILED", refusal.Code);
        Assert.Equal("Add", Assert.Single(refusal.Problems).Path);
    }

    [Fact]
    public void ACallTheRelayNeverDeliveredKeepsTheCodeOfTheRelay()
    {
        var (port, _) = FakeRelay(_ => """{"success":false,"executed":false,"error":"XIF_AGENT_UPDATE_REQUIRED: The SSAM agent of this account does not build extensions."}""");
        var refusal = Assert.Throws<XifRefusal>(() => XifEngineClient.RunRelay(new JsonObject { ["command"] = "model" }, port, Key, TimeSpan.FromSeconds(30)));
        Assert.Equal("XIF_AGENT_UPDATE_REQUIRED", refusal.Code);
        Assert.Contains("nothing was sent", refusal.Message);
    }

    [Fact]
    public void NoAnswerAndNoKeyAreRefusalsBeforeTheEnvironment()
    {
        var (port, _) = FakeRelay(_ => null);
        var lost = Assert.Throws<XifRefusal>(() => XifEngineClient.RunRelay(new JsonObject { ["command"] = "model" }, port, Key, TimeSpan.FromSeconds(30)));
        Assert.Equal(XifCodes.EngineUnavailable, lost.Code);
        var noKey = Assert.Throws<XifRefusal>(() => XifEngineClient.Select(Env(port, Path.Combine(Path.GetTempPath(), "no-such-" + Guid.NewGuid().ToString("N"))))(new JsonObject(), Path.GetTempPath()));
        Assert.Contains("relay key", noKey.Message);
        var noPort = Assert.Throws<XifRefusal>(() => XifEngineClient.Select(name => name == XifEngineClient.RelayVariable ? "1" : null)(new JsonObject(), Path.GetTempPath()));
        Assert.Contains("no port", noPort.Message);
    }
}
