using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Ssam.Agent.StudioKinds;

namespace Ssam.Agent;

internal sealed record InstalledBridge(JsonObject Manifest, string Root, string Digest)
{
    internal string Protocol => StudioKinds.Text(Manifest["protocol"])!;
    internal string FileNamed(params string[] names)
    {
        var matches = ((JsonArray)Manifest["files"]!).OfType<JsonObject>().Select(f => StudioKinds.Text(f["path"])!).Where(f => names.Contains(Path.GetFileName(f))).ToArray();
        if (matches.Length != 1) throw new IOException("The downloaded bridge layout is missing or ambiguous");
        return Path.Combine(Root, matches[0]);
    }
}

internal sealed class BridgeUpdates(string root, string runtime, string publicKey = BridgeTrust.ManifestPublicKey,
    string thumbprint = BridgeTrust.AuthenticodeThumbprint, Func<string, CancellationToken, Task>? authenticode = null, JsonObject? pack = null) : IDisposable
{
    internal const string MacReason = "Automatic bridge downloads are disabled on macOS in this build; use the bundled bridge.";
    private string Home => Path.Combine(root, "bridges");
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly object stateGate = new();
    private readonly JsonObject state = ReadState(root);
    private readonly Dictionary<string, (string Stamp, InstalledBridge Bridge)> cache = [];
    private readonly List<BridgeLease> leases = [];
    internal JsonObject? Status { get; private set; } = O11Connection.Read(Path.Combine(root, "private/bridge-update.json"));
    internal Action? Changed { get; set; }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static int ProtocolNumber(string? protocol) => Regex.IsMatch(protocol ?? "", @"^[vd](0|[1-9]\d{0,8})$") ? int.Parse(protocol![1..], CultureInfo.InvariantCulture) : -1;
    private static long Sequence(JsonNode m) => m["sequence"]?.GetValue<long>() ?? 0;
    private static string Pair(JsonNode m) => Text(m["lane"]) + "/" + Text(m["studioVersion"]);
    private static string Identity(JsonNode m) => Pair(m) + "/" + Text(m["protocol"]) + "/" + Sequence(m);
    private static JsonObject ReadState(string root)
    {
        var file = Path.Combine(root, "private/bridge-state.json");
        foreach (var candidate in new[] { Path.Combine(root, "private"), file })
            if ((File.Exists(candidate) || Directory.Exists(candidate)) && File.GetAttributes(candidate).HasFlag(FileAttributes.ReparsePoint)) return new() { ["broken"] = true };
        if (!File.Exists(file)) return new() { ["schema"] = 2, ["watermarks"] = new JsonObject(), ["reports"] = new JsonObject(), ["failures"] = new JsonObject() };
        var value = O11Connection.Read(file);
        return value != null && Integer(value["schema"]) == 2 ? value : new() { ["broken"] = true };
    }
    private void Save()
    {
        if (state["broken"] != null) throw new IOException("Bridge state is unreadable; automatic updates are disabled");
        NoLinks(Path.Combine(root, "private/bridge-state.json")); Atomic(Path.Combine(root, "private/bridge-state.json"), state.ToJsonString());
    }
    private void Remember(JsonObject m, string status, string reason, JsonObject? context = null)
    {
        lock (stateGate)
        {
            var record = new JsonObject { ["lane"] = m["lane"]?.DeepClone(), ["studioVersion"] = m["studioVersion"]?.DeepClone(), ["protocol"] = m["protocol"]?.DeepClone(),
                ["sequence"] = Sequence(m), ["status"] = status, ["reason"] = reason };
            if (context != null) { record["pid"] = context["pid"]?.DeepClone(); record["startedUtc"] = context["startedUtc"]?.DeepClone(); }
            state["reports"]![Identity(m)] = record; Save();
        }
    }
    internal JsonArray Reports()
    {
        lock (stateGate) return new((state["reports"] as JsonObject ?? new()).Select(pair => {
            var record = (JsonObject)pair.Value!.DeepClone(); record.Remove("pid"); record.Remove("startedUtc"); return (JsonNode?)record;
        }).ToArray());
    }
    internal static bool BundledSupports(JsonObject pack, string root, string lane, string? version, string? framework)
    {
        if (framework == null || Three(version) == null) return true;
        var build = pack["studioBuilds"]?[lane]; var builtFor = Text(build?["version"]) ?? Text(pack[lane == "odc" ? "odcBuiltFor" : "o11BuiltFor"]);
        if (builtFor != null && Three(builtFor) != Three(version)) return false;
        var tfm = Text(build?["tfm"]) ?? Text(build?["runtime"]) ?? Text(pack[lane + "Runtime"]);
        if (tfm == null)
        {
            var file = Path.Combine(root, lane == "odc" ? "odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge." + Text(pack["odcBridge"]) + ".deps.json" : "bin/o11/bridge/Anvil.Bridge.deps.json");
            var match = Regex.Match(Text(O11Connection.Read(file)?["runtimeTarget"]?["name"]) ?? "", @"Version=v(\d+\.\d+)");
            tfm = match.Success ? "net" + match.Groups[1].Value : "net8.0";
        }
        return framework == tfm;
    }
    private static string ManifestText(JsonNode? value) => Text(value) ?? value?.ToJsonString(new() { WriteIndented = false, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }) ?? "";
    private static void Atomic(string file, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, value, new UTF8Encoding(false)); File.Move(temporary, file, true); }
        finally { File.Delete(temporary); }
    }
    private void Report(string status, string message, string lane)
    {
        Status = new() { ["status"] = status, ["message"] = message, ["lane"] = lane };
        NoLinks(Path.Combine(root, "private"));
        Atomic(Path.Combine(root, "private/bridge-update.json"), Status.ToJsonString());
    }
    private void NoLinks(string target)
    {
        var relative = Path.GetRelativePath(root, target);
        if (Path.IsPathRooted(relative) || relative.Split(Path.DirectorySeparatorChar).Any(p => p == "..")) throw new IOException("Bridge path escapes the data directory");
        var at = root;
        foreach (var part in relative.Split(Path.DirectorySeparatorChar))
        {
            at = Path.Combine(at, part);
            if ((File.Exists(at) || Directory.Exists(at)) && File.GetAttributes(at).HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Bridge paths cannot contain links");
        }
    }
    private static bool SafePath(string path) => path.Length is > 0 and < 240 && path.Split('/').All(p => Regex.IsMatch(p, @"^[A-Za-z0-9_-][A-Za-z0-9_.-]*$")
        && !p.EndsWith('.') && !Regex.IsMatch(p, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", RegexOptions.IgnoreCase));
    private (JsonObject Manifest, string Text) VerifyManifest(JsonObject offer)
    {
        if (string.IsNullOrEmpty(publicKey) || !Regex.IsMatch(thumbprint, "^[a-fA-F0-9]{40}$")) throw new IOException("Bridge trust anchors are not configured in this build");
        var text = ManifestText(offer["manifest"]);
        if (Encoding.UTF8.GetByteCount(text) > 1024 * 1024 || !BridgeTrust.Verify(Encoding.UTF8.GetBytes(text), Convert.FromBase64String(Text(offer["signature"]) ?? ""), publicKey)) throw new IOException("Invalid bridge manifest signature");
        var m = JsonNode.Parse(text) as JsonObject ?? throw new IOException("Invalid bridge manifest");
        var lane = Text(m["lane"]); var version = Text(m["studioVersion"]); var protocol = Text(m["protocol"]);
        if (Integer(m["schema"]) != 1 || lane is not ("odc" or "o11") || Sequence(m) is < 1 or > 9007199254740991
            || !Regex.IsMatch(version ?? "", @"^\d+\.\d+\.\d+$") || ProtocolNumber(protocol) < 0 || !Regex.IsMatch(Text(m["runtime"]) ?? "", @"^net\d+\.\d+$")
            || !DateTimeOffset.TryParse(Text(m["createdAt"]), CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            || !string.Equals(Text(m["authenticodeThumbprint"]), thumbprint, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid bridge identity or certificate");
        foreach (var key in new[] { "lane", "studioVersion", "protocol" }) if (Text(offer[key]) != Text(m[key])) throw new IOException("Bridge offer differs from its signed manifest");
        if (m["files"] is not JsonArray entries || entries.Count is < 1 or > 512) throw new IOException("Invalid bridge file list");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "manifest.json", "manifest.sig" }; long total = 0;
        foreach (var entry in entries)
        {
            var name = Text(entry?["path"]) ?? ""; var size = entry?["size"]?.GetValue<long>() ?? -1;
            if (!SafePath(name) || size is < 1 or > 134217728 || !Regex.IsMatch(Text(entry?["sha256"]) ?? "", "^[a-f0-9]{64}$")
                || paths.Any(p => p.Equals(name, StringComparison.OrdinalIgnoreCase) || p.StartsWith(name + "/", StringComparison.OrdinalIgnoreCase) || name.StartsWith(p + "/", StringComparison.OrdinalIgnoreCase))) throw new IOException("Invalid or conflicting bridge file entry");
            paths.Add(name); total += size;
        }
        if (total > 536870912) throw new IOException("Bridge download exceeds the size limit");
        if (lane == "odc" && (!protocol!.StartsWith('v') || !paths.Contains("client/ODC3.Bridge.Client.dll") || paths.Count(p => Path.GetFileName(p) == "ODC3.Bridge.dll" || Path.GetFileName(p) == "ODC3.Bridge." + protocol + ".dll") != 1)) throw new IOException("Missing ODC bridge or matching client");
        var flatO11 = new[] { "hook/Anvil.RuntimeHook.Agent.dll", "bridge/Anvil.Bridge.dll" }.All(paths.Contains);
        if (lane == "o11" && (protocol != "d1" || !flatO11 || paths.Contains("hook/Anvil.RuntimeHook.Agent.dll.json"))) throw new IOException("Unsupported O11 downloaded hook layout");
        return (m, text);
    }
    private async Task VerifyFiles(JsonObject m, string directory, CancellationToken token, Dictionary<string, string>? generated = null)
    {
        NoLinks(directory);
        var entries = ((JsonArray)m["files"]!).OfType<JsonObject>().ToArray();
        var expected = entries.Select(f => Text(f["path"])!).Concat(["manifest.json", "manifest.sig"]).ToHashSet(StringComparer.Ordinal);
        if (generated != null) expected.UnionWith(generated.Keys);
        void Walk(string at)
        {
            foreach (var file in Directory.EnumerateFileSystemEntries(at))
            {
                NoLinks(file);
                if (Directory.Exists(file)) Walk(file);
                else if (!expected.Contains(Path.GetRelativePath(directory, file).Replace('\\', '/'))) throw new IOException("Unlisted file in bridge installation");
            }
        }
        Walk(directory);
        foreach (var entry in entries)
        {
            var file = Path.Combine(directory, Text(entry["path"])!);
            if (new FileInfo(file).Length != entry["size"]!.GetValue<long>() || Hash(await File.ReadAllBytesAsync(file, token)) != Text(entry["sha256"])) throw new IOException("Bridge file size or SHA-256 mismatch");
        }
        if (generated != null) foreach (var (name, digest) in generated) if (Hash(await File.ReadAllBytesAsync(Path.Combine(directory, name), token)) != digest) throw new IOException("The generated hook configuration changed");
        foreach (var entry in entries)
        {
            var file = Path.Combine(directory, Text(entry["path"])!);
            if (Path.GetExtension(file).Equals(".dll", StringComparison.OrdinalIgnoreCase) || Path.GetExtension(file).Equals(".exe", StringComparison.OrdinalIgnoreCase))
                try { await (authenticode == null ? Authenticode(file, token) : authenticode(file, token)); }
                catch (Exception e) when (e is not OperationCanceledException) { throw new IOException("Authenticode verification failed", e); }
        }
    }
    private async Task Authenticode(string file, CancellationToken token)
    {
        var info = new ProcessStartInfo { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (OperatingSystem.IsWindows())
        {
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            info.FileName = Path.Combine(windows, "System32/WindowsPowerShell/v1.0/powershell.exe");
            var module = Path.Combine(windows, "System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1");
            info.Environment["PSModulePath"] = Path.Combine(windows, "System32/WindowsPowerShell/v1.0/Modules");
            foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", "Import-Module '" + module + "' -Force -ErrorAction Stop; $s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '" + file.Replace("'", "''") + "'; if ($s.Status -ne 'Valid' -or $s.SignatureType -ne 'Authenticode') { exit 1 }; $s.SignerCertificate.Thumbprint" }) info.ArgumentList.Add(arg);
        }
        else if (OperatingSystem.IsMacOS())
        {
            info.FileName = Path.Combine(runtime, BridgeTrust.MacVerifier);
            foreach (var arg in new[] { "verify", "-in", file, "-CAfile", Path.Combine(runtime, "tools/osslsigncode-ca.pem"), "-require-leaf-hash", "sha1:" + thumbprint }) info.ArgumentList.Add(arg);
        }
        else throw new IOException("Authenticode verification is unavailable");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(30));
        using var process = Process.Start(info) ?? throw new IOException("Authenticode verifier unavailable");
        try
        {
            var stdout = process.StandardOutput.ReadToEndAsync(deadline.Token); var stderr = process.StandardError.ReadToEndAsync(deadline.Token);
            await process.WaitForExitAsync(deadline.Token); await stderr;
            if (process.ExitCode != 0 || OperatingSystem.IsWindows() && !string.Equals((await stdout).Trim(), thumbprint, StringComparison.OrdinalIgnoreCase)) throw new IOException("Authenticode signer does not match the pinned certificate");
        }
        finally { if (!process.HasExited) process.Kill(true); }
    }
    private string Fingerprint(string directory)
    {
        NoLinks(directory); var entries = new List<string>();
        void Walk(string at)
        {
            foreach (var file in Directory.EnumerateFileSystemEntries(at).Order(StringComparer.Ordinal))
            {
                NoLinks(file);
                if (Directory.Exists(file)) Walk(file);
                else { var info = new FileInfo(file); entries.Add(Path.GetRelativePath(directory, file) + ":" + info.Length + ":" + info.LastWriteTimeUtc.Ticks); }
            }
        }
        Walk(directory); return string.Join("\n", entries);
    }
    private async Task<List<InstalledBridge>> Inventory(string lane, string version, CancellationToken token)
    {
        var directory = Path.Combine(Home, lane, version); NoLinks(directory);
        if (!Directory.Exists(directory)) return [];
        var entries = new List<InstalledBridge>();
        foreach (var parent in Directory.EnumerateDirectories(directory))
        {
            var protocol = Path.GetFileName(parent); if (ProtocolNumber(protocol) < 0) continue; NoLinks(parent);
            foreach (var at in Directory.EnumerateDirectories(parent).Where(p => long.TryParse(Path.GetFileName(p), out _)))
            {
                try
                {
                    var stamp = Fingerprint(at); InstalledBridge? bridge = null;
                    lock (stateGate) if (cache.TryGetValue(at, out var cached) && stamp == cached.Stamp) bridge = cached.Bridge;
                    if (bridge == null)
                    {
                        var (m, text) = VerifyManifest(new() { ["lane"] = lane, ["studioVersion"] = version, ["protocol"] = protocol,
                            ["manifest"] = File.ReadAllText(Path.Combine(at, "manifest.json")), ["signature"] = File.ReadAllText(Path.Combine(at, "manifest.sig")) });
                        await VerifyFiles(m, at, token); bridge = new(m, at, Hash(Encoding.UTF8.GetBytes(text)));
                        var after = Fingerprint(at); if (after != stamp) throw new IOException("Bridge files changed during verification");
                        lock (stateGate) cache[at] = (after, bridge);
                    }
                    entries.Add(bridge);
                }
                catch (Exception e) when (e is IOException or FormatException or System.Text.Json.JsonException)
                { Report("refused", "Bridge update refused: cached bridge verification failed", lane); }
            }
        }
        return entries.OrderByDescending(b => Sequence(b.Manifest)).ToList();
    }
    private JsonObject Watermark(JsonObject m, bool rejected = false)
    {
        lock (stateGate)
        {
            if (state["broken"] != null) throw new IOException("Bridge state is unreadable; automatic updates are disabled");
            var known = state["watermarks"]![Pair(m)] as JsonObject ?? new JsonObject { ["installed"] = 0L, ["rejected"] = 0L, ["protocol"] = 0 };
            if (!rejected && (Sequence(m) < Math.Max(known["installed"]!.GetValue<long>(), known["rejected"]!.GetValue<long>()) || ProtocolNumber(Text(m["protocol"])) < Integer(known["protocol"])))
                throw new IOException("Bridge sequence replay or protocol downgrade refused");
            if (rejected) { known["rejected"] = Math.Max(Sequence(m), known["rejected"]!.GetValue<long>()); state["watermarks"]![Pair(m)] = known.DeepClone(); Save(); }
            return known;
        }
    }
    internal bool RejectLoad(InstalledBridge bridge, string reason = "The bridge failed to load", JsonObject? context = null, bool attempted = false, bool bridgeFailure = false)
    {
        if (!attempted || !bridgeFailure || Text(context?["startedUtc"]) == null) return false;
        lock (stateGate)
        {
            var failure = state["failures"]![Identity(bridge.Manifest)] as JsonObject ?? new JsonObject();
            failure[Integer(context!["pid"]).ToString(CultureInfo.InvariantCulture)] = context["startedUtc"]!.DeepClone();
            state["failures"]![Identity(bridge.Manifest)] = failure.DeepClone();
            Watermark(bridge.Manifest, true); Remember(bridge.Manifest, "failed", reason);
            var previous = state["reports"]!.AsObject().Select(p => p.Value).OfType<JsonObject>().Where(r => Pair(r) == Pair(bridge.Manifest) && Sequence(r) < Sequence(bridge.Manifest) && Text(r["status"]) != "failed").OrderByDescending(Sequence).FirstOrDefault();
            var fallback = previous ?? new JsonObject { ["lane"] = bridge.Manifest["lane"]!.DeepClone(), ["studioVersion"] = bridge.Manifest["studioVersion"]!.DeepClone(),
                ["protocol"] = pack?[Text(bridge.Manifest["lane"]) == "odc" ? "odcBridge" : "o11Hook"]?.DeepClone(), ["sequence"] = 0L };
            if (Text(fallback["protocol"]) != null) Remember(fallback, "fallback", previous == null ? "Using the bundled bridge" : "Using the previous verified bridge");
            Report("fallback", "The downloaded bridge failed to load; retry after the Studio restarts or a newer sequence arrives.", Text(bridge.Manifest["lane"])!);
        }
        Changed?.Invoke(); return true;
    }
    internal void MarkActive(InstalledBridge bridge, JsonObject context)
    {
        lock (stateGate)
        {
            Remember(bridge.Manifest, "active", "The bridge loaded successfully", context);
            state["active"] ??= new JsonObject();
            state["active"]![Text(bridge.Manifest["lane"]) + "/" + Integer(context["pid"]) + "/" + Text(context["startedUtc"])] =
                new JsonObject { ["studioVersion"] = bridge.Manifest["studioVersion"]?.DeepClone(), ["protocol"] = bridge.Protocol };
            Save();
        }
    }
    internal string? ProtocolFor(string lane, string? version, JsonObject context)
    {
        lock (stateGate)
        {
            var active = state["active"]?[lane + "/" + Integer(context["pid"]) + "/" + Text(context["startedUtc"])];
            if (Text(active?["studioVersion"]) == Three(version)?.ToString()) return Text(active?["protocol"]);
            var record = (state["reports"] as JsonObject)?.Select(p => p.Value).FirstOrDefault(r => Text(r?["lane"]) == lane && Text(r?["studioVersion"]) == Three(version)?.ToString()
                && Text(r?["status"]) == "active" && Integer(r?["pid"]) == Integer(context["pid"]) && Text(r?["startedUtc"]) == Text(context["startedUtc"]));
            return Text(record?["protocol"]) ?? Text(pack?[lane == "odc" ? "odcBridge" : "o11Hook"]);
        }
    }
    internal async Task<InstalledBridge?> Select(string lane, string? version, string? framework, CancellationToken token, JsonObject? context = null)
    {
        var three = Three(version)?.ToString();
        if (three == null || framework == null || OperatingSystem.IsMacOS() || state["broken"] != null || BundledSupports(pack ?? new(), runtime, lane, version, framework)) return null;
        foreach (var bridge in await Inventory(lane, three, token))
        {
            if (Text(bridge.Manifest["runtime"]) != framework) continue;
            lock (stateGate)
            {
                if (state["failures"]![Identity(bridge.Manifest)] is JsonObject blocked)
                {
                    var processKey = Integer(context?["pid"]).ToString(CultureInfo.InvariantCulture);
                    if (Text(context?["startedUtc"]) == null || Text(blocked[processKey]) == Text(context?["startedUtc"])) continue;
                    if (blocked[processKey] != null) { blocked.Remove(processKey); Remember(bridge.Manifest, "installed", "The Studio restarted; the bridge can be retried"); }
                }
            }
            return bridge;
        }
        return null;
    }
    internal async Task<BridgeLease> PrepareAttach(InstalledBridge bridge, JsonObject context, CancellationToken token)
    {
        var directory = Path.Combine(root, "private/bridge-loads", Guid.NewGuid().ToString("N")[..12]); NoLinks(directory); Directory.CreateDirectory(directory);
        BridgeFileLease? held = null;
        try
        {
            foreach (var name in ((JsonArray)bridge.Manifest["files"]!).Select(f => Text(f?["path"])!).Concat(["manifest.json", "manifest.sig"]))
            {
                var from = Path.Combine(bridge.Root, name); NoLinks(from); var target = Path.Combine(directory, name);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!); File.Copy(from, target);
            }
            var generated = new Dictionary<string, string>();
            if (Text(bridge.Manifest["lane"]) == "o11")
            {
                var config = new JsonObject { ["pid"] = context["pid"]?.DeepClone(), ["startedUtc"] = context["startedUtc"]?.DeepClone(), ["port"] = context["port"]?.DeepClone(),
                    ["bridgePath"] = Path.Combine(directory, "bridge/Anvil.Bridge.dll"), ["authorityDir"] = Path.Combine(root, "private/authority") };
                var name = "hook/Anvil.RuntimeHook.Agent.dll.json"; var bytes = Encoding.UTF8.GetBytes(config.ToJsonString()); File.WriteAllBytes(Path.Combine(directory, name), bytes); generated[name] = Hash(bytes);
            }
            held = BridgeFileLease.Acquire(root, directory);
            var (m, text) = VerifyManifest(new() { ["lane"] = bridge.Manifest["lane"]?.DeepClone(), ["studioVersion"] = bridge.Manifest["studioVersion"]?.DeepClone(), ["protocol"] = bridge.Protocol,
                ["manifest"] = File.ReadAllText(Path.Combine(directory, "manifest.json")), ["signature"] = File.ReadAllText(Path.Combine(directory, "manifest.sig")) });
            if (Hash(Encoding.UTF8.GetBytes(text)) != bridge.Digest) throw new IOException("The bridge changed while preparing the attach");
            await VerifyFiles(m, directory, token, generated);
            var lease = new BridgeLease(new(m, directory, bridge.Digest), held); lock (stateGate) leases.Add(lease); return lease;
        }
        catch { held?.Dispose(); throw; }
    }
    internal async Task<bool> Offers(JsonNode? welcome, JsonObject installed, HttpClient http, CancellationToken token)
    {
        if (OperatingSystem.IsMacOS()) return false;
        await gate.WaitAsync(token);
        try
        {
            var changed = false;
            foreach (var lane in new[] { "odc", "o11" })
            {
                if (welcome?["compatible"]?[lane]?["bridgeOffer"] is not JsonObject offer) continue;
                try { changed = await Install(offer, lane, installed[lane]?["installed"], http, token) || changed; }
                catch (Exception e) when (!token.IsCancellationRequested) { Report("refused", "Bridge update refused: " + (e is IOException ? e.Message : "invalid offer or interrupted download"), lane); }
            }
            return changed;
        }
        finally { gate.Release(); }
    }
    private async Task<bool> Install(JsonObject offer, string lane, JsonNode? installed, HttpClient http, CancellationToken token)
    {
        var (m, text) = VerifyManifest(offer);
        var version = Text(m["studioVersion"])!; var protocol = Text(m["protocol"])!;
        try
        {
            Watermark(m);
            if (Text(m["lane"]) != lane || Three(Text(installed?["version"]))?.ToString() != version || Text(installed?["runtime"]) != Text(m["runtime"])) throw new IOException("Bridge does not match the installed Studio and runtime");
            if (BundledSupports(pack ?? new(), runtime, lane, Text(installed?["version"]), Text(installed?["runtime"]))) return false;
            foreach (var previous in await Inventory(lane, version, token))
            {
                if (Sequence(previous.Manifest) > Sequence(m) || ProtocolNumber(previous.Protocol) > ProtocolNumber(protocol)) throw new IOException("Bridge sequence replay or protocol downgrade refused");
                if (Sequence(previous.Manifest) == Sequence(m)) { if (previous.Digest != Hash(Encoding.UTF8.GetBytes(text))) throw new IOException("An installed bridge identity cannot be replaced"); return false; }
            }
            var destination = Path.Combine(Home, lane, version, protocol, Sequence(m).ToString(CultureInfo.InvariantCulture)); NoLinks(destination); Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            var staging = Path.Combine(Path.GetDirectoryName(destination)!, ".staging-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(staging);
            try
            {
                foreach (var file in ((JsonArray)m["files"]!).OfType<JsonObject>())
                {
                    var size = file["size"]!.GetValue<long>(); using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(Math.Min(300, 15 + (size + 65535) / 65536)));
                    using var response = await http.GetAsync("agent/bridges/" + lane + "/" + version + "/" + protocol + "/" + Text(file["sha256"]), HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                    if (response.StatusCode != System.Net.HttpStatusCode.OK || response.Content.Headers.ContentLength is { } length && length != size) throw new IOException("Bridge download refused or size mismatch");
                    var target = Path.Combine(staging, Text(file["path"])!); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    await using var input = await response.Content.ReadAsStreamAsync(deadline.Token); await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    var buffer = new byte[65536]; long written = 0; int count;
                    while ((count = await input.ReadAsync(buffer, deadline.Token)) > 0) { written += count; if (written > size) throw new IOException("Bridge download exceeds the signed size"); await output.WriteAsync(buffer.AsMemory(0, count), deadline.Token); }
                    if (written != size) throw new IOException("Bridge download was interrupted"); output.Flush(true);
                }
                File.WriteAllText(Path.Combine(staging, "manifest.json"), text, new UTF8Encoding(false)); File.WriteAllText(Path.Combine(staging, "manifest.sig"), Text(offer["signature"]));
                await VerifyFiles(m, staging, token);
                lock (stateGate) { var known = Watermark(m); known["installed"] = Sequence(m); known["protocol"] = ProtocolNumber(protocol); state["watermarks"]![Pair(m)] = known.DeepClone(); Save(); }
                NoLinks(destination); Directory.Move(staging, destination);
                lock (stateGate) cache[destination] = (Fingerprint(destination), new(m, destination, Hash(Encoding.UTF8.GetBytes(text))));
                Remember(m, "installed", "The verified bridge is installed"); Report("installed", $"Updated the {lane} bridge for {(lane == "odc" ? "ODC Studio" : "Service Studio")} {version}", lane); return true;
            }
            finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
        }
        catch { Watermark(m, true); throw; }
    }
    public void Dispose() { lock (stateGate) { foreach (var lease in leases) lease.Dispose(); leases.Clear(); } }
    internal static string? Runtime(JsonNode? config)
    {
        var options = config?["runtimeOptions"];
        var tfm = Text(options?["tfm"]); if (Regex.IsMatch(tfm ?? "", @"^net\d+\.\d+$")) return tfm;
        var version = Text(options?["framework"]?["version"]) ?? (options?["frameworks"] as JsonArray)?.Where(f => Text(f?["name"]) == "Microsoft.NETCore.App").Select(f => Text(f?["version"])).FirstOrDefault();
        var match = Regex.Match(version ?? "", @"^(\d+\.\d+)\."); return match.Success ? "net" + match.Groups[1].Value : null;
    }
    internal static string? StudioRuntime(string? target, string lane)
    {
        if (target == null) return null;
        var dir = target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? Path.GetDirectoryName(target)! : target;
        if (OperatingSystem.IsMacOS())
        {
            var end = target.IndexOf(".app", StringComparison.OrdinalIgnoreCase);
            if (end < 0) return null;
            var bundle = MacPlatform.Inspect(target[..(end + 4)]);
            return Runtime(bundle?.RuntimeConfig);
        }
        return Runtime(O11Connection.Read(Path.Combine(dir, (lane == "odc" ? "ODCStudio" : "ServiceStudio") + ".runtimeconfig.json")));
    }
}
