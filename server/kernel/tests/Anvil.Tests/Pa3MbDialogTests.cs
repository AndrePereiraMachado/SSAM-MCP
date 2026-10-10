using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Package 3, lane mb, C10: one view of the Studio's blocking dialogs for wait, status and publish (DialogScope, linked from
/// the O11 bridge), and the rule that ends a publication stuck behind one (LF-04: a Manage Dependencies presenter of another
/// tab kept the publish waiting until its 600 s timeout).
/// </summary>
public class Pa3MbDialogTests
{
    private static JsonObject Presenter(string kind) => new() { ["kind"] = kind, ["type"] = kind + "Presenter", ["source"] = "presenter" };
    private static JsonObject Window(string kind, string title) => new() { ["kind"] = kind, ["type"] = "DialogWindow", ["title"] = title, ["source"] = "window", ["contentKind"] = "web" };

    [Fact]
    public void TheUnionTagsEachPresenterWithItsModuleAndListsEachWindowOnce()
    {
        var recovery = Window(DialogPolicy.Recovery, "Recover");
        var union = DialogScope.Union(new (string?, JsonArray)[]
        {
            ("Active", new JsonArray(recovery.DeepClone())),
            ("Consumer", new JsonArray(Presenter(DialogPolicy.ManageDependencies), recovery.DeepClone())),
        });
        Assert.Equal(2, union.Count);
        Assert.Equal("Consumer", union.OfType<JsonObject>().Single(e => e["source"]!.ToString() == "presenter")["module"]!.ToString());
        // The active tab has no dialog of its own; the references dialog of the other tab is in otherDialogs.
        var others = DialogScope.Others(union, "Active");
        Assert.Contains(others.OfType<JsonObject>(), e => e["kind"]!.ToString() == DialogPolicy.ManageDependencies);
        Assert.DoesNotContain(DialogScope.Others(union, "Consumer").OfType<JsonObject>(), e => e["source"]!.ToString() == "presenter");
        Assert.Single(DialogScope.Presenters(new JsonArray(Presenter(DialogPolicy.MergeEditor), recovery.DeepClone())));
    }

    [Fact]
    public void ABlockingDialogInThreeReadsInARowEndsThePublicationWait()
    {
        var streak = new DialogScope.Streak();
        var references = new JsonArray(Presenter(DialogPolicy.ManageDependencies));
        Assert.Null(streak.Observe(references.DeepClone().AsArray()));
        Assert.Null(streak.Observe(null));                                                                  // not read this time
        Assert.Null(streak.Observe(references.DeepClone().AsArray()));
        var stuck = streak.Observe(references.DeepClone().AsArray());
        Assert.NotNull(stuck);
        Assert.Equal(DialogPolicy.ManageDependencies, stuck![0]!["kind"]!.ToString());
        // A message box is not blocking; a read without a blocking dialog starts the count again.
        var other = new DialogScope.Streak();
        foreach (var read in new[] { references, new JsonArray(Window(DialogPolicy.MessageBox, "Info")), references, references })
            Assert.Null(other.Observe(read.DeepClone().AsArray()));
        // The recovery dialog, a web dialog and the merge editor block like the references dialog.
        Assert.All(new[] { DialogPolicy.Recovery, DialogPolicy.WebDialog, DialogPolicy.MergeEditor }, kind =>
        {
            var s = new DialogScope.Streak(); JsonArray? r = null;
            for (var i = 0; i < 3; i++) r = s.Observe(new JsonArray(Presenter(kind)));
            Assert.NotNull(r);
        });
    }

    [Fact]
    public void ABlockedPublicationSaysWhetherAnythingReachedTheServer()
    {
        var blockedBy = new JsonArray(new JsonObject { ["kind"] = DialogPolicy.ManageDependencies, ["module"] = "Consumer", ["source"] = "presenter" });
        var before = DialogScope.PublishBlocked("Producer", blockedBy.DeepClone().AsArray(), false, new JsonArray(), 3200);
        Assert.False(before["published"]!.GetValue<bool>());
        Assert.Equal(DialogScope.Code, before["code"]!.ToString());
        Assert.Equal("not-started", before["outcome"]!.ToString());
        Assert.Contains("ManageDependencies of Consumer", before["error"]!.ToString());
        Assert.Equal("uncertain", DialogScope.PublishBlocked("Producer", blockedBy.DeepClone().AsArray(), true, new JsonArray(), 3200)["outcome"]!.ToString());
    }
}
