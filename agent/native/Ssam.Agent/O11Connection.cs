using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using static Ssam.Agent.StudioKinds;

namespace Ssam.Agent;

internal sealed class O11Connection(string root, string runtime, JsonObject pack, StudioKinds studios)
{
    internal static JsonObject? Read(string file) { try { return JsonNode.Parse(File.ReadAllText(file).TrimStart('\uFEFF')) as JsonObject; } catch (Exception e) when (e is IOException or System.Text.Json.JsonException or UnauthorizedAccessException) { return null; } }
    internal static JsonObject? Record(string root)
    {
        var record = Read(Path.Combine(root, "private/o11-connection.json"));
        return Integer(record?["port"]) is > 0 and <= 65535 && Integer(record?["pid"]) > 0 ? record : null;
    }
    internal static string? Key(string root) { try { var key = File.ReadAllText(Path.Combine(root, "private/authority/bridge.key")).Trim(); return key.Length > 0 ? key : null; } catch (IOException) { return null; } }
    private static AgentFault Fail(string message, bool? executed = false) => new("ATTACH_FAILED", message, executed);
    private async Task<JsonObject> Describe(int pid, CancellationToken token)
    {
        if (OperatingSystem.IsMacOS()) return await MacPlatform.Describe("o11", pid, token);
        var reply = await Helper(Path.Combine(runtime, "bin/o11/connect/Anvil.Connect.dll"), ["describe", pid.ToString()], 30000, false, token);
        if (reply["ok"]?.GetValue<bool>() != true) throw Fail("The connector could not describe the selected Studio");
        return reply;
    }
    private static async Task<JsonObject> Probe(int port, CancellationToken token)
    {
        try
        {
            var ping = await StudioWire.Bridge(port, null, "ping", new(), token, 2500);
            if (ping?["success"]?.GetValue<bool>() != true || Text(ping["data"]?["bridge"]) != "anvil" || Integer(ping["data"]?["pid"]) < 1) return new() { ["occupied"] = true };
            var reply = await StudioWire.Bridge(port, null, "bridge_manifest", new(), token, 2500);
            var manifest = reply?["data"];
            if (reply?["success"]?.GetValue<bool>() != true || Integer(manifest?["protocolVersion"]) != 2 || manifest?["authentication"]?.GetValue<bool>() != true) return new() { ["occupied"] = true };
            if (Text(manifest?["flavor"]) != "thin") return new() { ["occupied"] = true, ["thin"] = false };
            return new() { ["connected"] = true, ["pid"] = ping["data"]!["pid"]!.DeepClone(), ["manifest"] = manifest!.DeepClone() };
        }
        catch (AgentFault e) { return new() { ["occupied"] = e.Code != "BRIDGE_NOT_LISTENING" }; }
    }
    private void Handshake(JsonNode? manifest, bool? executed)
    {
        var expected = Text(pack["o11Bridge"]?["sha256"]);
        var release = Text(pack["o11Hook"]) == "h1";
        expected ??= (pack["files"] as JsonArray)?.FirstOrDefault(f => Text(f?["path"]) == (release ? "studio/o11/bridge/b1/Anvil.Bridge.dll" : "bin/o11/bridge/Anvil.Bridge.dll"))?["sha256"]?.GetValue<string>();
        if (expected != null && Text(manifest?["bridgeSha256"]) != expected || release && (Text(manifest?["hookAbi"]) != "h1" || Text(manifest?["bridgeId"]) != "b1"))
            throw new AgentFault("BRIDGE_VERSION_MISMATCH", "The loaded thin bridge differs from this pack; it stays loaded but unused", executed);
    }
    private void VerifyCoverage()
    {
        if (!File.Exists(Path.Combine(runtime, "release.json"))) throw Fail("The release pack has no release.json");
        JsonObject payload;
        try
        {
            var parts = File.ReadAllText(Path.Combine(runtime, "release.sig.jws")).Trim().Split('.');
            if (parts.Length != 3) throw new FormatException();
            var b64 = parts[1].Replace('-', '+').Replace('_', '/');
            payload = JsonNode.Parse(Convert.FromBase64String(b64.PadRight((b64.Length + 3) / 4 * 4, '='))) as JsonObject ?? throw new FormatException();
        }
        catch (Exception e) when (e is IOException or FormatException or System.Text.Json.JsonException) { throw Fail("The signed release manifest is missing or unreadable"); }
        if (Text(payload["typ"]) != "ssam-release/1" || payload["files"] is not JsonArray entries) throw Fail("The signed release manifest has an invalid type");
        var folder = Path.Combine(runtime, "studio/o11/bridge/b1");
        if (!Directory.Exists(folder)) throw Fail("The release bridge is missing");
        foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories).Append(Path.Combine(runtime, "studio/o11/hook/Anvil.Hook.h1.dll")))
        {
            var relative = Path.GetRelativePath(runtime, file).Replace('\\', '/');
            var entry = entries.FirstOrDefault(n => string.Equals(Text(n?["path"]), relative, StringComparison.OrdinalIgnoreCase));
            if (entry == null || !File.Exists(file) || entry["size"]?.GetValue<long>() != new FileInfo(file).Length || Text(entry["sha256"]) != Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(file))))
                throw Fail("The release hook or bridge differs from its signed manifest; nothing was attached");
        }
    }
    private static void Atomic(string file, JsonNode value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, value.ToJsonString());
        File.Move(temporary, file, true);
    }
    public async Task<JsonNode> Execute(string kind, JsonObject p, CancellationToken token)
    {
        if (kind == "o11.selected")
        {
            var record = Record(root);
            var result = new JsonObject { ["connected"] = false, ["pid"] = record?["pid"]?.DeepClone(), ["startedUtc"] = record?["startedUtc"]?.DeepClone(), ["version"] = record?["studioVersion"]?.DeepClone() };
            if (record == null) return result;
            try
            {
                var ping = await StudioWire.Bridge(Integer(record["port"]), null, "ping", new(), token, 2500);
                if (ping?["success"]?.GetValue<bool>() == true && Integer(ping["data"]?["pid"]) == Integer(record["pid"]) && Text((await Describe(Integer(record["pid"]), token))["startedUtc"]) == Text(record["startedUtc"])) result["connected"] = true;
            }
            catch (AgentFault) { }
            return result;
        }
        var candidates = Processes("ServiceStudio.exe").OfType<JsonObject>().Where(n => p["pid"] == null || Integer(n["pid"]) == Integer(p["pid"])).ToArray();
        if (candidates.Length != 1) throw new AgentFault("STUDIO_NOT_SELECTED", "Select exactly one running Service Studio with pid");
        var selected = studios.CheckPid("o11", candidates[0]["pid"]);
        var warning = studios.CheckO11Build(Text(selected["version"]));
        var pid = Integer(selected["pid"]);
        var config = Read(Path.Combine(root, "private/agent-config.json")) ?? Read(Path.Combine(root, "private/config.json"));
        var port = Integer(config?["o11Port"], 4516);
        var folder = Path.Combine(root, "private/runtime-connect");
        Directory.CreateDirectory(folder);
        var lockPath = Path.Combine(folder, $"port-{port}.lock");
        FileStream guard;
        try { guard = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None); }
        catch (IOException) { throw Fail("Another connection attempt holds the local port"); }
        try
        {
            var target = await Describe(pid, token);
            var probed = await Probe(port, token);
            var reused = probed["connected"]?.GetValue<bool>() == true && Integer(probed["pid"]) == pid;
            if (probed["thin"]?.GetValue<bool>() == false || probed["occupied"]?.GetValue<bool>() == true || probed["connected"]?.GetValue<bool>() == true && !reused) throw Fail("The local bridge port is occupied by another bridge");
            var release = Text(pack["o11Hook"]) == "h1";
            if (release && OperatingSystem.IsMacOS()) throw Fail("The release h1 hook is not qualified for macOS; use the macOS development pack");
            if (reused) Handshake(probed["manifest"], false);
            else
            {
                if (target["diagnosticsAvailable"]?.GetValue<bool>() != true || Text(target["bridgePath"]) is { Length: > 0 } || Text(target["corePath"]) is { Length: > 0 }) throw Fail("The Studio cannot accept this hook, or already has Anvil loaded");
                var started = Text(target["startedUtc"]) ?? throw Fail("The Studio start time is unavailable");
                var pending = Path.Combine(folder, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(pid + ":" + started + ":" + port))) + ".json");
                if (File.Exists(pending)) throw Fail("A previous attach may have executed and will not be repeated");
                var id = Guid.NewGuid().ToString("N");
                string hook, receipt;
                if (release)
                {
                    VerifyCoverage();
                    var profile = Environment.GetEnvironmentVariable("USERPROFILE") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    var ms = DateTimeOffset.Parse(started).ToUnixTimeMilliseconds();
                    var exchange = Path.Combine(profile, ".ssam-hybrid/data/o11/runtime-connect", pid + "-" + ms);
                    receipt = Path.Combine(exchange, "receipt-b1.json");
                    if (File.Exists(receipt)) throw Fail("The release hook already answered for this Studio; it will not be repeated");
                    hook = Path.Combine(runtime, "studio/o11/hook/Anvil.Hook.h1.dll");
                    Atomic(Path.Combine(exchange, "request-b1.json"), new JsonObject { ["pid"] = pid, ["startedUtc"] = started, ["bridgeId"] = "b1", ["bridgeDir"] = Path.Combine(runtime, "studio/o11/bridge/b1"), ["port"] = port, ["dataDir"] = Path.Combine(root, "private/o11-bridge"), ["authorityDir"] = Path.Combine(root, "private/authority") });
                }
                else
                {
                    var evidence = Path.Combine(folder, id);
                    Directory.CreateDirectory(evidence);
                    hook = Path.Combine(evidence, "Anvil.RuntimeHook.Agent.dll");
                    File.Copy(Path.Combine(runtime, "bin/o11/hook/Anvil.RuntimeHook.Agent.dll"), hook);
                    Atomic(hook + ".json", new JsonObject { ["pid"] = pid, ["startedUtc"] = started, ["port"] = port, ["bridgePath"] = Path.Combine(runtime, "bin/o11/bridge/Anvil.Bridge.dll"), ["authorityDir"] = Path.Combine(root, "private/authority") });
                    receipt = hook + ".receipt.json";
                }
                var current = await Describe(pid, token);
                if (Text(current["startedUtc"]) != started || Text(current["bridgePath"]) is { Length: > 0 } || Text(current["corePath"]) is { Length: > 0 }) throw Fail("The Studio changed before attach");
                probed = await Probe(port, token);
                if (probed["connected"]?.GetValue<bool>() == true || probed["occupied"]?.GetValue<bool>() == true) throw Fail("The local bridge port became occupied");
                Atomic(pending, new JsonObject { ["pid"] = pid, ["startedUtc"] = started, ["evidence"] = id, ["hook"] = release ? "h1" : "dev" });
                try
                {
                    if (OperatingSystem.IsMacOS()) await MacPlatform.Attach("o11", pid, started, hook, token);
                    else await Helper(Path.Combine(runtime, "bin/o11/connect/Anvil.Connect.dll"), ["attach", pid.ToString(), started, hook], 30000, true, token);
                }
                catch (AgentFault) { }
                var end = DateTime.UtcNow.AddSeconds(30);
                for (var delay = 250; ; delay = Math.Min(delay * 2, 2000))
                {
                    probed = await Probe(port, token);
                    if (probed["connected"]?.GetValue<bool>() == true || probed["thin"]?.GetValue<bool>() == false || Read(receipt)?["ok"]?.GetValue<bool>() == false || DateTime.UtcNow >= end) break;
                    await Task.Delay(delay, token);
                }
                if (probed["connected"]?.GetValue<bool>() != true || Integer(probed["pid"]) != pid) throw Fail("Attach was not confirmed and must not be repeated", null);
                Handshake(probed["manifest"], null);
            }
            var key = Key(root) ?? throw Fail("The bridge key is missing", null);
            var alive = await StudioWire.Bridge(port, key, "ui_alive", new() { ["timeout_ms"] = 1000 }, token, 6000);
            if (alive?["success"]?.GetValue<bool>() != true) throw Fail("The bridge did not accept the local key", null);
            if (Text((await Describe(pid, token))["startedUtc"]) != Text(target["startedUtc"])) throw Fail("The Studio changed before connection was confirmed", null);
            var record = new JsonObject { ["ok"] = true, ["lane"] = "o11", ["connected"] = true, ["reused"] = reused, ["pid"] = pid, ["startedUtc"] = target["startedUtc"]?.DeepClone(), ["studioVersion"] = selected["version"]?.DeepClone(), ["port"] = port, ["uiResponsive"] = alive?["data"]?["alive"]?.GetValue<bool>() == true, ["connectedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["hook"] = release ? "h1" : "dev", ["bridgeId"] = probed["manifest"]?["bridgeId"]?.DeepClone(), ["bridgeSha256"] = probed["manifest"]?["bridgeSha256"]?.DeepClone() };
            if (warning != null) record["warning"] = warning;
            Atomic(Path.Combine(root, "private/o11-connection.json"), record);
            return record;
        }
        finally { guard.Dispose(); File.Delete(lockPath); }
    }
}
