using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F1 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md), A17: closing a failed task never requires the selected tab
/// ("Select the original module/environment before closing its failed delivery", 6 times on 2026-10-06, CLOSE_REFUSED).
/// A task never sent (the Cardapio_BackOffice case: writeState not-sent after an apply refusal, another tab selected) or
/// proven not applied closes with no Studio call at all; one with something to prove opens or selects its own module by
/// key; a module that no longer exists closes as "module gone".
/// </summary>
public sealed class Pa2F1CloseTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F1CloseTests).Assembly.Location)!)!;

    // Reservations live in the authority folder (BridgeAccess.DirectoryPath). These tests keep it private to the test run and
    // never restore it to an absent value, so no reservation of a test can reach the user's authority.
    public Pa2F1CloseTests()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR")))
            Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Root, ".local", "pa2-f1-tests", "authority"));
    }

    [Theory]
    [InlineData("not-sent")]
    [InlineData("not-applied")]
    public void ATaskWhoseWriteNeverReachedTheModuleClosesWithoutAnyStudioCall(string writeState)
    {
        var (work, id) = Create(writeState, "op #280 (html ): InvalidOperationException: html: line 1 col 3002 <label>: <label> takes text, not child elements");
        var bridge = new NoStudio();
        var closed = DeliveryTask.CloseKnownFailure(work, id, "superseded by a corrected job", bridge);
        Assert.Equal(0, bridge.Calls);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.Equal("superseded by a corrected job", closed["closedReason"]!.ToString());
        Assert.True(closed["closedWithoutStudio"]!.GetValue<bool>());
        Assert.Null(closed["reservationNotReleased"]);
        Assert.Contains("<label> takes text", closed["error"]!.ToString());
        // Closed for good: neither replayed nor closed twice through the Studio.
        Assert.Throws<InvalidOperationException>(() => Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, id), (_, _, _) => throw new Exception("must not apply")));
        Assert.True(DeliveryTask.CloseKnownFailure(work, id, "again", bridge)["closed"]!.GetValue<bool>());
        Assert.Equal(0, bridge.Calls);
    }

    [Fact]
    public void AnAppliedTaskWithAnotherTabSelectedOpensItsModuleByKeyAndCloses()
    {
        var (work, id) = Create("applied", "merge kept for review: new TrueChange errors");
        var bridge = new Studio { ActiveKey = "other-module" };
        var closed = DeliveryTask.CloseKnownFailure(work, id, "compiler correction", bridge);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.Equal("compiler correction", closed["closedReason"]!.ToString());
        Assert.True(File.Exists(Path.Combine(work, "deliver", id, "closed-state.oml")));
        var open = Assert.Single(bridge.Requests, r => r.Method == "open_module").Parameters!;
        Assert.Equal("module", open["module_key"]!.ToString());
        Assert.Equal(Env, open["environment"]!.ToString());
        Assert.Equal("module", Assert.Single(bridge.Requests, r => r.Method == "snapshot_module").Parameters!["module_key"]!.ToString());
        Assert.DoesNotContain(bridge.Requests, r => r.Method == "get_active_module");
    }

    [Fact]
    public void ATaskOfAModuleThatNoLongerExistsClosesAsModuleGone()
    {
        var (work, id) = Create("applied", "merge kept for review");
        var gone = new Studio { OpenError = "open_module: The module 'Cardapio_UI' was not found in the environment" };
        var closed = DeliveryTask.CloseKnownFailure(work, id, "module recreated", gone);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.Equal(DeliveryTask.ModuleGoneReason, closed["closedReason"]!.ToString());
        Assert.Equal("module recreated", closed["closeRequestReason"]!.ToString());
        Assert.Contains("not found", closed["moduleGone"]!["evidence"]!.ToString());
        Assert.DoesNotContain(gone.Requests, r => r.Method == "snapshot_module");

        // The name now opens another module (deleted and recreated): a bridge with module_key finds no tab with the old key.
        var (work2, id2) = Create("unchanged", "requested element missing");
        var recreated = new Studio { SnapshotError = "snapshot_module: Requested module identity is not open in any Studio tab; nothing was executed" };
        Assert.Equal(DeliveryTask.ModuleGoneReason, DeliveryTask.CloseKnownFailure(work2, id2, "x", recreated)["closedReason"]!.ToString());
        // An older bridge snapshots the selected tab: the same name under another key.
        var (work3, id3) = Create("applied", "merge kept for review");
        var older = new Studio { SnapshotKey = "new-key", SnapshotName = "Probe" };
        Assert.Equal(DeliveryTask.ModuleGoneReason, DeliveryTask.CloseKnownFailure(work3, id3, "x", older)["closedReason"]!.ToString());
        // A dialog that blocks the open refuses the close and closes nothing.
        var (work4, id4) = Create("applied", "merge kept for review");
        var blocked = new Studio { Blocked = true };
        Assert.Contains("blocked", Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(work4, id4, "x", blocked)).Message);
        Assert.NotEqual(true, DurableJson.Read(Path.Combine(work4, "deliver", id4, "task.json"))["closed"]?.GetValue<bool>());
    }

    [Fact]
    public void AnUncertainTaskIsNeverClosedOnTheInferenceThatItsModuleIsGone()
    {
        var (work, id) = Create("unknown", "Merge outcome is unknown");
        var state = DurableJson.Read(Path.Combine(work, "deliver", id, "task.json"));
        Assert.Null(RollbackProof.BaseSha256(state));
        // Without a recorded base the uncertain task is refused before any Studio call, as before.
        var bridge = new NoStudio();
        Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(work, id, "x", bridge));
        Assert.Equal(0, bridge.Calls);
        Assert.True(DeliveryTask.ModuleGone("open_module: module 'X' does not exist"));
        Assert.False(DeliveryTask.ModuleGone("open_module: 'X' did not become active in 20 s and no dialog was detected"));
    }

    // ---- helpers
    private const string Env = "fixture.close.example";

    private static (string Work, string Id) Create(string writeState, string error)
    {
        var work = Path.Combine(Root, ".local", "pa2-f1-tests", "close", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        using var task = new DeliveryTask(new DeliveryRequest("Probe", job, work, []));
        task.State["writeState"] = writeState; task.State["moduleKey"] = "module"; task.State["environment"] = Env; task.State["error"] = error;
        if (writeState is "applied" or "unchanged") task.State["validation"] = new JsonObject { ["newErrors"] = 1 };
        task.Save("rejected");
        return (work, task.Id);
    }

    /// <summary>A Studio that must never be called.</summary>
    private sealed class NoStudio : IBridgeClient
    {
        public int Calls;
        public JsonObject Call(string method, JsonObject? parameters = null) { Calls++; throw new InvalidOperationException("the Studio must not be called: " + method); }
    }

    private sealed class Studio : IBridgeClient
    {
        public string ActiveKey = "module";
        public string? OpenError, SnapshotError, SnapshotKey, SnapshotName;
        public bool Blocked;
        public List<(string Method, JsonObject? Parameters)> Requests { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Requests.Add((method, parameters?.DeepClone().AsObject()));
            switch (method)
            {
                case "get_active_module": return new() { ["name"] = ActiveKey == "module" ? "Probe" : "Other", ["key"] = ActiveKey, ["environment"] = Env };
                case "open_module":
                    if (OpenError != null) throw new BridgeCallException(OpenError, false);
                    if (Blocked) return new() { ["opened"] = false, ["blockedBy"] = new JsonArray("dialog"), ["hint"] = "close the dialog" };
                    ActiveKey = "module"; return new() { ["opened"] = true, ["alreadyOpen"] = true, ["selected"] = true };
                case "snapshot_module":
                    if (SnapshotError != null) throw new BridgeCallException(SnapshotError, false);
                    File.WriteAllText(parameters!["path"]!.ToString(), "closed snapshot");
                    return new() { ["snapshot_id"] = "closed", ["key"] = SnapshotKey ?? "module", ["name"] = SnapshotName ?? "Probe" };
                default: throw new InvalidOperationException("Unexpected bridge operation " + method);
            }
        }
    }
}
