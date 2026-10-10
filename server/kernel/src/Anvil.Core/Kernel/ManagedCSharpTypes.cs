using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    private HashSet<string> ReferencedManagedCSharpTypes()
    {
        var alreadyOrphaned=ObsoleteCSharpStructures(new JsonObject(),new JsonArray(),new JsonArray()).OfType<JsonObject>().Select(op=>op["target"]!.ToString()).ToHashSet();
        return ((IObjectSignature)_es).Children.OfType<IObjectSignature>().Where(type=>Implements(type,"IStructure") && ReferenceEquals(type.Parent,_es)
            && UIProperty(type,"Description")?.ToString()?.StartsWith("anvil:csharp sql schema\n",StringComparison.Ordinal)==true)
            .Select(type=>"@"+type.ObjectKey).Where(key=>!alreadyOrphaned.Contains(key)).ToHashSet();
    }
    private JsonArray OrphanedManagedCSharpTypes(HashSet<string> eligible)
    {
        // Existing orphans and types created in this transaction stay outside this lifecycle.
        var keep=new JsonArray(((IObjectSignature)_es).Children.OfType<IObjectSignature>().Where(type=>Implements(type,"IStructure") && !eligible.Contains("@"+type.ObjectKey))
            .Select(type=>(JsonNode)new JsonObject {["name"]=TypeResolver.Name(type)}).ToArray());
        return ObsoleteCSharpStructures(new JsonObject {["data"]=new JsonObject {["structures"]=keep}},new JsonArray(),new JsonArray());
    }
    private JsonArray ObsoleteCSharpStructures(JsonObject contract, JsonArray changes, JsonArray legacy)
    {
        const string prefix = "anvil:csharp sql schema\n";
        var desired = (contract["data"]?["structures"]?.AsArray() ?? []).Select(s=>s!["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var rebuilt = changes.OfType<JsonObject>().Select(a=>OwnedAction(a["name"]!.ToString(),a)).Where(a=>a!=null).ToArray();
        var result = new JsonArray();
        foreach (var structure in ((IObjectSignature)_es).Children.OfType<IObjectSignature>().Where(s=>Implements(s,"IStructure") && ReferenceEquals(s.Parent,_es)))
        {
            var name = TypeResolver.Name(structure)!;
            if (desired.Contains(name) || UIProperty(structure,"Public") is true) continue;
            var description = UIProperty(structure,"Description")?.ToString() ?? "";
            JsonObject? descriptor;
            try
            {
                descriptor = description.StartsWith(prefix,StringComparison.Ordinal)
                    ? JsonNode.Parse(description[prefix.Length..])?.AsObject()
                    : description.Length == 0 ? legacy.OfType<JsonObject>().SingleOrDefault(s=>s["name"]!.ToString()==name)?.DeepClone().AsObject() : null;
                if (descriptor == null || descriptor["name"]?.ToString()!=name || descriptor["public"]?.GetValue<bool>()!=false) continue;
                var fields = descriptor["attributes"]!.AsArray();
                var actual = structure.Children.Where(s=>Implements(s,"IStructureAttribute")).ToArray();
                if (actual.Length!=fields.Count) continue;
                if (actual.Any(field=>!string.IsNullOrEmpty(UIProperty(field,"Description")?.ToString())
                    || UIProperty(field,"DefaultValue") is IExpression value && !string.IsNullOrEmpty(value.Text))) continue;
                // A copied marker is insufficient: changing a field, default or description revokes ownership.
                var proof = CheckDataSpecification(new JsonObject { ["structures"] = new JsonArray(descriptor.DeepClone()) });
                if (!proof["accepted"]!.GetValue<bool>()) continue;
            }
            catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException) { continue; }
            if (UsedOutsideRebuild(structure,new HashSet<IObjectSignature>())) continue;
            // Anonymous record wrappers can outlive the old SQL node in runtime caches.
            // Their transitive consumers were checked above; Verify/recarga still gate the result.
            result.Add(new JsonObject { ["op"]="delete", ["target"]="@"+structure.ObjectKey, ["force"]=true });
        }
        return result;
        bool UsedOutsideRebuild(IObjectSignature target, HashSet<IObjectSignature> visited)
        {
            if (!visited.Add(target)) return false;
            foreach (var consumer in Consumers(target))
            {
                if (IsDerived(consumer.Referer,consumer.Path) || rebuilt.Any(a=>IsInside(consumer.Referer,a!))) continue;
                if (Implements(consumer.Referer,"IListType") && !UsedOutsideRebuild((IObjectSignature)consumer.Referer,visited)) continue;
                if (((IObjectSignature)consumer.Referer).Parent is IObjectSignature parent && Implements(parent,"IAnonymousStructure"))
                { if (!UsedOutsideRebuild(parent,visited)) continue; }
                return true;
            }
            return false;
        }
    }
}
