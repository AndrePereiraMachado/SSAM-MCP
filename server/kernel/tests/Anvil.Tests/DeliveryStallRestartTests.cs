using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX14 N5 (kernel side): the merge stopped in Studio S1, which was restarted; the resume runs in S2 and its own
/// open_module stops behind a report of S2. Each call is judged by its own Studio: the open (S2) stays fenced until two idle
/// reads, then the close proves by hash, in another Studio than the merge's, that nothing was applied. The real BridgeClient,
/// Delivery.Run and DeliveryTask against a loopback fake Studio. Synthetic values only.</summary>
public class DeliveryStallRestartTests
{
    [Fact]
    public void TheResumesOwnStoppedOpenInTheNewStudioIsFencedUntilIdleThenTheCloseProvesByHash()
    {
        using var test = new StallCase();
        test.Studio.OnMerge = s => { s.ReportVisible = true; return null; };
        var first = test.Run();
        Assert.Equal(1, test.Studio.Count("merge_from_oml"));
        // S1 is restarted: the same port answers S2 (same process here, another start), with no dialog.
        test.Restart(pid: Environment.ProcessId, startedUtc: "2026-10-15T00:31:00Z#S2");
        test.Studio.OnOpen = s => { s.ReportVisible = true; s.UiAlive = false; return null; };
        var resumed = test.Resume(first);
        var pending = resumed["pendingBridgeOperation"]!;
        Assert.Equal("merge_from_oml", pending["method"]!.ToString());
        Assert.Equal("2026-10-15T00:00:00Z#S1", pending["stall"]!["studio"]!["startedUtc"]!.ToString());
        Assert.Equal("open_module", pending["after"]![0]!["method"]!.ToString());
        Assert.Equal("2026-10-15T00:31:00Z#S2", pending["after"]![0]!["stall"]!["studio"]!["startedUtc"]!.ToString());
        // The report of S2 is closed, the open still runs: the close refuses and sends nothing.
        test.Studio.ReportVisible = false; test.Studio.OnOpen = null; test.Studio.Clear();
        var waiting = Assert.Throws<InvalidOperationException>(() => test.Close(first));
        Assert.Contains("open_module", waiting.Message);
        Assert.DoesNotContain(test.Studio.Calls, m => m is "open_module" or "snapshot_module" or "merge_from_oml");
        // The open ends: the close settles it and proves by hash in S2 that S1's merge was not applied.
        test.Studio.UiAlive = true; test.Studio.Clear();
        var closed = test.Close(first);
        Assert.True(closed["closed"]!.GetValue<bool>(), closed.ToJsonString());
        Assert.True(closed["closeProof"]!["equal"]!.GetValue<bool>());
        Assert.Equal("not-applied", closed["writeState"]!.ToString());
        Assert.Equal(0, test.Studio.Count("merge_from_oml"));
    }
}
