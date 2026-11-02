using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// B4 (the proto line's lote 4, F2: 0abbad00, 9daca5c2; relatos 8ea13c21, 31a4b527 and 0e627037, a delivery that said success
/// while the runtime showed the old CSS): where the CSS of a set StyleSheet landed and what serves it at runtime. Each set
/// StyleSheet of the job is read again once the job's ops have run (a later op may give the theme to a flow): its result carries
/// css.placement (ThemeCss.Placement) and the receipt the list cssPlacement. A theme that was already in the module, that no page
/// of this module shows and that is not public is refused (CSS_TARGET_UNSERVED, one more failure of the single refusal, nothing
/// saved); a theme the job itself creates is being prepared (a later job may give it to a flow): a warning, as a block no page
/// places. Without a footprint (what the job created is unknown) nothing is refused.
/// </summary>
public sealed partial class ModelSession
{
    private readonly List<(int Op, JsonObject Source, JsonObject? Result)> _styleSheetSets = [];

    /// <summary>A set StyleSheet of the job, read at the end of the apply.</summary>
    internal void StyleSheetSet(int op, JsonObject source, JsonNode? result)
    {
        if (_applyOps == null) return;
        _styleSheetSets.Add((op, source, result as JsonObject));
    }

    private void CssPlacementReview(List<ApplyFailure> failures)
    {
        var sets = _styleSheetSets.ToList();
        _styleSheetSets.Clear();
        if (sets.Count == 0) return;
        // What the job created (the footprint, B3); unknown without a footprint, and then nothing is refused.
        HashSet<IObjectSignature>? created = null;
        if (_footprintBegun)
            try { created = JobObjects().Created; } catch { created = null; } finally { _dataAccessObjects = null; }
        foreach (var (op, source, result) in sets)
        {
            JsonObject placement;
            IObjectSignature target;
            try
            {
                if (Resolve(Req(source, "target")) is not IObjectSignature { WasDeleted: false } written) continue;
                target = written;
                placement = ThemeCss.Placement(target, (IObjectSignature)_espace);
            }
            catch (Exception) { continue; }
            if (result != null) result["css"] = new JsonObject { ["placement"] = placement.DeepClone() };
            var entry = placement.DeepClone().AsObject();
            entry["op"] = op;
            Report("cssPlacement", entry);
            if (placement["served"]?.GetValue<bool>() != false) continue;
            var name = placement["name"]?.ToString();
            var shown = (placement["shownThemes"] as JsonArray)?.Select(n => n?.ToString()).Where(n => n != null).ToList() ?? [];
            var fresh = created == null || created.Contains(target);
            if (placement["object"]?.ToString() == "theme" && !fresh)
            {
                var message = $"set StyleSheet on the theme {name}: {placement["why"]}; the CSS would be saved and published and never reach the runtime";
                var fix = (shown.Count > 0 ? $"write the CSS in a theme the pages show ({string.Join(", ", shown)}: read it first and write the whole, or use <style scope=\"theme\">), " : "")
                    + $"or give the theme to the flow that should show it (set IMobileFlow:<flow> Theme {name}), or make it the BaseTheme of a theme a flow shows";
                var problem = new JsonObject
                {
                    ["code"] = ThemeCss.TargetUnserved, ["severity"] = "error", ["op"] = op, ["pointer"] = OpsPointer == null ? null : $"{OpsPointer}/{op}/target",
                    ["message"] = message, ["fix"] = fix, ["placement"] = placement.DeepClone(),
                };
                failures.Add(new ApplyFailure(op, "set", source,
                    new KernelRefusalException(ThemeCss.TargetUnserved, $"op #{op} (set StyleSheet): [{ThemeCss.TargetUnserved}] {message}. Fix: {fix}", new JsonArray(problem))));
                continue;
            }
            Report("highWarnings", new JsonObject
            {
                ["code"] = ThemeCss.TargetUnserved, ["severity"] = "medium", ["op"] = op,
                ["message"] = $"set StyleSheet on the {placement["object"]} {name}: {placement["why"]}"
                    + (placement["object"]?.ToString() == "theme" ? " (the theme is new in this job: not refused)" : ""),
                ["fix"] = placement["object"]?.ToString() == "theme"
                    ? $"give the theme to the flow that should show it (set IMobileFlow:<flow> Theme {name}), or make it the BaseTheme of a theme a flow shows"
                    : "place the block on the screen that should show it, or make it public when other modules place it",
            });
        }
    }
}
