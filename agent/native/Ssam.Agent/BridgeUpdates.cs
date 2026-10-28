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
    string thumbprint = BridgeTrust.AuthenticodeThumbprint, Func<string, CancellationToken, Task>? authenticode = null)
{
    private string Home => Path.Combine(root, "bridges");
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly HashSet<string> refused = [];
    internal JsonObject? Status { get; private set; }
    internal Action? Changed { get; set; }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static int ProtocolNumber(string? protocol) => Regex.IsMatch(protocol ?? "", @"^[vh](0|[1-9]\d{0,8})$") ? int.Parse(protocol![1..], CultureInfo.InvariantCulture) : -1;
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
        if (Integer(m["schema"]) != 1 || lane is not ("odc" or "o11") || OperatingSystem.IsMacOS() && lane != "odc"
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
        if (lane == "odc" && (!protocol!.StartsWith('v') || paths.Count(p => Path.GetFileName(p) == "ODC3.Bridge.dll" || Path.GetFileName(p) == "ODC3.Bridge." + protocol + ".dll") != 1)) throw new IOException("Missing or ambiguous ODC bridge entrypoint");
        var flatO11 = new[] { "hook/Anvil.RuntimeHook.Agent.dll", "bridge/Anvil.Bridge.dll" }.All(paths.Contains);
        var releaseO11 = new[] { "studio/o11/hook/Anvil.Hook.h1.dll", "studio/o11/bridge/b1/Anvil.Bridge.dll", "release.json", "release.sig.jws" }.All(paths.Contains);
        if (lane == "o11" && (protocol != "h1" || (!flatO11 && !releaseO11))) throw new IOException("Unsupported O11 hook or incomplete bridge layout");
        return (m, text);
    }
    private async Task VerifyFiles(JsonObject m, string directory, CancellationToken token)
    {
        NoLinks(directory);
        var entries = ((JsonArray)m["files"]!).OfType<JsonObject>().ToArray();
        var expected = entries.Select(f => Text(f["path"])!).Concat(["manifest.json", "manifest.sig"]).ToHashSet(StringComparer.Ordinal);
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
            info.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32/WindowsPowerShell/v1.0/powershell.exe");
            foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", "$s=Get-AuthenticodeSignature -LiteralPath '" + file.Replace("'", "''") + "'; if ($s.Status -ne 'Valid' -or $s.SignatureType -ne 'Authenticode') { exit 1 }; $s.SignerCertificate.Thumbprint" }) info.ArgumentList.Add(arg);
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
    private IEnumerable<(JsonObject Manifest, string Text, string Directory)> Inventory(string lane, string version)
    {
        var directory = Path.Combine(Home, lane, version); NoLinks(directory);
        if (!Directory.Exists(directory)) return [];
        var entries = new List<(JsonObject, string, string)>();
        foreach (var at in Directory.EnumerateDirectories(directory))
        {
            var protocol = Path.GetFileName(at); if (ProtocolNumber(protocol) < 0) continue;
            NoLinks(at);
            var verified = VerifyManifest(new() { ["lane"] = lane, ["studioVersion"] = version, ["protocol"] = protocol,
                ["manifest"] = File.ReadAllText(Path.Combine(at, "manifest.json")), ["signature"] = File.ReadAllText(Path.Combine(at, "manifest.sig")) });
            entries.Add((verified.Manifest, verified.Text, at));
        }
        return entries.OrderByDescending(e => ProtocolNumber(Text(e.Item1["protocol"])));
    }
    private HashSet<string> Failed() => (O11Connection.Read(Path.Combine(Home, "failed.json"))?["digests"] as JsonArray)?.Select(n => Text(n)!).ToHashSet() ?? [];
    internal void RejectLoad(InstalledBridge bridge)
    {
        lock (refused)
        {
            var failed = Failed(); failed.Add(bridge.Digest); NoLinks(Home);
            Atomic(Path.Combine(Home, "failed.json"), new JsonObject { ["digests"] = new JsonArray(failed.Select(s => (JsonNode?)JsonValue.Create(s)).ToArray()) }.ToJsonString());
            Report("fallback", "The downloaded bridge could not load; the previous bridge or bundled bridge will be used. Restart the Studio if an attach was already sent.", Text(bridge.Manifest["lane"])!);
        }
        Changed?.Invoke();
    }
    internal async Task<InstalledBridge?> Select(string lane, string? version, string? framework, CancellationToken token)
    {
        var three = Three(version)?.ToString();
        if (three == null || framework == null || OperatingSystem.IsMacOS() && lane != "odc") return null;
        try
        {
            foreach (var entry in Inventory(lane, three))
            {
                var digest = Hash(Encoding.UTF8.GetBytes(entry.Text));
                if (Text(entry.Manifest["runtime"]) != framework || Failed().Contains(digest)) continue;
                try { await VerifyFiles(entry.Manifest, entry.Directory, token); return new(entry.Manifest, entry.Directory, digest); }
                catch (IOException e) { Report("refused", "Bridge update refused: " + e.Message, lane); }
            }
        }
        catch (Exception e) when (e is IOException or FormatException or System.Text.Json.JsonException) { Report("refused", "Bridge update refused: cached bridge verification failed", lane); }
        return null;
    }
    internal async Task<bool> Offers(JsonNode? welcome, JsonObject installed, HttpClient http, CancellationToken token)
    {
        await gate.WaitAsync(token);
        try
        {
            var changed = false;
            foreach (var lane in new[] { "odc", "o11" })
            {
                if (welcome?["compatible"]?[lane]?["bridgeOffer"] is not JsonObject offer) continue;
                try { changed = await Install(offer, lane, installed[lane]?["installed"], http, token) || changed; }
                catch (Exception e) when (!token.IsCancellationRequested)
                { Report("refused", "Bridge update refused: " + (e is IOException ? e.Message : "invalid offer or interrupted download"), lane); }
            }
            return changed;
        }
        finally { gate.Release(); }
    }
    private async Task<bool> Install(JsonObject offer, string lane, JsonNode? installed, HttpClient http, CancellationToken token)
    {
        var (m, text) = VerifyManifest(offer);
        var version = Text(m["studioVersion"])!; var protocol = Text(m["protocol"])!;
        if (Text(m["lane"]) != lane || Three(Text(installed?["version"]))?.ToString() != version || Text(installed?["runtime"]) != Text(m["runtime"])) throw new IOException("Bridge does not match the installed Studio and runtime");
        foreach (var previous in Inventory(lane, version))
        {
            var old = Text(previous.Manifest["protocol"])!;
            if (old[0] != protocol[0] || ProtocolNumber(old) > ProtocolNumber(protocol)) throw new IOException("Bridge protocol downgrade refused");
            if (old == protocol)
            {
                if (text != previous.Text) throw new IOException("An installed bridge identity cannot be replaced");
                await VerifyFiles(m, previous.Directory, token); return false;
            }
        }
        var destination = Path.Combine(Home, lane, version, protocol); NoLinks(destination);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var staging = Path.Combine(Path.GetDirectoryName(destination)!, ".staging-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(staging);
        try
        {
            foreach (var file in ((JsonArray)m["files"]!).OfType<JsonObject>())
            {
                var size = file["size"]!.GetValue<long>();
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(Math.Min(300, 15 + (size + 65535) / 65536)));
                using var response = await http.GetAsync("agent/bridges/" + lane + "/" + version + "/" + protocol + "/" + Text(file["sha256"]), HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                if (response.StatusCode != System.Net.HttpStatusCode.OK || response.Content.Headers.ContentLength is { } length && length != size) throw new IOException("Bridge download refused or size mismatch");
                var target = Path.Combine(staging, Text(file["path"])!); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                await using var source = await response.Content.ReadAsStreamAsync(deadline.Token);
                await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                var buffer = new byte[65536]; long written = 0; int count;
                while ((count = await source.ReadAsync(buffer, deadline.Token)) > 0)
                { written += count; if (written > size) throw new IOException("Bridge download exceeds the signed size"); await output.WriteAsync(buffer.AsMemory(0, count), deadline.Token); }
                if (written != size) throw new IOException("Bridge download was interrupted"); output.Flush(true);
            }
            File.WriteAllText(Path.Combine(staging, "manifest.json"), text, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(staging, "manifest.sig"), Text(offer["signature"]));
            await VerifyFiles(m, staging, token); NoLinks(destination); Directory.Move(staging, destination);
            Report("installed", $"Updated the {lane} bridge for {(lane == "odc" ? "ODC Studio" : "Service Studio")} {version}", lane); return true;
        }
        finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
    }
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
