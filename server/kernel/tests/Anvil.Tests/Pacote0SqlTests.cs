using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane 0, C42: SQL that fails only at run time, or that the Studio refuses after the model changed, is refused before the
/// apply with the exact rewrite. The Studio's own Verify reads every @name as a node parameter: @@ROWCOUNT, DECLARE @x and
/// DECLARE @t TABLE each give InvalidSQL_UnknownParam (measured on Service Studio 11, 2026-10-05), so they are refused with
/// the rewrite instead of a request for a parameter that would not help. An aggregate over a subquery or another aggregate
/// is SQL Server error 130 at run time (session 890a2354, checkout, 04/10 22:54); PostgreSQL refuses only the nested one.
/// </summary>
public sealed class Pacote0SqlTests
{
    private const string Model = """
      {"op":"spec","data":{"entities":[
        {"name":"Game","attributes":[{"name":"Title","type":"Text"},{"name":"PriceCoins","type":"Integer"},{"name":"IsActive","type":"Boolean"}]},
        {"name":"Promotion","attributes":[{"name":"GameId","type":"Game Identifier"},{"name":"DiscountPercent","type":"Integer"}]},
        {"name":"CartItem","attributes":[{"name":"GameId","type":"Game Identifier"},{"name":"UserId","type":"Long Integer"}]}]}}
      """;

    private static JsonArray RawJob(string statement, params (string Name, string Type, bool Inline)[] parameters)
    {
        var ops = new JsonArray(JsonNode.Parse(Model)!,
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IServerAction","name":"Probe","as":"$act"}""")!,
            JsonNode.Parse("""{"op":"create","parent":"$act","type":"ISQLNode","name":"Query","as":"$sql"}""")!,
            new JsonObject { ["op"] = "set", ["target"] = "$sql", ["prop"] = "Statement", ["value"] = statement });
        foreach (var (name, type, inline) in parameters)
        {
            ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "$sql", ["type"] = "ISQLInputParameter", ["name"] = name, ["as"] = "$p" + name });
            ops.Add(new JsonObject { ["op"] = "set", ["target"] = "$p" + name, ["prop"] = "DataType", ["value"] = type });
            if (inline) ops.Add(new JsonObject { ["op"] = "set", ["target"] = "$p" + name, ["prop"] = "ExpandInline", ["value"] = true });
        }
        return ops;
    }

    private static string[] Errors(JsonArray ops, string dialect = "sqlserver") =>
        SqlPreflight.Analyze(ops, dialect)["errors"]!.AsArray().Select(e => e!.GetValue<string>()).ToArray();

    private static string Single(JsonArray ops, string dialect = "sqlserver")
    {
        var errors = Errors(ops, dialect);
        Assert.True(errors.Length == 1, "expected one error, got: " + string.Join(" | ", errors));
        return errors[0];
    }

    // ---- @@ system functions and DECLARE: the Studio's reading, refused with the rewrite ------------------------------

    [Fact]
    public void LogicSqlWithRowcountNamesTheFunctionInsteadOfAMissingParameter()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            SqlChecks.Validate("UPDATE {Game} SET [IsActive] = 0 WHERE {Game}.[Id] = @Id;\nSELECT @@ROWCOUNT", ["Id"], "action A passo #1")).Message;
        Assert.Contains("@@ROWCOUNT is read by the Studio as a node parameter named ROWCOUNT", error);
        Assert.Contains("CAST(ROWCOUNT_BIG() AS INT)", error);
        Assert.DoesNotContain("used but not declared", error);
    }

    [Theory]
    [InlineData("DECLARE @Limit INT = @Minimum;\nSELECT {Game}.* FROM {Game} WHERE {Game}.[PriceCoins] >= @Limit", "@Limit is a T-SQL variable")]
    [InlineData("DECLARE @Picked TABLE ([Id] BIGINT);\nINSERT INTO @Picked ([Id]) SELECT {Game}.[Id] FROM {Game} WHERE {Game}.[PriceCoins] >= @Minimum;\nSELECT {Game}.* FROM {Game} WHERE {Game}.[Id] IN (SELECT [Id] FROM @Picked)", "@Picked is a T-SQL variable")]
    [InlineData("DECLARE @A INT = @Minimum, @B INT = 2;\nSELECT {Game}.* FROM {Game} WHERE {Game}.[PriceCoins] BETWEEN @A AND @B", "@A, @B are T-SQL variables")]
    public void LogicSqlWithDeclaredVariablesNamesTheRewrite(string statement, string expected)
    {
        var error = Assert.Throws<InvalidOperationException>(() => SqlChecks.Validate(statement, ["Minimum"], "action A passo #1")).Message;
        Assert.Contains(expected, error);
        Assert.Contains("derived table or a CTE", error);
        Assert.DoesNotContain("used but not declared", error);
        Assert.DoesNotContain("Minimum", error);   // the declared node parameter is not a problem
    }

    [Fact]
    public void AGenuinelyMissingParameterIsStillReportedNextToTheRewrite()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            SqlChecks.Validate("SELECT {Game}.* FROM {Game} WHERE {Game}.[PriceCoins] >= @Missing;\nSELECT @@ROWCOUNT", ["Unused"], "probe")).Message;
        Assert.Contains("CAST(ROWCOUNT_BIG() AS INT)", error);
        Assert.Contains("used but not declared: Missing; declared but not used: Unused", error);
    }

    [Fact]
    public void RawNodeWithRowcountIsRefusedWithTheFunctionNotAsAnUndeclaredParameter()
    {
        var error = Single(RawJob("UPDATE {Game} SET [IsActive] = 0 WHERE {Game}.[Id] = @Id;\nSELECT @@ROWCOUNT", ("Id", "Game Identifier", false)));
        Assert.Contains("line 2", error);
        Assert.Contains("CAST(ROWCOUNT_BIG() AS INT)", error);
        Assert.DoesNotContain("declares no parameter", error);
    }

    [Fact]
    public void RawNodeWithDeclareIsRefusedInO11WithTheRewrite()
    {
        var error = Single(RawJob("SET NOCOUNT ON\nDECLARE @Total INT = 0, @Rows INT;\nSELECT {Game}.* FROM {Game} WHERE {Game}.[PriceCoins] > @Total"));
        Assert.Contains("line 2", error);
        Assert.Contains("@Total, @Rows are T-SQL variables (DECLARE)", error);
        Assert.Contains("InvalidSQL_UnknownParam", error);
    }

    [Fact]
    public void TheExpandInlineSymbolOfAVariableIsTheNodesOwnParameter()
    {
        // The proven escape hatch (jobs-live/dcips-approval-native-sql.json): an Expand Inline Text parameter whose value is
        // the literal token "@Now" carries the T-SQL variable past the Studio's reading.
        Assert.Empty(Errors(RawJob("DECLARE @SqlSymbolNow datetime2 = SYSUTCDATETIME();\nSELECT {Game}.* FROM {Game} WHERE {Game}.[PriceCoins] > 0",
            ("SqlSymbolNow", "Text", true))));
    }

    [Fact]
    public void OdcRefusesSqlServerSystemVariablesButNotTheTextSearchOperator()
    {
        Assert.Contains("WITH changed AS (UPDATE ... RETURNING 1) SELECT COUNT(*) FROM changed",
            Single(RawJob("DELETE FROM {Game} WHERE {Game}.[Id] = @Id;\nSELECT @@ROWCOUNT", ("Id", "Game Identifier", false)), "odc"));
        Assert.Empty(Errors(RawJob("SELECT {Game}.* FROM {Game} WHERE to_tsvector({Game}.[Title]) @@ to_tsquery(@Term)", ("Term", "Text", false)), "odc"));
    }

    // ---- aggregates over a subquery or an aggregate (error 130) ---------------------------------------------------

    [Theory]
    [InlineData("SELECT SUM((SELECT MAX({Promotion}.[DiscountPercent]) FROM {Promotion} WHERE {Promotion}.[GameId] = {Game}.[Id])) FROM {Game}", "SUM(...) aggregates an expression containing a subquery")]
    [InlineData("SELECT MAX(COUNT({CartItem}.[Id])) FROM {CartItem} GROUP BY {CartItem}.[UserId]", "MAX(...) aggregates an expression containing another aggregate (COUNT)")]
    [InlineData("SELECT ISNULL(SUM({Game}.[PriceCoins] - ({Game}.[PriceCoins] * ISNULL((SELECT MAX({Promotion}.[DiscountPercent]) FROM {Promotion} WHERE {Promotion}.[GameId] = {Game}.[Id]), 0) / 100)), 0) FROM {CartItem} INNER JOIN {Game} ON {Game}.[Id] = {CartItem}.[GameId] WHERE {CartItem}.[UserId] = @UserId", "SUM(...) aggregates an expression containing a subquery")]
    [InlineData("SELECT COUNT(CASE WHEN EXISTS (SELECT 1 FROM {Promotion} WHERE {Promotion}.[GameId] = {Game}.[Id]) THEN 1 END) FROM {Game}", "COUNT(...) aggregates an expression containing a subquery")]
    public void AnAggregateOverASubqueryOrAnAggregateIsError130InO11(string statement, string reason)
    {
        var error = Single(RawJob(statement, ("UserId", "Long Integer", false)));
        Assert.Contains("SQL Server error 130", error);
        Assert.Contains(reason, error);
        Assert.Contains("derived table or CTE", error);
    }

    [Fact]
    public void PostgresRefusesOnlyTheNestedAggregate()
    {
        Assert.Contains("aggregate function calls cannot be nested",
            Single(RawJob("SELECT MAX(COUNT({CartItem}.[Id])) FROM {CartItem} GROUP BY {CartItem}.[UserId]"), "odc"));
        // A subquery keeps its own aggregates in PostgreSQL: valid there.
        Assert.Empty(Errors(RawJob("SELECT SUM((SELECT COUNT(*) FROM {Promotion} WHERE {Promotion}.[GameId] = {Game}.[Id])) FROM {Game}"), "odc"));
    }

    [Theory]
    [InlineData("SELECT SUM(x.[Discount]) FROM (SELECT {Promotion}.[GameId], MAX({Promotion}.[DiscountPercent]) AS [Discount] FROM {Promotion} GROUP BY {Promotion}.[GameId]) x")]
    [InlineData("SELECT {CartItem}.[UserId], SUM(COUNT({CartItem}.[Id])) OVER () FROM {CartItem} GROUP BY {CartItem}.[UserId]")]
    [InlineData("SELECT COUNT(DISTINCT {CartItem}.[GameId]), ISNULL(SUM({Game}.[PriceCoins]), 0) FROM {CartItem} INNER JOIN {Game} ON {Game}.[Id] = {CartItem}.[GameId]")]
    public void TheRewriteAndWindowAggregatesPassInBothLanes(string statement)
    {
        Assert.DoesNotContain(Errors(RawJob(statement)), e => e.Contains("error 130"));
        Assert.DoesNotContain(Errors(RawJob(statement), "odc"), e => e.Contains("cannot be nested"));
    }
}
