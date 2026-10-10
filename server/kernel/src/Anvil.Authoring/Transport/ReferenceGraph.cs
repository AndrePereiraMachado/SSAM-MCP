using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace Anvil.Authoring.Transport;

// Compiler-generated caller metadata. FieldInfo identifies storage: serialization never
// invokes a source constructor, property getter, initializer, or business method.
public abstract record GraphShape;
public sealed record GraphScalar(Type Type) : GraphShape;
/// <summary>SDK Id&lt;T&gt; has scalar signed-integer transport. Only its fixed SDK
/// Value accessor and long constructor execute; the target/source type is never constructed.</summary>
public sealed record GraphIdentity(Type Type, int Bits) : GraphShape
{
    internal void Validate()
    {
        if (!Type.IsConstructedGenericType || Type.ContainsGenericParameters
            || Type.GetGenericTypeDefinition() != typeof(Id<>) || Bits is not (32 or 64))
            throw new ArgumentException("Identity shapes require the exact SDK Id<T> and a signed 32/64-bit native target.");
    }
    internal long NativeValue(object? value)
    {
        Validate();
        if (value is not long number || Bits == 32 && (number < int.MinValue || number > int.MaxValue))
            throw new InvalidDataException("Identity value is not an exact integer within the native target range.");
        return number;
    }
    internal long Encode(object? value)
    {
        Validate();
        if (value?.GetType() != Type) throw new InvalidDataException("Identity value differs from its exact SDK entity type.");
        return NativeValue(Type.GetProperty(nameof(Id<object>.Value))!.GetValue(value));
    }
    internal object Decode(object? value) => Activator.CreateInstance(Type, [NativeValue(value)])!;
}
public sealed record GraphOptional(GraphShape Value) : GraphShape;
public sealed record GraphReference(string Target) : GraphShape;
public sealed record GraphInline(Type Type, IReadOnlyList<GraphField> Fields) : GraphShape;
public sealed record GraphField(string Name, FieldInfo Storage, GraphShape Shape);
public sealed record GraphDefinition(string Name, Type Type, IReadOnlyList<GraphField> Fields, GraphShape? Element = null);
public readonly record struct GraphHandle(string Type, int Index);
public sealed record GraphRecord(IReadOnlyDictionary<string, object?> Fields);
public sealed record GraphSequence(IReadOnlyList<object?> Items, int? Version = null, int? Capacity = null);
public sealed record ReferenceGraph(IReadOnlyDictionary<string, IReadOnlyList<object>> Arenas, IReadOnlyList<object?> Roots);

/// <summary>
/// Caller-side identity bookkeeping for a typed graph boundary. Not a business interpreter
/// or a native action emitter. One session spans all input roots and one response; native
/// entry generation and source ABI bindings must supply the matching transport descriptor.
/// </summary>
public sealed class ReferenceGraphSession
{
    private readonly Dictionary<string, ClrListState> listStates = new(StringComparer.Ordinal);
    private readonly Dictionary<string, GraphDefinition> definitions;
    private readonly Dictionary<object, GraphHandle> identities = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<GraphHandle, object> originals = [];
    private readonly Dictionary<string, List<object>> arenas;
    private readonly Queue<(GraphHandle Handle, object Value)> pending = [];
    private bool encoded, completed;
    internal IReadOnlyDictionary<string, GraphDefinition> Definitions => definitions;
    internal int AbiVersion { get; }

    public ReferenceGraphSession(IEnumerable<GraphDefinition> definitions) : this(definitions, 2) { }

    public ReferenceGraphSession(IEnumerable<GraphDefinition> definitions, int abiVersion)
    {
        GraphExceptions.Version(abiVersion); AbiVersion = abiVersion;
        this.definitions = definitions.ToDictionary(d => d.Name, d => d with { Fields = FreezeFields(d.Fields), Element = d.Element == null ? null : FreezeShape(d.Element) }, StringComparer.Ordinal);
        if (abiVersion >= 3 && (this.definitions.ContainsKey(GraphExceptions.Arena)
            || this.definitions.Values.Any(d => typeof(Exception).IsAssignableFrom(d.Type))))
            throw new ArgumentException("ABI3 exceptions require the reserved exception arena and typed exception shape.");
        if (this.definitions.Values.Select(d => d.Type).Distinct().Count() != this.definitions.Count)
            throw new ArgumentException("One canonical graph definition is required per CLR reference type.");
        foreach (var d in this.definitions.Values)
        {
            if (!d.Type.IsClass || d.Type.IsAbstract || d.Type == typeof(string))
                throw new ArgumentException("A graph arena requires a concrete object, list or array type.");
            if (d.Element != null && (!typeof(IList).IsAssignableFrom(d.Type) || d.Fields.Count != 0))
                throw new ArgumentException("A sequence definition requires IList and no object fields.");
            if (d.Element == null && typeof(IList).IsAssignableFrom(d.Type))
                throw new ArgumentException("A sequence requires an element shape.");
            ValidateFields(d.Type, d.Fields);
            if (d.Element != null)
            {
                ValidateShape(d.Element);
                var elementType = d.Type.IsArray && d.Type.GetArrayRank() == 1 ? d.Type.GetElementType()
                    : d.Type.IsGenericType && d.Type.GetGenericTypeDefinition() == typeof(List<>) ? d.Type.GetGenericArguments()[0] : null;
                if (elementType == null || ShapeType(d.Element) != elementType)
                    throw new ArgumentException("Sequences require an exact framework List<T> or one-dimensional array element type.");
                if (!d.Type.IsArray) listStates.Add(d.Name, new ClrListState(d.Type));
            }
        }
        arenas = this.definitions.Keys.ToDictionary(k => k, _ => new List<object>(), StringComparer.Ordinal);
        if (abiVersion >= 3) arenas.Add(GraphExceptions.Arena, []);
    }

    public ReferenceGraph Encode(IReadOnlyList<GraphShape> shapes, IReadOnlyList<object?> values)
    {
        if (encoded) throw new InvalidOperationException("A graph session encodes one invocation.");
        if (shapes.Count != values.Count) throw new ArgumentException("Root count differs from the source signature.");
        encoded = true;
        var roots = shapes.Select((s, i) => EncodeValue(s, values[i])).ToArray();
        while (pending.TryDequeue(out var item))
        {
            if (AbiVersion >= 3 && item.Handle.Type == GraphExceptions.Arena)
            {
                arenas[item.Handle.Type][item.Handle.Index - 1] = GraphExceptions.Capture((Exception)item.Value,
                    value => ((GraphHandle)EncodeValue(new GraphException(typeof(Exception)), value)!).Index);
                continue;
            }
            var d = definitions[item.Handle.Type];
            object cell = d.Element == null
                ? EncodeRecord(d.Fields, item.Value)
                : new GraphSequence(((IList)item.Value).Cast<object?>().Select(v => EncodeValue(d.Element, v)).ToArray(),
                    listStates.GetValueOrDefault(item.Handle.Type)?.Version((IList)item.Value),
                    listStates.GetValueOrDefault(item.Handle.Type)?.Capacity((IList)item.Value));
            arenas[item.Handle.Type][item.Handle.Index - 1] = cell;
        }
        return new(arenas.ToDictionary(p => p.Key, p => (IReadOnlyList<object>)p.Value.ToArray(), StringComparer.Ordinal), roots);
    }

    /// <summary>Validate the complete reply before changing any caller object. Reserve all
    /// returned identities before filling cells; reconcile before the generated caller raises
    /// a returned completion. Parameter rebinding does not replace the caller's variable.</summary>
    public IReadOnlyList<object?> Reconcile(ReferenceGraph graph, IReadOnlyList<GraphShape> results)
        => Reconcile(graph, results, null).Values;

    public GraphReconciliation Reconcile(ReferenceGraph graph, IReadOnlyList<GraphShape> results, GraphHandle? failure)
    {
        if (!encoded || completed) throw new InvalidOperationException("A graph session reconciles one encoded invocation.");
        if (!graph.Arenas.Keys.Order(StringComparer.Ordinal).SequenceEqual(arenas.Keys.Order(StringComparer.Ordinal)))
            throw new InvalidDataException("Reply arena set differs from the frozen source schema.");
        if (graph.Roots.Count != results.Count) throw new InvalidDataException("Reply root count differs from the source signature.");
        foreach (var (name, cells) in graph.Arenas)
        {
            if (cells.Count < arenas[name].Count) throw new InvalidDataException("Reply omitted an original input identity.");
            if (AbiVersion >= 3 && name == GraphExceptions.Arena)
            {
                foreach (var cell in cells) GraphExceptions.Validate(cell as GraphExceptionRecord
                    ?? throw new InvalidDataException("Expected typed exception cell."), cells.Count);
                continue;
            }
            var d = definitions[name];
            for (var i = 0; i < cells.Count; i++)
            {
                if (d.Element == null) ValidateRecord(d.Fields, cells[i], graph);
                else
                {
                    var sequence = cells[i] as GraphSequence ?? throw new InvalidDataException("Expected sequence cell.");
                    if (d.Type.IsArray ? sequence.Version != null || sequence.Capacity != null
                        : sequence.Version == null || sequence.Capacity == null || sequence.Capacity < sequence.Items.Count)
                        throw new InvalidDataException("Reply sequence state differs from its array/list schema.");
                    if (originals.TryGetValue(new(name, i + 1), out var original) && original is Array array && array.Length != sequence.Items.Count)
                        throw new InvalidDataException("Reply resized an existing array identity.");
                    if (original is IList callerList && !d.Type.IsArray)
                    {
                        var captured = (GraphSequence)arenas[name][i]; var state = listStates[name];
                        if (state.Version(callerList) != captured.Version || state.Capacity(callerList) != captured.Capacity)
                            throw new InvalidDataException("Caller list changed while its remote invocation was running.");
                    }
                    foreach (var value in sequence.Items) ValidateValue(d.Element, value, graph);
                }
            }
        }
        for (var i = 0; i < results.Count; i++) ValidateValue(results[i], graph.Roots[i], graph);
        if (failure is { } root)
        {
            if (AbiVersion < 3 || root.Index == 0) throw new InvalidDataException("Failure requires a nonnull ABI3 exception identity.");
            ValidateValue(new GraphException(typeof(Exception)), root, graph);
        }
        ValidateReachability(graph, results, failure);
        var objects = new Dictionary<GraphHandle, object>(originals);
        if (AbiVersion >= 3) GraphExceptions.Prepare(graph.Arenas[GraphExceptions.Arena], originals, arenas[GraphExceptions.Arena], objects);
        completed = true;
        foreach (var (name, cells) in graph.Arenas)
        {
            if (AbiVersion >= 3 && name == GraphExceptions.Arena) continue;
            for (var i = 0; i < cells.Count; i++)
            {
                var handle = new GraphHandle(name, i + 1); var d = definitions[name];
                if (!objects.ContainsKey(handle)) objects.Add(handle, d.Element == null ? RuntimeHelpers.GetUninitializedObject(d.Type)
                    : d.Type.IsArray ? Array.CreateInstance(d.Type.GetElementType()!, ((GraphSequence)cells[i]).Items.Count)
                    : Activator.CreateInstance(d.Type)!);
            }
        }
        foreach (var (name, cells) in graph.Arenas)
        {
            if (AbiVersion >= 3 && name == GraphExceptions.Arena) continue;
            for (var i = 0; i < cells.Count; i++)
            {
                var target = objects[new(name, i + 1)]; var d = definitions[name];
                if (d.Element == null) Fill(d.Fields, target, (GraphRecord)cells[i], objects);
                else
                {
                    var values = ((GraphSequence)cells[i]).Items.Select(v => Decode(d.Element, v, objects)).ToArray();
                    var list = (IList)target;
                    if (target is Array) for (var j = 0; j < values.Length; j++) list[j] = values[j];
                    else
                    {
                        var sequence = (GraphSequence)cells[i];
                        list.Clear(); foreach (var value in values) list.Add(value);
                        listStates[name].Restore(list, sequence.Version!.Value, sequence.Capacity!.Value);
                    }
                }
            }
        }
        return new(results.Select((s, i) => Decode(s, graph.Roots[i], objects)).ToArray(),
            failure is { } failed ? (Exception)objects[failed] : null);
    }

    private object? EncodeValue(GraphShape shape, object? value)
    {
        ValidateShape(shape);
        switch (shape)
        {
            case GraphOptional optional: return value == null ? null : EncodeValue(optional.Value, value);
            case GraphScalar scalar: ValidateScalar(scalar, value); return value;
            case GraphTemporal temporal: return temporal.Encode(value);
            case GraphIdentity identity: return identity.Encode(value);
            case GraphInline inline:
                if (value?.GetType() != inline.Type) throw new ArgumentException("Inline source value has the wrong type.");
                return EncodeRecord(inline.Fields, value);
            case GraphException exception:
                if (value == null) return new GraphHandle(GraphExceptions.Arena, 0);
                GraphExceptions.ValidateType(value.GetType());
                if (!exception.Type.IsInstanceOfType(value)) throw new ArgumentException("Exception runtime type differs from its declared type.");
                return Intern(GraphExceptions.Arena, value);
            case GraphReadOnlyList view:
                if (value == null) return view.Handle(0, 0);
                if (value.GetType() == definitions[view.ListTarget].Type) return Intern(view.ListTarget, value);
                if (value.GetType() == definitions[view.ArrayTarget].Type) return Intern(view.ArrayTarget, value);
                throw new ArgumentException("Readonly-list source values require the exact declared List<T> or T[] runtime type.");
            case GraphReference reference:
                if (value == null) return new GraphHandle(reference.Target, 0);
                var definition = definitions[reference.Target];
                if (value.GetType() != definition.Type) throw new ArgumentException("Reference source value has the wrong runtime type.");
                return Intern(reference.Target, value);
            default: throw new ArgumentException("Unknown graph shape.");
        }
    }
    private GraphHandle Intern(string arena, object value)
    {
        if (identities.TryGetValue(value, out var known)) return known;
        var handle = new GraphHandle(arena, arenas[arena].Count + 1);
        identities.Add(value, handle); originals.Add(handle, value); arenas[arena].Add(null!); pending.Enqueue((handle, value));
        return handle;
    }
    private GraphRecord EncodeRecord(IReadOnlyList<GraphField> fields, object value)
        => new(fields.ToDictionary(f => f.Name, f => EncodeValue(f.Shape, f.Storage.GetValue(value)), StringComparer.Ordinal));
    private static object? Decode(GraphShape shape, object? value, IReadOnlyDictionary<GraphHandle, object> objects)
    {
        if (shape is GraphOptional optional) return value == null ? null : Decode(optional.Value, value, objects);
        if (shape is GraphScalar) return value;
        if (shape is GraphTemporal temporal) return temporal.Decode(value);
        if (shape is GraphIdentity identity) return identity.Decode(value);
        if (shape is GraphReference or GraphException or GraphReadOnlyList) { var handle = (GraphHandle)value!; return handle.Index == 0 ? null : objects[handle]; }
        var inline = (GraphInline)shape; var target = RuntimeHelpers.GetUninitializedObject(inline.Type);
        Fill(inline.Fields, target, (GraphRecord)value!, objects); return target;
    }
    private static void Fill(IReadOnlyList<GraphField> fields, object target, GraphRecord record, IReadOnlyDictionary<GraphHandle, object> objects)
    { foreach (var f in fields) f.Storage.SetValue(target, Decode(f.Shape, record.Fields[f.Name], objects)); }
    private void ValidateReachability(ReferenceGraph graph, IReadOnlyList<GraphShape> results, GraphHandle? failure)
    {
        var reached = new HashSet<GraphHandle>(); var queue = new Queue<GraphHandle>();
        void Touch(GraphHandle handle) { if (handle.Index != 0 && reached.Add(handle)) queue.Enqueue(handle); }
        void Value(GraphShape shape, object? value)
        {
            if (shape is GraphOptional optional) { if (value != null) Value(optional.Value, value); }
            else if (shape is GraphReference or GraphException or GraphReadOnlyList) Touch((GraphHandle)value!);
            else if (shape is GraphInline inline)
                foreach (var field in inline.Fields) Value(field.Shape, ((GraphRecord)value!).Fields[field.Name]);
        }
        // Detached imported identities still belong to the caller. New identities must be
        // reachable from those originals or the actual result, never from hidden locals.
        foreach (var handle in originals.Keys) Touch(handle);
        for (var i = 0; i < results.Count; i++) Value(results[i], graph.Roots[i]);
        if (failure is { } failed) Touch(failed);
        while (queue.TryDequeue(out var handle))
        {
            if (AbiVersion >= 3 && handle.Type == GraphExceptions.Arena)
            {
                Touch(new(GraphExceptions.Arena, ((GraphExceptionRecord)graph.Arenas[handle.Type][handle.Index - 1]).InnerRef));
                continue;
            }
            var definition = definitions[handle.Type]; var cell = graph.Arenas[handle.Type][handle.Index - 1];
            if (definition.Element == null)
                foreach (var field in definition.Fields) Value(field.Shape, ((GraphRecord)cell).Fields[field.Name]);
            else foreach (var item in ((GraphSequence)cell).Items) Value(definition.Element, item);
        }
        if (reached.Count != graph.Arenas.Sum(a => a.Value.Count))
            throw new InvalidDataException("Reply includes identities outside the caller/result graph.");
    }
    private void ValidateValue(GraphShape shape, object? value, ReferenceGraph graph)
    {
        ValidateShape(shape);
        if (shape is GraphOptional optional) { if (value != null) ValidateValue(optional.Value, value, graph); return; }
        if (shape is GraphScalar scalar) { ValidateScalar(scalar, value); return; }
        if (shape is GraphTemporal temporal) { temporal.Checked(value); return; }
        if (shape is GraphIdentity identity) { identity.NativeValue(value); return; }
        if (shape is GraphInline inline) { ValidateRecord(inline.Fields, value, graph); return; }
        if (shape is GraphReadOnlyList view)
        {
            view.Kind(value); var handle = (GraphHandle)value!;
            if (handle.Index > graph.Arenas[handle.Type].Count)
                throw new InvalidDataException("Reply readonly-list handle has an invalid index.");
            return;
        }
        if (shape is GraphException exception)
        {
            if (value is not GraphHandle handle || handle.Type != GraphExceptions.Arena || handle.Index < 0
                || handle.Index > graph.Arenas[GraphExceptions.Arena].Count)
                throw new InvalidDataException("Invalid exception arena or index.");
            if (handle.Index != 0 && (graph.Arenas[GraphExceptions.Arena][handle.Index - 1] is not GraphExceptionRecord record
                || !exception.Type.IsAssignableFrom(GraphExceptions.Resolve(record.TypeName))))
                throw new InvalidDataException("Exception runtime type differs from the declared graph type.");
            return;
        }
        var reference = (GraphReference)shape;
        if (value is not GraphHandle h || h.Type != reference.Target || h.Index < 0 || h.Index > graph.Arenas[h.Type].Count)
            throw new InvalidDataException("Reply reference has an invalid arena or index.");
    }
    private void ValidateRecord(IReadOnlyList<GraphField> fields, object? value, ReferenceGraph graph)
    {
        if (value is not GraphRecord record || record.Fields.Count != fields.Count || fields.Any(f => !record.Fields.ContainsKey(f.Name)))
            throw new InvalidDataException("Reply record differs from the frozen source fields.");
        foreach (var f in fields) ValidateValue(f.Shape, record.Fields[f.Name], graph);
    }
    private void ValidateFields(Type owner, IReadOnlyList<GraphField> fields)
    {
        if (fields.Select(f => f.Name).Distinct(StringComparer.Ordinal).Count() != fields.Count) throw new ArgumentException("Duplicate graph field.");
        foreach (var f in fields)
        {
            if (f.Storage.IsStatic || f.Storage.DeclaringType != owner) throw new ArgumentException("Graph fields must identify source instance storage.");
            ValidateShape(f.Shape);
            var type = ShapeType(f.Shape);
            if (type != f.Storage.FieldType) throw new ArgumentException("Graph field storage and shape differ.");
        }
    }
    private Type? ShapeType(GraphShape shape) => shape switch
    { GraphScalar s => s.Type, GraphTemporal s => s.Type, GraphIdentity s => s.Type, GraphInline s => s.Type, GraphException s => s.Type, GraphReference s => definitions[s.Target].Type,
        GraphReadOnlyList s => s.Validate(definitions),
        GraphOptional s => typeof(Nullable<>).MakeGenericType(ShapeType(s.Value)!), _ => null };
    private static IReadOnlyList<GraphField> FreezeFields(IReadOnlyList<GraphField> fields)
        => fields.Select(f => f with { Shape = FreezeShape(f.Shape) }).ToArray();
    private static GraphShape FreezeShape(GraphShape shape)
        => shape switch { GraphInline inline => inline with { Fields = FreezeFields(inline.Fields) },
            GraphOptional optional => optional with { Value = FreezeShape(optional.Value) }, _ => shape };
    internal void ValidateSignature(IEnumerable<GraphShape> shapes)
    {
        foreach (var shape in shapes) ValidateShape(shape);
    }
    private void ValidateShape(GraphShape shape)
    {
        switch (shape)
        {
            case GraphOptional optional:
                ValidateShape(optional.Value);
                if (optional.Value is GraphOptional || ShapeType(optional.Value)?.IsValueType != true)
                    throw new ArgumentException("Nullable graph values require a nonnullable source value type.");
                return;
            case GraphReference r when definitions.ContainsKey(r.Target): return;
            case GraphException s when AbiVersion >= 3: GraphExceptions.ValidateType(s.Type); return;
            case GraphIdentity s: s.Validate(); return;
            case GraphTemporal s when AbiVersion >= 4: s.Validate(); return;
            case GraphReadOnlyList s when AbiVersion >= 4: s.Validate(definitions); return;
            case GraphScalar s when s.Type == typeof(string) || s.Type.IsPrimitive || s.Type.IsEnum || s.Type == typeof(decimal): return;
            case GraphInline s when s.Type.IsValueType && !GraphTemporal.Types.Values.Contains(s.Type): ValidateFields(s.Type, s.Fields); return;
            default: throw new ArgumentException("Unsupported or unresolved graph shape.");
        }
    }
    private static void ValidateScalar(GraphScalar shape, object? value)
    {
        if (value == null && shape.Type == typeof(string)) return;
        if (value?.GetType() != shape.Type) throw new InvalidDataException("Graph scalar differs from the source type.");
    }
}
