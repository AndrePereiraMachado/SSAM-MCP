using System.Text.Json.Nodes;
using Anvil.Core.Preflight;

namespace Anvil.Core;

public static partial class JobRunner
{
    internal sealed record AutoPatchResult(object Result, JsonNode Document, IReadOnlyList<JsonObject> Problems, int Rounds);

    internal static bool AutoPatchApplies(Exception refusal, bool enabled, bool expectedValid, string? opsPointer)
    {
        var errors = (Errors.FindCoded(refusal)?.Problems ?? new JsonArray()).OfType<JsonObject>()
            .Where(p => p["severity"]?.ToString() != "warning").ToList();
        return enabled && expectedValid && opsPointer != null && errors.Count > 0 && errors.All(PatchCertainty.IsCertain);
    }

    // The same execution callback is used by the native runner and by the synthetic rule tests. There is no recursion:
    // a new independent certain problem may use a second round, while any cause or choice ends in the single refusal.
    internal static object AutoPatchLoop(Exception refusal, JsonArray original, string opsPointer,
        Func<JsonArray, Probe, object> execute, Action<string>? log = null, JsonNode? sentDocument = null)
    {
        if (!AutoPatchApplies(refusal, true, true, opsPointer)) return refusal;
        JsonNode document = opsPointer.Length == 0 ? original.DeepClone() : new JsonObject { ["ops"] = original.DeepClone() };
        var source = sentDocument?.DeepClone() ?? document.DeepClone();
        var listed = Errors.FindCoded(refusal)!.Problems!.OfType<JsonObject>().ToList();
        var pending = listed.Where(p => p["severity"]?.ToString() != "warning").ToList();
        var appliedProblems = new List<JsonObject>();
        for (var round = 1; round <= 2; round++)
        {
            foreach (var patch in pending.Select(p => p["patch"]).OfType<JsonArray>().DistinctBy(p => p.ToJsonString()))
            {
                var next = Patched(document, patch);
                var nextSource = Patched(source, patch);
                if (next == null || nextSource == null)
                {
                    foreach (var problem in listed.Where(p => JsonNode.DeepEquals(p["patch"], patch)))
                    {
                        problem.Remove("patch");
                        problem["fix"] = problem["fix"] + " (no patch: the offered patch does not apply to the job)";
                        PatchCertainty.Publish(problem);
                    }
                    return refusal;
                }
                document = next;
                source = nextSource;
            }
            appliedProblems.AddRange(pending.Select(p => p.DeepClone().AsObject()));
            var applied = (opsPointer.Length == 0 ? document : document["ops"])!.DeepClone().AsArray();
            var probe = Plan(listed, original, applied, opsPointer);
            if (probe == null) return refusal;
            probe.Final = true;
            object result;
            try { result = execute(applied, probe); }
            catch (Exception error)
            {
                log?.Invoke("  auto patch round did not finish: " + Errors.Text(error));
                foreach (var problem in listed.Where(p => pending.Any(f => JsonNode.DeepEquals(p["patch"], f["patch"])) && p["patch"] is JsonArray))
                {
                    problem.Remove("patch");
                    problem["fix"] = problem["fix"] + " (no patch: its verification round did not finish: " + Errors.Text(error) + ")";
                    PatchCertainty.Publish(problem);
                }
                foreach (var problem in (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>())
                    probe.Found.Add((problem.DeepClone().AsObject(), null));
                if (probe.Found.Count == 0) probe.Found.Add((RefusedPolicy(Errors.Text(error), opsPointer), null));
                return Merge(refusal, Errors.FindCoded(refusal)!, listed, probe, opsPointer, log);
            }
            if (result is not Probe)
            {
                var verdict = System.Text.Json.JsonSerializer.SerializeToNode(result);
                if (verdict?["accepted"]?.GetValue<bool>() == true && probe.Found.Count == 0) return new AutoPatchResult(result, source, appliedProblems, round);
                foreach (var problem in (verdict?["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    probe.Found.Add((problem.DeepClone().AsObject(), null));
                var policy = string.Join("; ", (verdict?["policyMessages"] as JsonArray ?? new JsonArray()).Select(p => p?.ToString()));
                if (policy.Length > 0 || probe.Found.Count == 0) probe.Found.Add((RefusedPolicy(policy.Length > 0 ? policy : "the final verdict did not accept the candidate", opsPointer), null));
                return Merge(refusal, Errors.FindCoded(refusal)!, listed, probe, opsPointer, log);
            }
            var newProblems = probe.Found.Where(f => f.Cause == null && !listed.Any(p => SameAutoPatchProblem(p, f.Problem))).Select(f => f.Problem).ToList();
            var allIndependentAndCertain = newProblems.Count > 0 && newProblems.Count == probe.Found.Count
                && newProblems.All(PatchCertainty.IsCertain);
            refusal = Merge(refusal, Errors.FindCoded(refusal)!, listed, probe, opsPointer, log);
            if (round == 2 || !allIndependentAndCertain) return refusal;
            listed = Errors.FindCoded(refusal)!.Problems!.OfType<JsonObject>().ToList();
            pending = newProblems;
        }
        return refusal;
    }

    private static bool SameAutoPatchProblem(JsonObject left, JsonObject right)
        => new[] { "code", "op", "pointer", "message" }.All(field => JsonNode.DeepEquals(left[field], right[field]));

    private static JsonObject RefusedPolicy(string message, string pointer)
    {
        var problem = JobPreflight.Problem(null, pointer, "VERIFY_REFUSED", "error", message, "resolve the complete final validation and policy verdict");
        problem["phase"] = "verify"; return JobPreflight.PublicProblem(problem);
    }
}
