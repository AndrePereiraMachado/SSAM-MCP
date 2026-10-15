using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// The battery of stage LG2 over the corpus of the plan (C:\Users\andre\SSAM-analises\html-do-ssam\PLANO.md section 8): on
// the 34 unique modules of tests/fixtures/text-roundtrip/corpus.json, one action in every `every` of each module gets one
// edit of each kind it has room for (expression, call, remove, branch, rename, swap: FlowEdits), written back through the
// logic op's text form and read again (FlowBattery), then undone the same way. Every edit and every undo must read back as
// exactly its text, with the keys of what it did not touch; the counts must reach the floor of
// tests/fixtures/text-roundtrip/flow-battery-expected.json. The captures are read only and never copied into the
// repository: without them the test says so and returns.
public static class FlowBatteryCorpus
{
    // expectedKey: the entry of flow-battery-expected.json (the lane by default); kinds: the edit kinds (all of FlowEdits.Kinds by
    // default; ["map"] is the O11 mapping battery, whose remap edits count with it).
    public static void Run(string lane, Func<ModelHost> host, ITestOutputHelper output, string? expectedKey = null, IReadOnlyList<string>? kinds = null)
    {
        var root = TextRoundTripCorpus.Root() ?? throw new InvalidOperationException("tests/fixtures/text-roundtrip not found");
        var fixtures = Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip");
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "corpus.json")))!.AsArray();
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "flow-battery-expected.json")))!["lanes"]![expectedKey ?? lane]!.AsObject();
        var modules = manifest.Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == lane).ToList();
        var missing = modules.Where(m => !File.Exists(m["oml"]!.GetValue<string>())).Select(m => m["oml"]!.GetValue<string>()).ToList();
        if (missing.Count > 0) {
            output.WriteLine("WARNING: the corpus of the plan is not on this machine (" + missing.Count + " of " + modules.Count + " captures missing, first "
                + missing[0] + "); the LG2 battery did not run.");
            return;
        }
        var every = expected["every"]!.GetValue<int>();
        var total = new FlowBattery.Tally();
        foreach (var module in modules) {
            var file = module["oml"]!.GetValue<string>();
            var started = DateTime.UtcNow;
            var tally = FlowBattery.Run(host(), File.ReadAllBytes(file), module["label"]!.GetValue<string>(), seed: 1, every: every, kinds: kinds);
            total.Add(tally);
            output.WriteLine(module["label"] + ": " + tally.Actions + " actions, " + tally.Edits + " edits, " + tally.Exact + " exact, " + tally.Reverts + " undone, "
                + tally.RevertsExact + " exact, " + (DateTime.UtcNow - started).TotalSeconds.ToString("0") + " s");
        }
        var summary = total.ToJson();
        output.WriteLine(summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(total.Failures.Count == 0, total.Failures.Count + " edits do not read back as their text:\n" + string.Join("\n", total.Failures.Take(20)));
        Assert.Equal(total.Edits, total.Exact);
        Assert.Equal(total.Reverts, total.RevertsExact);
        Assert.True(total.Edits >= expected["minEdits"]!.GetValue<int>(), total.Edits + " edits, at least " + expected["minEdits"] + " expected");
        foreach (var kind in kinds ?? FlowEdits.Kinds) Assert.True(total.ByKind.GetValueOrDefault(kind) > 0, "no edit of kind " + kind);
    }

    // The creation battery (FlowCreateBattery): on the same corpus, one owner in every `every` of the screens and blocks that
    // have screen or data actions gets a new action of each of those kinds, born from a text without @key whose header names
    // the owner; every creation must read back as exactly its text, and the counts must reach the floor of the "create"
    // section of flow-battery-expected.json.
    public static void RunCreate(string lane, Func<ModelHost> host, ITestOutputHelper output)
    {
        var root = TextRoundTripCorpus.Root() ?? throw new InvalidOperationException("tests/fixtures/text-roundtrip not found");
        var fixtures = Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip");
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "corpus.json")))!.AsArray();
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "flow-battery-expected.json")))!["create"]![lane]!.AsObject();
        var modules = manifest.Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == lane).ToList();
        var missing = modules.Where(m => !File.Exists(m["oml"]!.GetValue<string>())).Select(m => m["oml"]!.GetValue<string>()).ToList();
        if (missing.Count > 0) {
            output.WriteLine("WARNING: the corpus of the plan is not on this machine (" + missing.Count + " of " + modules.Count + " captures missing, first "
                + missing[0] + "); the creation battery did not run.");
            return;
        }
        var every = expected["every"]!.GetValue<int>();
        var total = new FlowCreateBattery.Tally();
        // FLOW_BATTERY_MODULES=<label,label>: only those modules (a failure looked at again; the floors are not checked).
        var only = Environment.GetEnvironmentVariable("FLOW_BATTERY_MODULES") is { Length: > 0 } list ? list.Split(',', StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase) : null;
        if (only != null) modules = modules.Where(m => only.Contains(m["label"]!.GetValue<string>())).ToList();
        foreach (var module in modules) {
            var started = DateTime.UtcNow;
            var tally = FlowCreateBattery.Run(host(), File.ReadAllBytes(module["oml"]!.GetValue<string>()), module["label"]!.GetValue<string>(), seed: 1, every: every);
            total.Add(tally);
            output.WriteLine(module["label"] + ": " + tally.Owners + " owners, " + tally.Created + " created, " + tally.Exact + " exact, " + tally.Skipped + " skipped, "
                + (DateTime.UtcNow - started).TotalSeconds.ToString("0") + " s");
        }
        output.WriteLine(total.ToJson().ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(total.Failures.Count == 0, total.Failures.Count + " creations do not read back as their text:\n" + string.Join("\n", total.Failures.Take(20)));
        Assert.Equal(total.Created, total.Exact);
        if (only != null) return;
        foreach (var (kind, floor) in expected["minCreated"]!.AsObject())
            Assert.True(total.ByKind.GetValueOrDefault(kind) >= floor!.GetValue<int>(), kind + ": " + total.ByKind.GetValueOrDefault(kind) + " created, at least " + floor + " expected");
    }

    // An owner whose every screen action runs a JavaScript (each template refused new: decision 6) is created through the
    // refusal's verified patch (the script moved into a client action of its own), and the action and the client action read
    // back as their texts: the owner is not lost to the rule (the third junction lost 5 O11 owners and 1 ODC owner, below the
    // creation floors). One module of the corpus.
    public static void RunCreatePatched(string label, Func<ModelHost> host, ITestOutputHelper output)
    {
        var root = TextRoundTripCorpus.Root() ?? throw new InvalidOperationException("tests/fixtures/text-roundtrip not found");
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray();
        var module = manifest.Select(m => m!.AsObject()).Single(m => m["label"]!.GetValue<string>() == label);
        if (!File.Exists(module["oml"]!.GetValue<string>())) { output.WriteLine("WARNING: " + label + " is not on this machine; the creation battery did not run."); return; }
        var tally = FlowCreateBattery.Run(host(), File.ReadAllBytes(module["oml"]!.GetValue<string>()), label, seed: 1, every: 1);
        output.WriteLine(tally.ToJson().ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(tally.Failures.Count == 0, string.Join("\n", tally.Failures.Take(10)));
        Assert.Equal(tally.Created, tally.Exact);
        Assert.True(tally.Rules.GetValueOrDefault("patched FLOW_JAVASCRIPT_NOT_ISOLATED") > 0, tally.ToJson().ToJsonString());
        Assert.Equal(0, tally.Skipped);
    }
}
