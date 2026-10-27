using System.Text.Json.Nodes;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: the verdict of an F2 sweep (ModelHost.HtmlRoundTripSweep), with its coverage printed. A case
// that fails is a failure of the test, but for the few named here, each matched exactly (fixture, root, family, kind, property,
// outcome and refusal code: no wildcard, so another failure is never absorbed) and with the reason it is out of F2; they are
// printed as KNOWN and counted. An entry that matches no row fails the test too (an exception that no longer happens goes).
internal static class ScreenHtmlRoundTripReport
{
    internal sealed record Known(string Fixture, string Root, string Family, string Kind, string? Property, string Outcome, string? Code, string Why);

    public static void Check(JsonObject sweep, string name, ITestOutputHelper output, IReadOnlyList<Known>? known = null)
    {
        known ??= [];
        var families = sweep["families"]!.AsObject();
        output.WriteLine(name + ": " + sweep["cases"] + " cases, " + sweep["ok"] + " ok; " + sweep["kinds"] + " kinds, " + sweep["propertiesTested"] + " properties tested, "
            + sweep["propertiesSkipped"] + " skipped; oracle " + sweep["oracle"]?.ToJsonString() + "; traditional roots " + sweep["traditionalRoots"] + "; " + sweep["totalMs"] + " ms");
        foreach (var (family, counts) in families) output.WriteLine("  " + family + ": " + counts!["ok"] + "/" + counts["cases"]);
        var failed = new List<JsonNode>(); var used = new HashSet<Known>();
        foreach (var row in sweep["rows"]!.AsArray()) {
            if (row!["outcome"]!.ToString() == "ok") continue;
            var match = known.FirstOrDefault(k => k.Fixture == name && (k.Root == row["root"]!.ToString() || k.Root == row["rootKey"]?.ToString()) && k.Family == row["family"]!.ToString() && k.Kind == row["kind"]!.ToString()
                && k.Property == row["property"]?.ToString() && k.Outcome == row["outcome"]!.ToString() && k.Code == row["code"]?.ToString());
            if (match != null) { used.Add(match); output.WriteLine("  KNOWN " + row["root"] + " " + row["family"] + " " + row["kind"] + "." + row["property"] + " k=" + row["k"] + " (" + row["outcome"] + ", " + row["code"] + "): " + match.Why); continue; }
            failed.Add(row);
        }
        foreach (var row in failed.Take(40)) output.WriteLine("  FAIL " + row["root"] + " " + row["family"] + " " + row["kind"] + "." + row["property"] + " k=" + row["k"] + " (" + row["outcome"] + ", " + row["code"] + "): " + row["detail"]);
        var stale = known.Where(k => k.Fixture == name && !used.Contains(k)).ToList();
        foreach (var k in stale) output.WriteLine("  STALE known entry (matches no row): " + k);
        output.WriteLine("  known " + used.Count + ", failed " + failed.Count + ", stale " + stale.Count);
        Assert.True(failed.Count == 0, name + ": " + failed.Count + " of " + sweep["cases"] + " round-trip cases failed (first: " + failed.FirstOrDefault()?.ToJsonString() + ")");
        Assert.True(stale.Count == 0, name + ": known entries that match no row: " + string.Join("; ", stale));
    }
}
