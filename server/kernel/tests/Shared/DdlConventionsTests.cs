using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: what the platform fills by itself for an entity has one meaning in the data text whether
// the text writes it or not (DdlConventions, run before any round of the way back, so every round compiles the same text).
// Without the Studio: the identifier is required, a static entity's identifier is never AutoNumber, a static record's value
// the text leaves out keeps the module's (kept record) or takes the platform's fill (identifier: next free integer; label:
// the record's name; order: its position; a required attribute: its default), a required value with none is refused with
// its line, an index on a static entity is checked against the records and left out; and a static entity's Label or Order
// left out of a kept statement is refused with its line as the patch when the records have values of it (`order none` deletes
// it, the link first, before the delete). Both lanes. The real modules and the session of
// 2026-10-12 (VisitaCerta_CS, jobs #15/#16/#19) are DdlConventionsNativeTests.
public sealed class DdlConventionsTests
{
    private const string Base = """
        -- ssam-ddl/1 module=Shop lane=o11 key=@m sourceSha256=ab elements=14

        create entity Categoria public ( -- @e2
          Id Long Integer identifier auto required, -- @b1
          Nome Text(50) -- @b2
        );

        create static entity Status public ( -- @s1
          Id Integer identifier required, -- @c1
          Label Text(50) required, -- @c2
          Order Integer required, -- @c3
          Cor Text(20) -- @c4
        )
        values
          Aberto (Id = 1, Label = "Aberto", Order = 1, Cor = "red"), -- @r1
          Fechado (Id = 2, Label = "Fechado", Order = 2); -- @r2

        create static entity Legado ( -- @s2
          Id Integer identifier auto required, -- @d1
          Label Text(50), -- @d2
          Order Integer -- @d3
        )
        values
          Um (Label = "Um", Order = 1), -- @q1
          Dois (Label = "Dois", Order = 2); -- @q2
        """;

    private static (DdlDocument Edit, DdlConventions.Result Result) Normalize(string text, string lane = "o11", bool module = true)
    {
        var edit = DdlParser.Parse(text, lane);
        return (edit, DdlConventions.Apply(edit, module ? DdlParser.Parse(Base.Replace("lane=o11", "lane=" + lane)) : null));
    }

    private static DdlElement Entity(DdlDocument edit, string name) => edit.Elements.First(e => e.Name == name);
    private static Dictionary<string, string> Values(DdlDocument edit, string entity, string record) =>
        Entity(edit, entity).Children.First(c => c.Name == record && c.Kind is "Record" or "StaticEntityRecord").Values.ToDictionary(v => v.Attribute, v => v.Value);
    // A record's values as one line, by attribute name: "Id=1, Label=""A""".
    private static string Row(DdlDocument edit, string entity, string record) =>
        string.Join(", ", Values(edit, entity, record).OrderBy(v => v.Key, StringComparer.Ordinal).Select(v => v.Key + "=" + v.Value));

    private static List<string> Ops(DdlDocument edit, string lane = "o11") =>
        DdlCompiler.Compile(edit, DdlParser.Parse(Base.Replace("lane=o11", "lane=" + lane)), lane, "$ddl", "").Ops().Select(o => o.Op).Select(op => op["op"]!.ToString() switch {
            "set" => $"set {op["target"]} {op["prop"]} {op["value"]?.ToJsonString() ?? "null"}",
            "delete" => $"delete {op["target"]}",
            "create" => $"create {op["type"]} {op["name"]} in {op["parent"]}",
            "spec" => "spec",
            var verb => verb }).ToList();

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void TheModuleTextIsAlreadyItsOwnConvention(string lane)
    {
        // A text as read has every value the platform filled: nothing to fill, nothing to compile.
        foreach (var start in new[] { "create entity Categoria", "create static entity Status", "create static entity Legado" }) {
            var text = Base.Replace("\r\n", "\n");
            var at = text.IndexOf(start, StringComparison.Ordinal);
            var end = text.IndexOf("\n\n", at, StringComparison.Ordinal);
            var (edit, result) = Normalize(text[at..(end < 0 ? text.Length : end)], lane);
            Assert.Empty(result.Notes);
            Assert.Empty(result.Problems);
            Assert.Empty(Ops(edit, lane));
        }
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void ANewStaticEntityGetsWhatThePlatformFillsWhenTheTextLeavesItOut(string lane)
    {
        // No `Id =`, no Order values, one Label left out, one Id given (taken: the others skip it).
        var (edit, result) = Normalize("""
            create static entity Condicao public (
              Id Integer identifier required,
              Codigo Integer required,
              Label Text(120) required,
              Order Integer
            )
            values
              Ceu (Codigo = 0, Label = "Céu aberto"),
              Nublado (Id = 1, Codigo = 3),
              Chuva (Codigo = 61, Label = "Chuva", Order = 9);
            """, lane);
        Assert.Empty(result.Problems);
        Assert.Equal("Codigo=0, Id=2, Label=\"Céu aberto\", Order=1", Row(edit, "Condicao", "Ceu"));
        Assert.Equal("Codigo=3, Id=1, Label=\"Nublado\", Order=2", Row(edit, "Condicao", "Nublado"));
        Assert.Equal("Codigo=61, Id=3, Label=\"Chuva\", Order=9", Row(edit, "Condicao", "Chuva"));
        var note = Assert.Single(result.Notes);
        Assert.Equal("DDL_STATIC_VALUE_FILLED", note.Code);
        Assert.Contains("Ceu.Id = 2", note.Message);
        // The spec takes the filled ids as its own (plain ids), so no round writes another value.
        var spec = DdlCompiler.Compile(edit, null, lane).Spec!;
        Assert.Equal([2, 1, 3], spec["static"]![0]!["records"]!.AsArray().Select(r => r!["id"]!.GetValue<int>()));
        // The static checks of a job see the same values (no module needed for a new statement).
        var (alone, staticCheck) = Normalize(edit.Text!, lane, module: false);
        Assert.Equal(Row(edit, "Condicao", "Ceu"), Row(alone, "Condicao", "Ceu"));
        Assert.Single(staticCheck.Notes);
    }

    [Fact]
    public void TheSessionTextsOf20261012MeanWhatTheModelMeant()
    {
        // #15: no Order attribute (the spec creates it and deletes it: DataContract counts the values that went with it as
        // kept proof, DataContractIdentityScenarios); #16: the same records without `Id =`.
        var records = string.Join(",\n", Enumerable.Range(0, 28).Select(i => $"  WMO{i} (WmoCode = {i}, Label = \"L{i}\", ScorePenalty = {i % 7})")) + ";";
        var (edit, result) = Normalize("create static entity CondicaoMeteorologica public (\n  Id Integer identifier required,\n  WmoCode Integer required,\n"
            + "  Label Text(120) required,\n  ScorePenalty Integer required\n)\nvalues\n" + records);
        Assert.Empty(result.Problems);
        Assert.Equal(Enumerable.Range(1, 28).Select(i => i.ToString()), Entity(edit, "CondicaoMeteorologica").Children.Where(c => c.Kind == "Record").Select(r => r.Values.First(v => v.Attribute == "Id").Value));
        Assert.Contains("28 value(s)", Assert.Single(result.Notes).Message);
        // Nothing for the Order the text does not have.
        Assert.DoesNotContain(Entity(edit, "CondicaoMeteorologica").Children.SelectMany(c => c.Values), v => v.Attribute == "Order");
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void TheLabelAndOrderAreTheAttributesTheEntityNames(string lane)
    {
        // `label Nome`: Nome is the label (the record's name); no attribute is the order.
        var (edit, result) = Normalize("create static entity Tipo label Nome (\n  Id Integer identifier required,\n  Nome Text(5),\n  Peso Integer\n)\nvalues\n  Grande (Id = 1),\n  P (Id = 2, Nome = \"p\");", lane);
        Assert.Empty(result.Problems);
        Assert.Equal("Id=1, Nome=\"Grand\"", Row(edit, "Tipo", "Grande"));   // within Text(5)
        Assert.Equal("Id=2, Nome=\"p\"", Row(edit, "Tipo", "P"));
        // A Text identifier has no number to take: it is left as written (required: refused once, with the line).
        var (text, refused) = Normalize("create static entity Sigla (\n  Id Text(3) identifier required,\n  Label Text(50)\n)\nvalues\n  Norte (Label = \"N\"),\n  Sul (Id = \"S\");", lane);
        var problem = Assert.Single(refused.Problems);
        Assert.Equal(("DDL_VALUE_REQUIRED", 6), (problem.Code, problem.Line));
        Assert.Equal("\"Sul\"", Values(text, "Sigla", "Sul")["Label"]);
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void AStaticIdentifierIsNeverAutoNumberUnlessTheModuleHasItSo(string lane)
    {
        var (edit, result) = Normalize("create static entity Novo (\n  Id Integer identifier auto required,\n  Label Text(50)\n)\nvalues\n  A (Label = \"a\"),\n  B (Label = \"b\");", lane);
        Assert.False(Entity(edit, "Novo").Children[0].Props.ContainsKey("IsAutoNumber"));
        Assert.Equal(["DDL_STATIC_ID_NOT_AUTO", "DDL_STATIC_VALUE_FILLED"], result.Notes.Select(n => n.Code));
        Assert.Equal("2", Values(edit, "Novo", "B")["Id"]);
        // A module made before the rule (O11) keeps its AutoNumber identifier: its records have no value of it, a new one none.
        var legado = Base.Replace("\r\n", "\n");
        var block = legado[legado.IndexOf("create static entity Legado", StringComparison.Ordinal)..].Replace("Dois (Label = \"Dois\", Order = 2); -- @q2", "Dois (Label = \"Dois\", Order = 2), -- @q2\n  Tres ();");
        var (kept, keptResult) = Normalize(block, lane);
        Assert.Equal("Yes", Entity(kept, "Legado").Children[0].Props["IsAutoNumber"]);
        Assert.Equal("Label=\"Tres\", Order=3", Row(kept, "Legado", "Tres"));
        Assert.Equal(["DDL_STATIC_VALUE_FILLED"], keptResult.Notes.Select(n => n.Code));
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void AnIdentifierIsAlwaysRequired(string lane)
    {
        // New: an entity, a client entity and a static entity written without `required` on the identifier.
        var (edit, result) = Normalize("create entity Pedido (\n  Id Long Integer identifier auto,\n  Total Decimal(18,2)\n);\ncreate client entity Rascunho (\n  Id Long Integer identifier,\n  Texto Text\n);\n"
            + "create static entity Fase (\n  Id Integer identifier,\n  Label Text(50)\n)\nvalues\n  Inicio (Id = 1, Label = \"Início\");", lane);
        Assert.All(new[] { "Pedido", "Rascunho", "Fase" }, name => Assert.Equal("True", Entity(edit, name).Children[0].Props["IsMandatory"]));
        Assert.Equal(3, result.Notes.Count(n => n.Code == "DDL_IDENTIFIER_REQUIRED"));
        // Kept: what the module has (required), never cleared by an edit that leaves the word out.
        var (kept, keptResult) = Normalize("create entity Categoria public ( -- @e2\n  Id Long Integer identifier auto, -- @b1\n  Nome Text(50) -- @b2\n);", lane);
        Assert.Equal("True", Entity(kept, "Categoria").Children[0].Props["IsMandatory"]);
        Assert.Single(keptResult.Notes);
        Assert.Empty(Ops(kept, lane));
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void AKeptRecordKeepsWhatTheModuleHasAndANewOneTakesTheNextValues(string lane)
    {
        var (edit, result) = Normalize("""
            create static entity Status public ( -- @s1
              Id Integer identifier required, -- @c1
              Label Text(50) required, -- @c2
              Order Integer required, -- @c3
              Cor Text(20) -- @c4
            )
            values
              Aberto (Cor = "red"), -- @r1
              Fechado (Id = 2), -- @r2
              Cancelado (Cor = "gray");
            """, lane);
        Assert.Empty(result.Problems);
        Assert.Equal("Cor=\"red\", Id=1, Label=\"Aberto\", Order=1", Row(edit, "Status", "Aberto"));
        // A value the text leaves out that is not the platform's (Cor) stays out: the text clears it, as it says.
        Assert.Equal("Id=2, Label=\"Fechado\", Order=2", Row(edit, "Status", "Fechado"));
        // The new record: the next free id (the module's 1 and 2 are taken), its name, its position.
        Assert.Equal("Cor=\"gray\", Id=3, Label=\"Cancelado\", Order=3", Row(edit, "Status", "Cancelado"));
        Assert.Equal(["DDL_STATIC_VALUE_FILLED", "DDL_STATIC_VALUE_KEPT"], result.Notes.Select(n => n.Code));
        // Compiled: only the new record (nothing cleared on the kept ones).
        var ops = Ops(edit, lane);
        Assert.Equal("create IRecord Cancelado in @s1", ops[0]);
        Assert.DoesNotContain(ops, o => o.StartsWith("set @r", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void ARequiredValueTakesItsDefaultOrIsRefusedOnceWithEveryRecord(string lane)
    {
        // A new required attribute of a kept static entity: with a default, every record takes it; without, each record is a
        // problem with its line, all in one refusal.
        var head = "create static entity Status public ( -- @s1\n  Id Integer identifier required, -- @c1\n  Label Text(50) required, -- @c2\n  Order Integer required, -- @c3\n  Cor Text(20), -- @c4\n";
        var records = ")\nvalues\n  Aberto (Id = 1, Label = \"Aberto\", Order = 1, Cor = \"red\"), -- @r1\n  Fechado (Id = 2, Label = \"Fechado\", Order = 2); -- @r2";
        var (edit, result) = Normalize(head + "  Peso Integer required default 3\n" + records, lane);
        Assert.Empty(result.Problems);
        Assert.Equal("3", Values(edit, "Status", "Fechado")["Peso"]);
        var (_, refused) = Normalize(head + "  Peso Integer required\n" + records, lane);
        Assert.Equal([(9, "DDL_VALUE_REQUIRED"), (10, "DDL_VALUE_REQUIRED")], refused.Problems.Select(p => (p.Line, p.Code)));
        Assert.Contains("Peso", refused.Problems[0].Message);
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void AnIndexOnAStaticEntityIsCheckedAgainstTheRecordsAndLeftOut(string lane)
    {
        var statement = "create static entity Uf (\n  Id Integer identifier required,\n  Label Text(50),\n  Sigla Text(2)\n)\nvalues\n  SaoPaulo (Id = 1, Sigla = \"SP\"),\n  Bahia (Id = 2, Sigla = \"BA\");\n";
        var (edit, result) = Normalize(statement + "create unique index UX_Uf_Sigla on Uf (Sigla);", lane);
        Assert.Empty(result.Problems);
        Assert.DoesNotContain(Entity(edit, "Uf").Children, c => c.Kind == "EntityIndex");
        Assert.Contains(result.Notes, n => n.Code == "DDL_STATIC_INDEX_DROPPED" && n.Message.Contains("unique"));
        Assert.Empty(DdlCompiler.Compile(edit, null, lane).Problems);
        // Repeated values under a unique index: refused with the index's line and the records.
        var (_, repeated) = Normalize(statement.Replace("\"BA\"", "\"SP\"") + "create unique index UX_Uf_Sigla on Uf (Sigla);", lane);
        var problem = Assert.Single(repeated.Problems);
        Assert.Equal(("DDL_STATIC_INDEX_DUPLICATE", 9), (problem.Code, problem.Line));
        Assert.Contains("SaoPaulo and Bahia", problem.Message);
        // Its patch (the corrected text: the index without unique) is accepted as it is.
        Assert.EndsWith("create index UX_Uf_Sigla on Uf (Sigla);", problem.Corrected);
        var (patched, patchedResult) = Normalize(problem.Corrected!, lane);
        Assert.Empty(patchedResult.Problems);
        Assert.Contains(patchedResult.Notes, n => n.Code == "DDL_STATIC_INDEX_DROPPED");
        Assert.Empty(DdlCompiler.Compile(patched, null, lane).Problems);
        // Not unique: left out; a column that is not an attribute: refused.
        Assert.Contains(Normalize(statement.Replace("\"BA\"", "\"SP\"") + "create index IX_Uf_Sigla on Uf (Sigla);", lane).Result.Notes, n => n.Code == "DDL_STATIC_INDEX_DROPPED");
        Assert.Equal("DDL_NAME_UNKNOWN", Assert.Single(Normalize(statement + "create index IX_Uf on Uf (Nome);", lane).Result.Problems).Code);
        // On a kept static entity, the same (the compiler would refuse it otherwise: DDL_UNSUPPORTED).
        var text = Base.Replace("\r\n", "\n");
        var at = text.IndexOf("create static entity Status", StringComparison.Ordinal);
        var (kept, keptResult) = Normalize(text[at..text.IndexOf("\n\n", at, StringComparison.Ordinal)] + "\ncreate unique index UX_Status_Cor on Status (Label);", lane);
        Assert.Contains(keptResult.Notes, n => n.Code == "DDL_STATIC_INDEX_DROPPED");
        Assert.Empty(Ops(kept, lane));
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void AStaticLabelOrOrderLeftOutOfAKeptStatementIsRefusedWithItsLineWhenTheRecordsHaveValues(string lane)
    {
        // The statement written from memory without Order (its records have Order 1 and 2): refused once, never deleted in
        // silence with its values and the order of every list of Status.
        const string withoutOrder = """
            create static entity Status public ( -- @s1
              Id Integer identifier required, -- @c1
              Label Text(50) required, -- @c2
              Cor Text(20) -- @c4
            )
            values
              Aberto (Id = 1, Label = "Aberto", Cor = "red"), -- @r1
              Fechado (Id = 2, Label = "Fechado"); -- @r2
            """;
        var (_, refused) = Normalize(withoutOrder, lane);
        var problem = Assert.Single(refused.Problems);
        Assert.Equal(("DDL_STATIC_ATTRIBUTE_LEFT_OUT", 1), (problem.Code, problem.Line));
        Assert.Contains("Order is its order attribute and 2 record(s) have a value of it", problem.Message);
        Assert.Contains("order none", problem.Fix);
        // The patch: the attribute's line as the module has it, the list's commas right. Accepted as it is, and it changes
        // nothing (the records keep their Order values).
        Assert.Contains("  Label Text(50) required, -- @c2\n  Order Integer required, -- @c3\n  Cor Text(20) -- @c4\n)", problem.Corrected);
        var (patched, patchedResult) = Normalize(problem.Corrected!, lane);
        Assert.Empty(patchedResult.Problems);
        Assert.Equal("1", Values(patched, "Status", "Aberto")["Order"]);
        Assert.Empty(Ops(patched, lane));
        // Deleting it is said: `order none`. The entity stops ordering by it before the delete (its use), and no record value
        // is cleared first.
        var (deleted, deleteResult) = Normalize(withoutOrder.Replace("Status public (", "Status public order none ("), lane);
        Assert.Empty(deleteResult.Problems);
        Assert.Equal(["set @s1 OrderByAttribute null", "delete @c3"], Ops(deleted, lane));
        // Label the same (its texts would be lost), with both left out: one refusal, both problems.
        var (_, both) = Normalize("""
            create static entity Status public ( -- @s1
              Id Integer identifier required, -- @c1
              Cor Text(20) -- @c4
            )
            values
              Aberto (Id = 1, Cor = "red"), -- @r1
              Fechado (Id = 2); -- @r2
            """, lane);
        Assert.Equal(["Label", "Order"], both.Problems.Select(p => p.Message.Split(' ')[3].TrimEnd(':')));
        // One patch for both, accepted as it is and changing nothing.
        Assert.Equal(both.Problems[0].Corrected, both.Problems[1].Corrected);
        Assert.Contains("  Id Integer identifier required, -- @c1\n  Label Text(50) required, -- @c2\n  Order Integer required, -- @c3\n  Cor Text(20) -- @c4\n)", both.Problems[0].Corrected);
        var (bothPatched, bothPatchedResult) = Normalize(both.Problems[0].Corrected!, lane);
        Assert.Empty(bothPatchedResult.Problems);
        Assert.Empty(Ops(bothPatched, lane));
        // Without values of it (no record has one), it goes with a note.
        var empty = Base.Replace("\r\n", "\n").Replace(", Order = 1, Cor", ", Cor").Replace(", Order = 2)", ")");
        var emptyModule = DdlParser.Parse(empty.Replace("lane=o11", "lane=" + lane));
        var quiet = DdlParser.Parse(withoutOrder, lane);
        var quietResult = DdlConventions.Apply(quiet, emptyModule);
        Assert.Empty(quietResult.Problems);
        Assert.Contains(quietResult.Notes, n => n.Code == "DDL_STATIC_LINK_DROPPED" && n.Message.Contains("Order"));
        // The patch keeps the attribute's description lines (else the kept attribute would lose its description).
        var described = Base.Replace("\r\n", "\n").Replace("  Order Integer required, -- @c3", "  /// A posição nas listas\n  Order Integer required, -- @c3");
        var describedModule = DdlParser.Parse(described.Replace("lane=o11", "lane=" + lane));
        var describedProblem = Assert.Single(DdlConventions.Apply(DdlParser.Parse(withoutOrder, lane), describedModule).Problems);
        Assert.Contains("  Label Text(50) required, -- @c2\n  /// A posição nas listas\n  Order Integer required, -- @c3\n  Cor Text(20) -- @c4\n)", describedProblem.Corrected);
        var describedPatch = DdlParser.Parse(describedProblem.Corrected!, lane);
        Assert.Empty(DdlConventions.Apply(describedPatch, describedModule).Problems);
        Assert.Empty(DdlCompiler.Compile(describedPatch, DdlParser.Parse(described.Replace("lane=o11", "lane=" + lane)), lane, "$ddl", "").Ops());
        // A renamed one (its key kept) is not left out.
        var (renamed, renamedResult) = Normalize(withoutOrder.Replace("  Cor Text(20) -- @c4", "  Cor Text(20), -- @c4\n  Posicao Integer required -- @c3"), lane);
        Assert.Empty(renamedResult.Problems);
        Assert.DoesNotContain("delete @c3", Ops(renamed, lane));
    }
}
