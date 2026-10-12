using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// primeira-certa A1/A2 (decision of the owner, 2026-10-10): one refusal with every problem. The problems came in waves
/// because each phase refused alone and stopped the next: the preflight before the base was loaded (so the rules that need
/// the base, such as the field path of a SQL output on a module entity, ran only in the next round), the base check before
/// the apply, the apply before the Verify. Now the phases run in order on the disposable copy of the base and the refusal
/// is their union: preflight, base, apply (failed ops recorded, dependents skipped) and the Verify of what did apply, each
/// problem with its phase, op, pointer, code, message and fix (and the patch when one correction is certain). The same
/// place is reported once (the problem with a patch stays). Nothing is saved.
/// </summary>
public static partial class JobRunner
{
    /// <summary>What CheckAgainstBase found: the problems (phase "base") and their text lines, in the wording tools read.</summary>
    private sealed record BaseCheck(List<JsonObject> Problems, List<string> Lines);

    private static readonly Regex UpgradePrefix = new(@"^op #(\d+)(?: \(([^)]*)\))?:\s*", RegexOptions.Compiled);
    // A quoted name ('X', 'A.B', a function as 'Right('), never the text between the apostrophe of "can't" and the next quote.
    private static readonly Regex QuotedToken = new(@"'([\p{L}_][\p{L}\p{N}_.]{2,})\(?'|(?<![\w$@])(I[A-Z][A-Za-z0-9]*:[\p{L}_][\p{L}\p{N}_]*)", RegexOptions.Compiled);
    private static readonly HashSet<string> TypeWords = new(StringComparer.OrdinalIgnoreCase)
        { "Text", "Integer", "Long Integer", "Decimal", "Currency", "Boolean", "Date", "Date Time", "Time", "Identifier", "Binary Data", "Email", "Phone Number" };
    // The codes of a problem that makes its op fail at apply: an op-level apply failure of the same op says it again.
    private static readonly HashSet<string> FailsTheOp = new(StringComparer.Ordinal)
        { "REFERENCE_UNRESOLVED", "CHILD_NOT_FOUND", "PROPERTY_NOT_WRITABLE", "ENUM_VALUE_INVALID", "TYPE_UNRESOLVED", "SQL_UNRESOLVED", "JSON_SHAPE", "OP_NOT_OBJECT", "LOGIC_DUPLICATE_ACTION" };

    /// <summary>The ops the preflight refused whole: their JSON could not be read as the op (JSON_SHAPE, OP_NOT_OBJECT), or an
    /// html op the structural pass refused (H3 of docs/PROTOTIPO-NATIVO.md: HTML_* and the CSS the html op carries, found
    /// without a module). Applying them again only repeated the same failure after the whole build.</summary>
    private static IReadOnlySet<int>? RefusedWhole(JsonObject? preflight)
    {
        var ops = (preflight?["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(p => (p["code"]?.ToString() is JobDocument.ShapeCode or "OP_NOT_OBJECT" || StructuralHtml(p)) && p["op"] is JsonValue v && v.TryGetValue<int>(out _))
            .Select(p => p["op"]!.GetValue<int>()).ToHashSet();
        return ops.Count == 0 ? null : ops;
    }

    /// <summary>A problem of the module-free pass of an html op: its code is an HTML_* code (or the CSS one of the op), its pointer
    /// inside an op, and it is an error of the preflight (no base was loaded to find it).</summary>
    private static bool StructuralHtml(JsonObject problem)
        => problem["severity"]?.ToString() is null or "error" && problem["phase"]?.ToString() is null or "preflight"
           && problem["code"]?.ToString() is { } code && (code.StartsWith("HTML_", StringComparison.Ordinal) || code == CssCompat.Code && problem["pointer"]?.ToString()?.Contains("/data/css", StringComparison.Ordinal) == true);

    /// <summary>The refusal of a job with problems in any phase: the Verify of the candidate as applied (never saved), its
    /// blocking messages mapped to the job, and the union of every phase. One phase alone keeps the refusal tools already
    /// read: a lone apply failure its own exception (DELETE_HAS_CONSUMERS keeps its code), a lone database-upgrade refusal
    /// its text.</summary>
    private static Exception Diagnosis(ModelSession session, ServiceStudio.Model.ESpace espace, IReadOnlyList<MessageInfo> before, JsonArray ops,
        JsonObject? preflight, BaseCheck baseCheck, List<string> upgrade, IReadOnlyList<ExpectedMessage> expected, bool expectedValid, string? opsPointer,
        Action<string>? log)
    {
        var preflightInvalid = preflight?["valid"]?.GetValue<bool>() == false;
        var kept = session.Kept;
        // The Verify of what did apply: its blocking messages (errors, security warnings) are problems of the job too. A job
        // that expects an invalid module asks the Verify for that verdict: its errors are not problems.
        var verify = new List<JsonObject>();
        string? verifyFailed = null;
        string? verifyReason = null;
        if (session.EndOfApplyFailure is { } broken)
        {
            // The Studio's own check at the end of the apply already failed on what the failed op(s) left half-built: the
            // Verify would fail the same way. The failures of the apply are the refusal.
            verifyFailed = broken;
            verifyReason = "the Studio's check at the end of the apply failed on what the failed op(s) left half-built (" + broken + "): the Verify did not run; fix the failed op(s) and the next refusal brings the Verify";
        }
        else
            try
            {
                var after = ModelHost.Messages(espace);
                var delta = MessageDelta.Compute(before, after);
                var footprint = session.Footprint();
                var judged = footprint.Footprint with { AnonymousIntent = session.AnonymousIntentOf(footprint.Footprint) };
                var policy = MessageExpectations.Evaluate(delta.New, expected, delta.Preexisting, judged);
                if (expectedValid) verify = session.VerifyProblems(policy.Unexpected, ops, opsPointer, MessageExpectations.Lane, VerifyHints.TryRead());
            }
            catch (Exception ex) { verifyFailed = Errors.Text(ex); log?.Invoke("  verify of the diagnosis failed: " + verifyFailed); }
        var verifyNotes = verify.Where(p => p["severity"]?.ToString() == "warning").ToList();
        verify = verify.Except(verifyNotes).ToList();
        verifyReason ??= verifyFailed != null ? "the Verify of the candidate failed: " + verifyFailed
            : expectedValid ? null : "expectValid is false: the Verify's errors are the verdict the job expects, not problems";
        if (!preflightInvalid && baseCheck.Problems.Count == 0 && verify.Count == 0)
        {
            // primeira-certa A7: one phase alone keeps its refusal (its code, its text), and the envelope is still complete:
            // verifyRan, the phase and the problems in the format of the single refusal.
            if (kept == null && upgrade.Count > 0)
            {
                var refused = new InvalidOperationException(string.Join(Environment.NewLine, upgrade));
                Errors.Annotate(refused, verifyFailed == null, verifyReason, ["apply"],
                    new JsonArray(UpgradeProblems(upgrade, opsPointer).Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
                return refused;
            }
            if (kept?.Refusal != null && upgrade.Count == 0)
            {
                Errors.Annotate(kept.Refusal, verifyFailed == null, verifyReason, ["apply"],
                    new JsonArray(kept.Problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
                return kept.Refusal;
            }
        }
        var all = new List<JsonObject>();
        foreach (var p in (preflight?["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var copy = p.DeepClone().AsObject();
            copy["phase"] ??= "preflight";
            all.Add(copy);
        }
        all.AddRange(baseCheck.Problems);
        if (kept != null) all.AddRange(kept.Problems);
        all.AddRange(UpgradeProblems(upgrade, opsPointer));
        all.AddRange(verify);
        var problems = Union(all, opsPointer);
        // The text: the lines of the preflight and of the base as tools read them, then the failures of the apply that are
        // not the same place again, the database upgrade and the Verify.
        var lines = new List<string>();
        lines.AddRange((preflight?["errors"] as JsonArray ?? new JsonArray()).Select(e => e?.ToString()).OfType<string>());
        // CheckAgainstBase writes one line per problem, in order: the line of a problem the union dropped goes with it.
        lines.AddRange(baseCheck.Lines.Where((_, n) => n >= baseCheck.Problems.Count || problems.Contains(baseCheck.Problems[n])));
        var applyOps = problems.Where(p => p["phase"]?.ToString() == "apply").Select(p => p["op"]?.GetValue<int>()).OfType<int>().ToHashSet();
        if (kept != null)
            lines.AddRange(kept.Lines.Where(l => UpgradePrefix.Match(l) is not { Success: true } m || applyOps.Contains(int.Parse(m.Groups[1].Value)) || l.Contains(" skipped: ", StringComparison.Ordinal)));
        lines.AddRange(upgrade);
        lines.AddRange(problems.Where(p => p["phase"]?.ToString() == "verify").Select(JobPreflight.Text));
        var warnings = new JsonArray((preflight?["warnings"] as JsonArray ?? new JsonArray()).Select(w => w?.DeepClone())
            .Concat((kept?.Warnings ?? []).Select(w => (JsonNode?)w)).Concat(verifyNotes.Select(w => (JsonNode?)JobPreflight.PublicProblem(w))).ToArray());
        var phases = problems.Select(p => p["phase"]?.ToString()).OfType<string>().Distinct().ToList();
        return new JobPreflightException(string.Join(Environment.NewLine, lines), new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()), warnings)
        {
            VerifyRan = verifyFailed == null,
            VerifyReason = verifyReason,
            Phases = phases,
        };
    }

    /// <summary>The lines of the database upgrade refusal as problems (phase apply, code DATABASE_UPGRADE_REFUSED).</summary>
    private static IEnumerable<JsonObject> UpgradeProblems(List<string> upgrade, string? opsPointer)
    {
        foreach (var line in upgrade)
        {
            var m = UpgradePrefix.Match(line);
            var op = m.Success ? int.Parse(m.Groups[1].Value) : (int?)null;
            var message = m.Success ? line[m.Length..] : line;
            var problem = JobPreflight.Problem(op, op is { } i && opsPointer != null ? $"{opsPointer}/{i}" : null, "DATABASE_UPGRADE_REFUSED", "error", message,
                JobPreflight.FixFrom(message) ?? "set the Delete Rule the message names to Ignore or Protect");
            problem["phase"] = "apply";
            yield return problem;
        }
    }

    /// <summary>The problems of every phase, in phase order, each place once: a later problem (apply, verify) at the same
    /// place as an earlier one is the same fault seen again and is dropped, unless it carries a patch the earlier one lacks.
    /// The same place: the same op and pointer; or a pointer inside the other's with the same code or the same quoted name;
    /// or an op-level apply failure of an op the preflight or the base already refused for a fault that fails the op. Two
    /// messages of the Verify are never one place unless they are the same message on the same element (key).</summary>
    internal static List<JsonObject> Union(IEnumerable<JsonObject> all, string? opsPointer)
    {
        var result = new List<JsonObject>();
        foreach (var p in all)
        {
            // The base check runs the expression rules again with the base: what the preflight already said is not news,
            // unless the base made the fix certain (a patch the preflight could not write: a site property of the module).
            if (p["phase"]?.ToString() == "base" && result.FirstOrDefault(q => q["phase"]?.ToString() == "preflight" && q["op"]?.ToJsonString() == p["op"]?.ToJsonString()
                && q["pointer"]?.ToString() == p["pointer"]?.ToString() && q["code"]?.ToString() == p["code"]?.ToString()) is { } said)
            {
                if (said["patch"] is not JsonArray && p["patch"] is JsonArray) result[result.IndexOf(said)] = p;
                continue;
            }
            if (p["phase"]?.ToString() is "apply" or "verify" && result.FirstOrDefault(q => SamePlace(q, p, opsPointer)) is { } same)
            {
                if (same["pointer"]?.ToString() == p["pointer"]?.ToString() && same["patch"] is not JsonArray && p["patch"] is JsonArray)
                    result[result.IndexOf(same)] = p;
                continue;
            }
            result.Add(p);
        }
        return result;
    }

    private static bool SamePlace(JsonObject q, JsonObject p, string? opsPointer)
    {
        // The Verify says each fault of each element once: two of its messages are two faults (UI-Mockup, FarmaVirtual call 96:
        // the 16 IfWidgets of one html op shared /ops/245 and came back as 1; call 99: the ExpressionUnknownObject of a Labels
        // went under the CustomObjectError of the same Labels), unless the same message on the same element came twice.
        if (q["phase"]?.ToString() == "verify" && p["phase"]?.ToString() == "verify"
            && (q["key"]?.ToString() != p["key"]?.ToString() || q["message"]?.ToString() != p["message"]?.ToString())) return false;
        var qo = q["op"] is JsonValue qv && qv.TryGetValue<int>(out var a) ? a : (int?)null;
        var po = p["op"] is JsonValue pv && pv.TryGetValue<int>(out var b) ? b : (int?)null;
        if (qo == null || po == null || qo != po) return false;
        var qp = q["pointer"]?.ToString(); var pp = p["pointer"]?.ToString();
        var sameCode = q["code"]?.ToString() == p["code"]?.ToString();
        if (qp == null || pp == null) return sameCode || Subjects(q).Overlaps(Subjects(p));
        if (qp == pp) return true;
        if (!qp.StartsWith(pp + "/", StringComparison.Ordinal) && !pp.StartsWith(qp + "/", StringComparison.Ordinal)) return false;
        if (sameCode || Subjects(q).Overlaps(Subjects(p))) return true;
        var opLevel = opsPointer != null && pp == $"{opsPointer}/{po}";
        return opLevel && p["phase"]?.ToString() == "apply" && q["phase"]?.ToString() is "preflight" or "base"
            && q["code"]?.ToString() is { } code && (FailsTheOp.Contains(code) || code.EndsWith("_INVALID", StringComparison.Ordinal));
    }

    /// <summary>The names a problem's message quotes ('X', Type:Name), without the type names any message may quote.</summary>
    private static HashSet<string> Subjects(JsonObject p)
        => QuotedToken.Matches(p["message"]?.ToString() ?? "").Select(m => m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value)
            .Where(s => !TypeWords.Contains(s)).ToHashSet(StringComparer.OrdinalIgnoreCase);
}
