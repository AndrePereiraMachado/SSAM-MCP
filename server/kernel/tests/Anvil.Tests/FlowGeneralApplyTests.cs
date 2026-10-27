using Xunit;

namespace Anvil.Tests;

/// <summary>The general language of ssam-flow/1 (R7, FlowGeneral) through a real O11 job (FlowApplyScenarios, linked into both
/// test projects), on the blank service fixture.</summary>
public sealed class FlowGeneralApplyTests
{
    private const string Fixture = "blank-service.oml";
    [Fact] public void GeneralFormsApplyAndReadBackAsTheExpandedText() => Run(FlowApplyScenarios.GeneralFormsApplyAndReadBackAsTheExpandedText);
    [Fact] public void ContextProjectionAndTypedLetsApplyThroughTheOp() => Run(FlowApplyScenarios.ContextProjectionAndTypedLetsApplyThroughTheOp);
    [Fact] public void RecordsContractsAndBindsApplyAndReadBackAsTheExpandedText() => Run(FlowApplyScenarios.RecordsContractsAndBindsApplyAndReadBackAsTheExpandedText);

    private static void Run(Action<string, string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "flow-apply-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        scenario(dir, Fixture, "o11");
    }
}
