namespace Anvil.Core;

/// <summary>
/// C08 of the atritos 3 package: the screens whose anonymous access is the job's intent, so the anonymous-access warning
/// family on them (ServerActionInScreenAccessibleByEveryone, one per server action the screen calls) is tolerated with
/// reason anonymous-declared-by-job instead of asking for one expectation per node (lab 25: three `set AnonymousAccess true`
/// refused with nine Unexpected). Two sources: what the job wrote (the verbs record every screen a `set AnonymousAccess
/// true`, a `set Roles` naming Anonymous or a `link` through Roles to Anonymous made open, raw or expanded from html,
/// screen and spec ops), and the screens of the footprint that were already anonymous in the base (lab 31: data actions
/// recreated on screens the base already opened). A screen the job creates without declaring it stays under C37. Pure.
/// </summary>
public static class AnonymousIntent
{
    /// <summary>The keys of the intent: <paramref name="declared"/> (screens the job made anonymous) and every screen of
    /// <paramref name="screens"/> (the footprint's) that the job did not create (<paramref name="created"/>) and that is
    /// anonymous now (<paramref name="isAnonymous"/>, read on the effective model: the job did not write it, so it is the
    /// base's state).</summary>
    public static IReadOnlySet<string> Compute(IEnumerable<string> declared, IReadOnlySet<string> screens, IReadOnlySet<string> created, Func<string, bool> isAnonymous)
    {
        var intent = new HashSet<string>(declared, StringComparer.Ordinal);
        foreach (var screen in screens)
            if (!intent.Contains(screen) && !created.Contains(screen) && isAnonymous(screen)) intent.Add(screen);
        return intent;
    }

    /// <summary>Whether a value written to AnonymousAccess opens the screen (true, "true", "True", "Yes").</summary>
    public static bool Opens(object? value) => value switch
    {
        bool b => b,
        string s => s.Trim().Equals("true", StringComparison.OrdinalIgnoreCase) || s.Trim().Equals("yes", StringComparison.OrdinalIgnoreCase),
        _ => false,
    };

    /// <summary>The role that lets everyone in (O11 system role; ODC has none and uses AnonymousAccess).</summary>
    public static bool IsAnonymousRole(string? name) => string.Equals(name, "Anonymous", StringComparison.OrdinalIgnoreCase);
}
