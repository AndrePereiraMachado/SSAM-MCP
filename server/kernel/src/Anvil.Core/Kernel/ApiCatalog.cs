using System.Text.Json.Nodes;
namespace Anvil.Core;

/// <summary>Checked-in metadata, available without loading a Studio runtime.</summary>
public static class ApiCatalog
{
    private static readonly Lazy<JsonObject?> Default = new(() => {
        var root = JobRunner.RepoRoot(Environment.CurrentDirectory) ?? JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ApiCatalog).Assembly.Location)!);
        var path = root == null ? null : Directory.GetFiles(Path.Combine(root, "catalog"), "model-api-*.json").OrderDescending().FirstOrDefault();
        return path == null ? null : JsonNode.Parse(File.ReadAllText(path))!.AsObject();
    });
    public static JsonObject? Data => Default.Value;
    public static JsonObject? Enum(string name, JsonObject? catalog = null) => (catalog ?? Data)?["Enums"]?.AsArray()
        .OfType<JsonObject>().FirstOrDefault(e => string.Equals(e["Name"]?.ToString(), name.Split('.').Last(), StringComparison.OrdinalIgnoreCase));
    private static readonly Lazy<JsonObject?> PluginEnums = new(() => {
        var root = JobRunner.RepoRoot(Environment.CurrentDirectory) ?? JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ApiCatalog).Assembly.Location)!);
        var path = root == null ? null : Directory.GetFiles(Path.Combine(root, "catalog"), "ui-plugin-enums-*.json").OrderDescending().FirstOrDefault();
        return path == null ? null : JsonNode.Parse(File.ReadAllText(path))!.AsObject();
    });
    /// <summary>The values of an enum. A qualified name must match the namespace too: ServiceStudio.Plugin.NRWidgets.Enumerations.InputType
    /// (Text..Time..Search) is not OutSystems.Model.Enumerations.InputType (Text, Number, Email, Search). A UI plugin enum the model
    /// catalog does not carry comes from ui-plugin-enums; one found in neither is null, so no value is refused on a guess.</summary>
    public static string[]? EnumValues(string name)
    {
        var dot = name.LastIndexOf('.');
        if (dot < 0) return Enum(name)?["Values"]?.AsArray().Select(x => x!.ToString()).ToArray();
        if (PluginEnums.Value?[name] is JsonArray plugin) return plugin.Select(x => x!.ToString()).ToArray();
        var model = Enum(name);
        return model != null && string.Equals(model["Namespace"]?.ToString(), name[..dot], StringComparison.Ordinal)
            ? model["Values"]?.AsArray().Select(x => x!.ToString()).ToArray() : null;
    }
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, JsonObject[]> PropertyCache = new();
    public static IEnumerable<JsonObject> Properties(string type) => PropertyCache.GetOrAdd(type, t => Properties(t, new HashSet<string>()).ToArray());
    private static IEnumerable<JsonObject> Properties(string type, HashSet<string> seen)
    {
        if (!seen.Add(type) || Data == null) yield break;
        foreach (var hit in Data["Interfaces"]!.AsArray().OfType<JsonObject>().Where(i =>
            i["Name"]!.ToString() == type || i["Name"]!.ToString().Split('.').Last() == type))
        {
            foreach (var p in hit["Properties"]!.AsArray().OfType<JsonObject>()) yield return p;
            foreach (var b in hit["Bases"]!.AsArray())
                foreach (var p in Properties(b!.ToString(), seen)) yield return p;
        }
    }
    public static string? PropertyType(string type, string property) => Properties(type)
        .FirstOrDefault(p => p["Name"]!.ToString() == property)?["Type"]?.ToString();
}
