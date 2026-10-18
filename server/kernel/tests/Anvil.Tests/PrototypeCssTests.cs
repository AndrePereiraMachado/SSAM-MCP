using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>The css lane of the prototype importer (docs/PROTOTIPO-NATIVO.md 4.1, 4.2, 7.4): the theme stylesheet composed from the
/// FarmaVirtual bundle (verbatim, every rule, @import on top, the closed list of rewrites with their specificity), the icon mask
/// classes, the UA and adapter blocks in their order, and the wrapper-transparent rewrites decided on the compiled tree. No
/// Studio: pure functions over the fixture (an IR subset built from the owner's prototype: its styles.css byte for byte, the
/// icons of its own lucide.js, the trees of its 6 views and 5 modals).</summary>
public class PrototypeCssTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PrototypeCssTests).Assembly.Location)!)!;
    internal static readonly string Fixtures = Path.Combine(Root, "tests", "Anvil.Tests", "Fixtures", "prototype-css");
    private static readonly string Bundle = Path.Combine(Fixtures, "farmavirtual");
    private const string ProductsUrl = "/Haiku_UI/img/Haiku_UI.FarmaVirtualProducts.png";

    internal static JsonObject Capture() => JsonNode.Parse(File.ReadAllText(Path.Combine(Bundle, "capture.json")))!.AsObject();
    private static string Original(JsonObject capture) => File.ReadAllText(Path.Combine(Bundle, capture["css"]!["sheets"]![0]!["bundle"]!.ToString()));

    private static PrototypeCssRequest Request(JsonObject capture, string platform = "o11", IReadOnlyDictionary<string, WidgetNode>? roots = null,
        IReadOnlyList<string>? substituted = null, string? bundle = null) =>
        new(capture, bundle ?? Bundle, platform, "Haiku_UI", new Dictionary<string, string> { ["assets/products.png"] = ProductsUrl },
            new Dictionary<string, string>(), substituted ?? ["dialog"], roots ?? new Dictionary<string, WidgetNode>());

    private static RewriteOptions Options(string platform = "o11", params string[] substituted) => new()
    {
        Platform = platform, SubstitutedTags = substituted.ToHashSet(), RuntimeSpans = RuntimeDomTable.RuntimeSpans(platform),
    };

    private static string Section(string css, string from, string to)
    {
        var a = css.IndexOf(from, StringComparison.Ordinal); var b = css.IndexOf(to, StringComparison.Ordinal);
        Assert.True(a >= 0 && b > a, $"sections {from} .. {to} in order");
        return css[(a + from.Length)..b];
    }

    // ---- test 1: verbatim, every rule, @import on top, one asset rewrite, no scope -----------------------------------

    [Fact]
    public void FarmaVirtualStylesheetIsVerbatimWithEveryRuleAndTheImportOnTop()
    {
        var capture = Capture();
        var original = Original(capture);
        var result = PrototypeCss.Compose(Request(capture));
        var css = result.StyleSheet;

        // @import hoisted by the parser: the first statement of the theme, whole (the ';' inside the url did not cut it).
        Assert.StartsWith("@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;450;500;550;600;650;700&family=Manrope:wght@500;600;650;700;750;800&display=swap');\n", css);
        Assert.True(ThemeCss.ImportsFirst(css).Ok);
        Assert.Equal(1, Occurrences(css, "@import"));

        // Every rule, by the same parser: the sheet section has the original count minus the @import that moved up.
        var section = Section(css, "/* styles.css */\n", PrototypeCss.IconsMarker);
        var before = CssStylesheet.CountRules(original);
        Assert.Equal(before - 1, CssStylesheet.CountRules(section));
        Assert.Equal(CssStylesheet.Parse(original, lenient: true).Rules.Count, CssStylesheet.Parse(section, lenient: true).Rules.Count);
        Assert.Equal(before, result.Report["rules"]!.GetValue<int>());
        Assert.True(result.Report["verbatim"]!.GetValue<bool>());

        // One asset rewrite, one import hoist, and only kinds of the closed list.
        var counts = result.Report["rewrites"]!.AsArray().ToDictionary(r => r!["kind"]!.ToString(), r => r!["count"]!.GetValue<int>());
        Assert.Equal(1, counts["asset-url"]);
        Assert.Equal(1, counts["import-hoist"]);
        Assert.All(counts.Keys, k => Assert.Contains(k, PrototypeRewrites.Kinds));
        Assert.Contains("background-image:url('" + ProductsUrl + "')", section);
        Assert.DoesNotContain("assets/products.png", section);

        // :root, * and body intact; no scope prefix anywhere.
        Assert.Contains(":root{--green:#18765c;--green-dark:#10533f;", section);
        Assert.Contains("*{box-sizing:border-box;letter-spacing:0}body{margin:0}", section);
        Assert.Contains("@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important", section);
        Assert.DoesNotContain("fv-native-root", css);
        Assert.DoesNotContain(".app ", section);

        // Bytes equal outside the recorded rewrites, and the check is real: one byte off fails it.
        var rewrite = PrototypeRewrites.Rewrite(original, Options("o11", "dialog") with { });
        Assert.True(PrototypeRewrites.Verbatim(original, rewrite.Text, rewrite.Rewrites));
        Assert.False(PrototypeRewrites.Verbatim(original, rewrite.Text.Remove(rewrite.Text.Length / 2, 1), rewrite.Rewrites));
        Assert.False(PrototypeRewrites.Verbatim(original, rewrite.Text + " ", rewrite.Rewrites));
    }

    [Fact]
    public void TheThemeKeepsTheComposedStylesheetVerbatimWithTheImportFirst()
    {
        if (!StudioAvailable()) return;
        var css = PrototypeCss.Compose(Request(Capture())).StyleSheet;
        var host = new ModelHost(Path.Combine(Root, ".local", "prototype-css-tests"));
        // Reflection: this test project does not compile against the Studio's model types.
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml")])!;
        try
        {
            var theme = ModelHost.Prop(module, "DefaultMobileTheme")!;
            JsonObject? written = null;
            // One native command, as the job's apply runs the builder (Action<object> stands for Action<ESpace> by contravariance).
            typeof(IStudioRuntime).GetMethod("Mutate")!.Invoke(StudioAdapter.Runtime,
                [module, "prototype css verbatim", (Action<object>)(_ => written = ThemeCss.WriteThemeVerbatim(theme, css))]);
            var report = written!;
            Assert.True(report["verbatim"]!.GetValue<bool>(), report.ToJsonString());
            Assert.True(report["importsFirst"]!.GetValue<bool>(), report.ToJsonString());
            Assert.StartsWith("@import url('https://fonts.googleapis.com/", report["firstStatement"]!.ToString());
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }

    [Fact]
    public void TheRuntimeTableHoldsTheProvenRowsAndRoundTripsTheStage0Schema()
    {
        // CX17: IInput, IDropdown, ILabel and IList read on the published DemoLATAM_UI (2026-10-14): evidence now.
        var proven = new[] { "ILink", "IAdvancedHtml", "IContainer", "ITextWidget", "ICheckbox", "IMobileBlockInstanceWidget", "IInput", "IDropdown", "ILabel", "IList" };
        foreach (var row in RuntimeDomTable.Rows("o11"))
            Assert.Equal(proven.Contains(row.Widget) ? RuntimeStatus.Evidence : RuntimeStatus.Inferred, row.Status);
        Assert.All(RuntimeDomTable.Rows("odc"), row => Assert.Equal(RuntimeStatus.Inferred, row.Status));   // no ODC page read yet
        var checkbox = RuntimeDomTable.Row("o11", "ICheckbox")!;
        Assert.Equal("span", Assert.Single(checkbox.Wrappers).Tag);
        Assert.Empty(checkbox.Wrappers[0].Attributes);
        Assert.Equal("div.OSBlockWidget[data-block]", RuntimeDomTable.ElementSelector(RuntimeDomTable.Row("o11", "IMobileBlockInstanceWidget")!));
        Assert.Equal(("div.popup-backdrop", "div.popup-dialog[data-popup]"), RuntimeDomTable.Popup("o11"));
        // CX17: the input's span.input-<type> is a runtime span too (DemoLATAM_UI, 2026-10-14).
        Assert.Equal([":has(> [data-checkbox])", ":has(> [data-input])", "[data-expression]"], RuntimeDomTable.RuntimeSpans("o11"));
        Assert.Equal("span", Assert.Single(RuntimeDomTable.Row("o11", "IInput")!.Wrappers).Tag);
        Assert.Equal("div.dropdown-container[data-dropdown]", Assert.Single(RuntimeDomTable.Row("o11", "IDropdown")!.Wrappers).Selector);
        Assert.Equal("select.dropdown-display", RuntimeDomTable.ElementSelector(RuntimeDomTable.Row("o11", "IDropdown")!));
        var back = RuntimeDomTable.FromEvidence(RuntimeDomTable.ToJson("o11"));
        Assert.Equal(RuntimeDomTable.Rows("o11").Select(r => (r.Widget, r.Element, r.Status, r.Transparent, r.Wrappers.Count, r.Classes.Count)),
            back.Select(r => (r.Widget, r.Element, r.Status, r.Transparent, r.Wrappers.Count, r.Classes.Count)));
        Assert.Equal("ssam-runtime-dom/1", RuntimeDomTable.Schema()["schema"]!.ToString());
    }

    [Fact]
    public void ABundleSheetThatDiffersFromTheCaptureIsAnSsamDefectNeverTruncated()
    {
        var capture = Capture();
        capture["css"]!["sheets"]![0]!["sha256"] = new string('0', 64);
        var ex = Assert.Throws<KernelRefusalException>(() => PrototypeCss.Compose(Request(capture)));
        Assert.Equal("PROTOTYPE_IR_INVALID", ex.Code);
        Assert.True(ex.Problems![0]!["ssamDefect"]!.GetValue<bool>());
        Assert.Contains("sha256", ex.Message);
    }

    [Fact]
    public void TheAssetUrlIsTheModuleImageOnO11AndStaysUnconfirmedOnOdc()
    {
        var capture = Capture();
        PrototypeCssRequest Bare(string platform) => new(capture, Bundle, platform, "Haiku_UI", new Dictionary<string, string>(), new Dictionary<string, string>(), ["dialog"], new Dictionary<string, WidgetNode>());
        var o11 = PrototypeCss.Compose(Bare("o11"));
        Assert.Contains("background-image:url('/Haiku_UI/img/Haiku_UI.FarmaVirtualProducts.png')", o11.StyleSheet);
        Assert.Equal("derived", o11.Report["assetUrls"]![0]!["source"]!.ToString());
        var odc = PrototypeCss.Compose(Bare("odc"));
        Assert.Contains("background-image:url('assets/products.png')", odc.StyleSheet);
        Assert.Equal("unconfirmed", odc.Report["assetUrls"]![0]!["source"]!.ToString());
        Assert.Equal("assets/products.png", odc.Report["unmappedUrls"]![0]!["url"]!.ToString());
    }

    /// <summary>2026-10-13 (VisitaCerta screens/*.png are JPEGs): a JPEG saved as products.png gets the URL .jpg, the type the
    /// Studio gives the image (url(.png) was refused by the Verify as an unknown object, with no code); a real PNG keeps .png
    /// and an asset whose bytes are no image keeps its own extension.</summary>
    [Fact]
    public void AnImageUrlTakesTheTypeOfItsBytesNeverTheExtensionOfItsName()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-css-type-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            var capture = Capture();
            Directory.CreateDirectory(Path.Combine(dir, "sheets"));
            foreach (var sheet in Directory.GetFiles(Path.Combine(Bundle, "sheets"))) File.Copy(sheet, Path.Combine(dir, "sheets", Path.GetFileName(sheet)));
            var asset = Path.Combine(dir, capture["assets"]![0]!["bundle"]!.ToString());
            Directory.CreateDirectory(Path.GetDirectoryName(asset)!);
            PrototypeCssRequest Bare() => new(capture, dir, "o11", "Haiku_UI", new Dictionary<string, string>(), new Dictionary<string, string>(), ["dialog"], new Dictionary<string, WidgetNode>());
            File.WriteAllBytes(asset, [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0]);
            Assert.Contains("background-image:url('/Haiku_UI/img/Haiku_UI.FarmaVirtualProducts.jpg')", PrototypeCss.Compose(Bare()).StyleSheet);
            File.WriteAllBytes(asset, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            Assert.Contains("background-image:url('/Haiku_UI/img/Haiku_UI.FarmaVirtualProducts.png')", PrototypeCss.Compose(Bare()).StyleSheet);
        }
        finally { try { Directory.Delete(dir, recursive: true); } catch (IOException) { } }
        // the rule itself: a JPEG is .jpg whatever the name (foto.jpeg was refused too), GIF/SVG/WebP by their bytes
        byte[] jpeg = [0xFF, 0xD8, 0xFF, 0xDB], gif = "GIF89a"u8.ToArray(), svg = "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"u8.ToArray();
        Assert.Equal("jpg", PrototypeNames.ImageExtension(jpeg, "foto.png"));
        Assert.Equal("jpg", PrototypeNames.ImageExtension(jpeg, "foto.jpeg"));
        Assert.Equal("gif", PrototypeNames.ImageExtension(gif, "anim.png"));
        Assert.Equal("svg", PrototypeNames.ImageExtension(svg, "logo.svg"));
        Assert.Equal("png", PrototypeNames.ImageExtension([0x89, 0x50, 0x4E, 0x47], "foto.jpg"));
        Assert.Equal("woff2", PrototypeNames.ImageExtension("wOF2"u8.ToArray(), "fonts/a.woff2"));
        Assert.Equal("ext", PrototypeNames.ImageExtension([], "a.EXT"));
    }

    /// <summary>2026-10-13: 'foto%20grande.png' in a url() or an img src is the asset 'foto grande.png' (the capture names it
    /// decoded): the module image, never an External URL that does not exist in the published module.</summary>
    [Fact]
    public void APercentEncodedUrlResolvesToTheDecodedAsset()
    {
        Assert.Equal("foto grande.png", PrototypeNames.Unescape("foto%20grande.png"));
        Assert.Equal("enc ícone.png", PrototypeNames.Unescape("enc%20%C3%ADcone.png"));
        Assert.Equal("100%.css", PrototypeNames.Unescape("100%.css"));
        Assert.Equal("plain.png", PrototypeNames.Unescape("plain.png"));
        var options = new RewriteOptions { Platform = "o11", AssetUrls = new Dictionary<string, string> { ["img/foto grande.png"] = "/M/img/M.PFotoGrande.png" } };
        var rewrite = PrototypeRewrites.Rewrite(".a{background:url('img/foto%20grande.png')}", options);
        Assert.Contains("url('/M/img/M.PFotoGrande.png')", rewrite.Text);
    }

    [Fact]
    public void TheImportFallbackHookWritesTheInlineFontFacesInPlaceOfTheImport()
    {
        var previous = PrototypeCss.ImportFallback;
        try
        {
            PrototypeCss.ImportFallback = statement => statement.Contains("fonts.googleapis.com") ? "@font-face{font-family:'DM Sans';src:url(https://fonts.gstatic.com/x.woff2)}" : null;
            var css = PrototypeCss.Compose(Request(Capture())).StyleSheet;
            Assert.StartsWith("@font-face{font-family:'DM Sans';", css);
            Assert.DoesNotContain("@import", css);
        }
        finally { PrototypeCss.ImportFallback = previous; }
    }

    // ---- test 2: the rewrites keep the specificity -------------------------------------------------------------------

    [Theory]
    [InlineData("dialog", ":is(dialog, :where(.ssam-tag-dialog))", 0, 0, 1)]
    [InlineData("dialog[open]", ":is(dialog, :where(.ssam-tag-dialog))[open]", 0, 1, 1)]
    [InlineData("#modal", ":is(#modal, .ssam-id-modal)", 1, 0, 0)]
    [InlineData("#modal .modal-head h2", ":is(#modal, .ssam-id-modal) .modal-head h2", 1, 1, 1)]
    [InlineData("svg.icon", ":is(svg, :where(.ssam-icon)).icon", 0, 1, 1)]
    [InlineData("button[type=submit]", "button:is([type=submit], :where(.ssam-submit))", 0, 1, 1)]
    [InlineData(".brand span:last-child", ".brand span:not(:where(.ssam-icon, :has(> [data-checkbox]), :has(> [data-input]), [data-expression])):last-child", 0, 2, 1)]
    [InlineData(".header-link span:not(.cart-number)", ".header-link span:not(:where(.ssam-icon, :has(> [data-checkbox]), :has(> [data-input]), [data-expression])):not(.cart-number)", 0, 2, 1)]
    [InlineData(".field>span", ".field>span:not(:where(.ssam-icon, :has(> [data-checkbox]), :has(> [data-input]), [data-expression]))", 0, 1, 1)]
    [InlineData(":not(dialog) > p", ":not(:is(dialog, :where(.ssam-tag-dialog))) > p", 0, 0, 2)]
    public void EachRewriteKeepsTheOriginalSpecificity(string selector, string expected, int a, int b, int c)
    {
        var kinds = new List<string>();
        var written = PrototypeRewrites.RewriteSelector(selector, Options("o11", "dialog"), kinds, out _);
        Assert.Equal(expected, written);
        Assert.Equal((a, b, c), CssSelectors.Specificity(selector));
        Assert.Equal(CssSelectors.Specificity(selector), CssSelectors.Specificity(written));
    }

    [Fact]
    public void DialogBackdropGoesToThePopupAdapterAndTheRuleStaysAsWritten()
    {
        var kinds = new List<string>();
        var written = PrototypeRewrites.RewriteSelector("dialog::backdrop", Options("o11", "dialog"), kinds, out var backdrop);
        Assert.True(backdrop);
        Assert.Equal("dialog::backdrop", written);
        var css = PrototypeCss.Compose(Request(Capture())).StyleSheet;
        var adapters = css[css.IndexOf(PrototypeCss.AdaptersMarker, StringComparison.Ordinal)..];
        Assert.Contains(".popup-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#13291e55;backdrop-filter:blur(3px)}", adapters);
        Assert.Contains("dialog::backdrop{background:#13291e55;backdrop-filter:blur(3px)}", Section(css, "/* styles.css */\n", PrototypeCss.IconsMarker));
    }

    [Fact]
    public void TheBrandIconIsNoLongerTheLastSpanOfTheBrand()
    {
        // Native: the icon is a span.ssam-icon (IAdvancedHtml) inside span.brand-mark; the browser had an svg there.
        var brand = DomNode.Element("a"); brand.Attributes.Add(("class", "brand"));
        var mark = brand.Add(DomNode.Element("span")); mark.Attributes.Add(("class", "brand-mark"));
        var icon = mark.Add(DomNode.Element("span")); icon.Attributes.Add(("class", "lucide lucide-plus icon ssam-icon ssam-icon-plus-w300"));
        var name = brand.Add(DomNode.Element("div")); name.Add(DomNode.TextNode("Farma"));
        var virtualSpan = name.Add(DomNode.Element("span")); virtualSpan.Add(DomNode.TextNode("Virtual"));
        const string selector = ".brand span:last-child";
        var written = PrototypeRewrites.RewriteSelector(selector, Options("o11", "dialog"), [], out _);
        Assert.True(CssSelectors.Matches(icon, selector), "without the rewrite the icon turns green on green");
        Assert.False(CssSelectors.Matches(icon, written));
        Assert.True(CssSelectors.Matches(virtualSpan, written));
        // The prototype side: the svg never matched.
        var svgIcon = DomNode.Element("svg"); var protoMark = DomNode.Element("span"); protoMark.Attributes.Add(("class", "brand-mark")); protoMark.Add(svgIcon);
        var protoBrand = DomNode.Element("a"); protoBrand.Attributes.Add(("class", "brand")); protoBrand.Add(protoMark);
        Assert.False(CssSelectors.Matches(svgIcon, selector));
    }

    [Fact]
    public void MainIsRewrittenOnlyOnOdcWhereTheElementMapSubstitutesIt()
    {
        var (capture, bundle) = SyntheticBundle("main{display:grid}main.app>p{color:red}", ("main", "app"));
        var previous = PrototypeSeams.Element;
        try
        {
            // The html lane's map, faked: ODC has no main in the HTML Element list (0.1), O11 has.
            PrototypeSeams.Element = r => new ElementMapping("IAdvancedHtml", r.Platform == "odc" && r.Tag == "main" ? "div" : r.Tag, null, [], [], [],
                r.Platform == "odc" && r.Tag == "main" ? "main" : null, null);
            var o11 = PrototypeCss.Compose(Request(capture, "o11", substituted: [], bundle: bundle)).StyleSheet;
            var odc = PrototypeCss.Compose(Request(capture, "odc", substituted: [], bundle: bundle)).StyleSheet;
            Assert.Contains("main{display:grid}main.app>p{color:red}", o11);
            Assert.DoesNotContain("ssam-tag-main", o11);
            Assert.Contains(":is(main, :where(.ssam-tag-main)){display:grid}:is(main, :where(.ssam-tag-main)).app>p{color:red}", odc);
            Assert.Contains(":where(.ssam-tag-main){display:block}", Section(odc, PrototypeCss.UaMarker, "/* styles.css */"));
        }
        finally { PrototypeSeams.Element = previous; }
    }

    // ---- test 3: icons, UA defaults and adapters once, in the documented order ---------------------------------------

    [Fact]
    public void ThirtyThreeIconsBecomeMaskClassesWithTheBrandVariant()
    {
        var capture = Capture();
        var result = PrototypeCss.Compose(Request(capture));
        Assert.Equal(33, PrototypeIcons.Uses(capture).Select(u => u.Name).Distinct().Count());
        Assert.Equal(34, result.IconClasses.Count);   // 33 names at the default stroke 1.7 + plus at 3 (the brand mark)
        Assert.Equal("ssam-icon-plus-w300", result.IconClasses["plus@3"]);
        Assert.Equal("ssam-icon-plus", result.IconClasses["plus"]);
        Assert.Equal("ssam-icon-plus-w300", PrototypeIcons.ClassName("plus", 3, 1.7));
        var icons = Section(result.StyleSheet, PrototypeCss.IconsMarker, PrototypeCss.AdaptersMarker);
        var rules = icons.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(34, rules.Length);
        foreach (var rule in rules)
        {
            Assert.Matches(@"^\.ssam-icon-[a-z0-9-]+\{display:inline-block;background-color:currentColor;-webkit-mask:url\(""data:image/svg\+xml,[^""\s<>#]+""\) center/contain no-repeat;mask:url\(""data:image/svg\+xml,[^""\s<>#]+""\) center/contain no-repeat\}$", rule);
            var data = rule[(rule.IndexOf("svg+xml,", StringComparison.Ordinal) + 8)..rule.IndexOf("\")", StringComparison.Ordinal)];
            var svg = XElement.Parse(Uri.UnescapeDataString(data));   // valid percent-encoding of well-formed SVG
            Assert.Equal("svg", svg.Name.LocalName);
            Assert.Equal(rule.StartsWith(".ssam-icon-plus-w300{", StringComparison.Ordinal) ? "3" : "1.7", svg.Attribute("stroke-width")!.Value);
            Assert.Null(svg.Attribute("class"));
        }
        Assert.Equal(1, Occurrences(result.StyleSheet, ".ssam-icon-plus-w300{"));
        Assert.Equal(33, result.Report["icons"]!["names"]!.GetValue<int>());
    }

    [Fact]
    public void UaDefaultsAndAdaptersComeOnceInTheDocumentedOrder()
    {
        var roots = new Dictionary<string, WidgetNode>
        {
            ["v:catalogo"] = Node("IMobileBlockInstanceWidget", role: "wrapper", children: [Node("IContainer", k: "v:catalogo/0", style: "app")]),
            ["m:detalhes-do-produto"] = Node("IPopup", role: "wrapper", children: [Node("IAdvancedHtml", k: "m:detalhes-do-produto", tag: "div", style: "ssam-tag-dialog product-modal")]),
        };
        var css = PrototypeCss.Compose(Request(Capture(), roots: roots)).StyleSheet;
        var order = new[] { "@import", PrototypeCss.UaMarker, "/* styles.css */", PrototypeCss.IconsMarker, PrototypeCss.AdaptersMarker }
            .Select(m => css.IndexOf(m, StringComparison.Ordinal)).ToArray();
        Assert.All(order, i => Assert.True(i >= 0));
        Assert.Equal(order.OrderBy(i => i), order);
        foreach (var marker in new[] { PrototypeCss.UaMarker, PrototypeCss.IconsMarker, PrototypeCss.AdaptersMarker }) Assert.Equal(1, Occurrences(css, marker));
        var ua = Section(css, PrototypeCss.UaMarker, "/* styles.css */");
        Assert.StartsWith("\n:where(.ssam-tag-dialog){position:absolute;", ua);
        Assert.All(ua.Split('\n', StringSplitOptions.RemoveEmptyEntries), rule => Assert.StartsWith(":where(", rule));   // specificity zero
        var adapters = css[css.IndexOf(PrototypeCss.AdaptersMarker, StringComparison.Ordinal)..];
        Assert.Contains(":where(div.OSBlockWidget[data-block]){display:contents}", adapters);
        Assert.Contains(":where(div.popup-dialog[data-popup]){display:contents}", adapters);
        Assert.Contains(":where(div.OSInline){display:block}", adapters);
        Assert.Contains(":where(.ThemeGrid_MarginGutter){margin-left:0}", adapters);
        Assert.Equal(1, Occurrences(css, ":where(div.OSBlockWidget[data-block]){display:contents}"));
        Assert.Equal(1, Occurrences(css, ".popup-backdrop{"));
        // The section of the prototype keeps dialog rules rewritten, never the UA's.
        Assert.Contains(":is(dialog, :where(.ssam-tag-dialog)){border:1px solid var(--line)", Section(css, "/* styles.css */\n", PrototypeCss.IconsMarker));
    }

    // ---- test 4: wrapper-transparent rewrites on the compiled tree ---------------------------------------------------

    [Fact]
    public void TheCheckboxSpanWrapperMakesChildCombinatorsTransparent()
    {
        var tree = Node("IAdvancedHtml", k: "v:x/0", tag: "label", style: "switch", children: [Node("ICheckbox", k: "v:x/0/0")]);
        var roots = new Dictionary<string, WidgetNode> { ["v:x"] = tree };
        var (capture, bundle) = SyntheticBundle(".switch > input{opacity:0}.row>input:first-child{margin:0}.switch input{width:1px}");
        var css = PrototypeCss.Compose(Request(capture, roots: roots, bundle: bundle)).StyleSheet;
        var section = Section(css, "/* styles.css */\n", PrototypeCss.IconsMarker);
        const string wrapped = ":is(.switch > input, .switch > :where(span:has(> input[data-checkbox])) > input){opacity:0}";
        Assert.Contains(wrapped, section);
        Assert.Contains(".switch input{width:1px}", section);   // a descendant combinator needs nothing

        var native = PrototypeRender.FromWidgets(tree, "o11");
        var input = native.Descendants(includeSelf: false).Single(n => n.Tag == "input");
        Assert.Equal("span", input.Parent!.Tag);   // the runtime row: <span><input data-checkbox ...></span>
        Assert.False(CssSelectors.Matches(input, ".switch > input"));
        var selector = wrapped[..wrapped.IndexOf('{')];
        Assert.True(CssSelectors.Matches(input, selector));
        Assert.Equal(CssSelectors.Specificity(".switch > input"), CssSelectors.Specificity(selector));
        Assert.True(CssSelectors.Matches(native.Descendants(includeSelf: false).Single(n => n.Tag == "span"), ":where(span:has(> input[data-checkbox]))"));
    }

    [Fact]
    public void TheShellPlaceholderBetweenMainAndTheViewIsSeenThrough()
    {
        var shell = Node("IContainer", k: "s:0", style: "app ssam-id-app", children:
            [Node("IAdvancedHtml", k: "s:0/3", tag: "main", style: "main container", children: [Node("IPlaceholderWidget", role: "wrapper")])]);
        var view = Node("IMobileBlockInstanceWidget", role: "wrapper", children: [Node("IContainer", k: "v:catalogo/0", style: "page-heading")]);
        var roots = new Dictionary<string, WidgetNode> { ["shell"] = shell, ["v:catalogo"] = view };
        var (capture, bundle) = SyntheticBundle(".main > .page-heading{margin:0}");
        var section = Section(PrototypeCss.Compose(Request(capture, roots: roots, bundle: bundle)).StyleSheet, "/* styles.css */\n", PrototypeCss.IconsMarker);
        const string selector = ":is(.main > .page-heading, .main > :where(div[data-placeholder]) > .page-heading)";
        Assert.Contains(selector + "{margin:0}", section);
        var native = PrototypeRender.FromWidgets(PrototypeCss.Spliced("v:catalogo", view, roots, "o11"), "o11");
        var heading = native.Descendants(includeSelf: false).Single(n => n.K == "v:catalogo/0");
        Assert.Equal(["div", "main", "div", "div"], heading.Ancestors().Select(a => a.Tag!).ToArray());   // placeholder, main, #app, OSBlockWidget
        Assert.False(CssSelectors.Matches(heading, ".main > .page-heading"));
        Assert.True(CssSelectors.Matches(heading, selector));
    }

    [Fact]
    public void APositionalPseudoClassMovesToTheWrapper()
    {
        var tree = Node("IContainer", k: "r", style: "row", children: [Node("ICheckbox", k: "r/0"), Node("ITextWidget", k: "r/1", text: "Ativo")]);
        var native = PrototypeRender.FromWidgets(tree, "o11");
        var input = native.Descendants(includeSelf: false).Single(n => n.Tag == "input");
        var compiled = native;
        var written = PrototypeRewrites.WrapperTransparent(".row>input:first-child", (compound, _) =>
            compiled.Descendants(includeSelf: true).Any(e => e.IsElement && e.Runtime == null && e.Parent?.Runtime != null && CssSelectors.MatchesCompound(e, compound))
                ? [["span:has(> input[data-checkbox])"]] : []);
        Assert.Equal(":is(.row > input:first-child, .row > :where(span:has(> input[data-checkbox])):first-child > input)", written);
        Assert.False(CssSelectors.Matches(input, ".row>input:first-child"));
        Assert.True(CssSelectors.Matches(input, written));
        Assert.Equal(CssSelectors.Specificity(".row>input:first-child"), CssSelectors.Specificity(written));
    }

    [Fact]
    public void FarmaVirtualSelectorsSelectTheSameElementsOnTheCompiledTree()
    {
        // A faked compile of the captured trees (the shape the compile lane builds through the element map): every selector of
        // styles.css without dynamic pseudo-classes or pseudo-elements selects in the native tree, rewritten, exactly the keys
        // it selects in the prototype tree. The rewrites of 4.1 are what makes this hold (svg icons as spans, dialog as a div,
        // the checkbox wrapper).
        var capture = Capture();
        var roots = new Dictionary<string, WidgetNode>();
        var prototypes = new Dictionary<string, DomNode>();
        foreach (var group in new[] { "views", "modals" })
            foreach (var item in capture[group]!.AsArray())
            {
                var key = (group == "views" ? "v:" : "m:") + item!["key"];
                prototypes[key] = DomNode.FromJson(new JsonArray(item["root"]!.DeepClone()));
                roots[key] = FakeCompile(item["root"]!.AsObject());
            }
        var result = PrototypeCss.Compose(Request(capture, roots: roots));
        var original = Original(capture);
        var rewritten = PrototypeRewrites.Rewrite(original, Options("o11", "dialog") with
        {
            Wrappers = (compound, _) =>
            {
                var chains = new List<IReadOnlyList<string>>();
                foreach (var tree in roots.Values.Select(r => PrototypeRender.FromWidgets(r, "o11")))
                    foreach (var e in tree.Descendants(includeSelf: false))
                        if (e.IsElement && e.Runtime == null && e.Parent?.Runtime != null && CssSelectors.MatchesCompound(e, compound))
                        {
                            var chain = new List<string>();
                            for (var p = e.Parent; p != null && p.Runtime != null; p = p.Parent) chain.Insert(0, p.RuntimeSelector!);
                            if (!chains.Any(c => c.SequenceEqual(chain))) chains.Add(chain);
                        }
                return chains;
            },
        });
        Assert.Contains(PrototypeCss.IconsMarker, result.StyleSheet);
        var originalRules = CssStylesheet.Parse(original, lenient: true).Rules;
        var writtenRules = CssStylesheet.Parse(rewritten.Text, lenient: true).Rules;
        Assert.Equal(originalRules.Count, writtenRules.Count);
        var natives = roots.ToDictionary(r => r.Key, r => PrototypeRender.FromWidgets(r.Value, "o11"));
        var compared = 0; var differences = new List<string>();
        for (var i = 0; i < originalRules.Count; i++)
        {
            var source = CssStylesheet.SplitSelectors(originalRules[i].Selector).ToList();
            var target = CssStylesheet.SplitSelectors(writtenRules[i].Selector).ToList();
            Assert.Equal(source.Count, target.Count);
            for (var s = 0; s < source.Count; s++)
            {
                if (Dynamic(source[s]) || DocumentLevel(source[s])) continue;
                foreach (var (key, proto) in prototypes)
                {
                    var expected = CssSelectors.Select(proto, source[s]).Select(n => n.K).ToHashSet();
                    var matched = CssSelectors.Select(natives[key], target[s]).ToList();
                    var got = matched.Where(n => n.Runtime == null).Select(n => n.K).ToHashSet();
                    compared++;
                    if (!expected.SetEquals(got)) differences.Add($"{key} {source[s]} -> {target[s]}: expected {expected.Count}, got {got.Count}");
                    // A runtime element (wrapper, popup box) matched is a gain; only '*' may reach them, harmlessly.
                    if (matched.Any(n => n.Runtime != null) && source[s].Trim() != "*") differences.Add($"{key} {source[s]}: gained a runtime element");
                }
            }
        }
        Assert.True(compared > 2000, compared.ToString());
        Assert.Empty(differences);

        // Without the rewrites the same compiled trees select differently: the dialog rules miss the popup's div and the brand
        // rule reaches the icon span (what the rewrites exist for).
        var without = new List<string>();
        foreach (var rule in originalRules)
            foreach (var selector in CssStylesheet.SplitSelectors(rule.Selector))
            {
                if (Dynamic(selector) || DocumentLevel(selector)) continue;
                foreach (var (key, proto) in prototypes)
                    if (!CssSelectors.Select(proto, selector).Select(n => n.K).ToHashSet().SetEquals(CssSelectors.Select(natives[key], selector).Where(n => n.Runtime == null).Select(n => n.K)))
                        without.Add(selector);
            }
        Assert.Contains("dialog", without);
        Assert.Contains(".brand span:last-child", without);
    }

    private static bool Dynamic(string selector) =>
        new[] { ":hover", ":focus", ":active", ":visited", ":target", "::", ":before", ":after", ":disabled", ":empty", ":checked" }.Any(p => selector.Contains(p, StringComparison.Ordinal));

    // The trees are fragments without html/body: :root, html and body select the document, not these trees.
    private static bool DocumentLevel(string selector) => selector.StartsWith(":root", StringComparison.Ordinal) || selector.StartsWith("html", StringComparison.Ordinal) || selector.StartsWith("body", StringComparison.Ordinal);

    /// <summary>The compile lane's construction, faked for the test: element → widget by the table of 3.2 (div → IContainer, a →
    /// ILink, button → IButton, checkbox → ICheckbox, other inputs → IInput, select → IDropdown, textarea → ITextArea, text →
    /// ITextWidget, an icon → IAdvancedHtml span with ssam-icon and the mask class, dialog → IPopup with div.ssam-tag-dialog,
    /// every other tag → IAdvancedHtml); id → the ssam-id-* class.</summary>
    private static WidgetNode FakeCompile(JsonObject node)
    {
        if (node["t"] is null) return Node("ITextWidget", k: node["k"]?.ToString(), text: node["x"]?.ToString() ?? "");
        var tag = node["t"]!.ToString();
        var attributes = (node["a"] as JsonArray ?? []).OfType<JsonArray>().Select(p => (p[0]!.ToString(), p[1]?.ToString() ?? "")).ToList();
        var classes = attributes.Where(a => a.Item1 == "class").Select(a => a.Item2).FirstOrDefault() ?? "";
        if (attributes.FirstOrDefault(a => a.Item1 == "id").Item2 is { Length: > 0 } id) classes = (classes + " ssam-id-" + id).Trim();
        var rest = attributes.Where(a => a.Item1 is not ("class" or "id")).ToList();
        var children = (node["c"] as JsonArray ?? []).OfType<JsonObject>().Select(FakeCompile).ToList();
        if (node["icon"] is JsonObject icon)
            return Node("IAdvancedHtml", k: node["k"]!.ToString(), tag: "span",
                style: (classes + " ssam-icon " + PrototypeIcons.ClassName(icon["name"]!.ToString(), icon["strokeWidth"]!.GetValue<double>(), 1.7)).Trim(), attributes: rest);
        var type = attributes.FirstOrDefault(a => a.Item1 == "type").Item2;
        var widget = tag switch
        {
            "div" => "IContainer",
            "a" => "ILink",
            "button" => "IButton",
            "input" when type == "checkbox" => "ICheckbox",
            "input" => "IInput",
            "select" => "IDropdown",
            "textarea" => "ITextArea",
            _ => "IAdvancedHtml",
        };
        if (tag == "dialog")
            return Node("IPopup", role: "wrapper", children: [Node("IAdvancedHtml", k: node["k"]!.ToString(), tag: "div", style: (classes + " ssam-tag-dialog").Trim(), attributes: rest, children: children)]);
        return Node(widget, k: node["k"]!.ToString(), tag: widget == "IAdvancedHtml" ? tag : null, style: classes, attributes: rest, children: children);
    }

    internal static WidgetNode Node(string w, string? k = null, string? tag = null, string? style = null, string? text = null, string? role = null,
        IReadOnlyList<(string, string)>? attributes = null, IReadOnlyList<WidgetNode>? children = null) =>
        new(w, k, tag, style, attributes ?? [], text, null, null, null, children ?? [], null, role);

    /// <summary>A bundle with one sheet in a fresh folder: the capture names it with its sha256.</summary>
    internal static (JsonObject Capture, string Bundle) SyntheticBundle(string css, params (string Tag, string Class)[] nodes)
    {
        var bundle = Path.Combine(Root, ".local", "prototype-css-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(bundle, "sheets"));
        var bytes = Encoding.UTF8.GetBytes(css);
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        File.WriteAllBytes(Path.Combine(bundle, "sheets", sha + ".css"), bytes);
        var root = new JsonObject { ["k"] = "v:x", ["t"] = "div", ["a"] = new JsonArray(), ["c"] = new JsonArray(nodes.Select((n, i) => (JsonNode)new JsonObject
        {
            ["k"] = "v:x/" + i, ["t"] = n.Tag, ["a"] = new JsonArray(new JsonArray("class", n.Class)), ["c"] = new JsonArray(),
        }).ToArray()) };
        var capture = new JsonObject
        {
            ["schema"] = "ssam-prototype-capture/1",
            ["app"] = new JsonObject { ["prefix"] = "Tst" },
            ["css"] = new JsonObject { ["sheets"] = new JsonArray(new JsonObject { ["path"] = "styles.css", ["bundle"] = "sheets/" + sha + ".css", ["order"] = 0, ["sha256"] = sha }) },
            ["icons"] = new JsonObject { ["defaultStrokeWidth"] = 2, ["set"] = new JsonObject() },
            ["views"] = new JsonArray(new JsonObject { ["key"] = "x", ["root"] = root }),
        };
        return (capture, bundle);
    }

    internal static int Occurrences(string text, string needle) { var count = 0; var i = 0; while ((i = text.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { count++; i += needle.Length; } return count; }
}
