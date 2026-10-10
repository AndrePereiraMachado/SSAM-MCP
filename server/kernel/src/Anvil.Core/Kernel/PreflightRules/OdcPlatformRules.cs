using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.PreflightRules;

/// <summary>
/// ODC platform rules the ODC Studio itself refuses, checked on the job before any model is touched (pluggable
/// preflight rule, interface I1 of the 2026-10-05 package: discovered by name and signature, pure, no I/O, no model, no
/// clock). Each one was learned by a refused delivery in a real session (62a884e8, QuizLiveWeb, 2026-10-04 22:08-22:29):
/// <list type="bullet">
/// <item><c>ODC_SERVICE_ACTION_SAME_APP</c>: a Service Action is the API of the app for OTHER apps; the app's own flows
/// cannot call it ("A IServiceAction cannot be used as the value for the IExecuteServerActionNode.Action property").</item>
/// <item><c>ODC_FUNCTION_UNAVAILABLE</c>: <c>GenerateGuid()</c> is not an ODC built-in ("Unknown function 'GenerateGuid'")
/// and <c>mod</c> is not an ODC operator ("Expecting an expression instead of end of line").</item>
/// <item><c>ODC_COUNT_IS_LONG</c>: an aggregate's <c>Count</c> is Long Integer on ODC; assigning it to an Integer is an
/// ExpressionUnexpectedExpresssionType error.</item>
/// </list>
/// Only what the job itself proves is refused: a call to a Service Action the job declares (or names as
/// <c>IServiceAction:</c>, an element of this app; another app's is a signature), and an Integer target declared in the
/// same action. Every problem carries the exact fix and, when the fix is mechanical, an RFC 6902 patch. Pointers are in
/// the <c>{"ops":[...]}</c> form of the job document (the form the deliver tools store).
/// </summary>
public static class OdcPlatformRules
{
    private static readonly Regex GenerateGuid = new(@"\bGenerateGuid\s*\(", RegexOptions.CultureInvariant);
    // The binary operator between two operands ("a mod n"), never a name that merely reads "mod".
    private static readonly Regex ModOperator = new(@"(?<=[A-Za-z0-9_\)\]])\s+mod\s+(?=[A-Za-z0-9_\(\-""])", RegexOptions.CultureInvariant);
    private static readonly Regex StringLiteral = new("\"(?:[^\"]|\"\")*\"", RegexOptions.CultureInvariant);
    // The step keys whose values are OutSystems expressions (never SQL, never names).
    private static readonly string[] ExpressionStepKeys = ["if", "while", "where", "foreach", "return", "message"];
    private static readonly string[] BranchKeys = ["then", "else", "do", "otherwise", "steps"];
    // Properties a raw `set` writes as an OutSystems expression.
    private static readonly string[] ExpressionProps = ["Value", "Condition", "Expression", "DefaultValue", "Visible", "Enabled"];

    public static IEnumerable<JsonObject> Check(JsonArray ops, string lane)
    {
        if (!string.Equals(lane, "odc", StringComparison.OrdinalIgnoreCase) || ops == null) return [];
        var problems = new List<JsonObject>();
        var serviceActions = DeclaredServiceActions(ops);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var verb = op["op"]?.GetValue<string>() ?? "";
            var basePointer = "/ops/" + i;
            if (verb == "logic" && op["data"]?["actions"] is JsonArray actions)
                for (var a = 0; a < actions.Count; a++)
                    if (actions[a] is JsonObject action) CheckAction(problems, i, $"{basePointer}/data/actions/{a}", action, serviceActions);
            if (verb == "set") CheckSet(problems, i, basePointer, op, serviceActions);
            else if (verb != "logic") ScanForGenerateGuid(problems, i, basePointer, op);
        }
        return problems;
    }

    // ---- the Service Actions this job declares (logic kind:"service" or a raw create IServiceAction), by name
    private static HashSet<string> DeclaredServiceActions(JsonArray ops)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in ops)
        {
            if (node is not JsonObject op) continue;
            var verb = op["op"]?.GetValue<string>();
            if (verb == "logic" && op["data"]?["actions"] is JsonArray actions)
                foreach (var a in actions.OfType<JsonObject>())
                    if (Text(a["kind"]) == "service" && Text(a["name"]) is { Length: > 0 } name) names.Add(name);
            if (verb == "create" && Text(op["type"]) is "IServiceAction" or "ServiceAction" && Text(op["name"]) is { Length: > 0 } created) names.Add(created);
        }
        return names;
    }

    private static string? ServiceActionTarget(string? reference, HashSet<string> declared)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        var value = reference.Trim();
        if (value.StartsWith("IServiceAction:", StringComparison.Ordinal)) return value["IServiceAction:".Length..];
        return declared.Contains(value) ? value : null;
    }

    private static void CheckSet(List<JsonObject> problems, int index, string pointer, JsonObject op, HashSet<string> declared)
    {
        var prop = Text(op["prop"]);
        if (prop != null && ExpressionProps.Contains(prop, StringComparer.Ordinal)) Expression(problems, index, pointer + "/value", Text(op["value"]));
        if (prop != "Action") return;
        var target = ServiceActionTarget(Text(op["value"]), declared);
        if (target == null) return;
        problems.Add(Problem(index, pointer + "/value", "ODC_SERVICE_ACTION_SAME_APP",
            $"set Action names the Service Action '{target}' of this app; ODC refuses a call from the app to its own Service Action (a Service Action is the API other apps call).",
            ServiceActionFix(target), null));
    }

    private static string ServiceActionFix(string name) =>
        $"Point at a Server Action: declare the logic of '{name}' with kind:\"server\" and call that from this app; a Service Action stays only as the entry other apps call (it may call the Server Action). Add such an entry, or any Core_ wrapper, only when the person asked for the API.";

    // ---- one action of a logic op: its declared Integer names, aggregate aliases, and every step recursively
    private static void CheckAction(List<JsonObject> problems, int index, string pointer, JsonObject action, HashSet<string> serviceActions)
    {
        var integers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in new[] { "inputs", "outputs", "vars" })
            if (action[key] is JsonArray list)
                foreach (var p in list.OfType<JsonObject>())
                    if (Text(p["type"]) is { } type && type.Trim().Equals("Integer", StringComparison.OrdinalIgnoreCase) && Text(p["name"]) is { Length: > 0 } name) integers.Add(name);
        var aggregates = new HashSet<string>(StringComparer.Ordinal);
        CollectAggregates(action["steps"] as JsonArray, aggregates);
        if (action["handlers"] is JsonArray handlers)
            foreach (var h in handlers.OfType<JsonObject>()) CollectAggregates(h["steps"] as JsonArray, aggregates);
        Steps(problems, index, pointer + "/steps", action["steps"] as JsonArray, integers, aggregates, serviceActions);
        if (action["handlers"] is JsonArray hs)
            for (var h = 0; h < hs.Count; h++)
                if (hs[h] is JsonObject handler) Steps(problems, index, $"{pointer}/handlers/{h}/steps", handler["steps"] as JsonArray, integers, aggregates, serviceActions);
    }

    private static void CollectAggregates(JsonArray? steps, HashSet<string> aliases)
    {
        if (steps == null) return;
        foreach (var step in steps.OfType<JsonObject>())
        {
            if (step.ContainsKey("get") && step["sql"]?.GetValue<bool?>() != true && Text(step["as"]) is { Length: > 0 } alias) aliases.Add(alias);
            foreach (var branch in Branches(step)) CollectAggregates(branch.Steps, aliases);
        }
    }

    private static IEnumerable<(string Key, JsonArray Steps)> Branches(JsonObject step)
    {
        foreach (var key in BranchKeys)
            if (step[key] is JsonArray list) yield return (key, list);
        // switch: [{when, steps}]
        if (step["switch"] is JsonArray cases)
            for (var c = 0; c < cases.Count; c++)
                if (cases[c] is JsonObject @case && @case["steps"] is JsonArray caseSteps) yield return ($"switch/{c}/steps", caseSteps);
    }

    private static void Steps(List<JsonObject> problems, int index, string pointer, JsonArray? steps, HashSet<string> integers, HashSet<string> aggregates, HashSet<string> serviceActions)
    {
        if (steps == null) return;
        for (var s = 0; s < steps.Count; s++)
        {
            if (steps[s] is not JsonObject step) continue;
            var at = $"{pointer}/{s}";
            if (step.ContainsKey("call"))
            {
                var target = ServiceActionTarget(Text(step["call"]), serviceActions);
                if (target != null)
                    problems.Add(Problem(index, at + "/call", "ODC_SERVICE_ACTION_SAME_APP",
                        $"call '{Text(step["call"])}' is a Service Action of this app; ODC refuses a call from the app to its own Service Action (a Service Action is the API other apps call).",
                        ServiceActionFix(target), null));
                if (step["args"] is JsonObject args)
                    foreach (var (name, value) in args) Expression(problems, index, $"{at}/args/{Escape(name)}", Text(value));
            }
            if (step["assign"] is JsonObject assign)
                foreach (var (target, value) in assign)
                {
                    var expression = Text(value);
                    var valuePointer = $"{at}/assign/{Escape(target)}";
                    Expression(problems, index, valuePointer, expression);
                    if (expression != null && integers.Contains(target) && CountOf(expression, aggregates) is { } count
                        && !expression.Contains("LongIntegerToInteger(", StringComparison.Ordinal))
                    {
                        var fixedValue = "LongIntegerToInteger(" + expression.Trim() + ")";
                        problems.Add(Problem(index, valuePointer, "ODC_COUNT_IS_LONG",
                            $"'{target}' is Integer and '{count}' is Long Integer on ODC (an aggregate's Count); the Studio refuses the assignment (ExpressionUnexpectedExpresssionType).",
                            $"assign {target} = {fixedValue} (or declare '{target}' as Long Integer)",
                            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = valuePointer, ["value"] = fixedValue })));
                    }
                }
            foreach (var key in ExpressionStepKeys)
            {
                if (key == "where" && step["where"] is JsonArray wheres)
                {
                    for (var w = 0; w < wheres.Count; w++) Expression(problems, index, $"{at}/where/{w}", Text(wheres[w]));
                    continue;
                }
                if (step.ContainsKey(key) && step[key] is JsonValue) Expression(problems, index, $"{at}/{key}", Text(step[key]));
            }
            if (step["switch"] is JsonArray cases)
                for (var c = 0; c < cases.Count; c++)
                    if (cases[c] is JsonObject @case) Expression(problems, index, $"{at}/switch/{c}/when", Text(@case["when"]));
            foreach (var (key, branch) in Branches(step)) Steps(problems, index, $"{at}/{key}", branch, integers, aggregates, serviceActions);
        }
    }

    // `<alias>.Count` of an aggregate of the same action, as a term of the expression (not `.List.Count` of a list).
    private static string? CountOf(string expression, HashSet<string> aggregates)
    {
        var code = StringLiteral.Replace(expression, "\"\"");
        foreach (Match m in Regex.Matches(code, @"(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\.Count(?![A-Za-z0-9_])"))
            if (aggregates.Contains(m.Groups[1].Value)) return m.Value;
        return null;
    }

    private static void Expression(List<JsonObject> problems, int index, string pointer, string? expression)
    {
        if (string.IsNullOrWhiteSpace(expression)) return;
        var code = StringLiteral.Replace(expression, "\"\"");
        if (GenerateGuid.IsMatch(code)) problems.Add(GenerateGuidProblem(index, pointer));
        if (ModOperator.IsMatch(code))
        {
            // C19 of the atritos 3 package: the exact expression, as an RFC 6902 patch (Preflight.ExpressionRewrites).
            var written = Preflight.ExpressionRewrites.Mod(expression!, Preflight.ExpressionRewrites.HasMod("odc"));
            problems.Add(Problem(index, pointer, "ODC_FUNCTION_UNAVAILABLE",
                "'mod' is not an ODC operator (the Studio answers 'Expecting an expression instead of end of line').",
                (written != null ? $"write {written} (the patch writes it); " : "write Mod(x, n), or x - Trunc(x / n) * n; ")
                + "not x - DecimalToInteger(x / n) * n (the QuizLive form of 2026-10-04): DecimalToInteger rounds half to even in logic, so 5 mod 3 gave -1",
                written == null ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = written })));
        }
    }

    private static JsonObject GenerateGuidProblem(int index, string pointer) => Problem(index, pointer, "ODC_FUNCTION_UNAVAILABLE",
        "GenerateGuid() is not an ODC built-in function (the Studio answers 'Unknown function GenerateGuid').",
        "derive the value from data instead: e.g. a code from the last record Id, LongIntegerToText(10000 + IdentifierToLongInteger(GetLast.List.Current.<Entity>.Id) * 7919 ...) checked for uniqueness with a get, as the QuizLive delivery did (2026-10-04); an entity Id is already unique", null);

    // Raw verbs (set Value/Condition/..., html {{expr}}) carry expressions too: GenerateGuid( is specific enough to scan
    // every string of the op except SQL text and authoring notes.
    private static void ScanForGenerateGuid(List<JsonObject> problems, int index, string pointer, JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var (key, value) in o)
                {
                    if (key is "_why" or "statement" or "sql" or "description") continue;
                    ScanForGenerateGuid(problems, index, pointer + "/" + Escape(key), value);
                }
                break;
            case JsonArray a:
                for (var k = 0; k < a.Count; k++) ScanForGenerateGuid(problems, index, pointer + "/" + k, a[k]);
                break;
            case JsonValue v when v.TryGetValue<string>(out var text):
                if (GenerateGuid.IsMatch(StringLiteral.Replace(text, "\"\"")) || (text.Contains("{{", StringComparison.Ordinal) && GenerateGuid.IsMatch(text)))
                    problems.Add(GenerateGuidProblem(index, pointer));
                break;
        }
    }

    private static JsonObject Problem(int index, string pointer, string code, string message, string fix, JsonArray? patch) => new()
    {
        ["op"] = index, ["pointer"] = pointer, ["code"] = code, ["severity"] = "error",
        ["message"] = message, ["fix"] = fix, ["patch"] = patch,
    };

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static string Escape(string key) => key.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);
}
