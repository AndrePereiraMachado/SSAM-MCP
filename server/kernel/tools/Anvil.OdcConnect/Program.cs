using System.Diagnostics;
using System.Text.Json;
using Microsoft.Diagnostics.NETCore.Client;

try
{
    if (args.Length < 2 || !int.TryParse(args[1], out var pid)) throw new ArgumentException("describe <pid> | attach <pid> <startedUtc> <unique-hook.dll>");
    using var process = Process.GetProcessById(pid);
    if (process.ProcessName != "ODCStudio") throw new InvalidOperationException("Only ODCStudio.exe is accepted.");
    var executable = process.MainModule?.FileName ?? throw new InvalidOperationException("Studio executable unavailable.");
    var studioDir = Path.GetDirectoryName(executable)!;
    foreach (var name in new[] { "ODCStudio.runtimeconfig.json", "ServiceStudio.Presenter.dll", "ServiceStudio.Identity.dll", "OutSystems.Model.V1.dll" })
        if (!File.Exists(Path.Combine(studioDir, name))) throw new InvalidOperationException("Unsupported ODC Studio installation.");
    var startedUtc = process.StartTime.ToUniversalTime().ToString("O");
    var coreclr = process.Modules.Cast<ProcessModule>().FirstOrDefault(m => m.ModuleName.Equals("coreclr.dll", StringComparison.OrdinalIgnoreCase));
    if (coreclr == null || coreclr.FileVersionInfo.FileMajorPart < 8) throw new InvalidOperationException("ODC Studio requires .NET 8 or later for runtime connection.");
    if (args[0] == "describe" && args.Length == 2)
        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, pid, path = executable, studioDir, startedUtc, diagnosticsAvailable = DiagnosticsClient.GetPublishedProcesses().Contains(pid) }));
    else if (args[0] == "attach" && args.Length == 4)
    {
        if (args[2] != startedUtc) throw new InvalidOperationException("Studio process changed.");
        var hook = Path.GetFullPath(args[3]);
        if (!File.Exists(hook) || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(hook), "^Anvil\\.OdcSessionHook\\.[a-f0-9]{32}\\.dll$"))
            throw new InvalidOperationException("A uniquely named ODC session component is required.");
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
