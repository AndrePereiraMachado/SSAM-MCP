using System.Text.Json.Nodes;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F7 (25/10/2026): the outputs of a call a ssam-flow/1 text reads, judged by the scope phase (ScopeOutputs) over the module
/// index of ScopePhaseTests (entity Order, server action GetOrders), lane o11. The owner's delivery reached the Verify with 15
/// ExpressionUnknownObject: `Lock = GetPedidoForUpdate(...)` then `Lock.Pedido.X`, where the entity action's only output is
/// Record. Refused here before the build, with the patch when the output meant is certain; a callee whose outputs are not
/// known here (an action of the base, of a reference) is left to the Verify. The ODC mirror is in ScopePhaseOdcTests.
/// </summary>
public class ScopeOutputsTests
{
    private const string Lane = "o11";
    private static List<JsonObject> Unknown(ScopePhase.Result r) => ScopePhaseTests.Code(r, ScopeOutputs.Code);

    [Fact]
    public void TheEntityRecordReadWithoutRecordIsRefusedWithThePatch()
    {
        var text = "server action Close\n  in OrderId: Order Identifier\n  local Done: Boolean\n  Lock = GetOrderForUpdate(Id=OrderId)\n"
            + "  assign Done = Lock.Order.Id = OrderId\n  Same = GetOrder(Id=OrderId)\n  assign Done = Done and Same.Order.Id <> NullIdentifier() and Lock.Order.Id > 0\n  end\n";
        var problems = Unknown(ScopePhaseTests.Run(Lane, ScopePhaseTests.Ops(ScopePhaseTests.Logic(text))));
        Assert.Equal(2, problems.Count);
        var lockProblem = problems.Single(p => p["message"]!.ToString().Contains("Lock.Order.Id"));
        Assert.Equal("scope", lockProblem["phase"]!.ToString());
        Assert.Equal("ExpressionUnknownObject", lockProblem["predicts"]!.ToString());
        Assert.Equal("/ops/0/data/flow/0", lockProblem["pointer"]!.ToString());
        Assert.Contains("(2 times in Close)", lockProblem["message"]!.ToString());
        Assert.Contains("GetOrderForUpdate, which has the only output Record (the Order record: Lock.Record.Order.<Attribute>)", lockProblem["message"]!.ToString());
        Assert.Contains("write Lock.Record.Order", lockProblem["fix"]!.ToString());
        // One patch for the whole text, the same on each problem: every certain correction of the rule written in it.
        var patched = lockProblem["patch"]![0]!["value"]!.ToString();
        Assert.Equal(patched, problems.Single(p => p != lockProblem)["patch"]![0]!["value"]!.ToString());
        Assert.Contains("Lock.Record.Order.Id = OrderId", patched);
        Assert.Contains("Same.Record.Order.Id <> NullIdentifier() and Lock.Record.Order.Id > 0", patched);
        Assert.Empty(Unknown(ScopePhaseTests.Run(Lane, ScopePhaseTests.Ops(ScopePhaseTests.Logic(patched)))));
    }

    [Fact]
    public void TheOutputsOfAnActionOfTheJobAreItsOutLines()
    {
        var helper = ScopePhaseTests.Logic("server action Totals\n  out Total: Integer\n  out Count: Integer\n  end\n");
        var caller = ScopePhaseTests.Logic("server action Report\n  local X: Integer\n  T = Totals()\n  assign X = T.Totl + T.Count\n  New = CreateOrder(Source=R)\n  assign X = New.OrderId\n  end\n");
        var problems = Unknown(ScopePhaseTests.Run(Lane, ScopePhaseTests.Ops(helper, caller)));
        Assert.Equal(2, problems.Count);
        var typo = problems.Single(p => p["message"]!.ToString().Contains("'Totl'"));
        Assert.Contains("which has the outputs Total, Count", typo["message"]!.ToString());
        Assert.Contains("T.Total + T.Count", typo["patch"]![0]!["value"]!.ToString());
        Assert.Contains(problems, p => p["message"]!.ToString().Contains("CreateOrder, which has the only output Id"));
    }

    [Fact]
    public void ACalleeWhoseOutputsAreNotKnownHereIsLeftToTheVerify()
    {
        // GetOrders is a server action of the base (not the entity action of an entity Orders); Orders_CS.ListOrders a reference.
        var text = "server action Report\n  local X: Integer\n  G = GetOrders()\n  L = Orders_CS.ListOrders()\n  assign X = G.Anything + L.Whatever\n"
            + "  Rows = aggregate FROM Order MAX 1\n  assign X = Rows.List.Length\n  end\n";
        Assert.Empty(Unknown(ScopePhaseTests.Run(Lane, ScopePhaseTests.Ops(ScopePhaseTests.Logic(text)))));
    }
}
