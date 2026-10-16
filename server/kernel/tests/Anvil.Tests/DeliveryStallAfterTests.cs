using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 N3: a UI call (open_module, refresh_references) the resume of a pending merge sent and that then stopped is
/// recorded beside the merge (pendingBridgeOperation.after) without replacing it. While it may still run, no resume or close
/// sends open/refresh/close; once two idle reads prove it ended, the resume goes on. The real BridgeClient and Delivery.Run
/// against a loopback fake Studio whose UI thread stays busy (ui_alive false) while the stopped call runs. Synthetic values.</summary>
public class DeliveryStallAfterTests
{
    private static readonly JsonObject Answered = new() { ["answered"] = new JsonArray(new JsonObject { ["title"] = "Incompatible or missing dependencies found", ["answer"] = "Cancel" }) };

    /// <summary>The merge stops (journal unknown); the person closes the report; resume 1 sends a UI call that stops and keeps
    /// running; the person closes that report too, the call still runs.</summary>
    private static StallCase AStoppedCallOfTheResume(bool refresh, out JsonObject first, out JsonObject resumed)
    {
        var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        first = test.Run();
        Assert.Equal("merge_from_oml", first["pendingBridgeOperation"]!["method"]!.ToString());
        test.Studio.ReportVisible = false;
        if (refresh)
        {
            test.Studio.OnOpen = s => { var opened = s.Open(); opened["dependenciesDialog"] = Answered.DeepClone(); return opened; };
            test.Studio.OnRefresh = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        }
        else test.Studio.OnOpen = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        resumed = test.Resume(first);
        var pending = resumed["pendingBridgeOperation"]!;
        Assert.Equal("merge_from_oml", pending["method"]!.ToString());
        Assert.Equal(first["operationId"]!.ToString(), pending["operationId"]!.ToString());
        test.Studio.ReportVisible = false; test.Studio.OnOpen = null; test.Studio.OnRefresh = null; test.Studio.Clear();
        return test;
    }

    [Theory]
    [InlineData(false, "unknown")]
    [InlineData(true, "unknown")]
    [InlineData(false, "not-applied")]
    public void AStoppedCallOfAResumeIsFencedBesideTheMergeAndNeverSentAgainWithoutIdle(bool refresh, string journal)
    {
        using var test = AStoppedCallOfTheResume(refresh, out var first, out var resumed);
        var method = refresh ? "refresh_references" : "open_module";
        Assert.Equal(method, resumed["pendingBridgeOperation"]!["after"]![0]!["method"]!.ToString());
        test.Studio.MergeStatus = journal;   // E: the merge's journal ends while the stopped call still runs
        // Resume 2 while the stopped call still runs (ui_alive false): nothing is sent.
        var second = test.Resume(first);
        Assert.Equal(0, test.Studio.Count("open_module")); Assert.Equal(0, test.Studio.Count("refresh_references"));
        Assert.Equal(0, test.Studio.Count("close_module")); Assert.Equal(2, test.Studio.Count("ui_alive"));
        Assert.Equal(method, second["pendingBridgeOperation"]!["after"]![0]!["method"]!.ToString());
        Assert.Contains("still pending", second["error"]!.ToString());
        // The close refuses too, sends nothing and keeps the evidence (whatever the merge's journal says).
        test.Studio.Clear();
        Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.DoesNotContain(test.Studio.Calls, m => m is "open_module" or "refresh_references" or "close_module" or "snapshot_module");
        var saved = DeliveryTask.ResumeRequest(test.Work, first["taskId"]!.ToString());
        using (var task = new DeliveryTask(saved)) Assert.Equal(method, task.State["pendingBridgeOperation"]?["after"]?[0]?["method"]?.ToString());
        // The call ends: the next resume proves idle, settles it and goes on, with one fresh open and no refresh.
        test.Studio.UiAlive = true; test.Studio.Clear();
        var third = test.Resume(first);
        Assert.Equal(1, test.Studio.Count("open_module")); Assert.Equal(0, test.Studio.Count("refresh_references"));
        Assert.Contains(third["settledBridgeOperations"]!.AsArray(), e => e?["method"]?.ToString() == method);
        Assert.Null(third["pendingBridgeOperation"]?["after"]);
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
    }
}
