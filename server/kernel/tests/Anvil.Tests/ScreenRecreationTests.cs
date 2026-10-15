using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The acceptance of B1 of the plan "Texto do SSAM" over the O11 corpus: every real screen read by ssam-html/1 and
/// compiled again by the document form of the html op, in the loaded copy without it, comes back the same (text and
/// Verify), above the floor and with only the known causes (ScreenRecreationCorpus). Needs the Service Studio and the
/// captures of tests/contracts/screen-html/corpus.json; without them it is skipped with a warning.</summary>
public class ScreenRecreationTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenRecreationTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-recreation");

    [Fact]
    public void EveryRealScreenOfTheO11CorpusIsCompiledAgainByTheDocumentFormAndComesBackTheSame()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the screen recreation corpus test is skipped."); return; }
        Directory.CreateDirectory(Work);
        ScreenRecreationCorpus.Check(ScreenHtmlCoverage.Manifest(Root), "o11", new ModelHost(Work), output);
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
