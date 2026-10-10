using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

/// <summary>Source identities are case-sensitive and namespace-aware; the target identifiers are not.</summary>
internal sealed class SymbolNames
{
    private readonly Dictionary<ISymbol, string> names = new(SymbolEqualityComparer.Default);
    public SymbolNames(IEnumerable<ISymbol> symbols, Func<ISymbol, string?>? explicitName = null)
    {
        var candidates = symbols.Distinct(SymbolEqualityComparer.Default).Select(s => (Symbol: s, Explicit: explicitName?.Invoke(s)))
            .Select(x => (x.Symbol, x.Explicit, Name: Normalize(x.Explicit ?? x.Symbol.Name))).ToArray();
        foreach (var group in candidates.GroupBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
        {
            if (group.Count() > 1 && group.Any(x => x.Explicit != null))
                throw SourceProgram.Error("AVCS102", "Conflicting explicit names: " + string.Join(", ", group.Select(x => x.Symbol.ToDisplayString())), group.First().Symbol);
            foreach (var item in group)
                names[item.Symbol] = group.Count() == 1 ? item.Name : item.Name[..Math.Min(item.Name.Length, 37)] + "_" + Digest(item.Symbol.ToDisplayString());
        }
    }
    public string this[ISymbol symbol] => names.TryGetValue(symbol, out var name) ? name : throw SourceProgram.Error("AVCS103", "Unbound source symbol " + symbol.ToDisplayString(), symbol);
    internal static string Digest(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..10].ToLowerInvariant();
    internal static string Allocate(string preferred, Func<string, bool> exists)
    {
        var name = Normalize(preferred);
        for (var suffix = 1; exists(name); suffix++) name = Normalize(preferred + "_" + suffix);
        return name;
    }
    internal static string Normalize(string text)
    {
        var result = new StringBuilder();
        foreach (var c in text.Normalize(NormalizationForm.FormD))
        {
            if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;
            result.Append(char.IsAsciiLetterOrDigit(c) || c == '_' ? c : '_');
        }
        if (result.Length == 0 || !char.IsAsciiLetter(result[0])) result.Insert(0, 'N');
        var name = result.ToString();
        return name.Length <= 48 ? name : name[..37] + "_" + Digest(text);
    }
}
