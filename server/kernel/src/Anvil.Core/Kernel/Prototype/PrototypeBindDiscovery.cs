using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// The deterministic proposal of data.bind (docs/PROTOTIPO-NATIVO.md 2.12), without any model reading the screens: the capture
/// already holds every value it rendered, so each binding comes from a closed table of correlations between those values and the
/// producer's surface (names, types, outputs and static records):
/// <list type="bullet">
/// <item>source of a view: the read action (no write verb, inputs a default can fill) whose outputs explain most of the view;</item>
/// <item>list: the output list whose row type explains the template's fields (a label of the prototype's collection that is a
/// record of a static entity of the producer -> its Identifier attribute; HH:mm texts -> a Time or Date Time attribute; the same
/// attribute name);</item>
/// <item>label: a text that is a static record's label (or the prototype's label correlated with one) -> an If over the records of
/// an Identifier output, each with the prototype's own text;</item>
/// <item>time: "previsto 12:00" -> the Time/Date Time output whose name shares a stem with the words around the time;</item>
/// <item>duration: a bare "02:49" whose neighbour texts share a stem with an Integer output of seconds or minutes;</item>
/// <item>name: a short capitalized text alone in its element (outside buttons and emphasis) -> the Text output named Nome/Name;</item>
/// <item>row variants: an attribute of a list row that takes two values -> the row's only Boolean, or its position (last row);</item>
/// <item>events: a button of a group of buttons -> navigation to the view its text names; a PDF/export button -> the action that
/// returns a Binary Data, then download; any other button -> the write action whose name shares a stem with its texts, then
/// refresh of the view's source.</item>
/// </list>
/// Each proposal is offered only after the offline build of the whole proposal passes (PrototypeBindPrepass); what no rule explains
/// comes back unresolved, without a patch.
/// </summary>
internal static class PrototypeBindDiscovery
{
    public sealed record Item(string Kind, string Section, string Key, string Owner, JsonNode? Value, string Why, string? Text = null, bool Unresolved = false, bool Required = true)
    {
        public bool Validated { get; set; }
        public string? Failure { get; set; }
    }

    public sealed class Proposal
    {
        public required JsonObject Bind { get; init; }
        public List<Item> Items { get; } = [];
    }

    private sealed record Leaf(string Path, string Type, string Name, bool Scalar);

    private static readonly HashSet<string> Stop = new(StringComparer.Ordinal) { "de", "do", "da", "dos", "das", "para", "o", "a", "os", "as", "e", "the", "of", "to", "and", "em", "no", "na", "por", "is", "has", "ha" };

    public static Proposal Propose(PrototypeCapture capture, JsonObject bind, PrototypeProducer producer, PrototypeBind.Result applied)
    {
        var json = capture.Json;
        var corrected = bind.DeepClone().AsObject();
        var proposal = new Proposal { Bind = corrected };
        var texts = new PrototypeExploredTexts(json);
        var labels = LabelMap(json, producer);
        var owners = PrototypeCapture.Objects(json["views"]).Select(v => (Key: "v:" + v["key"], Section: "screens", Name: v["key"]!.ToString(), Root: v["root"] as JsonObject))
            .Concat(PrototypeCapture.Objects(json["modals"]).Select(m => (Key: "m:" + m["key"], Section: "modals", Name: m["key"]!.ToString(), Root: m["root"] as JsonObject))).ToList();
        var unbound = applied.Unbound.ToList();
        var listsBySource = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, section, name, root) in owners)
        {
            if (root == null) continue;
            var ownUnbound = unbound.Where(u => u.View == key).ToList();
            // the source: the binding's own, else the read action that explains most of the owner
            var sources = new Dictionary<string, IReadOnlyList<ProducerParam>>(StringComparer.OrdinalIgnoreCase);
            if (corrected[section]?[name]?["source"] is JsonObject given && producer.Actions.TryGetValue(given["action"]?.ToString() ?? "", out var givenAction))
                sources[given["as"]?.ToString() ?? givenAction.Name] = Outputs(givenAction, given);
            else
            {
                var best = ChooseSource(producer, root, json, texts, key, labels, section == "modals" ? ModalParams(json, name) : []);
                if (best != null)
                {
                    var (action, args) = best.Value;
                    var source = new JsonObject { ["action"] = action.Name };
                    if (args.Count > 0) source["args"] = new JsonObject(args.Select(a => KeyValuePair.Create(a.Key, (JsonNode?)a.Value)));
                    Put(corrected, section, name, new JsonObject { ["source"] = source });
                    proposal.Items.Add(new Item("source", section, name, key, new JsonObject { ["source"] = source.DeepClone() }, $"{action.Name} explains the {(section == "screens" ? "view" : "popup")} best (its outputs correlate with its lists and texts)"));
                    sources[action.Name] = action.Outputs;
                }
            }
            var leaves = sources.SelectMany(s => Leaves(producer, s.Key, s.Value)).ToList();
            // lists of the prototype's collections
            foreach (var u in ownUnbound.Where(u => u.Kind == "list"))
            {
                var node = PrototypeBind.FindNode(json, u.Key);
                var list = node?["list"] as JsonObject;
                if (node == null || list == null) continue;
                var choice = ChooseList(producer, leaves, list, json, texts, key, u.Key, labels);
                if (choice == null)
                {
                    proposal.Items.Add(new Item("list", "lists", u.Key, key, null, $"no output list of {(sources.Count > 0 ? string.Join(", ", sources.Keys) : "a source")} explains the rows of {u.Text}", Unresolved: true));
                    continue;
                }
                Put(corrected, "lists", u.Key, choice.Path);
                listsBySource[u.Key] = choice.Path;
                proposal.Items.Add(new Item("list", "lists", u.Key, key, choice.Path, $"the rows of {u.Text} are the rows of {choice.Path} ({choice.Why})"));
                // the template's slots and row variants
                foreach (var (slotK, expression, why) in choice.Slots)
                {
                    if (expression == null) { proposal.Items.Add(new Item("slot", "slots", slotK, key, null, why, Unresolved: true)); continue; }
                    Put(corrected, "slots", slotK, expression);
                    proposal.Items.Add(new Item("slot", "slots", slotK, key, expression, why));
                }
            }
            // texts outside lists
            foreach (var (slotK, text, expression, why) in OutsideSlots(root, key, texts, leaves, labels, json))
            {
                if (corrected["slots"]?[slotK] != null || (corrected["slots"] as JsonObject)?.ContainsKey(slotK) == true) continue;
                Put(corrected, "slots", slotK, expression);
                proposal.Items.Add(new Item("slot", "slots", slotK, key, expression, why, text, Required: false));
            }
            // events
            var sourceName = sources.Keys.FirstOrDefault();
            foreach (var u in ownUnbound.Where(u => u.Kind == "event"))
            {
                var e = PrototypeCapture.Objects(json["events"]).FirstOrDefault(x => x["key"]?.ToString() == u.Key);
                if (e == null) continue;
                var (value, why) = EventBinding(e, root, json, producer, sourceName, texts, key, owners.Where(o => o.Section == "screens").Select(o => (o.Name, o.Root)).ToList());
                if (value == null) { proposal.Items.Add(new Item("event", "events", u.Key, key, null, why, Unresolved: true)); continue; }
                Put(corrected, "events", u.Key, value);
                proposal.Items.Add(new Item("event", "events", u.Key, key, value, why));
            }
            // slots the binding still lacks inside lists it gave (a row field of the prototype's collection)
            foreach (var u in ownUnbound.Where(u => u.Kind == "slot"))
                if (!proposal.Items.Any(i => i.Key == u.Key))
                    proposal.Items.Add(new Item("slot", "slots", u.Key, key, null, u.Why, u.Text, Unresolved: true));
        }
        // anything still unbound that no owner loop reached (a shell event)
        foreach (var u in unbound.Where(u => !proposal.Items.Any(i => i.Key == u.Key)))
            proposal.Items.Add(new Item(u.Kind, u.Kind == "list" ? "lists" : u.Kind == "slot" ? "slots" : "events", u.Key, u.View, null, u.Why, u.Text, Unresolved: true));
        if (corrected["producer"] == null) corrected["producer"] = producer.Name;
        return proposal;
    }

    private static IReadOnlyList<ProducerParam> Outputs(ProducerAction action, JsonObject source)
        => source["outputs"] is JsonArray subset ? action.Outputs.Where(o => subset.Any(s => string.Equals(s?.ToString(), o.Name, StringComparison.OrdinalIgnoreCase))).ToList() : action.Outputs;

    private static void Put(JsonObject bind, string section, string key, JsonNode? value)
    {
        if (bind[section] is not JsonObject s) { s = new JsonObject(); bind[section] = s; }
        s[key] = value?.DeepClone();
    }

    private static List<(string Name, string Type)> ModalParams(JsonObject json, string modal)
        => PrototypeCapture.Objects(PrototypeCapture.Objects(json["modals"]).FirstOrDefault(m => m["key"]?.ToString() == modal)?["params"]).Select(p => (p["name"]!.ToString(), p["type"]?.ToString() ?? "Integer")).ToList();

    // ---- the producer's leaves ----------------------------------------------------------------------------------------------

    /// <summary>Every attribute path of a data action's outputs, three levels deep, without going through lists (a list is a leaf of
    /// its own, Scalar=false).</summary>
    private static List<Leaf> Leaves(PrototypeProducer producer, string asName, IReadOnlyList<ProducerParam> outputs)
    {
        var leaves = new List<Leaf>();
        void Walk(string path, string type, string name, int depth)
        {
            var shape = PrototypeProducer.Shape(type).Shape;
            if (shape == "list") { leaves.Add(new(path, type, name, false)); return; }
            if (PrototypeProducer.IsBasic(type) || shape == "identifier") { leaves.Add(new(path, type, name, true)); return; }
            if (depth >= 3 || producer.Fields(type) is not { } fields) return;
            foreach (var f in fields) Walk(path + "." + f.Name, f.Type, f.Name, depth + 1);
        }
        foreach (var o in outputs) Walk(asName + "." + o.Name, o.Type, o.Name, 0);
        return leaves;
    }

    // ---- text helpers -------------------------------------------------------------------------------------------------------

    internal static string Fold(string text)
    {
        var d = text.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder();
        foreach (var ch in d) if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark) sb.Append(char.ToLowerInvariant(ch));
        return sb.ToString();
    }

    /// <summary>The stems of a text or of a camel-case name: words of letters, folded, without stop words, cut at 5 letters.</summary>
    internal static HashSet<string> Stems(string text)
    {
        var spaced = Regex.Replace(text, "([a-z])([A-Z])", "$1 $2");
        return Regex.Split(Fold(spaced), "[^a-z]+").Where(w => w.Length >= 3 && !Stop.Contains(w)).Select(w => w.Length > 5 ? w[..5] : w).ToHashSet(StringComparer.Ordinal);
    }

    private static bool SharesStem(HashSet<string> a, HashSet<string> b) => a.Any(x => b.Any(y => x == y || (x.Length >= 3 && y.Length >= 3 && (x.StartsWith(y[..3], StringComparison.Ordinal) && y.StartsWith(x[..3], StringComparison.Ordinal)))));

    private static readonly Regex Time = new(@"(?<!\d)(\d{1,2}):(\d{2})(?!\d)", RegexOptions.Compiled);

    // ---- labels: the prototype's texts that are records of a static entity of the producer ----------------------------------

    /// <summary>The prototype label -> (static entity, record) correlation: the text fields of the store's collections whose values
    /// are labels of a static entity of the producer (equal, or the prototype's words inside the record's label; one record per
    /// label, in order), when at least half of the values correlate.</summary>
    internal static Dictionary<string, (string Entity, ProducerRecord Record)> LabelMap(JsonObject json, PrototypeProducer producer)
    {
        var map = new Dictionary<string, (string, ProducerRecord)>(StringComparer.Ordinal);
        foreach (var c in PrototypeCapture.Objects(json["store"]?["collections"]).Where(c => c["snapshot"] == null))
            foreach (var f in PrototypeCapture.Objects(c["fields"]).Where(f => f["type"]?.ToString() == "Text"))
            {
                var values = PrototypeCapture.Objects(c["rows"]).Select(r => r[f["name"]!.ToString()]?.ToString()).OfType<string>().Where(v => v.Length > 0).Distinct().ToList();
                if (values.Count == 0) continue;
                foreach (var (entity, records) in producer.Statics)
                {
                    var assigned = Correlate(values, records);
                    if (assigned.Count * 2 < values.Count) continue;
                    foreach (var (v, r) in assigned) map.TryAdd(v, (entity, r));
                }
            }
        return map;
    }

    private static Dictionary<string, ProducerRecord> Correlate(IReadOnlyList<string> values, IReadOnlyList<ProducerRecord> records)
    {
        var assigned = new Dictionary<string, ProducerRecord>(StringComparer.Ordinal);
        var taken = new HashSet<ProducerRecord>();
        // equal labels first, then the prototype's words inside a record's label (fewest extra words), each record once
        foreach (var v in values)
            if (records.FirstOrDefault(r => !taken.Contains(r) && r.Label != null && Fold(r.Label).Trim() == Fold(v).Trim()) is { } exact) { assigned[v] = exact; taken.Add(exact); }
        foreach (var v in values.Where(v => !assigned.ContainsKey(v)))
        {
            var mine = Stems(v);
            if (mine.Count == 0) continue;
            var candidate = records.Where(r => !taken.Contains(r) && r.Label != null && mine.All(s => Stems(r.Label!).Contains(s)))
                .OrderBy(r => Stems(r.Label!).Count - mine.Count).ThenBy(r => r.Order).FirstOrDefault();
            if (candidate != null) { assigned[v] = candidate; taken.Add(candidate); }
        }
        return assigned;
    }

    /// <summary>The label expression over an Identifier: an If per record of the static entity, each with the prototype's own text
    /// (the producer's label for a record the prototype never shows).</summary>
    internal static string LabelExpression(string identifier, string entity, PrototypeProducer producer, IReadOnlyDictionary<string, (string Entity, ProducerRecord Record)> labels)
    {
        var records = producer.Statics.TryGetValue(entity, out var r) ? r : [];
        var text = "\"\"";
        foreach (var record in records.AsEnumerable().Reverse())
        {
            var own = labels.FirstOrDefault(l => l.Value.Entity == entity && l.Value.Record == record).Key ?? record.Label ?? record.Identifier;
            text = $"If({identifier} = Entities.{entity}.{record.Identifier}, {PrototypeExpr.Quote(own)}, {text})";
        }
        return text;
    }

    // ---- the source of an owner -----------------------------------------------------------------------------------------------

    private static (ProducerAction Action, Dictionary<string, string> Args)? ChooseSource(PrototypeProducer producer, JsonObject root, JsonObject json, PrototypeExploredTexts texts, string owner,
        Dictionary<string, (string Entity, ProducerRecord Record)> labels, List<(string Name, string Type)> modalParams)
    {
        (ProducerAction Action, Dictionary<string, string> Args, int Score)? best = null;
        foreach (var action in producer.Actions.Values.OrderBy(a => a.Name, StringComparer.Ordinal))
        {
            if (PrototypeBind.IsWriteAction(action.Name) || action.Outputs.Count == 0) continue;
            var args = new Dictionary<string, string>(StringComparer.Ordinal);
            var ok = true;
            foreach (var input in action.Inputs.Where(i => i.Mandatory))
            {
                // a popup's day: the date of its Integer parameter in the current month
                if (input.Type == "Date" && modalParams.Count == 1 && modalParams[0].Type == "Integer") { args[input.Name] = $"NewDate(Year(CurrDate()), Month(CurrDate()), {modalParams[0].Name})"; continue; }
                var value = PrototypeBind.DefaultArgument(input);
                if (input.Type.EndsWith(" Identifier", StringComparison.Ordinal) || (input.Type == "Text" && value == "\"\"")) { ok = false; break; }
                args[input.Name] = value;
            }
            if (!ok) continue;
            var leaves = Leaves(producer, action.Name, action.Outputs);
            var score = 0;
            var lists = new List<JsonObject>();
            Collect(root, lists);
            foreach (var list in lists)
                if (list["list"] is JsonObject l && l["collection"] != null && ChooseList(producer, leaves, l, json, texts, owner, list["k"]!.ToString(), labels) != null) score += 3;
            score += OutsideSlots(root, owner, texts, leaves, labels, json).Count;
            if (score == 0) continue;
            // the action that names the view (ObterEspelhoMensal for the view espelho) explains it first among equals
            if (SharesStem(Stems(action.Name), Stems(owner[2..]))) score += 2;
            // a name that reads (Obter, Get, Consultar...) before one that computes, among equals
            if (Regex.IsMatch(action.Name, "^(Obter|Get|Buscar|Consultar|Listar|List|Read|Fetch|Load|Carregar)", RegexOptions.IgnoreCase)) score += 1;
            // a popup's own parameter as an argument (the day it shows): the action is about that popup
            if (modalParams.Count > 0 && args.Values.Any(a => modalParams.Any(p => Regex.IsMatch(a, $@"(?<![\w.]){Regex.Escape(p.Name)}(?![\w])")))) score += 2;
            if (best == null || score > best.Value.Score || (score == best.Value.Score && action.Inputs.Count < best.Value.Action.Inputs.Count))
                best = (action, args, score);
        }
        return best == null ? null : (best.Value.Action, best.Value.Args);
    }

    private static void Collect(JsonObject n, List<JsonObject> lists)
    {
        if (n["list"] is JsonObject) lists.Add(n);
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Collect(o, lists);
        foreach (var c in n["else"] as JsonArray ?? []) if (c is JsonObject o) Collect(o, lists);
    }

    // ---- lists ------------------------------------------------------------------------------------------------------------------

    private sealed record ListChoice(string Path, string Why, List<(string K, string? Expression, string Why)> Slots);

    private static ListChoice? ChooseList(PrototypeProducer producer, List<Leaf> leaves, JsonObject list, JsonObject json, PrototypeExploredTexts texts, string owner, string listK,
        Dictionary<string, (string Entity, ProducerRecord Record)> labels)
    {
        var collection = list["collection"]?.ToString();
        var c = PrototypeCapture.Objects(json["store"]?["collections"]).FirstOrDefault(x => x["name"]?.ToString() == collection);
        var template = list["template"] as JsonObject;
        if (template == null) return null;
        var slots = TemplateSlots(template);
        var items = texts.Items(owner, listK).Count;
        ListChoice? best = null; var bestScore = 0;
        foreach (var leaf in leaves.Where(l => !l.Scalar))
        {
            var element = PrototypeProducer.Shape(leaf.Type).Base;
            if (producer.Fields(element) is not { } fields) continue;
            var current = leaf.Path + ".Current";
            var proposed = new List<(string, string?, string)>();
            var score = 0;
            foreach (var (k, field) in slots)
            {
                var observed = Enumerable.Range(0, Math.Max(items, 1)).Select(i => texts.Text(owner, k, listK, i)).OfType<string>().ToList();
                var fieldValues = c == null ? [] : PrototypeCapture.Objects(c["rows"]).Select(r => r[field]?.ToString()).OfType<string>().ToList();
                // label: the field's values are records of a static entity, and the row has its Identifier
                var label = fieldValues.Concat(observed).Select(v => labels.TryGetValue(v, out var m) ? m.Entity : null).OfType<string>().FirstOrDefault();
                var idAttr = label == null ? null : fields.FirstOrDefault(f => f.Type == label + " Identifier");
                if (label != null && idAttr != null)
                {
                    proposed.Add((k, LabelExpression(current + "." + idAttr.Name, label, producer, labels), $"its texts are records of {label} ({idAttr.Name})"));
                    score += 2; continue;
                }
                // time: HH:mm texts -> a Time or Date Time attribute (a name with a stem of the field's, else the first)
                if (observed.Count > 0 && observed.All(o => Time.IsMatch(o)))
                {
                    var times = fields.Where(f => f.Type is "Time" or "Date Time").ToList();
                    var chosen = times.FirstOrDefault(f => SharesStem(Stems(f.Name), Stems(field))) ?? times.FirstOrDefault(f => Stems(f.Name).Overlaps(["previ", "horar", "hora", "time"])) ?? times.FirstOrDefault();
                    if (chosen != null) { proposed.Add((k, Around(observed[0], $"FormatDateTime({current}.{chosen.Name}, \"HH:mm\")"), $"its texts are times ({chosen.Name}: {chosen.Type})")); score += 1; continue; }
                }
                var same = fields.FirstOrDefault(f => string.Equals(f.Name, field, StringComparison.OrdinalIgnoreCase));
                if (same != null) { proposed.Add((k, Text(current + "." + same.Name, same.Type), $"the attribute of the same name ({same.Name})")); score += 1; continue; }
                // day of the month: the rows show 1..31 and the row has a Date (a calendar)
                if (observed.Count > 0 && observed.All(o => int.TryParse(o, out var d) && d is >= 1 and <= 31) && fields.FirstOrDefault(f => f.Type == "Date") is { } date)
                { proposed.Add((k, $"IntegerToText(Day({current}.{date.Name}))", $"its texts are days of the month ({date.Name}: {date.Type})")); score += 1; continue; }
                proposed.Add((k, null, $"no attribute of {element} explains the field {field} of the prototype's rows"));
            }
            // row variants: an attribute that repeats a text of the row, or that takes two values across the rendered rows
            var rowTexts = proposed.Where(p => p.Item2 != null && !p.Item1.Contains('@'))
                .Select(p => (K: p.Item1, Expression: p.Item2!, Values: Enumerable.Range(0, items).Select(i => texts.Text(owner, p.Item1, listK, i)).ToList())).ToList();
            foreach (var variant in Variants(template, owner, listK, texts, fields, current, rowTexts)) proposed.Add(variant);
            if (score > bestScore || (score == bestScore && score > 0 && best != null && leaf.Path.Length < best.Path.Length))
            {
                bestScore = score;
                best = new ListChoice(leaf.Path, $"{score} field(s) of the rows correlate with {element}", proposed);
            }
        }
        return bestScore > 0 ? best : null;
    }

    /// <summary>The template's text slots that read a field of the prototype's collection (k, field).</summary>
    private static List<(string K, string Field)> TemplateSlots(JsonObject template)
    {
        var slots = new List<(string, string)>();
        void Walk(JsonObject n)
        {
            if (n["x"] != null && n["expr"]?["value"]?["field"]?.ToString() is { } field && n["k"]?.ToString() is { } k) slots.Add((k, field));
            if (n["list"] != null) return;
            foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o);
        }
        Walk(template);
        return slots;
    }

    private static IEnumerable<(string K, string? Expression, string Why)> Variants(JsonObject template, string owner, string listK, PrototypeExploredTexts texts, IReadOnlyList<ProducerParam> fields, string current,
        IReadOnlyList<(string K, string Expression, List<string?> Values)> rowTexts)
    {
        var rows = texts.Items(owner, listK);
        if (rows.Count < 2) yield break;
        var booleans = fields.Where(f => f.Type == "Boolean").ToList();
        var list = current[..^".Current".Length];
        var elements = new List<JsonObject>();
        void Walk(JsonObject n) { if (n["t"] != null) elements.Add(n); if (n["list"] != null) return; foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o); }
        Walk(template);
        foreach (var element in elements)
        {
            var k = element["k"]?.ToString();
            if (k == null) continue;
            var rest = k.Length > listK.Length + 2 ? k[(listK.Length + 2)..] : "";
            // a data-* attribute that repeats a text of the row (data-dia="5" on the day 5): that text's expression
            foreach (var (attribute, _) in (element["a"] as JsonArray ?? []).OfType<JsonArray>().Where(a => a.Count == 2 && a[0]?.ToString()?.StartsWith("data-", StringComparison.Ordinal) == true).Select(a => (a[0]!.ToString(), a[1]?.ToString())))
            {
                if (element["attrExpr"]?[attribute] != null) continue;
                var values = rows.Select(r => (r["k"]?.ToString() is { } rk ? (rest.Length == 0 ? r : FindIn(r, rk + rest)) : null) is { } n ? PrototypeBind.Attr(n, attribute) : null).ToList();
                if (values.Any(v => v == null) || values.Distinct().Count() < 2) continue;
                var same = rowTexts.FirstOrDefault(t => t.Values.Count == values.Count && t.Values.SequenceEqual(values));
                yield return same.Expression != null
                    ? ($"{k}@{attribute}", same.Expression, $"the {attribute} of each row is its text {same.K}")
                    : ($"{k}@{attribute}", null, $"the {attribute} of each row differs and no text of the row repeats it");
            }
            foreach (var attribute in new[] { "style", "class" })
            {
                var values = rows.Select(r => (r["k"]?.ToString() is { } rk ? (rest.Length == 0 ? r : FindIn(r, rk + rest)) : null) is { } n ? PrototypeBind.Attr(n, attribute) ?? "" : null).ToList();
                if (values.Any(v => v == null)) continue;
                var distinct = values.Distinct().ToList();
                if (distinct.Count != 2) continue;
                var first = values[0]!; var other = distinct.First(v => v != first)!;
                var last = values[^1]!;
                // the last row alone differs: its position
                if (values.Take(values.Count - 1).All(v => v == values[0]) && last != values[0])
                {
                    yield return ($"{k}@{attribute}", $"If({list}.CurrentRowNumber = {list}.Length - 1, {PrototypeExpr.Quote(last)}, {PrototypeExpr.Quote(values[0]!)})", $"the {attribute} of the last row differs (its position)");
                    continue;
                }
                if (booleans.Count == 1)
                    yield return ($"{k}@{attribute}", $"If({current}.{booleans[0].Name}, {PrototypeExpr.Quote(first)}, {PrototypeExpr.Quote(other)})", $"the {attribute} of the rows takes two values: the row's {booleans[0].Name}");
                else
                    yield return ($"{k}@{attribute}", null, $"the {attribute} of the rows takes two values and {(booleans.Count == 0 ? "the row has no Boolean" : "the row has several Booleans")} to tell them apart");
            }
        }
    }

    private static JsonObject? FindIn(JsonObject n, string k)
    {
        if (n["k"]?.ToString() == k) return n;
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o && FindIn(o, k) is { } hit) return hit;
        return null;
    }

    /// <summary>The expression of a text slot read from a leaf of this type.</summary>
    private static string Text(string path, string type) => type switch
    {
        "Text" or "Email" or "Phone Number" => path,
        "Integer" => $"IntegerToText({path})",
        "Long Integer" => $"LongIntegerToText({path})",
        "Decimal" or "Currency" => $"DecimalToText({path})",
        "Boolean" => $"If({path}, \"true\", \"false\")",
        "Time" => $"FormatDateTime({path}, \"HH:mm\")",
        "Date" => $"FormatDateTime({path}, \"dd/MM/yyyy\")",
        "Date Time" => $"FormatDateTime({path}, \"dd/MM/yyyy HH:mm\")",
        _ => $"IntegerToText(IdentifierToInteger({path}))",
    };

    /// <summary>The words around the time of a text kept as literals: "previsto 12:00" -> "previsto " + &lt;time&gt;.</summary>
    private static string Around(string text, string core)
    {
        var m = Time.Match(text);
        if (!m.Success) return core;
        var before = text[..m.Index]; var after = text[(m.Index + m.Length)..];
        return (before.Length > 0 ? PrototypeExpr.Quote(before) + " + " : "") + core + (after.Length > 0 ? " + " + PrototypeExpr.Quote(after) : "");
    }

    // ---- texts outside lists ----------------------------------------------------------------------------------------------------

    private static List<(string K, string Text, string Expression, string Why)> OutsideSlots(JsonObject root, string owner, PrototypeExploredTexts texts, List<Leaf> leaves,
        Dictionary<string, (string Entity, ProducerRecord Record)> labels, JsonObject json)
    {
        var found = new List<(string, string, string, string)>();
        var scalars = leaves.Where(l => l.Scalar).ToList();
        if (scalars.Count == 0) return found;
        var used = new HashSet<string>(StringComparer.Ordinal);
        // the words of the interface itself (the views' and popups' names, the texts of buttons and links) are never a name
        var interfaceWords = InterfaceWords(json);
        void Walk(JsonObject n, JsonObject? parent, JsonObject? grand, List<string> ancestors)
        {
            if (n["x"] != null)
            {
                if (n["kept"] != null || n["expr"]?["bound"] != null || n["k"]?.ToString() is not { } k) return;
                var text = PrototypeExploredTexts.Normalize(n["x"]!.ToString());
                if (text.Length == 0) return;
                // one leaf explains one text of the owner: a second text that would read it stays unresolved
                var available = scalars.Where(l => !used.Contains(l.Path)).ToList();
                if (Rule(n, parent, grand, ancestors, text, owner, texts, available, labels, interfaceWords) is { } rule) { found.Add((k, text, rule.Expression, rule.Why)); used.Add(rule.Leaf); }
                return;
            }
            if (n["list"] != null) return; // a list's texts are its rows'
            var tag = n["t"]?.ToString() ?? "";
            var next = new List<string>(ancestors) { tag };
            foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o, n, parent, next);
        }
        Walk(root, null, null, []);
        return found;
    }

    private static HashSet<string> InterfaceWords(JsonObject json)
    {
        var words = new HashSet<string>(StringComparer.Ordinal);
        foreach (var v in PrototypeCapture.Objects(json["views"])) { words.Add(Fold(v["key"]?.ToString() ?? "")); words.Add(Fold(v["name"]?.ToString() ?? "")); }
        foreach (var m in PrototypeCapture.Objects(json["modals"])) words.Add(Fold(m["name"]?.ToString() ?? ""));
        void Walk(JsonNode? n)
        {
            if (n is not JsonObject o) return;
            if (o["t"]?.ToString() is "button" or "a") words.Add(Fold(PrototypeExploredTexts.Normalize(PrototypeExploredTexts.TextOf(o))));
            foreach (var c in o["c"] as JsonArray ?? []) Walk(c);
            Walk(o["list"]?["template"]);
        }
        foreach (var v in PrototypeCapture.Objects(json["views"])) Walk(v["root"]);
        foreach (var m in PrototypeCapture.Objects(json["modals"])) Walk(m["root"]);
        return words;
    }

    private static (string Expression, string Why, string Leaf)? Rule(JsonObject node, JsonObject? parent, JsonObject? grand, List<string> ancestors, string text, string owner, PrototypeExploredTexts texts,
        List<Leaf> scalars, Dictionary<string, (string Entity, ProducerRecord Record)> labels, HashSet<string> interfaceWords)
    {
        // label: the text is a static record (the prototype's own label or the producer's)
        var entity = labels.TryGetValue(text, out var mapped) ? mapped.Entity : null;
        if (entity != null)
        {
            var candidates = scalars.Where(l => l.Type == entity + " Identifier").ToList();
            var chosen = candidates.FirstOrDefault(l => Stems(l.Name).Overlaps(["proxi", "next", "atual", "curre"])) ?? candidates.FirstOrDefault();
            if (chosen != null) return (LabelExpressionFor(chosen.Path, entity, labels), $"the text is the record {mapped.Record.Identifier} of {entity}: {chosen.Path}", chosen.Path);
        }
        var siblings = string.Join(" ", (parent?["c"] as JsonArray ?? []).OfType<JsonObject>().Where(c => c != node).Select(PrototypeExploredTexts.TextOf));
        var m = Time.Match(text);
        if (m.Success)
        {
            var words = text.Remove(m.Index, m.Length).Trim();
            // time with words around it: the Time/Date Time output whose name shares their stem
            if (words.Length > 0 && words is not ("+" or "-"))
            {
                var stems = Stems(words);
                var chosen = scalars.FirstOrDefault(l => l.Type is "Time" or "Date Time" && SharesStem(Stems(l.Name), stems));
                if (chosen != null) return (Around(text, $"FormatDateTime({chosen.Path}, \"HH:mm\")"), $"\"{words}\" names {chosen.Path} ({chosen.Type})", chosen.Path);
            }
            // a bare duration (or a signed balance): the Integer output of seconds or minutes whose name shares a stem with the
            // texts beside it (its element's and the enclosing one's: the label above a counter)
            else if (Regex.IsMatch(text, @"^[+-]?\d{2}:\d{2}$"))
            {
                var context = Stems(siblings + " " + NeighbourTexts(grand ?? parent));
                var durations = scalars.Where(l => l.Type is "Integer" or "Long Integer" && Regex.IsMatch(l.Name, "^(Segundos|Seconds|Minutos|Minutes|Saldo|Balance)", RegexOptions.IgnoreCase) && SharesStem(Stems(l.Name), context)).ToList();
                var chosen = durations.FirstOrDefault(l => Regex.IsMatch(l.Name, "^(Segundos|Seconds)", RegexOptions.IgnoreCase)) ?? durations.FirstOrDefault();
                if (chosen != null)
                {
                    var seconds = Regex.IsMatch(chosen.Name, "^(Segundos|Seconds)", RegexOptions.IgnoreCase);
                    var expression = text[0] is '+' or '-' ? $"If({chosen.Path} < 0, \"-\", \"+\") + " + Duration($"Abs({chosen.Path})", seconds) : Duration(chosen.Path, seconds);
                    return (expression, $"a duration beside \"{context.FirstOrDefault()}\": {chosen.Path}", chosen.Path);
                }
            }
            return null;
        }
        // a name: one to four capitalized words alone in a plain element
        if (Regex.IsMatch(text, @"^\p{Lu}[\p{L}'-]+( \p{Lu}[\p{L}'-]+){0,3}$") && !ancestors.Any(a => a is "button" or "a" or "label" or "b" or "strong" or "em" or "i" or "option" or "select")
            && (parent?["c"] as JsonArray ?? []).OfType<JsonObject>().Count(c => c["t"] != null || (c["x"]?.ToString()?.Trim().Length ?? 0) > 0) == 1 && !labels.ContainsKey(text)
            && !interfaceWords.Contains(Fold(text))
            // a caption is no name: a label in capitals (text-transform), or beside a number or a time in its block
            && !Regex.IsMatch(PrototypeBind.Attr(parent ?? node, "style") ?? "", @"text-transform:\s*uppercase", RegexOptions.IgnoreCase)
            && !(grand != null && grand["k"]?.ToString() != owner && (grand["c"] as JsonArray ?? []).OfType<JsonObject>().Where(c => c != parent).Any(c => Regex.IsMatch(PrototypeExploredTexts.TextOf(c), @"\d"))))
        {
            var chosen = scalars.FirstOrDefault(l => l.Type == "Text" && Regex.IsMatch(l.Name, "(Nome|Name)", RegexOptions.IgnoreCase));
            if (chosen != null) return (chosen.Path, $"a name shown alone: {chosen.Path}", chosen.Path);
        }
        return null;
    }

    private static string LabelExpressionFor(string path, string entity, Dictionary<string, (string Entity, ProducerRecord Record)> labels)
    {
        var records = labels.Values.Where(v => v.Entity == entity).Select(v => v.Record).Distinct().OrderBy(r => r.Order).ToList();
        var text = "\"\"";
        foreach (var record in records.AsEnumerable().Reverse())
        {
            var own = labels.First(l => l.Value.Entity == entity && l.Value.Record == record).Key;
            text = $"If({path} = Entities.{entity}.{record.Identifier}, {PrototypeExpr.Quote(own)}, {text})";
        }
        return text;
    }

    private static string NeighbourTexts(JsonObject? parent) => parent == null ? "" : PrototypeExploredTexts.TextOf(parent);

    /// <summary>hh:mm of an amount of seconds or minutes, with built-ins only (Trunc, Mod, FormatText).</summary>
    internal static string Duration(string path, bool seconds)
    {
        var minutes = seconds ? $"Trunc({path} / 60)" : path;
        return $"FormatText(IntegerToText(DecimalToInteger(Trunc({minutes} / 60))), 2, 2, True, \"0\") + \":\" + FormatText(IntegerToText(DecimalToInteger(Mod({minutes}, 60))), 2, 2, True, \"0\")";
    }

    // ---- events ---------------------------------------------------------------------------------------------------------------

    private static (JsonObject? Value, string Why) EventBinding(JsonObject e, JsonObject root, JsonObject json, PrototypeProducer producer, string? source, PrototypeExploredTexts texts, string owner, List<(string Name, JsonObject? Root)> views)
    {
        var key = e["key"]!.ToString();
        var trigger = FindTrigger(root, key, null);
        // the text the trigger rendered (its content may be a list or an expression the capture annotated)
        var text = trigger.Node == null ? "" : (trigger.Node["k"]?.ToString() is { } tk ? texts.Text(owner, tk) : null) ?? PrototypeExploredTexts.Normalize(PrototypeExploredTexts.TextOf(trigger.Node));
        // a button of a group of buttons (a tab bar): navigation to the view its text names
        var siblings = (trigger.Parent?["c"] as JsonArray ?? []).OfType<JsonObject>().Where(c => c["t"]?.ToString() is "button" or "a").ToList();
        if (siblings.Count >= 2 && trigger.Node != null)
        {
            var target = views.FirstOrDefault(v => Fold(v.Name).Replace("-", " ") == Fold(text) || Stems(v.Name).SetEquals(Stems(text)) && Stems(text).Count > 0);
            if (target.Name != null) return (new JsonObject { ["navigate"] = target.Name }, $"a button of a group of {siblings.Count} named \"{text}\": the view {target.Name}");
            return (null, $"a button of a group of {siblings.Count} named \"{text}\": the capture has no view \"{text}\" to navigate to (a view the prototype switches in its script needs the capture of that view)");
        }
        var stems = Stems(text);
        // export: the action that returns a file
        if (Regex.IsMatch(Fold(text), @"\b(pdf|export|baixar|download|imprimir|print)"))
        {
            var file = producer.Actions.Values.OrderBy(a => a.Name, StringComparer.Ordinal).FirstOrDefault(a => a.Outputs.Any(o => o.Type == "Binary Data") && Fillable(a));
            if (file != null) return (Call(file, ["download"]), $"\"{text}\" exports: {file.Name} returns a file");
        }
        // any other button: the write action whose name shares a stem with its texts
        var writes = producer.Actions.Values.Where(a => PrototypeBind.IsWriteAction(a.Name) && Fillable(a)).OrderBy(a => a.Name, StringComparer.Ordinal).ToList();
        var write = writes.FirstOrDefault(a => SharesStem(Stems(a.Name), stems));
        if (write != null) return (Call(write, source != null ? ["refresh " + source] : []), $"\"{text}\" shares a stem with {write.Name}" + (source != null ? $"; then the view's source {source} again" : ""));
        return (null, $"no action of {producer.Name} explains \"{text}\" (no write action shares a stem with it)");
    }

    private static bool Fillable(ProducerAction action) => action.Inputs.Where(i => i.Mandatory).All(i => !i.Type.EndsWith(" Identifier", StringComparison.Ordinal) && !(i.Type == "Text" && PrototypeBind.DefaultArgument(i) == "\"\""));

    private static JsonObject Call(ProducerAction action, string[] then)
    {
        var value = new JsonObject { ["call"] = action.Name };
        var args = new JsonObject();
        foreach (var input in action.Inputs.Where(i => i.Mandatory)) args[input.Name] = PrototypeBind.DefaultArgument(input);
        if (args.Count > 0) value["args"] = args;
        if (then.Length > 0) value["then"] = new JsonArray(then.Select(t => (JsonNode)t).ToArray());
        return value;
    }

    private static (JsonObject? Node, JsonObject? Parent) FindTrigger(JsonObject n, string key, JsonObject? parent)
    {
        if ((n["events"] as JsonArray)?.Any(x => x?.ToString() == key) == true) return (n, parent);
        foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o && FindTrigger(o, key, n) is { Node: not null } hit) return hit;
        if (n["list"]?["template"] is JsonObject t && FindTrigger(t, key, n) is { Node: not null } inList) return inList;
        return (null, null);
    }
}
