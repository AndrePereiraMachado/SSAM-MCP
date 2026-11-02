using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>F8 over the reactive fixture with the Service Studio (skipped without it): a table the html op writes renders with its
/// header and its rows in one grid in every form (the document, the fragment, the edit of a reading) and with any theme (one of
/// this module: the native layout block; one of another module: the List's inline display). A data table (one header row of
/// &lt;th&gt;, one template row of &lt;td&gt; over a list) is the native Table and stays it; the tables here are the shapes that stay HTML
/// Elements with a List (a body of two rows, a &lt;tr list&gt; without header, a list of the page). The ODC mirror is
/// ScreenVisualTableOdcTests.</summary>
public sealed class ScreenVisualTableJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenVisualTableJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-visual-tables");

    private static string Screen(string name, string flow, string body) => $"<screen name=\"{name}\" roles=\"Registered\" flow=\"{flow}\">\n<var name=\"Rows\" type=\"Text List\"/>\n"
        + "<Block name=\"LayoutBlank\"><slot name=\"Content\">\n" + body + "</slot></Block>\n</screen>";

    private const string Tables = "<table class=\"vt-two\"><thead><tr><th>A</th></tr></thead><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr><tr><td>-</td></tr></tbody></table>\n"
        + "<table class=\"vt-empty\"><thead><tr><th>B</th></tr></thead></table>\n"
        + "<ul list=\"Rows\"><li>{{ Rows.Current }}</li></ul>\n"
        // The shape of the delivery of 2026-10-25 (task 309723dc): a List of the row, lifted to its row group.
        + "<table class=\"vt-rows\"><tbody><tr list=\"Rows\" class=\"vt-row\"><td>{{ Rows.Current }}</td></tr></tbody></table>\n"
        // A data table: the native Table of the line, untouched by this rule.
        + "<table class=\"vt-native\"><thead><tr><th>C</th></tr></thead><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n";

    [Fact]
    public void EveryFormWritesATableListThatRendersAsItsTablePartWithEitherTheme()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var host = Host("forms");
        JsonObject Set(string target, string prop, string value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value };
        var ops = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow", ["name"] = "VtForeignFlow", ["as"] = "$foreign" },
            Set("$foreign", "Theme", "MobileThemeSignature:OutSystemsUI"),
            Html(Screen("VtTables", "MainFlow", Tables)),
            Html(Screen("VtForeign", "VtForeignFlow", Tables)));
        var outPath = Path.Combine(Work, "forms", "out.oml");
        var result = Run(host, null, Job(ops, "forms"), outPath);
        var bytes = File.ReadAllBytes(outPath);
        string Text(byte[] model, string root) => Regex.Replace(host.HtmlRead(model, root, withKeys: false)["documents"]![0]!["html"]!.ToString(), "\\s+k=\"[^\"]*\"", "");
        JsonObject Report(JsonObject job, string root) => job["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["root"]?.ToString() == root);

        // The document form, a theme of this module: Mode Custom, every row, the rows marker; the block in the theme.
        var own = Text(bytes, "VtTables");
        output.WriteLine(own);
        var body = Regex.Match(own, "<table class=\"vt-two\"[\\s\\S]*?(<tbody[^>]*>)").Groups[1].Value;
        Assert.Contains("os-Mode=\"Custom\"", body);
        Assert.Contains("disable-virtualization=\"{{ True }}\"", body);
        Assert.Contains("data-ssam-rows=\"1\"", body);
        Assert.Contains("class=\"\"", body);
        Assert.Contains("os-Mode=\"Custom\"", Regex.Match(own, "<ul[^>]*>").Value);   // any element but a div: Mode Custom
        var tables = Report(result, "VtTables")["visual"]!["tables"]!.AsArray();
        Assert.Equal(2, tables.Count);
        Assert.All(tables, t => Assert.Contains("native layout block", t!["rule"]!.ToString()));
        // The <tr list> of cells: the tbody is the List, the row a plain row with its class.
        Assert.Matches("<table class=\"vt-rows\"[^>]*>\\s*<tbody[^>]*list=\"Rows\"[^>]*os-Mode=\"Custom\"[^>]*>\\s*<tr class=\"vt-row\">\\s*<td>", own);
        Assert.Contains(Report(result, "VtTables")["normalized"]!.AsArray(), n => n!["code"]!.ToString() == "TABLE_ROW_LIST_LIFTED");
        Assert.Contains(Report(result, "VtTables")["normalized"]!.AsArray(), n => n!["code"]!.ToString() == "LIST_MODE_CUSTOM");
        // The data table is the native Table: its list on the <table>, no List of a part.
        Assert.Matches("<table list=\"Rows\" class=\"vt-native\"", own);
        // A theme of another module: the inline display, no marker without effect.
        var foreign = Regex.Match(Text(bytes, "VtForeign"), "<table class=\"vt-two\"[\\s\\S]*?(<tbody[^>]*>)").Groups[1].Value;
        output.WriteLine(foreign);
        Assert.Contains("os-Mode=\"Custom\"", foreign);
        Assert.Contains("ext:style=\"display:table-row-group\"", foreign);
        Assert.DoesNotContain("data-ssam-rows", foreign);
        Assert.Contains("inline style", Report(result, "VtForeign")["visual"]!["tables"]![0]!["rule"]!.ToString());
        // The fixed point: the reading reads back what the document wrote.
        foreach (var root in new[] { "VtTables", "VtForeign" })
            Assert.Equal(0, host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == root)!["ops"]!.GetValue<int>());

        // The edit of a reading: the empty table of the reading gets a new <tbody list> of two rows.
        var keyed = host.HtmlRead(bytes, "VtTables", withKeys: true)["documents"]![0]!;
        var html = keyed["html"]!.ToString();
        var lines = html.Split('\n');
        var start = Array.FindIndex(lines, l => l.Contains("class=\"vt-empty\"", StringComparison.Ordinal));
        var end = Array.FindIndex(lines, start, l => l.TrimStart().StartsWith("</table>", StringComparison.Ordinal));
        var edit = string.Join("\n", lines[start..end]) + "\n<tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr><tr><td>-</td></tr></tbody>\n</table>\n";
        var data = new JsonObject { ["screen"] = "VtTables", ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = keyed["htmlSha256"]!.ToString() },
            ["edit"] = new JsonArray(edit) };
        var editedPath = Path.Combine(Work, "forms", "edited.oml");
        var answer = host.HtmlEdit(bytes, data, editedPath);
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        output.WriteLine(answer["result"]!.ToJsonString());
        var edited = Text(File.ReadAllBytes(editedPath), "VtTables");
        var bodies = Regex.Matches(edited, "<tbody[^>]*list=[^>]*>").Select(m => m.Value).ToList();
        Assert.Equal(3, bodies.Count);
        Assert.All(bodies, b => Assert.Contains("os-Mode=\"Custom\"", b));
        Assert.All(bodies, b => Assert.Contains("data-ssam-rows=\"1\"", b));
        Assert.NotNull(answer["result"]!["visual"]?["tables"]);
        Assert.Empty(host.HtmlRead(File.ReadAllBytes(editedPath), "VtTables", withKeys: false)["documents"]![0]!["notes"]?.AsArray() ?? []);
    }

    [Fact]
    public void AFragmentTableBodyIsModeCustomAndRendersEveryRow()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the compile is skipped."); return; }
        var host = Host("fragment");
        var basePath = Path.Combine(Work, "fragment", "base.oml");
        Run(host, null, Job(new JsonArray(Html(Screen("VtFragment", "MainFlow", "<div class=\"vt-host\"></div>\n"))), "fragment"), basePath);
        var fragment = new JsonObject { ["op"] = "html", ["parent"] = "MobileScreen:VtFragment",
            ["html"] = "<table class=\"vt-frag\"><tbody list=\"Rows\" as=\"r\"><tr><td>{{ r }}</td></tr></tbody></table>" };
        var outPath = Path.Combine(Work, "fragment", "out.oml");
        var result = Run(host, basePath, Job(new JsonArray(fragment), "fragment-op"), outPath);
        var text = host.HtmlRead(File.ReadAllBytes(outPath), "VtFragment", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(text);
        var body = Regex.Match(text, "<tbody[^>]*>").Value;
        Assert.Contains("os-Mode=\"Custom\"", body);
        Assert.Contains("disable-virtualization=\"{{ True }}\"", body);
        Assert.Contains("data-ssam-rows=\"1\"", body);
        Assert.Contains("class=\"\"", body);
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Single(r => r["parent"] != null);
        Assert.NotNull(report["visual"]?["tables"]);
    }

    private JsonObject Run(ModelHost host, string? basePath, string job, string outPath)
    {
        try
        {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, outPath))!.AsObject();
            Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
            return result;
        }
        catch (Exception error) when (error is not Xunit.Sdk.XunitException) { output.WriteLine(Errors.Text(error)); throw; }
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    private static string Job(JsonArray ops, string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "job.json");
        File.WriteAllText(path, new JsonObject { ["base"] = "reactive-ui.oml", ["ops"] = ops }.ToJsonString());
        return path;
    }

    private static ModelHost Host(string name)
    {
        var dir = Path.Combine(Work, name);
        Directory.CreateDirectory(dir);
        return new ModelHost(dir);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
