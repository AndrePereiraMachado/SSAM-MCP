using System.Text.Json.Nodes;

namespace Anvil.CSharp;

/// <summary>Frozen authored files, not a binding or operation manifest.</summary>
public static class SourceBundle
{
    public static IReadOnlyDictionary<string, string> From(JsonNode source)
    {
        if (source is JsonValue value && value.TryGetValue<string>(out var text))
            return new Dictionary<string,string> { ["source.cs"] = text };
        if (source is not JsonObject obj || obj.Count != 1 || obj["files"] is not JsonObject files || files.Count == 0)
            throw new ArgumentException("C# source is text or an object containing authored files");
        return files.ToDictionary(p => p.Key, p => p.Value is JsonValue file && file.TryGetValue<string>(out var content) ? content
            : throw new ArgumentException("C# source file must contain text: " + p.Key), StringComparer.Ordinal);
    }
    public static JsonObject Read(string path) => new()
    {
        ["files"] = new JsonObject { [Path.GetFileName(path)] = File.ReadAllText(path) }
    };
    public static JsonObject Canonical(JsonNode source) => new()
    {
        ["files"] = new JsonObject(From(source).OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, (JsonNode?)JsonValue.Create(p.Value))))
    };
    public static JsonObject Schema() => new()
    {
        ["oneOf"] = new JsonArray(new JsonObject { ["type"] = "string" }, new JsonObject { ["type"] = "object",
            ["properties"] = new JsonObject { ["files"] = new JsonObject { ["type"] = "object", ["additionalProperties"] = new JsonObject { ["type"] = "string" } } },
            ["required"] = new JsonArray("files"), ["additionalProperties"] = false }),
        ["description"] = "Author C# classes/records with Entity, fixed catalogs with enums or StaticEntity records, and concrete static methods for server/service logic. Files are bound together semantically. Current logic translation includes typed parameters/results, scalar expressions, assignments, forward calls/overloads, if/ternary, switch statements/expressions with constant/relational patterns and guarded labels, for/while/foreach, lexical continue/break/return, typed throws and record/list construction. Public methods generate authenticated server access; ServiceAction and Authorize express endpoint kind and roles. Unsupported source semantics are diagnosed at their source location. IDataSession supplies typed Insert/Update/Delete and LINQ Where/Select/Join/GroupBy/OrderBy/ThenBy/Skip/Take/First/Single/Any/Count/ToList. Query operator order is preserved in generated SQL; published database execution remains a separate proof obligation. Projected groups support keys and aggregates; outer joins, nested group lists, more overloads, mutable reference effects, async and general .NET APIs remain incomplete. No jobs, graphs, native expressions or separate bindings are authored."
    };
}
