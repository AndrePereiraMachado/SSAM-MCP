using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>The acceptance of B1 of the plan "Texto do SSAM" over the ODC corpus: every real screen read by ssam-html/1 and
/// compiled again by the document form of the html op, in the loaded copy without it, comes back the same (text and
/// Verify), above the floor and with only the known causes (ScreenRecreationCorpus). Needs the ODC Studio and the captures of
/// tests/contracts/screen-html/corpus.json; without them it is skipped with a warning.</summary>
public class ScreenRecreationOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-recreation");

    [Fact]
    public void EveryRealScreenOfTheOdcCorpusIsCompiledAgainByTheDocumentFormAndComesBackTheSame()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: the screen recreation corpus test is skipped."); return; }
        Directory.CreateDirectory(Work);
        Anvil.Tests.ScreenRecreationCorpus.Check(Anvil.Tests.ScreenHtmlCoverage.Manifest(Root), "odc", new ModelHost(Work), output);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenRecreationOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
