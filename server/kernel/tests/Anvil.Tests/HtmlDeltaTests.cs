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

    /// <summary>H4-H14 of docs/PROTOTIPO-NATIVO.md through the Verify: a page with the nine constructions the 2026-10-10 session
    /// was refused for (an @import, a repeated key, a call to a screen action a later logic op of the job declares, a clickable
    /// div, tabindex and other attributes, visible on a span and on a row, a static table, a label around a control, an empty
    /// switch with aria-label) is accepted by the Studio's own check, and the logic op fills the screen action in place.</summary>
    [Fact]
    public void APageWithTheNineCausesOfTheRefusalsPassesTheVerifyAndTheLogicOpFillsItsScreenAction()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "nine-causes"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var html = """
            <div class="proto">
              <div class="card" data-av="open" role="button" tabindex="0" aria-label="Abrir o item"><span class="title">Item</span></div>
              <button class="switch" role="switch" aria-label="Ativar o item" data-av="toggle"></button>
              <table class="data-table"><thead><tr><th>Pedido</th></tr></thead><tbody><tr data-av="row"><td>1003</td></tr></tbody></table>
              <span class="badge" data-av="badge">Novo</span>
              <label class="field"><span>Nome</span><div id="NameMount" class="mount"></div></label>
              <p><span class="pill" data-av="shared">a</span><span class="pill" data-av="shared">b</span></p>
              <span name="quantity" min="1" max="9" step="1">x</span>
            </div>
            """;
        var job = new JsonObject
        {
            ["base"] = "reactive-ui.oml",
            ["ops"] = new JsonArray(
                new JsonObject
                {
                    ["op"] = "html",
                    ["data"] = new JsonObject
                    {
                        ["screen"] = "ProtoPage", ["layout"] = "blank", ["roles"] = new JsonArray("Anonymous"), ["html"] = html,
                        ["css"] = "@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600&display=swap');.proto{display:grid}.card{cursor:pointer}",
                        ["vars"] = JsonNode.Parse("""[{"name":"Selected","type":"Integer","default":"0"},{"name":"ShowBadge","type":"Boolean","default":"True"}]"""),
                        ["bindings"] = JsonNode.Parse("""
                            {"open":{"kind":"call","action":"Abrir","args":{"Id":"1"}},"toggle":{"kind":"call","action":"Abrir","args":{"Id":"2"}},
                             "row":{"kind":"visible","condition":"Selected >= 0"},"badge":{"kind":"visible","condition":"ShowBadge"},
                             "shared":{"kind":"class","value":"If(Selected = 1, \"on\", \"\")"}}
                            """),
                    },
                },
                JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"Abrir","kind":"screen","owner":"IMobileScreen:ProtoPage","inputs":[{"name":"Id","type":"Integer"}],"steps":[{"assign":{"Selected":"Id"}}]}]}}"""),
                JsonNode.Parse("""{"op":"create","parent":"IContainer:NameMount","type":"IExpression","as":"$mounted"}"""),
                JsonNode.Parse("""{"op":"set","target":"$mounted","prop":"Value","value":"\"montado\""}""")),
        };
        var jobPath = Path.Combine(dir, "nine-causes.json"); File.WriteAllText(jobPath, job.ToJsonString());
        var result = Run(host, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), jobPath, Path.Combine(dir, "nine-causes.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var results = result["results"]!.AsArray();
        var page = results[0]!["result"]!.AsObject();
        Assert.Equal(1, page["sameJobScreenActions"]![0]!["filledBy"]!.GetValue<int>());
        Assert.True(page["stylesheet"]!["installed"]!.GetValue<bool>());
        Assert.Single(page["stylesheet"]!["cssImportsHoisted"]!.AsArray());
        var logic = results[1]!["result"]!.AsObject();
        Assert.True(logic["replacements"]![0]!["identityRetained"]!.GetValue<bool>(), logic.ToJsonString());
        var styleSheet = ThemeStyleSheet(host, Path.Combine(dir, "nine-causes.oml"), dir);
        // the @import is the first statement of the theme (only comments before it), once
        var imports = CssCompat.Imports(styleSheet).Imports;
        Assert.Single(imports);
        Assert.False(imports[0].AfterRule, styleSheet[..Math.Min(300, styleSheet.Length)]);
        Assert.StartsWith("@import url('https://fonts.googleapis.com/css2?family=Manrope", imports[0].Statement);
    }

    /// <summary>4.3 item 2 of docs/PROTOTIPO-NATIVO.md: the theme block of a fragment is keyed by its owner and its class, so the
    /// same class in two screens is two blocks; a legacy block keyed by the class alone is adopted once (renamed, content
    /// replaced), never copied; the @import of both fragments lands once at the top of the theme.</summary>
    [Fact]
    public void TheSameClassInTwoScreensIsTwoThemeBlocksAndALegacyBlockIsAdoptedOnce()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "theme-blocks"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        const string fragment = "<style>@import url('https://fonts.example.test/a.css'); .card { color: #123456; }</style><div class=\"card\"><span>x</span></div>";
        var ops = new JsonArray(JsonNode.Parse("""{"op":"set","target":"IMobileTheme:Headless_UI","prop":"StyleSheet","value":".keep { color: red; }\n/* anvil:html card */\n.card .old { color: blue; }\n/* /anvil:html card */\n"}"""));
        foreach (var screen in new[] { "ThemeA", "ThemeB" })
        {
            ops.Add(JsonNode.Parse($$"""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"{{screen}}","as":"${{screen}}"}"""));
            ops.Add(JsonNode.Parse($$"""{"op":"set","target":"${{screen}}/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"}"""));
            ops.Add(new JsonObject { ["op"] = "html", ["parent"] = "$" + screen, ["html"] = fragment });
        }
        var jobPath = Path.Combine(dir, "theme-blocks.json");
        File.WriteAllText(jobPath, new JsonObject { ["base"] = "reactive-ui.oml", ["expectValid"] = true, ["ops"] = ops }.ToJsonString());
        var result = Run(host, Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), jobPath, Path.Combine(dir, "theme-blocks.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var first = result["results"]!.AsArray()[3]!["result"]!["css"]!.AsObject();
        Assert.Equal("/* anvil:html ThemeA:card */", first["adoptedLegacy"]!["to"]!.ToString());
        Assert.Null(result["results"]!.AsArray()[6]!["result"]!["css"]!["adoptedLegacy"]);
        var styleSheet = ThemeStyleSheet(host, Path.Combine(dir, "theme-blocks.oml"), dir);
        Assert.Equal(1, Occurrences(styleSheet, "/* anvil:html ThemeA:card */"));
        Assert.Equal(1, Occurrences(styleSheet, "/* anvil:html ThemeB:card */"));
        Assert.Equal(0, Occurrences(styleSheet, "/* anvil:html card */"));
        Assert.DoesNotContain(".old", styleSheet);
        Assert.Contains(".keep", styleSheet);
        Assert.Equal(1, Occurrences(styleSheet, "@import url('https://fonts.example.test/a.css');"));
        Assert.All(CssCompat.Imports(styleSheet).Imports, i => Assert.False(i.AfterRule, styleSheet));
        Assert.StartsWith("@import url('https://fonts.example.test/a.css');", styleSheet.TrimStart());
    }

    private static string ThemeStyleSheet(ModelHost host, string oml, string dir)
    {
        var job = Path.Combine(dir, "theme-get.json");
        File.WriteAllText(job, """{"ops":[{"op":"get","target":"IMobileTheme:Headless_UI"}]}""");
        var theme = Run(host, oml, job, Path.Combine(dir, "theme-get.oml"))["results"]!.AsArray()[0]!["result"]!;
        // The author half (UserStyleSheet when the theme has Theme Editor CSS): the one the html op writes (ThemeCss).
        return theme["UserStyleSheet"]?.ToString() ?? theme["properties"]?["UserStyleSheet"]?.ToString()
            ?? theme["StyleSheet"]?.ToString() ?? theme["properties"]?["StyleSheet"]?.ToString() ?? throw new InvalidOperationException("theme get has no StyleSheet");
    }

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
