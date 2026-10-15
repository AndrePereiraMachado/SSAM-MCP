using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>E0 (screens) and the acceptance of C1 of the plan "Texto do SSAM" over the ODC corpus: every screen and block of
/// the 4 ODC modules with screens reads as ssam-html/1 at the fixed point, with the floors of section 4.2 (ScreenHtmlCoverage).
/// Needs the ODC Studio and the captures of tests/contracts/screen-html/corpus.json; without them it is skipped with a
/// warning.</summary>
public class ScreenHtmlCoverageOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-html-coverage");

    [Fact]
    public void EveryScreenAndBlockOfTheOdcCorpusReadsAtTheFixedPointAboveTheFloors()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the screen-html corpus test is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        Anvil.Tests.ScreenHtmlCoverage.Check(Anvil.Tests.ScreenHtmlCoverage.Manifest(Root), "odc", bytes => host.HtmlCheck(bytes), output);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlCoverageOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
