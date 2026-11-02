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

    /// <summary>C-16 (F-FigmaReactive-08, F-AiChatbot-07a, F-Jesse-08, F-FT-19): the &lt;style&gt; of an html edit is the CSS as the
    /// author wrote it. The Fitmaker sheet was written one rule per line; the first edit stored it one property per line (1385 ->
    /// 4596 lines) and the next edit's find no longer matched. Now the stored sheet, read back, is the text sent, and the receipt
    /// lists no formatting of it.</summary>
    [Fact]
    public void AnHtmlEditWritesTheStyleSheetOfTheScreenAsWritten()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Work, "code-format-html-edit"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var basePath = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var bytes = File.ReadAllBytes(basePath);
        var read = host.HtmlRead(bytes, "Login", withKeys: false);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        // Rules of the Fitmaker sheet as the session wrote them: one rule per line, each longer than CodeFormat.LongLine.
        const string css = ".fm-hero{display:flex;align-items:center;justify-content:space-between;gap:48px;padding:96px 120px 64px;background:#0b0b0b;color:#ffffff}\n"
            + ".fm-footer .fm-logo-lg{font-family:'Bebas Neue',sans-serif;font-size:64px;letter-spacing:2px;line-height:1;color:#c6f432;margin:0 0 24px 0}\n"
            + ".fm-card{border-radius:24px;box-shadow:0 8px 24px rgba(0,0,0,.24);overflow:hidden;background:linear-gradient(180deg,#1b1b1b 0%,#0b0b0b 100%)}";
        Assert.True(css.Split('\n').All(line => line.Length > CodeFormat.LongLine && CodeFormat.Units(CodeLanguage.Css, line) >= 2));
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject {
            ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
                ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
                ["edit"] = new JsonArray("<style>" + css + "</style>") } }) };
        var jobPath = Path.Combine(dir, "style-edit.json"); File.WriteAllText(jobPath, job.ToJsonString());
        var outPath = Path.Combine(dir, "style-edit.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.DoesNotContain(result["formatted"] as JsonArray ?? new JsonArray(), f => f!["language"]?.ToString() == "css");
        var after = host.HtmlRead(File.ReadAllBytes(outPath), "Login", withKeys: false)["documents"]![0]!["html"]!.ToString().Replace("\r\n", "\n");
        Assert.Contains("<style>" + css + "</style>", after);
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
