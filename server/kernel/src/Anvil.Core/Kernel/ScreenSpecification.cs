using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>A tree declaration, never a list of commands or arbitrary mutation targets.</summary>
public static class ScreenSpecification
{
    private static readonly JsonObject vocabulary = JsonNode.Parse(typeof(ScreenSpecification).Assembly.GetManifestResourceStream("Anvil.Core.Kernel.ScreenVocabulary.json")!)!.AsObject();
    public static JsonObject Vocabulary => vocabulary.DeepClone().AsObject();
    public static string Context(JsonObject screen) => screen["type"]!.ToString().StartsWith("IMobile", StringComparison.Ordinal) ? "mobile" : "web";
    public static string Reference(JsonObject screen) => screen["type"] + ":" + screen["name"];
    public static JsonObject Shape(string context, string type) => vocabulary[context + ":" + type]?.AsObject()
        ?? throw new ArgumentException("Unsupported " + context + " screen/widget type: " + type);
    public static IEnumerable<JsonObject> Objects(JsonObject node, string key) => node[key]?.AsArray().OfType<JsonObject>() ?? [];
    internal static IReadOnlyList<JsonObject> DefinitionOrder(JsonArray screens)
    {
        string Canonical(string reference){var parts=reference.Split(':',2);return parts[0].Split('.').Last()+":"+parts[1];}
        var owners=screens.OfType<JsonObject>().ToDictionary(s=>Canonical(Reference(s)),StringComparer.OrdinalIgnoreCase);
        var done=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var visiting=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var result=new List<JsonObject>();
        IEnumerable<string> Sources(JsonNode? node)
        {
            if(node is JsonObject obj){if(obj["type"]?.ToString().EndsWith("BlockInstanceWidget",StringComparison.Ordinal)==true && obj["source"] is { } source)yield return Canonical(source.ToString());foreach(var value in obj.Select(p=>p.Value))foreach(var dependency in Sources(value))yield return dependency;}
            else if(node is JsonArray array)foreach(var value in array)foreach(var dependency in Sources(value))yield return dependency;
        }
        void Visit(string key)
        {
            if(done.Contains(key))return;
            if(!visiting.Add(key))throw new ArgumentException("UI block composition cycle at "+key);
            foreach(var source in Sources(owners[key]["widgets"]).Distinct(StringComparer.OrdinalIgnoreCase))if(owners.ContainsKey(source))Visit(source);
            visiting.Remove(key);done.Add(key);result.Add(owners[key]);
        }
        foreach(var key in owners.Keys)Visit(key);return result;
    }
    public static JsonObject Schema() => new() {
        ["owner"] = new JsonArray("name", "type", "flow", "roles", "properties", "inputs", "vars", "widgets", "events", "blockEvents", "queries", "sourceEvents"),
        ["widget"] = new JsonArray("name", "type", "properties", "children", "slots", "source", "args", "events", "attributes"),
        ["binding"] = new JsonArray("destination", "args", "method", "transition", "validation"),
        ["validation"] = new JsonArray("None", "ValidateAndContinue"),
        ["parameter"] = new JsonArray("name", "type", "mandatory", "default", "description"),
        ["vocabulary"] = Vocabulary,
        ["rules"] = "The declared owner controls its complete widget tree, inputs and local state. Named owners and surviving widgets retain identity. Events use named destinations and explicit arguments. Source block signatures determine placeholders, inputs and custom events. Roles are explicit on screens. Missing capabilities fail; no raw operations, keys or paths to external mutations."
    };
    public static void Validate(JsonArray screens)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in screens)
        {
            var screen = item as JsonObject ?? throw new ArgumentException("screens must contain declaration objects");
            Keys(screen, ["name", "type", "flow", "roles", "properties", "inputs", "vars", "widgets", "events", "blockEvents", "queries", "sourceEvents"], "screen");
            var name = Name(screen["name"]); if (!names.Add(name)) throw new ArgumentException("Duplicate screen/block name: " + name);
            var type = screen["type"]?.ToString() ?? "";
            if (type is not ("IMobileScreen" or "IMobileBlock" or "IWebScreen" or "IWebBlock")) throw new ArgumentException("Unknown screen/block type: " + type);
            Name(screen["flow"]); var context = Context(screen); var shape = Shape(context, type);
            Properties(screen, shape);
            if (type.EndsWith("Screen", StringComparison.Ordinal))
            {
                if (screen["roles"] is not JsonArray roles || roles.Count == 0) throw new ArgumentException("Screen roles must explicitly declare Registered, Anonymous or named roles");
                var values = roles.Select(Name).ToArray(); if (values.Distinct(StringComparer.OrdinalIgnoreCase).Count() != values.Length) throw new ArgumentException("Duplicate screen role");
            }
            else if (screen.ContainsKey("roles")) throw new ArgumentException("Blocks do not declare screen roles");
            var parameters = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var key in new[] { "inputs", "vars" })
            {
                Array(screen, key);
                foreach (var parameter in Objects(screen, key))
                {
                    Keys(parameter, ["name", "type", "mandatory", "default", "description"], "screen parameter");
                    if (!parameters.Add(Name(parameter["name"]))) throw new ArgumentException("Duplicate screen input/local variable");
                    Text(parameter["type"], "parameter type");
                    if (parameter.ContainsKey("mandatory") && key != "inputs") throw new ArgumentException("Only screen inputs declare mandatory");
                    if (parameter["mandatory"] != null) Boolean(parameter["mandatory"], "mandatory");
                    foreach (var text in new[] { "default", "description" }) if (parameter[text] != null) Text(parameter[text], text);
                }
            }
            Array(screen, "blockEvents");
            if (screen.ContainsKey("blockEvents") && !type.EndsWith("Block", StringComparison.Ordinal)) throw new ArgumentException("Only blocks declare outgoing events");
            var eventNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var ev in Objects(screen, "blockEvents"))
            {
                Keys(ev, ["name", "mandatory", "inputs"], "block event");
                if (!eventNames.Add(Name(ev["name"]))) throw new ArgumentException("Duplicate block event");
                if (ev["mandatory"] != null) Boolean(ev["mandatory"], "mandatory");
                Array(ev, "inputs");
                var eventInputs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var input in Objects(ev, "inputs")) { Keys(input, ["name", "type"], "event input"); if (!eventInputs.Add(Name(input["name"]))) throw new ArgumentException("Duplicate event input"); Text(input["type"], "event input type"); }
            }
            Array(screen, "queries");
            if (context == "web" && screen.ContainsKey("queries")) throw new ArgumentException("Traditional screens query in their Preparation action");
            foreach (var query in Objects(screen, "queries"))
            {
                if (!parameters.Add(Name(query["as"]))) throw new ArgumentException("Duplicate screen query/input/variable name");
                Query(query);
            }
            if (screen["sourceEvents"] is JsonObject sourceEvents)
            {
                foreach (var entry in sourceEvents)
                {
                    Name(JsonValue.Create(entry.Key));
                    Bindings(new JsonObject { ["events"] = new JsonObject { ["OnAfterFetch"] = entry.Value?.DeepClone() } }, new JsonObject { ["events"] = new JsonObject { ["OnAfterFetch"] = "" } }, false);
                }
            }
            else if (screen.ContainsKey("sourceEvents")) throw new ArgumentException("sourceEvents must be an object");
            var widgetNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Tree(screen["widgets"] as JsonArray ?? throw new ArgumentException("screen.widgets is required"), context, widgetNames);
            Bindings(screen, shape, false);
        }
        DefinitionOrder(screens);
    }
    internal static JsonObject Query(JsonObject declaration)
    {
        var query = declaration.DeepClone().AsObject();
        if (query.ContainsKey("client")) { Boolean(query["client"], "query.client"); query.Remove("client"); }
        if (query["sql"]?.GetValue<bool>() == true) throw new ArgumentException("Screen aggregates do not accept SQL; use a data/server action");
        LogicExpander.Expand(new JsonObject { ["actions"] = new JsonArray(new JsonObject { ["name"] = "ScreenQuery", ["steps"] = new JsonArray(query.DeepClone()) }) });
        return query;
    }
    private static void Tree(JsonArray children, string context, HashSet<string> names)
    {
        foreach (var item in children)
        {
            var widget = item as JsonObject ?? throw new ArgumentException("widgets must contain objects");
            Keys(widget, ["name", "type", "properties", "children", "slots", "source", "args", "events", "attributes"], "widget");
            var name = Name(widget["name"]); if (!names.Add(name)) throw new ArgumentException("Widget names must be unique within their screen/block: " + name);
            var shape = Shape(context, Text(widget["type"], "widget type"));
            if(widget["type"]!.ToString() is "IEditRecordWidget" or "IShowRecordWidget")
                foreach(var row in widget["children"] as JsonArray??new JsonArray())
                    if(row?["type"]?.ToString()!="IRowWidget" || row["children"] is not JsonArray {Count:2} cells || cells.Any(c=>c?["type"]?.ToString()!="ICellWidget"))
                        throw new ArgumentException("Legacy Edit/Show Record rows require caption and value cells; incomplete rows do not survive the native O11 merge");
            if (shape["root"]!.GetValue<bool>()) throw new ArgumentException("Screen/block owners cannot be nested as widgets; use a block instance");
            var block = widget["type"]!.ToString().EndsWith("BlockInstanceWidget", StringComparison.Ordinal);
            if (block) NamedReference(widget["source"]); else if (widget.ContainsKey("source") || widget.ContainsKey("args")) throw new ArgumentException("source/args require a block instance");
            Properties(widget, shape); Expressions(widget, "args"); Expressions(widget, "attributes"); Bindings(widget, shape, block);
            if (widget.ContainsKey("children") && shape["children"]?.GetValue<bool>() != true) throw new ArgumentException("This widget uses slots, not children: " + name);
            if (widget["children"] is JsonArray tree) Tree(tree, context, names); else if (widget.ContainsKey("children")) throw new ArgumentException("children must be an array");
            if (widget["slots"] is JsonObject slots)
                foreach (var slot in slots)
                {
                    Name(JsonValue.Create(slot.Key));
                    if (!block && shape["slots"]?[slot.Key] == null) throw new ArgumentException("Unknown widget slot: " + slot.Key);
                    Tree(slot.Value as JsonArray ?? throw new ArgumentException("slot must contain widgets"), context, names);
                }
            else if (widget.ContainsKey("slots")) throw new ArgumentException("slots must be an object");
        }
    }
    internal static void Properties(JsonObject declaration, JsonObject shape)
    {
        if (declaration["properties"] is JsonObject properties)
            foreach (var (key, value) in properties)
            {
                var field = shape["properties"]?[key]?.AsObject() ?? throw new ArgumentException("Unknown UI property: " + key);
                switch (field["kind"]!.ToString())
                {
                    case "boolean": Boolean(value, key); break;
                    case "integer": if (!(value == null && field["nullable"]?.GetValue<bool>() == true) && (value is not JsonValue v || !v.TryGetValue<int>(out _))) throw new ArgumentException(key + " requires an integer"); break;
                    case "reference": NamedReference(value); break;
                    case "enum": if (!field["values"]!.AsArray().Any(v => v!.ToString() == Text(value, key))) throw new ArgumentException("Invalid UI enum " + key); break;
                    default: Text(value, key); break;
                }
            }
        else if (declaration.ContainsKey("properties")) throw new ArgumentException("properties must be an object");
    }
    private static void Bindings(JsonObject declaration, JsonObject shape, bool block)
    {
        if (declaration["events"] is JsonObject events)
            foreach (var (name, value) in events)
            {
                Name(JsonValue.Create(name));
                if (!block && shape["events"]?[name] == null) throw new ArgumentException("Unknown UI event: " + name);
                var binding = value as JsonObject ?? throw new ArgumentException("event binding must be an object");
                Keys(binding, ["destination", "args", "method", "transition", "validation"], "event binding"); NamedReference(binding["destination"]); Expressions(binding, "args");
                foreach (var (key, property) in new[] { ("method", "Method"), ("transition", "Transition") })
                    if (binding.ContainsKey(key) && (shape["events"]?[name] == null || !ApiCatalog.Properties(shape["events"]![name]!.ToString()).Any(p => p["Name"]!.ToString() == property && p["CanWrite"]?.GetValue<bool>() == true)))
                        throw new ArgumentException(name + " does not expose " + key + " in this widget context");
                if (binding.ContainsKey("validation"))
                {
                    var validation=Text(binding["validation"],"event validation");
                    if(validation is not ("None" or "ValidateAndContinue"))throw new ArgumentException("Invalid event validation: "+validation+"; expected None or ValidateAndContinue");
                    var eventType=shape["events"]?[name]?.ToString();
                    if(eventType!="OutSystems.Model.UI.Mobile.Events.IBuiltinEvent" || !ApiCatalog.Properties(eventType).Any(p=>p["Name"]?.ToString()=="BuiltInValidations" && p["CanRead"]?.GetValue<bool>()==true && p["CanWrite"]?.GetValue<bool>()==true))
                        throw new ArgumentException(name+" does not expose writable built-in validation in this widget context");
                }
                if (binding["method"] != null && binding["method"]!.ToString() is not ("Submit" or "Ajax" or "Navigate")) throw new ArgumentException("Invalid event method");
                if (binding["transition"] != null && binding["transition"]!.ToString() is not ("Inherited" or "UseHistory" or "None" or "Fade" or "SlideFromLeft" or "SlideFromRight" or "SlideFromTop" or "SlideFromBottom")) throw new ArgumentException("Invalid navigation transition");
            }
        else if (declaration.ContainsKey("events")) throw new ArgumentException("events must be an object");
    }
    private static void Expressions(JsonObject declaration, string key)
    {
        if (declaration[key] is JsonObject values) foreach (var (name, value) in values) { if (key != "attributes") Name(JsonValue.Create(name)); else if (!Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_-]*$")) throw new ArgumentException("Invalid HTML attribute"); Text(value, key); }
        else if (declaration.ContainsKey(key)) throw new ArgumentException(key + " must be an object");
    }
    private static void Array(JsonObject value, string key) { if (value.ContainsKey(key) && (value[key] is not JsonArray a || a.Any(v => v is not JsonObject))) throw new ArgumentException(key + " must contain declaration objects"); }
    internal static string Name(JsonNode? value) { var name = Text(value, "name"); if (!Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_]*$")) throw new ArgumentException("Invalid UI name: " + name); return name; }
    internal static string NamedReference(JsonNode? value) { var text = Text(value, "reference"); if (!Regex.IsMatch(text, @"^(?:[A-Za-z][A-Za-z0-9_]*\.)*I[A-Za-z0-9_]+:[A-Za-z][A-Za-z0-9_]*(?:/[A-Za-z][A-Za-z0-9_]*)*$")) throw new ArgumentException("UI references must be named; keys and operational paths are forbidden"); return text; }
    internal static string Text(JsonNode? value, string where) => value is JsonValue j && j.TryGetValue<string>(out var text) ? text : throw new ArgumentException(where + " requires text");
    private static void Boolean(JsonNode? value, string where) { if (value is not JsonValue j || !j.TryGetValue<bool>(out _)) throw new ArgumentException(where + " requires a boolean"); }
    internal static void Keys(JsonObject value, IEnumerable<string> allowed, string where) { var unknown = value.Select(p => p.Key).Except(allowed, StringComparer.Ordinal).ToArray(); if (unknown.Length > 0) throw new ArgumentException(where + ": unknown fields " + string.Join(", ", unknown)); }
}
