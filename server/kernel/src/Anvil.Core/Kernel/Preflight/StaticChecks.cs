using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// CX16 (2026-10-15): everything the documents, the module index, the producers' indexes and the UI catalogs decide, before
/// any Studio step and before the apply, in one pass: <see cref="DocumentNameRules"/> plus <see cref="PreflightChecks.WithModule"/>
/// and <see cref="PreflightChecks.WithBase"/> over <see cref="IndexBaseFacts"/> (for a job with a reference op too: the facts
/// know the names it imports). What the pure preflight already said (same op, pointer and code) is said once. Without a fresh
/// index every problem that rests on a name the index lacks is a warning; a warning never stops anything.
/// </summary>
public static class StaticChecks
{
    public sealed record Result(List<JsonObject> Problems, List<JsonObject> Warnings, JsonArray Checked, JsonArray Skipped);

    /// <param name="verifyRules">false for a job that expects an invalid module (expectValid false): the classes that predict
    /// a Verify error (S1-S7, L1-L3, WithModule, WithBase) do not run, as in JobPreflight and JobRunner (the job asks the Verify
    /// for that verdict); they are listed in skipped.</param>
    public static Result Run(JsonArray ops, string? prefix, string lane, StaticBasis basis, IEnumerable<JsonObject>? preflight = null, IReadOnlyList<DocumentNameRules.Rule>? more = null,
        bool verifyRules = true)
    {
        var facts = new IndexBaseFacts(basis, ops);
        var skipped = new List<JsonObject>();
        var found = new List<JsonObject>();
        if (!verifyRules) {
            // CX16 r2 (M1): the rule of PreflightChecks.Pure and JobRunner.CheckAgainstBase (checkFunctions: expectedValid).
            skipped.Add(new JsonObject { ["class"] = "S1-S7, L1-L3, WithModule, WithBase", ["reason"] = "the job expects an invalid module (expectValid false): the Verify gives that verdict, nothing that predicts it is judged here" });
            return new Result([], [], [], new JsonArray(skipped.Select(s => (JsonNode)s).ToArray()));
        }
        if (basis.Module == null)
            skipped.Add(new JsonObject { ["class"] = "module-index", ["reason"] = "no module index: what only the module answers is not judged; the names it would have are warnings" });
        else if (!basis.Fresh)
            skipped.Add(new JsonObject { ["class"] = "absence", ["reason"] = "the index is not proved to be the module the job is applied to: a name it lacks is a warning" });
        if (basis.UiCatalogs.Count == 0)
            skipped.Add(new JsonObject { ["class"] = "ui-catalog", ["reason"] = "no UI catalog given: the contract of a library block is not judged" });
        found.AddRange(DocumentNameRules.Check(ops, prefix, lane, facts, basis, skipped, more));
        var checkedClasses = new List<string> { "S1", "S2", "S3", "S4", "S5", "S5-reference", "S6", "S7", "L1-L3" };
        if (basis.Module != null) {
            foreach (var (name, rules) in new (string, Func<PreflightChecks.Found>)[] {
                ("WithModule", () => PreflightChecks.WithModule(ops, prefix, lane, facts)),
                ("WithBase", () => PreflightChecks.WithBase(ops, prefix, lane, facts)) }) {
                PreflightChecks.Found result;
                try { result = rules(); }
                catch (Exception error) { skipped.Add(new JsonObject { ["class"] = name, ["reason"] = "the rules could not read the job: " + error.Message }); continue; }
                checkedClasses.Add(name);
                foreach (var p in result.Problems.Concat(result.Warnings)) {
                    p["phase"] = "static";
                    p["basis"] ??= "module-index";
                    if (!facts.Fresh && p["severity"]?.ToString() == "error") p["severity"] = "warning";
                    found.Add(p);
                }
            }
            if (Builtins.For(lane) is not { } builtins)
                skipped.Add(new JsonObject { ["class"] = "functions", ["reason"] = "the built-in functions of this lane come from its Studio (not bound here): a function name is not judged" });
            else {
                // CX16 r2 (M3, provisional): FUNCTION_UNKNOWN of the base phase, decided here without the Studio.
                try { found.AddRange(Functions(ops, prefix, lane, facts, builtins)); checkedClasses.Add("functions"); }
                catch (Exception error) { skipped.Add(new JsonObject { ["class"] = "functions", ["reason"] = "the rule failed: " + error.Message }); }
            }
            skipped.Add(new JsonObject { ["class"] = "callees", ["reason"] = "the signature of a callee comes from the model (the index has none): arguments of calls are judged at apply" });
        }
        // Once: what the pure preflight said, and the same problem twice.
        var said = new HashSet<string>((preflight ?? []).Select(Key), StringComparer.Ordinal);
        var problems = new List<JsonObject>(); var warnings = new List<JsonObject>();
        foreach (var p in found) {
            if (!said.Add(Key(p))) continue;
            (p["severity"]?.ToString() == "warning" ? warnings : problems).Add(p);
        }
        return new Result(problems, warnings, new JsonArray(checkedClasses.Select(c => (JsonNode)c).ToArray()), new JsonArray(skipped.Select(s => (JsonNode)s).ToArray()));
    }

    private static string Key(JsonObject p) => p["op"] + "|" + p["pointer"] + "|" + p["code"] + "|" + p["message"];

    // ---- functions: what the base phase (JobRunner.CheckAgainstBase, FUNCTION_UNKNOWN) decides without the Studio --------

    private static readonly Regex FunctionCall = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex StringLiteral = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);
    private static readonly Regex RoleFunction = new(@"^(?:Check|Grant|Revoke)\w+Role$", RegexOptions.Compiled);

    /// <summary>A call in an expression of the job (its logic ops in the JSON form, the documents and the edit forms of its
    /// html ops, as the base phase reads them) to a name that is no built-in of the lane (Builtins: the Studio's registry or the
    /// checked-in catalog), no element of the module or of its references (the index, the digest, the job's reference ops),
    /// nothing of a producer index and nothing the job may create. The message of the base phase, so the two say it once.
    /// Rests on an absence: an error only on a fresh index.</summary>
    internal static IEnumerable<JsonObject> Functions(JsonArray ops, string? prefix, string lane, IndexBaseFacts facts, IReadOnlyDictionary<string, BuiltinFact> builtins)
    {
        var expressions = new List<(int Op, string? Pointer, string Text)>();
        foreach (var (op, text) in LogicLint.AllExpressions(ops)) expressions.Add((op, prefix == null ? null : prefix + "/" + op, text));
        for (var i = 0; i < ops.Count; i++) {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html" || op["parent"] != null || op["data"] is not JsonObject data) continue;
            var texts = new List<(string At, string Text)>();
            if (data["edit"] is JsonArray list)
                for (var j = 0; j < list.Count; j++) { if (list[j] is JsonValue v && v.TryGetValue<string>(out var t)) texts.Add(("/data/edit/" + j, t)); }
            else if (data["html"] is JsonValue htmlValue && htmlValue.TryGetValue<string>(out var html) && (ScreenHtmlEdit.IsEdit(op) || ScreenDocument.IsDocumentOp(op))) texts.Add(("/data/html", html));
            foreach (var (at, text) in texts)
                foreach (var expression in JobRunner.EditExpressions(text)) expressions.Add((i, prefix == null ? null : prefix + "/" + i + at, expression));
        }
        if (expressions.Count == 0) yield break;
        // What the job may create (as the base phase's declared names): the declarations of the job (DocumentNameRules), its logic
        // ops in the JSON form reduced to the names of their actions and parameters; never the names its expressions only call.
        var reduced = new JsonArray();
        foreach (var node in DocumentNameRules.Declarations(ops)) {
            if (node is JsonObject o && o["op"]?.ToString() == "logic" && o["data"]?["actions"] is JsonArray actions) {
                var names = new JsonArray();
                foreach (var action in actions.OfType<JsonObject>()) {
                    if (action["name"]?.ToString() is { Length: > 0 } name) names.Add(name);
                    foreach (var list in new[] { "inputs", "outputs", "locals", "variables" })
                        foreach (var parameter in (action[list] as JsonArray ?? []).OfType<JsonObject>())
                            if (parameter["name"]?.ToString() is { Length: > 0 } parameterName) names.Add(parameterName);
                }
                reduced.Add(new JsonObject { ["op"] = "logic", ["names"] = names });
            } else reduced.Add(node?.DeepClone());
        }
        var (words, whole) = JobPreflight.JobWords(reduced);
        // A screen generator op writes names nobody plans here: an unknown call is a warning in that job (DocumentNameRules).
        var unplanned = ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() == "screen");
        var producers = new HashSet<string>(facts.ProducerNames("action").Concat(facts.ProducerNames("actionRef")), StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (op, pointer, text) in expressions)
            foreach (Match m in FunctionCall.Matches(StringLiteral.Replace(text, "\"\""))) {
                var name = m.Groups[1].Value;
                if (name is "and" or "or" or "not" || RoleFunction.IsMatch(name) || builtins.ContainsKey(name) || facts.HasName(name) || producers.Contains(name)
                    || JobPreflight.PossiblyCreated(name, words, whole) || !seen.Add(op + "|" + name)) continue;
                var near = ScreenHtmlEdit.Closest(name, builtins.Keys);
                var problem = JobPreflight.Problem(op, pointer, "FUNCTION_UNKNOWN", facts.Fresh && !unplanned ? "error" : "warning",
                    $"'{name}(' is not a built-in function of this Studio ({lane}), nor a function of the module, of its references or of this job",
                    near.Count > 0 ? "use one of: " + string.Join(", ", near)
                        : $"no built-in, no function of the module or of its references and no action of this job is named like {name}: write the built-in the expression means (ToLower, Substr, If, ...), or call an action of the module marked Function; the built-ins: `anvil functions --find {name}`",
                    null, "logic");
                problem["phase"] = "static";
                problem["basis"] = "functions+module-index";
                yield return problem;
            }
    }
}
