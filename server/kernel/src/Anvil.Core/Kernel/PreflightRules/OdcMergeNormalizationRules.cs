using System.Globalization;
using System.Text.Json.Nodes;

namespace Anvil.Core.PreflightRules;

/// <summary>
/// ODC native merge normalizations, checked before the job runs (pacote D2, C16.2, interface I1). The ODC Studio's merge
/// sets the Max. Records of a Refresh Data node to the Max. Records of the aggregate it refreshes (50 for 200 and 100 in
/// the six nodes of labs 10 and 61, 2026-10-04/05), so an explicit MaxRecords that differs can never reach the module:
/// the delivery would end with the merged module different from the candidate. Refused here with the fix (omit it; the
/// refresh takes the aggregate's value, which is the default) and a mechanical patch that removes it. An explicit value
/// equal to the aggregate declared in the same job passes; when the aggregate is not declared in the job its value is
/// unknown here and the explicit MaxRecords is refused always. The Structure.Public rule needs the module's kind (app or
/// library) and lives in the facade (kernel-delivery.mjs). Pure: no model, no I/O, no clock.
/// </summary>
public static class OdcMergeNormalizationRules
{
    public const string Code = "ODC_REFRESH_MAXRECORDS";
    public const string DeleteRuleCode = "ODC_DELETE_RULE_FORCED";
    // The ODC system entities an app references without declaring them (each app has its own database: Ignore only).
    private static readonly string[] SystemEntities = ["User"];
    private static bool SystemEntityReference(string? type)
        => type != null && SystemEntities.Any(entity => string.Equals(System.Text.RegularExpressions.Regex.Replace(type.Trim(), @"\s+", " "), entity + " Identifier", StringComparison.OrdinalIgnoreCase));
    // The Max. Records an aggregate has when the job does not set it (the value the merge kept in every node observed).
    private const string DefaultAggregateMaxRecords = "50";
    private static readonly HashSet<string> AggregateTypes = new(StringComparer.Ordinal) { "IScreenAggregate", "ScreenAggregate", "IAggregate", "Aggregate" };
    private static readonly HashSet<string> RefreshTypes = new(StringComparer.Ordinal) { "IRefreshDataNode", "RefreshDataNode" };

    public static IEnumerable<JsonObject> Check(JsonArray ops, string lane)
    {
        if (lane != "odc") yield break;
        var aggregates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var aliases = new Dictionary<string, (string Kind, string? Name, int Op)>(StringComparer.Ordinal);
        var refreshes = new List<(int Op, string Pointer, string Value, string? Aggregate)>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var verb = Text(op["op"]);
            if (verb == "create" && Text(op["type"]) is { } type)
            {
                var name = Text(op["name"]) ?? Text((op["args"] as JsonObject)?["name"]) ?? Text((op["args"] as JsonObject)?["Name"]);
                if (AggregateTypes.Contains(type))
                {
                    if (name != null) aggregates[name] = Value((op["args"] as JsonObject)?["MaxRecords"]) ?? DefaultAggregateMaxRecords;
                    if (Text(op["as"]) is { } alias) aliases[alias] = ("aggregate", name, i);
                }
                else if (RefreshTypes.Contains(type))
                {
                    var args = op["args"] as JsonObject;
                    var source = Text(args?["DataSource"]) ?? Text(args?["dataSource"]);
                    var refreshed = source != null && aliases.TryGetValue(source, out var bound) && bound.Kind == "aggregate" ? bound.Name : AggregateName(source);
                    if (Text(op["as"]) is { } alias) aliases[alias] = ("refresh", refreshed, i);
                    if (args?["MaxRecords"] is { } max) refreshes.Add((i, "/ops/" + i + "/args/MaxRecords", Value(max) ?? "", refreshed));
                }
            }
            else if (verb == "set" && Text(op["prop"]) == "MaxRecords" && Text(op["target"]) is { } target)
            {
                var value = Value(op["value"]) ?? "";
                if (aliases.TryGetValue(target, out var known))
                {
                    if (known.Kind == "aggregate" && known.Name != null) aggregates[known.Name] = value;
                    else if (known.Kind == "refresh") refreshes.Add((i, "/ops/" + i, value, known.Name));
                }
                else if (AggregateTarget(target) is { } aggregate) aggregates[aggregate] = value;
            }
            else if (verb is "html" or "screen" or "logic" && op["data"] is JsonNode data)
                Walk(data, "/ops/" + i + "/data", i, aggregates, refreshes);
        }
        // C17 (atritos 3): a reference to the system entity User keeps only Ignore in ODC (lab 10: "the Studio set Delete Rule
        // Ignore on Cart.UserId (requested Protect)"); an explicit Protect or Delete is refused with the patch to Ignore. Without
        // deleteRule the kernel writes Ignore (Verbs.Spec, which also judges references to other apps' entities on the base).
        // An entity the job itself declares under that name is its own, not the system's.
        var declaredEntities = ops.OfType<JsonObject>().Where(o => Text(o["op"]) == "spec").SelectMany(o => new[] { "entities", "clientEntities", "static" }
            .SelectMany(s => (o["data"]?[s] as JsonArray ?? new JsonArray()).Select(x => Text(x?["name"])))).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || Text(op["op"]) != "spec" || op["data"] is not JsonObject data) continue;
            if (SystemEntities.Any(declaredEntities.Contains)) break;
            foreach (var section in new[] { "entities", "clientEntities" })
                for (var e = 0; e < (data[section] as JsonArray)?.Count; e++)
                    for (var a = 0; a < (data[section]![e]?["attributes"] as JsonArray)?.Count; a++)
                    {
                        if (data[section]![e]!["attributes"]![a] is not JsonObject attribute) continue;
                        if (Text(attribute["deleteRule"]) is not { } rule || rule.Equals("Ignore", StringComparison.OrdinalIgnoreCase)) continue;
                        if (!SystemEntityReference(Text(attribute["type"]))) continue;
                        var pointer = $"/ops/{i}/data/{section}/{e}/attributes/{a}/deleteRule";
                        yield return new JsonObject
                        {
                            ["op"] = i, ["pointer"] = pointer, ["code"] = DeleteRuleCode, ["severity"] = "error",
                            ["message"] = $"{Text(data[section]![e]!["name"])}.{Text(attribute["name"])} references the system entity User with deleteRule {rule}: ODC keeps only Ignore on a reference to an entity of the system or of another app (the Studio rewrites it at merge, and the delivery would not match the candidate).",
                            ["fix"] = "\"deleteRule\": \"Ignore\" (or leave it out: the kernel writes Ignore)",
                            ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = "Ignore" })
                        };
                    }
        }
        foreach (var (op, pointer, value, aggregate) in refreshes)
        {
            string? kept = aggregate != null && aggregates.TryGetValue(aggregate, out var declared) ? declared : null;
            if (kept != null && Same(kept, value)) continue;
            var target = aggregate ?? "its aggregate";
            yield return new JsonObject
            {
                ["op"] = op, ["pointer"] = pointer, ["code"] = Code, ["severity"] = "error",
                ["message"] = "Refresh Data of " + target + " sets MaxRecords " + value + ": the ODC native merge normalizes it to the aggregate's Max. Records ("
                    + (kept != null ? kept + " in this job" : "the aggregate is not declared in this job") + "; 50 in every node observed), so the merged module would differ from the candidate.",
                ["fix"] = "Omit MaxRecords on the Refresh Data: it takes the Max. Records of " + target + " (the default); set Max. Records on the aggregate instead.",
                ["patch"] = new JsonArray(new JsonObject { ["op"] = "remove", ["path"] = pointer })
            };
        }
    }

    // The compact languages: a logic node step {node:"IRefreshDataNode", properties:{DataSource, MaxRecords}} anywhere in
    // the data, and an entity source of the html/screen data ({as, entity, max}) as an aggregate with its Max. Records.
    private static void Walk(JsonNode node, string pointer, int op, Dictionary<string, string> aggregates, List<(int, string, string, string?)> refreshes)
    {
        switch (node)
        {
            case JsonObject o:
                if (RefreshTypes.Contains(Text(o["node"]) ?? "") && o["properties"] is JsonObject properties && properties["MaxRecords"] is { } max)
                    refreshes.Add((op, pointer + "/properties/MaxRecords", Value(max) ?? "", AggregateName(Text(properties["DataSource"]))));
                if (Text(o["as"]) is { } name && o["entity"] is JsonValue && !o.ContainsKey("node"))
                    aggregates[name] = Value(o["max"]) ?? DefaultAggregateMaxRecords;
                foreach (var (key, child) in o) if (child != null) Walk(child, pointer + "/" + Escape(key), op, aggregates, refreshes);
                break;
            case JsonArray a:
                for (var i = 0; i < a.Count; i++) if (a[i] != null) Walk(a[i]!, pointer + "/" + i, op, aggregates, refreshes);
                break;
        }
    }

    // "IMobileScreen:Board/GetPeople", "IScreenAggregate:GetPeople" or "GetPeople": the aggregate is the last name.
    private static string? AggregateName(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference) || reference.StartsWith('$') || reference.StartsWith('@')) return null;
        var last = reference.Split('/').Last();
        var colon = last.IndexOf(':');
        return colon >= 0 ? last[(colon + 1)..] : last;
    }
    private static string? AggregateTarget(string target)
    {
        var last = target.Split('/').Last();
        var colon = last.IndexOf(':');
        return colon > 0 && AggregateTypes.Contains(last[..colon]) ? last[(colon + 1)..] : null;
    }
    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static string? Number(JsonNode? node)
    {
        if (node is not JsonValue v) return null;
        if (v.TryGetValue<long>(out var l)) return l.ToString(CultureInfo.InvariantCulture);
        if (v.TryGetValue<double>(out var d)) return d.ToString(CultureInfo.InvariantCulture);
        return v.TryGetValue<string>(out var s) && long.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed.ToString(CultureInfo.InvariantCulture) : null;
    }
    // A Max. Records as the job writes it: an integer (number or text) in its invariant form, else the expression text.
    private static string? Value(JsonNode? node) => Number(node) ?? (Text(node) is { } text && text.Trim().Length > 0 ? text.Trim() : null);
    private static bool Same(string a, string b) => string.Equals(a.Trim(), b.Trim(), StringComparison.Ordinal);
    private static string Escape(string key) => key.Replace("~", "~0").Replace("/", "~1");
}
