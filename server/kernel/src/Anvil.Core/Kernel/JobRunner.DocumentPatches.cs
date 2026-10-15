using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// Integration 24-1 familias (review, 2026-10-13): one patch per document. A patch of an html document writes the whole text
/// (data.html, and data.css beside it): the preflight's (OPERAND_TYPES of an aggregate, ICON_UNKNOWN) over the html as sent, the
/// compile's over the document it compiled. Two problems of one document came with two whole texts, each with only its own
/// correction; applied together the last undid the first, and the next round refused the same problem again (a chain the
/// owner never accepts), while the call called itself verified. Now every problem of one html op carries the same patch: the
/// html as sent with every distinct edit of its patches applied (each edit read as the difference of that patch to the text as
/// sent; two edits at the same place that differ are two readings, and then no problem of that document has a patch), proved
/// before it is offered: the rules of the job alone pass on it (no problem of a code it corrected) and its compile, in this
/// session and with nothing kept, has no problem but the ones nothing corrects. The same as Union already did for the whole
/// data.flow of a logic text (WholeFlowPatch), for the texts of a document.
/// </summary>
public static partial class JobRunner
{
    private static bool DocumentText(string path) => path.EndsWith("/data/html", StringComparison.Ordinal) || path.EndsWith("/data/css", StringComparison.Ordinal);

    /// <summary>Gives every problem of one html op the one patch of that document (see the class), or none with the reason.</summary>
    internal static void DocumentPatches(List<JsonObject> problems, JsonArray ops, string? opsPointer, Func<int, string, string?, List<(string Code, string Message)>?>? compile, Action<string>? log)
    {
        if (opsPointer == null) return;
        // The problems of each document: those whose patch writes its html or its css (the op of the problem is the normalized one).
        var groups = new Dictionary<int, List<JsonObject>>();
        foreach (var p in problems)
        {
            if (p["patch"] is not JsonArray patch || p["op"] is not JsonValue v || !v.TryGetValue<int>(out var op)) continue;
            if (!patch.OfType<JsonObject>().Any(s => s["path"]?.ToString() is { } path && DocumentText(path) && s["value"] is JsonValue)) continue;
            if (!groups.TryGetValue(op, out var list)) groups[op] = list = [];
            list.Add(p);
        }
        foreach (var (op, members) in groups)
        {
            var steps = new List<JsonObject>();
            foreach (var p in members)
                foreach (var step in p["patch"]!.AsArray().OfType<JsonObject>())
                    if (!steps.Any(s => JsonNode.DeepEquals(s, step))) steps.Add(step);
            var byPath = steps.GroupBy(s => s["op"]?.ToString() + "\u0001" + s["path"]?.ToString()).ToList();
            if (byPath.All(g => g.Count() == 1))
            {
                // One value per path: the union is the patch of each problem (a problem with the html beside one with the css).
                if (members.Count > 1) foreach (var p in members) p["patch"] = new JsonArray(steps.Select(s => (JsonNode)s.DeepClone()).ToArray());
                continue;
            }
            // The problems of the same op without a patch: what the compile of the composed document may still find.
            var open = problems.Where(p => p["patch"] is not JsonArray && p["op"] is JsonValue ov && ov.TryGetValue<int>(out var at) && at == op && p["severity"]?.ToString() != "warning")
                .Select(p => (p["code"]?.ToString() ?? "", p["message"]?.ToString() ?? "")).ToList();
            var why = Compose(op, members, steps, open, ops, opsPointer, compile, out var composed);
            if (composed != null)
            {
                var joins = members.Select(m => m["patch"]!.ToJsonString()).Distinct(StringComparer.Ordinal).Count();
                foreach (var p in members) { p["patch"] = composed.DeepClone(); p["patchJoins"] = joins; }
                log?.Invoke($"  op #{op}: one patch of the document for {members.Count} problem(s), proved by its compile");
                continue;
            }
            foreach (var p in members)
            {
                p["patch"] = null;
                var fix = p["fix"]?.ToString();
                p["fix"] = (string.IsNullOrEmpty(fix) ? "" : fix + " ") + "(no patch: " + why + ")";
            }
            log?.Invoke($"  op #{op}: the corrections of the document were not composed: {why}");
        }
    }

    private static string Compose(int op, List<JsonObject> members, List<JsonObject> steps, List<(string Code, string Message)> open, JsonArray ops, string opsPointer,
        Func<int, string, string?, List<(string Code, string Message)>?>? compile, out JsonArray? composed)
    {
        composed = null;
        if (op < 0 || op >= ops.Count || ops[op]?["data"] is not JsonObject holder) return "its op is not an html op of the job";
        var texts = new Dictionary<string, string>(StringComparer.Ordinal);
        var result = new List<JsonObject>();
        foreach (var group in steps.GroupBy(s => s["path"]?.ToString() ?? ""))
        {
            var path = group.Key;
            var values = group.ToList();
            if (values.Count == 1) { result.Add(values[0].DeepClone().AsObject()); continue; }
            if (!DocumentText(path) || values.Any(s => s["value"] is not JsonValue sv || !sv.TryGetValue<string>(out _) || s["op"]?.ToString() is not ("replace" or "add")))
                return $"two patches of this document write different values at {path}";
            var key = path.EndsWith("/data/html", StringComparison.Ordinal) ? "html" : "css";
            if (Preflight.SentJob.ToSent($"{opsPointer}/{op}/data/{key}", ops, opsPointer).Pointer != path) return $"{path} is not the {key} of op #{op} as sent";
            var sent = key == "html" ? Preflight.SentJob.HtmlAsSent(holder) ?? holder["html"]?.ToString() ?? "" : holder["css"]?.ToString() ?? "";
            var edits = new List<TextDiff.Edit>();
            foreach (var value in values.Select(s => s["value"]!.GetValue<string>()).Distinct(StringComparer.Ordinal))
            {
                if (TextDiff.Edits(sent, value) is not { } own) return $"the corrections of {key} differ too much from the text as sent to be read as edits";
                // The edits of one correction inside one tag or one run of text are one change of that place (a value
                // quoted is one edit, not two quotes): two corrections of the same place that differ are two readings.
                edits.AddRange(TextDiff.Hunks(sent, own));
            }
            if (TextDiff.Apply(sent, edits) is not { } joined) return $"two corrections of the {key} edit the same place differently (two readings)";
            texts[key] = joined;
            result.Add(new JsonObject { ["op"] = values.Any(s => s["op"]?.ToString() == "replace") ? "replace" : "add", ["path"] = path, ["value"] = joined });
        }
        // The proof: the rules of the job alone and the compile, on the job with the composed texts (normalized as the apply would).
        var clone = ops.DeepClone().AsArray();
        var data = clone[op]!["data"]!.AsObject();
        if (texts.TryGetValue("html", out var html)) data["html"] = html;
        if (texts.TryGetValue("css", out var css)) data["css"] = css;
        try { Preflight.JobNormalizer.Pure(clone, opsPointer, MessageExpectations.Lane); } catch (Exception) { /* the rules below judge it as written */ }
        var corrected = members.Where(p => p["patch"] is JsonArray).Select(p => p["code"]?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var rules = Preflight.PreflightChecks.Pure(clone, opsPointer, MessageExpectations.Lane, []);
        var unpatched = open.Select(o => o.Code).ToList();
        foreach (var left in rules.Problems.Where(p => p["op"] is JsonValue pv && pv.TryGetValue<int>(out var at) && at == op && corrected.Contains(p["code"]?.ToString() ?? "")))
            if (!unpatched.Remove(left["code"]!.ToString())) return $"the composed document still has {left["code"]}";
        if (compile == null) return "its compile could not run";
        var htmlNow = data["html"]?.ToString() ?? "";
        var cssNow = data["css"] is JsonValue cv && cv.TryGetValue<string>(out var c) ? c : null;
        if (compile(op, htmlNow, cssNow) is not { } remaining) return "its compile could not run";
        // What the compile still finds must be a problem of this refusal that nothing corrects (same code, or the Verify's id named).
        foreach (var (code, message) in remaining)
        {
            var match = open.FirstOrDefault(o => o.Code == code || message.Contains(o.Code, StringComparison.Ordinal));
            if (match == default) return $"its compile finds {code}: {Clip(message)}";
            open.Remove(match);
        }
        composed = new JsonArray(result.Select(s => (JsonNode)s).ToArray());
        return "";
    }
}

/// <summary>The edits that turn one text into another (Myers' difference, characters, its common ends first), and a set of
/// edits of the same text applied together when no two of them touch the same place differently.</summary>
internal static class TextDiff
{
    internal readonly record struct Edit(int Start, int Length, string Text);

    /// <summary>The edits from <paramref name="a"/> to <paramref name="b"/>, or null past <paramref name="maxCost"/> characters of difference.</summary>
    public static List<Edit>? Edits(string a, string b, int maxCost = 3000)
    {
        var limit = Math.Min(a.Length, b.Length);
        var pre = 0;
        while (pre < limit && a[pre] == b[pre]) pre++;
        var suf = 0;
        while (suf < limit - pre && a[a.Length - 1 - suf] == b[b.Length - 1 - suf]) suf++;
        int n = a.Length - pre - suf, m = b.Length - pre - suf;
        if (n == 0 && m == 0) return [];
        if (n == 0 || m == 0) return [new(pre, n, b.Substring(pre, m))];
        var max = n + m;
        var off = max + 1;
        var v = new int[2 * max + 3];
        var trace = new List<int[]>();
        var found = -1;
        for (var d = 0; d <= Math.Min(max, maxCost) && found < 0; d++)
        {
            var snapshot = new int[2 * d + 1];
            for (var k = -d; k <= d; k += 2)
            {
                var x = k == -d || k != d && v[off + k - 1] < v[off + k + 1] ? v[off + k + 1] : v[off + k - 1] + 1;
                var y = x - k;
                while (x < n && y < m && a[pre + x] == b[pre + y]) { x++; y++; }
                v[off + k] = x;
                if (x >= n && y >= m) { found = d; break; }
            }
            for (var k = -d; k <= d; k++) snapshot[k + d] = v[off + k];
            trace.Add(snapshot);
        }
        if (found < 0) return null;
        // Back from the end: each step is the insertion of b[y] at x, or the deletion of a[x].
        var steps = new List<(int X, int Y, bool Insert)>();
        int cx = n, cy = m;
        for (var d = found; d > 0; d--)
        {
            var prev = trace[d - 1];
            var k = cx - cy;
            int Prev(int kk) => prev[kk + d - 1];
            var down = k == -d || k != d && Prev(k - 1) < Prev(k + 1);
            var prevK = down ? k + 1 : k - 1;
            var px = Prev(prevK); var py = px - prevK;
            steps.Add((px, py, down));
            cx = px; cy = py;
        }
        steps.Reverse();
        var edits = new List<Edit>();
        int start = -1, length = 0; var text = new System.Text.StringBuilder();
        void Flush() { if (start >= 0) edits.Add(new(pre + start, length, text.ToString())); start = -1; length = 0; text.Clear(); }
        foreach (var (x, y, insert) in steps)
        {
            if (start < 0 || x != start + length) { Flush(); start = x; }
            if (insert) text.Append(b[pre + y]); else length++;
        }
        Flush();
        return edits;
    }

    /// <summary>The edits of one change joined where nothing but the same tag or the same run of text lies between them (no '&lt;',
    /// '&gt;' or line break in the text kept between two edits): one place, one edit.</summary>
    public static List<Edit> Hunks(string a, IReadOnlyList<Edit> edits)
    {
        var hunks = new List<Edit>();
        foreach (var e in edits.OrderBy(e => e.Start))
        {
            if (hunks.Count > 0 && hunks[^1] is var last && last.Start + last.Length <= e.Start
                && a[(last.Start + last.Length)..e.Start].IndexOfAny(['<', '>', '\n']) < 0)
            {
                hunks[^1] = new(last.Start, e.Start + e.Length - last.Start, last.Text + a[(last.Start + last.Length)..e.Start] + e.Text);
                continue;
            }
            hunks.Add(e);
        }
        return hunks;
    }

    /// <summary>The text with every distinct edit applied, or null when two of them touch the same place differently.</summary>
    public static string? Apply(string text, IEnumerable<Edit> all)
    {
        var edits = all.Distinct().OrderBy(e => e.Start).ThenBy(e => e.Length).ToList();
        for (var i = 1; i < edits.Count; i++)
        {
            var (a, b) = (edits[i - 1], edits[i]);
            if (b.Start < a.Start + a.Length || b.Start == a.Start) return null;
        }
        var sb = new System.Text.StringBuilder(text);
        for (var i = edits.Count - 1; i >= 0; i--)
        {
            var e = edits[i];
            if (e.Start + e.Length > sb.Length) return null;
            sb.Remove(e.Start, e.Length).Insert(e.Start, e.Text);
        }
        return sb.ToString();
    }
}
