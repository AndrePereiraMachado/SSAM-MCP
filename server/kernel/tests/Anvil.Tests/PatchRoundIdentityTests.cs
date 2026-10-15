using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class PatchRoundIdentityTests
{
    [Theory]
    [InlineData("Missing", 1)]
    [InlineData("AnotherMissing", 2)]
    public void NativeChildOrderDoesNotAddAProblemButADifferentMissingChildDoes(string child, int expected)
    {
        JsonObject Problem(string missing, string children) => new() {
            ["code"] = "CHILD_NOT_FOUND", ["op"] = 1, ["pointer"] = "/ops/1/target", ["phase"] = "base",
            ["message"] = $"IServerAction 'Compute' has no child '{missing}' (children: {children})"
        };
        var original = Problem("Missing", "IStartNode, IAssignNode, IEndNode");
        var observed = Problem(child, "IEndNode, IStartNode, IAssignNode");
        var refusal = new JobPreflightException("original refusal", new JsonArray(original)) {
            VerifyRan = true, Phases = ["preflight", "base", "apply", "verify"]
        };
        const BindingFlags fields = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var probeType = typeof(JobRunner).GetNestedType("Probe", BindingFlags.NonPublic)!;
        var probe = Activator.CreateInstance(probeType, true)!;
        probeType.GetField("Dropped", fields)!.SetValue(probe, new HashSet<string>());
        var found = (IList)probeType.GetField("Found", fields)!.GetValue(probe)!;
        found.Add((observed, (string?)null));
        var merge = typeof(JobRunner).GetMethod("Merge", BindingFlags.NonPublic | BindingFlags.Static)!;
        var merged = Assert.IsType<JobPreflightException>(merge.Invoke(null, [refusal, refusal, new List<JsonObject> { original }, probe, "/ops", null]));
        Assert.Equal(expected, merged.Problems.Count);
        if (expected == 1) Assert.Null(merged.Problems[0]!["afterPatch"]);
        else Assert.True(merged.Problems[1]!["afterPatch"]!.GetValue<bool>());
    }
}
