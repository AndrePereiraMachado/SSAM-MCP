using OutSystems.ObjectKeys;

namespace Anvil.Core;

/// <summary>Chaves de objeto em duas grafias: base64 do Studio ("Wrm0V2Zy...") e GUID do REST ("57b4b95a-...").
/// Sao a MESMA chave: base64 dos bytes do Guid (.NET), sem '=' (provado: ReactiveWebApp).</summary>
public static class Keys
{
    public static ObjectKey Parse(string key)
    {
        if (Guid.TryParse(key, out var g)) return ObjectKey.NewKey(g);
        return ObjectKey.Parse(key) ?? throw new FormatException("not an object key: " + key);
    }

    /// <summary>Forma que as URLs REST e o banco usam (ObjectKey.ToString("DB")).</summary>
    public static string ToDb(string key) => Parse(key).ToString("DB");

    /// <summary>Forma canonica do Studio (a que aparece no inventario e nos OMLs).</summary>
    public static string ToStudio(string key) => Parse(key).ToString();
}
