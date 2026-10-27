using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>Family F5: the composition plan of a job without a module (JobComposition): what each op declares and needs, the
/// order the ops run in, the roots declared before the first op, and the cycles of hard needs kept in the job's order.</summary>
public sealed class JobCompositionTests
{
    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Flow(string text) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray((JsonNode)text) } };
    private static JsonObject Ddl(string text) => new() { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } };
    private static JobComposition.Plan Plan(params JsonObject[] ops) => JobComposition.Compose(new JsonArray(ops.Select(o => (JsonNode)o.DeepClone()).ToArray()), Enumerable.Range(0, ops.Length).ToArray(), _ => false);

    private static readonly JsonObject List = Html("<screen name=\"JcList\">\n<a onclick=\"JcDetail(Id = 1)\">Open</a>\n</screen>");
    private static readonly JsonObject Detail = Html("<screen name=\"JcDetail\">\n<input name=\"Id\" type=\"Integer\"/>\n<a onclick=\"JcList()\">Back</a>\n</screen>");

    [Fact]
    public void AScreenAnEarlierOpNavigatesToIsDeclaredFirstAndNothingMoves()
    {
        var plan = Plan(List, Detail);
        Assert.Equal([0, 1], plan.Order);
        Assert.Equal((1, "JcDetail"), Assert.Single(plan.Roots));
        Assert.Empty(plan.Moved);
        // The other order: the same, the other root.
        var back = Plan(Detail, List);
        Assert.Equal((1, "JcList"), Assert.Single(back.Roots));
        // Its signature is the root with its name and inputs, nothing else.
        var signature = JobComposition.Signature(Detail["data"]!["html"]!.GetValue<string>())!;
        Assert.Contains("<screen name=\"JcDetail\">", signature);
        Assert.Contains("<input name=\"Id\" type=\"Integer\"/>", signature);
        Assert.DoesNotContain("onclick", signature);
    }

    [Fact]
    public void WhatAnOpNeedsWholeRunsBeforeItInAStableOrder()
    {
        var block = Html("<block name=\"JcCard\">\n<input name=\"Title\" type=\"Text\"/>\n</block>");
        var uses = Html("<screen name=\"JcUses\">\n<Block name=\"JcCard\" :Title=\"&quot;x&quot;\"/>\n</screen>");
        var owner = Flow("action JcUses.Go\n  end\n");
        var structure = Ddl("type JcRow = {\n  Label: Text(50);\n}\n");
        var typed = Flow("server action JcTakes\n  in Row: JcRow\n  end\n");
        var plan = Plan(owner, typed, uses, structure, block);
        // owner needs the screen (op 2), which needs the block (op 4); typed needs the structure (op 3).
        Assert.Equal([4, 2, 0, 3, 1], plan.Order);
        Assert.Contains(plan.Moved, m => m.Op == 2 && m.Before == 0);
        Assert.Contains(plan.Moved, m => m.Op == 3 && m.Before == 1);
        Assert.Empty(plan.Roots);
        // A name the base already has is the base's: nothing moves.
        Assert.Equal([0, 1, 2, 3, 4], JobComposition.Compose(new JsonArray(owner.DeepClone(), typed.DeepClone(), uses.DeepClone(), structure.DeepClone(), block.DeepClone()),
            [0, 1, 2, 3, 4], name => name is "JcUses" or "JcRow" or "JcCard").Order);
    }

    // ---- the review of a0a23ad8 (P1-P4) -------------------------------------------------------------------------------------

    [Fact]
    public void EveryOpWhosePlaceChangedIsInTheReceipt()
    {
        // P1: op 0 needs op 2, which needs op 1: both move before op 0, and op 0 itself runs elsewhere.
        var c = Flow("server action PvC\n  PvM()\n  end\n");
        var p = Ddl("type PvRow = {\n  Label: Text(50);\n}\n");
        var m = Flow("server action PvM\n  in Row: PvRow\n  end\n");
        var plan = Plan(c, p, m);
        Assert.Equal([1, 2, 0], plan.Order);
        Assert.Equal([0, 1, 2], plan.Moved.Select(x => x.Op).Order());
        Assert.Contains(plan.Moved, x => x.Op == 2 && x.Before == 0 && x.Declares == "PvM");
        Assert.Contains(plan.Moved, x => x.Op == 1 && x.From == 1 && x.To == 0);
        Assert.Contains(plan.Moved, x => x.Op == 0 && x.From == 0 && x.To == 2 && x.Before == null);
    }

    [Fact]
    public void AWordThatNamesNothingIsNoNeed()
    {
        // P2: a parameter named like a block, a class named like an entity: no reference, nothing moves; the same plan twice.
        var logic = Flow("server action PvShip\n  in Order: Text\n  out Total: Integer\n  assign Total = Length(Order)\n  end\n");
        var block = Html("<block name=\"Total\">\n<p>t</p>\n</block>");
        Assert.Equal([0, 1], Plan(logic, block).Order);
        Assert.Empty(Plan(logic, block).Moved);
        var doc = Html("<screen name=\"PvList\">\n<div class=\"order card\">x</div>\n</screen>");
        var spec = Ddl("create entity Order (\n  Id Long Integer identifier auto,\n  Name Text(50)\n);\n");
        Assert.Equal([0, 1], Plan(doc, spec).Order);
        Assert.Equal(Plan(logic, block).Order, Plan(logic, block).Order);
        // A type, a source of an aggregate and a parameter typed with an entity are references.
        var typed = Html("<screen name=\"PvTyped\">\n<var name=\"Row\" type=\"Order List\"/>\n</screen>");
        Assert.Equal([1, 0], Plan(typed, spec).Order);
    }

    [Fact]
    public void ThePageFormKeepsItsLogicOpAfterIt()
    {
        // P3: the page's text says the name of a client action of the logic op that also declares the page's screen action
        // (H10): the logic op stays after the page.
        var page = new JsonObject { ["op"] = "html", ["data"] = JsonNode.Parse("""{"screen":"Prototipo","title":"P","layout":"blank","html":"<button data-av=\"go\">Formatar</button>","bindings":{"go":{"kind":"action","action":"Salvar"}}}""") };
        var logic = JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"Formatar","kind":"client","steps":[]},{"name":"Salvar","kind":"screen","owner":"IMobileScreen:Prototipo","steps":[]}]}}""")!.AsObject();
        Assert.Equal([0, 1], Plan(page, logic).Order);
        // Written the other way, the logic op needs the page's screen: the page runs first.
        Assert.Equal([1, 0], Plan(logic, page).Order);
        // P4: the captured page jobs (H10 fixtures) run as written.
        foreach (var name in new[] { "job79-cc36c64b", "job88-0f7ceafe", "job105-cfb79d98" })
        {
            var ops = HtmlPageFixtures.Ops(name);
            var plan = JobComposition.Compose(ops, Enumerable.Range(0, ops.Count).ToArray(), _ => false);
            Assert.True(plan.Order.SequenceEqual(Enumerable.Range(0, ops.Count)), name + ": " + string.Join(",", plan.Order));
            Assert.Empty(plan.Moved);
        }
    }

    [Fact]
    public void AnOpTheKernelDoesNotReadIsABarrierAndTwoWritersKeepTheirOrder()
    {
        // A raw op between a consumer and its provider: nothing moves across it.
        var owner = Flow("action JbUses.Go\n  end\n");
        var raw = JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IServerAction","name":"JbRaw"}""")!.AsObject();
        var uses = Html("<screen name=\"JbUses\">\n<p>x</p>\n</screen>");
        Assert.Equal([0, 1, 2], Plan(owner, raw, uses).Order);
        // A block that writes the theme is not moved past another writer of the theme: the job's order, whole.
        var screen = Html("<screen name=\"JbScreen\">\n<style scope=\"theme\">.a{color:red}</style>\n<Block name=\"JbCard\"/>\n</screen>");
        var other = Html("<screen name=\"JbOther\">\n<style scope=\"theme\">.b{color:blue}</style>\n<p>o</p>\n</screen>");
        var card = Html("<block name=\"JbCard\">\n<style scope=\"theme\">.c{color:green}</style>\n<p>c</p>\n</block>");
        var plan = Plan(screen, other, card);
        Assert.Equal([0, 1, 2], plan.Order);
        Assert.NotNull(plan.Kept);
        // With no other writer of the theme before it, the block runs first.
        var plain = Html("<screen name=\"JbScreen\">\n<Block name=\"JbCard\"/>\n</screen>");
        Assert.Equal([1, 0], Plan(plain, card).Order);
    }

    [Fact]
    public void ACycleOfHardNeedsKeepsTheJobsOrderAndIsNamed()
    {
        var a = Flow("server action JcA\n  JcB()\n  end\n");
        var b = Flow("server action JcB\n  JcA()\n  end\n");
        var plan = Plan(a, b);
        Assert.Equal([0, 1], plan.Order);
        Assert.Contains("#0 needs JcB of #1", Assert.Single(plan.Cycles));
        // A comment or a text literal names nothing.
        var quiet = Flow("/// Calls JcA? no.\nserver action JcQuiet\n  out T: Text\n  // JcA is not called\n  assign T = \"JcA\"\n  end\n");
        Assert.Equal([0, 1], Plan(quiet, Flow("server action JcA\n  end\n")).Order);
    }
}
