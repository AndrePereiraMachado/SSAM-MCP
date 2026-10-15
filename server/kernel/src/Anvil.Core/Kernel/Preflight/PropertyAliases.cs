using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12), class C11 of the refusals found only at apply: a `set` that names a property by the name another
/// element of the same family uses is written to the one property this element has for it, and listed (PROPERTY_ALIASED),
/// never refused. Only pairs where the element has no property of the written name and the other name is writable on it
/// (the Model API of the bound Studio says so: <see cref="ModelTypes"/>), so nothing ambiguous is rewritten:
/// <list type="bullet">
/// <item>Handler on a lifecycle event (IUILifeCycleEvent: OnInitialize, OnReady, OnRender, OnDestroy, OnParametersChanged,
/// OnAfterFetch) is its Destination (FolhaPonto_UI, 2026-10-12 13:59:19: three `set Handler` refused one round after the
/// rest); Destination on a widget event (IEvent) is its Handler.</item>
/// <item>Name on an extended property (IExtendedProperty) is its Property: the attribute name (C16).</item>
/// </list>
/// The pure preflight rewrites the sets whose target type it knows (an alias of a create, a `Kind:Name`, or a
/// `Kind:Name/Child` whose child is a property of the kind, as IDataAction:X/OnAfterFetch); the apply rewrites the rest on the
/// resolved element (Verbs.Set).
/// </summary>
public static class PropertyAliases
{
    public const string Rule = "PROPERTY_ALIASED";

    /// <summary>(interface short name, written property) -> the property it means.</summary>
    private static readonly Dictionary<(string Type, string From), string> Table = new()
    {
        [("IUILifeCycleEvent", "Handler")] = "Destination",
        [("IEvent", "Destination")] = "Handler",
        [("IExtendedProperty", "Name")] = "Property",
    };

    /// <summary>The lifecycle events by name (properties of screens, blocks and data actions typed IUILifeCycleEvent), for a
    /// target path when the Model API cannot type it (no Studio bound): the alias is still checked against the event type.</summary>
    private static readonly HashSet<string> LifecycleEvents = new(StringComparer.Ordinal)
        { "OnInitialize", "OnReady", "OnRender", "OnDestroy", "OnParametersChanged", "OnAfterFetch" };

    /// <summary>The property <paramref name="prop"/> means on an element of these interfaces (short names), or null.</summary>
    public static string? Meant(IEnumerable<string> interfaces, string prop)
    {
        foreach (var type in interfaces)
            if (Table.TryGetValue((type.Split('.').Last(), prop), out var to)) return to;
        return null;
    }

    /// <summary>The alias of <paramref name="prop"/> on <paramref name="type"/> when the Model API confirms it: the type has no
    /// property, setter or parser of that name and the other one is writable. Unknown type: null.</summary>
    public static string? Confirmed(string type, string prop, string lane)
    {
        var shortName = type.Split('.').Last();
        if (!Table.TryGetValue((shortName, prop), out var to)) return null;
        if (ModelTypes.Of(shortName, lane) is not { } facts) return null;
        if (facts.Knows(prop) || !facts.Writable().Contains(to, StringComparer.Ordinal)) return null;
        return to;
    }

    /// <summary>The type of a `set` target the job alone tells: the create that registered the alias, `Kind:Name`, or
    /// `Kind:Name/Child...` whose children are properties of the type (each typed by the Model API), with the lifecycle event
    /// names as the last resort.</summary>
    internal static string? TypeOfTarget(string target, IReadOnlyDictionary<string, string> aliases, string lane)
    {
        if (PropertyRules.TypeOf(target, aliases) is { } direct) return direct;
        if (target.StartsWith('@') || !target.Contains('/')) return null;
        var segments = target.Split('/');
        string? type = null;
        if (aliases.TryGetValue(segments[0], out var aliased)) type = aliased;
        else if (ModelSession.AliasCounterpart(segments[0]) is { } other && aliases.TryGetValue(other, out aliased)) type = aliased;
        else if (segments[0].IndexOf(':') is var colon and > 0)
        {
            var kind = KindNames.Normalize(segments[0][..colon]);
            if (KindNames.LooksLikeInterface(kind)) type = kind;
        }
        if (type == null) return null;
        for (var k = 1; k < segments.Length; k++)
        {
            var child = segments[k];
            if (child.Contains(':')) return null;
            var property = ModelTypes.Of(type, lane)?.Properties.FirstOrDefault(p => p.Name == child);
            if (property == null)
                return k == segments.Length - 1 && LifecycleEvents.Contains(child) ? "IUILifeCycleEvent" : null;
            type = property.Type.Split('.').Last();
        }
        return type;
    }

    /// <summary>The pure normalization: every raw `set` of the job whose target type is known and whose property is an alias
    /// confirmed on that type is rewritten in place, and listed.</summary>
    public static void Normalize(JsonArray ops, string? prefix, string lane, List<JsonObject> done)
    {
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            if (kind == "create" && op["as"] is JsonValue a && a.TryGetValue<string>(out var alias) && op["type"]?.ToString() is { Length: > 0 } createdType)
                aliases[alias] = createdType;
            if (kind != "set" || op["target"]?.ToString() is not { Length: > 0 } target || op["prop"]?.ToString() is not { Length: > 0 } prop) continue;
            if (TypeOfTarget(target, aliases, lane) is not { } type) continue;
            if (Confirmed(type, prop, lane) is not { } to) continue;
            op["prop"] = to;
            done.Add(JobNormalizer.Entry(Rule, prefix == null ? null : $"{prefix}/{i}/prop", prop, to,
                $"{type.Split('.').Last()} {target} has no property {prop}; the one it has for it is {to}"));
        }
    }
}
