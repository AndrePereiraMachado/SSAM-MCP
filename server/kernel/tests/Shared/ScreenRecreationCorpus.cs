using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: the acceptance of B1 of the plan "Texto do SSAM" (the document form of the html op) over
// the plan's corpus (tests/contracts/screen-html/corpus.json, section "recreation"; the captures by absolute path, never
// committed). Every screen of the groups is read by ssam-html/1 and compiled again by the document form in the loaded copy
// without it (ScreenRecreationProof, the same path as `anvil html-recreate --verify`): recreated, the text read again equal
// to the text read before (the keys mapped by k) and no new Verify error. At least minSame of the screens of each group come
// back the same; every other one is one of the known causes listed in the manifest (a new one fails); the median build of a
// page stays under buildMedianMsMax. A capture that is absent skips its module (and the rate of its group) with a warning.
internal static class ScreenRecreationCorpus
{
    public static void Check(string manifestFile, string lane, ModelHost host, ITestOutputHelper output)
    {
        var manifest = JsonNode.Parse(File.ReadAllText(manifestFile))!.AsObject();
        var recreation = manifest["recreation"]!.AsObject();
        var groups = recreation["groups"]!.AsArray().Select(g => g!.GetValue<string>()).ToHashSet();
        var known = recreation["known"]!.AsArray().Select(k => k!.AsObject())
            .ToDictionary(k => k["module"]!.GetValue<string>() + "/" + k["root"]!.GetValue<string>(), k => k["cause"]!.GetValue<string>());
        var modules = manifest["modules"]!.AsArray().Select(m => m!.AsObject())
            .Where(m => m["lane"]!.GetValue<string>() == lane && m["screens"]!.GetValue<bool>() && groups.Contains(m["group"]!.GetValue<string>())).ToList();
        var present = modules.Where(m => File.Exists(m["oml"]!.GetValue<string>())).ToList();
        foreach (var m in modules.Except(present)) output.WriteLine("WARNING: capture absent, module skipped: " + m["label"] + " " + m["oml"]);
        if (present.Count == 0) { output.WriteLine("WARNING: no capture of the " + lane + " corpus on this machine: the recreation test is skipped."); return; }

        var problems = new List<string>();
        var rows = new List<(string Group, string Module, JsonObject Row)>();
        foreach (var m in present)
        {
            var label = m["label"]!.GetValue<string>();
            var bytes = File.ReadAllBytes(m["oml"]!.GetValue<string>());
            if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != m["sha256"]!.GetValue<string>()) { problems.Add(label + ": the capture changed; the corpus is of those bytes"); continue; }
            JsonObject report;
            try { report = ScreenRecreationProof.Run(host, bytes, verify: true); }
            catch (Exception error) { problems.Add(label + ": html-recreate failed: " + error.GetBaseException().Message); continue; }
            foreach (var row in report["rows"]!.AsArray().Select(r => r!.AsObject())) rows.Add((m["group"]!.GetValue<string>(), label, row));
        }

        foreach (var (module, row) in rows.Select(r => (r.Module, r.Row)))
        {
            var where = module + "/" + row["root"];
            var outcome = row["outcome"]!.GetValue<string>();
            if (outcome == "same") { if (known.ContainsKey(where)) output.WriteLine("NOTE: " + where + " comes back the same now; its known cause can leave the manifest"); continue; }
            var detail = outcome + " " + (row["code"]?.ToString() ?? "") + " " + (row["problems"]?.ToJsonString() ?? row["differences"]?.ToJsonString() ?? row["verify"]?.ToJsonString() ?? row["error"]?.ToString() ?? "");
            if (known.TryGetValue(where, out var cause)) output.WriteLine("known: " + where + ": " + cause);
            else problems.Add(where + ": " + detail);
        }
        foreach (var group in modules.Select(m => m["group"]!.GetValue<string>()).Distinct())
        {
            var mine = rows.Where(r => r.Group == group).Select(r => r.Row).ToList();
            var same = mine.Count(r => r["outcome"]!.GetValue<string>() == "same");
            var rate = mine.Count == 0 ? 1.0 : (double)same / mine.Count;
            // The build of the page (documentMs: the compile without the move of the original's actions, which only the proof pays).
            var builds = mine.Where(r => r["documentMs"] != null).Select(r => double.Parse(r["documentMs"]!.ToJsonString(), CultureInfo.InvariantCulture)).Order().ToList();
            var median = builds.Count == 0 ? 0 : builds.Count % 2 == 1 ? builds[builds.Count / 2] : (builds[builds.Count / 2 - 1] + builds[builds.Count / 2]) / 2.0;
            output.WriteLine(string.Create(CultureInfo.InvariantCulture, $"{lane} {group}: screens {mine.Count}, the same {same} ({100 * rate:F1}%), build median {median:F0} ms, p90 {(builds.Count == 0 ? 0 : builds[Math.Min(builds.Count - 1, (int)(0.9 * builds.Count))]):F0} ms"));
            if (modules.Any(m => m["group"]!.GetValue<string>() == group && !present.Contains(m))) { output.WriteLine("WARNING: " + group + " is incomplete on this machine: its rate is not checked."); continue; }
            var min = recreation["minSame"]!.GetValue<double>();
            if (rate < min) problems.Add(group + string.Create(CultureInfo.InvariantCulture, $": {same} of {mine.Count} screens the same ({100 * rate:F1}%) < {100 * min:F0}%"));
            var max = recreation["buildMedianMsMax"]!.GetValue<double>();
            if (median > max) problems.Add(group + string.Create(CultureInfo.InvariantCulture, $": build median {median:F0} ms > {max} ms"));
        }
        Assert.True(problems.Count == 0, string.Join(Environment.NewLine, problems));
    }
}
