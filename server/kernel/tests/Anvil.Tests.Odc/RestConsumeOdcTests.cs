using Anvil.Core;
using Anvil.Tests;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>The generator rest-consume in the ODC lane (RestConsumeScenarios, linked into both test projects), on the blank app.</summary>
public sealed class RestConsumeOdcTests
{
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(RestConsumeOdcTests).Assembly.Location);
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
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "rest-consume-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture);
    }

    [Fact] public void EveryFixtureAppliesVerifiesAndReadsBack() => Run(RestConsumeScenarios.EveryFixtureAppliesVerifiesAndReadsBack);
    [Fact] public void TheGateAppliesInOneJob() => Run(RestConsumeScenarios.TheGateAppliesInOneJob);
    [Fact] public void ATakenNameMovesOnAndTheRerunFindsIt() => Run(RestConsumeScenarios.ATakenNameMovesOnAndTheRerunFindsIt);
    [Fact] public void AChangedSampleUpdatesInPlace() => Run(RestConsumeScenarios.AChangedSampleUpdatesInPlace);
    [Fact] public void EveryDataProblemIsOneRefusal() => Run(RestConsumeScenarios.EveryDataProblemIsOneRefusal);
    [Fact] public void EveryAuthModeAppliesVerifiesAndReadsBack() => Run(RestConsumeAuthScenarios.EveryAuthModeAppliesVerifiesAndReadsBack);
    [Fact] public void AnAuthThatChangesRemovesWhatItNoLongerNeeds() => Run(RestConsumeAuthScenarios.AnAuthThatChangesRemovesWhatItNoLongerNeeds);
    [Fact] public void EveryAuthProblemIsOneRefusal() => Run(RestConsumeAuthScenarios.EveryAuthProblemIsOneRefusal);
    [Fact] public void ACallbackTheOpDidNotWriteIsRefused() => Run(RestConsumeAuthScenarios.ACallbackTheOpDidNotWriteIsRefused);
    [Fact] public void BasicAuthNeedsBinaryDataOnO11() => Run(RestConsumeAuthScenarios.BasicAuthNeedsBinaryDataOnO11);
}
