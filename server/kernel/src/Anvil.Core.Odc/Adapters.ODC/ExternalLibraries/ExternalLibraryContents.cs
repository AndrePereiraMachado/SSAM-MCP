using System.Text.Json.Nodes;

namespace Anvil.Core.ExternalLibraries;

/// <summary>
/// The contents of an External Library in one shape, whatever the source: the spec (the plan), the answer of the
/// generation operation (GET /generation-operations/{key}/contents: actions with parameters, structures with
/// attributes, each with the server's changeType), or a contents document written before. Diff compares two of them:
/// Added, Removed and Updated actions and structures (an Updated one names what changed: a parameter or attribute
/// added, removed, moved between input and output, or retyped). Removed and Updated are what breaks a consumer (D9).
/// </summary>
public static class ExternalLibraryContents
{
    public static JsonObject FromSpec(ExternalLibrarySpec spec) => new()
    {
        ["actions"] = new JsonArray(spec.Actions.Select(a => (JsonNode)new JsonObject
        {
            ["name"] = a.Name,
            ["parameters"] = new JsonArray(a.Inputs.Select(p => Parameter(p.Name, p.Type, "Input"))
                .Concat(a.Outputs.Select(p => Parameter(p.Name, p.Type, "Output"))).ToArray()),
        }).ToArray()),
        ["structures"] = new JsonArray(spec.Structures.Select(s => (JsonNode)new JsonObject
        {
            ["name"] = s.Name,
            ["attributes"] = new JsonArray(s.Attributes.Select(a => (JsonNode)new JsonObject { ["name"] = a.Name, ["dataType"] = a.Type }).ToArray()),
        }).ToArray()),
    };

    /// <summary>A spec, a contents document or a generation contents answer, as a contents document.</summary>
    public static JsonObject Normalize(JsonNode? node)
    {
        if (node is JsonObject o && o["actions"] is JsonArray actions && actions.OfType<JsonObject>().Any(a => a["body"] != null))
            return FromSpec(ExternalLibrarySpec.Parse(node));
        var result = new JsonObject { ["actions"] = new JsonArray(), ["structures"] = new JsonArray() };
        foreach (var a in (node?["actions"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var entry = new JsonObject { ["name"] = Text(a, "name"), ["parameters"] = new JsonArray(
                (a["parameters"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(p => Parameter(Text(p, "name"), Text(p, "dataType"), Direction(p))).ToArray()) };
            if (Text(a, "changeType") is { } change) entry["changeType"] = change;
            result["actions"]!.AsArray().Add(entry);
        }
        foreach (var s in (node?["structures"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var entry = new JsonObject { ["name"] = Text(s, "name"), ["attributes"] = new JsonArray(
                (s["attributes"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(a => (JsonNode)new JsonObject { ["name"] = Text(a, "name"), ["dataType"] = Text(a, "dataType") }).ToArray()) };
            if (Text(s, "changeType") is { } change) entry["changeType"] = change;
            result["structures"]!.AsArray().Add(entry);
        }
        return result;
    }

    /// <summary>What the zip carries: entries, the .deps.json and its runtime target, the main assembly.</summary>
    public static JsonObject FromPackage(byte[] zip, long maxBytes = ExternalLibraryPackage.MaxBytes) => ExternalLibraryPackage.Inspect(zip, maxBytes).ToJson();

    public static JsonObject Diff(JsonNode? before, JsonNode? after)
    {
        var a = Normalize(before); var b = Normalize(after);
        var added = new JsonArray(); var removed = new JsonArray(); var updated = new JsonArray(); var unchanged = 0;
        foreach (var (kind, list, members) in new[] { ("action", "actions", "parameters"), ("structure", "structures", "attributes") })
        {
            var left = Index(a[list]); var right = Index(b[list]);
            foreach (var (name, entry) in left)
            {
                if (!right.TryGetValue(name, out var other)) { removed.Add(new JsonObject { ["kind"] = kind, ["name"] = Text(entry, "name") }); continue; }
                var changes = MemberChanges(entry[members], other[members], kind == "action");
                if (changes.Count == 0) unchanged++;
                else updated.Add(new JsonObject { ["kind"] = kind, ["name"] = Text(other, "name"), ["changes"] = changes });
            }
            foreach (var (name, entry) in right)
                if (!left.ContainsKey(name)) added.Add(new JsonObject { ["kind"] = kind, ["name"] = Text(entry, "name") });
        }
        return new JsonObject { ["added"] = added, ["removed"] = removed, ["updated"] = updated, ["unchanged"] = unchanged,
            ["breaking"] = removed.Count > 0 || updated.Count > 0 };
    }

    private static JsonArray MemberChanges(JsonNode? before, JsonNode? after, bool parameters)
    {
        var changes = new JsonArray();
        var left = Index(before); var right = Index(after);
        foreach (var (name, entry) in left)
        {
            if (!right.TryGetValue(name, out var other)) { changes.Add(Text(entry, "name") + " removed"); continue; }
            if (parameters && !string.Equals(Text(entry, "direction"), Text(other, "direction"), StringComparison.OrdinalIgnoreCase))
                changes.Add(Text(other, "name") + " is now " + Text(other, "direction"));
            if (!SameType(Text(entry, "dataType"), Text(other, "dataType")))
                changes.Add(Text(other, "name") + " type " + Text(entry, "dataType") + " -> " + Text(other, "dataType"));
        }
        foreach (var (name, entry) in right)
            if (!left.ContainsKey(name)) changes.Add(Text(entry, "name") + " added");
        return changes;
    }
    /// <summary>Type names compared without spaces or case ("Long Integer" = LongInteger).</summary>
    public static bool SameType(string? a, string? b) => string.Equals(Key(a), Key(b), StringComparison.Ordinal);
    private static string Key(string? type) => (type ?? "").Replace(" ", "").ToLowerInvariant();
    private static Dictionary<string, JsonObject> Index(JsonNode? list)
    {
        var map = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in (list as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            if (Text(item, "name") is { } name) map.TryAdd(name, item);
        return map;
    }
    private static JsonNode Parameter(string? name, string? type, string direction) => new JsonObject { ["name"] = name, ["dataType"] = type, ["direction"] = direction };
    private static string Direction(JsonObject p) =>
        (Text(p, "direction") ?? Text(p, "parameterType")) is { } d && d.Equals("Output", StringComparison.OrdinalIgnoreCase) ? "Output" : "Input";
    private static string? Text(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
}
