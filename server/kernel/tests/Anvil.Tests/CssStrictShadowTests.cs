using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D after its review: the shadowed stage removes a rule only when every browser that shows it shows the later rule instead
/// (a comment in a selector is no space; a later value a browser could drop or a fallback the later rule does not repeat keeps
/// the earlier rule), and says which rules went; a data.css of whitespace is no data.css; a data: url inside a comment or a
/// string is no url. Synthetic selectors.
/// </summary>
public sealed class CssStrictShadowTests
{
    private static CssPipeline.Outcome Normal(string css) => CssPipeline.Normalize(css, new CssPipeline.Context("test"));
    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    [Theory]
    // A comment between two characters of a selector is no space: ".x/**/.y" is the compound ".x.y", "nav/**/li" no selector.
    [InlineData(".x .y{color:red}\n.x/**/.y{color:red}")]
    [InlineData("nav li{color:red}\nnav/**/li{color:red}")]
    public void ACommentInsideASelectorIsNoSpace(string css)
    {
        Assert.Equal(css, Normal(css).Css);
    }

    [Fact]
    public void ACommentThatTouchesASpaceReadsAsTheSpace()
    {
        Assert.Equal(".p{margin:0}", Normal(".p /* x */ {margin:0}\n.p{margin:0}").Css);
        Assert.Equal(".x .y{color:red}", Normal(".x /**/.y{color:red}\n.x .y{color:red}").Css);
    }

    [Theory]
    // A later value a browser drops at parse time: the earlier rule shows there.
    [InlineData(".w{width:100px}\n.w{width:100}")]
    [InlineData(".t{font-weight:600}\n.t{font-weight:semibold}")]
    [InlineData(".p{padding:4px}\n.p{padding:-4px}")]
    [InlineData(".c{color:red}\n.c{color:redd}")]
    [InlineData(".c{color:red}\n.c{color:}")]
    // A newer unit or a fallback pair the later rule does not repeat whole: an older engine shows the earlier rule.
    [InlineData(".h{height:100vh}\n.h{height:100dvh}")]
    [InlineData(".f{display:-webkit-box;display:flex}\n.f{display:flex}")]
    [InlineData(".h{height:100vh;height:100dvh}\n.h{height:100dvh}")]
    // Two values that differ inside a url that is not well formed are compared as written.
    [InlineData(".u{background:url(a b.png)}\n.u{background:url(c.png)}")]
    public void ALaterValueABrowserCouldDropLeavesTheEarlierRule(string css)
    {
        Assert.Equal(css, Normal(css).Css);
    }

    [Theory]
    // The same value, the same value but for what its well-formed urls name, a custom property, a CSS-wide keyword.
    [InlineData(".a{color:red;background:url(data:x)}\n.a{color:red;background:url(/i.png)}", ".a{color:red;background:url(/i.png)}")]
    [InlineData(".a{background:url(\"data:image/png;base64,AAAA\") no-repeat}\n.a{background:url('/M/img/M.I.png') no-repeat}", ".a{background:url('/M/img/M.I.png') no-repeat}")]
    [InlineData(".a{--tone:red}\n.a{--tone:blue}", ".a{--tone:blue}")]
    [InlineData(".a{color:red}\n.a{color:inherit}", ".a{color:inherit}")]
    [InlineData(".a{display:-webkit-box;display:flex}\n.a{display:-webkit-box;display:flex}", ".a{display:-webkit-box;display:flex}")]
    public void WhatEveryBrowserOverridesGoes(string css, string expected)
    {
        Assert.Equal(expected, Normal(css).Css);
    }

    [Fact]
    public void TheStageAndTheReportNameTheRulesThatWent()
    {
        var outcome = Normal(".a{color:red}\n@media print{.b{x:1} .b{x:1}}\n.a{color:red}");
        var stage = Assert.Single(outcome.StageChanges, c => c["stage"]?.ToString() == "shadowed");
        Assert.Equal([".a", "@media print .b"], stage["rules"]!.AsArray().Select(r => r!.ToString()));
        Assert.Null(stage["more"]);
        // More than 20: twenty names, then the count of the others.
        var many = string.Concat(Enumerable.Range(1, 25).Select(i => $".r{i}{{x:1}}\n")) + string.Concat(Enumerable.Range(1, 25).Select(i => $".r{i}{{x:1}}\n"));
        var listed = Assert.Single(Normal(many).StageChanges, c => c["stage"]?.ToString() == "shadowed");
        Assert.Equal(25, listed["removed"]!.GetValue<int>());
        Assert.Equal(20, listed["rules"]!.AsArray().Count);
        Assert.Equal(5, listed["more"]!.GetValue<int>());
        // The answer's styleSheet names the rules a write removed from the sheet.
        var report = ModelSession.StyleSheetReport(".keep{x:1}\n.gone{y:2}\n@media print{.also{z:3}}", ".keep{x:1}", null);
        Assert.Equal(2, report["rulesRemoved"]!.GetValue<int>());
        Assert.Equal([".gone", "@media print .also"], report["removedRules"]!.AsArray().Select(r => r!.ToString()));
    }

    [Fact]
    public void ADataCssOfWhitespaceIsNoDataCss()
    {
        Assert.Null(ScreenHtmlEdit.DataCss(new JsonObject { ["css"] = "  \n" }));
        Assert.False(ScreenHtmlEdit.CssOnly(new JsonObject { ["screen"] = "Page", ["css"] = " \n\t" }));
        var blocks = ScreenDocument.Styles(ScreenHtml.Parse("<screen name=\"S\"><style>.a{color:red}</style></screen>").Children[0]);
        Assert.Equal(".a{color:red}", ScreenDocument.OwnSheet(blocks, " \n"));
        Assert.Null(ScreenDocument.ReplacedSheet(blocks, " \n"));
        // Without anything else to edit, the edit is refused: nothing to write.
        var refused = Assert.Throws<KernelRefusalException>(() => ScreenHtmlEdit.Preflight(new JsonObject {
            ["screen"] = "Page", ["basedOn"] = new JsonObject { ["capture"] = new string('c', 64), ["html"] = new string('d', 64) }, ["css"] = " \n" }));
        Assert.Contains("'css' (the whole style sheet) is required", refused.Message);
    }

    [Fact]
    public void ADataUrlInACommentOrAStringIsNoUrl()
    {
        var text = "/* was: url(data:image/png;base64," + Png + ") */\n.a{content:\"url(data:image/png;base64," + Png + ")\"}";
        Assert.Empty(CssDataUrls.Find(text));
        // The url the CSS uses, quoted or not, still is one.
        Assert.Equal(2, CssDataUrls.Find(text + "\n.b{background:url(\"data:image/png;base64," + Png + "\")}\n.c{background:url( data:image/png;base64," + Png + " )}").Count);
    }
}
