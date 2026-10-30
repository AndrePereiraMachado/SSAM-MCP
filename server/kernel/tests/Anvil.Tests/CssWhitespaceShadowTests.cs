using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D, round 2 of the review: the shadowed stage reads whitespace as CSS does. Only space, tab, line feed, carriage return
/// and form feed are whitespace; U+00A0, U+2003 and every other Unicode space are characters of a name (".a" U+00A0 ".b" is one
/// compound selector, "10px" U+00A0 a dimension of another unit), and a line break inside a string makes a bad string. A rule
/// whose selector or value differs from a later one only by such a character is another rule and stays. Synthetic selectors.
/// </summary>
public sealed class CssWhitespaceShadowTests
{
    private static string Normal(string css) => CssPipeline.Normalize(css, new CssPipeline.Context("test")).Css;

    [Theory]
    [InlineData(".a .b{color:red}\n.a .b{color:red}")]      // a compound selector with the class "a" U+00A0, not the descendant
    [InlineData(".a{color:red}\n .a{color:red}")]            // a type selector that selects nothing
    [InlineData(".a .b{color:red}\n.a .b{color:red}")]
    [InlineData(".w{width:10px}\n.w{width:10px }")]          // a dimension of the unit px U+00A0: dropped by the browser
    [InlineData(".q{content:\"x y\"}\n.q{content:\"x\ny\"}")]     // a raw line break inside a string: a bad string
    [InlineData(".q{content:\"x  y\"}\n.q{content:\"x y\"}")]     // two spaces inside a string are two spaces
    public void ARuleThatDiffersByANonCssSpaceStays(string css)
    {
        Assert.Equal(css, Normal(css));
    }

    [Fact]
    public void EveryUnicodeSpaceThatIsNoCssWhitespaceIsACharacter()
    {
        var spaces = Enumerable.Range(0, 0x10000).Select(c => (char)c)
            .Where(c => char.IsWhiteSpace(c) && c is not (' ' or '\t' or '\n' or '\r' or '\f')).ToList();
        Assert.Contains(' ', spaces);
        Assert.Contains('　', spaces);
        foreach (var space in spaces)
        {
            var name = "U+" + ((int)space).ToString("X4");
            foreach (var css in new[]
            {
                ".a .b{color:red}\n.a" + space + ".b{color:red}",
                ".a{color:red}\n" + space + ".a{color:red}",
                ".w{width:10px}\n.w{width:10px" + space + "}",
                ".m{margin:0 1px}\n.m{margin:0" + space + "1px}",
                ".q{content:\"x y\"}\n.q{content:\"x" + space + "y\"}",
            })
                Assert.True(css == Normal(css), name + ": " + css.Replace("\n", "\\n") + " -> " + Normal(css).Replace("\n", "\\n"));
        }
    }

    [Theory]
    // CSS whitespace is still whitespace: these go as before.
    [InlineData(".p /* x */ {margin:0}\n.p{margin:0}", ".p{margin:0}")]
    [InlineData(".p>.q { margin : 0 }\n.p > .q{margin:0}", ".p > .q{margin:0}")]
    [InlineData(".a{margin:0 1px}\n.a{margin:0  1px}", ".a{margin:0  1px}")]
    [InlineData(".a .b{x:1}\n.a\t.b{x:1}", ".a\t.b{x:1}")]
    [InlineData(".a .b{x:1}\n.a\f.b{x:1}", ".a\f.b{x:1}")]
    [InlineData("﻿.a{x:1}\n.a{x:1}", "﻿.a{x:1}")]
    public void CssWhitespaceStillReadsAsWhitespace(string css, string expected)
    {
        Assert.Equal(expected, Normal(css));
    }
}
