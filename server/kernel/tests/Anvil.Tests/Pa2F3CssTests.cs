using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F3 of the atritos 2 package, A30: the CSS of a prototype rendered "preto e branco" in the Cardapio screens
/// (light-dark and color-mix, 2026-10-06 13:50). CssCompat expands light-dark into the light value plus a dark @media block
/// and refuses color-mix with the color it computes; the fragment, the page and a raw set StyleSheet all apply it. Pure.
/// </summary>
public sealed class Pa2F3CssTests
{
    [Fact]
    public void LightDarkIsTheLightValuePlusADarkMediaBlock()
    {
        var result = CssCompat.Rewrite(":root { --bg: light-dark(#ffffff, #111111); color-scheme: light dark; }\n.card { border: 1px solid light-dark(#cccccc, #333333); padding: 4px; }");
        Assert.Equal(2, result.Expanded);
        Assert.Empty(result.Problems);
        Assert.DoesNotContain("light-dark", result.Css);
        var sheet = CssStylesheet.Parse(result.Css);
        var light = sheet.Rules.Where(r => r.EnclosingRules.Count == 0).ToList();
        Assert.Contains(light, r => r.Selector == ":root" && r.Declarations.Any(d => d.Property == "--bg" && d.Value == "#ffffff"));
        Assert.Contains(light, r => r.Selector == ".card" && r.Declarations.Any(d => d.Property == "border" && d.Value == "1px solid #cccccc") && r.Declarations.Any(d => d.Property == "padding"));
        var dark = sheet.Rules.Where(r => r.EnclosingRules.SequenceEqual(["@media (prefers-color-scheme: dark)"])).ToList();
        Assert.Contains(dark, r => r.Selector == ":root" && r.Declarations.Single().Value == "#111111");
        Assert.Contains(dark, r => r.Selector == ".card" && r.Declarations.Single().Value == "1px solid #333333");
    }

    [Fact]
    public void LightDarkInsideAMediaQueryKeepsItsEnclosingRule()
    {
        var result = CssCompat.Rewrite("@media (max-width: 600px) { .a { color: light-dark(black, white); } }");
        var dark = CssStylesheet.Parse(result.Css).Rules.Single(r => r.EnclosingRules.Count == 2);
        Assert.Equal(["@media (max-width: 600px)", "@media (prefers-color-scheme: dark)"], dark.EnclosingRules);
        Assert.Equal("white", dark.Declarations.Single().Value);
    }

    [Fact]
    public void CssWithoutTheseFunctionsIsKeptVerbatim()
    {
        const string css = "/* note */ .a { color: red; }";
        var result = CssCompat.Rewrite(css);
        Assert.Equal(css, result.Css);
        Assert.Equal(0, result.Expanded);
        Assert.Empty(result.Problems);
    }

    [Theory]
    [InlineData("color-mix(in srgb, #ff0000 50%, #0000ff)", "#800080")]
    [InlineData("color-mix(in srgb, #ff0000, #0000ff)", "#800080")]
    [InlineData("color-mix(in srgb, white 25%, black)", "#404040")]
    [InlineData("color-mix(in oklab, #2563eb 15%, transparent)", "rgba(37, 99, 235, 0.15)")]
    [InlineData("color-mix(in srgb, rgb(255 0 0) 20%, transparent)", "rgba(255, 0, 0, 0.2)")]
    public void ColorMixOfLiteralsIsRefusedWithTheColorItComputes(string mix, string expected)
    {
        var result = CssCompat.Rewrite($".a {{ background: {mix}; }}");
        var problem = Assert.Single(result.Problems);
        Assert.Equal(expected, problem.Substitute);
        Assert.Contains(expected, problem.Fix);
        Assert.Contains($"background: {expected}", result.Mechanical);
    }

    [Fact]
    public void ColorMixWithAVariableHasNoSubstituteAndNoMechanicalRewrite()
    {
        var result = CssCompat.Rewrite(".a { color: color-mix(in oklch, var(--accent) 40%, white); }\n.b { content: \"color-mix(x)\"; }");
        var problem = Assert.Single(result.Problems);
        Assert.Null(problem.Substitute);
        Assert.Equal(1, problem.Line);
        Assert.Null(result.Mechanical);
        Assert.Contains("literal color", problem.Fix);
    }

    [Fact]
    public void TheFragmentStylesheetIsExpandedAndColorMixRefused()
    {
        var scope = new HtmlVisualScope([], HtmlVisualScope.Map(), HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null);
        var fragment = HtmlVisual.Expand("<style>.x { color: light-dark(#000000, #ffffff); }</style><div class=\"x\"></div>", "$screen", scope);
        Assert.Contains("@media (prefers-color-scheme: dark)", fragment.ScopedCss);
        Assert.Contains(".x { color: #000000; }", fragment.ScopedCss);
        Assert.DoesNotContain("light-dark", fragment.ScopedCss);
        var ex = Assert.Throws<InvalidOperationException>(() => HtmlVisual.Expand("<style>.x { color: color-mix(in srgb, red 50%, blue); }</style><div class=\"x\"></div>", "$screen", scope));
        Assert.Equal("CSS_FUNCTION_UNSUPPORTED", Errors.FindCoded(ex)!.Problems![0]!["code"]!.ToString());
    }

    [Fact]
    public void ThePageStylesheetIsExpandedAndColorMixRefusedAtItsField()
    {
        var data = JsonNode.Parse("""{"screen":"Pa2Css","html":"<div class=\"x\">Hi</div>","css":".x { color: color-mix(in srgb, red 50%, blue); background: light-dark(#fff, #000); }"}""")!.AsObject();
        var ex = Assert.Throws<InvalidOperationException>(() => HtmlExpander.Preflight(data));
        var problem = Errors.FindCoded(ex)!.Problems![0]!;
        Assert.Equal("CSS_FUNCTION_UNSUPPORTED", problem["code"]!.ToString());
        Assert.Equal("/css", problem["pointer"]!.ToString());
        Assert.Contains("#800080", problem["fix"]!.ToString());
        var ok = JsonNode.Parse("""{"screen":"Pa2Css","html":"<div class=\"x\">Hi</div>","css":".x { background: light-dark(#fff, #000); }"}""")!.AsObject();
        Assert.Equal(2, HtmlExpander.Preflight(ok)["cssRules"]!.GetValue<int>());
    }

    [Fact]
    public void ARawSetStyleSheetIsOneProblemWithThePatchWhenTheChangeIsMechanical()
    {
        var ops = JsonNode.Parse("""
            [{"op":"set","target":"IMobileTheme:App","prop":"StyleSheet","value":".a { color: light-dark(#000000, #ffffff); background: color-mix(in srgb, #ff0000 50%, #0000ff); }"},
             {"op":"set","target":"IMobileTheme:App","prop":"StyleSheet","value":".a { color: color-mix(in oklch, var(--x), white); }"},
             {"op":"set","target":"IMobileTheme:App","prop":"StyleSheet","value":".a { color: red; }"}]
            """)!.AsArray();
        var problems = StyleSheetRules.Check(ops, "o11").ToList();
        Assert.Equal(2, problems.Count);
        var mechanical = problems[0];
        Assert.Equal("CSS_FUNCTION_UNSUPPORTED", mechanical["code"]!.ToString());
        Assert.Equal("/ops/0/value", mechanical["pointer"]!.ToString());
        var patched = mechanical["patch"]![0]!["value"]!.ToString();
        Assert.Contains("background: #800080", patched);
        Assert.Contains("@media (prefers-color-scheme: dark)", patched);
        Assert.Null(problems[1]["patch"]);
        // Familias (2026-10-12): the preflight writes the mechanical change itself (CSS_FUNCTION_REWRITTEN, listed) instead of
        // refusing it; the rule, found by the I1 convention, refuses only what has no single rendering.
        var analysis = JobPreflight.Analyze(ops);
        Assert.DoesNotContain(analysis["problems"]!.AsArray(), p => p!["code"]?.ToString() == "CSS_FUNCTION_UNSUPPORTED" && p["pointer"]?.ToString() == "/ops/0/value");
        Assert.Contains(analysis["normalizations"]!.AsArray(), n => n!["rule"]?.ToString() == "CSS_FUNCTION_REWRITTEN" && n["path"]?.ToString() == "/ops/0/value");
        Assert.Contains("background: #800080", ops[0]!["value"]!.ToString());
        Assert.Contains(analysis["problems"]!.AsArray(), p => p!["code"]?.ToString() == "CSS_FUNCTION_UNSUPPORTED" && p["pointer"]?.ToString() == "/ops/1/value");
    }
}
