// U1 (bridge v106/v107): when a publication answers ok. Studio-free, compiled into the bridge and into Bridge.Tests.
//
// The family it closes (proto v105, proven on FloodQuotes revisions 512 and 513, 2026-10-28): the Studio said
// CompletedWithSuccess, the bridge downloaded the revision and compared it with the open module through the native MatchTree,
// and answered ok:true because nothing differed outside references (matchesOpenModule: outside.Length == 0). The server had
// published the old CSS (82,806 characters, not the 82,815 the delivery sent): a stale compilation cache the MatchTree does
// not see. Now a publication is ok only when it is verified: the revision was downloaded, nothing differs from the open module
// outside references, and the source of every stylesheet (effective, author, generated) equals the one submitted in
// before-publish.oml, with no sheet missing or added. Anything else, a failed download or comparison included, is
// verified:false in the receipt and a refusal of the PublishFailedException family, never ok:true.
internal static class PublishVerification {
    internal sealed record Verdict(bool Verified, bool StrictlyEqual, string Note, string? Reason);

    // outside: differences of the published revision from the open module outside references (null: not compared);
    // styles: keys of the stylesheets whose source differs from before-publish.oml, is missing or is new (null: not compared);
    // matchTreeEqual: the native MatchTree found no difference at all; failure: why the download or comparison failed;
    // sentEqual: the downloaded revision has the sha256 of before-publish.oml. Then it is the module sent, byte for byte, and it is
    // verified whatever the open module became meanwhile (the line's F1/H3 rule, b4577721): an edit made in the Studio during the
    // publication never turns a publication of the bytes sent into a refusal.
    public static Verdict Of(string[]? outside, string[]? styles, bool matchTreeEqual, string? failure, bool sentEqual = false) {
        if (sentEqual)
            return new Verdict(true, matchTreeEqual && failure == null && outside is { Length: 0 } && styles is { Length: 0 },
                "Published revision is the module sent, byte for byte (before-publish.oml)." + (outside is { Length: > 0 } ? " The open module changed since; open-vs-published.txt names how." : ""), null);
        if (failure != null || outside == null || styles == null)
            return new Verdict(false, false, "Publication completed but the published revision could not be downloaded and compared with the submitted module; it is not verified.",
                "the published revision could not be downloaded and compared (" + (failure ?? "no comparison") + ")");
        if (outside.Length == 0 && styles.Length == 0)
            return new Verdict(true, matchTreeEqual, "Published revision equals the open module and the submitted stylesheet sources.", null);
        var parts = new List<string>();
        if (outside.Length > 0) parts.Add(outside.Length + " difference(s) from the open module outside references (" + string.Join("; ", outside.Take(3)) + ")");
        if (styles.Length > 0) parts.Add(styles.Length + " stylesheet(s) whose source differs from before-publish.oml, is missing or is new (" + string.Join(", ", styles.Take(5)) + ")");
        return new Verdict(false, false, "Published revision differs from the submitted module; inspect open-vs-published.txt and stylesheetSourceDifferences. Do not publish again blindly.",
            string.Join(" and ", parts));
    }

    // The refusal of a completed publication that is not verified. It starts like every refusal after the dispatch ("Publication of
    // <module> ended in state <state>"), which the facade answers PUBLISH_FAILED with the log of the publication
    // (studio-publish-log.mjs AFTER_DISPATCH).
    public static string Refusal(string module, string state, object? revision, Verdict verdict) =>
        "Publication of " + module + " ended in state " + state + ", but the published revision" + (revision == null ? "" : " " + revision)
        + " is not verified: " + verdict.Reason + ". The server may serve what the delivery did not send. Nothing was repeated;"
        + " publish-receipt.json (published.differencesOutsideReferences, published.stylesheetSourceDifferences) and open-vs-published.txt name each difference.";
}
