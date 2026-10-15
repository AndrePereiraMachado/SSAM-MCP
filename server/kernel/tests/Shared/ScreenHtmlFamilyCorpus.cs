using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: the families of the owner's session of 2026-10-12 (inline svg, images by URL, the whitespace
// beside inline elements, attributes with bindings, inline decimals, the Popup's Transition) over every Reactive/Mobile module of
// the plan's corpus (tests/contracts/screen-html/corpus.json, captures by absolute path, never committed; absent = skipped with a
// warning), by ModelHost.HtmlFamilyBattery: each family appended to a container of every screen and block by the edit form (rolled
// back) and one new screen with every family by the document form; the module must read back each family's native construct and
// the reading of it must be a fixed point. Every case must pass; each family has its floor of cases per lane.
internal static class ScreenHtmlFamilyCorpus
{
    public static void Check(string manifestFile, string lane, Func<byte[], JsonObject> battery, int minPerFamily, ITestOutputHelper output)
    {
        var manifest = JsonNode.Parse(File.ReadAllText(manifestFile))!.AsObject();
        var modules = manifest["modules"]!.AsArray().Select(m => m!.AsObject())
            .Where(m => m["lane"]!.GetValue<string>() == lane && m["screens"]!.GetValue<bool>()).ToList();
        var present = modules.Where(m => File.Exists(m["oml"]!.GetValue<string>())).ToList();
        foreach (var m in modules.Except(present)) output.WriteLine("WARNING: capture absent, module skipped: " + m["label"] + " " + m["oml"]);
        if (present.Count == 0) { output.WriteLine("WARNING: no capture of the " + lane + " corpus on this machine: the family battery is skipped."); return; }
        var problems = new List<string>();
        var totals = new Dictionary<string, (int Cases, int Ok)>(StringComparer.Ordinal);
        foreach (var m in present)
        {
            var label = m["label"]!.GetValue<string>();
            var bytes = File.ReadAllBytes(m["oml"]!.GetValue<string>());
            if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != m["sha256"]!.GetValue<string>()) { problems.Add(label + ": the capture changed"); continue; }
            JsonObject report;
            try { report = battery(bytes); }
            catch (Exception error) { problems.Add(label + ": the family battery failed: " + error.GetBaseException().Message); continue; }
            Collect(label, report, totals, problems, output);
        }
        output.WriteLine(lane + " families: " + string.Join(", ", totals.Select(t => t.Key + " " + t.Value.Ok + "/" + t.Value.Cases)));
        if (present.Count == modules.Count)
            foreach (var family in Anvil.Core.ModelHost.HtmlFamilies.Select(f => "edit/" + f.Family))
                if (totals.GetValueOrDefault(family).Cases < minPerFamily) problems.Add(lane + ": " + family + " has " + totals.GetValueOrDefault(family).Cases + " cases < " + minPerFamily);
        Assert.True(problems.Count == 0, problems.Count + " problem(s):\n" + string.Join("\n", problems.Take(40)));
    }

    public static void Fixture(string oml, Func<byte[], JsonObject> battery, ITestOutputHelper output)
    {
        var totals = new Dictionary<string, (int Cases, int Ok)>(StringComparer.Ordinal);
        var problems = new List<string>();
        Collect(Path.GetFileName(oml), battery(File.ReadAllBytes(oml)), totals, problems, output);
        Assert.True(problems.Count == 0, problems.Count + " problem(s):\n" + string.Join("\n", problems.Take(40)));
        Assert.True(totals.Keys.Count(k => k.StartsWith("edit/", StringComparison.Ordinal)) == Anvil.Core.ModelHost.HtmlFamilies.Length, "a family has no case: " + string.Join(", ", totals.Keys));
        Assert.True(totals.ContainsKey("document"), "the document form has no case");
    }

    private static void Collect(string label, JsonObject report, Dictionary<string, (int Cases, int Ok)> totals, List<string> problems, ITestOutputHelper output)
    {
        output.WriteLine(label + ": " + report["ok"] + "/" + report["cases"] + " cases over " + report["roots"] + " roots, " + report["totalMs"] + " ms");
        foreach (var (family, counts) in report["families"]!.AsObject())
        {
            var (c, o) = totals.GetValueOrDefault(family);
            totals[family] = (c + counts!["cases"]!.GetValue<int>(), o + counts["ok"]!.GetValue<int>());
        }
        foreach (var row in report["rows"]!.AsArray().Select(r => r!.AsObject()).Where(r => r["outcome"]!.GetValue<string>() != "ok"))
            problems.Add(label + "/" + row["root"] + " " + row["form"] + " " + row["family"] + ": " + row["outcome"] + " " + row["detail"]);
    }
}
