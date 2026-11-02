using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

// U1 (bridge v106/v107) without a Studio: the theme cache and the verified publication, ported from the proto's v105
// (FloodQuotes revisions 512 and 513). The rules over the Studio's own model (NativeStyleSheetCache) are proven headless in
// kernel/tests/Anvil.Tests.Odc/StyleSheetMergeCacheTests.cs; here, the verdict of a publication, the verification of a merge as
// a job of its own, and the source rules that StartupHook.cs follows them at every site.
public sealed class VerifiedPublicationTests {
    private static string Source(string file, [CallerFilePath] string here = "") =>
        File.ReadAllText(Path.Combine(Path.GetDirectoryName(here)!, "..", file)).Replace("\r\n", "\n");
    private static string Body(string source, string signature) {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, "not found: " + signature);
        var end = source.IndexOf("\n    }\n", start, StringComparison.Ordinal);
        return source[start..end];
    }

    // ---- change 4: a publication is ok only when verified against before-publish.oml.

    [Fact]
    public void The_false_positive_of_the_line_a_stale_stylesheet_with_no_MatchTree_difference_is_not_verified() {
        // 2026-10-28: nothing differed outside references (matchesOpenModule was outside.Length == 0) and the server served 82,806
        // characters of CSS instead of the 82,815 sent.
        var verdict = PublishVerification.Of(outside: [], styles: ["7a1c0a3e-theme-sheet"], matchTreeEqual: true, failure: null);
        Assert.False(verdict.Verified);
        Assert.False(verdict.StrictlyEqual);
        Assert.Contains("7a1c0a3e-theme-sheet", verdict.Reason);
        Assert.Contains("before-publish.oml", verdict.Reason);
    }

    [Fact]
    public void A_missing_download_or_comparison_and_a_difference_outside_references_are_never_verified() {
        Assert.False(PublishVerification.Of(null, null, false, "Latest published revision could not be verified for Shop").Verified);
        Assert.False(PublishVerification.Of([], null, true, null).Verified);
        Assert.False(PublishVerification.Of(null, [], true, null).Verified);
        var outside = PublishVerification.Of(["Shop/MainFlow/Home [ChangedInLocal]"], [], false, null);
        Assert.False(outside.Verified);
        Assert.Contains("outside references", outside.Reason);
    }

    [Fact]
    public void The_bytes_sent_verify_a_publication_whatever_the_open_module_became_meanwhile() {
        // The line's F1/H3 rule (b4577721): the person edits the module during the publication; the server holds the bytes sent.
        var edited = PublishVerification.Of(outside: ["Shop/MainFlow/Home [ChangedInLocal]"], styles: [], matchTreeEqual: false, failure: null, sentEqual: true);
        Assert.True(edited.Verified);
        Assert.False(edited.StrictlyEqual, "not equal to the open module, which changed");
        Assert.Contains("byte for byte", edited.Note);
        Assert.Contains("open-vs-published.txt", edited.Note);
        // The bytes are the proof even when the comparison with the open module could not run.
        Assert.True(PublishVerification.Of(null, null, false, "MatchTree failed", sentEqual: true).Verified);
        // Other bytes and a difference: still refused.
        Assert.False(PublishVerification.Of(["Shop/MainFlow/Home [ChangedInLocal]"], [], false, null, sentEqual: false).Verified);
    }

    [Fact]
    public void Publish_compares_the_sha256_of_the_downloaded_revision_with_the_bytes_sent_and_answers_the_published_block() {
        var publish = Body(Source("StartupHook.cs"), "private static async Task<object> Publish(string argument, Context c)");
        Assert.Contains("sentEqual = string.Equals(Hash(File.ReadAllBytes(file)), Hash(sent), StringComparison.OrdinalIgnoreCase)", publish);
        Assert.Contains("PublishVerification.Of(outside, styles, equal, failure, sentEqual == true)", publish);
        Assert.Contains("{ Unverified = download }", publish);
        // The answer carries verified:false and the published block, which the facade reads as PUBLISHED_REVISION_DIFFERS.
        var serve = Body(Source("StartupHook.cs"), "private static async Task<PipeAnswer> ServeLine(string line)");
        Assert.Contains("error is PublishFailedException { Unverified: not null } unverified", serve);
        Assert.Contains("verified = false, published = unverified.Unverified", serve);
    }

    [Fact]
    public void Only_an_equal_module_with_every_submitted_stylesheet_is_verified() {
        var verdict = PublishVerification.Of([], [], matchTreeEqual: true, failure: null);
        Assert.True(verdict.Verified);
        Assert.True(verdict.StrictlyEqual);
        Assert.Null(verdict.Reason);
        Assert.False(PublishVerification.Of([], [], matchTreeEqual: false, failure: null).StrictlyEqual, "references refreshed: verified, not strictly equal");
    }

    [Fact]
    public void The_refusal_of_an_unverified_publication_is_read_as_a_failed_publication_and_steers_no_gate() {
        var verdict = PublishVerification.Of([], ["sheet-1", "sheet-2"], true, null);
        var text = PublishVerification.Refusal("FloodQuotes", "CompletedWithSuccess", 513, verdict);
        // The facade answers PUBLISH_FAILED with the log of the publication for every refusal after the dispatch
        // (platforms/odc/facade/studio-publish-log.mjs AFTER_DISPATCH).
        Assert.Matches(new Regex("Publication of .+ (ended in state|is still running)"), text);
        Assert.StartsWith("Publication of FloodQuotes ended in state CompletedWithSuccess, but the published revision 513 is not verified: ", text);
        Assert.Contains("stylesheetSourceDifferences", text);
        Assert.Equal("none", Journal.Gate(text));
        Assert.DoesNotMatch(new Regex("[^\\x20-\\x7E]"), text); // English, plain ASCII
        // The very text platforms/odc/facade/tests/publish-verified.test.mjs gives the facade.
        Assert.Equal("Publication of FloodQuotes ended in state CompletedWithSuccess, but the published revision 513 is not verified: 1 stylesheet(s) whose source differs from before-publish.oml, is missing or is new (sheet-1). The server may serve what the delivery did not send. Nothing was repeated; publish-receipt.json (published.differencesOutsideReferences, published.stylesheetSourceDifferences) and open-vs-published.txt name each difference.",
            PublishVerification.Refusal("FloodQuotes", "CompletedWithSuccess", 513, PublishVerification.Of([], ["sheet-1"], true, null)));
    }

    [Fact]
    public void Publish_answers_ok_only_when_verified_and_throws_the_PublishFailedException_family_otherwise() {
        var publish = Body(Source("StartupHook.cs"), "private static async Task<object> Publish(string argument, Context c)");
        Assert.DoesNotContain("matchesOpenModule = outside.Length == 0", publish);
        Assert.Contains("before-publish.oml", publish);
        Assert.Contains("NativeStyleSheetCache.Differences(published, submittedStyles)", publish);
        Assert.Contains("PublishVerification.Of(outside, styles, equal, failure, sentEqual == true)", publish);
        Assert.Contains("ok = success && verified", publish);
        Assert.Contains("verified, state", publish);
        Assert.Contains("if (!verified) throw new PublishFailedException(PublishVerification.Refusal(", publish);
        // The download and the comparison share one failure: an exception there is verified:false, never ok:true.
        Assert.Matches(new Regex(@"catch \(Exception error\) \{ failure = error\.Message; \}"), publish);
    }

    [Fact]
    public void Right_before_the_publication_the_stylesheets_are_checked_and_their_caches_refreshed() {
        var dispatch = Body(Source("StartupHook.cs"), "private static async Task<object> PublishDispatch(string manifestPath, Context c)");
        var refresh = dispatch.IndexOf("NativeStyleSheetCache.Refresh(s, source, basis)", StringComparison.Ordinal);
        var started = dispatch.LastIndexOf("\"publish-started.json\"", StringComparison.Ordinal); // the write, after the early refusal
        var publish = dispatch.IndexOf("ServiceStudio.Presenter.Commands.Publish>.Instance.Execute", StringComparison.Ordinal);
        Assert.True(refresh > 0 && refresh < started && started < publish, "refresh, then publish-started.json, then the native Publish");
        Assert.Contains("created ? null : Load(m.ReadBase())", dispatch);
        Assert.True(dispatch.LastIndexOf("\"before-publish.oml\"", StringComparison.Ordinal) > refresh, "before-publish.oml is written again after the refresh");
    }

    // ---- changes 1 to 3: after the merge, in a context of its own, on the module the merge went into.

    [Fact]
    public void The_merge_never_verifies_from_inside_its_own_job() {
        var hook = Source("StartupHook.cs");
        Assert.DoesNotContain("InvokeAsync(() => VerifyMerged(", hook);
        var run = Body(hook, "private static object Run(Manifest m, IAggregatorPresenter p, Mode mode, Context c)");
        Assert.DoesNotContain("VerifyMerged(", run);
        Assert.Equal(2, Regex.Matches(run, @"return new PendingMergeVerification\(").Count);
        var inContext = Body(hook, "private static async Task<object> InContext(string manifestPath, Context c, Mode mode)");
        Assert.Contains("result is not PendingMergeVerification pending", inContext);
        Assert.Contains("VerifyAfterMerge.Run(job => p.ExecuteInContext(job, executeWhenTopLevelIsIdle: true)", inContext);
    }

    [Fact]
    public void The_verification_refuses_a_tab_whose_active_module_changed_and_refreshes_the_stylesheet_caches_before_any_proof() {
        var verify = Body(Source("StartupHook.cs"), "private static object VerifyMerged(Manifest m, IAggregatorPresenter p, ESpace local, string outcome, object[] expectedMessages, Context c)");
        var lines = verify.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("//")).ToArray();
        // The first thing it does: record (verification-refused.json) and refuse a tab whose active module changed.
        Assert.StartsWith("if (!ReferenceEquals(p.ActiveESpace, local))", lines[1]);
        Assert.Contains("\"verification-refused.json\"", lines[2]);
        Assert.StartsWith("Require(ReferenceEquals(p.ActiveESpace, local), ", lines[3]);
        var refresh = verify.IndexOf("NativeStyleSheetCache.Refresh(local, expected, basis)", StringComparison.Ordinal);
        Assert.True(refresh > 0 && refresh < verify.IndexOf("NativeMergeVerification.Verify(", StringComparison.Ordinal), "the caches before the proof");
        Assert.True(refresh < verify.IndexOf("local.SaveToMemoryStream()", StringComparison.Ordinal), "after-merge.oml carries the fresh caches");
        Assert.Contains("\"stylesheet-caches.json\"", verify);
    }

    [Fact]
    // The composition itself (InContext queues it only after the merge's job returned) is the source rule above
    // (The_merge_never_verifies_from_inside_its_own_job); this proves the helper: one job of its own, not nested, its result.
    public async Task VerifyAfterMerge_queues_one_job_of_its_own_on_the_tab_and_answers_its_result() {
        // A fake tab: each queued callback runs on its own, after the one before it returned; depth counts nesting.
        var depth = 0; var order = new List<string>(); var queue = new Queue<Action>();
        Task Enqueue(Action job) { queue.Enqueue(job); return Task.CompletedTask; }
        async Task Drain() { while (queue.Count == 0) await Task.Yield(); var job = queue.Dequeue(); depth++; try { job(); } finally { depth--; } }

        var merged = TabQueue.Run(Enqueue, "merge", "Fixture", TimeSpan.FromSeconds(30), () => { order.Add("merge@" + depth); return (object)"pending"; }, _ => Task.FromResult<string?>(null));
        await Drain();
        Assert.Equal("pending", await merged);
        var verified = VerifyAfterMerge.Run(Enqueue, "Fixture", TimeSpan.FromSeconds(30), () => { order.Add("verify@" + depth); return "verified"; }, _ => Task.FromResult<string?>(null));
        Assert.Single(queue); // queued after the merge's job returned, not from inside it
        await Drain();
        Assert.Equal("verified", await verified);
        Assert.Equal(new[] { "merge@1", "verify@1" }, order);
    }

    [Fact]
    public async Task A_verification_its_tab_never_starts_says_the_merge_ran_and_never_nothing_was_executed() {
        Action? callback = null; var ran = 0;
        var error = await Assert.ThrowsAsync<MergeNotVerifiedException>(() => VerifyAfterMerge.Run(job => { callback = job; return new TaskCompletionSource().Task; }, "OrderPortal",
            TimeSpan.FromMilliseconds(100), () => { ran++; return "verified"; }, _ => Task.FromResult<string?>("{\"idle\":false}")));
        Assert.IsAssignableFrom<InvalidOperationException>(error);
        Assert.Contains("returned (native-return.json)", error.Message);
        Assert.Contains("holds the merge, not verified", error.Message);
        Assert.Contains("studio_publish {module, reconcile:true}", error.Message);
        Assert.Contains("{\"idle\":false}", error.Message);
        Assert.DoesNotContain("nothing was executed", error.Message);
        Assert.DoesNotContain("MERGE_NOT_STARTED", error.Message);
        Assert.Equal("studio_busy", Journal.Gate(error.Message));
        callback!(); // the tab becomes idle after all: an abandoned verification never runs
        Assert.Equal(0, ran);
    }
}
