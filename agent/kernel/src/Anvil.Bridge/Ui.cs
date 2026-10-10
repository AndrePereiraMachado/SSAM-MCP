using Avalonia.Threading;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// The only way the bridge reaches the Studio's UI thread (UiGate.cs has the rule): InvokeAsync with a hard deadline,
/// the job withdrawn (Abort) when it has not started, UI_BUSY otherwise. Never Dispatcher.UIThread.Invoke, never a
/// blocking wait on a UI job from the pipe thread.
/// </summary>
internal static class Ui
{
    public static Task<T> Run<T>(Func<T> job, TimeSpan limit, string what)
    {
        if (Dispatcher.UIThread.CheckAccess()) return Task.FromResult(job());
        var started = 0;
        var op = Dispatcher.UIThread.InvokeAsync(() => { Volatile.Write(ref started, 1); return job(); });
        return UiGate.Await(op.GetTask(), limit, op.Abort, () => Volatile.Read(ref started) == 1, what);
    }

    public static Task<T> Run<T>(Func<T> job, string what) => Run(job, UiGate.Read, what);

    public static Task Run(Action job, TimeSpan limit, string what) => Run(() => { job(); return true; }, limit, what);

    public static Task Run(Action job, string what) => Run(job, UiGate.Step, what);

    /// <summary>For the worker threads of a handler (merge, refresh) that read the UI synchronously: bounded too.</summary>
    public static T RunSync<T>(Func<T> job, TimeSpan limit, string what)
    {
        if (Dispatcher.UIThread.CheckAccess()) return job();
        return Run(job, limit, what).GetAwaiter().GetResult();
    }

    public static void RunSync(Action job, TimeSpan limit, string what) => RunSync(() => { job(); return true; }, limit, what);
}

/// <summary>
/// The idle state of one module tab (ModuleGate in UiGate.cs). The probe is posted to the tab's own ContextualDispatcher
/// root frame (ExecuteInContext, executeWhenTopLevelIsIdle: true, asynchronous: it never waits on the UI thread) and
/// runs only once everything queued before it ran. FrameCount comes from the tab's view by reflection (no reference to
/// the dispatcher assembly); null when this Studio does not expose it.
/// </summary>
internal static class AggregatorIdle
{
    public static async Task<bool> Wait(IAggregatorPresenter aggregator, TimeSpan limit)
    {
        Task probe;
        try { probe = aggregator.ExecuteInContext(() => { }, executeWhenTopLevelIsIdle: true); }
        catch (Exception ex) { Server.Log("idle probe: " + Server.Unwrap(ex)); return false; }
        return await Task.WhenAny(probe, Task.Delay(limit)).ConfigureAwait(false) == probe && probe.IsCompletedSuccessfully;
    }

    /// <summary>Frames of the tab's dispatcher (1 = root only). UI thread or any thread: a read of a counter.</summary>
    public static int? FrameCount(IAggregatorPresenter aggregator)
    {
        try { return Studio.Prop(Studio.Prop(Studio.Prop(aggregator, "View"), "ContextualDispatcher"), "FrameCount") as int?; }
        catch { return null; }
    }
}
