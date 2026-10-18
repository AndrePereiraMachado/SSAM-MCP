using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>CX17 W2/W4 census (runs only with SSAM_CX17_CENSUS, a folder for its JSON): over the screens of the plan's corpus
/// (captures of Studio-made modules, read only), the class of every widget of a type the Studio gives a class (unset, "",
/// the Studio's, another literal, an expression) and the widgets the runtime gives the gutter after a neighbor: what the
/// decisions of F2 and of the native layout block (F3) reach in screens made in the Studio.</summary>
public sealed class ScreenVisualCorpusCensus(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenVisualCorpusCensus).Assembly.Location)!)!;

    [Fact]
    public void TheClassesAndGuttersOfTheCorpusScreens()
    {
        var folder = Environment.GetEnvironmentVariable("SSAM_CX17_CENSUS");
        if (string.IsNullOrWhiteSpace(folder)) { output.WriteLine("SSAM_CX17_CENSUS not set: the census is skipped."); return; }
        var manifest = JsonNode.Parse(File.ReadAllText(ScreenHtmlCoverage.Manifest(Root)))!.AsObject();
        var modules = manifest["modules"]!.AsArray().Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == "o11" && m["screens"]!.GetValue<bool>()).ToList();
        var host = new ModelHost(Path.Combine(Root, ".local", "screen-visual-census"));
        var census = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
        var rows = new JsonArray();
        int roots = 0, gutters = 0, rootsWithGutter = 0, quoted = 0, modulesRead = 0;
        foreach (var m in modules)
        {
            var path = m["oml"]!.GetValue<string>();
            if (!File.Exists(path)) { output.WriteLine("absent: " + m["label"]); continue; }
            Dictionary<string, ScreenVisual.Prediction> predictions;
            try { predictions = ScreenVisual.PredictOml(host, path, "o11"); }
            catch (Exception error) { output.WriteLine(m["label"] + ": " + error.GetBaseException().Message); continue; }
            modulesRead++;
            int moduleGutters = 0;
            foreach (var (_, p) in predictions)
            {
                roots++; gutters += p.Gutters; moduleGutters += p.Gutters; quoted += p.QuotedClasses;
                if (p.Gutters > 0) rootsWithGutter++;
                foreach (var (type, forms) in p.StyleCensus)
                {
                    if (!census.TryGetValue(type, out var all)) census[type] = all = new(StringComparer.Ordinal);
                    foreach (var (form, n) in forms) all[form] = all.GetValueOrDefault(form) + n;
                }
            }
            rows.Add(new JsonObject { ["module"] = m["label"]?.ToString(), ["roots"] = predictions.Count, ["gutters"] = moduleGutters, ["rootsWithGutter"] = predictions.Values.Count(p => p.Gutters > 0) });
        }
        var result = new JsonObject
        {
            ["modules"] = modulesRead, ["roots"] = roots, ["gutters"] = gutters, ["rootsWithGutter"] = rootsWithGutter, ["quotedClasses"] = quoted,
            ["styles"] = new JsonObject(census.OrderBy(c => c.Key, StringComparer.Ordinal).Select(c => KeyValuePair.Create(c.Key,
                (JsonNode?)new JsonObject(c.Value.OrderByDescending(v => v.Value).Select(v => KeyValuePair.Create(v.Key, (JsonNode?)v.Value)))))),
            ["perModule"] = rows,
        };
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "census.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine(result.ToJsonString());
        Assert.True(modulesRead > 0);
    }
}
