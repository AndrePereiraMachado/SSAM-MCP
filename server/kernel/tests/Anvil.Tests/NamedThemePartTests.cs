using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

public sealed class NamedThemePartTests
{
    [Fact]
    public void AnEmptyNamedPartCanReplaceItsPreviousBodyWhileAnEmptyRootKeepsLegacyBehavior()
    {
        var top = ScreenHtml.Parse("<screen name=\"Page\"><style scope=\"theme\" id=\"base\"></style><style scope=\"theme\"></style></screen>").Children[0];
        Assert.Equal(new[] { ("style:base", "") }, ScreenDocument.ThemeParts(ScreenDocument.Styles(top), "Page"));
    }

    [Fact]
    public void NamedPartsKeepFirstAppearanceAndJoinRepeatedIdsInDocumentOrder()
    {
        var top = ScreenHtml.Parse("<screen name=\"Page\"><style scope=\"theme\" id=\"base\">.a{color:red}</style>"
            + "<style scope=\"theme\">.root{margin:0}</style><div><style scope=\"theme\" id=\"base\">.b{padding:0}</style></div>"
            + "<style id=\"local\">.local{display:block}</style><style scope=\"theme\" id=\"extra\">.c{border:0}</style></screen>").Children[0];
        var styles = ScreenDocument.Styles(top);
        Assert.Equal("base", styles[0].Id);
        Assert.Equal(new[] { ("style:base", ".a{color:red}\n.b{padding:0}"), ("Page", ".root{margin:0}"), ("style:extra", ".c{border:0}") },
            ScreenDocument.ThemeParts(styles, "Page"));
        Assert.Equal(".local{display:block}", ScreenDocument.OwnSheet(styles, null));
        Assert.Equal(".a{color:red}\n.root{margin:0}\n.b{padding:0}\n.c{border:0}", ScreenDocument.ThemeSheet(styles));
    }

    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("has.dot")]
    [InlineData("ação")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void InvalidNamedPartIdsAreRefusedWithTheirCorrection(string id)
    {
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(
            $"<screen name=\"Page\"><style scope=\"theme\" id=\"{id}\">.a{{color:red}}</style></screen>", "/data/html"));
        var problem = Assert.Single(refusal.Problems!);
        Assert.Equal(ScreenDocument.StyleUnplaced, problem!["code"]!.ToString());
        Assert.Contains("[A-Za-z0-9_-]{1,64}", problem.ToJsonString());
    }

    [Theory]
    [InlineData("a")]
    [InlineData("shared-0123abcd")]
    [InlineData("ABC_123-x")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void ValidNamedPartIdsPassDocumentPreflight(string id) => ScreenDocument.Preflight(
        $"<screen name=\"Page\"><style scope=\"theme\" id=\"{id}\">.a{{color:red}}</style></screen>", "/data/html");

    [Fact]
    public void NamedPartsAreInstalledOnceAndUpdatedAcrossDocumentsAndDeliveries()
    {
        if (!StudioAvailable()) return;
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NamedThemePartTests).Assembly.Location)!)!;
        var dir = Path.Combine(root, ".local", "named-theme-parts");
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        JsonObject Run(string name, string? basis, params JsonObject[] ops)
        {
            var job = Path.Combine(dir, name + ".json");
            File.WriteAllText(job, new JsonObject { ["base"] = basis ?? "reactive-ui.oml", ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) }.ToJsonString());
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, Path.Combine(dir, name + ".oml")))!.AsObject();
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            return result;
        }
        JsonObject Document(string name, string color, bool ownPart = false, string partId = "base") => new()
        {
            ["op"] = "html", ["data"] = new JsonObject { ["html"] = $"<screen name=\"{name}\" roles=\"Registered\">"
                + $"<style scope=\"theme\" id=\"{partId}\">.shared{{color:{color}}}</style>"
                + (ownPart ? "<style scope=\"theme\">.root{padding:0}</style>" : "")
                + "<Block name=\"LayoutBlank\"><slot name=\"Content\"><div class=\"shared\">x</div></slot></Block></screen>" }
        };
        var first = Run("first", null, Document("NamedA", "red", true), Document("NamedB", "red"));
        var report = first["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document");
        Assert.Equal("/* anvil:html NamedA */", report["styleSheet"]!["theme"]!["marker"]!.ToString());
        Assert.Equal(2, report["styleSheet"]!["theme"]!["parts"]!.AsArray().Count);
        // A named id equal to an existing root name is independent; it must never adopt the root's marker as legacy CSS.
        Run("second", Path.Combine(dir, "first.oml"), Document("NamedC", "blue"), Document("NamedD", "green", partId: "NamedA"));
        var after = Path.Combine(dir, "second.oml");
        var queried = Run("query", after, new JsonObject { ["op"] = "get", ["target"] = "IMobileTheme:Headless_UI" });
        var theme = queried["results"]![0]!["result"]!;
        var css = theme["UserStyleSheet"]?.ToString() ?? theme["properties"]?["UserStyleSheet"]?.ToString()
            ?? theme["StyleSheet"]?.ToString() ?? theme["properties"]?["StyleSheet"]?.ToString() ?? "";
        Assert.Equal(1, css.Split("/* anvil:html style:base */").Length - 1);
        Assert.Contains(".shared{color:blue}", css);
        Assert.DoesNotContain(".shared{color:red}", css);
        Assert.Contains("/* anvil:html NamedA */", css);
        Assert.Contains(".root{padding:0}", css);
        Assert.Equal(1, css.Split("/* anvil:html style:NamedA */").Length - 1);
        Assert.Contains(".shared{color:green}", css);
        foreach (var name in new[] { "NamedA", "NamedB", "NamedC", "NamedD" })
            Assert.DoesNotContain("<style", host.HtmlRead(File.ReadAllBytes(after), "MobileScreen:" + name, withKeys: false)["documents"]![0]!["html"]!.ToString());
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
