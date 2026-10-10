using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    private readonly HashSet<IObjectSignature> _replacementTargets = new(ReferenceEqualityComparer.Instance);

    // Capture after all ops: a following delete, rename or another replacement is intentional.
    // Preserve the final direct reference sets across serialization without claiming subtree rewiring.
    public JsonArray RefactorContract()
    {
        if (_replacementTargets.Count == 0) return new JsonArray();
        var alive = new KernelModelReader().Walk(_es).Concat(Descendants()).Select(n => n.ObjectKey!.ToString()!).ToHashSet(StringComparer.Ordinal);
        var assertions = new JsonArray();
        foreach (var target in _replacementTargets.OrderBy(t => t.ObjectKey!.ToString(), StringComparer.Ordinal)) {
            var key = target.ObjectKey!.ToString()!;
            var exists = alive.Contains(key);
            assertions.Add(new JsonObject { ["key"] = key, ["exists"] = exists,
                ["consumers"] = exists ? DirectConsumerKeys(target) : new JsonArray() });
        }
        return assertions;
    }

    private JsonArray DirectConsumerKeys(IObjectSignature target) => new(Consumers(target)
        .Where(c => !IsDerived(c.Referer, c.Path)).Select(c => ((IObjectSignature)c.Referer).ObjectKey!.ToString()!)
        .Distinct(StringComparer.Ordinal).OrderBy(k => k, StringComparer.Ordinal).Select(k => (JsonNode)JsonValue.Create(k)!).ToArray());

    public JsonObject CheckRefactorContract(JsonArray assertions)
    {
        var objects = new KernelModelReader().Walk(_es).Concat(Descendants()).GroupBy(n => n.ObjectKey!.ToString()!)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var differences = new JsonArray();
        foreach (var assertion in assertions.OfType<JsonObject>()) {
            var key = assertion["key"]!.GetValue<string>(); var exists = objects.TryGetValue(key, out var target);
            var actual = exists ? DirectConsumerKeys(target!) : new JsonArray();
            if (exists != assertion["exists"]!.GetValue<bool>() || !JsonNode.DeepEquals(actual, assertion["consumers"]))
                differences.Add(new JsonObject { ["key"] = key, ["expected"] = assertion.DeepClone(),
                    ["exists"] = exists, ["consumers"] = actual });
        }
        return new JsonObject { ["accepted"] = differences.Count == 0, ["targets"] = assertions.Count,
            ["scope"] = "final-direct-external-nonderived-reference-sets-after-save-reload", ["differences"] = differences };
    }
}
