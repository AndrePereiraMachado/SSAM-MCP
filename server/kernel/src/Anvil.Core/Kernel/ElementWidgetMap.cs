using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
namespace Anvil.Core;

/// <summary>
/// The one element-to-widget table (docs/PROTOTIPO-NATIVO.md, section 3.2): the html op in its page form (HtmlExpander) and
/// in its fragment form (HtmlVisual) and the prototype importer (through <see cref="PrototypeSeams.Element"/>) ask it which
/// native widget an element becomes, with which tag, name, properties, extended properties and classes. The manual path and
/// the importer never diverge.
/// <list type="bullet">
/// <item>The tags an HTML Element (IAdvancedHtml) accepts are frozen per platform from the installed validators
/// (<c>HtmlValidator..cctor</c> of <c>ServiceStudio.Plugin.NRWidgets.dll</c> 11.55.91 and <c>OutSystems.Model.Plugin.NRWidgets.dll</c>
/// 13.1431.3): 103 in O11, the same 100 in ODC without <c>data</c>, <c>main</c>, <c>picture</c>. A test re-extracts them from
/// the installed DLLs and fails on any difference.</item>
/// <item>A tag outside the list of the platform is replaced by the fixed substitute of <see cref="Substitute"/>, the widget
/// carrying the class <c>ssam-tag-&lt;tag&gt;</c> (the CSS of the importer rewrites <c>T</c> to <c>:is(T, :where(.ssam-tag-T))</c>).</item>
/// <item>Every attribute is preserved: the ones a native property consumes go to it (class, style, value/checked/selected,
/// disabled, placeholder, maxlength, required, type, a route href, for, src), the id names the widget, inline JavaScript
/// (<c>on*</c>) never becomes an attribute, and everything else is an extended property with its literal value.</item>
/// <item>A submit button is never <c>type=submit</c>: <c>IsDefault = True</c> inside a form (Verify requires the Form) and the
/// class <c>ssam-submit</c>.</item>
/// </list>
/// Values in <see cref="ElementMapping.Properties"/> and <see cref="ElementMapping.ExtendedProperties"/> are what a <c>set</c>
/// op writes: an OutSystems expression for expression properties (a quoted literal), the raw text for text properties (Tag,
/// CustomStyle) and True/False for booleans. Pseudo-properties a builder turns into more than one property:
/// <c>DefaultValue</c> (the default of the variable the control binds), <c>Event</c> (an IEvent of the HTML Element with that
/// event name; the handler is the builder's), <c>TargetWidget</c> (the id a label targets), <c>RadioGroup</c> (the name that
/// groups radio buttons) and <c>ImageMarkup</c> (an SVG that becomes a module image).
/// </summary>
public static class ElementWidgetMap
{
    public const string O11 = "o11";
    public const string Odc = "odc";

    /// <summary>The O11 list in the order of the validator (103).</summary>
    public static readonly IReadOnlyList<string> O11Tags =
    [
        "a", "abbr", "address", "area", "article", "aside", "audio", "b", "bdi", "bdo", "blockquote", "button", "canvas", "caption",
        "cite", "code", "col", "colgroup", "command", "data", "datalist", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
        "embed", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
        "hr", "i", "iframe", "img", "input", "ins", "kbd", "keygen", "label", "legend", "li", "link", "main", "map", "mark", "menu",
        "meter", "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p", "param", "picture", "pre", "progress",
        "q", "rp", "rt", "ruby", "s", "samp", "section", "select", "small", "source", "span", "strong", "style", "sub", "summary",
        "sup", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "time", "tr", "track", "u", "ul", "var", "video", "wbr",
    ];

    /// <summary>The tags the ODC validator does not have.</summary>
    public static readonly IReadOnlyList<string> OdcMissing = ["data", "main", "picture"];

    /// <summary>The ODC list in the order of the validator (100).</summary>
    public static readonly IReadOnlyList<string> OdcTags = O11Tags.Where(t => !OdcMissing.Contains(t)).ToArray();

    private static readonly HashSet<string> O11Set = new(O11Tags, StringComparer.Ordinal);
    private static readonly HashSet<string> OdcSet = new(OdcTags, StringComparer.Ordinal);

    /// <summary>Elements that never become a widget: the CSS, the behavior and what the browser does not render.</summary>
    public static readonly IReadOnlySet<string> NoWidget = new HashSet<string>(StringComparer.Ordinal) { "template", "slot", "script", "style" };

    /// <summary>The attributes the closed list of the page form carried before this table (H4 counts what it adds).</summary>
    public static readonly IReadOnlySet<string> LegacyAttributes = new HashSet<string>(StringComparer.Ordinal)
    { "class", "id", "style", "title", "role", "hidden", "placeholder", "for", "type", "href", "required", "maxlength", "autocomplete", "lang", "dir", "value" };

    /// <summary>The InputType of an input by its type attribute (the NRWidgets enum).</summary>
    public static readonly IReadOnlyDictionary<string, string> InputTypes = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["text"] = "Text", ["search"] = "Search", ["email"] = "Email", ["number"] = "Number", ["tel"] = "Phone", ["password"] = "Password",
        ["date"] = "Date", ["time"] = "Time", ["datetime-local"] = "Datetime",
    };

    /// <summary>The widgets whose class goes to the native Style (the others carry it as the extended property class).</summary>
    private static readonly HashSet<string> StyleWidgets = new(StringComparer.Ordinal)
    { "IContainer", "IButton", "ILink", "IForm", "IInput", "ITextArea", "ICheckbox", "IRadioButton", "IDropdown", "ILabel", "IImage", "IList" };

    private static readonly HashSet<string> EnabledWidgets = new(StringComparer.Ordinal) { "IButton", "ILink", "IInput", "ITextArea", "ICheckbox", "IRadioButton", "IDropdown" };
    private static readonly HashSet<string> ControlWidgets = new(StringComparer.Ordinal) { "IInput", "ITextArea", "ICheckbox", "IRadioButton", "IDropdown" };
    private static readonly Regex NameShape = new("^[A-Za-z][A-Za-z0-9_]*$", RegexOptions.Compiled);

    /// <summary>The H8 decision for an element with a click event that is not an a or a button: an HTML Element keeping its tag
    /// with an onclick IEvent (true), or the fallback of section 3.2, a Link with <c>ssam-tag-&lt;tag&gt;</c> (false). The
    /// compile lane proves the event in the Verify (7.2 test 10); the integrator flips this only if that proof fails.</summary>
    public static bool ElementEvents { get; set; } = true;

    // The seam of section 7.3: the importer of the compile lane asks this table through PrototypeSeams.Element.
    [ModuleInitializer]
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "CA2255", Justification = "the seams of the prototype lanes register at load (docs/PROTOTIPO-NATIVO.md 7.3)")]
    internal static void Register() => PrototypeSeams.Element ??= Map;

    /// <summary>"o11" or "odc" for the assembly that runs (Anvil.Core.Odc is the ODC kernel).</summary>
    public static string CurrentPlatform => typeof(ElementWidgetMap).Assembly.GetName().Name == "Anvil.Core.Odc" ? Odc : O11;

    public static IReadOnlyList<string> Tags(string platform) => platform == Odc ? OdcTags : O11Tags;

    /// <summary>True when the HTML Element of the platform accepts the tag as written.</summary>
    public static bool Accepts(string platform, string tag) => (platform == Odc ? OdcSet : O11Set).Contains(tag);

    /// <summary>A custom element: a lowercase name with a hyphen (my-card), which no validator accepts.</summary>
    public static bool IsCustomElement(string tag) => tag.Contains('-') && Regex.IsMatch(tag, "^[a-z][a-z0-9]*-[a-z0-9-]*$");

    /// <summary>The fixed substitute of a tag outside the list of the platform, or null when the tag is accepted as written or
    /// has no substitute (a problem). <c>(Widget, Tag)</c>: the widget and, for an HTML Element, the tag it carries.</summary>
    public static (string Widget, string? Tag)? Substitute(string platform, string tag)
    {
        if (Accepts(platform, tag)) return null;
        return tag switch
        {
            "dialog" => ("IContainer", null),
            "br" => ("IContainer", null),
            "main" or "search" or "menuitem" => ("IContainer", null),
            // the body of a prototype whose shell is the page itself (header, side menu and main#app as its children)
            "body" => ("IContainer", null),
            "data" or "picture" => ("IAdvancedHtml", "span"),
            "svg" => ("IImage", null),
            _ when IsCustomElement(tag) => ("IContainer", null),
            _ => null,
        };
    }

    /// <summary>The class an element whose tag was replaced carries, so the author's selectors on the tag still reach it.</summary>
    public static string TagClass(string tag) => "ssam-tag-" + tag;

    /// <summary>The class the importer gives the widget of an authored id, for the rewrite #id -> :is(#id, .ssam-id-&lt;id&gt;).</summary>
    public static string IdClass(string id) => "ssam-id-" + id;

    /// <summary>The widget name an authored id gives: the id itself when it is a valid name; otherwise its letters, digits and
    /// underscores, every other character an underscore, and Id_ in front when it does not start with a letter
    /// (header-search -> header_search). Null for an empty id. Uniqueness in the screen is the caller's.</summary>
    public static string? NameFromId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        var trimmed = id.Trim();
        if (NameShape.IsMatch(trimmed)) return trimmed;
        var sb = new StringBuilder(trimmed.Length);
        foreach (var ch in trimmed) sb.Append(ch < 128 && (char.IsLetterOrDigit(ch) || ch == '_') ? ch : '_');
        var name = sb.ToString();
        return char.IsLetter(name[0]) ? name : "Id_" + name;
    }

    /// <summary>A control with no visible text still says what it does: aria-label, aria-labelledby or title (H5).</summary>
    public static bool Labelled(IEnumerable<(string Name, string Value)> attributes)
        => attributes.Any(a => a.Name is "aria-label" or "aria-labelledby" or "title" && a.Value.Trim().Length > 0);

    /// <summary>Inline JavaScript: never an attribute (the behavior is the binding, or the effect the importer observes).</summary>
    public static bool IsInlineScript(string attribute) => attribute.Length > 2 && attribute.StartsWith("on", StringComparison.Ordinal) && attribute.All(c => char.IsLetter(c));

    /// <summary>True when the widget carries the class on its native Style.</summary>
    public static bool HasStyle(string widget) => StyleWidgets.Contains(widget);

    /// <summary>True when the widget has the native Enabled the disabled attribute writes.</summary>
    public static bool HasEnabled(string widget) => EnabledWidgets.Contains(widget);

    /// <summary>What a native property of the widget consumes, by attribute; null when the attribute is an extended property.
    /// The id (the name) and inline script are decided before (they never reach an extended property).</summary>
    public static string? Consumer(string widget, string tag, string attribute, string value) => attribute switch
    {
        "class" => HasStyle(widget) ? "Style" : null,
        "style" => "CustomStyle",
        "disabled" => HasEnabled(widget) ? "Enabled" : null,
        "placeholder" => widget is "IInput" or "ITextArea" ? "Prompt" : null,
        "maxlength" => widget is "IInput" or "ITextArea" ? "MaxLength" : null,
        "required" => widget is "IInput" or "ITextArea" or "IDropdown" ? "Mandatory" : null,
        "value" or "checked" => ControlWidgets.Contains(widget) ? "DefaultValue" : null,
        "selected" => tag == "option" ? "DefaultValue" : null,
        "type" => widget is "IInput" or "ICheckbox" or "IRadioButton" or "IButton" ? "InputType" : null,
        "href" => widget == "ILink" && value.StartsWith('#') ? "OnClick" : null,
        "for" => widget == "ILabel" ? "TargetWidget" : null,
        "src" => widget == "IImage" ? "Image" : null,
        "name" => widget == "IRadioButton" ? "RadioGroup" : null,
        _ => null,
    };

    /// <summary>The single element-to-widget decision (section 3.2), for both platforms.</summary>
    public static ElementMapping Map(ElementRequest request) => Map(request, ElementEvents);

    /// <summary>The decision with the H8 choice given (<see cref="ElementEvents"/> is the one in force).</summary>
    public static ElementMapping Map(ElementRequest request, bool elementEvents)
    {
        var platform = request.Platform == Odc ? Odc : O11;
        var tag = request.Tag.ToLowerInvariant();
        var attributes = request.Attributes;
        string Attr(string name) => attributes.FirstOrDefault(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Value ?? "";
        bool Has(string name) => attributes.Any(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        var classes = Regex.Split(Attr("class").Trim(), @"\s+").Where(c => c.Length > 0).ToList();
        var properties = new List<(string, string)>();
        var extended = new List<(string, string)>();
        string? substituted = null, problem = null;
        string widget;
        string? widgetTag = null;

        if (NoWidget.Contains(tag)) return new ElementMapping("", null, null, [], [], [], null, null);
        if (request.Icon)
        {
            // An icon of a library (an svg drawn by a script): an inline span with the original classes and ssam-icon; the mask
            // class of the icon (3.5) is the builder's.
            widget = "IAdvancedHtml"; widgetTag = "span";
            if (!classes.Contains("ssam-icon")) classes.Add("ssam-icon");
        }
        else if (Substitute(platform, tag) is { } replacement)
        {
            substituted = tag;
            (widget, widgetTag) = replacement;
            if (tag != "br") classes.Add(TagClass(tag));
            if (tag == "main" && !Has("role")) extended.Add(("role", Quote("main")));
            if (widget == "IImage") properties.Add(("ImageMarkup", "svg"));
        }
        else if (!Accepts(platform, tag))
        {
            widget = "IAdvancedHtml"; widgetTag = tag;
            problem = $"<{tag}> is not a tag the {(platform == Odc ? "ODC" : "O11")} HTML Element accepts and has no substitute; use one of: {string.Join(", ", Tags(platform))}";
        }
        else
        {
            var inputType = Attr("type").ToLowerInvariant();
            (string Widget, string? Tag) pick = tag switch
            {
                "a" => ("ILink", null),
                "button" => ("IButton", null),
                "div" when request.Clickable && !elementEvents => ("ILink", null),
                "div" when request.Clickable => ("IAdvancedHtml", "div"),
                "div" => ("IContainer", null),
                "form" => ("IForm", null),
                "input" when inputType == "checkbox" => ("ICheckbox", null),
                "input" when inputType == "radio" => ("IRadioButton", null),
                "input" when inputType.Length == 0 || InputTypes.ContainsKey(inputType) => ("IInput", null),
                "input" => ("IAdvancedHtml", "input"),
                "select" => ("IDropdown", null),
                "textarea" => ("ITextArea", null),
                "label" when request.HasElementChildren => ("IAdvancedHtml", "label"),
                "label" => ("ILabel", null),
                "img" => ("IImage", null),
                _ when request.Clickable && !elementEvents => ("ILink", null),
                _ => ("IAdvancedHtml", tag),
            };
            (widget, widgetTag) = pick;
            // The fallback of H8 (a Link for a clickable element that is not an a): the class of the original tag goes with it.
            if (widget == "ILink" && tag != "a") classes.Add(TagClass(tag));
        }

        // The event of a clickable element that is not a link or a button: the HTML Element's onclick (H8).
        if (request.Clickable && widget == "IAdvancedHtml") properties.Add(("Event", "onclick"));
        if (widget == "IInput") properties.Add(("InputType", InputTypes.GetValueOrDefault(Attr("type").ToLowerInvariant(), "Text")));
        if (widget == "IButton")
        {
            // A submit button is never type=submit (the native submit of the form is not what the prototype does): the button
            // that sends its form is the default one and carries ssam-submit (the CSS of [type=submit] reaches it).
            // A submit button outside its form (form="id") is no default button of a form: the Verify expects the default
            // button inside one; it keeps ssam-submit and its event submits the form it names.
            var type = Attr("type").ToLowerInvariant();
            if (type == "submit" || (type.Length == 0 && request.InsideForm))
            {
                if (request.InsideForm) properties.Add(("IsDefault", "True"));
                classes.Add("ssam-submit");
            }
        }
        if (widget == "IImage" && substituted == null)
        {
            var src = Attr("src").Trim();
            if (Regex.IsMatch(src, @"^(?:https?:)?//|^data:", RegexOptions.IgnoreCase)) { properties.Add(("Type", "External")); properties.Add(("Url", Quote(src))); }
            else properties.Add(("Type", "Static"));
        }

        var name = NameFromId(Attr("id"));
        foreach (var (attribute, value) in attributes)
        {
            var key = attribute.ToLowerInvariant();
            if (key is "id" or "class" || IsInlineScript(key)) continue;
            if (key == "style") { if (value.Trim().Length > 0) properties.Add(("CustomStyle", value.Trim())); continue; }
            switch (Consumer(widget, widgetTag ?? tag, key, value))
            {
                case "Enabled": properties.Add(("Enabled", "False")); continue;
                case "Prompt": properties.Add(("Prompt", Quote(value))); continue;
                case "MaxLength": if (int.TryParse(value, out _)) { properties.Add(("MaxLength", value)); continue; } break;
                case "Mandatory": properties.Add(("Mandatory", "True")); continue;
                case "DefaultValue": properties.Add(("DefaultValue", key is "checked" or "selected" ? "True" : Quote(value))); continue;
                case "InputType": continue; // the widget itself (IInput type, IsDefault of a submit button)
                case "OnClick": continue;   // a route: the builder writes the destination
                case "TargetWidget": properties.Add(("TargetWidget", value)); continue;
                case "Image": continue;      // the module image or the External URL above
                case "RadioGroup": properties.Add(("RadioGroup", value)); continue;
                case "Style": continue;
            }
            // The extended property keeps the literal value; a value attribute of a substituted data keeps it too.
            extended.Add((key, Quote(value)));
        }
        if (classes.Count > 0)
        {
            var css = string.Join(" ", classes);
            if (HasStyle(widget)) properties.Insert(0, ("Style", Quote(css)));
            else extended.Insert(0, ("class", Quote(css)));
        }
        if (widgetTag != null) properties.Insert(0, ("Tag", widgetTag));
        return new ElementMapping(widget, widgetTag, name, properties, extended, classes, substituted, problem);
    }

    /// <summary>The same decision from a parsed element of the html op.</summary>
    public static ElementMapping Map(string platform, HtmlNode node, bool clickable, bool insideForm = false)
        => Map(new ElementRequest(platform, node.Tag, node.Attributes.Select(a => (a.Key, a.Value)).ToArray(), clickable, false, insideForm, node.Elements.Any()));

    private static string Quote(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
}
