using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The contract check of an imported SOAP client (op `soap`), on the candidate before any merge: every parameter of the
/// requested methods keeps the exact WSDL type. A parameter whose OriginalType is an XML Schema primitive must have the
/// OutSystems type of that primitive; one whose OriginalType is complex must be typed by the client's own SOAP structure
/// of that name, bound by key (never Text, never a same-named structure elsewhere). GitSSAM proved live that an import
/// over a filtered WSDL detached a complex type (tCurrency) this way and code generation crashed later; here the delivery
/// stops before the merge with SOAP_CONTRACT_TYPE_MISMATCH naming each parameter. The check itself is pure (records);
/// <see cref="Read"/> takes the records from the model.
/// </summary>
public static class SoapContract
{
    public sealed record Parameter(string Action, string Direction, string Name, string OriginalType, string ActualType, string? ActualTypeKey);
    public sealed record Structure(string Name, string OriginalName, string Key);

    private static readonly Dictionary<string, string> Primitives = new(StringComparer.OrdinalIgnoreCase)
    {
        ["string"] = "Text", ["normalizedString"] = "Text", ["token"] = "Text", ["anyURI"] = "Text", ["QName"] = "Text", ["language"] = "Text", ["ID"] = "Text", ["NCName"] = "Text",
        ["boolean"] = "Boolean", ["byte"] = "Integer", ["unsignedByte"] = "Integer", ["short"] = "Integer", ["unsignedShort"] = "Integer", ["int"] = "Integer",
        ["integer"] = "Integer", ["long"] = "Long Integer", ["unsignedInt"] = "Long Integer", ["unsignedLong"] = "Decimal", ["positiveInteger"] = "Integer",
        ["nonNegativeInteger"] = "Integer", ["negativeInteger"] = "Integer", ["nonPositiveInteger"] = "Integer",
        ["decimal"] = "Decimal", ["double"] = "Decimal", ["float"] = "Decimal", ["date"] = "Date", ["dateTime"] = "Date Time", ["time"] = "Time",
        ["base64Binary"] = "Binary Data", ["hexBinary"] = "Binary Data",
    };

    public static string LocalName(string qname)
    {
        var text = (qname ?? "").Trim();
        var at = Math.Max(Math.Max(text.LastIndexOf(':'), text.LastIndexOf('#')), text.LastIndexOf('}')); // tns:x, ns#x, {uri}x
        var local = at >= 0 && at + 1 < text.Length ? text[(at + 1)..] : text;
        return local.EndsWith("[]", StringComparison.Ordinal) ? local[..^2] : local;
    }

    /// <summary>The OutSystems type of an XML Schema primitive, or null when the original type is complex.</summary>
    public static string? PrimitiveOf(string originalType)
    {
        var local = LocalName(originalType);
        if (Primitives.TryGetValue(local, out var type)) return type;
        return originalType.Contains("www.w3.org/2001/XMLSchema", StringComparison.OrdinalIgnoreCase) ? "Text" : null;
    }

    /// <summary>Every parameter whose type is not the WSDL's: SOAP_CONTRACT_TYPE_MISMATCH, one problem each.</summary>
    public static List<IntegrationProblem> Check(IEnumerable<Parameter> parameters, IReadOnlyCollection<Structure> structures)
    {
        var problems = new List<IntegrationProblem>();
        foreach (var p in parameters)
        {
            if (string.IsNullOrWhiteSpace(p.OriginalType)) continue;
            var actual = Plain(p.ActualType);
            var primitive = PrimitiveOf(p.OriginalType);
            var where = $"{p.Action}.{p.Name} ({p.Direction})";
            if (primitive != null)
            {
                if (!Same(actual, primitive))
                    problems.Add(new("SOAP_CONTRACT_TYPE_MISMATCH", "/data/methods", $"soap: {where} is {p.ActualType} and the WSDL type {p.OriginalType} is {primitive}",
                        "nothing was merged; refresh the method (\"refresh\": [\"" + p.Action + "\"]) so the native import types it again from the full WSDL"));
                continue;
            }
            var local = LocalName(p.OriginalType);
            var structure = structures.FirstOrDefault(s => Same(s.OriginalName, local)) ?? structures.FirstOrDefault(s => Same(s.Name, local));
            if (structure == null)
            {
                problems.Add(new("SOAP_CONTRACT_TYPE_MISMATCH", "/data/methods", $"soap: {where} has the complex WSDL type {p.OriginalType} and the client has no SOAP structure for it",
                    "nothing was merged; import the method again with the full WSDL (\"refresh\": [\"" + p.Action + "\"])"));
                continue;
            }
            if (Same(actual, "Text") || !Same(actual, structure.Name) || (p.ActualTypeKey != null && structure.Key.Length > 0 && p.ActualTypeKey != structure.Key))
                problems.Add(new("SOAP_CONTRACT_TYPE_MISMATCH", "/data/methods", $"soap: {where} is {p.ActualType}{(p.ActualTypeKey != null && p.ActualTypeKey != structure.Key ? " (key " + p.ActualTypeKey + ")" : "")} and the WSDL type {p.OriginalType} is the client's structure {structure.Name} (key {structure.Key})",
                    "nothing was merged; refresh the method (\"refresh\": [\"" + p.Action + "\"]) so it is typed by the client's own structure"));
        }
        return problems;
    }

    private static string Plain(string type) => type.EndsWith(" List", StringComparison.OrdinalIgnoreCase) ? type[..^5] : type;
    private static bool Same(string a, string b) => string.Equals(a.Replace(" ", ""), b.Replace(" ", ""), StringComparison.OrdinalIgnoreCase);

    /// <summary>The parameters of the client's methods named in <paramref name="methods"/> (all when null) and the client's
    /// SOAP structures, read from the model.</summary>
    public static (List<Parameter> Parameters, List<Structure> Structures) Read(IObjectSignature client, IReadOnlyCollection<string>? methods)
    {
        var structures = client.Children.OfType<IObjectSignature>()
            .Where(c => ModelSession.Implements(c, "ISOAPStructure"))
            .Select(c => new Structure(TypeResolver.Name(c) ?? "", ModelHost.Prop(c, "OriginalName")?.ToString() ?? "", c.ObjectKey?.ToString() ?? "")).ToList();
        var parameters = new List<Parameter>();
        foreach (var action in client.Children.OfType<IObjectSignature>().Where(c => ModelSession.Implements(c, "ISOAPAction")))
        {
            var name = TypeResolver.Name(action) ?? "";
            if (methods != null && !methods.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
            foreach (var parameter in action.Children.OfType<IObjectSignature>())
            {
                var direction = ModelSession.Implements(parameter, "ISOAPActionInput") ? "input" : ModelSession.Implements(parameter, "ISOAPActionOutput") ? "output" : null;
                if (direction == null) continue;
                var dataType = ModelHost.Prop(parameter, "DataType");
                parameters.Add(new(name, direction, TypeResolver.Name(parameter) ?? "", ModelHost.Prop(parameter, "OriginalType")?.ToString() ?? "",
                    UiCatalog.TypeName(dataType) ?? "", TypeKey(dataType)));
            }
        }
        return (parameters, structures);
    }

    /// <summary>The key of the structure a type points at (a structure type or a list of one), or null for a primitive.</summary>
    public static string? TypeKey(object? dataType)
    {
        for (var (type, depth) = (dataType, 0); type != null && depth < 3; depth++)
        {
            if (type is IObjectSignature { ObjectKey: { } key } signature && (ModelSession.Implements(signature, "IStructure") || ModelSession.Implements(signature, "IRecord") || ModelSession.Implements(signature, "IStructureSignature")))
                return key.ToString();
            object? next = null;
            foreach (var property in new[] { "Structure", "RecordDefinition", "Definition", "ElementType", "Type" })
                if ((next = ModelHost.Prop(type, property)) != null && !ReferenceEquals(next, type)) break;
            type = next;
        }
        return null;
    }

    public static JsonArray ToJson(IEnumerable<IntegrationProblem> problems) => new(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p.ToJson())).ToArray());
}
