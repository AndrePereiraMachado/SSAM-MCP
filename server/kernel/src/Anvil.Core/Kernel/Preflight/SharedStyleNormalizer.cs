using Anvil.Reading;
using System.Text;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Anvil.Core.Preflight;

/// <summary>Moves only whole, readable rules whose earlier local cascade can be preserved.
/// The input and output are author text; no module or Studio state participates.</summary>
public static class SharedStyleNormalizer
{
    public const string Rule = "CSS_MOVED_TO_THEME";
    private sealed class Item(int start, int end, string text)
    {
        public int Start = start, End = end;
        public string Text = text, Key = CssStylesheet.SharedRuleKey(text);
        public CssStylesheet Sheet = CssStylesheet.Parse(text, lenient: true);
        public bool Move;
        public string Reason = "unique";
        public readonly Dictionary<Item, bool> Competition = [];
    }
    private sealed class Sheet(HtmlText.Element element, string css, List<Item> items)
    {
        public HtmlText.Element Element = element;
        public string Css = css;
        public List<Item> Items = items;
    }
    private sealed class Document(int index, JsonObject data, string html)
    {
        public int Index = index;
        public JsonObject Data = data;
        public string Html = html;
        public List<Sheet> Sheets = [];
        public HashSet<string> Classes = new(StringComparer.Ordinal), Ids = new(StringComparer.Ordinal);
        public bool UnknownReach;
        public IEnumerable<Item> Items => Sheets.SelectMany(s => s.Items);
        public HashSet<string> Fixed = new(StringComparer.Ordinal);
    }
    private sealed class PartitionFailure(int index) : Exception("the CSS partition did not preserve every rule")
    {
        public int Index { get; } = index;
    }

    public static void Normalize(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        var skipped = new HashSet<int>();
        while (true)
        {
            var attempt = new List<JsonObject>();
            try
            {
                NormalizeCore(ops, prefix, attempt, skipped);
                done.AddRange(attempt);
                return;
            }
            catch (PartitionFailure error)
            {
                // Every write is staged. Rebuild the plan without this document; none
                // of its rules may become a supplier for another document's theme.
                if (!skipped.Add(error.Index)) return;
                done.Add(JobNormalizer.Entry("CSS_NOT_SHARED", Path(prefix, error.Index), null, null, error.Message));
            }
            catch { return; } // Normalization never refuses; the ordinary checks judge the original.
        }
    }

    private static void NormalizeCore(JsonArray ops, string? prefix, List<JsonObject> done, HashSet<int> skipped)
    {
        var docs = new List<Document>();
        var existing = new Dictionary<string, string>(StringComparer.Ordinal);
        var parts = new Dictionary<string, List<Item>>(StringComparer.Ordinal);
        var themeGuards = new List<Item>();
        var unreadableDocument = false;
        for (var i = 0; i < ops.Count; i++)
        {
            var ignoreOwn = skipped.Contains(i);
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "html" || op["data"] is not JsonObject data ||
                data["html"]?.ToString() is not { } html || !ScreenDocument.IsDocument(html)) continue;
            var doc = new Document(i, data, html);
            try
            {
                var top = ScreenHtml.Parse(html).Children.First(n => !n.IsText);
                doc.Classes.UnionWith(ScreenDocument.UsedClasses(top).Select(c => c.Class));
                foreach (var node in ScreenDocument.Descendants(top).Prepend(top))
                {
                    if (node.Get("id") is { } id) doc.Ids.Add(id);
                    if (node.Tag is "Block" or "os-opaque" || node.Get("class")?.Contains("{{", StringComparison.Ordinal) == true ||
                        node.Get("id")?.Contains("{{", StringComparison.Ordinal) == true) doc.UnknownReach = true;
                }
                var placed = ScreenDocument.Styles(top);
                var elements = HtmlText.Parse(html).Root.Descendants().Where(e => e.Tag == "style").ToList();
                // Match only styles the document compiler can place, in source order.
                if (placed.Count != elements.Count) throw new InvalidOperationException("unplaced style prevents a complete CSS reading");
                var documentParts = new Dictionary<string, List<Item>>(StringComparer.Ordinal);
                var documentGuards = new List<Item>();
                for (var s = 0; s < placed.Count; s++)
                {
                    var block = placed[s]; var e = elements[s];
                    if (ignoreOwn && !block.Theme) continue;
                    var end = html.LastIndexOf("</", e.End - 1, e.End - e.OpenEnd, StringComparison.Ordinal);
                    if (end < e.OpenEnd) throw new InvalidOperationException("style closing tag missing");
                    var css = html[e.OpenEnd..end];
                    var items = CssStylesheet.SplitTopLevel(css).Select(r => new Item(r.Start, r.End, css[r.Start..r.End])).ToList();
                    if (block.Theme)
                    {
                        documentGuards.AddRange(items);
                        if (block.Node.Get("id") is { } id && Regex.IsMatch(id, @"\A[A-Za-z0-9_-]{1,64}\z"))
                        {
                            if (!documentParts.TryGetValue(id, out var part)) documentParts[id] = part = [];
                            part.AddRange(items);
                        }
                    }
                    else doc.Sheets.Add(new Sheet(e, css, items));
                }
                foreach (var part in documentParts) parts[part.Key] = part.Value;
                themeGuards.AddRange(documentGuards);
                docs.Add(doc);
            }
            catch (Exception ex)
            {
                done.Add(JobNormalizer.Entry("CSS_NOT_SHARED", Path(prefix, i), null, null, "CSS left intact: " + ex.Message));
                unreadableDocument = true;
            }
        }
        // A new module theme also reaches documents whose CSS could not be read.
        // Their swallowed rules cannot prove equivalent behavior, so leave this delivery intact.
        if (unreadableDocument) return;
        var existingItems = parts.SelectMany(p => p.Value.Select(r => (Id: p.Key, Item: r))).ToList();
        foreach (var pair in existingItems) existing.TryAdd(pair.Item.Key, pair.Id);
        var occurrences = docs.SelectMany(d => d.Items.Select(r => (Doc: d, Item: r))).ToList();
        var candidates = occurrences.GroupBy(x => x.Item.Key).Where(g => g.Select(x => x.Doc.Index).Distinct().Count() >= 2 || existing.ContainsKey(g.Key))
            .Select(g => g.Key).ToHashSet(StringComparer.Ordinal);
        // A theme reaches every document, including one that never carried this rule.
        // Do not introduce it where its anchors may match, or where rendered classes
        // are unknowable without compiling a child block or a dynamic expression.
        var unsafeReach = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in occurrences.Select(x => x.Item).DistinctBy(r => r.Key))
        {
            if (!candidates.Contains(item.Key) || existing.ContainsKey(item.Key)) continue;
            var uncertainAnchors = item.Sheet.Rules.Any(r => r.Selector.Any(c => c == '\\' || c >= 0x80));
            var classes = item.Sheet.Rules.SelectMany(r => CssStylesheet.Classes(r.Selector)).ToHashSet(StringComparer.Ordinal);
            var ids = item.Sheet.Rules.SelectMany(r => CssStylesheet.Ids(r.Selector)).ToHashSet(StringComparer.Ordinal);
            if (docs.Any(d => !d.Items.Any(r => r.Key == item.Key) && (d.UnknownReach || uncertainAnchors ||
                classes.Count + ids.Count == 0 || d.Classes.Overlaps(classes) || d.Ids.Overlaps(ids))))
            { candidates.Remove(item.Key); unsafeReach.Add(item.Key); }
        }
        // An import is movable only if it is live in every document containing it.
        var deadImports = new HashSet<string>(StringComparer.Ordinal);
        foreach (var doc in docs)
        {
            var hasRule = false;
            foreach (var item in doc.Items)
            {
                var text = item.Text.TrimStart();
                if (text.StartsWith("@import", StringComparison.OrdinalIgnoreCase))
                { if (hasRule) { candidates.Remove(item.Key); deadImports.Add(item.Key); } }
                else if (!text.StartsWith("@charset", StringComparison.OrdinalIgnoreCase)) hasRule = true;
            }
        }
        var order = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var pair in occurrences) if (!order.ContainsKey(pair.Item.Key)) order.Add(pair.Item.Key, order.Count);

        bool ThemeOverrides(Item item)
        {
            // Named parts can be replaced later in this very delivery. Their relative
            // installation order is not the local rule order: keep competing copies.
            if (themeGuards.Any(x => x.Key != item.Key && Compete(x, item))) return true;
            return existing.ContainsKey(item.Key) && occurrences.Any(x => x.Item.Key != item.Key &&
                candidates.Contains(x.Item.Key) && Compete(x.Item, item));
        }
        void Pass(Document doc)
        {
            var kept = new List<Item>(); var hasRule = false;
            foreach (var item in doc.Items)
            {
                item.Move = false; item.Reason = deadImports.Contains(item.Key) ? "import" : unsafeReach.Contains(item.Key) ? "reach" : "unique";
                var import = item.Text.TrimStart().StartsWith("@import", StringComparison.OrdinalIgnoreCase);
                if (!candidates.Contains(item.Key)) { }
                else if (!Eligible(item)) item.Reason = "global";
                else if (import && hasRule) item.Reason = "import";
                else if (doc.Fixed.Contains(item.Key) || kept.Any(k => Compete(k, item)) || ThemeOverrides(item)) item.Reason = "competing";
                else { item.Move = true; item.Reason = "moved"; }
                if (!item.Move) kept.Add(item);
                var t = item.Text.TrimStart();
                if (!t.StartsWith("@import", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("@charset", StringComparison.OrdinalIgnoreCase)) hasRule = true;
            }
        }
        foreach (var doc in docs) Pass(doc);
        // The theme has one order, fixed by first appearance. An opposite local order is
        // retained as a pair and the pass repeats, because keeping it can pin later rules.
        foreach (var doc in docs)
        {
            bool again;
            do
            {
                again = false;
                var moved = doc.Items.Where(r => r.Move && !existing.ContainsKey(r.Key)).ToList();
                for (var a = 0; a < moved.Count; a++) for (var b = a + 1; b < moved.Count; b++)
                    if (order[moved[a].Key] > order[moved[b].Key] && Compete(moved[a], moved[b]))
                    { again |= doc.Fixed.Add(moved[a].Key); again |= doc.Fixed.Add(moved[b].Key); }
                if (again) Pass(doc);
            } while (again);
        }
        var themeItems = occurrences.Where(x => x.Item.Move && !existing.ContainsKey(x.Item.Key)).Select(x => x.Item)
            .DistinctBy(r => r.Key).OrderBy(r => order[r.Key]).ToList();
        // Statements must precede style rules in the theme, even when first encountered in a later document.
        themeItems = themeItems.OrderBy(r => r.Text.TrimStart().StartsWith("@import", StringComparison.OrdinalIgnoreCase) ? 0 : 1).ToList();
        var themeCss = string.Join("\n", themeItems.Select(r => r.Text));
        var idNew = "shared-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(themeCss)))[..8].ToLowerInvariant();
        // An explicitly authored part can use any valid id, including this digest.
        // Never replace it with a different generated body after a hash/id collision.
        if (themeItems.Count > 0 && parts.ContainsKey(idNew)) return;
        var host = themeItems.Count == 0 ? null : occurrences.First(x => themeItems.Any(t => t.Key == x.Item.Key)).Doc;
        var staged = new List<(Document Doc, string Html, JsonObject Entry)>();
        foreach (var doc in docs)
        {
            var moved = doc.Items.Where(r => r.Move).ToList();
            if (moved.Count == 0 && doc != host) continue;
            var edits = new List<HtmlText.Edit>();
            foreach (var sheet in doc.Sheets)
            {
                var removed = sheet.Items.Where(r => r.Move).ToList();
                if (removed.Count == 0) continue;
                var css = sheet.Css;
                foreach (var r in removed.OrderByDescending(r => r.Start)) css = css.Remove(r.Start, r.End - r.Start);
                // Verify the exact multiset, not just a byte or parser count.
                int remaining;
                try
                {
                    var keptSpans = CssStylesheet.SplitTopLevel(css);
                    remaining = keptSpans.Count;
                    var keptKeys = keptSpans.Select(r => CssStylesheet.SharedRuleKey(css[r.Start..r.End])).Order().ToArray();
                    if (!keptKeys.SequenceEqual(sheet.Items.Where(r => !r.Move).Select(r => r.Key).Order()) ||
                        CssStylesheet.CountRules(sheet.Css) != CssStylesheet.CountRules(css) + removed.Sum(r => r.Sheet.RuleCount))
                        throw new PartitionFailure(doc.Index);
                }
                catch { throw new PartitionFailure(doc.Index); }
                if (remaining == 0)
                    edits.Add(new(sheet.Element.OpenStart, sheet.Element.End - sheet.Element.OpenStart, ""));
                else foreach (var r in removed) edits.Add(new(sheet.Element.OpenEnd + r.Start, r.End - r.Start, ""));
            }
            if (doc == host)
            {
                var at = HtmlText.Parse(doc.Html).Root.Descendants().First(e => e.Tag == "style").OpenStart;
                edits.Add(new(at, 0, $"<style scope=\"theme\" id=\"{idNew}\">{themeCss}</style>"));
            }
            var written = HtmlText.Apply(doc.Html, edits);
            var ids = moved.Select(r => existing.TryGetValue(r.Key, out var id) ? id : idNew)
                .Concat(doc == host ? new[] { idNew } : Array.Empty<string>()).Distinct().Select(id => "style:" + id);
            var movedRules = moved.Sum(r => r.Sheet.RuleCount);
            var entry = JobNormalizer.Entry(Rule, Path(prefix, doc.Index), $"{movedRules} rules, {Encoding.UTF8.GetByteCount(string.Join("", doc.Sheets.Select(s => s.Css)))} B in <style>",
                "theme part " + string.Join(", ", ids), "Repeated whole CSS rules moved with their local cascade preserved");
            entry["bytesBefore"] = Encoding.UTF8.GetByteCount(doc.Html);
            entry["bytesAfter"] = Encoding.UTF8.GetByteCount(written);
            entry["rulesMoved"] = movedRules;
            entry["topLevelItemsMoved"] = moved.Count;
            var kept = new JsonObject { ["competing"] = 0, ["global"] = 0, ["import"] = 0, ["unique"] = 0, ["reach"] = 0 };
            foreach (var group in doc.Items.Where(r => !r.Move).GroupBy(r => r.Reason)) kept[group.Key] = group.Sum(r => r.Sheet.RuleCount);
            entry["kept"] = kept;
            entry["rulesBefore"] = doc.Items.Sum(r => r.Sheet.RuleCount);
            entry["rulesAfter"] = doc.Items.Where(r => !r.Move).Sum(r => r.Sheet.RuleCount);
            staged.Add((doc, written, entry));
        }
        foreach (var change in staged)
        {
            SentJob.HtmlBefore(change.Doc.Data, change.Doc.Html);
            change.Doc.Data["html"] = change.Html;
            done.Add(change.Entry);
        }
    }
    private static string? Path(string? prefix, int i) => prefix == null ? null : $"{prefix}/{i}/data/html";
    private static bool Eligible(Item item)
    {
        var t = item.Text.TrimStart();
        if (t.StartsWith("@charset", StringComparison.OrdinalIgnoreCase)) return false;
        if (t.StartsWith("@import", StringComparison.OrdinalIgnoreCase)) return true;
        if (item.Sheet.Statements.Count > 0 || item.Sheet.Rules.Any(r => r.EnclosingRules.Any(e => e.StartsWith("@layer", StringComparison.OrdinalIgnoreCase)))) return false;
        if (item.Sheet.Blocks.Any(b => !CssStylesheet.IsOpaqueAtRule(b.Prelude))) return false;
        return item.Sheet.Rules.All(r => CssSelectors.ParseList(r.Selector).All(Anchored));
    }
    private static bool Anchored(ComplexSelector selector) => selector.Parts.Any(p => p.Compound.Items.Any(s =>
        s.Kind is SimpleKind.Class or SimpleKind.Id || s.Kind == SimpleKind.PseudoClass &&
        (s.Name is "is" or "where") && s.Selectors is { Count: > 0 } children && children.All(Anchored)));

    private static bool Compete(Item a, Item b)
    {
        if (a.Competition.TryGetValue(b, out var known)) return known;
        var competes = Compare(a, b);
        a.Competition[b] = competes;
        b.Competition[a] = competes;
        return competes;
    }
    private static bool Compare(Item a, Item b)
    {
        foreach (var x in a.Sheet.Rules) foreach (var y in b.Sheet.Rules)
        {
            if (x.EnclosingRules.Count > 0 && y.EnclosingRules.Count > 0 && !x.EnclosingRules.SequenceEqual(y.EnclosingRules)) continue;
            if (!x.Declarations.Any(p => y.Declarations.Any(q => Family(p.Property, q.Property)))) continue;
            if (CssStylesheet.SplitSelectors(x.Selector).Any(s => CssStylesheet.SplitSelectors(y.Selector).Any(t => CssSelectors.Specificity(s) == CssSelectors.Specificity(t)))) return true;
        }
        return false;
    }
    private static bool Family(string a, string b)
    {
        if (a.StartsWith("--", StringComparison.Ordinal) || b.StartsWith("--", StringComparison.Ordinal)) return a == b;
        a = a.ToLowerInvariant(); b = b.ToLowerInvariant();
        if (a == b || a == "all" || b == "all" || a.StartsWith(b + "-", StringComparison.Ordinal) || b.StartsWith(a + "-", StringComparison.Ordinal)) return true;
        static bool Group(string a, string b, params string[] group) => group.Contains(a) && group.Contains(b);
        return Group(a,b,"inset","top","right","bottom","left") || Group(a,b,"gap","row-gap","column-gap") ||
            Group(a,b,"place-content","align-content","justify-content") || Group(a,b,"place-items","align-items","justify-items") ||
            Group(a,b,"place-self","align-self","justify-self") || Group(a,b,"flex-flow","flex-direction","flex-wrap");
    }
}
