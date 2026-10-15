using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// The rules of A02/A04 in one place, called by name (never discovered by reflection): <see cref="Pure"/> from
/// JobPreflight.Analyze (what the job alone decides) and <see cref="WithBase"/> from JobRunner.CheckAgainstBase (what needs
/// the base). The rules that predict a Verify error (EXPR_UNKNOWN_IDENTIFIER, NAME_COLLISION, FUNCTION_ARITY, OPERAND_TYPES,
/// DB_FUNCTION_IN_AGGREGATE, REQUIRED_ARGUMENT, ARGUMENT_UNKNOWN, MOBILE_BLOCK_WITH_NAVIGATION) do not run for a job that
/// expects an invalid module (expectValid false): it asks the Verify for that verdict. A rule that throws is a warning
/// (PREFLIGHT_RULE_FAILED), never a refusal.
/// </summary>
public static class PreflightChecks
{
    public sealed record Found(List<JsonObject> Problems, List<JsonObject> Warnings);

    public static Found Pure(JsonArray ops, string? prefix, string lane, IReadOnlyList<Expansion> expansions, bool verifyRules = true)
    {
        var found = new Found([], []);
        Run(found, nameof(PropertyRules), () => PropertyRules.Check(ops, prefix, lane, expansions));
        if (!verifyRules) return found;
        var job = JobFacts.From(ops);
        Run(found, nameof(NameRules), () => NameRules.Check(ops, prefix, lane, job));
        Run(found, nameof(ActionNameRules), () => ActionNameRules.Check(ops, prefix, null));
        Run(found, nameof(CallRules), () => CallRules.Check(ops, prefix, job, null));
        Run(found, nameof(ExpressionRules), () => ExpressionRules.Check(ops, prefix, lane, job, null));
        // motor2: what the normalizations left (an unknown icon, a default that could not move, two names in one document, a
        // name with two meanings in one body), in the same pass.
        Run(found, nameof(HtmlDocumentRules), () => HtmlDocumentRules.Check(ops, prefix, lane));
        Run(found, nameof(ScopeRenames), () => ScopeRenames.Check(ops, prefix, null));
        // Familias (C13): an identifier ordered against a number in the filter of a document's aggregate.
        Run(found, nameof(DocumentAggregates), () => DocumentAggregates.Check(ops, prefix, lane));
        return found;
    }

    /// <summary>motor2: the rules that need only the module type and the base's own screens, never the names a producer
    /// imports: they run for every job that expects a valid module, with the other problems of the base phase (a job with a
    /// reference op included, which skips <see cref="WithBase"/>).</summary>
    public static Found WithModule(JsonArray ops, string? prefix, string lane, IBaseFacts model)
    {
        var found = new Found([], []);
        var job = JobFacts.From(ops);
        Run(found, nameof(ActionNameRules), () => ActionNameRules.Check(ops, prefix, model));
        Run(found, nameof(NodeRules), () => NodeRules.Check(ops, prefix, job, model.ModuleType));
        Run(found, nameof(ScopeRenames), () => ScopeRenames.Check(ops, prefix, model.ScreenNames));
        return found;
    }

    /// <summary>The rules again, with the base: what the pure pass left unknown (an entity of the module, a callee of the
    /// module, a root name, the module type). Runs only after the pure pass accepted the job, so all it finds is new.</summary>
    public static Found WithBase(JsonArray ops, string? prefix, string lane, IBaseFacts model)
    {
        var found = new Found([], []);
        var job = JobFacts.From(ops);
        Run(found, nameof(CallRules), () => CallRules.Check(ops, prefix, job, model));
        Run(found, nameof(ExpressionRules), () => ExpressionRules.Check(ops, prefix, lane, job, model));
        Run(found, nameof(MobileRules), () => MobileRules.Check(ops, prefix, job, model));
        Run(found, nameof(ExpressionRules.CheckRawSets), () => ExpressionRules.CheckRawSets(ops, prefix, lane, job, model));
        return found;
    }

    private static void Run(Found found, string rule, Func<List<JsonObject>> check)
    {
        // A rule's warning (PROPERTY_SET_DROPPED) blocks nothing: it goes with the warnings.
        try { foreach (var p in check()) (p["severity"]?.ToString() == "warning" ? found.Warnings : found.Problems).Add(p); }
        catch (Exception ex)
        {
            found.Warnings.Add(JobPreflight.Problem(null, null, "PREFLIGHT_RULE_FAILED", "warning", $"preflight rule {rule} failed and was skipped: {Errors.Text(ex)}", null, null, "rule"));
        }
    }
}
