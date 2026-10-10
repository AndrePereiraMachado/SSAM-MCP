using Anvil.Bridge;
using Xunit;
namespace Anvil.Tests;
public sealed class SilentModeTests
{
    [Fact] public void PlainWebProgressIsNotADependenciesDialog()
    {
        Assert.Equal(Anvil.Core.DialogPolicy.Progress, Anvil.Core.DialogPolicy.ClassifyWindow("Progress", new[] { "Progress" }));
        Assert.Equal(Anvil.Core.DialogPolicy.ManageDependencies, Anvil.Core.DialogPolicy.ClassifyWindow("Incompatible or missing dependencies found", Array.Empty<string>()));
    }
    [Fact] public void QueueCompletionAndFinallyResetExactlyOnce()
    {
        var flag = false; var resets = 0;
        var lease = new SilentModeLease(() => flag, () => flag = true, () => { flag = false; resets++; });
        Assert.True(flag);
        Parallel.Invoke(lease.Dispose, lease.Dispose);
        Assert.False(flag); Assert.Equal(1, resets);
    }
    [Fact] public void TimeoutFinallyResetsBeforeQueuedCompletion()
    {
        var flag = false;
        var lease = new SilentModeLease(() => flag, () => flag = true, () => flag = false);
        try { throw new TimeoutException(); } catch (TimeoutException) { } finally { lease.Dispose(); }
        Assert.False(flag); lease.Dispose(); Assert.False(flag);
    }
    [Fact] public void NeverTakesOverSomeoneElsesSilentFlag()
    {
        Assert.Throws<InvalidOperationException>(() => new SilentModeLease(() => true, () => Assert.Fail("enable"), () => Assert.Fail("reset")));
    }
}
