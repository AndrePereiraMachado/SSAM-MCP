using Anvil.Core;
using Anvil.Tests;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>Family F5 (composition in one delivery) on the ODC lane (CompositionScenarios, linked into both test projects), on
/// the reactive fixture insurance-reactive-r8. Needs the ODC Studio.</summary>
public sealed class CompositionOdcTests
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CompositionOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static void Run(Action<string, string, string> scenario)
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "composition-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture, "odc");
    }

    [Fact] public void EveryOrderOfEveryReferenceKindBuildsTheSameModule() => Run(CompositionScenarios.EveryOrderOfEveryReferenceKindBuildsTheSameModule);
    [Fact] public void AShuffledJobOfEveryReferenceKindBuildsTheSameModule() => Run(CompositionScenarios.AShuffledJobOfEveryReferenceKindBuildsTheSameModule);
    [Fact] public void AReferenceToAnElementThatExistsNowhereIsRefusedOnceNamingIt() => Run(CompositionScenarios.AReferenceToAnElementThatExistsNowhereIsRefusedOnceNamingIt);
    [Fact] public void TheSameLogicWithoutAliasesBuildsAsWithThem() => Run(CompositionScenarios.TheSameLogicWithoutAliasesBuildsAsWithThem);
    [Fact] public void ANodeNameTheScopeHoldsIsRefusedNamingBoth() => Run(CompositionScenarios.ANodeNameTheScopeHoldsIsRefusedNamingBoth);
    [Fact] public void ACallNamedLikeItsScopeIsRefusedOnTheJsonAndTheTextForm() => Run(CompositionScenarios.ACallNamedLikeItsScopeIsRefusedOnTheJsonAndTheTextForm);
}
