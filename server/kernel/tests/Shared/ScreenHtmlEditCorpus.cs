using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: the acceptance of C2 of the plan "Texto do SSAM" (section 8). The synthetic edits of every
// Reactive/Mobile screen and block (ScreenHtmlEditBattery: class, text, expression, new child, leaf removal, sibling swap,
// event), each applied by the html op in its edit form on the capture and rolled back (ModelHost.HtmlEditBattery, the same
// path as `anvil html-edit-battery`): the module must read back the edited text, the op's own check must pass (kinds, facts,
// children, the ObjectKey of everything the edit kept) and, after the rollback, the screen reads as before. Over the plan's
// corpus (tests/contracts/screen-html/corpus.json, captures by absolute path, never committed; absent = skipped with a
// warning) with the floor of edits of the manifest ("c2"), and over the committed fixtures (always).
internal static class ScreenHtmlEditCorpus
{
    public static void Fixture(string oml, int minimum, Func<byte[], JsonObject> battery, ITestOutputHelper output)
    {
        var report = battery(File.ReadAllBytes(oml));
        Report(Path.GetFileName(oml), report, output);
        var failures = Failures(report).ToList();
        Assert.True(failures.Count == 0, failures.Count + " edit(s) of " + Path.GetFileName(oml) + " did not read back:\n" + string.Join("\n", failures.Take(20)));
        Assert.True(report["edits"]!.GetValue<int>() >= minimum, report["edits"] + " edits < " + minimum);
        Assert.Equal(0, report["rollbackDiffers"]!.GetValue<int>());
        Assert.Equal(0, report["serializerDiffers"]!.GetValue<int>());
    }

    public static void Check(string manifestFile, string lane, Func<byte[], JsonObject> battery, ITestOutputHelper output)
    {
        var manifest = JsonNode.Parse(File.ReadAllText(manifestFile))!.AsObject();
        var c2 = manifest["c2"]!.AsObject();
        // The plan's floor is over both lanes: the lane floors of the manifest add up to it.
        var floors = c2["minEdits"]!.AsObject();
        Assert.True(floors.Sum(f => f.Value!.GetValue<int>()) >= c2["minEditsTotal"]!.GetValue<int>(), "the lane floors of the manifest are below minEditsTotal");
        var groups = c2["groups"]!.AsArray().Select(g => g!.GetValue<string>()).ToHashSet();
        var modules = manifest["modules"]!.AsArray().Select(m => m!.AsObject())
            .Where(m => m["lane"]!.GetValue<string>() == lane && m["screens"]!.GetValue<bool>() && groups.Contains(m["group"]!.GetValue<string>())).ToList();
        var present = modules.Where(m => File.Exists(m["oml"]!.GetValue<string>())).ToList();
        foreach (var m in modules.Except(present)) output.WriteLine("WARNING: capture absent, module skipped: " + m["label"] + " " + m["oml"]);
        if (present.Count == 0) { output.WriteLine("WARNING: no capture of the " + lane + " corpus on this machine: the C2 battery is skipped."); return; }
        var problems = new List<string>();
        int edits = 0, ok = 0;
        var byKind = new Dictionary<string, (int Edits, int Ok)>();
        foreach (var m in present) {
            var label = m["label"]!.GetValue<string>();
            var bytes = File.ReadAllBytes(m["oml"]!.GetValue<string>());
            if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != m["sha256"]!.GetValue<string>()) { problems.Add(label + ": the capture changed"); continue; }
            JsonObject report;
            try { report = battery(bytes); }
            catch (Exception error) { problems.Add(label + ": the battery failed: " + error.GetBaseException().Message); continue; }
            Report(label, report, output);
            edits += report["edits"]!.GetValue<int>(); ok += report["ok"]!.GetValue<int>();
            foreach (var (kind, counts) in report["kinds"]!.AsObject()) {
                var (e, o) = byKind.GetValueOrDefault(kind);
                byKind[kind] = (e + counts!["edits"]!.GetValue<int>(), o + counts["ok"]!.GetValue<int>());
            }
            problems.AddRange(Failures(report).Select(f => label + "/" + f));
            if (report["rollbackDiffers"]!.GetValue<int>() > 0) problems.Add(label + ": " + report["rollbackDiffers"] + " rollback(s) left another text");
            if (report["serializerDiffers"]!.GetValue<int>() > 0) problems.Add(label + ": the canonical writer differs on " + report["serializerDiffers"] + " root(s)");
        }
        output.WriteLine(lane + " C2 battery: " + ok + "/" + edits + " edits read back; " + string.Join(", ", byKind.Select(k => k.Key + " " + k.Value.Ok + "/" + k.Value.Edits)));
        if (present.Count == modules.Count && c2["minEdits"]?[lane] is JsonValue floor && edits < floor.GetValue<int>())
            problems.Add(lane + ": " + edits + " edits < the floor " + floor);
        Assert.True(problems.Count == 0, problems.Count + " problem(s):\n" + string.Join("\n", problems.Take(40)));
    }

    private static IEnumerable<string> Failures(JsonObject report) =>
        report["rows"]!.AsArray().Select(r => r!.AsObject()).Where(r => r["outcome"]!.GetValue<string>() != "ok")
            .Select(r => r["root"] + " " + r["kind"] + " (" + r["note"] + "): " + r["outcome"] + " " + r["detail"]);

    private static void Report(string label, JsonObject report, ITestOutputHelper output) =>
        output.WriteLine(label + ": " + report["ok"] + "/" + report["edits"] + " edits over " + report["roots"] + " roots, p50 " + report["p50Ms"] + " ms, p90 " + report["p90Ms"]
            + " ms, total " + report["totalMs"] + " ms");
}
