using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// C28 of the atritos 3 package (K2): the arguments of an event exist only once its Destination is set (the platform creates
/// one argument per input of the screen or action it points to), so `set &lt;x&gt;/&lt;Event&gt;/&lt;Arg&gt; Value` written before the
/// `set &lt;x&gt;/&lt;Event&gt; Destination` of the same event failed with "IBuiltinEvent 'OnClick' has no child 'Index'". The ops
/// still run in the order written, except such an argument, which runs right after the Destination of its event (the job
/// keeps its indices and pointers). Pure: the targets are compared as written (an alias with or without its $).
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The order the ops run in (their original indices). <paramref name="moved"/> hears each argument moved and the
    /// Destination it now follows.</summary>
    internal static int[] ArgumentOrder(JsonArray ops, Action<int, int>? moved = null)
    {
        static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : null;
        static string Key(string target) => target.StartsWith('$') ? target[1..] : target;
        var destinations = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && Text(op["op"]) == "set" && Text(op["prop"]) == "Destination" && Text(op["target"]) is { Length: > 0 } target)
                destinations.TryAdd(Key(target), i);
        var after = new Dictionary<int, List<int>>();
        var deferred = new HashSet<int>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || Text(op["op"]) != "set" || Text(op["prop"]) != "Value" || Text(op["target"]) is not { } target) continue;
            var slash = target.LastIndexOf('/');
            if (slash <= 0 || !destinations.TryGetValue(Key(target[..slash]), out var destination) || destination < i) continue;
            if (!after.TryGetValue(destination, out var list)) after[destination] = list = [];
            list.Add(i);
            deferred.Add(i);
        }
        if (deferred.Count == 0) return Enumerable.Range(0, ops.Count).ToArray();
        var order = new List<int>(ops.Count);
        for (var i = 0; i < ops.Count; i++)
        {
            if (deferred.Contains(i)) continue;
            order.Add(i);
            if (!after.TryGetValue(i, out var arguments)) continue;
            foreach (var argument in arguments) { order.Add(argument); moved?.Invoke(argument, i); }
        }
        return order.ToArray();
    }

    /// <summary>LF-09: what a call node (Execute Server/Client Action) or an event (its Destination or Handler) calls, with the
    /// names of its inputs and, for an element of a producer, the producer's name; null for any other owner.</summary>
    private static (string? Callee, IReadOnlyList<string> Inputs, string? Producer)? CalleeInputs(OutSystems.Model.IObjectSignature owner)
    {
        string? property = Implements(owner, "IExecuteServerActionNode") || Implements(owner, "IExecuteClientActionNode") ? "Action"
            : Implements(owner, "IEvent") || Implements(owner, "IBuiltinEvent") || owner.GetType().GetInterfaces().Any(i => i.Name.EndsWith("Event", StringComparison.Ordinal)) ? "Destination"
            : null;
        if (property == null) return null;
        var callee = ModelHost.Prop(owner, property) ?? (property == "Destination" ? ModelHost.Prop(owner, "Handler") : null);
        if (callee is not OutSystems.Model.IObjectSignature target) return (null, [], null);
        var inputs = target.Children.Where(c => c.GetType().GetInterfaces().Any(i => i.Name.Contains("InputParameter", StringComparison.Ordinal)))
            .Select(c => TypeResolver.Name(c)).OfType<string>().Where(n => n.Length > 0).ToArray();
        string? producer = null;
        for (var p = target.Parent as OutSystems.Model.IObjectSignature; p != null; p = p.Parent as OutSystems.Model.IObjectSignature)
            if (Implements(p, "IReference")) { producer = TypeResolver.Name(p); break; }
        return (Describe(target), inputs, producer);
    }
}
