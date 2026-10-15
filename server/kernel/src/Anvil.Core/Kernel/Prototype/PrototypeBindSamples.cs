using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// The texts the prototype rendered, read from the canonical explored state of a view or a modal (2.10 explored/trees): the text of a
/// node by its k, and of a list template node in each rendered item. The binding reads them to build the example outputs and to
/// correlate slots with the producer (no LLM: the capture already holds every value it rendered).
/// </summary>
internal sealed class PrototypeExploredTexts(JsonObject json)
{
    private readonly Dictionary<string, JsonObject?> _trees = new(StringComparer.Ordinal);

    public JsonObject? Tree(string owner)
    {
        if (_trees.TryGetValue(owner, out var cached)) return cached;
        var explored = PrototypeCapture.Objects(json["explored"]);
        JsonObject? entry;
        if (owner.StartsWith("m:", StringComparison.Ordinal))
            entry = explored.FirstOrDefault(e => e["modal"]?.ToString() == owner[2..]) ?? explored.FirstOrDefault(e => (e["id"]?.ToString() ?? "").StartsWith(owner + "@", StringComparison.Ordinal));
        else
            entry = explored.FirstOrDefault(e => e["id"]?.ToString() == owner + "@canonical") ?? explored.FirstOrDefault(e => "v:" + e["view"] == owner && e["modal"] == null);
        JsonObject? tree = entry?["tree"]?.ToString() is { } sha ? json["trees"]?[sha] as JsonObject : null;
        // without explored states the view's own tree is its canonical rendering
        if (tree == null && owner.StartsWith("v:", StringComparison.Ordinal))
            tree = PrototypeCapture.Objects(json["views"]).FirstOrDefault(v => "v:" + v["key"] == owner)?["root"] as JsonObject;
        if (tree == null && owner.StartsWith("m:", StringComparison.Ordinal))
            tree = PrototypeCapture.Objects(json["modals"]).FirstOrDefault(m => "m:" + m["key"] == owner)?["root"] as JsonObject;
        return _trees[owner] = tree;
    }

    /// <summary>The node of k in the owner's rendered tree (the body of a static page is "b", the view's own root elsewhere).</summary>
    public JsonObject? Node(string owner, string k)
    {
        var tree = Tree(owner);
        if (tree == null) return null;
        if (Find(tree, k) is { } exact) return exact;
        if (owner.StartsWith("v:", StringComparison.Ordinal) && k.StartsWith(owner, StringComparison.Ordinal) && Find(tree, "b" + k[owner.Length..]) is { } body) return body;
        return null;
    }

    /// <summary>The rendered items of a list (element children of the list node, in order).</summary>
    public List<JsonObject> Items(string owner, string listK)
    {
        var node = Node(owner, listK);
        return (node?["c"] as JsonArray ?? []).OfType<JsonObject>().Where(c => c["t"] != null).ToList();
    }

    /// <summary>The text of a node; for a template node (&lt;list&gt;/*/...) the text in item <paramref name="item"/>.</summary>
    public string? Text(string owner, string k, string? listK = null, int item = -1)
    {
        // an attribute of an element: <k>@<attribute>
        string? attribute = null;
        if (k.IndexOf('@') is var at and > 0) { attribute = k[(at + 1)..]; k = k[..at]; }
        JsonObject? node;
        if (listK != null && item >= 0)
        {
            var items = Items(owner, listK);
            if (item >= items.Count) return null;
            var rest = k.Length > listK.Length + 2 ? k[(listK.Length + 2)..] : "";
            var itemK = items[item]["k"]?.ToString();
            node = itemK == null ? null : rest.Length == 0 ? items[item] : Find(items[item], itemK + rest);
        }
        else node = Node(owner, k);
        if (node == null) return null;
        if (attribute != null) return PrototypeBind.Attr(node, attribute) is { } value ? Normalize(value) : "";
        return Normalize(TextOf(node));
    }

    public static string TextOf(JsonNode? n) => n is JsonObject o ? o["x"]?.ToString() ?? string.Concat((o["c"] as JsonArray ?? []).Select(TextOf)) : "";
    public static string Normalize(string text) => Regex.Replace(text, @"\s+", " ").Trim();

    private static JsonObject? Find(JsonObject n, string k)
    {
        if (n["k"]?.ToString() == k) return n;
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o && (k.StartsWith((o["k"]?.ToString() ?? "\0") + "/", StringComparison.Ordinal) || o["k"]?.ToString() == k) && Find(o, k) is { } hit) return hit;
        // keys renamed between the view and the tree (s:app, v:view): a full walk
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o && Walk(o, k) is { } hit) return hit;
        return null;
    }

    private static JsonObject? Walk(JsonObject n, string k)
    {
        if (n["k"]?.ToString() == k) return n;
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o && Walk(o, k) is { } hit) return hit;
        return null;
    }
}

/// <summary>
/// Fidelity by construction (4.4 with data.bind): the example outputs of each Data Action are chosen so that every bound expression
/// renders, over them, the text the prototype rendered. Each expression is evaluated by the read-back's own evaluator
/// (PrototypeRender.Expressions) over a finite domain of values per leaf it reads (the numbers, times and words of the captured
/// text, the identifiers of the producer's static records, True/False), in a fixed order: the first assignment that renders the
/// captured text wins. A bound list gets one example row per rendered item. What no assignment explains keeps the type's default
/// and its slot shows as a fidelity mismatch with its k (never hidden).
/// </summary>
internal static class PrototypeBindSamples
{
    private const int Budget = 6000;
    private static readonly Regex Path = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)", RegexOptions.Compiled);

    public sealed record Outcome(JsonObject Samples, JsonArray Explained, JsonArray Unexplained);

    public static Outcome Build(JsonObject json, PrototypeBindPlan plan, PrototypeProducer producer, string? clock)
    {
        var texts = new PrototypeExploredTexts(json);
        var samples = new JsonObject();
        var explained = new JsonArray(); var unexplained = new JsonArray();
        var day = DateTime.TryParse(clock, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var c) ? c.Date : new DateTime(2026, 1, 1);
        // the skeleton: every output at the default of its type
        foreach (var source in plan.Sources)
        {
            var owner = samples[source.Owner] as JsonObject ?? new JsonObject();
            samples[source.Owner] = owner;
            var record = new JsonObject();
            foreach (var output in source.Outputs) record[output.Name] = Default(producer, output.Type, 0);
            owner[source.As] = record;
        }
        samples["@entities"] = Entities(producer);
        var resolvers = plan.Sources.GroupBy(s => s.Owner).ToDictionary(g => g.Key, g => new PrototypeBind.PathResolver(producer, g.ToDictionary(s => s.As, s => s.Outputs, StringComparer.OrdinalIgnoreCase)), StringComparer.Ordinal);
        foreach (var (owner, tree) in Owners(json))
        {
            if (samples[owner] is not JsonObject ownerSamples || !resolvers.TryGetValue(owner, out var resolver)) continue;
            var fixedLeaves = new HashSet<string>(StringComparer.Ordinal);
            // lists first: their rows exist before a slot of a row is explained
            var lists = new List<(JsonObject Node, string Source)>();
            Lists(tree, lists);
            foreach (var (node, source) in lists)
            {
                var k = node["k"]!.ToString();
                var count = texts.Items(owner, k).Count;
                if (count == 0) count = node["list"]?["items"]?.GetValue<int>() ?? 0;
                var type = resolver.Resolve(source).Type;
                if (type == null) continue;
                var element = PrototypeProducer.Shape(type).Base;
                var rows = new JsonArray();
                for (var i = 0; i < count; i++) rows.Add(Default(producer, element, 0));
                Set(ownerSamples, source, rows);
                fixedLeaves.Add(source);
                if (node["list"]?["template"] is JsonObject template)
                    foreach (var slot in Slots(template))
                        for (var i = 0; i < count; i++)
                        {
                            var expected = texts.Text(owner, slot.K, k, i);
                            Explain(slot, expected, owner, ownerSamples, samples, resolver, producer, day, (source, i), fixedLeaves, explained, unexplained);
                        }
            }
            foreach (var slot in Slots(tree).Where(s => !s.InList))
                Explain(slot, texts.Text(owner, slot.K), owner, ownerSamples, samples, resolver, producer, day, null, fixedLeaves, explained, unexplained);
        }
        return new Outcome(samples, explained, unexplained);
    }

    private sealed record Slot(string K, string Expression, bool InList);

    private static IEnumerable<(string Owner, JsonObject Tree)> Owners(JsonObject json)
    {
        foreach (var v in PrototypeCapture.Objects(json["views"])) if (v["root"] is JsonObject r) yield return ("v:" + v["key"], r);
        foreach (var m in PrototypeCapture.Objects(json["modals"])) if (m["root"] is JsonObject r) yield return ("m:" + m["key"], r);
    }

    private static void Lists(JsonObject n, List<(JsonObject, string)> found)
    {
        if (n["list"] is JsonObject list && list["bound"]?.GetValue<bool>() == true && list["source"]?.ToString() is { } source) found.Add((n, source));
        else if (n["list"]?["template"] is JsonObject t) Lists(t, found);
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Lists(o, found);
        foreach (var c in n["else"] as JsonArray ?? []) if (c is JsonObject o) Lists(o, found);
    }

    /// <summary>The bound text slots of a tree outside its lists (a list's template slots are explained row by row by the caller).</summary>
    private static List<Slot> Slots(JsonObject root)
    {
        var slots = new List<Slot>();
        void Walk(JsonObject n)
        {
            if (n["x"] != null && n["expr"]?["bound"]?.GetValue<bool>() == true && n["expr"]?["value"]?["os"]?.ToString() is { } os) slots.Add(new(n["k"]!.ToString(), os, false));
            // an attribute slot (<k>@style): the row variants and the attributes the binding computes
            foreach (var (attribute, value) in n["attrExpr"] as JsonObject ?? [])
                if (value?["bound"]?.GetValue<bool>() == true && value["expr"]?["value"]?["os"]?.ToString() is { } attrOs) slots.Add(new(n["k"]!.ToString() + "@" + attribute, attrOs, false));
            if (n["list"] != null) return;
            foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o);
            foreach (var c in n["else"] as JsonArray ?? []) if (c is JsonObject o) Walk(o);
        }
        if (root["list"] == null) Walk(root);
        else foreach (var c in root["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o);
        return slots;
    }

    private static void Explain(Slot slot, string? expected, string owner, JsonObject ownerSamples, JsonObject all, PrototypeBind.PathResolver resolver, PrototypeProducer producer,
        DateTime day, (string List, int Row)? row, HashSet<string> fixedLeaves, JsonArray explained, JsonArray unexplained)
    {
        if (expected == null) return;
        // the leaves the expression reads: paths of the owner's data actions (a row's leaves through <list>.Current)
        var leaves = new List<(string Path, string Type)>();
        foreach (Match m in Path.Matches(PrototypeBind.StripStrings(slot.Expression)))
        {
            var resolved = resolver.Resolve(m.Value);
            if (resolved.Path == null || resolved.Type == null) continue;
            // what the list computes (its length, the row being rendered) is no example value
            if (resolved.Path.EndsWith(".Length", StringComparison.Ordinal) || resolved.Path.EndsWith(".CurrentRowNumber", StringComparison.Ordinal)) continue;
            if (!PrototypeProducer.IsBasic(resolved.Type) && PrototypeProducer.Shape(resolved.Type).Shape != "identifier") continue;
            var path = row is { } r && resolved.Path.StartsWith(r.List + ".Current.", StringComparison.Ordinal) ? $"{r.List}[{r.Row}]{resolved.Path[(r.List + ".Current").Length..]}" : resolved.Path;
            if (!leaves.Any(l => l.Path == path)) leaves.Add((path, resolved.Type));
        }
        var free = leaves.Where(l => !fixedLeaves.Contains(l.Path)).ToList();
        var domains = free.Select(l => Domain(l.Type, expected, slot.Expression, producer, day)).ToList();
        var evaluations = 0;
        bool Renders()
        {
            evaluations++;
            try { return PrototypeExploredTexts.Normalize(Evaluate(slot.Expression, owner, all, row)) == expected; }
            catch (PrototypeRender.UnevaluableException) { return false; }
        }
        bool Search(int i)
        {
            if (evaluations > Budget) return false;
            if (i == free.Count) return Renders();
            foreach (var value in domains[i])
            {
                Set(ownerSamples, free[i].Path, value);
                if (Search(i + 1)) return true;
            }
            Set(ownerSamples, free[i].Path, Default(producer, free[i].Type, 0));
            return false;
        }
        var key = row is { } at ? slot.K + "#" + at.Row : slot.K;
        if (Search(0))
        {
            foreach (var l in free) fixedLeaves.Add(l.Path);
            explained.Add(key);
        }
        else unexplained.Add(new JsonObject { ["k"] = key, ["expected"] = expected, ["expression"] = slot.Expression });
    }

    private static string Evaluate(string expression, string owner, JsonObject all, (string List, int Row)? row)
    {
        var scope = Scope(owner, all);
        if (row is { } r)
        {
            var list = PrototypeRender.Expressions.Evaluate(r.List, scope) as PrototypeRender.ListValue ?? throw new PrototypeRender.UnevaluableException("no rows");
            scope = scope.With(r.List, r.Row < list.Items.Count ? list.Items[r.Row] : null);
        }
        return PrototypeRender.Expressions.ToText(PrototypeRender.Expressions.Evaluate(expression, scope));
    }

    /// <summary>The evaluation scope of an owner's example outputs (the read-back builds the same one: PrototypeRender.SampleVars).</summary>
    internal static PrototypeRender.Scope Scope(string owner, JsonObject all)
    {
        var scope = new PrototypeRender.Scope(_ => null);
        foreach (var (name, value) in PrototypeRender.SampleVars(all, [owner])) scope.Vars[name] = value;
        return scope;
    }

    /// <summary>The values a leaf may take to render <paramref name="text"/>.</summary>
    private static List<JsonNode?> Domain(string type, string text, string expression, PrototypeProducer producer, DateTime day)
    {
        var values = new List<JsonNode?>();
        void Add(JsonNode? v) { if (!values.Any(x => JsonNode.DeepEquals(x, v))) values.Add(v); }
        var times = Regex.Matches(text, @"(?<!\d)(\d{1,2}):(\d{2})(?!\d)").Select(m => (H: int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), M: int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture))).ToList();
        var numbers = Regex.Matches(text, @"\d+").Select(m => long.Parse(m.Value, CultureInfo.InvariantCulture)).ToList();
        switch (type)
        {
            case "Boolean": Add(false); Add(true); break;
            case "Integer" or "Long Integer":
                foreach (var (h, m) in times) { Add((long)(h * 3600 + m * 60)); Add((long)(h * 60 + m)); }
                foreach (var n in numbers) Add(n);
                Add(0L); Add(1L);
                break;
            case "Decimal" or "Currency":
                foreach (var m in Regex.Matches(text, @"\d+(?:[.,]\d+)?").Select(m => m.Value.Replace(',', '.')))
                    if (decimal.TryParse(m, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) Add(d);
                Add(0m);
                break;
            case "Time":
                foreach (var (h, m) in times) Add($"{h:00}:{m:00}:00");
                Add("00:00:00");
                break;
            case "Date Time":
                foreach (var (h, m) in times) Add(day.AddHours(h).AddMinutes(m).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                Add(day.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                break;
            case "Date":
                foreach (var n in numbers.Where(n => n is >= 1 and <= 31)) Add(new DateTime(day.Year, day.Month, (int)Math.Min(n, DateTime.DaysInMonth(day.Year, day.Month))).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
                Add(day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
                break;
            case "Text" or "Email" or "Phone Number":
                Add(text);
                foreach (Match literal in Regex.Matches(expression, "\"((?:[^\"]|\"\")*)\""))
                {
                    var l = literal.Groups[1].Value.Replace("\"\"", "\"");
                    if (l.Length > 0 && text.Contains(l, StringComparison.Ordinal)) Add(text.Replace(l, "").Trim());
                }
                Add("");
                break;
            default:
                if (PrototypeProducer.Shape(type) is { Shape: "identifier" } id)
                {
                    if (producer.Statics.TryGetValue(id.Base, out var records))
                        foreach (var r in records) if (long.TryParse(r.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)) Add(n);
                    foreach (var n in numbers) Add(n);
                    Add(0L);
                }
                break;
        }
        return values;
    }

    /// <summary>The default example value of a type: a record of defaults (two levels of records), an empty list, the basic null.</summary>
    internal static JsonNode? Default(PrototypeProducer producer, string type, int depth)
    {
        var (b, shape) = PrototypeProducer.Shape(type);
        if (shape == "list") return new JsonArray();
        if (shape == "identifier") return 0L;
        switch (type)
        {
            case "Boolean": return false;
            case "Integer" or "Long Integer": return 0L;
            case "Decimal" or "Currency": return 0m;
            case "Date": return "1900-01-01";
            case "Time": return "00:00:00";
            case "Date Time": return "1900-01-01 00:00:00";
            case "Binary Data": return null;
        }
        if (PrototypeProducer.IsBasic(type)) return "";
        if (producer.Fields(b) is { } fields && depth < 4)
        {
            var record = new JsonObject();
            foreach (var f in fields) record[f.Name] = Default(producer, f.Type, depth + 1);
            return record;
        }
        return depth < 4 ? new JsonObject() : null;
    }

    private static JsonObject Entities(PrototypeProducer producer)
    {
        var entities = new JsonObject();
        foreach (var (name, records) in producer.Statics)
        {
            var e = new JsonObject();
            foreach (var r in records) e[r.Identifier] = long.TryParse(r.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : r.Id;
            entities[name] = e;
        }
        return entities;
    }

    /// <summary>Writes a value at a path of the owner's samples (Resumo.Resumo.Dia.Etapas[2].HorarioPrevisto).</summary>
    internal static void Set(JsonObject ownerSamples, string path, JsonNode? value)
    {
        var tokens = Regex.Matches(path, @"([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?").Select(m => (Name: m.Groups[1].Value, Index: m.Groups[2].Success ? int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : -1)).ToList();
        JsonNode? current = ownerSamples;
        for (var i = 0; i < tokens.Count; i++)
        {
            var (name, index) = tokens[i];
            var last = i == tokens.Count - 1;
            if (current is not JsonObject o) return;
            if (last && index < 0) { o[name] = value?.DeepClone(); return; }
            var next = o[name];
            if (index >= 0)
            {
                if (next is not JsonArray a || index >= a.Count) return;
                if (last) { a[index] = value?.DeepClone(); return; }
                current = a[index];
            }
            else
            {
                if (next is not JsonObject) { next = new JsonObject(); o[name] = next; }
                current = next;
            }
        }
    }
}
