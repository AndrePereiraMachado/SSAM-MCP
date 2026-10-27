using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>QUERY_IN_LOOP and AGGREGATES_MERGEABLE in the ODC lane (QueryRulesScenarios, linked into both test projects).</summary>
public sealed class QueryRulesOdcTests
{
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(QueryRulesOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static void Run(Action<string, string> scenario)
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "query-rules-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture);
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
}
