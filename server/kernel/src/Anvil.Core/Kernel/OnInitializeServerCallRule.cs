using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

/// <summary>
/// ONINITIALIZE_SERVER_CALL (F11, owner's decision of 2026-10-26): a server or service action called from the OnInitialize of
/// a Reactive or Mobile screen or block (O11 and ODC alike) is REFUSED. OnInitialize runs before the first render: a round
/// trip to the server there delays the whole screen and the navigation to it; the platform's own pattern renders first and
/// fetches after (a Data Action with Fetch At start, or an aggregate, of the screen). Decided on the candidate model after the ops, in
/// ModelSession.Apply, with the other failures of the transaction (as QUERY_IN_LOOP is, QueryInLoopRule.cs): every form is
/// judged alike (the html document's oninitialize=, the flow text's `on Initialize -&gt;`, a raw set of the handler's
/// Destination, a prototype, a screen op), and the call is seen through the client actions the handler calls (the module's
/// own, to depth 6; a producer's client action is opaque).
///
///  * Refusal (error, phase apply): the job created the screen or block, created or changed its OnInitialize binding, or
///    created or changed the call node (a new handler, a new client action in the chain). The answer names the screen, the
///    handler, the chain and the server actions, the op and pointer that bind the handler, and the fix in words: the data comes
///    from a Data Action (Fetch: At start) or an aggregate of the screen. Never a patch that moves the call to another
///    lifecycle event: the owner's rule S1 (outsystems_padroes RULES.md) forbids a server call in every one of them (OnReady,
///    OnRender, OnParametersChanged, OnAfterFetch too), and the Studio's own warning (ClientActionWithServerRequestsOn
///    LifecycleEvent) points at Data Actions and aggregates. There is no certain mechanical rewrite to a Data Action today.
///  * Legacy: a call that was already there, in a screen the job touched without creating or changing the binding or the
///    call, is a HIGH warning (highWarnings, legacy: true), never a refusal: a job is not blocked by what it did not write.
///  * No escape: there is no `allow...` for this rule; the call never passes as written.
/// Traditional (Web) screens have a Preparation, not an OnInitialize: nothing is judged there.
/// Tests: OnInitializeRuleScenarios (linked into both lanes), OnInitializeRuleTests (O11), OnInitializeRuleOdcTests (ODC).
/// </summary>
public static class OnInitializeServerCallRule
{
    public const string Code = "ONINITIALIZE_SERVER_CALL";

    /// <summary>The fix sentence of a refusal (and of a legacy warning). Review of r4-w2-flow, correction 2: never OnReady (S1).</summary>
    public static string Fix(string owner, string handler, string callees, string? where) =>
        $"move the call of {callees} out of the lifecycle events of {owner}: fetch the data with a Data Action of {owner} (Fetch: At start) "
        + "that calls it, or with an aggregate, and read its output where the screen uses it; "
        + $"OnInitialize ({handler}{(where != null ? ", bound by " + where : "")}) keeps only assignments and client-side logic, "
        + "and no other lifecycle event of the screen calls a server or service action either";
}

public sealed partial class ModelSession
{
    private static bool IsScreenOrBlock(IObjectSignature o) => Implements(o, "IMobileScreen") || Implements(o, "IMobileBlock");
    private static bool IsServerCallNode(IObjectSignature o) => Implements(o, "IExecuteServerActionNode") || Implements(o, "IExecuteServiceActionNode");
    private static bool IsClientCallNode(IObjectSignature o) => Implements(o, "IExecuteClientActionNode");

    /// <summary>A server call an OnInitialize handler reaches: the node, the callee's name and the chain of actions from the
    /// handler to the action that holds the node (the handler alone when the call is its own).</summary>
    private sealed record ServerCall(IObjectSignature Node, string Callee, IReadOnlyList<IObjectSignature> Chain);

    /// <summary>The server calls <paramref name="handler"/> reaches: its own nodes and, through the client-action calls, the
    /// module's client actions and screen actions it calls (each action once, depth 6).</summary>
    private static List<ServerCall> ServerCallsOf(IObjectSignature handler)
    {
        var found = new List<ServerCall>();
        var visited = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        void Walk(IObjectSignature action, List<IObjectSignature> chain)
        {
            if (chain.Count > 6 || !visited.Add(action)) return;
            List<IFlowNode> nodes;
            try { nodes = FlowNodes(action); } catch { return; }
            foreach (var node in nodes.Cast<IObjectSignature>())
            {
                if (node.WasDeleted) continue;
                IObjectSignature? callee;
                try { callee = ModelHost.Prop(node, "Action") as IObjectSignature; } catch { callee = null; }
                if (IsServerCallNode(node)) found.Add(new ServerCall(node, callee != null ? NodeName(callee) : NodeName(node), chain));
                else if (IsClientCallNode(node) && callee is { WasDeleted: false }
                    && (Implements(callee, "IClientAction") || Implements(callee, LogicOrder.MobileScreenAction)))
                    Walk(callee, [.. chain, callee]);
            }
        }
        Walk(handler, [handler]);
        return found;
    }

    /// <summary>ONINITIALIZE_SERVER_CALL over the screens and blocks this job touched: the refusals are added to Apply's list, the
    /// legacy calls go to the receipt (highWarnings). Never throws: a screen it cannot read is skipped.</summary>
    private void OnInitializeReview(JsonArray ops, List<ApplyFailure> failures)
    {
        if (!_footprintBegun) return;
        HashSet<IObjectSignature> created, changed;
        try { (created, changed) = JobObjects(); } catch { return; }
        bool InJob(IObjectSignature o) => created.Contains(o) || changed.Contains(o)
            || o.GetAllDescendantsOfType<IObjectSignature>().Any(d => created.Contains(d) || changed.Contains(d));
        var owners = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        var clientActionTouched = false;
        foreach (var o in created.Concat(changed))
        {
            if (o.WasDeleted) continue;
            for (IObjectSignature? p = o; p != null; p = p.Parent as IObjectSignature)
            {
                if (!IsScreenOrBlock(p)) continue;
                if (!p.WasDeleted) owners.Add(p);
                break;
            }
            IObjectSignature? flowOwner;
            try { flowOwner = FlowOwner(o) ?? o; } catch { continue; }
            if (Implements(flowOwner, "IClientAction")) clientActionTouched = true;
        }
        // A module-level client action the job touched may be what an untouched OnInitialize calls: every screen is read then.
        if (clientActionTouched)
            try { foreach (var s in ((IObjectSignature)_espace).GetAllDescendantsOfType<IObjectSignature>()) if (IsScreenOrBlock(s) && !s.WasDeleted) owners.Add(s); }
            catch { }
        foreach (var owner in owners)
        {
            IObjectSignature? binding, handler;
            try
            {
                binding = ModelHost.Prop(owner, "OnInitialize") as IObjectSignature;
                handler = binding == null ? null : ModelHost.Prop(binding, "Destination") as IObjectSignature;
            }
            catch { continue; }
            if (binding == null || handler == null || handler.WasDeleted) continue;
            List<ServerCall> calls;
            try { calls = ServerCallsOf(handler); } catch { continue; }
            if (calls.Count == 0) continue;
            var ownerName = NodeName(owner); var handlerName = NodeName(handler);
            var ownerKind = Implements(owner, "IMobileBlock") ? "block" : "screen";
            var refused = created.Contains(owner) || InJob(binding) || calls.Any(c => InJob(c.Node) || c.Chain.Any(created.Contains));
            var callees = calls.Select(c => c.Callee).Distinct(StringComparer.Ordinal).ToList();
            var calleeText = string.Join(", ", callees.Select(c => $"'{c}'"));
            var chains = calls.Where(c => c.Chain.Count > 1).Select(c => string.Join(" -> ", c.Chain.Skip(1).Select(a => $"'{NodeName(a)}'"))).Distinct(StringComparer.Ordinal).ToList();
            var via = chains.Count > 0 ? $" through the client action{(chains.Count > 1 ? "s" : "")} {string.Join("; ", chains)}" : "";
            var plural = callees.Count > 1 ? "s" : "";
            var message = $"OnInitialize of {ownerKind} '{ownerName}' ('{handlerName}') calls the server action{plural} {calleeText}{via}: OnInitialize runs before the first render, "
                + $"so a round trip to the server there delays the whole {ownerKind} and the navigation to it (Reactive and Mobile render first and fetch after)";
            var (originOp, pointer, where) = OnInitializeOrigin(ops, ownerName, handlerName);
            var fix = OnInitializeServerCallRule.Fix(ownerName, handlerName, calleeText, where);
            JsonObject Finding(string severity, string text) => new()
            {
                ["code"] = OnInitializeServerCallRule.Code, ["severity"] = severity, ["op"] = originOp, ["message"] = text, ["fix"] = fix,
                ["flow"] = ownerName, ["loop"] = "OnInitialize", ["query"] = string.Join(", ", callees),
                ["screen"] = ownerName, ["handler"] = handlerName, ["callees"] = new JsonArray(callees.Select(c => (JsonNode)c).ToArray()),
            };
            if (!refused)
            {
                var legacy = Finding("high", message + "; this call was already in the module (not refused: the job did not create or change the binding or the call)");
                legacy["legacy"] = true;
                Report("highWarnings", legacy);
                continue;
            }
            var problem = Finding("error", message);
            problem["pointer"] = pointer;
            var op = originOp ?? Math.Max(0, ops.Select((x, n) => (x, n)).FirstOrDefault(p => p.x?["op"]?.ToString() is not ("get" or "find" or "dump" or "usages")).n);
            problem["op"] = op;
            var kind = (op < ops.Count ? ops[op]?["op"]?.ToString() : null) ?? "op";
            failures.Add(new ApplyFailure(op, kind, op < ops.Count && ops[op] is JsonObject source ? source : new JsonObject(),
                new KernelRefusalException(OnInitializeServerCallRule.Code, $"op #{op} ({kind} {ownerName}): [{OnInitializeServerCallRule.Code}] {message}. Fix: {fix}", new JsonArray(problem))));
        }
    }

    private static bool SameName(string? a, string b)
    {
        if (a == null) return false;
        var bare = a.Trim();
        var paren = bare.IndexOf('(');
        if (paren >= 0) bare = bare[..paren].Trim();
        return string.Equals(bare, b, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The op of the job that binds <paramref name="handler"/> to the OnInitialize of <paramref name="owner"/>, its
    /// pointer (relative to op.data) and how the binding is written there; (null, null, null) when no op of the job names it.</summary>
    private static (int? Op, string? Pointer, string? Where) OnInitializeOrigin(JsonArray ops, string owner, string handler)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            if (kind == "html" && op["parent"] == null)
            {
                Preflight.ScreenDocFacts? doc;
                try { doc = Preflight.ScreenDocFacts.Of(op, i); } catch { doc = null; }
                if (doc == null || !string.Equals(doc.Name, owner, StringComparison.OrdinalIgnoreCase) || doc.Root.Find("oninitialize") is not { } bound || !SameName(bound.Value, handler)) continue;
                return (i, "/html", $"oninitialize=\"{handler}\" on <{doc.Kind}>");
            }
            if (kind == "logic" && op["data"] is JsonObject data && data.ContainsKey("flow"))
            {
                List<(string Text, string? BasedOn, string Pointer)> texts;
                try { texts = FlowTextForm.Texts(data); } catch (KernelRefusalException) { continue; }
                foreach (var (text, _, pointer) in texts)
                {
                    var line = Regex.Match(text, @"(?m)^[ \t]*on[ \t]+Initialize[ \t]*->[ \t]*([A-Za-z_][A-Za-z0-9_]*)");
                    if (!line.Success || !SameName(line.Groups[1].Value, handler)) continue;
                    var header = Regex.Match(text, @"(?m)^[ \t]*(?:screen[ \t]+)?action[ \t]+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)");
                    if (!header.Success || !string.Equals(header.Groups[1].Value, owner, StringComparison.OrdinalIgnoreCase)) continue;
                    return (i, pointer, $"`on Initialize -> {handler}()` in the text of {owner}.{handler}");
                }
            }
            if (kind == "set" && op["target"]?.ToString() is { } target && target.EndsWith("/OnInitialize", StringComparison.Ordinal)
                && string.Equals(op["prop"]?.ToString(), "Destination", StringComparison.OrdinalIgnoreCase) && SameName(op["value"]?.ToString()?.Split('/').Last().Split(':').Last(), handler))
                return (i, "", $"the set of {target}");
        }
        return (null, null, null);
    }
}
