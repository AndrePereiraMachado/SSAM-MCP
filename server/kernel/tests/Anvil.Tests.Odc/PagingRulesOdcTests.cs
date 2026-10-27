using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>T3, paging that does not page, in the ODC lane (PagingRulesScenarios, linked into both test projects).</summary>
public sealed class PagingRulesOdcTests
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(PagingRulesOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string Scratch(string name)
    {
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "paging-rules-tests", name);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir); return dir;
    }

    [Fact]
    public void BatteryBuildsPagedScreensFromZero()
    {
        if (!StudioAvailable()) return;
        Anvil.Tests.PagingRulesScenarios.BatteryBuildsPagedScreensFromZero(Scratch("battery"), Fixture, "odc");
    }

    [Fact] public void WiringsThatPageAreAccepted() { if (StudioAvailable()) Anvil.Tests.PagingWiringScenarios.WiringsThatPageAreAccepted(Scratch("wirings"), Fixture); }
    [Fact] public void EditsThatDoNotWireThePagingAreAccepted() { if (StudioAvailable()) Anvil.Tests.PagingWiringScenarios.EditsThatDoNotWireThePagingAreAccepted(Scratch("legacy-edits"), Fixture); }
    [Fact] public void EditsThatWireThePagingAreJudged() { if (StudioAvailable()) Anvil.Tests.PagingWiringScenarios.EditsThatWireThePagingAreJudged(Scratch("legacy-wiring"), Fixture); }
    [Fact] public void EntityActionsKeepTheEarlierListWithItsReasonAndEdit() { if (StudioAvailable()) Anvil.Tests.PagingWiringScenarios.EntityActionsKeepTheEarlierListWithItsReasonAndEdit(Scratch("legacy-entity-actions"), Fixture); }
    [Fact] public void TheReviewReadsTheFootprintOnly() { if (StudioAvailable()) Anvil.Tests.PagingWiringScenarios.TheReviewReadsTheFootprintOnly(Scratch("footprint"), Fixture); }

    [Fact]
    public void SweepRefusesEveryBrokenWiringAtOnce()
    {
        if (!StudioAvailable()) return;
        Anvil.Tests.PagingRulesScenarios.SweepRefusesEveryBrokenWiringAtOnce(Scratch("sweep"), Fixture, "odc");
    }
}
