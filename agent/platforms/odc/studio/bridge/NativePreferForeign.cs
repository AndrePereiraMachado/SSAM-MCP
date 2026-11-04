using System.Text.Json.Nodes;
using Anvil.Bridge;
using ServiceStudio.Model;
using OutSystems.Model.Merge;
using ServiceStudio.Presenter;
using OutSystems.Model.Commands;

// The ODC command boundary. Selection is shared with O11; no model-wide foreign replacement.
internal static class NativePreferForeign {
    internal const string Capability = "merge:prefer-foreign";

    internal static bool Available(out string? reason, Type? treeType = null) {
        try { PreferForeign.Find(treeType ?? typeof(MatchTree)); reason = null; return true; }
        catch (Exception ex) { reason = ex.Message; return false; }
    }

    internal sealed class NotApplied(string message) : InvalidOperationException(message);
    internal sealed class Unknown(string message) : InvalidOperationException(message);

    internal static JsonObject? Merge(IAggregatorPresenter presenter, ESpace local, ESpace foreign, ESpace basis,
        Func<string> liveSha, Action? enteringNativeMerge = null, ESpace? finalCandidate = null, Action? afterNativeMerge = null,
        Action<MatchTree>? afterSelection = null) {
        var before = liveSha();
        JsonObject? resolved = null;
        var entered = false;
        var completed = false;
        Exception? failure = null;
        var context = presenter.GetPresenterContext();
        try { Command.Execute(context, "SSAM: merge delivery", () => {
          try {

            using (var tree = new MatchTree(local, foreign, basis, false, true)) {
            if (tree.HasConflicts) resolved = PreferForeign.Resolve(tree, int.MaxValue).Receipt();
            afterSelection?.Invoke(tree);
            if (tree.HasUnresolvedConflicts)
                throw new InvalidOperationException("MERGE_CONFLICT: unresolved conflicts; nothing was merged.");
            entered = true;
            enteringNativeMerge?.Invoke();
            tree.Merge();
            afterNativeMerge?.Invoke();
            tree.ClearCurrentMergeState();
            if (tree.CanMerge) throw new InvalidOperationException("The native merge did not merge its tree.");
            }
            if (finalCandidate != null) {
                using var second = new MatchTree(local, finalCandidate, foreign, false, true);
                if (second.HasConflicts) throw new InvalidOperationException("MERGE_CONFLICT: the second pass has conflicts.");
                if (!second.HasNoDifferences) { second.Merge(); second.ClearCurrentMergeState(); }
            }
            completed = true;
          } catch (Exception ex) { failure = ex; Command.RollbackCurrentCommand(context.SourceTopLevelPresenter); }
        }); } catch (Exception ex) { failure ??= ex; }
        if (failure != null) {
            if (!entered) throw new NotApplied("MERGE_CONFLICT: " + failure.Message);
            string? after = null;
            try { after = liveSha(); } catch { /* No readable hash is no rollback proof. */ }
            if (string.Equals(before, after, StringComparison.Ordinal))
                throw new NotApplied("MERGE_CONFLICT: the Studio rolled back the merge; the module equals its pre-merge snapshot. " + failure.Message);
            throw new Unknown("The native merge outcome is unknown. " + failure.Message);
        }
        if (!completed) throw new Unknown("The native merge outcome is unknown: the command callback did not complete.");
        return resolved;
    }
}
