using Anvil.Core;

namespace Anvil.Reading;

// The sorts, columns and joins of an aggregate in a text, as the Studio writes them (AggregateSortRule.cs; publish error P0 of
// 2026-10-12: `SORT -IdentifierToLongInteger(VisitEvent.Id)` was delivered and the OutSystems compiler failed on it):
//  - a sort that is not dynamic is one attribute of a source of its aggregate or one of its columns, the direction only in
//    `desc`; in an aggregate that groups (GROUP BY or AGG), only a group by column, its attribute or an aggregated column. A
//    form that certainly means one attribute (`X DESC`, `-X`, `IdentifierToLongInteger(X)`, `If(C, 0, 1)`) is written as that
//    attribute with its direction, before the diff, so the action reads back as the normalized text; a key that repeats an
//    earlier one is dropped (the order is the same without it); each one is listed (SortNormalizations, the apply's `sorts`
//    and expressionRewrites). Anything else is refused with the fix, and the verified patch when it is certain.
//  - a group by or aggregated column names one attribute (GROUP BY Name=Source.Attribute, AGG Name=Fn(Source.Attribute)); an
//    expression is refused, with the verified patch when certain: CALC NameRow=<expression> and the column by NameRow (the
//    published forms, a client module `AGG X=Sum(XRow) CALC XRow=If(...)`, AgentOps `GROUP BY RunDay=QueuedDay CALC QueuedDay=...`).
//  - a join is Inner, Left or Full; JOIN Right A~B, the only join of two sources, is written JOIN Left B~A (JoinNormalizations);
//    another Right, None, or a source in no join is refused.
// Only the parts the text changes are judged: a sort, column or join read from the module and written back as it was stays
// (the apply's checagem de compilação refuses an old part that does not compile, with the raw ops that fix it).
public sealed partial class FlowDiff
{
    // The sorts written as the Studio writes them: the node's id, the sort as the text had it, as it is written, and why.
    public readonly List<(string Id, string From, string To, string Why)> SortNormalizations = [];
    // The joins written as the Studio writes them (a Right join as the Left join with its sources swapped).
    public readonly List<(string Id, string From, string To, string Why)> JoinNormalizations = [];

    private void SortRule(FlowItem edited)
    {
        foreach (var node in edited.Items.Where(i => i.Role == "node" && i.Kind == "AggregateNode" && !i.Opaque)) {
            var old = baseByKey.GetValueOrDefault(node.Key);
            var id = mapped.FirstOrDefault(m => m.Value == node.Key).Key ?? node.Key;
            var what = "@" + id + (node.Name.Length > 0 ? " " + node.Name : "");
            JoinRule(node, old, id, what);
            var sources = node.Items.Where(p => p.Role == "source" && p.Name.Length > 0).Select(p => p.Name).ToList();
            var columns = node.Items.Where(p => p.Role is "group" or "agg" or "calc" && p.Name.Length > 0).Select(p => p.Name).ToList();
            var grouped = node.Items.Any(p => p.Role is "group" or "agg");
            var keys = GroupKeys(node);
            ColumnRule(node, old, id, what, edited, sources.Concat(columns));
            // The expressions of this aggregate that become columns (the patch), with the problem of the first one.
            var computed = new List<(FlowProblem Problem, string Expression)>();
            var sortsChanged = !SameParts(old, node, "sort");
            if (sortsChanged || !SameParts(old, node, "group") || !SameParts(old, node, "agg")) {
                var seen = new List<string>();
                foreach (var sort in node.Items.Where(p => p.Role == "sort").ToList()) {
                    if (sort.Prop("IsDynamic") == "True") continue;
                    var text = sort.Prop("Attribute") ?? "";
                    var descending = sort.Prop("SortDirection") == "Descending";
                    var key = AggregateSortRule.Normalize(text);
                    // The text kept the sorts and changed the grouping: only an old plain sort the new grouping leaves out is
                    // judged here (any other old sort is the apply's: preexisting).
                    if (!sortsChanged && key is not { Steps.Count: 0 }) continue;
                    var scope = key == null ? null : AggregateSortRule.OutOfScope(key.Attribute, sources, columns);
                    var outside = key == null ? null : scope ?? AggregateSortRule.OutOfGroup(key.Attribute, grouped, keys);
                    if (!sortsChanged && scope != null) continue;
                    if (key == null || outside != null) {
                        var fix = key == null ? (grouped ? AggregateSortRule.GroupedFix(keys) : AggregateSortRule.Fix(text)) : scope != null ? AggregateSortRule.Fix(text) : AggregateSortRule.GroupedFix(keys);
                        var problem = Problem(AggregateSortRule.Code, what + ": SORT " + text + (key == null
                            ? " is an expression, not one attribute: the Studio sorts an aggregate by an attribute of its sources or by one of its columns, and the OutSystems compiler fails on any other sort that is not dynamic"
                            : ": " + outside), id, fix);
                        if (key == null && !grouped) computed.Add((problem, text));
                        continue;
                    }
                    // A key that repeats an earlier one adds nothing to the order (the Verify refuses it written twice): dropped.
                    if (sortsChanged && seen.Contains(key.Attribute, StringComparer.OrdinalIgnoreCase)) {
                        node.Items.Remove(sort);
                        SortNormalizations.Add((id, text + (descending ? " desc" : ""), "(removed)",
                            "the key " + key.Attribute + " already orders the rows before it, so the order is the same without it (a sort written twice is refused by the Verify)"));
                        continue;
                    }
                    seen.Add(key.Attribute);
                    if (key.Steps.Count == 0) continue;
                    var now = descending ^ key.Flip;
                    sort.Props["Attribute"] = new('e', key.Attribute);
                    if (now) sort.Props["SortDirection"] = new('v', "Descending"); else sort.Props.Remove("SortDirection");
                    SortNormalizations.Add((id, text + (descending ? " desc" : ""), key.Attribute + (now ? " desc" : ""), string.Join("; ", key.Steps)));
                }
            }
            if (computed.Count > 0) SortColumnFix(computed, node, edited, sources.Concat(columns));
        }
    }

    // What a grouped aggregate may sort by: the attributes its group by columns read (a sort lives before the grouping, where
    // the group by and aggregated columns do not exist yet; AggregateSortRule.OutOfGroup).
    private static List<string> GroupKeys(FlowItem node)
    {
        var keys = new List<string>();
        foreach (var part in node.Items.Where(p => p.Role == "group"))
            if (AggregateSortRule.Plain(part.Prop("Attribute")) is { } attribute && !keys.Contains(attribute, StringComparer.OrdinalIgnoreCase)) keys.Add(attribute);
        return keys;
    }

    // Group by and aggregated columns over an expression (AGGREGATE_COLUMN_NOT_ATTRIBUTE), with the patch when certain.
    private void ColumnRule(FlowItem node, FlowItem? old, string id, string what, FlowItem edited, IEnumerable<string> taken)
    {
        if (SameParts(old, node, "group") && SameParts(old, node, "agg")) return;
        var computed = new List<(FlowProblem Problem, FlowItem Part, string Expression)>();
        foreach (var part in node.Items.Where(p => p.Role is "group" or "agg")) {
            var text = part.Prop("Attribute") ?? "";
            if (text.Trim().Length == 0) { EmptyColumn(node, part, id, what); continue; }
            if (AggregateSortRule.Plain(text) != null) continue;
            var group = part.Role == "group";
            var function = part.Prop("AggregationType");
            var shown = group ? "GROUP BY " + (part.Name.Length > 0 ? part.Name + "=" : "") + text : "AGG " + part.Name + "=" + function + "(" + text + ")";
            var problem = Problem(AggregateSortRule.ColumnCode, what + ": " + shown + " is an expression, not one attribute: the Studio groups and aggregates attributes of the sources (or columns of the aggregate), an expression goes in a calculated column grouped or aggregated by name, and the compiler builds that slot as it builds a sort, whose expressions it fails on",
                id, AggregateSortRule.ColumnFix(text, part.Name, group, function));
            computed.Add((problem, part, text));
        }
        if (computed.Count > 0) ColumnPatch(computed, node, edited, taken);
    }

    // A group by or aggregated column that reads no attribute (`Count(``)`, the form the reader prints for it; the parse refuses
    // `Count()`): no data type, nothing for the compiler to aggregate. The patch, when certain: Count with one source counts the
    // rows by that source's identifier (the model says its name: IFlowTypes.IdentifierOf).
    private void EmptyColumn(FlowItem node, FlowItem part, string id, string what)
    {
        var group = part.Role == "group";
        var function = part.Prop("AggregationType");
        var text = part.Prop("Attribute") ?? "";
        var printed = FlowSyntax.Expr(text, FlowPrinter.Paren);
        var shown = group ? "GROUP BY " + (part.Name.Length > 0 ? part.Name + "=" : "") + printed : "AGG " + part.Name + "=" + function + "(" + printed + ")";
        var sources = node.Items.Where(p => p.Role == "source").ToList();
        var source = sources.Count == 1 && sources[0].Name.Length > 0 ? sources[0].Name : null;
        var identifier = source != null && sources[0].Prop("Source") is { Length: > 0 } record ? types?.IdentifierOf(record) : null;
        // ODC: the text does not write a grouped aggregate (it reads back opaque): the fix names the logic op, no text patch.
        var odc = string.Equals(MessageExpectations.Lane, "odc", StringComparison.OrdinalIgnoreCase);
        var problem = Problem(AggregateSortRule.ColumnCode, what + ": " + shown + " " + AggregateSortRule.EmptyColumnWhy + ": the column has no data type and the compiler has nothing to "
            + (group ? "group by" : "aggregate") + "; the Studio always names the attribute a column reads (the O11 Verify sees it only when an expression reads the column)",
            id, AggregateSortRule.EmptyColumnFix(part.Name, group, function, source, identifier) + (odc ? AggregateSortRule.OdcGroupedByLogic : ""));
        if (odc || group || !string.Equals(function, "Count", StringComparison.OrdinalIgnoreCase) || source == null || identifier == null || part.Name.Length == 0) return;
        var from = part.Name + "=" + function + "(" + printed + ")";
        var to = part.Name + "=" + function + "(" + source + "." + identifier + ")";
        corrections.Add(new BlockFix(problem, node.Key, [], [], Build: (view, start) => {
            var end = view.End(start);
            var depth = TextView.Depth(view.Lines[start]);
            var line = TextView.Relative(view.Lines[start], depth);
            var at = line.IndexOf(from, StringComparison.Ordinal);
            if (at < 0 || line.IndexOf(from, at + 1, StringComparison.Ordinal) >= 0) return null;
            IReadOnlyList<string> lines = [line[..at] + to + line[(at + from.Length)..], .. Enumerable.Range(start + 1, end - start - 1).Select(i => TextView.Relative(view.Lines[i], depth))];
            return (lines, Array.Empty<string>());
        }));
    }

    // The patch of the columns over expressions, when it is certain: each expression becomes a calculated column NameRow, the
    // column groups or aggregates it by name. Certain only when every such column is named, the database runs every function of
    // the expression, and the action reads the rows of the aggregate only field by field (a new column changes the record
    // type of X.List, never what those read). The corrected text is then checked by Correct.
    private void ColumnPatch(List<(FlowProblem Problem, FlowItem Part, string Expression)> computed, FlowItem node, FlowItem edited, IEnumerable<string> taken)
    {
        if (node.Name.Length == 0 || computed.Any(c => c.Part.Name.Length == 0) || !RowsReadByField(node, edited)) return;
        // ODC: the text does not write a grouped aggregate (it reads back opaque), so no text patch is certain there; the logic
        // op writes it (a calculated column, and the column by its name), as the refusal's fix says.
        if (string.Equals(MessageExpectations.Lane, "odc", StringComparison.OrdinalIgnoreCase)) return;
        var client = !ServerFlow(edited);
        if (computed.Any(c => !AggregateSortRule.RunsInDatabase(c.Expression, client))) return;
        var names = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        var columns = new List<(FlowItem Part, string Calc, string Expression)>();
        foreach (var (_, part, expression) in computed) {
            var calc = part.Name + "Row";
            if (names.Contains(calc)) calc = Numbered(calc, names.Contains);
            names.Add(calc);
            columns.Add((part, calc, expression));
        }
        corrections.Add(new BlockFix(computed[0].Problem, node.Key, [], [], Build: (view, start) => {
            var end = view.End(start);
            var depth = TextView.Depth(view.Lines[start]);
            var line = TextView.Relative(view.Lines[start], depth);
            var head = FlowSyntax.SplitKey(line, out var bare, out _) ? bare : line;
            if (!line.StartsWith(head, StringComparison.Ordinal)) return null;
            var rest = line[head.Length..];
            var label = head.IndexOf("  # ", StringComparison.Ordinal);
            var body = label >= 0 ? head[..label] : head;
            var suffix = label >= 0 ? head[label..] : "";
            foreach (var (part, calc, expression) in columns) {
                var function = part.Prop("AggregationType");
                var from = part.Role == "group" ? part.Name + "=" + expression : part.Name + "=" + function + "(" + expression + ")";
                var to = part.Role == "group" ? part.Name + "=" + calc : part.Name + "=" + function + "(" + calc + ")";
                var at = body.IndexOf(from, StringComparison.Ordinal);
                if (at < 0 || body.IndexOf(from, at + 1, StringComparison.Ordinal) >= 0) return null;
                body = body[..at] + to + body[(at + from.Length)..];
            }
            var added = string.Join(", ", columns.Select(c => c.Calc + "=" + c.Expression));
            var calcAt = body.IndexOf(" CALC ", StringComparison.Ordinal);
            if (calcAt >= 0) body = body.Insert(calcAt + " CALC ".Length, added + ", ");
            else {
                var after = Math.Max(body.LastIndexOf(" AGG ", StringComparison.Ordinal), body.LastIndexOf(" GROUP BY ", StringComparison.Ordinal));
                if (after < 0) return null;
                var cut = new[] { " SORT ", " MAX ", " START " }.Select(w => body.IndexOf(w, after, StringComparison.Ordinal)).Where(i => i >= 0).DefaultIfEmpty(body.Length).Min();
                body = body.Insert(cut, " CALC " + added);
            }
            IReadOnlyList<string> lines = [body + suffix + rest, .. Enumerable.Range(start + 1, end - start - 1).Select(i => TextView.Relative(view.Lines[i], depth))];
            return (lines, Array.Empty<string>());
        }));
    }

    // Joins (AGGREGATE_JOIN_NOT_NATIVE): Inner, Left and Full as written; the Right join of two sources as the Left join with
    // its sources swapped (listed); any other type, or a source in no join, refused.
    private void JoinRule(FlowItem node, FlowItem? old, string id, string what)
    {
        if (SameParts(old, node, "join") && SameParts(old, node, "source")) return;
        var joins = node.Items.Where(p => p.Role == "join").ToList();
        var sources = node.Items.Where(p => p.Role == "source").ToList();
        foreach (var join in joins) {
            var type = join.Prop("JoinType") ?? "";
            var left = join.Prop("LeftSource") ?? "?";
            var right = join.Prop("RightSource") ?? "?";
            var native = LogicExpander.JoinKind(type);
            if (AggregateSortRule.NativeJoin(native)) continue;
            if (native == "Right" && joins.Count == 1 && sources.Count == 2 && join.Props.TryGetValue("LeftSource", out var l) && join.Props.TryGetValue("RightSource", out var r)) {
                join.Props["LeftSource"] = r;
                join.Props["RightSource"] = l;
                join.Props["JoinType"] = new('v', "Left");
                JoinNormalizations.Add((id, type + " " + left + "~" + right, "Left " + right + "~" + left,
                    "a Right join keeps every row of its right source, which is the Left join (With or Without) with the two sources swapped; the Studio writes no Right join"));
                continue;
            }
            Problem(AggregateSortRule.JoinCode, what + ": JOIN " + type + " " + left + "~" + right + " is not a join the Studio writes (Only With: Inner, With or Without: Left, With: Full), and nothing proves the compiler builds it",
                id, AggregateSortRule.JoinFix(native ?? type, left, right, joins.Count));
        }
        if (sources.Count < 2) return;
        var joined = joins.SelectMany(j => new[] { j.Prop("LeftSource"), j.Prop("RightSource") }).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var source in sources.Where(s => s.Name.Length > 0 && !joined.Contains(s.Name)))
            Problem(AggregateSortRule.JoinCode, what + ": the source " + source.Name + " is in no join: the Studio joins every source of an aggregate (Only With, With or Without, With), and nothing proves the compiler builds the product of two sources",
                id, "join it: JOIN Inner " + sources.First(s => !ReferenceEquals(s, source)).Name + "~" + source.Name + " ON <condition> (Left for With or Without), or remove the source");
    }

    // Whether the action reads the rows of the aggregate only field by field (X.List.Current.<...>, X.List.Length, X.List.Empty,
    // X.Count, or X.List mapTo {...}): then a new column changes the record type of X.List, never what those read.
    private static bool RowsReadByField(FlowItem node, FlowItem edited)
    {
        var name = System.Text.RegularExpressions.Regex.Escape(node.Name);
        var whole = new System.Text.RegularExpressions.Regex(@"(?<![\p{L}\p{N}_.])" + name + @"(?![\p{L}\p{N}_])(?!\s*\.\s*Count\b)(?!\s*\.\s*List\s*\.\s*(?:Current|Length|Empty)\b)(?!\s*\.\s*List\s+mapTo\s*\{)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        IEnumerable<string> Texts(FlowItem item) => item.Props.Values.Select(v => v.Text).Concat(item.Items.SelectMany(Texts));
        return !edited.Items.Where(i => !ReferenceEquals(i, node)).SelectMany(Texts).Any(t => whole.IsMatch(t));
    }

    // The patch of the sorts that are expressions, when it is certain: each expression becomes a calculated column of the
    // aggregate (CALC SortKey=<expression>, the Studio's way to sort by a computed value) and the sort names the column, in
    // the same place. Certain only when
    //  - the aggregate has no group by or aggregated column (a calculated column is not in a grouped row),
    //  - the database runs every function of the expression (EncodeHtml would make the Verify refuse the column), and
    //  - the action reads its rows only field by field (RowsReadByField).
    // The corrected text is then checked by Correct (it parses, its diff has none of these problems and no new one).
    private void SortColumnFix(List<(FlowProblem Problem, string Expression)> computed, FlowItem node, FlowItem edited, IEnumerable<string> taken)
    {
        if (node.Name.Length == 0 || node.Items.Any(p => p.Role is "group" or "agg") || !RowsReadByField(node, edited)) return;
        var client = !ServerFlow(edited);
        if (computed.Any(c => !AggregateSortRule.RunsInDatabase(c.Expression, client))) return;
        var names = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        var columns = new List<(string Name, string Expression)>();
        foreach (var (_, expression) in computed) {
            var column = names.Contains("SortKey") ? Numbered("SortKey", names.Contains) : "SortKey";
            names.Add(column);
            columns.Add((column, expression));
        }
        var hasCalc = node.Items.Any(p => p.Role == "calc");
        corrections.Add(new BlockFix(computed[0].Problem, node.Key, [], [], Build: (view, start) => {
            var end = view.End(start);
            var depth = TextView.Depth(view.Lines[start]);
            var line = TextView.Relative(view.Lines[start], depth);
            var at = line.IndexOf(" SORT ", StringComparison.Ordinal);
            if (at < 0 || line.IndexOf(" SORT ", at + 1, StringComparison.Ordinal) >= 0) return null;
            var head = line[..at];
            var tail = line[at..];
            foreach (var (column, expression) in columns) {
                var found = tail.IndexOf(expression, StringComparison.Ordinal);
                if (found < 0 || tail.IndexOf(expression, found + 1, StringComparison.Ordinal) >= 0) return null;
                tail = tail[..found] + column + tail[(found + expression.Length)..];
            }
            head += (hasCalc ? ", " : " CALC ") + string.Join(", ", columns.Select(c => c.Name + "=" + c.Expression));
            IReadOnlyList<string> lines = [head + tail, .. Enumerable.Range(start + 1, end - start - 1).Select(i => TextView.Relative(view.Lines[i], depth))];
            return (lines, Array.Empty<string>());
        }));
    }

    // Whether the parts of one role are the same in the read and in the text (a new node has none read).
    private static bool SameParts(FlowItem? old, FlowItem now, string role)
    {
        if (old == null) return false;
        static string Canon(FlowItem node, string role) => string.Join("\n", node.Items.Where(p => p.Role == role)
            .Select(p => p.Name + "|" + string.Join(";", p.Props.Select(v => v.Key + "=" + v.Value.Text))));
        return Canon(old, role) == Canon(now, role);
    }
}
