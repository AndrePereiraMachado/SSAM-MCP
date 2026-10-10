using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane kh of the atritos 3 package on the ODC model (the WrightFlood fixture, whose theme has Theme Editor CSS):
/// <list type="bullet">
/// <item>C23: an @import of the author's CSS goes to the top of the effective StyleSheet, before the Theme Editor block (lab
/// 29: the fonts never loaded), and the set says so (cssImportsHoisted); the author half keeps it as written.</item>
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
    public void ImportGoesBeforeTheThemeEditorBlockAndReactContainerAlsoSelectsInTheCanvas()
    {
        if (!StudioAvailable()) return;
        var css = "#reactContainer .pa3-shell { padding: 0; }\n.pa3-a { font-family: Inter; }\n" + Import + "\n";
        var result = Run("pa3-kh-theme-import", new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = "IMobileTheme:WrightFlood", ["prop"] = "StyleSheet", ["value"] = css },
            new JsonObject { ["op"] = "get", ["target"] = "IMobileTheme:WrightFlood" }));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() ?? result.ToJsonString());
        var landing = result["results"]!.AsArray().First(o => o!["op"]!.ToString() == "set")!["result"]!["styleSheet"]!;
        Assert.Contains(Import, landing["cssImportsHoisted"]![0]!["from"]!.ToString());
        Assert.Equal(":is(#reactContainer, body) .pa3-shell", landing["cssRewrites"]![0]!["to"]!.ToString());
        var theme = result["results"]!.AsArray().Last(o => o!["op"]!.ToString() == "get")!["result"]!["properties"]!.AsObject();
        var generated = theme["GeneratedStyleSheet"]!.GetValue<string>();
        var author = theme["UserStyleSheet"]!.GetValue<string>();
        var effective = theme["StyleSheet"]!.GetValue<string>();
        Assert.True(generated.Length > 0, "the fixture must have Theme Editor CSS for this test to mean anything");
        Assert.StartsWith(Import + "\r\n" + generated + "\r\n", effective);
        Assert.DoesNotContain(Import, effective[Import.Length..]);
        Assert.Contains(":is(#reactContainer, body) .pa3-shell { padding: 0; }", author);
        Assert.Contains(Import, author);   // the author's text keeps its @import
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
