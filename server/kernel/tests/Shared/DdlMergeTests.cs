using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the three-way merge of the data text (DdlMerge), without the Studio. Statements written on
// an older read (base) are merged with the module's text now (theirs, changed in the Studio since) by @key, and the merged
// edit compiled against the module now (DdlCompiler) writes only what the delivery changed: an attribute or record the
// Studio added after the read stays although the statement does not have it (compiled alone, the statement deletes it), a
// change of the same element on both sides keeps the delivery's version and is listed, an element the delivery left out that
// the Studio changed is deleted and listed, one the Studio removed that the delivery changed is created again and listed,
// what the Studio renamed is read in its new name, and without the read nothing left out is deleted. The real modules are
// the merge battery (MergeBatteryCorpus).
public sealed class DdlMergeTests
{
    private const string Read = """
        -- ssam-ddl/1 module=Shop lane=o11 key=@m sourceSha256=ab elements=20

        /// Products of the catalog.
        create entity Produto public label Nome ( -- @e1
          Id Long Integer identifier auto required, -- @a1
          CategoriaId Categoria Identifier required references Categoria on delete Protect, -- @a2
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
        """;

    private static string Text(string text) => text.Replace("\r\n", "\n");
    private static string Block(string text, string start)
    {
        text = Text(text);
        var at = text.IndexOf(start, StringComparison.Ordinal);
        var end = text.IndexOf("\n\n", at, StringComparison.Ordinal);
        return text[at..(end < 0 ? text.Length : end)];
    }

    // The Studio's change: the read with lines replaced.
    private static string Studio(params (string From, string To)[] changes)
    {
        var text = Text(Read);
        foreach (var (from, to) in changes) { Assert.Contains(from, text); text = text.Replace(from, to); }
        return text;
    }

    private static DdlMerge.Result Merge(string theirs, string edit) =>
        DdlMerge.ThreeWay(DdlParser.Parse(Text(Read)), DdlParser.Parse(theirs), DdlParser.Parse(Text(edit), "o11"), "o11");

    private static List<string> Ops(DdlMerge.Result merged, string theirs, string edit)
    {
        var compiled = DdlCompiler.Compile(merged.Edit, DdlParser.Parse(theirs), "o11", "$ddl", Text(edit));
        Assert.True(compiled.Problems.Count == 0, string.Join("; ", compiled.Problems.Select(p => p.Code + " " + p.Message)));
        return Describe(compiled);
    }

    private static List<string> Describe(DdlCompilation compiled) => compiled.Ops().Select(o => o.Op).Select(op => op["op"]!.ToString() switch {
        "set" => $"set {op["target"]} {op["prop"]} {op["value"]?.ToJsonString() ?? "null"}",
        "rename" => $"rename {op["target"]} {op["name"]}",
        "create" => $"create {op["type"]} {op["name"]} in {op["parent"]}",
        "delete" => $"delete {op["target"]}",
        "move" => $"move {op["target"]} " + (op["into"] != null ? "into " + op["into"] : op["after"] != null ? "after " + op["after"] : "first"),
        var verb => verb }).ToList();

    private static List<string> Alone(string theirs, string edit) => Describe(DdlCompiler.Compile(DdlParser.Parse(Text(edit), "o11"), DdlParser.Parse(theirs), "o11", "$ddl", Text(edit)));

    [Fact]
    public void AnAttributeTheStudioAddedStaysWhenTheStatementDoesNotHaveIt()
    {
        var theirs = Studio(("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer default 0 -- @a6"));
        var edit = Block(Read, "/// Products").Replace("Nome Text(120)", "Nome Text(200)");
        // Compiled alone against the module now (the behaviour before the merge), the statement would delete it.
        Assert.Contains("delete @a6", Alone(theirs, edit));
        var merged = Merge(theirs, edit);
        Assert.Empty(merged.Conflicts);
        Assert.Contains("Produto.Estoque", merged.Kept);
        Assert.Equal(["set @a3 Length \"200\""], Ops(merged, theirs, edit));
    }

    [Fact]
    public void TheSamePropertyChangedOnBothSidesKeepsTheDeliverysAndIsListed()
    {
        var theirs = Studio(("Nome Text(120) required, -- @a3", "Nome Text(150) required, -- @a3"));
        var edit = Block(Read, "/// Products").Replace("Nome Text(120)", "Nome Text(200)");
        var merged = Merge(theirs, edit);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("a3", conflict["key"]!.ToString());
        Assert.Equal("type", conflict["what"]!.ToString());
        Assert.Equal("Text(150)", conflict["studio"]!.ToString());
        Assert.Equal("Text(200)", conflict["delivered"]!.ToString());
        Assert.Equal("delivery", conflict["kept"]!.ToString());
        Assert.Equal(["set @a3 Length \"200\""], Ops(merged, theirs, edit));
        // A change only the Studio made, in a statement the delivery sends for another reason, stays.
        var other = Block(Read, "/// Products").Replace("Preco Decimal(18,2) default 0", "Preco Decimal(18,2) default 1");
        var kept = Merge(theirs, other);
        Assert.Empty(kept.Conflicts);
        Assert.Equal(["set @a4 DefaultValue \"1\""], Ops(kept, theirs, other));
    }

    [Fact]
    public void AnAttributeTheDeliveryLeftOutIsDeletedAndListedWhenTheStudioChangedIt()
    {
        var theirs = Studio(("Preco Decimal(18,2) default 0, -- @a4", "Preco Decimal(18,2) default 1, -- @a4"));
        var edit = Block(Read, "/// Products").Replace("  Preco Decimal(18,2) default 0, -- @a4\n", "");
        var merged = Merge(theirs, edit);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("a4", conflict["key"]!.ToString());
        Assert.Equal("removed by the delivery", conflict["what"]!.ToString());
        Assert.Equal(["delete @a4"], Ops(merged, theirs, edit));
        // Unchanged in the Studio: deleted, nothing listed.
        var quiet = Merge(Text(Read), edit);
        Assert.Empty(quiet.Conflicts);
        Assert.Equal(["delete @a4"], Ops(quiet, Text(Read), edit));
    }

    [Fact]
    public void AnAttributeTheStudioRemovedThatTheDeliveryChangedIsCreatedAgainAndListed()
    {
        var theirs = Studio(("  Preco Decimal(18,2) default 0, -- @a4\n", ""));
        var edit = Block(Read, "/// Products").Replace("Preco Decimal(18,2) default 0", "Preco Decimal(18,2) default 2");
        var merged = Merge(theirs, edit);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("removed in the Studio", conflict["what"]!.ToString());
        var ops = Ops(merged, theirs, edit);
        Assert.Contains("create IEntityAttribute Preco in @e1", ops);
        Assert.Contains(ops, o => o.EndsWith("DefaultValue \"2\"", StringComparison.Ordinal));
        // Unchanged by the delivery: it stays removed (nothing created, nothing listed).
        var untouched = Merge(theirs, Block(Read, "/// Products").Replace("Nome Text(120)", "Nome Text(121)"));
        Assert.Empty(untouched.Conflicts);
        Assert.DoesNotContain(untouched.Edit.All(), e => e.Name == "Preco");
    }

    [Fact]
    public void ARecordTheStudioAddedStaysWhenTheStatementSendsItsValues()
    {
        var theirs = Studio(("  Fechado (Id = 2, Label = \"Fechado\", Order = 2); -- @r2", "  Fechado (Id = 2, Label = \"Fechado\", Order = 2), -- @r2\n  Cancelado (Id = 3, Label = \"Cancelado\", Order = 3); -- @r3"));
        var edit = Block(Read, "create static entity Status").Replace("Label = \"Fechado\"", "Label = \"Encerrado\"");
        Assert.Contains("delete @r3", Alone(theirs, edit));
        var merged = Merge(theirs, edit);
        Assert.Empty(merged.Conflicts);
        Assert.Equal(["set @r2/Label Value \"\\u0022Encerrado\\u0022\""], Ops(merged, theirs, edit));
        // The same value on both sides: the delivery's, listed by the record's key.
        var both = Studio(("Label = \"Fechado\"", "Label = \"Terminado\""));
        var clash = Merge(both, edit);
        Assert.Equal("r2", Assert.Single(clash.Conflicts)["key"]!.ToString());
        Assert.Equal(["set @r2/Label Value \"\\u0022Encerrado\\u0022\""], Ops(clash, both, edit));
    }

    [Fact]
    public void WhatTheStudioRenamedIsReadInItsNewName()
    {
        // The Studio renamed Nome to Titulo (and the platform rewrote the label and the index); the statement, written on
        // the read, still says Nome and changes Preco.
        var theirs = Studio(("label Nome ( -- @e1", "label Titulo ( -- @e1"), ("  Nome Text(120) required, -- @a3", "  Titulo Text(120) required, -- @a3"),
            ("UQ_Nome on Produto (Nome)", "UQ_Nome on Produto (Titulo)"));
        var edit = Block(Read, "/// Products").Replace("Preco Decimal(18,2) default 0", "Preco Decimal(18,2) default 3");
        // Alone, the statement renames it back.
        Assert.Contains("rename @a3 Nome", Alone(theirs, edit));
        var merged = Merge(theirs, edit);
        Assert.Empty(merged.Conflicts);
        Assert.Equal(["set @a4 DefaultValue \"3\""], Ops(merged, theirs, edit));
        // The Studio renamed the entity Categoria to Grupo: a new attribute that names it by the old name reads the new one.
        var renamedType = Studio(("create entity Categoria public ( -- @e2", "create entity Grupo public ( -- @e2"),
            ("CategoriaId Categoria Identifier required references Categoria", "CategoriaId Grupo Identifier required references Grupo"));
        var added = Block(Read, "create entity Categoria").Replace("  Nome Text(50) -- @b2", "  Nome Text(50), -- @b2\n  PaiId Categoria Identifier references Categoria on delete Ignore");
        var typed = Merge(renamedType, added);
        Assert.Empty(typed.Conflicts);
        var ops = Ops(typed, renamedType, added);
        Assert.Contains(ops, o => o.EndsWith("DataType \"Grupo Identifier\"", StringComparison.Ordinal));
        Assert.DoesNotContain(ops, o => o.StartsWith("rename @e2", StringComparison.Ordinal));
    }

    [Fact]
    public void ADropOfWhatTheStudioChangedIsListedAndOfWhatItRemovedIsNothing()
    {
        var theirs = Studio(("  Nome: Text(80) json \"nome\"; -- @t1b", "  Nome: Text(90) json \"nome\"; -- @t1b"));
        var merged = Merge(theirs, "drop type Linha; -- @t1");
        Assert.Equal("t1", Assert.Single(merged.Conflicts)["key"]!.ToString());
        Assert.Equal(["delete @t1"], Ops(merged, theirs, "drop type Linha; -- @t1"));
        var gone = Studio(("type Linha public = { -- @t1\n  Qtd: Integer; -- @t1a\n  Nome: Text(80) json \"nome\"; -- @t1b\n}\n\n", ""));
        var nothing = Merge(gone, "drop type Linha; -- @t1");
        Assert.Empty(nothing.Conflicts);
        Assert.Single(nothing.Notes);
        Assert.Empty(nothing.Edit.Elements);
    }

    [Fact]
    public void ANewStatementNamedLikeWhatTheStudioCreatedEditsIt()
    {
        var theirs = Text(Read) + "\n\ncreate entity Cupom ( -- @e9\n  Id Long Integer identifier auto required, -- @g1\n  Codigo Text(20) -- @g2\n);";
        var edit = "create entity Cupom (\n  Id Long Integer identifier auto required,\n  Codigo Text(30),\n  Valor Decimal(18,2)\n);";
        var merged = Merge(theirs, edit);
        Assert.Equal("e9", Assert.Single(merged.Conflicts)["key"]!.ToString());
        var ops = Ops(merged, theirs, edit);
        Assert.Contains("set @g2 Length \"30\"", ops);
        Assert.Contains("create IEntityAttribute Valor in @e9", ops);
        Assert.DoesNotContain(ops, o => o.StartsWith("delete", StringComparison.Ordinal) || o.StartsWith("spec", StringComparison.Ordinal));
    }

    // Without the read (another store, a trimmed store, an older read), a statement that differs from the module now cannot
    // tell what the Studio changed since from what the statement changes: refused, with the current declaration as the patch;
    // one that says what the module says changes nothing and goes.
    [Fact]
    public void WithoutTheReadAStatementThatDiffersFromTheModuleIsRefused()
    {
        var theirs = DdlParser.Parse(Studio(("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer -- @a6")));
        var edit = DdlParser.Parse(Block(Read, "/// Products").Replace("Nome Text(120)", "Nome Text(200)"), "o11");
        var problems = DdlMerge.WithoutRead(theirs, edit, "abc", "o11");
        var problem = Assert.Single(problems);
        Assert.Equal("DDL_BASE_UNKNOWN", problem.Code);
        Assert.Contains("Estoque", problem.Message);
        // A statement that only changes a property is refused too: the Studio may have changed it since (D1 of the review).
        var renamed = DdlParser.Parse(Studio(("Nome Text(120) required, -- @a3", "Titulo Text(150) required, -- @a3"), ("label Nome ( -- @e1", "label Titulo ( -- @e1"),
            ("UQ_Nome on Produto (Nome)", "UQ_Nome on Produto (Titulo)")));
        var preco = DdlParser.Parse(Block(Read, "/// Products").Replace("Preco Decimal(18,2) default 0", "Preco Decimal(18,2) default 3"), "o11");
        var refused = Assert.Single(DdlMerge.WithoutRead(renamed, preco, "abc", "o11"));
        Assert.Equal("DDL_BASE_UNKNOWN", refused.Code);
        Assert.Contains("Titulo Text(150)", refused.Corrected ?? "");
        var whole = DdlParser.Parse(Block(Read, "create entity Categoria").Replace("Text(50)", "Text(60)"), "o11");
        Assert.Single(DdlMerge.WithoutRead(theirs, whole, "abc", "o11"));
        // The statement as the module has it now: nothing to refuse.
        Assert.Empty(DdlMerge.WithoutRead(theirs, DdlParser.Parse(Block(Read, "create entity Categoria"), "o11"), "abc", "o11"));
    }

    // ---- review of the junction feat/texto-ssam-2 ----------------------------------------------------------------------------

    // The problems of a merge (DdlMerge.Result.Problems, read by name: what the merge refuses instead of compiling).
    private static List<DdlProblem> Problems(DdlMerge.Result merged) =>
        typeof(DdlMerge.Result).GetField("Problems")?.GetValue(merged) as List<DdlProblem> ?? [];

    // A statement with the key of an element the read does not have (created after it, by a job whose receipt gave the keys)
    // is never compiled as sent against the module now: what the Studio changed in that element since cannot be told from
    // what the statement changes, so a statement that differs from the module is refused with the current declaration.
    [Fact]
    public void AStatementOfAnElementTheReadDoesNotHaveIsRefusedNeverCompiledAsSent()
    {
        var theirs = Text(Read) + "\n\ncreate entity Cupom ( -- @e9\n  Id Long Integer identifier auto required, -- @g1\n  Codigo Text(20), -- @g2\n  Desconto Integer -- @g3\n);";
        var edit = "create entity Cupom ( -- @e9\n  Id Long Integer identifier auto required, -- @g1\n  Codigo Text(30) -- @g2\n);";
        Assert.Contains("delete @g3", Alone(theirs, edit));
        var merged = Merge(theirs, edit);
        var problem = Assert.Single(Problems(merged));
        Assert.Equal("DDL_BASE_UNKNOWN", problem.Code);
        Assert.Contains("Desconto", problem.Message);
        Assert.Contains("Desconto Integer -- @g3", problem.Corrected ?? "");
        // An attribute the read does not have, in a statement the read has: the same rule.
        var theirs2 = Studio(("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer default 0 -- @a6"));
        var edit2 = Block(Read, "/// Products").Replace("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer default 5 -- @a6");
        Assert.Contains(Problems(Merge(theirs2, edit2)), p => p.Code == "DDL_BASE_UNKNOWN" && p.Message.Contains("Estoque", StringComparison.Ordinal));
    }

    // Two elements of one name from the two sides: both added an attribute (or a record) of that name: one element, the
    // delivery's values, listed; the delivery renamed an attribute onto the name of one the Studio added: refused.
    [Fact]
    public void ANameBothSidesGiveIsOneElementOrRefused()
    {
        var theirs = Studio(("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer default 0 -- @a6"));
        var edit = Block(Read, "/// Products").Replace("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer default 5");
        var merged = Merge(theirs, edit);
        Assert.Empty(Problems(merged));
        Assert.Contains(merged.Conflicts, c => c["key"]!.ToString() == "a6");
        var ops = Ops(merged, theirs, edit);
        Assert.DoesNotContain(ops, o => o.StartsWith("create", StringComparison.Ordinal));
        Assert.Contains("set @a6 DefaultValue \"5\"", ops);
        var records = Studio(("  Fechado (Id = 2, Label = \"Fechado\", Order = 2); -- @r2", "  Fechado (Id = 2, Label = \"Fechado\", Order = 2), -- @r2\n  Cancelado (Id = 3, Label = \"Cancelado\", Order = 3); -- @r3"));
        var mine = Block(Read, "create static entity Status").Replace("  Fechado (Id = 2, Label = \"Fechado\", Order = 2); -- @r2",
            "  Fechado (Id = 2, Label = \"Fechado\", Order = 2), -- @r2\n  Cancelado (Id = 4, Label = \"Cancelado!\", Order = 4);");
        var one = Merge(records, mine);
        Assert.Empty(Problems(one));
        Assert.Contains(one.Conflicts, c => c["key"]!.ToString() == "r3");
        Assert.DoesNotContain(Ops(one, records, mine), o => o.StartsWith("create", StringComparison.Ordinal));
        var valor = Studio(("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Valor Decimal(18,2) -- @a6"));
        var renamed = Block(Read, "/// Products").Replace("Preco Decimal(18,2) default 0, -- @a4", "Valor Decimal(18,2) default 0, -- @a4");
        Assert.Contains(Problems(Merge(valor, renamed)), p => p.Code == "DDL_MERGE_NAME_TAKEN" && p.Message.Contains("Valor", StringComparison.Ordinal));
    }

    // Corrigir 2 (review r2, D1): a drop of an element the read does not have (created after it, its key from a receipt) that
    // the Studio changed since is held to the rule without a read, as the same drop without the read is: refused with its
    // declaration now, never dropped with nothing listed.
    [Fact]
    public void ADropOfAnElementCreatedAfterTheReadIsRefusedAsWithoutTheRead()
    {
        var theirs = Text(Read) + "\n\ncreate entity Cupom ( -- @e9\n  Id Long Integer identifier auto required, -- @g1\n  Codigo Text(20), -- @g2\n  Desconto Decimal(18,2) -- @g3\n);";
        var edit = "drop entity Cupom; -- @e9";
        var merged = Merge(theirs, edit);
        var problem = Assert.Single(Problems(merged));
        Assert.Equal("DDL_BASE_UNKNOWN", problem.Code);
        Assert.Contains("Cupom", problem.Message);
        Assert.Contains("Desconto Decimal(18,2) -- @g3", problem.Corrected ?? "");
        Assert.DoesNotContain(merged.Edit.Elements, e => e.Drop);
        Assert.NotEmpty(DdlMerge.WithoutRead(DdlParser.Parse(theirs), DdlParser.Parse(edit, "o11"), "ff", "o11"));
        // A drop of an element of the read stays a drop (listed when the Studio changed it).
        Assert.Contains(Merge(Text(Read), "drop entity Categoria; -- @e2").Edit.Elements, e => e.Drop);
    }

    [Fact]
    public void TheStatementsAsReadMergeIntoNothingToWrite()
    {
        var theirs = Studio(("Nome Text(120) required, -- @a3", "Nome Text(150) required, -- @a3"),
            ("  Ativo Boolean required default True -- @a5", "  Ativo Boolean required default True, -- @a5\n  Estoque Integer -- @a6"));
        foreach (var start in new[] { "/// Products", "create entity Categoria", "create static entity Status", "type Linha", "site property Limite" }) {
            var merged = Merge(theirs, Block(Read, start));
            Assert.Empty(merged.Conflicts);
            Assert.Empty(Ops(merged, theirs, Block(Read, start)));
        }
    }
}
