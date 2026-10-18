using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>CX17 W8: the acceptance over the owner's DemoLATAM test (copies outside the repository, SSAM_DEMOLATAM_DIR; skipped
/// without them and without the Service Studio). The DOM the runtime will publish is predicted for the delivered module, for the
/// V2 roots compiled by the base compiler (antes-v2.oml) and by this one (depois-v2.oml, and with the warnings' patches applied
/// when depois-patched.oml exists); the families are counted per root and every prediction is dumped with the theme CSS of its
/// module (SSAM_DEMOLATAM_DUMP) for the browser comparison. No text of the owner's app is versioned.</summary>
public sealed class DemoLatamVisualTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DemoLatamVisualTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "demolatam-visual");

    [Fact]
    public void TheFamiliesOfTheDemoLatamPagesBeforeAndAfter()
    {
        var dir = Environment.GetEnvironmentVariable("SSAM_DEMOLATAM_DIR");
        if (string.IsNullOrWhiteSpace(dir) || !File.Exists(Path.Combine(dir, "antes-v2.oml"))) { output.WriteLine("WARNING: no DemoLATAM copies (SSAM_DEMOLATAM_DIR): skipped."); return; }
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var dump = Environment.GetEnvironmentVariable("SSAM_DEMOLATAM_DUMP");
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var counts = new JsonObject();
        foreach (var (label, file, keep) in new (string, string, Func<string, bool>)[]
                 {
                     ("delivered", "DemoLATAM_UI-delivered.oml", n => !n.EndsWith("V2", StringComparison.Ordinal)),
                     ("antes", "antes-v2.oml", n => n.EndsWith("V2", StringComparison.Ordinal)),
                     ("depois", "depois-v2.oml", n => n.EndsWith("V2", StringComparison.Ordinal)),
                     ("depois-patched", "depois-patched.oml", n => n.EndsWith("V2", StringComparison.Ordinal)),
                 })
        {
            var path = Path.Combine(dir, file);
            if (!File.Exists(path)) { output.WriteLine($"{label}: {file} absent"); continue; }
            var theme = ThemeCss(host, path, label);
            var predictions = ScreenVisual.PredictOml(host, path, "o11", keep);
            var rules = ScreenVisual.RulesOf([theme]);
            var perRoot = new JsonObject();
            int quoted = 0, gutters = 0, sentinels = 0, layoutSentinels = 0;
            foreach (var (name, prediction) in predictions.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                // A List with sentinels that is a table part or a grid/flex container by the theme's CSS (F1).
                var lists = prediction.Root.Descendants(includeSelf: false).Where(n => n.IsElement && n.Attr("data-list") != null).ToList();
                var layout = lists.Count(l => l.Children.Any(c => c.Tag == "script") && ScreenVisual.AllRowsReason(l.Tag!, Classes(l), rules) != null);
                perRoot[name] = new JsonObject
                {
                    ["quotedClasses"] = prediction.QuotedClasses, ["gutters"] = prediction.Gutters, ["listsWithSentinels"] = prediction.ListsWithSentinels,
                    ["layoutListsWithSentinels"] = layout, ["lists"] = lists.Count, ["inferred"] = prediction.Inferred,
                };
                quoted += prediction.QuotedClasses; gutters += prediction.Gutters; sentinels += prediction.ListsWithSentinels; layoutSentinels += layout;
                if (!string.IsNullOrWhiteSpace(dump))
                {
                    var folder = Path.Combine(dump, label);
                    Directory.CreateDirectory(folder);
                    File.WriteAllText(Path.Combine(folder, name + ".json"), new JsonObject { ["root"] = name, ["dom"] = prediction.Root.ToJson() }.ToJsonString());
                    File.WriteAllText(Path.Combine(folder, name + ".html"), Html(prediction.Root));
                }
            }
            if (!string.IsNullOrWhiteSpace(dump)) File.WriteAllText(Path.Combine(dump, label, "theme.css"), theme);
            counts[label] = new JsonObject
            {
                ["roots"] = predictions.Count, ["quotedClasses"] = quoted, ["gutters"] = gutters, ["listsWithSentinels"] = sentinels, ["layoutListsWithSentinels"] = layoutSentinels,
                ["nativeLayoutBlock"] = theme.Contains(ScreenVisual.NativeLayoutBegin, StringComparison.Ordinal), ["perRoot"] = perRoot,
            };
            output.WriteLine($"{label}: roots {predictions.Count}, quoted {quoted}, gutters {gutters}, lists with sentinels {sentinels} (in a table/grid/flex {layoutSentinels}), native block {theme.Contains(ScreenVisual.NativeLayoutBegin, StringComparison.Ordinal)}");
        }
        if (!string.IsNullOrWhiteSpace(dump)) { Directory.CreateDirectory(dump); File.WriteAllText(Path.Combine(dump, "counts.json"), counts.ToJsonString(new JsonSerializerOptions { WriteIndented = true })); }
        // The acceptance: F1 and F2 at zero after; F3's class is neutralized by the theme block.
        Assert.True(counts["antes"]!["quotedClasses"]!.GetValue<int>() > 0);
        Assert.Equal(0, counts["depois"]!["quotedClasses"]!.GetValue<int>());
        Assert.Equal(0, counts["depois"]!["layoutListsWithSentinels"]!.GetValue<int>());
        Assert.True(counts["depois"]!["nativeLayoutBlock"]!.GetValue<bool>());
    }

    // The predicted DOM as HTML text (for the browser captures; runtime-only elements included as they will be published).
    private static string Html(DomNode node)
    {
        var sb = new System.Text.StringBuilder();
        void Write(DomNode n)
        {
            if (!n.IsElement) { if (n.Text != null) sb.Append(System.Net.WebUtility.HtmlEncode(n.Text)); else if (n.Unevaluable != null) sb.Append(System.Net.WebUtility.HtmlEncode(n.Unevaluable)); foreach (var c in n.Children) Write(c); return; }
            sb.Append('<').Append(n.Tag);
            foreach (var (name, value) in n.Attributes) sb.Append(' ').Append(name).Append("=\"").Append(System.Net.WebUtility.HtmlEncode(value)).Append('"');
            sb.Append('>');
            if (n.Tag is "input" or "img" or "br" or "hr") return;
            foreach (var c in n.Children) Write(c);
            sb.Append("</").Append(n.Tag).Append('>');
        }
        Write(node);
        return sb.ToString();
    }

    // The author's classes of a predicted List (the rules of the theme are matched on its own element).
    private static DomNode Classes(DomNode list) => list;

    private static string ThemeCss(ModelHost host, string model, string label)
    {
        var dir = Path.Combine(Work, label);
        Directory.CreateDirectory(dir);
        var get = Path.Combine(dir, "theme-get.json");
        File.WriteAllText(get, """{"ops":[{"op":"get","target":"IMobileTheme:DemoLATAM_UI"}]}""");
        var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, model, get, Path.Combine(dir, "theme-get.oml")))!;
        var result = read["results"]![0]!["result"]!;
        return result["properties"]?["StyleSheet"]?.ToString() ?? result["StyleSheet"]?.ToString() ?? "";
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
