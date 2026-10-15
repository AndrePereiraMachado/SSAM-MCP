using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

// ssam-html/1, the reading half (C1 of the plan "Texto do SSAM"): a screen or block of a capture as one HTML document that
// carries its source, never its rendered state. Expressions are text ({{ Value }}, if, list, bind, :Input), both branches of
// every If are written, every event with a destination is an on<event> attribute, every authored property is either a named
// attribute of the element table or os-<Property>, and every element carries k, a short key of the reading mapped to its
// ObjectKey (Keys). A widget kind without a row is <os-opaque k kind name/>, untouchable with its subtree. Shared by both
// kernels and free of Studio types: it reads only through ModelReader, like the module index and the digest.
// The same capture gives the same text and the same htmlSha256. Fixed point: Compare(document, Parse(document.Html)) has no
// difference; every authored property of every node it prints is a fact of the comparison (absent = the default of the
// table, so an omitted value is never a lost one).
public static class ScreenHtml
{
    public const string Schema = "ssam-html/1";
    // The version of what Read writes; raise it on every change of the text.
    // 4: an event inside a Popup is at the Popup's own default (Transition Fade, the platform's); an expression whose text holds
    // a brace pair of a binding is written whole ({{ text }}), so the decoder never reads it as a binding.
    public const int Extractor = 4;

    public static ScreenHtmlModule<T> Module<T>(T module, ModelReader<T> reader) where T : class => new(module, reader);

    // ---- the element table (Reactive and Mobile, O11 and ODC) ----------------------------------------------------------
    // Widget kind -> element. List and AdvancedHtml take their tag from Tag; Checkbox and RadioButton are input[type].
    internal static readonly Dictionary<string, string> WidgetTags = new(StringComparer.Ordinal) {
        ["Container"] = "div", ["Form"] = "form", ["Link"] = "a", ["Button"] = "button", ["Input"] = "input", ["Checkbox"] = "input",
        ["RadioButton"] = "radio", ["TextArea"] = "textarea", ["Dropdown"] = "select", ["RadioGroup"] = "radio-group", ["Switch"] = "switch",
        ["ButtonGroup"] = "button-group", ["ButtonGroupItem"] = "button-group-item", ["Label"] = "label", ["Image"] = "img", ["Icon"] = "i",
        ["IfWidget"] = "div", ["Popup"] = "popup", ["MobileBlockInstanceWidget"] = "Block", ["PlaceholderWidget"] = "placeholder",
        ["Upload"] = "upload", ["ListItem"] = "list-item", ["Expression"] = "expr", ["TextWidget"] = "text",
    };
    // Kinds without a row: written as os-opaque, untouchable (the plan's 1.3: tables and the generic MobileWidget; the
    // Traditional Web widgets wait for D2). A table keeps its cells' widgets written inside it (OpaqueWithChildren); a
    // Traditional widget is opaque with its whole subtree.
    internal static readonly HashSet<string> OpaqueKinds = new(StringComparer.Ordinal) {
        "TableRecords", "HeaderCell", "RowCell", "MobileWidget", "WebBlockInstanceWidget", "WebWidget", "ContainerWidget", "LinkWidget",
        "ButtonWidget", "CheckBoxWidget", "ExpressionWidget", "InputWidget", "InputPasswordWidget", "ComboBoxWidget", "RadioButtonWidget",
        "TextWidgetWeb", "ImageWidget", "ListRecordsWidget", "EditRecordWidget", "ShowRecordWidget", "UploadWidget", "IfWidgetWeb" };
    internal static readonly HashSet<string> OpaqueWithChildren = new(StringComparer.Ordinal) { "TableRecords", "HeaderCell", "RowCell", "MobileWidget" };
    // Element names the language spends on its own rows: an HTML Element (AdvancedHtml) whose Tag is one of them carries the
    // html marker; a List with one of the void tags is <list tag>.
    internal static readonly HashSet<string> ReservedTags = new(StringComparer.Ordinal) {
        "div", "form", "a", "button", "input", "textarea", "select", "radio-group", "switch", "button-group", "button-group-item", "label",
        "img", "i", "popup", "Block", "block", "placeholder", "upload", "list-item", "expr", "text", "slot", "screen", "var", "aggregate",
        "data-action", "action", "event", "style", "html-element", "list", "content", "os-opaque", "radio" };
    internal static readonly HashSet<string> VoidTags = new(StringComparer.Ordinal) {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr" };
    // ---- what is not a fact of the page ----------------------------------------------------------------------------------
    // Bookkeeping, identity, editor state, canvas positions and values derived from other properties or from the structure.
    // Every name here is listed in the schema (Schema()["notFacts"]): nothing is dropped in silence.
    internal static readonly HashSet<string> NotFacts = new(StringComparer.Ordinal) {
        "Key", "ObjectKey", "GlobalKey", "IsValid", "IsInitialized", "WasDeleted", "CustomWidgetDescriptor", "Descriptor", "CollectionDescriptor",
        "CanMoveAfter", "CanMoveBefore", "Generation", "IndexInParent", "IsDetached", "IsSystemObject", "Match", "Object", "ReadableIdentifier",
        "Referrers", "Referers", "TransactionsManager", "DisplayName", "DisplayValue", "GridLayout", "PlaceholderDescriptor", "SourceProperty",
        "HasFillParentWidth", "HasGridColsWidth", "HasValidationProperties", "IsValidationAggregator", "DataSource", "Placeholders",
        "ContextForAfterReplaceData", "WidgetTypesToProcess", "Kind", "DesignMode", "EffectiveMarginLeft", "EffectiveWidth", "ExpandedInWebEditor",
        "ApplicableCssClasses", "Connectors", "IncomingConnectors", "HorizontalPosition", "VerticalPosition", "Owner", "OwnerESpace", "ESpace",
        "Module", "Parent", "Children", "Root", "PropertyOwner", "RealPropertyOwner", "RealPropertyDescriptor", "PropertyDescriptor",
        "AttributesInPreview", "IsIterated", "IconPath", "ReadOnlyIcon",
        // Lists and pointers that repeat the structure: every widget of a screen, the content pseudo-element of an O11 widget.
        "Widgets", "Content",
        // The theme a screen or block shows: its flow's or its module's (the theme is set there, not on the screen).
        "ThemeBeingUsed" };
    // The defaults of the table: a property at its default is not written, and an absent one reads as its default. Per
    // kind, measured on the corpus of the plan (section 4: the dominant value of each property when it is a platform default:
    // empty, True, False, (fill parent), Adaptive or an enum member, in at least 60% of the widgets of that kind). A kind of
    // the table falls back to the type (empty; False for a boolean); a kind outside it also to Global. Listed in the schema.
    internal static readonly Dictionary<(string Kind, string Property), string> KindDefaults = new() {
        [("AdvancedHtml", "AlignItems")] = "Stretch",
        [("AdvancedHtml", "AlignSelf")] = "Auto",
        [("AdvancedHtml", "FlexDirection")] = "Row",
        [("AdvancedHtml", "FlexWrap")] = "NoWrap",
        [("AdvancedHtml", "Flexible")] = "Shrink",
        [("AdvancedHtml", "JustifyContent")] = "Start",
        [("AdvancedHtml", "Visible")] = "True",
        [("AdvancedHtml", "WidgetGridType")] = "None",
        [("AdvancedHtml", "Width")] = "(fill parent)",
        [("BuiltinEvent", "BuiltInValidations")] = "None",
        [("BuiltinEvent", "Transition")] = "Inherited",
        [("ButtonGroupItem", "AlignItems")] = "Stretch",
        [("ButtonGroupItem", "AlignSelf")] = "Auto",
        [("ButtonGroupItem", "Enabled")] = "True",
        [("ButtonGroupItem", "FlexDirection")] = "Row",
        [("ButtonGroupItem", "FlexWrap")] = "NoWrap",
        [("ButtonGroupItem", "Flexible")] = "Shrink",
        [("ButtonGroupItem", "JustifyContent")] = "Start",
        [("ButtonGroupItem", "Visible")] = "True",
        [("ButtonGroupItem", "WidgetGridType")] = "None",
        [("ButtonGroup", "AlignItems")] = "Stretch",
        [("ButtonGroup", "AlignSelf")] = "Auto",
        [("ButtonGroup", "FlexDirection")] = "Row",
        [("ButtonGroup", "FlexWrap")] = "NoWrap",
        [("ButtonGroup", "Flexible")] = "Shrink",
        [("ButtonGroup", "JustifyContent")] = "Start",
        [("ButtonGroup", "Visible")] = "True",
        [("ButtonGroup", "WidgetGridType")] = "None",
        [("Button", "AlignItems")] = "Stretch",
        [("Button", "AlignSelf")] = "Auto",
        [("Button", "Enabled")] = "True",
        [("Button", "FlexDirection")] = "Row",
        [("Button", "FlexWrap")] = "NoWrap",
        [("Button", "Flexible")] = "Shrink",
        [("Button", "JustifyContent")] = "Start",
        [("Button", "MarginLeft")] = "Adaptive",
        [("Button", "Visible")] = "True",
        [("Button", "WidgetGridType")] = "None",
        [("Checkbox", "AlignSelf")] = "Auto",
        [("Checkbox", "Enabled")] = "True",
        [("Checkbox", "Flexible")] = "Shrink",
        [("Checkbox", "MarginLeft")] = "Adaptive",
        [("Checkbox", "Visible")] = "True",
        [("Container", "Align")] = "Default",
        [("Container", "AlignItems")] = "Stretch",
        [("Container", "AlignSelf")] = "Auto",
        [("Container", "FlexDirection")] = "Row",
        [("Container", "FlexWrap")] = "NoWrap",
        [("Container", "Flexible")] = "Shrink",
        [("Container", "JustifyContent")] = "Start",
        [("Container", "Visible")] = "True",
        [("Container", "WidgetGridType")] = "None",
        [("Container", "Width")] = "(fill parent)",
        [("Dropdown", "AlignItems")] = "Stretch",
        [("Dropdown", "AlignSelf")] = "Auto",
        [("Dropdown", "DropdownMode")] = "Text",
        [("Dropdown", "Enabled")] = "True",
        [("Dropdown", "FlexDirection")] = "Row",
        [("Dropdown", "FlexWrap")] = "NoWrap",
        [("Dropdown", "Flexible")] = "Shrink",
        [("Dropdown", "JustifyContent")] = "Start",
        [("Dropdown", "Mandatory")] = "False",
        [("Dropdown", "MarginLeft")] = "Adaptive",
        [("Dropdown", "Visible")] = "True",
        [("Dropdown", "WidgetGridType")] = "None",
        [("Expression", "AlignSelf")] = "Auto",
        [("Expression", "Flexible")] = "Shrink",
        [("Expression", "MarginLeft")] = "Adaptive",
        [("Expression", "Visible")] = "True",
        [("Form", "AlignItems")] = "Stretch",
        [("Form", "AlignSelf")] = "Auto",
        [("Form", "FlexDirection")] = "Row",
        [("Form", "FlexWrap")] = "NoWrap",
        [("Form", "Flexible")] = "Shrink",
        [("Form", "JustifyContent")] = "Start",
        [("Form", "MarginLeft")] = "Adaptive",
        [("Form", "Visible")] = "True",
        [("Form", "WidgetGridType")] = "None",
        [("HeaderCell", "AlignItems")] = "Stretch",
        [("HeaderCell", "AlignSelf")] = "Auto",
        [("HeaderCell", "FlexDirection")] = "Row",
        [("HeaderCell", "FlexWrap")] = "NoWrap",
        [("HeaderCell", "Flexible")] = "Shrink",
        [("HeaderCell", "JustifyContent")] = "Start",
        [("HeaderCell", "Visible")] = "True",
        [("HeaderCell", "WidgetGridType")] = "None",
        [("HeaderCell", "Width")] = "(fill parent)",
        [("Icon", "AlignSelf")] = "Auto",
        [("Icon", "Flexible")] = "Shrink",
        [("Icon", "IconSize")] = "FontSize",
        [("Icon", "MarginLeft")] = "Adaptive",
        [("Icon", "Visible")] = "True",
        [("Icon", "Width")] = "(fill parent)",
        [("Image", "AlignSelf")] = "Auto",
        [("Image", "Flexible")] = "Shrink",
        [("Image", "MarginLeft")] = "Adaptive",
        [("Image", "Type")] = "Static",
        [("Image", "Visible")] = "True",
        [("Input", "AlignSelf")] = "Auto",
        [("Input", "Enabled")] = "True",
        [("Input", "Flexible")] = "Shrink",
        [("Input", "InputType")] = "Text",
        [("Input", "Mandatory")] = "False",
        [("Input", "Visible")] = "True",
        [("Input", "Width")] = "(fill parent)",
        [("Join", "JoinType")] = "Left",
        [("Label", "AlignItems")] = "Stretch",
        [("Label", "AlignSelf")] = "Auto",
        [("Label", "FlexDirection")] = "Row",
        [("Label", "FlexWrap")] = "NoWrap",
        [("Label", "Flexible")] = "Shrink",
        [("Label", "JustifyContent")] = "Start",
        [("Label", "Visible")] = "True",
        [("Label", "WidgetGridType")] = "None",
        [("Label", "Width")] = "(fill parent)",
        [("Link", "AlignItems")] = "Stretch",
        [("Link", "AlignSelf")] = "Auto",
        [("Link", "Enabled")] = "True",
        [("Link", "FlexDirection")] = "Row",
        [("Link", "FlexWrap")] = "NoWrap",
        [("Link", "Flexible")] = "Shrink",
        [("Link", "JustifyContent")] = "Start",
        [("Link", "MarginLeft")] = "Adaptive",
        [("Link", "Visible")] = "True",
        [("Link", "WidgetGridType")] = "None",
        [("ListItem", "AlignItems")] = "Stretch",
        [("ListItem", "AlignSelf")] = "Auto",
        [("ListItem", "FlexDirection")] = "Row",
        [("ListItem", "FlexWrap")] = "NoWrap",
        [("ListItem", "Flexible")] = "Shrink",
        [("ListItem", "JustifyContent")] = "Start",
        [("ListItem", "TriggerActionOnFullSwipeLeft")] = "True",
        [("ListItem", "TriggerActionOnFullSwipeRight")] = "True",
        [("ListItem", "Visible")] = "True",
        [("ListItem", "WidgetGridType")] = "None",
        [("ListItem", "Width")] = "(fill parent)",
        [("List", "AlignItems")] = "Stretch",
        [("List", "AlignSelf")] = "Auto",
        [("List", "AnimateItems")] = "True",
        [("List", "FlexDirection")] = "Row",
        [("List", "FlexWrap")] = "NoWrap",
        [("List", "Flexible")] = "Shrink",
        [("List", "JustifyContent")] = "Start",
        [("List", "Mode")] = "Default",
        [("List", "Visible")] = "True",
        [("List", "WidgetGridType")] = "None",
        [("List", "Width")] = "(fill parent)",
        [("MobileBlock", "GridType")] = "Fluid",
        [("MobileScreen", "GridType")] = "Fluid",
        [("MobileScreen", "URLStructure")] = "QueryString",
        [("PlaceholderWidget", "Align")] = "Null",
        [("PlaceholderWidget", "AlignItems")] = "Stretch",
        [("PlaceholderWidget", "AlignSelf")] = "Auto",
        [("PlaceholderWidget", "FlexDirection")] = "Row",
        [("PlaceholderWidget", "FlexWrap")] = "NoWrap",
        [("PlaceholderWidget", "Flexible")] = "Shrink",
        [("PlaceholderWidget", "JustifyContent")] = "Start",
        [("PlaceholderWidget", "WidgetGridType")] = "None",
        [("PlaceholderWidget", "Width")] = "(fill parent)",
        [("Popup", "AlignItems")] = "Stretch",
        [("Popup", "AlignSelf")] = "Auto",
        [("Popup", "FlexDirection")] = "Row",
        [("Popup", "FlexWrap")] = "NoWrap",
        [("Popup", "Flexible")] = "Shrink",
        [("Popup", "JustifyContent")] = "Start",
        [("Popup", "Visible")] = "True",
        [("Popup", "WidgetGridType")] = "None",
        [("Popup", "Width")] = "(fill parent)",
        [("RadioButton", "AlignItems")] = "Stretch",
        [("RadioButton", "AlignSelf")] = "Auto",
        [("RadioButton", "Enabled")] = "True",
        [("RadioButton", "FlexDirection")] = "Row",
        [("RadioButton", "FlexWrap")] = "NoWrap",
        [("RadioButton", "Flexible")] = "Shrink",
        [("RadioButton", "JustifyContent")] = "Start",
        [("RadioButton", "Visible")] = "True",
        [("RadioButton", "WidgetGridType")] = "None",
        [("RadioGroup", "AlignItems")] = "Stretch",
        [("RadioGroup", "AlignSelf")] = "Auto",
        [("RadioGroup", "FlexDirection")] = "Row",
        [("RadioGroup", "FlexWrap")] = "NoWrap",
        [("RadioGroup", "Flexible")] = "Shrink",
        [("RadioGroup", "JustifyContent")] = "Start",
        [("RadioGroup", "Mandatory")] = "False",
        [("RadioGroup", "Visible")] = "True",
        [("RadioGroup", "WidgetGridType")] = "None",
        [("RadioGroup", "Width")] = "(fill parent)",
        [("RowCell", "AlignItems")] = "Stretch",
        [("RowCell", "AlignSelf")] = "Auto",
        [("RowCell", "FlexDirection")] = "Row",
        [("RowCell", "FlexWrap")] = "NoWrap",
        [("RowCell", "Flexible")] = "Shrink",
        [("RowCell", "JustifyContent")] = "Start",
        [("RowCell", "Visible")] = "True",
        [("RowCell", "WidgetGridType")] = "None",
        [("RowCell", "Width")] = "(fill parent)",
        [("ScreenAggregate", "CacheInMinutes")] = "",
        [("ScreenAggregate", "Fetch")] = "AtStart",
        [("Sort", "SortDirection")] = "Ascending",
        [("Switch", "Enabled")] = "True",
        [("Switch", "MarginLeft")] = "Adaptive",
        [("Switch", "Visible")] = "True",
        [("TableRecords", "AlignSelf")] = "Auto",
        [("TableRecords", "Flexible")] = "Shrink",
        [("TableRecords", "ShowHeader")] = "True",
        [("TableRecords", "Visible")] = "True",
        [("TableRecords", "Width")] = "(fill parent)",
        [("TextArea", "AlignSelf")] = "Auto",
        [("TextArea", "Enabled")] = "True",
        [("TextArea", "Flexible")] = "Shrink",
        [("TextArea", "Mandatory")] = "False",
        [("TextArea", "TextLines")] = "3",
        [("TextArea", "Visible")] = "True",
        [("TextArea", "Width")] = "(fill parent)",
        [("UILifeCycleEvent", "BuiltInValidations")] = "None",
        [("UILifeCycleEvent", "Transition")] = "Inherited",
        [("Upload", "AlignItems")] = "Stretch",
        [("Upload", "AlignSelf")] = "Auto",
        [("Upload", "FlexDirection")] = "Row",
        [("Upload", "FlexWrap")] = "NoWrap",
        [("Upload", "Flexible")] = "Shrink",
        [("Upload", "JustifyContent")] = "Start",
        [("Upload", "Mandatory")] = "False",
        [("Upload", "Visible")] = "True",
        [("Upload", "WidgetGridType")] = "None",
        [("Upload", "Width")] = "(fill parent)",
        [("List", "Tag")] = "div",
        // An input or a text area takes the length of a Text variable: 50 and 500 in 97% and 92% of the corpus.
        [("Input", "MaxLength")] = "50",
        [("TextArea", "MaxLength")] = "500",
        [("Icon", "Weight")] = "regular",
        [("Content", "Name")] = "content",
    };
    private static readonly HashSet<string> KnownKinds = new(KindDefaults.Keys.Select(k => k.Kind), StringComparer.Ordinal);
    internal static readonly Dictionary<string, string> Global = new(StringComparer.Ordinal) {
        ["Visible"] = "True", ["Enabled"] = "True", ["Mandatory"] = "False", ["BuiltInValidations"] = "None", ["Transition"] = "Inherited",
        ["AlignItems"] = "Stretch", ["AlignSelf"] = "Auto", ["FlexDirection"] = "Row", ["FlexWrap"] = "NoWrap", ["Flexible"] = "Shrink",
        ["JustifyContent"] = "Start", ["WidgetGridType"] = "None",
    };
    internal static string DefaultOf(string kind, string property, char type) =>
        KindDefaults.TryGetValue((kind, property), out var value) ? value
        : !KnownKinds.Contains(kind) && Global.TryGetValue(property, out value) ? value
        : type == 'b' ? "False" : "";

    /// <summary>The default of a property where the element sits: the Transition of an event of a widget inside a Popup is the
    /// platform's own there (Fade: every widget event the Service Studio creates inside a Popup gets it; the corpus has no event
    /// inside a Popup without it); anywhere else, the table's (<see cref="DefaultOf(string, string, char)"/>).</summary>
    internal static string DefaultOf(string kind, string property, char type, bool inPopup) =>
        inPopup && property == "Transition" && IsEventKind(kind) ? PopupTransition : DefaultOf(kind, property, type);

    internal const string PopupTransition = "Fade";

    // The events that carry a Transition (a widget's native events and the lifecycle ones): every kind the table names with it.
    private static bool IsEventKind(string kind) => kind is "BuiltinEvent" or "UILifeCycleEvent" || kind.EndsWith("Event", StringComparison.Ordinal);

    // The machine-readable contract of the reading: tables, defaults and what is not a fact.
    public static JsonObject Contract()
    {
        var tags = new JsonObject();
        foreach (var (kind, tag) in WidgetTags.OrderBy(t => t.Key, StringComparer.Ordinal)) tags[kind] = tag;
        tags["List"] = "<Tag> list=\"Source\" (a void or odd Tag: <list tag>)"; tags["AdvancedHtml"] = "<Tag> (a reserved Tag: html marker; an odd one: <html-element tag>)";
        var named = new JsonObject();
        foreach (var (kind, map) in ScreenHtmlTables.Named.OrderBy(t => t.Key, StringComparer.Ordinal)) named[kind] = new JsonObject(map.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)));
        named["*widget"] = new JsonObject(ScreenHtmlTables.CommonNamed.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)));
        named["*data"] = new JsonObject(ScreenHtmlTables.DataNamed.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)));
        var defaults = new JsonObject();
        foreach (var group in KindDefaults.GroupBy(d => d.Key.Kind).OrderBy(g => g.Key, StringComparer.Ordinal))
            defaults[group.Key] = new JsonObject(group.OrderBy(d => d.Key.Property, StringComparer.Ordinal).Select(d => KeyValuePair.Create(d.Key.Property, (JsonNode?)d.Value)));
        defaults["*other kinds"] = new JsonObject(Global.OrderBy(d => d.Key, StringComparer.Ordinal).Select(d => KeyValuePair.Create(d.Key, (JsonNode?)d.Value)));
        return new JsonObject {
            ["schema"] = Schema, ["extractor"] = Extractor, ["elements"] = tags, ["named"] = named,
            ["opaque"] = new JsonArray(OpaqueKinds.Order(StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray()),
            ["defaults"] = defaults,
            ["notFacts"] = new JsonArray(NotFacts.Order(StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray()),
            ["syntax"] = new JsonObject {
                ["k"] = "k=\"w<n>\": the element's key in this reading (keys); never written on a new element",
                ["class"] = "Style/StyleClasses: a plain string literal is written bare (class=\"a b\"); any other expression is {{ expression }}",
                ["expressions"] = "every other expression attribute holds the OutSystems expression as text",
                ["os-<Property>"] = "any property outside the table, with the Model API name and the value as the model keeps it",
                ["on<event>"] = "a native event: Destination(Param = expression, ...); its other properties are os-on<event>.<Property>",
                ["@<Event>"] = "a block event handler: Handler(Param = expression, ...)",
                [":<Input>"] = "an argument of a block instance",
                ["<attribute>"] = "an extended property: a plain string literal bare, else {{ expression }}; ext:<name> when the name is taken; literal text with bindings (\"Total {{ N }}\") is their concatenation",
                ["runs"] = "one text or {{ expression }} per line; a line with text and bindings (\"Hoje · {{ X }}\", \"{{ N }} dias\") is one Expression, their concatenation (\"Hoje · \" + X), read back as {{ \"Hoje · \" + X }}; the whitespace beside an inline element on the same line is part of the run (\"por <b>menor</b> para\" keeps \"por \" and \" para\"); <text>exact</text> keeps spaces, line breaks and literal braces",
                ["popup"] = "an event of a widget inside a Popup is at the Popup's Transition (Fade, the platform's): written only when it is another",
                ["if"] = "<div if=\"Condition\" k> True branch </div><div else> False branch </div> (else only when not empty)",
                ["slot"] = "<slot name=\"Placeholder\"> the content of a placeholder of a block instance",
                ["names"] = "a reference is Name, Owner.Name, Kind:Name or @key: the first one that names only it from this screen",
            },
        };
    }

    // ---- text: attribute and run escaping, and the parser ----------------------------------------------------------------
    internal static string Attribute(string name, string value)
    {
        var quote = value.Contains('"') && !value.Contains('\'') ? '\'' : '"';
        var sb = new StringBuilder(name.Length + value.Length + 4).Append(name).Append('=').Append(quote);
        foreach (var c in value) {
            switch (c) {
                case '&': sb.Append("&amp;"); break;
                case '\n': sb.Append("&#10;"); break;
                case '\r': sb.Append("&#13;"); break;
                case '\t': sb.Append("&#9;"); break;
                case '"' when quote == '"': sb.Append("&quot;"); break;
                case '\'' when quote == '\'': sb.Append("&#39;"); break;
                default:
                    if (c < ' ') sb.Append("&#").Append((int)c).Append(';'); else sb.Append(c);
                    break;
            }
        }
        return sb.Append(quote).ToString();
    }

    internal static string Escape(string text, bool newlines)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var c in text) {
            switch (c) {
                case '&': sb.Append("&amp;"); break;
                case '<': sb.Append("&lt;"); break;
                case '>': sb.Append("&gt;"); break;
                case '\n' when newlines: sb.Append("&#10;"); break;
                case '\r' when newlines: sb.Append("&#13;"); break;
                case '\t' when newlines: sb.Append("&#9;"); break;
                default:
                    if (c < ' ' && newlines) sb.Append("&#").Append((int)c).Append(';'); else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    // A text run is written bare when one line holds it exactly and no brace pair of a binding is in it (a bare line with {{ or
    // }} is a binding: Run reads "Hoje · {{ X }}" as one expression).
    internal static bool PlainRun(string text) =>
        text.Length > 0 && !char.IsWhiteSpace(text[0]) && !char.IsWhiteSpace(text[^1]) && !text.Contains("{{", StringComparison.Ordinal)
        && !text.Contains("}}", StringComparison.Ordinal) && !text.Any(c => c < ' ');

    // A plain string literal: "abc" with no quote inside (OutSystems doubles a quote inside a string) and no brace pair of a
    // binding (Unsugar reads a bare value with {{ or }} as its bindings).
    internal static bool PlainLiteral(string expression, out string inner)
    {
        inner = "";
        if (expression.Length < 2 || expression[0] != '"' || expression[^1] != '"') return false;
        inner = expression[1..^1];
        return !inner.Contains('"') && !inner.Contains("{{", StringComparison.Ordinal) && !inner.Contains("}}", StringComparison.Ordinal);
    }
    internal static string Sugar(string expression) => PlainLiteral(expression, out var inner) ? inner : "{{ " + expression + " }}";

    /// <summary>The expression of an attribute value: one whole "{{ x }}" is x as written; literal text with bindings is their
    /// concatenation ("Total {{ N }}" is "Total " + N, as a run of text); anything else is the string literal of the value, a
    /// quote doubled. A malformed value (a {{ that never closes) stays the literal it was: the document form refuses it
    /// (BindingFault).</summary>
    internal static string Unsugar(string value) => Bound(value, out _) is { } expression ? expression : Literal(value);

    /// <summary>A run of text, one line of the document: the expression it stands for (expression true) or the text itself.
    /// The reading's "{{ x }}" is x exactly as written (spaces inside kept); a line with literal text and bindings ("Hoje · {{
    /// FormatDateTime(D, "dd/MM") }}", "{{ N }} dias") is one expression, their concatenation (BoundExpression), so the page
    /// shows what the line says and the reading writes it back as that expression. <paramref name="fault"/>: why a line with
    /// a brace pair is not a binding (unclosed, stray, empty); the line is then its text.</summary>
    internal static string Run(string line, out bool expression, out string? fault)
    {
        fault = null;
        if (Bound(line, out fault) is { } bound) { expression = true; return bound; }
        expression = false;
        return line;
    }

    /// <summary>One run of the text of an element: its text as it counts (indentation and line breaks out, the whitespace beside
    /// an inline element on the same line in), where it starts, and the text node it comes from.</summary>
    internal readonly record struct TextRun(string Text, int Line, int Column, Node Source);

    // The elements a line of text flows with (HTML phrasing content, and the language's own inline rows): the whitespace between
    // one of them and the text on the same line is part of the page ("por <b>menor</b> risco": the spaces stay). A data element
    // (<var>, <input name>) and every block element are not.
    private static readonly HashSet<string> InlineTags = new(StringComparer.Ordinal) {
        "a", "abbr", "b", "bdi", "bdo", "button", "cite", "code", "del", "dfn", "em", "expr", "i", "img", "input", "ins", "kbd", "label",
        "mark", "meter", "output", "progress", "q", "s", "samp", "select", "small", "span", "strong", "sub", "sup", "svg", "text", "textarea",
        "time", "u" };
    internal static bool Inline(Node node) =>
        !node.IsText && InlineTags.Contains(node.Tag) && !(node.Tag == "input" && node.Get("name") != null && node.Get("bind") == null);

    /// <summary>The runs of an element's text, one per line (the reading writes one per line, indented): a line is trimmed, but the
    /// whitespace that touches an inline element on the same line is kept ("Reordene por <b>menor</b> para" keeps "por " and " para"),
    /// and whitespace alone between two inline elements on one line is a run of its own ("<b>a</b> <i>b</i>"). The reading writes such
    /// a run in &lt;text&gt; (or as its expression), so it never puts text and elements on one line: its own text reads the same.</summary>
    internal static IEnumerable<TextRun> Runs(Node parent)
    {
        for (var c = 0; c < parent.Children.Count; c++) {
            var child = parent.Children[c];
            if (!child.IsText) continue;
            var before = c > 0 && Inline(parent.Children[c - 1]);
            var after = c + 1 < parent.Children.Count && Inline(parent.Children[c + 1]);
            var lines = child.Text!.Split('\n');
            for (var n = 0; n < lines.Length; n++) {
                var raw = lines[n].TrimEnd('\r');
                var lead = n == 0 && before; var trail = n == lines.Length - 1 && after;
                var start = 0; while (start < raw.Length && raw[start] is ' ' or '\t' or '\r') start++;
                var end = raw.Length; while (end > start && raw[end - 1] is ' ' or '\t' or '\r') end--;
                if (start == end) {
                    // Whitespace alone: a run only between two inline elements on one line.
                    if (lines.Length == 1 && lead && trail && raw.Length > 0) yield return new TextRun(raw, child.Line, child.Column, child);
                    continue;
                }
                var from = lead ? 0 : start; var to = trail ? raw.Length : end;
                yield return new TextRun(raw[from..to], child.Line + n, n == 0 ? child.Column + from : from + 1, child);
            }
        }
    }

    /// <summary>A run as the reading writes it on a line of its own (the edit's corrected text, a merge): 'p' the run itself when
    /// it has no whitespace at its ends; else 't' (&lt;text&gt; with it exactly) or 'x' (the expression of its bindings, in {{ }}).
    /// Read back on its own line, each form is the same run.</summary>
    internal static (char Form, string Value) RunForm(string run)
    {
        if (run.Length == 0 || !char.IsWhiteSpace(run[0]) && !char.IsWhiteSpace(run[^1])) return ('p', run);
        var value = Run(run, out var expression, out var fault);
        return expression && fault == null ? ('x', value) : ('t', run);
    }

    /// <summary>Whether a text can never be an expression of the language: outside its string literals, two operands side by side
    /// with no operator between them ("Buscar por nome"), or a character no expression has (…, ?, !, ;). Prose in an attribute that
    /// takes an expression; a single word may be a name, so it is never this.</summary>
    internal static bool NotAnExpression(string text)
    {
        var operand = false; var i = 0;
        while (i < text.Length) {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '"') { i++; while (i < text.Length && !(text[i] == '"' && (i + 1 >= text.Length || text[i + 1] != '"'))) i += text[i] == '"' ? 2 : 1; i++; if (operand) return true; operand = true; continue; }
            if (char.IsLetterOrDigit(c) || c == '_') {
                var start = i;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or '.')) i++;
                var word = text[start..i];
                if (word.ToLowerInvariant() is "and" or "or" or "not" or "like") { operand = false; continue; }
                if (operand) return true;
                operand = true; continue;
            }
            if (c == '#') {
                // A date or time literal (#2026-10-12#): one operand.
                var close = text.IndexOf('#', i + 1);
                i = close < 0 ? text.Length : close + 1;
                if (operand) return true;
                operand = true; continue;
            }
            if (c is '…' or '?' or '!' or ';' or '`' or '~' or '\\' or '$' or '@') return true;
            // An operator, a parenthesis, a comma, a bracket: the next word is no neighbour of the last one.
            operand = c is ')' or ']';
            i++;
        }
        return ProseSyntax(text);
    }

    // Integration 24-1 familias (review): of what the language's syntax refuses, only what no expression typed wrong can be is
    // prose: a ':' outside a text or date literal ("Ex: 123, s/n", "Nota: ver"), and a number mask, digits in groups with a group
    // that starts with 0 and nothing else ("07", "00000-000", "000.000.000-00"; a decimal 0.07 is a number). An unbalanced
    // parenthesis or quote, an operator at the end, a name and its '(' left open are an expression typed wrong: two readings,
    // never prose (the Verify's message, no literal patch).
    private static readonly System.Text.RegularExpressions.Regex NumberMask = new(@"^\s*\d+(?:[-./ ]\d+)*\s*$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex Decimal = new(@"^\s*\d+\.\d+\s*$", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool ProseSyntax(string text)
    {
        for (var i = 0; i < text.Length; i++) {
            var c = text[i];
            if (c == '"') { i++; while (i < text.Length && !(text[i] == '"' && (i + 1 >= text.Length || text[i + 1] != '"'))) i += text[i] == '"' ? 2 : 1; continue; }
            if (c == '#') { var close = text.IndexOf('#', i + 1); if (close < 0) return false; i = close; continue; }
            if (c == ':') return true;
        }
        if (!NumberMask.IsMatch(text) || Decimal.IsMatch(text)) return false;
        return System.Text.RegularExpressions.Regex.Matches(text, @"\d+").Any(m => m.Value.Length > 1 && m.Value[0] == '0');
    }

    /// <summary>Whether a text holds a brace pair of a binding ({{ or }}).</summary>
    internal static bool HoldsBraces(string text) => text.Contains("{{", StringComparison.Ordinal) || text.Contains("}}", StringComparison.Ordinal);

    /// <summary>Whether an attribute value holds a binding ({{ expression }} whole, or text with bindings), well formed.</summary>
    internal static bool HasBinding(string value) => value.Contains("{{", StringComparison.Ordinal) && Bound(value, out var fault) != null && fault == null;

    /// <summary>The literal a value with bindings stands for when every binding is a constant (a string, a number or a boolean
    /// literal): "{{ \"abc\" }}" is abc, "a {{ 1 }}" is "a 1"; null when a binding names anything.</summary>
    internal static string? ConstantText(string value)
    {
        if (Bindings(value, out _) is not { } parts) return null;
        var sb = new StringBuilder();
        foreach (var part in parts) {
            if (!part.Expression) { sb.Append(part.Text); continue; }
            var e = part.Text.Trim();
            if (e.Length >= 2 && e[0] == '"' && e[^1] == '"' && !e[1..^1].Replace("\"\"", "", StringComparison.Ordinal).Contains('"')) sb.Append(e[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal));
            else if (System.Text.RegularExpressions.Regex.IsMatch(e, @"^-?\d+(\.\d+)?$") || e is "True" or "False") sb.Append(e);
            else return null;
        }
        return sb.ToString();
    }

    // The expression of a text with bindings (the reading's whole "{{ x }}" first, exactly), null without one or when malformed.
    private static string? Bound(string text, out string? fault)
    {
        fault = null;
        var whole = text.Length >= 6 && text.StartsWith("{{ ", StringComparison.Ordinal) && text.EndsWith(" }}", StringComparison.Ordinal);
        if (!text.Contains("{{", StringComparison.Ordinal) && !text.Contains("}}", StringComparison.Ordinal)) return null;
        var parts = Bindings(text, out fault);
        // The reading writes an Expression as "{{ " + value + " }}" whatever its value holds: that form is always that value.
        if (whole && (parts == null || parts.Count == 1)) { fault = null; return text[3..^3]; }
        if (parts == null) return null;
        if (parts.Count == 1 && parts[0].Expression) return parts[0].Text.Trim();
        var joined = string.Join(" + ", parts.Select(p => p.Expression ? (Atom(p.Text.Trim()) ? p.Text.Trim() : "(" + p.Text.Trim() + ")") : Literal(p.Text)));
        // Two bindings first ("{{ 1 }}{{ 2 }} itens"): 1 + 2 would add two numbers ("3 itens"); the empty text first makes every
        // + a join, so the page shows what the line says ("12 itens"). The reading writes it back as that expression.
        return parts.Count > 1 && parts[0].Expression && parts[1].Expression ? "\"\" + " + joined : joined;
    }

    /// <summary>Why a value with a brace pair of a binding is not one ({{ that never closes, }} outside a binding, {{ }} with no
    /// expression), or null.</summary>
    internal static string? BindingFault(string text)
    {
        if (!text.Contains("{{", StringComparison.Ordinal) && !text.Contains("}}", StringComparison.Ordinal)) return null;
        if (text.Length >= 6 && text.StartsWith("{{ ", StringComparison.Ordinal) && text.EndsWith(" }}", StringComparison.Ordinal) && text[3..^3].Trim().Length > 0) return null;
        return Bindings(text, out var fault) == null ? fault : null;
    }

    /// <summary>One part of a text with bindings: literal text, or the expression of a {{ }} as written inside the braces.</summary>
    internal readonly record struct Binding(string Text, bool Expression);

    /// <summary>A text cut into its literal parts and its {{ expression }} bindings, in order. A binding closes at the first }}
    /// outside its strings ("" doubles a quote) and its own braces (an ODC record literal), so "{{ A }} e {{ B }}" is two.
    /// Null (with the fault) for a {{ that never closes, a }} outside a binding, or a binding with no expression.</summary>
    internal static List<Binding>? Bindings(string text, out string? fault)
    {
        fault = null;
        var parts = new List<Binding>();
        var literal = new StringBuilder();
        var i = 0;
        while (i < text.Length)
        {
            if (string.CompareOrdinal(text, i, "{{", 0, 2) == 0)
            {
                var end = -1; var depth = 0; var inString = false;
                for (var j = i + 2; j < text.Length; j++)
                {
                    var c = text[j];
                    if (inString) { if (c == '"') { if (j + 1 < text.Length && text[j + 1] == '"') j++; else inString = false; } continue; }
                    if (c == '"') inString = true;
                    else if (c == '{') depth++;
                    else if (c == '}') { if (depth == 0 && j + 1 < text.Length && text[j + 1] == '}') { end = j; break; } if (depth > 0) depth--; }
                }
                if (end < 0) { fault = "{{ at column " + (i + 1).ToString(CultureInfo.InvariantCulture) + " never closes with }}"; return null; }
                var inner = text[(i + 2)..end];
                if (inner.Trim().Length == 0) { fault = "{{ }} at column " + (i + 1).ToString(CultureInfo.InvariantCulture) + " has no expression"; return null; }
                if (literal.Length > 0) { parts.Add(new(literal.ToString(), false)); literal.Clear(); }
                parts.Add(new(inner, true));
                i = end + 2;
                continue;
            }
            if (string.CompareOrdinal(text, i, "}}", 0, 2) == 0) { fault = "}} at column " + (i + 1).ToString(CultureInfo.InvariantCulture) + " closes no {{"; return null; }
            literal.Append(text[i++]);
        }
        if (literal.Length > 0) parts.Add(new(literal.ToString(), false));
        return parts;
    }

    // A string literal of the expression language: the text in quotes, a quote doubled.
    internal static string Literal(string text) => "\"" + text.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";

    // An expression that needs no parentheses beside a +: a name, a member, a call, a literal (nothing at its top level but
    // name characters, dots and the groups of its calls).
    private static bool Atom(string expression)
    {
        if (expression.Length == 0) return false;
        var depth = 0; var inString = false;
        foreach (var c in expression)
        {
            if (inString) { if (c == '"') inString = false; continue; }
            if (c == '"') { inString = true; continue; }
            if (c is '(' or '[') { depth++; continue; }
            if (c is ')' or ']') { depth--; continue; }
            if (depth == 0 && !(char.IsLetterOrDigit(c) || c is '_' or '.')) return false;
        }
        return depth == 0;
    }

    internal static string Sha256(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    // The parsed document: elements with ordered attributes (names as written), children and text runs. Strict: every element
    // closes (or is self-closed, or is one of the void tags), entities are &amp; &lt; &gt; &quot; &apos; &#N; &#xN;.
    public sealed class Node
    {
        public string Tag = ""; public List<KeyValuePair<string, string>> Attributes = []; public List<Node> Children = [];
        public string? Text; public int Line, Column;
        public bool IsText => Text != null;
        public string? Get(string name) { foreach (var a in Attributes) if (a.Key == name) return a.Value; return null; }
    }

    public static Node Parse(string html) => new HtmlParser(html).Document();

    private sealed class HtmlParser(string text)
    {
        private int i, line = 1, col = 1;
        private char Peek(int ahead = 0) => i + ahead < text.Length ? text[i + ahead] : '\0';
        private bool End => i >= text.Length;
        private char Take() { var c = text[i++]; if (c == '\n') { line++; col = 1; } else col++; return c; }
        private bool At(string s) => string.CompareOrdinal(text, i, s, 0, s.Length) == 0;
        private FormatException Error(string message) => new($"ssam-html: line {line} col {col}: {message}");

        public Node Document()
        {
            var root = new Node { Tag = "#document" };
            var open = new List<Node> { root };
            while (!End) {
                if (Peek() == '<') {
                    if (At("<!--")) { var end = text.IndexOf("-->", i + 4, StringComparison.Ordinal); if (end < 0) throw Error("unterminated comment"); while (i < end + 3) Take(); continue; }
                    if (At("</")) {
                        Take(); Take(); var name = Name(); SkipSpaces();
                        if (Peek() != '>') throw Error("malformed </" + name + ">");
                        Take();
                        if (open.Count == 1 || open[^1].Tag != name) throw Error("unexpected </" + name + ">" + (open.Count > 1 ? "; open <" + open[^1].Tag + ">" : ""));
                        open.RemoveAt(open.Count - 1);
                        continue;
                    }
                    if (char.IsLetter(Peek(1))) { Open(open); continue; }
                    throw Error("stray '<'");
                }
                var (l, c) = (line, col);
                var sb = new StringBuilder();
                while (!End && Peek() != '<') sb.Append(Peek() == '&' ? Entity() : Take().ToString());
                open[^1].Children.Add(new Node { Text = sb.ToString(), Line = l, Column = c });
            }
            if (open.Count > 1) throw Error("unclosed <" + open[^1].Tag + "> from line " + open[^1].Line);
            return root;
        }

        private void Open(List<Node> open)
        {
            var node = new Node { Line = line, Column = col };
            Take(); node.Tag = Name();
            while (true) {
                SkipSpaces();
                if (End) throw Error("unterminated <" + node.Tag + ">");
                if (At("/>")) { Take(); Take(); open[^1].Children.Add(node); return; }
                if (Peek() == '>') { Take(); break; }
                var name = AttributeName();
                if (name.Length == 0) throw Error("invalid character '" + Peek() + "' in <" + node.Tag + ">");
                SkipSpaces(); var value = "";
                if (Peek() == '=') {
                    Take(); SkipSpaces();
                    if (Peek() is not ('"' or '\'')) throw Error("unquoted value of " + name + " in <" + node.Tag + ">");
                    var quote = Take(); var sb = new StringBuilder();
                    while (!End && Peek() != quote) sb.Append(Peek() == '&' ? Entity() : Take().ToString());
                    if (End) throw Error("unterminated value of " + name);
                    Take(); value = sb.ToString();
                }
                if (node.Attributes.Any(a => a.Key == name)) throw Error("duplicate attribute " + name + " in <" + node.Tag + ">");
                node.Attributes.Add(new(name, value));
            }
            open[^1].Children.Add(node);
            if (node.Tag == "style") {
                // Raw text: everything up to </style>, as it is.
                var end = text.IndexOf("</style>", i, StringComparison.Ordinal);
                if (end < 0) throw Error("unterminated <style>");
                var sb = new StringBuilder(); while (i < end) sb.Append(Take());
                node.Children.Add(new Node { Text = sb.ToString() });
                for (var n = 0; n < "</style>".Length; n++) Take();
                return;
            }
            if (VoidTags.Contains(node.Tag)) return;
            open.Add(node);
        }

        private string Name()
        {
            var sb = new StringBuilder();
            while (!End && (char.IsLetterOrDigit(Peek()) || Peek() is '-' or '_' or ':' or '.')) sb.Append(Take());
            return sb.ToString();
        }
        private string AttributeName()
        {
            var sb = new StringBuilder();
            while (!End && !char.IsWhiteSpace(Peek()) && Peek() is not ('=' or '>' or '"' or '\'' or '<') && !At("/>")) sb.Append(Take());
            return sb.ToString();
        }
        private void SkipSpaces() { while (!End && char.IsWhiteSpace(Peek())) Take(); }
        private string Entity()
        {
            var semicolon = text.IndexOf(';', i);
            if (semicolon < 0 || semicolon - i > 10) throw Error("bare '&': write &amp;");
            var name = text.Substring(i + 1, semicolon - i - 1);
            string value = name switch {
                "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'",
                _ when name.StartsWith("#x", StringComparison.OrdinalIgnoreCase) => char.ConvertFromUtf32(int.Parse(name[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture)),
                _ when name.StartsWith('#') => char.ConvertFromUtf32(int.Parse(name[1..], CultureInfo.InvariantCulture)),
                _ => throw Error("unknown entity &" + name + ";")
            };
            while (i <= semicolon) Take();
            return value;
        }
    }

    // The arguments of a call: Destination(Param = expression, ...). Split at the top level only (strings, parentheses,
    // brackets and braces nest); the expression after "Param = " is kept exactly.
    internal static string Call(string target, IReadOnlyList<(string Param, string Value)> arguments) =>
        arguments.Count == 0 ? target : target + "(" + string.Join(", ", arguments.Select(a => a.Param + " = " + a.Value)) + ")";

    internal static bool TryCall(string text, out string target, out List<(string Param, string Value)> arguments)
    {
        arguments = [];
        var open = text.IndexOf('(');
        if (open < 0) { target = text; return true; }
        target = text[..open];
        if (!text.EndsWith(')')) return false;
        var body = text[(open + 1)..^1];
        var parts = new List<string>(); var depth = 0; var inString = false; var start = 0;
        for (var at = 0; at < body.Length; at++) {
            var c = body[at];
            if (inString) { if (c == '"') { if (at + 1 < body.Length && body[at + 1] == '"') at++; else inString = false; } continue; }
            if (c == '"') inString = true;
            else if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') depth--;
            else if (c == ',' && depth == 0) { parts.Add(body[start..at]); start = at + 1; }
        }
        parts.Add(body[start..]);
        for (var p = 0; p < parts.Count; p++) {
            var part = p == 0 ? parts[p] : parts[p].StartsWith(' ') ? parts[p][1..] : null;
            if (part == null) return false;
            var eq = part.IndexOf(" = ", StringComparison.Ordinal);
            if (eq <= 0) return false;
            var name = part[..eq];
            if (!IsIdentifier(name)) return false;
            arguments.Add((name, part[(eq + 3)..]));
        }
        return true;
    }

    internal static bool IsIdentifier(string text) =>
        text.Length > 0 && (char.IsLetter(text[0]) || text[0] == '_') && text.All(c => char.IsLetterOrDigit(c) || c == '_');
}

// One screen or block read as ssam-html/1.
public sealed class ScreenHtmlDocument
{
    public string Schema => ScreenHtml.Schema;
    public string Root { get; init; } = "";
    public string RootKey { get; init; } = "";
    public string RootKind { get; init; } = "";
    public string Html { get; init; } = "";
    public string HtmlSha256 { get; init; } = "";
    // k -> ObjectKey of every element (and of the structural nodes: k/slot name, k.true, k.false, k.content, k~run).
    public IReadOnlyList<KeyValuePair<string, string>> Keys { get; init; } = [];
    public int Widgets { get; init; }
    public int OpaqueWidgets { get; init; }
    public int Elements { get; init; }
    public int Bytes => Encoding.UTF8.GetByteCount(Html);
    public double ReadMs { get; init; }
    // Read errors and nodes the reading could not place (each one also counts against the fixed point).
    public IReadOnlyList<string> Problems { get; init; } = [];
    internal ScreenHtmlCanon Canon { get; init; } = new();
    internal Func<ScreenHtml.Node, ScreenHtmlCanon>? Decoder { get; init; }
    // The module, root, names and shapes of the reading (ScreenHtmlModule<T>.ReadingState): what an edit of this text (C2,
    // ScreenHtmlEdit) decodes and plans with.
    internal object? State { get; init; }

    public JsonObject Json(bool withKeys = true)
    {
        var json = new JsonObject { ["schema"] = Schema, ["root"] = Root, ["rootKey"] = RootKey, ["rootKind"] = RootKind,
            ["htmlSha256"] = HtmlSha256, ["bytes"] = Bytes, ["widgets"] = Widgets, ["opaqueWidgets"] = OpaqueWidgets, ["elements"] = Elements,
            ["html"] = Html };
        if (withKeys) json["keys"] = new JsonObject(Keys.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)k.Value)));
        if (Problems.Count > 0) json["problems"] = new JsonArray(Problems.Select(p => (JsonNode)p).ToArray());
        return json;
    }

    // The differences between this reading and an edited text of it, as the native ops a delivery would apply: set, create,
    // delete, move, foreign and opaque. Reapplying the text read unchanged gives none (the fixed point).
    public IReadOnlyList<JsonObject> Compare(string html)
    {
        var parsed = ScreenHtml.Parse(html);
        var other = Decoder!(parsed);
        return ScreenHtmlCanon.Diff(Canon, other);
    }
}

// The canonical form of a page: per element (k, or a structural id), its kind, its facts and its children in order. The
// reading builds it from the model; the decoder builds it from the text. Equal forms = the text loses nothing.
internal sealed class ScreenHtmlCanon
{
    internal sealed class Element
    {
        public string Kind = "";
        public SortedDictionary<string, string> Facts = new(StringComparer.Ordinal);
        public List<string> Children = [];
        // The decoder only: the attribute as written for a reference fact (p:SourceBlock, p:DataType...), which a writer may
        // need by name (a type), never compared.
        public Dictionary<string, string> Raw = new(StringComparer.Ordinal);
    }
    public readonly Dictionary<string, Element> Elements = new(StringComparer.Ordinal);
    public readonly List<string> Problems = [];

    public static List<JsonObject> Diff(ScreenHtmlCanon model, ScreenHtmlCanon text)
    {
        var ops = new List<JsonObject>();
        foreach (var problem in text.Problems) ops.Add(new JsonObject { ["op"] = "invalid", ["problem"] = problem });
        foreach (var (id, element) in model.Elements.OrderBy(e => e.Key, StringComparer.Ordinal)) {
            if (!text.Elements.TryGetValue(id, out var edited)) { ops.Add(new JsonObject { ["op"] = "delete", ["k"] = id, ["kind"] = element.Kind }); continue; }
            if (edited.Kind != element.Kind) { ops.Add(new JsonObject { ["op"] = "replace", ["k"] = id, ["from"] = element.Kind, ["to"] = edited.Kind }); continue; }
            foreach (var (fact, value) in element.Facts)
                if (!edited.Facts.TryGetValue(fact, out var now)) ops.Add(new JsonObject { ["op"] = "set", ["k"] = id, ["fact"] = fact, ["from"] = value, ["to"] = null });
                else if (now != value) ops.Add(new JsonObject { ["op"] = "set", ["k"] = id, ["fact"] = fact, ["from"] = value, ["to"] = now });
            foreach (var (fact, now) in edited.Facts)
                if (!element.Facts.ContainsKey(fact)) ops.Add(new JsonObject { ["op"] = "set", ["k"] = id, ["fact"] = fact, ["from"] = null, ["to"] = now });
            if (!element.Children.SequenceEqual(edited.Children, StringComparer.Ordinal))
                ops.Add(new JsonObject { ["op"] = "children", ["k"] = id, ["from"] = string.Join(" ", element.Children.Select(Clip)), ["to"] = string.Join(" ", edited.Children.Select(Clip)) });
        }
        foreach (var (id, element) in text.Elements.OrderBy(e => e.Key, StringComparer.Ordinal))
            if (!model.Elements.ContainsKey(id)) ops.Add(new JsonObject { ["op"] = id.StartsWith('+') ? "create" : "foreign", ["k"] = id, ["kind"] = element.Kind });
        return ops;
    }
    private static string Clip(string token) => token.Length > 60 ? token[..60] + "…" : token;
}
