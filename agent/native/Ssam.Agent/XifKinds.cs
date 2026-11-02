using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Ssam.Agent;

// o11.xif (F4 of PLANO-11H), the rules of agent/lib/xif.mjs in the same order: the model and final stages of o11_extension with the
// Integration Studio installed on this machine, for a hosted SSAM server. The engine is the pack's own Anvil.Xif.Engine.exe (net472,
// x86; no OutSystems binary in the pack); the server sends one JSON request whose files are agent: paths of this operation's folder
// (agent:o11/xif/<operationId>/), never code, a script, an executable or a path of this machine. Integration Studio is found by the rule
// of the Studios (NativeHost.Installed): the uninstall key "OutSystems Integration Studio 11" (HKLM then HKCU, 64 then 32-bit view),
// its InstallLocation or the "Integration Studio" folder in it, then Program Files; a folder counts with OutSystems.IntegrationStudio.Core.dll.
// The table of what passes is the Node agent's (tests/fixtures/xif-table.mjs, check-xif-request).
internal sealed partial class XifKinds
{
    internal const string Name = "o11.xif";
    internal const string EngineExe = "Anvil.Xif.Engine.exe";
    internal const string Marker = "OutSystems.IntegrationStudio.Core.dll";
    internal const string Uninstall = "OutSystems Integration Studio 11";
    internal static readonly TimeSpan EngineTimeout = TimeSpan.FromMinutes(10);
    private static readonly Dictionary<string, string[]> Keys = new(StringComparer.Ordinal)
    {
        ["model"] = ["command", "operationId", "output", "spec", "references", "base"],
        ["final"] = ["command", "operationId", "output", "model", "dll", "name", "sources"],
    };
    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_]*\\z", RegexOptions.CultureInvariant)] private static partial Regex NamePattern();
    [GeneratedRegex("^[0-9a-f]{8,16}\\z", RegexOptions.CultureInvariant)] private static partial Regex OperationPattern();
    [GeneratedRegex("^[A-Z][A-Z0-9_]{1,60}\\z", RegexOptions.CultureInvariant)] private static partial Regex CodePattern();

    private readonly string root;
    private readonly Workspace workspace;
    internal readonly string? Engine;
    // The tests' seams (check-xif-run): the Integration Studio folder and the engine process.
    internal Func<string?>? Locate;
    internal Func<string, string, Dictionary<string, string?>, string, TimeSpan, CancellationToken, Task<(bool TimedOut, string Stdout)>>? Spawn;
    internal string Profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    internal XifKinds(string root, string? runtime, JsonObject? pack)
    {
        this.root = Path.GetFullPath(root);
        workspace = new Workspace(root);
        Engine = ResolveEngine(runtime, pack);
    }

    internal bool Available => Engine != null;

    // pack.json xifEngine {path, sha256}; without it, xif-engine\Anvil.Xif.Engine.exe of the runtime. Windows only.
    internal static string? ResolveEngine(string? runtime, JsonObject? pack)
    {
        if (!OperatingSystem.IsWindows() || runtime == null) return null;
        var relative = (pack?["xifEngine"] as JsonObject)?["path"]?.GetValue<string>() ?? "xif-engine/" + EngineExe;
        if (Path.IsPathRooted(relative) || relative.Split('/', '\\').Contains("..")) return null;
        var file = Path.Combine([runtime, .. relative.Split('/', '\\')]);
        if (!File.Exists(file)) return null;
        if ((pack?["xifEngine"] as JsonObject)?["sha256"]?.GetValue<string>() is string expected)
            try { if (!Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(file))).Equals(expected, StringComparison.OrdinalIgnoreCase)) return null; }
            catch (IOException) { return null; }
        return file;
    }

    // The Integration Studio folder: the candidates in order, the first with the marker DLL.
    internal static string? LocateIn(IEnumerable<string?> locations, IEnumerable<string?> programFiles, Func<string, bool> exists)
    {
        foreach (var location in locations)
        {
            if (string.IsNullOrWhiteSpace(location)) continue;
            foreach (var dir in new[] { location.Trim(), Path.Combine(location.Trim(), "Integration Studio") })
                if (exists(Path.Combine(dir, Marker))) return dir;
        }
        foreach (var programs in programFiles)
        {
            if (string.IsNullOrWhiteSpace(programs)) continue;
            var dir = Path.Combine(programs, "OutSystems", "Integration Studio");
            if (exists(Path.Combine(dir, Marker))) return dir;
        }
        return null;
    }

    internal static string? LocateIntegrationStudio()
    {
        var locations = new List<string?>();
        if (OperatingSystem.IsWindows()) foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser }) foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var basis = RegistryKey.OpenBaseKey(hive, view);
                using var key = basis.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\" + Uninstall);
                locations.Add(key?.GetValue("InstallLocation") as string);
            }
            catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
        }
        return LocateIn(locations, [Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramW6432")], File.Exists);
    }

    private static AgentFault Invalid(string message) => new("PARAMS_INVALID", message);
    private static AgentFault Forbidden(string message) => new("PATH_FORBIDDEN", message);
    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    // The engine request of one stage, every agent: path confined to this operation's folder (xif.mjs prepareXifRequest).
    internal (JsonObject Request, string Output, string Folder) Prepare(JsonNode? node)
    {
        if (node is not JsonObject p) throw Invalid("params must be an object");
        var command = Text(p["command"]);
        if (command == null || !Keys.TryGetValue(command, out var allowed)) throw Invalid("command must be model or final");
        foreach (var (key, _) in p) if (!allowed.Contains(key)) throw Invalid("unknown field " + key[..Math.Min(key.Length, 40)]);
        var operation = Text(p["operationId"]);
        if (operation == null || !OperationPattern().IsMatch(operation)) throw Invalid("operationId must be 8 to 16 hex digits");
        var prefix = "agent:o11/xif/" + operation + "/";
        string File(JsonNode? value, string field, bool write = false)
        {
            var text = Text(value);
            if (text == null || !text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw Forbidden(field + " must be a file of this operation (" + prefix + "...)");
            try { return workspace.Resolve(text, write); }
            catch (PathRefusal e) { throw new AgentFault(e.Code, e.Message); }
        }
        var name = command == "model" ? Text((p["spec"] as JsonObject)?["name"]) : Text(p["name"]);
        if (name == null || !NamePattern().IsMatch(name)) throw Invalid("the extension name is not valid");
        if (Text(p["output"]) != prefix + "out/" + name + ".xif") throw Forbidden("output must be " + prefix + "out/<name>.xif");
        var output = File(p["output"], "output", true);
        string folder;
        try { folder = workspace.Resolve(prefix.TrimEnd('/'), true); } catch (PathRefusal e) { throw new AgentFault(e.Code, e.Message); }
        var request = new JsonObject { ["command"] = command, ["work"] = Path.Combine(folder, "work"), ["output"] = output };
        if (command == "model")
        {
            if (p["spec"] is not JsonObject spec) throw Invalid("spec must be an object");
            if (spec.ContainsKey("references") || spec.ContainsKey("sources")) throw Invalid("spec carries no references or sources in this stage");
            var sent = (JsonObject)spec.DeepClone();
            if (spec["resources"] is JsonNode resources)
            {
                if (resources is not JsonArray list) throw Invalid("spec.resources must be a list");
                var mapped = new JsonArray();
                for (var i = 0; i < list.Count; i++)
                {
                    if (list[i] is not JsonObject r) throw Invalid("spec.resources[" + i + "] must be an object");
                    var copy = (JsonObject)r.DeepClone();
                    if (r.ContainsKey("file")) copy["file"] = File(r["file"], "spec.resources[" + i + "].file");
                    mapped.Add((JsonNode)copy);
                }
                sent["resources"] = mapped;
            }
            request["spec"] = sent;
            if (p["references"] is JsonNode refs && refs is not JsonArray) throw Invalid("references must be a list");
            request["references"] = new JsonArray(((p["references"] as JsonArray) ?? []).Select((r, i) => (JsonNode?)JsonValue.Create(File(r, "references[" + i + "]"))).ToArray());
            if (p["base"] != null) request["base"] = File(p["base"], "base");
        }
        else
        {
            request["name"] = name;
            request["model"] = File(p["model"], "model");
            request["dll"] = File(p["dll"], "dll");
            if (p["sources"] is not JsonArray sources) throw Invalid("sources must be a list");
            var mapped = new JsonArray();
            for (var i = 0; i < sources.Count; i++)
            {
                var path = Text((sources[i] as JsonObject)?["path"]);
                if (path == null || path.Length == 0 || path.Length > 260 || path.Any(c => c < 32 || ":*?\"<>|".Contains(c)) || path[0] is '/' or '\\'
                    || path.Split('/', '\\').Any(s => s is "" or "." or "..")) throw Invalid("sources[" + i + "].path must be a relative path inside the extension");
                mapped.Add((JsonNode)new JsonObject { ["path"] = path, ["file"] = File((sources[i] as JsonObject)?["file"], "sources[" + i + "].file") });
            }
            request["sources"] = mapped;
        }
        return (request, output, folder);
    }

    internal async Task<JsonNode> Execute(JsonObject p, long? deadline, CancellationToken token)
    {
        if (!OperatingSystem.IsWindows() && Spawn == null) throw new AgentFault("XIF_PLATFORM_UNAVAILABLE", "Integration Studio runs only on Windows; this SSAM agent does not build extensions on this system. Nothing was generated or sent.");
        var (request, output, folder) = Prepare(p);
        if (Engine == null && Spawn == null) throw new AgentFault("XIF_ENGINE_UNAVAILABLE", "This SSAM agent package does not carry the Integration Studio engine host; install the current SSAM Agent app. Nothing was generated or sent.");
        var studio = (Locate ?? LocateIntegrationStudio)();
        if (studio == null) throw new AgentFault("XIF_ENGINE_UNAVAILABLE", "Integration Studio 11 is not installed on the machine of the SSAM agent (it comes with the OutSystems Development Environment installer); install it, then call again. Nothing was generated or sent.");
        if (System.IO.File.Exists(output)) throw Forbidden("the output of this operation already exists");
        var work = Text(request["work"])!;
        var temp = Path.Combine(work, "engine-temp");
        Directory.CreateDirectory(temp);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var left = deadline is long due ? TimeSpan.FromMilliseconds(Math.Max(1000, due - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) : EngineTimeout;
        var timeout = left < EngineTimeout ? left : EngineTimeout;
        var env = new Dictionary<string, string?>
        {
            ["TEMP"] = temp, ["TMP"] = temp, ["ANVIL_INTEGRATION_STUDIO_DIR"] = studio,
        };
        var masks = new List<(string, string)> { (root, "[data]"), (studio, "[Integration Studio]") };
        if (Engine != null) masks.Add((Path.GetDirectoryName(Engine)!, "[runtime]"));
        if (!string.IsNullOrEmpty(Profile)) masks.Add((Profile, "[profile]"));
        (bool TimedOut, string Stdout) result;
        try { result = await (Spawn ?? Run)(Engine ?? "", request.ToJsonString(), env, work, timeout, token); }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or InvalidOperationException)
        { return Refusal("XIF_ENGINE_UNAVAILABLE", "The Integration Studio engine host did not start; nothing was sent.", null, masks); }
        finally { try { Directory.Delete(Path.Combine(folder, "in"), true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { } }
        if (result.TimedOut) return Refusal("XIF_ENGINE_UNAVAILABLE", "Integration Studio did not finish the " + Text(request["command"]) + " stage within " + (int)Math.Round(timeout.TotalMinutes) + " minutes; nothing was sent.", null, masks);
        var line = result.Stdout.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.StartsWith('{'));
        JsonObject? answer = null;
        try { answer = line == null ? null : JsonNode.Parse(line) as JsonObject; } catch (System.Text.Json.JsonException) { }
        if (answer == null) return Refusal("XIF_ENGINE_UNAVAILABLE", "The Integration Studio engine host answered nothing readable; nothing was sent.", null, masks);
        if (answer["ok"] is not JsonValue ok || !ok.TryGetValue<bool>(out var good) || !good)
            return Refusal(Text(answer["code"]) ?? "XIF_ENGINE_FAILED", Text(answer["error"]) ?? "engine failure", answer["problems"] as JsonArray, masks);
        if (!System.IO.File.Exists(output)) return Refusal("XIF_ENGINE_FAILED", "The engine reported a XIF it did not write; nothing was sent.", null, masks);
        var bytes = await System.IO.File.ReadAllBytesAsync(output, token);
        if (NamesProfile(bytes, Profile))
        {
            System.IO.File.Delete(output);
            return Refusal("XIF_VERIFY_FAILED", "The XIF names a folder of the user profile of this machine; it was removed and nothing was sent.", null, masks);
        }
        try { Directory.Delete(work, true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        var reports = answer["reports"] is JsonArray r ? Masked(new JsonArray(r.Take(200).Select(x => x?.DeepClone()).ToArray()), masks) : new JsonArray();
        return new JsonObject
        {
            ["ok"] = true, ["xif"] = Text(p["output"]), ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            ["studio"] = new JsonObject { ["version"] = Text(answer["studio"]?["version"]), ["lastUpgradeVersion"] = Text(answer["studio"]?["lastUpgradeVersion"]) },
            ["reports"] = reports,
        };
    }

    // Whether the XIF (a zlib stream of the Extension XML) names this machine's user profile.
    internal static bool NamesProfile(byte[] bytes, string? profile)
    {
        if (string.IsNullOrEmpty(profile)) return false;
        string text;
        try { using var input = new ZLibStream(new MemoryStream(bytes), CompressionMode.Decompress); using var reader = new StreamReader(input, Encoding.UTF8); text = reader.ReadToEnd(); }
        catch (InvalidDataException) { text = Encoding.Latin1.GetString(bytes); }
        return text.Contains(profile, StringComparison.OrdinalIgnoreCase);
    }

    private static JsonNode Masked(JsonNode node, List<(string From, string To)> masks)
    {
        string Mask(string text) { foreach (var (from, to) in masks) if (from.Length > 0) text = text.Replace(from, to, StringComparison.OrdinalIgnoreCase); return text.Length > 2000 ? text[..2000] : text; }
        return node switch
        {
            JsonValue value when value.TryGetValue<string>(out var text) => JsonValue.Create(Mask(text))!,
            JsonArray array => new JsonArray(array.Take(100).Select(x => x == null ? null : Masked(x, masks)).ToArray()),
            JsonObject obj => new JsonObject(obj.Select(pair => KeyValuePair.Create(pair.Key, pair.Value == null ? null : Masked(pair.Value, masks)))),
            _ => node.DeepClone(),
        };
    }

    private static JsonObject Refusal(string code, string error, JsonArray? problems, List<(string, string)> masks)
    {
        if (!CodePattern().IsMatch(code)) code = "XIF_ENGINE_FAILED";
        var list = new JsonArray();
        foreach (var item in (problems ?? []).Take(50).OfType<JsonObject>())
        {
            var p = new JsonObject { ["code"] = Text(item["code"]) is string c && CodePattern().IsMatch(c) ? c : code };
            if (Text(item["path"]) is string path) p["path"] = path;
            p["message"] = Text(item["message"]) ?? "";
            if (Text(item["fix"]) is string fix) p["fix"] = fix;
            list.Add((JsonNode)p);
        }
        if (list.Count == 0) list.Add((JsonNode)new JsonObject { ["code"] = code, ["message"] = error });
        return (JsonObject)Masked(new JsonObject { ["ok"] = false, ["code"] = code, ["error"] = error, ["problems"] = list }, masks);
    }

    // The engine process: one JSON request on stdin, its stdout; killed at the timeout.
    private static async Task<(bool TimedOut, string Stdout)> Run(string exe, string input, Dictionary<string, string?> env, string work, TimeSpan timeout, CancellationToken token)
    {
        var start = new ProcessStartInfo(exe)
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = work, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var (key, value) in env) start.Environment[key] = value;
        using var process = Process.Start(start) ?? throw new InvalidOperationException("The engine did not start");
        var stdout = process.StandardOutput.ReadToEndAsync(token);
        _ = process.StandardError.ReadToEndAsync(token);
        await using (var stdin = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))) await stdin.WriteAsync(input);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(timeout);
        try { await process.WaitForExitAsync(limit.Token); }
        catch (OperationCanceledException) { try { process.Kill(true); } catch (InvalidOperationException) { } return (true, ""); }
        return (false, await stdout);
    }
}
