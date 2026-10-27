using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
namespace Anvil.Core;

/// <summary>The ops the fragment compiles to, the report, and the stylesheet rewritten under the fragment root class.
/// <see cref="Ids"/>: each authored id and the alias of its widget; <see cref="Created"/>: the widget names the ops give.</summary>
public sealed record HtmlVisualFragment(List<JsonObject> Ops, JsonObject Report, string? ScopedCss, string? ScopeClass)
{
    public IReadOnlyList<(string Alias, string Tag, int Line)> RowGroups { get; init; } = [];
    public IReadOnlyDictionary<string, string> Ids { get; init; } = new Dictionary<string, string>();
    public IReadOnlyCollection<string> Created { get; init; } = [];
    /// <summary>The widgets the fragment creates without class whose type the Studio gives a class (ScreenVisual.DecisionFor):
    /// their alias, type and line. The op gives each the class of F2 once they exist (ScreenVisual.StudioClassOf).</summary>
    public IReadOnlyList<(string Alias, string Type, int Line)> Unclassed { get; init; } = [];
}

/// <summary>
/// What the module already offers the fragment. The visual compiler creates no logic, no data and no variables: it binds by
/// name to what is there, so every name the fragment mentions is checked against these lists before a single op is emitted.
/// <paramref name="Supports"/> answers "does this Studio's widget have this property" (O11's IIcon has no Weight, the ODC one
/// has); without it the kernel's own Reactive/Mobile vocabulary answers. <paramref name="InputTypes"/> gives, per variable, the
/// InputType its data type implies (a Time variable is an input of type Time, as the Studio does when a variable is dropped).
/// <paramref name="BindTypes"/> gives the basic data type of what a bind may name (a variable, or Var.Attribute of a record):
/// the bound type decides the InputType, as the Verify demands ("Input type is a Phone but it should be Text").
/// </summary>
public sealed record HtmlVisualScope(
    IReadOnlyCollection<string> Variables,
    IReadOnlyDictionary<string, string> Actions,
    IReadOnlyDictionary<string, string> Blocks,
    IReadOnlyDictionary<string, string> Images,
    Func<string, ScreenContract?> Contract,
    Func<string, string, bool>? Supports = null,
    IReadOnlyDictionary<string, string>? InputTypes = null,
    IReadOnlyDictionary<string, string>? BindTypes = null)
{
    public static HtmlVisualScope Empty { get; } = new([], Map(), Map(), Map(), _ => null);
    public static Dictionary<string, string> Map() => new(StringComparer.OrdinalIgnoreCase);
    public bool Accepts(string type, string property) => Supports?.Invoke(type, property) ?? Known(type, property);
    internal static JsonObject? Property(string type, string property)
    {
        vocabulary ??= ScreenSpecification.Vocabulary;
        return (vocabulary["mobile:" + type]?["properties"] as JsonObject)?
            .FirstOrDefault(p => p.Key.Equals(property, StringComparison.OrdinalIgnoreCase)).Value as JsonObject;
    }

    /// <summary>The screens a link or a button may navigate to (onclick or href naming a screen): name -> reference.</summary>
    public IReadOnlyDictionary<string, string>? Screens { get; init; }
    /// <summary>The widget names already used in the screen or block that receives the fragment (the base and every op of the
    /// job applied before it): a generated name skips them, an id that repeats one is refused (C05 of the atritos 3 package).</summary>
    public IReadOnlySet<string>? Taken { get; init; }
    /// <summary>The part of <see cref="Taken"/> that earlier html fragments of the same job created: an id that repeats one of
    /// them is HTML_ID_DUPLICATE, any other repeat NAME_COLLISION.</summary>
    public IReadOnlySet<string>? Earlier { get; init; }
    /// <summary>The key of the screen or block that receives the fragment (where <see cref="Earlier"/> is kept).</summary>
    public string? Owner { get; init; }

    private static JsonObject? vocabulary;
    private static bool Known(string type, string property)
    {
        vocabulary ??= ScreenSpecification.Vocabulary;
        return vocabulary["mobile:" + type]?["properties"]?[property] != null;
    }
}

/// <summary>
/// The visual half of HTML authoring: a fragment of HTML becomes widgets and CSS inside a parent that already exists, and
/// nothing else. Logic, data, events, parameters and variables stay native — the fragment only names what the module already
/// has (a variable for <c>bind</c>, a screen or client action for <c>onclick</c> and <c>@Event</c>, a block for
/// <c>&lt;Block name&gt;</c>, an image for <c>&lt;img src&gt;</c>). A name that does not exist is an error with the line, the
/// column, the name that is missing and the list of the names that do exist, raised before the first op. Every problem of a
/// fragment comes out at once, in one coded refusal (HTML_INVALID, with HTML_TAG_NOT_ALLOWED, INPUT_TYPE_MISMATCH and
/// CSS_FUNCTION_UNSUPPORTED among its problems), pointers relative to the op (I4 of the atritos 2 package). The ops emitted
/// are the same <c>create</c>/<c>set</c> verbs the HtmlExpander emits; the closed syntax is HtmlVisualVocabulary.json.
/// </summary>
public static class HtmlVisual
{
    // <div> is the only tag with a native container; every other tag the HTML Element of the platform accepts (ElementWidgetMap,
    // the one table of the html op and the importer: 103 in O11, 100 in ODC) carries its own tag into an HTML Element widget, a
    // static table included. <br> is an empty Container (a block that breaks the line): the Verify refuses Tag br ("'br' is not a
    // valid HTML tag"). A tag outside the list has the fixed substitute of the table (main in ODC, search, a custom element: a
    // div with ssam-tag-<tag>) or is refused.
    private static readonly string Platform = ElementWidgetMap.CurrentPlatform;
    private static readonly HashSet<string> Elements = new(ElementWidgetMap.Tags(ElementWidgetMap.CurrentPlatform)
        .Where(t => t is not ("div" or "i" or "img" or "input" or "textarea" or "select" or "button" or "a" or "label" or "style" or "form" or "option" or "optgroup" or "link")), StringComparer.Ordinal);
    private static readonly Dictionary<string, string> InputTypes = new(StringComparer.Ordinal)
    {
        ["text"] = "Text", ["password"] = "Password", ["number"] = "Number", ["time"] = "Time", ["date"] = "Date",
        ["datetime-local"] = "Datetime", ["tel"] = "Phone", ["email"] = "Email", ["search"] = "Search",
    };
    // Attributes the syntax spends on the widget itself; everything else becomes an extended property with its literal value.
    private static readonly HashSet<string> Reserved = new(StringComparer.Ordinal)
    { "class", "id", "icon", "weight", "bind", "content", "placeholder", "type", "options", "value", "label", "onclick", "onchange", "for", "src", "list", "as", "if", "else", "name", "href", "filename", "show" };
    // Widgets the model gives no extended properties: an attribute they cannot carry is an error, not a silent drop.
    private static readonly HashSet<string> NoAttributes = new(StringComparer.Ordinal) { "IIfWidget", "IMobileBlockInstanceWidget" };
    private static readonly Regex WidgetNameShape = new("^[A-Za-z][A-Za-z0-9_]*$");
    // onclick="Name" or onclick="Name(arg, ...)": an action or a screen, with its arguments in the order of its inputs.
    private static readonly Regex CallShape = new(@"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*;?\s*$", RegexOptions.Singleline);
    // An image source that is not a module image: a URL the browser loads (Type External).
    private static readonly Regex UrlShape = new(@"^(?:https?:)?//|^data:", RegexOptions.IgnoreCase);
    private const string Invalid = "HTML_INVALID";
    private const string TagNotAllowed = "HTML_TAG_NOT_ALLOWED";
    private const string InputMismatch = "INPUT_TYPE_MISMATCH";
    private const string IdDuplicate = "HTML_ID_DUPLICATE";
    private const string NameCollision = "NAME_COLLISION";
    private const string ArgumentUnknown = "ARGUMENT_UNKNOWN";
    private const string ArgumentRequired = "REQUIRED_ARGUMENT";

    /// <summary>The closed syntax, machine readable: one entry per row of the table in docs/UI-HTML-VISUAL.md.</summary>
    public static JsonObject Schema() => new()
    {
        ["op"] = "html",
        ["shape"] = new JsonObject { ["parent"] = "the widget that receives the fragment (a screen: its Content)", ["file"] = "path of the .html fragment", ["html"] = "the fragment inline, instead of file" },
        ["tags"] = new JsonObject
        {
            ["div"] = Row("IContainer", "class -> Style, id -> Name"),
            ["(html element)"] = Row("IAdvancedHtml", "Tag = the tag, class -> extended property; any tag of the platform's HTML Element (api --op html, platformTags), tables too; br: an empty Container"),
            ["form"] = Row("IForm", "class -> Style; children are its content"),
            ["popup"] = Row("IPopup", "show -> ShowPopup; children are native popup content; events inside use Fade"),
            ["radio-group"] = Row("IRadioGroup", "bind -> Variable; radio-button value -> Value; onchange names an action"),
            ["radio-button"] = Row("IRadioButton", "value -> Value; children are its caption"),
            ["placeholder"] = Row("IPlaceholderWidget", "name -> Name; native block placeholder"),
            ["list-item"] = Row("IListItem", "native list item with authored children"),
            ["expr"] = Row("IExpression", "value is an OutSystems expression"),
            ["text"] = Row("ITextWidget", "children are explicit literal text, including literal braces"),
            ["(literal text)"] = Row("ITextWidget", "no class of its own; a space next to an inline element stays"),
            ["{{ expression }}"] = Row("IExpression", "OutSystems, copied as written (never JavaScript); a binding of a constant ({{ \"Search\" }}) is folded into the text around it"),
            ["i"] = Row("IIcon", "icon = the icon name; weight where the icon has one (ODC: mandatory; the O11 icon has none, as its reading writes it)"),
            ["input"] = Row("IInput", "bind names an existing variable, placeholder -> Prompt, type " + string.Join("|", InputTypes.Keys)
                + "; the bound data type decides the InputType"),
            ["input[type=checkbox]"] = Row("ICheckbox", "bind names an existing variable"),
            ["textarea"] = Row("ITextArea", "bind names an existing variable"),
            ["select"] = Row("IDropdown", "bind -> Variable, options -> List, value -> Values, label -> Labels, empty -> EmptyValue; value and label read the element of options by its attributes (Item.Id for an aggregate over Item, Id for a list of records), never options.Current"),
            ["button"] = Row("IButton", "onclick (or href): an action or screen, Name(args) or :Input passes inputs; children are its content; empty with aria-label/title"),
            ["a"] = Row("ILink", "as button"),
            ["label"] = Row("ILabel", "for -> TargetWidget (an input id of the fragment); with child elements: an HTML Element label with them"),
            ["img"] = Row("IImage", "src: module image, URL or {{ }}"),
            ["div[list]"] = Row("IList", "Source = list; as is mandatory and names the row inside {{ }}"),
            ["(html element)[list]"] = Row("IList", "Source = list; Tag preserves the element; as names the row inside {{ }}"),
            ["div[if]"] = Row("IIfWidget", "children: True branch; a <div else> right after: False branch"),
            ["Block"] = Row("IMobileBlockInstanceWidget", "name = an existing block, inputs by :Name, handlers by @Event=\"Action\" or, as the reading writes them, @Event=\"Action(Input = expression)\", children by <slot name>"),
            ["ButtonGroup"] = Row("IButtonGroup", "bind -> Variable; each <ButtonGroupItem value> an IButtonGroupItem, its text an Expression; also written <button-group> and <button-group-item>"),
            ["switch"] = Row(ElementWidgetMap.LanguageElements["switch"].Widget, "bind names an existing Boolean variable"),
            ["upload"] = Row(ElementWidgetMap.LanguageElements["upload"].Widget, "content or bind -> FileContent (a Binary Data variable), filename -> FileName; accept -> Accept; no enabled or disabled (no Upload has Enabled, in either lane)"),
            ["style"] = Row("(theme)", "scoped under the root class; light-dark() expanded, @keyframes kept, @import to the top"),
        },
        ["attributes"] = "enabled/disabled, required/mandatory, maxlength and empty use native properties; onchange names a native action; unsupported os-* is refused; any other attribute: an IExtendedProperty, {{ }} makes an expression",
        ["names"] = "id: name, alias $id; else Tag1, Tag2; Block none",
        ["rejected"] = new JsonArray("script", "an <i> without weight where the icon has one (ODC)", "a name that does not exist in the module", "a tag outside this table", "color-mix()"),
    };
    private static JsonObject Row(string widget, string rule) => new() { ["widget"] = widget, ["rule"] = rule };

    /// <param name="parentRef">The widget that receives the fragment: an alias ($screen), a key or Type:Name.</param>
    /// <param name="resolve">What the module already has; every name the fragment mentions is checked against it.</param>
    /// <param name="pointer">Where the fragment sits in its op ("/html" or "/file"): the pointer of every problem (I4).</param>
    public static HtmlVisualFragment Expand(string html, string parentRef, HtmlVisualScope resolve, string? pointer = null)
    {
        if (string.IsNullOrWhiteSpace(parentRef)) throw NoParent();
        return new Compiler(Parse(html, pointer ?? ""), parentRef, resolve, names: true, pointer ?? "").Run();
    }

    private static Exception NoParent() => Refusal([new(Invalid, "html: a fragment needs a parent widget", "add \"parent\": the widget that receives the fragment ($alias, @key or Type:Name)")], "/parent");

    // The widget names each html fragment of a job created, per screen or block: one table per session (the job), so a
    // resident worker never mixes two jobs.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, Dictionary<string, HashSet<string>>> FragmentNames = new();

    /// <summary>The names earlier fragments of this job created in <paramref name="owner"/>.</summary>
    internal static IReadOnlySet<string> Earlier(object session, string? owner)
        => owner != null && FragmentNames.TryGetValue(session, out var byOwner) && byOwner.TryGetValue(owner, out var names) ? names : new HashSet<string>();

    internal static void Remember(object session, string? owner, IEnumerable<string> names)
    {
        if (owner == null) return;
        var byOwner = FragmentNames.GetOrCreateValue(session);
        if (!byOwner.TryGetValue(owner, out var set)) byOwner[owner] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        set.UnionWith(names);
    }

    /// <summary>What check-job can prove without a module: the fragment and its stylesheet parse, the tags and attributes are
    /// the closed syntax, the structure compiles (else, lists, labels, inputs, names), the stylesheet respects the id rule and
    /// renders. Every problem at once. The names still need the module.</summary>
    public static JsonObject Preflight(string html, string parentRef) => Preflight(html, parentRef, "");

    private static JsonObject Preflight(string html, string parentRef, string pointer)
    {
        if (string.IsNullOrWhiteSpace(parentRef)) throw NoParent();
        return new Compiler(Parse(html, pointer), parentRef, HtmlVisualScope.Empty, names: false, pointer).Preflight();
    }

    private static HtmlNode Parse(string html, string pointer)
    {
        try { return HtmlSource.Parse(html); }
        catch (InvalidOperationException ex) when (ex is not ICodedError) { throw Refusal([new(Invalid, ex.Message, null)], pointer); }
    }

    private static readonly HashSet<string> CompiledTags = new(StringComparer.Ordinal)
    { "div", "i", "img", "input", "textarea", "select", "button", "a", "label", "block", "slot", "style", "br", "buttongroup", "buttongroupitem", "form",
      // the rows of the language with no HTML tag of their own (ElementWidgetMap.LanguageElements, the one table)
      "switch", "upload", "popup", "button-group", "button-group-item", "radio-group", "radio-button", "placeholder", "expr", "text", "list-item" };

    /// <summary>A tag outside the platform list that the one table replaces by a div (main in ODC, search, menuitem, a custom
    /// element, a dialog) or a span (data, picture in ODC): the element keeps its class ssam-tag-&lt;tag&gt;.</summary>
    private static bool Substituted(string tag) => ElementWidgetMap.Substitute(Platform, tag) is { Widget: "IContainer" or "IAdvancedHtml" } && tag != "br";

    /// <summary>The op as the job writes it: html inline, or file read next to the repository root. A fragment in a file is
    /// read here too (the same Source the apply reads), so its tags and attributes are checked before any model is loaded.</summary>
    public static void PreflightOp(JsonObject op)
    {
        if (op["html"] is not JsonValue && op["file"] is not JsonValue)
            throw Refusal([new(Invalid, "html: a fragment op needs file=\"<path>.html\" or html=\"<fragment>\"", "add \"html\": \"<fragment>\" or \"file\": \"<path>.html\"")], "");
        var pointer = op["html"] is JsonValue ? "/html" : "/file";
        var text = Source(op);
        try { Preflight(text, op["parent"]?.ToString() ?? "", pointer); }
        catch (Exception ex) when (op["file"] is JsonValue file && op["html"] is null)
        {
            // Each problem names the file it comes from, as the one-line refusal did before the problems were coded (I4).
            if (Errors.FindCoded(ex) is { Problems: { Count: > 0 } list } coded)
                throw new KernelRefusalException(coded.Code, $"fragment file {file}: {ex.Message}", new JsonArray(list.OfType<JsonObject>().Select(p =>
                {
                    var named = p.DeepClone().AsObject();
                    named["message"] = $"fragment file {file}: {p["message"]}";
                    return (JsonNode)named;
                }).ToArray()));
            throw new InvalidOperationException($"fragment file {file}: {ex.Message}", ex);
        }
    }

    /// <summary>The fragment text of an op: inline, or the file resolved against the working directory and the repository.</summary>
    public static string Source(JsonObject op)
    {
        if (op["html"] is JsonValue inline) return inline.GetValue<string>();
        var file = op["file"]?.GetValue<string>() ?? throw new InvalidOperationException("html: a fragment op needs file=\"<path>.html\" or html=\"<fragment>\"");
        var roots = new[] { Directory.GetCurrentDirectory(), JobRunner.RepoRoot(Directory.GetCurrentDirectory()), JobRunner.RepoRoot(AppContext.BaseDirectory) };
        var tried = new List<string>();
        foreach (var candidate in new[] { file }.Concat(roots.Where(r => r != null).Select(r => Path.Combine(r!, file))))
        {
            var full = Path.GetFullPath(candidate);
            if (File.Exists(full)) return File.ReadAllText(full);
            tried.Add(full);
        }
        throw new InvalidOperationException($"html: fragment file not found: {file} (tried {string.Join(", ", tried.Distinct())})");
    }

    private sealed record ListScope(string Alias, string Source);
    private sealed record FragmentProblem(string Code, string Message, string? Fix);

    /// <summary>A problem of one element: the compiler records it and goes on with the next one.</summary>
    private sealed class FragmentException(string code, string message, string? fix) : InvalidOperationException(message)
    {
        public string Code { get; } = code;
        public string? Fix { get; } = fix;
    }

    /// <summary>All the problems of a fragment at once (I4): one keeps the exception callers always got (same type and text) with
    /// the coded problem inside; several are one KernelRefusalException HTML_INVALID.</summary>
    private static Exception Refusal(IReadOnlyList<FragmentProblem> problems, string pointer)
    {
        var coded = new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, p.Code, "error", p.Message, p.Fix))).ToArray());
        if (problems.Count == 1)
            return new InvalidOperationException(problems[0].Message, new KernelRefusalException(problems[0].Code, problems[0].Message, coded));
        return new KernelRefusalException(Invalid, $"html: {problems.Count} problems in the fragment, all reported at once: "
            + string.Join(" | ", problems.Select((p, i) => $"({i + 1}) {p.Message}")), coded);
    }

    /// <summary>Where a link or a button goes: the action or screen it names, and the arguments the author wrote (positional
    /// in parentheses, or :Input attributes). <see cref="Explicit"/>: the author listed the arguments.</summary>
    private sealed record Target(string Name, string Reference, bool Screen, IReadOnlyList<string>? Positional, IReadOnlyList<(string Name, string Value)> Named)
    {
        public bool Explicit => Positional != null || Named.Count > 0;
    }

    private sealed class Compiler(HtmlNode root, string parentRef, HtmlVisualScope resolve, bool names, string pointer)
    {
        private readonly List<JsonObject> ops = [];
        private readonly Dictionary<string, int> counters = new(StringComparer.Ordinal);
        private readonly HashSet<string> widgetNames = new(StringComparer.OrdinalIgnoreCase);
        // Every id the fragment writes: a generated name never takes one, wherever the element with that id is.
        private readonly HashSet<string> authoredIds = new(root.Descendants().Where(n => !n.IsText).Select(n => n.Attribute("id")).OfType<string>().Where(i => i.Length > 0), StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> idAliases = new(StringComparer.Ordinal);
        private readonly List<(string Label, string Id, HtmlNode Node)> labels = [];
        private readonly Stack<ListScope> listScopes = new();
        private readonly List<string> bound = [], called = [], blocks = [], images = [], screens = [];
        private readonly List<FragmentProblem> problems = [];
        private readonly Dictionary<(HtmlNode Node, string Event), Target?> targets = [];
        private readonly JsonArray adjusted = [], implicitArguments = [], canvasSelectors = [];
        private readonly List<string> importsHoisted = [];
        private readonly List<(string Alias, string Type, int Line)> unclassed = [];
        private readonly List<(string Alias, string Tag, int Line)> rowGroups = [];
        private int counter, lightDark, popupDepth;

        private void Record(InvalidOperationException error)
        {
            var problem = error is FragmentException f ? new FragmentProblem(f.Code, f.Message, f.Fix) : new FragmentProblem(Invalid, error.Message, null);
            if (!problems.Any(p => p.Message == problem.Message)) problems.Add(problem);
        }

        private void Settle()
        {
            if (problems.Count > 0) throw Refusal(problems, pointer);
        }

        public JsonObject Preflight()
        {
            var css = Compile();
            return new JsonObject
            {
                ["parent"] = parentRef,
                ["elements"] = root.Descendants().Count(n => !n.IsText),
                ["cssRules"] = css.Rules,
                ["scope"] = "Tags, attributes, structure and the stylesheet. Variables, actions, blocks and images are checked against the module.",
            };
        }

        public HtmlVisualFragment Run()
        {
            var css = Compile();
            var report = new JsonObject
            {
                ["parent"] = parentRef,
                ["widgets"] = counter,
                ["names"] = Names(widgetNames),
                ["bound"] = Names(bound),
                ["actions"] = Names(called),
                ["blocks"] = Names(blocks),
                ["images"] = Names(images),
                ["css"] = new JsonObject { ["scope"] = css.Scope == null ? null : "." + css.Scope, ["rules"] = css.Rules },
            };
            if (screens.Count > 0) report["screens"] = Names(screens);
            if (lightDark > 0) report["css"]!["lightDarkExpanded"] = lightDark;
            if (canvasSelectors.Count > 0) report["css"]!["cssRewrites"] = canvasSelectors;
            if (importsHoisted.Count > 0) report["css"]!["cssImportsHoisted"] = new JsonArray(importsHoisted.Select(i => (JsonNode)i).ToArray());
            if (adjusted.Count > 0) report["inputTypes"] = adjusted;
            if (implicitArguments.Count > 0) report["implicitArguments"] = implicitArguments;
            if (root.Notes.Count > 0) report["notes"] = new JsonArray(root.Notes.Select(n => (JsonNode)n).ToArray());
            return new HtmlVisualFragment(ops, report, css.Text, css.Scope)
            {
                Ids = new Dictionary<string, string>(idAliases, StringComparer.Ordinal),
                Created = widgetNames.ToArray(),
                Unclassed = unclassed.ToArray(),
                RowGroups = rowGroups.ToArray(),
            };
        }

        /// <summary>Validation, stylesheet and widgets, each element on its own: the problems of all of them, then the refusal.</summary>
        private (string? Text, string? Scope, int Rules) Compile()
        {
            Tags();
            Validate(root, "#root");
            (string? Text, string? Scope, int Rules) css = (null, null, 0);
            try { css = Stylesheet(); }
            catch (InvalidOperationException ex) { Record(ex); }
            Children(root, parentRef);
            foreach (var (label, id, node) in labels)
            {
                if (!idAliases.TryGetValue(id, out var target))
                    Record(Error($"{node.Where}: for=\"{id}\" does not name a widget of this fragment; ids here: {Join(idAliases.Keys)}"));
                else Set(label, "TargetWidget", target);
            }
            Settle();
            return css;
        }
        private static JsonArray Names(IEnumerable<string> values) => new(values.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Select(v => (JsonNode)v).ToArray());

        private static bool Allowed(HtmlNode node) => node.IsText || node.Tag == "script" || CompiledTags.Contains(node.Tag) || Elements.Contains(node.Tag) || Substituted(node.Tag);

        /// <summary>The tag whitelist of the closed syntax, every tag at once, in one problem.</summary>
        private void Tags()
        {
            var outside = root.Descendants().Where(n => !Allowed(n)).ToArray();
            if (outside.Length == 0) return;
            var where = outside.Select(n => $"<{n.SourceTag}> at line {n.Line} col {n.Column}").Distinct();
            Record(Error($"{string.Join(", ", where)} is not compiled; supported tags: div, the tags of the platform's HTML Element ({Join(Elements)}), br, i, img, input, textarea, select, button, a, label, form, Block, ButtonGroup, slot, style", TagNotAllowed, "use div or a tag of the table"));
        }

        // ---- names: nothing is emitted before every name the fragment mentions is known to exist ---------------------

        /// <summary>Every check of every element runs: a problem of one check never hides the next check of the same element
        /// nor the elements inside it (C13 item 9 of the atritos 3 package: an &lt;a&gt; reported only its first problem).</summary>
        private void Validate(HtmlNode node, string parentTag)
        {
            foreach (var child in node.Children)
            {
                if (child.IsText || !Allowed(child)) continue;
                var tag = child.Tag;
                if (tag == "style") continue;
                void Check(Action check)
                {
                    try { check(); }
                    catch (InvalidOperationException ex) { Record(ex); }
                }
                switch (tag)
                {
                    case "script": Record(Error($"{child.Where}: <script> is not compiled; logic is native, written as a logic spec", TagNotAllowed)); break;
                    case "slot":
                        if (parentTag != "block") Record(Error($"{child.Where}: <slot> only belongs directly inside a <Block>"));
                        if (child.Attribute("name") is not { Length: > 0 }) Record(Error($"{child.Where}: <slot> needs name=\"<placeholder>\""));
                        break;
                    case "block": Check(() => ValidateBlock(child)); break;
                    case "i":
                        if (child.Attribute("icon") is not { Length: > 0 }) Record(Error($"{child.Where}: <i> needs icon=\"<name>\""));
                        if (IconWeighs && child.Attribute("weight") is not { Length: > 0 }) Record(Error($"{child.Where}: <i icon=\"{child.Attribute("icon")}\"> needs weight=\"<weight>\"; {WeightWhy}"));
                        break;
                    case "img":
                        Check(() =>
                        {
                            var src = Required(child, "src");
                            if (!External(src)) images.Add(Find(resolve.Images, src, "image", child));
                        });
                        break;
                    case "input": case "textarea": case "select": case "buttongroup": case "button-group": case "switch": case "upload": case "radio-group": Check(() => Bind(child)); break;
                    case "popup": Check(() => Required(child, "show")); break;
                    case "buttongroupitem": case "button-group-item":
                        if (parentTag is not ("buttongroup" or "button-group")) Record(Error($"{child.Where}: <ButtonGroupItem> only belongs directly inside a <ButtonGroup>"));
                        Check(() => Required(child, "value"));
                        break;
                    case "button": case "a":
                        if (Destination(child) is { } target) (target.Screen ? screens : called).Add(target.Reference);
                        break;
                    case "div":
                        if (child.Attribute("list") is { Length: 0 })
                            Record(Error($"{child.Where}: a list needs its Source on the element: list=\"<list expression>\"; the Verify refuses a List or a Gallery list without a Source"));
                        else if (child.Attribute("list") != null && child.Attribute("as") is not { Length: > 0 })
                            Record(Error($"{child.Where}: a list needs as=\"<row>\", the name its children use inside {{{{ }}}}"));
                        break;
                }
                if (child.Attribute("list") != null && tag != "div") Check(() => {
                    if (!Elements.Contains(tag) && !Substituted(tag)) throw Error($"{child.Where}: list requires a container or HTML element, not a native control", TagNotAllowed);
                    ValidateList(child);
                });
                if (child.Attribute("onchange") != null)
                {
                    if (tag is "input" or "textarea" or "select" or "switch" or "buttongroup" or "button-group" or "radio-group")
                        Check(() => Destination(child, "onchange"));
                    else Record(Error($"{child.Where}: onchange requires a native control", TagNotAllowed));
                }
                if (child.Attribute("onclick") != null && tag is not ("a" or "button"))
                    Record(Error($"{child.Where}: onclick in a fragment requires an a or button; the event cannot be discarded", "HTML_NATIVE_PROPERTY_UNSUPPORTED"));
                if (child.Attribute("placeholder") != null && tag is not ("input" or "textarea"))
                    Record(Error($"{child.Where}: placeholder requires an input or textarea", "HTML_NATIVE_PROPERTY_UNSUPPORTED"));
                if (child.Attribute("show") != null && tag != "popup")
                    Record(Error($"{child.Where}: show requires a popup", "HTML_NATIVE_PROPERTY_UNSUPPORTED"));
                Validate(child, tag);
            }
        }

        /// <summary>A source the browser loads (a URL) or computes ({{ expression }}): an External image, not a module image.</summary>
        private static bool External(string src) => src.Contains("{{", StringComparison.Ordinal) || UrlShape.IsMatch(src.Trim());

        /// <summary>Where a link or a button goes (C13, C28 of the atritos 3 package): onclick, or the href of an &lt;a&gt;,
        /// names an action or a screen of the module, with its arguments in parentheses (in the order of its inputs) or as
        /// :Input attributes. None (no onclick, href "#") is a control without destination: the job may set it with a later op,
        /// and the Verify judges what stays unset. Problems are recorded, never thrown, so every problem of the element comes
        /// out together.</summary>
        private Target? Destination(HtmlNode node, string eventAttribute = "onclick")
        {
            var targetKey = (node, eventAttribute);
            if (targets.TryGetValue(targetKey, out var known)) return known;
            Target? target = null;
            var named = node.Attributes.Where(a => a.Key.StartsWith(':')).Select(a => (Name: a.Key[1..], a.Value)).ToList();
            var onclick = node.Attribute(eventAttribute);
            var href = eventAttribute == "onclick" && node.Tag == "a" ? node.Attribute("href")?.Trim() : null;
            // "#", "" and javascript: are a prototype's placeholder for "goes nowhere yet"; a URL stays an attribute.
            var hrefTarget = href is { Length: > 0 } && href != "#" && !href.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase) && !UrlShape.IsMatch(href)
                && !href.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase) && !href.StartsWith("tel:", StringComparison.OrdinalIgnoreCase) ? href : null;
            if (onclick is { Length: > 0 } && hrefTarget != null)
                Record(Error($"{node.Where}: an <a> has one destination: onclick=\"{onclick}\" and href=\"{href}\" name two; keep one"));
            var call = onclick is { Length: > 0 } ? onclick : hrefTarget;
            if (call == null)
            {
                if (named.Count > 0) Record(Error($"{node.Where}: {string.Join(", ", named.Select(n => ":" + n.Name))} pass arguments, and the <{node.SourceTag}> names no action or screen; write onclick=\"<Action or Screen>\""));
            }
            else if (CallShape.Match(call) is not { Success: true } shape)
                Record(Error($"{node.Where}: {(onclick is { Length: > 0 } ? "onclick" : "href")}=\"{call}\" is not compiled; write the name of an action or a screen of the module, with its arguments in parentheses: onclick=\"Action(1, Row.Id)\""));
            else
            {
                var name = shape.Groups[1].Value;
                IReadOnlyList<string>? positional = null;
                List<(string Name, string Value)>? byName = null;
                if (shape.Groups[2].Success)
                {
                    try { positional = Arguments(shape.Groups[2].Value); }
                    catch (InvalidOperationException) { Record(Error($"{node.Where}: the arguments of {call} are unbalanced (a parenthesis or a quote is not closed)")); }
                    // Destination(Input = expression, ...), as the reading writes an event (onclick="Open(Id = Row.Id)"), names its
                    // inputs: the same call in the page, the document and the fragment (ScreenDocument.ParseCall), never the
                    // comparison "Id = Row.Id" passed to the first input.
                    if (positional is { Count: > 0 } && ScreenDocument.ParseCall(call, out _, out var parsed) && parsed.Count == positional.Count && parsed.All(a => a.Param != null))
                        byName = parsed.Select(a => (Name: a.Param!, Value: a.Value.Trim())).ToList();
                }
                string? reference = null; var isScreen = false;
                if (!names) reference = name;
                else if (resolve.Actions.TryGetValue(name, out var action)) reference = action;
                else if (resolve.Screens?.TryGetValue(name, out var screen) == true) { reference = screen; isScreen = true; }
                else Record(Error($"{node.Where}: \"{name}\" does not name an action or a screen of the module; actions: {Join(resolve.Actions.Keys)}; screens: {Join(resolve.Screens?.Keys ?? [])}"));
                // The review of round 2, A7: Filter(ShowAll = True), where ShowAll is a variable in scope and no input of Filter, is a
                // comparison passed by position (as before), never the input ShowAll; a name that is neither stays named, so a typo of
                // an input is ARGUMENT_UNKNOWN with the inputs. Without the callee's signature the call is read as the reading writes it.
                if (byName != null && !(names && reference != null && resolve.Contract(reference) is { } callee
                        && byName.Any(a => !callee.Inputs.Any(i => i.Name.Equals(a.Name, StringComparison.OrdinalIgnoreCase)) && resolve.Variables.Contains(a.Name, StringComparer.OrdinalIgnoreCase))))
                {
                    named = byName.Concat(named).ToList();
                    positional = null;
                }
                if (reference != null) target = new Target(name, reference, isScreen, positional, named);
            }
            // An onchange (the proto line's M01/M03: the native OnChange of an input) runs an action, never a screen.
            if (eventAttribute == "onchange" && target?.Screen == true)
            {
                Record(Error($"{node.Where}: onchange requires an action, not screen {target.Name}", TagNotAllowed));
                target = null;
            }
            targets[targetKey] = target;
            return target;
        }

        /// <summary>A block handler as the reading writes it (ScreenHtmlModule's Events): the action alone, or the action with the
        /// value of each of its inputs, Handler(Input = expression, ...), read with the one call of the text forms
        /// (ScreenDocument.ParseCall), and the fallback form @Event.Input="expression" beside it. Arguments by position name no
        /// input of a handler: refused with the named form as the fix.</summary>
        private (string Name, List<(string Input, string Value)> Arguments) Handler(HtmlNode node, string attribute, string value)
        {
            var text = value.Trim();
            if (text.Length == 0) throw Error($"{node.Where}: {attribute} needs the name of an action");
            if (CallShape.Match(text) is not { Success: true } shape || !ScreenDocument.ParseCall(text, out _, out var parsed))
                throw Error($"{node.Where}: {attribute}=\"{value}\" is not compiled; write the handler as the reading writes it: {attribute}=\"Action\" or {attribute}=\"Action(Input = expression)\"");
            var name = shape.Groups[1].Value;
            if (parsed.Any(a => a.Param == null))
                throw Error($"{node.Where}: {attribute}=\"{value}\" passes arguments by position; the inputs of a handler are named, as the reading writes them", ArgumentUnknown,
                    $"{attribute}=\"{name}({string.Join(", ", parsed.Select((a, k) => "<input" + (k + 1).ToString(System.Globalization.CultureInfo.InvariantCulture) + "> = " + a.Value.Trim()))})\"");
            var arguments = parsed.Select(a => (a.Param!, a.Value.Trim())).ToList();
            foreach (var (key, expression) in node.Attributes.Where(a => a.Key.StartsWith(attribute + ".", StringComparison.OrdinalIgnoreCase)))
                arguments.Add((key[(attribute.Length + 1)..], expression));
            // One value per input (the review of round 2, A5: the call and @Event.Input both gave one, and the last one won).
            foreach (var twice in arguments.GroupBy(a => a.Item1, StringComparer.OrdinalIgnoreCase).Where(g => g.Count() > 1))
                throw Error($"{node.Where}: {attribute}=\"{value}\" gives the input {twice.Key} {twice.Count()} times (in the call and as {attribute}.{twice.Key}); one value per input", ArgumentUnknown,
                    $"{attribute}=\"{name}({string.Join(", ", arguments.GroupBy(a => a.Item1, StringComparer.OrdinalIgnoreCase).Select(g => g.Key + " = " + g.First().Item2))})\" without {attribute}.{twice.Key}");
            return (name, arguments);
        }

        /// <summary>@Event.Input="expression" is an argument of the handler of @Event: without @Event on the same &lt;Block&gt; it is
        /// the argument of no handler, refused (it was dropped in silence: the review of round 2, A5), with the call that names it.</summary>
        private static void HandlerArgumentsHaveTheirHandler(HtmlNode node)
        {
            var handlers = node.Attributes.Where(a => a.Key.StartsWith('@') && !a.Key.Contains('.')).Select(a => a.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var orphans = node.Attributes.Where(a => a.Key.StartsWith('@') && a.Key.Contains('.') && !handlers.Contains(a.Key[..a.Key.IndexOf('.')])).ToList();
            foreach (var group in orphans.GroupBy(a => a.Key[..a.Key.IndexOf('.')], StringComparer.OrdinalIgnoreCase))
                throw Error($"{node.Where}: {string.Join(", ", group.Select(a => a.Key))} {(group.Count() == 1 ? "is an input" : "are inputs")} of the handler of {group.Key}, and the <Block> names no handler for {group.Key}", ArgumentUnknown,
                    $"{group.Key}=\"<Action>({string.Join(", ", group.Select(a => a.Key[(a.Key.IndexOf('.') + 1)..] + " = " + a.Value))})\"");
        }

        /// <summary>The top-level arguments of a call, split on the commas outside parentheses, brackets and "strings".</summary>
        private static List<string> Arguments(string inner)
        {
            var list = new List<string>(); var depth = 0; var start = 0; var quoted = false;
            for (var k = 0; k < inner.Length; k++)
            {
                var c = inner[k];
                if (c == '"') { quoted = !quoted; continue; }   // "" inside a string toggles twice: still inside
                if (quoted) continue;
                if (c is '(' or '[') depth++;
                else if (c is ')' or ']') { if (--depth < 0) throw new InvalidOperationException("unbalanced"); }
                else if (c == ',' && depth == 0) { list.Add(inner[start..k].Trim()); start = k + 1; }
            }
            if (quoted || depth != 0) throw new InvalidOperationException("unbalanced");
            var last = inner[start..].Trim();
            if (last.Length > 0 || list.Count > 0) list.Add(last);
            return list;
        }

        private void ValidateBlock(HtmlNode node)
        {
            var reference = Find(resolve.Blocks, Required(node, "name"), "block", node);
            blocks.Add(reference);
            HandlerArgumentsHaveTheirHandler(node);
            // @Event.Input="expression" is an argument of the handler of @Event, judged with it.
            var members = node.Attributes.Where(a => a.Key.StartsWith(':') || a.Key.StartsWith('@') && !a.Key.Contains('.')).ToArray();
            var slots = node.Elements.Where(e => e.Tag == "slot").ToArray();
            if (!names || (members.Length == 0 && slots.Length == 0)) return;
            var contract = resolve.Contract(reference)
                ?? throw Error($"{node.Where}: the public signature of {reference} is unavailable, so its inputs and events cannot be checked");
            foreach (var (attribute, value) in members)
            {
                var member = attribute[1..];
                if (attribute[0] == ':')
                {
                    if (!contract.Inputs.Any(i => i.Name.Equals(member, StringComparison.OrdinalIgnoreCase)))
                        throw Error($"{node.Where}: {reference} has no input '{member}'; inputs: {Join(contract.Inputs.Select(i => i.Name))}");
                    continue;
                }
                if (!contract.Events.Any(e => e.Name.Equals(member, StringComparison.OrdinalIgnoreCase)))
                    throw Error($"{node.Where}: {reference} has no event '{member}'; events: {Join(contract.Events.Select(e => e.Name))}");
                var (handler, arguments) = Handler(node, attribute, value);
                var action = Find(resolve.Actions, handler, "action", node);
                called.Add(action);
                // The inputs the call names are the handler's, when its signature is known (an action the same job creates has none yet:
                // the named argument goes where it says, and the Verify judges it).
                if (arguments.Count > 0 && resolve.Contract(action) is { } signature)
                    foreach (var (input, _) in arguments.Where(a => !signature.Inputs.Any(i => i.Name.Equals(a.Input, StringComparison.OrdinalIgnoreCase))))
                        throw Error($"{node.Where}: {attribute}=\"{value}\": {handler} has no input '{input}'; inputs: {Join(signature.Inputs.Select(i => i.Name))}", ArgumentUnknown,
                            signature.Inputs.Count == 0 ? $"{attribute}=\"{handler}\"" : $"{attribute}=\"{handler}({string.Join(", ", signature.Inputs.Select(i => i.Name + " = <expression>"))})\"");
            }
            foreach (var slot in slots)
            {
                var placeholder = slot.Attribute("name")!;
                if (!contract.Placeholders.Any(p => p.Name.Equals(placeholder, StringComparison.OrdinalIgnoreCase)))
                    throw Error($"{slot.Where}: {reference} has no placeholder '{placeholder}'; placeholders: {Join(contract.Placeholders.Select(p => p.Name))}");
            }
        }

        /// <summary>bind names a variable of the module, or a field of the row when the element sits inside a list.</summary>
        private void Bind(HtmlNode node)
        {
            var target = node.Tag == "upload" && node.Attribute("content") is { Length: > 0 } content ? content : Required(node, "bind");
            if (!names || target.Contains('.')) { bound.Add(target); return; } // a dotted name is a row field: the list alias is resolved when the expression is written
            if (!resolve.Variables.Contains(target, StringComparer.OrdinalIgnoreCase))
                throw Error($"{node.Where}: bind=\"{target}\" does not name a variable of the module; variables: {Join(resolve.Variables)}");
            bound.Add(target);
        }

        private string Find(IReadOnlyDictionary<string, string> known, string wanted, string kind, HtmlNode node)
            => !names ? wanted
                : known.TryGetValue(wanted, out var reference) ? reference
                : throw Error($"{node.Where}: \"{wanted}\" does not name a {kind} of the module; {kind}s: {Join(known.Keys)}");

        /// <summary>Whether this Studio's icon has a Weight: the ODC one has (without it the Studio shows "Non Existing Icon"),
        /// O11's has none, so the O11 reading writes no weight and the fragment asks for none (what the reading writes compiles as
        /// written). The loaded Model API answers with a module; without one (the preflight), the platform of this kernel.</summary>
        private bool IconWeighs => resolve.Supports != null ? resolve.Accepts("IIcon", "Weight") : Platform == ElementWidgetMap.Odc;
        private const string WeightWhy = "the icon of this Studio has a Weight, and without one the Studio shows it as Non Existing Icon";

        /// <summary>A name the validation already checked; without a module (preflight) the name itself stands for it.</summary>
        private string Known(IReadOnlyDictionary<string, string> known, string wanted) => names && known.TryGetValue(wanted, out var reference) ? reference : wanted;

        // ---- widgets --------------------------------------------------------------------------------------------------

        /// <summary>The children of one element, in order. A &lt;div else&gt; lands in the False branch of the
        /// &lt;div if&gt; it immediately follows instead of becoming a container of its own. A child that fails is a problem and
        /// the next child is compiled.</summary>
        private void Children(HtmlNode owner, string parent)
        {
            var scope = owner.IsText || owner.Attribute("class") is not { Length: > 0 } css ? null : HtmlNode.CollapseSpaces(css);
            string? lastIf = null;
            var siblings = owner.Children.ToList();
            for (var index = 0; index < siblings.Count; index++)
            {
                var child = siblings[index];
                try
                {
                    if (child.IsText)
                    {
                        // Whitespace next to an inline element is a space, as the browser lays it out: "<strong>Ctrl</strong> ao soltar"
                        // reads "Ctrl ao soltar", and "<b>A</b> <b>B</b>" keeps its space; indentation between blocks is dropped.
                        var afterInline = index > 0 && IsInline(siblings[index - 1]);
                        var beforeInline = index + 1 < siblings.Count && IsInline(siblings[index + 1]);
                        if (HtmlNode.CollapseSpaces(child.Text).Length == 0)
                        {
                            if (afterInline && beforeInline && child.Text.Length > 0) Literal(" ", parent, scope, keepLeading: true, keepTrailing: true);
                            continue;
                        }
                        Text(child, parent, scope, afterInline, beforeInline); lastIf = null; continue;
                    }
                    if (child.Tag is "style" or "script" || !Allowed(child)) continue; // reported by the validation
                    if (child.Tag == "div" && child.Attributes.Any(a => a.Key == "else"))
                    {
                        var branch = lastIf;
                        lastIf = null;
                        if (branch == null) throw Error($"{child.Where}: <div else> must immediately follow a <div if=\"...\">");
                        Children(child, branch + "/FalseBranch");
                        continue;
                    }
                    var alias = Widget(child, parent);
                    lastIf = child.Tag == "div" && child.Attribute("if") != null && child.Attribute("list") == null ? alias : null;
                }
                catch (InvalidOperationException ex) { Record(ex); lastIf = null; }
            }
        }

        private string Widget(HtmlNode node, string parent)
        {
            if (node.Attribute("list") != null && node.Tag != "div" && (Elements.Contains(node.Tag) || Substituted(node.Tag))) return ListWidget(node, parent);
            switch (node.Tag)
            {
                case "slot": throw Error($"{node.Where}: <slot> only belongs directly inside a <Block>");
                case "block": return Block(node, parent);
                case "div": return Division(node, parent);
                case "i": return Icon(node, parent);
                case "img": return Image(node, parent);
                case "input": return InputWidget(node, parent);
                case "textarea": return Simple(node, parent, "ITextArea", a =>
                {
                    Set(a, "Variable", Expression(Required(node, "bind"), node));
                    // T1: the placeholder of a text area is its Prompt, as an input's (it was reserved and dropped without a word).
                    if (node.Attribute("placeholder") is { Length: > 0 } prompt) Set(a, "Prompt", Bound(prompt, node, "placeholder"));
                });
                case "select": return Select(node, parent);
                case "button": return Clickable(node, parent, "IButton");
                case "a": return Clickable(node, parent, "ILink");
                case "label": return Label(node, parent);
                case "br": return Simple(node, parent, "IContainer", _ => { });
                case "buttongroup": case "button-group": return ButtonGroup(node, parent);
                case "buttongroupitem": case "button-group-item": throw Error($"{node.Where}: <ButtonGroupItem> only belongs directly inside a <ButtonGroup>");
                case "switch": return Simple(node, parent, ElementWidgetMap.LanguageElements["switch"].Widget, a => Set(a, "Variable", Expression(Required(node, "bind"), node)));
                case "expr": return Simple(node, parent, "IExpression", a => Set(a, "Value", Expression(Required(node, "value"), node)));
                case "text":
                    var literal = Create(parent, "ITextWidget", node);
                    Set(literal, "Text", string.Concat(node.Children.Select(c => c.Text)));
                    Attributes(node, literal, "ITextWidget");
                    return literal;
                case "radio-group":
                    var group = Create(parent, "IRadioGroup", node);
                    ops[^1]["empty"] = true;
                    Set(group, "Variable", Expression(Required(node, "bind"), node));
                    Attributes(node, group, "IRadioGroup");
                    if (node.Attribute("onchange") != null) Navigate(node, group, Destination(node, "onchange"), "OnChange");
                    Children(node, group);
                    return group;
                case "radio-button":
                    var radio = Create(parent, "IRadioButton", node);
                    ops[^1]["empty"] = true;
                    Set(radio, "Value", Expression(Required(node, "value"), node));
                    Attributes(node, radio, "IRadioButton");
                    Children(node, radio);
                    return radio;
                case "placeholder": case "list-item":
                    var nativeContainer = Create(parent, node.Tag == "placeholder" ? "IPlaceholderWidget" : "IListItem", node);
                    if (node.Tag == "placeholder") Set(nativeContainer, "Name", Required(node, "name"));
                    Attributes(node, nativeContainer, node.Tag == "placeholder" ? "IPlaceholderWidget" : "IListItem");
                    Children(node, nativeContainer);
                    return nativeContainer;
                case "upload": return Simple(node, parent, ElementWidgetMap.LanguageElements["upload"].Widget, a =>
                {
                    Set(a, "FileContent", Expression(node.Attribute("content") ?? Required(node, "bind"), node));
                    if (node.Attribute("filename") is { Length: > 0 } fileName) Set(a, "FileName", Expression(fileName, node));
                });
                case "form":
                    var form = Create(parent, "IForm", node);
                    Attributes(node, form, "IForm");
                    Children(node, form);
                    return form;
                case "popup":
                    var popup = Create(parent, "IPopup", node);
                    Set(popup, "ShowPopup", ScreenHtml.HoldsBraces(Required(node, "show")) ? Bound(Required(node, "show"), node, "show") : Expression(Required(node, "show"), node));
                    Attributes(node, popup, "IPopup");
                    popupDepth++;
                    try { Children(node, popup); }
                    finally { popupDepth--; }
                    return popup;
            }
            if (Substituted(node.Tag))
            {
                // The one table's substitute: a div (or a span) with the class ssam-tag-<tag>, so the author's CSS on the tag reaches it.
                var mapping = ElementWidgetMap.Map(Platform, node, clickable: false);
                var substitute = Create(parent, mapping.Widget, node);
                if (mapping.Widget == "IAdvancedHtml") Set(substitute, "Tag", mapping.Tag!);
                Attributes(node, substitute, mapping.Widget, extraClass: ElementWidgetMap.TagClass(node.Tag));
                if (node.Tag == "main" && node.Attribute("role") == null) Extended(node, substitute, mapping.Widget, "role", Quote("main"));
                Children(node, mapping.Widget == "IAdvancedHtml" ? substitute + "/Content" : substitute);
                return substitute;
            }
            if (!Elements.Contains(node.Tag))
                throw Error($"{node.Where}: <{node.SourceTag}> is not compiled; supported tags: div, the tags of the platform's HTML Element, br, i, img, input, textarea, select, button, a, label, form, Block, ButtonGroup, slot, style", TagNotAllowed);
            var alias = Create(parent, "IAdvancedHtml", node);
            Set(alias, "Tag", node.Tag);
            Attributes(node, alias, "IAdvancedHtml");
            Children(node, alias + "/Content");
            return alias;
        }

        private string Division(HtmlNode node, string parent)
        {
            var list = node.Attribute("list"); var condition = node.Attribute("if");
            if (list is { Length: > 0 } && condition != null) throw Error($"{node.Where}: a <div> is a list or an if, not both");
            if (list is { Length: > 0 })
            {
                return ListWidget(node, parent);
            }
            if (condition != null)
            {
                if (condition.Length == 0) throw Error($"{node.Where}: if=\"\" needs an OutSystems condition");
                var alias = Create(parent, "IIfWidget", node);
                Set(alias, "Condition", Expression(condition, node));
                Attributes(node, alias, "IIfWidget");
                Children(node, alias + "/TrueBranch");
                return alias;
            }
            var container = Create(parent, "IContainer", node);
            Attributes(node, container, "IContainer");
            Children(node, container);
            return container;
        }

        private static void ValidateList(HtmlNode node)
        {
            if (node.Attribute("list") is not { Length: > 0 }) throw Error($"{node.Where}: a list needs its Source");
            if (node.Attribute("as") is not { Length: > 0 }) throw Error($"{node.Where}: a list needs as=\"<row>\", the name its children use inside {{{{ }}}}");
            if (node.Attribute("if") != null) throw Error($"{node.Where}: a list and an if need separate elements");
        }

        private string ListWidget(HtmlNode node, string parent)
        {
            ValidateList(node);
            var source = Expression(Required(node, "list"), node);
            var alias = Create(parent, "IList", node);
            Set(alias, "Source", source);
            if (node.Tag != "div") Set(alias, "Tag", node.Tag);
            if (ScreenVisual.RowGroupTags.Contains(node.Tag)) rowGroups.Add((alias, node.Tag, node.Line));
            Attributes(node, alias, "IList");
            listScopes.Push(new ListScope(Required(node, "as"), source));
            try { Children(node, alias); }
            finally { listScopes.Pop(); }
            return alias;
        }

        /// <summary>Literal text is a Text widget scoped by the class of the element around it; {{ }} is an Expression whose
        /// text is OutSystems, copied as written.</summary>
        private void Text(HtmlNode node, string parent, string? scope, bool afterInline = false, bool beforeInline = false)
        {
            // T1: the one compile of a text with bindings (BindingText.Runs): a binding of a constant is folded into the text
            // around it ({{ "Search" }} is the text Search), any other binding is an Expression with the list scope.
            var runs = RunsOf(node.Text, node, Scoped);
            for (var r = 0; r < runs.Count; r++)
            {
                var run = runs[r];
                if (run.Expression) { Set(Create(parent, "IExpression", null), "Value", run.Text); continue; }
                Literal(run.Text, parent, scope, keepLeading: r == 0 ? afterInline : true, keepTrailing: r == runs.Count - 1 ? beforeInline : true);
            }
        }


        private static readonly HashSet<string> InlineTags = new(StringComparer.Ordinal)
        { "span", "strong", "em", "small", "code", "a", "i", "label", "img" };
        private static bool IsInline(HtmlNode node) => !node.IsText && InlineTags.Contains(node.Tag);

        /// <summary>Whitespace that touches a {{ }} of the same text run stays as one space, as a browser lays out inline
        /// content ("For {{Key}}" reads "For H-002", not "ForH-002"); indentation at the edges of the run is dropped.</summary>
        private void Literal(string text, string parent, string? scope, bool keepLeading = false, bool keepTrailing = false)
        {
            var leading = keepLeading && text.Length > 0 && char.IsWhiteSpace(text[0]);
            var trailing = keepTrailing && text.Length > 0 && char.IsWhiteSpace(text[^1]);
            var value = HtmlNode.CollapseSpaces(text);
            if (value.Length == 0) value = leading && trailing ? " " : "";
            else value = (leading ? " " : "") + value + (trailing ? " " : "");
            if (value.Length == 0) return;
            // The text carries no class of its own: the element around it already has it, and repeating it nests the style
            // (<span class="pill">!</span> drew two pills, one inside the other).
            var alias = Create(parent, "ITextWidget", null);
            Set(alias, "Text", value);
        }

        private string Icon(HtmlNode node, string parent)
        {
            if (node.Attribute("icon") is not { Length: > 0 } icon) throw Error($"{node.Where}: <i> needs icon=\"<name>\"");
            var weight = node.Attribute("weight");
            if (IconWeighs && weight is not { Length: > 0 }) throw Error($"{node.Where}: <i icon=\"{icon}\"> needs weight=\"<weight>\"; {WeightWhy}");
            var alias = Create(parent, ElementWidgetMap.LanguageElements["i"].Widget, node);
            Set(alias, "Icon", icon);
            // O11's IIcon has no Weight (Model API 11.55.69); the ODC one has. The weight is asked for where the icon has one, and it
            // reaches the model there; the O11 reading writes no weight, and the fragment takes its <i> as written.
            if (IconWeighs && weight is { Length: > 0 }) Set(alias, "Weight", weight);
            // An <i> takes the font size around it, as in HTML; the widget is born Twotimes, which doubles it.
            if (resolve.Accepts("IIcon", "IconSize")) Set(alias, "IconSize", "FontSize");
            Attributes(node, alias, "IIcon");
            return alias;
        }

        /// <summary>A module image (Static), or a URL or a {{ }} expression: an External image whose Url is that text, the native
        /// route of an image from the web or from data (C13; the session wrote Type ExternalURL by hand and was refused).</summary>
        private string Image(HtmlNode node, string parent)
        {
            var src = Required(node, "src");
            var alias = Create(parent, "IImage", node);
            if (External(src))
            {
                Set(alias, "Type", "External");
                Set(alias, "Url", Bound(src.Trim(), node, "src"));
            }
            else Set(alias, "Image", Known(resolve.Images, src));
            Attributes(node, alias, "IImage");
            return alias;
        }

        private string InputWidget(HtmlNode node, string parent)
        {
            var type = node.Attribute("type");
            if (type == "checkbox") return Simple(node, parent, "ICheckbox", a => Set(a, "Variable", Expression(Required(node, "bind"), node)));
            var bind = Required(node, "bind");
            // The bound data type decides, as the Verify demands ("Input type is a Phone but it should be Text to match
            // Telefone", Cardapio 2026-10-06 13:41); an authored type it accepts stays (password or search on Text).
            var (implied, dataType) = BoundInput(bind);
            if (dataType != null && implied == null)
                throw Error($"{node.Where}: bind=\"{bind}\" is a {dataType}; an <input> cannot edit it", InputMismatch,
                    dataType == "Boolean" ? $"write <input type=\"checkbox\" bind=\"{bind}\">" : "bind a Text, number, Date, Time, Date Time, Email or Phone Number variable or attribute");
            string inputType;
            if (type == null) inputType = implied ?? "Text";
            else if (!InputTypes.TryGetValue(type, out var authored))
                throw Error($"{node.Where}: input type \"{type}\" is not compiled; use {Join(InputTypes.Keys)} or checkbox", InputMismatch,
                    $"write type=\"{(implied == null ? "text" : InputTypes.First(p => p.Value == implied).Key)}\" or leave type out (the bound data type decides)");
            else if (implied != null && !Accepted(authored, implied))
            {
                adjusted.Add(new JsonObject { ["widget"] = node.Attribute("id") ?? node.Where, ["bind"] = bind, ["authored"] = authored, ["inputType"] = implied, ["dataType"] = dataType });
                inputType = implied;
            }
            else inputType = authored;
            return Simple(node, parent, "IInput", alias =>
            {
                Set(alias, "Variable", Expression(bind, node));
                Set(alias, "InputType", inputType);
                if (node.Attribute("placeholder") is { Length: > 0 } prompt) Set(alias, "Prompt", Bound(prompt, node, "placeholder"));
            });
        }

        private static bool Accepted(string authored, string implied) => authored == implied || (implied == "Text" && authored is "Password" or "Search");

        /// <summary>(the InputType the bound data type implies, the basic data type) — (null, null) when the type is unknown here,
        /// (null, type) when it is a basic type no input edits (Boolean, Binary Data).</summary>
        private (string? Implied, string? DataType) BoundInput(string bind)
        {
            if (resolve.BindTypes?.TryGetValue(bind, out var dataType) == true)
                return (dataType.Replace(" ", "").ToLowerInvariant() switch
                {
                    "text" => "Text", "integer" or "longinteger" or "decimal" or "currency" => "Number", "date" => "Date", "time" => "Time",
                    "datetime" => "Datetime", "email" => "Email", "phonenumber" => "Phone", _ => null,
                }, dataType);
            return (resolve.InputTypes?.GetValueOrDefault(bind), null);
        }

        private string Select(HtmlNode node, string parent) => Simple(node, parent, "IDropdown", alias =>
        {
            // value and label are evaluated per element of options, where only the element's attributes are names: a read of
            // options.Current is refused here, with the attribute path that compiles (PreflightRules.DropdownItemScopeRules).
            if (MessageExpectations.Lane != "odc" && node.Attribute("options") is { Length: > 0 } options)
                foreach (var attribute in new[] { "value", "label" })
                    if (node.Attribute(attribute) is { Length: > 0 } text && PreflightRules.DropdownItemScopeRules.ReadsCurrent(options, text))
                    {
                        var bare = PreflightRules.DropdownItemScopeRules.Bare(options, text);
                        Record(Error($"{node.Where}: {attribute}=\"{text}\" reads {options}.Current; value and label are evaluated per element of options, where only the element's attributes are names (the Verify cannot identify {options} there)",
                            PreflightRules.DropdownItemScopeRules.Code, bare != null ? $"write {attribute}=\"{bare}\"" : "read the element's attributes: Entity.Attribute for an aggregate, Attribute for a list of records"));
                    }
            Set(alias, "Variable", Expression(Required(node, "bind"), node));
            Set(alias, "List", Expression(Required(node, "options"), node));
            Set(alias, "Values", Expression(Required(node, "value"), node));
            Set(alias, "Labels", Expression(Required(node, "label"), node));
        });

        private string Simple(HtmlNode node, string parent, string type, Action<string> properties)
        {
            if (node.Elements.Any()) throw Error($"{node.Where}: <{node.SourceTag}> takes no child elements");
            var alias = Create(parent, type, node);
            properties(alias);
            Attributes(node, alias, type);
            if (node.Attribute("onchange") != null) Navigate(node, alias, Destination(node, "onchange"), "OnChange");
            return alias;
        }

        /// <summary>A button and a link are born with their own caption widget: literal text replaces it, never doubles it. A
        /// caption with {{ }}, an icon-only control and one with child elements (a card that is a link: C13 of the atritos 3
        /// package) drop the born caption and compile their content like any other content, so an expression is a native
        /// Expression with the list scope (the Cardapio buttons printed "{{ Restaurantes.Current.Nome }}").</summary>
        private string Clickable(HtmlNode node, string parent, string type)
        {
            var written = node.InnerText();
            // T1: a caption whose bindings are all constants is the literal caption ({{ "Save" }} is Save); one that names something
            // is the control's content, compiled (BindingText).
            var text = ScreenHtml.HoldsBraces(written) && BindingText.Literal(written) is { } folded ? folded : written;
            // H5 (the one table): a control with no visible content is named by its aria-label or title (a CSS switch).
            if (text.Length == 0 && !node.Elements.Any() && !ElementWidgetMap.Labelled(node.Attributes.Select(a => (a.Key, a.Value))))
                throw Error($"{node.Where}: a <{node.SourceTag}> needs text, {{{{ expression }}}}, an <i> icon, child elements, an aria-label or a title");
            var target = Destination(node);
            var alias = Create(parent, type, node);
            // The one table: a submit button is never type=submit; it is the default button and carries ssam-submit.
            var submit = type == "IButton" && (node.Attribute("type") ?? "").Equals("submit", StringComparison.OrdinalIgnoreCase);
            if (submit) Set(alias, "IsDefault", true);
            if (text.Length == 0 || node.Elements.Any(e => e.Tag != "i") || ScreenHtml.HoldsBraces(text))
            {
                // Dynamic content uses the same compiler as other widgets: it keeps literal spacing, native expressions,
                // list aliases, child elements and the authored order of the icons.
                Add("delete", ("target", alias + "/#ITextWidget"));
                Navigate(node, alias, target);
                Attributes(node, alias, type, submit ? "ssam-submit" : null);
                // A control with no visible text (an icon) says what it does to a screen reader by its title.
                if (text.Length == 0 && node.Attribute("title") is { Length: > 0 } title && node.Attribute("aria-label") == null)
                    Extended(node, alias, type, "aria-label", Bound(title, node, "title"));
                Children(node, alias);
                return alias;
            }
            Set(alias + "/#ITextWidget", "Text", text);
            Navigate(node, alias, target);
            Attributes(node, alias, type, submit ? "ssam-submit" : null);
            var before = true;
            var leading = new List<string>();
            foreach (var child in node.Children)
            {
                if (child.IsText) { if (HtmlNode.CollapseSpaces(child.Text).Length > 0) before = false; continue; }
                var icon = Icon(child, alias);
                if (before) leading.Add(icon);
            }
            // move first in reverse keeps the authored order of the leading icons
            for (var i = leading.Count - 1; i >= 0; i--) ops.Add(new JsonObject { ["op"] = "move", ["target"] = leading[i], ["first"] = true });
            return alias;
        }

        /// <summary>The OnClick of a control: the Destination, then one Value per argument in the order of the callee's inputs
        /// (I7 of the atritos 3 package, the shape `IButton:Cell0/OnClick/Index` the Verify accepted in the v02b proof). With
        /// the module: an argument the callee has no input for is ARGUMENT_UNKNOWN; when the author listed the arguments, a
        /// mandatory input left out is REQUIRED_ARGUMENT; when the author named only the action or the screen, a mandatory input
        /// takes the variable of the same name in scope (the wiring of a block event, reported in implicitArguments), and one
        /// without such a variable is left to a later op of the job and to the Verify.</summary>
        private void Navigate(HtmlNode node, string alias, Target? target, string eventName = "OnClick")
        {
            if (target == null) return;
            alias += "/" + eventName;
            Set(alias, "Destination", target.Reference);
            if (popupDepth > 0) Set(alias, "Transition", "Fade");
            if (!names) return;
            var contract = resolve.Contract(target.Reference);
            if (contract == null)
            {
                // Without the callee's signature a position names no input; a named argument still goes where it says, and
                // the Verify judges it.
                if (target.Positional is { Count: > 0 })
                    Record(Error($"{node.Where}: the signature of {target.Name} is unavailable, so the argument positions name no input", ArgumentUnknown,
                        $"pass them by name: {string.Join(" ", target.Positional.Select((a, k) => $":<input{k + 1}>=\"{a}\""))}"));
                foreach (var (name, value) in target.Named)
                {
                    if (value.Contains("{{", StringComparison.Ordinal)) Record(Error($"{node.Where}: {{{{ }}}} does not nest inside an attribute; write the expression directly"));
                    else Set(alias + "/" + name, "Value", Scoped(value));
                }
                return;
            }
            var inputs = contract.Inputs;
            var given = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var where = $"{node.Where}: {target.Name}";
            string Takes() => inputs.Count == 0 ? "takes no inputs" : $"takes {inputs.Count} input(s): {string.Join(", ", inputs.Select(i => i.Name))}";
            for (var k = 0; k < (target.Positional?.Count ?? 0); k++)
            {
                var argument = target.Positional![k];
                if (k >= inputs.Count) { Record(Error($"{where} {Takes()}; the argument {k + 1} ({argument}) has no input", ArgumentUnknown, $"write {target.Name}({string.Join(", ", target.Positional.Take(inputs.Count))})")); continue; }
                if (argument.Length == 0) { Record(Error($"{where}: the argument {k + 1} ({inputs[k].Name}) is empty", ArgumentRequired, $"write an expression for {inputs[k].Name}")); continue; }
                given[inputs[k].Name] = Scoped(argument);
            }
            foreach (var (name, value) in target.Named)
            {
                var input = inputs.FirstOrDefault(i => i.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (input == null) { Record(Error($"{where} has no input '{name}'; it {Takes()}", ArgumentUnknown, inputs.Count == 0 ? $"remove :{name}" : $"use one of: {string.Join(", ", inputs.Select(i => ":" + i.Name))}")); continue; }
                if (given.ContainsKey(input.Name)) { Record(Error($"{where}: the input {input.Name} is given twice (in parentheses and as :{name})", ArgumentUnknown, $"keep one value for {input.Name}")); continue; }
                if (value.Contains("{{", StringComparison.Ordinal)) { Record(Error($"{node.Where}: {{{{ }}}} does not nest inside an attribute; write the expression directly")); continue; }
                given[input.Name] = Scoped(value);
            }
            foreach (var input in inputs.Where(i => i.Mandatory && !given.ContainsKey(i.Name)))
            {
                if (target.Explicit)
                    Record(Error($"{where} needs the input {input.Name} ({input.Type}); {Takes()}", ArgumentRequired,
                        $"write {target.Name}({string.Join(", ", inputs.Select(i => given.TryGetValue(i.Name, out var v) ? v : "<" + i.Name + ">"))})"));
                else if (resolve.Variables.Contains(input.Name, StringComparer.OrdinalIgnoreCase))
                {
                    given[input.Name] = resolve.Variables.First(v => v.Equals(input.Name, StringComparison.OrdinalIgnoreCase));
                    implicitArguments.Add(new JsonObject { ["widget"] = node.Attribute("id") ?? node.Where, ["destination"] = target.Name, ["input"] = input.Name, ["value"] = given[input.Name] });
                }
            }
            foreach (var input in inputs)
                if (given.TryGetValue(input.Name, out var value)) Set(alias + "/" + input.Name, "Value", value);
        }

        /// <summary>A label with text is a Label. A label around other elements is an HTML Element of tag label (in the list of
        /// both platforms, H6 of the one table) with its text and its elements in the order written, so the DOM and the CSS of
        /// the label stay (label.field > span); a for is kept as its attribute. No refusal (the Cardapio BackOffice hit "label
        /// takes text").</summary>
        private string Label(HtmlNode node, string parent)
        {
            if (!node.Elements.Any(e => e.Tag != "style"))
            {
                var text = node.InnerText();
                if (text.Length == 0) throw Error($"{node.Where}: a <label> needs text");
                var alias = Create(parent, "ILabel", node);
                // T1: the caption of a label is a literal: its text, a binding of a constant folded into it ({{ "Search" }} is
                // Search); a binding that names something makes the label's content its runs, Text and Expression children
                // (the label's own caption goes, as a button's does). Never the braces as text (BindingText).
                if (!ScreenHtml.HoldsBraces(text)) Set(alias + "/#ITextWidget", "Text", text);
                else if (BindingText.Literal(text) is { } folded) Set(alias + "/#ITextWidget", "Text", folded);
                else
                {
                    Add("delete", ("target", alias + "/#ITextWidget"));
                    Children(node, alias);
                }
                Attributes(node, alias, "ILabel");
                if (node.Attribute("for") is { Length: > 0 } target) labels.Add((alias, target, node));
                return alias;
            }
            var wrapper = Create(parent, "IAdvancedHtml", node);
            Set(wrapper, "Tag", "label");
            Attributes(node, wrapper, "IAdvancedHtml");
            if (node.Attribute("for") is { Length: > 0 } wrapped) Extended(node, wrapper, "IAdvancedHtml", "for", Bound(wrapped, node, "for"));
            Children(node, wrapper + "/Content");
            return wrapper;
        }

        /// <summary>The native route of a button group (widgets-reactive): the group is created empty and bound to its
        /// variable; each item is an IButtonGroupItem with its Value and its caption as an Expression.</summary>
        private string ButtonGroup(HtmlNode node, string parent)
        {
            var alias = Create(parent, ElementWidgetMap.LanguageElements["button-group"].Widget, node);
            ops[^1]["empty"] = true;
            Set(alias, "Variable", Expression(Required(node, "bind"), node));
            Attributes(node, alias, "IButtonGroup");
            if (node.Attribute("onchange") != null) Navigate(node, alias, Destination(node, "onchange"), "OnChange");
            foreach (var child in node.Children)
            {
                try
                {
                    if (child.IsText)
                    {
                        if (HtmlNode.CollapseSpaces(child.Text).Length > 0) throw Error($"{child.Where}: the text of a <ButtonGroup> goes in its <ButtonGroupItem value=\"...\">");
                        continue;
                    }
                    if (child.Tag is not ("buttongroupitem" or "button-group-item")) throw Error($"{child.Where}: a <ButtonGroup> holds <ButtonGroupItem value=\"...\"> only");
                    var item = Create(alias, ElementWidgetMap.LanguageElements["button-group-item"].Widget, child);
                    Set(item, "Value", Expression(Required(child, "value"), child));
                    Attributes(child, item, "IButtonGroupItem");
                    foreach (var part in child.Children)
                    {
                        if (part.IsText) { Caption(part, item); continue; }
                        if (part.Tag != "i") throw Error($"{part.Where}: a <ButtonGroupItem> takes text, {{{{ }}}} and <i> icons");
                        Icon(part, item);
                    }
                }
                catch (InvalidOperationException ex) { Record(ex); }
            }
            return alias;
        }

        /// <summary>The caption of a button group item: literal text is a quoted Expression, {{ }} the expression as written.</summary>
        private void Caption(HtmlNode text, string parent)
        {
            // T1: the one compile of a text with bindings (BindingText.Runs); each run is an Expression of the item's caption.
            foreach (var run in RunsOf(text.Text, text, Scoped))
            {
                if (run.Expression) { Set(Create(parent, "IExpression", null), "Value", run.Text); continue; }
                var value = HtmlNode.CollapseSpaces(run.Text);
                if (value.Length > 0) Set(Create(parent, "IExpression", null), "Value", Quote(value));
            }
        }

        private string Block(HtmlNode node, string parent)
        {
            var reference = Known(resolve.Blocks, Required(node, "name"));
            HandlerArgumentsHaveTheirHandler(node);
            var alias = Create(parent, "IMobileBlockInstanceWidget", node);
            ops[^1]["source"] = reference;
            // A block whose slots the fragment fills starts with empty placeholders, as the ButtonGroup does: the example content
            // of a pattern (the OSUI Gallery's List without a Source and Image without a value, lab 19) never stays beside it.
            if (node.Elements.Any(e => e.Tag == "slot")) ops[^1]["empty"] = true;
            var contract = resolve.Contract(reference);
            foreach (var (attribute, value) in node.Attributes.Where(a => a.Key.StartsWith(':')))
                Set(alias + "/" + (contract == null ? attribute[1..] : Member(contract.Inputs.Select(i => i.Name), attribute[1..])), "Value", Expression(value, node));
            foreach (var (attribute, value) in node.Attributes.Where(a => a.Key.StartsWith('@') && !a.Key.Contains('.')))
            {
                var eventName = contract == null ? attribute[1..] : Member(contract.Events.Select(e => e.Name), attribute[1..]);
                var (name, arguments) = Handler(node, attribute, value);
                var handler = Known(resolve.Actions, name);
                Set(alias + "/" + eventName, "Handler", handler);
                var signature = resolve.Contract(handler);
                // Handler(Input = expression, ...), as the reading writes the event (the paginator's OnNavigate: ShowPage(NewStartIndex =
                // NewStartIndex)): each input the value it names, the same event in the page and in the fragment.
                if (arguments.Count > 0)
                {
                    foreach (var (input, expression) in arguments)
                        Set(alias + "/" + eventName + "/" + (signature == null ? input : Member(signature.Inputs.Select(i => i.Name), input)), "Value", Expression(expression, node));
                    continue;
                }
                // The handler named alone: the event's parameters reach it through the input of the same name, the wiring the Studio
                // asks for by hand; a parameter the handler does not declare is simply not passed.
                foreach (var parameter in contract?.Events.FirstOrDefault(e => e.Name == eventName)?.Params ?? [])
                    if (signature?.Inputs.Any(i => i.Name.Equals(parameter.Name, StringComparison.OrdinalIgnoreCase)) == true)
                        Set(alias + "/" + eventName + "/" + parameter.Name, "Value", parameter.Name);
            }
            Attributes(node, alias, "IMobileBlockInstanceWidget");
            foreach (var child in node.Children)
            {
                if (child.IsText) { if (HtmlNode.CollapseSpaces(child.Text).Length > 0) throw Error($"{child.Where}: the children of a <Block> go in <slot name=\"...\">"); continue; }
                if (child.Tag != "slot") throw Error($"{child.Where}: the children of a <Block> go in <slot name=\"...\">");
                var slot = child.Attribute("name") ?? "";
                Children(child, alias + "/" + (contract == null ? slot : Member(contract.Placeholders.Select(p => p.Name), slot)));
            }
            return alias;
        }

        // The authored case is folded away by the parser; the signature gives the real name back.
        private static string Member(IEnumerable<string> names, string wanted) => names.FirstOrDefault(n => n.Equals(wanted, StringComparison.OrdinalIgnoreCase)) ?? wanted;

        /// <summary>class goes to the native Style when the widget has one, otherwise to an extended property; every other
        /// attribute outside the closed list becomes an extended property with its literal value.</summary>
        private void Attributes(HtmlNode node, string alias, string type, string? extraClass = null)
        {
            var written = node.Attribute("class");
            var authored = written is { Length: > 0 } ? written : null;
            var css = authored == null ? extraClass : extraClass == null ? authored : authored + " " + extraClass;
            if (css != null)
            {
                // class="chip {{ If(Selected, "on", "") }}" is a dynamic Style: the literal parts quoted, the {{ }} parts as written.
                var value = HtmlNode.CollapseSpaces(css);
                var expression = Bound(value, node, "class");
                if (resolve.Accepts(type, "Style")) Set(alias, "Style", expression);
                else Extended(node, alias, type, "class", expression);
            }
            // M2 of the review of the M1 fix: class="" is the author's empty class, as in the document and the edit forms (they
            // read it back as class=""): the class the Studio gave the widget goes, and F2 does not apply.
            else if (written != null) { if (resolve.Accepts(type, "Style")) Set(alias, "Style", Quote("")); }
            // F2 (the owner's decision D1 of 2026-10-17): a widget written without class whose type the Studio gives one; the op
            // decides its class on the widget it created (ScreenVisual.StudioClassOf), as the document and the edit forms do.
            else if (ScreenVisual.DecisionFor(type) != null && resolve.Accepts(type, "Style"))
                unclassed.Add((alias, type, node.Line));
            foreach (var (attribute, value) in node.Attributes)
            {
                if (Reserved.Contains(attribute) || attribute.StartsWith(':') || attribute.StartsWith('@')) continue;
                if (NativeProperty(node, alias, type, attribute, value)) continue;
                if (attribute.StartsWith("os-", StringComparison.OrdinalIgnoreCase))
                    throw Error($"{node.Where}: {attribute} has no supported native property on {type}; it cannot become an inert HTML attribute", "HTML_NATIVE_PROPERTY_UNSUPPORTED");
                // Inline JavaScript never becomes an attribute (the one table): onclick is the syntax of a destination.
                if (ElementWidgetMap.IsInlineScript(attribute))
                    throw Error($"{node.Where}: attribute '{attribute}' is inline JavaScript, which is not compiled; logic is native", TagNotAllowed, "remove it; a link or a button names its action with onclick=\"Action\"");
                // CX17 review 2, M4: a marker of the theme's native layout block is the engine's (the one rule of the text forms);
                // a fragment goes into a screen that exists, where the op marks nothing.
                if (ScreenVisual.MarkerOf(attribute) != null)
                    throw Error($"{node.Where}: " + ScreenVisual.ReservedMarkerMessage(attribute, value, false, false), ScreenVisual.ReservedMarker, "remove " + attribute + "; a fragment carries no marker of the engine");
                Extended(node, alias, type, attribute, Bound(value, node, attribute));
            }
            // An href that is a URL (not a screen) stays the attribute the author wrote.
            if (node.Tag == "a" && node.Attribute("href")?.Trim() is { Length: > 0 } href && (UrlShape.IsMatch(href)
                || href.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase) || href.StartsWith("tel:", StringComparison.OrdinalIgnoreCase)))
                Extended(node, alias, type, "href", Bound(href, node, "href"));
        }

        private bool NativeProperty(HtmlNode node, string alias, string type, string attribute, string value)
        {
            var explicitNative = attribute.StartsWith("os-", StringComparison.OrdinalIgnoreCase);
            var name = explicitNative ? attribute[3..].ToLowerInvariant() : attribute;
            var property = name switch {
                "enabled" or "disabled" => "Enabled",
                "mandatory" or "required" => "Mandatory",
                "maxlength" => "MaxLength",
                "empty" or "emptyvalue" => "EmptyValue",
                _ => null,
            };
            if (property == null)
            {
                var native = ScreenHtmlTables.Named.GetValueOrDefault(type[1..]);
                property = explicitNative ? ScreenSpecification.Shape("mobile", type)["properties"]?.AsObject()
                    .Select(p => p.Key).FirstOrDefault(p => p.Equals(attribute[3..], StringComparison.OrdinalIgnoreCase))
                    : native?.FirstOrDefault(p => p.Value == attribute).Key;
                if (type == "IUpload" && attribute == "accept") property = "Accept";
            }
            if (property == null) return false;
            if (!resolve.Accepts(type, property)) throw Error($"{node.Where}: {attribute} is not supported by {type}", "HTML_NATIVE_PROPERTY_UNSUPPORTED");
            var propertyKind = HtmlVisualScope.Property(type, property)?["kind"]?.ToString();
            if (propertyKind != "expression")
            {
                if (ScreenHtml.HoldsBraces(value))
                {
                    // T1 (BindingText, the one compile): a malformed binding is HTML_BINDING_INVALID; a constant binding folds into
                    // the literal; any other binding cannot be the value of a literal property.
                    if (BindingText.Expression(value, out var fault, Scoped) == null) throw Error($"{node.Where}: {attribute}=\"{Clip(value)}\": {fault}", ScreenDocument.BindingInvalid, BindingFix);
                    value = BindingText.Literal(value) ?? throw Error($"{node.Where}: {attribute} is a native literal property, not an expression", ScreenDocument.BindingLiteral);
                }
                Set(alias, property, value);
                return true;
            }
            string expression;
            if (name == "disabled") expression = value.Length == 0 ? "False" : "not (" + (ScreenHtml.HoldsBraces(value) ? Bound(value, node, attribute) : Expression(value, node)) + ")";
            else if (name == "required") expression = value.Length == 0 ? "True" : ScreenHtml.HoldsBraces(value) ? Bound(value, node, attribute) : Expression(value, node);
            else if (property == "EmptyValue") expression = explicitNative && !ScreenHtml.HoldsBraces(value) ? Expression(value, node) : Bound(value, node, attribute);
            else expression = ScreenHtml.HoldsBraces(value) ? Bound(value, node, attribute) : Expression(value, node);
            Set(alias, property, expression);
            return true;
        }

        /// <param name="value">The OutSystems expression of the attribute (a quoted literal or an expression).</param>
        private void Extended(HtmlNode node, string alias, string type, string property, string value)
        {
            if (NoAttributes.Contains(type)) throw Error($"{node.Where}: a {type} carries no attributes, so '{property}' has nowhere to go");
            var ep = Create(alias, "IExtendedProperty", null);
            Set(ep, "Property", property); Set(ep, "Value", value);
        }

        /// <summary>T1: the value of an attribute that takes an expression, by the one compile of a text with bindings
        /// (BindingText.Expression): {{ E }} is E with the list scope, text with bindings their concatenation (the literal parts
        /// quoted), a value without a binding its string literal. A malformed binding is HTML_BINDING_INVALID, named.</summary>
        private string Bound(string value, HtmlNode node, string attribute)
        {
            if (BindingText.Expression(value, out var fault, Scoped) is { } expression) return expression;
            throw Error($"{node.Where}: {attribute}=\"{Clip(value)}\": {fault}", ScreenDocument.BindingInvalid, BindingFix);
        }

        private const string BindingFix = "a binding is {{ expression }} (text around it is joined: \"Total {{ N }}\"); a literal brace is written &#123; in <text>, or split in an expression ({{ \"{\" + \"{\" }})";
        private static string Clip(string text) => text.Length <= 80 ? text : text[..77] + "...";

        /// <summary>T1: the runs of a text with bindings (BindingText.Runs): literal text, each constant binding folded into it,
        /// and expressions with the list scope. A malformed binding is HTML_BINDING_INVALID, named.</summary>
        private static List<BindingText.Run> RunsOf(string text, HtmlNode node, Func<string, string> scoped)
        {
            if (BindingText.Runs(text, out var fault, scoped) is { } runs) return runs;
            throw Error($"{node.Where}: the text \"{Clip(HtmlNode.CollapseSpaces(text))}\": {fault}", ScreenDocument.BindingInvalid, BindingFix);
        }

        // ---- stylesheet -----------------------------------------------------------------------------------------------

        private (string? Text, string? Scope, int Rules) Stylesheet()
        {
            var text = new StringBuilder();
            foreach (var style in root.Descendants().Where(n => !n.IsText && n.Tag == "style"))
            {
                if (style.Attribute("media") != null) throw Error($"{style.Where}: use @media inside the stylesheet instead of a media attribute");
                text.Append(string.Concat(style.Children.Select(c => c.Text))).Append('\n');
            }
            var css = text.ToString().Trim();
            if (css.Length == 0) return (null, null, 0);
            // CSS the theme does not render (A30): light-dark() expanded here, color-mix() a problem with its substitute.
            var compat = CssCompat.Rewrite(css);
            foreach (var problem in compat.Problems) Record(Error(problem.Message, CssCompat.Code, problem.Fix));
            foreach (var selector in compat.Selectors) canvasSelectors.Add(new JsonObject { ["path"] = $"<style> line {selector.Line}", ["from"] = selector.From, ["to"] = selector.To });
            css = compat.Css; lightDark += compat.Expanded;
            // H14: an @import goes to the top of the theme stylesheet (the theme install moves it there, once), found by the
            // parser in any line of the stylesheet, never refused.
            var (imports, others) = CssCompat.Imports(css);
            var sheet = CssStylesheet.Parse(others);
            if (sheet.IdNames() is { Count: > 0 } ids)
                throw Error($"css: selectors use {string.Join(", ", ids.Select(i => "#" + i))}, but OutSystems reserves the id attribute (Verify InvalidHTMLAttribute_Id); select by class instead");
            if (sheet.Statements.Count > 0) throw Error($"css: {sheet.Statements[0]} is not compiled; the stylesheet must be self-contained");
            var roots = root.Children.Where(n => !n.IsText && n.Tag != "style").ToList();
            if (roots.Count != 1 || roots[0].Attribute("class") is not { Length: > 0 } scope)
                throw Error("css: a fragment with a <style> needs exactly one root element carrying the class the stylesheet is scoped under");
            var scopeClass = HtmlNode.CollapseSpaces(scope).Split(' ')[0];
            var scoped = sheet.Scoped("." + scopeClass);
            if (imports.Count > 0)
            {
                foreach (var import in imports) importsHoisted.Add(import.Statement);
                scoped = string.Join("\n", imports.Select(i => i.Statement)) + "\n" + scoped;
            }
            return (scoped, scopeClass, sheet.Rules.Count);
        }

        // ---- helpers (the shape of the ops is the HtmlExpander's) -------------------------------------------------------

        /// <summary>The row alias of the enclosing list stands for the current record: Row.Field is &lt;list&gt;.Current.Field.</summary>
        private string Expression(string text, HtmlNode node)
        {
            if (text.Contains("{{", StringComparison.Ordinal)) throw Error($"{node.Where}: {{{{ }}}} does not nest inside an attribute; write the expression directly");
            return Scoped(text);
        }

        private string Scoped(string text)
        {
            foreach (var scope in listScopes)
                text = Regex.Replace(text, @"(?<![\w.])" + Regex.Escape(scope.Alias) + @"(?![\w])", scope.Source + ".Current");
            return text;
        }

        /// <summary>The name of the widget an element creates (C05 of the atritos 3 package). An id is the name, unless the
        /// screen already has it: from an earlier html fragment of this job (HTML_ID_DUPLICATE) or from the base or another op
        /// (NAME_COLLISION), each with the free name. A &lt;Block&gt; without an id has no name of its own (null): the native
        /// instance, CustomName empty and CustomNameIsSuffix True. Any other element is Tag + a number that no widget of the
        /// screen and no id of the fragment has, so two fragments never give the same name. A problem with the id is recorded
        /// and the element still compiles under a generated name, so its other problems come out too.</summary>
        private string? WidgetName(HtmlNode node)
        {
            var index = counters.GetValueOrDefault(node.Tag) + 1;
            if (node.Attribute("id") is { Length: > 0 } authored)
            {
                counters[node.Tag] = index;
                string? problem = null, code = null;
                if (!WidgetNameShape.IsMatch(authored)) problem = $"id=\"{authored}\" is not a valid widget name (a letter, then letters, digits or _)";
                else if (widgetNames.Contains(authored)) problem = $"the name {authored} is already used by another widget of this fragment";
                else if (resolve.Earlier?.Contains(authored) == true) (problem, code) = ($"id=\"{authored}\" is already the name of a widget that an earlier html fragment of this job created in this screen", IdDuplicate);
                else if (resolve.Taken?.Contains(authored) == true) (problem, code) = ($"id=\"{authored}\" is already the name of a widget of this screen", NameCollision);
                if (problem == null) { widgetNames.Add(authored); return authored; }
                var free = WidgetNameShape.IsMatch(authored) ? Free(authored) : null;
                Record(Error($"{node.Where}: {problem}", code ?? Invalid, free == null ? null : $"write id=\"{free}\" (free in this screen), or another name"));
            }
            else if (node.Tag == "block") return null;
            var tag = Capitalise(node.SourceTag);
            while (Taken(tag + index)) index++;
            counters[node.Tag] = index;
            widgetNames.Add(tag + index);
            return tag + index;
        }

        private bool Taken(string name) => widgetNames.Contains(name) || authoredIds.Contains(name) || resolve.Taken?.Contains(name) == true;

        private string Free(string name)
        {
            var n = 2;
            while (Taken(name + n)) n++;
            return name + n;
        }
        private static string Capitalise(string tag)
        {
            var sb = new StringBuilder(); var upper = true;
            foreach (var ch in tag) { if (char.IsLetterOrDigit(ch)) { sb.Append(upper ? char.ToUpperInvariant(ch) : ch); upper = false; } else upper = true; }
            return sb.Length == 0 || !char.IsLetter(sb[0]) ? "W" + sb : sb.ToString();
        }

        private string Create(string parent, string type, HtmlNode? node)
        {
            var name = node == null ? null : WidgetName(node);
            var alias = "$hv." + (++counter);
            if (name == null) Add("create", ("parent", parent), ("type", type), ("as", alias));
            else Add("create", ("parent", parent), ("type", type), ("name", name), ("as", alias));
            if (node?.Attribute("id") is { Length: > 0 } id) idAliases[id] = alias;
            return alias;
        }
        private void Set(string target, string prop, object value) => Add("set", ("target", target), ("prop", prop), ("value", value));
        private void Add(string op, params (string, object?)[] values)
        {
            var node = new JsonObject { ["op"] = op };
            foreach (var (key, value) in values) node[key] = value is JsonNode json ? json.DeepClone() : System.Text.Json.JsonSerializer.SerializeToNode(value);
            ops.Add(node);
        }
    }

    private static string Required(HtmlNode node, string attribute) => node.Attribute(attribute) is { Length: > 0 } value
        ? value : throw Error($"{node.Where}: <{node.SourceTag}> needs {attribute}=\"...\"");
    private static string Join(IEnumerable<string> names) => names.Any() ? string.Join(", ", names.Order(StringComparer.Ordinal)) : "none";
    private static string Quote(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
    private static InvalidOperationException Error(string message) => new FragmentException(Invalid, "html: " + message, null);
    private static InvalidOperationException Error(string message, string code, string? fix = null) => new FragmentException(code, "html: " + message, fix);
}

/// <summary>
/// The html op in its visual form: <c>{"op":"html","parent":"$screen","file":"tests/html/visual/alert.html"}</c>. It reads
/// the module to know what the fragment may name — the variables of the screen or block that owns the parent widget, its
/// screen actions and the module's client actions, the blocks it can instantiate, its images — compiles the fragment with
/// those names, applies the ops in this same command, and installs the fragment stylesheet in the module theme.
/// </summary>
public sealed partial class ModelSession
{
    private JsonNode ApplyHtmlVisual(JsonObject op)
    {
        var authoredParent = op["parent"]?.GetValue<string>() ?? throw new InvalidOperationException("html: 'parent' is required");
        var parent = Resolve(authoredParent) as IObjectSignature
            ?? throw new InvalidOperationException($"html: {authoredParent} is not a model object that can hold widgets");
        var parentRef = ContentOf(parent, authoredParent, ref parent);
        var scope = VisualScope(parent, parentRef);
        var fragment = HtmlVisual.Expand(HtmlVisual.Source(op), parentRef, scope, op["html"] is JsonValue ? "/html" : "/file");
        for (var i = 0; i < fragment.Ops.Count; i++)
        {
            try { ApplyOne(fragment.Ops[i]); }
            catch (Exception ex) { throw new InvalidOperationException($"html op #{i} ({fragment.Ops[i]["op"]} {fragment.Ops[i]["prop"] ?? fragment.Ops[i]["type"]}): {Unwrap(ex)}", ex); }
        }
        // The names this fragment gave, for the next fragment of the job on the same screen (C05), and each id as the alias
        // $<id> the ops after this one can use (C28), unless the job already uses that alias.
        HtmlVisual.Remember(this, scope.Owner, fragment.Created);
        var aliases = new JsonArray();
        foreach (var (id, alias) in fragment.Ids.OrderBy(p => p.Key, StringComparer.Ordinal))
            if (!_handles.ContainsKey("$" + id) && _handles.TryGetValue(alias, out var widget)) { Register("$" + id, widget); aliases.Add("$" + id); }
        var report = fragment.Report.DeepClone().AsObject();
        report["expanded"] = fragment.Ops.Count;
        // F2 (the owner's decision D1 of 2026-10-17; M1 of the review of the CX17 merge): a widget the fragment created without
        // class is born with the class the Studio gave it, or its trimmed form, by the one rule of the forms of the language that
        // create a widget (ScreenVisual.StudioClassOf); a trim is written by its own set (in the receipt), each said in normalized.
        var classes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var normalized = new JsonArray();
        foreach (var (alias, type, line) in fragment.Unclassed)
        {
            if (!_handles.TryGetValue(alias, out var handle) || handle is not IObjectSignature widget) continue;
            var born = (ModelHost.Prop(widget, "Style") as IExpression)?.Text;
            if (ScreenVisual.StudioClassOf(type, born) is not { } studio) continue;
            if (studio.Writes && studio.Expression != born)
            {
                try { ApplyOne(new JsonObject { ["op"] = "set", ["target"] = alias, ["prop"] = "Style", ["value"] = studio.Expression }); }
                catch (Exception ex) { throw new InvalidOperationException($"html: the class {studio.Expression} of the new {studio.Kind} at line {line}: {Unwrap(ex)}", ex); }
            }
            if (ScreenVisual.CountStudioClass(classes, studio, line) is { } note) normalized.Add(note);
        }
        if (normalized.Count > 0) report["normalized"] = normalized;
        if (fragment.RowGroups.Count > 0)
        {
            var owner = parent;
            while (owner.Parent is IObjectSignature up && !Implements(owner, "IMobileScreen") && !Implements(owner, "IMobileBlock")) owner = up;
            var reachable = RootThemeOf(owner).Reachable;
            foreach (var (list, tag, line) in fragment.RowGroups)
            {
                void Mark(string property, string expression)
                {
                    var marker = "$fragmentRows" + Guid.NewGuid().ToString("N");
                    ApplyOne(new JsonObject { ["op"] = "create", ["parent"] = list, ["type"] = "IExtendedProperty", ["as"] = marker });
                    ApplyOne(new JsonObject { ["op"] = "set", ["target"] = marker, ["prop"] = "Property", ["value"] = property });
                    ApplyOne(new JsonObject { ["op"] = "set", ["target"] = marker, ["prop"] = "Value", ["value"] = expression });
                }
                Mark("disable-virtualization", "True");
                if (reachable) Mark(ScreenVisual.RowsMarker, "\"1\"");
                normalized.Add(new JsonObject { ["code"] = ScreenVisual.ListRendersAllRows, ["element"] = "List", ["line"] = line, ["tag"] = tag,
                    ["rowsMarker"] = reachable, ["note"] = "Native table/list rows keep their layout; the same runtime rule as document creation." });
            }
            foreach (var layout in InstallNativeLayouts(owner)) normalized.Add(layout);
            report["normalized"] = normalized;
        }
        if (aliases.Count > 0) report["aliases"] = aliases;
        if (parentRef != authoredParent) report["parentAuthored"] = authoredParent;
        // The block of the theme is keyed by the screen or block that receives the fragment and the class of its stylesheet
        // (docs/PROTOTIPO-NATIVO.md 4.3 item 2): the same class in two screens is two blocks.
        if (fragment.ScopedCss != null) report["css"]!["theme"] = InstallStylesheet(OwnerName(parent) + ":" + fragment.ScopeClass!, fragment.ScopedCss, report["css"]!.AsObject());
        return report;
    }

    /// <summary>The name of the screen or block that holds the widget (the owner of a fragment).</summary>
    private static string OwnerName(IObjectSignature widget)
    {
        var owner = widget;
        while (owner != null && owner.GetInterface()?.Name is not ("IMobileScreen" or "IMobileBlock")) owner = owner.Parent as IObjectSignature;
        return (owner == null ? null : TypeResolver.Name(owner)) ?? "module";
    }

    /// <summary>A screen with a layout receives the fragment in the layout's content placeholder (MainContent, else Content),
    /// as the Studio does when a widget is dropped on the screen; the Cardapio BackOffice screens rendered their content outside
    /// LayoutBlank. A layout without a content placeholder is refused with the exact paths that can hold the fragment.</summary>
    private string ContentOf(IObjectSignature parent, string parentRef, ref IObjectSignature resolved)
    {
        if (parent.GetInterface()?.Name != "IMobileScreen") return parentRef;
        IObjectSignature? layout;
        try { layout = Resolve(parentRef + "/#IMobileBlockInstanceWidget") as IObjectSignature; }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException) { return parentRef; } // a screen without a layout holds widgets at its root
        if (layout == null || ModelHost.Prop(layout, "SourceBlock") is not IObjectSignature definition) return parentRef;
        var contract = ScreenContracts.Read(definition, "layout");
        var placeholder = contract.Placeholders.Any(x => x.Name == "MainContent") ? "MainContent" : contract.Placeholders.Any(x => x.Name == "Content") ? "Content" : null;
        if (placeholder == null)
        {
            var paths = contract.Placeholders.Select(x => $"{parentRef}/#IMobileBlockInstanceWidget/{x.Name}").ToArray();
            const string fix = "set \"parent\" to one of the layout's placeholders, or give the screen a layout with Content (set SourceBlock IMobileBlock:LayoutBlank)";
            var message = $"html: {parentRef} has the layout {TypeResolver.Name(definition)} without a Content or MainContent placeholder; the fragment would land outside the layout. Placeholders: {(paths.Length == 0 ? "none" : string.Join(", ", paths))}";
            throw new KernelRefusalException("HTML_INVALID", message, new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, "/parent", "HTML_INVALID", "error", message, fix))));
        }
        var content = parentRef + "/#IMobileBlockInstanceWidget/" + placeholder;
        if (Resolve(content) is IObjectSignature holder) resolved = holder;
        return content;
    }

    /// <summary>The names the fragment may use, read from the module itself: nothing here is created by the fragment.</summary>
    private HtmlVisualScope VisualScope(IObjectSignature parent, string parentRef)
    {
        var owner = parent;
        while (owner != null && owner.GetInterface()?.Name is not ("IMobileScreen" or "IMobileBlock")) owner = owner.Parent as IObjectSignature;
        if (owner == null) throw new InvalidOperationException($"html: {parentRef} is not inside a Reactive/Mobile screen or block");
        var variables = new List<string>();
        var inputTypes = HtmlVisualScope.Map();
        var bindTypes = HtmlVisualScope.Map();
        foreach (var property in new[] { "LocalVariables", "InputParameters" })
            foreach (var variable in Sequence(owner, property).OfType<IObjectSignature>())
            {
                if (TypeResolver.Name(variable) is not { Length: > 0 } name) continue;
                variables.Add(name);
                // ModelHost.Prop reads an explicit interface implementation too (the O11 variable's DataType is one).
                var dataType = ModelHost.Prop(variable, "DataType");
                if (InputTypeOf(dataType) is { } inputType) inputTypes.TryAdd(name, inputType);
                if (BasicTypeName(dataType) is { } basic) bindTypes.TryAdd(name, basic);
                // One level of a record: bind="Perfil.Telefone" is checked against the attribute's own type.
                else if (dataType is IObjectSignature record)
                    foreach (var attribute in record.Children.OfType<IObjectSignature>())
                        if (TypeResolver.Name(attribute) is { Length: > 0 } attributeName && FindProperty(attribute, "DataType")?.GetValue(attribute) is { } attributeType
                            && BasicTypeName(attributeType) is { } attributeBasic)
                            bindTypes.TryAdd(name + "." + attributeName, attributeBasic);
            }
        var actions = HtmlVisualScope.Map();
        foreach (var action in Sequence(owner, "ScreenActions").OfType<IObjectSignature>())
            actions.TryAdd(TypeResolver.Name(action) ?? "", "@" + action.ObjectKey);
        var blocks = HtmlVisualScope.Map();
        var images = HtmlVisualScope.Map();
        var screens = HtmlVisualScope.Map();
        foreach (var element in Descendants())
        {
            var elementName = TypeResolver.Name(element);
            if (elementName is not { Length: > 0 }) continue;
            if (Implements(element, "IClientAction") || Implements(element, "IClientActionSignature")) actions.TryAdd(elementName, "@" + element.ObjectKey);
            else if (Implements(element, "IMobileBlock") || Implements(element, "IMobileBlockSignature")) blocks.TryAdd(elementName, "IMobileBlock:" + elementName);
            else if (Implements(element, "OutSystems.Model.UI.IImage") || Implements(element, "OutSystems.Model.UI.IImageSignature")) images.TryAdd(elementName, "IImage:" + elementName);
            else if (Implements(element, "IMobileScreen") || Implements(element, "IMobileScreenSignature")) screens.TryAdd(elementName, "@" + element.ObjectKey);
        }
        // Every widget name of the screen or block as it is now (the base and the ops of the job before this one).
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var widget in owner.GetAllDescendantsOfType<IObjectSignature>())
            if (Implements(widget, "IWidget") && TypeResolver.Name(widget) is { Length: > 0 } widgetName) taken.Add(widgetName);
        var ownerKey = owner.ObjectKey?.ToString();
        ScreenContract? Contract(string reference)
        {
            try { return Resolve(reference) is IObjectSignature o ? ScreenContracts.Read(o, reference) : null; }
            catch (KeyNotFoundException) { return null; }
        }
        // "Does this Studio's widget have this property" is answered by the loaded Model API itself: the ODC IIcon has a Weight
        // the O11 one lacks, and an ODC icon without a Weight is "Non Existing Icon" in the live Studio.
        return new HtmlVisualScope(variables, actions, blocks, images, Contract, Supports: WidgetHasProperty, InputTypes: inputTypes, BindTypes: bindTypes)
        {
            Screens = screens, Taken = taken, Earlier = HtmlVisual.Earlier(this, ownerKey), Owner = ownerKey,
        };
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, Type?> WidgetInterfaces = new(StringComparer.Ordinal);

    /// <summary>True when the widget interface of the loaded Model API (NRWidgets first) declares the property; the kernel
    /// vocabulary answers for an interface this runtime does not load.</summary>
    private static bool WidgetHasProperty(string type, string property)
    {
        var iface = WidgetInterfaces.GetOrAdd(type, name =>
        {
            var candidates = AppDomain.CurrentDomain.GetAssemblies().SelectMany(a => { try { return a.GetTypes(); } catch (System.Reflection.ReflectionTypeLoadException e) { return e.Types.OfType<Type>().ToArray(); } catch { return []; } })
                .Where(t => t.IsInterface && t.Name == name).ToArray();
            return candidates.FirstOrDefault(t => t.Namespace?.EndsWith("NRWidgets", StringComparison.Ordinal) == true) ?? candidates.FirstOrDefault();
        });
        if (iface == null) return HtmlVisualScope.Empty.Accepts(type, property);
        return new[] { iface }.Concat(iface.GetInterfaces()).Any(i => i.GetProperty(property) != null);
    }

    /// <summary>The InputType the Studio gives an input bound to a variable of this basic type; null for Text and the rest.</summary>
    private string? InputTypeOf(object? dataType)
    {
        foreach (var (basic, inputType) in new[] { ("Time", "Time"), ("Date", "Date"), ("Date Time", "Datetime"), ("Integer", "Number"), ("Long Integer", "Number"),
                     ("Decimal", "Number"), ("Currency", "Number"), ("Email", "Email"), ("Phone Number", "Phone") })
            if (dataType != null && ReferenceEquals(TypeResolver.Basic(_es, basic), dataType)) return inputType;
        return null;
    }

    /// <summary>The name of a basic data type (Text, Integer, Boolean, Phone Number, ...), or null for any other type.</summary>
    private string? BasicTypeName(object? dataType)
    {
        if (dataType == null) return null;
        string[] basics = ["Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency", "Email", "Phone Number", "Binary Data"];
        foreach (var basic in basics)
            if (ReferenceEquals(TypeResolver.Basic(_es, basic), dataType)) return basic;
        // A basic type the module reaches through another instance answers by its display name.
        var shown = UiCatalog.TypeName(dataType);
        return basics.FirstOrDefault(b => string.Equals(b, shown, StringComparison.OrdinalIgnoreCase) || string.Equals(b.Replace(" ", ""), shown, StringComparison.OrdinalIgnoreCase));
    }
}
