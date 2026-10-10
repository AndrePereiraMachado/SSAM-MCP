using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The footprint of a job (K7): what it created (keys present after the apply and absent before), what it changed (the
/// existing objects a set, link, move, rename or delete wrote) and the screens it created or touched. The message policy
/// reads it (Unused* on a created element is mechanical; the anonymous-access warning on a job screen is not tolerated),
/// and the apply result carries it, at most 200 entries per list plus the totals.
/// </summary>
public sealed partial class ModelSession
{
    private readonly HashSet<object> _touched = new(ReferenceEqualityComparer.Instance);
    // C08: the screens a write of this job opened to anonymous users (AnonymousAccess true, Roles with Anonymous).
    private readonly HashSet<object> _anonymousDeclared = new(ReferenceEqualityComparer.Instance);

    /// <summary>An existing object a write verb changed (recorded by the verbs themselves, where the target is resolved).</summary>
    private void Touch(object? target)
    {
        if (target is IObjectSignature) _touched.Add(target);
    }

    /// <summary>C08: the screen a write opened to anonymous users (the job's declared intent).</summary>
    private void DeclareAnonymous(object target)
    {
        if (ModelHost.IsScreen(target)) _anonymousDeclared.Add(target);
    }

    /// <summary>Whether a screen lets everyone in now: AnonymousAccess (ODC) or the Anonymous role among its Roles (O11).</summary>
    private static bool IsAnonymousScreen(object screen)
    {
        if (ModelHost.Prop(screen, "AnonymousAccess") is true) return true;
        try
        {
            return UiCatalog.Prop(screen, "Roles") is System.Collections.IEnumerable roles && roles.Cast<object>().Any(r => AnonymousIntent.IsAnonymousRole(TypeResolver.Name(r)));
        }
        catch { return false; }
    }

    /// <summary>The keys of JobFootprint.AnonymousIntent (C08): the screens the job declared and the footprint screens it
    /// did not create that are anonymous now (the base's state).</summary>
    public IReadOnlySet<string> AnonymousIntentOf(JobFootprint footprint)
    {
        var declared = _anonymousDeclared.OfType<IObjectSignature>().Where(s => !s.WasDeleted).Select(s => s.ObjectKey?.ToString()).OfType<string>();
        return AnonymousIntent.Compute(declared, footprint.Screens, footprint.Created, key =>
        {
            try { return IsAnonymousScreen(Resolve("@" + key)); }
            catch { return false; }
        });
    }

    /// <summary>The keys of every object of the module, read before the first op (the full sweep; B3 keeps it for the audit).</summary>
    public HashSet<string> ObjectKeys()
        => new KernelModelReader().Walk(_es).Concat(Descendants()).Select(o => o.ObjectKey?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);

    public sealed record FootprintReport(JobFootprint Footprint, JsonObject Json);

    // ---- B3 (atritos 3): the footprint without walking the module --------------------------------------------------------
    // Every object an op names (parent, target, from, to, ...) is a deep root: before the op runs, the first time, the
    // session keeps the keys of its whole subtree (the native descendants, indices included). Its parent, the module, the
    // references and the callers of what gains a parameter are shallow roots: their direct children are kept. Only roots
    // that existed before the job are kept (a root the job created is new as a whole). After the apply, Created is every
    // object of a deep root's subtree, and every new direct child of a shallow root with its subtree, whose key no kept list
    // had (what an op created, and what the platform created under what an op named: the placeholders of a block, the
    // arguments of a call, a filter inside an aggregate, an AutoIndex; never an object a move brought). Changed is still
    // _touched, minus what is new. Two full sweeps of a 2.9 MB module cost 3 to 6 s per delivery; this costs the roots.

    private sealed record Scope(bool Deep, HashSet<IObjectSignature> Children, HashSet<string> Keys);
    private readonly Dictionary<IObjectSignature, Scope> _scopes = new(ReferenceEqualityComparer.Instance);
    // The keys of every object kept in a scope: objects that existed before the job (a moved one stays old).
    private readonly HashSet<string> _oldKeys = new(StringComparer.Ordinal);
    private bool _footprintBegun;

    /// <summary>Test hook: when set (per async flow), JobRunner also takes the full sweep and records here every difference
    /// between the footprint of the scopes and the footprint of the sweep (the B3 audit over tests/jobs).</summary>
    internal static readonly AsyncLocal<List<string>?> FootprintAudit = new();

    /// <summary>Starts the footprint before anything of the job enters the model: the module's top-level elements and its
    /// references are the first scopes.</summary>
    public void BeginFootprint()
    {
        _footprintBegun = true;
        Keep(_es, deep: false);
        foreach (var reference in _es.References.OfType<IObjectSignature>()) Keep(reference, deep: false);
    }

    private static IEnumerable<IObjectSignature> DirectChildren(IObjectSignature o)
        => o.Children.OfType<IObjectSignature>().Concat(EntityIndexes.NativeChildren(o));

    /// <summary>Every object under <paramref name="o"/> as the full sweep sees it: the walk over Children (KernelModelReader) and
    /// the native descendants (GetAllDescendantsOfType), indices included. Neither alone finds every object.</summary>
    private static IEnumerable<IObjectSignature> Subtree(IObjectSignature o)
    {
        var all = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        var pending = new Stack<IObjectSignature>(DirectChildren(o));
        while (pending.TryPop(out var node))
            if (all.Add(node)) foreach (var child in DirectChildren(node)) pending.Push(child);
        all.UnionWith(EntityIndexes.IncludeNative(o.GetAllDescendantsOfType<IObjectSignature>()));
        return all;
    }

    /// <summary>Keeps a root that existed before the job, once: its subtree (deep) or its direct children (shallow). The module
    /// itself is always shallow. A shallow root named again as deep is kept deep then. What earlier ops already created under
    /// it (found by the scopes inside it) is never kept as old.</summary>
    private void Keep(IObjectSignature root, bool deep)
    {
        deep &= !ReferenceEquals(root, _es);
        if (_scopes.TryGetValue(root, out var known) && (known.Deep || !deep)) return;
        if (root.WasDeleted || known == null && !ExistedBefore(root)) return;
        var fresh = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (inner, scope) in _scopes.Where(s => ReferenceEquals(s.Key, root) || IsUnder(s.Key, root)).ToArray())
            foreach (var o in NewIn(inner, scope)) fresh.Add(o.ObjectKey!.ToString()!);
        // Under a deep scope kept earlier, only what that scope had is old (an earlier op may have created the rest).
        Scope? above = null;
        for (var p = Parent(root); p != null && above == null; p = Parent(p))
            if (_scopes.TryGetValue(p, out var s) && s.Deep) above = s;
        bool Old(IObjectSignature o) => o.ObjectKey?.ToString() is not { } key || !fresh.Contains(key) && (above == null || above.Keys.Contains(key));
        var children = new HashSet<IObjectSignature>(DirectChildren(root).Where(Old), ReferenceEqualityComparer.Instance);
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var o in deep ? Subtree(root).Where(Old) : children)
            if (o.ObjectKey?.ToString() is { } key) keys.Add(key);
        _oldKeys.UnionWith(keys);
        if (root.ObjectKey?.ToString() is { } own) _oldKeys.Add(own);
        _scopes[root] = new(deep, known?.Children ?? children, keys);
    }

    /// <summary>Whether the parent of <paramref name="o"/> holds it as an element (a child, a native descendant).</summary>
    private bool Held(IObjectSignature o)
    {
        if (ReferenceEquals(o, _es)) return true;
        if (Parent(o) is not { } parent) return false;
        return DirectChildren(parent).Contains(o) || parent.GetAllDescendantsOfType<IObjectSignature>().Contains(o);
    }

    private static bool IsUnder(IObjectSignature o, IObjectSignature ancestor)
    {
        for (var p = Parent(o); p != null; p = Parent(p)) if (ReferenceEquals(p, ancestor)) return true;
        return false;
    }

    /// <summary>The objects a scope sees as new now: in a deep scope, every object of the subtree no kept scope had; in a shallow
    /// one, every new direct child and its subtree.</summary>
    private IEnumerable<IObjectSignature> NewIn(IObjectSignature root, Scope scope)
    {
        bool New(IObjectSignature o) => !o.WasDeleted && o.ObjectKey?.ToString() is { } key && !_oldKeys.Contains(key);
        if (root.WasDeleted) yield break;
        if (scope.Deep)
        {
            foreach (var o in Subtree(root)) if (New(o)) yield return o;
            yield break;
        }
        foreach (var child in DirectChildren(root))
        {
            if (scope.Children.Contains(child) || !New(child)) continue;
            yield return child;
            foreach (var o in Subtree(child)) if (New(o)) yield return o;
        }
    }

    /// <summary>Whether <paramref name="o"/> existed before the job: some kept scope had its key, or, below the nearest kept
    /// ancestor, the first object of its path was in that ancestor's list (an object outside the module never is).</summary>
    private bool ExistedBefore(IObjectSignature o)
    {
        if (ReferenceEquals(o, _es)) return true;
        if (o.ObjectKey?.ToString() is { } key && _oldKeys.Contains(key)) return true;
        var below = o;
        for (var p = Parent(o); p != null; below = p, p = Parent(p))
            if (_scopes.TryGetValue(p, out var kept))
                return kept.Deep ? below.ObjectKey?.ToString() is { } k && kept.Keys.Contains(k) : kept.Children.Contains(below);
        return false;
    }

    private static IObjectSignature? Parent(IObjectSignature o) => o.Parent as IObjectSignature;

    /// <summary>The scope roots of one op, kept before it runs.</summary>
    private void FootprintScopes(string kind, JsonObject op)
    {
        if (!_footprintBegun || kind is "get" or "find" or "dump" or "usages" or "layout") return;
        foreach (var field in new[] { "parent", "target", "from", "to", "into", "before", "after" })
        {
            if (op[field] is not JsonValue v || !v.TryGetValue<string>(out var reference) || reference.Length == 0) continue;
            object resolved;
            try { resolved = Resolve(reference); } catch { continue; }
            if (resolved is not IObjectSignature root) continue;
            if (Parent(root) is { } parent) Keep(parent, deep: false);
            Keep(root, deep: true);
            // A parameter created under an action, a screen or a block gives its callers an argument; a replace rebinds the
            // callers of what it replaces.
            if (kind is "create" or "duplicate" && field is "parent" or "into" || kind == "replace" && field == "from")
                foreach (var caller in Callers(root)) Keep(caller, deep: false);
        }
        if (kind == "reference")
            foreach (var reference in _es.References.OfType<IObjectSignature>()) Keep(reference, deep: false);
    }

    /// <summary>The objects that refer to <paramref name="o"/> (call nodes, block instances, destinations), bounded.</summary>
    private static IEnumerable<IObjectSignature> Callers(IObjectSignature o)
    {
        if (o is not ServiceStudio.Model.AbstractObject model) return [];
        try { return model.Referers.OfType<IObjectSignature>().Take(500).ToArray(); } catch { return []; }
    }

    /// <summary>The footprint after the apply, from the scope roots (B3): no full sweep of the module.</summary>
    public FootprintReport Footprint(int limit = 200)
    {
        var created = new List<IObjectSignature>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (root, scope) in _scopes)
            foreach (var o in NewIn(root, scope))
                if (seen.Add(o.ObjectKey!.ToString()!)) created.Add(o);
        var createdKeys = created.Select(o => o.ObjectKey!.ToString()!).ToHashSet(StringComparer.Ordinal);
        // Changed: what a write touched that some kept scope had (it existed before) and that the module holds (a view the
        // Model API builds on access, like a form's `content`, is no element of its own: the sweep never sees it).
        var changed = _touched.OfType<IObjectSignature>().Where(o => !o.WasDeleted && o.ObjectKey?.ToString() is { } k && !createdKeys.Contains(k) && _oldKeys.Contains(k) && Held(o))
            .GroupBy(o => o.ObjectKey!.ToString()!).Select(g => g.First()).ToList();
        return Report(created, createdKeys, changed, limit);
    }

    /// <summary>B3 audit: the differences between two footprints (the scopes' and the sweep's), as text.</summary>
    internal IEnumerable<string> FootprintDifferences(JobFootprint scopes, JobFootprint sweep)
    {
        string What(string key)
        {
            IObjectSignature? o = null;
            try { o = Resolve("@" + key) as IObjectSignature; } catch { }
            o ??= _touched.OfType<IObjectSignature>().FirstOrDefault(t => t.ObjectKey?.ToString() == key);
            if (o == null) return key + " (does not resolve)";
            // The path with the kind of each link: '/' a child, '~' held otherwise (not in its parent's Children).
            var path = new List<string>();
            for (var n = o; n != null; n = Parent(n))
                path.Insert(0, (Parent(n) is { } p && !DirectChildren(p).Contains(n) ? "~" : "/") + ShortType(n) + ":" + TypeResolver.Name(n));
            return $"{key} {string.Concat(path)}{(o.WasDeleted ? " (deleted)" : "")}";
        }
        foreach (var (name, a, b) in new[] { ("created", scopes.Created, sweep.Created), ("changed", scopes.Changed, sweep.Changed), ("screens", scopes.Screens, sweep.Screens) })
        {
            foreach (var key in b.Except(a)) yield return $"{name}: the sweep has {What(key)}, the scopes do not";
            foreach (var key in a.Except(b)) yield return $"{name}: the scopes have {What(key)}, the sweep does not";
        }
    }

    /// <summary>The footprint after the apply, against the keys read before it (the full sweep).</summary>
    public FootprintReport Footprint(IReadOnlySet<string> before, int limit = 200)
    {
        var created = new List<IObjectSignature>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var o in new KernelModelReader().Walk(_es).Concat(Descendants()))
        {
            var key = o.ObjectKey?.ToString();
            if (key == null || before.Contains(key) || !seen.Add(key) || o.WasDeleted) continue;
            created.Add(o);
        }
        var createdKeys = created.Select(o => o.ObjectKey!.ToString()!).ToHashSet(StringComparer.Ordinal);
        var changed = _touched.OfType<IObjectSignature>().Where(o => !o.WasDeleted && o.ObjectKey?.ToString() is { } k && before.Contains(k))
            .GroupBy(o => o.ObjectKey!.ToString()!).Select(g => g.First()).ToList();
        return Report(created, createdKeys, changed, limit);
    }

    private FootprintReport Report(List<IObjectSignature> created, HashSet<string> createdKeys, List<IObjectSignature> changed, int limit)
    {
        var screens = new Dictionary<string, (IObjectSignature Screen, string Mode)>(StringComparer.Ordinal);
        foreach (var o in created.Concat(changed))
            for (var p = o; p != null; p = p.Parent as IObjectSignature)
            {
                if (!ModelHost.IsScreen(p) || p.ObjectKey?.ToString() is not { } screenKey) continue;
                var mode = createdKeys.Contains(screenKey) ? "create" : "update";
                if (!screens.ContainsKey(screenKey)) screens[screenKey] = (p, mode);
                break;
            }
        JsonObject Entry(IObjectSignature o) => new()
        {
            ["key"] = o.ObjectKey?.ToString(), ["kind"] = ShortType(o), ["name"] = TypeResolver.Name(o) is { Length: > 0 } n ? n : null, ["path"] = ModelHost.PathOf(o)
        };
        // Deterministic order: the path, then the key (the native traversal order is not stable between loads).
        JsonArray Page(IEnumerable<IObjectSignature> items) => new(items.Select(Entry).OrderBy(e => e["path"]?.ToString(), StringComparer.Ordinal)
            .ThenBy(e => e["key"]?.ToString(), StringComparer.Ordinal).Take(limit).Select(e => (JsonNode)e).ToArray());
        var json = new JsonObject
        {
            ["created"] = Page(created), ["createdTotal"] = created.Count,
            ["changed"] = Page(changed), ["changedTotal"] = changed.Count,
            ["screens"] = new JsonArray(screens.OrderBy(s => TypeResolver.Name(s.Value.Screen), StringComparer.Ordinal).ThenBy(s => s.Key, StringComparer.Ordinal).Take(limit)
                .Select(s => (JsonNode)new JsonObject { ["name"] = TypeResolver.Name(s.Value.Screen), ["key"] = s.Key, ["mode"] = s.Value.Mode }).ToArray()),
            ["screensTotal"] = screens.Count,
        };
        return new(new JobFootprint(createdKeys, changed.Select(o => o.ObjectKey!.ToString()!).ToHashSet(StringComparer.Ordinal),
            screens.Keys.ToHashSet(StringComparer.Ordinal)), json);
    }
}
