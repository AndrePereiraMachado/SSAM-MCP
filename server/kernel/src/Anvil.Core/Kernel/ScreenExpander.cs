using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
namespace Anvil.Core;

/// <summary>Closed, deterministic UI archetypes compiled into existing verbs against module-owned signatures.</summary>
public static class ScreenExpander
{
    private static readonly string[] Kinds = ["cards", "table", "detail", "form", "dashboard"];
    private static readonly Dictionary<string, string[]> Shapes = new()
    {
        ["data"] = ["screens"],
        ["screen"] = ["name", "kind", "title", "inputs", "source", "search", "filters", "card", "columns", "tabs", "fields", "actions"],
        ["input"] = ["name", "type", "mandatory", "default"],
        ["source"] = ["entity", "action", "as", "where", "sort", "args", "output", "total"],
        ["search"] = ["field", "label"],
        ["filter"] = ["field", "from", "label"],
        ["card"] = ["title", "description", "price", "rating", "image", "destination", "args", "layout"],
        ["column"] = ["field", "label"],
        ["field"] = ["field", "label", "kind", "readonly"],
        ["metric"] = ["label", "value"],
        ["tab"] = ["title", "fields"],
        ["action"] = ["name", "label", "destination", "call", "args"],
    };
    public static JsonObject Schema() => new()
    {
        ["kinds"] = new JsonArray(Kinds.Select(k => (JsonNode)k).ToArray()),
        ["shapes"] = new JsonObject(Shapes.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)new JsonArray(p.Value.Select(k => (JsonNode)k).ToArray())))),
    };

    public static List<JsonObject> Expand(JsonObject data, Func<string[], string?> tryRef,
        Func<string, ScreenContract?> contract, string runtime)
    {
        if (runtime is not ("CrossDevice" or "Reactive" or "Mobile")) throw Error("only Reactive and Mobile screens are supported");
        Keys(data, "data"); var screens = Objects(data, "screens");
        if (screens.Count == 0) throw Error("screens must not be empty");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in screens)
        {
            Keys(s, "screen");
            foreach (var key in new[] { "source", "search", "card" })
                if (s.ContainsKey(key) && s[key] is not JsonObject) throw Error($"{key} must be an object");
            if (s["source"] is JsonObject source && source.ContainsKey("sort") && source["sort"] is not JsonArray) throw Error("source.sort must be an array");
            var name = Required(s, "name");
            if (!names.Add(name)) throw Error($"duplicate screen '{name}'");
            if (tryRef(["IMobileScreen:" + name]) != null) throw Error($"screen '{name}' already exists; edit its job or use verbs to change the existing screen");
            if (!Kinds.Contains(Required(s, "kind"))) throw Error($"unknown kind '{s["kind"]}'; allowed: {string.Join(", ", Kinds)}");
            var kind = Required(s, "kind");
            var contentKeys = kind switch { "cards" => new[] { "card" }, "table" => ["columns"], "detail" => ["fields", "tabs"], "form" => ["fields"], _ => ["fields", "card"] };
            foreach (var key in new[] { "card", "columns", "tabs", "fields" })
                if (s.ContainsKey(key) && !contentKeys.Contains(key)) throw Error($"{kind} does not use '{key}'");
            if (kind == "detail" && Objects(s,"fields").Count + Objects(s,"tabs").Count == 0) throw Error("detail requires fields or tabs");
            if (kind is "form" or "dashboard" && Objects(s,"fields").Count == 0) throw Error($"{kind} requires fields");
            CheckInputs(s);
        }
        var ops = new List<JsonObject>();
        var contexts = screens.Select(s => new Compiler(s, screens, ops, tryRef, contract, runtime == "Mobile")).ToArray();
        // Every screen and input exists before any destination is assigned.
        foreach (var compiler in contexts) compiler.Declare();
        foreach (var compiler in contexts) compiler.Content();
        return ops;
    }

    private sealed class Compiler(JsonObject screen, IReadOnlyList<JsonObject> screens, List<JsonObject> ops,
        Func<string[], string?> tryRef, Func<string, ScreenContract?> contracts, bool mobile)
    {
        private readonly string name = Required(screen, "name"), kind = Required(screen, "kind");
        private readonly Dictionary<string, int> counts = new(StringComparer.Ordinal);
        private string Root => "$screen." + name;
        private string Main => Root + "/#IMobileBlockInstanceWidget/" + (mobile ? "Content" : "MainContent");
        private string dataAlias = "", list = "", current = "", count = "";
        private string? actionsParent;
        private bool formDefault;
        private IReadOnlyList<UiParam> fields = [];
        private bool Paged => kind is "cards" or "table";
        private string Alias(string suffix) => Root + "." + suffix;
        private string Next(string prefix) { counts.TryGetValue(prefix, out var n); counts[prefix] = ++n; return prefix + n; }
        private string Ref(params string[] candidates) => tryRef(candidates) ?? throw Error($"{name}: reference not found: {string.Join(" or ", candidates)}");
        private ScreenContract Contract(string reference) => contracts(reference) ?? throw Error($"{name}: public signature is unavailable: {reference}");
        private void Add(string op, params (string, object?)[] values)
        {
            var node = new JsonObject { ["op"] = op };
            foreach (var (key, value) in values) node[key] = value is JsonNode json ? json.DeepClone() : System.Text.Json.JsonSerializer.SerializeToNode(value);
            ops.Add(node);
        }
        private void Set(string target, string prop, object value) => Add("set", ("target", target), ("prop", prop), ("value", value));
        private string Create(string parent, string type, string? nodeName = null, string? alias = null)
        {
            alias ??= Alias(Next("node"));
            Add("create", ("parent", parent), ("type", type), ("name", nodeName), ("as", alias)); return alias;
        }
        private void Expression(string parent, string text) { var e = Create(parent, "IExpression"); Set(e, "Value", text); }
        private void Variable(string variable, string type, string? value = null)
        {
            var a = Create(Root, "ILocalVariable", variable); Set(a, "DataType", type); if (value != null) Set(a, "DefaultValue", value);
        }
        private string Field(string field)
        {
            var found = fields.FirstOrDefault(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase))
                ?? throw Error($"{name}: field '{field}' does not exist; available: {string.Join(", ", fields.Select(f => f.Name))}");
            return current + "." + found.Name;
        }
        private string Block(string parent, string blockName, IReadOnlyDictionary<string, string>? inputs = null, bool empty = false,
            IReadOnlySet<string>? handledEvents = null)
        {
            var reference = Ref("IMobileBlock:" + blockName); var c = Contract(reference);
            inputs ??= new Dictionary<string, string>();
            foreach (var input in inputs.Keys)
                if (!c.Inputs.Any(p => p.Name == input)) throw Error($"block {blockName} has no input '{input}'; available: {string.Join(", ", c.Inputs.Select(p => p.Name))}");
            foreach (var input in c.Inputs.Where(p => p.Mandatory && string.IsNullOrEmpty(p.Default)))
                if (!inputs.ContainsKey(input.Name)) throw Error($"block {blockName} requires input '{input.Name}'");
            foreach (var ev in c.Events.Where(e => e.Mandatory))
                if (handledEvents?.Contains(ev.Name) != true) throw Error($"block {blockName} requires handler '{ev.Name}'");
            var nodeName = Next(blockName); var alias = Alias(nodeName);
            Add("create", ("parent", parent), ("type", "IMobileBlockInstanceWidget"), ("name", nodeName), ("as", alias), ("source", reference), ("empty", empty));
            foreach (var input in inputs) Set(alias + "/" + input.Key, "Value", input.Value);
            return alias;
        }
        private string Placeholder(string block, string blockName, string placeholder)
        {
            if (!Contract(Ref("IMobileBlock:" + blockName)).Placeholders.Any(p => p.Name == placeholder)) throw Error($"{blockName} has no placeholder '{placeholder}'");
            return block + "/" + placeholder;
        }
        public void Declare()
        {
            Create(Ref("IMobileFlow:MainFlow"), "IMobileScreen", name, Root);
            var layout = mobile ? "Layout" : "LayoutTopMenu";
            var placeholder = mobile ? "Content" : "MainContent";
            // Without its content placeholder the screen's widgets would land outside the layout: refused with the exact paths.
            var layoutContract = Contract(Ref("IMobileBlock:" + layout));
            if (!layoutContract.Placeholders.Any(p => p.Name == placeholder))
                throw Error($"layout {layout} has no content placeholder {placeholder}; placeholders: {string.Join(", ", layoutContract.Placeholders.Select(p => Root + "/#IMobileBlockInstanceWidget/" + p.Name))}");
            Set(Root + "/#IMobileBlockInstanceWidget", "SourceBlock", layoutContract.Reference);
            foreach (var input in Objects(screen, "inputs"))
            {
                Keys(input, "input"); var a = Create(Root, "IInputParameter", Required(input, "name")); Set(a, "DataType", Required(input, "type"));
                Set(a, "IsMandatory", input["mandatory"]?.GetValue<bool>() ?? false);
                if (input["default"] != null) Set(a, "DefaultValue", input["default"]!.GetValue<string>());
            }
            Expression(Root + "/#IMobileBlockInstanceWidget/Title", Quote(screen["title"]?.GetValue<string>() ?? name));
        }
        public void Content()
        {
            var source = screen["source"]?.AsObject() ?? throw Error($"{name}: source is required"); Keys(source, "source");
            if (Paged) { Variable("StartIndex", "Integer", "0"); Variable("MaxRecords", "Integer", "20"); }
            if (screen["search"] is JsonObject search) { Keys(search, "search"); Variable("SearchText", "Text"); }
            var filters = Objects(screen, "filters");
            foreach (var filter in filters)
            {
                Keys(filter, "filter"); var from = Required(filter, "from"); Ref("IStaticEntity:" + from);
                Variable("Filter_" + Required(filter, "field"), from + " Identifier");
            }
            Source(source, filters);
            if ((screen["search"] != null || filters.Count > 0) && source["entity"] == null)
                throw Error($"{name}: search/filters require an entity source; pass explicit action arguments for action sources");
            if (screen["search"] is JsonObject searchBox) Search(searchBox);
            foreach (var filter in filters) Filter(filter);
            switch (kind)
            {
                case "cards": Cards(Main, screen["card"]?.AsObject() ?? throw Error($"{name}: card is required")); break;
                case "table": Table(); break;
                case "detail": Detail(); break;
                case "form": Form(); break;
                case "dashboard": Dashboard(); break;
            }
            if (Paged) Pagination();
            foreach (var action in Objects(screen, "actions")) Button(actionsParent ?? Main, action);
        }
        private void Source(JsonObject source, IReadOnlyList<JsonObject> filters)
        {
            if ((source["entity"] != null) == (source["action"] != null)) throw Error($"{name}: source requires exactly one of entity/action");
            var asName = Required(source, "as"); dataAlias = Alias("source");
            if (source["entity"] is JsonValue entityValue)
            {
                if (source["args"] != null || source["output"] != null || source["total"] != null) throw Error("entity source does not accept args/output/total");
                var entity = entityValue.GetValue<string>(); var reference = Ref("IServerEntity:" + entity, "IStaticEntity:" + entity, "IEntitySignature:" + entity);
                fields = Contract(reference).Fields; list = asName + ".List"; current = list + ".Current." + entity; count = asName + ".Count";
                Create(Root, "IScreenAggregate", asName, dataAlias);
                Add("create", ("parent", dataAlias), ("type", "IAliasedSource"), ("args", new JsonObject { ["dataSource"] = reference }));
                if (Paged) { Set(dataAlias, "StartIndex", "StartIndex"); Set(dataAlias, "MaxRecords", "MaxRecords"); }
                else if (kind is "detail" or "form") Set(dataAlias, "MaxRecords", "1");
                foreach (var where in Texts(source["where"])) Where(where);
                if (source["sort"] is JsonArray sorts)
                    foreach (var item in sorts)
                    {
                        var sort = item!.AsArray(); if (sort.Count != 2) throw Error("source.sort entries are [expression, Ascending|Descending]");
                        if (sort[1]?.GetValue<string>() is not ("Ascending" or "Descending")) throw Error("sort direction must be Ascending or Descending");
                        var a = Create(dataAlias, "ISort"); Set(a, "Attribute", sort[0]!.GetValue<string>()); Set(a, "SortDirection", sort[1]!.GetValue<string>());
                    }
                if (screen["search"] is JsonObject search)
                {
                    var f = Required(search, "field"); Field(f);
                    if (!fields.Any(p => p.Name.Equals(f, StringComparison.OrdinalIgnoreCase) && p.Type == "Text")) throw Error("search.field must be a Text attribute");
                    Where(entity + "." + f + " like \"%\" + SearchText + \"%\"");
                }
                foreach (var filter in filters)
                {
                    var f = Required(filter, "field"); Field(f);
                    var from = Required(filter, "from");
                    if (!fields.Any(p => p.Name.Equals(f, StringComparison.OrdinalIgnoreCase) && p.Type.Equals(from + " Identifier", StringComparison.OrdinalIgnoreCase))) throw Error($"{name}: {f} must have type {from} Identifier");
                    Where($"Filter_{f} = NullIdentifier() or {entity}.{f} = Filter_{f}");
                }
            }
            else
            {
                if (source["where"] != null || source["sort"] != null) throw Error("action source takes args, not where/sort");
                var action = Required(source, "action"); var reference = Ref("IServerAction:" + action, "IServiceAction:" + action);
                var signature = Contract(reference); var output = source["output"]?.GetValue<string>()
                    ?? (signature.Outputs.Count(p => p.Type.EndsWith(" List", StringComparison.Ordinal)) == 1 ? signature.Outputs.Single(p => p.Type.EndsWith(" List", StringComparison.Ordinal)).Name : throw Error("action source requires output naming a list"));
                var outputParameter = signature.Outputs.FirstOrDefault(p => p.Name == output && p.Type.EndsWith(" List", StringComparison.Ordinal)) ?? throw Error($"{action}.{output} is not a list output");
                fields = signature.OutputFields[output]; list = asName + "." + output; current = list + ".Current";
                var args = source["args"]?.AsObject() ?? new(); CheckArgs(signature, args);
                if (Paged && (!args.Any(p => p.Value?.ToString() == "StartIndex") || !args.Any(p => p.Value?.ToString() == "MaxRecords")))
                    throw Error("paged action source args must pass StartIndex and MaxRecords");
                Create(Root, "IDataAction", asName, dataAlias); Add("delete", ("target", dataAlias + "/Out1"));
                var outNode = Create(dataAlias, "IOutputParameter", output); Set(outNode, "DataType", outputParameter.Type);
                var start = Create(dataAlias, "IStartNode"); var call = Create(dataAlias, "IExecuteServerActionNode", "ReadSource"); Set(call, "Action", reference);
                foreach (var arg in args) Set(call + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                var assignments = new Dictionary<string, string> { [output] = "ReadSource." + output };
                if (Paged || source["total"] != null)
                {
                    var total = Required(source, "total"); var totalParameter = signature.Outputs.FirstOrDefault(p => p.Name == total && p.Type is "Integer" or "Long Integer") ?? throw Error("action source.total must name an integer output with the full row count");
                    var totalNode = Create(dataAlias, "IOutputParameter", total); Set(totalNode, "DataType", totalParameter.Type);
                    assignments[total] = "ReadSource." + total; count = asName + "." + total;
                }
                var assign = Assign(dataAlias, assignments); var end = Create(dataAlias, "IEndNode");
                Link(start, call); Link(call, assign); Link(assign, end); Add("layout", ("target", dataAlias));
            }
        }
        private void Where(string text) => Add("create", ("parent", dataAlias), ("type", "IFilter"), ("args", new JsonObject { ["condition"] = text }));
        private void Search(JsonObject search)
        {
            var block = Block(Main, "Search"); var input = Placeholder(block, "Search", "Input") + "/#IInput";
            Set(input, "Variable", "SearchText");
            if (search["label"] is JsonValue label) Set(input, "Prompt", Quote(label.GetValue<string>()));
            var action = RefreshAction("SearchChanged", Paged ? new Dictionary<string, string> { ["StartIndex"] = "0" } : new());
            Set(input + "/OnChange", "Destination", action);
        }
        private void Filter(JsonObject filter)
        {
            var from = Required(filter, "from"); var field = Required(filter, "field");
            var aggName = "Options_" + field; var agg = Create(Root, "IScreenAggregate", aggName);
            Add("create", ("parent", agg), ("type", "IAliasedSource"), ("args", new JsonObject { ["dataSource"] = Ref("IStaticEntity:" + from) }));
            var input = Create(Main, "IDropdown", "Filter" + field); Set(input, "List", aggName + ".List");
            Set(input, "Values", from + ".Id"); Set(input, "Labels", from + ".Label"); Set(input, "Variable", "Filter_" + field);
            Set(input, "EmptyValue", Quote(filter["label"]?.GetValue<string>() ?? "All"));
            Set(input + "/OnChange", "Destination", RefreshAction("Filter" + field + "Changed", Paged ? new Dictionary<string, string> { ["StartIndex"] = "0" } : new()));
        }
        private void Cards(string parent, JsonObject card)
        {
            Keys(card, "card"); var layout = card["layout"]?.GetValue<string>() ?? "gallery";
            if (layout is not ("gallery" or "carousel")) throw Error("card.layout must be gallery or carousel");
            var blockName = layout == "gallery" ? "Gallery" : "Carousel"; var placeholder = layout == "gallery" ? "Content" : "CarouselItems";
            var block = Block(parent, blockName); var listParent = Placeholder(block, blockName, placeholder) + "/#IList";
            var blockContract = Contract(Ref("IMobileBlock:" + blockName));
            if (!blockContract.ListChildren.TryGetValue(placeholder, out var defaults)) throw Error($"{blockName}.{placeholder} must expose exactly one default List");
            foreach (var type in defaults) Add("delete", ("target", listParent + "/**" + type));
            Set(listParent, "Source", list);
            var section = Block(listParent, "CardSectioned");
            Expression(Placeholder(section, "CardSectioned", "Title"), Field(Required(card, "title")));
            if (card["description"] != null) Expression(Placeholder(section, "CardSectioned", "Content"), Field(card["description"]!.GetValue<string>()));
            if (card["price"] != null) Expression(Placeholder(section, "CardSectioned", "Footer"), Field(card["price"]!.GetValue<string>()));
            if (card["rating"] != null) Block(Placeholder(section, "CardSectioned", "Footer"), "Rating", new Dictionary<string,string> { ["RatingValue"] = Field(card["rating"]!.GetValue<string>()) });
            if (card["image"] != null)
            {
                var image = Create(Placeholder(section, "CardSectioned", "Image"), "IImage"); Set(image, "Type", "External"); Set(image, "Url", Field(card["image"]!.GetValue<string>()));
            }
            if (card["destination"] != null)
                Button(Placeholder(section, "CardSectioned", "Footer"), new JsonObject { ["name"] = "OpenDetails", ["label"] = "View details", ["destination"] = card["destination"]!.DeepClone(), ["args"] = card["args"]?.DeepClone() ?? new JsonObject() });
            else if (card["args"] != null) throw Error("card.args requires destination");
        }
        private void Table()
        {
            if (screen["card"] != null) throw Error("table uses columns, not card");
            var columns = Objects(screen, "columns"); if (columns.Count == 0) throw Error("table requires columns");
            var table = Create(Main, "ITableRecords", "Table1"); Set(table, "Source", list);
            foreach (var column in columns)
            {
                Keys(column, "column"); var field = Required(column, "field");
                Expression(Create(table + "/HeaderRow", "IHeaderCell"), Quote(column["label"]?.GetValue<string>() ?? field));
                Expression(Create(table + "/Row", "IRowCell"), Field(field));
            }
        }
        private void Detail()
        {
            var card = Block(Main, "CardSectioned");
            if (Objects(screen, "fields").Count > 0) ShowFields(Placeholder(card, "CardSectioned", "Content"), Objects(screen, "fields"), false);
            var tabs = Objects(screen, "tabs");
            if (tabs.Count == 0) return;
            var block = Block(Placeholder(card, "CardSectioned", "Content"), "Tabs", empty:true);
            foreach (var tab in tabs)
            {
                Keys(tab, "tab"); var header = Block(Placeholder(block, "Tabs", "Header"), "TabsHeaderItem");
                Expression(Placeholder(header, "TabsHeaderItem", "Title"), Quote(Required(tab, "title")));
                var body = Block(Placeholder(block, "Tabs", "Content"), "TabsContentItem");
                ShowFields(Placeholder(body, "TabsContentItem", "Content"), Objects(tab, "fields"), false);
            }
        }
        private void Form()
        {
            var card = Block(Main, "CardSectioned"); var form = Create(Placeholder(card, "CardSectioned", "Content"), "IForm", "Form1");
            actionsParent = form;
            ShowFields(form, Objects(screen, "fields"), true);
        }
        private void ShowFields(string parent, IReadOnlyList<JsonObject> rows, bool edit)
        {
            foreach (var row in rows)
            {
                Keys(row, "field"); var field = Required(row, "field"); var value = Field(field);
                if (!edit && (row.ContainsKey("kind") || row.ContainsKey("readonly"))) throw Error("detail fields do not accept kind/readonly; use a form for editing");
                var box = Create(parent, "IContainer");
                if (!edit || row["readonly"]?.GetValue<bool>() == true) { Expression(box, Quote(row["label"]?.GetValue<string>() ?? field)); Expression(box, value); continue; }
                var label = Create(box, "ILabel"); Set(label + "/#ITextWidget", "Text", row["label"]?.GetValue<string>() ?? field);
                var type = fields.Single(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase)).Type;
                var fieldKind = row["kind"]?.GetValue<string>() ?? (type == "Boolean" ? "checkbox" : "input");
                var widget = fieldKind switch { "input" => "IInput", "textarea" => "ITextArea", "checkbox" => "ICheckbox", _ => throw Error("field.kind must be input, textarea or checkbox") };
                var input = Create(box, widget, "Edit" + field); Set(input, "Variable", value); Set(label, "TargetWidget", input);
                if (widget != "ICheckbox" && fields.Single(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase)).Mandatory) Set(input, "Mandatory", "True");
            }
        }
        private void Dashboard()
        {
            foreach (var metric in Objects(screen, "fields"))
            {
                Keys(metric, "metric"); var card = Block(Main, "CardSectioned");
                Expression(Placeholder(card, "CardSectioned", "Title"), Quote(Required(metric, "label")));
                var counter = Block(Placeholder(card, "CardSectioned", "Content"), "Counter");
                Expression(Placeholder(counter, "Counter", "Content"), Required(metric, "value"));
            }
            if (screen["card"] is JsonObject carousel) Cards(Main, carousel);
        }
        private void Pagination()
        {
            var signature = Contract(Ref("IMobileBlock:Pagination"));
            var ev = signature.Events.SingleOrDefault(e => e.Name == "OnNavigate") ?? throw Error("Pagination signature has no OnNavigate event");
            if (ev.Params.Count != 1 || ev.Params[0].Name != "NewStartIndex") throw Error("Pagination.OnNavigate signature changed; expected NewStartIndex");
            var block = Block(Main, "Pagination", new Dictionary<string,string> { ["StartIndex"] = "StartIndex", ["MaxRecords"] = "MaxRecords", ["TotalCount"] = count }, handledEvents:new HashSet<string> { "OnNavigate" });
            var handler = RefreshAction("OnNavigate", new Dictionary<string,string> { ["StartIndex"] = "NewStartIndex" }, ev.Params);
            Set(block + "/OnNavigate", "Handler", handler); Set(block + "/OnNavigate/NewStartIndex", "Value", "NewStartIndex");
        }
        private string RefreshAction(string actionName, IReadOnlyDictionary<string,string> assignments, IReadOnlyList<UiParam>? inputs = null)
        {
            var action = Create(Root, "IScreenAction", actionName);
            foreach (var input in inputs ?? []) { var p = Create(action, "IInputParameter", input.Name); Set(p, "DataType", input.Type); }
            var start = Create(action, "IStartNode"); var tail = start;
            if (assignments.Count > 0) { var assign = Assign(action, assignments); Link(tail, assign); tail = assign; }
            var refresh = Create(action, "IRefreshDataNode", "RefreshData"); Set(refresh, "DataSource", dataAlias); Link(tail, refresh);
            var end = Create(action, "IEndNode"); Link(refresh, end); Add("layout", ("target", action)); return action;
        }
        private string Assign(string action, IReadOnlyDictionary<string,string> values)
        {
            var assign = Create(action, "IAssignNode"); Set(assign, "Label", "SetValues");
            foreach (var pair in values) { var item = Create(assign, "IAssignment"); Set(item, "Variable", pair.Key); Set(item, "Value", pair.Value); }
            return assign;
        }
        private void Link(string from, string to) => Add("link", ("from", from), ("to", to));
        private void Button(string parent, JsonObject action)
        {
            Keys(action, "action"); var button = Create(parent, "IButton", Required(action, "name"));
            Set(button + "/#ITextWidget", "Text", action["label"]?.GetValue<string>() ?? Required(action, "name"));
            var args = action["args"]?.AsObject() ?? new();
            if ((action["destination"] != null) == (action["call"] != null)) throw Error("action requires exactly one of destination/call");
            if (action["destination"] is JsonValue destination)
            {
                var targetName = destination.GetValue<string>(); var target = screens.FirstOrDefault(s => Required(s, "name").Equals(targetName, StringComparison.OrdinalIgnoreCase));
                var reference = target == null ? Ref("IMobileScreen:" + targetName) : "$screen." + Required(target, "name");
                var inputs = target == null ? Contract(reference).Inputs : Objects(target, "inputs").Select(p => new UiParam(Required(p,"name"), Required(p,"type"), p["mandatory"]?.GetValue<bool>() ?? false,p["default"]?.GetValue<string>(),null)).ToArray();
                CheckArgs(inputs, args); Set(button + "/OnClick", "Destination", reference);
                foreach (var arg in args) Set(button + "/OnClick/" + arg.Key, "Value", arg.Value!.GetValue<string>());
            }
            else
            {
                var callName = Required(action, "call"); var reference = Ref("IServerAction:" + callName, "IServiceAction:" + callName, "IClientAction:" + callName);
                CheckArgs(Contract(reference), args);
                var handler = Create(Root, "IScreenAction", Required(action, "name") + "Handler"); var start = Create(handler, "IStartNode");
                var call = Create(handler, reference.Contains("ClientAction", StringComparison.Ordinal) ? "IExecuteClientActionNode" : "IExecuteServerActionNode", callName); Set(call, "Action", reference);
                foreach (var arg in args) Set(call + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                var refresh = Create(handler, "IRefreshDataNode", "RefreshData"); Set(refresh, "DataSource", dataAlias);
                var end = Create(handler, "IEndNode");
                if (kind == "form")
                {
                    Set(button + "/OnClick", "BuiltInValidations", "ValidateAndContinue");
                    if (!formDefault) { Set(button, "IsDefault", true); formDefault = true; }
                    var valid = Create(handler, "IIfNode"); Set(valid, "Condition", "Form1.Valid"); Link(start, valid);
                    Add("link", ("from", valid), ("connector", "TrueTarget"), ("to", call));
                    Add("link", ("from", valid), ("connector", "FalseTarget"), ("to", end));
                }
                else Link(start, call);
                Link(call, refresh); Link(refresh, end); Add("layout", ("target", handler));
                Set(button + "/OnClick", "Destination", handler);
            }
        }
        private static void CheckArgs(ScreenContract contract, JsonObject args) => CheckArgs(contract.Inputs, args);
        private static void CheckArgs(IReadOnlyList<UiParam> inputs, JsonObject args)
        {
            foreach (var arg in args)
                if (!inputs.Any(p => p.Name.Equals(arg.Key, StringComparison.OrdinalIgnoreCase))) throw Error($"unknown argument '{arg.Key}'; available: {string.Join(", ", inputs.Select(p => p.Name))}");
            foreach (var input in inputs.Where(p => p.Mandatory && string.IsNullOrEmpty(p.Default)))
                if (!args.Any(p => p.Key.Equals(input.Name, StringComparison.OrdinalIgnoreCase))) throw Error($"missing required argument '{input.Name}'");
        }
    }
    private static void CheckInputs(JsonObject screen)
    {
        var expressions = new List<string>();
        if (screen["source"] is JsonObject source)
        {
            expressions.AddRange(Texts(source["where"]));
            if (source["args"] is JsonObject args) expressions.AddRange(args.Select(p => p.Value!.GetValue<string>()));
            if (source["sort"] is JsonArray sorts) expressions.AddRange(sorts.Select(s => s![0]!.GetValue<string>()));
        }
        foreach (var action in Objects(screen, "actions")) if (action["args"] is JsonObject args) expressions.AddRange(args.Select(p => p.Value!.GetValue<string>()));
        if (screen["card"]?["args"] is JsonObject cardArgs) expressions.AddRange(cardArgs.Select(p => p.Value!.GetValue<string>()));
        if (screen["kind"]?.ToString() == "dashboard") expressions.AddRange(Objects(screen, "fields").Select(f => Required(f,"value")));
        var text = Regex.Replace(string.Join(" ", expressions), "\"(?:[^\"]|\"\")*\"", "\"\"");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (screen["source"]?["as"] is JsonValue sourceName) reserved.Add(sourceName.GetValue<string>());
        if (screen["kind"]?.ToString() is "cards" or "table") { reserved.Add("StartIndex"); reserved.Add("MaxRecords"); }
        if (screen["search"] != null) reserved.Add("SearchText");
        foreach (var filter in Objects(screen,"filters")) reserved.Add("Filter_" + Required(filter,"field"));
        foreach (var input in Objects(screen, "inputs"))
        {
            Keys(input,"input"); var name = Required(input,"name");
            if (reserved.Contains(name)) throw Error($"screen input '{name}' conflicts with generated source/pagination/filter state");
            if (!seen.Add(name)) throw Error($"duplicate screen input '{name}'");
            if (!Regex.IsMatch(text, @"(?<![\w.])" + Regex.Escape(name) + @"(?![\w])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                throw Error($"screen {screen["name"]}: input '{name}' declared and never used");
        }
    }
    private static string Quote(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
    private static string Required(JsonObject o, string key) => o[key]?.GetValue<string>() is { Length: > 0 } value ? value : throw Error($"missing '{key}'");
    private static List<JsonObject> Objects(JsonObject o, string key) => o[key]?.AsArray().Select(n => n!.AsObject()).ToList() ?? [];
    private static IEnumerable<string> Texts(JsonNode? node) => node == null ? [] : node is JsonArray array ? array.Select(n => n!.GetValue<string>()) : [node.GetValue<string>()];
    private static void Keys(JsonObject o, string shape)
    {
        var unknown = o.Select(p => p.Key).Except(Shapes[shape], StringComparer.Ordinal).ToArray();
        if (unknown.Length > 0) throw Error($"unknown {shape} keys: {string.Join(", ", unknown)}; allowed: {string.Join(", ", Shapes[shape])}");
    }
    private static InvalidOperationException Error(string message) => new("screen: " + message);
}
