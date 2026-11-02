using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal sealed class StudioKinds(string root, string runtime, JsonObject pack, Func<JsonNode?> kernel, BridgeUpdates? bridges = null)
{
    public static readonly string[] Names = ["studio.processes", "odc.pipe", "odc.attach", "o11.bridge", "o11.connect", "o11.selected"];
    // reconcile-merge (0.4.3-native, U1 of the server line): the ODC bridge's verification of a merge that returned, nothing merged or
    // published; from bridge v106 on a merge may return before it ran. The hello lists these commands (agent.odcCommands, in this
    // order), and the server offers the bridges from v106 on only to an agent that runs reconcile-merge (bridge-store.mjs).
    internal static readonly string[] OdcCommandList = ["status", "wait", "authorize", "open", "snapshot", "latest", "check-base", "preview", "merge", "reconcile-merge", "publish", "publish-status", "publish-log", "dismiss-dialog", "close", "module-info", "assets", "consumers", "create", "create-app", "templates", "template-download", "refresh-references", "reference-snapshot", "reference-producers", "data", "data-insert", "data-update", "data-delete", "portal-call", "portal-session", "auth-status", "stop", "query-test"];
    internal static readonly HashSet<string> OdcCommands = [.. OdcCommandList];
    internal static IEnumerable<string> OdcDeclared(JsonObject? pack) {
        var version = Text(pack?["odcBridge"]);
        return version is { Length: > 1 } && version[0] == 'v' && int.TryParse(version[1..], out var n) && n >= 108
            ? OdcCommandList.Append("merge:prefer-foreign") : OdcCommandList;
    }
    // integration_import (0.4.4-native, thin O11 bridge 1.1.0, fase4-28 r4-f3-import): the Studio's own SOAP/OpenAPI importer on a
    // detached copy of the snapshot, its paths agent paths (MapO11). The hello lists these methods (agent.o11Methods, in this
    // order), and the server sends the import only to an agent that lists it.
    internal static readonly string[] O11MethodList = ["ping", "bridge_manifest", "get_active_module", "list_open_modules", "get_errors", "open_module", "close_module", "publish", "windows", "ui_alive", "close_dialog", "snapshot_module", "merge_from_oml", "merge_status", "environment_session", "sc_api", "sc_web", "sc_http", "studio_login", "sc_session", "publish_log", "refresh_references", "integration_import", "answer_dependencies_dialog"];
    internal static readonly HashSet<string> O11Methods = [.. O11MethodList];
    // 0.4.6-native (agent/r4-prefer-foreign): what the hello's agent.o11Methods declares, the methods above and merge_from_oml:prefer_foreign
    // (thin O11 bridge 1.2.0: merge_from_oml {prefer:"foreign"}); never a method o11.bridge passes (O11Methods is that list).
    internal const string O11PreferForeign = "merge_from_oml:prefer_foreign";
    internal static readonly string[] O11DeclaredList = [.. O11MethodList, O11PreferForeign];
    private static readonly HashSet<string> Manifests = ["check-base", "preview", "merge", "reconcile-merge", "publish", "publish-status", "create", "authorize", "create-app"];
    private readonly Workspace workspace = new(root);
    private readonly SemaphoreSlim attachGate = new(1, 1);
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
                        ["version"] = file == null ? null : FileVersionInfo.GetVersionInfo(file).ProductVersion, ["startedUtc"] = process.StartTime.ToUniversalTime().ToString("O") });
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
    internal static JsonObject Instance(JsonObject target)
    {
        var start = Text(target["startedUtc"]);
        if (start == null) try { using var process = Process.GetProcessById(Integer(target["pid"])); start = process.StartTime.ToUniversalTime().ToString("O"); } catch (ArgumentException) { }
        return new() { ["pid"] = target["pid"]?.DeepClone(), ["startedUtc"] = start };
    }
    internal JsonObject CheckPid(string lane, JsonNode? value, bool exactBuild = true)
    {
        var pid = Integer(value);
        if (pid < 1) throw Invalid("pid must be a positive integer");
        var found = Processes(lane == "odc" ? "ODCStudio.exe" : "ServiceStudio.exe").OfType<JsonObject>().FirstOrDefault(p => Integer(p["pid"]) == pid)
            ?? throw new AgentFault("STUDIO_NOT_SELECTED", "The selected Studio process is not running");
        var actual = Three(Text(found["version"]));
        if (exactBuild) CheckExactBuild(pack, lane, Text(found["version"]));
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
    internal JsonObject? CheckO11Build(string? actual, JsonObject? effective = null)
    {
        // effective: the pack as this Studio sees it (O11Builds.PackFor), so a pack with a build for this version matches.
        var built = Text((effective ?? pack)["o11BuiltFor"]);
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
        if (method == "integration_import")
        {
            p["base_path"] = At(p["base_path"], false);
            p["document_path"] = At(p["document_path"], false);
            if (p["dependencies"] is JsonArray dependencies)
                foreach (var dependency in dependencies)
                {
                    if (dependency is not JsonObject d) throw Invalid("Each integration_import dependency is {uri, path, sha256}");
                    d["path"] = At(d["path"], false);
                }
            else if (p["dependencies"] != null) throw Invalid("integration_import dependencies is a list of {uri, path, sha256}");
            p["out_path"] = At(p["out_path"], true);
        }
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
    // The bridge loaded in a Studio is the one this agent knows per process. When the kernel serves both the version asked for and
    // the one loaded, the call goes to the one loaded: nothing else can answer it (agent/lib/kinds.mjs servedTogether).
    internal static bool ServedTogether(JsonNode? kernel, string? asked, string? loaded)
    {
        var served = new List<string?> { Text(kernel?["odcBridge"]) };
        if (kernel?["odcBridgeAccepted"] is JsonArray accepted) served.AddRange(accepted.Select(Text));
        return asked != null && loaded != null && served.Contains(asked) && served.Contains(loaded);
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
        var started = false; var diagnostic = "";
        try
        {
            started = child.Start();
            var output = child.StandardOutput.ReadToEndAsync(token);
            var error = child.StandardError.ReadToEndAsync(token);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(timeout);
            await child.WaitForExitAsync(deadline.Token);
            diagnostic = await error;
            var reply = JsonNode.Parse(await output) as JsonObject ?? throw new IOException();
            return reply;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or OperationCanceledException or System.Text.Json.JsonException)
        {
            if (started) try { child.Kill(true); } catch (InvalidOperationException) { }
            var attempted = mutation && diagnostic.Contains("ApplyStartupHook", StringComparison.Ordinal);
            throw new AgentFault("ATTACH_FAILED", "The Studio helper did not confirm its result; a started attach must not be repeated", started && mutation ? null : false)
                { AttachAttempted = attempted, BridgeLoadFailure = attempted && Regex.IsMatch(diagnostic, "BadImageFormat|FileLoadException|FileNotFoundException|UnsupportedCommandException|ServerErrorException") && !Regex.IsMatch(diagnostic, "TimeoutException|TaskCanceledException|OperationCanceledException") };
        }
    }
    public async Task<JsonNode?> Execute(string kind, JsonObject p, CancellationToken token)
    {
        if (kind != "odc.attach") return await ExecuteCore(kind, p, token);
        await attachGate.WaitAsync(token);
        try { return await ExecuteCore(kind, p, token); }
        finally { attachGate.Release(); }
    }
    private async Task<JsonNode?> ExecuteCore(string kind, JsonObject p, CancellationToken token)
    {
        if (kind == "studio.processes") return new JsonObject { ["processes"] = Processes(Text(p["image"]) ?? "") };
        var lane = kind.StartsWith("odc.") ? "odc" : "o11";
        Lane(lane);
        if (kind is "o11.connect" or "o11.selected")
        {
            if (kind == "o11.selected" || bridges == null) return await new O11Connection(root, runtime, pack, this).Execute(kind, p, token);
            var candidates = Processes("ServiceStudio.exe").OfType<JsonObject>().Where(n => p["pid"] == null || Integer(n["pid"]) == Integer(p["pid"])).ToArray();
            if (candidates.Length != 1) throw new AgentFault("STUDIO_NOT_SELECTED", "Select exactly one running Service Studio with pid");
            var o11Target = CheckPid("o11", candidates[0]["pid"], false);
            var instance = Instance(o11Target);
            var selected = await bridges.Select("o11", Text(o11Target["version"]), BridgeUpdates.StudioRuntime(Text(o11Target["path"]), "o11"), token, instance);
            if (selected == null) return await new O11Connection(root, runtime, pack, this).Execute(kind, p, token);
            var activePack = (JsonObject)pack.DeepClone(); activePack.Remove("studioBuilds");
            activePack["o11BuiltFor"] = selected.Manifest["studioVersion"]?.DeepClone();
            activePack["o11Hook"] = "d1";
            activePack["o11Bridge"] = new JsonObject { ["sha256"] = ((JsonArray)selected.Manifest["files"]!).FirstOrDefault(f => Path.GetFileName(Text(f?["path"])) == "Anvil.Bridge.dll")?["sha256"]?.DeepClone() };
            try
            {
                var result = await new O11Connection(root, selected.Root, activePack, this, runtime, true, selected, bridges).Execute(kind, p, token);
                bridges.MarkActive(selected, instance); return result;
            }
            catch (Exception error) when (!token.IsCancellationRequested)
            {
                if (error is AgentFault fault) bridges.RejectLoad(selected, error.Message, instance, fault.AttachAttempted, fault.BridgeLoadFailure);
                throw;
            }
        }
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
        var target = CheckPid("odc", p["pid"], false);
        var context = Instance(target);
        var selectedBridge = kind == "odc.attach" && bridges != null ? await bridges.Select("odc", Text(target["version"]), BridgeUpdates.StudioRuntime(Text(target["path"]), "odc"), token, context) : null;
        if (selectedBridge != null && bridges!.IsActive(selectedBridge, context)) {
            await Bind(Integer(target["pid"]), selectedBridge.Protocol, token, null);
            return new JsonObject { ["ok"] = true, ["attached"] = true, ["reused"] = true, ["pid"] = target["pid"]?.DeepClone(), ["version"] = selectedBridge.Protocol };
        }
        if (kind == "odc.attach" && selectedBridge == null) CheckExactBuild(pack, "odc", Text(target["version"]));
        var version = selectedBridge?.Protocol ?? (kind == "odc.pipe" ? bridges?.ProtocolFor("odc", Text(target["version"]), context) : null) ?? Text(pack["odcBridge"]) ?? "";
        if (!Regex.IsMatch(version, @"^v\d+$") || Integer(JsonValue.Create(int.TryParse(version[1..], out var n) ? n : 0)) < 98) throw new AgentFault("BRIDGE_VERSION_MISMATCH", "ODC bridge v98 or newer is required");
        if (kind == "odc.pipe" && Text(p["version"]) != version && !ServedTogether(kernel(), Text(p["version"]), version)) throw new AgentFault("BRIDGE_VERSION_MISMATCH", "This Studio runs another ODC bridge than the server asked for");
        var words = kind == "odc.pipe" ? MapOdc(p) : [];
        var pid = Integer(target["pid"]);
        if (kind == "odc.attach")
        {
            var lease = selectedBridge == null ? null : await bridges!.PrepareAttach(selectedBridge, context, token);
            try {
            var client = lease?.Bridge.FileNamed("ODC3.Bridge.Client.dll") ?? Path.Combine(runtime, "odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll");
            var bridge = lease?.Bridge.FileNamed($"ODC3.Bridge.{version}.dll", "ODC3.Bridge.dll") ?? Path.Combine(runtime, $"odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.{version}.dll");
            JsonObject result;
            try
            {
            if (!File.Exists(bridge)) throw new AgentFault("ATTACH_FAILED", "The installed bridge is missing");
            if (lease?.MayBeLoaded == true) throw new AgentFault("ATTACH_FAILED", "A previous attach may have executed; restart the Studio before retrying", null);
            lease?.Retain();
            if (OperatingSystem.IsMacOS())
            {
                var identity = await MacPlatform.Describe("odc", pid, token);
                await MacPlatform.Attach("odc", pid, Text(identity["startedUtc"])!, bridge, token);
                result = new() { ["ok"] = true, ["attached"] = true };
            }
            else result = await Helper(client, [pid.ToString(), "attach", bridge], 90000, true, token);
            if (selectedBridge != null && (result["ok"]?.GetValue<bool>() != true || result["attached"]?.GetValue<bool>() != true)) throw new AgentFault("ATTACH_FAILED", "Bridge load was not confirmed", null)
                { AttachAttempted = false, BridgeLoadFailure = false };
            }
            catch (Exception error) when (selectedBridge != null && !token.IsCancellationRequested)
            {
                if (error is AgentFault fault) bridges!.RejectLoad(selectedBridge, error.Message, context, fault.AttachAttempted, fault.BridgeLoadFailure);
                lease?.Dispose();
                throw;
            }
            if (selectedBridge != null) bridges!.MarkActive(selectedBridge, context);
            if (result["ok"]?.GetValue<bool>() == true && result["attached"]?.GetValue<bool>() == true) await Bind(pid, version, token, null);
            return new JsonObject { ["ok"] = result["ok"]?.DeepClone(), ["attached"] = result["attached"]?.DeepClone(), ["pid"] = pid, ["version"] = version, ["note"] = (result["note"] ?? result["error"])?.DeepClone() };
            } catch { lease?.Dispose(); throw; }
        }
        await Bind(pid, version, token);
        // The reply deadline of the server's one table (bridge-deadlines.json), as o11.bridge above: an agent never cuts before the bridge gives up.
        var replyMs = Integer(p["timeoutMs"]);
        var line = await StudioWire.Pipe(pid, version, words, Math.Clamp(Integer(p["connectMs"], 10000), 1, 120000), token, replyMs > 0 ? Math.Min(replyMs, 3600000) : null);
        var resultPaths = new JsonArray();
        try { line = Relativize(JsonNode.Parse(line), resultPaths)?.ToJsonString() ?? "null"; } catch (System.Text.Json.JsonException) { }
        return new JsonObject { ["line"] = line, ["paths"] = resultPaths };
    }
}
