using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12), class C14 (text written as an expression; Haiku_CS: static record Limpeza, Nome "Limpeza pos-obra",
/// ParserUnexpectedElement 'pos' at the Verify): a value of a text attribute of a static record, or the default of a text
/// attribute of the spec, takes only a literal. A value with no quote that is no expression at all is the text it says: the
/// job's own value is written as the text literal and listed (TEXT_LITERAL_QUOTED). A bare word stays the business of
/// JobPreflight.LiteralFix (SpecExpander writes it quoted, as before); an expression, or a text with quotes of its own,
/// stays as written.
/// </summary>
public static class SpecTexts
{
    public const string Rule = "TEXT_LITERAL_QUOTED";

    private static readonly HashSet<string> RecordKeys = new(StringComparer.Ordinal) { "name", "label", "id", "order", "Id", "Label", "Order" };

    public static void Normalize(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "spec" || op["data"] is not JsonObject data) continue;
            foreach (var section in new[] { "entities", "clientEntities", "structures", "static" })
            {
                if (data[section] is not JsonArray records) continue;
                for (var s = 0; s < records.Count; s++)
                {
                    if (records[s] is not JsonObject record) continue;
                    var types = new Dictionary<string, string>(StringComparer.Ordinal);
                    var attributes = record["attributes"] as JsonArray ?? new JsonArray();
                    for (var a = 0; a < attributes.Count; a++)
                    {
                        if (attributes[a] is not JsonObject attribute || attribute["name"]?.ToString() is not { Length: > 0 } name) continue;
                        var type = attribute["type"]?.ToString() ?? "Text";
                        types[name] = type;
                        Quote(attribute, "default", type, prefix == null ? null : $"{prefix}/{i}/data/{section}/{s}/attributes/{a}/default", $"the default of {record["name"]}.{name}", done);
                    }
                    if (section != "static" || record["records"] is not JsonArray rows) continue;
                    for (var r = 0; r < rows.Count; r++)
                        if (rows[r] is JsonObject row)
                            foreach (var key in row.Select(kv => kv.Key).Where(k => !RecordKeys.Contains(k) && types.ContainsKey(k)).ToList())
                                Quote(row, key, types[key], prefix == null ? null : $"{prefix}/{i}/data/static/{s}/records/{r}/{key}", $"{record["name"]} record {row["name"]}: {key}", done);
                }
            }
        }
    }

    private static void Quote(JsonObject holder, string key, string type, string? path, string what, List<JsonObject> done)
    {
        if (holder[key] is not JsonValue v || !v.TryGetValue<string>(out var text)) return;
        if (JobPreflight.LiteralFix(type, text) != null || SpecExpander.TextNoExpression(type, text) is not { } literal) return;
        holder[key] = literal;
        done.Add(JobNormalizer.Entry(Rule, path, text, literal, $"{what} ({type}) takes only a literal, and '{text}' is no expression: it is the text it says"));
    }
}
