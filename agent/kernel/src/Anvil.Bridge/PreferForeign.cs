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
/// that still has an unresolved conflict (MergeAction Unknown). The module root is never taken whole: it keeps the native
/// three-way selection and only the elements in conflict inside it take the delivery's side.
///
/// Reflection only, no Studio type at compile time: the same members exist in ServiceStudio.Merge (Service Studio 11.55.92,
/// .93, .94: ServiceStudio.Framework.dll) and OutSystems.Model.Merge (ODC Studio: OutSystems.Model.dll), and this file is
/// linked into the thin O11 bridge and the kernel's test harnesses. Every member it reads is required up front (Find): a Studio
/// without one of them throws before any selection, and the bridge answers the conflict as today.
///
/// Nothing is resolved silently (review A1/A3 of REVISAO-PREFER-FOREIGN): the Studio's selection reaches beyond the element it
/// is given (property dependencies that do not survive the merge, the parent of an element that is not a merge unit, extra
/// dependencies, referred hidden objects). So the MergeAction of EVERY match and property pair of the whole tree is read before
/// and after the selection, with no depth limit, and every element whose action changed and that has a side of the person
/// (ChangedInLocal, AddedToLocal, RemovedFromLocal) is an entry, with its cause: selected (inside an element in conflict),
/// parent (an ancestor the selection took) or dependency (anything else the selection reached). The server turns the list into
/// the note. A tree that still has an unresolved conflict after the selection throws: nothing is merged.
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

    // Review A5: every member the resolution reads, by type: (name, needs a public setter).
    private static readonly (string Name, bool Setter)[] TreeMembers = [("Roots", false), ("HasUnresolvedConflicts", false), ("HasConflicts", false), ("IsProgrammaticMerge", true)];
    private static readonly (string Name, bool Setter)[] MatchMembers = [("Parent", false), ("Children", false), ("Properties", false), ("MergeAction", true),
        ("Difference", false), ("MatchType", false), ("HasUnresolvedConflicts", false), ("HasConflicts", false), ("LocalObject", false), ("ForeignObject", false), ("BaseObject", false)];
    private static readonly (string Name, bool Setter)[] PairMembers = [("Difference", false), ("MergeAction", true)];

    /// <summary>The Studio's own selection API next to the tree's type: MergeUtils.SetIsChecked(Match, MergeUnitCheck, bool, bool),
    /// MergeUnitCheck.Foreign and Both, and every property the resolution reads on MatchTree, Match and PropertyPair. Throws when
    /// the bound Studio lacks any of them (the bridge then answers the conflict as today).</summary>
    internal static Members Find(Type treeType)
    {
        var ns = treeType.Namespace ?? throw new InvalidOperationException("prefer foreign: the merge tree type has no namespace");
        var asm = treeType.Assembly;
        var match = asm.GetType(ns + ".Match") ?? throw new InvalidOperationException("prefer foreign: no " + ns + ".Match in " + asm.GetName().Name);
        var pair = asm.GetType(ns + ".PropertyPair") ?? throw new InvalidOperationException("prefer foreign: no " + ns + ".PropertyPair in " + asm.GetName().Name);
        var utils = asm.GetType(ns + ".MergeUtils") ?? throw new InvalidOperationException("prefer foreign: no " + ns + ".MergeUtils in " + asm.GetName().Name);
        var set = utils.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(m => m.Name == "SetIsChecked")
            .SingleOrDefault(m => m.GetParameters() is { Length: 4 } p && p[0].ParameterType == match && p[1].ParameterType.IsEnum
                && p[2].ParameterType == typeof(bool) && p[3].ParameterType == typeof(bool))
            ?? throw new InvalidOperationException("prefer foreign: no public " + utils.FullName + ".SetIsChecked(Match, MergeUnitCheck, bool, bool)");
        var checkType = set.GetParameters()[1].ParameterType;
        foreach (var name in new[] { "Foreign", "Both" })
            if (!Enum.GetNames(checkType).Contains(name)) throw new InvalidOperationException("prefer foreign: " + checkType.FullName + " has no " + name);
        Require(treeType, TreeMembers); Require(match, MatchMembers); Require(pair, PairMembers);
        return new Members(ns, set, Enum.Parse(checkType, "Foreign"), match);
    }

    private static void Require(Type type, (string Name, bool Setter)[] names)
    {
        foreach (var (name, setter) in names)
        {
            var property = Property(type, name);
            if (property?.GetMethod == null || (setter && property.SetMethod == null))
                throw new InvalidOperationException("prefer foreign: " + type.FullName + "." + name + (setter ? " (get and set)" : "") + " is missing in this Studio");
        }
    }

    /// <summary>The result of a resolution: the entries (conflicts first), how many elements were selected, the counts, and the
    /// members used.</summary>
    internal sealed record Resolution(JsonArray Entries, int Units, int Total, int Conflicts, Members Members)
    {
        public JsonObject Receipt() => new()
        {
            ["prefer"] = "foreign", ["units"] = Units, ["count"] = Total, ["conflicts"] = Conflicts, ["others"] = Total - Conflicts,
            ["truncated"] = Total > Entries.Count, ["entries"] = Entries.DeepClone(), ["members"] = Members.Describe(),
        };
    }

    /// <summary>Selects the delivery's (foreign) side of every element of <paramref name="tree"/> in conflict, and returns
    /// everything of the person the selection replaces. Call inside the command that then runs tree.Merge(). Throws, before any
    /// write, when a member is missing or a conflict stays unresolved.</summary>
    internal static Resolution Resolve(object tree)
    {
        var members = Find(tree.GetType());
        // As the Studio's own Match.UpdateMergeAction: a programmatic selection, so SetIsChecked does not refresh the views of the
        // foreign and base models (ForceViewRefresh), which have no open command ("No command is open").
        var programmatic = Property(tree.GetType(), "IsProgrammaticMerge")!;
        var wasProgrammatic = programmatic.GetValue(tree) is true;
        programmatic.SetValue(tree, true);
        try { return ResolveSelected(tree, members); }
        finally { programmatic.SetValue(tree, wasProgrammatic); }
    }

    private static Resolution ResolveSelected(object tree, Members members)
    {
        var units = new List<object>();
        foreach (var root in Enumerate(Get(tree, "Roots"))) CollectUnits(root, units, new HashSet<object>(ReferenceEqualityComparer.Instance));
        if (units.Count == 0)
            throw new InvalidOperationException("prefer foreign: the merge tree has conflicts but no merge unit with an unresolved conflict was found; nothing was merged");
        // The whole tree before the selection (also sets up every child and property pair, so the comparison sees the same set).
        var before = Snapshot(tree);
        var sites = new List<object>();
        foreach (var unit in units)
        {
            // The module itself (the tree's root: a conflict in a collection of the module, such as Roles added and deleted by
            // the two sides) is never taken whole from the delivery: that would undo every edit of the person in the module.
            // Its native three-way selection (Both) stays, and only the elements in conflict inside it take the delivery's side.
            var chosen = Get(unit, "Parent") == null ? RootSites(unit, members) : [unit];
            foreach (var site in chosen)
            {
                members.SetIsChecked.Invoke(null, [site, members.ForeignCheck, true, false]);
                sites.Add(site);
            }
        }
        if (Flag(tree, "HasUnresolvedConflicts"))
            throw new InvalidOperationException("prefer foreign: the merge tree still has an unresolved conflict after selecting the delivery's side of "
                + sites.Count + " element(s); nothing was merged");
        var after = Snapshot(tree);
        var siteSet = new HashSet<object>(sites, ReferenceEqualityComparer.Instance);
        var all = new List<JsonObject>();
        foreach (var (element, action) in after.Order.Select(e => (e, after.Actions[e])))
        {
            var was = before.Actions.TryGetValue(element, out var old) ? old : "None";
            if (was == action) continue;
            if (Describe(element, siteSet, action) is { } entry) all.Add(entry);
        }
        var ordered = all.OrderByDescending(e => e["conflict"]!.GetValue<bool>()).ToList();
        var entries = new JsonArray(ordered.Take(MaxEntries).Select(e => (JsonNode)e).ToArray());
        return new Resolution(entries, sites.Count, ordered.Count, ordered.Count(e => e["conflict"]!.GetValue<bool>()), members);
    }

    // The merge units with an unresolved conflict of their own (MergeAction Unknown), outermost first.
    private static void CollectUnits(object match, List<object> units, HashSet<object> seen)
    {
        if (!seen.Add(match) || !(Flag(match, "HasUnresolvedConflicts") || Flag(match, "HasConflicts"))) return;
        if (Get(match, "MergeAction")?.ToString() == "Unknown") { units.Add(match); return; }
        foreach (var child in Enumerate(Get(match, "Children"))) CollectUnits(child, units, seen);
    }

    /// <summary>The module root in conflict: its Both selection (MergeUnitCheck.Both, the Studio's native three-way choice for every
    /// difference without a conflict), then the elements whose OWN difference is a conflict (a property both changed, or one side
    /// deleted what the other changed), outermost first, which then take the delivery's side one by one. A conflicting property of
    /// the module itself takes the delivery's value (MergeAction Update, as CheckMergeElementToForeign); the snapshot lists it.</summary>
    private static List<object> RootSites(object root, Members members)
    {
        members.SetIsChecked.Invoke(null, [root, Enum.Parse(members.ForeignCheck.GetType(), "Both"), false, false]);
        var sites = new List<object>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var pending = new Stack<object>(); pending.Push(root);
        while (pending.TryPop(out var match))
        {
            if (!seen.Add(match)) continue;
            foreach (var child in Enumerate(Get(match, "Children")))
            {
                var difference = Get(child, "Difference")?.ToString() ?? "";
                if (!difference.Contains("Conflict", StringComparison.Ordinal)) continue;
                if (OwnConflict(child, difference)) sites.Add(child);
                else pending.Push(child);
            }
        }
        foreach (var pair in Enumerate(Get(root, "Properties")))
            if ((Get(pair, "Difference")?.ToString() ?? "").Contains("Conflict", StringComparison.Ordinal)) SetAction(pair, "Update");
        return sites;
    }

    // A conflict of the element itself: one of its own properties, or a delete on one side of what the other side changed.
    private static bool OwnConflict(object match, string difference)
    {
        if (Get(match, "MatchType")?.ToString() is "InLocalESpaceOnly" or "InForeignESpaceOnly" && difference.Contains("Conflict", StringComparison.Ordinal)) return true;
        return Enumerate(Get(match, "Properties")).Any(p => (Get(p, "Difference")?.ToString() ?? "").Contains("Conflict", StringComparison.Ordinal));
    }

    private sealed record Shot(List<object> Order, Dictionary<object, string> Actions);

    /// <summary>The MergeAction of every match and property pair of the whole tree, no depth limit (review A3).</summary>
    private static Shot Snapshot(object tree)
    {
        var order = new List<object>(); var actions = new Dictionary<object, string>(ReferenceEqualityComparer.Instance);
        var pending = new Stack<object>();
        foreach (var root in Enumerate(Get(tree, "Roots"))) pending.Push(root);
        while (pending.TryPop(out var match))
        {
            if (actions.ContainsKey(match)) continue;
            order.Add(match); actions[match] = Get(match, "MergeAction")?.ToString() ?? "";
            foreach (var pair in Enumerate(Get(match, "Properties")))
                if (!actions.ContainsKey(pair)) { order.Add(pair); actions[pair] = Get(pair, "MergeAction")?.ToString() ?? ""; }
            foreach (var child in Enumerate(Get(match, "Children"))) pending.Push(child);
        }
        return new Shot(order, actions);
    }

    /// <summary>One entry for an element whose selection changed and that has a side of the person; null when the person did not
    /// change it (a change only of the delivery's side is what the delivery brings, never a loss).</summary>
    private static JsonObject? Describe(object element, HashSet<object> sites, string action)
    {
        var difference = Get(element, "Difference")?.ToString() ?? "";
        if (!HasLocal(difference)) return null;
        var isPair = Property(element.GetType(), "MatchType") == null;
        var match = isPair ? Get(element, "Match") ?? Get(element, "MatchTree") : element;
        var cause = Cause(isPair ? match : element, sites);
        var conflict = difference.Contains("Conflict", StringComparison.Ordinal) || HasForeign(difference);
        if (isPair)
        {
            var name = (Get(element, "PropertyName") ?? Get(element, "DisplayName") ?? Get(Get(element, "Property"), "Name"))?.ToString() ?? "";
            return Entry(match == null ? "(module)" : PathOf(match), name, Value(element, "Local"), Value(element, "Foreign"), difference, conflict, cause, action);
        }
        var element_ = PathOf(element);
        var hasBase = Get(element, "BaseObject") != null;
        return Get(element, "MatchType")?.ToString() switch
        {
            "InLocalESpaceOnly" => Entry(element_, "", hasBase ? "kept by the person" : "added by the person", "removed (the delivery's version has no such element)", difference, conflict, cause, action),
            "InForeignESpaceOnly" => Entry(element_, "", "removed by the person", "brought back by the delivery", difference, conflict, cause, action),
            // Both sides have it: its changed properties are entries of their own.
            _ => null,
        };
    }

    // selected: inside an element the resolution chose; parent: an ancestor of one; dependency: anything else the selection reached.
    private static string Cause(object? match, HashSet<object> sites)
    {
        for (var m = match; m != null; m = Get(m, "Parent")) if (sites.Contains(m)) return "selected";
        if (match != null && sites.Any(s => { for (var m = Get(s, "Parent"); m != null; m = Get(m, "Parent")) if (ReferenceEquals(m, match)) return true; return false; }))
            return "parent";
        return "dependency";
    }

    private static void SetAction(object element, string action)
    {
        var property = Property(element.GetType(), "MergeAction");
        if (property?.SetMethod == null) throw new InvalidOperationException("prefer foreign: " + element.GetType().FullName + ".MergeAction cannot be set");
        property.SetValue(element, Enum.Parse(property.PropertyType, action));
    }

    private static bool HasLocal(string difference) => difference.Contains("ChangedInLocal", StringComparison.Ordinal)
        || difference.Contains("AddedToLocal", StringComparison.Ordinal) || difference.Contains("RemovedFromLocal", StringComparison.Ordinal);

    private static bool HasForeign(string difference) => difference.Contains("ChangedInForeign", StringComparison.Ordinal)
        || difference.Contains("AddedToForeign", StringComparison.Ordinal) || difference.Contains("RemovedFromForeign", StringComparison.Ordinal);

    private static JsonObject Entry(string element, string property, string? user, string? delivery, string difference, bool conflict, string cause, string action) => new()
    {
        ["element"] = element, ["property"] = property, ["user"] = Clip(user), ["delivery"] = Clip(delivery),
        ["conflict"] = conflict, ["cause"] = cause, ["action"] = action, ["difference"] = difference,
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

    private static PropertyInfo? Property(Type type, string name)
    {
        for (var t = type; t != null; t = t.BaseType)
            if (t.GetProperty(name, Public | BindingFlags.DeclaredOnly) is { } p && p.GetIndexParameters().Length == 0) return p;
        return null;
    }

    private static object? Get(object? target, string name)
    {
        if (target == null) return null;
        var property = Property(target.GetType(), name);
        if (property?.GetMethod == null) return null;
        try { return property.GetValue(target); }
        catch (TargetInvocationException) { return null; }
    }

    private static bool Flag(object target, string name) => Get(target, name) is true;

    private static IEnumerable<object> Enumerate(object? items)
    {
        if (items is not IEnumerable list) yield break;
        foreach (var item in list) if (item != null) yield return item;
    }
}
