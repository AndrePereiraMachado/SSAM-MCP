using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Bridge;

/// <summary>Full bridge: the quoted names of a publish message resolved to the module elements of that name (kernel
/// model reading). The thin bridge has its own PublishLogResolver.cs that resolves nothing.</summary>
internal static partial class PublishLogHandler
{
    private static partial Func<string, JsonObject?>? ResolverFor(ESpace e) => Resolver(e);

    // Quoted names of a message -> the module element of that name (key, kind, path); several -> candidates.
    private static Func<string, JsonObject?> Resolver(ESpace e)
    {
        Dictionary<string, List<IObjectSignature>>? index = null;
        return name =>
        {
            index ??= Index(e);
            if (!index.TryGetValue(name, out var found) || found.Count == 0) return null;
            JsonObject Describe(IObjectSignature o) => new()
            {
                ["key"] = o.ObjectKey?.ToString(), ["kind"] = EntityIndexes.TypeName(o) ?? ModelHost.Kind(o.GetInterface()?.Name ?? o.GetType().Name),
                ["path"] = ModelHost.PathOf(o),
            };
            if (found.Count == 1) { var one = Describe(found[0]); one["name"] = name; one["source"] = "model"; return one; }
            return new JsonObject { ["name"] = name, ["source"] = "model", ["ambiguous"] = found.Count,
                ["candidates"] = new JsonArray(found.Take(3).Select(o => (JsonNode)Describe(o)).ToArray()) };
        };
    }

    private static Dictionary<string, List<IObjectSignature>> Index(ESpace e)
    {
        var index = new Dictionary<string, List<IObjectSignature>>(StringComparer.OrdinalIgnoreCase);
        foreach (var o in EntityIndexes.IncludeNative(((IObjectSignature)e).GetAllDescendantsOfType<IObjectSignature>()))
        {
            if (ModelHost.Prop(o, "Name") is not string n || n.Length == 0) continue;
            if (!index.TryGetValue(n, out var list)) index[n] = list = [];
            list.Add(o);
        }
        return index;
    }
}
