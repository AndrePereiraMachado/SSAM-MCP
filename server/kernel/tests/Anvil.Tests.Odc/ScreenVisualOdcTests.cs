using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>CX17 on the ODC lane (the fixture insurance-reactive-r8): the same class decisions (the ODC Studio gives the same
/// classes, PrototypeWidgetDefaults.Table), the List of a table or a grid renders every row, the theme takes the native layout
/// block, and the visual warnings say runtime "inferred" (no published ODC page read yet). Needs the ODC Studio.</summary>
public sealed class ScreenVisualOdcTests(ITestOutputHelper output)
{
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";

    private const string Document = "<screen name=\"VisualOdc\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Q\" type=\"Text\"/>\n<var name=\"Ok\" type=\"Boolean\"/>\n"
        + "<style>.vo-grid{display:grid;grid-template-columns:repeat(3,1fr)}</style>\n"
        + "<input bind=\"Q\" type=\"search\"/>\n<input bind=\"Q\" class=\"vo-mine\"/>\n<input type=\"checkbox\" bind=\"Ok\"/>\n<button onclick=\"Go\">Go</button>\n"
        + "<form><label>Name</label><input bind=\"Q\"/></form>\n"
        + "<table><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n"
        + "<div class=\"vo-grid\" list=\"Rows\"><p>{{ Rows.Current }}</p></div>\n"
        + "<p><strong>{{ Q }}</strong><span>items</span></p>\n</screen>";

    [Fact]
    public void TheOdcLaneTakesTheSameClassesRowsAndLayoutBlockAndItsWarningsSayInferred()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-visual", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = Fixture,
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = Document } },
                new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action VisualOdc.Go\n  end\n") } }),
        }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var host = new ModelHost(Path.Combine(dir, "work"));
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
        var normalized = report["normalized"]!.AsArray().Select(n => n!.AsObject()).ToList();
        output.WriteLine(new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
        int Count(string code, string element) => normalized.Where(n => n["code"]!.ToString() == code && n["element"]?.ToString() == element).Sum(n => n["count"]!.GetValue<int>());
        Assert.Equal(2, Count(ScreenVisual.StudioClassKept, "Input"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassKept, "Checkbox"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "List"));
        Assert.Equal(2, Count(ScreenVisual.ListRendersAllRows, "List"));
        Assert.Contains(normalized, n => n["code"]!.ToString() == ScreenVisual.ThemeNativeLayout);
        var text = host.HtmlRead(File.ReadAllBytes(outPath), "MobileScreen:VisualOdc", withKeys: false)["documents"]![0]!["html"]!.ToString();
        output.WriteLine(text);
        Assert.Equal(2, Regex.Matches(text, "<input[^>]*class=\"form-control\"").Count);
        Assert.Matches("<form[^>]*class=\"form\"", text);
        Assert.Equal(2, Regex.Matches(text, "disable-virtualization=").Count);
        var joined = Assert.Single(result["highWarnings"]!.AsArray(), w => w!["code"]!.ToString() == ScreenVisual.TextJoined)!;
        Assert.Equal("inferred", joined["suggestion"]!["runtime"]!.ToString());
        var check = host.HtmlCheck(File.ReadAllBytes(outPath))["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "VisualOdc")!;
        Assert.Equal(0, check["ops"]!.GetValue<int>());
    }

    // The review's ODC probe (C:\t\revisoes\cx17-juncao\probe-odc\jx-probe.json): no layout block, a page div at the top.
    private const string JxProbe = "<screen name=\"JxProbe\" roles=\"JxProbeRole\" actions=\"Go\">\n<var name=\"Rows\" type=\"Text List\"/>\n<var name=\"Q\" type=\"Text\"/>\n"
        + "<var name=\"Ok\" type=\"Boolean\"/>\n<var name=\"Show\" type=\"Boolean\" default=\"False\"/>\n"
        + "<style>.jx-grid{display:grid;grid-template-columns:repeat(3,1fr)}.jx-row{display:flex;gap:12px}</style>\n<div class=\"jx-page\">\n"
        + "<div class=\"jx-row\"><a onclick=\"Go\">One</a><a onclick=\"Go\">Two</a><button onclick=\"Go\">Three</button></div>\n"
        + "<input bind=\"Q\" type=\"search\"/>\n<textarea bind=\"Q\"></textarea>\n<input type=\"checkbox\" bind=\"Ok\"/>\n<button onclick=\"Go\">Go</button>\n"
        + "<form><label>Name</label><input bind=\"Q\"/></form>\n<table><tbody list=\"Rows\"><tr><td>{{ Rows.Current }}</td></tr></tbody></table>\n"
        + "<popup show=\"Show\"><div class=\"inside\">Inside</div></popup>\n</div>\n</screen>\n";

    [Fact]
    public void ANewWidgetWithoutClassTakesTheStudiosClassInTheEditFormsAndInAFragmentSaidLikeTheDocument()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        // M1 of the review of the CX17 merge and the owner's decision D1 (2026-10-17) on the ODC lane: the html edit, the element
        // edits and the fragment give a new widget without k and without class the class the Studio gives it (trimmed for a button
        // and a form), each said in normalized; every element of the reading keeps what it was read with; the fixed point holds.
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-visual", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var host = new ModelHost(Path.Combine(dir, "work"));
        JsonObject Run(string name, string? basePath, params JsonObject[] ops)
        {
            var job = Path.Combine(dir, name + ".json");
            var json = new JsonObject { ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) };
            if (basePath == null) json["base"] = Fixture;
            File.WriteAllText(job, json.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, Path.Combine(dir, name + ".oml")))!.AsObject();
            Assert.True(result["accepted"]!.GetValue<bool>(), name + ": " + result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
            return result;
        }
        var basePath = Path.Combine(dir, "jx.oml");
        Run("jx", null, new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IRole", ["name"] = "JxProbeRole" },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = JxProbe } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action JxProbe.Go\n  end\n") } });
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant();
        var read = host.HtmlRead(File.ReadAllBytes(basePath), "MobileScreen:JxProbe", withKeys: true)["documents"]![0]!.AsObject();
        var html = read["html"]!.ToString();
        output.WriteLine(html);
        // Every line of the reading (an element as it was read, its class included), wherever its k moved after an insertion.
        static Dictionary<string, int> Lines(string text) => Regex.Replace(text, " k=\"[^\"]*\"", "").Split('\n').GroupBy(l => l).ToDictionary(g => g.Key, g => g.Count());
        var lines = Lines(html);
        JsonObject BasedOn() => new() { ["capture"] = sha, ["html"] = read["htmlSha256"]!.DeepClone() };
        (string Text, List<JsonObject> Normalized) After(string name, JsonObject result, Func<JsonObject, bool> report)
        {
            var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml"));
            var keyed = host.HtmlRead(bytes, "MobileScreen:JxProbe", withKeys: true)["documents"]![0]!["html"]!.ToString();
            var normalized = (result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Last(report)["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
            output.WriteLine(name + ": " + keyed);
            output.WriteLine(name + ": " + new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
            var now = Lines(keyed);
            foreach (var (line, count) in lines) Assert.True(now.GetValueOrDefault(line) >= count, name + ": not read back as read: " + line);
            var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "JxProbe")!;
            Assert.Equal(0, check["ops"]!.GetValue<int>());
            Assert.Equal(0, check["problemCount"]!.GetValue<int>());
            return (Regex.Replace(keyed, " k=\"[^\"]*\"", ""), normalized);
        }
        int Count(List<JsonObject> normalized, string code, string element) => normalized.Where(n => n["code"]?.ToString() == code && n["element"]?.ToString() == element).Sum(n => n["count"]!.GetValue<int>());
        // (1) The review's repro: the whole document, a new button and a new text area in a new div before the page div closes.
        var end = html.LastIndexOf("</div>\n</screen>", StringComparison.Ordinal);
        Assert.True(end > 0, html);
        var whole = html[..end] + " <button onclick=\"Go\">NewOne</button>\n <div class=\"jx-row2\"><textarea bind=\"Q\"></textarea></div>\n" + html[end..];
        var document = After("html", Run("html", basePath, new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "JxProbe", ["basedOn"] = BasedOn(), ["html"] = whole } }),
            r => r["screen"] != null);
        Assert.Contains("<button class=\"btn\" onclick=\"Go\">NewOne</button>", document.Text);
        Assert.Matches("<div class=\"jx-row2\">\\s*<textarea [^>]*class=\"form-control\"", document.Text);
        Assert.Equal(1, Count(document.Normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, Count(document.Normalized, ScreenVisual.StudioClassKept, "TextArea"));
        // (2) The element edits: a new button in the flex row with its gap (btn and the gap marker of the engine) and a new form.
        var row = Regex.Match(html, "<div k=\"(w\\d+)\" class=\"jx-row\"").Groups[1].Value;
        var elements = After("edits", Run("edits", basePath, new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "JxProbe", ["basedOn"] = BasedOn(),
            ["edits"] = new JsonArray(new JsonObject { ["into"] = row, ["insert"] = "<button onclick=\"Go\">Four</button>" },
                new JsonObject { ["after"] = row, ["insert"] = "<form><input bind=\"Q\"/></form>" }) } }), r => r["screen"] != null);
        Assert.Matches("<button class=\"btn\" onclick=\"Go\" data-ssam-gap=\"1\">Four</button>", elements.Text);
        Assert.Equal(1, Count(elements.Normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, Count(elements.Normalized, ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Equal(1, Count(elements.Normalized, ScreenVisual.StudioClassKept, "Input"));
        Assert.Equal(2, Regex.Matches(elements.Text, "<form [^>]*class=\"form\"").Count);
        // (3) The fragment into the screen: the same classes, the same notes; the author's class as written.
        var fragment = After("fragment", Run("fragment", basePath, new JsonObject { ["op"] = "html", ["parent"] = "MobileScreen:JxProbe",
            ["html"] = "<div class=\"jx-frag\"><button onclick=\"Go\">Frag</button><textarea bind=\"Q\"></textarea><button class=\"mine\" onclick=\"Go\">Own</button></div>" }),
            r => r["parent"] != null);
        var part = fragment.Text[fragment.Text.IndexOf("jx-frag", StringComparison.Ordinal)..];
        Assert.Matches("<button [^>]*class=\"btn\"[^>]*>Frag</button>", part);
        Assert.Matches("<textarea [^>]*class=\"form-control\"", part);
        Assert.Matches("<button [^>]*class=\"mine\"[^>]*>Own</button>", part);
        Assert.DoesNotContain("btn-primary", part);
        Assert.Equal(1, Count(fragment.Normalized, ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, Count(fragment.Normalized, ScreenVisual.StudioClassKept, "TextArea"));
    }

    [Fact]
    public void AnEmptyClassInAFragmentIsTheAuthorsEmptyClassOnTheOdcLaneToo()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        // M2 of the review of the M1 fix on the ODC lane: class="" in a fragment is the author's empty class (as in the document and
        // the edit forms), never the class the Studio gave the widget; a widget without class takes F2, said. The screen of the
        // Studio has no button: the Studio gives the first one btn btn-primary, and the rule writes btn (review B6).
        var dir = Path.Combine(FindRoot(), ".local", "lane-odc", "screen-visual", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var host = new ModelHost(Path.Combine(dir, "work"));
        var before = host.HtmlRead(File.ReadAllBytes(Path.Combine(FindRoot(), Fixture)), "MobileScreen:InvalidPermissions", withKeys: true)["documents"]![0]!["html"]!.ToString();
        Assert.DoesNotContain("<button", before);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = Fixture,
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["parent"] = "MobileScreen:InvalidPermissions",
                ["html"] = "<div class=\"m2-frag\"><button onclick=\"UserProfile\">Bare</button><form>Hi</form><button class=\"\" onclick=\"UserProfile\">Empty</button><form class=\"\">Ho</form></div>" }),
        }.ToJsonString());
        var outPath = Path.Combine(dir, "out.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, outPath))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Single(r => r["parent"] != null);
        var normalized = (report["normalized"] as JsonArray ?? []).Select(n => n!.AsObject()).ToList();
        output.WriteLine(new JsonArray(normalized.Select(n => (JsonNode)n.DeepClone()).ToArray()).ToJsonString());
        var bytes = File.ReadAllBytes(outPath);
        var keyed = host.HtmlRead(bytes, "MobileScreen:InvalidPermissions", withKeys: true)["documents"]![0]!["html"]!.ToString();
        var text = Regex.Replace(keyed, " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        var part = text[text.IndexOf("m2-frag", StringComparison.Ordinal)..];
        Assert.Matches("<button [^>]*class=\"\"[^>]*>Empty</button>", part);
        Assert.Matches("<form [^>]*class=\"\"[^>]*>Ho</form>", part);
        Assert.Matches("<button [^>]*class=\"btn\"[^>]*>Bare</button>", part);
        Assert.Matches("<form [^>]*class=\"form\"[^>]*>Hi</form>", part);
        Assert.DoesNotContain("btn-primary", part);
        Assert.DoesNotContain("card", part);
        int Count(string code, string element) => normalized.Where(n => n["code"]?.ToString() == code && n["element"]?.ToString() == element).Sum(n => n["count"]!.GetValue<int>());
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "Button"));
        Assert.Equal(1, Count(ScreenVisual.StudioClassTrimmed, "Form"));
        Assert.Contains("the Studio gives it \"btn btn-primary\"", normalized.Single(n => n["element"]?.ToString() == "Button")["note"]!.ToString());
        // Every line of the screen as read is still there; the fixed point holds.
        static Dictionary<string, int> Lines(string html) => Regex.Replace(html, " k=\"[^\"]*\"", "").Split('\n').GroupBy(l => l).ToDictionary(g => g.Key, g => g.Count());
        var now = Lines(keyed);
        foreach (var (line, count) in Lines(before)) Assert.True(now.GetValueOrDefault(line) >= count, "not read back as read: " + line);
        var check = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "InvalidPermissions")!;
        Assert.Equal(0, check["ops"]!.GetValue<int>());
        Assert.Equal(0, check["problemCount"]!.GetValue<int>());
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenVisualOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }
}
