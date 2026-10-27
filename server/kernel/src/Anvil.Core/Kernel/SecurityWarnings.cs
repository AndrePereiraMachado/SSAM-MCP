namespace Anvil.Core;

/// <summary>
/// A03 (owner decision, 2026-10-06): only Verify ERRORS block a delivery. The warnings that still block are the security
/// ones: every id of <see cref="Ids"/> when it is new, a generic id (<see cref="GenericIds"/>) whose title is a security
/// family's, and the anonymous-access family (<see cref="AnonymousIds"/> and the O11 CustomObjectWarning with the anonymous
/// sentences) on a screen the job creates or changes (C37, MessageExpectations). Every other new warning is non-blocking.
/// T12: every security id of both platforms is classified here and checked against the platforms (SecurityFidelityTests):
/// the id manifests (kernel/catalog/verify-messages-*.json, kernel/catalog/odc/verify-messages-*.json), the bound Studio's
/// own security category and title families, and real messages the Studio emits. The O11 Studio files some security
/// warnings under the generic CustomObjectWarning, whose text starts with the title ("SQL Injection | When adding an
/// expand inline parameter after a Group By or Order By..."): those are classified by that title, as the anonymous
/// sentences are. A blocking one answers its fix and the acceptance with the user's own words (<see cref="Fix"/>).
/// Pure, BCL only: compiled into Anvil.Core, Anvil.Core.Odc and linked into the ODC builder and bridge.
/// </summary>
public static class SecurityWarnings
{
    public const string Blocking = "blocking";
    public const string Anonymous = "anonymous";
    public const string NotSecurity = "not-security";
    public const string Generic = "generic";

    /// <summary>Block whenever new (Type Warning). OpenRedirect/OpenRedirectNR, SQL_InputParameterPropagation,
    /// LdapFilterInjection (O11) and EntityActionClientSide (the platform's security category) came with T12.</summary>
    public static readonly IReadOnlySet<string> Ids = new HashSet<string>(StringComparer.Ordinal)
    {
        "SQLInjection", "SQLInjectionInvalidEncodeSQL", "SQLInjectionInvalidReplace", "SQL_InputParameterPropagation",
        "HTMLInjection", "JavascriptInjection", "ExpressionShouldBeEscaped", "OpenRedirect", "OpenRedirectNR",
        "LdapFilterInjection", "LoginSecurity", "EntityActionClientSide",
    };

    /// <summary>The anonymous-access family: blocks only on a screen of the job's footprint (C37); tolerated outside it.</summary>
    public static readonly IReadOnlySet<string> AnonymousIds = new HashSet<string>(StringComparer.Ordinal)
    {
        "ServerActionInScreenAccessibleByEveryone", "ServerActionInAnonymousScreen",
        "AnonymousAccess_NoPermissions", "AnonymousAccess_NoPermissionsNoRoles",
    };

    /// <summary>The platforms' generic buckets: one id for many diagnostics, a security one among them, told by its title.</summary>
    public static readonly IReadOnlySet<string> GenericIds = new HashSet<string>(StringComparer.Ordinal) { "CustomObjectWarning", "CustomObjectError" };

    /// <summary>Ids whose name speaks of security but that are no security warning, reviewed one by one: Verify errors (they
    /// block as errors: a role check, a client-side call, a structure, a handler, a cookie setting) and the mobile cookie
    /// setting warning.</summary>
    public static readonly IReadOnlySet<string> NotSecurityIds = new HashSet<string>(StringComparer.Ordinal)
    {
        "CannotUseCheckRoleBuiltInFunction", "ExecuteActionClientSide_CallingActionNotAllowedInClient",
        "ExecuteActionClientSide_CallingEntityActionNotAllowedInClient", "InvalidAnonymousStructure_NoAttr",
        "InvalidFlow_BadErrHandlerPermission", "InvalidPropertyValue_UseCookies", "InvalidRunServerAction_ClientRoleAction",
        "ReferenceRole_IsPersistent", "RequiredCookiesProperty",
    };

    /// <summary>Every id with a class.</summary>
    public static IEnumerable<string> Classified => Ids.Concat(AnonymousIds).Concat(GenericIds).Concat(NotSecurityIds);

    /// <summary>blocking (A03, whenever new), anonymous (C37), generic (by its title), not-security (reviewed), or null.</summary>
    public static string? Classify(string id) => Ids.Contains(id) ? Blocking : AnonymousIds.Contains(id) ? Anonymous
        : GenericIds.Contains(id) ? Generic : NotSecurityIds.Contains(id) ? NotSecurity : null;

    /// <summary>Whether a new warning of this id can block a delivery by its id alone.</summary>
    public static bool Blocks(string id) => Ids.Contains(id) || AnonymousIds.Contains(id);

    /// <summary>Whether a declaration of this id may cover a security warning: a blocking id or a generic bucket.</summary>
    public static bool MayBeSecurity(string id) => Blocks(id) || GenericIds.Contains(id);

    // ---- the generic bucket, by its title (the native titles of the security families; the text of a generic message
    // is "<title> | <detail>", or "<title>|<detail>" as the bridge joins them).
    private static readonly Dictionary<string, string> TitleFamilies = new(StringComparer.Ordinal)
    {
        ["SQL Injection"] = "sql", ["HTML Injection"] = "HTMLInjection", ["JavaScript Injection"] = "JavascriptInjection",
        ["Expression Should Be Escaped"] = "ExpressionShouldBeEscaped", ["Open Redirect"] = "redirect",
        ["LDAP Filter Injection"] = "LdapFilterInjection", ["Unexpected Login"] = "LoginSecurity", ["Security Warning"] = "category",
    };

    private static string? TitleOf(string? detail)
    {
        var text = (detail ?? "").Trim();
        var bar = text.IndexOf('|');
        return bar > 0 ? text[..bar].Trim() : null;
    }

    /// <summary>The security id a message stands for: its own id when it is classified blocking; for a generic bucket, the id
    /// its title and text name (an ORDER BY expand inline is SQL_InputParameterPropagation); null when it is no blocking
    /// security warning (the anonymous family is judged by <see cref="IsAnonymous"/>).</summary>
    public static string? SecurityIdOf(string id, string? detail)
    {
        if (Ids.Contains(id)) return id;
        if (!GenericIds.Contains(id) || IsAnonymous(id, detail) || TitleOf(detail) is not { } title || !TitleFamilies.TryGetValue(title, out var family)) return null;
        var text = detail ?? "";
        bool Says(string words) => text.Contains(words, StringComparison.OrdinalIgnoreCase);
        return family switch
        {
            "sql" => Says("Group By") || Says("Order By") ? "SQL_InputParameterPropagation" : Says("EncodeSql should") ? "SQLInjectionInvalidEncodeSQL"
                : Says("Replace") ? "SQLInjectionInvalidReplace" : "SQLInjection",
            "redirect" => Says("screen input") ? "OpenRedirectNR" : "OpenRedirect",
            "category" => "EntityActionClientSide",
            _ => family,
        };
    }

    /// <summary>A new warning that blocks whenever new: a blocking id, or a generic bucket with a security title.</summary>
    public static bool BlocksWhenNew(string id, string? detail) => SecurityIdOf(id, detail) != null;

    private const string Acceptance = "; or, when the user accepts the warning as it is, the patch declares it in expectedMessages: its why must be the user's own words (a security warning blocks until it is fixed or the user accepts it)";

    /// <summary>The fix of a security warning and its acceptance, one text; null for any other message. The advice is the
    /// platform's own where it gives one, per lane and app kind where they differ.</summary>
    public static string? Fix(string id, string? detail)
    {
        var security = IsAnonymous(id, detail) ? "anonymous" : SecurityIdOf(id, detail);
        var fix = security switch
        {
            "SQLInjection" => "turn Expand Inline off and pass the value as a query parameter; when it must be inlined, encode it (EncodeSql for a value inside a quoted string literal, the BuildSafe_InClause lists for an IN list) or check it against a fixed list of allowed values",
            "SQLInjectionInvalidEncodeSQL" => "EncodeSql escapes only a value written inside a quoted string literal ('...'): quote it there; an IN list takes the BuildSafe_InClause lists, and a column, table or keyword must come from a fixed list of allowed names",
            "SQLInjectionInvalidReplace" => "do not escape with Replace: encode a string literal with EncodeSql, build an IN list with the BuildSafe_InClause lists, or turn Expand Inline off",
            "SQL_InputParameterPropagation" => "check the value against a fixed list of the allowed column names (an allowlist) before it is inlined after GROUP BY or ORDER BY, and inline only the name from that list; EncodeSql and a plain parameter do not work in that position",
            "HTMLInjection" => "encode the value with EncodeHtml() before it is written into the HTML",
            "JavascriptInjection" => "encode the value with EncodeJavaScript() before it is written into the script",
            "ExpressionShouldBeEscaped" => "set Escape Content to Yes on the Expression, or encode the value with EncodeHtml() when it must stay unescaped",
            "OpenRedirect" => "wrap each input of the URL in ReplaceURLDomain() (HTTPRequestHandler, O11 Traditional Web), or navigate to a screen of the module instead",
            "OpenRedirectNR" => "do not redirect to a URL taken from a screen input as it is: navigate to a screen of the module, or redirect only after the URL is checked against a fixed list of allowed hosts or paths",
            "LdapFilterInjection" => "encode the value with LdapFilterEncode() before it builds the LDAP filter",
            "LoginSecurity" => "log in through the login actions of the module the message names",
            "EntityActionClientSide" => "move the entity action into a server action that validates the data, and call that server action",
            "anonymous" => "the screen is open to everyone and runs a server action: restrict the screen (O11: Roles without Anonymous, such as [Registered]; ODC: AnonymousAccess false), or, when the user wants it public, declare that on the screen (O11: Roles with Anonymous; ODC: AnonymousAccess true)",
            _ => null,
        };
        return fix == null ? null : fix + Acceptance;
    }

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

    /// <summary>Whether a message is a security warning (blocking or of the anonymous family), generic buckets by their title.</summary>
    public static bool IsSecurity(string id, string? detail) => BlocksWhenNew(id, detail) || IsAnonymous(id, detail);
}
