namespace Anvil.Core;

/// <summary>
/// A03 (owner decision, 2026-10-06): only Verify ERRORS block a delivery. The warnings that still block are the security
/// ones: every id of <see cref="Ids"/> when it is new, and the anonymous-access family (<see cref="AnonymousIds"/> and the O11
/// CustomObjectWarning with the anonymous sentence) on a screen the job creates or changes (C37, MessageExpectations).
/// Every other new warning is non-blocking: it comes back in the receipt and the answer, never in a refusal.
/// Pure, BCL only: compiled into Anvil.Core, Anvil.Core.Odc and linked into the ODC builder. The ids are those of the
/// catalogs kernel/catalog/verify-messages-11.55.91.json and kernel/catalog/odc/verify-messages-1.7.27.10846.json.
/// </summary>
public static class SecurityWarnings
{
    /// <summary>Block whenever new (Type Warning).</summary>
    public static readonly IReadOnlySet<string> Ids = new HashSet<string>(StringComparer.Ordinal)
    {
        "SQLInjection", "SQLInjectionInvalidEncodeSQL", "SQLInjectionInvalidReplace", "HTMLInjection",
        "JavascriptInjection", "ExpressionShouldBeEscaped", "LoginSecurity",
    };

    /// <summary>The anonymous-access family: blocks only on a screen of the job's footprint (C37); tolerated outside it.</summary>
    public static readonly IReadOnlySet<string> AnonymousIds = new HashSet<string>(StringComparer.Ordinal)
    {
        "ServerActionInScreenAccessibleByEveryone", "ServerActionInAnonymousScreen",
        "AnonymousAccess_NoPermissions", "AnonymousAccess_NoPermissionsNoRoles",
    };

    // The O11 Studio files the same warning under the generic bucket CustomObjectWarning, recognised by its two sentences
    // (MessageExpectations.cs); the bucket carries unrelated diagnostics too, so its id alone is never enough.
    private const string AnonymousAccessSentence = "You're exposing a Server Action for public access and without authentication.";
    private const string Ss11ScreenSentence = "Consider removing the Anonymous Role from this Screen.";

    public static bool IsAnonymous(string id, string? detail)
    {
        if (AnonymousIds.Contains(id)) return true;
        var text = detail ?? "";
        return id == "CustomObjectWarning" && text.Contains(AnonymousAccessSentence, StringComparison.Ordinal)
            && text.Contains(Ss11ScreenSentence, StringComparison.Ordinal);
    }

    public static bool IsSecurity(string id, string? detail) => Ids.Contains(id) || IsAnonymous(id, detail);
}
