using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>A node of a logic action that expressions can read by name: an aggregate (`get`), a SQL query (`get` with
/// sql), an action call (`call`), an entity action (save/create/update/delete) or any other named step.</summary>
public sealed record NodeFact(string Name, string Kind, JsonObject Step, string Pointer)
{
    public string? Target => Step["call"]?.ToString();
    /// <summary>The sources of an aggregate: its entity and the extra `sources`.</summary>
    public IReadOnlyList<string> Sources => Kind != "aggregate" ? [] : new[] { Step["get"]!.ToString() }
        .Concat(Many(Step["sources"])).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    /// <summary>Group-by and aggregation columns (an aggregate with them returns only them and the calculated ones).</summary>
    public IReadOnlyList<string> Columns => Names(Step["columns"]);
    public IReadOnlyList<string> Calculated => Names(Step["calculated"]);

    private static IReadOnlyList<string> Names(JsonNode? node) => (node as JsonArray ?? new JsonArray()).OfType<JsonObject>()
        .Select(c => c["name"]?.ToString()).OfType<string>().ToArray();
    internal static IEnumerable<string> Many(JsonNode? n) => n switch
    {
        JsonArray a => a.OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var s) ? s : null).OfType<string>(),
        JsonValue v when v.TryGetValue<string>(out var s) => [s],
        _ => [],
    };
}

/// <summary>One OutSystems expression of a logic step: its text, the JSON pointer relative to the action, the step and
/// the aggregate whose filter, sort, join or column it is (null elsewhere).</summary>
public sealed record ExpressionSite(string Text, string Pointer, JsonObject Step, string Key, NodeFact? Aggregate);

/// <summary>A `call` step: the target, its args and where it is (relative to the action).</summary>
public sealed record CallSite(string Target, JsonObject Step, string Pointer);

/// <summary>
/// The logic grammar read for the preflight rules: every node an expression can name, every expression with its pointer
/// (more keys than LogicLint reads: the filters, sorts, joins, columns and calculated values of aggregates too), and every
/// call. Pointers are relative to the action (`/steps/2/then/0/args/Id`); JavaScript and SQL statements are not
/// expressions of the language and are never read.
/// </summary>
public sealed class LogicScan
{
    public Dictionary<string, NodeFact> Nodes { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<ExpressionSite> Expressions { get; } = [];
    public List<CallSite> Calls { get; } = [];
    /// <summary>The exceptions the action's handlers catch (their names are roots of handler expressions).</summary>
    public HashSet<string> HandledExceptions { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<(JsonObject Step, string Pointer)> Steps { get; } = [];

    public static LogicScan Of(JsonObject action)
    {
        var scan = new LogicScan();
        if (action["steps"] is JsonArray steps) scan.Walk(steps, "/steps");
        for (var h = 0; h < (action["handlers"] as JsonArray)?.Count; h++)
            if (action["handlers"]![h] is JsonObject handler)
            {
                if (handler["exception"]?.ToString() is { Length: > 0 } exception) scan.HandledExceptions.Add(exception.Split(':').Last().Replace(" ", ""));
                if (handler["name"]?.ToString() is { Length: > 0 } handlerName) scan.Nodes.TryAdd(handlerName, new NodeFact(handlerName, "handler", handler, $"/handlers/{h}"));
                if (handler["steps"] is JsonArray handlerSteps) scan.Walk(handlerSteps, $"/handlers/{h}/steps");
            }
        return scan;
    }

    private static string Escape(string key) => key.Replace("~", "~0").Replace("/", "~1");

    private void Walk(JsonArray steps, string path)
    {
        for (var s = 0; s < steps.Count; s++)
        {
            if (steps[s] is not JsonObject step) continue;
            var at = path + "/" + s;
            Steps.Add((step, at));
            var name = step["as"] is JsonValue a && a.TryGetValue<string>(out var alias) ? alias : null;
            if (step["get"] is JsonValue)
            {
                var sql = step["sql"] is JsonValue sv && sv.TryGetValue<bool>(out var isSql) && isSql;
                NodeFact? node = name == null ? null : new NodeFact(name, sql ? "sql" : "aggregate", step, at);
                if (node != null) Nodes.TryAdd(name!, node);
                var aggregate = sql ? null : node ?? new NodeFact(step["get"]!.ToString(), "aggregate", step, at);
                if (sql)
                {
                    if (step["params"] is JsonObject parameters)
                        foreach (var (key, value) in parameters) Text(value?["value"], $"{at}/params/{Escape(key)}/value", step, key, null);
                }
                else
                {
                    Texts(step["where"], at + "/where", step, "where", aggregate);
                    Sorts(step["sort"], at + "/sort", step, aggregate);
                    for (var j = 0; j < (step["joins"] as JsonArray)?.Count; j++) Text(step["joins"]![j]?["condition"], $"{at}/joins/{j}/condition", step, "condition", aggregate);
                    for (var c = 0; c < (step["columns"] as JsonArray)?.Count; c++) Text(step["columns"]![c]?["attribute"], $"{at}/columns/{c}/attribute", step, "attribute", aggregate);
                    for (var c = 0; c < (step["calculated"] as JsonArray)?.Count; c++) Text(step["calculated"]![c]?["value"], $"{at}/calculated/{c}/value", step, "value", aggregate);
                }
                Text(step["max"], at + "/max", step, "max", null);
                Text(step["start"], at + "/start", step, "start", null);
            }
            else if (step["call"] is JsonValue call && call.TryGetValue<string>(out var target))
            {
                if (name != null) Nodes.TryAdd(name, new NodeFact(name, "call", step, at));
                Calls.Add(new CallSite(target, step, at));
                if (step["args"] is JsonObject args) foreach (var (key, value) in args) Text(value, $"{at}/args/{Escape(key)}", step, key, null);
            }
            else if (step["assign"] is JsonObject pairs)
            {
                if (name != null) Nodes.TryAdd(name, new NodeFact(name, "assign", step, at));
                foreach (var (key, value) in pairs) Text(value, $"{at}/assign/{Escape(key)}", step, key, null);
            }
            else if (new[] { "save", "create", "update", "delete" }.FirstOrDefault(step.ContainsKey) is { } verb && step[verb] is JsonValue entity)
            {
                var prefix = verb switch { "save" => "CreateOrUpdate", "create" => "Create", "update" => "Update", _ => "Delete" };
                var nodeName = name ?? prefix + entity;
                Nodes.TryAdd(nodeName, new NodeFact(nodeName, "entity", step, at));
                // C18: a record given as fields carries one expression per field.
                if (step["record"] is JsonObject fields) foreach (var (key, value) in fields) Text(value, $"{at}/record/{Escape(key)}", step, key, null);
                else Text(step["record"], at + "/record", step, "record", null);
                Text(step["id"], at + "/id", step, "id", null);
            }
            else
            {
                if (name != null) Nodes.TryAdd(name, new NodeFact(name, step["node"] is JsonValue ? "node" : "control", step, at));
                foreach (var key in new[] { "if", "while", "foreach", "start", "max", "message" }) Text(step[key], $"{at}/{key}", step, key, null);
                // Only the properties the node declares as expressions are expressions (LogicNodes.Shapes): a reference
                // ("IAgent:Support", "IMobileScreen:Home"), an enum, a data type or a text is never read as one. A node or
                // property the lane does not declare is refused whole by the logic compiler, not judged here.
                if (step["node"] is JsonValue nodeKind && LogicNodes.Shapes.TryGetValue(nodeKind.ToString(), out var shape) && step["properties"] is JsonObject properties)
                    foreach (var (key, value) in properties)
                        if (shape.Fields.TryGetValue(key, out var field) && field.Kind == "expression")
                            Text(value, $"{at}/properties/{Escape(key)}", step, key, null);
                if (step["node"] is JsonValue && step["args"] is JsonObject nodeArgs) foreach (var (key, value) in nodeArgs) Text(value, $"{at}/args/{Escape(key)}", step, key, null);
            }
            foreach (var key in new[] { "then", "else", "do", "next", "otherwise" })
                if (step[key] is JsonArray nested) Walk(nested, $"{at}/{key}");
            if (step["switch"] is JsonArray cases)
                for (var c = 0; c < cases.Count; c++)
                    if (cases[c] is JsonObject branch)
                    {
                        Text(branch["when"], $"{at}/switch/{c}/when", step, "when", null);
                        if (branch["steps"] is JsonArray branchSteps) Walk(branchSteps, $"{at}/switch/{c}/steps");
                    }
        }
    }

    private static readonly System.Text.RegularExpressions.Regex Direction = new(@"^\s*-?\s*|\s+(?:asc|desc|ascending|descending)\s*$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>The attributes of a sort, in any of its forms (text, list of texts, list of {by, desc}); a direction word is
    /// not an expression, and the direction written around an attribute ('-X', 'X DESC') is not part of it.</summary>
    private void Sorts(JsonNode? node, string pointer, JsonObject step, NodeFact? aggregate)
    {
        void One(JsonNode? item, string at)
        {
            if (item is JsonObject o) { One(o["by"], at + "/by"); return; }
            if (item is not JsonValue v || !v.TryGetValue<string>(out var text)) return;
            if (text.Trim().ToLowerInvariant() is "asc" or "desc" or "ascending" or "descending") return;
            var attribute = Direction.Replace(text, "");
            if (attribute.Length > 0) Expressions.Add(new ExpressionSite(attribute, at, step, "sort", aggregate));
        }
        if (node is JsonArray list) for (var k = 0; k < list.Count; k++) One(list[k], pointer + "/" + k);
        else One(node, pointer);
    }

    private void Texts(JsonNode? node, string pointer, JsonObject step, string key, NodeFact? aggregate)
    {
        if (node is JsonArray list) { for (var k = 0; k < list.Count; k++) Text(list[k], pointer + "/" + k, step, key, aggregate); }
        else Text(node, pointer, step, key, aggregate);
    }

    private void Text(JsonNode? node, string pointer, JsonObject step, string key, NodeFact? aggregate)
    {
        if (node is JsonValue v && v.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)) Expressions.Add(new ExpressionSite(text, pointer, step, key, aggregate));
    }
}
