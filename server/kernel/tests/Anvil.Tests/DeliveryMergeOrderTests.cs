using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The O11 deliver path with the merge order, end to end: Delivery.Run, the real job apply, the real planner, and a bridge
/// whose merge_from_oml is the Service Studio's own MatchTree run headless (MergeProbe.Replay: the same two merges the
/// bridge runs with first_pass_path). Only the Studio process is faked. A bridge without the merge order capability never
/// gets the merge; a second merge that did not merge leaves each lost default named with its repair; one that failed
/// inside the Studio is unknown; a resumed task plans again.
/// </summary>
public class DeliveryMergeOrderTests
{
    private const string Job = """
    {"ops":[
     {"op":"spec","data":{"static":[{"name":"Species","public":true,"records":[{"name":"Dog","id":1},{"name":"Cat","id":2}]},
                                    {"name":"Stage","public":true,"records":[{"name":"Egg","id":1}]}],
       "entities":[{"name":"Pet","public":true,"attributes":[{"name":"Name","type":"Text","length":30},
         {"name":"SpeciesId","type":"Species Identifier","mandatory":true,"default":"Entities.Species.Dog"},
         {"name":"StageId","type":"Stage Identifier","mandatory":true,"default":"Entities.Stage.Egg"}]}]}},
     {"op":"logic","data":{"actions":[{"name":"Adopt","kind":"server","public":true,
       "inputs":[{"name":"SpeciesId","type":"Species Identifier","default":"Entities.Species.Cat"}],"outputs":[{"name":"Out","type":"Species Identifier"}],
       "steps":[{"assign":{"Out":"SpeciesId"}}]}]}}]}
    """;

    [Fact]
    public void ADeliveryWithDefaultsOnNewElementsIsDeliveredAsRequested()
    {
        var (result, bridge, _) = Deliver();
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        Assert.Equal(["Adopt.SpeciesId", "Pet.SpeciesId", "Pet.StageId"], result["mergePlan"]!["deferred"]!.AsArray().Select(d => d!["element"]!.ToString()).Order(StringComparer.Ordinal));
        var merge = bridge.Merges.Single();
        var firstPass = merge["first_pass_path"]!.ToString();
        Assert.Equal(DeliveryReceipt.Hash(firstPass), merge["first_pass_sha256"]!.ToString());
        Assert.Contains(result["artifacts"]!.AsArray(), a => a!["path"]!.ToString() == firstPass);
        Assert.True(result["dataProof"]!["accepted"]!.GetValue<bool>());
        Assert.Null(result["mergeOrder"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ABridgeWithoutTheMergeOrderIsRefusedBeforeTheMergeAndTheSameTaskResumesOnACurrentOne(bool noManifest)
    {
        // A bridge loaded before the merge order would ignore first_pass_path and merge once: the Studio would drop the
        // defaults. It never gets the merge: refused at merge-order, nothing written, the reservation free.
        var (result, bridge, _) = Deliver(b => { b.Capabilities = noManifest ? null : ["publish_log"]; });
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Equal("BRIDGE_OUTDATED", result["code"]!.ToString());
        Assert.Equal("merge-order", result["stage"]!.ToString());
        Assert.Empty(bridge.Merges);
        var error = result["error"]!.ToString();
        Assert.StartsWith("The Service Studio runs a bridge without the merge order (capability merge_from_oml:first_pass): one native merge would drop 3 default value(s)", error);
        foreach (var named in new[] { "Adopt.SpeciesId = Entities.Species.Cat", "Pet.SpeciesId = Entities.Species.Dog", "Pet.StageId = Entities.Stage.Egg" }) Assert.Contains(named, error);
        Assert.Contains("Nothing was merged", error);
        // The current bridge: the same task resumes and is delivered as requested.
        bridge.Capabilities = [Delivery.MergeOrderCapability];
        var resumed = Resume(bridge, result);
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed["error"]?.ToString());
        Assert.Null(resumed["code"]);
        Assert.NotNull(Assert.Single(bridge.Merges)["first_pass_path"]);
    }

    [Fact]
    public void ASecondMergeThatDidNotMergeLeavesTheLostDefaultsNamedWithTheirRepair()
    {
        // A current bridge whose second merge stopped (a conflict): the first merge stays for review and the proof names
        // each lost default with its exact repair and the bridge's reason, never an "old bridge".
        var (result, bridge, host) = Deliver(b => { b.HonorFirstPass = false; b.SecondPass = new JsonObject { ["merged"] = false, ["reason"] = "conflicts" }; });
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("applied", result["writeState"]!.ToString());
        Assert.Single(bridge.Merges);
        var error = result["error"]!.ToString();
        Assert.StartsWith("Merge kept for review: the native merge did not keep 3 default value(s): ", error);
        foreach (var named in new[] { "Adopt.SpeciesId = Entities.Species.Cat", "Pet.SpeciesId = Entities.Species.Dog", "Pet.StageId = Entities.Stage.Egg" }) Assert.Contains(named, error);
        Assert.Contains("nothing else differs", error);
        Assert.Contains("The second native merge did not merge: conflicts.", error);
        Assert.DoesNotContain("predates", error);
        var repair = result["mergeOrder"]!["repair"]!.AsObject();
        Assert.Equal(3, repair["ops"]!.AsArray().Count);
        Assert.All(repair["ops"]!.AsArray(), op => { Assert.Equal("set", op!["op"]!.ToString()); Assert.Equal("DefaultValue", op["prop"]!.ToString()); Assert.StartsWith("@", op["target"]!.ToString()); });
        // The repair is exact: applied to the module as it is now and merged once, it lands every default.
        var dir = Path.Combine(result["work"]!.ToString(), "repair"); Directory.CreateDirectory(dir);
        var repairJob = Path.Combine(dir, "repair.json"); File.WriteAllText(repairJob, repair.ToJsonString());
        var repaired = Path.Combine(dir, "repaired.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, bridge.Live, repairJob, repaired))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        var merged = Path.Combine(dir, "merged.oml");
        var probe = MergeProbe.ThreeWay(host, File.ReadAllBytes(bridge.Live), File.ReadAllBytes(repaired), merged, singlePass: true);
        Assert.Empty(MergeOrderTests.Differences(host, merged, result["artifacts"]!.AsArray()[1]!["path"]!.ToString()));
        Assert.False(probe.HasConflicts);
    }

    [Fact]
    public void ASecondMergeThatFailedInsideTheStudioIsUnknownNeverTheFirstMergeAlone()
    {
        // MergeHandler journals the second merge as started before it runs: the receipt the bridge answers after an exception
        // inside it (verificationError) has merged unknown, so the task is uncertain and nothing is repeated.
        var receipt = new JsonObject { ["merged"] = true, ["result"] = "Merge", ["mergeOrder"] = new JsonObject { ["passes"] = 2 } };
        Assert.True(MergeReceipt.RunsSecondPass(receipt, firstPassHadNoDifferences: false));
        Assert.True(MergeReceipt.BeginSecondPass(receipt));
        var dir = Path.Combine(Path.GetTempPath(), "merge-receipt-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var journal = new MergeJournal(dir); var id = Guid.NewGuid().ToString("N");
        using (var operation = journal.Begin(id, new JsonObject { ["module_key"] = "module" })) operation.Record(receipt);
        Assert.Equal("unknown", journal.Status(id)["state"]!.ToString());
        Assert.Equal("started", journal.Status(id)["receipt"]!["secondPass"]!["state"]!.ToString());
        var (result, bridge, _) = Deliver(b => b.Reply = parameters => { var failed = receipt.DeepClone().AsObject(); failed["verificationError"] = "NullReferenceException in CompareAndMerge"; return failed; });
        Assert.Equal("unknown", result["writeState"]!.ToString());
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("Merge outcome is unknown: NullReferenceException in CompareAndMerge; nothing was repeated. Resume reconciles it through merge_status.", result["error"]!.ToString());
        Assert.Single(bridge.Merges);
        // The receipts the second merge settles: either merge merged -> applied; undo steps count the merges that merged.
        foreach (var (first, second, merged, undo) in new[] { (true, true, true, 2), (true, false, true, 1), (false, true, true, 1) })
        {
            var r = new JsonObject { ["merged"] = first, ["result"] = "Merge" };
            Assert.True(MergeReceipt.RunsSecondPass(r, firstPassHadNoDifferences: !first));
            var firstMerged = MergeReceipt.BeginSecondPass(r);
            MergeReceipt.EndSecondPass(r, new JsonObject { ["merged"] = second, ["result"] = second ? "Merge" : null, ["reason"] = second ? null : "conflicts" }, firstMerged);
            Assert.Equal((merged, undo), (r["merged"]!.GetValue<bool>(), r["undoSteps"]!.GetValue<int>()));
        }
        // A first merge that did not merge (and had differences) never gets a second one.
        Assert.False(MergeReceipt.RunsSecondPass(new JsonObject { ["merged"] = false, ["result"] = "Cancel" }, firstPassHadNoDifferences: false));
    }

    [Fact]
    public void APlanBelongsToItsAttemptAndAResumedTaskPlansAgain()
    {
        // Attempt 0 defers the defaults, then its merge is refused before it executed (writeState back to not-sent). The
        // resumed attempt plans again (here: nothing to defer) and never checks, or blames, the plan of attempt 0.
        var (result, bridge, _) = Deliver(b => b.Reply = _ => throw new BridgeCallException("merge_from_oml: Another merge is running", executed: false));
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Equal(3, result["mergePlan"]!["deferred"]!.AsArray().Count);
        bridge.Reply = null; bridge.Merges.Clear();
        var resumed = Resume(bridge, result, new NoDeferral());
        Assert.Null(resumed["mergePlan"]);
        Assert.Null(Assert.Single(bridge.Merges)["first_pass_path"]);
        Assert.DoesNotContain("predates", resumed["error"]?.ToString() ?? "");
        Assert.DoesNotContain("stale plan", resumed["error"]?.ToString() ?? "");
    }

    /// <summary>A plan with nothing to defer; Missing is never asked of a plan that deferred nothing.</summary>
    private sealed class NoDeferral : IMergePlanner
    {
        public JsonObject Plan(string basePath, string foreignPath, string firstPassPath) => new() { ["rule"] = MergeOrder.Rule, ["deferred"] = new JsonArray(), ["firstPass"] = null };
        public JsonArray Missing(string snapshotPath, JsonArray deferred) => throw new InvalidOperationException("stale plan: Missing asked for " + deferred.Count + " deferred default(s)");
    }

    [Fact]
    public void PredictedContentLossNeverReachesTheLiveMerge()
    {
        var (result, bridge, _) = Deliver(planner: new RejectPreview());
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("MERGE_CONTENT_PREVIEW_REFUSED", result["code"]!.ToString());
        Assert.Equal("not-sent", result["writeState"]!.ToString());
        Assert.Empty(bridge.Merges);
        Assert.False(result["mergeContentPreview"]!["accepted"]!.GetValue<bool>());
    }

    private sealed class RejectPreview : IMergePlanner
    {
        public JsonObject Plan(string baseline, string candidate, string firstPass) => new() {
            ["deferred"] = new JsonArray(), ["contentPreview"] = new JsonObject {
                ["accepted"] = false, ["contentProof"] = new JsonObject { ["accepted"] = false }
            }
        };
        public JsonArray Missing(string snapshot, JsonArray deferred) => throw new InvalidOperationException("No live merge may run");
    }

    [Fact]
    public void ContentLossAfterMergeIsNotDeliveredAndResumeNeverMergesAgain()
    {
        var (result, bridge, _) = Deliver(planner: new RejectContent());
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal("MERGE_CONTENT_MISMATCH", result["code"]!.ToString());
        Assert.Equal("applied", result["writeState"]!.ToString());
        Assert.False(result["contentProof"]!["accepted"]!.GetValue<bool>());
        Assert.Single(bridge.Merges);
        var resumed = Resume(bridge, result, new RejectContent());
        Assert.False(resumed["delivered"]!.GetValue<bool>());
        Assert.Single(bridge.Merges);
    }

    private sealed class RejectContent : IMergePlanner, IMergeContentVerifier
    {
        private readonly MergePlanner planner = new(directory => new ModelHost(Path.Combine(directory, "proof-test")));
        public JsonObject Plan(string baseline, string candidate, string firstPass) => planner.Plan(baseline, candidate, firstPass);
        public JsonArray Missing(string snapshot, JsonArray deferred) => planner.Missing(snapshot, deferred);
        public JsonObject VerifyContent(string expected, string snapshot)
        {
            Assert.True(File.Exists(expected));
            Assert.True(File.Exists(snapshot));
            Assert.NotEqual(expected, snapshot);
            return new() { ["accepted"] = false, ["differences"] = new JsonArray(new JsonObject { ["property"] = "DataSource" }) };
        }
    }

    private static (JsonObject Result, HeadlessBridge Bridge, ModelHost Host) Deliver(Action<HeadlessBridge>? configure = null, IMergePlanner? planner = null)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryMergeOrderTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "delivery-merge-order-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "pet-data-model.json"); File.WriteAllText(job, Job);
        var host = new ModelHost(Path.Combine(work, "model"));
        var live = Path.Combine(work, "live.oml"); File.Copy(Path.Combine(root, "tests", "fixtures", "blank-service.oml"), live);
        var bridge = new HeadlessBridge(host, live, work, job);
        configure?.Invoke(bridge);
        return (Run(bridge, new("Headless_CS", job, work, Array.Empty<string>()), planner), bridge, host);
    }

    private static JsonObject Resume(HeadlessBridge bridge, JsonObject result, IMergePlanner? planner = null)
        => Run(bridge, new("Headless_CS", bridge.Job, bridge.Work, Array.Empty<string>(), TaskId: result["taskId"]!.ToString()), planner);

    private static JsonObject Run(HeadlessBridge bridge, DeliveryRequest request, IMergePlanner? planner = null) => Delivery.Run(bridge, request,
        (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
        inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
        mergePlanner: planner ?? new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model"))));

    /// <summary>The Studio boundary: the open module is a file; merge_from_oml runs the Studio's MatchTree headless.
    /// Capabilities: what bridge_manifest lists (null: a bridge without the verb); HonorFirstPass false merges once, as a
    /// bridge whose second merge did not run (SecondPass is then its receipt); Reply replaces the merge answer.</summary>
    private sealed class HeadlessBridge(ModelHost host, string live, string work, string job) : IBridgeClient
    {
        public string Live { get; } = live;
        public string Work { get; } = work;
        public string Job { get; } = job;
        public string[]? Capabilities { get; set; } = ["publish_log", Delivery.MergeOrderCapability];
        public bool HonorFirstPass { get; set; } = true;
        public JsonObject? SecondPass { get; set; }
        public Func<JsonObject, JsonObject>? Reply { get; set; }
        public List<JsonObject> Merges { get; } = new();
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "bridge_manifest":
                    if (Capabilities == null) throw new BridgeCallException("bridge_manifest: Unknown method: bridge_manifest", executed: false);
                    return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray(Capabilities.Select(c => (JsonNode)c).ToArray()) };
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Headless_CS", ["key"] = "module" };
                case "snapshot_module":
                    File.Copy(Live, parameters!["path"]!.ToString(), true);
                    return new() { ["key"] = "module", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = new JsonArray() };
                case "merge_from_oml":
                    Merges.Add(parameters!.DeepClone().AsObject());
                    if (Reply != null) return Reply(parameters);
                    var path = parameters["first_pass_path"]?.ToString();
                    var twoPasses = path != null;
                    var firstPass = HonorFirstPass && path != null ? File.ReadAllBytes(path) : null;
                    var probe = MergeProbe.Replay(host, File.ReadAllBytes(Live), File.ReadAllBytes(parameters["base_path"]!.ToString()),
                        File.ReadAllBytes(parameters["foreign_path"]!.ToString()), firstPass, Live);
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = probe.HasConflicts, ["newErrors"] = 0,
                        ["mergeOrder"] = twoPasses ? new JsonObject { ["passes"] = 2 } : null,
                        ["secondPass"] = !twoPasses ? null : firstPass != null ? new JsonObject { ["merged"] = true } : SecondPass?.DeepClone() };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["rawMessages"] = new JsonArray() };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }
}
