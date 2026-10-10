using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

public sealed record LogicUsageReport(IReadOnlyList<string> Inputs, IReadOnlyList<string> Variables, IReadOnlyList<string> Outputs)
{
    public bool HasUnused => Inputs.Count + Variables.Count + Outputs.Count > 0;
}

/// <summary>Uso lexical das declaracoes da spec. Strings e membros qualificados nao contam como parametros locais.</summary>
public static class LogicUsage
{
    private static readonly Regex Strings = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);

    public static LogicUsageReport Analyze(JsonObject action)
    {
        var expressions = new List<(string Text, string?[] Shadows)>();
        var writes = new List<string>();
        var callArguments = new List<string>();
        void Read(JsonNode? node, params string?[] shadows)
        {
            if (node is JsonArray list) { foreach (var value in list) Read(value, shadows); }
            else if (node != null) expressions.Add((Strings.Replace(node.ToString(), "\"\""), shadows));
        }
        void Steps(JsonArray? steps)
        {
            foreach (var step in steps?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>())
            {
                if (step.ContainsKey("get"))
                {
                    var entity = step["get"]?.GetValue<string>();
                    Read(step["where"], entity, step["as"]?.GetValue<string>());
                    // Every key of the sort, in any of its forms (a direction word or {by, desc} is not an expression).
                    List<LogicExpander.SortKey> keys;
                    try { keys = LogicExpander.SortKeys(step["sort"]); } catch (Exception) { keys = []; }
                    foreach (var key in keys) Read(JsonValue.Create(key.Attribute), entity, step["as"]?.GetValue<string>());
                    Read(step["max"]); Read(step["start"]);
                    foreach (var join in step["joins"]?.AsArray().OfType<JsonObject>() ?? []) Read(join["condition"], entity);
                    foreach (var column in step["columns"]?.AsArray().OfType<JsonObject>() ?? []) Read(column["attribute"], entity);
                    foreach (var column in step["calculated"]?.AsArray().OfType<JsonObject>() ?? []) Read(column["value"], entity);
                    foreach (var param in step["params"]?.AsObject() ?? new JsonObject()) Read(param.Value?["value"]);
                }
                if (step["assign"] is JsonObject assign)
                    foreach (var pair in assign) { expressions.Add((pair.Key, [])); Read(pair.Value); writes.Add(pair.Key); }
                foreach (var arg in step["args"]?.AsObject() ?? new JsonObject())
                {
                    Read(arg.Value);
                    if (arg.Value != null) callArguments.Add(Strings.Replace(arg.Value.ToString(), "\"\""));
                }
                if (step.ContainsKey("node")) foreach (var (key, value) in LogicNodes.Values(step))
                    if (LogicNodes.Get(step).Fields[key].Kind == "expression") Read(value);
                foreach (var branch in step["switch"]?.AsArray().OfType<JsonObject>() ?? []) { Read(branch["when"]); Steps(branch["steps"]?.AsArray()); }
                if (step.ContainsKey("foreach")) { Read(step["start"]); Read(step["max"]); }
                foreach (var key in new[] { "record", "id", "if", "foreach", "while", "message" }) Read(step[key]);
                foreach (var branch in new[] { "then", "else", "do", "next", "otherwise" }) Steps(step[branch] as JsonArray);
            }
        }
        Steps(action["steps"] as JsonArray);
        foreach (var handler in action["handlers"]?.AsArray().OfType<JsonObject>() ?? []) Steps(handler["steps"]?.AsArray());
        foreach (var group in new[] { "vars", "outputs" })
            foreach (var parameter in action[group]?.AsArray().OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>()) Read(parameter["default"]);

        bool Mentions(string text, string name) => Regex.IsMatch(text, @"(?<![\w.])" + Regex.Escape(name) + @"(?![\w])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        bool Used(string name) => expressions.Any(e => !e.Shadows.Contains(name, StringComparer.OrdinalIgnoreCase) && Mentions(e.Text, name));
        string[] Names(string kind) => action[kind]?.AsArray().Select(p => p!["name"]!.GetValue<string>()).ToArray() ?? [];
        // Passing an output list to a call (e.g. ListAppend) may mutate it. The Verify remains the final judge for other calls.
        bool Assigned(string name) => writes.Any(w => Regex.IsMatch(w, @"^\s*" + Regex.Escape(name) + @"(?![\w])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            || callArguments.Any(a => Mentions(a, name));
        return new(Names("inputs").Where(n => !Used(n)).ToArray(), Names("vars").Where(n => !Used(n)).ToArray(),
            Names("outputs").Where(n => !Assigned(n)).ToArray());
    }

    /// <summary>Kept for callers that still want the refusal; the logic compiler no longer refuses unused declarations
    /// (C18 of the atritos 3 package, A03: the Verify warns, the warning is nonblocking).</summary>
    public static void Check(JsonObject action)
    {
        var report = Analyze(action);
        if (!report.HasUnused) return;
        throw new InvalidOperationException(Describe(action, report) +
            " Use them in where/sort/max/start/if/assign/args/record/id/message/foreach/params.value or remove them.");
    }

    /// <summary>"logic: action A: inputs declared and never used: B; vars never used: V."</summary>
    public static string Describe(JsonObject action, LogicUsageReport report)
    {
        var parts = new List<string>();
        if (report.Inputs.Count > 0) parts.Add("inputs declared and never used: " + string.Join(", ", report.Inputs));
        if (report.Variables.Count > 0) parts.Add("vars never used: " + string.Join(", ", report.Variables));
        if (report.Outputs.Count > 0) parts.Add("outputs never assigned: " + string.Join(", ", report.Outputs));
        return $"logic: action {action["name"]}: {string.Join("; ", parts)}.";
    }
}
