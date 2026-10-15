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
        try {
            var parser = new FlowParser(text, Mode.Collect);
            parser.Run();
            // One error of where a line stands a line (its first): a line the recovery meets twice (its block ends, then it is no
            // step) is one problem; an error of what the line says stays beside it.
            var seen = new HashSet<int>();
            var found = parser.errors.Distinct(StringComparer.Ordinal)
                .Where(e => !Placement.IsMatch(e) || FlowTextNormalizer.LineOf(e) is not { } n || seen.Add(n)).ToList();
            if (found.Count == 0 || found[0] != first.Message) return new FlowSyntaxException([first.Message]);
            return new FlowSyntaxException(found);
        } catch (Exception) { return new FlowSyntaxException([first.Message]); }
    }

    /// <summary>The edits that make a text the grammar reads where it has one reading (the lenient pass): applied by
    /// FlowTextNormalizer, which keeps them only when the edited text parses (and lists each). Empty for a text that parses.</summary>
    public static List<FlowTextEdit> Edits(string text) => Lenient(text).Edits;

    /// <summary>The lenient pass whole: the certain edits and the fall-throughs with two readings (never among the edits).</summary>
    public static (List<FlowTextEdit> Edits, List<FlowTextAmbiguity> Ambiguities) Lenient(string text)
    {
        try {
            var parser = new FlowParser(text, Mode.Lenient);
            parser.Run();
            return (parser.edits, parser.ambiguities);
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
    private static readonly string[] SqlJoins = [" LEFT OUTER JOIN ", " RIGHT OUTER JOIN ", " FULL OUTER JOIN ",
        " INNER JOIN ", " LEFT JOIN ", " RIGHT JOIN ", " FULL JOIN "];
    private static readonly string[] Boundaries = [.. SqlJoins, .. FlowPrinter.AggregateKeywords];
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
                var clause = token.Trim();
                if (!clauses.TryGetValue(clause, out var values)) clauses[clause] = values = [];
                if (values.Count > 0 && clause is "MAX" or "START")
                    return (null, "ambiguous repeated " + clause + ": " + values[0] + " or " + value + "; keep exactly one");
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