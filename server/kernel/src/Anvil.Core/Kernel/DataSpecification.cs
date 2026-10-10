using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Data contract uses the existing spec vocabulary; jobs and operational checks are not contract inputs.</summary>
public static class DataSpecification
{
    public static JsonObject Read(string path)
    {
        var document = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var unknown = document.Select(p => p.Key).Except(new[] { "data", "expectedMessages", "description" }).ToArray();
        if (unknown.Length > 0) throw new ArgumentException("Data contract accepts data, expectedMessages and description; unknown: " + string.Join(", ", unknown));
        var data = document["data"]?.AsObject() ?? throw new ArgumentException("Data contract requires a data specification");
        Validate(data);
        MessageExpectations.Read(document, path);
        return document;
    }

    public static void Validate(JsonObject data)
    {
        if (!data.Any(p => p.Value is JsonArray { Count: > 0 })) throw new ArgumentException("Data contract cannot be empty");
        JobPreflight.Validate(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = data.DeepClone() }));
    }
}
