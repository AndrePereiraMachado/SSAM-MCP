namespace Anvil.Core;

/// <summary>Distancia textual sobre uma lista fechada; nunca acrescenta nomes de outro catalogo.</summary>
public static class NameSuggestions
{
    public static IReadOnlyList<string> Closest(string name, IEnumerable<string> candidates, int max = 4)
        => candidates.Distinct(StringComparer.Ordinal).OrderBy(c => Distance(name.ToUpperInvariant(), c.ToUpperInvariant()))
            .ThenBy(c => c, StringComparer.Ordinal).Take(max).ToArray();
    /// <summary>primeira-certa A4: the one candidate <paramref name="name"/> can mean, or null: the only candidate there is,
    /// else the only one that contains it, is contained in it or differs by at most a quarter of its letters (one at least).</summary>
    public static string? OnlyMatch(string name, IReadOnlyCollection<string> candidates)
    {
        var pool = candidates.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (pool.Count == 1) return pool[0];
        var close = pool.Where(c => c.Contains(name, StringComparison.OrdinalIgnoreCase) || name.Contains(c, StringComparison.OrdinalIgnoreCase)
            || Distance(name.ToUpperInvariant(), c.ToUpperInvariant()) <= Math.Max(1, Math.Min(name.Length, c.Length) / 4)).ToList();
        return close.Count == 1 ? close[0] : null;
    }

    internal static int Distance(string a, string b)
    {
        var previous = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var row = new int[b.Length + 1]; row[0] = i;
            for (var j = 1; j <= b.Length; j++) row[j] = Math.Min(Math.Min(row[j - 1] + 1, previous[j] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            previous = row;
        }
        return previous[b.Length];
    }
}
