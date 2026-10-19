using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. The review of fix/html-edit-names round 2, A1: when the three-way merge of an edit written on
// an older reading gives nothing (that reading's text not kept, or a part of it the merge does not match: the native Table's
// <thead>, <tbody> and <tr> without k before fix/data-table), the rebase moved each k by its ObjectKey, and a whole document
// written on the old reading (the html form, and the document the element edits make) replaced the screen: what changed since
// was written back, and two html ops of one screen in one job undid the first. The rule: only an edit of elements moves by key
// (the edit form, its elements replacing the current ones whole); a whole document is HTML_BASE_CHANGED once, with the current
// text, the next step and, for element edits, the checked patch that writes them on the current text. Texts only, no module:
// ModelSession.RebaseEdits is the rebase the session runs.
public sealed class ScreenHtmlRebaseTests(ITestOutputHelper output)
{
    // The reading the edit was written on, and the screen now: a banner the Studio put at the top (every k after it renumbers),
    // the class of Other, and an action an earlier op of the job created.
    private static string Base(string table = "") =>
        "<screen name=\"S\" actions=\"Choose\">\n" + table + "<div k=\"w4\" id=\"Box\" class=\"a\">\n<text k=\"w5\">box</text>\n</div>\n<div k=\"w6\" id=\"Other\" class=\"o\">\n<text k=\"w7\">other</text>\n</div>\n</screen>\n";
    private static string Now(string table = "") =>
        "<screen name=\"S\" actions=\"Choose, ShowMore\">\n<div k=\"w1\" id=\"Banner\" class=\"banner\">\n<text k=\"w2\">tonight</text>\n</div>\n" + table.Replace("k=\"w1\"", "k=\"w11\"").Replace("k=\"w2\"", "k=\"w12\"").Replace("k=\"w3\"", "k=\"w13\"").Replace("k=\"w8\"", "k=\"w18\"")
        + "<div k=\"w3\" id=\"Box\" class=\"a\">\n<text k=\"w4\">box</text>\n</div>\n<div k=\"w5\" id=\"Other\" class=\"o studio\">\n<text k=\"w6\">other</text>\n</div>\n</screen>\n";

    // fix/data-table's native Table as its reading writes it: k on the table and its cells, <thead>, <tbody> and <tr> without k.
    private const string Table = "<table k=\"w1\" list=\"Rows\">\n<thead>\n<tr>\n<th k=\"w2\">\n<text k=\"w8\">Activity</text>\n</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td k=\"w3\">{{ Rows.Current }}</td>\n</tr>\n</tbody>\n</table>\n";

    private static readonly Dictionary<string, string> BaseKeys = new(StringComparer.Ordinal) {
        [""] = "KS", ["w1"] = "KT", ["w2"] = "KH", ["w3"] = "KD", ["w8"] = "KX", ["w4"] = "KBox", ["w5"] = "KBoxText", ["w6"] = "KOther", ["w7"] = "KOtherText" };
    private static readonly Dictionary<string, string> NowKeys = new(StringComparer.Ordinal) {
        [""] = "KS", ["w1"] = "KBanner", ["w2"] = "KBannerText", ["w11"] = "KT", ["w12"] = "KH", ["w13"] = "KD", ["w18"] = "KX",
        ["w3"] = "KBox", ["w4"] = "KBoxText", ["w5"] = "KOther", ["w6"] = "KOtherText" };

    private static JsonObject Old(bool table) => new(BaseKeys.Where(p => table || p.Key is not ("w1" or "w2" or "w3" or "w8")).Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)));
    private static ScreenHtmlDocument Reading(bool table) => new() {
        Root = "S", RootKey = "KS", RootKind = "MobileScreen", Html = Now(table ? Table : ""), HtmlSha256 = new string('c', 64),
        Keys = NowKeys.Where(p => table || p.Key is not ("w11" or "w12" or "w13" or "w18")).ToList() };
    private const string BaseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly JsonArray BoxWide = new(JsonNode.Parse("""{"set":"w4","attributes":{"class":"a wide"}}"""));

    private static KernelRefusalException Refused(Func<object> rebase) => Assert.Throws<KernelRefusalException>(rebase);
    private static JsonObject Single(KernelRefusalException refusal) => Assert.Single(refusal.Problems!)!.AsObject();

    [Fact]
    public void TheWholeDocumentOfAnOlderReadingWhoseTextIsNotKeptIsOneRefusalWithTheCurrentText()
    {
        var reading = Reading(false);
        var document = Base().Replace("class=\"a\"", "class=\"a wide\"");
        var refusal = Refused(() => ModelSession.RebaseEdits(reading, BaseSha, Old(false), null, [document], "/html", null, false, "capture-now", null));
        Assert.Equal(ScreenHtmlEdit.BaseChanged, refusal.Code);
        var problem = Single(refusal);
        output.WriteLine(problem.ToJsonString());
        Assert.Equal(reading.Html, problem["current"]!["text"]!.ToString());
        Assert.Equal(reading.HtmlSha256, problem["next"]!["basedOn"]!["html"]!.ToString());
        Assert.Equal("capture-now", problem["next"]!["basedOn"]!["capture"]!.ToString());
        Assert.Contains("would write that reading back", problem["message"]!.ToString());
        Assert.Contains("text is not kept", problem["message"]!.ToString());
        Assert.Contains("write the edit again on the current text", problem["fix"]!.ToString());
        Assert.Null(problem["patch"]);
    }

    // The element edits: the same refusal, with each element they address as it is now and the patch that writes them on the
    // current text (each address the element with its ObjectKey now); the patched edits change Box only, the banner, Other's
    // class and the action stay.
    [Fact]
    public void ElementEditsOfAnOlderReadingGetThePatchThatWritesThemOnTheCurrentText()
    {
        var reading = Reading(false);
        var document = HtmlElementEdits.Apply(Base(), BoxWide, BaseKeys).Document;
        var refusal = Refused(() => ModelSession.RebaseEdits(reading, BaseSha, Old(false), null, [document], "/edits", BoxWide, false, "capture-now", _ => []));
        var problem = Single(refusal);
        output.WriteLine(problem.ToJsonString());
        Assert.Equal("w3", problem["current"]!["elements"]![0]!["k"]!.ToString());
        var patch = problem["patch"]!.AsArray();
        Assert.Equal(["/basedOn", "/edits"], patch.Select(p => p!["path"]!.ToString()));
        Assert.Equal(reading.HtmlSha256, patch[0]!["value"]!["html"]!.ToString());
        var corrected = patch[1]!["value"]!.AsArray();
        Assert.Equal("w3", corrected[0]!["set"]!.ToString());
        var applied = HtmlElementEdits.Apply(reading.Html, corrected, NowKeys);
        Assert.Empty(applied.Problems);
        Assert.Contains("<div k=\"w3\" id=\"Box\" class=\"a wide\">", applied.Document);
        Assert.Contains("class=\"o studio\"", applied.Document);
        Assert.Contains("id=\"Banner\"", applied.Document);
        Assert.Contains("actions=\"Choose, ShowMore\"", applied.Document);
        // A replace carries the k of the element it writes: they move too.
        var replace = new JsonArray(new JsonObject { ["replace"] = "w4", ["with"] = "<div k=\"w4\" id=\"Box\" class=\"a\">\n<text k=\"w5\">box!</text>\n</div>" });
        var again = Single(Refused(() => ModelSession.RebaseEdits(reading, BaseSha, Old(false), null, [HtmlElementEdits.Apply(Base(), replace, BaseKeys).Document], "/edits", replace, false, "capture-now", _ => [])));
        var moved = again["patch"]![1]!["value"]![0]!.AsObject();
        Assert.Equal("w3", moved["replace"]!.ToString());
        Assert.Contains("<text k=\"w4\">box!</text>", moved["with"]!.ToString());
        // A find is the text of the reading: no patch, the words and the elements as they are now.
        var find = new JsonArray(JsonNode.Parse("""{"find":">box<","with":">box!<"}"""));
        Assert.Null(Single(Refused(() => ModelSession.RebaseEdits(reading, BaseSha, Old(false), null, [HtmlElementEdits.Apply(Base(), find, BaseKeys).Document], "/edits", find, false, "capture-now", _ => [])))["patch"]);
    }

    // Written on the current text, the edits have a problem of their own: it comes in the same refusal (never after it), with the
    // edits as they are on the current text, and no patch.
    [Fact]
    public void TheProblemsTheEditsHaveOnTheCurrentTextComeInTheSameRefusal()
    {
        var reading = Reading(false);
        var document = HtmlElementEdits.Apply(Base(), BoxWide, BaseKeys).Document;
        var own = new JsonObject { ["code"] = ScreenHtmlEdit.NameTaken, ["message"] = "id=\"Banner\" is already the name of k=\"w1\" in S", ["fix"] = "id=\"Banner2\"" };
        var refusal = Refused(() => ModelSession.RebaseEdits(reading, BaseSha, Old(false), null, [document], "/edits", BoxWide, false, "capture-now", _ => [own]));
        Assert.Equal(ScreenHtmlEdit.BaseChanged, refusal.Code);
        Assert.Equal(2, refusal.Problems!.Count);
        Assert.Null(refusal.Problems[0]!["patch"]);
        Assert.Equal("w3", refusal.Problems[0]!["current"]!["edits"]![0]!["set"]!.ToString());
        Assert.Equal(ScreenHtmlEdit.NameTaken, refusal.Problems[1]!["code"]!.ToString());
    }

    // An earlier op of this job changed the screen: the next step is the html op that did.
    [Fact]
    public void AnEarlierOpOfTheJobIsTheOneToWriteTheChangeIn()
    {
        var document = HtmlElementEdits.Apply(Base(), BoxWide, BaseKeys).Document;
        var problem = Single(Refused(() => ModelSession.RebaseEdits(Reading(false), BaseSha, Old(false), null, [document], "/edits", BoxWide, true, "capture-now", null)));
        Assert.Contains("an earlier op of this job changed it", problem["message"]!.ToString());
        Assert.Contains("when an earlier html op of this job changed S, make this change in that op", problem["fix"]!.ToString());
    }

    // A part of the reading the merge does not match (an element without k): the reason is said, and the document is refused.
    [Fact]
    public void APartTheMergeDoesNotMatchIsNamedAndTheDocumentIsRefused()
    {
        var kept = Base().Replace("<div k=\"w6\"", "<span>unmatched</span>\n<div k=\"w6\"");
        var document = HtmlElementEdits.Apply(kept, BoxWide, BaseKeys).Document;
        var problem = Single(Refused(() => ModelSession.RebaseEdits(Reading(false), BaseSha, Old(false), kept, [document], "/edits", BoxWide, false, "capture-now", _ => [])));
        output.WriteLine(problem["message"]!.ToString());
        Assert.Contains("the three-way merge could not lay it over that reading: <span> at line 5 has no k", problem["message"]!.ToString());
        Assert.NotNull(problem["patch"]);
    }

    // The edit form (its elements whole) still moves by key: each sent element replaces the one with its ObjectKey, and the note
    // says that, never more.
    [Fact]
    public void TheEditFormMovesByKeyAndSaysWhatItReplaced()
    {
        var reading = Reading(false);
        var (edits, notes) = ModelSession.RebaseEdits(reading, BaseSha, Old(false), null, ["<div k=\"w4\" id=\"Box\" class=\"a wide\">\n<text k=\"w5\">box</text>\n</div>"], "/edit", null, false, "capture-now", null);
        Assert.Contains("<div k=\"w3\" id=\"Box\" class=\"a wide\">", Assert.Single(edits));
        Assert.Contains("<text k=\"w4\">box</text>", edits[0]);
        var note = Assert.Single(notes);
        Assert.Equal("by-key", note["merge"]!.ToString());
        Assert.Contains("replaced the one with its ObjectKey, whole", note["note"]!.ToString());
        Assert.Contains("text is not kept", note["because"]!.ToString());
    }

    // With the reading's text kept, the element edits merge three ways: Box is the edit's, the banner, Other's class and the
    // action the screen's.
    [Fact]
    public void WithTheReadingKeptTheEditsMergeThreeWays()
    {
        var (edits, notes) = ModelSession.RebaseEdits(Reading(false), BaseSha, Old(false), Base(), [HtmlElementEdits.Apply(Base(), BoxWide, BaseKeys).Document], "/edits", BoxWide, false, "capture-now", null);
        var merged = Assert.Single(edits);
        Assert.Equal("three-way", Assert.Single(notes)["merge"]!.ToString());
        Assert.Contains("id=\"Box\" class=\"a wide\"", merged);
        Assert.Contains("class=\"o studio\"", merged);
        Assert.Contains("id=\"Banner\"", merged);
        Assert.Contains("ShowMore", merged.Split('\n')[0]);
    }

    // Two html ops of one screen in one job, the screen with a native Table: the second, written on the capture, is merged three
    // ways with the reading before the first, or refused; it never writes the old reading back over the first.
    [Fact]
    public void TheSecondHtmlOpOfAScreenWithANativeTableNeverUndoesTheFirst()
    {
        var reading = Reading(true);
        var document = HtmlElementEdits.Apply(Base(Table), BoxWide, BaseKeys).Document;
        try {
            var (edits, notes) = ModelSession.RebaseEdits(reading, BaseSha, Old(true), Base(Table), [document], "/edits", BoxWide, true, "capture-now", _ => []);
            var merged = Assert.Single(edits);
            output.WriteLine("merged three ways: " + merged);
            Assert.Equal("three-way", Assert.Single(notes)["merge"]!.ToString());
            Assert.Contains("class=\"o studio\"", merged);
            Assert.Contains("id=\"Box\" class=\"a wide\"", merged);
            Assert.Contains("ShowMore", merged.Split('\n')[0]);
        } catch (KernelRefusalException refusal) {
            output.WriteLine("refused: " + refusal.Problems!.ToJsonString());
            Assert.Equal(ScreenHtmlEdit.BaseChanged, refusal.Code);
            Assert.Contains("<thead>", refusal.Problems![0]!["message"]!.ToString());
            Assert.NotNull(refusal.Problems[0]!["patch"]);
        }
    }
}
