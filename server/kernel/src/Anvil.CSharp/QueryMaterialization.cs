using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private sealed record QueryIdentityCache(SourceValue Map, string Column, ValueType Type);

    private Dictionary<object, QueryIdentityCache> PrepareQueryIdentities(SqlShape shape,
        List<(string Name, string Type)> columns, List<string> expressions, JsonArray steps, IOperation location)
    {
        var result = new Dictionary<object, QueryIdentityCache>(ReferenceEqualityComparer.Instance);
        void Visit(SqlShape current)
        {
            var type = Type(current.Source);
            if (current.Value == null && type.IsArenaReference)
            {
                var origin = current.Origin ?? throw Unsupported(location, "A reference query projection needs source occurrence identity");
                if (origin.Keys.Count == 0) throw Unsupported(location, "Query identity requires represented occurrence keys");
                if (!result.ContainsKey(origin.Token))
                {
                    var column = "AvOrigin" + result.Count;
                    columns.Add((column, "Integer"));
                    // Ranks are dense within this terminal's rows, not persistent entity IDs.
                    // Separate query evaluations allocate separate maps and detached objects.
                    expressions.Add("DENSE_RANK() OVER (ORDER BY " + string.Join(", ", origin.Keys.Select(k => k.Render())) + ") AS " + column);
                    result.Add(origin.Token, new(QueryList(type, steps), column, type));
                }
            }
            foreach (var (_, child) in current.Members ?? []) Visit(child);
        }
        Visit(shape); return result;
    }

    private SourceValue ReadQueryIdentity(QueryIdentityCache cache, string row, JsonArray steps)
    {
        var ordinal = row + "." + cache.Column;
        var empty = Temp(cache.Type);
        var extend = new JsonArray(); QueryAppend(cache.Map.Text, empty.Text, extend);
        steps.Add(new JsonObject { ["while"] = cache.Map.Text + ".Length < " + ordinal, ["do"] = extend });
        var result = Temp(cache.Type);
        Assign(steps, result.Text, cache.Map.Text + "[" + ordinal + " - 1]"); return result;
    }
}
