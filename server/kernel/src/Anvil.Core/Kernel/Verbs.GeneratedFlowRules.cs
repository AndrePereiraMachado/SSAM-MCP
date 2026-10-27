using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

/// <summary>
/// The flow rules a generator's output must satisfy, judged over every flow of a module as if each node were new (what a
/// generator writes is new by definition): T1/T2 (FLOW_FOREACH_LIST_ACTION, a For Each that only filters, copies or maps into
/// a list), decision 6 (FLOW_JAVASCRIPT_NOT_ISOLATED) and QUERY_IN_LOOP (an aggregate or SQL inside a loop). The same rules the
/// Apply runs on what a job writes (FlowDiff.NewElementRules, QueryInLoopRule's loops), with no op, no escape and no claim: a
/// generator's test runs its corpus and asks for none (GeneratedFlowRulesTests). Read only; never throws for one flow: a flow
/// that cannot be read, or that the rules cannot judge, is a finding (FLOW_OWNER_RULES_UNREAD) that names the flow and the
/// kind of failure, never the exception's text.
/// </summary>
public sealed partial class ModelSession
{
    /// <summary>The findings of the flow rules over every flow of the module: each with the flow, the rule's code and its
    /// message; a QUERY_IN_LOOP finding also names the query node (node) and the decisions and loops of its loop (loop: the
    /// labels of its If and For Each nodes).</summary>
    public JsonArray GeneratedFlowRuleFindings()
    {
        var findings = new JsonArray();
        var reader = new KernelModelReader();
        HashSet<string>? scope = null;
        bool Taken(string name) => (scope ??= ScopeNames()).Contains(name);
        var owners = Descendants().OfType<IFlowNode>().Select(n => ((IObjectSignature)n).Parent as IObjectSignature).OfType<IObjectSignature>()
            .Where(o => !o.WasDeleted).Distinct(ReferenceEqualityComparer.Instance).Cast<IObjectSignature>().ToList();
        foreach (var owner in owners)
        {
            var name = reader.NameOf(owner);
            JsonObject Add(string code, string message)
            {
                var finding = new JsonObject { ["flow"] = name, ["code"] = code, ["message"] = message };
                findings.Add(finding); return finding;
            }
            void Unread(string what, Exception error) =>
                Add(OwnerRulesUnreadCode, "the flow " + name + " " + what + " (" + error.GetType().Name + "), so the flow rules do not judge it");
            List<IFlowNode> nodes; List<List<IFlowNode>> loops;
            try { nodes = FlowNodes(owner); loops = Loops(nodes); }
            catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException or NullReferenceException or NotSupportedException)
            { Unread("cannot be walked", error); continue; }
            if (nodes.Any(n => n is IForEachNode or IJavaScriptNode))
            {
                if (FlowItemOf(owner, out _) is not { } item)
                    Add(OwnerRulesUnreadCode, "the flow " + name + " cannot be read by the flow reader, so the flow rules do not judge it");
                else
                {
                    try { foreach (var problem in FlowDiff.NewElementRules(item, _ => true, new ModelFlowTypes(this, owner), Taken)) Add(problem.Code, problem.Message); }
                    catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException or NullReferenceException or NotSupportedException)
                    { Unread("cannot be judged by the owner's rules", error); }
                }
            }
            foreach (var loop in loops)
                foreach (var query in loop.Where(IsQueryNode))
                {
                    var finding = Add(QueryInLoopRule.Code, (query is ISQLNode ? "Execute SQL '" : "Aggregate '") + NodeName(query) + "' runs inside the loop of '"
                        + NodeName(loop.OfType<IForEachNode>().Cast<object>().FirstOrDefault() ?? loop[0]) + "'");
                    finding["node"] = NodeName(query);
                    finding["loop"] = new JsonArray(loop.Where(n => n is IIfNode or IForEachNode)
                        .Select(n => (JsonNode)JsonValue.Create(ModelHost.Prop(n, "Label") as string is { Length: > 0 } label ? label : NodeName(n))).ToArray());
                }
        }
        return findings;
    }
}
