using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class DeliveryResumeTests
{
    private static string Work()
    {
        var root = Anvil.Core.JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryResumeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "delivery-resume-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); return work;
    }

    [Theory]
    [InlineData("missing-check")]
    [InlineData("verify-exception")]
    [InlineData("proof-failure")]
    [InlineData("lost-response")]
    public void PostMergeFailureResumesOriginalProofWithoutRepeatingCreation(string failure)
    {
        var work = Work(); var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        var bridge = new Bridge { Failure = failure }; var applies = 0; var proofs = 0;
        JsonObject Apply(string _, string __, string output)
        {
            applies++; File.WriteAllText(output, "foreign");
            return new() { ["isValid"] = true, ["accepted"] = true, ["dataContract"] = new JsonObject {
                ["accepted"] = true, ["assertions"] = new JsonArray(new JsonObject { ["key"] = "field", ["property"] = "Length", ["expected"] = "2000000" }) } };
        }
        JsonObject Proof(string _, JsonArray assertions)
        {
            proofs++; Assert.Single(assertions);
            return new() { ["accepted"] = bridge.Failure != "proof-failure", ["count"] = 1 };
        }
        var first = Delivery.Run(bridge, new("Probe", job, work, new[] { "First", "Second" }), Apply, inspectData: Proof);
        Assert.False(first["delivered"]!.GetValue<bool>());
        Assert.Equal(failure == "lost-response" ? "unknown" : "applied", first["writeState"]!.ToString());
        if (failure != "lost-response") { Assert.Equal(1, proofs); Assert.Equal(2, bridge.Finds); }
        bridge.Failure = null;
        var request = DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString());
        var resumed = Delivery.Run(bridge, request, Apply, inspectData: Proof);
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
        Assert.Equal(first["taskId"]!.ToString(), resumed["taskId"]!.ToString());
        Assert.Equal(1, applies); Assert.Equal(1, bridge.Merges);
        Assert.True(DeliveryReceipt.Check(Path.Combine(resumed["work"]!.ToString(), "result.json"))["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void UnknownOutcomeDoesNotReplayAndRequestCannotBeWeakened()
    {
        var work = Work(); var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        var bridge = new Bridge { Failure = "lost-response", UnknownStatus = true };
        JsonObject Apply(string _, string __, string output) { File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; }
        var first = Delivery.Run(bridge, new("Probe", job, work, new[] { "Required" }), Apply);
        var request = DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString());
        var resumed = Delivery.Run(bridge, request, (_, _, _) => throw new Exception("must not apply again"));
        Assert.False(resumed["delivered"]!.GetValue<bool>()); Assert.Equal(1, bridge.Merges);
        Assert.Contains("unknown", resumed["error"]!.ToString());
        Assert.Throws<InvalidOperationException>(() => Delivery.Run(bridge, request with { Checks = Array.Empty<string>() }, Apply));
    }

    [Fact]
    public void MergeJournalRetainsAppliedFactBeforeLaterFailureAndRejectsChangedPayload()
    {
        var work = Work(); var id = Guid.NewGuid().ToString("N");
        var binding = new JsonObject { ["module_key"] = "A", ["foreignHash"] = "bytes-1" };
        using (var operation = new MergeJournal(work).Begin(id, binding))
        {
            Assert.True(operation.IsNew);
            operation.Record(new JsonObject { ["merged"] = true });
            operation.Failure("Verify threw after mutation");
        }
        var restarted = new MergeJournal(work);
        Assert.Equal("applied", restarted.Status(id, "A")["state"]!.ToString());
        using (var replay = restarted.Begin(id, binding)) Assert.False(replay.IsNew);
        Assert.Throws<InvalidOperationException>(() => restarted.Begin(id, new JsonObject { ["module_key"] = "A", ["foreignHash"] = "bytes-2" }));
        Assert.Throws<InvalidOperationException>(() => restarted.Status(id, "B"));
    }

    [Fact]
    public void InterruptedJournalEntryStaysUnknownAndConcurrentCallCannotAcquireIt()
    {
        var work = Work(); var journal = new MergeJournal(work); var id = Guid.NewGuid().ToString("N");
        var binding = new JsonObject { ["module_key"] = "A" };
        using (journal.Begin(id, binding))
            Assert.Throws<InvalidOperationException>(() => journal.Begin(id, binding));
        using var resumed = new MergeJournal(work).Begin(id, binding);
        Assert.False(resumed.IsNew); Assert.Equal("unknown", resumed.State["state"]!.ToString());
    }

    [Fact]
    public void IncrementalRepairRetainsAppliedAttemptAndCompletedTasksNeverRepairAutomatically()
    {
        var work = Work(); var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        var bridge = new Bridge(); var applies = 0; var inspections = 0;
        var specification = JsonNode.Parse("""{"entities":[{"name":"Entry","attributes":[{"name":"Title","type":"Text"}]}]}""")!.AsObject();
        JsonObject Apply(string _, string __, string output) { applies++; File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; }
        JsonObject Inspect(string _, JsonObject __, JsonObject? types)
        {
            var fail = ++inspections == 2;
            return new() { ["accepted"] = !fail, ["count"] = 1, ["expectedTypes"] = types?.DeepClone() ?? new JsonObject(),
                ["assertions"] = new JsonArray(new JsonObject { ["key"] = "field", ["property"] = "Name", ["expected"] = "Title" }),
                ["differences"] = fail ? new JsonArray(new JsonObject { ["element"] = "Entry/Title", ["actual"] = "missing" }) : new JsonArray() };
        }
        var first = Delivery.Run(bridge, new("Probe", job, work, Array.Empty<string>(), Specification: specification), Apply, inspectSpecification: Inspect);
        var id = first["taskId"]!.ToString();
        Assert.False(first["delivered"]!.GetValue<bool>());
        Assert.True(DeliveryTask.PrepareRepair(work, id));
        var repaired = Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, id), Apply, inspectSpecification: Inspect);
        Assert.True(repaired["delivered"]!.GetValue<bool>()); Assert.Equal(2, applies); Assert.Equal(2, bridge.Merges);
        Assert.Single(repaired["attempts"]!.AsArray());
        Assert.True(repaired["attempts"]![0]!["merge"]!["merged"]!.GetValue<bool>());
        Assert.True(repaired["hasAppliedWrites"]!.GetValue<bool>());
        Assert.False(DeliveryTask.PrepareRepair(work, id));
    }

    [Fact]
    public void DefinitePreExecutionRefusalCanResumeWithoutBecomingAnUnknownWrite()
    {
        var work = Work(); var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        var bridge = new Bridge { Failure = "not-started" };
        JsonObject Apply(string _, string __, string output) { File.WriteAllText(output, "foreign"); return new() { ["isValid"] = true, ["accepted"] = true }; }
        var first = Delivery.Run(bridge, new("Probe", job, work, Array.Empty<string>()), Apply);
        Assert.Equal("not-sent", first["writeState"]!.ToString());
        bridge.Failure = null;
        var resumed = Delivery.Run(bridge, DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString()), Apply);
        Assert.True(resumed["delivered"]!.GetValue<bool>(), resumed.ToJsonString());
    }

    private sealed class Bridge : IBridgeClient
    {
        public string? Failure; public bool UnknownStatus; public int Merges, Finds;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module": File.WriteAllText(parameters!["path"]!.ToString(), "snapshot"); return new() { ["key"] = "A", ["snapshot_id"] = "base-id" };
                case "merge_from_oml": Merges++; if (Failure == "not-started") throw new Anvil.Core.BridgeCallException("Dialog pending; merge not started", false); if (Failure == "lost-response") throw new IOException("Connection lost after server applied the merge"); return Receipt();
                case "merge_status": return new() { ["state"] = UnknownStatus ? "unknown" : "applied", ["receipt"] = UnknownStatus ? null : Receipt() };
                case "get_errors": if (Failure == "verify-exception") throw new Exception("Verify unavailable"); return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                case "find_element": Finds++; return new() { ["query"] = parameters!["name"]!.ToString(), ["count"] = Failure == "missing-check" ? 0 : 1 };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
        private static JsonObject Receipt() => new() { ["merged"] = true, ["newErrors"] = 0 };
    }
}
