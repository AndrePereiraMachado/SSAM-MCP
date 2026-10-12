using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Types;

namespace Anvil.Core;

/// <summary>
/// Mini-linguagem de tipos do Set: "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time",
/// "Date Time", "Currency", "Email", "Phone Number", "Binary Data"; "<Entidade> Identifier"; "<Entidade>" ou
/// "<Structure>" (record); "<X> List" (so se a lista ja existir no modulo); "User Identifier" (User do System).
/// Entidades e structures resolvem por nome no modulo e nas referencias.
/// </summary>
public static class TypeResolver
{
    public static ITypeSignature Resolve(IESpace es, string spec)
    {
        var s = spec.Trim();
        var basic = Basic(es, s);
        if (basic != null) return basic;
        if (s.EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase))
        {
            var ent = FindEntitySignature(es, s[..^" Identifier".Length].Trim()) ?? throw new KeyNotFoundException($"entity not found for identifier type: {spec}");
            return ent.IdentifierType;
        }
        if (s.Equals("Object", StringComparison.OrdinalIgnoreCase)) return es.ObjectType;
        if (s.EndsWith(" List", StringComparison.OrdinalIgnoreCase))
        {
            var elem = Resolve(es, s[..^" List".Length]);
            var list = es.ListTypes.FirstOrDefault(l => ReferenceEquals(l.ElementType, elem) || string.Equals(Name(l.ElementType), Name(elem), StringComparison.Ordinal));
            return list ?? es.GetOrCreateListType(elem);   // cria a lista se ainda nao existe (respostas REST em array, variaveis de lista)
        }
        var rec = s.EndsWith(" Record", StringComparison.OrdinalIgnoreCase) ? s[..^" Record".Length].Trim() : s;
        var entity = FindEntitySignature(es, rec);
        if (entity != null) return entity;
        var structure = es.GetAllDescendantsOfType<IStructure>().FirstOrDefault(x => string.Equals(Name(x), rec, StringComparison.OrdinalIgnoreCase));
        if (structure != null) return structure;
        foreach (var r in es.References)
            foreach (var st in r.Structures)
                if (string.Equals(Name(st), rec, StringComparison.OrdinalIgnoreCase) && st is ITypeSignature ts) return ts;
        // Native common records (e.g. ODC AIMessage/AIItem) are signatures,
        // not editable IStructure objects or imported reference structures.
        // Preserve the existing local/reference precedence before this fallback.
        var common = es.GetAllDescendantsOfType<IStructureSignature>()
            .FirstOrDefault(x => string.Equals(Name(x), rec, StringComparison.OrdinalIgnoreCase));
        if (common is ITypeSignature commonType) return commonType;
        throw new KeyNotFoundException($"unknown type: {spec}");
    }

    public static IBasicType? Basic(IESpace es, string s) => s.Replace(" ", "").ToLowerInvariant() switch
    {
        "text" or "string" => es.TextType,
        "integer" or "int" => es.IntegerType,
        "longinteger" or "long" => es.LongIntegerType,
        "decimal" => es.DecimalType,
        "boolean" or "bool" => es.BooleanType,
        "date" => es.DateType,
        "time" => es.TimeType,
        "datetime" => es.DateTimeType,
        "currency" => es.CurrencyType,
        "email" => es.EmailType,
        "phonenumber" or "phone" => es.PhoneNumberType,
        "binarydata" or "binary" => es.BinaryDataType,
        _ => null,
    };

    /// <summary>Entidade (server/static/client) do modulo ou de uma referencia, por nome.</summary>
    public static IEntitySignature? FindEntitySignature(IESpace es, string name)
    {
        foreach (var e in es.GetAllDescendantsOfType<IEntity>())
            if (string.Equals(Name(e), name, StringComparison.OrdinalIgnoreCase)) return e;
        foreach (var r in es.References)
            foreach (var e in r.Entities)
                if (string.Equals(Name(e), name, StringComparison.OrdinalIgnoreCase)) return e;
        return null;
    }

    public static string? Name(object? o) => o?.GetType().GetProperty("Name")?.GetValue(o) as string;
}
