using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// A18 of the 2026-10-06 package (lane F7a): `api --op &lt;verb&gt;` answers the verb's own line of the raw verb table
/// instead of "unknown op". The friction report's real refusals: "unknown op 'reference'; allowed: logic, spec, ..."
/// and "unknown op 'security'". The table itself (VerbSurface.Schema) does not grow.
/// </summary>
public class Pa2F7aSurfaceTests
{
    [Theory]
    [InlineData("create")]
    [InlineData("reference")]
    [InlineData("set")]
    [InlineData("usages")]
    public void ApiOpOfAVerbAnswersTheLineOfThatVerb(string verb)
    {
        var line = CommandSurface.Schema(verb);
        var table = VerbSurface.Schema()["verbs"]![verb]!.AsObject();
        Assert.Equal("verbs", line["op"]!.ToString());
        Assert.Equal(verb, line["verb"]!.ToString());
        foreach (var (key, value) in table) Assert.Equal(value!.ToJsonString(), line[key]!.ToJsonString());
        Assert.Equal(table.Count + 2, line.Count);
    }

    [Fact]
    public void TheVerbIsMatchedWithoutCaseAndTheGrammarsStayTheirOwnContracts()
    {
        Assert.Equal("create", CommandSurface.Schema("Create")["verb"]!.ToString());
        Assert.Contains("parent", CommandSurface.Schema("CREATE")["required"]!.AsArray().Select(k => k!.ToString()));
        // logic, spec, screen, html, rest, rest-expose and soap are verbs AND grammars: the grammar contract wins.
        Assert.Equal(LogicExpander.Schema().ToJsonString(), CommandSurface.Schema("logic").ToJsonString());
        Assert.Equal(VerbSurface.Schema().ToJsonString(), CommandSurface.Schema("verbs").ToJsonString());
    }

    [Fact]
    public void AnUnknownOpNamesTheGrammarsTheVerbsAndTheClosestName()
    {
        var unknown = Assert.Throws<ArgumentException>(() => CommandSurface.Schema("security")).Message;
        Assert.Contains("allowed: logic", unknown);
        Assert.Contains("verbs (their line): create, set", unknown);
        Assert.DoesNotContain("closest", unknown);
        var typo = Assert.Throws<ArgumentException>(() => CommandSurface.Schema("refrence")).Message;
        Assert.Contains("closest: 'reference'", typo);
    }
}
