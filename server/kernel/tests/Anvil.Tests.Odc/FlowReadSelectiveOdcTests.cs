using Anvil.Core;
using Anvil.Tests;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>The selective reading of actions (S10, FlowReadSelectiveScenarios, linked into both test projects) on the largest
/// ODC capture of the fixtures (the large ODC fixture of 310 actions) and on the blank mobile fixture for the merge.</summary>
public sealed class FlowReadSelectiveOdcTests(ITestOutputHelper output)
{
    private const string Large = "tests/fixtures/odc/wrightflood-personal-r8.oml";
    private const string Blank = "tests/fixtures/odc/blank-mobile.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(FlowReadSelectiveOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string Scratch()
    {
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "flow-read-selective-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    [Fact] public void SelectedActionsAreTheWholeReadingOfThem()
    {
        if (!StudioAvailable()) return;
        FlowReadSelectiveScenarios.SelectedActionsAreTheWholeReadingOfThem(Scratch(), Path.Combine(FindRoot(), Large), "odc", output.WriteLine);
    }

    [Fact] public void TheReaderNeverStoresASelectionAsTheModulesFlow()
    {
        if (!StudioAvailable()) return;
        FlowReadSelectiveScenarios.TheReaderNeverStoresASelectionAsTheModulesFlow(Scratch(), Path.Combine(FindRoot(), Large), "odc");
    }

    [Fact] public void AnEditOfASelectiveReadMergesOnTheSameBase()
    {
        if (!StudioAvailable()) return;
        FlowReadSelectiveScenarios.AnEditOfASelectiveReadMergesOnTheSameBase(Scratch(), Path.Combine(FindRoot(), Blank), "odc");
    }
}
