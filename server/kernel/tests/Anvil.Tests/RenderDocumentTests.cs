using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>R3-A piece C: the kernel verb render-document (ssam-render-document/1). One synthetic document per family of the
/// visual check (a) to (e), composed against small synthetic platform sheets written here: the document carries the runtime's
/// DOM with data-ssam-key, the List sentinels as &lt;template data-ssam-sentinel&gt;, the sheets in the runtime's order, the body
/// classes per breakpoint, no script and no external URL; the probes are the check's warnings with the value the author meant.</summary>
public sealed class RenderDocumentTests(ITestOutputHelper output)
{
    private static readonly PlatformSheets Platform = new("o11", "11.55.92", "present",
        [new PlatformSheet("runtime", "platform:reactive-runtime@11.55.92", "OutSystemsReactWidgets.css", "[data-input]:empty{height:32px}\nspan[data-expression]{white-space:pre-wrap}"),
         new PlatformSheet("osui", "osui@2.28.1", "OutSystemsUI.OutSystemsUI.css",
             ":root{--side-menu-size:300px}\n.OSFillParent{width:100%}\n.app-menu-content{position:fixed;top:0;left:0;width:var(--side-menu-size);height:100%}\n.tablet .app-menu-content{left:calc(-1 * var(--side-menu-size))}\n.ThemeGrid_MarginGutter{margin-left:20px}")],
        []) { Osui = "2.28.1", Runtime = "11.55.92" };

    private static readonly string[] All = ["desktop", "tablet", "phone"];

    private static DomNode El(DomNode parent, string tag, string? cls, string? key, params (string, string)[] attributes)
    {
        var e = parent.Add(DomNode.Element(tag));
        if (cls != null) e.SetAttr("class", cls);
        foreach (var (n, v) in attributes) e.SetAttr(n, v);
        e.ObjectKey = key;
        return e;
    }

    private static DomNode Sentinel(DomNode list)
    {
        var s = El(list, "script", null, null, ("style", "display: flex; height: 0px; width: 100%;"));
        s.Runtime = "IList";
        return s;
    }

    private static RenderDocument.Root Root(string id, Action<DomNode> build, string css)
    {
        var fragment = DomNode.Fragment();
        var top = fragment.Add(DomNode.Element("div"));
        top.SetAttr("data-ssam-root", id);
        build(top);
        return new RenderDocument.Root(id, "Screen" + id, "Key" + id, new ScreenVisual.Prediction { Root = fragment }, [new RenderDocument.Style("screen-" + id, "screen:Screen" + id, css)], []);
    }

    private static List<RenderDocument.Root> Families() =>
    [
        // (a) specificity
        Root("s1", top =>
        {
            var span = El(El(top, "div", "form-box", "KBox", ("data-container", "")), "span", "input-text", null); span.Runtime = "IInput";
            El(span, "input", "f form-control", "KInput", ("data-input", ""), ("type", "text"));
        }, ".f{height:50px}"),
        // (b) inheritance
        Root("s2", top =>
        {
            var cell = El(top, "div", "cell", "KCell", ("data-container", ""));
            var text = El(cell, "span", null, "KExpr", ("data-expression", "")); text.Runtime = "IExpression";
            text.Add(DomNode.TextNode("Total"));
        }, ".cell{white-space:nowrap}"),
        // (c) positional, against the sentinels
        Root("s3", top =>
        {
            var list = El(top, "div", "rows", "KList", ("data-list", ""));
            Sentinel(list);
            El(list, "div", "row", "KRow", ("data-container", "")).Add(DomNode.TextNode("Row"));
            Sentinel(list);
        }, ".rows>.row:first-child{border-top:0;margin-top:0}"),
        // (d) a runtime class's width on a flex item
        Root("s4", top =>
        {
            var wrap = El(top, "div", "wrap", "KWrap", ("data-container", ""));
            El(El(wrap, "div", "chart OSFillParent", "KChart", ("data-list", "")), "div", "bar", "KBar", ("data-container", "")).Add(DomNode.TextNode("V"));
            El(wrap, "div", "side", "KSide", ("data-container", "")).Add(DomNode.TextNode("Side"));
            El(wrap, "a", "ThemeGrid_MarginGutter", "KLink", ("data-link", ""), ("href", "#")).Add(DomNode.TextNode("Go"));
        }, ".wrap{display:flex}\n.chart{min-height:120px}"),
        // (e) the fixed menu per breakpoint
        Root("s5", top =>
        {
            var layout = El(top, "div", "layout", "KLayout", ("data-container", ""));
            El(El(layout, "div", "app-menu-content", "KMenu", ("data-container", "")), "a", null, "KHome", ("data-link", ""), ("href", "#")).Add(DomNode.TextNode("Home"));
            El(El(layout, "div", "main-content", "KMain", ("data-container", "")), "h1", null, "KTitle", ("data-advancedhtml", "")).Add(DomNode.TextNode("Title"));
        }, ".main-content{padding:16px}\n.app-menu-content{left:0}"),
    ];

    // In the document set the author's view of a module's page is its runtime DOM without the List sentinels and without the
    // classes the runtime adds (OSFillParent, ThemeGrid_MarginGutter, OSInline: the module writes a Width or a margin, never them).

    [Fact]
    public void EachFamilyComesAsAProbeOfItsOwnDocumentWithTheValueTheAuthorMeant()
    {
        var document = RenderDocument.Compose("o11", "Sample", new string('a', 64), Families(), [new RenderDocument.Style("theme-sample", "theme:Sample", ".x{color:red}")], Platform, All);
        output.WriteLine(document["probes"]!.ToJsonString());
        Assert.Equal(RenderDocument.Schema, document["schema"]!.ToString());
        Assert.Equal("present", document["platform"]!["sheets"]!.ToString());
        Assert.Equal("2.28.1", document["platform"]!["osui"]!.ToString());
        Assert.Empty(RenderDocument.Validate(document));
        // the sheets in the runtime's order: base runtime, OutSystems UI, theme, screen
        Assert.Equal(["runtime", "osui", "theme-sample", "screen-s1"], document["documents"]![0]!["styles"]!.AsArray().Select(s => s!.ToString()));
        Assert.Equal(["runtime", "osui", "theme-sample", "screen-s1", "screen-s2", "screen-s3", "screen-s4", "screen-s5"], document["styles"]!.AsArray().Select(s => s!["id"]!.ToString()));
        foreach (var d in document["documents"]!.AsArray())
        {
            var html = d!["html"]!.ToString();
            Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("data-ssam-key=\"K", html);
            Assert.Equal(["tablet", "portrait"], d["bodyClasses"]!["tablet"]!.AsArray().Select(c => c!.ToString()));
        }
        Assert.Equal(2, CountOf(document["documents"]![2]!["html"]!.ToString(), "<template data-ssam-sentinel=\"\""));
        var probes = document["probes"]!.AsArray().OfType<JsonObject>().ToList();
        JsonObject Probe(string doc, string warning, string viewport) =>
            Assert.Single(probes, p => p["document"]!.ToString() == doc && p["warning"]!.ToString() == warning && p["viewport"]!.ToString() == viewport);
        var a = Probe("s1", "HTML_PLATFORM_SPECIFICITY", "desktop");
        Assert.Equal(("KInput", "height", "50px"), (a["key"]!.ToString(), a["property"]!.ToString(), a["expect"]!.ToString()));
        var b = Probe("s2", "HTML_PLATFORM_INHERITED", "phone");
        Assert.Equal(("KExpr", "white-space", "nowrap"), (b["key"]!.ToString(), b["property"]!.ToString(), b["expect"]!.ToString()));
        var c = Probe("s3", "HTML_PLATFORM_POSITIONAL", "tablet");
        // the property the renderer measures (border-top is not one of them)
        Assert.Equal(("KRow", "margin-top", "0px"), (c["key"]!.ToString(), c["property"]!.ToString(), c["expect"]!.ToString()));
        Assert.Equal(".rows>.row:nth-child(1 of :not(script))", c["patch"]!.ToString());
        Assert.All(probes, p => Assert.True(p["property"]!.ToString() == "coveredBy" || ScreenVisual.MeasuredProperties.Contains(p["property"]!.ToString())));
        // F5: every expect in the form getComputedStyle answers (never auto, a bare 0 or rem), or no expect at all
        Assert.All(probes, p => Assert.False(p["expect"]?.ToString() is "auto" or "0" or "none" || (p["expect"]?.ToString() ?? "").EndsWith("rem", StringComparison.Ordinal), p.ToJsonString()));
        Assert.All(probes, p => Assert.True(p["property"]!.ToString() == "coveredBy" || p["expect"] != null || p["expectNot"] != null, p.ToJsonString()));
        // an absent expect is left out of the probe, never written null
        Assert.All(probes, p => Assert.False(p.ContainsKey("expect") && p["expect"] == null || p.ContainsKey("expectNot") && p["expectNot"] == null, p.ToJsonString()));
        // (d): the author declared no margin, so the probe says what the runtime class must not give; a width of 100% has no
        // computed form and no probe is sent for it
        var d4 = Probe("s4", "HTML_PLATFORM_INJECTED", "desktop");
        Assert.Equal(("KLink", "margin-left", "20px"), (d4["key"]!.ToString(), d4["property"]!.ToString(), d4["expectNot"]!.ToString()));
        Assert.Null(d4["expect"]);
        Assert.DoesNotContain(probes, p => p["key"]!.ToString() == "KChart");
        var e = Probe("s5", "HTML_PLATFORM_FIXED_LAYOUT", "desktop");
        Assert.Equal(("KMain", "coveredBy"), (e["key"]!.ToString(), e["property"]!.ToString()));
        Assert.Equal(".desktop div.main-content[data-container]{margin-left:300px}", e["patch"]!.ToString());
        Assert.StartsWith(".phone ", Probe("s5", "HTML_PLATFORM_FIXED_LAYOUT", "phone")["patch"]!.ToString());
        var hidden = Probe("s5", "HTML_PLATFORM_FIXED_LAYOUT", "tablet");
        Assert.Equal(("KMenu", "left", "-300px"), (hidden["key"]!.ToString(), hidden["property"]!.ToString(), hidden["expectNot"]!.ToString()));
        Assert.Null(hidden["expect"]);
        Assert.Null(hidden["patch"]);
    }

    [Fact]
    public void NoExternalUrlPassesThroughEscapesOrImageFunctions()
    {
        // F2: u\72l( is url( for CSS; image-set and -webkit-image-set take a string in place of url()
        var css = ".x{background:u\\72l(https://evil.test/a.png)} .y{background-image:image-set(\"https://evil.test/b.png\" 1x)}"
            + " .z{background-image:-webkit-image-set('//evil.test/c.png' 1x)} .w{background:url(\"\\68ttps://evil.test/d.png\")} .ok{background:image-set(\"data:image/png;base64,AAAA\" 1x)}";
        var root = Root("s1", top => El(top, "div", "x", "KX", ("data-container", ""), ("style", "background:u\\72l(https://evil.test/i.png)")).Add(DomNode.TextNode("X")), css);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.DoesNotContain("evil.test", document.ToJsonString());
        Assert.Contains("data:image/png;base64,AAAA", document["styles"]!.AsArray().Last()!["css"]!.ToString());
        Assert.Empty(RenderDocument.Validate(document));
        // and the renderer's check refuses them when they come through
        var raw = new JsonObject
        {
            ["styles"] = new JsonArray(new JsonObject { ["id"] = "s", ["css"] = css }),
            ["documents"] = new JsonArray(new JsonObject { ["id"] = "d", ["html"] = "<div style=\"background:u\\72l(https://evil.test/i.png)\"></div>", ["sha256"] = RuntimeCss.Sha("<div style=\"background:u\\72l(https://evil.test/i.png)\"></div>") }),
        };
        var problems = RenderDocument.Validate(raw);
        Assert.Contains(problems, p => p.Contains("style s: an external URL", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("style attribute", StringComparison.Ordinal));
    }

    [Fact]
    public void NoExternalUrlPassesThroughACustomProperty()
    {
        // V7: var() is not resolved statically: a custom property's string that leaves the machine is refused wherever it is
        var css = ":root{--u:\"https://evil.test/v.png\"} .x{background-image:image-set(var(--u) 1x)} .y{background-image:-webkit-image-set(var(--u) 1x)}"
            + " .t::before{content:\"https://example.test/shown-as-text\"}";
        const string style = "--w:'//evil.test/w.png';background-image:image-set(var(--w) 1x)";
        var root = Root("s1", top => El(top, "div", "x", "KX", ("data-container", ""), ("style", style)).Add(DomNode.TextNode("X")), css);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.DoesNotContain("evil.test", document.ToJsonString());
        Assert.Empty(RenderDocument.Validate(document));
        // a string of an ordinary property (content) is text, never a url: it stays
        Assert.Contains("https://example.test/shown-as-text", document["styles"]!.AsArray().Last()!["css"]!.ToString());
        var html = "<div style=\"" + style.Replace("'", "&#39;") + "\"></div>";
        var raw = new JsonObject
        {
            ["styles"] = new JsonArray(new JsonObject { ["id"] = "s", ["css"] = css }),
            ["documents"] = new JsonArray(new JsonObject { ["id"] = "d", ["html"] = html, ["sha256"] = RuntimeCss.Sha(html) }),
        };
        var problems = RenderDocument.Validate(raw);
        Assert.Contains(problems, p => p.Contains("style s: an external URL", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("style attribute", StringComparison.Ordinal));
    }

    [Fact]
    public void EveryStringThatLeavesTheMachineIsATargetButContentAndQuotes()
    {
        // W1/W2: a var() fallback inside an image function and an @property initial-value reach a url context too
        var css = ".x{background-image:image-set(var(--missing, \"https://evil.test/f.png\") 1x)}"
            + " @property --u{syntax:\"*\";inherits:false;initial-value:\"https://evil.test/p.png\"} .y{background-image:image-set(var(--u) 1x)}"
            + " .t::before{content:\"https://example.test/t\";quotes:\"«\" \"»\"}";
        const string style = "background-image:-webkit-image-set(var(--none, '//evil.test/s.png') 1x)";
        var root = Root("s1", top => El(top, "div", "x", "KX", ("data-container", ""), ("style", style)).Add(DomNode.TextNode("X")), css);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.DoesNotContain("evil.test", document.ToJsonString());
        Assert.Empty(RenderDocument.Validate(document));
        var sheet = document["styles"]!.AsArray().Last()!["css"]!.ToString();
        Assert.Contains("content:\"https://example.test/t\"", sheet);
        Assert.Contains("quotes:\"«\" \"»\"", sheet);
        Assert.Contains("syntax:\"*\"", sheet);
        var html = "<div style=\"" + style.Replace("'", "&#39;") + "\"></div>";
        var raw = new JsonObject
        {
            ["styles"] = new JsonArray(new JsonObject { ["id"] = "s", ["css"] = css }),
            ["documents"] = new JsonArray(new JsonObject { ["id"] = "d", ["html"] = html, ["sha256"] = RuntimeCss.Sha(html) }),
        };
        var problems = RenderDocument.Validate(raw);
        Assert.Contains(problems, p => p.Contains("style s: an external URL", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("style attribute", StringComparison.Ordinal));
        // content and quotes alone: nothing to refuse
        Assert.Empty(CssReach.External(".t::before{content:\"https://example.test/t\";quotes:\"«\" \"»\"}"));
    }

    [Fact]
    public void OnlyTheValuesAndPreludesThatFetchAreRead()
    {
        // Y1, Y2: selectors and @namespace never fetch; font names, areas, local(), counter-style strings, attr() and quotes stay
        const string legit = "@namespace svg url(http://www.w3.org/2000/svg);\n.a[href^=\"https://\"]{color:red}\n.b[title=\"//x\"]{color:blue}\nsvg|rect{fill:red}\n"
            + ".f{font-family:\"Open Sans\";grid-template-areas:\"a b\"}\n@font-face{font-family:\"R\";src:local(\"Roboto\")}\n@counter-style x{system:cyclic;symbols:\"*\";suffix:\" \"}\n"
            + ".t::before{content:attr(data-x,\"https://example.test\");quotes:\"«\" \"»\"}";
        Assert.Equal(legit, RenderDocument.NeutralizeCss(legit));
        Assert.Empty(CssReach.External(legit));
        // X1: content that takes an image fetches it, through a var() fallback too
        const string image = ".i::before{content:image-set(var(--m,\"https://evil.test/c.png\") 1x)} .j::before{content:-webkit-image-set(var(--m,'//evil.test/d.png') 1x)}";
        var root = Root("s1", top => El(top, "div", "i", "KI", ("data-container", "")).Add(DomNode.TextNode("I")), legit + "\n" + image);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.DoesNotContain("evil.test", document.ToJsonString());
        Assert.Contains("[href^=\"https://\"]", document["styles"]!.AsArray().Last()!["css"]!.ToString());
        Assert.Empty(RenderDocument.Validate(document));
        var raw = new JsonObject
        {
            ["styles"] = new JsonArray(new JsonObject { ["id"] = "s", ["css"] = image }),
            ["documents"] = new JsonArray(new JsonObject { ["id"] = "d", ["html"] = "<div></div>", ["sha256"] = RuntimeCss.Sha("<div></div>") }),
        };
        Assert.Contains(RenderDocument.Validate(raw), p => p.Contains("style s: an external URL", StringComparison.Ordinal));
    }

    [Fact]
    public void ADeclarationIsReadByItsShapeInAnyContainerAtAnyDepth()
    {
        // Z1: every container nested in every other up to depth 3 (a style rule, the conditional group rules nested by CSS
        // Nesting, @scope with loose declarations, an unknown at-rule): the custom property's url is read wherever it is, and the
        // strings of a nested rule's selector stay
        string[] containers = [".x{", "@media all{", "@supports (display:grid){", "@layer a{", "@container (min-width:1px){", "@scope (.x){", "@starting-style{", "@unknown-rule foo{"];
        var count = 0;
        foreach (var path in Paths(containers, 3))
        {
            var open = string.Concat(path);
            var close = new string('}', path.Length);
            var sheet = open + "--u:\"https://evil.test/" + count++ + ".png\";background-image:image-set(var(--u) 1x)" + close;
            Assert.True(CssReach.External(sheet).Count > 0, sheet);
            Assert.DoesNotContain("evil.test", RenderDocument.NeutralizeCss(sheet));
            var selector = open + "&[href^=\"https://\"]:hover{color:green}a:hover[title=\"//x\"]{color:red}" + close;
            Assert.Equal(selector, RenderDocument.NeutralizeCss(selector));
            Assert.Empty(CssReach.External(selector));
        }
        Assert.Equal(8 + 64 + 512, count);
        // the four of the review, through the whole set and its check
        const string css = ".x{@media all{--u:\"https://evil.test/m.png\"} background-image:image-set(var(--u) 1x)}"
            + " .y{@supports (display:grid){--u:'//evil.test/s.png'} background-image:image-set(var(--u) 1x)}"
            + " .z{@layer a{--u:\"https://evil.test/l.png\"} background-image:image-set(var(--u) 1x)}"
            + " @scope (.x){--u:\"https://evil.test/sc.png\"; background-image:image-set(var(--u) 1x)}"
            + " .n{&[href^=\"https://\"]{color:green}} @scope (.x){a:hover[href^=\"https://\"]{color:red}} @media (min-width:640px){.m[href$=\"//\"]{color:gray}}";
        var root = Root("s1", top => El(top, "div", "x", "KX", ("data-container", "")).Add(DomNode.TextNode("X")), css);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.DoesNotContain("evil.test", document.ToJsonString());
        var written = document["styles"]!.AsArray().Last()!["css"]!.ToString();
        Assert.Contains(".n{&[href^=\"https://\"]{color:green}}", written);
        Assert.Contains("@scope (.x){a:hover[href^=\"https://\"]{color:red}}", written);
        Assert.Contains("@media (min-width:640px){.m[href$=\"//\"]{color:gray}}", written);
        var raw = new JsonObject
        {
            ["styles"] = new JsonArray(new JsonObject { ["id"] = "s", ["css"] = css }),
            ["documents"] = new JsonArray(new JsonObject { ["id"] = "d", ["html"] = "<div></div>", ["sha256"] = RuntimeCss.Sha("<div></div>") }),
        };
        Assert.Contains(RenderDocument.Validate(raw), p => p.Contains("style s: an external URL", StringComparison.Ordinal));
    }

    [Fact]
    public void ADeclarationIsReadWithCommentsAndWhitespaceAtEveryBoundary()
    {
        // C1: comments and whitespace between the tokens of a declaration change nothing (CSS Syntax 3 "consume a declaration")
        string[] fills = ["", " ", "/**/", " /* a */ ", "\n/*x*/\n", "/*a*//*b*/"];
        var count = 0;
        foreach (var fill in fills)
            for (var at = 0; at <= 6; at++)
            {
                string B(int k) => k == at || at == 6 ? fill : "";
                var declarations = B(0) + "--u" + B(1) + ":" + B(2) + "\"https://evil.test/" + count++ + ".png\"" + B(3) + ";" + B(4) + "background-image" + B(5) + ":image-set(var(--u) 1x)";
                foreach (var (css, attribute) in new[] { (".x{" + declarations + "}", false), (declarations, true) })
                {
                    Assert.True(CssReach.External(css, attribute).Count > 0, css);
                    Assert.DoesNotContain("evil.test", RenderDocument.NeutralizeCss(css, attribute));
                }
            }
        Assert.Equal(fills.Length * 7, count);
        // the review's three, through the set and its check
        const string css2 = ".x{--u/**/:\"https://evil.test/c.png\"; background-image:image-set(var(--u) 1x)} .y{--u /* a */ : '//evil.test/d.png'}";
        const string style = "--u /* c */ :'//evil.test/cs.png';background-image:image-set(var(--u) 1x)";
        var root = Root("s1", top => El(top, "div", "x", "KX", ("data-container", ""), ("style", style)).Add(DomNode.TextNode("X")), css2);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.DoesNotContain("evil.test", document.ToJsonString());
        var html = "<div style=\"" + style.Replace("'", "&#39;") + "\"></div>";
        var raw = new JsonObject
        {
            ["styles"] = new JsonArray(new JsonObject { ["id"] = "s", ["css"] = css2 }),
            ["documents"] = new JsonArray(new JsonObject { ["id"] = "d", ["html"] = html, ["sha256"] = RuntimeCss.Sha(html) }),
        };
        var problems = RenderDocument.Validate(raw);
        Assert.Contains(problems, p => p.Contains("style s: an external URL", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("style attribute", StringComparison.Ordinal));
        // a selector with a comment before its pseudo-class stays a selector
        const string selector = ".n{a/**/:hover[href^=\"https://\"]{color:red}}";
        Assert.Equal(selector, RenderDocument.NeutralizeCss(selector));
    }

    private static IEnumerable<string[]> Paths(string[] containers, int depth)
    {
        for (var d = 1; d <= depth; d++)
        {
            IEnumerable<string[]> level = containers.Select(c => new[] { c });
            for (var k = 1; k < d; k++) level = level.SelectMany(p => containers.Select(c => p.Append(c).ToArray()));
            foreach (var p in level) yield return p;
        }
    }

    [Fact]
    public void EveryKeyOfTheSetIsInTheOneSafeForm()
    {
        // F6: a model key with + / and padding is the same key in the document, its elements and its probes
        var fragment = DomNode.Fragment();
        var top = fragment.Add(DomNode.Element("div"));
        var span = El(El(top, "div", "form-box", "KBox", ("data-container", "")), "span", "input-text", null); span.Runtime = "IInput";
        El(span, "input", "f form-control", "ab+c/d==", ("data-input", ""), ("type", "text"));
        var root = new RenderDocument.Root("s1", "Screen", "ab+c/d==", new ScreenVisual.Prediction { Root = fragment }, [new RenderDocument.Style("screen-s1", "screen:Screen", ".f{height:50px}")], []);
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        Assert.Equal("safe", document["keyForm"]!.ToString());
        Assert.Equal("ab-c_d", document["documents"]![0]!["key"]!.ToString());
        Assert.Contains("data-ssam-key=\"ab-c_d\"", document["documents"]![0]!["html"]!.ToString());
        Assert.Equal("ab-c_d", Assert.Single(document["probes"]!.AsArray())!["key"]!.ToString());
        Assert.Equal("ab-c_d", RenderDocument.SafeKey("@ab+c/d=="));
    }

    [Fact]
    public void WithoutThePlatformSheetsTheDocumentSaysSoAndOnlyTheSentinelFamilyRemains()
    {
        var none = PlatformSheets.None("o11", "11.55.92", "the store has no folder for o11 11.55.92");
        var document = RenderDocument.Compose("o11", "Sample", null, Families(), [], none, All);
        Assert.Equal("missing", document["platform"]!["sheets"]!.ToString());
        Assert.Equal("RENDER_PLATFORM_SHEETS_MISSING", document["warnings"]![0]!["code"]!.ToString());
        Assert.Equal(["screen-s1"], document["documents"]![0]!["styles"]!.AsArray().Select(s => s!.ToString()));
        // (c) needs no sheet; (d) reads the width .OSFillParent gets, which only the platform's sheet gives
        var warnings = document["probes"]!.AsArray().Select(p => p!["warning"]!.ToString()).Distinct().ToList();
        Assert.Equal(["HTML_PLATFORM_POSITIONAL"], warnings);
    }

    [Fact]
    public void NoScriptAndNoExternalUrlReachTheDocument()
    {
        var root = Root("s1", top =>
        {
            var link = El(top, "a", "out", "KOut", ("data-link", ""), ("href", "https://example.test/x"), ("onclick", "go()"));
            link.Add(DomNode.TextNode("see javascript:alert(1) and https://example.test"));
            El(top, "img", null, "KImg", ("data-image", ""), ("src", "//cdn.example.test/a.png"));
            El(top, "iframe", null, "KFrame", ("src", "https://example.test"));
            El(top, "div", null, "KStyle", ("data-container", ""), ("style", "background:url(https://example.test/b.png)"));
        }, "@import url(\"https://fonts.example.test/f.css\");\n.out{background-image:url('//cdn.example.test/c.png')}\n.ok{background:url(data:image/png;base64,AAAA)}");
        var document = RenderDocument.Compose("o11", "Sample", null, [root], [], Platform, ["desktop"]);
        var html = document["documents"]![0]!["html"]!.ToString();
        output.WriteLine(html);
        Assert.Empty(RenderDocument.Validate(document));
        Assert.DoesNotContain("example.test/x", html);
        Assert.DoesNotContain("onclick", html);
        Assert.DoesNotContain("<iframe", html);
        Assert.Contains("data-ssam-neutralized=\"iframe\"", html);
        Assert.Contains("href=\"#\"", html);
        // the text of the screen reads the same (a url in a text passes)
        Assert.Contains("https://example.test", html);
        var css = document["styles"]!.AsArray().Last()!["css"]!.ToString();
        Assert.DoesNotContain("@import url", css);
        Assert.DoesNotContain("//cdn", css);
        Assert.Contains("data:image/png;base64,AAAA", css);
        Assert.Equal(["desktop"], document["documents"]![0]!["bodyClasses"]!.AsObject().Select(p => p.Key));
    }

    private static int CountOf(string text, string part)
    {
        var count = 0;
        for (var i = text.IndexOf(part, StringComparison.Ordinal); i >= 0; i = text.IndexOf(part, i + part.Length, StringComparison.Ordinal)) count++;
        return count;
    }
}
