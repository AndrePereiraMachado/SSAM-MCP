using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.UI;

namespace Anvil.Core;

/// <summary>
/// C36 of the atritos 3 package: a delete counts the consumers that will really be there. An empty placeholder content (a
/// block instance's IPlaceholderContentWidget with no widget) that fills the placeholder being deleted goes with it, as in
/// the Studio (lab 43: "IPlaceholderWidget HeaderActions is used by 3 consumer(s)", all empty). A consumer that a later op
/// of the same job deletes, or that a later `replace` repoints, does not count: the delete is pending and runs at the end of
/// the apply, judged again there (DELETE_HAS_CONSUMERS 2x in a client migration session with the consumer removed in the same job).
/// </summary>
public sealed partial class ModelSession
{
    // The top-level ops of the Apply that runs and the index of the op being applied (null outside Apply).
    private JsonArray? _applyOps;
    private int _applyIndex;
    private readonly List<(int Index, JsonObject Op)> _pendingDeletes = [];

    /// <summary>A placeholder content with no widget inside that fills <paramref name="placeholder"/>.</summary>
    private static bool EmptyPlaceholderContent(object referer, IObjectSignature placeholder)
        => referer is IObjectSignature content && Implements(content, "IPlaceholderContentWidget") && Implements(placeholder, "IPlaceholderWidget")
           && !content.Children.Any(c => c is IWidget);

    /// <summary>Whether every consumer is inside the target of a later delete of this job, or the later ops repoint the target
    /// (replace from it). A later op whose target does not resolve now counts for nothing.</summary>
    private bool LaterRemoved(IReadOnlyList<(ServiceStudio.Model.AbstractObject Referer, string Path)> consumers, IObjectSignature target)
    {
        if (_applyOps == null) return false;
        var removed = new List<IObjectSignature>();
        for (var i = _applyIndex + 1; i < _applyOps.Count; i++)
        {
            if (_applyOps[i] is not JsonObject later) continue;
            var kind = later["op"]?.ToString();
            try
            {
                if (kind == "delete" && Resolve(later["target"]?.ToString() ?? "") is IObjectSignature gone) removed.Add(gone);
                else if (kind == "replace" && ReferenceEquals(Resolve(later["from"]?.ToString() ?? ""), target)) return true;
            }
            catch { /* resolved by its own op */ }
        }
        return removed.Count > 0 && consumers.All(c => c.Referer is IObjectSignature r && removed.Any(g => ReferenceEquals(r, g) || IsInside(r, g)));
    }
}
