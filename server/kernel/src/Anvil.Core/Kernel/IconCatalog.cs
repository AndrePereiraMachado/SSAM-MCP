using System.Collections;
using System.Reflection;

namespace Anvil.Core;

/// <summary>
/// C17 of the atritos 3 package (ODC lane): the icon names the bound ODC Studio knows. The merge of the ODC Studio converts a
/// FontAwesome name to the active library (Phosphor 2.0) through its own table (labs 22, 24, 30: cart-plus became
/// shopping-cart/fill, times became x), so the kernel writes the converted name itself and the merged module equals the
/// candidate. The table and the active library are read from the installed Studio, by reflection, on
/// ServiceStudio.Plugin.NRWidgets.IconLibraryProvider (OutSystems.Model.Plugin.NRWidgets.dll): GetIconClassNameMapping of
/// the default library and GetIconConversionMapping(old library, default library). Read once per process (one Studio per
/// process). No table (O11, or a Studio without that provider): nothing changes. Tests inject a table (Override).
/// </summary>
public static class IconCatalog
{
    /// <summary>The active library (its icon names) and the conversion table into it (old name: new name and weight).</summary>
    public sealed record IconTable(string Library, IReadOnlySet<string> Active, IReadOnlyDictionary<string, (string Name, string? Weight)> Conversion);

    /// <summary>What a name written to an icon becomes: the same (known), converted (with the weight of the table), or unknown.</summary>
    public sealed record IconVerdict(string Name, string? Weight, bool Converted, bool Unknown, IReadOnlyList<string> Closest);

    /// <summary>A table for tests (and hosts that read it otherwise); null reads the bound Studio.</summary>
    public static IconTable? Override { get; set; }

    private static readonly Lazy<IconTable?> Loaded = new(Load);

    /// <summary>The table of the bound Studio of this lane, or null (O11, no provider).</summary>
    public static IconTable? Current => Override ?? (MessageExpectations.Lane == "odc" ? Loaded.Value : null);

    /// <summary>The verdict of a name against <paramref name="table"/>: kept when the active library has it, converted when the
    /// table has it, unknown otherwise (with the closest active names).</summary>
    public static IconVerdict Judge(string name, IconTable table)
    {
        var trimmed = name.Trim();
        if (table.Active.Contains(trimmed)) return new(trimmed, null, false, false, []);
        if (table.Conversion.TryGetValue(trimmed, out var converted)) return new(converted.Name, string.IsNullOrEmpty(converted.Weight) ? null : converted.Weight, true, false, []);
        return new(trimmed, null, false, true, NameSuggestions.Closest(trimmed, table.Active));
    }

    private static IconTable? Load()
    {
        try
        {
            var provider = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic)
                .Select(a => a.GetType("ServiceStudio.Plugin.NRWidgets.IconLibraryProvider", false)).FirstOrDefault(t => t != null);
            if (provider == null) return null;
            var instance = provider.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
            if (instance == null) return null;
            var library = provider.GetProperty("DefaultIconLibrary")?.GetValue(instance) as string;
            var old = provider.GetProperty("OldIconLibrary")?.GetValue(instance) as string;
            if (string.IsNullOrEmpty(library)) return null;
            var active = provider.GetMethod("GetIconClassNameMapping")?.Invoke(instance, [library]) is IDictionary names
                ? names.Keys.Cast<object>().Select(k => k.ToString()!).ToHashSet(StringComparer.Ordinal) : new HashSet<string>(StringComparer.Ordinal);
            var conversion = new Dictionary<string, (string, string?)>(StringComparer.Ordinal);
            if (!string.IsNullOrEmpty(old) && provider.GetMethod("GetIconConversionMapping")?.Invoke(instance, [old, library]) is IDictionary table)
                foreach (DictionaryEntry entry in table)
                {
                    var mapping = entry.Value;
                    if (mapping?.GetType().GetProperty("IconName")?.GetValue(mapping) is not string target || target.Length == 0) continue;
                    conversion[entry.Key.ToString()!] = (target, mapping.GetType().GetProperty("Weight")?.GetValue(mapping) as string);
                }
            return active.Count == 0 ? null : new IconTable(library, active, conversion);
        }
        catch { return null; }
    }
}
