using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects. F10 (the owner's 9 screens of SSAMCoverageSoapWire_UI on 2026-10-25), what the job alone
/// decides: the declarations of the page edits go before the logic and the other pages (HTML_DECLARATIONS_FIRST: 4 rounds were
/// refused "the destination of ev:OnClick on the new element has no input PedidoId" until the owner wrote 42 create/set ops);
/// the texts of a logic op fail together, so the screen actions one of them declares are a cascade of the one that failed (22-33
/// HTML_NAME_UNKNOWN a round, "closest: &lt;screens&gt;"); the op of a problem is the one of the job as sent.
/// </summary>
public sealed class HtmlDocumentDeclarationsFirstTests
{
    private static JsonObject Html(string screen, params string[] edits) => new()
    {
        ["op"] = "html",
        ["data"] = new JsonObject { ["screen"] = screen, ["basedOn"] = new JsonObject { ["capture"] = "c", ["html"] = "h-" + screen }, ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) },
    };

    private static JsonObject Logic(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } };

    private static JsonArray Job() => new(
        new JsonObject { ["op"] = "reference", ["producer"] = "Core", ["elements"] = new JsonArray("IEntitySignature:Pedido") },
        Logic("action Dashboard.AplicarPeriodo\n  end"),
        Html("Dashboard", "<div k=\"w7\"><button onclick=\"Detalhe(PedidoId = 1)\">Ver</button></div>"),
        Html("Detalhe", "<input name=\"PedidoId\" type=\"Pedido Identifier\" mandatory=\"True\"/><var k=\"w2\" name=\"Aba\" type=\"Text\"/>\n<div k=\"w9\" class=\"tabs\"/>"));

    private static List<JsonObject> Hoisted(IEnumerable<JsonObject> done) => done.Where(n => n["rule"]?.ToString() == "HTML_DECLARATIONS_FIRST").ToList();

    [Fact]
    public void TheDeclarationsOfAPageEditGoBeforeTheLogicAndThePagesThatUseThem()
    {
        var ops = Job();
        var done = JobNormalizer.Pure(ops, "/ops", "o11");
        var entry = Assert.Single(Hoisted(done));
        Assert.Equal("/ops/3/data/edit", entry["path"]!.ToString());
        Assert.Contains("PedidoId, Aba", entry["message"]!.ToString());
        Assert.Equal(5, ops.Count);
        // reference, the declarations of Detalhe (same screen and reading), the logic, Dashboard, the rest of the edit of Detalhe.
        Assert.Equal("html", ops[1]!["op"]!.ToString());
        Assert.Equal("Detalhe", ops[1]!["data"]!["screen"]!.ToString());
        Assert.Equal("h-Detalhe", ops[1]!["data"]!["basedOn"]!["html"]!.ToString());
        Assert.Equal(["<input name=\"PedidoId\" type=\"Pedido Identifier\" mandatory=\"True\"/>", "<var k=\"w2\" name=\"Aba\" type=\"Text\"/>"],
            ops[1]!["data"]!["edit"]!.AsArray().Select(e => e!.ToString()));
        Assert.Equal("logic", ops[2]!["op"]!.ToString());
        Assert.Equal("Dashboard", ops[3]!["data"]!["screen"]!.ToString());
        Assert.Equal("<div k=\"w9\" class=\"tabs\"/>", ops[4]!["data"]!["edit"]![0]!.ToString());
        // The answer speaks of the job as sent: the inserted op points at the edit it came from, the others at their own place.
        Assert.Equal("/ops/3/data/edit", SentJob.ToSent("/ops/1/data/edit/0", ops, "/ops").Pointer);
        Assert.Equal("/ops/2/data/edit/0", SentJob.ToSent("/ops/3/data/edit/0", ops, "/ops").Pointer);
        // Run again (the apply normalizes the job the preflight normalized): nothing moves twice.
        Assert.Empty(Hoisted(JobNormalizer.Pure(ops, "/ops", "o11")));
        Assert.Equal(5, ops.Count);
    }

    [Fact]
    public void AWholeDocumentGivesItsNewDeclarationsAndKeepsTheOnesOfTheReading()
    {
        var ops = new JsonArray(Logic("action Detalhe.Salvar\n  end"),
            Html("Detalhe", "<screen name=\"Detalhe\">\n<input name=\"PedidoId\" type=\"Pedido Identifier\"/>\n<var k=\"w1\" name=\"Aba\" type=\"Text\"/>\n<div k=\"w2\"/>\n</screen>"));
        var done = JobNormalizer.Pure(ops, "/ops", "o11");
        Assert.Single(Hoisted(done));
        Assert.Equal(["<input name=\"PedidoId\" type=\"Pedido Identifier\"/>"], ops[0]!["data"]!["edit"]!.AsArray().Select(e => e!.ToString()));
        var document = ops[2]!["data"]!["edit"]![0]!.ToString();
        Assert.DoesNotContain("PedidoId", document);
        Assert.Contains("<var k=\"w1\" name=\"Aba\" type=\"Text\"/>", document);
        Assert.Empty(Hoisted(JobNormalizer.Pure(ops, "/ops", "o11")));
        // A whole document whose declarations are all of the reading moves nothing.
        var read = new JsonArray(Logic("action Detalhe.Salvar\n  end"), Html("Detalhe", "<screen name=\"Detalhe\">\n<var k=\"w1\" name=\"Aba\" type=\"Text\"/>\n</screen>"));
        Assert.Empty(Hoisted(JobNormalizer.Pure(read, "/ops", "o11")));
    }

    [Fact]
    public void NothingMovesPastWhatDeclaresTheirTypesNorAnEditOfDeclarationsOnly()
    {
        // A create between the first writer and the edit (it may make the type of a declaration): left as it is.
        var ops = Job();
        ops.Insert(3, new JsonObject { ["op"] = "create", ["parent"] = "IMobileScreen:Detalhe", ["type"] = "ILocalVariable", ["name"] = "Extra" });
        Assert.Empty(Hoisted(JobNormalizer.Pure(ops, "/ops", "o11")));
        // An edit of declarations only stays where it is (it is already an edit of its own).
        var only = new JsonArray(Logic("action Detalhe.Salvar\n  end"), Html("Detalhe", "<input name=\"PedidoId\" type=\"Pedido Identifier\"/>"));
        Assert.Empty(Hoisted(JobNormalizer.Pure(only, "/ops", "o11")));
        Assert.Equal(2, only.Count);
    }

    private static JsonObject P(string phase, int op, string pointer, string code, string message) =>
        new() { ["op"] = op, ["pointer"] = pointer, ["code"] = code, ["severity"] = "error", ["message"] = message, ["phase"] = phase };

    [Fact]
    public void AFailingTextOfALogicOpFailsItsOtherTextsAndTheirScreenActionsAreItsCascade()
    {
        var ops = new JsonArray(
            Logic("server action Consultar\n  out L: Cliente List\n  end", "action Dashboard.AplicarPeriodo\n  end", "action Pedidos.Filtrar\n  in Valor: Integer\n  end"),
            Html("Dashboard", "<div k=\"w1\"><button onclick=\"AplicarPeriodo\">x</button></div>"),
            Html("Pedidos", "<div k=\"w1\"><button onclick=\"Filtrar(Valor = 1)\">x</button></div>"));
        var root = P("apply", 0, "/ops/0/data/flow/0", "FLOW_NAME_AMBIGUOUS", "EntityOrStructure = Cliente");
        var all = new List<JsonObject>
        {
            root,
            P("apply", 1, "/ops/1/data/edit/0", "HTML_NAME_UNKNOWN", "'AplicarPeriodo' names nothing as the destination of hev:onclick from Dashboard: Dashboard has no screen action and the module no screen of that name"),
            P("apply", 2, "/ops/2/data/edit/0", "HTML_NAME_UNKNOWN", "'Filtrar' names nothing as the destination of hev:onclick from Pedidos: Pedidos has no screen action and the module no screen of that name"),
            P("apply", 2, "/ops/2/data/edit/0", "HTML_NAME_UNKNOWN", "'Nada' names nothing as the destination of hev:onclick from Pedidos: Pedidos has no screen action and the module no screen of that name"),
        };
        var folded = JobRunner.FoldCascade(all, ops, "/ops");
        Assert.Equal(2, folded.Count);
        Assert.Same(root, folded[0]);
        Assert.Equal(2, root["blocks"]!.GetValue<int>());
        // A name no part of the job declares is a fault of its own.
        Assert.Contains("'Nada'", folded[1]["message"]!.ToString());
    }

    [Fact]
    public void TheOpOfAProblemIsTheOneOfItsPointerInTheJobAsSent()
    {
        var ops = Job();
        JobNormalizer.Pure(ops, "/ops", "o11");
        var problem = P("verify", 4, "/ops/3/data/edit/0", "ExpressionUnknownObject", "Error ExpressionUnknownObject: Can't identify 'X'");
        var folded = JobRunner.FoldCascade([problem], ops, "/ops");
        Assert.Equal(3, Assert.Single(folded)["op"]!.GetValue<int>());
    }
}
