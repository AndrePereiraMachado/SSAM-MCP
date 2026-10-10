using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane D1, C15: an uncertain O11 merge no longer locks the module. Rule tests with a fake bridge: the kernel hash
/// proof in the reconcile, the bridge's own rollback receipt, the close of an uncertain task with the same proof, and the
/// pure rollback proof of the bridge (MergeRollbackProof.cs, linked from Anvil.Bridge).</summary>
public sealed class PacoteD1ReconcileTests
{
    private const string Rolled = "InvalidOperationException: Native merge did not retain all validated producer signature selections.";

    [Fact]
    public void UnknownMergeWithLiveHashEqualToBaseBecomesNotAppliedClosedAndFreesTheModule()
    {
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { StatusError = Rolled };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("not-applied", result["writeState"]!.ToString());
        Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
        Assert.True(result["closed"]!.GetValue<bool>());
        Assert.Equal(RollbackProof.KernelReason, result["merge"]!["reason"]!.ToString());
        Assert.True(result["merge"]!["rolledBack"]!.GetValue<bool>());
        Assert.Equal(1, bridge.Merges);
        Assert.Null(scope.Owner(bridge.Environment));
        // Closed: never replayed.
        Assert.Throws<InvalidOperationException>(() => Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, result["taskId"]!.ToString()), Apply));
        Assert.Equal(1, bridge.Merges);
    }

    [Fact]
    public void UnknownMergeWithADifferentLiveHashStaysUnknownAndKeepsTheReservation()
    {
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { StatusError = Rolled, LiveEqualsBase = false };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.Equal("unknown", result["writeState"]!.ToString());
        Assert.Contains("unknown", result["error"]!.ToString());
        Assert.Null(result["closed"]);
        Assert.False(result["reconcileProof"]!["equal"]!.GetValue<bool>());
        Assert.Equal(result["taskId"]!.ToString(), scope.Owner(bridge.Environment));
        Assert.Equal(1, bridge.Merges);
    }

    [Fact]
    public void AJournalWithoutTheFailureNeverAllowsTheHashProof()
    {
        // No error in the journal: the merge may still be running (or queued); the module is never captured as proof.
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { StatusError = null };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.Equal("unknown", result["writeState"]!.ToString());
        Assert.Equal(1, bridge.Snapshots);   // only the base
        Assert.False(RollbackProof.KernelProofApplies(new JsonObject { ["state"] = "unknown" }));   // no record at all
        Assert.False(RollbackProof.KernelProofApplies(new JsonObject { ["state"] = "unknown", ["binding"] = new JsonObject(), ["error"] = "x", ["receipt"] = new JsonObject() }));
    }

    [Fact]
    public void TheReconcileOfAResumedTaskUsesTheSameProof()
    {
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { StatusError = Rolled, StatusUnavailable = true };
        var first = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.Equal("unknown", first["writeState"]!.ToString());
        bridge.StatusUnavailable = false;
        var resumed = Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString()), (_, _, _) => throw new Exception("must not apply again"));
        Assert.Equal("not-applied", resumed["writeState"]!.ToString());
        Assert.True(resumed["closed"]!.GetValue<bool>());
        Assert.Equal(1, bridge.Merges);
        Assert.Null(scope.Owner(bridge.Environment));
    }

    [Fact]
    public void TheBridgesOwnRollbackReceiptClosesTheTaskInTheSameCall()
    {
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { MergeReply = new JsonObject { ["merged"] = false, ["reason"] = "rolled back", ["rolledBack"] = true,
            ["liveSha256"] = "ab", ["baseSha256"] = "ab", ["error"] = Rolled } };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.Equal("not-applied", result["writeState"]!.ToString());
        Assert.Equal(Delivery.MergeRolledBackCode, result["code"]!.ToString());
        Assert.True(result["closed"]!.GetValue<bool>());
        Assert.Contains("Nothing was applied", result["error"]!.ToString());
        Assert.Null(scope.Owner(bridge.Environment));
        Assert.DoesNotContain("merge_status", bridge.Calls);
    }

    [Fact]
    public void CloseOfAnUncertainTaskClosesWithTheProofAndRefusesWithout()
    {
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { StatusError = null };   // stays unknown in the delivery itself
        var first = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        var id = first["taskId"]!.ToString();
        Assert.Equal("unknown", first["writeState"]!.ToString());

        bridge.LiveEqualsBase = false;
        var differs = Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(work, id, "corrected job", bridge));
        Assert.Contains("differs", differs.Message);
        Assert.Equal(id, scope.Owner(bridge.Environment));

        bridge.LiveEqualsBase = true;
        var closed = DeliveryTask.CloseKnownFailure(work, id, "corrected job", bridge);
        Assert.True(closed["closed"]!.GetValue<bool>());
        Assert.Equal("not-applied", closed["writeState"]!.ToString());
        Assert.True(closed["closeProof"]!["equal"]!.GetValue<bool>());
        Assert.Null(scope.Owner(bridge.Environment));
        Assert.Equal(1, bridge.Merges);
    }

    [Fact]
    public void CloseRefusesAnUncertainTaskTheJournalKnowsAsApplied()
    {
        using var scope = new AuthorityScope();
        var (work, job) = Job();
        var bridge = new Bridge { StatusError = null };
        var first = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        bridge.StatusApplied = true;
        Assert.Contains("resume", Assert.Throws<InvalidOperationException>(() => DeliveryTask.CloseKnownFailure(work, first["taskId"]!.ToString(), "x", bridge)).Message);
    }

    [Fact]
    public void BridgeRollbackProofIsPureAndOnlyProvesEqualModules()
    {
        var bytes = Encoding.UTF8.GetBytes("module");
        var sha = MergeRollbackProof.Sha256Hex(bytes);
        var upper = Convert.ToHexString(SHA256.HashData(bytes));   // the journal's baseHash is upper case
        var byHash = MergeRollbackProof.Receipt("op", sha, upper, null, "boom")!;
        Assert.False(byHash["merged"]!.GetValue<bool>());
        Assert.Equal("rolled back", byHash["reason"]!.ToString());
        Assert.True(byHash["rolledBack"]!.GetValue<bool>());
        Assert.Equal("sha256", byHash["proof"]!.ToString());
        Assert.Equal("match-tree", MergeRollbackProof.Receipt("op", "aa", "bb", true, "boom")!["proof"]!.ToString());
        Assert.Null(MergeRollbackProof.Receipt("op", "aa", "bb", false, "boom"));
        Assert.Null(MergeRollbackProof.Receipt("op", "aa", "bb", null, "boom"));
        Assert.Null(MergeRollbackProof.Receipt("op", null, null, null, "boom"));
        var seen = new List<string>();
        MergeRollbackProof.AddSeen(seen, new JsonArray(new JsonObject { ["kind"] = "login", ["title"] = "Sign in" }, new JsonObject { ["kind"] = "login", ["title"] = "Sign in" }, new JsonObject { ["kind"] = "modal" }));
        Assert.Equal(new[] { "login: Sign in", "modal" }, seen);
    }

    // ---- helpers
    private static JsonObject Apply(string _, string __, string output) { File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; }

    private static (string Work, string Job) Job()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PacoteD1ReconcileTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "pacote-d1-reconcile-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        return (work, job);
    }

    private sealed class AuthorityScope : IDisposable
    {
        private readonly string? before = Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR");
        private readonly string directory = Path.Combine(Path.GetTempPath(), "pacote-d1-authority-" + Guid.NewGuid().ToString("N"));
        public AuthorityScope() => Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", directory);
        public string? Owner(string environment)
        {
            var file = Path.Combine(directory, "reservations", DurableJson.Hash(environment.ToLowerInvariant() + "\nA") + ".json");
            return File.Exists(file) ? DurableJson.Read(file)["owner"]?.ToString() : null;
        }
        public void Dispose() { Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR", Pa2F1TestAuthority.Restore(before)); try { Directory.Delete(directory, true); } catch (IOException) { } }
    }

    private sealed class Bridge : IBridgeClient
    {
        public string Environment { get; } = "lab-" + Guid.NewGuid().ToString("N")[..8] + ".example";
        public bool LiveEqualsBase = true, StatusUnavailable, StatusApplied;
        public string? StatusError;
        public JsonObject? MergeReply;
        public int Merges, Snapshots;
        public List<string> Calls { get; } = [];
        private string? operationId;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A", ["environment"] = Environment };
                case "snapshot_module":
                {
                    var bytes = Encoding.UTF8.GetBytes(Snapshots++ == 0 || LiveEqualsBase ? "module v1" : "module v2 (merged)");
                    File.WriteAllBytes(parameters!["path"]!.ToString(), bytes);
                    return new() { ["key"] = "A", ["snapshot_id"] = "s" + Snapshots, ["sha256"] = MergeRollbackProof.Sha256Hex(bytes) };
                }
                case "merge_from_oml":
                    Merges++; operationId = parameters!["operation_id"]!.ToString();
                    if (MergeReply != null) { var reply = MergeReply.DeepClone().AsObject(); reply["operationId"] = operationId; return reply; }
                    throw new BridgeCallException("InvalidOperationException: boom; merge outcome is unknown, inspect merge_status operation_id=" + operationId, null);
                case "merge_status":
                    if (StatusUnavailable) throw new IOException("bridge not answering");
                    if (StatusApplied) return new() { ["operationId"] = parameters!["operation_id"]!.DeepClone(), ["state"] = "applied", ["binding"] = new JsonObject(), ["receipt"] = new JsonObject { ["merged"] = true } };
                    return new() { ["operationId"] = parameters!["operation_id"]!.DeepClone(), ["state"] = "unknown", ["binding"] = new JsonObject { ["module_key"] = "A" },
                        ["error"] = StatusError };
                case "bridge_manifest": return new() { ["capabilities"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
