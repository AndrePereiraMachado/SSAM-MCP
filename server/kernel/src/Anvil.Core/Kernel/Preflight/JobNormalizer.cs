using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>
/// Deterministic shape normalizations (lentidao 2026-10-12, causes 2 and 3 of the owner's production test): what a job writes
/// in a shape the engine can only read one way is rewritten in place, before the checks, and listed in the answer
/// (<c>normalizations</c>: [{rule, path, from, to, message}]) instead of refused. Nothing ambiguous is rewritten: that stays a
/// refusal with its fix.
/// <list type="bullet">
/// <item>SORT_KEYS_SPLIT: a `get` sort written as one comma-separated text (`"A, B DESC"`) is the list of sort keys in order
/// (`["A", "B DESC"]`, the form LogicExpander.SortKeys reads); every tie-break key is kept. An empty key or a key whose syntax
/// does not hold leaves the text as written (EXPRESSION_SYNTAX).</item>
/// <item>LIST_ENTITY_SEGMENT_DROPPED: `V.Current.T.X` and `V[i].T.X` on a `T List` input, output or variable (or a `T List`
/// output of a call) read `V.Current.X` and `V[i].X`: a list of T records has the attributes directly. Only when the patch is
/// certain: T's attributes are known, X is one of them and T is not. A list of aggregate rows (`Agg.List`) is never touched.</item>
/// <item>NULL_FUNCTION_REWRITTEN (needs the base, which says the name is no function of the module): `NullDateTime()` and
/// `NullTime()`, which O11 does not have, are the null of the type they are assigned to, passed to or compared with:
/// `NullDate()` for a Date, `DateToDateTime(NullDate())` for a Date Time, `NewTime(0, 0, 0)` for a Time (the null Time of
/// the built-in catalog). `NullTime()` whose target type is unknown is `NewTime(0, 0, 0)` (the one null Time); `NullDateTime()`
/// whose target type is unknown, or a target of another type, stays FUNCTION_UNKNOWN.</item>
/// <item>PROPERTY_SET_DROPPED: a `set` of a documentation property (<see cref="Droppable"/>) the type has no way to write
/// (IUserException.Description) is dropped with a warning (PropertyRules, the base check and the apply), never refused.</item>
/// </list>
/// </summary>
public static class JobNormalizer
{
    public const string SortKeysSplit = "SORT_KEYS_SPLIT";
    public const string ListEntitySegment = "LIST_ENTITY_SEGMENT_DROPPED";
    public const string NullFunction = "NULL_FUNCTION_REWRITTEN";
    public const string PropertyDropped = "PROPERTY_SET_DROPPED";

    /// <summary>The properties whose `set` changes nothing the module runs: a type that cannot write one drops the set with a
    /// warning. Any other property the type cannot write stays PROPERTY_NOT_WRITABLE (dropping it could change behavior).</summary>
    private static readonly HashSet<string> Documentation = new(StringComparer.Ordinal) { "Description" };

    public static bool Droppable(string prop) => Documentation.Contains(prop);

    /// <summary>One entry of the answer's <c>normalizations</c>.</summary>
    public static JsonObject Entry(string rule, string? path, string? from, string? to, string message)
        => new() { ["rule"] = rule, ["path"] = path, ["from"] = from, ["to"] = to, ["message"] = message };

    /// <summary>The entry of a documentation property dropped by the preflight, the base check or the apply.</summary>
    public static JsonObject Dropped(string? path, string shownType, string prop, string target)
        => Entry(PropertyDropped, path, $"set {prop} on {target}", null,
            $"{shownType} has no way to write {prop} (a documentation property): the set is dropped, nothing else of the job changes");

    /// <summary>What the job alone decides: the sorts and the entity segment where the job declares the record; motor2: the
    /// property aliases, the html of the op (icons, weights, list aliases, titles, defaults) and the scope renames; VisitaCerta:
    /// the certain edits of the ssam-flow/1 texts of the logic ops (Anvil.Reading.FlowTextNormalizer).</summary>
    public static List<JsonObject> Pure(JsonArray ops, string? prefix, string lane)
    {
        var done = new List<JsonObject>();
        Motor2(ops, prefix, lane, null, done);
        try
        {
            Sorts(ops, prefix, done);
            Expressions(ops, prefix, lane, null, done);
        }
        catch { /* a normalization never refuses: the checks judge what stays */ }
        // VisitaCerta (tx-visitacerta): the certain edits of the ssam-flow/1 texts of the logic ops (FlowTextNormalizer).
        try { FlowTexts(ops, prefix, done); }
        catch { /* a normalization never refuses: the checks judge what stays */ }
        // motor2 review: each path is one of the job as sent (a step the kernel inserted shifts nothing the author wrote).
        SentJob.TranslateEntries(done, ops, prefix);
        return done;
    }

    // ---- the ssam-flow/1 texts (FlowTextNormalizer) -----------------------------------------------------------------------

    // Every text of the text form of a logic op (data.flow: one text, a list of texts or of {text, basedOn}) with its certain
    // edits, each listed with the line it changed (from: the line before, to: what it reads now; an inserted line has from
    // "before line N").
    private static void FlowTexts(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data || !data.ContainsKey("flow")) continue;
            var at = prefix == null ? null : $"{prefix}/{i}/data/flow";
            switch (data["flow"])
            {
                case JsonValue single when single.TryGetValue<string>(out var text):
                    if (One(text, at, done) is { } written) data["flow"] = written;
                    break;
                case JsonArray list:
                    for (var j = 0; j < list.Count; j++)
                    {
                        if (list[j] is JsonValue item && item.TryGetValue<string>(out var itemText))
                        {
                            if (One(itemText, at == null ? null : at + "/" + j, done) is { } itemWritten) list[j] = itemWritten;
                        }
                        else if (list[j] is JsonObject entry && entry["text"] is JsonValue inner && inner.TryGetValue<string>(out var entryText))
                        {
                            if (One(entryText, at == null ? null : at + "/" + j + "/text", done) is { } entryWritten) entry["text"] = entryWritten;
                        }
                    }
                    break;
            }
        }

        static string? One(string text, string? path, List<JsonObject> done)
        {
            var normalized = Anvil.Reading.FlowTextNormalizer.Normalize(text);
            if (normalized.Edits.Count == 0 || normalized.Text == text) return null;
            foreach (var edit in normalized.Edits)
            {
                var entry = Entry(edit.Rule, path, edit.Insert ? "before line " + edit.Line : "line " + edit.Line + ": " + (edit.From ?? ""), edit.To, edit.Message);
                entry["line"] = edit.Line;
                done.Add(entry);
            }
            return normalized.Text;
        }
    }

    /// <summary>The same again with the base (attributes of module records, callees of the module) plus the null functions.</summary>
    public static List<JsonObject> WithBase(JsonArray ops, string? prefix, string lane, IBaseFacts model)
    {
        var done = new List<JsonObject>();
        Motor2(ops, prefix, lane, model, done);
        try
        {
            Sorts(ops, prefix, done);
            Expressions(ops, prefix, lane, model, done);
        }
        catch { /* a normalization never refuses: the checks judge what stays */ }
        SentJob.TranslateEntries(done, ops, prefix);
        return done;
    }

    /// <summary>motor2 (2026-10-12): the normalizations of the classes found only at apply, each on its own (one that fails
    /// leaves the others): PROPERTY_ALIASED, the html rules (HtmlDocumentRules: ICON_NAME_NORMALIZED, ICON_WEIGHT_DROPPED,
    /// LIST_ALIAS_REWRITTEN, SCREEN_TITLE_QUOTED, DEFAULT_MOVED_TO_INITIALIZE, DEFAULT_MOVED_TO_ASSIGN), PARAMETER_RENAMED
    /// (with the base, the screens the module already has too), ARGUMENT_RENAMED (the list actions of the O11 System) and
    /// TEXT_LITERAL_QUOTED (a static or default text that is no expression).
    /// Idempotent: a second pass finds nothing to do.</summary>
    private static void Motor2(JsonArray ops, string? prefix, string lane, IBaseFacts? model, List<JsonObject> done)
    {
        // Familias (2026-10-12): the lines of the text forms the grammar rejects with one reading (DDL_DECLARATION_NORMALIZED,
        // FLOW_END_AFTER_TERMINATOR, FLOW_ASSIGN_WRITTEN), then the literal-only slots written as a constant (LITERAL_FOLDED,
        // before the defaults motor2 moves), and the CSS the theme does not render with one rendering (CSS_FUNCTION_REWRITTEN).
        try { TextForms.Normalize(ops, prefix, lane, done); } catch { }
        try { LiteralFolding.Normalize(ops, prefix, lane, done); } catch { }
        try { StyleSheetNormalizer.Normalize(ops, prefix, done); } catch { }
        try { SharedStyleNormalizer.Normalize(ops, prefix, done); } catch { }
        try { PropertyAliases.Normalize(ops, prefix, lane, done); } catch { }
        try { HtmlDocumentRules.Normalize(ops, prefix, lane, done); } catch { }
        try { ScopeRenames.Normalize(ops, prefix, lane, model == null ? null : model.ScreenNames, done); } catch { }
        try { SystemCalls.Normalize(ops, prefix, lane, model, done); } catch { }
        try { SpecTexts.Normalize(ops, prefix, done); } catch { }
    }

    /// <summary>Adds the entries of <paramref name="more"/> that <paramref name="into"/> does not have yet (same rule and path).</summary>
    public static void Merge(JsonArray into, IEnumerable<JsonNode?> more)
    {
        foreach (var entry in more.OfType<JsonObject>())
            if (!into.OfType<JsonObject>().Any(e => Same(e, entry))) into.Add(entry.DeepClone());
    }

    /// <summary>The same normalization seen twice (the preflight and the apply): same rule and text, at the same place or one
    /// inside the other (the apply knows only the op of a set a logic or spec op expands into).</summary>
    public static bool Same(JsonObject a, JsonObject b)
    {
        if (a["rule"]?.ToString() != b["rule"]?.ToString() || a["from"]?.ToString() != b["from"]?.ToString()) return false;
        // Identical statements on different lines are separate normalizations, not duplicate reports of one rewrite.
        if (a["line"] != null && b["line"] != null && !JsonNode.DeepEquals(a["line"], b["line"])) return false;
        var p = a["path"]?.ToString(); var q = b["path"]?.ToString();
        return p == q || p != null && q != null && (p.StartsWith(q + "/", StringComparison.Ordinal) || q.StartsWith(p + "/", StringComparison.Ordinal));
    }

    // ---- SORT_KEYS_SPLIT --------------------------------------------------------------------------------------------------

    private static readonly Regex Direction = new(@"^\s*[-+]?\s*|\s+(?:asc|desc|ascending|descending)\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly HashSet<string> DirectionWords = new(StringComparer.OrdinalIgnoreCase) { "asc", "desc", "ascending", "descending" };

    private static void Sorts(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"]?["actions"] is not JsonArray actions) continue;
            for (var a = 0; a < actions.Count; a++)
            {
                if (actions[a] is not JsonObject action) continue;
                LogicScan scan;
                try { scan = LogicScan.Of(action); } catch { continue; }
                foreach (var (step, at) in scan.Steps)
                {
                    if (step["get"] is not JsonValue || step["sql"] is JsonValue sql && sql.TryGetValue<bool>(out var isSql) && isSql) continue;
                    var path = prefix == null ? null : $"{prefix}/{i}/data/actions/{a}{at}/sort";
                    switch (step["sort"])
                    {
                        case JsonValue v when v.TryGetValue<string>(out var text) && SplitKeys(text) is { } keys:
                            var list = new JsonArray(keys.Select(k => (JsonNode)k).ToArray());
                            step["sort"] = list;
                            SentJob.Replaced(list);
                            done.Add(Entry(SortKeysSplit, path, text, list.ToJsonString(),
                                $"comma-separated sort = {keys.Count} keys in order, tie-breaks kept"));
                            break;
                        case JsonArray items when items.Any(n => n is JsonValue iv && iv.TryGetValue<string>(out var t) && SplitKeys(t) != null):
                            var before = items.ToJsonString();
                            var flat = new JsonArray();
                            foreach (var item in items)
                                if (item is JsonValue iv && iv.TryGetValue<string>(out var t) && SplitKeys(t) is { } parts) foreach (var part in parts) flat.Add(part);
                                else flat.Add(item?.DeepClone());
                            step["sort"] = flat;
                            SentJob.Replaced(flat);
                            done.Add(Entry(SortKeysSplit, path, before, flat.ToJsonString(),
                                "comma-separated sort key = several keys in order, tie-breaks kept"));
                            break;
                    }
                }
            }
        }
    }

    /// <summary>The keys of a sort text with commas outside parentheses and texts, or null when it has none, or when a key is
    /// empty or not an attribute expression (then the text is ambiguous and stays: EXPRESSION_SYNTAX says why).</summary>
    internal static List<string>? SplitKeys(string text)
    {
        var tokens = ExpressionText.Tokens(text);
        var cuts = new List<int>();
        var depth = 0;
        foreach (var t in tokens)
        {
            if (t.Kind is TokenKind.Open or TokenKind.OpenIndex) depth++;
            else if (t.Kind is TokenKind.Close or TokenKind.CloseIndex) depth--;
            else if (t.Kind == TokenKind.Comma && depth == 0) cuts.Add(t.Start);
        }
        if (cuts.Count == 0 || depth != 0) return null;
        var keys = new List<string>();
        var from = 0;
        foreach (var cut in cuts.Append(text.Length))
        {
            var key = text[from..cut].Trim();
            from = cut + 1;
            if (key.Length == 0) return null;
            if (DirectionWords.Contains(key))
            {
                // A bare direction applies to the key before it (SortKeys); before any key it means nothing.
                if (keys.Count == 0) return null;
                keys.Add(key);
                continue;
            }
            var attribute = Direction.Replace(key, "");
            if (attribute.Length == 0 || ExpressionSyntax.Check(attribute) != null) return null;
            keys.Add(key);
        }
        return keys;
    }

    // ---- expressions: LIST_ENTITY_SEGMENT_DROPPED and NULL_FUNCTION_REWRITTEN ------------------------------------------------

    private static readonly Regex SortPointer = new(@"/sort(?:/\d+(?:/by)?)?$", RegexOptions.Compiled);

    private static void Expressions(JsonArray ops, string? prefix, string lane, IBaseFacts? model, List<JsonObject> done)
    {
        var job = JobFacts.From(ops);
        var builtins = Builtins.For(lane);
        // A reference op of the job may import a function of that name: its producer is not the base, nothing is decided.
        var imported = new HashSet<string>(ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "reference")
            .SelectMany(o => o["elements"] as JsonArray ?? new JsonArray()).Select(e => e?.ToString() ?? "").Select(e => e[(e.IndexOf(':') + 1)..]), StringComparer.OrdinalIgnoreCase);
        foreach (var action in job.Actions)
        {
            LogicScan scan;
            try { scan = LogicScan.Of(action.Declaration); } catch { continue; }
            var locals = action.Locals.GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Type ?? "", StringComparer.OrdinalIgnoreCase);
            var scope = new Scope(action, scan, locals, job, model);
            foreach (var site in scan.Expressions)
            {
                // A sort key carries its direction beside the attribute: never rewritten here.
                if (site.Key == "sort" && SortPointer.IsMatch(site.Pointer)) continue;
                var text = site.Text;
                var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}{site.Pointer}";
                var current = text;
                var steps = new List<(string Rule, string From, string To, string Message)>();
                if (DropEntitySegment(current, scope) is { } entity)
                {
                    steps.Add((ListEntitySegment, current, entity.Text, entity.Message));
                    current = entity.Text;
                }
                if (model != null && builtins != null && NullFunctions(current, site, scope, builtins, name => Unknown(name, builtins, job, model, imported)) is { } nulls)
                {
                    steps.Add((NullFunction, current, nulls.Text, nulls.Message));
                    current = nulls.Text;
                }
                if (current == text || !ExpressionRewrites.Write(action.Declaration, site.Pointer, text, current)) continue;
                // One entry per expression: what it was, what it is, every rule that changed it.
                done.Add(Entry(string.Join("+", steps.Select(s => s.Rule)), at, text, current, string.Join("; ", steps.Select(s => s.Message))));
            }
        }
    }

    /// <summary>A call no built-in of the lane, no function of the module or of its references and no name of the job answers.</summary>
    private static bool Unknown(string name, IReadOnlyDictionary<string, BuiltinFact> builtins, JobFacts job, IBaseFacts model, HashSet<string> imported)
        => !builtins.ContainsKey(name) && !model.IsFunction(name) && !job.Names.Contains(name) && !imported.Contains(name);

    /// <summary>What an action's expression can name, with the types the job and the base give.</summary>
    private sealed class Scope(ActionFact action, LogicScan scan, Dictionary<string, string> locals, JobFacts job, IBaseFacts? model)
    {
        public ActionFact Action => action;

        /// <summary>The `T List` type of a local (`V`) or of a call's output (`Call.Out`), or null.</summary>
        public string? ListTypeOf(string path)
        {
            var segments = path.Split('.');
            if (segments.Length == 1)
            {
                if (scan.Nodes.ContainsKey(segments[0]) || !locals.TryGetValue(segments[0], out var type)) return null;
                return ExpressionRewrites.ListElement(type) != null ? type : null;
            }
            if (segments.Length == 2 && Output(segments[0], segments[1]) is { } output) return ExpressionRewrites.ListElement(output) != null ? output : null;
            return null;
        }

        /// <summary>The declared type of output <paramref name="name"/> of the call node <paramref name="node"/>.</summary>
        public string? Output(string node, string name)
        {
            if (!scan.Nodes.TryGetValue(node, out var call) || call.Kind != "call" || call.Target is not { } target) return null;
            var outputs = job.Callee(target, action)?.Outputs ?? model?.Callee(target, action.Declaration)?.Outputs;
            return outputs?.FirstOrDefault(o => string.Equals(o.Name, name, StringComparison.OrdinalIgnoreCase))?.Type is { Length: > 0 } t ? t : null;
        }

        /// <summary>The inputs of a callee of the job or of the base.</summary>
        public IReadOnlyList<ParamFact>? Inputs(string target) => job.Callee(target, action)?.Inputs ?? model?.Callee(target, action.Declaration)?.Inputs;

        public IReadOnlyDictionary<string, string>? Attributes(string record) => ExpressionRules.Attributes(record, job, model);

        /// <summary>The type of a value path (`V`, `V.A`, `V.Current.A`, `Agg.List.Current.Src.A`, `Call.Out.A`, `Src.A` inside an
        /// aggregate), or null when any step of it is unknown.</summary>
        public string? TypeOf(string path, NodeFact? aggregate)
        {
            var segments = path.Split('.');
            string type; int i;
            if (locals.TryGetValue(segments[0], out var declared) && !scan.Nodes.ContainsKey(segments[0])) { type = declared; i = 1; }
            else if (aggregate != null && segments.Length == 2 && aggregate.Sources.Contains(segments[0], StringComparer.OrdinalIgnoreCase)) { type = segments[0]; i = 1; }
            else if (scan.Nodes.TryGetValue(segments[0], out var node))
            {
                if (node.Kind == "aggregate" && node.Columns.Count == 0 && segments.Length >= 5 && segments[1].Equals("List", StringComparison.OrdinalIgnoreCase)
                    && segments[2].Equals("Current", StringComparison.OrdinalIgnoreCase) && node.Sources.Contains(segments[3], StringComparer.OrdinalIgnoreCase)) { type = segments[3]; i = 4; }
                else if (node.Kind == "call" && segments.Length >= 2 && Output(segments[0], segments[1]) is { } output) { type = output; i = 2; }
                else return null;
            }
            else return null;
            for (; i < segments.Length; i++)
            {
                if (ExpressionRewrites.ListElement(type) is { } element)
                {
                    if (!segments[i].Equals("Current", StringComparison.OrdinalIgnoreCase)) return null;
                    type = element;
                    continue;
                }
                if (ExpressionRewrites.IsBasic(type) || type.Contains(' ') || Attributes(type) is not { } attributes
                    || !attributes.TryGetValue(segments[i], out var attributeType) || attributeType.Length == 0) return null;
                type = attributeType;
            }
            return Normal(type);
        }
    }

    private static string? Normal(string? type) => type?.Trim() switch
    {
        null or "" => null,
        "DateTime" => "Date Time",
        var t => t,
    };

    // ---- LIST_ENTITY_SEGMENT_DROPPED --------------------------------------------------------------------------------------

    private static (string Text, string Message)? DropEntitySegment(string text, Scope scope)
    {
        if (!text.Contains('.')) return null;
        var tokens = ExpressionText.Tokens(text);
        var edits = new List<(int Start, int Length, string Text)>();
        var explained = new List<string>();
        // The certain case of ExpressionRules.CurrentOfList: T's attributes are known, the segment is T and not an attribute,
        // and the next segment is an attribute of T.
        bool Certain(string listType, string segment, string next, out string element)
        {
            element = ExpressionRewrites.ListElement(listType) ?? "";
            if (element.Length == 0 || element.Contains(' ') || ExpressionRewrites.IsBasic(element) || !segment.Equals(element, StringComparison.OrdinalIgnoreCase)) return false;
            return scope.Attributes(element) is { Count: > 0 } attributes && !attributes.ContainsKey(segment) && attributes.ContainsKey(next);
        }
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (t.Kind != TokenKind.Name || t.Text.StartsWith('.') || ExpressionText.Continues(tokens, k)) continue;
            if (k + 1 < tokens.Count && tokens[k + 1].Kind == TokenKind.Open) continue;   // a call
            // V[i].T.X: the path after the index of a T List.
            if (k + 1 < tokens.Count && tokens[k + 1].Kind == TokenKind.OpenIndex)
            {
                var close = Close(tokens, k + 1);
                if (close < 0 || close + 1 >= tokens.Count || tokens[close + 1] is not { Kind: TokenKind.Name } after || !after.Text.StartsWith('.')) continue;
                var rest = after.Segments;
                if (rest.Length < 2 || scope.ListTypeOf(t.Text) is not { } indexed || !Certain(indexed, rest[0], rest[1], out var element)) continue;
                edits.Add((after.Start, after.Text.Length, "." + string.Join(".", rest.Skip(1))));
                explained.Add($"{t.Text} is a {element} List: {t.Text}[i] has its attributes directly");
                continue;
            }
            // V.Current.T.X and Call.Out.Current.T.X.
            var parts = t.Segments;
            for (var c = 1; c <= 2 && c + 2 < parts.Length; c++)
            {
                if (!parts[c].Equals("Current", StringComparison.OrdinalIgnoreCase)) continue;
                var head = string.Join(".", parts.Take(c));
                if (scope.ListTypeOf(head) is not { } listType || !Certain(listType, parts[c + 1], parts[c + 2], out var element)) continue;
                edits.Add((t.Start, t.Text.Length, string.Join(".", parts.Take(c + 1).Concat(parts.Skip(c + 2)))));
                explained.Add($"{head} is a {element} List: {head}.Current has its attributes directly");
                break;
            }
        }
        if (edits.Count == 0) return null;
        return (Apply(text, edits), string.Join("; ", explained.Distinct(StringComparer.Ordinal)));
    }

    // ---- NULL_FUNCTION_REWRITTEN ------------------------------------------------------------------------------------------

    private static readonly HashSet<string> NullNames = new(StringComparer.OrdinalIgnoreCase) { "NullDateTime", "NullTime" };
    private static readonly HashSet<string> Comparisons = new(StringComparer.Ordinal) { "=", "<>", "<", ">", "<=", ">=" };

    private static (string Text, string Message)? NullFunctions(string text, ExpressionSite site, Scope scope, IReadOnlyDictionary<string, BuiltinFact> builtins, Func<string, bool> unknown)
    {
        if (!text.Contains("Null", StringComparison.OrdinalIgnoreCase)) return null;
        var tokens = ExpressionText.Tokens(text);
        var edits = new List<(int Start, int Length, string Text)>();
        var explained = new List<string>();
        foreach (var call in ExpressionText.Calls(text, tokens))
        {
            if (!NullNames.Contains(call.Name) || call.Arguments.Count != 0 || !unknown(call.Name)) continue;
            var close = call.NameIndex + 2;
            if (close >= tokens.Count || tokens[close].Kind != TokenKind.Close) continue;
            var (type, against) = TargetType(tokens, call.NameIndex, close, site, scope);
            var written = NullOf(call.Name, type);
            if (written == null || !Available(written, builtins, site, scope)) continue;
            edits.Add((tokens[call.NameIndex].Start, tokens[close].Start + 1 - tokens[call.NameIndex].Start, written));
            explained.Add(type == null
                ? $"no {call.Name}() in this Studio: the null Time is {written}"
                : $"no {call.Name}() in this Studio: the null {type} ({against}) is {written}");
        }
        if (edits.Count == 0) return null;
        return (Apply(text, edits), string.Join("; ", explained.Distinct(StringComparer.Ordinal)));
    }

    /// <summary>The null of <paramref name="type"/> (null when the type has none here): Date, Date Time and Time. NullTime()
    /// without a known target type is the one null Time.</summary>
    internal static string? NullOf(string function, string? type) => type switch
    {
        "Date" => "NullDate()",
        "Date Time" => "DateToDateTime(NullDate())",
        "Time" => "NewTime(0, 0, 0)",
        null when function.Equals("NullTime", StringComparison.OrdinalIgnoreCase) => "NewTime(0, 0, 0)",
        _ => null,
    };

    private static readonly Regex Called = new(@"([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);

    /// <summary>Every function the written text calls is a built-in of the lane, and runs where the expression runs (an aggregate).</summary>
    private static bool Available(string written, IReadOnlyDictionary<string, BuiltinFact> builtins, ExpressionSite site, Scope scope)
    {
        foreach (Match m in Called.Matches(written))
        {
            if (!builtins.TryGetValue(m.Groups[1].Value, out var f)) return false;
            if (site.Aggregate != null && !(scope.Action.IsClientSide ? f.ClientAggregates : f.ServerAggregates)) return false;
        }
        return true;
    }

    /// <summary>The type the call at [name, close] gets its value for: the target of an assignment, the input of a call or the
    /// field of a record it is the whole value of, or the operand it is compared with (a plain path, alone on its side).</summary>
    private static (string? Type, string Against) TargetType(List<Token> tokens, int name, int close, ExpressionSite site, Scope scope)
    {
        if (name == 0 && close == tokens.Count - 1)
        {
            if (site.Step["assign"] is JsonObject && site.Pointer.Contains("/assign/", StringComparison.Ordinal))
                return (scope.TypeOf(site.Key, null), $"assigned to {site.Key}");
            if (site.Step["call"] is JsonValue call && call.TryGetValue<string>(out var target) && site.Pointer.Contains("/args/", StringComparison.Ordinal))
            {
                var input = scope.Inputs(target)?.FirstOrDefault(p => string.Equals(p.Name, site.Key, StringComparison.OrdinalIgnoreCase));
                return (Normal(input?.Type), $"input {site.Key} of {target}");
            }
            if (site.Pointer.Contains("/record/", StringComparison.Ordinal) && new[] { "save", "create", "update" }.FirstOrDefault(site.Step.ContainsKey) is { } verb
                && site.Step[verb]?.ToString() is { Length: > 0 } entity)
                return (scope.Attributes(entity)?.TryGetValue(site.Key, out var t) == true ? Normal(t) : null, $"attribute {entity}.{site.Key}");
            return (null, "");
        }
        // X <op> NullDateTime(): X alone on its side, the call alone on the other.
        if (name >= 2 && tokens[name - 1].Kind == TokenKind.Operator && Comparisons.Contains(tokens[name - 1].Text) && Operand(tokens, name - 2, left: true)
            && Bounded(tokens, close + 1, left: false))
            return (scope.TypeOf(tokens[name - 2].Text, site.Aggregate), $"compared with {tokens[name - 2].Text}");
        if (close + 2 < tokens.Count && tokens[close + 1].Kind == TokenKind.Operator && Comparisons.Contains(tokens[close + 1].Text) && Operand(tokens, close + 2, left: false)
            && Bounded(tokens, name - 1, left: true))
            return (scope.TypeOf(tokens[close + 2].Text, site.Aggregate), $"compared with {tokens[close + 2].Text}");
        return (null, "");
    }

    /// <summary>A plain path alone on its side of a comparison: a name (not a call, an index or a continuation) bounded by the
    /// start, a parenthesis, a comma or and/or/not.</summary>
    private static bool Operand(List<Token> tokens, int index, bool left)
    {
        var t = tokens[index];
        if (t.Kind != TokenKind.Name || t.Text.StartsWith('.') || ExpressionText.Continues(tokens, index)) return false;
        if (index + 1 < tokens.Count && tokens[index + 1].Kind is TokenKind.Open or TokenKind.OpenIndex) return false;
        return left ? Bounded(tokens, index - 1, left: true) : Bounded(tokens, index + 1, left: false);
    }

    private static bool Bounded(List<Token> tokens, int index, bool left)
    {
        if (index < 0 || index >= tokens.Count) return true;
        var t = tokens[index];
        if (t.Kind == TokenKind.Comma) return true;
        if (left ? t.Kind == TokenKind.Open : t.Kind == TokenKind.Close) return true;
        return t.Kind == TokenKind.Operator && (t.Is("and") || t.Is("or") || left && t.Is("not"));
    }

    // ---- text edits -------------------------------------------------------------------------------------------------------

    private static int Close(List<Token> tokens, int open)
    {
        var depth = 0;
        for (var k = open; k < tokens.Count; k++)
        {
            if (tokens[k].Kind is TokenKind.Open or TokenKind.OpenIndex) depth++;
            else if (tokens[k].Kind is TokenKind.Close or TokenKind.CloseIndex && --depth == 0) return k;
        }
        return -1;
    }

    private static string Apply(string text, List<(int Start, int Length, string Text)> edits)
    {
        foreach (var (start, length, written) in edits.OrderByDescending(e => e.Start))
            text = text[..start] + written + text[(start + length)..];
        return text;
    }
}
