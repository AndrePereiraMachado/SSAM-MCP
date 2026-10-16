using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class DeliveryStallTests
{
    [Fact]
    public void AStalledMergeUsesOnlyItsJournalAndResumesWithoutReplaying()
    {
        using var test = new Case();
        var first = test.Run();
        Assert.Equal("unknown", first["writeState"]!.ToString());
        Assert.Equal("dialog", first["stalled"]!["verdict"]!.ToString());
        Assert.Equal(first["operationId"]!.ToString(), first["pendingBridgeOperation"]!["operationId"]!.ToString());
        Assert.Equal("merge_from_oml", first["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(1, test.Bridge.Count("merge_status")); Assert.Equal(1, test.Bridge.Count("snapshot_module")); Assert.Equal(1, test.Bridge.Count("merge_from_oml"));
        Assert.Throws<InvalidOperationException>(() => new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), "test", "A", "someone-else"));
        test.Bridge.StopMethod = null; test.Bridge.Status = "applied";
        var resumed = Delivery.Run(test.Bridge, DeliveryTask.ResumeRequest(test.Work, first["taskId"]!.ToString()), Apply);
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal(1, test.Bridge.Count("merge_from_oml"));
        Assert.Null(resumed["pendingBridgeOperation"]);
    }

    [Fact]
    public void AJournalNotAppliedClosesWithoutTouchingTheStudioUi()
    {
        using var test = new Case(); var first = test.Run();
        test.Bridge.Status = "not-applied"; test.Bridge.Seen.Clear();
        var closed = DeliveryTask.CloseKnownFailure(test.Work, first["taskId"]!.ToString(), "revise", test.Bridge);
        Assert.True(closed["closed"]!.GetValue<bool>()); Assert.Equal("not-applied", closed["writeState"]!.ToString());
        Assert.Equal(new[] { "merge_status" }, test.Bridge.Seen);
    }

    [Fact]
    public void UnknownInTheSameStudioCannotCloseOrCallOpenModule()
    {
        using var test = new Case(); var first = test.Run(); test.Bridge.Seen.Clear();
        var error = Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(test.Work, first["taskId"]!.ToString(), "revise", test.Bridge));
        Assert.Contains("pending", error.Message, StringComparison.OrdinalIgnoreCase);
        // CX14 R4: one bounded windows read names the dialog that blocks now (never a closed one); it writes nothing.
        Assert.Equal(new[] { "merge_status", "ping", "windows" }, test.Bridge.Seen);
    }

    [Theory]
    [InlineData("failed")]
    [InlineData("malformed")]
    public void MissingStudioIdentityEvidenceCannotCloseAPendingOperation(string pingMode)
    {
        using var test = new Case(); var first = test.Run(); test.Bridge.Seen.Clear(); test.Bridge.PingMode = pingMode;
        Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(test.Work, first["taskId"]!.ToString(), "revise", test.Bridge));
        // CX14 R4: one bounded windows read names the dialog that blocks now (never a closed one); it writes nothing.
        Assert.Equal(new[] { "merge_status", "ping", "windows" }, test.Bridge.Seen);
    }

    [Fact]
    public void AnotherStudioCanCloseWithTheExistingHashProof()
    {
        using var test = new Case(); var first = test.Run(); test.Bridge.Pid++;
        test.Bridge.Seen.Clear();
        var closed = DeliveryTask.CloseKnownFailure(test.Work, first["taskId"]!.ToString(), "revise", test.Bridge);
        Assert.True(closed["closed"]!.GetValue<bool>()); Assert.True(closed["closeProof"]!["equal"]!.GetValue<bool>());
        Assert.Equal(new[] { "merge_status", "ping", "open_module", "snapshot_module" }, test.Bridge.Seen);
    }

    [Fact]
    public void PreProbeRefusalIsNotSentAndReleasesTheReservation()
    {
        using var test = new Case(); test.Bridge.Before = true;
        var first = test.Run();
        Assert.Equal("not-sent", first["writeState"]!.ToString());
        Assert.Equal("STUDIO_ERROR_DIALOG_OPEN", first["code"]!.ToString());
        Assert.Equal("dialog-before", first["stalled"]!["verdict"]!.ToString());
        Assert.Null(first["pendingBridgeOperation"]);
        using var next = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), "test", "A", "someone-else"); next.Release();
        Assert.Equal(0, test.Bridge.Count("merge_status"));
    }

    [Fact]
    public void AStalledTabCloseKeepsConfirmedDeliveryAndReleasesItsModuleReservation()
    {
        using var test = new Case(); test.Bridge.StopMethod = "close_module";
        var result = test.Run(closeOpenedTab: true);
        Assert.True(result["delivered"]!.GetValue<bool>());
        Assert.Equal("applied", result["writeState"]!.ToString());
        Assert.Equal("close_module", result["stalled"]!["method"]!.ToString());
        Assert.Equal("close_module", result["pendingBridgeOperation"]!["method"]!.ToString());
        Assert.Equal(1, test.Bridge.Count("close_module")); Assert.Equal(1, test.Bridge.Count("merge_from_oml"));
        using var next = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), "test", "A", "someone-else"); next.Release();
    }

    // CX14 R3: the idle rows (true) moved to AResumeAfterProvenIdleSettlesTheUiCallAndGoesOnByTheMergeState: once idle is
    // proven the call has ended and the resume goes on; while it may still run, the resume only observes (these rows).
    [Theory]
    [InlineData("refresh_references", false)]
    [InlineData("open_module", false)]
    [InlineData("close_module", false)]
    public void ResumeWithoutAJournalNeverRepeatsTheUncertainUiWrite(string method, bool idle)
    {
        using var test = new Case(); var id = test.PendingWithoutJournal(method);
        test.Bridge.UiIdle = idle; test.Bridge.Seen.Clear();
        var result = Delivery.Run(test.Bridge, DeliveryTask.ResumeRequest(test.Work, id), Apply);
        Assert.Equal("unknown", result["writeState"]!.ToString());
        Assert.NotNull(result["pendingBridgeOperation"]);
        Assert.Equal(idle, result["pendingUiProof"]!["idle"]!.GetValue<bool>());
        Assert.Equal(idle ? "close-with-hash-proof" : "wait-for-idle", result["pendingOperationRecovery"]!["action"]!.ToString());
        Assert.Equal(2, test.Bridge.Count("windows")); Assert.Equal(2, test.Bridge.Count("ui_alive")); Assert.Equal(2, test.Bridge.Count("list_open_modules"));
        Assert.DoesNotContain(test.Bridge.Seen, m => m is "open_module" or "refresh_references" or "close_module" or "merge_from_oml");
        if (idle) Assert.Null(result["stalled"]!["blockedBy"]);
        else Assert.NotNull(result["stalled"]!["blockedBy"]);
    }

    [Theory]
    [InlineData("refresh_references", "applied")]
    [InlineData("open_module", "applied")]
    [InlineData("close_module", "applied")]
    [InlineData("refresh_references", "unknown")]
    [InlineData("open_module", "unknown")]
    [InlineData("close_module", "unknown")]
    public void AResumeAfterProvenIdleSettlesTheUiCallAndGoesOnByTheMergeState(string method, string writeState)
    {
        using var test = new Case(); var id = test.PendingWithoutJournal(method, writeState, keepOperationId: true);
        test.Bridge.UiIdle = true; test.Bridge.StopMethod = null; test.Bridge.Seen.Clear();
        var result = Delivery.Run(test.Bridge, DeliveryTask.ResumeRequest(test.Work, id), Apply);
        Assert.Null(result["pendingBridgeOperation"]);
        Assert.Null(result["pendingOperationRecovery"]);
        Assert.Equal(method, result["settledBridgeOperations"]![0]!["method"]!.ToString());
        Assert.True(result["settledBridgeOperations"]![0]!["idleProof"]!["idle"]!.GetValue<bool>());
        Assert.Equal(2, test.Bridge.Count("ui_alive"));
        Assert.DoesNotContain(test.Bridge.Seen, m => m is "refresh_references" or "close_module" or "merge_from_oml");
        Assert.DoesNotContain("Close this task", result["error"]?.ToString() ?? "");
        // An applied merge is verified again (here: delivered); an unknown one is reconciled through its own journal.
        if (writeState == "applied") { Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString()); Assert.Equal(1, test.Bridge.Count("get_errors")); }
        else Assert.Equal(1, test.Bridge.Count("merge_status"));
    }

    [Fact]
    public void ClosingAnUnjournaledUiWriteThatIsStillBusyDoesNotWrite()
    {
        using var test = new Case(); var id = test.PendingWithoutJournal("refresh_references"); test.Bridge.Seen.Clear();
        Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(test.Work, id, "revise", test.Bridge));
        Assert.DoesNotContain(test.Bridge.Seen, m => m is "open_module" or "refresh_references" or "close_module" or "snapshot_module");
        Assert.Equal(2, test.Bridge.Count("ui_alive"));
    }

    [Fact]
    public void AnUnjournaledPreMergeRefreshThatEndedGoesOnInTheSameResumeOrClosesNamingIt()
    {
        // CX14 N2 (declared): this test said "close this task" (R3). A settled Refresh References may have changed the
        // module, so the resume goes on in the same call, and both the receipt and the close name the refresh and Ctrl+Z.
        using var test = new Case(); var id = test.PendingWithoutJournal("refresh_references", "not-sent", recordedBase: false);
        test.Bridge.UiIdle = true; test.Bridge.StopMethod = null; test.Bridge.Seen.Clear();
        var resumed = Delivery.Run(test.Bridge, DeliveryTask.ResumeRequest(test.Work, id), Apply);
        Assert.DoesNotContain("Nothing of this task reached the module", resumed.ToJsonString());
        Assert.Null(resumed["pendingBridgeOperation"]);
        Assert.Contains("Ctrl+Z", resumed["settledBridgeOperations"]![0]!["note"]!.ToString());
        Assert.Equal(2, test.Bridge.Count("ui_alive"));
        Assert.Equal(1, test.Bridge.Count("merge_from_oml"));
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());

        using var other = new Case(); var second = other.PendingWithoutJournal("refresh_references", "not-sent", recordedBase: false);
        other.Bridge.UiIdle = true; other.Bridge.StopMethod = null; other.Bridge.Seen.Clear();
        var closed = DeliveryTask.CloseKnownFailure(other.Work, second, "revise", other.Bridge);
        Assert.True(closed["closedWithoutStudio"]!.GetValue<bool>());
        Assert.Contains("Ctrl+Z", closed["closedReason"]!.ToString());
        Assert.DoesNotContain(other.Bridge.Seen, m => m is "open_module" or "snapshot_module" or "refresh_references" or "merge_from_oml");
        Assert.Equal(2, other.Bridge.Count("ui_alive"));
    }

    // CX14 R3: the applied rows moved to AnAppliedTaskWhoseUiCallEndedClosesAsAKnownFailure: the outcome of an unjournaled UI
    // call never turns an applied merge into an uncertain one.
    [Theory]
    [InlineData("unknown", false)]
    [InlineData("unknown", true)]
    public void IdleWithoutAJournalStillRequiresTheExistingBaseHashProof(string writeState, bool changed)
    {
        using var test = new Case(); var id = test.PendingWithoutJournal("refresh_references", writeState);
        test.Bridge.UiIdle = true; test.Bridge.StopMethod = null; test.Bridge.Seen.Clear();
        if (changed) test.Bridge.LiveBytes = "different live bytes";
        if (changed)
            Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(test.Work, id, "revise", test.Bridge));
        else
        {
            var closed = DeliveryTask.CloseKnownFailure(test.Work, id, "revise", test.Bridge);
            Assert.True(closed["closed"]!.GetValue<bool>()); Assert.True(closed["closeProof"]!["equal"]!.GetValue<bool>());
        }
        Assert.Equal(2, test.Bridge.Count("ui_alive")); Assert.Equal(1, test.Bridge.Count("snapshot_module"));
        Assert.Equal(0, test.Bridge.Count("refresh_references")); Assert.Equal(0, test.Bridge.Count("merge_from_oml"));
    }

    [Theory]
    [InlineData("refresh_references", false)]
    [InlineData("refresh_references", true)]
    [InlineData("close_module", true)]
    [InlineData("open_module", true)]
    public void AnAppliedTaskWhoseUiCallEndedClosesAsAKnownFailure(string method, bool changed)
    {
        using var test = new Case(); var id = test.PendingWithoutJournal(method, "applied");
        test.Bridge.UiIdle = true; test.Bridge.StopMethod = null; test.Bridge.Seen.Clear();
        if (changed) test.Bridge.LiveBytes = "different live bytes";
        var closed = DeliveryTask.CloseKnownFailure(test.Work, id, "revise", test.Bridge);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.Equal("applied", closed["writeState"]!.ToString());
        Assert.Null(closed["closeProof"]);
        Assert.Null(closed["pendingBridgeOperation"]);
        Assert.Equal(method, closed["settledBridgeOperations"]![0]!["method"]!.ToString());
        Assert.Equal(2, test.Bridge.Count("ui_alive")); Assert.Equal(1, test.Bridge.Count("snapshot_module"));
        Assert.Equal(0, test.Bridge.Count("refresh_references")); Assert.Equal(0, test.Bridge.Count("merge_from_oml")); Assert.Equal(0, test.Bridge.Count("close_module"));
    }

    [Theory]
    [InlineData("refresh_references", true)]
    [InlineData("get_errors", false)]
    [InlineData("snapshot_module", false)]
    [InlineData("open_module", true)]
    public void OtherWatchedCallsKeepStallAndOnlyWritesHavePendingOperations(string method, bool pending)
    {
        using var test = new Case(); test.Bridge.StopMethod = method;
        var result = test.Run();
        Assert.Equal(method, result["stalled"]!["method"]!.ToString());
        if (pending)
        {
            Assert.Equal(method, result["pendingBridgeOperation"]!["method"]!.ToString());
            Assert.Null(result["pendingBridgeOperation"]!["operationId"]);
        }
        else Assert.Null(result["pendingBridgeOperation"]);
        if (method == "refresh_references") Assert.Equal(0, test.Bridge.Count("merge_from_oml"));
    }

    private static JsonObject Apply(string _, string __, string output)
    { File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; }

    private sealed class Case : IDisposable
    {
        private readonly string? authority = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        public string Work { get; }
        public string Job { get; }
        public FakeBridge Bridge = new();
        public Case()
        {
            var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryStallTests).Assembly.Location)!)!;
            Work = Path.Combine(root, ".local", "cx14-delivery-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Work);
            Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Path.Combine(Work, "authority"));
            Job = Path.Combine(Work, "job.json"); File.WriteAllText(Job, "{\"ops\":[]}");
        }
        public JsonObject Run(bool closeOpenedTab = false) => Delivery.Run(Bridge, new("Probe", Job, Work, Array.Empty<string>(), CloseOpenedTab: closeOpenedTab), Apply);
        public string PendingWithoutJournal(string method, string writeState = "unknown", bool recordedBase = true, bool keepOperationId = false)
        {
            var first = Run(); var id = first["taskId"]!.ToString();
            using var task = new DeliveryTask(DeliveryTask.ResumeRequest(Work, id));
            task.State["pendingBridgeOperation"] = new JsonObject { ["method"] = method, ["moduleKey"] = "A" };
            task.State["stalled"]!["method"] = method; if (!keepOperationId) task.State.Remove("operationId");
            task.State["writeState"] = writeState;
            if (!recordedBase) { task.State.Remove("snapshot"); task.State.Remove("artifacts"); }
            task.Save("fixture-pending-ui");
            Bridge.StopMethod = method;
            return id;
        }
        public void Dispose() => Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(authority));
    }

    private sealed class FakeBridge : IBridgeClient
    {
        public readonly List<string> Seen = new();
        public string? StopMethod = "merge_from_oml";
        public bool Before;
        public string Status = "unknown";
        public string? PingMode;
        public bool UiIdle;
        public string LiveBytes = "snapshot";
        public int Pid = 1234;
        public int Count(string method) => Seen.Count(m => m == method);
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Seen.Add(method);
            if (method == "ping" && PingMode == "failed") throw new IOException("Bridge cannot answer ping");
            if (method == StopMethod)
                throw new BridgeCallException("Studio stopped", Before ? false : null, new JsonObject {
                    ["method"] = method, ["verdict"] = Before ? "dialog-before" : "dialog", ["afterMs"] = 400,
                    ["studio"] = new JsonObject { ["pid"] = 1234, ["startedUtc"] = "original" },
                    ["blockedBy"] = new JsonObject { ["title"] = "Unexpected Error", ["type"] = "DialogWindow", ["kind"] = "UnexpectedError" } });
            return method switch {
                "open_module" => new() { ["opened"] = true, ["alreadyOpen"] = false, ["dependenciesDialog"] = StopMethod == "refresh_references"
                    ? new JsonObject { ["answered"] = new JsonArray(new JsonObject { ["kind"] = "Dependencies", ["title"] = "Dependencies" }) } : null },
                "get_active_module" => new() { ["name"] = "Probe", ["key"] = "A", ["environment"] = "test" },
                "snapshot_module" => Snapshot(parameters!),
                "merge_from_oml" => Receipt(),
                "merge_status" => new() { ["state"] = Status, ["binding"] = new JsonObject(), ["error"] = "operation pending", ["receipt"] = Status == "unknown" ? null : Receipt() },
                "get_errors" => new() { ["newErrors"] = 0, ["new"] = new JsonArray() },
                "ping" => PingMode == "malformed" ? new() : new() { ["pid"] = Pid, ["startedUtc"] = "original" },
                "windows" => new() { ["windows"] = UiIdle ? new JsonArray() : new JsonArray(new JsonObject {
                    ["title"] = "Unexpected Error", ["type"] = "DialogWindow", ["isVisible"] = true, ["isModal"] = false }) },
                "ui_alive" => new() { ["alive"] = UiIdle },
                "list_open_modules" => new() { ["modules"] = new JsonArray(new JsonObject { ["name"] = "Probe", ["serverSilentMode"] = !UiIdle,
                    ["hasOpenedActiveESpace"] = true, ["serverOperation"] = new JsonObject { ["running"] = !UiIdle } }) },
                _ => throw new InvalidOperationException(method)
            };
        }
        private JsonObject Receipt() => Status == "not-applied"
            ? new() { ["merged"] = false, ["reason"] = "not applied" }
            : new() { ["merged"] = true, ["newErrors"] = 0 };
        private JsonObject Snapshot(JsonObject p)
        { File.WriteAllText(p["path"]!.ToString(), LiveBytes); return new() { ["key"] = "A", ["snapshot_id"] = "base-id" }; }
    }
}
