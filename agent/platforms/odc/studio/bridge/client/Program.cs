using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using Microsoft.Diagnostics.NETCore.Client;

// ODC3 bridge client. Usage:
//   ODC3.Bridge.Client <ODCStudio pid> attach <path to ODC3.Bridge.<version>.dll>
//   ODC3.Bridge.Client <ODCStudio pid> <command> [argument]
// Commands: status | snapshot <Module> | latest <Module> | check-base <manifest> | preview <manifest>
//           | merge <manifest> | publish <manifest> | publish-status <manifest> | data <Module> <Entity> ...
//           | portal-call <request.json> [--tenant <host>] | portal-session status|open|close|fetch ... | auth-status | stop
// A client timeout never cancels the native operation: inspect the evidence directory instead of retrying.
const string Version = "v109";
// The bridge built for each Studio runtime (Bridge.csproj): v109 for the net10 ODC Studios (1.7.30 on), v108, the same sources,
// for the net8 ones (up to 1.7.29). The agent pack carries v108, which also loads in a net10 Studio, as v102 did; a net10 v109
// never loads in a net8 one. The runtime is the Studio's own ODCStudio.runtimeconfig.json.
const string EarlierVersion = "v108";
if (args.Length < 2) throw new ArgumentException("Usage: <pid> attach <dll> | <pid> <command> [argument]");
var pid = int.Parse(args[0]);
var process = Process.GetProcessById(pid);
if (process.ProcessName != "ODCStudio" || process.MainModule?.FileName != @"C:\Program Files\OutSystems\ODC Studio\ODC Studio\ODCStudio.exe")
    throw new InvalidOperationException("Unexpected target process: only ODCStudio.exe from the official install is accepted.");
var studioRuntime = System.Text.RegularExpressions.Regex.Match(
    File.ReadAllText(Path.ChangeExtension(process.MainModule.FileName, ".runtimeconfig.json")), "\"tfm\"\\s*:\\s*\"(net\\d+\\.\\d+)\"").Groups[1].Value;
var version = studioRuntime == "net8.0" ? EarlierVersion : Version;
if (args[1] == "attach") {
    if (args.Length < 3) throw new ArgumentException("attach requires the bridge dll path.");
    var dll = Path.GetFullPath(args[2]);
    var loadable = studioRuntime == "net8.0" ? new[] { EarlierVersion } : new[] { Version, EarlierVersion };
    if (!loadable.Any(v => Path.GetFileName(dll) == "ODC3.Bridge." + v + ".dll"))
        throw new InvalidOperationException("This ODC Studio runs on " + (studioRuntime == "" ? "an unknown runtime" : studioRuntime) + ": this client only attaches "
            + string.Join(" or ", loadable.Select(v => "ODC3.Bridge." + v)) + " to it.");
    await new DiagnosticsClient(pid).ApplyStartupHookAsync(dll, new CancellationTokenSource(TimeSpan.FromSeconds(20)).Token);
    Console.WriteLine("{\"ok\":true,\"attached\":true,\"note\":\"Run status before any other command; a bridge stays loaded until the Studio closes.\"}");
    return;
}
var line = args[1] + (args.Length > 2 ? " " + string.Join(' ', args.Skip(2)) : "");
// The pipe of the bridge built for this Studio's runtime (the agent speaks the pipe itself, by the name it attached).
using var pipe = new NamedPipeClientStream(".", "ODC3-Bridge-" + version + "-" + pid, PipeDirection.InOut, PipeOptions.Asynchronous);
await pipe.ConnectAsync(10000);
using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
await writer.WriteLineAsync(line);
// Past the bridge's own deadline (BridgeDeadlines.cs), so its answer is read, never left on a closed pipe.
Console.WriteLine(await reader.ReadLineAsync().WaitAsync(BridgeDeadlines.ClientWait(args[1], string.Join(' ', args.Skip(2)))));
