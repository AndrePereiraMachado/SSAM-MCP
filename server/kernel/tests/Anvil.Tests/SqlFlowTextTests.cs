using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F7 (25/10/2026): the SQL node of a ssam-flow/1 text goes through the same reading as the SQL of the JSON form and of raw
/// ops (SqlPreflight.Analyze). The owner's ImportarClientesDemo reached the Verify with five InvalidSQL_UnknownParam
/// (@@ROWCOUNT, DECLARE @doc, @src, @updated, @inserted) and the receipt said `sqlStatements: 0`: now the preflight says both
/// with their rewrite, before the build, in both dialects; the node's own `in` lines are its parameters.
/// </summary>
public class SqlFlowTextTests
{
    private const string Batch = "server action ImportarClientes\n  out Quantidade: Integer\n  local Payload: Text\n"
        + "  Batch = sql -> Resultado max 1\n    in Payload: Text = Payload\n"
        + "    | DECLARE @doc xml = CAST(@Payload AS xml);\n"
        + "    | DECLARE @updated int;\n"
        + "    | UPDATE {Cliente} SET [Nome] = 'x' WHERE [Id] > 0;\n"
        + "    | SET @updated=@@ROWCOUNT;\n"
        + "    | SELECT @updated\n"
        + "  assign Quantidade = Batch.List.Current.Resultado.Quantidade\n  end\n";

    private static JsonArray Job(string text) => new(
        JsonNode.Parse("""{"op":"spec","data":{"ddl":"create entity Cliente public (\n Id Long Integer identifier auto required,\n Nome Text(200) required\n);\ntype Resultado = {\n Quantidade: Integer;\n}\n"}}"""),
        new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } });

    [Fact]
    public void TheSqlOfAFlowTextIsCheckedWithTheRewriteInBothDialects()
    {
        var server = SqlPreflight.Analyze(Job(Batch), "sqlserver");
        Assert.Equal(1, server["sqlStatements"]!.GetValue<int>());
        var errors = server["errors"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.Contains(errors, e => e.Contains("op #1") && e.Contains("logic action 'ImportarClientes' sql 'Batch'") && e.Contains("write CAST(ROWCOUNT_BIG() AS INT)"));
        Assert.Contains(errors, e => e.Contains("@doc, @updated are T-SQL variables (DECLARE)"));
        var postgres = SqlPreflight.Analyze(Job(Batch), "odc")["errors"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.Contains(postgres, e => e.Contains("PostgreSQL (ODC) has none either"));
    }

    [Fact]
    public void AFlowTextSqlWithItsOwnParametersPassesAndAnUndeclaredOneIsNamed()
    {
        var clean = Batch[..Batch.IndexOf("    | DECLARE", StringComparison.Ordinal)] + "    | SELECT COUNT(*) FROM {Cliente} WHERE LEN(@Payload) > 0\n"
            + "  assign Quantidade = Batch.List.Current.Resultado.Quantidade\n  end\n";
        var result = SqlPreflight.Analyze(Job(clean), "sqlserver");
        Assert.Equal(1, result["sqlStatements"]!.GetValue<int>());
        Assert.Empty(result["errors"]!.AsArray());
        var undeclared = SqlPreflight.Analyze(Job(clean.Replace("@Payload", "@Carga")), "sqlserver")["errors"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.Contains(undeclared, e => e.Contains("@Carga is used but the SQL node declares no parameter 'Carga' (declared: Payload)"));
    }
}
