using Anvil.Bridge;
using Xunit;

namespace Anvil.Tests;

public class PublishConfirmationTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("Running")]
    [InlineData("CompletedWithFailure")]
    public void UploadOrMissingProcessNeverConfirmsDeployment(string? state)
        => Assert.False(PublishConfirmation.Succeeded(state));

    [Theory]
    [InlineData("CompletedWithSuccessNotOpenedInBrowser")]
    [InlineData("CompletedWithSuccessOpenedInBrowserOrClosed")]
    public void OnlyNativeSuccessfulCompletionConfirmsDeployment(string state)
        => Assert.True(PublishConfirmation.Succeeded(state));
}
