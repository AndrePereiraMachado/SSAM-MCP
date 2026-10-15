using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>
/// I4 of the atritos 2 package: a method that refuses with a coded exception (<see cref="ICodedError"/>, e.g.
/// <see cref="KernelRefusalException"/>) carries one problem per fault, each pointer relative to the JSON node the method
/// received and starting with '/' (or ""). The caller rebases those pointers onto the job: the op (HtmlVisual.PreflightOp),
/// its data (HtmlExpander.Preflight, LogicExpander.Expand) or, for the one-action envelope the preflight builds, the action
/// inside the op (`/actions/0` becomes `/ops/i/data/actions/k`). A pointer that is not a JSON pointer (the model path of a
/// consumer that DELETE_HAS_CONSUMERS names) is kept as written; in a composite job (no exact pointer) it becomes null.
/// </summary>
public static class CodedProblems
{
    /// <summary>The problems of a coded exception rebased onto the job, or null when the exception carries none (then the
    /// caller keeps its one-problem form). <paramref name="basePointer"/>: the pointer of the node the thrower received, null
    /// in a composite job; <paramref name="swapFrom"/>/<paramref name="swapTo"/>: a relative prefix replaced instead of
    /// prefixed (the one-action envelope); <paramref name="phase"/>: I6, written when the problem names none.</summary>
    public static List<JsonObject>? From(Exception ex, int op, string kind, string? basePointer, string? swapFrom = null, string? swapTo = null, string? phase = null)
    {
        if (Errors.FindCoded(ex) is not { Problems: { Count: > 0 } list } coded) return null;
        var result = new List<JsonObject>();
        foreach (var node in list.OfType<JsonObject>())
        {
            var problem = node.DeepClone().AsObject();
            var relative = problem["pointer"] is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;
            problem["op"] = op;
            problem["pointer"] = Rebase(relative, basePointer, swapFrom, swapTo);
            if (problem["code"] is not JsonValue c || !c.TryGetValue<string>(out var code) || code.Length == 0) problem["code"] = coded.Code;
            if (problem["severity"]?.ToString() is not ("error" or "warning")) problem["severity"] = "error";
            problem["message"] = OneLine(problem["message"]?.ToString() ?? coded.Code);
            // Every problem carries a fix (I2): one the thrower gave none gets what its message names, else its grammar's.
            var message = problem["message"]!.ToString();
            var supplied = problem["fix"] is JsonValue f && f.TryGetValue<string>(out var fix) && !string.IsNullOrWhiteSpace(fix) ? OneLine(fix) : null;
            // Preserve a thrower's specific correction, but never preserve a stale op-grammar fallback in place of
            // advice for a known code. A logic wrapper can expose a data/property/name error just as the raw verb does.
            if (supplied != null && JobPreflight.CodeFix(problem["code"]!.ToString()) != null && GrammarFixes.Contains(supplied)) supplied = null;
            problem["fix"] = JobPreflight.FixFrom(message)
                ?? supplied ?? JobPreflight.FixFor(problem["code"]!.ToString(), kind, message);
            var advice = message.IndexOf(" Fix: ", StringComparison.Ordinal);
            if (advice >= 0) problem["message"] = message[..advice].TrimEnd();
            if (problem["patch"] is JsonArray patch) problem["patch"] = basePointer == null ? null : RebasePatch(patch, basePointer, swapFrom, swapTo);
            if (phase != null && problem["phase"] == null) problem["phase"] = phase;
            problem["_kind"] = kind;
            result.Add(problem);
        }
        return result;
    }

    /// <summary>A relative pointer onto the job. Null relative: the node itself. Not a JSON pointer: kept.</summary>
    public static string? Rebase(string? relative, string? basePointer, string? swapFrom = null, string? swapTo = null)
    {
        if (relative != null && relative.Length > 0 && relative[0] != '/') return relative;
        if (basePointer == null) return null;
        // The node itself: in the one-action envelope that is the action, not the envelope.
        if (relative == null || relative.Length == 0) return swapTo ?? basePointer;
        if (swapFrom != null && swapTo != null && swapFrom.Length > 0 && (relative == swapFrom || relative.StartsWith(swapFrom + "/", StringComparison.Ordinal)))
            return swapTo + relative[swapFrom.Length..];
        return basePointer + relative;
    }

    private static JsonArray RebasePatch(JsonArray patch, string basePointer, string? swapFrom, string? swapTo)
    {
        var copy = patch.DeepClone().AsArray();
        foreach (var step in copy.OfType<JsonObject>())
            foreach (var key in new[] { "path", "from" })
                if (step[key] is JsonValue v && v.TryGetValue<string>(out var at) && (at.Length == 0 || at[0] == '/'))
                    step[key] = Rebase(at, basePointer, swapFrom, swapTo);
        return copy;
    }

    private static string OneLine(string text) => Regex.Replace(text, @"\s*[\r\n]+\s*", " ").Trim();

    private static readonly HashSet<string> GrammarFixes = new(new[] { "logic", "spec", "html", "html-visual", "sql", "data", "verbs" }
        .Select(JobPreflight.DefaultFix), StringComparer.Ordinal);
}
