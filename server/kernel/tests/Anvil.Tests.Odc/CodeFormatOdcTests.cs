using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// A formatacao do codigo na escrita, faixa ODC (tests/jobs-odc/code-format.json, espelho de
/// tests/jobs/code-format-reactive.json): o CSS cai formatado na metade do AUTOR do tema (que tem CSS do Theme Editor),
/// o Statement do no SQL e o JavaScript do no e do Script ficam em varias linhas, o SQL que a prova recusa fica como veio
/// (FORMAT_SKIPPED) e o recibo lista cada texto formatado. Precisa do ODC Studio.
/// </summary>
public sealed class CodeFormatOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work");
    private static readonly Lazy<JsonObject?> Applied = new(Run);

    [Fact]
    public void TheStoredCodeIsMultiLineAndTheThemeCssLandsInTheAuthorHalf()
    {
        if (Applied.Value is not { } result) return;
        Assert.True(result["accepted"]!.GetValue<bool>(), string.Join("\n", result["policyMessages"]!.AsArray().Select(m => m!.ToString())));
        var gets = Gets(result);

        var author = Property(gets[0], "UserStyleSheet").Replace("\r\n", "\n");
        Assert.StartsWith("/* code-format */\n.cf-card {\n    display: flex;\n    align-items: center;", author);
        Assert.Contains("@media (max-width:768px) {\n    .cf-card {\n        padding: 4px\n    }\n}", author);
        Assert.Equal(Property(gets[0], "GeneratedStyleSheet") + "\r\n" + Property(gets[0], "UserStyleSheet"), Property(gets[0], "StyleSheet"));

        var sql = Property(gets[1], "Statement").Replace("\r\n", "\n");
        Assert.Equal("SELECT\n    {CfItem}.[Id],\n    {CfItem}.[Name],\n    {CfItem}.[Quantity]\nFROM {CfItem}\n"
            + "WHERE {CfItem}.[Quantity] >= @Minimum\n    AND {CfItem}.[Name] <> 'select from where'\nORDER BY {CfItem}.[Name]", sql);

        var js = Property(gets[3], "JavaScript").Replace("\r\n", "\n");
        Assert.StartsWith("function fmt(v) {\n    var re=/[;{}]/g;\n", js);
        Assert.EndsWith("}\n$parameters.Out=fmt($parameters.In);", js);

        var script = Property(gets[4], "JavaScript").Replace("\r\n", "\n");
        Assert.Contains("\n    return String(s || \"\").trim().toUpperCase();\n", script);
    }

    [Fact]
    public void TheRefusedSqlIsStoredAsWrittenAndTheReceiptSaysWhatWasFormatted()
    {
        if (Applied.Value is not { } result) return;
        Assert.Equal("SELECT {CfItem}.[Id], {CfItem}.[Name], {CfItem}.[Quantity] FROM {CfItem} WHERE {CfItem}.[Name] = 'x'AND {CfItem}.[Quantity] > 0 ORDER BY {CfItem}.[Name]",
            Property(Gets(result)[2], "Statement"));
        var note = Assert.Single(result["notes"]!.AsArray(), n => n!["code"]!.ToString() == "FORMAT_SKIPPED");
        Assert.Contains("ReadCoded", note!["message"]!.ToString());
        var formatted = result["formatted"]!.AsArray().Select(f => f!.AsObject()).ToList();
        Assert.Equal(["css", "sql", "javascript", "javascript"], formatted.Select(f => f["language"]!.ToString()));
        Assert.All(formatted, f => Assert.True(f["linesAfter"]!.GetValue<int>() > f["linesBefore"]!.GetValue<int>(), f.ToJsonString()));
    }

    private static JsonObject? Run()
    {
        if (!StudioAvailable()) return null;
        var jobPath = Path.Combine(Root, "tests", "jobs-odc", "code-format.json");
        var outPath = Path.Combine(Work, "code-format.codeformat.oml");
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), null, jobPath, outPath))!.AsObject();
    }

    private static List<JsonObject> Gets(JsonObject result) => result["results"]!.AsArray()
        .Where(o => o!["op"]!.ToString() == "get").Select(o => o!["result"]!["properties"]!.AsObject()).ToList();

    private static string Property(JsonObject properties, string name) => properties[name]?.ToString() ?? throw new InvalidOperationException($"no {name} in {string.Join(", ", properties.Select(p => p.Key))}");

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CodeFormatOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
