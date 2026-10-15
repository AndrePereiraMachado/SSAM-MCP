using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: the screen part of E0 of the plan "Texto do SSAM" (ScreenHtmlCoverageTests) and the
// acceptance of C1. Every screen and block of the plan's corpus (tests/contracts/screen-html/corpus.json: the captures by
// absolute path, never committed) is read as ssam-html/1 by ModelHost.HtmlCheck, the same path as `anvil html-check`:
//   - the fixed point: the text decodes back to exactly what was read, with no problem, and reads again to the same text;
//   - the floors of section 4.2 per group: screens, blocks, the widget census and the widgets the contract represents
//     (not os-opaque);
//   - the acceptance of C1: read p90 per screen with the capture loaded, median size of a screen's text.
// A capture that is absent skips (with a warning) its module and the floors of its group; a capture whose bytes changed
// fails, because the floors are of those bytes. Every problem comes in one failure.
internal static class ScreenHtmlCoverage
{
    public static string Manifest(string kernelRoot) => Path.Combine(kernelRoot, "tests", "contracts", "screen-html", "corpus.json");

    public static void Check(string manifestFile, string lane, Func<byte[], JsonObject> htmlCheck, ITestOutputHelper output)
    {
        var manifest = JsonNode.Parse(File.ReadAllText(manifestFile))!.AsObject();
        var modules = manifest["modules"]!.AsArray().Select(m => m!.AsObject())
            .Where(m => m["lane"]!.GetValue<string>() == lane && m["screens"]!.GetValue<bool>()).ToList();
        var present = modules.Where(m => File.Exists(m["oml"]!.GetValue<string>())).ToList();
        foreach (var m in modules.Except(present)) output.WriteLine("WARNING: capture absent, module skipped: " + m["label"] + " " + m["oml"]);
        if (present.Count == 0) { output.WriteLine("WARNING: no capture of the " + lane + " corpus on this machine: the screen-html corpus test is skipped."); return; }

        var problems = new List<string>();
        var rows = new List<(string Group, string Module, JsonObject Row)>();
        foreach (var m in present) {
            var label = m["label"]!.GetValue<string>();
            var bytes = File.ReadAllBytes(m["oml"]!.GetValue<string>());
            var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (sha256 != m["sha256"]!.GetValue<string>()) { problems.Add(label + ": the capture changed (sha256 " + sha256 + "); the floors are of the corpus bytes"); continue; }
            JsonObject report;
            try { report = htmlCheck(bytes); }
            catch (Exception error) { problems.Add(label + ": html-check failed: " + error.GetBaseException().Message); continue; }
            foreach (var row in report["documents"]!.AsArray().Select(r => r!.AsObject())) {
                rows.Add((m["group"]!.GetValue<string>(), label, row));
                var where = label + "/" + row["kind"] + ":" + row["root"];
                if (row["parseError"] is { } parse && parse.GetValueKind() == System.Text.Json.JsonValueKind.String) problems.Add(where + ": the text does not parse: " + parse);
                if (row["ops"]!.GetValue<int>() > 0) problems.Add(where + ": " + row["ops"] + " difference(s) between the model and its text: " + row["opSamples"]!.ToJsonString());
                if (row["problemCount"]!.GetValue<int>() > 0) problems.Add(where + ": " + row["problemCount"] + " problem(s): " + row["problems"]!.ToJsonString());
                if (!row["deterministic"]!.GetValue<bool>()) problems.Add(where + ": reading it again gives another text");
            }
        }

        var floors = manifest["floors"]!.AsObject();
        var acceptance = manifest["acceptance"]!.AsObject();
        var accepted = acceptance["groups"]!.AsArray().Select(g => g!.GetValue<string>()).ToHashSet();
        foreach (var group in modules.Select(m => m["group"]!.GetValue<string>()).Distinct()) {
            var mine = rows.Where(r => r.Group == group).Select(r => r.Row).ToList();
            int screens = mine.Count(r => r["kind"]!.GetValue<string>().EndsWith("Screen", StringComparison.Ordinal));
            int blocks = mine.Count(r => r["kind"]!.GetValue<string>().EndsWith("Block", StringComparison.Ordinal));
            int widgets = mine.Sum(r => r["widgets"]!.GetValue<int>()), opaque = mine.Sum(r => r["opaqueWidgets"]!.GetValue<int>());
            var read = mine.Select(r => r["readMs"]!.GetValue<double>()).Order().ToList();
            var sizes = mine.Where(r => r["kind"]!.GetValue<string>().EndsWith("Screen", StringComparison.Ordinal)).Select(r => r["bytes"]!.GetValue<int>()).Order().ToList();
            double p90 = read.Count == 0 ? 0 : read[Math.Min(read.Count - 1, (int)(0.9 * read.Count))];
            double median = sizes.Count == 0 ? 0 : sizes.Count % 2 == 1 ? sizes[sizes.Count / 2] : (sizes[sizes.Count / 2 - 1] + sizes[sizes.Count / 2]) / 2.0;
            output.WriteLine(string.Create(CultureInfo.InvariantCulture,
                $"{lane} {group}: modules {rows.Where(r => r.Group == group).Select(r => r.Module).Distinct().Count()}, screens {screens}, blocks {blocks}, widgets {widgets}, opaque {opaque}, represented {widgets - opaque} ({(widgets == 0 ? 100 : 100.0 * (widgets - opaque) / widgets):F2}%), read p90 {p90:F1} ms, screen text median {median} B"));
            if (modules.Any(m => m["group"]!.GetValue<string>() == group && !present.Contains(m))) {
                output.WriteLine("WARNING: " + group + " is incomplete on this machine: its floors are not checked.");
                continue;
            }
            if (floors[group] is JsonObject floor) {
                int Floor(string name) => floor[name]!.GetValue<int>();
                if (screens < Floor("screens")) problems.Add(group + ": " + screens + " screens < floor " + Floor("screens"));
                if (blocks < Floor("blocks")) problems.Add(group + ": " + blocks + " blocks < floor " + Floor("blocks"));
                if (widgets != Floor("widgets")) problems.Add(group + ": " + widgets + " widgets, the census of the plan is " + Floor("widgets"));
                if (widgets - opaque < Floor("represented")) problems.Add(group + ": " + (widgets - opaque) + " widgets represented (not os-opaque) < floor " + Floor("represented"));
            }
            if (accepted.Contains(group)) {
                var p90Max = acceptance["readP90MsMax"]!.GetValue<double>();
                var medianMax = acceptance["screenHtmlMedianBytesMax"]!.GetValue<double>();
                if (p90 > p90Max) problems.Add(group + string.Create(CultureInfo.InvariantCulture, $": read p90 {p90:F1} ms > {p90Max} ms"));
                if (median > medianMax) problems.Add(group + string.Create(CultureInfo.InvariantCulture, $": median screen text {median} B > {medianMax} B"));
            }
        }
        Assert.True(problems.Count == 0, problems.Count + " problem(s):\n" + string.Join("\n", problems.Take(60)));
    }
}
