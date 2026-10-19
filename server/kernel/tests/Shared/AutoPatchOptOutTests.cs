using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class AutoPatchOptOutTests
{
    [Fact]
    public void CommandPolicyIsOptionalAndRejectsUnrecognizedValues()
    {
        Assert.Null(DeliverArguments.AutoPatch(["apply"]));
        Assert.False(DeliverArguments.AutoPatch(["apply", "--auto-patch", "off"]));
        Assert.True(DeliverArguments.AutoPatch(["apply", "--auto-patch", "on"]));
        Assert.Throws<ArgumentException>(() => DeliverArguments.AutoPatch(["apply", "--auto-patch"]));
        Assert.Throws<ArgumentException>(() => DeliverArguments.AutoPatch(["apply", "--auto-patch", "false"]));
        Assert.Throws<ArgumentException>(() => DeliverArguments.AutoPatch(["apply", "--auto-patch", "--job"]));
    }

    [Fact]
    public void NestedPolicyScopeRestoresAfterFailure()
    {
        var previous = JobPreflight.AutoPatch.Value;
        using (JobPreflight.UseAutoPatch(true))
        {
            Assert.Throws<InvalidOperationException>((Action)(() =>
            {
                using var policy = JobPreflight.UseAutoPatch(false);
                Assert.False(JobPreflight.AutoPatch.Value);
                throw new InvalidOperationException("synthetic failure");
            }));
            Assert.True(JobPreflight.AutoPatch.Value);
            using (JobPreflight.UseAutoPatch(null)) Assert.Null(JobPreflight.AutoPatch.Value);
            Assert.True(JobPreflight.AutoPatch.Value);
        }
        Assert.Equal(previous, JobPreflight.AutoPatch.Value);
    }

    [Fact]
    public async Task ParallelExecutionContextsKeepIndependentPolicies()
    {
        using var outer = JobPreflight.UseAutoPatch(true);
        await Task.WhenAll(Task.Run(() =>
        {
            using var policy = JobPreflight.UseAutoPatch(false);
            Assert.False(JobPreflight.AutoPatch.Value);
        }), Task.Run(() => Assert.True(JobPreflight.AutoPatch.Value)));
        Assert.True(JobPreflight.AutoPatch.Value);
    }

    [Fact]
    public void DeliveryRequestRetainsOptOutAcrossResumeAndRestoresCallerPolicy()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(AutoPatchOptOutTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "auto-patch-opt-out", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        var request = DeliverArguments.ForJob(["deliver", "--module", "Probe", "--job", job, "--auto-patch", "off"], work, 4516);
        Assert.False(request.AutoPatch);
        Assert.False(JsonSerializer.SerializeToNode(request)!["AutoPatch"]!.GetValue<bool>());
        Assert.False(JsonSerializer.SerializeToNode(request with { AutoPatch = null })!.AsObject().ContainsKey("AutoPatch"));
        using var caller = JobPreflight.UseAutoPatch(true);
        var first = Delivery.Run(new RefusingBridge(), request, (_, _, _) => throw new Exception("must not apply"));
        Assert.False(first["delivered"]!.GetValue<bool>());
        Assert.True(JobPreflight.AutoPatch.Value);
        var resumed = DeliveryTask.ResumeRequest(work, first["taskId"]!.ToString());
        Assert.False(resumed.AutoPatch);
        DeliverArguments.RequireRecordedAutoPatch(["deliver", "--resume", resumed.TaskId!], resumed);
        DeliverArguments.RequireRecordedAutoPatch(["deliver", "--auto-patch", "off"], resumed);
        Assert.Throws<ArgumentException>(() => DeliverArguments.RequireRecordedAutoPatch(["deliver", "--auto-patch", "on"], resumed));
        Delivery.Run(new RefusingBridge(), resumed, (_, _, _) => throw new Exception("must not apply"));
        Assert.True(JobPreflight.AutoPatch.Value);
    }

    [Theory]
    [InlineData("false")]
    [InlineData("true")]
    public void BooleanJobPolicyHasNoShapeProblem(string value)
        => Assert.Empty(JobDocument.RootShape(JsonNode.Parse("{\"autoPatch\":" + value + "}")));

    [Theory]
    [InlineData("\"false\"")]
    [InlineData("{}")]
    [InlineData("[]")]
    public void InvalidJobPolicyReportsStructuredShapeProblem(string value)
    {
        var job = JsonNode.Parse("{\"ops\":[],\"autoPatch\":" + value + "}")!;
        var result = JobPreflight.Analyze(job["ops"]!.AsArray(), job, []);
        var problem = Assert.Single(result["problems"]!.AsArray().OfType<JsonObject>());
        Assert.Equal(JobDocument.ShapeCode, problem["code"]!.GetValue<string>());
        Assert.Equal("/autoPatch", problem["pointer"]!.GetValue<string>());
        Assert.Null(problem["patchRule"]);
        Assert.False(Anvil.Core.Preflight.PatchCertainty.IsCertain(problem));
    }

    private sealed class RefusingBridge : IBridgeClient
    {
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Assert.False(JobPreflight.AutoPatch.Value);
            Assert.Equal("open_module", method);
            return new() { ["opened"] = false, ["hint"] = "synthetic refusal before snapshot" };
        }
    }
}
