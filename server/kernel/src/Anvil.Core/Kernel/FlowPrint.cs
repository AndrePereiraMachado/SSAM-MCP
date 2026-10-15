using System.Text;

namespace Anvil.Reading;

// One action as ssam-flow/1 text, with the table of its short ids (n12 -> model key) and what it could not print (a
// non-empty list means the action is not represented and the text must not be used to write it back).
public sealed record FlowDocument(string Text, IReadOnlyDictionary<string, string> Keys, IReadOnlyList<string> Unprintable);

// The printer: the digest's pseudocode (ModuleDigest) made into a source form. Every element line ends with its id (@n
// nodes, @p parameters, @l locals, the model key for the action itself); descriptions are /// lines above the element,
// texts are whole (a comment, a script or a statement continues on '| ' lines), and every authored property without a
// word of its own goes on an @{...} line under the element. A flow runs from Start in connector order: a node is followed
// by its Target at the same depth; an if's true branch is indented and its false branch continues below it; a foreach
// body is indented and ends in next; every branch ends in end, raise, navigate, next, '-> @id' (a node written elsewhere)
// or '-> (no connector)'. Exception handlers follow, then the nodes no connector reaches (unreached:).
internal sealed class FlowPrinter
{
    public const string Schema = "ssam-flow/1";
    private static readonly Dictionary<string, string> ActionLabels = new(StringComparer.Ordinal) {
        ["ServerAction"] = "server action", ["ServiceAction"] = "service action", ["ClientAction"] = "client action",
        ["ScreenAction"] = "action", ["DataAction"] = "data action" };
    public static IReadOnlyDictionary<string, string> Labels => ActionLabels;
    // Slot terminators (FlowSyntax.Plain): a value is written plain only when reading the slot gives it back whole.
    internal static readonly string[] LabelEnd = ["  # "];
    internal static readonly string[] CallValue = [",", ")"];
    internal static readonly string[] Paren = [")"];
    internal static readonly string[] Colon = [":"];
    internal static readonly string[] Assigned = [" = "];
    internal static readonly string[] ForEachList = [" max ", " start ", ":"];
    internal static readonly string[] ForEachMax = [" start ", ":"];
    internal static readonly string[] RefreshMax = [" start ", "  # "];
    internal static readonly string[] AggregateKeywords = [" JOIN ", " WHERE ", " GROUP BY ", " AGG ", " CALC ", " SORT ", " MAX ", " START ", "  # "];
    internal static readonly string[] JoinCondition = [.. AggregateKeywords, " | "];
    internal static readonly string[] ListValue = [.. AggregateKeywords, ","];
    internal static readonly string[] SortValue = [.. AggregateKeywords, ",", " desc", " dynamic"];
    internal static readonly string[] AggregateMax = [" START ", "  # "];
    internal static readonly string[] SqlMax = ["  # "];

    private readonly FlowItem action;
    private readonly Dictionary<string, FlowItem> nodes = new(StringComparer.Ordinal);
    private readonly List<string> lines = [];
    private readonly Dictionary<string, string> idOf = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> keys = new(StringComparer.Ordinal);
    private readonly HashSet<string> printed = new(StringComparer.Ordinal);
    private readonly List<string> unprintable = [];
    private int nodeIds, parameterIds, localIds;

    // Ids chosen by the caller (model key -> id): an element of another key is written with its key as id. FlowDiff and the
    // battery print an edited action with the ids of the read it edits, so the same element keeps the same id.
    private readonly IReadOnlyDictionary<string, string>? fixedIds;

    private FlowPrinter(FlowItem action, IReadOnlyDictionary<string, string>? fixedIds) { this.action = action; this.fixedIds = fixedIds; }

    public static FlowDocument Print(FlowItem action, IReadOnlyDictionary<string, string>? fixedIds = null)
    {
        var printer = new FlowPrinter(action, fixedIds);
        printer.Write();
        return new(string.Join("\n", printer.lines) + "\n", printer.keys, printer.unprintable);
    }

    private void Write()
    {
        foreach (var item in action.Items.Where(i => i.Role == "node")) {
            if (item.Key.Length == 0 || !nodes.TryAdd(item.Key, item)) unprintable.Add("node without a unique key: " + item.Kind);
        }
        var used = new HashSet<string>(StringComparer.Ordinal);
        if (!ActionLabels.TryGetValue(action.Kind, out var label)) { unprintable.Add("action kind " + action.Kind); label = "action"; }
        if (!FlowSyntax.IsIdentifier(action.Name)) unprintable.Add("action name " + action.Name);
        // A screen, block or data action: its owner before its name (action Home.Save); a module action has none.
        if (action.Owner.Length > 0 && (!FlowOwners.Valid(action.Owner) || !FlowOwners.Owned(action.Kind))) unprintable.Add("action owner " + action.Owner);
        var head = new StringBuilder(label).Append(' ');
        if (action.Owner.Length > 0) head.Append(action.Owner).Append('.');
        head.Append(action.Name);
        if (action.Prop("Public") == "True") { head.Append(" public"); used.Add("Public"); }
        if (action.Prop("Function") == "True") { head.Append(" function"); used.Add("Function"); }
        if (action.Prop("Fetch") is { } fetch && FlowSyntax.Bare(fetch)) { head.Append(" fetch=").Append(fetch); used.Add("Fetch"); }
        Element(action, 0, head.ToString(), used, id: action.Key);
        foreach (var handler in action.Items.Where(i => i.Role == "event")) Event(handler);
        foreach (var parameter in action.Items.Where(i => i.Role is "in" or "out" or "local")) Parameter(parameter, 1, null);
        foreach (var comment in nodes.Values.Where(n => n.Kind == "CommentNode").OrderBy(n => n.Prop("Text") ?? "", StringComparer.Ordinal).ThenBy(n => n.Key, StringComparer.Ordinal))
            Comment(comment);
        var starts = nodes.Values.Where(n => n.Kind == "StartNode").ToList();
        if (starts.Count != 1) unprintable.Add(starts.Count + " Start nodes");
        foreach (var start in starts) {
            printed.Add(start.Key);
            Id(start);
            if (start.Props.Count > 0 || start.Opaque) unprintable.Add("Start node with properties");
            Steps(Edge(start, "Target"), 1, null);
        }
        foreach (var handler in nodes.Values.Where(n => n.Kind == "ExceptionHandlerNode").OrderBy(n => n.Prop("Exception") ?? "", StringComparer.Ordinal).ThenBy(n => n.Key, StringComparer.Ordinal)) {
            printed.Add(handler.Key);
            Handler(handler);
        }
        var rest = nodes.Values.Where(n => !printed.Contains(n.Key) && n.Kind != "CommentNode").ToList();
        if (rest.Count > 0) {
            Line(1, "unreached:");
            while (rest.Count > 0) {
                var pointed = new HashSet<string>(rest.SelectMany(n => n.Edges.Values.Concat(n.Items.SelectMany(i => i.Edges.Values))), StringComparer.Ordinal);
                var root = rest.Where(n => !pointed.Contains(n.Key)).OrderBy(n => n.Key, StringComparer.Ordinal).FirstOrDefault()
                    ?? rest.OrderBy(n => n.Key, StringComparer.Ordinal).First();
                Steps(root.Key, 2, null);
                rest = rest.Where(n => !printed.Contains(n.Key)).ToList();
            }
        }
    }

    private string Id(FlowItem item)
    {
        if (item.Role == "action") return item.Key;
        if (idOf.TryGetValue(item.Key, out var id)) return id;
        // The Start node is always "start" (a comment attached to it names it so): one id per element, one element per id.
        if (item.Role == "node" && item.Kind == "StartNode" && !keys.ContainsKey("start")) id = "start";
        else if (fixedIds != null) {
            id = fixedIds.TryGetValue(item.Key, out var chosen) ? chosen : item.Key;
            if (!FlowSyntax.IsKeyToken(id)) unprintable.Add("element id " + id);
        }
        else id = item.Role switch { "node" => "n" + ++nodeIds, "local" => "l" + ++localIds, _ => "p" + ++parameterIds };
        idOf[item.Key] = id; keys[id] = item.Key;
        return id;
    }

    private void Line(int depth, string text) => lines.Add(new string(' ', depth * 2) + text);

    // The element's description lines, its line ending in its id, then its @{...} line with what nothing else wrote.
    private void Element(FlowItem item, int depth, string content, HashSet<string> used, string? id = null, bool nameWritten = true)
    {
        if (item.Prop("Description") is { } description && FlowSyntax.Lines(description)) {
            foreach (var line in description.Split('\n')) Line(depth, line.Length == 0 ? "///" : "/// " + line);
            used.Add("Description");
        }
        var written = id ?? Id(item);
        // A new action (no key yet) has a header without one.
        Line(depth, written.Length > 0 ? content + " @" + written : content);
        Passthrough(item, depth + 1, used, nameWritten);
    }

    private void Passthrough(FlowItem item, int depth, HashSet<string> used, bool nameWritten = true)
    {
        var rest = item.Props.Where(p => !used.Contains(p.Key)).ToList();
        if (!nameWritten) rest.Insert(0, new("Name", new('t', item.Name)));
        if (rest.Count > 0) Line(depth, FlowSyntax.Passthrough(rest));
    }

    private string LabelOf(FlowItem item, HashSet<string> used)
    {
        if (item.Prop("Label") is not { } label || FlowSyntax.HasBreaks(label)) return "";
        used.Add("Label");
        return "  # " + label;
    }

    private string? Edge(FlowItem node, string edge)
    {
        if (node.Edges.TryGetValue(edge, out var target)) return target;
        unprintable.Add(node.Kind + " without " + edge);
        return "";
    }

    private void Event(FlowItem handler)
    {
        var used = new HashSet<string>(StringComparer.Ordinal) { "Destination" };
        if (!handler.Name.StartsWith("On", StringComparison.Ordinal) || handler.Name.Length < 3 || !FlowSyntax.IsIdentifier(handler.Name)) unprintable.Add("event " + handler.Name);
        if (handler.Prop("Destination") is not { } destination || !IsCallee(destination)) { unprintable.Add("event without a plain destination"); destination = "?"; }
        if (handler.Props.Keys.Any(p => !used.Contains(p))) unprintable.Add("event property " + string.Join(",", handler.Props.Keys));
        Line(1, "on " + handler.Name[2..] + " -> " + destination + Arguments(handler));
    }

    // in Name?: Type = default @p1 (a node's own parameters: the value is the argument the node passes; SQL adds inline).
    private void Parameter(FlowItem parameter, int depth, FlowItem? node)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        if (!FlowSyntax.IsIdentifier(parameter.Name)) unprintable.Add("parameter name " + parameter.Name);
        var text = new StringBuilder(parameter.Role).Append(' ').Append(parameter.Name);
        if (parameter.Role == "in" && parameter.Prop("IsMandatory") == "False") { text.Append('?'); used.Add("IsMandatory"); }
        if (parameter.Prop("DataType") is { } type && PlainType(type, node?.Kind == "SQLNode")) { text.Append(": ").Append(type); used.Add("DataType"); }
        if (node?.Kind == "SQLNode" && parameter.Prop("ExpandInline") == "True") { text.Append(" inline"); used.Add("ExpandInline"); }
        if (node == null) {
            if (parameter.Prop("DefaultValue") is { } value) { text.Append(" = ").Append(FlowSyntax.Expr(value, [])); used.Add("DefaultValue"); }
        } else if (node.Items.FirstOrDefault(i => i.Role == "argument" && i.Name == parameter.Name) is { } argument) {
            if (argument.Props.Keys.Any(k => k != "Value")) unprintable.Add("argument property " + string.Join(",", argument.Props.Keys));
            text.Append(" = ").Append(FlowSyntax.Expr(argument.Prop("Value") ?? "", []));
        }
        Element(parameter, depth, text.ToString(), used);
    }

    private static bool PlainType(string type, bool sql) =>
        type.Length > 0 && !FlowSyntax.HasBreaks(type) && !char.IsWhiteSpace(type[0]) && !char.IsWhiteSpace(type[^1])
        && !type.Contains(" = ", StringComparison.Ordinal) && !type.Contains(" @", StringComparison.Ordinal) && !type.Contains("  # ", StringComparison.Ordinal)
        && !(sql && type.EndsWith(" inline", StringComparison.Ordinal));

    private void Comment(FlowItem comment)
    {
        printed.Add(comment.Key);
        if (comment.Opaque) unprintable.Add("opaque comment");
        var used = new HashSet<string>(StringComparer.Ordinal);
        var text = comment.Prop("Text") ?? "";
        var printable = FlowSyntax.Lines(text);
        if (printable) used.Add("Text");
        var parts = printable ? text.Split('\n') : [""];
        var head = comment.Edges.TryGetValue("Attached", out var attached) && nodes.TryGetValue(attached, out var target) ? "//-> @" + Id(target) + " " : "// ";
        if (comment.Edges.Keys.Any(e => e != "Attached") || comment.Edges.TryGetValue("Attached", out var at) && !nodes.ContainsKey(at)) unprintable.Add("comment edges");
        Element(comment, 1, head + parts[0], used);
        foreach (var line in parts.Skip(1)) Line(2, line.Length == 0 ? "|" : "| " + line);
    }

    private void Handler(FlowItem handler)
    {
        if (handler.Opaque) unprintable.Add("opaque exception handler");
        var used = new HashSet<string>(StringComparer.Ordinal) { "Exception", "AbortTransaction", "LogError" };
        var exception = handler.Prop("Exception") ?? "";
        if (exception.Length == 0 || exception.Contains(':') || FlowSyntax.HasBreaks(exception) || exception.EndsWith(" abort", StringComparison.Ordinal)
            || exception.EndsWith(" log", StringComparison.Ordinal) || char.IsWhiteSpace(exception[0]) || char.IsWhiteSpace(exception[^1]))
            unprintable.Add("exception name " + exception);
        var text = "on exception " + exception + (handler.Prop("AbortTransaction") != "False" ? " abort" : "") + (handler.Prop("LogError") != "False" ? " log" : "")
            + ":" + LabelOf(handler, used);
        Element(handler, 1, text, used, nameWritten: handler.Name.Length == 0);
        Steps(Edge(handler, "Target"), 2, null);
    }

    // ---- the flow -----------------------------------------------------------------------------------------------------

    private void Steps(string? key, int depth, string? stop)
    {
        while (true) {
            if (string.IsNullOrEmpty(key)) { Line(depth, "-> (no connector)"); return; }
            if (key == stop) { Line(depth, "next"); return; }
            if (!nodes.TryGetValue(key, out var node)) { unprintable.Add("connector to an unknown node"); Line(depth, "-> (no connector)"); return; }
            if (node.Kind == "EndNode") { End(node, depth); return; }
            if (!printed.Add(key)) {
                if (node.Kind is "StartNode" or "CommentNode" or "ExceptionHandlerNode") unprintable.Add("connector to a " + node.Kind);
                Line(depth, "-> @" + Id(node));
                return;
            }
            if (node.Opaque) {
                if (!Opaque(node, depth)) return;
                key = Edge(node, "Target");
                continue;
            }
            switch (node.Kind) {
                case "IfNode": {
                    var used = new HashSet<string>(StringComparer.Ordinal) { "Condition" };
                    Element(node, depth, "if " + FlowSyntax.Expr(node.Prop("Condition") ?? "", Colon) + ":" + LabelOf(node, used), used, nameWritten: node.Name.Length == 0);
                    Steps(Edge(node, "TrueTarget"), depth + 1, stop);
                    key = Edge(node, "FalseTarget");
                    continue;
                }
                case "SwitchNode": {
                    var used = new HashSet<string>(StringComparer.Ordinal);
                    Element(node, depth, "switch:" + LabelOf(node, used), used, nameWritten: node.Name.Length == 0);
                    foreach (var branch in node.Items.Where(i => i.Role == "case")) {
                        if (branch.Props.Keys.Any(k => k != "Value")) unprintable.Add("case property");
                        Line(depth + 1, "case " + FlowSyntax.Expr(branch.Prop("Value") ?? "", []) + ":");
                        Steps(branch.Edges.GetValueOrDefault("Target"), depth + 2, stop);
                    }
                    Line(depth + 1, "otherwise:");
                    Steps(Edge(node, "OtherwiseTarget"), depth + 2, stop);
                    Parts(node, "case");
                    return;
                }
                case "ForEachNode": {
                    var used = new HashSet<string>(StringComparer.Ordinal) { "RecordList" };
                    var text = new StringBuilder("foreach ").Append(FlowSyntax.Expr(node.Prop("RecordList") ?? "", ForEachList));
                    if (node.Prop("MaximumIterations") is { } maximum) { text.Append(" max ").Append(FlowSyntax.Expr(maximum, ForEachMax)); used.Add("MaximumIterations"); }
                    if (node.Prop("StartIndex") is { } start) { text.Append(" start ").Append(FlowSyntax.Expr(start, Colon)); used.Add("StartIndex"); }
                    Element(node, depth, text.Append(':').Append(LabelOf(node, used)).ToString(), used, nameWritten: node.Name.Length == 0);
                    Steps(Edge(node, "CycleTarget"), depth + 1, key);
                    key = Edge(node, "Target");
                    continue;
                }
            }
            if (!Simple(node, depth)) return;
            key = Edge(node, "Target");
        }
    }

    // An opaque node: its name, kind and connector only ("X = opaque Kind", " end" when it has no Target). Only a node with
    // one Target (or none) has a place in the flow; an opaque branching node leaves the action unprintable.
    private bool Opaque(FlowItem node, int depth)
    {
        if (node.Edges.Keys.Any(e => e != "Target")) unprintable.Add("opaque " + node.Kind + " with connectors " + string.Join(",", node.Edges.Keys));
        if (!FlowSyntax.IsIdentifier(node.Kind)) unprintable.Add("node kind " + node.Kind);
        var terminal = !node.Edges.ContainsKey("Target");
        var text = (FlowSyntax.IsIdentifier(node.Name) ? node.Name + " = " : "") + "opaque " + node.Kind + (terminal ? " end" : "");
        Element(node, depth, text, [], nameWritten: node.Name.Length == 0 || FlowSyntax.IsIdentifier(node.Name));
        return !terminal;
    }

    private void End(FlowItem node, int depth)
    {
        if (!printed.Add(node.Key)) { Line(depth, "end @" + Id(node)); return; }
        if (node.Opaque) unprintable.Add("opaque end");
        var used = new HashSet<string>(StringComparer.Ordinal);
        Element(node, depth, "end" + LabelOf(node, used), used, nameWritten: node.Name.Length == 0);
        if (node.Edges.Count > 0) unprintable.Add("End with connectors");
    }

    // A node that continues to its Target; false when it ends the branch (raise, navigate, a terminal generic node).
    private bool Simple(FlowItem node, int depth)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var named = true;
        string Named(string head)
        {
            if (FlowSyntax.IsIdentifier(node.Name)) return node.Name + " = " + head;
            named = node.Name.Length == 0;
            return head;
        }
        string text;
        var terminal = false;
        switch (node.Kind) {
            case "AssignNode": {
                // One assignment: on the node's line (assign X = Y  # label); more: one per line under it.
                var assignments = node.Items.Where(i => i.Role == "assignment").ToList();
                foreach (var assignment in assignments)
                    if (assignment.Props.Keys.Any(k => k is not ("Variable" or "Value"))) unprintable.Add("assignment property");
                string Assignment(FlowItem a, string[] end) => FlowSyntax.Expr(a.Prop("Variable") ?? "", Assigned) + " = " + FlowSyntax.Expr(a.Prop("Value") ?? "", end);
                if (assignments.Count == 1) Element(node, depth, "assign " + Assignment(assignments[0], LabelEnd) + LabelOf(node, used), used, nameWritten: node.Name.Length == 0);
                else {
                    Element(node, depth, "assign" + LabelOf(node, used), used, nameWritten: node.Name.Length == 0);
                    foreach (var assignment in assignments) Line(depth + 1, Assignment(assignment, []));
                }
                Parts(node, "assignment");
                return Continues(node, true);
            }
            case "Execute": {
                used.Add("Action");
                var callee = node.Prop("Action") ?? "";
                if (!IsCallee(callee)) unprintable.Add("callee " + callee);
                var simple = callee[(callee.LastIndexOf('.') + 1)..];
                text = (node.Name == simple ? "" : FlowSyntax.IsIdentifier(node.Name) ? node.Name + " = " : "") + callee + Arguments(node) + LabelOf(node, used);
                named = node.Name == simple || FlowSyntax.IsIdentifier(node.Name);
                Element(node, depth, text, used, nameWritten: named);
                Parts(node, "argument");
                return Continues(node, true);
            }
            case "AggregateNode": text = Named(Query(node, used)); break;
            case "SQLNode": {
                used.Add("Statement");
                var head = new StringBuilder("sql");
                var outputs = node.Items.Where(i => i.Role == "output").Select(o => {
                    if (o.Props.Keys.Any(k => k != "EntityOrStructure")) unprintable.Add("SQL output property");
                    var name = o.Prop("EntityOrStructure") ?? "";
                    if (!IsCallee(name)) unprintable.Add("SQL output " + name);
                    return name;
                }).ToList();
                if (outputs.Count > 0) head.Append(" -> ").Append(string.Join(", ", outputs));
                if (node.Prop("MaxRecords") is { } max) { head.Append(" max ").Append(FlowSyntax.Expr(max, SqlMax)); used.Add("MaxRecords"); }
                var statement = node.Prop("Statement") ?? "";
                if (!FlowSyntax.Lines(statement)) used.Remove("Statement");
                Element(node, depth, Named(head.ToString()) + LabelOf(node, used), used, nameWritten: named);
                foreach (var parameter in node.Items.Where(i => i.Role == "in")) Parameter(parameter, depth + 1, node);
                Code(statement, depth + 1, used.Contains("Statement"));
                Parts(node, "output", "in", "argument");
                CheckArguments(node);
                return Continues(node, true);
            }
            case "JavaScriptNode": {
                used.Add("JavaScript");
                var script = node.Prop("JavaScript") ?? "";
                if (!FlowSyntax.Lines(script)) used.Remove("JavaScript");
                Element(node, depth, Named("javascript") + LabelOf(node, used), used, nameWritten: named);
                foreach (var parameter in node.Items.Where(i => i.Role is "in" or "out")) Parameter(parameter, depth + 1, node);
                Code(script, depth + 1, used.Contains("JavaScript"));
                Parts(node, "in", "out", "argument");
                CheckArguments(node);
                return Continues(node, true);
            }
            case "JSONSerializeNode":
                used.Add("Data");
                text = Named("JSONSerialize(" + FlowSyntax.Expr(node.Prop("Data") ?? "", Paren) + ")");
                break;
            case "JSONDeserializeNode": {
                used.Add("JSONString");
                var head = "JSONDeserialize(" + FlowSyntax.Expr(node.Prop("JSONString") ?? "", Paren) + ")";
                if (node.Prop("DataType") is { } type && PlainType(type, false)) { head += " as " + type; used.Add("DataType"); }
                text = Named(head);
                break;
            }
            case "RaiseExceptionNode": {
                used.Add("Exception"); used.Add("ExceptionMessage");
                var exception = node.Prop("Exception") ?? "";
                if (exception.Length == 0 || exception.Contains('(') || FlowSyntax.HasBreaks(exception) || char.IsWhiteSpace(exception[0]) || char.IsWhiteSpace(exception[^1]))
                    unprintable.Add("exception name " + exception);
                text = "raise " + exception + "(" + (node.Prop("ExceptionMessage") is { } message ? FlowSyntax.Expr(message, Paren) : "") + ")";
                named = node.Name.Length == 0;
                terminal = true;
                break;
            }
            case "DestinationNode": {
                used.Add("Destination");
                var destination = node.Prop("Destination") ?? "";
                if (!IsCallee(destination)) unprintable.Add("destination " + destination);
                text = "navigate " + destination + Arguments(node);
                named = node.Name.Length == 0;
                terminal = true;
                break;
            }
            case "RefreshDataNode": {
                used.Add("DataSource");
                var source = node.Prop("DataSource") ?? "";
                if (!IsCallee(source)) unprintable.Add("data source " + source);
                var head = new StringBuilder("refresh ").Append(source);
                if (node.Prop("MaxRecords") is { } max) { head.Append(" max ").Append(FlowSyntax.Expr(max, RefreshMax)); used.Add("MaxRecords"); }
                if (node.Prop("StartIndex") is { } start) { head.Append(" start ").Append(FlowSyntax.Expr(start, LabelEnd)); used.Add("StartIndex"); }
                text = head.ToString();
                named = node.Name.Length == 0;
                break;
            }
            case "MessageNode": {
                used.Add("Type"); used.Add("Message");
                var type = node.Prop("Type") ?? "";
                if (!FlowSyntax.Bare(type)) unprintable.Add("message type " + type);
                text = "message " + type + ": " + FlowSyntax.Expr(node.Prop("Message") ?? "", LabelEnd);
                named = node.Name.Length == 0;
                break;
            }
            case "TriggerNode": {
                used.Add("Event");
                var target = node.Prop("Event") ?? "";
                if (!IsCallee(target)) unprintable.Add("event " + target);
                text = "trigger " + target + Arguments(node);
                named = node.Name.Length == 0;
                break;
            }
            default: {
                if (!FlowSyntax.IsIdentifier(node.Kind)) unprintable.Add("node kind " + node.Kind);
                terminal = !node.Edges.ContainsKey("Target");
                text = Named("node " + node.Kind + Arguments(node)) + (terminal ? " end" : "");
                if (node.Edges.Keys.Any(e => e != "Target")) unprintable.Add(node.Kind + " connectors " + string.Join(",", node.Edges.Keys));
                break;
            }
        }
        Element(node, depth, text + LabelOf(node, used), used, nameWritten: named);
        if (node.Kind != "AggregateNode") Parts(node, "argument");
        return Continues(node, !terminal);
    }

    // A non-terminal node must have a Target; a terminal one must not.
    private bool Continues(FlowItem node, bool continues)
    {
        if (continues != node.Edges.ContainsKey("Target")) unprintable.Add(node.Kind + (continues ? " without Target" : " with Target"));
        return continues;
    }

    // Parts a node printer did not write make the action unprintable.
    private void Parts(FlowItem node, params string[] written)
    {
        foreach (var part in node.Items.Where(i => !written.Contains(i.Role))) unprintable.Add(node.Kind + " part " + part.Role);
    }

    // Every argument of a SQL or JavaScript node binds one of its parameters.
    private void CheckArguments(FlowItem node)
    {
        foreach (var argument in node.Items.Where(i => i.Role == "argument"))
            if (!node.Items.Any(i => i.Role == "in" && i.Name == argument.Name)) unprintable.Add("argument without parameter " + argument.Name);
    }

    private void Code(string text, int depth, bool plain)
    {
        if (!plain || text.Length == 0) return;
        foreach (var line in text.Split('\n')) Line(depth, line.Length == 0 ? "|" : "| " + line);
    }

    // (P=value, Q) ordered by parameter; a bare name passes the variable of the same name. Empty arguments are not written.
    private string Arguments(FlowItem node)
    {
        var parts = new List<string>();
        foreach (var argument in node.Items.Where(i => i.Role == "argument").OrderBy(i => i.Name, StringComparer.Ordinal)) {
            if (!FlowSyntax.IsIdentifier(argument.Name)) unprintable.Add("argument name " + argument.Name);
            if (argument.Props.Keys.Any(k => k != "Value")) unprintable.Add("argument property " + string.Join(",", argument.Props.Keys));
            var value = argument.Prop("Value") ?? "";
            parts.Add(value == argument.Name ? value : argument.Name + "=" + FlowSyntax.Expr(value, CallValue));
        }
        return "(" + string.Join(", ", parts) + ")";
    }

    // FROM/JOIN/WHERE/GROUP BY/AGG/CALC/SORT/MAX/START of an aggregate, the digest's one line. Sets in text order (they are
    // sets in the model too); sorts in the model's order.
    private string Query(FlowItem node, HashSet<string> used)
    {
        string Name(string? text) { if (text == null || !IsCallee(text)) unprintable.Add("aggregate name " + text); return text ?? "?"; }
        void Only(FlowItem part, params string[] properties) { if (part.Props.Keys.Any(k => !properties.Contains(k))) unprintable.Add(part.Role + " property " + string.Join(",", part.Props.Keys)); }
        var sources = node.Items.Where(i => i.Role == "source").Select(s => {
            Only(s, "Source");
            var entity = Name(s.Prop("Source"));
            if (!FlowSyntax.IsIdentifier(s.Name)) unprintable.Add("source alias " + s.Name);
            return s.Name == entity ? entity : s.Name + "=" + entity;
        }).Order(StringComparer.Ordinal).ToList();
        var text = new StringBuilder("aggregate FROM ").Append(string.Join(", ", sources));
        var joins = node.Items.Where(i => i.Role == "join").Select(j => {
            Only(j, "JoinType", "LeftSource", "RightSource", "Condition");
            var type = j.Prop("JoinType") ?? "";
            if (!FlowSyntax.Bare(type)) unprintable.Add("join type " + type);
            return type + " " + Name(j.Prop("LeftSource")) + "~" + Name(j.Prop("RightSource")) + " ON " + FlowSyntax.Expr(j.Prop("Condition") ?? "", JoinCondition);
        }).Order(StringComparer.Ordinal).ToList();
        if (joins.Count > 0) text.Append(" JOIN ").Append(string.Join(" | ", joins));
        var filters = node.Items.Where(i => i.Role == "filter").Select(f => { Only(f, "Condition"); return "(" + FlowSyntax.Expr(f.Prop("Condition") ?? "", Paren) + ")"; })
            .Order(StringComparer.Ordinal).ToList();
        if (filters.Count > 0) text.Append(" WHERE ").Append(string.Join(" AND ", filters));
        var groups = node.Items.Where(i => i.Role == "group").Select(g => {
            Only(g, "Attribute");
            // A group column is named after its attribute (the last name of Entity.Attribute); another name is written Name=.
            var attribute = g.Prop("Attribute") ?? "";
            var named = g.Name != GroupName(attribute);
            if (named && !FlowSyntax.IsIdentifier(g.Name)) unprintable.Add("group column name " + g.Name);
            var value = !named && NamedPrefix.IsMatch(attribute) ? FlowSyntax.Escape(attribute) : FlowSyntax.Expr(attribute, ListValue);
            return (named ? g.Name + "=" : "") + value;
        }).Order(StringComparer.Ordinal).ToList();
        if (groups.Count > 0) text.Append(" GROUP BY ").Append(string.Join(", ", groups));
        var aggregates = node.Items.Where(i => i.Role == "agg").Select(a => {
            Only(a, "AggregationType", "Attribute");
            if (!FlowSyntax.IsIdentifier(a.Name)) unprintable.Add("column name " + a.Name);
            var function = a.Prop("AggregationType") ?? "";
            if (!FlowSyntax.IsIdentifier(function)) unprintable.Add("aggregation " + function);
            return a.Name + "=" + function + "(" + FlowSyntax.Expr(a.Prop("Attribute") ?? "", Paren) + ")";
        }).Order(StringComparer.Ordinal).ToList();
        if (aggregates.Count > 0) text.Append(" AGG ").Append(string.Join(", ", aggregates));
        var calculated = node.Items.Where(i => i.Role == "calc").Select(c => {
            Only(c, "Value");
            if (!FlowSyntax.IsIdentifier(c.Name)) unprintable.Add("column name " + c.Name);
            return c.Name + "=" + FlowSyntax.Expr(c.Prop("Value") ?? "", ListValue);
        }).Order(StringComparer.Ordinal).ToList();
        if (calculated.Count > 0) text.Append(" CALC ").Append(string.Join(", ", calculated));
        var sorts = node.Items.Where(i => i.Role == "sort").Select(s => {
            Only(s, "Attribute", "SortDirection", "IsDynamic");
            var direction = s.Prop("SortDirection");
            if (direction is not (null or "Descending")) unprintable.Add("sort direction " + direction);
            return FlowSyntax.Expr(s.Prop("Attribute") ?? "", SortValue) + (direction == "Descending" ? " desc" : "") + (s.Prop("IsDynamic") == "True" ? " dynamic" : "");
        }).ToList();
        if (sorts.Count > 0) text.Append(" SORT ").Append(string.Join(", ", sorts));
        if (node.Prop("MaxRecords") is { } max) { text.Append(" MAX ").Append(FlowSyntax.Expr(max, AggregateMax)); used.Add("MaxRecords"); }
        if (node.Prop("StartIndex") is { } start) { text.Append(" START ").Append(FlowSyntax.Expr(start, LabelEnd)); used.Add("StartIndex"); }
        Parts(node, "source", "join", "filter", "group", "agg", "calc", "sort");
        return text.ToString();
    }

    private static readonly System.Text.RegularExpressions.Regex NamedPrefix = new("^[A-Za-z_][A-Za-z0-9_]*=", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex DottedName = new(@"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // The name a group column takes from its attribute: the last name of a dotted path ("Order.CustomerId" -> CustomerId).
    internal static string GroupName(string attribute) => DottedName.IsMatch(attribute) ? attribute[(attribute.LastIndexOf('.') + 1)..] : "";

    // A name the text writes bare: identifiers joined by dots, a producer like "(System)." in front.
    internal static bool IsCallee(string text)
    {
        var rest = text.StartsWith("(System).", StringComparison.Ordinal) ? text["(System).".Length..] : text;
        return rest.Length > 0 && rest.Split('.').All(FlowSyntax.IsIdentifier);
    }
}
