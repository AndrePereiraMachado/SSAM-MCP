namespace Anvil.Core;

/// <summary>
/// D2 of the atritos 3 package (C21): the Studio keeps at most 28 characters of the name of an entity attribute or of an
/// index and truncates a longer one in silence (index: 'IX_Contact_Email_Name_Status30' became
/// 'IX_Contact_Email_Name_Status', measured 2026-09-23 on ODC 1.7.25 and Service Studio 11.55.87; attribute: a client migration
/// 'SignatureAuthenticationMethod', 29 characters, refused only by the data proof). The kernel writes the name the Studio
/// would keep, so the data proof expects that one: the first 28 characters; when that name is taken by a sibling, its end
/// gives way to a number (…2, …3) as a copy is numbered. Every truncation is reported in nameTruncations. Pure.
/// </summary>
public static class NameTruncation
{
    public const int MaxLength = 28;

    /// <summary>The name the Studio keeps for <paramref name="name"/> among <paramref name="siblings"/> (case-insensitive);
    /// the name itself when it fits.</summary>
    public static string Truncate(string name, IEnumerable<string> siblings)
    {
        if (name.Length <= MaxLength) return name;
        var taken = new HashSet<string>(siblings, StringComparer.OrdinalIgnoreCase);
        var cut = name[..MaxLength];
        for (var n = 2; taken.Contains(cut); n++)
        {
            var suffix = n.ToString(System.Globalization.CultureInfo.InvariantCulture);
            cut = name[..(MaxLength - suffix.Length)] + suffix;
        }
        return cut;
    }
}
