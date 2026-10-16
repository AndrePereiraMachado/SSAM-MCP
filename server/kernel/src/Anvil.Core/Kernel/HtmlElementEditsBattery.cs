using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// CX16 §9.1: the equivalence of the element edits with the edit form, on the synthetic edits of the C2 battery
/// (ScreenHtmlEditBattery, the parameters of today). Every edit of every Reactive/Mobile screen and block is applied twice and
/// rolled back: as the edit form sends it (each element whole, with its k) and as element edits (each element whole as
/// {replace: k}, the &lt;style&gt; by {find, with} or {into: "/"} when the reading has none, the document as {replace: "/"});
/// the two must give the same outcome, the same text read back and the same ops. Both lanes (the kernel compiles it for each).
/// </summary>
public static class HtmlElementEditsBattery
{
    private sealed class Rollback : Exception { }

    public sealed record Row(string Root, string Kind, bool Same, string Detail);

    public static List<Row> Equivalence(ModelHost host, byte[] bytes, int seed, int perKind)
    {
        var rows = new List<Row>();
        var module = host.Load(bytes);
        try {
            var reading = ScreenHtml.Module((IObjectSignature)module, new KernelModelReader());
            foreach (var (name, kind, key) in reading.Roots.ToList()) {
                if (kind is "WebScreen" or "WebBlock") continue;
                var document = reading.Read("@" + key);
                if (document.Problems.Count > 0) continue;
                // The reading reads as positions and back: an edit that changes nothing is the reading itself.
                var none = HtmlElementEdits.Apply(document.Html, new JsonArray(JsonNode.Parse("{\"set\":\"/\",\"attributes\":{\"ssam-none\":null}}")), null);
                if (none.Problems.Count > 0 || none.Document != document.Html) { rows.Add(new Row(name, "reading", false, "the reading does not read as positions: " + string.Join(" | ", none.Problems.Select(p => p["message"])))); continue; }
                foreach (var edit in ScreenHtmlEditBattery.Generate(document, seed, perKind, k => !reading.UsedOutside(document, k), reading.ActionNames(document))) {
                    (string Outcome, string Text, string Ops) Once(JsonObject data)
                    {
                        JsonNode? answer = null; ScreenHtmlDocument? after = null;
                        try {
                            StudioAdapter.Runtime.Mutate(module, "Anvil: html edits equivalence", _ => {
                                var session = new ModelSession(module) { ScreenHtmlReading = reading };
                                answer = session.ApplyOne(new JsonObject { ["op"] = "html", ["data"] = data });
                                after = session.ScreenHtmlAfter!.Read("@" + key);
                                throw new Rollback();
                            });
                            return ("not-rolled-back", "", "");
                        }
                        catch (Exception error) when (Chain(error).Any(e => e is Rollback)) {
                            return ("applied", after!.Html, answer!["ops"]!.ToJsonString());
                        }
                        catch (Exception error) {
                            var coded = Errors.FindCoded(error);
                            return ("refused", coded?.Code ?? Errors.Text(error), string.Join(",", (coded?.Problems?.Select(p => p?["code"]?.ToString() ?? "") ?? []).Order()));
                        }
                        finally { reading = reading.Refresh(key); }
                    }
                    var basedOn = new JsonObject { ["html"] = document.HtmlSha256 };
                    var a = Once(new JsonObject { ["screen"] = "@" + key, ["basedOn"] = basedOn.DeepClone(), ["edit"] = new JsonArray(edit.Edits.Select(e => (JsonNode)e).ToArray()) });
                    var b = Once(new JsonObject { ["screen"] = "@" + key, ["basedOn"] = basedOn.DeepClone(), ["edits"] = ElementEdits(document.Html, edit.Edits) });
                    rows.Add(new Row(name, edit.Kind, a == b, a == b ? a.Outcome
                        : edit.Note + ": edit " + a.Outcome + " " + Clip(a.Ops) + " | edits " + b.Outcome + " " + Clip(b.Ops) + " " + Clip(b.Text)));
                }
            }
        }
        finally { ModelHost.Release(module); }
        return rows;
    }

    /// <summary>The edit form's strings as element edits: an element (an If with its else) by its k, the &lt;style&gt; by its
    /// text, the document as /.</summary>
    public static JsonArray ElementEdits(string reading, IEnumerable<string> edits)
    {
        var list = new JsonArray();
        foreach (var text in edits) {
            var root = ScreenHtml.Parse(text).Children.First(c => !c.IsText);
            if (root.Tag is "screen" or "block") list.Add(new JsonObject { ["replace"] = "/", ["with"] = text });
            else if (root.Tag == "style") {
                var start = reading.IndexOf("<style", StringComparison.Ordinal);
                if (start < 0) list.Add(new JsonObject { ["into"] = "/", ["insert"] = text });
                else list.Add(new JsonObject { ["find"] = reading[start..(reading.IndexOf("</style>", start, StringComparison.Ordinal) + "</style>".Length)], ["with"] = text });
            }
            else list.Add(new JsonObject { ["replace"] = root.Get("k"), ["with"] = text });
        }
        return list;
    }

    private static string Clip(string s) => s.Length > 300 ? s[..300] + "…" : s;
    private static IEnumerable<Exception> Chain(Exception e) { for (Exception? x = e; x != null; x = x.InnerException) yield return x; }
}
