namespace Anvil.Core;

/// <summary>Distancia textual sobre uma lista fechada; nunca acrescenta nomes de outro catalogo.</summary>
public static class NameSuggestions
{
    public static IReadOnlyList<string> Closest(string name, IEnumerable<string> candidates, int max = 4)
        => candidates.Distinct(StringComparer.Ordinal).OrderBy(c => Distance(name.ToUpperInvariant(), c.ToUpperInvariant()))
            .ThenBy(c => c, StringComparer.Ordinal).Take(max).ToArray();
    private static int Distance(string a, string b)
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
