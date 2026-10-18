using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>CX17: the native look of the document form (the families of the owner's DemoLATAM test of 2026-10-13/14). F2 the
/// class a new widget is born with, F1 a List that is part of a table or of a layout renders every row, F3/F6 the native layout
/// block of the theme: the rules without a module first, then the compile over the reactive fixture (skipped without the Service
/// Studio).</summary>
public sealed class ScreenVisualFamilyTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenVisualFamilyTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-visual-families");

    // ---- F2: the decision table against the widget table -------------------------------------------------------------------

    [Fact]
    public void EveryClassTheStudioGivesAWidgetHasItsDecisionAndATrimKeepsOnlyClassesOfTheStudio()
    {
        foreach (var platform in new[] { "o11", "odc" })
            foreach (var (type, defaults) in PrototypeWidgetDefaults.Table[platform])
            {
                var decision = ScreenVisual.DecisionFor(type);
                if (defaults.Style == null) { Assert.Null(decision); continue; }
                Assert.NotNull(decision);
                // If the Studio changes the class it gives a widget, this test says so (the decision is per class).
                Assert.Equal(defaults.Style, decision!.StudioClass);
                if (decision.Rule == ScreenVisual.ClassRule.Kept) { Assert.Null(decision.Written); continue; }
                var studio = decision.StudioClass.Trim('"').Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var written = decision.Written!.Trim('"').Split(' ', StringSplitOptions.RemoveEmptyEntries);
                Assert.StartsWith("\"", decision.Written);
                Assert.All(written, c => Assert.Contains(c, studio));
                Assert.True(written.Length < studio.Length, type + ": a trim drops the ornament");
            }
        Assert.Equal(ScreenVisual.ClassRule.Kept, ScreenVisual.DecisionFor("Input")!.Rule);
        Assert.Equal("\"form\"", ScreenVisual.DecisionFor("Form")!.Written);
        Assert.Equal("\"list\"", ScreenVisual.DecisionFor("IList")!.Written);
    }

    // ---- F1: which new List renders every row --------------------------------------------------------------------------------

    [Fact]
    public void AListThatIsATableBodyAListOrALayoutContainerRendersEveryRow()
    {
        var html = "<screen name=\"S\"><div class=\"wrap\"><table><tbody list=\"R\"><tr><td>a</td></tr></tbody></table>"
            + "<ul list=\"R\"><li>a</li></ul><div class=\"grid\" list=\"R\"><p>a</p></div><div class=\"plain\" list=\"R\"><p>a</p></div>"
            + "<section class=\"row\" list=\"R\"><p>a</p></section><li list=\"R\">a</li></div></screen>";
        var top = ScreenHtml.Parse(html).Children[0];
        var map = new Dictionary<ScreenHtml.Node, DomNode>(ReferenceEqualityComparer.Instance);
        ScreenVisual.AuthorDom(top, map);
        var rules = ScreenVisual.RulesOf([".grid{display:grid;gap:4px}", "@media (min-width:1px){.wrap .row{display:inline-flex}}", ".plain{display:block}"]);
        string? Reason(int index)
        {
            var node = map.Keys.Where(n => n.Get("list") != null).ElementAt(index);
            return ScreenVisual.AllRowsReason(node.Tag, map[node], rules);
        }
        Assert.Contains("table", Reason(0));            // tbody
        Assert.Contains("list", Reason(1));             // ul
        Assert.Contains("display grid", Reason(2));     // its own class is a grid
        Assert.Null(Reason(3));                         // a plain block
        Assert.Contains("inline-flex", Reason(4));      // matched with its ancestor, inside @media
        Assert.Null(Reason(5));                         // li: one item, not the list
    }

    // ---- F3/F6: the native layout block --------------------------------------------------------------------------------------

    [Fact]
    public void TheNativeLayoutBlockIsWrittenOnceAndAnOlderVersionIsReplacedNeverDuplicated()
    {
        var once = ScreenVisual.WithNativeLayout(".a{color:red}\n", out var first);
        Assert.Equal("added", first);
        Assert.Single(Regex.Matches(once, Regex.Escape(ScreenVisual.NativeLayoutBegin)));
        Assert.StartsWith(".a{color:red}\n\n" + ScreenVisual.NativeLayoutBegin, once);
        Assert.Equal(once, ScreenVisual.WithNativeLayout(once, out var second));
        Assert.Equal("present", second);
        var older = ".a{}\n/* ssam:native-layout */ v0\n.x{}\n/* /ssam:native-layout */\n.b{}";
        var replaced = ScreenVisual.WithNativeLayout(older, out var third);
        Assert.Equal("replaced", third);
        Assert.Equal(".a{}\n" + ScreenVisual.NativeLayoutCss + "\n.b{}", replaced);
        // Every rule of the block parses, each neutralizes one family, and each needs a marker of the op (review 1, A1).
        var rules = ScreenVisual.RulesOf([ScreenVisual.NativeLayoutCss]);
        Assert.Equal(["[data-ssam-gap].ThemeGrid_MarginGutter", ".layout :is(.main,.content,.main-content):has([data-ssam-page])",
            ":is(thead,tbody,tfoot)[data-ssam-rows]", "[data-ssam-rows]>script"], rules.Select(r => r.Selector));
        Assert.Contains(rules, r => r.Selector.Contains("ThemeGrid_MarginGutter", StringComparison.Ordinal) && r.Declarations.Any(d => d.Property == "margin-left" && d.Value.Trim() == "0"));
        Assert.Contains(rules, r => r.Selector.Contains("main-content", StringComparison.Ordinal) && r.Declarations.Any(d => d.Property == "min-width"));
        Assert.Contains(rules, r => r.Selector.Contains("tbody", StringComparison.Ordinal) && r.Declarations.Any(d => d.Property == "display" && d.Value.Trim() == "table-row-group"));
        // The gutter rule (0,2,0) wins over a rule of one class whatever the order; the layout rule over the one-class rules of OutSystems UI.
        Assert.Equal((0, 2, 0), CssSelectors.Specificity("[data-ssam-gap].ThemeGrid_MarginGutter"));
        Assert.True(CssSelectors.Specificity(".layout :is(.main,.content,.main-content):has([data-ssam-page])").CompareTo(CssSelectors.Specificity(".content")) > 0);
    }
    // ---- the compile over the reactive fixture -------------------------------------------------------------------------------

    private const string Document = "<screen name=\"VisualFamilies\" roles=\"Registered\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Q\" type=\"Text\"/>\n<var name=\"Ok\" type=\"Boolean\"/>\n"
        + "<style>.vf-grid{display:grid;grid-template-columns:repeat(3,1fr)}.vf-plain{color:#123}</style>\n"
        + "<Block name=\"LayoutBlank\"><slot name=\"Content\">\n"
        + "<div class=\"vf-bar\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n"
        + "<input bind=\"Q\" type=\"search\"/>\n<input bind=\"Q\" class=\"vf-mine\"/>\n<textarea bind=\"Q\"></textarea>\n"
        + "<label><input type=\"checkbox\" bind=\"Ok\"/> I agree</label>\n<button onclick=\"Go\">Go</button>\n"
        + "<form><label>Name</label><input bind=\"Q\"/></form>\n"
        + "<table><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n"
        + "<table><tbody list=\"Rows\" disable-virtualization=\"{{ True }}\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n"
        + "<div class=\"vf-grid\" list=\"Rows\"><p>{{ Rows.Current }}</p></div>\n"
        + "<div class=\"vf-plain\" list=\"Rows\"><p>{{ Rows.Current }}</p></div>\n"
        + "</slot></Block>\n</screen>";

    [Fact]
    public void ANewWidgetIsBornWithItsNativeClassAListOfATableOrAGridRendersEveryRowAndTheThemeTakesTheLayoutBlockOnce()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var host = Host("compile");
        var outPath = Path.Combine(Work, "compile", "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Job(Ops(Document, "VisualFamilies"), "compile"), outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document").AsObject();
        var normalized = report["normalized"]!.AsArray().Select(n => n!.AsObject()).ToList();
        output.WriteLine(new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        int Count(string code, string element) => normalized.Where(n => n["code"]!.ToString() == code && n["element"]?.ToString() == element).Sum(n => n["count"]!.GetValue<int>());
        // F2: the controls keep the Studio's class (the author's class wins), the containers lose the ornament.
        Assert.Equal(2, Count(ScreenVisual.StudioClassKept, "Input"));          // the search and the form's input; not the one with class
        Assert.Equal(1, Count(ScreenVisual.StudioClassKept, "TextArea"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassKept, "Checkbox"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Equal(2, Count(ScreenVisual.StudioClassTrimmed, "List"));        // the two table bodies; the grid and the plain list have the author's class
        // F1: the table bodies and the grid, never the plain list; the gen-screen form (its own attribute) once.
        // (review 1: the gen-screen one keeps its own attribute and gets only the rows marker of the block)
        Assert.Equal(3, Count(ScreenVisual.ListRendersAllRows, "List"));
        var layout = Assert.Single(normalized, n => n["code"]!.ToString() == ScreenVisual.ThemeNativeLayout);
        Assert.True(layout["written"]!.GetValue<bool>());
        Assert.Equal("added", layout["action"]!.ToString());

        var bytes = File.ReadAllBytes(outPath);
        var text = host.HtmlRead(bytes, "MobileScreen:VisualFamilies", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(text);
        Assert.Equal(2, Regex.Matches(text, "<input[^>]*class=\"form-control\"").Count);
        Assert.Contains("class=\"vf-mine\"", text);
        Assert.DoesNotContain("\"&quot;", text);
        Assert.Matches("<textarea[^>]*class=\"form-control\"", text);
        Assert.Matches("<input[^>]*type=\"checkbox\"[^>]*class=\"checkbox\"|<input[^>]*class=\"checkbox\"[^>]*type=\"checkbox\"", text);
        Assert.Matches("<button[^>]*class=\"btn\"", text);
        Assert.Matches("<form[^>]*class=\"form\"", text);
        Assert.Equal(2, Regex.Matches(text, "<tbody[^>]*class=\"list\"").Count);
        Assert.Equal(3, Regex.Matches(text, "disable-virtualization=").Count);   // two tbody, one grid; once each
        Assert.Equal(3, Regex.Matches(text, "data-ssam-rows=").Count);
        // The reading reads back what it wrote (the fixed point).
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "VisualFamilies")!;
        Assert.Equal(0, check["problemCount"]!.GetValue<int>());
        Assert.Equal(0, check["ops"]!.GetValue<int>());
        // The theme carries the block once; a second job that compiles another document leaves it as it is.
        var themeName = layout["theme"]!.ToString();
        Assert.Single(Regex.Matches(ThemeCss(host, outPath, "compile", themeName), Regex.Escape(ScreenVisual.NativeLayoutBegin)));
        var again = Path.Combine(Work, "compile", "again.oml");
        var second = JsonSerializer.SerializeToNode(JobRunner.Run(host, outPath, Job(Ops(Document.Replace("VisualFamilies", "VisualFamiliesTwo"), "VisualFamiliesTwo"), "compile-2"), again))!.AsObject();
        Assert.True(second["accepted"]!.GetValue<bool>(), second["details"]?.ToJsonString());
        Assert.DoesNotContain(ScreenVisual.ThemeNativeLayout, second.ToJsonString());
        var css = ThemeCss(host, again, "compile-2", themeName);
        Assert.Single(Regex.Matches(css, Regex.Escape(ScreenVisual.NativeLayoutBegin)));
        Assert.Contains(ScreenVisual.NativeLayoutCss, css);
    }

    [Fact]
    public void ACheckOfExpressionsARefusedDocumentAndTheRecreationOfTheReadingWriteNothing()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // A refused document: nothing of it, the theme included.
        var host = Host("refused");
        var broken = Document.Replace("<Block name=\"LayoutBlank\">", "<Block name=\"NoSuchLayout\">");
        var refusedOut = Path.Combine(Work, "refused", "out.oml");
        if (File.Exists(refusedOut)) File.Delete(refusedOut);
        var refused = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, null, Job(Ops(broken, "VisualFamilies"), "refused"), refusedOut));
        Assert.Contains("NoSuchLayout", refused.ToString());
        Assert.DoesNotContain(ScreenVisual.ThemeNativeLayout, refused.ToString());
        Assert.False(File.Exists(refusedOut));
        // The recreation of every screen of the fixture (every element read: the k of the reading) writes no class, no row and
        // no theme block, and reads back the same text.
        var fixture = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"));
        var proof = ScreenRecreationProof.Run(Host("recreation"), fixture, verify: true);
        var rows = proof["rows"]!.AsArray().Select(r => r!.AsObject()).ToList();
        Assert.NotEmpty(rows);
        output.WriteLine(string.Join("\n", rows.Select(r => r["root"] + " " + r["outcome"])));
        Assert.DoesNotContain(ScreenVisual.ThemeNativeLayout, proof.ToJsonString());
        Assert.DoesNotContain(ScreenVisual.StudioClassKept, proof.ToJsonString());
        Assert.DoesNotContain(ScreenVisual.StudioClassTrimmed, proof.ToJsonString());
        Assert.DoesNotContain(ScreenVisual.ListRendersAllRows, proof.ToJsonString());
    }

    // ---- review 1 (A1, M1): the block never reaches what the html op did not create --------------------------------------

    [Fact]
    public void EveryRuleOfTheNativeLayoutBlockMatchesOnlyWhatTheHtmlOpMarked()
    {
        // A1: the theme is the whole module's; a rule without the op's marker would change the screens made in the Studio.
        var rules = ScreenVisual.RulesOf([ScreenVisual.NativeLayoutCss]);
        Assert.NotEmpty(rules);
        foreach (var rule in rules)
            foreach (var selector in CssStylesheet.SplitSelectors(rule.Selector))
                Assert.Contains("[data-ssam-", selector, StringComparison.Ordinal);
    }

    [Fact]
    public void APreexistingStudioScreenKeepsItsGutterLayoutAndListsWhenADocumentLandsInItsModule()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // The review's repro (verify-0/job-a1.json): one synthetic screen in a module with screens made in the Studio.
        var probe = "<screen name=\"ProbeA1\" roles=\"Registered\">\n<div class=\"probe-a1\">Synthetic probe text</div>\n</screen>";
        var host = Host("a1");
        var outPath = Path.Combine(Work, "a1", "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Job(new JsonArray(Op(probe)), "a1"), outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
        var layout = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).FirstOrDefault(n => n["code"]!.ToString() == ScreenVisual.ThemeNativeLayout);
        output.WriteLine(layout?.ToJsonString() ?? "no layout note");
        var css = ThemeCss(host, outPath, "a1", layout?["theme"]?.ToString() ?? "ReactiveUI");
        var block = css.IndexOf(ScreenVisual.NativeLayoutBegin, StringComparison.Ordinal) is var at and >= 0 ? css[at..(css.IndexOf(ScreenVisual.NativeLayoutEnd, at, StringComparison.Ordinal) + ScreenVisual.NativeLayoutEnd.Length)] : "";
        var selectors = ScreenVisual.RulesOf([block]).SelectMany(r => CssStylesheet.SplitSelectors(r.Selector)).ToList();
        // Every other screen and block of the module, predicted: no element of theirs is reached by any rule of the block.
        var others = ScreenVisual.PredictOml(host, outPath, "o11", name => name != "ProbeA1");
        Assert.NotEmpty(others);
        int reached = 0, gutters = 0;
        foreach (var (name, prediction) in others)
        {
            gutters += prediction.Root.Descendants(includeSelf: false).Count(n => n.IsElement && n.Classes.Contains("ThemeGrid_MarginGutter"));
            foreach (var selector in selectors)
                foreach (var hit in CssSelectors.Select(prediction.Root, selector)) { reached++; output.WriteLine($"{name}: {selector} reaches <{hit.Tag} class=\"{hit.Attr("class")}\">"); }
        }
        output.WriteLine($"other roots {others.Count}, their gutters {gutters}, elements the block reaches {reached}");
        Assert.Equal(0, reached);
        if (layout != null) Assert.Equal(0, layout["otherRootsAffected"]!.GetValue<int>());
    }

    [Fact]
    public void TheReviewsModulesKeepEveryOtherScreenUntouched()
    {
        // Review 1, A1 repro on the reviewer's copies (verify-0: Horsie_UI, SS360_Backoffice; outside the repository, read only):
        // SSAM_CX17_A1_MODULES = paths separated by ';'. Skipped without them.
        var list = Environment.GetEnvironmentVariable("SSAM_CX17_A1_MODULES");
        if (string.IsNullOrWhiteSpace(list) || !StudioAvailable()) { output.WriteLine("SSAM_CX17_A1_MODULES not set: skipped."); return; }
        var probe = "<screen name=\"ProbeA1\" roles=\"Registered\">\n<div class=\"probe-a1\">Synthetic probe text</div>\n</screen>";
        foreach (var (path, i) in list.Split(';', StringSplitOptions.RemoveEmptyEntries).Select((p, i) => (p, i)))
        {
            var host = Host("a1-" + i);
            var copy = Path.Combine(Work, "a1-" + i, "base.oml");
            File.Copy(path, copy, overwrite: true);
            var outPath = Path.Combine(Work, "a1-" + i, "out.oml");
            var job = Path.Combine(Work, "a1-" + i, "job.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(Op(probe)) }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, copy, job, outPath))!.AsObject();
            Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
            var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
            var layout = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).FirstOrDefault(n => n["code"]!.ToString() == ScreenVisual.ThemeNativeLayout);
            var block = ScreenVisual.RulesOf([ScreenVisual.NativeLayoutCss]).SelectMany(r => CssStylesheet.SplitSelectors(r.Selector)).ToList();
            var others = ScreenVisual.PredictOml(host, outPath, "o11", name => name != "ProbeA1");
            int reached = 0, gutters = 0, layouts = 0;
            foreach (var (_, prediction) in others)
            {
                gutters += prediction.Root.Descendants(includeSelf: false).Count(n => n.IsElement && n.Classes.Contains("ThemeGrid_MarginGutter"));
                layouts += CssSelectors.Select(prediction.Root, ".layout .main-content").Count();
                reached += block.Sum(selector => CssSelectors.Select(prediction.Root, selector).Count());
            }
            output.WriteLine($"{Path.GetFileName(path)}: note {layout?.ToJsonString()}; other roots {others.Count}, their gutters {gutters}, their layout chains {layouts}, elements the block reaches {reached}");
            Assert.Equal(0, reached);
            Assert.Equal(0, layout?["otherRootsAffected"]?.GetValue<int>() ?? 0);
        }
    }
    private const string GenButtons = "<screen name=\"GenButtons\" roles=\"Registered\" actions=\"Go\">\n<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<p>Confirm?</p>\n"
        + "<div class=\"display-flex justify-content-flex-end margin-top-base\"><button class=\"btn\" onclick=\"Go\">Cancel</button><button class=\"btn btn-primary\" onclick=\"Go\">Save</button></div>\n"
        + "<style>.gb-bar{display:flex;gap:12px}</style><div class=\"gb-bar\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n"
        + "</slot></Block>\n</screen>";

    [Fact]
    public void TwoButtonsSideBySideKeepTheRuntimesGutterUnlessTheirParentHasAGapAndEveryJobSaysWhich()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // M1: the gen-screen shape (display-flex, two btn, no gap): the gutter is the only spacing between them; it stays.
        var host = Host("m1");
        var outPath = Path.Combine(Work, "m1", "out.oml");
        var again = Path.Combine(Work, "m1", "again.oml");
        var first = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Job(Ops(GenButtons, "GenButtons"), "m1"), outPath))!.AsObject();
        Assert.True(first["accepted"]!.GetValue<bool>(), first["details"]?.ToJsonString());
        // The second job lands on a module whose theme already has the block: it says the same.
        var second = JsonSerializer.SerializeToNode(JobRunner.Run(host, outPath, Job(Ops(GenButtons.Replace("GenButtons", "GenButtonsTwo"), "GenButtonsTwo"), "m1-2"), again))!.AsObject();
        Assert.True(second["accepted"]!.GetValue<bool>(), second["details"]?.ToJsonString());
        foreach (var result in new[] { first, second })
        {
            var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
            var normalized = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
            output.WriteLine(new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
            Assert.Equal(1, normalized.Where(n => n["code"]!.ToString() == ScreenVisual.GutterKept).Sum(n => n["count"]!.GetValue<int>()));
            // The count is the gutters zeroed: the first link of the bar has no gutter (the runtime gives it after a neighbor only).
            Assert.Equal(1, normalized.Where(n => n["code"]!.ToString() == ScreenVisual.GutterZeroedInGap).Sum(n => n["count"]!.GetValue<int>()));
        }
        var prediction = ScreenVisual.PredictOml(host, again, "o11", name => name == "GenButtonsTwo")["GenButtonsTwo"];
        var save = Assert.Single(CssSelectors.Select(prediction.Root, ".display-flex > button.btn-primary"));
        Assert.Contains("ThemeGrid_MarginGutter", save.Classes);
        Assert.Null(save.Attr("data-ssam-gap"));                              // no rule of the block reaches it
        var links = CssSelectors.Select(prediction.Root, ".gb-bar > a").ToList();
        Assert.Equal(2, links.Count);
        Assert.Null(links[0].Attr("data-ssam-gap"));                          // no gutter, no marker
        Assert.NotNull(links[1].Attr("data-ssam-gap"));
        Assert.Contains("ThemeGrid_MarginGutter", links[1].Classes);
    }

    [Fact]
    public void ABlockOfTheOpCarriesNoPageMarkerSoAPageThatPlacesItKeepsItsLayoutChain()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 1, A1 (the page marker): a block goes on pages the op did not create (made in the Studio); a marker inside it
        // would give their .layout chain min-width 0 through :has. Only a screen of the op carries the page marker.
        var block = "<block name=\"ProbeBlockA1\">\n<div class=\"probe-block-a1\">Synthetic block text</div>\n<p>Second synthetic line</p>\n</block>";
        var screen = "<screen name=\"ProbeScreenA1\" roles=\"Registered\">\n<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<div class=\"probe-screen-a1\">Synthetic page text</div>\n</slot></Block>\n</screen>";
        var host = Host("a1-block");
        var outPath = Path.Combine(Work, "a1-block", "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Job(new JsonArray(Op(block), Op(screen)), "a1-block"), outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var reports = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Where(r => r["form"]?.ToString() == "document").ToList();
        Assert.Equal(2, reports.Count);
        bool Marked(JsonObject report) => (report["normalized"] as JsonArray ?? []).Any(n => n!["code"]!.ToString() == ScreenVisual.PageMarked);
        Assert.False(Marked(reports.Single(r => r["root"]!.ToString() == "ProbeBlockA1")));
        Assert.True(Marked(reports.Single(r => r["root"]!.ToString() == "ProbeScreenA1")));
        var bytes = File.ReadAllBytes(outPath);
        var blockText = host.HtmlRead(bytes, "MobileBlock:ProbeBlockA1", withKeys: false)["documents"]![0]!["html"]!.ToString();
        var screenText = host.HtmlRead(bytes, "MobileScreen:ProbeScreenA1", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(blockText);
        output.WriteLine(screenText);
        Assert.DoesNotContain(ScreenVisual.PageMarker, blockText);
        Assert.Contains(ScreenVisual.PageMarker, screenText);
    }

    // ---- review 2 (M4): the markers are the engine's; the block's reach is measured ------------------------------------------

    // The code as a literal: the test reads the contract the agent reads.
    private const string ReservedMarker = "HTML_RESERVED_MARKER";

    [Fact]
    public void AMarkerOfTheEngineWrittenByTheAuthorIsRefusedOnceWithThePatchThatRemovesIt()
    {
        // Review 2, M4 (verify\f3\job-marker.json, verify-0\job-m4.json): data-ssam-page copied from a reading into a block, and
        // data-ssam-gap copied onto a link, were written as attributes; the block then reached the Studio's pages again.
        var block = "<block name=\"MarkedBlock\">\n<div class=\"mb-head\" data-ssam-page=\"1\">Synthetic header copied from a reading</div>\n</block>";
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(block, "/data/html"));
        var problem = Assert.Single(refusal.Problems!)!;
        Assert.Equal(ReservedMarker, problem["code"]!.ToString());
        Assert.NotNull(problem["patch"]);
        var corrected = Assert.IsType<string>(refusal.Data["correctedHtml"]);
        Assert.DoesNotContain("data-ssam-page", corrected);
        Assert.Contains("class=\"mb-head\"", corrected);
        ScreenDocument.Preflight(corrected, "/data/html");
        // Every marker at once, in any case and through ext: (HTML reads an attribute name without case).
        var screen = "<screen name=\"CopiedMarkers\" roles=\"Registered\">\n<div class=\"cm-row\"><a DATA-SSAM-GAP=\"1\">One</a><a ext:data-ssam-gap=\"1\">Two</a></div>\n"
            + "<table><tbody list=\"Rows\" data-ssam-rows=\"1\"><tr><td>Synthetic cell</td></tr></tbody></table>\n</screen>";
        var all = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(screen, "/data/html"));
        Assert.Equal(3, all.Problems!.Count(p => p!["code"]!.ToString() == ReservedMarker));
        Assert.DoesNotContain("ssam-", Assert.IsType<string>(all.Data["correctedHtml"]), StringComparison.OrdinalIgnoreCase);
        // An element of a reading (its k) keeps the marker it was read with.
        ScreenDocument.Preflight("<screen name=\"ReadMarkers\" roles=\"Registered\">\n<div k=\"w3\" data-ssam-page=\"1\">Synthetic kept text</div>\n</screen>", "/data/html");
    }

    [Fact]
    public void AnElementOfAReadingKeepsTheMarkerItWasReadWithAndNoOther()
    {
        // The rule of an element with k against its reading (the document form with the stored reading, the edit form's plan).
        ScreenHtml.Node Node(string html) => ScreenHtml.Parse(html).Children[0];
        var read = Node("<a k=\"w4\" data-ssam-gap=\"1\">Synthetic</a>");
        Assert.Empty(ScreenVisual.AuthorMarkers(Node("<a k=\"w4\" data-ssam-gap=\"1\">Synthetic</a>"), read));        // as read: kept
        var changed = Assert.Single(ScreenVisual.AuthorMarkers(Node("<a k=\"w4\" data-ssam-gap=\"2\">Synthetic</a>"), read));
        Assert.Equal(("data-ssam-gap", "2", "1"), changed);                                                            // put back
        var added = Assert.Single(ScreenVisual.AuthorMarkers(Node("<a k=\"w4\" data-ssam-gap=\"1\" data-ssam-page=\"1\">Synthetic</a>"), read));
        Assert.Equal(("data-ssam-page", "1", (string?)null), added);                                                   // removed
        Assert.Single(ScreenVisual.AuthorMarkers(Node("<div k=\"w5\" data-ssam-page=\"1\">Synthetic</div>"), Node("<div k=\"w5\" data-ssam-page=\"1\">Synthetic</div>"), block: true));
        // In the document form the same rule, with its patch.
        var problem = Assert.Single(ScreenDocument.RuleProblems(Node("<a k=\"w4\" data-ssam-gap=\"2\">Synthetic</a>"), true, null, read));
        Assert.Equal(ReservedMarker, problem.Code);
        Assert.IsType<ScreenDocument.SetAttribute>(problem.Correction);
        Assert.Empty(ScreenDocument.RuleProblems(Node("<a k=\"w4\" data-ssam-gap=\"1\">Synthetic</a>"), true, null, read));
    }

    [Fact]
    public void ACopiedMarkerInABlockOrOnALinkIsRefusedAndThePatchedLinkKeepsTheRuntimesGutter()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var block = "<block name=\"MarkedBlock\">\n<div class=\"mb-head\" data-ssam-page=\"1\">Synthetic header copied from a reading</div>\n</block>";
        var screen = "<screen name=\"CopiedGap\" roles=\"Registered\" actions=\"Go\">\n<Block name=\"LayoutBlank\"><slot name=\"Content\">\n"
            + "<div class=\"cg-row\"><a onclick=\"Go\">One</a><a onclick=\"Go\" data-ssam-gap=\"1\">Two</a></div>\n</slot></Block>\n</screen>";
        var host = Host("m4-doc");
        var ops = new JsonArray(Op(block), Op(screen), Logic("CopiedGap"));
        var refused = RunCatching(host, null, Job(ops, "m4-doc"), Path.Combine(Work, "m4-doc", "refused.oml"));
        Assert.False(refused["accepted"]?.GetValue<bool>() ?? false, refused.ToJsonString());
        var problems = (refused["problems"] as JsonArray ?? []).Select(p => p!.AsObject()).Where(p => p["code"]?.ToString() == ReservedMarker).ToList();
        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => Assert.NotNull(p["patch"]));
        // The patches applied: the block carries no page marker, the link no copied marker, and it keeps the runtime's gutter.
        var patched = ApplyPatches(ops, problems);
        var outPath = Path.Combine(Work, "m4-doc", "out.oml");
        var accepted = RunCatching(host, null, Job(patched, "m4-doc-patched"), outPath);
        Assert.True(accepted["accepted"]?.GetValue<bool>() ?? false, accepted.ToJsonString());
        var report = accepted["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["root"]?.ToString() == "CopiedGap");
        var normalized = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
        Assert.Equal(1, normalized.Where(n => n["code"]!.ToString() == ScreenVisual.GutterKept).Sum(n => n["count"]!.GetValue<int>()));
        Assert.DoesNotContain(normalized, n => n["code"]!.ToString() == ScreenVisual.GutterZeroedInGap);
        var bytes = File.ReadAllBytes(outPath);
        Assert.DoesNotContain(ScreenVisual.PageMarker, host.HtmlRead(bytes, "MobileBlock:MarkedBlock", withKeys: false)["documents"]![0]!["html"]!.ToString());
        var links = CssSelectors.Select(ScreenVisual.PredictOml(host, outPath, "o11", name => name == "CopiedGap")["CopiedGap"].Root, ".cg-row > a").ToList();
        Assert.Equal(2, links.Count);
        Assert.Null(links[1].Attr(ScreenVisual.GapMarker));
        Assert.Contains("ThemeGrid_MarginGutter", links[1].Classes);
    }

    [Fact]
    public void AnEditThatAddsAMarkerToAScreenThatExistedIsRefusedWithThePatchThatPutsItBack()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 2, M4 by the edit form (verify\edit\edit-data.json, verify-0\job-m4.json): an html edit of a screen made in the
        // Studio added data-ssam-page to an element of the reading; nothing said it.
        var host = Host("m4-edit");
        var basePath = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var bytes = File.ReadAllBytes(basePath);
        var read = host.HtmlRead(bytes, "Login", withKeys: false);
        var html = read["documents"]![0]!["html"]!.ToString();
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var tree = ScreenHtml.Parse(html);
        var label = ScreenHtmlText.Elements(tree).First(x => x.Node.Get("k") == "w16").Node;
        Assert.DoesNotContain(label.Attributes, a => a.Key.StartsWith("data-ssam", StringComparison.OrdinalIgnoreCase));
        label.Attributes.Add(new("data-ssam-page", "1"));
        JsonObject Edit(IEnumerable<string> edits) => new()
        {
            ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
                ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
                ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) },
        };
        var refused = RunCatching(host, basePath, Job(new JsonArray(Edit([ScreenHtmlText.Write(label)])), "m4-edit"), Path.Combine(Work, "m4-edit", "refused.oml"));
        Assert.False(refused["accepted"]?.GetValue<bool>() ?? false, refused.ToJsonString());
        var problem = (refused["problems"] as JsonArray ?? []).Select(p => p!.AsObject()).Single(p => p["code"]?.ToString() == ReservedMarker);
        Assert.Equal("w16", problem["k"]?.ToString());
        var patched = problem["patch"]![0]!["value"]!.AsArray().Select(v => v!.ToString()).ToList();
        Assert.DoesNotContain(patched, e => e.Contains("data-ssam", StringComparison.OrdinalIgnoreCase));
        var outPath = Path.Combine(Work, "m4-edit", "out.oml");
        var accepted = RunCatching(host, basePath, Job(new JsonArray(Edit(patched)), "m4-edit-patched"), outPath);
        Assert.True(accepted["accepted"]?.GetValue<bool>() ?? false, accepted.ToJsonString());
        Assert.DoesNotContain("data-ssam", host.HtmlRead(File.ReadAllBytes(outPath), "Login", withKeys: false)["documents"]![0]!["html"]!.ToString());
        // A new element of an edit with a marker: refused the same way, before the module is read.
        var form = ScreenHtmlText.Elements(ScreenHtml.Parse(html)).First(x => x.Node.Get("k") == "w7").Node;
        form.Children.Add(ScreenHtml.Parse("<a data-ssam-gap=\"1\">Synthetic link</a>").Children[0]);
        var fresh = RunCatching(host, basePath, Job(new JsonArray(Edit([ScreenHtmlText.Write(form)])), "m4-edit-new"), Path.Combine(Work, "m4-edit", "new.oml"));
        Assert.False(fresh["accepted"]?.GetValue<bool>() ?? false, fresh.ToJsonString());
        Assert.Contains(fresh["problems"] as JsonArray ?? [], p => p!["code"]?.ToString() == ReservedMarker);
        // Both in one edit: one refusal with both (the preflight's word on the new element does not hide the plan's on w16).
        var both = ScreenHtml.Parse(html);
        var bothLabel = ScreenHtmlText.Elements(both).First(x => x.Node.Get("k") == "w16").Node;
        bothLabel.Attributes.Add(new("data-ssam-page", "1"));
        var bothForm = ScreenHtmlText.Elements(both).First(x => x.Node.Get("k") == "w7").Node;
        bothForm.Children.Add(ScreenHtml.Parse("<a data-ssam-gap=\"1\">Synthetic link</a>").Children[0]);
        var edits = ScreenHtmlText.Elements(bothForm).Any(x => ReferenceEquals(x.Node, bothLabel))
            ? new[] { ScreenHtmlText.Write(bothForm) } : new[] { ScreenHtmlText.Write(bothForm), ScreenHtmlText.Write(bothLabel) };
        var once = RunCatching(host, basePath, Job(new JsonArray(Edit(edits)), "m4-edit-both"), Path.Combine(Work, "m4-edit", "both.oml"));
        var markers = (once["problems"] as JsonArray ?? []).Select(p => p!.AsObject()).Where(p => p["code"]?.ToString() == ReservedMarker).ToList();
        output.WriteLine(new JsonArray(markers.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString());
        Assert.Contains(markers, p => p["k"]?.ToString() == "w16");
        Assert.Contains(markers, p => p["message"]!.ToString().Contains("data-ssam-gap", StringComparison.Ordinal));
    }

    [Fact]
    public void TheNoteOfTheBlockSaysTheOtherRootsItReachesMeasuredOnTheirMarkers()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 2, M4: otherRootsAffected was the literal 0. Measured now: the roots of the module that carry a marker (screens an
        // earlier html op wrote) are the only ones the block reaches. Job 1: a screen of the op on the fixture (its Studio roots
        // carry none). Job 2: an older block in the theme (it is replaced) and another screen: the first one is named.
        var host = Host("m4-reach");
        var first = "<screen name=\"ReachFirst\" roles=\"Registered\" actions=\"Go\">\n<style>.rf-bar{display:flex;gap:12px}</style>\n<Block name=\"LayoutBlank\"><slot name=\"Content\">\n"
            + "<div class=\"rf-bar\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n</slot></Block>\n</screen>";
        var outPath = Path.Combine(Work, "m4-reach", "first.oml");
        var one = RunCatching(host, null, Job(new JsonArray(Op(first), Logic("ReachFirst")), "m4-reach"), outPath);
        Assert.True(one["accepted"]?.GetValue<bool>() ?? false, one.ToJsonString());
        var layout = LayoutNote(one, "ReachFirst");
        output.WriteLine(layout.ToJsonString());
        Assert.Equal(0, layout["otherRootsAffected"]!.GetValue<int>());
        var theme = layout["theme"]!.ToString();
        var older = ThemeCss(host, outPath, "m4-reach", theme).Replace("/* version " + ScreenVisual.NativeLayoutVersion + ",", "/* version 2,", StringComparison.Ordinal);
        Assert.Contains("/* version 2,", older);
        var second = first.Replace("ReachFirst", "ReachSecond").Replace("rf-bar", "rs-bar");
        var two = RunCatching(host, outPath, Job(new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:" + theme, ["prop"] = "StyleSheet", ["value"] = older },
            Op(second), Logic("ReachSecond")), "m4-reach-2"), Path.Combine(Work, "m4-reach", "second.oml"));
        Assert.True(two["accepted"]?.GetValue<bool>() ?? false, two.ToJsonString());
        var replaced = LayoutNote(two, "ReachSecond");
        output.WriteLine(replaced.ToJsonString());
        Assert.Equal("replaced", replaced["action"]!.ToString());
        Assert.Equal(1, replaced["otherRootsAffected"]!.GetValue<int>());
        Assert.Contains("ReachFirst", replaced.ToJsonString());
    }

    // ---- review 2 (M5): the gap of the parent, per axis and per condition --------------------------------------------------

    [Fact]
    public void TheGutterFollowsTheHorizontalGapOfTheParentPerAxisPerConditionAndWithTheOutSystemsUiUtilities()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 2, M5 (verify-1\job.json, verify\f3\job-f3.json): the OutSystems UI gap utilities read as "no gap" (the space came
        // out doubled), gap:16px 0 and column-gap:0 read as a gap (the links touched), a gap inside @media read as always there.
        const string links = "<a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a>";
        const string buttons = "<button class=\"btn\" onclick=\"Go\">Cancel</button><button class=\"btn btn-primary\" onclick=\"Go\">Save</button>";
        var cases = new (string Root, string Parent, string Css, string Items, bool Zeroed)[]
        {
            ("VOsuiGapS", "display-flex gap-s", "", buttons, true),
            ("VOsuiColGapS", "display-flex column-gap-s", "", links, true),
            ("VOsuiRowGapS", "display-flex row-gap-s", "", links, false),
            ("VOsuiFlexOnly", "display-flex justify-content-flex-end", "", buttons, false),     // the gen-screen shape
            ("VRowGapOnly", "vrg", ".vrg{display:flex;gap:16px 0}", links, false),
            ("VColGapZeroLonghand", "vcz", ".vcz{display:flex;gap:16px;column-gap:0}", links, false),
            ("VGapAfterLonghand", "vga", ".vga{display:flex;column-gap:0;gap:16px}", links, true),  // the declaration that wins
            ("VMediaGap", "vmq", "@media (min-width:1024px){.vmq{display:flex;gap:12px}}", links, false),
            ("VCtrlAuthorGap", "vcg", ".vcg{display:flex;gap:8px}", links, true),
            ("VCtrlNoGap", "vng", ".vng{display:flex}", links, false),
        };
        var ops = new JsonArray();
        foreach (var (root, parent, css, items, _) in cases)
        {
            ops.Add(Op($"<screen name=\"{root}\" roles=\"Registered\" actions=\"Go\">\n" + (css.Length > 0 ? $"<style>{css}</style>\n" : "")
                + $"<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<div class=\"{parent}\">{items}</div>\n</slot></Block>\n</screen>"));
            ops.Add(Logic(root));
        }
        var host = Host("m5");
        var outPath = Path.Combine(Work, "m5", "out.oml");
        var result = RunCatching(host, null, Job(ops, "m5"), outPath);
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        var reports = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Where(r => r["form"]?.ToString() == "document").ToList();
        var wrong = new List<string>();
        foreach (var (root, parent, _, _, zeroed) in cases)
        {
            var normalized = (reports.Single(r => r["root"]!.ToString() == root)["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
            int Count(string code) => normalized.Where(n => n["code"]!.ToString() == code).Sum(n => n["count"]!.GetValue<int>());
            output.WriteLine($"{root} ({parent}): zeroed {Count(ScreenVisual.GutterZeroedInGap)}, kept {Count(ScreenVisual.GutterKept)}");
            if (Count(ScreenVisual.GutterZeroedInGap) != (zeroed ? 1 : 0) || Count(ScreenVisual.GutterKept) != (zeroed ? 0 : 1)) wrong.Add(root);
        }
        Assert.True(wrong.Count == 0, "wrong gutter decision: " + string.Join(", ", wrong));
        // The gap only under @media: the note says the condition (there the gap and the gutter add up).
        var media = (reports.Single(r => r["root"]!.ToString() == "VMediaGap")["normalized"] as JsonArray ?? []).Single(n => n!["code"]!.ToString() == ScreenVisual.GutterKept)!;
        output.WriteLine(media.ToJsonString());
        output.WriteLine((reports.Single(r => r["root"]!.ToString() == "VOsuiGapS")["normalized"] as JsonArray ?? []).Single(n => n!["code"]!.ToString() == ScreenVisual.GutterZeroedInGap)!.ToJsonString());
        Assert.Contains("@media (min-width:1024px)", media.ToJsonString());
        var predicted = ScreenVisual.PredictOml(host, outPath, "o11", name => name is "VOsuiGapS" or "VRowGapOnly");
        Assert.NotNull(CssSelectors.Select(predicted["VOsuiGapS"].Root, ".gap-s > button").Last().Attr(ScreenVisual.GapMarker));
        Assert.Null(CssSelectors.Select(predicted["VRowGapOnly"].Root, ".vrg > a").Last().Attr(ScreenVisual.GapMarker));
    }

    [Fact]
    public void TheSpaceOfAParentIsReadOneWayPerAxisPerConditionAndByTheCascade()
    {
        // Review 2, M5, without a module: ScreenVisual.SpacingReader is the one reading of a parent's gap.
        ScreenVisual.Spacing Read(string css, string classes, string? style = null)
        {
            var html = $"<screen name=\"S\"><div class=\"{classes}\"" + (style != null ? $" style=\"{style}\"" : "") + "><a>One</a><a>Two</a></div></screen>";
            var top = ScreenHtml.Parse(html).Children[0];
            var map = new Dictionary<ScreenHtml.Node, DomNode>(ReferenceEqualityComparer.Instance);
            ScreenVisual.AuthorDom(top, map);
            var div = map.First(p => p.Key.Tag == "div").Value;
            return new ScreenVisual.SpacingReader([("OutSystems UI", ScreenVisual.OutSystemsUiLayoutCss), ("page", css)]).Of(div);
        }
        var osui = Read("", "display-flex gap-s");
        Assert.True(osui.Always.Horizontal);
        Assert.Equal("8px", osui.Always.ColumnGap);
        Assert.Contains(".gap-s (OutSystems UI)", osui.Always.ColumnGapFrom);
        Assert.True(Read("", "display-flex column-gap-s").Always.Horizontal);
        var rows = Read("", "display-flex row-gap-s").Always;
        Assert.False(rows.Horizontal);
        Assert.Equal("8px", rows.RowGap);                                                    // per axis: the lines are spaced
        Assert.False(Read("", "gap-s").Always.Horizontal);                                     // a gap outside flex or grid spaces nothing
        var shorthand = Read(".a{display:flex;gap:16px 0}", "a").Always;
        Assert.Equal(("16px", "0"), (shorthand.RowGap, shorthand.ColumnGap));
        Assert.False(shorthand.Horizontal);
        Assert.False(Read(".a{display:flex;gap:16px;column-gap:0}", "a").Always.Horizontal);    // the longhand after it wins
        Assert.True(Read(".a{display:flex;column-gap:0;gap:16px}", "a").Always.Horizontal);     // the shorthand after it wins
        Assert.False(Read(".a.b{gap:0}.a{display:flex;gap:8px}", "a b").Always.Horizontal);     // specificity before order
        Assert.False(Read(".a{display:flex;gap:0!important}.a{gap:8px}", "a").Always.Horizontal);
        Assert.True(Read(".a{gap:0}", "a", "display:flex;gap:8px").Always.Horizontal);          // the style attribute
        Assert.False(Read(":root{--space-s:0}", "display-flex gap-s").Always.Horizontal);       // the author's token over OutSystems UI's
        Assert.True(Read(".a{display:grid;grid-gap:4px 10px}", "a").Always.Horizontal);
        Assert.False(Read(".a{display:flex;gap:normal}", "a").Always.Horizontal);
        // Per condition: the rules without one decide; a condition that changes the answer is said.
        var media = Read("@media (min-width:1024px){.a{display:flex;gap:12px}}", "a");
        Assert.False(media.Always.Horizontal);
        var (condition, there) = Assert.Single(media.Conditional);
        Assert.Equal("@media (min-width:1024px)", condition);
        Assert.True(there.Horizontal);
        var phone = Read(".a{display:flex;gap:12px}@media (max-width:767px){.a{display:block}}", "a");
        Assert.True(phone.Always.Horizontal);
        Assert.False(Assert.Single(phone.Conditional).There.Horizontal);
        Assert.Empty(Read(".a{display:flex;gap:12px}@media (max-width:767px){.a{gap:8px}}", "a").Conditional);  // the same answer there
    }

    [Fact]
    public void TheOutSystemsUiLayoutTableIsTheFixturesRules()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the fixture's theme is not read."); return; }
        // The table of ScreenVisual.OutSystemsUiLayoutCss is taken from the theme of the fixture outsystems-ui.oml (OutSystems UI
        // 2.28.1): every one of its declarations is there, in a rule of the same selector without a condition.
        // The fixture is local (kernel/.gitignore: it is not in the repository): without it the comparison is skipped, said.
        var fixturePath = Path.Combine(Root, "tests", "fixtures", "outsystems-ui.oml");
        if (!File.Exists(fixturePath)) { output.WriteLine("WARNING: no tests/fixtures/outsystems-ui.oml (a local fixture): the table is not compared."); return; }
        var host = Host("osui-table");
        var css = ThemeCss(host, fixturePath, "osui-table", "OutSystemsUI");
        Assert.True(css.Length > 100_000, "the OutSystems UI theme of the fixture");
        var fixture = ScreenVisual.RulesOf([css]).Where(r => r.EnclosingRules.Count == 0).ToList();
        var table = ScreenVisual.RulesOf([ScreenVisual.OutSystemsUiLayoutCss]);
        Assert.Equal(1 + 8 + 21, table.Count);
        foreach (var rule in table)
            foreach (var d in rule.Declarations)
                Assert.True(fixture.Any(f => f.Selector == rule.Selector && f.Declarations.Any(x => x.Property == d.Property && x.Value.Trim() == d.Value.Trim())),
                    $"{rule.Selector}{{{d.Property}:{d.Value}}} is not in the fixture's theme");
    }

    [Fact]
    public void EveryMarkerTheBlockReadsIsReservedInEveryTextForm()
    {
        // The family closed: the reserved names are exactly the attributes the block's rules read.
        var read = Regex.Matches(ScreenVisual.NativeLayoutCss, @"\[([a-z-]+)\]").Select(m => m.Groups[1].Value).Distinct().Order(StringComparer.Ordinal);
        Assert.Equal(ScreenVisual.EngineMarkers.Order(StringComparer.Ordinal), read);
        Assert.Equal(ScreenVisual.PageMarker, ScreenVisual.MarkerOf("ext:DATA-SSAM-PAGE"));
        Assert.Null(ScreenVisual.MarkerOf("data-ssam-asset"));
        // The fragment form (an html op with parent: a screen that exists) refuses it too, with the other problems of the fragment.
        var fragment = Assert.ThrowsAny<Exception>(() => HtmlVisual.Preflight("<div class=\"f\"><div data-ssam-gap=\"1\">One</div><div DATA-SSAM-PAGE=\"1\">Two</div></div>", "Container:Main"));
        var coded = Errors.FindCoded(fragment);
        Assert.NotNull(coded);
        Assert.Equal(2, coded!.Problems!.Count(p => p!["code"]!.ToString() == ReservedMarker));
    }

    // ---- review 3 (M6): the marker is derived state, decided again in every text form ---------------------------------------

    // The codes as literals: the test reads the contract the agent reads.
    private const string MarkerDecided = "HTML_MARKER_DECIDED";
    private const string GutterAddsToGap = "GUTTER_ADDS_TO_GAP";

    // The QA screen of the review (verify\m4k\job-qa.json): one row with a gap (the second link carries data-ssam-gap), one without.
    private const string QaScreen = "<screen name=\"QA\" roles=\"Registered\" actions=\"Go\">\n<style>.qa{display:flex;gap:16px}.qb{display:flex}</style>\n"
        + "<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<div class=\"qa\"><a onclick=\"Go\">GapOne</a><a onclick=\"Go\">GapTwo</a></div>\n"
        + "<div class=\"qb\"><a onclick=\"Go\">FlatOne</a><a onclick=\"Go\">FlatTwo</a></div>\n</slot></Block>\n</screen>";

    [Fact]
    public void TheGapMarkerOfAnElementOfAReadingIsDecidedAgainInEveryTextForm()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 3, M6 (verify\m4k\job-{nogap,move,drop,add,copy}.json): the marker of an element read was copied, kept or dropped
        // without a decision: links touching where the parent lost its gap or the link moved, the space added up where the author
        // dropped it. The marker is the engine's decision on the parent, made again whenever the element or its parent changes.
        var host = Host("m6");
        var basePath = Path.Combine(Work, "m6", "qa.oml");
        var made = RunCatching(host, null, Job(new JsonArray(Op(QaScreen), Logic("QA")), "m6"), basePath);
        Assert.True(made["accepted"]?.GetValue<bool>() ?? false, made.ToJsonString());
        var bytes = File.ReadAllBytes(basePath);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var read = host.HtmlRead(bytes, "QA", withKeys: true)["documents"]![0]!.AsObject();
        var html = read["html"]!.ToString();
        output.WriteLine(html);
        Assert.True(Gap(html, "GapTwo"));
        Assert.False(Gap(html, "FlatTwo"));
        JsonObject Edit(params string[] edits) => new()
        {
            ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "QA",
                ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() },
                ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) },
        };
        (string Html, List<JsonObject> Normalized) Run(string name, JsonObject op, string root = "QA")
        {
            var outPath = Path.Combine(Work, "m6", name + ".oml");
            var result = RunCatching(host, basePath, Job(new JsonArray(op), "m6-" + name), outPath);
            Assert.True(result["accepted"]?.GetValue<bool>() ?? false, name + ": " + result.ToJsonString());
            var text = host.HtmlRead(File.ReadAllBytes(outPath), root, withKeys: false)["documents"]![0]!["html"]!.ToString();
            var normalized = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().SelectMany(r => r["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
            output.WriteLine(name + ": " + text);
            output.WriteLine(name + ": " + new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
            return (text, normalized);
        }
        static bool Said(List<JsonObject> normalized, string code) => normalized.Any(n => n["code"]?.ToString() == code);
        // The parent loses its gap: the marker goes, said (the runtime's gutter is the only spacing again).
        var nogap = Run("nogap", Edit("<style>.qa{display:flex}.qb{display:flex}</style>"));
        Assert.False(Gap(nogap.Html, "GapTwo"));
        Assert.True(Said(nogap.Normalized, MarkerDecided));
        Assert.True(Said(nogap.Normalized, ScreenVisual.GutterKept));
        // The link moves to the row without a gap, its marker written in the text: decided again there, it goes.
        var move = Run("move", Edit("<div k=\"w2\" class=\"qa\" data-ssam-page=\"1\">\n<a k=\"w3\" onclick=\"Go\">GapOne</a>\n</div>",
            "<div k=\"w5\" class=\"qb\" data-ssam-page=\"1\">\n<a k=\"w6\" onclick=\"Go\">FlatOne</a>\n<a k=\"w7\" onclick=\"Go\">FlatTwo</a>\n<a k=\"w4\" onclick=\"Go\" data-ssam-gap=\"1\">GapTwo</a>\n</div>"));
        Assert.False(Gap(move.Html, "GapTwo"));
        Assert.True(Said(move.Normalized, MarkerDecided));
        // The author drops the marker where the parent still has its gap: decided again, it stays (never the space added up), said.
        var drop = Run("drop", Edit("<a k=\"w4\" onclick=\"Go\">GapTwo</a>"));
        Assert.True(Gap(drop.Html, "GapTwo"));
        Assert.True(Said(drop.Normalized, MarkerDecided));
        // A new link after a neighbor in the row with the gap is marked like the others.
        var add = Run("add", Edit("<div k=\"w2\" class=\"qa\" data-ssam-page=\"1\">\n<a k=\"w3\" onclick=\"Go\">GapOne</a>\n<a k=\"w4\" onclick=\"Go\" data-ssam-gap=\"1\">GapTwo</a>\n<a onclick=\"Go\">GapThree</a>\n</div>"));
        Assert.True(Gap(add.Html, "GapTwo"));
        Assert.True(Gap(add.Html, "GapThree"));
        Assert.True(Said(add.Normalized, ScreenVisual.GutterZeroedInGap));
        // The fixed point: an edit that changes nothing of the space keeps every marker as read, and says no decision.
        var same = Run("same", Edit("<a k=\"w6\" onclick=\"Go\">FlatOneRenamed</a>"));
        Assert.True(Gap(same.Html, "GapTwo"));
        Assert.False(Gap(same.Html, "FlatTwo"));
        Assert.False(Said(same.Normalized, MarkerDecided));
        // The document form: a copy to a new screen with the stored reading (ssam_map view html keeps it). The copied k elements are
        // decided again in their new parents: w4 (marked in the reading) lands in a row without a gap, w7 (unmarked) in one with it.
        var store = ModuleIndexStore.Default();
        if (store == null) { output.WriteLine("WARNING: no module index (SSAM_MODULE_INDEX_ROOT): the copy by the document form is skipped."); return; }
        var file = store.HtmlKeysPathOf(sha, read["htmlSha256"]!.ToString());
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, new JsonObject { ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = "o11", ["sourceSha256"] = sha,
            ["root"] = "QA", ["rootKey"] = read["rootKey"]?.DeepClone(), ["rootKind"] = read["rootKind"]?.DeepClone(), ["htmlSha256"] = read["htmlSha256"]!.DeepClone(),
            ["keys"] = read["keys"]!.DeepClone(), ["html"] = html }.ToJsonString());
        var copy = new JsonObject
        {
            ["op"] = "html", ["data"] = new JsonObject {
                ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() },
                ["html"] = "<screen name=\"QB\" roles=\"Registered\" actions=\"Go\">\n<style>.qc{display:flex}.qd{display:flex;gap:8px}</style>\n<Block name=\"LayoutBlank\"><slot name=\"Content\">\n"
                    + "<div class=\"qc\"><a onclick=\"Go\">NewOne</a><a k=\"w4\" onclick=\"Go\" data-ssam-gap=\"1\">GapTwo</a></div>\n"
                    + "<div class=\"qd\"><a onclick=\"Go\">NewTwo</a><a k=\"w7\" onclick=\"Go\">FlatTwo</a></div>\n</slot></Block>\n</screen>" },
        };
        var copyPath = Path.Combine(Work, "m6", "copy.oml");
        var copied = RunCatching(host, basePath, Job(new JsonArray(copy, Logic("QB")), "m6-copy"), copyPath);
        Assert.True(copied["accepted"]?.GetValue<bool>() ?? false, copied.ToJsonString());
        var qb = host.HtmlRead(File.ReadAllBytes(copyPath), "QB", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(qb);
        Assert.False(Gap(qb, "GapTwo"));
        Assert.True(Gap(qb, "FlatTwo"));
        var report = copied["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["root"]?.ToString() == "QB");
        Assert.Contains(report["normalized"] as JsonArray ?? [], n => n!["code"]?.ToString() == MarkerDecided);
    }

    // Whether the link with that text carries the gap marker in a reading.
    private static bool Gap(string html, string label) =>
        ScreenHtmlText.Elements(ScreenHtml.Parse(html)).Select(x => x.Node).First(n => n.Tag == "a" && string.Concat(n.Children.Where(c => c.IsText).Select(c => c.Text)).Trim() == label)
            .Attributes.Any(a => a.Key == ScreenVisual.GapMarker);

    // ---- review 3 (M7): the theme the page shows ------------------------------------------------------------------------------

    [Fact]
    public void TheLayoutBlockAndTheSpaceOfAParentFollowTheThemeThePageShows()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 3, M7 (verify\probes\job-theme2.json, job-theme3.json, job-theme4.json, the DCIPS corpus shape): the block went to
        // the module's default theme and the space was read from it, while the page shows its flow's theme; the notes said a gutter
        // zeroed and a layout chain given min-width 0 that no rule of the page's CSS does.
        JsonObject Set(string target, string prop, string value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value };
        JsonObject Create(string type, string name, string alias) => new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = type, ["name"] = name, ["as"] = alias };
        string Screen(string name, string flow, string css, string parent) => $"<screen name=\"{name}\" roles=\"Registered\" actions=\"Go\" flow=\"{flow}\">\n"
            + (css.Length > 0 ? $"<style>{css}</style>\n" : "") + $"<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<div class=\"{parent}\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n</slot></Block>\n</screen>";
        var ops = new JsonArray(
            Create("IMobileTheme", "VzFlowTheme", "$theme"), Set("$theme", "BaseTheme", "MobileThemeSignature:OutSystemsUI"), Set("$theme", "StyleSheet", ".vt{display:flex;gap:10px}\n"),
            Create("IMobileFlow", "VzFlow", "$flow"), Set("$flow", "Theme", "$theme"),
            // The DCIPS shape: the flow shows a theme of another module (a producer's), the default theme stays this module's.
            Create("IMobileFlow", "VzForeignFlow", "$foreign"), Set("$foreign", "Theme", "MobileThemeSignature:OutSystemsUI"),
            Op(Screen("VzThemedGap", "VzFlow", ".tg{display:flex;gap:12px}", "tg")), Logic("VzThemedGap"),
            Op(Screen("VzThemeRow", "VzFlow", "", "vt")), Logic("VzThemeRow"),
            Op(Screen("VzForeignGap", "VzForeignFlow", ".fg{display:flex;gap:12px}", "fg")), Logic("VzForeignGap"));
        var host = Host("m7");
        var outPath = Path.Combine(Work, "m7", "out.oml");
        var result = RunCatching(host, null, Job(ops, "m7"), outPath);
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        List<JsonObject> Normalized(JsonObject job, string root) =>
            (job["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["root"]?.ToString() == root)["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
        int Count(List<JsonObject> normalized, string code) => normalized.Where(n => n["code"]?.ToString() == code).Sum(n => n["count"]?.GetValue<int>() ?? 1);
        foreach (var root in new[] { "VzThemedGap", "VzThemeRow", "VzForeignGap" }) output.WriteLine(root + ": " + new JsonArray(Normalized(result, root).Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
        // The flow's own theme takes the block (the page loads it), and the gap of the theme is read.
        var layout = LayoutNote(result, "VzThemedGap");
        Assert.Equal("VzFlowTheme", layout["theme"]!.ToString());
        Assert.True(layout["written"]!.GetValue<bool>());
        Assert.Contains(ScreenVisual.NativeLayoutBegin, ThemeCss(host, outPath, "m7", "VzFlowTheme"));
        Assert.Equal(1, Count(Normalized(result, "VzThemedGap"), ScreenVisual.GutterZeroedInGap));
        Assert.Equal(1, Count(Normalized(result, "VzThemeRow"), ScreenVisual.GutterZeroedInGap));
        Assert.Equal(0, Count(Normalized(result, "VzThemeRow"), ScreenVisual.GutterKept));
        Assert.DoesNotContain(ScreenVisual.TextJoined, result.ToJsonString());               // F8 reads the theme the page shows
        // A page whose flow shows a theme of another module: no marker, no note that says one, and the reason.
        var foreign = Normalized(result, "VzForeignGap");
        Assert.Equal(0, Count(foreign, ScreenVisual.GutterZeroedInGap));
        Assert.Equal(0, Count(foreign, ScreenVisual.PageMarked));
        Assert.Equal(1, Count(foreign, GutterAddsToGap));
        var unreached = foreign.Single(n => n["code"]?.ToString() == ScreenVisual.ThemeNativeLayout);
        Assert.False(unreached["written"]!.GetValue<bool>());
        Assert.Contains("OutSystemsUI", unreached["note"]!.ToString());
        Assert.DoesNotContain("data-ssam", host.HtmlRead(File.ReadAllBytes(outPath), "VzForeignGap", withKeys: false)["documents"]![0]!["html"]!.ToString());
        // The default theme of another module (verify\probes\job-theme4.json): one answer never says both.
        var four = RunCatching(Host("m7-default"), null, Job(new JsonArray(Set("@espace", "DefaultMobileTheme", "MobileThemeSignature:OutSystemsUI"),
            Op(Screen("VzForeignTheme", "MainFlow", ".ft{display:flex;gap:12px}", "ft").Replace(" flow=\"MainFlow\"", "")), Logic("VzForeignTheme")), "m7-default"), Path.Combine(Work, "m7-default", "out.oml"));
        Assert.True(four["accepted"]?.GetValue<bool>() ?? false, four.ToJsonString());
        var other = Normalized(four, "VzForeignTheme");
        output.WriteLine(new JsonArray(other.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
        Assert.False(other.Single(n => n["code"]?.ToString() == ScreenVisual.ThemeNativeLayout)["written"]!.GetValue<bool>());
        Assert.Equal(0, Count(other, ScreenVisual.GutterZeroedInGap));
        Assert.Equal(0, Count(other, ScreenVisual.PageMarked));
    }

    // ---- review 3 (M8): one place of an edit op is the same rule on the same element -----------------------------------------

    [Fact]
    public void TheProblemsOfOneEditOpAreOnePlaceOnlyForTheSameElementOrTheSameMessage()
    {
        // Review 3, M8 (verify\m4k-merge\job-login-edits.json, the CX16 edits form in the merge): the preflight refused the new
        // element of the op at /data/edits and the plan the element with k at /data/edits/0, with the same code; "a pointer inside
        // with the same code" made them one place and the list lost the element with k (the text had both). The same for HTML_SCRIPT.
        JsonObject P(string phase, string pointer, string code, string message, string? k = null)
        {
            var p = JobPreflight.Problem(0, pointer, code, "error", message, "fix");
            p["phase"] = phase;
            if (k != null) p["k"] = k;
            return p;
        }
        foreach (var code in new[] { ReservedMarker, "HTML_SCRIPT" })
            foreach (var (outer, inner) in new[] { ("/ops/0/data/edits", "/ops/0/data/edits/0"), ("/ops/0/data/edit", "/ops/0/data/edit/1") })
            {
                var newElement = "line 1 col 1: the new element writes it (synthetic)";
                var united = JobRunner.Union([
                    P("preflight", outer, code, newElement),
                    P("apply", inner, code, "the element with k writes it (synthetic)", "w16"),
                    P("apply", outer, code, newElement),                                  // the same new element said again: one place
                    P("apply", inner, code, "the element with k writes it (synthetic)", "w16"),  // the same element said again: one place
                ], "/ops");
                Assert.True(united.Count == 2, code + " " + outer + ": " + new JsonArray(united.Select(p => (JsonNode)p.DeepClone()).ToArray()).ToJsonString());
                Assert.Contains(united, p => p["k"]?.ToString() == "w16");
                Assert.Contains(united, p => p["message"]?.ToString() == newElement);
            }
    }

    // ---- review 4 (N1): a block shows the themes of the pages that place it --------------------------------------------------

    private const string GapBlock = "<block name=\"VzGapBlock\" actions=\"Go\">\n<style>.gb{display:flex;gap:12px}</style>\n<div class=\"gb\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n</block>";
    private static string HostScreen(string name, string flow, string block) => $"<screen name=\"{name}\" roles=\"Registered\"{(flow.Length > 0 ? $" flow=\"{flow}\"" : "")}>\n"
        + $"<Block name=\"LayoutBlank\"><slot name=\"Content\">\n<Block name=\"{block}\"></Block>\n</slot></Block>\n</screen>";
    private static JsonObject SetOp(string target, string prop, string value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value };
    private static JsonObject CreateOp(string type, string name, string alias) => new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = type, ["name"] = name, ["as"] = alias };
    private static List<JsonObject> NormalizedOf(JsonObject job, string root) =>
        (job["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Last(r => r["root"]?.ToString() == root || r["screen"]?.ToString() == root)["normalized"] as JsonArray ?? [])
            .Select(n => n!.AsObject()).ToList();
    private static int CountOf(List<JsonObject> normalized, string code) => normalized.Where(n => n["code"]?.ToString() == code).Sum(n => n["count"]?.GetValue<int>() ?? 1);
    private string Dump(List<JsonObject> normalized) => new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString();

    // The edit of one element of a reading (its stored sha of the capture and of the reading).
    private static JsonObject EditOf(string root, string capture, JsonObject read, params string[] edits) => new()
    {
        ["op"] = "html", ["data"] = new JsonObject { ["screen"] = root,
            ["basedOn"] = new JsonObject { ["capture"] = capture, ["html"] = read["htmlSha256"]!.DeepClone() },
            ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) },
    };
    private static string Sha(string path) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    [Fact]
    public void ABlockIsDecidedByTheThemesOfThePagesThatShowItAndAPageSaysTheMarkedBlocksItPlaces()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 4, N1 (verify\m7b\job-blockflow.json, verify\r4\new\job-blockedit.json): a block was decided by the theme of its
        // own flow, not by the themes of the pages that show it. Placed only on a page whose flow shows a theme of another module,
        // its links were marked and said GUTTER_ZEROED_IN_GAP while the gap and the gutter add up there; the page said "no marker
        // ... is written on the page" while it carries the block's.
        var host = Host("n1");
        var basePath = Path.Combine(Work, "n1", "base.oml");
        var made = RunCatching(host, null, Job(new JsonArray(
            CreateOp("IMobileFlow", "VzForeignFlow", "$foreign"), SetOp("$foreign", "Theme", "MobileThemeSignature:OutSystemsUI"),
            Op(GapBlock), Logic("VzGapBlock"), Op(HostScreen("VzHost", "VzForeignFlow", "VzGapBlock"))), "n1"), basePath);
        Assert.True(made["accepted"]?.GetValue<bool>() ?? false, made.ToJsonString());
        var hostNotes = NormalizedOf(made, "VzHost");
        output.WriteLine("VzHost: " + Dump(hostNotes));
        // The page says the marked block it places: its markers have no effect there.
        var unreached = hostNotes.Single(n => n["code"]?.ToString() == ScreenVisual.ThemeNativeLayout);
        Assert.False(unreached["written"]!.GetValue<bool>());
        Assert.Contains("VzGapBlock", unreached.ToJsonString());
        // An edit of the block, now shown by that page only: decided by the page's theme, nothing marked, never GUTTER_ZEROED_IN_GAP.
        var read = host.HtmlRead(File.ReadAllBytes(basePath), "VzGapBlock", withKeys: true)["documents"]![0]!.AsObject();
        output.WriteLine(read["html"]!.ToString());
        var editPath = Path.Combine(Work, "n1", "edit.oml");
        var edited = RunCatching(host, basePath, Job(new JsonArray(EditOf("VzGapBlock", Sha(basePath), read,
            "<div k=\"w1\" class=\"gb\"><a k=\"w2\" onclick=\"Go\">One</a><a k=\"w3\" onclick=\"Go\" data-ssam-gap=\"1\">Two</a><a onclick=\"Go\">Three</a></div>")), "n1-edit"), editPath);
        Assert.True(edited["accepted"]?.GetValue<bool>() ?? false, edited.ToJsonString());
        var editNotes = NormalizedOf(edited, "VzGapBlock");
        output.WriteLine("edit: " + Dump(editNotes));
        Assert.Equal(0, CountOf(editNotes, ScreenVisual.GutterZeroedInGap));
        Assert.True(CountOf(editNotes, GutterAddsToGap) >= 1);
        var after = host.HtmlRead(File.ReadAllBytes(editPath), "VzGapBlock", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(after);
        Assert.DoesNotContain("data-ssam", after);

        // The block on two pages: one shows a theme of this module (the block reaches it), one a theme of another module. Marked for
        // the first, and the note says the page where the gap and the gutter add up.
        var mixedPath = Path.Combine(Work, "n1", "mixed.oml");
        var mixed = RunCatching(host, basePath, Job(new JsonArray(Op(HostScreen("VzHome", "", "VzGapBlock")),
            EditOf("VzGapBlock", Sha(basePath), read, "<div k=\"w1\" class=\"gb\"><a k=\"w2\" onclick=\"Go\">One</a><a k=\"w3\" onclick=\"Go\" data-ssam-gap=\"1\">Two</a><a onclick=\"Go\">Three</a></div>")), "n1-mixed"), mixedPath);
        Assert.True(mixed["accepted"]?.GetValue<bool>() ?? false, mixed.ToJsonString());
        var mixedNotes = NormalizedOf(mixed, "VzGapBlock");
        output.WriteLine("mixed: " + Dump(mixedNotes));
        var zeroed = mixedNotes.Single(n => n["code"]?.ToString() == ScreenVisual.GutterZeroedInGap);
        Assert.Contains("VzHost", zeroed.ToJsonString());
        Assert.True(Gap(host.HtmlRead(File.ReadAllBytes(mixedPath), "VzGapBlock", withKeys: false)["documents"]![0]!["html"]!.ToString(), "Three"));

        // Two pages of themes of this module that space the block's row differently: one refusal, never a marker right on one page
        // and wrong on the other.
        var twoPath = Path.Combine(Work, "n1", "two.oml");
        var two = RunCatching(host, null, Job(new JsonArray(
            CreateOp("IMobileTheme", "VzGapTheme", "$theme"), SetOp("$theme", "BaseTheme", "MobileThemeSignature:OutSystemsUI"), SetOp("$theme", "StyleSheet", ".fb{display:flex;gap:10px}\n"),
            CreateOp("IMobileFlow", "VzGapFlow", "$flow"), SetOp("$flow", "Theme", "$theme"),
            Op("<block name=\"VzFlatBlock\" actions=\"Go\" flow=\"VzGapFlow\">\n<style>.fb{display:flex}</style>\n<div class=\"fb\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a></div>\n</block>"), Logic("VzFlatBlock"),
            Op(HostScreen("VzGapPage", "VzGapFlow", "VzFlatBlock")), Op(HostScreen("VzFlatPage", "", "VzFlatBlock"))), "n1-two"), twoPath);
        Assert.True(two["accepted"]?.GetValue<bool>() ?? false, two.ToJsonString());
        var flat = host.HtmlRead(File.ReadAllBytes(twoPath), "VzFlatBlock", withKeys: true)["documents"]![0]!.AsObject();
        output.WriteLine(flat["html"]!.ToString());
        Assert.True(Gap(flat["html"]!.ToString(), "Two"));
        var diverge = RunCatching(host, twoPath, Job(new JsonArray(EditOf("VzFlatBlock", Sha(twoPath), flat, "<a k=\"w2\" onclick=\"Go\">OneRenamed</a>")), "n1-diverge"), Path.Combine(Work, "n1", "diverge.oml"));
        output.WriteLine("diverge: " + diverge.ToJsonString());
        Assert.False(diverge["accepted"]?.GetValue<bool>() ?? true);
        Assert.Contains("HTML_BLOCK_PAGES_DIVERGE", diverge.ToJsonString());
        Assert.Contains("VzGapPage", diverge.ToJsonString());
        Assert.Contains("VzFlatPage", diverge.ToJsonString());
    }

    // ---- review 4 (N2): a change of the theme a page shows is decided again and the block installed ---------------------------

    [Fact]
    public void EveryEditOfAPageOfTheOpPutsTheLayoutBlockInTheThemeItShowsNowOrDecidesItsMarkersAgain()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // Review 4, N2 (verify\m7c\job-later.json; verify\r4\new\job-switch.json then job-switch-edit.json): the edit forms installed
        // the block only when the plan added a marker. After the theme the page shows changed, the markers read stayed without a
        // block: one edit said GUTTER_ZEROED_IN_GAP with no effect, another left them without effect in silence.
        var host = Host("n2");
        var basePath = Path.Combine(Work, "n2", "qa.oml");
        var made = RunCatching(host, null, Job(new JsonArray(Op(QaScreen), Logic("QA")), "n2"), basePath);
        Assert.True(made["accepted"]?.GetValue<bool>() ?? false, made.ToJsonString());
        var read = host.HtmlRead(File.ReadAllBytes(basePath), "QA", withKeys: true)["documents"]![0]!.AsObject();
        Assert.True(Gap(read["html"]!.ToString(), "GapTwo"));
        var later = new JsonArray(CreateOp("IMobileTheme", "VzLaterTheme", "$t"), SetOp("$t", "StyleSheet", ".vz-later{color:inherit}\n"),
            SetOp("$t", "BaseTheme", "MobileThemeSignature:OutSystemsUI"), SetOp("IMobileFlow:MainFlow", "Theme", "$t"));
        // One job: the flow's theme changes, then an edit of a marked link. The new theme carries the block, said.
        var laterPath = Path.Combine(Work, "n2", "later.oml");
        var ops = later.DeepClone().AsArray();
        ops.Add(EditOf("QA", Sha(basePath), read, "<a k=\"w4\" onclick=\"Go\" data-ssam-gap=\"1\">GapTwoEdited</a>"));
        var one = RunCatching(host, basePath, Job(ops, "n2-later"), laterPath);
        Assert.True(one["accepted"]?.GetValue<bool>() ?? false, one.ToJsonString());
        var notes = NormalizedOf(one, "QA");
        output.WriteLine("later: " + Dump(notes));
        Assert.Contains(ScreenVisual.NativeLayoutBegin, ThemeCss(host, laterPath, "n2-later", "VzLaterTheme"));
        Assert.Contains(notes, n => n["code"]?.ToString() == ScreenVisual.ThemeNativeLayout && n["theme"]?.ToString() == "VzLaterTheme" && n["written"]?.GetValue<bool>() == true);
        // Two jobs: the switch alone, then an edit that only renames a link. The block is installed in the new theme, said.
        var switchPath = Path.Combine(Work, "n2", "switch.oml");
        var switched = RunCatching(host, basePath, Job(later.DeepClone().AsArray(), "n2-switch"), switchPath);
        Assert.True(switched["accepted"]?.GetValue<bool>() ?? false, switched.ToJsonString());
        var reread = host.HtmlRead(File.ReadAllBytes(switchPath), "QA", withKeys: true)["documents"]![0]!.AsObject();
        var renamePath = Path.Combine(Work, "n2", "rename.oml");
        var renamed = RunCatching(host, switchPath, Job(new JsonArray(EditOf("QA", Sha(switchPath), reread, "<a k=\"w3\" onclick=\"Go\">GapOneRenamed</a>")), "n2-rename"), renamePath);
        Assert.True(renamed["accepted"]?.GetValue<bool>() ?? false, renamed.ToJsonString());
        var renameNotes = NormalizedOf(renamed, "QA");
        output.WriteLine("rename: " + Dump(renameNotes));
        Assert.Contains(ScreenVisual.NativeLayoutBegin, ThemeCss(host, renamePath, "n2-rename", "VzLaterTheme"));
        Assert.Contains(renameNotes, n => n["code"]?.ToString() == ScreenVisual.ThemeNativeLayout && n["written"]?.GetValue<bool>() == true);
        // The flow now shows a theme of another module: every marker of the page is decided again (none has an effect), said.
        var foreignPath = Path.Combine(Work, "n2", "foreign.oml");
        var foreign = RunCatching(host, basePath, Job(new JsonArray(SetOp("IMobileFlow:MainFlow", "Theme", "MobileThemeSignature:OutSystemsUI"),
            EditOf("QA", Sha(basePath), read, "<a k=\"w3\" onclick=\"Go\">GapOneRenamed</a>")), "n2-foreign"), foreignPath);
        Assert.True(foreign["accepted"]?.GetValue<bool>() ?? false, foreign.ToJsonString());
        var foreignNotes = NormalizedOf(foreign, "QA");
        output.WriteLine("foreign: " + Dump(foreignNotes));
        var text = host.HtmlRead(File.ReadAllBytes(foreignPath), "QA", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(text);
        Assert.DoesNotContain("data-ssam", text);
        Assert.Equal(0, CountOf(foreignNotes, ScreenVisual.GutterZeroedInGap));
        Assert.True(CountOf(foreignNotes, MarkerDecided) >= 3);   // the gap marker of w4 and the page marker of w2 and w5
    }

    // ---- D1 of 2026-10-17 (the review of the CX17 merge, M1): F2 in every form that creates a widget -------------------------

    // The review's probe (C:\t\revisoes\cx17-juncao\probe\jx-probe.json): links and a button in a flex row with a gap, inputs, a
    // text area, a checkbox, a form, a List of a table and of a grid, a popup and a button with the author's class btn.
    private const string JxProbe = "<screen name=\"JxProbe\" roles=\"Registered\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Q\" type=\"Text\"/>\n"
        + "<var name=\"Ok\" type=\"Boolean\"/>\n<var name=\"Show\" type=\"Boolean\" default=\"False\"/>\n"
        + "<style>.jx-grid{display:grid;grid-template-columns:repeat(3,1fr)}.jx-row{display:flex;gap:12px}</style>\n"
        + "<Block name=\"LayoutBlank\"><slot name=\"Content\">\n"
        + "<div class=\"jx-row\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a><button onclick=\"Go\">Three</button></div>\n"
        + "<input bind=\"Q\" type=\"search\"/>\n<input bind=\"Q\" class=\"jx-mine\"/>\n<textarea bind=\"Q\"></textarea>\n"
        + "<label><input type=\"checkbox\" bind=\"Ok\"/> I agree</label>\n<button onclick=\"Go\">Go</button>\n<button class=\"btn\" onclick=\"Go\">Mine</button>\n"
        + "<form><label>Name</label><input bind=\"Q\"/></form>\n<table><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n"
        + "<div class=\"jx-grid\" list=\"Rows\"><p>{{ Rows.Current }}</p></div>\n<popup show=\"Show\"><div class=\"inside\">Inside</div></popup>\n"
        + "</slot></Block>\n</screen>\n";

    // The F2 entries of a form's answer for a root, summed per code and element.
    private static int ClassNotes(List<JsonObject> normalized, string code, string element) =>
        normalized.Where(n => n["code"]?.ToString() == code && n["element"]?.ToString() == element).Sum(n => n["count"]?.GetValue<int>() ?? 1);

    // Every line of a reading the edit did not change (an element as it was read, its class included) is in the reading after it,
    // as many times, wherever its k moved (a new element before it renumbers the k that follow).
    private static void ReadsBackAsRead(string before, string after, params string[] changed)
    {
        static Dictionary<string, int> Lines(string html) => Regex.Replace(html, " k=\"[^\"]*\"", "").Split('\n').GroupBy(l => l).ToDictionary(g => g.Key, g => g.Count());
        var now = Lines(after);
        foreach (var (line, count) in Lines(before))
            if (!changed.Any(c => line.Contains(c, StringComparison.Ordinal))) Assert.True(now.GetValueOrDefault(line) >= count, "not read back as read: " + line);
    }

    [Fact]
    public void ANewWidgetWithoutClassIsBornWithTheStudiosClassInEveryEditFormAndAnElementWithKKeepsItsOwn()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // M1 of the review of the CX17 merge (probe\edit-result.json): the html edit wrote a new <button> without class and a new
        // <textarea> without form-control, with no note, while the document form gives them btn and form-control. The owner's
        // decision D1 (2026-10-17): the same rule in every form that creates a widget without k and without class.
        var host = Host("d1-edit");
        var basePath = Path.Combine(Work, "d1-edit", "jx.oml");
        var made = RunCatching(host, null, Job(Ops(JxProbe, "JxProbe"), "d1-edit"), basePath);
        Assert.True(made["accepted"]?.GetValue<bool>() ?? false, made.ToJsonString());
        var sha = Sha(basePath);
        var read = host.HtmlRead(File.ReadAllBytes(basePath), "JxProbe", withKeys: true)["documents"]![0]!.AsObject();
        var html = read["html"]!.ToString();
        output.WriteLine(html);
        (string Text, string Keyed, List<JsonObject> Normalized, JsonObject Check) Run(string name, JsonObject op)
        {
            var outPath = Path.Combine(Work, "d1-edit", name + ".oml");
            var result = RunCatching(host, basePath, Job(new JsonArray(op), "d1-edit-" + name), outPath);
            Assert.True(result["accepted"]?.GetValue<bool>() ?? false, name + ": " + result.ToJsonString());
            var bytes = File.ReadAllBytes(outPath);
            var keyed = host.HtmlRead(bytes, "JxProbe", withKeys: true)["documents"]![0]!["html"]!.ToString();
            var normalized = NormalizedOf(result, "JxProbe");
            output.WriteLine(name + ": " + keyed);
            output.WriteLine(name + ": " + Dump(normalized));
            var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "JxProbe")!.AsObject();
            return (Regex.Replace(keyed, " k=\"[^\"]*\"", ""), keyed, normalized, check);
        }
        void Kept((string Text, string Keyed, List<JsonObject> Normalized, JsonObject Check) after, params string[] changed)
        {
            // Every element of the reading the edit did not change reads back as it was read (its class included); the fixed point holds.
            ReadsBackAsRead(html, after.Keyed, changed);
            Assert.Equal(0, after.Check["ops"]!.GetValue<int>());
            Assert.Equal(0, after.Check["problemCount"]!.GetValue<int>());
        }
        // (1) The review's repro: the whole document (html) with a new button and a new text area in a new div before the slot ends.
        var whole = html.Replace(" </slot>\n</Block>", "  <button onclick=\"Go\">NewOne</button>\n  <div class=\"jx-row2\"><textarea bind=\"Q\"></textarea></div>\n </slot>\n</Block>");
        Assert.NotEqual(html, whole);
        var document = Run("html", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "JxProbe",
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() }, ["html"] = whole } });
        Assert.Contains("<button class=\"btn\" onclick=\"Go\">NewOne</button>", document.Text);
        Assert.Matches("<div class=\"jx-row2\">\\s*<textarea [^>]*class=\"form-control\"", document.Text);
        Assert.Equal(1, ClassNotes(document.Normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, ClassNotes(document.Normalized, ScreenVisual.StudioClassKept, "TextArea"));
        Assert.Contains(document.Normalized, n => n["code"]?.ToString() == ScreenVisual.StudioClassTrimmed && n["note"]!.ToString().Contains("the reading writes it as class=\"btn\"", StringComparison.Ordinal));
        Assert.Contains(document.Normalized, n => n["code"]?.ToString() == ScreenVisual.StudioClassKept && n["note"]!.ToString().Contains("the reading writes it as class=\"form-control\"", StringComparison.Ordinal));
        Kept(document);
        // (2) The edit form: the flex row with its gap, a new button and a new text area in it, and the class of its button with k
        // dropped by the author. The new button takes btn and the gap marker of the engine; the element with k keeps what its text
        // says (no class), never F2.
        var rowK = Regex.Match(html, "<div k=\"(w\\d+)\" class=\"jx-row\"").Groups[1].Value;
        var row = Regex.Match(html, "(?s)  <div k=\"" + rowK + "\" class=\"jx-row\".*?\n  </div>").Value;
        var threeK = Regex.Match(row, "<button k=\"(w\\d+)\" class=\"btn\"").Groups[1].Value;
        Assert.NotEqual("", threeK);
        var rowEdit = row.Replace("<button k=\"" + threeK + "\" class=\"btn\"", "<button k=\"" + threeK + "\"")
            .Replace("\n  </div>", "\n   <button onclick=\"Go\">Four</button>\n   <textarea bind=\"Q\"></textarea>\n  </div>");
        var edit = Run("edit", EditOf("JxProbe", sha, read, rowEdit));
        Assert.Matches("<button class=\"btn\" onclick=\"Go\" data-ssam-gap=\"1\">Four</button>", edit.Text);
        Assert.Matches("<button k=\"" + threeK + "\" onclick=\"Go\" data-ssam-gap=\"1\">Three</button>", edit.Keyed);
        Assert.Equal(1, ClassNotes(edit.Normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, ClassNotes(edit.Normalized, ScreenVisual.StudioClassKept, "TextArea"));
        Assert.Equal(2, Regex.Matches(edit.Text, "<textarea [^>]*class=\"form-control\"").Count);
        Kept(edit, ">Three</button>");
        // (3) The element edits form: into the layout's slot (the review's place) and before the author's button with class btn.
        var block = Regex.Match(html, "<Block k=\"(w\\d+)\" name=\"LayoutBlank\"").Groups[1].Value;
        var mineK = Regex.Match(html, "<button k=\"(w\\d+)\" class=\"btn\" onclick=\"Go\"[^>]*>Mine</button>").Groups[1].Value;
        var elements = Run("edits", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "JxProbe",
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(
                new JsonObject { ["into"] = block + "/Content", ["insert"] = "<form><input bind=\"Q\"/></form>" },
                new JsonObject { ["before"] = mineK, ["insert"] = "<button onclick=\"Go\">Five</button><button class=\"mine\" onclick=\"Go\">Six</button>" }) } });
        Assert.Contains("<button class=\"btn\" onclick=\"Go\">Five</button>", elements.Text);
        Assert.Contains("<button class=\"mine\" onclick=\"Go\">Six</button>", elements.Text);         // the author's class wins
        Assert.Matches("<form [^>]*class=\"form\"[^>]*>\\s*<input [^>]*class=\"form-control\"", elements.Text);
        Assert.Equal(1, ClassNotes(elements.Normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, ClassNotes(elements.Normalized, ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Equal(1, ClassNotes(elements.Normalized, ScreenVisual.StudioClassKept, "Input"));
        Kept(elements);
    }

    [Fact]
    public void AFragmentIntoAParentGivesItsNewWidgetsTheStudiosClassSaidLikeEveryOtherForm()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // D1 (2026-10-17): the fragment form (html {parent}) kept the full class the Studio gives (btn btn-primary, form card) with no
        // note. The same rule as the document: btn and form trimmed, form-control kept, the author's class as written, each said.
        var host = Host("d1-fragment");
        var basePath = Path.Combine(Work, "d1-fragment", "jx.oml");
        var made = RunCatching(host, null, Job(Ops(JxProbe, "JxProbe"), "d1-fragment"), basePath);
        Assert.True(made["accepted"]?.GetValue<bool>() ?? false, made.ToJsonString());
        var before = host.HtmlRead(File.ReadAllBytes(basePath), "JxProbe", withKeys: true)["documents"]![0]!["html"]!.ToString();
        var outPath = Path.Combine(Work, "d1-fragment", "out.oml");
        var fragment = new JsonObject { ["op"] = "html", ["parent"] = "MobileScreen:JxProbe",
            ["html"] = "<div class=\"jx-frag\"><button onclick=\"Go\">Frag</button><textarea bind=\"Q\"></textarea><form><input bind=\"Q\"/></form><button class=\"mine\" onclick=\"Go\">Own</button></div>" };
        var result = RunCatching(host, basePath, Job(new JsonArray(fragment), "d1-fragment-op"), outPath);
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Single(r => r["parent"] != null);
        var normalized = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
        output.WriteLine(Dump(normalized));
        var bytes = File.ReadAllBytes(outPath);
        var keyed = host.HtmlRead(bytes, "JxProbe", withKeys: true)["documents"]![0]!["html"]!.ToString();
        var text = Regex.Replace(keyed, " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        Assert.Matches("<button [^>]*class=\"btn\"[^>]*>Frag</button>", text);
        Assert.Matches("<div [^>]*class=\"jx-frag\">[\\s\\S]*<textarea [^>]*class=\"form-control\"", text);
        Assert.Matches("<form [^>]*class=\"form\"", text.Split("jx-frag")[1]);
        Assert.Matches("<button [^>]*class=\"mine\"[^>]*>Own</button>", text);
        Assert.DoesNotContain("btn-primary", text.Split("jx-frag")[1]);
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassKept, "TextArea"));
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassKept, "Input"));
        ReadsBackAsRead(before, keyed);
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "JxProbe")!;
        Assert.Equal(0, check["ops"]!.GetValue<int>());
    }

    [Fact]
    public void ANewWidgetOnAScreenOfTheStudioTakesItsClassAndNothingElseOfThatScreenChanges()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // D1 on a screen made in the Studio (no marker of the engine): the new button the edit writes is born with btn, said; no
        // marker, no layout block in the theme, and every element of the screen reads back as it was read.
        var host = Host("d1-studio");
        var basePath = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var bytes = File.ReadAllBytes(basePath);
        var read = host.HtmlRead(bytes, "InvalidPermissions", withKeys: true)["documents"]![0]!.AsObject();
        var html = read["html"]!.ToString();
        Assert.DoesNotContain("data-ssam-", html);
        var div = Regex.Match(html, "<div k=\"(w\\d+)\">\\s*<text ").Groups[1].Value;
        Assert.NotEqual("", div);
        var outPath = Path.Combine(Work, "d1-studio", "out.oml");
        var result = RunCatching(host, basePath, Job(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "InvalidPermissions",
            ["basedOn"] = new JsonObject { ["capture"] = Sha(basePath), ["html"] = read["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(new JsonObject { ["into"] = div, ["insert"] = "<button onclick=\"MobileScreen:Login\">StudioNew</button>" }) } }), "d1-studio"), outPath);
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        var normalized = NormalizedOf(result, "InvalidPermissions");
        output.WriteLine(Dump(normalized));
        var after = host.HtmlRead(File.ReadAllBytes(outPath), "InvalidPermissions", withKeys: true)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(after);
        Assert.Matches("<button k=\"w\\d+\" class=\"btn\" onclick=\"MobileScreen:Login\">StudioNew</button>", after);
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.DoesNotContain("data-ssam-", after);
        Assert.DoesNotContain(ScreenVisual.ThemeNativeLayout, result.ToJsonString());
        ReadsBackAsRead(html, after);
    }

    [Fact]
    public void AnEmptyClassInAFragmentIsTheAuthorsEmptyClassAsInTheDocumentAndTheEditForms()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        // M2 of the review of the M1 fix (k-probes\f2-empty-class-job.json): class="" in a fragment wrote nothing, so the widget kept
        // the class the Studio gave it (form card) with no note, while the document and the edit forms read class="" back. The
        // empty class is the author's in every form; a widget without class still takes F2, said. The block of the Studio has no
        // button: the Studio gives the first one btn btn-primary, and the rule writes btn (review B6).
        var host = Host("m2-fragment");
        var basePath = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var before = host.HtmlRead(File.ReadAllBytes(basePath), "MobileBlock:UserInfo", withKeys: true)["documents"]![0]!["html"]!.ToString();
        Assert.DoesNotContain("<button", before);
        var outPath = Path.Combine(Work, "m2-fragment", "out.oml");
        var fragment = new JsonObject { ["op"] = "html", ["parent"] = "MobileBlock:UserInfo",
            ["html"] = "<div class=\"m2-frag\"><button onclick=\"ClientLogout\">Bare</button><form>Hi</form><button class=\"\" onclick=\"ClientLogout\">Empty</button><form class=\"\">Ho</form></div>" };
        var result = RunCatching(host, basePath, Job(new JsonArray(fragment), "m2-fragment"), outPath);
        Assert.True(result["accepted"]?.GetValue<bool>() ?? false, result.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Single(r => r["parent"] != null);
        var normalized = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
        output.WriteLine(Dump(normalized));
        var bytes = File.ReadAllBytes(outPath);
        var keyed = host.HtmlRead(bytes, "MobileBlock:UserInfo", withKeys: true)["documents"]![0]!["html"]!.ToString();
        var text = Regex.Replace(keyed, " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        var part = text[text.IndexOf("m2-frag", StringComparison.Ordinal)..];
        Assert.Matches("<button [^>]*class=\"\"[^>]*>Empty</button>", part);
        Assert.Matches("<form [^>]*class=\"\"[^>]*>Ho</form>", part);
        Assert.Matches("<button [^>]*class=\"btn\"[^>]*>Bare</button>", part);
        Assert.Matches("<form [^>]*class=\"form\"[^>]*>Hi</form>", part);
        Assert.DoesNotContain("btn-primary", part);
        Assert.DoesNotContain("card", part);
        // Only the widgets without class are said, and the button's note says what the Studio gave it.
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, ClassNotes(normalized, ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Contains("the Studio gives it \"btn btn-primary\"", normalized.Single(n => n["element"]?.ToString() == "Button")["note"]!.ToString());
        ReadsBackAsRead(before, keyed);
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "UserInfo")!;
        Assert.Equal(0, check["ops"]!.GetValue<int>());
        Assert.Equal(0, check["problemCount"]!.GetValue<int>());
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------------

    private static JsonObject Logic(string root) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action " + root + ".Go\n  end\n") } };

    // A job run with its refusal as data: accepted false, the code and the problems.
    private JsonObject RunCatching(ModelHost host, string? basePath, string job, string outPath)
    {
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, outPath))!.AsObject(); }
        catch (Exception error)
        {
            var coded = Errors.FindCoded(error);
            output.WriteLine("refused: " + Errors.Text(error)[..Math.Min(1500, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    // The ops with the patches of the problems applied (each a JSON Patch on /ops/<i>/...: replace or add).
    private static JsonArray ApplyPatches(JsonArray ops, IEnumerable<JsonObject> problems)
    {
        var copy = ops.DeepClone().AsArray();
        foreach (var edit in problems.SelectMany(p => p["patch"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var path = edit["path"]!.ToString().Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (path[0] == "ops") path = path[1..];
            JsonNode target = copy;
            foreach (var part in path[..^1]) target = target is JsonArray a ? a[int.Parse(part)]! : target[part]!;
            if (target is JsonObject o) o[path[^1]] = edit["value"]!.DeepClone();
        }
        return copy;
    }

    private static JsonObject LayoutNote(JsonObject result, string root) =>
        (result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["root"]?.ToString() == root)["normalized"] as JsonArray ?? [])
            .Select(n => n!.AsObject()).Single(n => n["code"]!.ToString() == ScreenVisual.ThemeNativeLayout);


    private static string ThemeCss(ModelHost host, string model, string name, string theme)
    {
        var dir = Path.Combine(Work, name);
        var get = Path.Combine(dir, "theme-get.json");
        File.WriteAllText(get, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "get", ["target"] = "IMobileTheme:" + theme }) }.ToJsonString());
        var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, model, get, Path.Combine(dir, "theme-get.oml")))!;
        var result = read["results"]![0]!["result"]!;
        return result["properties"]?["StyleSheet"]?.ToString() ?? result["StyleSheet"]?.ToString() ?? "";
    }

    private static JsonObject Op(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    // The document and the logic op that declares its screen action Go.
    private static JsonArray Ops(string html, string root) =>
        new(Op(html), new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action " + root + ".Go\n  end\n") } });

    private static string Job(JsonArray ops, string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        return path;
    }

    private static ModelHost Host(string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        return new ModelHost(dir);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
