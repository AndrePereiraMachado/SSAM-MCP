using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>C2 of the plan "Texto do SSAM" on the ODC lane: the battery of synthetic edits (ScreenHtmlEditCorpus) over the
/// committed fixture insurance-reactive and over the ODC modules of the plan's corpus (absent captures are skipped with a
/// warning). Needs the ODC Studio.</summary>
public class ScreenHtmlEditBatteryOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-html-edit");

    [Fact]
    public void EverySyntheticEditOfTheReactiveFixtureReadsBack()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the C2 battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        Anvil.Tests.ScreenHtmlEditCorpus.Fixture(Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml"), 100,
            bytes => host.HtmlEditBattery(bytes, seed: 3, perKind: 1), output);
    }

    [Fact]
    public void EverySyntheticEditOfTheOdcCorpusReadsBack()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the C2 battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var manifest = Anvil.Tests.ScreenHtmlCoverage.Manifest(Root);
        var c2 = JsonNode.Parse(File.ReadAllText(manifest))!["c2"]!;
        Anvil.Tests.ScreenHtmlEditCorpus.Check(manifest, "odc", bytes => host.HtmlEditBattery(bytes, c2["seed"]!.GetValue<int>(), c2["perKind"]!.GetValue<int>()), output);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlEditBatteryOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
