using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

// The families of the owner's session of 2026-10-12 (VisitaCerta_UI) proved on real screens, both lanes (FamilyTests): an edit
// of each family into a container of every Reactive/Mobile screen and block of a capture, by the html op in its edit form (each
// one rolled back), and one new screen with every family by its document form; what the module reads back must be the native
// construct of each family, and the reading of it a fixed point.
public sealed partial class ModelHost
{
    /// <summary>The families, each a snippet appended to a container: an inline svg icon (currentColor), a painted svg (a
    /// gradient), an image by URL; text beside inline elements; a style and an attribute with bindings, an id of a constant
    /// binding; inline decimals; a Popup with a button.</summary>
    public static readonly (string Family, string Snippet)[] HtmlFamilies =
    [
        ("svg", "<span class=\"fam-svg\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M5 12h14\"/><circle cx=\"12\" cy=\"12\" r=\"9\"/></svg>"
            + "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\"><defs><linearGradient id=\"g\"><stop offset=\"0\" stop-color=\"#f00\"/><stop offset=\"1\" stop-color=\"#00f\"/></linearGradient></defs><rect width=\"20\" height=\"20\" fill=\"url(#g)\"/></svg>"
            + "<img class=\"fam-url\" src=\"https://example.com/fam.png\"/></span>"),
        ("spaces", "<p class=\"fam-spaces\">left <b>mid</b> right <em>x</em> <b>y</b></p>"),
        ("bindings", "<div class=\"fam-bindings\" style=\"--fam:{{ Year(CurrDate()) }}\" title=\"Ano {{ Year(CurrDate()) }}\">z</div>"),
        ("decimals", "<span class=\"fam-decimals\" style=\"opacity:0.5;line-height:1.25;flex:2\">d</span>"),
        ("popup", "<popup class=\"fam-popup\" show=\"False\"><button class=\"btn\"{0}>ok</button></popup>"),
    ];

    /// <summary>Every family on these bytes: for up to <paramref name="maxRoots"/> screens and blocks with a container, each family
    /// appended to it by the edit form and rolled back; then one new screen with every family by the document form. Rows by case;
    /// totals by family and form.</summary>
    public JsonObject HtmlFamilyBattery(byte[] source, int maxRoots = 8, Action<string>? log = null)
    {
        var total = Stopwatch.StartNew();
        var module = Load(source);
        try {
            var reading = ScreenHtml.Module((IObjectSignature)module, new KernelModelReader());
            var rows = new JsonArray();
            var counts = new Dictionary<string, (int Cases, int Ok)>(StringComparer.Ordinal);
            void Count(string key, bool ok) { var (c, o) = counts.GetValueOrDefault(key); counts[key] = (c + 1, o + (ok ? 1 : 0)); }
            var roots = 0;
            // Screens and blocks in turn (the roots come by kind: every block before the first screen).
            var screens = reading.Roots.Where(r => r.Kind.EndsWith("Screen", StringComparison.Ordinal)).ToList();
            var blocks = reading.Roots.Where(r => !r.Kind.EndsWith("Screen", StringComparison.Ordinal)).ToList();
            var order = Enumerable.Range(0, Math.Max(screens.Count, blocks.Count)).SelectMany(i => new[] { i < screens.Count ? screens[i] : default, i < blocks.Count ? blocks[i] : default })
                .Where(r => r.Key != null).ToList();
            foreach (var (name, kind, key) in order) {
                if (kind is "WebScreen" or "WebBlock" || roots >= maxRoots) continue;
                var document = reading.Read("@" + key);
                if (document.Problems.Count > 0) continue;
                var tree = ScreenHtml.Parse(document.Html);
                var top = tree.Children.First(c => !c.IsText);
                var parents = ScreenHtmlText.Parents(tree);
                var container = ScreenHtmlText.Elements(top).Select(x => x.Node).FirstOrDefault(n => n != top && n.Tag == "div" && n.Get("k") != null && n.Get("if") == null
                    && n.Get("else") == null && n.Get("list") == null && !Inside(n, parents, p => p.Tag is "os-opaque" or "popup" || p.Get("list") != null));
                if (container == null) continue;
                roots++;
                var actions = reading.ActionNames(document);
                foreach (var (family, snippet) in HtmlFamilies) {
                    var text = snippet.Replace("{0}", actions.Count > 0 ? " onclick=\"" + actions[0] + "\"" : "", StringComparison.Ordinal);
                    var edit = Append(container, text);
                    var op = new JsonObject { ["op"] = "html", ["data"] = new JsonObject {
                        ["screen"] = "@" + key, ["basedOn"] = new JsonObject { ["html"] = document.HtmlSha256 }, ["edit"] = new JsonArray(edit) } };
                    ScreenHtmlDocument? after = null; string outcome; string? detail = null;
                    var sw = Stopwatch.StartNew();
                    try {
                        StudioAdapter.Runtime.Mutate(module, "Anvil: html family battery", _ => {
                            var session = new ModelSession(module) { ScreenHtmlReading = reading };
                            session.ApplyOne(op);
                            after = session.ScreenHtmlAfter!.Read("@" + key);
                            throw new BatteryRollback();
                        });
                        outcome = "not-rolled-back";
                    }
                    catch (Exception error) when (Chain(error).Any(e => e is BatteryRollback)) {
                        detail = FamilyProblem(family, after!, actions.Count > 0);
                        outcome = detail == null ? "ok" : "differs";
                    }
                    catch (Exception error) {
                        var coded = Errors.FindCoded(error);
                        outcome = coded != null ? "refused" : "failed";
                        detail = coded?.Problems is { Count: > 0 } problems ? string.Join(" | ", problems.Take(4).Select(p => "[" + p?["code"] + "] " + p?["message"])) : Errors.Text(error);
                    }
                    reading = reading.Refresh(key);
                    if (reading.Read("@" + key).Html != document.Html) { detail = (detail ?? "") + " | after the rollback the screen reads another text"; outcome = "rollback-differs"; }
                    Count("edit/" + family, outcome == "ok");
                    var row = new JsonObject { ["form"] = "edit", ["root"] = name, ["family"] = family, ["outcome"] = outcome, ["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1) };
                    if (detail != null) { row["detail"] = detail.Length > 1500 ? detail[..1500] + "…" : detail; row["edit"] = edit.Length > 2000 ? edit[..2000] + "…" : edit; }
                    rows.Add(row);
                    if (outcome != "ok") log?.Invoke($"{name} {family} {outcome}: {detail}");
                }
            }
            // The document form: one new screen with every family, in the module's UI flow (when it has one).
            DocumentFamilies(module, reading, rows, Count, log);
            var families = new JsonObject();
            foreach (var (k, (c, o)) in counts.OrderBy(k => k.Key, StringComparer.Ordinal)) families[k] = new JsonObject { ["cases"] = c, ["ok"] = o };
            var all = rows.Select(r => r!["outcome"]!.ToString()).ToList();
            return new JsonObject { ["module"] = reading.ModuleName, ["roots"] = roots, ["cases"] = all.Count, ["ok"] = all.Count(o => o == "ok"),
                ["families"] = families, ["totalMs"] = total.ElapsedMilliseconds, ["rows"] = rows };
        }
        finally { Release(module); }
    }

    private void DocumentFamilies(ESpace module, ScreenHtmlModule<IObjectSignature> reading, JsonArray rows, Action<string, bool> count, Action<string>? log)
    {
        var body = string.Join("\n", HtmlFamilies.Select(f => f.Snippet.Replace("{0}", "", StringComparison.Ordinal)));
        // A name of its own (stable: the module's name, never a hash that changes per process).
        var name = "SsamFamilies" + (reading.ModuleName.Sum(c => c) % 1000).ToString(System.Globalization.CultureInfo.InvariantCulture);
        // The first Reactive/Mobile UI flow of the module takes the screen (none: no case).
        var flow = ((IObjectSignature)module).Children.OfType<IObjectSignature>().FirstOrDefault(c => ModelSession.Implements(c, "IMobileFlow"));
        if (flow == null) return;
        var html = "<screen name=\"" + name + "\" flow=\"" + TypeResolver.Name(flow) + "\">\n<div class=\"fam-root\">\n" + body + "\n</div>\n</screen>";
        ScreenHtmlDocument? after = null; string outcome; string? detail = null;
        var sw = Stopwatch.StartNew();
        try {
            StudioAdapter.Runtime.Mutate(module, "Anvil: html family document", _ => {
                var session = new ModelSession(module);
                session.ApplyOne(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
                after = ScreenHtml.Module((IObjectSignature)module, new KernelModelReader()).Read(name);
                throw new BatteryRollback();
            });
            outcome = "not-rolled-back";
        }
        catch (Exception error) when (Chain(error).Any(e => e is BatteryRollback)) {
            detail = string.Join(" | ", HtmlFamilies.Select(f => FamilyProblem(f.Family, after!, false)).OfType<string>());
            if (detail.Length == 0) detail = null;
            outcome = detail == null ? "ok" : "differs";
        }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            outcome = coded != null ? "refused" : "failed";
            detail = coded?.Problems is { Count: > 0 } problems ? string.Join(" | ", problems.Take(4).Select(p => "[" + p?["code"] + "] " + p?["message"])) : Errors.Text(error);
        }
        count("document", outcome == "ok");
        var row = new JsonObject { ["form"] = "document", ["root"] = name, ["family"] = "all", ["outcome"] = outcome, ["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1) };
        if (detail != null) row["detail"] = detail.Length > 1500 ? detail[..1500] + "…" : detail;
        rows.Add(row);
        if (outcome != "ok") log?.Invoke($"{name} document {outcome}: {detail}");
    }

    // The container's text with the snippet as its last child, exactly as written (the snippet is not re-written: its own spaces count).
    private static string Append(ScreenHtml.Node container, string snippet)
    {
        var text = ScreenHtmlText.Write(container).TrimEnd('\n');
        var close = "</" + container.Tag + ">";
        if (text.EndsWith("/>", StringComparison.Ordinal)) return text[..^2] + ">" + snippet + close;
        return text[..^close.Length].TrimEnd('\n') + "\n" + snippet + "\n" + close;
    }

    private static bool Inside(ScreenHtml.Node node, Dictionary<ScreenHtml.Node, ScreenHtml.Node> parents, Func<ScreenHtml.Node, bool> test)
    {
        for (var p = parents.GetValueOrDefault(node); p != null; p = parents.GetValueOrDefault(p)) if (test(p)) return true;
        return false;
    }

    /// <summary>What the module read back lacks of a family's native construct (null: it is all there), and the fixed point of the
    /// text read.</summary>
    private static string? FamilyProblem(string family, ScreenHtmlDocument after, bool withAction)
    {
        var tree = ScreenHtml.Parse(after.Html);
        var top = tree.Children.First(c => !c.IsText);
        var all = ScreenHtmlText.Elements(top).Select(x => x.Node).ToList();
        ScreenHtml.Node? Marked(string cls) => all.FirstOrDefault(n => (n.Get("class") ?? n.Get("ext:class") ?? "").Split(' ').Contains(cls));
        var sheet = string.Concat(top.Children.Where(c => c.Tag == "style").SelectMany(c => c.Children).Select(c => c.Text));
        var problems = new List<string>();
        if (after.Compare(after.Html).Count > 0) problems.Add("the text read is no fixed point");
        switch (family) {
            case "svg": {
                var holder = Marked("fam-svg");
                if (holder == null) { problems.Add("no .fam-svg"); break; }
                var icon = holder.Children.FirstOrDefault(c => !c.IsText && c.Tag == "span");
                var mask = (icon?.Get("class") ?? "").Split(' ').FirstOrDefault(c => c.StartsWith("ssam-icon-svg-", StringComparison.Ordinal));
                if (icon == null || mask == null || !(icon.Get("class") ?? "").Split(' ').Contains("ssam-icon")) problems.Add("the svg icon is no span.ssam-icon with its mask class: " + ScreenHtmlText.Write(holder));
                else if (!System.Text.RegularExpressions.Regex.IsMatch(sheet, @"\." + System.Text.RegularExpressions.Regex.Escape(mask) + @"\s*\{[^}]*mask\s*:\s*url\(""data:image/svg\+xml,"))
                    problems.Add("the style sheet has no mask rule ." + mask);
                if (icon?.Get("style") is not { } size || !size.Contains("width:16px", StringComparison.Ordinal)) problems.Add("the icon lost its size");
                var images = holder.Children.Where(c => !c.IsText && c.Tag == "img").ToList();
                if (!images.Any(i => i.Get("os-Type") == "External" && (i.Get("url") ?? "").StartsWith("\"data:image/svg+xml,", StringComparison.Ordinal))) problems.Add("the painted svg is no External image of its data URL");
                if (!images.Any(i => i.Get("os-Type") == "External" && i.Get("url") == "\"https://example.com/fam.png\"")) problems.Add("the image by URL is no External image");
                break;
            }
            case "spaces": {
                var p = Marked("fam-spaces");
                var runs = p == null ? [] : p.Children.Where(c => !c.IsText && c.Tag == "text").Select(c => string.Concat(c.Children.Select(t => t.Text))).ToList();
                if (!runs.SequenceEqual(["left ", " right ", " "])) problems.Add("the runs beside the inline elements are [" + string.Join("|", runs) + "], not [left | right | ]");
                break;
            }
            case "bindings": {
                var d = Marked("fam-bindings");
                if (d == null) { problems.Add("no .fam-bindings"); break; }
                if (d.Get("style") != null) problems.Add("style with a binding stayed the Custom Style: " + d.Get("style"));
                if (d.Get("ext:style") != "{{ \"--fam:\" + Year(CurrDate()) }}") problems.Add("ext:style is " + (d.Get("ext:style") ?? "absent"));
                if (d.Get("title") != "{{ \"Ano \" + Year(CurrDate()) }}") problems.Add("title is " + (d.Get("title") ?? "absent"));
                break;
            }
            case "decimals": {
                var s = Marked("fam-decimals");
                if (s?.Get("style") != "opacity:calc(0.5);line-height:calc(1.25);flex:2") problems.Add("the inline decimals read " + (s?.Get("style") ?? "absent"));
                break;
            }
            case "popup": {
                var popup = all.FirstOrDefault(n => n.Tag == "popup" && (n.Get("class") ?? "").Contains("fam-popup", StringComparison.Ordinal));
                var button = popup?.Children.FirstOrDefault(c => !c.IsText && c.Tag == "button");
                if (button == null) { problems.Add("no popup with its button"); break; }
                if (button.Attributes.Any(a => a.Key.EndsWith(".Transition", StringComparison.Ordinal))) problems.Add("the button inside the popup is not at the popup's default Transition: " + ScreenHtmlText.Write(button));
                if (withAction && button.Get("onclick") == null) problems.Add("the button lost its onclick");
                break;
            }
        }
        return problems.Count == 0 ? null : family + ": " + string.Join("; ", problems);
    }
}
