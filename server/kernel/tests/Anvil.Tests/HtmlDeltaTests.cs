using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>Fixture proofs of the html op beyond Verify: the CSS lands once in the module theme, scoped under the page root; a
/// second compilation over the existing screen keeps the screen and its variables (same keys), regenerates the presentation
/// without duplicates and replaces the theme block; the generated module merges three-way over the fixture without conflicts.
/// Needs the Service Studio assemblies; skipped without them, like JobTests.</summary>
public class HtmlDeltaTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlDeltaTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? "lane-ss5" : "", "html-delta-tests");

    [Fact]
    public void UpdatingTheExistingDashboardKeepsIdentityStylesheetAndMerges()
    {
        if (!StudioAvailable()) return;
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var fixture = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var first = Path.Combine(Work, "first.oml"); var second = Path.Combine(Work, "second.oml");
        var create = Run(host, null, Path.Combine(Root, "tests", "jobs", "html-dashboard-reactive.json"), first);
        Assert.True(create["accepted"]!.GetValue<bool>(), create["details"]!.ToJsonString());
        var html = create["results"]!.AsArray().Last()!["result"]!.AsObject();
        Assert.Equal("create", html["mode"]!.ToString());
        Assert.True(html["stylesheet"]!["installed"]!.GetValue<bool>(), html["stylesheet"]!.ToJsonString());
        var before = Inspect(host, first);
        Assert.Equal(1, Occurrences(before.StyleSheet, "/* anvil:html Dashboard */"));
        Assert.Contains(".av-dashboard .metric-value {", before.StyleSheet);
        Assert.DoesNotContain("\n.metric-value {", before.StyleSheet);
        Assert.Single(before.Pages);

        var update = Run(host, first, Path.Combine(Work, "update.json"), second, updateJob: true);
        Assert.True(update["accepted"]!.GetValue<bool>(), update["details"]!.ToJsonString());
        var updated = update["results"]!.AsArray().Last()!["result"]!.AsObject();
        Assert.Equal("update", updated["mode"]!.ToString());
        var kept = updated["variables"]!["kept"]!.AsArray().Select(v => v!.ToString()).ToArray();
        foreach (var variable in new[] { "DashboardStartDate", "DashboardEndDate", "SearchText", "Filter_PriorityId", "StatusMax", "LastDatePickerId" }) Assert.Contains(variable, kept);
        Assert.Empty(updated["variables"]!["created"]!.AsArray());
        Assert.Empty(updated["delta"]!["variablesPruned"]!.AsArray());
        Assert.True(updated["delta"]!["removed"]!["widgets"]!.AsArray().Count >= 1, updated["delta"]!.ToJsonString());
        Assert.Equal(4, updated["delta"]!["removed"]!["dataActions"]!.AsArray().Count);
        var after = Inspect(host, second);
        Assert.Equal(before.ScreenKey, after.ScreenKey);
        Assert.Equal(before.StartDateKey, after.StartDateKey);
        Assert.Single(after.Pages);
        Assert.Equal(1, Occurrences(after.StyleSheet, "/* anvil:html Dashboard */"));
        Assert.Equal(before.DataActions, after.DataActions);
        Assert.Equal(before.Widgets, after.Widgets);

        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(fixture), File.ReadAllBytes(first), Path.Combine(Work, "merged.oml"));
        Assert.False(merge.HasConflicts, JsonSerializer.Serialize(merge));
        Assert.True(merge.LocalIsValid, JsonSerializer.Serialize(merge));
        Assert.Equal(merge.ForeignObjects, merge.LocalObjects);
    }

    private sealed record Snapshot(string ScreenKey, string StartDateKey, string StyleSheet, string[] Pages, string[] DataActions, string[] Widgets);

    [Fact]
    public void ReplacementRefusesToDeleteLogicUsedByARetainedLayoutWidget()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "retained-consumer"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var first = Path.Combine(dir, "first.oml");
        var themeFixture = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", "html-dashboard-reactive.json")))!;
        themeFixture["ops"]!.AsArray().Last()!["data"]!["layout"] = "theme";
        var themeJob = Path.Combine(dir, "theme-fixture.json"); File.WriteAllText(themeJob, themeFixture.ToJsonString());
        Run(host, null, themeJob, first);
        var prepare = Path.Combine(dir, "prepare.json");
        File.WriteAllText(prepare, """
            {"ops":[
              {"op":"create","parent":"IMobileScreen:Dashboard/#IMobileBlockInstanceWidget/Title","type":"IButton","name":"RetainedRefresh","as":"$retained"},
              {"op":"set","target":"$retained/OnClick","prop":"Destination","value":"IMobileScreen:Dashboard/RefreshHandler"}
            ]}
            """);
        var withConsumer = Path.Combine(dir, "with-consumer.oml");
        var prepared = Run(host, first, prepare, withConsumer);
        Assert.True(File.Exists(withConsumer), prepared.ToJsonString());
        var updateJob = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", "html-dashboard-update.json")))!;
        updateJob["ops"]!.AsArray().Last()!["data"]!["layout"] = "theme";
        var updatePath = Path.Combine(dir, "update.json"); File.WriteAllText(updatePath, updateJob.ToJsonString());
        var ex = Assert.ThrowsAny<Exception>(() => Run(host, withConsumer, updatePath, Path.Combine(dir, "result.oml")));
        Assert.Contains("retained elements still use it", ex.ToString());
    }

    /// <summary>Reads the proof through the verbs (find/dump/get) so the test needs no OutSystems model types.</summary>
    private static Snapshot Inspect(ModelHost host, string oml)
    {
        var job = Path.Combine(Work, "inspect.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            JsonNode.Parse("""{"op":"find","name":"Dashboard","type":"IMobileScreen"}"""), JsonNode.Parse("""{"op":"find","name":"DashboardStartDate","type":"ILocalVariable"}"""),
            JsonNode.Parse("""{"op":"find","name":"Page","type":"IContainer","max":10}"""), JsonNode.Parse("""{"op":"find","type":"IMobileTheme","max":5}"""),
            JsonNode.Parse("""{"op":"dump","target":"IMobileScreen:Dashboard","depth":4}""")) }.ToJsonString());
        var result = Run(host, oml, job, Path.Combine(Work, "inspect.oml"));
        var results = result["results"]!.AsArray();
        var screen = results[0]!["result"]!.AsArray().Single(); var variable = results[1]!["result"]!.AsArray().Single();
        var pages = results[2]!["result"]!.AsArray().Select(p => p!["key"]!.ToString()).ToArray();
        var theme = results[3]!["result"]!.AsArray().First();
        var themeJob = Path.Combine(Work, "theme.json");
        File.WriteAllText(themeJob, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "@" + theme["key"] }) }.ToJsonString());
        var themeResult = Run(host, oml, themeJob, Path.Combine(Work, "theme.oml"))["results"]!.AsArray()[0]!["result"]!;
        var styleSheet = themeResult["StyleSheet"]?.ToString() ?? themeResult["properties"]?["StyleSheet"]?.ToString() ?? throw new InvalidOperationException("theme get has no StyleSheet: " + themeResult.ToJsonString()[..Math.Min(400, themeResult.ToJsonString().Length)]);
        var dump = results[4]!["result"]!.AsObject();
        var dataActions = dump["children"]!.AsArray().Where(c => c!["type"]?.ToString() == "IDataAction").Select(c => c!["name"]!.ToString()).Order().ToArray();
        var widgets = new List<string>();
        void Walk(JsonObject n) { if (n["type"]?.ToString() is { } t && t != "IExpression" && n["name"]?.ToString() is { Length: > 0 } nm) widgets.Add(t + ":" + nm); foreach (var c in n["children"]?.AsArray() ?? []) Walk(c!.AsObject()); }
        Walk(dump);
        return new Snapshot(screen["key"]!.ToString(), variable["key"]!.ToString(), styleSheet, pages, dataActions, widgets.Order().ToArray());
    }

    private static JsonObject Run(ModelHost host, string? basePath, string jobPath, string outPath, bool updateJob = false)
    {
        if (updateJob)
        {
            // The update job compiles the same page over the module the first job produced (base overridden by the file, not by job:).
            var source = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests", "jobs", "html-dashboard-update.json")))!.AsObject();
            source["base"] = "reactive-ui.oml"; File.WriteAllText(jobPath, source.ToJsonString());
        }
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, outPath))!.AsObject();
    }

    private static int Occurrences(string text, string needle) { var count = 0; var i = 0; while ((i = text.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { count++; i += needle.Length; } return count; }
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
