using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>T3, paging that does not page, in the O11 lane (PagingRulesScenarios, linked into both test projects), plus the
/// pure part of the rule.</summary>
public sealed class PagingRulesTests
{
    private const string Fixture = "reactive-ui.oml";

    private static string Scratch(string name)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "paging-rules-tests", name);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir); return dir;
    }

    [Fact]
    public void BatteryBuildsPagedScreensFromZero()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        PagingRulesScenarios.BatteryBuildsPagedScreensFromZero(Scratch("battery"), Fixture, "o11");
    }

    [Fact]
    public void SweepRefusesEveryBrokenWiringAtOnce()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        PagingRulesScenarios.SweepRefusesEveryBrokenWiringAtOnce(Scratch("sweep"), Fixture, "o11");
    }

    // The review round: paging that works is never refused; what the job did not wire is a warning; the generated list.
    [Fact] public void WiringsThatPageAreAccepted() { if (PacoteBPolicyTests.StudioAvailable()) PagingWiringScenarios.WiringsThatPageAreAccepted(Scratch("wirings"), Fixture); }
    [Fact] public void EditsThatDoNotWireThePagingAreAccepted() { if (PacoteBPolicyTests.StudioAvailable()) PagingWiringScenarios.EditsThatDoNotWireThePagingAreAccepted(Scratch("legacy-edits"), Fixture); }
    [Fact] public void EditsThatWireThePagingAreJudged() { if (PacoteBPolicyTests.StudioAvailable()) PagingWiringScenarios.EditsThatWireThePagingAreJudged(Scratch("legacy-wiring"), Fixture); }
    [Fact] public void EntityActionsKeepTheEarlierListWithItsReasonAndEdit() { if (PacoteBPolicyTests.StudioAvailable()) PagingWiringScenarios.EntityActionsKeepTheEarlierListWithItsReasonAndEdit(Scratch("legacy-entity-actions"), Fixture); }
    [Fact] public void TheReviewReadsTheFootprintOnly() { if (PacoteBPolicyTests.StudioAvailable()) PagingWiringScenarios.TheReviewReadsTheFootprintOnly(Scratch("footprint"), Fixture); }

    [Theory]
    [InlineData("(CurrentPage - 1) * MaxRecords", "CurrentPage,MaxRecords")]
    [InlineData("Filter.StartIndex", "Filter.StartIndex")]
    [InlineData("Client.PgStart + 0", "Client.PgStart")]
    [InlineData("If(Max(0, X) > 1, \"Y\", Z)", "X,Z")]
    [InlineData("0", "")]
    public void APageExpressionReadsItsVariablesAndPaths(string expression, string expected)
        => Assert.Equal(expected, string.Join(",", PagingRules.Paths(expression)));

    [Theory]
    [InlineData("Filter.StartIndex", "Filter", true)]
    [InlineData("Filter.StartIndex", "Filter.StartIndex", true)]
    [InlineData("Filter.StartIndexOld", "Filter.StartIndex", false)]
    [InlineData("Other.Filter.StartIndex", "Filter.StartIndex", false)]
    [InlineData("LongIntegerToInteger(GetItems.Count)", "GetItems.Count", true)]
    public void APathIsReadFromItsRoot(string expression, string path, bool expected) => Assert.Equal(expected, PagingRules.Reads(expression, path));

    [Fact]
    public void TheCatalogHasAPagingPatternOnEveryLane()
    {
        Assert.Contains("Pagination", PagingRulesScenarios.CatalogPagers("o11"));
        Assert.Contains("Pagination", PagingRulesScenarios.CatalogPagers("odc"));
    }

    [Theory]
    [InlineData("StartIndex", "StartIndex", true)]
    [InlineData("StartIndex + MaxRecords", "MaxRecords", true)]
    [InlineData("GetItems.StartIndex", "StartIndex", false)]
    [InlineData("\"StartIndex\"", "StartIndex", false)]
    [InlineData("If(X, StartIndex2, 0)", "StartIndex", false)]
    [InlineData("Max(0, startindex)", "StartIndex", true)]
    public void AnExpressionRefersToANameOnlyAsItsOwnIdentifier(string expression, string word, bool expected)
        => Assert.Equal(expected, PagingRules.Refers(expression, word));

    [Theory]
    [InlineData("SELECT 1 FROM {T} ORDER BY {T}.[Id] OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY", "Skip")]
    [InlineData("SELECT 1 FROM {T} ORDER BY {T}.[Id] LIMIT @Take OFFSET @From", "From")]
    [InlineData("select 1 from {T} order by 1 offset @s rows", "s")]
    public void TheOffsetOfAnSqlIsItsParameter(string statement, string parameter)
        => Assert.Equal(parameter, PagingRules.Offset.Match(statement).Groups[1].Value);

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData(" 0 ", false)]
    [InlineData("StartIndex", true)]
    [InlineData("25", true)]
    public void OnlyANonZeroStartAsksForAnOffset(string? text, bool expected) => Assert.Equal(expected, PagingRules.AsksForOffset(text));
}
