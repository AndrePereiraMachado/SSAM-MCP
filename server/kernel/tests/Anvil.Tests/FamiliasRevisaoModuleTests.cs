using Xunit;

namespace Anvil.Tests;

/// <summary>The review of integration 24-1 familias on the O11 lane (FamiliasRevisaoScenarios, linked into both test projects), on
/// the reactive fixture. Needs the Service Studio.</summary>
public sealed class FamiliasRevisaoModuleTests
{
    private const string Fixture = "reactive-ui.oml";

    private static void Run(Action<string, string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "familias-revisao", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture, "o11");
    }

    [Fact] public void OneDocumentOnePatchAndATypoIsNeverItsLiteral() => Run(FamiliasRevisaoScenarios.OneDocumentOnePatchAndATypoIsNeverItsLiteral);
    [Fact] public void AnImageIsTheModulesByItsFileNameItsBinaryByTypeOrRefusedWithTheNearest() => Run(FamiliasRevisaoScenarios.AnImageIsTheModulesByItsFileNameItsBinaryByTypeOrRefusedWithTheNearest);
    [Fact] public void ARuleForTheInsideOfAnSvgIsAProblemOfTheSameRefusal() => Run(FamiliasRevisaoScenarios.ARuleForTheInsideOfAnSvgIsAProblemOfTheSameRefusal);
}
