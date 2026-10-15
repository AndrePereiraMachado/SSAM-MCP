using System.Text.RegularExpressions;

namespace Anvil.Reading;

/// <summary>The errors of a text the ssam-flow/1 grammar refuses, every one of them in the order the parse meets them (the
/// first is the message): each is a FLOW_SYNTAX problem of the same refusal.</summary>
public sealed class FlowSyntaxException(IReadOnlyList<string> errors) : FormatException(errors[0])
{
    public IReadOnlyList<string> Errors { get; } = errors;
}

/// <summary>One edit of the lenient parse (FlowParser.Edits): a line inserted before line <see cref="Line"/> (1-based, of the
/// text as given; after the last line at its end), or, in that line, <see cref="From"/> replaced by <see cref="To"/> (From
/// null: To appended).</summary>
public sealed record FlowTextEdit(string Rule, int Line, bool Insert, string? From, string To, string Message)
{
    public const string FallsThrough = "FLOW_BRANCH_FALLS_THROUGH";
    public const string LabelSpacing = "FLOW_LABEL_SPACING";
    public const string AssignmentIndent = "FLOW_ASSIGNMENT_INDENT";
    public const string NewActionIds = "FLOW_NEW_ACTION_IDS";
    public const string MappingRelative = "FLOW_MAPPING_RELATIVE";
    public const string SortDirection = "FLOW_SORT_DIRECTION";
    public const string AggregateSqlShape = "FLOW_AGGREGATE_SQL_SHAPE";

    /// <summary>The text with the edits applied, in order (the inserts before a line in the order they were made).</summary>
    public static string Apply(string text, IReadOnlyList<FlowTextEdit> edits)
    {
        var raw = text.Replace("\r\n", "\n").Split('\n');
        var result = new List<string>(raw.Length + edits.Count);
        var last = edits.Count == 0 ? 0 : edits.Max(e => e.Line);
        for (var number = 1; number <= Math.Max(raw.Length, last); number++) {
            foreach (var edit in edits.Where(e => e.Insert && e.Line == number)) result.Add(edit.To);
            if (number > raw.Length) continue;
            var line = raw[number - 1];
            foreach (var edit in edits.Where(e => !e.Insert && e.Line == number)) {
                if (edit.From == null) { line += edit.To; continue; }
                var at = line.LastIndexOf(edit.From, StringComparison.Ordinal);
                if (at >= 0) line = line[..at] + edit.To + line[(at + edit.From.Length)..];
            }
            result.Add(line);
        }
        // An insert after the last line of a text that ends with a line break keeps the break at the end.
        if (raw.Length > 0 && raw[^1].Length == 0 && result.Count > 0 && result[^1].Length != 0) result.Add("");
        return string.Join("\n", result);
    }
}

/// <summary>A fall-through with two readings (FlowParser.Lenient): the branch that ends without a terminator before line
/// <see cref="Line"/> either goes on to the step after its block (<see cref="Through"/>: `-> @id`, the step named when it had
/// no id) or ends there (<see cref="Ends"/>: `end`, `next` in a loop body). Never applied: the line stays a FLOW_SYNTAX
/// problem whose fix names both.</summary>
public sealed record FlowTextAmbiguity(int Line, IReadOnlyList<FlowTextEdit> Through, IReadOnlyList<FlowTextEdit> Ends);

/// <summary>
/// The deterministic normalizations of a ssam-flow/1 text a job sends (Preflight.JobNormalizer, the owner's rule "a shape the
/// engine can only read one way is rewritten and listed, never refused"). Each is kept only when the edited text parses and
/// says what the text meant; anything with two readings stays a FLOW_SYNTAX (or other) problem with its fix.
/// <list type="bullet">
/// <item>FLOW_BRANCH_FALLS_THROUGH: a branch whose block ends without a terminator goes on to what follows its block, as in
/// any structured language, where that is its only reading: `next` back to its loop (a For Each body), `end` at the end of the
/// main flow or a handler, `-> @id` to an end that follows its block (named @j1, @j2... when the text gave it no id). A
/// branch before its If's false branch has two readings (going on there, or a forgotten terminator), also one that ends on an
/// If with no false step (that If's false path goes on or ends): never rewritten, its FLOW_SYNTAX names both (Ambiguities).</item>
/// <item>FLOW_LABEL_SPACING: a label after one space (`assign # Prepare`) is the label: a # date literal never has a space
/// after its #.</item>
/// <item>FLOW_ASSIGNMENT_INDENT: an assignment line one level shallower than the assign block above it, which no step reads
/// and whose value has no shape of a node line (an aggregate, a call with named arguments...), is one of the block's
/// assignments.</item>
/// <item>FLOW_NEW_ACTION_IDS: a new action (no @key in the header) has no read, so an id of the read's pattern (@n12, @p1,
/// @l3) only labels a new element: it becomes @x&lt;id&gt; (FlowDiff refuses read ids no read gave).</item>
/// <item>FLOW_MAPPING_RELATIVE (a new action): inside `L mapTo { Field: ... }`, every `L.Current.` of a value (outside its
/// texts) is the item's: `L.Current.X` is `X` (the values of a mapping are relative to the item it maps; L.Current would be
/// the list's cursor, not the item), on every line that has the mapping. A value that still reads `L.Current` (the item
/// whole) is refused, FLOW_MAPPING_CURSOR (Cursors); the cursor in an edit of a read is the apply's (it knows the read).</item>
/// <item>FLOW_SORT_DIRECTION: an aggregate sort key written `X DESC` (or `X ASC`) is `X desc` (or `X`): the grammar's
/// direction word, never an expression.</item>
/// <item>FLOW_AGGREGATE_SQL_SHAPE: SQL JOINs become explicit source pairs, repeated clauses are joined, and clauses
/// are put in grammar order. Conditions stay literal; more than one possible left source, or repeated MAX/START,
/// remains refused with the candidates.</item>
/// </list>
/// </summary>
public static class FlowTextNormalizer
{
    public sealed record Normalized(string Text, IReadOnlyList<FlowTextEdit> Edits);

    /// <summary>The text with its certain normalizations and the edits made (none: the same text).</summary>
    public static Normalized Normalize(string text)
    {
        var current = text;
        var done = new List<FlowTextEdit>();
        // The structure (fall-through, labels, slips), only when the edited text parses whole: a text with another error
        // goes as written, and the refusal names every error of it.
        if (!Parses(current)) {
            var edits = FlowParser.Edits(current);
            if (edits.Count > 0) {
                var edited = FlowTextEdit.Apply(current, edits);
                if (Parses(edited)) { done.AddRange(edits); current = edited; }
            }
            if (!Parses(current)) return new(text, []);
        }
        Step(ref current, done, NewActionIds);
        Step(ref current, done, MappingValues);
        Step(ref current, done, SortDirections);
        return new(current, done);
    }

    private static bool Parses(string text)
    {
        try { ModuleFlow.Read(text); return true; } catch (FormatException) { return false; }
    }

    /// <summary>The certain edits of a text that still has another error: the edited text, the edits and the lines whose
    /// errors they remove. Verified by reading the edited text: it has exactly the errors of the text minus those of the
    /// edited lines. Null when there is no such edit (or the text normalizes whole: Normalize keeps it).</summary>
    public sealed record Partial(string Text, IReadOnlyList<FlowTextEdit> Edits, IReadOnlySet<int> Lines);

    public static Partial? Corrected(string text)
    {
        var before = SyntaxErrors(text);
        if (before.Count == 0) return null;
        var edits = FlowParser.Edits(text);
        if (edits.Count == 0) return null;
        var edited = FlowTextEdit.Apply(text, edits);
        var after = SyntaxErrors(edited);
        if (after.Count == 0) return null;
        var lines = edits.Select(e => e.Line).ToHashSet();
        var removed = before.Count(e => LineOf(e) is { } n && lines.Contains(n));
        return removed > 0 && after.Count == before.Count - removed ? new(edited, edits, lines) : null;
    }

    /// <summary>The line an error of the parse names ("line 12: ..."), if any.</summary>
    public static int? LineOf(string error)
    {
        var match = Regex.Match(error, @"^line ([0-9]+): ", RegexOptions.CultureInvariant);
        return match.Success ? int.Parse(match.Groups[1].Value) : null;
    }

    private static List<string> SyntaxErrors(string text)
    {
        try { ModuleFlow.Read(text); return []; }
        catch (FlowSyntaxException error) { return error.Errors.ToList(); }
        catch (FormatException error) { return [error.Message]; }
    }

    // A step on a text that parses: kept when the result parses too.
    private static void Step(ref string text, List<FlowTextEdit> done, Func<string, FlowItem, List<FlowTextEdit>> step)
    {
        try {
            var edits = step(text, ModuleFlow.Read(text));
            if (edits.Count == 0) return;
            var edited = FlowTextEdit.Apply(text, edits);
            if (!Parses(edited)) return;
            done.AddRange(edits);
            text = edited;
        } catch (Exception) { /* a normalization never refuses: the checks judge what stays */ }
    }

    private static readonly Regex ReadId = new(@"^[npl][0-9]+$", RegexOptions.CultureInvariant);

    // FLOW_NEW_ACTION_IDS: the read-pattern ids of a text without @key (every line that writes one: its own id, a jump, an
    // attached comment, a repeated end).
    private static List<FlowTextEdit> NewActionIds(string text, FlowItem action)
    {
        var edits = new List<FlowTextEdit>();
        if (action.Key.Length > 0) return edits;
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in action.Items) {
            if (FlowItem.Keyed(item.Role) && ReadId.IsMatch(item.Key)) ids.Add(item.Key);
            foreach (var target in item.Edges.Values) if (ReadId.IsMatch(target)) ids.Add(target);
            foreach (var parameter in item.Items.Where(p => FlowItem.Keyed(p.Role) && ReadId.IsMatch(p.Key))) ids.Add(parameter.Key);
        }
        if (ids.Count == 0) return edits;
        var taken = new HashSet<string>(Regex.Matches(text, @"(?<= @)[A-Za-z0-9_+/=.#-]+").Select(m => m.Value), StringComparer.Ordinal);
        var renamed = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var id in ids.OrderBy(i => i, StringComparer.Ordinal)) {
            var to = "x" + id;
            while (taken.Contains(to)) to = "x" + to;
            renamed[id] = to;
            taken.Add(to);
        }
        var lines = text.Replace("\r\n", "\n").Split('\n');
        for (var n = 0; n < lines.Length; n++) {
            var content = lines[n].TrimStart(' ');
            foreach (var (id, to) in renamed) {
                // The line's own id (its last token), a jump (-> @id), a repeated end and an attached comment (//-> @id text).
                if (content.EndsWith(" @" + id, StringComparison.Ordinal) || content == "-> @" + id)
                    edits.Add(new FlowTextEdit(FlowTextEdit.NewActionIds, n + 1, false, "@" + id, "@" + to, Renamed(id, to)));
                else if (content.StartsWith("//-> @" + id + " ", StringComparison.Ordinal))
                    edits.Add(new FlowTextEdit(FlowTextEdit.NewActionIds, n + 1, false, "//-> @" + id + " ", "//-> @" + to + " ", Renamed(id, to)));
            }
        }
        return edits;

        static string Renamed(string id, string to) => "@" + id + " is an id of a read, and a new action has none: it only labels a new element here, written @" + to;
    }

    // FLOW_MAPPING_RELATIVE: the values of a mapping over a list that read the list's Current, in a new action (an edit of a
    // read is the apply's: only it knows which values the text changed).
    private static List<FlowTextEdit> MappingValues(string text, FlowItem action) =>
        action.Key.Length > 0 ? [] : CursorEdits(text, action, CursorValues(action).Where(c => c.Relative != null).ToList());

    /// <summary>A mapping value of an action that reads its source's Current: its node, the value, and the mapping written
    /// relative to the item (every `S.Current.` of its values outside texts taken out), null when a value still reads
    /// `S.Current` (the item whole, which a mapping has no name for).</summary>
    public sealed record CursorValue(FlowItem Node, FlowItem Part, string Value, string Source, string? Relative);

    /// <summary>Every mapping value of the action whose values read the source's Current (assignments and arguments).</summary>
    public static List<CursorValue> CursorValues(FlowItem action)
    {
        var found = new List<CursorValue>();
        foreach (var node in action.Items.Where(i => i.Role == "node"))
            foreach (var part in node.Items.Where(p => p.Role is "assignment" or "argument"))
                if (part.Prop("Value") is { } value && RelativeMapping(value) is { } relative)
                    found.Add(new CursorValue(node, part, value, relative.Source, relative.Text));
        return found;
    }

    /// <summary>The mapping `S mapTo { ... }` with every `S.Current.` of its values (outside "texts" and #dates#, at a name
    /// boundary, any case) taken out: Text, or null when a value still reads `S.Current` or is left empty; null whole when the
    /// value is no mapping or none of its values reads S.Current.</summary>
    public static (string Source, string? Text)? RelativeMapping(string value)
    {
        if (!value.Contains(" mapTo {", StringComparison.Ordinal) || FlowMapping.Split(value) is not { } mapping) return null;
        var cursor = mapping.Source + ".Current";
        if (!mapping.Fields.Any(f => Reads(f.Value, cursor))) return null;
        var fields = mapping.Fields.Select(f => (f.Field, Value: Without(f.Value, cursor + "."))).ToList();
        if (fields.Any(f => f.Value.Length == 0 || Reads(f.Value, cursor))) return (mapping.Source, null);
        return (mapping.Source, FlowMapping.Compose(mapping.Source, fields));
    }

    // The places of a token in an expression outside its "texts" ("" inside one) and #dates#, at a name boundary before it.
    private static IEnumerable<int> Outside(string value, string token)
    {
        for (var i = 0; i < value.Length;) {
            var c = value[i];
            if (c == '"') {
                i++;
                while (i < value.Length && !(value[i] == '"' && !(i + 1 < value.Length && value[i + 1] == '"'))) i += value[i] == '"' ? 2 : 1;
                i++;
                continue;
            }
            if (c == '#') { var end = value.IndexOf('#', i + 1); if (end < 0) yield break; i = end + 1; continue; }
            if (string.Compare(value, i, token, 0, token.Length, StringComparison.OrdinalIgnoreCase) == 0
                && (i == 0 || !(char.IsLetterOrDigit(value[i - 1]) || value[i - 1] is '_' or '.'))) { yield return i; i += token.Length; continue; }
            i++;
        }
    }

    // Whether the value reads the cursor (the token not followed by more of a name: L.Current, L.Current.X).
    private static bool Reads(string value, string cursor) =>
        Outside(value, cursor).Any(i => i + cursor.Length >= value.Length || !(char.IsLetterOrDigit(value[i + cursor.Length]) || value[i + cursor.Length] == '_'));

    private static string Without(string value, string prefix)
    {
        var result = new System.Text.StringBuilder();
        var from = 0;
        foreach (var i in Outside(value, prefix).ToList()) { result.Append(value, from, i - from); from = i + prefix.Length; }
        return result.Append(value, from, value.Length - from).ToString();
    }

    /// <summary>The edits that write these values relative to the item, on the lines of their nodes (the node's line and the
    /// lines under it; descriptions, comments and code lines never), each line that has the value once per time it has it.</summary>
    public static List<FlowTextEdit> CursorEdits(string text, FlowItem action, IReadOnlyList<CursorValue> values)
    {
        var edits = new List<FlowTextEdit>();
        if (values.Count == 0) return edits;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        Dictionary<string, int> nodeLines;
        try { nodeLines = FlowParser.NodeLines(text); } catch (FormatException) { return edits; }
        static int Depth(string line) => line.Length - line.TrimStart(' ').Length;
        foreach (var group in values.Where(v => v.Relative != null).GroupBy(v => v.Node)) {
            if (!nodeLines.TryGetValue(group.Key.Key, out var number) || number < 1 || number > lines.Length) continue;
            var depth = Depth(lines[number - 1]);
            var block = new List<int> { number };
            for (var n = number + 1; n <= lines.Length && (lines[n - 1].Trim().Length == 0 || Depth(lines[n - 1]) > depth); n++)
                if (lines[n - 1].Trim().Length > 0) block.Add(n);
            foreach (var value in group.Select(v => (v.Value, v.Source, v.Relative!)).Distinct())
                foreach (var n in block) {
                    var content = lines[n - 1].TrimStart(' ');
                    if (content.StartsWith("//", StringComparison.Ordinal) || content.StartsWith('|') || content.StartsWith("@{", StringComparison.Ordinal)) continue;
                    for (var at = lines[n - 1].IndexOf(value.Value, StringComparison.Ordinal); at >= 0; at = lines[n - 1].IndexOf(value.Value, at + value.Value.Length, StringComparison.Ordinal))
                        edits.Add(new FlowTextEdit(FlowTextEdit.MappingRelative, n, false, value.Value, value.Item3,
                            "line " + n + ": a mapping over " + value.Source + " maps each item, so " + value.Source + ".Current.X is the item's X (" + value.Item3 + ")"));
                }
        }
        return edits;
    }

    /// <summary>The mapping values of a new action's text (after its normalizations) that still read their source's Current
    /// (FLOW_MAPPING_CURSOR): the line of the node and the value. Empty for an edit of a read (the apply's) or a text that does
    /// not parse.</summary>
    public static List<(int Line, string Value, string Source)> Cursors(string text)
    {
        FlowItem action;
        try { action = ModuleFlow.Read(text); } catch (FormatException) { return []; }
        if (action.Key.Length > 0) return [];
        Dictionary<string, int> nodeLines;
        try { nodeLines = FlowParser.NodeLines(text); } catch (FormatException) { return []; }
        return CursorValues(action).Where(c => c.Relative == null)
            .Select(c => (nodeLines.GetValueOrDefault(c.Node.Key), c.Value, c.Source)).ToList();
    }

    // ---- FLOW_BRANCH_FALLS_THROUGH with two readings ----------------------------------------------------------------------

    /// <summary>A fall-through with two readings, each verified: the text with that reading (and the certain edits of the
    /// text) has exactly the errors of the text minus those of the lines the edits touch. Through and Ends are the texts,
    /// ThroughEdit and EndsEdit say the edits in words.</summary>
    public sealed record Readings(int Line, string Through, string Ends, string ThroughEdit, string EndsEdit);

    public static List<Readings> Ambiguities(string text)
    {
        var found = new List<Readings>();
        var before = SyntaxErrors(text);
        if (before.Count == 0) return found;
        var (certain, ambiguous) = FlowParser.Lenient(text);
        foreach (var ambiguity in ambiguous) {
            string? Verified(IReadOnlyList<FlowTextEdit> reading)
            {
                var edits = certain.Concat(reading).ToList();
                var edited = FlowTextEdit.Apply(text, edits);
                var after = SyntaxErrors(edited);
                var lines = edits.Select(e => e.Line).Append(ambiguity.Line).ToHashSet();
                var removed = before.Count(e => LineOf(e) is { } n && lines.Contains(n));
                return removed > 0 && after.Count == before.Count - removed ? edited : null;
            }
            if (Verified(ambiguity.Through) is { } through && Verified(ambiguity.Ends) is { } ends)
                found.Add(new Readings(ambiguity.Line, through, ends, Words(ambiguity.Through), Words(ambiguity.Ends)));
        }
        return found;

        static string Words(IReadOnlyList<FlowTextEdit> edits) => string.Join(" and ", edits.Select(e => e.Insert
            ? "insert the line `" + e.To + "` before line " + e.Line : "end line " + e.Line + " with its id `" + e.To + "`"));
    }

    private static readonly Regex Direction = new(@"^(.*\S)\s+(DESC|ASC|Desc|Asc|DESCENDING|ASCENDING|descending|ascending|asc)$", RegexOptions.CultureInvariant | RegexOptions.Singleline);

    // FLOW_SORT_DIRECTION: the sort keys of an aggregate whose text ends with a direction word the grammar does not read.
    private static List<FlowTextEdit> SortDirections(string text, FlowItem action)
    {
        var edits = new List<FlowTextEdit>();
        var lines = text.Replace("\r\n", "\n").Split('\n');
        foreach (var node in action.Items.Where(i => i.Role == "node" && i.Kind == "AggregateNode")) {
            var keys = node.Items.Where(p => p.Role == "sort").ToList();
            if (!keys.Any(k => k.Prop("Attribute") is { } a && Direction.IsMatch(a))) continue;
            var where = Enumerable.Range(0, lines.Length).Where(n => lines[n].Contains("aggregate FROM ", StringComparison.Ordinal) && lines[n].Contains(" SORT ", StringComparison.Ordinal)
                && keys.All(k => lines[n].Contains(k.Prop("Attribute") ?? "\u0001", StringComparison.Ordinal))).ToList();
            if (where.Count != 1) continue;
            var line = lines[where[0]];
            var sortAt = line.LastIndexOf(" SORT ", StringComparison.Ordinal);
            var from = line[sortAt..];
            var to = from;
            var changed = new List<string>();
            foreach (var key in keys) {
                if (key.Prop("Attribute") is not { } attribute || Direction.Match(attribute) is not { Success: true } match) continue;
                var expression = match.Groups[1].Value;
                var descending = match.Groups[2].Value.StartsWith("d", StringComparison.OrdinalIgnoreCase);
                var written = expression + (descending ? " desc" : "");
                var at = to.IndexOf(attribute, StringComparison.Ordinal);
                if (at < 0) { changed.Clear(); break; }
                to = to[..at] + written + to[(at + attribute.Length)..];
                changed.Add(attribute + " -> " + written);
            }
            if (changed.Count == 0 || to == from) continue;
            edits.Add(new FlowTextEdit(FlowTextEdit.SortDirection, where[0] + 1, false, from, to,
                "line " + (where[0] + 1) + ": the direction of a sort key is the word desc after it (ascending is the default): " + string.Join("; ", changed)));
        }
        return edits;
    }
}
