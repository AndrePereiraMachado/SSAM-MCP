using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Anvil.Core;

public static class Json
{
    /// <summary>Opcoes com resolver explicito: a pasta do Studio traz o proprio
    /// System.Text.Json e as opcoes default podem ficar read-only sem resolver.</summary>
    public static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        IncludeFields = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    public static readonly JsonSerializerOptions Compact = new()
    {
        WriteIndented = false,
        IncludeFields = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    public static string Serialize<T>(T value, bool pretty = true) => JsonSerializer.Serialize(value, pretty ? Pretty : Compact);

    /// <summary>
    /// Projecao por reflexao dos DTOs do Studio (structs com campos, ObjectKey,
    /// enums, arrays), tolerante a getters que lancam. Uso: diagnostico e dumps
    /// brutos; a API tipada usa os records de Dtos.cs.
    /// </summary>
    public static JsonNode? Project(object? o, int depth = 0)
    {
        if (o == null) return null;
        if (depth > 4) return JsonValue.Create(o.ToString());
        switch (o)
        {
            case string s: return JsonValue.Create(s);
            case bool b: return JsonValue.Create(b);
            case int i: return JsonValue.Create(i);
            case long l: return JsonValue.Create(l);
            case decimal d: return JsonValue.Create(d);
            case double dd: return JsonValue.Create(dd);
            case DateTime dt: return JsonValue.Create(dt.ToString("o"));
            case byte[] bytes: return JsonValue.Create($"<{bytes.Length} bytes>");
            case Enum e: return JsonValue.Create(e.ToString());
            case Version v: return JsonValue.Create(v.ToString());
        }
        var type = o.GetType();
        if (type.FullName == "OutSystems.ObjectKeys.ObjectKey" || type.BaseType?.FullName == "OutSystems.ObjectKeys.ObjectKey")
            return JsonValue.Create(o.ToString());
        if (o is System.Collections.IEnumerable seq)
        {
            var arr = new JsonArray();
            foreach (var item in seq) arr.Add(Project(item, depth + 1));
            return arr;
        }
        var obj = new JsonObject();
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!p.CanRead || p.GetIndexParameters().Length > 0) continue;
            try { obj[p.Name] = Project(p.GetValue(o), depth + 1); }
            catch (Exception ex) { obj[p.Name] = JsonValue.Create("<error " + (ex.InnerException ?? ex).GetType().Name + ">"); }
        }
        foreach (var f in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            try { obj[f.Name] = Project(f.GetValue(o), depth + 1); }
            catch (Exception ex) { obj[f.Name] = JsonValue.Create("<error " + (ex.InnerException ?? ex).GetType().Name + ">"); }
        }
        return obj;
    }
}
