using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    /// <summary>Compile the same declaration against a snapshot; bind existing objects instead of creating numbered copies.</summary>
    public JsonArray PlanDataSpecification(JsonObject specification)
    {
        // Read the declared model before expanding mutations. Reapplying an identical
        // contract must not rewrite identities, defaults or static record values.
        if (CheckDataSpecification(specification)["accepted"]!.GetValue<bool>()) return new JsonArray();
        var result = new JsonArray();
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        var pending = new HashSet<string>(StringComparer.Ordinal);
        foreach (var original in SpecExpander.Expand(specification))
        {
            var op = Rewrite(original).AsObject();
            if (op["op"]?.ToString() != "create") { result.Add(op); continue; }
            var parentReference = op["parent"]!.ToString();
            var parentAlias = parentReference.Split('/')[0];
            if (pending.Contains(parentAlias)) { Keep(); continue; }
            var parent = (IObjectSignature)Resolve(parentReference);
            var name = op["name"]?.ToString(); var kind = op["type"]!.ToString();
            var candidates = kind == "EntityIndex" ? EntityIndexes.IncludeNative(new[] { parent }).Where(o => EntityIndexes.TypeName(o) == kind)
                : parent.Children.OfType<IObjectSignature>().Where(o => Implements(o, kind));
            var existing = candidates.Where(o => string.Equals(TypeResolver.Name(o), name, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (existing.Length > 1) throw new InvalidOperationException("Ambiguous existing declaration: " + kind + ":" + name);
            if (existing.Length == 0) { Keep(); continue; }
            var target = existing[0]; var reference = "@" + target.ObjectKey;
            if (op["as"] is { } alias) aliases[alias.ToString()] = reference;
            if (kind == "EntityIndex")
            {
                var wanted = original["args"]!["attributes"]!.AsArray().Select(a => a!.ToString().Split('.').Last()).ToArray();
                var actual = EntityIndexes.Read(target)!["properties"]!["Attributes"]!.AsArray().Select(a => a!.ToString()).ToArray();
                if (!wanted.SequenceEqual(actual))
                {
                    result.Add(new JsonObject { ["op"] = "delete", ["target"] = reference });
                    result.Add(op);
                }
                else if (EntityIndexes.Read(target)!["properties"]!["Unique"]!.GetValue<bool>() != (op["args"]?["unique"]?.GetValue<bool>() ?? false)) result.Add(new JsonObject { ["op"] = "set", ["target"] = reference, ["prop"] = "Unique", ["value"] = op["args"]?["unique"]?.DeepClone() ?? JsonValue.Create(false) });
            }
            void Keep()
            {
                result.Add(op);
                if (op["as"] is { } alias) pending.Add(alias.ToString());
            }
        }
        return result;

        JsonNode Rewrite(JsonNode node)
        {
            if (node is JsonObject obj) return new JsonObject(obj.Select(p => KeyValuePair.Create(p.Key, p.Value == null ? null : p.Key == "as" ? p.Value.DeepClone() : Rewrite(p.Value))));
            if (node is JsonArray array) return new JsonArray(array.Select(n => n == null ? null : Rewrite(n)).ToArray());
            if (node is JsonValue value && value.TryGetValue<string>(out var text))
            {
                var slash = text.IndexOf('/'); var alias = slash < 0 ? text : text[..slash];
                if (aliases.TryGetValue(alias, out var reference)) return JsonValue.Create(reference + (slash < 0 ? "" : text[slash..]))!;
            }
            return node.DeepClone();
        }
    }
}
