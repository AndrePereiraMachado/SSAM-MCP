using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// Cookie transport remains private. Only bounded, named public routing metadata
// is excluded from substring redaction; unknown cookies remain sensitive.
internal static class CookieSensitivity
{
    private static readonly Dictionary<string, string> PublicMetadata = Load();
    private static Dictionary<string, string> Load()
    {
        using var stream = typeof(CookieSensitivity).Assembly.GetManifestResourceStream("public-cookie-metadata.json")
            ?? throw new InvalidOperationException("Cookie metadata policy is missing.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);
    }
    internal static bool IsSensitive(string? name, string? value) => name is null || value is null
        || !PublicMetadata.Any(rule =>
            Regex.IsMatch(name, "\\A(?:" + rule.Key + ")\\z", RegexOptions.CultureInvariant)
            && Regex.IsMatch(value, "\\A(?:" + rule.Value + ")\\z", RegexOptions.CultureInvariant));
}
