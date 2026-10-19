using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class PatchCertaintyArgumentReceiptRevisionTests
{
    [Fact]
    public void TwoMissingArgumentsInTheSameCallFocusTheirParsedTopLevelSlots()
    {
        const string before = "client action Check\n  Probe = ReadValue(Z=\"First=wrong Second=wrong\")\n  end\n";
        var afterFirst = VerifySourceEdits.AddFlowArgument(before, "Probe", "ReadValue", "First", "\"" + new string('x', 210) + "\"")!;
        var after = VerifySourceEdits.AddFlowArgument(afterFirst, "Probe", "ReadValue", "Second", "Trim(\"Second=wrong\")")!;
        var first = VerifySourceEdits.FlowArgumentColumns(before, after, "Probe", "ReadValue", "First");
        var second = VerifySourceEdits.FlowArgumentColumns(before, after, "Probe", "ReadValue", "Second");
        Assert.NotNull(first); Assert.NotNull(second);
        var left = before.Split('\n')[1]; var right = after.Split('\n')[1];
        Assert.Equal(left.IndexOf("Z=", StringComparison.Ordinal) + 1, first!.Value.Before);
        Assert.Equal(first.Value.Before, second!.Value.Before);
        Assert.Equal(right.IndexOf("First=", StringComparison.Ordinal) + 1, first.Value.After);
        Assert.Equal(right.IndexOf("Second=Trim", StringComparison.Ordinal) + 1, second.Value.After);
        Assert.True(second.Value.After - first.Value.After > 160);
    }
    [Theory]
    [InlineData("First", 2)]
    [InlineData("Second", 3)]
    public void FlowCallFocusUsesTheSameUniqueNodeAsTheArgumentEdit(string node, int expected)
    {
        const string text = "client action Check\n  First = ReadValue()\n  Second = ReadValue()\n  end\n";
        var location = VerifySourceEdits.FlowCallLocation(text, node, "ReadValue");
        Assert.NotNull(location); Assert.Equal(expected, location!.Value.Line);
        var corrected = VerifySourceEdits.AddFlowArgument(text, node, "ReadValue", "Reset", "False")!;
        Assert.Contains(node + " = ReadValue(Reset=False)", corrected);
    }

    [Fact]
    public void TwoRequiredDefaultsInOneFlowDiscloseTheirOwnCallLines()
    {
        var lane = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";
        var kernel = Path.Combine(TextRoundTripCorpus.Root()!, "kernel");
        var fixture = Path.Combine(kernel, "tests", "fixtures", lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml");
        var work = Path.Combine(kernel, ".local", "argument-receipt-revision", lane, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = new JsonObject { ["expectValid"] = true, ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
                ["name"] = "ReadValue", ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Reset", ["type"] = "Boolean", ["mandatory"] = true, ["default"] = "False" }),
                ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Boolean" }),
                ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Reset" } }) }) } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
                ["flow"] = "client action CheckValue\n  First = ReadValue()\n  Second = ReadValue()\n  end\n" } }) };
        var path = Path.Combine(work, "job.json"); File.WriteAllText(path, job.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "runtime")), fixture, path, Path.Combine(work, "candidate.oml")))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var applied = result["patchesApplied"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]?.ToString() == "ArgumentRequiredExpression").ToList();
        Assert.Equal(2, applied.Count);
        foreach (var node in new[] { "First", "Second" }) {
            var item = Assert.Single(applied.Where(p => p["from"]!.ToString().Contains(node + " = ReadValue()", StringComparison.Ordinal)));
            Assert.Contains(node + " = ReadValue(Reset=False)", item["to"]!.ToString());
            Assert.DoesNotContain(node == "First" ? "Second =" : "First =", item["from"]!.ToString());
            Assert.NotEqual(item["from"]!.ToString(), item["to"]!.ToString());
        }
    }
}
