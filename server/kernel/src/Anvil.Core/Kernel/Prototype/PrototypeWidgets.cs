using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// What the direct builder writes on one widget besides the <see cref="WidgetNode"/> of the shared contract: the name, the native
/// properties (each as the set verb takes it: expression text for expression properties, the literal for booleans, enums,
/// numbers and text), the extended properties (OutSystems expressions), the event handler, the block instance arguments and
/// handlers, and the placeholder. Built once from the capture by <see cref="PrototypeWidgets"/>; the builder never decides.
/// </summary>
public sealed class PrototypeWidgetSpec
{
    public string? Name { get; set; }
    public List<(string Property, string Value)> Properties { get; } = [];
    public List<(string Name, string Value)> Extended { get; } = [];
    public PrototypeHandler? Handler { get; set; }
    public string? Block { get; set; }
    public List<(string Input, string Value)> BlockArguments { get; } = [];
    public List<(string Event, string Action)> BlockHandlers { get; } = [];
    public string? Placeholder { get; set; }
    /// <summary>The widget name of the label target (for), set after the tree is built.</summary>
    public string? TargetWidget { get; set; }
    public string? SourceKey { get; set; }
}

/// <summary>An event of a widget: pure navigation (Screen) or a screen action of the owner (Action), with its arguments.
/// Event is the native event (OnClick, OnChange) or, for an HTML element, the extended event name (onclick).</summary>
public sealed record PrototypeHandler(string Event, string? Screen, string? Action, IReadOnlyList<(string Argument, string Value)> Arguments, bool Extended = false);

/// <summary>How an event key compiles at one owner (PrototypeLogic decides; the widget compiler only binds).</summary>
public sealed record PrototypeEventBinding(string EventKey, string? Screen, string? Action, IReadOnlyList<JsonObject> Params, IReadOnlyDictionary<string, JsonNode>? NavParams = null, string? Why = null);

/// <summary>A list of the owner: the aggregate it iterates and how its current record is read; or, bound by data.bind (2.12), the
/// output list of a Data Action (Source) and its current record (Current).</summary>
public sealed record PrototypeListBinding(string Aggregate, string Entity, string Collection, IReadOnlyDictionary<string, string> Joins, string? Source = null, string? Current = null);

/// <summary>
/// The capture trees as native widget trees (3.2): one <see cref="WidgetNode"/> per element of the prototype, decided by the shared
/// element map (<see cref="PrototypeSeams.Element"/>, the html lane's table), with the annotations of the capture compiled to
/// native constructs: list -> IList (Custom, the tag and class of the group), if -> IIfWidget (never Visible), expr -> IExpression,
/// classExpr/attrExpr -> Style and extended property expressions, events -> the handler PrototypeLogic bound, control -> Variable,
/// icon -> span with the icon classes, id -> Name (and the ssam-id class). Text is collapsed by the HTML rule; whitespace-only
/// text between elements is dropped.
/// </summary>
public sealed class PrototypeWidgets
{
    public sealed class Context
    {
        public required string Platform { get; init; }
        public required PrototypeCapture Capture { get; init; }
        public required Func<ElementRequest, ElementMapping> Element { get; init; }
        /// <summary>The owner's scope outside any list (dimensions, parameters, controls, records, counts).</summary>
        public required PrototypeScope Scope { get; init; }
        public required Func<string, JsonObject, PrototypeEventBinding?> Event { get; init; }
        public required Func<JsonObject, PrototypeListBinding?> List { get; init; }
        /// <summary>The variable of a control annotation (dimension local, control local, or a record field).</summary>
        public required Func<JsonObject, PrototypeScope, string?> Variable { get; init; }
        /// <summary>The options of a select: (list expression, values attribute, labels attribute).</summary>
        public required Func<JsonObject, JsonObject, (string List, string Values, string Labels)?> Options { get; init; }
        public required PrototypeNameScope Names { get; init; }
        public required Func<string, string> ScreenOf { get; init; }
        /// <summary>The module image of a bundled asset path (null for a path the bundle does not carry).</summary>
        public Func<string, string?> ImageOf { get; init; } = _ => null;
        public Dictionary<string, string> Ids { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> IdClasses { get; } = new(StringComparer.Ordinal);
        public HashSet<string> SubstitutedTags { get; } = new(StringComparer.Ordinal);
        public List<JsonObject> Degraded { get; } = [];
        public List<JsonObject> Unevaluable { get; } = [];
        public List<JsonObject> References { get; } = [];
        public Dictionary<WidgetNode, PrototypeWidgetSpec> Specs { get; } = new(ReferenceEqualityComparer.Instance);
        public HashSet<string> IconClasses { get; } = new(StringComparer.Ordinal);
        public int Elements { get; set; }
        public int Widgets { get; set; }
        public int ExtendedProperties { get; set; }
        public int Ifs { get; set; }
        public int Lists { get; set; }
        /// <summary>The submit event of a form id (its submit buttons take it).</summary>
        public Dictionary<string, string> FormSubmits { get; } = new(StringComparer.Ordinal);
        /// <summary>The form of a form id: a submit button passes the parameters the form carries (its data-id).</summary>
        public Dictionary<string, JsonObject> FormNodes { get; } = new(StringComparer.Ordinal);
    }

    private static readonly HashSet<string> NeverWidgets = new(StringComparer.Ordinal) { "template", "slot", "script", "style", "option", "optgroup", "#comment", "noscript" };
    private static readonly HashSet<string> IdReferences = new(StringComparer.OrdinalIgnoreCase) { "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "form", "list" };

    /// <summary>HTML boolean attributes: present or absent, whatever their value. The runtime (React) drops one whose value is
    /// empty, so a present one is written with its own name ("hidden") and an absent one as "" (If(cond, "hidden", "")).</summary>
    internal static readonly HashSet<string> BooleanAttributes = new(StringComparer.OrdinalIgnoreCase)
    {
        "hidden", "disabled", "required", "readonly", "multiple", "checked", "selected", "open", "novalidate", "formnovalidate", "autofocus",
        "inert", "itemscope", "async", "defer", "autoplay", "controls", "loop", "muted", "playsinline", "reversed", "default", "allowfullscreen",
    };
    private static readonly Regex Collapse = new("[ \t\n\r\f]+", RegexOptions.Compiled);

    private readonly Context _c;
    public PrototypeWidgets(Context context) => _c = context;

    /// <summary>The widgets of the children of <paramref name="parent"/> (a view's mount element, a region, a template).</summary>
    public List<WidgetNode> Children(JsonObject parent, PrototypeScope scope, bool insideForm = false)
    {
        // ids and forms are per tree (two popups of a screen may both have a #product-form); names stay unique in the screen
        _c.Ids.Clear(); _c.FormSubmits.Clear();
        PreScan(parent);
        var result = new List<WidgetNode>();
        foreach (var child in parent["c"] as JsonArray ?? [])
            if (child is JsonObject node) result.AddRange(Node(node, scope, insideForm));
        return result;
    }

    /// <summary>The widget of one node (the node itself included).</summary>
    public List<WidgetNode> Nodes(JsonObject node, PrototypeScope scope, bool insideForm = false)
    {
        _c.Ids.Clear(); _c.FormSubmits.Clear();
        PreScan(node);
        return Node(node, scope, insideForm);
    }

    /// <summary>Ids of the tree get their names first, so references (aria-labelledby, for, form) resolve forwards too.</summary>
    private void PreScan(JsonObject root)
    {
        void Walk(JsonObject n)
        {
            if (n["t"] is not null && Attr(n, "id") is { Length: > 0 } id && !_c.Ids.ContainsKey(id))
            {
                var wanted = PrototypeNames.WidgetName(id);
                _c.Ids[id] = _c.Names.Claim(wanted) ? wanted : _c.Names.Free(wanted, 2);
                _c.IdClasses[id] = PrototypeNames.IdClass(id);
                if (n["t"]?.ToString() == "form" && n["events"] is JsonArray fe)
                    foreach (var e in fe) if (e?.ToString() is { } key && key.Contains(":submit:", StringComparison.Ordinal)) { _c.FormSubmits[id] = key; _c.FormNodes[id] = n; }
            }
            foreach (var c in n["c"] as JsonArray ?? []) if (c is JsonObject o) Walk(o);
            if (n["list"]?["template"] is JsonObject t) Walk(t);
            foreach (var c in n["else"] as JsonArray ?? []) if (c is JsonObject o) Walk(o);
            if (n["toast"]?["template"] is JsonObject tt) Walk(tt);
        }
        Walk(root);
    }

    private List<WidgetNode> Node(JsonObject node, PrototypeScope scope, bool insideForm)
    {
        if (node["x"] is JsonValue)
        {
            var text = Text(node, scope);
            return text == null ? [] : [text];
        }
        var tag = node["t"]?.ToString() ?? "";
        if (NeverWidgets.Contains(tag)) return [];
        WidgetNode widget;
        if (tag == "table" && DataTable(node, scope) is { } table) widget = table;
        else if (node["list"] is JsonObject list && list["mode"]?.ToString() == "self") widget = ListWidget(node, list, scope, self: true);
        else widget = Element(node, scope, insideForm);
        if (node["if"] is JsonObject condition)
        {
            var otherwise = node["else"] is JsonArray els ? els.OfType<JsonObject>().SelectMany(e => Node(e, scope, insideForm)).ToList() : null;
            return [If(node, condition, [widget], otherwise, scope)];
        }
        return [widget];
    }

    private WidgetNode If(JsonObject node, JsonObject condition, IReadOnlyList<WidgetNode> then, IReadOnlyList<WidgetNode>? otherwise, PrototypeScope scope)
    {
        var spec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
        string text;
        try { text = PrototypeExpr.Pred(condition, scope); }
        catch (PrototypeExpressionException ex) { Unevaluable(node, "if", ex.Message); text = "True"; }
        spec.Properties.Add(("Condition", text));
        var widget = new WidgetNode("IIfWidget", node["k"]?.ToString(), null, null, [], null, null, condition.DeepClone(), null, then, otherwise ?? [], null);
        _c.Specs[widget] = spec; _c.Ifs++; _c.Widgets++;
        return widget;
    }

    /// <summary>A whitespace-only text between two texts that show something (not a formatting newline between elements).</summary>
    private static bool SignificantSpace(JsonArray siblings, int i)
    {
        static bool Blank(JsonNode? n) => n is JsonObject o && o["x"] is JsonValue && o["expr"] == null && o["t"] == null && Collapse.Replace(o["x"]!.ToString(), " ").Trim().Length == 0;
        static bool Shows(JsonNode? n) => n is JsonObject o && o["t"] == null && o["x"] is JsonValue && (o["expr"] != null || o["x"]!.ToString().Trim().Length > 0);
        return Blank(siblings[i]) && !siblings[i]!["x"]!.ToString().Contains('\n') && i > 0 && i < siblings.Count - 1 && Shows(siblings[i - 1]) && Shows(siblings[i + 1]);
    }

    private WidgetNode SpaceText(JsonObject node)
    {
        var text = new WidgetNode("ITextWidget", node["k"]?.ToString(), null, null, [], " ", null, null, null, []);
        var spec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
        spec.Properties.Add(("Text", " "));
        _c.Specs[text] = spec; _c.Widgets++;
        return text;
    }

    private WidgetNode? Text(JsonObject node, PrototypeScope scope)
    {
        var raw = node["x"]!.ToString();
        if (node["expr"] is JsonObject expr)
        {
            var spec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
            try { spec.Properties.Add(("Value", PrototypeExpr.Expr(expr, scope))); }
            catch (PrototypeExpressionException ex)
            {
                Unevaluable(node, "expr", ex.Message);
                var literal = Collapse.Replace(raw, " ");
                if (literal.Trim().Length == 0) return null;
                spec.Properties.Add(("Value", PrototypeExpr.Quote(literal)));
            }
            var widget = new WidgetNode("IExpression", node["k"]?.ToString(), null, null, [], raw, expr.DeepClone(), null, null, []);
            _c.Specs[widget] = spec; _c.Widgets++;
            return widget;
        }
        var collapsed = Collapse.Replace(raw, " ");
        if (collapsed.Trim().Length == 0) return null;
        var text = new WidgetNode("ITextWidget", node["k"]?.ToString(), null, null, [], collapsed, null, null, null, []);
        var textSpec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
        textSpec.Properties.Add(("Text", collapsed));
        _c.Specs[text] = textSpec; _c.Widgets++;
        return text;
    }

    /// <summary>The source of an image (3.2): Static with the module image of a bundled asset, External with the Url of any other
    /// address (an expression when the capture computed it).</summary>
    private void ImageSource(JsonObject node, PrototypeWidgetSpec spec, PrototypeScope scope)
    {
        if (node["attrExpr"]?["src"] is JsonObject dynamic && AttributeExpression(node, "src", dynamic, scope) is { } computed)
        {
            spec.Properties.Add(("Type", "External"));
            spec.Properties.Add(("Url", computed.Value));
            return;
        }
        var src = Attr(node, "src");
        if (string.IsNullOrEmpty(src)) return;
        var path = src.Split('#', '?')[0];
        if (path.StartsWith("./", StringComparison.Ordinal)) path = path[2..];
        // 'foto%20grande.png' is the file 'foto grande.png' (the capture names the asset decoded, as the browser reads it)
        if ((_c.ImageOf(path) ?? _c.ImageOf(PrototypeNames.Unescape(path))) is { } image)
        {
            spec.Properties.Add(("Type", "Static"));
            spec.Properties.Add(("Image", image));
            return;
        }
        spec.Properties.Add(("Type", "External"));
        spec.Properties.Add(("Url", PrototypeExpr.Quote(src)));
    }

    private static string? Attr(JsonObject node, string name)
    {
        foreach (var pair in node["a"] as JsonArray ?? [])
            if (pair is JsonArray p && p.Count == 2 && string.Equals(p[0]?.ToString(), name, StringComparison.OrdinalIgnoreCase)) return p[1]?.ToString();
        return null;
    }

    private static List<(string Name, string Value)> Attrs(JsonObject node)
        => (node["a"] as JsonArray ?? []).OfType<JsonArray>().Where(p => p.Count == 2).Select(p => (p[0]!.ToString(), p[1]?.ToString() ?? "")).ToList();

    private bool Clickable(JsonObject node)
        => node["events"] is JsonArray events && events.Any(e => e?.ToString() is { } key && (key.Contains(":click:", StringComparison.Ordinal) || _c.Capture.Event(key)?["on"]?.ToString() == "click"))
           || node["nav"] is JsonObject;

    private WidgetNode Element(JsonObject node, PrototypeScope scope, bool insideForm)
    {
        var tag = node["t"]!.ToString();
        var icon = node["icon"] as JsonObject;
        _c.Elements++;
        var attrs = icon != null
            ? (icon["from"] as JsonArray ?? []).OfType<JsonArray>().Where(p => p.Count == 2).Select(p => (p[0]!.ToString(), p[1]?.ToString() ?? "")).ToList()
            : Attrs(node);
        var hasElementChildren = (node["c"] as JsonArray ?? []).OfType<JsonObject>().Any(c => c["t"] != null);
        // an inline svg that is no icon (several colors, a gradient): the image of its own markup (an img with the SVG as a data
        // URL, its size and classes kept), never an Image without a value nor the svg attributes on another element
        if (icon == null && tag == "svg" && node["svg"]?.ToString() is { Length: > 0 } markup)
        {
            attrs = attrs.Where(a => a.Item1.ToLowerInvariant() is "class" or "style" or "width" or "height" or "role" or "title" || a.Item1.StartsWith("aria-", StringComparison.OrdinalIgnoreCase)).ToList();
            var xml = markup.Contains("xmlns=", StringComparison.Ordinal) ? markup : markup.Replace("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"", StringComparison.Ordinal);
            attrs.Insert(0, ("src", "data:image/svg+xml," + PrototypeIcons.PercentEncode(xml)));
            tag = "img";
        }
        var request = new ElementRequest(_c.Platform, icon != null ? "svg" : tag, attrs, Clickable(node), icon != null, insideForm, hasElementChildren);
        ElementMapping mapping;
        try { mapping = _c.Element(request); }
        catch (Exception ex) { mapping = new ElementMapping("IAdvancedHtml", "div", null, [], [], [], tag, "the element map failed: " + ex.Message); }
        if (mapping.Problem != null)
        {
            // 1.4.1: a node the map refuses becomes a literal (HTML element with the substitute tag and its text), never lost
            _c.Degraded.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["code"] = "ELEMENT_MAP", ["message"] = mapping.Problem, ["done"] = "literal" });
            mapping = new ElementMapping("IAdvancedHtml", mapping.Tag ?? "div", mapping.Name, [], mapping.ExtendedProperties, mapping.Classes, mapping.SubstitutedFrom ?? tag, null);
        }
        if (mapping.SubstitutedFrom != null) _c.SubstitutedTags.Add(mapping.SubstitutedFrom);
        var spec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
        // name: the prototype id, else Tag + n (unique in the screen or block)
        var id = icon == null ? Attr(node, "id") : null;
        if (id is { Length: > 0 } && _c.Ids.TryGetValue(id, out var idName)) spec.Name = idName;
        else if (mapping.Widget is not ("ITextWidget" or "IExpression")) spec.Name = _c.Names.Free(PrototypeNames.TagStem(mapping.Tag ?? (mapping.Widget.StartsWith('I') ? mapping.Widget[1..] : mapping.Widget)));
        // the map's pseudo-properties are decisions this compiler carries out itself (the event of an HTML element, the label
        // target, the default of the bound variable, the markup image, the radio group), never properties of the widget
        foreach (var (property, value) in mapping.Properties)
            if (property is not ("Style" or "Event" or "DefaultValue" or "TargetWidget" or "RadioGroup" or "ImageMarkup")) spec.Properties.Add((property, value));
        if (mapping.Widget == "IImage" && !spec.Properties.Any(p => p.Property is "Image" or "Url" or "ImageContent")) ImageSource(node, spec, scope);
        // classes: the dynamic class of the capture (classExpr / attrExpr class) or the static ones of the map, plus the ssam classes
        var classes = new List<string>(mapping.Classes);
        // every substitute names the tag it stands for (the map leaves the class out of br to keep the html op's output; the
        // importer's measure and rewrites read it)
        if (mapping.SubstitutedFrom is { } substituted && !classes.Contains(ElementWidgetMap.TagClass(substituted))) classes.Add(ElementWidgetMap.TagClass(substituted));
        if (icon != null)
        {
            var name = icon["name"]!.ToString();
            var stroke = icon["strokeWidth"] is JsonValue sv && sv.TryGetValue<double>(out var sw) ? sw : _c.Capture.DefaultStrokeWidth;
            var mask = PrototypeNames.IconClass(name, stroke, _c.Capture.DefaultStrokeWidth);
            _c.IconClasses.Add(mask);
            foreach (var cls in new[] { "lucide", "lucide-" + name, "ssam-icon", mask }) if (!classes.Contains(cls)) classes.Add(cls);
        }
        if (id is { Length: > 0 } && _c.IdClasses.TryGetValue(id, out var idClass) && !classes.Contains(idClass)) classes.Add(idClass);
        var styleExpression = StyleExpression(node, classes, scope);
        // extended properties: what the map kept, minus what a capture expression rewrites
        var dynamicAttributes = node["attrExpr"] as JsonObject;
        // an inline style the capture (or data.bind) computes is the expression's alone: never the static one beside it
        if (dynamicAttributes?["style"] is JsonObject) spec.Properties.RemoveAll(p => p.Property == "CustomStyle");
        // the map's extended values as every widget made from the map writes them (MappedAttributes); an attribute the capture
        // computes is its expression's, below
        spec.Extended.AddRange(MappedAttributes(node, mapping, dynamicAttributes));
        if (dynamicAttributes != null)
            foreach (var (name, value) in dynamicAttributes)
            {
                if (string.Equals(name, "class", StringComparison.OrdinalIgnoreCase)) continue;
                var text = AttributeExpression(node, name, value as JsonObject, scope);
                if (text == null) continue;
                // an inline style that varies by item (an extra attribute of the list's entity): it replaces the static
                // CustomStyle the map took from the first item, never a second style attribute
                if (string.Equals(name, "style", StringComparison.OrdinalIgnoreCase))
                {
                    spec.Properties.RemoveAll(p => p.Property == "CustomStyle");
                    spec.Extended.RemoveAll(x => string.Equals(x.Name, "style", StringComparison.OrdinalIgnoreCase));
                    spec.Extended.Add(("style", text.Value));
                    continue;
                }
                if (name == "disabled" && mapping.Widget is "IButton" or "ILink" or "IInput" or "ITextArea" or "IDropdown" or "ICheckbox")
                {
                    spec.Properties.RemoveAll(p => p.Property == "Enabled");
                    spec.Properties.Add(("Enabled", text.Condition != null ? $"not ({text.Condition})" : "True"));
                    continue;
                }
                spec.Extended.Add((name, text.Value));
            }
        _c.ExtendedProperties += spec.Extended.Count;
        // the label target and the form a button submits
        if (mapping.Widget == "ILabel" && Attr(node, "for") is { Length: > 0 } target)
        {
            if (_c.Ids.TryGetValue(target, out var targetName)) spec.TargetWidget = targetName;
            else _c.References.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["attribute"] = "for", ["value"] = target, ["why"] = "the target is not in the same tree" });
        }
        // controls: the variable, and the options of a select
        var unbound = node["control"] == null;
        if (node["control"] is JsonObject control)
        {
            var variable = _c.Variable(control, scope);
            unbound = variable == null;
            // the Variable first: binding it resets MaxLength to the variable's length, and the prototype's maxlength comes after
            if (variable != null) spec.Properties.Insert(0, ("Variable", variable));
            else _c.Unevaluable.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["what"] = "control", ["why"] = "the control has no variable here" });
            if (mapping.Widget == "IDropdown" && _c.Options(control, node) is { } options)
            {
                spec.Properties.Add(("List", options.List));
                spec.Properties.Add(("Values", options.Values));
                spec.Properties.Add(("Labels", options.Labels));
            }
        }
        // events: navigation, screen action, or the submit of the form this button belongs to
        Handler(node, mapping, spec, scope);
        var widgetType = mapping.Widget;
        var widgetTag = mapping.Tag;
        if (unbound && widgetType is "IInput" or "ITextArea" or "ICheckbox" or "IDropdown")
        {
            // a control the capture tied to nothing (no dimension, no form field), or to a variable this owner does not have: a
            // native input requires a variable, so it stays the HTML element it was, with its own attributes (a select keeps its
            // options as children)
            widgetType = "IAdvancedHtml";
            widgetTag = tag;
            spec.Properties.RemoveAll(p => p.Property is not ("Style" or "CustomStyle"));
            spec.Properties.Add(("Tag", tag));
            foreach (var (name, value) in Attrs(node))
                if (name is not ("class" or "id" or "style") && spec.Extended.All(x => !string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))) spec.Extended.Add((name, PrototypeExpr.Quote(BooleanAttributes.Contains(name) ? name.ToLowerInvariant() : value)));
            _c.Degraded.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["code"] = "CONTROL_UNBOUND", ["message"] = $"<{tag}> is tied to no dimension nor form field: a native {mapping.Widget} needs a variable", ["done"] = "HTML element <" + tag + ">" });
        }
        if (widgetType == "IRadioButton")
        {
            // a native Radio Button lives inside a Radio Group that owns the variable; the prototype's loose radios (name="x"
            // per input) have none, so each stays the HTML <input type="radio"> it was, with its name, value and checked
            widgetType = "IAdvancedHtml";
            widgetTag = "input";
            spec.Properties.RemoveAll(p => p.Property is not ("Style" or "CustomStyle"));
            spec.Properties.Add(("Tag", "input"));
            foreach (var name in new[] { "type", "name", "value", "checked" })
                if (Attr(node, name) is { } value && spec.Extended.All(x => x.Name != name)) spec.Extended.Add((name, PrototypeExpr.Quote(value)));
            _c.Degraded.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["code"] = "RADIO_UNGROUPED", ["message"] = "a radio without a native Radio Group has no variable to write", ["done"] = "HTML element <input type=\"radio\">" });
        }
        if (spec.Handler == null && widgetType is "ILink" or "IButton")
        {
            // a link to a route of the capture navigates to its screen; a button or link with nothing to do natively is the HTML
            // element of its own tag (a native Link or Button requires its OnClick)
            if (widgetType == "ILink" && Attr(node, "href") is { } href && RouteOf(href) is { } route)
                spec.Handler = new PrototypeHandler("OnClick", _c.ScreenOf(route.View), null, route.Arguments, false);
            else
            {
                widgetType = "IAdvancedHtml";
                widgetTag = tag;
                var enabled = spec.Properties.FirstOrDefault(p => p.Property == "Enabled").Value;
                spec.Properties.RemoveAll(p => p.Property is "Enabled" or "IsDefault");
                foreach (var name in new[] { "href", "type" })
                    if (Attr(node, name) is { } value && spec.Extended.All(x => x.Name != name)) spec.Extended.Add((name, PrototypeExpr.Quote(value)));
                if (enabled != null && spec.Extended.All(x => x.Name != "disabled"))
                    spec.Extended.Add(("disabled", enabled == "False" ? "\"\"" : $"If({enabled}, \"\", \"disabled\")"));
                spec.Properties.Add(("Tag", tag));
                _c.Degraded.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["code"] = "NO_HANDLER", ["message"] = $"<{tag}> has no event the native {mapping.Widget} can run", ["done"] = "HTML element <" + tag + ">" });
            }
        }
        // children
        var children = new List<WidgetNode>();
        var childScope = scope;
        var nowInsideForm = insideForm || mapping.Widget == "IForm" || tag == "form";
        if (node["placeholder"]?.ToString() is { } placeholder)
        {
            var ph = new WidgetNode("IPlaceholderWidget", node["k"] + "/placeholder", null, null, [], null, null, null, null, [], null, "wrapper");
            _c.Specs[ph] = new PrototypeWidgetSpec { Name = placeholder, Placeholder = placeholder, SourceKey = node["k"]?.ToString() };
            _c.Widgets++;
            children.Add(ph);
        }
        else if (node["message"] is JsonObject message)
        {
            var expression = new WidgetNode("IExpression", node["k"] + "/message", null, null, [], null, message.DeepClone(), null, null, []);
            var messageSpec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
            messageSpec.Properties.Add(("Value", (scope.Local ?? (n => n))(message["local"]!.ToString())));
            _c.Specs[expression] = messageSpec; _c.Widgets++;
            children.Add(expression);
        }
        else if (node["toast"] is JsonObject toast && toast["template"] is JsonObject template)
        {
            var inner = Node(template, scope, false);
            var condition = new JsonObject { ["op"] = "truthy", ["l"] = new JsonObject { ["input"] = "Aviso" } };
            children.Add(If(template, condition, inner, null, scope));
        }
        else if (widgetType is not ("IDropdown" or "IInput" or "ITextArea" or "ICheckbox" or "IImage" or "IRadioGroup"))
        {
            var c = node["c"] as JsonArray ?? [];
            var wrap = node["list"] as JsonObject is { } wl && wl["mode"]?.ToString() == "wrap" ? wl : null;
            var start = wrap?["start"]?.GetValue<int>() ?? -1;
            var count = wrap?["items"]?.GetValue<int>() ?? 0;
            // the rendered items are in c (their place taken by the list), or detached: c holds only the other children and the
            // list goes where the items started (PrototypeDialect: the render lane keeps the template only)
            var detached = wrap?["detached"]?.GetValue<bool>() == true;
            var listed = false;
            for (var i = 0; i < c.Count; i++)
            {
                if (wrap != null && i == start) { children.Add(ListWidget(node, wrap, childScope, self: false)); listed = true; if (!detached) continue; }
                if (wrap != null && !detached && i > start && i < start + Math.Max(count, 1)) continue;
                if (c[i] is JsonObject child)
                {
                    // the space between two texts of one line ("📦" " " "Entrega", JSX {icon} {label}) is the space the browser
                    // shows, never formatting: kept as a text of one space (VisitaCerta 2026-10-12)
                    if (SignificantSpace(c, i)) { children.Add(SpaceText(child)); continue; }
                    children.AddRange(Node(child, childScope, nowInsideForm));
                }
            }
            if (wrap != null && !listed) children.Add(ListWidget(node, wrap, childScope, self: false));
        }
        var attributes = spec.Extended.Select(e => (e.Name, e.Value)).ToList();
        var widget = new WidgetNode(widgetType, node["k"]?.ToString(), widgetTag, styleExpression.Static, attributes, null,
            null, null, null, children, null, null);
        if (styleExpression.Expression != null) spec.Properties.Add(("Style", styleExpression.Expression));
        _c.Specs[widget] = spec; _c.Widgets++;
        return widget;
    }

    /// <summary>The class of a widget: the static classes, or the expression of classExpr/attrExpr class, always with the ssam
    /// classes the map or this compiler add.</summary>
    private (string Static, string? Expression) StyleExpression(JsonObject node, List<string> classes, PrototypeScope scope)
    {
        var ssam = classes.Where(c => c.StartsWith("ssam-", StringComparison.Ordinal) || c is "lucide" || c.StartsWith("lucide-", StringComparison.Ordinal)).ToList();
        var staticText = string.Join(" ", classes);
        try
        {
            if (node["classExpr"] is JsonObject ce)
            {
                var parts = new List<string> { PrototypeExpr.Quote(ce["base"]?.ToString() ?? "") };
                foreach (var token in ce["tokens"] as JsonArray ?? [])
                {
                    if (token is not JsonObject t) continue;
                    if (t["expr"] is JsonObject te)
                    {
                        var computed = PrototypeExpr.Quote(" ") + " + " + PrototypeExpr.Expr(te, scope);
                        parts.Add(t["when"] is JsonObject tokenWhen ? $"If({PrototypeExpr.Pred(tokenWhen, scope)}, {computed}, \"\")" : computed);
                        continue;
                    }
                    var cls = t["token"]?.ToString() ?? "";
                    if (t["when"] is JsonObject when) parts.Add($"If({PrototypeExpr.Pred(when, scope)}, {PrototypeExpr.Quote(" " + cls)}, \"\")");
                    else parts.Add(PrototypeExpr.Quote(" " + cls));
                }
                if (ssam.Count > 0) parts.Add(PrototypeExpr.Quote(" " + string.Join(" ", ssam)));
                return (staticText, Join(parts));
            }
            if (node["attrExpr"]?["class"] is JsonObject ae && ae["expr"] is JsonObject expression)
            {
                var text = PrototypeExpr.Expr(expression, scope);
                if (ssam.Count > 0) text += " + " + PrototypeExpr.Quote(" " + string.Join(" ", ssam));
                return (staticText, text);
            }
        }
        catch (PrototypeExpressionException ex) { Unevaluable(node, "class", ex.Message); }
        return (staticText, PrototypeExpr.Quote(staticText));
    }

    private static string Join(List<string> parts)
    {
        // adjacent literals fold into one ("a" + " b" -> "a b")
        var folded = new List<string>();
        foreach (var part in parts)
        {
            if (folded.Count > 0 && IsLiteral(folded[^1]) && IsLiteral(part)) folded[^1] = folded[^1][..^1] + part[1..];
            else folded.Add(part);
        }
        return string.Join(" + ", folded);
    }

    /// <summary>The extended properties of the element map as a widget writes them: one rule for every widget the importer makes from
    /// the map (the HTML element, the List of an element, the native Table; X1 of the review of round 6, round 7 of fix/data-table: a
    /// List quoted them again, so aria-label="Pedidos" was published with the quotes). The map's values are already what a set op
    /// writes (quoted literals, ElementWidgetMap): written as they are, never quoted again; an id reference is the literal with the
    /// ids resolved to the widget names, a boolean attribute its own name (the runtime drops an empty one); the class is the
    /// widget's Style. <paramref name="computed"/>: the attributes the capture computes, written by the caller as their expressions
    /// (the HTML element); null keeps the static value the capture rendered (a List or a Table writes no expression of its own
    /// element).</summary>
    private IEnumerable<(string Name, string Value)> MappedAttributes(JsonObject node, ElementMapping mapping, JsonObject? computed)
    {
        foreach (var (name, value) in mapping.ExtendedProperties)
        {
            // the map writes attribute names in lower case (viewbox) and the capture as written (viewBox): one attribute, once
            if (computed?.Any(d => string.Equals(d.Key, name, StringComparison.OrdinalIgnoreCase)) == true || string.Equals(name, "class", StringComparison.OrdinalIgnoreCase)) continue;
            if (IdReferences.Contains(name) && Literal(value) is { Length: > 0 } ids) { yield return (name, PrototypeExpr.Quote(ResolveIds(node, name, ids))); continue; }
            if (BooleanAttributes.Contains(name) && IsLiteral(value)) { yield return (name, PrototypeExpr.Quote(name.ToLowerInvariant())); continue; }
            yield return (name, value);
        }
    }

    private static bool IsLiteral(string text) => text.Length >= 2 && text[0] == '"' && text[^1] == '"' && !text[1..^1].Replace("\"\"", "").Contains('"');

    /// <summary>The text of a quoted literal ("a ""b""" -> a "b"); a value that is no literal is itself.</summary>
    private static string Literal(string value) => IsLiteral(value) ? value[1..^1].Replace("\"\"", "\"") : value;

    private sealed record AttrText(string Value, string? Condition);

    private AttrText? AttributeExpression(JsonObject node, string name, JsonObject? value, PrototypeScope scope)
    {
        if (value == null) return null;
        try
        {
            if (value["expr"] is JsonObject expression)
            {
                var text = PrototypeExpr.Expr(expression, scope);
                return new AttrText(text, null);
            }
            if (value["when"] is JsonObject when)
            {
                var condition = PrototypeExpr.Pred(when, scope);
                // a boolean attribute present under the condition: its name, else empty (dropped by the runtime)
                if (BooleanAttributes.Contains(name)) return new AttrText($"If({condition}, {PrototypeExpr.Quote(name.ToLowerInvariant())}, \"\")", condition);
                // the value when present: a literal, or an expression of its own (a format, cases)
                var then = value["then"] is JsonObject { } thenValue && thenValue["expr"] is JsonObject thenExpr ? PrototypeExpr.Expr(thenExpr, scope) : PrototypeExpr.Quote(value["then"]?.ToString() ?? "");
                var otherwise = value["else"]?.ToString();
                return new AttrText($"If({condition}, {then}, {PrototypeExpr.Quote(otherwise ?? "")})", condition);
            }
        }
        catch (PrototypeExpressionException ex) { Unevaluable(node, "attribute " + name, ex.Message); }
        return Attr(node, name) is { } literal ? new AttrText(PrototypeExpr.Quote(literal), null) : null;
    }

    private string ResolveIds(JsonObject node, string attribute, string value)
    {
        var parts = value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(id =>
        {
            if (_c.Ids.TryGetValue(id, out var name)) return name;
            _c.References.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["attribute"] = attribute, ["value"] = id, ["why"] = "the target id is not in the same screen tree" });
            return id;
        });
        return string.Join(" ", parts);
    }

    private void Handler(JsonObject node, ElementMapping mapping, PrototypeWidgetSpec spec, PrototypeScope scope)
    {
        var eventName = mapping.Widget switch
        {
            "IButton" or "ILink" => "OnClick",
            "IInput" or "ITextArea" or "IDropdown" or "ICheckbox" or "IRadioGroup" => "OnChange",
            "IAdvancedHtml" or "IContainer" => "onclick",
            _ => null,
        };
        var extended = eventName == "onclick";
        if (node["nav"] is JsonObject nav && node["events"] is not JsonArray { Count: > 0 })
        {
            var view = nav["view"]?.ToString();
            if (view == null || eventName == null) return;
            var args = new List<(string, string)>();
            foreach (var (param, val) in nav["params"] as JsonObject ?? [])
            {
                try { args.Add((param, PrototypeExpr.Val(val, scope))); }
                catch (PrototypeExpressionException ex) { Unevaluable(node, "nav " + param, ex.Message); }
            }
            spec.Handler = new PrototypeHandler(eventName, _c.ScreenOf(view), null, args, extended);
            return;
        }
        var keys = (node["events"] as JsonArray ?? []).Select(e => e?.ToString()).OfType<string>().ToList();
        // a submit button without an event of its own submits its form (inside it, or named by form=); the parameters of the
        // submit (the form's data-id) are read on the form
        var source = node;
        if (keys.Count == 0 && mapping.Widget == "IButton" && (Attr(node, "type") == "submit" || mapping.Properties.Any(p => p.Property == "IsDefault" && p.Value == "True")))
        {
            var form = Attr(node, "form");
            if (form != null && _c.FormSubmits.TryGetValue(form, out var submit)) { keys.Add(submit); source = _c.FormNodes.GetValueOrDefault(form) ?? node; }
            else if (_c.FormSubmits.Count == 1) { keys.Add(_c.FormSubmits.Values.First()); source = _c.FormNodes.Values.First(); }
        }
        foreach (var key in keys)
        {
            if (key.Contains(":submit:", StringComparison.Ordinal) && mapping.Widget is "IForm") continue; // the form's submit goes on its button
            var binding = _c.Event(key, node);
            if (binding == null || eventName == null) continue;
            var args = new List<(string, string)>();
            foreach (var param in binding.Params)
            {
                var name = param["name"]!.ToString();
                var from = param["from"]?.ToString();
                string? value = null;
                if (from == "@control") value = spec.Properties.FirstOrDefault(p => p.Property == "Variable").Value;
                else if (from != null && (node["attrExpr"]?[from] ?? source["attrExpr"]?[from]) is JsonObject dynamicValue)
                    value = AttributeExpression(node["attrExpr"]?[from] != null ? node : source, from, dynamicValue, scope)?.Value is { } text ? Unquote(text, param["type"]?.ToString()) : null;
                if (value == null && from != null && (Attr(node, from) ?? Attr(source, from)) is { } literal)
                    value = PrototypeExpr.Literal(JsonValue.Create(literal), param["type"]?.ToString() ?? "Text");
                if (value != null) args.Add((name, value));
            }
            if (binding.NavParams != null)
                foreach (var (param, val) in binding.NavParams)
                {
                    try { args.Add((param, PrototypeExpr.Val(val, scope))); }
                    catch (PrototypeExpressionException ex) { Unevaluable(node, "nav " + param, ex.Message); }
                }
            spec.Handler = new PrototypeHandler(eventName, binding.Screen, binding.Action, args, extended);
            return;
        }
    }

    /// <summary>The view an href of a route names ("#catalogo", "#pedido/1003" for pedido/{id}), with the arguments of its
    /// parameters (the literal values of the href).</summary>
    private (string View, List<(string Argument, string Value)> Arguments)? RouteOf(string href)
    {
        if (!href.StartsWith('#') || href.Length < 2) return null;
        var path = href[1..].Split('/');
        foreach (var view in _c.Capture.Views)
        {
            var template = (view["template"]?.ToString() ?? view["route"]?.ToString()?.TrimStart('#') ?? "").Split('/');
            if (template.Length != path.Length) continue;
            var args = new List<(string, string)>();
            var ok = true;
            var parameters = PrototypeCapture.Objects(view["params"]);
            for (var i = 0; i < template.Length && ok; i++)
            {
                if (template[i].StartsWith('{') && template[i].EndsWith('}'))
                {
                    var p = parameters.FirstOrDefault();
                    if (p == null) { ok = false; break; }
                    args.Add((p["name"]!.ToString(), PrototypeExpr.Literal(JsonValue.Create(path[i]), p["type"]?.ToString() ?? "Text")));
                }
                else if (!string.Equals(template[i], path[i], StringComparison.Ordinal)) ok = false;
            }
            if (ok) return (view["key"]!.ToString(), args);
        }
        return null;
    }

    /// <summary>An attribute expression of a parameter (IntegerToText(x) of data-id) back to the typed value it formats.</summary>
    private static string Unquote(string text, string? type)
    {
        var m = Regex.Match(text, @"^IntegerToText\((.*)\)$");
        if (m.Success && type is "Integer" or null) return m.Groups[1].Value;
        // the literal value of an attribute the capture could not express (data-id="501" of a row that changes with the
        // session) passed to a numeric parameter: the number itself, never the quoted text (Verify: Integer required)
        var number = Regex.Match(text, @"^""(-?\d+(?:\.\d+)?)""$");
        if (number.Success && (type == "Decimal" || (type == "Integer" && !number.Groups[1].Value.Contains('.')))) return number.Groups[1].Value;
        // a text expression of the attribute (an If over the session whose branches are the texts "501" and "503") for a
        // numeric parameter: converted, as the attribute's text is what the prototype read
        if (type is "Integer" or "Decimal" && text.Contains('"')) return (type == "Integer" ? "TextToInteger(" : "TextToDecimal(") + text + ")";
        return text;
    }

    /// <summary>A data table of the prototype (the owner's VpBookings bug of 2026-10-18, the html op's ScreenHtmlTables.NativeTable):
    /// a &lt;table&gt; whose only parts are a &lt;thead&gt; of one row of &lt;th&gt; and a &lt;tbody&gt; whose one row of &lt;td&gt;
    /// repeats over a collection is the native Table: its Source the list's, one header cell and one row cell per column (aligned by
    /// construction), the class of the header row and of the template row its StyleHeader and StyleRow. A cell of it spans one column
    /// and one row (the owner's rule of 2026-10-19, round 5: RowCells). A table of another shape, or whose parts carry behavior of
    /// their own (a condition, an event, a computed attribute that is not a class), stays the HTML elements and the List it was
    /// (null), said in degraded (TABLE_NOT_NATIVE).</summary>
    private WidgetNode? DataTable(JsonObject node, PrototypeScope scope)
    {
        static List<JsonObject>? Parts(JsonObject n)
        {
            var parts = new List<JsonObject>();
            foreach (var c in n["c"] as JsonArray ?? [])
            {
                if (c is not JsonObject o) continue;
                if (o["t"] == null) { if (o["expr"] != null || Collapse.Replace(o["x"]?.ToString() ?? "", " ").Trim().Length > 0) return null; continue; }
                parts.Add(o);
            }
            return parts;
        }
        // A part with no behavior of its own; a row and a cell may compute their class (the Style of its widget), a row its other
        // attributes too (left out below: a row of the Table holds none).
        static bool Plain(JsonObject n, bool computedClass = false, bool row = false) => n["if"] == null && n["list"] == null && n["nav"] == null && n["control"] == null
            && n["events"] is not JsonArray { Count: > 0 } && (computedClass || n["classExpr"] == null)
            && (n["attrExpr"] is not JsonObject computed || row || computedClass && computed.All(a => string.Equals(a.Key, "class", StringComparison.OrdinalIgnoreCase)));
        if (Parts(node) is not [var head, var body] || head["t"]?.ToString() != "thead" || body["t"]?.ToString() != "tbody") return null;
        if (body["list"] is not JsonObject list || list["mode"]?.ToString() != "self" || list["template"] is not JsonObject template || template["t"]?.ToString() != "tr") return null;
        if (Parts(head) is not [var headRow] || headRow["t"]?.ToString() != "tr") return null;
        if (Parts(headRow) is not { } headers || Parts(template) is not { } cells) return null;
        if (headers.Any(h => h["t"]?.ToString() != "th") || cells.Any(c => c["t"]?.ToString() != "td")) return null;
        // The shape of a data table: what keeps it from the native Table is said (the review of round 1, M3), never silent.
        string? why = null;
        // A colspan that explains the shorter row (the html op's rule, ScreenHtmlTables.SpanExplains) makes the rows as wide: the
        // Table's columns are the prototype's (RowCells); a different count it does not explain stays the old form, its spans named.
        var explains = Anvil.Reading.ScreenHtmlTables.SpanExplains(headers.Select(SpanNode).ToList(), cells.Select(SpanNode).ToList());
        if (headers.Count != cells.Count && !explains)
        {
            var spans = headers.Concat(cells).SelectMany(c => Anvil.Reading.ScreenHtmlTables.Spans(SpanNode(c)).Select(sp => $"{sp.Attribute}=\"{sp.Value}\" on a <{c["t"]}>")).Distinct().ToList();
            why = $"its header row has {headers.Count} cells and its template row {cells.Count}" + (spans.Count > 0 ? $", which its spans do not explain ({string.Join(", ", spans)})" : "");
        }
        else if (!Plain(head) || body["if"] != null || body["events"] is JsonArray { Count: > 0 } || body["classExpr"] != null || body["attrExpr"] != null
            || !Plain(headRow, computedClass: true, row: true) || !Plain(template, computedClass: true, row: true))
            why = "a part of it (thead, tbody or a row) has a condition, an event or a computed attribute of its own";
        else if (headers.Concat(cells).FirstOrDefault(c => !Plain(c, computedClass: true)) is { } cell)
            why = $"a <{cell["t"]}> has a condition, an event or a computed attribute of its own (a sortable header, a clickable cell)";
        if (why != null)
        {
            // The List of its <tbody> takes F1 of the html op (ListWidget): its rows stay the table's row group, under the header.
            _c.Degraded.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["code"] = "TABLE_NOT_NATIVE", ["message"] = "a data table stays HTML elements and a List: " + why,
                ["done"] = $"HTML elements and a List whose rows are the table's row group ({ScreenVisual.ListRendersAllRows}: disable-virtualization and {ScreenVisual.RowsMarker} on the List, the native layout block in the theme)" });
            return null;
        }
        // What a section or a row says beside its class (a data attribute of the prototype's own script, data-admin-product="1"):
        // the native Table holds none, so it is left out and listed; the class of a section joins its row's (RowStyle).
        foreach (var part in new[] { head, headRow, body, template })
        {
            var left = Attrs(part).Select(a => a.Name).Concat((part["attrExpr"] as JsonObject ?? []).Select(a => a.Key))
                .Where(n => !string.Equals(n, "class", StringComparison.OrdinalIgnoreCase)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (left.Count > 0)
                _c.Degraded.Add(new JsonObject { ["k"] = part["k"]?.ToString(), ["code"] = part["t"]?.ToString() == "tr" ? "TABLE_ROW_ATTRIBUTE" : "TABLE_SECTION_ATTRIBUTE",
                    ["message"] = $"the <{part["t"]}> of a native Table holds no attribute: " + string.Join(", ", left), ["done"] = "left out" });
        }
        var spec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
        _c.Lists++; _c.Widgets++; _c.Elements++;
        var itemScope = ListSource(body, list, scope, spec, out _);
        ElementMapping mapping;
        try { mapping = _c.Element(new ElementRequest(_c.Platform, "table", Attrs(node), false, false, false, true)); }
        catch { mapping = new ElementMapping("IAdvancedHtml", "table", null, [], [], [], null, null); }
        var classes = new List<string>(mapping.Classes);
        if (Attr(node, "id") is { Length: > 0 } id)
        {
            if (_c.Ids.TryGetValue(id, out var name)) spec.Name = name;
            if (_c.IdClasses.TryGetValue(id, out var cls) && !classes.Contains(cls)) classes.Add(cls);
        }
        var style = StyleExpression(node, classes, scope);
        spec.Properties.Add(("Style", style.Expression ?? PrototypeExpr.Quote(style.Static)));
        spec.Properties.Add(("StyleHeader", RowStyle(head, headRow, scope)));
        spec.Properties.Add(("StyleRow", RowStyle(body, template, itemScope)));
        // the attributes of the table as every widget made from the map writes them (MappedAttributes); its inline style an
        // attribute (no CustomStyle)
        spec.Extended.AddRange(MappedAttributes(node, mapping, null));
        if (mapping.Properties.FirstOrDefault(p => p.Property == "CustomStyle").Value is { Length: > 0 } inline
            && !spec.Extended.Any(x => string.Equals(x.Name, "style", StringComparison.OrdinalIgnoreCase)))
            spec.Extended.Add(("style", PrototypeExpr.Quote(inline)));
        spec.Name ??= _c.Names.Free("Table");
        _c.ExtendedProperties += spec.Extended.Count;
        var children = RowCells(headers, "IHeaderCell", scope, explains).Concat(RowCells(cells, "IRowCell", itemScope, explains)).ToList();
        var widget = new WidgetNode("ITableRecords", node["k"]?.ToString(), "table", style.Static, spec.Extended.Select(e => (e.Name, e.Value)).ToList(),
            null, null, null, list.DeepClone(), children, null, null);
        _c.Specs[widget] = spec;
        return widget;
    }

    /// <summary>The class of a header row or of the template row (its StyleHeader, StyleRow): the static classes of its section
    /// (&lt;thead&gt;, &lt;tbody&gt;: a Table has no class of its own for them) and its own, or the expression the capture computed for
    /// the row in its scope, after the section's.</summary>
    private string RowStyle(JsonObject section, JsonObject row, PrototypeScope scope)
    {
        var classes = (Attr(row, "class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var style = StyleExpression(row, classes, scope);
        var text = style.Expression ?? PrototypeExpr.Quote(style.Static);
        if ((Attr(section, "class") ?? "").Trim() is not { Length: > 0 } sectionClass) return text;
        return IsLiteral(text) ? PrototypeExpr.Quote((sectionClass + " " + Literal(text)).Trim()) : PrototypeExpr.Quote(sectionClass + " ") + " + " + text;
    }

    /// <summary>The cells of a row of a native Table, each of one column and one row (the owner's rule of 2026-10-19 in the importer,
    /// round 5: the patch the html op offers for the same table, applied and said, ScreenHtmlTables). A colspan that explains the
    /// shorter row (<paramref name="explains"/>) is the cell and one empty cell per column it covered after it, so the Table's
    /// columns are the prototype's and every other cell stays in its column; any other colspan, and every rowspan (a header row is
    /// one row; the template row repeats once per record, where rowspan pushes the next record's cells), is left out and the cells
    /// pair one by one. A native Table never carries the span on its cell (its published columns would shift in silence). Each span
    /// left out is listed in degraded (TABLE_CELL_SPAN, the cell's key).</summary>
    private List<WidgetNode> RowCells(List<JsonObject> row, string type, PrototypeScope scope, bool explains)
    {
        var widgets = new List<WidgetNode>();
        foreach (var source in row)
        {
            var node = SpanNode(source);
            var tag = source["t"]!.ToString();
            widgets.Add(Cell(source, type, scope));
            var covered = explains ? Anvil.Reading.ScreenHtmlTables.Span(node) - 1 : 0;
            foreach (var (attribute, value) in Anvil.Reading.ScreenHtmlTables.Spans(node))
            {
                var filled = covered > 0 && attribute.Equals("colspan", StringComparison.OrdinalIgnoreCase);
                _c.Degraded.Add(new JsonObject
                {
                    ["k"] = source["k"]?.ToString(), ["code"] = "TABLE_CELL_SPAN",
                    ["message"] = $"{attribute}=\"{value}\" on a <{tag}> of a native Table: " + Anvil.Reading.ScreenHtmlTables.SpanWhy(attribute, tag),
                    ["done"] = filled ? $"left out, and {covered} empty <{tag}> after the cell, one per column it spanned" : "left out",
                });
            }
            for (var i = 0; i < covered; i++) widgets.Add(EmptyCell(type, tag));
        }
        return widgets;
    }

    /// <summary>An empty header cell or row cell: a column a colspan of the prototype covered (no key: the measure reads it as the
    /// runtime's own element).</summary>
    private WidgetNode EmptyCell(string type, string tag)
    {
        var widget = new WidgetNode(type, null, tag, null, new List<(string Name, string Value)>(), null, null, null, null, new List<WidgetNode>(), null, null);
        _c.Specs[widget] = new PrototypeWidgetSpec { Name = _c.Names.Free(PrototypeNames.TagStem(tag)) };
        _c.Widgets++; _c.Elements++;
        return widget;
    }

    /// <summary>A cell of the capture as a node of the language (its tag and its static attributes), for the rules of a native
    /// Table's cells the html op and the importer share (ScreenHtmlTables.Spans, SpanExplains).</summary>
    private static Anvil.Reading.ScreenHtml.Node SpanNode(JsonObject cell)
        => new() { Tag = cell["t"]?.ToString() ?? "", Attributes = Attrs(cell).Select(a => new KeyValuePair<string, string>(a.Name, a.Value)).ToList() };

    /// <summary>A cell of a data table: the element the map gives its &lt;th&gt; or &lt;td&gt; (its class, attributes and children),
    /// as the header cell or the row cell of its column (no Tag; its inline style an attribute; never its span, RowCells).</summary>
    private WidgetNode Cell(JsonObject cell, string type, PrototypeScope scope)
    {
        var built = Element(cell, scope, false);
        var spec = _c.Specs[built];
        _c.Specs.Remove(built);
        spec.Properties.RemoveAll(p => p.Property is "Tag" or "Enabled" or "IsDefault");
        var spans = Anvil.Reading.ScreenHtmlTables.Spans(SpanNode(cell)).Select(sp => sp.Attribute).ToList();
        _c.ExtendedProperties -= spec.Extended.RemoveAll(x => spans.Contains(x.Name, StringComparer.OrdinalIgnoreCase));
        if (spec.Properties.FirstOrDefault(p => p.Property == "CustomStyle").Value is { Length: > 0 } inline
            && !spec.Extended.Any(x => string.Equals(x.Name, "style", StringComparison.OrdinalIgnoreCase)))
            spec.Extended.Add(("style", PrototypeExpr.Quote(inline)));
        spec.Properties.RemoveAll(p => p.Property == "CustomStyle");
        var widget = built with { W = type, Tag = cell["t"]!.ToString(), Attributes = spec.Extended.Select(e => (e.Name, e.Value)).ToList() };
        _c.Specs[widget] = spec;
        return widget;
    }

    /// <summary>The source of a list and the scope of its row, written on the spec: the output of a Data Action when data.bind binds
    /// it (its slots need bind.slots), the aggregate of its collection otherwise; <paramref name="bound"/> whether it has one.</summary>
    private PrototypeScope ListSource(JsonObject node, JsonObject list, PrototypeScope scope, PrototypeWidgetSpec spec, out bool bound)
    {
        var binding = _c.List(list);
        bound = binding != null;
        PrototypeScope itemScope = scope;
        if (binding?.Source != null)
        {
            spec.Properties.Add(("Source", binding.Source));
            // the prototype's fields are not the producer's: an unbound slot of the row keeps its literal (listed unevaluable)
            itemScope = scope.With(field: (field, _) => throw new PrototypeExpressionException($"the list is bound to {binding.Source}: the field {field} of the prototype's collection needs bind.slots"), fieldType: (_, _) => null);
        }
        else if (binding != null)
        {
            spec.Properties.Add(("Source", binding.Aggregate + ".List"));
            itemScope = scope.With(
                field: (field, via) => via != null && binding.Joins.TryGetValue(via, out var joined)
                    ? $"{binding.Aggregate}.List.Current.{joined}.{field}" : $"{binding.Aggregate}.List.Current.{binding.Entity}.{field}",
                fieldType: (field, via) => FieldType(via != null ? JoinedCollection(binding, via) : binding.Collection, field));
        }
        else _c.Unevaluable.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["what"] = "list", ["why"] = "the list has no source on this owner" });
        return itemScope;
    }

    private WidgetNode ListWidget(JsonObject node, JsonObject list, PrototypeScope scope, bool self)
    {
        var spec = new PrototypeWidgetSpec { SourceKey = node["k"]?.ToString() };
        _c.Lists++; _c.Widgets++;
        var template = list["template"] as JsonObject;
        var items = new List<WidgetNode>();
        var itemScope = ListSource(node, list, scope, spec, out var bound);
        spec.Properties.Add(("Mode", "Custom"));
        spec.Extended.Add(("disable-virtualization", "True"));
        if (template != null) items.AddRange(Node(template, itemScope, false));
        string? tag; string style;
        if (self)
        {
            var tagName = node["t"]!.ToString();
            ElementMapping mapping;
            try { mapping = _c.Element(new ElementRequest(_c.Platform, tagName, Attrs(node), false, false, false, true)); }
            catch { mapping = new ElementMapping("IList", tagName, null, [], [], [], null, null); }
            tag = mapping.Tag ?? tagName;
            var classes = new List<string>(mapping.Classes);
            if (Attr(node, "id") is { Length: > 0 } id)
            {
                if (_c.Ids.TryGetValue(id, out var name)) spec.Name = name;
                if (_c.IdClasses.TryGetValue(id, out var cls) && !classes.Contains(cls)) classes.Add(cls);
            }
            style = string.Join(" ", classes);
            // the inline style of the list element, as the element map writes it for any element (CustomStyle)
            foreach (var (property, value) in mapping.Properties.Where(p => p.Property == "CustomStyle")) spec.Properties.Add((property, value));
            // the attributes of the list's own element as every widget made from the map writes them (MappedAttributes): the map's
            // values are quoted literals already (X1 of the review of round 6: quoted again here, they were published with the quotes)
            spec.Extended.AddRange(MappedAttributes(node, mapping, null));
            // the inline style of the list's own element (a React column: display flex, direction column): an attribute of the
            // list, as the class is its Style
            if (mapping.Properties.FirstOrDefault(p => p.Property == "CustomStyle").Value is { Length: > 0 } inline
                && !spec.Extended.Any(x => string.Equals(x.Name, "style", StringComparison.OrdinalIgnoreCase)))
                spec.Extended.Add(("style", PrototypeExpr.Quote(inline)));
            if (mapping.SubstitutedFrom != null) _c.SubstitutedTags.Add(mapping.SubstitutedFrom);
            _c.Elements++;
            // F1 of the html op (ScreenVisual; the DemoLATAM D1 the owner saw in VpBookings, round 6 of fix/data-table): a List that
            // is a part of a table (the body of a data table that stays HTML elements and a List, TABLE_NOT_NATIVE, or of any other
            // table) renders every row (disable-virtualization above) and carries the rows marker, so the native layout block the
            // planner writes in the import's theme lays it out as the table's row group at auto width. Without it the runtime
            // publishes it display:block with OSFillParent and its cells no longer line up under the header cells.
            if (ScreenVisual.TablePartReason(tag) != null && !spec.Extended.Any(x => string.Equals(x.Name, ScreenVisual.RowsMarker, StringComparison.OrdinalIgnoreCase)))
                spec.Extended.Add((ScreenVisual.RowsMarker, ScreenVisual.MarkerValue));
        }
        else { tag = "div"; style = "ssam-list"; }
        spec.Name ??= _c.Names.Free(bound ? "List" : "ListLiteral");
        spec.Properties.Add(("Tag", tag ?? "div"));
        spec.Properties.Add(("Style", PrototypeExpr.Quote(style)));
        _c.ExtendedProperties += spec.Extended.Count;
        var widget = new WidgetNode("IList", node["k"]?.ToString(), tag, style, spec.Extended.Select(e => (e.Name, e.Value)).ToList(), null, null, null, list.DeepClone(), items, null, self ? null : "wrapper");
        _c.Specs[widget] = spec;
        return widget;
    }

    private string? JoinedCollection(PrototypeListBinding binding, string via)
        => _c.Capture.Collection(binding.Collection)?["references"] is JsonArray refs
            ? refs.OfType<JsonObject>().FirstOrDefault(r => r["field"]?.ToString() == via)?["collection"]?.ToString() : null;

    private string? FieldType(string? collection, string field) => PrototypePlanner.FieldTypeOf(_c.Capture, collection, field);

    private void Unevaluable(JsonObject node, string what, string why)
        => _c.Unevaluable.Add(new JsonObject { ["k"] = node["k"]?.ToString(), ["what"] = what, ["why"] = why });
}
