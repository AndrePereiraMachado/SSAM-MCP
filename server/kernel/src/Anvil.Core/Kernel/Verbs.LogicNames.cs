using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    // A call of a JSON logic action the platform numbered (its declaration says Loaded, the node is Loaded2). Run after
    // structure, before expressions. Two causes, two answers, the same on the JSON form as on the text form (F5):
    // - an element of the node's scope holds the declared name (a variable, input, aggregate or widget of its screen or
    //   block, an element of the module: ScopeHolder): the declaration's name says two things, refused naming both
    //   (FLOW_NODE_NAME_TAKEN), never rewritten;
    // - a Traditional screen or block shares one naming scope between the nodes of all its flows (Preparation and screen
    //   actions): a node of another flow of the same owner holds the name, or a call of this action numbered by the same
    //   rule does (Loaded -> Loaded2 makes the next Loaded2 -> Loaded3). The expressions of this action that read the
    //   declared name read the actual call, never a similarly named node of another flow.
    // Any other numbering is left as the platform made it (no rewrite).
    private void RebindNativeCallNames(JsonObject data, LogicExpander.ConstructionPlan plan)
    {
        var numbered = new List<NumberedCall>();
        foreach (var create in plan.Operations.Where(o => o["op"]?.ToString() == "create"
                     && o["type"]?.ToString() is "IExecuteServerActionNode" or "IExecuteClientActionNode")) {
            if (create["as"]?.ToString() is not { } alias || !_handles.TryGetValue(alias, out var handle) || handle is not IObjectSignature node
                || create["name"]?.ToString() is not { } asked || TypeResolver.Name(node) is not { Length: > 0 } actual
                || string.Equals(asked, actual, StringComparison.OrdinalIgnoreCase)
                || node.Parent is not IObjectSignature flow
                || ActionOfGenerated(create, plan.Operations, data) is not { } index
                || data["actions"]?[index] is not JsonObject action) continue;
            var scan = Preflight.LogicScan.Of(action);
            if (!scan.Nodes.TryGetValue(asked, out var declared) || declared.Kind != "call") continue;
            numbered.Add(new(create, index, asked, actual, flow, declared, ScopeHolder(flow, asked)));
        }
        if (numbered.Count == 0) return;
        var reader = new KernelModelReader();
        var taken = numbered.Where(n => n.Holder != null).ToList();
        if (taken.Count > 0) {
            var problems = new JsonArray();
            foreach (var call in taken) {
                var problem = JobPreflight.Problem(null, $"/actions/{call.Index}{call.Declared.Pointer}/as", "FLOW_NODE_NAME_TAKEN", "error",
                    $"the node {call.Asked} of {reader.NameOf(call.Flow)}: {call.Holder} has the name {call.Asked} in its scope, so the platform names the node {call.Actual}, and the declaration's {call.Asked} says both",
                    $"give the node a name nothing in its scope has (for example \"as\": \"{call.Actual}\") and write that name where the action means the node's value; keep {call.Asked} where it means {call.Holder} (nothing was kept)");
                problem["node"] = call.Asked; problem["given"] = call.Actual; problem["holder"] = call.Holder;
                problems.Add(JobPreflight.PublicProblem(problem));
            }
            throw new KernelRefusalException("FLOW_NODE_NAME_TAKEN", "logic: " + string.Join(" | ", problems.Select(p => p!["message"]?.ToString())), problems);
        }
        // The Traditional rule, to its fixed point (a call numbered because a call of its action was numbered before it).
        var rebound = new List<NumberedCall>();
        for (var grew = true; grew; ) {
            grew = false;
            foreach (var call in numbered.Where(c => !rebound.Contains(c)).ToList())
                if (call.Flow.Parent is IObjectSignature owner && reader.KindOf(owner) is "WebScreen" or "WebBlock"
                    && (OtherFlowNodeNamed(call.Flow, call.Asked) || rebound.Any(r => r.Index == call.Index && string.Equals(r.Actual, call.Asked, StringComparison.OrdinalIgnoreCase)))) {
                    rebound.Add(call); grew = true;
                }
        }
        foreach (var call in rebound) call.Create["name"] = call.Actual;
        foreach (var group in rebound.GroupBy(c => c.Index)) {
            var index = group.Key;
            var names = group.ToList();
            var action = data["actions"]![index]!.AsObject();
            // Simultaneous rewrite: Loaded -> Loaded2 must not then become Loaded3 when another call originally named Loaded2
            // was itself numbered. A field name and a call of a function of that name are never the node (RenamedNode).
            string Rewrite(string text) {
                for (var n = 0; n < names.Count; n++) text = FlowEdits.RenamedNode(text, names[n].Asked, "\u0002" + n + "\u0002", outsideFields: true);
                for (var n = 0; n < names.Count; n++) text = text.Replace("\u0002" + n + "\u0002", names[n].Actual, StringComparison.Ordinal);
                return text;
            }
            void ReportChange(string pointer, string before, string after) => Normalized([
                Preflight.JobNormalizer.Entry("LOGIC_NATIVE_CALL_RENAMED", $"{OpsPointer ?? "/ops"}/{_applyIndex}/data/actions/{index}{pointer}",
                    before, after, "the native call name is numbered in its Traditional screen scope (a node of another flow of the screen has it); only this action's output references follow it")]);
            foreach (var site in Preflight.LogicScan.Of(action).Expressions) {
                var rewritten = Rewrite(site.Text);
                if (rewritten != site.Text && Preflight.ExpressionRewrites.Write(action, site.Pointer, site.Text, rewritten))
                    ReportChange(site.Pointer, site.Text, rewritten);
            }
            foreach (var call in names) {
                call.Declared.Step["as"] = call.Actual;
                ReportChange(call.Declared.Pointer + "/as", call.Asked, call.Actual);
            }
            foreach (var ordinal in plan.BodyExpressionOrdinals) {
                var expression = plan.Operations[ordinal];
                if (ActionOfGenerated(expression, plan.Operations, data) == index && expression["value"] is JsonValue value
                    && value.TryGetValue<string>(out var text)) expression["value"] = Rewrite(text);
            }
        }
    }

    private sealed record NumberedCall(JsonObject Create, int Index, string Asked, string Actual, IObjectSignature Flow, Preflight.NodeFact Declared, string? Holder);

    // A node of another flow (Preparation, screen action) of the owner of this flow has the name.
    private static bool OtherFlowNodeNamed(IObjectSignature flow, string name)
    {
        if (flow.Parent is not IObjectSignature owner) return false;
        foreach (var other in owner.Children.OfType<IObjectSignature>())
            if (!ReferenceEquals(other, flow) && !other.WasDeleted)
                foreach (var node in other.Children.OfType<IObjectSignature>())
                    if (node is IFlowNode && !node.WasDeleted && string.Equals(TypeResolver.Name(node), name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
}
