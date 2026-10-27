using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Ssam.Agent;

internal sealed record MacBundle(string Root, string Lane, string Executable, string ManagedDir, string Entry, string? Version, JsonObject? RuntimeConfig);

internal static class MacPlatform
{
    internal static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    internal static string Tool(string executable, params string[] args)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["LC_ALL"] = "C";
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("The system tool could not start");
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(20000)) { process.Kill(); throw new IOException("The system tool timed out"); }
        Task.WaitAll(output, error);
        if (process.ExitCode != 0) throw new IOException("The system tool refused the request");
        return output.Result;
    }
    internal static bool Inside(string value, string parent) => value.Normalize().Equals(parent.TrimEnd(Path.DirectorySeparatorChar).Normalize(), StringComparison.Ordinal)
        || value.Normalize().StartsWith(parent.TrimEnd(Path.DirectorySeparatorChar).Normalize() + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    internal static string RealPath(string value)
    {
        var full = Path.GetFullPath(value); var current = Path.GetPathRoot(full)!;
        foreach (var part in full[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (info.LinkTarget != null) current = info.ResolveLinkTarget(true)?.FullName ?? throw new IOException("Unresolved symbolic link");
        }
        return current;
    }
    internal static void CheckRoot(string root, string? home = null)
    {
        home ??= Home;
        var target = root.TrimEnd('/').Normalize();
        if (!root.StartsWith('/') || root.Any(char.IsWhiteSpace) || target.Length == 0) throw new ArgumentException("Use an absolute dedicated data directory without whitespace");
        var folders = new[] { "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/opt", "/private", "/var", "/tmp", "/cores", "/dev", "/Volumes", "/Network",
            home + "/Library", home + "/Desktop", home + "/Documents", home + "/Downloads" };
        bool WithinFold(string a, string b) => a.Equals(b, StringComparison.OrdinalIgnoreCase) || a.StartsWith(b.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase);
        if (WithinFold(home, target) || folders.Any(f => WithinFold(target, f))) throw new ArgumentException("The data directory must be outside system, temporary and privacy-protected folders");
        var temporary = Environment.GetEnvironmentVariable("TMPDIR");
        if (!string.IsNullOrEmpty(temporary) && WithinFold(target, temporary.TrimEnd('/'))) throw new ArgumentException("The data directory must not be temporary");
    }
    private static bool Link(string file) => (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0;
    internal static string? SocketIdentity(string file)
    {
        try
        {
            if (!File.Exists(file)) return null;
            // BSD stat supplies the inode; FileInfo keeps subsecond birth time.
            return Tool("/usr/bin/stat", "-f", "%i", file).Trim() + ":" + File.GetCreationTimeUtc(file).Ticks;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }
    internal static IEnumerable<string> Bundles()
    {
        static string[] Children(string path)
        {
            try { return Directory.GetDirectories(path).Where(p => !Link(p)).ToArray(); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return []; }
        }
        foreach (var root in new[] { "/Applications", Path.Combine(Home, "Applications") })
        {
            if (!Directory.Exists(root)) continue;
            foreach (var first in Children(root))
            {
                if (Link(first)) continue;
                if (first.EndsWith(".app", StringComparison.OrdinalIgnoreCase)) { yield return first; continue; }
                foreach (var second in Children(first))
                    if (!Link(second) && second.EndsWith(".app", StringComparison.OrdinalIgnoreCase)) yield return second;
            }
        }
    }
    internal static MacBundle? Inspect(string bundle) => Inspect(bundle, 0, null);
    internal static MacBundle? InspectWithDiagnostics(string bundle, JsonArray diagnostics) => Inspect(bundle, 0, diagnostics);
    private static MacBundle? Inspect(string bundle, int depth, JsonArray? diagnostics)
    {
        var stage = "bundle";
        MacBundle? Reject(string reason)
        {
            diagnostics?.Add((JsonNode)new JsonObject { ["bundle"] = bundle, ["stage"] = stage, ["reason"] = reason });
            return null;
        }
        try
        {
            if (depth > 4) return Reject("Nested bundle depth limit exceeded");
            var contents = Path.Combine(bundle, "Contents");
            if (Link(bundle) || Link(contents)) return Reject("Bundle or Contents is a symbolic link");
            stage = "scan";
            // Record the launcher's immediate managed-file candidates even when
            // the bounded recursive scan cannot complete.
            var main = Path.Combine(contents, "MacOS");
            if (diagnostics != null && Directory.Exists(main))
            {
                var names = Directory.EnumerateFileSystemEntries(main).Select(Path.GetFileName).Where(n => n != null &&
                    (n.EndsWith(".runtimeconfig.json") || Regex.IsMatch(n, @"^(ServiceStudio|ODCStudio)(\.(dll|exe))?$"))).Order().Take(30);
                diagnostics.Add((JsonNode)new JsonObject { ["bundle"] = bundle, ["stage"] = stage,
                    ["candidates"] = new JsonArray(names.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()) });
            }
            var files = new Dictionary<string, string>(StringComparer.Ordinal);
            var queue = new Queue<string>(); queue.Enqueue(contents);
            var count = 0;
            while (queue.TryDequeue(out var folder))
            {
                if (++count > 400) return Reject("Folder scan limit exceeded (400)");
                foreach (var file in Directory.EnumerateFileSystemEntries(folder).Order(StringComparer.Ordinal))
                {
                    if (Link(file)) continue;
                    if (Directory.Exists(file)) { if (!Regex.IsMatch(file, @"\.(app|appex|xpc|dSYM)$", RegexOptions.IgnoreCase) && Path.GetFileName(file) != "_CodeSignature") queue.Enqueue(file); }
                    else files.TryAdd(Path.GetFileName(file), file);
                }
            }
            var odc = files.ContainsKey("ODCStudio.dll");
            var o11 = files.ContainsKey("ServiceStudio.dll");
            if (!odc && !o11)
            {
                // The official launcher wraps a same-named Studio bundle here.
                // Inspect that bundle's own plist and executable; never treat an
                // arbitrary helper .app as the Studio or follow a link outside it.
                var resources = Path.Combine(contents, "Resources");
                var app = Path.Combine(resources, "app");
                var nested = Path.Combine(app, Path.GetFileName(bundle));
                if (!Directory.Exists(nested) || Link(resources) || Link(app) || Link(nested)
                    || !Inside(RealPath(nested), RealPath(bundle))) return Reject("Managed entry assembly missing; no permitted nested bundle found");
                var inner = Inspect(nested, depth + 1, diagnostics);
                return inner == null ? null : inner with { Root = bundle };
            }
            if (odc && o11) return Reject("Both Studio entry assemblies found; ambiguous lane");
            var entry = odc ? "ODCStudio" : "ServiceStudio";
            stage = "plist";
            var plistPath = Path.Combine(contents, "Info.plist");
            // plutil understands all macOS plist formats and writes only stdout.
            // Feed bytes to XmlReader so BOMs and XML encoding declarations are
            // interpreted by the XML parser, not decoded as literal text content.
            var bytes = OperatingSystem.IsMacOS()
                ? System.Text.Encoding.UTF8.GetBytes(Tool("/usr/bin/plutil", "-convert", "xml1", "-o", "-", plistPath))
                : File.ReadAllBytes(plistPath);
            var document = ParsePlistXml(bytes);
            var values = document.Root?.Element("dict")?.Elements().ToArray() ?? [];
            string? Value(string key) { for (var i = 0; i + 1 < values.Length; i++) if (values[i].Name.LocalName == "key" && values[i].Value == key && values[i + 1].Name.LocalName == "string") return values[i + 1].Value; return null; }
            var executable = Value("CFBundleExecutable");
            if (string.IsNullOrEmpty(executable) || executable.Contains('/') || executable is "." or "..") return Reject("Missing or invalid CFBundleExecutable");
            stage = "executable";
            var path = Path.Combine(contents, "MacOS", executable);
            if (!File.Exists(path) || !Inside(RealPath(path), RealPath(bundle))) return Reject("Executable missing or outside bundle");
            if (!files.TryGetValue(entry + ".dll", out var assembly)) return Reject("Managed entry assembly missing");
            stage = "version";
            var managed = Path.GetDirectoryName(assembly)!;
            var version = FileVersionInfo.GetVersionInfo(assembly).ProductVersion;
            if (StudioKinds.Three(version) == null) version = Value("CFBundleShortVersionString") ?? Value("CFBundleVersion");
            return new(bundle, odc ? "odc" : "o11", path, managed, entry, version, O11Connection.Read(Path.Combine(managed, entry + ".runtimeconfig.json")));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or XmlException or ArgumentException) { return Reject(e.GetType().Name + ": " + e.Message); }
    }
    internal static MacBundle[] InstalledBundles() => Bundles().Select(bundle => Inspect(bundle)).OfType<MacBundle>().ToArray();
    internal static XDocument ParsePlistXml(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes, writable: false);
        using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null });
        return XDocument.Load(reader);
    }
    internal static JsonObject Installed()
    {
        var bundles = InstalledBundles(); var result = new JsonObject();
        foreach (var lane in new[] { "odc", "o11" })
        {
            var bundle = bundles.Where(b => b.Lane == lane).OrderByDescending(b => StudioKinds.Three(b.Version)).FirstOrDefault();
            result[lane] = new JsonObject { ["installed"] = bundle == null ? null : new JsonObject { ["dir"] = bundle.Root, ["version"] = bundle.Version } };
        }
        return result;
    }
    internal static JsonArray Processes(string image)
    {
        var lane = image switch { "ODCStudio.exe" => "odc", "ServiceStudio.exe" => "o11", _ => throw StudioKinds.Invalid("Unknown Studio image") };
        var bundles = InstalledBundles().Where(b => b.Lane == lane).ToArray();
        return MatchProcesses(bundles, Tool("/bin/ps", "-axww", "-o", "pid=,comm="));
    }
    internal static JsonArray MatchProcesses(MacBundle[] bundles, string processList)
    {
        var result = new JsonArray();
        foreach (var line in processList.Split('\n'))
        {
            var match = Regex.Match(line, @"^\s*(\d+)\s+(.+?)\s*$");
            if (!match.Success || !int.TryParse(match.Groups[1].Value, out var pid)) continue;
            var bundle = bundles.FirstOrDefault(b => b.Executable == match.Groups[2].Value || RealPath(b.Executable) == match.Groups[2].Value);
            if (bundle != null) result.Add((JsonNode)new JsonObject { ["pid"] = pid, ["path"] = bundle.Executable, ["version"] = bundle.Version });
        }
        return result;
    }
    internal static string[] TempFolders()
    {
        var folders = new List<string>();
        var tmp = Environment.GetEnvironmentVariable("TMPDIR"); if (tmp != null) folders.Add(tmp);
        try { folders.Add(Tool("/usr/bin/getconf", "DARWIN_USER_TEMP_DIR").Trim()); } catch (IOException) { }
        folders.Add(Path.GetTempPath()); folders.Add("/tmp"); folders.Add("/private/tmp");
        return folders.Where(p => p.StartsWith('/') && Directory.Exists(p)).Select(p => p.TrimEnd('/')).Distinct(StringComparer.Ordinal).ToArray();
    }
    internal static (string Path, long StartSeconds)? Endpoint(int pid) => DiagnosticIpc.UnixEndpoints(pid, TempFolders()).Select(e => ((string Path, long StartSeconds)?)e).FirstOrDefault();
    internal static async Task<JsonObject> Describe(string lane, int pid, CancellationToken token)
    {
        var record = Processes(lane == "odc" ? "ODCStudio.exe" : "ServiceStudio.exe").OfType<JsonObject>().FirstOrDefault(p => StudioKinds.Integer(p["pid"]) == pid)
            ?? throw new AgentFault("STUDIO_NOT_SELECTED", "No matching installed Studio is running");
        var executable = StudioKinds.Text(record["path"])!;
        var bundle = InstalledBundles().First(b => b.Executable == executable && b.Lane == lane);
        if (bundle.RuntimeConfig == null) throw new AgentFault("ATTACH_FAILED", "The Studio runtime configuration is missing or unreadable");
        var hookSetting = bundle.RuntimeConfig["runtimeOptions"]?["configProperties"]?["System.StartupHookProvider.IsSupported"]?.ToJsonString();
        if (hookSetting is "false" or "\"false\"") throw new AgentFault("ATTACH_FAILED", "The Studio disables startup hooks");
        using var process = Process.GetProcessById(pid);
        var started = process.StartTime.ToUniversalTime();
        var endpoint = Endpoint(pid);
        if (endpoint == null) throw new AgentFault("ATTACH_FAILED", "The Studio has no .NET diagnostic socket");
        var seconds = new DateTimeOffset(started).ToUnixTimeSeconds();
        if (Math.Abs(seconds - endpoint.Value.StartSeconds) > 1) throw new AgentFault("ATTACH_FAILED", "The diagnostic socket belongs to another process start");
        var identity = await DiagnosticIpc.ProcessInfo(endpoint.Value.Path, false, token);
        var actualPath = RealPath(executable);
        var command = identity.CommandLine ?? "";
        bool Starts(string prefix) => command == prefix || command.StartsWith(prefix + " ", StringComparison.Ordinal);
        if (identity.Pid != (ulong)pid || Path.GetFileNameWithoutExtension(identity.EntryPoint ?? "") != bundle.Entry || !(Starts(actualPath) || Starts('"' + actualPath + '"') || Starts("'" + actualPath + "'")) || !int.TryParse((identity.ClrVersion ?? "").Split('.')[0], out var major) || major < 8)
            throw new AgentFault("ATTACH_FAILED", "The diagnostic runtime identity differs from the selected Studio");
        var openFiles = Tool("/usr/sbin/lsof", "-p", pid.ToString(), "-Fn").Split('\n').Where(s => s.StartsWith('n')).Select(s => s[1..]).ToArray();
        if (lane == "o11" && !openFiles.Any(f => f.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))) throw new AgentFault("ATTACH_FAILED", "Loaded Studio assemblies could not be verified");
        return new() { ["ok"] = true, ["pid"] = pid, ["path"] = executable, ["version"] = bundle.Version, ["startedUtc"] = started.ToString("O"), ["diagnosticsAvailable"] = true,
            ["bridgePath"] = openFiles.FirstOrDefault(f => f.EndsWith("/Anvil.Bridge.dll", StringComparison.OrdinalIgnoreCase)), ["corePath"] = openFiles.FirstOrDefault(f => f.EndsWith("/Anvil.Core.dll", StringComparison.OrdinalIgnoreCase)), ["endpoint"] = endpoint.Value.Path };
    }
    internal static async Task Attach(string lane, int pid, string started, string hook, CancellationToken token)
    {
        var current = await Describe(lane, pid, token);
        if (StudioKinds.Text(current["startedUtc"]) != started || lane == "o11" && (current["bridgePath"] != null || current["corePath"] != null)) throw new AgentFault("ATTACH_FAILED", "The Studio changed before attachment; nothing was sent");
        try { await DiagnosticIpc.ApplyHook(StudioKinds.Text(current["endpoint"])!, false, hook, token); }
        catch (DiagnosticFault e) { throw new AgentFault("ATTACH_FAILED", e.Message, e.Sent ? null : false); }
    }

    internal static async Task<JsonObject> InspectHost()
    {
        if (!OperatingSystem.IsMacOS()) throw new ArgumentException("mac-inspect must run on the target Mac");
        var report = new JsonObject { ["schema"] = "ssam-native-mac-readiness/1", ["arch"] = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(), ["studios"] = Installed(), ["macOSValidated"] = false };
        var discovery = new JsonArray();
        foreach (var bundle in Bundles().Where(p => Path.GetFileName(p).Contains("Studio", StringComparison.OrdinalIgnoreCase))) InspectWithDiagnostics(bundle, discovery);
        report["bundleDiagnostics"] = discovery;
        var running = new JsonArray();
        foreach (var lane in new[] { "odc", "o11" }) foreach (var process in Processes(lane == "odc" ? "ODCStudio.exe" : "ServiceStudio.exe").OfType<JsonObject>())
        {
            var entry = (JsonObject)process.DeepClone(); entry["lane"] = lane;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try { entry["diagnostics"] = await Describe(lane, StudioKinds.Integer(process["pid"]), deadline.Token); }
            catch (AgentFault e) { entry["error"] = e.Code + ": " + e.Message; }
            catch (DiagnosticFault e) { entry["error"] = e.Code + ": " + e.Message; }
            catch (Exception e) when (e is IOException or InvalidOperationException or OperationCanceledException or System.ComponentModel.Win32Exception) { entry["error"] = e.GetType().Name; }
            running.Add((JsonNode)entry);
        }
        report["processes"] = running;
        return report;
    }
}
