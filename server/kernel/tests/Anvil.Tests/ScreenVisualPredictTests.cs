using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>CX17 7.1: the runtime DOM predicted from a compiled model and the runtime table has the shapes the published
/// DemoLATAM_UI showed on 2026-10-14 (the input's span.input-type, the dropdown's container, the check box's span in a label with
/// OSFillParent, the List's OSFillParent and sentinels, the gutter after a neighbor, the span of a {{ }}, an empty class expression
/// published between quotes); and the contract of api --op html says them, generated from the same table.</summary>
public sealed class ScreenVisualPredictTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenVisualPredictTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-visual-predict");

    [Fact]
    public void AnEmptyClassExpressionIsPublishedAsTheStudiosClassBetweenQuotes()
    {
        Assert.Equal(["\"form-control\""], ScreenVisual.PublishedClasses("", "Input", "o11", out var quoted, out _));
        Assert.True(quoted);
        Assert.Equal(["\"list", "list-group\""], ScreenVisual.PublishedClasses(" ", "List", "odc", out _, out _));
        // Saved, an empty expression is no Style at all: the same.
        Assert.Equal(["\"form", "card\""], ScreenVisual.PublishedClasses(null, "Form", "o11", out quoted, out _));
        Assert.True(quoted);
        Assert.Equal(["form-control"], ScreenVisual.PublishedClasses("\"form-control\"", "Input", "o11", out quoted, out _));
        Assert.False(quoted);
        Assert.Empty(ScreenVisual.PublishedClasses("\"\"", "Input", "o11", out quoted, out _));
        Assert.Empty(ScreenVisual.PublishedClasses("If(X, \"a\", \"b\")", "Input", "o11", out _, out var dynamic));
        Assert.True(dynamic);
        Assert.Empty(ScreenVisual.PublishedClasses("", "Container", "o11", out quoted, out _));
        Assert.False(quoted);
    }

    [Fact]
    public void TheContractSaysTheRuntimeDomOfEachTagFromTheTable()
    {
        var contract = ScreenVisual.RuntimeContract("o11");
        output.WriteLine(contract.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.Contains("span.input-<type> > input[data-input]", contract["input"]!.ToString());
        Assert.Contains("div.dropdown-container[data-dropdown] > select.dropdown-display", contract["select"]!.ToString());
        Assert.Contains("no class: dropdown", contract["select"]!.ToString());
        Assert.Contains("no class: form", contract["form"]!.ToString());
        Assert.Contains("OSFillParent", contract["label"]!.ToString());
        Assert.Contains("ThemeGrid_MarginGutter", contract["a"]!.ToString());
        Assert.StartsWith("evidence", contract["status"]!.ToString());
        Assert.StartsWith("inferred", ScreenVisual.RuntimeContract("odc")["status"]!.ToString());
        Assert.Same(contract.GetType(), ScreenDocument.Schema()["runtime"]!.GetType());
        Assert.True(contract.ToJsonString().Length < 1300, "the contract stays small: " + contract.ToJsonString().Length);
    }

    [Fact]
    public void ThePredictedDomOfACompiledPageHasTheShapesOfThePublishedOne()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the prediction is skipped."); return; }
        var html = "<screen name=\"Predicted\" roles=\"Registered\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Q\" type=\"Text\"/>\n<var name=\"Ok\" type=\"Boolean\"/>\n"
            + "<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<div class=\"bar\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n"
            + "<input bind=\"Q\" type=\"search\"/>\n<label><input type=\"checkbox\" bind=\"Ok\"/> I agree</label>\n<p><strong>{{ Q }}</strong></p>\n"
            + "<table><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n<div list=\"Rows\"><p>{{ Rows.Current }}</p></div>\n</slot></Block>\n</screen>";
        var dir = Path.Combine(Work, "page");
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action Predicted.Go\n  end\n") } }) }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var host = new ModelHost(dir);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var prediction = ScreenVisual.PredictOml(host, outPath, "o11", name => name == "Predicted")["Predicted"];
        var dom = prediction.Root;
        output.WriteLine(dom.ToJson().ToJsonString());
        DomNode One(string selector) => Assert.Single(CssSelectors.Select(dom, selector));
        One("span.input-search > input[data-input].form-control.OSFillParent[type=search]");
        One("label[data-label].OSFillParent > span > input[data-checkbox].checkbox[type=checkbox]");
        One("strong > span[data-expression]");
        Assert.Single(CssSelectors.Select(dom, ".bar > a[data-link].ThemeGrid_MarginGutter"));      // the second link only
        One("tbody[data-list].list.OSFillParent[data-virtualization-disabled]");
        Assert.Empty(CssSelectors.Select(dom, "tbody[data-list] > script"));
        Assert.Equal(2, CssSelectors.Select(dom, "div[data-list] > script").Count());                // a plain List keeps its sentinels
        Assert.Equal(0, prediction.QuotedClasses);
        Assert.Equal(1, prediction.ListsWithSentinels);   }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
