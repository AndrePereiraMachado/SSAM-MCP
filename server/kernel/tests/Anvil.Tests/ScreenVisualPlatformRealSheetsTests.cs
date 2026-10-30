using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>A test that needs the platform's REAL sheets of the private store (ANVIL_RUNTIME_CSS_DIR, the OutSystems UI theme of
/// Studio 11.55.92): skipped, with the reason, on a machine without them; never a pass that checked nothing (F10).</summary>
public sealed class RealSheetsFactAttribute : FactAttribute
{
    public RealSheetsFactAttribute(bool needsStudio = false)
    {
        if (Environment.GetEnvironmentVariable(RuntimeCss.EnvRoot) is not { Length: > 0 } root) { Skip = $"no {RuntimeCss.EnvRoot}: the platform's real sheets are not on this machine"; return; }
        if (RuntimeCss.Load("o11", "11.55.92", root).Sheets.All(s => s.Id != "osui")) { Skip = $"the store at {RuntimeCss.EnvRoot} has no OutSystems UI sheet for o11 11.55.92"; return; }
        if (needsStudio && !ScreenVisualPlatformRealSheetsTests.StudioAvailable()) Skip = "no Service Studio: the fixtures are not read";
    }
}

/// <summary>R3-A: the visual check with the platform's REAL sheets of the private store (the OutSystems files are never in the
/// repository): a synthetic page with the OutSystems UI menu class, and the Studio's own templates, which publish right and so
/// must give no warning (zero false positives), with the time each costs.</summary>
public sealed class ScreenVisualPlatformRealSheetsTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenVisualPlatformRealSheetsTests).Assembly.Location)!)!;

    internal static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }

    private static PlatformSheets Real() => RuntimeCss.Load("o11", "11.55.92", Environment.GetEnvironmentVariable(RuntimeCss.EnvRoot)!);

    [RealSheetsFact]
    public void TheRealOutSystemsUiMenuOffScreenAtTabletIsSaidOnlyWhenTheAuthorLaysItOut()
    {
        var platform = Real();
        output.WriteLine(platform.Describe().ToJsonString());
        ScreenVisual.CheckInput Page(string authorCss)
        {
            var html = "<screen name=\"Page\"><div id=\"ly\" class=\"layout\"><div id=\"m\" class=\"app-menu-content\"><a id=\"h\">Home</a></div><div id=\"mc\" class=\"main-content\"><h1 id=\"t\">Title</h1></div></div></screen>";
            var top = ScreenHtml.Parse(html).Children.First(c => !c.IsText);
            var map = new Dictionary<ScreenHtml.Node, DomNode>(ReferenceEqualityComparer.Instance);
            var author = ScreenVisual.AuthorDom(top, map);
            var nodes = new Dictionary<DomNode, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
            foreach (var (node, element) in map) nodes[element] = node;
            var byId = map.Values.Where(e => e.Attr("id") != null).ToDictionary(e => e.Attr("id")!, e => e, StringComparer.Ordinal);
            var fragment = DomNode.Fragment();
            var counterparts = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            DomNode El(DomNode parent, string tag, string? cls, string id, string key, params (string, string)[] attributes)
            {
                var e = parent.Add(DomNode.Element(tag));
                if (cls != null) e.SetAttr("class", cls);
                foreach (var (n, v) in attributes) e.SetAttr(n, v);
                e.ObjectKey = key;
                counterparts[byId[id]] = e;
                return e;
            }
            var layout = El(fragment, "div", "layout", "ly", "KLayout", ("data-container", ""));
            El(El(layout, "div", "app-menu-content", "m", "KMenu", ("data-container", "")), "a", null, "h", "KHome", ("data-link", ""), ("href", "#")).Add(DomNode.TextNode("Home"));
            El(El(layout, "div", "main-content", "mc", "KMain", ("data-container", "")), "h1", null, "t", "KTitle", ("data-advancedhtml", "")).Add(DomNode.TextNode("Title"));
            var sheets = ScreenVisual.PlatformSheetsOf(platform).Append(new ScreenVisual.Sheet(authorCss, "page")).ToList();
            return new ScreenVisual.CheckInput("Page", author, nodes, new ScreenVisual.Prediction { Root = fragment }, counterparts, sheets, "o11", html);
        }
        var watch = Stopwatch.StartNew();
        var plain = ScreenVisual.Check(Page(".main-content{padding:16px}"));
        var coldMs = watch.ElapsedMilliseconds;
        watch.Restart();
        var laidOut = ScreenVisual.Check(Page(".main-content{padding:16px}\n.app-menu-content{left:0;width:240px}"));
        output.WriteLine($"check: {coldMs} ms cold (the sheet parsed), {watch.ElapsedMilliseconds} ms warm; {platform.Sheets.Sum(s => s.Css.Length)} chars of platform CSS");
        foreach (var f in plain.Concat(laidOut)) output.WriteLine($"{f.Code} {f.Kind} [{string.Join(",", f.Viewports)}] {f.Subject} winner={f.Winner} property={f.Property} expect={f.Expect} not={f.ExpectNot}: {f.Why}");
        // the menu the theme hides at tablet and phone (its hamburger) is the theme's design
        Assert.DoesNotContain(plain, f => f.Code == ScreenVisual.PlatformFixedLayout);
        // the author who lays the menu out as always shown is told, with no patch that undoes the platform's menu
        var hidden = Assert.Single(laidOut, f => f.Code == ScreenVisual.PlatformFixedLayout && f.Kind == "hidden");
        Assert.Equal(["tablet", "phone"], hidden.Viewports);
        Assert.Contains("OutSystemsUI.OutSystemsUI.css", hidden.Winner);
        Assert.Contains(".app-menu-content", hidden.Winner);
        Assert.Empty(hidden.Candidates);
        Assert.Equal("-300px", ScreenVisual.ComputedForm("left", hidden.ExpectNot));
    }

    [RealSheetsFact(needsStudio: true)]
    public void TheStudioTemplatesGiveNoPlatformWarning()
    {
        // F1: the reactive and mobile templates publish right: every platform warning on them would be a false positive
        var platform = Real();
        var host = new ModelHost(Path.Combine(Root, ".local", "screen-visual-real-sheets"));
        var total = 0;
        foreach (var fixture in new[] { "reactive-ui.oml", "mobile-ui.oml" })
        {
            var path = Path.Combine(Root, "tests", "fixtures", fixture);
            Assert.True(File.Exists(path), path);
            var screens = Screens(host, path);
            Assert.NotEmpty(screens);
            var watch = Stopwatch.StartNew();
            var probes = new List<JsonObject>();
            foreach (var batch in screens.Chunk(RenderDocument.MaxDocuments))
            {
                var document = RenderDocument.FromOml(host, path, "o11", batch, ["desktop", "tablet", "phone"], platform, []);
                Assert.Empty(RenderDocument.Validate(document));
                probes.AddRange(document["probes"]!.AsArray().OfType<JsonObject>());
            }
            output.WriteLine($"{fixture}: {screens.Count} screens and blocks, {probes.Count} probes, {watch.ElapsedMilliseconds} ms");
            foreach (var p in probes) output.WriteLine("  " + p.ToJsonString());
            total += probes.Count(p => p["warning"]!.ToString() == ScreenVisual.PlatformFixedLayout);
        }
        Assert.Equal(0, total);
    }

    private static List<string> Screens(ModelHost host, string path)
    {
        var module = host.Load(path);
        try
        {
            var reader = new KernelModelReader();
            var top = (OutSystems.Model.IObjectSignature)module;
            return reader.ChildrenOf(top).Where(c => reader.KindOf(c) is "MobileFlow" or "WebFlow")
                .SelectMany(flow => reader.ChildrenOf(flow).Where(c => reader.KindOf(c) is "MobileScreen" or "MobileBlock"))
                .Select(r => reader.NameOf(r)).Distinct(StringComparer.Ordinal).ToList();
        }
        finally { ModelHost.Release(module); }
    }
}
