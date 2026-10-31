using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

// The real ODC bridge DLL in a process of its own, without a Studio: what a test needs to prove the command server end to end
// over the real pipe. Nothing attaches to anything; the Studio's folder is only read, for the assemblies the bridge binds to.
// Set SSAM_HYBRID_ODC_ROOT to the data folder of the run.
//
//   dotnet ODC3.Bridge.IsolatedHost.dll <bridge dll> <ODC Studio folder> [--ui-after <seconds>] [--queue-probe <evidence folder>]
//
// --ui-after:    the UI thread starts answering only then, as a Studio whose UI was held and came back. Without it, it never does.
//                No module is open in this process, so a command that reaches the Studio then ends with its refusal.
// --queue-probe: instead of the pipe, hands the bridge's own queue (TabQueue, its own bound) a tab that never becomes idle, says what
//                it answered and when, then runs the queued callback as a tab that comes back would: {seconds, refusal, ranLate, notStarted}.
// The first line of the output is {pid, pipe}; the process ends when its input closes.
var dll = Path.GetFullPath(args[0]);
var studio = Path.GetFullPath(args[1]);
int? uiAfter = null;
string? queueProbe = null;
for (var i = 2; i < args.Length; i++) {
    if (args[i] == "--ui-after") uiAfter = int.Parse(args[++i]);
    else if (args[i] == "--queue-probe") queueProbe = Path.GetFullPath(args[++i]);
    else throw new ArgumentException("Unknown argument: " + args[i]);
}
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var file = Path.Combine(studio, name.Name + ".dll");
    return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
};
// The UI thread is the first one to ask for it: this one, as in a Studio.
var avalonia = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(studio, "Avalonia.Base.dll"));
var dispatcherType = avalonia.GetType("Avalonia.Threading.Dispatcher", true)!;
var dispatcher = dispatcherType.GetProperty("UIThread", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
var bridge = AssemblyLoadContext.Default.LoadFromAssemblyPath(dll);
if (queueProbe != null) { await QueueProbe.Run(bridge, queueProbe); return; }
bridge.GetType("StartupHook", true)!.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null);
var version = Path.GetFileNameWithoutExtension(dll).Split('.')[^1];
Console.WriteLine(JsonSerializer.Serialize(new { pid = Environment.ProcessId, pipe = "ODC3-Bridge-" + version + "-" + Environment.ProcessId }));
using var ended = new CancellationTokenSource();
_ = Task.Run(async () => { try { await Console.In.ReadToEndAsync(); } catch { } ended.Cancel(); });
if (uiAfter is int seconds) {
    if (ended.Token.WaitHandle.WaitOne(TimeSpan.FromSeconds(seconds))) return;
    Console.WriteLine(JsonSerializer.Serialize(new { ui = "answering", at = DateTimeOffset.UtcNow }));
    // No windowing platform in this process, so no MainLoop: the queued jobs of the UI thread run here.
    var runJobs = dispatcherType.GetMethods(BindingFlags.Public | BindingFlags.Instance).Where(m => m.Name == "RunJobs").OrderBy(m => m.GetParameters().Length).First();
    var none = new object?[runJobs.GetParameters().Length];
    while (!ended.Token.WaitHandle.WaitOne(50)) runJobs.Invoke(dispatcher, none);
} else ended.Token.WaitHandle.WaitOne();

// The bridge's own queue on a tab that never becomes idle: the callback is queued and never run, then run late.
internal static class QueueProbe {
    public static async Task Run(Assembly bridge, string evidence) {
        var queue = bridge.GetType("TabQueue");
        if (queue == null) { Console.WriteLine(JsonSerializer.Serialize(new { absent = "This bridge has no bound on a queued job." })); return; }
        var limit = (TimeSpan)bridge.GetType("BridgeDeadlines", true)!.GetProperty("QueueStart", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
        Action? queued = null;
        var ran = false;
        Func<Action, Task> enqueue = job => { queued = job; return new TaskCompletionSource().Task; };
        Func<object> work = () => { ran = true; return "ran"; };
        Func<DateTimeOffset, Task<string?>> abandoned = _ => { File.WriteAllText(Path.Combine(evidence, "not-started.json"), "{}"); return Task.FromResult<string?>(null); };
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var task = (Task<object>)queue.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!.MakeGenericMethod(typeof(object)).Invoke(null, new object?[] { enqueue, "merge", "Fixture", limit, work, abandoned })!;
        string? refusal = null;
        try { await task; } catch (Exception error) { refusal = error.Message; }
        var seconds = Math.Round(clock.Elapsed.TotalSeconds, 1);
        queued?.Invoke(); // the tab becomes idle after all: the abandoned job must do nothing
        Console.WriteLine(JsonSerializer.Serialize(new { seconds, refusal, ranLate = ran, notStarted = File.Exists(Path.Combine(evidence, "not-started.json")) }));
    }
}
