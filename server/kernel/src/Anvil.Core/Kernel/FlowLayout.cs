using OutSystems.Model;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

/// <summary>Refused is set when the engine found no clear grid cell: the flow then keeps
/// its current coordinates, labels and End nodes (Moved = SeparatedEnds = 0).</summary>
public sealed record LayoutOutcome(string Action, int Nodes, int Rows, int Columns, int Moved, int SeparatedEnds = 0, string? Refused = null)
{
    public string EngineRevision => FlowLayout.EngineRevision;
}

/// <summary>
/// Native canvas adapter (1/20 px). Forward joins are ranked after every incoming branch;
/// loops retain their back edges. Shared action End nodes are split into equivalent
/// terminal copies; all nonterminal nodes and branch semantics are preserved.
/// </summary>
public static partial class FlowLayout
{
    public const string EngineRevision = "anvil-d4d8ece";
    public const int Unit = 20, X0 = 160 * Unit, ColStep = 80 * Unit, Y0 = 40 * Unit, RowStep = 80 * Unit;

    /// <summary>Native positions are twentieths of a pixel. Keep at least one
    /// standard row of separation on either axis; preserve already readable manual layouts.</summary>
    public static bool HasCrowdedNodes(IEnumerable<IFlowNode> allNodes)
    {
        var nodes = allNodes.ToArray();
        for (var i = 0; i < nodes.Length; i++)
            for (var j = i + 1; j < nodes.Length; j++)
                if (Math.Abs((long)nodes[i].HorizontalPosition - nodes[j].HorizontalPosition) < RowStep &&
                    Math.Abs((long)nodes[i].VerticalPosition - nodes[j].VerticalPosition) < RowStep) return true;
        return false;
    }

    public static LayoutOutcome Apply(IAction action) => Apply(action.Nodes, action.GetType().GetProperty("Name")?.GetValue(action) as string ?? "?");

    /// <summary>Qualquer fluxo com nos (action, preparation, data action, processo): so precisa de um Start.</summary>
    /// <summary>The flow as the engine sees it: End copies already separated (Undo reverts
    /// them), vertices numbered in canonical order, Start = vertex 0.</summary>
    internal sealed record PreparedFlow(List<IFlowNode> Nodes, FlowGraphLayout.Vertex[] Graph, int Start, List<Action> Undo);

    internal static PreparedFlow Prepare(IEnumerable<IFlowNode> allNodes)
    {
        // The model returns Nodes in a different order on every load. Number the
        // vertices canonically (DFS from Start in connector order, then by key) so
        // that the same flow always gets the same geometry and a second pass is idempotent.
        var nodes = CanonicalOrder(allNodes.ToList());
        var separated = SeparateActionEnds(nodes);
        if (separated.Count > 0) nodes = CanonicalOrder(nodes);
        var ids = nodes.Select((node, id) => (node, id)).ToDictionary(x => x.node, x => x.id);
        var graph = nodes.Select(n => new FlowGraphLayout.Vertex(
            Successors(n).Where(s => ids.ContainsKey(s.Node)).Select(s => ids[s.Node]).Distinct().ToArray(),
            n is IForEachNode fe && fe.Target != null && ids.TryGetValue(fe.Target, out var exit) ? exit : null,
            n is IRaiseExceptionNode || IsEnd(n), n is IExceptionHandlerNode)).ToArray();
        return new PreparedFlow(nodes, graph, ids[nodes[0]], separated);
    }

    public static LayoutOutcome Apply(IEnumerable<IFlowNode> allNodes, string flowName) => Apply(allNodes, flowName, FlowGraphLayout.Arrange);

    internal static LayoutOutcome Apply(IEnumerable<IFlowNode> allNodes, string flowName,
        Func<IReadOnlyList<FlowGraphLayout.Vertex>, int, FlowGraphLayout.Cell[]> arrange)
    {
        var (nodes, graph, start, separated) = Prepare(allNodes);
        FlowGraphLayout.Cell[] positions;
        try { positions = arrange(graph, start); }
        catch (FlowLayoutRefusedException refusal)
        {
            // A refusal must never abort the job that touched this flow: undo the
            // End copies and keep every coordinate and label exactly as it was.
            foreach (var restore in Enumerable.Reverse(separated)) restore();
            return new LayoutOutcome(flowName, nodes.Count - separated.Count, 0, 0, 0, 0, refusal.Message);
        }
        var separatedEnds = separated.Count;
        var moved = 0;
        for (var i = 0; i < nodes.Count; i++)
        {
            if (nodes[i] is IIfNode decision && System.Text.RegularExpressions.Regex.IsMatch(decision.Label ?? "", @"^(If|While)\d*$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                && !string.IsNullOrWhiteSpace(decision.Condition.Text))
                decision.Label = decision.Condition.Text.Trim();
            var x = X0 + positions[i].Column * ColStep;
            var y = Y0 + positions[i].Row * RowStep;
            if (nodes[i].HorizontalPosition != x || nodes[i].VerticalPosition != y) moved++;
            nodes[i].HorizontalPosition = x;
            nodes[i].VerticalPosition = y;
        }
        return new LayoutOutcome(flowName, nodes.Count, positions.Max(p => p.Row) + 1, positions.Max(p => p.Column) + 1, moved, separatedEnds);
    }
    // This is terminal normalization, not routing. Never duplicate process End
    // nodes: BPT termination has different semantics from action returns.
    // Returns one undo step per copy (restore the connector, delete the copy).
    private static List<Action> SeparateActionEnds(List<IFlowNode> nodes)
    {
        var undo = new List<Action>();
        foreach (var end in nodes.OfType<IEndNode>().ToArray())
        {
            var incoming = nodes.OfType<IActionNode>().SelectMany(n => n.Connectors)
                .Where(c => ReferenceEquals(TargetOf(() => c.Target), end)).ToArray();
            foreach (var connector in incoming.Skip(1))
            {
                var owner = (IObject)((IObjectSignature)end).Parent;
                var copy = (IEndNode)owner.Duplicate((IObjectSignature)end);
                connector.Target = copy;
                nodes.Add(copy);
                undo.Add(() => { connector.Target = end; ((IObjectSignature)copy).Delete(); });
            }
        }
        return undo;
    }

    private static string KeyOf(IFlowNode n) => n.ObjectKey?.ToString() ?? "";

    /// <summary>Start first (lowest key if several), then a DFS in connector order;
    /// entries without a predecessor (handlers) and any leftover node follow by key.</summary>
    internal static List<IFlowNode> CanonicalOrder(List<IFlowNode> nodes)
    {
        var byKey = nodes.OrderBy(KeyOf, StringComparer.Ordinal).ToList();
        var start = byKey.FirstOrDefault(IsStart) ?? byKey.FirstOrDefault(n => n is IExceptionHandlerNode)
            ?? throw new InvalidOperationException("flow without Start");
        var members = new HashSet<IFlowNode>(nodes);
        var targeted = new HashSet<IFlowNode>(nodes.SelectMany(n => Successors(n).Select(s => s.Node)).Where(members.Contains));
        var order = new List<IFlowNode>(nodes.Count);
        var seen = new HashSet<IFlowNode>();
        void Visit(IFlowNode root)
        {
            var stack = new Stack<IFlowNode>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var n = stack.Pop();
                if (!seen.Add(n)) continue;
                order.Add(n);
                foreach (var s in Successors(n).Select(s => s.Node).Where(members.Contains).Reverse()) stack.Push(s);
            }
        }
        Visit(start);
        foreach (var n in byKey.Where(n => !targeted.Contains(n))) Visit(n);
        foreach (var n in byKey) Visit(n);
        return order;
    }

    private static bool IsStart(IFlowNode n) => n is IStartNode || n is OutSystems.Model.Processes.Nodes.IStartNode;
    private static bool IsEnd(IFlowNode n) => n is IEndNode || n is OutSystems.Model.Processes.Nodes.IEndNode;

    /// <summary>Sucessores de um no com a marca de "ramo" (sai da coluna principal). Nos de processo usam os conectores genericos.</summary>
    internal static IEnumerable<(IFlowNode Node, bool Branch)> Successors(IFlowNode n)
    {
        switch (n)
        {
            case IIfNode i:
                if (i.FalseTarget != null) yield return (i.FalseTarget, false);
                if (i.TrueTarget != null) yield return (i.TrueTarget, true);
                yield break;
            case IForEachNode f:
                if (f.CycleTarget != null) yield return (f.CycleTarget, true);
                if (f.Target != null) yield return (f.Target, false);
                yield break;
            case ISwitchNode s:
                foreach (var c in s.Conditions) if (TargetOf(() => c.Target) is IActionNode t) yield return (t, true);
                if (s.OtherwiseTarget != null) yield return (s.OtherwiseTarget, false);
                yield break;
            case IActionNode a:
                foreach (var c in a.Connectors) if (TargetOf(() => c.Target) is { } t) yield return (t, false);
                yield break;
            default:
                // processos (IProcessNode.Connectors) e qualquer outro no com Connectors: Target e IFlowNode; a partir do 2o conector e ramo
                var idx = 0;
                if (n.GetType().GetProperty("Connectors")?.GetValue(n) is System.Collections.IEnumerable conns)
                    foreach (var c in conns)
                        if (c is IConnector ic && TargetOf(() => ic.Target) is { } t) yield return (t, idx++ > 0);
                yield break;
        }
    }

    /// <summary>O alvo de um conector, ou null quando o getter tipado da plataforma nao o consegue dar: a condicao de um
    /// Switch sem alvo (SwitchCondition.TargetNode cai com NullReferenceException no O11; o duplicate de um Switch deixa-a
    /// assim) e o conector de comentario cujo alvo nao e no de logica (o End de um processo, a tela de um fluxo de UI:
    /// IActionConnector.Target cai com InvalidCastException). Nenhum dos dois e aresta do layout, e o layout corre depois
    /// das ops, fora de qualquer uma: deixa-se o Verify dizer o que faltar.</summary>
    private static IFlowNode? TargetOf(Func<IFlowNode?> target)
    {
        try { return target(); }
        catch (Exception ex) when (ex is NullReferenceException or InvalidCastException) { return null; }
    }

}
