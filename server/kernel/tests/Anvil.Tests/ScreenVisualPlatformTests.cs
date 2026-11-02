using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>R3-A: the visual check against the platform's cascade (ScreenVisual.Platform). Each family is a synthetic page (an
/// author document, the runtime DOM the predictor gives it, the author's CSS) and a small synthetic platform sheet written here
/// (never the OutSystems files): (a) specificity, (b) inheritance, (c) positional selectors against the List's sentinels, (d) the
/// width and margin of a runtime class, (e) a fixed layout element per breakpoint. The platform's sheets reach the check as
/// sheets of the page whose place is "platform:&lt;file&gt;" (the same input the base reads as the author's own sheets), so every
/// test here reads only what the base already has and fails there by its assertion.</summary>
public sealed class ScreenVisualPlatformTests(ITestOutputHelper output)
{
    // The codes as literals: the test reads the contract the agent reads.
    private const string Specificity = "HTML_PLATFORM_SPECIFICITY";
    private const string Inherited = "HTML_PLATFORM_INHERITED";
    private const string Positional = "HTML_PLATFORM_POSITIONAL";
    private const string Injected = "HTML_PLATFORM_INJECTED";
    private const string FixedLayout = "HTML_PLATFORM_FIXED_LAYOUT";

    private static ScreenVisual.Sheet Platform(string file, string css) => new(css, "platform:" + file);

    private static ScreenVisual.CheckInput Input(string html, Func<Dictionary<string, DomNode>, (DomNode Root, Dictionary<DomNode, DomNode> Map)> predict, params ScreenVisual.Sheet[] sheets)
    {
        var top = ScreenHtml.Parse(html).Children.First(c => !c.IsText);
        var map = new Dictionary<ScreenHtml.Node, DomNode>(ReferenceEqualityComparer.Instance);
        var author = ScreenVisual.AuthorDom(top, map);
        var nodes = new Dictionary<DomNode, ScreenHtml.Node>(ReferenceEqualityComparer.Instance);
        foreach (var (node, element) in map) nodes[element] = node;
        var byId = map.Values.Where(e => e.Attr("id") != null).ToDictionary(e => e.Attr("id")!, e => e, StringComparer.Ordinal);
        var (root, counterparts) = predict(byId);
        return new ScreenVisual.CheckInput("Page", author, nodes, new ScreenVisual.Prediction { Root = root }, counterparts, sheets, "o11", html);
    }

    private static DomNode El(DomNode parent, string tag, string? cls = null, string? runtime = null, params (string, string)[] attributes)
    {
        var e = parent.Add(DomNode.Element(tag));
        if (cls != null) e.SetAttr("class", cls);
        foreach (var (n, v) in attributes) e.SetAttr(n, v);
        e.Runtime = runtime;
        return e;
    }

    private static DomNode Keyed(DomNode element, string key, string widget) { element.ObjectKey = key; element.Widget = widget; return element; }

    private List<ScreenVisual.Finding> Run(ScreenVisual.CheckInput input)
    {
        var findings = ScreenVisual.Check(input);
        foreach (var f in findings) output.WriteLine($"{f.Code} {f.Kind} {f.Subject} -> {f.Right ?? "(" + string.Join(" | ", f.Candidates) + ")"} append={f.Append}: {f.Why}");
        return findings;
    }

    [Fact]
    public void AnAuthorRuleThatLosesToAPlatformRuleOnTheRuntimeElementGetsTheSelectorThatWins()
    {
        // (a): .f{height} (0,1,0) on an input loses to the runtime's [data-input]:empty (0,2,0): the input has no children.
        var html = "<screen name=\"Page\"><div class=\"form-box\"><input id=\"i\" class=\"f\"/></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var box = El(fragment, "div", "form-box", null, ("data-container", ""));
            var span = El(box, "span", "input-text", "IInput");
            map[a["i"]] = Keyed(El(span, "input", "f form-control", null, ("data-input", ""), ("type", "text")), "KeyInput1", "IInput");
            return (fragment, map);
        }, Platform("RuntimeBase.css", "[data-input]:empty{height:32px;padding:5px}\n.unrelated{height:1px}"), new ScreenVisual.Sheet(".f{height:50px;color:navy}", "page"));
        var findings = Run(input);
        var f = Assert.Single(findings, x => x.Code == Specificity);
        Assert.Equal(".f", f.Subject);
        // the runtime's own attribute raises the author's selector to an equal specificity, which wins after the platform's sheet
        Assert.Equal(".f[data-input]", f.Right);
        Assert.Contains("[data-input]:empty", f.Why);
        Assert.Contains("RuntimeBase.css", f.Why);
        Assert.Contains("height", f.Why);
        Assert.DoesNotContain("color", f.Why);
        Assert.True(f.AddSelector);
        Assert.True(CssSelectors.Matches(input.Counterparts[input.Counterparts.Keys.First()], f.Right!));
    }

    /// <summary>C-12 (F-FigmaReactive-09a), mapped onto family (a): OutSystems UI sizes the headings by device (.phone h1, 0,1,1);
    /// the author's .fm-hero-title{font-size} (0,1,0) on an h1 loses on the phone and the tablet, and comes back with the selector
    /// that wins there. The prototype's hand-written "device-heading" rule is this cascade.</summary>
    [Fact]
    public void AHeadingOutSystemsUiSizesByDeviceLosesItsFontSizeOnThePhone()
    {
        var html = "<screen name=\"Page\"><div class=\"fm-page\"><h1 id=\"t\" class=\"fm-hero-title\">Hero</h1></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var page = El(fragment, "div", "fm-page", null, ("data-container", ""));
            map[a["t"]] = Keyed(El(page, "h1", "fm-hero-title", null, ("data-advancedhtml", "")), "KeyTitle", "IAdvancedHtml");
            return (fragment, map);
        }, Platform("OutSystemsUI.OutSystemsUI.css", ".phone h1{font-size:20px}\n.tablet h1{font-size:24px}"), new ScreenVisual.Sheet(".fm-hero-title{font-size:28px}", "page"));
        // One finding per breakpoint OutSystems UI sizes it at: the phone's and the tablet's.
        var found = Run(input).Where(x => x.Code == Specificity && x.Property == "font-size").ToList();
        Assert.Equal([".phone h1", ".tablet h1"], found.Select(f => f.Winner!.Split(' ', 2)[1]).Order(StringComparer.Ordinal));
        Assert.All(found, f => { Assert.Equal(".fm-hero-title", f.Subject); Assert.NotNull(f.Right); });
    }

    [Fact]
    public void ATextPropertyThePlatformSetsAgainOnTheElementOfTheTextComesBackAsInherit()
    {
        // (b): .cell{white-space:nowrap} for its text; the runtime's span[data-expression] carries white-space:pre-wrap.
        var html = "<screen name=\"Page\"><div id=\"c\" class=\"cell\">{{ Total }}</div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var cell = Keyed(El(fragment, "div", "cell", null, ("data-container", "")), "KeyCell", "IContainer"); map[a["c"]] = cell;
            Keyed(El(cell, "span", null, "IExpression", ("data-expression", "")), "KeyExpr", "IExpression").Add(DomNode.TextNode("Total"));
            return (fragment, map);
        }, Platform("RuntimeBase.css", "span[data-expression]{white-space:pre-wrap}"), new ScreenVisual.Sheet(".cell{white-space:nowrap;overflow:hidden}", "page"));
        var f = Assert.Single(Run(input), x => x.Code == Inherited);
        Assert.Equal(".cell", f.Subject);
        Assert.Equal(".cell span[data-expression]", f.Right);
        Assert.Equal(".cell span[data-expression]{white-space:inherit}", f.Append);
        Assert.Contains("pre-wrap", f.Why);
        Assert.Contains("nowrap", f.Why);
    }

    [Fact]
    public void APositionalSelectorTheListSentinelsMoveGetsTheSelectorThatCountsTheRowsOnly()
    {
        // (c): the List renders a <script> first and last among its rows: .rows>.row:first-child misses the first row and
        // .row:last-child misses the last; the patch counts the rows only.
        var html = "<screen name=\"Page\"><div id=\"l\" class=\"rows\" list=\"Items\"><div id=\"r\" class=\"row\">{{ Name }}</div></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var list = Keyed(El(fragment, "div", "rows OSFillParent", null, ("data-list", ""), ("style", "position: relative;")), "KeyList", "IList"); map[a["l"]] = list;
            El(list, "script", null, "IList", ("style", "display: flex; height: 0px; width: 100%;"));
            var row = Keyed(El(list, "div", "row", null, ("data-container", "")), "KeyRow", "IContainer"); map[a["r"]] = row;
            El(list, "script", null, "IList", ("style", "display: flex; height: 0px; width: 100%;"));
            return (fragment, map);
        }, new ScreenVisual.Sheet(".rows>.row:first-child{border-top:0}\n.rows .row:last-child{border-bottom:0}\n.rows .row{padding:8px}", "page"));
        var findings = Run(input);
        var positional = findings.Where(x => x.Code == Positional).ToList();
        Assert.Equal(2, positional.Count);
        Assert.Equal(".rows>.row:nth-child(1 of :not(script))", Assert.Single(positional, x => x.Subject == ".rows>.row:first-child").Right);
        Assert.Equal(".rows .row:nth-last-child(1 of :not(script))", Assert.Single(positional, x => x.Subject == ".rows .row:last-child").Right);
        Assert.Contains("sentinel", positional[0].Why);
        // the wrapper branch leaves them to their own family (no second warning on the same selector)
        Assert.DoesNotContain(findings, x => x.Code == ScreenVisual.SelectorMissesRuntime && x.Subject.Contains("-child"));
        var row = input.Counterparts.Values.Single(v => v.Classes.Contains("row"));
        foreach (var p in positional) Assert.True(CssSelectors.Matches(row, p.Right!));
    }

    [Fact]
    public void AWidthARuntimeClassGivesAFlexItemComesWithTheValueThePageMeant()
    {
        // (d): the runtime adds OSFillParent to a List whose Width is (fill parent); in the author's flex row the platform's
        // .OSFillParent{width:100%} makes it the whole row.
        var html = "<screen name=\"Page\"><div id=\"w\" class=\"wrap\"><div id=\"ch\" class=\"chart\" list=\"Points\"><div class=\"bar\">{{ V }}</div></div><div id=\"s\" class=\"side\">Side</div></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var wrap = Keyed(El(fragment, "div", "wrap", null, ("data-container", "")), "KeyWrap", "IContainer"); map[a["w"]] = wrap;
            var list = Keyed(El(wrap, "div", "chart OSFillParent", null, ("data-list", ""), ("data-virtualization-disabled", "")), "KeyChart", "IList"); map[a["ch"]] = list;
            El(list, "div", "bar", null, ("data-container", "")).Add(DomNode.TextNode("V"));
            var side = Keyed(El(wrap, "div", "side", null, ("data-container", "")), "KeySide", "IContainer"); map[a["s"]] = side;
            side.Add(DomNode.TextNode("Side"));
            return (fragment, map);
        }, Platform("OutSystemsUI.css", ".OSFillParent{width:100%}"), new ScreenVisual.Sheet(".wrap{display:flex;gap:16px}\n.chart{min-height:120px}\n.side{width:240px}", "page"));
        var f = Assert.Single(Run(input), x => x.Code == Injected);
        Assert.Contains("OSFillParent", f.Why);
        Assert.Contains("width:100%", f.Why);
        Assert.Equal(".chart.OSFillParent", f.Right);
        Assert.Equal(".chart.OSFillParent{width:auto}", f.Append);
    }

    [Fact]
    public void AFixedLayoutElementThatCoversTheContentOrLeavesTheScreenIsSaidPerBreakpoint()
    {
        // (e): the platform fixes the menu at 300px on the left; the content beside it starts at 16px (desktop); at tablet the
        // device class moves the menu off screen.
        var html = "<screen name=\"Page\"><div id=\"ly\" class=\"layout\"><div id=\"m\" class=\"app-menu-content\"><a id=\"h\">Home</a></div><div id=\"mc\" class=\"main-content\"><h1 id=\"t\">Title</h1></div></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var layout = Keyed(El(fragment, "div", "layout", null, ("data-container", "")), "KeyLayout", "IContainer"); map[a["ly"]] = layout;
            var menu = Keyed(El(layout, "div", "app-menu-content", null, ("data-container", "")), "KeyMenu", "IContainer"); map[a["m"]] = menu;
            var link = Keyed(El(menu, "a", null, null, ("data-link", ""), ("href", "#")), "KeyHome", "ILink"); map[a["h"]] = link;
            link.Add(DomNode.TextNode("Home"));
            var main = Keyed(El(layout, "div", "main-content", null, ("data-container", "")), "KeyMain", "IContainer"); map[a["mc"]] = main;
            var title = Keyed(El(main, "h1", null, null, ("data-advancedhtml", "")), "KeyTitle", "IAdvancedHtml"); map[a["t"]] = title;
            title.Add(DomNode.TextNode("Title"));
            return (fragment, map);
        }, Platform("OutSystemsUI.css", ":root{--side-menu-size:300px}\n.app-menu-content{position:fixed;top:0;left:0;width:var(--side-menu-size);height:100%}\n.tablet .app-menu-content{transform:translateX(-100%)}"),
           new ScreenVisual.Sheet(".main-content{padding:16px}\n.app-menu-content{left:0}", "page"));
        var findings = Run(input).Where(x => x.Code == FixedLayout).ToList();
        Assert.Equal(2, findings.Count);
        var covers = Assert.Single(findings, x => x.Kind == "covers");
        Assert.Contains("300px", covers.Why);
        Assert.Contains("desktop", covers.Why);
        Assert.Contains(".desktop div.main-content[data-container]{margin-left:300px}", covers.Candidates);
        var hidden = Assert.Single(findings, x => x.Kind == "hidden");
        Assert.Contains("tablet", hidden.Why);
        Assert.Contains("translateX(-100%)", hidden.Why, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(hidden.Candidates);
        Assert.Null(hidden.Right);
    }

    // ---- the correction round (REVISAO-R3A.md F1, F3, F4, F7, F8) ---------------------------------------------------------

    private static ScreenVisual.CheckInput Menu(string layoutClass, bool blockInstance, params ScreenVisual.Sheet[] sheets)
    {
        var html = "<screen name=\"Page\"><div id=\"ly\" class=\"" + layoutClass + "\"><div id=\"m\" class=\"app-menu-content\"><a id=\"h\">Home</a></div><div id=\"mc\" class=\"main-content\"><h1 id=\"t\">Title</h1></div></div></screen>";
        return Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var layout = Keyed(El(fragment, "div", layoutClass, null, ("data-container", "")), "KeyLayout", "IContainer"); map[a["ly"]] = layout;
            var menu = Keyed(El(layout, "div", "app-menu-content", null, ("data-container", "")), "KeyMenu", "IContainer"); map[a["m"]] = menu;
            var link = Keyed(El(menu, "a", null, null, ("data-link", ""), ("href", "#")), "KeyHome", "ILink"); map[a["h"]] = link;
            link.Add(DomNode.TextNode("Home"));
            // the content beside the menu: the layout's own .main-content, or a block instance of another module around it
            var host = blockInstance ? Keyed(El(layout, "div", "OSBlockWidget", "IMobileBlockInstanceWidget", ("data-block", "")), "KeyBlock", "IMobileBlockInstanceWidget") : layout;
            var main = Keyed(El(host, "div", "main-content", null, ("data-container", "")), "KeyMain", "IContainer"); map[a["mc"]] = main;
            var title = Keyed(El(main, "h1", null, null, ("data-advancedhtml", "")), "KeyTitle", "IAdvancedHtml"); map[a["t"]] = title;
            title.Add(DomNode.TextNode("Title"));
            return (fragment, map);
        }, sheets);
    }

    private const string SideMenuSample = ":root{--side-menu-size:300px}\n.layout-side .app-menu-content{position:fixed;top:0;left:0;width:var(--side-menu-size);height:100%}\n"
        + ".tablet .app-menu-content{position:fixed;left:calc(-1*var(--side-menu-size))}\n.layout-side .main-content{margin-left:var(--side-menu-size)}";

    [Fact]
    public void TheMenuTheThemeMovesOffScreenAtADeviceClassIsItsDesignNotAWarning()
    {
        // F1: the hamburger menu of the layout (off screen at tablet and phone until its toggle opens it) and the content the
        // layout already moves beside the menu: no warning, no patch that would undo the platform's menu.
        var findings = Run(Menu("layout layout-side", false, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample)));
        Assert.DoesNotContain(findings, x => x.Code == FixedLayout);
        // an unknown wrapper between the layout and the content (a block instance of another module): silence, never a guess
        var unknown = Run(Menu("layout layout-side", true, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample.Replace(".layout-side .main-content{margin-left:var(--side-menu-size)}", ""))));
        Assert.DoesNotContain(unknown, x => x.Code == FixedLayout);
    }

    [Fact]
    public void AThemeThatOnlyResizesTheMenuKeepsNothingOnScreen()
    {
        // V8: a width never keeps the menu on screen against the device class that moves it off
        var findings = Run(Menu("layout layout-side", false, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample), new ScreenVisual.Sheet(".app-menu-content{width:260px}", "page")));
        Assert.DoesNotContain(findings, x => x.Code == FixedLayout);
    }

    [Fact]
    public void ALayoutDisplayOfTheMenuKeepsNothingOnScreen()
    {
        // V8b: display:flex (a column) does not hold a menu a negative offset moved off; only a contradicting offset does
        var findings = Run(Menu("layout layout-side", false, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample), new ScreenVisual.Sheet(".app-menu-content{display:flex;flex-direction:column}", "page")));
        Assert.DoesNotContain(findings, x => x.Code == FixedLayout);
        var offset = Run(Menu("layout layout-side", false, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample), new ScreenVisual.Sheet(".app-menu-content{left:0}", "page")));
        Assert.Contains(offset, x => x.Code == FixedLayout && x.Kind == "hidden");
    }

    [Fact]
    public void AVerticalOffsetKeepsNoMenuTheLeftMovedOff()
    {
        // V8c: the menu below a fixed header (top) or with a margin on top is still off screen by the left at tablet
        foreach (var css in new[] { ".app-menu-content{top:64px}", ".app-menu-content{margin-top:16px}" })
            Assert.DoesNotContain(Run(Menu("layout layout-side", false, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample), new ScreenVisual.Sheet(css, "page"))), x => x.Code == FixedLayout);
        Assert.Contains(Run(Menu("layout layout-side", false, Platform("OutSystemsUI.OutSystemsUI.css", SideMenuSample), new ScreenVisual.Sheet(".app-menu-content{left:0}", "page"))), x => x.Code == FixedLayout && x.Kind == "hidden");
    }

    [Fact]
    public void TheHandWrittenOutSystemsUiRulesStayWhenOnlyTheRuntimeSheetIsThere()
    {
        // F3: a store with the runtime's base sheet only (an extraction that found no OutSystems UI theme)
        var html = "<screen name=\"Page\"><div class=\"form-box\"><input id=\"i\" class=\"f\"/></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var span = El(El(fragment, "div", "form-box", null, ("data-container", "")), "span", "input-text", "IInput");
            var control = El(span, "input", "f form-control", null, ("data-input", ""), ("type", "text")); control.Widget = "IInput";
            map[a["i"]] = control;
            return (fragment, map);
        }, Platform("OutSystemsReactWidgets.css", "span[data-expression]{white-space:pre-wrap}"), new ScreenVisual.Sheet(".f{height:50px}", "page"));
        Assert.Contains(Run(input), x => x.Code == ScreenVisual.SelectorMissesRuntime && x.Kind == "specificity");
    }

    [Fact]
    public void APlatformInheritIsTheAuthorsValueNotALoss()
    {
        // F4: the platform's span[data-expression]{white-space:inherit} gives the text the author's nowrap
        var html = "<screen name=\"Page\"><div id=\"c\" class=\"cell\">{{ Total }}</div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var cell = Keyed(El(fragment, "div", "cell", null, ("data-container", "")), "KeyCell", "IContainer"); map[a["c"]] = cell;
            Keyed(El(cell, "span", null, "IExpression", ("data-expression", "")), "KeyExpr", "IExpression").Add(DomNode.TextNode("Total"));
            return (fragment, map);
        }, Platform("OutSystemsReactWidgets.css", "span[data-expression]{white-space:inherit;word-break:initial}"), new ScreenVisual.Sheet(".cell{white-space:nowrap;word-break:normal}", "page"));
        Assert.DoesNotContain(Run(input), x => x.Code == Inherited);
    }

    private ScreenVisual.CheckInput Field(string platformCss, string authorCss)
    {
        var html = "<screen name=\"Page\"><div class=\"form-box\"><input id=\"i\" class=\"f\"/></div></screen>";
        return Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var span = El(El(fragment, "div", "form-box", null, ("data-container", "")), "span", "input-text", "IInput");
            map[a["i"]] = Keyed(El(span, "input", "f form-control", null, ("data-input", ""), ("type", "text")), "KeyInput1", "IInput");
            return (fragment, map);
        }, Platform("OutSystemsUI.OutSystemsUI.css", platformCss), new ScreenVisual.Sheet(authorCss, "page"));
    }

    [Fact]
    public void ValuesTheBrowserComputesAlikeAreNoLoss()
    {
        // F7: 0 and 0px, #fff and white compute alike
        Assert.DoesNotContain(Run(Field(".form-control[data-input]{margin-top:0px;color:#ffffff}", ".f{margin-top:0;color:white}")), x => x.Code == Specificity);
    }

    [Fact]
    public void ARuleInALayerLosesToTheUnlayeredPlatformRuleAtAnySpecificity()
    {
        // F8: (0,2,0) in @layer app loses to the platform's unlayered (0,1,0): the browser shows 32px
        var f = Assert.Single(Run(Field(".f{height:32px}", "@layer app{.f.form-control{height:50px}}")), x => x.Code == Specificity);
        Assert.Null(f.Right);
        Assert.Contains(".f.form-control{height:50px}", f.Candidates);
        Assert.Contains("@layer", f.Why);
    }

    [Fact]
    public void WithoutThePlatformSheetsTheCascadeFamiliesSayNothingAndTheHandWrittenRulesStay()
    {
        // The same page as (a) with no platform sheet: no platform warning (never a cascade silently approximated).
        var html = "<screen name=\"Page\"><div class=\"form-box\"><input id=\"i\" class=\"f\"/></div></screen>";
        var input = Input(html, a =>
        {
            var fragment = DomNode.Fragment();
            var map = new Dictionary<DomNode, DomNode>(ReferenceEqualityComparer.Instance);
            var box = El(fragment, "div", "form-box", null, ("data-container", ""));
            var span = El(box, "span", "input-text", "IInput");
            var control = El(span, "input", "f form-control", null, ("data-input", ""), ("type", "text")); control.Widget = "IInput";
            map[a["i"]] = control;
            return (fragment, map);
        }, new ScreenVisual.Sheet(".f{height:50px}", "page"));
        var findings = Run(input);
        Assert.DoesNotContain(findings, x => x.Code.StartsWith("HTML_PLATFORM_", StringComparison.Ordinal));
        // the hand-written OutSystems UI control rule still answers (.form-control[data-input] beats .f)
        Assert.Contains(findings, x => x.Code == ScreenVisual.SelectorMissesRuntime && x.Kind == "specificity");
    }
}
