using System.Reflection;
using System.Text.Json.Nodes;

namespace Anvil.Authoring.Transport;

/// <summary>Binds compiler-produced data metadata to the caller's already loaded source
/// assembly. No Roslyn, source evaluation, arbitrary assembly loading or property execution.</summary>
public sealed class ReferenceGraphBinding
{
    public IReadOnlyList<GraphDefinition> Definitions { get; }
    public IReadOnlyList<GraphShape> Inputs { get; }
    public IReadOnlyList<GraphShape> Results { get; }
    public IReadOnlyList<string> InputNames { get; }
    public int AbiVersion { get; }
    public IReadOnlyList<bool> OptionalInputs { get; }

    public ReferenceGraphBinding(JsonObject schema, Assembly sourceAssembly) : this(schema, sourceAssembly, 2) { }

    public ReferenceGraphBinding(JsonObject schema, Assembly sourceAssembly, int maxSupportedVersion)
    {
        GraphExceptions.Version(maxSupportedVersion);
        AbiVersion = schema["version"]?.GetValue<int>() ?? throw new InvalidDataException("Missing C# graph ABI version.");
        if (Text(schema, "id") != "anvil.csharp.reference-graph" || AbiVersion is not (2 or 3 or 4) || AbiVersion > maxSupportedVersion)
            throw new InvalidDataException("Unsupported C# reference graph ABI.");
        if (AbiVersion == 2) Keys(schema, "id", "version", "inputs", "results", "definitions");
        else
        {
            Keys(schema, "id", "version", "inputs", "results", "definitions", "exceptionArena");
            if (Text(schema, "exceptionArena") != GraphExceptions.Arena) throw new InvalidDataException("Unknown exception arena.");
        }
        Type Resolve(JsonObject type)
        {
            var kind = Text(type, "kind");
            if (kind == "identity")
            {
                Keys(type, "kind", "target");
                return typeof(Id<>).MakeGenericType(Resolve(Object(type["target"])));
            }
            if (kind is "list" or "array" or "nullable" || kind == "readonly-list" && AbiVersion >= 4)
            {
                Keys(type, "kind", "element"); var element = Resolve(Object(type["element"]));
                return kind switch { "list" => typeof(List<>).MakeGenericType(element),
                    "readonly-list" => typeof(IReadOnlyList<>).MakeGenericType(element),
                    "nullable" => typeof(Nullable<>).MakeGenericType(element), _ => element.MakeArrayType() };
            }
            Keys(type, "kind", "name"); var name = Text(type, "name");
            if (kind == "exception" && AbiVersion >= 3) return GraphExceptions.Resolve(name);
            if (kind == "temporal" && AbiVersion >= 4) return GraphTemporal.Types.GetValueOrDefault(name)
                ?? throw new InvalidDataException("Unsupported BCL temporal graph type: " + name);
            if (kind == "primitive" && AbiVersion >= 4 && name == typeof(DateTimeKind).FullName) return typeof(DateTimeKind);
            if (kind == "primitive") return Primitives.GetValueOrDefault(name)
                ?? throw new InvalidDataException("Unsupported graph primitive: " + name);
            if (kind != "source") throw new InvalidDataException("Unsupported graph type descriptor.");
            var resolved = sourceAssembly.GetType(name, throwOnError: false);
            if (resolved == null || resolved.Assembly != sourceAssembly)
                throw new InvalidDataException("Graph source type does not belong to the caller assembly: " + name);
            return resolved;
        }
        GraphShape Shape(JsonObject shape)
        {
            switch (Text(shape, "kind"))
            {
                case "nullable": Keys(shape, "kind", "value"); return new GraphOptional(Shape(Object(shape["value"])));
                case "scalar": Keys(shape, "kind", "type"); return new GraphScalar(Resolve(Object(shape["type"])));
                case "identity": Keys(shape, "kind", "type", "bits"); return new GraphIdentity(Resolve(Object(shape["type"])), shape["bits"]!.GetValue<int>());
                case "reference": Keys(shape, "kind", "arena"); return new GraphReference(Text(shape, "arena"));
                case "readonly-list" when AbiVersion >= 4:
                    Keys(shape, "kind", "listArena", "arrayArena");
                    return new GraphReadOnlyList(Text(shape, "listArena"), Text(shape, "arrayArena"));
                case "temporal" when AbiVersion >= 4:
                    Keys(shape, "kind", "type"); var temporal = Object(shape["type"]);
                    if (Text(temporal, "kind") != "temporal") throw new InvalidDataException("A temporal shape requires its exact BCL temporal type.");
                    return new GraphTemporal(Resolve(temporal));
                case "exception" when AbiVersion >= 3:
                    Keys(shape, "kind", "type"); var declared = Object(shape["type"]);
                    if (Text(declared, "kind") != "exception") throw new InvalidDataException("An exception shape requires a declared BCL exception type.");
                    return new GraphException(Resolve(declared));
                case "inline":
                    Keys(shape, "kind", "type", "fields"); var inlineType = Object(shape["type"]);
                    if (Text(inlineType, "kind") != "source") throw new InvalidDataException("Inline graph fields require a source value type; BCL values use their explicit codec.");
                    var type = Resolve(inlineType);
                    return new GraphInline(type, Fields(type, Array(shape["fields"])));
                default: throw new InvalidDataException("Unsupported graph shape descriptor.");
            }
        }
        IReadOnlyList<GraphField> Fields(Type type, JsonArray fields) => fields.Select(node => {
            var field = Object(node); Keys(field, "name", "sourceMember", "storage", "shape");
            var storage = type.GetField(Text(field, "storage"), BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                ?? throw new InvalidDataException("Graph field has no caller storage: " + type.FullName + "." + Text(field, "sourceMember"));
            return new GraphField(Text(field, "name"), storage, Shape(Object(field["shape"])));
        }).ToArray();
        Definitions = Array(schema["definitions"]).Select(node => {
            var definition = Object(node); var sequence = definition.ContainsKey("element");
            Keys(definition, "arena", "type", sequence ? "element" : "fields");
            var type = Resolve(Object(definition["type"]));
            return new GraphDefinition(Text(definition, "arena"), type,
                sequence ? [] : Fields(type, Array(definition["fields"])), sequence ? Shape(Object(definition["element"])) : null);
        }).ToArray();
        var inputs = Array(schema["inputs"]).Select(node => {
            var input = Object(node); var optional = input.ContainsKey("optional");
            if (optional)
            {
                if (AbiVersion < 4 || input["optional"] is not JsonValue flag || !flag.TryGetValue<bool>(out var enabled) || !enabled)
                    throw new InvalidDataException("Optional graph arguments require the closed ABI4 omission contract.");
                Keys(input, "name", "sourceName", "shape", "optional");
            }
            else Keys(input, "name", "sourceName", "shape");
            return (Name: Text(input, "name"), Shape: Shape(Object(input["shape"])), Optional: optional);
        }).ToArray();
        InputNames = inputs.Select(i => i.Name).ToArray(); Inputs = inputs.Select(i => i.Shape).ToArray();
        OptionalInputs = inputs.Select(i => i.Optional).ToArray();
        Results = Array(schema["results"]).Select(node => Shape(Object(node))).ToArray();
        if (InputNames.Distinct(StringComparer.Ordinal).Count() != inputs.Length || Results.Count > 1)
            throw new InvalidDataException("Graph call signature is malformed.");
        // This validates storage types, closure, sequence elements and supported source types.
        CreateSession().ValidateSignature(Inputs.Concat(Results));
    }

    public ReferenceGraphSession CreateSession() => new(Definitions, AbiVersion);
    public ReferenceGraphWire CreateWire() => new(Definitions, AbiVersion);
    public ReferenceGraphCall CreateCall(string action) => new(action, InputNames, Inputs, Results, Definitions, AbiVersion, OptionalInputs);

    private static readonly IReadOnlyDictionary<string, Type> Primitives = new[] { typeof(string), typeof(bool), typeof(char),
        typeof(byte), typeof(sbyte), typeof(short), typeof(ushort), typeof(int), typeof(uint), typeof(long), typeof(ulong),
        typeof(float), typeof(double), typeof(decimal) }.ToDictionary(t => t.FullName!, StringComparer.Ordinal);
    private static JsonObject Object(JsonNode? node) => node as JsonObject ?? throw new InvalidDataException("Expected graph schema object.");
    private static JsonArray Array(JsonNode? node) => node as JsonArray ?? throw new InvalidDataException("Expected graph schema array.");
    private static string Text(JsonObject obj, string name) => obj[name]?.GetValue<string>() is { Length: > 0 } text ? text
        : throw new InvalidDataException("Missing graph schema string: " + name);
    private static void Keys(JsonObject obj, params string[] keys)
    {
        if (obj.Count != keys.Length || keys.Any(k => !obj.ContainsKey(k) || obj[k] == null))
            throw new InvalidDataException("Graph schema has missing, null or unknown fields.");
    }
}
