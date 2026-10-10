using System.Reflection;
using System.Text.Json.Nodes;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;

// Copy of kernel/src/Anvil.Core/Kernel/MergeOrder.cs, so the bridge carries no type of the kernel's namespace (the agent
// pack's IP scan, docs/O11-BRIDGE-FINA.md 6.4 and 6.5): global namespace, internal, same names, so engine/NativeMergeOrder.cs
// and StartupHook.cs read the same in the bridge and in kernel/tests/Anvil.Tests.Odc (which binds the kernel's types).
// platforms/odc/tests/public-signature-drift.test.mjs keeps the bodies equal.
/// <summary>A default value the native merge would drop, delivered by a second native merge in the same delivery.
/// Key is the full model key (matching between base, candidate and live module), ObjectKey the short key a job
/// targets as "@ObjectKey", BaseValue the default of the same element in the base (null when absent or empty).</summary>
internal sealed record DeferredDefault(string Key, string ObjectKey, string Element, string Value, string? BaseValue);

/// <summary>
/// The order of a native merge for default values. Both Studios (O11 Service Studio, ODC Studio) apply one rule when a
/// merge sets the data type or the mandatory flag of an element: AbstractAttribute, scoped variable, input parameter and
/// global variable RefreshState call SetDefaultValue(null) when the Studio marks that element's Default Value read-only
/// (PropertyIsReadOnly: an entity attribute whose type is an entity identifier, a mandatory input parameter, a variable
/// of a type that cannot carry a default). A merge that CREATES such an element sets its type, so its default is lost;
/// the same default merged onto the element once it exists is kept (the type is not set again). Proven offline with the
/// Studios' own MatchTree (MergeOrderTests) and live on 2026-10-03/04 (GameStore_CS, OfficePet_CS, QuizLiveWeb).
/// Plan lists those defaults; the first merge delivers the candidate without them (Strip), the second merges the
/// candidate itself over that first-pass model, so only the deferred defaults remain to merge.
/// Studio-only types (the kernel's own file is compiled by Anvil.Core and Anvil.Core.Odc).
/// </summary>
internal static class MergeOrder
{
    public const string Rule = "the Studio removes a Default Value it marks read-only (entity attribute of an identifier type, mandatory input parameter, variable of a type without defaults) when a merge sets that element's type or mandatory flag; the default is merged in a second native merge, onto the element the first one created";

    /// <summary>The Studio's own rule, a non-public method found by reflection. A Studio build without it (renamed or
    /// removed) is not refused: every default counts as one the merge may drop (see ReadOnly).</summary>
    internal static readonly MethodInfo? ReadOnlyRule = typeof(AbstractObject).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        .FirstOrDefault(m => m.Name == "PropertyIsReadOnly" && m.GetParameters().Length == 1);

    /// <summary>The defaults of the candidate the merge would drop: non-empty, outside references (their defaults belong
    /// to the producer), read-only by the Studio's rule, on an element the merge creates or whose type or mandatory flag
    /// the merge changes (the two properties whose setting triggers the removal). Sorted by key: the same models give the
    /// same plan.</summary>
    public static IReadOnlyList<DeferredDefault> Plan(ESpace candidate, ESpace basis) => Plan(candidate, basis, ReadOnlyRule);

    internal static IReadOnlyList<DeferredDefault> Plan(ESpace candidate, ESpace basis, MethodInfo? rule)
    {
        var before = ByKey(basis);
        var deferred = new List<DeferredDefault>();
        foreach (var owner in Owners(candidate))
        {
            var value = Text(owner);
            if (value.Length == 0 || !ReadOnly(owner, rule)) continue;
            before.TryGetValue(Key(owner), out var was);
            if (was != null && TypeOf(was) == TypeOf(owner) && Equals(Mandatory(was), Mandatory(owner))) continue;
            var baseValue = was == null ? "" : Text(was);
            deferred.Add(new DeferredDefault(Key(owner), ObjectKeyOf(owner), Element(owner), value, baseValue.Length == 0 ? null : baseValue));
        }
        return deferred.OrderBy(d => d.Key, StringComparer.Ordinal).ToArray();
    }

    /// <summary>True when the candidate holds a default Plan could defer; without one the base is never read.</summary>
    public static bool HasReadOnlyDefault(ESpace candidate) => HasReadOnlyDefault(candidate, ReadOnlyRule);

    internal static bool HasReadOnlyDefault(ESpace candidate, MethodInfo? rule) => Owners(candidate).Any(o => Text(o).Length > 0 && ReadOnly(o, rule));

    /// <summary>Removes each deferred default from a candidate copy: the first merge sets the element's type or mandatory
    /// flag without it (the Studio would remove it there anyway). The caller runs it inside the platform's mutation scope
    /// (O11 command, ODC transaction).</summary>
    public static void Strip(ESpace firstPass, IReadOnlyList<DeferredDefault> deferred)
    {
        var owners = ByKey(firstPass);
        foreach (var d in deferred)
        {
            if (!owners.TryGetValue(d.Key, out var owner)) throw new InvalidOperationException("Merge order: " + d.Element + " is absent from the first-pass copy");
            owner.SetDefaultValue("");
            if (owner.DefaultValue != null) throw new InvalidOperationException("Merge order: the first-pass copy kept a default on " + d.Element);
        }
    }

    /// <summary>The deferred defaults the live module does not carry (empty when the second merge delivered them).</summary>
    public static IReadOnlyList<DeferredDefault> Missing(ESpace live, IReadOnlyList<DeferredDefault> deferred)
    {
        var owners = ByKey(live);
        return deferred.Where(d => !owners.TryGetValue(d.Key, out var o) || Text(o) != d.Value).ToArray();
    }

    /// <summary>Every default of the expected model (outside references) that the live module has lost: the element exists
    /// with an empty default. BaseValue carries the live value (null). Names the known class when a merge kept less.</summary>
    public static IReadOnlyList<DeferredDefault> Lost(ESpace live, ESpace expected)
    {
        var owners = ByKey(live);
        return Owners(expected).Where(o => Text(o).Length > 0 && owners.TryGetValue(Key(o), out var now) && Text(now).Length == 0)
            .Select(o => new DeferredDefault(Key(o), ObjectKeyOf(o), Element(o), Text(o), null))
            .OrderBy(d => d.Key, StringComparer.Ordinal).ToArray();
    }

    /// <summary>The exact repair of a lost default: the element exists now, so a merge keeps a default set on it.</summary>
    public static JsonObject RepairJob(IEnumerable<DeferredDefault> missing) => new()
    {
        ["ops"] = new JsonArray(missing.Select(d => (JsonNode)new JsonObject { ["op"] = "set", ["target"] = "@" + d.ObjectKey, ["prop"] = "DefaultValue", ["value"] = d.Value }).ToArray())
    };

    public static string Describe(IEnumerable<DeferredDefault> defaults) => string.Join(", ", defaults.Select(d => d.Element + " = " + d.Value));

    public static JsonArray ToJson(IEnumerable<DeferredDefault> defaults) => new(defaults.Select(d => (JsonNode)new JsonObject
    {
        ["key"] = d.Key, ["objectKey"] = d.ObjectKey, ["element"] = d.Element, ["property"] = "DefaultValue", ["value"] = d.Value, ["baseValue"] = d.BaseValue
    }).ToArray());

    public static IReadOnlyList<DeferredDefault> FromJson(JsonArray? items) => items?.OfType<JsonObject>().Select(i => new DeferredDefault(
        i["key"]!.GetValue<string>(), i["objectKey"]!.GetValue<string>(), i["element"]!.GetValue<string>(), i["value"]!.GetValue<string>(), i["baseValue"]?.GetValue<string>())).ToArray()
        ?? Array.Empty<DeferredDefault>();

    static IEnumerable<IObjectWithDefaultValue> Owners(ESpace model) =>
        model.GetAllChildrenOfType<IObjectWithDefaultValue>().Where(o => o is AbstractObject a && a.FindParent<ITopLevelReferenceElement>() == null);

    static Dictionary<string, IObjectWithDefaultValue> ByKey(ESpace model) =>
        Owners(model).GroupBy(Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

    static bool ReadOnly(IObjectWithDefaultValue owner, MethodInfo? rule)
    {
        var o = (AbstractObject)owner;
        // An element without a Default Value descriptor has no rule to apply: the merge does not remove what it cannot set.
        var descriptor = o.GetPropertyByName("DefaultValue");
        if (descriptor == null) return false;
        // Without the Studio's rule every default is deferred: the second merge sets it on the element the first one created,
        // where a merge keeps any default, so deferring one the Studio would have kept costs only that second merge.
        return rule == null || (bool)rule.Invoke(o, new object[] { descriptor })!;
    }

    static string Key(IObjectWithDefaultValue o) => ((AbstractObject)o).Key.ToString()!;
    static string ObjectKeyOf(IObjectWithDefaultValue o) => (o as OutSystems.Model.IObjectSignature)?.ObjectKey?.ToString() ?? Key(o).Split('/').Last().Split('.').Last();
    static string Text(IObjectWithDefaultValue o) => o.DefaultValue?.GetText() ?? "";
    static string? TypeOf(IObjectWithDefaultValue o) => o.Type?.Key?.ToString();
    static object? Mandatory(IObjectWithDefaultValue o) => o.GetType().GetProperties().FirstOrDefault(p => p.Name == "IsMandatory" && p.PropertyType == typeof(bool) && p.GetIndexParameters().Length == 0)?.GetValue(o);
    static string Element(IObjectWithDefaultValue o)
    {
        var names = new List<string>();
        for (var x = (AbstractObject?)o; x != null && x is not ESpace; x = x.GetParent())
            if (!string.IsNullOrEmpty(x.Name)) names.Add(x.Name);
        names.Reverse();
        return string.Join(".", names);
    }
}
