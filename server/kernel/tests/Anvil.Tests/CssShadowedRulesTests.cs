using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D, item 3: the stage "shadowed" of the one normalization (CssPipeline.Normalize): a rule goes when a LATER rule with the
/// same selector list and the same context of at-rules declares every one of its properties with an importance at least as
/// high; nothing else moves (a different @media, !important only on the earlier rule, a longhand before its shorthand, another
/// selector list, a fallback value, CSS nesting, @keyframes, an anonymous @layer). Each removal is said in cssStages. Synthetic
/// selectors.
/// </summary>
public sealed class CssShadowedRulesTests
{
    private static CssPipeline.Outcome Normal(string css) => CssPipeline.Normalize(css, new CssPipeline.Context("test"));

    [Fact]
    public void ARuleALaterRuleOfTheSameSelectorsOverridesWholeGoesAndIsSaid()
    {
        var outcome = Normal(".a{color:red;background:url(data:x)} .b{x:1} .a{color:red;background:url(/i.png)}");
        Assert.Equal(".b{x:1} .a{color:red;background:url(/i.png)}", outcome.Css);
        var stage = Assert.Single(outcome.StageChanges, c => c["stage"]?.ToString() == "shadowed");
        Assert.Equal(1, stage["removed"]!.GetValue<int>());
        Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(".a{color:red;background:url(data:x)} .b{x:1} .a{color:red;background:url(/i.png)}"), stage["bytesBefore"]!.GetValue<int>());
        Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(outcome.Css), stage["bytesAfter"]!.GetValue<int>());
        // One rule per line: the line goes with it.
        Assert.Equal(".b{x:1}\n.a{color:red;background:url(/i.png)}", Normal(".a{color:red;background:url(data:x)}\n.b{x:1}\n.a{color:red;background:url(/i.png)}").Css);
        // An exact duplicate: the last one stays; spaces and comments in the selectors and declarations do not matter.
        Assert.Equal(".p > .q{margin:0}", Normal(".p>.q { margin : 0 }\n.p > .q{margin:0}").Css);
        Assert.Equal(".p{margin:0}", Normal(".p /* x */ {margin:0}\n.p{margin:0}").Css);
        // Inside the same @media, and the same named @layer (the strict rule: the later rule repeats the value).
        Assert.Equal("@media print{.m{color:red}}", Normal("@media print{.m{color:red} .m{color:red}}").Css);
        // A conditional group the stage empties goes with its rules; an empty named @layer stays (it orders the layers).
        Assert.Equal("@layer base{} @layer base{.l{color:red}}", Normal("@layer base{.l{color:red}} @layer base{.l{color:red}}").Css);
        // !important on the later rule beats the earlier rule's plain one.
        Assert.Equal(".i{color:red!important}", Normal(".i{color:red}\n.i{color:red!important}").Css);
    }

    [Fact]
    public void WhatTheCascadeCouldStillShowStaysAsWritten()
    {
        foreach (var css in new[]
        {
            "@media print{.a{color:red}} @media screen{.a{color:red}}",           // another @media
            ".a{color:red} @media print{.a{color:red}}",                            // another context
            ".a{color:red!important} .a{color:red}",                                // !important only on the earlier rule
            ".a{margin-top:1px} .a{margin:0}",                                       // a longhand before its shorthand
            ".a{margin:0} .a{margin-top:1px}",                                       // a shorthand before one longhand
            ".a,.b{color:red} .a{color:red}",                                        // another selector list
            ".a{color:red} .a,.b{color:red}",
            ".a{color:red;padding:0} .a{color:red}",                                 // a property the later rule does not declare
            ".a{width:100px} .a{width:min(100px, 50vw)}",                            // a fallback: a function an older engine drops
            ".a{display:block} .a{display:-webkit-box}",                             // a vendor value
            ".a{color:red; &:hover{color:blue}} .a{color:green}",                    // CSS nesting: not read here
            "@keyframes k{from{opacity:0}} @keyframes k{from{opacity:1}}",           // never touched
            "@font-face{font-family:F;src:url(a.woff)} @font-face{font-family:F;src:url(a.woff)}",
            "@layer{.a{color:red}} @layer{.a{color:red}}",                          // two anonymous layers are two layers
            ".A{color:red} .a{color:red}",                                          // another selector (case)
        })
        {
            var outcome = Normal(css);
            Assert.True(css == outcome.Css, css + " -> " + outcome.Css);
            Assert.DoesNotContain(outcome.StageChanges, c => c["stage"]?.ToString() == "shadowed");
        }
    }

    [Fact]
    public void ASheetSentAgainWholeIsTheSheetOnceAndTheStageIsIdempotent()
    {
        const string sheet = ".card{padding:8px;background:url(data:image/png;base64,AAAA)}\n.title{font-weight:600}\n@media (max-width:600px){.card{padding:4px}}\n";
        const string again = ".card{padding:8px;background:url(/M/img/M.Card.png)}\n.title{font-weight:600}\n@media (max-width:600px){.card{padding:4px}}\n";
        // The reading's sheet followed by the same sheet with its urls changed (what an edit that resends its reading wrote
        // before): the later copy alone, as many bytes as it has.
        var doubled = Normal(sheet + again);
        Assert.Equal(again, doubled.Css);
        Assert.Equal(3, doubled.StageChanges.Single(c => c["stage"]?.ToString() == "shadowed")["removed"]!.GetValue<int>());
        // Idempotent: the stage changes nothing the second time.
        Assert.Equal(doubled.Css, Normal(doubled.Css).Css);
        Assert.False(Normal(again).Changed);
    }
}
