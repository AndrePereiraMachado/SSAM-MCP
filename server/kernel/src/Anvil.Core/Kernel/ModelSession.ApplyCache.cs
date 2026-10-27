using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// S12 (apply indexes): the indexes of names the apply reads again and again, kept while one op runs and dropped by the
/// mutation that can change one of their answers. Never across ops of a job nor across captures (the hot module keeps the
/// model, never these). A watch records, for every verb applied while it is open, the names of the elements the verb
/// created, renamed or moved (with their descendants: an entity's actions are born and renamed with it); a verb whose effect
/// on names it cannot tell (a compound op, a replace) marks every name. A cache answers a name no mutation touched since it
/// was built; any other name rebuilds it, so its answers are the ones a fresh index of the model now would give.
/// ANVIL_APPLY_CACHES=off (tests only: ApplyCacheTests compares both candidates) reads the model every time, as before.
/// </summary>
public sealed partial class ModelSession
{
    internal static bool ApplyCachesOn => ApplyCachesOverride.Value
        ?? !string.Equals(Environment.GetEnvironmentVariable("ANVIL_APPLY_CACHES"), "off", StringComparison.OrdinalIgnoreCase);

    /// <summary>Tests only: the caches on or off for the calls of this flow, whatever the variable says (the equivalence test
    /// runs both sides in one process without touching the other tests).</summary>
    internal static readonly AsyncLocal<bool?> ApplyCachesOverride = new();

    /// <summary>The names the mutations touched since the watch began (any case); All: any name may have changed.</summary>
    internal sealed class NameWatch
    {
        internal readonly HashSet<string> Touched = new(StringComparer.OrdinalIgnoreCase);
        internal bool All;
        internal bool Clean(string name) => !All && !Touched.Contains(name);
        internal void Reset() { Touched.Clear(); All = false; }
    }

    private readonly List<NameWatch> _nameWatches = [];

    private NameWatch BeginNameWatch() { var watch = new NameWatch(); _nameWatches.Add(watch); return watch; }
    private void EndNameWatch(NameWatch? watch) { if (watch != null) _nameWatches.Remove(watch); }

    // The verbs whose effect on names is the element they name or create (and what lies below it). Set writes a name only
    // through Name or Label; link and delete never change a name (a deleted element is read as deleted by every index).
    private static bool NamesOfTarget(string kind, JsonObject op) =>
        kind is "rename" or "move" || kind == "set" && op["prop"]?.ToString() is "Name" or "Label";

    /// <summary>Before a verb: the names of what it renames or moves, as they are now.</summary>
    private void WatchNamesBefore(string kind, JsonObject op, object? renamed)
    {
        if (_nameWatches.Count == 0 || !NamesOfTarget(kind, op)) return;
        object? target = renamed;
        if (target == null) { try { target = Resolve(Req(op, "target")); } catch (Exception) { MarkAllNames(); return; } }
        TouchNames(target as IObjectSignature);
    }

    /// <summary>After a verb: the names of what it created, duplicated, renamed or moved, as they are now; every name for a verb
    /// that is neither of those nor one that never names (set of another property, link, delete, the reads).</summary>
    private void WatchNamesAfter(string kind, JsonObject op, object? renamed, IObjectSignature? written)
    {
        if (_nameWatches.Count == 0) return;
        switch (kind) {
            case "create" or "duplicate":
                if (written == null) MarkAllNames(); else TouchNames(written);
                break;
            case "rename" or "move" or "set" when NamesOfTarget(kind, op):
                object? target = renamed;
                if (target == null) { try { target = Resolve(Req(op, "target")); } catch (Exception) { MarkAllNames(); return; } }
                TouchNames(target as IObjectSignature);
                break;
            case "set" or "link" or "delete" or "get" or "find" or "usages" or "dump":
                break;
            default:
                MarkAllNames();
                break;
        }
    }

    private void MarkAllNames() { foreach (var watch in _nameWatches) watch.All = true; }

    // The names as the indexes of the op key them (TypeResolver.Name: ModelBaseFacts). A flow node or a widget is never one of
    // the elements they answer (an action, a record, a variable) nor holds one: the verbs a text writes are mostly on them.
    private void TouchNames(IObjectSignature? element)
    {
        if (element == null) { MarkAllNames(); return; }
        if (element is IFlowNode or OutSystems.Model.UI.IWidget) return;
        using var timing = NativePerformanceCapture.Measure("watch.names");
        foreach (var item in element.GetAllDescendantsOfType<IObjectSignature>().Prepend(element))
            if (TypeResolver.Name(item) is { Length: > 0 } name)
                foreach (var watch in _nameWatches) watch.Touched.Add(name);
    }
}
