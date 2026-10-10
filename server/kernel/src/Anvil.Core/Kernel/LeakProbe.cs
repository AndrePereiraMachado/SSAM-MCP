using System.Collections;
using System.Reflection;

namespace Anvil.Core;

public sealed record StaticHit(string Type, string Field, string ValueType, int Count, string Sample, string Path);

/// <summary>
/// Sonda de retencao para o processo residente: percorre os campos ESTATICOS de todos os tipos dos assemblies do Studio,
/// do Model API e do Anvil e devolve as colecoes grandes (e as colecoes grandes dentro de singletons, ate 2 niveis).
/// E deterministica e nao depende de ferramentas externas (dotnet-gcdump); serve para apontar QUAL campo segura a memoria
/// quando `ESpaceInstances` ja esta vazio e o GC completo nao devolve o heap.
/// </summary>
public static class LeakProbe
{
    public static IReadOnlyList<StaticHit> ScanStatics(int minCount = 200, int maxHits = 60)
    {
        var hits = new List<StaticHit>();
        var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var name = asm.GetName().Name ?? "";
            if (!(name.StartsWith("ServiceStudio", StringComparison.Ordinal) || name.StartsWith("OutSystems", StringComparison.Ordinal) || name.StartsWith("Anvil", StringComparison.Ordinal))) continue;
            Type[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray()!; }
            catch { continue; }
            foreach (var t in types)
            {
                if (t.IsGenericTypeDefinition) continue;
                FieldInfo[] fields;
                try { fields = t.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly); }
                catch { continue; }
                foreach (var f in fields)
                {
                    if (f.IsLiteral || f.FieldType.IsPrimitive || f.FieldType == typeof(string) || f.FieldType.IsEnum) continue;
                    object? v;
                    try { v = f.GetValue(null); } catch { continue; }
                    if (v == null) continue;
                    Visit(v, t.FullName ?? t.Name, f.Name, f.Name, 0, minCount, hits, visited);
                    if (hits.Count >= maxHits * 4) break;
                }
            }
        }
        return hits.OrderByDescending(h => h.Count).Take(maxHits).ToList();
    }

    private static void Visit(object v, string type, string field, string path, int depth, int minCount, List<StaticHit> hits, HashSet<object> visited)
    {
        if (!visited.Add(v)) return;
        var count = CountOf(v);
        if (count >= minCount)
        {
            hits.Add(new StaticHit(type, field, v.GetType().Name, count, SampleOf(v), path));
            return;
        }
        if (depth >= 2) return;
        var vt = v.GetType();
        if (vt.IsPrimitive || vt == typeof(string) || vt.IsEnum) return;
        FieldInfo[] inner;
        try { inner = vt.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic); }
        catch { return; }
        foreach (var f in inner)
        {
            if (f.FieldType.IsPrimitive || f.FieldType == typeof(string) || f.FieldType.IsEnum) continue;
            object? iv;
            try { iv = f.GetValue(v); } catch { continue; }
            if (iv == null) continue;
            Visit(iv, type, field, path + "." + f.Name, depth + 1, minCount, hits, visited);
        }
    }

    /// <summary>Tamanho de uma colecao (ICollection/IDictionary/Array) ou -1.</summary>
    private static int CountOf(object v)
    {
        try
        {
            if (v is Array a) return a.Length;
            if (v is ICollection c) return c.Count;
            var p = v.GetType().GetProperty("Count", BindingFlags.Instance | BindingFlags.Public);
            if (p != null && p.PropertyType == typeof(int) && v is IEnumerable) return (int)p.GetValue(v)!;
        }
        catch { }
        return -1;
    }

    private static string SampleOf(object v)
    {
        try
        {
            if (v is IDictionary d)
            {
                foreach (DictionaryEntry e in d) return $"{e.Key?.GetType().Name} -> {e.Value?.GetType().Name}";
                return "";
            }
            if (v is IEnumerable en)
            {
                foreach (var x in en) return x?.GetType().Name ?? "null";
            }
        }
        catch { }
        return "";
    }
}
