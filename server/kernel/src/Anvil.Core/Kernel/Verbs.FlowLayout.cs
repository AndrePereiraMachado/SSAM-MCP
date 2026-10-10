using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    public IReadOnlyList<LayoutOutcome> AutomaticLayouts { get; private set; } = [];

    // Compare the final graph, including deletions and coordinates. Do not touch an
    // unrelated manual flow or relayout an incomplete graph midway through raw ops.
    private IEnumerable<IGrouping<IObjectSignature, IFlowNode>> FlowGroups() =>
        Descendants().OfType<IFlowNode>().GroupBy(n => (IObjectSignature)((IObjectSignature)n).Parent);

    private static string FlowShape(IEnumerable<IFlowNode> nodes) => string.Join("\n", nodes
        .OrderBy(n => n.ObjectKey.ToString(), StringComparer.Ordinal)
        .Select(n => $"{n.ObjectKey}:{n.HorizontalPosition}:{n.VerticalPosition}:" +
            string.Join(",", FlowLayout.Successors(n).Select(s => s.Node.ObjectKey.ToString()))));

    private Dictionary<string, string> CaptureFlowLayouts() => FlowGroups()
        .ToDictionary(g => g.Key.ObjectKey.ToString()!, g => FlowShape(g));

    private IReadOnlyList<LayoutOutcome> LayoutChangedFlows(IReadOnlyDictionary<string, string> before)
    {
        var results = new List<LayoutOutcome>();
        foreach (var flow in FlowGroups().ToArray())
        {
            if (before.TryGetValue(flow.Key.ObjectKey.ToString()!, out var shape) && shape == FlowShape(flow)) continue;
            // Leave malformed flows to native Verify, keeping its original diagnostic.
            if (!flow.Any(n => n is IStartNode or IExceptionHandlerNode or OutSystems.Model.Processes.Nodes.IStartNode)) continue;
            results.Add(FlowLayout.Apply(flow, TypeResolver.Name(flow.Key) ?? flow.Key.ObjectKey.ToString()!));
        }
        return results;
    }
}
