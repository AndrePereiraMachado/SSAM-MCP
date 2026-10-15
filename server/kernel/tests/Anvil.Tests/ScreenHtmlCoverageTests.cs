using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>E0 (screens) and the acceptance of C1 of the plan "Texto do SSAM" over the O11 corpus: every screen and block of
/// the 23 O11 modules with screens reads as ssam-html/1 at the fixed point, with the floors of section 4.2 (ScreenHtmlCoverage).
/// Needs the Service Studio and the captures of tests/contracts/screen-html/corpus.json; without them it is skipped with a
/// warning.</summary>
public class ScreenHtmlCoverageTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlCoverageTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-coverage");

    [Fact]
    public void EveryScreenAndBlockOfTheO11CorpusReadsAtTheFixedPointAboveTheFloors()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the screen-html corpus test is skipped."); return; }
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        ScreenHtmlCoverage.Check(ScreenHtmlCoverage.Manifest(Root), "o11", bytes => host.HtmlCheck(bytes), output);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
