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
    public sealed record IdleWork(Action<CancellationToken> Run, Func<string[], bool> Wait, Action Shed, TimeSpan Poll);

    private sealed record Request(string[] Args, long Received, TaskCompletionSource<JsonObject> Completion);
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
                        lock (state)
                        {
                            if (draining || queue.IsAddingCompleted) request.Completion.SetResult(Retry(args[0]));
                            else { queue.Add(request); running = idleRun; }
                        }
                        if (running != null) Arrived(running, args);
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
            lock (state)
            {
                if (draining) { request.Completion.TrySetResult(Retry(command)); continue; }
                current = command; started = Stopwatch.GetTimestamp();
            }
            JsonObject result;
            try
            {
                result = command == "shutdown" ? Success(command, Status())
                    : command == "serve" ? Failure(command, "serve inside worker is not allowed") : execute(request.Args);
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
