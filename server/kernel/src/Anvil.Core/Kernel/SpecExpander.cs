using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// Spec compacta de dados -> ops de verbos. E acucar: tudo o que gera e verbo normal, com as convencoes do Studio ja aplicadas
/// (Id Long Integer AutoNumber + IdentifierAttribute; static entity com Id Integer SEM AutoNumber, Label e Order; Public/ExposeReadOnly).
/// Static entity: o Id nunca e AutoNumber (o ODC recusa 'StaticEntity Auto Number' ao vivo) e cada registo recebe o seu Id:
/// o `id` declarado no registo ou, sem ele, a posicao 1..n. O job so escolhe os valores, nunca o AutoNumber.
/// Aliases registados: $&lt;Entidade&gt;, $&lt;Entidade&gt;.&lt;Atributo&gt;, $&lt;Static&gt;.&lt;Record&gt;, $&lt;Structure&gt;.
///
/// {"op":"spec","data":{
///   "static":[{"name":"Status","records":[{"name":"Active","label":"Active"},{"name":"Inactive"}]}],
///   "entities":[{"name":"Contact","public":true,"description":"...","attributes":[
///       {"name":"Name","type":"Text","mandatory":true,"length":100},{"name":"StatusId","type":"Status Identifier"},
///       {"name":"Email","type":"Email"},{"name":"CreatedOn","type":"Date Time","default":"CurrDateTime()"}]}],
///   "structures":[{"name":"ContactSummary","public":true,"attributes":[{"name":"Name","type":"Text"}]}]}}
/// </summary>
public static class SpecExpander
{
    private static readonly Dictionary<string, string[]> Shapes = new()
    {
        ["data"] = ["static", "entities", "clientEntities", "structures"],
        ["static"] = ["name", "public", "description", "attributes", "records"],
        ["entity"] = ["name", "public", "readOnly", "description", "label", "id", "idType", "attributes", "updateBehavior", "indexes"],
        ["attribute"] = ["name", "type", "mandatory", "length", "default", "description", "label", "deleteRule"],
        ["structure"] = ["name", "public", "description", "attributes"],
        ["structureAttribute"] = ["name", "type", "mandatory", "length", "label", "default", "description"],
        ["record"] = ["name", "id", "label", "order"],
        ["index"] = ["name", "unique", "attributes"]
    };
    public static JsonObject Schema() => new()
    {
        ["op"] = "spec", ["shapes"] = System.Text.Json.JsonSerializer.SerializeToNode(Shapes),
        ["rules"] = "Closed keys. Static records also accept the names of custom attributes declared on their entity. Entity id defaults to Long Integer; client ids have no AutoNumber. Static entity ids are Integer and never AutoNumber: each record gets its Id from `id` (positive, unique in the entity) or, when omitted, its position 1..n. Types and identifiers are declared before fields. Long Text attributes default to Text Length 2000000. Server entities default to Optimized (Changed Attributes) update behavior unless `updateBehavior` is given."
    };
    private static void Keys(JsonObject value, string shape, IEnumerable<string>? extra = null)
    {
        var allowed = Shapes[shape].Concat(extra ?? []).ToArray();
        var unknown = value.Select(kv => kv.Key).Except(allowed, StringComparer.Ordinal).ToArray();
        if (unknown.Length != 0) throw new InvalidOperationException($"spec {shape}: unknown keys {string.Join(", ", unknown)}; allowed: {string.Join(", ", allowed)}");
    }

    public static List<JsonObject> Expand(JsonObject data) => Expand(data, null);

    /// <summary>C21 (atritos 3): <paramref name="rewrites"/> hears every value written otherwise than the spec gives it, with its
    /// pointer relative to the data: a default given as JSON (true, 3) or as a bare word is the literal the Studio stores
    /// ("True", 3, "\"Pending\""), a JSON boolean of a static record is True/False.</summary>
    public static List<JsonObject> Expand(JsonObject data, List<(string Pointer, string From, string To)>? rewrites)
    {
        Keys(data, "data");
        var ops = new List<JsonObject>();
        _rewrites = rewrites;
        try
        {
            var i = 0;
            foreach (var s in data["static"]?.AsArray() ?? new JsonArray()) { _at = "/static/" + i++; StaticEntity(ops, s!.AsObject()); }
            i = 0;
            foreach (var e in data["entities"]?.AsArray() ?? new JsonArray()) { _at = "/entities/" + i++; Entity(ops, e!.AsObject(), client: false); }
            i = 0;
            foreach (var e in data["clientEntities"]?.AsArray() ?? new JsonArray()) { _at = "/clientEntities/" + i++; Entity(ops, e!.AsObject(), client: true); }
            i = 0;
            _publicInner = PublicInner(data["structures"] as JsonArray ?? new JsonArray());
            foreach (var st in data["structures"]?.AsArray() ?? new JsonArray()) { _at = "/structures/" + i++; Structure(ops, st!.AsObject()); }
        }
        finally { _rewrites = null; _at = ""; _publicInner = null; }
        // Declare every type and identifier before resolving fields, including cyclic FKs.
        var identities = new HashSet<string>();
        foreach (var op in ops.Where(o => o["prop"]?.ToString() == "IdentifierAttribute")) identities.Add(op["value"]!.ToString());
        bool Skeleton(JsonObject op) =>
            op["op"]?.ToString() == "create" && (op["parent"]?.ToString() == "@espace" || identities.Contains(op["as"]?.ToString() ?? "")) ||
            op["op"]?.ToString() == "set" && (op["prop"]?.ToString() == "IdentifierAttribute" || identities.Contains(op["target"]?.ToString() ?? ""));
        return ops.Where(Skeleton).Concat(ops.Where(o => !Skeleton(o))).ToList();
    }

    private static void StaticEntity(List<JsonObject> ops, JsonObject s)
    {
        Keys(s, "static");
        var name = Req(s, "name");
        ops.Add(Op("create", ("parent", "@espace"), ("type", "IStaticEntity"), ("name", name), ("as", "$" + name)));
        if (s["public"]?.GetValue<bool>() is { } isPublic) ops.Add(Set("$" + name, "Public", isPublic));
        if (s["description"]?.GetValue<string>() is { } d) ops.Add(Set("$" + name, "Description", d));
        ops.Add(Op("create", ("parent", "$" + name), ("type", "IEntityAttribute"), ("name", "Id"), ("as", $"${name}.Id")));
        ops.Add(Set($"${name}.Id", "DataType", "Integer"));
        ops.Add(Set($"${name}.Id", "IsAutoNumber", "No"));
        ops.Add(Set("$" + name, "IdentifierAttribute", $"${name}.Id"));
        ops.Add(Op("create", ("parent", "$" + name), ("type", "IEntityAttribute"), ("name", "Label"), ("as", $"${name}.Label")));
        ops.Add(Set($"${name}.Label", "DataType", "Text"));
        ops.Add(Set($"${name}.Label", "Length", 50));
        ops.Add(Set("$" + name, "LabelAttribute", $"${name}.Label"));
        ops.Add(Op("create", ("parent", "$" + name), ("type", "IEntityAttribute"), ("name", "Order"), ("as", $"${name}.Order")));
        ops.Add(Set($"${name}.Order", "DataType", "Integer"));
        ops.Add(Set("$" + name, "OrderByAttribute", $"${name}.Order"));
        var extra = new List<string>();
        var attributes = s["attributes"]?.AsArray() ?? new JsonArray();
        for (var k = 0; k < attributes.Count; k++)
        {
            var ao = attributes[k]!.AsObject(); var an = Req(ao, "name");
            extra.Add(an);
            Attribute(ops, "$" + name, name, ao, create: an is not ("Id" or "Label" or "Order"), at: $"{_at}/attributes/{k}");
        }
        var types = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var x in attributes.OfType<JsonObject>()) if (x["name"]?.ToString() is { } n) types[n] = x["type"]?.ToString() ?? "Text";
        var i = 0;
        var ids = new HashSet<int>();
        foreach (var r in s["records"]?.AsArray() ?? new JsonArray())
        {
            var ro = r!.AsObject(); Keys(ro, "record", extra); var rn = Req(ro, "name"); i++;
            var id = RecordId(name, ro, i);
            if (!ids.Add(id)) throw new InvalidOperationException($"spec static {name}: record '{rn}' repeats id {id}; ids must be unique in the static entity");
            ops.Add(Op("create", ("parent", "$" + name), ("type", "IRecord"), ("name", rn), ("as", $"${name}.{rn}")));
            ops.Add(Set($"${name}.{rn}/Id", "Value", id.ToString()));
            ops.Add(Set($"${name}.{rn}/Label", "Value", Quote(ro["label"]?.GetValue<string>() ?? rn)));
            ops.Add(Set($"${name}.{rn}/Order", "Value", (ro["order"]?.GetValue<int>() ?? i).ToString()));
            foreach (var an in extra)
                if (ro[an] is { } v) ops.Add(Set($"${name}.{rn}/{an}", "Value", Literal(types.GetValueOrDefault(an) ?? "Text", v, $"{_at}/records/{i - 1}/{an}")));
        }
    }

    /// <summary>Id de um registo de static entity: o `id` declarado (inteiro positivo) ou a posicao 1..n.</summary>
    public static int RecordId(string entity, JsonObject record, int position)
    {
        if (record["id"] is not { } node) return position;
        if (node is JsonValue v && v.TryGetValue<int>(out var id) && id > 0) return id;
        throw new InvalidOperationException($"spec static {entity}: record '{record["name"]}' id must be a positive integer, got {node.ToJsonString()}");
    }

    private static void Entity(List<JsonObject> ops, JsonObject e, bool client)
    {
        Keys(e, "entity");
        var name = Req(e, "name");
        ops.Add(Op("create", ("parent", "@espace"), ("type", client ? "IClientEntity" : "IServerEntity"), ("name", name), ("as", "$" + name)));
        if (e["public"]?.GetValue<bool>() is { } isPublic) { ops.Add(Set("$" + name, "Public", isPublic)); if (!client && isPublic) ops.Add(Set("$" + name, "ExposeReadOnly", e["readOnly"]?.GetValue<bool>() ?? true)); }
        if (e["description"]?.GetValue<string>() is { } d) ops.Add(Set("$" + name, "Description", d));
        if (e["label"]?.GetValue<string>() is { } l) ops.Add(Set("$" + name, "Label", l));
        if (e["id"]?.GetValue<bool>() is not false)
        {
            ops.Add(Op("create", ("parent", "$" + name), ("type", "IEntityAttribute"), ("name", "Id"), ("as", $"${name}.Id")));
            ops.Add(Set($"${name}.Id", "DataType", e["idType"]?.GetValue<string>() ?? "Long Integer"));
            if (!client) ops.Add(Set($"${name}.Id", "IsAutoNumber", "Yes"));
            ops.Add(Set("$" + name, "IdentifierAttribute", $"${name}.Id"));
        }
        // Server entities default to Optimized (Changed Attributes): the Studio suggests it for many attributes, Binary Data
        // and long text, and it is harmless otherwise. An explicit updateBehavior still wins.
        if (e["updateBehavior"] is { } behavior) ops.Add(Set("$" + name, "UpdateBehavior", ValueAliases.Normalize("UpdateBehavior", behavior.ToString())));
        else if (!client) ops.Add(Set("$" + name, "UpdateBehavior", "Optimized"));
        var attributes = e["attributes"]?.AsArray() ?? new JsonArray();
        for (var k = 0; k < attributes.Count; k++) Attribute(ops, "$" + name, name, attributes[k]!.AsObject(), at: $"{_at}/attributes/{k}");
        foreach (var index in e["indexes"]?.AsArray() ?? new JsonArray())
        {
            var ix = index!.AsObject();
            Keys(ix, "index");
            var fields = ix["attributes"]?.AsArray() ?? throw new ArgumentException("Index attributes required");
            var declared = (e["attributes"]?.AsArray() ?? new JsonArray()).Select(a => a!["name"]!.ToString()).Append("Id").ToHashSet();
            if (fields.Count == 0 || fields.Select(f => f!.ToString()).Distinct().Count() != fields.Count || fields.Any(f => !declared.Contains(f!.ToString())))
                throw new ArgumentException($"Invalid index attributes on {name}: use distinct declared attributes");
            ops.Add(new JsonObject { ["op"] = "create", ["type"] = "EntityIndex", ["parent"] = "$" + name,
                ["name"] = Req(ix, "name"), ["args"] = new JsonObject { ["unique"] = ix["unique"]?.DeepClone() ?? JsonValue.Create(false),
                    ["attributes"] = new JsonArray(fields.Select(f => (JsonNode)JsonValue.Create("$" + name + "." + f!.ToString())!).ToArray()) } });
        }
    }

    private static void Attribute(List<JsonObject> ops, string parentAlias, string owner, JsonObject a, bool create = true, string at = "")
    {
        Keys(a, "attribute");
        var an = Req(a, "name");
        var alias = $"${owner}.{an}";
        if (create) ops.Add(Op("create", ("parent", parentAlias), ("type", "IEntityAttribute"), ("name", an), ("as", alias)));
        var type = a["type"]?.GetValue<string>() ?? "Text";
        var longText = type.Equals("Long Text", StringComparison.OrdinalIgnoreCase);
        ops.Add(Set(alias, "DataType", longText ? "Text" : type));
        if (longText && a["length"] == null) ops.Add(Set(alias, "Length", 2000000));
        if (a["mandatory"]?.GetValue<bool>() is { } mandatory) ops.Add(Set(alias, "IsMandatory", mandatory));
        if (a["length"]?.GetValue<int>() is { } len) ops.Add(Set(alias, "Length", len));
        if (a["default"] is { } dv) ops.Add(Set(alias, "DefaultValue", Literal(type, dv, at + "/default")));
        if (a["description"]?.GetValue<string>() is { } d) ops.Add(Set(alias, "Description", d));
        if (a["label"]?.GetValue<string>() is { } l) ops.Add(Set(alias, "Label", l));
        if (a["deleteRule"]?.GetValue<string>() is { } dr)
        {
            // C19 (atritos 3): a reference of an entity to itself cannot cascade (Verify BadDeleteRule, a client's messaging module); it
            // keeps the platform's default, Protect, reported.
            if (dr.Equals("Delete", StringComparison.OrdinalIgnoreCase) && type.Trim().Equals(owner + " Identifier", StringComparison.OrdinalIgnoreCase))
            {
                _rewrites?.Add((at + "/deleteRule", dr, "Protect"));
                dr = "Protect";
            }
            ops.Add(Set(alias, "DeleteRule", dr));
        }
    }

    private static void Structure(List<JsonObject> ops, JsonObject st)
    {
        Keys(st, "structure");
        var name = Req(st, "name");
        ops.Add(Op("create", ("parent", "@espace"), ("type", "IStructure"), ("name", name), ("as", "$" + name)));
        if (_publicInner?.Contains(name) == true && st["public"]?.GetValue<bool>() is not true)
        {
            // C19 (atritos 3): a structure a public structure holds is public too (InvalidPublic_AttributeNotPublic otherwise).
            ops.Add(Set("$" + name, "Public", true));
            _rewrites?.Add((_at + "/public", st["public"]?.ToJsonString() ?? "(absent)", "true"));
        }
        else if (st["public"]?.GetValue<bool>() is { } isPublic) ops.Add(Set("$" + name, "Public", isPublic));
        if (st["description"]?.GetValue<string>() is { } d) ops.Add(Set("$" + name, "Description", d));
        var attributes = st["attributes"]?.AsArray() ?? new JsonArray();
        for (var k = 0; k < attributes.Count; k++)
        {
            var ao = attributes[k]!.AsObject(); Keys(ao, "structureAttribute"); var an = Req(ao, "name"); var alias = $"${name}.{an}";
            ops.Add(Op("create", ("parent", "$" + name), ("type", "IStructureAttribute"), ("name", an), ("as", alias)));
            var type = ao["type"]?.GetValue<string>() ?? "Text";
            ops.Add(Set(alias, "DataType", type));
            if (ao["mandatory"]?.GetValue<bool>() is { } mandatory) ops.Add(Set(alias, "IsMandatory", mandatory));
            // C21 (atritos 3): a structure attribute takes length and label as an entity attribute does.
            if (ao["length"]?.GetValue<int>() is { } len) ops.Add(Set(alias, "Length", len));
            if (ao["label"]?.GetValue<string>() is { } label) ops.Add(Set(alias, "Label", label));
            if (ao["default"] is { } dv) ops.Add(Set(alias, "DefaultValue", Literal(type, dv, $"{_at}/attributes/{k}/default")));
            if (ao["description"]?.GetValue<string>() is { } ad) ops.Add(Set(alias, "Description", ad));
        }
    }

    private static JsonObject Op(string op, params (string Key, object Value)[] fields)
    {
        var o = new JsonObject { ["op"] = op };
        foreach (var (k, v) in fields) o[k] = V(v);
        return o;
    }

    private static JsonObject Set(string target, string prop, object value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = V(value) };
    private static JsonNode V(object v) => v switch { string s => JsonValue.Create(s)!, bool b => JsonValue.Create(b), int i => JsonValue.Create(i), _ => JsonValue.Create(v.ToString())! };
    private static string Quote(string s) => "\"" + s.Replace("\"", "\"\"") + "\"";

    // The rewrites of the Expand that runs and the pointer of the declaration it reads (C21).
    [ThreadStatic] private static List<(string Pointer, string From, string To)>? _rewrites;
    [ThreadStatic] private static string? _at;
    [ThreadStatic] private static HashSet<string>? _publicInner;

    /// <summary>C19: the structures of this spec that a public structure of it holds (an attribute of type S, S List or S
    /// Record), at any depth, and that are not declared public.</summary>
    private static HashSet<string> PublicInner(JsonArray structures)
    {
        var byName = structures.OfType<JsonObject>().Where(s => s["name"] is JsonValue).GroupBy(s => s["name"]!.ToString(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        var needed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<JsonObject>(byName.Values.Where(s => s["public"] is JsonValue p && p.TryGetValue<bool>(out var isPublic) && isPublic));
        while (queue.Count > 0)
            foreach (var attribute in (queue.Dequeue()["attributes"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
            {
                var type = attribute["type"]?.ToString()?.Trim() ?? "";
                foreach (var suffix in new[] { " List", " Record" }) if (type.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) type = type[..^suffix.Length].Trim();
                if (byName.TryGetValue(type, out var inner) && !(inner["public"] is JsonValue ip && ip.TryGetValue<bool>(out var open) && open) && needed.Add(inner["name"]!.ToString()))
                    queue.Enqueue(inner);
            }
        return needed;
    }

    /// <summary>C21 (atritos 3): a value of the spec as the literal the Studio stores. JSON true/false is True/False, a JSON
    /// number its invariant text, and a text the literal JobPreflight.LiteralFix gives for the type (a bare word of a Text is
    /// quoted, yes/no and "true" of a Boolean are True/False, a date gets its #); anything else is the expression as written.
    /// Every change is a rewrite with its pointer.</summary>
    internal static string Literal(string type, JsonNode value, string pointer)
    {
        string written, literal;
        if (value is JsonValue v && v.TryGetValue<string>(out var text)) { written = text; literal = JobPreflight.LiteralFix(type, text) ?? text; }
        else if (value is JsonValue b && b.TryGetValue<bool>(out var flag)) { written = value.ToJsonString(); literal = flag ? "True" : "False"; }
        else { written = value.ToJsonString(); literal = written; }
        if (literal != written || value is not JsonValue s || !s.TryGetValue<string>(out _)) _rewrites?.Add((pointer, written, literal));
        return literal;
    }
    private static string Req(JsonObject o, string k) => o[k]?.GetValue<string>() ?? throw new InvalidOperationException($"spec: missing '{k}' in {o.ToJsonString()}");
}
