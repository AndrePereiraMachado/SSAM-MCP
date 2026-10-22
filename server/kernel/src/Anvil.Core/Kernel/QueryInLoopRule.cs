using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

/// <summary>
/// QUERY_IN_LOOP (decisao do dono, 2026-10-09): um Aggregate ou um Execute SQL dentro do corpo de um laco (ForEach, ou um
/// ciclo de If/Assign que volta a um no anterior) e RECUSADO. Decidido no modelo candidato depois das ops (logic, html,
/// screen e sets crus cobertos igualmente), em ModelSession.Apply, junto com as outras falhas da transacao (A02 item 6:
/// uma recusa so, com todos os problemas). Os lacos sao as componentes fortemente conexas do grafo do fluxo
/// (FlowLayout.Successors): um no esta no laco quando sai do cabecalho e volta a ele.
///
///  * Recusa (erro, phase apply): o no de consulta foi criado ou mudado pelo job, ou o job criou o ForEach/If que fecha o
///    laco em volta dele. A resposta traz o op de origem, o laco, a consulta e a correcao exata (consulta antes do laco com
///    join/filtro pela chave da lista iterada, depois ListFilter/ListIndexOf ou busca por chave dentro do laco), com o
///    trecho de ops pronto quando o laco e um ForEach sobre outro aggregate do mesmo fluxo e ha FK entre as entidades.
///  * Legado: num fluxo que o job tocou, o laco e a consulta que o job nao criou nem mudou sao um aviso HIGH (highWarnings),
///    nunca recusa. Fluxos que o job nao tocou nao sao lidos.
///  * Escape: `"allowQueryInLoop": {"why": "&lt;texto &gt;= 15 caracteres&gt;"}` no op que criou a consulta (ou o laco) aceita, e o
///    recibo registra QUERY_IN_LOOP_ALLOWED em highWarnings com o motivo; nunca silencioso.
/// Testes: QueryRulesTests (O11) e QueryRulesOdcTests (ODC).
/// </summary>
public static class QueryInLoopRule
{
    public const string Code = "QUERY_IN_LOOP";
    public const string AllowedCode = "QUERY_IN_LOOP_ALLOWED";
    public const string AllowKey = "allowQueryInLoop";
    public const int MinimumWhy = 15;

    /// <summary>The why of a valid escape on <paramref name="op"/>, or null (absent, or too short: then <paramref name="invalid"/> says why).</summary>
    public static string? Allowed(JsonObject? op, out string? invalid)
    {
        invalid = null;
        if (op?[AllowKey] is not { } flag) return null;
        var why = flag is JsonObject o && o["why"] is JsonValue w && w.TryGetValue<string>(out var text) ? text.Trim() : null;
        if (why != null && why.Length >= MinimumWhy) return why;
        invalid = $"{AllowKey} needs {{\"why\": \"<at least {MinimumWhy} characters>\"}}";
        return null;
    }

    /// <summary>The HIGH warnings of an apply (its `highWarnings`) in the I9 shape of the delivery answers ({id, path, detail,
    /// fix}) plus severity "high", the op and the suggestion: what Delivery puts first in `warnings` and in `highWarnings`.</summary>
    public static JsonArray HighWarnings(JsonArray? applied)
    {
        var result = new JsonArray();
        foreach (var w in (applied ?? new JsonArray()).OfType<JsonObject>())
        {
            var path = string.Join(" / ", new[] { w["flow"] ?? w["owner"], w["loop"], w["query"] }.Select(n => n?.ToString()).Where(n => !string.IsNullOrEmpty(n)));
            var warning = new JsonObject
            {
                ["id"] = w["code"]?.ToString() ?? "", ["severity"] = "high", ["path"] = path,
                ["detail"] = VerifyHints.OneLine(w["message"]?.ToString(), 400), ["fix"] = w["fix"]?.ToString(),
            };
            if (w["elements"] is JsonArray elements) warning["elements"] = elements.DeepClone();
            if (w["op"] is JsonValue op) warning["op"] = op.DeepClone();
            if (w["suggestion"] is JsonObject suggestion) warning["suggestion"] = suggestion.DeepClone();
            if (w["why"] is JsonValue why) warning["why"] = why.DeepClone();
            result.Add(warning);
        }
        return result;
    }

    /// <summary>The fix sentence of a refusal (and of a legacy warning).</summary>
    public static string Fix(bool sql, string loop, string? list) =>
        (sql ? "move the SQL before the loop as ONE query with IN/JOIN on the key of the iterated list (e.g. WHERE {Child}.[ParentId] IN (@Ids) with Expand Inline, or JOIN the parent table)"
             : "move the aggregate before the loop, joined with the related entity (sources + joins) and filtered by the key of the iterated list")
        + $", then inside '{loop}' look the row up by key with a List action (ListFilter/ListIndexOf{(list == null ? "" : " over the joined list instead of " + list)})"
        + $"; only when the query truly must run per item, add \"{AllowKey}\": {{\"why\": \"...\"}} (at least {MinimumWhy} characters) to the op that creates it";
}

public sealed partial class ModelSession
{
    // The top-level op of the job (Apply's index) that created each object, by key: the pointer of a data-access finding.
    private readonly Dictionary<string, int> _dataAccessOrigin = new(StringComparer.Ordinal);

    /// <summary>Called by ApplyOne after each op: a create (also inside logic/html/spec/screen expansions) remembers its op.</summary>
    private void RecordDataAccessOrigin(string kind, JsonNode? result)
    {
        if (_applyOps == null || kind != "create") return;
        if (result?["key"] is JsonValue key && key.TryGetValue<string>(out var k) && k.Length > 0) _dataAccessOrigin.TryAdd(k, _applyIndex);
    }

    // The objects of the job for the two reviews of one Apply: QueryInLoopReview reads them, AggregateConsolidationReview
    // reuses and clears them (each walk of the scopes costs the subtrees the job named).
    private (HashSet<IObjectSignature> Created, HashSet<IObjectSignature> Changed)? _dataAccessObjects;

    /// <summary>What this job created and what it changed (the footprint's objects, B3), without a sweep of the module.</summary>
    private (HashSet<IObjectSignature> Created, HashSet<IObjectSignature> Changed) JobObjects()
    {
        if (_dataAccessObjects is { } known) return known;
        var created = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        foreach (var (root, scope) in _scopes) foreach (var o in NewIn(root, scope)) created.Add(o);
        var changed = new HashSet<IObjectSignature>(_touched.OfType<IObjectSignature>().Where(o => !o.WasDeleted && !created.Contains(o)), ReferenceEqualityComparer.Instance);
        _dataAccessObjects = (created, changed);
        return (created, changed);
    }

    private static string NodeName(object o)
        => TypeResolver.Name(o) is { Length: > 0 } name ? name : ModelHost.Prop(o, "Label") as string is { Length: > 0 } label ? label : ShortType(o);

    private static string ExpressionText(object? value) => value switch
    {
        null => "",
        IExpression e => e.Text ?? "",
        _ => value.ToString() ?? "",
    };

    private static bool IsQueryNode(IFlowNode node) => node is ISQLNode || node is IAggregateNode || Implements(node, "IAggregate");

    /// <summary>The flow owner (action, screen action, data action, preparation) of a job object: the parent of the flow node
    /// that is or holds it.</summary>
    private static IObjectSignature? FlowOwner(IObjectSignature o)
    {
        for (IObjectSignature? p = o; p != null; p = p.Parent as IObjectSignature)
            if (p is IFlowNode) return p.Parent as IObjectSignature;
        return null;
    }

    private static List<IFlowNode> FlowNodes(IObjectSignature owner)
        => owner.GetAllDescendantsOfType<IObjectSignature>().OfType<IFlowNode>().Where(n => ReferenceEquals(((IObjectSignature)n).Parent, owner)).ToList();

    /// <summary>The loops of a flow: its strongly connected components with a cycle (Tarjan, iterative over FlowLayout.Successors).</summary>
    internal static List<List<IFlowNode>> Loops(IReadOnlyList<IFlowNode> nodes)
    {
        var members = new HashSet<IFlowNode>(nodes, ReferenceEqualityComparer.Instance);
        var successors = new Dictionary<IFlowNode, List<IFlowNode>>(ReferenceEqualityComparer.Instance);
        foreach (var n in nodes) successors[n] = FlowLayout.Successors(n).Select(s => s.Node).Where(members.Contains).Distinct().ToList();
        var index = new Dictionary<IFlowNode, int>(ReferenceEqualityComparer.Instance);
        var low = new Dictionary<IFlowNode, int>(ReferenceEqualityComparer.Instance);
        var onStack = new HashSet<IFlowNode>(ReferenceEqualityComparer.Instance);
        var stack = new Stack<IFlowNode>();
        var loops = new List<List<IFlowNode>>();
        var counter = 0;
        foreach (var root in nodes)
        {
            if (index.ContainsKey(root)) continue;
            var work = new Stack<(IFlowNode Node, int Next)>();
            work.Push((root, 0)); index[root] = low[root] = counter++; stack.Push(root); onStack.Add(root);
            while (work.Count > 0)
            {
                var (node, next) = work.Pop();
                var edges = successors[node];
                if (next < edges.Count)
                {
                    work.Push((node, next + 1));
                    var to = edges[next];
                    if (!index.ContainsKey(to)) { index[to] = low[to] = counter++; stack.Push(to); onStack.Add(to); work.Push((to, 0)); }
                    else if (onStack.Contains(to)) low[node] = Math.Min(low[node], index[to]);
                    continue;
                }
                if (work.Count > 0) { var parent = work.Peek().Node; low[parent] = Math.Min(low[parent], low[node]); }
                if (low[node] != index[node]) continue;
                var component = new List<IFlowNode>();
                IFlowNode popped;
                do { popped = stack.Pop(); onStack.Remove(popped); component.Add(popped); } while (!ReferenceEquals(popped, node));
                if (component.Count > 1 || successors[node].Any(s => ReferenceEquals(s, node))) loops.Add(component);
            }
        }
        return loops;
    }

    /// <summary>The op of the job behind an object: the op that created it or an ancestor, else the first op that names it
    /// (or its flow owner), else null.</summary>
    private int? OriginOp(IObjectSignature o, JsonArray ops)
    {
        for (IObjectSignature? p = o; p != null; p = p.Parent as IObjectSignature)
            if (p.ObjectKey?.ToString() is { } key && _dataAccessOrigin.TryGetValue(key, out var op)) return op;
        foreach (var name in new[] { NodeName(o), FlowOwner(o) is { } owner ? NodeName(owner) : null }.OfType<string>())
        {
            var word = new Regex(@"(?<![\p{L}\p{N}_])" + Regex.Escape(name) + @"(?![\p{L}\p{N}_])");
            for (var i = 0; i < ops.Count; i++)
                if (ops[i] is JsonObject candidate && candidate["op"]?.ToString() is not ("get" or "find" or "dump" or "usages") && word.IsMatch(candidate.ToJsonString())) return i;
        }
        return null;
    }

    /// <summary>The pointer of a logic step relative to op.data (`/actions/a/steps/...`), when the op is a logic op that
    /// declares the flow owner and the node by name; null otherwise.</summary>
    private static string? StepPointer(JsonObject? op, string owner, string node)
    {
        // The text form (ssam-flow/1): the text of the action whose header names the owner.
        if (op?["op"]?.ToString() == "logic" && op["data"] is JsonObject textForm && textForm.ContainsKey("flow"))
        {
            try
            {
                foreach (var (text, _, pointer) in FlowTextForm.Texts(textForm))
                    if (FlowTextForm.ActionNames([(text, null, pointer)]).Contains(owner)) return pointer;
            }
            catch (KernelRefusalException) { }
            return null;
        }
        if (op?["op"]?.ToString() != "logic" || op["data"]?["actions"] is not JsonArray actions) return null;
        for (var a = 0; a < actions.Count; a++)
            if (actions[a] is JsonObject action && string.Equals(action["name"]?.ToString(), owner, StringComparison.OrdinalIgnoreCase)
                && Preflight.LogicScan.Of(action).Nodes.TryGetValue(node, out var fact))
                return $"/actions/{a}{fact.Pointer}";
        return null;
    }

    /// <summary>QUERY_IN_LOOP over the flows this job touched: the failures (refusals) are added to Apply's list, the legacy
    /// loops and the accepted escapes go to the receipt (highWarnings). Never throws: a flow it cannot read is skipped.</summary>
    private void QueryInLoopReview(JsonArray ops, List<ApplyFailure> failures)
    {
        if (!_footprintBegun) return;
        _dataAccessObjects = null;
        HashSet<IObjectSignature> created, changed;
        try { (created, changed) = JobObjects(); } catch { return; }
        var owners = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        foreach (var o in created.Concat(changed))
            if (!o.WasDeleted && FlowOwner(o) is { WasDeleted: false } owner) owners.Add(owner);
        bool InJob(IObjectSignature o) => created.Contains(o) || changed.Contains(o)
            || o.GetAllDescendantsOfType<IObjectSignature>().Any(d => created.Contains(d) || changed.Contains(d));
        foreach (var owner in owners)
        {
            List<IFlowNode> nodes;
            List<List<IFlowNode>> loops;
            try { nodes = FlowNodes(owner); loops = Loops(nodes); } catch { continue; }
            if (loops.Count == 0) continue;
            var order = FlowLayout.CanonicalOrderSafe(nodes);
            var flowName = NodeName(owner);
            foreach (var loop in loops)
            {
                var header = loop.OfType<IForEachNode>().Cast<IFlowNode>().FirstOrDefault()
                    ?? loop.OrderBy(n => order.TryGetValue(n, out var at) ? at : int.MaxValue).First();
                var loopName = NodeName(header);
                var list = header is IForEachNode each ? ExpressionText(ModelHost.Prop(each, "RecordList")).Trim() : null;
                var builtLoop = loop.Where(n => n is IForEachNode or IIfNode && created.Contains((IObjectSignature)n)).Cast<IObjectSignature>().ToList();
                foreach (var query in loop.Where(IsQueryNode).Cast<IObjectSignature>())
                {
                    var sql = query is ISQLNode;
                    var queryName = NodeName(query);
                    var kindText = sql ? "Execute SQL" : "Aggregate";
                    var suggestion = sql ? null : LoopSuggestion(nodes, list, query);
                    var fix = QueryInLoopRule.Fix(sql, loopName, list);
                    var refused = InJob(query) || builtLoop.Count > 0;
                    var originOp = OriginOp(query, ops) ?? builtLoop.Select(b => OriginOp(b, ops)).FirstOrDefault(o => o != null);
                    var originJson = originOp is { } oi && oi < ops.Count ? ops[oi] as JsonObject : null;
                    var message = $"{kindText} '{queryName}' runs inside the loop '{loopName}'{(list is { Length: > 0 } ? " over " + list : "")} of '{flowName}': one query per iteration (N+1 round trips to the database)";
                    JsonObject Finding(string code, string severity, string text) => new()
                    {
                        ["code"] = code, ["severity"] = severity, ["op"] = originOp, ["message"] = text, ["fix"] = fix,
                        ["flow"] = flowName, ["loop"] = loopName, ["query"] = queryName, ["queryKind"] = sql ? "sql" : "aggregate",
                        ["suggestion"] = suggestion?.DeepClone(),
                    };
                    if (!refused)
                    {
                        var legacy = Finding(QueryInLoopRule.Code, "high", message + "; this loop and query were already in the module (not refused: the job did not create or change them)");
                        legacy["legacy"] = true;
                        Report("highWarnings", legacy);
                        continue;
                    }
                    // The escape: on the op that created the query, or the op that built the loop around it.
                    var candidates = new[] { originOp }.Concat(builtLoop.Select(b => OriginOp(b, ops))).OfType<int>().Distinct().ToList();
                    string? why = null, invalid = null;
                    foreach (var c in candidates)
                    {
                        why = QueryInLoopRule.Allowed(c < ops.Count ? ops[c] as JsonObject : null, out var bad);
                        invalid ??= bad;
                        if (why != null) { originOp = c; break; }
                    }
                    if (why != null)
                    {
                        var allowed = Finding(QueryInLoopRule.AllowedCode, "high", message + $"; accepted by {QueryInLoopRule.AllowKey} on op #{originOp}: {why}");
                        allowed["why"] = why;
                        Report("highWarnings", allowed);
                        continue;
                    }
                    var problem = Finding(QueryInLoopRule.Code, "error", message + (invalid != null ? "; " + invalid : ""));
                    problem["pointer"] = StepPointer(originJson, flowName, queryName);
                    var op = originOp ?? Math.Max(0, ops.Select((x, n) => (x, n)).FirstOrDefault(p => p.x?["op"]?.ToString() is not ("get" or "find" or "dump" or "usages")).n);
                    problem["op"] = op;
                    var kind = (op < ops.Count ? ops[op]?["op"]?.ToString() : null) ?? "op";
                    failures.Add(new ApplyFailure(op, kind, op < ops.Count && ops[op] is JsonObject source ? source : new JsonObject(),
                        new KernelRefusalException(QueryInLoopRule.Code, $"op #{op} ({kind} {queryName}): [{QueryInLoopRule.Code}] {message}. Fix: {fix}", new JsonArray(problem))));
                }
            }
        }
    }

    /// <summary>The ready ops when the loop is a ForEach over `X.List`, X an aggregate of the same flow, and the query inside is
    /// an aggregate whose entity has a reference (FK) to or from X's entity: one aggregate before the loop with the join, and
    /// the lookup by key inside it. Null when that is not derivable.</summary>
    private static JsonObject? LoopSuggestion(List<IFlowNode> nodes, string? list, IObjectSignature query)
    {
        if (list == null || Regex.Match(list, @"^\s*([A-Za-z_]\w*)\.List\s*$") is not { Success: true } m) return null;
        var outer = nodes.Cast<IObjectSignature>().FirstOrDefault(n => IsQueryNode((IFlowNode)n) && n is not ISQLNode && string.Equals(NodeName(n), m.Groups[1].Value, StringComparison.OrdinalIgnoreCase));
        if (outer == null) return null;
        var parent = AggregateShape.Of(outer); var child = AggregateShape.Of(query);
        if (parent.Entities.Count == 0 || child.Entities.Count == 0) return null;
        var relation = AggregateShape.Relation(parent.Entities[0], child.Entities[0]);
        if (relation == null) return null;
        var p = parent.Entities[0].Name; var c = child.Entities[0].Name;
        var joined = $"{NodeName(outer)}With{c}";
        var key = relation.Owner == c ? $"{c}.{relation.Attribute}" : $"{c}.Id";
        var parentKey = relation.Owner == c ? $"{NodeName(outer)}.List.Current.{p}.Id" : $"{NodeName(outer)}.List.Current.{p}.{relation.Attribute}";
        return new JsonObject
        {
            ["relation"] = relation.Text,
            ["before"] = new JsonObject
            {
                ["get"] = p, ["as"] = joined, ["sources"] = new JsonArray(c),
                ["joins"] = new JsonArray(new JsonObject { ["left"] = p, ["right"] = c, ["kind"] = "With or Without", ["condition"] = relation.Condition }),
                ["where"] = new JsonArray(parent.Filters.Select(f => (JsonNode)f).ToArray()),
            },
            ["inside"] = $"ListFilter({joined}.List, {key} = {parentKey})",
            ["note"] = $"iterate {joined}.List (or keep {list} and look up with the ListFilter above); delete '{NodeName(query)}' from the loop",
        };
    }
}

public static partial class FlowLayout
{
    /// <summary>The canonical position of each node (CanonicalOrder), or the list order when the flow has no Start.</summary>
    internal static Dictionary<IFlowNode, int> CanonicalOrderSafe(List<IFlowNode> nodes)
    {
        List<IFlowNode> order;
        try { order = CanonicalOrder(nodes); } catch { order = nodes; }
        var result = new Dictionary<IFlowNode, int>(ReferenceEqualityComparer.Instance);
        for (var i = 0; i < order.Count; i++) result.TryAdd(order[i], i);
        return result;
    }
}
