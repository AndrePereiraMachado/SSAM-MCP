using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// Warnings over the logic grammar (C29), pure and before any model: what the Studio accepts but fails at runtime or
/// converts silently. Never a refusal.
/// <list type="bullet">
/// <item>LIST_CURRENT_UNGUARDED: `X.List.Current` of an aggregate/SQL of the same action read where nothing proves X has a
/// row (an `if not X.List.Empty`, an `if X.List.Empty` whose branch leaves, a `foreach X.List`, or the guard in the same
/// expression). An empty result gives an empty record, and the bug surfaces far away (the 2026-10-04 case).</item>
/// <item>DATETIME_COMPARED_WITH_DATE: a Date and a Date Time on the two sides of a comparison (the Date becomes midnight).</item>
/// <item>ODC_COUNT_TO_INTEGER (ODC only): an aggregate's Count is a Long Integer; assigned to an Integer it is narrowed.</item>
/// </list>
/// </summary>
public static class LogicLint
{
    private static readonly Regex Current = new(@"(?<![\w.])([A-Za-z_]\w*)\.List\.Current\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex NotEmpty = new(@"\bnot\s+([A-Za-z_]\w*)\.List\.Empty\b|(?<![\w.])([A-Za-z_]\w*)\.(?:List\.(?:Length|Count)|Count)\s*(?:>\s*0|>=\s*1|<>\s*0)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex Empty = new(@"(?<!\bnot\s+)(?<![\w.])([A-Za-z_]\w*)\.List\.Empty\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex Comparison = new(@"(?<a>CurrDateTime\(\)|CurrDate\(\)|(?<![\w.])[A-Za-z_]\w*(?![\w.(]))\s*(?<op><=|>=|<>|=|<|>)\s*(?<b>CurrDateTime\(\)|CurrDate\(\)|(?<![\w.])[A-Za-z_]\w*(?![\w.(]))", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex CountOnly = new(@"^\s*([A-Za-z_]\w*)\.Count\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex Str = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);
    private static readonly string[] Leaving = ["raise", "return", "break", "continue"];

    public static IEnumerable<JsonObject> Check(JsonArray ops, string lane, string? prefix = "/ops")
    {
        var found = new List<JsonObject>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"]?["actions"] is not JsonArray actions) continue;
            // What the compiler writes otherwise than the spec (a node numbered as the Studio does, Long Text as Text, the record
            // path a list really has): never a refusal, always said.
            foreach (var note in LogicExpander.Notes(op["data"]!.AsObject()))
                found.Add(JobPreflight.Problem(i, prefix == null ? null : $"{prefix}/{i}/data{note.Pointer}", note.Code, "warning", note.Message, note.Fix, null, "logic"));
            for (var a = 0; a < actions.Count; a++)
            {
                if (actions[a] is not JsonObject action || action["steps"] is not JsonArray steps) continue;
                var context = new Context(i, prefix == null ? null : $"{prefix}/{i}/data/actions/{a}/steps", lane, Types(action), Sources(steps), found);
                try { context.Walk(steps, context.Root, new HashSet<string>(StringComparer.OrdinalIgnoreCase)); }
                catch { /* the grammar errors are JobPreflight's; a lint never hides them */ }
            }
        }
        return found;
    }

    private static Dictionary<string, string> Types(JsonObject action)
    {
        var types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var section in new[] { "inputs", "outputs", "vars" })
            foreach (var p in (action[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                if (p["name"] is JsonValue n && n.TryGetValue<string>(out var name) && p["type"] is JsonValue t && t.TryGetValue<string>(out var type))
                    types[name] = Normal(type);
        return types;
    }

    private static string Normal(string type) => type.Trim() switch
    {
        var t when t.Equals("DateTime", StringComparison.OrdinalIgnoreCase) || t.Equals("Date Time", StringComparison.OrdinalIgnoreCase) => "Date Time",
        var t when t.Equals("Date", StringComparison.OrdinalIgnoreCase) => "Date",
        var t when t.Equals("Integer", StringComparison.OrdinalIgnoreCase) || t.Equals("Int", StringComparison.OrdinalIgnoreCase) => "Integer",
        var t => t,
    };

    /// <summary>The aggregates and SQL queries of the action (get steps, any depth): the only lists this lint judges.</summary>
    private static HashSet<string> Sources(JsonArray steps)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Visit(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject o:
                    if (o["get"] is JsonValue && o["as"] is JsonValue a && a.TryGetValue<string>(out var name)) names.Add(name);
                    foreach (var (_, child) in o) Visit(child);
                    break;
                case JsonArray list: foreach (var child in list) Visit(child); break;
            }
        }
        Visit(steps);
        return names;
    }

    private sealed class Context(int op, string? root, string lane, Dictionary<string, string> types, HashSet<string> sources, List<JsonObject> found)
    {
        public string? Root => root;
        private readonly HashSet<string> reported = new(StringComparer.Ordinal);

        public void Walk(JsonArray steps, string? path, HashSet<string> guarded)
        {
            var scope = new HashSet<string>(guarded, StringComparer.OrdinalIgnoreCase);
            for (var s = 0; s < steps.Count; s++)
            {
                if (steps[s] is not JsonObject step) continue;
                var at = path == null ? null : path + "/" + s;
                foreach (var (key, text) in Expressions(step)) Expression(text, at == null ? null : at + "/" + key, scope, step, key);
                if (step["if"] is JsonValue condition && condition.TryGetValue<string>(out var test))
                {
                    var whenTrue = WhenTrue(test); var whenFalse = WhenFalse(test);
                    var then = step["then"] as JsonArray ?? new JsonArray();
                    var otherwise = step["else"] as JsonArray ?? new JsonArray();
                    Walk(then, at == null ? null : at + "/then", Union(scope, whenTrue));
                    Walk(otherwise, at == null ? null : at + "/else", Union(scope, whenFalse));
                    if (Leaves(then)) scope.UnionWith(whenFalse);
                    if (Leaves(otherwise)) scope.UnionWith(whenTrue);
                }
                else if (step["foreach"] is JsonValue list && list.TryGetValue<string>(out var source) && step["do"] is JsonArray body)
                {
                    var inner = new HashSet<string>(scope, StringComparer.OrdinalIgnoreCase);
                    if (Regex.Match(source.Trim(), @"^([A-Za-z_]\w*)\.List$", RegexOptions.IgnoreCase) is { Success: true } m) inner.Add(m.Groups[1].Value);
                    Walk(body, at == null ? null : at + "/do", inner);
                }
                else if (step["while"] is JsonValue loop && loop.TryGetValue<string>(out var whileTest))
                {
                    if (step["do"] is JsonArray loopBody) Walk(loopBody, at == null ? null : at + "/do", Union(scope, WhenTrue(whileTest)));
                    if (step["next"] is JsonArray next) Walk(next, at == null ? null : at + "/next", Union(scope, WhenTrue(whileTest)));
                }
                else if (step["switch"] is JsonArray cases)
                {
                    for (var c = 0; c < cases.Count; c++)
                        if (cases[c] is JsonObject branch && branch["steps"] is JsonArray branchSteps)
                            Walk(branchSteps, at == null ? null : $"{at}/switch/{c}/steps",
                                Union(scope, branch["when"] is JsonValue w && w.TryGetValue<string>(out var when) ? WhenTrue(when) : []));
                    if (step["otherwise"] is JsonArray rest) Walk(rest, at == null ? null : at + "/otherwise", scope);
                }
            }
        }

        private void Expression(string text, string? pointer, HashSet<string> guarded, JsonObject step, string key)
        {
            var code = Str.Replace(text, "\"\"");
            foreach (Match m in Current.Matches(code))
            {
                var name = m.Groups[1].Value;
                if (!sources.Contains(name) || guarded.Contains(name)) continue;
                // The guard written in the same expression: If(X.List.Empty, ..., X.List.Current...) or X.List.Length/Count tests.
                if (Regex.IsMatch(code, $@"(?<![\w.]){Regex.Escape(name)}\.(?:List\.(?:Empty|Length|Count)|Count)\b", RegexOptions.IgnoreCase)) continue;
                if (!reported.Add("current|" + pointer + "|" + name.ToLowerInvariant())) continue;
                found.Add(JobPreflight.Problem(op, pointer, "LIST_CURRENT_UNGUARDED", "warning",
                    $"{name}.List.Current is read where nothing proves {name} returned a row: with no rows Current is an empty record and the action goes on with default values",
                    $"guard it: {{\"if\":\"not {name}.List.Empty\",\"then\":[...]}} around the step, or If({name}.List.Empty, <default>, {name}.List.Current...) in the expression", null, "logic"));
            }
            foreach (Match m in Comparison.Matches(code))
            {
                var left = TypeOf(m.Groups["a"].Value); var right = TypeOf(m.Groups["b"].Value);
                if (!((left == "Date" && right == "Date Time") || (left == "Date Time" && right == "Date"))) continue;
                if (!reported.Add("date|" + pointer + "|" + m.Value)) continue;
                var dateTime = left == "Date Time" ? m.Groups["a"].Value : m.Groups["b"].Value;
                found.Add(JobPreflight.Problem(op, pointer, "DATETIME_COMPARED_WITH_DATE", "warning",
                    $"'{m.Value.Trim()}' compares a Date with a Date Time: the Date becomes midnight, so the same day compares as earlier",
                    $"compare dates: DateTimeToDate({dateTime}) on the Date Time side, or declare both sides with the same type", null, "logic"));
            }
            if (lane == "odc" && step["assign"] is JsonObject && types.TryGetValue(key, out var target) && target == "Integer"
                && CountOnly.Match(code) is { Success: true } count && sources.Contains(count.Groups[1].Value)
                && reported.Add("count|" + pointer))
                found.Add(JobPreflight.Problem(op, pointer, "ODC_COUNT_TO_INTEGER", "warning",
                    $"{count.Groups[1].Value}.Count is a Long Integer in ODC, and '{key}' is an Integer: the value is narrowed",
                    $"declare '{key}' as Long Integer, or assign LongIntegerToInteger({count.Groups[1].Value}.Count)", null, "logic"));
        }

        private string? TypeOf(string operand)
        {
            if (operand.Equals("CurrDate()", StringComparison.OrdinalIgnoreCase)) return "Date";
            if (operand.Equals("CurrDateTime()", StringComparison.OrdinalIgnoreCase)) return "Date Time";
            return types.TryGetValue(operand, out var type) ? type : null;
        }
    }

    private static HashSet<string> Union(HashSet<string> scope, IEnumerable<string> more)
    {
        var copy = new HashSet<string>(scope, StringComparer.OrdinalIgnoreCase);
        copy.UnionWith(more);
        return copy;
    }

    /// <summary>The sources a condition proves non-empty when it is true (a conjunction: `or` proves nothing).</summary>
    private static IEnumerable<string> WhenTrue(string condition)
    {
        if (Regex.IsMatch(condition, @"\bor\b", RegexOptions.IgnoreCase)) return [];
        return NotEmpty.Matches(condition).Select(m => m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value).ToArray();
    }

    /// <summary>The sources a condition proves non-empty when it is false (a disjunction of `X.List.Empty`: `and` proves nothing).</summary>
    private static IEnumerable<string> WhenFalse(string condition)
    {
        if (Regex.IsMatch(condition, @"\band\b", RegexOptions.IgnoreCase)) return [];
        return Empty.Matches(condition).Select(m => m.Groups[1].Value).ToArray();
    }

    private static bool Leaves(JsonArray steps) => steps.Count > 0 && steps[^1] is JsonObject last && Leaving.Any(last.ContainsKey);

    /// <summary>The OutSystems expressions of one step, by the key that holds them (JavaScript and SQL statements are not).</summary>
    private static IEnumerable<(string Key, string Text)> Expressions(JsonObject step)
    {
        static IEnumerable<string> Texts(JsonNode? node) => node switch
        {
            JsonValue v when v.TryGetValue<string>(out var s) => [s],
            JsonArray a => a.OfType<JsonValue>().Select(x => x.TryGetValue<string>(out var s) ? s : null).OfType<string>(),
            _ => [],
        };
        foreach (var key in new[] { "where", "max", "start", "record", "id", "if", "while", "foreach", "message" })
            foreach (var text in Texts(step[key])) yield return (key, text);
        foreach (var key in new[] { "assign", "args", "record" })
            if (step[key] is JsonObject pairs)
                foreach (var (name, value) in pairs)
                    foreach (var text in Texts(value)) yield return (name, text);
        if (step["params"] is JsonObject parameters)
            foreach (var (name, value) in parameters)
                foreach (var text in Texts(value?["value"])) yield return (name, text);
        if (step["node"] is JsonValue node && node.ToString() != "IJavaScriptNode" && step["properties"] is JsonObject properties)
            foreach (var (name, value) in properties)
                foreach (var text in Texts(value)) yield return (name, text);
    }

    // ---- T9: the JavaScript of client-side code against the runtime that renders the page ----------------------------------

    /// <summary>The device classes the runtime's UI framework keeps on body.</summary>
    public static readonly IReadOnlyList<string> RuntimeDeviceClasses = ["phone", "tablet", "desktop", "portrait", "landscape"];

    /// <summary>T9: the JavaScript of a node, a script or a page script that runs in client-side code, read once as tokens
    /// (Preflight.ClientScriptLint): DATETIME_TZ_REINTERPRETED, DOM_MUTATION_OF_RUNTIME and JS_RUNTIME_DUPLICATE, each an error
    /// only when the script proves it, a warning otherwise. The caller decides that the code runs on the client.</summary>
    public static IReadOnlyList<Preflight.ClientScriptLint.Finding> ClientScript(string script, Preflight.ScriptContext context)
        => Preflight.ClientScriptLint.Lint(script, context);

    /// <summary>Every OutSystems expression the logic ops of a job write, with its op (the base check reads their calls): the
    /// JSON form's, and the expression-typed values of the text form (read from its parse: never SQL, JavaScript or comments).
    /// A text that does not parse gives none (its FLOW_SYNTAX says why) and hides nothing of another text. A call of an action
    /// a text of the job declares is no call of an unknown function (the checks only know the JSON form's declarations): it is
    /// taken out of the expression the checks read.</summary>
    public static IEnumerable<(int Op, string Text)> AllExpressions(JsonArray ops)
    {
        var parsed = new List<(int Op, FlowItem Action)>();
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject textOp && textOp["op"]?.ToString() == "logic" && textOp["data"] is JsonObject textData && textData["flow"] != null)
            {
                // A data.flow that is no text of an action (42, [42], {"text":1}) is the preflight's LOGIC_INVALID: it gives no
                // expression here and never stops the base check (PatchCertaintyUnreadableJobScopeTests, integ/proto-into-product).
                List<(string Text, string? BasedOn, string Pointer)> texts;
                try { texts = FlowTextForm.Texts(textData); }
                catch (Exception error) when (error is KernelRefusalException or InvalidOperationException or FormatException) { continue; }
                foreach (var text in texts)
                {
                    try { parsed.Add((i, ModuleFlow.Read(text.Text))); }
                    catch (FormatException) { }
                }
            }
        var declared = parsed.Select(p => p.Action.Name).Where(n => n.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var ownCalls = declared.Count == 0 ? null
            : new Regex(@"(?<![\w.])(?:" + string.Join("|", declared.Select(Regex.Escape)) + @")\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        foreach (var (op, action) in parsed)
        {
            var items = new Stack<FlowItem>(action.Items);
            while (items.TryPop(out var item))
            {
                foreach (var value in item.Props.Values)
                    if (value.Type == 'e' && value.Text.Length > 0) yield return (op, ownCalls == null ? value.Text : ownCalls.Replace(value.Text, "("));
                foreach (var child in item.Items) items.Push(child);
            }
        }
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"]?["actions"] is not JsonArray actions) continue;
            var pending = new Stack<JsonNode?>(actions.OfType<JsonObject>().Select(a => a["steps"]).Concat(actions.OfType<JsonObject>().Select(a => a["handlers"])));
            while (pending.TryPop(out var node))
            {
                switch (node)
                {
                    case JsonArray list: foreach (var child in list) pending.Push(child); break;
                    case JsonObject step:
                        if (step.ContainsKey("get") || step.ContainsKey("assign") || step.ContainsKey("call") || step.ContainsKey("if") || step.ContainsKey("node")
                            || step.ContainsKey("while") || step.ContainsKey("foreach") || step.ContainsKey("raise") || step.ContainsKey("save") || step.ContainsKey("create")
                            || step.ContainsKey("update") || step.ContainsKey("delete"))
                            foreach (var (_, text) in Expressions(step)) yield return (i, text);
                        foreach (var key in new[] { "then", "else", "do", "next", "otherwise", "steps", "switch" })
                            if (step[key] is JsonArray nested) pending.Push(nested);
                        if (step["switch"] is JsonArray cases)
                            foreach (var branch in cases.OfType<JsonObject>())
                                if (branch["when"] is JsonValue w && w.TryGetValue<string>(out var when)) yield return (i, when);
                        break;
                }
            }
        }
    }
}
