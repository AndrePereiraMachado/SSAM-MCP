using System.IO.Pipes;
using System.Text;

// The Studio-free halves of the bridge's command server and of the jobs it queues on a Studio tab. Compiled into the
// bridge (StartupHook.cs uses them) and into Bridge.Tests, so each rule is proven without a Studio.
//
// The family they close (2026-10-22, again 2026-10-30 at the R3 gate): a merge queued on a module tab (ExecuteInContext,
// executeWhenTopLevelIsIdle) did not run because the tab never became idle; the client gave up, the bridge's late answer hit
// a closed pipe, the IOException left the one loop that served every command, and the pipe never came back for the life of
// the Studio. A re-attach ran the startup hook again, but Start() refused to start a second loop, so attach "succeeded" on
// a dead pipe. The first fix (d5b65432) was lost in the merge 6c574812 of 2026-10-27.

// Runs the command server: one accepted connection per call of serveOne, until serveOne answers false (the stop command).
// A failed connection is recorded and never ends the loop. A server that cannot even create its pipe backs off
// (250 ms -> 5 s) and gives up only after maxConsecutiveFailures in a row, recording why, so it never spins.
internal static class ServeLoop {
    public static async Task Run(Func<Task<bool>> serveOne, Action<Exception> record, Func<TimeSpan, Task>? delay = null, int maxConsecutiveFailures = 50) {
        delay ??= Task.Delay;
        var failures = 0;
        while (true) {
            try {
                if (!await serveOne()) return;
                failures = 0;
            } catch (Exception error) {
                failures++;
                try { record(error); } catch { /* recording never ends the server */ }
                if (failures >= maxConsecutiveFailures) {
                    try { record(new InvalidOperationException("The bridge command server stopped after " + failures + " consecutive failures; attach again to start it.")); } catch { }
                    return;
                }
                await delay(TimeSpan.FromMilliseconds(Math.Min(5000, 250 * (1 << Math.Min(failures - 1, 5)))));
            }
        }
    }
}

// The command server of this load. The startup hook runs Start() on every attach; a server that runs is kept, a server that
// ended (stopped, or given up) is started again, so attaching the same DLL again revives a lost pipe instead of answering
// success on it.
internal sealed class ServerSlot {
    private readonly object gate = new();
    private Task? running;
    public bool IsRunning { get { lock (gate) return running is { IsCompleted: false }; } }
    public bool Ensure(Func<Task> start) {
        lock (gate) {
            if (running is { IsCompleted: false }) return false;
            running = Task.Run(start);
            return true;
        }
    }
}

// A job handed to a Studio tab's queue. The Studio runs it when its top level is idle, which may be much later or never.
// Exactly one of TryStart (the tab runs the job) and Abandon (the caller's bound passed first) wins: an abandoned job never
// runs, so a caller that answered "not started, nothing executed" is never contradicted by a merge that lands later.
internal sealed class QueuedJob {
    private const int Queued = 0, Running = 1, Abandoned = 2;
    private int state = Queued;
    private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public bool IsStarted => Volatile.Read(ref state) == Running;
    public bool IsAbandoned => Volatile.Read(ref state) == Abandoned;
    // First line of the queued callback: false means the caller gave up on it; the callback returns without doing anything.
    public bool TryStart() {
        if (Interlocked.CompareExchange(ref state, Running, Queued) != Queued) return false;
        started.TrySetResult();
        return true;
    }
    public bool Abandon() => Interlocked.CompareExchange(ref state, Abandoned, Queued) == Queued;
    // True when the tab started the job within the limit (or in the instant the limit passed); false when it did not and
    // the job was abandoned: it will never run.
    public async Task<bool> StartedWithin(TimeSpan limit, Func<TimeSpan, Task>? delay = null) {
        delay ??= Task.Delay;
        if (await Task.WhenAny(started.Task, delay(limit)) == started.Task) return true;
        return !Abandon();
    }
}

// Every job the bridge queues on a tab goes through here. enqueue hands the callback to the tab; the job starts within limit,
// or it is abandoned (it never runs later) and the command refuses with JobNotStartedException: nothing was executed, the
// module is unchanged. abandoned: what the caller records, and the state of the tab for the refusal. A queue the tab itself
// refuses or drops answers at once.
internal static class TabQueue {
    public static async Task<T> Run<T>(Func<Action, Task> enqueue, string what, string module, TimeSpan limit, Func<T> work, Func<DateTimeOffset, Task<string?>> abandoned) {
        var job = new QueuedJob();
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var queuedAt = DateTimeOffset.UtcNow;
        var queued = enqueue(() => {
            if (!job.TryStart()) return; // abandoned: the caller already answered "not started"
            try { done.SetResult(work()); } catch (Exception error) { done.SetException(error); }
        });
        _ = queued.ContinueWith(t => {
            if (job.Abandon()) done.TrySetException(t.Exception?.GetBaseException() ?? new InvalidOperationException("The Studio dropped the queued " + what + " of " + module + " without running it; nothing was executed."));
        }, CancellationToken.None, TaskContinuationOptions.NotOnRanToCompletion, TaskScheduler.Default);
        var bound = job.StartedWithin(limit);
        if (await Task.WhenAny(bound, done.Task) == bound && !await bound)
            throw new JobNotStartedException(what, module, limit, await abandoned(queuedAt));
        return await done.Task;
    }
}

// A queued job the Studio did not start within its bound: abandoned, never run, nothing executed. The message carries
// "did not become idle" (Journal.Gate: studio_busy) and a stable token the facade reads (MERGE_NOT_STARTED for a merge,
// STUDIO_NOT_IDLE for any other job).
internal sealed class JobNotStartedException : InvalidOperationException {
    public string Token { get; }
    public JobNotStartedException(string what, string module, TimeSpan limit, string? state)
        : base(TokenOf(what) + ": the Studio did not run the " + what + " of " + module + " within " + (int)limit.TotalSeconds
            + " s: its tab did not become idle (a queued job waits for an idle top level). It was abandoned and will never run; nothing was executed and the module is unchanged."
            + " Read studio_status; " + (what == "merge" ? "deliver again only when the Studio is idle." : "ask again only when the Studio is idle.") + (string.IsNullOrEmpty(state) ? "" : " Tab state: " + state)) { Token = TokenOf(what); }
    // Only a merge that never ran may be delivered again; a reconcile-merge comes after a merge that did.
    public static string TokenOf(string what) => what == "merge" ? "MERGE_NOT_STARTED" : "STUDIO_NOT_IDLE";
}

// The command that holds the Studio turn: it holds it until its work ends, whether its answer was written, lost or sent
// late. Context: whatever the caller wants to read back about it (the bridge's module and evidence).
internal sealed class BusyCommand {
    public BusyCommand(string command, DateTimeOffset since) { Command = command; Since = since; }
    public string Command { get; }
    public DateTimeOffset Since { get; }
    public volatile object? Context;
    public volatile bool Overran;
    // What a command past its deadline leaves as a way out. Nothing here may end it: running another one on top is worse.
    public const string PastDeadline = "It is past its deadline and was not cancelled, and the bridge cannot end it. It may end by itself if the Studio's UI answers again; if a dialog holds it, dismiss-dialog <caption>|<action> may free it (status lists the open dialogs). If it never ends, only restarting ODC Studio ends it, and that is the person's call, when it suits them. Its outcome then stays unknown, and what the open modules had not saved or published may be lost. Then read the outcome before any new write.";
    public string? Advice => Overran ? PastDeadline : null;
    // The refusal of a call the running command keeps from the Studio: "still running" is what the journal reads as studio_busy.
    public static string Refusal(BusyCommand? holder, string command) {
        if (holder == null) return "Another command was still running a moment ago; nothing of this call ran. Ask again.";
        var head = "Command '" + holder.Command + "' is still running since " + holder.Since.ToString("o");
        var mine = CommandRunner.TakesNoTurn(command) ? "; the Studio's UI did not answer this " + command + " beside it" : "; nothing of this call ran; status answers until it completes";
        return head + mine + ". Never run it again on top of it." + (holder.Overran ? " " + PastDeadline : "");
    }
}

// One command reaches the Studio at a time, as it always did; a turn no longer depends on the pipe.
internal sealed class CommandGate {
    private readonly SemaphoreSlim turn = new(1, 1);
    private BusyCommand? holder;
    public BusyCommand? Holder => Volatile.Read(ref holder);
    public async Task<BusyCommand?> TryEnter(string command, TimeSpan wait) {
        if (!await turn.WaitAsync(wait)) return null;
        var mine = new BusyCommand(command, DateTimeOffset.UtcNow);
        Volatile.Write(ref holder, mine);
        return mine;
    }
    public void Leave(BusyCommand mine) {
        if (Interlocked.CompareExchange(ref holder, null, mine) == mine) turn.Release();
    }
}

internal enum CommandEnd { Done, Busy, Overran }
internal sealed record CommandRun(CommandEnd End, Task<object>? Work, BusyCommand? Holder, TimeSpan Limit);

// Runs one command under its deadline. Past the deadline the caller answers by itself and the work keeps running: it was
// not cancelled. A command that takes the turn holds it until its work ends, so the next one is refused at once rather than
// run on top of it, and is served as soon as the work ends. The commands that read or free a held Studio never take the turn.
internal sealed class CommandRunner {
    private readonly CommandGate gate;
    private readonly TimeSpan turnWait, busyAnswer;
    public CommandRunner(CommandGate gate, TimeSpan turnWait, TimeSpan busyAnswer) { this.gate = gate; this.turnWait = turnWait; this.busyAnswer = busyAnswer; }
    public static bool TakesNoTurn(string command) => command is "status" or "dismiss-dialog" or "auth-status" or "publish-log";
    // The quick reads: beside a running command they wait for the Studio's UI for a moment only, since the UI may be what
    // the command holds; then the bridge answers for itself (BRIDGE_BUSY) and the facade reads the evidence.
    private static bool QuickRead(string command) => command is "status" or "auth-status";
    public async Task<CommandRun> Run(string command, TimeSpan deadline, Func<BusyCommand?, Task<object>> work) {
        BusyCommand? mine = null;
        if (!TakesNoTurn(command)) {
            mine = await gate.TryEnter(command, turnWait);
            if (mine == null) return new CommandRun(CommandEnd.Busy, null, gate.Holder, turnWait);
        }
        var running = Task.Run(() => work(mine));
        if (mine != null) _ = running.ContinueWith(_ => gate.Leave(mine), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        var limit = QuickRead(command) && gate.Holder != null && busyAnswer < deadline ? busyAnswer : deadline;
        if (await Task.WhenAny(running, Task.Delay(limit)) == running) return new CommandRun(CommandEnd.Done, running, null, limit);
        if (mine != null) mine.Overran = true;
        return new CommandRun(CommandEnd.Overran, running, mine ?? gate.Holder, limit);
    }
}

// What a connection answers: one line, whether the server stops after it, and what to do when the client has left.
internal sealed record PipeAnswer(string Line, bool Stop = false, Action<Exception>? Undelivered = null);

// One connection per call, each served on its own: the listener never waits for a command, an answer, or a client. A client
// that left is the client's business: the answer is handed to Undelivered, and the server goes on.
internal sealed class PipeServer {
    // More than any facade or agent keeps open at once; a connection holds its instance only while it reads or answers.
    public const int MaxInstances = 16;
    private readonly string name;
    private readonly Func<string, Task<PipeAnswer>> serve;
    private readonly Action<Exception> record;
    private readonly TimeSpan lineLimit, writeLimit;
    private readonly CancellationTokenSource stopping = new();
    public PipeServer(string name, Func<string, Task<PipeAnswer>> serve, Action<Exception> record, TimeSpan lineLimit, TimeSpan writeLimit) {
        this.name = name; this.serve = serve; this.record = record; this.lineLimit = lineLimit; this.writeLimit = writeLimit;
    }
    // Waits for one connection and hands it off. false: the stop command was answered.
    public async Task<bool> AcceptOne() {
        var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, MaxInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try { await pipe.WaitForConnectionAsync(stopping.Token); }
        catch (OperationCanceledException) { pipe.Dispose(); return false; }
        catch { pipe.Dispose(); throw; }
        _ = Task.Run(() => Connection(pipe));
        return true;
    }
    private void Recorded(Exception error) { try { record(error); } catch { /* recording never ends the server */ } }
    private async Task Connection(NamedPipeServerStream pipe) {
        try {
            using (pipe) {
                string? line;
                using (var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true)) {
                    // A client that connects and says nothing holds this connection only: never a command, never the server.
                    try { line = await reader.ReadLineAsync().WaitAsync(lineLimit); }
                    catch (TimeoutException) { return; }
                    catch (IOException) { return; }
                }
                line = line?.Trim();
                if (string.IsNullOrEmpty(line)) return;
                PipeAnswer answer;
                try { answer = await serve(line); }
                catch (Exception error) {
                    Recorded(error);
                    answer = new PipeAnswer("{\"ok\":false,\"outcome\":\"native_error\",\"error\":\"The bridge could not serve this command; read its journal.\"}");
                }
                try {
                    using var limit = new CancellationTokenSource(writeLimit);
                    await pipe.WriteAsync(new UTF8Encoding(false).GetBytes(answer.Line + "\n"), limit.Token);
                    await pipe.FlushAsync(limit.Token);
                } catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException or InvalidOperationException) {
                    Recorded(error);
                    try { answer.Undelivered?.Invoke(error); } catch (Exception inner) { Recorded(inner); }
                }
                if (answer.Stop) stopping.Cancel();
            }
        } catch (Exception error) { Recorded(error); }
    }
}
