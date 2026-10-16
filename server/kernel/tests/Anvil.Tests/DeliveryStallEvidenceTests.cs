using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 R4: the evidence of the pending operation (which Studio ran it, which merge journal settles it) belongs
/// to that operation. A later stop of another call (the resume's open_module) is recorded beside it and never replaces it.
/// The real BridgeClient, Delivery.Run and DeliveryTask.CloseKnownFailure against a loopback fake Studio. Synthetic values.</summary>
public class DeliveryStallEvidenceTests
{
    [Fact]
    public void ACloseAfterARestartComparesTheStudioThatRanTheMergeAndClosesWithTheHashProof()
    {
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        Assert.Equal("unknown", first["writeState"]!.ToString());
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        var original = first["pendingBridgeOperation"]!.DeepClone();
        // The Studio S1 is restarted: S2 (another process) shows its own error report while the task is resumed.
        test.Restart(pid: Environment.ProcessId + 100000, startedUtc: "2026-10-15T00:31:00Z#S2");
        test.Studio.Report["title"] = "Erro inesperado"; test.Studio.ReportVisible = true;
        var resumed = test.Resume(first);
        Assert.Equal("unknown", resumed["writeState"]!.ToString());
        Assert.Equal("open_module", resumed["stalled"]!["method"]!.ToString());
        Assert.Equal(original["operationId"]!.ToString(), resumed["pendingBridgeOperation"]!["operationId"]!.ToString());
        // The person closes S2's report: the close compares S1 (the merge's Studio) with S2 and proves the base by hash.
        test.Studio.ReportVisible = false;
        var closed = test.Close(first);
        Assert.True(closed["closed"]!.GetValue<bool>(), closed.ToJsonString());
        Assert.True(closed["closeProof"]!["equal"]!.GetValue<bool>());
        Assert.Equal("not-applied", closed["writeState"]!.ToString());
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
        Assert.False(test.ReservationHeld(closed));
        // The close compared the Studio recorded with the pending merge itself (S1), kept apart from the resume's stop (S2).
        Assert.Equal("2026-10-15T00:00:00Z#S1", closed["closeStudioChanged"]!["previous"]!["startedUtc"]!.ToString());
        Assert.Equal("2026-10-15T00:31:00Z#S2", closed["closeStudioChanged"]!["current"]!["startedUtc"]!.ToString());
    }

    [Fact]
    public void AStalledOpenOnResumeNeverReplacesThePendingMergeAndTheCloseStillReadsItsJournal()
    {
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        test.Studio.ReportVisible = false;
        // The resume's open_module is sent and then stops behind a new report in the same Studio.
        test.Studio.OnOpen = s => { s.ReportVisible = true; return null; };
        var resumed = test.Resume(first);
        Assert.Equal("unknown", resumed["writeState"]!.ToString());
        Assert.Equal("open_module", resumed["stalled"]!["method"]!.ToString());
        Assert.Equal("merge_from_oml", resumed["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(first["operationId"]!.ToString(), resumed["pendingBridgeOperation"]!["operationId"]!.ToString());
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        // CX14 N3: while the stopped open may still run (its report is open), the close proves nothing and sends nothing.
        test.Studio.Clear();
        var waiting = Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.Contains("open_module", waiting.Message);
        Assert.DoesNotContain(test.Studio.Calls, m => m is "open_module" or "snapshot_module" or "merge_from_oml" or "merge_status");
        // The report is closed and the Studio idle: the close settles the open and still reads the merge's journal.
        test.Studio.ReportVisible = false;
        test.Studio.Clear();
        var refused = Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.Contains("same Studio", refused.Message);
        Assert.Equal(1, test.Studio.Count("merge_status"));
        Assert.DoesNotContain(test.Studio.Calls, m => m is "open_module" or "snapshot_module" or "merge_from_oml");
        Assert.True(test.ReservationHeld(resumed));
    }

    [Fact]
    public void ACloseRefusedInTheSameStudioNamesOnlyADialogThatIsStillOpen()
    {
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        // The person closed the report; the merge's journal still says unknown in the same Studio.
        test.Studio.ReportVisible = false;
        var refused = Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.Contains("same Studio", refused.Message);
        Assert.DoesNotContain("Unexpected Error", refused.Message);
        // The report comes back: the refusal names it again.
        test.Studio.ReportVisible = true;
        var again = Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.Contains("Close the Studio dialog \"Unexpected Error\"", again.Message);
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
    }
}
