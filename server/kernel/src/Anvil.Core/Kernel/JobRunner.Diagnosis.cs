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
        { "REFERENCE_UNRESOLVED", "CHILD_NOT_FOUND", "PROPERTY_NOT_WRITABLE", "ENUM_VALUE_INVALID", "TYPE_UNRESOLVED", "SQL_UNRESOLVED", "JSON_SHAPE", "OP_NOT_OBJECT", "LOGIC_DUPLICATE_ACTION",
          Preflight.NodeRules.Code };

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

    /// <summary>The ops refused whole, but the document form (B1) still runs: its compile says the rules again with the names
    /// only the module can check, and the refusal brings both together (the same problem at the same line once).</summary>
    private static IReadOnlySet<int>? RefusedWholeButDocuments(JsonObject? preflight, JsonArray jobOps)
    {
        var ops = RefusedWhole(preflight)?.Where(i => !(StructuralHtmlOnly(preflight, i) && i < jobOps.Count && ScreenDocument.IsDocumentOp(jobOps[i]))
            && !(RulesOnly(preflight, i) && i < jobOps.Count && jobOps[i] is JsonObject edit && Anvil.Reading.ScreenHtmlEdit.IsEdit(edit))).ToHashSet();
        return ops is { Count: > 0 } ? ops : null;
    }

    // B3: the edit form of an html op that the preflight refused only for the owner's rules on what is new (a <script>, a
    // javascript: event, a foreign iteration, a Visible): its plan says them again with the reading (what the element already
    // had is kept, never refused) beside everything else that is wrong with it, each with its patch: one refusal, not one per wave.
    // CX17 review 2, M4: a marker of the engine on a new element is one of them (the plan says it again with the markers of the
    // elements with k, and the patch).
    private static readonly HashSet<string> RuleCodes = new(StringComparer.Ordinal) { "HTML_SCRIPT", "HTML_FOREACH", "HTML_VISIBLE", "HTML_JSON", ScreenVisual.ReservedMarker };
    private static bool RulesOnly(JsonObject? preflight, int op)
        => (preflight?["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(p => p["op"] is JsonValue v && v.TryGetValue<int>(out var at) && at == op).All(p => RuleCodes.Contains(p["code"]?.ToString() ?? ""));

    // Every problem the preflight found in this op is a module-free html one (none is the shape of the op itself).
    private static bool StructuralHtmlOnly(JsonObject? preflight, int op)
        => (preflight?["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(p => p["op"] is JsonValue v && v.TryGetValue<int>(out var at) && at == op).All(StructuralHtml);

    /// <summary>A problem of the module-free pass of an html op: its code is an HTML_* code (or the CSS one of the op), its pointer
    /// inside an op, and it is an error of the preflight (no base was loaded to find it).</summary>
    private static bool StructuralHtml(JsonObject problem)
        => problem["severity"]?.ToString() is null or "error" && problem["phase"]?.ToString() is null or "preflight"
           && problem["code"]?.ToString() is { } code && (code.StartsWith("HTML_", StringComparison.Ordinal) || code == CssCompat.Code && problem["pointer"]?.ToString() is { } pointer
               && (pointer.Contains("/data/css", StringComparison.Ordinal) || pointer.Contains("/data/html", StringComparison.Ordinal)));

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
        // The envelope reports phases executed; each problem's phase still reports where that problem was found.
        var phases = new List<string>();
        if (preflight != null) phases.Add("preflight");
        phases.Add("base");
        phases.Add("apply");
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
        {
            phases.Add("verify");
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
        }
        var verifyNotes = verify.Where(p => p["severity"]?.ToString() == "warning").ToList();
        verify = verify.Except(verifyNotes).ToList();
        // motor2 (C16): what a failed op left half-built is not a fault of its own: the Verify's messages on the actions a
        // failed logic op declares (InvalidFlow_NoStart of a screen action born empty by its document) go with that failure.
        string? cascadeLine = null;
        if (kept != null && CascadeOfFailedOps(verify, kept.Problems, ops, opsPointer) is { Count: > 0 } cascade)
        {
            verify = verify.Except(cascade).ToList();
            var note = JobPreflight.Problem(null, null, "VERIFY_OF_FAILED_OP", "warning",
                $"{cascade.Count} message(s) of the Verify are on actions a failed op declares ({string.Join(", ", cascade.Select(c => c["message"]?.ToString() ?? "").Select(Element).Distinct().Take(6))}): what the failure left half-built, left out of the problems",
                "fix the failed op; its actions are built whole the next time", null, "verify");
            verifyNotes.Add(note);
            cascadeLine = JobPreflight.Text(note);
        }
        // motor2 review: the apply and the Verify point into the ops as normalized (and as patched for the diagnosis); the
        // answer points into the job as sent (after the cascade, which reads the ops as they are). A patch this round applied
        // for its diagnosis (NODE_NOT_ALLOWED) says whether the round proved it.
        if (kept != null)
        {
            Preflight.SentJob.TranslateAll(kept.Problems, ops, opsPointer);
            Preflight.SentJob.TranslateAll(kept.Warnings.OfType<JsonObject>(), ops, opsPointer);
        }
        Preflight.SentJob.TranslateAll(verify, ops, opsPointer);
        Preflight.SentJob.TranslateAll(verifyNotes, ops, opsPointer);
        Preflight.NodeRules.Proven(baseCheck.Problems, kept?.Problems ?? [], verify, opsPointer);
        verifyReason ??= verifyFailed != null ? "the Verify of the candidate failed: " + verifyFailed
            : expectedValid ? null : "expectValid is false: the Verify's errors are the verdict the job expects, not problems";
        if (!preflightInvalid && baseCheck.Problems.Count == 0 && verify.Count == 0)
        {
            // primeira-certa A7: one phase alone keeps its refusal (its code, its text), and the envelope is still complete:
            // verifyRan, the phase and the problems in the format of the single refusal.
            if (kept == null && upgrade.Count > 0)
            {
                var refused = new InvalidOperationException(string.Join(Environment.NewLine, upgrade));
                Errors.Annotate(refused, verifyFailed == null, verifyReason, phases,
                    new JsonArray(UpgradeProblems(upgrade, opsPointer).Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
                return refused;
            }
            if (kept?.Refusal != null && upgrade.Count == 0)
            {
                Errors.Annotate(kept.Refusal, verifyFailed == null, verifyReason, phases,
                    new JsonArray(FoldCascade(kept.Problems.ToList(), ops, opsPointer).Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
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
        var united = Union(all, opsPointer);
        // Integration 24-1 familias (review): every problem of one html document carries one patch, every correction composed and
        // proved by its compile (JobRunner.DocumentPatches), never two whole texts where the last undoes the first.
        DocumentPatches(united, ops, opsPointer, (op, html, css) => session.CheckComposedDocument(ops, op, html, css), log);
        // Familias: the cascade of a failed part of the job (a name it declares, not found elsewhere) leaves the problems; its
        // root says blocks: N.
        var problems = FoldCascade(united, ops, opsPointer);
        string? foldedLine = null;
        if (problems.Count < united.Count)
        {
            var folded = JobPreflight.Problem(null, null, "CASCADE_FOLDED", "warning",
                $"{united.Count - problems.Count} problem(s) of the apply and the Verify name what a failed part of this job declares: left out of the problems, counted in blocks of their {problems.Count(p => p["blocks"] is JsonValue)} root(s)",
                "fix the roots (the problems with blocks); what they declare is built the next time", null, "verify");
            verifyNotes.Add(folded);
            foldedLine = JobPreflight.Text(folded);
        }
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
        if (cascadeLine != null) lines.Add(cascadeLine);
        if (foldedLine != null) lines.Add(foldedLine);
        var warnings = new JsonArray((preflight?["warnings"] as JsonArray ?? new JsonArray()).Select(w => w?.DeepClone())
            .Concat((kept?.Warnings ?? []).Select(w => (JsonNode?)w)).Concat(verifyNotes.Select(w => (JsonNode?)JobPreflight.PublicProblem(w))).ToArray());
        return new JobPreflightException(string.Join(Environment.NewLine, lines), new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()), warnings)
        {
            VerifyRan = verifyFailed == null,
            VerifyReason = verifyReason,
            Phases = phases,
        };
    }

    private static readonly Regex VerifyPath = new(@" @ (?<path>.+?)\s*$", RegexOptions.Compiled);
    private static readonly Regex PathLevel = new(@"^(?<name>.+?) \((?<kind>[A-Za-z]+)\)$", RegexOptions.Compiled);

    /// <summary>The "Screen / Action" a Verify message names at the end of its path (or the message when it names none).</summary>
    private static string Element(string message)
    {
        if (VerifyPath.Match(message) is not { Success: true } m) return message.Length > 60 ? message[..60] : message;
        var levels = m.Groups["path"].Value.Split(" / ");
        return string.Join(".", levels.TakeLast(2).Select(l => PathLevel.Match(l) is { Success: true } lm ? lm.Groups["name"].Value : l));
    }

    /// <summary>motor2: the Verify problems whose element is an action a logic op declares (by owner and name), when that op
    /// failed whole at apply (its op-level APPLY_FAILED, or the op skipped): the cascade of that failure.</summary>
    internal static List<JsonObject> CascadeOfFailedOps(IReadOnlyList<JsonObject> verify, IReadOnlyList<JsonObject> applied, JsonArray ops, string? opsPointer)
    {
        if (opsPointer == null) return [];
        var declared = new HashSet<(string Owner, string Name)>();
        void Declare(JsonNode? action)
        {
            if (action is JsonObject a && a["name"]?.ToString() is { Length: > 0 } name && a["owner"]?.ToString() is { } owner && owner.Contains(':'))
                declared.Add((owner[(owner.IndexOf(':') + 1)..].ToUpperInvariant(), name.ToUpperInvariant()));
        }
        foreach (var p in applied)
        {
            if (p["op"] is not JsonValue v || !v.TryGetValue<int>(out var op) || op >= ops.Count || ops[op] is not JsonObject logic
                || logic["op"]?.ToString() != "logic" || logic["data"]?["actions"] is not JsonArray actions) continue;
            var pointer = p["pointer"]?.ToString() ?? "";
            // The op failed whole: every action it declares; one action failed: that one.
            if (pointer == $"{opsPointer}/{op}") foreach (var action in actions) Declare(action);
            else if (Regex.Match(pointer, "^" + Regex.Escape($"{opsPointer}/{op}/data/actions/") + @"(\d+)$") is { Success: true } one && int.Parse(one.Groups[1].Value) < actions.Count)
                Declare(actions[int.Parse(one.Groups[1].Value)]);
        }
        if (declared.Count == 0) return [];
        var cascade = new List<JsonObject>();
        foreach (var p in verify)
        {
            if (VerifyPath.Match(p["message"]?.ToString() ?? "") is not { Success: true } m) continue;
            var levels = m.Groups["path"].Value.Split(" / ").Select(l => PathLevel.Match(l)).Where(l => l.Success).ToList();
            // The action is a level of the path (the message may name a node inside it); its screen or block is the level above.
            for (var k = levels.Count - 1; k >= 1; k--)
            {
                if (!levels[k].Groups["kind"].Value.EndsWith("Action", StringComparison.Ordinal)) continue;
                if (declared.Contains((levels[k - 1].Groups["name"].Value.ToUpperInvariant(), levels[k].Groups["name"].Value.ToUpperInvariant()))) cascade.Add(p);
                break;
            }
        }
        return cascade;
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
                // A problem of an html document said by the preflight and again by the compile: the compile's word stands, its
                // patch the corrected document it compiled and checked (the names too, which only the module knows), or none when
                // that check refused it (B4: a patch that does not compile is never offered).
                var document = same["phase"]?.ToString() == "preflight" && p["line"] is JsonValue && same["line"] is JsonValue && Html(p) && Html(same);
                // A logic text's problem said by the preflight and again by the apply: the apply's patch was written with the
                // module (the type of a list of the screen, the order of a record's attributes), and stands.
                var text = same["phase"]?.ToString() == "preflight" && p["phase"]?.ToString() == "apply" && (WholeFlowPatch(p["patch"]) || WholeFlowPatch(same["patch"]));
                if (same["pointer"]?.ToString() == p["pointer"]?.ToString() && (same["patch"] is not JsonArray && p["patch"] is JsonArray || document || text))
                    result[result.IndexOf(same)] = p;
                continue;
            }
            result.Add(p);
        }
        // The patch of a logic op's text form writes its whole data.flow (FlowTextForm.Patch: every certain fix of every text of
        // the op): the one the apply wrote, with the read of every action, stands for every problem of that op that has one, so
        // the patches of one refusal never undo each other.
        foreach (var group in result.Where(p => p["op"] is JsonValue && WholeFlowPatch(p["patch"])).GroupBy(p => p["op"]!.ToJsonString()))
        {
            var best = group.LastOrDefault(p => p["phase"]?.ToString() == "apply") ?? group.Last();
            foreach (var p in group) if (!ReferenceEquals(p, best)) p["patch"] = best["patch"]!.DeepClone();
        }
        return result;
    }

    private static bool WholeFlowPatch(JsonNode? patch)
        => patch is JsonArray { Count: 1 } steps && steps[0] is JsonObject step && step["op"]?.ToString() == "replace"
           && step["path"]?.ToString() is { } path && (path.EndsWith("/data/flow", StringComparison.Ordinal) || path.EndsWith("/data", StringComparison.Ordinal) && step["value"]?["flow"] != null);

    private static bool Html(JsonObject problem) => problem["code"]?.ToString()?.StartsWith("HTML_", StringComparison.Ordinal) == true;

    // A pointer at the edit of a reading (C2: data.edit or data.html; the CX16 element edits: data.edits) or inside it.
    private static bool EditPointer(string pointer) =>
        pointer.Contains("/data/edit", StringComparison.Ordinal) || pointer.EndsWith("/data/html", StringComparison.Ordinal);

    private static bool SamePlace(JsonObject q, JsonObject p, string? opsPointer)
    {
        // The Verify says each fault of each element once: two of its messages are two faults (UI-Mockup, FarmaVirtual call 96:
        // the 16 IfWidgets of one html op shared /ops/245 and came back as 1; call 99: the ExpressionUnknownObject of a Labels
        // went under the CustomObjectError of the same Labels), unless the same message on the same element came twice.
        if (q["phase"]?.ToString() == "verify" && p["phase"]?.ToString() == "verify"
            && (q["key"]?.ToString() != p["key"]?.ToString() || q["message"]?.ToString() != p["message"]?.ToString())) return false;
        // motor2 review: a problem whose patch this round's apply ran (NODE_NOT_ALLOWED) did not fail its op; what the apply or
        // the Verify found at its place is a fault of the patched op, never the same refusal again.
        if (q["_diagnosisPatch"] is JsonValue) return false;
        // Familias: a preflight rule that predicts a Verify message names it (verifyCode) and the element it is on (element):
        // the Verify's message of that id on that element (a level of its path) is the same fault.
        if (q["verifyCode"]?.ToString() is { Length: > 0 } predicted && p["phase"]?.ToString() == "verify" && p["code"]?.ToString() == predicted
            && q["op"]?.ToJsonString() == p["op"]?.ToJsonString() && q["element"]?.ToString() is { Length: > 0 } element
            && VerifyPath.Match(p["message"]?.ToString() ?? "") is { Success: true } verifyPath
            && verifyPath.Groups["path"].Value.Split(" / ").Any(level => PathLevel.Match(level) is { Success: true } lm && lm.Groups["name"].Value.Equals(element, StringComparison.OrdinalIgnoreCase)))
            return true;
        var qo = q["op"] is JsonValue qv && qv.TryGetValue<int>(out var a) ? a : (int?)null;
        var po = p["op"] is JsonValue pv && pv.TryGetValue<int>(out var b) ? b : (int?)null;
        if (qo == null || po == null || qo != po) return false;
        // Problems of one logic text (ssam-flow/1) all point at the text and name the element by its id: one place is the same
        // rule on the same element, never the next rule on another node of the same text.
        if (q["id"] is JsonValue && p["id"] is JsonValue)
            return q["code"]?.ToString() == p["code"]?.ToString() && q["id"]!.ToJsonString() == p["id"]!.ToJsonString() && q["pointer"]?.ToString() == p["pointer"]?.ToString();
        // Problems of the edit of a reading (C2) all point at their edit string: one place there is the same rule on the same
        // element (its k; a new element or a <script>, which have none, by the message), never every problem of the same edit,
        // nor an html rule and another check of the same string (an unknown function of the base beside the L6 rule). CX17 review 3,
        // M8: the op's edit list and each of its strings are one family (/data/edit, /data/edits and /data/edit[s]/<j>): the
        // preflight says the new elements at the list, the plan the elements with k at their string; a pointer inside the other
        // with the same code is never the same place there, only the same k or the same message.
        if (!(q["line"] is JsonValue && p["line"] is JsonValue) && (Html(q) || Html(p)) && q["pointer"]?.ToString() is { } edit && p["pointer"]?.ToString() is { } other
            && EditPointer(edit) && EditPointer(other) && (edit == other || edit.StartsWith(other + "/", StringComparison.Ordinal) || other.StartsWith(edit + "/", StringComparison.Ordinal)))
            return q["code"]?.ToString() == p["code"]?.ToString()
                && (q["k"] is JsonValue && q["k"]!.ToString() == p["k"]?.ToString() || q["message"]?.ToString() == p["message"]?.ToString());
        // Problems of one text (the html document of an op) carry their line and column: two of them are one place only when
        // they say the same thing there. One refusal brings every wrong name of the document (B1), not the first of them.
        if (q["line"] is JsonValue && p["line"] is JsonValue && Html(q) && Html(p))
            return q["line"]!.ToJsonString() == p["line"]!.ToJsonString() && q["column"]?.ToJsonString() == p["column"]?.ToJsonString()
                && q["message"]?.ToString() == p["message"]?.ToString();
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
