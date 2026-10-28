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
const string Version = "v100";
// The bridge a Studio loads is the one built for its runtime (Bridge.csproj): v100 for the net10 ODC Studios (1.7.30 on),
// the earlier v97 binary for the net8 ones (up to 1.7.29). The runtime is the Studio's own ODCStudio.runtimeconfig.json.
const string EarlierVersion = "v97";
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
    if (Path.GetFileName(dll) != "ODC3.Bridge." + version + ".dll")
        throw new InvalidOperationException("This ODC Studio runs on " + (studioRuntime == "" ? "an unknown runtime" : studioRuntime) + ": this client only attaches ODC3.Bridge." + version + " to it.");
    await new DiagnosticsClient(pid).ApplyStartupHookAsync(dll, new CancellationTokenSource(TimeSpan.FromSeconds(20)).Token);
    Console.WriteLine("{\"ok\":true,\"attached\":true,\"note\":\"Run status before any other command; a bridge stays loaded until the Studio closes.\"}");
    return;
}
var line = args[1] + (args.Length > 2 ? " " + string.Join(' ', args.Skip(2)) : "");
using var pipe = new NamedPipeClientStream(".", "ODC3-Bridge-" + version + "-" + pid, PipeDirection.InOut, PipeOptions.Asynchronous);
await pipe.ConnectAsync(10000);
using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
await writer.WriteLineAsync(line);
Console.WriteLine(await reader.ReadLineAsync().WaitAsync(TimeSpan.FromMinutes(10)));
