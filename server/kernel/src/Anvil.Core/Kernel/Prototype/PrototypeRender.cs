using System.Globalization;
using Anvil.Reading;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>A node of a rendered tree: an element (<see cref="Tag"/>), a text node (<see cref="Text"/>) or an expression the
/// renderer could not evaluate (<see cref="Unevaluable"/>). <see cref="Runtime"/> names the widget whose runtime element this is
/// when the prototype has no counterpart (a wrapper, a block instance, a placeholder, the popup backdrop and box).</summary>
public sealed class DomNode
{
    public string? Tag { get; init; }
    public string? Text { get; set; }
    public string? Unevaluable { get; set; }
    public List<(string Name, string Value)> Attributes { get; } = [];
    public List<DomNode> Children { get; } = [];
    public DomNode? Parent { get; private set; }
    public string? K { get; set; }
    public string? Runtime { get; set; }
    public string? RuntimeSelector { get; set; }
    public string? Widget { get; set; }
    public string? Name { get; set; }
    public string? ObjectKey { get; set; }

    public bool IsElement => Tag != null;
    public static DomNode Element(string tag) => new() { Tag = tag.ToLowerInvariant() };
    public static DomNode TextNode(string text) => new() { Text = text };
    public static DomNode Fragment() => new();

    public DomNode Add(DomNode child) { child.Parent = this; Children.Add(child); return child; }
    public string? Attr(string name)
    {
        foreach (var (n, v) in Attributes) if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) return v;
        return null;
    }
    public void SetAttr(string name, string value)
    {
        var at = Attributes.FindIndex(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase));
        if (at >= 0) Attributes[at] = (name, value); else Attributes.Add((name, value));
    }
    public IReadOnlySet<string> Classes => (Attr("class") ?? "").Split((char[])[' ', '\t', '\n', '\r', '\f'], StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
    public DomNode? ParentElement => Parent is { IsElement: true } p ? p : null;
    public DomNode? PreviousElement
    {
        get
        {
            if (Parent == null) return null;
            var i = Parent.Children.IndexOf(this);
            for (var k = i - 1; k >= 0; k--) if (Parent.Children[k].IsElement) return Parent.Children[k];
            return null;
        }
    }
    public IEnumerable<DomNode> PreviousSiblings() { for (var s = PreviousElement; s != null; s = s.PreviousElement) yield return s; }
    public IEnumerable<DomNode> FollowingSiblings()
    {
        if (Parent == null) yield break;
        var i = Parent.Children.IndexOf(this);
        for (var k = i + 1; k < Parent.Children.Count; k++) if (Parent.Children[k].IsElement) yield return Parent.Children[k];
    }
    public IEnumerable<DomNode> Ancestors() { for (var a = ParentElement; a != null; a = a.ParentElement) yield return a; }
    public IEnumerable<DomNode> Descendants(bool includeSelf)
    {
        if (includeSelf) yield return this;
        foreach (var child in Children) foreach (var d in child.Descendants(includeSelf: true)) yield return d;
    }
    private List<DomNode> ElementSiblings() => Parent?.Children.Where(c => c.IsElement).ToList() ?? [this];
    public int ElementIndex() => ElementSiblings().IndexOf(this);
    public int ElementIndexFromEnd() { var s = ElementSiblings(); return s.Count - 1 - s.IndexOf(this); }
    public int TypeIndex() { var s = ElementSiblings().Where(x => x.Tag == Tag).ToList(); return s.IndexOf(this); }
    public int TypeIndexFromEnd() { var s = ElementSiblings().Where(x => x.Tag == Tag).ToList(); return s.Count - 1 - s.IndexOf(this); }

    /// <summary>The node in the IR form (2.10): {k, t, a, c} for an element, {x} for text; runtime elements say which widget
    /// made them (<c>rt</c>); <c>w</c>, <c>n</c> and <c>o</c> are the widget type, name and key of the built model.</summary>
    public JsonNode ToJson()
    {
        if (Unevaluable != null) return new JsonObject { ["unevaluable"] = Unevaluable, ["w"] = Widget, ["n"] = Name, ["o"] = ObjectKey, ["k"] = K };
        if (!IsElement && Tag == null && Text == null && Parent == null)
            return new JsonArray(Children.Select(c => c.ToJson()).ToArray());
        if (!IsElement) return K == null ? new JsonObject { ["x"] = Text } : new JsonObject { ["k"] = K, ["x"] = Text };
        var node = new JsonObject();
        if (K != null) node["k"] = K;
        node["t"] = Tag;
        node["a"] = new JsonArray(Attributes.Select(a => (JsonNode)new JsonArray(a.Name, a.Value)).ToArray());
        node["c"] = new JsonArray(Children.Select(c => c.ToJson()).ToArray());
        if (Runtime != null) node["rt"] = Runtime;
        if (Widget != null) node["w"] = Widget;
        if (Name != null) node["n"] = Name;
        if (ObjectKey != null) node["o"] = ObjectKey;
        return node;
    }

    /// <summary>A capture Node (2.10) as a tree: elements keep their k, tag and attributes; text keeps its text.</summary>
    public static DomNode FromJson(JsonNode? node)
    {
        if (node is JsonArray array)
        {
            var fragment = Fragment();
            foreach (var child in array) fragment.Add(FromJson(child));
            return fragment;
        }
        if (node is not JsonObject o) return TextNode("");
        if (o["t"] is null) return new DomNode { Text = o["x"]?.ToString() ?? "", K = o["k"]?.ToString(), Unevaluable = o["unevaluable"]?.ToString() };
        var element = Element(o["t"]!.ToString());
        element.K = o["k"]?.ToString();
        element.Runtime = o["rt"]?.ToString();
        foreach (var pair in o["a"] as JsonArray ?? []) if (pair is JsonArray p && p.Count == 2) element.Attributes.Add((p[0]!.ToString(), p[1]?.ToString() ?? ""));
        foreach (var child in o["c"] as JsonArray ?? []) element.Add(FromJson(child));
        return element;
    }
}

/// <summary>
/// The native side of the fidelity measure (docs/PROTOTIPO-NATIVO.md, 4.4 step 2), the <see cref="PrototypeSeams.Render"/> seam:
/// after the Verify, the built module is read back (<see cref="KernelModelReader"/> over the saved session: screens, blocks,
/// popups, widgets, properties, extended properties, expressions, aggregates) and every explored state of the capture is rendered
/// through the runtime DOM table of the platform (wrappers and runtime attributes included). Expressions are evaluated by an
/// evaluator of the closed subset the compiler emits (the format and logic tables 2.8 and 3.4); a function outside it renders an
/// <c>unevaluable</c> node, counted. Aggregates are evaluated over the seed rows of the capture with the filters and sorts read
/// from the model. Output: <c>prototype-dom.json</c> (schema <c>ssam-prototype-dom/1</c>).
/// </summary>
public static class PrototypeRender
{
    public const string Schema = "ssam-prototype-dom/1";

    public static JsonObject Render(PrototypeRenderRequest request) =>
        Render(new KernelModelReader(), request.Capture, request.Platform, request.Roots);

    /// <summary>The same read-back from a saved module file: each root given by its model path ("MobileScreen:Catalogo",
    /// "@key"), resolved by the kernel reader, rendered, and the module released.</summary>
    public static JsonObject RenderOml(ModelHost host, string omlPath, JsonObject capture, string platform, IReadOnlyDictionary<string, string> paths)
    {
        var module = host.Load(omlPath);
        try
        {
            var reader = new KernelModelReader();
            var roots = paths.ToDictionary(p => p.Key, p => reader.Resolve((OutSystems.Model.IObjectSignature)module, p.Value), StringComparer.Ordinal);
            return Render(reader, capture, platform, roots);
        }
        finally { ModelHost.Release(module); }
    }

    // ---- the compiled tree (WidgetNode) through the table: what the rewrites ask before the module exists ------------

    /// <summary>The DOM the runtime will render for a compiled tree, with both branches of every If and one list item: the
    /// superset the rewrite decisions match against (4.1 item 6).</summary>
    public static DomNode FromWidgets(WidgetNode root, string platform)
    {
        var fragment = DomNode.Fragment();
        Emit(root, fragment, platform);
        return fragment;
    }

    private static void Emit(WidgetNode node, DomNode parent, string platform)
    {
        var row = RuntimeDomTable.Row(platform, node.W);
        IEnumerable<WidgetNode> Kids() => node.Children.Concat(node.Else ?? []);
        if (row == null)
        {
            var unknown = parent.Add(DomNode.Element(node.Tag ?? "div"));
            unknown.K = node.K; unknown.Widget = node.W;
            Fill(unknown, node, null);
            foreach (var child in Kids()) Emit(child, unknown, platform);
            return;
        }
        var host = parent;
        foreach (var wrapper in row.Wrappers) host = host.Add(RuntimeElement(row, wrapper));
        if (row.Element == null || node.Role == "wrapper" && row.Transparent)
        {
            if (row.Element != null) host = host.Add(TransparentElement(row));
            foreach (var child in Kids()) Emit(child, host, platform);
            return;
        }
        if (row.Transparent) { host = host.Add(TransparentElement(row)); foreach (var child in Kids()) Emit(child, host, platform); return; }
        if (row.Element == "#text") { host.Add(new DomNode { Text = node.Text ?? "", K = node.K }); return; }
        var element = host.Add(DomNode.Element(row.Element.StartsWith('{') ? node.Tag ?? "div" : row.Element));
        element.K = node.K; element.Widget = row.Widget;
        Fill(element, node, row);
        if (node.Text != null) element.Add(DomNode.TextNode(node.Text));
        foreach (var child in Kids()) Emit(child, element, platform);
    }

    private static void Fill(DomNode element, WidgetNode node, RuntimeDomRow? row)
    {
        foreach (var (name, value) in row?.Attributes ?? []) if (name.StartsWith("data-", StringComparison.Ordinal)) element.Attributes.Add((name, value));
        var classes = new List<string>();
        foreach (var (name, value) in row?.Attributes ?? []) if (name == "class") classes.AddRange(value.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        if (!string.IsNullOrWhiteSpace(node.Style)) classes.AddRange(node.Style.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        foreach (var (name, value) in node.Attributes) if (name == "class") classes.AddRange(value.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        if (classes.Count > 0 || row?.Attributes.Any(a => a.Name == "class") == true) element.Attributes.Add(("class", string.Join(" ", classes.Distinct(StringComparer.Ordinal))));
        foreach (var (name, value) in row?.Attributes ?? []) if (!name.StartsWith("data-", StringComparison.Ordinal) && name != "class") element.Attributes.Add((name, value));
        foreach (var (name, value) in node.Attributes) if (name != "class" && element.Attr(name) == null) element.Attributes.Add((name, value));
    }

    private static DomNode RuntimeElement(RuntimeDomRow row, RuntimeWrapper wrapper)
    {
        var element = DomNode.Element(wrapper.Tag);
        foreach (var a in wrapper.Attributes) element.Attributes.Add(a);
        if (wrapper.Classes.Count > 0) element.Attributes.Add(("class", string.Join(" ", wrapper.Classes)));
        element.Runtime = row.Widget;
        element.RuntimeSelector = PrototypeAdapters.WrapperSelector(row, wrapper);
        return element;
    }

    private static DomNode TransparentElement(RuntimeDomRow row)
    {
        var element = DomNode.Element(row.Element!.StartsWith('{') ? "div" : row.Element);
        foreach (var a in row.Attributes) element.Attributes.Add(a);
        element.Runtime = row.Widget;
        element.RuntimeSelector = RuntimeDomTable.ElementSelector(row);
        return element;
    }

    // ---- the built module read back -------------------------------------------------------------------------------

    internal sealed class NativeWidget
    {
        public string Kind = "";
        public string Basic = "";
        public string? Name;
        public string? Key;
        public object? Node;
        public readonly Dictionary<string, string> Props = new(StringComparer.Ordinal);
        public readonly List<(string Name, string Value)> Extended = [];
        public readonly List<NativeWidget> Children = [];
        public List<NativeWidget>? Else;
        public readonly List<(string Parameter, string Value)> Arguments = [];
        public readonly Dictionary<string, List<NativeWidget>> Contents = new(StringComparer.OrdinalIgnoreCase);
        public object? SourceBlock;
    }

    private static readonly string[] ReadProps = ["Style", "StyleClasses", "Tag", "Text", "Value", "Condition", "Source", "ShowPopup", "InputType", "Variable",
        "Enabled", "CustomStyle", "Label", "Image", "Url", "Prompt", "Mode", "Width", "List", "Values", "Labels", "MaxLength"];

    private static string Base(string kind) => kind.Length > "Widget".Length && kind.EndsWith("Widget", StringComparison.Ordinal) && kind != "IfWidget" ? kind[..^"Widget".Length] : kind;

    internal static NativeWidget ReadWidget<T>(ModelReader<T> reader, T node) where T : class
    {
        var kind = reader.KindOf(node);
        var widget = new NativeWidget { Kind = kind, Basic = Base(kind), Name = reader.NameOf(node), Key = reader.KeyOf(node), Node = node };
        foreach (var property in ReadProps)
            if (Prop(reader, node, property) is { } text) widget.Props[property] = text;
        if (reader.IsKind(node, "IfWidget") || widget.Basic == "If" || kind == "IfWidget")
        {
            if (Raw(reader, node, "TrueBranch") is T yes) widget.Children.AddRange(Widgets(reader, yes));
            if (Raw(reader, node, "FalseBranch") is T no) widget.Else = Widgets(reader, no).ToList();
            return widget;
        }
        foreach (var child in reader.ChildrenOf(node))
        {
            var childKind = reader.KindOf(child);
            if (childKind == "ExtendedProperty")
            {
                var name = Prop(reader, child, "Property") ?? reader.NameOf(child);
                widget.Extended.Add((name, Prop(reader, child, "Value") ?? ""));
            }
            else if (childKind == "Argument")
                widget.Arguments.Add((Prop(reader, child, "Parameter") ?? reader.NameOf(child), Prop(reader, child, "Value") ?? ""));
            else if (childKind == "PlaceholderContentWidget")
                widget.Contents[Prop(reader, child, "Placeholder") ?? reader.NameOf(child)] = Widgets(reader, child).ToList();
            else if (reader.IsKind(child, "Widget") && childKind != "IfBranchWidget")
                widget.Children.Add(ReadWidget(reader, child));
        }
        if (kind.Contains("BlockInstance", StringComparison.Ordinal)) widget.SourceBlock = Raw(reader, node, "SourceBlock");
        return widget;
    }

    private static IEnumerable<NativeWidget> Widgets<T>(ModelReader<T> reader, T container) where T : class =>
        reader.ChildrenOf(container).Where(c => reader.IsKind(c, "Widget") && reader.KindOf(c) != "IfBranchWidget").Select(c => ReadWidget(reader, c)).ToList();

    private static object? Raw<T>(ModelReader<T> reader, T node, string property) where T : class
    {
        if (reader.PropertyOf(node, property) is not { } read) return null;
        try { return read(); } catch { return null; }
    }

    private static string? Prop<T>(ModelReader<T> reader, T node, string property) where T : class => Raw(reader, node, property) switch
    {
        null => null,
        string text => text,
        var value when reader.ExpressionText(value) is { } expression => expression,
        T reference => reader.DisplayOf(reference),
        System.Collections.IEnumerable => null,
        var value => value.ToString(),
    };

    // ---- the data of a root: locals, inputs, aggregates, client variables --------------------------------------------

    internal sealed record Variable(string Name, string? Type, string? Default);
    internal sealed record Aggregate(string Name, IReadOnlyList<(string Entity, string Alias)> Sources, IReadOnlyList<string> Filters,
        IReadOnlyList<(string Attribute, bool Descending)> Sorts, string? Max, bool Joined)
    {
        /// <summary>The joins in order: the source they bring (its alias), the condition and the kind (Left/With or Without keep
        /// the row without a match, the others drop it).</summary>
        public IReadOnlyList<(string Left, string Right, string Condition, string Kind)> Joins { get; init; } = [];
        /// <summary>The aggregation columns (Sum, Count, Max, Min, Average) of an aggregate without group by: one row.</summary>
        public IReadOnlyList<(string Name, string Attribute, string Function)> Columns { get; init; } = [];
        /// <summary>The order its OnAfterFetch gives the list (the compiler's Ordenar&lt;Lista&gt;: a Switch of ListSort calls on a bare
        /// attribute): each case's condition, the attribute and the direction.</summary>
        public IReadOnlyList<(string When, string By, string Ascending)> AfterFetchSorts { get; init; } = [];
    }

    internal sealed class RootModel
    {
        public string Name = "";
        public readonly List<Variable> Locals = [];
        public readonly List<Variable> Inputs = [];
        public readonly List<Aggregate> Aggregates = [];
        public readonly List<NativeWidget> Widgets = [];
        /// <summary>The assignments of the root's OnInitialize and OnParametersChanged when those actions only assign (the
        /// compiler's own: locals from Client Variables, a block's copies of its inputs), in order.</summary>
        public readonly List<(string Variable, string Value)> Lifecycle = [];
    }

    internal static RootModel ReadRoot<T>(ModelReader<T> reader, T root) where T : class
    {
        var model = new RootModel { Name = reader.NameOf(root) };
        foreach (var child in reader.ChildrenOf(root))
        {
            var kind = reader.KindOf(child);
            if (kind is "LocalVariable") model.Locals.Add(new Variable(reader.NameOf(child), Prop(reader, child, "DataType"), Prop(reader, child, "DefaultValue")));
            else if (kind is "InputParameter") model.Inputs.Add(new Variable(reader.NameOf(child), Prop(reader, child, "DataType"), Prop(reader, child, "DefaultValue")));
            else if (kind is "ScreenAggregate" or "Aggregate" or "BlockAggregate") model.Aggregates.Add(ReadAggregate(reader, child));
            else if (reader.IsKind(child, "Widget")) model.Widgets.Add(ReadWidget(reader, child));
        }
        // A popup or a single widget given as the root renders itself.
        if (reader.IsKind(root, "Widget")) model.Widgets.Add(ReadWidget(reader, root));
        var seen = new HashSet<T>(ReferenceEqualityComparer.Instance);
        foreach (var lifecycle in new[] { "OnInitialize", "OnParametersChanged" })
            if (Raw(reader, root, lifecycle) is T handler && Raw(reader, handler, "Destination") is T action && seen.Add(action) && AssignOnly(reader, action) is { } assignments)
                model.Lifecycle.AddRange(assignments);
        return model;
    }

    /// <summary>The assignments of an action made of Start, Assign and End only; null for any other action (the read-back never
    /// runs logic: a server call, a branch, a loop are the runtime's).</summary>
    private static List<(string, string)>? AssignOnly<T>(ModelReader<T> reader, T action) where T : class
    {
        var assignments = new List<(string, string)>();
        foreach (var node in reader.Walk(action))
        {
            var kind = reader.KindOf(node);
            if (kind == "Assignment")
            {
                if (Prop(reader, node, "Variable") is { Length: > 0 } variable && Prop(reader, node, "Value") is { Length: > 0 } value) assignments.Add((variable, value));
                continue;
            }
            if (kind.EndsWith("Node", StringComparison.Ordinal) && kind is not ("StartNode" or "EndNode" or "AssignNode" or "AssignmentNode")) return null;
        }
        return assignments;
    }

    private static Aggregate ReadAggregate<T>(ModelReader<T> reader, T aggregate) where T : class
    {
        var sources = new List<(string, string)>(); var filters = new List<string>(); var sorts = new List<(string, bool)>(); var joined = false;
        var joins = new List<(string, string, string, string)>(); var columns = new List<(string, string, string)>();
        var stack = new Stack<T>(reader.ChildrenOf(aggregate).Reverse());
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            var kind = reader.KindOf(node);
            switch (kind)
            {
                case "AliasedSource": sources.Add((Prop(reader, node, "Source") ?? reader.DisplayOf(node), reader.DisplayOf(node))); break;
                case "Filter": if (Prop(reader, node, "Condition") is { Length: > 0 } condition) filters.Add(condition); break;
                case "Sort": if (Prop(reader, node, "Attribute") is { Length: > 0 } attribute) sorts.Add((attribute, Prop(reader, node, "SortDirection") == "Descending")); break;
                case "Join":
                    joined = true;
                    if (Prop(reader, node, "RightSource") is { Length: > 0 } right && Prop(reader, node, "Condition") is { Length: > 0 } on)
                        joins.Add((Prop(reader, node, "LeftSource") ?? "", right, on, Prop(reader, node, "JoinType") ?? "Left"));
                    break;
                case "AggregateAttribute" or "CalculatedAttribute":
                    if (Prop(reader, node, "Attribute") is { Length: > 0 } column)
                        columns.Add((reader.NameOf(node), column, Prop(reader, node, "AggregationType") ?? ""));
                    break;
            }
            foreach (var child in reader.ChildrenOf(node).Reverse()) stack.Push(child);
        }
        var afterFetch = Raw(reader, aggregate, "OnAfterFetch") is T handler && Raw(reader, handler, "Destination") is T action ? SortSwitch(reader, action) : null;
        return new Aggregate(reader.NameOf(aggregate), sources, filters, sorts, Prop(reader, aggregate, "MaxRecords"), joined || sources.Count > 1)
            { Joins = joins, Columns = columns, AfterFetchSorts = afterFetch ?? [] };
    }

    /// <summary>The cases of an action that is a Switch whose every case is one ListSort call (Start -> Switch -> ListSort -> End);
    /// null for any other action (the read-back runs no other logic).</summary>
    private static List<(string, string, string)>? SortSwitch<T>(ModelReader<T> reader, T action) where T : class
    {
        var start = reader.ChildrenOf(action).FirstOrDefault(c => reader.KindOf(c) == "StartNode");
        if (start == null || Raw(reader, start, "Target") is not T node || reader.KindOf(node) != "SwitchNode") return null;
        var conditions = Raw(reader, node, "Conditions") is System.Collections.IEnumerable items and not string
            ? items.OfType<T>().Where(c => reader.KindOf(c) == "SwitchCondition").ToList() : [];
        var cases = new List<(string, string, string)>();
        foreach (var condition in conditions)
        {
            if (Prop(reader, condition, "Value") is not { Length: > 0 } when || Raw(reader, condition, "Target") is not T call) return null;
            if (!reader.KindOf(call).StartsWith("Execute", StringComparison.Ordinal) || Raw(reader, call, "Action") is not T callee || reader.NameOf(callee) != "ListSort") return null;
            string? by = null, ascending = null;
            foreach (var argument in reader.ChildrenOf(call).Where(c => reader.KindOf(c) == "Argument"))
            {
                var parameter = Prop(reader, argument, "Parameter");
                if (parameter == "By") by = Prop(reader, argument, "Value");
                else if (parameter == "Ascending") ascending = Prop(reader, argument, "Value");
            }
            if (by == null) return null;
            cases.Add((when, by, ascending ?? "True"));
        }
        return cases;
    }

    private static IReadOnlyList<Variable> ClientVariables<T>(ModelReader<T> reader, T node) where T : class
    {
        var top = node;
        for (var p = reader.ParentOf(node); p != null; p = reader.ParentOf(p)) top = p;
        return reader.ChildrenOf(top).Where(c => reader.KindOf(c) == "ClientVariable")
            .Select(c => new Variable(reader.NameOf(c), Prop(reader, c, "DataType"), Prop(reader, c, "DefaultValue"))).ToList();
    }

    // ---- rendering the explored states ----------------------------------------------------------------------------

    internal static JsonObject Render<T>(ModelReader<T> reader, JsonObject capture, string platform, IReadOnlyDictionary<string, T> roots) where T : class
    {
        platform = RuntimeDomTable.IsOdc(platform) ? "odc" : "o11";
        var models = new Dictionary<string, RootModel>(StringComparer.Ordinal);
        RootModel Model(T node, string key) => models.TryGetValue(key, out var m) ? m : models[key] = ReadRoot(reader, node);
        var context = new RenderContext(capture, platform);
        var clients = roots.Values.Take(1).SelectMany(r => ClientVariables(reader, r)).ToList();
        var states = new JsonArray(); var problems = new JsonArray();
        foreach (var state in States(capture))
        {
            var view = state["view"]?.ToString() ?? "";
            var key = "v:" + view;
            if (!roots.TryGetValue(key, out var root)) { problems.Add(new JsonObject { ["state"] = state["id"]?.DeepClone(), ["message"] = "no root " + key + " in the built module" }); continue; }
            var model = Model(root, key);
            var scope = context.StateScope(model, clients, state);
            var fragment = DomNode.Fragment();
            context.StateId = state["id"]?.ToString() ?? key;
            foreach (var widget in model.Widgets) context.RenderWidget(widget, fragment, scope, reader, roots, Model);
            states.Add(new JsonObject
            {
                ["id"] = state["id"]?.DeepClone() ?? key, ["view"] = view, ["modal"] = ModalOf(state),
                ["root"] = fragment.ToJson(), ["elements"] = fragment.Descendants(includeSelf: false).Count(n => n.IsElement && n.Runtime == null),
            });
        }
        return new JsonObject
        {
            ["schema"] = Schema,
            ["platform"] = platform,
            ["states"] = states,
            ["unevaluable"] = context.UnevaluableReport,
            ["runtimeUnverified"] = new JsonArray(context.Unverified.OrderBy(u => u.Key, StringComparer.Ordinal)
                .Select(u => (JsonNode)new JsonObject { ["widget"] = u.Key, ["count"] = u.Value }).ToArray()),
            ["problems"] = problems,
        };
    }

    /// <summary>The modal a state opens: its <c>modal</c> field, else the key of an id written <c>m:&lt;modal&gt;@&lt;state&gt;</c>.
    /// The popup opens as the first trigger opened it (a ListIndexOf index or an input at its default: the first item).</summary>
    private static string? ModalOf(JsonObject state)
    {
        if (state["modal"]?.ToString() is { Length: > 0 } modal) return modal;
        var id = state["id"]?.ToString() ?? "";
        if (!id.StartsWith("m:", StringComparison.Ordinal)) return null;
        var at = id.IndexOf('@');
        return at > 2 ? id[2..at] : id[2..];
    }

    /// <summary>The explored states of the capture; without any, the canonical state of each view.</summary>
    private static IEnumerable<JsonObject> States(JsonObject capture)
    {
        var explored = (capture["explored"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        if (explored.Count > 0) return explored;
        return (capture["views"] as JsonArray ?? []).OfType<JsonObject>().Select(v => new JsonObject
        {
            ["id"] = "v:" + v["key"] + "@canonical", ["view"] = v["key"]?.ToString(), ["assign"] = v["state"]?.DeepClone() ?? new JsonObject(),
        });
    }

    internal sealed class RenderContext(JsonObject capture, string platform)
    {
        public string StateId = "";
        public readonly JsonArray UnevaluableReport = [];
        public readonly Dictionary<string, int> Unverified = new(StringComparer.Ordinal);
        private readonly string _prefix = capture["app"]?["prefix"]?.ToString() ?? "";
        private readonly JsonObject? _nativeKeys = capture["nativeKeys"] as JsonObject;

        public Scope StateScope(RootModel model, IReadOnlyList<Variable> clients, JsonObject state)
        {
            var scope = new Scope(Rows);
            foreach (var client in clients) scope.Client[client.Name] = Initial(client, scope);
            foreach (var input in model.Inputs) scope.Vars[input.Name] = Initial(input, scope);
            foreach (var local in model.Locals) scope.Vars[local.Name] = Initial(local, scope);
            foreach (var aggregate in model.Aggregates) scope.Aggregates[aggregate.Name] = aggregate;
            // The state: each dimension assigned (a global one is a Client Variable <Prefix><Name>, a screen one a local <Name>),
            // the view's route parameters, the open modal.
            var dimensions = (capture["dimensions"] as JsonArray ?? []).OfType<JsonObject>().ToDictionary(d => d["key"]?.ToString() ?? "", d => d, StringComparer.Ordinal);
            foreach (var (key, value) in state["assign"] as JsonObject ?? [])
            {
                var name = dimensions.TryGetValue(key, out var d) ? d["name"]?.ToString() ?? key : key;
                var type = d?["type"]?.ToString();
                var typed = Typed(value?.ToString(), type);
                if (scope.Client.ContainsKey(_prefix + name)) scope.Client[_prefix + name] = typed;
                if (scope.Client.ContainsKey(name)) scope.Client[name] = typed;
                if (scope.Vars.ContainsKey(name)) scope.Vars[name] = typed;
            }
            var view = (capture["views"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(v => v["key"]?.ToString() == state["view"]?.ToString());
            foreach (var (name, value) in RouteParameters(view)) if (scope.Vars.ContainsKey(name)) scope.Vars[name] = value;
            foreach (var (name, value) in state["params"] as JsonObject ?? []) if (scope.Vars.ContainsKey(name)) scope.Vars[name] = Json(value);
            // OnInitialize as the runtime runs it before the first render: the locals of the global dimensions from their Client
            // Variables (the state's values)
            RunLifecycle(model, scope);
            if (ModalOf(state) is { Length: > 0 } modalKey)
            {
                var modal = (capture["modals"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(m => m["key"]?.ToString() == modalKey);
                var popup = modal?["name"]?.ToString() ?? modalKey;
                if (scope.Vars.ContainsKey(popup + "IsOpen")) scope.Vars[popup + "IsOpen"] = true;
                // opened by its first trigger: the first item of the list the popup reads by position (ListIndexOf)
                foreach (var index in new[] { popup + "Indice", popup + "Index" }) if (scope.Vars.ContainsKey(index)) scope.Vars[index] = 0L;
                foreach (var (name, value) in state["modalParams"] as JsonObject ?? []) if (scope.Vars.ContainsKey(popup + name)) scope.Vars[popup + name] = Json(value);
            }
            return scope;
        }

        private static IEnumerable<(string, object?)> RouteParameters(JsonObject? view)
        {
            if (view?["template"]?.ToString() is not { } template || view["route"]?.ToString() is not { } route) yield break;
            var t = template.Trim('#', '/').Split('/'); var r = route.Trim('#', '/').Split('/');
            if (t.Length != r.Length) yield break;
            for (var i = 0; i < t.Length; i++)
                if (t[i].StartsWith('{') && t[i].EndsWith('}'))
                {
                    var name = t[i][1..^1]; name = char.ToUpperInvariant(name[0]) + name[1..];
                    yield return (name, long.TryParse(r[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : r[i]);
                }
        }

        private object? Initial(Variable variable, Scope scope)
        {
            if (!string.IsNullOrWhiteSpace(variable.Default))
            {
                try { return Expressions.Evaluate(variable.Default!, scope); } catch (UnevaluableException) { }
            }
            return Expressions.DefaultOf(variable.Type);
        }

        /// <summary>The assign-only lifecycle of a root (ReadRoot): each assignment evaluated in the scope, in order; one that cannot
        /// be evaluated leaves its variable as it is.</summary>
        private static void RunLifecycle(RootModel model, Scope scope)
        {
            foreach (var (variable, value) in model.Lifecycle)
            {
                object? result;
                try { result = Expressions.Evaluate(value, scope); } catch (UnevaluableException) { continue; }
                if (variable.StartsWith("Client.", StringComparison.OrdinalIgnoreCase)) scope.Client[variable["Client.".Length..]] = result;
                else scope.Vars[variable] = result;
            }
        }

        private static object? Typed(string? value, string? type) => type switch
        {
            "Integer" or "LongInteger" when long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) => n,
            "Boolean" => value is "true" or "True" or "1",
            "Decimal" when decimal.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
            _ => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) && type == null ? i : value,
        };

        private static object? Json(JsonNode? node) => node switch
        {
            JsonValue v when v.TryGetValue<long>(out var l) => l,
            JsonValue v when v.TryGetValue<decimal>(out var d) => d,
            JsonValue v when v.TryGetValue<bool>(out var b) => b,
            JsonValue v when v.TryGetValue<string>(out var s) => s,
            _ => null,
        };

        /// <summary>The seed rows of an entity: the capture's collection whose name is the entity name without the prefix.</summary>
        private List<Dictionary<string, object?>>? Rows(string entity)
        {
            // the static entities the compiler creates itself (options of a select) come with their records
            if (capture["nativeRows"]?[entity] is JsonArray created)
                return created.OfType<JsonObject>().Select(r => r.ToDictionary(p => p.Key, p => Json(p.Value), StringComparer.OrdinalIgnoreCase)).ToList();
            var name = capture["nativeEntities"]?[entity]?.ToString()
                ?? (entity.StartsWith(_prefix, StringComparison.Ordinal) && entity.Length > _prefix.Length ? entity[_prefix.Length..] : entity);
            var collection = (capture["store"]?["collections"] as JsonArray ?? []).OfType<JsonObject>()
                .FirstOrDefault(c => string.Equals(c["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase) || string.Equals(c["name"]?.ToString(), entity, StringComparison.OrdinalIgnoreCase));
            if (collection == null) return null;
            return (collection["rows"] as JsonArray ?? []).OfType<JsonObject>()
                .Select(r => r.ToDictionary(p => p.Key, p => Json(p.Value), StringComparer.OrdinalIgnoreCase)).ToList();
        }

        private string? Eval(NativeWidget widget, string? expression, Scope scope, out bool failed)
        {
            failed = false;
            if (expression == null) return null;
            try { return Expressions.ToText(Expressions.Evaluate(expression, scope)); }
            catch (UnevaluableException ex) { failed = true; Unevaluable(widget, expression, ex.Message); return null; }
        }

        private void Unevaluable(NativeWidget widget, string expression, string why) => UnevaluableReport.Add(new JsonObject
        {
            ["state"] = StateId, ["widget"] = "I" + widget.Kind, ["name"] = widget.Name, ["key"] = widget.Key, ["expression"] = expression, ["why"] = why,
        });

        private void Count(RuntimeDomRow? row, NativeWidget widget)
        {
            var name = row?.Widget ?? "I" + widget.Kind;
            if (row == null || RuntimeDomTable.Unverified(platform, name)) Unverified[name] = Unverified.GetValueOrDefault(name) + 1;
        }

        private DomNode Mark(DomNode node, NativeWidget widget)
        {
            node.Widget = "I" + widget.Kind; node.Name = string.IsNullOrEmpty(widget.Name) ? null : widget.Name; node.ObjectKey = widget.Key;
            if (widget.Key != null && _nativeKeys?[widget.Key]?.ToString() is { } k) node.K = k;
            return node;
        }

        public void RenderWidget<T>(NativeWidget widget, DomNode parent, Scope scope, ModelReader<T> reader, IReadOnlyDictionary<string, T> roots,
            Func<T, string, RootModel> model, IReadOnlyDictionary<string, (List<NativeWidget> Widgets, Scope Scope)>? placeholders = null) where T : class
        {
            var row = RuntimeDomTable.Row(platform, widget.Kind);
            void Children(IEnumerable<NativeWidget> children, DomNode host, Scope s)
            {
                foreach (var child in children) RenderWidget(child, host, s, reader, roots, model, placeholders);
            }
            switch (widget.Basic)
            {
                case "If" or "IfWidget":
                {
                    Count(row, widget);
                    var condition = widget.Props.GetValueOrDefault("Condition") ?? "True";
                    object? value;
                    try { value = Expressions.Evaluate(condition, scope); }
                    catch (UnevaluableException ex) { Unevaluable(widget, condition, ex.Message); parent.Add(Mark(new DomNode { Unevaluable = condition }, widget)); return; }
                    Children(Expressions.Truthy(value) ? widget.Children : widget.Else ?? [], parent, scope);
                    return;
                }
                case "List":
                {
                    Count(row, widget);
                    var source = widget.Props.GetValueOrDefault("Source") ?? "";
                    var element = parent.Add(Mark(DomNode.Element(widget.Props.GetValueOrDefault("Tag") is { Length: > 0 } tag ? Unquote(tag) : "div"), widget));
                    Attributes(element, widget, row, scope);
                    List<object?> items;
                    try { items = Expressions.Evaluate(source, scope) is ListValue list ? list.Items : throw new UnevaluableException("the list source is not a list"); }
                    catch (UnevaluableException ex) { Unevaluable(widget, source, ex.Message); element.Add(Mark(new DomNode { Unevaluable = source }, widget)); return; }
                    var owner = Expressions.ListOwner(source);
                    foreach (var item in items)
                    {
                        var inner = scope.With(owner, item);
                        Children(widget.Children, element, inner);
                    }
                    return;
                }
                case "Popup":
                {
                    Count(row, widget);
                    var show = widget.Props.GetValueOrDefault("ShowPopup") ?? "False";
                    object? value;
                    try { value = Expressions.Evaluate(show, scope); }
                    catch (UnevaluableException ex) { Unevaluable(widget, show, ex.Message); parent.Add(Mark(new DomNode { Unevaluable = show }, widget)); return; }
                    if (!Expressions.Truthy(value)) return;
                    var host = parent;
                    foreach (var wrapper in row?.Wrappers ?? []) host = host.Add(Runtime(row!, wrapper));
                    Mark(host, widget);
                    Children(widget.Children, host, scope);
                    return;
                }
                case "PlaceholderContent":
                    Children(widget.Children, parent, scope);
                    return;
                case "Placeholder":
                {
                    Count(row, widget);
                    var host = row is { Element: not null } ? parent.Add(Transparent(row)) : parent;
                    if (placeholders != null && placeholders.TryGetValue(widget.Name ?? "", out var content))
                        foreach (var child in content.Widgets) RenderWidget(child, host, content.Scope, reader, roots, model, null);
                    return;
                }
            }
            if (widget.Kind.Contains("BlockInstance", StringComparison.Ordinal))
            {
                Count(row, widget);
                var host = parent;
                if (row is { Element: not null }) { host = parent.Add(Transparent(row)); Mark(host, widget); }
                if (widget.SourceBlock is not T block)
                {
                    parent.Add(Mark(new DomNode { Unevaluable = "SourceBlock" }, widget));
                    return;
                }
                var blockName = reader.NameOf(block);
                host.SetAttr("data-block", blockName);
                var blockModel = model(block, "b:" + reader.KeyOf(block));
                var blockScope = new Scope(scope.RowsOf);
                foreach (var (name, value) in scope.Client) blockScope.Client[name] = value;
                foreach (var input in blockModel.Inputs) blockScope.Vars[input.Name] = Initial(input, blockScope);
                foreach (var local in blockModel.Locals) blockScope.Vars[local.Name] = Initial(local, blockScope);
                foreach (var aggregate in blockModel.Aggregates) blockScope.Aggregates[aggregate.Name] = aggregate;
                foreach (var (parameter, value) in widget.Arguments)
                {
                    try { blockScope.Vars[parameter] = Expressions.Evaluate(value, scope); }
                    catch (UnevaluableException ex) { Unevaluable(widget, value, ex.Message); }
                }
                RunLifecycle(blockModel, blockScope);
                var contents = widget.Contents.ToDictionary(c => c.Key, c => (c.Value, scope), StringComparer.OrdinalIgnoreCase);
                if (blockModel.Widgets.Count == 0)
                {
                    // A block of another module (a reference keeps only its signature): its own widgets are not in this
                    // model, so the contents of the instance render in place, in order, and the block is listed.
                    Unevaluable(widget, "SourceBlock " + blockName, "the block's widgets are not in this module (a reference); its placeholder contents rendered in place");
                    foreach (var (_, content) in widget.Contents) Children(content, host, scope);
                    return;
                }
                foreach (var child in blockModel.Widgets) RenderWidget(child, host, blockScope, reader, roots, model, contents);
                return;
            }
            Count(row, widget);
            if (row?.Element == "#text" || widget.Basic == "Text")
            {
                parent.Add(Mark(DomNode.TextNode(widget.Props.GetValueOrDefault("Text") ?? ""), widget));
                return;
            }
            var hostElement = parent;
            foreach (var wrapper in row?.Wrappers ?? []) hostElement = hostElement.Add(Runtime(row!, wrapper));
            var tagName = row?.Element is { } e && !e.StartsWith('{') ? e : widget.Props.GetValueOrDefault("Tag") is { Length: > 0 } t ? Unquote(t) : "div";
            var node = hostElement.Add(Mark(DomNode.Element(tagName), widget));
            Attributes(node, widget, row, scope);
            switch (widget.Basic)
            {
                case "Expression" or "InlineExpression":
                {
                    var value = Eval(widget, widget.Props.GetValueOrDefault("Value") ?? "\"\"", scope, out var failed);
                    // the expression's element is the runtime's (a runtime span the author's span selectors exclude); its text is the
                    // prototype's text node, so the text carries the key
                    var text = failed ? Mark(new DomNode { Unevaluable = widget.Props.GetValueOrDefault("Value") }, widget) : DomNode.TextNode(value ?? "");
                    if (!failed) { text.K = node.K; text.Widget = node.Widget; text.ObjectKey = node.ObjectKey; }
                    node.K = null; node.Runtime = "IExpression";
                    node.Add(text);
                    return;
                }
                case "Checkbox":
                    if (widget.Props.GetValueOrDefault("Variable") is { Length: > 0 } variable)
                    {
                        try { if (Expressions.Truthy(Expressions.Evaluate(variable, scope))) node.SetAttr("checked", ""); } catch (UnevaluableException) { }
                    }
                    return;
                case "Input" or "TextArea":
                    if (widget.Props.GetValueOrDefault("InputType") is { Length: > 0 } inputType && widget.Basic == "Input") node.SetAttr("type", InputType(inputType));
                    // a controlled input shows its variable as its value (inferred row until stage 0 confirms the attribute)
                    if (widget.Basic == "Input" && widget.Props.GetValueOrDefault("Variable") is { Length: > 0 } bound)
                        try { node.SetAttr("value", Expressions.ToText(Expressions.Evaluate(bound, scope))); } catch (UnevaluableException) { }
                    if (widget.Props.GetValueOrDefault("Prompt") is { Length: > 0 } prompt && Eval(widget, prompt, scope, out _) is { Length: > 0 } placeholder) node.SetAttr("placeholder", placeholder);
                    // the maximum length of the text is the element's maxlength (inferred row until stage 0)
                    if (widget.Props.GetValueOrDefault("MaxLength") is { Length: > 0 } maxLength && maxLength != "0" && long.TryParse(maxLength, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)) node.SetAttr("maxlength", maxLength);
                    return;
                case "Dropdown" or "ComboBox":
                    Options(node, widget, scope);
                    return;
            }
            Children(widget.Children, node, scope);
        }

        private void Attributes(DomNode element, NativeWidget widget, RuntimeDomRow? row, Scope scope)
        {
            foreach (var (name, value) in row?.Attributes ?? []) if (name.StartsWith("data-", StringComparison.Ordinal)) element.Attributes.Add((name, value));
            var classes = new List<string>();
            foreach (var (name, value) in row?.Attributes ?? []) if (name == "class") classes.AddRange(value.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            var style = widget.Props.GetValueOrDefault("Style") ?? widget.Props.GetValueOrDefault("StyleClasses");
            var classUnevaluable = false;
            if (!string.IsNullOrWhiteSpace(style) && Eval(widget, style, scope, out classUnevaluable) is { } evaluated) classes.AddRange(evaluated.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            var extended = new List<(string, string)>();
            foreach (var (name, expression) in widget.Extended)
            {
                var value = Eval(widget, expression, scope, out var failed);
                if (failed) continue;
                if (name == "class") classes.AddRange((value ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries));
                // a boolean attribute as the runtime (React) renders it: dropped when empty, present and empty otherwise
                else if (PrototypeWidgets.BooleanAttributes.Contains(name)) { if (!string.IsNullOrEmpty(value)) extended.Add((name, "")); }
                else extended.Add((name, value ?? ""));
            }
            if (classes.Count > 0 || row?.Attributes.Any(a => a.Name == "class") == true || classUnevaluable)
                element.Attributes.Add(("class", string.Join(" ", classes.Distinct(StringComparer.Ordinal))));
            foreach (var (name, value) in row?.Attributes ?? []) if (!name.StartsWith("data-", StringComparison.Ordinal) && name != "class") element.Attributes.Add((name, value));
            // CustomStyle is the inline style as text (ElementWidgetMap writes it raw); a quoted literal is read as one
            if (widget.Props.GetValueOrDefault("CustomStyle") is { Length: > 0 } custom
                && (custom.Length >= 2 && custom[0] == '"' && custom[^1] == '"' ? Eval(widget, custom, scope, out _) : custom) is { Length: > 0 } inline) element.SetAttr("style", inline);
            foreach (var (name, value) in extended) element.SetAttr(name, value);
            // a control that is not enabled is disabled at runtime
            if (widget.Basic is "Button" or "Input" or "TextArea" or "Dropdown" or "ComboBox" or "Checkbox" or "Link"
                && widget.Props.GetValueOrDefault("Enabled") is { Length: > 0 } enabled)
                try { if (!Expressions.Truthy(Expressions.Evaluate(enabled, scope))) element.SetAttr("disabled", ""); } catch (UnevaluableException) { }
            if (row?.IdRule is "name" or "block" && !string.IsNullOrEmpty(widget.Name)) element.SetAttr("id", widget.Name!);
        }

        /// <summary>The options of a dropdown: one &lt;option&gt; per item of its List, with the label and value its Labels and
        /// Values read on the item, the one equal to the Variable selected (an inferred row until stage 0 confirms the runtime's
        /// option attributes).</summary>
        private void Options(DomNode select, NativeWidget widget, Scope scope)
        {
            if (widget.Props.GetValueOrDefault("List") is not { Length: > 0 } listExpression) return;
            var labels = widget.Props.GetValueOrDefault("Labels");
            var values = widget.Props.GetValueOrDefault("Values");
            ListValue options;
            try { options = Expressions.Evaluate(listExpression, scope) as ListValue ?? throw new UnevaluableException("the options list is not a list"); }
            catch (UnevaluableException ex) { Unevaluable(widget, listExpression, ex.Message); return; }
            object? selected = null;
            if (widget.Props.GetValueOrDefault("Variable") is { Length: > 0 } variable)
                try { selected = Expressions.Evaluate(variable, scope); } catch (UnevaluableException) { }
            var owner = Expressions.ListOwner(listExpression);
            var index = 0;
            foreach (var item in options.Items)
            {
                var itemScope = scope.With(owner, item);
                if (item is RecordValue record) foreach (var (name, value) in record.Fields) itemScope.Vars[name] = value;
                var option = DomNode.Element("option");
                option.K = (select.K ?? select.Name ?? "select") + "/option/" + index++;
                try
                {
                    var value = values is { Length: > 0 } ? Expressions.Evaluate(values, itemScope) : null;
                    option.SetAttr("value", Expressions.ToText(value));
                    if (selected != null && value != null && Expressions.Comparer.Compare(value, selected) == 0) option.SetAttr("selected", "");
                    option.Add(DomNode.TextNode(labels is { Length: > 0 } ? Expressions.ToText(Expressions.Evaluate(labels, itemScope)) : ""));
                }
                catch (UnevaluableException ex) { Unevaluable(widget, values ?? labels ?? "", ex.Message); }
                select.Add(option);
            }
        }

        private static string InputType(string value) => Unquote(value).Replace("Entities.InputType.", "", StringComparison.Ordinal).ToLowerInvariant() switch
        {
            "text" or "" => "text", "password" => "password", "email" => "email", "number" => "number", "phone" or "tel" => "tel",
            "search" => "search", "date" => "date", "time" => "time", "datetime" => "datetime-local", var other => other,
        };

        private static string Unquote(string text) => text.Length >= 2 && text[0] == '"' && text[^1] == '"' ? text[1..^1] : text;

        private DomNode Runtime(RuntimeDomRow row, RuntimeWrapper wrapper)
        {
            var element = DomNode.Element(wrapper.Tag);
            foreach (var a in wrapper.Attributes) element.Attributes.Add(a);
            if (wrapper.Classes.Count > 0) element.Attributes.Add(("class", string.Join(" ", wrapper.Classes)));
            element.Runtime = row.Widget;
            return element;
        }

        private DomNode Transparent(RuntimeDomRow row)
        {
            var element = DomNode.Element(row.Element!.StartsWith('{') ? "div" : row.Element);
            foreach (var a in row.Attributes) element.Attributes.Add(a);
            element.Runtime = row.Widget;
            return element;
        }
    }

    // ---- expressions: the closed subset ---------------------------------------------------------------------------

    public sealed class UnevaluableException(string message) : Exception(message);

    /// <summary>A list value (an aggregate's List, a list variable).</summary>
    public sealed class ListValue(List<object?> items, string? owner = null)
    {
        public List<object?> Items { get; } = items;
        public string? Owner { get; } = owner;
    }

    /// <summary>A record: an aggregate row (alias → entity record) or an entity record (attribute → value).</summary>
    public sealed class RecordValue(Dictionary<string, object?> fields)
    {
        public Dictionary<string, object?> Fields { get; } = new(fields, StringComparer.OrdinalIgnoreCase);
        /// <summary>The record of an empty list's Current (the runtime gives the default record): every attribute is its default
        /// (an empty text, 0, False).</summary>
        public bool IsDefault { get; private init; }
        public static readonly RecordValue Default = new(new Dictionary<string, object?>()) { IsDefault = true };
    }

    internal sealed class Scope(Func<string, List<Dictionary<string, object?>>?> rows)
    {
        public Func<string, List<Dictionary<string, object?>>?> RowsOf { get; } = rows;
        public Dictionary<string, object?> Vars { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, object?> Client { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, Aggregate> Aggregates { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, object?> Current { get; } = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, ListValue> _evaluated = new(StringComparer.OrdinalIgnoreCase);
        public Scope? Outer { get; init; }

        public Scope With(string? owner, object? current)
        {
            var inner = new Scope(RowsOf) { Outer = this };
            foreach (var (k, v) in Vars) inner.Vars[k] = v;
            foreach (var (k, v) in Client) inner.Client[k] = v;
            foreach (var (k, v) in Aggregates) inner.Aggregates[k] = v;
            foreach (var (k, v) in Current) inner.Current[k] = v;
            foreach (var (k, v) in _evaluated) inner._evaluated[k] = v;
            if (owner != null) inner.Current[owner] = current;
            return inner;
        }

        public ListValue AggregateList(Aggregate aggregate)
        {
            if (_evaluated.TryGetValue(aggregate.Name, out var cached)) return cached;
            if (aggregate.Sources.Count == 0) throw new UnevaluableException($"aggregate {aggregate.Name}: no source");
            if (aggregate.Joined && aggregate.Joins.Count != aggregate.Sources.Count - 1)
                throw new UnevaluableException($"aggregate {aggregate.Name}: {aggregate.Sources.Count} sources and {aggregate.Joins.Count} joins; only sources joined by a condition are evaluated over the seed");
            // the root source: the one no join brings in (the model does not keep the sources in the order they were added)
            bool Named((string Entity, string Alias) s, string name) => string.Equals(s.Alias, name, StringComparison.OrdinalIgnoreCase) || string.Equals(s.Entity, name, StringComparison.OrdinalIgnoreCase);
            var (entity, alias) = aggregate.Sources.FirstOrDefault(s => !aggregate.Joins.Any(j => Named(s, j.Right)));
            if (entity == null) (entity, alias) = aggregate.Sources[0];
            var data = RowsOf(entity) ?? throw new UnevaluableException($"aggregate {aggregate.Name}: no seed rows for {entity}");
            var joinedRows = new List<RecordValue>();
            foreach (var row in data)
            {
                var record = new RecordValue(new Dictionary<string, object?> { [alias] = new RecordValue(row) });
                if (!string.Equals(alias, entity, StringComparison.OrdinalIgnoreCase)) record.Fields[entity] = record.Fields[alias];
                joinedRows.Add(record);
            }
            // the joins in order, each over the seed rows of its source: a row per match; a left join (With or Without) keeps the
            // row without a match with an empty record
            foreach (var (_, right, condition, kind) in aggregate.Joins)
            {
                var source = aggregate.Sources.FirstOrDefault(s => Named(s, right));
                if (source == default) throw new UnevaluableException($"aggregate {aggregate.Name}: the join source {right} is not a source");
                var other = RowsOf(source.Entity) ?? throw new UnevaluableException($"aggregate {aggregate.Name}: no seed rows for {source.Entity}");
                var keepUnmatched = kind.Replace(" ", "", StringComparison.Ordinal) is "Left" or "WithOrWithout" or "LeftOuter";
                var next = new List<RecordValue>();
                foreach (var record in joinedRows)
                {
                    var matched = false;
                    foreach (var row in other)
                    {
                        var candidate = new RecordValue(record.Fields) { };
                        candidate.Fields[source.Alias] = new RecordValue(row);
                        if (!string.Equals(source.Alias, source.Entity, StringComparison.OrdinalIgnoreCase)) candidate.Fields[source.Entity] = candidate.Fields[source.Alias];
                        var rowScope = With(null, null);
                        foreach (var (name, value) in candidate.Fields) rowScope.Vars[name] = value;
                        bool joins;
                        try { joins = Expressions.Truthy(Expressions.Evaluate(condition, rowScope)); }
                        catch (UnevaluableException ex)
                        {
                            throw new UnevaluableException($"aggregate {aggregate.Name} (sources {string.Join(", ", aggregate.Sources.Select(s => s.Entity + " as " + s.Alias))}; names {string.Join(", ", candidate.Fields.Keys)}), join {condition}: {ex.Message}");
                        }
                        if (!joins) continue;
                        next.Add(candidate); matched = true;
                    }
                    if (!matched && keepUnmatched)
                    {
                        var empty = new RecordValue(other.FirstOrDefault()?.ToDictionary(p => p.Key, p => (object?)null) ?? new Dictionary<string, object?>());
                        var candidate = new RecordValue(record.Fields);
                        candidate.Fields[source.Alias] = empty;
                        if (!string.Equals(source.Alias, source.Entity, StringComparison.OrdinalIgnoreCase)) candidate.Fields[source.Entity] = empty;
                        next.Add(candidate);
                    }
                }
                joinedRows = next;
            }
            var rows = new List<RecordValue>();
            foreach (var record in joinedRows)
            {
                var keep = true;
                foreach (var filter in aggregate.Filters)
                {
                    var rowScope = With(null, null);
                    foreach (var (name, value) in record.Fields) rowScope.Vars[name] = value;
                    try { if (!Expressions.Truthy(Expressions.Evaluate(filter, rowScope))) { keep = false; break; } }
                    catch (UnevaluableException ex)
                    {
                        throw new UnevaluableException($"aggregate {aggregate.Name} (sources {string.Join(", ", aggregate.Sources.Select(s => s.Entity + " as " + s.Alias))}), filter {filter}: {ex.Message}");
                    }
                }
                if (keep) rows.Add(record);
            }
            IEnumerable<RecordValue> ordered = rows;
            for (var s = aggregate.Sorts.Count - 1; s >= 0; s--)
            {
                var (attribute, descending) = aggregate.Sorts[s];
                object? Key(RecordValue r)
                {
                    var rs = With(null, null); foreach (var (n, v) in r.Fields) rs.Vars[n] = v;
                    try { return Expressions.Evaluate(attribute, rs); }
                    catch (UnevaluableException ex) { throw new UnevaluableException($"aggregate {aggregate.Name} (names {string.Join(", ", r.Fields.Keys)}), sort {attribute}: {ex.Message}"); }
                }
                var keyed = ordered.Select(r => (Row: r, Key: Key(r))).ToList();
                ordered = (descending ? keyed.OrderByDescending(x => x.Key, Expressions.Comparer) : keyed.OrderBy(x => x.Key, Expressions.Comparer)).Select(x => x.Row).ToList();
            }
            // the order Ordenar<Lista> gives after the fetch: the first case whose condition holds sorts by its attribute
            foreach (var (when, by, ascending) in aggregate.AfterFetchSorts)
            {
                if (!Expressions.Truthy(Expressions.Evaluate(when, With(null, null)))) continue;
                var up = Expressions.Truthy(Expressions.Evaluate(ascending, With(null, null)));
                object? SortKey(RecordValue r) { var rs = With(null, null); foreach (var (n, v) in r.Fields) rs.Vars[n] = v; return Expressions.Evaluate(by, rs); }
                var keyed = ordered.Select(r => (Row: r, Key: SortKey(r))).ToList();
                ordered = (up ? keyed.OrderBy(x => x.Key, Expressions.Comparer) : keyed.OrderByDescending(x => x.Key, Expressions.Comparer)).Select(x => x.Row).ToList();
                break;
            }
            var list = ordered.Cast<object?>().ToList();
            if (aggregate.Max is { } max && long.TryParse(max, NumberStyles.Integer, CultureInfo.InvariantCulture, out var limit) && limit >= 0 && list.Count > limit) list = list.Take((int)limit).ToList();
            // aggregation columns without group by: one row with each column computed over the rows kept
            if (aggregate.Columns.Count > 0)
            {
                var fields = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (var (name, attribute, function) in aggregate.Columns)
                {
                    var values = list.OfType<RecordValue>().Select(r => { var rs = With(null, null); foreach (var (n, v) in r.Fields) rs.Vars[n] = v; return Expressions.Evaluate(attribute, rs); }).ToList();
                    fields[name] = function switch
                    {
                        "Sum" => values.Aggregate(0m, (sum, v) => sum + Expressions.ToDecimalValue(v)) is var total && values.All(v => v is long or int) ? (object)(long)total : total,
                        "Count" => (long)values.Count(v => v != null),
                        "Max" => values.Where(v => v != null).Max(Expressions.Comparer),
                        "Min" => values.Where(v => v != null).Min(Expressions.Comparer),
                        "Average" => values.Count == 0 ? 0m : values.Aggregate(0m, (sum, v) => sum + Expressions.ToDecimalValue(v)) / values.Count,
                        _ => throw new UnevaluableException($"aggregate {aggregate.Name}: aggregation {function} is outside the evaluated subset"),
                    };
                }
                list = [new RecordValue(fields)];
            }
            return _evaluated[aggregate.Name] = new ListValue(list, aggregate.Name);
        }
    }

    /// <summary>The evaluator of the closed expression subset the prototype compiler emits: literals, variables (locals,
    /// inputs, Client.X), aggregate lists (List, Current, Length, [i], Count, Empty), record attributes, + - * /, comparisons,
    /// and/or/not, and the functions of the format and logic tables. Anything else throws <see cref="UnevaluableException"/>.</summary>
    internal static class Expressions
    {
        public static readonly IReadOnlySet<string> Functions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "If", "IntegerToText", "LongIntegerToText", "DecimalToText", "FormatDecimal", "FormatDateTime", "FormatText", "Substr", "Index",
            "Length", "ToLower", "ToUpper", "Trim", "TrimStart", "TrimEnd", "Replace", "Month", "Year", "Day", "Hour", "Minute",
            "Max", "Min", "Abs", "Round", "Trunc", "TextToInteger", "TextToDecimal", "IntegerToDecimal", "DecimalToInteger",
            "NullIdentifier", "NullTextIdentifier", "NullDate", "BooleanToText", "Chr", "NewLine",
            // the conversions the compiler writes between entity identifiers, integers and long integers (an identity here)
            "IdentifierToInteger", "IntegerToIdentifier", "LongIntegerToInteger", "IntegerToLongInteger", "IdentifierToLongInteger", "LongIntegerToIdentifier",
            "DateTimeToText",
        };

        public static decimal ToDecimalValue(object? value) => value == null ? 0m : ToDecimal(value);

        public static object? DefaultOf(string? type) => type switch
        {
            null => null,
            "Integer" or "LongInteger" => 0L,
            "Decimal" or "Currency" => 0m,
            "Boolean" => false,
            "Text" or "Email" or "Phone Number" => "",
            "Date" or "Date Time" or "DateTime" => new DateTime(1900, 1, 1),
            _ when type.EndsWith("Identifier", StringComparison.Ordinal) => 0L,
            _ => null,
        };

        public static bool Truthy(object? value) => value switch { bool b => b, null => false, string s => s.Length > 0, long l => l != 0, decimal d => d != 0, RecordValue { IsDefault: true } => false, _ => true };

        public static string ToText(object? value) => value switch
        {
            null => "",
            RecordValue { IsDefault: true } => "",
            string s => s,
            bool b => b ? "True" : "False",
            long l => l.ToString(CultureInfo.InvariantCulture),
            int i => i.ToString(CultureInfo.InvariantCulture),
            decimal d => d.ToString("0.############################", CultureInfo.InvariantCulture),
            double f => f.ToString(CultureInfo.InvariantCulture),
            DateTime t => t.TimeOfDay == TimeSpan.Zero ? t.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : t.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
            _ => value.ToString() ?? "",
        };

        public static readonly IComparer<object?> Comparer = Comparer<object?>.Create(Compare);

        private static int Compare(object? a, object? b)
        {
            if (a is RecordValue { IsDefault: true }) a = null;
            if (b is RecordValue { IsDefault: true }) b = null;
            if (a == null && b == null) return 0;
            if (a == null) return -1;
            if (b == null) return 1;
            if (IsNumber(a) && IsNumber(b)) return ToDecimal(a).CompareTo(ToDecimal(b));
            if (a is DateTime x && b is DateTime y) return x.CompareTo(y);
            if (a is bool p && b is bool q) return p.CompareTo(q);
            return string.Compare(ToText(a), ToText(b), StringComparison.Ordinal);
        }

        /// <summary>The aggregate (or list variable) a list source expression names: "GetProducts.List" → "GetProducts".</summary>
        public static string? ListOwner(string source)
        {
            var text = source.Trim();
            var dot = text.IndexOf('.');
            return dot > 0 ? text[..dot] : text.Length > 0 ? text : null;
        }

        public static object? Evaluate(string expression, Scope scope)
        {
            var parser = new ExprParser(expression);
            var node = parser.Parse();
            return Eval(node, scope);
        }

        private abstract record Node;
        private sealed record Literal(object? Value) : Node;
        private sealed record Name(string Id) : Node;
        private sealed record Member(Node Target, string Id) : Node;
        private sealed record Indexed(Node Target, Node Index) : Node;
        private sealed record Call(string Function, List<Node> Arguments) : Node;
        private sealed record Unary(string Op, Node Operand) : Node;
        private sealed record Binary(string Op, Node Left, Node Right) : Node;

        private sealed class ExprParser(string text)
        {
            private int _i;
            private UnevaluableException Fail(string why) => new($"cannot parse '{text}': {why}");

            public Node Parse()
            {
                var node = Or();
                Space();
                if (_i < text.Length) throw Fail($"unexpected '{text[_i]}'");
                return node;
            }

            private void Space() { while (_i < text.Length && char.IsWhiteSpace(text[_i])) _i++; }
            private bool Keyword(string word)
            {
                Space();
                if (_i + word.Length <= text.Length && string.Compare(text, _i, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) == 0
                    && (_i + word.Length == text.Length || !(char.IsLetterOrDigit(text[_i + word.Length]) || text[_i + word.Length] == '_')))
                { _i += word.Length; return true; }
                return false;
            }
            private bool Symbol(string symbol)
            {
                Space();
                if (string.CompareOrdinal(text, _i, symbol, 0, symbol.Length) == 0) { _i += symbol.Length; return true; }
                return false;
            }

            private Node Or() { var left = And(); while (Keyword("or")) left = new Binary("or", left, And()); return left; }
            private Node And() { var left = Not(); while (Keyword("and")) left = new Binary("and", left, Not()); return left; }
            private Node Not() => Keyword("not") ? new Unary("not", Not()) : Comparison();
            private Node Comparison()
            {
                var left = Additive();
                while (true)
                {
                    string? op = Symbol("<>") ? "<>" : Symbol("<=") ? "<=" : Symbol(">=") ? ">=" : Symbol("=") ? "=" : Symbol("<") ? "<" : Symbol(">") ? ">" : null;
                    if (op == null) return left;
                    left = new Binary(op, left, Additive());
                }
            }
            private Node Additive()
            {
                var left = Multiplicative();
                while (true)
                {
                    if (Symbol("+")) left = new Binary("+", left, Multiplicative());
                    else if (Symbol("-")) left = new Binary("-", left, Multiplicative());
                    else return left;
                }
            }
            private Node Multiplicative()
            {
                var left = Prefix();
                while (true)
                {
                    if (Symbol("*")) left = new Binary("*", left, Prefix());
                    else if (Symbol("/")) left = new Binary("/", left, Prefix());
                    else return left;
                }
            }
            private Node Prefix() => Symbol("-") ? new Unary("-", Prefix()) : Postfix(Primary());
            private Node Postfix(Node node)
            {
                while (true)
                {
                    Space();
                    if (_i < text.Length && text[_i] == '.') { _i++; node = new Member(node, Identifier()); }
                    else if (_i < text.Length && text[_i] == '[') { _i++; var index = Or(); if (!Symbol("]")) throw Fail("expected ']'"); node = new Indexed(node, index); }
                    else return node;
                }
            }
            private Node Primary()
            {
                Space();
                if (_i >= text.Length) throw Fail("unexpected end");
                var c = text[_i];
                if (c == '(') { _i++; var inner = Or(); if (!Symbol(")")) throw Fail("expected ')'"); return inner; }
                if (c == '"')
                {
                    _i++; var sb = new StringBuilder();
                    while (_i < text.Length)
                    {
                        if (text[_i] == '"' && _i + 1 < text.Length && text[_i + 1] == '"') { sb.Append('"'); _i += 2; continue; }
                        if (text[_i] == '\\' && _i + 1 < text.Length && text[_i + 1] == '"') { sb.Append('"'); _i += 2; continue; }
                        if (text[_i] == '"') break;
                        sb.Append(text[_i]); _i++;
                    }
                    if (_i >= text.Length) throw Fail("unterminated text");
                    _i++;
                    return new Literal(sb.ToString());
                }
                if (c == '#')
                {
                    var close = text.IndexOf('#', _i + 1);
                    if (close < 0) throw Fail("unterminated date");
                    var raw = text[(_i + 1)..close]; _i = close + 1;
                    return DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) ? new Literal(date) : throw Fail("bad date " + raw);
                }
                if (char.IsDigit(c))
                {
                    var start = _i;
                    while (_i < text.Length && char.IsDigit(text[_i])) _i++;
                    if (_i + 1 < text.Length && text[_i] == '.' && char.IsDigit(text[_i + 1]))
                    {
                        _i++;
                        while (_i < text.Length && char.IsDigit(text[_i])) _i++;
                        return new Literal(decimal.Parse(text[start.._i], CultureInfo.InvariantCulture));
                    }
                    return new Literal(long.Parse(text[start.._i], CultureInfo.InvariantCulture));
                }
                var id = Identifier();
                if (id.Equals("True", StringComparison.OrdinalIgnoreCase)) return new Literal(true);
                if (id.Equals("False", StringComparison.OrdinalIgnoreCase)) return new Literal(false);
                Space();
                if (_i < text.Length && text[_i] == '(')
                {
                    _i++; var args = new List<Node>();
                    Space();
                    if (!Symbol(")"))
                    {
                        do args.Add(Or()); while (Symbol(","));
                        if (!Symbol(")")) throw Fail("expected ')'");
                    }
                    return new Call(id, args);
                }
                return new Name(id);
            }
            private string Identifier()
            {
                Space();
                var start = _i;
                while (_i < text.Length && (char.IsLetterOrDigit(text[_i]) || text[_i] == '_')) _i++;
                if (_i == start) throw Fail($"unexpected '{(start < text.Length ? text[start] : ' ')}'");
                return text[start.._i];
            }
        }

        private static object? Eval(Node node, Scope scope)
        {
            switch (node)
            {
                case Literal l: return l.Value;
                case Name n: return Resolve(n.Id, scope);
                case Member m:
                    if (m.Target is Name { Id: var root } && root.Equals("Client", StringComparison.OrdinalIgnoreCase))
                        return scope.Client.TryGetValue(m.Id, out var client) ? client : throw new UnevaluableException("unknown client variable " + m.Id);
                    return MemberOf(Eval(m.Target, scope), m.Id, m.Target, scope);
                case Indexed ix:
                    var target = Eval(ix.Target, scope);
                    var index = ToLong(Eval(ix.Index, scope));
                    if (target is ListValue list) return index >= 0 && index < list.Items.Count ? list.Items[(int)index] : throw new UnevaluableException("index out of range");
                    throw new UnevaluableException("indexing a value that is not a list");
                case Unary u:
                    var operand = Eval(u.Operand, scope);
                    return u.Op == "not" ? !Truthy(operand) : Negate(operand);
                case Binary b:
                    if (b.Op == "and") return Truthy(Eval(b.Left, scope)) && Truthy(Eval(b.Right, scope));
                    if (b.Op == "or") return Truthy(Eval(b.Left, scope)) || Truthy(Eval(b.Right, scope));
                    return Arithmetic(b.Op, Eval(b.Left, scope), Eval(b.Right, scope));
                case Call c: return Invoke(c, scope);
            }
            throw new UnevaluableException("unknown expression");
        }

        private static object? Resolve(string id, Scope scope)
        {
            if (scope.Vars.TryGetValue(id, out var value)) return value;
            if (scope.Aggregates.TryGetValue(id, out var aggregate)) return new AggregateRef(aggregate);
            if (scope.Current.TryGetValue(id, out var current)) return current;
            throw new UnevaluableException("unknown name " + id);
        }

        private sealed record AggregateRef(Aggregate Aggregate);

        private static object? MemberOf(object? target, string member, Node targetNode, Scope scope)
        {
            switch (target)
            {
                case AggregateRef a:
                    var list = scope.AggregateList(a.Aggregate);
                    return member switch
                    {
                        "List" => list,
                        "Count" => (long)list.Items.Count,
                        "IsDataFetched" => true,
                        _ => throw new UnevaluableException($"{a.Aggregate.Name}.{member} is outside the evaluated subset"),
                    };
                case ListValue l:
                    return member switch
                    {
                        "Current" => l.Owner != null && scope.Current.TryGetValue(l.Owner, out var current) ? current : l.Items.Count > 0 ? l.Items[0] : RecordValue.Default,
                        "Length" => (long)l.Items.Count,
                        "Empty" => l.Items.Count == 0,
                        _ => throw new UnevaluableException($"List.{member} is outside the evaluated subset"),
                    };
                case RecordValue r:
                    return r.Fields.TryGetValue(member, out var field) ? field : r.IsDefault ? RecordValue.Default : throw new UnevaluableException("unknown attribute " + member);
            }
            throw new UnevaluableException($"member {member} of a value that has none");
        }

        private static object? Invoke(Call call, Scope scope)
        {
            if (!Functions.Contains(call.Function)) throw new UnevaluableException($"function {call.Function} is outside the evaluated subset");
            var name = call.Function.ToLowerInvariant();
            if (name == "if")
            {
                if (call.Arguments.Count != 3) throw new UnevaluableException("If takes 3 arguments");
                return Truthy(Eval(call.Arguments[0], scope)) ? Eval(call.Arguments[1], scope) : Eval(call.Arguments[2], scope);
            }
            var a = call.Arguments.Select(x => Eval(x, scope)).ToList();
            object? Arg(int i) => i < a.Count ? a[i] : null;
            switch (name)
            {
                case "integertotext" or "longintegertotext": return ToLong(Arg(0)).ToString(CultureInfo.InvariantCulture);
                case "decimaltotext": return ToText(ToDecimal(Arg(0)));
                case "booleantotext": return Truthy(Arg(0)) ? "True" : "False";
                case "formatdecimal":
                {
                    var decimals = (int)ToLong(Arg(1));
                    var rounded = Math.Round(ToDecimal(Arg(0)), decimals, MidpointRounding.AwayFromZero);
                    var format = new NumberFormatInfo { NumberGroupSeparator = ToText(Arg(2)), NumberDecimalSeparator = ToText(Arg(3)), NumberGroupSizes = [3] };
                    return rounded.ToString(ToText(Arg(2)).Length > 0 ? "N" + decimals : "F" + decimals, format);
                }
                case "formatdatetime": return ToDate(Arg(0)).ToString(ToText(Arg(1)), CultureInfo.InvariantCulture);
                case "formattext":
                {
                    var text = ToText(Arg(0)); var min = (int)ToLong(Arg(1)); var max = (int)ToLong(Arg(2));
                    var left = Truthy(Arg(3)); var pad = ToText(Arg(4)); var c = pad.Length > 0 ? pad[0] : ' ';
                    if (text.Length < min) text = left ? text.PadLeft(min, c) : text.PadRight(min, c);
                    if (max > 0 && text.Length > max) text = left ? text[^max..] : text[..max];
                    return text;
                }
                case "substr":
                {
                    var text = ToText(Arg(0)); var start = (int)Math.Max(0, ToLong(Arg(1))); var length = (int)Math.Max(0, ToLong(Arg(2)));
                    if (start >= text.Length) return "";
                    return text.Substring(start, Math.Min(length, text.Length - start));
                }
                case "index":
                {
                    var text = ToText(Arg(0)); var search = ToText(Arg(1)); var start = (int)Math.Max(0, a.Count > 2 ? ToLong(Arg(2)) : 0);
                    var fromEnd = a.Count > 3 && Truthy(Arg(3)); var ignore = a.Count > 4 && Truthy(Arg(4));
                    var comparison = ignore ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
                    if (start > text.Length) return -1L;
                    return (long)(fromEnd ? text.LastIndexOf(search, comparison) : text.IndexOf(search, start, comparison));
                }
                case "length": return Arg(0) is ListValue lv ? lv.Items.Count : (long)ToText(Arg(0)).Length;
                case "tolower": return ToText(Arg(0)).ToLowerInvariant();
                case "toupper": return ToText(Arg(0)).ToUpperInvariant();
                case "trim": return ToText(Arg(0)).Trim();
                case "trimstart": return ToText(Arg(0)).TrimStart();
                case "trimend": return ToText(Arg(0)).TrimEnd();
                case "replace": return ToText(Arg(0)).Replace(ToText(Arg(1)), ToText(Arg(2)), StringComparison.Ordinal);
                case "month": return (long)ToDate(Arg(0)).Month;
                case "year": return (long)ToDate(Arg(0)).Year;
                case "day": return (long)ToDate(Arg(0)).Day;
                case "hour": return (long)ToDate(Arg(0)).Hour;
                case "minute": return (long)ToDate(Arg(0)).Minute;
                case "max": return Compare(Arg(0), Arg(1)) >= 0 ? Arg(0) : Arg(1);
                case "min": return Compare(Arg(0), Arg(1)) <= 0 ? Arg(0) : Arg(1);
                case "abs": return Arg(0) is long l ? Math.Abs(l) : Math.Abs(ToDecimal(Arg(0)));
                case "round": return Math.Round(ToDecimal(Arg(0)), a.Count > 1 ? (int)ToLong(Arg(1)) : 0, MidpointRounding.AwayFromZero);
                case "trunc": return Math.Truncate(ToDecimal(Arg(0)));
                case "texttointeger": return long.TryParse(ToText(Arg(0)).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var ti) ? ti : 0L;
                case "texttodecimal": return decimal.TryParse(ToText(Arg(0)).Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var td) ? td : 0m;
                case "integertodecimal": return ToDecimal(Arg(0));
                case "decimaltointeger": return (long)Math.Round(ToDecimal(Arg(0)), MidpointRounding.AwayFromZero);
                case "identifiertointeger" or "integertoidentifier" or "longintegertointeger" or "integertolonginteger" or "identifiertolonginteger" or "longintegertoidentifier":
                    return Arg(0) == null ? 0L : ToLong(Arg(0));
                case "datetimetotext": return ToText(Arg(0));
                case "nullidentifier": return 0L;
                case "nulltextidentifier": return "";
                case "nulldate": return new DateTime(1900, 1, 1);
                case "chr": return ((char)ToLong(Arg(0))).ToString();
                case "newline": return "\n";
            }
            throw new UnevaluableException($"function {call.Function} is outside the evaluated subset");
        }

        private static object? Arithmetic(string op, object? left, object? right)
        {
            switch (op)
            {
                case "=": return Compare(left, right) == 0;
                case "<>": return Compare(left, right) != 0;
                case "<": return Compare(left, right) < 0;
                case ">": return Compare(left, right) > 0;
                case "<=": return Compare(left, right) <= 0;
                case ">=": return Compare(left, right) >= 0;
                case "+" when left is string || right is string: return ToText(left) + ToText(right);
            }
            if (!IsNumber(left) || !IsNumber(right)) throw new UnevaluableException($"'{op}' needs numbers");
            if (left is long x && right is long y && op != "/")
                return op switch { "+" => x + y, "-" => x - y, "*" => x * y, _ => throw new UnevaluableException(op) };
            var p = ToDecimal(left); var q = ToDecimal(right);
            return op switch
            {
                "+" => p + q, "-" => p - q, "*" => p * q,
                "/" => q == 0 ? throw new UnevaluableException("division by zero") : p / q,
                _ => throw new UnevaluableException(op),
            };
        }

        private static object? Negate(object? value) => value switch
        {
            long l => -l, decimal d => -d, int i => -(long)i, _ => throw new UnevaluableException("'-' needs a number"),
        };

        private static bool IsNumber(object? value) => value is long or int or decimal or double;
        private static long ToLong(object? value) => value switch
        {
            long l => l, int i => i, decimal d => (long)d, double f => (long)f, bool b => b ? 1 : 0,
            string s when long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) => p,
            null or RecordValue { IsDefault: true } => 0, _ => throw new UnevaluableException("not an integer"),
        };
        private static decimal ToDecimal(object? value) => value switch
        {
            long l => l, int i => i, decimal d => d, double f => (decimal)f,
            string s when decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p) => p,
            null or RecordValue { IsDefault: true } => 0, _ => throw new UnevaluableException("not a number"),
        };
        private static DateTime ToDate(object? value) => value switch
        {
            DateTime t => t,
            string s when DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var p) => p,
            _ => throw new UnevaluableException("not a date"),
        };
    }
}
