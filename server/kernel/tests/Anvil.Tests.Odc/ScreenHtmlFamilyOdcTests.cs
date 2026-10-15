using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>The families of the owner's session of 2026-10-12 on the ODC lane (ScreenHtmlFamilyCorpus): every family appended to
/// the screens and blocks of the committed fixture insurance-reactive and of the ODC modules of the plan's corpus by the edit form,
/// and one new screen with every family by the document form; each must read back as its native construct, a fixed point. Needs
/// the ODC Studio.</summary>
public class ScreenHtmlFamilyOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-html-families");

    [Fact]
    public void EveryFamilyOfTheReactiveFixtureReadsBackItsNativeConstruct()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the family battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        Anvil.Tests.ScreenHtmlFamilyCorpus.Fixture(Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml"),
            bytes => host.HtmlFamilyBattery(bytes, maxRoots: 6, log: output.WriteLine), output);
    }

    [Fact]
    public void EveryFamilyOfTheOdcCorpusReadsBackItsNativeConstruct()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the family battery is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        Anvil.Tests.ScreenHtmlFamilyCorpus.Check(Anvil.Tests.ScreenHtmlCoverage.Manifest(Root), "odc", bytes => host.HtmlFamilyBattery(bytes, maxRoots: 10), minPerFamily: 30, output);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenHtmlFamilyOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
