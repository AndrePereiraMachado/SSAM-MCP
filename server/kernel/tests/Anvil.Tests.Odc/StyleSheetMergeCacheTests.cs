using Anvil.Core;
using System.Text.Json.Nodes;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Hashes;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// U1 (ODC bridge v106/v107, platforms/odc/studio/engine/NativeStyleSheetCache.cs linked here), ported from the proto's v105:
/// a merged stylesheet whose source is the candidate's may still carry the compilation hashes of the base, and the server
/// then publishes the old CSS (FloodQuotes, 2026-10-28: 82,806 characters served for the 82,815 sent, and ok:true). Headless,
/// over the ODC Studio's own model: the caches of a changed sheet are rebuilt without touching its texts, audit or key; an
/// unchanged sheet is left alone; a lost source is a refusal and is never rewritten from the candidate; and the check of a
/// published revision compares sources, so a stale hash that looks right never passes.
/// </summary>
public class StyleSheetMergeCacheTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RefreshesAStaleCompilationCacheWithoutChangingSourceAuditOrKey(bool split)
    {
        StudioAssembliesOdc.Bind(); // the main proof of U1: fails, never passes silently, without the ODC Studio
        Run(split, (host, basis, expected, live) =>
        {
            var sheet = Sheet(live);
            var oldHash = Sheet(basis).GetHash(HashType.Compilation);
            var currentHash = Sheet(expected).GetHash(HashType.Compilation);
            Assert.NotEqual(oldHash, currentHash);
            // The state of the line's false positive: the source is the candidate's, the compilation hash the base's.
            StaleHash(live, sheet, oldHash);
            Assert.Equal(oldHash, sheet.GetHash(HashType.Compilation));
            var (source, author, generated, date, by, key) = (sheet.EffectiveValue, sheet.UserEffectiveValue, sheet.GeneratedEffectiveValue, sheet.LastModifiedDate, sheet.LastModifiedBy, sheet.Key);

            var entry = Assert.Single(NativeStyleSheetCache.Refresh(live, expected, basis));
            Assert.Equal(key.ToString(), entry.Key);
            Assert.NotEqual(entry.Before, entry.After);
            Assert.Equal(currentHash, sheet.GetHash(HashType.Compilation));
            Assert.Equal(source, sheet.EffectiveValue);
            Assert.Equal(author, sheet.UserEffectiveValue);
            Assert.Equal(generated, sheet.GeneratedEffectiveValue);
            Assert.Equal(date, sheet.LastModifiedDate);
            Assert.Equal(by, sheet.LastModifiedBy);
            Assert.Equal(key, sheet.Key);

            // What the bridge saves (after-merge.oml, before-publish.oml) carries the fresh cache.
            var saved = host.Load(host.Save(live));
            try
            {
                Assert.Equal(source, Sheet(saved).EffectiveValue);
                Assert.Equal(currentHash, Sheet(saved).GetHash(HashType.Compilation));
            }
            finally { ModelHost.Release(saved); }
        });
    }

    [Fact]
    public void ACreatedModuleHasNoBaseAndEverySheetOfItsCandidateIsRefreshed()
    {
        StudioAssembliesOdc.Bind(); // the main proof of U1: fails, never passes silently, without the ODC Studio
        Run(false, (_, basis, expected, live) =>
        {
            var oldHash = Sheet(basis).GetHash(HashType.Compilation);
            StaleHash(live, Sheet(live), oldHash);
            Assert.NotEmpty(NativeStyleSheetCache.Refresh(live, expected, null));
            Assert.Equal(Sheet(expected).GetHash(HashType.Compilation), Sheet(live).GetHash(HashType.Compilation));
        });
    }

    [Fact]
    public void AnUnchangedStylesheetIsNotRefreshed()
    {
        StudioAssembliesOdc.Bind(); // the main proof of U1: fails, never passes silently, without the ODC Studio
        Run(false, (_, _, _, live) => Assert.Empty(NativeStyleSheetCache.Refresh(live, live, live)));
    }

    [Fact]
    public void ThePublishedSourceCheckRejectsOldCssDespiteMatchingCachedHashes()
    {
        StudioAssembliesOdc.Bind(); // the main proof of U1: fails, never passes silently, without the ODC Studio
        Run(false, (_, basis, expected, live) =>
        {
            var submitted = NativeStyleSheetCache.Capture(expected);
            var expectedHash = Sheet(expected).GetHash(HashType.Compilation);
            // A "published" revision with the old CSS and the hash of the new one.
            StaleHash(basis, Sheet(basis), expectedHash, Sheet(expected).GetHash(HashType.CompilationInterface));
            Assert.Equal(expectedHash, Sheet(basis).GetHash(HashType.Compilation));
            Assert.Equal(new[] { Sheet(basis).Key.ToString() }, NativeStyleSheetCache.Differences(basis, submitted));
            Assert.Empty(NativeStyleSheetCache.Differences(live, submitted));
        });
    }

    [Fact]
    public void ThePublishedSourceCheckNamesAMissingAndAnUnexpectedStylesheet()
    {
        StudioAssembliesOdc.Bind(); // the main proof of U1: fails, never passes silently, without the ODC Studio
        Run(false, (_, _, expected, live) =>
        {
            var submitted = NativeStyleSheetCache.Capture(expected);
            submitted.Add("missing-style", new NativeStyleSheetCache.SourceText("test", "", ""));
            Assert.Equal(new[] { "missing-style" }, NativeStyleSheetCache.Differences(live, submitted));
            submitted.Clear();
            Assert.NotEmpty(NativeStyleSheetCache.Differences(live, submitted));
        });
    }

    [Fact]
    public void LostCssIsARefusalAndIsNeverReplacedFromTheCandidate()
    {
        StudioAssembliesOdc.Bind(); // the main proof of U1: fails, never passes silently, without the ODC Studio
        Run(false, (_, basis, expected, live) =>
        {
            StudioAdapter.Runtime.Mutate(live, "reproduce dropped stylesheet text", _ => ThemeCss.WriteAuthor(Sheet(live), "/* lost source */"));
            var refused = Assert.Throws<InvalidOperationException>(() => NativeStyleSheetCache.Refresh(live, expected, basis));
            Assert.Contains("Merged stylesheet differs from the candidate", refused.Message);
            Assert.Equal("/* lost source */", Sheet(live).EffectiveValue);
        });
    }

    private static void StaleHash(ESpace module, WebStyleSheet sheet, object compilation, object? compilationInterface = null) =>
        StudioAdapter.Runtime.Mutate(module, "reproduce a stale compilation cache", _ =>
            typeof(AbstractObject).GetMethod("SetCompilationHashes", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .Invoke(sheet, new object[] { compilation, compilationInterface ?? sheet.GetHash(HashType.CompilationInterface) }));

    private static WebStyleSheet Sheet(ESpace module) => module.NRThemes.Single(t => t.Name == "InsuranceApp").StyleSheet;

    // basis: a library with one theme; expected: basis plus one author rule (the candidate); live: expected saved and loaded again
    // (the open module after the merge).
    private static void Run(bool split, Action<ModelHost, ESpace, ESpace, ESpace> test)
    {
        var root = Path.GetDirectoryName(typeof(StyleSheetMergeCacheTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Directory.GetParent(root)!.FullName;
        var host = new ModelHost(Path.Combine(root, ".local", "lane-odc", "stylesheet-cache-tests", Guid.NewGuid().ToString("N")));
        var basis = (ESpace)Loader.ModelServicesInstance.CreateESpace(SegmentationKind.ReactiveLibrary, "CacheFixture",
            targetPlatform: PlatformServerVersion.Neo, enableTransactions: true);
        ESpace? expected = null, live = null;
        try
        {
            new ModelSession(basis).Apply(JsonNode.Parse("""
                [{"op":"create","parent":"@espace","type":"IMobileTheme","name":"InsuranceApp"}]
                """)!.AsArray());
            StudioAdapter.Runtime.Mutate(basis, "stylesheet fixture", _ =>
            {
                Sheet(basis).GeneratedEffectiveValue = split ? ":root { --fixture-color: red; }" : "";
                ThemeCss.WriteAuthor(Sheet(basis), ".fixture { color: black; }");
            });
            expected = host.Load(host.Save(basis));
            StudioAdapter.Runtime.Mutate(expected, "change author CSS", _ =>
                ThemeCss.WriteAuthor(Sheet(expected), ThemeCss.Author(Sheet(expected)) + "\n.cache-proof { color: #123456; }"));
            live = host.Load(host.Save(expected));
            test(host, basis, expected, live);
        }
        finally { ModelHost.Release(live); ModelHost.Release(expected); ModelHost.Release(basis); }
    }
}
