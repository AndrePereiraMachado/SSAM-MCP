using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// T18 on the ODC model (a theme with Theme Editor CSS, so the author half and the effective StyleSheet differ): the keyed css
/// op on the theme, a screen and a block derived from the fixture writes the author half through the one path (the @import the
/// edit brings at the top of the effective StyleSheet, before the Theme Editor block; the effective one composed again), its
/// basedOn is the sha256 of the UserStyleSheet the get reads, F1 reports each element; a stale basedOn is THEME_CHANGED with the
/// current hash, and a raw set takes the same check.
/// </summary>
public sealed class CssPathOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work", "t18-css-path");
    private const string Fixture = "tests/fixtures/odc/insurance-reactive-r8.oml";
    private const string Import = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";

    [Fact]
    public void TheCssOpEditsTheAuthorHalfOfEveryStylesheetElement()
    {
        if (!StudioAvailable()) return;
        var elements = Elements();
        Assert.Contains(elements, e => e.Kind == "theme" && e.Split);
        foreach (var (target, kind, author, split) in elements)
        {
            var probe = $".t18-{kind}-probe{{color:#123456}}";
            var result = Run("css-" + kind, new JsonArray(
                new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author),
                    ["edits"] = new JsonArray(new JsonObject { ["append"] = probe + "\n" + Import }) },
                new JsonObject { ["op"] = "get", ["target"] = target }));
            Assert.True(result["accepted"]!.GetValue<bool>(), target + ": " + Clip(result));
            var css = Results(result).OfType<JsonObject>().First(r => r["css"] != null);
            var properties = Results(result).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!.AsObject();
            var written = (properties["UserStyleSheet"] ?? properties["StyleSheet"])!.ToString();
            Assert.Contains(probe, written);
            Assert.True(ThemeCss.Matches(css["basedOn"]!.ToString(), written), target);
            var effective = properties["StyleSheet"]!.ToString();
            Assert.True(ThemeCss.ImportsFirst(effective).Ok && effective.Contains(Import, StringComparison.Ordinal) && effective.IndexOf(Import, StringComparison.Ordinal) < effective.IndexOf(probe, StringComparison.Ordinal), target + ": " + effective[..Math.Min(300, effective.Length)]);
            if (split)
            {
                // The Theme Editor block stays whole after the author's @import, and the author half keeps the rest.
                var generated = properties["GeneratedStyleSheet"]!.ToString();
                var imports = CssCompat.Imports(written).Imports.Select(x => x.Statement).ToList();
                Assert.Contains(Import, imports);
                Assert.StartsWith(string.Join("\r\n", imports) + "\r\n" + generated + "\r\n", effective);
                Assert.NotNull(css["cssImportsHoisted"]);
            }
            var entry = Assert.Single(result["styleSheets"]!.AsArray(), e => e!["name"]!.ToString() == target[(target.IndexOf(':') + 1)..])!;
            Assert.Equal(kind, entry["kind"]!.ToString());
            Assert.True(entry["touch"] != null || entry["reason"]?.ToString() is { Length: > 0 }, entry.ToJsonString());
        }
    }

    [Fact]
    public void AStaleBasedOnIsRefusedOnTheCssOpAndOnTheSet()
    {
        if (!StudioAvailable()) return;
        var (target, _, author, _) = Elements().First(e => e.Kind == "theme");
        foreach (var op in new[]
        {
            new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author + "x"), ["edits"] = new JsonArray(new JsonObject { ["append"] = ".a{b:c}" }) },
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = ".a{b:c}", ["basedOn"] = ThemeCss.Sha256(author + "x") },
        })
        {
            var error = Assert.ThrowsAny<Exception>(() => Run("stale-" + op["op"], new JsonArray(op)));
            var coded = Assert.IsType<KernelRefusalException>(Errors.FindCoded(error));
            Assert.Equal(ModelSession.ThemeChanged, coded.Code);
            Assert.Equal(ThemeCss.Sha256(author), coded.Problems![0]!["actual"]!.ToString());
        }
    }

    // One theme, screen and block of the fixture with a stylesheet of its own, with the author CSS: derived from the model.
    private static List<(string Target, string Kind, string Author, bool Split)> Elements()
    {
        var found = new List<(string, string, string, bool)>();
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Path.Combine(Root, Fixture)));
        try
        {
            foreach (var o in ((IObjectSignature)espace).GetAllDescendantsOfType<IObjectSignature>())
            {
                var names = o.GetType().GetInterfaces().Select(i => i.Name).ToHashSet();
                var type = new[] { "IMobileTheme", "IMobileScreen", "IMobileBlock" }.FirstOrDefault(names.Contains);
                if (type == null || ThemeCss.AuthorOf(o) is not { } author || TypeResolver.Name(o) is not { Length: > 0 } name) continue;
                var kind = type == "IMobileTheme" ? "theme" : type == "IMobileBlock" ? "block" : "screen";
                var split = ThemeCss.Of(o) is { } sheet && ThemeCss.IsSplit(sheet);
                // A theme with Theme Editor CSS first: it is the one whose halves differ.
                var same = found.FindIndex(f => f.Item2 == kind);
                if (same >= 0 && (found[same].Item4 || !split)) continue;
                if (same >= 0) found.RemoveAt(same);
                found.Add((type + ":" + name, kind, author, split));
            }
        }
        finally { ModelHost.Release(espace); }
        return found;
    }

    private static JsonObject Run(string name, JsonArray ops)
    {
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["base"] = Path.Combine(Root, Fixture), ["expectValid"] = true, ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), Path.Combine(Root, Fixture), job, Path.Combine(Work, name + ".oml")))!.AsObject();
    }

    private static IEnumerable<JsonNode?> Results(JsonObject result) => (result["results"] as JsonArray ?? new JsonArray()).Select(r => r is JsonObject o && o["result"] is { } inner ? inner : r);
    private static string Clip(JsonObject result) { var s = result.ToJsonString(); return s[..Math.Min(4000, s.Length)]; }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(CssPathOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
