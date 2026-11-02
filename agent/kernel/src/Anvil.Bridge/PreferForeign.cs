using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;

namespace Anvil.Bridge;

/// <summary>
/// merge_from_oml {prefer:"foreign"} (PLANO-11H, owner rule: SSAM never stops because the person is programming in the Studio at
/// the same time; on a same-element conflict the delivery wins, with a note). The Studio's automatic merge keeps the person's
/// side of every conflict (Match.ResolveWithLocalVersionAllConflictsToResolveInSelfAndChildren is the only resolution it runs
/// by itself), so no retry from the server wins against a person who keeps editing the same element. This resolves the
/// conflicts INSIDE the same MatchTree, the way the merge dialog does when the person picks the incoming side of a conflict:
/// MergeUtils.SetIsChecked(match, MergeUnitCheck.Foreign, checkDependencies: true, checkAllChildren: false) on each merge unit
/// that still has an unresolved conflict (MergeAction Unknown). Every other merge unit keeps the native three-way selection
/// (MergeUnitCheck.Both, set by the tree), so the person's edits elsewhere stay.
///
/// Reflection only, no Studio type at compile time: the same members exist in ServiceStudio.Merge (Service Studio 11.55.92,
/// .93, .94: ServiceStudio.Framework.dll) and OutSystems.Model.Merge (ODC Studio: OutSystems.Model.dll), and this file is
/// linked into the thin and the full O11 bridges, the ODC bridge and the kernel's test harnesses.
///
/// Nothing is resolved silently: <see cref="Resolve"/> returns one entry per value of the person that the delivery's side
/// replaces (element, property, the person's value, the delivery's value, conflict or not); the server turns the list into the
/// note of the answer. A tree that still has an unresolved conflict after the selection throws: nothing is merged.
/// </summary>
internal static class PreferForeign
{
    /// <summary>The capability of a bridge that serves merge_from_oml {prefer:"foreign"} (bridge_manifest capabilities).</summary>
    internal const string Capability = "merge_from_oml:prefer_foreign";
    /// <summary>The receipt field with the resolved list.</summary>
    internal const string ResolvedField = "resolvedConflicts";
    internal const int MaxEntries = 50;

    private const BindingFlags Public = BindingFlags.Public | BindingFlags.Instance;

    /// <summary>The members found on the bound Studio's merge namespace (reported in the receipt as members).</summary>
    internal sealed record Members(string Namespace, MethodInfo SetIsChecked, object ForeignCheck, Type MatchType)
    {
        public JsonObject Describe() => new()
        {
            ["namespace"] = Namespace,
            ["setIsChecked"] = SetIsChecked.DeclaringType!.FullName + "." + SetIsChecked.Name + "(" + string.Join(", ", SetIsChecked.GetParameters().Select(p => p.ParameterType.Name)) + ")",
            ["check"] = ForeignCheck.GetType().FullName + "." + ForeignCheck,
            ["assembly"] = SetIsChecked.DeclaringType.Assembly.GetName().Name + " " + SetIsChecked.DeclaringType.Assembly.GetName().Version,
        };
    }

    /// <summary>The Studio's own selection API next to the tree's type: MergeUtils.SetIsChecked(Match, MergeUnitCheck, bool, bool)
    /// and MergeUnitCheck.Foreign. Throws when the bound Studio has no such member (the bridge then answers the conflict as before).</summary>
    internal static Members Find(Type treeType)
    {
        var ns = treeType.Namespace ?? throw new InvalidOperationException("prefer foreign: the merge tree type has no namespace");
        var asm = treeType.Assembly;
        var match = asm.GetType(ns + ".Match") ?? throw new InvalidOperationException("prefer foreign: no " + ns + ".Match in " + asm.GetName().Name);
        var utils = asm.GetType(ns + ".MergeUtils") ?? throw new InvalidOperationException("prefer foreign: no " + ns + ".MergeUtils in " + asm.GetName().Name);
        var set = utils.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == "SetIsChecked")
            .SingleOrDefault(m => m.GetParameters() is { Length: 4 } p && p[0].ParameterType == match && p[1].ParameterType.IsEnum
                && p[2].ParameterType == typeof(bool) && p[3].ParameterType == typeof(bool))
            ?? throw new InvalidOperationException("prefer foreign: no public " + utils.FullName + ".SetIsChecked(Match, MergeUnitCheck, bool, bool)");
        var checkType = set.GetParameters()[1].ParameterType;
        if (!Enum.GetNames(checkType).Contains("Foreign")) throw new InvalidOperationException("prefer foreign: " + checkType.FullName + " has no Foreign");
        return new Members(ns, set, Enum.Parse(checkType, "Foreign"), match);
    }

    /// <summary>The result of a resolution: the entries, how many merge units were selected, and the members used.</summary>
    internal sealed record Resolution(JsonArray Entries, int Units, int Total, Members Members)
    {
        public JsonObject Receipt() => new()
        {
            ["prefer"] = "foreign", ["units"] = Units, ["count"] = Total, ["truncated"] = Total > Entries.Count,
            ["entries"] = Entries.DeepClone(), ["members"] = Members.Describe(),
        };
    }

    /// <summary>Selects the delivery's (foreign) side of every merge unit of <paramref name="tree"/> that has an unresolved
    /// conflict, and returns what the person loses. Call inside the command that then runs tree.Merge(). Throws, before any
    /// write, when a conflict stays unresolved.</summary>
    internal static Resolution Resolve(object tree)
    {
        var members = Find(tree.GetType());
        // As the Studio's own Match.UpdateMergeAction: a programmatic selection, so SetIsChecked does not refresh the views of the
        // foreign and base models (ForceViewRefresh), which have no open command ("No command is open").
        var programmatic = tree.GetType().GetProperty("IsProgrammaticMerge", Public);
        var wasProgrammatic = programmatic?.GetValue(tree) is true;
        programmatic?.SetValue(tree, true);
        try { return ResolveSelected(tree, members); }
        finally { programmatic?.SetValue(tree, wasProgrammatic); }
    }

    private static Resolution ResolveSelected(object tree, Members members)
    {
        var units = new List<object>();
        foreach (var root in Enumerate(Get(tree, "Roots"))) CollectUnits(root, units, new HashSet<object>(ReferenceEqualityComparer.Instance));
        var entries = new JsonArray(); var total = 0;
        foreach (var unit in units)
        {
            // What the person changed inside this unit, read before the selection (afterwards the actions say foreign).
            foreach (var entry in Losses(unit))
            {
                total++;
                if (entries.Count < MaxEntries) entries.Add(entry);
            }
            members.SetIsChecked.Invoke(null, [unit, members.ForeignCheck, true, false]);
        }
        if (units.Count == 0)
            throw new InvalidOperationException("prefer foreign: the merge tree has conflicts but no merge unit with an unresolved conflict was found; nothing was merged");
        if (Flag(tree, "HasUnresolvedConflicts"))
            throw new InvalidOperationException("prefer foreign: the merge tree still has an unresolved conflict after selecting the delivery's side of "
                + units.Count + " merge unit(s); nothing was merged");
        return new Resolution(entries, units.Count, total, members);
    }

    // The merge units with an unresolved conflict of their own (MergeAction Unknown), outermost first; a unit selected as foreign
    // takes its whole subtree, so its descendants are not visited again.
    private static void CollectUnits(object match, List<object> units, HashSet<object> seen)
    {
        if (!seen.Add(match) || !(Flag(match, "HasUnresolvedConflicts") || Flag(match, "HasConflicts"))) return;
        if (Get(match, "MergeAction")?.ToString() == "Unknown") { units.Add(match); return; }
        foreach (var child in Enumerate(Get(match, "Children"))) CollectUnits(child, units, seen);
    }

    // Each value of the person (the local side differs from the base) in the unit and its subtree.
    private static IEnumerable<JsonObject> Losses(object unit)
    {
        var stack = new Stack<(object Match, int Depth)>(); stack.Push((unit, 0));
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        while (stack.Count > 0)
        {
            var (match, depth) = stack.Pop();
            if (!seen.Add(match)) continue;
            var difference = Get(match, "Difference")?.ToString() ?? "";
            if (!HasLocal(difference) && !difference.Contains("Conflict", StringComparison.Ordinal) && depth > 0) { if (difference.Contains("Children", StringComparison.Ordinal)) PushChildren(); continue; }
            var element = PathOf(match);
            var matchType = Get(match, "MatchType")?.ToString();
            if (matchType == "InLocalESpaceOnly" && Get(match, "BaseObject") == null)
                yield return Entry(element, "", "added by the person", "absent", difference, conflict: false);
            else if (matchType == "InForeignESpaceOnly" && Get(match, "BaseObject") != null)
                yield return Entry(element, "", "removed by the person", "kept by the delivery", difference, conflict: difference.Contains("Conflict", StringComparison.Ordinal));
            else
            {
                foreach (var pair in Enumerate(Get(match, "Properties")))
                {
                    var pd = Get(pair, "Difference")?.ToString() ?? "";
                    if (!HasLocal(pd) && !pd.Contains("Conflict", StringComparison.Ordinal)) continue;
                    var name = (Get(pair, "PropertyName") ?? Get(pair, "DisplayName") ?? Get(Get(pair, "Property"), "Name"))?.ToString() ?? "";
                    yield return Entry(element, name, Value(pair, "Local"), Value(pair, "Foreign"), pd, pd.Contains("Conflict", StringComparison.Ordinal));
                }
            }
            PushChildren();
            void PushChildren() { if (depth < 12) foreach (var child in Enumerate(Get(match, "Children"))) stack.Push((child, depth + 1)); }
        }
    }

    private static bool HasLocal(string difference) => difference.Contains("ChangedInLocal", StringComparison.Ordinal)
        || difference.Contains("AddedToLocal", StringComparison.Ordinal) || difference.Contains("RemovedFromLocal", StringComparison.Ordinal);

    private static JsonObject Entry(string element, string property, string? user, string? delivery, string difference, bool conflict) => new()
    {
        ["element"] = element, ["property"] = property, ["user"] = Clip(user), ["delivery"] = Clip(delivery),
        ["conflict"] = conflict, ["difference"] = difference,
    };

    private static string? Value(object pair, string side)
    {
        try { return (Get(pair, side + "DisplayValue") ?? Get(pair, side + "Value"))?.ToString(); }
        catch (Exception) { try { return Get(pair, side + "Value")?.ToString(); } catch (Exception) { return null; } }
    }

    private static string? Clip(string? text) => text == null ? null : text.Length > 200 ? text[..200] + "..." : text;

    /// <summary>A readable path of the element: kind and name of each named ancestor, from the module down.</summary>
    internal static string PathOf(object match)
    {
        var parts = new List<string>();
        for (var m = match; m != null && parts.Count < 8; m = Get(m, "Parent"))
        {
            var obj = Get(m, "LocalObject") ?? Get(m, "ForeignObject") ?? Get(m, "BaseObject");
            if (obj == null) continue;
            var kind = obj.GetType().Name; var name = SafeName(obj);
            if (Get(m, "Parent") == null) break;   // the module itself
            parts.Add(string.IsNullOrEmpty(name) ? kind : kind + ":" + name);
        }
        parts.Reverse();
        return parts.Count == 0 ? "(module)" : string.Join("/", parts);
    }

    private static string? SafeName(object obj) { try { return obj.GetType().GetProperty("Name", Public)?.GetValue(obj)?.ToString(); } catch (Exception) { return null; } }

    private static object? Get(object? target, string name)
    {
        if (target == null) return null;
        for (var t = target.GetType(); t != null; t = t.BaseType)
        {
            var property = t.GetProperty(name, Public | BindingFlags.DeclaredOnly);
            if (property?.GetMethod != null && property.GetIndexParameters().Length == 0)
            {
                try { return property.GetValue(target); }
                catch (TargetInvocationException) { return null; }
            }
        }
        return null;
    }

    private static bool Flag(object target, string name) => Get(target, name) is true;

    private static IEnumerable<object> Enumerate(object? items)
    {
        if (items is not IEnumerable list) yield break;
        foreach (var item in list) if (item != null) yield return item;
    }
}
