using System.Text.Json.Nodes;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 (2026-10-12), class C06 of the refusals found only at apply (34 rounds, 32 of them alone: `IExecuteServerActionNode
/// 'FilterModuleVersions' has no child 'List'`): the list actions of the O11 System module name their list input two ways
/// (ListFilter and ListDuplicate read SourceList, the others List), and a job that names it the other way failed at apply,
/// one round per call, because a job that imports a producer never had its calls judged against the base. The inputs below
/// are the System's own (read from the System references of the owner's modules, 2026-10-12); an argument named the other
/// way is written as the input of that action and listed (ARGUMENT_RENAMED). Only when the call names the System action
/// (bare, `System.X` or `Kind:X`), the job declares no action of that name, the other name is not passed too, and the base
/// (when there is one) does not say the callee has the written input.
/// </summary>
public static class SystemCalls
{
    public const string Rule = "ARGUMENT_RENAMED";

    /// <summary>The O11 System list actions and their inputs.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Inputs = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["ListFilter"] = ["SourceList", "Condition"],
        ["ListDuplicate"] = ["SourceList"],
        ["ListAll"] = ["List", "Condition"],
        ["ListAny"] = ["List", "Condition"],
        ["ListIndexOf"] = ["List", "Condition"],
        ["ListAppend"] = ["List", "Element"],
        ["ListInsert"] = ["List", "Element", "Position"],
        ["ListRemove"] = ["List", "Position"],
        ["ListClear"] = ["List"],
        ["ListSort"] = ["List", "By", "Ascending"],
    };

    private static string? SystemAction(string target)
    {
        var name = target.Contains(':') ? target[(target.IndexOf(':') + 1)..]
            : target.StartsWith("(System).", StringComparison.Ordinal) ? target["(System).".Length..]
            : target.StartsWith("System.", StringComparison.Ordinal) ? target["System.".Length..] : target;
        return name.Contains('/') || name.Contains('.') ? null : Inputs.ContainsKey(name) ? name : null;
    }

    public static void Normalize(JsonArray ops, string? prefix, string lane, IBaseFacts? model, List<JsonObject> done)
    {
        if (lane != "o11") return;
        var job = JobFacts.From(ops);
        var declared = new HashSet<string>(job.Actions.Select(a => a.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var op in ops.OfType<JsonObject>())
            if (op["op"]?.ToString() == "logic" && op["data"] is JsonObject data && data.ContainsKey("flow"))
                try { declared.UnionWith(FlowTextForm.ActionNames(FlowTextForm.Texts(data))); } catch (FormatException) { }
        foreach (var action in job.Actions)
        {
            LogicScan scan;
            try { scan = LogicScan.Of(action.Declaration); } catch { continue; }
            foreach (var call in scan.Calls)
            {
                if (SystemAction(call.Target) is not { } name || call.Step["args"] is not JsonObject args) continue;
                // A job action of that name is the callee, not the System's.
                if (declared.Contains(name)) continue;
                var inputs = Inputs[name];
                // The list input is SourceList or List: the other name, written alone, is that input.
                var list = inputs.Contains("SourceList") && !inputs.Contains("List") ? "SourceList" : inputs.Contains("List") && !inputs.Contains("SourceList") ? "List" : null;
                if (list == null) continue;
                var other = list == "List" ? "SourceList" : "List";
                if (args.Select(kv => kv.Key).FirstOrDefault(k => k.Equals(other, StringComparison.OrdinalIgnoreCase)) is not { } written || args.ContainsKey(list)) continue;
                // The base knows this callee and says it has the written input: nothing to do.
                if (model?.Callee(call.Target, action.Declaration) is { } callee && callee.Inputs.Any(i => i.Name.Equals(written, StringComparison.OrdinalIgnoreCase))) continue;
                var ordered = args.ToList().Select(kv => (kv.Key == written ? list : kv.Key, kv.Value?.DeepClone())).ToList();
                args.Clear();
                foreach (var (k, v) in ordered) args[k] = v;
                SentJob.KeyRenamed(args, written, list);
                done.Add(JobNormalizer.Entry(Rule, prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}{call.Pointer}/args/{written}", written, list,
                    $"{name} of the System module reads its list as {list} ({string.Join(", ", inputs)}): the argument {written} is that input"));
            }
        }
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data || !data.ContainsKey("flow")) continue;
            FlowTexts.Rewrite(data, prefix == null ? null : $"{prefix}/{i}", (text, path) => NormalizeFlow(text, path, declared, model, done));
        }
    }

    private static string? NormalizeFlow(string text, string? path, HashSet<string> declared, IBaseFacts? model, List<JsonObject> done)
    {
        FlowItem action;
        Dictionary<string, int> nodeLines;
        try { action = ModuleFlow.Read(text); nodeLines = FlowParser.NodeLines(text); }
        catch (FormatException) { return null; }
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var changed = false;
        var caller = new JsonObject { ["name"] = action.Name, ["kind"] = action.Owner.Length > 0 ? "screen" : action.Kind.Contains("Client", StringComparison.Ordinal) ? "client" : "server" };
        foreach (var call in action.Items.Where(n => n.Role == "node" && n.Kind == "Execute"))
        {
            if (call.Prop("Action") is not { } target || SystemAction(target) is not { } name || declared.Contains(name)
                || !nodeLines.TryGetValue(call.Key, out var line)) continue;
            var inputs = Inputs[name];
            var list = inputs.Contains("SourceList") ? "SourceList" : inputs.Contains("List") ? "List" : null;
            if (list == null) continue;
            var other = list == "List" ? "SourceList" : "List";
            var args = call.Items.Where(p => p.Role == "argument").ToList();
            if (args.Any(p => p.Name.Equals(list, StringComparison.OrdinalIgnoreCase))
                || args.FirstOrDefault(p => p.Name.Equals(other, StringComparison.OrdinalIgnoreCase)) is not { } argument) continue;
            if (model?.Callee(target, caller) is { } callee && callee.Inputs.Any(p => p.Name.Equals(argument.Name, StringComparison.OrdinalIgnoreCase))) continue;
            var raw = lines[line - 1];
            var callAt = raw.IndexOf(target + "(", StringComparison.Ordinal);
            if (callAt < 0) continue;
            var at = callAt + target.Length + 1;
            string? written = null;
            while (at < raw.Length && raw[at] != ')')
            {
                var end = FlowSyntax.Scan(raw, at, [", ", ")"]);
                if (end < at) break;
                var part = raw[at..end];
                var equal = part.IndexOf('=');
                var parameter = equal < 0 ? part : part[..equal];
                if (parameter == argument.Name)
                {
                    written = raw[..at] + list + (equal < 0 ? "=" + part : part[equal..]) + raw[end..];
                    break;
                }
                if (end >= raw.Length || raw[end] == ')') break;
                at = end + 2;
            }
            if (written == null) continue;
            lines[line - 1] = written;
            try { ModuleFlow.Read(string.Join("\n", lines)); }
            catch (FormatException) { lines[line - 1] = raw; continue; }
            changed = true;
            var entry = JobNormalizer.Entry(Rule, path, $"line {line}: {raw.Trim()}", written.Trim(),
                $"line {line}: {name} of the System module reads its list as {list} ({string.Join(", ", inputs)}); the argument value is unchanged");
            entry["line"] = line;
            done.Add(entry);
        }
        return changed ? string.Join("\n", lines) : null;
    }
}
