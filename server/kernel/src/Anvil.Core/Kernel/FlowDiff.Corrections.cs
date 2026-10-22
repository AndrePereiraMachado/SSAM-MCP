using System.Text.RegularExpressions;

namespace Anvil.Reading;

// The certain fixes of an edited text (the owner's rule "one refusal with every problem, each with a verified patch when the
// fix is certain"). Three rules write a fix into the text the model sent, never into the model:
//  - T1/T2 (FLOW_FOREACH_LIST_ACTION): the foreach block becomes the List action of the problem's patch;
//  - decision 6 (FLOW_JAVASCRIPT_NOT_ISOLATED): a new JavaScript node of a client flow that does more than run it moves into a
//    new client action of its own (only that script, its inputs and outputs copied through), called where the node was;
//  - T3 (QUERY_IN_LOOP), in a server flow: an aggregate a new loop runs per item is read once before the loop (the filters
//    that do not depend on the item) and looked up inside it with ListFilter (the ones that do).
// Every fix of a text is applied to the text at once, and the result is checked before it is offered: it parses, its own
// diff (same read, same rules) has none of the problems it fixes and no problem the text did not have, and each new action
// text parses and has no problem at all. A fix that fails the check alone is dropped (its problem keeps its fix sentence);
// the ones that pass go together. The problems a check accepts carry the corrected text (Corrected) and the new texts
// (Added); the op builds the patch of the job from them (FlowTextForm.Patch).
public sealed partial class FlowDiff
{
    private readonly string? editedText;
    private readonly Func<string, bool>? actionTaken;
    private readonly bool allowQueryInLoop;
    private readonly bool correct;
    private readonly IFlowTypes? types;
    private FlowItem? restoredFrom;
    private IReadOnlySet<string>? rewritten;
    private readonly List<BlockFix> corrections = [];
    private readonly HashSet<string> generatedNodeNames = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> generatedActionNames = new(StringComparer.OrdinalIgnoreCase);

    // A fix: the block of the node NodeKey (its line and the deeper lines under it; with its /// lines above when
    // FromDescription) replaced by the lines Build writes (indented as the node's line), plus the new action texts. DropLocal:
    // a local of the action only the replaced block used (the element a T2 loop built), whose line goes with it.
    private sealed record BlockFix(FlowProblem Problem, string NodeKey, IReadOnlyList<string> Lines, IReadOnlyList<string> Added, bool FromDescription = false,
        Func<TextView, int, (IReadOnlyList<string> Lines, IReadOnlyList<string> Added)?>? Build = null, string? DropLocal = null);

    // The edited text as lines, with the line of every node by its key (the text id the parse gave it, mapped by Identify).
    private sealed class TextView
    {
        public readonly string[] Lines;
        private readonly Dictionary<string, int> lineOfId;
        private readonly Dictionary<string, string> idOfKey = new(StringComparer.Ordinal);

        public TextView(string text, IReadOnlyDictionary<string, string> mapped)
        {
            Lines = text.Split('\n');
            lineOfId = FlowParser.NodeLines(text);
            foreach (var (id, key) in mapped) idOfKey.TryAdd(key, id);
        }

        public string? Id(string key) => idOfKey.GetValueOrDefault(key);
        // The 0-based index of the node's line, or null.
        public int? Line(string key) => Id(key) is { } id && lineOfId.TryGetValue(id, out var number) && number >= 1 && number <= Lines.Length ? number - 1 : null;
        public static int Depth(string line) { var n = 0; while (n < line.Length && line[n] == ' ') n++; return n / 2; }
        public static bool Blank(string line) => line.Trim().Length == 0;
        // The end (exclusive) of the node's block: its line and the deeper lines under it (blank lines inside kept).
        public int End(int start)
        {
            var depth = Depth(Lines[start]);
            var end = start + 1;
            while (end < Lines.Length && (Blank(Lines[end]) || Depth(Lines[end]) > depth)) end++;
            while (end > start + 1 && Blank(Lines[end - 1])) end--;
            return end;
        }
        // The first of the /// lines right above the node's line (its description), or the line itself.
        public int DescriptionStart(int start)
        {
            var depth = Depth(Lines[start]);
            var at = start;
            while (at > 0 && !Blank(Lines[at - 1]) && Depth(Lines[at - 1]) == depth && Lines[at - 1].TrimStart() is var t && (t == "///" || t.StartsWith("/// ", StringComparison.Ordinal))) at--;
            return at;
        }
        // The line without the indentation of `depth` levels.
        public static string Relative(string line, int depth) => line.Length >= depth * 2 && line[..(depth * 2)].Trim().Length == 0 ? line[(depth * 2)..] : line.TrimStart();
    }

    // A node name no node of the action has, nor one a fix of this text already gave (reserve: a fix that writes it takes it).
    private string FreshNodeName(string stem, FlowItem edited, bool reserve = true)
    {
        var taken = edited.Items.Where(i => i.Role == "node" && i.Name.Length > 0).Select(i => i.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        bool Taken(string name) => taken.Contains(name) || generatedNodeNames.Contains(name);
        var name = Taken(stem) ? Numbered(stem, Taken) : stem;
        if (reserve) generatedNodeNames.Add(name);
        return name;
    }

    // A client flow: a client action, or an action of a screen or block (FlowPrinter's "action").
    private static bool ClientFlow(FlowItem action) => action.Kind is "ClientAction" or "ScreenAction";
    private static bool ServerFlow(FlowItem action) => action.Kind is "ServerAction" or "ServiceAction" or "DataAction";

    // ---- decision 6: new JavaScript only in an isolated, named client action -----------------------------------------------

    private static readonly Regex DefaultClientActionName = new(@"^ClientAction\d*$", RegexOptions.CultureInvariant);
    private static readonly Regex DefaultScriptName = new(@"^JavaScript\d*$", RegexOptions.CultureInvariant);

    // A client action that only runs JavaScript: a name of its own, JavaScript nodes, and at most assigns that copy their
    // outputs to the action's outputs (with comments, the start and the ends).
    public static bool Isolated(FlowItem action)
    {
        if (action.Kind != "ClientAction" || action.Name.Length == 0 || DefaultClientActionName.IsMatch(action.Name)) return false;
        var outputs = action.Items.Where(i => i.Role == "out").Select(i => i.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var nodes = action.Items.Where(i => i.Role == "node").ToList();
        if (!nodes.Any(n => n.Kind == "JavaScriptNode")) return false;
        foreach (var node in nodes) {
            switch (node.Kind) {
                case "StartNode" or "EndNode" or "CommentNode" or "JavaScriptNode": continue;
                case "AssignNode":
                    if (node.Items.Where(i => i.Role == "assignment").All(a => outputs.Contains(Root(a.Prop("Variable") ?? "")))) continue;
                    return false;
                default: return false;
            }
        }
        return true;
        static string Root(string variable) { var dot = variable.IndexOf('.'); return (dot < 0 ? variable : variable[..dot]).Trim(); }
    }

    // A JavaScript node the text writes new (an existing one is read, kept and editable) in any action but an isolated, named
    // client action is refused. In a client flow the fix is certain: the node moves into a new client action of its own.
    private void JavaScriptRule(FlowItem edited)
    {
        // A node an undo writes back as the earlier read had it (same name, same code) is that JavaScript again, not a new one.
        bool Restored(FlowItem node) => restoredFrom?.Items.Any(r => r.Role == "node" && r.Kind == "JavaScriptNode" && r.Name == node.Name
            && r.Prop("JavaScript") == node.Prop("JavaScript")) == true;
        // A node of the read a three-way merge writes again (the Studio removed it, the delivery changed it) is the action's own
        // JavaScript too (the owner's rule: existing JavaScript is preserved, the delivery's version of it wins).
        var fresh = edited.Items.Where(i => i.Role == "node" && i.Kind == "JavaScriptNode" && Fresh(i) && !Restored(i)).ToList();
        if (fresh.Count == 0 || Isolated(edited)) return;
        if (allowScreenJavaScript && edited.Kind == "ScreenAction" && owner?.Web != true) return;
        var kind = FlowPrinter.Labels.GetValueOrDefault(edited.Kind, edited.Kind);
        foreach (var node in fresh) {
            var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? "";
            var what = "the new JavaScript node @" + id + (node.Name.Length > 0 ? " " + node.Name : "") + " is in the " + kind + " " + edited.Name;
            if (!ClientFlow(edited)) {
                Problem("FLOW_JAVASCRIPT_NOT_ISOLATED", what + ", a server flow: JavaScript runs only in a client action, and new JavaScript only in an isolated, named one (decision 6, L5)", id,
                    "write the logic natively in the " + kind + "; JavaScript the runtime needs (clipboard, focus) goes in a client action of its own, called from the screen");
                continue;
            }
            var name = NewActionName(node, edited);
            var problem = Problem("FLOW_JAVASCRIPT_NOT_ISOLATED", what + ", which does more than run it: new JavaScript lives only in an isolated, named client action (decision 6, L5)", id,
                "move the script into the client action " + name + " (only the script, its inputs and outputs) and call it where the node was: the patch writes both");
            var key = node.Key;
            corrections.Add(new BlockFix(problem, key, [], [], FromDescription: true, Build: (view, start) => MoveScript(view, start, node, edited, name)));
        }
    }

    private string NewActionName(FlowItem node, FlowItem edited)
    {
        var stem = node.Name.Length > 0 && !DefaultScriptName.IsMatch(node.Name) && !node.Name.Equals(edited.Name, StringComparison.OrdinalIgnoreCase) ? node.Name : edited.Name + "Script";
        if (!FlowSyntax.IsIdentifier(stem)) stem = "IsolatedScript";
        bool Taken(string name) => actionTaken?.Invoke(name) == true || generatedActionNames.Contains(name) || name.Equals(edited.Name, StringComparison.OrdinalIgnoreCase);
        var chosen = Taken(stem) ? Numbered(stem, Taken) : stem;
        generatedActionNames.Add(chosen);
        return chosen;
    }

    private static readonly HashSet<string> ScriptParameterProps = new(StringComparer.Ordinal) { "DataType", "IsMandatory", "Description" };

    // The call that takes the node's place and the client action that runs the script: its inputs are the script's inputs
    // (the call passes the values the node passed), its outputs the script's outputs (copied by an assign), so the expressions
    // after the call read Name.Output as they read the node.
    private (IReadOnlyList<string> Lines, IReadOnlyList<string> Added)? MoveScript(TextView view, int start, FlowItem node, FlowItem edited, string action)
    {
        var name = node.Name;
        var inputs = node.Items.Where(i => i.Role == "in").ToList();
        var outputs = node.Items.Where(i => i.Role == "out").ToList();
        if (outputs.Count > 0 && name.Length == 0) return null;
        if (inputs.Concat(outputs).Any(p => p.Prop("DataType") is not { Length: > 0 } || p.Props.Keys.Any(k => !ScriptParameterProps.Contains(k)))) return null;
        var arguments = node.Items.Where(i => i.Role == "argument").ToDictionary(i => i.Name, i => i.Prop("Value") ?? "", StringComparer.Ordinal);
        var depth = TextView.Depth(view.Lines[start]);
        var end = view.End(start);
        var description = view.Lines[view.DescriptionStart(start)..start].Select(l => l.TrimStart()).ToList();
        var passthrough = new List<string>(); var code = new List<string>();
        for (var i = start + 1; i < end; i++) {
            var line = view.Lines[i];
            if (TextView.Blank(line)) continue;
            var relative = TextView.Depth(line) - depth;
            var part = TextView.Relative(line, depth + 1);
            if (relative == 1 && part.StartsWith("@{", StringComparison.Ordinal)) passthrough.Add(part);
            else if (relative == 1 && (part == "|" || part.StartsWith("| ", StringComparison.Ordinal))) code.Add(part);
            else if (relative == 1 && (part.StartsWith("in ", StringComparison.Ordinal) || part.StartsWith("out ", StringComparison.Ordinal) || part == "///" || part.StartsWith("/// ", StringComparison.Ordinal))) continue;
            else return null;   // a line the move does not know (a parameter's own @{...}): not certain
        }
        string V(string value) => FlowSyntax.Expr(value, FlowPrinter.CallValue);
        IEnumerable<string> Described(FlowItem item, string indent) =>
            (item.Prop("Description") ?? "").Length == 0 ? [] : item.Prop("Description")!.Split('\n').Select(l => indent + (l.Length == 0 ? "///" : "/// " + l));
        var label = node.Prop("Label");
        var labelText = label is { Length: > 0 } ? "  # " + label : "";
        // The client action: only the script.
        var text = new List<string> {
            "/// Runs the JavaScript " + (name.Length > 0 ? name : "node") + " of " + edited.Name + " on its own: new JavaScript lives only in an isolated, named client action (decision 6).",
            "client action " + action,
        };
        foreach (var p in inputs) {
            text.AddRange(Described(p, "  "));
            var optional = p.Prop("IsMandatory") == "False" || !arguments.TryGetValue(p.Name, out var given) || given.Length == 0;
            text.Add("  in " + p.Name + (optional ? "?" : "") + ": " + p.Prop("DataType"));
        }
        foreach (var o in outputs) { text.AddRange(Described(o, "  ")); text.Add("  out " + o.Name + ": " + o.Prop("DataType")); }
        text.AddRange(description.Select(l => "  " + l));
        text.Add("  " + (name.Length > 0 ? name + " = " : "") + "javascript" + labelText);
        text.AddRange(passthrough.Select(l => "    " + l));
        foreach (var p in inputs) { text.AddRange(Described(p, "    ")); text.Add("    in " + p.Name + (p.Prop("IsMandatory") == "False" ? "?" : "") + ": " + p.Prop("DataType") + " = " + p.Name); }
        foreach (var o in outputs) { text.AddRange(Described(o, "    ")); text.Add("    out " + o.Name + ": " + o.Prop("DataType")); }
        text.AddRange(code.Select(l => "    " + l));
        // The outputs copied as the reader writes an assign: on its line when there is one, one per line otherwise.
        if (outputs.Count == 1) text.Add("  assign " + outputs[0].Name + " = " + name + "." + outputs[0].Name);
        else if (outputs.Count > 1) {
            text.Add("  assign");
            foreach (var o in outputs) text.Add("    " + o.Name + " = " + name + "." + o.Name);
        }
        text.Add("  end");
        // The call where the node was: the same name (Name.Output still reads), the label, and an id the text gave it.
        var id = view.Id(node.Key) ?? "";
        var keepId = id.Length > 0 && !id.StartsWith(FlowParser.FreshPrefix, StringComparison.Ordinal);
        // As the reader writes a call's arguments: a value that is the parameter's own name alone, else Name=value.
        var args = inputs.Where(p => arguments.TryGetValue(p.Name, out var v) && v.Length > 0).Select(p => arguments[p.Name] == p.Name ? p.Name : p.Name + "=" + V(arguments[p.Name]));
        var call = (name.Length > 0 && name != action ? name + " = " : "") + action + "(" + string.Join(", ", args) + ")" + labelText + (keepId ? " @" + id : "");
        return ([call], [string.Join("\n", text) + "\n"]);
    }

    // ---- T3: an aggregate a loop runs per item, in a server flow -----------------------------------------------------------

    // A new aggregate inside a loop, or an aggregate inside a new loop (the candidate's QUERY_IN_LOOP for any op), whose fix is
    // certain: a server flow (ListFilter reads Source.Current there), one source, no join, group, column or start, at most one
    // row, the aggregate written in the loop's block and named only inside the loop. The rest is left to the candidate's rule.
    private void QueryInLoopRule(FlowItem edited)
    {
        if (allowQueryInLoop || editedText == null || !ServerFlow(edited)) return;
        TextView? view = null;
        var nodes = edited.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var loop in nodes.Values.Where(n => n.Kind == "ForEachNode")) {
            var body = new List<FlowItem>(); var pending = new Stack<string>(); var seen = new HashSet<string>(StringComparer.Ordinal);
            if (loop.Edges.GetValueOrDefault("CycleTarget") is { Length: > 0 } first) pending.Push(first);
            while (pending.TryPop(out var key)) {
                if (key == loop.Key || !seen.Add(key) || !nodes.TryGetValue(key, out var node)) continue;
                body.Add(node);
                foreach (var target in Next(node)) pending.Push(target);
            }
            foreach (var query in body.Where(n => n.Kind == "AggregateNode" && (Fresh(n) || Fresh(loop)))) {
                var sources = query.Items.Where(i => i.Role == "source").ToList();
                if (sources.Count != 1 || query.Items.Any(i => i.Role is "join" or "group" or "agg" or "calc") || query.Name.Length == 0
                    || query.Prop("StartIndex") != null || query.Prop("MaxRecords") is { } max && max.Trim() != "1"
                    || query.Props.Keys.Any(k => k is not ("MaxRecords" or "Label" or "Description"))) continue;
                // Only a certain fix makes this a problem here; the text says whether it is (the rest: the candidate's rule).
                try { view ??= new TextView(editedText, mapped); } catch (FormatException) { return; }
                if (view.Line(loop.Key) is not int start || Hoist(view, start, loop, query, body, edited) is not { } hoisted) continue;
                var list = loop.Prop("RecordList") ?? "";
                var loopName = loop.Name.Length > 0 ? loop.Name : loop.Prop("Label") ?? "ForEach";
                var id = mapped.FirstOrDefault(m => m.Value == query.Key).Key ?? "";
                var problem = Problem("QUERY_IN_LOOP", "Aggregate '" + query.Name + "' runs inside the loop '" + loopName + "'" + (list.Length > 0 ? " over " + list : "") + " of '" + edited.Name
                    + "': one query per iteration (N+1 round trips to the database)", id,
                    "the patch reads " + query.Name + " once before the loop (with the filters that do not depend on the item) and looks the row up inside '" + loopName
                    + "' with ListFilter over " + query.Name + ".List; only when the query truly must run per item, add \"" + Anvil.Core.QueryInLoopRule.AllowKey
                    + "\": {\"why\": \"...\"} (at least " + Anvil.Core.QueryInLoopRule.MinimumWhy + " characters) to the op");
                Problems[^1] = problem = problem with { Fields = new() { ["flow"] = edited.Name, ["loop"] = loopName, ["query"] = query.Name, ["queryKind"] = "aggregate" } };
                corrections.Add(new BlockFix(problem, loop.Key, [], [], FromDescription: true, Build: (_, _) => hoisted));
            }
        }
    }

    // The loop's block with the aggregate read once before it: its filters that name nothing of the loop stay in it, the
    // others become the condition of a ListFilter where the aggregate was, and the loop's lines read the filtered list.
    private (IReadOnlyList<string> Lines, IReadOnlyList<string> Added)? Hoist(TextView view, int start, FlowItem loop, FlowItem query, List<FlowItem> body, FlowItem edited)
    {
        if (view.Line(query.Key) is not int at) return null;
        var depth = TextView.Depth(view.Lines[start]);
        var end = view.End(start);
        var from = view.DescriptionStart(start);
        var queryEnd = view.End(at);
        var queryFrom = view.DescriptionStart(at);
        if (queryFrom <= start || queryEnd > end) return null;
        var loopId = view.Id(loop.Key) ?? "";
        // A jump to the loop would pass by the read before it.
        if (loopId.Length > 0 && !loopId.StartsWith(FlowParser.FreshPrefix, StringComparison.Ordinal)
            && view.Lines.Where((l, i) => i != start).Any(l => l.Contains("-> @" + loopId, StringComparison.Ordinal))) return null;
        var name = query.Name;
        static bool Code(string line) => line.TrimStart() is var t && (t == "|" || t.StartsWith("| ", StringComparison.Ordinal) || t.StartsWith("//", StringComparison.Ordinal));
        // Named only inside the loop: after it, the read before the loop would have every row.
        for (var i = 0; i < view.Lines.Length; i++)
            if ((i < from || i >= end) && !Code(view.Lines[i]) && Mentions(view.Lines[i], name)) return null;
        var source = query.Items.Single(i => i.Role == "source");
        var alias = source.Name;
        var entity = source.Prop("Source") ?? "";
        // What the loop gives each item: its list, the nodes and the variables its body writes.
        var perItem = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var root = Regex.Match(loop.Prop("RecordList") ?? "", @"^\s*([A-Za-z_][A-Za-z0-9_]*)").Groups[1].Value;
        if (root.Length > 0) perItem.Add(root);
        foreach (var node in body) {
            if (node.Name.Length > 0 && !ReferenceEquals(node, query)) perItem.Add(node.Name);
            foreach (var assignment in node.Items.Where(i => i.Role == "assignment"))
                if (Regex.Match(assignment.Prop("Variable") ?? "", @"^\s*([A-Za-z_][A-Za-z0-9_]*)") is { Success: true } variable) perItem.Add(variable.Groups[1].Value);
        }
        var filters = query.Items.Where(i => i.Role == "filter").Select(f => f.Prop("Condition") ?? "").ToList();
        var stay = filters.Where(f => !perItem.Any(n => Mentions(f, n))).ToList();
        var lookup = filters.Except(stay).ToList();
        if (lookup.Count == 0) return null;   // nothing depends on the item: not a lookup, the candidate's fix says what to do
        var filterName = FreshNodeName("Filter" + name, edited);
        string V(string value) => FlowSyntax.Expr(value, FlowPrinter.CallValue);
        var condition = string.Join(" and ", lookup.Select(f => lookup.Count == 1 ? f : "(" + f + ")"));
        condition = FlowEdits.Renamed(condition, alias, name + ".List.Current." + alias);
        var head = name + " = aggregate FROM " + (alias == entity ? entity : alias + "=" + entity);
        if (stay.Count > 0) head += " WHERE " + string.Join(" AND ", stay.Select(f => "(" + FlowSyntax.Expr(f, FlowPrinter.Paren) + ")"));
        var sorts = query.Items.Where(i => i.Role == "sort").Select(s => FlowSyntax.Expr(s.Prop("Attribute") ?? "", FlowPrinter.SortValue)
            + (s.Prop("SortDirection") == "Descending" ? " desc" : "") + (s.Prop("IsDynamic") == "True" ? " dynamic" : "")).ToList();
        if (sorts.Count > 0) head += " SORT " + string.Join(", ", sorts);
        var lines = new List<string>();
        lines.AddRange(view.Lines[queryFrom..at].Select(l => l.TrimStart()));
        lines.Add(head);
        for (var i = from; i < end; i++) {
            if (i == queryFrom) {
                var queryId = view.Id(query.Key) ?? "";
                var keep = queryId.Length > 0 && !queryId.StartsWith(FlowParser.FreshPrefix, StringComparison.Ordinal) ? " @" + queryId : "";
                lines.Add(new string(' ', (TextView.Depth(view.Lines[at]) - depth) * 2) + filterName + " = (System).ListFilter(Condition=" + V(condition) + ", SourceList=" + name + ".List)"
                    + (query.Prop("Label") is { Length: > 0 } label ? "  # " + label : "") + keep);
                i = queryEnd - 1;
                continue;
            }
            var line = TextView.Relative(view.Lines[i], depth);
            if (!Code(line)) {
                line = FlowEdits.Renamed(FlowEdits.Renamed(line, name + ".Count", filterName + ".FilteredList.Length"), name + ".List", filterName + ".FilteredList");
                if (Mentions(line, name)) return null;   // the aggregate named another way (its output whole): not certain
            }
            lines.Add(line);
        }
        return (lines, []);
    }

    // ---- the corrected text ------------------------------------------------------------------------------------------------

    private sealed record Built(BlockFix Fix, int From, int To, IReadOnlyList<string> Lines, IReadOnlyList<string> Added, int DropFrom = -1, int DropTo = -1)
    {
        // The ranges of lines the fix replaces: its block and, with DropLocal, the local's line (with its /// lines).
        public IEnumerable<(int From, int To, IReadOnlyList<string> Lines)> Ranges()
        {
            yield return (From, To, Lines);
            if (DropFrom >= 0) yield return (DropFrom, DropTo, []);
        }
    }

    private void Correct()
    {
        TextView view;
        try { view = new TextView(editedText!, mapped); } catch (FormatException) { return; }
        var built = new List<Built>();
        foreach (var fix in corrections) {
            if (view.Line(fix.NodeKey) is not int start) continue;
            IReadOnlyList<string> lines, added;
            if (fix.Build != null) {
                if (fix.Build(view, start) is not { } result) continue;
                (lines, added) = result;
            } else {
                // The node's own id, when the text gave it one (a jump names it), goes to the first line that takes its place.
                var id = view.Id(fix.NodeKey) ?? "";
                lines = id.Length > 0 && !id.StartsWith(FlowParser.FreshPrefix, StringComparison.Ordinal) && fix.Lines.Count > 0 ? [fix.Lines[0] + " @" + id, .. fix.Lines.Skip(1)] : fix.Lines;
                added = fix.Added;
            }
            var indent = new string(' ', TextView.Depth(view.Lines[start]) * 2);
            var (dropFrom, dropTo) = (-1, -1);
            if (fix.DropLocal != null) {
                var local = Array.FindIndex(view.Lines, l => TextView.Depth(l) == 1 && Regex.IsMatch(l.TrimStart(), @"^local " + Regex.Escape(fix.DropLocal) + @"\??:", RegexOptions.IgnoreCase));
                if (local >= 0) (dropFrom, dropTo) = (view.DescriptionStart(local), local + 1);
            }
            built.Add(new(fix, fix.FromDescription ? view.DescriptionStart(start) : start, view.End(start), lines.Select(l => l.Length == 0 ? l : indent + l).ToList(), added, dropFrom, dropTo));
        }
        // Blocks that overlap (a fix inside another's block): the first one in the text.
        var chosen = new List<Built>();
        foreach (var b in built.OrderBy(b => b.From))
            if (!chosen.Any(c => c.Ranges().Any(x => b.Ranges().Any(y => y.From < x.To && x.From < y.To)))) chosen.Add(b);
        if (chosen.Count == 0) return;
        var accepted = Verified(view, chosen) ? chosen : null;
        if (accepted == null) {
            var alone = chosen.Where(c => Verified(view, [c])).ToList();
            accepted = alone.Count == 1 || alone.Count > 1 && Verified(view, alone) ? alone : [];
        }
        // A hoist the check refused keeps the candidate's fix sentence (no patch to point at).
        foreach (var b in chosen.Except(accepted ?? []).Where(b => b.Fix.Problem.Code == "QUERY_IN_LOOP")) {
            var at = Problems.FindIndex(p => ReferenceEquals(p, b.Fix.Problem));
            var fields = b.Fix.Problem.Fields;
            if (at >= 0) Problems[at] = Problems[at] with { Fix = Anvil.Core.QueryInLoopRule.Fix(false, fields?["loop"]?.ToString() ?? "loop", null) };
        }
        if (accepted.Count == 0) return;
        var (text, added2) = Applied(view, accepted);
        foreach (var b in accepted) {
            var at = Problems.FindIndex(p => ReferenceEquals(p, b.Fix.Problem));
            if (at < 0) continue;
            var problem = Problems[at];
            Problems[at] = problem with { Corrected = text, Added = added2 };
        }
    }

    private static (string Text, List<string> Added) Applied(TextView view, IReadOnlyList<Built> fixes)
    {
        var lines = view.Lines.ToList();
        foreach (var (from, to, replacement) in fixes.SelectMany(b => b.Ranges()).OrderByDescending(r => r.From)) { lines.RemoveRange(from, to - from); lines.InsertRange(from, replacement); }
        return (string.Join("\n", lines), fixes.SelectMany(b => b.Added).ToList());
    }

    // The corrected text and its new action texts read again under the same rules: none of the problems the fixes fix, no
    // problem the text did not already have; every new action text without any problem.
    private bool Verified(TextView view, IReadOnlyList<Built> fixes)
    {
        var (text, added) = Applied(view, fixes);
        try {
            var again = Compute(baseline, ids, ModuleFlow.Read(text), baseText, prefix, text, actionTaken, allowQueryInLoop, correct: false, restoredFrom, types, owner, rewritten, allowScreenJavaScript);
            var fixedOnes = fixes.Select(b => b.Fix.Problem).ToHashSet(ReferenceEqualityComparer.Instance);
            var remaining = Problems.Where(p => !fixedOnes.Contains(p)).Select(p => p.Code).ToList();
            foreach (var p in again.Problems) if (!remaining.Remove(p.Code)) return false;
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var extra in added) {
                var item = ModuleFlow.Read(extra);
                if (!names.Add(item.Name) || item.Key.Length > 0) return false;
                if (Compute(null, new Dictionary<string, string>(), item, null, prefix, extra, actionTaken, allowQueryInLoop, correct: false, types: types).Problems.Count > 0) return false;
            }
            return true;
        } catch (FormatException) { return false; }
    }
}
