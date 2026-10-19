using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core.Preflight;

namespace Anvil.Core;

public static partial class JobRunner
{
    // Patches target the document sent by the author, not its resolved execution copy.
    // Relative-source provenance is disclosed separately, preserving bindings and array shape.
    internal static JsonNode AutoPatchSource(JsonNode sentJob, JsonArray resolvedOps, string resolvedBase)
    {
        return sentJob.DeepClone();
    }

    internal static JsonObject AutoPatchReceipt(AutoPatchResult outcome, JsonNode original, string outPath, JsonArray? priorNotes, long elapsedMs, JsonArray? normalizedOps = null, string? sourceDirectory = null)
    {
        var answer = JsonSerializer.SerializeToNode(outcome.Result, Json.Compact)!.AsObject();
        var applied = new JsonArray();
        var current = original.DeepClone();
        if (normalizedOps != null)
        {
            if (current is JsonObject obj) obj["ops"] = normalizedOps.DeepClone();
            else current = normalizedOps.DeepClone();
        }
        var beforePatches = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        var notes = answer["normalizations"] as JsonArray ?? new JsonArray();
        if (priorNotes != null)
            foreach (var prior in priorNotes.OfType<JsonObject>())
                if (!notes.OfType<JsonObject>().Any(n => JobNormalizer.Same(n, prior))) notes.Add(prior.DeepClone());
        foreach (var problem in outcome.Problems)
        {
            var patch = problem["patch"]!.AsArray();
            var identity = patch.ToJsonString();
            if (!beforePatches.TryGetValue(identity, out var beforePatch))
            {
                beforePatches[identity] = beforePatch = current.DeepClone();
                current = Patched(current, patch) ?? throw new InvalidOperationException("the accepted patch no longer applies to its sent source");
            }
            var before = new List<string>(); var after = new List<string>();
            foreach (var step in patch.OfType<JsonObject>())
            {
                if (step["op"]?.ToString() == "test") continue;
                var path = step["path"]?.ToString() ?? "";
                var old = PatchValue(beforePatch, path)?.ToString() ?? "";
                var now = step["value"]?.ToString() ?? "";
                var focus = problem["line"] is JsonValue line && line.TryGetValue<int>(out var n)
                    && (path.EndsWith("/data/html", StringComparison.Ordinal) || path.Contains("/data/flow", StringComparison.Ordinal)) ? n : (int?)null;
                var argument = problem["patchFocus"]?["argument"]?.ToString();
                var nodeName = problem["patchFocus"]?["node"]?.ToString();
                var callee = problem["patchFocus"]?["callee"]?.ToString();
                var positions = argument != null && nodeName != null && callee != null
                    ? VerifySourceEdits.FlowArgumentColumns(old, now, nodeName, callee, argument) : null;
                var lines = ChangedPatchLines(old, now, focus);
                var left = string.Join("\n", lines.From); var right = string.Join("\n", lines.To);
                var column = problem["column"] is JsonValue col && col.TryGetValue<int>(out var c) ? c : 1;
                var attribute = problem["patchFocus"]?["attribute"]?.ToString();
                var window = PatchWindow(left, right, column, attribute, positions?.Before, positions?.After);
                before.Add(window.From); after.Add(window.To);
            }
            var joined = PatchWindow(string.Join("\n", before), string.Join("\n", after));
            var from = joined.From; var to = joined.To;
            if (from == to) throw new InvalidOperationException("the applied problem has no distinct before/after source window");
            var rule = problem["patchRule"]!.ToString();
            var reason = PatchCertainty.Reason(problem);
            var item = new JsonObject { ["code"] = problem["code"]?.DeepClone(), ["pointer"] = problem["pointer"]?.DeepClone(),
                ["phase"] = problem["phase"]?.DeepClone(), ["patchRule"] = rule, ["reason"] = reason,
                ["from"] = from, ["to"] = to, ["patchSha256"] = PatchHash(Encoding.UTF8.GetBytes(patch.ToJsonString())) };
            applied.Add(item);
            var note = JobNormalizer.Entry(rule, problem["pointer"]?.ToString(), from, to, reason);
            note["patchApplied"] = true;
            notes.Add(note);
        }
        var pathOfJob = Path.GetFullPath(outPath) + ".patched-job.json";
        var bytes = Encoding.UTF8.GetBytes(outcome.Document.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.WriteAllBytes(pathOfJob, bytes);
        answer["patchesApplied"] = applied;
        answer["normalizations"] = notes;
        answer["patchedJob"] = new JsonObject { ["path"] = pathOfJob, ["sha256"] = PatchHash(bytes) };
        if (sourceDirectory != null)
        {
            var sourcePath = pathOfJob + ".source.json";
            var sourceBytes = Encoding.UTF8.GetBytes(new JsonObject { ["jobSha256"] = PatchHash(bytes),
                ["sourceDirectory"] = Path.GetFullPath(sourceDirectory) }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.WriteAllBytes(sourcePath, sourceBytes);
            answer["patchedJob"]!["source"] = new JsonObject { ["path"] = sourcePath, ["sha256"] = PatchHash(sourceBytes) };
        }
        answer["autoPatch"] = new JsonObject { ["rounds"] = outcome.Rounds, ["elapsedMs"] = elapsedMs };
        return answer;
    }

    private static string PatchHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static (string From, string To) PatchWindow(string from, string to, int column = 1, string? attribute = null, int? beforeColumn = null, int? afterColumn = null)
    {
        var a = 0; var b = 0;
        if (beforeColumn is { } before && afterColumn is { } after)
        {
            a = Math.Clamp(before - 1, 0, from.Length); b = Math.Clamp(after - 1, 0, to.Length);
        }
        if (attribute != null)
        {
            var token = new System.Text.RegularExpressions.Regex(@"(?<![\w-])" + System.Text.RegularExpressions.Regex.Escape(attribute) + @"\s*=");
            var left = token.Match(from, Math.Clamp(column - 1, 0, from.Length));
            var right = token.Match(to, Math.Clamp(column - 1, 0, to.Length));
            if (left.Success && right.Success) { a = left.Index; b = right.Index; }
        }
        while (a < from.Length && b < to.Length && from[a] == to[b]) { a++; b++; }
        if (from.Length <= 160 && to.Length <= 160) return (from, to);
        return (Around(from, a), Around(to, b));

        static string Around(string value, int difference)
        {
            var start = Math.Max(0, difference - 75);
            var remaining = 160 - (start > 0 ? 1 : 0);
            var length = Math.Min(remaining, value.Length - start);
            if (start + length < value.Length) length--;
            return (start > 0 ? "…" : "") + value.Substring(start, length) + (start + length < value.Length ? "…" : "");
        }
    }

    private static JsonNode? PatchValue(JsonNode document, string pointer)
    {
        JsonNode? current = document;
        foreach (var token in pointer.Split('/').Skip(1).Select(t => t.Replace("~1", "/").Replace("~0", "~")))
            current = current switch { JsonObject obj => obj[token], JsonArray array when int.TryParse(token, out var i) && i >= 0 && i < array.Count => array[i], _ => null };
        return current;
    }

    // Only lines absent from the longest common subsequence are disclosed, never a whole-source replacement's body.
    internal static (IReadOnlyList<string> From, IReadOnlyList<string> To) ChangedPatchLines(string from, string to, int? focusLine = null)
    {
        var left = from.Replace("\r\n", "\n").Split('\n'); var right = to.Replace("\r\n", "\n").Split('\n');
        var common = new int[left.Length + 1, right.Length + 1];
        for (var i = left.Length - 1; i >= 0; i--)
            for (var j = right.Length - 1; j >= 0; j--)
                common[i, j] = left[i] == right[j] ? common[i + 1, j + 1] + 1 : Math.Max(common[i + 1, j], common[i, j + 1]);
        var removed = new List<string>(); var added = new List<string>();
        var runs = new List<(int Start, int End, List<string> From, List<string> To)>();
        int? start = null; var removedRun = new List<string>(); var addedRun = new List<string>();
        void EndRun(int at)
        {
            if (start == null) return;
            runs.Add((start.Value, at, removedRun, addedRun)); start = null; removedRun = []; addedRun = [];
        }
        var a = 0; var b = 0;
        while (a < left.Length || b < right.Length)
        {
            if (a < left.Length && b < right.Length && left[a] == right[b]) { EndRun(a); a++; b++; }
            else if (a < left.Length && (b == right.Length || common[a + 1, b] >= common[a, b + 1]))
            { start ??= a; removedRun.Add(left[a]); removed.Add(left[a++]); }
            else { start ??= a; addedRun.Add(right[b]); added.Add(right[b++]); }
        }
        EndRun(a);
        if (focusLine is { } focus && runs.FirstOrDefault(r => focus - 1 >= r.Start && focus - 1 < r.End) is { From: not null } selected)
        {
            var offset = focus - 1 - selected.Start;
            return (selected.From.Skip(offset).Take(1).ToList(), selected.To.Skip(Math.Min(offset, Math.Max(0, selected.To.Count - 1))).Take(1).ToList());
        }
        return (removed, added);
    }
}
