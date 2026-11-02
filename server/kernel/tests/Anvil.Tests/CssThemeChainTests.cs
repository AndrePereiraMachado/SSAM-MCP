using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>B4 (the proto line's lote 4, frente F2: 6478486d, 0abbad00, a1f3b6da, 9daca5c2): CSS that a delivery writes and the
/// runtime does not show. The fixture of tests/fixtures/css-theme-chain: a producer theme module and a consumer with a local
/// theme based on it, a flow, a screen, a placed block, an unused block and a theme no page shows.
/// <list type="bullet">
/// <item>css.placement: every set StyleSheet says where its CSS landed and what serves it (relatos 8ea13c21, 31a4b527,
/// 0e627037); a theme of the module no page shows is refused before the build (CSS_TARGET_UNSERVED) with the fix; a theme the
/// job itself creates is a warning, as a block no page places.</item>
/// <item>HTML_CLASS_NO_RULE reads the producer theme the consumer keeps in its signature (relato 90a697c3).</item>
/// </list>
/// The ODC mirror is Anvil.Tests.Odc.CssThemeChainOdcTests over tests/fixtures/odc/css-theme-chain.</summary>
public sealed class CssThemeChainTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CssThemeChainTests).Assembly.Location)!)!;
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "css-theme-chain");
    private static readonly string Work = Path.Combine(Root, ".local", "css-theme-chain-tests");

    [Fact]
    public void EverySetStyleSheetSaysWhereItsCssLandedAndWhatServesIt()
    {
        Assert.True(StudioAvailable(), "these tests need the Service Studio's assemblies (headless)");
        var result = Run("css-chain-placement");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var placements = result["results"]!.AsArray().Select(r => r!["result"]!["css"]!["placement"]!.AsObject()).ToList();
        Assert.Equal(5, placements.Count);

        var local = placements[0];
        Assert.Equal("theme", local["object"]!.ToString());
        Assert.False(local["moduleDefault"]!.GetValue<bool>());
        var flow = Assert.Single(local["servedBy"]!.AsArray())!;
        Assert.Equal("ChainFlow", flow["flow"]!.ToString());
        Assert.Equal("the flow's Theme", flow["via"]!.ToString());
        Assert.True(local["served"]!.GetValue<bool>());

        Assert.True(placements[1]["moduleDefault"]!.GetValue<bool>());
        Assert.True(placements[1]["served"]!.GetValue<bool>());

        var card = placements[2];
        Assert.Equal("block", card["object"]!.ToString());
        Assert.Equal(["ChainScreen"], card["placedIn"]!.AsArray().Select(n => n!.ToString()));
        Assert.EndsWith(".ChainFlow.ChainCard.css", card["resource"]!.ToString());

        var unused = placements[3];
        Assert.False(unused["served"]!.GetValue<bool>());
        Assert.Contains(result["highWarnings"]!.AsArray(), w => w!["code"]!.ToString() == TargetUnserved && w["op"]!.GetValue<int>() == 3);

        var screen = placements[4];
        Assert.Equal("screen", screen["object"]!.ToString());
        Assert.Equal(["ChainLocalTheme", ProducerTheme()], screen["themes"]!.AsArray().Select(n => n!.ToString()));
        Assert.Equal(5, result["cssPlacement"]!.AsArray().Count);
    }

    [Fact]
    public void CssForAThemeNoPageShowsIsRefusedBeforeTheBuildWithTheFix()
    {
        Assert.True(StudioAvailable(), "these tests need the Service Studio's assemblies (headless)");
        var refusal = Assert.ThrowsAny<Exception>(() => Run("css-chain-orphan"));
        var text = Errors.Text(refusal);
        Assert.Contains(TargetUnserved, text, StringComparison.Ordinal);
        Assert.Contains("ChainOrphanTheme", text, StringComparison.Ordinal);
        Assert.Contains("ChainLocalTheme", text, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(Work, "css-chain-orphan.oml")), "a refused job saves nothing");
    }

    [Fact]
    public void CssForAThemeTheJobCreatesIsAWarningNeverTheRefusal()
    {
        Assert.True(StudioAvailable(), "these tests need the Service Studio's assemblies (headless)");
        var result = Run("css-chain-new-theme");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var warning = Assert.Single(result["highWarnings"]!.AsArray(), w => w!["code"]!.ToString() == TargetUnserved)!;
        Assert.Equal("medium", warning["severity"]!.ToString());
        Assert.Contains("ChainNewTheme", warning["message"]!.ToString(), StringComparison.Ordinal);
        Assert.Contains("new in this job", warning["message"]!.ToString(), StringComparison.Ordinal);
        Assert.True(File.Exists(Path.Combine(Work, "css-chain-new-theme.oml")));
    }

    [Fact]
    public void TheProducerThemeOfTheChainDefinesItsClasses()
    {
        Assert.True(StudioAvailable(), "these tests need the Service Studio's assemblies (headless)");
        var result = Run("css-chain-classes");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var report = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document");
        var missing = report["classesWithoutRule"]!;
        Assert.Equal(["zz-sem-regra"], missing["classes"]!.AsArray().Select(c => c!["class"]!.ToString()));
        Assert.Null(missing["themeElsewhere"]);
        var warning = Assert.Single(result["highWarnings"]!.AsArray(), w => w!["code"]!.ToString() == "HTML_CLASS_NO_RULE")!;
        Assert.Equal("high", warning["severity"]!.ToString());
    }

    private const string TargetUnserved = "CSS_TARGET_UNSERVED";
    private static string ProducerTheme() => "HeadlessMobile_UI.ChainProducerTheme";

    private static JsonObject Run(string job)
    {
        Directory.CreateDirectory(Work);
        var output = Path.Combine(Work, job + ".oml");
        if (File.Exists(output)) File.Delete(output);
        var host = new ModelHost(Directory.CreateDirectory(Path.Combine(Work, job)).FullName);
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, null, Path.Combine(Fixture, job + ".json"), output))!.AsObject();
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
