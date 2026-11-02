using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>C-13, C-28 and C-29 (F-FT-02, -04, -15, -16, -17, -21, -27; 27/10): the Traditional dialect was learned from
/// the refusals. 35 and 67 HTML_TRADITIONAL with one long fix (the whole dialect), cut by the answer to "...table-records/
/// list-records with source/lin…"; layout="blank" refused; the aggregates of the Preparation of the same job "named nothing".
/// The dialect is one table (TraditionalDocumentRules.AttributesOf, which Check reads), exported as the card the facade serves
/// (platforms/odc/facade/catalog/traditional-dialect.json); every fix is its tag's own.</summary>
public sealed class TraditionalDialectTests(ITestOutputHelper output)
{
    private static readonly string Kernel = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalDialectTests).Assembly.Location)!)!;
    private static readonly string Card = Path.GetFullPath(Path.Combine(Kernel, "..", "platforms", "odc", "facade", "catalog", "traditional-dialect.json"));

    [Fact]
    public void TheCardTheFacadeServesIsTheAllowlistTheCheckReads()
    {
        var dialect = TraditionalDocumentRules.Dialect();
        var text = dialect.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n";
        if (Environment.GetEnvironmentVariable("SSAM_WRITE_TRADITIONAL_DIALECT") == "1") File.WriteAllText(Card, text);
        Assert.True(File.Exists(Card), Card + " is missing: run this test with SSAM_WRITE_TRADITIONAL_DIALECT=1");
        Assert.Equal(text.Replace("\r\n", "\n"), File.ReadAllText(Card).Replace("\r\n", "\n"));
        // Every attribute the card lists for a tag is one the check takes on it (with the value the language reads).
        foreach (var (tag, row) in dialect["tags"]!.AsObject())
            foreach (var attribute in row!["attributes"]!.AsArray().Select(a => a!.ToString()).Where(a => !a.Contains('<')))
            {
                var element = $"<{tag} {attribute}=\"{Value(tag, attribute)}\"" + (tag == "div" && attribute == "line-separator" ? " list=\"Rows\"" : "")
                    + (attribute is "method" or "validation" ? " onclick=\"Go\"" : "") + (tag == "Block" && attribute != "name" ? " name=\"B\"" : "") + (tag == "expr" && attribute != "value" ? " value=\"1\"" : "")
                    + (tag is "input" or "textarea" or "checkbox-input" or "password-input" or "radio-input" && attribute != "bind" ? " bind=\"X\"" : "") + "/>";
                var problems = TraditionalDocumentRules.Lint("<screen name=\"S\">" + element + "</screen>", out _);
                Assert.DoesNotContain(problems, p => p.Message.Contains("Unsupported Traditional attribute " + attribute, StringComparison.Ordinal));
            }
        Assert.Equal(["Ajax", "Submit", "Navigate"], dialect["method"]!.AsArray().Select(m => m!.ToString()));
        Assert.Contains("blank", dialect["root"]!["layout"]!.AsArray().Select(m => m!.ToString()));
    }

    private static string Value(string tag, string attribute) => attribute switch {
        "method" => "Ajax", "validation" => "None", "line-separator" => "None", "href" => "https://example.test", "onclick" or "onchange" => "Go",
        "if" => "True", "line-count" or "start-index" => "1", _ => "x" };

    [Fact]
    public void EveryFixOfATraditionalProblemIsItsTagsOwnAndWhole()
    {
        var html = "<screen name=\"S\" color=\"red\">\n<video/>\n<div bind=\"X\"/>\n<a onclick=\"Go\" method=\"AjaxSubmit\">x</a>\n<expr/>\n<span onclick=\"Go\">y</span>\n</screen>";
        var problems = TraditionalDocumentRules.Lint(html, out _);
        output.WriteLine(string.Join("\n", problems.Select(p => p.Message + " => " + p.Fix)));
        Assert.True(problems.Count >= 5);
        // No fix is the whole dialect: each one fits the answer's prose (no cut) and names its own tag or values.
        Assert.All(problems, p => Assert.True((p.Fix ?? "").Length <= 600, p.Message + " => " + p.Fix));
        Assert.Contains(problems, p => p.Message.Contains("method", StringComparison.Ordinal) && p.Fix!.Contains("\"Navigate\"", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Message.Contains("<span>", StringComparison.Ordinal) || p.Fix!.StartsWith("<span> takes", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Message.Contains("<video>", StringComparison.Ordinal) && p.Fix!.Contains("component", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Fix!.StartsWith("<screen> takes name, flow, title", StringComparison.Ordinal));
        Assert.True(problems.Select(p => p.Fix).Distinct().Count() >= 4);
    }

    /// <summary>The example of the Traditional card (ssam-code.mjs EXAMPLE_TRADITIONAL_HTML and its two logic texts, the same
    /// text) applies on the Traditional fixture: layout blank, a "show more" over a list variable, if/else.</summary>
    [Fact]
    public void TheExampleOfTheTraditionalCardApplies()
    {
        var facade = File.ReadAllText(Path.GetFullPath(Path.Combine(Kernel, "..", "platforms", "odc", "facade", "ssam-code.mjs")));
        var start = facade.IndexOf("export const EXAMPLE_TRADITIONAL_HTML = `", StringComparison.Ordinal);
        Assert.True(start >= 0);
        start = facade.IndexOf('`', start) + 1;
        var html = facade[start..facade.IndexOf('`', start)];
        StudioAssemblies.Bind();
        var work = Path.Combine(Kernel, ".local", "traditional-layout-tests", "card-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"ddl":"create entity Project (\n  Id Long Integer identifier auto required,\n  Title Text(80)\n);\n"}}"""),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "preparation Works.Preparation\n  GetProjects = aggregate FROM Project SORT Project.Title\n  assign Projects = GetProjects.List\n  end" } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "action Works.ShowMore\n  assign ProjectCount = ProjectCount + 3\n  GetMore = aggregate FROM Project SORT Project.Title\n  assign Projects = GetMore.List\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"ProjectList\"}\n  end" } }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "model")), Path.Combine(Kernel, "tests/fixtures/traditional-ui.oml"), job, Path.Combine(work, "out.oml")))!;
        File.WriteAllText(Path.Combine(work, "result.json"), result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
    }

    // ---- C-28: layout="blank" ----------------------------------------------------------------------------------------------

    [Fact]
    public void ABlankLayoutIsAcceptedAndAnotherLayoutIsRefusedWithItsValues()
    {
        Assert.Empty(TraditionalDocumentRules.Lint("<screen name=\"S\" layout=\"blank\"><div>x</div></screen>", out _));
        var wrong = Assert.Single(TraditionalDocumentRules.Lint("<screen name=\"S\" layout=\"none\"><div>x</div></screen>", out _));
        Assert.Contains("layout=\"blank\"", wrong.Fix);
        Assert.NotEmpty(TraditionalDocumentRules.Lint("<block name=\"B\" layout=\"blank\"><div>x</div></block>", out _));
    }

    [Fact]
    public void AScreenWithABlankLayoutHasNoTemplateLayoutBlock()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Kernel, ".local", "traditional-layout-tests", "blank-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["html"] = "<screen name=\"BlankShell\" layout=\"blank\"><div class=\"fm-page\">One body</div></screen>" } }) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(Kernel, "tests/fixtures/traditional-ui.oml"), job, Path.Combine(work, "out.oml")))!;
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var read = host.HtmlRead(File.ReadAllBytes(Path.Combine(work, "out.oml")), "BlankShell")["documents"]![0]!["html"]!.ToString();
        File.WriteAllText(Path.Combine(work, "read.html"), read);
        Assert.DoesNotContain("LayoutTopMenu", read);
        Assert.Contains("<div k=\"w1\" class=\"fm-page\">One body</div>", read);
    }

    // ---- C-29: what the Preparation of the same job fetches is data of its screen --------------------------------------------

    [Fact]
    public void TheAggregatesOfThePreparationOfTheSameJobAreDataOfItsScreen()
    {
        StudioAssemblies.Bind();
        var work = Path.Combine(Kernel, ".local", "traditional-html-records", "preparation-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work); output.WriteLine(work);
        var html = """
            <screen name="Fitmaker" actions="Preparation">
             <div class="stats">{{ GetHeroStats.List.Current.HeroStat.Label }}</div>
             <list-records id="Stats" source="GetHeroStats.List" line-separator="None"><div>{{ Stats.List.Current.HeroStat.Label }}</div></list-records>
            </screen>
            """;
        var ops = new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"ddl":"create entity HeroStat (\n  Id Long Integer identifier auto required,\n  Label Text(50)\n);\n"}}"""),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "preparation Fitmaker.Preparation\n  GetHeroStats = aggregate FROM HeroStat SORT HeroStat.Label\n  end" } });
        // The check before the Studio (S5 over the job's own texts): no name problem for GetHeroStats.
        var basis = new StaticBasis { Lane = "o11", Module = null, Fresh = false };
        var found = StaticChecks.Run(ops, "/ops", "o11", basis);
        output.WriteLine(string.Join("\n", found.Problems.Concat(found.Warnings).Select(p => p.ToJsonString())));
        Assert.DoesNotContain(found.Problems.Concat(found.Warnings), p => p["message"]!.ToString().Contains("'GetHeroStats'", StringComparison.Ordinal));
        // And the job applies: the page reads the Preparation's aggregate.
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = ops.DeepClone() }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "model")), Path.Combine(Kernel, "tests/fixtures/traditional-ui.oml"), job, Path.Combine(work, "out.oml")))!;
        File.WriteAllText(Path.Combine(work, "result.json"), result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
    }
}
