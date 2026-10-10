using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// Bindings the kernel keeps instead of refusing (C09, C21): the arguments of an execute node or event handler follow a new
/// Action/Handler by parameter name; a Refresh Data without MaxRecords takes the one of the aggregate it refreshes; a system
/// exception answers to the names people write (All Exceptions, AllExceptions, DatabaseException); a node without a name
/// answers to its Label; an If answers to True/False for its branches.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The arguments before a new Action/Handler is written: values by parameter name, names by argument.</summary>
    private sealed record CapturedArguments(Dictionary<string, string> Values, Dictionary<object, string> Names);

    private static CapturedArguments? CaptureArguments(object target)
    {
        if (target is not IObjectSignature owner) return null;
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var names = new Dictionary<object, string>(ReferenceEqualityComparer.Instance);
        foreach (var child in owner.Children)
        {
            if (ArgumentName(child) is not { } name) continue;
            names[child] = name;
            if (ArgumentValue(child) is { Text.Length: > 0 } expression) values[name] = expression.Text;
        }
        return new(values, names);
    }

    /// <summary>A node as a report names it: the Label of a node without a name (an Assign, an If).</summary>
    private static string Named(object o)
        => string.IsNullOrEmpty(TypeResolver.Name(o)) && LabelOf(o) is { Length: > 0 } label ? $"{ShortType(o)} '{label}'" : Describe(o);

    private static IExpression? ArgumentValue(object argument)
    {
        try { return UiCatalog.Prop(argument, "Value") as IExpression; } catch { return null; }
    }

    /// <summary>After a new Action/Handler: each argument whose parameter keeps its name gets its old value back (when the
    /// platform left it empty), each argument without a parameter of the new target goes. The report names both.</summary>
    private JsonObject? RebindArguments(object target, object? newTarget, CapturedArguments captured)
    {
        var before = captured.Values;
        if (target is not IObjectSignature owner) return null;
        var parameters = newTarget is IObjectSignature action
            ? action.Children.Where(c => c.GetType().GetInterfaces().Any(i => i.Name.Contains("InputParameter", StringComparison.Ordinal) || i.Name == "IParameter"))
                .ToHashSet(ReferenceEqualityComparer.Instance)
            : null;
        var restored = new JsonArray(); var removed = new JsonArray(); var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var child in owner.Children.ToArray())
        {
            var property = child.GetType().GetProperty("Parameter", BindingFlags.Public | BindingFlags.Instance);
            if (property == null) continue;
            object? parameter;
            try { parameter = property.GetValue(child); } catch { parameter = null; }
            var name = parameter == null ? null : TypeResolver.Name(parameter);
            if (parameter == null || (parameters is { Count: > 0 } && !parameters.Contains(parameter)))
            {
                EsquecerApagado(child);
                try { child.Delete(); removed.Add((JsonNode)(name ?? captured.Names.GetValueOrDefault(child) ?? "(no parameter)")); } catch { /* the platform keeps it: Verify names it */ }
                continue;
            }
            if (name == null) continue;
            present.Add(name);
            if (before.TryGetValue(name, out var text) && ArgumentValue(child) is { } expression && string.IsNullOrEmpty(expression.Text))
            {
                expression.Text = text;
                restored.Add((JsonNode)name);
            }
        }
        var dropped = new JsonArray(before.Keys.Where(k => !present.Contains(k)).OrderBy(k => k, StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray());
        return restored.Count + removed.Count + dropped.Count == 0 ? null
            : new JsonObject { ["restored"] = restored, ["removed"] = removed, ["droppedValues"] = dropped };
    }

    /// <summary>The Max. Records of the aggregate a Refresh Data refreshes, or 50 when it is empty: the value the ODC native
    /// merge keeps for the node. C17 (atritos 3): a Data Action has no Max. Records and the merge removes any value from its
    /// Refresh Data (labs 21, 22, 24: `Max. Records[] / Max. Records[50] [RemovedFromLocal]`), so it is left empty.</summary>
    private static string RefreshMaxRecords(object refresh)
    {
        object? source = null;
        try { source = UiCatalog.Prop(refresh, "DataSource"); } catch { }
        if (source != null && (Implements(source, "IDataAction") || FindProperty(source, "MaxRecords") == null)) return "";
        string? text = null;
        try { text = source == null ? null : (UiCatalog.Prop(source, "MaxRecords") as IExpression)?.Text; } catch { }
        return string.IsNullOrWhiteSpace(text) ? "50" : text.Trim();
    }

    /// <summary>A system exception by the name people write: spaces, case and the Exception(s) suffix do not matter.</summary>
    private IObjectSignature? SystemExceptionNamed(string name)
    {
        var wanted = ValueAliases.SystemExceptionKey(name);
        return Descendants().FirstOrDefault(d => Implements(d, "ISystemException") && ValueAliases.SystemExceptionKey(TypeResolver.Name(d) ?? "") == wanted);
    }

    /// <summary>The names of the module (and its references) of a type: what a refusal offers as the closest names.</summary>
    internal IEnumerable<string> NamesOfType(string type) => Descendants()
        .Where(d => type.Length == 0 || Implements(d, type) || Implements(d, type + "Signature"))
        .Select(d => TypeResolver.Name(d) is { Length: > 0 } n ? n : LabelOf(d)).OfType<string>().Where(n => n.Length > 0).Distinct(StringComparer.Ordinal);

    private static string? LabelOf(object o)
    {
        try { return o.GetType().GetProperty("Label", BindingFlags.Public | BindingFlags.Instance)?.GetValue(o) as string; } catch { return null; }
    }

    /// <summary>The name a reference matches: Name, or the Label of an element without a name (If, Assign, For Each, ...).</summary>
    private static bool AnswersTo(object o, string name)
    {
        var own = TypeResolver.Name(o);
        return string.IsNullOrEmpty(own) ? string.Equals(LabelOf(o), name, StringComparison.OrdinalIgnoreCase) : string.Equals(own, name, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>C21 fallbacks of a path segment, after the direct children: True/False of an If, then one descendant that
    /// answers to the name (Name, or Label without a name). Two descendants are ambiguous and named.</summary>
    private object? ResolveChildFallback(IObjectSignature owner, string childName)
    {
        if (childName.Equals("True", StringComparison.OrdinalIgnoreCase) || childName.Equals("False", StringComparison.OrdinalIgnoreCase))
        {
            // An If node links its branches (TrueTarget/FalseTarget); an If widget holds them (TrueBranch/FalseBranch, C30).
            var yes = childName.Equals("True", StringComparison.OrdinalIgnoreCase);
            foreach (var branch in yes ? new[] { "TrueTarget", "TrueBranch" } : ["FalseTarget", "FalseBranch"])
                if (FindProperty(owner, branch) is { CanRead: true } target)
                    return target.GetValue(owner) ?? throw new KeyNotFoundException($"{Describe(owner)} has no {branch} yet (link the branch first)");
        }
        foreach (var c in owner.Children) if (string.IsNullOrEmpty(TypeResolver.Name(c)) && string.Equals(LabelOf(c), childName, StringComparison.OrdinalIgnoreCase)) return c;
        if (UiCatalog.Prop(owner, childName) is IObjectSignature viaProp) return viaProp;
        var hits = owner.GetAllDescendantsOfType<IObjectSignature>().Where(d => AnswersTo(d, childName)).Take(3).ToArray();
        if (hits.Length == 1) return hits[0];
        if (hits.Length > 1)
            throw new KeyNotFoundException($"{Describe(owner)} has no child '{childName}', and {hits.Length}+ descendants answer to it: "
                + string.Join("; ", hits.Select(h => ModelHost.PathOf(h))) + " (write the path through their parents, or use @key)");
        return null;
    }
}
