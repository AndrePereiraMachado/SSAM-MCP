using System.Text;

namespace Anvil.Reading;

// Reads ssam-flow/1 text (FlowPrinter's grammar) back into the canonical model. Element ids stay as written unless a key
// table maps them (the printer's table of the same read: ids -> model keys); an id the table does not know is a new
// element. An element line without an id is a new element too (the text a model writes): it gets a fresh id "+1", "+2"...
// that no read gives; a header without a key is a new action. Any line the grammar does not accept throws FormatException
// with its line number, so a text is never read in two ways. A text with errors throws a FlowSyntaxException that names every
// line the grammar refuses (a second pass that records each error and goes on past its line), its first error the message.
// The lenient pass (Edits, used by FlowTextNormalizer only) also writes down the edits that make a text the grammar reads when
// there is one reading of it: a branch that ends without a terminator falls through to what follows its block, as in any
// structured language, where that is its only reading (FLOW_BRANCH_FALLS_THROUGH: a loop body goes back to its loop, the main
// flow and a handler end; a branch before the step that follows its If, whatever its last step (an If with no false step too),
// has two readings, the If's false branch after it or a forgotten terminator, and stays refused with both, Ambiguities); a
// label written with one space ("assign # Prepare") is the label
// (FLOW_LABEL_SPACING); an assignment line one level shallower than the assign block above it, which no node line reads and
// which has no shape of a node line, is one of its assignments (FLOW_ASSIGNMENT_INDENT). The strict parse never applies any.
internal sealed class FlowParser
{
    private enum Mode { Strict, Collect, Lenient }
    private readonly Mode mode;
    private readonly List<(int Depth, string Text, int Number)> lines = [];
    private int at, current;
    private readonly Dictionary<string, FlowItem> nodes = new(StringComparer.Ordinal);
    private FlowItem action = new("action", "");
    private int fresh;
    // The line (1-based, of the text as given) of every node, by the id the text gives it (a fresh one included): the
    // patches of FlowDiff replace a node's block of lines in the text the model wrote (NodeLines).
    private readonly Dictionary<string, int> nodeLines = new(StringComparer.Ordinal);
    // The prefix of the ids the parser gives the elements written without one (never an id of a read).
    public const string FreshPrefix = "+";
    // Collect and Lenient: every error of the text, in the order the strict parse would meet them.
    private readonly List<string> errors = [];
    // Lenient: the raw lines of the text, the edits that normalize it, the ids the text writes and the ids given to the nodes
    // a branch falls through to.
    private readonly string[] raw;
    private readonly List<FlowTextEdit> edits = [];
    private readonly HashSet<string> written = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> joinIds = new(StringComparer.Ordinal);
    private int joins;
    // Lenient: the fall-throughs with two readings (FlowTextAmbiguity), never among the edits.
    private readonly List<FlowTextAmbiguity> ambiguities = [];
    // The chain line that ends a branch at the depth of the main flow (a handler or the unreached islands follow it).
    private static bool EndsMainFlow(string text) => text.StartsWith("on exception ", StringComparison.Ordinal) || text == "unreached:";

    /// <summary>The line of every node of a text (1-based, blank lines counted), by the id the text gives it or the fresh id
    /// the parse gives a line without one (the ids of ModuleFlow.Read(text) without a key table). Throws as Parse does.</summary>
    public static Dictionary<string, int> NodeLines(string text)
    {
        var parser = new FlowParser(text);
        try { parser.Action("start"); }
        catch (FormatException error) when (!error.Message.StartsWith("line ", StringComparison.Ordinal)) { throw Error(parser.current, error.Message); }
        return parser.nodeLines;
    }

    private FlowParser(string text, Mode mode = Mode.Strict)
    {
        this.mode = mode;
        var number = 0;
        // A text with Windows line endings (a client on Windows, a checkout with autocrlf) is the same text: the printer
        // never writes a raw carriage return inside a line (texts that need one are escaped).
        raw = text.Replace("\r\n", "\n").Split('\n');
        foreach (var line in raw) {
            number++;
            if (line.Length == 0) continue;
            var spaces = 0;
            while (spaces < line.Length && line[spaces] == ' ') spaces++;
            if (spaces == line.Length) continue;
            if (spaces % 2 != 0) {
                if (mode == Mode.Strict) throw Error(number, "indentation must be a multiple of two spaces");
                errors.Add(Error(number, "indentation must be a multiple of two spaces").Message);
                // The collecting passes read the line at the depth one space less gives (its block stays under it): a line
                // with an odd indentation is one error, not one more for each line under it.
            }
            lines.Add((spaces / 2, line[spaces..], number));
            if (mode == Mode.Lenient) Written(line[spaces..]);
        }
    }

    public static FlowItem Parse(string text, IReadOnlyDictionary<string, string>? keys = null)
    {
        FlowParser? parser = null;
        FlowItem action;
        // The lexical readers (expressions, escapes, @{...}) say the column; the line is the one being read. An error of the
        // lines themselves (an odd indentation) comes from the constructor with its line.
        try {
            parser = new FlowParser(text);
            action = parser.Action(keys?.GetValueOrDefault("start") ?? "start");
        } catch (FlowRuleFormatException) {
            // A line the grammar reads and a rule of the compiler refuses (tx-publicacao: a column that reads no attribute) keeps
            // its code, fix and certain correction: it is not folded into the syntax errors of the collecting pass (junction 24-1-final).
            throw;
        } catch (FormatException error) {
            var first = error.Message.StartsWith("line ", StringComparison.Ordinal) ? error : Error(parser?.current ?? 0, error.Message);
            throw Every(text, first);
        }
        if (keys != null) Map(action, keys);
        return action;
    }

    // The errors of where a line stands (its depth, a line where none can be), not of what it says.
    private static readonly System.Text.RegularExpressions.Regex Placement = new(@"^line [0-9]+: (?:expected a line at depth |unexpected line: |expected the flow before )",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // Every error of a text the strict parse refused (its first error first): a second pass records each and goes on past
    // its line. A recovery that cannot tell (the second pass finds nothing, or another first error) gives the first alone.
    private static FormatException Every(string text, FormatException first)
    {
        List<string> found;
        try {
            var parser = new FlowParser(text, Mode.Collect);
            parser.Run();
            // One error of where a line stands a line (its first): a line the recovery meets twice (its block ends, then it is no
            // step) is one problem; an error of what the line says stays beside it.
            var seen = new HashSet<int>();
            found = parser.errors.Distinct(StringComparer.Ordinal)
                .Where(e => !Placement.IsMatch(e) || FlowTextNormalizer.LineOf(e) is not { } n || seen.Add(n)).ToList();
            if (found.Count == 0 || found[0] != first.Message) found = [first.Message];
        } catch (Exception) { found = [first.Message]; }
        return new FlowSyntaxException(Accepted(text, found));
    }

    // Each refused line with the line the grammar accepts beside it: the tolerated shape of that line (the text did not read
    // whole with it, so it is no normalization), or the shape to write when no edit is certain (FlowTolerance).
    private static List<string> Accepted(string text, List<string> errors)
    {
        try {
            var (edits, hints) = FlowTolerance.Of(text);
            // A form of the general language that refuses (R7) says what to write beside its line.
            if (FlowGeneral.Uses(text) || text.Contains(" = sql -> ", StringComparison.Ordinal))
                foreach (var problem in FlowGeneral.Expand(edits.Count == 0 ? text : FlowTextEdit.Apply(text, edits)).Problems)
                    if (FlowTextNormalizer.LineOf(problem) is { } at) hints[at] = System.Text.RegularExpressions.Regex.Replace(problem, @"^line [0-9]+: ", "");
            var lines = edits.GroupBy(e => e.Line).ToDictionary(g => g.Key, g => g.Last());
            return errors.Select(e => FlowTextNormalizer.LineOf(e) is not { } n ? e
                : lines.TryGetValue(n, out var edit) ? e + (edit.To.Trim().Length == 0 ? "; accepted form: no line (" + Reason(edit) + ")" : "; accepted form: `" + edit.To + "` (" + Reason(edit) + ")")
                : hints.TryGetValue(n, out var hint) ? e + "; " + hint : e).ToList();
        } catch (Exception) { return errors; }
        static string Reason(FlowTextEdit edit) => System.Text.RegularExpressions.Regex.Replace(edit.Message, @"^line [0-9]+: ", "");
    }

    /// <summary>The edits that make a text the grammar reads where it has one reading (the lenient pass): applied by
    /// FlowTextNormalizer, which keeps them only when the edited text parses (and lists each). Empty for a text that parses.</summary>
    public static List<FlowTextEdit> Edits(string text) => Lenient(text).Edits;

    /// <summary>The lenient pass whole: the certain edits and the fall-throughs with two readings (never among the edits).</summary>
    public static (List<FlowTextEdit> Edits, List<FlowTextAmbiguity> Ambiguities) Lenient(string text)
    {
        try {
            // The tolerated shapes first (FlowTolerance: whole lines, none added or removed), then the structure of the text
            // they give: the numbers of every edit are the lines of the text as given.
            var (tolerated, _) = FlowTolerance.Of(text);
            var parser = new FlowParser(tolerated.Count == 0 ? text : FlowTextEdit.Apply(text, tolerated), Mode.Lenient);
            parser.Run();
            return ([.. tolerated, .. parser.edits], parser.ambiguities);
        } catch (Exception) { return ([], []); }
    }

    // The collecting passes: every error recorded, none thrown (a lexical error says its column; the line is the current one).
    private void Run()
    {
        try { Action("start"); }
        catch (FormatException error) { Record(error); }
    }

    private void Record(FormatException error) =>
        errors.Add(error.Message.StartsWith("line ", StringComparison.Ordinal) ? error.Message : Error(current, error.Message).Message);

    // Lenient: the ids a line writes (its own, a jump's, an attached comment's), so a join id is one the text does not use.
    private void Written(string text)
    {
        if (FlowSyntax.SplitKey(text, out _, out var id)) written.Add(id);
        if (text.StartsWith("-> @", StringComparison.Ordinal)) written.Add(text[4..]);
        if (text.StartsWith("//-> @", StringComparison.Ordinal) && text.IndexOf(' ', 6) is > 6 and var space) written.Add(text[6..space]);
    }

    private static FormatException Error(int number, string message) => new("line " + number + ": " + message);
    private static FormatException Error(int number, string message, string code, string fix) => new FlowRuleFormatException("line " + number + ": " + message, code, fix);
    private FormatException Error(string message) => Error(at < lines.Count ? lines[at].Number : lines.Count > 0 ? lines[^1].Number + 1 : 1, message);

    private (int Depth, string Text, int Number)? Peek => at < lines.Count ? lines[at] : null;
    private bool At(int depth, Func<string, bool> test) => Peek is { } line && line.Depth == depth && test(line.Text);

    private string Next(int depth)
    {
        if (Peek is not { } line) throw Error("unexpected end of text");
        if (line.Depth != depth) throw Error("expected a line at depth " + depth + ", found depth " + line.Depth + ": " + line.Text);
        at++;
        current = line.Number;
        return line.Text;
    }

    private static void Map(FlowItem item, IReadOnlyDictionary<string, string> keys)
    {
        if (FlowItem.Keyed(item.Role) && item.Role != "action" && keys.TryGetValue(item.Key, out var key)) item.Key = key;
        foreach (var edge in item.Edges.Keys.ToList()) if (keys.TryGetValue(item.Edges[edge], out var target)) item.Edges[edge] = target;
        foreach (var child in item.Items) Map(child, keys);
    }

    // ---- elements ------------------------------------------------------------------------------------------------------

    private string? Description(int depth)
    {
        List<string>? text = null;
        while (At(depth, t => t == "///" || t.StartsWith("/// ", StringComparison.Ordinal))) {
            var line = Next(depth);
            (text ??= []).Add(line.Length == 3 ? "" : line[4..]);
        }
        return text == null ? null : string.Join("\n", text);
    }

    // The @{...} line under an element, if any.
    private void Passthrough(FlowItem item, int depth)
    {
        if (!At(depth, t => t.StartsWith("@{", StringComparison.Ordinal))) return;
        var number = Peek!.Value.Number;
        var text = Next(depth);
        try {
            foreach (var (name, value) in FlowSyntax.ReadPassthrough(text)) {
                if (name == "Name" && value.Type == 't') item.Name = value.Text;
                else if (!item.Props.TryAdd(name, value)) throw new FormatException(name + " is written twice");
            }
        } catch (FormatException error) { throw Error(number, error.Message); }
    }

    // The element line and its id; a line without one is a new element, with a fresh id.
    private string Keyed(string text, int number, out string id)
    {
        if (FlowSyntax.SplitKey(text, out var head, out id)) return head;
        id = FreshPrefix + ++fresh;
        return text;
    }

    private static readonly (string Label, string Kind)[] ActionLabels =
        FlowPrinter.Labels.Select(p => (p.Value + " ", p.Key)).OrderByDescending(p => p.Item1.Length).ToArray();

    private FlowItem Action(string startKey)
    {
        var description = Description(0);
        var number = Peek?.Number ?? 1;
        var line = Next(0);
        // The header names the action's model key; without one it is a new action.
        var head = FlowSyntax.SplitKey(line, out var split, out var key) ? split : line;
        if (head == line) key = "";
        var (label, kind) = ActionLabels.FirstOrDefault(l => head.StartsWith(l.Label, StringComparison.Ordinal));
        if (label == null) throw Error(number, "expected an action header (server action, service action, client action, action, data action)");
        var words = head[label.Length..].Split(' ');
        // A screen, block or data action names its owner before its name: action Home.Save, data action Flow/Home.GetOrders.
        var name = words[0]; var owner = "";
        var dot = name.LastIndexOf('.');
        if (dot >= 0) {
            owner = name[..dot]; name = name[(dot + 1)..];
            if (!FlowOwners.Owned(kind)) throw Error(number, "a " + label.Trim() + " belongs to the module: its header names no owner (" + words[0] + "); only a screen, block or data action has one");
            if (!FlowOwners.Valid(owner) || !FlowSyntax.IsIdentifier(name)) throw Error(number, "expected <Owner>.<Name> after " + label.Trim() + " (the screen, block or email, or its Flow/Name path, then the action's name): " + words[0]);
        }
        action = new FlowItem("action", kind, key, name) { Owner = owner };
        foreach (var word in words.Skip(1)) {
            if (word == "public") action.Set("Public", 'v', "True");
            else if (word == "function") action.Set("Function", 'v', "True");
            else if (word.StartsWith("fetch=", StringComparison.Ordinal)) action.Set("Fetch", 'v', word[6..]);
            else throw Error(number, "unknown action flag " + word);
        }
        action.Set("Description", 't', description);
        Guard(() => Passthrough(action, 1), 1);
        while (At(1, t => t.StartsWith("on ", StringComparison.Ordinal) && !t.StartsWith("on exception ", StringComparison.Ordinal))) Guard(() => action.Items.Add(Event()), 1);
        while (true) {
            var mark = at;
            var parameterDescription = Description(1);
            if (At(1, t => t.StartsWith("in ", StringComparison.Ordinal) || t.StartsWith("out ", StringComparison.Ordinal) || t.StartsWith("local ", StringComparison.Ordinal))) {
                Guard(() => action.Items.Add(Parameter(1, parameterDescription, null)), 1);
                continue;
            }
            at = mark;
            break;
        }
        while (true) {
            var mark = at;
            var commentDescription = Description(1);
            if (At(1, t => t.StartsWith("// ", StringComparison.Ordinal) || t.StartsWith("//-> @", StringComparison.Ordinal))) {
                Guard(() => Comment(commentDescription), 1);
                continue;
            }
            at = mark;
            break;
        }
        var start = Node(new FlowItem("node", "StartNode", startKey));
        if (Chain(1, target => start.Edges["Target"] = target, null) is { } tail) EndHere(tail);
        while (true) {
            var mark = at;
            var handlerDescription = Description(1);
            if (At(1, t => t.StartsWith("on exception ", StringComparison.Ordinal))) { Guard(() => Handler(handlerDescription), 1); continue; }
            at = mark;
            break;
        }
        if (At(1, t => t == "unreached:")) {
            Next(1);
            while (Peek is { Depth: 2 }) Chain(2, _ => { }, null);
        }
        if (Peek is { } extra) {
            if (mode == Mode.Strict) throw Error("unexpected line: " + extra.Text);
            Record(Error("unexpected line: " + extra.Text));
        }
        return action;
    }

    // Collect and Lenient: an error of one element is recorded and the parse goes on after its line and the block under it.
    private void Guard(Action read, int depth)
    {
        if (mode == Mode.Strict) { read(); return; }
        var mark = at;
        try { read(); }
        catch (FormatException error) {
            Record(error);
            if (at == mark && Peek != null) at++;
            while (Peek is { } deeper && deeper.Depth > depth) at++;
        }
    }

    // ---- lenient: a branch that ends without a terminator ------------------------------------------------------------------

    // Where a branch that falls through needs its terminator line: before the line Before (the one that ends its block), at
    // its depth; Loop is the For Each its body is in (a fall-through to the loop is `next`). A branch has two readings when what
    // follows its block is the next step of the chain (an If's false branch): going on there, or a forgotten terminator; one
    // only where both say the same (the next step is an end, or `next` back to the same loop). A branch that ends on an If with
    // no false step is no exception (re-check of 2026-10-12, probes N26 and P13): a forgotten terminator after that If is its
    // false branch, so the If's false path either goes on to the outer If's false branch or ends there.
    private sealed record Site(int Before, int Depth, string? Loop);
    // The sites of a branch that ends without a terminator, resolved by what follows its block.
    private sealed record Dangling(List<Site> Sites);

    // The line after the last line of the text (a terminator at the end of the text goes there).
    private int EndOfText => lines.Count > 0 ? lines[^1].Number + 1 : 1;

    // The fall-through of these sites goes to target: `next` back to their loop, `-> @id` anywhere else (a node written
    // without an id gets one the text does not use).
    private void Resolve(List<Site> sites, string target)
    {
        foreach (var site in sites) {
            var line = target.Length == 0 ? "-> (no connector)" : site.Loop != null && target == site.Loop ? "next" : "-> @" + JoinId(target);
            edits.Add(new FlowTextEdit(FlowTextEdit.FallsThrough, site.Before, true, null, new string(' ', site.Depth * 2) + line,
                "a branch at depth " + site.Depth + " ends without a terminator before line " + site.Before + ": it falls through to what follows its block (" + line + ")"));
        }
    }

    // Sites with two readings: the edits of each, kept apart (never applied by the normalizer). Going on: `-> @id` to the step
    // that follows the block (named @jN when the text gave it no id); ending: the terminator a branch of that place has, `next`
    // in a loop body, `end` elsewhere.
    private void Ambiguous(List<Site> sites, string target)
    {
        var through = new List<FlowTextEdit>();
        var stop = new List<FlowTextEdit>();
        FlowTextEdit? named = null;
        var jump = "-> (no connector)";
        if (target.Length > 0) {
            var id = target;
            if (target.StartsWith(FreshPrefix, StringComparison.Ordinal)) {
                id = joinIds.TryGetValue(target, out var known) ? known : NewJoinId();
                if (!joinIds.ContainsKey(target) && nodeLines.TryGetValue(target, out var number))
                    named = new FlowTextEdit(FlowTextEdit.FallsThrough, number, false, null, " @" + id, "line " + number + ", where the branch goes on, is named @" + id);
            }
            jump = "-> @" + id;
        }
        foreach (var site in sites) {
            var indent = new string(' ', site.Depth * 2);
            through.Add(new FlowTextEdit(FlowTextEdit.FallsThrough, site.Before, true, null, indent + jump,
                "the branch at depth " + site.Depth + " goes on to the step after its block (" + jump + ")"));
            var terminator = site.Loop != null ? "next" : "end";
            stop.Add(new FlowTextEdit(FlowTextEdit.FallsThrough, site.Before, true, null, indent + terminator,
                "the branch at depth " + site.Depth + " ends (" + terminator + ")"));
        }
        if (named != null) through.Add(named);
        ambiguities.Add(new FlowTextAmbiguity(sites.Min(s => s.Before), through, stop));
    }

    private string NewJoinId()
    {
        string id;
        do id = "j" + ++joins; while (written.Contains(id) || nodes.ContainsKey(id));
        return id;
    }

    private string JoinId(string target)
    {
        if (!target.StartsWith(FreshPrefix, StringComparison.Ordinal)) return target;
        if (joinIds.TryGetValue(target, out var id)) return id;
        id = joinIds[target] = NewJoinId();
        if (nodeLines.TryGetValue(target, out var number))
            edits.Add(new FlowTextEdit(FlowTextEdit.FallsThrough, number, false, null, " @" + id, "line " + number + ", where a branch falls through, is named @" + id));
        return id;
    }

    // The main flow or a handler that ends without `end`: it ends there (the last site ends it, the others jump to that end).
    private void EndHere(Dangling tail)
    {
        if (tail.Sites.Count == 0) return;
        var id = tail.Sites.Count > 1 ? NewJoinId() : null;
        foreach (var site in tail.Sites.Take(tail.Sites.Count - 1))
            edits.Add(new FlowTextEdit(FlowTextEdit.FallsThrough, site.Before, true, null, new string(' ', site.Depth * 2) + "-> @" + id,
                "a branch at depth " + site.Depth + " ends without a terminator before line " + site.Before + ": it falls through to the end of the flow"));
        var own = tail.Sites[^1];
        edits.Add(new FlowTextEdit(FlowTextEdit.FallsThrough, own.Before, true, null, new string(' ', own.Depth * 2) + (id == null ? "end" : "end @" + id),
            "the flow ends without a terminator before line " + own.Before + ": it ends there"));
    }

    private FlowItem Node(FlowItem node, int number = 0)
    {
        if (!nodes.TryAdd(node.Key, node)) throw number > 0 ? Error(number, "@" + node.Key + " is written twice") : Error("@" + node.Key + " is written twice");
        if (number > 0) nodeLines[node.Key] = number;
        action.Items.Add(node);
        return node;
    }

    private FlowItem Event()
    {
        var number = Peek!.Value.Number;
        var text = Next(1);
        var arrow = text.IndexOf(" -> ", StringComparison.Ordinal);
        if (arrow < 0) throw Error(number, "expected on <Event> -> <Handler>(arguments)");
        var item = new FlowItem("event", "UILifeCycleEvent", "", "On" + text[3..arrow]);
        var i = arrow + 4;
        item.Set("Destination", 'r', Callee(text, ref i, number));
        Arguments(text, ref i, item, number);
        if (i != text.Length) throw Error(number, "unexpected text after the arguments");
        return item;
    }

    // in Name?: Type[ inline] = value @p1; on a node (node != null) the value is the argument the node passes.
    private FlowItem Parameter(int depth, string? description, FlowItem? node)
    {
        var number = Peek!.Value.Number;
        var head = Keyed(Next(depth), number, out var id);
        var space = head.IndexOf(' ');
        var role = head[..space];
        var kind = node?.Kind == "SQLNode" ? "SQLInputParameter" : role switch { "in" => "InputParameter", "out" => "OutputParameter", _ => "LocalVariable" };
        var i = space + 1;
        var start = i;
        while (i < head.Length && (char.IsLetterOrDigit(head[i]) || head[i] == '_')) i++;
        var item = new FlowItem(role, kind, id, head[start..i]);
        if (item.Name.Length == 0) throw Error(number, "expected a parameter name");
        if (i < head.Length && head[i] == '?') { item.Set("IsMandatory", 'v', "False"); i++; }
        string? value = null;
        var rest = head[i..];
        var equals = rest.IndexOf(" = ", StringComparison.Ordinal);
        var typePart = equals < 0 ? rest : rest[..equals];
        if (equals >= 0) {
            var valueText = rest[(equals + 3)..];
            if (valueText.StartsWith('`')) { var j = 0; value = FlowSyntax.ReadEscaped(valueText, ref j); if (j != valueText.Length) throw Error(number, "unexpected text after the value"); }
            else value = valueText;
        }
        if (typePart.Length > 0) {
            if (!typePart.StartsWith(": ", StringComparison.Ordinal) && typePart != " inline") throw Error(number, "expected ': Type' after the name");
            if (node?.Kind == "SQLNode" && typePart.EndsWith(" inline", StringComparison.Ordinal)) { item.Set("ExpandInline", 'v', "True"); typePart = typePart[..^" inline".Length]; }
            if (typePart.Length > 0) {
                if (!typePart.StartsWith(": ", StringComparison.Ordinal)) throw Error(number, "expected ': Type' after the name");
                item.Set("DataType", 'r', typePart[2..]);
            }
        }
        if (node == null) item.Set("DefaultValue", 'e', value);
        else if (!string.IsNullOrEmpty(value)) {
            var argument = new FlowItem("argument", "Argument", "", item.Name);
            argument.Set("Value", 'e', value);
            node.Items.Add(argument);
        }
        item.Set("Description", 't', description);
        Passthrough(item, depth + 1);
        return item;
    }

    private void Comment(string? description)
    {
        var number = Peek!.Value.Number;
        var head = Keyed(Next(1), number, out var id);
        var node = Node(new FlowItem("node", "CommentNode", id), number);
        string text;
        if (head.StartsWith("//-> @", StringComparison.Ordinal)) {
            var space = head.IndexOf(' ', 6);
            if (space < 0) throw Error(number, "expected the comment text after the attached @id");
            node.Edges["Attached"] = head[6..space];
            text = head[(space + 1)..];
        } else text = head[3..];
        var parts = new List<string> { text };
        node.Set("Description", 't', description);
        Passthrough(node, 2);
        while (At(2, t => t == "|" || t.StartsWith("| ", StringComparison.Ordinal))) { var line = Next(2); parts.Add(line.Length == 1 ? "" : line[2..]); }
        node.Set("Text", 't', string.Join("\n", parts));
    }

    private void Handler(string? description)
    {
        var number = Peek!.Value.Number;
        var head = Keyed(Next(1), number, out var id);
        var node = Node(new FlowItem("node", "ExceptionHandlerNode", id), number);
        var rest = head["on exception ".Length..];
        var colon = rest.IndexOf(':');
        if (colon < 0) throw Error(number, "expected ':' after the exception");
        var name = rest[..colon];
        var log = name.EndsWith(" log", StringComparison.Ordinal); if (log) name = name[..^4];
        var abort = name.EndsWith(" abort", StringComparison.Ordinal); if (abort) name = name[..^6];
        node.Set("Exception", 'r', name);
        if (!abort) node.Set("AbortTransaction", 'v', "False");
        if (!log) node.Set("LogError", 'v', "False");
        Label(node, rest[(colon + 1)..], number);
        node.Set("Description", 't', description);
        Passthrough(node, 2);
        if (Chain(2, target => node.Edges["Target"] = target, null) is { } tail) EndHere(tail);
    }

    // One space (or three) before the "# " of a label: a # date literal never has a space after its #, so it is the label.
    private static readonly System.Text.RegularExpressions.Regex LabelSpacing = new(@"^(?: | {3,})# ", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    private void Label(FlowItem node, string rest, int number)
    {
        if (rest.Length == 0) return;
        if (!rest.StartsWith("  # ", StringComparison.Ordinal)) {
            if (mode == Mode.Lenient && LabelSpacing.Match(rest) is { Success: true } spacing) {
                var label = rest[spacing.Length..];
                edits.Add(new FlowTextEdit(FlowTextEdit.LabelSpacing, number, false, rest, "  # " + label,
                    "line " + number + ": the label is written after two spaces (`  # " + label + "`)"));
                node.Props["Label"] = new('t', label);
                return;
            }
            throw Error(number, "unexpected text: " + rest);
        }
        node.Props["Label"] = new('t', rest[4..]);
    }

    // ---- flows -----------------------------------------------------------------------------------------------------------

    // One branch at this depth, to its end; edge receives the id each connector points at. Collect and Lenient: a line the
    // grammar refuses is recorded and skipped with the block under it (the chain goes on from it). Lenient: a branch that
    // ends without a terminator (its block ends) answers the sites its fall-through needs; the branches that fall through
    // inside it (an If's true branch) go where its next element goes (pending): written when that is their only reading,
    // kept apart with both readings (Ambiguous) when it is not. The cases of a Switch that fall through are sites of the
    // branch the Switch ends (nothing follows a Switch in its chain).
    private Dangling? Chain(int depth, Action<string> edge, string? loop)
    {
        List<Site>? pending = null;
        var read = 0;
        // The last line of this chain was refused: its block ending is no error of its own (the line may have been its end).
        var failed = false;
        // ends: the target is an end (a forgotten `end` there would read the same).
        void Connect(string target, bool ends = false)
        {
            edge(target);
            if (pending == null) return;
            var sites = pending;
            pending = null;
            if (mode == Mode.Lenient && sites.Any(s => !(s.Loop != null ? target == s.Loop : ends))) Ambiguous(sites, target);
            else Resolve(sites, target);
        }
        while (true) {
            if (mode != Mode.Strict) {
                var ends = Peek is not { } next || next.Depth < depth || mode == Mode.Lenient && depth == 1 && EndsMainFlow(next.Text);
                if (ends) {
                    if (failed) return null;
                    if (mode == Mode.Lenient && read > 0) {
                        var sites = pending ?? [];
                        sites.Add(new Site(Peek?.Number ?? EndOfText, depth, loop));
                        return new Dangling(sites);
                    }
                    if (Peek is not { } after || after.Depth < depth) {
                        try { Next(depth); } catch (FormatException error) { Record(error); }
                    } else Record(Error(after.Number, "expected the flow before " + after.Text));
                    return null;
                }
                if (Peek is { } deeper && deeper.Depth > depth) {
                    try { Next(depth); } catch (FormatException error) { Record(error); }
                    while (Peek is { } inner && inner.Depth > depth) at++;
                    continue;
                }
            }
            var mark = at;
            FlowItem? stepped = null;
            failed = false;
            try {
                var description = Description(depth);
                var number = Peek?.Number ?? 0;
                var text = Next(depth);
                if (text == "-> (no connector)") { NoDescription(description, number); Connect(""); return null; }
                if (text == "next") { NoDescription(description, number); if (loop == null) throw Error(number, "next outside a foreach"); Connect(loop); return null; }
                if (text.StartsWith("-> @", StringComparison.Ordinal)) { NoDescription(description, number); Connect(text[4..]); return null; }
                var head = Keyed(text, number, out var id);
                if (head == "end" && nodes.TryGetValue(id, out var known)) {
                    if (known.Kind != "EndNode") throw Error(number, "@" + id + " is not an end");
                    NoDescription(description, number);
                    Connect(id, ends: true);
                    return null;
                }
                var node = Node(new FlowItem("node", "", id), number);
                node.Set("Description", 't', description);
                Connect(id, ends: Starts(head, "end"));
                stepped = node;
                read++;
                switch (Head(node, head, depth, number)) {
                    case Flow.If:
                        var branch = Chain(depth + 1, target => node.Edges["TrueTarget"] = target, loop);
                        edge = target => node.Edges["FalseTarget"] = target;
                        if (branch != null) pending = branch.Sites;
                        continue;
                    case Flow.ForEach:
                        // The body that ends without `next` goes back to its loop: its only reading, whatever its last step.
                        if (Chain(depth + 1, target => node.Edges["CycleTarget"] = target, id) is { } body) Resolve(body.Sites, id);
                        edge = target => node.Edges["Target"] = target;
                        continue;
                    case Flow.Switch:
                        var falling = new List<Site>();
                        while (At(depth + 1, t => t.StartsWith("case ", StringComparison.Ordinal))) {
                            var caseNumber = Peek!.Value.Number;
                            var line = Next(depth + 1);
                            if (!line.EndsWith(':')) throw Error(caseNumber, "expected case <expression>:");
                            var option = new FlowItem("case", "SwitchCondition");
                            option.Set("Value", 'e', Whole(line[5..^1], caseNumber));
                            node.Items.Add(option);
                            if (Chain(depth + 2, target => option.Edges["Target"] = target, loop) is { } fell) falling.AddRange(fell.Sites);
                        }
                        if (Next(depth + 1) != "otherwise:") throw Error(number, "expected otherwise: after the cases");
                        if (Chain(depth + 2, target => node.Edges["OtherwiseTarget"] = target, loop) is { } otherwise) falling.AddRange(otherwise.Sites);
                        // A Switch ends its branch (nothing follows it in its chain): the cases that fall through go where the
                        // branch goes after its block (lenient only).
                        return falling.Count == 0 || mode != Mode.Lenient ? null : new Dangling(falling);
                    case Flow.End:
                        return null;
                    default:
                        edge = target => node.Edges["Target"] = target;
                        continue;
                }
            } catch (FormatException error) when (mode != Mode.Strict) {
                Record(error);
                failed = true;
                if (at == mark && Peek != null) at++;
                while (Peek is { } inner && inner.Depth > depth) at++;
                // The failed line stands for a step of the chain: what follows goes on from it.
                if (stepped != null) { var step = stepped; edge = target => step.Edges["Target"] = target; }
            }
        }
    }

    private void NoDescription(string? description, int number) { if (description != null) throw Error(number, "a description belongs to an element line"); }

    // A plain expression standing alone (a case value, a default, an assignment value): escaped or the whole text.
    private static string Whole(string text, int number)
    {
        if (!text.StartsWith('`')) return text;
        var i = 0;
        var value = FlowSyntax.ReadEscaped(text, ref i);
        if (i != text.Length) throw Error(number, "unexpected text after the escaped expression");
        return value;
    }

    private enum Flow { Next, If, ForEach, Switch, End }

    // The word alone or with its label; lenient, a label written after one space (or three) too (Label normalizes it).
    private bool Starts(string text, string word) => text == word || text.StartsWith(word + "  # ", StringComparison.Ordinal)
        || mode == Mode.Lenient && text.Length > word.Length && text.StartsWith(word, StringComparison.Ordinal) && LabelSpacing.IsMatch(text[word.Length..]);

    // The shape of a node line in the value of a line that reads as an assignment: an aggregate, a SQL, a JSON node, a node or
    // opaque line (their keywords in any case), or a call with a named argument (`CreateRec (Source=R)`, `CreateRec(Source = R)`,
    // `(System).ListAppend(List=L, ...)`). Such a line is a node line the grammar refuses (a space before the parenthesis, a
    // typo after FROM), never a slipped assignment. A built-in function of expressions is no callee: `If(A=1, "x", "y")`
    // compares (re-check of 2026-10-12, probes P1, P2, P2b and P3).
    private static readonly System.Text.RegularExpressions.Regex NodeKeyword = new(
        @"^(?:aggregate\s+from\b|sql(?:\s|$)|JSONSerialize\s*\(|JSONDeserialize\s*\(|node\s+[A-Za-z_]|opaque\s+[A-Za-z_])",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static readonly System.Text.RegularExpressions.Regex NamedCall = new(
        @"^(?<system>\(System\)\.)?(?:I\w*:)?(?<callee>[A-Za-z_][\w.]*)\s*\(\s*[A-Za-z_]\w*\s*=(?!=)",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // The built-in functions of expressions (both lanes): their arguments are never named, so `If(A=1, ...)` is a value. A name
    // missing here only makes such a line a node line (refused as written, never a change of meaning).
    private static readonly HashSet<string> ExpressionFunctions = new(StringComparer.OrdinalIgnoreCase) {
        "If", "Concat", "Trim", "TrimStart", "TrimEnd", "Length", "Substr", "Index", "Replace", "ToLower", "ToUpper", "Chr", "NewLine",
        "EncodeHtml", "EncodeJavaScript", "EncodeSql", "EncodeUrl", "FormatText", "FormatDecimal", "FormatCurrency", "FormatPercent", "FormatPhoneNumber",
        "Abs", "Max", "Min", "Mod", "Power", "Round", "Sqrt", "Trunc", "Sign",
        "AddDays", "AddHours", "AddMinutes", "AddMonths", "AddSeconds", "AddYears", "DiffDays", "DiffHours", "DiffMinutes", "DiffSeconds",
        "Year", "Month", "Day", "Hour", "Minute", "Second", "DayOfWeek", "NewDate", "NewDateTime", "NewTime", "BuildDateTime",
        "CurrDate", "CurrDateTime", "CurrTime", "NullDate", "NullIdentifier", "NullTextIdentifier", "NullObject", "NullBinary",
        "BooleanToText", "BooleanToInteger", "IntegerToBoolean", "IntegerToText", "IntegerToDecimal", "IntegerToIdentifier", "IntegerToLongInteger",
        "LongIntegerToText", "LongIntegerToInteger", "LongIntegerToIdentifier", "DecimalToText", "DecimalToInteger", "DecimalToBoolean", "DecimalToLongInteger",
        "TextToInteger", "TextToLongInteger", "TextToDecimal", "TextToDate", "TextToDateTime", "TextToTime", "TextToIdentifier",
        "TextToIntegerValidate", "TextToDecimalValidate", "TextToDateValidate", "TextToDateTimeValidate", "TextToTimeValidate",
        "DateToText", "DateTimeToText", "TimeToText", "DateToDateTime", "DateTimeToDate", "DateTimeToTime", "TimeToDateTime",
        "IdentifierToInteger", "IdentifierToLongInteger", "IdentifierToText", "ToObject" };

    private static bool NodeShape(string value) =>
        NodeKeyword.IsMatch(value)
        || NamedCall.Match(value) is { Success: true } call && (call.Groups["system"].Success || !ExpressionFunctions.Contains(call.Groups["callee"].Value));

    // Lenient: a line one level shallower than the assign block above it that reads as an assignment and as no node line, and
    // whose value has no shape of a node line, is one of that block's assignments (the only reading it has).
    private bool AssignmentSlip(string text, int depth, int number)
    {
        if (FlowSyntax.SplitKey(text, out _, out _)) return false;
        try {
            var j = 0;
            var assignment = Assignment(text, ref j, [], number);
            if (j != text.Length || NodeShape(assignment.Prop("Value") ?? "")) return false;
        }
        catch (FormatException) { return false; }
        // A node line (a call, an aggregate...) is read as one: then it is no slip.
        var (mark, was, given, made, found) = (at, current, fresh, edits.Count, errors.Count);
        try { Head(new FlowItem("node", "", FreshPrefix + "probe"), text, depth, number); return false; }
        catch (FormatException) { return true; }
        finally {
            at = mark; current = was; fresh = given;
            edits.RemoveRange(made, edits.Count - made); errors.RemoveRange(found, errors.Count - found);
        }
    }

    // Reads the head of a node line (without its id) and the lines under it; answers how the flow goes on.
    private Flow Head(FlowItem node, string head, int depth, int number)
    {
        string? name = null;
        var rest = head;
        var equals = head.IndexOf(" = ", StringComparison.Ordinal);
        if (equals > 0 && FlowSyntax.IsIdentifier(head[..equals])) { name = head[..equals]; rest = head[(equals + 3)..]; }
        int i;
        if (name == null) {
            if (rest.StartsWith("if ", StringComparison.Ordinal)) {
                node.Kind = "IfNode"; i = 3;
                node.Set("Condition", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.Colon));
                Expect(rest, ref i, ":", number);
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.If;
            }
            if (rest.StartsWith("switch:", StringComparison.Ordinal)) {
                node.Kind = "SwitchNode";
                Label(node, rest[7..], number);
                Passthrough(node, depth + 1);
                return Flow.Switch;
            }
            if (rest.StartsWith("foreach ", StringComparison.Ordinal)) {
                node.Kind = "ForEachNode"; i = 8;
                node.Set("RecordList", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.ForEachList));
                if (Skip(rest, ref i, " max ")) node.Set("MaximumIterations", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.ForEachMax));
                if (Skip(rest, ref i, " start ")) node.Set("StartIndex", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.Colon));
                Expect(rest, ref i, ":", number);
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.ForEach;
            }
            if (rest.StartsWith("assign ", StringComparison.Ordinal) && !rest.StartsWith("assign  # ", StringComparison.Ordinal)
                && !(mode == Mode.Lenient && LabelSpacing.IsMatch(rest[6..]))) {
                node.Kind = "AssignNode"; i = 7;
                node.Items.Add(Assignment(rest, ref i, FlowPrinter.LabelEnd, number));
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.Next;
            }
            if (Starts(rest, "assign")) {
                node.Kind = "AssignNode";
                Label(node, rest[6..], number);
                Passthrough(node, depth + 1);
                while (Peek is { } line && line.Depth == depth + 1) {
                    var text = Next(depth + 1);
                    // Collect and Lenient: each assignment the grammar refuses is its own error, and the block goes on.
                    try {
                        var j = 0;
                        node.Items.Add(Assignment(text, ref j, [], line.Number));
                        if (j != text.Length) throw Error(line.Number, "unexpected text after the assignment");
                    } catch (FormatException error) when (mode != Mode.Strict) { Record(error); }
                }
                if (mode == Mode.Lenient && node.Items.Count > 0)
                    while (Peek is { } slip && slip.Depth == depth && AssignmentSlip(slip.Text, depth, slip.Number)) {
                        var text = Next(depth);
                        var j = 0;
                        node.Items.Add(Assignment(text, ref j, [], slip.Number));
                        var line = raw[slip.Number - 1];
                        edits.Add(new FlowTextEdit(FlowTextEdit.AssignmentIndent, slip.Number, false, line, "  " + line,
                            "line " + slip.Number + " is an assignment of the assign block above it (no step reads it): indented into the block"));
                    }
                return Flow.Next;
            }
            if (Starts(rest, "end")) {
                node.Kind = "EndNode";
                Label(node, rest[3..], number);
                Passthrough(node, depth + 1);
                return Flow.End;
            }
            if (rest.StartsWith("raise ", StringComparison.Ordinal)) {
                node.Kind = "RaiseExceptionNode";
                var open = rest.IndexOf('(');
                if (open < 0) throw Error(number, "expected raise <Exception>(<message>)");
                node.Set("Exception", 'r', rest[6..open]);
                i = open + 1;
                if (i < rest.Length && rest[i] != ')') node.Set("ExceptionMessage", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.Paren));
                Expect(rest, ref i, ")", number);
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.End;
            }
            if (rest.StartsWith("navigate ", StringComparison.Ordinal)) {
                node.Kind = "DestinationNode"; i = 9;
                node.Set("Destination", 'r', Callee(rest, ref i, number));
                Arguments(rest, ref i, node, number);
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.End;
            }
            if (rest.StartsWith("refresh ", StringComparison.Ordinal)) {
                node.Kind = "RefreshDataNode"; i = 8;
                node.Set("DataSource", 'r', Callee(rest, ref i, number));
                if (Skip(rest, ref i, " max ")) node.Set("MaxRecords", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.RefreshMax));
                if (Skip(rest, ref i, " start ")) node.Set("StartIndex", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.LabelEnd));
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.Next;
            }
            if (rest.StartsWith("message ", StringComparison.Ordinal)) {
                node.Kind = "MessageNode";
                var colon = rest.IndexOf(": ", 8, StringComparison.Ordinal);
                if (colon < 0) throw Error(number, "expected message <Type>: <expression>");
                node.Set("Type", 'v', rest[8..colon]);
                i = colon + 2;
                node.Set("Message", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.LabelEnd));
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.Next;
            }
            if (rest.StartsWith("trigger ", StringComparison.Ordinal)) {
                node.Kind = "TriggerNode"; i = 8;
                node.Set("Event", 'r', Callee(rest, ref i, number));
                Arguments(rest, ref i, node, number);
                Label(node, rest[i..], number);
                Passthrough(node, depth + 1);
                return Flow.Next;
            }
        }
        node.Name = name ?? "";
        if (rest.StartsWith("opaque ", StringComparison.Ordinal)) {
            // A node the text does not carry: its kind, name and connector only (FlowPrinter.Opaque).
            i = 7;
            var start = i;
            while (i < rest.Length && (char.IsLetterOrDigit(rest[i]) || rest[i] == '_')) i++;
            node.Kind = rest[start..i]; node.Opaque = true;
            if (node.Kind.Length == 0) throw Error(number, "expected opaque <Kind>");
            var terminal = Skip(rest, ref i, " end");
            if (i != rest.Length) throw Error(number, "unexpected text after opaque " + node.Kind + ": " + rest[i..]);
            Passthrough(node, depth + 1);
            return terminal ? Flow.End : Flow.Next;
        }
        if (rest.StartsWith("node ", StringComparison.Ordinal)) {
            i = 5;
            var start = i;
            while (i < rest.Length && (char.IsLetterOrDigit(rest[i]) || rest[i] == '_')) i++;
            node.Kind = rest[start..i];
            Arguments(rest, ref i, node, number);
            var terminal = Skip(rest, ref i, " end");
            Label(node, rest[i..], number);
            Passthrough(node, depth + 1);
            return terminal ? Flow.End : Flow.Next;
        }
        if (rest.StartsWith("aggregate FROM ", StringComparison.OrdinalIgnoreCase)) { Query(node, rest, number); Passthrough(node, depth + 1); return Flow.Next; }
        if (Starts(rest, "javascript")) {
            node.Kind = "JavaScriptNode";
            Label(node, rest[10..], number);
            Passthrough(node, depth + 1);
            Parameters(node, depth + 1);
            node.Set("JavaScript", 't', Code(depth + 1));
            return Flow.Next;
        }
        if (rest == "sql" || rest.StartsWith("sql ", StringComparison.Ordinal)) {
            node.Kind = "SQLNode"; i = 3;
            if (Skip(rest, ref i, " -> ")) {
                while (true) {
                    var output = new FlowItem("output", "SQLOutput");
                    output.Set("EntityOrStructure", 'r', Callee(rest, ref i, number));
                    node.Items.Add(output);
                    if (!Skip(rest, ref i, ", ")) break;
                }
            }
            if (Skip(rest, ref i, " max ")) node.Set("MaxRecords", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.SqlMax));
            Label(node, rest[i..], number);
            Passthrough(node, depth + 1);
            Parameters(node, depth + 1);
            node.Set("Statement", 't', Code(depth + 1));
            return Flow.Next;
        }
        if (rest.StartsWith("JSONSerialize(", StringComparison.Ordinal)) {
            node.Kind = "JSONSerializeNode"; i = 14;
            node.Set("Data", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.Paren));
            Expect(rest, ref i, ")", number);
            Label(node, rest[i..], number);
            Passthrough(node, depth + 1);
            return Flow.Next;
        }
        if (rest.StartsWith("JSONDeserialize(", StringComparison.Ordinal)) {
            node.Kind = "JSONDeserializeNode"; i = 16;
            node.Set("JSONString", 'e', FlowSyntax.ReadExpr(rest, ref i, FlowPrinter.Paren));
            Expect(rest, ref i, ")", number);
            if (Skip(rest, ref i, " as ")) {
                var end = rest.IndexOf("  # ", i, StringComparison.Ordinal);
                if (end < 0) end = rest.Length;
                node.Set("DataType", 'r', rest[i..end]);
                i = end;
            }
            Label(node, rest[i..], number);
            Passthrough(node, depth + 1);
            return Flow.Next;
        }
        // A call: [Name = ]Callee(arguments); without a name, the node is named after the action.
        node.Kind = "Execute"; i = 0;
        var callee = Callee(rest, ref i, number);
        node.Set("Action", 'r', callee);
        if (name == null) node.Name = callee[(callee.LastIndexOf('.') + 1)..];
        Arguments(rest, ref i, node, number);
        Label(node, rest[i..], number);
        Passthrough(node, depth + 1);
        return Flow.Next;
    }

    // Variable = Value; the value runs to the first top-level terminator (the end of the line under an assign).
    private static FlowItem Assignment(string text, ref int i, string[] end, int number)
    {
        var assignment = new FlowItem("assignment", "Assignment");
        assignment.Set("Variable", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.Assigned));
        Expect(text, ref i, " = ", number);
        assignment.Set("Value", 'e', FlowSyntax.ReadExpr(text, ref i, end));
        return assignment;
    }

    // The parameters of a SQL or JavaScript node, one per line under it.
    private void Parameters(FlowItem node, int depth)
    {
        while (true) {
            var mark = at;
            var description = Description(depth);
            if (At(depth, t => t.StartsWith("in ", StringComparison.Ordinal) || t.StartsWith("out ", StringComparison.Ordinal))) {
                node.Items.Add(Parameter(depth, description, node));
                continue;
            }
            at = mark;
            return;
        }
    }

    private string? Code(int depth)
    {
        List<string>? text = null;
        while (At(depth, t => t == "|" || t.StartsWith("| ", StringComparison.Ordinal))) { var line = Next(depth); (text ??= []).Add(line.Length == 1 ? "" : line[2..]); }
        return text == null ? null : string.Join("\n", text);
    }

    private static bool Skip(string text, ref int i, string word)
    {
        if (string.CompareOrdinal(text, i, word, 0, word.Length) != 0) return false;
        i += word.Length;
        return true;
    }

    private static void Expect(string text, ref int i, string word, int number)
    {
        if (!Skip(text, ref i, word)) throw Error(number, "expected '" + word + "' at column " + (i + 1) + ": " + text);
    }

    // A name written bare (FlowPrinter.IsCallee): identifiers joined by dots, "(System)." in front.
    private static string Callee(string text, ref int i, int number)
    {
        var start = i;
        if (string.CompareOrdinal(text, i, "(System).", 0, 9) == 0) i += 9;
        while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or '.')) i++;
        if (i == start) throw Error(number, "expected a name at column " + (start + 1));
        return text[start..i];
    }

    private static void Arguments(string text, ref int i, FlowItem node, int number)
    {
        Expect(text, ref i, "(", number);
        if (Skip(text, ref i, ")")) return;
        while (true) {
            var start = i;
            while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
            var parameter = text[start..i];
            if (parameter.Length == 0) throw Error(number, "expected an argument name at column " + (start + 1));
            var argument = new FlowItem("argument", "Argument", "", parameter);
            argument.Set("Value", 'e', Skip(text, ref i, "=") ? FlowSyntax.ReadExpr(text, ref i, FlowPrinter.CallValue) : parameter);
            node.Items.Add(argument);
            if (Skip(text, ref i, ")")) return;
            if (i >= text.Length) throw Error(number, "expected ')' to close the arguments: " + text);
            Expect(text, ref i, ", ", number);
        }
    }

    private static readonly System.Text.RegularExpressions.Regex GroupNamed = new(@"\G([A-Za-z_][A-Za-z0-9_]*)=", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // ODC: the text does not write a grouped aggregate (it reads back opaque), so the fix of a column names the logic op.
    private static string OdcGrouped => Anvil.Core.KernelLane.IsOdc ? Anvil.Core.AggregateSortRule.OdcGroupedByLogic : "";

    // The one source of an aggregate the FROM declares, or null (none, or several).
    private static string? OnlySource(FlowItem node)
    {
        var sources = node.Items.Where(p => p.Role == "source").Select(p => p.Name).ToList();
        return sources.Count == 1 ? sources[0] : null;
    }

    // aggregate FROM a, b=E JOIN Type a~b ON c | ... WHERE (c) AND (d) GROUP BY g, N=h AGG N=Fn(x) CALC N=v SORT s desc, t MAX m START s
    private void Query(FlowItem node, string text, int number)
    {
        node.Kind = "AggregateNode";
        var shape = FlowAggregateShape.Canonical(text);
        if (shape.Text == null) throw Error(number, FlowTextEdit.AggregateSqlShape + ": " + shape.Why);
        if (shape.Text != text) {
            if (mode != Mode.Lenient) throw Error(number, FlowTextEdit.AggregateSqlShape + ": " + shape.Why + "; use: " + shape.Text);
            edits.Add(new FlowTextEdit(FlowTextEdit.AggregateSqlShape, number, false, text, shape.Text, shape.Why));
            text = shape.Text;
        }
        var i = "aggregate FROM ".Length;
        while (true) {
            var first = Callee(text, ref i, number);
            var source = new FlowItem("source", "Source", "", first);
            if (Skip(text, ref i, "=")) source.Set("Source", 'r', Callee(text, ref i, number)); else source.Set("Source", 'r', first);
            node.Items.Add(source);
            if (!Skip(text, ref i, ", ")) break;
        }
        if (Skip(text, ref i, " JOIN "))
            while (true) {
                var start = i;
                while (i < text.Length && text[i] != ' ') i++;
                var join = new FlowItem("join", "Join");
                join.Set("JoinType", 'v', text[start..i]);
                Expect(text, ref i, " ", number);
                join.Set("LeftSource", 'r', Callee(text, ref i, number));
                Expect(text, ref i, "~", number);
                join.Set("RightSource", 'r', Callee(text, ref i, number));
                Expect(text, ref i, " ON ", number);
                join.Set("Condition", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.JoinCondition));
                node.Items.Add(join);
                if (!Skip(text, ref i, " | ")) break;
            }
        if (Skip(text, ref i, " WHERE "))
            while (true) {
                Expect(text, ref i, "(", number);
                var filter = new FlowItem("filter", "Filter");
                filter.Set("Condition", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.Paren));
                Expect(text, ref i, ")", number);
                node.Items.Add(filter);
                if (!Skip(text, ref i, " AND ")) break;
            }
        if (Skip(text, ref i, " GROUP BY "))
            while (true) {
                var group = new FlowItem("group", "GroupByAttribute");
                // Name=attribute, or the attribute alone (the column takes its name from it, FlowPrinter.GroupName).
                var named = GroupNamed.Match(text, i);
                string? name = null;
                if (named.Success) { name = named.Groups[1].Value; i += named.Length; }
                var escaped = i < text.Length && text[i] == '`';
                var attribute = FlowSyntax.ReadExpr(text, ref i, FlowPrinter.ListValue);
                // Nothing to group by (`GROUP BY X=` before a comma or a keyword): no column the compiler can build. An empty `` is
                // what the reader prints for a column that reads nothing; the diff refuses that one (ColumnRule).
                if (!escaped && attribute.Trim().Length == 0) {
                    var fix = Anvil.Core.AggregateSortRule.EmptyColumnFix(name ?? "", true, null, OnlySource(node), null) + OdcGrouped;
                    throw Error(number, "GROUP BY " + (name != null ? name + "= " : "") + Anvil.Core.AggregateSortRule.EmptyColumnWhy + ": the compiler has nothing to group by: " + text,
                        Anvil.Core.AggregateSortRule.ColumnCode, fix);
                }
                group.Set("Attribute", 'e', attribute);
                group.Name = name ?? FlowPrinter.GroupName(attribute);
                node.Items.Add(group);
                if (!Skip(text, ref i, ", ")) break;
            }
        if (Skip(text, ref i, " AGG "))
            while (true) {
                var start = i;
                var columnStart = start;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                var column = new FlowItem("agg", "AggregateAttribute", "", text[start..i]);
                Expect(text, ref i, "=", number);
                start = i;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                column.Set("AggregationType", 'v', text[start..i]);
                Expect(text, ref i, "(", number);
                var escaped = i < text.Length && text[i] == '`';
                var attribute = FlowSyntax.ReadExpr(text, ref i, FlowPrinter.Paren);
                // `Count()` is no COUNT(*): an aggregated column reads one attribute, or it has no data type and the compiler
                // nothing to aggregate (an O11 Verify passes it when nothing reads the column). An empty `` is what the reader
                // prints for a column that reads nothing; the diff refuses that one (ColumnRule), with its patch when certain.
                if (!escaped && attribute.Trim().Length == 0) {
                    var fix = Anvil.Core.AggregateSortRule.EmptyColumnFix(column.Name, false, column.Prop("AggregationType"), OnlySource(node), null) + OdcGrouped;
                    // Count with one source counts the rows of each group by that source's identifier: certain once the model names it (not on
                    // ODC, whose text does not write a grouped aggregate).
                    var only = node.Items.Where(p => p.Role == "source").ToList();
                    var certain = OdcGrouped.Length == 0 && only.Count == 1 && column.Name.Length > 0 && i < text.Length && text[i] == ')'
                        && string.Equals(column.Prop("AggregationType"), "Count", StringComparison.OrdinalIgnoreCase);
                    throw new FlowRuleFormatException("line " + number + ": AGG " + column.Name + "=" + column.Prop("AggregationType") + "() " + Anvil.Core.AggregateSortRule.EmptyColumnWhy
                        + " (it is no COUNT(*)): the column has no data type and the compiler has nothing to aggregate: " + text, Anvil.Core.AggregateSortRule.ColumnCode, fix) {
                        Replace = certain ? text[columnStart..(i + 1)] : null, With = certain ? column.Name + "=" + column.Prop("AggregationType") + "(" + only[0].Name + ".{identifier})" : null,
                        Entity = certain ? only[0].Prop("Source") : null,
                    };
                }
                column.Set("Attribute", 'e', attribute);
                Expect(text, ref i, ")", number);
                node.Items.Add(column);
                if (!Skip(text, ref i, ", ")) break;
            }
        if (Skip(text, ref i, " CALC "))
            while (true) {
                var start = i;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                var column = new FlowItem("calc", "CalculatedAttribute", "", text[start..i]);
                Expect(text, ref i, "=", number);
                column.Set("Value", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.ListValue));
                node.Items.Add(column);
                if (!Skip(text, ref i, ", ")) break;
            }
        if (Skip(text, ref i, " SORT "))
            while (true) {
                var sort = new FlowItem("sort", "Sort");
                sort.Set("Attribute", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.SortValue));
                if (Skip(text, ref i, " desc")) sort.Set("SortDirection", 'v', "Descending");
                if (Skip(text, ref i, " dynamic")) sort.Set("IsDynamic", 'v', "True");
                node.Items.Add(sort);
                if (!Skip(text, ref i, ", ")) break;
            }
        if (Skip(text, ref i, " MAX ")) node.Set("MaxRecords", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.AggregateMax));
        if (Skip(text, ref i, " START ")) node.Set("StartIndex", 'e', FlowSyntax.ReadExpr(text, ref i, FlowPrinter.LabelEnd));
        Label(node, text[i..], number);
    }
}

// A line the grammar reads that a rule of the compiler refuses (a column that reads no attribute): the problem's code and fix go
// with it (Verbs.Flow refuses the text with them instead of FLOW_SYNTAX).
// Replace/With/Entity: the certain fix when the model says the identifier of Entity (Verbs.Flow writes With, its {identifier}
// filled, in place of the one Replace of the text, and offers it only when that text has no problem at all).
internal sealed class FlowRuleFormatException(string message, string code, string fix) : FormatException(message)
{
    public string Code { get; } = code;
    public string Fix { get; } = fix;
    public string? Replace { get; init; }
    public string? With { get; init; }
    public string? Entity { get; init; }
}

// Text only: also linked by the ODC builder. Expressions remain literal. A SQL join supplies the missing source pair
// only when exactly one previously declared source can be its left side.
internal static class FlowAggregateShape
{
    private const System.Text.RegularExpressions.RegexOptions Options = System.Text.RegularExpressions.RegexOptions.CultureInvariant
        | System.Text.RegularExpressions.RegexOptions.IgnoreCase;
    private static readonly System.Text.RegularExpressions.Regex Head = new(@"\baggregate\s+FROM\s+", Options);
    private const string Name = @"[\p{L}_][\p{L}\p{N}_]*";
    private const string Entity = @"(?:\(" + Name + @"\)\.)?" + Name + @"(?:\." + Name + @")*";
    private static readonly System.Text.RegularExpressions.Regex Source = new(@"^(?:(" + Name + @")\s*=\s*(" + Entity
        + @")|(" + Entity + @")(?:\s+(?:AS\s+)?(" + Name + @"))?)$", Options);
    private static readonly System.Text.RegularExpressions.Regex Pair = new(@"^(\S+)\s+(" + Entity + @")~(" + Entity + @")\s+ON\s+", Options);
    private static readonly System.Text.RegularExpressions.Regex On = new(@"\s+ON\s+", Options);
    private static readonly System.Text.RegularExpressions.Regex ColumnName = new(@"^(" + Name + @")\s*=\s*(?!=)", Options);
    private static readonly string[] SqlJoins = [" LEFT OUTER JOIN ", " RIGHT OUTER JOIN ", " FULL OUTER JOIN ",
        " INNER JOIN ", " LEFT JOIN ", " RIGHT JOIN ", " FULL JOIN "];
    // ORDER BY is the SQL spelling of SORT (its keys and directions as written: FLOW_SORT_DIRECTION reads DESC/ASC).
    private static readonly string[] Boundaries = [.. SqlJoins, " ORDER BY ", .. FlowPrinter.AggregateKeywords];
    private sealed record From(string Alias, string Entity)
    {
        public string Text => Alias == Entity ? Entity : Alias + "=" + Entity;
    }

    public static (string? Text, string Why) Canonical(string line)
    {
        var head = Head.Match(line);
        if (!head.Success) return (line, "not an aggregate");
        // Query supplies the aggregate alone; whole node lines are useful for diagnostics and tests.
        var body = line[(head.Index + head.Length)..];
        var suffix = "";
        if (FlowSyntax.SplitKey(body, out var withoutKey, out var key)) { body = withoutKey; suffix = " @" + key; }
        // A label is not a #date# literal. Isolate it before scanning clause bodies, even when its text contains # again.
        var labelAt = FlowSyntax.Scan(Mask(body), 0, ["  # "]);
        if (labelAt >= 0 && labelAt < body.Length) { suffix = body[labelAt..] + suffix; body = body[..labelAt]; }
        var sources = new List<From>();
        var joins = new List<string>();
        var clauses = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var shadow = Mask(body).ToUpperInvariant();
        var at = FlowSyntax.Scan(shadow, 0, Boundaries);
        if (at < 0) return (null, "unbalanced aggregate expression");
        foreach (var source in Split(body[..at], ",")) {
            if (ParseSource(source) is not { } parsed) return (null, "invalid aggregate source: " + source);
            if (sources.Any(s => string.Equals(s.Alias, parsed.Alias, StringComparison.OrdinalIgnoreCase)))
                return (null, "duplicate aggregate source alias: " + parsed.Alias);
            sources.Add(parsed);
        }
        if (sources.Count == 0) return (null, "aggregate FROM needs a source");
        while (at < body.Length) {
            var token = Boundaries.FirstOrDefault(t => shadow.AsSpan(at).StartsWith(t, StringComparison.Ordinal));
            if (token == null) return (null, "unknown aggregate clause: " + body[at..]);
            if (token == "  # ") { suffix = body[at..] + suffix; break; }
            var valueAt = at + token.Length;
            var end = FlowSyntax.Scan(shadow, valueAt, Boundaries);
            if (end < 0) return (null, "unbalanced aggregate expression: " + body[valueAt..]);
            var value = body[valueAt..end].Trim();
            if (value.Length == 0) return (null, "empty aggregate clause " + token.Trim());
            if (token.Contains("JOIN", StringComparison.Ordinal)) {
                if (token == " JOIN " && Pair.IsMatch(value)) {
                    foreach (var part in Split(value, " | ")) {
                        var pair = Pair.Match(part);
                        if (!pair.Success || Anvil.Core.AggregateSortRule.JoinKindOf(pair.Groups[1].Value) is not { } kind)
                            return (null, "invalid explicit JOIN: " + part);
                        joins.Add(kind + " " + pair.Groups[2].Value + "~" + pair.Groups[3].Value + " ON " + part[pair.Length..]);
                    }
                } else {
                    var on = On.Match(value);
                    if (!on.Success || ParseSource(value[..on.Index]) is not { } right)
                        return (null, "SQL JOIN needs a source and ON condition: " + value);
                    var condition = value[(on.Index + on.Length)..];
                    if (condition.Length == 0) return (null, "SQL JOIN needs an ON condition");
                    if (sources.Any(s => string.Equals(s.Alias, right.Alias, StringComparison.OrdinalIgnoreCase)))
                        return (null, "duplicate aggregate source alias: " + right.Alias + "; name each source with an alias");
                    var mentioned = sources.Where(s => Mentions(condition, s.Alias)).ToList();
                    var candidates = mentioned.Count == 0 && sources.Count == 1 ? sources : mentioned;
                    var kind = token == " JOIN " ? "Inner" : Anvil.Core.AggregateSortRule.JoinKindOf(token.Trim())!;
                    if (candidates.Count != 1) {
                        var choices = (candidates.Count == 0 ? sources : candidates).Select(s =>
                            "JOIN " + kind + " " + s.Alias + "~" + right.Alias + " ON " + condition);
                        return (null, "ambiguous SQL JOIN left source; candidates: " + string.Join(", ", (candidates.Count == 0 ? sources : candidates).Select(s => s.Alias))
                            + "; possible readings: " + string.Join(" or ", choices));
                    }
                    joins.Add(kind + " " + candidates[0].Alias + "~" + right.Alias + " ON " + condition);
                    sources.Add(right);
                }
            } else {
                var clause = token == " ORDER BY " ? "SORT" : token.Trim();
                if (!clauses.TryGetValue(clause, out var values)) clauses[clause] = values = [];
                if (values.Count > 0 && clause is "MAX" or "START")
                    return (null, "ambiguous repeated " + clause + ": " + values[0] + " or " + value + "; keep exactly one");
                // A column's name is written `Name=value` (no space around its `=`) in GROUP BY, AGG and CALC.
                if (clause is "GROUP BY" or "AGG" or "CALC")
                    value = string.Join(", ", Split(value, ",").Select(item => ColumnName.Replace(item, "$1=")));
                values.Add(value);
            }
            at = end;
        }
        var result = new StringBuilder(line[..head.Index]).Append("aggregate FROM ").Append(string.Join(", ", sources.Select(s => s.Text)));
        if (joins.Count > 0) result.Append(" JOIN ").Append(string.Join(" | ", joins));
        foreach (var clause in new[] { "WHERE", "GROUP BY", "AGG", "CALC", "SORT", "MAX", "START" })
            if (clauses.TryGetValue(clause, out var values)) {
                result.Append(' ').Append(clause).Append(' ');
                result.Append(clause == "WHERE" ? string.Join(" AND ", values.Select(Filter)) : string.Join(", ", values));
            }
        result.Append(suffix);
        return (result.ToString(), "SQL JOINs use explicit source pairs; repeated clauses are combined in FROM JOIN WHERE GROUP BY AGG CALC SORT MAX START order");
    }

    private static From? ParseSource(string source)
    {
        var match = Source.Match(source.Trim());
        if (!match.Success) return null;
        if (match.Groups[1].Success) return new(match.Groups[1].Value, match.Groups[2].Value);
        return new(match.Groups[4].Success ? match.Groups[4].Value : match.Groups[3].Value, match.Groups[3].Value);
    }

    private static IEnumerable<string> Split(string text, string delimiter)
    {
        var shadow = Mask(text);
        var from = 0;
        while (from < text.Length) {
            var end = FlowSyntax.Scan(shadow, from, [delimiter]);
            if (end < 0) { yield return text[from..].Trim(); yield break; }
            yield return text[from..end].Trim();
            from = end + delimiter.Length;
        }
    }

    // Existing canonical filters are parenthesized, possibly several joined by AND. Keep their literal slices.
    private static string Filter(string text)
    {
        var parts = Split(Mask(text).ToUpperInvariant(), " AND ").ToList();
        return parts.Count > 0 && parts.All(p => p.StartsWith('(') && FlowSyntax.Scan(p, 1, [")"]) == p.Length - 1) ? text : "(" + text + ")";
    }

    private static bool Mentions(string condition, string alias)
    {
        // A backtick encodes an expression, not a text literal: its references still select a source.
        if (condition.StartsWith('`')) {
            var at = 0;
            try { var decoded = FlowSyntax.ReadEscaped(condition, ref at); if (at == condition.Length) condition = decoded; }
            catch (FormatException) { return false; }
        }
        return System.Text.RegularExpressions.Regex.IsMatch(Mask(condition),
            @"(?<![\p{L}\p{N}_.])" + System.Text.RegularExpressions.Regex.Escape(alias) + @"\.", Options);
    }

    // Scan is ordinal. The uppercase shadow accepts mixed keyword casing. Literal contents are masked at their original
    // positions; all emitted expressions are slices of the untouched input.
    private static string Mask(string text)
    {
        var masked = text.ToCharArray();
        var depth = 0;
        for (var i = 0; i < text.Length; i++) {
            if (text[i] is not ('"' or '#' or '`')) {
                if (text[i] is '(' or '[' or '{') depth++;
                else if (text[i] is ')' or ']' or '}') depth--;
                continue;
            }
            if (text[i] == '#' && depth == 0 && i >= 2 && text[i - 1] == ' ' && text[i - 2] == ' '
                && i + 1 < text.Length && text[i + 1] == ' ') break;
            var start = i;
            if (text[i] == '`') {
                try { FlowSyntax.ReadEscaped(text, ref i); i--; } catch (FormatException) { continue; }
            } else if (text[i] == '#') {
                var end = text.IndexOf('#', i + 1);
                if (end < 0) continue;
                i = end;
            } else {
                i++;
                while (i < text.Length) {
                    if (text[i] == '"') { if (i + 1 < text.Length && text[i + 1] == '"') { i += 2; continue; } break; }
                    i++;
                }
                if (i >= text.Length) break;
            }
            for (var n = start; n <= i; n++) masked[n] = 'x';
        }
        return new string(masked);
    }
}

// ---- tolerance: the shapes a model writes for a line the grammar has one reading of (R1, 24/10/2026) ---------------------
//
// The lenient pass (FlowParser.Lenient) runs this first, on the raw lines, then reads the result: every edit here replaces one
// whole line by another (a line may become empty, none is added or removed), so the line numbers of the structural edits the
// parser writes after it are the numbers of the text as given. Each rewrite is a FlowTextEdit with its rule, which the
// normalizer lists (normalizations) when the edited text reads whole, or offers as the certain patch of a text that still has
// another error (FlowTextNormalizer.Corrected). Nothing here changes what a line says:
//   FLOW_INDENT_UNIT      indentation of 1 (or 4) spaces a level, consistent in the action, is 2; a body written at depth 0
//                         under its header is one level in; a single step at depth 0 between steps of depth 1 is at depth 1;
//   FLOW_LINE_CONTINUATION an aggregate written over several lines (the next starting with JOIN, WHERE, ORDER, GROUP, ON, AND,
//                         OR...) is one line; a SQL statement under its node without `| ` is its code;
//   FLOW_SWITCH_INDENT    the cases of a switch written at its own depth are one level in;
//   FLOW_ELSE             `else:` (or `otherwise:`) at the depth of its `if`: the false branch is written below the if, and
//                         the true branch ends with the jump to where the if/else goes on (the step after it, `next` in a loop,
//                         `end` at the end of the flow); a continuation that cannot be named stays refused, with the shape;
//   FLOW_DECLARATION_ORDER an in/out/local written among the steps goes with the declarations (the steps keep their order);
//   FLOW_LABEL_SPACING    a label after one space (or three) is the label (a #date# literal never has a space after its #);
//   FLOW_ASSIGN_SPACING   `assign X=v` (and `X=v` in an assign block) is `assign X = v`: only the first `=` outside texts and
//                         brackets, after a name, is the assignment's; the value is kept as written;
//   FLOW_RESULT_SPACING   `Result=Action(...)` is `Result = Action(...)`;
//   FLOW_ARGUMENT_SPACING the arguments of a call, navigate, trigger, node or event: `P=v, Q` (a comma and one space, no
//                         space around the `=` of a name), no space before the parenthesis; values are kept as written;
//   FLOW_NAVIGATE_ARGUMENTS `navigate Screen` (trigger, raise, an event's handler) without arguments is `navigate Screen()`;
//   FLOW_JUMP_BY_NAME     `-> Name` names the one node of that name: `-> @id` (the node is given an id when it has none);
//   FLOW_UNREACHED_END    an `end` right after a navigate or raise of the same branch (which end it) is no step;
//   FLOW_MAPPING_SPACING  the value `Source mapTo {A: x,B: y}` of an assignment or an argument is `Source mapTo { A: x, B: y }`.
internal static class FlowTolerance
{
    public const string IndentUnit = "FLOW_INDENT_UNIT";
    public const string LineContinuation = "FLOW_LINE_CONTINUATION";
    public const string SwitchIndent = "FLOW_SWITCH_INDENT";
    public const string Else = "FLOW_ELSE";
    public const string DeclarationOrder = "FLOW_DECLARATION_ORDER";
    public const string AssignSpacing = "FLOW_ASSIGN_SPACING";
    public const string ResultSpacing = "FLOW_RESULT_SPACING";
    public const string ArgumentSpacing = "FLOW_ARGUMENT_SPACING";
    public const string NavigateArguments = "FLOW_NAVIGATE_ARGUMENTS";
    public const string JumpByName = "FLOW_JUMP_BY_NAME";
    public const string UnreachedEnd = "FLOW_UNREACHED_END";
    public const string MappingSpacing = "FLOW_MAPPING_SPACING";

    /// <summary>The whole-line edits of the tolerated shapes of a text (none for a text in the grammar's shapes), and the
    /// shape to write beside a line no edit can make certain (by line, 1-based).</summary>
    public static (List<FlowTextEdit> Edits, Dictionary<int, string> Hints) Of(string text)
    {
        var pass = new Pass(text);
        try { pass.Run(); } catch (Exception) { return ([], pass.Hints); }
        return (pass.Edits, pass.Hints);
    }

    private static readonly System.Text.RegularExpressions.Regex LValue = new(
        @"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\[]+\])*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex Named = new(
        @"^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(\S.*)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.Singleline);
    private static readonly System.Text.RegularExpressions.Regex CallHead = new(
        @"^(?:\(System\)\.)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex NodeWord = new(
        @"^(?:aggregate\s+from\b|sql(?:\s|$)|javascript\b|JSONSerialize\(|JSONDeserialize\(|node\s|opaque\s)",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static readonly System.Text.RegularExpressions.Regex Continuation = new(
        @"^(?:JOIN|INNER|LEFT|RIGHT|FULL|WHERE|ORDER|GROUP|ON|AND|OR|SORT|MAX|START|AGG|CALC)\b|^\|\s*(?:Inner|Left|Full|Right)\s",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static readonly System.Text.RegularExpressions.Regex SqlWord = new(
        @"^(?:SELECT|FROM|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|WHERE|ORDER|GROUP|HAVING|ON|AND|OR|UNION|LIMIT|OFFSET|SET|UPDATE|INSERT|DELETE|VALUES|WITH|INTO)\b",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant | System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static readonly string[] Keywords = ["if ", "switch:", "foreach ", "assign", "end", "raise ", "navigate ", "refresh ", "message ",
        "trigger ", "next", "-> ", "else", "otherwise:", "case ", "on ", "unreached:", "//", "@{", "|", "in ", "out ", "local "];

    private sealed class Pass
    {
        private readonly string[] cur;
        public readonly List<FlowTextEdit> Edits = [];
        public readonly Dictionary<int, string> Hints = [];
        private readonly HashSet<string> ids = new(StringComparer.Ordinal);
        private int header = -1;
        private int joins;

        public Pass(string text)
        {
            cur = text.Replace("\r\n", "\n").Split('\n');
            foreach (var line in cur) {
                var content = line.TrimStart(' ');
                if (FlowSyntax.SplitKey(content, out _, out var id)) ids.Add(id);
                if (content.StartsWith("-> @", StringComparison.Ordinal)) ids.Add(content[4..]);
                if (content.StartsWith("//-> @", StringComparison.Ordinal) && content.IndexOf(' ', 6) is > 6 and var space) ids.Add(content[6..space]);
            }
        }

        public void Run()
        {
            for (var i = 0; i < cur.Length && header < 0; i++) {
                if (Blank(i) || Content(i).StartsWith("///", StringComparison.Ordinal)) continue;
                // What the general language writes above the actions (R7: a contract and its lines, a binding, a context).
                if (Spaces(i) == 0 && System.Text.RegularExpressions.Regex.IsMatch(cur[i], @"^(?:contract [A-Za-z_]\w*:$|binding |context )")) {
                    while (i + 1 < cur.Length && (Blank(i + 1) || Spaces(i + 1) > 0)) i++;
                    continue;
                }
                header = Spaces(i) == 0 ? i : int.MaxValue;
            }
            if (header is < 0 or int.MaxValue) return;
            Indentation();
            Continuations();
            Switches();
            Declarations();
            Elses();
            for (var i = header + 1; i < cur.Length; i++) Line(i);
            Jumps();
            for (var i = header + 1; i < cur.Length; i++) if (!Blank(i) && Shape(i, Head(Content(i))) is { } hint) Hints.TryAdd(i + 1, hint);
        }

        // The shape to write for a line of another language a model writes, which has no certain edit.
        private string? Shape(int i, string head)
        {
            var depth = Depth(i);
            int? previous = null;
            for (var j = i - 1; j > header && previous == null; j--) if (!Blank(j)) previous = j;
            if (previous is { } p && Depth(p) == depth - 1 && Head(Content(p)) is var above && above.StartsWith("assign ", StringComparison.Ordinal) && above.Trim() != "assign")
                return "an assign of several assignments is `assign` alone on its line, with one assignment a line one level in";
            if (previous is { } q && Depth(q) > depth) {
                for (var j = q; j > header; j--)
                    if (!Blank(j) && Depth(j) <= depth) {
                        if (Depth(j) == depth && Head(Content(j)).StartsWith("switch:", StringComparison.Ordinal))
                            return "nothing follows a switch in its chain: each case ends (end, raise, navigate) or jumps (-> @id); write this step in the first case that reaches it";
                        break;
                    }
            }
            if (head.StartsWith("navigate ", StringComparison.Ordinal) && System.Text.RegularExpressions.Regex.Match(head, @"^navigate [A-Za-z_]\w*/([A-Za-z_]\w*)\(") is { Success: true } flow)
                return "a navigate names the screen alone (navigate " + flow.Groups[1].Value + "(...)); its flow is not written";
            if (head.StartsWith("while ", StringComparison.Ordinal) || head.StartsWith("for ", StringComparison.Ordinal))
                return "a loop is foreach List: with its body one level in and ending in next (or an if whose branch jumps back to it with -> @id)";
            if (head.StartsWith("else if ", StringComparison.Ordinal) || head.StartsWith("elif ", StringComparison.Ordinal) || head.StartsWith("elseif ", StringComparison.Ordinal))
                return "else if is no line: write the false branch below the if, at its depth, starting with the next if";
            if (System.Text.RegularExpressions.Regex.Match(head, @"^(?:[A-Za-z_]\w*\s*=\s*)?I[A-Za-z]+:([A-Za-z_][\w.]*)\(") is { Success: true } typed)
                return "a call names the action alone (" + typed.Groups[1].Value + "(...)); the kind of call, when two actions share the name, goes on its @{Call=Client|Server} line";
            return null;
        }

        // ---- lines ------------------------------------------------------------------------------------------------------

        private bool Blank(int i) => cur[i].Trim(' ').Length == 0;
        private int Spaces(int i) { var s = 0; while (s < cur[i].Length && cur[i][s] == ' ') s++; return s; }
        private int Depth(int i) => Spaces(i) / 2;
        private string Content(int i) => cur[i][Spaces(i)..];
        private string Indent(int depth) => new(' ', depth * 2);
        private IEnumerable<int> Body() { for (var i = header + 1; i < cur.Length; i++) if (!Blank(i)) yield return i; }
        private int? NextLine(int from) { for (var i = from; i < cur.Length; i++) if (!Blank(i)) return i; return null; }

        // The content of a line without its id and its label (the grammar's tail).
        private static string Head(string content)
        {
            var head = FlowSyntax.SplitKey(content, out var withoutKey, out _) ? withoutKey : content;
            var label = head.IndexOf("  # ", StringComparison.Ordinal);
            return label >= 0 && LabelAt(head) == label + 2 ? head[..label] : head;
        }

        private static bool Code(string content) => content == "|" || content.StartsWith("| ", StringComparison.Ordinal);
        private static bool Description(string content) => content == "///" || content.StartsWith("/// ", StringComparison.Ordinal);
        private static bool Parameter(string content) => content.StartsWith("in ", StringComparison.Ordinal) || content.StartsWith("out ", StringComparison.Ordinal)
            || content.StartsWith("local ", StringComparison.Ordinal);
        // A line that starts with a word of the grammar (a word alone, like `assign`, `end` or `next`, is the whole word).
        private static bool Keyword(string content) => Keywords.Any(k => k[^1] is ' ' or ':' || k is "//" or "@{" or "|"
            ? content.StartsWith(k, StringComparison.Ordinal) || content == k.TrimEnd()
            : content == k || content.StartsWith(k + " ", StringComparison.Ordinal) || content.StartsWith(k + ":", StringComparison.Ordinal));
        private static bool BareAssign(string content) => Head(content) == "assign";
        private static bool ElseLine(string content) => Head(content).TrimEnd() is "else:" or "else" or "otherwise:";
        private static bool IfLine(string content) => content.StartsWith("if ", StringComparison.Ordinal);

        private void Set(int i, string line, string rule, string message)
        {
            if (cur[i] == line) return;
            Edits.Add(new FlowTextEdit(rule, i + 1, false, cur[i], line, "line " + (i + 1) + ": " + message));
            cur[i] = line;
        }

        private string NewId()
        {
            string id;
            do id = "j" + ++joins; while (ids.Contains(id));
            ids.Add(id);
            return id;
        }

        // The id of a node line, given one (appended) when it has none.
        private string IdOf(int i, string rule)
        {
            if (FlowSyntax.SplitKey(Content(i), out _, out var id)) return id;
            id = NewId();
            Set(i, cur[i] + " @" + id, rule, "the step a jump goes to is named @" + id);
            return id;
        }

        // ---- FLOW_INDENT_UNIT ---------------------------------------------------------------------------------------------

        private void Indentation()
        {
            var body = Body().ToList();
            if (body.Count == 0) return;
            var spaces = body.Select(Spaces).ToList();
            bool Valid(IReadOnlyList<int> depths)
            {
                if (depths[0] != 1) return false;
                for (var k = 1; k < depths.Count; k++) if (depths[k] < 1 || depths[k] > depths[k - 1] + 1) return false;
                return true;
            }
            if (spaces.All(s => s % 2 == 0) && Valid(spaces.Select(s => s / 2).ToList())) return;
            List<int>? wanted = null;
            string? why = null;
            if (Valid(spaces)) { wanted = spaces.Select(s => s * 2).ToList(); why = "the action is indented one space a level: two spaces a level"; }
            else if (spaces.All(s => s % 4 == 0) && Valid(spaces.Select(s => s / 4).ToList())) { wanted = spaces.Select(s => s / 2).ToList(); why = "the action is indented four spaces a level: two spaces a level"; }
            else if (spaces[0] is 1 or 3 && spaces.All(s => (s + 2 - spaces[0]) % 2 == 0 && s + 2 - spaces[0] > 0) && Valid(spaces.Select(s => (s + 2 - spaces[0]) / 2).ToList())) {
                // Two spaces a level, every line one space short (or over): depth 1 at one space, depth 2 at three...
                var shift = 2 - spaces[0];
                wanted = spaces.Select(s => s + shift).ToList(); why = "every line of the action is one space " + (shift > 0 ? "short of" : "over") + " its depth: two spaces a level";
            }
            else if (spaces[0] == 0) {
                // The body under its header at depth 0: one level in, in the unit the rest of it has.
                foreach (var unit in new[] { 2, 1, 4 })
                    if (spaces.All(s => s % unit == 0) && Valid(spaces.Select(s => s / unit + 1).ToList())) {
                        wanted = spaces.Select(s => (s / unit + 1) * 2).ToList(); why = "the body of the action is one level under its header"; break;
                    }
            } else if (spaces.All(s => s % 2 == 0)) {
                // One step at depth 0 between steps of depth 1 (no block under it): a step of the main flow. After a deeper
                // line it could be a step of that branch too: not certain.
                var depths = spaces.Select(s => s / 2).ToList();
                for (var k = 1; k < depths.Count; k++)
                    if (depths[k] == 0 && depths[k - 1] == 1 && (k + 1 == depths.Count || depths[k + 1] == 1) && !Content(body[k]).TrimEnd().EndsWith(':')
                        && !BareAssign(Content(body[k])) && !Description(Content(body[k])))
                        depths[k] = 1;
                if (Valid(depths)) { wanted = depths.Select(d => d * 2).ToList(); why = "a step of the main flow is at depth 1, under the header"; }
            }
            if (wanted == null) return;
            for (var k = 0; k < body.Count; k++)
                if (wanted[k] != spaces[k]) Set(body[k], new string(' ', wanted[k]) + Content(body[k]), IndentUnit, why!);
        }

        // ---- FLOW_LINE_CONTINUATION ---------------------------------------------------------------------------------------

        private void Continuations()
        {
            for (var i = header + 1; i < cur.Length; i++) {
                if (Blank(i)) continue;
                var content = Content(i);
                var named = Named.Match(content);
                var value = named.Success ? named.Groups[2].Value : "";
                var depth = Depth(i);
                if (value.StartsWith("aggregate ", StringComparison.OrdinalIgnoreCase)) {
                    var parts = new List<int>();
                    for (var j = i + 1; j < cur.Length; j++) {
                        if (Blank(j)) continue;
                        if (Depth(j) <= depth || !Continuation.IsMatch(Content(j))) break;
                        parts.Add(j);
                    }
                    if (parts.Count == 0) continue;
                    var (head, tail) = Split(content);
                    var joined = cur[i][..Spaces(i)] + head.TrimEnd() + " " + string.Join(" ", parts.Select(j => Content(j).Trim())) + tail;
                    Set(i, joined, LineContinuation, "an aggregate is one line: the " + parts.Count + " line(s) under it continue it");
                    foreach (var j in parts) Set(j, "", LineContinuation, "continues the aggregate of line " + (i + 1));
                } else if (value == "sql" || value.StartsWith("sql ", StringComparison.Ordinal)) {
                    // A SQL statement under its node without `| `: its code (in/out/@{ stay what they are).
                    for (var j = i + 1; j < cur.Length; j++) {
                        if (Blank(j)) continue;
                        if (Depth(j) <= depth) break;
                        var line = Content(j);
                        if (Code(line) || Parameter(line) || line.StartsWith("@{", StringComparison.Ordinal) || Description(line)) continue;
                        if (Depth(j) == depth + 1 && !SqlWord.IsMatch(line)) break;
                        var extra = Spaces(j) - (depth + 1) * 2;
                        Set(j, Indent(depth + 1) + "| " + new string(' ', Math.Max(0, extra)) + line, LineContinuation, "a line of the SQL statement is code: `| `");
                    }
                }
            }
        }

        // ---- FLOW_SWITCH_INDENT -------------------------------------------------------------------------------------------

        private void Switches()
        {
            for (var i = header + 1; i < cur.Length; i++) {
                if (Blank(i) || !Head(Content(i)).StartsWith("switch:", StringComparison.Ordinal)) continue;
                var depth = Depth(i);
                if (NextLine(i + 1) is not { } first || Depth(first) != depth || !Content(first).StartsWith("case ", StringComparison.Ordinal)) continue;
                var block = new List<int>();
                for (var j = first; j < cur.Length; j++) {
                    if (Blank(j)) continue;
                    var d = Depth(j);
                    if (d < depth) break;
                    if (d == depth && !(Content(j).StartsWith("case ", StringComparison.Ordinal) || Head(Content(j)).TrimEnd() == "otherwise:")) break;
                    block.Add(j);
                }
                foreach (var j in block) Set(j, "  " + cur[j], SwitchIndent, "the cases of the switch of line " + (i + 1) + " are one level under it");
            }
        }

        // ---- FLOW_ELSE ----------------------------------------------------------------------------------------------------

        private void Elses()
        {
            var failed = new HashSet<int>();
            while (true) {
                int? at = null;
                for (var i = header + 1; i < cur.Length && at == null; i++)
                    if (!Blank(i) && !failed.Contains(i) && ElseLine(Content(i)) && OwnIf(i) != null) at = i;
                if (at is not { } line) return;
                if (!Lower(line)) failed.Add(line);
            }
        }

        // The if an `else:` of its depth belongs to: the step above it at that depth (the lines between are its true branch).
        private int? OwnIf(int line)
        {
            var depth = Depth(line);
            for (var i = line - 1; i > header; i--) {
                if (Blank(i)) continue;
                if (Depth(i) > depth) continue;
                return Depth(i) == depth && IfLine(Content(i)) ? i : null;
            }
            return null;
        }

        // The end of an `else:`'s body: the first line after it at its depth or shallower.
        private int BodyEnd(int line)
        {
            var depth = Depth(line);
            var end = line + 1;
            for (var j = line + 1; j < cur.Length; j++) {
                if (Blank(j)) continue;
                if (Depth(j) <= depth) return j;
                end = j + 1;
            }
            return end;
        }

        private bool Lower(int line)
        {
            var depth = Depth(line);
            var own = OwnIf(line)!.Value;
            var truth = Enumerable.Range(own + 1, line - own - 1).Where(j => !Blank(j)).ToList();
            var last = truth.LastOrDefault(j => Depth(j) == depth + 1, -1);
            var body = Enumerable.Range(line + 1, BodyEnd(line) - line - 1).Where(j => !Blank(j)).ToList();
            var shape = "write the false branch below the if, at its depth, and end the true branch with the jump to the step after the if/else (-> @id), `next` in a loop or `end`";
            if (last < 0 || body.Count == 0) { Hints[line + 1] = shape; return false; }
            var lastHead = Head(Content(last));
            if (lastHead.StartsWith("switch:", StringComparison.Ordinal)) { Hints[line + 1] = shape; return false; }
            var ends = Terminator(lastHead);
            string? jump = null;
            if (!ends) {
                jump = After(BodyEnd(line), depth, own);
                if (jump == null) { Hints[line + 1] = shape + "; the step after this if/else is not certain here"; return false; }
            }
            Set(line, ends ? "" : Indent(depth + 1) + jump, Else, ends
                ? "the true branch of the if of line " + (own + 1) + " ends; its false branch is written below it (`else:` is no line of the grammar)"
                : "the true branch of the if of line " + (own + 1) + " goes on after the if/else (" + jump + "); its false branch is written below it");
            foreach (var j in body)
                Set(j, cur[j][2..], Else, "the false branch of the if of line " + (own + 1) + " is at the depth of the if");
            return true;
        }

        // A return of the general language (FlowGeneral, R7) ends its branch too.
        private static bool Terminator(string head) => head == "next" || head.StartsWith("-> ", StringComparison.Ordinal) || head == "end" || head.StartsWith("end ", StringComparison.Ordinal)
            || head == "return" || head.StartsWith("return ", StringComparison.Ordinal)
            || head.StartsWith("raise ", StringComparison.Ordinal) || head.StartsWith("navigate ", StringComparison.Ordinal)
            || head.EndsWith(" end", StringComparison.Ordinal) && (head.Contains(" = opaque ", StringComparison.Ordinal) || head.StartsWith("opaque ", StringComparison.Ordinal)
                || head.Contains(" = node ", StringComparison.Ordinal) || head.StartsWith("node ", StringComparison.Ordinal));

        // Where the chain at this depth goes on after the line `from` (the end of a construct whose first line is `start`):
        // the next step of the chain, else what follows the block that holds it. Null when that is not certain.
        private string? After(int from, int depth, int start)
        {
            if (NextLine(from) is { } next && Depth(next) == depth) return Target(next);
            if (depth == 1) return "end";
            // The head of the block: the line above the construct one level up, with every line between it deeper.
            int? head = null;
            for (var i = start - 1; i > header; i--) {
                if (Blank(i)) continue;
                if (Depth(i) >= depth) continue;
                head = Depth(i) == depth - 1 ? i : null;
                break;
            }
            if (head is not { } h) return null;
            var content = Content(h);
            if (content.StartsWith("foreach ", StringComparison.Ordinal)) return "next";
            if (content.StartsWith("on exception ", StringComparison.Ordinal)) return "end";
            if (IfLine(content) && NextLine(from) is { } after && Depth(after) == depth - 1 && ElseLine(Content(after)) && OwnIf(after) == h)
                return After(BodyEnd(after), depth - 1, h);
            if (ElseLine(content) && OwnIf(h) is { } outer) return After(BodyEnd(h), depth - 1, outer);
            return null;
        }

        // The jump to a line that follows a construct: `next` and a jump are copied, the end of the main flow is `end`, a step
        // is named by its id (given one when it has none). Null for a line no jump can name (a case, another else).
        private string? Target(int line)
        {
            var content = Content(line);
            var head = Head(content);
            if (head == "next") return "next";
            if (content.StartsWith("-> ", StringComparison.Ordinal)) return content;
            if (content.StartsWith("on exception ", StringComparison.Ordinal) || content == "unreached:") return "end";
            if (ElseLine(content) || content.StartsWith("case ", StringComparison.Ordinal) || Code(content) || content.StartsWith("@{", StringComparison.Ordinal)
                || Parameter(content)) return null;
            if (Description(content)) {
                for (var j = line + 1; j < cur.Length; j++)
                    if (!Blank(j) && !Description(Content(j))) return Depth(j) == Depth(line) ? Target(j) : null;
                return null;
            }
            return "-> @" + IdOf(line, Else);
        }

        // ---- FLOW_DECLARATION_ORDER ---------------------------------------------------------------------------------------

        private void Declarations()
        {
            for (var round = 0; round < 64; round++) {
                // The first line of the flow at depth 1 (the lines describing it with it).
                int? flow = null;
                for (var i = header + 1; i < cur.Length && flow == null; i++) {
                    if (Blank(i) || Depth(i) != 1) continue;
                    var content = Content(i);
                    // A `use` of a contract (the general language, R7) brings declarations: it is no step.
                    if (Description(content) || content.StartsWith("@{", StringComparison.Ordinal) || Parameter(content) || content.StartsWith("use ", StringComparison.Ordinal)
                        || content.StartsWith("on ", StringComparison.Ordinal) && !content.StartsWith("on exception ", StringComparison.Ordinal)) continue;
                    flow = i;
                }
                if (flow is not { } first) return;
                var start = first;
                while (start - 1 > header && (Blank(start - 1) || Depth(start - 1) == 1 && Description(Content(start - 1)))) start--;
                while (start < first && Blank(start)) start++;
                int? moved = null;
                for (var i = first + 1; i < cur.Length && moved == null; i++)
                    if (!Blank(i) && Depth(i) == 1 && Parameter(Content(i))) moved = i;
                if (moved is not { } declaration) return;
                var from = declaration;
                while (from - 1 > first && Depth(from - 1) == 1 && !Blank(from - 1) && Description(Content(from - 1))) from--;
                var to = declaration;
                while (to + 1 < cur.Length && !Blank(to + 1) && Depth(to + 1) > 1) to++;
                var block = Enumerable.Range(from, to - from + 1).Select(j => cur[j]).ToList();
                var rest = Enumerable.Range(start, from - start).Select(j => cur[j]).ToList();
                var order = block.Concat(rest).ToList();
                var text = Head(Content(declaration));
                for (var k = 0; k < order.Count; k++)
                    Set(start + k, order[k], DeclarationOrder, k < block.Count
                        ? "the declaration `" + text + "` (line " + (declaration + 1) + ") goes with the declarations, before the flow"
                        : "follows the declaration `" + text + "` moved before the flow");
            }
        }

        // ---- one line -----------------------------------------------------------------------------------------------------

        private void Line(int i)
        {
            if (Blank(i)) return;
            var content = Content(i);
            if (Code(content) || Description(content) || content.StartsWith("//", StringComparison.Ordinal) || content.StartsWith("@{", StringComparison.Ordinal)) return;
            var indent = cur[i][..Spaces(i)];
            // A label after one space or three: two (a #date# literal never has a space after its #).
            if (!InAssignBlock(i) && !content.StartsWith("case ", StringComparison.Ordinal) && !Parameter(content) && LabelAt(content) is { } label && label > 0) {
                var run = label;
                while (run > 0 && content[run - 1] == ' ') run--;
                var written = content[run..label];
                if (written != "  " && run > 0) {
                    content = content[..run] + "  " + content[label..];
                    Set(i, indent + content, FlowTextEdit.LabelSpacing, "the label is written after two spaces (`  " + content[(run + 2)..].TrimEnd() + "`)");
                }
            }
            var (head, tail) = Split(content);
            string? canonical = null;
            string rule = "", message = "";
            if (InAssignBlock(i)) {
                if (Assignment(content) is { } fixedLine && fixedLine != content) { Set(i, indent + fixedLine, AssignSpacing, "an assignment is `Variable = value`: " + fixedLine); content = fixedLine; }
                if (Mapped(content) is { } mapped) Set(i, indent + mapped, MappingSpacing, "a mapping is `Source mapTo { Field: value, ... }`: " + mapped);
                return;
            }
            if (head.StartsWith("assign ", StringComparison.Ordinal) && head.Trim() != "assign" && Assignment(head[7..].TrimStart()) is { } assignment) {
                canonical = "assign " + assignment; rule = AssignSpacing; message = "an assignment is `assign Variable = value`: " + canonical;
            } else if (head.StartsWith("navigate ", StringComparison.Ordinal) || head.StartsWith("trigger ", StringComparison.Ordinal)) {
                var word = head[..(head.IndexOf(' ') + 1)];
                if (Call(head[word.Length..], out _, out var empty) is { } written) {
                    canonical = word + written; rule = empty ? NavigateArguments : ArgumentSpacing;
                    message = empty ? "a " + word.Trim() + " without arguments is written with `()`: " + canonical : "the arguments are `P=v, Q`: " + canonical;
                }
            } else if (head.StartsWith("raise ", StringComparison.Ordinal) && !head.Contains('(') && CallHead.Match(head[6..]) is { Success: true } exception
                && exception.Length == head.Length - 6) {
                canonical = head + "()"; rule = NavigateArguments; message = "a raise without a message is written with `()`: " + canonical;
            } else if (head.StartsWith("on ", StringComparison.Ordinal) && !head.StartsWith("on exception ", StringComparison.Ordinal) && Depth(i) == 1
                && head.IndexOf(" -> ", StringComparison.Ordinal) is > 3 and var arrow && Call(head[(arrow + 4)..], out _, out var none) is { } events) {
                canonical = head[..(arrow + 4)] + events; rule = none ? NavigateArguments : ArgumentSpacing;
                message = none ? "an event's handler without arguments is written with `()`: " + canonical : "the arguments are `P=v, Q`: " + canonical;
            } else if (!Keyword(head)) {
                // A node line: `Name = rest` with one space around the `=`, then the arguments of a call.
                var rest = head;
                var prefix = "";
                if (Named.Match(head) is { Success: true } named && !named.Groups[2].Value.StartsWith('=')) {
                    prefix = named.Groups[1].Value + " = "; rest = named.Groups[2].Value;
                    if (prefix + rest != head) {
                        Set(i, indent + prefix + rest + tail, ResultSpacing, "a node's name is `Name = ...`: " + prefix + rest);
                        head = prefix + rest;
                    }
                } else if (Assignment(head) is { } slipped && !slipped.Equals(head, StringComparison.Ordinal) && !Keyword(head)) {
                    // `X.Y=v` where a step is: the spacing of an assignment (the parser decides whether it is one of a block).
                    canonical = slipped; rule = AssignSpacing; message = "an assignment is `Variable = value`: " + canonical;
                }
                if (canonical == null && !NodeWord.IsMatch(rest) && CallHead.IsMatch(rest) && Call(rest, out _, out _, needs: true) is { } written && written != rest) {
                    canonical = prefix + written; rule = ArgumentSpacing; message = "the arguments are `P=v, Q`: " + canonical;
                }
            }
            if (canonical != null && canonical != head) { Set(i, indent + canonical + tail, rule, message); head = canonical; }
            if (Mapped(head) is { } spaced) Set(i, indent + spaced + tail, MappingSpacing, "a mapping is `Source mapTo { Field: value, ... }`: " + spaced);
        }

        // The line with its mapping values in the grammar's spelling (the value of `X = v`, or of a call's arguments), or null.
        private static string? Mapped(string head)
        {
            if (!head.Contains(" mapTo {", StringComparison.Ordinal)) return null;
            string? Canonical(string value) => FlowMapping.Split(value) is { } m && FlowMapping.Compose(m.Source, m.Fields) is { } c && c != value ? c : null;
            var at = head.IndexOf(" = ", StringComparison.Ordinal);
            if (at > 0 && Canonical(head[(at + 3)..]) is { } whole) return head[..(at + 3)] + whole;
            var start = at > 0 ? at + 3 : 0;
            var open = start + (CallHead.Match(head[start..]) is { Success: true } callee ? callee.Length : 0);
            if (open >= head.Length || head[open] != '(' || !head.EndsWith(')')) return null;
            var arguments = head[(open + 1)..^1];
            var parts = new List<string>();
            var changed = false;
            for (var i = 0; i < arguments.Length;) {
                var end = FlowSyntax.Scan(arguments, i, [","]);
                if (end < 0) return null;
                var part = arguments[i..end];
                var equals = part.IndexOf('=');
                if (equals > 0 && Canonical(part[(equals + 1)..].Trim()) is { } value) { part = part[..(equals + 1)] + value; changed = true; }
                parts.Add(part);
                i = end + 1;
            }
            return changed ? head[..(open + 1)] + string.Join(",", parts) + ")" : null;
        }

        // The line of an assign block (under a bare `assign`, one level in).
        private bool InAssignBlock(int i)
        {
            var depth = Depth(i);
            for (var j = i - 1; j > header; j--) {
                if (Blank(j)) continue;
                if (Depth(j) >= depth) continue;
                return Depth(j) == depth - 1 && BareAssign(Content(j));
            }
            return false;
        }

        // ---- FLOW_JUMP_BY_NAME and FLOW_UNREACHED_END ---------------------------------------------------------------------

        private void Jumps()
        {
            var referenced = new HashSet<string>(StringComparer.Ordinal);
            for (var i = header + 1; i < cur.Length; i++) {
                var content = Blank(i) ? "" : Content(i);
                if (content.StartsWith("-> @", StringComparison.Ordinal)) referenced.Add(content[4..]);
                if (content.StartsWith("//-> @", StringComparison.Ordinal) && content.IndexOf(' ', 6) is > 6 and var space) referenced.Add(content[6..space]);
            }
            for (var i = header + 1; i < cur.Length; i++) {
                if (Blank(i)) continue;
                var content = Content(i);
                if (content.StartsWith("-> ", StringComparison.Ordinal) && !content.StartsWith("-> @", StringComparison.Ordinal) && content != "-> (no connector)"
                    && FlowSyntax.IsIdentifier(content[3..].Trim())) {
                    var name = content[3..].Trim();
                    var nodes = Enumerable.Range(header + 1, cur.Length - header - 1).Where(j => !Blank(j) && NodeName(j) is { } n && string.Equals(n, name, StringComparison.Ordinal)).ToList();
                    if (nodes.Count != 1) { Hints[i + 1] = "a jump names the id of the step it goes to: -> @id" + (nodes.Count > 1 ? " (" + nodes.Count + " steps are named " + name + ")" : ""); continue; }
                    var id = IdOf(nodes[0], JumpByName);
                    Set(i, cur[i][..Spaces(i)] + "-> @" + id, JumpByName, "the jump to " + name + " is written with its id: -> @" + id);
                    referenced.Add(id);
                }
            }
            for (var i = header + 1; i < cur.Length; i++) {
                if (Blank(i) || Head(Content(i)) != "end") continue;
                if (FlowSyntax.SplitKey(Content(i), out _, out var id) && referenced.Contains(id)) continue;
                int? previous = null;
                for (var j = i - 1; j > header && previous == null; j--) if (!Blank(j)) previous = j;
                if (previous is not { } p || Depth(p) != Depth(i)) continue;
                var head = Head(Content(p));
                if (head.StartsWith("navigate ", StringComparison.Ordinal) || head.StartsWith("raise ", StringComparison.Ordinal))
                    Set(i, "", UnreachedEnd, "a " + head[..head.IndexOf(' ')] + " ends its branch: the end after it is no step");
            }
        }

        // The name of the node a line writes: `Name = ...`, or the action a call names (the last part of its name).
        private string? NodeName(int i)
        {
            var content = Content(i);
            if (Code(content) || Description(content) || content.StartsWith("//", StringComparison.Ordinal) || content.StartsWith("@{", StringComparison.Ordinal)
                || Parameter(content) || InAssignBlock(i)) return null;
            var head = Head(content);
            if (Keyword(head)) return null;
            if (Named.Match(head) is { Success: true } named) return named.Groups[1].Value;
            if (CallHead.Match(head) is { Success: true } call && call.Length < head.Length && head[call.Length] == '(') return call.Value[(call.Value.LastIndexOf('.') + 1)..];
            return null;
        }
    }

    // ---- the shapes of one line ---------------------------------------------------------------------------------------------

    // Where the label of a line starts (its #), outside "texts", `escaped expressions` and #date# literals: a # with a space
    // before and after it. Null when the line has none.
    internal static int? LabelAt(string content)
    {
        for (var i = 0; i < content.Length; i++) {
            var c = content[i];
            if (c == '"') { i++; while (i < content.Length && !(content[i] == '"' && !(i + 1 < content.Length && content[i + 1] == '"'))) i += content[i] == '"' ? 2 : 1; continue; }
            if (c == '`') { var j = i; try { FlowSyntax.ReadEscaped(content, ref j); i = j - 1; } catch (FormatException) { return null; } continue; }
            if (c != '#') continue;
            if (i > 0 && content[i - 1] == ' ' && (i + 1 == content.Length || content[i + 1] == ' ')) return i;
            var end = content.IndexOf('#', i + 1);
            if (end < 0) return null;
            i = end;
        }
        return null;
    }

    // The content of a node line split into its head and its tail (the label and the id, as written).
    private static (string Head, string Tail) Split(string content)
    {
        var withoutKey = FlowSyntax.SplitKey(content, out var head, out _) ? head : content;
        var tail = content[withoutKey.Length..];
        var label = withoutKey.IndexOf("  # ", StringComparison.Ordinal);
        if (label >= 0 && LabelAt(withoutKey) == label + 2) { tail = withoutKey[label..] + tail; withoutKey = withoutKey[..label]; }
        return (withoutKey, tail);
    }

    // `Variable = value` from `Variable=value` (any spaces around the first `=` outside texts and brackets, after a name, that
    // is no part of <=, >= or <>); null when the text has no such shape.
    internal static string? Assignment(string text)
    {
        var depth = 0;
        for (var i = 0; i < text.Length; i++) {
            var c = text[i];
            if (c == '"') { i++; while (i < text.Length && !(text[i] == '"' && !(i + 1 < text.Length && text[i + 1] == '"'))) i += text[i] == '"' ? 2 : 1; continue; }
            if (c == '`') return null;
            if (c is '(' or '[' or '{') { depth++; continue; }
            if (c is ')' or ']' or '}') { depth--; continue; }
            if (c != '=' || depth != 0) continue;
            if (i > 0 && text[i - 1] is '<' or '>' or '!' or '=' || i + 1 < text.Length && text[i + 1] == '=') return null;
            var variable = text[..i].TrimEnd();
            var value = text[(i + 1)..].TrimStart();
            if (value.Length == 0 || !LValue.IsMatch(variable)) return null;
            return variable + " = " + value;
        }
        return null;
    }

    // A call `Callee(arguments)` with its arguments in the grammar's spelling: `P=v` for a named one (no space around its `=`),
    // a name alone for a positional one, ", " between them, no space before the parenthesis; the text after the closing
    // parenthesis is kept. Without parentheses (`Screen` alone): `Screen()` (empty). Null when the text is no such call (an
    // argument that is an expression, a parenthesis left open), or, with needs, when it has no parenthesis.
    private static string? Call(string text, out string callee, out bool empty, bool needs = false)
    {
        empty = false;
        var head = CallHead.Match(text);
        callee = head.Value;
        if (!head.Success) return null;
        var i = head.Length;
        while (i < text.Length && text[i] == ' ') i++;
        if (i >= text.Length) { if (needs) return null; empty = true; return callee + "()"; }
        if (text[i] != '(') return null;
        var arguments = Arguments(text, i, out var close);
        if (arguments == null) return null;
        return callee + arguments + text[(close + 1)..];
    }

    private static string? Arguments(string text, int open, out int close)
    {
        close = -1;
        var parts = new List<string>();
        var i = open + 1;
        void Spaces() { while (i < text.Length && text[i] == ' ') i++; }
        Spaces();
        if (i < text.Length && text[i] == ')') { close = i; return "()"; }
        while (true) {
            Spaces();
            var start = i;
            while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
            var name = text[start..i];
            if (name.Length == 0) return null;
            var mark = i;
            Spaces();
            if (i < text.Length && text[i] == '=' && !(i + 1 < text.Length && text[i + 1] == '=')) {
                i++;
                Spaces();
                string value;
                if (i < text.Length && text[i] == '`') {
                    var j = i;
                    try { FlowSyntax.ReadEscaped(text, ref j); } catch (FormatException) { return null; }
                    value = text[i..j]; i = j;
                } else {
                    var end = FlowSyntax.Scan(text, i, FlowPrinter.CallValue);
                    if (end < 0 || end >= text.Length) return null;
                    value = text[i..end].TrimEnd(); i = end;
                }
                if (value.Length == 0) return null;
                parts.Add(name + "=" + value);
            } else { i = mark; parts.Add(name); }
            Spaces();
            if (i >= text.Length) return null;
            if (text[i] == ')') { close = i; break; }
            if (text[i] != ',') return null;
            i++;
        }
        return "(" + string.Join(", ", parts) + ")";
    }
}
