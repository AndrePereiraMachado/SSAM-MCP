using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The attribute names of the store's fields, chosen before anything reads the capture (docs/PROTOTIPO-NATIVO.md 1.6, 3.4, 3.5).
/// The Model API compares attribute names ignoring case and renames a newcomer that collides (label next to the Label of a
/// static entity became label2, 2026-10-12), so every entity gets a name scope (<see cref="PrototypeNameScope"/>, case-insensitive)
/// that reserves its key, the built-in Label and Order of a static entity and every one of its fields, in the order of the
/// collection:
/// <list type="bullet">
/// <item>a field of a static entity called label or order in any case IS the built-in attribute: its values go to Label/Order;</item>
/// <item>a field that collides with another one of the same entity (Name and name) or with a built-in gets the first free
/// &lt;field&gt;2, &lt;field&gt;3... free in every entity that has that field, so one field name maps to one attribute name in the whole
/// capture;</item>
/// <item>mapping.names "&lt;Entity&gt;/&lt;field&gt;" (the collection, its entity stem or the prefixed entity name) gives the attribute
/// instead, and the generated one stays reserved.</item>
/// </list>
/// The capture as written is then read with those names everywhere it names a field (the store, the rows, the references, every
/// field/via of a value, the effect field maps, the options sources, the extra attributes, the snapshot lists): every reference
/// of the compile goes through the same map. The canonical hash stays the facade's (taken before this).
/// </summary>
public static class PrototypeFieldNames
{
    public static readonly string[] BuiltIns = ["Label", "Order"];

    /// <summary>The capture with the attribute names, and what was renamed ([{collection, field, attribute, why}]).</summary>
    public sealed record Result(JsonObject Ir, JsonArray Renamed, IReadOnlyDictionary<string, string> Map);

    private sealed record Group(string Name, bool Static, string? Key, List<string> Fields);

    public static Result Canonicalize(JsonObject raw, JsonObject? names, string prefix)
    {
        var groups = Groups(raw);
        var renamed = new JsonArray();
        var map = Choose(groups, names, prefix, renamed);
        if (map.Count == 0) return new Result(raw, renamed, map);
        var ir = raw.DeepClone().AsObject();
        Rewrite(ir, map);
        return new Result(ir, renamed, map);
    }

    /// <summary>The store collections (static when nothing writes them and they reference no regular one, the planner's rule)
    /// and the snapshot lists (static entities of the slots of a list no collection explains).</summary>
    private static List<Group> Groups(JsonObject raw)
    {
        var collections = PrototypeCapture.Objects(raw["store"]?["collections"]);
        var regular = new HashSet<string>(collections.Where(c => c["mutated"] is JsonValue m && m.TryGetValue<bool>(out var b) && b).Select(c => c["name"]?.ToString() ?? ""), StringComparer.Ordinal);
        for (var changed = true; changed;)
        {
            changed = false;
            foreach (var c in collections)
            {
                var name = c["name"]?.ToString() ?? "";
                if (regular.Contains(name)) continue;
                if (PrototypeCapture.Objects(c["references"]).Any(r => r["collection"]?.ToString() is { } t && regular.Contains(t))) { regular.Add(name); changed = true; }
            }
        }
        var groups = new List<Group>();
        foreach (var c in collections)
        {
            var name = c["name"]?.ToString() ?? "";
            var key = c["key"]?.ToString();
            var fields = PrototypeCapture.Objects(c["fields"]).Select(f => f["name"]?.ToString()).OfType<string>().ToList();
            if (key != null && key != "#" && fields.Remove(key)) fields.Insert(0, key);
            groups.Add(new Group(name, !regular.Contains(name), key == "#" ? null : key, fields));
        }
        foreach (var root in Roots(raw))
            Walk(root, node =>
            {
                if (node["list"]?["snapshot"] is JsonObject snapshot && snapshot["entity"]?.ToString() is { } entity)
                    groups.Add(new Group(entity, true, null, PrototypeCapture.Objects(snapshot["attributes"]).Select(a => a["name"]?.ToString()).OfType<string>().ToList()));
            });
        return groups;
    }

    private static IEnumerable<JsonObject> Roots(JsonObject raw)
    {
        if (raw["shell"]?["root"] is JsonObject shell) yield return shell;
        foreach (var v in PrototypeCapture.Objects(raw["views"])) if (v["root"] is JsonObject r) yield return r;
        foreach (var m in PrototypeCapture.Objects(raw["modals"])) if (m["root"] is JsonObject r) yield return r;
    }

    private static void Walk(JsonObject node, Action<JsonObject> visit)
    {
        visit(node);
        foreach (var c in node["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o, visit);
        if (node["list"]?["template"] is JsonObject t) Walk(t, visit);
        if (node["else"] is JsonObject e) Walk(e, visit);
        foreach (var e2 in node["else"] as JsonArray ?? []) if (e2 is JsonObject o2) Walk(o2, visit);
    }

    /// <summary>Whether a mapping.names owner names this group: the collection, its entity stem or the prefixed entity (with a
    /// trailing number when the planner had to number it), ignoring case.</summary>
    internal static bool Owns(string owner, string group, string prefix)
    {
        var bare = owner.TrimEnd('0', '1', '2', '3', '4', '5', '6', '7', '8', '9');
        foreach (var candidate in new[] { owner, bare })
        {
            if (string.Equals(candidate, group, StringComparison.OrdinalIgnoreCase)) return true;
            var stem = PrototypeNames.EntityStem(group);
            if (string.Equals(candidate, stem, StringComparison.OrdinalIgnoreCase) || string.Equals(candidate, prefix + stem, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static Dictionary<string, string> Choose(List<Group> groups, JsonObject? names, string prefix, JsonArray renamed)
    {
        // the requested attribute of each field (mapping.names "<Entity>/<field>"), in any group that has the field
        var requested = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in names ?? [])
        {
            if (value is not JsonValue v || !v.TryGetValue<string>(out var to) || string.IsNullOrWhiteSpace(to)) continue;
            var slash = key.LastIndexOf('/');
            if (slash <= 0) continue;
            var owner = key[..slash]; var field = key[(slash + 1)..];
            foreach (var g in groups.Where(g => Owns(owner, g.Name, prefix)))
                foreach (var f in g.Fields.Where(f => string.Equals(f, field, StringComparison.OrdinalIgnoreCase)))
                    requested.TryAdd(f, to);
        }
        var target = new Dictionary<string, string>(StringComparer.Ordinal);
        var why = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var g in groups)
            foreach (var f in g.Fields)
            {
                if (target.ContainsKey(f)) continue;
                if (requested.TryGetValue(f, out var to)) { target[f] = to; why[f] = $"mapping.names maps {f} to {to}"; continue; }
                // a field label/order of a static entity IS its built-in Label/Order (never the key: the key is its own attribute)
                var builtIn = groups.Any(x => x.Static && x.Fields.Contains(f) && x.Key != f) ? BuiltIns.FirstOrDefault(b => string.Equals(b, f, StringComparison.OrdinalIgnoreCase)) : null;
                target[f] = builtIn ?? f;
                if (builtIn != null && builtIn != f) why[f] = $"the field {f} of a static entity is its built-in attribute {builtIn}";
            }
        // one scope per entity (case-insensitive): its key, the built-ins of a static entity and its fields, in order; a field that
        // collides gets the first suffix free in EVERY entity that has it (one field name, one attribute name)
        for (var pass = 0; pass < 16; pass++)
        {
            var changed = false;
            foreach (var g in groups)
            {
                var scope = new PrototypeNameScope(prefix, [], [], reserved: g.Static ? BuiltIns : null);
                foreach (var f in g.Fields)
                {
                    var t = target[f];
                    var isBuiltIn = g.Static && f != g.Key && BuiltIns.Contains(t, StringComparer.Ordinal) && string.Equals(f, t, StringComparison.OrdinalIgnoreCase);
                    if (isBuiltIn) continue;
                    if (scope.Claim(t)) continue;
                    var holders = groups.Where(x => x.Fields.Contains(f)).ToList();
                    string next;
                    var n = 2;
                    do next = t + n++;
                    while (holders.Any(h => Occupied(h, next, f, target)));
                    why[f] = $"{t} collides in entity {g.Name} with " + (g.Static && BuiltIns.Contains(t, StringComparer.OrdinalIgnoreCase) ? "its built-in attribute" : "another field") + $"; the attribute is {next}";
                    target[f] = next;
                    scope.Claim(next);
                    changed = true;
                }
            }
            if (!changed) break;
        }
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (f, t) in target)
        {
            if (string.Equals(f, t, StringComparison.Ordinal)) continue;
            map[f] = t;
            foreach (var g in groups.Where(g => g.Fields.Contains(f)))
                renamed.Add(new JsonObject { ["kind"] = "attribute", ["collection"] = g.Name, ["field"] = f, ["name"] = t, ["renamedFrom"] = f, ["why"] = why.GetValueOrDefault(f) ?? "attribute name" });
        }
        return map;
    }

    private static bool Occupied(Group g, string name, string self, Dictionary<string, string> target)
        => (g.Static && BuiltIns.Contains(name, StringComparer.OrdinalIgnoreCase)) || g.Fields.Any(f => f != self && string.Equals(target[f], name, StringComparison.OrdinalIgnoreCase));

    // ---- the rewrite: the same places the facade's pascalFields names a field (capture.mjs), with this map ----------------

    private static readonly HashSet<string> Skip = new(StringComparer.Ordinal) { "trees", "explored", "document", "css", "assets", "icons", "source", "engine", "warnings", "timings", "outOfScope" };
    private static readonly HashSet<string> EffectKinds = new(PrototypeCapture.Effects, StringComparer.Ordinal);

    private static void Rewrite(JsonObject ir, IReadOnlyDictionary<string, string> map)
    {
        string F(string name) => map.TryGetValue(name, out var to) ? to : name;
        void Visit(JsonNode? node, bool top)
        {
            if (node is JsonArray array) { foreach (var item in array) Visit(item, false); return; }
            if (node is not JsonObject o) return;
            var effect = o["kind"] is JsonValue k && k.TryGetValue<string>(out var kind) && EffectKinds.Contains(kind);
            var options = o["collection"] is JsonValue && o["value"] is JsonValue vv && vv.TryGetValue<string>(out _) && o["label"] is JsonValue lv && lv.TryGetValue<string>(out _);
            var isEvent = o["selector"] != null && o["key"] != null;
            foreach (var key in o.Select(p => p.Key).ToList())
            {
                var value = o[key];
                if (top && Skip.Contains(key)) continue;
                if (value is JsonValue jv && jv.TryGetValue<string>(out var s))
                {
                    var field = key is "field" or "via" or "existing" || (key == "on" && !isEvent) || (key == "sum" && effect) || ((key is "source" or "join") && !effect) || (options && key is "value" or "label");
                    if (field && map.ContainsKey(s)) o[key] = F(s);
                    continue;
                }
                if (key == "fields" && value is JsonArray fa && fa.All(x => x is JsonValue xv && xv.TryGetValue<string>(out _)))
                {
                    for (var i = 0; i < fa.Count; i++) { var name = fa[i]!.GetValue<string>(); if (map.ContainsKey(name)) fa[i] = F(name); }
                    continue;
                }
                if ((key is "fields" or "keys") && effect && value is JsonObject fo) { RenameKeys(fo, F); foreach (var (_, inner) in fo) Visit(inner, false); continue; }
                Visit(value, false);
            }
        }
        Visit(ir, true);
        foreach (var c in PrototypeCapture.Objects(ir["store"]?["collections"]))
        {
            if (c["key"]?.ToString() is { } key && key != "#") c["key"] = F(key);
            foreach (var f in PrototypeCapture.Objects(c["fields"])) if (f["name"]?.ToString() is { } n) f["name"] = F(n);
            foreach (var row in (c["rows"] as JsonArray ?? []).OfType<JsonObject>()) RenameKeys(row, F);
        }
        foreach (var x in PrototypeCapture.Objects(ir["extraAttributes"])) if (x["name"]?.ToString() is { } n) x["name"] = F(n);
        foreach (var root in Roots(ir))
            Walk(root, node =>
            {
                if (node["list"]?["snapshot"] is not JsonObject snapshot) return;
                foreach (var a in PrototypeCapture.Objects(snapshot["attributes"])) if (a["name"]?.ToString() is { } n) a["name"] = F(n);
                foreach (var row in (snapshot["rows"] as JsonArray ?? []).OfType<JsonObject>()) RenameKeys(row, F);
            });
    }

    /// <summary>Renames the keys of an object in place, keeping their order.</summary>
    private static void RenameKeys(JsonObject o, Func<string, string> rename)
    {
        if (!o.Any(p => rename(p.Key) != p.Key)) return;
        var pairs = o.Select(p => (Key: rename(p.Key), Value: p.Value)).ToList();
        o.Clear();
        foreach (var (k, v) in pairs) o[k] = v;
    }
}
