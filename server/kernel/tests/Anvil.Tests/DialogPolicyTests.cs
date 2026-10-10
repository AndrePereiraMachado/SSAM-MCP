using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>Classificacao pura dos bloqueios (plano, itens 12/13a): a bridge deteta e ensina o proximo passo; nunca clica.</summary>
public class DialogPolicyTests
{
    [Fact]
    public void ReferencesPresenterIsManageDependencies()
    {
        Assert.Equal(DialogPolicy.ManageDependencies, DialogPolicy.ClassifyPresenter(new[] { "ICommandTarget", "IAddRemoveReferencesPresenter" }, "prs_x"));
        Assert.Equal(DialogPolicy.MergeEditor, DialogPolicy.ClassifyPresenter(new[] { "IMergeEditorPresenter" }, "prs_y"));
        Assert.StartsWith("Modal:", DialogPolicy.ClassifyPresenter(new[] { "IPresenter" }, "SomethingElse"));
    }

    [Fact]
    public void RecoveryWindowIsRecognizedByItsButtons()
    {
        Assert.Equal(DialogPolicy.Recovery, DialogPolicy.ClassifyWindow("Service Studio", new[] { "[Button] Open", "[Button] Discard" }));
        Assert.Equal(DialogPolicy.ManageDependencies, DialogPolicy.ClassifyWindow("Manage Dependencies", new[] { "[Button] Apply" }));
        Assert.Equal(DialogPolicy.ManageDependencies, DialogPolicy.ClassifyWindow("Incompatible or missing dependencies found", new[] { "[Button] Viewbox", "Incompatible or missing dependencies found" }));
        Assert.Equal(DialogPolicy.ManageDependencies, DialogPolicy.ClassifyWindow("Warning", new[] { "Modified or missing references found", "[Button] OK" }));
        Assert.Equal(DialogPolicy.MessageBox, DialogPolicy.ClassifyWindow("Warning", new[] { "Publish failed", "[Button] OK" }));
    }

    [Fact]
    public void ProgressDialogsAndUnknownPresentersDoNotBlock()
    {
        Assert.Equal(DialogPolicy.Progress, DialogPolicy.ClassifyWindow("Service Studio", new[] { "Opening Davitest_CS...", "42%" }));
        Assert.Equal(DialogPolicy.Progress, DialogPolicy.ClassifyWindow(null, new[] { "Loading environment" }));
        Assert.False(DialogPolicy.IsBlockingPresenterKind(DialogPolicy.ClassifyPresenter(new[] { "IPresenter" }, "prs_login")));
        Assert.True(DialogPolicy.IsBlockingPresenterKind(DialogPolicy.ManageDependencies));
    }

    [Fact]
    public void EveryKindHasAHintThatSaysWhatToDo()
    {
        foreach (var k in new[] { DialogPolicy.Recovery, DialogPolicy.ManageDependencies, DialogPolicy.MergeEditor, DialogPolicy.MessageBox, "Modal:X" })
            Assert.Contains("retry", DialogPolicy.Hint(k));
    }
}
