using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 R3: an unjournaled UI call (here the tab close after an applied merge) that stopped behind a dialog never
/// changes what the merge's own state says. Once the dialog is gone and two reads prove the Studio idle, a single close or a
/// single resume ends the task: never a resume that says "close" answered by a close that says "resume". The real
/// BridgeClient and Delivery.Run against a loopback fake Studio. Synthetic values only.</summary>
public class DeliveryStallCycleTests
{
    private static StallCase AppliedWithAStalledTabClose(out JsonObject first)
    {
        var test = new StallCase();
        test.Studio.NewErrors = 1;
        // The merge is applied: the live module no longer has the bytes of the task's base.
        test.Studio.OnMerge = s => { s.LiveBytes = "merged-oml-synthetic"; return new JsonObject { ["merged"] = true, ["result"] = "merged" }; };
        // The Studio shows its error report after the tab close was sent; the close then waits behind it.
        test.Studio.OnClose = s => { s.ReportVisible = true; return null; };
        first = test.Run();
        Assert.Equal("applied", first["writeState"]!.ToString());
        Assert.Equal("close_module", first["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Contains("Ctrl+Z", first["error"]!.ToString());
        // The person closes the report; the queued close ends (the Studio keeps the tab of an unsaved merge).
        test.Studio.ReportVisible = false;
        return test;
    }

    [Fact]
    public void OneCloseEndsAnAppliedTaskWhoseTabCloseStoppedAndKeepsItsWriteState()
    {
        using var test = AppliedWithAStalledTabClose(out var first);
        test.Studio.Clear();
        var closed = test.Close(first);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.Equal("applied", closed["writeState"]!.ToString());
        Assert.Null(closed["pendingBridgeOperation"]);
        Assert.False(test.ReservationHeld(closed));
        Assert.DoesNotContain(test.Studio.Calls, m => m is "close_module" or "merge_from_oml" or "refresh_references");
    }

    [Fact]
    public void OneResumeReverifiesAnAppliedTaskWhoseTabCloseStoppedAndNamesCtrlZ()
    {
        using var test = AppliedWithAStalledTabClose(out var first);
        test.Studio.Clear();
        var resumed = test.Resume(first);
        Assert.Equal("applied", resumed["writeState"]!.ToString());
        Assert.Null(resumed["pendingBridgeOperation"]);
        Assert.Contains("Ctrl+Z", resumed["error"]!.ToString());
        Assert.DoesNotContain("Close this task", resumed["error"]!.ToString());
        Assert.Equal(1, test.Studio.Count("get_errors"));
        Assert.DoesNotContain(test.Studio.Calls, m => m is "close_module" or "merge_from_oml" or "refresh_references");
        // The refused task holds the module until it is closed (or closed by the corrected delivery): one close ends it.
        var closed = test.Close(first);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.False(test.ReservationHeld(closed));
    }
}
