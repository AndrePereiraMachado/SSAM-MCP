using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane kh of the atritos 3 package on the ODC model (the WrightFlood fixture, whose theme has Theme Editor CSS):
/// <list type="bullet">
/// <item>C23, as B4 corrected it: an @import of the author's CSS goes to the top of the author's half; the effective StyleSheet is the
/// platform's composition (the Theme Editor block, then the author's half: what the saved module holds), so the set says the @import is
/// ignored there (cssImportsIgnored, C-05). Before B4 the kernel put it at the top of the effective StyleSheet (lab
/// 29: the fonts never loaded), which no save kept.</item>
/// <item>C35: a selector of the author's CSS that starts with #reactContainer is :is(#reactContainer, body) (cssRewrites).</item>
/// <item>C05: a &lt;Block&gt; without an id is the native instance (CustomName empty, CustomNameIsSuffix True), so the Studio's
/// merge has nothing to drop (labs 18-38: CustomName[] / CustomName[Block1], MERGE_UNCERTAIN), and two fragments on one
/// screen never give the same name (lab 20: Duplicated object Block1).</item>
/// </list>
/// </summary>
public class Pa3KhOdcTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "test-work");
    private const string Fixture = "tests/fixtures/odc/wrightflood-personal-r8.oml";
    private const string Import = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";

    [Fact]
    public void AnImportOfTheAuthorGoesFirstInItsHalfIsSaidIgnoredAndReactContainerAlsoSelectsInTheCanvas()
    {
        if (!StudioAvailable()) return;
        var css = "#reactContainer .pa3-shell { padding: 0; }\n.pa3-a { font-family: Inter; }\n" + Import + "\n";
        var result = Run("pa3-kh-theme-import", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:WrightFlood", ["prop"] = "StyleSheet", ["value"] = css },
            new JsonObject { ["op"] = "get", ["target"] = "IMobileTheme:WrightFlood" }));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var landing = result["results"]!.AsArray().First(o => o!["op"]!.ToString() == "set")!["result"]!["styleSheet"]!;
        // The @import after a rule goes up in the author's half, which is all a write can order.
        Assert.Contains(Import, landing["cssImportsHoisted"]![0]!["from"]!.ToString());
        Assert.Equal("/UserStyleSheet", landing["cssImportsHoisted"]![0]!["path"]!.ToString());
        // C-05, B4: the receipt says what the browser gets (the platform serves the Theme Editor CSS first, then this author CSS).
        Assert.Equal([Import], landing["cssImportsIgnored"]!["imports"]!.AsArray().Select(i => i!.ToString()));
        Assert.Equal(ThemeCss.ServedImportNote, landing["cssImportsIgnored"]!["served"]!.ToString());
        Assert.Equal(":is(#reactContainer, body) .pa3-shell", landing["cssRewrites"]![0]!["to"]!.ToString());
        var theme = result["results"]!.AsArray().Last(o => o!["op"]!.ToString() == "get")!["result"]!["properties"]!.AsObject();
        var generated = theme["GeneratedStyleSheet"]!.GetValue<string>();
        var author = theme["UserStyleSheet"]!.GetValue<string>();
        var effective = theme["StyleSheet"]!.GetValue<string>();
        Assert.True(generated.Length > 0, "the fixture must have Theme Editor CSS for this test to mean anything");
        // B4: the platform's composition, which the saved module holds (TheEffectiveStyleSheetOfTheCandidateIsTheOneTheSavedModuleHas).
        Assert.Equal(generated + "\r\n" + author, effective);
        Assert.Contains(":is(#reactContainer, body) .pa3-shell { padding: 0; }", author);
        Assert.StartsWith(Import, author);   // the author's text has its @import first
    }

    [Fact]
    public void UnnamedBlocksAreNativeInstancesAndTwoFragmentsNeverCollide()
    {
        if (!StudioAvailable()) return;
        static JsonObject Op(string json) => JsonNode.Parse(json)!.AsObject();
        var result = Run("pa3-kh-block-names", new JsonArray(
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"Pa3Tag","as":"$blk"}"""),
            Op("""{"op":"create","parent":"$blk","type":"IInputParameter","name":"Text","as":"$bin"}"""),
            Op("""{"op":"set","target":"$bin","prop":"DataType","value":"Text"}"""),
            new JsonObject { ["op"] = "html", ["parent"] = "$blk", ["html"] = "<span class=\"pa3-tag\">{{ Text }}</span>" },
            Op("""{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Blocks","as":"$scr"}"""),
            Op("""{"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"}"""),
            new JsonObject { ["op"] = "html", ["parent"] = "$scr", ["html"] = "<div id=\"Pa3First\" class=\"pa3\"><span>Um</span><Block name=\"Pa3Tag\" :Text='\"a\"'></Block></div>" },
            new JsonObject { ["op"] = "html", ["parent"] = "$scr", ["html"] = "<div id=\"Pa3Second\" class=\"pa3\"><span>Dois</span><Block name=\"Pa3Tag\" :Text='\"b\"'></Block></div>" },
            Op("""{"op":"get","target":"$Pa3First/#IMobileBlockInstanceWidget"}"""),
            Op("""{"op":"get","target":"$Pa3Second/#IMobileBlockInstanceWidget"}""")));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var instances = result["results"]!.AsArray().Where(o => o!["op"]!.ToString() == "get").Select(o => o!["result"]!.AsObject()).ToList();
        Assert.Equal(2, instances.Count);
        Assert.All(instances, instance => Assert.Null(instance["properties"]!["Name"]));
        // the generated names of the second fragment are new on the screen
        var second = result["results"]!.AsArray()[7]!["result"]!.AsObject();
        Assert.Equal(["Pa3Second", "Span2"], second["names"]!.AsArray().Select(n => n!.ToString()).Order());
        // In the saved OML both instances carry the naming of the instances the Studio itself made in the fixture (every
        // unnamed one: Name and CustomName empty, the same CustomNameIsSuffix), where Block1 carried CustomName Block1.
        var naming = Naming(Path.Combine(Work, "pa3-kh-block-names.oml"));
        var ours = naming.Where(n => n.Display.EndsWith("\\Pa3Tag", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, ours.Count);
        var native = naming.Where(n => n.Display.EndsWith("\\DatePicker", StringComparison.Ordinal)).Select(n => (n.Name, n.Custom, n.Suffix)).Distinct().Single();
        Assert.Equal(("", "", native.Suffix), native);
        Assert.All(ours, n => Assert.Equal(native, (n.Name, n.Custom, n.Suffix)));
    }

    [Fact]
    public void AnImportOfTheThemesPartGoesFirstInTheRootsOwnStyleSheetWhenTheThemeServesThemeEditorCssFirst()
    {
        if (!StudioAvailable()) return;
        // C-05 (the proto line's f9a24e6a; F-FigmaMobile-02, F-FigmaReactive-02): the @import of a <style scope="theme"> landed in
        // the theme's author half, which the platform serves after the Theme Editor CSS (its :root{...}), so the browser ignored
        // it and the fonts never loaded, while the receipt said cssImportsHoisted. The document puts it first in the screen's own
        // style sheet (served with the screen, starting with it) and says so (cssImportsMoved, CSS_IMPORT_MOVED); the theme keeps
        // the rules.
        var html = "<screen name=\"Pa3Fonts\">\n<style scope=\"theme\" id=\"pa3-fonts\">" + Import + "\n.pa3-title { font-family: Inter; }</style>\n"
            + "<style>.pa3-page { padding: 4px; }</style>\n<div class=\"pa3-page\"><p class=\"pa3-title\">Fonts</p></div>\n</screen>";
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, "pa3-kh-theme-import-document.json");
        File.WriteAllText(job, new JsonObject
        {
            ["base"] = Path.Combine(Root, Fixture), ["expectValid"] = true,
            ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }),
            ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } },
                new JsonObject { ["op"] = "get", ["target"] = "IMobileTheme:WrightFlood" }),
        }.ToJsonString());
        var output = Path.Combine(Work, "pa3-kh-theme-import-document.oml");
        var host = new ModelHost(Work);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Path.Combine(Root, Fixture), job, output))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var theme = result["results"]!.AsArray().Last(o => o!["op"]!.ToString() == "get")!["result"]!["properties"]!.AsObject();
        Assert.True(theme["GeneratedStyleSheet"]!.GetValue<string>().Length > 0, "the fixture must have Theme Editor CSS for this test to mean anything");
        var author = theme["UserStyleSheet"]!.GetValue<string>();
        Assert.Contains(".pa3-title { font-family: Inter; }", author);
        Assert.DoesNotContain(Import, author);
        // The screen's own style sheet starts with the @import, then the document's own CSS; it reads back so.
        var text = host.HtmlRead(File.ReadAllBytes(output), "MobileScreen:Pa3Fonts", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("<style>" + Import + "\n.pa3-page { padding: 4px; }</style>", text);
        var report = result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().First(r => r["form"]?.ToString() == "document");
        var moved = Assert.Single(report["styleSheet"]!["cssImportsMoved"]!.AsArray())!;
        Assert.Contains(Import, moved["from"]!.ToString());
        Assert.Contains(report["normalized"]!.AsArray(), n => n!["code"]!.ToString() == "CSS_IMPORT_MOVED");
    }

    /// <summary>B4 (the U1 review's doubt on C23): the candidate a job leaves is the module it saves. In a theme with Theme Editor
    /// CSS the platform composes the effective StyleSheet as the Theme Editor CSS and then the author's (CalculateFinalCssSource,
    /// again when the module is saved, loaded and published); the kernel composed it with the author's @import first (C23), so the
    /// get of the job showed an effective StyleSheet that the saved module never had, and the proofs that read the candidate
    /// (merge, served, publish) compared a text no Studio serves. Now the effective StyleSheet of the candidate is the platform's
    /// composition, the get shows what the saved module holds, and the set says the @import is ignored there
    /// (cssImportsIgnored, as the html op says it), never that it went to the top.</summary>
    [Fact]
    public void TheEffectiveStyleSheetOfTheCandidateIsTheOneTheSavedModuleHas()
    {
        if (!StudioAvailable()) return;
        var css = ".pa3-b { font-family: Inter; }\n" + Import + "\n";
        var result = Run("pa3-kh-theme-import-saved", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:WrightFlood", ["prop"] = "StyleSheet", ["value"] = css },
            new JsonObject { ["op"] = "get", ["target"] = "IMobileTheme:WrightFlood" }));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var candidate = result["results"]!.AsArray().Last(o => o!["op"]!.ToString() == "get")!["result"]!["properties"]!.AsObject();
        var generated = candidate["GeneratedStyleSheet"]!.GetValue<string>();
        Assert.True(generated.Length > 0, "the fixture must have Theme Editor CSS for this test to mean anything");
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(Path.Combine(Work, "pa3-kh-theme-import-saved.oml")));
        string saved, savedAuthor;
        try
        {
            var theme = ((OutSystems.Model.IObjectSignature)espace).GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>()
                .First(o => TypeResolver.Name(o) == "WrightFlood" && ThemeCss.Of(o) != null);
            var sheet = ThemeCss.Of(theme)!;
            (saved, savedAuthor) = (sheet.EffectiveValue ?? "", ThemeCss.Author(sheet));
        }
        finally { ModelHost.Release(espace); }
        Assert.Contains(Import, savedAuthor);
        Assert.Equal(saved, candidate["StyleSheet"]!.GetValue<string>());
        Assert.Equal(generated + "\r\n" + savedAuthor, saved);
        var landing = result["results"]!.AsArray().First(o => o!["op"]!.ToString() == "set")!["result"]!["styleSheet"]!;
        Assert.DoesNotContain("effective StyleSheet", landing["cssImportsHoisted"]?.ToJsonString() ?? "", StringComparison.Ordinal);
        var ignored = landing["cssImportsIgnored"]!;
        Assert.Equal([Import], ignored["imports"]!.AsArray().Select(i => i!.ToString()));
        Assert.Equal(ThemeCss.ServedImportNote, ignored["served"]!.ToString());
    }

    /// <summary>(DisplayName, Name, CustomName, CustomNameIsSuffix) of every block instance of a saved OML, read from the
    /// concrete widget (CustomName and CustomNameIsSuffix are not in the Model API).</summary>
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static List<(string Display, string Name, string Custom, string Suffix)> Naming(string oml)
    {
        var espace = new ModelHost(Work).Load(File.ReadAllBytes(oml));
        try
        {
            // the most derived declaration: the widget hides AbstractObject.Name with its own
            string Read(object o, string property) => (o.GetType().GetProperties().Where(p => p.Name == property && p.GetIndexParameters().Length == 0)
                .OrderBy(p => p.DeclaringType == o.GetType() ? 0 : 1).FirstOrDefault()?.GetValue(o)?.ToString()) ?? "";
            return ((OutSystems.Model.IObjectSignature)espace).GetAllDescendantsOfType<OutSystems.Model.IObjectSignature>()
                .Where(o => o.GetType().Name == "WebBlockInstance")
                .Select(o => (Read(o, "DisplayName"), Read(o, "Name"), Read(o, "CustomName"), Read(o, "CustomNameIsSuffix"))).ToList();
        }
        finally { ModelHost.Release(espace); }
    }

    private static JsonObject Run(string name, JsonArray ops)
    {
        Directory.CreateDirectory(Work);
        var job = Path.Combine(Work, name + ".json");
        File.WriteAllText(job, new JsonObject { ["base"] = Path.Combine(Root, Fixture), ["expectValid"] = true, ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Work), Path.Combine(Root, Fixture), job, Path.Combine(Work, name + ".oml")))!.AsObject();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(Pa3KhOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
