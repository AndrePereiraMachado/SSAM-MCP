using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Reading;
namespace Anvil.Core;

/// <summary>Ops to apply, the compilation report and, when the page carries a stylesheet, the CSS scoped to the page root.</summary>
public sealed record HtmlCompilation(List<JsonObject> Ops, JsonObject Report, string? ScopedCss, string ScopeClass);

/// <summary>An action a logic op of the same job declares, as the html page op sees it (H2, H10 of docs/PROTOTIPO-NATIVO.md):
/// its name, kind (server, service, client, screen), owner (@espace or the screen), inputs and the op that declares it.
/// Flow: declared by a flow text (ssam-flow/1, a header with its owner and no @key: "action Home.Save"); its owner is written
/// as the text writes it (the screen's name, or Flow/Name).</summary>
public sealed record HtmlJobAction(string Name, string Kind, string Owner, IReadOnlyList<UiParam> Inputs, IReadOnlyList<UiParam> Outputs, int Op, bool Flow = false);

/// <summary>The job around an html page op: its index and the actions its logic ops declare (before or after it).</summary>
public sealed record HtmlJob(int Op, IReadOnlyList<HtmlJobAction> Actions)
{
    /// <summary>The actions of every logic op of <paramref name="ops"/>; null without ops.</summary>
    public static HtmlJob? From(JsonArray? ops, int htmlOp)
    {
        if (ops == null) return null;
        var actions = new List<HtmlJobAction>();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"]?["actions"] is not JsonArray declared) continue;
            foreach (var action in declared.OfType<JsonObject>())
            {
                if (action["name"] is not JsonValue nameValue || !nameValue.TryGetValue<string>(out var name) || name.Length == 0) continue;
                var kind = (action["kind"] is JsonValue k && k.TryGetValue<string>(out var text) ? text : "server").ToLowerInvariant();
                var owner = action["owner"] is JsonValue o && o.TryGetValue<string>(out var ownerText) ? ownerText : "@espace";
                actions.Add(new(name, kind, owner, Params(action["inputs"], true), Params(action["outputs"], false), i));
            }
        }
        return new HtmlJob(htmlOp, actions);
    }

    /// <summary>The screen, block and data actions the flow texts of the job's logic ops create (a header that names its owner,
    /// without @key: "action Home.Save", "data action Home.GetOrders"), as the document form sees them: name, kind (screen or
    /// data), owner as the text writes it, inputs and outputs, and the op. A text that does not read is the logic op's own
    /// problem (FLOW_SYNTAX), never this list's.</summary>
    public static IReadOnlyList<HtmlJobAction> FlowActions(JsonArray? ops)
    {
        var actions = new List<HtmlJobAction>();
        if (ops == null) return actions;
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data || !data.ContainsKey("flow")) continue;
            List<(string Text, string? BasedOn, string Pointer)> texts;
            try { texts = FlowTextForm.Texts(data); } catch (Exception) { continue; }
            foreach (var (text, _, _) in texts)
            {
                Anvil.Reading.FlowItem item;
                try { item = Anvil.Reading.ModuleFlow.Read(text); } catch (FormatException) { continue; }
                if (item.Key.Length > 0 || item.Owner.Length == 0 || !Anvil.Reading.FlowOwners.Owned(item.Kind)) continue;
                static UiParam Param(Anvil.Reading.FlowItem p) => new(p.Name, p.Prop("DataType") ?? "Text", p.Role == "in" && p.Prop("IsMandatory") != "False", p.Prop("DefaultValue"), null);
                actions.Add(new(item.Name, item.Kind switch { "DataAction" => "data", "Preparation" => "preparation", _ => "screen" }, item.Owner,
                    item.Items.Where(p => p.Role == "in").Select(Param).ToArray(), item.Items.Where(p => p.Role == "out").Select(Param).ToArray(), i, Flow: true));
            }
        }
        return actions;
    }

    private static UiParam[] Params(JsonNode? node, bool inputs) => (node as JsonArray ?? new JsonArray()).OfType<JsonObject>()
        .Where(p => p["name"] is JsonValue)
        .Select(p => new UiParam(p["name"]!.ToString(), p["type"]?.ToString() ?? "Text", inputs && (p["mandatory"] is not JsonValue m || !m.TryGetValue<bool>(out var flag) || flag),
            p["default"]?.ToString(), null)).ToArray();
}

/// <summary>
/// Compiles an authored HTML/CSS page plus a small typed binding manifest into the existing verbs. The page keeps its tags,
/// order, classes and attributes; which widget each element becomes is the one table of the html op and of the prototype
/// importer (<see cref="ElementWidgetMap"/>): Container for div, HTML Element for the other tags of the platform, Expression for
/// text. Data, filters, events and client functions come only from the closed manifest keyed by data-av attributes.
/// Every problem of the page comes out at once, in one coded refusal (H1): the checks run per element, per key and per CSS
/// statement, and the problem of one element never hides the next check nor the elements inside it. The structure is proved
/// without a module (H2): the preflight runs the same widget pass with an empty scope and checks call against the logic ops
/// of the job. Capabilities without a proven translation are refused with the source line and column instead of being
/// approximated (nothing is dropped silently: a visible binding is a native If widget around any element, a label keeps its
/// children, the children of a link or button are its child widgets). The CSS is rewritten under the page root class so the
/// theme carries it without leaking into other screens; its @import statements go to the top of the theme.
/// </summary>
public static class HtmlExpander
{
    private static readonly Dictionary<string, string[]> Shapes = new()
    {
        ["data"] = ["screen", "title", "layout", "roles", "html", "css", "stylesheet", "vars", "source", "sources", "search", "filters", "derived", "scripts", "bindings"],
        ["var"] = ["name", "type", "default"],
        ["derived"] = ["name", "type", "source", "output", "max", "sum"],
        ["source"] = ["entity", "action", "as", "where", "sort", "max", "args", "outputs", "state", "paging"],
        ["paging"] = ["offset", "size", "total", "offsetInput", "sizeInput"],
        ["search"] = ["key", "field", "label", "variable"],
        ["filter"] = ["key", "field", "from", "label", "variable"],
        ["script"] = ["name", "inputs", "outputs", "code"],
        ["param"] = ["name", "type"],
        ["text"] = ["kind", "value"], ["field"] = ["kind", "field"], ["list"] = ["kind", "source", "output"], ["visible"] = ["kind", "condition"],
        ["style"] = ["kind", "value"], ["class"] = ["kind", "value"], ["date"] = ["kind", "variable", "format"],
        ["navigate"] = ["kind", "destination", "args"], ["call"] = ["kind", "action", "args"], ["refresh"] = ["kind", "sources"],
        ["page"] = ["kind", "source", "direction"],
        ["block"] = ["kind", "block", "args"],
    };
    private static readonly string[] Kinds = ["text", "field", "list", "visible", "style", "class", "date", "navigate", "call", "refresh", "page", "block"];
    private static readonly string[] ClickKinds = ["navigate", "call", "refresh", "page"];
    private static readonly string[] StylesheetModes = ["theme", "none"];
    private static readonly HashSet<string> TextTags = new(StringComparer.Ordinal) { "div", "li", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "b", "em", "i", "small", "code", "td", "th", "label", "a", "button", "dt", "dd", "caption", "legend", "summary", "mark", "q", "s", "u", "sub", "sup", "time", "abbr", "cite", "kbd", "samp", "var", "del", "ins", "pre", "blockquote", "address", "output" };
    private static readonly HashSet<string> Repeaters = new(StringComparer.Ordinal) { "div", "ul", "ol", "section" };
    private static readonly HashSet<string> Transparent = new(StringComparer.Ordinal) { "html", "head", "body" };
    private static readonly HashSet<string> Ignored = new(StringComparer.Ordinal) { "meta", "title", "style" };
    // What the page form does not bind (the fragment form or the importer does): refused with the way that compiles it.
    private static readonly Dictionary<string, string> Unsupported = new(StringComparer.Ordinal)
    {
        ["script"] = "inline scripts are not compiled; declare client functions in data.scripts and call them from binding expressions",
        ["link"] = "external stylesheets are not compiled; put the CSS in a <style> block or in data.css",
        ["form"] = "forms need the native validation/submit integration, which this version does not provide",
        ["dialog"] = "dialogs are not compiled; navigate to an existing screen instead",
        ["textarea"] = "text areas are not bound by this version",
        ["img"] = "images are not compiled by this version", ["svg"] = "inline SVG is not compiled by this version",
        ["iframe"] = "iframes are not compiled", ["video"] = "media is not compiled", ["audio"] = "media is not compiled",
    };
    /// <summary>Roles of a screen the page creates without data.roles: authenticated users only, as the component path does
    /// (HtmlComponents); a page open to anyone says roles:["Anonymous"].</summary>
    public static readonly string[] DefaultRoles = ["Registered"];

    // The problem codes of the page form (H15): each with its own fix, and a patch when one correction is certain.
    internal const string Invalid = "HTML_INVALID";
    internal const string TagNotAllowed = "HTML_TAG_NOT_ALLOWED";
    internal const string AttributeScript = "HTML_ATTRIBUTE_SCRIPT";
    internal const string KeyUnbound = "HTML_KEY_UNBOUND";
    internal const string BindingOrphan = "HTML_BINDING_ORPHAN";
    internal const string BindingInvalid = "HTML_BINDING_INVALID";
    internal const string KindTag = "HTML_KIND_TAG";
    internal const string ControlDead = "HTML_CONTROL_DEAD";
    internal const string ContentEmpty = "HTML_CONTENT_EMPTY";
    internal const string CallOtherScreen = "HTML_CALL_OTHER_SCREEN";
    internal const string ReferenceUnresolved = "HTML_REFERENCE_UNRESOLVED";
    internal const string IdDuplicate = "HTML_ID_DUPLICATE";
    internal const string CssInvalid = "HTML_CSS_INVALID";
    internal const string CssIdSelector = "HTML_CSS_ID_SELECTOR";
    internal const string ListTemplate = "HTML_LIST_TEMPLATE";
    internal const string ArgumentInvalid = "HTML_ARGUMENT_INVALID";

    // The fragment form of the html op ({"op":"html","parent":...}, HtmlVisual) already compiles what the page form refuses below:
    // the refusal carries that exact syntax (HtmlVisualVocabulary.json) instead of a dead end. Single quotes keep it valid inside JSON.
    // value and label are evaluated per element of the options list, where only the element's attributes are names (an
    // aggregate's element is read as Entity.Attribute, a list of records as Attribute): never List.Current, which the Verify
    // cannot identify there (PreflightRules.DropdownItemScopeRules, proved on Haiku_UI 2026-10-11).
    internal const string FragmentSelect = "<select bind='Var' options='GetItems.List' value='Item.Id' label='Item.Label'/>";
    internal const string SelectScopeNote = " In a <select>, value and label read the element of the options list by its attributes (Item.Id for an aggregate over Item, Id for a list variable of records), never List.Current.";
    internal const string FragmentList = "<div list='Source.List' as='Row'><div>{{ Row.X.Name }}<div list='Row.X.Items' as='Item'>{{ Item.Name }}</div></div></div>";

    /// <summary>The contract of the page form, rules included (H16): kinds and the tags each binds, the tags of the platform,
    /// the attributes, the names, the stylesheet and what call reaches.</summary>
    public static JsonObject Schema() => new()
    {
        ["kinds"] = new JsonArray(Kinds.Select(k => (JsonNode)k).ToArray()),
        ["shapes"] = new JsonObject(Shapes.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)new JsonArray(p.Value.Select(k => (JsonNode)k).ToArray())))),
        ["tags"] = new JsonArray(ElementWidgetMap.Tags(ElementWidgetMap.CurrentPlatform).Where(t => !Unsupported.ContainsKey(t)).Append("br").Order(StringComparer.Ordinal).Select(t => (JsonNode)t).ToArray()),
        ["kindTags"] = new JsonObject
        {
            ["text"] = "an element without child elements whose whole content is the expression (" + string.Join(", ", TextTags.Order(StringComparer.Ordinal)) + ")",
            ["field"] = "as text, inside an element bound with kind list",
            ["list"] = "div, ul, ol, section with one child element as the row template, or a table with one thead row and one tbody template row; source names a declared source or {\"variable\": \"<List variable of vars>\"}",
            ["visible"] = "any element: a native If widget takes its place and the element is born in the True branch (never the Visible property)",
            ["navigate|call|refresh|page"] = "a (Link) or button (Button) with native OnClick; any other element stays an HTML Element of its own tag with an onclick event",
            ["search"] = "input type text or search", ["filter"] = "select over a static entity", ["date"] = "input type=\"date\"",
            ["block"] = "an empty div", ["class|style"] = "any element: the expression joins the static attribute",
        },
        ["platformTags"] = new JsonObject
        {
            ["o11"] = new JsonArray(ElementWidgetMap.O11Tags.Select(t => (JsonNode)t).ToArray()),
            ["odc"] = new JsonArray(ElementWidgetMap.OdcTags.Select(t => (JsonNode)t).ToArray()),
            ["substituted"] = "br: an empty Container; main (ODC), search, menuitem, custom elements: a div with the class ssam-tag-<tag> (main keeps role=main); data, picture (ODC): a span",
        },
        ["unsupported"] = new JsonObject(Unsupported.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
        ["attributes"] = new JsonArray(ElementWidgetMap.LegacyAttributes.Order(StringComparer.Ordinal).Select(a => (JsonNode)a).ToArray()),
        ["extendedAttributes"] = "any other attribute (tabindex, name, min, max, step, minlength, form, aria-*, data-* ...) is an IExtendedProperty with its literal value; disabled is Enabled = False on a control; inline JavaScript (on*) is refused: bind the element instead",
        ["names"] = "a data-av key in PascalCase (fv.284 -> Fv284; a key repeated on N elements is the same binding on each: Fv284, Fv284_2 ...); an element without data-av takes its id (header-search -> header_search); otherwise none",
        ["call"] = "a server, service or client action of the module or declared by a logic op before this op, or a screen action of this screen declared by a logic op of the same job (the page creates it first, the logic op fills its body)",
        ["paging"] = "action source: {offset:screenVariable,size:1..100,total:integerOutput,offsetInput:'StartIndex',sizeInput:'MaxRecords'}. Input names may be overridden and must be integer inputs of the source action. Refresh passes the real offset and size. An advancing counter alone is not proof; browser acceptance requires expected records for first/next/last.",
        ["state"] = "action source: state:{assign:{screenVariable:sourceOutput}} applies screen state in a typed OnAfterFetch screen action only after FetchSucceeded. Output name collisions are renamed and references rewritten. Derived values share that handler; failure preserves previous screen state.",
        ["stylesheet"] = new JsonArray(StylesheetModes.Select(m => (JsonNode)m).ToArray()),
        ["css"] = "scoped under the page root class; @import statements go to the top of the theme (cssImportsHoisted); #id selectors are refused (OutSystems reserves the id attribute)",
        ["layout"] = new JsonArray("theme", "blank"),
        // The document form (B1 of the plan "Texto do SSAM"): one whole <screen> or <block> in ssam-html/1.
        ["document"] = ScreenDocument.Schema(),
    };

    /// <param name="existing">Description of the screen when it already exists (variables by name and type); null for a new screen.
    /// The caller has already removed the presentation and the screen logic it regenerates.</param>
    /// <param name="job">The job around the op: call reaches the screen actions of this screen its logic ops declare (H10).</param>
    public static HtmlCompilation Expand(JsonObject data, Func<string[], string?> tryRef, Func<string, ScreenContract?> contract, string runtime, JsonObject? existing = null, HtmlJob? job = null)
    {
        if (runtime is not ("CrossDevice" or "Reactive" or "Mobile")) throw Error("only Reactive and Mobile screens are supported");
        Keys(data, "data");
        return new Compiler(data, tryRef, contract, runtime == "Mobile", existing, names: true, job).Run();
    }

    /// <summary>What check-job proves without a module (H2): the HTML and CSS parse, the stylesheet respects the id rule, the
    /// manifest has the closed shape, every data-av key matches one binding and the widget pass compiles every element with an
    /// empty scope (call checked against the logic ops of the job). Every problem at once; references, fields and arguments of
    /// the module still need the base.</summary>
    public static JsonObject Preflight(JsonObject data) => Preflight(data, null);

    public static JsonObject Preflight(JsonObject data, HtmlJob? job)
    {
        var (report, refusal) = Analyze(data, job);
        if (refusal != null) throw refusal;
        return report;
    }

    /// <summary>The preflight without throwing: the report (with the rewrites the compilation made) and the refusal of every
    /// problem, or null. JobPreflight reads both, so the warnings come with the refusal in one answer.</summary>
    public static (JsonObject Report, Exception? Refusal) Analyze(JsonObject data, HtmlJob? job)
    {
        Keys(data, "data");
        return new Compiler(data, _ => null, _ => null, false, null, names: false, job).Preflight();
    }

    /// <summary>The widget names a page op creates (data-av keys in PascalCase, repeated keys numbered, ids of elements without
    /// data-av) and the screen: what a later op of the job may name (H13, the skip heuristic of the apply).</summary>
    public static IReadOnlyCollection<string> CreatedNames(JsonObject data)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (data["screen"] is JsonValue screen && screen.TryGetValue<string>(out var screenName)) names.Add(screenName);
        if (data["html"] is not JsonValue html || !html.TryGetValue<string>(out var text)) return names;
        HtmlNode root;
        try { root = HtmlSource.Parse(text); } catch (InvalidOperationException) { return names; }
        var repeats = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var node in root.Descendants().Where(n => !n.IsText))
        {
            if (node.Attribute("data-av") is { Length: > 0 } key && Pascal(key) is { } name)
            {
                var n = repeats[key] = repeats.GetValueOrDefault(key) + 1;
                var widget = n == 1 ? name : Numbered(name, n);
                names.Add(widget); names.Add("If" + widget);
            }
            else if (ElementWidgetMap.NameFromId(node.Attribute("id")) is { } fromId) names.Add(fromId);
        }
        foreach (var v in data["vars"] as JsonArray ?? new JsonArray()) if (v?["name"] is JsonValue variable) names.Add(variable.ToString());
        return names;
    }

    /// <summary>G5 of the UI-Mockup diagnosis (2026-10-11): the OutSystems expressions a page op writes from its manifest, each
    /// with its pointer relative to op.data: the default of a variable; the where, sort and args of a source; of each binding
    /// the value (text, class, style), the condition (visible) and the args (navigate, call, block). The base check reads their
    /// calls (FUNCTION_UNKNOWN) and writes its patch at these pointers. What the compiler quotes itself (title, date format,
    /// labels), the names (fields, sources, actions, destinations) and the JavaScript of data.scripts are not expressions.</summary>
    public static IEnumerable<(string Pointer, string Text)> Expressions(JsonObject data)
    {
        static IEnumerable<(string, string)> Texts(JsonNode? node, string at)
        {
            if (node is JsonValue value && value.TryGetValue<string>(out var text)) yield return (at, text);
            else if (node is JsonArray array)
                for (var i = 0; i < array.Count; i++)
                    if (array[i] is JsonValue item && item.TryGetValue<string>(out var itemText)) yield return (at + "/" + i, itemText);
        }
        static IEnumerable<(string, string)> Args(JsonNode? node, string at)
        {
            if (node is not JsonObject args) yield break;
            foreach (var (key, value) in args)
                if (value is JsonValue v && v.TryGetValue<string>(out var text)) yield return (at + "/" + Escape(key), text);
        }
        if (data["vars"] is JsonArray vars)
            for (var i = 0; i < vars.Count; i++)
                if (vars[i]?["default"] is JsonValue d && d.TryGetValue<string>(out var text)) yield return ($"/vars/{i}/default", text);
        var sources = new List<(string At, JsonObject Source)>();
        if (data["source"] is JsonObject single) sources.Add(("/source", single));
        if (data["sources"] is JsonArray many)
            for (var i = 0; i < many.Count; i++) if (many[i] is JsonObject source) sources.Add(($"/sources/{i}", source));
        foreach (var (at, source) in sources)
        {
            foreach (var site in Texts(source["where"], at + "/where")) yield return site;
            if (source["sort"] is JsonArray sorts)
                for (var j = 0; j < sorts.Count; j++)
                    if (sorts[j] is JsonArray { Count: > 0 } sort && sort[0] is JsonValue e && e.TryGetValue<string>(out var by)) yield return ($"{at}/sort/{j}/0", by);
            foreach (var site in Args(source["args"], at + "/args")) yield return site;
        }
        if (data["bindings"] is not JsonObject bindings) yield break;
        foreach (var (key, node) in bindings)
        {
            if (node is not JsonObject binding) continue;
            var at = "/bindings/" + Escape(key);
            switch (binding["kind"]?.ToString())
            {
                case "text" or "class" or "style":
                    foreach (var site in Texts(binding["value"] as JsonValue, at + "/value")) yield return site;
                    break;
                case "visible":
                    foreach (var site in Texts(binding["condition"] as JsonValue, at + "/condition")) yield return site;
                    break;
                case "navigate" or "call" or "block":
                    foreach (var site in Args(binding["args"], at + "/args")) yield return site;
                    break;
            }
        }
    }

    /// <summary>One warning per class of construction the compiler accepted that the former page form refused (the 9 causes of
    /// the 2026-10-10 refusals, an\html-compiler.md table 2.2), with the count: what the page reads as compiled.</summary>
    public static IEnumerable<(string Code, string Pointer, string Message)> RewriteWarnings(JsonObject report)
    {
        if (report["rewrites"] is not JsonObject r) yield break;
        int Count(string key) => r[key] is JsonValue v && v.TryGetValue<int>(out var n) ? n : r[key] is JsonObject o ? o.Sum(p => p.Value?.GetValue<int>() ?? 0) : 0;
        string Detail(string key) => r[key] is JsonObject o ? " (" + string.Join(", ", o.Select(p => $"{p.Key} {p.Value}")) + ")" : "";
        if (Count("cssImportsHoisted") is var imports and > 0)
            yield return ("CSS_IMPORT_HOISTED", "/css", $"{imports} @import of the page stylesheet go to the top of the theme stylesheet (the browser ignores an @import after a rule)");
        if (Count("sharedKeys") is var shared and > 0)
            yield return ("HTML_KEY_SHARED", "/html", $"{shared} elements repeat the data-av key of another element ({r["sharedKeyCount"]} keys): each gets the same binding, the copies named <Name>2, <Name>3 (Name_2 after a digit)");
        if (Count("sameJobScreenActions") is var actions and > 0)
            yield return ("HTML_SCREEN_ACTION_SAME_JOB", "/bindings", $"{actions} screen actions of this screen called by the page are declared by a logic op of the same job: the page creates them first (name and inputs) and the logic op fills their bodies");
        if (Count("clickableElements") is var clickable and > 0)
            yield return ("HTML_CLICKABLE_ELEMENT", "/html", $"{clickable} elements that are not <a> or <button> have a click binding: each stays an HTML Element of its own tag with an onclick event{Detail("clickableElements")}");
        if (Count("extendedAttributes") + Count("disabledToEnabled") is var attributes and > 0)
            yield return ("HTML_ATTRIBUTE_EXTENDED", "/html", $"{attributes} attributes outside the former closed list are kept: extended properties with their literal value{Detail("extendedAttributes")}"
                + (Count("disabledToEnabled") > 0 ? $", disabled is Enabled = False ({Count("disabledToEnabled")})" : ""));
        if (Count("visibleWrapped") is var visible and > 0)
            yield return ("HTML_VISIBLE_IF", "/html", $"{visible} visible bindings on elements that are not <div> are native If widgets around the element{Detail("visibleWrapped")}");
        if (Count("staticTables") is var tables and > 0)
            yield return ("HTML_TABLE_STATIC", "/html", $"{tables} tables without a list binding are HTML Elements of their own tags (table, thead, tbody, tr, th, td)");
        if (Count("labelsWithChildren") is var labels and > 0)
            yield return ("HTML_LABEL_CHILDREN", "/html", $"{labels} labels around other elements are HTML Elements of tag label with their children ({Count("labelsWithoutText")} without text of their own)");
        if (Count("labelledEmptyControls") is var named and > 0)
            yield return ("HTML_CONTROL_LABELLED", "/html", $"{named} buttons or links without visible content are named by their aria-label or title");
    }

    private sealed record SourceInfo(string As, string Alias, bool IsEntity, string? Entity, Dictionary<string, (string List, string Current, IReadOnlyList<UiParam> Fields)> Lists, bool Open = false);
    private sealed record ListScope(string List, string Current, IReadOnlyList<UiParam> Fields, bool Open = false);
    private sealed record PageProblem(string Code, string Message, string? Fix, string Pointer, JsonArray? Patch, JsonArray? JobPatch);

    /// <summary>A problem of one element, key or statement: the compiler records it and goes on.</summary>
    private sealed class PageException(string code, string message, string? fix, string? pointer = null, JsonArray? patch = null, JsonArray? jobPatch = null) : InvalidOperationException(message)
    {
        public string Code { get; } = code;
        public string? Fix { get; } = fix;
        public string? Pointer { get; } = pointer;
        public JsonArray? Patch { get; } = patch;
        public JsonArray? JobPatch { get; } = jobPatch;
    }

    private sealed class Compiler(JsonObject data, Func<string[], string?> tryRef, Func<string, ScreenContract?> contracts, bool mobile, JsonObject? existing, bool names, HtmlJob? job)
    {
        private readonly string name = Required(data, "screen");
        private readonly List<JsonObject> ops = [];
        private readonly Dictionary<string, JsonObject> bindings = new(StringComparer.Ordinal);
        private readonly Dictionary<string, List<HtmlNode>> keyed = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> idAliases = new(StringComparer.Ordinal);
        private readonly List<(string Label, string Id, HtmlNode Node)> labels = [];
        private readonly Dictionary<string, string> actions = new(StringComparer.Ordinal);
        private readonly HashSet<string> widgetNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> keyNames = new(StringComparer.Ordinal);
        private readonly Dictionary<string, int> keyRepeats = new(StringComparer.Ordinal);
        private readonly Dictionary<HtmlNode, string?> preNamed = new(ReferenceEqualityComparer.Instance);
        private readonly HashSet<HtmlNode> visibleBound = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<string, string> variables = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<SourceInfo> sources = [];
        private readonly Dictionary<string, (string Offset, int Size, string Total)> paging = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> scriptNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> sourceOutputNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, (string Action, string Tail, string End)> stateHandlers = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, (string Alias, HtmlJobAction Action)> shells = new(StringComparer.OrdinalIgnoreCase);
        private readonly Stack<ListScope> listScopes = new();
        private readonly Stack<HtmlNode> clickables = new();
        private readonly List<string> keptVariables = [], createdVariables = [];
        private readonly List<PageProblem> problems = [];
        private readonly List<string> importsHoisted = [];
        private readonly Dictionary<string, int> extendedAttributes = new(StringComparer.Ordinal), visibleWrapped = new(StringComparer.Ordinal), clickableElements = new(StringComparer.Ordinal);
        private int disabledToEnabled, staticTables, labelsWithChildren, labelsWithoutText, labelledEmptyControls;
        private List<string> roles = [];
        private bool anonymous;
        private int counter, lightDark;
        private readonly string platform = ElementWidgetMap.CurrentPlatform;
        private bool Existing => existing != null;

        /// <summary>A refusal of the page with its code and fix, one problem with a pointer relative to op.data (I4).</summary>
        private static InvalidOperationException Coded(string code, string message, string fix, string pointer) => new PageException(code, message, fix, pointer);
        private string Root => Existing ? "IMobileScreen:" + name : "$html." + name;
        private bool BlankLayout => data["layout"]?.ToString() == "blank";
        private string Main => Root + "/#IMobileBlockInstanceWidget/" + (mobile || BlankLayout ? "Content" : "MainContent");
        private string ScopeClass => "av-" + name.ToLowerInvariant();

        /// <summary>A reference of the module; without the module (the preflight) the first candidate stands for it.</summary>
        private string Ref(params string[] candidates) => !names ? candidates[0]
            : tryRef(candidates) ?? throw new PageException(ReferenceUnresolved, $"html: {name}: reference not found: {string.Join(" or ", candidates)}",
                "name an element the module has or references (ssam_map lists them), or create it in an earlier op of the job", "/bindings");
        /// <summary>The public signature of a reference; null without the module (its checks wait for the base).</summary>
        private ScreenContract? Contract(string reference) => !names ? null : contracts(reference) ?? throw Error($"{name}: public signature is unavailable: {reference}");
        /// <summary>The fragment op that compiles what the page form refuses, aimed at this screen's content placeholder.</summary>
        private string FragmentHint(string html) =>
            $" The fragment form of the html op compiles it: after this page op add {{\"op\":\"html\",\"parent\":\"IMobileScreen:{name}/#IMobileBlockInstanceWidget/{(mobile || BlankLayout ? "Content" : "MainContent")}\",\"html\":\"{html}\"}} (any widget of the screen can be the parent).";

        // ---- every problem at once (H1) -------------------------------------------------------------------------------

        private void Record(Exception error, string pointer = "/html")
        {
            if (Errors.FindCoded(error) is { Problems: { Count: > 0 } list } && error is not PageException)
            {
                foreach (var p in list.OfType<JsonObject>())
                    Add(new PageProblem(p["code"]?.ToString() ?? Invalid, p["message"]?.ToString() ?? error.Message, p["fix"]?.ToString(), p["pointer"]?.ToString() ?? pointer, p["patch"] as JsonArray, null));
                return;
            }
            Add(error is PageException e
                ? new PageProblem(e.Code, e.Message, e.Fix, e.Pointer ?? pointer, e.Patch, e.JobPatch)
                : new PageProblem(Invalid, error.Message, null, pointer, null, null));
        }

        private void Add(PageProblem problem)
        {
            if (!problems.Any(p => p.Message == problem.Message)) problems.Add(problem);
        }

        private void Guard(Action check, string pointer = "/html")
        {
            try { check(); }
            catch (InvalidOperationException ex) { Record(ex, pointer); }
            catch (FormatException ex) { Record(new InvalidOperationException("html: " + ex.Message, ex), pointer); }
        }

        /// <summary>All the problems at once: one keeps the exception callers always got (same type and text) with the coded
        /// problem inside; several are one KernelRefusalException HTML_INVALID.</summary>
        private Exception? Refusal()
        {
            if (problems.Count == 0) return null;
            var coded = new JsonArray(problems.Select(p =>
            {
                var problem = JobPreflight.PublicProblem(JobPreflight.Problem(null, p.Pointer, p.Code, "error", p.Message, p.Fix ?? FixOf(p.Code), p.Patch?.DeepClone().AsArray()));
                if (p.JobPatch != null) problem["jobPatch"] = p.JobPatch.DeepClone();
                return (JsonNode)problem;
            }).ToArray());
            if (problems.Count == 1)
                return new InvalidOperationException(problems[0].Message, new KernelRefusalException(problems[0].Code, problems[0].Message, coded));
            return new KernelRefusalException(Invalid, $"html: {problems.Count} problems in the page, all reported at once: "
                + string.Join(" | ", problems.Select((p, i) => $"({i + 1}) {p.Message}")), coded);
        }

        private void Settle()
        {
            if (Refusal() is { } refusal) throw refusal;
        }

        public (JsonObject Report, Exception? Refusal) Preflight()
        {
            Guard(() => { if (data["layout"] is { } layout && layout.ToString() is not ("blank" or "theme")) throw Error("layout must be blank or theme"); }, "/layout");
            Guard(() => { if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_]*$")) throw Error($"invalid screen name '{name}'"); }, "/screen");
            Guard(() => DeclaredRoles(), "/roles");
            var root = HtmlSource.Parse(Required(data, "html"));
            var css = Compile(root);
            var report = new JsonObject { ["screen"] = name, ["keys"] = keyed.Count, ["elements"] = root.Descendants().Count(n => !n.IsText), ["cssRules"] = css.Sheet?.Rules.Count ?? 0 };
            report["rewrites"] = Rewrites();
            return (report, Refusal());
        }

        public HtmlCompilation Run()
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_]*$")) throw Error($"invalid screen name '{name}'");
            if (!Existing && tryRef(["IMobileScreen:" + name]) != null) throw Error($"screen '{name}' exists; the caller must describe it to update it in place");
            var root = HtmlSource.Parse(Required(data, "html"));
            var mode = data["stylesheet"]?.GetValue<string>() ?? "theme";
            var css = Compile(root);
            Settle();
            // Native widgets default to fill-parent widths, unlike HTML buttons/spans/flex items. A zero-specificity
            // target restores intrinsic sizing; authored widths (including table/input 100%) still take precedence.
            var scoped = mode == "theme" ? "." + ScopeClass + " :where(.OSFillParent) { width: auto; }\n." + ScopeClass + " .ThemeGrid_MarginGutter { margin-left: 0; }\n" + css.Sheet!.Scoped("." + ScopeClass) : null;
            // The @import statements lead the block: the theme install moves them to the top of the stylesheet (H14).
            if (scoped != null && importsHoisted.Count > 0) scoped = string.Join("\n", importsHoisted) + "\n" + scoped;
            var report = new JsonObject
            {
                ["screen"] = name, ["mode"] = Existing ? "update" : "create",
                ["roles"] = new JsonArray(roles.Select(r => (JsonNode)r).ToArray()),
                ["anonymous"] = anonymous,
                ["elements"] = counter,
                ["keys"] = new JsonArray(keyed.Keys.Order(StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray()),
                ["sources"] = new JsonArray(sources.Select(s => (JsonNode)s.As).ToArray()),
                ["variables"] = new JsonObject { ["kept"] = new JsonArray(keptVariables.Select(v => (JsonNode)v).ToArray()), ["created"] = new JsonArray(createdVariables.Select(v => (JsonNode)v).ToArray()) },
                ["stylesheet"] = new JsonObject { ["mode"] = mode, ["scope"] = "." + ScopeClass, ["rules"] = css.Sheet!.Rules.Count, ["chars"] = css.Text.Length, ["sha256"] = Sha(css.Text), ["installed"] = false },
                ["html"] = new JsonObject { ["sha256"] = Sha(Required(data, "html")) },
            };
            if (lightDark > 0) report["stylesheet"]!["lightDarkExpanded"] = lightDark;
            if (importsHoisted.Count > 0) report["stylesheet"]!["cssImportsHoisted"] = new JsonArray(importsHoisted.Select(i => (JsonNode)i).ToArray());
            if (shells.Count > 0) report["sameJobScreenActions"] = new JsonArray(shells.Keys.Order(StringComparer.OrdinalIgnoreCase).Select(s => (JsonNode)s).ToArray());
            var rewrites = Rewrites();
            if (rewrites.Count > 0) report["rewrites"] = rewrites;
            return new HtmlCompilation(ops, report, scoped, ScopeClass);
        }

        /// <summary>The whole page, each part on its own: a problem of one part never stops the next (H1). The same pass runs
        /// with the module (Run) and without it (Preflight, H2).</summary>
        private (CssStylesheet? Sheet, string Text) Compile(HtmlNode root)
        {
            Validate(root);
            (CssStylesheet? Sheet, string Text) css = (null, "");
            Guard(() => css = Stylesheet(root), data["css"] != null ? "/css" : "/html");
            Guard(() => { var mode = data["stylesheet"]?.GetValue<string>() ?? "theme"; if (!StylesheetModes.Contains(mode)) throw Error($"stylesheet must be one of: {string.Join(", ", StylesheetModes)}"); }, "/stylesheet");
            Bindings(root);
            if (names) Guard(() => Declare(root.Descendants().Any(n => n.Tag == "h1")), "/layout");
            Guard(Variables, "/vars");
            Guard(Shells, "/bindings");
            Guard(Scripts, "/scripts");
            Guard(Sources, data["source"] != null ? "/source" : "/sources");
            Guard(Derived, "/derived");
            var page = Create(Main, "IContainer", "Page"); Set(page, "Style", Quote(ScopeClass));
            foreach (var node in Content(root)) Guard(() => Widget(node, page));
            foreach (var (label, id, node) in labels)
            {
                if (!idAliases.TryGetValue(id, out var target)) Record(Error($"{node.Where}: label for=\"{id}\" does not name an input or select of this page"));
                else Set(label, "TargetWidget", target);
            }
            return (css.Sheet ?? CssStylesheet.Parse(""), css.Text);
        }

        private JsonObject Rewrites()
        {
            var r = new JsonObject();
            if (importsHoisted.Count > 0) r["cssImportsHoisted"] = importsHoisted.Count;
            var shared = keyed.Values.Where(v => v.Count > 1).ToArray();
            if (shared.Length > 0) { r["sharedKeys"] = shared.Sum(v => v.Count - 1); r["sharedKeyCount"] = shared.Length; }
            if (shells.Count > 0) r["sameJobScreenActions"] = shells.Count;
            if (clickableElements.Count > 0) r["clickableElements"] = Counts(clickableElements);
            if (extendedAttributes.Count > 0) r["extendedAttributes"] = Counts(extendedAttributes);
            if (disabledToEnabled > 0) r["disabledToEnabled"] = disabledToEnabled;
            if (visibleWrapped.Count > 0) r["visibleWrapped"] = Counts(visibleWrapped);
            if (staticTables > 0) r["staticTables"] = staticTables;
            if (labelsWithChildren > 0) { r["labelsWithChildren"] = labelsWithChildren; r["labelsWithoutText"] = labelsWithoutText; }
            if (labelledEmptyControls > 0) r["labelledEmptyControls"] = labelledEmptyControls;
            return r;
        }
        private static JsonObject Counts(Dictionary<string, int> counts) => new(counts.OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value)));

        // ---- validation -------------------------------------------------------------------------------------------

        /// <summary>The checks of every element that need no binding: tags the page form does not compile, tags outside the
        /// platform list without a substitute, inline JavaScript. Each element on its own.</summary>
        private void Validate(HtmlNode root)
        {
            var outside = new List<HtmlNode>();
            foreach (var node in root.Descendants().Where(n => !n.IsText))
            {
                if (Unsupported.TryGetValue(node.Tag, out var why))
                {
                    Record(new PageException(TagNotAllowed, $"html: {node.Where}: {why}", node.Tag == "script" ? "move the behavior to data.scripts and a binding" : "remove the element, or compile it with the fragment form of the html op (api --op html-visual)"));
                    continue;
                }
                if (!Transparent.Contains(node.Tag) && !Ignored.Contains(node.Tag) && node.Tag is not ("br" or "option") && !ElementWidgetMap.Accepts(platform, node.Tag) && ElementWidgetMap.Substitute(platform, node.Tag) == null)
                    outside.Add(node);
                foreach (var (attribute, _) in node.Attributes)
                    if (ElementWidgetMap.IsInlineScript(attribute))
                        Record(new PageException(AttributeScript, $"html: {node.Where}: attribute '{attribute}' is not compiled: inline JavaScript never becomes an attribute",
                            $"remove {attribute} and give the element a data-av key with a call, navigate or refresh binding"));
            }
            foreach (var node in outside)
                Record(new PageException(TagNotAllowed, $"html: {node.Where}: <{node.Tag}> is not compiled by this version; supported tags: {string.Join(", ", ElementWidgetMap.Tags(platform).Where(t => !Unsupported.ContainsKey(t)).Append("br").Order(StringComparer.Ordinal))}",
                    "use div or a tag of the platform list (api --op html, platformTags)"));
        }

        private (CssStylesheet Sheet, string Text) Stylesheet(HtmlNode root)
        {
            var text = new StringBuilder();
            // CSS the theme does not render (A30): light-dark() expanded, color-mix() refused with its substitute, all at once.
            string Rendered(string css, string pointer)
            {
                var compat = CssCompat.Rewrite(css);
                foreach (var p in compat.Problems) Add(new PageProblem(CssCompat.Code, "html: " + p.Message, p.Fix, pointer, null, null));
                lightDark += compat.Expanded;
                return compat.Css;
            }
            foreach (var style in root.Descendants().Where(n => n.Tag == "style"))
            {
                if (style.Attribute("media") != null) Record(Error($"{style.Where}: use @media inside the stylesheet instead of a media attribute"));
                text.Append(Rendered(string.Concat(style.Children.Select(c => c.Text)), "/html")).Append('\n');
            }
            if (data["css"] is JsonValue extra) text.Append(Rendered(extra.GetValue<string>(), "/css")).Append('\n');
            var css = text.ToString().Trim();
            // H14: an @import of any line (a minified first line too) goes to the top of the theme; the parser finds it, never a
            // regular expression over lines (the 2026-10-10 session cut 27,632 characters of CSS removing it by regex).
            var (imports, others) = CssCompat.Imports(css);
            importsHoisted.AddRange(imports.Select(i => i.Statement));
            CssStylesheet sheet;
            try { sheet = CssStylesheet.Parse(others); }
            catch (InvalidOperationException ex)
            {
                // The CSS parser already labels its errors "css: line L col C: ..."; prefix "html: " once, not "html: css: "
                // on top of it (the double "css: css:" the diagnosis flagged).
                var inner = ex.Message.Replace("html: ", "");
                if (inner.StartsWith("css: ", StringComparison.Ordinal)) inner = inner["css: ".Length..];
                var message = "html: css: " + inner;
                throw new PageException(CssInvalid, message, System.Text.RegularExpressions.Regex.IsMatch(ex.Message, @"line 1 col 1\b")
                    ? "the stylesheet starts in the middle of a statement: it was cut (an @import needs no removal: the compiler moves it to the top of the theme)"
                    : "fix the CSS at the line and column named; every statement must parse", data["css"] != null ? "/css" : "/html");
            }
            if (sheet.IdNames() is { Count: > 0 } ids)
                Add(new PageProblem(CssIdSelector, $"html: css: selectors use {string.Join(", ", ids.Select(i => "#" + i))}, but OutSystems reserves the id attribute (Verify InvalidHTMLAttribute_Id); select by class instead",
                    "select the element by a class (class=\"x\" and .x)", data["css"] != null ? "/css" : "/html", null, null));
            foreach (var statement in sheet.Statements)
                Add(new PageProblem(CssInvalid, $"html: css: {statement} is not compiled; the stylesheet must be self-contained", "remove the statement (an @import is moved to the top of the theme on its own)",
                    data["css"] != null ? "/css" : "/html", null, null));
            return (sheet, css);
        }

        private void Bindings(HtmlNode root)
        {
            if (data["bindings"] is JsonObject declared)
                foreach (var (key, value) in declared)
                {
                    var pointer = "/bindings/" + Escape(key);
                    Guard(() =>
                    {
                        if (value is not JsonObject binding) throw new PageException(BindingInvalid, $"html: binding '{key}' must be an object", "write {\"kind\": \"...\", ...}", pointer);
                        var kind = Required(binding, "kind");
                        if (!Kinds.Contains(kind)) throw new PageException(BindingInvalid, $"html: binding '{key}': unknown kind '{kind}'; allowed: {string.Join(", ", Kinds)}", $"use one of: {string.Join(", ", Kinds)}", pointer);
                        Keys(binding, kind, $"binding '{key}'");
                        if (kind == "list" && binding["source"] is JsonObject listSource && (listSource.Count != 1 || listSource["variable"] is not JsonValue))
                            throw new PageException(BindingInvalid, $"html: binding '{key}': a list source object is {{\"variable\": \"<List variable of vars>\"}}", "write \"source\": {\"variable\": \"<Name>\"} or the name of a declared source", pointer + "/source");
                        bindings[key] = binding;
                    }, pointer);
                }
            Guard(() =>
            {
                if (data["search"] is not JsonObject search) return;
                Keys(search, "search"); var key = Required(search, "key");
                if (bindings.ContainsKey(key)) throw Error($"search key '{key}' is also declared in bindings");
                bindings[key] = new JsonObject { ["kind"] = "search", ["field"] = search["field"]?.DeepClone(), ["label"] = search["label"]?.DeepClone(), ["variable"] = search["variable"]?.GetValue<string>() ?? "SearchText" };
            }, "/search");
            Guard(() =>
            {
                foreach (var filter in Objects(data, "filters"))
                {
                    Keys(filter, "filter"); var key = Required(filter, "key"); var from = Required(filter, "from");
                    if (bindings.ContainsKey(key)) throw Error($"filter key '{key}' is declared twice");
                    bindings[key] = new JsonObject { ["kind"] = "filter", ["field"] = filter["field"]?.DeepClone(), ["from"] = from, ["label"] = filter["label"]?.DeepClone(), ["variable"] = filter["variable"]?.GetValue<string>() ?? "Filter_" + (filter["field"]?.GetValue<string>() ?? from) };
                }
            }, "/filters");
            foreach (var node in root.Descendants().Where(n => !n.IsText && n.Attribute("data-av") != null))
            {
                var key = node.Attribute("data-av")!;
                if (key.Length == 0) { Record(new PageException(KeyUnbound, $"html: {node.Where}: data-av must name a binding key", "write data-av=\"<key>\" and declare bindings.<key>, or remove data-av")); continue; }
                if (!bindings.ContainsKey(key) && data["bindings"]?[key] == null)
                    Record(new PageException(KeyUnbound, $"html: {node.Where}: data-av \"{key}\" has no binding; declare it in bindings, search or filters", $"declare bindings.{key}, or remove data-av=\"{key}\""));
                // H12: the same key on N elements is the same binding on each of them (named Name, Name2 ...).
                if (!keyed.TryGetValue(key, out var nodes)) keyed[key] = nodes = [];
                nodes.Add(node);
            }
            foreach (var key in bindings.Keys)
                if (!keyed.ContainsKey(key))
                    Add(new PageProblem(BindingOrphan, $"html: binding '{key}' matches no element; add data-av=\"{key}\" to the element it describes",
                        $"add data-av=\"{key}\" to the element it describes, or remove the binding (the patch)", "/bindings/" + Escape(key),
                        data["bindings"]?[key] != null ? new JsonArray(new JsonObject { ["op"] = "remove", ["path"] = "/bindings/" + Escape(key) }) : null, null));
        }

        // ---- screen, variables, scripts, data -------------------------------------------------------------------------

        private void Declare(bool authoredTitle)
        {
            if (data["layout"] is { } mode && mode.ToString() is not ("blank" or "theme")) throw Error("layout must be blank or theme");
            var layout = BlankLayout ? "LayoutBlank" : mobile ? "Layout" : "LayoutTopMenu";
            var placeholder = mobile || BlankLayout ? "Content" : "MainContent";
            // Without the layout, or without its content placeholder, the page would land outside it: refused with the exact path.
            var layoutReference = tryRef(["IMobileBlock:" + layout]) ?? throw Coded("HTML_INVALID",
                $"html: {name}: layout IMobileBlock:{layout} is not in this module nor in its references (a module created blank has no OutSystemsUI layouts)",
                $"reference IMobileBlock:{layout} from OutSystemsUI (o11_dependencies or ssam_map of the producer), or create the module from a Reactive/Mobile template", "/layout");
            var layoutContract = Contract(layoutReference)!;
            if (!layoutContract.Placeholders.Any(p => p.Name == placeholder))
                throw Coded("HTML_INVALID", $"html: layout {layout} has no content placeholder {placeholder}; placeholders: {string.Join(", ", layoutContract.Placeholders.Select(p => Root + "/#IMobileBlockInstanceWidget/" + p.Name))}",
                    $"use a layout with {placeholder} (layout: \"blank\" uses LayoutBlank/Content)", "/layout");
            if (!Existing)
            {
                Create(Ref("IMobileFlow:MainFlow"), "IMobileScreen", name, Root);
            }
            Access();
            if (!Existing || existing?["layout"]?.ToString() != layout)
            {
                Set(Root + "/#IMobileBlockInstanceWidget", "SourceBlock", layoutContract.Reference);
                if (BlankLayout) ops[^1]["empty"] = true;
            }
            if (!authoredTitle && layoutContract.Placeholders.Any(p => p.Name == "Title")) Expression(Root + "/#IMobileBlockInstanceWidget/Title", Quote(data["title"]?.GetValue<string>() ?? name));
        }

        /// <summary>
        /// Who may open the screen. A new screen is born for authenticated users (Registered) unless data.roles says otherwise;
        /// an existing screen keeps its access (identity preserved) unless data.roles replaces it with exactly that list.
        /// O11: the Roles collection, with the system roles Registered and Anonymous (the op of the spec path, ScreenModel).
        /// ODC has neither system role (IRole:Registered does not resolve there): everyone gets in through AnonymousAccess,
        /// authenticated users are AnonymousAccess off (the model's own default for a new screen, kept with its app role),
        /// and the Roles collection holds app roles, replaced only when data.roles names them.
        /// </summary>
        private void Access()
        {
            var declared = DeclaredRoles();
            foreach (var role in (declared ?? []).Where(r => !SystemRole(r)))
                if (tryRef(["IRole:" + role]) == null) throw Error($"{name}: role '{role}' is not a role of the module or of its references; roles: Registered (authenticated users), Anonymous (everyone) or a role the module defines or references");
            var current = existing?["roles"] is JsonArray roleNames ? roleNames.Select(r => r!.ToString()).ToList() : [];
            if (!Odc)
            {
                if (declared != null || !Existing)
                {
                    roles = declared ?? [.. DefaultRoles];
                    Set(Root, "Roles", new JsonArray(roles.Select(r => (JsonNode)("IRole:" + r)).ToArray()));
                }
                else roles = current;
                anonymous = roles.Contains("Anonymous", StringComparer.OrdinalIgnoreCase);
                return;
            }
            if (declared != null || !Existing)
            {
                roles = declared ?? [.. DefaultRoles];
                anonymous = roles.Contains("Anonymous");
                Set(Root, "AnonymousAccess", anonymous);
                var named = roles.Where(r => !SystemRole(r)).ToArray();
                if (named.Length > 0) Set(Root, "Roles", new JsonArray(named.Select(r => (JsonNode)("IRole:" + r)).ToArray()));
                return;
            }
            anonymous = existing?["anonymous"] is JsonValue open && open.GetValue<bool>();
            roles = [.. (anonymous ? new[] { "Anonymous", "Registered" } : ["Registered"]), .. current.Where(r => !SystemRole(r))];
        }
        private static bool Odc => typeof(HtmlExpander).Assembly.GetName().Name == "Anvil.Core.Odc";

        /// <summary>data.roles as role names, null when absent. Anonymous lets every user in, so Registered goes with it, the
        /// rule the component path applies (HtmlComponents) and the pair the Studio checks together.</summary>
        private List<string>? DeclaredRoles()
        {
            if (data["roles"] is not { } node) return null;
            const string shape = "roles must be a nonempty array of role names, such as [\"Registered\"] (authenticated users) or [\"Anonymous\"] (everyone)";
            if (node is not JsonArray array || array.Count == 0) throw Error(shape);
            var roleNames = new List<string>();
            foreach (var item in array)
            {
                var role = item is JsonValue value && value.TryGetValue<string>(out var text) ? text.Trim() : "";
                if (role.Length == 0) throw Error(shape);
                if (SystemRole(role)) role = role.Equals("Anonymous", StringComparison.OrdinalIgnoreCase) ? "Anonymous" : "Registered";
                if (!roleNames.Contains(role, StringComparer.OrdinalIgnoreCase)) roleNames.Add(role);
            }
            if (roleNames.Contains("Anonymous") && !roleNames.Contains("Registered")) roleNames.Add("Registered");
            return roleNames;
        }
        private static bool SystemRole(string role) => role.Equals("Anonymous", StringComparison.OrdinalIgnoreCase) || role.Equals("Registered", StringComparison.OrdinalIgnoreCase);

        private void Variables()
        {
            var declared = Objects(data, "vars");
            for (var i = 0; i < declared.Count; i++)
            {
                var v = declared[i];
                Guard(() => { Keys(v, "var"); Variable(Required(v, "name"), Required(v, "type"), v["default"]?.GetValue<string>()); }, "/vars/" + i);
            }
        }

        /// <summary>Declares a screen variable once; on an existing screen a variable of the same name and type is kept (identity preserved).</summary>
        private void Variable(string variable, string type, string? defaultValue = null)
        {
            if (variables.TryGetValue(variable, out var known))
            {
                if (!known.Equals(type, StringComparison.OrdinalIgnoreCase)) throw Error($"variable '{variable}' is declared as {known} and as {type}");
                return;
            }
            variables[variable] = type;
            if (existing?["variables"] is JsonObject vars && vars[variable] is JsonValue existingType)
            {
                if (!existingType.GetValue<string>().Equals(type, StringComparison.OrdinalIgnoreCase)) throw Error($"variable '{variable}' exists as {existingType} and the page declares {type}; keep the type or rename the variable");
                keptVariables.Add(variable); return;
            }
            var a = Create(Root, "ILocalVariable", variable); Set(a, "DataType", type);
            if (defaultValue != null) Set(a, "DefaultValue", defaultValue);
            createdVariables.Add(variable);
        }

        /// <summary>H10: the screen actions of this screen that a logic op of the same job declares and the page calls are born
        /// here, before the content, with their name, inputs and outputs (a Start and an End): the widgets bind to them, and the
        /// logic op fills their bodies in place (it replaces the action keeping its key: HtmlDelta marks it).</summary>
        private void Shells()
        {
            if (job == null) return;
            var called = bindings.Values.Where(b => b["kind"]?.ToString() == "call" && b["action"] is JsonValue).Select(b => b["action"]!.ToString()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            foreach (var callName in called)
            {
                if (names && tryRef(["IServerAction:" + callName, "IServiceAction:" + callName, "IClientAction:" + callName]) != null) continue;
                if (job.Actions.FirstOrDefault(a => a.Kind == "screen" && OwnsThisScreen(a) && a.Name.Equals(callName, StringComparison.OrdinalIgnoreCase)) is not { } action) continue;
                var shell = Create(Root, "IScreenAction", action.Name, Root + ".shell." + action.Name);
                foreach (var input in action.Inputs) { var p = Create(shell, "IInputParameter", input.Name); Set(p, "DataType", input.Type); }
                foreach (var output in action.Outputs) { var p = Create(shell, "IOutputParameter", output.Name); Set(p, "DataType", output.Type); }
                var start = Create(shell, "IStartNode"); var end = Create(shell, "IEndNode"); Link(start, end);
                shells[action.Name] = (shell, action);
            }
        }

        private bool OwnsThisScreen(HtmlJobAction action) => action.Owner.Equals("IMobileScreen:" + name, StringComparison.OrdinalIgnoreCase) || action.Owner.Equals("$html." + name, StringComparison.OrdinalIgnoreCase);

        /// <summary>Client functions written in JavaScript, callable from binding expressions: an IClientAction with Function on and one
        /// JavaScript node carrying the inputs, outputs and code (the shape proved by client-js-reactive.json).</summary>
        private void Scripts()
        {
            var scriptSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var script in Objects(data, "scripts"))
            {
                Keys(script, "script"); var scriptName = Required(script, "name");
                if (!System.Text.RegularExpressions.Regex.IsMatch(scriptName, "^[A-Za-z][A-Za-z0-9_]*$")) throw Error($"script '{scriptName}' is not a valid action name");
                if (!scriptSet.Add(scriptName)) throw Error($"script '{scriptName}' is declared twice");
                var code = Required(script, "code");
                var inputs = Objects(script, "inputs"); var outputs = Objects(script, "outputs");
                if (outputs.Count == 0) throw Error($"script '{scriptName}' needs at least one output to be usable in an expression");
                var generatedName = name + "_" + scriptName;
                scriptNames.Add(scriptName, generatedName);
                var marker = "anvil:html script " + name + "/" + scriptName;
                var reference = "IClientAction:" + generatedName;
                if (tryRef([reference]) != null)
                {
                    if (existing?["scripts"]?[generatedName]?.ToString() != marker) throw Error($"script '{generatedName}' already exists and is not owned by this page");
                    Add("delete", ("target", reference));
                }
                var action = Create("@espace", "IClientAction", generatedName, "$html.script." + scriptName); Set(action, "Function", true);
                Set(action, "Description", marker);
                foreach (var p in inputs) { Keys(p, "param"); var i = Create(action, "IInputParameter", Required(p, "name")); Set(i, "DataType", Required(p, "type")); }
                foreach (var p in outputs) { Keys(p, "param"); var o = Create(action, "IOutputParameter", Required(p, "name")); Set(o, "DataType", Required(p, "type")); }
                var start = Create(action, "IStartNode"); var js = Create(action, "IJavaScriptNode", "Run");
                foreach (var p in inputs) { var i = Create(js, "IInputParameter", Required(p, "name")); Set(i, "DataType", Required(p, "type")); }
                foreach (var p in outputs) { var o = Create(js, "IOutputParameter", Required(p, "name")); Set(o, "DataType", Required(p, "type")); }
                Set(js, "JavaScript", code);
                foreach (var p in inputs) Set(js + "/arg:" + Required(p, "name"), "Value", Required(p, "name"));
                var assign = Assign(action, outputs.ToDictionary(p => Required(p, "name"), p => "Run." + Required(p, "name")));
                var end = Create(action, "IEndNode"); Link(start, js); Link(js, assign); Link(assign, end); Add("layout", ("target", action));
            }
        }

        private void Sources()
        {
            var declared = Objects(data, "sources");
            if (data["source"] is JsonObject single) { if (declared.Count > 0) throw Error("declare either source or sources, not both"); declared = [single]; }
            else if (data["source"] != null) throw Error("source must be an object");
            var filters = Objects(data, "filters");
            var search = data["search"] as JsonObject;
            if (declared.Count == 0)
            {
                if (search != null || filters.Count > 0) throw Error($"{name}: search/filters require a source");
                // H11: a list over a list variable needs no source, nor do the fields inside it.
                var variableLists = bindings.Values.Any(b => b["kind"]?.ToString() == "list" && b["source"] is JsonObject);
                foreach (var (key, binding) in bindings)
                {
                    var kind = binding["kind"]?.ToString();
                    if (kind == "list" && binding["source"] is JsonObject) continue;
                    if (kind == "field" && variableLists) continue;
                    if (kind is "list" or "field" or "refresh" or "date") throw Error($"binding '{key}' ({binding["kind"]}) requires a source");
                }
                return;
            }
            if (search != null) Variable(search["variable"]?.GetValue<string>() ?? "SearchText", "Text");
            foreach (var filter in filters) { Ref("IStaticEntity:" + Required(filter, "from")); Variable(bindings[Required(filter, "key")]["variable"]!.ToString(), Required(filter, "from") + " Identifier"); }
            foreach (var source in declared)
            {
                Keys(source, "source");
                if ((source["entity"] != null) == (source["action"] != null)) throw Error($"{name}: source requires exactly one of entity/action");
                var asName = Required(source, "as");
                if (sources.Any(s => s.As.Equals(asName, StringComparison.OrdinalIgnoreCase))) throw Error($"source '{asName}' is declared twice");
                var alias = Root + ".source." + asName;
                if (source["entity"] is JsonValue entityValue) EntitySource(source, asName, alias, entityValue.GetValue<string>(), search, filters);
                else ActionSource(source, asName, alias);
            }
            // A filter variable that reaches no source would be a dead control.
            foreach (var (key, binding) in bindings.Where(b => b.Value["kind"]?.ToString() is "search" or "filter"))
            {
                var variable = binding["variable"]!.ToString();
                var used = (binding["field"] != null && declared.Any(s => s["entity"] != null)) || declared.Any(s => s["args"] is JsonObject args && args.Any(a => Mentions(a.Value?.ToString() ?? "", variable)));
                if (!used) throw Error($"'{key}' binds {variable}, but no source reads it: give the entity source a field or pass {variable} in an action source's args");
            }
        }

        private void EntitySource(JsonObject source, string asName, string alias, string entity, JsonObject? search, IReadOnlyList<JsonObject> filters)
        {
            if (source["state"] != null || source["paging"] != null) throw Error("state/paging currently require an action source");
            if (source["args"] != null || source["outputs"] != null) throw Error("entity source does not accept args/outputs");
            var reference = Ref("IServerEntity:" + entity, "IStaticEntity:" + entity, "IEntitySignature:" + entity);
            var signature = Contract(reference);
            var open = signature == null;
            var fields = signature?.Fields ?? []; var list = asName + ".List"; var current = list + ".Current." + entity;
            Create(Root, "IScreenAggregate", asName, alias);
            Add("create", ("parent", alias), ("type", "IAliasedSource"), ("args", new JsonObject { ["dataSource"] = reference }));
            if (source["max"] is JsonValue max) Set(alias, "MaxRecords", max.GetValue<int>().ToString());
            foreach (var where in Texts(source["where"])) Where(alias, where);
            if (source["sort"] is JsonArray sorts)
                foreach (var item in sorts)
                {
                    var sort = item as JsonArray ?? throw Error("source.sort entries are [expression, Ascending|Descending]");
                    if (sort.Count != 2) throw Error("source.sort entries are [expression, Ascending|Descending]");
                    if (sort[1]?.GetValue<string>() is not ("Ascending" or "Descending")) throw Error("sort direction must be Ascending or Descending");
                    var a = Create(alias, "ISort"); Set(a, "Attribute", sort[0]!.GetValue<string>()); Set(a, "SortDirection", sort[1]!.GetValue<string>());
                }
            else if (source["sort"] != null) throw Error("source.sort must be an array");
            if (search?["field"] is JsonValue searchField)
            {
                var f = searchField.GetValue<string>();
                var found = open ? new UiParam(f, "Text", false, null, null) : fields.FirstOrDefault(p => p.Name.Equals(f, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"search.field '{f}' does not exist in {entity}");
                if (found.Type != "Text") throw Error("search.field must be a Text attribute");
                Where(alias, $"{entity}.{found.Name} like \"%\" + {search["variable"]?.GetValue<string>() ?? "SearchText"} + \"%\"");
            }
            foreach (var filter in filters.Where(f => f["field"] != null))
            {
                var f = filter["field"]!.GetValue<string>(); var from = Required(filter, "from"); var variable = bindings[Required(filter, "key")]["variable"]!.ToString();
                var found = open ? new UiParam(f, from + " Identifier", false, null, null) : fields.FirstOrDefault(p => p.Name.Equals(f, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"filter field '{f}' does not exist in {entity}");
                if (!found.Type.Equals(from + " Identifier", StringComparison.OrdinalIgnoreCase)) throw Error($"{name}: {f} must have type {from} Identifier");
                Where(alias, $"{variable} = NullIdentifier() or {entity}.{f} = {variable}");
            }
            sources.Add(new SourceInfo(asName, alias, true, entity, new(StringComparer.OrdinalIgnoreCase) { ["List"] = (list, current, fields) }, open));
        }

        /// <summary>A data action exposing every output of the server/service action (or the declared subset), assigned from one call.</summary>
        private void ActionSource(JsonObject source, string asName, string alias)
        {
            if (source["where"] != null || source["sort"] != null || source["max"] != null) throw Error("action source takes args, not where/sort/max");
            var action = Required(source, "action"); var reference = Ref("IServerAction:" + action, "IServiceAction:" + action);
            if (source["paging"] is JsonObject pagingSyntax)
            {
                Keys(pagingSyntax, "paging"); Required(pagingSyntax, "offset"); Required(pagingSyntax, "total");
                if ((pagingSyntax["size"]?.GetValue<int>() ?? 20) is < 1 or > 100) throw Error("paging.size must be between 1 and 100");
                if (pagingSyntax["offsetInput"]?.ToString() is { } startName && startName == pagingSyntax["sizeInput"]?.ToString())
                    throw Error("paging offsetInput and sizeInput must differ");
            }
            else if (source["paging"] != null) throw Error("source.paging must be an object");
            if (source["state"] is JsonObject stateSyntax && (stateSyntax["assign"] is not JsonObject { Count: > 0 } || stateSyntax.Any(p => p.Key != "assign")))
                throw Error("state object requires only a nonempty assign: {screenVariable: sourceOutput}");
            var signature = Contract(reference);
            if (signature == null)
            {
                // Without the module the outputs are unknown: the lists are open (their fields are checked against the base).
                if (source["paging"] is JsonObject openPage) { Keys(openPage, "paging"); var offset = Required(openPage, "offset"); Required(openPage, "total"); Variable(offset, "Integer", "0"); paging.Add(asName, (offset, openPage["size"]?.GetValue<int>() ?? 20, asName + "." + openPage["total"])); }
                Create(Root, "IDataAction", asName, alias);
                sources.Add(new SourceInfo(asName, alias, false, null, new(StringComparer.OrdinalIgnoreCase), Open: true));
                return;
            }
            var wanted = source["outputs"] is JsonArray subset ? subset.Select(o => o!.GetValue<string>()).ToList() : signature.Outputs.Select(o => o.Name).ToList();
            if (wanted.Count == 0) throw Error($"{action} has no outputs to expose");
            var args = source["args"]?.DeepClone().AsObject() ?? new();
            if (source["paging"] is JsonObject page)
            {
                Keys(page, "paging"); var offset = Required(page, "offset"); var size = page["size"]?.GetValue<int>() ?? 20; var total = Required(page, "total");
                if (size < 1 || size > 100) throw Error("paging.size must be between 1 and 100");
                if (!wanted.Contains(total) || !signature.Outputs.Any(o => o.Name == total && o.Type is "Integer" or "Long Integer")) throw Error("paging.total must name an exposed integer output");
                var offsetInput = page["offsetInput"]?.GetValue<string>() ?? "StartIndex";
                var sizeInput = page["sizeInput"]?.GetValue<string>() ?? "MaxRecords";
                foreach (var input in new[] { offsetInput, sizeInput })
                    if (!signature.Inputs.Any(p => p.Name == input && p.Type is "Integer" or "Long Integer"))
                        throw Error($"paging input '{input}' must name an Integer or Long Integer input of {action}");
                if (offsetInput == sizeInput) throw Error("paging offsetInput and sizeInput must differ");
                if (args.ContainsKey(offsetInput) || args.ContainsKey(sizeInput)) throw Error($"paging owns {offsetInput}/{sizeInput}; omit these args");
                Variable(offset, "Integer", "0"); args[offsetInput] = offset; args[sizeInput] = size.ToString();
                paging.Add(asName, (offset, size, asName + "." + total));
            }
            else if (source["paging"] != null) throw Error("source.paging must be an object");
            CheckArgs(signature.Inputs, args);
            Create(Root, "IDataAction", asName, alias); Add("delete", ("target", alias + "/Out1"));
            var lists = new Dictionary<string, (string, string, IReadOnlyList<UiParam>)>(StringComparer.OrdinalIgnoreCase);
            var assignments = new Dictionary<string, string>();
            var stateMap = (source["state"] as JsonObject)?["assign"] as JsonObject;
            if (source["state"] is JsonObject stateObject && (stateMap == null || stateObject.Any(p => p.Key != "assign")))
                throw Error("state object requires only assign: {screenVariable: sourceOutput}");
            var state = source["state"] is JsonObject || source["state"]?.GetValue<bool>() == true;
            var outputNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (state)
            {
                if (signature.Outputs.Any(o => o.Name == "FetchSucceeded")) throw Error("state reserves the FetchSucceeded output");
                var success = Create(alias, "IOutputParameter", "FetchSucceeded"); Set(success, "DataType", "Boolean");
                assignments["FetchSucceeded"] = "True";
            }
            foreach (var outputName in wanted)
            {
                var output = signature.Outputs.FirstOrDefault(o => o.Name.Equals(outputName, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"{action} has no output '{outputName}'; available: {string.Join(", ", signature.Outputs.Select(o => o.Name))}");
                var nativeName = output.Name;
                if (variables.ContainsKey(nativeName) || stateMap?.ContainsKey(nativeName) == true)
                {
                    nativeName = "Fetched" + output.Name;
                    for (var suffix = 2; variables.ContainsKey(nativeName) || signature.Outputs.Any(o => o.Name == nativeName) || outputNames.ContainsValue(nativeName); suffix++)
                        nativeName = "Fetched" + output.Name + suffix;
                }
                outputNames.Add(output.Name, nativeName);
                if (nativeName != output.Name) sourceOutputNames[asName + "." + output.Name] = asName + "." + nativeName;
                var node = Create(alias, "IOutputParameter", nativeName); Set(node, "DataType", output.Type);
                assignments[nativeName] = "ReadSource." + output.Name;
                if (output.Type.EndsWith(" List", StringComparison.Ordinal)) lists[output.Name] = (asName + "." + nativeName, asName + "." + nativeName + ".Current", signature.OutputFields.GetValueOrDefault(output.Name) ?? []);
            }
            var start = Create(alias, "IStartNode"); var call = Create(alias, "IExecuteServerActionNode", "ReadSource"); Set(call, "Action", reference);
            foreach (var arg in args) Set(call + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
            var assign = Assign(alias, assignments); var end = Create(alias, "IEndNode");
            Link(start, call); Link(call, assign); Link(assign, end); Add("layout", ("target", alias));
            if (state)
            {
                var handler = Create(alias, "IExceptionHandlerNode", "FetchFailed"); Set(handler, "Exception", "@espace/AllExceptions");
                Set(handler, "AbortTransaction", true); Set(handler, "LogError", true);
                var failure = Assign(alias, new Dictionary<string, string> { ["FetchSucceeded"] = "False" });
                var failureEnd = Create(alias, "IEndNode");
                Link(handler, failure); Link(failure, failureEnd); Add("layout", ("target", alias));
            }
            if (paging.TryGetValue(asName, out var pagingState))
            {
                var totalName = pagingState.Total[(asName.Length + 1)..];
                paging[asName] = (pagingState.Offset, pagingState.Size, asName + "." + outputNames[totalName]);
            }
            if (stateMap != null)
            {
                var applyValues = new Dictionary<string, string>();
                foreach (var assignment in stateMap)
                {
                    var outputName = assignment.Value?.GetValue<string>() ?? throw Error("state.assign values name source outputs");
                    var output = signature.Outputs.FirstOrDefault(o => o.Name == outputName);
                    if (output == null || !outputNames.ContainsKey(outputName)) throw Error($"state.assign '{assignment.Key}' names an output not exposed: {outputName}");
                    Variable(assignment.Key, output.Type);
                    applyValues.Add(assignment.Key, asName + "." + outputNames[outputName]);
                }
                var handlerName = "Apply" + asName;
                for (var suffix = 2; variables.ContainsKey(handlerName) || job?.Actions.Any(a => a.Name == handlerName && OwnsThisScreen(a)) == true; suffix++) handlerName = "Apply" + asName + suffix;
                var handler = Create(Root, "IScreenAction", handlerName);
                var begin = Create(handler, "IStartNode"); var ready = Create(handler, "IIfNode");
                Set(ready, "Condition", asName + ".FetchSucceeded"); Link(begin, ready);
                var apply = Assign(handler, applyValues); var done = Create(handler, "IEndNode");
                Add("link", ("from", ready), ("connector", "TrueTarget"), ("to", apply));
                Add("link", ("from", ready), ("connector", "FalseTarget"), ("to", done)); Link(apply, done);
                Set(alias + "/OnAfterFetch", "Destination", handler); Add("layout", ("target", handler));
                stateHandlers[alias] = (handler, apply, done);
            }
            sources.Add(new SourceInfo(asName, alias, false, null, lists));
        }

        /// <summary>A value computed over a fetched list (the largest or the sum of a field) in native logic: a screen action run on the
        /// source's OnAfterFetch loops the list into a screen variable. What a page would compute in a script becomes visible, typed logic.</summary>
        private void Derived()
        {
            var handlers = new Dictionary<string, (string Action, string Tail)>(StringComparer.OrdinalIgnoreCase);
            foreach (var d in Objects(data, "derived"))
            {
                Keys(d, "derived"); var derivedName = Required(d, "name"); var type = d["type"]?.GetValue<string>() ?? "Integer";
                if ((d["max"] != null) == (d["sum"] != null)) throw Error($"derived '{derivedName}' takes exactly one of max/sum naming a field of the list");
                var isMax = d["max"] != null; var field = isMax ? Required(d, "max") : Required(d, "sum");
                var where = $"derived '{derivedName}'";
                var source = SourceFor(d["source"]?.GetValue<string>(), where); var scope = List(source, d["output"]?.GetValue<string>(), where);
                var found = scope.Open ? new UiParam(field, "Integer", false, null, null) : scope.Fields.FirstOrDefault(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"{where}: field '{field}' does not exist in the list; available: {string.Join(", ", scope.Fields.Select(f => f.Name))}");
                Variable(derivedName, type, "0");
                var value = scope.Current + "." + found.Name;
                if (!handlers.TryGetValue(source.Alias, out var handler))
                {
                    if (stateHandlers.TryGetValue(source.Alias, out var stateHandler))
                    {
                        // Compose the graph before applying it: do not emit a temporary tail->End edge and then rewire it.
                        ops.RemoveAll(o => o["op"]?.ToString() == "link" && o["from"]?.ToString() == stateHandler.Tail && o["to"]?.ToString() == stateHandler.End);
                        handler = (stateHandler.Action, stateHandler.Tail);
                    }
                    else
                    {
                        var newAction = Create(Root, "IScreenAction", "Derive" + derivedName);
                        handler = (newAction, Create(newAction, "IStartNode"));
                        Set(source.Alias + "/OnAfterFetch", "Destination", newAction);
                    }
                }
                var action = handler.Action;
                var reset = Assign(action, new Dictionary<string, string> { [derivedName] = "0" });
                var loop = Create(action, "IForEachNode"); Set(loop, "Label", "Each" + derivedName); Set(loop, "RecordList", scope.List);
                Link(handler.Tail, reset); Link(reset, loop);
                if (isMax)
                {
                    var test = Create(action, "IIfNode"); Set(test, "Label", "Larger"); Set(test, "Condition", value + " > " + derivedName);
                    var take = Assign(action, new Dictionary<string, string> { [derivedName] = value });
                    Add("link", ("from", loop), ("connector", "CycleTarget"), ("to", test));
                    Add("link", ("from", test), ("connector", "TrueTarget"), ("to", take)); Add("link", ("from", test), ("connector", "FalseTarget"), ("to", loop)); Link(take, loop);
                }
                else
                {
                    var add = Assign(action, new Dictionary<string, string> { [derivedName] = derivedName + " + " + value });
                    Add("link", ("from", loop), ("connector", "CycleTarget"), ("to", add)); Link(add, loop);
                }
                handlers[source.Alias] = (action, loop);
            }
            foreach (var entry in handlers)
            {
                var handler = entry.Value;
                var end = stateHandlers.TryGetValue(entry.Key, out var stateHandler) ? stateHandler.End : Create(handler.Action, "IEndNode");
                Link(handler.Tail, end); Add("layout", ("target", handler.Action));
            }
        }

        // Refresh only sources whose inputs depend on the changed variable. An explicit refresh still refreshes all.
        private IReadOnlyList<string> ConsumersOf(string variable)
        {
            var declared = Objects(data, "sources").ToList();
            if (data["source"] is JsonObject single) declared.Add(single);
            return sources.Where(s => s.IsEntity || declared.Any(d => (d["as"]?.ToString() ?? "GetData") == s.As &&
                d["args"] is JsonObject args && args.Any(a => Mentions(a.Value?.ToString() ?? "", variable))))
                .Select(s => s.As).ToArray();
        }

        /// <param name="consumers">The sources of a search or filter (ConsumersOf): none means its "no source reads it" problem
        /// is already recorded, so no second problem of the same cause.</param>
        private string RefreshAction(string actionName, IReadOnlyList<string>? only = null, bool resetPaging = false, bool consumers = false)
        {
            var key = actionName + "|" + string.Join(",", only ?? []) + "|" + resetPaging;
            if (actions.TryGetValue(key, out var existingAction)) return existingAction;
            var targets = only == null ? sources : only.Select(o => sources.FirstOrDefault(s => s.As.Equals(o, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"refresh names unknown source '{o}'; declared: {string.Join(", ", sources.Select(s => s.As))}")).ToList();
            if (targets.Count == 0)
            {
                // A page without any source already has its problem ("requires a source"): no second one for the same cause.
                if ((data["source"] == null && data["sources"] == null) || consumers) return Create(Root, "IScreenAction", actionName);
                throw Error($"{name}: '{actionName}' needs a source to refresh");
            }
            var action = Create(Root, "IScreenAction", actionName);
            var tail = Create(action, "IStartNode");
            if (resetPaging)
            {
                var resets = targets.Where(s => paging.ContainsKey(s.As)).ToDictionary(s => paging[s.As].Offset, _ => "0");
                if (resets.Count > 0) { var reset = Assign(action, resets); Link(tail, reset); tail = reset; }
            }
            foreach (var source in targets) { var refresh = Create(action, "IRefreshDataNode", "Refresh" + source.As); Set(refresh, "DataSource", source.Alias); Link(tail, refresh); tail = refresh; }
            var end = Create(action, "IEndNode"); Link(tail, end); Add("layout", ("target", action));
            actions[key] = action; return action;
        }

        // ---- widgets ------------------------------------------------------------------------------------------------

        private static List<HtmlNode> Content(HtmlNode root)
        {
            var body = root.Descendants().FirstOrDefault(n => n.Tag == "body");
            return body?.Children ?? root.Children;
        }

        private JsonObject? BindingOf(HtmlNode node) => node.Attribute("data-av") is { } key && bindings.TryGetValue(key, out var binding) ? binding : null;

        /// <summary>The children of an element, each on its own: a child that fails is a problem and the next one compiles.</summary>
        private void Children(HtmlNode node, string parent)
        {
            foreach (var child in node.Children) Guard(() => Widget(child, parent));
        }

        private void Widget(HtmlNode node, string parent)
        {
            if (node.IsText) { var text = HtmlNode.CollapseSpaces(node.Text); if (text.Length > 0) Expression(parent, Bound(text, node, "the text")); return; }
            var tag = node.Tag;
            if (Ignored.Contains(tag)) return;
            if (Transparent.Contains(tag)) { Children(node, parent); return; }
            if (Unsupported.ContainsKey(tag)) return; // reported by the validation
            var binding = BindingOf(node); var kind = binding?["kind"]?.ToString();
            if (clickables.Count > 0 && InsideClickable(tag, kind) is { } refusal)
            {
                var outer = clickables.Peek();
                Record(Error($"{node.Where}{(kind != null ? $" (kind {kind})" : "")} cannot be compiled inside <{outer.Tag}> ({outer.Where}): {refusal}"));
                // What is inside still compiles, so its own problems come out too (the rows of a refused list in an open scope).
                if (kind == "list") listScopes.Push(new ListScope("", "", [], true));
                try { Children(node, parent); }
                finally { if (kind == "list") listScopes.Pop(); }
                return;
            }
            // H7: visible on any element other than a div (the div keeps its Container path) is a native If around it.
            if (kind == "visible" && tag != "div")
            {
                var elementName = NameFor(node); preNamed[node] = elementName;
                var ifName = "If" + (elementName ?? Capitalise(tag) + (counter + 1));
                if (!widgetNames.Add(ifName)) throw Error($"{node.Where}: the If of key \"{node.Attribute("data-av")}\" would be named {ifName}, already used by another key; rename one of the keys");
                var branch = Create(parent, "IIfWidget", ifName); Set(branch, "Condition", Required(binding!, "condition"));
                visibleWrapped[tag] = visibleWrapped.GetValueOrDefault(tag) + 1;
                visibleBound.Add(node);
                Element(node, branch + "/TrueBranch", null, null);
                return;
            }
            Element(node, parent, binding, kind);
        }

        private void Element(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            var tag = node.Tag;
            switch (tag)
            {
                case "input": Input(node, parent, binding, kind); return;
                case "select": Select(node, parent, kind); return;
                case "button": case "a": Clickable(node, parent, binding, kind); return;
                case "label": Label(node, parent); return;
                case "table" when kind == "list": Table(node, parent, binding, kind); return;
                case "option": throw Error($"{node.Where}: options come from the filter's static entity; a <select> must not contain literal options." + FragmentHint(FragmentSelect) + SelectScopeNote);
            }
            if (kind == "list") { Repeater(node, parent, binding!); return; }
            if (kind == "block")
            {
                if (tag != "div" || node.Elements.Any() || node.InnerText().Length > 0) throw Error($"{node.Where}: block binding needs an empty div");
                var wrapper = Create(parent, "IContainer", NameFor(node)); Attributes(node, wrapper, true, true, null, widget: "IContainer");
                var reference = Ref("IMobileBlock:" + Required(binding!, "block")); var contract = Contract(reference);
                if (contract != null && (contract.Placeholders.Count > 0 || contract.Events.Any(e => e.Mandatory)))
                    throw Error($"{node.Where}: block binding needs a block without placeholders or required event handlers; {Required(binding!, "block")} has "
                        + $"{(contract.Placeholders.Count > 0 ? "placeholders " + string.Join(", ", contract.Placeholders.Select(p => p.Name)) : "")}"
                        + $"{(contract.Placeholders.Count > 0 && contract.Events.Any(e => e.Mandatory) ? " and " : "")}"
                        + $"{(contract.Events.Any(e => e.Mandatory) ? "required events " + string.Join(", ", contract.Events.Where(e => e.Mandatory).Select(e => e.Name)) : "")}."
                        + FragmentHint(BlockFragment(Required(binding!, "block"), contract)));
                var args = binding!["args"]?.AsObject() ?? new(); if (contract != null) CheckArgs(contract.Inputs, args);
                var block = Create(wrapper, "IMobileBlockInstanceWidget"); ops[^1]["source"] = reference;
                foreach (var arg in args) Set(block + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                return;
            }
            // H8: a click binding on an element that is not a link or a button keeps the element and its tag.
            if (kind != null && ClickKinds.Contains(kind)) { ClickableElement(node, parent, binding!, kind); return; }
            if (tag == "div") { Container(node, parent, binding, kind); return; }
            if (tag == "br") { Create(parent, "IContainer", NameFor(node)); return; }
            if (tag == "table") staticTables++;
            var mapping = ElementWidgetMap.Map(platform, node, clickable: false);
            if (mapping.Problem != null) { Children(node, parent); return; } // reported by the validation; what is inside still compiles
            if (kind is "search" or "filter" or "date") throw new PageException(KindTag, $"html: {node.Where}: kind {kind} needs a {KindTarget(kind)}, not <{tag}>", $"put data-av=\"{node.Attribute("data-av")}\" on a {KindTarget(kind)}");
            if (mapping.Widget == "IContainer")
            {
                // A substituted tag (main in ODC, search, menuitem, a custom element) is a Container with ssam-tag-<tag>.
                var container = Create(parent, "IContainer", NameFor(node));
                Set(container, "Style", Quote(string.Join(" ", mapping.Classes)));
                foreach (var (property, value) in mapping.ExtendedProperties) if (property != "class") Extended(container, property, value);
                Inner(node, container, binding, kind);
                return;
            }
            var alias = Create(parent, "IAdvancedHtml", NameFor(node)); Set(alias, "Tag", mapping.Tag ?? tag);
            Attributes(node, alias, hasStyle: false, hasVisible: false, binding, widget: "IAdvancedHtml", substitutedClass: mapping.SubstitutedFrom != null ? ElementWidgetMap.TagClass(mapping.SubstitutedFrom) : null);
            Inner(node, alias + "/Content", binding, kind);
        }

        /// <summary>What a Link/Button cannot hold as a child widget, with what to do instead; null when the child compiles inside it
        /// (text, Containers, HTML Elements such as icons, and the bindings text/field/class/style/visible).</summary>
        private static string? InsideClickable(string tag, string? kind) => tag switch
        {
            "a" or "button" => "a Link/Button cannot contain another Link/Button (nested interactive content); move it out, or make the outer element a <div> and keep one control",
            "input" or "select" or "label" => "form controls do not belong inside a Link/Button; place the control next to it",
            "table" when kind == "list" => "a table (TableRecords) is not compiled inside a Link/Button; put the table outside and the <a>/<button> inside a cell of its template row",
            _ => kind switch
            {
                "list" => "a repeated region (List) is not compiled inside a Link/Button; put the List outside and the <a>/<button> as its row template",
                "block" => "a block instance is not compiled inside a Link/Button; place the block next to the control",
                "navigate" or "call" or "refresh" or "page" => "a clickable element cannot sit inside a Link/Button (nested interactive content); move it out",
                _ => null,
            },
        };

        /// <summary>The fragment syntax of an instance of this block: required inputs by :Name, required handlers by @Event and
        /// the content of every placeholder by &lt;slot name&gt;.</summary>
        private static string BlockFragment(string block, ScreenContract contract)
        {
            var html = new StringBuilder("<Block name='").Append(block).Append('\'');
            var inputs = contract.Inputs.Where(i => i.Mandatory && string.IsNullOrEmpty(i.Default)).ToList();
            if (inputs.Count == 0) inputs = contract.Inputs.Take(1).ToList();
            foreach (var input in inputs) html.Append(" :").Append(input.Name).Append("='expr'");
            var events = contract.Events.Where(e => e.Mandatory).ToList();
            if (events.Count == 0) events = contract.Events.Take(1).ToList();
            foreach (var ev in events) html.Append(" @").Append(ev.Name).Append("='ScreenAction'");
            html.Append('>');
            foreach (var placeholder in contract.Placeholders) html.Append("<slot name='").Append(placeholder.Name).Append("'>...</slot>");
            return html.Append("</Block>").ToString();
        }

        private static string KindTarget(string kind) => kind switch { "search" => "<input>", "filter" => "<select>", "date" => "<input type=\"date\">", "visible" => "<div>", _ => "<button> or <a>" };

        private void Container(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            if (kind is "search" or "filter" or "date") throw new PageException(KindTag, $"html: {node.Where}: kind {kind} needs a {KindTarget(kind)}, not <div>", $"put data-av=\"{node.Attribute("data-av")}\" on a {KindTarget(kind)}");
            var containerName = NameFor(node);
            if (kind == "visible")
            {
                // Screen visibility is a native If widget, never the Visible property: the If takes the element's place in the
                // parent, its Condition is the binding expression and the element is born inside the True branch.
                var condition = Required(binding!, "condition");
                var ifName = "If" + containerName;
                if (!widgetNames.Add(ifName)) throw Error($"{node.Where}: the If of key \"{node.Attribute("data-av")}\" would be named {ifName}, already used by another key; rename one of the keys");
                var branch = Create(parent, "IIfWidget", ifName); Set(branch, "Condition", condition);
                parent = branch + "/TrueBranch";
            }
            var alias = Create(parent, "IContainer", containerName);
            Attributes(node, alias, hasStyle: true, hasVisible: true, binding, widget: "IContainer");
            Inner(node, alias, binding, kind);
        }

        private void Inner(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            switch (kind)
            {
                case "text":
                    if (!TextTags.Contains(node.Tag)) throw new PageException(KindTag, $"html: {node.Where}: kind text needs a text element, not <{node.Tag}>", "put the text binding on a span, p, div, td, label ...");
                    if (node.Elements.Any()) throw Error($"{node.Where}: an element bound with kind text must not contain child elements; its whole content becomes the expression");
                    Expression(parent, Required(binding!, "value")); return;
                case "field":
                    if (listScopes.Count == 0) throw Error($"{node.Where}: kind field is only valid inside an element bound with kind list");
                    if (node.Elements.Any()) throw Error($"{node.Where}: an element bound with kind field must not contain child elements");
                    Expression(parent, Field(Required(binding!, "field"), node)); return;
                case "visible": case "style": case "class": case null: break;
                default: throw new PageException(KindTag, $"html: {node.Where}: kind {kind} cannot bind <{node.Tag}>", "bind the element with text, class, style or visible, or move the key to the element the kind needs");
            }
            Children(node, parent);
        }

        /// <summary>A repeating region: the element becomes a native List over the bound list and its single child element is the template.</summary>
        private void Repeater(HtmlNode node, string parent, JsonObject binding)
        {
            string? problem = null;
            if (!Repeaters.Contains(node.Tag)) problem = $"kind list needs a <table> or a <div>/<ul>/<ol>/<section>, not <{node.Tag}>.";
            else if (node.Elements.Count() != 1) problem = $"a repeated element needs exactly one child element as the row template; found {node.Elements.Count()}.";
            else if (node.Children.FirstOrDefault(c => c.IsText && HtmlNode.CollapseSpaces(c.Text).Length > 0) is { } stray)
                throw new PageException(ListTemplate, $"html: {stray.Where}: text outside the template of a repeated element is not compiled." + FragmentHint(FragmentList), "move the text into the row template or out of the list");
            if (problem != null)
            {
                Record(new PageException(ListTemplate, $"html: {node.Where}: {problem}" + FragmentHint(FragmentList), "keep one child element as the row template (or use the fragment form)"));
                // the template still compiles inside an open scope, so the fields of its rows report only their own problems
                listScopes.Push(new ListScope("", "", [], true)); Children(node, parent); listScopes.Pop();
                return;
            }
            var scope = List(binding, node);
            var alias = Create(parent, "IList", NameFor(node)); Set(alias, "Source", scope.List);
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding, widget: "IList");
            listScopes.Push(scope);
            try { Widget(node.Elements.First(), alias); }
            finally { listScopes.Pop(); }
        }

        private ListScope List(JsonObject binding, HtmlNode node)
        {
            // H11: a list over a local list variable of the page (vars), Source = the variable.
            if (binding["source"] is JsonObject source)
            {
                var variable = source["variable"]!.ToString();
                if (!variables.TryGetValue(variable, out var type)) throw Error($"{node.Where}: list variable '{variable}' is not declared in vars");
                if (!type.EndsWith(" List", StringComparison.OrdinalIgnoreCase)) throw Error($"{node.Where}: list variable '{variable}' is {type}, not a List");
                return new ListScope(variable, variable + ".Current", [], Open: true);
            }
            return List(SourceFor(binding["source"]?.GetValue<string>(), node.Where), binding["output"]?.GetValue<string>(), node.Where);
        }

        private SourceInfo SourceFor(string? sourceName, string where)
        {
            if (sources.Count == 0) throw Error($"{where}: needs a source");
            return sourceName == null
                ? (sources.Count == 1 ? sources[0] : throw Error($"{where}: name the source; declared: {string.Join(", ", sources.Select(s => s.As))}"))
                : sources.FirstOrDefault(s => s.As.Equals(sourceName, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"{where}: unknown source '{sourceName}'; declared: {string.Join(", ", sources.Select(s => s.As))}");
        }

        private static ListScope List(SourceInfo source, string? output, string where)
        {
            if (source.Open && !source.IsEntity) return new ListScope(source.As + "." + (output ?? "List"), source.As + "." + (output ?? "List") + ".Current", [], true);
            if (output == null)
            {
                if (source.Lists.Count != 1) throw Error($"{where}: source {source.As} has {source.Lists.Count} lists; name the output ({string.Join(", ", source.Lists.Keys)})");
                output = source.Lists.Keys.First();
            }
            if (!source.Lists.TryGetValue(output, out var list)) throw Error($"{where}: {source.As} has no list output '{output}'; available: {string.Join(", ", source.Lists.Keys)}");
            return new ListScope(list.List, list.Current, list.Fields, source.Open);
        }

        private void Input(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            var type = node.Attribute("type") ?? "text";
            if (type == "date") { Date(node, parent, binding, kind); return; }
            if (kind != "search") throw new PageException(KindTag, $"html: {node.Where}: an <input> must carry the search key or be type=\"date\" with a date binding; other inputs are not bound by this version",
                "bind it with the search key, or compile the control with the fragment form of the html op (bind=\"Variable\")");
            if (type is not ("text" or "search")) throw Error($"{node.Where}: input type {type} is not compiled; use text, search or date");
            var variable = binding!["variable"]!.ToString();
            var alias = Create(parent, "IInput", NameFor(node)); Set(alias, "Variable", variable);
            var label = binding["label"]?.GetValue<string>() ?? node.Attribute("placeholder");
            if (label != null) Set(alias, "Prompt", Bound(label, node, "placeholder"));
            if (node.Attribute("maxlength") is { } max) Set(alias, "MaxLength", int.Parse(max));
            if (node.Attribute("required") != null) Set(alias, "Mandatory", "True");
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding, widget: "IInput");
            Set(alias + "/OnChange", "Destination", RefreshAction("SearchChanged", ConsumersOf(variable), resetPaging: true, consumers: true));
        }

        /// <summary>An input type=date becomes the OutSystems UI DatePicker bound to the declared variable; selecting a date assigns it
        /// and refreshes the sources, the way the Dashboard period filter behaves today.</summary>
        private void Date(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            if (kind != "date") throw Error($"{node.Where}: an <input type=\"date\"> needs a date binding (variable, format)");
            var variable = Required(binding!, "variable");
            if (!variables.TryGetValue(variable, out var variableType)) throw Error($"{node.Where}: date variable '{variable}' is not declared in vars");
            if (variableType is not ("Date" or "Date Time")) throw Error($"{node.Where}: date variable '{variable}' must be Date or Date Time, not {variableType}");
            foreach (var (attribute, _) in node.Attributes)
                if (attribute is not ("class" or "type" or "data-av" or "id")) throw Error($"{node.Where}: attribute '{attribute}' is not carried by a DatePicker; allowed: class, id, type, data-av");
            var widgetName = NameFor(node) ?? throw Error($"{node.Where}: a date input needs a data-av key");
            if (!names)
            {
                // the DatePicker's signature needs the module; a label still targets the input of the pattern
                var placeholder = Create(parent, "IMobileBlockInstanceWidget", widgetName);
                if (node.Attribute("id") is { } inputId) idAliases[inputId] = placeholder + "/Datepicker/#IInput";
                return;
            }
            var reference = Ref("IMobileBlock:DatePicker"); var contract = Contract(reference)!;
            var ev = contract.Events.FirstOrDefault(e => e.Name == "OnSelected") ?? throw Error("DatePicker signature has no OnSelected event");
            if (!contract.Placeholders.Any(p => p.Name == "Datepicker")) throw Error("DatePicker signature has no Datepicker placeholder");
            Variable("LastDatePickerId", "Text", "\"\"");
            var block = Create(parent, "IMobileBlockInstanceWidget", widgetName); ops[^1]["source"] = reference;
            Set(block + "/Datepicker/#IInput", "Variable", variable);
            if (binding!["format"] is JsonValue format) Set(block + "/DateFormat", "Value", Quote(format.GetValue<string>()));
            if (node.Attribute("class") is { } cls && contract.Inputs.Any(i => i.Name == "ExtendedClass")) Set(block + "/ExtendedClass", "Value", Quote(HtmlNode.CollapseSpaces(cls)));
            if (node.Attribute("id") is { } id) idAliases[id] = block + "/Datepicker/#IInput"; // a label targets the input inside the pattern, not the block
            var handler = Create(Root, "IScreenAction", widgetName + "Selected");
            foreach (var p in ev.Params) { var i = Create(handler, "IInputParameter", p.Name); Set(i, "DataType", p.Type); }
            var start = Create(handler, "IStartNode");
            var assignments = new Dictionary<string, string> { [variable] = "SelectedDateTime" };
            foreach (var page in paging.Values) assignments[page.Offset] = "0";
            if (ev.Params.Any(p => p.Name == "DatePickerId")) assignments["LastDatePickerId"] = "DatePickerId";
            var assign = Assign(handler, assignments); Link(start, assign); var tail = assign;
            foreach (var source in sources) { var refresh = Create(handler, "IRefreshDataNode", "Refresh" + source.As); Set(refresh, "DataSource", source.Alias); Link(tail, refresh); tail = refresh; }
            var end = Create(handler, "IEndNode"); Link(tail, end); Add("layout", ("target", handler));
            Set(block + "/OnSelected", "Handler", handler);
            foreach (var p in ev.Params) Set(block + "/OnSelected/" + p.Name, "Value", p.Name);
        }

        private void Select(HtmlNode node, string parent, string? kind)
        {
            if (kind != "filter") throw new PageException(KindTag, $"html: {node.Where}: a <select> must carry a filter key; other selects are not bound by the page form." + FragmentHint(FragmentSelect) + SelectScopeNote,
                "bind it with a filter key, or compile it with the fragment form of the html op");
            var binding = bindings[node.Attribute("data-av")!]; var from = binding["from"]!.ToString(); var variable = binding["variable"]!.ToString();
            var aggName = "Options_" + from; var agg = Create(Root, "IScreenAggregate", aggName);
            Add("create", ("parent", agg), ("type", "IAliasedSource"), ("args", new JsonObject { ["dataSource"] = Ref("IStaticEntity:" + from) }));
            var widgetName = NameFor(node)!;
            var alias = Create(parent, "IDropdown", widgetName); Set(alias, "List", aggName + ".List");
            Set(alias, "Values", from + ".Id"); Set(alias, "Labels", from + ".Label"); Set(alias, "Variable", variable);
            var empty = binding["label"]?.GetValue<string>() ?? node.Elements.FirstOrDefault(o => o.Tag == "option" && (o.Attribute("value") ?? "").Length == 0)?.InnerText() ?? "All";
            Set(alias, "EmptyValue", Bound(empty, node, "the empty option"));
            foreach (var option in node.Elements) if (option.Tag != "option") Record(Error($"{option.Where}: only <option> is allowed inside <select>"));
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding, widget: "IDropdown");
            Set(alias + "/OnChange", "Destination", RefreshAction(widgetName + "Changed", ConsumersOf(variable), resetPaging: true, consumers: true));
        }

        private void Clickable(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            var link = node.Tag == "a";
            if (kind is not ("navigate" or "call" or "refresh" or "page"))
            {
                Record(new PageException(ControlDead, $"html: {node.Where}: a <{node.Tag}> needs a navigate, call, refresh or page binding; a dead control is not compiled",
                    $"give the <{node.Tag}> a data-av key with a navigate, call, refresh or page binding"));
                Children(node, parent); // its content still compiles, so its own problems come out too
                return;
            }
            if (link && node.Attribute("href") is { } href && href != "#") throw Error($"{node.Where}: navigation comes from the binding; use href=\"#\" or omit it");
            var text = node.InnerText(); var rich = node.Elements.Any();
            // H5: a control with no visible content is named by its aria-label or title (an icon-only button, a CSS switch).
            var labelled = text.Length == 0 && !rich && ElementWidgetMap.Labelled(node.Attributes.Select(a => (a.Key, a.Value)));
            if (text.Length == 0 && !rich && !labelled)
                throw new PageException(ContentEmpty, $"html: {node.Where}: a <{node.Tag}> needs visible content (text or child elements), an aria-label or a title",
                    $"add aria-label=\"<what it does>\" (or title) to the <{node.Tag}>, or give it text");
            var widgetName = NameFor(node)!;
            var alias = Create(parent, link ? "ILink" : "IButton", widgetName);
            // Plain text stays the widget's own caption. Child elements (a card, an icon, bound spans, a visible div) are compiled
            // as real child widgets of the Link/Button: the default caption is removed so nothing is doubled or flattened.
            if (labelled) { Add("delete", ("target", alias + "/#ITextWidget")); labelledEmptyControls++; }
            else if (!rich) Set(alias + "/#ITextWidget", "Text", text);
            else Add("delete", ("target", alias + "/#ITextWidget"));
            // The one table: a submit button is never type=submit; it is the default button and carries ssam-submit.
            var submit = !link && ElementWidgetMap.Map(platform, node, clickable: false).Classes.Contains("ssam-submit");
            Attributes(node, alias, hasStyle: true, hasVisible: true, binding, widget: link ? "ILink" : "IButton", substitutedClass: submit ? "ssam-submit" : null);
            if (submit) Set(alias, "IsDefault", true);
            if (rich)
            {
                clickables.Push(node);
                try { Children(node, alias); }
                finally { clickables.Pop(); }
            }
            var args = binding!["args"]?.AsObject() ?? new();
            switch (kind)
            {
                case "page":
                    var pageAction = PageHandler(binding, node, widgetName, alias);
                    Set(alias + "/OnClick", "Destination", pageAction); Add("layout", ("target", pageAction));
                    break;
                case "navigate":
                    var destination = Required(binding, "destination"); var reference = Ref("IMobileScreen:" + destination);
                    if (Contract(reference) is { } screen) CheckArgs(screen.Inputs, args);
                    Set(alias + "/OnClick", "Destination", reference);
                    foreach (var arg in args) Set(alias + "/OnClick/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                    break;
                case "call":
                    var (target, shellArgs) = CallHandler(binding, node, widgetName);
                    Set(alias + "/OnClick", "Destination", target);
                    foreach (var arg in shellArgs) Set(alias + "/OnClick/" + arg.Key, "Value", arg.Value);
                    break;
                case "refresh":
                    var only = binding["sources"] is JsonArray subset ? subset.Select(s => s!.GetValue<string>()).ToList() : null;
                    Set(alias + "/OnClick", "Destination", RefreshAction(widgetName + "Handler", only));
                    break;
            }
        }

        /// <summary>H8: an element that is not a link or a button with a click binding stays an HTML Element of its own tag (the
        /// card image div[role=button] keeps its tag and its CSS), with an onclick event whose handler is the screen action of the
        /// binding. With the fallback of section 3.2 (ElementWidgetMap.ElementEvents false) it is a Link with ssam-tag-&lt;tag&gt;.</summary>
        private void ClickableElement(HtmlNode node, string parent, JsonObject binding, string kind)
        {
            var tag = node.Tag;
            clickableElements[tag] = clickableElements.GetValueOrDefault(tag) + 1;
            var widgetName = NameFor(node) ?? throw Error($"{node.Where}: a clickable element needs a data-av key");
            var mapping = ElementWidgetMap.Map(platform, node, clickable: true);
            if (mapping.Widget == "ILink")
            {
                var link = Create(parent, "ILink", widgetName);
                Add("delete", ("target", link + "/#ITextWidget"));
                Attributes(node, link, hasStyle: true, hasVisible: true, binding, widget: "ILink", substitutedClass: ElementWidgetMap.TagClass(tag));
                clickables.Push(node);
                try { Children(node, link); }
                finally { clickables.Pop(); }
                var (destination, values) = Handler(binding, node, widgetName, link, kind, enabled: true);
                Set(link + "/OnClick", "Destination", destination);
                foreach (var (input, value) in values) Set(link + "/OnClick/" + input, "Value", value);
                return;
            }
            var alias = Create(parent, "IAdvancedHtml", widgetName); Set(alias, "Tag", mapping.Tag ?? tag);
            Attributes(node, alias, hasStyle: false, hasVisible: false, binding, widget: "IAdvancedHtml");
            clickables.Push(node);
            try { Inner(node, alias + "/Content", null, null); }
            finally { clickables.Pop(); }
            var (handler, arguments) = Handler(binding, node, widgetName, alias, kind, enabled: false);
            var ev = Create(alias, "IEvent"); Set(ev, "Event", "onclick"); Set(ev, "Handler", handler);
            foreach (var (input, value) in arguments) Set(ev + "/" + input, "Value", value);
        }

        /// <summary>The action an event runs for a click binding, and the arguments it passes: the screen action of the binding
        /// (navigate becomes a screen action ending in the destination, an event handler being an action).</summary>
        private (string Action, IReadOnlyList<(string Input, string Value)> Arguments) Handler(JsonObject binding, HtmlNode node, string widgetName, string alias, string kind, bool enabled)
        {
            var args = binding["args"]?.AsObject() ?? new();
            switch (kind)
            {
                case "call":
                    var (target, values) = CallHandler(binding, node, widgetName);
                    return (target, values.Select(v => (v.Key, v.Value)).ToArray());
                case "refresh":
                    var only = binding["sources"] is JsonArray subset ? subset.Select(s => s!.GetValue<string>()).ToList() : null;
                    return (RefreshAction(widgetName + "Handler", only), []);
                case "page":
                    // an HTML Element has no Enabled: the guard of the handler alone keeps the page in range
                    var pageAction = PageHandler(binding, node, widgetName, enabled ? alias : null);
                    Add("layout", ("target", pageAction));
                    return (pageAction, []);
                default:
                    var destination = Required(binding, "destination"); var reference = Ref("IMobileScreen:" + destination);
                    if (Contract(reference) is { } screen) CheckArgs(screen.Inputs, args);
                    var handler = Create(Root, "IScreenAction", widgetName + "Handler"); var start = Create(handler, "IStartNode");
                    var go = Create(handler, "IDestinationNode"); Set(go, "Destination", reference);
                    foreach (var arg in args) Set(go + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                    Link(start, go); Add("layout", ("target", handler));
                    return (handler, []);
            }
        }

        /// <summary>The destination of a call binding and the arguments the OnClick passes to it. A server, service or client
        /// action of the module (or declared by a logic op before this op) runs from a handler screen action that refreshes the
        /// sources; a screen action of this screen declared by a logic op of the job is the destination itself (H10).</summary>
        private (string Target, IReadOnlyDictionary<string, string> Arguments) CallHandler(JsonObject binding, HtmlNode node, string widgetName)
        {
            var callName = Required(binding, "action");
            var args = binding["args"]?.AsObject() ?? new();
            var pointer = "/bindings/" + Escape(node.Attribute("data-av") ?? "");
            if (shells.TryGetValue(callName, out var shell))
            {
                CheckArgs(shell.Action.Inputs, args, node, pointer);
                return (shell.Alias, args.ToDictionary(a => a.Key, a => a.Value!.GetValue<string>()));
            }
            var declared = job?.Actions.Where(a => a.Name.Equals(callName, StringComparison.OrdinalIgnoreCase)).ToList() ?? [];
            string? action = names ? tryRef(["IServerAction:" + callName, "IServiceAction:" + callName, "IClientAction:" + callName]) : null;
            IReadOnlyList<UiParam>? inputs = action != null ? Contract(action)?.Inputs : null;
            if (action == null)
            {
                if (declared.FirstOrDefault(a => a.Kind == "screen") is { } screenAction && !OwnsThisScreen(screenAction) && !declared.Any(a => a.Kind != "screen"))
                    throw new PageException(CallOtherScreen, $"html: {node.Where}: \"{callName}\" is a screen action of {screenAction.Owner} (op #{screenAction.Op}); a page calls the screen actions of its own screen ({name})",
                        $"declare {callName} with owner IMobileScreen:{name}, or as a client action (kind client, no owner)", pointer);
                if (declared.FirstOrDefault(a => a.Kind is not ("screen" or "data" or "preparation" or "rest")) is { } moduleAction)
                {
                    // F5: wherever the logic op is in the job, the kernel runs it before this page (JobComposition): the page
                    // takes the declaration (its kind and inputs) and the apply binds the action the logic op created.
                    action = (moduleAction.Kind switch { "client" => "IClientAction:", "service" => "IServiceAction:", _ => "IServerAction:" }) + moduleAction.Name;
                    inputs = moduleAction.Inputs;
                    if (names && tryRef([action]) == null)
                        throw new PageException(ReferenceUnresolved, $"html: {name}: reference not found: {action} (declared by the logic op #{moduleAction.Op}, which had not applied when this page compiled: it failed, or the kernel could not run it first)",
                            $"fix the logic op #{moduleAction.Op} if it failed; else declare {callName} in a logic op that declares nothing of this page's screen, with no raw op between it and this page (the kernel then runs it first)", pointer);
                }
                else action = Ref("IServerAction:" + callName, "IServiceAction:" + callName, "IClientAction:" + callName);
            }
            if (inputs != null) CheckArgs(inputs, args, node, pointer);
            var handler = Create(Root, "IScreenAction", widgetName + "Handler"); var start = Create(handler, "IStartNode");
            var call = Create(handler, action.Contains("ClientAction", StringComparison.Ordinal) ? "IExecuteClientActionNode" : "IExecuteServerActionNode", callName); Set(call, "Action", action);
            foreach (var arg in args) Set(call + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
            var tail = call; Link(start, call);
            foreach (var source in sources) { var refresh = Create(handler, "IRefreshDataNode", "Refresh" + source.As); Set(refresh, "DataSource", source.Alias); Link(tail, refresh); tail = refresh; }
            var end = Create(handler, "IEndNode"); Link(tail, end); Add("layout", ("target", handler));
            return (handler, new Dictionary<string, string>());
        }

        /// <summary>The screen action of a page binding (without its layout op: the caller lays it out after binding it).</summary>
        private string PageHandler(JsonObject binding, HtmlNode node, string widgetName, string? enabledTarget)
        {
            var pageSource = SourceFor(Required(binding, "source"), node.Where);
            if (!paging.TryGetValue(pageSource.As, out var page)) throw Error("page binding requires source.paging");
            var direction = Required(binding, "direction");
            if (direction is not ("next" or "previous")) throw Error("page.direction must be next or previous");
            var condition = direction == "next" ? $"{page.Offset} + {page.Size} < {page.Total}" : page.Offset + " > 0";
            if (enabledTarget != null) Set(enabledTarget, "Enabled", pageSource.As + ".IsDataFetched and (" + condition + ")");
            var pageAction = Create(Root, "IScreenAction", widgetName + "Handler"); var pageStart = Create(pageAction, "IStartNode");
            var guard = Create(pageAction, "IIfNode"); Set(guard, "Condition", condition); Link(pageStart, guard);
            var advance = Assign(pageAction, new Dictionary<string, string> { [page.Offset] = direction == "next" ? $"{page.Offset} + {page.Size}" : $"If({page.Offset} < {page.Size}, 0, {page.Offset} - {page.Size})" });
            Add("link", ("from", guard), ("connector", "TrueTarget"), ("to", advance));
            var reload = Create(pageAction, "IRefreshDataNode", "Refresh" + pageSource.As); Set(reload, "DataSource", pageSource.Alias); Link(advance, reload);
            var pageEnd = Create(pageAction, "IEndNode"); Link(reload, pageEnd); Add("link", ("from", guard), ("connector", "FalseTarget"), ("to", pageEnd));
            return pageAction;
        }

        /// <summary>H6: a label around other elements is an HTML Element of tag label (in the list of both platforms) with its
        /// children compiled, bindings included; a label of text only is a Label, its for the TargetWidget.</summary>
        private void Label(HtmlNode node, string parent)
        {
            if (node.Attribute("data-av") != null) throw Error($"{node.Where}: labels are not bound; bind the control they describe");
            if (node.Elements.Any())
            {
                labelsWithChildren++;
                if (node.InnerText().Length == 0) labelsWithoutText++;
                var wrapper = Create(parent, "IAdvancedHtml", NameFor(node)); Set(wrapper, "Tag", "label");
                Attributes(node, wrapper, hasStyle: false, hasVisible: false, null, widget: "IAdvancedHtml", keepFor: true);
                Children(node, wrapper + "/Content");
                return;
            }
            var text = node.InnerText(); if (text.Length == 0) throw new PageException(ContentEmpty, $"html: {node.Where}: a <label> needs text", "give the label its text, or put the control it names inside it");
            var alias = Create(parent, "ILabel", NameFor(node));
            // T1: the caption is a literal: its text, a binding of a constant folded into it; a binding that names something is the
            // label's Expression (its own caption goes), never the braces as text (BindingText).
            if (!ScreenHtml.HoldsBraces(text)) Set(alias + "/#ITextWidget", "Text", text);
            else if (BindingText.Literal(text) is { } folded) Set(alias + "/#ITextWidget", "Text", folded);
            else { Add("delete", ("target", alias + "/#ITextWidget")); Expression(alias, Bound(text, node, "the text")); }
            Attributes(node, alias, hasStyle: true, hasVisible: false, null, widget: "ILabel");
            if (node.Attribute("for") is { } target) labels.Add((alias, target, node));
        }

        private void Table(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            var heads = node.Elements.Where(e => e.Tag == "thead").ToList(); if (heads.Count != 1) throw Error($"{node.Where}: a bound table needs exactly one <thead>");
            var bodies = node.Elements.Where(e => e.Tag == "tbody").ToList(); if (bodies.Count != 1) throw Error($"{node.Where}: a bound table needs exactly one <tbody> with one template row");
            var head = heads[0]; var body = bodies[0];
            foreach (var other in node.Elements.Where(e => e.Tag is not ("thead" or "tbody"))) throw Error($"{other.Where}: <{other.Tag}> is not compiled inside a bound table");
            var headRows = head.Elements.Where(e => e.Tag == "tr").ToList(); if (headRows.Count != 1) throw Error($"{head.Where}: <thead> needs exactly one <tr>");
            var bodyRows = body.Elements.Where(e => e.Tag == "tr").ToList(); if (bodyRows.Count != 1) throw Error($"{body.Where}: <tbody> needs exactly one template <tr>; rows come from the data, demonstration rows are not compiled");
            var headRow = headRows[0]; var bodyRow = bodyRows[0];
            var headCells = headRow.Elements.ToList(); var bodyCells = bodyRow.Elements.ToList();
            if (headCells.Count != bodyCells.Count) throw Error($"{node.Where}: header has {headCells.Count} cells and the template row has {bodyCells.Count}; they must match");
            foreach (var cell in headCells) if (cell.Tag != "th") throw Error($"{cell.Where}: header cells must be <th>");
            foreach (var cell in bodyCells) if (cell.Tag != "td") throw Error($"{cell.Where}: template row cells must be <td>");
            var scope = List(binding!, node);
            var alias = Create(parent, "ITableRecords", NameFor(node)); Set(alias, "Source", scope.List);
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding);
            Attributes(headRow, alias, hasStyle: true, hasVisible: false, BindingOf(headRow), "StyleHeader");
            Attributes(bodyRow, alias, hasStyle: true, hasVisible: false, BindingOf(bodyRow), "StyleRow");
            foreach (var cell in headCells)
            {
                var h = Create(alias + "/HeaderRow", "IHeaderCell"); var cellBinding = BindingOf(cell); Attributes(cell, h, hasStyle: true, hasVisible: false, cellBinding);
                Inner(cell, h, cellBinding, cellBinding?["kind"]?.ToString());
            }
            listScopes.Push(scope);
            try
            {
                foreach (var cell in bodyCells)
                {
                    var c = Create(alias + "/Row", "IRowCell"); var cellBinding = BindingOf(cell); Attributes(cell, c, hasStyle: true, hasVisible: false, cellBinding);
                    Inner(cell, c, cellBinding, cellBinding?["kind"]?.ToString());
                }
            }
            finally { listScopes.Pop(); }
        }

        /// <summary>Carries the authored attributes: class to the native Style when the widget has one, else to an extended property;
        /// hidden to Visible when the widget has one; every other attribute to an extended property with its literal value (H4: the
        /// closed list of before plus everything else), disabled to Enabled = False on a control. Bindings of kind class/style/visible
        /// replace the static attribute with an expression. Inline JavaScript is reported by the validation.</summary>
        private void Attributes(HtmlNode node, string alias, bool hasStyle, bool hasVisible, JsonObject? binding, string styleProperty = "Style", string widget = "", string? substitutedClass = null, bool keepFor = false)
        {
            var kind = binding?["kind"]?.ToString();
            var dynamicClass = kind == "class" ? Required(binding!, "value") : null;
            var dynamicStyle = kind == "style" ? Required(binding!, "value") : null;
            var staticClass = node.Attribute("class") is { } c ? HtmlNode.CollapseSpaces(c) : null;
            if (substitutedClass != null) staticClass = staticClass == null ? substitutedClass : staticClass + " " + substitutedClass;
            if (dynamicClass != null || staticClass != null)
            {
                var value = dynamicClass == null ? Bound(staticClass!, node, "class") : staticClass == null ? dynamicClass : Bound(staticClass + " ", node, "class") + " + " + dynamicClass;
                if (hasStyle) Set(alias, styleProperty, value); else Extended(alias, "class", value);
            }
            if (dynamicStyle != null || node.Attribute("style") != null)
            {
                var inline = node.Attribute("style"); var value = dynamicStyle == null ? Quote(inline!) : inline == null ? dynamicStyle : Quote(inline.TrimEnd(';') + "; ") + " + " + dynamicStyle;
                // The O11 React renderer camel-cases inline property names, including --custom properties.
                // Reject that unsupported form instead of silently publishing a different style, with the CSS code (not the
                // generic HTML_INVALID) so the refusal names the kind of problem it is.
                try { CssStylesheet.RequireRenderableInline(value); }
                catch (InvalidOperationException ex) { throw new PageException(CssInvalid, $"html: {node.Where}: {ex.Message}", "bind the concrete property (e.g. width/background-color), or declare the CSS variable in the stylesheet", "/html"); }
                Extended(alias, "style", value);
            }
            foreach (var (attribute, value) in node.Attributes)
            {
                if (attribute is "data-av" or "class" or "style") continue;
                if (attribute.StartsWith("aria-", StringComparison.Ordinal) || attribute.StartsWith("data-", StringComparison.Ordinal)) { Extended(alias, attribute, Bound(value, node, attribute)); continue; }
                if (ElementWidgetMap.IsInlineScript(attribute)) continue; // reported by the validation
                if (!ElementWidgetMap.LegacyAttributes.Contains(attribute))
                {
                    // H4: what the closed list refused is carried; disabled is the native Enabled of a control.
                    if (attribute == "disabled" && ElementWidgetMap.HasEnabled(widget)) { Set(alias, "Enabled", "False"); disabledToEnabled++; continue; }
                    Extended(alias, attribute, Bound(value, node, attribute));
                    extendedAttributes[attribute] = extendedAttributes.GetValueOrDefault(attribute) + 1;
                    continue;
                }
                switch (attribute)
                {
                    case "hidden":
                        if (kind == "visible" || visibleBound.Contains(node)) break; // the binding decides visibility
                        if (hasVisible) Set(alias, "Visible", "False"); else Extended(alias, "hidden", Quote("hidden"));
                        break;
                    case "placeholder": if (node.Tag != "input") Extended(alias, attribute, Bound(value, node, attribute)); break;
                    case "for": if (node.Tag != "label" || keepFor) Extended(alias, attribute, Bound(value, node, attribute)); break;
                    case "type": if (node.Tag is not ("input" or "button")) Extended(alias, attribute, Bound(value, node, attribute)); break;
                    case "href": if (node.Tag != "a") Extended(alias, attribute, Bound(value, node, attribute)); break;
                    case "required": case "maxlength": if (node.Tag != "input") Extended(alias, attribute, Bound(value, node, attribute)); break;
                    case "value": if (node.Tag != "option") Extended(alias, attribute, Bound(value, node, attribute)); break;
                    case "id": idAliases[value] = alias; break; // reserved by OutSystems (InvalidHTMLAttribute_Id): the name of the widget (H13), and the target of labels
                    default: Extended(alias, attribute, Bound(value, node, attribute)); break;
                }
            }
            // kind visible never reaches the widget's Visible property: Container wraps the element in a native If.
            if (kind == "visible" && !hasVisible) throw Error($"{node.Where}: kind visible needs a <div>");
        }

        private void Extended(string alias, string property, string expression)
        {
            var ep = Create(alias, "IExtendedProperty"); Set(ep, "Property", property); Set(ep, "Value", expression);
        }

        // ---- helpers ------------------------------------------------------------------------------------------------

        private string Field(string field, HtmlNode node)
        {
            var scope = listScopes.Peek();
            if (scope.Open) return (scope.Current.Length == 0 ? "Row" : scope.Current) + "." + field;
            var found = scope.Fields.FirstOrDefault(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase))
                ?? throw Error($"{node.Where}: field '{field}' does not exist in the row; available: {string.Join(", ", scope.Fields.Select(f => f.Name))}");
            return scope.Current + "." + found.Name;
        }

        /// <summary>The name of the widget an element creates: the data-av key in PascalCase (H12: the same key on N elements
        /// names them Name, Name2 ..., Name_2 after a digit), else its id (H13, ElementWidgetMap.NameFromId), else none.</summary>
        private string? NameFor(HtmlNode node)
        {
            if (preNamed.TryGetValue(node, out var known)) return known;
            if (node.Attribute("data-av") is { } key)
            {
                var widgetName = Pascal(key) ?? throw Error($"{node.Where}: key \"{key}\" does not yield a valid name");
                if (keyNames.ContainsKey(key))
                {
                    var n = keyRepeats[key] + 1;
                    while (widgetNames.Contains(Numbered(widgetName, n))) n++;
                    keyRepeats[key] = n;
                    widgetNames.Add(Numbered(widgetName, n));
                    return preNamed[node] = Numbered(widgetName, n);
                }
                if (!widgetNames.Add(widgetName)) throw Error($"{node.Where}: key \"{key}\" yields the name {widgetName}, already used by another key");
                keyNames[key] = widgetName; keyRepeats[key] = 1;
                return preNamed[node] = widgetName;
            }
            if (ElementWidgetMap.NameFromId(node.Attribute("id")) is { } fromId)
            {
                if (!widgetNames.Add(fromId))
                {
                    Record(new PageException(IdDuplicate, $"html: {node.Where}: id=\"{node.Attribute("id")}\" names the widget {fromId}, already the name of another element of this page",
                        $"give the element another id (the widget names are case-insensitive)"));
                    return preNamed[node] = null;
                }
                return preNamed[node] = fromId;
            }
            return null;
        }
        private static bool Mentions(string expression, string variable) => System.Text.RegularExpressions.Regex.IsMatch(expression, @"(?<![\w.])" + System.Text.RegularExpressions.Regex.Escape(variable) + @"(?![\w])");
        private void Add(string op, params (string, object?)[] values)
        {
            var node = new JsonObject { ["op"] = op };
            foreach (var (key, value) in values) node[key] = value is JsonNode json ? json.DeepClone() : System.Text.Json.JsonSerializer.SerializeToNode(value);
            ops.Add(node);
        }
        private void Set(string target, string prop, object value)
        {
            if (value is string original && prop is "Value" or "Condition" or "Visible" or "Enabled" or "DefaultValue" or "RecordList")
                value = System.Text.RegularExpressions.Regex.Replace(original, "\"(?:\"\"|[^\"])*\"|(?<![\\w.])[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*(?![\\w])",
                    m => sourceOutputNames.TryGetValue(m.Value, out var mapped) ? mapped : m.Value);
            if (value is string expression && prop is "Value" or "Condition" or "Visible" or "Enabled" or "DefaultValue")
                value = System.Text.RegularExpressions.Regex.Replace(expression, "\"(?:\"\"|[^\"])*\"|(?<![\\w.])[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()",
                    m => scriptNames.TryGetValue(m.Value, out var mapped) ? mapped : m.Value);
            Add("set", ("target", target), ("prop", prop), ("value", value));
        }
        private string Create(string parent, string type, string? nodeName = null, string? alias = null)
        {
            alias ??= Root + ".e" + (++counter);
            Add("create", ("parent", parent), ("type", type), ("name", nodeName), ("as", alias)); return alias;
        }
        private void Expression(string parent, string text) { var e = Create(parent, "IExpression"); Set(e, "Value", text); }

        // T1: a text or an attribute value that takes an expression, by the one compile of a text with bindings
        // (BindingText.Expression): {{ E }} is E, text with bindings their concatenation, a value without one its string literal.
        private static string Bound(string value, HtmlNode node, string what) => BindingText.Expression(value, out var fault)
            ?? throw new PageException(BindingInvalid, $"html: {node.Where}: {what} \"{value}\": {fault}",
                "a binding is {{ expression }} (text around it is joined: \"Total {{ N }}\"); a literal brace is written &#123; in <text>, or split in an expression", "/html");
        private void Where(string alias, string text) => Add("create", ("parent", alias), ("type", "IFilter"), ("args", new JsonObject { ["condition"] = text }));
        private string Assign(string action, IReadOnlyDictionary<string, string> values)
        {
            var assign = Create(action, "IAssignNode"); Set(assign, "Label", "SetValues");
            foreach (var pair in values) { var item = Create(assign, "IAssignment"); Set(item, "Variable", pair.Key); Set(item, "Value", pair.Value); }
            return assign;
        }
        private void Link(string from, string to) => Add("link", ("from", from), ("to", to));
        private static void CheckArgs(IReadOnlyList<UiParam> inputs, JsonObject args, HtmlNode? node = null, string? pointer = null)
        {
            var where = node == null ? "" : node.Where + ": ";
            foreach (var arg in args)
                if (!inputs.Any(p => p.Name.Equals(arg.Key, StringComparison.OrdinalIgnoreCase)))
                    throw new PageException(ArgumentInvalid, $"html: {where}unknown argument '{arg.Key}'; available: {string.Join(", ", inputs.Select(p => p.Name))}",
                        inputs.Count == 0 ? $"remove args.{arg.Key}" : $"use one of: {string.Join(", ", inputs.Select(p => p.Name))}", pointer);
            foreach (var input in inputs.Where(p => p.Mandatory && string.IsNullOrEmpty(p.Default)))
                if (!args.Any(p => p.Key.Equals(input.Name, StringComparison.OrdinalIgnoreCase)))
                    throw new PageException(ArgumentInvalid, $"html: {where}missing required argument '{input.Name}'", $"add args.{input.Name} ({input.Type})", pointer);
        }
        private static string Sha(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    }

    /// <summary>The fix of a code without one of its own (H15): never the fragment form for a problem of the page.</summary>
    internal static string FixOf(string code) => code switch
    {
        TagNotAllowed => "use div or a tag of the platform list (api --op html, platformTags)",
        KeyUnbound => "declare the binding of the key, or remove data-av",
        BindingOrphan => "add data-av=\"<key>\" to the element it describes, or remove the binding (the patch)",
        ReferenceUnresolved => "name an element the module has or references, or create it in an earlier op of the job",
        _ => "fix the element at the line and column the message names; the rules of the page form: api --op html",
    };

    /// <summary>A data-av key in PascalCase (fv.284 -> Fv284), or null when it yields no valid name.</summary>
    private static string? Pascal(string key)
    {
        var sb = new StringBuilder(); var upper = true;
        foreach (var ch in key) { if (char.IsLetterOrDigit(ch)) { sb.Append(upper ? char.ToUpperInvariant(ch) : ch); upper = false; } else upper = true; }
        var widgetName = sb.ToString();
        return widgetName.Length == 0 || !char.IsLetter(widgetName[0]) ? null : widgetName;
    }
    private static string Numbered(string name, int n) => char.IsDigit(name[^1]) ? name + "_" + n : name + n;
    private static string Capitalise(string tag) => tag.Length == 0 ? "W" : char.ToUpperInvariant(tag[0]) + tag[1..];
    private static string Escape(string key) => key.Replace("~", "~0").Replace("/", "~1");

    private static string Quote(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
    private static string Required(JsonObject o, string key) => o[key]?.GetValue<string>() is { Length: > 0 } value ? value : throw Error($"missing '{key}'");
    private static List<JsonObject> Objects(JsonObject o, string key) => o[key] is JsonArray array ? array.Select(n => n as JsonObject ?? throw Error($"{key} entries must be objects")).ToList() : o[key] == null ? [] : throw Error($"{key} must be an array");
    private static IEnumerable<string> Texts(JsonNode? node) => node == null ? [] : node is JsonArray array ? array.Select(n => n!.GetValue<string>()) : [node.GetValue<string>()];
    private static void Keys(JsonObject o, string shape, string? where = null)
    {
        var unknown = o.Select(p => p.Key).Except(Shapes[shape], StringComparer.Ordinal).ToArray();
        if (unknown.Length > 0) throw Error($"{where ?? shape}: unknown keys: {string.Join(", ", unknown)}; allowed: {string.Join(", ", Shapes[shape])}");
    }
    private static InvalidOperationException Error(string message) => new("html: " + message);
}
