using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// Spec declarativa de LOGICA -> ops de verbos (item 4). Esquema FECHADO: chave desconhecida, passo com duas formas, nome
/// repetido ou referencia a entidade/action/excecao inexistente falham na compilacao com a lista do que e permitido, antes de
/// tocar no modelo. E uma funcao pura do JSON: mesma spec, mesmos ops, sempre (teste SameSpecSameOps).
///
/// {"op":"logic","data":{"actions":[{
///   "name":"Ticket_Cancel", "kind":"server", "public":true, "description":"...",
///   "inputs":[{"name":"TicketId","type":"Ticket Identifier"},{"name":"Reason","type":"Text","mandatory":false}],
///   "outputs":[{"name":"Ok","type":"Boolean"}], "vars":[{"name":"T","type":"Ticket"}],
///   "steps":[
///     {"get":"Ticket","as":"GetTicket","where":"Ticket.Id = TicketId","max":1},
///     {"if":"GetTicket.List.Empty","then":[{"raise":"NotFound","message":"\"Ticket not found\""}]},
///     {"assign":{"T":"GetTicket.List.Current.Ticket","T.StatusId":"Entities.TicketStatus.Cancelled"}},
///     {"save":"Ticket","record":"T","as":"SaveTicket"},
///     {"call":"Event_Write","as":"Ev","args":{"TicketId":"TicketId","Note":"Reason"}},
///     {"foreach":"GetWatchers.List","as":"EachWatcher","do":[ ... ]},
///     {"assign":{"Ok":"True"}}]}]}}
///
/// Passos: get (aggregate: where, sort, max), assign, call (action propria, referenciada, de entidade ou de sistema; args),
/// save|create|update (record) e delete (id) de entidade, if (then/else, ramos voltam ao fluxo), foreach (do), raise.
/// Start, End, ligacoes e layout sao gerados. Um ramo que termina em raise nao volta.
/// </summary>
public static class LogicExpander
{
    private static readonly string[] RootKeys = ["actions"];
    private static readonly string[] SqlParamKeys = ["type", "value"];
    private static readonly string[] ActionKeys = ["name", "kind", "owner", "public", "description", "function", "replace", "inputs", "outputs", "vars", "steps", "handlers", "comments", "fetch", "timeout", "http", "path"];
    // `in` only on the parameters of a rest action (exposed REST method): url|header|body for inputs, body|header for outputs.
    private static readonly string[] ParamKeys = ["name", "type", "mandatory", "default", "description", "in"];
    private static readonly string[] StepKinds = ["get", "assign", "call", "save", "create", "update", "delete", "if", "foreach", "while", "break", "continue", "return", "raise", "switch", "node"];
    private static readonly Dictionary<string, string[]> StepKeys = new()
    {
        ["get"] = ["get", "as", "where", "sort", "max", "start", "sql", "statement", "params", "sources", "joins", "columns", "calculated"],
        ["assign"] = ["assign", "as"],
        ["call"] = ["call", "as", "args"],
        ["save"] = ["save", "as", "record"],
        ["create"] = ["create", "as", "record"],
        ["update"] = ["update", "as", "record"],
        ["delete"] = ["delete", "as", "id"],
        ["if"] = ["if", "as", "label", "then", "else"],
        ["foreach"] = ["foreach", "as", "do", "start", "max"],
        ["while"] = ["while", "as", "label", "do", "next"],
        ["break"] = ["break"],
        ["continue"] = ["continue"],
        ["return"] = ["return"],
        ["switch"] = ["switch", "as", "otherwise"],
        ["node"] = ["node", "as", "properties", "inputs", "outputs", "args"],
        ["raise"] = ["raise", "message"],
    };

    public static JsonObject Schema() => new()
    {
        ["op"] = "logic", ["data"] = System.Text.Json.JsonSerializer.SerializeToNode(RootKeys),
        ["action"] = System.Text.Json.JsonSerializer.SerializeToNode(ActionKeys),
        ["actionKinds"] = new JsonArray("server", "service", "client", "screen", "preparation", "data", "rest", "callback"),
        ["owners"] = new JsonObject { ["screen"] = new JsonArray("IMobileScreen", "IMobileBlock", "IWebScreen", "IWebBlock"), ["preparation"] = new JsonArray("IWebScreen", "IWebBlock", "IWebEmail"),
            ["rest"] = new JsonArray("IRestService"), ["callback"] = new JsonArray("IRestClient") },
        ["callback"] = "kind callback: the OnBeforeRequest or OnAfterResponse of a consumed REST client, owner IRestClient:<C>; no inputs/outputs (the platform's Request, CustomizedRequest; Request, Response, CustomizedResponse); vars and steps as any action (op rest-consume writes them for you).",
        ["rest"] = "kind rest: an exposed REST method of owner IRestService:<S>; http GET|POST|PUT|PATCH|DELETE, path /x/{Input}; parameter `in` url|header|body (inputs, default url) and body|header (outputs, default body); Start and End are the method's own (op rest-expose writes it for you).",
        ["parameter"] = System.Text.Json.JsonSerializer.SerializeToNode(ParamKeys),
        ["steps"] = System.Text.Json.JsonSerializer.SerializeToNode(StepKeys),
        ["kinds"] = System.Text.Json.JsonSerializer.SerializeToNode(StepKinds),
        ["nativeNodes"] = LogicNodes.Schema(),
        ["handler"] = new JsonArray("name", "exception", "abortTransaction", "logError", "steps"),
        ["comment"] = new JsonArray("text", "reminder"),
        ["switchCase"] = new JsonArray("when", "steps"),
        ["queryJoin"] = new JsonArray("left", "right", "kind", "condition"),
        ["queryColumn"] = new JsonArray("name", "attribute", "kind"),
        ["queryCalculated"] = new JsonArray("name", "value"),
        ["sqlParameter"] = System.Text.Json.JsonSerializer.SerializeToNode(SqlParamKeys),
        ["rules"] = "One step kind per step; closed keys; label on any step; record: var or {Field: expr}; expressions are OutSystems text.",
        // The text form (Verbs.Flow.cs, docs/TEXTO-LOGICA.md): instead of data.actions.
        ["flow"] = "data.flow: the text of one action as ssam_map view \"flow\" reads it (ssam-flow/1), edited; or a list of texts or {text, basedOn}. "
            + "data.basedOn: the textSha of the read, needed with a header @key (changed since: merged three ways). A line keeps the element of its @id; a line without @id is new; "
            + "a removed line is a removed element; a parameter or local renamed with its id is renamed (its expressions rewritten). A header without @key "
            + "creates the action: server, service or client action Name; action Owner.Name (screen or block action) and data action Owner.Name name their "
            + "screen or block (a screen an html op of the same job creates: put the logic op after it). Only what changed is written (set, create, link, delete, rename, move); the action is read again "
            + "and must be the text (FLOW_NOT_EXACT otherwise). Refused at once: FLOW_KEY_FOREIGN, FLOW_KEY_ROLE, FLOW_KEY_TWICE, FLOW_JUMP_UNKNOWN, FLOW_SELF_LOOP, "
            + "FLOW_BRANCHES_MEET, FLOW_OPAQUE_TOUCHED, FLOW_FOREACH_LIST_ACTION (T1/T2, with the List action as patch), FLOW_NODE_NAME_TAKEN, FLOW_BASE_CHANGED, "
            + "FLOW_ACTION_NAME_TAKEN (a text without @key named after an action the module has: its current text is the patch); one refusal carries "
            + "every problem of every text. Call=Client|Server only for the kind of call the flow does not pick by default. A record mapping is part of "
            + "the value, in both lanes: Source mapTo { Field: value } (FLOW_MAPPING_TYPES when the two types take none)."
    };

    /// <summary>tryRef recebe candidatos ("IServerEntity:X", "IEntitySignature:X", ...) e devolve o primeiro que resolve no modulo,
    /// ou null. Sem tryRef (testes offline) usa-se o primeiro candidato.</summary>
    public static List<JsonObject> Expand(JsonObject data, Func<string[], string?>? tryRef = null)
        => ExpandCore(data, tryRef, checkUsage: true);

    internal static List<JsonObject> Expand(JsonObject data, Func<string[], string?>? tryRef,
        Func<LogicCallCandidate, JsonObject, LogicCallTarget?> tryCall)
        => ExpandCore(data, tryRef, checkUsage: true, tryCall);

    internal static List<JsonObject> ExpandScreenQuery(JsonObject declaration, string owner, Func<string[], string?> resolver)
    {
        var query = ScreenSpecification.Query(declaration); var ops = new List<JsonObject>();
        var compiler = new ActionCompiler(ops, new JsonObject { ["name"] = "ScreenQuery" }, "ScreenQuery", "$ScreenQuery", "", [], null, resolver);
        compiler.Get(query, "screen query");
        ops[0]["parent"] = owner; ops[0]["type"] = "IScreenAggregate";
        ops[0]["args"] = new JsonObject { ["isClientSide"] = declaration["client"]?.DeepClone() ?? JsonValue.Create(false) };
        return ops;
    }

    // So os testes de paridade podem produzir o caso negativo para consultar o juiz Verify; nao e opcao de job/CLI.
    internal static List<JsonObject> ExpandForVerification(JsonObject data, Func<string[], string?>? tryRef = null)
        => ExpandCore(data, tryRef, checkUsage: false);

    internal sealed record ConstructionBarrier(int Ordinal, string Reason);
    internal sealed record ConstructionBatch(bool ExpressionPhase, int[] OriginalOrdinals);
    internal sealed record ConstructionPlan(List<JsonObject> Operations, HashSet<int> BodyExpressionOrdinals, List<ConstructionBarrier> Barriers)
    {
        public IEnumerable<ConstructionBatch> Batches()
        {
            var cuts = Barriers.Select(b => b.Ordinal).Append(0).Append(Operations.Count).Distinct().Order().ToArray();
            for (var j = 1; j < cuts.Length; j++)
            {
                var range = Enumerable.Range(cuts[j - 1], cuts[j] - cuts[j - 1]);
                foreach (var expressionPhase in new[] { false, true })
                {
                    var ordinals = range.Where(i => BodyExpressionOrdinals.Contains(i) == expressionPhase).ToArray();
                    if (ordinals.Length != 0) yield return new(expressionPhase, ordinals);
                }
            }
        }
    }

    internal static ConstructionPlan ExpandConstruction(JsonObject data, Func<string[], string?>? tryRef,
        Func<LogicCallCandidate, JsonObject, LogicCallTarget?> tryCall)
    {
        var body = new HashSet<int>();
        var barriers = new List<ConstructionBarrier>();
        return new(ExpandCore(data, tryRef, true, tryCall, body, barriers), body, barriers);
    }

    internal static ConstructionPlan PlanConstructionForVerification(JsonObject data)
    {
        var body = new HashSet<int>();
        var barriers = new List<ConstructionBarrier>();
        return new(ExpandCore(data, null, true, null, body, barriers), body, barriers);
    }

    /// <summary>What the compiler did that the author did not write, with a pointer relative to the logic op's data: a node
    /// named as the Studio names a copy (LOGIC_NODE_RENAMED), a type the platform spells otherwise (LOGIC_TYPE_MAPPED), a
    /// record path rewritten to the one the list really has (LOGIC_CURRENT_REWRITTEN). LogicLint returns them as warnings.</summary>
    internal sealed record LogicNote(string Pointer, string Code, string Message, string? Fix = null);

    /// <summary>The notes of a logic op's data, compiled offline (no module). Never throws: the grammar errors are the
    /// preflight's.</summary>
    internal static List<LogicNote> Notes(JsonObject data)
    {
        var notes = new List<LogicNote>();
        try { ExpandCore(data, null, checkUsage: false, notes: notes); }
        catch (Exception) { /* the problems are reported by the preflight itself */ }
        return notes;
    }

    private sealed record LogicProblem(string Pointer, string Code, Exception Error, string? Fix = null);

    /// <summary>A refusal that knows the key of the step it is about, so the problem points at the field to change. A field
    /// given as path segments (columns, 0, attribute) points inside the step; Code and Fix, when given, are the problem's.</summary>
    private sealed class FieldException(string message, string field, string? code = null, string? fix = null, params string[] more) : InvalidOperationException(message)
    {
        public string Field { get; } = field;
        public string? Code { get; } = code;
        public string? Fix { get; } = fix;
        private readonly string[] _more = more;
        /// <summary>The pointer of the field relative to the step: each segment escaped.</summary>
        public string Suffix => "/" + string.Join("/", new[] { Field }.Concat(_more).Select(Escape));
    }

    private static string Escape(string key) => key.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    /// <summary>The problem of an exception at <paramref name="at"/>: the field it names, its code and its fix.</summary>
    private static LogicProblem ProblemAt(Exception ex, string at, bool coded = false) => ex is FieldException f
        ? new(at + f.Suffix, f.Code ?? "LOGIC_INVALID", ex, f.Fix)
        : new(at, coded && ex is ICodedError c ? c.Code : "LOGIC_INVALID", ex);

    /// <summary>Every problem of the spec at once (I4): one problem keeps the exception the caller always got (same type and
    /// text), carrying the coded problem inside for the preflight; several are one KernelRefusalException LOGIC_INVALID.</summary>
    private static Exception Refusal(List<LogicProblem> problems)
    {
        var coded = problems.Select(p => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, p.Pointer, p.Code, "error",
            p.Error.Message, p.Fix))).ToArray();
        if (problems.Count == 1)
        {
            var original = problems[0].Error;
            if (original is ICodedError) return original;
            var inner = new KernelRefusalException(problems[0].Code, original.Message, new JsonArray(coded));
            return original switch
            {
                FieldException => new InvalidOperationException(original.Message, inner),
                _ when original.GetType() == typeof(InvalidOperationException) => new InvalidOperationException(original.Message, inner),
                _ when original.GetType() == typeof(ArgumentException) => new ArgumentException(original.Message, inner),
                _ => original,
            };
        }
        return new KernelRefusalException("LOGIC_INVALID", $"logic: {problems.Count} problems, all reported at once: "
            + string.Join(" | ", problems.Select((p, i) => $"({i + 1}) {p.Error.Message}")), new JsonArray(coded));
    }

    private static List<JsonObject> ExpandCore(JsonObject data, Func<string[], string?>? tryRef, bool checkUsage, Func<LogicCallCandidate, JsonObject, LogicCallTarget?>? tryCall = null, HashSet<int>? body = null, List<ConstructionBarrier>? barriers = null,
        List<LogicNote>? notes = null)
    {
        var problems = new List<LogicProblem>();
        try { Keys(data, RootKeys, "data"); }
        catch (Exception ex) { problems.Add(ProblemAt(ex, "")); }
        if (data["actions"] is not JsonArray)
        {
            problems.Add(new("/actions", "LOGIC_INVALID", new InvalidOperationException("logic: 'actions' e obrigatorio"), "{\"actions\":[{\"name\":\"...\",\"steps\":[...]}]}"));
            throw Refusal(problems);
        }
        var normalized = Normalize(data, notes);
        var actions = normalized["actions"]!.AsArray();
        for (var i = 0; i < actions.Count; i++)
            if (actions[i] is not JsonObject)
                problems.Add(new("/actions/" + i, "LOGIC_INVALID", new InvalidOperationException($"logic: action #{i + 1} is not an object {{\"name\":..., \"steps\":[...]}}")));
        var declared = LogicOrder.Index(actions);
        var pointers = new Dictionary<JsonObject, string>(ReferenceEqualityComparer.Instance);
        var aliases = new Dictionary<JsonObject, string>(ReferenceEqualityComparer.Instance);
        var aliasNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < actions.Count; i++)
        {
            if (actions[i] is not JsonObject action) continue;
            pointers[action] = "/actions/" + i;
            var key = LogicOrder.Key(action, i);
            if (!ReferenceEquals(declared[key], action))
            {
                problems.Add(new("/actions/" + i, "LOGIC_DUPLICATE_ACTION", new InvalidOperationException($"logic: action '{LogicOrder.NameOf(action)}' is declared more than once with the same owner"),
                    $"keep one declaration of '{LogicOrder.NameOf(action)}' in this op"));
                continue;
            }
            // The same name on another owner is another action (I5); its handle gets the owner so the two never collide.
            var name = LogicOrder.NameOf(action) ?? "#" + i;
            var alias = "$" + name;
            for (var n = 1; !aliasNames.Add(alias); n++)
                alias = "$" + name + "~" + LogicOrder.SafeOwner(action).Split(':')[^1] + (n > 1 ? n.ToString(System.Globalization.CultureInfo.InvariantCulture) : "");
            aliases[action] = alias;
        }
        string? ResolveReference(string[] candidates)
        {
            foreach (var candidate in candidates)
            {
                var action = LogicOrder.DeclaredTarget(candidate, declared);
                if (action != null) return LogicOrder.DeclaredCall(action).Reference;
            }
            return tryRef != null ? tryRef(candidates) : candidates.FirstOrDefault();
        }
        LogicCallTarget? ResolveCall(LogicCallCandidate[] candidates, JsonObject caller)
        {
            foreach (var candidate in candidates)
            {
                var action = LogicOrder.DeclaredTarget(candidate.Reference, declared);
                if (action != null) return LogicOrder.DeclaredCall(action);
                // Interleave declared and existing candidates in the same order. An existing local
                // action must not lose to a later module declaration merely because it was not edited.
                if (tryCall != null && tryCall(candidate, caller) is { } existing) return existing;
            }
            if (tryCall != null) return null;
            var references = candidates.Select(candidate => candidate.Reference).ToArray();
            // A string-only resolver cannot establish the native kind/owner of an arbitrary path.
            // Offline expansion remains a syntax check; live expansion supplies the native resolver.
            var reference = tryRef != null ? tryRef(references) : references.FirstOrDefault(c => !c.Contains('/')) ?? references.FirstOrDefault();
            if (reference == null) return null;
            if (tryRef != null && !new[] { "IServerAction:", "IServerActionSignature:", "IServiceAction:", "IServiceActionSignature:",
                    "IClientAction:", "IClientActionSignature:", "IEntityActionSignature:", "IExtensionActionSignature:" }
                .Any(prefix => reference.StartsWith(prefix, StringComparison.Ordinal)))
                throw new InvalidOperationException("logic: call '" + reference + "' requires native action metadata to prove its kind and owner");
            var kind = reference.StartsWith("IClientAction", StringComparison.Ordinal) ? "IClientAction" : "IServerAction";
            return new(reference, kind);
        }
        // Native binding determines the dependency too: a retained local Foo may shadow a
        // newly declared module Foo, so raw name sorting would invent a cycle or the wrong edge.
        var groups = tryCall == null ? LogicOrder.Groups(actions) : LogicOrder.Groups(actions, (caller, target) =>
        {
            var binding = ResolveCall(LogicOrder.CallCandidates(target, caller), caller);
            return binding == null ? null : LogicOrder.DeclaredTarget(binding.Reference, declared);
        });
        var ops = new List<JsonObject>();
        foreach (var group in groups)
        {
            // Every input/output is materialized before a recursive call sets its Action and
            // creates native arguments. Singleton DAG components retain their original ops.
            var compilers = new List<(ActionCompiler Compiler, JsonObject Action)>();
            foreach (var action in group)
            {
                var at = pointers[action];
                try
                {
                    var compiler = new ActionCompiler(ops, action, Req(action, "name", "action"), aliases[action], at, problems, notes,
                        ResolveReference, ResolveCall, body, barriers);
                    compiler.Declare();
                    compilers.Add((compiler, action));
                }
                catch (Exception ex) { problems.Add(ProblemAt(ex, at)); }
            }
            foreach (var (compiler, action) in compilers)
            {
                var at = pointers[action];
                try { compiler.CompileBody(); }
                catch (Exception ex) { problems.Add(ProblemAt(ex, at)); }
                barriers?.Add(new(ops.Count, "action"));
                // C18 (atritos 3): an input or var never used and an output never assigned are the Verify's warnings (A03,
                // nonblocking), never a refusal of the kernel; the preflight returns them as a note (LogicLint warning).
                if (notes == null) continue;
                try
                {
                    var usage = LogicUsage.Analyze(action);
                    if (usage.HasUnused) notes.Add(new(at, "LOGIC_UNUSED", LogicUsage.Describe(action, usage) + " The Verify warns about them; the job is not refused.",
                        "use each declared input and var in an expression and assign each output, or remove them"));
                }
                catch (Exception) { /* a step the compiler refuses is reported by its own problem */ }
            }
        }
        if (problems.Count > 0) throw Refusal(problems.OrderBy(p => p.Pointer, PointerOrder.Instance).ToList());
        return ops;
    }

    /// <summary>Problems in document order: /actions/2/steps/10 after /actions/2/steps/9.</summary>
    private sealed class PointerOrder : IComparer<string>
    {
        public static readonly PointerOrder Instance = new();
        public int Compare(string? x, string? y)
        {
            var a = (x ?? "").Split('/'); var b = (y ?? "").Split('/');
            for (var i = 0; i < Math.Min(a.Length, b.Length); i++)
            {
                var c = int.TryParse(a[i], out var m) && int.TryParse(b[i], out var n) ? m.CompareTo(n) : string.CompareOrdinal(a[i], b[i]);
                if (c != 0) return c;
            }
            return a.Length.CompareTo(b.Length);
        }
    }

    // ---- normalization: what the platform writes otherwise, mapped before compiling (A07 of the atritos 2 package) -----

    private static readonly Regex LongText = new(@"^\s*long\s*text(\s+list)?\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex ListType = new(@"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+list\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex StringLiteral = new("\"(?:[^\"]|\"\")*\"", RegexOptions.CultureInvariant);
    private static readonly string[] ExpressionKeys = ["where", "max", "start", "record", "id", "if", "while", "foreach", "message"];

    private sealed record CurrentRule(Regex Pattern, string Replacement, string Why);

    /// <summary>A deep copy of the spec as the compiler reads it. 'Long Text' is Text (OutSystems has no such type: the length
    /// is a property of an attribute). A record path is the one the list really has: `V.Current.T.X` of a parameter or
    /// variable `V` of type `T List` reads `V.Current.X`, and `Q.List.Current.T.X` of a SQL query `Q` whose output is `T`
    /// reads `Q.List.Current.List.X`, its output being named List (the Verify answers "Can't identify 'T'" otherwise,
    /// Cardapio 2026-10-06). Every change is a note.</summary>
    internal static JsonObject Normalize(JsonObject data, List<LogicNote>? notes = null)
    {
        var copy = data.DeepClone().AsObject();
        if (copy["actions"] is not JsonArray actions) return copy;
        for (var a = 0; a < actions.Count; a++)
        {
            if (actions[a] is not JsonObject action) continue;
            var at = "/actions/" + a;
            var rules = new List<CurrentRule>();
            foreach (var section in new[] { "inputs", "outputs", "vars" })
            {
                if (action[section] is not JsonArray parameters) continue;
                for (var p = 0; p < parameters.Count; p++)
                {
                    if (parameters[p] is not JsonObject parameter) continue;
                    MapType(parameter, $"{at}/{section}/{p}/type", notes);
                    if (parameter["name"] is JsonValue n && n.TryGetValue<string>(out var name) && parameter["type"] is JsonValue t && t.TryGetValue<string>(out var type)
                        && ListType.Match(type) is { Success: true } list && !list.Groups[1].Value.Equals("Record", StringComparison.OrdinalIgnoreCase))
                    {
                        var element = list.Groups[1].Value;
                        rules.Add(new(new Regex($@"(?<![\w.])({Regex.Escape(name)})\.(?:List\.)?Current\.{Regex.Escape(element)}\.", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant),
                            "$1.Current.", $"{name} is a {element} List: its Current has the attributes of {element} directly"));
                    }
                }
            }
            // The SQL output this compiler creates is named List (kernel/AGENTS.md 2.1): the type segment of the output
            // (Q.List.Current.T.X) is that List, whatever the entity or structure. Any other path is left to the Verify and its
            // Hint Current, which names the real wrapper.
            foreach (var (query, type) in SqlQueries(action))
                rules.Add(new(new Regex($@"(?<![\w.])({Regex.Escape(query)})\.List\.Current\.{Regex.Escape(type)}\.", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant),
                    "$1.List.Current.List.", $"{query} is a SQL query: its output is named List, so a field of its record is {query}.List.Current.List.<Field>"));
            string Rewrite(string text, string pointer)
            {
                if (rules.Count == 0 || !text.Contains("Current", StringComparison.OrdinalIgnoreCase)) return text;
                var result = new StringBuilder(); var last = 0;
                foreach (Match? literal in StringLiteral.Matches(text).Cast<Match?>().Append(null))
                {
                    var end = literal?.Index ?? text.Length;
                    var code = text[last..end];
                    foreach (var rule in rules)
                    {
                        var changed = rule.Pattern.Replace(code, rule.Replacement);
                        if (changed == code) continue;
                        notes?.Add(new(pointer, "LOGIC_CURRENT_REWRITTEN", $"logic: {rule.Why}; '{rule.Pattern.Match(code).Value}' is written '{rule.Pattern.Match(code).Result(rule.Replacement)}'",
                            "write the path without the type segment"));
                        code = changed;
                    }
                    result.Append(code);
                    if (literal != null) result.Append(literal.Value);
                    last = literal == null ? text.Length : literal.Index + literal.Length;
                }
                return result.ToString();
            }
            if (action["steps"] is JsonArray steps) Steps(steps, at + "/steps", Rewrite, notes);
            if (action["handlers"] is JsonArray handlers)
                for (var h = 0; h < handlers.Count; h++)
                    if (handlers[h] is JsonObject handler && handler["steps"] is JsonArray handlerSteps) Steps(handlerSteps, $"{at}/handlers/{h}/steps", Rewrite, notes);
        }
        return copy;
    }

    private static void MapType(JsonObject owner, string pointer, List<LogicNote>? notes, string key = "type")
    {
        if (owner[key] is not JsonValue value || !value.TryGetValue<string>(out var type) || LongText.Match(type) is not { Success: true } match) return;
        var mapped = "Text" + (match.Groups[1].Success ? " List" : "");
        owner[key] = mapped;
        notes?.Add(new(pointer, "LOGIC_TYPE_MAPPED", $"logic: '{type.Trim()}' is not an OutSystems data type; it is declared as {mapped} (a text length belongs to an entity attribute)", $"write \"{mapped}\""));
    }

    /// <summary>The SQL queries of an action at any depth: (as, the entity or structure of its output).</summary>
    private static IEnumerable<(string Query, string Type)> SqlQueries(JsonObject action)
    {
        var found = new List<(string, string)>();
        void Visit(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject o:
                    if (o["sql"] is JsonValue sql && sql.TryGetValue<bool>(out var isSql) && isSql && o["get"] is JsonValue g && g.TryGetValue<string>(out var type)
                        && o["as"] is JsonValue a && a.TryGetValue<string>(out var query)) found.Add((query, type));
                    foreach (var (_, child) in o) Visit(child);
                    break;
                case JsonArray list: foreach (var child in list) Visit(child); break;
            }
        }
        Visit(action["steps"]); Visit(action["handlers"]);
        return found;
    }

    /// <summary>Applies <paramref name="rewrite"/> to every OutSystems expression of the steps (never to SQL or JavaScript text)
    /// and maps the declared types of SQL and JavaScript parameters.</summary>
    private static void Steps(JsonArray steps, string pointer, Func<string, string, string> rewrite, List<LogicNote>? notes)
    {
        for (var s = 0; s < steps.Count; s++)
        {
            if (steps[s] is not JsonObject step) continue;
            var at = pointer + "/" + s;
            void Value(JsonObject owner, string key, string where)
            {
                if (owner[key] is JsonValue v && v.TryGetValue<string>(out var text)) { var changed = rewrite(text, where); if (changed != text) owner[key] = changed; }
            }
            foreach (var key in ExpressionKeys)
            {
                if (step[key] is JsonArray many)
                {
                    for (var w = 0; w < many.Count; w++)
                        if (many[w] is JsonValue v && v.TryGetValue<string>(out var text) && rewrite(text, $"{at}/{key}/{w}") is var changed && changed != text) many[w] = changed;
                }
                else Value(step, key, at + "/" + key);
            }
            if (step["sort"] is JsonValue) Value(step, "sort", at + "/sort");
            else if (step["sort"] is JsonArray sorts)
                for (var k = 0; k < sorts.Count; k++)
                {
                    if (sorts[k] is JsonValue v && v.TryGetValue<string>(out var text) && rewrite(text, $"{at}/sort/{k}") is var changed && changed != text) sorts[k] = changed;
                    else if (sorts[k] is JsonObject by) Value(by, "by", $"{at}/sort/{k}/by");
                }
            if (step["assign"] is JsonObject assign)
            {
                // The target is a path too (V.Current.T.X = ...): the pairs are rebuilt in their order.
                var rebuilt = new JsonObject();
                foreach (var (target, value) in assign.ToList())
                {
                    var where = $"{at}/assign/{Escape(target)}";
                    var key = rewrite(target, where);
                    var copy = value?.DeepClone();
                    if (copy is JsonValue v && v.TryGetValue<string>(out var text)) copy = rewrite(text, where);
                    if (!rebuilt.ContainsKey(key)) rebuilt[key] = copy;
                }
                step["assign"] = rebuilt;
            }
            foreach (var key in new[] { "args", "properties", "record" })
                if (step[key] is JsonObject pairs && !(key == "properties" && step["node"]?.ToString() == "IJavaScriptNode"))
                    foreach (var name in pairs.Select(p => p.Key).ToArray()) Value(pairs, name, $"{at}/{key}/{Escape(name)}");
            if (step["params"] is JsonObject parameters)
                foreach (var (name, value) in parameters.ToArray())
                    if (value is JsonObject parameter) { Value(parameter, "value", $"{at}/params/{Escape(name)}/value"); MapType(parameter, $"{at}/params/{Escape(name)}/type", notes); }
            foreach (var section in new[] { "inputs", "outputs" })
                if (step["node"] != null && step[section] is JsonArray declared)
                    for (var p = 0; p < declared.Count; p++)
                        if (declared[p] is JsonObject parameter) MapType(parameter, $"{at}/{section}/{p}/type", notes);
            foreach (var (key, field) in new[] { ("joins", "condition"), ("columns", "attribute"), ("calculated", "value") })
                if (step[key] is JsonArray items)
                    for (var k = 0; k < items.Count; k++)
                        if (items[k] is JsonObject item) Value(item, field, $"{at}/{key}/{k}/{field}");
            if (step["switch"] is JsonArray cases)
                for (var c = 0; c < cases.Count; c++)
                    if (cases[c] is JsonObject branch)
                    {
                        Value(branch, "when", $"{at}/switch/{c}/when");
                        if (branch["steps"] is JsonArray caseSteps) Steps(caseSteps, $"{at}/switch/{c}/steps", rewrite, notes);
                    }
            foreach (var key in new[] { "then", "else", "do", "next", "otherwise" })
                if (step[key] is JsonArray nested) Steps(nested, at + "/" + key, rewrite, notes);
        }
    }

    // ---- sort: one ISort per key ---------------------------------------------------------------------------------------

    internal sealed record SortKey(string Attribute, string Direction);
    private static readonly Regex SortSuffix = new(@"^(.*?\S)\s+(asc|ascending|desc|descending)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static string? Direction(string word) => word.Trim().ToLowerInvariant() switch
    {
        "asc" or "ascending" => "Ascending", "desc" or "descending" => "Descending", _ => null,
    };

    /// <summary>The keys of a get's sort, in order: a text ("X", "X DESC", "-X", "+X"), a list of texts (a bare Ascending or
    /// Descending applies to the key before it, so the old ["X", "Descending"] still reads one key) or a list of {by, desc}.</summary>
    internal static List<SortKey> SortKeys(JsonNode? sort)
    {
        const string shape = "sort is \"Attr\", \"Attr DESC\", \"-Attr\", a list of those, or a list of {\"by\":\"Attr\",\"desc\":true}";
        var keys = new List<SortKey>();
        SortKey Parse(string text)
        {
            var value = text.Trim(); var direction = "Ascending";
            if (value.StartsWith('-')) { direction = "Descending"; value = value[1..].Trim(); }
            else if (value.StartsWith('+')) value = value[1..].Trim();
            else if (SortSuffix.Match(value) is { Success: true } m) { value = m.Groups[1].Value.Trim(); direction = Direction(m.Groups[2].Value)!; }
            if (value.Length == 0 || Direction(value) != null) throw new FieldException($"logic: sort key '{text}' names no attribute; " + shape, "sort");
            return new(value, direction);
        }
        switch (sort)
        {
            case null: return keys;
            case JsonValue v when v.TryGetValue<string>(out var text): keys.Add(Parse(text)); return keys;
            case JsonArray list:
                foreach (var item in list)
                {
                    if (item is JsonValue word && word.TryGetValue<string>(out var t) && Direction(t) is { } bare)
                    {
                        if (keys.Count == 0) throw new FieldException($"logic: sort direction '{t}' comes before any attribute; " + shape, "sort");
                        keys[^1] = keys[^1] with { Direction = bare };
                    }
                    else if (item is JsonValue entry && entry.TryGetValue<string>(out var keyText)) keys.Add(Parse(keyText));
                    else if (item is JsonObject by)
                    {
                        var unknown = by.Select(p => p.Key).Where(k => k is not ("by" or "desc")).ToArray();
                        if (unknown.Length > 0) throw new FieldException($"logic: sort key has unknown field(s) {string.Join(", ", unknown)}; " + shape, "sort");
                        var attribute = by["by"] is JsonValue b && b.TryGetValue<string>(out var s) ? s : throw new FieldException("logic: sort key {by, desc} needs by (text); " + shape, "sort");
                        var desc = by["desc"] switch
                        {
                            null => false,
                            JsonValue d when d.TryGetValue<bool>(out var flag) => flag,
                            _ => throw new FieldException("logic: sort desc is true or false; " + shape, "sort"),
                        };
                        var parsed = Parse(attribute);
                        keys.Add(by["desc"] == null ? parsed : parsed with { Direction = desc ? "Descending" : "Ascending" });
                    }
                    else throw new FieldException("logic: " + shape, "sort");
                }
                return keys;
            default: throw new FieldException("logic: " + shape, "sort");
        }
    }

    private sealed class ActionCompiler
    {
        private readonly List<JsonObject> _ops;
        private readonly HashSet<int>? _bodyExpressionOrdinals;
        private readonly List<ConstructionBarrier>? _barriers;
        private int _sequentialDepth;
        private sealed class ConstructionScope(Action end) : IDisposable
        {
            public void Dispose() => end();
        }

        private IDisposable? PreserveOrder(string reason)
        {
            if (_barriers == null) return null;
            _barriers.Add(new(_ops.Count, reason + ".begin"));
            _sequentialDepth++;
            return new ConstructionScope(() =>
            {
                _sequentialDepth--;
                _barriers.Add(new(_ops.Count, reason + ".end"));
            });
        }

        // Internal metadata only: the JSON operations and their original ordinals remain unchanged.
        private void BodySet(string target, string property, object value)
        {
            if (_sequentialDepth == 0) _bodyExpressionOrdinals?.Add(_ops.Count);
            _ops.Add(Set(target, property, value));
        }
        private readonly JsonObject _a;
        private readonly string _name;
        private readonly string _alias;
        private readonly string _pointer;
        private readonly List<LogicProblem> _problems;
        private readonly List<LogicNote>? _notes;
        private string? _stepPointer;
        private readonly Func<string[], string?> _tryRef;
        private readonly Func<LogicCallCandidate[], JsonObject, LogicCallTarget?>? _tryCall;
        private readonly HashSet<string> _nodeNames = new(StringComparer.OrdinalIgnoreCase);
        // Parameters and variables share the action's names: a generated node name never takes one of them.
        private readonly HashSet<string> _declaredNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, int> _counters = new(StringComparer.Ordinal);
        private readonly List<List<string>> _switchConditions = [];
        private sealed class ControlScope(bool isLoop, bool canBreak = true)
        {
            public bool IsLoop { get; } = isLoop;
            public bool CanBreak { get; } = canBreak;
            public List<(string, string?)> Breaks { get; } = [];
            public List<(string, string?)> Continues { get; } = [];
        }
        private readonly Stack<ControlScope> _scopes = new();

        /// <summary>Nome gerado por familia: Assign1, Assign2, If1, ForEach1 (sempre numerado) ou RaiseX, RaiseX2 (numerado a partir do 2o).</summary>
        private string Next(string prefix, bool numberFirst = true)
        {
            var n = _counters[prefix] = _counters.GetValueOrDefault(prefix) + 1;
            return n == 1 && !numberFirst ? prefix : prefix + n;
        }

        public ActionCompiler(List<JsonObject> ops, JsonObject a, string name, string alias, string pointer, List<LogicProblem> problems, List<LogicNote>? notes,
            Func<string[], string?> tryRef, Func<LogicCallCandidate[], JsonObject, LogicCallTarget?>? tryCall = null, HashSet<int>? body = null, List<ConstructionBarrier>? barriers = null)
        {
            _ops = ops; _a = a; _name = name; _alias = alias; _pointer = pointer; _problems = problems; _notes = notes;
            _tryRef = tryRef; _tryCall = tryCall; _bodyExpressionOrdinals = body; _barriers = barriers;
        }

        /// <summary>A problem of one step, the step's pointer plus the field it names; compilation goes on with the next step.</summary>
        private void Record(Exception error, string at)
            => _problems.Add(ProblemAt(error, at, coded: true));

        public void Declare()
        {
            Keys(_a, ActionKeys, $"action {_name}");
            foreach (var key in new[] { "inputs", "outputs", "vars", "steps", "handlers", "comments" })
                if (_a.ContainsKey(key) && (_a[key] is not JsonArray array || array.Any(v => v is not JsonObject))) throw new ArgumentException("logic: " + key + " requires declaration objects");
            if (_a.ContainsKey("replace") && (_a["replace"] is not JsonValue flag || !flag.TryGetValue<bool>(out _)))
                throw new InvalidOperationException($"logic: action {_name}: replace must be a boolean");
            var kind = LogicOrder.ActionType(_a);
            if (kind == LogicOrder.MobileScreenAction && _a["outputs"]?.AsArray().Count > 0)
                throw new InvalidOperationException("logic: Reactive/Mobile screen actions do not support output parameters in this SS5 runtime; use a client action for returned values or a void screen action with owner state");
            _ops.Add(Op("create", ("parent", LogicOrder.Owner(_a)), ("type", kind), ("name", _name), ("as", _alias)));
            // A new REST callback is born with its parameters, a comment, Start, End and the Assign that copies the request:
            // the body written here replaces that Assign (a replaced one keeps only its parameters).
            if (BornCallback) _ops.Add(Op("delete", ("target", _alias + "/#IAssignNode"), ("force", true))); // its only consumer: the Start's connector, linked again below
            if (kind == LogicOrder.RestServiceAction)
            {
                var http = _a["http"]?.GetValue<string>()?.ToUpperInvariant() ?? "GET";
                if (!RestExpander.Verbs.Contains(http)) throw new ArgumentException($"logic: rest action {_name}: http '{_a["http"]}' is not one of {string.Join(", ", RestExpander.Verbs)}");
                var path = _a["path"]?.GetValue<string>() ?? "/" + _name;
                if (RestExpander.PathProblem(path) is { } why) throw new ArgumentException($"logic: rest action {_name}: path '{path}': {why}");
                _ops.Add(Set(_alias, "HTTPMethod", http));
                _ops.Add(Set(_alias, "URLPath", path));
            }
            else if (_a.ContainsKey("http") || _a.ContainsKey("path")) throw new ArgumentException($"logic: action {_name}: http/path exist only on kind rest");
            foreach (var section in new[] { "inputs", "outputs", "vars" })
                if (kind != LogicOrder.RestServiceAction || section == "vars")
                    foreach (var p in _a[section]?.AsArray().OfType<JsonObject>() ?? [])
                        if (p.ContainsKey("in")) throw new ArgumentException($"logic: action {_name} {section} '{p["name"]}': 'in' exists only on the parameters of a rest action");
            if (kind == "IDataAction")
            {
                _ops.Add(Op("delete", ("target", _alias + "/Out1")));
                var fetch = _a["fetch"]?.ToString() ?? "AtStart";
                if (fetch is not ("AtStart" or "OnDemand")) throw new ArgumentException("Data action fetch must be AtStart or OnDemand");
                _ops.Add(Set(_alias, "Fetch", fetch));
                if (_a["timeout"] != null) _ops.Add(Set(_alias, "ServerRequestTimeout", _a["timeout"]!.GetValue<int>()));
            }
            else if (_a.ContainsKey("fetch") || _a.ContainsKey("timeout")) throw new ArgumentException("fetch/timeout require a data action");
            if (_a["public"]?.GetValue<bool>() is true) _ops.Add(Set(_alias, "Public", true));
            if (_a["function"]?.GetValue<bool>() is true) _ops.Add(Set(_alias, "Function", true));
            if (_a["description"]?.GetValue<string>() is { } d) _ops.Add(Set(_alias, "Description", d));
            var rest = kind == LogicOrder.RestServiceAction;
            Params("inputs", rest ? "IRestServiceActionInput" : "IInputParameter");
            Params("outputs", rest ? "IRestServiceActionOutput" : "IOutputParameter");
            Params("vars", "ILocalVariable");
        }

        private bool IsRest => LogicOrder.ActionType(_a) == LogicOrder.RestServiceAction;
        // A REST callback created by this op (not a replace): its Start and End are the ones it is born with.
        private bool BornCallback => LogicOrder.ActionType(_a) == LogicOrder.RestCallback && _a["replace"]?.GetValue<bool>() != true;
        private bool BornFlow => IsRest || BornCallback;

        public void CompileBody()
        {
            var steps = _a["steps"]?.AsArray() ?? throw new InvalidOperationException($"logic: action {_name}: 'steps' e obrigatorio (pode ser [])");
            // An exposed REST method is born with its Start and End: the flow starts at its own Start (a second one is
            // InvalidFlow_TooManyNodes) and the tails reach its own End.
            var start = BornFlow ? _alias + "/#IStartNode" : Node("IStartNode", "Start", label: false);
            var tails = Segment(steps, [(start, null)], $"action {_name}", _pointer + "/steps");
            var handlers = _a["handlers"]?.AsArray() ?? new JsonArray();
            for (var h = 0; h < handlers.Count; h++)
            {
                var at = $"{_pointer}/handlers/{h}";
                _stepPointer = at;
                try
                {
                    var handler = handlers[h] as JsonObject ?? throw new InvalidOperationException($"logic: action {_name}: handler #{h + 1} is an object {{\"name\", \"exception\", \"steps\"}}");
                    Keys(handler, ["name", "exception", "abortTransaction", "logError", "steps"], "handler");
                    var node = Node("IExceptionHandlerNode", Req(handler, "name", "handler"), false);
                    _ops.Add(Set(node, "Exception", HandledException(Req(handler, "exception", "handler"))));
                    // The Studio's own defaults for a new handler: abort the transaction and log the error.
                    _ops.Add(Set(node, "AbortTransaction", Flag(handler, "abortTransaction", true)));
                    _ops.Add(Set(node, "LogError", Flag(handler, "logError", true)));
                    var handlerTails = Segment(handler["steps"] as JsonArray ?? throw new FieldException("logic: handler: 'steps' e obrigatorio (pode ser [])", "steps"), [(node, null)], "handler", at + "/steps");
                    if (handlerTails.Count > 0) { _stepPointer = at; LinkAll(handlerTails, Node("IEndNode", "End" + handler["name"], false)); }
                }
                catch (Exception ex) { Record(ex, at); }
                finally { _stepPointer = null; }
            }
            if (BornFlow)
            {
                if (tails.Count > 0) LinkAll(tails, _alias + "/#IEndNode");
                else _ops.Add(Op("delete", ("target", _alias + "/#IEndNode"))); // every path raises: the born End would be unreachable
            }
            else if (tails.Count > 0) { var end = Node("IEndNode", "End", label: false); LinkAll(tails, end); }
            var comments = _a["comments"]?.AsArray() ?? new JsonArray();
            for (var c = 0; c < comments.Count; c++)
            {
                try
                {
                    var comment = comments[c] as JsonObject ?? throw new InvalidOperationException($"logic: action {_name}: comment #{c + 1} is an object {{\"text\", \"reminder\"}}");
                    Keys(comment, ["text", "reminder"], "comment");
                    var node = Node("OutSystems.Model.Logic.Nodes.ICommentNode", Next("Comment"), false);
                    _ops.Add(Set(node, "Text", Req(comment, "text", "comment")));
                    _ops.Add(Set(node, "IsReminder", comment["reminder"]?.GetValue<bool>() ?? false));
                }
                catch (Exception ex) { Record(ex, $"{_pointer}/comments/{c}"); }
            }
            // Native condition order follows connector creation. A break/continue edge may be
            // linked much later, so restore declared order only after every target is connected.
            foreach (var conditions in _switchConditions)
                for (var i = 0; i < conditions.Count; i++)
                    _ops.Add(i == 0 ? Op("move", ("target", conditions[i]), ("first", true))
                        : Op("move", ("target", conditions[i]), ("after", conditions[i - 1])));
            _ops.Add(Op("layout", ("target", _alias)));
        }

        private static bool Flag(JsonObject owner, string key, bool fallback)
        {
            if (!owner.ContainsKey(key)) return fallback;
            return owner[key] is JsonValue v && v.TryGetValue<bool>(out var flag) ? flag
                : throw new ArgumentException($"handler {key} must be true or false (omit it for {fallback.ToString().ToLowerInvariant()})");
        }

        /// <summary>The exception a handler catches: a reference as written (Type:Name, @key, $alias); a system exception by
        /// the name people write (All Exceptions, AllExceptions, Database Exception, ...); otherwise a user exception.</summary>
        private static string HandledException(string exception)
        {
            if (exception.Contains(':') || exception.StartsWith('@') || exception.StartsWith('$')) return exception;
            return ValueAliases.SystemExceptions.Contains(ValueAliases.SystemExceptionKey(exception)) ? "ISystemException:" + exception : "IUserException:" + exception;
        }

        private void Params(string key, string type)
        {
            foreach (var p in _a[key]?.AsArray() ?? new JsonArray())
            {
                var po = p!.AsObject();
                Keys(po, ParamKeys, $"action {_name} {key}");
                var pn = Req(po, "name", $"action {_name} {key}");
                _declaredNames.Add(pn);
                _ops.Add(Op("create", ("parent", _alias), ("type", type), ("name", pn), ("as", $"{_alias}.{pn}")));
                _ops.Add(Set($"{_alias}.{pn}", "DataType", po["type"]?.GetValue<string>() ?? throw new InvalidOperationException($"logic: action {_name} {key} '{pn}': 'type' e obrigatorio")));
                if (po["mandatory"]?.GetValue<bool>() is false)
                {
                    if (type is not ("IInputParameter" or "IRestServiceActionInput")) throw new InvalidOperationException($"logic: action {_name} {key} '{pn}': 'mandatory' so existe em inputs");
                    _ops.Add(Set($"{_alias}.{pn}", "IsMandatory", false));
                }
                if (po["default"]?.GetValue<string>() is { } dv) _ops.Add(Set($"{_alias}.{pn}", "DefaultValue", dv));
                if (po["description"]?.GetValue<string>() is { } ds) _ops.Add(Set($"{_alias}.{pn}", "Description", ds));
                // An exposed REST method's parameter: where it is received/sent (the platform defaults are URL and Body).
                if (type == "IRestServiceActionInput" && (po["in"]?.GetValue<string>()?.ToLowerInvariant() ?? "url") is var receive and not "url")
                    _ops.Add(Set($"{_alias}.{pn}", "ReceiveIn", receive switch { "header" => "Header", "body" => "Body", _ => throw new ArgumentException($"logic: rest action {_name} input '{pn}': in '{receive}' is not url, header or body") }));
                if (type == "IRestServiceActionOutput" && (po["in"]?.GetValue<string>()?.ToLowerInvariant() ?? "body") is var send and not "body")
                    _ops.Add(Set($"{_alias}.{pn}", "SendIn", send == "header" ? "Header" : throw new ArgumentException($"logic: rest action {_name} output '{pn}': in '{send}' is not body or header")));
            }
        }

        /// <summary>Compila uma lista de passos a partir das pontas soltas (no, conector) e devolve as pontas soltas do fim. Um passo
        /// que falha vira um problema com o seu ponteiro e a compilacao segue no proximo (todos os erros de uma vez, I4).</summary>
        private List<(string Node, string? Connector)> Segment(JsonArray steps, List<(string, string?)> incoming, string where, string pointer)
        {
            var tails = incoming;
            for (var i = 0; i < steps.Count; i++)
            {
                var ctx = $"{where} passo #{i + 1}";
                var at = pointer + "/" + i;
                var outer = _stepPointer; _stepPointer = at; var outerLabel = _stepLabel;
                try
                {
                    var so = steps[i] as JsonObject ?? throw new InvalidOperationException($"logic: {ctx}: a step is an object with one of {string.Join(", ", StepKinds)}");
                    // Reported once, and the step is still compiled so its own problems come out in the same answer.
                    if (tails.Count == 0) Record(new ArgumentException("logic: unreachable step at " + ctx), at);
                    var kind = StepKinds.Where(k => so.ContainsKey(k)).ToList();
                    if (kind.Count != 1)
                        throw new InvalidOperationException($"logic: {ctx}: um passo tem exatamente UMA forma ({string.Join(", ", StepKinds)}); encontrado: {(kind.Count == 0 ? "nenhuma" : string.Join(", ", kind))} em {so.ToJsonString()}");
                    var k = kind[0];
                    // C18 (atritos 3): `label` is accepted on every step (StepKeys keeps it only where it always was).
                    Keys(so, StepKeys[k].Contains("label") ? StepKeys[k] : [.. StepKeys[k], "label"], $"{ctx} ({k})");
                    _stepLabel = so["label"] is JsonValue lv && lv.TryGetValue<string>(out var labelText) && labelText.Trim().Length > 0 ? labelText.Trim()
                        : so.ContainsKey("label") ? throw new FieldException($"logic: {ctx} ({k}): 'label' is text", "label") : null;
                    tails = k switch
                    {
                        "get" => Simple(tails, Get(so, ctx)),
                        "assign" => Simple(tails, Assign(so, ctx)),
                        "call" => Simple(tails, Call(so, ctx)),
                        "save" or "create" or "update" or "delete" => EntityStep(tails, so, k, ctx),
                        "if" => If(so, tails, ctx, at),
                        "foreach" => ForEach(so, tails, ctx, at),
                        "while" => While(so, tails, ctx, at),
                        "break" or "continue" or "return" => Transfer(so, k, tails, ctx),
                        "raise" => Raise(so, tails, ctx),
                        "switch" => Switch(so, tails, ctx, at),
                        "node" => Native(so, tails, ctx),
                        _ => throw new InvalidOperationException(k),
                    };
                }
                catch (Exception ex) { Record(ex, at); }
                finally { _stepPointer = outer; _stepLabel = outerLabel; }
            }
            return tails;
        }

        // C18: the label of the step being compiled; a node with a Label (Assign, If, For Each, Switch, Message) shows it.
        private string? _stepLabel;
        // C18: the locals of the records given as fields, by step (RecordVariables).
        private Dictionary<JsonObject, (string Variable, string Entity)>? _recordVariables;

        /// <summary>The name a step without `as` takes from its label, on a node that has no Label (a call, an aggregate, an
        /// entity action): the label when it is an identifier; otherwise null and a note that it was not written.</summary>
        private string? LabelAsName(JsonObject so)
        {
            if (so["as"] != null || _stepLabel == null) return null;
            if (Identifier.IsMatch(_stepLabel)) return _stepLabel;
            _notes?.Add(new(_stepPointer ?? _pointer, "LOGIC_LABEL_NOT_WRITTEN",
                $"logic: action {_name}: this node has no Label and its name must be an identifier; the label '{_stepLabel}' was not written",
                "give the step an \"as\" (an identifier) to name the node, or drop the label"));
            return null;
        }

        private List<(string, string?)> Simple(List<(string, string?)> tails, string node)
        {
            LinkAll(tails, node);
            return [(node, null)];
        }

        public string Get(JsonObject so, string ctx)
        {
            var entity = Req(so, "get", ctx);
            foreach (var key in new[] { "joins", "columns", "calculated" })
                if (so.ContainsKey(key) && (so[key] is not JsonArray collection || collection.Any(v => v is not JsonObject))) throw new ArgumentException(key + " requires declaration objects");
            var name = so["as"] is JsonValue a && a.TryGetValue<string>(out var given) ? given
                : LabelAsName(so) ?? throw new FieldException($"logic: {ctx}: get exige 'as' (o nome do aggregate, ex.: {{\"get\":\"{entity}\",\"as\":\"Get{entity}s\",\"where\":\"...\"}})", "as");
            if (so["sql"]?.GetValue<bool>() is true)
                return SqlGet(so, ctx, entity, name);
            // Aggregate columns/filters may infer types. Flush preceding expressions, then
            // preserve the whole existing construction sequence without deferring its setters.
            using var constructionOrder = PreserveOrder("aggregate");
            if (so.ContainsKey("statement") || so.ContainsKey("params"))
                throw new InvalidOperationException($"logic: {ctx}: statement/params require sql:true");
            var src = _tryRef([$"IServerEntity:{entity}", $"IClientEntity:{entity}", $"IStaticEntity:{entity}", $"IEntitySignature:{entity}"])
                      ?? throw new InvalidOperationException($"logic: {ctx}: entidade '{entity}' nao existe neste modulo nem esta referenciada (use `reference` antes, ou confira o nome com `find`)");
            var node = Node("IAggregateNode", name, label: false);
            var sources = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var sourceIndex = 0;
            foreach (var source in new[] { entity }.Concat(Many(so["sources"])))
            {
                var sourceAlias = node + ".source" + sources.Count;
                // C18 (atritos 3): the same entity twice is a self-join; the second source is <Entity>2, as the Studio names it.
                var sourceName = source;
                for (var n = 2; sources.ContainsKey(sourceName); n++) sourceName = source + n;
                if (sourceName != source)
                    _notes?.Add(new($"{_stepPointer ?? _pointer}/sources" + (so["sources"] is JsonArray ? "/" + (sourceIndex - 1) : ""), "LOGIC_SOURCE_RENAMED",
                        $"logic: {ctx}: '{source}' is already a source of this aggregate; this one is named '{sourceName}' (a self-join), as the Studio names it",
                        $"name it '{sourceName}' in joins and expressions"));
                sources[sourceName] = sourceAlias;
                sourceIndex++;
                var reference = source == entity ? src : _tryRef([$"IServerEntity:{source}", $"IClientEntity:{source}", $"IEntitySignature:{source}", $"IStaticEntity:{source}"])
                    ?? throw new ArgumentException("Unknown aggregate source: " + source);
                _ops.Add(Op("create", ("parent", node), ("type", "IAliasedSource"), ("name", sourceName), ("as", sourceAlias), ("args", new JsonObject { ["dataSource"] = reference })));
            }
            var joinIndex = 0;
            var declaredJoins = so["joins"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
            foreach (var item in declaredJoins)
            {
                Keys(item, ["left", "right", "kind", "condition"], "aggregate join");
                var left = Req(item, "left", ctx); var right = Req(item, "right", ctx);
                var joinType = JoinKind(Req(item, "kind", ctx)) ?? throw new ArgumentException($"Unknown JoinType: {item["kind"]}; use Only With (Inner), With or Without (Left), With (Full), or None, Inner, Left, Right, Full");
                if (!sources.ContainsKey(left) || !sources.ContainsKey(right) || left.Equals(right, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Join must name two declared distinct sources");
                // The Right join of two sources is the Left join with them swapped, the form the Studio writes (NativeJoin; any
                // other Right or None is refused by the checagem de compilação).
                if (NativeJoin(joinType, declaredJoins.Count, sources.Count) is { } native && native.Swapped)
                {
                    _notes?.Add(new($"{_stepPointer ?? _pointer}/joins/{joinIndex}", AggregateSortRule.JoinNormalizedCode,
                        $"logic: {ctx}: the join Right {left}~{right} is written Left {right}~{left}, as the Studio writes it (a Right join keeps every row of its right source: the Left join with the two sources swapped)",
                        $"write {{\"left\":\"{right}\",\"right\":\"{left}\",\"kind\":\"With or Without\"}}"));
                    (left, right, joinType) = (right, left, native.Kind);
                }
                var alias = node + ".join" + ++joinIndex;
                _ops.Add(Op("create", ("parent", node), ("type", "IJoin"), ("as", alias)));
                _ops.Add(Set(alias, "LeftSource", sources[left])); _ops.Add(Set(alias, "RightSource", sources[right]));
                _ops.Add(Set(alias, "JoinType", joinType)); _ops.Add(Set(alias, "Condition", Req(item, "condition", ctx)));
            }
            var columnNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var declaredColumns = so["columns"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
            for (var columnIndex = 0; columnIndex < declaredColumns.Count; columnIndex++)
            {
                var item = declaredColumns[columnIndex];
                Keys(item, ["name", "kind", "attribute"], "aggregate column"); var columnName = Req(item, "name", ctx); var columnKind = Req(item, "kind", ctx);
                if (!columnNames.Add(columnName)) throw new ArgumentException("Repeated aggregate column: " + columnName);
                if (!new[] { "Group", "Count", "Sum", "Max", "Min", "Avg" }.Contains(columnKind)) throw new ArgumentException("Unknown aggregation: " + columnKind);
                var attribute = Req(item, "attribute", ctx);
                // A column that reads no attribute ("Count" is no COUNT(*)): no data type, nothing for the compiler to aggregate.
                if (attribute.Trim().Length == 0)
                {
                    var only = sources.Count == 1 ? sources.Keys.First() : null;
                    var fix = AggregateSortRule.EmptyColumnFix(columnName, columnKind == "Group", columnKind == "Group" ? null : columnKind, only, null);
                    throw new FieldException($"logic: {ctx}: the aggregate column '{columnName}' ({columnKind}) {AggregateSortRule.EmptyColumnWhy}: the column has no data type and the compiler has nothing to "
                        + (columnKind == "Group" ? "group by" : "aggregate") + " (Count is no COUNT(*)); " + fix, "columns", AggregateSortRule.ColumnCode,
                        "write the attribute the column reads: " + fix, columnIndex.ToString(System.Globalization.CultureInfo.InvariantCulture), "attribute");
                }
                var alias = node + ".column" + columnNames.Count;
                _ops.Add(Op("create", ("parent", node), ("type", columnKind == "Group" ? "IGroupByAttribute" : "IAggregateAttribute"), ("name", columnName), ("as", alias)));
                _ops.Add(Set(alias, "Attribute", attribute));
                if (columnKind != "Group") _ops.Add(Set(alias, "AggregationType", columnKind));
            }
            foreach (var item in so["calculated"]?.AsArray().OfType<JsonObject>() ?? [])
            {
                Keys(item, ["name", "value"], "calculated column"); var columnName = Req(item, "name", ctx);
                if (!columnNames.Add(columnName)) throw new ArgumentException("Repeated aggregate column: " + columnName);
                var alias = node + ".column" + columnNames.Count;
                _ops.Add(Op("create", ("parent", node), ("type", "ICalculatedAttribute"), ("name", columnName), ("as", alias)));
                _ops.Add(Set(alias, "Value", Req(item, "value", ctx)));
            }
            foreach (var w in Many(so["where"]))
                _ops.Add(Op("create", ("parent", node), ("type", "IFilter"), ("args", new JsonObject { ["condition"] = w })));
            // One ISort per key, in the order written (the first is the primary order): "X DESC", "-X", ["X","Y"], [{by,desc}].
            var keys = SortKeys(so["sort"]);
            for (var k = 0; k < keys.Count; k++)
            {
                var sal = k == 0 ? $"{node}.sort" : $"{node}.sort{k + 1}";
                _ops.Add(Op("create", ("parent", node), ("type", "ISort"), ("as", sal)));
                _ops.Add(Set(sal, "Attribute", keys[k].Attribute));
                _ops.Add(Set(sal, "SortDirection", keys[k].Direction));
            }
            if (so["max"] is { } max) BodySet(node, "MaxRecords", max.ToString());
            if (so["start"] is { } st) BodySet(node, "StartIndex", st.ToString());
            // The Studio renames an aggregate whose name follows its own pattern (GetPerguntas) when a filter arrives
            // (GetPerguntasByQuizId): the declared name is written again after the sources and filters, so it is the one kept.
            _ops.Add(Set(node, "Name", name));
            return node;
        }


        private string SqlGet(JsonObject so, string ctx, string entity, string name)
        {
            var statement = so["statement"]?.GetValue<string>()
                            ?? throw new InvalidOperationException($"logic: {ctx}: get com sql=true exige 'statement'");
            var incompatible = new[] { "where", "sort", "start", "sources", "joins", "columns", "calculated" }.Where(so.ContainsKey).ToArray();
            if (incompatible.Length > 0)
                throw new InvalidOperationException($"logic: {ctx}: {string.Join(", ", incompatible)} cannot be used with sql:true; filter/order/page in the statement (MaxRecords uses max).");
            SqlChecks.Validate(statement, so["params"]?.AsObject().Select(p => p.Key) ?? Enumerable.Empty<string>(), ctx);
            var node = Node("ISQLNode", name, label: false);
            _ops.Add(Set(node, "Statement", statement));
            foreach (var p in so["params"]?.AsObject() ?? new JsonObject())
            {
                var po = p.Value?.AsObject() ?? throw new InvalidOperationException($"logic: {ctx}: parametro SQL '{p.Key}' deve ser objeto");
                Keys(po, SqlParamKeys, $"{ctx} SQL param {p.Key}");
                var pt = po["type"]?.GetValue<string>() ?? throw new InvalidOperationException($"logic: {ctx}: parametro SQL '{p.Key}' exige 'type'");
                var pv = po["value"]?.GetValue<string>() ?? throw new InvalidOperationException($"logic: {ctx}: parametro SQL '{p.Key}' exige 'value'");
                var input = $"{node}/{p.Key}";
                _ops.Add(Op("create", ("parent", node), ("type", "ISQLInputParameter"), ("name", p.Key), ("as", input)));
                _ops.Add(Set(input, "DataType", pt));
                BodySet($"{node}/arg:{p.Key}", "Value", pv);
            }
            _ops.Add(Op("create", ("parent", node), ("type", "ISQLOutput"), ("name", "List"), ("as", $"{node}/List"),
                ("args", new JsonObject { ["entityOrStructure"] = entity })));
            if (so["max"] is { } max) BodySet(node, "MaxRecords", max.ToString());
            return node;
        }

        private string Assign(JsonObject so, string ctx)
        {
            var pairs = so["assign"]?.AsObject() ?? throw new InvalidOperationException($"logic: {ctx}: 'assign' e um objeto {{\"Variavel\": \"expressao\"}}");
            if (pairs.Count == 0) throw new InvalidOperationException($"logic: {ctx}: assign vazio");
            var node = Node("IAssignNode", so["as"]?.GetValue<string>() ?? Next("Assign"), label: true);
            var j = 0;
            foreach (var kv in pairs)
            {
                var value = kv.Value?.GetValue<string>() ?? throw new InvalidOperationException($"logic: {ctx}: assign '{kv.Key}': a expressao e texto");
                if (string.Equals(kv.Key.Trim(), value.Trim(), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"logic: {ctx} ({so["as"] ?? "Assign"}): assignment '{kv.Key} = {value}' does nothing; assign the intended source expression.");
                var al = $"{node}.a{++j}";
                _ops.Add(Op("create", ("parent", node), ("type", "IAssignment"), ("as", al)));
                BodySet(al, "Variable", kv.Key);
                BodySet(al, "Value", value);
            }
            return node;
        }

        private string Call(JsonObject so, string ctx)
        {
            var target = Req(so, "call", ctx);
            // Without 'as' the node takes the action's name, numbered from the second (Event_Write, Event_Write2), as the Studio
            // names a dropped action; a reference by key or alias has no name to read, so it is Call1, Call2.
            var name = so["as"] != null ? Req(so, "as", ctx) : LabelAsName(so) ?? DefaultCallName(target);
            var resolved = _tryCall!(LogicOrder.CallCandidates(target, _a), _a)
                ?? throw new InvalidOperationException($"logic: {ctx}: action '{target}' nao existe (propria, referenciada, de entidade como CreateOrUpdateX, ou de sistema como ListAppend); confira com `find`");
            LogicOrder.ValidateCall(_a, resolved);
            RefuseForeignCurrent(target, so, ctx);
            var node = Node(resolved.IsClient ? "IExecuteClientActionNode" : "IExecuteServerActionNode", name, label: false);
            _ops.Add(Set(node, "Action", resolved.Reference));
            foreach (var kv in so["args"]?.AsObject() ?? new JsonObject())
                BodySet($"{node}/{kv.Key}", "Value", kv.Value?.GetValue<string>() ?? throw new InvalidOperationException($"logic: {ctx}: arg '{kv.Key}': a expressao e texto"));
            return node;
        }

        private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);

        private string DefaultCallName(string target)
        {
            var bare = target.Split('/')[^1].Split(':')[^1].Trim();
            if (target.StartsWith('@') || target.StartsWith('$') || !Identifier.IsMatch(bare)) return Next("Call");
            // A parameter or variable of the same name keeps its name, and so does an earlier node: this one is numbered.
            bool Taken(string name) => _nodeNames.Contains(name) || _declaredNames.Contains(name);
            return Taken(bare) ? Numbered(bare, Taken) : bare;
        }

        /// <summary>The stem of a native node's default name: the interface without its I and its Node suffix.</summary>
        private static string NativeStem(string type)
        {
            var stem = type.StartsWith('I') && type.Length > 1 && char.IsUpper(type[1]) ? type[1..] : type;
            return stem.EndsWith("Node", StringComparison.Ordinal) && stem.Length > 4 ? stem[..^4] : stem;
        }

        /// <summary>The Studio's name for a copy: End -> End2, Assign1 -> Assign2, the first free one.</summary>
        private static string Numbered(string name, Func<string, bool> taken)
        {
            var match = Regex.Match(name, @"^(.*?[^0-9])([0-9]+)$");
            var stem = match.Success ? match.Groups[1].Value : name;
            var n = match.Success && int.TryParse(match.Groups[2].Value, out var current) ? current + 1 : 2;
            while (taken(stem + n)) n++;
            return stem + n;
        }

        private static readonly HashSet<string> ConditionBuiltins = new(StringComparer.Ordinal) { "ListIndexOf", "ListFilter", "ListAny", "ListAll" };

        /// <summary>In ODC client logic the Condition of ListIndexOf/ListFilter/ListAny/ListAll reads `List.Current` through the call's
        /// iteration context (the generated code ignores the element the built-in passes). Inside a For Each or While that context
        /// already pins the List's Current to one element, so the search compares every row against that same element and silently
        /// answers -1 or the wrong row (Escala Viva, live: chips named after the wrong type, coverage 0/7, every shift "Novo", the
        /// selection bar inert). The same happens in a screen action started by JavaScript ($actions.X from a JS node) or by an event
        /// of a widget inside a List (the row pins the context): the caller decides, so client logic never uses these built-ins. The
        /// search is written as a For Each over the List with an If that keeps the first match.</summary>
        private void RefuseForeignCurrent(string target, JsonObject so, string ctx)
        {
            if (!ConditionBuiltins.Contains(target) || !LogicOrder.IsClient(_a)) return;
            // Only the loop is visible here; a List row event or a JavaScript caller is the caller's choice (kernel/AGENTS.md).
            if (!ctx.Contains(" do", StringComparison.Ordinal)) return;
            var list = (so["args"]?["List"] ?? so["args"]?["SourceList"])?.GetValue<string>()?.Trim() ?? "List";
            throw new InvalidOperationException($"logic: {ctx}: {target} over {list} inside a loop of client logic: the generated Condition reads {list}.Current from the "
                + "loop's iteration context, which stays pinned to one element, so the search silently finds nothing or the wrong row. Write it as "
                + $"{{\"foreach\": \"{list}\", \"do\": [{{\"if\": \"Pos < 0 and <condition on {list}.Current>\", \"then\": [{{\"assign\": {{\"Pos\": \"{list}.CurrentRowNumber\"}}}}]}}]}} "
                + "with a local Pos set to -1 before it.");
        }

        /// <summary>An entity action step; a record given as fields puts its Assign before the action (C18).</summary>
        private List<(string, string?)> EntityStep(List<(string, string?)> tails, JsonObject so, string kind, string ctx)
        {
            var (node, head) = EntityAction(so, kind, ctx);
            if (head != null) tails = Simple(tails, head);
            return Simple(tails, node);
        }

        private (string Node, string? Head) EntityAction(JsonObject so, string kind, string ctx)
        {
            var entity = Req(so, kind, ctx);
            var verb = kind switch { "save" => "CreateOrUpdate", "create" => "Create", "update" => "Update", _ => "Delete" };
            var reference = _tryRef([$"IEntityActionSignature:{verb}{entity}"])
                            ?? throw new InvalidOperationException($"logic: {ctx}: entidade '{entity}' nao existe (nao ha {verb}{entity}); confira o nome com `find`");
            var client = LogicOrder.IsClient(_a) && _tryRef([$"IClientEntity:{entity}"]) != null;
            // C18 (atritos 3): `record` given as the values of its fields ({Field: expression}) is a local of the entity's
            // record type, an Assign of those fields and the entity action over it, as one writes it in the Studio.
            string? source = null; string? assign = null;
            if (kind != "delete" && so["record"] is JsonObject fields)
            {
                if (fields.Count == 0) throw new FieldException($"logic: {ctx}: record {{}} has no field; write {{\"Field\": \"expression\"}} or the name of a {entity} variable", "record");
                (source, assign) = RecordAssign(so, entity, fields, ctx);
            }
            var node = Node(client ? "IExecuteClientActionNode" : "IExecuteServerActionNode", so["as"]?.GetValue<string>() ?? LabelAsName(so) ?? $"{verb}{entity}", label: false);
            _ops.Add(Set(node, "Action", reference));
            if (kind == "delete")
                BodySet($"{node}/Id", "Value", Req(so, "id", ctx));
            else
                BodySet($"{node}/Source", "Value", source ?? Req(so, "record", ctx));
            return (node, assign);
        }

        /// <summary>A local of type <paramref name="entity"/> (its record), named &lt;Entity&gt;Record (numbered when taken), and
        /// an Assign of each field: (the local's name, the Assign node).</summary>
        private (string Variable, string Assign) RecordAssign(JsonObject so, string entity, JsonObject fields, string ctx)
        {
            _recordVariables ??= RecordVariables(_a);
            var variable = _recordVariables.TryGetValue(so, out var named) ? named.Variable : entity + "Record";
            _declaredNames.Add(variable);
            var alias = $"{_alias}.{variable}";
            _ops.Add(Op("create", ("parent", _alias), ("type", "ILocalVariable"), ("name", variable), ("as", alias)));
            _ops.Add(Set(alias, "DataType", entity));
            // The generated Assign shows its own name; the step's label (if any) names the entity action.
            var label = _stepLabel; _stepLabel = null;
            string node;
            try { node = Node("IAssignNode", Next("Assign"), label: true); }
            finally { _stepLabel = label; }
            var j = 0;
            foreach (var (field, value) in fields)
            {
                var text = value is JsonValue v && v.TryGetValue<string>(out var expression) ? expression
                    : throw new FieldException($"logic: {ctx}: record field '{field}' is an OutSystems expression (text)", "record");
                var al = $"{node}.a{++j}";
                _ops.Add(Op("create", ("parent", node), ("type", "IAssignment"), ("as", al)));
                BodySet(al, "Variable", variable + "." + field);
                BodySet(al, "Value", text);
            }
            return (variable, node);
        }

        private List<(string, string?)> If(JsonObject so, List<(string, string?)> tails, string ctx, string at)
        {
            var node = Node("IIfNode", so["as"]?.GetValue<string>() ?? Next("If"), label: true);
            BodySet(node, "Condition", Req(so, "if", ctx));
            if (so["label"] != null || so["as"] == null) _ops.Add(Set(node, "Label", DecisionLabel(so["label"]?.GetValue<string>() ?? Req(so, "if", ctx))));
            LinkAll(tails, node);
            var thenTails = Segment(so["then"]?.AsArray() ?? new JsonArray(), [(node, "TrueTarget")], $"{ctx} then", at + "/then");
            var elseTails = Segment(so["else"]?.AsArray() ?? new JsonArray(), [(node, "FalseTarget")], $"{ctx} else", at + "/else");
            return [.. thenTails, .. elseTails];
        }

        private List<(string, string?)> ForEach(JsonObject so, List<(string, string?)> tails, string ctx, string at)
        {
            var node = Node("IForEachNode", so["as"]?.GetValue<string>() ?? Next("ForEach"), label: true);
            BodySet(node, "RecordList", Req(so, "foreach", ctx));
            if (so["start"] != null) BodySet(node, "StartIndex", so["start"]!.ToString());
            if (so["max"] != null) BodySet(node, "MaximumIterations", so["max"]!.ToString());
            LinkAll(tails, node);
            var body = so["do"]?.AsArray() ?? throw new InvalidOperationException($"logic: {ctx}: foreach exige 'do' com os passos do ciclo");
            if (body.Count == 0) throw new InvalidOperationException($"logic: {ctx}: foreach com 'do' vazio");
            var scope = new ControlScope(isLoop: true, canBreak: false); _scopes.Push(scope);
            var bodyTails = Segment(body, [(node, "CycleTarget")], $"{ctx} do", at + "/do");
            _scopes.Pop();
            LinkAll([.. bodyTails, .. scope.Continues], node);
            return [(node, null), .. scope.Breaks];
        }

        private List<(string, string?)> While(JsonObject so, List<(string, string?)> tails, string ctx, string at)
        {
            if (so.ContainsKey("next") && so["next"] is not JsonArray) throw new ArgumentException("while next requires an array of steps");
            var node = Node("IIfNode", so["as"]?.GetValue<string>() ?? Next("While"), true);
            BodySet(node, "Condition", Req(so, "while", ctx)); LinkAll(tails, node);
            if (so["label"] != null || so["as"] == null) _ops.Add(Set(node, "Label", DecisionLabel(so["label"]?.GetValue<string>() ?? Req(so, "while", ctx))));
            var body = so["do"]?.AsArray() ?? throw new ArgumentException("while requires do");
            var scope = new ControlScope(isLoop: true); _scopes.Push(scope);
            var bodyTails = Segment(body, [(node, "TrueTarget")], ctx + " do", at + "/do"); _scopes.Pop();
            var updateTails = new List<(string, string?)>([.. bodyTails, .. scope.Continues]);
            if (so["next"] is JsonArray { Count: > 0 } update)
                updateTails = Segment(update, updateTails, ctx + " update", at + "/next");
            LinkAll(updateTails, node);
            return [(node, "FalseTarget"), .. scope.Breaks];
        }

        private List<(string, string?)> Transfer(JsonObject step, string kind, List<(string, string?)> tails, string ctx)
        {
            if (step[kind] is not JsonValue value || !value.TryGetValue<bool>(out var flag) || !flag)
                throw new ArgumentException(kind + " requires true at " + ctx);
            if (kind == "return") LinkAll(tails, Node("IEndNode", Next("Return"), false));
            else
            {
                var scope = kind == "break" ? _scopes.FirstOrDefault() : _scopes.FirstOrDefault(s => s.IsLoop);
                if (scope == null) throw new ArgumentException(kind + " requires an enclosing " + (kind == "break" ? "loop or switch" : "loop") + " at " + ctx);
                if (kind == "break" && !scope.CanBreak)
                    throw new ArgumentException("Native ForEach cannot share an exit with its cycle; lower a breakable enumeration to an indexed while loop at " + ctx);
                (kind == "break" ? scope.Breaks : scope.Continues).AddRange(tails);
            }
            return [];
        }

        private List<(string, string?)> Switch(JsonObject so, List<(string, string?)> tails, string ctx, string at)
        {
            var node = Node("ISwitchNode", so["as"]?.ToString() ?? Next("Switch"), true); LinkAll(tails, node);
            var cases = so["switch"]?.AsArray() ?? throw new ArgumentException("switch requires an array of cases");
            if (cases.Count == 0) throw new ArgumentException("switch requires at least one case");
            var scope = new ControlScope(isLoop: false); _scopes.Push(scope);
            try
            {
                var order = new List<string>(); _switchConditions.Add(order);
                var result = new List<(string, string?)>();
                for (var index = 0; index < cases.Count; index++)
                {
                    var caseAt = $"{at}/switch/{index}";
                    try
                    {
                        var branch = cases[index] as JsonObject ?? throw new InvalidOperationException($"logic: {ctx}: switch case #{index + 1} is an object {{\"when\", \"steps\"}}");
                        Keys(branch, ["when", "steps"], "switch case");
                        var condition = node + ".case" + (index + 1);
                        order.Add(condition);
                        _ops.Add(Op("create", ("parent", node), ("type", "ISwitchCondition"), ("as", condition)));
                        BodySet(condition, "Value", Req(branch, "when", ctx));
                        result.AddRange(Segment(branch["steps"] as JsonArray ?? throw new FieldException($"logic: {ctx}: switch case needs steps (an array)", "steps"),
                            [(condition, null)], ctx + " case", caseAt + "/steps"));
                    }
                    catch (Exception ex) { Record(ex, caseAt); }
                }
                result.AddRange(Segment(so["otherwise"]?.AsArray() ?? new JsonArray(), [(node, "OtherwiseTarget")], ctx + " otherwise", at + "/otherwise"));
                result.AddRange(scope.Breaks);
                return result;
            }
            finally { _scopes.Pop(); }
        }
        private List<(string, string?)> Native(JsonObject so, List<(string, string?)> tails, string ctx)
        {
            if (so["node"]?.ToString() == "ICallAgentNode" && LogicOrder.ActionType(_a) != "IServerAction")
                throw new InvalidOperationException("logic: ICallAgentNode requires a server action; expose it through a service action that calls that server action");
            var shape = LogicNodes.Get(so); var values = LogicNodes.Values(so);
            // Includes type-dependent children, JavaScript declarations and Excel selections.
            using var constructionOrder = PreserveOrder("node");
            // A07: without 'as' the node takes the Studio's default name, its kind numbered (IDestinationNode -> Destination1,
            // IJSONSerializeNode -> JSONSerialize1), as a call or an assign does; 'as' still names it when outputs are read.
            var type = so["node"]!.ToString();
            var nodeName = so["as"] != null ? Req(so, "as", ctx) : type == "IMessageNode" ? Next(NativeStem(type)) : LabelAsName(so) ?? Next(NativeStem(type));
            var node = Node("OutSystems.Model.Logic.Nodes." + type, nodeName, type == "IMessageNode");
            foreach (var (key, value) in values) _ops.Add(new JsonObject { ["op"] = "set", ["target"] = node, ["prop"] = key, ["value"] = value!.DeepClone() });
            foreach (var (section, parameterType) in new[] { ("inputs", "IInputParameter"), ("outputs", "IOutputParameter") })
                foreach (var item in so[section]?.AsArray() ?? new JsonArray())
                {
                    var parameter = item!.AsObject(); Keys(parameter, ParamKeys, "JavaScript parameter");
                    if (parameter.ContainsKey("in")) throw new ArgumentException($"logic: {ctx}: JavaScript parameter '{parameter["name"]}': 'in' exists only on the parameters of a rest action");
                    var name = Req(parameter, "name", ctx); var alias = node + "." + name;
                    _ops.Add(Op("create", ("parent", node), ("type", parameterType), ("name", name), ("as", alias)));
                    _ops.Add(Set(alias, "DataType", Req(parameter, "type", ctx)));
                    if (parameter["default"] != null) _ops.Add(Set(alias, "DefaultValue", parameter["default"]!.ToString()));
                    if (parameter["description"] != null) _ops.Add(Set(alias, "Description", parameter["description"]!.ToString()));
                    if (parameter["mandatory"] != null) _ops.Add(Set(alias, "IsMandatory", parameter["mandatory"]!.GetValue<bool>()));
                }
            foreach (var argument in so["args"]?.AsObject() ?? new JsonObject()) _ops.Add(Set(node + "/arg:" + argument.Key, "Value", argument.Value!.GetValue<string>()));
            LinkAll(tails, node); return shape.Terminal ? [] : [(node, null)];
        }

        private List<(string, string?)> Raise(JsonObject so, List<(string, string?)> tails, string ctx)
        {
            var exc = Req(so, "raise", ctx);
            var reference = exc.Contains(':') ? exc
                : _tryRef([$"IUserException:{exc}", $"IUserExceptionSignature:{exc}"])
                  ?? throw new InvalidOperationException($"logic: {ctx}: exception '{exc}' nao existe (crie-a com IUserException no @espace, ou na spec de dados)");
            var node = Node("IRaiseExceptionNode", LabelAsName(so) ?? Next("Raise" + exc, numberFirst: false), label: false);
            _ops.Add(Set(node, "Exception", reference));
            BodySet(node, "ExceptionMessage", so["message"]?.GetValue<string>() ?? Quote(exc));
            LinkAll(tails, node);
            return [];
        }

        private static string DecisionLabel(string condition) => condition.Trim();

        /// <summary>A repeated node name is numbered as the Studio numbers a copy (End, End2), never refused; the given name is a
        /// note (LOGIC_NODE_RENAMED) that LogicLint returns with the step's pointer.</summary>
        private string Node(string type, string name, bool label)
        {
            if (_nodeNames.Contains(name))
            {
                var given = Numbered(name, _nodeNames.Contains);
                _notes?.Add(new(_stepPointer ?? _pointer, "LOGIC_NODE_RENAMED",
                    $"logic: action {_name}: the node name '{name}' is already used in this action; this node is named '{given}', as the Studio names a copy",
                    $"give the step a unique \"as\" to choose the name (outputs read <as>.<Output>)"));
                name = given;
            }
            _nodeNames.Add(name);
            var alias = $"{_alias}.{name}";
            _ops.Add(Op("create", ("parent", _alias), ("type", type), ("name", name), ("as", alias)));
            if (label) _ops.Add(Set(alias, "Label", _stepLabel ?? name));
            return alias;
        }

        private void LinkAll(List<(string Node, string? Connector)> tails, string to)
        {
            foreach (var (from, connector) in tails)
            {
                var op = Op("link", ("from", from), ("to", to));
                if (connector != null) op["connector"] = connector;
                _ops.Add(op);
            }
        }
    }

    /// <summary>C18 (atritos 3): the local each save/create/update step with `record` given as fields ({Field: expression})
    /// fills: &lt;Entity&gt;Record, numbered (&lt;Entity&gt;Record2, ...) past the action's inputs, outputs, vars and the earlier
    /// ones, in document order (steps, then handlers). The compiler and the module-specification proof read the same names.</summary>
    internal static Dictionary<JsonObject, (string Variable, string Entity)> RecordVariables(JsonObject action)
    {
        var result = new Dictionary<JsonObject, (string, string)>(ReferenceEqualityComparer.Instance);
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var section in new[] { "inputs", "outputs", "vars" })
            foreach (var parameter in action[section] as JsonArray ?? new JsonArray())
                if (parameter?["name"] is JsonValue n && n.TryGetValue<string>(out var name)) taken.Add(name);
        void Visit(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject step:
                    if (step["record"] is JsonObject && new[] { "save", "create", "update" }.FirstOrDefault(step.ContainsKey) is { } verb
                        && step[verb] is JsonValue e && e.TryGetValue<string>(out var entity))
                    {
                        var variable = entity + "Record";
                        for (var i = 2; taken.Contains(variable); i++) variable = entity + "Record" + i;
                        taken.Add(variable);
                        result[step] = (variable, entity);
                    }
                    foreach (var (key, child) in step) if (key is "then" or "else" or "do" or "next" or "otherwise" or "switch" or "steps") Visit(child);
                    break;
                case JsonArray list: foreach (var child in list) Visit(child); break;
            }
        }
        Visit(action["steps"]);
        Visit(action["handlers"]);
        return result;
    }

    /// <summary>C18 (atritos 3): the join kind as the Studio shows it or as SQL says it, any case: Only With and Inner are
    /// Inner, With or Without and Left are Left, With and Full are Full; None and Right as they are. Null otherwise.</summary>
    internal static string? JoinKind(string text)
        => AggregateSortRule.JoinKindOf(text);

    /// <summary>The join as written in the model: a Right join, the only join of an aggregate of two sources, is the Left join
    /// with its sources swapped (Swapped); the other kinds as they are. Null for a kind JoinKind does not know.</summary>
    internal static (string Kind, bool Swapped)? NativeJoin(string kind, int joins, int sources)
        => JoinKind(kind) is not { } known ? null : known == "Right" && joins == 1 && sources == 2 ? ("Left", true) : (known, false);

    /// <summary>C18: the sources of an aggregate as the Studio names them: the same entity again is a self-join, named
    /// &lt;Entity&gt;2, &lt;Entity&gt;3 (name, entity), in order.</summary>
    internal static List<(string Name, string Entity)> SourceNames(IEnumerable<string> sources)
    {
        var names = new List<(string, string)>(); var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var source in sources)
        {
            var name = source;
            for (var n = 2; taken.Contains(name); n++) name = source + n;
            taken.Add(name); names.Add((name, source));
        }
        return names;
    }

    private static List<string> Many(JsonNode? n) => n switch
    {
        null => [],
        JsonArray a => a.Select(x => x!.GetValue<string>()).ToList(),
        _ => [n.GetValue<string>()],
    };

    private static void Keys(JsonObject o, string[] allowed, string ctx)
    {
        var bad = o.Select(kv => kv.Key).Where(k => !allowed.Contains(k, StringComparer.Ordinal)).ToList();
        if (bad.Count > 0)
            throw new FieldException($"logic: {ctx}: chave(s) desconhecida(s) {string.Join(", ", bad.Select(b => "'" + b + "'"))}; permitidas: {string.Join(", ", allowed)}", bad[0]);
    }

    private static string Req(JsonObject o, string k, string ctx) =>
        o[k] is JsonValue v && v.TryGetValue<string>(out var text) ? text : throw new FieldException($"logic: {ctx}: '{k}' e obrigatorio (texto)", k);

    private static JsonObject Op(string op, params (string Key, object Value)[] fields)
    {
        var o = new JsonObject { ["op"] = op };
        foreach (var (k, v) in fields) o[k] = v is JsonNode jn ? jn : V(v);
        return o;
    }

    private static JsonObject Set(string target, string prop, object value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = V(value) };
    private static JsonNode V(object v) => v switch { string s => JsonValue.Create(s)!, bool b => JsonValue.Create(b), int i => JsonValue.Create(i), _ => JsonValue.Create(v.ToString())! };
    private static string Quote(string s) => "\"" + s.Replace("\"", "\"\"") + "\"";
}

/// <summary>Compiler-internal call binding; never a source-authored identity or dependency catalog.</summary>
internal sealed record LogicCallCandidate(string Reference, bool IsImplicitLocal = false);

internal sealed record LogicCallTarget(string Reference, string Kind, string? Owner = null)
{
    public bool IsClient => Kind is "IClientAction" or "IClientActionSignature" or LogicOrder.MobileScreenAction;
}

public sealed partial class ModelSession
{
    // The same Resolve used by verbs establishes the actual signature; kind/owner never come from path text.
    internal LogicCallTarget? ResolveLogicCall(LogicCallCandidate candidate, JsonObject caller)
    {
        object resolved;
        try { resolved = Resolve(candidate.Reference); }
        catch (KeyNotFoundException) { return null; }
        // A bare action name searches the local action namespace before module actions.
        // Variables/widgets share the owner but are not candidates in that namespace.
        // Explicit owner/child references never receive this fallback.
        var mobileScreen = Implements(resolved, LogicOrder.MobileScreenAction);
        var webScreen = Implements(resolved, LogicOrder.WebScreenAction);
        if (candidate.IsImplicitLocal && !mobileScreen && !webScreen) return null;
        var signature = resolved as IObjectSignature;
        if (signature == null || signature.ObjectKey == null)
            throw new InvalidOperationException("logic: call target is not a native action: " + candidate.Reference);
        if (Implements(resolved, "IDataAction") || Implements(resolved, "IPreparation"))
            throw new InvalidOperationException("logic: 'call' cannot invoke a data action or preparation: " + candidate.Reference);
        string kind;
        if (mobileScreen) kind = LogicOrder.MobileScreenAction;
        else if (webScreen) kind = LogicOrder.WebScreenAction;
        else if (Implements(resolved, "IClientAction") || Implements(resolved, "IClientActionSignature")) kind = "IClientAction";
        else if (Implements(resolved, "IServiceAction") || Implements(resolved, "IServiceActionSignature")) kind = "IServiceAction";
        else if (Implements(resolved, "IActionSignature")) kind = "IServerAction";
        else throw new InvalidOperationException("logic: call target is not a native action signature: " + candidate.Reference);
        string? owner = null;
        if (mobileScreen || webScreen)
        {
            owner = LogicOrder.Owner(caller);
            var callerOwner = Resolve(owner) as IObjectSignature;
            if (callerOwner?.ObjectKey == null || signature.Parent is not IObjectSignature { ObjectKey: not null } signatureOwner
                || !callerOwner.ObjectKey.Equals(signatureOwner.ObjectKey))
                throw new InvalidOperationException("logic: screen action '" + candidate.Reference + "' can only be called from its own screen/block owner");
        }
        var target = new LogicCallTarget("@" + signature.ObjectKey, kind, owner);
        LogicOrder.ValidateCall(caller, target);
        // Native identifier/exposure changes can synthesize entity actions after the
        // identity index was built. Preserve the exact signature just resolved and
        // validated; never initialize a partial index or rebind the call by name.
        if (_byKey != null) _byKey[signature.ObjectKey.ToString()!] = signature;
        return target;
    }
}
