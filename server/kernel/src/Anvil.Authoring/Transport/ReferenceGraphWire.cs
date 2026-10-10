using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Authoring.Transport;

/// <summary>Maps the caller graph to typed native arena/handle records. Object and list
/// identity use Index; text always carries HasValue independently of source annotations.
/// No executable source, constructors or property getters cross this boundary.</summary>
public sealed class ReferenceGraphWire
{
    private readonly IReadOnlyDictionary<string, GraphDefinition> definitions;
    private readonly ReferenceGraphSession schema;
    public ReferenceGraphWire(IEnumerable<GraphDefinition> definitions) : this(definitions, 2) { }
    public ReferenceGraphWire(IEnumerable<GraphDefinition> definitions, int abiVersion)
    {
        schema = new ReferenceGraphSession(definitions, abiVersion); this.definitions = schema.Definitions;
    }
    private IEnumerable<string> ArenaNames => schema.AbiVersion >= 3 ? definitions.Keys.Append(GraphExceptions.Arena) : definitions.Keys;

    public JsonObject EncodeArenas(ReferenceGraph graph)
    {
        if (!graph.Arenas.Keys.Order(StringComparer.Ordinal).SequenceEqual(ArenaNames.Order(StringComparer.Ordinal)))
            throw new InvalidDataException("Native graph arena set differs from the source schema.");
        var result = new JsonObject();
        foreach (var (name, definition) in definitions)
            result[name] = new JsonArray(graph.Arenas[name].Select(cell => definition.Element == null
                ? (JsonNode)EncodeRecord(definition.Fields, (GraphRecord)cell)
                : EncodeSequence(definition, (GraphSequence)cell)).ToArray());
        if (schema.AbiVersion >= 3) result[GraphExceptions.Arena] = new JsonArray(graph.Arenas[GraphExceptions.Arena]
            .Select(cell => (JsonNode)EncodeException((GraphExceptionRecord)cell)).ToArray());
        return result;
    }

    public IReadOnlyList<JsonNode?> EncodeRoots(ReferenceGraph graph, IReadOnlyList<GraphShape> roots)
    {
        schema.ValidateSignature(roots);
        if (graph.Roots.Count != roots.Count) throw new InvalidDataException("Native root count differs from the source schema.");
        return roots.Select((shape, index) => EncodeValue(shape, graph.Roots[index])).ToArray();
    }

    public ReferenceGraph Decode(JsonObject arenas, IReadOnlyList<JsonNode?> roots, IReadOnlyList<GraphShape> shapes)
    {
        schema.ValidateSignature(shapes);
        RequireKeys(arenas, ArenaNames);
        if (roots.Count != shapes.Count) throw new InvalidDataException("Native root count differs from the source schema.");
        var cells = definitions.ToDictionary(p => p.Key, p => (IReadOnlyList<object>)
            (arenas[p.Key] as JsonArray ?? throw new InvalidDataException("Expected native arena list.")).Select(cell => {
                var record = cell as JsonObject ?? throw new InvalidDataException("Expected native arena cell.");
                if (p.Value.Element == null) return (object)DecodeRecord(p.Value.Fields, record);
                RequireKeys(record, p.Value.Type.IsArray ? ["Items"] : ["Items", "Version", "Capacity"]);
                return new GraphSequence((record["Items"] as JsonArray ?? throw new InvalidDataException("Expected native item list."))
                    .Select(value => DecodeValue(p.Value.Element, value)).ToArray(),
                    p.Value.Type.IsArray ? null : record["Version"]!.GetValue<int>(),
                    p.Value.Type.IsArray ? null : record["Capacity"]!.GetValue<int>());
            }).ToArray(), StringComparer.Ordinal);
        if (schema.AbiVersion >= 3) cells.Add(GraphExceptions.Arena,
            (arenas[GraphExceptions.Arena] as JsonArray ?? throw new InvalidDataException("Expected exception arena list."))
                .Select(cell => (object)DecodeException(cell)).ToArray());
        // Handle bounds and completeness are validated by Reconcile before caller writeback.
        var graph = new ReferenceGraph(cells, shapes.Select((shape, index) => DecodeValue(shape, roots[index])).ToArray());
        if (schema.AbiVersion >= 3 && (!JsonNode.DeepEquals(arenas, EncodeArenas(graph))
            || EncodeRoots(graph, shapes).Where((root, index) => !JsonNode.DeepEquals(root, roots[index])).Any()))
            throw new InvalidDataException("ABI3 graph contains noncanonical or invalid inactive payload fields.");
        return graph;
    }

    private static JsonObject EncodeSequence(GraphDefinition definition, GraphSequence sequence)
    {
        var result = new JsonObject { ["Items"] = new JsonArray(sequence.Items.Select(item => EncodeValue(definition.Element!, item)).ToArray()) };
        if (!definition.Type.IsArray)
        {
            result["Version"] = sequence.Version ?? throw new InvalidDataException("Missing list version.");
            result["Capacity"] = sequence.Capacity ?? throw new InvalidDataException("Missing list capacity.");
        }
        return result;
    }

    private static JsonNode? EncodeValue(GraphShape shape, object? value) => shape switch
    {
        GraphOptional optional => new JsonObject { ["HasValue"] = value != null,
            ["Value"] = value == null ? NativeDefault(optional.Value) : EncodeValue(optional.Value, value) },
        GraphReference or GraphException => new JsonObject { ["Index"] = ((GraphHandle)value!).Index },
        GraphReadOnlyList view => new JsonObject { ["Kind"] = view.Kind(value), ["Index"] = ((GraphHandle)value!).Index },
        GraphInline inline => EncodeRecord(inline.Fields, (GraphRecord)value!),
        GraphTemporal temporal => temporal.EncodeWire(value),
        GraphIdentity identity => JsonValue.Create(identity.NativeValue(value)),
        GraphScalar scalar when scalar.Type == typeof(string) => new JsonObject { ["HasValue"] = value != null, ["Value"] = (string?)value ?? "" },
        GraphScalar scalar => JsonSerializer.SerializeToNode(value, scalar.Type),
        _ => throw new ArgumentException("Unsupported native graph value shape.")
    };
    private static JsonNode? NativeDefault(GraphShape shape) => shape switch
    {
        GraphReference or GraphException => new JsonObject { ["Index"] = 0 },
        GraphReadOnlyList => new JsonObject { ["Kind"] = 0, ["Index"] = 0 },
        GraphInline inline => new JsonObject(inline.Fields.Select(f => KeyValuePair.Create(f.Name, NativeDefault(f.Shape)))),
        GraphTemporal temporal => temporal.EncodeWire(new GraphTemporalValue(0)),
        GraphOptional optional => new JsonObject { ["HasValue"] = false, ["Value"] = NativeDefault(optional.Value) },
        GraphIdentity identity => JsonValue.Create(identity.NativeValue(0L)),
        GraphScalar scalar when scalar.Type == typeof(string) => new JsonObject { ["HasValue"] = false, ["Value"] = "" },
        GraphScalar scalar => JsonSerializer.SerializeToNode(Activator.CreateInstance(scalar.Type), scalar.Type),
        _ => throw new InvalidDataException("Unsupported graph default shape.")
    };
    private static JsonObject EncodeRecord(IReadOnlyList<GraphField> fields, GraphRecord value)
        => new(fields.Select(f => KeyValuePair.Create(f.Name, EncodeValue(f.Shape, value.Fields[f.Name]))));
    private static object? DecodeValue(GraphShape shape, JsonNode? value)
    {
        if (shape is GraphTemporal temporal) return temporal.DecodeWire(value);
        if (shape is GraphReadOnlyList view)
        {
            try
            {
                var record = value as JsonObject ?? throw new InvalidDataException("Expected native readonly-list handle record.");
                RequireKeys(record, ["Kind", "Index"]);
                return view.Handle(record["Kind"]!.GetValue<int>(), record["Index"]!.GetValue<int>());
            }
            catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException or JsonException)
            { throw new InvalidDataException("Malformed native readonly-list handle.", error); }
        }
        if (shape is GraphOptional optional)
        {
            var record = value as JsonObject ?? throw new InvalidDataException("Expected native nullable value record.");
            RequireKeys(record, ["HasValue", "Value"]);
            return record["HasValue"]!.GetValue<bool>() ? DecodeValue(optional.Value, record["Value"]) : null;
        }
        if (shape is GraphReference or GraphException)
        {
            var record = value as JsonObject ?? throw new InvalidDataException("Expected native handle record.");
            RequireKeys(record, ["Index"]); return new GraphHandle(shape is GraphReference reference ? reference.Target : GraphExceptions.Arena, record["Index"]!.GetValue<int>());
        }
        if (shape is GraphInline inline)
            return DecodeRecord(inline.Fields, value as JsonObject ?? throw new InvalidDataException("Expected native inline record."));
        if (shape is GraphIdentity identity)
        {
            if (value is not JsonValue) throw new InvalidDataException("Expected a native identity integer scalar.");
            try { return identity.NativeValue(JsonSerializer.Deserialize<long>(value.ToJsonString())); }
            catch (JsonException error) { throw new InvalidDataException("Native identity is not an exact signed integer.", error); }
        }
        var scalar = (GraphScalar)shape;
        if (scalar.Type == typeof(string))
        {
            var record = value as JsonObject ?? throw new InvalidDataException("Expected native text presence record.");
            RequireKeys(record, ["HasValue", "Value"]);
            var text = record["Value"]!.GetValue<string>();
            return record["HasValue"]!.GetValue<bool>() ? text : null;
        }
        if (value == null) throw new InvalidDataException("Native scalar is null without presence metadata.");
        return JsonSerializer.Deserialize(value.ToJsonString(), scalar.Type);
    }
    private static GraphRecord DecodeRecord(IReadOnlyList<GraphField> fields, JsonObject value)
    {
        RequireKeys(value, fields.Select(f => f.Name));
        return new(fields.ToDictionary(f => f.Name, f => DecodeValue(f.Shape, value[f.Name]), StringComparer.Ordinal));
    }
    internal static void RequireDefault(GraphShape shape, JsonNode? value)
    {
        if (!JsonNode.DeepEquals(value, NativeDefault(shape)))
            throw new InvalidDataException("A failed completion must carry only the native default result payload.");
    }
    private static JsonObject EncodeException(GraphExceptionRecord record)
    {
        GraphExceptions.ValidateActual(record.ActualValue);
        return new JsonObject {
            ["TypeName"] = record.TypeName, ["Message"] = record.Message,
            ["ParamName"] = record.ParamName ?? "", ["HasParamName"] = record.ParamName != null,
            ["InnerRef"] = record.InnerRef, ["HasHResult"] = true, ["HResult"] = record.HResult,
            ["HasActualValue"] = record.ActualValue != null, ["ActualValueType"] = record.ActualValue?.GetType().FullName ?? "",
            ["ActualValueInteger"] = record.ActualValue is int integer ? integer : 0,
            ["ActualValueLong"] = record.ActualValue is long number ? number : 0L,
            ["ActualValueText"] = record.ActualValue as string ?? "",
            ["ActualValueBoolean"] = record.ActualValue is bool boolean && boolean
        };
    }
    internal static GraphExceptionRecord DecodeException(JsonNode? value)
    {
        try
        {
            var record = value as JsonObject ?? throw new InvalidDataException("Expected typed exception payload.");
            RequireKeys(record, ["TypeName", "Message", "ParamName", "HasParamName", "InnerRef", "HasHResult", "HResult",
                "HasActualValue", "ActualValueType", "ActualValueInteger", "ActualValueLong", "ActualValueText", "ActualValueBoolean"]);
            var hasActual = record["HasActualValue"]!.GetValue<bool>();
            var tag = record["ActualValueType"]!.GetValue<string>();
            object? actual = tag switch {
                "" when !hasActual => null,
                "System.Int32" when hasActual => record["ActualValueInteger"]!.GetValue<int>(),
                "System.Int64" when hasActual => record["ActualValueLong"]!.GetValue<long>(),
                "System.String" when hasActual => record["ActualValueText"]!.GetValue<string>(),
                "System.Boolean" when hasActual => record["ActualValueBoolean"]!.GetValue<bool>(),
                _ => throw new InvalidDataException("Unknown or inconsistent exception ActualValue type.")
            };
            var result = new GraphExceptionRecord(record["TypeName"]!.GetValue<string>(), record["Message"]!.GetValue<string>(),
                record["HasParamName"]!.GetValue<bool>() ? record["ParamName"]!.GetValue<string>() : null,
                actual, record["HResult"]!.GetValue<int>(), record["InnerRef"]!.GetValue<int>());
            // Checks all inactive slots, presence metadata and scalar JSON types too.
            if (!JsonNode.DeepEquals(record, EncodeException(result)))
                throw new InvalidDataException("Exception payload has noncanonical or inconsistent typed slots.");
            return result;
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException or JsonException)
        { throw new InvalidDataException("Malformed typed exception payload.", error); }
    }
    private static void RequireKeys(JsonObject value, IEnumerable<string> keys)
    {
        var expected = keys.ToArray();
        if (value.Count != expected.Length || expected.Any(k => !value.ContainsKey(k) || value[k] == null))
            throw new InvalidDataException("Native graph record has missing, null or unknown fields.");
    }
}
