using System.Text.RegularExpressions;

namespace Anvil.Reading;

/// <summary>
/// What the module knows that the text of one action does not say, for the patches of the rules (the apply's session gives
/// it; the preflight reads the job alone and has none): the type of a name the action reads without declaring it, the
/// sources of an aggregate of its screen or block, and the attributes of a record in their order.
/// </summary>
public interface IFlowTypes
{
    /// <summary>The data type of a name the action reads and its text does not declare (a variable or input of its screen or
    /// block, a client variable), written as the reader writes types ("TipoTurno List"); null when nothing in scope has it.</summary>
    string? TypeOf(string name);
    /// <summary>The sources of an aggregate of the action's screen or block, by alias with the entity or structure each one
    /// reads; null when the screen has no aggregate of that name.</summary>
    IReadOnlyList<(string Alias, string Record)>? SourcesOf(string aggregate);
    /// <summary>The attributes of an entity or structure in their order (the order the platform prints a mapping in); null
    /// when the module has no record of that name.</summary>
    IReadOnlyList<string>? AttributesOf(string record);
    /// <summary>The mandatory attributes of an entity or structure (the Verify refuses a mapping that leaves one empty, on both
    /// lanes: AttributeMappingRequiredExpression; an entity's identifier always), each with the
    /// value a local of that record holds when nothing assigns it, when that value is certain (NullIdentifier() for the
    /// identifier of an entity), else null; null when the module does not say.</summary>
    IReadOnlyList<(string Attribute, string? Value)>? MandatoryOf(string record) => null;
    /// <summary>The data type of the input `parameter` of the action a call node names (as the reader writes the callee, with
    /// its Call= kind when the text writes one), written as the reader writes types; null when the module has no such action or
    /// input (an action another text of the op creates, a system action).</summary>
    string? InputTypeOf(string callee, string? callKind, string parameter) => null;
    /// <summary>The data type of one attribute of an entity or structure, written as the reader writes types; null when the
    /// module does not say.</summary>
    string? AttributeTypeOf(string record, string attribute) => null;
    /// <summary>The name of the identifier attribute of an entity (Count(Source.Id) counts its rows); null when the module does
    /// not say (no record of that name, a structure, an entity without one).</summary>
    string? IdentifierOf(string record) => null;
}

// ---- T1/T2: a new For Each that only filters, copies or maps into a list ------------------------------------------------
//
// The owner's rules T1 (List actions over For Each) and T2 (mapping instead of For Each + ListAppend), judged on a For Each the
// text writes NEW (one of the read stays as it is, preserved and listed). A loop whose body only tests, builds the element it
// appends and appends it to one list is refused, always (decision 5); a body that does anything else (a total, a flag, an
// output, a call) is a For Each the team allows (T3: an effect or a decision per item). The patch comes when the fix is certain:
//   filter:     Ifs that keep the append on one branch -> ListFilter (the condition, negated for the false branch);
//   row:        ListAppend(Source.Current), or of a variable that takes it -> ListAppendAll of the (filtered) source;
//   row record: ListAppend(Agg.List.Current.Entity), the entity of an aggregate's row -> ListAppendAll of the (filtered)
//               aggregate list (O11 converts a row with one entity to that entity; ODC writes the conversion: mapTo {  });
//   value:      ListAppend(Source.Current.Field), a value read from the item -> mapTo { Value: Field } into a list of
//               values, in both lanes (the O11 native whole-value conversion);
//   map:        a local built field by field from the item and appended -> mapTo { Field: value } with the fields in the order
//               of the record (the order the platform prints; another order reads back as a second mapping), on both lanes:
//               the expression's own text on ODC, the argument's TypeConversion on O11 (on both, every mandatory attribute is
//               named: the identifier the local leaves empty is NullIdentifier()). The patch says what the loop says only when
//               the local is another type than the item (some fields copied into the same type are no mapping), no value reads
//               the local it builds and nothing outside the loop reads or writes it; otherwise the fix is in words.
// What the text cannot say for certain (the type of a list the screen declares, the sources of a screen aggregate, the order of
// a record's attributes) comes from IFlowTypes, the apply's; without it that patch is not certain and the problem has none.
public sealed partial class FlowDiff
{
    private static readonly HashSet<string> ValueTypes = new(StringComparer.OrdinalIgnoreCase)
        { "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Date Time", "DateTime", "Time", "Currency", "Email", "Phone Number" };
    private static readonly Regex AggregateList = new(@"^\s*([A-Za-z_][A-Za-z0-9_]*)\.List\s*$", RegexOptions.CultureInvariant);

    private enum Appended { Row, RowRecord, Value, Map }

    private void ForEachRule(FlowItem edited)
    {
        var nodes = edited.Items.Where(i => i.Role == "node").ToDictionary(i => i.Key, StringComparer.Ordinal);
        var odc = Anvil.Core.MessageExpectations.Lane == "odc";
        // A For Each of the read a three-way merge writes again is the action's own (preserved), not a new one.
        foreach (var loop in nodes.Values.Where(n => n.Kind == "ForEachNode" && Fresh(n))) {
            var body = new List<FlowItem>(); var pending = new Stack<string>(); var seen = new HashSet<string>(StringComparer.Ordinal);
            var escapes = false;
            if (loop.Edges.GetValueOrDefault("CycleTarget") is { Length: > 0 } first) pending.Push(first);
            while (pending.TryPop(out var key)) {
                if (key == loop.Key || !seen.Add(key)) continue;
                if (!nodes.TryGetValue(key, out var node)) { escapes = true; continue; }
                body.Add(node);
                var next = Next(node).ToList();
                if (next.Count == 0) { escapes = true; continue; }
                foreach (var target in next) pending.Push(target);
            }
            // One ListAppend, Ifs, assigns and comments: anything else (a ListAppendAll that flattens, a call, a query) is a loop
            // the team allows. A ListInsert at the end of the list (Position = List.Length) is that append written another way
            // (the reviews of rounds 1 and 2: t1-listinsert, t2-listinsert-copy); one at another position is not an append.
            var appends = body.Where(n => n.Kind == "Execute" && Callee(n) is "ListAppend" or "ListAppendAll" or "ListInsert").ToList();
            if (escapes || appends.Count != 1 || !AppendsAtTheEnd(appends[0])
                || body.Any(n => n.Kind is not ("AssignNode" or "IfNode" or "Execute" or "CommentNode") || n.Kind == "Execute" && !appends.Contains(n))) continue;
            var append = appends[0];
            var list = Argument(append, "List") ?? "?";
            var element = Argument(append, "Element") ?? "?";
            var source = loop.Prop("RecordList") ?? "?";
            var current = source + ".Current";
            var assignments = body.Where(n => n.Kind == "AssignNode").SelectMany(n => n.Items.Where(i => i.Role == "assignment"))
                .Select(a => (Variable: a.Prop("Variable") ?? "", Value: a.Prop("Value") ?? "")).ToList();
            // Every assignment builds the element appended (the element itself, or one of its fields); else the body does more.
            if (assignments.Any(a => !Same(a.Variable, element) && !a.Variable.StartsWith(element.Trim() + ".", StringComparison.OrdinalIgnoreCase))) continue;
            var id = mapped.FirstOrDefault(m => m.Value == loop.Key).Key ?? "";
            var why = new List<string>();
            // A loop with a limit (max) or a first item (start) appends only part of the list; ListFilter and ListAppendAll take
            // every item, so a List action would append more than the loop: no certain patch (correction 2, a client module).
            if (loop.Prop("MaximumIterations") is { } maximum && maximum.Trim().Length > 0)
                why.Add("the loop stops after " + maximum.Trim() + " items (max), and a List action takes every item of " + source);
            if (loop.Prop("StartIndex") is { } startAt && startAt.Trim().Length > 0)
                why.Add("the loop starts at item " + startAt.Trim() + " (start), and a List action takes every item of " + source);
            // What is appended: the item, the entity of an aggregate's row, a value read from the item, or a variable built
            // field by field. A variable is certain only as a local of this action that nothing after the loop reads (the loop
            // leaves the last item in it; the List action leaves it alone).
            var variable = assignments.Count > 0;
            if (variable && !(edited.Items.Any(i => i.Role == "local" && Same(i.Name, element)) && !MentionedOutside(edited, body.Select(b => b.Key).Append(loop.Key), element)))
                why.Add(element + " is not a local of " + edited.Name + " that only the loop uses");
            Appended shape; string? value = null; (string Alias, string Record)? row = null;
            var fields = new List<(string Field, string? Value)>();
            if (variable && assignments.All(a => Same(a.Variable, element))) {
                // A variable that takes one value per item: the value is what is appended.
                if (assignments.Count > 1) why.Add(element + " is assigned twice in the loop");
                (shape, value, row) = Classify(edited, assignments[^1].Value, source, current, why);
            } else if (variable) {
                shape = Appended.Map;
                fields = assignments.Select(a => (Field: a.Variable.Trim().Length > element.Trim().Length ? a.Variable.Trim()[(element.Trim().Length + 1)..] : "", Value: Relative(a.Value, current))).ToList();
                if (fields.Any(f => !FlowSyntax.IsIdentifier(f.Field)) || fields.Select(f => f.Field).Distinct(StringComparer.OrdinalIgnoreCase).Count() != fields.Count)
                    why.Add("each assignment writes one field of " + element + " once");
                if (fields.Any(f => f.Value == null)) why.Add("a field reads the item whole, which a mapping cannot name");
                // The mapping says what the loop says only when it is one: a value that reads the local it builds would read the
                // item instead, and some fields copied into the item's own type are no mapping (the platform refuses it).
                if (assignments.Any(a => Mentions(a.Value, element.Trim()))) why.Add("a value reads " + element.Trim() + ", which the loop builds (a mapping reads only the item)");
                if (TypeOf(edited, element) is { } elementType && ItemType(edited, source) is { } itemType && Same(elementType, itemType))
                    why.Add(element.Trim() + " is a " + itemType + ", the type of the item: copying some of its fields is no mapping");
            } else (shape, value, row) = Classify(edited, element, source, current, why);
            // Each If keeps the append on one branch only: that branch's condition (negated on the false branch) filters.
            var conditions = new List<string>();
            var tests = body.Where(n => n.Kind == "IfNode").ToList();
            foreach (var test in tests) {
                var onTrue = Reaches(nodes, test.Edges.GetValueOrDefault("TrueTarget", ""), append.Key, loop.Key);
                var onFalse = Reaches(nodes, test.Edges.GetValueOrDefault("FalseTarget", ""), append.Key, loop.Key);
                var condition = test.Prop("Condition") ?? "";
                if (onTrue == onFalse) { why.Add("an If whose branches both reach the append, or neither: no one filter"); continue; }
                if (variable && Mentions(condition, element)) why.Add("a condition reads " + element + ", which the loop builds");
                conditions.Add(onTrue ? condition : "not (" + condition + ")");
            }
            var filtered = tests.Count > 0;
            var rule = shape is Appended.Row or Appended.RowRecord
                ? (filtered ? "T1: the loop only filters " + source + " into " + list : "T2: the loop only copies " + source + " into " + list)
                : "T2: the loop only maps " + source + " into " + list + (filtered ? " (with a filter)" : "");
            // The values of the patch are written as the text writes an argument (escaped when a plain one would not read back).
            string V(string text) => FlowSyntax.Expr(text, FlowPrinter.CallValue);
            // The condition of the filter. In a client flow the lambda reads the item's attributes directly (the team rule: a client
            // ListFilter never advances Source.Current, so Source.Current.X compares every row with the same one); a condition
            // that reads the item whole has no such form, and that patch is not certain.
            var lambda = conditions.Count == 0 ? null : Join(conditions);
            if (lambda != null && ClientFlow(edited)) {
                if (Relative(lambda, current) is { } bare) lambda = bare;
                else why.Add("the condition reads the item whole, and a client ListFilter reads only its attributes");
            }
            // What ListAppendAll takes, by what is appended and the lane.
            var from = lambda == null ? source : "\u0001.FilteredList";
            string? sourceList = null;
            switch (shape) {
                case Appended.Row: sourceList = from; break;
                case Appended.RowRecord:
                    if (!odc) { sourceList = from; break; }   // O11 converts a row of one entity to that entity
                    sourceList = from + " mapTo {  }";
                    if (!(TypeOf(edited, list) is { } listType && Same(listType, row!.Value.Record + " List")))
                        why.Add("the type of " + list + " is not known to be " + row!.Value.Record + " List (ODC converts the row with mapTo {  } only into its entity)");
                    break;
                case Appended.Value:
                    if (value == null) break;
                    sourceList = from + " mapTo { Value: " + value + " }";
                    if (!(TypeOf(edited, list) is { } valueType && valueType.Trim().EndsWith(" List", StringComparison.Ordinal) && ValueTypes.Contains(valueType.Trim()[..^5])))
                        why.Add("the type of " + list + " is not known to be a list of values");
                    break;
                case Appended.Map:
                    if (fields.Any(f => f.Value == null || !FlowSyntax.IsIdentifier(f.Field))) break;
                    var record = TypeOf(edited, element)?.Trim();
                    var order = record == null ? null : types?.AttributesOf(record);
                    if (order == null) why.Add("the order of the attributes of " + (record ?? "the type of " + element) + " is not known (the platform prints a mapping in that order)");
                    else if (fields.FirstOrDefault(f => !order.Contains(f.Field, StringComparer.OrdinalIgnoreCase)) is { Field.Length: > 0 } stranger)
                        why.Add(stranger.Field + " is not an attribute of " + record);
                    else {
                        // The Verify refuses a mapping that leaves a mandatory attribute empty (both lanes: an entity's identifier
                        // always): the loop leaves it as the local had it, which the mapping names when that value is certain (an
                        // entity's identifier: NullIdentifier()).
                        if (record != null) {
                            var mandatory = types?.MandatoryOf(record);
                            if (mandatory == null) why.Add("the mandatory attributes of " + record + " are not known (the Verify refuses a mapping that leaves one empty)");
                            else foreach (var (attribute, fill) in mandatory.Where(m => !fields.Any(f => string.Equals(f.Field, m.Attribute, StringComparison.OrdinalIgnoreCase)))) {
                                if (fill == null) why.Add(attribute + " is mandatory in " + record + " and the loop leaves it as the local had it (the Verify refuses a mapping that leaves it empty)");
                                else fields.Add((attribute, fill));
                            }
                        }
                        fields = fields.OrderBy(f => order.ToList().FindIndex(a => string.Equals(a, f.Field, StringComparison.OrdinalIgnoreCase))).ToList();
                    }
                    sourceList = from + " mapTo { " + string.Join(", ", fields.Select(f => f.Field + ": " + f.Value)) + " }";
                    break;
            }
            var certain = why.Count == 0 && sourceList != null;
            // The List action: the lines of the patch (the text of the problem), with a filter name no node of the action has. A fix
            // that is not certain has no lines: the refusal says it in words.
            string? patch = null;
            if (certain) {
                var filterName = lambda != null ? FreshNodeName("Filter" + (FlowSyntax.IsIdentifier(list) ? list : "List"), edited) : "";
                var filter = lambda == null ? "" : filterName + " = (System).ListFilter(Condition=" + V(lambda) + ", SourceList=" + V(source) + ")\n";
                // A call without a name is named after its action, and a node name is unique in the action: a second ListAppendAll
                // (another loop of the same text, or one the action has) is named as the Studio names a copy, in the patch, so the
                // corrected text reads back as written (correction 2: two loops of one template, the second read as ListAppendAll2).
                var appendName = FreshNodeName("ListAppendAll", edited);
                var appendHead = string.Equals(appendName, "ListAppendAll", StringComparison.Ordinal) ? "" : appendName + " = ";
                patch = filter + appendHead + "(System).ListAppendAll(List=" + V(list) + ", SourceList=" + V(sourceList!.Replace("\u0001", filterName)) + ")";
                // The patch is checked: its lines read as steps of the grammar (a flow of their own, then end).
                try { FlowParser.Parse("server action Patch\n" + string.Concat(patch.Split('\n').Select(l => "  " + l + "\n")) + "  end\n"); }
                catch (FormatException error) { why.Add("the List action does not read (" + error.Message + ")"); patch = null; certain = false; }
            }
            var fix = certain ? "replace the foreach block (its line, its body and its next) with the List action of the patch"
                : "replace the foreach block (its line, its body and its next) with "
                  + (filtered ? "(System).ListFilter(Condition=<what keeps the item>, SourceList=" + source + ") and " : "")
                  + "(System).ListAppendAll(List=" + list + ", SourceList=" + (filtered ? "<the filter>.FilteredList" : source)
                  + (shape is Appended.Value ? " mapTo { Value: <the value of the item> })"
                      : shape is Appended.Map ? " mapTo { <Field>: <value of the item>, ... }) with the fields in the order of the record"
                          + " and every mandatory attribute named"
                      : odc && shape is Appended.RowRecord ? " mapTo {  })" : ")")
                  + "; no patch: " + string.Join("; ", why.Distinct());
            var problem = Problem("FLOW_FOREACH_LIST_ACTION", "the new For Each @" + id + " over " + source + " only "
                + (rule.StartsWith("T1", StringComparison.Ordinal) ? "filters into a list" : rule.Contains("maps") ? "maps into a list" : "copies into a list")
                + " (" + rule + "); the team rule is a List action, never a new For Each for that", id, fix, patch);
            // The patch of the job: the text with the foreach block replaced by those lines (checked in Correct); the local the
            // loop built the element in, which only the loop used, goes with it.
            if (certain) corrections.Add(new BlockFix(problem, loop.Key, patch!.Split('\n'), [], DropLocal: variable ? element.Trim() : null));
        }
        static string Join(List<string> conditions) => conditions.Count == 1 ? conditions[0] : string.Join(" and ", conditions.Select(c => "(" + c + ")"));
    }

    // ListAppend, or ListInsert whose Position is the list's own Length (the end of the list: the same append).
    private static bool AppendsAtTheEnd(FlowItem call)
    {
        if (Callee(call) == "ListAppend") return true;
        if (Callee(call) != "ListInsert" || Argument(call, "List") is not { } list || Argument(call, "Position") is not { } position) return false;
        static string Bare(string text) => Regex.Replace(text, @"\s+", "");
        return string.Equals(Bare(position), Bare(list) + ".Length", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The owner's rules on what an op other than the text form wrote new in an action (the JSON form of the logic op,
    /// round 1 and 2 of the reviews: it skipped them): decision 6 (a new JavaScript node outside an isolated, named client
    /// action) and T1/T2 (a new For Each that only filters, copies or maps into a list, refused always, decision 5), judged on
    /// the action as the candidate model has it (the reader's FlowItem, model keys). isNew: the nodes the op wrote new (the
    /// others are the action's own: preserved). Without the text the patch of the job is not written; a problem keeps the fix
    /// in words and, for T1/T2 when it is certain, the List action's lines (Patch) the text form would write.</summary>
    public static List<FlowProblem> NewElementRules(FlowItem action, Func<FlowItem, bool> isNew, IFlowTypes? types, Func<string, bool>? actionTaken = null)
    {
        var copy = action.Clone();
        var diff = new FlowDiff(null, new Dictionary<string, string>(), null, AliasPrefix + "j.", null, actionTaken, allowQueryInLoop: true, correct: false, types, null);
        // The new nodes take an alias (they are Fresh), named for the messages by their name, label or kind; connectors follow.
        var alias = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var node in copy.Items.Where(i => i.Role == "node" && isNew(i))) {
            var shown = node.Name.Length > 0 ? node.Name : node.Prop("Label") is { Length: > 0 } label ? label : node.Kind;
            for (var n = 2; diff.mapped.ContainsKey(shown); n++) shown = (node.Name.Length > 0 ? node.Name : node.Prop("Label") ?? node.Kind) + "#" + n;
            alias[node.Key] = diff.NewAlias();
            diff.mapped[shown] = alias[node.Key];
        }
        void Rekey(FlowItem item)
        {
            foreach (var edge in item.Edges.Keys.ToList()) if (alias.TryGetValue(item.Edges[edge], out var to)) item.Edges[edge] = to;
            foreach (var part in item.Items.Where(p => !FlowItem.Keyed(p.Role))) Rekey(part);
        }
        foreach (var node in copy.Items.Where(i => i.Role == "node")) {
            Rekey(node);
            if (alias.TryGetValue(node.Key, out var to)) node.Key = to;
        }
        diff.ForEachRule(copy);
        diff.JavaScriptRule(copy);
        return diff.Problems;
    }

    // What an appended value is: the item; the record of one source of the aggregate the loop reads (its row names it); or a
    // value read from the item (relative to it, as a mapping reads; null when it reads the item whole).
    private (Appended Shape, string? Value, (string Alias, string Record)? Row) Classify(FlowItem edited, string appended, string source, string current, List<string> why)
    {
        if (Same(appended, current)) return (Appended.Row, null, null);
        var relative = Relative(appended, current);
        if (relative != null && FlowSyntax.IsIdentifier(relative.Trim()) && AggregateList.Match(source) is { Success: true } aggregate) {
            var sources = SourcesOf(edited, aggregate.Groups[1].Value);
            if (sources?.FirstOrDefault(s => Same(s.Alias, relative)) is { Alias.Length: > 0 } hit) return (Appended.RowRecord, null, hit);
            if (sources == null) {
                why.Add("the sources of " + aggregate.Groups[1].Value + " are not known (" + relative + " may be its entity or a column)");
                return (Appended.RowRecord, null, (relative.Trim(), relative.Trim()));
            }
        }
        if (relative == null) why.Add("the value reads the item whole, which a mapping cannot name");
        return (Appended.Value, relative, null);
    }

    // The type of a name the action reads: its own parameter or local, else what the module says (IFlowTypes).
    private string? TypeOf(FlowItem edited, string name)
    {
        var bare = name.Trim();
        if (edited.Items.FirstOrDefault(i => i.Role is "in" or "out" or "local" && Same(i.Name, bare)) is { } declared) return declared.Prop("DataType");
        return FlowSyntax.IsIdentifier(bare) ? types?.TypeOf(bare) : null;
    }

    // The type of an item of the list a loop reads (a list parameter or local, or one the module says), or null.
    private string? ItemType(FlowItem edited, string list) =>
        TypeOf(edited, list)?.Trim() is { } type && type.EndsWith(" List", StringComparison.Ordinal) ? type[..^5].Trim() : null;

    // The sources of an aggregate: a node of the text, else one of the screen (IFlowTypes).
    private IReadOnlyList<(string Alias, string Record)>? SourcesOf(FlowItem edited, string aggregate)
    {
        if (edited.Items.FirstOrDefault(i => i.Role == "node" && i.Kind == "AggregateNode" && Same(i.Name, aggregate)) is { } node)
            return node.Items.Where(i => i.Role == "source").Select(s => (s.Name, s.Prop("Source") ?? s.Name)).ToList();
        return types?.SourcesOf(aggregate);
    }

    // Whether a node outside the loop (its body and itself) reads the name in any expression.
    private static bool MentionedOutside(FlowItem edited, IEnumerable<string> inside, string name)
    {
        var skip = inside.ToHashSet(StringComparer.Ordinal);
        foreach (var node in edited.Items.Where(i => i.Role == "node" && !skip.Contains(i.Key)))
            if (Expressions(node).Any(v => Mentions(v, name.Trim()))) return true;
        return false;
        static IEnumerable<string> Expressions(FlowItem item) =>
            item.Props.Values.Where(p => p.Type == 'e').Select(p => p.Text).Concat(item.Items.SelectMany(Expressions));
    }
}
