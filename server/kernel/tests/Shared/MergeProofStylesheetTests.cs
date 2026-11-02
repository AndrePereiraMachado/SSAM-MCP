using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects (B17, port of proto c995402e, lote 4 F2: CSS the merge or the publication lost, reordered
// or changed while every receipt said success). The merge content proof says, for every stylesheet of the candidate, whether
// the merged module has the same bytes, only other line endings, or which rules it lost, added or reordered. The acceptance is
// unchanged: modulo line endings, as before. Pure: no model, no Studio.
public sealed class MergeProofStylesheetTests
{
    [Fact]
    public void TheSameBytesAreEqualAndLineEndingsAloneAreNoChangeOfTheCss()
    {
        var css = ".a { color: red; }\n\n.b { margin: 0; }";
        Assert.True(CssStylesheet.Compare(css, css)["bytesEqual"]!.GetValue<bool>());
        var crlf = CssStylesheet.Compare(css, css.Replace("\n", "\r\n"));
        Assert.False(crlf["bytesEqual"]!.GetValue<bool>());
        Assert.True(crlf["lineEndingsOnly"]!.GetValue<bool>());
        Assert.Equal(1, crlf["firstDifference"]!["line"]!.GetValue<int>());
        Assert.Equal(64, crlf["expectedSha256"]!.ToString().Length);
    }

    [Fact]
    public void ALostRuleAnAddedRuleAndAReorderAreNamed()
    {
        var before = ".a { color: red; }\n.b { margin: 0; }\n.c { gap: 4px; }";
        var lost = CssStylesheet.Compare(before, ".a { color: red; }\n.c { gap: 4px; }")["rules"]!;
        Assert.Equal(3, lost["expected"]!.GetValue<int>());
        Assert.Equal(2, lost["actual"]!.GetValue<int>());
        Assert.Equal(1, lost["lost"]!.GetValue<int>());
        Assert.Contains(".b", lost["lostRules"]![0]!.ToString());
        Assert.False(lost["reordered"]!.GetValue<bool>());
        var reordered = CssStylesheet.Compare(before, ".c { gap: 4px; }\n.a { color: red; }\n.b { margin: 0; }");
        Assert.False(reordered["lineEndingsOnly"]!.GetValue<bool>());
        Assert.True(reordered["rules"]!["reordered"]!.GetValue<bool>());
        Assert.Equal(0, reordered["rules"]!["lost"]!.GetValue<int>());
        var added = CssStylesheet.Compare(before, before + "\n.d { top: 0; }")["rules"]!;
        Assert.Equal(1, added["added"]!.GetValue<int>());
        // A text the splitter cannot read keeps the byte comparison, and never throws.
        var broken = CssStylesheet.Compare(before, ".a { color: red;");
        Assert.Equal(JsonValueKind.Null, broken["rules"]?.GetValueKind() ?? JsonValueKind.Null);
        Assert.NotNull(broken["firstDifference"]);
        Assert.True(CssStylesheet.Compare(null, null)["bytesEqual"]!.GetValue<bool>());
    }

    [Fact]
    public void TheMergeProofListsEveryStylesheetByteByByteAndStillAcceptsLineEndings()
    {
        var expected = new Dictionary<(string Key, string Property), string>
        {
            [("t", "$kind")] = "ITheme", [("t", "StyleSheet")] = ".a{}\n.b{}", [("t", "UserStyleSheet")] = ".a{}\n.b{}",
            [("s", "$kind")] = "IScreen", [("s", "StyleSheet")] = ".x{}\n.y{}",
        };
        var lineEndings = new Dictionary<(string Key, string Property), string>(expected) { [("t", "StyleSheet")] = ".a{}\r\n.b{}" };
        var same = MergeContentProof.Compare(expected, lineEndings);
        Assert.True(same["accepted"]!.GetValue<bool>());
        Assert.Equal(3, same["css"]!["sheets"]!.GetValue<int>());
        Assert.Equal(2, same["css"]!["bytesEqual"]!.GetValue<int>());
        Assert.Equal(1, same["css"]!["lineEndingsOnly"]!.GetValue<int>());
        Assert.Equal(0, same["css"]!["differingTotal"]!.GetValue<int>());
        Assert.Empty(same["css"]!["differing"]!.AsArray());

        var reordered = new Dictionary<(string Key, string Property), string>(expected) { [("s", "StyleSheet")] = ".y{}\n.x{}" };
        var proof = MergeContentProof.Compare(expected, reordered);
        Assert.False(proof["accepted"]!.GetValue<bool>());
        var differing = Assert.Single(proof["css"]!["differing"]!.AsArray())!;
        Assert.Equal("StyleSheet", differing["property"]!.ToString());
        Assert.Equal("s", differing["element"]!.ToString());
        Assert.True(differing["rules"]!["reordered"]!.GetValue<bool>());
        var difference = Assert.Single(proof["differences"]!.AsArray())!;
        Assert.True(difference["css"]!["rules"]!["reordered"]!.GetValue<bool>());

        var missing = new Dictionary<(string Key, string Property), string>(expected);
        missing.Remove(("s", "StyleSheet"));
        var gone = MergeContentProof.Compare(expected, missing);
        Assert.True(gone["css"]!["differing"]![0]!["missing"]!.GetValue<bool>());
        // A property that is not a stylesheet carries no css comparison.
        var renamed = new Dictionary<(string Key, string Property), string>(expected) { [("s", "$kind")] = "IWebBlock" };
        Assert.Null(Assert.Single(MergeContentProof.Compare(expected, renamed)["differences"]!.AsArray())!["css"]);
    }
}
