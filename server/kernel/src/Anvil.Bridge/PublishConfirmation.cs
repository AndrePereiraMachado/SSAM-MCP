namespace Anvil.Bridge;

internal static class PublishConfirmation
{
    // Upload timestamps are not deployment evidence: compilation can fail after an upload succeeds.
    internal static bool Succeeded(string? state) => state is
        "CompletedWithSuccessNotOpenedInBrowser" or "CompletedWithSuccessOpenedInBrowserOrClosed";
    internal static bool Failed(string? state) => state == "CompletedWithFailure";
}
