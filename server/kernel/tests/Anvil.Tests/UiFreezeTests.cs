using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Bridge;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// UI freeze of 2026-10-08 (DCIPS_Documents_CS, 15:10Z and 22:40Z): publish, then close_module, then the Studio's UI thread
/// blocked for good. Fakes only: a single-thread "UI" queue and a single-thread "tab dispatcher" queue model the Studio's
/// Avalonia thread and the tab's ContextualDispatcher; nothing here touches a Studio.
/// </summary>
public sealed class UiFreezeTests
{
    /// <summary>A thread that runs posted jobs in order, like the UI thread or a tab's dispatcher. Background: a test that
    /// proves a deadlock leaves it blocked without holding the test process.</summary>
    private sealed class FakeThread
    {
        private readonly BlockingCollection<(Action Run, Func<bool> TryClaim)> queue = new();
        public FakeThread(string name)
        {
            var thread = new Thread(() => { foreach (var job in queue.GetConsumingEnumerable()) if (job.TryClaim()) job.Run(); }) { IsBackground = true, Name = name };
            thread.Start();
        }

        /// <summary>The job, how to withdraw it (true only before it started) and whether it started.</summary>
        public (Task<T> Job, Func<bool> Withdraw, Func<bool> Started) Post<T>(Func<T> f)
        {
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            var state = 0; // 0 pending, 1 started, 2 withdrawn
            queue.Add((() => { try { tcs.SetResult(f()); } catch (Exception e) { tcs.SetException(e); } },
                () => Interlocked.CompareExchange(ref state, 1, 0) == 0));
            return (tcs.Task, () => Interlocked.CompareExchange(ref state, 2, 0) == 0 && tcs.TrySetCanceled(), () => Volatile.Read(ref state) == 1);
        }

        public Task Post(Action a) => Post(() => { a(); return true; }).Job;
    }

    private static Task<T> OnUi<T>(FakeThread ui, Func<T> f, TimeSpan limit, string what)
    {
        var (job, withdraw, started) = ui.Post(f);
        return UiGate.Await(job, limit, withdraw, started, what);
    }

    // The tab's Close as the Studio implements it: on the UI thread, a post to the tab's root frame and a blocking Wait.
    private static bool StudioClose(FakeThread tab) { tab.Post(() => { }).Wait(); return true; }

    // The end of a publication on the tab's dispatcher: some server work, then a step that needs the UI thread.
    private static void PublicationTail(FakeThread tab, FakeThread ui, int serverMs) =>
        tab.Post(() => { Thread.Sleep(serverMs); ui.Post(() => { }).Wait(); });

    private static async Task<bool> UiAnswers(FakeThread ui, int ms)
    {
        var probe = ui.Post(() => true).Job;
        return await Task.WhenAny(probe, Task.Delay(ms)) == probe;
    }

    [Fact]
    public async Task TheFakeReproducesTheFreeze_ACloseRightAfterPublishDeadlocksTheUiThread()
    {
        // What the bridge did before: close_module dispatched Close on the UI thread right after publish answered success.
        var ui = new FakeThread("ui"); var tab = new FakeThread("tab");
        PublicationTail(tab, ui, serverMs: 200);
        await Task.Delay(50);                       // the tail is running its server part
        _ = ui.Post(() => StudioClose(tab)).Job;    // the old close_module
        Assert.False(await UiAnswers(ui, 1500), "the model must freeze like the Studio did: UI waits on the tab, the tab waits on the UI");
    }

    [Fact]
    public async Task CloseWaitsForTheTabToBeIdleAndThenClosesWithoutFreezing()
    {
        var ui = new FakeThread("ui"); var tab = new FakeThread("tab");
        PublicationTail(tab, ui, serverMs: 200);
        await Task.Delay(50);
        var closes = 0;
        var outcome = await ModuleGate.CloseAsync(
            () => OnUi(ui, () => new ModuleGate.Look(tab, null, "K", false), TimeSpan.FromSeconds(2), "read"),
            _ => false,
            async (t, limit) => { var probe = ((FakeThread)t).Post(() => { }); return await Task.WhenAny(probe, Task.Delay(limit)) == probe; },
            _ => 1,
            (t, _) => OnUi<bool?>(ui, () => { closes++; return StudioClose((FakeThread)t); }, TimeSpan.FromSeconds(2), "close"),
            TimeSpan.FromSeconds(5));
        Assert.Equal("closed", outcome.Kind);
        Assert.Equal(1, closes);
        Assert.True(await UiAnswers(ui, 1000), "the UI thread answers after the close");
    }

    [Fact]
    public async Task APublicationStillFinishingRefusesTheCloseWithModuleBusyAndNeverCallsClose()
    {
        var ui = new FakeThread("ui"); var tab = new FakeThread("tab");
        PublicationTail(tab, ui, serverMs: 3000);   // longer than the idle limit below
        await Task.Delay(50);
        var closes = 0;
        var outcome = await ModuleGate.CloseAsync(
            () => OnUi(ui, () => new ModuleGate.Look(tab, null, "K", false), TimeSpan.FromSeconds(2), "read"),
            _ => false,
            async (t, limit) => { var probe = ((FakeThread)t).Post(() => { }); return await Task.WhenAny(probe, Task.Delay(limit)) == probe; },
            _ => 1,
            (t, _) => { closes++; return Task.FromResult<bool?>(StudioClose((FakeThread)t)); },
            TimeSpan.FromMilliseconds(500));
        Assert.Equal("busy", outcome.Kind);
        Assert.Equal("not-idle", outcome.Reason);
        Assert.Equal(0, closes);
        Assert.True(await UiAnswers(ui, 1000), "the UI thread is never held by close_module");
    }

    [Fact]
    public async Task ARunningServerOperationOrAHeadlessPublicationRefusesWithoutWaiting()
    {
        var idleCalls = 0; var closes = 0;
        Task<bool> Idle(object _, TimeSpan __) { idleCalls++; return Task.FromResult(true); }
        Task<bool?> Close(object _, string? __) { closes++; return Task.FromResult<bool?>(true); }
        var tab = new object();
        var running = await ModuleGate.CloseAsync(() => Task.FromResult(new ModuleGate.Look(tab, null, "K", true)), _ => false, Idle, _ => 1, Close, TimeSpan.FromSeconds(1));
        Assert.Equal(("busy", "server-operation"), (running.Kind, running.Reason));
        var headless = await ModuleGate.CloseAsync(() => Task.FromResult(new ModuleGate.Look(tab, null, "K", false)), k => k == "K", Idle, _ => 1, Close, TimeSpan.FromSeconds(1));
        Assert.Equal(("busy", "headless-publish"), (headless.Kind, headless.Reason));
        var nested = await ModuleGate.CloseAsync(() => Task.FromResult(new ModuleGate.Look(tab, null, "K", false)), _ => false, Idle, _ => 2, Close, TimeSpan.FromSeconds(1));
        Assert.Equal(("busy", "nested-frame"), (nested.Kind, nested.Reason));
        Assert.Equal(0, closes);
        Assert.Equal(1, idleCalls); // only the nested case reached the probe
        var guard = await ModuleGate.CloseAsync(() => Task.FromResult(new ModuleGate.Look(tab, "unsaved changes", null, false)), _ => false, Idle, _ => 1, Close, TimeSpan.FromSeconds(1));
        Assert.Equal(("refused", "unsaved changes"), (guard.Kind, guard.Text));
        var none = await ModuleGate.CloseAsync(() => Task.FromResult(new ModuleGate.Look(null, null, null, false)), _ => false, Idle, _ => 1, Close, TimeSpan.FromSeconds(1));
        Assert.Equal("already-closed", none.Kind);
        Assert.Equal(0, closes);
    }

    [Fact]
    public async Task AUiThreadThatNeverAnswersIsWithdrawnAndAnswersUiBusyNotExecuted()
    {
        // A dispatcher that never runs the job (the UI thread blocked by something else).
        var never = new TaskCompletionSource<string>();
        var withdrawn = false;
        var sw = Stopwatch.StartNew();
        var busy = await Assert.ThrowsAsync<UiBusyException>(() =>
            UiGate.Await(never.Task, TimeSpan.FromMilliseconds(300), () => withdrawn = true, () => false, "list_open_modules"));
        Assert.InRange(sw.ElapsedMilliseconds, 250, 5000);
        Assert.True(withdrawn, "the job is taken out of the UI queue: it never runs later");
        Assert.True(busy.Withdrawn); Assert.False(busy.Started);
        var reply = JsonNode.Parse(UiGate.Reply(busy))!.AsObject();
        Assert.Equal("UI_BUSY", reply["code"]!.GetValue<string>());
        Assert.False(reply["success"]!.GetValue<bool>());
        Assert.False(reply["executed"]!.GetValue<bool>());
        Assert.Equal("not-executed", reply["data"]!["outcome"]!.GetValue<string>());
    }

    [Fact]
    public async Task AStepThatStartedAndHangsAnswersOutcomeUnknownNeverNotExecuted()
    {
        var never = new TaskCompletionSource<bool>();
        var busy = await Assert.ThrowsAsync<UiBusyException>(() =>
            UiGate.Await(never.Task, TimeSpan.FromMilliseconds(200), () => throw new InvalidOperationException("a started job is never withdrawn"), () => true, "close_module: close the tab"));
        Assert.True(busy.Started); Assert.False(busy.Withdrawn);
        var reply = JsonNode.Parse(UiGate.Reply(busy))!.AsObject();
        Assert.Null(reply["executed"]);
        Assert.Equal("unknown", reply["data"]!["outcome"]!.GetValue<string>());
        // A withdrawn read after the request dispatched its change (an open started) is not "not executed" either.
        var late = new UiBusyException("open_module: read the open", 200, started: false, withdrawn: true);
        var afterDispatch = JsonNode.Parse(UiGate.Reply(late, dispatched: true))!.AsObject();
        Assert.Null(afterDispatch["executed"]);
        Assert.Equal("unknown", afterDispatch["data"]!["outcome"]!.GetValue<string>());
    }

    [Fact]
    public async Task TheRequestScopeKeepsTheCodeWhenAHandlerTurnsUiBusyIntoText()
    {
        var scope = UiGate.BeginRequest();
        try { await UiGate.Await(new TaskCompletionSource<int>().Task, TimeSpan.FromMilliseconds(50), () => true, () => false, "get_errors"); }
        catch (UiBusyException) { /* a handler answers Server.Fail(text) */ }
        Assert.NotNull(scope.Busy);
        Assert.Equal("get_errors", scope.Busy!.What);
        UiGate.MarkDispatched();
        Assert.True(scope.Dispatched);
        UiGate.Forget();
        Assert.Null(scope.Busy);
    }

    [Fact]
    public async Task AFastJobAnswersItsValueAndNothingIsWithdrawn()
    {
        var ui = new FakeThread("ui");
        Assert.Equal(42, await OnUi(ui, () => 42, TimeSpan.FromSeconds(2), "ping"));
        var failing = OnUi<int>(ui, () => throw new InvalidOperationException("model"), TimeSpan.FromSeconds(2), "read");
        Assert.Equal("model", (await Assert.ThrowsAsync<InvalidOperationException>(() => failing)).Message);
    }

    [Fact]
    public void HeadlessPublicationsAreKeptFromStartToTheCheckThatEndsThem()
    {
        HeadlessPublications.Clear();
        var t0 = new DateTime(2026, 10, 8, 13, 59, 49, DateTimeKind.Utc);
        HeadlessPublications.Started("SurvivorKey", "personal.example", t0);
        Assert.Equal(t0, HeadlessPublications.Of("survivorkey", t0.AddSeconds(30))?.Since);   // keys compare without case
        Assert.NotNull(HeadlessPublications.Any("personal.example", t0.AddSeconds(30)));
        Assert.NotNull(HeadlessPublications.Any(null, t0.AddSeconds(30)));
        Assert.Null(HeadlessPublications.Any("other.example", t0.AddSeconds(30)));
        HeadlessPublications.Checked("SurvivorKey", ended: false, t0.AddMinutes(9));
        Assert.NotNull(HeadlessPublications.Of("SurvivorKey", t0.AddMinutes(18)));   // a check 9 min in keeps it alive
        HeadlessPublications.Checked("SurvivorKey", ended: true, t0.AddMinutes(19));
        Assert.Null(HeadlessPublications.Of("SurvivorKey", t0.AddMinutes(19)));
        // A publication nobody checks for longer than Expiry stops blocking.
        HeadlessPublications.Started("Lost", "personal.example", t0);
        Assert.Null(HeadlessPublications.Of("Lost", t0 + HeadlessPublications.Expiry + TimeSpan.FromSeconds(1)));
        HeadlessPublications.Started(null, "x", t0);
        Assert.Null(HeadlessPublications.Any(null, t0));
    }

    [Fact]
    public void ModuleGateReasonsAreStableAndExplained()
    {
        Assert.Null(ModuleGate.CloseRefusal(false, false, 1, true));
        Assert.Null(ModuleGate.CloseRefusal(false, false, null, true));   // a Studio that does not expose FrameCount
        Assert.Equal("server-operation", ModuleGate.CloseRefusal(true, true, 3, false));
        Assert.Equal("not-idle", ModuleGate.CloseRefusal(false, false, 1, false));
        foreach (var reason in new[] { "server-operation", "headless-publish", "nested-frame", "not-idle" })
            Assert.NotEqual(reason, ModuleGate.Explain(reason));
        Assert.Contains("ui:bounded", UiGate.Capabilities);
        Assert.Contains("close_module:idle_gate", UiGate.Capabilities);
    }
}
