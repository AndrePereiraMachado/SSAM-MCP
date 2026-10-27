using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core.Hosting;

/// <summary>JSON-lines transport: responsive readers, one dedicated execution thread, explicit safe retry on draining.</summary>
public sealed class WorkerServer : IDisposable
{
    /// <summary>Work the dispatch thread does while the queue is empty (the base model cache): <see cref="Run"/> after each
    /// reply and every <see cref="Poll"/> while idle. A request queued meanwhile cancels its token unless <see cref="Wait"/>
    /// says the request needs what Run is preparing; it then waits for the remainder. <see cref="Shed"/> runs after each
    /// command, before the heap recycle rule.</summary>
    public sealed record IdleWork(Action<CancellationToken> Run, Func<string[], bool> Wait, Action Shed, TimeSpan Poll)
    {
        /// <summary>L3b: the `warm` command (the base cache's <c>Warm</c>): it names the captures the idle work prepares next and
        /// answers at once; the ping says `warm:true`. Null: the command is the host's (anvil-odc's builder has none).</summary>
        public Func<string[], JsonObject>? Warm { get; init; }
        public const string WarmCommand = "warm";
    }

    private sealed record Request(string[] Args, long Received, TaskCompletionSource<JsonObject> Completion)
    {
        // Under the state lock: the dispatch thread took it (Started), or its client gave up before that (Withdrawn: never run).
        public bool Started { get; set; }
        public bool Withdrawn { get; set; }
    }
    private readonly TcpListener listener;
    private readonly BlockingCollection<Request> queue = new();
    private readonly Func<string[], JsonObject> execute;
    private readonly Func<JsonObject, bool>? authorize;
    private readonly Action<string>? log;
    private readonly Func<long> heap;
    private readonly int maxCommands;
    private readonly Func<JsonObject>? commandMetrics;
    private readonly IdleWork? idle;
    private readonly TimeSpan? idleExit;
    private long lastCommand = Stopwatch.GetTimestamp();
    private JsonObject metadata;
    private readonly CancellationTokenSource stopping = new();
    private readonly ConcurrentDictionary<int, Task> clients = new();
    private readonly object state = new();
    private string? current;
    private CancellationTokenSource? idleRun;
    private long started, served, commands;
    private bool draining;
    private int highHeap, clientId;
    public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;
    public string InstanceId { get; } = Guid.NewGuid().ToString("N");

    /// <summary>The worker that executed no command for this long exits by itself (a worker of an installation nobody
    /// selects any more, or left behind by a session, never runs forever). Read here, so every host (anvil serve,
    /// anvil-odc serve, the snapshot reader) gets it without a change of its own: ANVIL_WORKER_IDLE_MINUTES, decimal
    /// minutes; unset or invalid is <see cref="DefaultIdleExit"/>; 0 or less never exits. Pings do not count as work: a
    /// client that only checks the worker does not keep it alive. A request that arrives while it exits is answered
    /// "recycling, not executed" (retryable), as on any recycle, and the client starts a new worker.</summary>
    public static readonly TimeSpan DefaultIdleExit = TimeSpan.FromMinutes(240);
    public const string IdleExitVariable = "ANVIL_WORKER_IDLE_MINUTES";
    public static TimeSpan? IdleExitFrom(string? minutes)
    {
        if (string.IsNullOrWhiteSpace(minutes)) return DefaultIdleExit;
        if (!double.TryParse(minutes.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value)
            || double.IsNaN(value) || double.IsInfinity(value)) return DefaultIdleExit;
        return value <= 0 ? null : TimeSpan.FromMinutes(Math.Min(value, TimeSpan.MaxValue.TotalMinutes / 2));
    }
    /// <summary>The idle exit in effect (null: never).</summary>
    public TimeSpan? IdleExit => idleExit;

    public WorkerServer(int port, Func<string[], JsonObject> execute, int maxCommands = 5000, Func<long>? heap = null, Action<string>? log = null, Func<JsonObject>? commandMetrics = null, JsonObject? initialMetrics = null, Func<JsonObject, bool>? authorize = null, IdleWork? idle = null, TimeSpan? idleExit = null)
    {
        this.authorize = authorize; this.idle = idle;
        this.idleExit = idleExit is { } explicitExit ? (explicitExit > TimeSpan.Zero ? explicitExit : null) : IdleExitFrom(Environment.GetEnvironmentVariable(IdleExitVariable));
        this.commandMetrics = commandMetrics; metadata = initialMetrics?.DeepClone().AsObject() ?? new();
        this.execute = execute; this.maxCommands = Math.Max(1, maxCommands);
        this.heap = heap ?? (() => GC.GetTotalMemory(false)); this.log = log;
        listener = new TcpListener(IPAddress.Loopback, port); listener.Start();
    }

    public async Task RunAsync()
    {
        var worker = new Thread(Work) { IsBackground = true, Name = "anvil-dispatch" };
        worker.Start();
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(stopping.Token);
                var id = Interlocked.Increment(ref clientId);
                var task = Handle(client);
                clients[id] = task;
                _ = task.ContinueWith(_ => clients.TryRemove(id, out var ignored), TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) { }
        catch (SocketException) when (stopping.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (stopping.IsCancellationRequested) { }
        finally
        {
            queue.CompleteAdding();
            worker.Join();
            await Task.WhenAll(clients.Values);
        }
    }

    public JsonObject Status()
    {
        lock (state)
        {
        var result = new JsonObject
        {
            ["protocol"] = "anvil-worker-1", ["instanceId"] = InstanceId, ["pid"] = Environment.ProcessId,
            ["busy"] = current != null, ["currentCommand"] = current,
            ["runningMs"] = current == null ? 0 : Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            ["queued"] = queue.Count, ["served"] = served, ["commands"] = commands, ["recycling"] = draining, ["idleWork"] = idleRun != null,
            ["idleExitMinutes"] = idleExit is { } exit ? Math.Round(exit.TotalMinutes, 2) : null,
            ["gcMB"] = heap() >> 20, ["workingSetMB"] = Environment.WorkingSet >> 20,
        };
        // S14: a worker with spares (the base cache's idle work) reads over them (HotModuleRead).
        if (idle != null) result["hotRead"] = true;
        if (idle?.Warm != null) result["warm"] = true;
        foreach (var pair in metadata) result[pair.Key] = pair.Value?.DeepClone();
        return result;
        }
    }

    private async Task Handle(TcpClient client)
    {
        using (client)
        using (var stream = client.GetStream())
        using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
        {
            try
            {
                while (!stopping.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(stopping.Token);
                    if (line == null) break;
                    JsonObject reply;
                    string[] args;
                    try
                    {
                        var request = JsonNode.Parse(line)?.AsObject() ?? throw new ArgumentException("request must be an object");
                        args = request["args"]?.AsArray().Select(n => n!.GetValue<string>()).ToArray()
                            ?? throw new ArgumentException("args must be an array");
                        if (args.Length == 0) throw new ArgumentException("command is required");
                        if (args[0] != "ping" && authorize != null && !authorize(request))
                        {
                            var denied = Failure(args[0], "Worker operation requires the trusted Hybrid controller");
                            denied["executed"] = false;
                            await writer.WriteLineAsync(denied.ToJsonString());
                            continue;
                        }
                    }
                    catch (Exception ex)
                    {
                        await writer.WriteLineAsync(Failure("?", ex.Message).ToJsonString()); continue;
                    }
                    lock (state) served++;
                    if (args[0] == "ping") reply = Success("ping", Status());
                    else
                    {
                        var request = new Request(args, Stopwatch.GetTimestamp(), new(TaskCreationOptions.RunContinuationsAsynchronously));
                        CancellationTokenSource? running = null;
                        var hotRead = args[0] == HotModuleRead.Command;
                        // S14/L3b: a hot read of the model whose spare is being prepared joins that prefetch (the base cache's
                        // Wait says so, and the idle step ends after it); any other prefetch is never stopped for a read.
                        var joins = hotRead && idle != null && idleRun != null && JoinsPrefetch(args);
                        lock (state)
                        {
                            if (draining || queue.IsAddingCompleted) request.Completion.SetResult(Retry(args[0]));
                            // S14: otherwise a hot read never waits nor stops a prefetch: refused at once (not executed) unless the
                            // dispatch thread is free now; the caller then reads cold.
                            else if (hotRead && (idle == null || current != null || queue.Count > 0 || idleRun != null && !joins))
                                request.Completion.SetResult(HotModuleRead.Busy(idle == null ? "this worker keeps no spare" : current != null ? "busy with " + current : queue.Count > 0 ? "requests queued" : "preparing the spare of another model"));
                            else { queue.Add(request); running = hotRead ? null : idleRun; }
                        }
                        if (running != null) Arrived(running, args);
                        // A joined hot read waits at most HotModuleRead.JoinWait for the prefetch; still not taken then, it is
                        // withdrawn (never run) and refused, and the caller reads cold.
                        if (joins && await Task.WhenAny(request.Completion.Task, Task.Delay(HotModuleRead.JoinWait)) != request.Completion.Task)
                            lock (state)
                                if (!request.Started) { request.Withdrawn = true; request.Completion.TrySetResult(HotModuleRead.Busy("the spare of this model was still being prepared after " + HotModuleRead.JoinWait.TotalSeconds + " s")); }
                        reply = await request.Completion.Task;
                    }
                    await writer.WriteLineAsync(reply.ToJsonString());
                }
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
            catch (IOException) { log?.Invoke("worker: connection closed before reply delivery; execution outcome may be unknown to client"); }
            catch (SocketException) { log?.Invoke("worker: connection closed before reply delivery; execution outcome may be unknown to client"); }
        }
    }

    private void Work()
    {
        var poll = idle == null ? Timeout.Infinite : (int)idle.Poll.TotalMilliseconds;
        while (true)
        {
            if (!queue.TryTake(out var request, WaitBeforeIdleExit(poll)))
            {
                if (queue.IsCompleted) return;
                if (IdleExpired())
                {
                    log?.Invoke($"worker: no command for {idleExit!.Value.TotalMinutes:0.##} min ({IdleExitVariable}); exiting");
                    Stop();
                    continue;
                }
                RunIdle();
                continue;
            }
            var command = request.Args[0];
            bool withdrawn;
            lock (state)
            {
                if (draining) { request.Completion.TrySetResult(Retry(command)); continue; }
                withdrawn = request.Withdrawn;
                if (!withdrawn) { request.Started = true; current = command; started = Stopwatch.GetTimestamp(); }
            }
            // A hot read that gave up waiting was answered already: nothing runs, the idle work goes on.
            if (withdrawn) { RunIdle(); continue; }
            JsonObject result;
            try
            {
                result = command == "shutdown" ? Success(command, Status())
                    : command == "serve" ? Failure(command, "serve inside worker is not allowed")
                    : command == HotModuleRead.Command && idle != null ? HotModuleRead.Serve(request.Args)
                    : command == IdleWork.WarmCommand && idle?.Warm is { } warm ? warm(request.Args) : execute(request.Args);
            }
            catch (Exception ex) { result = Failure(command, ex.Message); }
            try { idle?.Shed(); } catch (Exception ex) { log?.Invoke("worker: idle shed failed: " + ex.Message); }
            JsonObject? metrics = null;
            try { metrics = commandMetrics?.Invoke(); } catch { }
            result["queuedMs"] = (long)Stopwatch.GetElapsedTime(request.Received, started).TotalMilliseconds;
            bool recycle;
            lock (state)
            {
                if (metrics != null) foreach (var pair in metrics) metadata[pair.Key] = pair.Value?.DeepClone();
                if (command != "shutdown") commands++;
                highHeap = heap() > 2048L * 1024 * 1024 ? highHeap + 1 : 0;
                current = null; lastCommand = Stopwatch.GetTimestamp();
                recycle = command == "shutdown" || commands >= maxCommands || highHeap >= 2;
                if (recycle) { draining = true; result["recycling"] = true; }
            }
            request.Completion.TrySetResult(result);
            if (recycle)
            {
                log?.Invoke($"worker: drain after {commands} commands ({(command == "shutdown" ? "shutdown" : highHeap >= 2 ? "heap" : "limit")})");
                Stop();
            }
            else RunIdle();
        }
    }

    /// <summary>How long the dispatch thread may wait for a request: the idle-work poll, cut to the moment the idle exit is due.</summary>
    private int WaitBeforeIdleExit(int poll)
    {
        if (idleExit is not { } limit) return poll;
        long since; lock (state) since = lastCommand;
        var left = Math.Ceiling((limit - Stopwatch.GetElapsedTime(since)).TotalMilliseconds);
        var ms = (int)Math.Clamp(left, 0, int.MaxValue - 1);
        return poll == Timeout.Infinite ? ms : Math.Min(poll, ms);
    }

    /// <summary>No command for the idle-exit time, nothing queued and nothing running.</summary>
    private bool IdleExpired()
    {
        if (idleExit is not { } limit) return false;
        lock (state) return !draining && current == null && queue.Count == 0 && Stopwatch.GetElapsedTime(lastCommand) >= limit;
    }

    /// <summary>Idle work on this (the dispatch) thread, only while nothing is queued; the metrics are read again after it.</summary>
    private void RunIdle()
    {
        if (idle == null) return;
        CancellationTokenSource run;
        lock (state)
        {
            if (draining || queue.Count > 0) return;
            idleRun = run = new CancellationTokenSource();
        }
        try { idle.Run(run.Token); }
        catch (Exception ex) { log?.Invoke("worker: idle work failed: " + ex.Message); }
        JsonObject? metrics = null;
        try { metrics = commandMetrics?.Invoke(); } catch { }
        lock (state)
        {
            idleRun = null;
            if (metrics != null) foreach (var pair in metrics) metadata[pair.Key] = pair.Value?.DeepClone();
        }
        run.Dispose();
    }

    private bool JoinsPrefetch(string[] args)
    {
        try { return idle!.Wait(args); } catch { return false; }
    }

    private void Arrived(CancellationTokenSource running, string[] args)
    {
        bool wait;
        try { wait = idle!.Wait(args); } catch { wait = false; }
        if (!wait) CancelIdle(running);
    }

    private static void CancelIdle(CancellationTokenSource? running)
    {
        try { running?.Cancel(); } catch (ObjectDisposedException) { }
    }

    private static JsonObject Success(string command, JsonObject data) => new() { ["ok"] = true, ["command"] = command, ["elapsedMs"] = 0, ["data"] = data };
    private static JsonObject Failure(string command, string error) => new() { ["ok"] = false, ["command"] = command, ["error"] = error };
    private static JsonObject Retry(string command) => new() { ["ok"] = false, ["command"] = command,
        ["error"] = "worker recycling; request was not executed", ["retryable"] = true, ["executed"] = false };
    public void Stop()
    {
        CancellationTokenSource? running;
        lock (state) { draining = true; queue.CompleteAdding(); running = idleRun; }
        CancelIdle(running);
        stopping.Cancel(); listener.Stop();
    }
    public void Dispose() { Stop(); stopping.Dispose(); queue.Dispose(); }
}


/// <summary>
/// S14 (leitura quente): the `hot-read` command of the write worker. The reader itself (HotModuleRead.Kernel.cs) is set by the
/// kernel over its spare of the model; a build that shares this file without it (the ODC builder) has no reader and answers Busy.
/// </summary>
public static partial class HotModuleRead
{
    public const string Command = "hot-read";

    /// <summary>Set by the kernel part; null where the worker keeps no spare of a model.</summary>
    public static Func<string[], JsonObject>? Reader { get; set; }

    /// <summary>L3b follow-up: the longest a hot read of the model being prepared waits for that prefetch (the load and walk of a
    /// large module in a warm worker: ~2 s after a merge, ~6 s as the first load of the process).</summary>
    public static TimeSpan JoinWait { get; set; } = TimeSpan.FromSeconds(8);

    /// <summary>A test's own reader, for the flow of execution that starts the worker (its dispatch thread inherits it).</summary>
    internal static readonly AsyncLocal<Func<string[], JsonObject>?> ReaderOverride = new();

    public static JsonObject Busy(string why) => new() { ["ok"] = false, ["command"] = Command, ["executed"] = false, ["code"] = "WORKER_BUSY",
        ["error"] = "the worker is not free for a hot read (" + why + "); nothing ran" };

    public static JsonObject Serve(string[] args) => (ReaderOverride.Value ?? Reader) is { } read ? read(args) : Busy("this worker has no hot reader");
}
