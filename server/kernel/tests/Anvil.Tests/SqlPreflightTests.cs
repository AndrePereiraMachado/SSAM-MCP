using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// Headless SQL preflight (plano-erros-publicacao, fase 3): SQL that the Studio accepts and only the database refuses is
/// refused in check-job/apply with op index, SQL line and reason. Positive cases prove the rules do not refuse valid SQL,
/// including every SQL of the jobs in the repository and the SQL of the real Horsie_CS case.
/// </summary>
public sealed class SqlPreflightTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();

    // ---- helpers --------------------------------------------------------------------------------

    private const string Model = """
      {"op":"spec","data":{
        "static":[{"name":"Sex","records":[{"name":"Mare"}]}],
        "entities":[
          {"name":"Product","attributes":[{"name":"Name","type":"Text","length":100},{"name":"Price","type":"Decimal"},
            {"name":"IsActive","type":"Boolean"},{"name":"CreatedOn","type":"Date Time"},{"name":"SexId","type":"Sex Identifier"},
            {"name":"Photo","type":"Binary Data"}]},
          {"name":"Code","id":false,"attributes":[{"name":"Id","type":"Text","length":20},{"name":"Label","type":"Text"}]}],
        "clientEntities":[{"name":"Draft","attributes":[{"name":"Body","type":"Text"}]}],
        "structures":[{"name":"Row","attributes":[{"name":"Name","type":"Text"}]}]}}
      """;

    /// <summary>A model spec plus one raw SQL node with the given statement and parameters (name, type, expandInline).</summary>
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
        ops.Add(JsonNode.Parse("""{"op":"create","parent":"$sql","type":"ISQLOutput","name":"List","args":{"entityOrStructure":"Product"}}""")!);
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

    // ---- lexical layer (all lanes) ------------------------------------------------------------

    [Theory]
    [InlineData("SELECT {Product}.* FROM {Product}\nWHERE {Product}.[Name] = 'it''s", 2, "unterminated string literal")]
    [InlineData("SELECT {Product}.[Name FROM {Product}", 1, "unterminated [identifier]")]
    [InlineData("SELECT 1 /* outer /* inner */\nFROM {Product}", 1, "unterminated /* comment")]
    [InlineData("SELECT {Product}.* FROM {Product}\nWHERE ({Product}.[Price] > 1", 2, "'(' is never closed")]
    [InlineData("SELECT {Product}.* FROM {Product}\n\nWHERE {Product}.[Price] > 1)", 3, "')' without a matching '('")]
    [InlineData("SELECT {Product.* FROM {Product}", 1, "unterminated {Entity}")]
    [InlineData("SELECT {GetCart}.[List].{Current Cart} FROM {Product}", 1, "is not an entity reference")]
    public void LexicalErrorsCarryOpAndLineInBothLanes(string statement, int line, string reason)
    {
        foreach (var dialect in new[] { "sqlserver", "odc" })
        {
            var error = Single(RawJob(statement), dialect);
            Assert.StartsWith("op #3 (SQL ISQLNode 'Query', line " + line + ")", error);
            Assert.Contains(reason, error);
        }
    }

    [Fact]
    public void LiteralsCommentsAndBracketsDoNotCountAsParametersOrParentheses()
    {
        Assert.Empty(Errors(RawJob("""
            -- a comment with @Ignored and (
            SELECT {Product}.* FROM {Product}
            WHERE {Product}.[Name] <> ':) @NotAParam' /* nested /* @x */ ( */
              AND {Product}.[Price] >= @Min
            """, ("Min", "Decimal", false))));
    }

    // ---- entities, attributes, parameters -----------------------------------------------------

    [Fact]
    public void UndeclaredParameterOfAJobNodeIsRefusedWithItsLine()
    {
        var error = Single(RawJob("SELECT {Product}.* FROM {Product}\nWHERE {Product}.[Price] >= @Minimum", ("Min", "Decimal", false)));
        Assert.Contains("line 2", error);
        Assert.Contains("@Minimum is used but the SQL node declares no parameter 'Minimum' (declared: Min)", error);
    }

    [Fact]
    public void DeclaredButUnusedParameterOfARawNodeIsLeftToVerify()
    {
        // The Studio reports it as UnusedElement (a warning governed by expectedMessages); it never fails at publish.
        Assert.Empty(Errors(RawJob("SELECT {Product}.* FROM {Product}", ("Unused", "Text", false))));
    }

    [Fact]
    public void AttributeAbsentFromAJobEntityIsRefusedAndListsTheDeclaredOnes()
    {
        var error = Single(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Nome] = 'x'"));
        Assert.Contains("[Nome] is not an attribute of {Product}; declared: CreatedOn, Id, IsActive, Name, Photo, Price, SexId", error);
    }

    [Fact]
    public void ClientEntityInSqlIsRefused()
        => Assert.Contains("{Draft} is a Local Storage (client) entity", Single(RawJob("SELECT {Draft}.* FROM {Draft}")));

    [Fact]
    public void NamesOutsideTheJobAreLeftForTheBaseCheck()
    {
        var result = SqlPreflight.Analyze(RawJob("SELECT {Customer}.* FROM {Customer}\nWHERE {Customer}.[Email] = @Mail", ("Mail", "Email", false)), "sqlserver");
        Assert.Empty(result["errors"]!.AsArray());
        var open = result["unresolved"]!.AsArray().Select(x => x!["kind"] + ":" + x["entity"] + "." + x["attribute"] + "@" + x["line"]).ToArray();
        Assert.Contains("entity:Customer.@1", open);
        Assert.Contains("attribute:Customer.Email@2", open);
        Assert.Contains("comparison:Customer.Email@2", open);
    }

    [Fact]
    public void RawStatementOnAnExistingNodeLeavesItsParametersForTheBase()
    {
        var ops = new JsonArray(
            JsonNode.Parse("""{"op":"set","target":"IServerAction:Product_Search/SearchProducts","prop":"Statement","value":"SELECT {Product}.* FROM {Product}\nWHERE {Product}.[Id] = @Missing"}""")!,
            JsonNode.Parse("""{"op":"delete","target":"IServerAction:Product_Search/SearchProducts/MinPrice"}""")!);
        var result = SqlPreflight.Analyze(ops, "sqlserver");
        Assert.Empty(result["errors"]!.AsArray());
        var parameters = Assert.Single(result["unresolved"]!.AsArray(), x => x!["kind"]!.ToString() == "parameters")!;
        Assert.Equal("IServerAction:Product_Search/SearchProducts", parameters["target"]!.ToString());
        Assert.Equal(2, parameters["line"]!.GetValue<int>());
        Assert.Equal("MinPrice", parameters["removed"]![0]!.ToString());
    }

    [Fact]
    public void RenamesAndReferencesAreFollowed()
    {
        var ops = RawJob("SELECT {Item}.[Title] FROM {Item} INNER JOIN {Remote} ON {Remote}.[Anything] = {Item}.[Id] WHERE {Item}.[Title] = @T", ("T", "Text", false));
        ops.Insert(1, JsonNode.Parse("""{"op":"rename","target":"$Product","name":"Item"}""")!);
        ops.Insert(2, JsonNode.Parse("""{"op":"rename","target":"$Product.Name","name":"Title"}""")!);
        ops.Insert(3, JsonNode.Parse("""{"op":"reference","producer":"job:producer-public","elements":["IServerEntity:Remote"]}""")!);
        var result = SqlPreflight.Analyze(ops, "sqlserver");
        Assert.Empty(result["errors"]!.AsArray());
        Assert.Empty(result["unresolved"]!.AsArray());
    }

    [Fact]
    public void AStatementSetBeforeARenameKeepsTheOldNames()
    {
        // tests/jobs-odc/rename-data-propagation: the platform rewrites the SQL text when the entity/attribute is renamed.
        var ops = RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] <> @T", ("T", "Text", false));
        ops.Add(JsonNode.Parse("""{"op":"rename","target":"$Product","name":"Item"}""")!);
        ops.Add(JsonNode.Parse("""{"op":"rename","target":"$Product.Name","name":"Title"}""")!);
        ops.Add(JsonNode.Parse("""{"op":"rename","target":"$pT","name":"Term"}""")!);
        var result = SqlPreflight.Analyze(ops, "sqlserver");
        Assert.Empty(result["errors"]!.AsArray());
        Assert.Empty(result["unresolved"]!.AsArray());
    }

    // ---- types ----------------------------------------------------------------------------------

    [Theory]
    [InlineData("{Product}.[Name] = @P", "Integer", true)]
    [InlineData("@P = {Product}.[Price]", "Text", true)]
    [InlineData("{Product}.[CreatedOn] >= @P", "Integer", true)]
    [InlineData("{Product}.[IsActive] = @P", "Text", true)]
    [InlineData("{Product}.[Photo] = @P", "Text", true)]
    [InlineData("{Product}.[SexId] = @P", "Text", true)]
    [InlineData("{Code}.[Id] = @P", "Long Integer", true)]
    [InlineData("{Product}.[Name] LIKE @P", "Decimal", true)]
    [InlineData("{Product}.[IsActive] = @P", "Integer", false)]
    [InlineData("{Product}.[CreatedOn] >= @P", "Text", false)]
    [InlineData("{Product}.[SexId] = @P", "Sex Identifier", false)]
    [InlineData("{Product}.[Price] >= @P", "Currency", false)]
    [InlineData("{Product}.[Name] = CAST(@P AS NVARCHAR(20))", "Integer", false)]
    [InlineData("{Product}.[Price] = @P * 2", "Text", false)]
    public void ComparisonTypesFollowTheDeclaredTypes(string condition, string type, bool refused)
    {
        var errors = Errors(RawJob("SELECT {Product}.* FROM {Product} WHERE " + condition, ("P", type, false)));
        if (refused) Assert.Contains("is declared " + type, Assert.Single(errors));
        else Assert.Empty(errors);
    }

    [Fact]
    public void ExpandInlineParameterMustBeText()
    {
        Assert.Contains("@Ids has Expand Inline but DataType 'Integer'", Single(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Id] IN (@Ids)", ("Ids", "Integer", true))));
        Assert.Empty(Errors(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Id] IN (@Ids)", ("Ids", "Text", true))));
    }

    // ---- SQL Server (O11) -----------------------------------------------------------------------

    [Theory]
    [InlineData("SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Name] LIMIT 10", "LIMIT does not exist in SQL Server")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[CreatedOn] < NOW()", "NOW() is not a SQL Server function; use GETDATE()")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE IFNULL({Product}.[Price], 0) > 0", "use ISNULL or COALESCE")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE LENGTH({Product}.[Name]) > 3", "use LEN")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[IsActive] = TRUE", "TRUE is not a literal in SQL Server")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] ILIKE 'a%'", "ILIKE does not exist")]
    [InlineData("SELECT {Product}.[Price]::int FROM {Product}", "'::int' is a PostgreSQL cast")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] = \"abc\"", "\"abc\" is a quoted identifier in SQL Server, not a text literal; use single quotes: 'abc'")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] > 0 && {Product}.[Price] < 9", "'&&' is not a SQL operator")]
    [InlineData("SELECT", "the statement ends with SELECT")]
    [InlineData("FIND {Product}.* FROM {Product}", "the statement starts with 'FIND'")]
    [InlineData("SELECT X.* FROM (SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Name]) X", "error 1033")]
    [InlineData("WITH C AS (SELECT {Product}.[Id] FROM {Product} ORDER BY {Product}.[Id]) SELECT {Product}.* FROM {Product} WHERE {Product}.[Id] IN (SELECT Id FROM C)", "error 1033")]
    public void SqlServerRefusalsAreReportedInO11AndNotInOdc(string statement, string reason)
    {
        Assert.Contains(reason, Single(RawJob(statement)));
        Assert.DoesNotContain(Errors(RawJob(statement), "odc"), e => e.Contains(reason));
    }

    [Theory]
    [InlineData("SELECT X.* FROM (SELECT TOP 5 {Product}.* FROM {Product} ORDER BY {Product}.[Name]) X")]
    [InlineData("SELECT X.* FROM (SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Name] OFFSET 0 ROWS) X")]
    [InlineData("SELECT {Product}.*, ROW_NUMBER() OVER (PARTITION BY {Product}.[SexId] ORDER BY {Product}.[Price] DESC) FROM {Product}")]
    [InlineData("SELECT STRING_AGG({Product}.[Name], ', ') WITHIN GROUP (ORDER BY {Product}.[Name]) FROM {Product}")]
    [InlineData(";WITH C AS (SELECT {Product}.[Id] FROM {Product}) SELECT {Product}.* FROM {Product} INNER JOIN C ON C.Id = {Product}.[Id] ORDER BY {Product}.[Name]")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] BETWEEN 1 AND 2 AND {Product}.[IsActive] = 1 AND NOT EXISTS (SELECT 1 FROM {Code} WHERE {Code}.[Label] = {Product}.[Name])")]
    [InlineData("UPDATE {Product} SET [Price] = [Price] * 1.1, [IsActive] = 0 WHERE {Product}.[Id] > 0;")]
    [InlineData("DELETE FROM {Product} WHERE {Product}.[CreatedOn] < DATEADD(day, -30, GETDATE())")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] = N'Ação' AND {Product}.[Price] <> 0 AND {Product}.[Price] != 1")]
    [InlineData("SELECT CASE WHEN {Product}.[Price] > 10 THEN 'High' ELSE 'Low' END AS [True] FROM {Product}")]
    [InlineData("SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Id] OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY")]
    // DECLARE @x is not here: the Studio's Verify reads @x as an unknown node parameter (InvalidSQL_UnknownParam), so it is
    // refused with the rewrite (Pacote0SqlTests); the Expand Inline "SqlSymbol" form of a variable passes.
    [InlineData("SET NOCOUNT ON\nSELECT {Product}.* FROM {Product} WHERE {Product}.[Price] > 0")]
    public void ValidSqlServerPasses(string statement) => Assert.Empty(Errors(RawJob(statement)));

    [Fact]
    public void BackticksAreReportedOnce()
        => Assert.Contains("backticks quote identifiers in MySQL", Single(RawJob("SELECT {Product}.`Name` FROM {Product}")));

    [Fact]
    public void ExpandInlineStatementsKeepOnlyTheCertainRules()
    {
        // The inline text completes the statement at run time: no grammar guesses, lexical and dialect rules still apply.
        Assert.Empty(Errors(RawJob("SELECT {Product}.* FROM {Product} WHERE @Filter", ("Filter", "Text", true))));
        Assert.Contains("NOW()", Single(RawJob("SELECT NOW() FROM {Product} WHERE @Filter", ("Filter", "Text", true))));
    }

    // ---- grammar (all lanes) ----------------------------------------------------------------------

    [Theory]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] == 1", "'==' is not a SQL operator")]
    [InlineData("SELECT {Product}.[Name], {Product}.[Price], FROM {Product}", "a comma is followed by 'FROM'")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE AND {Product}.[Price] > 1", "WHERE is followed by 'AND'")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] > 1 AND", "AND is followed by the end of the statement")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE ({Product}.[Price] > 1 OR )", "OR is followed by ')'")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] > AND 1 = 1", "'>' is missing an operand")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE;", "WHERE is followed by the end of the statement")]
    [InlineData("SELECT {Product}.* FROM", "the statement ends with FROM")]
    public void GrammarGapsAreRefusedInBothLanes(string statement, string reason)
    {
        // PostgreSQL refuses the same gaps ("syntax error at or near ..."): the grammar is not a SQL Server rule.
        foreach (var dialect in new[] { "sqlserver", "odc" })
            Assert.Contains(reason, Single(RawJob(statement), dialect));
    }

    // ---- PostgreSQL (ODC) -----------------------------------------------------------------------

    [Theory]
    [InlineData("SELECT TOP 10 {Product}.* FROM {Product} ORDER BY {Product}.[Name]", "TOP does not exist in PostgreSQL (ODC); remove it and end the query with LIMIT n")]
    [InlineData("SELECT DISTINCT TOP (5) {Product}.[Name] FROM {Product}", "TOP does not exist in PostgreSQL")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE ISNULL({Product}.[Price], 0) > 0", "ISNULL() is SQL Server; ODC runs SQL on PostgreSQL, which has no such function: use COALESCE(x, fallback)")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[CreatedOn] < GETDATE()", "GETDATE() is SQL Server; ODC runs SQL on PostgreSQL, which has no such function: use NOW() or CURRENT_TIMESTAMP")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE LEN({Product}.[Name]) > 3", "LEN() is SQL Server; ODC runs SQL on PostgreSQL, which has no such function: use LENGTH")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[CreatedOn] < DATEADD(day, -30, NOW())", "DATEADD() is SQL Server; ODC runs SQL on PostgreSQL, which has no such function: use x + INTERVAL '1 day'")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE YEAR({Product}.[CreatedOn]) = 2026", "use EXTRACT(YEAR FROM x)")]
    [InlineData("SELECT {Product}.* FROM {Product} ORDER BY NEWID()", "use GEN_RANDOM_UUID()")]
    [InlineData("SELECT IIF({Product}.[Price] > 10, 'High', 'Low') AS \"Band\" FROM {Product}", "use CASE WHEN")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE CHARINDEX('a', {Product}.[Name]) > 0", "use STRPOS(text, part)")]
    [InlineData("SELECT TRY_CAST({Product}.[Name] AS INT) FROM {Product}", "TRY_CAST() is SQL Server")]
    [InlineData("SELECT CAST({Product}.[Price] AS NVARCHAR(20)) FROM {Product}", "NVARCHAR is a SQL Server type; PostgreSQL (ODC) has no such type: use VARCHAR or TEXT")]
    [InlineData("SELECT {Product}.[CreatedOn]::datetime FROM {Product}", "DATETIME is a SQL Server type; PostgreSQL (ODC) has no such type: use TIMESTAMP")]
    [InlineData("SELECT CONVERT(VARCHAR(10), {Product}.[CreatedOn], 103) FROM {Product}", "CONVERT(VARCHAR, x) is SQL Server; PostgreSQL (ODC) uses CAST(x AS type)")]
    [InlineData("SELECT {Product}.[Name] + ' ' + {Product}.[Name] FROM {Product}", "'+' does not concatenate text in PostgreSQL (ODC) ({Product}.[Name] is Text); use || or CONCAT(...)")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] LIKE '%' + 'a' + '%'", "'+' does not concatenate text in PostgreSQL (ODC) (a text literal is an operand)")]
    [InlineData("SELECT {Product}.[Price] + ', ' FROM {Product}", "'+' does not concatenate text in PostgreSQL (ODC) (a text literal is an operand)")]
    [InlineData("SELECT {Product}.[Name] AS [ProductName] FROM {Product}", "[ProductName] is SQL Server identifier quoting; PostgreSQL (ODC) has no [name] syntax")]
    [InlineData("SELECT {Product}.[Name] [ProductName] FROM {Product}", "[ProductName] is SQL Server identifier quoting")]
    [InlineData("UPDATE {Product} SET [Price] = 0 WHERE {Product}.[Id] = 1", "[Price] is SQL Server identifier quoting")]
    [InlineData("SELECT P.[Name] FROM {Product} P", "[Name] is SQL Server identifier quoting")]
    [InlineData("SELECT {Product}.* FROM {Product} WITH (NOLOCK)", "table hints (WITH (NOLOCK)) are SQL Server; PostgreSQL (ODC) has none")]
    [InlineData("SELECT {Product}.* FROM {Product} (NOLOCK)", "table hints (WITH (NOLOCK)) are SQL Server")]
    [InlineData("SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Id] OPTION (RECOMPILE)", "OPTION (...) query hints are SQL Server")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[IsActive] = 1", "{Product}.[IsActive] is Boolean and is compared with the number 1; PostgreSQL (ODC) has no boolean = integer operator")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE 0 <> {Product}.[IsActive]", "{Product}.[IsActive] is Boolean and is compared with the number 0")]
    [InlineData("SELECT {Sex}.* FROM {Sex} WHERE {Sex}.[Is_Active] = 1", "{Sex}.[Is_Active] is Boolean and is compared with the number 1")]
    [InlineData("DELETE FROM {Product} OUTPUT DELETED.Id WHERE {Product}.[Price] < 0", "OUTPUT INSERTED/DELETED is SQL Server; PostgreSQL (ODC) returns rows with RETURNING")]
    [InlineData("SELECT {Product}.* FROM {Product} CROSS APPLY (SELECT {Code}.[Label] FROM {Code} WHERE {Code}.[Label] = {Product}.[Name]) C", "CROSS APPLY is SQL Server; PostgreSQL (ODC) uses CROSS JOIN LATERAL")]
    [InlineData("SELECT {Product}.[Name] FROM {Product} FOR JSON PATH", "FOR JSON is SQL Server")]
    [InlineData("SELECT STRING_AGG({Product}.[Name], ', ') WITHIN GROUP (ORDER BY {Product}.[Name]) FROM {Product}", "PostgreSQL (ODC) orders inside the call: STRING_AGG(x, ', ' ORDER BY y)")]
    [InlineData("SET NOCOUNT ON\nSELECT {Product}.* FROM {Product}", "SET NOCOUNT is SQL Server")]
    [InlineData("DECLARE @Total DECIMAL(18,2) = 0;\nSELECT {Product}.* FROM {Product} WHERE {Product}.[Price] > @Total", "DECLARE @Total is a T-SQL variable")]
    [InlineData("IF EXISTS (SELECT 1 FROM {Product}) SELECT {Product}.* FROM {Product}", "IF is a T-SQL statement")]
    [InlineData("SELECT {Product}.* INTO #Recent FROM {Product}", "#Recent is a SQL Server temporary table")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] !< 1", "'!<' is a SQL Server operator; PostgreSQL (ODC) uses >=")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] = \"abc\"", "\"abc\" is a quoted identifier (a column name) in PostgreSQL, not a text literal")]
    [InlineData("SELECT {Product}.`Name` FROM {Product}", "PostgreSQL (ODC) uses \"name\"")]
    public void PostgresRefusalsAreReportedInOdcAndNotInO11(string statement, string reason)
    {
        Assert.Contains(reason, Single(RawJob(statement), "odc"));
        Assert.DoesNotContain(Errors(RawJob(statement)), e => e.Contains(reason));
    }

    [Theory]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[IsActive] = TRUE ORDER BY {Product}.[Name] LIMIT 10 OFFSET 5")]
    [InlineData("SELECT {Product}.[Name] || ' ' || {Product}.[Name] AS \"Label\" FROM {Product} WHERE {Product}.[Name] ILIKE 'a%' AND NOT {Product}.[IsActive]")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[CreatedOn] < NOW() - INTERVAL '30 days' AND COALESCE({Product}.[Price], 0) > 0")]
    [InlineData("SELECT {Product}.[Price]::int, CAST({Product}.[Price] AS TEXT), LENGTH({Product}.[Name]), EXTRACT(YEAR FROM {Product}.[CreatedOn]) AS year FROM {Product}")]
    [InlineData("SELECT X.* FROM (SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Name] LIMIT 5) X")]
    [InlineData("SELECT {Product}.[Price] + 1, {Product}.[CreatedOn] + INTERVAL '1 day', {Product}.[CreatedOn] + '1 day', 1 + '2' FROM {Product}")]
    [InlineData("SELECT (STRING_TO_ARRAY({Product}.[Name], ','))[1] AS \"First\", ARRAY[1, 2] AS \"Pair\", '{1,2}'::int[] FROM {Product}")]
    [InlineData("SELECT STRING_AGG({Product}.[Name], ', ' ORDER BY {Product}.[Name]) FROM {Product}")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[IsActive] AND {Product}.[Price] > 0 ORDER BY {Product}.[Price] USING >")]
    [InlineData("SELECT E'it\\'s' AS \"T\", $$O'Brien$$ AS \"N\", $tag$a ' b$tag$ FROM {Product}")]
    [InlineData("DELETE FROM {Product} WHERE {Product}.[Price] < 0 RETURNING {Product}.[Id]")]
    [InlineData("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] = 1 AND {Product}.[SexId] <> 0 AND {Product}.[IsActive] = FALSE")]
    [InlineData("SELECT {Product}.* FROM {Product} ORDER BY {Product}.[Id] OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY")]
    [InlineData("WITH C AS (SELECT {Product}.[Id] FROM {Product} ORDER BY {Product}.[Id]) SELECT {Product}.* FROM {Product} WHERE {Product}.[Id] IN (SELECT C.Id FROM C)")]
    [InlineData("SELECT")]
    [InlineData("SELECT 1")]
    public void ValidPostgresPasses(string statement) => Assert.Empty(Errors(RawJob(statement), "odc"));

    [Fact]
    public void TextPlusFollowsTheDeclaredParameterTypes()
    {
        // A Text parameter with a text operand has no '+' in PostgreSQL; with a number it may still be read as a number.
        Assert.Contains("(a text literal is an operand)", Single(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] LIKE '%' + @Term", ("Term", "Text", false)), "odc"));
        Assert.Contains("(Text parameter and text operand)", Single(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] = @First + @Last", ("First", "Text", false), ("Last", "Text", false)), "odc"));
        Assert.Contains("(Text parameter and text operand)", Single(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] = @Term + 'x'", ("Term", "Text", false)), "odc"));
        Assert.Empty(Errors(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Name] LIKE @Term || '%'", ("Term", "Text", false)), "odc"));
        Assert.Empty(Errors(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[Price] > @Min + 1", ("Min", "Decimal", false)), "odc"));
    }

    [Fact]
    public void BaseAttributesDecideBooleanAndTextRulesInTheBaseCheck()
    {
        // {Customer} is not in the job: its attribute types are read by CheckBase (tests/jobs-odc-negative/sql-odc-base-*).
        var result = SqlPreflight.Analyze(RawJob("SELECT {Customer}.* FROM {Customer}\nWHERE {Customer}.[IsVip] = 1 AND {Customer}.[Name] + '-x' <> ''"), "odc");
        Assert.Empty(result["errors"]!.AsArray());
        var open = result["unresolved"]!.AsArray().Select(x => x!["kind"] + ":" + x["entity"] + "." + x["attribute"] + "@" + x["line"] + (x["literal"] is { } l ? "=" + l : "")).ToArray();
        Assert.Contains("odc-boolean-literal:Customer.IsVip@2=1", open);
        Assert.Contains("odc-text-plus:Customer.Name@2", open);
        // The O11 lane has no such rule: bit takes 0/1 and '+' concatenates.
        Assert.DoesNotContain(SqlPreflight.Analyze(RawJob("SELECT {Customer}.* FROM {Customer} WHERE {Customer}.[IsVip] = 1"), "sqlserver")["unresolved"]!.AsArray(), x => x!["kind"]!.ToString().StartsWith("odc-"));
    }

    [Fact]
    public void ExpandInlineStatementsKeepThePostgresRules()
        => Assert.Contains("TOP does not exist in PostgreSQL", Single(RawJob("SELECT TOP 5 {Product}.* FROM {Product} WHERE @Filter", ("Filter", "Text", true)), "odc"));

    [Fact]
    public void PostgresLiteralsAreLexedInOdcOnly()
    {
        Assert.Contains("unterminated dollar-quoted string (missing the closing $q$)", Single(RawJob("SELECT $q$abc FROM {Product}"), "odc"));
        // In SQL Server E'...' has no escapes: the backslash does not protect the quote.
        Assert.Contains("unterminated string literal", Single(RawJob("SELECT E'it\\'s' FROM {Product}")));
    }

    // ---- logic spec -----------------------------------------------------------------------------

    [Fact]
    public void LogicSqlStepsAreCheckedWhereverTheyAreNested()
    {
        var ops = new JsonArray(JsonNode.Parse(Model)!, JsonNode.Parse("""
          {"op":"logic","data":{"actions":[{"name":"Product_Find","inputs":[{"name":"Term","type":"Integer"},{"name":"Deep","type":"Boolean"}],
           "steps":[{"if":"Deep","as":"IsDeep","then":[
             {"get":"Product","sql":true,"as":"Query","statement":"SELECT {Product}.* FROM {Product}\nWHERE {Product}.[Name] = @Term\nLIMIT 5",
              "params":{"Term":{"type":"Integer","value":"Term"}}}]}]}]}}
          """)!);
        var errors = Errors(ops);
        Assert.Equal(2, errors.Length);
        Assert.All(errors, e => Assert.StartsWith("op #1 (SQL in logic action 'Product_Find' get 'Query', line ", e));
        Assert.Contains(errors, e => e.Contains("line 2") && e.Contains("{Product}.[Name] is Text but @Term is declared Integer"));
        Assert.Contains(errors, e => e.Contains("line 3") && e.Contains("LIMIT"));
    }

    [Fact]
    public void JobPreflightReportsSqlErrorsAndTheOpenNames()
    {
        var result = JobPreflight.Analyze(RawJob("SELECT {Product}.* FROM {Product}, {Customer} WHERE {Product}.[Price] = NOW()"));
        Assert.False(result["valid"]!.GetValue<bool>());
        Assert.Contains(result["errors"]!.AsArray(), e => e!.ToString().Contains("NOW() is not a SQL Server function"));
        Assert.Contains(result["unresolvedSql"]!.AsArray(), x => x!["entity"]!.ToString() == "Customer");
        Assert.Equal(1, result["sqlStatements"]!.GetValue<int>());
    }

    // ---- real cases -----------------------------------------------------------------------------

    /// <summary>
    /// Horsie_CS (personal-2qqw9srv, 2026-10-04): TrueChange 0/0 and the Studio publish failed. Its two SQL queries
    /// (Discovery_Query and Message_UnreadCount, from kernel/.local/jobs/horsie-cs-actions.json, with the attributes of
    /// horsie-cs-datamodel.json) are valid SQL Server: the preflight must not refuse them, so the SQL is not what broke
    /// that publish (the publish message itself is read by phase 1, `publish-log`).
    /// </summary>
    [Fact]
    public void HorsieSqlIsValidAndPasses()
    {
        var result = SqlPreflight.Analyze(HorsieOps(), "sqlserver");
        Assert.Empty(result["errors"]!.AsArray());
        Assert.Empty(result["unresolved"]!.AsArray());
        Assert.Equal(2, result["sqlStatements"]!.GetValue<int>());
    }

    /// <summary>
    /// The same Horsie_CS SQL in the ODC lane: valid SQL Server, refused by PostgreSQL. Boolean attributes compared with
    /// 1 (no boolean = integer operator) and YEAR(GETDATE()) (neither function exists) fail when the query runs.
    /// </summary>
    [Fact]
    public void HorsieSqlIsRefusedInOdc()
    {
        var errors = Errors(HorsieOps(), "odc");
        Assert.All(errors, e => Assert.StartsWith("op #1 (SQL in logic action '", e));
        Assert.Contains(errors, e => e.Contains("'Discovery_Query'") && e.Contains("{Horse}.[IsActive] is Boolean and is compared with the number 1"));
        Assert.Contains(errors, e => e.Contains("{Horse}.[IsStudbookVerified] is Boolean and is compared with the number 1"));
        Assert.Contains(errors, e => e.Contains("YEAR() is SQL Server"));
        Assert.Contains(errors, e => e.Contains("GETDATE() is SQL Server"));
        Assert.Contains(errors, e => e.Contains("'Message_UnreadCount'") && e.Contains("{Match}.[IsActive] is Boolean and is compared with the number 1"));
        Assert.Equal(5, errors.Length);
    }

    private static JsonArray HorsieOps()
    {
        return new JsonArray(JsonNode.Parse("""
          {"op":"spec","data":{
            "static":[{"name":"Sex","records":[{"name":"Mare"}]},{"name":"Breed","records":[{"name":"Arabian"}]},{"name":"Discipline","records":[{"name":"Trail"}]}],
            "entities":[
              {"name":"Horse","attributes":[{"name":"UserId","type":"User Identifier"},{"name":"Name","type":"Text","length":50},
                {"name":"SexId","type":"Sex Identifier"},{"name":"BreedId","type":"Breed Identifier"},{"name":"DisciplineId","type":"Discipline Identifier"},
                {"name":"FoaledYear","type":"Integer"},{"name":"Height","type":"Decimal"},{"name":"IsStudbookVerified","type":"Boolean"},
                {"name":"IsBot","type":"Boolean"},{"name":"IsActive","type":"Boolean"},{"name":"CreatedOn","type":"Date Time"}]},
              {"name":"Swipe","attributes":[{"name":"FromHorseId","type":"Horse Identifier"},{"name":"ToHorseId","type":"Horse Identifier"}]},
              {"name":"Match","attributes":[{"name":"HorseAId","type":"Horse Identifier"},{"name":"HorseBId","type":"Horse Identifier"},{"name":"IsActive","type":"Boolean"}]},
              {"name":"Message","attributes":[{"name":"MatchId","type":"Match Identifier"},{"name":"SenderHorseId","type":"Horse Identifier"},
                {"name":"Text","type":"Text","length":1000},{"name":"ReadOn","type":"Date Time"}]},
              {"name":"Block","attributes":[{"name":"BlockerHorseId","type":"Horse Identifier"},{"name":"BlockedHorseId","type":"Horse Identifier"}]}],
            "structures":[{"name":"DiscoveryPreference","attributes":[{"name":"SexId","type":"Sex Identifier"}]}]}}
          """)!, JsonNode.Parse("""
          {"op":"logic","data":{"actions":[
           {"name":"Discovery_Query","inputs":[{"name":"MeId","type":"Horse Identifier"}],"steps":[
            {"get":"Horse","sql":true,"as":"Query",
             "statement":"SELECT {Horse}.* FROM {Horse} WHERE {Horse}.[IsActive] = 1 AND {Horse}.[Id] <> @Me AND (@SexId IS NULL OR @SexId = 0 OR {Horse}.[SexId] = @SexId) AND (@BreedId IS NULL OR @BreedId = 0 OR {Horse}.[BreedId] = @BreedId) AND (@DisciplineId IS NULL OR @DisciplineId = 0 OR {Horse}.[DisciplineId] = @DisciplineId) AND (YEAR(GETDATE()) - {Horse}.[FoaledYear]) BETWEEN @AgeMin AND @AgeMax AND {Horse}.[Height] BETWEEN @HeightMin AND @HeightMax AND (@StudbookOnly = 0 OR {Horse}.[IsStudbookVerified] = 1) AND NOT EXISTS (SELECT 1 FROM {Swipe} WHERE {Swipe}.[FromHorseId] = @Me AND {Swipe}.[ToHorseId] = {Horse}.[Id]) AND NOT EXISTS (SELECT 1 FROM {Block} WHERE ({Block}.[BlockerHorseId] = @Me AND {Block}.[BlockedHorseId] = {Horse}.[Id]) OR ({Block}.[BlockerHorseId] = {Horse}.[Id] AND {Block}.[BlockedHorseId] = @Me)) ORDER BY {Horse}.[IsBot] ASC, {Horse}.[CreatedOn] DESC",
             "params":{"Me":{"type":"Horse Identifier","value":"MeId"},"SexId":{"type":"Sex Identifier","value":"1"},"BreedId":{"type":"Breed Identifier","value":"1"},
              "DisciplineId":{"type":"Discipline Identifier","value":"1"},"AgeMin":{"type":"Integer","value":"3"},"AgeMax":{"type":"Integer","value":"20"},
              "HeightMin":{"type":"Decimal","value":"13"},"HeightMax":{"type":"Decimal","value":"17"},"StudbookOnly":{"type":"Boolean","value":"False"}},"max":"20"}]},
           {"name":"Message_UnreadCount","inputs":[{"name":"MeId","type":"Horse Identifier"}],"steps":[
            {"get":"Message","sql":true,"as":"Query",
             "statement":"SELECT {Message}.* FROM {Message} INNER JOIN {Match} ON {Match}.[Id] = {Message}.[MatchId] WHERE {Match}.[IsActive] = 1 AND ({Match}.[HorseAId] = @Me OR {Match}.[HorseBId] = @Me) AND {Message}.[SenderHorseId] <> @Me AND ({Message}.[ReadOn] IS NULL OR {Message}.[ReadOn] = '1900-01-01')",
             "params":{"Me":{"type":"Horse Identifier","value":"MeId"}},"max":999}]}]}}
          """)!);
    }

    /// <summary>
    /// virtual-game-store (2026-09-04, tests/jobs-cold): the first SQL generation used an OutSystems expression inside SQL
    /// and wrote the parameter inside the attribute brackets. Both are refused now, before any model is loaded.
    /// </summary>
    [Fact]
    public void ColdSessionSqlMistakesAreRefused()
    {
        var expression = Single(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[SexId] = {GetCart}.[List].{Current}.[Cart].Id"));
        Assert.Contains("line 1", expression);
        Assert.Contains("{GetCart}.[List].{Current} reads like an OutSystems expression", expression);
        var open = SqlPreflight.Analyze(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[SexId] = {GetCart}.[List].{Current}.[Cart].Id"), "sqlserver")["unresolved"]!.AsArray();
        Assert.Contains(open, x => x!["entity"]!.ToString() == "GetCart");
        Assert.Contains("[@Min] is not an attribute of {Product}", Errors(RawJob("SELECT {Product}.* FROM {Product} WHERE {Product}.[@Min] = @Min", ("Min", "Decimal", false)))[0]);
    }

    /// <summary>
    /// Found by this preflight in the repository: the last generations of the same cold session (-v6/-v7; the UI session
    /// read -v7 as the Headless_CS contract) have a GetRefunds query with three '(' and two ')' in its second EXISTS group.
    /// TrueChange has no error rule for SQL syntax (its parser at most warns, SQL_Unrecognized); SQL Server refuses the
    /// statement (Incorrect syntax) when the query runs.
    /// </summary>
    [Fact]
    public void ColdSessionUnbalancedSqlIsRefused()
    {
        var dir = Path.Combine(Root, "tests", "jobs-cold");
        var ops = JobRunner.CollectOps(JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "virtual-game-store-all-sql-v7.json")))!, dir);
        var error = Assert.Single(SqlPreflight.Analyze(ops, "sqlserver")["errors"]!.AsArray())!.GetValue<string>();
        Assert.Equal("op #73 (SQL in logic action 'Admin_GetSalesDashboard' get 'GetRefunds', line 1): '(' is never closed near \"(@GameId = 0 OR EXISTS (SELECT 1 FROM {O\"", error);
    }

    // ---- no false positives on the repository's jobs ------------------------------------------

    public static IEnumerable<object[]> JobFolders() => new[]
    {
        new object[] { "jobs", "sqlserver" }, new object[] { "jobs-live", "sqlserver" }, new object[] { "jobs-coverage/o11", "sqlserver" },
        new object[] { "jobs-coverage-f2/o11", "sqlserver" }, new object[] { "jobs-odc", "odc" }, new object[] { "jobs-coverage/odc", "odc" },
        new object[] { "jobs-coverage-f2/odc", "odc" }, new object[] { "jobs-cold", "sqlserver" },
    };

    /// <summary>History files of a cold session that kept its failing generations (the fixed one is -v7).</summary>
    private static readonly Dictionary<string, string> KnownBroken = new(StringComparer.OrdinalIgnoreCase)
    {
        ["virtual-game-store-all-sql"] = "first generation: [@Param] inside attribute brackets and OutSystems expressions in SQL",
        ["virtual-game-store-all-sql-v6"] = "GetRefunds: unbalanced parenthesis (ColdSessionUnbalancedSqlIsRefused)",
        ["virtual-game-store-all-sql-v7"] = "GetRefunds: unbalanced parenthesis (ColdSessionUnbalancedSqlIsRefused)",
    };

    [Theory]
    [MemberData(nameof(JobFolders))]
    public void RepositoryJobsPassTheSqlPreflight(string folder, string dialect)
    {
        var dir = Path.Combine(Root, "tests", folder);
        if (!Directory.Exists(dir)) return;
        var failures = new List<string>(); var statements = 0; var clock = System.Diagnostics.Stopwatch.StartNew();
        foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(x => x, StringComparer.Ordinal))
        {
            JsonArray ops;
            try { ops = JobRunner.CollectOps(JsonNode.Parse(File.ReadAllText(file))!, dir); }
            catch { continue; }   // not a job, or a composite whose parts live elsewhere
            var result = SqlPreflight.Analyze(ops, dialect);
            statements += result["sqlStatements"]!.GetValue<int>();
            var name = Path.GetFileNameWithoutExtension(file);
            var errors = result["errors"]!.AsArray();
            if (KnownBroken.ContainsKey(name)) { if (errors.Count == 0) failures.Add(name + " is listed as broken but passes: " + KnownBroken[name]); continue; }
            failures.AddRange(errors.Select(e => name + ": " + e));
        }
        output.WriteLine($"{folder}: {statements} SQL statements in {clock.ElapsedMilliseconds} ms");
        Assert.True(failures.Count == 0, string.Join(Environment.NewLine, failures));
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(SqlPreflightTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
