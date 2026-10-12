using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>Scoping of the html op (manual path, docs/PROTOTIPO-NATIVO.md 4.3 item 1) and the parser pieces the prototype CSS
/// leans on: a first compound that already is the root is the anchor (never `.app main.app`), `*` covers the root, the
/// @import walk finds a statement inside a minified line or behind a byte order mark, the @font-face hook, and the rule
/// count that never throws.</summary>
public class CssScopeTests
{
    private static string Scoped(string css, string scope = ".app") => CssStylesheet.Parse(css).Scoped(scope);

    [Theory]
    [InlineData("main.app{display:block}", "main.app { display: block; }")]
    [InlineData("[data-x].app{color:red}", "[data-x].app { color: red; }")]
    [InlineData(".a.app{color:red}", ".a.app { color: red; }")]
    [InlineData("main.app:hover>p{color:red}", "main.app:hover>p { color: red; }")]
    [InlineData(".app .x{color:red}", ".app .x { color: red; }")]
    public void AFirstCompoundThatIsTheRootIsTheAnchor(string css, string expected) => Assert.Equal(expected, Scoped(css));

    [Fact]
    public void ARootTokenThatIsOnlyAPrefixOfAClassIsNotTheRoot()
    {
        Assert.Equal(".app .apple { color: red; }", Scoped(".apple{color:red}"));
        Assert.Equal(".app main.apple { color: red; }", Scoped("main.apple{color:red}"));
        Assert.Equal(".app main .app { color: red; }", Scoped("main .app{color:red}"));
    }

    [Theory]
    [InlineData("*{box-sizing:border-box}", ".app, .app * { box-sizing: border-box; }")]
    [InlineData("*:before{content:''}", ".app:before, .app *:before { content: ''; }")]
    [InlineData("*,*:after{margin:0}", ".app, .app *, .app:after, .app *:after { margin: 0; }")]
    [InlineData("* > p{margin:0}", ".app > p, .app * > p { margin: 0; }")]
    public void TheUniversalSelectorCoversTheRoot(string css, string expected) => Assert.Equal(expected, Scoped(css));

    [Theory]
    [InlineData(":root{--x:1}", ".app { --x: 1; }")]
    [InlineData("body{margin:0}", ".app { margin: 0; }")]
    [InlineData("html body .x{margin:0}", ".app body .x { margin: 0; }")]
    [InlineData(".x{margin:0}", ".app .x { margin: 0; }")]
    public void DocumentRootsStillBecomeTheScope(string css, string expected) => Assert.Equal(expected, Scoped(css));

    [Fact]
    public void OwnedScopingKeepsTheOwnerOnEverySelectorOfTheUniversalExpansion()
    {
        var owned = CssStylesheet.Parse("*{margin:0}main.app{display:block}").ScopedOwned(".app", ".own");
        Assert.Contains(".app:where(.own), .app *:where(.own) { margin: 0; }", owned);
        Assert.Contains("main.app:where(.own) { display: block; }", owned);
    }

    [Fact]
    public void ImportsAreFoundInsideAMinifiedLineAndBehindAByteOrderMark()
    {
        // The call-79 stylesheet: @import and 271 rules on one line of 27,632 characters, ';' inside the Google Fonts url.
        var call79 = File.ReadAllText(Path.Combine(PrototypeCssTests.Fixtures, "call79-html-css.css"));
        var (imports, others) = CssCompat.Imports(call79);
        Assert.Single(imports);
        Assert.StartsWith("@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;450;", imports[0].Statement);
        Assert.EndsWith("&display=swap');", imports[0].Statement);
        Assert.Equal(CssStylesheet.CountRules(call79) - 1, CssStylesheet.CountRules(others));   // the rules of the line stay
        Assert.Contains(".fv-prototype{--green:#18765c", others);

        var afterRule = ".a{b:c}@import url(x.css?a=1;b=2);.d{e:f}";
        var found = CssCompat.Imports(afterRule);
        Assert.Equal("@import url(x.css?a=1;b=2);", Assert.Single(found.Imports).Statement);
        Assert.True(found.Imports[0].AfterRule);
        Assert.Equal(".a{b:c}.d{e:f}", found.Others);

        var bom = "﻿@import url('f.css');\n.x{color:red}";
        Assert.Single(CssCompat.Imports(bom).Imports);
        var (hoisted, _) = CssCompat.HoistImports(".x{color:red}\n﻿@import url('f.css');");
        Assert.StartsWith("@import url('f.css');\n", hoisted);
    }

    [Fact]
    public void TheFontFaceHookReplacesAnImportItResolves()
    {
        var (css, _) = CssCompat.HoistImports("@import url('https://fonts.googleapis.com/css2?family=X');\n.x{color:red}",
            import => import.Statement.Contains("fonts.googleapis.com") ? "@font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2)}" : null);
        Assert.Equal("@font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2)}\n.x{color:red}", css);
        var (kept, _) = CssCompat.HoistImports("@import url(a.css);.x{}", _ => null);
        Assert.Equal("@import url(a.css);.x{}", kept);
    }

    [Fact]
    public void TheRuleCountIsLenientAndNeverThrows()
    {
        const string css = "@page{margin:1cm}@property --x{syntax:'<length>';inherits:false;initial-value:0}.a{b:c}@media(min-width:1px){.d{e:f}.g{h:i}}@import url(a.css);";
        Assert.Throws<InvalidOperationException>(() => CssStylesheet.Parse(css));
        Assert.Equal(6, CssStylesheet.Parse(css, lenient: true).RuleCount);
        Assert.Equal(6, CssStylesheet.CountRules(css));
        Assert.Equal(css, CssStylesheet.Parse(css, lenient: true).Text);
        Assert.Equal(2, CssStylesheet.CountRules(".a{&:hover{color:red}}.b{c:d}"));   // nesting: the tolerant walk counts blocks
    }
}
