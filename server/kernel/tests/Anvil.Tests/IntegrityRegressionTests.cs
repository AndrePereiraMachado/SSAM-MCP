using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public class IntegrityRegressionTests
{
    [Fact]
    public void UnexpectedContentCannotPassProof()
    {
        var expected = new Dictionary<(string, string), string> { [("page", "StyleSheet")] = "" };
        var actual = new Dictionary<(string, string), string>(expected) { [("extra", "DataSource")] = "source" };
        var proof = MergeContentProof.Compare(expected, actual);
        Assert.False(proof["accepted"]!.GetValue<bool>());
        Assert.True(Assert.Single(proof["differences"]!.AsArray())!["unexpected"]!.GetValue<bool>());
    }

    [Fact]
    public void MissingRefreshAndStaleEffectiveCssCannotPassContentProof()
    {
        var expected = new Dictionary<(string, string), string> {
            [("refresh", "DataSource")] = "aggregate", [("theme", "StyleSheet")] = ".new {}",
            [("theme", "UserStyleSheet")] = ".new {}", [("theme", "GeneratedStyleSheet")] = "" };
        var actual = new Dictionary<(string, string), string>(expected) {
            [("refresh", "DataSource")] = "", [("theme", "StyleSheet")] = ".old {}" };
        var proof = MergeContentProof.Compare(expected, actual);
        Assert.False(proof["accepted"]!.GetValue<bool>());
        Assert.Equal(2, proof["differences"]!.AsArray().Count);
        Assert.True(MergeContentProof.Compare(expected, expected)["accepted"]!.GetValue<bool>());
        actual.Remove(("theme", "UserStyleSheet"));
        Assert.Contains(MergeContentProof.Compare(expected, actual)["differences"]!.AsArray(), d => d!["missing"]!.GetValue<bool>());
    }

    [Fact]
    public void CssOnKeyedHtmlEditsBecomesAVerifiedStyleEdit()
    {
        var edits = ScreenHtmlEdit.WithCss(["<div k=\"w1\" class=\"new\"/>"], ".new { color: var(--live); }");
        Assert.Equal(2, edits.Count);
        Assert.Contains("var(--live)", edits[1]);
        Assert.StartsWith("<style>", edits[1].Trim());
        var document = ScreenHtmlEdit.WithCss(["<screen name=\"Page\"><div k=\"w1\"/></screen>"], "");
        Assert.Single(document);
        Assert.Contains("<style", document[0]);
        // The document's <style> stays, data.css after it (the rule of the create: ScreenDocument.OwnSheet).
        var previous = ScreenHtmlEdit.WithCss(["<screen name=\"Page\"><style>.old{}</style><div k=\"w1\"/></screen>"], ".new{}");
        Assert.Contains(".old{}\n.new{}", previous[0]);
        Assert.Contains(".old{}\n.new{}", Assert.Single(ScreenHtmlEdit.WithCss(["<style>.old{}</style>"], ".new{}")));
    }
}
