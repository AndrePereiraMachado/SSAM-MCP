using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane kh of the atritos 3 package, the CSS: the scope class is never prefixed twice (C20), a selector that starts with
/// #reactContainer also selects in the Studio canvas and @keyframes/@font-face pass whole (C35), and an @import after a rule
/// goes to the top (C23, the raw set side; the split theme side is Pa3KhOdcTests). Pure: no Studio.
/// </summary>
public sealed class Pa3KhCssTests
{
    // ---- C20 --------------------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(".ttt-wrap { display: flex; }", ".ttt-wrap { display: flex; }")]
    [InlineData(".ttt-wrap .cell { color: red; }", ".ttt-wrap .cell { color: red; }")]
    [InlineData(".ttt-wrap:hover { color: red; }", ".ttt-wrap:hover { color: red; }")]
    [InlineData(".ttt-wrap > .cell { color: red; }", ".ttt-wrap > .cell { color: red; }")]
    [InlineData(".ttt-wrap.active { color: red; }", ".ttt-wrap.active { color: red; }")]
    [InlineData(".ttt-wrapper { color: red; }", ".ttt-wrap .ttt-wrapper { color: red; }")]
    [InlineData(".cell { color: red; }", ".ttt-wrap .cell { color: red; }")]
    public void TheScopeClassIsNeverPrefixedTwice(string css, string scoped)
        => Assert.Equal(scoped, CssStylesheet.Parse(css).Scoped(".ttt-wrap"));

    [Fact]
    public void TheFragmentRootSelectorKeepsItsOwnRule()
    {
        // The tic-tac-toe board of 2026-10-06 came out ".ttt-wrap .ttt-wrap { display:flex }" and the first square fell out.
        var scope = new HtmlVisualScope([], HtmlVisualScope.Map(), HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null);
        var fragment = HtmlVisual.Expand("<style>.ttt-wrap { display: grid; } .ttt-wrap .cell { width: 64px; }</style><div class=\"ttt-wrap\"><div class=\"cell\"></div></div>", "$screen", scope);
        Assert.Contains(".ttt-wrap { display: grid; }", fragment.ScopedCss);
        Assert.Contains(".ttt-wrap .cell { width: 64px; }", fragment.ScopedCss);
        Assert.DoesNotContain(".ttt-wrap .ttt-wrap", fragment.ScopedCss);
        // the owned form (components) follows the same rule
        Assert.Equal(".root:where(.owner) { color: red; }\n", CssStylesheet.Parse(".root { color: red; }").ScopedOwned(".root", ".owner"));
    }

    // ---- C35 --------------------------------------------------------------------------------------------------------------

    [Fact]
    public void AReactContainerSelectorAlsoSelectsInTheStudioCanvas()
    {
        const string css = "/* shell */\n#reactContainer .login-card { padding: 8px; }\n#reactContainer, .x { margin: 0; }\n.a #reactContainer { color: red; }\n@media (max-width: 600px) {\n  #reactContainer > .shell { display: block; }\n}";
        var (rewritten, rewrites) = CssCompat.CanvasSelectors(css);
        Assert.Equal(3, rewrites.Count);
        Assert.Contains(":is(#reactContainer, body) .login-card { padding: 8px; }", rewritten);
        Assert.Contains(":is(#reactContainer, body), .x { margin: 0; }", rewritten);
        Assert.Contains(".a #reactContainer { color: red; }", rewritten);   // only a selector that starts with it
        Assert.Contains("  :is(#reactContainer, body) > .shell { display: block; }", rewritten);
        Assert.StartsWith("/* shell */\n", rewritten);
        Assert.Equal(2, rewrites[0].Line);
        Assert.Equal("#reactContainer .login-card", rewrites[0].From);
        // nothing to rewrite: the same text
        const string plain = ".a #reactContainer { color: red; }";
        Assert.Same(plain, CssCompat.CanvasSelectors(plain).Css);
    }

    [Fact]
    public void KeyframesAndFontFacePassWholeAndUnscoped()
    {
        const string css = "@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }\n@font-face { font-family: \"Inter\"; src: url(\"/fonts/inter.woff2\") format(\"woff2\"); }\n.spinner { animation: spin 1s linear infinite; }";
        var sheet = CssStylesheet.Parse(css);
        Assert.Equal(2, sheet.Blocks.Count);
        Assert.Single(sheet.Rules);
        var scoped = sheet.Scoped(".wf-x");
        Assert.Contains("@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }", scoped);
        Assert.Contains("@font-face { font-family: \"Inter\"; src: url(\"/fonts/inter.woff2\") format(\"woff2\"); }", scoped);
        Assert.Contains(".wf-x .spinner { animation: spin 1s linear infinite; }", scoped);
        // the fragment compiles it (it was "css: unsupported at-rule '@keyframes spin'"), and light-dark keeps the block
        var scope = new HtmlVisualScope([], HtmlVisualScope.Map(), HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null);
        var fragment = HtmlVisual.Expand("<style>" + css + " .wf-x { color: light-dark(#000000, #ffffff); }</style><div class=\"wf-x\"><span class=\"spinner\"></span></div>", "$screen", scope);
        Assert.Contains("@keyframes spin", fragment.ScopedCss);
        Assert.Contains("@font-face", fragment.ScopedCss);
        Assert.Contains("@media (prefers-color-scheme: dark)", fragment.ScopedCss);
    }

    [Fact]
    public void AFragmentSelectorFromReactContainerIsScopedLikeBody()
    {
        var scope = new HtmlVisualScope([], HtmlVisualScope.Map(), HtmlVisualScope.Map(), HtmlVisualScope.Map(), _ => null);
        var fragment = HtmlVisual.Expand("<style>#reactContainer .title { font-weight: 600; }</style><div class=\"wf-login\"><span class=\"title\">Hi</span></div>", "$screen", scope);
        Assert.Contains(".wf-login .title { font-weight: 600; }", fragment.ScopedCss);
        Assert.Equal(":is(#reactContainer, body) .title", fragment.Report["css"]!["cssRewrites"]![0]!["to"]!.ToString());
    }

    [Fact]
    public void ARawStyleSheetWithReactContainerOrALateImportIsAWarningWithThePatch()
    {
        var ops = JsonNode.Parse("""
            [{"op":"set","target":"IMobileTheme:App","prop":"StyleSheet","value":"#reactContainer .shell { padding: 0; }\n@import url(\"https://fonts.googleapis.com/css2?family=Inter\");\n.a { color: red; }"},
             {"op":"set","target":"IMobileTheme:App","prop":"StyleSheet","value":"@import url(\"x.css\");\n.a { color: red; }"}]
            """)!.AsArray();
        var found = StyleSheetRules.Check(ops, "o11").ToList();
        var warning = Assert.Single(found);
        Assert.Equal("CSS_REWRITTEN", warning["code"]!.ToString());
        Assert.Equal("warning", warning["severity"]!.ToString());
        var patched = warning["patch"]![0]!["value"]!.ToString();
        Assert.StartsWith("@import url(\"https://fonts.googleapis.com/css2?family=Inter\");\n", patched);
        Assert.Contains(":is(#reactContainer, body) .shell { padding: 0; }", patched);
        // a warning never blocks the job
        var analysis = JobPreflight.Analyze(ops);
        Assert.True(analysis["valid"]!.GetValue<bool>(), analysis.ToJsonString());
        Assert.Contains(analysis["warnings"]!.AsArray(), w => w!["code"]?.ToString() == "CSS_REWRITTEN");
    }

    // ---- C23 (pure part) ----------------------------------------------------------------------------------------------

    [Fact]
    public void AnImportAfterARuleGoesToTheTopAfterTheCharset()
    {
        const string css = "@charset \"utf-8\";\n.a { color: red; }\n@import url(\"fonts.css\");\n@media print { .b { color: blue; } }";
        var (hoisted, moved) = CssCompat.HoistImports(css);
        Assert.Single(moved);
        Assert.Equal(3, moved[0].Line);
        Assert.StartsWith("@charset \"utf-8\";\n@import url(\"fonts.css\");\n.a { color: red; }", hoisted);
        Assert.Contains("@media print { .b { color: blue; } }", hoisted);
        // already at the top: the same text
        const string top = "@import url(\"fonts.css\");\n.a { color: red; }";
        Assert.Same(top, CssCompat.HoistImports(top).Css);
    }
}
