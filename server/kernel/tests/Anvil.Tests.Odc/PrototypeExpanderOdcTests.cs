using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>
/// The compile lane on ODC (docs/PROTOTIPO-NATIVO.md 7.2 test 7, 3.6): the same capture gives the same widgets on both platforms,
/// with the tags ODC's HTML Element does not accept (main, data, picture) substituted by the shared table, and anonymous access as
/// each platform says it (O11 role Anonymous, ODC AnonymousAccess). The minimal capture is also applied headless over the ODC
/// Reactive fixture, and the defaults table of ODC is compared with the installed ODC Model API. The element map of the html lane
/// is a fake here (the same rules as the O11 tests' fake, with the platform's tag list). Needs the ODC Studio installed; without it
/// the tests return without asserting.
/// </summary>
public class PrototypeExpanderOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static string Fixtures => Path.Combine(Root, "tests", "Anvil.Tests", "Fixtures", "prototype");
    private static string FarmaVirtual => Path.Combine(Fixtures, "farmavirtual.capture.json");
    private static string Minimal => Path.Combine(Fixtures, "minimal.capture.json");
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "proto-odc-tests");

    private static readonly HashSet<string> O11Tags = new(("a abbr address area article aside audio b bdi bdo blockquote button canvas caption cite code col colgroup command data datalist dd del details dfn div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins kbd keygen label legend li link main map mark menu meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp section select small source span strong style sub summary sup table tbody td textarea tfoot th thead time tr track u ul var video wbr").Split(' '), StringComparer.Ordinal);
    private static readonly HashSet<string> OdcTags = new(O11Tags.Where(t => t is not ("data" or "main" or "picture")), StringComparer.Ordinal);

    /// <summary>The element map of 3.2 as a fake (the html lane owns the real one).</summary>
    private static ElementMapping Element(ElementRequest r)
    {
        string? Attr(string name) => r.Attributes.FirstOrDefault(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase)).Value;
        var classes = (Attr("class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var id = Attr("id");
        var consumed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "class", "id" };
        var props = new List<(string, string)>();
        string widget; string? tag = null; string? substituted = null;
        if (r.Icon) { widget = "IAdvancedHtml"; tag = "span"; }
        else
            switch (r.Tag)
            {
                case "button":
                    widget = "IButton"; consumed.UnionWith(["type", "disabled"]);
                    if (Attr("disabled") != null) props.Add(("Enabled", "False"));
                    if (Attr("type") == "submit") { props.Add(("IsDefault", "True")); classes.Add("ssam-submit"); }
                    break;
                case "a": widget = "ILink"; if (Attr("href") is { } href && href.StartsWith('#')) consumed.Add("href"); break;
                case "form": widget = "IForm"; break;
                case "input" when Attr("type") == "checkbox": widget = "ICheckbox"; consumed.UnionWith(["type", "checked", "value"]); break;
                case "input":
                    widget = "IInput"; consumed.UnionWith(["type", "value", "placeholder", "maxlength", "required"]);
                    props.Add(("InputType", Attr("type") switch { "search" => "Search", "number" => "Number", "email" => "Email", _ => "Text" }));
                    if (Attr("placeholder") is { } ph) props.Add(("Prompt", PrototypeExpr.Quote(ph)));
                    if (Attr("maxlength") is { } ml) props.Add(("MaxLength", ml));
                    if (Attr("required") != null) props.Add(("Mandatory", "True"));
                    break;
                case "textarea": widget = "ITextArea"; consumed.UnionWith(["placeholder", "maxlength", "required", "value"]); break;
                case "select": widget = "IDropdown"; consumed.UnionWith(["required", "value"]); break;
                case "label" when !r.HasElementChildren && Attr("for") != null: widget = "ILabel"; consumed.Add("for"); break;
                case "img": widget = "IImage"; consumed.Add("src"); break;
                case "div" when !r.Clickable: widget = "IContainer"; break;
                default:
                    if (!(r.Platform == "odc" ? OdcTags : O11Tags).Contains(r.Tag))
                    {
                        substituted = r.Tag;
                        tag = r.Tag is "data" or "picture" ? "span" : "div";
                        classes.Add(PrototypeNames.TagClass(r.Tag));
                        widget = tag == "div" && !r.Clickable ? "IContainer" : "IAdvancedHtml";
                    }
                    else { widget = "IAdvancedHtml"; tag = r.Tag; }
                    break;
            }
        // like the real map (ElementWidgetMap), an extended value is what a set op writes: the quoted literal
        var extended = r.Attributes.Where(a => !consumed.Contains(a.Name) && !a.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase)).Select(a => (a.Name, PrototypeExpr.Quote(a.Value))).ToList();
        if (substituted == "main") extended.Add(("role", PrototypeExpr.Quote("main")));
        return new ElementMapping(widget, tag, id is { Length: > 0 } ? PrototypeNames.WidgetName(id) : null, props, extended, classes, substituted, null);
    }

    private static PrototypeCssResult Css(PrototypeCssRequest request)
    {
        var sheets = (request.Capture["css"]?["sheets"] as JsonArray ?? []).OfType<JsonObject>().OrderBy(s => s["order"]?.GetValue<int>() ?? 0);
        return new PrototypeCssResult(string.Join("\n", sheets.Select(s => File.ReadAllText(Path.Combine(request.BundleRoot, s["bundle"]!.ToString())))), new Dictionary<string, string>(), new JsonObject { ["fake"] = true });
    }

    private static PrototypeExpander.Seams Seams => new(Element, Css, PrototypeBuilder.ReadBack);

    /// <summary>FarmaVirtual planned on ODC with this class's fakes (ScreenHtmlDataTableOdcTests reads its tables).</summary>
    internal static PrototypePlan PlanFarmaVirtual() => Plan(FarmaVirtual, "odc");

    /// <summary>A capture planned on ODC with this class's fakes (ScreenHtmlDataTableOdcTests: FarmaVirtual's tables with spans).</summary>
    internal static PrototypePlan PlanCapture(string capture) => Plan(capture, "odc");

    private static PrototypePlan Plan(string capture, string platform)
    {
        var problems = new List<PrototypeCapture.Problem>();
        var c = PrototypeCapture.Load(new JsonObject { ["source"] = "C:\\fixture\\" + Path.GetFileName(capture).Split('.')[0], ["capture"] = capture }, problems);
        Assert.True(problems.Count == 0, string.Join("\n", problems.Select(p => p.Message)));
        var plan = PrototypeExpander.Plan(c!, PrototypeModule.Empty(platform, "Haiku_UI"), Seams);
        Assert.Empty(plan.Problems);
        return plan;
    }

    private static IEnumerable<(WidgetNode Node, PrototypeWidgetSpec Spec)> Widgets(PrototypePlan plan)
    {
        foreach (var job in plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>())
        {
            var stack = new Stack<WidgetNode>(job.Roots.Reverse());
            while (stack.Count > 0)
            {
                var n = stack.Pop();
                yield return (n, job.Specs.GetValueOrDefault(n) ?? new PrototypeWidgetSpec());
                foreach (var c in (n.Else ?? []).Reverse()) stack.Push(c);
                foreach (var c in n.Children.Reverse()) stack.Push(c);
            }
        }
    }

    private static Dictionary<string, string> Tags(PrototypeCapture capture)
    {
        var tags = new Dictionary<string, string>(StringComparer.Ordinal);
        void Walk(JsonNode? n)
        {
            if (n is not JsonObject o) return;
            if (o["k"]?.ToString() is { } k && o["t"]?.ToString() is { } t) tags[k] = t;
            foreach (var c in o["c"] as JsonArray ?? []) Walk(c);
            foreach (var c in o["else"] as JsonArray ?? []) Walk(c);
            Walk(o["list"]?["template"]);
            Walk(o["toast"]?["template"]);
        }
        foreach (var v in capture.Views) Walk(v["root"]);
        foreach (var m in capture.Modals) Walk(m["root"]);
        if (capture.Shell != null) { Walk(capture.Shell["root"]); foreach (var a in capture.Shell["after"] as JsonArray ?? []) Walk(a); }
        return tags;
    }

    [Fact]
    public void TheSameCaptureGivesTheSameWidgetsOnO11AndOdcWithMainSubstitutedAndEachPlatformsAnonymousAccess()
    {
        if (!StudioAvailable()) return;
        SameWidgets();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void SameWidgets()
    {
        var o11 = Plan(FarmaVirtual, "o11");
        var odc = Plan(FarmaVirtual, "odc");
        var tags = Tags(o11.Capture);
        var a = Widgets(o11).ToList();
        var b = Widgets(odc).ToList();
        Assert.Equal(a.Count, b.Count);
        var substituted = 0;
        for (var i = 0; i < a.Count; i++)
        {
            var (x, xs) = a[i];
            var (y, ys) = b[i];
            Assert.Equal(x.K, y.K);
            Assert.Equal(xs.Name, ys.Name);
            Assert.Equal(xs.Handler?.Action, ys.Handler?.Action);
            Assert.Equal(xs.Handler?.Screen, ys.Handler?.Screen);
            var original = x.K != null && tags.TryGetValue(x.K, out var t) ? t : null;
            if (original is "main" or "data" or "picture" && x.W == "IAdvancedHtml" && x.Tag == original)
            {
                // O11 keeps the tag; ODC takes the substitute of the table, with ssam-tag-<tag> (and role=main for main)
                substituted++;
                Assert.NotEqual(original, y.Tag);
                Assert.Contains(PrototypeNames.TagClass(original), (y.Style ?? "") + " " + ys.Properties.LastOrDefault(p => p.Property == "Style").Value);
                if (original == "main") Assert.Contains(ys.Extended, e => e.Name == "role" && e.Value == "\"main\"");
                continue;
            }
            Assert.Equal(x.W, y.W);
            Assert.Equal(x.Tag, y.Tag);
            Assert.Equal(xs.Properties.Where(p => p.Property != "Style"), ys.Properties.Where(p => p.Property != "Style"));
        }
        Assert.True(substituted > 0, "the FarmaVirtual capture has main elements: ODC substitutes them");
        Assert.Contains("main", odc.SubstitutedTags);
        Assert.DoesNotContain("main", o11.SubstitutedTags);
        // anonymous access: O11 role Anonymous, ODC AnonymousAccess, on every screen
        var o11Ops = o11.Steps.SelectMany(s => s.Ops ?? []).ToList();
        var odcOps = odc.Steps.SelectMany(s => s.Ops ?? []).ToList();
        foreach (var screen in o11.Screens.Values)
        {
            var reference = o11.OwnerRefs[screen];
            Assert.Contains(o11Ops, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == reference && o["prop"]?.ToString() == "Roles" && o["value"]!.ToJsonString().Contains("IRole:Anonymous"));
            Assert.DoesNotContain(o11Ops, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == reference && o["prop"]?.ToString() == "AnonymousAccess");
            Assert.Contains(odcOps, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == odc.OwnerRefs[screen] && o["prop"]?.ToString() == "AnonymousAccess" && o["value"]!.ToJsonString() == "true");
            Assert.DoesNotContain(odcOps, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == odc.OwnerRefs[screen] && o["prop"]?.ToString() == "Roles");
        }
        // the image URL of the CSS follows each platform's rule over the module name (3.6)
        Assert.All(odc.AssetUrls.Values, u => Assert.StartsWith("/Haiku_UI/img/Haiku_UI.", u));
        output.WriteLine($"{a.Count} widgets on both platforms, {substituted} substituted on ODC");
    }

    [Fact]
    public void TheMinimalCaptureAppliesHeadlessOnTheOdcReactiveFixtureWithoutVerifyErrors()
    {
        if (!StudioAvailable()) return;
        ApplyOdc();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void ApplyOdc()
    {
        var dir = Path.Combine(Work, "minimal-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        // a private copy of the bundles: the kernel writes prototype-dom.json beside the capture
        foreach (var file in Directory.GetFiles(Fixtures, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dir, "bundle", Path.GetRelativePath(Fixtures, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
        }
        var capture = Path.Combine(dir, "bundle", "minimal.capture.json");
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject
        {
            ["description"] = "prototype compile lane, ODC", ["expectValid"] = true,
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "prototype", ["data"] = new JsonObject { ["source"] = "C:\\fixture\\minimal", ["capture"] = capture } }),
        }.ToJsonString());
        var baseOml = Path.Combine(dir, "base.oml");
        File.Copy(Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml"), baseOml, true);
        var host = new ModelHost(dir);
        var result = PrototypeExpander.WithSeams(Seams, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, baseOml, job, Path.Combine(dir, "candidate.oml")))!.AsObject());
        var errors = (result["details"] as JsonArray ?? []).Select(d => d!.ToString()).Where(d => d.StartsWith("Error", StringComparison.Ordinal)).ToList();
        File.WriteAllText(Path.Combine(Work, "odc-apply-result.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(result["isValid"]!.GetValue<bool>() && result["accepted"]!.GetValue<bool>(), string.Join(" | ", errors.Take(10)) + " " + result["policyMessages"]?.ToJsonString());
        Assert.Empty(errors);
        var report = result["results"]!.AsArray().OfType<JsonObject>().Single(r => r["op"]?.ToString() == "prototype")["result"]!["prototype"]!;
        Assert.Empty(report["builder"]!["problems"]!.AsArray());
        var dom = JsonNode.Parse(File.ReadAllText(report["nativeDom"]!["path"]!.ToString()))!;
        Assert.Equal("odc", dom["platform"]!.ToString());
        output.WriteLine($"ODC apply {result["timings"]?["sessionApplyMs"]} ms, {report["builder"]!["widgets"]} widgets, {result["messages"]} messages");
    }

    [Fact]
    public void TheOdcWidgetDefaultsTableEqualsWhatTheInstalledOdcModelApiCreates()
    {
        if (!StudioAvailable()) return;
        Defaults();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Defaults()
    {
        var dir = Path.Combine(Work, "defaults-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var copy = Path.Combine(dir, "insurance-reactive-r8.oml");
        File.Copy(Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml"), copy, true);
        var observed = PrototypeWidgetDefaults.Observe(copy, dir, "odc");
        output.WriteLine(observed.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var diff = PrototypeWidgetDefaults.Diff(observed, "odc");
        Assert.True(diff.Count == 0, "PrototypeWidgetDefaults (odc) differs from the installed ODC Model API:\n" + string.Join("\n", diff));
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(PrototypeExpanderOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
