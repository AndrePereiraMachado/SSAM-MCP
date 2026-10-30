using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

// screen.render in the native core, the rules of agent/lib/render.mjs: the renderer is pack.json renderer {kind:
// "electron-worker", protocol: 1, path} relative to the runtime, inside the installation (two folders up) and present;
// only then the hello announces the kind. One worker at a time and two calls waiting (RENDER_BUSY above); the request is
// checked (RenderRequest.cs), the worker "<renderer> --ssam-render-worker" gets it on its standard input and a temporary
// folder of its own under private/tmp as TEMP (removed after it ended); it is killed with its processes at the request's
// timeoutMs or the call's deadline (RENDER_TIMEOUT); another exit code or more than 20 MiB of output is RENDER_FAILED; its
// facts are checked before they are answered. Nothing on this machine changes: executed is false.
internal sealed class RenderKinds
{
    internal const string Flag = "--ssam-render-worker";
    internal const int StdoutBytes = 20 * 1024 * 1024;
    internal const int Queue = 2;
    private readonly string? path;
    private readonly string tempRoot;
    private readonly SemaphoreSlim worker = new(1);
    private int waiting;
    public string? Reason { get; }
    public string? Version { get; }
    public bool Available => path != null;
    // The doctor's line, as the Node agent writes it.
    public string Line => Available ? $"available (Electron {Version ?? "version unknown"})" : $"not available ({Reason ?? "no renderer"})";

    public RenderKinds(string? runtimeRoot, JsonObject? pack, string dataRoot)
    {
        tempRoot = Path.Combine(dataRoot, "private", "tmp");
        (path, Version, Reason) = Resolve(runtimeRoot, pack, dataRoot);
    }

    internal static (string? Path, string? Version, string? Reason) Resolve(string? runtimeRoot, JsonObject? pack, string dataRoot)
    {
        if (runtimeRoot == null || pack?["renderer"] is not JsonObject renderer) return (null, null, "this installation has no SSAM Agent app to render with");
        if (StudioKinds.Text(renderer["kind"]) != "electron-worker" || renderer["protocol"] is not JsonValue protocol || !protocol.TryGetValue<long>(out var number) || number != RenderRequest.Protocol)
            return (null, null, "the renderer of this installation speaks another protocol");
        var relative = StudioKinds.Text(renderer["path"]);
        if (string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative)) return (null, null, "the renderer path of this installation is not relative");
        var runtime = Path.GetFullPath(runtimeRoot);
        var install = Path.GetFullPath(Path.Combine(runtime, "..", ".."));
        var file = Path.GetFullPath(Path.Combine(runtime, relative));
        if (!LocalPaths.Inside(file, install) || LocalPaths.Inside(file, runtime) || LocalPaths.Inside(file, Path.GetFullPath(dataRoot))) return (null, null, "the renderer path leaves the installation");
        try
        {
            if (!File.Exists(file)) return (null, null, "the renderer is missing from the installation");
            var real = OperatingSystem.IsWindows() ? NativeFileIdentity.FinalPathOf(file) : MacPlatform.RealPath(file);
            var realInstall = NativeFileIdentity.RealDirectory(install);
            if (!LocalPaths.Inside(real, realInstall)) return (null, null, "the renderer path leaves the installation");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return (null, null, "the renderer is missing from the installation"); }
        var version = StudioKinds.Text(renderer["electron"]);
        return (file, version is null ? null : version[..Math.Min(40, version.Length)], null);
    }

    public async Task<JsonNode> Execute(JsonObject parameters, long? deadline, CancellationToken token)
    {
        if (path == null) throw new AgentFault("RENDER_UNAVAILABLE", "This agent cannot render screens: " + (Reason ?? "no renderer") + ". Update the SSAM Agent app to render screens.");
        var request = RenderRequest.Validate(parameters);
        if (!worker.Wait(0))
        {
            if (Interlocked.Increment(ref waiting) > Queue) { Interlocked.Decrement(ref waiting); throw new AgentFault("RENDER_BUSY", "The agent is already rendering and has two renders waiting; try again shortly"); }
            try { await worker.WaitAsync(token); } finally { Interlocked.Decrement(ref waiting); }
        }
        try
        {
            var budget = Math.Min(request["timeoutMs"]!.GetValue<long>(), deadline is long at ? at - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : long.MaxValue);
            if (budget <= 0) throw new AgentFault("RENDER_TIMEOUT", "The deadline of the call passed before the render started");
            return RenderRequest.ValidateFacts(await RunWorker(request, budget, token), request);
        }
        finally { worker.Release(); }
    }

    private async Task<JsonNode?> RunWorker(JsonObject request, long budgetMs, CancellationToken token)
    {
        string temp;
        try { Directory.CreateDirectory(tempRoot); temp = Path.Combine(tempRoot, "render-" + Guid.NewGuid().ToString("N")[..12]); Directory.CreateDirectory(temp); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw new AgentFault("RENDER_FAILED", "The render worker has no temporary folder"); }
        var start = new ProcessStartInfo(path!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Flag);
        start.Environment.Remove("ELECTRON_RUN_AS_NODE");
        start.Environment["TEMP"] = temp; start.Environment["TMP"] = temp; start.Environment["TMPDIR"] = temp;
        Process process;
        try { process = Process.Start(start) ?? throw new IOException("no process"); }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        { Cleanup(temp); throw new AgentFault("RENDER_FAILED", "The render worker could not start"); }
        using (process)
        {
            var reason = (string?)null;
            using var output = new MemoryStream();
            var reading = Task.Run(async () =>
            {
                var buffer = new byte[65536]; int count;
                var stream = process.StandardOutput.BaseStream;
                while ((count = await stream.ReadAsync(buffer)) > 0)
                {
                    if (output.Length + count > StdoutBytes) { reason ??= "large"; Kill(process); continue; }
                    output.Write(buffer, 0, count);
                }
            });
            var discard = Task.Run(async () => { try { await process.StandardError.BaseStream.CopyToAsync(Stream.Null); } catch (IOException) { } });
            try
            {
                var input = Encoding.UTF8.GetBytes(request.ToJsonString());
                await process.StandardInput.BaseStream.WriteAsync(input, token);
                process.StandardInput.Close();
            }
            catch (IOException) { /* the worker ended before reading: its exit code says why */ }
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(TimeSpan.FromMilliseconds(Math.Min(budgetMs, int.MaxValue)));
            try { await process.WaitForExitAsync(limit.Token); }
            catch (OperationCanceledException) { reason ??= "timeout"; Kill(process); await process.WaitForExitAsync(CancellationToken.None); }
            try { await Task.WhenAll(reading, discard).WaitAsync(TimeSpan.FromSeconds(10)); } catch (Exception e) when (e is TimeoutException or IOException) { }
            Cleanup(temp);
            if (reason == "timeout") throw new AgentFault("RENDER_TIMEOUT", $"The render did not finish in {Math.Round(budgetMs / 1000d)} s; the worker was stopped");
            if (reason == "large") throw new AgentFault("RENDER_FAILED", $"The render worker wrote more than {StdoutBytes} bytes; the worker was stopped");
            if (process.ExitCode != 0) throw new AgentFault("RENDER_FAILED", $"The render worker ended with code {process.ExitCode}");
            var line = Encoding.UTF8.GetString(output.ToArray()).Split('\n').Select(l => l.TrimEnd('\r')).LastOrDefault(l => l.Trim().Length > 0);
            try { return JsonNode.Parse(line ?? ""); }
            catch (System.Text.Json.JsonException) { throw new AgentFault("RENDER_FAILED", "The render worker did not write one line of JSON"); }
        }
    }

    private static void Kill(Process process) { try { process.Kill(true); } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { } }
    // The worker's helpers may hold its profile for a moment after it ended.
    private static void Cleanup(string temp) => _ = Task.Run(async () =>
    {
        for (var attempt = 0; attempt < 30 && Directory.Exists(temp); attempt++)
        {
            try { Directory.Delete(temp, true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { await Task.Delay(200); }
        }
    });
}
