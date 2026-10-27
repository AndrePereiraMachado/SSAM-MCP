using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// T16 (one refusal carries every problem with a certain patch). Two facts the base gives before the first op, so they come
/// in the first refusal with the patch that answers them:
/// <list type="bullet">
/// <item>Rule 1: a raw create whose name an element of the same type already has under the same parent of the base. The apply
/// found it only after the Studio had renamed the newcomer (Name2), and every op that used its alias was skipped unjudged (70
/// ops behind one MainFlow). Now it is a base problem whose patch uses the existing element (the create becomes a read of it and
/// every use of its alias names it), or none when that patch cannot be written whole. The author has two ways out (use the
/// existing element, or another name) and the ops that depend on the create (its alias, transitively) can fail differently
/// under each (review of e10ecacc, R4): this round runs them under the other name (the Studio's free name), the patch round
/// (JobRunner.Probe) under the patch, and what each finds there is conditional on that choice: said under the collision, by
/// choice, never as a problem of its own, and the patch is never called proven. What both rounds find is the job's own.
/// When the job may change the element or its parent (a delete, a rename, a re-creation, a text that declares them: R2) the
/// collision is not certain from the base and the apply decides.</item>
/// <item>Rule 5: a DELETE_HAS_CONSUMERS of a one-exit flow node whose uses are only the connectors that reach it carries the
/// patch reconnect:true, the removal of that step.</item>
/// </list>
/// </summary>
public static partial class JobRunner
{
    /// <summary>The patch rule of a create that uses the existing element (Preflight.PatchCertainty).</summary>
    internal const string CreateUsesExisting = "CREATE_USES_EXISTING";
    /// <summary>The patch rule of reconnect:true on a delete of a one-exit flow node (Preflight.PatchCertainty).</summary>
    internal const string DeleteReconnects = "DELETE_RECONNECTS";
    private const string RenamedMark = "_renamedForDiagnosis";
    /// <summary>The choices of a create collision, as its conditional problems say them.</summary>
    internal const string OtherName = "another name", UseExisting = "the patch (use the existing element)";

    // The keys of a raw op that hold a reference, where an alias of the job is used whole or as the root of a path.
    private static readonly string[] ReferenceKeys = ["parent", "target", "from", "to", "value", "source"];
    // A create that writes nothing but its name: using the existing element instead keeps every later op's meaning.
    private static readonly HashSet<string> NameOnlyCreate = new(StringComparer.Ordinal) { "op", "parent", "type", "name", "as" };

    /// <summary>Rule 1: the creates of the job whose name an element of the same type has under the same parent of the base, as
    /// base problems (NAME_COLLISION at the op's name), each with the patch that uses the existing element when that patch is
    /// certain: the create writes nothing but its name, and every use of its alias is a reference value of a raw op (else the
    /// fix says what to do and the patch is null).</summary>
    private static List<JsonObject> CreateCollisions(ModelSession session, JsonArray ops, string? opsPointer)
    {
        var problems = new List<JsonObject>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject create || create["op"]?.ToString() != "create" || create["name"]?.ToString() is not { Length: > 0 } name
                || create["type"]?.ToString() is not { Length: > 0 } type || create["parent"]?.ToString() is not { Length: > 0 } parent
                || parent.StartsWith('$')) continue;
            if (session.ExistingChild(parent, type, name) is not { } found || session.UnsureAfterJob(ops, i, found.Existing)) continue;
            var alias = create["as"]?.ToString();
            var nameOnly = create.All(p => NameOnlyCreate.Contains(p.Key) || p.Key.StartsWith('_'));
            var uses = alias is { Length: > 0 } && opsPointer != null ? AliasUses(ops, i, alias, found.Reference, opsPointer) : (Steps: new JsonArray(), Complete: true);
            JsonArray? patch = null;
            if (opsPointer != null && nameOnly && uses.Complete)
            {
                patch = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = $"{opsPointer}/{i}", ["value"] = new JsonObject { ["op"] = "get", ["target"] = found.Reference } });
                foreach (var step in uses.Steps) patch.Add(step!.DeepClone());
            }
            var why = !nameOnly ? $"; no patch: the create also writes {string.Join(", ", create.Select(p => p.Key).Where(k => !NameOnlyCreate.Contains(k) && !k.StartsWith('_')))}, so using the existing element changes what it means"
                : !uses.Complete ? $"; no patch: {alias} is also used inside a text or a data of this job, which a reference rewrite cannot reach" : "";
            var problem = JobPreflight.Problem(i, opsPointer == null ? null : $"{opsPointer}/{i}/name", "NAME_COLLISION", "error",
                $"create {type} '{name}' under {found.Parent}: the module already has {found.Reference} there; the Studio would rename the new one to '{found.Rename}', and every op and expression of this job that names '{name}' would read the existing one",
                (patch != null ? $"use the existing {found.Reference}: read it in place of the create" + (uses.Steps.Count > 0 ? $" and point the {uses.Steps.Count} use(s) of {alias} at it" : "")
                    : $"use the existing {found.Reference} (write it where this job writes {alias ?? "the new element"}) and drop the create") + $", or give the new element another name{why}",
                patch, "create", patch != null ? CreateUsesExisting : null);
            problem["existing"] = found.Reference;
            problem["existingName"] = name;
            problem["existingKind"] = type.StartsWith('I') ? type[1..] : type;
            problem["freeName"] = found.Rename;
            var dependents = Dependents(ops, i);
            if (dependents.Count > 0) problem["dependents"] = new JsonArray(dependents.Select(d => (JsonNode)d).ToArray());
            problems.Add(problem);
        }
        return problems;
    }

    /// <summary>The patch steps that point every use of <paramref name="alias"/> (whole, or as the root of a path) at
    /// <paramref name="reference"/>, in the reference keys of the raw ops; Complete is false when the alias (with or without its
    /// $) is also written anywhere else in the job (a logic text, an html document, a data object, a description), which this
    /// rewrite does not reach.</summary>
    private static (JsonArray Steps, bool Complete) AliasUses(JsonArray ops, int creator, string alias, string reference, string opsPointer)
    {
        var steps = new JsonArray();
        var bare = alias.TrimStart('$');
        var token = new System.Text.RegularExpressions.Regex(@"(?<![\w])\$?" + System.Text.RegularExpressions.Regex.Escape(bare) + @"(?![\w])");
        var counted = 0;
        var total = 0;
        for (var j = 0; j < ops.Count; j++)
        {
            if (j == creator || ops[j] is not JsonObject op) continue;
            total += token.Matches(op.ToJsonString()).Count;
            foreach (var key in ReferenceKeys)
            {
                if (op[key] is not JsonValue v || !v.TryGetValue<string>(out var text)) continue;
                var root = text.IndexOf('/') is var slash && slash > 0 ? text[..slash] : text;
                if (root.TrimStart('$') != bare || token.Matches(text).Count != 1) continue;
                steps.Add(new JsonObject { ["op"] = "replace", ["path"] = $"{opsPointer}/{j}/{key}", ["value"] = reference + text[root.Length..] });
                counted++;
            }
        }
        return (steps, total == counted);
    }

    /// <summary>The ops that depend on the create <paramref name="create"/>: those that use its alias (whole, as the root of a
    /// path, or inside a text), then those that use the aliases these define, and so on.</summary>
    internal static List<int> Dependents(JsonArray ops, int create)
    {
        var aliases = new List<System.Text.RegularExpressions.Regex>();
        void Alias(JsonNode? op)
        {
            if (op?["as"]?.ToString() is { Length: > 0 } a)
                aliases.Add(new(@"(?<![\w])\$?" + System.Text.RegularExpressions.Regex.Escape(a.TrimStart('$')) + @"(?![\w])"));
        }
        Alias(ops[create]);
        var found = new SortedSet<int>();
        for (var grew = aliases.Count > 0; grew;)
        {
            grew = false;
            for (var j = 0; j < ops.Count; j++)
            {
                if (j == create || found.Contains(j) || ops[j] is not JsonObject op) continue;
                var json = op.ToJsonString();
                if (!aliases.Any(a => a.IsMatch(json))) continue;
                found.Add(j); Alias(op); grew = true;
            }
        }
        return found.ToList();
    }

    /// <summary>Rule 1, this round only: the create of each collision runs under the Studio's free name (the other way out), so
    /// what depends on it is judged; the pointers do not move (one value replaced in place). The job is refused for the collision;
    /// nothing is saved. What this round finds in those ops is conditional on that choice (<see cref="ConditionalOnChoice"/>).</summary>
    private static void RenameForDiagnosis(JsonArray ops, IEnumerable<JsonObject> problems, Action<string>? log)
    {
        foreach (var problem in problems.Where(p => p["code"]?.ToString() == "NAME_COLLISION" && p["freeName"] is JsonValue && p["op"] is JsonValue).ToList())
        {
            var op = problem["op"]!.GetValue<int>();
            if (op < 0 || op >= ops.Count || ops[op] is not JsonObject create || create["op"]?.ToString() != "create") continue;
            create["name"] = problem["freeName"]!.ToString();
            problem[RenamedMark] = true;
            log?.Invoke($"  NAME_COLLISION at {problem["pointer"]}: this round runs the create as '{problem["freeName"]}' (never saved)");
        }
    }

    /// <summary>Rule 1: what the apply and the Verify of this round found in a collision's create and its dependents, which ran
    /// under the other name, leaves the problems and is said under the collision (conditional, with that choice), until the patch
    /// round (the other choice) finds it too (<see cref="SplitByChoice"/>).</summary>
    private static List<JsonObject> ConditionalOnChoice(List<JsonObject> problems)
    {
        var collisions = problems.Where(p => p[RenamedMark] is JsonValue).ToList();
        if (collisions.Count == 0) return problems;
        var moved = new HashSet<JsonObject>(ReferenceEqualityComparer.Instance);
        foreach (var collision in collisions)
        {
            collision.Remove(RenamedMark);
            var list = collision["conditional"] as JsonArray ?? new JsonArray();
            foreach (var p in problems)
                if (!ReferenceEquals(p, collision) && !moved.Contains(p) && p["phase"]?.ToString() is "apply" or "verify"
                    && InScope(collision, p, collision["freeName"]!.ToString()))
                {
                    list.Add(Conditional(p, OtherName));
                    moved.Add(p);
                }
            if (list.Count > 0) collision["conditional"] = list;
        }
        return problems.Where(p => !moved.Contains(p)).ToList();
    }

    // The ops a collision's choice decides: the create and its dependents.
    private static HashSet<int> Scope(JsonObject collision)
        => (collision["dependents"] as JsonArray ?? []).Select(d => d!.GetValue<int>()).Append(collision["op"]!.GetValue<int>()).ToHashSet();

    /// <summary>Whether a problem is about what a collision's choice decides: in its create or a dependent op, or, a Verify message
    /// no op owns, on the element the choice makes (a level "Name (Kind)" of its path, Name the element as this round names it) or,
    /// in the round of the other name, naming that name at all (it is no name of the base: a caller that now lacks an argument of
    /// the new element, ODC sweep).</summary>
    private static bool InScope(JsonObject collision, JsonObject p, string name)
    {
        if (p["op"] is JsonValue v && v.TryGetValue<int>(out var op)) return Scope(collision).Contains(op);
        if (name == collision["freeName"]?.ToString() && System.Text.RegularExpressions.Regex.IsMatch(p["message"]?.ToString() ?? "",
            @"(?<![\w])" + System.Text.RegularExpressions.Regex.Escape(name) + @"(?![\w])")) return true;
        var kind = collision["existingKind"]?.ToString() ?? "";
        if (kind.Length == 0) return false;
        var level = name + " (" + kind + ")";
        var path = p["element"]?.ToString() ?? (p["message"]?.ToString() is { } m && m.LastIndexOf(" @ ", StringComparison.Ordinal) is var at and >= 0 ? m[(at + 3)..] : "");
        return path.Split(" / ").Any(l => string.Equals(l.Trim(), level, StringComparison.OrdinalIgnoreCase));
    }

    private static JsonObject Conditional(JsonObject p, string choice)
    {
        var entry = new JsonObject { ["if"] = choice };
        foreach (var field in new[] { "phase", "op", "pointer", "code", "severity", "message", "fix", "element", "key" })
            if (p[field] != null) entry[field] = p[field]!.DeepClone();
        return entry;
    }

    /// <summary>Rule 1, the patch round (JobRunner.Probe.Merge): a problem the round found in a collision's create or dependents is
    /// the job's own when the other choice found it too (it leaves the conditional list and joins <paramref name="certain"/>,
    /// bothChoices); else it is conditional on the patch. False when the problem is in no such op.</summary>
    internal static bool SplitByChoice(List<JsonObject> listed, JsonObject found, Func<JsonObject, string> signature, List<JsonObject> certain)
    {
        foreach (var collision in listed.Where(p => p["code"]?.ToString() == "NAME_COLLISION" && p["freeName"] is JsonValue && p["op"] is JsonValue))
        {
            var name = collision["existingName"]?.ToString() ?? "";
            if (!InScope(collision, found, name)) continue;
            var free = collision["freeName"]!.ToString();
            string Same(JsonObject p) => System.Text.RegularExpressions.Regex.Replace(signature(p), @"\b" + System.Text.RegularExpressions.Regex.Escape(free) + @"\b", name);
            var list = collision["conditional"] as JsonArray ?? new JsonArray();
            var mine = Same(found);
            var other = list.OfType<JsonObject>().FirstOrDefault(c => c["if"]?.ToString() == OtherName && Same(c) == mine);
            if (other != null)
            {
                list.Remove(other);
                var own = found.DeepClone().AsObject();
                own["bothChoices"] = true;
                certain.Add(own);
            }
            else if (!list.OfType<JsonObject>().Any(c => c["if"]?.ToString() == UseExisting && Same(c) == mine)) list.Add(Conditional(found, UseExisting));
            if (list.Count > 0) collision["conditional"] = list; else collision.Remove("conditional");
            return true;
        }
        return false;
    }

    /// <summary>Rule 5: each DELETE_HAS_CONSUMERS of the apply whose delete reconnect:true certainly removes (a one-exit flow node
    /// reached only by the connectors of its flow) carries that patch. The others keep their fix: the author chooses.</summary>
    private static void ReconnectPatches(ModelSession session, ModelSession.KeptApply kept, JsonArray ops, string? opsPointer)
    {
        if (opsPointer == null) return;
        var certain = new Dictionary<int, bool>();
        var patched = new List<JsonObject>();
        foreach (var problem in kept.Problems.Where(p => p["code"]?.ToString() == "DELETE_HAS_CONSUMERS" && p["patch"] is not JsonArray { Count: > 0 }))
        {
            if (problem["op"] is not JsonValue v || !v.TryGetValue<int>(out var op) || op < 0 || op >= ops.Count || ops[op] is not JsonObject delete) continue;
            if (!certain.TryGetValue(op, out var yes)) certain[op] = yes = session.ReconnectIsCertain(delete);
            if (!yes) continue;
            problem["patch"] = new JsonArray(new JsonObject { ["op"] = "add", ["path"] = $"{opsPointer}/{op}/reconnect", ["value"] = true });
            problem["patchRule"] = DeleteReconnects;
            problem["fix"] = "remove the step with reconnect:true: its incoming connectors move to its next node; or delete or rewrite the consumer earlier in this job";
            patched.Add(problem);
        }
        // A lone coded refusal keeps its own problems (its code, Errors.FindCoded): the same patch on each of them.
        if (patched.Count == 0 || kept.Refusal == null || Errors.FindCoded(kept.Refusal)?.Problems is not { } own) return;
        foreach (var problem in own.OfType<JsonObject>())
            if (patched.FirstOrDefault(p => p["code"]?.ToString() == problem["code"]?.ToString() && p["pointer"]?.ToString() == problem["pointer"]?.ToString()
                && p["message"]?.ToString() == problem["message"]?.ToString()) is { } same)
                foreach (var field in new[] { "patch", "patchRule", "fix" }) problem[field] = same[field]!.DeepClone();
    }
}
