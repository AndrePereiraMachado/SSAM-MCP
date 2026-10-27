using Anvil.Core;
using Anvil.Tests;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>The general language of ssam-flow/1 (R7, FlowGeneral) through a real ODC job (FlowApplyScenarios, linked into both
/// test projects), on the blank mobile fixture.</summary>
public sealed class FlowGeneralApplyOdcTests
{
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";
    [Fact] public void GeneralFormsApplyAndReadBackAsTheExpandedText() => Run(FlowApplyScenarios.GeneralFormsApplyAndReadBackAsTheExpandedText);
    [Fact] public void ContextProjectionAndTypedLetsApplyThroughTheOp() => Run(FlowApplyScenarios.ContextProjectionAndTypedLetsApplyThroughTheOp);
    [Fact] public void RecordsContractsAndBindsApplyAndReadBackAsTheExpandedText() => Run(FlowApplyScenarios.RecordsContractsAndBindsApplyAndReadBackAsTheExpandedText);

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(FlowGeneralApplyOdcTests).Assembly.Location);
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
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "flow-apply-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture, "odc");
    }
}
