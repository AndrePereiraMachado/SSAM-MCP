using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>Incomplete element-hash verification follows a producer capture through caching and delivery.</summary>
public static class ProducerHashWarnings
{
    public const string Code = "PRODUCER_HASH_UNVERIFIED";

    public static JsonArray Create(string producer, IEnumerable<string>? hashes, JsonArray? elements = null)
    {
        var keys = (hashes ?? []).Distinct(StringComparer.Ordinal).OrderBy(k => k, StringComparer.Ordinal).ToArray();
        if (keys.Length == 0) return [];
        var affected = new JsonArray(keys.Select(key => {
            var element = elements?.OfType<JsonObject>().FirstOrDefault(e => (e["originalKey"] ?? e["key"])?.ToString() == key);
            return (JsonNode)new JsonObject { ["key"] = key, ["name"] = element?["name"]?.DeepClone(), ["path"] = element?["path"]?.DeepClone() };
        }).ToArray());
        return [new JsonObject {
            ["code"] = Code, ["severity"] = "high", ["owner"] = producer,
            ["message"] = $"the producer signature uses an older element order; {keys.Length} element hashes could not be re-derived and were accepted unverified",
            ["elements"] = affected,
            ["fix"] = "Publish the producer with the current element order and capture its signature again to verify these element hashes."
        }];
    }

    // Old cache receipts may have only hashUnverified. Reconstruct their warning instead of silently upgrading trust.
    public static JsonArray OfReceipt(string producer, JsonObject receipt)
    {
        var warnings = (receipt["highWarnings"] as JsonArray)?.DeepClone().AsArray() ?? [];
        if (warnings.OfType<JsonObject>().Any(w => (w["code"] ?? w["id"])?.ToString() == Code)) return warnings;
        var elements = new JsonArray((receipt["elements"] as JsonArray ?? []).Concat(receipt["closure"] as JsonArray ?? [])
            .Select(e => e?.DeepClone()).ToArray());
        foreach (var warning in Create(producer, (receipt["hashUnverified"] as JsonArray)?.Select(k => k!.ToString()), elements))
            warnings.Add(warning?.DeepClone());
        return warnings;
    }

    public static JsonArray OfCaptures(JsonObject? captures)
    {
        var warnings = new JsonArray();
        foreach (var pair in captures ?? new JsonObject())
            if (pair.Value is JsonObject receipt)
                foreach (var warning in OfReceipt(receipt["producer"]?.ToString() ?? pair.Key, receipt))
                    warnings.Add(warning?.DeepClone());
        return warnings;
    }

    /// <summary>Record before saving a capture too, so a later refusal cannot hide incomplete verification.</summary>
    public static void Record(JsonObject state)
    {
        var high = QueryInLoopRule.HighWarnings(OfCaptures(state["capturedProducers"] as JsonObject));
        foreach (var field in new[] { "warnings", "highWarnings" })
        {
            var list = state[field] as JsonArray;
            if (list == null && high.Count == 0) continue;
            if (list == null) state[field] = list = new JsonArray();
            for (var i = list.Count - 1; i >= 0; i--)
                if ((list[i]?["id"] ?? list[i]?["code"])?.ToString() == Code) list.RemoveAt(i);
            foreach (var warning in high) list.Add(warning?.DeepClone());
        }
    }
}