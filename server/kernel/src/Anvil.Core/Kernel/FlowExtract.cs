using System.Collections;

namespace Anvil.Reading;

// What ssam-flow/1 leaves out of an action, by rule (closed lists; every value a rule leaves out is counted by rule in
// ModuleFlow.NotWritten, and the corpus test checks every element and property):
//  - noise: ModelReader's and the rich index's bookkeeping (keys, owners, positions, validity, descriptors);
//  - structure: connectors (they are the edges), lists that repeat the element's own children or descendants, the
//    operation tree of an aggregate, the ODC implicit parameters an aggregate infers from its filters;
//  - derived: what the Model API computes from authored properties (the Type of a parameter from its DataType, the output
//    Type of an aggregate or SQL, the type of an aggregate column, ConcreteParameterType of a generic argument,
//    NodesWithinCycle, SourceOperation), and duplicates (IsFunction = Function, Shareable = Public, the ODC comment's
//    Comment = Text) when they agree;
//  - editor state: AttributesInPreview (the columns the aggregate editor previews);
//  - defaults: a value equal to the property's default (False for a boolean unless listed below). The defaults are the
//    values both Studios give a new element of each kind (measured 2026-10-11 by creating every node kind, parameter and
//    action headless: every boolean is False but IsMandatory, AbortTransaction and LogError, and a service action's
//    Public and Shareable, which the text always states).
// Everything else an element holds is a property of the text: with a word of its own, or as @{Name=value}.
internal static class FlowRules
{
    public static readonly string[] EdgeNames = ["Target", "TrueTarget", "FalseTarget", "CycleTarget", "OtherwiseTarget"];
    public static readonly HashSet<string> ValueKinds = new(StringComparer.Ordinal) {
        "Expression", "TextBasedExpression", "TypeConversionExpression", "RecordLiteralExpression", "RecordLiteralField", "ListLiteralExpression",
        "ListLiteralItem", "ImplicitParameter" };
    public static readonly HashSet<string> Lifecycle = new(StringComparer.Ordinal) { "OnInitialize", "OnReady", "OnRender", "OnParametersChanged", "OnDestroy", "OnAfterFetch" };
    // Written as edges and items (connectors, the lists of the element's own parameters), or bookkeeping.
    private static readonly HashSet<string> Structural = new(StringComparer.Ordinal) {
        "Target", "TrueTarget", "FalseTarget", "CycleTarget", "OtherwiseTarget", "Connectors", "InputParameters", "OutputParameters", "LocalVariables",
        // The ODC Model API's undo bookkeeping, the same object on every element.
        "TransactionsManager" };
    // Not written, with the reason; ModuleFlow counts every value each rule leaves out (notWritten).
    private static readonly Dictionary<string, string> Unwritten = new(StringComparer.Ordinal) {
        ["NodesWithinCycle"] = "derived from the connectors", ["ConcreteParameterType"] = "derived from the argument",
        ["SourceOperation"] = "aggregate operation tree", ["AttributesInPreview"] = "aggregate editor preview" };
    private static readonly Dictionary<string, Dictionary<string, string>> UnwrittenByKind = new(StringComparer.Ordinal) {
        ["InputParameter"] = new() { ["Type"] = "derived from DataType" }, ["OutputParameter"] = new() { ["Type"] = "derived from DataType" },
        ["LocalVariable"] = new() { ["Type"] = "derived from DataType" }, ["SQLInputParameter"] = new() { ["Type"] = "derived from DataType" },
        ["AggregateNode"] = new() { ["Type"] = "derived output type", ["RootOperation"] = "aggregate operation tree" },
        ["SQLNode"] = new() { ["Type"] = "derived output type" },
        ["AggregateAttribute"] = new() { ["DataType"] = "derived column type" }, ["CalculatedAttribute"] = new() { ["DataType"] = "derived column type" } };
    // Defaults that are not False/empty (values the Model API gives a new element).
    private static readonly Dictionary<string, string> Defaults = new(StringComparer.Ordinal) {
        ["AnimationEffect"] = "None", ["Transition"] = "Inherited", ["DateFormat"] = "ISO", ["Fetch"] = "AtStart", ["SortDirection"] = "Ascending",
        ["IsMandatory"] = "True", ["AbortTransaction"] = "True", ["LogError"] = "True" };

    public static bool Skip(string property) =>
        ModelReader<object>.IsNoise(property) || ModuleRichIndex.Skipped.Contains(property) || Structural.Contains(property);

    // Why a property is not written (null: it is written).
    public static string? NotWritten(string kind, string property) =>
        UnwrittenByKind.TryGetValue(kind, out var byKind) && byKind.TryGetValue(property, out var reason) ? reason : Unwritten.GetValueOrDefault(property);

    // A new service action is public and shareable (ODC and O11): neither value is a default, so a False is never lost and
    // a True is the header's "public".
    private static readonly HashSet<(string Kind, string Property)> Stated = [("ServiceAction", "Public"), ("ServiceAction", "Shareable")];

    // Values the text shows but the platform computes (no setter): IsAsynchronous follows from the script ($resolve). The
    // way back never writes them; a text that changes one without what it follows from is refused (FlowDiff).
    private static readonly Dictionary<(string Kind, string Property), string> Computed = new() { [("JavaScriptNode", "IsAsynchronous")] = "JavaScript" };
    public static string? ComputedFrom(string kind, string property) => Computed.GetValueOrDefault((kind, property));

    // Call=Client|Server on a call whose callee's name two actions share, when the node is not the kind its flow picks by
    // default (a client flow calls the client action, a server flow the server one): the kind of the Execute node (never a
    // property of the model: FlowDiff reads it to choose the callee and the node, and never writes it).
    public const string CallProperty = "Call";

    public static bool IsDefault(string kind, string property, FlowValue value) =>
        !Stated.Contains((kind, property))
        && (Defaults.TryGetValue(property, out var known) ? value.Text == known : value.Type == 'v' && value.Text == "False");

    // The value a property left out of the text has (FlowDiff writes it when the text removes a value): the listed default,
    // False for a boolean, null when the property has no default (a number or enum without one, a Stated property).
    public static string? DefaultText(string kind, string property, string current) =>
        Stated.Contains((kind, property)) ? null
        : Defaults.TryGetValue(property, out var known) ? known
        : current is "True" or "False" ? "False" : null;

    // Execute*ActionNode: the concrete kind follows from the action it calls.
    public static string NodeKind(string kind) => kind.StartsWith("Execute", StringComparison.Ordinal) && kind.EndsWith("ActionNode", StringComparison.Ordinal) ? "Execute" : kind;
}

// Reads one action of a loaded module into the canonical model. Every element below the action is claimed (as the action,
// a parameter, a node, a part, a value carrier or structure); an element nobody claims, a child of a kind the reader does
// not know and a property read error are problems of that action, so nothing is left out silently.
internal sealed class FlowExtractor<T>(ModelReader<T> reader, T root) where T : class
{
    private readonly HashSet<T> claimed = new(ReferenceEqualityComparer.Instance);
    private List<string> problems = [];
    private bool clientFlow;
    // The node being read: a problem found while reading it is that node's (it becomes opaque), not the action's.
    private T? scope;
    private readonly Dictionary<T, List<string>> nodeProblems = new(ReferenceEqualityComparer.Instance);

    private void Problem(string problem)
    {
        if (scope == null) problems.Add(problem);
        else (nodeProblems.TryGetValue(scope, out var list) ? list : nodeProblems[scope] = []).Add(problem);
    }

    // The action under its own name; where it lives (Flow/Screen) is the caller's (ModuleFlow names the entry with it).
    // A problem of one node (a part, value or property its reader cannot carry) makes that node opaque: it keeps its name,
    // key and connectors, is written "opaque <Kind>" and is never written back; the action's own problems stay problems.
    public FlowItem Action(T action, out List<string> found)
    {
        claimed.Clear(); problems = []; nodeProblems.Clear(); scope = null;
        // The kind of call a name two actions share reads as by default in this flow (ModelSession.Callee's rule).
        clientFlow = reader.IsKind(action, "IClientAction") || reader.IsKind(action, "OutSystems.Model.UI.Mobile.IScreenAction");
        var item = new FlowItem("action", reader.KindOf(action), reader.KeyOf(action), reader.DisplayOf(action));
        // A screen, block or data action names its owner in the header (FlowOwners.Text).
        if (FlowOwners.Owned(item.Kind) && reader.ParentOf(action) is { } holder && !ReferenceEquals(holder, root)) item.Owner = FlowOwners.Text(reader, root, holder);
        claimed.Add(action);
        Capture(action, item);
        // Duplicates kept only when they disagree.
        Same(item, "IsFunction", "Function");
        Same(item, "Shareable", "Public");
        bool IsInput(T c) => reader.KindOf(c) == "InputParameter";
        foreach (var parameter in Listed(action, "InputParameters", IsInput)) item.Items.Add(Parameter(parameter, "in"));
        foreach (var parameter in Listed(action, "OutputParameters", c => reader.KindOf(c) == "OutputParameter")) item.Items.Add(Parameter(parameter, "out"));
        foreach (var parameter in Listed(action, "LocalVariables", c => reader.KindOf(c) == "LocalVariable")) item.Items.Add(Parameter(parameter, "local"));
        var nodes = reader.ChildrenOf(action).Where(c => reader.KindOf(c).EndsWith("Node", StringComparison.Ordinal)).ToList();
        var members = new HashSet<T>(nodes, ReferenceEqualityComparer.Instance);
        var nodeItems = new Dictionary<T, FlowItem>(ReferenceEqualityComparer.Instance);
        foreach (var child in reader.ChildrenOf(action)) {
            var kind = reader.KindOf(child);
            if (kind == "UILifeCycleEvent") { if (Event(action, child) is { } handler) item.Items.Add(handler); }
            else if (members.Contains(child)) { var node = Node(child, members); nodeItems[child] = node; item.Items.Add(node); }
            else if (!claimed.Contains(child)) problems.Add("child " + kind + " of the action is not read");
        }
        itemOf[action] = item;
        // The audit: every element below the action is claimed; value carriers below a claimed element belong to it, and
        // their text is in what the element nearest above them wrote (an expression object never holds anything else).
        // A finding below a node is that node's.
        T? NodeAbove(T element)
        {
            for (var at = (T?)element; at != null && !ReferenceEquals(at, action); at = reader.ParentOf(at))
                if (members.Contains(at)) return at;
            return null;
        }
        foreach (var node in reader.Walk(action)) {
            var kind = reader.KindOf(node);
            scope = NodeAbove(node);
            if (FlowRules.ValueKinds.Contains(kind)) {
                if (!claimed.Contains(node) && !(reader.ParentOf(node) is { } parent && claimed.Contains(parent))) Problem("element " + kind + " @" + reader.KeyOf(node) + " is not read");
                claimed.Add(node);
                var text = reader.ExpressionText(node) ?? (Raw(node, "Value") is { } value ? reader.ExpressionText(value) : null);
                if (!string.IsNullOrEmpty(text) && Owner(node) is { } owner && !Holds(owner, text)) Problem("value " + kind + " is not in the text of its " + owner.Kind);
                continue;
            }
            if (!claimed.Contains(node)) Problem("element " + kind + " @" + reader.KeyOf(node) + " is not read");
        }
        scope = null;
        // The opaque nodes: their name, key and connectors stay; what they hold is not the text's.
        foreach (var (node, reasons) in nodeProblems) {
            if (!nodeItems.TryGetValue(node, out var opaque)) { problems.AddRange(reasons); continue; }
            opaque.Opaque = true; opaque.OpaqueReasons = reasons;
            opaque.Props.Clear(); opaque.Items.Clear();
        }
        itemOf.Clear();
        found = problems;
        return item;
    }

    // The elements written as items, so a value carrier finds the item that holds its text.
    private readonly Dictionary<T, FlowItem> itemOf = new(ReferenceEqualityComparer.Instance);

    private FlowItem? Owner(T node)
    {
        for (var at = reader.ParentOf(node); at != null; at = reader.ParentOf(at))
            if (itemOf.TryGetValue(at, out var item)) return item;
        return null;
    }

    // An empty mapping (Source mapTo {  }) is held by the value the text writes for it: its source (Mapping).
    private static bool Holds(FlowItem item, string text) =>
        item.Props.Values.Any(v => v.Text.Contains(text, StringComparison.Ordinal)) || item.Items.Any(child => Holds(child, text))
        || FlowMapping.WithoutEmpty(text) is { } plain && Holds(item, plain);

    private FlowItem Parameter(T parameter, string role)
    {
        claimed.Add(parameter);
        var item = new FlowItem(role, reader.KindOf(parameter), reader.KeyOf(parameter), reader.NameOf(parameter));
        Capture(parameter, item);
        itemOf[parameter] = item;
        return item;
    }

    // A lifecycle event of the action (a data action's OnAfterFetch): its handler and arguments; an empty one is not written.
    private FlowItem? Event(T action, T handler)
    {
        claimed.Add(handler);
        var name = FlowRules.Lifecycle.FirstOrDefault(p => ReferenceEquals(Raw(action, p), handler)) ?? reader.NameOf(handler);
        // The event keeps its model key (not in the canonical text: an event is named by its property), for FlowDiff.
        var item = new FlowItem("event", "UILifeCycleEvent", reader.KeyOf(handler), name);
        Capture(handler, item); itemOf[handler] = item;
        Parts(handler, item);
        return item.Props.Count == 0 && item.Items.Count == 0 ? null : item;
    }

    private FlowItem Node(T node, HashSet<T> members)
    {
        claimed.Add(node);
        var kind = reader.KindOf(node);
        var item = new FlowItem("node", FlowRules.NodeKind(kind), reader.KeyOf(node), reader.NameOf(node));
        scope = node;
        try {
            Capture(node, item); itemOf[node] = item;
            if (kind == "CommentNode") Same(item, "Comment", "Text");
            // A node that keeps a record mapping of its own the text does not carry (O11: the attachments mapping of a Send
            // Email node) is opaque.
            if (reader.RecordMapping(node) is { Authored: true, Fields.Count: > 0 }) Problem(kind + " keeps a record mapping the text does not carry");
            // A call whose callee's name another action beside it also has (a client and a server action, a role's two
            // checks) reads as the kind of its flow; the other kind says so (Call=Client|Server), or the name would read
            // the wrong way.
            if (item.Kind == "Execute") {
                var clientNode = kind.Contains("Client", StringComparison.Ordinal);
                item.CallKind = clientNode ? "Client" : "Server";
                if (clientNode != clientFlow && Raw(node, "Action") is T callee && Shared(callee)) item.Props[FlowRules.CallProperty] = new('v', item.CallKind);
            }
            foreach (var edge in FlowRules.EdgeNames) {
                if (reader.PropertyOf(node, edge) is not { } read) continue;
                object? value;
                try { value = read(); } catch (Exception error) { Problem(kind + "." + edge + " read error: " + error.GetBaseException().Message); continue; }
                if (value is T target) {
                    if (!members.Contains(target)) problems.Add(kind + "." + edge + " points outside the action (" + reader.KindOf(target) + ")");
                    item.Edges[edge] = reader.KeyOf(target);
                } else item.Edges[edge] = "";
            }
            if (kind == "AggregateNode") Aggregate(node, item);
            else Parts(node, item, members);
        } finally { scope = default; }
        return item;
    }

    // The parts of a node or event, in the order the model lists them.
    private void Parts(T owner, FlowItem item, HashSet<T>? members = null)
    {
        var ownerKind = reader.KindOf(owner);
        foreach (var child in Ordered(owner)) {
            var kind = reader.KindOf(child);
            switch (kind) {
                case "ActionConnector": Claim(child); continue;
                case "CommentConnector": {
                    Claim(child);
                    if (Raw(child, "Target") is T target) {
                        if (members != null && !members.Contains(target)) problems.Add("comment attached outside the action");
                        item.Edges["Attached"] = reader.KeyOf(target);
                    }
                    continue;
                }
                case "Assignment": item.Items.Add(Part(child, "assignment")); continue;
                case "Argument": {
                    var part = Part(child, "argument");
                    part.Name = Raw(child, "Parameter") is T parameter ? reader.DisplayOf(parameter) : "?";
                    if (part.Props.Count > 0) item.Items.Add(part);
                    continue;
                }
                case "SwitchCondition": {
                    var part = Part(child, "case");
                    part.Edges["Target"] = Raw(child, "Target") is T target ? reader.KeyOf(target) : "";
                    item.Items.Add(part);
                    continue;
                }
                case "SQLOutput": item.Items.Add(Part(child, "output")); continue;
                case "InputParameter" or "SQLInputParameter" when ownerKind is "JavaScriptNode" or "SQLNode": item.Items.Add(Parameter(child, "in")); continue;
                case "OutputParameter" when ownerKind == "JavaScriptNode": item.Items.Add(Parameter(child, "out")); continue;
            }
            if (FlowRules.ValueKinds.Contains(kind)) { Claim(child); continue; }
            Problem("part " + kind + " of " + ownerKind + " is not read");
        }
    }

    // Sources, joins, filters, groups, columns and sorts of an aggregate, wherever its operation tree keeps them.
    private void Aggregate(T node, FlowItem item)
    {
        var sorts = Raw(node, "Sorts") is IEnumerable listed and not string ? listed.OfType<T>().ToList() : null;
        var sources = new List<T>(); var additions = new List<T>();
        foreach (var child in reader.Walk(node).Skip(1)) {
            var kind = reader.KindOf(child);
            switch (kind) {
                case "AddSourceOperation": additions.Add(child); Claim(child); continue;
                case "CombineSourcesOperation" or "GroupByOperation" or "ActionConnector": Claim(child); continue;
                case "ImplicitParameter": Claim(child); Count("AggregateNode.ImplicitParameter (inferred from the aggregate's expressions)"); continue;
                case "AliasedSource": {
                    var part = Part(child, "source"); part.Name = reader.NameOf(child); part.Kind = "Source";
                    item.Items.Add(part); sources.Add(child);
                    continue;
                }
                case "Join": item.Items.Add(Part(child, "join")); continue;
                case "Filter": item.Items.Add(Part(child, "filter")); continue;
                case "GroupByAttribute": { var part = Part(child, "group"); part.Name = reader.NameOf(child); item.Items.Add(part); continue; }
                case "AggregateAttribute": { var part = Part(child, "agg"); part.Name = reader.NameOf(child); item.Items.Add(part); continue; }
                case "CalculatedAttribute": { var part = Part(child, "calc"); part.Name = reader.NameOf(child); item.Items.Add(part); continue; }
                case "Sort": if (sorts == null) item.Items.Add(Part(child, "sort")); else Claim(child); continue;
            }
            if (claimed.Contains(child)) continue;
            if (FlowRules.ValueKinds.Contains(kind) && reader.ParentOf(child) is { } parent && claimed.Contains(parent)) { claimed.Add(child); continue; }
            Problem("aggregate part " + kind + " is not read");
        }
        if (sorts != null) foreach (var sort in sorts) item.Items.Add(Part(sort, "sort"));
        // A source the aggregate adds without an aliased source over it (ODC: a plain FROM is only its AddSourceOperation)
        // is a source of its own; one an aliased source stands for is structure.
        var aliased = new HashSet<T>(sources.Select(s => Raw(s, "SourceOperation")).OfType<T>(), ReferenceEqualityComparer.Instance);
        foreach (var addition in additions.Where(a => !aliased.Contains(a))) {
            var part = Part(addition, "source"); part.Name = reader.NameOf(addition); part.Kind = "Source";
            item.Items.Add(part); sources.Add(addition);
        }
        // The master source says which source the joins start from: written when there is more than one source.
        if (Raw(node, "MasterSource") is T master) {
            if (sources.Count > 1) item.Props["MasterSource"] = new('r', reader.DisplayOf(master));
            else Count("AggregateNode.MasterSource (the only source)");
        }
    }

    // A part keeps its model key (never in the canonical text: parts compare by content), so a change of the parts of a
    // node can delete the old ones (FlowDiff).
    private FlowItem Part(T node, string role)
    {
        claimed.Add(node);
        var item = new FlowItem(role, reader.KindOf(node), reader.KeyOf(node));
        Capture(node, item); itemOf[node] = item;
        if (role is "assignment" or "argument") Mapping(node, item);
        return item;
    }

    // The record mapping an assignment or argument keeps beside its value (O11, NativeMapping) is part of its Value, written
    // as ODC prints it: "Source mapTo { Field: value, ... }". The automatic conversion the Studio derives from the two types
    // is not written (counted); a mapping whose text would not read back whole makes the node opaque.
    private void Mapping(T node, FlowItem item)
    {
        var kind = reader.KindOf(node);
        // O11: an expression whose own text holds a mapping is no mapping (the platform's parser does not read mapTo): written
        // back, the text would become one. The node is opaque.
        if (reader.MappingsBeside && item.Prop("Value") is { } own && FlowMapping.Split(own) != null) {
            Problem(kind + " value holds mapTo in its own expression text, which this platform does not parse: " + own);
            return;
        }
        // A field value the model binds to an element whose name the source now has as an attribute (an attribute renamed in the
        // Studio onto that name): the text would read back the same and mean the attribute, so the node is not carried by the
        // text (opaque: kept as it is, never written back; the review of round 2, o-dr / d-dr).
        if (reader.MappingCaptures(node) is { Count: > 0 } captures) {
            foreach (var capture in captures) Problem(kind + " " + capture);
            return;
        }
        // ODC: an empty mapping (Source mapTo {  }) is the conversion the platform makes on its own when the value is written
        // plain: the text writes the value, as O11 does (one form in both lanes).
        if (!reader.MappingsBeside && item.Prop("Value") is { } written && FlowMapping.WithoutEmpty(written) is { } plain) {
            item.Props["Value"] = new('e', plain);
            Count(kind + ".Value (an empty mapping: the platform's own conversion of the value)");
            return;
        }
        if (reader.RecordMapping(node) is not { } mapping) return;
        if (!mapping.Authored) { Count(kind + ".ValueTypeConversion (automatic: the Studio derives it from the two types)"); return; }
        if (mapping.Fields.Count == 0) { Count(kind + ".ValueTypeConversion (every attribute empty)"); return; }
        var value = item.Prop("Value") ?? "";
        if (FlowMapping.Compose(value, mapping.Fields) is { } text) item.Props["Value"] = new('e', text);
        else Problem(kind + " mapping of " + (value.Length > 0 ? value : "an empty value") + " is not text that reads back whole ("
            + string.Join(", ", mapping.Fields.Select(f => f.Field + ": " + f.Value)) + ")");
    }

    private void Claim(T node) { foreach (var descendant in reader.Walk(node)) claimed.Add(descendant); }

    // Whether an action shares its name with another action beside it (under the same module or reference).
    private readonly Dictionary<T, Dictionary<string, int>> actionNames = new(ReferenceEqualityComparer.Instance);
    private bool Shared(T callee)
    {
        if (reader.ParentOf(callee) is not { } parent) return false;
        if (!actionNames.TryGetValue(parent, out var names)) {
            actionNames[parent] = names = new(StringComparer.Ordinal);
            foreach (var sibling in reader.ChildrenOf(parent))
                if (reader.KindOf(sibling).EndsWith("Action", StringComparison.Ordinal) || reader.IsKind(sibling, "IActionSignature"))
                    names[reader.DisplayOf(sibling)] = names.GetValueOrDefault(reader.DisplayOf(sibling)) + 1;
        }
        return names.GetValueOrDefault(reader.DisplayOf(callee)) > 1;
    }

    // Children in the order of the model's own list properties when it has them (the plain enumeration can differ
    // between two loads), else in key order.
    private IEnumerable<T> Ordered(T owner)
    {
        var children = reader.ChildrenOf(owner).ToList();
        var ordered = new List<T>(); var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        foreach (var property in new[] { "Assignments", "Arguments", "Conditions", "InputParameters", "OutputParameters", "Parameters", "Outputs" }) {
            if (Raw(owner, property) is not IEnumerable items || items is string) continue;
            foreach (var element in items.OfType<T>())
                if (children.Contains(element) && seen.Add(element)) ordered.Add(element);
        }
        foreach (var child in children.Where(c => !seen.Contains(c)).OrderBy(reader.KeyOf, StringComparer.Ordinal)) ordered.Add(child);
        return ordered;
    }

    private List<T> Listed(T node, string property, Func<T, bool> filter)
    {
        if (Raw(node, property) is IEnumerable items and not string) return items.OfType<T>().Where(filter).ToList();
        return reader.ChildrenOf(node).Where(filter).OrderBy(reader.DisplayOf, StringComparer.Ordinal).ThenBy(reader.KeyOf, StringComparer.Ordinal).ToList();
    }

    private object? Raw(T node, string property)
    {
        if (reader.PropertyOf(node, property) is not { } read) return null;
        try { return read(); } catch { return null; }
    }

    // Every authored property of an element: noise, structure and derived values by rule, defaults left out.
    private void Capture(T node, FlowItem item)
    {
        var kind = reader.KindOf(node);
        foreach (var (property, read) in reader.PropertiesOf(node)) {
            if (FlowRules.Skip(property) || kind == "Argument" && property == "Parameter") continue;
            var reason = FlowRules.NotWritten(kind, property);
            object? raw;
            try { raw = read(); }
            catch (Exception error) { if (reason == null) Problem("read error " + kind + "." + property + ": " + error.GetBaseException().GetType().Name); continue; }
            var value = Value(node, property, raw);
            if (reason != null) { if (value != null) Count(kind + "." + property + " (" + reason + ")"); continue; }
            if (value == null || FlowRules.IsDefault(kind, property, value)) continue;
            item.Props[property] = value;
        }
    }

    // A duplicate property (IsFunction of Function, Shareable of Public, the ODC Comment of Text) is written once; kept
    // only when the two disagree.
    private void Same(FlowItem item, string copy, string of)
    {
        if (item.Prop(copy) != item.Prop(of)) return;
        if (item.Props.Remove(copy)) Count(item.Kind + "." + copy + " (same as " + of + ")");
    }

    // What the rules leave out, by rule, over every action read with this extractor.
    public readonly SortedDictionary<string, int> NotWritten = new(StringComparer.Ordinal);
    private void Count(string rule) => NotWritten[rule] = NotWritten.GetValueOrDefault(rule) + 1;

    private FlowValue? Value(T node, string property, object? raw)
    {
        switch (raw) {
            case null or byte[]: return null;
        }
        if (reader.ExpressionText(raw) is { } expression) return expression.Length > 0 ? new('e', expression) : null;
        switch (raw) {
            case T target:
                // The owner above an element is structure, but an Execute node's Action naming its own action is a recursive call.
                var recursive = property == "Action" && FlowRules.NodeKind(reader.KindOf(node)) == "Execute";
                if (ReferenceEquals(target, node) || ReferenceEquals(target, root) || !recursive && ReferenceEquals(reader.ParentOf(node), target) || Below(target, node)) return null;
                return new('r', property == "Action" ? Callee(target) : Named(target));
            case string text: return text.Length > 0 ? new('t', text) : null;
            case bool flag: return new('v', flag ? "True" : "False");
            case IEnumerable items: {
                var elements = new List<T>(); var texts = new List<string>(); var structural = true;
                foreach (var entry in items) {
                    if (entry is T element) { elements.Add(element); structural &= Below(element, node); }
                    else if (entry?.ToString() is { Length: > 0 } plain) { texts.Add(plain); structural = false; }
                }
                if (elements.Count + texts.Count == 0 || structural && texts.Count == 0) return null;
                return elements.Count > 0
                    ? new('r', "[" + string.Join(", ", elements.Select(reader.DisplayOf).Order(StringComparer.Ordinal)) + "]")
                    : new('v', "[" + string.Join(", ", texts) + "]");
            }
            default: return raw.ToString() is { Length: > 0 } other ? new('v', other) : null;
        }
    }

    // True when element sits below owner (a child list or a reference into the element's own subtree).
    private bool Below(T element, T owner)
    {
        var at = reader.ParentOf(element);
        for (var depth = 0; at != null && depth < 16; depth++) {
            if (ReferenceEquals(at, owner)) return true;
            at = reader.ParentOf(at);
        }
        return false;
    }

    // The name a reference is written with; an element without one (the previous screen of a navigation) by its kind.
    private string Named(T target) => reader.DisplayOf(target) is { Length: > 0 } name ? name : reader.KindOf(target);

    // An action of another module is named through its producer, as the digest does ("(System).ListAppend").
    public string Callee(T action) =>
        reader.ParentOf(action) is { } owner && reader.KindOf(owner) == "Reference" ? reader.DisplayOf(owner) + "." + reader.DisplayOf(action) : reader.DisplayOf(action);
}
