using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// CX17 7.1: the DOM the runtime will publish for a compiled screen or block, predicted from the model (read as the importer reads
/// it, PrototypeRender.ReadWidget) and the runtime DOM table of the platform: wrappers, data-* attributes, the author's classes,
/// the runtime classes of property values (Width (fill parent): OSFillParent; the gutter after a neighbor; an empty class
/// expression on a type the Studio gives a class: that class between quotes, as the runtime published it), the virtualization
/// sentinels of a List that renders by batches, and the widget and key on every node. No layout, no network, no Studio running;
/// an inferred row marks its nodes (data-ssam-runtime="inferred"). The same predictor reads the delivered module (before) and a
/// new compile (after).
/// </summary>
public static partial class ScreenVisual
{
    /// <summary>The widgets the runtime published with OSFillParent when their Width is (fill parent) (DemoLATAM, 2026-10-14:
    /// input, label, List; a text area is inferred from the input).</summary>
    private static readonly HashSet<string> FillParentKinds = new(StringComparer.Ordinal) { "Input", "TextArea", "Label", "List" };

    /// <summary>The widgets the runtime published with ThemeGrid_MarginGutter after a neighbor (DemoLATAM, 2026-10-14: a 9, button 5,
    /// form 1); a dropdown after its label had none.</summary>
    private static readonly HashSet<string> GutterKinds = new(StringComparer.Ordinal) { "Link", "Button", "Form" };

    /// <summary>The counts of the families a prediction shows.</summary>
    public sealed class Prediction
    {
        public DomNode Root { get; init; } = DomNode.Fragment();
        /// <summary>Elements whose class attribute carries a class between quotes (F2).</summary>
        public int QuotedClasses { get; set; }
        /// <summary>Elements with ThemeGrid_MarginGutter (F3).</summary>
        public int Gutters { get; set; }
        /// <summary>Lists that render their virtualization sentinels (F1).</summary>
        public int ListsWithSentinels { get; set; }
        /// <summary>Lists that are a table part, an HTML list or a layout container and still render their sentinels (F1).</summary>
        public int LayoutListsWithSentinels { get; set; }
        /// <summary>Widgets rendered through an inferred row of the table.</summary>
        public int Inferred { get; set; }
        /// <summary>The widget's own predicted element by its model key.</summary>
        public Dictionary<string, DomNode> ByKey { get; } = new(StringComparer.Ordinal);
        /// <summary>The class of every widget of a type the Studio gives a class, by type and form: "unset" (no Style or an empty
        /// expression), "empty literal" (""), "studio" (the Studio's class), "literal" (another), "expression" (computed).</summary>
        public Dictionary<string, Dictionary<string, int>> StyleCensus { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>The tags of the document and the widget each one creates, for the contract (api --op html, document.runtime).</summary>
    private static readonly (string Tag, string Widget)[] ContractTags =
    [
        ("input", "IInput"), ("textarea", "ITextArea"), ("select", "IDropdown"), ("input type=checkbox", "ICheckbox"), ("label", "ILabel"),
        ("<x list>", "IList"), ("{{ }}", "IExpression"), ("form", "IForm"), ("button", "IButton"), ("a", "ILink"),
    ];

    /// <summary>The contract's DOM of the runtime per document tag (generated from the runtime table and the class decisions, never
    /// written by hand): the elements outermost first, the class a new widget without class gets, and the selector of the box (the
    /// layout item: flex/grid, width, margin) and of the control (its look).</summary>
    public static JsonObject RuntimeContract(string platform)
    {
        var contract = new JsonObject
        {
            ["rule"] = "each tag as the runtime publishes it: lay out the box (flex/grid item, width, margin), style the control; a selector on the bare tag misses the box (HTML_SELECTOR_MISSES_RUNTIME brings the patch)",
            ["status"] = RuntimeDomTable.IsOdc(platform) ? "inferred" : "evidence",
        };
        foreach (var (tag, widget) in ContractTags)
        {
            var row = RuntimeDomTable.Row(platform, widget);
            if (row == null) continue;
            var element = RuntimeDomTable.ElementSelector(row);
            if (row.Element is { } e && e.StartsWith('{')) element = "<x>" + element;
            if (widget == "ICheckbox" || widget == "IInput" && tag == "input") element = element.StartsWith("input", StringComparison.Ordinal) ? element : "input" + element;
            var wrappers = row.Wrappers.Select(w => widget == "IInput" && w.Tag == "span" && w.Classes.Count == 0 && w.Attributes.Count == 0 ? "span.input-<type>" : w.Selector).ToList();
            var decision = DecisionFor(widget);
            var cls = decision == null ? null : decision.Rule == ClassRule.Kept ? decision.StudioClass : decision.Written;
            var runtime = row.Classes.Select(c => c.Class).Concat(GutterKinds.Contains(widget[1..]) ? ["ThemeGrid_MarginGutter after a neighbor"] : []).ToList();
            var text = string.Join(" > ", wrappers.Append(element));
            if (cls != null) text += $"; no class: {cls.Trim('"')}";
            if (runtime.Count > 0) text += "; +" + string.Join(", +", runtime);
            if (widget == "IList") text += "; every row in a table part or a grid";
            text += wrappers.Count > 0 ? $"; box {wrappers[0]}" : "";
            contract[tag] = text;
        }
        return contract;
    }

    /// <summary>Every screen and block of a saved module predicted (root name -> prediction), the module released: the before and
    /// after of the acceptance read the same way. <paramref name="keep"/> chooses the roots by name.</summary>
    public static Dictionary<string, Prediction> PredictOml(ModelHost host, string omlPath, string platform, Func<string, bool>? keep = null)
    {
        var module = host.Load(omlPath);
        try
        {
            var reader = new KernelModelReader();
            var top = (OutSystems.Model.IObjectSignature)module;
            var predictions = new Dictionary<string, Prediction>(StringComparer.Ordinal);
            foreach (var flow in reader.ChildrenOf(top).Where(c => reader.KindOf(c) is "MobileFlow" or "WebFlow"))
                foreach (var root in reader.ChildrenOf(flow).Where(c => reader.KindOf(c) is "MobileScreen" or "MobileBlock"))
                {
                    var name = reader.NameOf(root);
                    if (keep != null && !keep(name)) continue;
                    predictions[name] = Predict(reader, root, platform);
                }
            return predictions;
        }
        finally { ModelHost.Release(module); }
    }

    /// <summary>The predicted runtime DOM of one root (a screen or a block) of a model.</summary>
    public static Prediction Predict<T>(ModelReader<T> reader, T root, string platform) where T : class
    {
        platform = RuntimeDomTable.IsOdc(platform) ? "odc" : "o11";
        var model = PrototypeRender.ReadRoot(reader, root);
        var prediction = new Prediction();
        var predictor = new Predictor<T>(reader, platform, prediction);
        var top = prediction.Root.Add(DomNode.Element("div"));
        top.SetAttr("data-ssam-root", model.Name);
        predictor.Emit(model.Widgets, top, null, 0);
        return prediction;
    }

    /// <summary>The classes an expression of Style publishes: a string literal its words; an empty expression on a type the Studio
    /// gives a class, that class with its quotes (the runtime publishes the Studio's text); any other expression none (dynamic).</summary>
    public static IReadOnlyList<string> PublishedClasses(string? style, string kind, string platform, out bool quoted, out bool dynamic)
    {
        // Saved, an empty expression is no Style at all (the module read back has Style null: DemoLATAM_UI, the inputs of the
        // document form), so an unset Style is the same.
        quoted = false; dynamic = false;
        var text = (style ?? "").Trim();
        if (text.Length == 0)
        {
            var type = "I" + kind;
            if (PrototypeWidgetDefaults.Table.TryGetValue(RuntimeDomTable.IsOdc(platform) ? "odc" : "o11", out var table) && table.TryGetValue(type, out var d) && d.Style != null)
            {
                quoted = true;
                return d.Style.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            }
            return [];
        }
        if (IsStringLiteral(text)) return text[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        dynamic = true;
        return [];
    }

    private static bool IsStringLiteral(string text)
    {
        if (text.Length < 2 || text[0] != '"' || text[^1] != '"') return false;
        for (var i = 1; i < text.Length - 1; i++)
            if (text[i] == '"') { if (i + 1 < text.Length - 1 && text[i + 1] == '"') i++; else return false; }
        return true;
    }

    private static string Unquote(string text) => text.Length >= 2 && text[0] == '"' && text[^1] == '"' ? text[1..^1] : text;

    private static readonly Regex LastName = new(@"([A-Za-z_][A-Za-z0-9_]*)\s*\)*\s*$", RegexOptions.Compiled);
    private static readonly Regex StringLiteral = new("\"((?:[^\"]|\"\")*)\"", RegexOptions.Compiled);

    /// <summary>The classes an expression always writes: its leading string literal ("layout blank" + If(...)).</summary>
    private static string LiteralPrefix(string expression)
    {
        var text = expression.Trim();
        if (IsStringLiteral(text)) return Unquote(text);
        var m = StringLiteral.Match(text);
        return m.Success && m.Index == 0 && text[(m.Index + m.Length)..].TrimStart().StartsWith("+", StringComparison.Ordinal) ? m.Groups[1].Value.Trim() : "";
    }

    /// <summary>The text an expression shows in a prediction: a string literal's content, else the last name it reads (a stand-in of
    /// about the length of a value).</summary>
    private static string ExpressionText(string? value)
    {
        var text = (value ?? "").Trim();
        if (IsStringLiteral(text)) return Unquote(text);
        // A choice between texts shows the last one (the default branch); else the last name it reads.
        var literals = StringLiteral.Matches(text);
        if (literals.Count > 0 && literals[^1].Groups[1].Value.Trim().Length > 0) return literals[^1].Groups[1].Value;
        var m = LastName.Match(text);
        return m.Success ? m.Groups[1].Value : text.Length > 12 ? text[..12] : text;
    }

    private sealed class Predictor<T>(ModelReader<T> reader, string platform, Prediction prediction) where T : class
    {
        // Inside the widgets of a block instance the counts are the block's (counted once, in the block's own prediction);
        // a placeholder's content inside it is the page's again.
        private int blockDepth;
        private bool owned => blockDepth == 0;
        public void Emit(IReadOnlyList<PrototypeRender.NativeWidget> widgets, DomNode parent, IReadOnlyDictionary<string, List<PrototypeRender.NativeWidget>>? placeholders, int depth)
        {
            if (depth > 96) return;   // the depth of the page (Ifs, placeholders, blocks), never a loop
            for (var i = 0; i < widgets.Count; i++) One(widgets[i], parent, i > 0, placeholders, depth);
        }

        private void One(PrototypeRender.NativeWidget widget, DomNode parent, bool neighbor, IReadOnlyDictionary<string, List<PrototypeRender.NativeWidget>>? placeholders, int depth)
        {
            var kind = widget.Kind;
            if (widget.Basic is "If" or "IfWidget" || kind == "IfWidget")
            {
                // Both branches: what either may show (the check sees every element the document wrote).
                Emit(widget.Children, parent, placeholders, depth + 1);
                if (widget.Else != null) Emit(widget.Else, parent, placeholders, depth + 1);
                return;
            }
            if (widget.Basic == "PlaceholderContent") { Emit(widget.Children, parent, placeholders, depth + 1); return; }
            if (widget.Basic == "Placeholder")
            {
                if (placeholders != null && placeholders.TryGetValue(widget.Name ?? "", out var content))
                {
                    var saved = blockDepth; blockDepth = 0;
                    try { Emit(content, parent, null, depth + 1); } finally { blockDepth = saved; }
                }
                return;
            }
            if (kind.Contains("BlockInstance", StringComparison.Ordinal)) { Block(widget, parent, depth); return; }
            var row = RuntimeDomTable.Row(platform, kind);
            if (row == null || row.Element == null)
            {
                var unknown = parent.Add(DomNode.Element(widget.Props.GetValueOrDefault("Tag") is { Length: > 0 } t ? Unquote(t) : "div"));
                Mark(unknown, widget);
                Emit(widget.Children, unknown, placeholders, depth + 1);
                return;
            }
            if (row.Status == RuntimeStatus.Inferred && owned) prediction.Inferred++;
            if (row.Element == "#text" || widget.Basic == "Text") { parent.Add(Mark(DomNode.TextNode(widget.Props.GetValueOrDefault("Text") ?? ""), widget)); return; }
            var host = parent;
            foreach (var wrapper in row.Wrappers)
            {
                var element = host.Add(DomNode.Element(wrapper.Tag));
                foreach (var a in wrapper.Attributes) element.Attributes.Add(a);
                var classes = wrapper.Classes.ToList();
                // The input's span carries its type (input-text, input-number, input-search seen).
                if (kind == "Input" && wrapper.Tag == "span") classes.Add("input-" + InputType(widget.Props.GetValueOrDefault("InputType")));
                if (classes.Count > 0) element.SetAttr("class", string.Join(" ", classes));
                if (kind == "Dropdown" && !string.IsNullOrEmpty(widget.Name)) element.SetAttr("id", widget.Name + "-container");
                element.Runtime = row.Widget;
                element.RuntimeSelector = PrototypeAdapters.WrapperSelector(row, wrapper);
                if (row.Status == RuntimeStatus.Inferred) element.SetAttr("data-ssam-runtime", "inferred");
                host = element;
            }
            var tag = row.Element.StartsWith('{') ? (widget.Props.GetValueOrDefault("Tag") is { Length: > 0 } t2 ? Unquote(t2) : "div") : row.Element;
            var node = host.Add(Mark(DomNode.Element(tag), widget));
            foreach (var (name, value) in row.Attributes) if (name.StartsWith("data-", StringComparison.Ordinal)) node.Attributes.Add((name, value));
            var list = new List<string>();
            foreach (var (name, value) in row.Attributes) if (name == "class") list.AddRange(value.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            var style = StyleOf(widget);
            var published = PublishedClasses(style, kind, platform, out var quoted, out var dynamic);
            list.AddRange(published);
            if (quoted && owned) prediction.QuotedClasses++;
            if (owned && DecisionFor(kind) is { } decision)
            {
                var form = string.IsNullOrWhiteSpace(style) ? "unset" : style!.Trim() == "\"\"" ? "empty literal" : style!.Trim() == decision.StudioClass ? "studio"
                    : decision.Written != null && style!.Trim() == decision.Written ? "trimmed" : IsStringLiteral(style!.Trim()) ? "literal" : "expression";
                if (!prediction.StyleCensus.TryGetValue("I" + kind, out var forms)) prediction.StyleCensus["I" + kind] = forms = new(StringComparer.Ordinal);
                forms[form] = forms.GetValueOrDefault(form) + 1;
            }
            if (FillParentKinds.Contains(kind) && widget.Props.GetValueOrDefault("Width") == "(fill parent)") list.Add("OSFillParent");
            if (GutterKinds.Contains(kind) && neighbor && (widget.Props.GetValueOrDefault("MarginLeft") == "Adaptive" || kind == "Form")) { list.Add("ThemeGrid_MarginGutter"); if (owned) prediction.Gutters++; }
            if (list.Count > 0 || row.Attributes.Any(a => a.Name == "class")) node.SetAttr("class", string.Join(" ", list.Distinct(StringComparer.Ordinal)));
            if (dynamic) { node.SetAttr("data-ssam-class", style!); if (LiteralPrefix(style!) is { Length: > 0 } fixedPart) node.SetAttr("class", ((node.Attr("class") ?? "") + " " + fixedPart).Trim()); }
            foreach (var (name, value) in row.Attributes) if (!name.StartsWith("data-", StringComparison.Ordinal) && name != "class") node.SetAttr(name, value);
            if (row.IdRule is "name" or "block" && !string.IsNullOrEmpty(widget.Name)) node.SetAttr("id", widget.Name!);
            if (row.Status == RuntimeStatus.Inferred) node.SetAttr("data-ssam-runtime", "inferred");
            // The extended properties are attributes of the element (as, aria-*, data-*); disable-virtualization is the List's.
            var allRows = false;
            foreach (var (name, value) in widget.Extended)
            {
                if (name == "disable-virtualization") { allRows = value.Trim().Equals("True", StringComparison.OrdinalIgnoreCase); continue; }
                if (name == "class") { var c = (node.Attr("class") ?? "") + " " + LiteralPrefix(value); node.SetAttr("class", c.Trim()); continue; }
                node.SetAttr(name, ExpressionText(value));
            }
            switch (widget.Basic)
            {
                case "Input":
                    node.SetAttr("type", InputType(widget.Props.GetValueOrDefault("InputType")));
                    return;
                case "TextArea": return;
                case "Checkbox": node.SetAttr("type", "checkbox"); return;
                case "Dropdown": node.Add(DomNode.Element("option")).Add(DomNode.TextNode(ExpressionText(widget.Props.GetValueOrDefault("Labels")))); return;
                case "Expression" or "InlineExpression":
                    node.Runtime = "IExpression";
                    node.Add(DomNode.TextNode(ExpressionText(widget.Props.GetValueOrDefault("Value"))));
                    return;
                case "List":
                    node.SetAttr("style", "position: relative;");
                    if (allRows) node.SetAttr("data-virtualization-disabled", "");
                    else
                    {
                        if (owned) prediction.ListsWithSentinels++;
                        if (owned && RowGroupTags.Contains(tag)) prediction.LayoutListsWithSentinels++;
                        Sentinel(node);
                    }
                    Emit(Kids(widget), node, placeholders, depth + 1);
                    if (!allRows) Sentinel(node);
                    return;
            }
            Emit(Kids(widget), node, placeholders, depth + 1);
        }

        /// <summary>The children of a widget: an O11 HTML element or label keeps them in its Content (not a widget of the read).</summary>
        private IReadOnlyList<PrototypeRender.NativeWidget> Kids(PrototypeRender.NativeWidget widget)
        {
            if (widget.Children.Count > 0 || widget.Node is not T node || reader.PropertyOf(node, "Content") is not { } read) return widget.Children;
            object? value;
            try { value = read(); } catch { return widget.Children; }
            if (value is not T content || ReferenceEquals(content, node)) return widget.Children;
            return reader.ChildrenOf(content).Where(c => reader.IsKind(c, "Widget") && reader.KindOf(c) != "IfBranchWidget").Select(c => PrototypeRender.ReadWidget(reader, c)).ToList();
        }

        /// <summary>The Style of a widget as its expression text: an expression with no text is "" (the reading's Prop gives its
        /// type name then), a text Style its text, null when unset.</summary>
        private string? StyleOf(PrototypeRender.NativeWidget widget)
        {
            // O11 keeps the class expression in StyleClasses and its text in Style; ODC in Style.
            var style = Raw(widget, "Style");
            var classes = Raw(widget, "StyleClasses");
            return classes != null && string.IsNullOrEmpty(style) ? classes : style ?? classes;
        }

        private string? Raw(PrototypeRender.NativeWidget widget, string property)
        {
            if (widget.Node is not T node || reader.PropertyOf(node, property) is not { } read) return widget.Props.GetValueOrDefault(property);
            object? value;
            try { value = read(); } catch { return widget.Props.GetValueOrDefault(property); }
            if (value == null) return null;
            if (value is string text) return text;
            if (reader.ExpressionText(value) is { } expression) return expression;
            return value is System.Collections.IEnumerable ? null : "";
        }

        private static void Sentinel(DomNode list)
        {
            var script = list.Add(DomNode.Element("script"));
            script.SetAttr("style", "display: flex; height: 0px; width: 100%;");
            script.Runtime = "IList";
        }

        private void Block(PrototypeRender.NativeWidget widget, DomNode parent, int depth)
        {
            var row = RuntimeDomTable.Row(platform, "IMobileBlockInstanceWidget")!;
            var host = parent.Add(DomNode.Element("div"));
            foreach (var a in row.Attributes) host.Attributes.Add(a);
            host.Runtime = row.Widget;
            Mark(host, widget);
            var contents = widget.Contents.ToDictionary(c => c.Key, c => c.Value, StringComparer.OrdinalIgnoreCase);
            if (widget.SourceBlock is T block)
            {
                host.SetAttr("data-block", reader.NameOf(block));
                var blockModel = PrototypeRender.ReadRoot(reader, block);
                if (blockModel.Widgets.Count > 0 && blockDepth < 4) { blockDepth++; try { Emit(blockModel.Widgets, host, contents, depth + 1); } finally { blockDepth--; } return; }
            }
            // A block of another module (its widgets are not in this model): the placeholder contents in place.
            foreach (var (_, content) in widget.Contents) Emit(content, host, null, depth + 1);
        }

        private DomNode Mark(DomNode node, PrototypeRender.NativeWidget widget)
        {
            node.Widget = "I" + widget.Kind;
            node.Name = string.IsNullOrEmpty(widget.Name) ? null : widget.Name;
            node.ObjectKey = widget.Key;
            if (widget.Key != null && node.IsElement) prediction.ByKey.TryAdd(widget.Key, node);
            return node;
        }

        private static string InputType(string? value) => Unquote(value ?? "").Replace("Entities.InputType.", "", StringComparison.Ordinal).ToLowerInvariant() switch
        {
            "" or "text" => "text", "password" => "password", "email" => "email", "number" => "number", "phone" or "tel" => "tel",
            "search" => "search", "date" => "date", "time" => "time", "datetime" => "datetime-local", var other => other,
        };
    }
}
