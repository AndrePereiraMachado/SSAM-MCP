using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;

namespace Anvil.Core;

/// <summary>
/// The ODC bridge client of the Anvil kernel (WS2). It does not reimplement the SSAM-Hybrid-ODC bridge: every call
/// runs the existing pipe client (<c>dotnet ODC3.Bridge.Client.dll &lt;pid&gt; &lt;command&gt; [args]</c>) against the ODC
/// Studio process and returns the one JSON line the bridge answers, as it is. A refusal (<c>ok=false</c>, with
/// <c>gate</c> and <c>outcome</c>) is returned, never thrown, so callers stop at the first refusal and keep the JSON;
/// only a transport failure (client not built, Studio not running, pipe not attached, process killed) throws
/// <see cref="BridgeCallException"/>, whose <c>Executed</c> is false when nothing reached the bridge and null when the
/// client timed out with the native command possibly still running (the bridge journals it as <c>uncertain</c>).
/// </summary>
public sealed class BridgeClientOdc : IBridgeClient
{
    public static string DefaultRoot {
        get {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                if (File.Exists(Path.Combine(directory.FullName, ".ssam-workspace.json")))
                    return Path.Combine(directory.FullName, "platforms", "odc");
            throw new InvalidOperationException("SSAM workspace not found; set SSAM_HYBRID_ODC_ROOT explicitly.");
        }
    }

    /// <summary>SSAM-Hybrid-ODC root: ANVIL_ODC_ROOT, SSAM_HYBRID_ODC_ROOT or ODC3_ROOT, else the default folder.</summary>
    public string Root { get; }
    public string ClientPath { get; }
    public int Pid { get; }
    /// <summary>How long to wait for the client process; the pipe client itself waits up to 10 minutes for a reply.</summary>
    public int TimeoutSeconds { get; }

    public BridgeClientOdc(string? root = null, int? pid = null, int timeoutSeconds = 11 * 60)
    {
        Root = Path.GetFullPath(root ?? Environment.GetEnvironmentVariable("ANVIL_ODC_ROOT") ?? Environment.GetEnvironmentVariable("SSAM_HYBRID_ODC_ROOT")
            ?? Environment.GetEnvironmentVariable("ODC3_ROOT") ?? DefaultRoot);
        ClientPath = Path.Combine(Root, "studio", "bridge", "client", "bin", "Release", "net10.0", "ODC3.Bridge.Client.dll");
        Pid = pid ?? (int.TryParse(Environment.GetEnvironmentVariable("ANVIL_ODC_STUDIO_PID"), out var configured) ? configured : FindStudioPid());
        TimeoutSeconds = timeoutSeconds;
    }

    /// <summary>The single ODCStudio.exe process; several or none are an error, as in facade\lib.mjs.</summary>
    public static int FindStudioPid()
    {
        var pids = Process.GetProcessesByName("ODCStudio").Select(p => p.Id).OrderBy(id => id).ToArray();
        if (pids.Length == 0) throw new BridgeCallException("ODC Studio is not running (no ODCStudio.exe process): open it, sign in to the tenant and run 'odc attach'.", executed: false);
        if (pids.Length > 1) throw new BridgeCallException("Several ODC Studio processes are running (" + string.Join(", ", pids) + "); pass the pid (ANVIL_ODC_STUDIO_PID).", executed: false);
        return pids[0];
    }

    /// <summary>One bridge command with positional and flag words, e.g. <c>Call("status", "brief")</c> or
    /// <c>Call("refresh-references", "TestGap", "--producer", "ODC3_LabLib")</c>. Words are joined with spaces by the
    /// client, exactly as the CLI does; a word with spaces (an authorization text) is passed as one argument.</summary>
    public JsonObject Call(string command, params string[] args)
    {
        if (!File.Exists(ClientPath)) throw new BridgeCallException("Bridge client is not built: dotnet build studio\\bridge\\client\\Client.csproj -c Release (" + ClientPath + ")", executed: false);
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true, WorkingDirectory = Root };
        start.ArgumentList.Add(ClientPath); start.ArgumentList.Add(Pid.ToString()); start.ArgumentList.Add(command);
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new BridgeCallException(command + ": the bridge client process could not be started", executed: false);
        var stdout = new StringBuilder(); var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };
        process.BeginOutputReadLine(); process.BeginErrorReadLine();
        if (!process.WaitForExit(TimeSpan.FromSeconds(TimeoutSeconds)))
        {
            try { process.Kill(entireProcessTree: true); } catch { /* best effort */ }
            throw new BridgeCallException(command + ": the bridge client did not answer within " + TimeoutSeconds + " s; the native command may still be running. Poll 'status' and read the evidence directory; never retry.", executed: null);
        }
        process.WaitForExit();
        var text = stdout.ToString().Trim();
        var line = text.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.StartsWith('{'));
        if (line != null)
        {
            try { return JsonNode.Parse(line)!.AsObject(); } catch { /* not JSON: fall through to the failure below */ }
        }
        var error = (stderr.ToString().Trim().Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? text.Split('\n').FirstOrDefault() ?? "bridge client failed").Trim();
        var timedOut = error.Contains("TimeoutException", StringComparison.Ordinal);
        throw new BridgeCallException(command + ": " + error, executed: timedOut ? null : false);
    }

    /// <summary>The kernel's bridge contract (Delivery.cs). Parameters become words: <c>args</c> (a JSON array of
    /// strings) are positional, every other entry is <c>--name value</c>, a <c>true</c> is the bare flag, a null or
    /// <c>false</c> is omitted. The command name is the bridge command (status, snapshot, check-base, ...).</summary>
    public JsonObject Call(string method, JsonObject? parameters = null)
    {
        var words = new List<string>();
        if (parameters?["args"] is JsonArray positional) words.AddRange(positional.Select(a => a?.ToString() ?? ""));
        foreach (var (name, value) in parameters ?? new JsonObject())
        {
            if (name == "args" || value == null) continue;
            if (value is JsonValue v && v.TryGetValue<bool>(out var flag)) { if (flag) words.Add("--" + name); continue; }
            words.Add("--" + name); words.Add(value.ToString());
        }
        return Call(method, words.ToArray());
    }

    /// <summary>The bridge's brief state: bridge version, busy, catalog, dialogs with choices, open modules.</summary>
    public JsonObject StatusBrief() => Call("status", "brief");

    public static bool Ok(JsonObject? reply) => reply?["ok"]?.GetValue<bool>() == true;
}
