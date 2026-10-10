using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>The job was refused before anything was loaded or applied, with every problem at once (I2). Code is always
/// PREFLIGHT_REFUSED; the CLI envelope (Errors.Envelope) carries Code and Problems next to the error text.</summary>
public sealed class JobPreflightException : InvalidOperationException, ICodedError
{
    public const string PreflightRefused = "PREFLIGHT_REFUSED";
    public string Code => PreflightRefused;
    public JsonArray Problems { get; }
    public JsonArray Warnings { get; }
    JsonArray? ICodedError.Problems => Problems;
    public JobPreflightException(string message, JsonArray problems, JsonArray? warnings = null) : base(message)
    {
        Problems = problems; Warnings = warnings ?? new JsonArray();
    }

    /// <summary>The refusal of the apply (A02 item 6): <paramref name="inner"/> is the first failure, so the error text keeps
    /// the type of its root (Errors.Describe) and the code of the refusal is still PREFLIGHT_REFUSED.</summary>
    public JobPreflightException(string message, JsonArray problems, JsonArray? warnings, Exception? inner) : base(message, inner)
    {
        Problems = problems; Warnings = warnings ?? new JsonArray();
    }

    /// <summary>The exception for a list of problems (I2): the message is their text form, one per line, unless the caller
    /// gives the lines (refusals whose wording other tools already read).</summary>
    public static JobPreflightException Of(IReadOnlyList<JsonObject> problems, IReadOnlyList<string>? lines = null)
        => new(string.Join(Environment.NewLine, lines ?? problems.Select(JobPreflight.Text).ToList()),
            new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));

    /// <summary>Whether the Verify of the candidate ran before this refusal (primeira-certa A2): true when the union of the
    /// phases includes the Verify's errors; false with <see cref="VerifyReason"/> when it could not run (only the job was
    /// read, or the base could not be loaded), so the refusal never passes for complete. Null: not said (other refusals).</summary>
    public bool? VerifyRan { get; set; }
    public string? VerifyReason { get; set; }
    /// <summary>The phases whose problems this refusal carries, in order (preflight, base, apply, verify).</summary>
    public IReadOnlyList<string>? Phases { get; set; }
}

/// <summary>Cheap syntax and implementation inventory, before loading a fixture or building dependencies. Every problem of
/// every op comes back in one answer: `problems` and `warnings` structured (I2: op, pointer, code, severity, message, fix,
/// patch), `errors` as text (`op #i (kind) [CODE]: message Fix: fix`). Rules in the namespace Anvil.Core.PreflightRules
/// are discovered by reflection (I1) and run here; a rule that throws becomes a warning, never a refusal. Warnings never
/// block (the Studio would accept the module): List.Current without an empty guard, a Date compared with a Date Time, an
/// ODC Count (Long Integer) assigned to an Integer (LogicLint).</summary>
public static class JobPreflight
{
    public static JsonObject Check(string path)
    {
        var clock = Stopwatch.StartNew();
        var job = JobDocument.Parse(path);
        // N3: the problems of expectedMessages are collected with the others (Analyze with the job's path).
        var ops = JobRunner.CollectOps(job, Path.GetDirectoryName(Path.GetFullPath(path))!);
        var result = Analyze(ops, job, null, path);
        // primeira-certa A2: check-job reads the job only; it never passes for the complete verdict.
        result["verifyRan"] = false;
        result["verifyReason"] = OnlyTheJob;
        result["elapsedMs"] = clock.ElapsedMilliseconds;
        return result;
    }

    /// <summary>Why a refusal of the job alone is not complete: what did not run, and the command that runs it all.</summary>
    public const string OnlyTheJob = "only the job was read (no base loaded): the base check, the apply and the Verify did not run; "
        + "`apply --job <job> --base <oml> --out <oml>` runs every phase and refuses once with all of them";

    public static void Validate(JsonArray ops)
    {
        RequireValid(Analyze(ops));
    }

    public static void RequireValid(JsonObject result, string? verifyReason = null)
    {
        if (result["errors"]!.AsArray().Count > 0)
            throw new JobPreflightException(string.Join(Environment.NewLine, result["errors"]!.AsArray().Select(e => e!.ToString())),
                result["problems"]?.DeepClone().AsArray() ?? new JsonArray(), result["warnings"]?.DeepClone().AsArray())
            { VerifyRan = false, VerifyReason = verifyReason ?? OnlyTheJob, Phases = ["preflight"] };
    }

    /// <summary>Without the job document the pointers assume the usual {"ops":[...]} shape.</summary>
    public static JsonObject Analyze(JsonArray ops) => Analyze(ops, (JsonNode?)null);

    /// <summary>The JSON Pointer prefix of the ops inside the job document: "" for an array job, "/ops" for {ops:[...]},
    /// null for a composite {jobs:[...]} (its indices span the parts: no pointer is exact).</summary>
    public static string? OpsPointer(JsonNode? job) => job switch
    {
        JsonArray => "",
        JsonObject o when o["jobs"] is JsonArray => null,
        _ => "/ops",
    };

    /// <summary><paramref name="job"/>: the document the ops came from (gives the pointers); <paramref name="rules"/>: the
    /// rule types to run (tests pass their own), null discovers them (I1); <paramref name="jobPath"/>: the job's file, given
    /// by Check and JobRunner, whose expectedMessages are judged here with every other problem (N3, EXPECTED_MESSAGES_INVALID).</summary>
    public static JsonObject Analyze(JsonArray ops, JsonNode? job, IReadOnlyList<Type>? rules = null, string? jobPath = null)
    {
        var prefix = OpsPointer(job);
        var problems = new List<JsonObject>();
        var warnings = new List<JsonObject>();
        var notes = new JsonArray();
        var expansions = new List<Preflight.Expansion>();
        string? Pointer(int op, string? rest = null) => prefix == null ? null : prefix + "/" + op + (rest ?? "");
        void Error(int? op, string kind, string code, string message, string? fix = null, string? pointer = null, JsonArray? patch = null)
            => problems.Add(Problem(op, pointer ?? (op is { } i ? Pointer(i) : null), code, "error", message, fix ?? FixFrom(message) ?? DefaultFix(kind), patch, kind));
        // A coded refusal (I4) becomes its own problems, rebased onto the job; anything else one generic problem, which a
        // more specific problem of the same op under its pointer replaces at the end (A02 item 1).
        void Refused(Exception ex, int op, string kind, string code, string? basePointer, string? swapFrom = null, string? swapTo = null)
        {
            if (Preflight.CodedProblems.From(ex, op, kind, basePointer, swapFrom, swapTo) is { } coded)
            {
                foreach (var p in coded) (p["severity"]?.ToString() == "warning" ? warnings : problems).Add(p);
                return;
            }
            // C24: a raw System.Text.Json cast ("The node must be of type ...") never reaches an answer: the shape it broke.
            if (JobDocument.IsShapeError(ex) && ops[op] is JsonObject source)
            {
                var shapes = JobDocument.OpShape(source, Pointer(op));
                if (shapes.Count == 0) shapes.Add(new(swapTo ?? basePointer ?? Pointer(op), $"a value of this {kind} op has the wrong JSON type ({JobDocument.Describe(ex)})",
                    $"write the op as `api --op {(kind.Length > 0 ? kind : "verbs")}` describes it"));
                foreach (var shape in shapes) problems.Add(Problem(op, shape.Pointer, JobDocument.ShapeCode, "error", shape.Message, shape.Fix, shape.Patch, kind));
                return;
            }
            var generic = Problem(op, swapTo ?? basePointer, code, "error", Errors.Text(ex), FixFrom(Errors.Text(ex)) ?? DefaultFix(kind), null, kind);
            generic["_generic"] = true;
            problems.Add(generic);
        }
        // N3: the expectation contract of the job is judged with everything else, never before it and alone.
        if (jobPath != null && job != null)
        {
            var expectations = MessageExpectations.Inspect(job, jobPath);
            foreach (var p in expectations.Problems)
                problems.Add(Problem(null, p.Pointer, "EXPECTED_MESSAGES_INVALID", "error", p.Message, p.Fix, null, "expectedMessages"));
            foreach (var note in expectations.Notes) notes.Add(note.DeepClone());
        }
        var actions = new List<JsonObject>();
        // Actions are keyed by (owner, name): the same screen action name in two screens is legal (I5).
        var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var broken = new HashSet<int>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) { Error(i, "op", "OP_NOT_OBJECT", "expected an object {\"op\":\"<verb>\", ...}", "write the op as an object; verbs: " + string.Join(", ", VerbSurface.Names)); continue; }
            var kind = op["op"]?.ToString() ?? "";
            var code = (kind.Length == 0 ? "OP" : Regex.Replace(kind, "[^A-Za-z0-9]", "_").ToUpperInvariant()) + "_INVALID";
            // C24: a field of the wrong JSON type (an object where text is expected, an array where an object is) is a
            // JSON_SHAPE problem with its pointer and the shape expected; the op is not compiled (it would only throw the raw cast).
            if (JobDocument.OpShape(op, Pointer(i)) is { Count: > 0 } wrong)
            {
                foreach (var shape in wrong) problems.Add(Problem(i, shape.Pointer, JobDocument.ShapeCode, "error", shape.Message, shape.Fix, shape.Patch, kind));
                broken.Add(i);
                continue;
            }
            // Raw refactoring can remove/rename declarations through aliases or keys. Let the model resolve those.
            if (kind is "delete" or "rename") declared.Clear();
            try
            {
                if (kind == "agent")
                {
                    try { AgentExpander.Expand(op["data"]?.AsObject() ?? throw new InvalidOperationException("agent: data is required")); }
                    catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i, "/data")); }
                }
                if (kind == "spec")
                {
                    try { expansions.Add(new(i, null, SpecExpander.Expand(op["data"]!.AsObject()))); }
                    catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i, "/data")); }
                }
                if (kind == "html")
                {
                    // The fragment form (HtmlVisual.cs): inline html or the file it names, both parsed against the closed syntax.
                    // I4: PreflightOp answers relative to the op, Preflight relative to op.data.
                    if (op["parent"] != null)
                    {
                        try { HtmlVisual.PreflightOp(op); }
                        catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i)); }
                    }
                    else if (op["data"]?["components"] is JsonValue source)
                    {
                        try { HtmlComponents.Compile(source.GetValue<string>()); }
                        catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i)); }
                    }
                    else
                    {
                        try { HtmlExpander.Preflight(op["data"]?.AsObject() ?? throw new InvalidOperationException("html: 'data' is required")); }
                        catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i, "/data")); }
                    }
                }
                if (kind == "logic")
                {
                    var data = op["data"]!.AsObject();
                    // Validate the root, order and cycles once; validate individual bodies to report all errors.
                    if (data.Any(p => p.Key != "actions"))
                    {
                        try { expansions.Add(new(i, null, LogicExpander.Expand(data))); }
                        catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i, "/data")); }
                        continue;
                    }
                    var all = data["actions"]!.AsArray();
                    IReadOnlyList<JsonObject> ordered;
                    // A sort that refuses (a name repeated in two owners, a malformed action) leaves the declaration order:
                    // each action is still checked on its own, and its expansion names the fault.
                    try { ordered = LogicOrder.Sort(all); }
                    catch { ordered = all.OfType<JsonObject>().ToList(); }
                    foreach (var action in ordered)
                    {
                        actions.Add(action);
                        var name = action["name"]?.ToString() ?? "";
                        var index = all.IndexOf(action);
                        var at = index >= 0 ? Pointer(i, "/data/actions/" + index) : Pointer(i);
                        var owner = Preflight.JobFacts.Owner(action);
                        if (name.Length > 0 && !declared.Add(owner + "\u0001" + name) && action["replace"]?.GetValue<bool>() != true)
                            Error(i, kind, "LOGIC_DUPLICATE_ACTION", $"action '{name}' is declared more than once" + (owner == "@espace" ? "" : $" in {owner}") + "; use one definition or explicit replace",
                                "keep one declaration of '" + name + "', or add \"replace\": true to rewrite it", at);
                        try { expansions.Add(new(i, index >= 0 ? index : null, LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(action.DeepClone()) }))); }
                        catch (Exception ex) { Refused(ex, i, kind, "LOGIC_INVALID", Pointer(i, "/data"), "/actions/0", at); }
                    }
                }
            }
            catch (Exception ex) { Refused(ex, i, kind, code, Pointer(i)); }
        }
        // The other checks read the sound ops only: an op with a JSON_SHAPE problem is a null there (indices kept).
        var whole = ops;
        if (broken.Count > 0)
        {
            ops = new JsonArray(whole.Select((o, n) => broken.Contains(n) ? null : o?.DeepClone()).ToArray());
        }
        var dataChecks = DataPreflight.Analyze(ops);
        foreach (var error in dataChecks["errors"]!.AsArray()) Legacy(error!.ToString(), "data", "DATA_INVALID");
        var sqlChecks = SqlPreflight.Analyze(ops);
        foreach (var error in sqlChecks["errors"]!.AsArray()) Legacy(error!.ToString(), "sql", "SQL_INVALID");
        foreach (var p in LiteralDefaults(ops, prefix)) (p["severity"]?.ToString() == "warning" ? warnings : problems).Add(p);
        foreach (var p in SpecValueLimits(ops, prefix)) problems.Add(p);
        foreach (var p in PublicSignatures(ops, prefix)) problems.Add(p);
        foreach (var w in LogicLint.Check(ops, MessageExpectations.Lane, prefix)) warnings.Add(w);
        // A02/A04: enums, writable properties, names, call arguments and expressions, all at once (Kernel/Preflight). A job
        // that expects an invalid module asks the Verify for that verdict: the rules that predict it do not run.
        var expectsValid = !(job is JsonObject document && document["expectValid"] is JsonValue ev && ev.TryGetValue<bool>(out var valid) && !valid);
        var checks = Preflight.PreflightChecks.Pure(ops, prefix, MessageExpectations.Lane, expansions, verifyRules: expectsValid);
        problems.AddRange(checks.Problems); warnings.AddRange(checks.Warnings);
        RunRules(ops, rules ?? DiscoveredRules, problems, warnings, prefix);
        // A generic problem (the one-line form of an uncoded refusal) whose pointer is a prefix of a more specific problem a
        // rule reports for the same op says the same thing less precisely. The independent checks (defaults, signatures, the
        // A02/A04 rules) never replace it: they judge another fault, and hiding the generic one would cost a round.
        problems.RemoveAll(p => p["_generic"] is JsonValue && p["pointer"]?.ToString() is { } at && problems.Any(q => !ReferenceEquals(p, q) && q["_rule"] is JsonValue
            && q["op"]?.GetValue<int>() == p["op"]?.GetValue<int>() && q["pointer"]?.ToString() is { } deeper && deeper.StartsWith(at + "/", StringComparison.Ordinal)));
        bool AlwaysRaises(JsonObject a) => a["steps"] is JsonArray { Count: > 0 } steps && steps[^1] is JsonObject last && last.ContainsKey("raise");
        var identical = actions.GroupBy(a => Canonical(new JsonObject(a.Where(p => p.Key is not ("name" or "description" or "public" or "replace"))
                .Select(p => KeyValuePair.Create(p.Key, p.Value?.DeepClone())))))
            .Where(g => g.Count() > 1).Select(g => (JsonNode)new JsonObject
            {
                ["names"] = new JsonArray(g.Select(a => (JsonNode)a["name"]!.ToString()).ToArray()),
                ["alwaysRaises"] = g.All(AlwaysRaises),
                ["note"] = "Same declared contract and body; distinct API intent may be legitimate. Do not delete without checking callers."
            }).ToArray();
        // Stable order: by op (problems without an op last), then as found.
        var sorted = problems.Select((p, n) => (p, n)).OrderBy(x => x.p["op"]?.GetValue<int>() ?? int.MaxValue).ThenBy(x => x.n).Select(x => x.p).ToList();
        // primeira-certa A2: every problem says its phase; these are the job's own (no base, no model).
        foreach (var p in sorted) p["phase"] ??= "preflight";
        var errors = new JsonArray(sorted.Select(p => (JsonNode)Text(p)).ToArray());
        return new JsonObject
        {
            ["valid"] = errors.Count == 0, ["errors"] = errors, ["ops"] = ops.Count,
            ["problems"] = new JsonArray(sorted.Select(p => (JsonNode)PublicProblem(p)).ToArray()),
            ["warnings"] = new JsonArray(warnings.Select(p => (JsonNode)PublicProblem(p)).ToArray()),
            // What the kernel did or could not check that the author did not write (VERIFY_IDS_UNCHECKED, ...): {code, message}.
            ["notes"] = notes,
            ["unresolvedTypes"] = dataChecks["unresolvedTypes"]!.DeepClone(),
            ["unresolvedSql"] = sqlChecks["unresolved"]!.DeepClone(),
            ["sqlStatements"] = sqlChecks["sqlStatements"]!.DeepClone(),
            ["actions"] = actions.Count, ["publicActions"] = actions.Count(a => a["public"]?.GetValue<bool>() == true),
            ["helpers"] = actions.Count(a => a["public"]?.GetValue<bool>() != true),
            ["alwaysRaises"] = new JsonArray(actions.Where(AlwaysRaises).Select(a => (JsonNode)a["name"]!.ToString()).ToArray()),
            ["identicalImplementations"] = new JsonArray(identical),
            ["scope"] = "Validates syntax (fragment files included), declared data type order, known enums and lengths, literal defaults, the types public actions expose, and the SQL the job carries (lexical balance, {Entity}.[Attribute] and @parameters against the job, type clashes, SQL Server rules in O11, PostgreSQL rules in ODC), plus the rules of Anvil.Core.PreflightRules; warnings (never blocking) for List.Current without an empty guard, Date compared with Date Time and, in ODC, Count assigned to Integer. Names and keys the job does not declare, unresolved types, unresolvedSql and unknown functions are checked against the base, all at once, before the first op; what only the database upgrade refuses (cascade paths and cycles on O11, columns per table) is checked on the effective model (base + job) at apply, before anything is saved; expressions and business correctness still require Verify and delivery assertions. Always-raising endpoints are not evidence of completed integrations."
        };

        // A data/sql check names its op and place in its own prefix ("op #i (SQL <where>, line n): ..."): that place stays the kind.
        void Legacy(string text, string kind, string code)
        {
            var m = OpPrefix.Match(text);
            var op = m.Success ? int.Parse(m.Groups[1].Value) : (int?)null;
            var place = m.Success && m.Groups[2].Success ? m.Groups[2].Value : kind;
            var message = m.Success ? text[m.Length..] : text;
            problems.Add(Problem(op, op is { } i ? Pointer(i) : null, code, "error", message, FixFrom(message) ?? DefaultFix(kind), null, place));
        }
    }

    // ---- problems (I2) ------------------------------------------------------------------------------------------------

    /// <summary>One problem as I2 describes it. `kind` stays internal (the text form names it).</summary>
    public static JsonObject Problem(int? op, string? pointer, string code, string severity, string message, string? fix, JsonArray? patch = null, string? kind = null)
    {
        var line = Regex.Replace(message ?? "", @"\s*[\r\n]+\s*", " ").Trim();
        var problem = new JsonObject
        {
            ["op"] = op, ["pointer"] = pointer, ["code"] = code, ["severity"] = severity, ["message"] = line,
            ["fix"] = fix == null ? null : Regex.Replace(fix, @"\s*[\r\n]+\s*", " ").Trim(), ["patch"] = patch,
        };
        if (kind != null) problem["_kind"] = kind;
        return problem;
    }

    /// <summary>`op #i (kind) [CODE]: message Fix: fix`, the text form of a problem.</summary>
    public static string Text(JsonObject p)
    {
        var op = p["op"]?.GetValue<int>();
        var kind = p["_kind"]?.ToString() ?? "op";
        var fix = p["fix"]?.ToString();
        return (op is { } i ? $"op #{i} ({kind}) [{p["code"]}]: " : $"[{p["code"]}]: ") + p["message"] + (string.IsNullOrEmpty(fix) ? "" : " Fix: " + fix);
    }

    /// <summary>The problem as it is published (I2): the internal kind is dropped.</summary>
    public static JsonObject PublicProblem(JsonObject p)
    {
        var copy = p.DeepClone().AsObject();
        copy.Remove("_kind"); copy.Remove("_generic"); copy.Remove("_rule");
        return copy;
    }

    private static readonly Regex OpPrefix = new(@"^\s*op #(\d+)(?: \(([^)]*)\))?[^:]*:\s*", RegexOptions.Compiled);

    /// <summary>The accepted syntax a refusal already names (allowed:, permitidas:, use ...), as the fix line.</summary>
    internal static string? FixFrom(string message)
    {
        foreach (var marker in new[] { "allowed: ", "permitidas: ", "accepted: ", "Accepted: " })
        {
            var at = message.LastIndexOf(marker, StringComparison.Ordinal);
            if (at >= 0) return "use one of: " + message[(at + marker.Length)..].Trim().TrimEnd('.');
        }
        foreach (var marker in new[] { "; use ", ". Use ", ": use ", "; Write it as ", ". Write it as " })
        {
            var at = message.IndexOf(marker, StringComparison.Ordinal);
            if (at >= 0) return message[(at + 2)..].Trim().TrimEnd('.');
        }
        return null;
    }

    internal static string DefaultFix(string kind) => kind switch
    {
        "logic" => "write the step in the logic grammar (`api --op logic`): one step kind per step, closed keys",
        "spec" => "write the data in the spec grammar (`api --op spec`)",
        "html" => "write the fragment in the closed syntax (`api --op html-visual`) or the page manifest (`api --op html`)",
        "sql" => "fix the statement as the message says; the SQL of the job is checked against the job and the base",
        "data" => "fix the value as the message says (`api --name <Type>` lists properties and enums)",
        _ => "write the op as `api --op verbs` describes it",
    };

    // ---- literal defaults ---------------------------------------------------------------------------------------------

    private static readonly Regex Number = new(@"^-?\d+(\.\d+)?$", RegexOptions.Compiled);
    private static readonly Regex BareWords = new(@"^[\p{L}_][\p{L}\p{N}_ ]*$", RegexOptions.Compiled);
    private static readonly HashSet<string> Keywords = new(StringComparer.OrdinalIgnoreCase)
        { "True", "False", "NullIdentifier", "NullTextIdentifier", "NullDate", "NullBinary", "NullObject" };

    /// <summary>A default the Studio would reject as written: text without quotes, a quoted or fractional integer, a boolean
    /// that is not True/False, a date without #. The fix is the literal as the Studio writes it, with the patch that writes it.</summary>
    public static IEnumerable<JsonObject> LiteralDefaults(JsonArray ops, string? prefix = "/ops")
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            IEnumerable<(JsonObject Owner, string Pointer)> owners = kind switch
            {
                "logic" => (op["data"]?["actions"] as JsonArray ?? new JsonArray()).Select((a, ai) => (a as JsonObject, ai))
                    .Where(x => x.Item1 != null)
                    .SelectMany(x => new[] { "inputs", "outputs", "vars" }.SelectMany(section => (x.Item1![section] as JsonArray ?? new JsonArray())
                        .Select((p, pi) => (p as JsonObject, $"/data/actions/{x.ai}/{section}/{pi}"))))
                    .Where(x => x.Item1 != null).Select(x => (x.Item1!, x.Item2)),
                "spec" => new[] { "entities", "clientEntities", "structures", "static" }.SelectMany(section => (op["data"]?[section] as JsonArray ?? new JsonArray())
                        .Select((e, ei) => (e as JsonObject, ei)).Where(x => x.Item1 != null)
                        .SelectMany(x => (x.Item1!["attributes"] as JsonArray ?? new JsonArray()).Select((a, ai) => (a as JsonObject, $"/data/{section}/{x.ei}/attributes/{ai}"))))
                    .Where(x => x.Item1 != null).Select(x => (x.Item1!, x.Item2)),
                _ => [],
            };
            foreach (var (owner, at) in owners)
            {
                if (owner["default"] is not JsonValue v || !v.TryGetValue<string>(out var value)) continue;
                var type = owner["type"]?.ToString() ?? "Text";
                if (LiteralFix(type, value) is not { } fixedValue) continue;
                var pointer = prefix == null ? null : $"{prefix}/{i}{at}/default";
                var patch = pointer == null ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = fixedValue });
                // C21 (atritos 3): a spec default is written as that literal (SpecExpander.Literal, reported in expressionRewrites):
                // a warning that says so, never a refusal. A logic parameter's default is still refused with the patch.
                if (kind == "spec")
                {
                    yield return Problem(i, pointer, "DEFAULT_LITERAL_REWRITTEN", "warning",
                        $"'{owner["name"]}' ({type}) default {value} is not a {type} literal: it is written as {fixedValue}", $"\"default\": \"{fixedValue.Replace("\"", "\\\"")}\"", patch, kind);
                    continue;
                }
                yield return Problem(i, pointer, "DEFAULT_LITERAL_INVALID", "error",
                    $"'{owner["name"]}' ({type}) default {value} is not a {type} literal: the Studio reads it as an expression and refuses it",
                    $"\"default\": \"{fixedValue.Replace("\"", "\\\"")}\"", patch, kind);
            }
        }
    }

    /// <summary>C21 (atritos 3): a text value of a static record longer than its attribute keeps (the Label of a static entity
    /// is Text 50; a declared Text attribute its length, 50 when not given) is refused before the first op with the exact fix
    /// (an O11 client migration: "Label > 50" 10 messages from the Verify after the build).</summary>
    public static IEnumerable<JsonObject> SpecValueLimits(JsonArray ops, string? prefix = "/ops")
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "spec" || op["data"]?["static"] is not JsonArray statics) continue;
            for (var s = 0; s < statics.Count; s++)
            {
                if (statics[s] is not JsonObject entity) continue;
                var lengths = new Dictionary<string, int>(StringComparer.Ordinal) { ["Label"] = 50 };
                foreach (var attribute in (entity["attributes"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    if (attribute["name"]?.ToString() is { } n && (attribute["type"]?.ToString() ?? "Text").Equals("Text", StringComparison.OrdinalIgnoreCase))
                        lengths[n] = attribute["length"] is JsonValue lv && lv.TryGetValue<int>(out var l) ? l : 50;
                var records = entity["records"] as JsonArray ?? new JsonArray();
                for (var r = 0; r < records.Count; r++)
                {
                    if (records[r] is not JsonObject record) continue;
                    foreach (var (field, length) in lengths)
                    {
                        var key = field == "Label" && !record.ContainsKey("Label") ? (record.ContainsKey("label") ? "label" : "name") : field;
                        if (record[key] is not JsonValue v || !v.TryGetValue<string>(out var text)) continue;
                        var literal = key is "label" or "name" ? text : Unquoted(SpecExpander.Literal("Text", v, ""));
                        if (literal.Length <= length) continue;
                        var pointer = prefix == null ? null : $"{prefix}/{i}/data/static/{s}/records/{r}/{key}";
                        yield return Problem(i, pointer, "SPEC_VALUE_TOO_LONG", "error",
                            $"static {entity["name"]} record '{record["name"]}': {field} has {literal.Length} characters and the attribute keeps {length}",
                            field == "Label" ? $"write a label of at most {length} characters" : $"write at most {length} characters, or declare {field} with \"length\": {literal.Length}",
                            pointer == null || key is "name" ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = literal[..length] }), "spec");
                    }
                }
            }
        }
        static string Unquoted(string literal) => literal.Length > 1 && literal.StartsWith('"') && literal.EndsWith('"') ? literal[1..^1].Replace("\"\"", "\"") : literal;
    }

    /// <summary>The literal the Studio accepts for an obviously wrong default, or null when the default is fine or is an
    /// expression this check cannot judge (a function, an attribute, a variable, Site.X, an operator).</summary>
    public static string? LiteralFix(string type, string value)
    {
        var v = value.Trim();
        if (v.Length == 0) return null;
        var t = type.Trim();
        if (t.EndsWith(" Identifier", StringComparison.OrdinalIgnoreCase) || t.EndsWith(" List", StringComparison.OrdinalIgnoreCase) || t.EndsWith(" Record", StringComparison.OrdinalIgnoreCase)) return null;
        switch (t.ToLowerInvariant())
        {
            case "text" or "long text" or "email" or "phone number":
                // A bare word is read as an identifier, and a default names no variable: the Studio refuses it unquoted.
                if (v.StartsWith('"') || Keywords.Contains(v) || Number.IsMatch(v)) return null;
                return BareWords.IsMatch(v) ? "\"" + v.Replace("\"", "\"\"") + "\"" : null;
            case "integer" or "long integer":
                if (v.Length > 1 && v.StartsWith('"') && v.EndsWith('"') && long.TryParse(v[1..^1], out var quoted)) return quoted.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (Regex.IsMatch(v, @"^-?\d+\.\d+$") && decimal.TryParse(v, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var fraction)) return decimal.Truncate(fraction).ToString(System.Globalization.CultureInfo.InvariantCulture);
                return null;
            case "decimal" or "currency":
                if (v.Length > 1 && v.StartsWith('"') && v.EndsWith('"') && Number.IsMatch(v[1..^1])) return v[1..^1];
                return null;
            case "boolean":
                if (v.Equals("yes", StringComparison.OrdinalIgnoreCase) || v == "1" || v.Equals("\"true\"", StringComparison.OrdinalIgnoreCase)) return "True";
                if (v.Equals("no", StringComparison.OrdinalIgnoreCase) || v == "0" || v.Equals("\"false\"", StringComparison.OrdinalIgnoreCase)) return "False";
                return null;
            case "date":
                return Regex.IsMatch(v, @"^""?\d{4}-\d{2}-\d{2}""?$") ? "#" + v.Trim('"') + "#" : null;
            case "date time" or "datetime":
                return Regex.IsMatch(v, @"^""?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?""?$") ? "#" + v.Trim('"').Replace('T', ' ') + (v.Trim('"').Length == 16 ? ":00" : "") + "#" : null;
            case "time":
                return Regex.IsMatch(v, @"^""?\d{2}:\d{2}(:\d{2})?""?$") ? "#" + v.Trim('"') + (v.Trim('"').Length == 5 ? ":00" : "") + "#" : null;
            default: return null;
        }
    }

    // ---- public signatures --------------------------------------------------------------------------------------------

    /// <summary>A public action of the job that exposes a type the same job declares without public: the Studio refuses the
    /// public signature. The fix proposes first the private option (the action private, or a public DTO structure), then the
    /// public type (A25: exposing a module's types is a decision, not the default); the patch still writes the public type.</summary>
    public static IEnumerable<JsonObject> PublicSignatures(JsonArray ops, string? prefix = "/ops")
    {
        var types = new Dictionary<string, (int Op, string Pointer, bool Public, string Section)>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && op["op"]?.ToString() == "spec")
                foreach (var section in new[] { "entities", "structures", "static" })
                    for (var j = 0; j < (op["data"]?[section] as JsonArray)?.Count; j++)
                        if (op["data"]![section]![j] is JsonObject type && type["name"]?.ToString() is { } name)
                            types[name] = (i, $"/{i}/data/{section}/{j}", type["public"] is JsonValue p && p.TryGetValue<bool>(out var isPublic) && isPublic, section);
        if (types.Count == 0) yield break;
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic") continue;
            var list = op["data"]?["actions"] as JsonArray ?? new JsonArray();
            for (var a = 0; a < list.Count; a++)
            {
                if (list[a] is not JsonObject action || !(action["public"] is JsonValue pv && pv.TryGetValue<bool>(out var actionPublic) && actionPublic)) continue;
                foreach (var section in new[] { "inputs", "outputs" })
                    foreach (var parameter in (action[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    {
                        var type = parameter["type"]?.ToString() ?? "";
                        foreach (var suffix in new[] { " List", " Record", " Identifier" })
                            while (type.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) type = type[..^suffix.Length].Trim();
                        if (!types.TryGetValue(type, out var declared) || declared.Public) continue;
                        var pointer = prefix == null ? null : prefix + declared.Pointer + "/public";
                        yield return Problem(i, prefix == null ? null : $"{prefix}/{i}/data/actions/{a}", "PUBLIC_SIGNATURE_PRIVATE_TYPE", "error",
                            $"public action '{action["name"]}' exposes {section[..^1]} '{parameter["name"]}' of type {parameter["type"]}, and {type} is declared in this job without \"public\": true",
                            $"make '{action["name"]}' private (drop \"public\": true) or expose a public DTO structure instead of {type}; or, if {type} itself must be shared, declare {type} with \"public\": true (op #{declared.Op})",
                            pointer == null ? null : new JsonArray(new JsonObject { ["op"] = "add", ["path"] = pointer, ["value"] = true }), "logic");
                    }
            }
        }
    }

    // ---- references checked against the base (JobRunner, before the first op) -----------------------------------------

    /// <summary>A reference an op makes to something it does not create: `Type:Name` (the root of a path) or `@key` without
    /// a path. Aliases, @espace, producer identities and names the job itself writes anywhere (it may create them: a spec, a
    /// logic action, an html widget, a rename) are left out, so what remains can only come from the base.</summary>
    public sealed record BaseReference(int Op, string Kind, string? Pointer, string Reference, string Type, string Name);

    private static readonly Regex TypedName = new(@"^(I[A-Za-z0-9_.]*|):([^/]+)", RegexOptions.Compiled);
    private static readonly Regex ReferenceToken = new(@"(?<![\w$@])I[A-Za-z0-9_.]*:[^/\s""',)\]]+", RegexOptions.Compiled);
    private static readonly Regex Word = new(@"[\p{L}_][\p{L}\p{N}_]*", RegexOptions.Compiled);
    private static readonly string[] ReferenceFields = ["target", "parent", "from", "to", "before", "after", "into"];

    public static List<BaseReference> BaseReferences(JsonArray ops, string? prefix = "/ops")
    {
        var found = new List<BaseReference>();
        // The job imports producers: their names are not the base's, the reference op decides them.
        if (ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "reference")) return found;
        var (words, whole) = JobWords(ops);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString() ?? "";
            var fields = ReferenceFields.Select(f => (Field: f, Value: op[f])).ToList();
            if (kind == "set" && op["value"] is JsonValue) fields.Add(("value", op["value"]));
            if (kind == "set" && op["value"] is JsonArray values)
                fields.AddRange(values.Select((v, n) => ("value/" + n, v)));
            foreach (var (field, node) in fields)
            {
                if (node is not JsonValue v || !v.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text)) continue;
                text = text.Trim();
                var pointer = prefix == null ? null : $"{prefix}/{i}/{field}";
                if (text.StartsWith('$') || text.StartsWith("@espace", StringComparison.Ordinal)) continue;
                if (text.StartsWith('@'))
                {
                    if (!text.Contains('/')) found.Add(new(i, kind, pointer, text, "@", text[1..]));
                    continue;
                }
                if (Typed(text, field) is not { } reference || reference.Name.StartsWith('@')) continue;
                // set values are references only when they are written as one (Type:Name); any other text is a literal.
                if (field.StartsWith("value", StringComparison.Ordinal) && reference.Type.Length == 0) continue;
                if (reference.Name.Length == 0 || PossiblyCreated(reference.Name, words, whole)) continue;
                found.Add(new(i, kind, pointer, reference.Typed, reference.Type, reference.Name));
            }
        }
        return found;
    }

    /// <summary>A reference by path, `Kind:Name/Child/...`, whose root and every child segment are names the job does not
    /// write (A02 item 5): the base check resolves the whole path, so a child the base does not have
    /// (`IServerEntity 'UserAccessScope' has no child 'IEntityIndex:AutoIndex_RoleId'`) is refused before the first op,
    /// with the others, instead of one per round at apply. Segments the job may create, or that the resolver reads by
    /// position (#Type[n], **Type), by argument (arg:, param:) or by a typed name, are left to the apply.</summary>
    public sealed record BasePath(int Op, string Kind, string? Pointer, string Reference, string Root, IReadOnlyList<string> Segments);

    // A child by name, or by a typed name (`IEntityIndex:X`), which the resolver never accepts as a segment.
    private static readonly Regex PlainSegment = new(@"^(?:I[A-Za-z0-9_]*:)?[\p{L}_][\p{L}\p{N}_ ]*$", RegexOptions.Compiled);

    public static List<BasePath> BasePaths(JsonArray ops, string? prefix = "/ops")
    {
        var found = new List<BasePath>();
        if (ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "reference")) return found;
        var (words, whole) = JobWords(ops);
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString() ?? "";
            foreach (var field in ReferenceFields)
            {
                if (op[field] is not JsonValue v || !v.TryGetValue<string>(out var text) || !text.Contains('/')) continue;
                text = text.Trim();
                if (text.StartsWith('$') || text.StartsWith('@') || text.StartsWith("IReference:", StringComparison.Ordinal)) continue;
                var slash = text.IndexOf('/');
                if (Typed(text[..slash], field) is not { } root || root.Type.Length == 0 || root.Name.StartsWith('@') || PossiblyCreated(root.Name, words, whole)) continue;
                var segments = text[(slash + 1)..].Split('/');
                if (segments.Length == 0 || segments.Any(s => !PlainSegment.IsMatch(s) || PossiblyCreated(s[(s.IndexOf(':') + 1)..].Trim(), words, whole))) continue;
                found.Add(new(i, kind, prefix == null ? null : $"{prefix}/{i}/{field}", root.Typed + "/" + string.Join("/", segments), root.Typed, segments));
            }
        }
        return found;
    }

    private static (HashSet<string> Words, HashSet<string> Whole) JobWords(JsonArray ops)
    {
        var words = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var whole = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var text in Strings(ops))
        {
            whole.Add(text.Trim());
            foreach (Match w in Word.Matches(ReferenceToken.Replace(text, " "))) words.Add(w.Value);
        }
        return (words, whole);
    }

    private static readonly Regex KindlessName = new(@"^([A-Za-z][A-Za-z0-9_]*):([^/]+)", RegexOptions.Compiled);

    /// <summary>The `Kind:Name` root a reference field writes: (the reference as the base check resolves it, the kind, the
    /// name). A27: in a reference field (target, parent, from, to, ...) the kind may omit the I of its interface
    /// (`ServerActionSignature:X`), and is completed; a set value keeps requiring the interface name, since any text may
    /// hold a colon. Null when the text is no typed reference.</summary>
    private static (string Typed, string Type, string Name)? Typed(string text, string field)
    {
        var m = TypedName.Match(text);
        if (m.Success) return (m.Value, m.Groups[1].Value, m.Groups[2].Value.Trim());
        if (field.StartsWith("value", StringComparison.Ordinal)) return null;
        var k = KindlessName.Match(text);
        if (!k.Success) return null;
        var kind = Preflight.KindNames.Normalize(k.Groups[1].Value);
        if (!Preflight.KindNames.LooksLikeInterface(kind)) return null;
        var name = k.Groups[2].Value.Trim();
        return (kind + ":" + name, kind, name);
    }

    private static readonly Regex SynthesizedPrefix = new(@"^(?:CreateOrUpdate|Create|Update|Delete|GetForUpdate|Get|Check|Grant|Revoke|AutoIndex_|Not\s+)", RegexOptions.Compiled);
    private static readonly Regex SynthesizedSuffix = new(@"(?:Role|Request|ResponseItem|Response|Item|Identifier|s|\d+)$", RegexOptions.Compiled);

    /// <summary>Whether the job may create the name itself: written anywhere in the job, every word of it written, or the
    /// name the platform derives from one the job writes (CreateX/UpdateX/DeleteX of entity X, "Not R" of role R, CheckRRole,
    /// XRequest/XResponse of method X, a name numbered by position).</summary>
    private static bool PossiblyCreated(string name, HashSet<string> words, HashSet<string> whole)
    {
        if (words.Contains(name) || whole.Contains(name)) return true;
        var parts = Word.Matches(name).Select(w => w.Value).ToArray();
        if (parts.Length > 1 && parts.All(words.Contains)) return true;
        var core = SynthesizedSuffix.Replace(SynthesizedPrefix.Replace(name, ""), "");
        if (core.Length >= 2 && core != name && (words.Contains(core) || whole.Contains(core))) return true;
        var bare = SynthesizedPrefix.Replace(name, "");
        return bare.Length >= 2 && bare != name && (words.Contains(bare) || whole.Contains(bare));
    }

    /// <summary>Every string of a JSON tree, except the values of reference fields of verb ops (those are what is checked).</summary>
    private static IEnumerable<string> Strings(JsonNode? node, string? key = null, bool verb = false)
    {
        switch (node)
        {
            case JsonValue v when v.TryGetValue<string>(out var s):
                if (!(verb && key != null && (ReferenceFields.Contains(key) || key == "value") && Typed(s.Trim(), key) != null)) yield return s;
                break;
            case JsonObject o:
                var isVerb = o["op"] is JsonValue;
                foreach (var (k, child) in o) foreach (var s in Strings(child, k, isVerb)) yield return s;
                break;
            case JsonArray a:
                foreach (var child in a) foreach (var s in Strings(child, key, verb)) yield return s;
                break;
        }
    }

    // ---- plug-in rules (I1) -------------------------------------------------------------------------------------------

    private static IReadOnlyList<Type>? _discovered;

    /// <summary>Static classes of the namespace Anvil.Core.PreflightRules in the kernel assembly with
    /// `public static IEnumerable&lt;JsonObject&gt; Check(JsonArray ops, string lane)`.</summary>
    public static IReadOnlyList<Type> DiscoveredRules => _discovered ??= RulesIn(typeof(JobPreflight).Assembly);

    /// <summary>The rules of an assembly by the I1 convention, in a stable order (by full name).</summary>
    public static IReadOnlyList<Type> RulesIn(Assembly assembly) => Types(assembly)
        .Where(IsRule)
        .OrderBy(t => t.FullName, StringComparer.Ordinal).ToArray();

    // A type whose metadata needs an assembly this lane does not load (an O11 model type in the ODC CLI, 2026-10-09) is not
    // a rule: reading its namespace throws, and that must never fail the preflight of every job.
    private static bool IsRule(Type t)
    {
        try { return t is { IsClass: true, IsAbstract: true, IsSealed: true } && t.Namespace == "Anvil.Core.PreflightRules" && RuleMethod(t) != null; }
        catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or TypeLoadException or BadImageFormatException) { return false; }
    }

    // check-job runs without the Studio assemblies bound: a type that cannot load is skipped, never a failure.
    private static IEnumerable<Type> Types(Assembly assembly)
    {
        try { return assembly.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { return ex.Types.OfType<Type>(); }
    }

    private static MethodInfo? RuleMethod(Type t)
    {
        var m = t.GetMethod("Check", BindingFlags.Public | BindingFlags.Static, [typeof(JsonArray), typeof(string)]);
        return m != null && typeof(IEnumerable<JsonObject>).IsAssignableFrom(m.ReturnType) ? m : null;
    }

    /// <summary><paramref name="prefix"/>: OpsPointer of the job. Rules see only the ops and write pointers for the usual
    /// {"ops":[...]} shape; they are rebased onto the real shape ("" for an array job) and dropped for a composite job.</summary>
    private static void RunRules(JsonArray ops, IReadOnlyList<Type> rules, List<JsonObject> problems, List<JsonObject> warnings, string? prefix)
    {
        var composite = prefix == null;
        string Rebase(string text) => prefix == "/ops" || !text.StartsWith("/ops/", StringComparison.Ordinal) ? text : prefix + text["/ops".Length..];
        // The RFC 6902 patch of a rule follows its pointer: rebased with it, dropped with it in a composite job.
        JsonArray? RebasePatch(JsonArray patch)
        {
            if (composite) return null;
            var copy = patch.DeepClone().AsArray();
            foreach (var step in copy.OfType<JsonObject>())
                foreach (var key in new[] { "path", "from" })
                    if (step[key] is JsonValue v && v.TryGetValue<string>(out var at)) step[key] = Rebase(at);
            return copy;
        }
        foreach (var rule in rules)
        {
            var method = RuleMethod(rule);
            if (method == null) continue;
            List<JsonObject> found;
            try
            {
                // The rule reads a copy: a rule that edits its input cannot change the job or another rule's view.
                found = ((IEnumerable<JsonObject>?)method.Invoke(null, [ops.DeepClone().AsArray(), MessageExpectations.Lane]) ?? []).ToList();
            }
            catch (Exception ex)
            {
                warnings.Add(Problem(null, null, "PREFLIGHT_RULE_FAILED", "warning", $"preflight rule {rule.Name} failed and was skipped: {Errors.Text(ex)}", null, null, "rule"));
                continue;
            }
            foreach (var raw in found)
            {
                if (raw == null) continue;
                var op = raw["op"] is JsonValue o && o.TryGetValue<int>(out var index) && index >= 0 && index < ops.Count ? index : (int?)null;
                var pointer = composite ? null : raw["pointer"] is JsonValue pv && pv.TryGetValue<string>(out var text) ? Rebase(text) : null;
                var severity = raw["severity"]?.ToString() == "warning" ? "warning" : "error";
                var problem = Problem(op, pointer, raw["code"]?.ToString() is { Length: > 0 } code ? code : "PREFLIGHT_RULE", severity, raw["message"]?.ToString() ?? rule.Name,
                    raw["fix"]?.ToString(), raw["patch"] is JsonArray patch ? RebasePatch(patch) : null, op is { } at && ops[at] is JsonObject source ? source["op"]?.ToString() : "rule");
                // A rule of SSAM that the platform itself would not refuse says so (section 1.6 of docs/INTEGRACOES-GITSSAM.md).
                if (raw["ssamRule"] is JsonValue ssam && ssam.TryGetValue<bool>(out var isSsamRule) && isSsamRule) problem["ssamRule"] = true;
                problem["_rule"] = true;
                // The same place reported by the generic checks and by a rule: the rule is the specific one and stays.
                if (op != null) { problems.RemoveAll(p => Same(p, problem)); warnings.RemoveAll(p => Same(p, problem)); }
                (severity == "warning" ? warnings : problems).Add(problem);
            }
        }
        static bool Same(JsonObject a, JsonObject b) => a["op"]?.GetValue<int>() == b["op"]?.GetValue<int>() && a["pointer"]?.ToString() == b["pointer"]?.ToString();
    }

    private static string Canonical(JsonNode? node) => node switch
    {
        JsonObject o => "{" + string.Join(",", o.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => System.Text.Json.JsonSerializer.Serialize(p.Key) + ":" + Canonical(p.Value))) + "}",
        JsonArray a => "[" + string.Join(",", a.Select(Canonical)) + "]",
        _ => node?.ToJsonString() ?? "null"
    };
}
