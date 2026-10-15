using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Review of fam-deps (2026-10-13), family D as rules over every SSAM operation, with a fake Studio (nothing live): a web
/// dialog read before its page loaded is read again, never asked (finding 4); after a blocked answer the watch stays with the
/// operation, closes the certain dialogs and reports the dialog that waits now (finding 5), which merge_status answers from
/// the operation's journal; a modal presenter of the tab is seen and asked at once (finding 6); the merge slot of a job the
/// tab never ran is freed at once and that job never runs (finding 7); a certain dialog the operation opened as it ended is
/// still closed (finding 1); and a sweep that closes only the Studio's error reports leaves every other dialog to its own
/// rules (finding 8: publish and the pre-checks).
/// </summary>
public sealed class FamDepsReviewDialogTests
{
    /// <summary>A fake Studio: windows appear at given polls; reads can change over time; Close removes them.</summary>
    private sealed class FakeSurface : IStudioDialogSurface
    {
        public readonly Dictionary<string, Queue<DialogRead>> Reads = new(StringComparer.Ordinal);
        public readonly Dictionary<string, DialogRead> Open = new(StringComparer.Ordinal);
        public readonly List<string> Closed = [];
        public Action<FakeSurface>? OnList;
        public int ReadCount;
        public Task<IReadOnlyList<string>> List() { OnList?.Invoke(this); return Task.FromResult<IReadOnlyList<string>>(Open.Keys.ToArray()); }
        public Task<DialogRead?> Read(string id)
        {
            ReadCount++;
            if (!Open.TryGetValue(id, out var read)) return Task.FromResult<DialogRead?>(null);
            if (Reads.TryGetValue(id, out var next) && next.Count > 0) Open[id] = read = next.Dequeue();
            return Task.FromResult<DialogRead?>(read);
        }
        public Task<bool> Close(string id, DialogDecision decision)
        {
            if (id.StartsWith("presenter|", StringComparison.Ordinal)) return Task.FromResult(false);
            Closed.Add(id); Open.Remove(id); return Task.FromResult(true);
        }
    }

    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(20);
    private static DialogRead Web(string id, string? text, string title = "") => new(id, "DialogWindow", title, ["[Button] Viewbox"], text, true);
    private static DialogRead Crash(string id) => new(id, "DialogWindow", "Unexpected Error", ["[Button] Viewbox", "Unexpected Error"], "An unexpected error occurred. Report | Close", true);

    [Fact]
    public async Task AWebDialogReadBeforeItsPageLoadedIsReadAgainAndClosedByRuleNeverAsked()
    {
        var surface = new FakeSurface();
        // The dependencies dialog: first read with no page text (null, then ""), then the page.
        surface.Open["deps"] = Web("deps", null);
        surface.Reads["deps"] = new Queue<DialogRead>([Web("deps", null), Web("deps", ""), Web("deps", "Incompatible or missing dependencies found. Manage Dependencies Cancel")]);
        var merge = new TaskCompletionSource<string>();
        var recorded = new List<JsonObject>();
        var watch = OperationDialogLoop.Watch(merge.Task, surface, TimeSpan.FromSeconds(20), Poll, recorded.Add, new HashSet<string>(), webSettle: TimeSpan.FromSeconds(10));
        while (surface.Closed.Count == 0 && !watch.IsCompleted) await Task.Delay(10);
        merge.SetResult("merged");
        var outcome = await watch;
        Assert.Equal("done", outcome.State);
        Assert.Equal(["deps"], surface.Closed);
        Assert.Equal(OperationDialogPolicy.Dependencies, Assert.Single(recorded)["kind"]!.ToString());
    }

    [Fact]
    public async Task AWebDialogWhosePageNeverAnswersBecomesTheQuestionOnlyAfterItsSettleTime()
    {
        var surface = new FakeSurface();
        surface.Open["web"] = Web("web", null, "Something");
        var outcome = await OperationDialogLoop.Watch(new TaskCompletionSource<string>().Task, surface, TimeSpan.FromSeconds(20), Poll,
            before: new HashSet<string>(), webSettle: TimeSpan.FromMilliseconds(200));
        Assert.Equal("blocked", outcome.State);
        Assert.Equal(OperationDialogPolicy.Unreadable, outcome.Blocked!["kind"]!.ToString());
        Assert.True(outcome.ElapsedMs >= 200, "decided before its settle time: " + outcome.ElapsedMs);
        Assert.True(surface.ReadCount > 1, "read again while the page loads");
    }

    [Fact]
    public async Task AfterABlockedAnswerTheWatchStaysClosesTheCertainDialogsAndReportsTheQuestionOfNow()
    {
        var surface = new FakeSurface();
        var recovery = new DialogRead("recovery", "DialogWindow", "Recover", ["[Button] Viewbox"], "Recover unsaved changes? Open Discard", true);
        surface.Open["recovery"] = recovery;
        var merge = new TaskCompletionSource<string>();
        var pendings = new List<JsonObject?>();
        var closed = new List<JsonObject>();
        var watch = OperationDialogLoop.Watch(merge.Task, surface, TimeSpan.FromSeconds(20), Poll, closed.Add, new HashSet<string>(), pending: p => pendings.Add(p));
        while (pendings.Count == 0) await Task.Delay(10);
        Assert.Equal("Recover", pendings[0]!["title"]!.ToString());
        // The person answers the recovery; then the merge opens the Studio's crash report, which nobody else would close.
        surface.Open.Remove("recovery");
        while (pendings.Count < 2) await Task.Delay(10);
        Assert.Null(pendings[1]);
        surface.Open["crash"] = Crash("crash");
        while (surface.Closed.Count == 0) await Task.Delay(10);
        merge.SetResult("rolled back");
        var outcome = await watch;
        Assert.Equal("done", outcome.State);
        Assert.Equal(["crash"], surface.Closed);
        Assert.Equal(OperationDialogPolicy.UnexpectedError, Assert.Single(closed)["kind"]!.ToString());
        Assert.Equal(2, pendings.Count);
    }

    [Fact]
    public void MergeStatusAnswersTheDialogsTheWatchRecordedAndTheOneThatWaitsNow()
    {
        var directory = Path.Combine(Path.GetTempPath(), "fam-deps-journal-" + Guid.NewGuid().ToString("N"));
        var journal = new MergeJournal(directory);
        var id = Guid.NewGuid().ToString("N");
        var crash = new JsonObject { ["kind"] = OperationDialogPolicy.UnexpectedError, ["title"] = "Unexpected Error", ["closed"] = true };
        var waiting = new JsonObject { ["kind"] = OperationDialogPolicy.Question, ["title"] = "Save changes", ["question"] = "pergunta de agora" };
        using (var operation = journal.Begin(id, new JsonObject { ["module_key"] = "m" }))
        {
            journal.RecordDialogs(id, new JsonArray(crash.DeepClone()), waiting);
            var running = journal.Status(id, "m");
            Assert.True(running["dialogWatch"]!.GetValue<bool>());
            Assert.Equal("pergunta de agora", running["pendingDialog"]!["question"]!.ToString());
            operation.Record(new JsonObject { ["operationId"] = id, ["merged"] = true });
        }
        var settled = journal.Status(id, "m");
        Assert.Equal("applied", settled["state"]!.ToString());
        // A settled merge waits for nobody, and its receipt carries every dialog the watch closed (finding 1 on resume).
        Assert.Null(settled["pendingDialog"]);
        Assert.Equal(OperationDialogPolicy.UnexpectedError, settled["receipt"]!["dialogs"]![0]!["kind"]!.ToString());
    }

    [Fact]
    public async Task AModalPresenterTheOperationOpensIsAskedAtOnceAndNeverClosedBySsam()
    {
        var surface = new FakeSurface();
        surface.OnList = s => s.Open["presenter|1|ManageDependencies"] = new DialogRead("presenter|1|ManageDependencies", DialogPolicy.ManageDependencies, "Manage Dependencies", [], null, false, Presenter: true);
        var outcome = await OperationDialogLoop.Watch(new TaskCompletionSource<string>().Task, surface, TimeSpan.FromSeconds(20), Poll, before: new HashSet<string>());
        Assert.Equal("blocked", outcome.State);
        Assert.Equal(DialogPolicy.ManageDependencies, outcome.Blocked!["kind"]!.ToString());
        Assert.Contains("Manage Dependencies", outcome.Blocked["question"]!.ToString());
        Assert.Empty(surface.Closed);
        Assert.True(outcome.ElapsedMs < 5000, "asked in seconds, not at the end of the bound: " + outcome.ElapsedMs);
    }

    [Fact]
    public async Task ACertainDialogTheOperationOpenedAsItEndedIsStillClosed()
    {
        var surface = new FakeSurface();
        var merge = new TaskCompletionSource<string>();
        var watch = OperationDialogLoop.Watch(merge.Task, surface, TimeSpan.FromSeconds(20), TimeSpan.FromSeconds(5), before: new HashSet<string>());
        // The merge returns while its crash report is still on screen (the watch had not polled yet).
        surface.Open["crash"] = Crash("crash");
        merge.SetResult("merged");
        var outcome = await watch;
        Assert.Equal("done", outcome.State);
        Assert.Equal(["crash"], surface.Closed);
        Assert.Equal(OperationDialogPolicy.UnexpectedError, Assert.Single(outcome.Answered)!["kind"]!.ToString());
    }

    [Fact]
    public async Task ASweepOfErrorReportsClosesOnlyTheStudiosErrorReport()
    {
        var surface = new FakeSurface();
        surface.Open["crash"] = Crash("crash");
        surface.Open["deps"] = Web("deps", "Incompatible or missing dependencies found. Manage Dependencies Cancel");
        surface.Open["recovery"] = new DialogRead("recovery", "DialogWindow", "Recover", ["[Button] Viewbox"], "Recover unsaved changes? Open Discard", true);
        var sweep = new DialogSweep(surface, accept: DialogSweep.ErrorReportsOnly);
        Assert.Null(await sweep.Pass(closeOnly: true));
        Assert.Equal(["crash"], surface.Closed);
        Assert.Equal(OperationDialogPolicy.UnexpectedError, Assert.Single(sweep.Answered)!["kind"]!.ToString());
        // Read once: a later pass does not read the decided dialogs again.
        var reads = surface.ReadCount;
        await sweep.Pass(closeOnly: true);
        Assert.Equal(reads + 1, surface.ReadCount);   // only the recovery (not certain) is read again
    }

    [Fact]
    public void AStudioErrorIsTheCrashReportOrAnErrorBoxNeverAnyOtherDialog()
    {
        Assert.True(OperationDialogPolicy.IsStudioError(new JsonObject { ["kind"] = OperationDialogPolicy.UnexpectedError }));
        Assert.True(OperationDialogPolicy.IsStudioError(new JsonObject { ["kind"] = DialogPolicy.MessageBox, ["title"] = "Error", ["text"] = "The operation failed." }));
        Assert.False(OperationDialogPolicy.IsStudioError(new JsonObject { ["kind"] = DialogPolicy.MessageBox, ["title"] = "Information", ["text"] = "The module was saved." }));
        Assert.False(OperationDialogPolicy.IsStudioError(new JsonObject { ["kind"] = OperationDialogPolicy.Dependencies, ["text"] = "Incompatible or missing dependencies" }));
    }

    // ---- finding 7: the merge slot ----------------------------------------------------------------------------------------

    [Fact]
    public void AJobTheTabNeverRanFreesTheSlotAtOnceAndNeverRunsAfterwards()
    {
        var slot = new SemaphoreSlim(1);
        Assert.True(slot.Wait(0));
        var lease = new OperationLease(() => slot.Release());
        // ExecuteInContext never ran the job: the caller's bound passed and it abandons it.
        Assert.True(lease.Abandon());
        Assert.True(slot.Wait(0), "the next merge may run at once");
        slot.Release();
        // The job runs hours later with old bytes: it must not.
        Assert.False(lease.TryStart());
        lease.End();
        Assert.Equal(1, slot.CurrentCount);
    }

    [Fact]
    public void AJobThatStartedFreesTheSlotOnlyWhenItEndsAndExactlyOnce()
    {
        var releases = 0;
        var lease = new OperationLease(() => Interlocked.Increment(ref releases));
        Assert.True(lease.TryStart());
        Assert.False(lease.Abandon());       // blocked or timed out while it runs
        Assert.Equal(0, releases);
        lease.End();                         // its journal is terminal
        Assert.Equal(1, releases);
        lease.Release(); lease.Abandon(); lease.End();
        Assert.Equal(1, releases);

        var done = 0;
        var answered = new OperationLease(() => Interlocked.Increment(ref done));
        Assert.True(answered.TryStart());
        answered.End();
        answered.Release();                  // the answer path of a merge that ended while the caller waited
        answered.Abandon();
        Assert.Equal(1, done);
    }

    [Fact]
    public async Task AQueueThatNeverRunsTheMergeDoesNotHoldTheSlotForever()
    {
        // The MergeHandler shape with a fake ExecuteInContext that never runs: watch bound, abandon, slot free.
        var slot = new SemaphoreSlim(1);
        Assert.True(await slot.WaitAsync(0));
        var lease = new OperationLease(() => slot.Release());
        var response = new TaskCompletionSource<string>();
        Action? neverRun = () => { if (lease.TryStart()) try { response.TrySetResult("merged"); } finally { lease.End(); } };
        var watched = await OperationDialogLoop.Watch(response.Task, new FakeSurface(), TimeSpan.FromMilliseconds(100), Poll, before: new HashSet<string>());
        Assert.Equal("timed-out", watched.State);
        Assert.True(lease.Abandon());
        Assert.True(await slot.WaitAsync(0));
        neverRun();                          // the tab runs the old job at last: nothing happens
        Assert.False(response.Task.IsCompleted);
    }
}
