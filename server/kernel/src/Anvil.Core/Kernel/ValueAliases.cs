using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>The names the Studio shows for some enum values, mapped to the value the model stores, so a job that writes what
/// the Studio shows is applied instead of refused (C09). One table for the spec, the set verb, the preflight and the data
/// contract, so the four agree.</summary>
public static class ValueAliases
{
    private static readonly Regex ChangedAttributes = new(@"^\s*changed\s*attributes\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>The key a system exception answers to: spaces, case and the Exception(s) suffix do not matter
    /// ("All Exceptions", "AllExceptions" and "All" are "all"; "Database Exception" and "DatabaseException" are "database").</summary>
    public static string SystemExceptionKey(string name)
    {
        var key = new string(name.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        if (key.EndsWith("exceptions", StringComparison.Ordinal)) key = key[..^"exceptions".Length];
        else if (key.EndsWith("exception", StringComparison.Ordinal)) key = key[..^"exception".Length];
        return key;
    }

    /// <summary>The system exceptions of both platforms, by their key.</summary>
    public static readonly IReadOnlySet<string> SystemExceptions = new HashSet<string>(StringComparer.Ordinal)
        { "all", "database", "security", "notregistered", "communication", "abortactivitychange", "user" };

    /// <summary>The stored value for <paramref name="value"/> of <paramref name="property"/>; the value itself when it is no alias.</summary>
    public static string Normalize(string property, string value) => property switch
    {
        "UpdateBehavior" or "updateBehavior" when ChangedAttributes.IsMatch(value) => "Optimized",
        _ => value,
    };
}
