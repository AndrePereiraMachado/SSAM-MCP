using System.Text.Json.Nodes;
namespace Anvil.Core;

public static class DataPreflight
{
    /// <summary>Where the contract of a Model API type is read, named by the ENUM_VALUE_INVALID and PROPERTY_NOT_WRITABLE
    /// fixes of Preflight.PropertyRules (the enum check that lived here): the CLI line in the checkout; the release overlay
    /// of this file names the MCP call instead.</summary>
    internal static string ApiContract(string type) => "anvil api --name " + type;

    private static readonly HashSet<string> Basic = new(StringComparer.OrdinalIgnoreCase) {
        "Text", "String", "Integer", "Int", "Long Integer", "Long", "Decimal", "Boolean", "Bool", "Date", "Time",
        "Date Time", "DateTime", "Currency", "Email", "Phone Number", "Phone", "Binary Data", "Binary", "Object", "User Identifier" };
    public static JsonObject Analyze(JsonArray source)
    {
        var errors = new JsonArray(); var unresolved = new JsonArray();
        var ops = new List<(JsonObject Op, int Source)>();
        for (var i = 0; i < source.Count; i++)
            if (source[i] is JsonObject op)
                try {
                    if (op["op"]?.ToString() == "spec") ops.AddRange(SpecExpander.Expand(op["data"]!.AsObject()).Select(o => (o, i)));
                    else ops.Add((op, i));
                } catch { /* JobPreflight reports shape errors. */ }
        var declarations = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var n = 0; n < ops.Count; n++)
        {
            var op = ops[n].Op;
            if (op["op"]?.ToString() == "create")
            {
                var type = op["type"]?.ToString() ?? "";
                if (op["as"] is { } alias) aliases[alias.ToString()] = type;
                if (type is "IServerEntity" or "IStaticEntity" or "IClientEntity" || type.EndsWith("Structure", StringComparison.Ordinal))
                    if (op["name"] is { } name && !declarations.TryAdd(name.ToString(), n))
                        errors.Add($"op #{ops[n].Source}: duplicate data type '{name}'");
            }
            if (op["op"]?.ToString() == "reference")
                foreach (var el in op["elements"]?.AsArray() ?? new JsonArray())
                {
                    var parts = el!.ToString().Split(':', 2);
                    if (parts.Length == 2 && (parts[0].Contains("Entity") || parts[0].Contains("Structure"))) declarations.TryAdd(parts[1], n);
                }
        }
        for (var n = 0; n < ops.Count; n++)
        {
            var (op, origin) = ops[n];
            if (op["op"]?.ToString() != "set") continue;
            var property = op["prop"]?.ToString() ?? ""; var value = op["value"];
            var target = op["target"]?.ToString() ?? "";
            // Enum values are judged by Preflight.PropertyRules (ENUM_VALUE_INVALID), on every interface the type names and
            // in what logic expands into too.
            if (property == "Length" && (!int.TryParse(value?.ToString(), out var length) || length <= 0))
                errors.Add($"op #{origin}: {target}.Length must be a positive integer");
            if (property != "DataType" || value == null) continue;
            var name = value.ToString().Trim();
            if (Basic.Contains(name)) continue;
            if (name.Equals("Long Text", StringComparison.OrdinalIgnoreCase) || name is "Identifier" or "Int32" or "Int64")
            {
                errors.Add($"op #{origin}: unknown DataType '{name}' on {target}; use Text with Length for long text, Long Integer/Integer, or <Entity> Identifier. Long Text is supported in spec attributes.");
                continue;
            }
            foreach (var suffix in new[] { " List", " Record", " Identifier" })
                while (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) name = name[..^suffix.Length].Trim();
            if (Basic.Contains(name)) continue;
            if (declarations.TryGetValue(name, out var declaredAt))
            {
                if (declaredAt > n) errors.Add($"op #{origin}: type '{name}' on {target} is used before its declaration at op #{ops[declaredAt].Source}; move the declaration before this use in the SAME job, or put the data types together in one spec. Do not split delivery.");
            }
            else unresolved.Add(new JsonObject { ["type"] = value.DeepClone(), ["name"] = name, ["target"] = target, ["op"] = origin });
        }
        // Indexes read once (a job of a thousand ops expands into tens of thousands: the lookups below were quadratic, minutes
        // for a complete data model): the first create of each alias, the first op of each `as`, the last IdentifierAttribute
        // of each target, and the targets whose Value a set writes.
        var createdBy = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var declaredAs = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var identifiers = new Dictionary<string, string?>(StringComparer.Ordinal);
        var valued = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (op, _) in ops)
        {
            if (op["as"]?.ToString() is { } asName)
            {
                declaredAs.TryAdd(asName, op);
                if (op["op"]?.ToString() == "create") createdBy.TryAdd(asName, op);
            }
            if (op["target"]?.ToString() is { } t)
            {
                if (op["prop"]?.ToString() == "IdentifierAttribute") identifiers[t] = op["value"]?.ToString();
                if (op["prop"]?.ToString() == "Value") valued.Add(t);
            }
        }
        // A static entity id is never AutoNumber (ODC refuses 'StaticEntity Auto Number' live), so every new record needs its id.
        foreach (var (op, origin) in ops)
            if (op["op"]?.ToString() == "set" && op["prop"]?.ToString() == "IsAutoNumber" && string.Equals(op["value"]?.ToString(), "Yes", StringComparison.OrdinalIgnoreCase)
                && StaticOwner(op["target"]?.ToString() ?? "") is { } owner)
                errors.Add($"op #{origin}: IsAutoNumber Yes on {op["target"]} ({owner}): a static entity id is never AutoNumber; set IsAutoNumber No and give every record its Id. A compact static spec does this for you.");
        var records = ops.Where(x => x.Op["type"]?.ToString() is "IRecord" or "IStaticEntityRecord" && x.Op["parent"] != null)
            .GroupBy(x => x.Op["parent"]!.ToString(), StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        foreach (var (entity, _) in ops.Where(x => x.Op["type"]?.ToString() == "IStaticEntity" && x.Op["as"] != null))
        {
            var alias = entity["as"]!.ToString();
            var identifier = identifiers.GetValueOrDefault(alias);
            if (identifier == null) continue;
            var idName = declaredAs.GetValueOrDefault(identifier)?["name"]?.ToString() ?? "Id";
            foreach (var (record, origin) in records.GetValueOrDefault(alias) ?? [])
                if (record["as"] is { } recordAlias && !valued.Contains(recordAlias + "/" + idName))
                    errors.Add($"op #{origin}: static record '{record["name"]}' has no {idName}; set its value ({recordAlias}/{idName} prop Value). A static entity id is never AutoNumber; a compact static spec supplies the ids.");
        }
        // The attribute target is an alias created under a static entity, or an IStaticEntity:<Name>/<Attribute> path.
        string? StaticOwner(string target)
        {
            if (target.StartsWith("IStaticEntity:", StringComparison.Ordinal)) return target.Split('/')[0];
            var parent = createdBy.GetValueOrDefault(target)?["parent"]?.ToString();
            return parent != null && aliases.GetValueOrDefault(parent) == "IStaticEntity" ? parent : null;
        }
        return new JsonObject { ["errors"] = errors, ["unresolvedTypes"] = unresolved };
    }
}
