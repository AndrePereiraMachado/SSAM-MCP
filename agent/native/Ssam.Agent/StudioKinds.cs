using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal sealed class StudioKinds(string root, string runtime, JsonObject pack, Func<JsonNode?> kernel)
{
    public static readonly string[] Names = ["studio.processes", "odc.pipe", "odc.attach", "o11.bridge", "o11.connect", "o11.selected"];
    internal static readonly HashSet<string> OdcCommands = ["status", "wait", "authorize", "open", "snapshot", "latest", "check-base", "preview", "merge", "publish", "publish-status", "publish-log", "dismiss-dialog", "close", "module-info", "assets", "consumers", "create", "create-app", "templates", "template-download", "refresh-references", "reference-snapshot", "reference-producers", "data", "data-insert", "data-update", "data-delete", "portal-call", "portal-session", "auth-status", "stop", "query-test"];
    internal static readonly HashSet<string> O11Methods = ["ping", "bridge_manifest", "get_active_module", "list_open_modules", "get_errors", "open_module", "close_module", "publish", "windows", "ui_alive", "close_dialog", "snapshot_module", "merge_from_oml", "merge_status", "environment_session", "sc_api", "sc_web", "sc_http", "studio_login", "sc_session", "publish_log", "refresh_references", "answer_dependencies_dialog"];
    private static readonly HashSet<string> Manifests = ["check-base", "preview", "merge", "publish", "publish-status", "create", "authorize", "create-app"];
    private readonly Workspace workspace = new(root);
    internal static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    internal static int Integer(JsonNode? node, int fallback = 0) => node is JsonValue v && v.TryGetValue<int>(out var n) ? n : fallback;
    internal static AgentFault Invalid(string message) => new("PARAMS_INVALID", message);
    internal void Lane(string lane)
    {
        if (pack["lanes"] is not JsonArray lanes || !lanes.Any(n => Text(n) == lane)) throw new AgentFault("LANE_DISABLED", "The installed pack does not carry this Studio lane");
    }
    internal static JsonArray Processes(string image)
    {
        if (image is not ("ODCStudio.exe" or "ServiceStudio.exe")) throw Invalid("Unknown Studio image");
        if (OperatingSystem.IsMacOS()) return MacPlatform.Processes(image);
        var result = new JsonArray();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(image)))
        {
            using (process)
            {
                try
                {
                    var file = process.MainModule?.FileName;
                    result.Add((JsonNode)new JsonObject { ["pid"] = process.Id, ["path"] = file,
                        ["version"] = file == null ? null : FileVersionInfo.GetVersionInfo(file).ProductVersion });
                }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException) { }
            }
        }
        return result;
    }
    internal static Version? Three(string? value)
    {
        var match = Regex.Match(value ?? "", @"^(\d+)\.(\d+)\.(\d+)");
        return match.Success && Version.TryParse(match.Value, out var v) ? v : null;
    }
    internal JsonObject CheckPid(string lane, JsonNode? value)
    {
        var pid = Integer(value);
        if (pid < 1) throw Invalid("pid must be a positive integer");
        var found = Processes(lane == "odc" ? "ODCStudio.exe" : "ServiceStudio.exe").OfType<JsonObject>().FirstOrDefault(p => Integer(p["pid"]) == pid)
            ?? throw new AgentFault("STUDIO_NOT_SELECTED", "The selected Studio process is not running");
        var actual = Three(Text(found["version"]));
        CheckExactBuild(pack, lane, Text(found["version"]));
        var expected = Three(Text(kernel()?[lane]));
        var window = (kernel()?["servedVersions"]?[lane] as JsonArray)?.Select(n => Three(Text(n))).ToArray() ?? [];
        if (expected == null || actual == null || actual != expected && !(window.Length > 0 && window.All(v => v != null && actual > v)))
            throw new AgentFault("STUDIO_VERSION_MISMATCH", "The Studio version does not match the server kernel");
        return found;
    }
    // Locally compiled Mac packs are bound to their exact host build, including
    // the fourth component. A Studio update requires rebuilding its bridge.
    internal static void CheckExactBuild(JsonObject pack, string lane, string? actual)
    {
        if (pack["studioBuilds"] is not JsonObject builds) return;
        var built = Text(builds[lane]?["version"]);
        if (built == null || actual == null || !Version.TryParse(built, out var expected)
            || !Version.TryParse(actual, out var current) || expected != current)
            throw new AgentFault("STUDIO_BRIDGE_REBUILD_REQUIRED", "Rebuild the local bridge for this exact Studio version before connecting");
    }
    internal JsonObject? CheckO11Build(string? actual)
    {
        var built = Text(pack["o11BuiltFor"]);
        if (built == null || Three(built) == Three(actual)) return null;
        var versions = (kernel()?["servedVersions"]?["o11"] as JsonArray)?.Select(n => Three(Text(n))).Where(v => v != null).ToArray() ?? [];
        var current = Three(actual);
        if (!versions.Contains(Three(built)) || current == null || !(versions.Contains(current) || versions.Length > 0 && versions.All(v => current > v)))
            throw new AgentFault("STUDIO_VERSION_MISMATCH", "This bridge build and Studio version are outside the server compatibility window");
        return new() { ["code"] = "O11_BRIDGE_BUILT_FOR_DIFFERS", ["builtFor"] = built, ["studio"] = actual,
            ["message"] = "The bridge was built for another version within the server compatibility window. Check the result in Service Studio before publishing." };
    }
    private static Dictionary<int, bool> Positions(string[] words)
    {
        var roles = new Dictionary<int, bool>();
        if (Manifests.Contains(words[0]) && words.Length > 1) roles[1] = true;
        if (words[0] == "open" && words.Length > 2) roles[2] = false;
        if (words[0] == "portal-call" && words.Length > 1) roles[1] = false;
        if (words[0] == "portal-session" && words.Length > 2 && words[1] == "fetch") roles[2] = false;
        var flag = words[0] switch { "data-insert" or "data-update" => "--records-file", "data" => "--out", _ => null };
        for (var i = 0; flag != null && i + 1 < words.Length; i++) if (words[i] == flag) roles[i + 1] = words[0] == "data";
        return roles;
    }
    private string BridgePath(JsonNode? value, bool write)
    {
        var text = Text(value);
        if (text == null || !text.StartsWith("agent:")) throw new AgentFault("PATH_NOT_AGENT", "Bridge paths must use agent:<relative path>");
        if (text.Any(char.IsWhiteSpace)) throw new AgentFault("PATH_FORBIDDEN", "Bridge paths may not contain whitespace");
        return workspace.Resolve(text, write);
    }
    internal string[] MapOdc(JsonObject p)
    {
        if (p["args"] is not JsonArray array || array.Count == 0) throw Invalid("args must be a non-empty array");
        var words = array.Select(n => Text(n) ?? (n is JsonValue v && v.TryGetValue<double>(out var d) ? d.ToString(CultureInfo.InvariantCulture) : throw Invalid("args must contain strings or numbers"))).ToArray();
        if (words.Any(s => s.IndexOfAny(['\r', '\n', '\0']) >= 0) || !OdcCommands.Contains(words[0])) throw new AgentFault("COMMAND_NOT_ALLOWED", "This command is not permitted on the agent");
        if (words[0] is "reference-snapshot" or "query-test")
        {
            JsonObject request;
            try { request = JsonNode.Parse(string.Join(' ', words.Skip(1))) as JsonObject ?? throw Invalid("Expected a JSON object"); }
            catch (System.Text.Json.JsonException) { throw Invalid("Expected a JSON object"); }
            if (words[0] == "reference-snapshot") request["output"] = BridgePath(request["output"], true);
            else if (request["source"] != null) request["source"] = BridgePath(request["source"], false);
            words = [words[0], request.ToJsonString()];
        }
        var roles = Positions(words);
        for (var i = 0; i < words.Length; i++) words[i] = roles.TryGetValue(i, out var write) ? BridgePath(JsonValue.Create(words[i]), write)
            : Regex.Replace(words[i], @"(^|\s)(agent:\S*)", m => m.Groups[1].Value + workspace.Resolve(m.Groups[2].Value));
        var final = Regex.Split(string.Join(' ', words), @"\s+").Where(s => s.Length > 0).ToArray();
        roles = words[0] is "reference-snapshot" or "query-test" ? [] : Positions(final);
        for (var i = 0; i < final.Length; i++)
            if (roles.ContainsKey(i) || Regex.IsMatch(final[i], @"^[A-Za-z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$)")) workspace.CheckAbsolute(final[i], roles.GetValueOrDefault(i));
        if (Manifests.Contains(words[0]) && words.Length > 1 && File.Exists(words[1]))
        {
            JsonNode? manifest;
            try { manifest = JsonNode.Parse(File.ReadAllText(words[1]).TrimStart('\uFEFF')); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("PATH_FORBIDDEN", "Manifest must be JSON with checked paths"); }
            if (manifest is JsonObject obj) foreach (var entry in obj)
            {
                if (entry.Key.ToLowerInvariant() is not ("basepath" or "candidatepath" or "producerpath" or "builderreceipt" or "evidencedir") || entry.Value == null || Text(entry.Value) == "") continue;
                workspace.CheckAbsolute(Text(entry.Value) ?? throw new AgentFault("PATH_FORBIDDEN", "Manifest path must be a string"), entry.Key.Equals("evidenceDir", StringComparison.OrdinalIgnoreCase));
            }
        }
        return words;
    }
    internal JsonObject MapO11(string method, JsonObject p)
    {
        if (!O11Methods.Contains(method)) throw new AgentFault("METHOD_NOT_ALLOWED", "This bridge method is not permitted");
        p = (JsonObject)p.DeepClone();
        string At(JsonNode? node, bool write)
        {
            var text = Text(node) ?? throw new AgentFault("PATH_NOT_AGENT", "Expected an agent path");
            var file = workspace.Resolve(text, write);
            if (write && !Regex.IsMatch(text, @"^agent:o11[\\/]", RegexOptions.IgnoreCase)) throw new AgentFault("PATH_FORBIDDEN", "O11 output must remain in agent:o11/");
            return file;
        }
        if (method == "snapshot_module") p["path"] = At(p["path"], true);
        if (method == "merge_from_oml") foreach (var name in new[] { "foreign_path", "base_path", "first_pass_path" })
            if (name == "foreign_path" || p[name] != null) p[name] = At(p[name], false);
        if (method == "environment_session" && Text(p["operation"]) == "download")
        {
            if (p["arguments"] is not JsonObject a) throw new AgentFault("PATH_NOT_AGENT", "Download requires arguments.outputDirectory");
            a["outputDirectory"] = At(a["outputDirectory"], true);
        }
        if (method is "sc_api" or "sc_web" or "sc_http" && p["args"] is JsonObject args)
        {
            if (args["outFile"] != null) throw new AgentFault("PATH_FORBIDDEN", "outFile is not accepted; results return in the reply");
            if (method == "sc_api" && args["file"] != null) args["file"] = At(args["file"], false);
        }
        return p;
    }
    internal JsonNode? Relativize(JsonNode? node, JsonArray paths, JsonArray? keys = null)
    {
        keys ??= [];
        if (Text(node) is string value && workspace.ToAgent(value) is string relative) { paths.Add(keys.DeepClone()); return JsonValue.Create(relative); }
        if (node is JsonObject obj)
        {
            var result = new JsonObject();
            foreach (var entry in obj) { var next = (JsonArray)keys.DeepClone(); next.Add((JsonNode)JsonValue.Create(entry.Key)); result[entry.Key] = Relativize(entry.Value, paths, next); }
            return result;
        }
        if (node is JsonArray array)
        {
            var result = new JsonArray();
            for (var i = 0; i < array.Count; i++) { var next = (JsonArray)keys.DeepClone(); next.Add((JsonNode)JsonValue.Create(i)); result.Add(Relativize(array[i], paths, next)); }
            return result;
        }
        return node?.DeepClone();
    }
    internal async Task Bind(int pid, string version, CancellationToken token, bool? executed = false)
    {
        if (!Regex.IsMatch(version, @"^v\d+$") || !int.TryParse(version[1..], out var number) || number < 98) throw new AgentFault("BRIDGE_VERSION_MISMATCH", "Native installed runtimes require ODC bridge v98 or newer");
        var data = Path.Combine(root, "odc");
        try
        {
            var reply = JsonNode.Parse(await StudioWire.Pipe(pid, version, ["agent-root", new JsonObject { ["root"] = data }.ToJsonString()], 10000, token, 10000));
            if (reply?["ok"]?.GetValue<bool>() == true && Integer(reply["protocol"]) == 1 && Text(reply["root"]) == data) return;
        }
        catch (AgentFault e) { throw new AgentFault(e.Code, e.Message, executed) { Sent = false }; }
        catch (System.Text.Json.JsonException) { }
        throw new AgentFault("ODC_DATA_ROOT_FAILED", "The bridge did not confirm its data directory; no application command was sent", executed);
    }
    internal static bool SelfContainedHelper(string dll)
    {
        var folder = Path.GetDirectoryName(dll)!;
        if (!File.Exists(Path.ChangeExtension(dll, ".exe")) || !File.Exists(Path.Combine(folder, "hostfxr.dll"))
            || !File.Exists(Path.Combine(folder, "hostpolicy.dll")) || !File.Exists(Path.Combine(folder, "coreclr.dll"))) return false;
        try
        {
            var options = JsonNode.Parse(File.ReadAllText(Path.ChangeExtension(dll, ".runtimeconfig.json")))?["runtimeOptions"];
            return options?["includedFrameworks"] is JsonArray frameworks && frameworks.Count > 0
                && options["framework"] == null && options["frameworks"] == null;
        }
        catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { return false; }
    }
    internal static async Task<JsonObject> Helper(string dll, string[] args, int timeout, bool mutation, CancellationToken token)
    {
        if (!File.Exists(dll)) throw new AgentFault("ATTACH_FAILED", "The installed runtime is missing a Studio helper");
        var bundled = OperatingSystem.IsWindows() && SelfContainedHelper(dll);
        var info = new ProcessStartInfo(bundled ? Path.ChangeExtension(dll, ".exe") : "dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (!bundled) info.ArgumentList.Add(dll);
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var child = new Process { StartInfo = info };
        var started = false;
        try
        {
            started = child.Start();
            var output = child.StandardOutput.ReadToEndAsync(token);
            var error = child.StandardError.ReadToEndAsync(token);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(timeout);
            await child.WaitForExitAsync(deadline.Token);
            await error;
            var reply = JsonNode.Parse(await output) as JsonObject ?? throw new IOException();
            return reply;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or OperationCanceledException or System.Text.Json.JsonException)
        {
            if (started) try { child.Kill(true); } catch (InvalidOperationException) { }
            throw new AgentFault("ATTACH_FAILED", "The Studio helper did not confirm its result; a started attach must not be repeated", started && mutation ? null : false);
        }
    }
    public async Task<JsonNode?> Execute(string kind, JsonObject p, CancellationToken token)
    {
        if (kind == "studio.processes") return new JsonObject { ["processes"] = Processes(Text(p["image"]) ?? "") };
        var lane = kind.StartsWith("odc.") ? "odc" : "o11";
        Lane(lane);
        if (kind is "o11.connect" or "o11.selected") return await new O11Connection(root, runtime, pack, this).Execute(kind, p, token);
        if (kind == "o11.bridge")
        {
            var method = Text(p["method"]) ?? "";
            var mapped = MapO11(method, p["params"] as JsonObject ?? (p["params"] == null ? new JsonObject() : throw Invalid("params must be an object")));
            var record = O11Connection.Record(root) ?? throw new AgentFault("O11_NOT_CONNECTED", "Connect a Service Studio first");
            var key = O11Connection.Key(root) ?? throw new AgentFault("O11_NOT_CONNECTED", "The local bridge key is missing");
            var limit = Integer(p["timeoutMs"]);
            var reply = await StudioWire.Bridge(Integer(record["port"]), key, method, mapped, token, limit > 0 ? Math.Min(limit, 3600000) : null);
            var paths = new JsonArray();
            return new JsonObject { ["reply"] = Relativize(reply, paths), ["paths"] = paths };
        }
        var version = Text(pack["odcBridge"]) ?? "";
        if (!Regex.IsMatch(version, @"^v\d+$") || Integer(JsonValue.Create(int.TryParse(version[1..], out var n) ? n : 0)) < 98) throw new AgentFault("BRIDGE_VERSION_MISMATCH", "ODC bridge v98 or newer is required");
        if (kind == "odc.pipe" && Text(p["version"]) != version) throw new AgentFault("BRIDGE_VERSION_MISMATCH", "The requested bridge version differs from the installed pack");
        var words = kind == "odc.pipe" ? MapOdc(p) : [];
        var target = CheckPid("odc", p["pid"]);
        var pid = Integer(target["pid"]);
        if (kind == "odc.attach")
        {
            var client = Path.Combine(runtime, "odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll");
            var bridge = Path.Combine(runtime, $"odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.{version}.dll");
            if (!File.Exists(bridge)) throw new AgentFault("ATTACH_FAILED", "The installed bridge is missing");
            JsonObject result;
            if (OperatingSystem.IsMacOS())
            {
                var identity = await MacPlatform.Describe("odc", pid, token);
                await MacPlatform.Attach("odc", pid, Text(identity["startedUtc"])!, bridge, token);
                result = new() { ["ok"] = true, ["attached"] = true };
            }
            else result = await Helper(client, [pid.ToString(), "attach", bridge], 90000, true, token);
            if (result["ok"]?.GetValue<bool>() == true && result["attached"]?.GetValue<bool>() == true) await Bind(pid, version, token, null);
            return new JsonObject { ["ok"] = result["ok"]?.DeepClone(), ["attached"] = result["attached"]?.DeepClone(), ["pid"] = pid, ["version"] = version, ["note"] = (result["note"] ?? result["error"])?.DeepClone() };
        }
        await Bind(pid, version, token);
        var line = await StudioWire.Pipe(pid, version, words, Math.Clamp(Integer(p["connectMs"], 10000), 1, 120000), token);
        var resultPaths = new JsonArray();
        try { line = Relativize(JsonNode.Parse(line), resultPaths)?.ToJsonString() ?? "null"; } catch (System.Text.Json.JsonException) { }
        return new JsonObject { ["line"] = line, ["paths"] = resultPaths };
    }
}
