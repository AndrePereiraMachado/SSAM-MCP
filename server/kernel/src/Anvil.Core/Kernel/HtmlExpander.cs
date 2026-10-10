using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
namespace Anvil.Core;

/// <summary>Ops to apply, the compilation report and, when the page carries a stylesheet, the CSS scoped to the page root.</summary>
public sealed record HtmlCompilation(List<JsonObject> Ops, JsonObject Report, string? ScopedCss, string ScopeClass);

/// <summary>
/// Compiles an authored HTML/CSS page plus a small typed binding manifest into the existing verbs. The page keeps its tags,
/// order, classes and attributes (Container for div, HTML Element for the other tags, Expression for text); data, filters,
/// events and client functions come only from the closed manifest keyed by data-av attributes. Capabilities without a
/// proven translation are rejected with the source line and column instead of being approximated (nothing is dropped silently:
/// a visible binding is a native If widget, and the children of a link or button are its child widgets). The CSS is rewritten
/// under the page root class so the theme carries it without leaking into other screens.
/// </summary>
public static class HtmlExpander
{
    private static readonly Dictionary<string, string[]> Shapes = new()
    {
        ["data"] = ["screen", "title", "layout", "roles", "html", "css", "stylesheet", "vars", "source", "sources", "search", "filters", "derived", "scripts", "bindings"],
        ["var"] = ["name", "type", "default"],
        ["derived"] = ["name", "type", "source", "output", "max", "sum"],
        ["source"] = ["entity", "action", "as", "where", "sort", "max", "args", "outputs", "state", "paging"],
        ["paging"] = ["offset", "size", "total"],
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
    private static readonly string[] StylesheetModes = ["theme", "none"];
    // <br> compiles to an empty Container (a block that breaks the line): the Verify refuses Tag br ("'br' is not a valid HTML
    // tag", Cardapio 2026-10-06). Tag hr passes the Verify (the Cardapio BackOffice merged four with 0 new errors): an element.
    private static readonly HashSet<string> Elements = new(StringComparer.Ordinal) { "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "li", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "b", "em", "i", "small", "code", "hr" };
    private static readonly HashSet<string> TextTags = new(StringComparer.Ordinal) { "div", "li", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "strong", "b", "em", "i", "small", "code", "td", "th" };
    private static readonly HashSet<string> Repeaters = new(StringComparer.Ordinal) { "div", "ul", "ol", "section" };
    private static readonly HashSet<string> Transparent = new(StringComparer.Ordinal) { "html", "head", "body" };
    private static readonly HashSet<string> Ignored = new(StringComparer.Ordinal) { "meta", "title", "style" };
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
    private static readonly HashSet<string> AllowedAttributes = new(StringComparer.Ordinal) { "class", "id", "style", "title", "role", "hidden", "placeholder", "for", "type", "href", "required", "maxlength", "autocomplete", "lang", "dir", "value" };
    /// <summary>Roles of a screen the page creates without data.roles: authenticated users only, as the component path does
    /// (HtmlComponents); a page open to anyone says roles:["Anonymous"].</summary>
    public static readonly string[] DefaultRoles = ["Registered"];

    // The fragment form of the html op ({"op":"html","parent":...}, HtmlVisual) already compiles what the page form refuses below:
    // the refusal carries that exact syntax (HtmlVisualVocabulary.json) instead of a dead end. Single quotes keep it valid inside JSON.
    internal const string FragmentSelect = "<select bind='Var' options='List' value='List.Current.X.Id' label='List.Current.X.Label'/>";
    internal const string FragmentList = "<div list='Source.List' as='Row'><div>{{ Row.X.Name }}<div list='Row.X.Items' as='Item'>{{ Item.Name }}</div></div></div>";

    public static JsonObject Schema() => new()
    {
        ["kinds"] = new JsonArray(Kinds.Select(k => (JsonNode)k).ToArray()),
        ["shapes"] = new JsonObject(Shapes.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)new JsonArray(p.Value.Select(k => (JsonNode)k).ToArray())))),
        ["tags"] = new JsonArray(new[] { "div", "input", "select", "button", "a", "label", "table", "thead", "tbody", "tr", "th", "td", "br" }.Concat(Elements).Order().Select(t => (JsonNode)t).ToArray()),
        ["attributes"] = new JsonArray(AllowedAttributes.Order().Select(a => (JsonNode)a).ToArray()),
        ["stylesheet"] = new JsonArray(StylesheetModes.Select(m => (JsonNode)m).ToArray()),
        ["layout"] = new JsonArray("theme", "blank"),
    };

    /// <param name="existing">Description of the screen when it already exists (variables by name and type); null for a new screen.
    /// The caller has already removed the presentation and the screen logic it regenerates.</param>
    public static HtmlCompilation Expand(JsonObject data, Func<string[], string?> tryRef, Func<string, ScreenContract?> contract, string runtime, JsonObject? existing = null)
    {
        if (runtime is not ("CrossDevice" or "Reactive" or "Mobile")) throw Error("only Reactive and Mobile screens are supported");
        Keys(data, "data");
        return new Compiler(data, tryRef, contract, runtime == "Mobile", existing).Run();
    }

    /// <summary>What check-job can prove without a module: the HTML and CSS parse, the stylesheet respects the id rule, the manifest
    /// has the closed shape and every data-av key matches one binding. References, fields and arguments still need the base.</summary>
    public static JsonObject Preflight(JsonObject data)
    {
        Keys(data, "data");
        var compiler = new Compiler(data, _ => null, _ => null, false, null);
        return compiler.Preflight();
    }

    private sealed record SourceInfo(string As, string Alias, bool IsEntity, string? Entity, Dictionary<string, (string List, string Current, IReadOnlyList<UiParam> Fields)> Lists);
    private sealed record ListScope(string List, string Current, IReadOnlyList<UiParam> Fields);

    private sealed class Compiler(JsonObject data, Func<string[], string?> tryRef, Func<string, ScreenContract?> contracts, bool mobile, JsonObject? existing)
    {
        private readonly string name = Required(data, "screen");
        private readonly List<JsonObject> ops = [];
        private readonly Dictionary<string, JsonObject> bindings = new(StringComparer.Ordinal);
        private readonly Dictionary<string, HtmlNode> keyed = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> idAliases = new(StringComparer.Ordinal);
        private readonly List<(string Label, string Id, HtmlNode Node)> labels = [];
        private readonly Dictionary<string, string> actions = new(StringComparer.Ordinal);
        private readonly HashSet<string> widgetNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> variables = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<SourceInfo> sources = [];
        private readonly Dictionary<string, (string Offset, int Size, string Total)> paging = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> scriptNames = new(StringComparer.OrdinalIgnoreCase);
        private readonly Stack<ListScope> listScopes = new();
        private readonly Stack<HtmlNode> clickables = new();
        private readonly List<string> keptVariables = [], createdVariables = [];
        private List<string> roles = [];
        private bool anonymous;
        private int counter, lightDark;
        private bool Existing => existing != null;

        /// <summary>A refusal of the page with its code and fix, one problem with a pointer relative to op.data (I4).</summary>
        private static InvalidOperationException Coded(string code, string message, string fix, string pointer) =>
            new(message, new KernelRefusalException(code, message, new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, pointer, code, "error", message, fix)))));
        private string Root => Existing ? "IMobileScreen:" + name : "$html." + name;
        private bool BlankLayout => data["layout"]?.ToString() == "blank";
        private string Main => Root + "/#IMobileBlockInstanceWidget/" + (mobile || BlankLayout ? "Content" : "MainContent");
        private string ScopeClass => "av-" + name.ToLowerInvariant();
        private string Ref(params string[] candidates) => tryRef(candidates) ?? throw Error($"{name}: reference not found: {string.Join(" or ", candidates)}");
        private ScreenContract Contract(string reference) => contracts(reference) ?? throw Error($"{name}: public signature is unavailable: {reference}");
        /// <summary>The fragment op that compiles what the page form refuses, aimed at this screen's content placeholder.</summary>
        private string FragmentHint(string html) =>
            $" The fragment form of the html op compiles it: after this page op add {{\"op\":\"html\",\"parent\":\"IMobileScreen:{name}/#IMobileBlockInstanceWidget/{(mobile || BlankLayout ? "Content" : "MainContent")}\",\"html\":\"{html}\"}} (any widget of the screen can be the parent).";

        public JsonObject Preflight()
        {
            if (data["layout"] is { } layout && layout.ToString() is not ("blank" or "theme")) throw Error("layout must be blank or theme");
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_]*$")) throw Error($"invalid screen name '{name}'");
            DeclaredRoles();
            var root = HtmlSource.Parse(Required(data, "html"));
            foreach (var node in root.Descendants()) if (!node.IsText && Unsupported.TryGetValue(node.Tag, out var why)) throw Error($"{node.Where}: {why}");
            var css = Stylesheet(root);
            Bindings(root);
            foreach (var v in Objects(data, "vars")) Keys(v, "var");
            foreach (var s in Objects(data, "sources")) Keys(s, "source");
            foreach (var d in Objects(data, "derived")) Keys(d, "derived");
            foreach (var s in Objects(data, "scripts")) Keys(s, "script");
            return new JsonObject { ["screen"] = name, ["keys"] = keyed.Count, ["elements"] = root.Descendants().Count(n => !n.IsText), ["cssRules"] = css.Sheet.Rules.Count };
        }

        public HtmlCompilation Run()
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z][A-Za-z0-9_]*$")) throw Error($"invalid screen name '{name}'");
            if (!Existing && tryRef(["IMobileScreen:" + name]) != null) throw Error($"screen '{name}' exists; the caller must describe it to update it in place");
            var root = HtmlSource.Parse(Required(data, "html"));
            foreach (var node in root.Descendants()) if (!node.IsText && Unsupported.TryGetValue(node.Tag, out var why)) throw Error($"{node.Where}: {why}");
            var css = Stylesheet(root);
            var mode = data["stylesheet"]?.GetValue<string>() ?? "theme";
            if (!StylesheetModes.Contains(mode)) throw Error($"stylesheet must be one of: {string.Join(", ", StylesheetModes)}");
            Bindings(root);
            Declare(root.Descendants().Any(n => n.Tag == "h1"));
            Variables();
            Scripts();
            Sources();
            Derived();
            var page = Create(Main, "IContainer", "Page"); Set(page, "Style", Quote(ScopeClass));
            foreach (var node in Content(root)) Widget(node, page);
            foreach (var (label, id, node) in labels)
            {
                if (!idAliases.TryGetValue(id, out var target)) throw Error($"{node.Where}: label for=\"{id}\" does not name an input or select of this page");
                Set(label, "TargetWidget", target);
            }
            // Native widgets default to fill-parent widths, unlike HTML buttons/spans/flex items. A zero-specificity
            // target restores intrinsic sizing; authored widths (including table/input 100%) still take precedence.
            var scoped = mode == "theme" ? "." + ScopeClass + " :where(.OSFillParent) { width: auto; }\n." + ScopeClass + " .ThemeGrid_MarginGutter { margin-left: 0; }\n" + css.Sheet.Scoped("." + ScopeClass) : null;
            var report = new JsonObject
            {
                ["screen"] = name, ["mode"] = Existing ? "update" : "create",
                ["roles"] = new JsonArray(roles.Select(r => (JsonNode)r).ToArray()),
                ["anonymous"] = anonymous,
                ["elements"] = counter,
                ["keys"] = new JsonArray(keyed.Keys.Order(StringComparer.Ordinal).Select(k => (JsonNode)k).ToArray()),
                ["sources"] = new JsonArray(sources.Select(s => (JsonNode)s.As).ToArray()),
                ["variables"] = new JsonObject { ["kept"] = new JsonArray(keptVariables.Select(v => (JsonNode)v).ToArray()), ["created"] = new JsonArray(createdVariables.Select(v => (JsonNode)v).ToArray()) },
                ["stylesheet"] = new JsonObject { ["mode"] = mode, ["scope"] = "." + ScopeClass, ["rules"] = css.Sheet.Rules.Count, ["chars"] = css.Text.Length, ["sha256"] = Sha(css.Text), ["installed"] = false },
                ["html"] = new JsonObject { ["sha256"] = Sha(Required(data, "html")) },
            };
            if (lightDark > 0) report["stylesheet"]!["lightDarkExpanded"] = lightDark;
            return new HtmlCompilation(ops, report, scoped, ScopeClass);
        }

        // ---- validation -------------------------------------------------------------------------------------------

        private (CssStylesheet Sheet, string Text) Stylesheet(HtmlNode root)
        {
            var text = new StringBuilder();
            // CSS the theme does not render (A30): light-dark() expanded, color-mix() refused with its substitute, all at once.
            var unsupported = new List<(string Pointer, CssCompat.Problem Problem)>();
            string Rendered(string css, string pointer)
            {
                var compat = CssCompat.Rewrite(css);
                unsupported.AddRange(compat.Problems.Select(p => (pointer, p)));
                lightDark += compat.Expanded;
                return compat.Css;
            }
            foreach (var style in root.Descendants().Where(n => n.Tag == "style"))
            {
                if (style.Attribute("media") != null) throw Error($"{style.Where}: use @media inside the stylesheet instead of a media attribute");
                text.Append(Rendered(string.Concat(style.Children.Select(c => c.Text)), "/html")).Append('\n');
            }
            if (data["css"] is JsonValue extra) text.Append(Rendered(extra.GetValue<string>(), "/css")).Append('\n');
            if (unsupported.Count > 0)
            {
                var problems = new JsonArray(unsupported.Select(u => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, u.Pointer, CssCompat.Code, "error", "html: " + u.Problem.Message, u.Problem.Fix))).ToArray());
                var message = string.Join(" | ", unsupported.Select(u => "html: " + u.Problem.Message + " Fix: " + u.Problem.Fix));
                if (unsupported.Count == 1) throw new InvalidOperationException(message, new KernelRefusalException(CssCompat.Code, message, problems));
                throw new KernelRefusalException("HTML_INVALID", $"html: {unsupported.Count} CSS problems, all reported at once: {message}", problems);
            }
            var css = text.ToString().Trim();
            var sheet = CssStylesheet.Parse(css);
            if (sheet.IdNames() is { Count: > 0 } ids) throw Error($"css: selectors use {string.Join(", ", ids.Select(i => "#" + i))}, but OutSystems reserves the id attribute (Verify InvalidHTMLAttribute_Id); select by class instead");
            if (sheet.Statements.Count > 0) throw Error($"css: {sheet.Statements[0]} is not compiled; the stylesheet must be self-contained");
            return (sheet, css);
        }

        private void Bindings(HtmlNode root)
        {
            if (data["bindings"] is JsonObject declared)
                foreach (var (key, value) in declared)
                {
                    if (value is not JsonObject binding) throw Error($"binding '{key}' must be an object");
                    var kind = Required(binding, "kind");
                    if (!Kinds.Contains(kind)) throw Error($"binding '{key}': unknown kind '{kind}'; allowed: {string.Join(", ", Kinds)}");
                    Keys(binding, kind, $"binding '{key}'");
                    bindings[key] = binding;
                }
            if (data["search"] is JsonObject search)
            {
                Keys(search, "search"); var key = Required(search, "key");
                if (bindings.ContainsKey(key)) throw Error($"search key '{key}' is also declared in bindings");
                bindings[key] = new JsonObject { ["kind"] = "search", ["field"] = search["field"]?.DeepClone(), ["label"] = search["label"]?.DeepClone(), ["variable"] = search["variable"]?.GetValue<string>() ?? "SearchText" };
            }
            foreach (var filter in Objects(data, "filters"))
            {
                Keys(filter, "filter"); var key = Required(filter, "key"); var from = Required(filter, "from");
                if (bindings.ContainsKey(key)) throw Error($"filter key '{key}' is declared twice");
                bindings[key] = new JsonObject { ["kind"] = "filter", ["field"] = filter["field"]?.DeepClone(), ["from"] = from, ["label"] = filter["label"]?.DeepClone(), ["variable"] = filter["variable"]?.GetValue<string>() ?? "Filter_" + (filter["field"]?.GetValue<string>() ?? from) };
            }
            foreach (var node in root.Descendants().Where(n => !n.IsText && n.Attribute("data-av") != null))
            {
                var key = node.Attribute("data-av")!;
                if (key.Length == 0) throw Error($"{node.Where}: data-av must name a binding key");
                if (keyed.ContainsKey(key)) throw Error($"{node.Where}: data-av \"{key}\" is used twice (first at {keyed[key].Where}); keys identify one element");
                if (!bindings.ContainsKey(key)) throw Error($"{node.Where}: data-av \"{key}\" has no binding; declare it in bindings, search or filters");
                keyed[key] = node;
            }
            foreach (var key in bindings.Keys)
                if (!keyed.ContainsKey(key)) throw Error($"binding '{key}' matches no element; add data-av=\"{key}\" to the element it describes");
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
            var layoutContract = Contract(layoutReference);
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
            var current = existing?["roles"] is JsonArray names ? names.Select(r => r!.ToString()).ToList() : [];
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
            var names = new List<string>();
            foreach (var item in array)
            {
                var role = item is JsonValue value && value.TryGetValue<string>(out var text) ? text.Trim() : "";
                if (role.Length == 0) throw Error(shape);
                if (SystemRole(role)) role = role.Equals("Anonymous", StringComparison.OrdinalIgnoreCase) ? "Anonymous" : "Registered";
                if (!names.Contains(role, StringComparer.OrdinalIgnoreCase)) names.Add(role);
            }
            if (names.Contains("Anonymous") && !names.Contains("Registered")) names.Add("Registered");
            return names;
        }
        private static bool SystemRole(string role) => role.Equals("Anonymous", StringComparison.OrdinalIgnoreCase) || role.Equals("Registered", StringComparison.OrdinalIgnoreCase);

        private void Variables()
        {
            foreach (var v in Objects(data, "vars"))
            {
                Keys(v, "var"); Variable(Required(v, "name"), Required(v, "type"), v["default"]?.GetValue<string>());
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

        /// <summary>Client functions written in JavaScript, callable from binding expressions: an IClientAction with Function on and one
        /// JavaScript node carrying the inputs, outputs and code (the shape proved by client-js-reactive.json).</summary>
        private void Scripts()
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var script in Objects(data, "scripts"))
            {
                Keys(script, "script"); var scriptName = Required(script, "name");
                if (!System.Text.RegularExpressions.Regex.IsMatch(scriptName, "^[A-Za-z][A-Za-z0-9_]*$")) throw Error($"script '{scriptName}' is not a valid action name");
                if (!names.Add(scriptName)) throw Error($"script '{scriptName}' is declared twice");
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
                foreach (var (key, binding) in bindings)
                    if (binding["kind"]?.ToString() is "list" or "field" or "refresh" or "date") throw Error($"binding '{key}' ({binding["kind"]}) requires a source");
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
            var fields = Contract(reference).Fields; var list = asName + ".List"; var current = list + ".Current." + entity;
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
                var f = searchField.GetValue<string>(); var found = fields.FirstOrDefault(p => p.Name.Equals(f, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"search.field '{f}' does not exist in {entity}");
                if (found.Type != "Text") throw Error("search.field must be a Text attribute");
                Where(alias, $"{entity}.{found.Name} like \"%\" + {search["variable"]?.GetValue<string>() ?? "SearchText"} + \"%\"");
            }
            foreach (var filter in filters.Where(f => f["field"] != null))
            {
                var f = filter["field"]!.GetValue<string>(); var from = Required(filter, "from"); var variable = bindings[Required(filter, "key")]["variable"]!.ToString();
                var found = fields.FirstOrDefault(p => p.Name.Equals(f, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"filter field '{f}' does not exist in {entity}");
                if (!found.Type.Equals(from + " Identifier", StringComparison.OrdinalIgnoreCase)) throw Error($"{name}: {f} must have type {from} Identifier");
                Where(alias, $"{variable} = NullIdentifier() or {entity}.{f} = {variable}");
            }
            sources.Add(new SourceInfo(asName, alias, true, entity, new(StringComparer.OrdinalIgnoreCase) { ["List"] = (list, current, fields) }));
        }

        /// <summary>A data action exposing every output of the server/service action (or the declared subset), assigned from one call.</summary>
        private void ActionSource(JsonObject source, string asName, string alias)
        {
            if (source["where"] != null || source["sort"] != null || source["max"] != null) throw Error("action source takes args, not where/sort/max");
            var action = Required(source, "action"); var reference = Ref("IServerAction:" + action, "IServiceAction:" + action);
            var signature = Contract(reference);
            var wanted = source["outputs"] is JsonArray subset ? subset.Select(o => o!.GetValue<string>()).ToList() : signature.Outputs.Select(o => o.Name).ToList();
            if (wanted.Count == 0) throw Error($"{action} has no outputs to expose");
            var args = source["args"]?.DeepClone().AsObject() ?? new();
            if (source["paging"] is JsonObject page)
            {
                Keys(page, "paging"); var offset = Required(page, "offset"); var size = page["size"]?.GetValue<int>() ?? 20; var total = Required(page, "total");
                if (size < 1 || size > 100) throw Error("paging.size must be between 1 and 100");
                if (!wanted.Contains(total) || !signature.Outputs.Any(o => o.Name == total && o.Type is "Integer" or "Long Integer")) throw Error("paging.total must name an exposed integer output");
                if (args.ContainsKey("StartIndex") || args.ContainsKey("MaxRecords")) throw Error("paging owns StartIndex/MaxRecords; omit these args");
                Variable(offset, "Integer", "0"); args["StartIndex"] = offset; args["MaxRecords"] = size.ToString();
                paging.Add(asName, (offset, size, asName + "." + total));
            }
            else if (source["paging"] != null) throw Error("source.paging must be an object");
            CheckArgs(signature.Inputs, args);
            Create(Root, "IDataAction", asName, alias); Add("delete", ("target", alias + "/Out1"));
            var lists = new Dictionary<string, (string, string, IReadOnlyList<UiParam>)>(StringComparer.OrdinalIgnoreCase);
            var assignments = new Dictionary<string, string>();
            var state = source["state"]?.GetValue<bool>() ?? false;
            if (state)
            {
                if (signature.Outputs.Any(o => o.Name == "FetchSucceeded")) throw Error("state reserves the FetchSucceeded output");
                var success = Create(alias, "IOutputParameter", "FetchSucceeded"); Set(success, "DataType", "Boolean");
                assignments["FetchSucceeded"] = "True";
            }
            foreach (var outputName in wanted)
            {
                var output = signature.Outputs.FirstOrDefault(o => o.Name.Equals(outputName, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"{action} has no output '{outputName}'; available: {string.Join(", ", signature.Outputs.Select(o => o.Name))}");
                var node = Create(alias, "IOutputParameter", output.Name); Set(node, "DataType", output.Type);
                assignments[output.Name] = "ReadSource." + output.Name;
                if (output.Type.EndsWith(" List", StringComparison.Ordinal)) lists[output.Name] = (asName + "." + output.Name, asName + "." + output.Name + ".Current", signature.OutputFields.GetValueOrDefault(output.Name) ?? []);
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
                var found = scope.Fields.FirstOrDefault(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"{where}: field '{field}' does not exist in the list; available: {string.Join(", ", scope.Fields.Select(f => f.Name))}");
                Variable(derivedName, type, "0");
                var value = scope.Current + "." + found.Name;
                if (!handlers.TryGetValue(source.Alias, out var handler))
                {
                    var newAction = Create(Root, "IScreenAction", "Derive" + derivedName);
                    handler = (newAction, Create(newAction, "IStartNode"));
                    Set(source.Alias + "/OnAfterFetch", "Destination", newAction);
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
            foreach (var handler in handlers.Values)
            {
                var end = Create(handler.Action, "IEndNode"); Link(handler.Tail, end); Add("layout", ("target", handler.Action));
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

        private string RefreshAction(string actionName, IReadOnlyList<string>? only = null, bool resetPaging = false)
        {
            var key = actionName + "|" + string.Join(",", only ?? []) + "|" + resetPaging;
            if (actions.TryGetValue(key, out var existingAction)) return existingAction;
            var targets = only == null ? sources : only.Select(o => sources.FirstOrDefault(s => s.As.Equals(o, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"refresh names unknown source '{o}'; declared: {string.Join(", ", sources.Select(s => s.As))}")).ToList();
            if (targets.Count == 0) throw Error($"{name}: '{actionName}' needs a source to refresh");
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

        private JsonObject? BindingOf(HtmlNode node) => node.Attribute("data-av") is { } key ? bindings[key] : null;

        private void Widget(HtmlNode node, string parent)
        {
            if (node.IsText) { var text = HtmlNode.CollapseSpaces(node.Text); if (text.Length > 0) Expression(parent, Quote(text)); return; }
            var tag = node.Tag;
            if (Ignored.Contains(tag)) return;
            if (Transparent.Contains(tag)) { foreach (var child in node.Children) Widget(child, parent); return; }
            var binding = BindingOf(node); var kind = binding?["kind"]?.ToString();
            if (clickables.Count > 0 && InsideClickable(tag, kind) is { } refusal)
            {
                var outer = clickables.Peek();
                throw Error($"{node.Where}{(kind != null ? $" (kind {kind})" : "")} cannot be compiled inside <{outer.Tag}> ({outer.Where}): {refusal}");
            }
            switch (tag)
            {
                case "input": Input(node, parent, binding, kind); return;
                case "select": Select(node, parent, kind); return;
                case "button": case "a": Clickable(node, parent, binding, kind); return;
                case "label": Label(node, parent); return;
                case "table": Table(node, parent, binding, kind); return;
                case "thead": case "tbody": case "tfoot": case "tr": case "th": case "td": case "caption": case "colgroup": case "col":
                    throw Error($"{node.Where}: <{tag}> only belongs inside a <table> bound with kind list");
                case "option": throw Error($"{node.Where}: options come from the filter's static entity; a <select> must not contain literal options." + FragmentHint(FragmentSelect));
            }
            if (kind == "list") { Repeater(node, parent, binding!); return; }
            if (kind == "block")
            {
                if (tag != "div" || node.Elements.Any() || node.InnerText().Length > 0) throw Error($"{node.Where}: block binding needs an empty div");
                var wrapper = Create(parent, "IContainer", NameFor(node)); Attributes(node, wrapper, true, true, null);
                var reference = Ref("IMobileBlock:" + Required(binding!, "block")); var contract = Contract(reference);
                if (contract.Placeholders.Count > 0 || contract.Events.Any(e => e.Mandatory))
                    throw Error($"{node.Where}: block binding needs a block without placeholders or required event handlers; {Required(binding!, "block")} has "
                        + $"{(contract.Placeholders.Count > 0 ? "placeholders " + string.Join(", ", contract.Placeholders.Select(p => p.Name)) : "")}"
                        + $"{(contract.Placeholders.Count > 0 && contract.Events.Any(e => e.Mandatory) ? " and " : "")}"
                        + $"{(contract.Events.Any(e => e.Mandatory) ? "required events " + string.Join(", ", contract.Events.Where(e => e.Mandatory).Select(e => e.Name)) : "")}."
                        + FragmentHint(BlockFragment(Required(binding!, "block"), contract)));
                var args = binding!["args"]?.AsObject() ?? new(); CheckArgs(contract.Inputs, args);
                var block = Create(wrapper, "IMobileBlockInstanceWidget"); ops[^1]["source"] = reference;
                foreach (var arg in args) Set(block + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                return;
            }
            if (tag == "div") { Container(node, parent, binding, kind); return; }
            if (tag == "br") { Create(parent, "IContainer", NameFor(node)); return; }
            if (!Elements.Contains(tag)) throw Error($"{node.Where}: <{tag}> is not compiled by this version; supported tags: {string.Join(", ", Schema()["tags"]!.AsArray().Select(t => t!.ToString()))}");
            if (kind is "navigate" or "call" or "refresh" or "search" or "filter" or "date" or "visible") throw Error($"{node.Where}: kind {kind} needs a {KindTarget(kind)}, not <{tag}>");
            var alias = Create(parent, "IAdvancedHtml", NameFor(node)); Set(alias, "Tag", tag);
            Attributes(node, alias, hasStyle: false, hasVisible: false, binding);
            Inner(node, alias + "/Content", binding, kind);
        }

        /// <summary>What a Link/Button cannot hold as a child widget, with what to do instead; null when the child compiles inside it
        /// (text, Containers, HTML Elements such as icons, and the bindings text/field/class/style/visible).</summary>
        private static string? InsideClickable(string tag, string? kind) => tag switch
        {
            "a" or "button" => "a Link/Button cannot contain another Link/Button (nested interactive content); move it out, or make the outer element a <div> and keep one control",
            "input" or "select" or "label" => "form controls do not belong inside a Link/Button; place the control next to it",
            "table" => "a table (TableRecords) is not compiled inside a Link/Button; put the table outside and the <a>/<button> inside a cell of its template row",
            _ => kind switch
            {
                "list" => "a repeated region (List) is not compiled inside a Link/Button; put the List outside and the <a>/<button> as its row template",
                "block" => "a block instance is not compiled inside a Link/Button; place the block next to the control",
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
            if (kind is "navigate" or "call" or "refresh" or "search" or "filter" or "date") throw Error($"{node.Where}: kind {kind} needs a {KindTarget(kind)}, not <div>");
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
            Attributes(node, alias, hasStyle: true, hasVisible: true, binding);
            Inner(node, alias, binding, kind);
        }

        private void Inner(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            switch (kind)
            {
                case "text":
                    if (!TextTags.Contains(node.Tag)) throw Error($"{node.Where}: kind text needs a text element, not <{node.Tag}>");
                    if (node.Elements.Any()) throw Error($"{node.Where}: an element bound with kind text must not contain child elements; its whole content becomes the expression");
                    Expression(parent, Required(binding!, "value")); return;
                case "field":
                    if (listScopes.Count == 0) throw Error($"{node.Where}: kind field is only valid inside an element bound with kind list");
                    if (node.Elements.Any()) throw Error($"{node.Where}: an element bound with kind field must not contain child elements");
                    Expression(parent, Field(Required(binding!, "field"), node)); return;
                case "visible": case "style": case "class": case null: break;
                default: throw Error($"{node.Where}: kind {kind} cannot bind <{node.Tag}>");
            }
            foreach (var child in node.Children) Widget(child, parent);
        }

        /// <summary>A repeating region: the element becomes a native List over the bound list and its single child element is the template.</summary>
        private void Repeater(HtmlNode node, string parent, JsonObject binding)
        {
            if (!Repeaters.Contains(node.Tag)) throw Error($"{node.Where}: kind list needs a <table> or a <div>/<ul>/<ol>/<section>, not <{node.Tag}>." + FragmentHint(FragmentList));
            var template = node.Elements.ToList();
            if (template.Count != 1) throw Error($"{node.Where}: a repeated element needs exactly one child element as the row template; found {template.Count}." + FragmentHint(FragmentList));
            foreach (var t in node.Children.Where(c => c.IsText && HtmlNode.CollapseSpaces(c.Text).Length > 0)) throw Error($"{t.Where}: text outside the template of a repeated element is not compiled." + FragmentHint(FragmentList));
            var scope = List(binding, node);
            var alias = Create(parent, "IList", NameFor(node)); Set(alias, "Source", scope.List);
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding);
            listScopes.Push(scope);
            Widget(template[0], alias);
            listScopes.Pop();
        }

        private ListScope List(JsonObject binding, HtmlNode node) => List(SourceFor(binding["source"]?.GetValue<string>(), node.Where), binding["output"]?.GetValue<string>(), node.Where);

        private SourceInfo SourceFor(string? sourceName, string where)
        {
            if (sources.Count == 0) throw Error($"{where}: needs a source");
            return sourceName == null
                ? (sources.Count == 1 ? sources[0] : throw Error($"{where}: name the source; declared: {string.Join(", ", sources.Select(s => s.As))}"))
                : sources.FirstOrDefault(s => s.As.Equals(sourceName, StringComparison.OrdinalIgnoreCase)) ?? throw Error($"{where}: unknown source '{sourceName}'; declared: {string.Join(", ", sources.Select(s => s.As))}");
        }

        private static ListScope List(SourceInfo source, string? output, string where)
        {
            if (output == null)
            {
                if (source.Lists.Count != 1) throw Error($"{where}: source {source.As} has {source.Lists.Count} lists; name the output ({string.Join(", ", source.Lists.Keys)})");
                output = source.Lists.Keys.First();
            }
            if (!source.Lists.TryGetValue(output, out var list)) throw Error($"{where}: {source.As} has no list output '{output}'; available: {string.Join(", ", source.Lists.Keys)}");
            return new ListScope(list.List, list.Current, list.Fields);
        }

        private void Input(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            var type = node.Attribute("type") ?? "text";
            if (type == "date") { Date(node, parent, binding, kind); return; }
            if (kind != "search") throw Error($"{node.Where}: an <input> must carry the search key or be type=\"date\" with a date binding; other inputs are not bound by this version");
            if (type is not ("text" or "search")) throw Error($"{node.Where}: input type {type} is not compiled; use text, search or date");
            var variable = binding!["variable"]!.ToString();
            var alias = Create(parent, "IInput", NameFor(node)); Set(alias, "Variable", variable);
            var label = binding["label"]?.GetValue<string>() ?? node.Attribute("placeholder");
            if (label != null) Set(alias, "Prompt", Quote(label));
            if (node.Attribute("maxlength") is { } max) Set(alias, "MaxLength", int.Parse(max));
            if (node.Attribute("required") != null) Set(alias, "Mandatory", "True");
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding);
            Set(alias + "/OnChange", "Destination", RefreshAction("SearchChanged", ConsumersOf(variable), resetPaging: true));
        }

        /// <summary>An input type=date becomes the OutSystems UI DatePicker bound to the declared variable; selecting a date assigns it
        /// and refreshes the sources, the way the Dashboard period filter behaves today.</summary>
        private void Date(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            if (kind != "date") throw Error($"{node.Where}: an <input type=\"date\"> needs a date binding (variable, format)");
            var variable = Required(binding!, "variable");
            if (!variables.TryGetValue(variable, out var variableType)) throw Error($"{node.Where}: date variable '{variable}' is not declared in vars");
            if (variableType is not ("Date" or "Date Time")) throw Error($"{node.Where}: date variable '{variable}' must be Date or Date Time, not {variableType}");
            var reference = Ref("IMobileBlock:DatePicker"); var contract = Contract(reference);
            var ev = contract.Events.FirstOrDefault(e => e.Name == "OnSelected") ?? throw Error("DatePicker signature has no OnSelected event");
            if (!contract.Placeholders.Any(p => p.Name == "Datepicker")) throw Error("DatePicker signature has no Datepicker placeholder");
            var widgetName = NameFor(node) ?? throw Error($"{node.Where}: a date input needs a data-av key");
            Variable("LastDatePickerId", "Text", "\"\"");
            var block = Create(parent, "IMobileBlockInstanceWidget", widgetName); ops[^1]["source"] = reference;
            Set(block + "/Datepicker/#IInput", "Variable", variable);
            if (binding["format"] is JsonValue format) Set(block + "/DateFormat", "Value", Quote(format.GetValue<string>()));
            if (node.Attribute("class") is { } cls && contract.Inputs.Any(i => i.Name == "ExtendedClass")) Set(block + "/ExtendedClass", "Value", Quote(HtmlNode.CollapseSpaces(cls)));
            foreach (var (attribute, _) in node.Attributes)
                if (attribute is not ("class" or "type" or "data-av" or "id")) throw Error($"{node.Where}: attribute '{attribute}' is not carried by a DatePicker; allowed: class, id, type, data-av");
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
            if (kind != "filter") throw Error($"{node.Where}: a <select> must carry a filter key; other selects are not bound by the page form." + FragmentHint(FragmentSelect));
            var binding = bindings[node.Attribute("data-av")!]; var from = binding["from"]!.ToString(); var variable = binding["variable"]!.ToString();
            var aggName = "Options_" + from; var agg = Create(Root, "IScreenAggregate", aggName);
            Add("create", ("parent", agg), ("type", "IAliasedSource"), ("args", new JsonObject { ["dataSource"] = Ref("IStaticEntity:" + from) }));
            var widgetName = NameFor(node)!;
            var alias = Create(parent, "IDropdown", widgetName); Set(alias, "List", aggName + ".List");
            Set(alias, "Values", from + ".Id"); Set(alias, "Labels", from + ".Label"); Set(alias, "Variable", variable);
            var empty = binding["label"]?.GetValue<string>() ?? node.Elements.FirstOrDefault(o => o.Tag == "option" && (o.Attribute("value") ?? "").Length == 0)?.InnerText() ?? "All";
            Set(alias, "EmptyValue", Quote(empty));
            foreach (var option in node.Elements) if (option.Tag != "option") throw Error($"{option.Where}: only <option> is allowed inside <select>");
            Attributes(node, alias, hasStyle: true, hasVisible: false, binding);
            Set(alias + "/OnChange", "Destination", RefreshAction(widgetName + "Changed", ConsumersOf(variable), resetPaging: true));
        }

        private void Clickable(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            var link = node.Tag == "a";
            if (kind is not ("navigate" or "call" or "refresh" or "page")) throw Error($"{node.Where}: a <{node.Tag}> needs a navigate, call, refresh or page binding; a dead control is not compiled");
            if (link && node.Attribute("href") is { } href && href != "#") throw Error($"{node.Where}: navigation comes from the binding; use href=\"#\" or omit it");
            var text = node.InnerText(); var rich = node.Elements.Any();
            if (text.Length == 0 && !rich) throw Error($"{node.Where}: a <{node.Tag}> needs visible content (text or child elements)");
            var widgetName = NameFor(node)!;
            var alias = Create(parent, link ? "ILink" : "IButton", widgetName);
            // Plain text stays the widget's own caption. Child elements (a card, an icon, bound spans, a visible div) are compiled
            // as real child widgets of the Link/Button: the default caption is removed so nothing is doubled or flattened.
            if (!rich) Set(alias + "/#ITextWidget", "Text", text);
            else Add("delete", ("target", alias + "/#ITextWidget"));
            Attributes(node, alias, hasStyle: true, hasVisible: true, binding);
            if (rich)
            {
                clickables.Push(node);
                foreach (var child in node.Children) Widget(child, alias);
                clickables.Pop();
            }
            var args = binding!["args"]?.AsObject() ?? new();
            switch (kind)
            {
                case "page":
                    var pageSource = SourceFor(Required(binding, "source"), node.Where);
                    if (!paging.TryGetValue(pageSource.As, out var page)) throw Error("page binding requires source.paging");
                    var direction = Required(binding, "direction");
                    if (direction is not ("next" or "previous")) throw Error("page.direction must be next or previous");
                    var condition = direction == "next" ? $"{page.Offset} + {page.Size} < {page.Total}" : page.Offset + " > 0";
                    Set(alias, "Enabled", pageSource.As + ".IsDataFetched and (" + condition + ")");
                    var pageAction = Create(Root, "IScreenAction", widgetName + "Handler"); var pageStart = Create(pageAction, "IStartNode");
                    var guard = Create(pageAction, "IIfNode"); Set(guard, "Condition", condition); Link(pageStart, guard);
                    var advance = Assign(pageAction, new Dictionary<string, string> { [page.Offset] = direction == "next" ? $"{page.Offset} + {page.Size}" : $"If({page.Offset} < {page.Size}, 0, {page.Offset} - {page.Size})" });
                    Add("link", ("from", guard), ("connector", "TrueTarget"), ("to", advance));
                    var reload = Create(pageAction, "IRefreshDataNode", "Refresh" + pageSource.As); Set(reload, "DataSource", pageSource.Alias); Link(advance, reload);
                    var pageEnd = Create(pageAction, "IEndNode"); Link(reload, pageEnd); Add("link", ("from", guard), ("connector", "FalseTarget"), ("to", pageEnd));
                    Set(alias + "/OnClick", "Destination", pageAction); Add("layout", ("target", pageAction));
                    break;
                case "navigate":
                    var destination = Required(binding, "destination"); var reference = Ref("IMobileScreen:" + destination);
                    CheckArgs(Contract(reference).Inputs, args); Set(alias + "/OnClick", "Destination", reference);
                    foreach (var arg in args) Set(alias + "/OnClick/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                    break;
                case "call":
                    var callName = Required(binding, "action"); var action = Ref("IServerAction:" + callName, "IServiceAction:" + callName, "IClientAction:" + callName);
                    CheckArgs(Contract(action).Inputs, args);
                    var handler = Create(Root, "IScreenAction", widgetName + "Handler"); var start = Create(handler, "IStartNode");
                    var call = Create(handler, action.Contains("ClientAction", StringComparison.Ordinal) ? "IExecuteClientActionNode" : "IExecuteServerActionNode", callName); Set(call, "Action", action);
                    foreach (var arg in args) Set(call + "/" + arg.Key, "Value", arg.Value!.GetValue<string>());
                    var tail = call; Link(start, call);
                    foreach (var source in sources) { var refresh = Create(handler, "IRefreshDataNode", "Refresh" + source.As); Set(refresh, "DataSource", source.Alias); Link(tail, refresh); tail = refresh; }
                    var end = Create(handler, "IEndNode"); Link(tail, end); Add("layout", ("target", handler));
                    Set(alias + "/OnClick", "Destination", handler);
                    break;
                case "refresh":
                    var only = binding["sources"] is JsonArray subset ? subset.Select(s => s!.GetValue<string>()).ToList() : null;
                    Set(alias + "/OnClick", "Destination", RefreshAction(widgetName + "Handler", only));
                    break;
            }
        }

        private void Label(HtmlNode node, string parent)
        {
            if (node.Attribute("data-av") != null) throw Error($"{node.Where}: labels are not bound; bind the control they describe");
            // A label is compiled to its text: a bound element inside it would lose its binding without a trace.
            if (node.Descendants().FirstOrDefault(d => !d.IsText && d.Attribute("data-av") != null) is { } bound)
                throw Error($"{bound.Where}: data-av \"{bound.Attribute("data-av")}\" inside a <label> is not compiled (a label carries only its text); move the bound element out of the <label>");
            var text = node.InnerText(); if (text.Length == 0) throw Error($"{node.Where}: a <label> needs text");
            var alias = Create(parent, "ILabel"); Set(alias + "/#ITextWidget", "Text", text);
            Attributes(node, alias, hasStyle: true, hasVisible: false, null);
            if (node.Attribute("for") is { } target) labels.Add((alias, target, node));
        }

        private void Table(HtmlNode node, string parent, JsonObject? binding, string? kind)
        {
            if (kind != "list") throw Error($"{node.Where}: a <table> must be bound with kind list; static tables are not compiled by this version");
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
            foreach (var cell in bodyCells)
            {
                var c = Create(alias + "/Row", "IRowCell"); var cellBinding = BindingOf(cell); Attributes(cell, c, hasStyle: true, hasVisible: false, cellBinding);
                Inner(cell, c, cellBinding, cellBinding?["kind"]?.ToString());
            }
            listScopes.Pop();
        }

        /// <summary>Carries the authored attributes: class to the native Style when the widget has one, else to an extended property;
        /// hidden to Visible when the widget has one; everything else in the closed attribute list to extended properties. Bindings
        /// of kind class/style/visible replace the static attribute with an expression.</summary>
        private void Attributes(HtmlNode node, string alias, bool hasStyle, bool hasVisible, JsonObject? binding, string styleProperty = "Style")
        {
            var kind = binding?["kind"]?.ToString();
            var dynamicClass = kind == "class" ? Required(binding!, "value") : null;
            var dynamicStyle = kind == "style" ? Required(binding!, "value") : null;
            var staticClass = node.Attribute("class") is { } c ? HtmlNode.CollapseSpaces(c) : null;
            if (dynamicClass != null || staticClass != null)
            {
                var value = dynamicClass == null ? Quote(staticClass!) : staticClass == null ? dynamicClass : Quote(staticClass + " ") + " + " + dynamicClass;
                if (hasStyle) Set(alias, styleProperty, value); else Extended(alias, "class", value);
            }
            if (dynamicStyle != null || node.Attribute("style") != null)
            {
                var inline = node.Attribute("style"); var value = dynamicStyle == null ? Quote(inline!) : inline == null ? dynamicStyle : Quote(inline.TrimEnd(';') + "; ") + " + " + dynamicStyle;
                // The O11 React renderer camel-cases inline property names, including --custom properties.
                // Reject that unsupported form instead of silently publishing a different style.
                try { CssStylesheet.RequireRenderableInline(value); }
                catch(InvalidOperationException ex) { throw Error($"{node.Where}: {ex.Message}"); }
                Extended(alias, "style", value);
            }
            foreach (var (attribute, value) in node.Attributes)
            {
                if (attribute is "data-av" or "class" or "style") continue;
                if (attribute.StartsWith("aria-", StringComparison.Ordinal) || attribute.StartsWith("data-", StringComparison.Ordinal)) { Extended(alias, attribute, Quote(value)); continue; }
                if (!AllowedAttributes.Contains(attribute)) throw Error($"{node.Where}: attribute '{attribute}' is not compiled; allowed: {string.Join(", ", AllowedAttributes.Order())}, aria-*, data-*");
                switch (attribute)
                {
                    case "hidden":
                        if (kind == "visible") break; // the binding decides visibility
                        if (hasVisible) Set(alias, "Visible", "False"); else Extended(alias, "hidden", Quote("hidden"));
                        break;
                    case "placeholder": if (node.Tag != "input") Extended(alias, attribute, Quote(value)); break;
                    case "for": if (node.Tag != "label") Extended(alias, attribute, Quote(value)); break;
                    case "type": if (node.Tag is not ("input" or "button")) Extended(alias, attribute, Quote(value)); break;
                    case "href": if (node.Tag != "a") Extended(alias, attribute, Quote(value)); break;
                    case "required": case "maxlength": if (node.Tag != "input") Extended(alias, attribute, Quote(value)); break;
                    case "value": if (node.Tag != "option") Extended(alias, attribute, Quote(value)); break;
                    case "id": idAliases[value] = alias; break; // reserved by OutSystems (InvalidHTMLAttribute_Id): an authored id only targets labels, natively
                    default: Extended(alias, attribute, Quote(value)); break;
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
            var found = scope.Fields.FirstOrDefault(f => f.Name.Equals(field, StringComparison.OrdinalIgnoreCase))
                ?? throw Error($"{node.Where}: field '{field}' does not exist in the row; available: {string.Join(", ", scope.Fields.Select(f => f.Name))}");
            return scope.Current + "." + found.Name;
        }
        private string? NameFor(HtmlNode node)
        {
            if (node.Attribute("data-av") is not { } key) return null;
            var sb = new StringBuilder(); var upper = true;
            foreach (var ch in key) { if (char.IsLetterOrDigit(ch)) { sb.Append(upper ? char.ToUpperInvariant(ch) : ch); upper = false; } else upper = true; }
            var widgetName = sb.ToString();
            if (widgetName.Length == 0 || !char.IsLetter(widgetName[0])) throw Error($"{node.Where}: key \"{key}\" does not yield a valid name");
            if (!widgetNames.Add(widgetName)) throw Error($"{node.Where}: key \"{key}\" yields the name {widgetName}, already used by another key");
            return widgetName;
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
        private void Where(string alias, string text) => Add("create", ("parent", alias), ("type", "IFilter"), ("args", new JsonObject { ["condition"] = text }));
        private string Assign(string action, IReadOnlyDictionary<string, string> values)
        {
            var assign = Create(action, "IAssignNode"); Set(assign, "Label", "SetValues");
            foreach (var pair in values) { var item = Create(assign, "IAssignment"); Set(item, "Variable", pair.Key); Set(item, "Value", pair.Value); }
            return assign;
        }
        private void Link(string from, string to) => Add("link", ("from", from), ("to", to));
        private static void CheckArgs(IReadOnlyList<UiParam> inputs, JsonObject args)
        {
            foreach (var arg in args)
                if (!inputs.Any(p => p.Name.Equals(arg.Key, StringComparison.OrdinalIgnoreCase))) throw Error($"unknown argument '{arg.Key}'; available: {string.Join(", ", inputs.Select(p => p.Name))}");
            foreach (var input in inputs.Where(p => p.Mandatory && string.IsNullOrEmpty(p.Default)))
                if (!args.Any(p => p.Key.Equals(input.Name, StringComparison.OrdinalIgnoreCase))) throw Error($"missing required argument '{input.Name}'");
        }
        private static string Sha(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    }

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
