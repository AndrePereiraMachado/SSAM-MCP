using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Anvil.Xif.Engine;

/// <summary>
/// One request on stdin ({command: probe|model|final, ...}), one JSON answer on stdout. Every failure is an answer
/// {ok:false, code, error, problems}; the process never prompts, logs in or reaches the network.
/// </summary>
internal static class Program
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };
    internal static string Studio = "";
    internal static readonly List<string> Searched = new List<string>();

    public static int Main()
    {
        Dictionary<string, object?> answer;
        string? command = null;
        try
        {
            var input = Console.In.ReadToEnd();
            var request = Json.DeserializeObject(input) as Dictionary<string, object?> ?? throw new EngineFailure("XIF_ENGINE_REQUEST", "The request is not a JSON object.", null);
            command = request.TryGetValue("command", out var c) ? c as string : null;
            Studio = Locate();
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
            answer = Run(request);
        }
        catch (EngineFailure failure) { answer = failure.Answer(); }
        catch (Exception error)
        {
            while (error is TargetInvocationException { InnerException: not null }) error = error.InnerException!;
            answer = Unexpected(error, command).Answer();
        }
        answer["studio"] = Studio.Length == 0 ? null : new Dictionary<string, object?> { ["dir"] = Studio, ["version"] = StudioVersion(), ["lastUpgradeVersion"] = StudioLastUpgradeVersion() };
        Console.Out.WriteLine(Json.Serialize(answer));
        return answer.TryGetValue("ok", out var ok) && ok is true ? 0 : 1;
    }

    /// <summary>An exception the engine did not expect: a defect of SSAM's host of Integration Studio, never a problem of the
    /// spec (the reports of ProjectVerify are XIF_VERIFY_FAILED). The frames name methods only, never file paths.</summary>
    internal static EngineFailure Unexpected(Exception error, string? command)
    {
        var frames = (new StackTrace(error, false).GetFrames() ?? new StackFrame[0])
            .Select(f => f.GetMethod()).Where(m => m != null).Select(m => (m!.DeclaringType?.FullName ?? "?") + "." + m.Name).Take(8).ToArray();
        var message = "The SSAM engine failed inside Integration Studio" + (command == null ? "" : " (stage " + command + ")") + ": " + error.GetType().Name + ": " + error.Message
            + " This is a defect of SSAM, not of the spec; nothing was sent.";
        return new EngineFailure("XIF_ENGINE_FAILED", message, "Report it with this answer (ssam_friction); do not change the spec for it.",
            new Dictionary<string, object?> { ["stage"] = command, ["exception"] = error.GetType().FullName, ["at"] = frames });
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static Dictionary<string, object?> Run(Dictionary<string, object?> request)
    {
        var command = request.TryGetValue("command", out var c) ? c as string : null;
        var host = new Host();
        switch (command)
        {
            case "probe": return host.Probe();
            case "model": host.Require(); return host.Model(request);
            case "final": host.Require(); return host.Final(request);
            default: throw new EngineFailure("XIF_ENGINE_REQUEST", "Unknown command '" + command + "' (probe, model or final).", null);
        }
    }

    /// <summary>The Integration Studio folder: ANVIL_INTEGRATION_STUDIO_DIR, the uninstall registry, Program Files.</summary>
    private static string Locate()
    {
        var candidates = new List<string>();
        var explicitDir = Environment.GetEnvironmentVariable("ANVIL_INTEGRATION_STUDIO_DIR");
        if (!string.IsNullOrWhiteSpace(explicitDir)) candidates.Add(explicitDir!);
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
            {
                try
                {
                    using var root = RegistryKey.OpenBaseKey(hive, view);
                    using var uninstall = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
                    if (uninstall == null) continue;
                    foreach (var name in uninstall.GetSubKeyNames())
                    {
                        using var entry = uninstall.OpenSubKey(name);
                        if (entry?.GetValue("DisplayName") is string display && display.StartsWith("OutSystems Integration Studio", StringComparison.OrdinalIgnoreCase) &&
                            entry.GetValue("InstallLocation") is string location && location.Trim().Length > 0)
                            candidates.Add(location.Trim());
                    }
                }
                catch (Exception) { }
            }
        foreach (var programs in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramW6432") })
            if (!string.IsNullOrEmpty(programs)) candidates.Add(Path.Combine(programs!, "OutSystems", "Integration Studio"));
        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            Searched.Add(candidate);
            if (File.Exists(Path.Combine(candidate, "OutSystems.IntegrationStudio.Core.dll"))) return Path.GetFullPath(candidate);
            var nested = Path.Combine(candidate, "Integration Studio");
            if (File.Exists(Path.Combine(nested, "OutSystems.IntegrationStudio.Core.dll"))) { Searched.Add(nested); return Path.GetFullPath(nested); }
        }
        throw new EngineFailure("XIF_ENGINE_UNAVAILABLE", "Integration Studio is not installed on this machine (no OutSystems.IntegrationStudio.Core.dll in " + string.Join("; ", Searched) + ").",
            "Install Integration Studio 11 (the version of this environment's platform) or set ANVIL_INTEGRATION_STUDIO_DIR to its folder; nothing was generated or sent.",
            new Dictionary<string, object?> { ["searched"] = Searched.ToArray() });
    }

    private static Assembly? Resolve(object? sender, ResolveEventArgs e)
    {
        var name = new AssemblyName(e.Name).Name + ".dll";
        foreach (var dir in new[] { Studio, Path.Combine(Studio, "Plugins") })
        {
            var file = Path.Combine(dir, name);
            if (File.Exists(file)) return Assembly.LoadFrom(file);
        }
        return null;
    }

    internal static string? StudioVersion()
    {
        try { return FileVersionInfo.GetVersionInfo(Path.Combine(Studio, "OutSystems.IntegrationStudio.Core.dll")).FileVersion; }
        catch (Exception) { return null; }
    }

    /// <summary>Config.LastUpgradeVersion of the installed Integration Studio (11.0.0.200 in 11.14): the second argument of
    /// its Handshake (WebServicesFacade.Handshake passes ProductVersion, then LastUpgradeVersion). It is not the product
    /// version: the server refuses a Handshake whose lastUpVersion is the product version as an incompatible tool.</summary>
    internal static string? StudioLastUpgradeVersion()
    {
        try
        {
            var config = Assembly.LoadFrom(Path.Combine(Studio, "OutSystems.IntegrationStudio.Core.dll")).GetType("OutSystems.IntegrationStudio.Core.Config", false);
            return config?.GetProperty("LastUpgradeVersion", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null, null)?.ToString();
        }
        catch (Exception) { return null; }
    }
}

/// <summary>A refusal of the engine, in the shape of the kernel's (contract 1.6).</summary>
internal sealed class EngineFailure : Exception
{
    public string Code { get; }
    public string? Fix { get; }
    public List<Dictionary<string, object?>> Problems { get; }
    public Dictionary<string, object?>? Extra { get; }

    public EngineFailure(string code, string message, string? fix, Dictionary<string, object?>? extra = null, List<Dictionary<string, object?>>? problems = null) : base(message)
    {
        Code = code; Fix = fix; Extra = extra;
        Problems = problems ?? new List<Dictionary<string, object?>> { new Dictionary<string, object?> { ["code"] = code, ["message"] = message, ["fix"] = fix } };
    }

    public Dictionary<string, object?> Answer()
    {
        var answer = new Dictionary<string, object?> { ["ok"] = false, ["code"] = Code, ["error"] = Message, ["problems"] = Problems };
        if (Extra != null) foreach (var pair in Extra) answer[pair.Key] = pair.Value;
        return answer;
    }
}
