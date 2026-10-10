using System.Collections;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// O censo de um modulo: percorre TODOS os objetos (nao o top-N do <c>inspect</c>) e responde, por tipo do Model API,
/// quantas instancias existem, QUAIS propriedades o codigo de facto define, e que filhos uma instancia real tem.
///
/// Para que serve: a API diz o que e POSSIVEL; um modulo real diz o que e USADO. Um `create` so nasce idiomatico se
/// souber o conjunto minimo de propriedades que a plataforma espera, e esse conjunto nao esta documentado em lado
/// nenhum -- le-se de um exemplo que funciona.
///
/// FORMA, NAO CONTEUDO: para propriedade de texto e expressao o censo guarda so a frequencia e o tamanho; valores
/// distintos so sao recolhidos para enum e booleano, que sao vocabulario fechado da plataforma. Assim o censo de um
/// modulo de terceiro pode ser lido, versionado e discutido sem carregar uma linha do codigo dele.
/// </summary>
public sealed partial class ModelSession
{
    private const int MaxDistinctValues = 12;

    public JsonObject Census()
    {
        var types = new Dictionary<string, TypeCensus>(StringComparer.Ordinal);
        var total = 0;
        foreach (var o in Descendants())
        {
            total++;
            var typeName = ShortType(o);
            if (!types.TryGetValue(typeName, out var census)) types[typeName] = census = new TypeCensus();
            census.Count++;
            foreach (var pi in AllProperties(o).GroupBy(p => p.Name).Select(g => g.OrderByDescending(p => p.CanWrite).First()))
            {
                if (pi.GetIndexParameters().Length > 0 || Skip.Contains(pi.Name)) continue;
                object? value;
                try { value = pi.GetValue(o); } catch { continue; }
                if (!census.Properties.TryGetValue(pi.Name, out var property))
                    census.Properties[pi.Name] = property = new PropertyCensus(ShortName(pi.PropertyType), pi.CanWrite);
                property.Seen++;
                if (IsUnset(value)) continue;
                property.Set++;
                Record(property, pi.PropertyType, value);
            }
            foreach (var child in o.Children.OfType<IObjectSignature>())
            {
                var childType = ShortType(child);
                census.Children.TryGetValue(childType, out var n);
                census.Children[childType] = n + 1;
            }
        }
        var result = new JsonObject { ["objects"] = total, ["types"] = types.Count };
        var byType = new JsonObject();
        foreach (var (name, census) in types.OrderByDescending(t => t.Value.Count).ThenBy(t => t.Key, StringComparer.Ordinal))
            byType[name] = census.ToJson();
        result["byType"] = byType;
        return result;
    }

    /// <summary>Ruido de infraestrutura do modelo: nao ensina nada sobre como construir um objeto.</summary>
    private static readonly HashSet<string> Skip = new(StringComparer.Ordinal)
    {
        "Parent", "Children", "TransactionsManager", "Descriptor", "ObjectKey", "Key", "GlobalKey", "Object",
        "OwnerESpace", "CollectionDescriptor", "Digest", "Generation", "WasDeleted", "IsDetached", "Match",
        "ReadableIdentifier", "DisplayName", "CanMoveBefore", "CanMoveAfter", "IsValid", "IsSystemObject", "Referrers",
    };

    private static bool IsUnset(object? value) => value switch
    {
        null => true,
        string s => s.Length == 0,
        bool => false,
        DateTime d => d == default,
        IExpression e => string.IsNullOrEmpty(e.Text),
        IEnumerable sequence and not string => !sequence.Cast<object>().Any(),
        _ => false,
    };

    /// <summary>Enum e booleano sao vocabulario fechado da plataforma: os valores distintos ensinam e nao expoem nada.
    /// Texto e expressao entram so como estatistica de tamanho.</summary>
    private static void Record(PropertyCensus property, Type type, object value)
    {
        var underlying = Nullable.GetUnderlyingType(type) ?? type;
        if (underlying.IsEnum || underlying == typeof(bool))
        {
            var text = value.ToString() ?? "";
            if (property.Values.Count < MaxDistinctValues || property.Values.ContainsKey(text))
            {
                property.Values.TryGetValue(text, out var n);
                property.Values[text] = n + 1;
            }
            return;
        }
        var length = value switch { string s => s.Length, IExpression e => e.Text?.Length ?? 0, _ => -1 };
        if (length < 0) return;
        property.Lengths ??= new Lengths();
        property.Lengths.Add(length);
    }

    private static string ShortName(Type type)
    {
        var underlying = Nullable.GetUnderlyingType(type) ?? type;
        if (!underlying.IsGenericType) return underlying.Name;
        return underlying.Name[..underlying.Name.IndexOf('`')] + "<" + string.Join(",", underlying.GetGenericArguments().Select(ShortName)) + ">";
    }

    private sealed class TypeCensus
    {
        public int Count;
        public readonly Dictionary<string, PropertyCensus> Properties = new(StringComparer.Ordinal);
        public readonly Dictionary<string, int> Children = new(StringComparer.Ordinal);

        public JsonObject ToJson()
        {
            var properties = new JsonObject();
            foreach (var (name, p) in Properties.Where(p => p.Value.Set > 0).OrderByDescending(p => p.Value.Set).ThenBy(p => p.Key, StringComparer.Ordinal))
                properties[name] = p.ToJson(Count);
            var children = new JsonObject();
            foreach (var (name, n) in Children.OrderByDescending(c => c.Value).ThenBy(c => c.Key, StringComparer.Ordinal))
                children[name] = n;
            var unset = new JsonArray(Properties.Where(p => p.Value.Set == 0).Select(p => p.Key)
                .OrderBy(n => n, StringComparer.Ordinal).Select(n => (JsonNode)n!).ToArray());
            var result = new JsonObject { ["count"] = Count, ["properties"] = properties };
            if (children.Count > 0) result["children"] = children;
            if (unset.Count > 0) result["neverSet"] = unset;
            return result;
        }
    }

    private sealed class PropertyCensus(string type, bool writable)
    {
        public int Seen, Set;
        public readonly Dictionary<string, int> Values = new(StringComparer.Ordinal);
        public Lengths? Lengths;

        public JsonObject ToJson(int instances)
        {
            var result = new JsonObject { ["type"] = type, ["set"] = Set, ["of"] = instances };
            if (!writable) result["readOnly"] = true;
            if (Values.Count > 0)
            {
                var values = new JsonObject();
                foreach (var (v, n) in Values.OrderByDescending(v => v.Value).ThenBy(v => v.Key, StringComparer.Ordinal)) values[v] = n;
                result["values"] = values;
            }
            if (Lengths != null) result["length"] = Lengths.ToJson();
            return result;
        }
    }

    private sealed class Lengths
    {
        private int _min = int.MaxValue, _max, _count;
        private long _sum;
        public void Add(int length) { _count++; _sum += length; if (length < _min) _min = length; if (length > _max) _max = length; }
        public JsonObject ToJson() => new() { ["min"] = _min, ["max"] = _max, ["avg"] = (int)(_sum / Math.Max(1, _count)) };
    }
}
