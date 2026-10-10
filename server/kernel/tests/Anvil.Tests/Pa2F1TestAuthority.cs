namespace Anvil.Tests;

/// <summary>
/// The authority folder of the test process (ANVIL_AUTHORITY_DIR, read by BridgeAccess.DirectoryPath). Test classes that
/// point it at a folder of their own run in parallel; one that restores it to an absent value lets a reservation written by
/// another test meanwhile reach the user's authority (%LOCALAPPDATA%\Anvil\authority). Restoring goes back to the value it
/// had, or to a private folder of the test process when it had none: never to absent.
/// </summary>
internal static class Pa2F1TestAuthority
{
    public static string Restore(string? before)
        => string.IsNullOrWhiteSpace(before) ? Path.Combine(Path.GetTempPath(), "anvil-tests-authority") : before;
}
