using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>ONINITIALIZE_SERVER_CALL in the ODC lane, on the Mobile fixture (OnInitializeRuleScenarios, linked into both test projects).</summary>
public sealed class OnInitializeRuleOdcTests
{
    private const string Fixture = "tests/fixtures/odc/blank-mobile.oml";

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(OnInitializeRuleOdcTests).Assembly.Location);
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
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "oninitialize-rule-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        OnInitializeRuleScenarios.Prelude = ["""{"op":"create","parent":"@espace","type":"IRole","name":"OiRole"}""", """{"op":"create","parent":"@espace","type":"IMobileFlow","name":"MainFlow"}"""];
        OnInitializeRuleScenarios.Roles = "OiRole";
        scenario(dir, Fixture);
    }

    [Fact] public void AServerCallInOnInitializeIsRefusedWithTheFixToADataAction() => Run(OnInitializeRuleScenarios.AServerCallInOnInitializeIsRefusedWithTheFixToADataAction);
    [Fact] public void AServerCallThroughAClientActionIsRefusedNamingTheChain() => Run(OnInitializeRuleScenarios.AServerCallThroughAClientActionIsRefusedNamingTheChain);
    [Fact] public void TheSameCallFromOnReadyPassesAndAnOnInitializeWithoutCallsPasses() => Run(OnInitializeRuleScenarios.TheSameCallFromOnReadyPassesAndAnOnInitializeWithoutCallsPasses);
    [Fact] public void ABlockIsJudgedLikeAScreen() => Run(OnInitializeRuleScenarios.ABlockIsJudgedLikeAScreen);
    [Fact] public void ARawSetThatBindsOnInitializeToAHandlerWithTheCallIsRefused() => Run(OnInitializeRuleScenarios.ARawSetThatBindsOnInitializeToAHandlerWithTheCallIsRefused);
    [Fact] public void ALegacyCallIsAHighWarningNotARefusal() => Run(OnInitializeRuleScenarios.ALegacyCallIsAHighWarningNotARefusal);
}
