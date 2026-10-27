using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Ssam.Agent;

internal static class NativeHost
{
    internal static void CheckRoot(string root)
    {
        if (OperatingSystem.IsMacOS()) { MacPlatform.CheckRoot(root); MacPlatform.CheckRoot(Path.GetFullPath(root)); MacPlatform.CheckRoot(MacPlatform.RealPath(root)); return; }
        if (!OperatingSystem.IsWindows()) throw new ArgumentException("The installed native core supports Windows and macOS");
        if (!Path.IsPathFullyQualified(root) || root.Any(char.IsWhiteSpace) || root.StartsWith("\\\\")) throw new ArgumentException("Use an absolute local data directory without whitespace");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (Within(root, local)) throw new ArgumentException("The data directory must be outside LocalAppData so the Studio can see it");
    }
    internal static bool Within(string file, string root) => Path.GetFullPath(file).TrimEnd('\\', '/').Equals(Path.GetFullPath(root).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase)
        || Path.GetFullPath(file).StartsWith(Path.GetFullPath(root).TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    internal static Uri Server(string server)
    {
        if (!Uri.TryCreate(server.TrimEnd('/') + "/", UriKind.Absolute, out var uri) || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" ||
            !(uri.Scheme == "https" || uri.Scheme == "http" && uri.IsLoopback)) throw new ArgumentException("The server must use HTTPS, or HTTP on loopback, without embedded credentials, query or fragment");
        return uri;
    }
    internal static JsonObject Pack(string runtime, string root)
    {
        if (Within(runtime, root) || Within(root, runtime)) throw new ArgumentException("Installation and data directories must be separate");
        var pack = O11Connection.Read(Path.Combine(runtime, "pack.json")) ?? throw new ArgumentException("The installed pack.json is missing");
        if (pack["files"] is not JsonArray files || files.Count == 0) throw new ArgumentException("The installed pack has no integrity manifest");
        foreach (var item in files)
        {
            var relative = StudioKinds.Text(item?["path"]) ?? throw new ArgumentException("Invalid pack file");
            if (Path.IsPathRooted(relative) || relative.Split(['/', '\\']).Any(s => s is ".." or "." or "")) throw new ArgumentException("Invalid pack file path");
            var file = Path.GetFullPath(Path.Combine(runtime, relative));
            if (!Within(file, runtime) || !File.Exists(file)) throw new ArgumentException("The installed pack is incomplete");
            using var stream = File.OpenRead(file);
            if (item?["size"]?.GetValue<long>() != stream.Length || StudioKinds.Text(item?["sha256"]) != Convert.ToHexStringLower(SHA256.HashData(stream))) throw new ArgumentException("The installed pack failed its integrity check");
        }
        return pack;
    }
    internal static JsonObject Installed()
    {
        if (OperatingSystem.IsMacOS()) return MacPlatform.Installed();
        var result = new JsonObject();
        foreach (var lane in new[] { "odc", "o11" })
        {
            var uninstall = lane == "odc" ? "OutSystems ODC Studio" : "OutSystems Service Studio 11";
            var folder = lane == "odc" ? "ODC Studio" : "Service Studio";
            var image = lane == "odc" ? "ODCStudio.exe" : "ServiceStudio.exe";
            var marker = lane == "odc" ? "OutSystems.Model.dll" : "ServiceStudio.Framework.dll";
            var candidates = new List<string>();
            if (OperatingSystem.IsWindows()) foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser }) foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using var basis = RegistryKey.OpenBaseKey(hive, view);
                    using var key = basis.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\" + uninstall);
                    if (key?.GetValue("InstallLocation") is string location) candidates.Add(Path.Combine(location, folder));
                }
                catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
            }
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "OutSystems", lane == "odc" ? "ODC Studio" : "Service Studio 11", folder));
            var dir = candidates.FirstOrDefault(d => File.Exists(Path.Combine(d, marker)) && File.Exists(Path.Combine(d, image)));
            result[lane] = new JsonObject { ["installed"] = dir == null ? null : new JsonObject { ["dir"] = dir, ["version"] = FileVersionInfo.GetVersionInfo(Path.Combine(dir, image)).ProductVersion } };
        }
        return result;
    }
    internal static JsonObject Machine()
    {
        var guid = "";
        if (OperatingSystem.IsMacOS()) try { guid = Regex.Match(MacPlatform.Tool("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"), "\"IOPlatformUUID\"\\s*=\\s*\"([^\"]+)\"").Groups[1].Value; } catch (IOException) { }
        if (OperatingSystem.IsWindows()) try { using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"); guid = key?.GetValue("MachineGuid") as string ?? ""; } catch (System.Security.SecurityException) { }
        var name = Environment.MachineName; var user = Environment.UserName;
        return new() { ["id"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(guid + "|" + name + "|" + user)))[..16], ["name"] = name[..Math.Min(64, name.Length)], ["user"] = user[..Math.Min(64, user.Length)] };
    }
    internal static async Task<int> Command(string[] args)
    {
        var options = new Dictionary<string, string>();
        for (var i = 1; i < args.Length; i++)
        {
            if (args[i] == "--json") continue;
            if (!args[i].StartsWith("--") || i + 1 >= args.Length || !options.TryAdd(args[i], args[++i])) throw new ArgumentException("Invalid command options");
        }
        var root = options.GetValueOrDefault("--root") ?? throw new ArgumentException("--root is required");
        CheckRoot(root);
        var runtime = options.GetValueOrDefault("--runtime-root") ?? AppContext.BaseDirectory;
        var pack = Pack(runtime, root);
        if (args[0] == "doctor")
        {
            var checks = new JsonArray(); var ok = true;
            void Add(bool passed, string name, string detail, bool required = true) { if (!passed && required) ok = false; checks.Add((JsonNode)new JsonObject { ["status"] = passed ? "ok" : required ? "fail" : "warn", ["name"] = name, ["detail"] = detail }); }
            Add(true, "pack", "Installed files match the integrity manifest");
            Add(true, "agent folder", root);
            var configCheck = O11Connection.Read(Path.Combine(root, "private/config.json"));
            Uri? serverCheck = null;
            try { serverCheck = Server(StudioKinds.Text(configCheck?["server"]) ?? ""); } catch (ArgumentException) { }
            Add(serverCheck != null, "server", serverCheck == null ? "Run setup with a valid server address" : serverCheck.ToString());
            var credentialOk = false;
            try { credentialOk = Regex.IsMatch(File.ReadAllText(Path.Combine(root, "private/credential")).Trim(), @"^ssam_agent_[A-Za-z0-9_-]{43}$"); } catch (IOException) { }
            Add(credentialOk, "credential", credentialOk ? "Present (not displayed)" : "Run setup with a valid credential");
            var runtimes = "";
            try
            {
                using var dotnet = Process.Start(new ProcessStartInfo("dotnet", "--list-runtimes") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
                if (dotnet != null) { var output = dotnet.StandardOutput.ReadToEndAsync(); var error = dotnet.StandardError.ReadToEndAsync(); await dotnet.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); runtimes = await output; await error; }
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or TimeoutException) { }
            var installed = Installed();
            foreach (var lane in (pack["lanes"] as JsonArray ?? []).Select(StudioKinds.Text))
            {
                if (lane == null) continue;
                var bundled = StudioKinds.SelfContainedHelper(Path.Combine(runtime, lane == "odc"
                    ? "odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.dll" : "bin/o11/connect/Anvil.Connect.dll"));
                var hasRuntime = OperatingSystem.IsMacOS() || bundled || Regex.IsMatch(runtimes, lane == "odc" ? @"Microsoft\.NETCore\.App 10\." : @"Microsoft\.NETCore\.App (8|9|1[0-9])\.");
                Add(hasRuntime, lane + " attach runtime", OperatingSystem.IsMacOS() ? "Native diagnostic client (no external runtime required)" : bundled ? "Included in the application" : hasRuntime ? "Installed" : "Install the required .NET runtime for the Studio helper");
                var studio = installed[lane]?["installed"];
                Add(studio != null, lane + " Studio", studio == null ? "Not found" : StudioKinds.Text(studio["version"]) ?? "Version unknown", false);
            }
            var report = new JsonObject { ["ok"] = ok, ["agentVersion"] = "0.4.0-native", ["runtime"] = "native-aot", ["root"] = root, ["pack"] = new JsonObject { ["id"] = pack["id"]?.DeepClone(), ["lanes"] = pack["lanes"]?.DeepClone() }, ["studios"] = installed, ["checks"] = checks, ["macOSValidated"] = false };
            Console.WriteLine(report.ToJsonString()); return ok ? 0 : 1;
        }
        if (args[0] == "setup")
        {
            var server = Server(options.GetValueOrDefault("--server") ?? "");
            var credential = (await Console.In.ReadToEndAsync()).Trim();
            if (!Regex.IsMatch(credential, @"^ssam_agent_[A-Za-z0-9_-]{43}$")) throw new ArgumentException("Invalid agent credential format; nothing was saved");
            var previous = O11Connection.Read(Path.Combine(root, "private/config.json"));
            var portText = options.GetValueOrDefault("--o11-port") ?? StudioKinds.Integer(previous?["o11Port"], 4516).ToString();
            if (!int.TryParse(portText, out var port) || port is < 1024 or > 65535) throw new ArgumentException("O11 port must be between 1024 and 65535");
            var state = new StateStore(root, false);
            if (OperatingSystem.IsMacOS()) File.SetUnixFileMode(state.Private, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            else
            {
            var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "icacls.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { state.Private, "/inheritance:r", "/grant:r", Environment.UserDomainName + "\\" + Environment.UserName + ":(OI)(CI)F" }) info.ArgumentList.Add(arg);
            using var process = Process.Start(info) ?? throw new ArgumentException("Could not restrict private data permissions");
            var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(); await stdout; await stderr;
            if (process.ExitCode != 0) throw new ArgumentException("Could not restrict private data permissions; credential was not saved");
            }
            Write(Path.Combine(state.Private, "config.json"), new JsonObject { ["server"] = server.ToString().TrimEnd('/'), ["o11Port"] = port }.ToJsonString());
            Write(Path.Combine(state.Private, "credential"), credential);
            Console.WriteLine("Agent setup saved. The credential was not displayed."); return 0;
        }
        if (args[0] != "run") throw new ArgumentException("Unknown command");
        var config = O11Connection.Read(Path.Combine(root, "private/config.json")) ?? throw new ArgumentException("Run setup first");
        var url = Server(StudioKinds.Text(config["server"]) ?? "");
        var secret = File.ReadAllText(Path.Combine(root, "private/credential")).Trim();
        if (!Regex.IsMatch(secret, @"^ssam_agent_[A-Za-z0-9_-]{43}$")) throw new ArgumentException("Run setup with a valid agent credential");
        var data = new StateStore(root, false);
        // Kernel ownership is exclusive for this data directory, including crashes.
        using var guard = new FileStream(Path.Combine(data.Private, "native.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        using var lifetime = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
        using var channel = new AgentChannel(url, secret, data, 0, runtime, pack);
        var run = channel.RunAsync(lifetime.Token);
        while (!run.IsCompleted && !lifetime.IsCancellationRequested)
        {
            if (File.Exists(Path.Combine(data.Private, "agent.stop"))) lifetime.Cancel();
            await Task.WhenAny(run, Task.Delay(100));
        }
        return await run;
    }
    private static void Write(string file, string text)
    {
        var staged = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(staged, text);
        if (OperatingSystem.IsMacOS()) File.SetUnixFileMode(staged, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(staged, file, true);
    }
}
