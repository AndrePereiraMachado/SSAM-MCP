using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 N2: a Refresh References of this task (MB2 after the dependencies dialog, C26) that stopped behind a dialog
/// and then ran may have changed the module's references. Once two idle reads prove it ended, no answer says that nothing
/// of the task reached the module: the receipt and the close name the refresh and Ctrl+Z, and a resume goes on as any
/// resume of a task whose merge was never sent (one call, no close and deliver again). The real BridgeClient and
/// Delivery.Run against a loopback fake Studio. Synthetic values only.</summary>
public class DeliveryStallRefreshTests
{
    private static readonly JsonObject Answered = new() { ["answered"] = new JsonArray(new JsonObject { ["title"] = "Incompatible or missing dependencies found", ["answer"] = "Cancel" }) };

    /// <param name="dialogAgain">The Studio shows the dependencies dialog again at the resume's open (MB2 answers it and
    /// the delivery's normal steps send refresh_references again).</param>
    private static StallCase RefreshStoppedAfterTheDependenciesDialog(out JsonObject first, bool dialogAgain = false)
    {
        var test = new StallCase();
        var opens = 0;
        test.Studio.OnOpen = s => { var opened = s.Open(); if (++opens == 1 || dialogAgain) opened["dependenciesDialog"] = Answered.DeepClone(); return opened; };
        // MB2: the refresh is sent, then stops behind an error report; it stays queued in the Studio.
        test.Studio.OnRefresh = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        test.Studio.OnMerge = s => new JsonObject { ["merged"] = true, ["result"] = "merged" };
        first = test.Run();
        Assert.Equal("not-sent", first["writeState"]!.ToString());
        Assert.Equal("refresh_references", first["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        // The person closes the report; the queued refresh runs and changes the module's references.
        test.Studio.ReportVisible = false; test.Studio.UiAlive = true; test.Studio.LiveBytes = "refreshed-references-oml";
        test.Studio.OnRefresh = null; test.Studio.Clear();
        return test;
    }

    [Fact]
    public void AResumeAfterTheRefreshEndedGoesOnAndNamesTheRefreshAndCtrlZ()
    {
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first);
        var resumed = test.Resume(first);
        Assert.DoesNotContain("Nothing of this task reached the module", resumed.ToJsonString());
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        var settled = resumed["settledBridgeOperations"]![0]!;
        Assert.Equal("refresh_references", settled["method"]!.ToString());
        Assert.Contains("Refresh References", settled["note"]!.ToString());
        Assert.Contains("Ctrl+Z", settled["note"]!.ToString());
        // CX14 N6: the note is the truth of this call's end: the merge was sent (delivered), and it names every UI call the
        // resume sent again after the proof (its open), never "nothing was repeated" nor "not sent again".
        Assert.DoesNotContain("never sent", settled["note"]!.ToString());
        AssertTheNoteNamesWhatTheCallSentAgain(resumed, settled.AsObject(), test.Studio);
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        Assert.Equal(0, test.Studio.Count("refresh_references"));
        Assert.Equal(2, test.Studio.Count("ui_alive"));
    }

    [Fact]
    public void AResumeWhoseOpenShowsTheDependenciesDialogAgainSaysTheRefreshWasSentAgain()
    {
        // CX14 N6 (declared): after the proven idle the not-sent resume runs its normal steps; MB2 answers the dialog again
        // and sends refresh_references again (C26 does the same whenever the task captured producers); never the merge.
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first, dialogAgain: true);
        var resumed = test.Resume(first);
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal(1, test.Studio.Count("refresh_references"));
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        var note = resumed["settledBridgeOperations"]![0]!["note"]!.ToString();
        Assert.Contains("refresh_references 1x", note);
        AssertTheNoteNamesWhatTheCallSentAgain(resumed, resumed["settledBridgeOperations"]![0]!.AsObject(), test.Studio);
        Assert.DoesNotContain("never sent", note);
    }

    /// <summary>CX14 N6 (r4 guard): the note of a settled refresh names, with its count, each of refresh_references,
    /// open_module and close_module that the call that settled it sent again after its proof (the fake Studio's own count since
    /// that call began), or says it sent none; never "nothing was repeated" nor "not sent again"; the merge never twice. The
    /// answer's sentAgainAfterIdle carries the same counts, ended.</summary>
    internal static void AssertTheNoteNamesWhatTheCallSentAgain(JsonObject state, JsonObject entry, LoopbackStudio studio)
    {
        var note = entry["note"]!.ToString();
        Assert.DoesNotContain("nothing was repeated", note, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("not sent again", note);
        Assert.Null(entry["noteOpen"]);
        Assert.True(state["sentAgainAfterIdle"]!["ended"]!.GetValue<bool>(), state.ToJsonString());
        var any = false;
        foreach (var method in new[] { "refresh_references", "open_module", "close_module" })
        {
            var sent = studio.Count(method);
            Assert.Equal(sent, entry["sentAgain"]![method]!.GetValue<int>());
            Assert.Equal(sent, state["sentAgainAfterIdle"]![method]!.GetValue<int>());
            if (sent > 0) { any = true; Assert.Contains(method + " " + sent + "x", note); } else Assert.DoesNotMatch(method + @" [0-9]+x", note);
        }
        Assert.Contains(any ? "merge_from_oml is sent at most once per task" : "sent none of refresh_references, open_module or close_module again", note);
        // CX14 N7: this helper checked only the note. The same answer's own texts (error, next, closedReason) never say
        // "nothing was repeated" either, in any case, once the call sent a UI call again after its proof.
        AssertTheAnswerNeverSaysNothingWasRepeated(state);
    }

    /// <summary>CX14 N7: when the call that settled a stopped UI call sent refresh_references, open_module or close_module
    /// again after its proof (sentAgainAfterIdle, ended, any count above zero), no text of its answer says "nothing was
    /// repeated", in any case: the kernel's error, the hint (next) and the close's reason. What is true is said instead:
    /// the merge was not repeated (merge_from_oml at most once per task), and a stopped bridge call was not retried.</summary>
    internal static void AssertTheAnswerNeverSaysNothingWasRepeated(JsonObject state, string? thrown = null)
    {
        var sent = state["sentAgainAfterIdle"] as JsonObject;
        if (sent == null || !new[] { "refresh_references", "open_module", "close_module" }.Any(m => sent[m] is JsonValue v && v.TryGetValue<int>(out var n) && n > 0)) return;
        foreach (var text in new[] { state["error"]?.ToString(), state["next"]?.ToString(), state["closedReason"]?.ToString(), thrown })
            Assert.DoesNotContain("nothing was repeated", text ?? "", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The settled refresh entry of a receipt.</summary>
    private static JsonObject SettledRefresh(JsonObject state)
        => state["settledBridgeOperations"]!.AsArray().OfType<JsonObject>().Last(e => e["method"]?.ToString() == "refresh_references");

    private static readonly JsonObject PersonQuestion = new() { ["blocked"] = true,
        ["blockedBy"] = new JsonObject { ["title"] = "Synthetic question", ["question"] = "Synthetic choice?" } };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AResumeWhoseMergeStopsAfterTheSettledRefreshSaysOnlyThatTheMergeWasNotRepeated(bool dialogAgain)
    {
        // CX14 N7 (A1, A2 of the review): the refresh stopped and ended; the resume proved the idle, settled it and went on
        // (its open_module, and with the dependencies dialog back its refresh_references, sent again); then its merge stopped
        // behind an error report. The uncertain error said "...; nothing was repeated." beside counts that say otherwise.
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first, dialogAgain);
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var resumed = test.Resume(first);
        Assert.Equal("unknown", resumed["writeState"]!.ToString());
        Assert.Equal("merge_from_oml", resumed["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        Assert.Equal(1, test.Studio.Count("open_module"));
        Assert.Equal(dialogAgain ? 1 : 0, test.Studio.Count("refresh_references"));
        AssertTheNoteNamesWhatTheCallSentAgain(resumed, SettledRefresh(resumed), test.Studio);
        var error = resumed["error"]!.ToString();
        Assert.StartsWith("The Studio stopped answering the merge: dialog (Unexpected Error) after ", error);
        Assert.Contains("; the merge was not repeated. Resume reconciles it through merge_status.", error);
    }

    [Fact]
    public void AResumeWhoseResentRefreshStopsAgainIsRefusedWithoutSayingNothingWasRepeated()
    {
        // CX14 N7 (B): the dependencies dialog came back, the refresh the resume sent again stopped behind the report again
        // (not-sent). The bridge client's stop said "...; nothing was repeated" while this call had sent open_module and
        // refresh_references again: it says what is true of the call it stopped, "this call was not retried".
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first, dialogAgain: true);
        test.Studio.OnRefresh = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        var resumed = test.Resume(first);
        Assert.Equal("not-sent", resumed["writeState"]!.ToString());
        Assert.Equal("refresh_references", resumed["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        Assert.Equal(1, test.Studio.Count("refresh_references"));
        AssertTheNoteNamesWhatTheCallSentAgain(resumed, SettledRefresh(resumed), test.Studio);
        Assert.Equal("BridgeCallException: refresh_references: Studio call stopped (dialog): Unexpected Error; this call was not retried", resumed["error"]!.ToString());
    }

    [Fact]
    public void AResumeWhoseMergeWaitsForThePersonSaysOnlyThatTheMergeWasNotRepeated()
    {
        // CX14 N7 (C): the merge the resume sent after the settled refresh answers blocked by a dialog only the person
        // answers (STUDIO_DIALOG_PENDING). Its error said "Nothing was repeated" after this call sent open_module again.
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first);
        test.Studio.OnMerge = _ => PersonQuestion.DeepClone().AsObject();
        var resumed = test.Resume(first);
        Assert.Equal("STUDIO_DIALOG_PENDING", resumed["code"]!.ToString());
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        AssertTheNoteNamesWhatTheCallSentAgain(resumed, SettledRefresh(resumed), test.Studio);
        Assert.Contains("Synthetic choice? The merge was not repeated; after the answer, resume this task (deliver --resume " + first["taskId"] + ").", resumed["error"]!.ToString());
    }

    [Fact]
    public void AResumeThatSettlesItsOwnStoppedOpenWhileTheMergeStillWaitsSaysOnlyThatTheMergeWasNotRepeated()
    {
        // CX14 N7 (the reconcile of a merge that still waits for the person, Delivery.Run): the merge waits for the person;
        // the next resume's open_module stops behind a report and ends; the resume after it proves the idle, settles that
        // open, opens again, and the bridge's watch of the merge (merge_status, dialogWatch) says the question is open
        // again. Its error names only what is true.
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first);
        test.Studio.OnMerge = _ => PersonQuestion.DeepClone().AsObject();
        Assert.Equal("STUDIO_DIALOG_PENDING", test.Resume(first)["code"]!.ToString());
        test.Studio.OnOpen = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        var stopped = test.Resume(first);
        Assert.Equal("open_module", stopped["pendingBridgeOperation"]?["method"]?.ToString() ?? stopped.ToJsonString());
        test.Studio.ReportVisible = false; test.Studio.UiAlive = true; test.Studio.OnOpen = null; test.Studio.Clear();
        test.Studio.OnMergeStatus = _ => new JsonObject { ["state"] = "unknown", ["receipt"] = null, ["dialogWatch"] = true,
            ["pendingDialog"] = PersonQuestion["blockedBy"]!.DeepClone() };
        var resumed = test.Resume(first);
        Assert.Equal("STUDIO_DIALOG_PENDING", resumed["code"]?.ToString() ?? resumed.ToJsonString());
        Assert.Equal(1, test.Studio.Count("open_module"));
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        Assert.Equal(1, resumed["sentAgainAfterIdle"]!["open_module"]!.GetValue<int>());
        AssertTheAnswerNeverSaysNothingWasRepeated(resumed);
        Assert.Contains("Synthetic choice? The merge was not repeated; resume this task again after the answer.", resumed["error"]!.ToString());
    }

    [Fact]
    public void ACloseThatOpensTheModuleAfterTheSettledRefreshAndFindsItChangedSaysOnlyThatTheMergeWasNotRepeated()
    {
        // CX14 N7 (the close, DeliveryTask): the close settles the resume's refresh, opens the module (sent again after the
        // proof) and the live module differs from the base: the task stays uncertain. It said "nothing was repeated".
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        test.Restart(pid: Environment.ProcessId, startedUtc: "2026-10-15T00:31:00Z#S2");
        test.Studio.OnOpen = s => { var opened = s.Open(); opened["dependenciesDialog"] = Answered.DeepClone(); return opened; };
        test.Studio.OnRefresh = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        var resumed = test.Resume(first);
        Assert.Equal("refresh_references", resumed["pendingBridgeOperation"]!["after"]![0]!["method"]!.ToString());
        test.Studio.ReportVisible = false; test.Studio.UiAlive = true; test.Studio.OnOpen = null; test.Studio.OnRefresh = null; test.Studio.Clear();
        test.Studio.LiveBytes = "changed-oml-synthetic";
        var refused = Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.Equal(1, test.Studio.Count("open_module"));
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        var saved = JsonNode.Parse(File.ReadAllText(Path.Combine(first["work"]!.ToString(), "result.json")))!.AsObject();
        Assert.Equal(1, saved["sentAgainAfterIdle"]!["open_module"]!.GetValue<int>());
        AssertTheAnswerNeverSaysNothingWasRepeated(saved, refused.Message);
        Assert.EndsWith("so the task stays uncertain and is not closed. Resume it to reconcile; the merge was not repeated", refused.Message);
    }

    [Fact]
    public void ACloseAfterTheRefreshEndedNamesTheRefreshAndCtrlZInItsReason()
    {
        using var test = RefreshStoppedAfterTheDependenciesDialog(out var first);
        var closed = test.Close(first);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.True(closed["closedWithoutStudio"]!.GetValue<bool>());
        Assert.Contains("Refresh References", closed["closedReason"]!.ToString());
        Assert.Contains("Ctrl+Z", closed["closedReason"]!.ToString());
        Assert.Contains("never sent", closed["closedReason"]!.ToString());
        Assert.DoesNotContain("Nothing of this task reached the module", closed.ToJsonString());
        Assert.DoesNotContain(test.Studio.Calls, m => m is "open_module" or "refresh_references" or "merge_from_oml");
        // CX14 N6 (r4 guard): this close sent nothing again, and says so with its counts.
        AssertTheNoteNamesWhatTheCallSentAgain(closed, closed["settledBridgeOperations"]![0]!.AsObject(), test.Studio);
        Assert.Contains("sent none of", closed["closedReason"]!.ToString());
    }

    [Fact]
    public void ACloseThatSettlesTheResumesRefreshAndThenOpensTheModuleNamesThatOpen()
    {
        // CX14 N6 (r4 guard): the merge stopped in S1, which was restarted; the resume in S2 answered the dependencies dialog
        // and its refresh_references stopped beside the pending merge. The close proves that refresh idle, settles it, then
        // opens the module (open_module, sent again after the proof) for the hash proof in another Studio. Its note names
        // that open; the merge is never sent twice.
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        test.Restart(pid: Environment.ProcessId, startedUtc: "2026-10-15T00:31:00Z#S2");
        test.Studio.OnOpen = s => { var opened = s.Open(); opened["dependenciesDialog"] = Answered.DeepClone(); return opened; };
        test.Studio.OnRefresh = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        var resumed = test.Resume(first);
        Assert.Equal("merge_from_oml", resumed["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal("refresh_references", resumed["pendingBridgeOperation"]!["after"]![0]!["method"]!.ToString());
        test.Studio.ReportVisible = false; test.Studio.UiAlive = true; test.Studio.OnOpen = null; test.Studio.OnRefresh = null; test.Studio.Clear();
        var closed = test.Close(first);
        Assert.True(closed["closed"]!.GetValue<bool>(), closed.ToJsonString());
        Assert.Equal("not-applied", closed["writeState"]!.ToString());
        Assert.Equal(1, test.Studio.Count("open_module"));
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        var entry = closed["settledBridgeOperations"]!.AsArray().OfType<JsonObject>().Single(e => e["method"]?.ToString() == "refresh_references");
        AssertTheNoteNamesWhatTheCallSentAgain(closed, entry, test.Studio);
        Assert.Contains("open_module 1x", closed["closedReason"]!.ToString());
        Assert.DoesNotContain("never sent", entry["note"]!.ToString());
    }
}
