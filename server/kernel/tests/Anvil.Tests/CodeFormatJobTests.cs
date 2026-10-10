using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// A formatacao do codigo na escrita, faixa O11 (tests/jobs/code-format-reactive.json): o CSS do tema, o Statement do no
/// SQL, o JavaScript do no JavaScript e o do Script chegam numa linha so e o modelo guarda-os em varias linhas; o SQL que
/// a prova recusa fica como veio, com FORMAT_SKIPPED; o recibo lista cada texto formatado. Precisa do Service Studio.
/// </summary>
public sealed class CodeFormatJobTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "test-work");
    private static readonly Lazy<JsonObject?> Applied = new(Run);

    [Fact]
    public void TheJobIsAcceptedAndTheStoredCodeIsMultiLine()
    {
        if (Applied.Value is not { } result) return;
        Assert.True(result["accepted"]!.GetValue<bool>(), string.Join("\n", result["policyMessages"]!.AsArray().Select(m => m!.ToString())));
        var gets = Gets(result);

        var css = Property(gets[0], "StyleSheet");
        Assert.Contains("/* code-format */\n.cf-card {\n    display: flex;\n    align-items: center;", css);
        Assert.Contains("@media (max-width:768px) {\n    .cf-card {\n        padding: 4px\n    }\n}", css);

        var sql = Property(gets[1], "Statement").Replace("\r\n", "\n");
        Assert.Equal("SELECT\n    {CfItem}.[Id],\n    {CfItem}.[Name],\n    {CfItem}.[Quantity]\nFROM {CfItem}\n"
            + "WHERE {CfItem}.[Quantity] >= @Minimum\n    AND {CfItem}.[Name] <> 'select from where'\nORDER BY {CfItem}.[Name]", sql);

        var js = Property(gets[3], "JavaScript").Replace("\r\n", "\n");
        Assert.StartsWith("function fmt(v) {\n    var re=/[;{}]/g;\n", js);
        Assert.EndsWith("}\n$parameters.Out=fmt($parameters.In);", js);

        var script = Property(gets[4], "JavaScript").Replace("\r\n", "\n");
        Assert.True(script.Split('\n').Length > 1, script);
        Assert.Contains("\n    return String(s || \"\").trim().toUpperCase();\n", script);
    }

    [Fact]
    public void TheSqlTheProofRefusesIsStoredAsWrittenWithFormatSkipped()
    {
        if (Applied.Value is not { } result) return;
        var stored = Property(Gets(result)[2], "Statement");
        Assert.Equal("SELECT {CfItem}.[Id], {CfItem}.[Name], {CfItem}.[Quantity] FROM {CfItem} WHERE {CfItem}.[Name] = 'x'AND {CfItem}.[Quantity] > 0 ORDER BY {CfItem}.[Name]", stored);
        var note = Assert.Single(result["notes"]!.AsArray(), n => n!["code"]!.ToString() == "FORMAT_SKIPPED");
        Assert.Contains("ReadCoded", note!["message"]!.ToString());
    }

    [Fact]
    public void TheReceiptListsEachFormattedText()
    {
        if (Applied.Value is not { } result) return;
        var formatted = result["formatted"]!.AsArray().Select(f => f!.AsObject()).ToList();
        Assert.Equal(["css", "sql", "javascript", "javascript"], formatted.Select(f => f["language"]!.ToString()));
        Assert.All(formatted, f => Assert.Equal(1, f["linesBefore"]!.GetValue<int>()));
        Assert.All(formatted, f => Assert.True(f["linesAfter"]!.GetValue<int>() > 3, f.ToJsonString()));
        Assert.Contains("ReadCfItems", formatted[1]["element"]!.ToString());
        Assert.Contains("FormatJS", formatted[2]["element"]!.ToString());
    }

    /// <summary>O bloco de CSS que o op html instala no tema (uma regra por linha, longa, na serializacao do escopo)
    /// tambem chega formatado, entre os mesmos marcadores, e o recibo nomeia o tema e a tela.</summary>
    [Fact]
    public void TheHtmlOpInstallsItsScopedCssFormatted()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "code-format-html"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var first = Path.Combine(dir, "dashboard.oml");
        var created = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Path.Combine(Root, "tests", "jobs", "html-dashboard-reactive.json"), first))!.AsObject();
        Assert.True(created["accepted"]!.GetValue<bool>());
        Assert.True(created["formatted"] is JsonArray all && all.Any(f => f!["element"]!.ToString().Contains("(html Dashboard)", StringComparison.Ordinal)), "formatted: " + created["formatted"]?.ToJsonString() + " notes: " + created["notes"]?.ToJsonString());
        var entry = Assert.Single(created["formatted"]!.AsArray(), f => f!["element"]!.ToString().Contains("(html Dashboard)", StringComparison.Ordinal));
        Assert.Equal("css", entry!["language"]!.ToString());
        Assert.True(entry["linesAfter"]!.GetValue<int>() > entry["linesBefore"]!.GetValue<int>());

        var read = Path.Combine(dir, "read-theme.json");
        File.WriteAllText(read, """{"ops":[{"op":"get","target":"IMobileTheme:Headless_UI"}]}""");
        var theme = JsonSerializer.SerializeToNode(JobRunner.Run(host, first, read, Path.Combine(dir, "read.oml")))!.AsObject();
        var css = Property(Gets(theme)[0], "StyleSheet").Replace("\r\n", "\n");
        var begin = css.IndexOf("/* anvil:html Dashboard */", StringComparison.Ordinal);
        var end = css.IndexOf("/* /anvil:html Dashboard */", StringComparison.Ordinal);
        Assert.True(begin >= 0 && end > begin, css);
        var block = css[begin..end];
        Assert.Contains(".av-dashboard .metric-value {\n    ", block);
        Assert.DoesNotContain(block.Split('\n'), line => line.Length > CodeFormat.LongLine && CodeFormat.Units(CodeLanguage.Css, line) >= 2);
    }

    private static JsonObject? Run()
    {
        if (!StudioAvailable()) return null;
        var jobPath = Path.Combine(Root, "tests", "jobs", "code-format-reactive.json");
        var outPath = Path.Combine(Work, "code-format-reactive.codeformat.oml");
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), null, jobPath, outPath))!.AsObject();
    }

    internal static List<JsonObject> Gets(JsonObject result) => result["results"]!.AsArray()
        .Where(o => o!["op"]!.ToString() == "get").Select(o => o!["result"]!["properties"]!.AsObject()).ToList();

    internal static string Property(JsonObject properties, string name) => properties[name]?.ToString() ?? throw new InvalidOperationException($"no {name} in {string.Join(", ", properties.Select(p => p.Key))}");

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CodeFormatJobTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
