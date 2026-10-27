using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

// F2 (read -> edit -> read is a faithful round trip): the generated sweep. Every case comes from the property model of the
// element (ScreenHtmlModule.PropertiesOf: the native model of its concrete type), never from a list of properties written by
// hand: for every widget kind the reading writes and every property its model says an edit may write, the same value written
// again, another value and the default written explicitly must read back as written (the effective value), and the native
// model must hold the value written (the oracle: the property read from the model itself, and for the first case of each
// property from the module saved and loaded again, never through the reading's defaults); every widget moved into a new
// container keeps its identity in the text and its references; and the edits the model says are not edits (a property the page
// does not keep, a value outside its enumeration, a widget into a widget that holds none, the removal of a widget still used)
// are refused with the element and the property named. Each case is applied by the html op in its edit form and rolled back;
// after a case on a block, or one that moved or deleted, every root of the module is read again from scratch and must read as
// before (a consumer on another screen, such as an instance of the block, is rewired by the move and by its rollback).
public sealed partial class ModelHost
{
    private sealed class RoundTripRollback : Exception { }

    /// <summary>The F2 sweep on these bytes: rows by case and the coverage (kinds x properties, what is skipped and why).</summary>
    public JsonObject HtmlRoundTripSweep(byte[] source, int perProperty = 2, int perKindMoves = 3, Action<string>? log = null, string? onlyRoot = null, int reloadPerProperty = 1)
    {
        var total = Stopwatch.StartNew();
        var module = Load(source);
        try {
            var reading = ScreenHtml.Module((IObjectSignature)module, new KernelModelReader());
            var roots = reading.Roots.Where(r => r.Kind is not ("WebScreen" or "WebBlock")).ToList();
            // Every root as it reads before any case: what every rollback must give back.
            var initial = roots.ToDictionary(r => r.Key, r => reading.Read("@" + r.Key).Html, StringComparer.Ordinal);
            var observed = ScreenHtmlRoundTrip.Observed(roots.Select(r => reading.Read("@" + r.Key)));
            // The roots that hold an instance of a block: the platform's move (and its rollback) rewires their slots and handlers.
            var dependents = roots.Where(r => r.Kind is "MobileBlock").ToDictionary(r => r.Key, r => roots.Where(o => o.Key != r.Key
                && System.Text.RegularExpressions.Regex.IsMatch(initial[o.Key], "<Block [^>]*name=\"(?:[A-Za-z]+:)?" + System.Text.RegularExpressions.Regex.Escape(r.Name) + "\"")).Select(o => o.Key).ToList(), StringComparer.Ordinal);
            var rows = new JsonArray();
            var coverage = new SortedDictionary<string, SortedDictionary<string, string>>(StringComparer.Ordinal);
            var taken = new Dictionary<string, int>(StringComparer.Ordinal);
            var reloaded = new Dictionary<string, int>(StringComparer.Ordinal);
            var traditional = reading.Roots.Count(r => r.Kind is "WebScreen" or "WebBlock");
            foreach (var (name, kind, key) in roots) {
                if (onlyRoot != null && !string.Equals(onlyRoot, name, StringComparison.OrdinalIgnoreCase)) continue;
                var document = reading.Read("@" + key);
                if (document.Problems.Count > 0 || document.DefaultsNote.Length > 0) continue;
                var cases = ScreenHtmlRoundTrip.Generate(reading, document, coverage, taken, perProperty, perKindMoves, observed);
                foreach (var c in cases) {
                    // The module saved and loaded again for the first case of each property (by name, across kinds).
                    var slot = c.Property ?? "";
                    var reload = c.Written != null && reloaded.GetValueOrDefault(slot) < reloadPerProperty;
                    if (reload) reloaded[slot] = reloaded.GetValueOrDefault(slot) + 1;
                    var row = RunRoundTripCase(module, ref reading, ref document, key, c, initial, reload, dependents.GetValueOrDefault(key) ?? []);
                    rows.Add(row);
                    if (row["outcome"]!.ToString() != "ok") log?.Invoke(name + " " + c.Family + " " + c.Note + ": " + row["detail"]);
                }
            }
            var byFamily = new JsonObject();
            foreach (var group in rows.GroupBy(r => r!["family"]!.ToString()).OrderBy(g => g.Key, StringComparer.Ordinal))
                byFamily[group.Key] = new JsonObject { ["cases"] = group.Count(), ["ok"] = group.Count(r => r!["outcome"]!.ToString() == "ok") };
            var kinds = new JsonObject();
            var tested = 0; var skipped = 0;
            foreach (var (k, properties) in coverage) {
                var map = new JsonObject();
                foreach (var (p, status) in properties) { map[p] = status; if (status == "tested") tested++; else skipped++; }
                kinds[k] = map;
            }
            return new JsonObject {
                ["module"] = reading.ModuleName, ["cases"] = rows.Count, ["ok"] = rows.Count(r => r!["outcome"]!.ToString() == "ok"),
                ["families"] = byFamily, ["kinds"] = coverage.Count, ["propertiesTested"] = tested, ["propertiesSkipped"] = skipped,
                ["oracle"] = new JsonObject { ["native"] = rows.Count(r => r!["oracle"]?.ToString() is "native" or "reloaded"), ["reloaded"] = rows.Count(r => r!["oracle"]?.ToString() == "reloaded") },
                ["traditionalRoots"] = traditional, ["coverage"] = kinds, ["rows"] = rows, ["totalMs"] = total.ElapsedMilliseconds,
            };
        }
        finally { Release(module); }
    }

    private JsonObject RunRoundTripCase(ServiceStudio.Model.ESpace module, ref ScreenHtmlModule<IObjectSignature> reading, ref ScreenHtmlDocument document, string key,
        ScreenHtmlRoundTrip.Case c, Dictionary<string, string> initial, bool reload, List<string> dependents)
    {
        var op = new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
            ["screen"] = "@" + key, ["basedOn"] = new JsonObject { ["html"] = document.HtmlSha256 },
            ["edit"] = new JsonArray(c.Edits.Select(e => (JsonNode)e).ToArray()) } };
        string outcome; string? detail = null; ScreenHtmlDocument? after = null; JsonObject? answer = null; JsonArray? problems = null;
        var current = reading;
        var reader = new KernelModelReader();
        var objectKey = document.Keys.FirstOrDefault(p => p.Key == c.K).Value;
        // The oracle's value before (a case that writes the value the element holds must leave the native value as it was).
        var before = c.Property != null && current.NodeOf(document, c.K) is { } was ? NativeText(reader, was, c.Property) : null;
        string? nativeAfter = null; byte[]? saved = null;
        var errorsBefore = Messages(module).Count(m => m.IsError);
        var errorsAfter = -1;
        var sw = Stopwatch.StartNew();
        try {
            StudioAdapter.Runtime.Mutate(module, "Anvil: html round trip", _ => {
                var session = new ModelSession(module) { ScreenHtmlReading = current };
                answer = session.ApplyOne(op) as JsonObject;
                after = session.ScreenHtmlAfter!.Read("@" + key);
                errorsAfter = Messages(module).Count(m => m.IsError);
                if (c.Property != null && c.Written != null && objectKey != null) {
                    nativeAfter = session.ScreenHtmlAfter!.NodeByKey(objectKey) is { } node ? NativeText(reader, node, c.Property) : "<no element " + objectKey + ">";
                    if (reload) saved = Save(module);
                }
                throw new RoundTripRollback();
            });
            outcome = "not-rolled-back";
        }
        catch (Exception error) when (Chain(error).Any(e => e is RoundTripRollback)) {
            outcome = "applied";
        }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            outcome = coded != null ? "refused" : "failed";
            problems = coded?.Problems?.DeepClone() as JsonArray;
            detail = problems is { Count: > 0 } ? string.Join(" | ", problems.Take(4).Select(p => "[" + p?["code"] + "] k=" + p?["k"] + " " + p?["message"])) : Errors.Text(error);
        }
        var row = new JsonObject { ["root"] = document.Root, ["rootKey"] = document.RootKey, ["family"] = c.Family, ["kind"] = c.Kind, ["property"] = c.Property, ["k"] = c.K, ["note"] = c.Note };
        if (problems?.FirstOrDefault() is { } first) row["code"] = first["code"]?.DeepClone();
        // The verdict: what the case expects.
        string verdict;
        if (c.Expect == ScreenHtmlRoundTrip.Expectation.Refused) {
            var named = problems?.Any(p => p?["k"]?.ToString() == c.K && (c.Property == null || (p?["message"]?.ToString() ?? "").Contains(c.Property, StringComparison.Ordinal))
                && p?["fix"] is { } fix && fix.ToString().Length > 0) == true;
            verdict = outcome == "refused" && named ? "ok" : outcome == "refused" ? "refused-unnamed" : "accepted";
            if (verdict != "ok" && detail == null) detail = outcome;
        } else if (outcome != "applied") {
            verdict = outcome;
        } else if (c.Expect == ScreenHtmlRoundTrip.Expectation.Text) {
            var got = ScreenHtmlText.WithoutKeys(after!.Html);
            verdict = got == c.Expected ? "ok" : "text-differs";
            if (verdict != "ok") detail = FirstDifference(c.Expected, got);
            if (verdict == "ok" && errorsAfter > errorsBefore) { verdict = "verify-errors"; detail = (errorsAfter - errorsBefore) + " new Verify error(s)"; }
            if (verdict == "ok" && c.Family == "move") row["keyChanged"] = (answer?["keyChanged"] as JsonArray)?.Count ?? 0;
        } else {
            // The same page but for the property written: compared as facts (the order of attributes is the reading's).
            var diff = after!.Compare(c.Expected);
            verdict = diff.Count == 0 ? "ok" : "facts-differ";
            if (verdict != "ok") detail = string.Join("; ", diff.Take(4).Select(d => d.ToJsonString()));
        }
        // The oracle, never through the reading's defaults: the native value of the property in the model the edit wrote (and, for the
        // first case of a property, in that model saved and loaded again) is the value written, or the one it had for "same".
        if (verdict == "ok" && outcome == "applied" && c.Written != null && c.Property != null) {
            var wanted = c.Same ? before : c.Written;
            if (!SameNative(nativeAfter, wanted, c.Property)) { verdict = "native-differs"; detail = c.Property + ": the model holds " + Quote(nativeAfter) + ", the edit wrote " + Quote(wanted); }
            else row["oracle"] = "native";
            if (verdict == "ok" && saved != null) {
                var again = Load(saved);
                try {
                    var reloadedText = NativeText(reader, reader.Resolve((IObjectSignature)again, "@" + objectKey), c.Property);
                    if (!SameNative(reloadedText, wanted, c.Property)) { verdict = "reload-differs"; detail = c.Property + ": saved and loaded again, the model holds " + Quote(reloadedText) + ", the edit wrote " + Quote(wanted); }
                    else row["oracle"] = "reloaded";
                } catch (InvalidOperationException error) { verdict = "reload-differs"; detail = "saved and loaded again: " + error.Message; }
                finally { Release(again); }
            }
        }
        row["outcome"] = verdict;
        row["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        if (detail != null) { row["detail"] = detail.Length > 1500 ? detail[..1500] + "…" : detail; row["edit"] = c.Edits[0].Length > 2000 ? c.Edits[0][..2000] + "…" : c.Edits[0]; }
        if (problems != null && verdict == "ok") row["problem"] = problems.FirstOrDefault(p => p?["k"]?.ToString() == c.K)?.DeepClone();
        // The rollback. A case on a block (its instances live on other roots) or one that moved or deleted (the platform rewires every
        // consumer, and the rollback rewires them back): the whole module read again from scratch, every root as it was read. Any other
        // case: its root read again.
        // Finding 1 of the review: the platform's move of a widget of a block rewires the slots of its instances on other roots, and
        // so does the rollback, with objects of their own: a reading kept from before the case reads those roots with nodes that are
        // gone (an os-PlaceholdersContent of slots it cannot name). The edited root and every root with an instance of it are read
        // again; each must read as before the first case (a fresh reading of every root after every case on a block showed the
        // rollback is faithful: the stale reading was the sweep's).
        var differs = new List<string>();
        foreach (var rootKey in dependents.Prepend(document.RootKey)) {
            reading = reading.Refresh(rootKey);
            if (reading.Read("@" + rootKey).Html != initial[rootKey]) differs.Add(reading.Roots.FirstOrDefault(r => r.Key == rootKey).Name ?? rootKey);
        }
        if (differs.Count > 0) { row["outcome"] = "rollback-differs"; row["detail"] = "after the rollback these roots read another text: " + string.Join(", ", differs); }
        document = reading.Read("@" + document.RootKey);
        return row;
    }

    // A property of a node as the native model holds it: the text of an expression, a boolean, a member or a number, a text.
    private static string? NativeText(KernelModelReader reader, IObjectSignature node, string property)
    {
        if (reader.PropertyOf(node, property) is not { } read) return null;
        var value = read();
        return value switch {
            null => null,
            _ when reader.ExpressionText(value) is { } expression => expression,
            string s => s,
            bool b => b ? "True" : "False",
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            IObjectSignature target => "@" + target.ObjectKey,
            _ => value.ToString(),
        };
    }
    private static bool SameNative(string? got, string? wanted, string property) =>
        (got ?? "") == (wanted ?? "") || property is "Style" or "StyleClasses" && ScreenHtmlModule<IObjectSignature>.EditPlan.ClassTokens("t:" + (got ?? "")) == ScreenHtmlModule<IObjectSignature>.EditPlan.ClassTokens("t:" + (wanted ?? ""));
    private static string Quote(string? text) => text == null ? "nothing" : "'" + (text.Length > 80 ? text[..80] + "…" : text) + "'";
}
