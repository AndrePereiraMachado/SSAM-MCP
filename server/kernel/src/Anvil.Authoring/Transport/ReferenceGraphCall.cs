using System.Text.Json.Nodes;

namespace Anvil.Authoring.Transport;

/// <summary>Compiler-bound call site. The transport invokes a native action; this class
/// only marshals data and reconciles caller identities before interpreting completion.</summary>
public sealed class ReferenceGraphCall(string action, IReadOnlyList<string> inputNames,
    IReadOnlyList<GraphShape> inputs, IReadOnlyList<GraphShape> results, IReadOnlyList<GraphDefinition> definitions, int abiVersion, IReadOnlyList<bool>? optionalInputs)
{
    public ReferenceGraphCall(string action, IReadOnlyList<string> inputNames, IReadOnlyList<GraphShape> inputs,
        IReadOnlyList<GraphShape> results, IReadOnlyList<GraphDefinition> definitions, int abiVersion)
        : this(action, inputNames, inputs, results, definitions, abiVersion, null) { }

    public ReferenceGraphCall(string action, IReadOnlyList<string> inputNames, IReadOnlyList<GraphShape> inputs,
        IReadOnlyList<GraphShape> results, IReadOnlyList<GraphDefinition> definitions)
        : this(action, inputNames, inputs, results, definitions, 2) { }

    public object? Invoke(IReadOnlyList<object?> arguments, Func<string, JsonObject, JsonObject> transport)
    {
        if (inputNames.Count != inputs.Count || inputNames.Distinct(StringComparer.Ordinal).Count() != inputNames.Count || results.Count > 1)
            throw new InvalidOperationException("Graph call descriptor differs from the supported source signature.");
        GraphExceptions.Version(abiVersion);
        if (optionalInputs != null && (optionalInputs.Count != inputs.Count || abiVersion < 4 && optionalInputs.Any(optional => optional)))
            throw new InvalidOperationException("Optional graph arguments require ABI4 and one descriptor per input.");
        if (abiVersion >= 3) return InvokeAbi3(arguments, transport);
        var session = new ReferenceGraphSession(definitions); var wire = new ReferenceGraphWire(definitions);
        var encoded = session.Encode(inputs, arguments); var rootValues = wire.EncodeRoots(encoded, inputs);
        var request = new JsonObject { ["AvGraphIn"] = wire.EncodeArenas(encoded) };
        for (var i = 0; i < inputs.Count; i++) request[inputNames[i]] = rootValues[i]?.DeepClone();
        var response = transport(action, request);
        var completion = response["AvCompletion"] as JsonObject ?? throw new InvalidDataException("Missing native graph completion.");
        var kind = completion["Kind"]?.GetValue<int>() ?? throw new InvalidDataException("Missing native completion kind.");
        if (kind is not (0 or 1 or 2)) throw new InvalidDataException("Unknown native completion kind.");
        // Validate completion before writeback as well; the business exception is raised
        // only after every original caller object has received its returned mutations.
        Exception? failure = kind == 2 ? Failure(response["AvErrors"] as JsonArray
            ?? throw new InvalidDataException("Missing native exception chain."), completion["ExceptionRef"]!.GetValue<int>()) : null;
        var roots = results.Count == 0 ? Array.Empty<JsonNode?>() : new[] { response["AvResult"] };
        var graph = wire.Decode(response["AvGraphOut"] as JsonObject ?? throw new InvalidDataException("Missing native output graph."), roots, results);
        var values = session.Reconcile(graph, results);
        if (failure != null) throw failure;
        return values.Count == 0 ? null : values[0];
    }

    private object? InvokeAbi3(IReadOnlyList<object?> arguments, Func<string, JsonObject, JsonObject> transport)
    {
        if (inputNames.Any(name => name is "AvGraphAbiIn" or "AvGraphAbiOut" or "AvGraphIn" or "AvGraphOut" or "AvCompletion" or "AvResult"))
            throw new InvalidOperationException("Source input collides with a generated graph protocol parameter.");
        var session = new ReferenceGraphSession(definitions, abiVersion); var wire = new ReferenceGraphWire(definitions, abiVersion);
        session.ValidateSignature(inputs.Concat(results));
        if (arguments.Count > inputs.Count) throw new ArgumentException("Too many graph call arguments.", nameof(arguments));
        var specified = Enumerable.Range(0, inputs.Count).Select(i => i < arguments.Count && !ReferenceEquals(arguments[i], Type.Missing)).ToArray();
        for (var i = 0; i < inputs.Count; i++)
            if (!specified[i] && optionalInputs?[i] != true) throw new ArgumentException("Missing required graph argument: " + inputNames[i], nameof(arguments));
        // Omitted arguments have no caller identity or value. Encode only supplied
        // roots; the native entry evaluates the compiler-bound source default.
        var suppliedShapes = inputs.Where((_, i) => specified[i]).ToArray();
        var suppliedArguments = arguments.Where((_, i) => specified[i]).ToArray();
        var encoded = session.Encode(suppliedShapes, suppliedArguments); var rootValues = wire.EncodeRoots(encoded, suppliedShapes);
        var request = new JsonObject { ["AvGraphAbiIn"] = abiVersion, ["AvGraphIn"] = wire.EncodeArenas(encoded) };
        var rootIndex = 0;
        for (var i = 0; i < inputs.Count; i++)
        {
            // An absent optional native input is its zero-initialized wrapper:
            // IsSpecified=false. Do not invent a source value or reproduce native
            // record defaults in the SDK (notably char's native Text default).
            if (!specified[i]) continue;
            var value = rootValues[rootIndex++]?.DeepClone();
            request[inputNames[i]] = optionalInputs?[i] == true
                ? new JsonObject { ["IsSpecified"] = true, ["Value"] = value } : value;
        }
        var response = transport(action, request);
        Keys(response, results.Count == 0 ? ["AvGraphAbiOut", "AvGraphOut", "AvCompletion"]
            : ["AvGraphAbiOut", "AvGraphOut", "AvCompletion", "AvResult"]);
        if (Integer(response, "AvGraphAbiOut") != abiVersion) throw new InvalidDataException("Native graph ABI negotiation mismatch.");
        var completion = response["AvCompletion"] as JsonObject ?? throw new InvalidDataException("Missing native graph completion.");
        Keys(completion, ["Kind", "ExceptionRef"]);
        var kind = Integer(completion, "Kind"); var exceptionRef = Integer(completion, "ExceptionRef");
        if (kind is not (0 or 1 or 2) || (kind == 2 ? exceptionRef <= 0 : exceptionRef != 0))
            throw new InvalidDataException("Invalid native exception completion.");
        // Failure has no business return. The generated native output still has a fixed
        // signature and must contain its canonical default, never another reachable root.
        if (kind == 2 && results.Count != 0) ReferenceGraphWire.RequireDefault(results[0], response["AvResult"]);
        IReadOnlyList<GraphShape> returnedShapes = kind == 2 ? [] : results;
        var roots = returnedShapes.Count == 0 ? Array.Empty<JsonNode?>() : new[] { response["AvResult"] };
        var graph = wire.Decode(response["AvGraphOut"] as JsonObject ?? throw new InvalidDataException("Missing native output graph."), roots, returnedShapes);
        var reconciled = session.Reconcile(graph, returnedShapes, kind == 2 ? new GraphHandle(GraphExceptions.Arena, exceptionRef) : null);
        if (reconciled.Failure != null) throw reconciled.Failure;
        return reconciled.Values.Count == 0 ? null : reconciled.Values[0];
    }
    private static int Integer(JsonObject record, string name)
    {
        try { return record[name]!.GetValue<int>(); }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException)
        { throw new InvalidDataException("Invalid native graph integer: " + name, error); }
    }
    private static void Keys(JsonObject record, string[] names)
    {
        if (record.Count != names.Length || names.Any(name => !record.ContainsKey(name) || record[name] == null))
            throw new InvalidDataException("Native graph response has missing, null or unknown fields.");
    }

    private static Exception Failure(JsonArray errors, int root)
    {
        if (root != 1 || errors.Count == 0) throw new InvalidDataException("Invalid native exception chain root.");
        Exception? inner = null;
        for (var i = errors.Count - 1; i >= 0; i--)
        {
            var item = errors[i] as JsonObject ?? throw new InvalidDataException("Invalid native exception record.");
            if (item["InnerRef"] is not JsonValue link || !link.TryGetValue<int>(out var innerRef)
                || innerRef != (i == errors.Count - 1 ? 0 : i + 2))
                throw new InvalidDataException("Invalid native exception chain link.");
            var type = item["TypeName"] is JsonValue name && name.TryGetValue<string>(out var text) ? text : null;
            inner = type switch
            {
                "System.InvalidOperationException" => new InvalidOperationException(LegacyMessage(), inner),
                "System.NullReferenceException" => new NullReferenceException(LegacyMessage(), inner),
                "System.IndexOutOfRangeException" => new IndexOutOfRangeException(LegacyMessage(), inner),
                "System.DivideByZeroException" => new DivideByZeroException(LegacyMessage(), inner),
                "System.OverflowException" => new OverflowException(LegacyMessage(), inner),
                "System.NotSupportedException" => new NotSupportedException(LegacyMessage(), inner),
                "System.Exception" => new Exception(LegacyMessage(), inner),
                _ => TypedFailure(item, inner, errors.Count)
            };
            string LegacyMessage() => item["Message"]!.GetValue<string>();
        }
        return inner!;

        // Preserve ABI2's original compact records above. Other supported types
        // require the complete canonical payload, including the observed BCL message.
        static Exception TypedFailure(JsonObject item, Exception? inner, int count)
        {
            var record = ReferenceGraphWire.DecodeException(item);
            GraphExceptions.Validate(record, count);
            return GraphExceptions.Create(record, inner);
        }
    }
}
