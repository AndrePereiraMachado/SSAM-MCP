using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Types;

namespace Anvil.Core;

/// <summary>Checks the declaration, including properties for which the compiler emitted no operation.</summary>
public sealed partial class ModelSession
{
    public JsonObject CheckDataSpecification(JsonObject specification, JsonObject? expectedTypes = null)
    {
        var assertions = new JsonArray();
        var types = expectedTypes?.DeepClone().AsObject() ?? new JsonObject();
        var unresolvedTypes = new JsonArray();
        _ = SpecExpander.Expand(specification); // Closed vocabulary, independently read below.
        foreach (var group in new[] { "static", "entities", "clientEntities", "structures" })
        foreach (var definition in specification[group]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var name = definition["name"]!.ToString();
            var kind = group switch { "static" => "IStaticEntity", "entities" => "IServerEntity", "clientEntities" => "IClientEntity", _ => "IStructure" };
            var root = kind + ":" + name;
            Exists(root, name);
            if (definition["public"]?.GetValue<bool>() is { } isPublic) Add(root, "Public", Normal(isPublic));
            Properties(root, definition, ("description", "Description"), ("label", "Label"));
            if (group == "entities" && definition["public"]?.GetValue<bool>() == true)
                Add(root, "ExposeReadOnly", Normal(definition["readOnly"]?.GetValue<bool>() ?? true));
            var fields = definition["attributes"]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
            if (group == "static" || group != "structures" && definition["id"]?.GetValue<bool>() != false)
            {
                Exists(root + "/Id", "Id");
                Type(root + "/Id", group == "static" ? "Integer" : definition["idType"]?.ToString() ?? "Long Integer");
                Add(root + "/Id", "IsAutoNumber", Normal(group is "clientEntities" or "static" ? "No" : "Yes"));
                Reference(root, "IdentifierAttribute", root + "/Id");
            }
            if (group == "static")
            {
                foreach (var (field, type) in new[] { ("Label", "Text"), ("Order", "Integer") })
                {
                    Exists(root + "/" + field, field);
                    if (!fields.Any(f => f["name"]?.ToString() == field)) Type(root + "/" + field, type);
                }
                if (!fields.Any(f => f["name"]?.ToString() == "Label" && f["length"] != null)) Add(root + "/Label", "Length", Normal(50));
                Reference(root, "LabelAttribute", root + "/Label");
                Reference(root, "OrderByAttribute", root + "/Order");
            }
            if (definition["updateBehavior"] != null) Add(root, "UpdateBehavior", Normal(ValueAliases.Normalize("UpdateBehavior", definition["updateBehavior"]!.ToString())));
            else if (group == "entities")
                Add(root, "UpdateBehavior", Normal("Optimized"));
            foreach (var field in fields)
            {
                var fieldName = field["name"]!.ToString(); var path = root + "/" + fieldName;
                Exists(path, fieldName);
                var type = field["type"]?.ToString() ?? "Text";
                var longText = type.Equals("Long Text", StringComparison.OrdinalIgnoreCase);
                Type(path, longText ? "Text" : type);
                if (longText && field["length"] == null) Add(path, "Length", Normal(2000000));
                Properties(path, field, ("mandatory", "IsMandatory"), ("length", "Length"), ("default", "DefaultValue"),
                    ("description", "Description"), ("label", "Label"), ("deleteRule", "DeleteRule"));
            }
            var order = 0;
            foreach (var record in definition["records"]?.AsArray().OfType<JsonObject>() ?? [])
            {
                order++; var recordName = record["name"]!.ToString(); var path = root + "/" + recordName;
                Exists(path, recordName);
                Add(path + "/Id", "Value", Normal(SpecExpander.RecordId(name, record, order)));
                Add(path + "/Label", "Value", JsonValue.Create(Quote(record["label"]?.ToString() ?? recordName)));
                Add(path + "/Order", "Value", Normal(record["order"]?.GetValue<int>() ?? order));
                foreach (var field in fields)
                {
                    var fieldName = field["name"]!.ToString();
                    if (record[fieldName] is { } value) Add(path + "/" + fieldName, "Value", JsonValue.Create(value.ToString()));
                }
            }
            foreach (var index in definition["indexes"]?.AsArray().OfType<JsonObject>() ?? [])
            {
                var path = root + "/" + index["name"]!.ToString();
                Exists(path, index["name"]!.ToString());
                Add(path, "Unique", Normal(index["unique"]?.GetValue<bool>() ?? false));
                // Por CHAVE, como o `create EntityIndex` ja fazia: os atributos do indice seguem um rename no mesmo job
                // e a foto dos nomes recusaria a entrega com o indice certo no modelo (fase 3, 2026-09-23).
                var keys = new JsonArray();
                foreach (var attribute in index["attributes"]!.AsArray())
                {
                    try { keys.Add(JsonValue.Create(ResolveDataPath(root + "/" + attribute!.ToString()).ObjectKey?.ToString())); }
                    catch (Exception ex) { unresolvedTypes.Add(new JsonObject { ["element"] = path, ["property"] = "AttributeKeys", ["expected"] = attribute!.ToString(), ["actual"] = "unresolved: " + Errors.Text(ex) }); }
                }
                Add(path, "AttributeKeys", keys);
            }
        }
        var result = CheckDataContract(assertions);
        foreach (var failure in unresolvedTypes) result["differences"]!.AsArray().Add(failure!.DeepClone());
        result["accepted"] = result["differences"]!.AsArray().Count == 0;
        result["expectedTypes"] = types;
        result["scope"] = "All declared data requirements; independently read from the specification, not inferred from emitted operations.";
        return result;

        void Exists(string path, string name) { Add(path, "$exists", JsonValue.Create(true)); Add(path, "Name", JsonValue.Create(name)); }
        void Add(string path, string property, JsonNode? expected)
        {
            string reference = path; string? key = null;
            try { var target = ResolveDataPath(path); key = target.ObjectKey?.ToString(); reference = DataAssertionReference(target, path) ?? path; }
            catch (Exception ex) { unresolvedTypes.Add(new JsonObject { ["element"] = path, ["property"] = property, ["actual"] = "unavailable: " + Errors.Text(ex) }); }
            assertions.Add(new JsonObject { ["reference"] = reference, ["key"] = key, ["element"] = path, ["property"] = property, ["expected"] = expected?.DeepClone() });
        }
        void Type(string path, string name)
        {
            try
            {
                if (types[path] == null) types[path] = Expected(name);
                Add(path, "DataType", types[path]!.DeepClone());
            }
            catch (Exception ex)
            {
                unresolvedTypes.Add(new JsonObject { ["element"] = path, ["property"] = "DataType", ["expected"] = name, ["actual"] = "unresolved: " + Errors.Text(ex) });
            }
        }
        JsonObject Expected(string name)
        {
            if (name.EndsWith(" List", StringComparison.OrdinalIgnoreCase))
                return new() { ["kind"] = "list", ["element"] = Expected(name[..^5].Trim()) };
            return SemanticTypes.Describe(_es, TypeResolver.Resolve(_es, name));
        }
        void Reference(string path, string property, string target)
        {
            JsonNode? value;
            try { value = Normal(ResolveDataPath(target)); }
            catch { value = new JsonObject { ["missing"] = target }; }
            Add(path, property, value);
        }
        void Properties(string path, JsonObject node, params (string Json, string Model)[] properties)
        {
            foreach (var (json, model) in properties)
                if (node[json] is JsonValue value)
                    Add(path, model, value.TryGetValue<bool>(out var boolean) ? Normal(boolean) : JsonValue.Create(value.ToString()));
        }
    }

    private IObjectSignature ResolveDataPath(string path)
    {
        var slash = path.IndexOf('/'); var root = slash < 0 ? path : path[..slash];
        var colon = root.IndexOf(':'); var kind = root[..colon]; var name = root[(colon + 1)..];
        // Data declarations are owned directly by the module. Walking every action body
        // for every asserted property makes verification grow with unrelated logic.
        var matches = ((IObjectSignature)_es).Children.OfType<IObjectSignature>().Where(d => ReferenceEquals(d.Parent, _espace) && Implements(d, kind) &&
            string.Equals(TypeResolver.Name(d), name, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length != 1) throw new InvalidOperationException($"Expected exactly one owned {root}; found {matches.Length}");
        IObjectSignature current = matches[0];
        if (slash < 0) return current;
        foreach (var child in path[(slash + 1)..].Split('/'))
        {
            if (EntityIndexes.IncludeNative(new[] { current }).Where(o => EntityIndexes.TypeName(o) == "EntityIndex" && TypeResolver.Name(o) == child).ToArray() is { Length: 1 } indexes)
                current = indexes[0];
            else current = (IObjectSignature)ResolveChild(current, child);
        }
        return current;
    }

    private static string Quote(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";
}
