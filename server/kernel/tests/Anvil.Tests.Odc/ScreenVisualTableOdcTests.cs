using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>F8 on the ODC lane (the fixture insurance-reactive-r8, the ODC Studio's ListDescriptor has the same Mode/Tag rule): a
/// table List of the document form and of the edit of a reading is Mode Custom, renders every row and lays out as its part (a
/// data table, one header row and one template row, is the native Table and not this rule: the body here has two rows).
/// Needs the ODC Studio.</summary>
public sealed class ScreenVisualTableOdcTests(ITestOutputHelper output)
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    private const string Document = "<screen name=\"VtOdc\">\n<var name=\"Rows\" type=\"Text List\"/>\n"
        + "<table class=\"vt-two\"><thead><tr><th>A</th></tr></thead><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr><tr><td>-</td></tr></tbody></table>\n"
        + "<table class=\"vt-empty\"><thead><tr><th>B</th></tr></thead></table>\n</screen>";

    [Fact]
    public void TheDocumentAndTheEditWriteATableListThatRendersAsItsTablePart()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-visual-tables", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = Fixture,
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = Document } }),
        }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var host = new ModelHost(Path.Combine(dir, "work"));
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var bytes = File.ReadAllBytes(outPath);
        string Text(byte[] model) => Regex.Replace(host.HtmlRead(model, "MobileScreen:VtOdc", withKeys: false)["documents"]![0]!["html"]!.ToString(), "\\s+k=\"[^\"]*\"", "");
        var text = Text(bytes);
        output.WriteLine(text);
        var body = Regex.Match(text, "<table class=\"vt-two\"[\\s\\S]*?(<tbody[^>]*>)").Groups[1].Value;
        Assert.Contains("os-Mode=\"Custom\"", body);
        Assert.Contains("disable-virtualization=\"{{ True }}\"", body);
        Assert.Contains("class=\"\"", body);
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
        var table = Assert.Single(report["visual"]!["tables"]!.AsArray())!;
        // The display reaches the page either way: the rows marker with the block in the theme, or the List's inline style.
        Assert.True(body.Contains("data-ssam-rows=\"1\"", StringComparison.Ordinal) || body.Contains("ext:style=\"display:table-row-group\"", StringComparison.Ordinal), body);
        output.WriteLine(table.ToJsonString());
        Assert.Equal(0, host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "VtOdc")!["ops"]!.GetValue<int>());

        // The edit of the reading: the empty table gets a new <tbody list>.
        var keyed = host.HtmlRead(bytes, "MobileScreen:VtOdc", withKeys: true)["documents"]![0]!;
        var lines = keyed["html"]!.ToString().Split('\n');
        var start = Array.FindIndex(lines, l => l.Contains("class=\"vt-empty\"", StringComparison.Ordinal));
        var end = Array.FindIndex(lines, start, l => l.TrimStart().StartsWith("</table>", StringComparison.Ordinal));
        var edit = string.Join("\n", lines[start..end]) + "\n<tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr><tr><td>-</td></tr></tbody>\n</table>\n";
        var data = new JsonObject { ["screen"] = "VtOdc", ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = keyed["htmlSha256"]!.ToString() },
            ["edit"] = new JsonArray(edit) };
        var editedPath = Path.Combine(dir, "edited.oml");
        var answer = host.HtmlEdit(bytes, data, editedPath);
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        output.WriteLine(answer["result"]!.ToJsonString());
        var bodies = Regex.Matches(Text(File.ReadAllBytes(editedPath)), "<tbody[^>]*list=[^>]*>").Select(m => m.Value).ToList();
        Assert.Equal(2, bodies.Count);
        Assert.All(bodies, b => Assert.Contains("os-Mode=\"Custom\"", b));
        Assert.All(bodies, b => Assert.Contains("disable-virtualization=\"{{ True }}\"", b));
        Assert.NotNull(answer["result"]!["visual"]?["tables"]);
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenVisualTableOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }
}
