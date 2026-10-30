using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D, round 3 of the review: the shadowed stage compares the token streams of one CSS Syntax Level 3 tokenizer. Whitespace
/// around a combinator matters inside [] and () and in at-rule preludes; the whitespace that ends a hex escape belongs to it;
/// case folding is ASCII only; an invalid custom property value covers nothing; an author NUL is a character. A generative test
/// mutates OutSystems UI-like rules with changes that keep or change the token stream and checks the stage removes the earlier
/// rule exactly when the stream is the same. Synthetic selectors.
/// </summary>
public sealed class CssTokenShadowTests
{
    private static string Normal(string css) => CssPipeline.Normalize(css, new CssPipeline.Context("test")).Css;

    [Theory]
    // Whitespace around > + ~ = inside [] / () and in preludes is part of what they mean.
    [InlineData(".a[class~=\"x\"]{color:red}\n.a[class~ =\"x\"]{color:red}")]
    [InlineData("li:nth-child(+n){color:red}\nli:nth-child(+ n){color:red}")]
    [InlineData("@media (width >= 600px){.a{color:red}}\n@media (width > = 600px){.a{color:red}}")]
    [InlineData("@media (min-width: calc(100px + 1em)){.a{color:red}}\n@media (min-width: calc(100px+1em)){.a{color:red}}")]
    [InlineData("@supports (width: calc(1px + 2px)){.a{color:red}}\n@supports (width: calc(1px+2px)){.a{color:red}}")]
    // The first whitespace after a hex escape is the escape's.
    [InlineData(".a{display:\\66 lex}\n.a{display:\\66  lex}")]
    [InlineData(".a{display:\\66 lex}\n.a{display:\\66\n\nlex}")]
    [InlineData(".a .b{color:red}\n.a\\20 .b{color:red}")]
    // ASCII case folding only.
    [InlineData(".a{font-kerning:none}\n.a{font-Kerning:none}")]
    [InlineData(".a{color:red}\n.a{color:İNHERIT}")]
    [InlineData(".a{color:red}\n.a{color:İNITIAL}")]
    // A custom property value that is no <declaration-value>.
    [InlineData(".a{--x:red}\n.a{--x:]}")]
    [InlineData(".a{--x:red}\n.a{--x:url(a b)}")]
    [InlineData(".a{--x:red}\n.a{--x:a!b}")]
    [InlineData(".a{--x:red}\n.a{--x:a]b}")]
    // An author NUL is a character (U+FFFD), never a marker.
    [InlineData(".a[t=\"x\"][u=\"x\"]{color:red}\n.a[t=\"x\"][u=\u00000\u0000]{color:red}")]
    // The other probes of the stopped round-3 session.
    [InlineData(".q{content:\"x\\A y\"}\n.q{content:\"x\ny\"}")]
    [InlineData(".a .b{color:red}\n.a/**/ .b{color:red}")]
    [InlineData(".a .b{color:red}\n.a /**/.b{color:red}")]
    [InlineData("@media print{.a{color:red}}\n@media print{.a{color:red}}")]
    [InlineData("@media screen and (max-width:600px){.a{color:red}}\n@media screen and (max-width:600px){.a{color:red}}")]
    [InlineData("@layer a{.a{color:red}}\n@layer a{.a{color:red}}")]
    [InlineData(".a{color:red}\n﻿.a{color:red}")]
    [InlineData(".a{background:url(a.png)}\n.a{background:url(a\nb.png)}")]
    [InlineData(".a{color:red!important}\n.a{color:red! important}")]
    public void WhatTokenizesDifferentlyStays(string css)
    {
        Assert.Equal(css, Normal(css));
    }

    [Theory]
    [InlineData(".p>.q { margin : 0 }\n.p > .q{margin:0}", ".p > .q{margin:0}")]
    [InlineData(".a , .b{x:1}\n.a,.b{x:1}", ".a,.b{x:1}")]
    [InlineData("@media  print{.a{x:1}}\n@media print{.a{x:1}}", "@media print{.a{x:1}}")]
    [InlineData(".a{display:\\66 lex}\n.a{display:\\66 lex}", ".a{display:\\66 lex}")]
    [InlineData(".a{COLOR:red}\n.a{color:red}", ".a{color:red}")]
    [InlineData(".a{--x:red}\n.a{--x:blue}", ".a{--x:blue}")]
    [InlineData(".a{--x:red}\n.a{--x:inherit}", ".a{--x:inherit}")]
    // (A { in a value makes the reader leave the whole sheet as written: it cannot tell it from CSS nesting.)
    [InlineData(".a{--x:red}\n.a{--x:[a] (b)}", ".a{--x:[a] (b)}")]
    [InlineData(".a{margin:0\r\n1px}\n.a{margin:0 1px}", ".a{margin:0 1px}")]
    [InlineData(".a{display:flex}\n.a{display:\\66 lex}", ".a{display:\\66 lex}")]
    public void WhatTokenizesTheSameGoes(string css, string expected)
    {
        Assert.Equal(expected, Normal(css));
    }

    // ---- generative ---------------------------------------------------------------------------------------------------------

    private sealed record Rule(string Selector, (string Property, string Value)[] Declarations)
    {
        public string Text => Selector + "{" + string.Join(";", Declarations.Select(d => d.Property + ":" + d.Value)) + "}";
    }

    // Rules of the shapes OutSystems UI writes.
    private static readonly Rule[] Bases =
    [
        new(".btn.btn-primary", [("background-color", "var(--color-primary)"), ("border-radius", "var(--border-radius-soft)"), ("color", "#fff")]),
        new(".card > .card-header", [("padding", "var(--space-m) var(--space-base)"), ("font-weight", "600")]),
        new(".table tbody tr:nth-child(2n+1) td", [("background-color", "rgba(0, 0, 0, 0.02)")]),
        new(".form-control[data-input]:focus", [("border-color", "var(--color-primary)"), ("box-shadow", "0 0 0 2px var(--color-primary-lighter)")]),
        new(".layout-side .menu, .layout-side .app-menu-links", [("width", "calc(100% - 16px)"), ("margin", "0 auto")]),
        new(".tag.tag-success", [("color", "var(--color-success)"), ("font-size", "12px !important")]),
    ];

    private static readonly char[] UnicodeSpaces = new[] { 0x00A0, 0x1680, 0x2003, 0x200A, 0x2028, 0x202F, 0x3000, 0x000B, 0x0085 }.Select(c => (char)c).ToArray();

    // A change that keeps the token stream (the only normalizations the stage allows): true; one that changes it: false.
    private static (Rule Rule, bool Same) Mutate(Rule rule, Random random)
    {
        var d = rule.Declarations.ToArray();
        var pick = random.Next(d.Length);
        switch (random.Next(12))
        {
            case 0: // a run of whitespace where the selector has one space at the top level
                var at = TopSpace(rule.Selector, random);
                if (at < 0) goto case 3;
                return (rule with { Selector = rule.Selector[..at] + new[] { "  ", "\t", "\n ", " /*c*/ " }[random.Next(4)] + rule.Selector[(at + 1)..] }, true);
            case 1: // spaces around a top-level combinator or comma
                var joint = rule.Selector.IndexOfAny(['>', ',']);
                if (joint < 0) goto case 3;
                return (rule with { Selector = rule.Selector[..joint].TrimEnd() + "  " + rule.Selector[joint] + " \t" + rule.Selector[(joint + 1)..].TrimStart() }, true);
            case 2: // the property name in another ASCII case
                d[pick] = (d[pick].Property.ToUpperInvariant(), d[pick].Value);
                return (rule with { Declarations = d }, true);
            case 3: // whitespace around the colon and the value
                d[pick] = (d[pick].Property + " ", "\t" + d[pick].Value + "  ");
                return (rule with { Declarations = d }, true);
            case 4: // a run of whitespace for one space of a value (anywhere: runs collapse inside () too)
                var space = d[pick].Value.IndexOf(' ');
                if (space < 0) goto case 3;
                d[pick] = (d[pick].Property, d[pick].Value[..space] + new[] { "  ", "\t", " /*x*/ " }[random.Next(3)] + d[pick].Value[(space + 1)..]);
                return (rule with { Declarations = d }, true);
            case 5: // a Unicode space that is no CSS whitespace, inside the selector
                var s = random.Next(1, rule.Selector.Length);
                return (rule with { Selector = rule.Selector[..s] + UnicodeSpaces[random.Next(UnicodeSpaces.Length)] + rule.Selector[s..] }, false);
            case 6: // a Unicode space inside a value
                var v = random.Next(0, d[pick].Value.Length + 1);
                d[pick] = (d[pick].Property, d[pick].Value[..v] + UnicodeSpaces[random.Next(UnicodeSpaces.Length)] + d[pick].Value[v..]);
                return (rule with { Declarations = d }, false);
            case 7: // a comment glued inside a name of the selector
                var letter = Enumerable.Range(1, rule.Selector.Length - 2).Where(i => char.IsAsciiLetter(rule.Selector[i - 1]) && char.IsAsciiLetter(rule.Selector[i])).ToList();
                if (letter.Count == 0) goto case 5;
                var g = letter[random.Next(letter.Count)];
                return (rule with { Selector = rule.Selector[..g] + "/**/" + rule.Selector[g..] }, false);
            case 8: // the Kelvin sign (no k) or another non-ASCII letter in a property name
                d[pick] = (d[pick].Property + "K", d[pick].Value);
                return (rule with { Declarations = d }, false);
            case 9: // whitespace inside () or [] where there was none, or none where there was some
                if (rule.Selector.Contains("2n+1", StringComparison.Ordinal)) return (rule with { Selector = rule.Selector.Replace("2n+1", "2n + 1") }, false);
                if (rule.Selector.Contains("[data-input]", StringComparison.Ordinal)) return (rule with { Selector = rule.Selector.Replace("[data-input]", "[data-input ]") }, false);
                var calc = Array.FindIndex(d, x => x.Value.StartsWith("calc(", StringComparison.Ordinal));
                if (calc >= 0) { d[calc] = (d[calc].Property, d[calc].Value.Replace(" - ", "-")); return (rule with { Declarations = d }, false); }
                goto case 6;
            case 10: // a value that does not tokenize cleanly or is no <declaration-value>
                d[pick] = (d[pick].Property, d[pick].Value + new[] { ")", "]", " url(a b)", " \"x" }[random.Next(4)]);
                return (rule with { Declarations = d }, false);
            default: // the same rule
                return (rule, true);
        }
    }

    // A space of the selector at the top level (outside () and []), or -1.
    private static int TopSpace(string selector, Random random)
    {
        var depth = 0;
        var spaces = new List<int>();
        for (var i = 0; i < selector.Length; i++)
        {
            if (selector[i] is '(' or '[') depth++;
            else if (selector[i] is ')' or ']') depth--;
            else if (selector[i] == ' ' && depth == 0 && i > 0 && selector[i - 1] is not (',' or '>') && i + 1 < selector.Length && selector[i + 1] is not (',' or '>'))
                spaces.Add(i);
        }
        return spaces.Count == 0 ? -1 : spaces[random.Next(spaces.Count)];
    }

    [Fact]
    public void TheStageRemovesARuleExactlyWhenTheLaterRuleTokenizesTheSame()
    {
        var random = new Random(20261029);
        var failures = new List<string>();
        for (var n = 0; n < 3000; n++)
        {
            var rule = Bases[random.Next(Bases.Length)];
            var (later, same) = Mutate(rule, random);
            var css = rule.Text + "\n" + later.Text;
            var result = Normal(css);
            var removed = result == later.Text;
            if (removed != same && failures.Count < 10)
                failures.Add((same ? "kept a rule that tokenizes the same: " : "removed a rule that tokenizes differently: ") + css.Replace("\n", "\\n"));
            if (!removed) Assert.Equal(css, result);
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }
}
