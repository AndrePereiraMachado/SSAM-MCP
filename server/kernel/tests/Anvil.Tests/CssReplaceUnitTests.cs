using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D, the pure parts: what data.css replaced (PlaceCss), the rules a write adds and removes (CssShadowedRules.Diff), and what
/// a base64 data: image of the CSS becomes (CssDataUrls). Synthetic names.
/// </summary>
public sealed class CssReplaceUnitTests
{
    private const string Reading = "<screen name=\"Page\">\n<style>.read { margin: 0; }</style>\n<div k=\"w1\"/>\n</screen>\n";

    [Fact]
    public void WhatDataCssReplacedIsTheReadingsSheetOrTheEditsOwnStyle()
    {
        var elements = ScreenHtmlEdit.PlaceCss(["<div k=\"w1\"/>"], ".b{}", Reading);
        Assert.Equal(".read { margin: 0; }", elements.Replaced);
        Assert.False(elements.ReplacedTheEdits);
        Assert.False(ScreenHtmlEdit.PlaceCss([Reading], ".b{}", Reading).ReplacedTheEdits);
        var own = ScreenHtmlEdit.PlaceCss(["<style>.other{}</style>"], ".b{}", Reading);
        Assert.True(own.ReplacedTheEdits);
        Assert.Equal(".other{}", own.Replaced);
        Assert.Equal((0, ".read { margin: 0; }"), ScreenHtmlEdit.OwnSheet([Reading])!.Value);
        Assert.Equal(".x{}", ScreenHtmlEdit.OwnSheetOf(ScreenHtmlEdit.WithOwnSheet([Reading], 0, ".x{}")[0]));
        Assert.Null(ScreenHtmlEdit.OwnSheet(["<div k=\"w1\"/>"]));
    }

    [Fact]
    public void TheRulesAWriteAddsAndRemovesAreCountedAsRules()
    {
        Assert.Equal((0, 0), CssShadowedRules.Diff(".a{x:1}\n.b{y:2}", ".a { x: 1 }\n.b{y:2}") is { } d ? (d.Added, d.Removed) : default);
        Assert.Equal((1, 2), CssShadowedRules.Diff(".a{x:1}\n.b{y:2}\n@media print{.c{z:3}}", ".a{x:1}\n.d{w:4}") is { } d2 ? (d2.Added, d2.Removed) : default);
        Assert.Equal((2, 0), CssShadowedRules.Diff("", ".a{x:1}@keyframes k{from{opacity:0}}") is { } d3 ? (d3.Added, d3.Removed) : default);
        Assert.Null(CssShadowedRules.Diff(".a{x:1}", ".a{ &:hover{x:2} }"));
        Assert.Equal([".b", "@media print .c"], CssShadowedRules.Diff(".a{x:1}\n.b{y:2}\n@media print{.c{z:3}}", ".a{x:1}\n.d{w:4}")!.Value.RemovedNames);
        Assert.Equal(3, CssShadowedRules.Count("@import url(a.css);\n.a{x:1}\n@media print{.b{y:2}}"));
    }

    [Fact]
    public void ABase64DataImageIsDescribedByItsBytes()
    {
        const string png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        var svg = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"/>"));
        var gif = Convert.ToBase64String([(byte)'G', (byte)'I', (byte)'F', (byte)'8', (byte)'9', (byte)'a', 3, 0, 2, 0, 0, 0, 0]);
        var css = ".a{background:url(\"data:image/png;base64," + png + "\")}\n.b{mask:url('data:image/svg+xml;base64," + svg + "')}\n"
            + ".c{background:url(data:image/gif;base64," + gif + ")}\n.d{background:url(data:image/webp;base64,UklGRg==)}\n"
            + ".e{mask:url(\"data:image/svg+xml,%3Csvg%3E%3C/svg%3E\")}\n.f{background:url(data:image/png;base64,AAAA)}";
        var found = CssDataUrls.Find(css);
        Assert.Equal(["image/png", "image/svg+xml", "image/gif", "image/webp", "image/png"], found.Select(f => f.Mime));   // the percent-encoded svg is not base64
        var described = found.Select(f => CssDataUrls.Describe(f, "Accounts")).ToList();
        Assert.Matches("^AccountsImage[0-9a-f]{8}$", described[0].Name);
        Assert.Equal(("png", "Png", 1, 1), (described[0].Extension, described[0].Args["format"]!.ToString(), described[0].Args["width"]!.GetValue<int>(), described[0].Args["height"]!.GetValue<int>()));
        Assert.Equal("svg", described[1].Extension);
        Assert.Null(described[1].Args["format"]);
        Assert.Equal(("gif", 3, 2), (described[2].Extension, described[2].Args["width"]!.GetValue<int>(), described[2].Args["height"]!.GetValue<int>()));
        Assert.Contains("not a type of the module images", described[3].Kept);
        Assert.Contains("not a png image", described[4].Kept);
        // The same bytes, the same name; the url replaces the whole token.
        Assert.Equal(described[0].Name, CssDataUrls.Describe(CssDataUrls.Find(".x{background:url(data:image/png;base64," + png + ")}")[0], "Accounts").Name);
        var rewritten = CssDataUrls.Rewrite(css, found, new Dictionary<string, string> { [found[0].Token] = "/M/img/M.I.png" });
        Assert.Contains(".a{background:url(\"/M/img/M.I.png\")}", rewritten);
        Assert.Contains("data:image/svg+xml;base64", rewritten);
    }
}
