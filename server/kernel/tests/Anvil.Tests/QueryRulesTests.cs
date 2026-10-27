using Xunit;

namespace Anvil.Tests;

/// <summary>QUERY_IN_LOOP and AGGREGATES_MERGEABLE in the O11 lane (QueryRulesScenarios, linked into both test projects).</summary>
public sealed class QueryRulesTests
{
    private const string Fixture = "blank-service.oml";

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "query-rules-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static void Run(Action<string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        scenario(Scratch(), Fixture);
    }

    [Fact] public void AnAggregateInAForEachIsRefused() => Run(QueryRulesScenarios.AnAggregateInAForEachIsRefused);
    [Fact] public void ASqlInAForEachIsRefused() => Run(QueryRulesScenarios.ASqlInAForEachIsRefused);
    [Fact] public void AnAggregateInAWhileCycleIsRefused() => Run(QueryRulesScenarios.AnAggregateInAWhileCycleIsRefused);
    [Fact] public void EveryRefusalComesBackAtOnce() => Run(QueryRulesScenarios.EveryRefusalComesBackAtOnce);
    [Fact] public void TheEscapeWithAWhyIsAcceptedAndRecorded() => Run(QueryRulesScenarios.TheEscapeWithAWhyIsAcceptedAndRecorded);
    [Fact] public void ALegacyLoopIsAHighWarningNotARefusal() => Run(QueryRulesScenarios.ALegacyLoopIsAHighWarningNotARefusal);
    [Fact] public void RelatedAggregatesUsedTogetherAreAHighWarning() => Run(QueryRulesScenarios.RelatedAggregatesUsedTogetherAreAHighWarning);
    [Fact] public void UnrelatedAggregatesAreNotAWarning() => Run(QueryRulesScenarios.UnrelatedAggregatesAreNotAWarning);
    [Fact] public void ConsolidationRequiresSemanticReview() => Run(QueryRulesScenarios.ConsolidationNeverRewritesIndependentPagesOrInterveningReads);

    [Fact]
    public void TheEscapeKeyIsPartOfTheVerbContract()
    {
        Anvil.Core.VerbSurface.Check(System.Text.Json.Nodes.JsonNode.Parse("""{"op":"logic","data":{},"allowQueryInLoop":{"why":"bounded list of three"}}""")!.AsObject());
        Assert.Throws<InvalidOperationException>(() => Anvil.Core.VerbSurface.Check(System.Text.Json.Nodes.JsonNode.Parse("""{"op":"get","target":"$x","allowQueryInLoop":{"why":"bounded list of three"}}""")!.AsObject()));
        Assert.Null(Anvil.Core.QueryInLoopRule.Allowed(System.Text.Json.Nodes.JsonNode.Parse("""{"allowQueryInLoop":{"why":"short"}}""")!.AsObject(), out var invalid));
        Assert.Contains("15", invalid);
    }
}
