using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// R1 (2026-10-24): the scope phase of the base check. Before any op and before the Verify, every name the job's expressions,
/// calls, documents and raw sets use is resolved against the scope of its owner (the base, read as a fresh module index of the
/// very model the job is applied to, and what the same job declares), and every op that needs what a refused op declares is
/// named with that root (SCOPE_BLOCKED_BY_REFUSED_OP), so the apply never builds what can only fail. Phase "scope" on every
/// problem; the rule that found it in <c>rule</c>; the code the apply or the Verify would have answered in <c>predicts</c>.
/// The problems of the phase stop the job before its first op (JobRunner: no sessionApply while one is open).
/// </summary>
public static class ScopePhase
{
    public const string Phase = "scope";
    public const string Blocked = "SCOPE_BLOCKED_BY_REFUSED_OP";

    public sealed record Result(List<JsonObject> Problems, List<JsonObject> Normalizations, List<JsonObject> Warnings, long Ms);

    private static readonly ConditionalWeakTable<IBaseFacts, Result> Done = new();
    // The preflight of the job being applied in this flow (JobPreflight.Analyze remembers it): the ops it refused are the roots
    // of what they block. Until JobRunner hands it to Run, the flow carries it.
    private static readonly AsyncLocal<JsonObject?> LastPreflight = new();

    /// <summary>`ANVIL_SCOPE_PHASE=off` in the kernel's environment: the operator's emergency switch (and the baseline of the
    /// measurement of the phase), never an option of a job: the phase neither normalizes nor refuses.</summary>
    public static bool Off => string.Equals(Environment.GetEnvironmentVariable("ANVIL_SCOPE_PHASE"), "off", StringComparison.OrdinalIgnoreCase);

    /// <summary>JobPreflight.Analyze: the preflight of the job this flow goes on to apply.</summary>
    public static void Remember(JsonObject preflight) => LastPreflight.Value = preflight;

    /// <summary>The result of the phase already run on these facts (one base reading, one job), or null.</summary>
    public static Result? Measured(IBaseFacts facts) => Done.TryGetValue(facts, out var result) ? result : null;

    /// <summary>The phase over these ops and facts, once per facts object: the normalizations (JobNormalizer.WithBase) and the
    /// problems (PreflightChecks.WithModule) read the same run. <paramref name="preflight"/>: the job's own preflight (null:
    /// the one this flow remembers).</summary>
    public static Result Run(JsonArray ops, string? prefix, string lane, IBaseFacts facts, JsonObject? preflight = null)
    {
        if (Done.TryGetValue(facts, out var known)) return known;
        if (Off) return new Result([], [], [], 0);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var problems = new List<JsonObject>(); var normalizations = new List<JsonObject>(); var warnings = new List<JsonObject>();
        var job = ScopeJob.Of(ops);
        var index = facts as IndexBaseFacts ?? (facts as ModelBaseFacts)?.Indexed(ops, lane);
        if (index != null)
        {
            // The names of a document (blocks, handlers, destinations: S1-S7 of DocumentNameRules) are not judged here: the
            // compile of the document at apply says them all at once, before any Verify, with one patch composed for the whole
            // text (JobRunner.DocumentPatches); refusing them earlier would give a poorer refusal. The static check (check-job,
            // StaticChecks) says them before the build.
            var callables = ScopeRules.Known(index, job, ops, lane);
            Collect(problems, warnings, () => ScopeRules.Calls(ops, prefix, job, callables));
            Collect(problems, warnings, () => ScopeRules.Identifiers(ops, prefix, job, index, callables));
        }
        Collect(problems, warnings, () => ScopeRules.ProducerElements(ops, prefix, facts));
        Collect(problems, warnings, () => ScopeRules.Kinds(ops, prefix, job, facts.ModuleType ?? index?.ModuleType, lane));
        Collect(problems, warnings, () => ScopeRules.Destinations(ops, prefix, job));
        Collect(problems, warnings, () => ScopeRules.Properties(ops, prefix, job, facts, lane));
        // L3c: what the ODC platform refuses on every module of a kind (PreflightRules/OdcScopeRules).
        if (lane == "odc") Collect(problems, warnings, () => PreflightRules.OdcScopeRules.Check(ops, prefix, job, facts));
        foreach (var p in problems.Concat(warnings)) p["phase"] = Phase;
        // The roots: the ops the preflight refused and those this phase refuses; what they block is said once per root.
        var roots = RefusedOps(preflight ?? LastPreflight.Value, ops, prefix);
        foreach (var p in problems) if (p["op"] is JsonValue v && v.TryGetValue<int>(out var at)) roots.Add(at);
        problems.AddRange(BlockedProblems(job, roots, ops, prefix));
        var result = new Result(problems, normalizations, warnings, clock.ElapsedMilliseconds);
        Done.AddOrUpdate(facts, result);
        return result;
    }

    public const string ChildCreated = "OWNER_CHILD_CREATED";
    public const string IfClassRule = "IF_CLASS_MOVED";

    private static readonly HashSet<string> Wrappable = new(StringComparer.OrdinalIgnoreCase) { "div", "section", "article", "header", "footer", "nav", "main", "aside", "span", "p" };

    /// <summary>The If widget of this lane has no Style (the Studio's own answer: "IIfWidget.Style takes no expression here").
    /// L3c: the ODC If has none either (ModelTypes of the ODC Studio; lab 103, HTML_INVALID at apply on 22/10/2026).</summary>
    private static bool IfHasNoStyle(string lane) => lane is "o11" or "odc" && ModelTypes.Of("IIfWidget", lane) is { } facts && !facts.Knows("Style");

    /// <summary>The html with the class of every element with if= or else= moved to an element of the same tag around its
    /// content (the element keeps if/else and its other attributes), or null when there is none.</summary>
    internal static (string Html, int Count, List<string> Classes)? IfClassMoved(string html)
    {
        HtmlText text;
        try { text = HtmlText.Parse(html); } catch { return null; }
        var edits = new List<HtmlText.Edit>(); var classes = new List<string>();
        foreach (var e in text.Elements())
        {
            if (!Wrappable.Contains(e.Tag) || e.Find("if") == null && e.Find("else") == null || e.Find("class") is not { } cls) continue;
            var close = "</" + e.Tag + ">";
            var closeStart = e.End - close.Length;
            if (closeStart < e.OpenEnd || !string.Equals(html.Substring(closeStart, close.Length), close, StringComparison.OrdinalIgnoreCase)) continue;   // self-closed: left as is
            var start = cls.Start; while (start > 0 && html[start - 1] is ' ' or '\t' or '\n' or '\r') start--;
            edits.Add(new HtmlText.Edit(start, cls.End - start, ""));
            edits.Add(new HtmlText.Edit(e.OpenEnd, 0, $"<{e.Tag} class=\"{cls.Value}\">"));
            edits.Add(new HtmlText.Edit(closeStart, 0, $"</{e.Tag}>"));
            classes.Add(cls.Value);
        }
        return classes.Count == 0 ? null : (HtmlText.Apply(html, edits), classes.Count, classes);
    }


    /// <summary>The children by position a widget type is never born with (the Studio creates it empty), and that the job reads
    /// as written (`$link/#ITextWidget`): the evidence of the receipts (11-24/10/2026: ILinkWidget/#ITextWidget 133 refusals,
    /// none accepted). A child any accepted job read without creating it (IButton/#ITextWidget, a screen's block instance)
    /// is not here.</summary>
    internal static readonly IReadOnlyDictionary<string, string[]> NotBorn = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["ILinkWidget"] = ["ITextWidget"],
    };

    /// <summary>R1 normalizations, with the base (JobNormalizer.WithBase): OWNER_CHILD_CREATED, the child by position a widget
    /// the job creates is never born with (NotBorn) and that no op creates before its first use: a create of that child is
    /// inserted right before that use (one reading: the author writes into the only child the element would have).</summary>
    public static List<JsonObject> Normalize(JsonArray ops, string? prefix, string lane, IBaseFacts facts)
    {
        var done = new List<JsonObject>();
        if (Off) return done;
        var job = ScopeJob.Of(ops);
        var inserts = new List<(int At, string Alias, string Type, string Use)>();
        var created = new HashSet<(string, string)>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            if (op["op"]?.ToString() == "create" && op["parent"]?.ToString() is { } parent && parent.StartsWith('$') && !parent.Contains('/'))
                created.Add((parent, KindNames.Normalize(op["type"]?.ToString() ?? "")));
            foreach (var key in new[] { "target", "parent" })
            {
                if (op[key]?.ToString() is not { } reference) continue;
                var m = System.Text.RegularExpressions.Regex.Match(reference, @"^(\$[\w.]+)/#(I\w+)(?:\[1\])?(?:/|$)");
                if (!m.Success || job.Reused.Contains(m.Groups[1].Value) || !job.Aliases.TryGetValue(m.Groups[1].Value, out var owner) || owner.Op >= i) continue;
                var child = m.Groups[2].Value;
                if (!NotBorn.TryGetValue(owner.Type, out var notBorn) || !notBorn.Contains(child) || !created.Add((owner.Alias!, child))) continue;
                inserts.Add((i, owner.Alias!, child, reference));
            }
        }
        // IF_CLASS_MOVED: the class of an element with if= (or else=) in a Reactive or Mobile module is the class of what it shows.
        if (facts.ModuleType is "CrossDevice" or "ReactiveLibrary" or "Mobile" or "MobileLibrary")
            for (var i = 0; i < ops.Count; i++)
            {
                if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html") continue;
                var (holder, key, at) = op["data"] is JsonObject data && data["html"] is JsonValue ? (data, "html", "/data/html") : op["html"] is JsonValue ? (op, "html", "/html") : (null, null, null);
                if (holder == null || holder[key!]?.ToString() is not { } html || !html.Contains("class=", StringComparison.Ordinal)) continue;
                if (IfClassMoved(html) is not { } moved || !IfHasNoStyle(lane)) continue;
                SentJob.HtmlBefore(holder, html);
                holder[key!] = moved.Html;
                done.Add(JobNormalizer.Entry(IfClassRule, prefix == null ? null : $"{prefix}/{i}{at}", $"<x if=\"...\" class=\"...\">", "<x if=\"...\"><x class=\"...\">...</x></x>",
                    $"{moved.Count} element(s) with if= and class= ({string.Join(", ", moved.Classes.Take(4))}): the If of this module has no Style, so the class goes on a container of what it shows"));
            }
        foreach (var (at, alias, type, _) in inserts.OrderByDescending(x => x.At))
        {
            var create = new JsonObject { ["op"] = "create", ["parent"] = alias, ["type"] = type };
            ops.Insert(at, create);
            SentJob.Inserted(create, prefix == null ? null : $"{prefix}/{at}");
        }
        // The entries point at the op that writes into the child, where it is now (TranslateEntries writes it as sent).
        var shifted = 0;
        foreach (var (at, alias, type, use) in inserts.OrderBy(x => x.At))
        {
            shifted++;
            done.Add(JobNormalizer.Entry(ChildCreated, prefix == null ? null : $"{prefix}/{at + shifted}", use, $"create {type} under {alias}, then {use}",
                $"{alias} is a {job.Aliases[alias].Type}, created without a {type} (the Studio does not give it one): the {type} is created right before op #{at} writes into it"));
        }
        return done;
    }

    /// <summary>Whether a base check found a problem of this phase (an error): JobRunner stops there, before the first op.</summary>
    public static bool Stops(IEnumerable<JsonObject> baseProblems)
        => baseProblems.Any(p => p["phase"]?.ToString() == Phase && p["severity"]?.ToString() is null or "error");

    /// <summary>The ops the apply never builds for the scope phase (JobRunner): each op a scope error names, and every op such
    /// an op blocks (SCOPE_BLOCKED_BY_REFUSED_OP's blockedOps).</summary>
    public static IReadOnlySet<int> SkippedOps(IEnumerable<JsonObject> baseProblems)
    {
        var skipped = new HashSet<int>();
        foreach (var p in baseProblems.Where(p => p["phase"]?.ToString() == Phase && p["severity"]?.ToString() is null or "error"))
        {
            if (p["op"] is JsonValue v && v.TryGetValue<int>(out var op)) skipped.Add(op);
            foreach (var blocked in (p["blockedOps"] as JsonArray ?? []).OfType<JsonValue>())
                if (blocked.TryGetValue<int>(out var b)) skipped.Add(b);
        }
        return skipped;
    }

    /// <summary>The single refusal of a job the scope phase stops before its first op: the problems of the preflight and of
    /// the base check (scope included), in the format of every refusal; the apply and the Verify did not run.</summary>
    public static JobPreflightException Refusal(JsonObject? preflight, IReadOnlyList<JsonObject> baseProblems, IReadOnlyList<string>? baseLines = null)
    {
        var all = new List<JsonObject>();
        foreach (var p in (preflight?["problems"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var copy = p.DeepClone().AsObject();
            copy["phase"] ??= "preflight";
            all.Add(copy);
        }
        all.AddRange(baseProblems);
        var lines = (preflight?["errors"] as JsonArray ?? []).Select(e => e?.ToString()).OfType<string>()
            .Concat(baseLines ?? baseProblems.Select(JobPreflight.Text).ToList()).ToList();
        var warnings = new JsonArray((preflight?["warnings"] as JsonArray ?? []).Select(w => w?.DeepClone()).ToArray());
        return new JobPreflightException(string.Join(Environment.NewLine, lines), new JsonArray(all.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()), warnings)
        {
            VerifyRan = false,
            VerifyReason = "the scope phase found what the job names and the module does not have, before the first op: the apply and the Verify did not run; fix the problems of the phase scope and the next round builds the job",
            Phases = preflight != null ? ["preflight", "base", Phase] : ["base", Phase],
        };
    }

    /// <summary>A rule's problems (a rule that throws is a warning, never a refusal: PreflightChecks' contract).</summary>
    private static void Collect(List<JsonObject> problems, List<JsonObject> warnings, Func<IEnumerable<JsonObject>> rule)
    {
        try { foreach (var p in rule()) (p["severity"]?.ToString() == "warning" ? warnings : problems).Add(p); }
        catch (Exception ex) { warnings.Add(JobPreflight.Problem(null, null, "PREFLIGHT_RULE_FAILED", "warning", $"scope rule {rule.Method.Name} failed and was skipped: {Errors.Text(ex)}", null, null, "rule")); }
    }

    /// <summary>The current index of each op the preflight refused (its problems point into the job as sent).</summary>
    private static HashSet<int> RefusedOps(JsonObject? preflight, JsonArray ops, string? prefix)
    {
        var refused = new HashSet<int>();
        var sent = (preflight?["problems"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(p => p["severity"]?.ToString() is null or "error" && p["op"] is JsonValue v && v.TryGetValue<int>(out _))
            .Select(p => p["op"]!.GetValue<int>()).ToHashSet();
        if (sent.Count == 0) return refused;
        // An op the normalizations inserted at the top level is not one of the job as sent: skip it when counting.
        var position = 0;
        for (var i = 0; i < ops.Count; i++)
        {
            if (prefix != null && SentJob.ToSent($"{prefix}/{i}", ops, prefix) is { Exact: false }) continue;
            if (sent.Contains(position)) refused.Add(i);
            position++;
        }
        return refused;
    }

    private static IEnumerable<JsonObject> BlockedProblems(ScopeJob job, HashSet<int> roots, JsonArray ops, string? prefix)
    {
        foreach (var group in job.Blocked(roots).GroupBy(b => b.Value.Root).OrderBy(g => g.Key))
        {
            var root = group.Key;
            var names = group.SelectMany(b => b.Value.Names).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var blockedOps = group.Select(b => b.Key).Order().ToList();
            var problem = JobPreflight.Problem(root, prefix == null ? null : $"{prefix}/{root}", Blocked, "error",
                $"op #{root} ({job.Ops[root].Kind}) is refused, and {blockedOps.Count} op(s) after it need what it declares ({Short(names)}): ops {Short(blockedOps.Select(o => "#" + o))}; none of them can be built until op #{root} is",
                $"fix the problems of op #{root}; the ops it blocks need no change", null, "scope");
            problem["phase"] = Phase;
            problem["rule"] = Blocked;
            problem["blocks"] = blockedOps.Count;
            problem["blockedOps"] = new JsonArray(blockedOps.Select(o => (JsonNode)o).ToArray());
            yield return problem;
        }
    }

    internal static string Short(IEnumerable<string> names)
    {
        var list = names.ToList();
        return string.Join(", ", list.Take(8)) + (list.Count > 8 ? $", ... ({list.Count})" : "");
    }
}
