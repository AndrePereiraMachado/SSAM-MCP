using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>servidor/fase4-26 (M2, C:\t\vps-a6\PLANO.md section 3): on a hosted server the module index is one store for every
/// customer, addressed by hashes only. With ANVIL_KEPT_READINGS=own (the hosted server sets it for every kernel process) a job
/// reads a kept reading (an html reading's keys and text, an action's flow read, a data text) only of the capture it runs on;
/// another capture's reading is not kept for it, so a customer who knows the two hashes of another customer's reading never
/// gets it as the base of an edit. Locally nothing changes. No Studio.</summary>
public class KeptReadingRuleTests
{
    private static string Sha(char c) => new(c, 64);

    // The store of one test: a temporary root, Default() in its flow of execution only (as HtmlElementEditJobTests.OwnStore).
    private sealed class OwnStore : IDisposable
    {
        public readonly ModuleIndexStore Store;
        private readonly IDisposable scope;
        public OwnStore()
        {
            Store = new ModuleIndexStore(Path.Combine(Path.GetTempPath(), "kept-reading-" + Guid.NewGuid().ToString("N")), "o11", "kernel");
            scope = ModuleIndexStore.Use(Store);
        }
        public void Dispose()
        {
            scope.Dispose();
            try { if (Directory.Exists(Store.Root)) Directory.Delete(Store.Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static void KeepHtml(ModuleIndexStore store, string capture, string html)
    {
        var file = store.HtmlKeysPathOf(capture, html);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, new JsonObject {
            ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = capture, ["root"] = "Login",
            ["htmlSha256"] = html, ["keys"] = new JsonObject { ["w1"] = "objectkey-of-another-customer" }, ["html"] = "<screen name=\"Login\"><div k=\"w1\"></div></screen>" }.ToJsonString());
    }

    [Fact]
    public void TheRuleIsOwnInAnyCaseAndNothingElse()
    {
        Assert.True(ModuleIndexStore.OwnReadingsRule("own"));
        Assert.True(ModuleIndexStore.OwnReadingsRule(" OWN "));
        foreach (var other in new[] { null, "", "all", "0", "1" }) Assert.False(ModuleIndexStore.OwnReadingsRule(other));
        using (ModuleIndexStore.OwnReadings(false)) Assert.True(ModuleIndexStore.KeptReadingAllowed(Sha('a'), null));
        using (ModuleIndexStore.OwnReadings()) {
            Assert.False(ModuleIndexStore.KeptReadingAllowed(Sha('a'), null));
            Assert.False(ModuleIndexStore.KeptReadingAllowed(Sha('a'), Sha('b')));
            Assert.False(ModuleIndexStore.KeptReadingAllowed(null, null));
            Assert.True(ModuleIndexStore.KeptReadingAllowed(Sha('a'), Sha('a').ToUpperInvariant()));
        }
    }

    [Fact]
    public void AKeptHtmlReadingIsReadOnlyForTheJobsOwnCapture()
    {
        using var own = new OwnStore();
        var theirs = Sha('a'); var mine = Sha('b'); var html = Sha('c');
        KeepHtml(own.Store, theirs, html);
        using (ModuleIndexStore.OwnReadings(false)) {
            Assert.NotNull(own.Store.LoadHtmlKeys(theirs, html));
            Assert.NotNull(own.Store.LoadHtmlKeys(theirs, html, mine));
        }
        using (ModuleIndexStore.OwnReadings()) {
            Assert.Null(own.Store.LoadHtmlKeys(theirs, html));          // no job: check-job and the static rules skip it
            Assert.Null(own.Store.LoadHtmlKeys(theirs, html, mine));    // the job runs on another capture
            Assert.NotNull(own.Store.LoadHtmlKeys(theirs, html, theirs)); // the reading of the job's own capture
        }
    }

    [Fact]
    public void AKeptFlowReadIsReadOnlyBesideTheJobsOwnCapture()
    {
        using var own = new OwnStore();
        var foreign = new FlowReading("o11", Sha('d'), "k1", "ServerAction", "A", "action A() {\n}\n", new Dictionary<string, string>());
        own.Store.SaveFlowReading(foreign);
        Assert.Equal(Sha('d'), own.Store.LoadFlowReading(foreign.TextSha)!.SourceSha256);   // any capture of the lane (local rule)
        Assert.Null(own.Store.LoadFlowReading(foreign.TextSha, Sha('a')));                   // only beside the job's own capture
        var mine = foreign with { SourceSha256 = Sha('a') };
        own.Store.SaveFlowReading(mine);
        Assert.Equal(Sha('a'), own.Store.LoadFlowReading(mine.TextSha, Sha('a'))!.SourceSha256);
        Assert.Null(own.Store.LoadFlowReading(mine.TextSha, "not-a-sha"));
    }
}
