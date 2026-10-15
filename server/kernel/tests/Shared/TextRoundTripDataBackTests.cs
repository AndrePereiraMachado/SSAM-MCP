using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects. DL2 of the SSAM text plan, the way back of the data text, without the Studio: an edited
// text compiled against the module's text (DdlCompiler) gives the ops of what changed and nothing else: the same text gives
// none (the fixed point of the way back), the same key with another name is a rename (only a rename), an element without a
// key is new, an attribute or record left out of a statement sent whole is deleted, `drop … -- @key` deletes, and what the
// text cannot mean is refused once, with every problem and its line. The real modules (the battery, the rename on a real
// model, the request of the transcript) are TextRoundTripDataBackNativeTests.
public sealed class TextRoundTripDataBackTests
{
    private const string Base = """
        -- ssam-ddl/1 module=Shop lane=o11 key=@m sourceSha256=ab elements=20

        /// Products of the catalog.
        create entity Produto public label Nome ( -- @e1
          Id Long Integer identifier auto required, -- @a1
          CategoriaId Categoria Identifier required references Categoria on delete Protect, -- @a2
          /// Shown in the catalog.
          Nome Text(120) required, -- @a3
          Preco Decimal(18,2) default 0, -- @a4
          Ativo Boolean required default True -- @a5
        );
        create unique index UQ_Nome on Produto (Nome); -- @i1

        create entity Categoria public ( -- @e2
          Id Long Integer identifier auto required, -- @b1
          Nome Text(50) -- @b2
        );

        create static entity Status public ( -- @s1
          Id Integer identifier required, -- @c1
          Label Text(50) required, -- @c2
          Order Integer required -- @c3
        )
        values
          Aberto (Id = 1, Label = "Aberto", Order = 1), -- @r1
          Fechado (Id = 2, Label = "Fechado", Order = 2); -- @r2

        type Linha public = { -- @t1
          Qtd: Integer; -- @t1a
          Nome: Text(80) json "nome"; -- @t1b
        }

        site property Limite: Integer = 10 -- @p1

        timer Noturno action Recalcular schedule "When Published" -- @tm1
        """;

    private static string Block(string start)
    {
        var text = Base.Replace("\r\n", "\n");
        var at = text.IndexOf(start, StringComparison.Ordinal);
        var end = text.IndexOf("\n\n", at, StringComparison.Ordinal);
        return text[at..(end < 0 ? text.Length : end)];
    }

    private static DdlCompilation Compile(string edit, string lane = "o11") =>
        DdlCompiler.Compile(DdlParser.Parse(edit, lane), DdlParser.Parse(Base), lane, "$ddl", edit);

    // One line per op: verb, then its target or parent, prop and value (or name, or into/after).
    private static List<string> Ops(DdlCompilation compiled) => compiled.Ops().Select(o => o.Op).Select(op => op["op"]!.ToString() switch {
        "set" => $"set {op["target"]} {op["prop"]} {op["value"]?.ToJsonString() ?? "null"}",
        "rename" => $"rename {op["target"]} {op["name"]}",
        "create" => $"create {op["type"]} {op["name"]} in {op["parent"]}",
        "delete" => $"delete {op["target"]}",
        "move" => $"move {op["target"]} " + (op["into"] != null ? "into " + op["into"] : op["after"] != null ? "after " + op["after"] : "first"),
        "spec" => "spec " + string.Join(",", op["data"]!.AsObject().Select(p => p.Key + ":" + string.Join("/", p.Value!.AsArray().Select(e => e!["name"]!.ToString())))),
        var verb => verb }).ToList();

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void TheTextSentBackUnchangedIsZeroOps(string lane)
    {
        var compiled = Compile(Base.Replace("lane=o11", "lane=" + lane), lane);
        Assert.Empty(compiled.Problems);
        Assert.Equal(0, compiled.Count);
        // Each statement alone, as read, too.
        foreach (var start in new[] { "/// Products", "create entity Categoria", "create static entity Status", "type Linha", "site property Limite", "timer Noturno" })
            Assert.Equal(0, Compile(Block(start), lane).Count);
    }

    [Fact]
    public void RenamingAnAttributeIsOnlyARename()
    {
        // The model renames Nome in its statement and everywhere the statement names it (label, index columns).
        var edit = Block("/// Products").Replace("  Nome Text(120)", "  Titulo Text(120)").Replace("label Nome", "label Titulo").Replace("(Nome)", "(Titulo)");
        Assert.Equal(["rename @a3 Titulo"], Ops(Compile(edit)));
        var structure = Block("type Linha").Replace("  Nome: Text(80)", "  Descricao: Text(80)");
        Assert.Equal(["rename @t1b Descricao"], Ops(Compile(structure)));
        // A record and an entity are renamed the same way; another statement that still names the entity by its old name
        // is read with the new one (what the platform rewrites), so it changes nothing.
        var entity = Block("create entity Categoria").Replace("create entity Categoria", "create entity Grupo") + "\n\n" + Block("/// Products");
        Assert.Equal(["rename @e2 Grupo"], Ops(Compile(entity)));
        Assert.Equal(["rename @r2 Encerrado"], Ops(Compile(Block("create static entity Status").Replace("  Fechado (", "  Encerrado ("))));
        // The Label of a static entity, which its label points at without the text saying it: the link follows the attribute.
        Assert.Equal(["rename @c2 Rotulo"], Ops(Compile(Block("create static entity Status").Replace("  Label Text(50)", "  Rotulo Text(50)").Replace("Label = ", "Rotulo = "))));
    }

    public static IEnumerable<object[]> Edits() => new (string Name, string Start, string From, string To, string[] Ops)[] {
        ("description changed", "/// Products", "/// Shown in the catalog.", "/// Shown everywhere.", ["set @a3 Description \"Shown everywhere.\""]),
        ("description removed", "/// Products", "  /// Shown in the catalog.\n", "", ["set @a3 Description \"\""]),
        ("required removed", "/// Products", "Nome Text(120) required,", "Nome Text(120),", ["set @a3 IsMandatory \"False\""]),
        ("length", "/// Products", "Text(120)", "Text(200)", ["set @a3 Length \"200\""]),
        ("decimals", "/// Products", "Decimal(18,2)", "Decimal(18,4)", ["set @a4 Decimals \"4\""]),
        ("default", "/// Products", "default 0,", "default 1,", ["set @a4 DefaultValue \"1\""]),
        ("default removed", "/// Products", " default 0,", ",", ["set @a4 DefaultValue \"\""]),
        ("public removed", "/// Products", "create entity Produto public", "create entity Produto", ["set @e1 Public \"False\""]),
        ("update behavior", "/// Products", "public label Nome", "public label Nome update full", ["set @e1 UpdateBehavior \"Full\""]),
        ("label attribute", "/// Products", "label Nome", "label Preco", ["set @e1 LabelAttribute \"@a4\""]),
        ("delete rule", "/// Products", "on delete Protect", "on delete Ignore", ["set @a2 DeleteRule \"Ignore\""]),
        ("json", "type Linha", "json \"nome\"", "json \"name\"", ["set @t1b NameInJSON \"name\""]),
        ("attribute added", "create entity Categoria", "  Nome Text(50) -- @b2", "  Nome Text(50), -- @b2\n  Ordem Integer default 0",
            ["create IEntityAttribute Ordem in @e2", "set $ddl~1 DataType \"Integer\"", "set $ddl~1 DefaultValue \"0\""]),
        ("attribute added in the middle", "create entity Categoria", "  Nome Text(50) -- @b2", "  Codigo Text(10),\n  Nome Text(50) -- @b2",
            ["create IEntityAttribute Codigo in @e2", "set $ddl~1 DataType \"Text\"", "set $ddl~1 Length \"10\"", "move $ddl~1 after @b1"]),
        ("attribute deleted", "/// Products", "  Preco Decimal(18,2) default 0, -- @a4\n", "", ["delete @a4"]),
        ("attributes swapped", "type Linha", "  Qtd: Integer; -- @t1a\n  Nome: Text(80) json \"nome\"; -- @t1b", "  Nome: Text(80) json \"nome\"; -- @t1b\n  Qtd: Integer; -- @t1a", ["move @t1b first"]),
        ("type changed", "/// Products", "Preco Decimal(18,2) default 0", "Preco Integer default 0", ["set @a4 DataType \"Integer\"", "set @a4 DefaultValue \"0\""]),
        ("reference changed", "/// Products", "CategoriaId Categoria Identifier required references Categoria", "CategoriaId Status Identifier required references Status",
            ["set @a2 DataType \"Status Identifier\""]),
        ("record value", "create static entity Status", "Label = \"Fechado\"", "Label = \"Encerrado\"", ["set @r2/Label Value \"\\u0022Encerrado\\u0022\""]),
        ("record added", "create static entity Status", "Order = 2); -- @r2", "Order = 2), -- @r2\n  Cancelado (Id = 3, Label = \"Cancelado\", Order = 3);",
            ["create IRecord Cancelado in @s1", "set $ddl~1/Id Value \"3\"", "set $ddl~1/Label Value \"\\u0022Cancelado\\u0022\"", "set $ddl~1/Order Value \"3\""]),
        ("record deleted", "create static entity Status", "Order = 1), -- @r1\n  Fechado (Id = 2, Label = \"Fechado\", Order = 2); -- @r2", "Order = 1); -- @r1", ["delete @r2"]),
        ("records left out", "create static entity Status", ")\nvalues\n  Aberto (Id = 1, Label = \"Aberto\", Order = 1), -- @r1\n  Fechado (Id = 2, Label = \"Fechado\", Order = 2); -- @r2", ");", []),
        ("index unique", "/// Products", "create unique index UQ_Nome", "create index UQ_Nome", ["set @i1 Unique false"]),
        ("index columns", "/// Products", "(Nome); -- @i1", "(Nome, Preco); -- @i1", ["delete @i1", "create EntityIndex UQ_Nome in @e1"]),
        ("index added", "create entity Categoria", ");", ");\ncreate index IX_Nome on Categoria (Nome);", []),
        ("site property default", "site property Limite", "= 10", "= 20", ["set @p1 DefaultValue \"20\""]),
        ("timer", "timer Noturno", "schedule \"When Published\"", "schedule \"When Published\" timeout 5", ["set @tm1 TimeoutInMinutes \"5\""]),
        ("timer action", "timer Noturno", "action Recalcular", "action Fechar", ["set @tm1 Action \"IServerAction:Fechar\""]),
    }.Select(e => new object[] { e.Name, e.Start, e.From, e.To, e.Ops });

    [Theory]
    [MemberData(nameof(Edits))]
    public void EachEditIsTheOpsOfWhatChanged(string edit, string start, string from, string to, string[] expected)
    {
        var block = Block(start);
        Assert.Contains(from, block);
        var compiled = Compile(block.Replace(from, to));
        Assert.True(compiled.Problems.Count == 0, edit + ": " + string.Join("; ", compiled.Problems.Select(p => p.Code + " " + p.Message)));
        var ops = Ops(compiled);
        if (edit == "index added") { Assert.Single(ops); Assert.StartsWith("create EntityIndex IX_Nome in @e2", ops[0]); return; }
        Assert.Equal(expected, ops);
    }

    [Fact]
    public void NewElementsAreTheSpecAndTheRawVerbs()
    {
        var edit = """
            /// Reviews.
            create entity Avaliacao public label Comentario (
              Id Long Integer identifier auto required,
              ProdutoId Produto Identifier required references Produto on delete Delete,
              Nota Integer required default 5,
              Comentario Text(500) json "comment"
            );
            create unique index UQ_Avaliacao on Avaliacao (ProdutoId, Nota);
            create static entity Prioridade public (
              Id Integer identifier required,
              Label Text(50) required,
              Order Integer required
            )
            values
              Alta (Id = 1, Label = "Alta", Order = 1);
            type Resumo = {
              Total: Decimal(18,2) required;
            }
            site property MaxItens: Integer = 3
            timer Limpeza action Recalcular schedule "When Published" timeout 7
            """;
        var compiled = Compile(edit);
        Assert.Empty(compiled.Problems);
        var spec = compiled.Spec!;
        Assert.Equal("Avaliacao", spec["entities"]![0]!["name"]!.ToString());
        Assert.Equal("Comentario", spec["entities"]![0]!["labelAttribute"]!.ToString());
        Assert.Equal("comment", spec["entities"]![0]!["attributes"]![2]!["nameInJSON"]!.ToString());
        Assert.Equal("UQ_Avaliacao", spec["entities"]![0]!["indexes"]![0]!["name"]!.ToString());
        Assert.Equal(1, spec["static"]![0]!["records"]![0]!["id"]!.GetValue<int>());
        Assert.Equal(2, spec["structures"]![0]!["attributes"]![0]!["decimals"]!.GetValue<int>());
        var ops = Ops(compiled);
        Assert.Equal("spec entities:Avaliacao,static:Prioridade,structures:Resumo", ops[0]);
        Assert.Contains("create ISiteProperty MaxItens in @espace", ops);
        Assert.Contains("create ITimer Limpeza in @espace", ops);
        Assert.Contains(ops, o => o.StartsWith("set $ddl~", StringComparison.Ordinal) && o.EndsWith("Action \"IServerAction:Recalcular\"", StringComparison.Ordinal));
        // The spec takes the new keys of SpecExpander and nothing it would refuse.
        var expanded = SpecExpander.Expand(spec);
        Assert.Contains(expanded, op => op["prop"]?.ToString() == "NameInJSON" && op["value"]?.ToString() == "comment");
        Assert.Contains(expanded, op => op["prop"]?.ToString() == "Decimals" && op["value"]?.GetValue<int>() == 2);
        Assert.Contains(expanded, op => op["prop"]?.ToString() == "LabelAttribute" && op["value"]?.ToString() == "$Avaliacao.Comentario");
    }

    [Fact]
    public void ANameFreedByTheSameEditIsFreedFirst()
    {
        // Categoria becomes Grupo and a new Categoria comes: the rename runs before the spec that creates it.
        var edit = Block("create entity Categoria").Replace("create entity Categoria", "create entity Grupo") + "\n\ncreate entity Categoria (\n  Id Long Integer identifier auto required\n);";
        var compiled = Compile(edit);
        Assert.Empty(compiled.Problems);
        var ops = Ops(compiled);
        Assert.Equal("rename @e2 Grupo", ops[0]);
        Assert.StartsWith("spec entities:Categoria", ops[1]);
        // An attribute deleted and a new one under its name: the delete runs first.
        var attribute = Block("create entity Categoria").Replace("  Nome Text(50) -- @b2", "  Nome Integer");
        Assert.Equal(["delete @b2", "create IEntityAttribute Nome in @e2", "set $ddl~1 DataType \"Integer\""], Ops(Compile(attribute)));
    }

    [Fact]
    public void DropDeletesByKeyAndChecksTheName()
    {
        Assert.Equal(["delete @e2"], Ops(Compile("drop entity Categoria; -- @e2")));
        Assert.Equal(["delete @i1"], Ops(Compile("drop index UQ_Nome; -- @i1")));
        Assert.Equal(["delete @t1"], Ops(Compile("drop type Linha; -- @t1")));
        Assert.Equal(["delete @p1"], Ops(Compile("drop site property Limite -- @p1")));
        var wrong = Compile("drop entity Categorias; -- @e2");
        var problem = Assert.Single(wrong.Problems);
        Assert.Equal("DDL_DROP_NAME", problem.Code);
        Assert.Equal("drop entity Categoria; -- @e2", problem.Corrected);
        Assert.Equal("DDL_KIND_CHANGED", Assert.Single(Compile("drop type Categoria; -- @e2").Problems).Code);
    }

    [Fact]
    public void WhatTheTextCannotMeanIsRefusedOnceWithEveryProblemAndItsLine()
    {
        var edit = """
            create entity Produto public label Nomes ( -- @e1
              Id Long Integer identifier auto required, -- @a1
              Nome Text(120) required -- @zz
            );
            create entity Categoria ( -- @e2
              Id Long Integer identifier auto required -- @b1
            );
            create entity Linha ( -- @t1
              Id Long Integer identifier auto required -- @a1
            );
            create static entity Status public ( -- @s1
              Id Integer identifier required -- @c1
            )
            values
              Aberto (Id = 1, Cor = "red"); -- @r1
            """;
        var problems = Compile(edit).Problems;
        Assert.Contains(problems, p => p.Code == "DDL_NAME_UNKNOWN" && p.Line == 1 && p.Message.Contains("Nomes"));
        Assert.Contains(problems, p => p.Code == "DDL_KEY_FOREIGN" && p.Line == 3);
        Assert.Contains(problems, p => p.Code == "DDL_KIND_CHANGED" && p.Line == 8);
        Assert.Contains(problems, p => p.Code == "DDL_KEY_TWICE" && p.Line == 9);
        Assert.Contains(problems, p => p.Code == "DDL_NAME_UNKNOWN" && p.Line == 15 && p.Message.Contains("Cor"));
        // A new element under the name of an existing one: the fix names the key that edits it.
        var taken = Assert.Single(Compile("create entity categoria (\n  Id Long Integer identifier auto required\n);").Problems);
        Assert.Equal("DDL_NAME_TAKEN", taken.Code);
        Assert.Contains("-- @e2", taken.Fix);
        // A label that names an attribute by a near name: the corrected text is the patch.
        var near = Assert.Single(Compile(Block("/// Products").Replace("label Nome", "label Nomee")).Problems);
        Assert.Equal("DDL_NAME_UNKNOWN", near.Code);
        Assert.Contains("label Nome (", near.Corrected);
    }

    [Fact]
    public void TheGrammarOfTheWayBackIsClosed()
    {
        Assert.True(DdlParser.Parse("drop entity X; -- @k", "odc").Elements.Single() is { Drop: true, Kind: "ServerEntity", Name: "X", Key: "k" });
        Assert.Equal("StaticEntityRecord", DdlParser.Parse("create static entity S ( -- @s\n  Id Integer identifier required -- @c\n)\nvalues\n  A (Id = 1); -- @r", "odc").All().Last().Kind);
        foreach (var (text, message) in new[] {
            ("drop entity X;", "drop names its element by its key"),
            ("drop table X; -- @k", "drop takes"),
            ("/// note\ndrop entity X; -- @k", "a description (///) before drop") }) {
            var error = Assert.ThrowsAny<FormatException>(() => DdlParser.Parse(text, "o11"));
            Assert.Contains(message, error.Message);
        }
    }

    [Fact]
    public void TheSpecOpTakesTheTextAndTheNewKeys()
    {
        // The text alone (with basedOn); JSON sections next to it are refused, and so is a key the spec does not have.
        Assert.Throws<InvalidOperationException>(() => SpecExpander.Expand(new JsonObject { ["ddl"] = "type T = {\n  A: Text;\n}", ["entities"] = new JsonArray() }));
        var created = SpecExpander.Expand(new JsonObject { ["ddl"] = "type T public = {\n  A: Decimal(10,3) json \"a\";\n}", ["basedOn"] = "ab", ["_why"] = "note" });
        Assert.Contains(created, op => op["op"]?.ToString() == "create" && op["name"]?.ToString() == "T");
        Assert.Contains(created, op => op["prop"]?.ToString() == "Decimals");
        // A text that does not parse is refused with every problem, each with the pointer of the text and its line.
        var refusal = Assert.Throws<KernelRefusalException>(() => SpecExpander.Expand(new JsonObject { ["ddl"] = "create entity X shiny (\n);\ntype Y = {\n  A: Text\n}" }));
        Assert.Equal("DDL_SYNTAX", refusal.Code);
        Assert.Equal([1, 4], refusal.Problems!.Select(p => p!["line"]!.GetValue<int>()));
        Assert.All(refusal.Problems!, p => Assert.Equal("/ddl", p!["pointer"]!.ToString()));
        // The static checks read what the text creates: its new types and every name it writes.
        var data = new JsonObject { ["ddl"] = "create entity Pedido (\n  Id Long Integer identifier auto required,\n  Total Decimal(18,2)\n);" };
        Assert.Equal("Pedido", SpecExpander.Sections(data)["entities"]![0]!["name"]!.ToString());
        Assert.Contains("Total", SpecExpander.DdlNames(data));
        // The JSON form keeps its keys, with the new ones.
        var json = SpecExpander.Expand(new JsonObject { ["static"] = new JsonArray(new JsonObject { ["name"] = "S", ["folder"] = "Quotes", ["restrictedInQueries"] = true,
            ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Is_Active", ["type"] = "Boolean" }), ["activeAttribute"] = "Is_Active" }) });
        Assert.Contains(json, op => op["op"]?.ToString() == "move" && op["into"]?.ToString() == "folder:Quotes");
        Assert.Contains(json, op => op["prop"]?.ToString() == "IsActiveAttribute" && op["value"]?.ToString() == "$S.Is_Active");
        Assert.Contains(json, op => op["prop"]?.ToString() == "IsRestrictedInQueries" && op["value"]?.GetValue<bool>() == true);
    }

    [Fact]
    public void AJobWithABrokenTextIsRefusedByThePreflightWithItsLines()
    {
        var job = new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "create entity X shiny (\n);\ntype Y = {\n  A: Text\n}" } });
        var result = JobPreflight.Analyze(job, new JsonObject { ["ops"] = job.DeepClone() });
        Assert.False(result["valid"]!.GetValue<bool>());
        var problems = result["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(2, problems.Count(p => p["code"]?.ToString() == "DDL_SYNTAX"));
        Assert.All(problems.Where(p => p["code"]?.ToString() == "DDL_SYNTAX"), p => Assert.Equal("/ops/0/data/ddl", p["pointer"]!.ToString()));
    }
}
