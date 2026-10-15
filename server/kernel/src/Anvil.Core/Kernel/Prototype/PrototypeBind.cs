using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>A data source of a screen or popup bound to a producer action: the Data Action &lt;As&gt; of the owner calls Action with
/// Args and exposes Outputs (docs/PROTOTIPO-NATIVO.md 2.12, the compiled form of HtmlExpander.ActionSource). Owner is "v:&lt;view&gt;"
/// or "m:&lt;modal&gt;"; a popup source on a screen is fetched on demand and refreshed when the popup opens.</summary>
public sealed record PrototypeBindSource(string Owner, string As, string Action, IReadOnlyDictionary<string, string> Args, IReadOnlyList<ProducerParam> Outputs);

/// <summary>What data.bind adds to the plan: the producer and its file (the reference step of an .oml binding), the producer elements
/// the reference imports, the Data Actions per owner, the example outputs the read-back renders (fidelity by construction) and the
/// receipt part.</summary>
public sealed class PrototypeBindPlan
{
    public required string Producer { get; init; }
    public string? ProducerFile { get; init; }
    public List<string> Elements { get; } = [];
    public List<PrototypeBindSource> Sources { get; } = [];
    /// <summary>"v:&lt;view&gt;" / "m:&lt;modal&gt;" -> {&lt;as&gt; -> {&lt;output&gt; -> example value}}.</summary>
    public JsonObject Samples { get; } = new();
    public JsonObject Report { get; } = new();
    /// <summary>The collections the binding replaced (no entity, no seed, no snapshot entity).</summary>
    public HashSet<string> BoundCollections { get; } = new(StringComparer.Ordinal);
}

/// <summary>An item of the capture that a binding to the producer must cover: a list, a text slot or an event.</summary>
public sealed record PrototypeUnbound(string Kind, string Key, string View, string Why, string? Text = null);

/// <summary>
/// data.bind (docs/PROTOTIPO-NATIVO.md 2.12): the prototype's collections, texts and events bound to the published actions of a
/// producer module instead of mock entities. Closed keys: producer, screens, lists, slots, events, modals. The binder checks every
/// name against the producer surface (closest names when one is wrong), and rewrites the capture into the annotations the
/// planner compiles: a bound list iterates the output list (list.source), a bound slot is the expression (expr value os), a bound
/// event calls the producer action (effect call, then refresh/message/download) or navigates; a bound collection leaves the
/// store (no entity, no Edit Data seed, no snapshot entity). What still needs a binding is returned as unbound items.
/// </summary>
public static class PrototypeBind
{
    public const string Required = "PROTOTYPE_BINDING_REQUIRED";
    public static readonly IReadOnlyList<string> Keys = ["producer", "screens", "lists", "slots", "events", "modals"];
    public static readonly IReadOnlyList<string> SourceKeys = ["action", "as", "args", "outputs"];
    public static readonly IReadOnlyList<string> EventKeys = ["call", "args", "then", "navigate"];
    private static readonly Regex Identifier = new("^[A-Za-z][A-Za-z0-9_]*$", RegexOptions.Compiled);
    private static readonly Regex Then = new(@"^(refresh [A-Za-z][A-Za-z0-9_]*|message(=| ).+|download)$", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly string[] Write = ["registrar", "criar", "salvar", "gerar", "excluir", "remover", "atualizar", "alterar", "inserir", "enviar", "cancelar",
        "create", "save", "delete", "remove", "update", "insert", "register", "generate", "send", "cancel", "set", "add"];

    public sealed class Result
    {
        public required JsonObject Json { get; init; }
        public required PrototypeBindPlan Plan { get; init; }
        public List<PrototypeCapture.Problem> Problems { get; } = [];
        public List<PrototypeUnbound> Unbound { get; } = [];
    }

    /// <summary>The producer elements a binding needs referenced ("IServerAction:X", "IStaticEntity:Y"): the actions of its sources and
    /// calls and the static entities its expressions read (Entities.Y.Z); the structures of the signatures come with the actions.</summary>
    public static List<string> ElementsOf(JsonObject bind)
    {
        var actions = new SortedSet<string>(StringComparer.Ordinal);
        var statics = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var section in new[] { "screens", "modals" })
            foreach (var (_, owner) in bind[section] as JsonObject ?? [])
                if (owner?["source"]?["action"]?.ToString() is { Length: > 0 } a) actions.Add(a);
        foreach (var (_, e) in bind["events"] as JsonObject ?? []) if (e?["call"]?.ToString() is { Length: > 0 } c) actions.Add(c);
        void Scan(string? text) { if (text == null) return; foreach (Match m in Regex.Matches(text, @"\bEntities\.([A-Za-z][A-Za-z0-9_]*)\.")) statics.Add(m.Groups[1].Value); }
        foreach (var section in new[] { "lists", "slots" }) foreach (var (_, v) in bind[section] as JsonObject ?? []) Scan(v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : null);
        foreach (var (_, e) in bind["events"] as JsonObject ?? []) foreach (var (_, v) in e?["args"] as JsonObject ?? []) Scan(v?.ToString());
        foreach (var section in new[] { "screens", "modals" }) foreach (var (_, owner) in bind[section] as JsonObject ?? []) foreach (var (_, v) in owner?["source"]?["args"] as JsonObject ?? []) Scan(v?.ToString());
        return actions.Select(a => "IServerAction:" + a).Concat(statics.Select(s => "IStaticEntity:" + s)).ToList();
    }

    /// <summary>True when the binding names anything to bind (a binding with only its producer asks for the proposal).</summary>
    public static bool HasBindings(JsonObject bind) => new[] { "screens", "lists", "slots", "events", "modals" }.Any(k => bind[k] is JsonObject { Count: > 0 });

    // ---- the shape (closed keys), before the producer is known -------------------------------------------------------------

    /// <summary>The problems of data.bind's own shape (pointers relative to the op's data).</summary>
    public static List<PrototypeCapture.Problem> Shape(JsonObject data)
    {
        var problems = new List<PrototypeCapture.Problem>();
        if (data["bind"] is null) return problems;
        if (data["bind"] is not JsonObject bind) { problems.Add(Input("/bind", "data.bind is an object {producer, screens, lists, slots, events, modals}", null)); return problems; }
        foreach (var key in bind.Select(p => p.Key).Where(k => !Keys.Contains(k)))
            problems.Add(Input("/bind/" + Esc(key), $"bind.{key} is not a key of data.bind; closest: {Closest(key, Keys)}; keys: {string.Join(", ", Keys)}", Patch(("remove", "/bind/" + Esc(key), null))));
        if (bind["producer"] is not JsonValue pv || !pv.TryGetValue<string>(out var producer) || !Identifier.IsMatch(producer))
            problems.Add(Input("/bind/producer", "bind.producer is the name of the producer module (a binding of producers, e.g. \"FolhaPonto_CS\")", null));
        foreach (var section in new[] { "screens", "modals" })
        {
            if (bind[section] is null) continue;
            if (bind[section] is not JsonObject owners) { problems.Add(Input("/bind/" + section, $"bind.{section} is an object {{<{(section == "screens" ? "view" : "modal")}>: {{source: {{action, as, args, outputs}}}}}}", null)); continue; }
            foreach (var (key, value) in owners)
            {
                var at = $"/bind/{section}/{Esc(key)}";
                if (value is not JsonObject owner) { problems.Add(Input(at, $"bind.{section}.{key} is {{source: {{action, as, args, outputs}}}}", null)); continue; }
                foreach (var extra in owner.Select(p => p.Key).Where(k => k != "source")) problems.Add(Input(at + "/" + Esc(extra), $"bind.{section}.{key}.{extra} is not a key; keys: source", Patch(("remove", at + "/" + Esc(extra), null))));
                if (owner["source"] is not JsonObject source) { problems.Add(Input(at + "/source", $"bind.{section}.{key}.source is {{action, as, args, outputs}}", null)); continue; }
                foreach (var extra in source.Select(p => p.Key).Where(k => !SourceKeys.Contains(k)))
                    problems.Add(Input(at + "/source/" + Esc(extra), $"source.{extra} is not a key; closest: {Closest(extra, SourceKeys)}; keys: {string.Join(", ", SourceKeys)}", Patch(("remove", at + "/source/" + Esc(extra), null))));
                if (source["action"] is not JsonValue av || !av.TryGetValue<string>(out var action) || !Identifier.IsMatch(action)) problems.Add(Input(at + "/source/action", "source.action names a public server action of the producer", null));
                if (source["as"] is { } asNode && (asNode is not JsonValue asv || !asv.TryGetValue<string>(out var asName) || !Identifier.IsMatch(asName))) problems.Add(Input(at + "/source/as", "source.as is the name of the Data Action (an identifier)", null));
                if (source["args"] is { } args && args is not JsonObject) problems.Add(Input(at + "/source/args", "source.args is {<input>: \"<expression>\"}", null));
                if (source["args"] is JsonObject argObject) foreach (var (name, v) in argObject) if (v is not JsonValue jv || !jv.TryGetValue<string>(out _)) problems.Add(Input(at + "/source/args/" + Esc(name), "an argument is an expression (text)", null));
                if (source["outputs"] is { } outputs && (outputs is not JsonArray oa || oa.Any(o => o is not JsonValue))) problems.Add(Input(at + "/source/outputs", "source.outputs lists output names of the action", null));
            }
        }
        foreach (var section in new[] { "lists", "slots" })
        {
            if (bind[section] is null) continue;
            if (bind[section] is not JsonObject items) { problems.Add(Input("/bind/" + section, $"bind.{section} is {{<capture k>: \"<expression>\" | null}}", null)); continue; }
            foreach (var (key, value) in items)
                if (value != null && (value is not JsonValue v || !v.TryGetValue<string>(out var text) || text.Trim().Length == 0))
                    problems.Add(Input($"/bind/{section}/{Esc(key)}", $"bind.{section}.{key} is an expression (text), or null to keep the prototype's own value", null));
        }
        if (bind["events"] is { } eventsNode)
        {
            if (eventsNode is not JsonObject events) problems.Add(Input("/bind/events", "bind.events is {<event key>: {call, args, then, navigate} | null}", null));
            else
                foreach (var (key, value) in events)
                {
                    var at = "/bind/events/" + Esc(key);
                    if (value == null) continue;
                    if (value is not JsonObject e) { problems.Add(Input(at, "an event binding is {call, args, then} or {navigate}", null)); continue; }
                    foreach (var extra in e.Select(p => p.Key).Where(k => !EventKeys.Contains(k)))
                        problems.Add(Input(at + "/" + Esc(extra), $"events.{key}.{extra} is not a key; closest: {Closest(extra, EventKeys)}; keys: {string.Join(", ", EventKeys)}", Patch(("remove", at + "/" + Esc(extra), null))));
                    if (e["call"] == null && e["navigate"] == null) problems.Add(Input(at, "an event binding calls an action (call) or navigates (navigate)", null));
                    if (e["call"] is { } c && (c is not JsonValue cv || !cv.TryGetValue<string>(out var cs) || !Identifier.IsMatch(cs))) problems.Add(Input(at + "/call", "call names a public server action of the producer", null));
                    if (e["navigate"] is { } n && (n is not JsonValue nv || !nv.TryGetValue<string>(out _))) problems.Add(Input(at + "/navigate", "navigate names a view of the capture", null));
                    if (e["args"] is { } a && a is not JsonObject) problems.Add(Input(at + "/args", "args is {<input>: \"<expression>\"}", null));
                    if (e["then"] is { } t)
                    {
                        if (t is not JsonArray ta) problems.Add(Input(at + "/then", "then is a list: \"refresh <as>\", \"message <text>\", \"message= <expression>\", \"download\"", null));
                        else foreach (var (item, i) in ta.Select((x, i) => (x, i)))
                            if (item is not JsonValue iv || !iv.TryGetValue<string>(out var s) || !Then.IsMatch(s.Trim()))
                                problems.Add(Input($"{at}/then/{i}", $"then item '{item}' is \"refresh <as>\", \"message <text>\", \"message= <expression>\" or \"download\"", null));
                    }
                }
        }
        return problems;
    }

    // ---- the binding over the capture and the producer --------------------------------------------------------------------

    /// <summary>Checks every name of data.bind against the capture and the producer and rewrites a copy of the capture.</summary>
    public static Result Apply(PrototypeCapture capture, JsonObject bind, PrototypeProducer producer, string? producerFile)
    {
        var json = capture.Json.DeepClone().AsObject();
        var result = new Result { Json = json, Plan = new PrototypeBindPlan { Producer = producer.Name, ProducerFile = producerFile } };
        var problems = result.Problems;
        var sources = new Dictionary<string, (string Owner, ProducerAction Action, IReadOnlyList<ProducerParam> Outputs)>(StringComparer.OrdinalIgnoreCase);
        var views = PrototypeCapture.Objects(json["views"]).Select(v => v["key"]!.ToString()).ToList();
        var modals = PrototypeCapture.Objects(json["modals"]).Select(m => m["key"]!.ToString()).ToList();
        // sources
        foreach (var section in new[] { "screens", "modals" })
            foreach (var (key, value) in bind[section] as JsonObject ?? [])
            {
                var at = $"/bind/{section}/{Esc(key)}";
                var known = section == "screens" ? views : modals;
                if (!known.Contains(key)) { problems.Add(Input(at, $"bind.{section}: '{key}' is not a {(section == "screens" ? "view" : "modal")} of the capture; closest: {Closest(key, known)}; {(section == "screens" ? "views" : "modals")}: {string.Join(", ", known)}", known.Count > 0 ? Rename(at, "/bind/" + section + "/" + Esc(Closest(key, known)), value) : null)); continue; }
                if (value?["source"] is not JsonObject source) continue;
                var actionName = source["action"]?.ToString() ?? "";
                if (!producer.Actions.TryGetValue(actionName, out var action))
                {
                    var closest = Closest(actionName, producer.Actions.Keys);
                    problems.Add(Input(at + "/source/action", $"{producer.Name} has no public server action '{actionName}'; closest: {closest}; actions: {string.Join(", ", producer.Actions.Keys.Order(StringComparer.Ordinal))}", Patch(("replace", at + "/source/action", closest))));
                    continue;
                }
                var asName = source["as"]?.ToString() ?? action.Name;
                var owner = (section == "screens" ? "v:" : "m:") + key;
                if (sources.TryGetValue(asName, out var other) && other.Owner == owner) { problems.Add(Input(at + "/source/as", $"the data action '{asName}' is declared twice in {owner}", null)); continue; }
                var args = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var (name, v) in source["args"] as JsonObject ?? [])
                {
                    var input = action.Inputs.FirstOrDefault(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                    if (input == null) { problems.Add(Input($"{at}/source/args/{Esc(name)}", $"{action.Name} has no input '{name}'; inputs: {string.Join(", ", action.Inputs.Select(p => p.Name + ": " + p.Type))}", action.Inputs.Count > 0 ? Rename($"{at}/source/args/{Esc(name)}", $"{at}/source/args/{Esc(Closest(name, action.Inputs.Select(p => p.Name)))}", v) : Patch(("remove", $"{at}/source/args/{Esc(name)}", null)))); continue; }
                    args[input.Name] = v!.ToString();
                }
                foreach (var input in action.Inputs.Where(p => p.Mandatory && !args.ContainsKey(p.Name)))
                    problems.Add(Input($"{at}/source/args/{Esc(input.Name)}", $"{action.Name} needs the input {input.Name} ({input.Type}): args.{input.Name} is an expression of the screen", Patch(("add", $"{at}/source/args/{Esc(input.Name)}", DefaultArgument(input)))));
                var outputs = new List<ProducerParam>();
                if (source["outputs"] is JsonArray subset)
                    foreach (var o in subset.Select(o => o!.ToString()))
                    {
                        var output = action.Outputs.FirstOrDefault(p => p.Name.Equals(o, StringComparison.OrdinalIgnoreCase));
                        if (output == null) problems.Add(Input(at + "/source/outputs", $"{action.Name} has no output '{o}'; outputs: {string.Join(", ", action.Outputs.Select(p => p.Name))}", null));
                        else outputs.Add(output);
                    }
                else outputs.AddRange(action.Outputs);
                if (outputs.Count == 0) { problems.Add(Input(at + "/source", $"{action.Name} has no outputs to show", null)); continue; }
                sources[asName] = (owner, action, outputs);
                result.Plan.Sources.Add(new PrototypeBindSource(owner, asName, action.Name, args, outputs));
            }
        var resolver = new PathResolver(producer, sources.ToDictionary(s => s.Key, s => s.Value.Outputs, StringComparer.OrdinalIgnoreCase));
        // lists
        var listNodes = ListNodes(json);
        foreach (var (key, value) in bind["lists"] as JsonObject ?? [])
        {
            var at = "/bind/lists/" + Esc(key);
            var node = FindList(listNodes, key);
            if (node == null) { problems.Add(Input(at, $"'{key}' is not a list of the capture; lists: {string.Join(", ", listNodes.Select(l => l.Node["k"]!.ToString()))}", listNodes.Count > 0 ? Rename(at, "/bind/lists/" + Esc(Closest(key, listNodes.Select(l => l.Node["k"]!.ToString()))), value) : null)); continue; }
            if (value == null) { node.Node["list"]!["kept"] = true; continue; }
            var expression = value.ToString().Trim();
            var resolved = resolver.Resolve(expression);
            if (resolved.Error != null) { problems.Add(Input(at, $"lists.{key}: {resolved.Error}", resolved.Fix != null ? Patch(("replace", at, resolved.Fix)) : null)); continue; }
            if (PrototypeProducer.Shape(resolved.Type!).Shape != "list") { problems.Add(Input(at, $"lists.{key}: {resolved.Path} is {resolved.Type}, not a list", null)); continue; }
            var list = (JsonObject)node.Node["list"]!;
            if (list["collection"]?.ToString() is { } collection) result.Plan.BoundCollections.Add(collection);
            foreach (var drop in new[] { "collection", "filter", "sort", "sortBy", "snapshot", "key" }) list.Remove(drop);
            list["source"] = resolved.Path;
            list["item"] = resolved.Path + ".Current";
            list["itemType"] = PrototypeProducer.Shape(resolved.Type!).Base;
            list["bound"] = true;
        }
        // slots
        foreach (var (key, value) in bind["slots"] as JsonObject ?? [])
        {
            var at = "/bind/slots/" + Esc(key);
            var attribute = key.Contains('@') ? key[(key.IndexOf('@') + 1)..] : null;
            var k = attribute != null ? key[..key.IndexOf('@')] : key;
            var node = FindNode(json, k);
            if (node == null) { problems.Add(Input(at, $"'{k}' is not a node of the capture (a text, an element with one text, or a template node of a list: <list k>/*/...)", null)); continue; }
            if (value == null) { node["kept"] = true; continue; }
            var expression = value.ToString().Trim();
            var check = resolver.Check(expression);
            if (check.Error != null) { problems.Add(Input(at, $"slots.{key}: {check.Error}", check.Fix != null ? Patch(("replace", at, expression.Replace(check.Bad!, check.Fix))) : null)); continue; }
            var os = new JsonObject { ["fmt"] = "text", ["value"] = new JsonObject { ["os"] = resolver.Canonical(expression), ["type"] = "Text" }, ["bound"] = true };
            if (attribute != null)
            {
                if (node["t"] == null) { problems.Add(Input(at, $"'{k}' is a text: an attribute slot (<k>@<attribute>) names an element", null)); continue; }
                var attrExpr = node["attrExpr"] as JsonObject ?? new JsonObject();
                attrExpr[attribute] = new JsonObject { ["expr"] = os, ["bound"] = true };
                node["attrExpr"] = attrExpr;
                continue;
            }
            var text = node["x"] != null ? node : (node["c"] as JsonArray)?.OfType<JsonObject>().Where(c => c["x"] != null || c["t"] != null).ToList() is [{ } only] && only["x"] != null ? only : null;
            if (text == null) { problems.Add(Input(at, $"'{k}' is an element with child elements: name its text node (or an element whose only content is a text)", null)); continue; }
            text["expr"] = os;
        }
        // events
        var events = PrototypeCapture.Objects(json["events"]);
        foreach (var (key, value) in bind["events"] as JsonObject ?? [])
        {
            var at = "/bind/events/" + Esc(key);
            var e = events.FirstOrDefault(x => x["key"]?.ToString() == key);
            if (e == null) { problems.Add(Input(at, $"'{key}' is not an event of the capture; closest: {Closest(key, events.Select(x => x["key"]!.ToString()))}", events.Count > 0 ? Rename(at, "/bind/events/" + Esc(Closest(key, events.Select(x => x["key"]!.ToString()))), value) : null)); continue; }
            if (value == null) { e["kept"] = true; continue; }
            var effects = new JsonArray();
            if (value["call"]?.ToString() is { } callName)
            {
                if (!producer.Actions.TryGetValue(callName, out var action))
                {
                    var closest = Closest(callName, producer.Actions.Keys);
                    problems.Add(Input(at + "/call", $"{producer.Name} has no public server action '{callName}'; closest: {closest}", Patch(("replace", at + "/call", closest))));
                    continue;
                }
                var args = new JsonObject();
                foreach (var (name, v) in value["args"] as JsonObject ?? [])
                {
                    var input = action.Inputs.FirstOrDefault(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                    if (input == null) { problems.Add(Input($"{at}/args/{Esc(name)}", $"{action.Name} has no input '{name}'; inputs: {string.Join(", ", action.Inputs.Select(p => p.Name))}", null)); continue; }
                    args[input.Name] = resolver.Canonical(v!.ToString());
                }
                foreach (var input in action.Inputs.Where(p => p.Mandatory && !args.ContainsKey(p.Name)))
                    problems.Add(Input($"{at}/args/{Esc(input.Name)}", $"{action.Name} needs the input {input.Name} ({input.Type})", Patch(("add", $"{at}/args/{Esc(input.Name)}", DefaultArgument(input)))));
                var then = new JsonArray();
                foreach (var item in value["then"] as JsonArray ?? [])
                {
                    var s = item!.ToString().Trim();
                    if (s.StartsWith("refresh ", StringComparison.Ordinal) && !sources.ContainsKey(s[8..].Trim()))
                    { problems.Add(Input(at + "/then", $"'{s}': no data action {s[8..].Trim()}; data actions: {string.Join(", ", sources.Keys)}", null)); continue; }
                    if (s == "download" && !action.Outputs.Any(o => o.Type == "Binary Data"))
                    { problems.Add(Input(at + "/then", $"download needs a Binary Data output; {action.Name} has none", null)); continue; }
                    then.Add(s);
                }
                effects.Add(new JsonObject { ["kind"] = "call", ["action"] = action.Name, ["args"] = args, ["then"] = then, ["outputs"] = new JsonArray(action.Outputs.Select(o => (JsonNode)new JsonObject { ["name"] = o.Name, ["type"] = o.Type }).ToArray()) });
            }
            if (value["navigate"]?.ToString() is { } navigate)
            {
                if (!views.Contains(navigate)) { problems.Add(Input(at + "/navigate", $"'{navigate}' is not a view of the capture; views: {string.Join(", ", views)}", views.Count > 0 ? Patch(("replace", at + "/navigate", Closest(navigate, views))) : null)); continue; }
                effects.Add(new JsonObject { ["kind"] = "navigate", ["view"] = navigate });
            }
            // the capture's own client effects stay after the call (a popup that opens, a toast) unless they wrote the store
            foreach (var x in PrototypePlanner.Effects(e).Where(x => !PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString()) && x["kind"]?.ToString() != "validate" && x["kind"]?.ToString() != "navigate"))
                effects.Add(x.DeepClone());
            e["effects"] = effects; e.Remove("cases"); e["compiled"] = true; e.Remove("notCompiled"); e["bound"] = true;
        }
        if (problems.Count > 0) return result;
        // the collections the binding replaced leave the store (no entity, no seed); the lists still over them keep it
        var stillUsed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var l in ListNodes(json)) if (l.Node["list"]?["collection"]?.ToString() is { } c) stillUsed.Add(c);
        result.Plan.BoundCollections.ExceptWith(stillUsed);
        if (json["store"]?["collections"] is JsonArray collections)
            foreach (var c in collections.OfType<JsonObject>().Where(c => result.Plan.BoundCollections.Contains(c["name"]?.ToString() ?? "")).ToList()) collections.Remove(c);
        if (json["extraAttributes"] is JsonArray extras)
            foreach (var x in extras.OfType<JsonObject>().Where(x => result.Plan.BoundCollections.Contains(x["collection"]?.ToString() ?? "")).ToList()) extras.Remove(x);
        result.Unbound.AddRange(Unbound(json, bind, result.Plan));
        foreach (var element in ElementsOf(bind)) result.Plan.Elements.Add(element);
        return result;
    }

    /// <summary>What the binding still has to cover: a list of a store collection, a text that reads a collection field (a list
    /// template slot of the mock collection), an event the capture could not compile or that writes a bound collection.</summary>
    public static IEnumerable<PrototypeUnbound> Unbound(JsonObject json, JsonObject bind, PrototypeBindPlan plan)
    {
        var snapshots = PrototypeCapture.Objects(json["store"]?["collections"]).Where(c => c["snapshot"] != null).Select(c => c["name"]!.ToString()).ToHashSet(StringComparer.Ordinal);
        foreach (var (node, view) in ListNodes(json).Select(l => (l.Node, l.View)))
        {
            var list = (JsonObject)node["list"]!;
            if (list["kept"]?.GetValue<bool>() == true || list["bound"]?.GetValue<bool>() == true) continue;
            // a group of siblings the capture kept as rows of a snapshot entity is the prototype's layout, not its data
            if (list["collection"]?.ToString() is { } collection && !snapshots.Contains(collection))
                yield return new PrototypeUnbound("list", node["k"]!.ToString(), view, $"the list renders the prototype's collection {collection}", collection);
        }
        foreach (var (node, view, inBoundList) in TextNodes(json))
        {
            if (node["kept"]?.GetValue<bool>() == true) continue;
            if (node["expr"] is not JsonObject expr || expr["bound"]?.GetValue<bool>() == true) continue;
            if (!ReadsField(expr)) continue;
            if (!inBoundList) continue;
            yield return new PrototypeUnbound("slot", node["k"]!.ToString(), view, "the text reads a field of the prototype's collection inside a bound list", node["x"]?.ToString());
        }
        foreach (var e in PrototypeCapture.Objects(json["events"]))
        {
            if (e["bound"]?.GetValue<bool>() == true || e["kept"]?.GetValue<bool>() == true) continue;
            var view = e["modal"]?.ToString() is { } modal ? "m:" + modal : e["view"]?.ToString() is { } v ? "v:" + v : "shell";
            var effects = PrototypePlanner.Effects(e).ToList();
            if (effects.Count == 0) { yield return new PrototypeUnbound("event", e["key"]!.ToString(), view, "the capture explained no effect of the event (state only in the script)"); continue; }
            var writes = effects.Where(x => PrototypeCapture.DataEffects.Contains(x["kind"]!.ToString())).Select(x => x["collection"]?.ToString()).OfType<string>().ToList();
            if (writes.Any(plan.BoundCollections.Contains)) yield return new PrototypeUnbound("event", e["key"]!.ToString(), view, "the event writes a collection the binding replaced: it calls a producer action instead");
        }
    }

    private static bool ReadsField(JsonNode? n) => n switch
    {
        JsonObject o => (o["field"] != null && o["os"] == null) || o.Any(p => p.Key != "bound" && ReadsField(p.Value)),
        JsonArray a => a.Any(ReadsField),
        _ => false,
    };

    // ---- nodes of the capture ---------------------------------------------------------------------------------------------

    internal sealed record ListNode(JsonObject Node, string View);

    internal static List<ListNode> ListNodes(JsonObject json)
    {
        var lists = new List<ListNode>();
        void Walk(JsonObject? n, string view)
        {
            if (n == null) return;
            if (n["list"] is JsonObject list) { lists.Add(new ListNode(n, view)); Walk(list["template"] as JsonObject, view); }
            foreach (var c in n["c"] as JsonArray ?? []) Walk(c as JsonObject, view);
            foreach (var c in n["else"] as JsonArray ?? []) Walk(c as JsonObject, view);
            if (n["toast"]?["template"] is JsonObject t) Walk(t, view);
        }
        foreach (var v in PrototypeCapture.Objects(json["views"])) Walk(v["root"] as JsonObject, "v:" + v["key"]);
        foreach (var m in PrototypeCapture.Objects(json["modals"])) Walk(m["root"] as JsonObject, "m:" + m["key"]);
        if (json["shell"] is JsonObject shell) { Walk(shell["root"] as JsonObject, "shell"); foreach (var a in PrototypeCapture.Objects(shell["after"])) Walk(a, "shell"); }
        return lists;
    }

    /// <summary>The text nodes of the capture with their owner and whether they are inside a list bound to the producer.</summary>
    internal static IEnumerable<(JsonObject Node, string View, bool InBoundList)> TextNodes(JsonObject json)
    {
        var found = new List<(JsonObject, string, bool)>();
        void Walk(JsonObject? n, string view, bool bound)
        {
            if (n == null) return;
            if (n["x"] != null) { found.Add((n, view, bound)); return; }
            if (n["list"] is JsonObject list) Walk(list["template"] as JsonObject, view, list["bound"]?.GetValue<bool>() == true);
            foreach (var c in n["c"] as JsonArray ?? []) Walk(c as JsonObject, view, bound);
            foreach (var c in n["else"] as JsonArray ?? []) Walk(c as JsonObject, view, bound);
        }
        foreach (var v in PrototypeCapture.Objects(json["views"])) Walk(v["root"] as JsonObject, "v:" + v["key"], false);
        foreach (var m in PrototypeCapture.Objects(json["modals"])) Walk(m["root"] as JsonObject, "m:" + m["key"], false);
        return found;
    }

    private static ListNode? FindList(List<ListNode> lists, string key)
    {
        var exact = lists.FirstOrDefault(l => l.Node["k"]?.ToString() == key);
        if (exact != null) return exact;
        // a selector of the list element: #id or .class
        if (key.StartsWith('#')) return lists.FirstOrDefault(l => Attr(l.Node, "id") == key[1..]);
        if (key.StartsWith('.')) return lists.FirstOrDefault(l => (Attr(l.Node, "class") ?? "").Split(' ').Contains(key[1..]));
        return null;
    }

    internal static string? Attr(JsonObject node, string name) => (node["a"] as JsonArray ?? []).OfType<JsonArray>().FirstOrDefault(p => p.Count == 2 && p[0]?.ToString() == name)?[1]?.ToString();

    /// <summary>The node of a k anywhere in the capture (views, modals, shell, list templates).</summary>
    internal static JsonObject? FindNode(JsonObject json, string k)
    {
        JsonObject? Walk(JsonObject? n)
        {
            if (n == null) return null;
            if (n["k"]?.ToString() == k) return n;
            if (n["list"]?["template"] is JsonObject t && Walk(t) is { } inTemplate) return inTemplate;
            foreach (var c in n["c"] as JsonArray ?? []) if (Walk(c as JsonObject) is { } hit) return hit;
            foreach (var c in n["else"] as JsonArray ?? []) if (Walk(c as JsonObject) is { } hit) return hit;
            if (n["toast"]?["template"] is JsonObject tt && Walk(tt) is { } inToast) return inToast;
            return null;
        }
        foreach (var v in PrototypeCapture.Objects(json["views"])) if (Walk(v["root"] as JsonObject) is { } hit) return hit;
        foreach (var m in PrototypeCapture.Objects(json["modals"])) if (Walk(m["root"] as JsonObject) is { } hit) return hit;
        if (json["shell"] is JsonObject shell)
        {
            if (Walk(shell["root"] as JsonObject) is { } hit) return hit;
            foreach (var a in PrototypeCapture.Objects(shell["after"])) if (Walk(a) is { } h) return h;
        }
        return null;
    }

    // ---- expressions over the outputs -------------------------------------------------------------------------------------

    /// <summary>Resolves dotted paths over the Data Actions of a binding: &lt;as&gt;.&lt;output&gt;.&lt;attribute&gt;...; with one output the
    /// output may be left out (Resumo.Dia.Etapas for the Data Action Resumo whose only output is Resumo is Resumo.Resumo.Dia.Etapas).</summary>
    internal sealed class PathResolver(PrototypeProducer producer, IReadOnlyDictionary<string, IReadOnlyList<ProducerParam>> sources)
    {
        public sealed record Resolved(string? Path, string? Type, string? Error, string? Fix, string? Bad = null);

        public Resolved Resolve(string expression)
        {
            var parts = expression.Split('.').Select(p => p.Trim()).ToList();
            if (parts.Count == 0 || parts.Any(p => !Identifier.IsMatch(p))) return new(null, null, $"'{expression}' is not a path <dataAction>.<output>.<attribute>...", null);
            if (!sources.TryGetValue(parts[0], out var outputs))
                return new(null, null, $"'{parts[0]}' is not a data action of the binding; data actions: {string.Join(", ", sources.Keys)}", sources.Count > 0 ? Closest(parts[0], sources.Keys) + expression[parts[0].Length..] : null, parts[0]);
            var canonical = new List<string> { sources.Keys.First(k => k.Equals(parts[0], StringComparison.OrdinalIgnoreCase)) };
            var rest = parts.Skip(1).ToList();
            if (rest.Count == 0) return new(null, null, $"'{expression}' names the data action; add the output ({string.Join(", ", outputs.Select(o => o.Name))})", null);
            var output = outputs.FirstOrDefault(o => o.Name.Equals(rest[0], StringComparison.OrdinalIgnoreCase));
            if (output == null)
            {
                if (outputs.Count == 1) output = outputs[0];
                else return new(null, null, $"{canonical[0]} has no output '{rest[0]}'; outputs: {string.Join(", ", outputs.Select(o => o.Name))}", canonical[0] + "." + Closest(rest[0], outputs.Select(o => o.Name)) + string.Concat(rest.Skip(1).Select(r => "." + r)), rest[0]);
            }
            else rest.RemoveAt(0);
            canonical.Add(output.Name);
            var type = output.Type;
            foreach (var part in rest)
            {
                if (part.Equals("Current", StringComparison.Ordinal) && PrototypeProducer.Shape(type).Shape == "list") { canonical.Add("Current"); type = PrototypeProducer.Shape(type).Base; continue; }
                if (part is "Length" or "CurrentRowNumber" && PrototypeProducer.Shape(type).Shape == "list") { canonical.Add(part); type = "Integer"; continue; }
                var fields = producer.Fields(type);
                if (fields == null) return new(null, null, $"{string.Join(".", canonical)} is {type}: it has no attribute '{part}'", null, part);
                var field = fields.FirstOrDefault(f => f.Name.Equals(part, StringComparison.OrdinalIgnoreCase));
                if (field == null)
                {
                    var closest = Closest(part, fields.Select(f => f.Name));
                    return new(null, null, $"{string.Join(".", canonical)} ({type}) has no attribute '{part}'; closest: {closest}; attributes: {string.Join(", ", fields.Select(f => f.Name))}", string.Join(".", canonical) + "." + closest, part);
                }
                canonical.Add(field.Name);
                type = field.Type;
            }
            return new(string.Join(".", canonical), type, null, null);
        }

        /// <summary>Every path of an expression that starts with a data action resolves (the rest of the expression is the Verify's).</summary>
        public Resolved Check(string expression)
        {
            foreach (Match m in Regex.Matches(StripStrings(expression), @"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)"))
            {
                if (!sources.ContainsKey(m.Groups[1].Value)) continue;
                var path = m.Value;
                var resolved = Resolve(path);
                if (resolved.Error != null) return resolved with { Bad = path, Fix = resolved.Fix };
            }
            return new(expression, null, null, null);
        }

        /// <summary>The expression with every shorthand path written in full (Resumo.Dia -> Resumo.Resumo.Dia).</summary>
        public string Canonical(string expression)
        {
            var masked = StripStrings(expression);
            var sb = new StringBuilder(expression);
            foreach (Match m in Regex.Matches(masked, @"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)").Cast<Match>().Reverse())
            {
                if (!sources.ContainsKey(m.Groups[1].Value)) continue;
                var resolved = Resolve(m.Value);
                if (resolved.Path != null && resolved.Path != m.Value) { sb.Remove(m.Index, m.Length); sb.Insert(m.Index, resolved.Path); }
            }
            return sb.ToString();
        }
    }

    /// <summary>The expression with the contents of its string literals blanked (same length), so paths are never read inside them.</summary>
    internal static string StripStrings(string expression)
    {
        var chars = expression.ToCharArray();
        var inside = false;
        for (var i = 0; i < chars.Length; i++)
        {
            if (chars[i] == '"') { if (inside && i + 1 < chars.Length && chars[i + 1] == '"') { chars[i] = ' '; chars[++i] = ' '; continue; } inside = !inside; continue; }
            if (inside) chars[i] = ' ';
        }
        return new string(chars);
    }

    /// <summary>A request (idempotency) key computed on the client with built-ins only (GenerateGuid is the Text extension's, not a
    /// client built-in): the user and the second of the click, so a second press of the same click is the same request.</summary>
    internal const string RequestKey = "IntegerToText(IdentifierToInteger(GetUserId())) + \"-\" + FormatDateTime(CurrDateTime(), \"yyyyMMddHHmmss\")";

    /// <summary>The argument a mandatory input gets when nothing else is known: a request key for a request id, today for a date, the
    /// current year and month for Ano/Mes (Year/Month), else the type's null.</summary>
    internal static string DefaultArgument(ProducerParam input)
    {
        var n = input.Name.ToLowerInvariant();
        return input.Type switch
        {
            "Text" when n.Contains("request") || n.Contains("guid") || n.Contains("idempot") => RequestKey,
            "Date" => "CurrDate()",
            "Date Time" => "CurrDateTime()",
            "Time" => "CurrTime()",
            "Integer" when n is "ano" or "year" => "Year(CurrDate())",
            "Integer" when n is "mes" or "month" => "Month(CurrDate())",
            "Integer" or "Long Integer" or "Decimal" or "Currency" => "0",
            "Boolean" => "False",
            "Text" => "\"\"",
            _ when input.Type.EndsWith(" Identifier", StringComparison.Ordinal) => "NullIdentifier()",
            _ => "\"\"",
        };
    }

    // ---- problems -------------------------------------------------------------------------------------------------------------

    internal static PrototypeCapture.Problem Input(string pointer, string message, JsonArray? patch) => new("INPUT_INVALID", pointer, "prototype: " + message, false, patch);

    internal static JsonArray Patch(params (string Op, string Path, string? Value)[] operations)
        => new(operations.Select(o => (JsonNode)(o.Op == "remove" ? new JsonObject { ["op"] = "remove", ["path"] = o.Path } : new JsonObject { ["op"] = o.Op, ["path"] = o.Path, ["value"] = o.Value })).ToArray());

    /// <summary>A key renamed to the closest one (remove + add: the patches of a refusal never move).</summary>
    private static JsonArray Rename(string from, string to, JsonNode? value)
        => new(new JsonObject { ["op"] = "remove", ["path"] = from }, new JsonObject { ["op"] = "add", ["path"] = to, ["value"] = value?.DeepClone() });

    internal static string Esc(string token) => token.Replace("~", "~0").Replace("/", "~1");

    internal static string Closest(string key, IEnumerable<string> known)
    {
        var list = known.ToList();
        if (list.Count == 0) return key;
        return list.OrderBy(k => Distance(key.ToLowerInvariant(), k.ToLowerInvariant())).ThenBy(k => k, StringComparer.Ordinal).First();
    }

    private static int Distance(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) d[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
            for (var j = 1; j <= b.Length; j++)
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
        return d[a.Length, b.Length];
    }

    internal static bool IsWriteAction(string name)
    {
        var lower = name.ToLowerInvariant();
        return Write.Any(w => lower.StartsWith(w, StringComparison.Ordinal));
    }
}
