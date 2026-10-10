using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class SqlContractTests
{
    [Theory]
    [InlineData("SELECT @A, @a, @B", "A,B")]
    [InlineData("SELECT '@Ignored', @Actual", "Actual")]
    [InlineData("SELECT 'it''s @Ignored', @Actual", "Actual")]
    [InlineData("SELECT @A -- @Ignored\n, @B", "A,B")]
    [InlineData("SELECT /* @Ignored */ @A", "A")]
    [InlineData("SELECT @@ROWCOUNT", "ROWCOUNT")]
    [InlineData("SELECT '-- @Ignored /* x */', @A", "A")]
    public void ParameterScanIgnoresCommentsAndLiteralsButMatchesStudioDoubleAt(string sql, string expected)
        => Assert.Equal(expected.Split(','), SqlChecks.Parameters(sql).OrderBy(x => x, StringComparer.Ordinal));

    [Fact]
    public void ParameterMismatchReportsBothSidesAndUsesCaseInsensitiveNames()
    {
        SqlChecks.Validate("SELECT @A", new[] { "a" }, "probe");
        var error = Assert.Throws<InvalidOperationException>(() => SqlChecks.Validate("SELECT @Missing", new[] { "Unused" }, "probe"));
        Assert.Contains("used but not declared: Missing", error.Message);
        Assert.Contains("declared but not used: Unused", error.Message);
        Assert.Throws<InvalidOperationException>(() => SqlChecks.Validate("SELECT @A", new[] { "A", "a" }, "probe"));
    }

    [Theory]
    [InlineData("where")]
    [InlineData("sort")]
    [InlineData("start")]
    public void SqlRejectsOptionsThatWouldBeSilentlyIgnored(string key)
    {
        var step = JsonNode.Parse("""{"get":"Product","as":"ReadProducts","sql":true,"statement":"SELECT {Product}.* FROM {Product}"}""")!.AsObject();
        step[key] = "0";
        var spec = new JsonObject { ["actions"] = new JsonArray(new JsonObject { ["name"] = "Probe", ["steps"] = new JsonArray(step) }) };
        Assert.Contains("cannot be used with sql:true", Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(spec)).Message);
    }

    [Fact]
    public void SelfAssignmentFromSqlConversionIsRejected()
    {
        var spec = JsonNode.Parse("""{"actions":[{"name":"Probe","steps":[{"assign":{"SqlRecord1":" SqlRecord1 "},"as":"LoadSqlRecord1"}]}]}""")!.AsObject();
        var error = Assert.Throws<InvalidOperationException>(() => LogicExpander.Expand(spec));
        Assert.Contains("LoadSqlRecord1", error.Message);
        Assert.Contains("does nothing", error.Message);
    }

    [Fact]
    public void SuggestionsUseOnlyTheProvidedPropertyNames()
    {
        var names = new[] { "StartIndex", "MaxRecords", "Statement" };
        var suggestions = NameSuggestions.Closest("MaxRecord", names);
        Assert.Equal("MaxRecords", suggestions[0]);
        Assert.Empty(suggestions.Except(names));
    }

    [Fact]
    public void RawSqlUnknownParameterIsRefusedAgainstTheBaseBeforeApply()
    {
        // Before the SQL preflight this came only from Verify (InvalidSQL_UnknownParam), after mutating the model.
        if (!StudioAvailable()) return;
        var root = Root();
        var work = Path.Combine(root, ".local", "sql-contract-tests");
        var ex = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(work), null,
            Path.Combine(root, "tests", "jobs-negative", "sql-unknown-param.json"), Path.Combine(work, "unknown.oml")));
        var text = Errors.Text(ex);
        Assert.Contains("op #0 (SQL IServerAction:Product_Search/SearchProducts, line 1)", text);
        Assert.Contains("@Missing is used but the SQL node declares no parameter 'Missing' (declared: MinPrice)", text);
    }

    [Fact]
    public void PropertyErrorListsExpressionsAndApiInsteadOfBuiltinFunctions()
    {
        if (!StudioAvailable()) return;
        var root = Root();
        var work = Path.Combine(root, ".local", "sql-contract-tests"); Directory.CreateDirectory(work);
        var job = Path.Combine(work, "property.json");
        File.WriteAllText(job, """{"base":"reactive-ui.oml","ops":[{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"PropertyProbe","as":"$s"},{"op":"create","parent":"$s/#IMobileBlockInstanceWidget/MainContent","type":"IDropdown","as":"$d"},{"op":"set","target":"$d","prop":"Prompt","value":"\"Pick\""}]}""");
        var ex = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "property.oml")));
        var text = Errors.Text(ex);
        Assert.Contains("expression.Text:", text);
        Assert.Contains("EmptyValue", text);
        Assert.Contains("see anvil api --name IDropdown", text);
        Assert.DoesNotContain("CurrDateTime", text);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
    private static string Root()
    {
        var dir = Path.GetDirectoryName(typeof(SqlContractTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
