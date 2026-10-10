namespace Anvil.Core;

/// <summary>
/// Which candidate a `Tipo:Nome` reference means when several objects match the name without case distinction and
/// implement the requested type. The choice is deterministic: exact-case name first, then the object whose own kind
/// is exactly the requested type (not a subtype that merely implements it), then, when the caller says which kind its
/// context prefers (a client flow prefers a client action to a server action of the same name, A27), that one, and among
/// equals the traversal order the caller gave. Pure so it can be tested without a Studio.
/// </summary>
public static class ReferencePrecedence
{
    public static T? Prefer<T>(IEnumerable<T> candidates, Func<T, string?> nameOf, Func<T, string?> kindOf, string type, string name,
        Func<T, bool>? preferred = null) where T : class
    {
        T? best = null; var bestScore = -1;
        foreach (var c in candidates)
        {
            var score = (string.Equals(nameOf(c), name, StringComparison.Ordinal) ? 4 : 0) + (string.Equals(kindOf(c), type, StringComparison.Ordinal) ? 2 : 0)
                + (preferred != null && preferred(c) ? 1 : 0);
            if (score > bestScore) { best = c; bestScore = score; }   // strictly greater: ties keep the first in traversal order
        }
        return best;
    }
}
