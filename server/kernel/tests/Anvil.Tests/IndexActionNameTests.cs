using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class IndexActionNameTests
{
    [Fact]
    public void TheModuleIndexIdentifiesOwnActionsWithoutTreatingReferenceSignaturesAsOwn()
    {
        var ops = ScopePhaseTests.Ops(ScopePhaseTests.Logic("server action GetOrders\n  end\n"));
        var facts = ScopePhaseTests.Facts(ops, "o11");
        var problem = Assert.Single(ActionNameRules.Check(ops, "/ops", facts));
        Assert.Equal("FLOW_ACTION_NAME_TAKEN", problem["code"]!.ToString());
        Assert.Equal("get", problem["id"]!.ToString());
        Assert.Contains("the index has no action body", problem["fix"]!.ToString());
        Assert.Contains("read the current text of the action @get", problem["fix"]!.ToString());
        Assert.Null(problem["text"]); // An index has identity but no editable flow text.
        Assert.Equal("@get", problem["rename"]!["target"]!.ToString());
        Assert.Null(problem["patch"]);

        var imported = ScopePhaseTests.Ops(ScopePhaseTests.Logic("server action ListOrders\n  end\n"));
        Assert.DoesNotContain(ActionNameRules.Check(imported, "/ops", ScopePhaseTests.Facts(imported, "o11")),
            p => p["code"]!.ToString() == "FLOW_ACTION_NAME_TAKEN");
    }
}
