using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The selective reading of actions (S10, FlowReadSelectiveScenarios, linked into both test projects) on the largest
/// O11 capture of the fixtures (HMISJHA_CS, 347 server actions) and on the blank service fixture for the merge.</summary>
public sealed class FlowReadSelectiveTests(ITestOutputHelper output)
{
    private const string Large = "tests/fixtures/hmisjha/HMISJHA_CS-v5578.oml";
    private const string Blank = "tests/fixtures/blank-service.oml";

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-read-selective-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static string Fixture(string relative) => Path.Combine(PacoteBPolicyTests.FindRoot(), relative);

    [Fact] public void SelectedActionsAreTheWholeReadingOfThem()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowReadSelectiveScenarios.SelectedActionsAreTheWholeReadingOfThem(Scratch(), Fixture(Large), "o11", output.WriteLine);
    }

    [Fact] public void TheReaderNeverStoresASelectionAsTheModulesFlow()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowReadSelectiveScenarios.TheReaderNeverStoresASelectionAsTheModulesFlow(Scratch(), Fixture(Large), "o11");
    }

    [Fact] public void AnEditOfASelectiveReadMergesOnTheSameBase()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        FlowReadSelectiveScenarios.AnEditOfASelectiveReadMergesOnTheSameBase(Scratch(), Fixture(Blank), "o11");
    }
}
