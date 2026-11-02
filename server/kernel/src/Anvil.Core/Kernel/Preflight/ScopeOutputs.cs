using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// F7 (25/10/2026, the owner's SSAMCoverageSoapWire delivery: 15 ExpressionUnknownObject 'Pedido' and 'Cliente' in 7 actions,
/// all from the Verify): the outputs of a call a ssam-flow/1 text reads. `Lock = GetPedidoForUpdate(Id=PedidoId)` then
/// `Lock.Pedido.StatusPedidoId`: the entity action's only output is Record (`Lock.Record.Pedido.StatusPedidoId`), so the
/// Verify can't identify 'Pedido'. The scope phase says it before the build (EXPR_UNKNOWN_IDENTIFIER, predicts
/// ExpressionUnknownObject), with the patch when the output meant is certain. Judged only what is known: the outputs of an
/// action a text of the same job declares (its `out` lines) and, in the O11 lane, of the entity actions of an entity of the
/// job or of the base (Get/GetForUpdate: Record; Create/CreateOrUpdate: Id; Update/Delete: none). Any other callee is the
/// Verify's to judge.
/// </summary>
internal static class ScopeOutputs
{
    public const string Code = "EXPR_UNKNOWN_IDENTIFIER";
    private static readonly Regex EntityAction = new(@"^(CreateOrUpdate|Create|Update|Delete|Get)(\w+?)(ForUpdate)?$", RegexOptions.Compiled);

    private sealed record Text(int Op, string? At, string Source, FlowItem Item);

    public static IEnumerable<JsonObject> Check(JsonArray ops, string? prefix, string lane, ScopeRules.Callables known)
    {
        var texts = new List<Text>();
        var declared = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data) continue;
            var flow = data["flow"] ?? data["text"];
            foreach (var (index, text) in DocumentNameRules.Texts(data))
            {
                FlowItem parsed;
                try { parsed = FlowParser.Parse(text); } catch { continue; }   // a text the grammar refuses is the preflight's
                var at = prefix == null ? null : $"{prefix}/{i}/" + (flow is JsonArray ? $"{(data["flow"] != null ? "data/flow" : "data/text")}/{index}" : data["flow"] != null ? "data/flow" : "data/text");
                texts.Add(new(i, at, text, parsed));
                if (parsed.Role == "action" && parsed.Name.Length > 0 && parsed.Owner.Length == 0)
                    declared[parsed.Name] = parsed.Items.Where(c => c.Role == "out").Select(c => c.Name).ToList();
            }
        }
        foreach (var text in texts)
        {
            var calls = new Dictionary<string, (string Callee, List<string> Outputs, string Why)>(StringComparer.OrdinalIgnoreCase);
            foreach (var node in Nodes(text.Item).Where(n => n.Kind == "Execute" && n.Name.Length > 0 && n.Prop("Action") is { Length: > 0 }))
                if (Outputs(node.Prop("Action")!, declared, known, lane) is { } outputs) calls[node.Name] = (node.Prop("Action")!, outputs.Names, outputs.Why);
            if (calls.Count == 0) continue;
            var found = new Dictionary<(string Root, string Segment), (int Count, string Example, string? Meant)>();
            foreach (var expression in Expressions(text.Item))
                foreach (var token in ExpressionText.Tokens(expression).Where(t => t.Kind == TokenKind.Name && !t.Text.StartsWith('.') && t.Segments.Length >= 2))
                {
                    var (root, segment) = (token.Segments[0], token.Segments[1]);
                    if (!calls.TryGetValue(root, out var call) || call.Outputs.Contains(segment, StringComparer.OrdinalIgnoreCase)) continue;
                    var key = (calls.Keys.First(k => string.Equals(k, root, StringComparison.OrdinalIgnoreCase)), segment);
                    found[key] = found.TryGetValue(key, out var seen) ? seen with { Count = seen.Count + 1 } : (1, token.Text, Meant(call.Callee, call.Outputs, segment));
                }
            if (found.Count == 0) continue;
            // One patch for the text: every certain correction of this rule written in it, the same on each problem.
            var patched = text.Source;
            foreach (var ((root, segment), (_, _, meant)) in found.Where(f => f.Value.Meant != null))
                patched = Regex.Replace(patched, @"(?<![\w.])" + Regex.Escape(root) + @"\." + Regex.Escape(segment) + @"(?![\w])", root + "." + meant, RegexOptions.IgnoreCase);
            var patch = text.At != null && !string.Equals(patched, text.Source, StringComparison.Ordinal)
                ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = text.At, ["value"] = patched }) : null;
            foreach (var ((root, segment), (count, example, meant)) in found)
            {
                var call = calls[root];
                var has = call.Outputs.Count == 0 ? "no outputs" : call.Outputs.Count == 1 ? $"the only output {call.Outputs[0]}" : $"the outputs {string.Join(", ", call.Outputs)}";
                yield return ScopeRules.Problem(text.Op, text.At, Code, "ExpressionUnknownObject",
                    $"can't identify '{segment}' in {example}{(count > 1 ? $" ({count} times in {text.Item.Name})" : "")}: {root} is the call of {call.Callee}, which has {has}{call.Why.Replace("{call}", root)}",
                    meant != null ? $"write {root}.{meant} where the text reads {root}.{segment}" + (patch != null ? " (the patch writes it in the whole text)" : "")
                        : call.Outputs.Count == 0 ? $"read nothing from {root}: {call.Callee} returns nothing" : $"read an output of {call.Callee}: {string.Join(", ", call.Outputs.Select(o => root + "." + o))}",
                    meant != null ? patch?.DeepClone().AsArray() : null, "logic");
            }
        }
    }

    /// <summary>The outputs of a callee this rule knows, with what explains them; null when it is not judged here.</summary>
    private static (List<string> Names, string Why)? Outputs(string callee, Dictionary<string, List<string>> declared, ScopeRules.Callables known, string lane)
    {
        if (callee.Contains('.') || callee.Contains(':') || callee.StartsWith('$') || callee.StartsWith('@')) return null;
        if (declared.TryGetValue(callee, out var outputs)) return (outputs, "");
        // An action of the module named like an entity action is that action, not the generated one: the Verify judges it.
        if (lane != "o11" || EntityAction.Match(callee) is not { Success: true } m || !known.IsRecord(m.Groups[2].Value)
            || known.Index.KindsOf(callee).Any(k => k.Contains("Action", StringComparison.Ordinal))) return null;
        var entity = m.Groups[2].Value;
        return m.Groups[1].Value switch
        {
            "Get" => (["Record"], $" (the {entity} record: {{call}}.Record.{entity}.<Attribute>)"),
            "Create" or "CreateOrUpdate" => (["Id"], $" (the {entity} Identifier)"),
            _ => ([], ""),
        };
    }

    /// <summary>What follows the call's name in the path a segment can mean: for the Record of an entity Get, the entity's own name (`Lock.Pedido` is
    /// `Lock.Record.Pedido`); otherwise the only close output name.</summary>
    private static string? Meant(string callee, List<string> outputs, string segment)
    {
        if (outputs is ["Record"] && EntityAction.Match(callee) is { Success: true } m && string.Equals(m.Groups[2].Value, segment, StringComparison.OrdinalIgnoreCase))
            return "Record." + m.Groups[2].Value;
        return NameSuggestions.OnlyMatch(segment, outputs);
    }

    private static IEnumerable<FlowItem> Nodes(FlowItem item)
    {
        foreach (var child in item.Items)
        {
            if (child.Role == "node") yield return child;
            foreach (var deeper in Nodes(child)) yield return deeper;
        }
    }

    private static IEnumerable<string> Expressions(FlowItem item)
    {
        foreach (var (_, value) in item.Props) if (value.Type == 'e') yield return value.Text;
        foreach (var child in item.Items) foreach (var text in Expressions(child)) yield return text;
    }
}
