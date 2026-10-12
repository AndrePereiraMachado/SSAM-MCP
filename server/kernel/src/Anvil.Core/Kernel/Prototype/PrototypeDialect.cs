using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// The capture as the render lane writes it (platforms/odc/facade/prototype, IR ssam-prototype-capture/1) read in the form the
/// compiler plans from (docs/PROTOTIPO-NATIVO.md 2.10 and 7.2). Both lanes wrote the same IR with a few different spellings; this
/// reader closes that gap in one place, deterministically, without guessing: every rewrite below is a change of spelling of
/// something the capture states, or a fact the capture states elsewhere put where the compiler reads it. The canonical hash is
/// taken over the capture as written (the facade's hash), never over this form. A capture already in the compiler's spelling
/// goes through unchanged.
/// <list type="bullet">
/// <item>dimensions: scope view/modal is a screen dimension of its views; a hidden dimension written by an event of another view
/// survives navigation, so it is global (2.6); literals compared with a dimension take its type.</item>
/// <item>events: view = a modal key is the modal's event (view = its first screen); view = shell is the shell's; node event keys
/// with no event are dropped (nothing observed to compile).</item>
/// <item>effects: by/value/from/collection of upsert, increment, insertFrom, updateFrom and removeWhere in the compiler's names;
/// generated keys ({key: max+1}) left to the compiler; agg sums as sum; validation rules as the failure condition of each
/// control and message, with the alert they write in as a message local; the toast dimension (aviso) as the toast effect;
/// setDimension bounds (min/max of the control) on the effect.</item>
/// <item>nodes: Expr cases (value -> then, else as an Expr), attribute expressions as {expr}, a conditional class as a class
/// expression, an icon whose name varies as If/else of two icons, counts by list name, list start/sortBy, a snapshot list as a
/// static collection of the store, the options of a select inside its control, form controls bound to the modal record field or to
/// a local of their name, the mount point's placeholder.</item>
/// <item>shell: siblings as after, inputs and events in the compiler's names (a record input, a sum input), the toast inputs.</item>
/// </list>
/// </summary>
public static class PrototypeDialect
{
    private static readonly Regex SimpleSelector = new(@"^(?<tag>[a-z][a-z0-9-]*)?(?<rest>(?:#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[^\]]+\])*)$", RegexOptions.Compiled);
    private static readonly Regex SelectorPart = new(@"#(?<id>[A-Za-z0-9_-]+)|\.(?<cls>[A-Za-z0-9_-]+)|\[(?<attr>[^\]=~|^$*]+)(?:=(?<q>[""']?)(?<val>[^""'\]]*)\k<q>)?\]", RegexOptions.Compiled);
    private static readonly HashSet<string> Comparisons = new(StringComparer.Ordinal) { "eq", "ne", "gt", "ge", "lt", "le" };

    /// <summary>The capture in the compiler's form (a new document; the given one is not changed).</summary>
    public static JsonObject Normalize(JsonObject capture)
    {
        var ir = capture.DeepClone().AsObject();
        new Reader(ir).Run();
        return ir;
    }

    private sealed class Reader(JsonObject ir)
    {
        private readonly Dictionary<string, JsonObject> _dims = new(StringComparer.Ordinal);
        private readonly Dictionary<string, JsonObject> _modals = new(StringComparer.Ordinal);
        private readonly Dictionary<string, JsonObject> _collections = new(StringComparer.Ordinal);
        private readonly HashSet<string> _views = new(StringComparer.Ordinal);
        private readonly HashSet<string> _events = new(StringComparer.Ordinal);
        /// <summary>A control name (its dimension key, or the name/id of the element of a dimension control) -> dimension key.</summary>
        private readonly Dictionary<string, string> _dimControls = new(StringComparer.Ordinal);
        /// <summary>The list parent key -> list name (counts read lists by name).</summary>
        private readonly Dictionary<string, string> _listNames = new(StringComparer.Ordinal);
        private readonly HashSet<string> _takenListNames = new(StringComparer.Ordinal);
        /// <summary>The element of a validation alert (its id) -> the message local the validation writes.</summary>
        private readonly Dictionary<string, string> _alerts = new(StringComparer.Ordinal);
        /// <summary>Nodes an update binds to a record field by selector (k -> field).</summary>
        private readonly Dictionary<string, string> _boundBySelector = new(StringComparer.Ordinal);
        private string _prefix = "";
        private bool _pt;
        private string _notice = "Aviso", _noticeError = "AvisoErro";

        public void Run()
        {
            _prefix = ir["app"]?["prefix"]?.ToString() ?? "";
            _pt = (ir["app"]?["lang"]?.ToString() ?? "").StartsWith("pt", StringComparison.OrdinalIgnoreCase);
            if (!_pt) { _notice = "Notice"; _noticeError = "NoticeError"; }
            foreach (var d in Objects(ir["dimensions"])) if (d["key"]?.ToString() is { } k) _dims[k] = d;
            foreach (var m in Objects(ir["modals"])) if (m["key"]?.ToString() is { } k) _modals[k] = m;
            foreach (var v in Objects(ir["views"])) if (v["key"]?.ToString() is { } k) _views.Add(k);
            foreach (var e in Objects(ir["events"])) if (e["key"]?.ToString() is { } k) _events.Add(k);
            PositionalKeys();
            ExtraAttributes();
            SnapshotLists();
            foreach (var c in Objects(ir["store"]?["collections"])) if (c["name"]?.ToString() is { } n) _collections[n] = c;
            Shell();
            ScanControls();
            Modals();
            ListNames();
            Dimensions();
            Events();
            Nodes();
            Explored();
        }

        /// <summary>The explored states as the read-back renders them: the dimensions of the view's canonical state under the
        /// state's own assignment (a management view is explored as the administrator), and the parameters a modal was opened
        /// with (the attribute its first trigger in the view carries: data-id="1004").</summary>
        private void Explored()
        {
            var views = Objects(ir["views"]).Where(v => v["key"] != null).ToDictionary(v => v["key"]!.ToString(), StringComparer.Ordinal);
            foreach (var state in Objects(ir["explored"]))
            {
                if (state["view"]?.ToString() is not { } viewKey || !views.TryGetValue(viewKey, out var view)) continue;
                var assign = new JsonObject();
                foreach (var (k, v) in view["state"] as JsonObject ?? []) assign[k] = v?.DeepClone();
                foreach (var (k, v) in state["assign"] as JsonObject ?? []) assign[k] = v?.DeepClone();
                state["assign"] = assign;
                if (state["modal"]?.ToString() is not { } modalKey || !_modals.TryGetValue(modalKey, out var modal) || state["modalParams"] != null) continue;
                var opener = Objects(modal["openedFrom"]).FirstOrDefault(o => o["view"]?.ToString() == viewKey && o["modal"] == null)?["event"]?.ToString();
                if (opener == null || Objects(ir["events"]).FirstOrDefault(e => e["key"]?.ToString() == opener) is not { } openEvent) continue;
                var trigger = view["root"] is JsonObject root ? Nodes(root).FirstOrDefault(n => (n["events"] as JsonArray ?? []).Any(x => x?.ToString() == opener)) : null;
                if (trigger == null) continue;
                var parameters = new JsonObject();
                foreach (var effect in EffectsOf(openEvent).Where(x => x["kind"]?.ToString() == "openPopup" && x["modal"]?.ToString() == modalKey))
                    foreach (var (input, value) in effect["inputs"] as JsonObject ?? [])
                        if (value?["param"]?.ToString() is { } param && Objects(openEvent["params"]).FirstOrDefault(p => p["name"]?.ToString() == param) is { } declared
                            && declared["from"]?.ToString() is { } from && Attr(trigger, from) is { } literal)
                            parameters[input] = Typed(literal, declared["type"]?.ToString() ?? "Text");
                if (parameters.Count > 0) state["modalParams"] = parameters;
            }
        }

        // ---- the store ----------------------------------------------------------------------------------------------------

        /// <summary>A collection without an integer key (key "#": lookups keyed by a text code, the items nested in an order)
        /// gets an Integer Id by position (1-based), the key every entity of the compile lane has.</summary>
        private void PositionalKeys()
        {
            foreach (var collection in Objects(ir["store"]?["collections"]))
            {
                if (collection["key"]?.ToString() != "#") continue;
                var fields = collection["fields"] as JsonArray ?? [];
                var taken = new HashSet<string>(fields.OfType<JsonObject>().Select(f => f["name"]?.ToString() ?? ""), StringComparer.OrdinalIgnoreCase);
                var key = "Id";
                for (var n = 2; taken.Contains(key); n++) key = "Id" + n;
                fields.Insert(0, new JsonObject { ["name"] = key, ["type"] = "Integer" });
                collection["fields"] = fields;
                collection["key"] = key;
                var rows = Objects(collection["rows"]);
                for (var i = 0; i < rows.Count; i++) rows[i][key] = i + 1;
            }
        }

        /// <summary>2.8: a slot of a correlated list nothing explains is an extra Text attribute of the collection with the value of
        /// the canonical rendering by key.</summary>
        private void ExtraAttributes()
        {
            var collections = Objects(ir["store"]?["collections"]);
            foreach (var extra in Objects(ir["extraAttributes"]))
            {
                if (extra["collection"]?.ToString() is not { } name || extra["name"]?.ToString() is not { } attribute) continue;
                var collection = collections.FirstOrDefault(c => c["name"]?.ToString() == name);
                if (collection == null) continue;
                var key = collection["key"]?.ToString() ?? "Id";
                var values = Objects(extra["values"]);
                var fields = collection["fields"] as JsonArray ?? [];
                if (!fields.OfType<JsonObject>().Any(f => f["name"]?.ToString() == attribute))
                    fields.Add(new JsonObject { ["name"] = attribute, ["type"] = "Text", ["length"] = TextLength(values.Select(v => v["value"]?.ToString() ?? "")) });
                foreach (var row in Objects(collection["rows"]))
                {
                    var match = values.FirstOrDefault(v => Same(v["key"], row[key]));
                    row[attribute] = match?["value"]?.ToString() ?? "";
                }
            }
        }

        /// <summary>2.8: a group without a correlated collection is a list over a static snapshot entity: a collection of the store
        /// nothing writes, with one row per rendered item (Id = its position).</summary>
        private void SnapshotLists()
        {
            var store = ir["store"] as JsonObject;
            if (store == null) { store = new JsonObject { ["collections"] = new JsonArray() }; ir["store"] = store; }
            if (store["collections"] is not JsonArray collections) { collections = []; store["collections"] = collections; }
            var names = new HashSet<string>(collections.OfType<JsonObject>().Select(c => c["name"]?.ToString() ?? ""), StringComparer.Ordinal);
            foreach (var node in AllNodes())
            {
                if (node["list"] is not JsonObject list || list["snapshot"] is not JsonObject snapshot || list["collection"] is JsonValue) continue;
                var entity = snapshot["entity"]?.ToString() ?? "Snapshot";
                var name = entity.StartsWith(_prefix, StringComparison.Ordinal) && entity.Length > _prefix.Length ? entity[_prefix.Length..] : entity;
                var unique = name;
                for (var n = 2; !names.Add(unique); n++) unique = name + n;
                var fields = new JsonArray(new JsonObject { ["name"] = "Id", ["type"] = "Integer" });
                var rows = Objects(snapshot["rows"]);
                foreach (var attribute in Objects(snapshot["attributes"]))
                {
                    var an = attribute["name"]?.ToString() ?? "";
                    var type = attribute["type"]?.ToString() ?? "Text";
                    var field = new JsonObject { ["name"] = an, ["type"] = type };
                    if (type == "Text") field["length"] = TextLength(rows.Select(r => r[an]?.ToString() ?? ""));
                    fields.Add(field);
                }
                var newRows = new JsonArray();
                for (var i = 0; i < rows.Count; i++)
                {
                    var row = rows[i].DeepClone().AsObject();
                    row["Id"] = i + 1;
                    newRows.Add(row);
                }
                collections.Add(new JsonObject { ["name"] = unique, ["key"] = "Id", ["mutated"] = false, ["fields"] = fields, ["references"] = new JsonArray(), ["rows"] = newRows, ["snapshot"] = entity });
                list["collection"] = unique;
                list["snapshot"] = null;
            }
        }

        // ---- the shell ----------------------------------------------------------------------------------------------------

        private void Shell()
        {
            if (ir["shell"] is not JsonObject shell) return;
            // the toast containers next to the app root
            if (shell["after"] == null && shell["siblings"] is JsonArray siblings) { shell["after"] = siblings.DeepClone(); shell.Remove("siblings"); }
            // the placeholder of the mount point (the views' content goes there)
            if (shell["root"] is JsonObject root && shell["mount"]?["path"] is JsonArray path)
            {
                JsonObject? at = root;
                foreach (var step in path)
                    at = step is JsonValue sv && sv.TryGetValue<int>(out var index) && at?["c"] is JsonArray kids && index >= 0 && index < kids.Count ? kids[index] as JsonObject : null;
                if (at != null && at != root && at["placeholder"] == null) { at["placeholder"] = "Content"; at["c"] = new JsonArray(); }
            }
            var inputs = new JsonArray();
            foreach (var input in Objects(shell["inputs"]))
            {
                var name = input["name"]?.ToString() ?? "";
                var type = input["type"]?.ToString() ?? "Text";
                if (input["source"] is not JsonObject source) { inputs.Add(input.DeepClone()); continue; }
                var o = new JsonObject { ["name"] = name, ["type"] = type };
                if (source["dimension"]?.ToString() is { } dim) o["dimension"] = dim;
                else if (source["toast"]?.ToString() is { } toast) o["toast"] = toast;
                else if (source["view"] != null) { o["name"] = "View"; o["type"] = "Text"; }
                else if (source["record"]?.ToString() is { } record) o["record"] = new JsonObject { ["collection"] = record, ["by"] = source["by"]?.ToString() };
                else if (source["aggregate"]?.ToString() is { } aggregate && SumOf(aggregate) is { } sum) { o["from"] = new JsonObject { ["sum"] = sum.Sum }; o["type"] = sum.Type; }
                inputs.Add(o);
            }
            shell["inputs"] = inputs;
            var events = new JsonArray();
            foreach (var e in Objects(shell["events"]))
            {
                if (e["from"] != null) { events.Add(e.DeepClone()); continue; }
                var o = new JsonObject { ["name"] = e["name"]?.ToString(), ["from"] = e["event"]?.ToString() };
                o["params"] = e["dimension"]?.ToString() is { } dim && _dims.TryGetValue(dim, out var d)
                    ? new JsonArray(new JsonObject { ["name"] = _pt ? "Valor" : "Value", ["type"] = d["type"]?.ToString() ?? "Text" })
                    : new JsonArray();
                events.Add(o);
            }
            shell["events"] = events;
        }

        /// <summary>The sum a shell input names (2.5, names.mjs aggregateInputName): the numeric field of a collection that references
        /// the record a global dimension selects, filtered by that dimension.</summary>
        private (JsonObject Sum, string Type)? SumOf(string input)
        {
            foreach (var dim in _dims.Values.Where(d => d["scope"]?.ToString() == "global" && d["collection"] is JsonValue))
            {
                var target = dim["collection"]!.ToString();
                foreach (var c in Objects(ir["store"]?["collections"]))
                {
                    var name = c["name"]?.ToString() ?? "";
                    var reference = Objects(c["references"]).FirstOrDefault(r => r["collection"]?.ToString() == target);
                    if (reference == null) continue;
                    var stem = Regex.Replace(name, "Items?$", "");
                    if (stem.Length == 0) stem = name;
                    foreach (var f in Objects(c["fields"]))
                    {
                        var fn = f["name"]?.ToString() ?? "";
                        var type = f["type"]?.ToString();
                        if (type is not ("Integer" or "Decimal") || fn == (c["key"]?.ToString() ?? "Id") || Objects(c["references"]).Any(r => r["field"]?.ToString() == fn)) continue;
                        if (stem + fn != input) continue;
                        return (new JsonObject
                        {
                            ["collection"] = name, ["field"] = fn,
                            ["where"] = new JsonObject { ["op"] = "eq", ["l"] = new JsonObject { ["field"] = reference["field"]!.ToString() }, ["r"] = new JsonObject { ["dim"] = dim["key"]!.ToString() } },
                        }, type);
                    }
                }
            }
            return null;
        }

        // ---- controls -------------------------------------------------------------------------------------------------------

        /// <summary>The names an event uses for a dimension control: its key, and the name and id of the control element.</summary>
        private void ScanControls()
        {
            foreach (var (k, _) in _dims) _dimControls[k] = k;
            // the element a dimension names as its control (a select or a text field of the shell, which the capture writes
            // without a control annotation) is that dimension's control
            foreach (var (key, dim) in _dims)
            {
                if (dim["control"]?.ToString() is not { Length: > 0 } selector || dim["kind"]?.ToString() is "trigger" or "toggle" or "hidden") continue;
                foreach (var tree in Trees())
                    foreach (var node in Matching(tree, selector))
                        if (node["t"]?.ToString() is "input" or "select" or "textarea" && node["control"] == null)
                        {
                            var kind = node["t"]!.ToString() == "select" ? "select" : node["t"]!.ToString() == "textarea" ? "textarea" : Attr(node, "type") == "checkbox" ? "checkbox" : "input";
                            node["control"] = new JsonObject { ["dimension"] = key, ["initial"] = dim["initial"]?.DeepClone(), ["kind"] = kind, ["type"] = dim["type"]?.DeepClone(), ["var"] = dim["name"]?.DeepClone() };
                            if (node["attrExpr"] is JsonObject a) { a.Remove("value"); a.Remove("checked"); if (a.Count == 0) node.Remove("attrExpr"); }
                        }
            }
            // a name names the dimension only when no other control of the prototype has it (the search filter's name="cidade"
            // and the listing form's name="cidade" are two controls; the id stays the dimension's)
            var names = AllNodes().Where(n => n["t"]?.ToString() is "input" or "select" or "textarea").Select(n => Attr(n, "name")).OfType<string>()
                .GroupBy(n => n, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
            foreach (var node in AllNodes())
                if ((node["control"] as JsonObject)?["dimension"]?.ToString() is { } dim && _dims.ContainsKey(dim))
                {
                    if (Attr(node, "name") is { Length: > 0 } name && names.GetValueOrDefault(name) <= 1) _dimControls.TryAdd(name, dim);
                    if (Attr(node, "id") is { Length: > 0 } id) _dimControls.TryAdd(id, dim);
                }
        }

        // ---- modals ---------------------------------------------------------------------------------------------------------

        /// <summary>The record of a modal: read by its key parameter, or a new record when the modal only inserts; a record named
        /// without a parameter or an insert is no record of the modal.</summary>
        private void Modals()
        {
            foreach (var (key, modal) in _modals)
            {
                if (modal["record"] is JsonObject) continue;
                var collection = modal["record"]?.ToString();
                modal.Remove("record");
                var parameters = Objects(modal["params"]);
                if (collection != null && _collections.ContainsKey(collection) && parameters.Count > 0)
                {
                    modal["record"] = new JsonObject { ["collection"] = collection, ["key"] = new JsonObject { ["param"] = parameters[0]["name"]?.ToString() } };
                    continue;
                }
                // a modal whose events insert into a collection edits a new record of it (its controls are that record's fields)
                var inserted = Objects(ir["events"]).Where(e => e["view"]?.ToString() == key || e["modal"]?.ToString() == key)
                    .SelectMany(EffectsOf).Where(x => x["kind"]?.ToString() == "insert").Select(x => x["collection"]?.ToString()).FirstOrDefault(c => c != null && _collections.ContainsKey(c));
                if (inserted != null && parameters.Count == 0)
                    modal["record"] = new JsonObject { ["collection"] = inserted, ["new"] = NewRecord(modal, _collections[inserted]) };
            }
        }

        /// <summary>The values of a new record: the controls of the modal as the canonical rendering shows them, by field name.</summary>
        private JsonObject NewRecord(JsonObject modal, JsonObject collection)
        {
            var record = new JsonObject();
            var key = collection["key"]?.ToString() ?? "Id";
            var controls = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            foreach (var node in Nodes(modal["root"] as JsonObject))
                if (node["t"]?.ToString() is "input" or "select" or "textarea" && Attr(node, "name") is { Length: > 0 } name) controls.TryAdd(name, node);
            foreach (var f in Objects(collection["fields"]))
            {
                var name = f["name"]?.ToString() ?? "";
                var type = f["type"]?.ToString() ?? "Text";
                if (name == key) { record[name] = 0; continue; }
                if (!controls.TryGetValue(name, out var control)) { record[name] = Default(type); continue; }
                string? raw;
                if (control["t"]?.ToString() == "input" && Attr(control, "type") == "checkbox") raw = Attr(control, "checked") != null ? "true" : "false";
                else if (control["t"]?.ToString() == "textarea") raw = TextOf(control);
                else if (control["t"]?.ToString() == "select")
                {
                    raw = Options(control).FirstOrDefault(o => Attr(o, "selected") != null) is { } selected ? Attr(selected, "value") ?? TextOf(selected) : null;
                    if (raw == null && control["options"]?["source"] is JsonObject source && source["collection"]?.ToString() is { } oc && _collections.TryGetValue(oc, out var options))
                        raw = Objects(options["rows"]).FirstOrDefault()?[source["value"]?.ToString() ?? "Id"]?.ToString();
                }
                else raw = Attr(control, "value");
                record[name] = Typed(raw, type) ?? Default(type);
            }
            return record;
        }

        // ---- lists -------------------------------------------------------------------------------------------------------

        private void ListNames()
        {
            foreach (var node in AllNodes())
            {
                if (node["list"] is not JsonObject list || node["k"]?.ToString() is not { } k) continue;
                var collection = list["collection"]?.ToString() ?? "Itens";
                var name = list["name"]?.ToString() ?? (_pt ? "Lista" : "List") + collection;
                var unique = name;
                for (var n = 2; !_takenListNames.Add(unique); n++) unique = name + n;
                list["name"] = unique;
                _listNames[k] = unique;
                // the render lane keeps the template only: c holds the other children, the items started at `at`
                if (list["start"] == null && list["at"] is JsonValue at) { list["start"] = at.DeepClone(); list["detached"] = true; }
                if (list["sortBy"] is JsonObject sortBy)
                    foreach (var c in Objects(sortBy["cases"]))
                        if (c["field"] == null && c["sort"] is JsonArray { Count: > 0 } sort && sort[0] is JsonObject first)
                        { c["field"] = first["field"]?.DeepClone(); c["dir"] = first["dir"]?.DeepClone(); }
            }
        }

        // ---- dimensions -------------------------------------------------------------------------------------------------

        private void Dimensions()
        {
            foreach (var (key, dim) in _dims)
            {
                var scope = dim["scope"]?.ToString();
                if (scope is "global" or "screen") continue;
                var view = dim["view"]?.ToString();
                var views = new List<string>();
                if (scope == "modal" && dim["modal"]?.ToString() is { } m && _modals.TryGetValue(m, out var modal)) views.AddRange(ModalScreens(modal));
                if (view != null && !views.Contains(view)) views.Add(view);
                // written by an event of another view (and read where the navigation leads): it survives navigation (2.6)
                var writers = Objects(ir["events"]).Where(e => EffectsOf(e).Any(x => x["kind"]?.ToString() == "setDimension" && x["dimension"]?.ToString() == key)).ToList();
                var foreign = writers.Any(e => EventViews(e).Any(v => !views.Contains(v)) && !string.Equals(e["view"]?.ToString(), "shell", StringComparison.Ordinal));
                if (foreign && scope == "view") { dim["scope"] = "global"; continue; }
                dim["scope"] = "screen";
                dim["views"] = new JsonArray(views.Select(v => (JsonNode)v).ToArray());
            }
        }

        private List<string> ModalScreens(JsonObject modal)
        {
            var views = new List<string>();
            foreach (var s in modal["screens"] as JsonArray ?? []) if (s?.ToString() is { } v && _views.Contains(v) && !views.Contains(v)) views.Add(v);
            foreach (var o in Objects(modal["openedFrom"])) if (o["view"]?.ToString() is { } v && _views.Contains(v) && !views.Contains(v)) views.Add(v);
            return views;
        }

        /// <summary>The views an event runs on (its own view, or the screens of its modal).</summary>
        private IEnumerable<string> EventViews(JsonObject e)
        {
            var view = e["view"]?.ToString();
            if (view != null && _modals.TryGetValue(view, out var modal)) return ModalScreens(modal);
            if (e["modal"]?.ToString() is { } m && _modals.TryGetValue(m, out var mm)) return ModalScreens(mm);
            return view != null && _views.Contains(view) ? [view] : [];
        }

        // ---- events -----------------------------------------------------------------------------------------------------

        private void Events()
        {
            foreach (var e in Objects(ir["events"]))
            {
                var view = e["view"]?.ToString();
                if (view != null && _modals.TryGetValue(view, out var modal))
                {
                    e["modal"] = view;
                    e["view"] = ModalScreens(modal).FirstOrDefault();
                }
                else if (view == "shell") e["view"] = null;
                var context = new Context(e["modal"]?.ToString() is { } mk && _modals.TryGetValue(mk, out var mm) ? mm["record"]?["collection"]?.ToString() : null, null);
                var trees = EventTrees(e).ToList();
                if (e["effects"] is JsonArray effects) e["effects"] = Effects(e, effects, context, trees);
                foreach (var c in Objects(e["cases"]))
                {
                    var caseEffects = Effects(e, c["effects"] as JsonArray ?? [], context, trees);
                    c["effects"] = caseEffects;
                    if (c["when"] is JsonObject when) c["when"] = NewValues(V(when, context), caseEffects);
                }
                // a toast that reads the field the same event toggles was observed on the record before the toggle: it reads the
                // toggled value back from the server action (not updated)
                var toggled = EffectsOf(e).Where(x => x["kind"]?.ToString() == "toggle").Select(x => x["field"]?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
                if (toggled.Count > 0)
                    foreach (var toast in EffectsOf(e).Where(x => x["kind"]?.ToString() == "toast" && x["text"] is JsonObject))
                        toast["text"] = BeforeToggle(toast["text"], toggled);
                // a parameter an effect reads that the event does not declare comes from the attribute its selector names
                var declared = Objects(e["params"]).Select(p => p["name"]?.ToString()).ToHashSet(StringComparer.Ordinal);
                foreach (var p in ParamsIn(e).Where(p => !declared.Contains(p)).Distinct(StringComparer.Ordinal).ToList())
                    if (SelectorAttribute(e["selector"]?.ToString()) is { } from)
                    {
                        if (e["params"] is not JsonArray parameters) { parameters = []; e["params"] = parameters; }
                        parameters.Add(new JsonObject { ["name"] = p, ["from"] = from, ["type"] = "Integer" });
                    }
            }
        }

        private static JsonNode? BeforeToggle(JsonNode? n, HashSet<string> toggled) => n switch
        {
            JsonObject o when o.Count == 1 && o["field"]?.ToString() is { } f && toggled.Contains(f) => new JsonObject { ["not"] = new JsonObject { ["updated"] = f } },
            JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(p.Key, BeforeToggle(p.Value, toggled)))),
            JsonArray a => new JsonArray(a.Select(x => BeforeToggle(x, toggled)).ToArray()),
            _ => n?.DeepClone(),
        };

        /// <summary>A predicate of a case reads the value its own effects write (the prototype tests the new value).</summary>
        private static JsonNode? NewValues(JsonNode? when, JsonArray effects)
        {
            var writes = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
            foreach (var x in effects.OfType<JsonObject>())
                if (x["kind"]?.ToString() == "setDimension" && x["dimension"]?.ToString() is { } d && x["value"] is JsonObject v && !Mentions(v, d)) writes.TryAdd(d, v);
            if (writes.Count == 0) return when;
            JsonNode? Replace(JsonNode? n) => n switch
            {
                JsonObject o when o.Count == 1 && o["dim"]?.ToString() is { } d && writes.TryGetValue(d, out var value) => value.DeepClone(),
                JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(p.Key, Replace(p.Value)))),
                JsonArray a => new JsonArray(a.Select(Replace).ToArray()),
                _ => n?.DeepClone(),
            };
            return Replace(when);
        }

        private static bool Mentions(JsonNode? n, string dim) => n switch
        {
            JsonObject o => o["dim"]?.ToString() == dim || o.Any(p => Mentions(p.Value, dim)),
            JsonArray a => a.Any(x => Mentions(x, dim)),
            _ => false,
        };

        private JsonArray Effects(JsonObject e, JsonArray effects, Context context, List<JsonObject> trees)
        {
            var result = new JsonArray();
            foreach (var x in effects.OfType<JsonObject>())
            {
                var effect = Effect(e, x, context, trees);
                if (effect == null) continue;
                FieldLengths(effect, trees);
                result.Add(effect);
            }
            return result;
        }

        /// <summary>A Text field an insert or update writes from a control is at least as long as the control's maxlength (the
        /// delivery address of 500 characters fits its field).</summary>
        private void FieldLengths(JsonObject effect, List<JsonObject> trees)
        {
            if (effect["kind"]?.ToString() is not ("insert" or "update") || effect["collection"]?.ToString() is not { } name || !_collections.TryGetValue(name, out var collection)) return;
            foreach (var (f, v) in effect["fields"] as JsonObject ?? [])
            {
                if (v?["control"]?.ToString() is not { } control) continue;
                var node = trees.SelectMany(Nodes).FirstOrDefault(n => Attr(n, "name") == control);
                if (node == null || Attr(node, "maxlength") is not { } maxText || !int.TryParse(maxText, out var max)) continue;
                if (Objects(collection["fields"]).FirstOrDefault(x => x["name"]?.ToString() == f) is { } field && field["type"]?.ToString() == "Text" && (field["length"]?.GetValue<int>() ?? 0) < max)
                    field["length"] = TextLength([new string('x', max)]);
            }
        }

        private JsonObject? Effect(JsonObject e, JsonObject x, Context context, List<JsonObject> trees)
        {
            var kind = x["kind"]?.ToString();
            var o = x.DeepClone().AsObject();
            switch (kind)
            {
                case "setDimension":
                {
                    var dim = o["dimension"]?.ToString() ?? "";
                    if (!_dims.TryGetValue(dim, out var d))
                    {
                        // the toast of the shell is no dimension: closing it clears the notice
                        if (dim == "aviso") return o["value"]?["lit"]?.ToString() is { Length: > 0 } notice
                            ? new JsonObject { ["kind"] = "toast", ["text"] = new JsonObject { ["lit"] = notice }, ["variant"] = "" }
                            : new JsonObject { ["kind"] = "toast", ["text"] = null, ["variant"] = "", ["close"] = true };
                        return null;
                    }
                    if (o["value"] is JsonObject value)
                    {
                        if (value["min"] != null && value["add"] != null) { o["min"] = V(value["min"], context); value.Remove("min"); }
                        if (value["max"] is JsonObject max && value["add"] != null) { o["max"] = Bound(max, trees, context); value.Remove("max"); }
                        var converted = V(value, context) as JsonObject;
                        if (converted?["lit"] is JsonValue lit) converted["lit"] = TypedNode(lit, d["type"]?.ToString());
                        o["value"] = converted;
                    }
                    return o;
                }
                case "toast":
                    if (o["text"] is JsonObject text) o["text"] = text.ContainsKey("fmt") ? Expr(V(text, context)) : V(text, context);
                    if (o["variant"] == null || o["variant"] is JsonValue vv && vv.ToString() == "null") o["variant"] = "";
                    return o;
                case "upsert":
                {
                    if (o["delta"] == null && o["by"] != null) { o["delta"] = V(o["by"], context); o.Remove("by"); }
                    var keys = o["keys"] as JsonObject ?? [];
                    var field = o["field"]?.ToString();
                    if (o["fields"] is JsonObject fields)
                    {
                        var rest = new JsonObject();
                        foreach (var (f, v) in fields)
                            if (!Generated(v) && !keys.ContainsKey(f) && f != field) rest[f] = V(v, context);
                        o["fields"] = rest;
                    }
                    o["keys"] = V(keys, context);
                    return o;
                }
                case "increment":
                    if (o["delta"] == null && o["by"] != null) { o["delta"] = V(o["by"], context); o.Remove("by"); }
                    o["key"] = V(o["key"], context);
                    return o;
                case "toggle" when o["keys"] is JsonObject memberKeys:
                    // a membership one click adds or removes (keys of the record, no Boolean field)
                    o["keys"] = V(memberKeys, context);
                    return o;
                case "toggle":
                case "remove":
                    o["key"] = V(o["key"], context);
                    return o;
                case "update":
                {
                    o["key"] = V(o["key"], context);
                    if (o["fields"] is JsonObject fields)
                    {
                        var converted = new JsonObject();
                        foreach (var (f, v) in fields)
                        {
                            // a control named by a selector (an input of a list row) is the control bound to that field
                            if (v is JsonObject cv && cv["control"]?.ToString() is { } control && IsSelector(control))
                            {
                                foreach (var tree in trees) foreach (var n in Matching(tree, control)) if (n["k"]?.ToString() is { } k) _boundBySelector[k] = f;
                                converted[f] = new JsonObject { ["control"] = f };
                            }
                            else converted[f] = V(v, context);
                        }
                        o["fields"] = converted;
                    }
                    return o;
                }
                case "insert":
                {
                    if (o["fields"] is JsonObject fields)
                    {
                        var converted = new JsonObject();
                        foreach (var (f, v) in fields)
                        {
                            if (Generated(v)) continue;
                            converted[f] = v is JsonObject a && a["agg"] is JsonObject agg ? Aggregate(agg, context) : V(v, context);
                        }
                        o["fields"] = converted;
                    }
                    return o;
                }
                case "insertFrom":
                {
                    if (o["target"] == null) { o["target"] = o["collection"]?.DeepClone(); o.Remove("collection"); }
                    if (o["source"] == null) { o["source"] = o["from"]?.DeepClone(); o.Remove("from"); }
                    JsonObject? join = o["join"] as JsonObject;
                    if (o["fields"] is JsonObject fields)
                    {
                        var converted = new JsonObject();
                        foreach (var (f, v) in fields)
                        {
                            if (Generated(v)) continue;
                            converted[f] = Joined(V(v, context), ref join);
                        }
                        o["fields"] = converted;
                    }
                    if (join != null) o["join"] = join;
                    o["where"] = V(o["where"], context);
                    return o;
                }
                case "updateFrom":
                    if (o["target"] == null) { o["target"] = o["collection"]?.DeepClone(); o.Remove("collection"); }
                    if (o["source"] == null) { o["source"] = o["from"]?.DeepClone(); o.Remove("from"); }
                    if (o["sum"] == null && o["value"] is JsonValue sumField) { o["sum"] = sumField.DeepClone(); o.Remove("value"); }
                    o["where"] = V(o["where"], context);
                    return o;
                case "removeWhere":
                    if (o["target"] == null) { o["target"] = o["collection"]?.DeepClone(); o.Remove("collection"); }
                    o["where"] = V(o["where"], context);
                    return o;
                case "validate":
                    return Validate(o, context, trees);
                case "openPopup":
                    if (o["inputs"] is JsonObject inputs) o["inputs"] = V(inputs, context);
                    return o;
                case "navigate":
                    if (o["params"] is JsonObject parameters) o["params"] = V(parameters, context);
                    return o;
                default:
                    return V(o, context) as JsonObject;
            }
        }

        /// <summary>A value the capture computes and the compiler generates itself (the next key).</summary>
        private static bool Generated(JsonNode? v) => v is JsonObject o && o["key"]?.ToString() is { } k && k.StartsWith("max", StringComparison.Ordinal);

        /// <summary>agg {op: sum, collection, field, times?, where} as the compiler's sum (one join for the factor).</summary>
        private JsonNode Aggregate(JsonObject agg, Context context)
        {
            JsonNode field = agg["field"]?.DeepClone() ?? "Id";
            if (agg["times"] is JsonObject times)
                field = new JsonObject { ["mul"] = new JsonArray(new JsonObject { ["field"] = agg["field"]?.ToString() }, Joined(new JsonObject { ["field"] = times["field"]?.ToString(), ["via"] = times["via"]?.ToString() })) };
            return new JsonObject { ["sum"] = new JsonObject { ["collection"] = agg["collection"]?.ToString(), ["field"] = field, ["where"] = V(agg["where"], context) } };
        }

        private static JsonObject Joined(JsonObject value) { JsonObject? join = null; return (JsonObject)Joined(value, ref join); }

        /// <summary>{collection, field, via} (a field of the record a foreign key reaches) as {field, via}; the first join it needs is the
        /// effect's join.</summary>
        private static JsonNode Joined(JsonNode? value, ref JsonObject? join)
        {
            switch (value)
            {
                case JsonObject o when o["field"] != null && o["collection"]?.ToString() is { } collection && o["via"]?.ToString() is { } via:
                    join ??= new JsonObject { ["collection"] = collection, ["on"] = via };
                    return new JsonObject { ["field"] = o["field"]!.ToString(), ["via"] = via };
                case JsonObject o:
                {
                    var copy = new JsonObject();
                    foreach (var (k, v) in o) copy[k] = v is JsonObject or JsonArray ? Joined(v, ref join) : v?.DeepClone();
                    return copy;
                }
                case JsonArray a:
                {
                    var copy = new JsonArray();
                    foreach (var item in a) copy.Add(Joined(item, ref join));
                    return copy;
                }
                default: return value?.DeepClone() ?? JsonValue.Create("")!;
            }
        }

        /// <summary>The bound of a setDimension: the attribute of the control (its expression when the capture computed it).</summary>
        private JsonNode? Bound(JsonObject bound, List<JsonObject> trees, Context context)
        {
            if (bound["attr"]?.ToString() is { } attribute && bound["of"]?.ToString() is { } of)
            {
                foreach (var tree in trees)
                    foreach (var node in Nodes(tree))
                        if (node["control"]?["dimension"]?.ToString() == of && node["attrExpr"]?[attribute] is JsonObject dynamic && dynamic["value"] is JsonObject val)
                            return V(val, Context.ForTree(tree, _modals, context));
                if (bound["lit"] is JsonValue lit) return new JsonObject { ["lit"] = lit.DeepClone() };
            }
            return V(bound, context);
        }

        /// <summary>Validation rules (each a constraint of a control and the condition that holds when it is valid) as the failure
        /// condition of each control and message, in the order of the capture; the alert the message goes to becomes a local.</summary>
        private JsonObject Validate(JsonObject o, Context context, List<JsonObject> trees)
        {
            var rules = Objects(o["rules"]);
            if (rules.Count == 0 || rules.All(r => r["constraint"] == null)) return o;
            var grouped = new List<(string Control, string Message, List<JsonNode> Failures)>();
            string? target = null;
            foreach (var rule in rules)
            {
                var control = rule["control"]?.ToString() ?? "";
                var message = rule["message"]?.ToString() ?? "";
                target ??= rule["target"]?["id"]?.ToString();
                var failure = Failure(rule, context, trees);
                if (failure == null) continue;
                var group = grouped.FirstOrDefault(g => g.Control == control && g.Message == message);
                if (group.Failures == null) { group = (control, message, []); grouped.Add(group); }
                group.Failures.Add(failure);
            }
            var result = new JsonObject { ["kind"] = "validate" };
            if (target != null)
            {
                var local = Pascal(target);
                _alerts[target] = local;
                result["target"] = new JsonObject { ["local"] = local };
            }
            result["rules"] = new JsonArray(grouped.Select(g => (JsonNode)new JsonObject
            {
                ["when"] = g.Failures.Count == 1 ? g.Failures[0] : new JsonObject { ["op"] = "or", ["a"] = new JsonArray(g.Failures.ToArray()) },
                ["message"] = g.Message, ["control"] = g.Control,
            }).ToArray());
            return result;
        }

        private JsonNode? Failure(JsonObject rule, Context context, List<JsonObject> trees)
        {
            if (rule["when"] is not JsonObject valid) return null;
            var control = rule["control"]?.ToString() ?? "";
            var kind = ControlKind(control, trees, context);
            // "required" of a number or a key is "not 0" (a number local is never empty); of a checkbox there is nothing to test
            if (rule["constraint"]?.ToString() == "required" && valid["op"]?.ToString() == "ne" && valid["r"]?["lit"]?.ToString() == "")
            {
                if (kind == "boolean") return null;
                if (kind == "number") return new JsonObject { ["op"] = "eq", ["l"] = V(valid["l"], context), ["r"] = new JsonObject { ["lit"] = 0 } };
            }
            return Negate(V(valid, context));
        }

        /// <summary>number, boolean or text: the type a form control holds (its input type, a select of a key, a checkbox).</summary>
        private string ControlKind(string control, List<JsonObject> trees, Context context)
        {
            if (_dimControls.TryGetValue(control, out var dim)) return _dims[dim]["type"]?.ToString() is "Integer" or "Decimal" ? "number" : _dims[dim]["type"]?.ToString() == "Boolean" ? "boolean" : "text";
            foreach (var tree in trees)
                foreach (var node in Nodes(tree))
                {
                    if (Attr(node, "name") != control) continue;
                    if (node["t"]?.ToString() == "input" && Attr(node, "type") is "number" or "range") return "number";
                    if (node["t"]?.ToString() == "input" && Attr(node, "type") == "checkbox") return "boolean";
                    if (node["t"]?.ToString() == "select")
                    {
                        if (context.Collection is { } c && FieldType(c, control) is "Integer" or "Decimal" or "Identifier") return "number";
                        if (node["options"]?["source"]?["value"]?.ToString() is { } valueField && node["options"]?["source"]?["collection"]?.ToString() is { } oc && FieldType(oc, valueField) is "Integer" or "Identifier") return "number";
                    }
                    if (context.Collection is { } rc && FieldType(rc, control) is "Integer" or "Decimal" or "Identifier") return "number";
                    if (context.Collection is { } bc && FieldType(bc, control) is "Boolean") return "boolean";
                    return "text";
                }
            return "text";
        }

        private string? FieldType(string collection, string field)
        {
            if (!_collections.TryGetValue(collection, out var c)) return null;
            if (string.Equals(c["key"]?.ToString() ?? "Id", field, StringComparison.Ordinal)) return "Identifier";
            if (Objects(c["references"]).Any(r => r["field"]?.ToString() == field)) return "Identifier";
            return Objects(c["fields"]).FirstOrDefault(f => f["name"]?.ToString() == field)?["type"]?.ToString();
        }

        private static JsonNode Negate(JsonNode? pred)
        {
            if (pred is not JsonObject p) return new JsonObject { ["op"] = "not", ["a"] = new JsonArray(pred?.DeepClone()) };
            var op = p["op"]?.ToString();
            var flipped = op switch
            {
                "len-ge" => "len-lt", "len-le" => "len-gt", "len-gt" => "len-le", "len-lt" => "len-ge",
                "ge" => "lt", "le" => "gt", "gt" => "le", "lt" => "ge", "eq" => "ne", "ne" => "eq", _ => null,
            };
            if (flipped != null) { var copy = p.DeepClone().AsObject(); copy["op"] = flipped; return copy; }
            if (op == "not" && p["a"] is JsonArray { Count: 1 } inner) return inner[0]!.DeepClone();
            if (op == "and") return new JsonObject { ["op"] = "or", ["a"] = new JsonArray((p["a"] as JsonArray ?? []).Select(x => (JsonNode?)Negate(x)).ToArray()) };
            if (op == "or") return new JsonObject { ["op"] = "and", ["a"] = new JsonArray((p["a"] as JsonArray ?? []).Select(x => (JsonNode?)Negate(x)).ToArray()) };
            return new JsonObject { ["op"] = "not", ["a"] = new JsonArray(p.DeepClone()) };
        }

        private IEnumerable<JsonObject> EventTrees(JsonObject e)
        {
            if (e["modal"]?.ToString() is { } m && _modals.TryGetValue(m, out var modal) && modal["root"] is JsonObject mr) yield return mr;
            else if (e["view"]?.ToString() is { } v && Objects(ir["views"]).FirstOrDefault(x => x["key"]?.ToString() == v)?["root"] is JsonObject vr) yield return vr;
            if (e["view"] == null && e["modal"] == null && ir["shell"] is JsonObject shell)
            {
                if (shell["root"] is JsonObject sr) yield return sr;
                foreach (var a in Objects(shell["after"])) yield return a;
            }
        }

        private static IEnumerable<string> ParamsIn(JsonNode? n)
        {
            switch (n)
            {
                case JsonObject o:
                    if (o["param"] is JsonValue p && p.TryGetValue<string>(out var name)) yield return name;
                    foreach (var (k, v) in o) if (k is not ("param" or "params")) foreach (var x in ParamsIn(v)) yield return x;
                    break;
                case JsonArray a: foreach (var v in a) foreach (var x in ParamsIn(v)) yield return x; break;
            }
        }

        /// <summary>The attribute a selector names ([data-cart-quantity], input[data-x="1"]): where a parameter of the event comes from.</summary>
        private static string? SelectorAttribute(string? selector)
        {
            if (selector == null) return null;
            var m = Regex.Match(selector, @"\[(?<a>[A-Za-z_][A-Za-z0-9_:-]*)");
            return m.Success && m.Groups["a"].Value.StartsWith("data-", StringComparison.Ordinal) ? m.Groups["a"].Value : null;
        }

        // ---- nodes --------------------------------------------------------------------------------------------------------

        private void Nodes()
        {
            if (ir["shell"] is JsonObject shell)
            {
                var context = new Context(null, null) { Shell = true };
                if (shell["root"] is JsonObject root) Node(root, context, null, false);
                foreach (var a in Objects(shell["after"])) Node(a, context, null, false);
            }
            foreach (var view in Objects(ir["views"]))
            {
                var records = new HashSet<string>(StringComparer.Ordinal);
                var context = new Context(null, records);
                if (view["root"] is JsonObject root) Node(root, context, null, false);
                // the records a view reads by its route parameter (PedidoDetalhe: the Pedido of the input Id)
                var parameters = Objects(view["params"]);
                if (records.Count > 0 && parameters.Count > 0 && view["records"] == null)
                    view["records"] = new JsonArray(records.Where(r => _collections.ContainsKey(r)).Order(StringComparer.Ordinal)
                        .Select(r => (JsonNode)new JsonObject { ["name"] = r, ["collection"] = r, ["key"] = new JsonObject { ["param"] = parameters[0]["name"]?.ToString() } }).ToArray());
            }
            foreach (var (_, modal) in _modals)
                if (modal["root"] is JsonObject root) Node(root, new Context(modal["record"]?["collection"]?.ToString(), null) { Modal = modal }, null, false);
        }

        private void Node(JsonObject node, Context context, JsonObject? parent, bool inTemplate)
        {
            if (node["x"] != null)
            {
                if (node["expr"] is JsonObject textExpr) node["expr"] = Expr(V(textExpr, context));
                return;
            }
            // events nothing compiled (no effect observed) are no events of the node
            if (node["events"] is JsonArray events)
            {
                var kept = events.Where(x => x?.ToString() is { } key && _events.Contains(key)).Select(x => (JsonNode?)x!.DeepClone()).ToArray();
                if (kept.Length == 0) node.Remove("events"); else node["events"] = new JsonArray(kept);
            }
            if (node["if"] is JsonObject condition) node["if"] = V(condition, context);
            if (node["expr"] is JsonObject expression) node["expr"] = Expr(V(expression, context));
            if (node["classExpr"] is JsonObject classExpr) node["classExpr"] = V(classExpr, context);
            if (node["nav"] is JsonObject nav) node["nav"] = V(nav, context);
            if (node["attrExpr"] is JsonObject attrExpr)
            {
                var converted = new JsonObject();
                foreach (var (name, value) in attrExpr)
                {
                    if (value is not JsonObject v) continue;
                    if (v["expr"] != null) { converted[name] = V(v, context); continue; }
                    if (v["when"] != null)
                    {
                        var when = V(v["when"], context);
                        // the value the attribute takes when present may itself vary (a format, cases): an expression, never its JSON text
                        var thenExpr = v["then"] is JsonObject thenValue ? Expr(V(thenValue, context)) : null;
                        // a class present only under a condition: the class expression of the node
                        if (name == "class" && node["classExpr"] == null)
                        {
                            var token = thenExpr != null ? new JsonObject { ["expr"] = thenExpr, ["when"] = when } : new JsonObject { ["token"] = v["then"]?.ToString() ?? "", ["when"] = when };
                            node["classExpr"] = new JsonObject { ["base"] = "", ["tokens"] = new JsonArray(token) };
                            continue;
                        }
                        converted[name] = new JsonObject { ["when"] = when, ["then"] = thenExpr != null ? new JsonObject { ["expr"] = thenExpr } : v["then"]?.DeepClone(), ["else"] = v["else"]?.DeepClone() };
                        continue;
                    }
                    converted[name] = new JsonObject { ["expr"] = Expr(V(v, context)) };
                }
                node["attrExpr"] = converted;
            }
            if (node["list"] is JsonObject list)
            {
                if (list["filter"] is JsonObject filter) list["filter"] = V(filter, context);
                if (list["template"] is JsonObject template) Node(template, context, node, true);
            }
            // the alert a validation writes in shows the message local
            if (Attr(node, "id") is { Length: > 0 } id && _alerts.TryGetValue(id, out var local) && node["message"] == null && Attr(node, "role") == "alert")
            {
                node["message"] = new JsonObject { ["local"] = local };
                node["c"] = new JsonArray();
            }
            Control(node, context);
            Icon(node, parent);
            foreach (var child in (node["c"] as JsonArray ?? []).OfType<JsonObject>().ToList()) Node(child, context, node, inTemplate);
            foreach (var other in (node["else"] as JsonArray ?? []).OfType<JsonObject>().ToList()) Node(other, context, parent, inTemplate);
        }

        /// <summary>A form control: the options of a select inside its control, and the variable it is bound to (a dimension, the
        /// record field of its modal or of the list row an update names, else a local of its name).</summary>
        private void Control(JsonObject node, Context context)
        {
            var tag = node["t"]?.ToString();
            if (tag is not ("input" or "select" or "textarea")) return;
            var kind = tag == "select" ? "select" : tag == "textarea" ? "textarea" : Attr(node, "type") == "checkbox" ? "checkbox" : Attr(node, "type") == "radio" ? "radio" : "input";
            var control = node["control"] as JsonObject;
            if (control == null)
            {
                var name = Attr(node, "name");
                var k = node["k"]?.ToString() ?? "";
                if (_boundBySelector.TryGetValue(k, out var boundField)) control = new JsonObject { ["kind"] = kind, ["field"] = boundField };
                else if (name is { Length: > 0 } && context.Collection is { } collection && FieldType(collection, name) != null)
                {
                    control = new JsonObject { ["kind"] = kind, ["field"] = name };
                    // the field holds what its form accepts: a Text field is at least as long as the control's maxlength
                    if (Attr(node, "maxlength") is { } maxText && int.TryParse(maxText, out var max)
                        && Objects(_collections[collection]["fields"]).FirstOrDefault(f => f["name"]?.ToString() == name) is { } field
                        && field["type"]?.ToString() == "Text" && (field["length"]?.GetValue<int>() ?? 0) < max)
                        field["length"] = TextLength([new string('x', max)]);
                }
                else if (name is { Length: > 0 } && !_dimControls.ContainsKey(name))
                {
                    control = new JsonObject { ["kind"] = kind, ["var"] = name };
                    var initial = kind == "checkbox" ? (Attr(node, "checked") != null ? "true" : "false") : tag == "textarea" ? TextOf(node) : Attr(node, "value");
                    if (initial != null) control["initial"] = initial;
                }
                if (control == null) return;
                node["control"] = control;
                // the bound variable gives the value; the literal or computed value of the rendering does not
                if (node["attrExpr"] is JsonObject a) { a.Remove("value"); a.Remove("checked"); if (a.Count == 0) node.Remove("attrExpr"); }
            }
            if (node["options"] is JsonObject options && control["options"] == null)
            {
                control["options"] = OptionsOf(options);
                node.Remove("options");
            }
            // a bound control shows its variable: the value or checked state the rendering wrote is not an attribute of it
            if (node["attrExpr"] is JsonObject bound) { bound.Remove("value"); bound.Remove("checked"); if (bound.Count == 0) node.Remove("attrExpr"); }
        }

        private JsonObject OptionsOf(JsonObject options)
        {
            if (options["source"] is JsonObject source)
                return new JsonObject { ["collection"] = source["collection"]?.DeepClone(), ["value"] = source["value"]?.DeepClone(), ["label"] = source["label"]?.DeepClone(), ["where"] = source["where"]?.DeepClone() };
            var o = new JsonObject();
            // the compiler prefixes the options entity itself
            if (options["entity"]?.ToString() is { } entity)
                o["entity"] = entity.StartsWith(_prefix, StringComparison.Ordinal) && entity.Length > _prefix.Length ? entity[_prefix.Length..] : entity;
            if (options["by"]?["field"]?.ToString() is { } byField) o["byField"] = byField;
            if (options["snapshot"] is JsonValue snapshot) o["snapshot"] = snapshot.DeepClone();
            if (options["rows"] is JsonArray rows)
                o["rows"] = new JsonArray(rows.OfType<JsonObject>().Select(r => (JsonNode)new JsonObject
                {
                    ["key"] = (r["Chave"] ?? r["key"])?.DeepClone(), ["value"] = (r["Value"] ?? r["value"])?.ToString(), ["label"] = (r["Label"] ?? r["label"])?.ToString(),
                    ["order"] = (r["Ordem"] ?? r["Order"] ?? r["order"])?.DeepClone(),
                }).ToArray());
            return o;
        }

        /// <summary>An icon whose name varies by a predicate: an If of the icon of each case (one If per case, the last name in the else).</summary>
        private static void Icon(JsonObject node, JsonObject? parent)
        {
            if (node["icon"] is not JsonObject icon || icon["cases"] is not JsonArray { Count: > 0 } cases) return;
            var otherwise = icon["else"]?.ToString() ?? icon["name"]?.ToString() ?? "";
            icon.Remove("cases"); icon.Remove("else");
            JsonObject Variant(string name)
            {
                var copy = node.DeepClone().AsObject();
                copy.Remove("if"); copy.Remove("else");
                copy["icon"]!["name"] = name;
                copy["a"] = Renamed(copy["a"] as JsonArray, icon["name"]?.ToString() ?? "", name);
                return copy;
            }
            var chain = Variant(otherwise);
            foreach (var c in cases.OfType<JsonObject>().Reverse())
            {
                var variant = Variant(c["name"]?.ToString() ?? otherwise);
                variant["if"] = c["when"]?.DeepClone();
                variant["else"] = new JsonArray(chain);
                chain = variant;
            }
            if (node["if"] is JsonObject outer)
            {
                // the node already has its own condition: it keeps it, and the icon chain is its content
                var inner = chain;
                node["icon"]!["name"] = inner["icon"]!["name"]!.ToString();
                if (inner["if"] is JsonObject innerIf) { node["if"] = new JsonObject { ["op"] = "and", ["a"] = new JsonArray(outer.DeepClone(), innerIf.DeepClone()) }; node["else"] = new JsonArray(Guarded(inner["else"]![0]!.AsObject(), outer)); }
                return;
            }
            foreach (var key in node.Select(p => p.Key).ToList()) node.Remove(key);
            foreach (var (key, value) in chain) node[key] = value?.DeepClone();
        }

        private static JsonObject Guarded(JsonObject node, JsonObject condition)
        {
            var copy = node.DeepClone().AsObject();
            copy["if"] = copy["if"] is JsonObject own ? new JsonObject { ["op"] = "and", ["a"] = new JsonArray(condition.DeepClone(), own.DeepClone()) } : condition.DeepClone();
            return copy;
        }

        private static JsonArray Renamed(JsonArray? attributes, string from, string to)
        {
            var result = new JsonArray();
            foreach (var pair in attributes ?? [])
            {
                if (pair is not JsonArray p || p.Count != 2) { result.Add(pair?.DeepClone()); continue; }
                var name = p[0]?.ToString() ?? ""; var value = p[1]?.ToString() ?? "";
                if (name == "class") value = string.Join(" ", value.Split(' ').Select(t => t == "lucide-" + from ? "lucide-" + to : t));
                if (name == "data-lucide" && value == from) value = to;
                result.Add(new JsonArray(name, value));
            }
            return result;
        }

        // ---- values -----------------------------------------------------------------------------------------------------

        /// <summary>Where a value is read: the modal record (its fields need no record name there), the view records it collects.</summary>
        private sealed class Context(string? collection, HashSet<string>? viewRecords)
        {
            public string? Collection { get; } = collection;
            public HashSet<string>? ViewRecords { get; } = viewRecords;
            public bool Shell { get; init; }
            public JsonObject? Modal { get; init; }

            public static Context ForTree(JsonObject tree, Dictionary<string, JsonObject> modals, Context fallback)
            {
                var k = tree["k"]?.ToString() ?? "";
                if (k.StartsWith("m:", StringComparison.Ordinal) && modals.TryGetValue(k[2..].Split('/')[0], out var modal))
                    return new Context(modal["record"]?["collection"]?.ToString(), null) { Modal = modal };
                return fallback;
            }
        }

        /// <summary>One value, predicate or expression of the capture in the compiler's spelling (bottom-up, a new node).</summary>
        private JsonNode? V(JsonNode? n, Context context)
        {
            switch (n)
            {
                case JsonArray a: return new JsonArray(a.Select(x => V(x, context)).ToArray());
                case JsonObject o:
                {
                    var r = new JsonObject();
                    foreach (var (k, v) in o) r[k] = V(v, context);
                    // counts read a list by its name
                    if (r["count"] is JsonValue count && count.TryGetValue<string>(out var listKey))
                        r["count"] = new JsonObject { ["list"] = _listNames.TryGetValue(listKey.TrimStart('#'), out var listName) ? listName : listKey };
                    // the toast is read through the shell's inputs
                    if (r["dim"]?.ToString() is { } dim && !_dims.ContainsKey(dim))
                    {
                        if (dim == "aviso") return new JsonObject { ["input"] = _notice };
                        if (dim == "avisoErro") return new JsonObject { ["input"] = _noticeError };
                    }
                    // a control named by its dimension is the dimension's control
                    if (r["control"] is JsonValue cv && cv.ToString() is { } control && _dimControls.TryGetValue(control, out var dk))
                        r["control"] = _dims[dk]["name"]?.ToString() ?? control;
                    // a field of the modal's own record needs no record name inside the modal
                    if (r["field"] != null && r["record"]?.ToString() is { } record)
                    {
                        if (context.Collection != null && record == context.Collection) r.Remove("record");
                        else context.ViewRecords?.Add(record);
                    }
                    switch (r["op"]?.ToString())
                    {
                        case "contains" when r["fields"] is JsonArray fields:
                            return new JsonObject
                            {
                                ["op"] = "contains", ["l"] = r["r"]?.DeepClone() ?? r["l"]?.DeepClone(),
                                ["r"] = new JsonObject { ["fields"] = new JsonArray(fields.Select(f => (JsonNode?)(f is JsonObject fo ? fo["field"]?.ToString() : f?.ToString())).ToArray()) },
                            };
                        case "not" when r["a"] == null && r["l"] != null:
                            return new JsonObject { ["op"] = "not", ["a"] = new JsonArray(new JsonObject { ["op"] = "truthy", ["l"] = r["l"]!.DeepClone() }) };
                        case { } op when Comparisons.Contains(op):
                            TypeLiteral(r, "l", "r");
                            TypeLiteral(r, "r", "l");
                            break;
                    }
                    if (r["fmt"]?.ToString() == "cases" && r["cases"] is JsonArray cases)
                    {
                        foreach (var c in cases.OfType<JsonObject>())
                            if (c["then"] == null && c.ContainsKey("value")) { c["then"] = Expr(c["value"]); c.Remove("value"); }
                        if (r["else"] is JsonObject otherwise) r["else"] = Expr(otherwise);
                    }
                    return r;
                }
                default: return n?.DeepClone();
            }
        }

        /// <summary>A literal compared with a dimension (or the control of a dimension) takes the dimension's type ("3" -> 3).</summary>
        private void TypeLiteral(JsonObject pred, string side, string other)
        {
            if (pred[side] is not JsonObject literal || literal["lit"] is not JsonValue lit || !lit.TryGetValue<string>(out _)) return;
            string? type = null;
            if (pred[other]?["dim"]?.ToString() is { } dim && _dims.TryGetValue(dim, out var d)) type = d["type"]?.ToString();
            else if (pred[other]?["control"]?.ToString() is { } control && _dims.Values.FirstOrDefault(x => x["name"]?.ToString() == control) is { } cd) type = cd["type"]?.ToString();
            if (type is null or "Text") return;
            literal["lit"] = TypedNode(lit, type);
        }

        /// <summary>An Expr of the format table, from an Expr or a plain value (a value is shown as text).</summary>
        private static JsonNode? Expr(JsonNode? e) => e is JsonObject o && !o.ContainsKey("fmt") ? new JsonObject { ["fmt"] = "text", ["value"] = o.DeepClone() } : e?.DeepClone();

        // ---- helpers ----------------------------------------------------------------------------------------------------

        /// <summary>The roots of the trees: the shell and its siblings, the views, the modals.</summary>
        private IEnumerable<JsonObject> Trees()
        {
            if (ir["shell"] is JsonObject shell)
            {
                if (shell["root"] is JsonObject root) yield return root;
                foreach (var a in Objects(shell["after"] ?? shell["siblings"])) yield return a;
            }
            foreach (var v in Objects(ir["views"])) if (v["root"] is JsonObject vr) yield return vr;
            foreach (var m in Objects(ir["modals"])) if (m["root"] is JsonObject mr) yield return mr;
        }

        private IEnumerable<JsonObject> AllNodes()
        {
            if (ir["shell"] is JsonObject shell)
            {
                foreach (var n in Nodes(shell["root"] as JsonObject)) yield return n;
                foreach (var a in Objects(shell["after"] ?? shell["siblings"])) foreach (var n in Nodes(a)) yield return n;
            }
            foreach (var v in Objects(ir["views"])) foreach (var n in Nodes(v["root"] as JsonObject)) yield return n;
            foreach (var m in Objects(ir["modals"])) foreach (var n in Nodes(m["root"] as JsonObject)) yield return n;
        }

        /// <summary>The element nodes of a tree (list templates and else branches included).</summary>
        private static IEnumerable<JsonObject> Nodes(JsonObject? root)
        {
            if (root == null) yield break;
            var stack = new Stack<JsonObject>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var n = stack.Pop();
                if (n["t"] == null) continue;
                yield return n;
                foreach (var c in (n["c"] as JsonArray ?? []).OfType<JsonObject>().Reverse()) stack.Push(c);
                if (n["list"]?["template"] is JsonObject t) stack.Push(t);
                foreach (var c in (n["else"] as JsonArray ?? []).OfType<JsonObject>()) stack.Push(c);
            }
        }

        private static IEnumerable<JsonObject> Options(JsonObject select) => (select["c"] as JsonArray ?? []).OfType<JsonObject>().Where(o => o["t"]?.ToString() == "option");

        private static bool IsSelector(string text) => text.Length > 0 && (text[0] is '[' or '#' or '.' || text.Contains('['));

        /// <summary>The nodes of a tree a compound selector (tag, #id, .class, [attr], [attr="v"]) matches.</summary>
        private static IEnumerable<JsonObject> Matching(JsonObject tree, string selector)
        {
            var m = SimpleSelector.Match(selector.Trim());
            if (!m.Success) yield break;
            var tag = m.Groups["tag"].Value;
            var parts = SelectorPart.Matches(m.Groups["rest"].Value).ToList();
            foreach (var node in Nodes(tree))
            {
                if (tag.Length > 0 && node["t"]?.ToString() != tag) continue;
                var ok = true;
                foreach (Match p in parts)
                {
                    if (p.Groups["id"].Success) ok = Attr(node, "id") == p.Groups["id"].Value;
                    else if (p.Groups["cls"].Success) ok = (Attr(node, "class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(p.Groups["cls"].Value);
                    else if (p.Groups["attr"].Success) ok = Attr(node, p.Groups["attr"].Value.Trim()) is { } value && (!p.Groups["val"].Success || p.Groups["val"].Value == value);
                    if (!ok) break;
                }
                if (ok) yield return node;
            }
        }

        private static string? Attr(JsonObject node, string name)
        {
            foreach (var pair in node["a"] as JsonArray ?? [])
                if (pair is JsonArray p && p.Count == 2 && string.Equals(p[0]?.ToString(), name, StringComparison.OrdinalIgnoreCase)) return p[1]?.ToString() ?? "";
            return null;
        }

        private static string TextOf(JsonObject node) => node["x"]?.ToString() ?? string.Concat((node["c"] as JsonArray ?? []).OfType<JsonObject>().Select(TextOf));

        private static IEnumerable<JsonObject> EffectsOf(JsonObject e)
        {
            foreach (var x in e["effects"] as JsonArray ?? []) if (x is JsonObject o) yield return o;
            foreach (var c in e["cases"] as JsonArray ?? []) foreach (var x in c?["effects"] as JsonArray ?? []) if (x is JsonObject o) yield return o;
        }

        private static List<JsonObject> Objects(JsonNode? n) => n is JsonArray a ? a.OfType<JsonObject>().ToList() : [];

        private static bool Same(JsonNode? a, JsonNode? b) => a?.ToJsonString().Trim('"') == b?.ToJsonString().Trim('"');

        private static int TextLength(IEnumerable<string> values)
        {
            var longest = values.Select(v => v.Length).DefaultIfEmpty(0).Max();
            foreach (var length in new[] { 50, 120, 250, 2000 }) if (length >= longest) return length;
            return longest;
        }

        private static string Pascal(string text)
        {
            var words = Regex.Split(text, "[^A-Za-z0-9]+").Where(w => w.Length > 0);
            var name = string.Concat(words.Select(w => char.ToUpperInvariant(w[0]) + w[1..]));
            return name.Length > 0 && char.IsLetter(name[0]) ? name : "N" + name;
        }

        private static JsonNode? Default(string type) => type switch { "Integer" or "Decimal" => 0, "Boolean" => false, _ => "" };

        private static JsonNode? Typed(string? raw, string type)
        {
            if (raw == null) return null;
            switch (type)
            {
                case "Integer": return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) ? i : 0;
                case "Decimal": return decimal.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
                case "Boolean": return raw is "true" or "True" or "1" or "on";
                default: return raw;
            }
        }

        private static JsonNode TypedNode(JsonValue lit, string? type)
        {
            if (!lit.TryGetValue<string>(out var s)) return lit.DeepClone();
            return type switch
            {
                "Integer" when long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) => i,
                "Decimal" when decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
                "Boolean" when s is "true" or "false" => s == "true",
                _ => lit.DeepClone(),
            };
        }
    }
}
