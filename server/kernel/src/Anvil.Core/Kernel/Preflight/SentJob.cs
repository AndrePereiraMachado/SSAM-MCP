using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// motor2 review (2026-10-12): the answer speaks of the job as the author sent it, never of the job the kernel normalized.
/// The normalizations edit the ops in place (a step inserted first, an action added, a key renamed, a text made a list), and
/// every rule, the apply and the Verify then point into that normalized job; the model applies the pointers and the patches
/// to the job it has. A probe of the review: a SetInitialValues inserted before the Download of ExportarPDF moved the
/// NODE_NOT_ALLOWED pointer one step down, and its patch replaced the assign after it. Each normalization that changes the
/// shape marks what it wrote here (weakly, on the nodes themselves: a fresh read of the job has no marks), and
/// <see cref="Translate"/> writes every pointer and patch path of an answer back into the job as sent:
/// <list type="bullet">
/// <item>a node inserted into an array (a step, an action) is not counted in the indices after it, and a pointer into it is
/// its origin (the default it came from), never a patch path (a patch into it is dropped: it has no place in the sent job);</item>
/// <item>a node written in place of the one sent (a sort text made a list, the call of a patch applied for the diagnosis)
/// keeps the place; a pointer inside it is that place;</item>
/// <item>a renamed key (an assignment of a renamed output, a renamed argument) is written as sent.</item>
/// </list>
/// An html the kernel normalized together with another op (a default moved to an OnInitialize of the logic op) carries that
/// other change as the companion of any patch that writes the html whole, so the patched job is whole too.
/// </summary>
public static class SentJob
{
    private sealed record Mark(string? Origin, bool Inserted);

    private static readonly ConditionalWeakTable<JsonNode, Mark> Marks = new();
    private static readonly ConditionalWeakTable<JsonObject, Dictionary<string, string>> Keys = new();
    private static readonly ConditionalWeakTable<JsonObject, StrongBox<string>> Htmls = new();
    private sealed record Change(string Op, string Path, JsonNode Value);
    private static readonly ConditionalWeakTable<JsonObject, List<Change>> Companions = new();

    /// <summary>A node a normalization inserted into an array; <paramref name="origin"/>: the pointer (in the job as sent) of
    /// what it came from, null for the array that holds it.</summary>
    public static void Inserted(JsonNode node, string? origin) => Marks.AddOrUpdate(node, new Mark(origin, true));

    /// <summary>A node written in place of the one sent, at the same index or key; <paramref name="origin"/> null: that place.</summary>
    public static void Replaced(JsonNode node, string? origin = null) => Marks.AddOrUpdate(node, new Mark(origin, false));

    /// <summary>A key of <paramref name="holder"/> renamed from <paramref name="from"/> to <paramref name="to"/>.</summary>
    public static void KeyRenamed(JsonObject holder, string from, string to)
    {
        var map = Keys.GetValue(holder, _ => new Dictionary<string, string>(StringComparer.Ordinal));
        var sent = map.TryGetValue(from, out var older) ? older : from;
        map.Remove(from);
        if (!string.Equals(sent, to, StringComparison.Ordinal)) map[to] = sent;
    }

    /// <summary>The html of <paramref name="holder"/> as sent, kept before its first normalization.</summary>
    public static void HtmlBefore(JsonObject holder, string sent)
    {
        if (!Htmls.TryGetValue(holder, out _)) Htmls.AddOrUpdate(holder, new StrongBox<string>(sent));
    }

    /// <summary>The html of <paramref name="holder"/> as the author sent it (null when no normalization changed it).</summary>
    public static string? HtmlAsSent(JsonObject holder) => Htmls.TryGetValue(holder, out var box) ? box.Value : null;

    /// <summary>A change of another op that comes with the normalized html of <paramref name="holder"/>: a JSON Patch op over
    /// the job as sent (<paramref name="path"/>), whose value is the node the normalization wrote (read when the patch is
    /// written, so it carries what later normalizations did to it).</summary>
    public static void Companion(JsonObject holder, string op, string path, JsonNode value)
        => Companions.GetValue(holder, _ => []).Add(new Change(op, path, value));

    /// <summary>The pointer in the job as sent, and whether it is exact (false: it lands on the origin of a node the kernel
    /// added, or inside a node it wrote in place).</summary>
    public static (string? Pointer, bool Exact) ToSent(string? pointer, JsonArray ops, string? prefix)
    {
        if (pointer == null || prefix == null) return (pointer, true);
        if (!(pointer == prefix || pointer.StartsWith(prefix + "/", StringComparison.Ordinal))) return (pointer, true);
        var rest = pointer[prefix.Length..];
        if (rest.Length == 0) return (pointer, true);
        var segments = rest[1..].Split('/');
        var written = new StringBuilder(prefix);
        JsonNode? node = ops;
        for (var k = 0; k < segments.Length; k++)
        {
            var raw = segments[k];
            var key = raw.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal);
            var last = k == segments.Length - 1;
            switch (node)
            {
                case JsonArray array when int.TryParse(key, out var index) && index >= 0:
                {
                    var shift = 0;
                    for (var n = 0; n < Math.Min(index, array.Count); n++)
                        if (array[n] is { } before && Marks.TryGetValue(before, out var b) && b.Inserted) shift++;
                    var place = written + "/" + (index - shift);
                    if (index < array.Count && array[index] is { } child && Marks.TryGetValue(child, out var mark))
                        return mark.Inserted ? (mark.Origin ?? written.ToString(), false) : (mark.Origin ?? place, last);
                    written.Append('/').Append(index - shift);
                    node = index < array.Count ? array[index] : null;
                    break;
                }
                case JsonObject obj:
                {
                    var child = obj[key];
                    var sentKey = Keys.TryGetValue(obj, out var map) && map.TryGetValue(key, out var s) ? s : key;
                    var place = written + "/" + Escape(sentKey);
                    if (child != null && Marks.TryGetValue(child, out var mark))
                        return mark.Inserted ? (mark.Origin ?? written.ToString(), false) : (mark.Origin ?? place, last);
                    written.Append('/').Append(Escape(sentKey));
                    node = child;
                    break;
                }
                default:
                    written.Append('/').Append(raw);
                    node = null;
                    break;
            }
        }
        return (written.ToString(), true);
    }

    private static string Escape(string key) => key.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    /// <summary>The node at a pointer of the normalized job, with its holder and key (null when it does not resolve).</summary>
    private static (JsonObject? Holder, string? Key) Holder(string? pointer, JsonArray ops, string prefix)
    {
        if (pointer == null || !pointer.StartsWith(prefix + "/", StringComparison.Ordinal)) return (null, null);
        var segments = pointer[(prefix.Length + 1)..].Split('/').Select(s => s.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal)).ToArray();
        JsonNode? node = ops;
        for (var k = 0; k < segments.Length - 1 && node != null; k++)
            node = node switch
            {
                JsonObject o => o[segments[k]],
                JsonArray a when int.TryParse(segments[k], out var i) && i >= 0 && i < a.Count => a[i],
                _ => null,
            };
        return node is JsonObject holder ? (holder, segments[^1]) : (null, null);
    }

    /// <summary>The problem's pointer and patch written into the job as sent (in place). A problem whose patch is already
    /// over the job as sent (<c>_sentPatch</c>) keeps it. A patch with a path that has no exact place in the sent job is
    /// dropped (the fix says why); a patch that writes an html normalized with another op carries that op's change.</summary>
    public static void Translate(JsonObject problem, JsonArray ops, string? prefix)
    {
        if (prefix == null) return;
        if (problem["pointer"] is JsonValue pv && pv.TryGetValue<string>(out var pointer)) problem["pointer"] = ToSent(pointer, ops, prefix).Pointer;
        if (problem["patch"] is not JsonArray patch || problem["_sentPatch"] is JsonValue) return;
        var steps = new JsonArray();
        var exact = true;
        foreach (var step in patch.OfType<JsonObject>())
        {
            var copy = step.DeepClone().AsObject();
            foreach (var key in new[] { "path", "from" })
                if (copy[key] is JsonValue v && v.TryGetValue<string>(out var at))
                {
                    var (sent, ok) = ToSent(at, ops, prefix);
                    exact &= ok;
                    copy[key] = sent;
                }
            steps.Add(copy);
            if (copy["op"]?.ToString() == "replace" && Holder(step["path"]?.ToString(), ops, prefix) is { Holder: { } holder, Key: "html" }
                && Companions.TryGetValue(holder, out var extra))
                foreach (var change in extra)
                {
                    var companion = new JsonObject { ["op"] = change.Op, ["path"] = change.Path, ["value"] = change.Value.DeepClone() };
                    if (!steps.Any(s => JsonNode.DeepEquals(s, companion))) steps.Add(companion);
                }
        }
        if (exact) { problem["patch"] = steps; return; }
        problem["patch"] = null;
        var fix = problem["fix"]?.ToString();
        problem["fix"] = (string.IsNullOrEmpty(fix) ? "" : fix + " ") + "(no patch: its place is in what the kernel added when it normalized the job, which the job as sent does not have)";
    }

    /// <summary><see cref="Translate"/> for each problem of a list.</summary>
    public static void TranslateAll(IEnumerable<JsonObject> problems, JsonArray ops, string? prefix)
    {
        if (prefix == null) return;
        foreach (var p in problems) Translate(p, ops, prefix);
    }

    /// <summary>The paths of normalization entries written into the job as sent (an entry inside a node the kernel added
    /// is its origin).</summary>
    public static void TranslateEntries(IEnumerable<JsonObject> entries, JsonArray ops, string? prefix)
    {
        if (prefix == null) return;
        foreach (var e in entries)
            if (e["path"] is JsonValue v && v.TryGetValue<string>(out var path)) e["path"] = ToSent(path, ops, prefix).Pointer;
    }
}
