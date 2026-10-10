namespace Anvil.Authoring.Transport;

/// <summary>A typed view of the same canonical framework List&lt;T&gt; or T[] identity.
/// The view owns no arena and never allocates a wrapper or a copied collection.</summary>
public sealed record GraphReadOnlyList(string ListTarget, string ArrayTarget) : GraphShape
{
    internal Type Validate(IReadOnlyDictionary<string, GraphDefinition> definitions)
    {
        if (!definitions.TryGetValue(ListTarget, out var list) || !definitions.TryGetValue(ArrayTarget, out var array)
            || !list.Type.IsConstructedGenericType || list.Type.GetGenericTypeDefinition() != typeof(List<>)
            || list.Type.ContainsGenericParameters || list.Element == null || list.Fields.Count != 0
            || array.Type != list.Type.GetGenericArguments()[0].MakeArrayType() || array.Element == null || array.Fields.Count != 0)
            throw new ArgumentException("A readonly-list view requires canonical exact List<T> and T[] arenas with the same element type.");
        if (!EquivalentElements(list.Element, array.Element))
            throw new ArgumentException("A readonly-list view requires equivalent list and array element graph shapes.");
        return typeof(IReadOnlyList<>).MakeGenericType(list.Type.GetGenericArguments()[0]);
    }

    private static bool EquivalentElements(GraphShape left, GraphShape right)
    {
        var pending = new Stack<(GraphShape Left, GraphShape Right)>();
        var visited = new Dictionary<GraphShape, HashSet<GraphShape>>(ReferenceEqualityComparer.Instance);
        pending.Push((left, right));
        while (pending.TryPop(out var pair))
        {
            if (ReferenceEquals(pair.Left, pair.Right)) continue;
            if (!visited.TryGetValue(pair.Left, out var matches))
                visited.Add(pair.Left, matches = new(ReferenceEqualityComparer.Instance));
            if (!matches.Add(pair.Right)) continue;
            // Arena names identify canonical definitions. Do not expand them here:
            // a source object can point through its fields back to this same view.
            switch (pair)
            {
                case (GraphScalar a, GraphScalar b) when a.Type == b.Type: break;
                case (GraphTemporal a, GraphTemporal b) when a.Type == b.Type: break;
                case (GraphIdentity a, GraphIdentity b) when a.Type == b.Type && a.Bits == b.Bits: break;
                case (GraphException a, GraphException b) when a.Type == b.Type: break;
                case (GraphReference a, GraphReference b) when a.Target == b.Target: break;
                case (GraphReadOnlyList a, GraphReadOnlyList b) when a.ListTarget == b.ListTarget && a.ArrayTarget == b.ArrayTarget: break;
                case (GraphOptional a, GraphOptional b): pending.Push((a.Value, b.Value)); break;
                case (GraphInline a, GraphInline b) when a.Type == b.Type && a.Fields.Count == b.Fields.Count:
                    var fields = new Dictionary<string, GraphField>(StringComparer.Ordinal);
                    foreach (var field in b.Fields) if (!fields.TryAdd(field.Name, field)) return false;
                    foreach (var field in a.Fields)
                    {
                        if (!fields.TryGetValue(field.Name, out var other) || !field.Storage.Equals(other.Storage)) return false;
                        pending.Push((field.Shape, other.Shape));
                    }
                    break;
                default: return false;
            }
        }
        return true;
    }

    internal GraphHandle Handle(int kind, int index) => kind switch
    {
        0 when index == 0 => new(ListTarget, 0),
        1 when index > 0 => new(ListTarget, index),
        2 when index > 0 => new(ArrayTarget, index),
        _ => throw new InvalidDataException("Invalid readonly-list kind or index.")
    };

    internal int Kind(object? value)
    {
        if (value is not GraphHandle handle || handle.Index < 0)
            throw new InvalidDataException("Expected a canonical readonly-list handle.");
        if (handle.Type == ListTarget) return handle.Index == 0 ? 0 : 1;
        if (handle.Type == ArrayTarget && handle.Index > 0) return 2;
        throw new InvalidDataException("Invalid readonly-list arena or noncanonical null handle.");
    }
}
