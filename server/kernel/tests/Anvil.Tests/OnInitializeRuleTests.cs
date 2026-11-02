using Xunit;

namespace Anvil.Tests;

/// <summary>ONINITIALIZE_SERVER_CALL in the O11 lane, on the Reactive fixture (OnInitializeRuleScenarios, linked into both test projects).</summary>
public sealed class OnInitializeRuleTests
{
    private const string Fixture = "reactive-ui.oml";

    private static string Scratch()
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "oninitialize-rule-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir); return dir;
    }

    private static void Run(Action<string, string> scenario)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        scenario(Scratch(), Fixture);
    }

    [Fact] public void AServerCallInOnInitializeIsRefusedWithTheFixToADataAction() => Run(OnInitializeRuleScenarios.AServerCallInOnInitializeIsRefusedWithTheFixToADataAction);
    [Fact] public void AServerCallThroughAClientActionIsRefusedNamingTheChain() => Run(OnInitializeRuleScenarios.AServerCallThroughAClientActionIsRefusedNamingTheChain);
    [Fact] public void TheSameCallFromOnReadyPassesAndAnOnInitializeWithoutCallsPasses() => Run(OnInitializeRuleScenarios.TheSameCallFromOnReadyPassesAndAnOnInitializeWithoutCallsPasses);
    [Fact] public void ABlockIsJudgedLikeAScreen() => Run(OnInitializeRuleScenarios.ABlockIsJudgedLikeAScreen);
    [Fact] public void ARawSetThatBindsOnInitializeToAHandlerWithTheCallIsRefused() => Run(OnInitializeRuleScenarios.ARawSetThatBindsOnInitializeToAHandlerWithTheCallIsRefused);
    [Fact] public void ALegacyCallIsAHighWarningNotARefusal() => Run(OnInitializeRuleScenarios.ALegacyCallIsAHighWarningNotARefusal);
}
