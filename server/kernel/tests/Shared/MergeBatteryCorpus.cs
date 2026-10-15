using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// The batteries of the three-way merge of the logic and data texts over the corpus of the plan (the 34 unique modules of
// tests/fixtures/text-roundtrip/corpus.json): a Studio edit and a model edit of the same read, disjoint and overlapping,
// merged by the op, written and read again (FlowMergeBattery, DdlMergeBattery). Every case must come back exact: disjoint
// edits with both sides and no conflict listed; overlapping edits with the conflict listed by key, the delivery's side kept
// and everything else as the Studio left it, keys preserved. The counts must reach the floors of
// tests/fixtures/text-roundtrip/merge-battery-expected.json. The captures are read only and never copied into the
// repository: without them the test says so and returns.
public static class MergeBatteryCorpus
{
    private static (JsonObject Expected, List<JsonObject> Modules)? Corpus(string lane, string battery, ITestOutputHelper output)
    {
        var root = TextRoundTripCorpus.Root() ?? throw new InvalidOperationException("tests/fixtures/text-roundtrip not found");
        var fixtures = Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip");
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "corpus.json")))!.AsArray();
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "merge-battery-expected.json")))![battery]![lane]!.AsObject();
        var modules = manifest.Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == lane).ToList();
        var missing = modules.Where(m => !File.Exists(m["oml"]!.GetValue<string>())).Select(m => m["oml"]!.GetValue<string>()).ToList();
        if (missing.Count > 0) {
            output.WriteLine("WARNING: the corpus of the plan is not on this machine (" + missing.Count + " of " + modules.Count + " captures missing, first "
                + missing[0] + "); the " + battery + " merge battery did not run.");
            return null;
        }
        return (expected, modules);
    }

    public static void Flow(string lane, Func<ModelHost> host, ITestOutputHelper output)
    {
        if (Corpus(lane, "flow", output) is not var (expected, modules)) return;
        var every = expected["every"]!.GetValue<int>();
        var total = new FlowMergeBattery.Tally();
        foreach (var module in modules) {
            var tally = FlowMergeBattery.Run(host(), File.ReadAllBytes(module["oml"]!.GetValue<string>()), module["label"]!.GetValue<string>(), lane, seed: 1, every: every);
            total.Add(tally);
            output.WriteLine(module["label"] + ": " + tally.Actions + " actions, " + tally.Cases + " cases, " + tally.Exact + " exact (disjoint " + tally.DisjointExact + "/" + tally.Disjoint
                + ", overlapping " + tally.OverlapExact + "/" + tally.Overlap + "), " + Math.Round(tally.Ms / 1000) + " s");
        }
        output.WriteLine(total.ToJson().ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(total.Failures.Count == 0, total.Failures.Count + " merge cases do not read back as expected:\n" + string.Join("\n", total.Failures.Take(20)));
        Assert.Equal(total.Cases, total.Exact);
        Assert.True(total.Disjoint >= expected["minDisjoint"]!.GetValue<int>(), total.Disjoint + " disjoint cases, at least " + expected["minDisjoint"] + " expected");
        Assert.True(total.Overlap >= expected["minOverlap"]!.GetValue<int>(), total.Overlap + " overlapping cases, at least " + expected["minOverlap"] + " expected");
        foreach (var name in FlowMergeBattery.OverlapCases.Concat(FlowMergeBattery.SameNodeCases)) Assert.True(total.ByCase.GetValueOrDefault(name) > 0, "no case " + name);
    }

    public static void Data(string lane, Func<ModelHost> host, ITestOutputHelper output)
    {
        if (Corpus(lane, "ddl", output) is not var (expected, modules)) return;
        var rounds = expected["rounds"]!.GetValue<int>();
        var total = new DdlMergeBattery.Tally();
        foreach (var module in modules) {
            var tally = DdlMergeBattery.Run(host(), module["oml"]!.GetValue<string>(), lane, seed: 1, rounds: rounds, log: output.WriteLine);
            total.Add(tally);
            output.WriteLine(module["label"] + ": " + tally.Cases + " cases, " + tally.Exact + " exact (disjoint " + tally.DisjointExact + "/" + tally.Disjoint
                + ", overlapping " + tally.OverlapExact + "/" + tally.Overlap + "), " + Math.Round(tally.Ms / 1000) + " s");
        }
        output.WriteLine(total.ToJson().ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(total.Failures.Count == 0, total.Failures.Count + " merge cases do not read back as expected:\n" + string.Join("\n", total.Failures.Take(20)));
        Assert.Equal(total.Cases, total.Exact);
        Assert.True(total.Disjoint >= expected["minDisjoint"]!.GetValue<int>(), total.Disjoint + " disjoint cases, at least " + expected["minDisjoint"] + " expected");
        Assert.True(total.Overlap >= expected["minOverlap"]!.GetValue<int>(), total.Overlap + " overlapping cases, at least " + expected["minOverlap"] + " expected");
        // The statements the merge refuses (a read of another module, an element created after the read), refused and nothing
        // of the module changed.
        foreach (var name in DdlMergeBattery.RefusedCases) Assert.True(total.ByCase.GetValueOrDefault(name) > 0, "no case " + name);
        Assert.True(total.Refused >= (expected["minRefused"]?.GetValue<int>() ?? 0), total.Refused + " refused cases, at least " + expected["minRefused"] + " expected");
    }
}
