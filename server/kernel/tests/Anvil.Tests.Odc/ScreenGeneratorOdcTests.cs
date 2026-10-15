using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>Screens from entities and blocks (gen-screen/1) on the ODC lane: the proof job (jobs-odc/screen-generate.json, the
/// insurance app with three entities of the job) compiles with no new message, every generated root is a C1 fixed point and the
/// same request again is NO_CHANGE; the corpus run (ScreenGeneratorCorpus) with SSAM_GEN_SCREEN_CORPUS=1. Needs the ODC Studio.</summary>
public class ScreenGeneratorOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", "lane-odc", "screen-generator");

    [Fact]
    public void TheOdcProofJobCompilesWithoutNewMessagesIsAFixedPointAndTheSecondRunIsNoChange()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var (_, receipt) = Anvil.Tests.ScreenGeneratorCorpus.Proof(new ModelHost(Work), null, Path.Combine(Root, "tests", "jobs-odc", "screen-generate.json"),
            Path.Combine(Work, "proof"), new JsonArray("GenTicket", "GenTeam", "GenAsset"), output);
        var created = receipt["create"]!.AsArray().Select(c => c!["kind"] + ":" + c["name"]).ToList();
        foreach (var expected in new[] { "screen:GenTicketList", "screen:GenTicketDetail", "screen:GenTicketEdit", "block:Pager", "block:ConfirmDialog", "block:FilterBar", "action:SaveGenTicket", "action:RemoveGenTicket" })
            Assert.Contains(expected, created);
        // The insurance app's screens have the app role: the generated ones take it.
        Assert.Equal("AppRole:InsuranceApp", receipt["roles"]!.ToString());
    }

    [Fact]
    public void ScreensAreGeneratedOverTheOdcCorpus()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        Anvil.Tests.ScreenGeneratorCorpus.Check(Anvil.Tests.ScreenHtmlCoverage.Manifest(Root), "odc", new ModelHost(Work), Path.Combine(Work, "corpus"), output);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(ScreenGeneratorOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
