namespace Anvil.Core.Preflight;

/// <summary>
/// The roots an expression reads by name without any declaration of the page or the action, in one table for every rule that
/// asks (ExpressionRules, DocumentNameRules, ScopeRules, ScreenHtmlNative): the roots of the module's own values, the words of
/// the language and the asset roots. Case does not matter (OutSystems names have no case).
/// </summary>
public static class ExpressionRoots
{
    /// <summary>Roots of values every lane reads (a record of a static entity, a client or session variable, a role...).</summary>
    private static readonly string[] SharedValues = ["Entities", "Session", "Roles", "Resources", "Request", "Client", "BuiltinClientVariables"];

    /// <summary>Roots of values, any lane: the shared ones, Site (O11 site properties) and Settings (ODC settings).</summary>
    public static readonly IReadOnlySet<string> Values = new HashSet<string>([.. SharedValues, "Site", "Settings"], StringComparer.OrdinalIgnoreCase);

    /// <summary>Words of the language that read as a root of a path (no value of the module).</summary>
    public static readonly IReadOnlySet<string> Language = new HashSet<string>(["True", "False", "and", "or", "not", "like", "NullObject"], StringComparer.OrdinalIgnoreCase);

    /// <summary>Roots of assets of the module (an image, a theme): no value of an expression.</summary>
    public static readonly IReadOnlySet<string> Assets = new HashSet<string>(["Images", "Themes"], StringComparer.OrdinalIgnoreCase);

    /// <summary>Every root of the three tables.</summary>
    public static readonly IReadOnlySet<string> All = new HashSet<string>([.. Values, .. Language, .. Assets], StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether <paramref name="name"/> (any case) is a root of a value an expression of <paramref name="lane"/> reads:
    /// the shared roots, Site only in O11, Settings only in ODC.</summary>
    public static bool IsValueRoot(string name, string lane)
    {
        if (string.Equals(name, "Site", StringComparison.OrdinalIgnoreCase)) return !string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase);
        if (string.Equals(name, "Settings", StringComparison.OrdinalIgnoreCase)) return string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase);
        return Values.Contains(name);
    }
}
