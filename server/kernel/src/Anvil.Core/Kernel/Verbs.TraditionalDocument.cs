using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
using OutSystems.Model.UI;

namespace Anvil.Core;

/// <summary>
/// F5 (2026-10-25, the NWLoanPortal_TW chain: 10 rounds, 125 HTML_TRADITIONAL problems in 10 receipts): what a Traditional
/// document may write, shared by the compiler (the apply) and the preflight (HtmlDocumentRules.CheckTraditional, before the
/// build, with the module type). <see cref="Adapt"/> writes what HTML has under another name as the Traditional widget that
/// renders it and lists it (migration.adapted), with what that widget cannot keep (migration.dropped, with the reason): th is a
/// cell, thead/tbody/tfoot are the rows of their table, a table with list is the table-records of that source, p/h1-h6/section...
/// are containers, strong/em... inline containers, i icon the Font Awesome class of OutSystemsUIWeb, radio the radio-input, a
/// button with elements the link with class Button, os-Editable of a form its editable, the os-Source* names of a select its
/// label/value, os-onchange.Method="Ajax" nothing (the only method of a Traditional OnChange). <see cref="Check"/> refuses the
/// rest, each problem with the tag or attribute to write instead.
/// </summary>
internal static class TraditionalDocumentRules
{
    internal const string WebText = "OutSystems.Model.UI.Web.Widgets.ITextWidget";
    internal static readonly Dictionary<string, string> Types = new(StringComparer.Ordinal) {
        ["div"] = "IContainerWidget", ["span"] = "IContainerWidget", ["a"] = "ILinkWidget",
        ["button"] = "IButtonWidget", ["input"] = "IInputWidget", ["textarea"] = "IInputWidget",
        ["table"] = "ITableWidget", ["tr"] = "IRowWidget", ["td"] = "ICellWidget",
        ["table-records"] = "ITableRecordsWidget", ["list-records"] = "IListRecordsWidget",
        ["Block"] = "IWebBlockInstanceWidget", ["form"] = "ServiceStudio.Plugin.Widgets.IForm",
        ["checkbox-input"] = "ICheckBoxWidget", ["password-input"] = "IInputPasswordWidget",
        ["radio-input"] = "IRadioButtonWidget", ["select"] = "IComboBoxWidget",
        // No img: the installed Model API creates no image widget in a Web container (C-30, Check).
        ["upload"] = "IInputFilenameWidget", ["label"] = "ServiceStudio.Plugin.Widgets.ILabel",
        ["text"] = WebText, ["expr"] = "IExpressionWidget", ["placeholder"] = "OutSystems.Model.UI.Web.Widgets.IPlaceholderWidget"
    };
    internal const string Supported = "Traditional supports div/span, text and {{ expressions }} (expr value/example), input/textarea/checkbox/password/radio with bind and onchange, form record, select bind/options/source-entity/source-attribute, button/a with onclick, a href (a URL, or the #id of an element of the document: its onclick ExternalURL(URL = ...)), upload, table/tr/td, table-records/list-records with source/line-count/start-index (table slots HeaderRow/DataRow; list-records and div list also line-separator NewLine|None|Bullets), Block/slot, placeholder (in a block), if/else on any widget and div list; th, thead/tbody/tfoot, p/h1-h6/section/header/footer/nav/article/aside/main/ul/ol/li, strong/em/b/small, i icon and radio are written as those widgets (migration.adapted); use the installed component contract for other widgets.";
    internal static bool Data(ScreenHtml.Node n) => n.Tag == "var" || n.Tag == "input" && n.Get("bind") == null;
    // The attributes the language spends on its own rows: misplaced, they are refused; any other plain name on a
    // widget is an extended property of that widget, as the reader prints them (OSTagName="h1" on an expression).
    private static readonly HashSet<string> Language = new(StringComparer.Ordinal) { "k", "id", "name", "class", "style", "if", "else", "list",
        "onclick", "method", "validation", "type", "bind", "placeholder", "mandatory", "required", "maxlength", "rows", "onchange", "enabled", "value",
        "record", "editable", "source-entity", "source-attribute", "options", "label", "empty", "empty-value", "source", "line-count", "start-index", "line-separator", "example", "for", "onnotify",
        "flow", "title", "description", "roles", "actions", "default", "kind", "html", "tag" };
    private static readonly Regex PlainName = new(@"^[A-Za-z_][A-Za-z0-9_\-]*$", RegexOptions.CultureInvariant);
    // C-07 (F-FT-06, 27/10): the Line Separator of a List Records (ListRecordsLineSeparator), on list-records and div list.
    // Before, line-separator was an extended property of the widget: the runtime kept a <br> between the rows while the reading
    // printed line-separator="None".
    internal static readonly string[] LineSeparators = ["NewLine", "None", "Bullets"];

    // ---- C-13: the dialect, one table (Check reads it; the grammar card is generated from it, Dialect) ---------------------
    // Port of the dialect half of proto e699810c (its href half, C-23, is the screen-writing port's): the allowlist the Check
    // reads and the card the facade serves are the same table.
    internal static readonly string[] TopAttributes = ["name", "flow", "title", "description", "roles", "actions", "layout"];
    internal static readonly string[] DataAttributes = ["name", "type", "default", "mandatory", "description"];
    /// <summary>C-28: the layouts of a Traditional screen: blank (no layout block, the content at the root) and theme (the
    /// template's layout block, the content in its MainContent; the default).</summary>
    internal static readonly string[] Layouts = ["blank", "theme"];
    internal static readonly string[] Methods = ["Ajax", "Submit", "Navigate"];
    internal static readonly string[] Validations = ["None", "Server", "ClientAndServer"];

    /// <summary>The attributes a widget tag of the document takes (besides k, os-&lt;Property&gt;, ext:&lt;name&gt; and plain
    /// names, its extended properties): the allowlist of <see cref="Check"/>. line-separator on a div only with list.</summary>
    internal static IReadOnlyList<string> AttributesOf(string tag)
    {
        if (!Types.ContainsKey(tag)) return [];
        var a = new List<string> { "id", "name", "class", "style" };
        // A condition on any widget is the If around it (div if is the If itself, as the reader prints it).
        if (tag != "Block") a.AddRange(["if", "else", "title"]);
        if (tag == "div") a.AddRange(["list", "line-separator"]);
        if (tag == "list-records") a.Add("line-separator");
        if (tag is "button" or "a") a.AddRange(["onclick", "method", "validation", "enabled"]);
        if (tag == "a") a.Add("href");   // C-23: written as its onclick (ExternalLinks); what cannot be is HTML_HREF_UNSUPPORTED
        if (tag is "input" or "textarea" or "checkbox-input" or "password-input" or "radio-input")
            a.AddRange(["type", "bind", "placeholder", "mandatory", "required", "maxlength", "rows", "onchange", "enabled", "value"]);
        if (tag == "form") a.AddRange(["record", "editable"]);
        if (tag == "select") a.AddRange(["bind", "source-entity", "source-attribute", "required", "options", "label", "value", "empty", "empty-value", "enabled", "onchange"]);
        if (tag is "table-records" or "list-records") a.AddRange(["source", "line-count", "start-index"]);
        if (tag == "expr") a.AddRange(["value", "example"]);
        if (tag == "upload") a.AddRange(["required", "enabled"]);
        if (tag == "label") a.Add("for");
        if (tag == "Block") a.AddRange([":<Input>", "@<Event>", "onnotify"]);
        return a;
    }

    private const string GrammarHint = "the dialect: ssam_code {action:\"grammar\", part:\"html\", lane:\"o11\"} (traditional)";

    /// <summary>C-13: the fix of a problem of one element, short and its own: what this tag takes, or the tags there are.</summary>
    internal static string TagFix(ScreenHtml.Node node, bool top)
    {
        if (top) return "<" + node.Tag + "> takes " + string.Join(", ", TopAttributes) + " (layout blank|theme) and os-<Property>; its children: var, input name (parameters), style and the widgets; " + GrammarHint;
        if (Types.ContainsKey(node.Tag))
            return "<" + node.Tag + "> takes " + string.Join(", ", AttributesOf(node.Tag)) + ", os-<Property>, ext:<name> and plain names (extended properties)"
                + (node.Tag is "a" or "button" ? "; method " + string.Join("|", Methods) + ", validation " + string.Join("|", Validations) : "") + "; " + GrammarHint;
        return "the Traditional tags: " + string.Join(", ", Types.Keys.Order(StringComparer.Ordinal)) + "; p/h1-h6/section/ul/li... are written as div, strong/em/b... as span, th as td (migration.adapted); " + GrammarHint;
    }

    /// <summary>C-13: the dialect as data (the source of the Traditional grammar card, platforms/odc/facade/catalog/
    /// traditional-dialect.json; TraditionalDialectTests holds the file equal to this).</summary>
    internal static JsonObject Dialect()
    {
        JsonArray A(IEnumerable<string> items) => new(items.Select(i => (JsonNode)i).ToArray());
        var tags = new JsonObject();
        foreach (var tag in Types.Keys.Order(StringComparer.Ordinal)) tags[tag] = new JsonObject { ["widget"] = Types[tag][(Types[tag].LastIndexOf('.') + 1)..], ["attributes"] = A(AttributesOf(tag)) };
        var adapted = new JsonObject();
        foreach (var tag in BlockTags.Order(StringComparer.Ordinal)) adapted[tag] = "div";
        foreach (var tag in InlineTags.Order(StringComparer.Ordinal)) adapted[tag] = "span";
        adapted["th"] = "td"; adapted["thead/tbody/tfoot"] = "the rows of their table"; adapted["table list"] = "table-records";
        adapted["i icon"] = "span class=\"fa fa-<icon>\""; adapted["radio"] = "radio-input"; adapted["button with elements"] = "a class=\"Button\"";
        adapted["a href"] = "a onclick=\"ExternalURL(URL = ...)\"";
        var none = new JsonObject();
        foreach (var (tag, fix) in NoWidget.OrderBy(p => p.Key, StringComparer.Ordinal)) none[tag] = fix;
        none["img"] = "write it as " + ImageFix;
        return new JsonObject {
            ["schema"] = "ssam-traditional-dialect/1",
            ["root"] = new JsonObject { ["tags"] = A(["screen", "block"]), ["attributes"] = A(TopAttributes), ["layout"] = A(Layouts) },
            ["data"] = new JsonObject { ["tags"] = A(["var", "input name"]), ["attributes"] = A(DataAttributes) },
            ["tags"] = tags,
            ["method"] = A(Methods), ["validation"] = A(Validations), ["lineSeparator"] = A(LineSeparators),
            ["adapted"] = adapted, ["noWidget"] = none,
        };
    }
    internal static bool Extended(ScreenHtml.Node node, string key) => Types.ContainsKey(node.Tag) && node.Tag != "Block" && !Language.Contains(key)
        && !key.StartsWith("os-", StringComparison.Ordinal) && !key.StartsWith("ext:", StringComparison.Ordinal) && !key.StartsWith("on", StringComparison.Ordinal) && PlainName.IsMatch(key);

    // HTML elements whose Traditional widget is the Container: a div (block) or a span (inline, display: inline).
    private static readonly HashSet<string> BlockTags = new(StringComparer.Ordinal) { "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header",
        "footer", "nav", "main", "aside", "ul", "ol", "li", "figure", "figcaption", "blockquote", "address", "dl", "dt", "dd" };
    private static readonly HashSet<string> InlineTags = new(StringComparer.Ordinal) { "strong", "em", "b", "u", "small", "mark", "s", "sub", "sup", "code", "abbr", "cite", "q", "time", "kbd" }; // never var: the declaration of the language
    // What has no Traditional widget, with what to write instead.
    private static readonly Dictionary<string, string> NoWidget = new(StringComparer.Ordinal) {
        ["pre"] = "write <div style=\"white-space: pre\"> (a Container keeps the text, the style keeps the spacing)",
        ["br"] = "end the line with a new <div> (a Container per line); Traditional text has no line break widget",
        ["hr"] = "write <div class=\"separator\"> and draw the line in CSS",
        ["iframe"] = "Traditional has no frame widget: use the installed component contract (an extension block) or an expr with Escape Content off",
        ["script"] = "move the script to a JavaScript of the screen or of a screen action; a document carries no code",
        ["svg"] = "write the icon as the Font Awesome class (<i icon=\"name\">) or as a CSS mask or background of a div; an image by URL is " + ImageFix,
        ["canvas"] = "Traditional has no canvas widget: use the installed component contract",
        ["video"] = "Traditional has no video widget: use the installed component contract",
        ["audio"] = "Traditional has no audio widget: use the installed component contract",
        ["popup"] = "a Traditional popup is a screen with LayoutPopup opened by a link (Popup_Editor) or the Modal of OutSystemsUIWeb (kernel/AGENTS.md, Traditional components)",
        ["radio-group"] = "write one <radio-input bind=\"X\" value=\"...\"> per choice, all with the same bind",
        ["switch"] = "write <checkbox-input bind=\"X\"> (a Traditional switch is a checkbox with the class of the theme)",
        ["icon"] = "write <i icon=\"name\"> (written as the Font Awesome class of OutSystemsUIWeb)",
    };

    // C-30 (F-FT-05, 27/10): <img> was IImageWidget, which no Web parent creates ("IContainerWidget '' cannot create
    // IImageWidget" at the apply, with no line). The installed Model API has no image widget a Web container creates
    // (kernel/catalog model-api: the Creatables of IContainerWidget, IWebScreen and IWebBlock name none), so the document refuses
    // <img> before the build, the Expression that renders it as the patch (every value through EncodeHtml, as the Verify asks).
    internal const string ImageFix = "an Expression with Escape Content off that writes the <img>: <expr value=\"&quot;<img src='&quot; + EncodeHtml(Url) + &quot;'>&quot;\" os-EscapeContent=\"False\"/> (EncodeHtml around every value; the patch writes it from the <img>), or a CSS background-image of a div";
    internal const string ImageMessage = "<img>: Traditional has no image widget a document can create (the Model API creates none in a Web container).";

    /// <summary>C-30: the &lt;expr&gt; that renders an &lt;img&gt; (its id, if and else kept on the Expression; every attribute in
    /// the HTML it writes, a literal as text, a {{ binding }} through EncodeHtml); null when the image carries what an Expression
    /// cannot (an event, a native or extended property).</summary>
    internal static string? ImageExpression(ScreenHtml.Node img)
    {
        var pieces = new List<string>();
        var text = new System.Text.StringBuilder("<img");
        string Literal(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
        static string Html(string value) => value.Replace("&", "&amp;").Replace("'", "&#39;").Replace("<", "&lt;").Replace(">", "&gt;");
        var kept = new List<string>();
        foreach (var (key, value) in img.Attributes) {
            if (key == "k") continue;
            if (key is "id" or "if" or "else") { kept.Add(key == "else" && value.Length == 0 ? " else" : " " + key + "=" + ScreenDocument.QuoteAttribute(value)); continue; }
            if (key.StartsWith("on", StringComparison.Ordinal) || key.StartsWith("os-", StringComparison.Ordinal) || key.StartsWith("ext:", StringComparison.Ordinal) || key.StartsWith('@') || !PlainName.IsMatch(key)) return null;
            var bound = ScreenHtml.Run(value, out var expression, out var fault);
            if (fault != null) return null;
            text.Append(' ').Append(key).Append("='");
            if (expression) { pieces.Add(Literal(text.ToString())); text.Clear(); pieces.Add("EncodeHtml(" + bound + ")"); }
            else text.Append(Html(value));
            text.Append('\'');
        }
        text.Append('>');
        pieces.Add(Literal(text.ToString()));
        return "<expr" + string.Concat(kept) + " value=" + ScreenDocument.QuoteAttribute(string.Join(" + ", pieces)) + " os-EscapeContent=\"False\"/>";
    }

    public sealed record Adaptation(JsonArray Adapted, JsonArray Dropped)
    {
        public JsonObject? Receipt() => Adapted.Count == 0 && Dropped.Count == 0 ? null
            : new JsonObject { ["adapted"] = Adapted.DeepClone(), ["dropped"] = Dropped.DeepClone() };
    }

    /// <summary>Rewrites the parsed document in place (the top screen or block and everything under it), returning what changed
    /// and what could not be kept. Deterministic; a document already in the Traditional form comes back unchanged and empty.</summary>
    public static Adaptation Adapt(ScreenHtml.Node top)
    {
        var adapted = new JsonArray(); var dropped = new JsonArray();
        void Note(JsonArray list, ScreenHtml.Node n, string from, string to, string why)
            => list.Add(new JsonObject { ["line"] = n.Line, ["column"] = n.Column, ["from"] = from, ["to"] = to, ["why"] = why });
        void Remove(ScreenHtml.Node n, string key) => n.Attributes.RemoveAll(a => a.Key == key);
        void Put(ScreenHtml.Node n, string key, string value) { Remove(n, key); n.Attributes.Add(new(key, value)); }
        bool Plain(string value) => !value.StartsWith('@') && !value.Contains(':');
        void Rename(ScreenHtml.Node node)
        {
            var was = node.Tag;
            if (was == "th") { node.Tag = "td"; Note(adapted, node, "<th>", "<td> (ICellWidget)", "a Traditional table has one cell widget: the header look of th (bold, centered) is the CSS of its class"); }
            else if (BlockTags.Contains(was)) { node.Tag = "div"; Note(adapted, node, "<" + was + ">", "<div> (IContainerWidget)", "a Traditional Container renders a div: the browser's own look of <" + was + "> (margins, size, bullets) is the CSS of its class"); }
            else if (InlineTags.Contains(was) || was == "i" && node.Get("icon") == null) { node.Tag = "span"; Note(adapted, node, "<" + was + ">", "<span> (IContainerWidget, display: inline)", "a Traditional Container renders a span here: the browser's own look of <" + was + "> (weight, style) is the CSS of its class"); }
            else if (was == "i") {
                var icon = node.Get("icon")!; var classes = node.Get("class");
                node.Tag = "span"; Remove(node, "icon");
                Put(node, "class", "fa fa-" + icon + (string.IsNullOrWhiteSpace(classes) ? "" : " " + classes));
                Note(adapted, node, "<i icon=\"" + icon + "\">", "<span class=\"fa fa-" + icon + "\">", "Traditional has no Icon widget: OutSystemsUIWeb renders Font Awesome by class");
                foreach (var key in new[] { "size", "weight" })
                    if (node.Get(key) is { } value) { Remove(node, key); Note(dropped, node, key + "=\"" + value + "\"", "", "the Font Awesome class has no " + key + "; give it in the CSS of the class"); }
            }
            else if (was == "radio") { node.Tag = "radio-input"; Note(adapted, node, "<radio>", "<radio-input> (IRadioButtonWidget)", "the same widget under its Traditional name"); }
            else if (was == "button" && node.Children.Any(c => !c.IsText)) {
                node.Tag = "a"; Put(node, "class", "Button" + (node.Get("class") is { Length: > 0 } c ? " " + c : ""));
                Note(adapted, node, "<button> with elements", "<a class=\"Button\"> (ILinkWidget)", "a Traditional Button holds only its label; the Link holds widgets and the theme draws class Button as a button");
            }
            if (node.Tag == "form") {
                foreach (var (os, attribute) in new[] { ("os-Editable", "editable"), ("os-IsEditable", "editable"), ("os-SourceRecord", "record") })
                    if (node.Get(os) is { } value && node.Get(attribute) == null) { Remove(node, os); Put(node, attribute, value); Note(adapted, node, os + "=\"" + value + "\"", attribute + "=\"" + value + "\"", "the Form's own row (IsEditable, SourceRecord)"); }
            }
            if (node.Tag == "select") {
                // The reader's own form of a record-list Combo Box (os-SourceAttributeParent="StructureAttribute:Name" beside
                // os-SourceAttributeRecord="Choice"): the field of that record, written back as Record.Field (b0b90315: the read
                // form was not writable, so the migration replaced every select by a generic list).
                // Only the column of an entity or structure that is the row itself (EntityAttribute/StructureAttribute...): a
                // Source Entity combo, or a parent that is an attribute of the row's record with its own os-Source*Attribute,
                // is written natively as read.
                var entitySource = node.Get("source-entity") != null || node.Get("os-SourceEntity") != null;
                foreach (var (parent, record, attribute, own) in new[] { ("os-SourceAttributeParent", "os-SourceAttributeRecord", "label", "os-SourceAttribute"), ("os-SourceIdentifierAttributeParent", "os-SourceIdentifierAttributeRecord", "value", "os-SourceIdentifierAttribute") })
                    if (!entitySource && node.Get(own) == null && node.Get(parent) is { } read && read.IndexOf(':') is var colon && colon > 0
                        && read[..colon] is "EntityAttribute" or "StructureAttribute" or "EntityAttributeSignature" or "StructureAttributeSignature"
                        && node.Get(record) is { } owner && Plain(owner) && node.Get(attribute) == null) {
                        Remove(node, parent); Remove(node, record); Put(node, attribute, owner + "." + read[(colon + 1)..]);
                        Note(adapted, node, parent + "=\"" + read + "\" " + record + "=\"" + owner + "\"", attribute + "=\"" + owner + "." + read[(colon + 1)..] + "\"", "the reader's form of the column, written as the select's own row");
                    }
                foreach (var (os, attribute) in new[] { ("os-SourceAttributeParent", "label"), ("os-SourceIdentifierAttributeParent", "value"), ("os-SourceRecordList", "options") })
                    if (node.Get(os) is { } value && Plain(value) && node.Get(attribute) == null) { Remove(node, os); Put(node, attribute, value); Note(adapted, node, os + "=\"" + value + "\"", attribute + "=\"" + value + "\"", "the select's own row: label/value name Record.Field of its options"); }
                foreach (var os in new[] { "os-SourceAttributeRecord", "os-SourceIdentifierAttributeRecord" })
                    if (node.Get(os) is { } value && Plain(value) && (node.Get("label") != null || node.Get("value") != null)) { Remove(node, os); Note(adapted, node, os + "=\"" + value + "\"", "", "derived from label/value (the record of Record.Field)"); }
            }
            if (node.Get("os-onchange.Method") is "Ajax") { Remove(node, "os-onchange.Method"); Note(adapted, node, "os-onchange.Method=\"Ajax\"", "", "a Traditional OnChange is always an Ajax Submit: IOnChange has only Destination"); }
        }
        // thead/tbody/tfoot directly in a table: their rows are the table's; a table (or its tbody) with list is a table-records.
        void Rows(ScreenHtml.Node table)
        {
            string? source = table.Get("list");
            ScreenHtml.Node? listed = null;
            for (var i = 0; i < table.Children.Count; i++) {
                var group = table.Children[i];
                if (group.IsText || group.Tag is not ("thead" or "tbody" or "tfoot")) continue;
                if (group.Get("list") is { } groupSource && source == null) { source = groupSource; listed = group; }
                else if (group.Attributes.Any(a => a.Key != "k")) continue; // Check refuses it with its attributes
                table.Children.RemoveAt(i); table.Children.InsertRange(i, group.Children); i += group.Children.Count - 1;
                Note(adapted, group, "<" + group.Tag + ">", "its rows, in the table", "a Traditional table holds its rows directly (ITableWidget, ITableRecordsWidget)");
            }
            if (source == null || table.Tag != "table") return;
            var rows = table.Children.Where(c => !c.IsText).ToList();
            if (rows.Count != 2 || rows.Any(r => r.Tag != "tr")) {
                if (listed != null) { table.Children.Clear(); table.Children.AddRange(rows); Put(table, "list", source); }
                return; // Check refuses the list with the form it needs
            }
            table.Tag = "table-records"; Remove(table, "list"); Put(table, "source", source);
            Note(adapted, table, "<table list=\"" + source + "\">", "<table-records source=\"" + source + "\"> (HeaderRow, DataRow)", "a repeated Traditional table is the Table Records of its source: the first row is its header, the second its row");
        }
        void Walk(ScreenHtml.Node node, bool isTop)
        {
            if (!isTop && !node.IsText) Rename(node);
            if (node.Tag is "table" or "table-records") Rows(node);
            foreach (var child in node.Children.Where(c => !c.IsText).ToList()) Walk(child, false);
        }
        Walk(top, true);
        return new(adapted, dropped);
    }

    /// <summary>The problems of an adapted document, all at once, each with the tag or attribute to write instead.
    /// <paramref name="opaqueKept"/> says whether an os-opaque element is moved from the reading (a recreation).</summary>
    public static void Check(ScreenHtml.Node node, List<ScreenDocument.Problem> problems, bool block, Func<ScreenHtml.Node, bool> opaqueKept, bool top = false, bool declaration = false)
    {
        // C-13: the default fix names what this tag takes (TagFix), never the whole dialect: 35 problems with the same long fix were
        // cut to one ("...table-records/list-records with source/lin…") by the answer's prose rules.
        void Problem(ScreenHtml.Node n, string message, string? fix = null, ScreenDocument.Correction? correct = null) => problems.Add(new(ScreenDocument.Traditional, n.Line, n.Column, message, fix ?? TagFix(n, top), Correct: correct));
        if (node.IsText) { ScreenHtml.Run(node.Text!, out _, out var fault); if (fault != null) Problem(node, fault); return; }
        var allowed = new HashSet<string>(StringComparer.Ordinal);
        // k is the identity of the reading an edit or a recreation is based on: accepted everywhere, written nowhere.
        allowed.Add("k");
        if (top) {
            allowed.UnionWith(TopAttributes);
            // C-28 (F-FT-17): layout="blank" is the screen without the template's layout block (its content at the root).
            if (node.Get("layout") is { } layout && !Layouts.Contains(layout, StringComparer.Ordinal))
                Problem(node, "layout=\"" + layout + "\" is no layout of a Traditional document.", "write layout=\"blank\" (the screen without the template's layout block: its content at the root) or layout=\"theme\" (the default: inside the layout's MainContent), or name the layout block: <Block name=\"Layout\"><slot name=\"MainContent\">...");
            if (node.Get("layout") != null && node.Tag != "screen") Problem(node, "layout is an attribute of a <screen>; a block has no layout.", "drop layout from the <block>");
        }
        else if (Data(node)) { allowed.UnionWith(DataAttributes); if (!declaration) Problem(node, "Variables and input parameters must be direct children of screen or block; a visual input needs bind."); }
        else if (node.Tag == "os-opaque" || node.Tag.StartsWith("os-", StringComparison.Ordinal)) {
            // A widget the language has no row for (os-opaque) or an element of another kind the reader prints by its
            // kind (a UI flow connector of the screen) keeps its native subtree: a recreation moves the original (by k);
            // a new document cannot make it.
            if (!opaqueKept(node))
                Problem(node, "<os-opaque kind=\"" + node.Get("kind") + "\"> is a widget the Traditional document cannot create; keep it where the reading put it (edit by k and basedOn) or write it with the native verbs.");
            return;
        }
        else if (node.Tag == "style") { if (node.Attributes.Count > 0) Problem(node, "Traditional <style> writes the screen or block stylesheet; scope and other attributes are unsupported."); return; }
        else if (node.Tag == "slot") allowed.Add("name");
        else if (node.Tag == "img") {
            var expression = ImageExpression(node);
            Problem(node, ImageMessage, "write it as " + ImageFix + (expression == null ? "; the <img> carries an event or a native property an Expression has no row for, so there is no patch" : ""),
                expression == null ? null : new ScreenDocument.ReplaceElement(expression));
            return;
        }
        else if (Types.ContainsKey(node.Tag)) {
            // C-13: the one table of what each tag takes (AttributesOf), the one the dialect card is generated from.
            allowed.UnionWith(AttributesOf(node.Tag));
            if (node.Tag == "div" && node.Get("list") == null) allowed.Remove("line-separator");
            if (node.Tag == "list-records" || node.Tag == "div" && node.Get("list") != null) {
                if (node.Get("line-separator") is { } separator && !LineSeparators.Contains(separator, StringComparer.Ordinal))
                    Problem(node, "line-separator=\"" + separator + "\" is no Line Separator of a List Records.", "write line-separator=\"None\" (the rows side by side, laid out by the CSS), \"NewLine\" (a <br> between the rows, the default) or \"Bullets\"");
            }
            if (node.Tag == "placeholder" && !block) Problem(node, "<placeholder> is a placeholder of a block; this document is a screen.", "write the content where the screen's layout block has its placeholder (<Block name=\"Layout\"><slot name=\"MainContent\">...), or move it to a <block>");
        }
        else Problem(node, "Traditional has no document mapping for <" + node.Tag + ">.", NoWidget.TryGetValue(node.Tag, out var instead) ? instead : null);
        if (node.Get("method") is { } method && !Methods.Contains(method, StringComparer.Ordinal))
            Problem(node, "method must be Ajax, Submit or Navigate (Ajax means Ajax Submit).", "method=\"Ajax\" (Ajax Submit: the action runs and the page stays), \"Submit\" (a full postback: upload, download) or \"Navigate\" (a screen or a URL)");
        if (node.Get("validation") is { } validation && !Validations.Contains(validation, StringComparer.Ordinal))
            Problem(node, "validation must be None, Server or ClientAndServer.", "validation=\"None\" (tabs, paging, open/close), \"Server\" or \"ClientAndServer\"");
        if ((node.Get("method") != null || node.Get("validation") != null) && node.Get("onclick") == null)
            Problem(node, "method and validation require onclick.");
        foreach (var a in node.Attributes) {
            if (!allowed.Contains(a.Key) && !((top || Types.ContainsKey(node.Tag)) && (a.Key.StartsWith("os-", StringComparison.Ordinal) || a.Key.StartsWith("ext:", StringComparison.Ordinal))) && !(node.Tag == "Block" && (a.Key.StartsWith(':') || a.Key.StartsWith('@') || a.Key == "onnotify")) && !Extended(node, a.Key))
                Problem(node, "Unsupported Traditional attribute " + a.Key + " on <" + node.Tag + ">; it would not be preserved.", AttributeFix(node, a.Key));
            if (a.Key.StartsWith("ext:", StringComparison.Ordinal)) {
                if (a.Key.Length == 4 || ScreenDocument.ScriptAttribute(a.Key,a.Value) != null) Problem(node,"Extended attributes must have a name and cannot introduce inline browser code; bind native events to actions.");
                if (ScreenDocument.AttributeBindingProblem(node,a.Key,a.Value) is { } binding) problems.Add(binding);
            }
            if (a.Key.Equals("os-Visible", StringComparison.OrdinalIgnoreCase) && !(a.Key == "os-Visible" && a.Value == "True")) Problem(node, "Use div if/else for a new conditional widget; the canonical constant os-Visible=True only preserves an always-visible control.");
            if (a.Key is "class" or "style" && ScreenHtml.HasBinding(a.Value)) Problem(node, "Traditional " + a.Key + " must be literal; dynamic classes need a native extended property.", "write the class as ext:class=\"{{ expression }}\" (an extended property the runtime evaluates)");
            if ((a.Key == "onclick" || a.Key == "onchange" || a.Key == "onnotify" || a.Key.StartsWith('@')) && !ScreenHtml.TryCall(a.Value, out _, out _)) Problem(node, "An event requires a destination and named OutSystems argument expressions.");
            if (a.Key == "os-onchange.Method") Problem(node, "os-onchange.Method=\"" + a.Value + "\": the OnChange of a Traditional input has no method (IOnChange has only Destination); it is always an Ajax Submit.", "drop os-onchange.Method; for a full submit put a button with method=\"Submit\" beside the input");
        }
        if (node.Tag == "select") {
            var source = node.Get("options") ?? node.Get("source-entity") ?? node.Get("os-SourceEntity") ?? node.Get("os-SourceRecordList");
            if (node.Get("bind") != null && source == null)
                Problem(node, "<select bind> without options or source-entity: a Traditional Combo Box holds its variable only with a Source Record List or a Source Entity (the Studio refuses it: InvalidPropertySelection_VarFilled); fixed choices alone (empty, os-SpecialOptions) are no source.",
                    "give it options=\"List\" with label=\"Record.Field\" value=\"Record.Field\" (a local list of a structure filled in the Preparation, or an aggregate), or source-entity=\"Entity\" source-attribute=\"Entity.Field\"; keep the fixed choices as empty/os-SpecialOptions");
            if (node.Get("options") != null && (node.Get("source-entity") ?? node.Get("os-SourceEntity")) is { } entity)
                Problem(node, "<select> with options and source-entity " + entity + ": a Traditional Combo Box reads one source (the Studio refuses the other's column: InvalidProperty_SourceAttribute).",
                    "keep options=\"List\" with label/value Record.Field (the rows of the list), or source-entity=\"" + entity + "\" with source-attribute; drop the other");
            foreach (var column in new[] { "label", "value" })
                if (node.Get(column) is { } named && !named.Contains('.') && node.Get("options") == null)
                    Problem(node, column + "=\"" + named + "\" without options: the column of a Traditional select is Record.Field of its options.", "write options=\"List\" and " + column + "=\"Record." + named + "\" (the entity or structure of the list's rows)");
        }
        if (node.Tag == "Block" && node.Get("name") == null) Problem(node, "Block needs the name of its source block.");
        if (node.Tag == "text" && node.Children.Any(c => !c.IsText)) Problem(node, "text contains only literal text.");
        if (node.Tag == "label" && node.Children.Any(c => !c.IsText && c.Tag != "text"))
            Problem(node, "A native Traditional label contains literal text; put dynamic expressions beside its input.", "write the expression in an <expr value=\"...\"/> next to the label, and keep the label's literal text");
        if (node.Tag == "expr" && (node.Get("value") == null || node.Children.Any(c => !c.IsText || !string.IsNullOrWhiteSpace(c.Text)))) Problem(node, "expr requires value and no children.");
        if (node.Tag == "text") return; // Literal braces are not binding syntax inside canonical text.
        foreach (var child in node.Children) Check(child, problems, block, opaqueKept, declaration: top);
    }

    /// <summary>C-48 (F-FT-29, Jesse Traditional, 27/10): a List Records (list-records, table-records, div list) whose line-count
    /// is an expression ("show more": ShowMore adds 3 to ProjectCount). The Traditional runtime fetches an aggregate a List
    /// Records shows, directly or through the variable it is assigned to, with Max Records = start-index + line-count + 1,
    /// evaluated when the aggregate runs, in the Preparation and in a screen action alike: "View all works" showed 7 of 9 and
    /// disappeared. A warning (the page compiles and runs; what it fetches is the platform's), with the pattern that shows every
    /// row: raise the count, then query again.</summary>
    internal const string LineCountFetch = "HTML_LIST_RECORDS_LINE_COUNT";

    internal static IEnumerable<ScreenDocument.Problem> Paging(ScreenHtml.Node node)
    {
        if (node.IsText) yield break;
        var records = node.Tag is "list-records" or "table-records" || node.Tag == "div" && node.Get("list") != null;
        if (records && node.Get("line-count") is { } count && count.Trim() is { Length: > 0 } written
            && !int.TryParse(written, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out _)) {
            var source = node.Get("source") ?? node.Get("list") ?? "";
            yield return new(LineCountFetch, node.Line, node.Column,
                $"<{node.Tag} source=\"{source}\" line-count=\"{written}\">: the Traditional runtime fetches an aggregate a List Records shows (directly or through the variable it is assigned to) with Max Records = start-index + line-count + 1, evaluated when the aggregate runs, in the Preparation and in a screen action alike: a line count raised after the query shows only the rows already fetched (F-FT-29: 7 of 9 projects)",
                $"to show more, raise the count BEFORE querying again: in the screen action, assign {written} = {written} + N, then run the aggregate again and assign {source} (Ajax does not rerun the Preparation), then Ajax Refresh the list; or give the aggregate a MAX that covers every row");
        }
        foreach (var child in node.Children) foreach (var p in Paging(child)) yield return p;
    }

    private static string? AttributeFix(ScreenHtml.Node node, string key) => (node.Tag, key) switch {
        ("table", "list") => "a repeated Traditional table is <table-records source=\"X\"> with exactly two tr: the header row, then the data row (a <table list> or <tbody list> with those two rows is written so)",
        (_, "list") => "put list on a div around it: <div list=\"X\"> repeats its content",
        ("Block", "if" or "else") => "put the condition on a div around the block: <div if=\"...\"><Block .../></div>",
        (_, "bind") => "bind belongs to input, textarea, checkbox-input, password-input, radio-input and select",
        (_, "onclick") => "onclick belongs to button and a",
        (_, "onchange") => "onchange belongs to the inputs and select",
        (_, "enabled") => "enabled belongs to button, a, the inputs, select and upload",
        (_, "line-separator") => "line-separator belongs to list-records and div list (the Line Separator of a List Records); a Table Records has rows and no separator",
        _ => null,
    };

    /// <summary>C-08 (F-FT-08, 27/10): the classes whose display the CSS gives, those named by the subject of a rule (its last
    /// compound selector, not a pseudo-element's) that declares display. A span is a Container, which renders a div: it is written
    /// inline (CustomStyle display: inline) unless one of its classes is here; an inline style would beat the class (the steps'
    /// descriptions beside their titles, the logo's square gone, "Search" shown on the desktop).</summary>
    internal static HashSet<string> DisplayedClasses(string css)
    {
        var classes = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(css)) return classes;
        CssStylesheet sheet;
        try { sheet = CssStylesheet.Parse(css, lenient: true); }
        catch (Exception) { return classes; } // CSS that does not parse gives no class a display: the span stays inline
        foreach (var rule in sheet.Rules) {
            if (!rule.Declarations.Any(d => d.Property.Trim().Equals("display", StringComparison.OrdinalIgnoreCase))) continue;
            foreach (var selector in CssStylesheet.SplitSelectors(rule.Selector)) {
                var subject = Subject(selector);
                if (subject.Contains("::", StringComparison.Ordinal) || PseudoElement.IsMatch(subject)) continue;
                classes.UnionWith(CssStylesheet.Classes(subject));
            }
        }
        return classes;
    }
    private static readonly Regex PseudoElement = new(@":(before|after|first-line|first-letter)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Argument = new(@"\([^()]*\)", RegexOptions.CultureInvariant);
    // The last compound selector (after the last combinator outside brackets and parentheses), without the arguments of its
    // pseudo-classes (.a:not(.b) gives a, never b).
    private static string Subject(string selector)
    {
        var depth = 0; var start = 0;
        for (var i = 0; i < selector.Length; i++) {
            var c = selector[i];
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (depth == 0 && (char.IsWhiteSpace(c) || c is '>' or '+' or '~')) start = i + 1;
        }
        var subject = selector[start..].Trim();
        for (var before = ""; before != subject;) { before = subject; subject = Argument.Replace(subject, ""); }
        return subject;
    }

    /// <summary>C-03 (F-FT-09 Fitmaker, 27/10, P0): an expression an event of a row of a List Records or Table Records evaluates
    /// at the postback, with the row of its source written through the list widget: Source.Current and Source.CurrentRowNumber
    /// become &lt;List&gt;.List.Current and &lt;List&gt;.List.CurrentRowNumber (outside text literals). At the postback
    /// Source.Current is the last row the list rendered: "Choose This Plan" of the Pro chose the Begginer and a JoinRequest was
    /// saved with the wrong PlanId; the list widget's Current is the row clicked. A source that is no plain path (an expression)
    /// has no row an argument can name: the text is kept.</summary>
    internal static string ThroughList(string expression, string source, string list)
    {
        if (!SourcePath.IsMatch(source) || string.Equals(source, list, StringComparison.OrdinalIgnoreCase)) return expression;
        var path = string.Join(@"\s*\.\s*", source.Split('.').Select(Regex.Escape));
        var row = new Regex(@"(?<![\p{L}\p{N}_.$@])" + path + @"\s*\.\s*(CurrentRowNumber|Current)(?![\p{L}\p{N}_])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var masked = TextLiteral.Replace(expression, m => new string(' ', m.Length));
        var result = expression;
        foreach (var m in row.Matches(masked).Cast<Match>().Reverse())
            result = result[..m.Index] + list + ".List." + (m.Groups[1].Value.Length > "Current".Length ? "CurrentRowNumber" : "Current") + result[(m.Index + m.Length)..];
        return result;
    }
    private static readonly Regex SourcePath = new(@"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$", RegexOptions.CultureInvariant);
    private static readonly Regex TextLiteral = new("\"(?:[^\"]|\"\")*\"", RegexOptions.CultureInvariant);
    internal const string RowWhy = "an event in a row of a Traditional list reads the row clicked through the list widget: at the postback the source's Current is the last row the list rendered";

    /// <summary>C-08: the literal text of a text node as the page has it (ScreenHtml.Runs, the rule the reading writes by): its
    /// line breaks and indentation are layout (one space inside, none at its ends), and the whitespace beside an inline element on
    /// the same line is the page's ("Our &lt;span&gt;Services&lt;/span&gt;" keeps "Our "; "OurServices" and "With Over5 Yearsof"
    /// before). Whitespace alone is a run only between two inline elements on one line ("&lt;b&gt;a&lt;/b&gt; &lt;i&gt;b&lt;/i&gt;");
    /// null when it is layout.</summary>
    internal static string? LiteralRun(string text, bool afterInline, bool beforeInline)
    {
        if (string.IsNullOrWhiteSpace(text))
            return afterInline && beforeInline && text.Length > 0 && !text.Contains('\n') ? text.Replace("\r", "") : null;
        static string Edge(string edge) => edge.Contains('\n') ? "" : edge.Replace("\r", "");
        var lead = afterInline ? Edge(text[..(text.Length - text.TrimStart().Length)]) : "";
        var trail = beforeInline ? Edge(text[text.TrimEnd().Length..]) : "";
        return lead + Regex.Replace(text.Trim(), @"\s*\n\s*", " ") + trail;
    }

    /// <summary>The preflight's reading of one document: parsed, adapted and checked as the compiler will, without a model.
    /// An os-opaque element with k is a recreation's (kept); without k it is refused as the compiler does.</summary>
    public static List<ScreenDocument.Problem> Lint(string html, out Adaptation adaptation)
    {
        var problems = new List<ScreenDocument.Problem>();
        adaptation = new([], []);
        var nodes = ScreenHtml.Parse(html).Children.Where(n => !n.IsText || !string.IsNullOrWhiteSpace(n.Text)).ToList();
        if (nodes.Count != 1 || nodes[0].Tag is not ("screen" or "block")) return problems;
        adaptation = Adapt(nodes[0]);
        Check(nodes[0], problems, nodes[0].Tag == "block", n => n.Get("k") is { Length: > 0 }, top: true);
        return problems;
    }
}

public sealed partial class ModelSession
{
    // F5: the roots a Traditional document of this job made before their own document ran (a link or a block instance of an
    // earlier document names them): the later document fills that root instead of refusing it as existing.
    private readonly Dictionary<string, IObjectSignature> _traditionalShells = new(StringComparer.OrdinalIgnoreCase);

    // The Traditional front end shares the html document entry and native mutation primitives.
    // Its widget model is distinct from Mobile: never send Mobile widgets or DefaultScreen to it.
    private sealed class TraditionalDocumentCompiler(ModelSession s, string source, DocumentOptions options)
    {
        private readonly List<ScreenDocument.Problem> problems = [];
        private readonly JsonArray written = [];
        // k of the reading the document is based on -> the ObjectKey of what this document made for it (a recreation
        // repoints the consumers of the original by it; ScreenRecreationProof compares the readings by it).
        private readonly JsonObject keys = [];
        private void Keyed(ScreenHtml.Node node, IObjectSignature item) { if (node.Get("k") is { Length: > 0 } k) keys[k] = item.ObjectKey!.ToString(); }
        private IObjectSignature? root, entry;
        private readonly List<(IObjectSignature Label, string For)> labels = [];
        /// <summary>C-21 (F-FT-18): an element the platform or a rule of the compile refuses is one problem at its line and
        /// column, and its siblings are still written: one refusal says every element that fails (four failures came one per
        /// round, with no line: "If objects can't be children of Link objects", "cannot create IImageWidget"). The root is
        /// removed with the refusal at the end, so nothing of a failed element stays.</summary>
        private void Guarded(ScreenHtml.Node node, Action write)
        {
            try { write(); }
            // A reference the session resolves by loading its producer (a Users entity of a select) goes up as it did: the
            // apply loads it and runs the op again.
            catch (Exception error) when (error is not (OutOfMemoryException or StackOverflowException) && Errors.FindUnresolved(error) == null)
            {
                var inner = error;
                while (inner is System.Reflection.TargetInvocationException { InnerException: { } cause }) inner = cause;
                var code = Errors.FindCoded(error)?.Code is { Length: > 0 } c && c != "PREFLIGHT_REFUSED" ? c : ScreenDocument.Invalid;
                var message = inner is KernelRefusalException ? inner.Message : inner.GetType().Name + ": " + inner.Message;
                problems.Add(new(code, node.Line, node.Column, $"<{node.Tag}>" + (node.Get("id") is { Length: > 0 } id ? $" id=\"{id}\"" : "") + ": " + message,
                    "change this element (another tag, or a parent the Traditional widget accepts) or remove it; the other elements of the document were written and judged in this same refusal"));
            }
        }
        private int sequence;
        // C-08: the classes whose display the document's CSS gives (a span with one of them is not written inline).
        private HashSet<string> displayed = new(StringComparer.Ordinal);
        // C-03: the lists whose rows the element being written is in, the innermost last: the source as written and the name of
        // the list widget (an event argument of a row reads its row through it).
        private readonly List<(string Source, string List)> rowsOf = [];
        /// <summary>An argument of an event of the element, its source's row written through the lists it is in (C-03), listed in
        /// migration.adapted when it changed.</summary>
        private string RowArgument(ScreenHtml.Node node, string value)
        {
            var written = value;
            for (var i = rowsOf.Count - 1; i >= 0; i--) written = TraditionalDocumentRules.ThroughList(written, rowsOf[i].Source, rowsOf[i].List);
            if (written != value)
                adaptation.Adapted.Add(new JsonObject { ["line"] = node.Line, ["column"] = node.Column, ["from"] = value, ["to"] = written, ["why"] = TraditionalDocumentRules.RowWhy });
            return written;
        }
        // The name of a list widget whose rows an argument reads: its id, the name the platform gave it, else the first free
        // <Kind>N of the root (deterministic: the document's order).
        private string ListName(IObjectSignature list, string prefix)
        {
            if (TypeResolver.Name(list) is { Length: > 0 } given) return given;
            var taken = new HashSet<string>(root!.GetAllDescendantsOfType<IObjectSignature>().Select(TypeResolver.Name).OfType<string>(), StringComparer.OrdinalIgnoreCase);
            var n = 1; while (taken.Contains(prefix + n)) n++;
            Set(list, "Name", prefix + n);
            return prefix + n;
        }
        private const string WebText = TraditionalDocumentRules.WebText;
        private static Dictionary<string, string> Types => TraditionalDocumentRules.Types;
        private static bool Data(ScreenHtml.Node n) => TraditionalDocumentRules.Data(n);
        private static bool Extended(ScreenHtml.Node node, string key) => TraditionalDocumentRules.Extended(node, key);
        private TraditionalDocumentRules.Adaptation adaptation = new([], []);
        private void Check(ScreenHtml.Node top) => TraditionalDocumentRules.Check(top, problems, top.Tag == "block",
            node => options.MoveOpaque && options.Opaque != null && node.Get("k") is { Length: > 0 } opaque && options.Opaque(opaque) != null, top: true);

        // The documents of the other html ops of this job, by root name: what a link (onclick) or a block instance of this
        // document may name before its own op runs. Parsed once per compile; a document that does not parse is its op's problem.
        private Dictionary<string, ScreenHtml.Node>? jobRoots;
        private Dictionary<string, ScreenHtml.Node> JobRoots()
        {
            if (jobRoots != null) return jobRoots;
            jobRoots = new(StringComparer.OrdinalIgnoreCase);
            foreach (var op in (s._applyOps ?? []).OfType<JsonObject>())
            {
                if (op["op"]?.ToString() != "html" || op["parent"] != null || op["data"] is not JsonObject data || data["screen"] != null || data["edits"] != null
                    || data["html"] is not JsonValue html || !html.TryGetValue<string>(out var text) || text == source) continue;
                try
                {
                    var top = ScreenHtml.Parse(text).Children.Where(n => !n.IsText).ToList();
                    if (top is [{ Tag: "screen" or "block" } only] && only.Get("name") is { Length: > 0 } name) jobRoots.TryAdd(only.Tag + ":" + name, only);
                }
                catch (FormatException) { }
            }
            return jobRoots;
        }

        /// <summary>The root a later document of this job creates (a screen to navigate to, a block to instantiate), made now with
        /// its name and its input parameters so this document can bind to it; the later document fills it. Null when no document
        /// of the job declares it.</summary>
        private IObjectSignature? Shell(string kind, string name)
        {
            if (s._traditionalShells.TryGetValue(kind + ":" + name, out var made)) return made;
            if (!JobRoots().TryGetValue(kind + ":" + name, out var document)) return null;
            var flow = (IObjectSignature)s.Resolve("IWebFlow:" + (document.Get("flow") ?? "MainFlow"));
            var shell = (IObjectSignature)s.NewChild(flow, kind == "screen" ? "IWebScreen" : "IWebBlock", name);
            s.Anchor(shell, created: true);
            foreach (var input in document.Children.Where(n => n.Tag == "input" && n.Get("bind") == null && n.Get("name") is { Length: > 0 }))
            {
                var parameter = (IObjectSignature)s.NewChild(shell, "IInputParameter", input.Get("name"));
                s.Anchor(parameter, created: true);
                var dataType = input.Get("type") ?? "Text";
                Set(parameter, "DataType", dataType.StartsWith("BasicType:", StringComparison.Ordinal) ? dataType[10..] : dataType);
                Set(parameter, "IsMandatory", input.Get("mandatory") ?? "False");
            }
            s._traditionalShells[kind + ":" + name] = shell;
            written.Add(new JsonObject { ["type"] = "shell:" + (kind == "screen" ? "IWebScreen" : "IWebBlock"), ["key"] = shell.ObjectKey!.ToString(), ["name"] = name });
            return shell;
        }
        private IObjectSignature Create(IObjectSignature parent, string type, string? name = null)
        {
            // The footprint keeps the parent as a scope before the child exists, as a create op would (B3): the sweep
            // and the scopes then agree on what this document created.
            s.FootprintScopes("create", new JsonObject { ["parent"] = "@" + parent.ObjectKey });
            var item = (IObjectSignature)s.NewChild(parent, type, name);
            s.Anchor(item, created: true);
            written.Add(new JsonObject { ["type"] = type, ["key"] = item.ObjectKey!.ToString(), ["name"] = TypeResolver.Name(item) });
            return item;
        }
        private void Set(IObjectSignature item, string property, string value)
        {
            var op = new JsonObject { ["op"] = "set", ["target"] = "@" + item.ObjectKey, ["prop"] = property, ["value"] = value };
            if (property == "Style") {
                var (written, done) = s.StyleRule(item, op);
                if (done != null) return;
                op = written;
            }
            s.SetCore(item, op);
        }
        private void ComboColumn(IObjectSignature item, string column, bool identifier, string? options)
        {
            // The row of the options written as the list's current row (Options.Current.Name, Options.Current.Record.Name): the
            // column is what follows it (the NWLoanPortal_TW chain wrote FilterChoices.Current.Name).
            if (options != null && column.StartsWith(options + ".Current.", StringComparison.Ordinal)) {
                var rest = column[(options.Length + 9)..];
                adaptation.Adapted.Add(new JsonObject { ["from"] = (identifier ? "value" : "label") + "=\"" + column + "\"", ["to"] = (identifier ? "value" : "label") + "=\"" + rest + "\"",
                    ["why"] = "a select's column names the field of its options' rows, not the list's current row" });
                column = rest;
            }
            var dot = column.LastIndexOf('.');
            IObjectSignature record, field;
            if (dot < 0 && TraditionalWidgetMetadata.InferColumn(item, column) is { } inferred) {
                // A bare field of the options' rows: the one entity or structure of the row that has it (F5).
                (record, field) = inferred;
                adaptation.Adapted.Add(new JsonObject { ["from"] = (identifier ? "value" : "label") + "=\"" + column + "\"", ["to"] = (identifier ? "value" : "label") + "=\"" + TypeResolver.Name(record) + "." + column + "\"",
                    ["why"] = "the only record of the options' rows with a field " + column });
            }
            else {
                if (dot <= 0 || dot == column.Length - 1)
                    throw new KernelRefusalException(ScreenDocument.Traditional, "Traditional select label/value requires Record.Field of its options; received " + column
                        + (TraditionalWidgetMetadata.RowRecords(item) is { Count: > 0 } rows ? " (the options' rows hold " + string.Join(", ", rows) + ")" : ""));
                var recordName = column[..dot];
                try { record = (IObjectSignature)s.Resolve("IEntitySignature:" + recordName); }
                catch (KeyNotFoundException) {
                    try { record = (IObjectSignature)s.Resolve("IStructureSignature:" + recordName); }
                    catch (KeyNotFoundException) {
                        throw new KernelRefusalException(ScreenDocument.Traditional, "select " + (identifier ? "value" : "label") + "=\"" + column + "\": " + recordName + " is no entity or structure of this module or its references"
                            + (TraditionalWidgetMetadata.RowRecords(item) is { Count: > 0 } rows ? "; the options' rows hold " + string.Join(", ", rows) : ""));
                    }
                }
                field = At(record, "/" + column[(dot + 1)..]);
            }
            var parent = TraditionalWidgetMetadata.ColumnParent(item, record, field);
            Set(item, identifier ? "SourceIdentifierAttributeParent" : "SourceAttributeParent", "@" + parent.ObjectKey);
            if (!ReferenceEquals(parent, field))
                Set(item, identifier ? "SourceIdentifierAttribute" : "SourceAttribute", "@" + field.ObjectKey);
            Set(item, identifier ? "SourceIdentifierAttributeRecord" : "SourceAttributeRecord", "@" + record.ObjectKey);
        }
        private static string Expression(string text) { var value = ScreenHtml.Run(text, out var expression, out _); return expression ? value : "\"" + value.Replace("\"", "\"\"") + "\""; }
        private void TextValue(IObjectSignature item, string property, string value)
        {
            // The WebScreen title getter is an expression, but SetTitle takes its literal caption.
            if (property != "Title" && IsExpressionProperty(item, property)) Set(item, property, Expression(value));
            else {
                if (ScreenHtml.HasBinding(value)) throw new FormatException("Traditional " + property + " takes literal text, not a binding.");
                var verbatim = s._verbatim;
                try { s._verbatim = true; Set(item, property, value); }
                finally { s._verbatim = verbatim; }
            }
        }
        /// <summary>C-23 (proto e699810c): a destination written without its kind that no element of the root and no screen
        /// carries, but the module's external site of that name does (ExternalURL of the WebFlow Common of the templates, as the
        /// reading prints it and LINK_HREF_REWRITTEN writes an href): that site, qualified; the name as written otherwise.</summary>
        private string ExternalSite(string destination)
        {
            if (destination.Contains(':')) return destination;
            foreach (var other in new Func<object>[] { () => At(root!, "/" + destination), () => s.Resolve("IWebScreen:" + destination) })
                try { other(); return destination; }
                catch (Exception error) when (error is KeyNotFoundException or InvalidOperationException) { }
            try { return s.Resolve("IExternalSite:" + destination) is IObjectSignature site && Implements(site, "IExternalSite") ? "ExternalSite:" + destination : destination; }
            catch (Exception error) when (error is KeyNotFoundException or InvalidOperationException) { return destination; }
        }
        private IObjectSignature At(IObjectSignature item, string suffix) => (IObjectSignature)s.Resolve("@" + item.ObjectKey + suffix);
        /// <summary>C-09 (F-FT-23 and F-FT-07, 27/10): what the text of a form control leaves out is the language's
        /// (ScreenDefaults.LanguageDefault on a Traditional page), never what the Studio gives a fresh widget: no grid width (the
        /// theme's ThemeGrid_Width4 beat the class: a 125 px e-mail field; a label's ThemeGrid_Width2), not mandatory, no Max Length
        /// (50 cut an e-mail and a textarea). os-Width, required/mandatory and maxlength write them (os-* after this, in
        /// NativeProperties).</summary>
        private void LanguageDefaults(IObjectSignature item, ScreenHtml.Node node, string type)
        {
            if (type is "IInputWidget" or "IInputPasswordWidget" or "IComboBoxWidget" or "IInputFilenameWidget" or "ServiceStudio.Plugin.Widgets.ILabel"
                && node.Get("os-Width") == null && FindProperty(item, "Width") != null && ModelHost.Prop(item, "Width")?.ToString() is { Length: > 0 })
                Set(item, "Width", "");
            if (type is "IInputWidget" or "IInputPasswordWidget" or "ICheckBoxWidget" or "IInputFilenameWidget"
                && node.Get("mandatory") == null && node.Get("required") == null && node.Get("os-Mandatory") == null && FindProperty(item, "Mandatory") != null)
                Set(item, "Mandatory", "False");
            if (type is "IInputWidget" or "IInputPasswordWidget" && node.Get("maxlength") == null && node.Get("os-MaxLength") == null
                && FindProperty(item, "MaxLength") != null && ModelHost.Prop(item, "MaxLength") != null)
                s.SetCore(item, new JsonObject { ["op"] = "set", ["target"] = "@" + item.ObjectKey, ["prop"] = "MaxLength", ["value"] = null });
        }
        // An event handler of the document is an action of its own root: a name the root does not own is refused with
        // the fix, never a KeyNotFoundException out of the apply.
        private IObjectSignature Owned(string actionName, string attribute)
        {
            try { return At(root!, "/" + actionName); }
            catch (KeyNotFoundException) {
                throw new KernelRefusalException(ScreenDocument.NameUnknown, attribute + " names " + actionName + ", which is no action of "
                    + TypeResolver.Name(root!) + "; declare " + TypeResolver.Name(root!) + "." + actionName + " in a logic op of the same job.");
            }
        }
        private void NativeProperties(IObjectSignature item, ScreenHtml.Node node)
        {
            if (node.Tag == "select" && node.Get("os-SourceEntity") is { } entity)
                Set(item,"SourceEntity",entity.Contains(':') || entity.StartsWith('@') ? entity : "IEntitySignature:" + entity);
            foreach (var attribute in node.Attributes.Where(a => a.Key.StartsWith("ext:", StringComparison.Ordinal) || Extended(node, a.Key))) {
                var extended = Create(item,"IExtendedProperty");
                Set(extended,"Property",attribute.Key.StartsWith("ext:", StringComparison.Ordinal) ? attribute.Key[4..] : attribute.Key); Set(extended,"Value",ScreenHtml.Unsugar(attribute.Value));
            }
            // title of a widget is the HTML attribute: the Link's own Title, else the extended property title (literal).
            if (!ReferenceEquals(item, root) && node.Tag != "a" && node.Get("if") == null && node.Get("title") is { } title) {
                var extended = Create(item,"IExtendedProperty");
                Set(extended,"Property","title"); Set(extended,"Value",ScreenHtml.Unsugar(title));
            }
            foreach (var attribute in node.Attributes.Where(a => a.Key.StartsWith("os-", StringComparison.Ordinal))) {
                var property = attribute.Key[3..]; var target = item;
                // Targets of a screen are its UI flow connectors, derived: the connectors themselves are moved (os-ActionConnector).
                if (ReferenceEquals(item, root) && property == "Targets") continue;
                if (node.Tag == "select" && property == "SourceEntity") continue;
                if (node.Tag == "select" && property == "SourceAttribute" && attribute.Value.StartsWith("EntityAttributeSignature:",StringComparison.Ordinal)
                    && ModelHost.Prop(item,"SourceEntity") is IObjectSignature sourceEntity) {
                    var sourceAttribute = At(sourceEntity,"/" + attribute.Value["EntityAttributeSignature:".Length..]);
                    Set(item,property,"@" + sourceAttribute.ObjectKey); continue;
                }
                // The reader prints a column record by its bare name (os-SourceAttributeRecord="User"), as it prints
                // os-SourceEntity: read it back as the entity of that name, or the structure when no entity has it.
                if (node.Tag == "select" && property is "SourceAttributeRecord" or "SourceIdentifierAttributeRecord"
                    && !attribute.Value.Contains(':') && !attribute.Value.StartsWith('@') && !attribute.Value.StartsWith('$')) {
                    object record;
                    try { record = s.Resolve("IEntitySignature:" + attribute.Value); }
                    catch (KeyNotFoundException) { record = s.Resolve("IStructureSignature:" + attribute.Value); }
                    Set(item,property,"@" + ((IObjectSignature)record).ObjectKey); continue;
                }
                if (property.StartsWith("onclick.", StringComparison.Ordinal)) { target = At(item, "/OnClick"); property = property[8..]; }
                else if (property.StartsWith("onchange.", StringComparison.Ordinal)) { target = At(item, "/OnChange"); property = property[9..]; }
                // Type is a derived contract printed by the reader. It is checked
                // against the source binding, never dropped or assigned by force.
                if (property == "Type" && node.Tag is "table-records" or "list-records") {
                    var actual = UiCatalog.TypeName(ModelHost.Prop(item, property));
                    if (actual != attribute.Value) throw new KernelRefusalException(ScreenDocument.Traditional,
                        "Derived records Type differs from the HTML: expected " + attribute.Value + ", read " + actual);
                } else Set(target, property, attribute.Value);
            }
        }
        public JsonObject Run()
        {
            var parsed = ScreenHtml.Parse(source);
            var nodes = parsed.Children.Where(n => !n.IsText || !string.IsNullOrWhiteSpace(n.Text)).ToList();
            if (nodes.Count != 1 || nodes[0].Tag is not ("screen" or "block")) throw new FormatException("Traditional html needs one screen or block document.");
            var top = nodes[0];
            adaptation = TraditionalDocumentRules.Adapt(top);
            Check(top);
            var name = top.Get("name") ?? "";
            if (!Regex.IsMatch(name, @"^[A-Za-z_][A-Za-z0-9_]*$")) problems.Add(new(ScreenDocument.Traditional, top.Line, top.Column, "A screen or block needs a valid name.", TraditionalDocumentRules.Supported));
            if (problems.Count > 0) throw ScreenDocument.Refusal(problems, source, "/html");
            var flow = (IObjectSignature)s.Resolve("IWebFlow:" + (top.Get("flow") ?? "MainFlow"));
            var kind = top.Tag == "screen" ? "IWebScreen" : "IWebBlock";
            // A root of this name made by this job before its document (a shell an earlier document named, or a create op of the
            // job, still without content) is filled; any other existing root is the reading's to edit.
            IObjectSignature? reused = null;
            if (flow.Children.OfType<IObjectSignature>().FirstOrDefault(c => string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase)) is { } existing) {
                var shell = s._traditionalShells.TryGetValue(top.Tag + ":" + name, out var made) && ReferenceEquals(made, existing);
                if (!(Implements(existing, kind) && (shell || s._creators.ContainsKey(existing) && !existing.GetAllDescendantsOfType<IObjectSignature>().Any(w => Implements(w, "IWidget") && !Implements(w, "IWebBlockInstanceWidget") && !Implements(w, "IPlaceholderContentWidget")))))
                    throw new KernelRefusalException(ScreenDocument.RootExists, "Traditional document creates a new root; '" + name + "' already exists. Read ssam_map view html and edit with k and basedOn.");
                reused = existing;
            }
            var reusedChildren = reused == null ? [] : reused.Children.OfType<IObjectSignature>().ToList();
            try {
                root = reused ?? Create(flow, kind, name);
                if (reused != null) { s.Anchor(root); written.Add(new JsonObject { ["type"] = "filled:" + kind, ["key"] = root.ObjectKey!.ToString(), ["name"] = name }); }
                Keyed(top, root);
                if (top.Get("description") is { } description) Set(root, "Description", description);
                if (top.Get("title") is { } title) TextValue(root, "Title", title);
                if (top.Get("roles") is { } roles) s.SetCore(root, new JsonObject { ["op"] = "set", ["target"] = "@" + root.ObjectKey, ["prop"] = "Roles",
                    ["value"] = new JsonArray(roles.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(r => (JsonNode)("IRole:" + r)).ToArray()) });
                foreach (var node in top.Children.Where(Data)) {
                    var dataKind = node.Tag == "var" ? "ILocalVariable" : "IInputParameter";
                    var dataType = node.Get("type") ?? "Text";
                    // An input the shell already made for this document keeps its type and mandatory (written from this same text).
                    var data = reusedChildren.FirstOrDefault(c => Implements(c, dataKind) && string.Equals(TypeResolver.Name(c), node.Get("name"), StringComparison.Ordinal));
                    if (data == null) {
                        data = Create(root, dataKind, node.Get("name"));
                        // The canonical reader qualifies native basic types.
                        Set(data, "DataType", dataType.StartsWith("BasicType:", StringComparison.Ordinal) ? dataType[10..] : dataType);
                        if (node.Tag == "input") Set(data, "IsMandatory", node.Get("mandatory") ?? "False");
                    }
                    Keyed(node, data);
                    if (node.Get("default") is { } value) Set(data, "DefaultValue", value);
                    if (node.Get("description") is { } why) Set(data, "Description", why);
                }
                NativeProperties(root, top);
                options.BeforeContent?.Invoke(root);
                var declared = options.DeclaredBy?.Invoke(root.GetInterface()?.Name ?? "", name) ?? [];
                foreach (var action in (top.Get("actions") ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                    if (!root.Children.OfType<IObjectSignature>().Any(c => Implements(c, "IScreenAction") && TypeResolver.Name(c) == action)
                        && !(action == "Preparation" && (declared.Contains(action) || root.Children.OfType<IObjectSignature>().Any(c => Implements(c, "IPreparation")))))
                        throw new KernelRefusalException(ScreenDocument.NameUnknown, "Declare action " + name + "." + action + " in a logic op of the same job.");
                var css = string.Join("\n", All(top).Where(n => n.Tag == "style").Select(n => string.Concat(n.Children.Select(c => c.Text))));
                if (options.Css != null) css += "\n" + options.Css;
                displayed = TraditionalDocumentRules.DisplayedClasses(css);
                IObjectSignature host = root;
                if (top.Tag == "screen" && root.Children.OfType<IObjectSignature>().FirstOrDefault(c => Implements(c, "IWebBlockInstanceWidget")) is { } defaultLayout) {
                    var visual = top.Children.Where(n => !Data(n) && n.Tag != "style" && !(n.IsText && string.IsNullOrWhiteSpace(n.Text)) && !n.Tag.StartsWith("os-", StringComparison.Ordinal)).ToList();
                    // C-28 (F-FT-17): layout="blank" is the screen without the template's layout (no header, no 1280 px
                    // main-content): its content at the root, as with a document that names its own layout block.
                    if (visual.Count == 0 || top.Children.Any(n => n.Tag == "Block") || top.Get("layout") == "blank")
                        defaultLayout.Delete(); // The document supplies the shell (or has none); do not nest it inside the template shell.
                    else host = At(root, "/#IWebBlockInstanceWidget/MainContent");
                }
                Children(host, top.Children.Where(n => !Data(n)).ToList());
                // A label names its input by the input's name, which may come later in the document.
                foreach (var (label, forName) in labels) {
                    var targets = root.GetAllDescendantsOfType<IObjectSignature>().Where(w => Implements(w, "IWidget") && TypeResolver.Name(w) == forName).ToList();
                    if (targets.Count != 1) { var at = All(top).FirstOrDefault(n => n.Tag == "label" && n.Get("for") == forName) ?? top; problems.Add(new(ScreenDocument.NameUnknown, at.Line, at.Column, "label for=\"" + forName + "\" names " + targets.Count + " widgets of " + name + "; give the input that id.", "give the input id=\"" + forName + "\"")); continue; }
                    Set(label, "TargetWidget", "@" + targets[0].ObjectKey);
                }
                Set(root, "StyleSheet", css);
                if (ThemeCss.Of(root)?.EffectiveValue?.Replace("\r\n", "\n") != css.Replace("\r\n", "\n"))
                    throw new InvalidOperationException("Traditional document stylesheet readback mismatch.");
                // C-21: every element that failed (Guarded), at its line, in one refusal (the root goes with it).
                if (problems.Count > 0) throw ScreenDocument.Refusal(problems, source, "/html");
                // Entry is the Traditional navigation mechanism. Keep an existing entry/default intact.
                if (top.Tag == "screen" && !((IObjectSignature)s._espace).GetAllDescendantsOfType<IObjectSignature>().Any(c => Implements(c, "IEntry"))) {
                    entry = Create(flow, "IEntry", name + "Entry");
                    s.Link(new JsonObject { ["op"] = "link", ["from"] = "@" + entry.ObjectKey, ["to"] = "@" + root.ObjectKey });
                    Set(entry, "IsDefault", "True");
                }
                var answer = new JsonObject { ["form"] = "ssam-html/1", ["context"] = "Traditional", ["root"] = name,
                    ["key"] = root.ObjectKey!.ToString(), ["created"] = written, ["keys"] = keys, ["entryCreated"] = entry != null,
                    ["editing"] = "Read existing Traditional roots with ssam_map view html; edit with k and basedOn. Document creation refuses a duplicate root." };
                // F5: what the document wrote as another Traditional widget, and what that widget cannot keep, never in silence.
                if (adaptation.Receipt() is { } migration) answer["migration"] = migration;
                // C-48: a List Records whose line count is an expression fetches start-index + line-count + 1 rows.
                if (TraditionalDocumentRules.Paging(top).ToList() is { Count: > 0 } paging)
                    answer["warnings"] = new JsonArray(paging.Select(p => (JsonNode)new JsonObject { ["code"] = p.Code, ["line"] = p.Line, ["column"] = p.Column, ["message"] = p.Message, ["fix"] = p.Fix }).ToArray());
                return answer;
            }
            catch {
                entry?.Delete();
                // A root this job made before its document (a shell other documents link to) stays, emptied of what this
                // document wrote: the links to it keep their destination and the refusal stays this document's.
                if (reused != null) foreach (var child in reused.Children.OfType<IObjectSignature>().Where(c => !reusedChildren.Contains(c)).ToList()) child.Delete();
                else root?.Delete();
                throw;
            }
        }
        private static IEnumerable<ScreenHtml.Node> All(ScreenHtml.Node node) { yield return node; foreach (var child in node.Children) foreach (var n in All(child)) yield return n; }
        // The original of an os-opaque element of the reading, moved under the host by the platform (its subtree and its
        // consumers follow): the recreation keeps what the language has no row for. Checked before anything is written.
        private void MoveOpaque(IObjectSignature host, ScreenHtml.Node node)
        {
            var k = node.Get("k") ?? "";
            var original = k.Length > 0 && options.MoveOpaque ? options.Opaque?.Invoke(k) : null;
            if (original == null) throw new KernelRefusalException(ScreenDocument.OpaqueTouched, "<os-opaque kind=\"" + node.Get("kind") + "\"> is a widget the Traditional document cannot create; keep it where the reading put it (edit by k and basedOn).");
            var moved = (IObjectSignature)StudioAdapter.Runtime.MoveObject((IObject)original, (IObject)host);
            keys[k] = moved.ObjectKey!.ToString();
            written.Add(new JsonObject { ["type"] = "moved:" + node.Get("kind"), ["key"] = moved.ObjectKey!.ToString(), ["name"] = TypeResolver.Name(moved) });
        }
        private void Children(IObjectSignature host, List<ScreenHtml.Node> nodes)
        {
            for (var i = 0; i < nodes.Count; i++) {
                var node = nodes[i];
                if (node.IsText) {
                    var afterInline = i > 0 && ScreenHtml.Inline(nodes[i - 1]);
                    var beforeInline = i + 1 < nodes.Count && ScreenHtml.Inline(nodes[i + 1]);
                    if (!string.IsNullOrWhiteSpace(node.Text)) Text(host, node.Text!, afterInline, beforeInline);
                    else if (TraditionalDocumentRules.LiteralRun(node.Text!, afterInline, beforeInline) is { } space) Set(Create(host, WebText), "Text", space);
                    continue;
                }
                if (node.Tag == "style") continue;
                if (node.Get("if") is { } condition && node.Tag != "div") {
                    // A condition on another widget is the If around it, the widget alone in its true branch (F5).
                    var guard = Create(host, "OutSystems.Model.UI.Web.Widgets.IIfWidget"); Set(guard, "Condition", condition);
                    Element(At(guard, "/TrueBranch"), Without(node, "if"));
                    var after = i + 1; while (after < nodes.Count && nodes[after].IsText && string.IsNullOrWhiteSpace(nodes[after].Text)) after++;
                    if (after < nodes.Count && nodes[after].Get("else") != null) {
                        var otherwise = nodes[after];
                        if (otherwise.Tag == "div" && otherwise.Attributes.All(a => a.Key is "else" or "k")) Children(At(guard, "/FalseBranch"), otherwise.Children);
                        else Element(At(guard, "/FalseBranch"), Without(otherwise, "else"));
                        i = after;
                    }
                }
                else if (node.Get("if") is { } divCondition) {
                    var branch = Create(host, "OutSystems.Model.UI.Web.Widgets.IIfWidget", node.Get("id")); Set(branch, "Condition", divCondition);
                    Keyed(node, branch);
                    NativeProperties(branch,node);
                    if (node.Get("style") is { } style) Set(branch,"CustomStyle",style);
                    var yes = At(branch,"/TrueBranch");
                    // div if is the native branch, exactly as the reader prints it.
                    // A requested class needs a visual container inside that branch.
                    if (node.Get("class") is { } classes) { yes = Create(yes,"IContainerWidget"); Set(yes,"StyleClasses",classes); }
                    Children(yes, node.Children);
                    var next = i + 1; while (next < nodes.Count && nodes[next].IsText && string.IsNullOrWhiteSpace(nodes[next].Text)) next++;
                    if (next < nodes.Count && nodes[next].Get("else") != null) {
                        var otherwise=nodes[next]; var no=At(branch,"/FalseBranch");
                        if (otherwise.Attributes.Any(a=>a.Key!="else")) Element(no,Without(otherwise,"else"));
                        else Children(no,otherwise.Children);
                        i=next;
                    }
                } else if (node.Get("else") != null) Guarded(node, () => throw new FormatException("Traditional else must follow div if."));
                else Guarded(node, () => Element(host, node));
            }
        }
        private static ScreenHtml.Node Without(ScreenHtml.Node node, string attribute) => new() { Tag = node.Tag, Line = node.Line, Column = node.Column,
            Attributes = node.Attributes.Where(a => a.Key != attribute).ToList(), Children = node.Children };
        private void Text(IObjectSignature host, string text, bool afterInline, bool beforeInline)
        {
            var value = ScreenHtml.Run(text, out var expression, out _);
            if (!expression) value = TraditionalDocumentRules.LiteralRun(text, afterInline, beforeInline)!;
            var item = Create(host, expression ? "IExpressionWidget" : WebText);
            Set(item, expression ? "Value" : "Text", value);
        }
        // The lists an element opens (C-03) close with it, whatever it throws.
        private void Element(IObjectSignature host, ScreenHtml.Node node)
        {
            var depth = rowsOf.Count;
            try { ElementCore(host, node); }
            finally { rowsOf.RemoveRange(depth, rowsOf.Count - depth); }
        }
        private void ElementCore(IObjectSignature host, ScreenHtml.Node node)
        {
            if (node.Tag == "os-opaque" || node.Tag.StartsWith("os-", StringComparison.Ordinal)) { MoveOpaque(host, node); return; }
            if (node.Get("list") is { } list) {
                var rows = Create(host, "IListRecordsWidget", "Rows" + ++sequence); Set(rows, "SourceRecordList", list);
                if (node.Get("line-separator") is { } rowsSeparator) Set(rows, "LineSeparator", rowsSeparator);
                rowsOf.Add((list, ListName(rows, "Rows")));
                host = rows;
            }
            if (node.Tag == "slot") {
                var slot = At(host, "/" + node.Get("name"));
                Keyed(node, slot);
                // An explicitly supplied slot replaces sample content; omitted slots retain the official defaults.
                foreach (var child in slot.Children.OfType<IWidget>().ToArray()) child.Delete();
                Children(slot, node.Children); return;
            }
            var type = Types[node.Tag];
            // The installed Model API exposes Method/Validation on ILinkOnClick only.
            // Explicit event policy uses that native widget, with button styling when requested.
            var policyLink = node.Tag == "button" && (node.Get("method") != null || node.Get("validation") != null || node.Get("os-onclick.Method") != null);
            if (policyLink) type = "ILinkWidget";
            if (node.Tag == "input" && node.Get("type") == "checkbox") type = "ICheckBoxWidget";
            else if (node.Tag == "input" && node.Get("type") == "password") type = "IInputPasswordWidget";
            else if (node.Tag == "input" && node.Get("type") == "radio") type = "IRadioButtonWidget";
            var item = Create(host, type, node.Get("id") ?? (node.Tag == "Block" ? null : node.Get("name")));
            Keyed(node, item);
            // C-23: an href of a new link the normalization could not write as its On Click (LINK_HREF_REWRITTEN: beside an onclick,
            // an anchor of no element, a placeholder with no click) is refused with its fix, never an extended property the
            // runtime drops; beside an onclick the patch drops it.
            if (node.Tag == "a" && node.Get("k") == null && node.Get("href") is { } href)
                problems.Add(new(Preflight.ExternalLinks.Unsupported, node.Line, node.Column, Preflight.ExternalLinks.Message(href, node.Get("onclick") != null),
                    Preflight.ExternalLinks.Fix(href, node.Get("onclick") != null, true, Preflight.ExternalLinks.TraditionalSite),
                    Correct: node.Get("onclick") != null ? new ScreenDocument.RemoveAttribute("href") : null));
            if (node.Get("class") is { } classes) Set(item, FindProperty(item, "StyleClasses") != null ? "StyleClasses" : "Style", classes);
            if (policyLink) Set(item, "StyleClasses", "Button " + (node.Get("class") ?? ""));
            if (node.Get("style") is { } style) Set(item, "CustomStyle", style);
            // C-08: a span is a Container (a div), inline unless the document's CSS gives one of its classes a display: an inline
            // style would beat that class.
            else if (node.Tag == "span" && !(node.Get("class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Any(displayed.Contains))
                Set(item, "CustomStyle", "display: inline;");
            if (node.Tag == "Block") {
                var blockName = node.Get("name")!;
                if (blockName.Contains(':')) Set(item, "SourceBlock", blockName.StartsWith('I') ? blockName : "I" + blockName);
                else {
                    try { Set(item, "SourceBlock", "IWebBlock:" + blockName); }
                    catch (UnresolvedReferenceException) {
                        try { Set(item, "SourceBlock", "IWebBlockSignature:" + blockName); }
                        // A block a later document of this job creates (F5): its shell now, filled by that document.
                        catch (UnresolvedReferenceException) when (Shell("block", blockName) is { } later) { Set(item, "SourceBlock", "@" + later.ObjectKey); }
                    }
                }
            }
            if (node.Tag == "label" && node.Get("for") is { } forName) labels.Add((item, forName));
            if (node.Tag == "a" && node.Get("title") is { } linkTitle) Set(item, "Title", Expression(linkTitle)); // ILinkWidget.Title is an expression
            if (node.Tag is "table-records" or "list-records") {
                if (node.Get("source") is { } records) Set(item, "SourceRecordList", records);
                if (node.Get("line-count") is { } lines) Set(item, "LineCount", lines);
                if (node.Get("start-index") is { } start) Set(item, "StartIndex", start);
                if (node.Tag == "list-records" && node.Get("line-separator") is { } separator) Set(item, "LineSeparator", separator);
                // its rows (the elements written inside it) read the row clicked through it (C-03)
                if (node.Get("source") is { } rowsSource) rowsOf.Add((rowsSource, ListName(item, node.Tag == "list-records" ? "ListRecords" : "TableRecords")));
            }
            if (node.Get("bind") is { } bind) Set(item, "Variable", bind);
            if (node.Get("enabled") is { } enabled) Set(item, "Enabled", enabled);
            if (node.Tag == "form") {
                if (node.Get("record") is { } record) Set(item, "SourceRecord", record);
                if (node.Get("editable") is { } editable) Set(item, "IsEditable", editable);
            }
            if (node.Tag == "select") {
                if (node.Get("options") is { } options) Set(item, "SourceRecordList", options);
                if (node.Get("source-entity") is { } entity) Set(item, "SourceEntity", entity);
                if (node.Get("source-attribute") is { } attribute) Set(item, "SourceAttribute", attribute);
                if (node.Get("label") is { } labelColumn) ComboColumn(item, labelColumn, false, node.Get("options"));
                if (node.Get("value") is { } valueColumn) ComboColumn(item, valueColumn, true, node.Get("options"));
                if (node.Get("empty") is { } empty) {
                    var caption = empty.StartsWith('"') && empty.EndsWith('"') ? empty[1..^1].Replace("\"\"", "\"") : empty;
                    var add = ModelApiMetadata.Methods(item.GetType()).Single(m=>m.Name == "AddSpecialValue");
                    add.Invoke(item, [caption, node.Get("empty-value") ?? "0"]);
                }
                if (node.Get("required") is { } requiredChoice) Set(item, "IsMandatory", requiredChoice.Length == 0 ? "True" : requiredChoice);
            }
            if (node.Tag == "upload" && node.Get("required") is { } uploadRequired) Set(item, "Mandatory", uploadRequired.Length == 0 ? "True" : uploadRequired);
            if (node.Tag == "expr") {
                Set(item, "Value", node.Get("value")!);
                if (node.Get("example") is { } example) TextValue(item, "Example", example);
            }
            else if (node.Tag != "select" && node.Get("value") is { } radioValue) {
                if (type != "IRadioButtonWidget") throw new KernelRefusalException(ScreenDocument.Traditional, "value requires a Traditional radio input; use bind for editable values.");
                Set(item, "Value", radioValue);
            }
            if (node.Get("onchange") is { } onChange) {
                ScreenHtml.TryCall(onChange, out var actionName, out var arguments);
                var target = Owned(actionName, "onchange");
                if (!Implements(target, "IScreenAction"))
                    throw new KernelRefusalException(ScreenDocument.Traditional, "Traditional onchange requires a screen action of the current screen or block.");
                var handler = At(item, "/OnChange");
                Set(handler, "Destination", "@" + target.ObjectKey);
                foreach (var (parameter, value) in arguments) Set(At(handler, "/" + parameter), "Value", RowArgument(node, value));
            }
            if (node.Tag is "input" or "textarea" or "checkbox-input" or "password-input" or "radio-input") {
                if (node.Get("placeholder") is { } prompt) TextValue(item, "Prompt", prompt);
                if (node.Get("mandatory") is { } mandatory) Set(item, "Mandatory", mandatory);
                if (node.Get("required") is { } required) Set(item, "Mandatory", required.Length == 0 ? "True" : required);
                if (node.Get("maxlength") is { } maxLength) Set(item, "MaxLength", maxLength);
                if (node.Tag == "textarea") Set(item, "TextLines", node.Get("rows") ?? "4");
                if (node.Get("type") is { } inputType && inputType is not ("text" or "password" or "checkbox" or "radio")) Set(item, "Type", inputType);
            }
            LanguageDefaults(item, node, type);
            if (node.Get("onclick") is { } destination) {
                ScreenHtml.TryCall(destination, out destination, out var arguments);
                IObjectSignature target;
                destination = ExternalSite(destination);
                if (destination.IndexOf(':') is var colon && colon > 0 && destination[..colon] == "ScreenAction") target = Owned(destination[(colon + 1)..], "onclick");
                else if (colon > 0) {
                    var qualified = destination.StartsWith('I') ? destination : "I" + destination;
                    try { target = (IObjectSignature)s.Resolve(qualified); }
                    catch (KeyNotFoundException) when (qualified.StartsWith("IWebScreen:", StringComparison.Ordinal) && Shell("screen", qualified[11..]) is { } later) { target = later; }
                }
                else {
                    try { target = At(root!, "/" + destination); }
                    catch (KeyNotFoundException) {
                        // A screen a later document of this job creates (F5: navigation both ways in one job): its shell now.
                        try { target = (IObjectSignature)s.Resolve("IWebScreen:" + destination); }
                        catch (KeyNotFoundException) when (Shell("screen", destination) is { } later) { target = later; }
                    }
                }
                var click = At(item, "/OnClick"); Set(click, "Destination", "@" + target.ObjectKey);
                foreach (var (parameter, value) in arguments) Set(At(click, "/" + parameter), "Value", RowArgument(node, value));
                var navigation = Implements(target, "IWebScreen") || Implements(target, "IExternalSite");
                var method = node.Get("method") ?? node.Get("os-onclick.Method") ?? (navigation ? "Navigate" : "Submit");
                if (method == "Navigate" && !navigation || method != "Navigate" && navigation)
                    throw new KernelRefusalException(ScreenDocument.Traditional, "Navigate requires a screen/external site; Ajax/Submit require a screen action. Choose method for the destination, not the caption.");
                if (node.Tag == "a" || policyLink) {
                    Set(click, "Method", method);
                    if (node.Get("validation") is { } validation) Set(click, "Validation", validation);
                }
            }
            if (node.Tag == "Block") foreach (var attribute in node.Attributes) {
                if (attribute.Key.StartsWith(':')) Set(At(item, "/" + attribute.Key[1..]), "Value", attribute.Value);
                else if (attribute.Key.StartsWith('@') || attribute.Key == "onnotify") {
                    ScreenHtml.TryCall(attribute.Value, out var handlerName, out var arguments);
                    var target = Owned(handlerName, attribute.Key);
                    var handler = At(item, "/" + (attribute.Key == "onnotify" ? "OnNotify" : attribute.Key[1..]));
                    Set(handler, attribute.Key == "onnotify" ? "Destination" : "Handler", "@" + target.ObjectKey);
                    foreach (var (parameter, value) in arguments) Set(At(handler, "/" + parameter), "Value", RowArgument(node, value));
                }
            }
            NativeProperties(item, node);
            if (node.Tag == "text") Set(item, "Text", string.Concat(node.Children.Select(c => c.Text)));
            else if (node.Tag == "label") {
                var caption = string.Concat(node.Children.Select(c => c.IsText ? c.Text : string.Concat(c.Children.Select(t=>t.Text))));
                // A caption with {{ }} is the Label's Value (an expression); a literal one its Text (9a7b8588: label values lost).
                // The runtime shows Value (born '"label"'): a literal caption is its Text and the same text as Value.
                if (node.Children.All(c => c.IsText) && ScreenHtml.HasBinding(caption)) Set(item, "Value", Expression(caption.Trim()));
                else if (caption.Trim().Length > 0 || node.Get("os-Text") == null && node.Get("os-Value") == null) {
                    TextValue(item, "Text", caption.Trim());
                    if (node.Get("os-Value") == null) Set(item, "Value", Expression(caption.Trim()));
                }
            }
            else if (node.Tag == "expr") { }
            else if (node.Tag == "button" && !policyLink) { var caption = string.Concat(node.Children.Select(c => c.Text)); if (caption.Length > 0 || node.Get("os-Label") == null) TextValue(item, "Label", caption); }
            else if (node.Tag == "table-records" && node.Children.Any(c => c.Tag == "tr")) {
                var rows = node.Children.Where(c => !c.IsText || !string.IsNullOrWhiteSpace(c.Text)).ToList();
                if (rows.Count != 2 || rows.Any(c => c.Tag != "tr"))
                    throw new KernelRefusalException(ScreenDocument.Traditional,"Canonical table-records requires HeaderRow then DataRow as exactly two tr elements.");
                for (var i=0;i<2;i++) {
                    var row = At(item, i == 0 ? "/HeaderRow" : "/DataRow");
                    Keyed(rows[i], row);
                    foreach (var child in row.Children.OfType<IWidget>().ToArray()) child.Delete();
                    if (rows[i].Get("id") is { } id) Set(row,"Name",id);
                    if (rows[i].Get("class") is { } rowClasses) Set(row,"StyleClasses",rowClasses);
                    if (rows[i].Get("style") is { } rowStyle) Set(row,"CustomStyle",rowStyle);
                    NativeProperties(row,rows[i]); Children(row,rows[i].Children);
                }
            } else Children(item, node.Children);
        }
    }
}
