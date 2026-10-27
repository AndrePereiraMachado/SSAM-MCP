using Xunit;

namespace Anvil.Tests;

/// <summary>Family F5 (composition in one delivery) on the O11 lane: CompositionScenarios (linked into both test projects) on
/// the Reactive fixture (on this base the html document form is Reactive and Mobile). Needs the Service Studio.</summary>
public sealed class CompositionTests
{
    private static void Run(string fixture, Action<string, string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "composition-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, fixture, "o11");
    }

    [Fact] public void EveryOrderOfEveryReferenceKindBuildsTheSameModule() => Run("reactive-ui.oml", CompositionScenarios.EveryOrderOfEveryReferenceKindBuildsTheSameModule);
    [Fact] public void AShuffledJobOfEveryReferenceKindBuildsTheSameModule() => Run("reactive-ui.oml", CompositionScenarios.AShuffledJobOfEveryReferenceKindBuildsTheSameModule);
    [Fact] public void AReferenceToAnElementThatExistsNowhereIsRefusedOnceNamingIt() => Run("reactive-ui.oml", CompositionScenarios.AReferenceToAnElementThatExistsNowhereIsRefusedOnceNamingIt);
    [Fact] public void TheSameLogicWithoutAliasesBuildsAsWithThem() => Run("reactive-ui.oml", CompositionScenarios.TheSameLogicWithoutAliasesBuildsAsWithThem);
    [Fact] public void ANodeNameTheScopeHoldsIsRefusedNamingBoth() => Run("reactive-ui.oml", CompositionScenarios.ANodeNameTheScopeHoldsIsRefusedNamingBoth);
}
