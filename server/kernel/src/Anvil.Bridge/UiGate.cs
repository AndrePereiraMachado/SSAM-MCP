using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Anvil.Bridge;

/// <summary>
/// UI freeze of 2026-10-08 (a customer module, twice): no bridge call may hold the Studio's UI thread, and no bridge call
/// may wait on it without a bound. This file is pure (no Avalonia, no Studio type) so the tests run it with fakes.
///
/// UI_BUSY: every job the bridge posts to the UI thread (Ui.Run) has a hard deadline. When it expires the job is withdrawn
/// from the UI queue if it has not started (DispatcherOperation.Abort: it will never run later, behind the person's work),
/// and the call answers UI_BUSY at once with {what, waitedMs, started, withdrawn}. withdrawn:true means nothing of it ran
/// (executed:false). A job that already started keeps running on the UI thread (it cannot be stopped from outside), and
/// the answer says so: outcome unknown, read the state before any new write. The pipe thread never waits on the UI thread
/// with .Wait(), .Result or GetAwaiter().GetResult() without this bound.
///
/// The request scope (BeginRequest) lets Server answer the code even when a handler caught the exception and answered a
/// plain failure text: the scope object flows down the async calls of one request and UiGate marks it.
/// </summary>
internal sealed class UiBusyException : Exception
{
    public const string Code = "UI_BUSY";
    public string What { get; }
    public long WaitedMs { get; }
    public bool Started { get; }
    public bool Withdrawn { get; }

    public UiBusyException(string what, long waitedMs, bool started, bool withdrawn)
        : base($"{what}: the Studio UI thread did not run this step in {waitedMs / 1000.0:0.#} s ("
            + (withdrawn ? "withdrawn from the UI queue; nothing of it ran" : "it started and is still running on the UI thread; outcome unknown") + ")")
    {
        What = what; WaitedMs = waitedMs; Started = started; Withdrawn = withdrawn;
    }
}

internal static class UiGate
{
    /// <summary>What a bridge with these rules offers (bridge_manifest): every UI step bounded (UI_BUSY), close_module only
    /// on an idle tab (MODULE_BUSY), publish answers settled, open_module waits for a headless publication.</summary>
    public static readonly string[] Capabilities = ["ui:bounded", "close_module:idle_gate", "publish:settled", "open_module:headless_guard"];

    /// <summary>A read of the model or of the windows (list_open_modules, get_active_module, a guard check).</summary>
    public static readonly TimeSpan Read = TimeSpan.FromSeconds(30);
    /// <summary>A short native step on the UI thread (select a tab, start an open, close a tab, read a publish state).</summary>
    public static readonly TimeSpan Step = TimeSpan.FromSeconds(30);
    /// <summary>A model step of one module on the UI thread (snapshot, validation of a big module): under the client's 300 s.</summary>
    public static readonly TimeSpan Model = TimeSpan.FromSeconds(240);
    /// <summary>The merge apply on the UI thread: under the client's 900 s of merge_from_oml.</summary>
    public static readonly TimeSpan Heavy = TimeSpan.FromMinutes(14);

    /// <summary>One bridge request: the last UI_BUSY seen in it, and whether it already dispatched a change (then no
    /// UI_BUSY of a later step may answer "not executed").</summary>
    internal sealed class RequestScope { public UiBusyException? Busy; public bool Dispatched; }
    private static readonly AsyncLocal<RequestScope?> current = new();

    /// <summary>Opens the scope of one bridge request (Server.Serve).</summary>
    public static RequestScope BeginRequest()
    {
        var scope = new RequestScope();
        current.Value = scope;
        return scope;
    }

    /// <summary>A handler marks the moment its change reached the Studio (an open started, a publish dispatched, a merge
    /// applied): from then on a UI_BUSY answers outcome unknown, never executed:false.</summary>
    public static void MarkDispatched() { if (current.Value is { } scope) scope.Dispatched = true; }

    /// <summary>Waits for a UI job with a hard deadline (see the class summary). withdraw() aborts the job and returns true
    /// only when it had not started; started() says whether it began. Never waits past limit.</summary>
    public static async Task<T> Await<T>(Task<T> job, TimeSpan limit, Func<bool> withdraw, Func<bool> started, string what)
    {
        var sw = Stopwatch.StartNew();
        using var timer = new CancellationTokenSource();
        var expiry = Task.Delay(limit, timer.Token);
        if (await Task.WhenAny(job, expiry).ConfigureAwait(false) == job)
        {
            timer.Cancel();
            return await job.ConfigureAwait(false);
        }
        var withdrawn = !started() && Safe(withdraw);
        // An abandoned job may still fault later: observe it so it never surfaces as an unobserved exception.
        _ = job.ContinueWith(t => _ = t.Exception, CancellationToken.None, TaskContinuationOptions.NotOnRanToCompletion, TaskScheduler.Default);
        var busy = new UiBusyException(what, sw.ElapsedMilliseconds, !withdrawn, withdrawn);
        if (current.Value is { } scope) scope.Busy = busy;
        throw busy;
    }

    /// <summary>A handler that dealt with a UI_BUSY itself (a read retried while a dispatched command runs) clears the mark,
    /// so Server never turns its answer into "not executed".</summary>
    public static void Forget() { if (current.Value is { } scope) scope.Busy = null; }

    private static bool Safe(Func<bool> f) { try { return f(); } catch { return false; } }

    /// <summary>The bridge answer of a UI_BUSY: code, executed:false only when the step was withdrawn and nothing of the
    /// request was dispatched before it, and the continuation (a state read).</summary>
    public static string Reply(UiBusyException busy, bool dispatched = false)
    {
        var notExecuted = busy.Withdrawn && !dispatched;
        var reply = new JsonObject
        {
            ["success"] = false,
            ["code"] = UiBusyException.Code,
            ["error"] = busy.Message,
            ["data"] = new JsonObject
            {
                ["code"] = UiBusyException.Code, ["what"] = busy.What, ["waitedMs"] = busy.WaitedMs,
                ["started"] = busy.Started, ["withdrawn"] = busy.Withdrawn, ["dispatched"] = dispatched,
                ["outcome"] = notExecuted ? "not-executed" : "unknown",
                ["next"] = "ui_alive and list_open_modules (o11_studio status): the Studio UI thread is busy or blocked; nothing new is sent until it answers",
            },
        };
        if (notExecuted) reply["executed"] = false;
        return reply.ToJsonString();
    }
}

/// <summary>
/// Pattern 1 of 2026-10-08: close_module right after a 1-Click Publish froze the Studio. AggregatorPresenter.Close() (UI
/// thread) runs ExecuteInContext(action, executeSynchronously: true, executeWhenTopLevelIsIdle: true): it posts to the
/// root frame of the tab's own ContextualDispatcher and blocks the UI thread on Task.Wait() until that frame runs it.
/// After a publish the tab's dispatcher is still finishing the publication (its queue, or a nested frame), and that work
/// needs the UI thread: a deadlock with CPU at 0 and a window Windows still calls "Responding" (the COM wait pumps
/// messages; Avalonia jobs never run). So a tab is closed only when all of these hold, read just before the close:
/// no server operation (publish, upload) of the module runs, no headless publication of it is in flight, its dispatcher
/// has no nested frame, and an idle probe posted to its root frame ran within the bound. Otherwise close_module answers
/// MODULE_BUSY with the reason, nothing closed. Pure.
/// </summary>
internal static class ModuleGate
{
    public const string BusyCode = "MODULE_BUSY";

    /// <summary>Why the tab may not be closed now, or null when it may.</summary>
    public static string? CloseRefusal(bool serverOperationRunning, bool headlessPublishing, int? frameCount, bool idle)
    {
        if (serverOperationRunning) return "server-operation";
        if (headlessPublishing) return "headless-publish";
        if (frameCount is > 1) return "nested-frame";
        if (!idle) return "not-idle";
        return null;
    }

    /// <summary>What close_module saw: the tab (null = no such tab), a guard refusal, its key and whether a server operation runs.</summary>
    public sealed record Look(object? Tab, string? Refusal, string? Key, bool Running);
    /// <summary>closed | already-closed | refused (Text) | busy (Reason).</summary>
    public sealed record Outcome(string Kind, string? Text = null, string? Reason = null, long WaitedMs = 0);

    /// <summary>The order of close_module, pure (OpenHandler.Close gives it the Studio): read the tab (bounded UI read),
    /// refuse a guard, then the idle gate, and only then the close (bounded UI step, which re-checks). A UI step that does
    /// not run in time throws UiBusyException from look or close; the close is never invoked on a busy tab.</summary>
    public static async Task<Outcome> CloseAsync(Func<Task<Look>> look, Func<string?, bool> headless, Func<object, TimeSpan, Task<bool>> idle,
        Func<object, int?> frames, Func<object, string?, Task<bool?>> close, TimeSpan idleLimit)
    {
        var seen = await look();
        if (seen.Tab == null) return new Outcome("already-closed");
        if (seen.Refusal != null) return new Outcome("refused", seen.Refusal);
        var sw = Stopwatch.StartNew();
        var publishing = headless(seen.Key);
        var isIdle = !seen.Running && !publishing && await idle(seen.Tab, idleLimit);
        var busy = CloseRefusal(seen.Running, publishing, frames(seen.Tab), isIdle);
        if (busy != null) return new Outcome("busy", Reason: busy, WaitedMs: sw.ElapsedMilliseconds);
        var closed = await close(seen.Tab, seen.Key);
        return closed switch
        {
            null => new Outcome("already-closed"),
            false => new Outcome("busy", Reason: "not-idle", WaitedMs: sw.ElapsedMilliseconds),
            true => new Outcome("closed", WaitedMs: sw.ElapsedMilliseconds),
        };
    }

    public static string Explain(string reason) => reason switch
    {
        "server-operation" => "a publish or upload of this module is still running in the Studio",
        "headless-publish" => "a publication of this module through the environment session (o11_environment) is still in flight",
        "nested-frame" => "the tab is inside a nested operation (a modal step of the Studio)",
        "not-idle" => "the tab is still finishing work (the end of a publication, a refresh or a validation)",
        _ => reason,
    };
}

/// <summary>
/// Pattern 2 of 2026-10-08: open_module of a customer module while a headless publication of the same module ran
/// through the environment session (o11_environment refresh-refs publish). The bridge itself keeps the headless
/// publications in flight, by module key and environment, from publish-start to the publish-check that ends them (or
/// until no check came for Expiry). open_module, close_module and publish of the Studio wait for them (bounded) or answer
/// MODULE_BUSY, whatever SSAM process or root sent them. Pure.
/// </summary>
internal static class HeadlessPublications
{
    public static readonly TimeSpan Expiry = TimeSpan.FromMinutes(10);
    private sealed record Entry(string Host, DateTime Since, DateTime LastSeen);
    private static readonly ConcurrentDictionary<string, Entry> inFlight = new(StringComparer.OrdinalIgnoreCase);

    public static void Started(string? key, string? host, DateTime now)
    {
        if (string.IsNullOrWhiteSpace(key)) return;
        inFlight[key] = new Entry(host ?? "", now, now);
    }

    public static void Checked(string? key, bool ended, DateTime now)
    {
        if (string.IsNullOrWhiteSpace(key)) return;
        if (ended) { inFlight.TryRemove(key, out _); return; }
        inFlight.AddOrUpdate(key, _ => new Entry("", now, now), (_, e) => e with { LastSeen = now });
    }

    /// <summary>The in-flight publication of a module key, or null (an entry with no check for Expiry is dropped).</summary>
    public static (string Key, DateTime Since)? Of(string? key, DateTime now)
    {
        if (string.IsNullOrWhiteSpace(key) || !inFlight.TryGetValue(key, out var e)) return null;
        if (now - e.LastSeen > Expiry) { inFlight.TryRemove(key, out _); return null; }
        return (key, e.Since);
    }

    /// <summary>Any in-flight publication on an environment (host null = any): an open by name cannot know the key yet.</summary>
    public static (string Key, DateTime Since)? Any(string? host, DateTime now)
    {
        foreach (var (key, e) in inFlight.ToArray())
        {
            if (now - e.LastSeen > Expiry) { inFlight.TryRemove(key, out _); continue; }
            if (host == null || e.Host.Length == 0 || string.Equals(e.Host, host, StringComparison.OrdinalIgnoreCase)) return (key, e.Since);
        }
        return null;
    }

    internal static void Clear() => inFlight.Clear();
}
