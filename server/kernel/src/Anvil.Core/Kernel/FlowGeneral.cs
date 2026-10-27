using System.Text.RegularExpressions;

namespace Anvil.Reading;

/// <summary>
/// What the module knows of the types an expansion of the general language needs and the text does not say (R7): the
/// attributes of an entity or structure, in their order, with their types, and the outputs of an action a call names. Null
/// always means unknown: an expansion that needs it refuses, naming what to write.
/// </summary>
public interface IFlowSchema
{
    IReadOnlyList<(string Name, string Type)>? Attributes(string record);
    IReadOnlyList<(string Name, string Type)>? Outputs(string callee) => null;
}

/// <summary>The schemas an expansion reads: the base of a job (FlowSchema.Kernel.cs: Preflight.IBaseFacts, IFlowTypes),
/// the signatures the texts of one op declare, or several of them in order (the first that knows answers).</summary>
public static partial class FlowSchema
{
    public static IFlowSchema Of(IReadOnlyDictionary<string, IReadOnlyList<(string Name, string Type)>> records,
        IReadOnlyDictionary<string, IReadOnlyList<(string Name, string Type)>>? outputs = null) => new Fixed(records, outputs);
    public static IFlowSchema Combine(params IFlowSchema?[] schemas) => new Chain(schemas.OfType<IFlowSchema>().ToList());

    private sealed class Fixed(IReadOnlyDictionary<string, IReadOnlyList<(string Name, string Type)>> records,
        IReadOnlyDictionary<string, IReadOnlyList<(string Name, string Type)>>? outputs) : IFlowSchema
    {
        public IReadOnlyList<(string Name, string Type)>? Attributes(string record) =>
            records.FirstOrDefault(r => string.Equals(r.Key, record, StringComparison.OrdinalIgnoreCase)).Value;
        public IReadOnlyList<(string Name, string Type)>? Outputs(string callee) =>
            outputs?.FirstOrDefault(r => string.Equals(r.Key, callee, StringComparison.OrdinalIgnoreCase)).Value;
    }

    private sealed class Chain(List<IFlowSchema> schemas) : IFlowSchema
    {
        public IReadOnlyList<(string Name, string Type)>? Attributes(string record) => schemas.Select(s => s.Attributes(record)).FirstOrDefault(a => a != null);
        public IReadOnlyList<(string Name, string Type)>? Outputs(string callee) => schemas.Select(s => s.Outputs(callee)).FirstOrDefault(a => a != null);
    }
}

// ---- the general language of ssam-flow/1 (R7, 24/10/2026) ------------------------------------------------------------------
//
// Shorter lines a model writes for what the grammar spells out, each with one reading, expanded into the grammar's own lines
// before the parse (FlowTextNormalizer, after FlowTolerance): an edit of the text as given (a whole line replaced, emptied or
// inserted), listed in normalizations like any other, never a second grammar: the reader prints the expanded text, so the
// text read back is the canonical one and sent again writes nothing (fixed point).
//   FLOW_GENERAL_LET        `let X = v`: the local X, of the type v has with certainty (a literal, a declared name, a field of
//                           a record the schema knows, an output of a call, a row of an aggregate, a function of fixed type),
//                           and `assign X = v` where the let was; `let X: T = v` names the type; each let is its own assign;
//   FLOW_GENERAL_REQUIRE    `require c else raise E(m)` (or `else return [...]`, `else end`, `else -> @id`): `if not (c):` with
//                           the else one level in; the steps after it are its false branch;
//   FLOW_GENERAL_RETURN     `return` is `end`; `return Out = v, ...` assigns the outputs first;
//   FLOW_GENERAL_JOIN       in a text that uses let, require or return, a branch without a terminator goes on to the step
//                           after its block, as in any structured language (the If reading FlowParser.Lenient names, FLOW_ELSE
//                           and FLOW_BRANCH_FALLS_THROUGH where they already decide), and the steps after a switch go in the
//                           first case that reaches them, the other cases jumping to them;
//   FLOW_GENERAL_COPY       `X = { ...S, F: v }`: `X = S` and `X.F = v` in one assign;
//   FLOW_GENERAL_PROJECTION `X = S mapTo { *, F: v }`: every attribute of X's type the item of S has by name, F as written;
//   FLOW_GENERAL_CONTEXT    `context N: T` above the actions of a text: the input N of every action that reads N (or calls one
//                           that needs it), and the argument N of those calls;
//   FLOW_GENERAL_SQL_BIND   a `@P` of a sql node's code with no `in P` under the node: `in P: T = P`, P the input, output or
//                           local of that name (one, scalar).
// Anything with two readings refuses, saying what to write (Problems: "line N: ..."), and the text is left as written.
public static class FlowGeneral
{
    public const string Let = "FLOW_GENERAL_LET";
    public const string Require = "FLOW_GENERAL_REQUIRE";
    public const string Return = "FLOW_GENERAL_RETURN";
    public const string Join = "FLOW_GENERAL_JOIN";
    public const string Copy = "FLOW_GENERAL_COPY";
    public const string Projection = "FLOW_GENERAL_PROJECTION";
    public const string Context = "FLOW_GENERAL_CONTEXT";
    public const string SqlBind = "FLOW_GENERAL_SQL_BIND";
    public const string Record = "FLOW_GENERAL_RECORD";
    public const string Contract = "FLOW_GENERAL_CONTRACT";

    /// <summary>The text with its general forms expanded (the text as given when there is nothing to expand or a form refuses),
    /// the edits of the text as given, and the problems of the forms that cannot expand (each "line N: ...").</summary>
    public sealed record Expansion(string Text, IReadOnlyList<FlowTextEdit> Edits, IReadOnlyList<string> Problems)
    {
        /// <summary>Whether the text writes a statement of the general language (let, require, return): its branches read as a
        /// structured language's (FLOW_GENERAL_JOIN).</summary>
        public bool Structured { get; init; }
        /// <summary>The edits of the forms that expand even when another refuses (the certain part of a patch).</summary>
        public IReadOnlyList<FlowTextEdit> Certain { get; init; } = [];
    }

    private static readonly Regex Header = new(@"^(?:server action|service action|client action|data action|action) \S", RegexOptions.CultureInvariant);
    private static readonly Regex ContextLine = new(@"^context ([A-Za-z_][A-Za-z0-9_]*): (\S.*)$", RegexOptions.CultureInvariant);
    private static readonly Regex Statement = new(@"^(?:let |require |return(?: |$)|load |insert |update |delete |use )", RegexOptions.CultureInvariant);
    private static readonly Regex ContractHead = new(@"^contract ([A-Za-z_][A-Za-z0-9_]*):$", RegexOptions.CultureInvariant);
    private static readonly Regex ContractBody = new(@"^(?:in |out |local |let |load |require |use |///)", RegexOptions.CultureInvariant);
    private static readonly Regex BindingLine = new(@"^binding ([A-Za-z_][A-Za-z0-9_]*): (.+?) = (\S.*)$", RegexOptions.CultureInvariant);

    /// <summary>Whether a text writes a form of the general language (a line of the flow starting with let, require, return,
    /// load, insert, update, delete or use, a context, contract or binding above its header, a copy, a projection).</summary>
    public static bool Uses(string text) => text.Replace("\r\n", "\n").Split('\n').Any(line => {
        var content = line.TrimStart(' ');
        return Statement.IsMatch(content) && line.Length > content.Length || ContextLine.IsMatch(line) || ContractHead.IsMatch(line) || BindingLine.IsMatch(line)
            || content.Contains("{ ...", StringComparison.Ordinal) || content.Contains("{...", StringComparison.Ordinal) || content.Contains("mapTo { *", StringComparison.Ordinal);
    });

    /// <summary>The general forms of one text (one action, or several one after the other with their contexts above them).</summary>
    public static Expansion Expand(string text, IFlowSchema? schema = null)
    {
        var doc = new Document(text);
        if (!doc.Any()) return new(text, [], []);
        var expanded = new Expander(doc, schema, null).Run();
        return expanded;
    }

    /// <summary>The texts of one op (data.flow) with their general forms expanded, a context at the top of one of them reaching
    /// every action of the op that reads it: each text with its edits, and the problems of all (each "text i: line N: ...").</summary>
    public static (List<Expansion> Texts, List<string> Problems) ExpandAll(IReadOnlyList<string> texts, IFlowSchema? schema = null)
    {
        var docs = texts.Select(t => new Document(t)).ToList();
        var shared = new Shared(docs, schema);
        var results = new List<Expansion>();
        var problems = new List<string>();
        for (var i = 0; i < docs.Count; i++) {
            var result = docs[i].Any() || shared.Contexts.Count > 0 || shared.Contracts.Count > 0 || shared.Bindings.Count > 0 ? new Expander(docs[i], schema, shared).Run() : new Expansion(texts[i], [], []);
            results.Add(result);
            problems.AddRange(result.Problems.Select(p => (texts.Count > 1 ? "text " + (i + 1) + ": " : "") + p));
        }
        return (results, problems);
    }

    // ---- the lines of a text ---------------------------------------------------------------------------------------------

    private sealed class Row(string text, int origin, int source)
    {
        public string Text = text;
        // The line of the text as given (0-based) this row is, -1 for a line the expansion adds or moves.
        public int Origin = origin;
        // The line (1-based) whose form wrote the row, for the messages.
        public readonly int Source = source;
        public string? Rule;
        public string? Message;
        public int Spaces { get { var s = 0; while (s < Text.Length && Text[s] == ' ') s++; return s; } }
        public int Depth => Spaces / 2;
        public string Content => Text.TrimStart(' ');
        public bool Blank => Text.Trim(' ').Length == 0;
    }

    private sealed class Document
    {
        public readonly string[] Raw;
        public readonly List<Row> Rows = [];
        public readonly bool EndsWithBreak;

        public Document(string text)
        {
            Raw = text.Replace("\r\n", "\n").Split('\n');
            for (var i = 0; i < Raw.Length; i++) Rows.Add(new Row(Raw[i], i, i + 1));
            EndsWithBreak = Raw.Length > 0 && Raw[^1].Length == 0;
        }

        public bool Any() => Rows.Any(r => !r.Blank && r.Depth >= 1 && (Statement.IsMatch(r.Content) || r.Content.Contains("{ ...", StringComparison.Ordinal)
            || r.Content.Contains("{...", StringComparison.Ordinal) || r.Content.Contains("mapTo { *", StringComparison.Ordinal) || r.Content.EndsWith(" = sql", StringComparison.Ordinal)
            || r.Content.Contains(" = sql -> ", StringComparison.Ordinal) || r.Content.StartsWith("switch:", StringComparison.Ordinal)) || ContextLine.IsMatch(r.Text) || ContractHead.IsMatch(r.Text) || BindingLine.IsMatch(r.Text));

        // The action headers (row indexes) in order.
        public List<int> Headers() => Enumerable.Range(0, Rows.Count).Where(i => Rows[i].Spaces == 0 && Header.IsMatch(Rows[i].Text)).ToList();

        // The edits that make the text as given these rows: a kept line changed is replaced whole, a line no row keeps is
        // emptied, an added row is inserted before the next kept line (after the last line at the end).
        public List<FlowTextEdit> Edits()
        {
            var last = -1;
            foreach (var row in Rows) {
                if (row.Origin < 0) continue;
                if (row.Origin <= last) row.Origin = -1; else last = row.Origin;
            }
            var kept = Rows.Where(r => r.Origin >= 0).ToDictionary(r => r.Origin);
            var edits = new List<FlowTextEdit>();
            var gone = new HashSet<int>();
            for (var k = 0; k < Raw.Length; k++) {
                if (kept.TryGetValue(k, out var row)) {
                    if (row.Text != Raw[k]) edits.Add(new FlowTextEdit(row.Rule ?? Join, k + 1, false, Raw[k], row.Text, row.Message ?? Say(k + 1, "the line is " + row.Text.Trim())));
                } else if (Raw[k].Trim(' ').Length > 0) gone.Add(k);
            }
            for (var i = 0; i < Rows.Count; i++) {
                var row = Rows[i];
                if (row.Origin >= 0) continue;
                var before = Rows.Skip(i + 1).FirstOrDefault(r => r.Origin >= 0)?.Origin is { } next ? next + 1 : Raw.Length + (EndsWithBreak ? 0 : 1);
                if (EndsWithBreak && before > Raw.Length) before = Raw.Length;
                edits.Add(new FlowTextEdit(row.Rule ?? Join, before, true, null, row.Text, row.Message ?? Say(row.Source, "the line " + row.Text.Trim() + " is added")));
            }
            foreach (var k in gone) {
                var moved = Rows.FirstOrDefault(r => r.Origin < 0 && r.Source == k + 1 && r.Text.Trim() == Raw[k].Trim());
                edits.Add(new FlowTextEdit(moved?.Rule ?? Rows.FirstOrDefault(r => r.Source == k + 1 && r.Rule != null)?.Rule ?? Join, k + 1, false, Raw[k], "",
                    moved?.Message ?? Say(k + 1, "the line is written elsewhere: " + Raw[k].Trim())));
            }
            return edits.OrderBy(e => e.Line).ThenBy(e => e.Insert ? 0 : 1).ToList();
        }
    }

    private static string Say(int line, string message) => "line " + line + ": " + message;
    private static string Indent(int depth) => new(' ', depth * 2);

    // The content of a line split into its head and its tail (the label and the id, as written: "  # label @id").
    private static (string Head, string Tail) Split(string content)
    {
        var withoutKey = FlowSyntax.SplitKey(content, out var head, out _) ? head : content;
        var tail = content[withoutKey.Length..];
        var label = withoutKey.IndexOf("  # ", StringComparison.Ordinal);
        if (label >= 0 && FlowTolerance.LabelAt(withoutKey) == label + 2) { tail = withoutKey[label..] + tail; withoutKey = withoutKey[..label]; }
        return (withoutKey.TrimEnd(), tail);
    }

    // The parts of a list separated by commas at the top level of an expression (outside texts, dates and brackets).
    private static List<string>? Parts(string text)
    {
        var parts = new List<string>();
        var at = 0;
        while (true) {
            var end = FlowSyntax.Scan(text, at, [","]);
            if (end < 0) return null;
            parts.Add(text[at..end].Trim());
            if (end >= text.Length) return parts;
            at = end + 1;
        }
    }

    // ---- what one op shares: its contexts and the signatures its actions declare -------------------------------------------

    private sealed record Signature(string Name, string Kind, bool New, List<(string Name, string Type)> Inputs, List<(string Name, string Type)> Outputs);

    private sealed class Shared
    {
        public readonly List<(string Name, string Type, int Line, Document Doc)> Contexts = [];
        public readonly Dictionary<string, Signature> Signatures = new(StringComparer.OrdinalIgnoreCase);
        // The actions of the op that need each context, by action name: a fixed point over the calls between them.
        public readonly Dictionary<string, HashSet<string>> Needs = new(StringComparer.OrdinalIgnoreCase);
        public readonly List<(string Message, Document Doc)> Problems = [];
        // The contracts of the op (`contract Name:` and its lines, in/out/local/let/load/require/use), by name, and where
        // each is written; the bindings of SQL parameters (`binding Name: Type = value`).
        public readonly Dictionary<string, (List<string> Lines, int Line, Document Doc)> Contracts = new(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, (string Type, string Value, int Line, Document Doc)> Bindings = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, List<string>?> resolved = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>The lines of a contract with every `use` in it resolved; null (a problem) for an unknown or cyclic one.</summary>
        public List<string>? Resolve(string name, int line, List<string> problems, List<string>? stack = null)
        {
            stack ??= [];
            if (stack.Contains(name, StringComparer.OrdinalIgnoreCase)) { problems.Add(Say(line, Contract + ": the contract " + name + " uses itself (" + string.Join(" -> ", stack.Append(name)) + ")")); return null; }
            if (!Contracts.TryGetValue(name, out var contract)) { problems.Add(Say(line, Contract + ": no contract " + name + " in this op (contract " + name + ": above the actions, with its lines one level in)")); return null; }
            if (resolved.TryGetValue(name, out var done)) return done;
            var lines = new List<string>();
            foreach (var text in contract.Lines) {
                var use = Regex.Match(text.Trim(), @"^use ([A-Za-z_][A-Za-z0-9_]*)$");
                if (!use.Success) { lines.Add(text); continue; }
                if (Resolve(use.Groups[1].Value, contract.Line, problems, [.. stack, name]) is not { } inner) { resolved[name] = null; return null; }
                lines.AddRange(inner);
            }
            return resolved[name] = lines;
        }

        public Shared(List<Document> docs, IFlowSchema? schema)
        {
            var actions = new List<(Document Doc, int Header, int End, string Name)>();
            foreach (var doc in docs)
                for (var i = 0; i < doc.Rows.Count; i++) {
                    var row = doc.Rows[i];
                    if (row.Spaces != 0 || row.Blank) continue;
                    if (ContractHead.Match(row.Text) is { Success: true } head) {
                        var lines = new List<string>();
                        for (var j = i + 1; j < doc.Rows.Count && (doc.Rows[j].Blank || doc.Rows[j].Spaces > 0); j++) if (!doc.Rows[j].Blank) lines.Add(doc.Rows[j].Text);
                        var name = head.Groups[1].Value;
                        var bad = lines.FirstOrDefault(l => l.Length - l.TrimStart(' ').Length != 2 || !ContractBody.IsMatch(l.TrimStart(' ')));
                        if (Contracts.ContainsKey(name)) Problems.Add((Say(row.Source, Contract + ": the contract " + name + " is written twice"), doc));
                        else if (lines.Count == 0) Problems.Add((Say(row.Source, Contract + ": the contract " + name + " has no line"), doc));
                        else if (bad != null) Problems.Add((Say(row.Source, Contract + ": a contract has in, out, local, let, load, require, use and /// lines one level in: " + bad.Trim()), doc));
                        else Contracts[name] = (lines, row.Source, doc);
                    } else if (BindingLine.Match(row.Text) is { Success: true } binding) {
                        var name = binding.Groups[1].Value;
                        if (Bindings.ContainsKey(name)) Problems.Add((Say(row.Source, SqlBind + ": the binding " + name + " is written twice"), doc));
                        else Bindings[name] = (binding.Groups[2].Value.Trim(), binding.Groups[3].Value.Trim(), row.Source, doc);
                    }
                }
            // Every contract resolved once, used or not: an unknown or cyclic one is a problem of its own text.
            foreach (var (name, contract) in Contracts.ToList()) {
                var found = new List<string>();
                Resolve(name, contract.Line, found);
                Problems.AddRange(found.Select(f => (f, contract.Doc)));
            }
            foreach (var doc in docs) {
                var headers = doc.Headers();
                for (var h = 0; h < headers.Count; h++) {
                    var end = ActionEnd(doc.Rows, headers[h], h + 1 < headers.Count ? headers[h + 1] : doc.Rows.Count);
                    var signature = Declared(doc.Rows, headers[h], end);
                    if (signature == null) continue;
                    Signatures.TryAdd(signature.Name, signature);
                    actions.Add((doc, headers[h], end, signature.Name));
                }
                foreach (var row in doc.Rows.TakeWhile(r => !(r.Spaces == 0 && Header.IsMatch(r.Text))))
                    if (ContextLine.Match(row.Text) is { Success: true } context) {
                        var name = context.Groups[1].Value;
                        if (Contexts.Any(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))) Problems.Add((Say(row.Source, Context + ": context " + name + " is written twice"), doc));
                        else Contexts.Add((name, context.Groups[2].Value.Trim(), row.Source, doc));
                    }
            }
            foreach (var context in Contexts) {
                var needs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var a in actions)
                    if (Reads(a.Doc.Rows, a.Header, a.End, context.Name) && !Signatures[a.Name].Inputs.Any(i => i.Name.Equals(context.Name, StringComparison.OrdinalIgnoreCase)))
                        needs.Add(a.Name);
                for (var changed = true; changed;) {
                    changed = false;
                    foreach (var a in actions)
                        if (!needs.Contains(a.Name) && !Signatures[a.Name].Inputs.Any(i => i.Name.Equals(context.Name, StringComparison.OrdinalIgnoreCase))
                            && Calls(a.Doc.Rows, a.Header, a.End).Any(c => needs.Contains(c.Callee) && !c.Passes(context.Name)))
                            changed = needs.Add(a.Name);
                }
                Needs[context.Name] = needs;
            }
        }
    }

    // Where an action ends: the next header, or a line at column 0 before it (a contract, a binding, a context).
    private static int ActionEnd(List<Row> rows, int start, int next)
    {
        for (var j = start + 1; j < next; j++)
            if (rows[j].Spaces == 0 && !rows[j].Blank && !rows[j].Content.StartsWith("///", StringComparison.Ordinal)) return j;
        return next;
    }

    // The signature an action text declares (header, inputs, outputs), null for a header the grammar does not read.
    private static Signature? Declared(List<Row> rows, int header, int end)
    {
        var head = rows[header].Content;
        if (FlowSyntax.SplitKey(head, out var withoutKey, out _)) head = withoutKey;
        var words = head.Split(' ');
        var label = words[0] is "server" or "service" or "client" or "data" ? 2 : 1;
        if (words.Length <= label) return null;
        var name = words[label];
        var kind = label == 2 ? words[0] : "screen";
        var inputs = new List<(string, string)>();
        var outputs = new List<(string, string)>();
        for (var i = header + 1; i < end; i++) {
            if (rows[i].Blank || rows[i].Depth != 1) continue;
            if (Declaration(rows[i].Content) is not { } d) continue;
            if (d.Role == "in") inputs.Add((d.Name, d.Type)); else if (d.Role == "out") outputs.Add((d.Name, d.Type));
        }
        return new Signature(name, kind, !FlowSyntax.SplitKey(rows[header].Content, out _, out _), inputs, outputs);
    }

    private static readonly Regex DeclarationLine = new(@"^(in|out|local) ([A-Za-z_][A-Za-z0-9_]*)\??(?:: ([^=@]+?))?(?: inline)?(?: = .*?)?(?: @\S+)?$", RegexOptions.CultureInvariant);

    private static (string Role, string Name, string Type)? Declaration(string content)
    {
        var match = DeclarationLine.Match(content);
        if (!match.Success) return null;
        return (match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Success ? match.Groups[3].Value.Trim() : "");
    }

    // Whether the steps of an action read a name (a word of an expression, not a member of another, outside texts).
    private static bool Reads(List<Row> rows, int header, int end, string name)
    {
        for (var i = header + 1; i < end; i++) {
            var row = rows[i];
            if (row.Blank || row.Depth < 1) continue;
            var content = row.Content;
            if (content.StartsWith("///", StringComparison.Ordinal) || content.StartsWith("//", StringComparison.Ordinal) || content.StartsWith('|') || content.StartsWith("@{", StringComparison.Ordinal)) continue;
            if (Declaration(content) is { } d && row.Depth == 1) { if (d.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return false; continue; }
            if (Words(content).Any(w => w.Equals(name, StringComparison.OrdinalIgnoreCase))) return true;
        }
        return false;
    }

    // The words of an expression that start a name (not after a dot), outside "texts" and #dates#.
    private static IEnumerable<string> Words(string text)
    {
        for (var i = 0; i < text.Length;) {
            var c = text[i];
            if (c == '"') { i++; while (i < text.Length && !(text[i] == '"' && !(i + 1 < text.Length && text[i + 1] == '"'))) i += text[i] == '"' ? 2 : 1; i++; continue; }
            if (c == '#') { var close = text.IndexOf('#', i + 1); if (close < 0) yield break; i = close + 1; continue; }
            if (char.IsLetter(c) || c == '_') {
                var start = i;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                if (start == 0 || text[start - 1] != '.' && text[start - 1] != '@') yield return text[start..i];
                continue;
            }
            i++;
        }
    }

    private sealed record CallLine(int Row, string Prefix, string Callee, string Arguments, string Tail)
    {
        public bool Passes(string name) => Parts(Arguments) is { } parts && parts.Any(p => p.Equals(name, StringComparison.OrdinalIgnoreCase)
            || p.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase));
    }

    private static readonly Regex CallText = new(@"^((?:[A-Za-z_][A-Za-z0-9_]* = )?)((?:\([A-Za-z_][A-Za-z0-9_ ]*\)\.)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\((.*)\)$", RegexOptions.CultureInvariant);

    private static IEnumerable<CallLine> Calls(List<Row> rows, int header, int end)
    {
        for (var i = header + 1; i < end; i++) {
            if (rows[i].Blank || rows[i].Depth < 1) continue;
            var (head, tail) = Split(rows[i].Content);
            if (head.StartsWith("raise ", StringComparison.Ordinal) || head.StartsWith("navigate ", StringComparison.Ordinal) || head.StartsWith("trigger ", StringComparison.Ordinal)) continue;
            if (CallText.Match(head) is { Success: true } call && !call.Groups[2].Value.Equals("If", StringComparison.Ordinal))
                yield return new CallLine(i, call.Groups[1].Value, call.Groups[2].Value, call.Groups[3].Value, tail);
        }
    }

    // ---- the expansion of one text ---------------------------------------------------------------------------------------

    private sealed class Expander(Document doc, IFlowSchema? schema, Shared? shared)
    {
        private readonly List<Row> rows = doc.Rows;
        private readonly List<string> problems = [];
        private bool structured;
        private int joins;
        private readonly HashSet<string> ids = new(StringComparer.Ordinal);
        private Shared op = null!;

        public Expansion Run()
        {
            foreach (var row in rows)
                if (FlowSyntax.SplitKey(row.Content, out _, out var id)) ids.Add(id);
                else if (row.Content.StartsWith("-> @", StringComparison.Ordinal)) ids.Add(row.Content[4..]);
            var local = shared ?? new Shared([doc], schema);
            op = local;
            problems.AddRange(local.Problems.Where(p => p.Doc == doc).Select(p => p.Message));
            Contexts(local);
            Contracts(local);
            var headers = doc.Headers();
            for (var h = headers.Count - 1; h >= 0; h--) {
                var start = headers[h];
                var end = ActionEnd(rows, start, h + 1 < headers.Count ? headers[h + 1] : rows.Count);
                // The description lines of the next action belong to it.
                while (end - 1 > start && (rows[end - 1].Blank || rows[end - 1].Content.StartsWith("///", StringComparison.Ordinal) && rows[end - 1].Spaces == 0)) end--;
                Action(start, end, local);
            }
            var edits = doc.Edits();
            var text = string.Join("\n", doc.Raw);
            if (problems.Count > 0) return new(text, [], problems) { Structured = structured, Certain = edits };
            if (edits.Count == 0) return new(text, [], []) { Structured = structured };
            return new(FlowTextEdit.Apply(text, edits), edits, []) { Structured = structured, Certain = edits };
        }

        private void Problem(int line, string rule, string message) => problems.Add(Say(line, rule + ": " + message));

        private void Set(Row row, string text, string rule, string message)
        {
            if (row.Text == text) return;
            row.Text = text; row.Rule = rule; row.Message = Say(row.Source, message);
        }

        private Row Added(int at, string text, int source, string rule, string message)
        {
            var row = new Row(text, -1, source) { Rule = rule, Message = Say(source, message) };
            rows.Insert(at, row);
            return row;
        }

        // ---- FLOW_GENERAL_CONTEXT ----------------------------------------------------------------------------------------

        private void Contexts(Shared op)
        {
            if (op.Contexts.Count == 0) return;
            foreach (var row in rows.Where(r => ContextLine.IsMatch(r.Text) && r.Spaces == 0).ToList())
                Set(row, "", Context, "the context " + row.Text["context ".Length..] + " is an input of the actions of the op that read it");
            var headers = doc.Headers();
            for (var h = headers.Count - 1; h >= 0; h--) {
                var start = headers[h];
                var end = ActionEnd(rows, start, h + 1 < headers.Count ? headers[h + 1] : rows.Count);
                var signature = Declared(rows, start, end);
                if (signature == null) continue;
                foreach (var context in op.Contexts) {
                    var own = op.Signatures.TryGetValue(signature.Name, out var known) ? known : signature;
                    var declared = Enumerable.Range(start + 1, end - start - 1).Where(i => !rows[i].Blank && rows[i].Depth == 1).Select(i => (Row: i, Declaration(rows[i].Content)))
                        .FirstOrDefault(d => d.Item2 is { } x && x.Name.Equals(context.Name, StringComparison.OrdinalIgnoreCase));
                    if (declared.Item2 is { } existing) {
                        if (existing.Role != "in" || !SameType(existing.Type, context.Type))
                            Problem(rows[declared.Row].Source, Context, "the context " + context.Name + ": " + context.Type + " is also the " + existing.Role + " " + existing.Name + ": "
                                + existing.Type + " of " + signature.Name + "; rename one of them or write the same input");
                    }
                    var needs = op.Needs.TryGetValue(context.Name, out var set) && set.Contains(signature.Name);
                    if (needs) {
                        if (signature.Kind is "screen" or "data") {
                            Problem(rows[start].Source, Context, "the context " + context.Name + " is an input of server, service and client actions; " + signature.Name
                                + " reads it from its screen or block: declare it there");
                            continue;
                        }
                        // After the last input (and the lines under it), else after the header's own lines (@{...}, events).
                        var at = start + 1;
                        var lastInput = -1;
                        for (var i = start + 1; i < end; i++) {
                            if (rows[i].Blank || rows[i].Depth != 1) continue;
                            var content = rows[i].Content;
                            if (content.StartsWith("in ", StringComparison.Ordinal)) lastInput = i;
                            else if (lastInput < 0 && (content.StartsWith("@{", StringComparison.Ordinal) || content.StartsWith("on ", StringComparison.Ordinal) && !content.StartsWith("on exception ", StringComparison.Ordinal))) at = i + 1;
                            else if (!content.StartsWith("///", StringComparison.Ordinal)) break;
                        }
                        if (lastInput >= 0) { at = lastInput + 1; while (at < end && (rows[at].Blank || rows[at].Depth >= 2)) at++; }
                        Added(at, Indent(1) + "in " + context.Name + ": " + context.Type, context.Line, Context, "the context " + context.Name + " is an input of " + signature.Name + ", which reads it");
                        end++;
                    }
                    foreach (var call in Calls(rows, start, end).ToList()) {
                        if (!op.Needs.TryGetValue(context.Name, out var callees) || !callees.Contains(call.Callee) || call.Passes(context.Name)) continue;
                        var row = rows[call.Row];
                        var arguments = call.Arguments.Trim().Length == 0 ? context.Name : call.Arguments + ", " + context.Name;
                        Set(row, Indent(row.Depth) + call.Prefix + call.Callee + "(" + arguments + ")" + call.Tail, Context,
                            "the call of " + call.Callee + " passes the context " + context.Name);
                    }
                }
            }
        }

        // ---- FLOW_GENERAL_CONTRACT -----------------------------------------------------------------------------------------

        // The contracts and bindings of this text go (they are the op's); each `use Name` of an action is the lines of the
        // contract, every `use` in it resolved, and the declarations of the action go first, in the order they are written.
        private void Contracts(Shared shared)
        {
            if (shared.Contracts.Count == 0 && shared.Bindings.Count == 0) return;
            for (var i = 0; i < rows.Count; i++) {
                if (rows[i].Spaces != 0 || rows[i].Blank) continue;
                if (ContractHead.Match(rows[i].Text) is { Success: true } head) {
                    var what = "the contract " + head.Groups[1].Value + " is written in the actions that use it";
                    Set(rows[i], "", Contract, what);
                    for (var j = i + 1; j < rows.Count && (rows[j].Blank || rows[j].Spaces > 0); j++) if (!rows[j].Blank) Set(rows[j], "", Contract, what);
                } else if (BindingLine.Match(rows[i].Text) is { Success: true } binding)
                    Set(rows[i], "", SqlBind, "the binding " + binding.Groups[1].Value + " is the parameter of the sql nodes that read @" + binding.Groups[1].Value);
            }
            var headers = doc.Headers();
            for (var h = headers.Count - 1; h >= 0; h--) {
                var start = headers[h];
                var end = ActionEnd(rows, start, h + 1 < headers.Count ? headers[h + 1] : rows.Count);
                var used = false;
                for (var i = end - 1; i > start; i--) {
                    var row = rows[i];
                    if (row.Blank || row.Depth != 1 || Regex.Match(Split(row.Content).Head, @"^use ([A-Za-z_][A-Za-z0-9_]*)$") is not { Success: true } use) continue;
                    if (shared.Resolve(use.Groups[1].Value, row.Source, problems) is not { } lines) continue;
                    rows.RemoveAt(i);
                    rows.InsertRange(i, lines.Select(l => new Row(l, -1, row.Source) { Rule = Contract, Message = Say(row.Source, "a line of the contract " + use.Groups[1].Value + " (" + l.Trim() + ")") }));
                    end += lines.Count - 1;
                    used = true;
                }
                if (!used) continue;
                Hoist(start, end);
                var names = Enumerable.Range(start + 1, end - start - 1).Where(i => rows[i].Depth == 1 && !rows[i].Blank).Select(i => (Row: rows[i], Declaration(rows[i].Content)))
                    .Where(d => d.Item2 != null).GroupBy(d => d.Item2!.Value.Name, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
                if (names != null) Problem(names.Last().Row.Source, Contract, names.Key + " is declared twice in the action (by a contract it uses and by the action, or by two contracts)");
            }
        }

        // The declarations (in, out, local, with the /// above and the @{...} under each) of an action that come after a step
        // go before the steps, in their order; the header's own lines (@{...}, events) stay first.
        private void Hoist(int start, int end)
        {
            var body = rows.GetRange(start + 1, end - start - 1);
            var groups = new List<Row>();
            var claimed = new HashSet<Row>();
            bool step = false, late = false;
            bool Own(Row r) => r.Blank || r.Depth == 1 && (r.Content.StartsWith("@{", StringComparison.Ordinal) || r.Content.StartsWith("on ", StringComparison.Ordinal)
                && !r.Content.StartsWith("on exception ", StringComparison.Ordinal)) || r.Depth == 2 && r.Content.StartsWith("@{", StringComparison.Ordinal);
            for (var k = 0; k < body.Count; k++) {
                var r = body[k];
                if (r.Blank) continue;
                if (r.Depth == 1 && Declaration(r.Content) != null) {
                    var s = k;
                    while (s > 0 && body[s - 1].Depth == 1 && body[s - 1].Content.StartsWith("///", StringComparison.Ordinal) && !claimed.Contains(body[s - 1])) s--;
                    var e = k + 1;
                    while (e < body.Count && body[e].Depth >= 2 && body[e].Content.StartsWith("@{", StringComparison.Ordinal)) e++;
                    for (var t = s; t < e; t++) { groups.Add(body[t]); claimed.Add(body[t]); }
                    late |= step;
                    k = e - 1;
                    continue;
                }
                if (!Own(r) && !(r.Depth == 1 && r.Content.StartsWith("///", StringComparison.Ordinal))) step = true;
            }
            if (!late) return;
            var rest = body.Where(r => !claimed.Contains(r)).ToList();
            var at = 0;
            while (at < rest.Count && Own(rest[at])) at++;
            rest.InsertRange(at, groups);
            foreach (var r in groups.Where(r => r.Rule == null)) { r.Rule = Contract; r.Message = Say(r.Source, "a declaration of the action goes with the others, before the steps"); }
            rows.RemoveRange(start + 1, body.Count);
            rows.InsertRange(start + 1, rest);
        }

        // ---- one action --------------------------------------------------------------------------------------------------

        private sealed record Symbol(string Name, string Role, string Type);
        private sealed record NodeOf(string Name, string Kind, string Detail, List<string> Sources);

        private Dictionary<string, Symbol> symbols = new(StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, NodeOf> nodes = new(StringComparer.OrdinalIgnoreCase);

        private void Action(int start, int end, Shared op)
        {
            symbols = new(StringComparer.OrdinalIgnoreCase);
            nodes = new(StringComparer.OrdinalIgnoreCase);
            records.Clear();
            // The words of the action (its description too): the names the lowering writes are none of them.
            reserved.Clear();
            var first = start;
            while (first > 0 && rows[first - 1].Spaces == 0 && rows[first - 1].Content.StartsWith("///", StringComparison.Ordinal)) first--;
            for (var i = first; i < end; i++) foreach (Match word in Regex.Matches(rows[i].Text, @"\b[A-Za-z_][A-Za-z0-9_]*\b")) reserved.Add(word.Value);
            var declarations = start + 1;
            var anything = false;
            for (var i = start + 1; i < end; i++) {
                var row = rows[i];
                if (row.Blank) continue;
                var content = row.Content;
                if (row.Depth == 1 && Declaration(content) is { } d) {
                    symbols[d.Name] = new Symbol(d.Name, d.Role, d.Type);
                    declarations = i + 1;
                    for (var j = i + 1; j < end && (rows[j].Blank || rows[j].Depth >= 2); j++) if (!rows[j].Blank) declarations = j + 1;
                    continue;
                }
                if (row.Depth == 1 && (content.StartsWith("@{", StringComparison.Ordinal) || content.StartsWith("on ", StringComparison.Ordinal) && !content.StartsWith("on exception ", StringComparison.Ordinal))
                    && declarations == i) { declarations = i + 1; continue; }
                if (row.Depth >= 1) Node(content);
                if (row.Depth >= 1 && (Statement.IsMatch(content) || content.Contains("{ ...", StringComparison.Ordinal) || content.Contains("{...", StringComparison.Ordinal)
                    || content.Contains("mapTo { *", StringComparison.Ordinal) || content.Contains(" = sql -> ", StringComparison.Ordinal) || content.StartsWith("switch:", StringComparison.Ordinal))) anything = true;
                if (row.Depth >= 1 && Statement.IsMatch(content)) structured = true;
            }
            if (!anything) return;
            var locals = new List<(string Name, string Type, int Source, string Rule)>();
            var outputs = symbols.Values.Where(s => s.Role == "out").Select(s => s.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            for (var i = start + 1; i < end; i++) {
                var row = rows[i];
                // The lines a contract brought are the action's own; the lines another form added are already the grammar's.
                if (row.Blank || row.Depth < 1 || row.Origin < 0 && row.Rule != null && row.Rule != Contract || handled.Contains(row)) continue;
                var content = row.Content;
                if (content.StartsWith("///", StringComparison.Ordinal) || content.StartsWith("//", StringComparison.Ordinal) || content.StartsWith('|') || content.StartsWith("@{", StringComparison.Ordinal)) continue;
                // A record is known while the lines are in its branch; a handler starts with none.
                if (content.StartsWith("on exception ", StringComparison.Ordinal)) records.Clear();
                foreach (var gone in records.Where(r => row.Depth < r.Value.Depth).Select(r => r.Key).ToList()) records.Remove(gone);
                var before = rows.Count;
                if (Regex.IsMatch(content, @"^(?:load|insert|update|delete) ")) RecordLine(i, locals);
                else if (content.StartsWith("let ", StringComparison.Ordinal)) LetBlock(i, end, locals);
                else if (content.StartsWith("require ", StringComparison.Ordinal)) RequireLine(i, outputs);
                else if (content == "return" || content.StartsWith("return ", StringComparison.Ordinal) && !content.StartsWith("return =", StringComparison.Ordinal)) ReturnLine(i, outputs, row.Depth);
                else if (content.StartsWith("assign", StringComparison.Ordinal)) AssignValues(i, end);
                else if (Split(content).Head is var head && Regex.Match(head, @"^([A-Za-z_][A-Za-z0-9_]*) = sql -> ") is { Success: true }) SqlNode(i, end);
                end += rows.Count - before;
            }
            if (locals.Count > 0) {
                foreach (var (name, type, source, rule) in locals.AsEnumerable().Reverse())
                    Added(declarations, Indent(1) + "local " + name + ": " + type, source, rule, "the local " + name + ": " + type + " of the form of line " + source);
                end += locals.Count;
            }
            Switches(start, end);
        }

        // The nodes of the action the expressions read: aggregates (their sources), sql nodes (their structure), calls.
        private void Node(string content)
        {
            var (head, _) = Split(content);
            var named = Regex.Match(head, @"^([A-Za-z_][A-Za-z0-9_]*) = (.*)$");
            if (named.Success) {
                var value = named.Groups[2].Value;
                if (value.StartsWith("aggregate FROM ", StringComparison.Ordinal)) {
                    var from = value["aggregate FROM ".Length..];
                    var stop = Regex.Match(from, @" (?:JOIN|WHERE|GROUP BY|AGG|CALC|SORT|MAX|START) ");
                    var list = stop.Success ? from[..stop.Index] : from;
                    nodes[named.Groups[1].Value] = new NodeOf(named.Groups[1].Value, "aggregate", "", list.Split(", ").Select(s => s.Trim()).ToList());
                } else if (Regex.Match(value, @"^sql -> ([A-Za-z_][A-Za-z0-9_]*)") is { Success: true } sql)
                    nodes[named.Groups[1].Value] = new NodeOf(named.Groups[1].Value, "sql", sql.Groups[1].Value, []);
                else if (CallText.Match(head) is { Success: true } call)
                    nodes[named.Groups[1].Value] = new NodeOf(named.Groups[1].Value, "call", call.Groups[2].Value, []);
            } else if (CallText.Match(head) is { Success: true } bare && bare.Groups[1].Value.Length == 0) {
                var callee = bare.Groups[2].Value;
                var name = callee[(callee.LastIndexOf('.') + 1)..];
                nodes.TryAdd(name, new NodeOf(name, "call", callee, []));
            }
        }

        // ---- FLOW_GENERAL_LET (and FLOW_GENERAL_COPY in a let) -------------------------------------------------------------

        private readonly HashSet<Row> handled = [];

        // The lets from this line on at its depth, each expanded on its own into its own assign. A let that refuses stays as
        // written (its problem says what to write); the others still expand.
        private void LetBlock(int first, int end, List<(string Name, string Type, int Source, string Rule)> locals)
        {
            var depth = rows[first].Depth;
            var block = new List<(Row Row, string Name, string? Type, string Value, string Tail)>();
            for (var i = first; i < end; i++) {
                var row = rows[i];
                if (row.Blank || row.Depth != depth || !row.Content.StartsWith("let ", StringComparison.Ordinal)) break;
                var (head, tail) = Split(row.Content);
                var match = Regex.Match(head, @"^let ([A-Za-z_][A-Za-z0-9_]*)(?:: ([^=]+?))? = (\S.*)$");
                handled.Add(row);
                if (!match.Success) { Problem(row.Source, Let, "write `let Name = value` (or `let Name: Type = value`)"); block.Add((row, "", null, "", tail)); continue; }
                block.Add((row, match.Groups[1].Value, match.Groups[2].Success ? match.Groups[2].Value.Trim() : null, match.Groups[3].Value.Trim(), tail));
            }
            // Each let: its assignments, or null when it refuses.
            var expanded = new List<List<(string Target, string Value)>?>();
            foreach (var (row, name, written, given, _) in block) {
                if (name.Length == 0) { expanded.Add(null); continue; }
                var value = given;
                var source = row.Source;
                var failed = problems.Count;
                if (symbols.TryGetValue(name, out var taken))
                    Problem(source, Let, name + " is already the " + (taken.Role == "let" ? "local of an earlier let" : taken.Role + " " + taken.Name + ": " + taken.Type)
                        + "; give it a value with `assign " + name + " = " + value + "`");
                else if (nodes.ContainsKey(name)) Problem(source, Let, name + " is the name of a node of the action; give the local another name");
                var copy = CopyOf(value);
                string? type = written;
                if (problems.Count == failed && type == null) {
                    type = TypeOf(copy is { } c ? c.Source : value, out var why);
                    if (type == null)
                        Problem(source, Let, "the type of " + name + " is not certain from `" + value + "`" + (why == null ? "" : " (" + why + ")") + ": write `let " + name + ": <Type> = " + value + "`");
                }
                List<(string Target, string Value)>? assignments = null;
                if (problems.Count == failed) {
                    if (Projected(value, type, source) is { } projected) value = projected;
                    if (problems.Count == failed) assignments = copy is { } spread ? Spread(name, spread, source) : [(name, value)];
                }
                if (assignments == null || problems.Count > failed) { expanded.Add(null); continue; }
                symbols[name] = new Symbol(name, "let", type!);
                locals.Add((name, type!, source, Let));
                expanded.Add(assignments);
            }
            // Each let that expands: its own assign where it was.
            bool IsCopy(int j) => CopyOf(block[j].Value) != null;
            for (var k = 0; k < block.Count; k++) {
                if (expanded[k] == null) continue;
                // A copy is its own two assigns (FLOW_GENERAL_COPY), never one of a run.
                if (IsCopy(k)) { CopyNodes(block[k].Row, depth, expanded[k]!, block[k].Tail); continue; }
                var run = new List<int> { k };
                // One let is one assign, as the record lowering writes it (two lets are two steps of the flow).
                var head = block[run[0]].Row;
                var all = run.SelectMany(j => expanded[j]!).ToList();
                var form = run.Any(j => CopyOf(block[j].Value) != null) ? Copy : Let;
                if (all.Count == 1) {
                    Set(head, Indent(depth) + "assign " + all[0].Target + " = " + all[0].Value + block[run[0]].Tail, Let,
                        "the let of " + block[run[0]].Name + " is the assignment of its local (" + all[0].Target + " = " + all[0].Value + ")");
                    continue;
                }
                // One assign: its first line where the first let was, each assignment one level in, on the line of its let (the
                // assignments a copy adds right after it).
                Set(head, Indent(depth) + "assign" + block[run[0]].Tail, form, "the " + run.Count + " let(s) from here are one assign, an assignment a line");
                var place = rows.IndexOf(head) + 1;
                foreach (var j in run) {
                    var letRow = block[j].Row;
                    var rule = CopyOf(block[j].Value) != null ? Copy : Let;
                    var opening = true;
                    foreach (var (target, value) in expanded[j]!) {
                        var text = Indent(depth + 1) + target + " = " + value;
                        var message = "an assignment of the assign of line " + head.Source + " (" + target + " = " + value + ")";
                        if (opening && !ReferenceEquals(letRow, head)) { Set(letRow, text, rule, message); place = rows.IndexOf(letRow) + 1; }
                        else handled.Add(Added(place++, text, letRow.Source, rule, message));
                        opening = false;
                    }
                }
            }
        }

        // ---- FLOW_GENERAL_RECORD: load, insert, update, delete -----------------------------------------------------------

        // The records a load or an insert gives, while the lines are in their branch: an update or a delete needs one that is
        // locked (a load ... locked or an insert) where it is written; a handler starts with none.
        private sealed record Loaded(string Entity, int Depth, bool Locked);
        private readonly Dictionary<string, Loaded> records = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> reserved = new(StringComparer.OrdinalIgnoreCase);

        // A name for a node or local the lowering writes: the stem, else the stem with 2, 3... (no word of the action has it).
        private string Fresh(string stem)
        {
            var name = stem;
            for (var n = 1; reserved.Contains(name);) name = stem + ++n;
            reserved.Add(name);
            return name;
        }

        private static readonly Regex LoadLine = new(@"^load ([A-Za-z_][A-Za-z0-9_]*): ([A-Za-z_][A-Za-z0-9_]*) by (.+?)( locked)?$", RegexOptions.CultureInvariant);
        private static readonly Regex InsertLine = new(@"^insert ([A-Za-z_][A-Za-z0-9_]*): ([A-Za-z_][A-Za-z0-9_]*) \{(.+)\}$", RegexOptions.CultureInvariant);
        private static readonly Regex UpdateLine = new(@"^update ([A-Za-z_][A-Za-z0-9_]*) \{(.+)\}$", RegexOptions.CultureInvariant);
        private static readonly Regex DeleteLine = new(@"^delete ([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.CultureInvariant);

        // The rows of a record operation where its line was (the line takes the first, with its label and id), each a step of
        // the entity actions: Get<E>[ForUpdate], Create<E>, Update<E>, Delete<E>.
        private void RecordLine(int i, List<(string Name, string Type, int Source, string Rule)> locals)
        {
            var row = rows[i];
            var (head, tail) = Split(row.Content);
            var depth = row.Depth;
            var source = row.Source;
            List<string>? lines = null;
            string? what = null;
            void Local(string name, string type)
            {
                symbols[name] = new Symbol(name, "let", type);
                locals.Add((name, type, source, Record));
            }
            bool Free(string name)
            {
                if (!symbols.TryGetValue(name, out var taken) && !nodes.ContainsKey(name)) return true;
                Problem(source, Record, name + " is already " + (taken == null ? "a node of the action" : "the " + (taken.Role == "let" ? "local" : taken.Role) + " " + taken.Name + ": " + taken.Type) + "; give the record another name");
                return false;
            }
            if (LoadLine.Match(head) is { Success: true } load) {
                var (name, entity, id, locked) = (load.Groups[1].Value, load.Groups[2].Value, load.Groups[3].Value.Trim(), load.Groups[4].Success);
                if (!Free(name)) return;
                var node = Fresh("Load" + name);
                Local(name, entity);
                records[name] = new Loaded(entity, depth, locked);
                lines = [node + " = Get" + entity + (locked ? "ForUpdate" : "") + "(Id=" + id + ")" + tail, "assign " + name + " = " + node + ".Record." + entity];
                what = "the load of " + name + " is the Get" + entity + (locked ? "ForUpdate" : "") + " of its id, then the record";
            } else if (InsertLine.Match(head) is { Success: true } insert) {
                var (name, entity) = (insert.Groups[1].Value, insert.Groups[2].Value);
                if (Fields(insert.Groups[3].Value, entity, source) is not { } fields || !Free(name)) return;
                var empty = Fresh("Empty" + name);
                var created = Fresh("Create" + name);
                Local(name, entity); Local(empty, entity);
                records[name] = new Loaded(entity, depth, true);
                lines = ["assign " + name + " = " + empty + tail, "assign", .. fields.Select(f => "  " + name + "." + f.Field + " = " + f.Value),
                    created + " = Create" + entity + "(Source=" + name + ")", "assign " + name + ".Id = " + created + ".Id"];
                what = "the insert of " + name + " is an empty " + entity + ", its fields, Create" + entity + " and the id it gives";
            } else if (UpdateLine.Match(head) is { Success: true } update) {
                var name = update.Groups[1].Value;
                if (!records.TryGetValue(name, out var record) || !record.Locked) {
                    Problem(source, Record, "an update of " + name + " needs it loaded locked (load " + name + ": <Entity> by <Id> locked) or inserted in this branch"); return;
                }
                if (Fields(update.Groups[2].Value, record.Entity, source) is not { } fields) return;
                // The values read the record as it was before the update, whatever their order.
                var before = Fresh("Before" + name);
                Local(before, record.Entity);
                lines = ["assign " + before + " = " + name + tail, "assign", .. fields.Select(f => "  " + name + "." + f.Field + " = " + Renamed(f.Value, name, before)),
                    Fresh("Save" + name) + " = Update" + record.Entity + "(Source=" + name + ")"];
                what = "the update of " + name + " keeps the record before it, assigns its fields and Update" + record.Entity;
            } else if (DeleteLine.Match(head) is { Success: true } delete) {
                var name = delete.Groups[1].Value;
                if (!records.TryGetValue(name, out var record) || !record.Locked) {
                    Problem(source, Record, "a delete of " + name + " needs it loaded locked (load " + name + ": <Entity> by <Id> locked) or inserted in this branch"); return;
                }
                records.Remove(name);
                lines = [Fresh("Delete" + name) + " = Delete" + record.Entity + "(Id=" + name + ".Id)" + tail];
                what = "the delete of " + name + " is Delete" + record.Entity + " of its id";
            } else {
                Problem(source, Record, "write `load R: Entity by Id [locked]`, `insert R: Entity {Field=value, ...}`, `update R {Field=value, ...}` or `delete R`");
                return;
            }
            Set(row, Indent(depth) + lines[0], Record, what);
            var place = i + 1;
            foreach (var line in lines.Skip(1)) handled.Add(Added(place++, Indent(depth) + line, source, Record, what));
        }

        // The `Field=value` pairs of an insert or an update: unique names, attributes of the entity when the schema knows it.
        private List<(string Field, string Value)>? Fields(string text, string entity, int source)
        {
            if (Parts(text) is not { Count: > 0 } parts) { Problem(source, Record, "the fields are `{Field=value, ...}`: " + text); return null; }
            var fields = new List<(string, string)>();
            var attributes = schema?.Attributes(entity);
            foreach (var part in parts) {
                var match = Regex.Match(part, @"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$", RegexOptions.Singleline);
                if (!match.Success) { Problem(source, Record, "each field is `Field=value`: " + part); return null; }
                var field = match.Groups[1].Value;
                if (fields.Any(f => f.Item1.Equals(field, StringComparison.OrdinalIgnoreCase))) { Problem(source, Record, field + " is written twice"); return null; }
                if (attributes != null && !attributes.Any(a => a.Name.Equals(field, StringComparison.OrdinalIgnoreCase))) { Problem(source, Record, field + " is no attribute of " + entity); return null; }
                fields.Add((field, match.Groups[2].Value.Trim()));
            }
            return fields;
        }

        // The value with every read of the record's name (a word not after a dot, outside "texts") reading the other name.
        private static string Renamed(string value, string from, string to) => Regex.Replace(value, "\"(?:[^\"]|\"\")*\"|\\b[A-Za-z_][A-Za-z0-9_]*\\b",
            m => m.Value.Equals(from, StringComparison.OrdinalIgnoreCase) && (m.Index == 0 || value[m.Index - 1] != '.') ? to : m.Value);

        // ---- FLOW_GENERAL_COPY and FLOW_GENERAL_PROJECTION in assignments ---------------------------------------------------

        private void AssignValues(int i, int end)
        {
            var row = rows[i];
            var (head, tail) = Split(row.Content);
            var depth = row.Depth;
            if (head == "assign") {
                for (var j = i + 1; j < end && (rows[j].Blank || rows[j].Depth > depth); j++) {
                    if (rows[j].Blank || rows[j].Depth != depth + 1) continue;
                    if (Regex.Match(rows[j].Content, @"^([A-Za-z_][A-Za-z0-9_.]*(?:\[[^\]]+\])?) = (\S.*)$") is not { Success: true } a) continue;
                    var target = a.Groups[1].Value; var value = a.Groups[2].Value;
                    if (Projected(value, TargetType(target), rows[j].Source) is { } projected && projected != value)
                        Set(rows[j], Indent(depth + 1) + target + " = " + projected, Projection, "the projection of " + target + " names every attribute it copies (" + projected + ")");
                    else if (CopyOf(value) is { } copy && Spread(target, copy, rows[j].Source) is { } list) {
                        Set(rows[j], Indent(depth + 1) + list[0].Target + " = " + list[0].Value, Copy, "the copy into " + target + " is its source first (" + list[0].Target + " = " + list[0].Value + ")");
                        var at = j + 1;
                        foreach (var (t, v) in list.Skip(1)) { Added(at++, Indent(depth + 1) + t + " = " + v, rows[j].Source, Copy, "then the field it changes (" + t + " = " + v + ")"); end++; }
                        j = at - 1;
                    }
                }
                return;
            }
            if (Regex.Match(head, @"^assign ([A-Za-z_][A-Za-z0-9_.]*(?:\[[^\]]+\])?) = (\S.*)$") is not { Success: true } single) return;
            var to = single.Groups[1].Value; var what = single.Groups[2].Value;
            if (Projected(what, TargetType(to), row.Source) is { } projection && projection != what)
                Set(row, Indent(depth) + "assign " + to + " = " + projection + tail, Projection, "the projection of " + to + " names every attribute it copies (" + projection + ")");
            else if (CopyOf(what) is { } c && Spread(to, c, row.Source) is { } assignments) CopyNodes(row, depth, assignments, tail);
        }

        // The nodes of a copy, as the record lowering writes them: `assign X = S` where the copy was (its label and id), then one
        // assign of the fields it changes; a copy of X into itself is that assign alone.
        private void CopyNodes(Row row, int depth, List<(string Target, string Value)> assignments, string tail)
        {
            var target = Root(assignments[0].Target);
            var fields = assignments[0].Target.Contains('.') ? assignments : assignments.Skip(1).ToList();
            var place = rows.IndexOf(row) + 1;
            if (fields.Count == assignments.Count) Set(row, Indent(depth) + "assign" + tail, Copy, "the copy into " + target + " changes its fields in one assign");
            else {
                Set(row, Indent(depth) + "assign " + assignments[0].Target + " = " + assignments[0].Value + tail, Copy,
                    "the copy into " + target + " is its source first (" + assignments[0].Target + " = " + assignments[0].Value + "), then an assign of the fields it changes");
                if (fields.Count == 0) return;
                handled.Add(Added(place++, Indent(depth) + "assign", row.Source, Copy, "the fields the copy into " + target + " changes, one assign"));
            }
            foreach (var (t, v) in fields) handled.Add(Added(place++, Indent(depth + 1) + t + " = " + v, row.Source, Copy, "an assignment of the copy into " + target + " (" + t + " = " + v + ")"));
        }

        // `{ ...Source, F: v, ... }`: the source and the fields, null when the value is no copy.
        private static (string Source, List<(string Field, string Value)> Fields)? CopyOf(string value)
        {
            value = value.Trim();
            if (value.Length < 6 || value[0] != '{' || value[^1] != '}') return null;
            var inner = value[1..^1].Trim();
            if (!inner.StartsWith("...", StringComparison.Ordinal)) return null;
            if (Parts(inner) is not { Count: > 0 } parts) return null;
            var source = parts[0][3..].Trim();
            var fields = new List<(string, string)>();
            foreach (var part in parts.Skip(1)) {
                var field = Regex.Match(part, @"^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*(\S.*)$", RegexOptions.Singleline);
                if (!field.Success) return (source, [("", part)]);
                fields.Add((field.Groups[1].Value, field.Groups[2].Value.Trim()));
            }
            return (source, fields);
        }

        // The assignments of a copy: the target from its source, then each field. Null (a problem) when a field is no name,
        // twice, or reads the target as it was (the copy reads the record before it, the assignments one after another).
        private List<(string Target, string Value)>? Spread(string target, (string Source, List<(string Field, string Value)> Fields) copy, int source)
        {
            if (!Regex.IsMatch(copy.Source, @"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])*$")) {
                Problem(source, Copy, "a copy is `{ ...Record, Field: value }`, its source a record (a name or a member of one): " + copy.Source); return null;
            }
            if (copy.Fields.Any(f => f.Field.Length == 0)) { Problem(source, Copy, "each field of a copy is `Field: value`: " + copy.Fields.First(f => f.Field.Length == 0).Value); return null; }
            var twice = copy.Fields.GroupBy(f => f.Field, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
            if (twice != null) { Problem(source, Copy, "the field " + twice.Key + " is written twice in the copy"); return null; }
            var root = Root(target);
            var same = string.Equals(copy.Source, target, StringComparison.OrdinalIgnoreCase);
            foreach (var (field, value) in copy.Fields) {
                var reads = Words(value).Any(w => w.Equals(root, StringComparison.OrdinalIgnoreCase));
                if (reads && !same) { Problem(source, Copy, "the value of " + field + " reads " + root + ", which the copy is writing: give the value from " + copy.Source + " or another name"); return null; }
                if (reads && copy.Fields.Any(f => !ReferenceEquals(f.Field, field) && value.Contains(target + "." + f.Field, StringComparison.OrdinalIgnoreCase))) {
                    Problem(source, Copy, "the value of " + field + " reads a field the same copy changes: the assignments run one after another"); return null;
                }
            }
            if (symbols.TryGetValue(root, out var declared) && declared.Role != "let" && target == root && TypeOf(copy.Source, out _) is { } from && !SameType(from, declared.Type)) {
                Problem(source, Copy, "the copy into " + target + ": " + declared.Type + " reads " + copy.Source + ": " + from + "; a copy keeps the type of its source"); return null;
            }
            var list = new List<(string, string)>();
            if (!same) list.Add((target, copy.Source));
            list.AddRange(copy.Fields.Select(f => (target + "." + f.Field, f.Value)));
            if (list.Count == 0) { Problem(source, Copy, "a copy of " + target + " into itself changes no field"); return null; }
            return list;
        }

        private static string Root(string path) { var end = 0; while (end < path.Length && (char.IsLetterOrDigit(path[end]) || path[end] == '_')) end++; return path[..end]; }

        private string? TargetType(string target)
        {
            if (!symbols.TryGetValue(Root(target), out var symbol)) return null;
            return target.Length == symbol.Name.Length ? symbol.Type : Member(symbol.Type, target[Root(target).Length..], out _);
        }

        // `S mapTo { *, F: v }`: the attributes of the target's record each S's item has by name (relative to the item, as a
        // mapping's values are), F as written; the attributes the item does not have are left out (said in the message). The
        // value itself when it is no projection, null (a problem) when the schema does not say what to name.
        private string? Projected(string value, string? targetType, int source)
        {
            if (!value.Contains("mapTo { *", StringComparison.Ordinal)) return value;
            if (FlowMapping.Split(value.Replace("{ *, ", "{ Star__: x, ").Replace("{ * }", "{ Star__: x }")) is not { } mapping) {
                Problem(source, Projection, "a projection is `Source mapTo { *, Field: value }`: " + value); return null;
            }
            var overrides = mapping.Fields.Where(f => f.Field != "Star__").ToList();
            var record = targetType == null ? null : Item(targetType);
            if (record == null) { Problem(source, Projection, "the type of the target of `" + value + "` is not certain here: write its fields"); return null; }
            if (schema?.Attributes(record) is not { Count: > 0 } attributes) {
                Problem(source, Projection, "the attributes of " + record + " are not known here (they are not in this text): write `" + mapping.Source + " mapTo { Field: value, ... }`"); return null;
            }
            foreach (var (field, _) in overrides)
                if (!attributes.Any(a => a.Name.Equals(field, StringComparison.OrdinalIgnoreCase))) { Problem(source, Projection, field + " is no attribute of " + record); return null; }
            // A mapping converts between two record types (O11 keeps no conversion of a type into itself).
            if (TypeOf(mapping.Source, out _) is { } sourceType && Item(sourceType) is { } same && same.Equals(record, StringComparison.OrdinalIgnoreCase)) {
                Problem(source, Projection, "the items of " + mapping.Source + " are already " + record + ": a projection maps them into another record type; assign the list and change its items");
                return null;
            }
            var items = ItemFields(mapping.Source);
            if (items == null) { Problem(source, Projection, "the items of " + mapping.Source + " are not known here: write its fields"); return null; }
            var fields = new List<(string Field, string Value)>();
            var missing = new List<string>();
            foreach (var (name, _) in attributes) {
                var given = overrides.FirstOrDefault(o => o.Field.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (given.Field != null) { fields.Add((name, given.Value)); continue; }
                var found = items.Where(i => i.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
                if (found.Count > 1) { Problem(source, Projection, "the attribute " + name + " of " + record + " is in " + found.Count + " records of the items of " + mapping.Source + " (" + string.Join(", ", found.Select(f => f.Value)) + "): write `" + name + ": <value>`"); return null; }
                if (found.Count == 1) fields.Add((name, found[0].Value)); else missing.Add(name);
            }
            if (fields.Count == 0) { Problem(source, Projection, "no attribute of " + record + " is in the items of " + mapping.Source); return null; }
            return FlowMapping.Compose(mapping.Source, fields) ?? value;
        }

        // The record a list or record type holds: `X List` and `X` are X (a primitive has none).
        private static string? Item(string type)
        {
            var item = type.EndsWith(" List", StringComparison.Ordinal) ? type[..^5] : type;
            return Primitive(item) || item.EndsWith(" Identifier", StringComparison.Ordinal) || item.Contains(' ') ? null : item;
        }

        // The fields of the items of a source of a mapping, with the value each one is relative to the item: a list of records
        // (X), the list of an aggregate (Entity.X of each source) or of a sql node (Structure.X).
        private List<(string Name, string Value)>? ItemFields(string source)
        {
            var parts = source.Split('.');
            if (nodes.TryGetValue(parts[0], out var node) && parts.Length == 2 && parts[1] == "List") {
                var records = node.Kind == "aggregate" ? node.Sources : node.Kind == "sql" ? [node.Detail] : null;
                if (records == null) return null;
                var fields = new List<(string, string)>();
                foreach (var record in records) {
                    if (schema?.Attributes(record) is not { } attributes) return null;
                    fields.AddRange(attributes.Select(a => (a.Name, record + "." + a.Name)));
                }
                return fields;
            }
            var type = TypeOf(source, out _);
            if (type == null || Item(type) is not { } item || schema?.Attributes(item) is not { } own) return null;
            return own.Select(a => (a.Name, a.Name)).ToList();
        }

        // ---- FLOW_GENERAL_REQUIRE ----------------------------------------------------------------------------------------

        private void RequireLine(int i, HashSet<string> outputs)
        {
            var row = rows[i];
            var (head, tail) = Split(row.Content);
            // `else -> @id`: the id is the jump's, not the line's.
            if (head.EndsWith(" else ->", StringComparison.Ordinal) && tail.StartsWith(" @", StringComparison.Ordinal)) { head += tail; tail = ""; }
            var body = head["require ".Length..];
            var at = FlowSyntax.Scan(body, 0, [" else "]);
            if (at <= 0 || at >= body.Length) { Problem(row.Source, Require, "write `require <condition> else raise Exception(\"message\")` (or else return, end, -> @id)"); return; }
            var condition = body[..at].Trim();
            var otherwise = body[(at + " else ".Length)..].Trim();
            var depth = row.Depth;
            List<string>? branch = null;
            if (otherwise.StartsWith("raise ", StringComparison.Ordinal) && Regex.IsMatch(otherwise, @"^raise [A-Za-z_][A-Za-z0-9_.]*\(.*\)$")) branch = [otherwise];
            else if (otherwise == "end" || Regex.IsMatch(otherwise, @"^-> @\S+$")) branch = [otherwise];
            else if (otherwise == "return" || otherwise.StartsWith("return ", StringComparison.Ordinal)) branch = Returned(otherwise, outputs, row.Source, depth + 1);
            // `else Exc("message")`: the else of a guard ends its branch, so an exception named with its message is raised.
            else if (Regex.IsMatch(otherwise, @"^[A-Za-z_][A-Za-z0-9_.]*\(.*\)$")) branch = ["raise " + otherwise];
            else { Problem(row.Source, Require, "the else of a require is raise Exception(\"message\"), return, end or -> @id: " + otherwise); return; }
            if (branch == null) return;
            Set(row, Indent(depth) + "if not (" + condition + "):" + tail, Require, "the require is an if on its condition's opposite, the else in its true branch");
            var place = i + 1;
            foreach (var line in branch) Added(place++, Indent(depth + 1) + line, row.Source, Require, "the else of the require of line " + row.Source + " (" + line.Trim() + ")");
        }

        // ---- FLOW_GENERAL_RETURN -----------------------------------------------------------------------------------------

        private void ReturnLine(int i, HashSet<string> outputs, int depth)
        {
            var row = rows[i];
            var (head, tail) = Split(row.Content);
            if (Returned(head, outputs, row.Source, depth) is not { } lines) return;
            if (lines.Count == 1) { Set(row, Indent(depth) + "end" + tail, Return, "return is the end of the flow"); return; }
            // The assign takes the label and the id (a jump to the return goes to its assign); the end follows.
            Set(row, Indent(depth) + lines[0] + tail, Return, "the return assigns its outputs, then ends");
            var place = i + 1;
            foreach (var line in lines.Skip(1)) Added(place++, Indent(depth) + line, row.Source, Return, "the return of line " + row.Source + " (" + line.Trim() + ")");
        }

        // The lines of a return at the depth given (relative to it): its assignments, then end. Null (a problem) when a target is
        // no output of the action or the values do not split.
        private List<string>? Returned(string text, HashSet<string> outputs, int source, int depth)
        {
            if (text == "return") return ["end"];
            var values = Parts(text["return ".Length..]);
            if (values == null) { Problem(source, Return, "the values of a return are `Output = value, ...`: " + text); return null; }
            var assignments = new List<(string Target, string Value)>();
            foreach (var value in values) {
                var match = Regex.Match(value, @"^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*=(?!=)\s*(\S.*)$", RegexOptions.Singleline);
                if (!match.Success) { Problem(source, Return, "each value of a return is `Output = value`: " + value); return null; }
                var root = Root(match.Groups[1].Value);
                if (!outputs.Contains(root)) { Problem(source, Return, root + " is no output of the action (" + (outputs.Count == 0 ? "it has none" : string.Join(", ", outputs)) + "): a return assigns outputs"); return null; }
                if (assignments.Any(a => a.Target.Equals(match.Groups[1].Value, StringComparison.OrdinalIgnoreCase))) { Problem(source, Return, match.Groups[1].Value + " is returned twice"); return null; }
                assignments.Add((match.Groups[1].Value, match.Groups[2].Value.Trim()));
            }
            if (assignments.Count == 1) return ["assign " + assignments[0].Target + " = " + assignments[0].Value, "end"];
            return ["assign", .. assignments.Select(a => "  " + a.Target + " = " + a.Value), "end"];
        }

        // ---- FLOW_GENERAL_SQL_BIND ---------------------------------------------------------------------------------------

        private static readonly Regex BindLine = new(@"^bind ([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([^=]+?))?(?:\s*=\s*(\S.*?))?$", RegexOptions.CultureInvariant);

        // A `bind P[: T][ = value]` under the node is `in P: T = value` (the type the value has with certainty when it is not
        // written; the value P itself when none is); a `@P` the code reads with no `in P` is the variable of that name, or the
        // op's `binding P: T = value` (both: refused, two readings).
        private void SqlNode(int i, int end)
        {
            var row = rows[i];
            var depth = row.Depth;
            var bound = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var code = new List<int>();
            var binds = new List<int>();
            for (var j = i + 1; j < end && (rows[j].Blank || rows[j].Depth > depth); j++) {
                if (rows[j].Blank) continue;
                var content = rows[j].Content;
                if (rows[j].Depth == depth + 1 && Declaration(content) is { Role: "in" } p) bound.Add(p.Name);
                if (rows[j].Depth == depth + 1 && content.StartsWith("bind ", StringComparison.Ordinal)) binds.Add(j);
                if (content == "|" || content.StartsWith("| ", StringComparison.Ordinal)) code.Add(j);
            }
            if (code.Count == 0) return;
            var sql = string.Join("\n", code.Select(j => rows[j].Content.Length > 2 ? rows[j].Content[2..] : ""));
            var read = SqlParameters(sql).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            foreach (var j in binds) {
                var (head, tail) = Split(rows[j].Content);
                handled.Add(rows[j]);
                if (BindLine.Match(head) is not { Success: true } bind) { Problem(rows[j].Source, SqlBind, "write `bind Name[: Type] = value` under the sql node"); continue; }
                var name = bind.Groups[1].Value;
                var value = bind.Groups[3].Success ? bind.Groups[3].Value.Trim() : name;
                if (bound.Contains(name)) { Problem(rows[j].Source, SqlBind, "@" + name + " is bound twice under the sql node"); continue; }
                if (!read.Contains(name, StringComparer.OrdinalIgnoreCase)) { Problem(rows[j].Source, SqlBind, "the sql reads no @" + name + ": the bind has nothing to bind"); continue; }
                var type = bind.Groups[2].Success ? bind.Groups[2].Value.Trim() : TypeOf(value, out _);
                if (type == null || type.EndsWith(" List", StringComparison.Ordinal)) { Problem(rows[j].Source, SqlBind, "the type of @" + name + " is not certain from `" + value + "`: write `bind " + name + ": <Type> = " + value + "`"); continue; }
                Set(rows[j], Indent(depth + 1) + "in " + name + ": " + type + " = " + value + tail, SqlBind, "the bind of @" + name + " is the parameter of the sql (in " + name + ": " + type + " = " + value + ")");
                bound.Add(name);
            }
            var added = new List<string>();
            foreach (var name in read.Where(p => !bound.Contains(p))) {
                var found = symbols.Values.Where(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
                var shared = op.Bindings.TryGetValue(name, out var binding);
                if (shared && found.Count > 0) { Problem(row.Source, SqlBind, "@" + name + " of the sql is both the binding " + name + " of the op and the " + found[0].Role + " " + found[0].Name + ": write `bind " + name + " = <value>` under the node"); continue; }
                if (shared) { added.Add(Indent(depth + 1) + "in " + name + ": " + binding.Type + " = " + binding.Value); continue; }
                if (found.Count == 0) { Problem(row.Source, SqlBind, "@" + name + " of the sql has no input, output or local of that name: write `in " + name + ": <Type> = <value>` under the node"); continue; }
                var symbol = found[0];
                if (symbol.Type.Length == 0 || symbol.Type.EndsWith(" List", StringComparison.Ordinal) || Item(symbol.Type) != null && !symbol.Type.EndsWith(" Identifier", StringComparison.Ordinal) && !Primitive(symbol.Type)) {
                    Problem(row.Source, SqlBind, "@" + name + " of the sql is the " + symbol.Role + " " + symbol.Name + ": " + symbol.Type + ", which is no scalar: write `in " + name + ": <Type> = <value>` under the node");
                    continue;
                }
                added.Add(Indent(depth + 1) + "in " + name + ": " + Bare(symbol.Type) + " = " + symbol.Name);
            }
            var place = code[0];
            foreach (var line in added) Added(place++, line, row.Source, SqlBind, "@" + line.Trim()[3..line.Trim().IndexOf(':')] + " of the sql is " + line.Trim()[(line.Trim().IndexOf(" = ", StringComparison.Ordinal) + 3)..] + " (" + line.Trim() + ")");
        }

        // The @Names a statement reads, outside its 'texts', [names], {names} and comments (@@ROWCOUNT and the like are no
        // parameter).
        private static IEnumerable<string> SqlParameters(string sql)
        {
            for (var i = 0; i < sql.Length; i++) {
                var c = sql[i];
                if (c == '\'') { i++; while (i < sql.Length && !(sql[i] == '\'' && !(i + 1 < sql.Length && sql[i + 1] == '\''))) i += sql[i] == '\'' ? 2 : 1; continue; }
                if (c is '[' or '{') { var close = sql.IndexOf(c == '[' ? ']' : '}', i + 1); if (close < 0) yield break; i = close; continue; }
                if (c == '-' && i + 1 < sql.Length && sql[i + 1] == '-') { var line = sql.IndexOf('\n', i); if (line < 0) yield break; i = line; continue; }
                if (c == '/' && i + 1 < sql.Length && sql[i + 1] == '*') { var close = sql.IndexOf("*/", i + 2, StringComparison.Ordinal); if (close < 0) yield break; i = close + 1; continue; }
                if (c != '@') continue;
                if (i + 1 < sql.Length && sql[i + 1] == '@') { i++; while (i + 1 < sql.Length && (char.IsLetterOrDigit(sql[i + 1]) || sql[i + 1] == '_')) i++; continue; }
                var start = i + 1;
                var end = start;
                while (end < sql.Length && (char.IsLetterOrDigit(sql[end]) || sql[end] == '_')) end++;
                if (end > start && (char.IsLetter(sql[start]) || sql[start] == '_')) yield return sql[start..end];
                i = end - 1;
            }
        }

        // ---- FLOW_GENERAL_JOIN: the steps after a switch -----------------------------------------------------------------

        private void Switches(int start, int end)
        {
            if (!structured) return;
            for (var i = end - 1; i > start; i--) {
                var row = rows[i];
                if (row.Blank || !Split(row.Content).Head.StartsWith("switch:", StringComparison.Ordinal)) continue;
                var depth = row.Depth;
                var after = i + 1;
                while (after < rows.Count && (rows[after].Blank || rows[after].Depth > depth)) after++;
                if (after >= rows.Count || rows[after].Depth != depth || rows[after].Spaces == 0) continue;
                var tail = after;
                while (tail < rows.Count && (rows[tail].Blank || rows[tail].Depth >= depth) && !(rows[tail].Depth == depth && (rows[tail].Content.StartsWith("on exception ", StringComparison.Ordinal) || rows[tail].Content == "unreached:")))
                    tail++;
                while (tail > after && rows[tail - 1].Blank) tail--;
                // The cases of the switch, each with the end of its block; the open ones (no terminator) go on to the remainder.
                var cases = new List<(int Head, int End)>();
                for (var j = i + 1; j < after; j++)
                    if (!rows[j].Blank && rows[j].Depth == depth + 1) {
                        var k = j + 1;
                        while (k < after && (rows[k].Blank || rows[k].Depth > depth + 1)) k++;
                        cases.Add((j, k));
                        j = k - 1;
                    }
                var open = cases.Where(c => Open(c.Head, c.End, depth + 2)).ToList();
                if (open.Count == 0) { Problem(rows[after].Source, Join, "every case of the switch of line " + row.Source + " ends: nothing reaches this step"); return; }
                var remainder = rows.GetRange(after, tail - after);
                var first = remainder.First(r => !r.Blank);
                var (firstHead, firstTail) = Split(first.Content);
                string id;
                if (FlowSyntax.SplitKey(first.Content, out _, out var written)) id = written;
                else {
                    do id = "j" + ++joins; while (ids.Contains(id));
                    ids.Add(id);
                }
                _ = firstHead; _ = firstTail;
                rows.RemoveRange(after, tail - after);
                // The other open cases jump to the remainder, written in the first open one (moved: new lines of the text).
                foreach (var (head, caseEnd) in open.Skip(1).Reverse())
                    Added(caseEnd, Indent(depth + 2) + "-> @" + id, row.Source, Join, "the case of line " + rows[head].Source + " goes on after the switch of line " + row.Source + " (-> @" + id + ")");
                var at = open[0].End;
                var moved = remainder.Select(r => {
                    var text = r.Blank ? "" : "    " + r.Text;
                    if (ReferenceEquals(r, first) && !FlowSyntax.SplitKey(r.Content, out _, out _)) text += " @" + id;
                    return new Row(text, -1, r.Source) { Rule = Join, Message = Say(r.Source, "the step after the switch of line " + row.Source + " is written in its first open case") };
                }).ToList();
                rows.InsertRange(at, moved);
            }
        }

        // Whether a block of steps at this depth ends without a terminator (end, raise, navigate, next, a jump).
        private bool Open(int head, int end, int depth)
        {
            var last = Enumerable.Range(head + 1, Math.Max(0, end - head - 1)).LastOrDefault(j => !rows[j].Blank && rows[j].Depth == depth, -1);
            if (last < 0) return true;
            var content = Split(rows[last].Content).Head;
            return !(content == "end" || content == "next" || content.StartsWith("-> ", StringComparison.Ordinal) || content.StartsWith("raise ", StringComparison.Ordinal)
                || content.StartsWith("navigate ", StringComparison.Ordinal) || content == "return" || content.StartsWith("return ", StringComparison.Ordinal)
                || content.StartsWith("switch:", StringComparison.Ordinal));
        }

        // ---- the types of expressions ------------------------------------------------------------------------------------

        private string? TypeOf(string expression, out string? why)
        {
            why = null;
            var reader = new Types(this, expression);
            var type = reader.Read(out why);
            return type;
        }

        // The type of a member path of a value of this type (".Current.X", "[i].Y", ".X"); null when not certain.
        private string? Member(string type, string path, out string? why)
        {
            why = null;
            var at = 0;
            while (at < path.Length) {
                if (path[at] == '[') {
                    var close = FlowSyntax.Scan(path, at + 1, ["]"]);
                    if (close < 0 || close >= path.Length) { why = "an index that does not close"; return null; }
                    if (!type.EndsWith(" List", StringComparison.Ordinal)) { why = type + " is no list"; return null; }
                    type = type[..^5]; at = close + 1; continue;
                }
                if (path[at] != '.') { why = "an expression after " + type; return null; }
                var start = ++at;
                while (at < path.Length && (char.IsLetterOrDigit(path[at]) || path[at] == '_')) at++;
                var name = path[start..at];
                if (type.EndsWith(" List", StringComparison.Ordinal)) {
                    switch (name) {
                        case "Current": type = type[..^5]; continue;
                        case "Length": case "CurrentRowNumber": type = "Integer"; continue;
                        case "Empty": type = "Boolean"; continue;
                        default: why = name + " is no member of a list"; return null;
                    }
                }
                if (Primitive(type) || type.EndsWith(" Identifier", StringComparison.Ordinal)) { why = type + " has no member " + name; return null; }
                if (schema?.Attributes(type) is not { } attributes) { why = "the attributes of " + type + " are not in this text"; return null; }
                var attribute = attributes.FirstOrDefault(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (attribute.Name == null) { why = name + " is no attribute of " + type; return null; }
                type = attribute.Type;
            }
            return type;
        }

        // A name path of an expression: a declared name, a node's output, a static entity record.
        private string? PathType(string path, out string? why)
        {
            why = null;
            var root = Root(path);
            var rest = path[root.Length..];
            if (root == "Entities" && Regex.Match(rest, @"^\.([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$") is { Success: true } entity) return entity.Groups[1].Value + " Identifier";
            if (symbols.TryGetValue(root, out var symbol)) {
                if (symbol.Type.Length == 0) { why = root + " has no type in this text"; return null; }
                return rest.Length == 0 ? Bare(symbol.Type) : Member(Bare(symbol.Type), rest, out why);
            }
            if (nodes.TryGetValue(root, out var node)) {
                var member = Regex.Match(rest, @"^\.([A-Za-z_][A-Za-z0-9_]*)(.*)$");
                if (!member.Success) { why = root + " is a node"; return null; }
                var output = member.Groups[1].Value;
                var more = member.Groups[2].Value;
                if (node.Kind is "aggregate" or "sql") {
                    if (output != "List") { why = output + " of " + root + " is not certain (write its type)"; return null; }
                    var list = Regex.Match(more, @"^\.(Length|Empty|CurrentRowNumber)$");
                    if (list.Success) return list.Groups[1].Value == "Empty" ? "Boolean" : "Integer";
                    var row = Regex.Match(more, @"^(?:\.Current|\[[^\]]+\])\.([A-Za-z_][A-Za-z0-9_]*)(.*)$");
                    if (!row.Success) { why = "the rows of " + root + " have no type of their own: name one of its records"; return null; }
                    var records = node.Kind == "aggregate" ? node.Sources : [node.Detail];
                    var record = records.FirstOrDefault(r => r.Equals(row.Groups[1].Value, StringComparison.OrdinalIgnoreCase));
                    if (record == null) { why = row.Groups[1].Value + " is no record of " + root; return null; }
                    return row.Groups[2].Value.Length == 0 ? record : Member(record, row.Groups[2].Value, out why);
                }
                var outputs = schema?.Outputs(node.Detail) ?? (shared?.Signatures.TryGetValue(node.Detail, out var signature) == true ? signature!.Outputs : null);
                if (outputs == null) { why = "the outputs of " + node.Detail + " are not in this text"; return null; }
                var found = outputs.FirstOrDefault(o => o.Name.Equals(output, StringComparison.OrdinalIgnoreCase));
                if (found.Name == null) { why = output + " is no output of " + node.Detail; return null; }
                return more.Length == 0 ? Bare(found.Type) : Member(Bare(found.Type), more, out why);
            }
            why = root + " is not declared in this text";
            return null;
        }

        private static string Bare(string type) => Regex.Replace(type, @"\(\d+(?:,\d+)?\)$", "").Trim();

        // A reader of OutSystems expressions that says the type of one when it is certain: literals, declared names and their
        // members, the operators, If() and the built-in functions of fixed type.
        private sealed class Types(Expander owner, string text)
        {
            private int at;
            private string? why;

            public string? Read(out string? reason)
            {
                string? type;
                try { type = Or(); Space(); if (at != text.Length) { why ??= "an expression this reader does not follow"; type = null; } }
                catch (FormatException) { type = null; why ??= "an expression this reader does not follow"; }
                reason = type == null ? why : null;
                return type;
            }

            private void Space() { while (at < text.Length && text[at] == ' ') at++; }
            private bool Word(string word)
            {
                Space();
                if (string.CompareOrdinal(text, at, word, 0, word.Length) != 0) return false;
                var after = at + word.Length;
                if (after < text.Length && (char.IsLetterOrDigit(text[after]) || text[after] == '_')) return false;
                at = after; return true;
            }
            private bool Symbol(string symbol) { Space(); if (string.CompareOrdinal(text, at, symbol, 0, symbol.Length) != 0) return false; at += symbol.Length; return true; }

            private string? Or()
            {
                var left = And();
                while (Word("or")) { And(); left = "Boolean"; }
                return left;
            }
            private string? And()
            {
                var left = Not();
                while (Word("and")) { Not(); left = "Boolean"; }
                return left;
            }
            private string? Not()
            {
                if (Word("not")) { Not(); return "Boolean"; }
                return Compare();
            }
            private string? Compare()
            {
                var left = Add();
                foreach (var op in new[] { "<>", "<=", ">=", "=", "<", ">" })
                    if (Symbol(op)) { Add(); return "Boolean"; }
                return left;
            }
            private string? Add()
            {
                var left = Multiply();
                while (true) {
                    Space();
                    if (Symbol("+")) { var right = Multiply(); left = left == "Text" || right == "Text" ? (left != null && right != null ? "Text" : Fail("a text joined to a value of unknown type")) : Numeric(left, right); continue; }
                    if (at < text.Length && text[at] == '-' ) { at++; var right = Multiply(); left = Numeric(left, right); continue; }
                    return left;
                }
            }
            private string? Multiply()
            {
                var left = Unary();
                while (true) {
                    if (Symbol("*")) { left = Numeric(left, Unary()); continue; }
                    if (Symbol("/")) { var right = Unary(); left = Number(left) && Number(right) && left != "Currency" && right != "Currency" ? "Decimal" : Fail("a division of values of unknown type"); continue; }
                    return left;
                }
            }
            private string? Unary()
            {
                if (Symbol("-")) { var type = Unary(); return Number(type) ? type : Fail("a negative of a value of unknown type"); }
                return Primary();
            }

            private string? Fail(string reason) { why ??= reason; return null; }
            private static bool Number(string? type) => type is "Integer" or "Long Integer" or "Decimal" or "Currency";
            private string? Numeric(string? left, string? right)
            {
                if (!Number(left) || !Number(right)) return Fail("arithmetic on a value of unknown type");
                if (left == right) return left;
                if (left == "Currency" || right == "Currency") return Fail("Currency with another number");
                if (left == "Decimal" || right == "Decimal") return "Decimal";
                return "Long Integer";
            }

            private string? Primary()
            {
                Space();
                if (at >= text.Length) throw new FormatException();
                var c = text[at];
                if (c == '(') { at++; var type = Or(); if (!Symbol(")")) throw new FormatException(); return type; }
                if (c == '"') {
                    at++;
                    while (at < text.Length && !(text[at] == '"' && !(at + 1 < text.Length && text[at + 1] == '"'))) at += text[at] == '"' ? 2 : 1;
                    if (at >= text.Length) throw new FormatException();
                    at++; return "Text";
                }
                if (c == '#') {
                    var close = text.IndexOf('#', at + 1);
                    if (close < 0) throw new FormatException();
                    var literal = text[(at + 1)..close].Trim();
                    at = close + 1;
                    var date = Regex.IsMatch(literal, @"^\d{4}-\d{2}-\d{2}"); var time = Regex.IsMatch(literal, @"\d{1,2}:\d{2}(:\d{2})?$");
                    return date && time ? "Date Time" : date ? "Date" : time ? "Time" : Fail("a # literal of no type");
                }
                if (char.IsDigit(c)) {
                    var start = at;
                    while (at < text.Length && char.IsDigit(text[at])) at++;
                    if (at < text.Length && text[at] == '.' && at + 1 < text.Length && char.IsDigit(text[at + 1])) { at++; while (at < text.Length && char.IsDigit(text[at])) at++; return "Decimal"; }
                    return text[start..at].Length > 9 ? "Long Integer" : "Integer";
                }
                if (char.IsLetter(c) || c == '_') {
                    var start = at;
                    while (at < text.Length && (char.IsLetterOrDigit(text[at]) || text[at] == '_')) at++;
                    var name = text[start..at];
                    if (name is "True" or "False") return "Boolean";
                    Space();
                    if (at < text.Length && text[at] == '(') return Function(name);
                    // A path: members and indexes.
                    var end = at;
                    while (end < text.Length) {
                        if (text[end] == '.' && end + 1 < text.Length && (char.IsLetter(text[end + 1]) || text[end + 1] == '_')) {
                            end++; while (end < text.Length && (char.IsLetterOrDigit(text[end]) || text[end] == '_')) end++; continue;
                        }
                        if (text[end] == '[') { var close = FlowSyntax.Scan(text, end + 1, ["]"]); if (close < 0 || close >= text.Length) throw new FormatException(); end = close + 1; continue; }
                        break;
                    }
                    var path = text[start..end].Replace(" ", "");
                    at = end;
                    var type = owner.PathType(path, out var reason);
                    if (type == null) why ??= reason;
                    return type;
                }
                throw new FormatException();
            }

            // The functions of fixed type, the same on both lanes; If() is its branches' type when they agree.
            private static readonly Dictionary<string, string> Fixed = new(StringComparer.Ordinal) {
                ["Trim"] = "Text", ["TrimStart"] = "Text", ["TrimEnd"] = "Text", ["ToUpper"] = "Text", ["ToLower"] = "Text", ["Substr"] = "Text",
                ["Replace"] = "Text", ["Chr"] = "Text", ["NewLine"] = "Text", ["IntegerToText"] = "Text", ["LongIntegerToText"] = "Text",
                ["DecimalToText"] = "Text", ["BooleanToText"] = "Text", ["DateToText"] = "Text", ["DateTimeToText"] = "Text", ["TimeToText"] = "Text",
                ["FormatDecimal"] = "Text", ["FormatText"] = "Text", ["FormatCurrency"] = "Text", ["FormatPercent"] = "Text", ["EncodeHtml"] = "Text",
                ["EncodeJavaScript"] = "Text", ["EncodeSql"] = "Text", ["EncodeUrl"] = "Text", ["IdentifierToText"] = "Text",
                ["Length"] = "Integer", ["Index"] = "Integer", ["DiffDays"] = "Integer", ["DiffHours"] = "Integer", ["DiffMinutes"] = "Integer",
                ["DiffSeconds"] = "Integer", ["Year"] = "Integer", ["Month"] = "Integer", ["Day"] = "Integer", ["Hour"] = "Integer", ["Minute"] = "Integer",
                ["Second"] = "Integer", ["DayOfWeek"] = "Integer", ["TextToInteger"] = "Integer", ["DecimalToInteger"] = "Integer", ["BooleanToInteger"] = "Integer",
                ["LongIntegerToInteger"] = "Integer", ["TextToLongInteger"] = "Long Integer", ["IntegerToLongInteger"] = "Long Integer",
                ["TextToDecimal"] = "Decimal", ["IntegerToDecimal"] = "Decimal", ["LongIntegerToDecimal"] = "Decimal", ["Power"] = "Decimal", ["Sqrt"] = "Decimal",
                ["Round"] = "Decimal", ["Trunc"] = "Decimal", ["DecimalToBoolean"] = "Boolean", ["IntegerToBoolean"] = "Boolean", ["TextToBoolean"] = "Boolean",
                ["CurrDate"] = "Date", ["NewDate"] = "Date", ["DateTimeToDate"] = "Date", ["TextToDate"] = "Date", ["NullDate"] = "Date",
                ["CurrTime"] = "Time", ["NewTime"] = "Time", ["DateTimeToTime"] = "Time", ["TextToTime"] = "Time",
                ["CurrDateTime"] = "Date Time", ["NewDateTime"] = "Date Time", ["TextToDateTime"] = "Date Time", ["DateToDateTime"] = "Date Time",
                ["BuildDateTime"] = "Date Time", ["GetUserId"] = "User Identifier",
            };

            private string? Function(string name)
            {
                at++;
                var arguments = new List<string?>();
                Space();
                if (!Symbol(")")) {
                    do arguments.Add(Or()); while (Symbol(","));
                    if (!Symbol(")")) throw new FormatException();
                }
                if (Fixed.TryGetValue(name, out var type)) return type;
                switch (name) {
                    case "If" when arguments.Count == 3:
                        if (arguments[1] != null && arguments[1] == arguments[2]) return arguments[1];
                        if (Number(arguments[1]) && Number(arguments[2])) return Numeric(arguments[1], arguments[2]);
                        return Fail("the branches of If have different types");
                    case "Abs" or "Max" or "Min" when arguments.Count >= 1:
                        return arguments.Skip(1).Aggregate(arguments[0], (a, b) => Number(a) && Number(b) ? Numeric(a, b) : null) is { } numeric && Number(numeric) ? numeric : Fail(name + " of values of unknown type");
                    case "AddDays" or "AddHours" or "AddMinutes" or "AddSeconds" or "AddMonths" or "AddYears" when arguments.Count == 2:
                        return arguments[0] == "Date Time" ? "Date Time" : Fail(name + " of a value that is no Date Time");
                }
                return Fail(name + "() is no function of fixed type");
            }
        }
    }

    private static readonly HashSet<string> Primitives = new(StringComparer.Ordinal) {
        "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency", "Email", "Phone Number", "Binary Data", "Object" };
    private static bool Primitive(string type) => Primitives.Contains(Regex.Replace(type, @"\(\d+(?:,\d+)?\)$", "").Trim());
    private static bool SameType(string a, string b) => string.Equals(Regex.Replace(a, @"\(\d+(?:,\d+)?\)$", "").Trim(), Regex.Replace(b, @"\(\d+(?:,\d+)?\)$", "").Trim(), StringComparison.OrdinalIgnoreCase);
}
