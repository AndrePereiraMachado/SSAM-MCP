using Anvil.Core;
using Anvil.Tests;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>The review of integration 24-1 familias on the ODC lane (FamiliasRevisaoScenarios, linked into both test projects), on
/// the reactive fixture insurance-reactive-r8. Needs the ODC Studio.</summary>
public sealed class FamiliasRevisaoOdcTests
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(FamiliasRevisaoOdcTests).Assembly.Location);
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
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "familias-revisao", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture, "odc");
    }

    [Fact] public void OneDocumentOnePatchAndATypoIsNeverItsLiteral() => Run(FamiliasRevisaoScenarios.OneDocumentOnePatchAndATypoIsNeverItsLiteral);
    [Fact] public void AnImageIsTheModulesByItsFileNameItsBinaryByTypeOrRefusedWithTheNearest() => Run(FamiliasRevisaoScenarios.AnImageIsTheModulesByItsFileNameItsBinaryByTypeOrRefusedWithTheNearest);
    [Fact] public void ARuleForTheInsideOfAnSvgIsAProblemOfTheSameRefusal() => Run(FamiliasRevisaoScenarios.ARuleForTheInsideOfAnSvgIsAProblemOfTheSameRefusal);
}
