using System.Text.Json.Nodes;

namespace Anvil.Xif;

/// <summary>
/// The public contract of an extension before and after an edit. Breaking (D9: the consumers must be named): an action
/// removed or renamed, a parameter or attribute removed or retyped, a new mandatory input, a structure removed, a function
/// that stops being one (or starts). Additive: a new action, a new optional input, a new output, a new structure or
/// attribute, a body or description change. Elements match by key when both sides have one, else by name (a key with a new
/// name is a rename).
/// </summary>
public static class XifContractDiff
{
    public static JsonObject Diff(XifDocument before, XifDocument after) => Diff(Contract(before), Contract(after));

    public static JsonObject Diff(XifContract before, XifContract after)
    {
        var changes = new List<JsonObject>();
        void Change(string kind, string kindOfElement, string name, string? key, bool breaking, string? detail = null)
        {
            var o = new JsonObject { ["change"] = kind, ["element"] = kindOfElement, ["name"] = name, ["breaking"] = breaking };
            if (key != null) o["key"] = key;
            if (detail != null) o["detail"] = detail;
            changes.Add(o);
        }

        foreach (var old in before.Structures)
        {
            var now = Match(after.Structures, old.Key, old.Name, s => s.Key, s => s.Name);
            if (now == null) { Change("removed", "structure", old.Name, old.Key, true); continue; }
            if (!string.Equals(now.Name, old.Name, StringComparison.Ordinal)) Change("renamed", "structure", old.Name, old.Key, true, "now " + now.Name);
            foreach (var attribute in old.Attributes)
            {
                var current = Match(now.Attributes, attribute.Key, attribute.Name, a => a.Key, a => a.Name);
                if (current == null) Change("removed", "attribute", old.Name + "." + attribute.Name, attribute.Key, true);
                else if (!string.Equals(current.Name, attribute.Name, StringComparison.Ordinal)) Change("renamed", "attribute", old.Name + "." + attribute.Name, attribute.Key, true, "now " + current.Name);
                else if (!SameType(current.Type, attribute.Type, before, after)) Change("retyped", "attribute", old.Name + "." + attribute.Name, attribute.Key, true, attribute.Type + " -> " + current.Type);
            }
            foreach (var added in now.Attributes.Where(a => Match(old.Attributes, a.Key, a.Name, x => x.Key, x => x.Name) == null))
                Change("added", "attribute", now.Name + "." + added.Name, added.Key, false);
        }
        foreach (var added in after.Structures.Where(s => Match(before.Structures, s.Key, s.Name, x => x.Key, x => x.Name) == null))
            Change("added", "structure", added.Name, added.Key, false);

        foreach (var old in before.Actions)
        {
            var now = Match(after.Actions, old.Key, old.Name, a => a.Key, a => a.Name);
            if (now == null) { Change("removed", "action", old.Name, old.Key, true); continue; }
            if (!string.Equals(now.Name, old.Name, StringComparison.Ordinal)) Change("renamed", "action", old.Name, old.Key, true, "now " + now.Name);
            if (now.IsFunction != old.IsFunction) Change("function", "action", old.Name, old.Key, true, old.IsFunction ? "no longer a function" : "now a function");
            var oldParameters = old.Inputs.Concat(old.Outputs).ToList();
            var newParameters = now.Inputs.Concat(now.Outputs).ToList();
            foreach (var parameter in oldParameters)
            {
                var current = Match(newParameters, parameter.Key, parameter.Name, p => p.Key, p => p.Name);
                var label = old.Name + "." + parameter.Name;
                if (current == null) Change("removed", parameter.IsInput ? "input" : "output", label, parameter.Key, true);
                else if (current.IsInput != parameter.IsInput) Change("direction", parameter.IsInput ? "input" : "output", label, parameter.Key, true, parameter.IsInput ? "now an output" : "now an input");
                else if (!string.Equals(current.Name, parameter.Name, StringComparison.Ordinal)) Change("renamed", parameter.IsInput ? "input" : "output", label, parameter.Key, true, "now " + current.Name);
                else if (!SameType(current.Type, parameter.Type, before, after)) Change("retyped", parameter.IsInput ? "input" : "output", label, parameter.Key, true, parameter.Type + " -> " + current.Type);
                else if (current.IsInput && current.Mandatory && !parameter.Mandatory) Change("mandatory", "input", label, parameter.Key, true, "now mandatory");
            }
            foreach (var added in newParameters.Where(p => Match(oldParameters, p.Key, p.Name, x => x.Key, x => x.Name) == null))
                Change("added", added.IsInput ? "input" : "output", now.Name + "." + added.Name, added.Key, added.IsInput && added.Mandatory, added.IsInput && added.Mandatory ? "a new mandatory input" : null);
            if (!string.Equals(Norm(old.Body), Norm(now.Body), StringComparison.Ordinal)) Change("body", "action", now.Name, now.Key, false);
        }
        foreach (var added in after.Actions.Where(a => Match(before.Actions, a.Key, a.Name, x => x.Key, x => x.Name) == null))
            Change("added", "action", added.Name, added.Key, false);

        var breaking = changes.Where(c => c["breaking"]!.GetValue<bool>()).ToList();
        // The elements whose consumers must be named: the action or structure that owns each breaking change.
        var elements = breaking.Select(c => Owner(c, before)).Where(e => e != null).GroupBy(e => e!["name"]!.ToString()).Select(g => (JsonNode)g.First()!).ToArray();
        return new JsonObject
        {
            ["breaking"] = breaking.Count > 0,
            ["changes"] = new JsonArray(changes.Select(c => (JsonNode)c).ToArray()),
            ["breakingElements"] = new JsonArray(elements),
        };
    }

    private static JsonObject? Owner(JsonObject change, XifContract before)
    {
        var name = change["name"]!.ToString();
        var head = name.Split('.')[0];
        var element = change["element"]!.ToString();
        if (element is "structure" or "attribute")
        {
            var s = before.Structures.FirstOrDefault(x => x.Name == head);
            return s == null ? null : new JsonObject { ["kind"] = "structure", ["name"] = s.Name, ["key"] = s.Key };
        }
        var a = before.Actions.FirstOrDefault(x => x.Name == head);
        return a == null ? null : new JsonObject { ["kind"] = "action", ["name"] = a.Name, ["key"] = a.Key };
    }

    private static T? Match<T>(IEnumerable<T> items, string? key, string name, Func<T, string?> keyOf, Func<T, string> nameOf) where T : class
    {
        var list = items.ToList();
        if (!string.IsNullOrEmpty(key) && list.FirstOrDefault(i => string.Equals(keyOf(i), key, StringComparison.OrdinalIgnoreCase)) is { } byKey) return byKey;
        return list.FirstOrDefault(i => (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(keyOf(i))) && string.Equals(nameOf(i), name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Two type names are the same type: equal primitives, or the same structure (renamed structures compare by key).</summary>
    private static bool SameType(string now, string old, XifContract before, XifContract after)
    {
        if (string.Equals(now, old, StringComparison.Ordinal)) return true;
        var listNow = now.EndsWith(" List", StringComparison.Ordinal); var listOld = old.EndsWith(" List", StringComparison.Ordinal);
        if (listNow != listOld) return false;
        var a = listNow ? now[..^5] : now; var b = listOld ? old[..^5] : old;
        var keyNow = after.Structures.FirstOrDefault(s => s.Name == a)?.Key; var keyOld = before.Structures.FirstOrDefault(s => s.Name == b)?.Key;
        return !string.IsNullOrEmpty(keyNow) && string.Equals(keyNow, keyOld, StringComparison.OrdinalIgnoreCase);
    }

    private static string Norm(string? body) => string.Join("\n", (body ?? "").Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0));

    public static XifContract Contract(XifDocument document) => new(document.Name, document.Structures, document.Actions);

    public static XifContract Contract(XifSpec spec) => new(spec.Name, spec.Structures, spec.Actions);

    /// <summary>The canonical contract (no bodies, no descriptions): the input of signatureHash.</summary>
    public static JsonObject Canonical(XifDocument document) => new()
    {
        ["name"] = document.Name,
        ["structures"] = new JsonArray(document.Structures.OrderBy(s => s.Name, StringComparer.Ordinal).Select(s => (JsonNode)new JsonObject
        {
            ["name"] = s.Name, ["key"] = s.Key,
            ["attributes"] = new JsonArray(s.Attributes.Select(a => (JsonNode)new JsonObject { ["name"] = a.Name, ["key"] = a.Key, ["type"] = a.Type, ["mandatory"] = a.Mandatory }).ToArray()),
        }).ToArray()),
        ["actions"] = new JsonArray(document.Actions.OrderBy(a => a.Name, StringComparer.Ordinal).Select(a => (JsonNode)new JsonObject
        {
            ["name"] = a.Name, ["key"] = a.Key, ["isFunction"] = a.IsFunction,
            ["parameters"] = new JsonArray(a.Inputs.Concat(a.Outputs).Select(p => (JsonNode)new JsonObject
            {
                ["name"] = p.Name, ["key"] = p.Key, ["type"] = p.Type, ["input"] = p.IsInput, ["mandatory"] = p.Mandatory,
            }).ToArray()),
        }).ToArray()),
    };
}

public sealed record XifContract(string Name, IReadOnlyList<XifStructure> Structures, IReadOnlyList<XifAction> Actions);
