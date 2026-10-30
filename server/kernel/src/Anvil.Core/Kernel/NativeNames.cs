using System.Reflection;
using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// R3-C (2026-10-29; K2 of the review of 28/10): the names the Studio gives an element on its own, in one registry. Each
/// rule says its condition, the name that results and the native source it was read from. A merge (or an import, or the
/// editor) that sets the content a rule watches renames the element in the module, while the candidate the kernel built
/// through the Model API keeps the author's name: the kernel never fires those events. The content proof then saw the old
/// name lost and a new one added (MERGE_CONTENT_MISMATCH on a module the merge had applied: 9 rounds of one scenario).
/// <para>The candidate predicts the final name (<see cref="Predict"/>: its own model read with the Studio's own naming
/// functions), and MergeContentProof accepts ONLY the predicted pair: the old name gone and the predicted one present under
/// the same owner, of the same kind, and, with the candidate renamed by the Studio's own SetName (<see cref="Apply"/>, which
/// rewrites every expression that names it), no other difference. Any other rename, or other content under the predicted
/// name, still refuses. Never a local ObjectKey: the merge regenerates them (MergeContentProof.IdentityRule).</para>
/// <para>Of the same family, still decided where they are (not in this registry yet): the cut of a name at the platform's
/// length (NameTruncation), the numbered free name of a clash (Preflight.NameRules.Free) and the name of an auto-generated
/// index (EntityIndexes; MergeContentProof.GeneratedIndexIdentity).</para>
/// </summary>
public static class NativeNames
{
    /// <summary>A rule of the registry: its id, the condition under which the Studio renames, the name that results and the
    /// native source (decompiled member and lines) it was read from.</summary>
    public sealed record Rule(string Id, string Condition, string Result, string Source);

    /// <summary>One predicted rename: the element of the candidate, its name now, the name the Studio gives it, the rule.</summary>
    public sealed record Rename(IObjectSignature Element, string From, string To, string Rule);

    public const string AggregateByAttribute = "aggregate-filter-by-attribute";
    public const string AggregateByIdentifier = "aggregate-filter-by-identifier";

    private const string AggregateSource = "ServiceStudio.Model.Nodes.AbstractDataSet.OnFilterConditionChanged and IsFilterByAttribute "
        + "(decompiled O11 ServiceStudio.Framework Nodes.cs:3778-3824, ODC OutSystems.Model Nodes.cs:6093-6139), fired by "
        + "Filter.RefreshState when a merge, an import or the editor sets a filter's Condition (Filter.cs:356-363); "
        + "kernel/docs/NAO-DA.md, \"An aggregate with the Studio default name is renamed on its own\"";

    /// <summary>The registry. Both rules are one native method: the attribute a filter compares decides which applies.</summary>
    public static IReadOnlyList<Rule> Registry { get; } = [
        new(AggregateByAttribute,
            "an aggregate named with its kind's default name (Aggregate, Aggregate2, ...) or exactly \"Get\" + the plural label of an "
            + "entity receives a filter <attribute of that entity> <operator> <a value from outside the aggregate>, and the attribute "
            + "is not the entity's identifier",
            "\"Get\" + the entity's plural label + \"By\" + the attribute's name in PascalCase (an aggregate of Orders filtered by "
            + "CustomerId: GetOrdersByCustomerId), made unique among its siblings by the Studio's NameClash",
            AggregateSource),
        new(AggregateByIdentifier,
            "the same, when the filtered attribute is the entity's identifier",
            "\"Get\" + the entity's singular label + \"By\" + the identifier's name in PascalCase (GetOrderById), made unique the same way",
            AggregateSource),
    ];

    /// <summary>Every element of the model a rule of the registry renames, with the name the Studio gives it. An element whose
    /// filters would give two different names (the Studio's result then depends on the order the merge sets them) is not
    /// predicted; neither is anything on a Studio whose native member a rule reads is missing. Nothing predicted: the proof
    /// refuses a rename as before.</summary>
    public static List<Rename> Predict(IObjectSignature root)
    {
        var found = new List<Rename>();
        foreach (var node in Walk(root))
            if (node is ServiceStudio.Model.Nodes.AbstractDataSet dataSet && Aggregate(dataSet) is { } rename) found.Add(rename);
        return found;
    }

    /// <summary>The element renamed as a rule of the registry renames it: the Studio's own public SetName(string) of its class,
    /// the method OnFilterConditionChanged calls (it applies NameClash and rewrites the expressions that name the element).
    /// False when the class has none, or when the name it kept is not <paramref name="name"/>.</summary>
    public static bool Apply(IObjectSignature element, string name)
    {
        var setName = element.GetType().GetMethod("SetName", BindingFlags.Public | BindingFlags.Instance, null, [typeof(string)], null);
        if (setName == null) return false;
        try { setName.Invoke(element, [name]); }
        catch { return false; }
        return string.Equals(ModelHost.Prop(element, "Name")?.ToString(), name, StringComparison.Ordinal);
    }

    /// <summary>A predicted rename as the receipt says it.</summary>
    public static JsonObject Json(Rename rename, string? element = null) => new()
    {
        ["element"] = element ?? ModelHost.Prop(rename.Element, "Name")?.ToString(), ["from"] = rename.From, ["to"] = rename.To, ["rule"] = rename.Rule,
    };

    // ---- the aggregate rules (OnFilterConditionChanged) ------------------------------------------------------------------

    private static readonly MethodInfo? IsFilterByAttribute =
        typeof(ServiceStudio.Model.Nodes.AbstractDataSet).GetMethod("IsFilterByAttribute", BindingFlags.NonPublic | BindingFlags.Instance);

    private static Rename? Aggregate(ServiceStudio.Model.Nodes.AbstractDataSet dataSet)
    {
        if (IsFilterByAttribute == null) return null;
        var names = new List<(string Name, string Rule)>();
        foreach (var filter in Walk(dataSet).OfType<ServiceStudio.Model.Filter>())
        {
            var arguments = new object?[] { filter, null };
            bool byAttribute;
            try { byAttribute = IsFilterByAttribute.Invoke(dataSet, arguments) is true; }
            catch { return null; }
            if (!byAttribute || arguments[1] is not ServiceStudio.Model.AbstractEntityAttribute attribute || attribute.ParentRecord is not ServiceStudio.Model.AbstractEntity entity) continue;
            var plural = ServiceStudio.Model.ModelExtensions.GetPrettyNamePlural(entity);
            if (!(dataSet.HasDefaultName() || dataSet.Name == "Get" + plural)) continue;
            var identifier = entity.GetIdentifier();
            var named = ReferenceEquals(attribute, identifier)
                ? (Pascal(identifier.Name) is { } id ? ("Get" + ServiceStudio.Model.ModelExtensions.GetPrettyName(entity) + "By" + id, AggregateByIdentifier) : default)
                : (Pascal(attribute.Name) is { } by ? ("Get" + plural + "By" + by, AggregateByAttribute) : default);
            if (named.Item1 == null) return null;
            names.Add(named);
        }
        if (names.Select(n => n.Name).Distinct(StringComparer.Ordinal).Count() != 1) return null;
        string final;
        try { final = ServiceStudio.Model.AbstractObject.NameClash(dataSet, names[0].Name); }
        catch { return null; }
        return string.Equals(final, dataSet.Name, StringComparison.Ordinal) ? null : new Rename(dataSet, dataSet.Name, final, names[0].Rule);
    }

    // The Studio's own ToPascalCase(string) (OutSystems.RuntimeCommon, the extension OnFilterConditionChanged calls), found once.
    private static readonly Lazy<MethodInfo?> PascalCase = new(() =>
    {
        IEnumerable<Assembly> Candidates()
        {
            foreach (var loaded in AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name == "OutSystems.RuntimeCommon")) yield return loaded;
            Assembly? named = null;
            try { named = Assembly.Load("OutSystems.RuntimeCommon"); } catch { }
            if (named != null) yield return named;
        }
        foreach (var assembly in Candidates())
        {
            Type[] types;
            try { types = assembly.GetExportedTypes(); } catch { continue; }
            foreach (var type in types.Where(t => t.IsAbstract && t.IsSealed))
                if (type.GetMethod("ToPascalCase", BindingFlags.Public | BindingFlags.Static, null, [typeof(string)], null) is { ReturnType: var returns } method && returns == typeof(string))
                    return method;
        }
        return null;
    });

    private static string? Pascal(string name)
    {
        if (PascalCase.Value is not { } method) return null;
        try { return method.Invoke(null, [name]) as string; }
        catch { return null; }
    }

    // The elements under a root, never inside a producer's reference (nothing there is the module's to rename).
    private static IEnumerable<IObjectSignature> Walk(IObjectSignature root)
    {
        var pending = new Stack<IObjectSignature>();
        pending.Push(root);
        while (pending.TryPop(out var node))
        {
            yield return node;
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
            List<IObjectSignature> children;
            try { children = node.Children.OfType<IObjectSignature>().ToList(); }
            catch { continue; }
            for (var i = children.Count - 1; i >= 0; i--) pending.Push(children[i]);
        }
    }
}
