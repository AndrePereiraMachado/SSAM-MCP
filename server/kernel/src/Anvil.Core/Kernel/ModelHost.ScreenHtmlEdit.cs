using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

// C2 of the plan "Texto do SSAM" on a capture, without a Studio: one edit of a screen (anvil html-edit) and the battery of
// synthetic edits of every screen and block (anvil html-edit-battery, ScreenHtmlEditBatteryTests).
public sealed partial class ModelHost
{
    private sealed class BatteryRollback : Exception { }

    /// <summary>One html op in its edit form ({screen, basedOn, edit|html}) applied to these bytes, as a job applies it: the
    /// answer of the op, or its refusal with every problem; the result saved to <paramref name="outPath"/> when it applied.</summary>
    public JsonObject HtmlEdit(byte[] source, JsonObject data, string? outPath = null)
    {
        var sw = Stopwatch.StartNew();
        var module = Load(source);
        var loadMs = sw.ElapsedMilliseconds;
        try {
            var session = new ModelSession(module) { BaseSha256 = Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant() };
            JsonNode? result = null;
            sw.Restart();
            try { StudioAdapter.Runtime.Mutate(module, "Anvil: html edit", _ => result = session.ApplyOne(new JsonObject { ["op"] = "html", ["data"] = data.DeepClone() })); }
            catch (Exception error) {
                var coded = Errors.FindCoded(error);
                return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code ?? "APPLY_FAILED", ["message"] = Errors.Text(error),
                    ["problems"] = coded?.Problems?.DeepClone(), ["loadMs"] = loadMs, ["applyMs"] = sw.ElapsedMilliseconds };
            }
            var applyMs = sw.ElapsedMilliseconds;
            var answer = new JsonObject { ["accepted"] = true, ["result"] = result, ["loadMs"] = loadMs, ["applyMs"] = applyMs };
            if (outPath != null) { File.WriteAllBytes(outPath, Save(module)); answer["out"] = Path.GetFullPath(outPath); }
            return answer;
        }
        finally { Release(module); }
    }

    /// <summary>The C2 battery on these bytes: for every Reactive/Mobile screen and block, the synthetic edits of
    /// ScreenHtmlEditBattery (class, text, expression, new child, leaf removal, sibling swap, event), each applied by the html
    /// op in its edit form and rolled back: the module must read back the edited text (without the reading's k), the op's own
    /// check must pass (kinds, facts, children, the ObjectKey of everything it kept), and after the rollback the screen must
    /// read as before. Rows by edit; totals by kind.</summary>
    public JsonObject HtmlEditBattery(byte[] source, int seed = 1, int perKind = 1, Action<string>? log = null, string? onlyRoot = null)
    {
        var total = Stopwatch.StartNew();
        var module = Load(source);
        var loadMs = total.ElapsedMilliseconds;
        try {
            var reading = ScreenHtml.Module((IObjectSignature)module, new KernelModelReader());
            var rows = new JsonArray();
            var byKind = new Dictionary<string, (int Edits, int Ok)>(StringComparer.Ordinal);
            var serializer = 0; var roots = 0; var rollbacks = 0;
            foreach (var (name, kind, key) in reading.Roots) {
                if (kind is "WebScreen" or "WebBlock") continue;
                if (onlyRoot != null && !string.Equals(onlyRoot, name, StringComparison.OrdinalIgnoreCase)) continue;
                var document = reading.Read("@" + key);
                if (document.Problems.Count > 0) continue;
                roots++;
                if (ScreenHtmlText.Write(ScreenHtml.Parse(document.Html)) != document.Html) serializer++;
                foreach (var edit in ScreenHtmlEditBattery.Generate(document, seed, perKind, k => !reading.UsedOutside(document, k), reading.ActionNames(document))) {
                    var op = new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
                        ["screen"] = "@" + key, ["basedOn"] = new JsonObject { ["html"] = document.HtmlSha256 },
                        ["edit"] = new JsonArray(edit.Edits.Select(e => (JsonNode)e).ToArray()) } };
                    string outcome; string? detail = null; ScreenHtmlDocument? after = null; JsonNode? answer = null;
                    var sw = Stopwatch.StartNew();
                    try {
                        StudioAdapter.Runtime.Mutate(module, "Anvil: html edit battery", _ => {
                            var session = new ModelSession(module) { ScreenHtmlReading = reading };
                            answer = session.ApplyOne(op);
                            after = session.ScreenHtmlAfter!.Read("@" + key);
                            throw new BatteryRollback();
                        });
                        outcome = "not-rolled-back";
                    }
                    catch (Exception error) when (Chain(error).Any(e => e is BatteryRollback)) {
                        var got = ScreenHtmlText.WithoutKeys(after!.Html);
                        outcome = got == edit.Expected ? "ok" : "text-differs";
                        if (outcome != "ok") detail = FirstDifference(edit.Expected, got);
                    }
                    catch (Exception error) {
                        var coded = Errors.FindCoded(error);
                        outcome = coded != null ? "refused" : "failed";
                        detail = coded?.Problems is { Count: > 0 } problems ? string.Join(" | ", problems.Take(4).Select(p => "[" + p?["code"] + "] " + p?["message"])) : Errors.Text(error);
                    }
                    var ms = sw.Elapsed.TotalMilliseconds;
                    // The rollback: the screen reads as it was read.
                    reading = reading.Refresh(key);
                    var back = reading.Read("@" + key);
                    if (back.Html != document.Html) { rollbacks++; detail = (detail == null ? "" : detail + " | ") + "after the rollback the screen reads another text"; if (outcome == "ok") outcome = "rollback-differs"; document = back; }
                    var (edits, ok) = byKind.GetValueOrDefault(edit.Kind);
                    byKind[edit.Kind] = (edits + 1, ok + (outcome == "ok" ? 1 : 0));
                    var row = new JsonObject { ["root"] = name, ["rootKind"] = kind, ["kind"] = edit.Kind, ["note"] = edit.Note, ["outcome"] = outcome, ["ms"] = Math.Round(ms, 1) };
                    if (answer is JsonObject applied) {
                        row["ops"] = applied["counts"]?.DeepClone();
                        if (applied["keyChanged"] is JsonArray changed) row["keyChanged"] = changed.Count;
                    }
                    if (detail != null) { row["detail"] = detail.Length > 1500 ? detail[..1500] + "…" : detail; row["edit"] = edit.Edits[0].Length > 3000 ? edit.Edits[0][..3000] + "…" : edit.Edits[0]; }
                    rows.Add(row);
                    if (outcome != "ok") log?.Invoke($"{name} {edit.Kind} {outcome}: {detail}");
                }
            }
            var kinds = new JsonObject();
            foreach (var (k, (edits, ok)) in byKind.OrderBy(k => Array.IndexOf(ScreenHtmlEditBattery.Kinds, k.Key))) kinds[k] = new JsonObject { ["edits"] = edits, ["ok"] = ok };
            var all = rows.Select(r => r!["outcome"]!.ToString()).ToList();
            return new JsonObject {
                ["schema"] = ScreenHtml.Schema, ["module"] = reading.ModuleName, ["seed"] = seed, ["perKind"] = perKind, ["roots"] = roots,
                ["edits"] = all.Count, ["ok"] = all.Count(o => o == "ok"), ["kinds"] = kinds, ["serializerDiffers"] = serializer, ["rollbackDiffers"] = rollbacks,
                ["loadMs"] = loadMs, ["totalMs"] = total.ElapsedMilliseconds,
                ["p50Ms"] = Percentile(rows, 0.5), ["p90Ms"] = Percentile(rows, 0.9), ["rows"] = rows,
            };
        }
        finally { Release(module); }
    }

    private static IEnumerable<Exception> Chain(Exception error)
    {
        for (var e = error; e != null; e = e.InnerException) yield return e;
        if (error is AggregateException aggregate) foreach (var inner in aggregate.InnerExceptions) foreach (var e in Chain(inner)) yield return e;
    }

    private static double Percentile(JsonArray rows, double p)
    {
        var values = rows.Select(r => r!["ms"]!.GetValue<double>()).Order().ToList();
        return values.Count == 0 ? 0 : values[Math.Min(values.Count - 1, (int)(p * values.Count))];
    }

    // The first line where two texts differ, both sides.
    private static string FirstDifference(string expected, string got)
    {
        var a = expected.Split('\n'); var b = got.Split('\n');
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++) {
            var x = i < a.Length ? a[i] : "<end>"; var y = i < b.Length ? b[i] : "<end>";
            if (x != y) return "line " + (i + 1).ToString(CultureInfo.InvariantCulture) + ": expected «" + Clip(x) + "» read «" + Clip(y) + "»";
        }
        return "equal";
        static string Clip(string s) => s.Length > 300 ? s[..300] + "…" : s;
    }
}
