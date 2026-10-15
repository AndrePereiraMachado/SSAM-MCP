using System.Text.Json.Nodes;

namespace Anvil.Core;

// The part of AggregateSortRule that reads the model or the built-in catalog (Preflight, MessageExpectations, ModelApiMetadata):
// compiled by Anvil.Core and Anvil.Core.Odc only. AggregateSortRule.cs stays text only, so the ODC builder can link it with
// FlowParse.cs without the publication and preflight types.
public static partial class AggregateSortRule
{
    /// <summary>Whether the database runs every function the expression calls (each one a built-in of the lane the server, or
    /// client, aggregates run): only then can the expression be a calculated column of an aggregate. Unknown functions (the
    /// module's, a role check) and a lane without its catalog answer false: a patch is offered only when it is certain
    /// (`CALC SortKey=EncodeHtml(...)` would be refused by the Verify: InvalidArgumentForExternalFunction).</summary>
    public static bool RunsInDatabase(string expression, bool client = false)
    {
        // The lane's own registry; without it (a process that asked before its Studio was bound), the checked-in catalog: which
        // built-ins the database runs is the same on both platforms.
        var builtins = Preflight.Builtins.For(MessageExpectations.Lane) ?? Preflight.Builtins.For("o11");
        if (builtins == null) return false;
        foreach (var call in Preflight.ExpressionText.Calls(expression))
            if (!builtins.TryGetValue(call.Name, out var fact) || !(client ? fact.ClientAggregates : fact.ServerAggregates)) return false;
        return true;
    }
}

public sealed partial class ModelSession
{
    // The sorts whose Attribute a normalization rewrote with the direction reversed (`-X`): the direction the job declared for
    // each, so a SortDirection written before or after the Attribute ends as the declared one reversed, in any order.
    private readonly Dictionary<object, (bool Flip, string Declared)> _sortFlips = new(ReferenceEqualityComparer.Instance);

    /// <summary>The Attribute written on an ISort that is not dynamic, as the Studio writes it (AggregateSortRule): a certain
    /// form becomes the attribute (the direction reversed when the form says so), reported in expressionRewrites and in the
    /// notes; anything else is written as given and the checagem de compilação refuses it at the end of the apply.</summary>
    private string SortAttribute(object sort, string text, string path)
    {
        if (ModelHost.Prop(sort, "IsDynamic") is true) return text;
        var key = AggregateSortRule.Normalize(text);
        // Only a form whose attribute is in the aggregate's scope is that attribute (`If(Fav, 0, 1)` with Fav an input is not a
        // sort by Fav): otherwise the text is written as given and the checagem de compilação refuses it with its own words.
        if (key is { Steps.Count: > 0 } && sort is OutSystems.Model.IObjectSignature element && CompileCheck.AggregateOf(element) is { } aggregate)
        {
            var scope = CompileCheck.ScopeOf(aggregate);
            if (AggregateSortRule.OutOfScope(key.Attribute, scope.Sources, scope.Columns) != null || AggregateSortRule.OutOfGroup(key.Attribute, scope.Grouped, scope.GroupKeys) != null)
                key = null;
        }
        var current = ModelHost.Prop(sort, "SortDirection")?.ToString() ?? "Ascending";
        var known = _sortFlips.TryGetValue(sort, out var state);
        var declared = known ? state.Declared : current;
        var flip = key?.Flip ?? false;
        if (key is { Steps.Count: > 0 })
        {
            var direction = flip ? AggregateSortRule.Reverse(declared) : declared;
            Report("expressionRewrites", path + "/Attribute", text, key.Attribute + (direction == "Descending" ? " (SortDirection Descending)" : ""));
            Note(AggregateSortRule.NormalizedCode, $"{path}: the sort '{text}' is written as the Studio writes it, the attribute {key.Attribute} with SortDirection {direction}: {string.Join("; ", key.Steps)}");
            text = key.Attribute;
        }
        if (flip || known)
        {
            _sortFlips[sort] = (flip, declared);
            var wanted = flip ? AggregateSortRule.Reverse(declared) : declared;
            if (!string.Equals(wanted, current, StringComparison.OrdinalIgnoreCase)) WriteSortDirection(sort, wanted);
        }
        return text;
    }

    /// <summary>A SortDirection written on a sort whose Attribute a normalization reversed: the declared direction, reversed.</summary>
    private JsonNode? SortDirectionValue(object sort, JsonNode? value)
    {
        if (!_sortFlips.TryGetValue(sort, out var state) || value is not JsonValue v || !v.TryGetValue<string>(out var declared)) return value;
        _sortFlips[sort] = (state.Flip, declared);
        return state.Flip ? JsonValue.Create(AggregateSortRule.Reverse(declared)) : value;
    }

    private static void WriteSortDirection(object sort, string direction)
    {
        var property = ModelApiMetadata.Properties(sort.GetType()).FirstOrDefault(p => p.Name == "SortDirection" && p.CanWrite);
        if (property == null) return;
        property.SetValue(sort, Enum.Parse(property.PropertyType, direction, ignoreCase: true));
    }
}
