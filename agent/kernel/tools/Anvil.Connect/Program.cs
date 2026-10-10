using System.Diagnostics;
using System.Text.Json;
using Microsoft.Diagnostics.NETCore.Client;

try
{
    if (args.Length < 2 || !int.TryParse(args[1], out var pid))
        throw new ArgumentException("Usage: describe <pid> | attach <pid> <startedUtc> <hook.dll>");
    using var process = Process.GetProcessById(pid);
    var executable = process.MainModule?.FileName ?? throw new InvalidOperationException("Cannot read the Studio executable.");
    if (process.ProcessName != "ServiceStudio") throw new InvalidOperationException("Only ServiceStudio.exe is accepted.");
    var studioDir = Path.GetDirectoryName(executable)!;
    foreach (var file in new[] { "ServiceStudio.runtimeconfig.json", "ServiceStudio.Framework.dll", "OutSystems.Model.V1.dll" })
        if (!File.Exists(Path.Combine(studioDir, file))) throw new InvalidOperationException("Not a compatible Service Studio installation: " + file);
    var startedUtc = process.StartTime.ToUniversalTime().ToString("O");
    var modules = process.Modules.Cast<ProcessModule>().ToArray();
    var coreclr = modules.FirstOrDefault(m => m.ModuleName.Equals("coreclr.dll", StringComparison.OrdinalIgnoreCase));
    if (coreclr == null || coreclr.FileVersionInfo.FileMajorPart < 8)
        throw new InvalidOperationException("Runtime connection requires .NET 8 or later. The Studio has not been changed.");
    if (args[0] == "describe")
    {
        Console.WriteLine(JsonSerializer.Serialize(new {
            ok = true, pid, path = executable, studioDir, startedUtc,
            version = FileVersionInfo.GetVersionInfo(executable).FileVersion,
            bridgePath = modules.FirstOrDefault(m => m.ModuleName.Equals("Anvil.Bridge.dll", StringComparison.OrdinalIgnoreCase))?.FileName,
            corePath = modules.FirstOrDefault(m => m.ModuleName.Equals("Anvil.Core.dll", StringComparison.OrdinalIgnoreCase))?.FileName,
            diagnosticsAvailable = DiagnosticsClient.GetPublishedProcesses().Contains(pid)
        }));
    }
    else if (args[0] == "attach" && args.Length == 4)
    {
        if (startedUtc != args[2]) throw new InvalidOperationException("The Studio process changed. Discover it again before connecting.");
        var hook = Path.GetFullPath(args[3]);
        if (!File.Exists(hook)) throw new FileNotFoundException("Hook not found.", hook);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await new DiagnosticsClient(pid).ApplyStartupHookAsync(hook, timeout.Token);
        Console.WriteLine("{\"ok\":true,\"hookRequested\":true}");
    }
    else throw new ArgumentException("Unknown connector command.");
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = error.Message }));
    Environment.ExitCode = 1;
}
