using Anvil.Core;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Merge;
using OutSystems.ModelAPILoader;
using ServiceStudio.Hashes;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

// U1 round 2 (REVISAO-U1 probe, item 6): a theme with Theme Editor CSS whose author CSS carries an @import after a rule
// (the kernel hoists it above the Theme Editor block, ThemeCss.Settle C23), merged by the headless stand-in of CompareAndMerge
// (MatchTree.Merge in a transaction), then NativeStyleSheetCache.Refresh as VerifyMerged calls it.
public class StyleSheetMergeImportTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ProbeMergeThenRefresh(bool split, bool import)
    {
        Assert.True(Bind(), "ODC Studio assemblies not available");
        var root = Path.GetDirectoryName(typeof(StyleSheetMergeImportTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Directory.GetParent(root)!.FullName;
        var host = new ModelHost(Path.Combine(root, ".local", "lane-odc", "stylesheet-merge-import", Guid.NewGuid().ToString("N")));
        var basis = (ESpace)Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "ProbeFixture", targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        ESpace? candidate = null, live = null, merged = null, expected = null, over = null, b = null;
        try
        {
            new ModelSession(basis).Apply(JsonNode.Parse("""[{"op":"create","parent":"@espace","type":"IMobileTheme","name":"InsuranceApp"}]""")!.AsArray());
            StudioAdapter.Runtime.Mutate(basis, "fixture", _ =>
            {
                Sheet(basis).GeneratedEffectiveValue = split ? ":root { --fixture-color: red; }" : "";
                ThemeCss.WriteAuthor(Sheet(basis), ".fixture { color: black; }");
            });
            var baseBytes = host.Save(basis);
            candidate = host.Load(baseBytes);
            StudioAdapter.Runtime.Mutate(candidate, "change author CSS", _ =>
                ThemeCss.WriteAuthor(Sheet(candidate), ThemeCss.Author(Sheet(candidate)) + "\n.cache-proof { color: #123456; }" + (import ? "\n@import url(\"https://example.com/a.css\");" : "")));
            var candidateBytes = host.Save(candidate);
            output.WriteLine("candidate effective: " + Sheet(candidate).EffectiveValue?.Replace("\r\n", "\\r\\n"));
            live = host.Load(baseBytes);
            var liveSheet = Sheet(live);
            var baseCompilation = liveSheet.GetHash(HashType.Compilation);
            expected = host.Load(candidateBytes);
            over = host.Load(baseBytes);
            var foreign = host.Load(candidateBytes);
            try { ((IESpace)live).TransactionsManager.ExecuteTransaction("probe: native merge", (_, _) => { using var tree = new MatchTree(live, foreign, over, false, true); Assert.False(tree.HasConflicts); tree.Merge(); return true; }); }
            finally { ModelHost.Release(foreign); }
            output.WriteLine("live effective after merge: " + liveSheet.EffectiveValue?.Replace("\r\n", "\\r\\n"));
            output.WriteLine("effective equal: " + (liveSheet.EffectiveValue == Sheet(expected).EffectiveValue) + "; author equal: " + (liveSheet.UserEffectiveValue == Sheet(expected).UserEffectiveValue) + "; generated equal: " + (liveSheet.GeneratedEffectiveValue == Sheet(expected).GeneratedEffectiveValue));
            output.WriteLine("compilation hash after merge: base=" + baseCompilation + " live=" + liveSheet.GetHash(HashType.Compilation) + " candidate=" + Sheet(expected).GetHash(HashType.Compilation));
            Exception? refused = null; NativeStyleSheetCache.Entry[] entries = [];
            b = host.Load(baseBytes);
                try { entries = NativeStyleSheetCache.Refresh(live, expected, b); } catch (Exception e) { refused = e; }
            output.WriteLine("refresh: " + (refused?.Message ?? ("ok, " + entries.Length + " entr(ies): " + string.Join("; ", entries.Select(e => e.Before + " -> " + e.After)))));
            output.WriteLine("effective after refresh equal to candidate: " + (liveSheet.EffectiveValue == Sheet(expected).EffectiveValue));
            merged = host.Load(host.Save(live));
            output.WriteLine("saved/loaded: compilation " + Sheet(merged).GetHash(HashType.Compilation) + "; differences vs candidate sources: " + string.Join(",", NativeStyleSheetCache.Differences(merged, NativeStyleSheetCache.Capture(expected))));
            Assert.Null(refused);
            // What VerifyMerged needs of a theme with Theme Editor CSS and an author @import (C23): the merge keeps the candidate's three
            // texts, the refresh changes none of them and leaves the candidate's compilation hash, and what is saved has its sources.
            Assert.Equal(Sheet(expected).EffectiveValue, liveSheet.EffectiveValue);
            Assert.Equal(Sheet(expected).UserEffectiveValue, liveSheet.UserEffectiveValue);
            Assert.Equal(Sheet(expected).GeneratedEffectiveValue, liveSheet.GeneratedEffectiveValue);
            Assert.Single(entries);
            Assert.Equal(Sheet(expected).GetHash(HashType.Compilation), liveSheet.GetHash(HashType.Compilation));
            Assert.Empty(NativeStyleSheetCache.Differences(merged, NativeStyleSheetCache.Capture(expected)));
        }
        finally { ModelHost.Release(b); ModelHost.Release(over); ModelHost.Release(expected); ModelHost.Release(merged); ModelHost.Release(live); ModelHost.Release(candidate); ModelHost.Release(basis); }
    }

    private static WebStyleSheet Sheet(ESpace module) => module.NRThemes.Single(t => t.Name == "InsuranceApp").StyleSheet;
    private static bool Bind() { try { StudioAssembliesOdc.Bind(); return true; } catch { return false; } }
}
