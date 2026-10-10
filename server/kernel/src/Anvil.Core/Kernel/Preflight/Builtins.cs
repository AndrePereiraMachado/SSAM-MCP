using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>A built-in function of the expressions as the preflight judges a call: how many arguments it takes, what it
/// returns and whether the database runs it (server and client aggregates).</summary>
public sealed record BuiltinFact(string Name, string Signature, string ReturnType, int Required, int Total, bool ServerAggregates, bool ClientAggregates);

/// <summary>
/// The built-ins of the lane: the Studio's own registry (<see cref="FunctionCatalog"/>) when the lane's Studio is bound,
/// otherwise, in the O11 lane only, the newest checked-in kernel/catalog/functions-*.json. Null when neither is
/// available: then no rule that needs them judges anything.
/// </summary>
public static class Builtins
{
    private static readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, BuiltinFact>?> Cache = new(StringComparer.Ordinal);

    public static IReadOnlyDictionary<string, BuiltinFact>? For(string lane) => Cache.GetOrAdd(lane, l => Studio() ?? (l == "o11" ? Checked() : null));

    public static BuiltinFact? Get(string name, string lane) => For(lane) is { } all && all.TryGetValue(name, out var fact) ? fact : null;

    private static IReadOnlyDictionary<string, BuiltinFact>? Studio()
    {
        try
        {
            var all = FunctionCatalog.All;
            if (all.Count == 0) return null;
            return all.GroupBy(f => f.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g =>
            {
                var f = g.First();
                return new BuiltinFact(f.Name, f.Signature, f.ReturnType, f.Parameters.Count(p => !p.Optional), f.Parameters.Count, f.ServerAggregates, f.ClientAggregates);
            }, StringComparer.OrdinalIgnoreCase);
        }
        catch { return null; }   // no Studio bound in this process
    }

    private static IReadOnlyDictionary<string, BuiltinFact>? Checked()
    {
        try
        {
            var root = JobRunner.RepoRoot(Environment.CurrentDirectory) ?? JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Builtins).Assembly.Location)!);
            var path = root == null ? null : Directory.GetFiles(Path.Combine(root, "catalog"), "functions-*.json").OrderDescending().FirstOrDefault();
            if (path == null) return null;
            var functions = JsonNode.Parse(File.ReadAllText(path))?["Functions"] as JsonArray;
            if (functions == null) return null;
            var result = new Dictionary<string, BuiltinFact>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in functions.OfType<JsonObject>())
            {
                var name = f["Name"]?.ToString();
                if (string.IsNullOrEmpty(name) || result.ContainsKey(name)) continue;
                var parameters = f["Parameters"] as JsonArray ?? new JsonArray();
                result[name] = new BuiltinFact(name, f["Signature"]?.ToString() ?? name, f["ReturnType"]?.ToString() ?? "",
                    parameters.Count(p => p?["Optional"]?.GetValue<bool>() != true), parameters.Count,
                    f["ServerAggregates"]?.GetValue<bool>() == true, f["ClientAggregates"]?.GetValue<bool>() == true);
            }
            return result;
        }
        catch { return null; }
    }
}
