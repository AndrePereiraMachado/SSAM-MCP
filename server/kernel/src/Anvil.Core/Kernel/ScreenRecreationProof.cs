using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The acceptance of B1 over one capture (plan "Texto do SSAM", section 8): every screen (and, asked, every block) read by
/// C1 and compiled again by the document form in the loaded copy without it (ModelSession.RecreateFromReading). Per root:
/// recreated or refused (with every problem), the text read again equal to the text read before (the keys of the
/// re-created elements mapped by k: equal facts of every element, a MatchTree without keys), and, asked, the Verify with
/// no new error. One load per capture; the roots run one after the other on the same copy (each recreation is the same
/// module again), and a failed one reloads the capture. Nothing is saved.
/// </summary>
public static class ScreenRecreationProof
{
    public static JsonObject Run(ModelHost host, byte[] source, string? target = null, bool blocks = false, bool verify = false, Action<string>? log = null)
    {
        var total = Stopwatch.StartNew();
        var reader = new KernelModelReader();
        var espace = host.Load(source);
        var loadMs = total.ElapsedMilliseconds;
        var rows = new JsonArray();
        try
        {
            var session = new ModelSession(espace);
            var baseline = verify ? Identities(ModelHost.Messages(espace)) : null;
            var previous = baseline;
            var first = ScreenHtml.Module((OutSystems.Model.IObjectSignature)espace, reader);
            var moduleName = first.ModuleName;
            var roots = first.Roots.Where(r => r.Kind is "MobileScreen" or "WebScreen" || blocks && r.Kind is "MobileBlock" or "WebBlock")
                .Where(r => target == null || string.Equals(r.Name, target, StringComparison.OrdinalIgnoreCase)).ToList();
            foreach (var (name, kind, _) in roots)
            {
                var row = new JsonObject { ["root"] = name, ["kind"] = kind };
                rows.Add(row);
                var watch = Stopwatch.StartNew();
                ScreenHtmlDocument before;
                try { before = ScreenHtml.Module((OutSystems.Model.IObjectSignature)espace, reader).Read(kind + ":" + name); }
                catch (Exception error) { row["outcome"] = "unread"; row["error"] = error.GetBaseException().Message; continue; }
                if (before.Problems.Count > 0) { row["outcome"] = "unread"; row["error"] = string.Join("; ", before.Problems.Take(3)); continue; }
                row["widgets"] = before.Widgets; row["bytes"] = before.Bytes;
                JsonObject report;
                try { report = session.RecreateFromReading(before); }
                catch (Exception error) { report = new JsonObject { ["recreated"] = false, ["code"] = "EXCEPTION", ["message"] = error.GetBaseException().GetType().Name + ": " + error.GetBaseException().Message }; }
                if (report["recreated"]?.GetValue<bool>() != true)
                {
                    row["outcome"] = "refused";
                    row["code"] = report["code"]?.DeepClone(); row["message"] = Clip(report["message"]?.ToString() ?? "", 600);
                    if (report["problems"] is JsonArray problems) row["problems"] = new JsonArray(problems.Take(12).Select(p => (JsonNode)Clip(p!["message"]?.ToString() ?? "", 300)).ToArray());
                    row["problemCount"] = (report["problems"] as JsonArray)?.Count ?? 1;
                    log?.Invoke($"{moduleName}/{name}: refused {report["code"]}");
                    // The copy may hold half of it: the next root starts from the capture again.
                    ModelHost.Release(espace);
                    espace = host.Load(source);
                    session = new ModelSession(espace);
                    previous = baseline;
                    continue;
                }
                row["compileMs"] = report["compileMs"]?.DeepClone(); row["buildMs"] = report["timings"]?["buildMs"]?.DeepClone(); row["indexMs"] = report["timings"]?["indexMs"]?.DeepClone();
                row["steps"] = report["timings"]?["steps"]?.DeepClone();
                // The build of the page itself: the move of the original's actions (the stand-in for the job's logic ops,
                // which a delivery does not pay) taken out.
                if (report["timings"]?["buildMs"]?.GetValue<long>() is { } built)
                    row["documentMs"] = built - (report["timings"]?["steps"]?["phase:actions"]?["ms"]?.GetValue<long>() ?? 0);
                row["actionsMoved"] = report["actionsMoved"]?.DeepClone(); row["repointed"] = report["repointed"]?.DeepClone(); row["unmatchedKeys"] = report["unmatchedKeys"]?.DeepClone();
                if (report["preserved"] is JsonArray kept) row["preserved"] = kept.Count;
                ScreenHtmlDocument after;
                try { after = ScreenHtml.Module((OutSystems.Model.IObjectSignature)espace, reader).Read(kind + ":" + name); }
                catch (Exception error) { row["outcome"] = "reread failed"; row["error"] = error.GetBaseException().Message; continue; }
                var (equal, differences) = Compare(before, after);
                row["equal"] = equal;
                if (!equal) { row["differences"] = new JsonArray(differences.Take(10).Select(d => (JsonNode)d).ToArray()); row["differenceCount"] = differences.Count; }
                if (verify)
                {
                    var now = Identities(ModelHost.Messages(espace));
                    var added = Minus(now, previous!); var gone = Minus(previous!, now);
                    row["newErrors"] = added.Count(m => m.StartsWith("Error", StringComparison.Ordinal));
                    row["goneErrors"] = gone.Count(m => m.StartsWith("Error", StringComparison.Ordinal));
                    if (added.Count + gone.Count > 0)
                        row["verify"] = new JsonArray(added.Take(8).Select(m => (JsonNode)("+ " + Clip(m, 300))).Concat(gone.Take(4).Select(m => (JsonNode)("- " + Clip(m, 300)))).ToArray());
                    previous = now;
                }
                row["ms"] = watch.ElapsedMilliseconds;
                var clean = !verify || row["newErrors"]!.GetValue<int>() == 0;
                row["outcome"] = equal && clean ? "same" : equal ? "verify" : "different";
                log?.Invoke($"{moduleName}/{name}: {row["outcome"]} ({row["compileMs"]} ms)");
            }
            var summary = new JsonObject();
            foreach (var group in rows.Select(r => r!["outcome"]!.ToString()).GroupBy(o => o)) summary[group.Key] = group.Count();
            return new JsonObject { ["schema"] = "ssam-html-recreation/1", ["module"] = moduleName, ["roots"] = rows.Count, ["outcomes"] = summary,
                ["loadMs"] = loadMs, ["totalMs"] = total.ElapsedMilliseconds, ["verify"] = verify, ["rows"] = rows };
        }
        finally { ModelHost.Release(espace); }
    }

    /// <summary>The texts of a root read before and after, the keys of the elements of the same k mapped (the recreated
    /// elements have new keys): equal, or the differing lines.</summary>
    public static (bool Equal, List<string> Differences) Compare(ScreenHtmlDocument before, ScreenHtmlDocument after)
    {
        var newKeys = after.Keys.ToDictionary(k => k.Key, k => k.Value, StringComparer.Ordinal);
        var map = new List<(string From, string To)>();
        foreach (var (k, key) in before.Keys)
            if (newKeys.TryGetValue(k, out var now) && now != key && key.Length > 0) map.Add((key, now));
        var text = new StringBuilder(before.Html);
        foreach (var (from, to) in map.OrderByDescending(m => m.From.Length)) text.Replace("@" + from, "@" + to);
        var a = text.ToString().Split('\n'); var b = after.Html.Split('\n');
        var differences = new List<string>();
        if (a.Length != b.Length) differences.Add($"lines {a.Length} -> {b.Length}");
        for (var i = 0; i < Math.Max(a.Length, b.Length) && differences.Count < 40; i++)
        {
            var x = i < a.Length ? a[i] : ""; var y = i < b.Length ? b[i] : "";
            if (x != y) differences.Add($"{i + 1}: {Clip(x.Trim(), 240)} => {Clip(y.Trim(), 240)}");
        }
        return (differences.Count == 0, differences);
    }

    private static List<string> Identities(IReadOnlyList<MessageInfo> messages) =>
        messages.Select(m => (m.IsError ? "Error " : "Warning ") + m.Id + " @ " + m.Path + " | " + m.Detail).ToList();

    private static List<string> Minus(List<string> a, List<string> b)
    {
        var counts = b.GroupBy(x => x).ToDictionary(g => g.Key, g => g.Count());
        var result = new List<string>();
        foreach (var x in a) { if (counts.TryGetValue(x, out var n) && n > 0) counts[x] = n - 1; else result.Add(x); }
        return result;
    }

    private static string Clip(string text, int max) => text.Length > max ? text[..max] + "…" : text;
}
