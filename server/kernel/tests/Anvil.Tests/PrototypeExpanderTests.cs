using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The seams of the other lanes as fakes, inside this lane's tests (docs/PROTOTIPO-NATIVO.md 7.3): the element map of the html lane
/// (the table of 3.2, the tag lists of 0.1, the substitutions and the submit rule), the stylesheet of the css lane (the sheets of
/// the bundle, verbatim, in order) and the read-back (PrototypeBuilder.ReadBack instead of the runtime DOM renderer). Plus the
/// readers the tests share: the ops, logic actions and widgets of a plan, and the nodes of a capture by key.
/// </summary>
public static class PrototypeFakes
{
    public static readonly HashSet<string> O11Tags = new(("a abbr address area article aside audio b bdi bdo blockquote button canvas caption cite code col colgroup command data datalist dd del details dfn div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins kbd keygen label legend li link main map mark menu meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp section select small source span strong style sub summary sup table tbody td textarea tfoot th thead time tr track u ul var video wbr").Split(' '), StringComparer.Ordinal);
    public static readonly HashSet<string> OdcTags = new(O11Tags.Where(t => t is not ("data" or "main" or "picture")), StringComparer.Ordinal);
    private static readonly Dictionary<string, string> InputTypes = new(StringComparer.OrdinalIgnoreCase)
    { ["text"] = "Text", ["search"] = "Search", ["email"] = "Email", ["number"] = "Number", ["tel"] = "Phone", ["password"] = "Password", ["date"] = "Date", ["time"] = "Time", ["datetime-local"] = "Datetime" };

    public static PrototypeExpander.Seams Seams => new(Element, Css, PrototypeBuilder.ReadBack);

    public static int ElementCalls;

    public static ElementMapping Element(ElementRequest r)
    {
        Interlocked.Increment(ref ElementCalls);
        string? Attr(string name) => r.Attributes.FirstOrDefault(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase)).Value;
        var classes = (Attr("class") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var id = Attr("id");
        var name = id is { Length: > 0 } ? PrototypeNames.WidgetName(id) : null;
        var consumed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "class", "id" };
        var props = new List<(string, string)>();
        var tags = r.Platform == "odc" ? OdcTags : O11Tags;
        string widget; string? tag = null; string? substituted = null;
        if (r.Icon) { widget = "IAdvancedHtml"; tag = "span"; }
        else
        {
            var t = r.Tag;
            switch (t)
            {
                case "button":
                    widget = "IButton"; consumed.Add("type"); consumed.Add("disabled");
                    if (Attr("disabled") != null) props.Add(("Enabled", "False"));
                    if (Attr("type") == "submit") { props.Add(("IsDefault", "True")); classes.Add("ssam-submit"); }
                    break;
                case "a":
                    widget = "ILink";
                    if (Attr("href") is { } href && href.StartsWith('#')) consumed.Add("href");
                    break;
                case "form": widget = "IForm"; break;
                case "input" when Attr("type") == "checkbox": widget = "ICheckbox"; consumed.UnionWith(["type", "checked", "value"]); break;
                case "input" when Attr("type") == "radio": widget = "IRadioGroup"; consumed.UnionWith(["type", "checked", "value"]); break;
                case "input":
                    widget = "IInput"; consumed.UnionWith(["type", "value", "placeholder", "maxlength", "required"]);
                    props.Add(("InputType", InputTypes.GetValueOrDefault(Attr("type") ?? "text") ?? "Text"));
                    if (Attr("placeholder") is { } ph) props.Add(("Prompt", PrototypeExpr.Quote(ph)));
                    if (Attr("maxlength") is { } ml) props.Add(("MaxLength", ml));
                    if (Attr("required") != null) props.Add(("Mandatory", "True"));
                    break;
                case "textarea":
                    widget = "ITextArea"; consumed.UnionWith(["placeholder", "maxlength", "required", "value"]);
                    if (Attr("placeholder") is { } tph) props.Add(("Prompt", PrototypeExpr.Quote(tph)));
                    if (Attr("maxlength") is { } tml) props.Add(("MaxLength", tml));
                    if (Attr("required") != null) props.Add(("Mandatory", "True"));
                    break;
                case "select": widget = "IDropdown"; consumed.UnionWith(["required", "value"]); break;
                case "label" when !r.HasElementChildren && Attr("for") != null: widget = "ILabel"; consumed.Add("for"); break;
                case "img": widget = "IImage"; consumed.Add("src"); break;
                case "div" when !r.Clickable: widget = "IContainer"; break;
                default:
                    if (!tags.Contains(t))
                    {
                        substituted = t;
                        tag = t is "data" or "picture" ? "span" : "div";
                        classes.Add(PrototypeNames.TagClass(t));
                        widget = tag == "div" && !r.Clickable ? "IContainer" : "IAdvancedHtml";
                    }
                    else { widget = "IAdvancedHtml"; tag = t; }
                    break;
            }
        }
        // like the real map (ElementWidgetMap), an extended value is what a set op writes: the quoted literal
        var extended = r.Attributes.Where(a => !consumed.Contains(a.Name) && !a.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase)).Select(a => (a.Name, PrototypeExpr.Quote(a.Value))).ToList();
        if (substituted == "main") extended.Add(("role", PrototypeExpr.Quote("main")));
        return new ElementMapping(widget, tag, name, props, extended, classes, substituted, null);
    }

    /// <summary>The attributes the fake map consumes into native properties (3.3); every other attribute is an extended property.</summary>
    public static readonly HashSet<string> Consumed = new(StringComparer.OrdinalIgnoreCase) { "class", "id", "type", "disabled", "value", "checked", "placeholder", "maxlength", "required", "for", "src", "selected" };

    public static int CssCalls;

    public static PrototypeCssResult Css(PrototypeCssRequest request)
    {
        Interlocked.Increment(ref CssCalls);
        var sheets = (request.Capture["css"]?["sheets"] as JsonArray ?? []).OfType<JsonObject>().OrderBy(s => s["order"]?.GetValue<int>() ?? 0);
        var text = string.Join("\n", sheets.Select(s => File.ReadAllText(Path.Combine(request.BundleRoot, s["bundle"]!.ToString()))));
        return new PrototypeCssResult(text, new Dictionary<string, string>(), new JsonObject { ["fake"] = true, ["roots"] = request.Roots.Count, ["substitutedTags"] = new JsonArray(request.SubstitutedTags.Select(t => (JsonNode)t).ToArray()) });
    }

    /// <summary>The Studio assemblies bound (the seams' contract names Model API types); false without a Service Studio.</summary>
    public static bool Studio()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    public static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PrototypeFakes).Assembly.Location)!)!;
    public static string Fixtures => Path.Combine(Root, "tests", "Anvil.Tests", "Fixtures", "prototype");
    public static string FarmaVirtual => Path.Combine(Fixtures, "farmavirtual.capture.json");
    public static string Minimal => Path.Combine(Fixtures, "minimal.capture.json");

    public static JsonObject Data(string capture, string? sha = null, JsonObject? extra = null)
    {
        var data = new JsonObject { ["source"] = "C:\\fixture\\" + Path.GetFileName(capture).Split('.')[0], ["capture"] = capture };
        if (sha != null) data["captureSha256"] = sha;
        foreach (var (k, v) in extra ?? []) data[k] = v?.DeepClone();
        return data;
    }

    public static PrototypeCapture Load(string capture, JsonObject? extra = null)
    {
        var problems = new List<PrototypeCapture.Problem>();
        var c = PrototypeCapture.Load(Data(capture, null, extra), problems);
        Assert.True(problems.Count == 0, string.Join("\n", problems.Select(p => p.Message)));
        return c!;
    }

    public static (PrototypePlan Plan, PrototypeCapture Capture) Plan(string capture, string platform = "o11", PrototypeModule? module = null, JsonObject? extra = null, PrototypeExpander.Seams? seams = null)
    {
        var c = Load(capture, extra);
        var plan = PrototypeExpander.Plan(c, module ?? PrototypeModule.Empty(platform, "Haiku_UI"), seams ?? Seams);
        return (plan, c);
    }

    public static IEnumerable<JsonObject> Ops(PrototypePlan plan) => plan.Steps.SelectMany(s => s.Ops ?? []);

    /// <summary>The actions of the logic ops of a plan (kind "server" or "screen").</summary>
    public static IEnumerable<JsonObject> Actions(PrototypePlan plan, string? kind = null)
        => Ops(plan).Where(o => o["op"]?.ToString() == "logic").SelectMany(o => o["data"]!["actions"]!.AsArray().OfType<JsonObject>())
            .Where(a => kind == null || a["kind"]?.ToString() == kind);

    /// <summary>Every step of a logic action, nested ones included (then, else, switch cases, otherwise).</summary>
    public static IEnumerable<JsonObject> Steps(JsonNode? steps)
    {
        foreach (var step in steps as JsonArray ?? [])
        {
            if (step is not JsonObject s) continue;
            yield return s;
            foreach (var key in new[] { "then", "else", "otherwise", "steps" })
                foreach (var inner in Steps(s[key])) yield return inner;
            foreach (var c in s["switch"] as JsonArray ?? [])
                foreach (var inner in Steps(c?["steps"])) yield return inner;
        }
    }

    /// <summary>The steps of an action and of its exception handlers.</summary>
    public static IEnumerable<JsonObject> AllSteps(JsonObject action)
        => Steps(action["steps"]).Concat((action["handlers"] as JsonArray ?? []).OfType<JsonObject>().SelectMany(h => Steps(h["steps"])));

    /// <summary>Every widget of the plan with its spec and owner, depth first (children, then the else branch).</summary>
    public static IEnumerable<(WidgetNode Node, PrototypeWidgetSpec Spec, string Owner)> Widgets(PrototypePlan plan)
    {
        foreach (var job in plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>())
        {
            var stack = new Stack<WidgetNode>(job.Roots.Reverse());
            while (stack.Count > 0)
            {
                var n = stack.Pop();
                yield return (n, job.Specs.GetValueOrDefault(n) ?? new PrototypeWidgetSpec(), job.OwnerName);
                foreach (var c in (n.Else ?? []).Reverse()) stack.Push(c);
                foreach (var c in n.Children.Reverse()) stack.Push(c);
            }
        }
    }

    public static string? Prop(PrototypeWidgetSpec spec, string name) => spec.Properties.LastOrDefault(p => p.Property == name).Value;
    public static string? Ext(PrototypeWidgetSpec spec, string name) => spec.Extended.LastOrDefault(p => p.Name == name).Value;
    public static string Classes(WidgetNode node, PrototypeWidgetSpec spec) => (node.Style ?? "") + " " + (Prop(spec, "Style") ?? "");

    /// <summary>The element nodes of a capture by key: views, modals, the shell, its regions after the mount, list templates
    /// and else branches.</summary>
    public static Dictionary<string, JsonObject> Nodes(PrototypeCapture capture)
    {
        var all = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        void Walk(JsonNode? n)
        {
            if (n is not JsonObject o) return;
            if (o["k"]?.ToString() is { } k && o["t"] != null) all[k] = o;
            foreach (var c in o["c"] as JsonArray ?? []) Walk(c);
            foreach (var c in o["else"] as JsonArray ?? []) Walk(c);
            Walk(o["list"]?["template"]);
            Walk(o["toast"]?["template"]);
        }
        foreach (var v in capture.Views) Walk(v["root"]);
        foreach (var m in capture.Modals) Walk(m["root"]);
        if (capture.Shell != null) { Walk(capture.Shell["root"]); foreach (var a in capture.Shell["after"] as JsonArray ?? []) Walk(a); }
        return all;
    }

    public static JsonObject Canonical(PrototypePlan plan, string? owner = null)
        => new() { ["jobs"] = new JsonArray(plan.Steps.Select(s => s.Widgets).OfType<PrototypeWidgetsJob>().Where(j => owner == null || j.OwnerName == owner).Select(j => (JsonNode)PrototypeExpander.Canonical(j)).ToArray()) };

    public static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
}

/// <summary>
/// The compile lane's planner (docs/PROTOTIPO-NATIVO.md 7.2, tests 1-6 and the expansion half of 8): the capture becomes ops in the
/// documented order, names and marks, widget trees from the shared element map, logic from the effects of 3.4 and data from the
/// store. No module is touched here (PrototypeBuilderTests applies the plans headless).
/// </summary>
public class PrototypeExpanderTests(ITestOutputHelper output)
{
    private static string Golden => Path.Combine(PrototypeFakes.Fixtures, "minimal.golden.json");

    // ---- 1. the minimal capture: order, names, marks, golden widgets ----------------------------------------------------------

    [Fact]
    public void TheMinimalCaptureIsPlannedInTheDocumentedOrderWithNamesMarksAndTheGoldenWidgets()
    {
        if (!PrototypeFakes.Studio()) return;
        MinimalOrderNamesMarksGolden();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void MinimalOrderNamesMarksGolden()
    {
        var (plan, capture) = PrototypeFakes.Plan(PrototypeFakes.Minimal);
        Assert.Empty(plan.Problems);
        // the order of 7.2: images, spec, theme (+ its stylesheet), flow, client variables, server actions, blocks and screens,
        // per owner the content, the screen actions, the widgets, the render after everything
        var phases = plan.Steps.Select(s => s.Phase).ToList();
        Assert.Equal(new[] { "images", "spec", "theme", "theme", "flow", "clientVariables", "logic:server", "ui", "ui", "ui", "block", "screen", "screen",
            "logic:ui", "wiring", "widgets", "widgets", "widgets", "wiring", "flow", "render" }, phases);
        Assert.Equal("stylesheet", plan.Steps[3].Special);
        Assert.Equal("render", plan.Steps[^1].Special);
        Assert.Equal(["MiniShell", "Lista", "TarefaDetalhe"], plan.Steps.Where(s => s.Widgets != null).Select(s => s.Widgets!.OwnerName));
        // names (3.5): prefix where the name is global, the view names for screens, the asset file for images
        Assert.Equal("Mini", plan.FlowName);
        Assert.Equal("MiniTheme", plan.ThemeName);
        Assert.Equal("MiniShell", plan.ShellName);
        Assert.Equal("Lista", plan.Screens["lista"]);
        Assert.Equal("TarefaDetalhe", plan.Screens["tarefa"]);
        var creates = PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() is "@espace" or "$p.flow").ToDictionary(o => o["name"]!.ToString(), o => o["type"]!.ToString());
        Assert.Equal("IImage", creates["MiniLogo"]);
        Assert.Equal("IStaticEntity", creates["Categoria"]); // the singular of the collection, no prefix without a collision
        Assert.Equal("IServerEntity", creates["Tarefa"]);
        Assert.Equal("IClientVariable", creates["MiniConta"]);
        Assert.Equal("IMobileTheme", creates["MiniTheme"]);
        Assert.Equal("IMobileFlow", creates["Mini"]);
        Assert.Equal("IMobileBlock", creates["MiniShell"]);
        Assert.Equal("IMobileScreen", creates["Lista"]);
        Assert.Equal("IUserException", creates["MiniValidacao"]);
        Assert.Equal(["AlternarTarefaFeita", "CriarTarefa", "RemoverTarefa"], PrototypeFakes.Actions(plan, "server").Select(a => a["name"]!.ToString()).Order(StringComparer.Ordinal));
        // marks (1.6): the Description of everything that has one ends with the mark, no hash in it
        var mark = PrototypeNames.Mark("Mini");
        var aliases = PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() is "IImage" or "IStaticEntity" or "IServerEntity" or "IClientVariable" or "IMobileTheme" or "IMobileBlock" or "IMobileScreen")
            .Select(o => o["as"]!.ToString()).ToList();
        var descriptions = PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Description").ToDictionary(o => o["target"]!.ToString(), o => o["value"]!.ToString());
        foreach (var alias in aliases) Assert.True(descriptions.TryGetValue(alias, out var d) && d.EndsWith(mark, StringComparison.Ordinal), $"{alias} has no mark: {descriptions.GetValueOrDefault(alias)}");
        foreach (var action in PrototypeFakes.Actions(plan, "server")) Assert.EndsWith(mark, action["description"]!.ToString());
        // a Description on every attribute of the model and on every action (server and screen) the importation creates
        var attributes = PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IEntityAttribute").Select(o => o["as"]!.ToString()).ToList();
        Assert.NotEmpty(attributes);
        foreach (var attribute in attributes) Assert.False(string.IsNullOrWhiteSpace(descriptions.GetValueOrDefault(attribute)), $"{attribute} has no Description");
        Assert.NotEmpty(PrototypeFakes.Actions(plan, "screen"));
        foreach (var action in PrototypeFakes.Actions(plan)) Assert.False(string.IsNullOrWhiteSpace(action["description"]?.ToString()), $"{action["name"]} has no Description");
        Assert.DoesNotContain(capture.Sha256, string.Join("\n", descriptions.Values));
        var flowDescription = plan.Steps.Single(s => s.Special == "flow-description").Arguments!["description"]!.ToString();
        Assert.Contains("capture " + capture.Sha256, flowDescription);
        Assert.EndsWith(mark, flowDescription);
        // the widget trees equal the golden (regenerate with SSAM_PROTOTYPE_GOLDEN=1 after an intended change, and review the diff)
        var actual = PrototypeFakes.Canonical(plan).ToJsonString(PrototypeFakes.Indented).Replace("\r\n", "\n");
        if (Environment.GetEnvironmentVariable("SSAM_PROTOTYPE_GOLDEN") == "1") File.WriteAllText(Golden, actual + "\n");
        var expected = File.ReadAllText(Golden).Replace("\r\n", "\n").TrimEnd('\n');
        if (expected != actual)
        {
            var path = Path.Combine(Path.GetTempPath(), "minimal.actual.json");
            File.WriteAllText(path, actual);
            var e = expected.Split('\n'); var a = actual.Split('\n');
            var line = Enumerable.Range(0, Math.Min(e.Length, a.Length)).FirstOrDefault(i => e[i] != a[i], Math.Min(e.Length, a.Length));
            Assert.Fail($"the widgets differ from {Golden} at line {line + 1}: expected '{(line < e.Length ? e[line] : "<end>")}', got '{(line < a.Length ? a[line] : "<end>")}' (actual in {path})");
        }
    }

    // ---- 2. the element map decides each widget ------------------------------------------------------------------------------

    [Fact]
    public void EachElementMappingBecomesTheWidgetWithItsPropertiesClassesAndName()
    {
        if (!PrototypeFakes.Studio()) return;
        ElementMappingFidelity();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ElementMappingFidelity()
    {
        var (plan, capture) = PrototypeFakes.Plan(PrototypeFakes.Minimal);
        var widgets = PrototypeFakes.Widgets(plan).Where(w => w.Node.K != null && w.Node.W is not ("IPopup" or "IIfWidget")).GroupBy(w => w.Node.K!).ToDictionary(g => g.Key, g => g.First());
        // every element of the capture is a widget (option children are the dropdown's list; the root of a view is the shell's
        // mount element, its children fill the placeholder)
        var roots = capture.Views.Select(v => v["root"]!["k"]!.ToString()).ToHashSet();
        var lost = PrototypeFakes.Nodes(capture).Where(n => n.Value["t"]!.ToString() != "option" && !roots.Contains(n.Key) && !widgets.ContainsKey(n.Key)).Select(n => n.Key).ToList();
        Assert.True(lost.Count == 0, "elements without a widget: " + string.Join(", ", lost));
        var search = widgets["v:lista/0/2/1"];
        Assert.Equal("IInput", search.Node.W);
        // the local Busca (the dimension) holds the name in the screen: the Studio would rename the widget, so the plan does (busca2)
        Assert.Equal("busca2", search.Spec.Name);
        Assert.Equal("Search", PrototypeFakes.Prop(search.Spec, "InputType"));
        Assert.Equal("\"Buscar tarefa\"", PrototypeFakes.Prop(search.Spec, "Prompt"));
        Assert.Equal("60", PrototypeFakes.Prop(search.Spec, "MaxLength"));
        Assert.Equal("Busca", PrototypeFakes.Prop(search.Spec, "Variable"));
        Assert.Equal("\"off\"", PrototypeFakes.Ext(search.Spec, "autocomplete"));
        Assert.Null(PrototypeFakes.Ext(search.Spec, "id"));
        // a tag outside the platform's list: the substitute of the table with ssam-tag-<tag>
        var wrapper = widgets["v:lista/0/2"];
        Assert.Equal("IContainer", wrapper.Node.W);
        Assert.Contains("ssam-tag-search", PrototypeFakes.Classes(wrapper.Node, wrapper.Spec));
        Assert.Contains("search", plan.SubstitutedTags);
        var dialog = widgets["m:nova-tarefa"];
        Assert.Contains("ssam-tag-dialog", PrototypeFakes.Classes(dialog.Node, dialog.Spec));
        Assert.Equal("\"open\"", PrototypeFakes.Ext(dialog.Spec, "open")); // a boolean attribute by its own name (the runtime drops an empty one)
        // the submit button: never type=submit; IsDefault, ssam-submit and the form's submit action on OnClick
        var submit = widgets["m:nova-tarefa/1/3/1"];
        Assert.Equal("IButton", submit.Node.W);
        Assert.Equal("True", PrototypeFakes.Prop(submit.Spec, "IsDefault"));
        Assert.Contains("ssam-submit", PrototypeFakes.Classes(submit.Node, submit.Spec));
        Assert.DoesNotContain(submit.Spec.Extended, e => e.Name == "type");
        Assert.Equal(("OnClick", "CriarTarefa"), (submit.Spec.Handler!.Event, submit.Spec.Handler.Action));
        var cancel = widgets["m:nova-tarefa/1/3/0"];
        Assert.Null(PrototypeFakes.Prop(cancel.Spec, "IsDefault"));
        Assert.Equal("FecharNovaTarefa", cancel.Spec.Handler!.Action);
        // label for -> ILabel with the target widget; icon -> span with the icon classes; img -> the module image
        var label = widgets["v:lista/0/2/0"];
        Assert.Equal("ILabel", label.Node.W);
        Assert.Equal("busca2", label.Spec.TargetWidget);
        var icon = widgets["v:lista/0/3/0"];
        Assert.Equal(("IAdvancedHtml", "span"), (icon.Node.W, icon.Node.Tag));
        foreach (var cls in new[] { "icon", "lucide", "lucide-plus", "ssam-icon", "ssam-icon-plus-w300" }) Assert.Contains(cls, PrototypeFakes.Classes(icon.Node, icon.Spec).Split(' ', '"'));
        Assert.Equal("\"true\"", PrototypeFakes.Ext(icon.Spec, "aria-hidden"));
        var image = widgets["s:app/0/0"];
        Assert.Equal("IImage", image.Node.W);
        Assert.Equal("Static", PrototypeFakes.Prop(image.Spec, "Type"));
        Assert.Equal("MiniLogo", PrototypeFakes.Prop(image.Spec, "Image"));
        Assert.Equal("\"Mini\"", PrototypeFakes.Ext(image.Spec, "alt"));
        // list -> IList Custom over the aggregate, the tag and class of the element, virtualization off
        var list = widgets["v:lista/0/4"];
        Assert.Equal(("IList", "ul"), (list.Node.W, list.Node.Tag));
        Assert.Equal("Tarefas.List", PrototypeFakes.Prop(list.Spec, "Source"));
        Assert.Equal("Custom", PrototypeFakes.Prop(list.Spec, "Mode"));
        Assert.Equal("True", PrototypeFakes.Ext(list.Spec, "disable-virtualization"));
        Assert.Contains("tarefas", PrototypeFakes.Classes(list.Node, list.Spec));
        // if -> IIfWidget with the else branch (never Visible); expr -> IExpression; class by predicate
        var when = PrototypeFakes.Widgets(plan).Single(w => w.Node.W == "IIfWidget" && w.Node.Else is { Count: > 0 } && w.Node.Else[0].K == "v:lista:else:pendente");
        Assert.Contains("Feita", PrototypeFakes.Prop(when.Spec, "Condition"));
        var title = PrototypeFakes.Widgets(plan).Single(w => w.Node.W == "IExpression" && w.Node.K == "v:lista:template:item/0/0");
        Assert.Equal("Tarefas.List.Current.Tarefa.Titulo", PrototypeFakes.Prop(title.Spec, "Value"));
        var item = widgets["v:lista:template:item"];
        Assert.Contains("If(Tarefas.List.Current.Tarefa.Feita, \" done\", \"\")", PrototypeFakes.Prop(item.Spec, "Style"));
        // a route link navigates to its screen with the parameter of the row
        var open = widgets["v:lista:template:item/4"];
        Assert.Equal("TarefaDetalhe", open.Spec.Handler!.Screen);
        Assert.Contains(open.Spec.Handler.Arguments, a => a.Argument == "Id" && a.Value.Contains("Tarefas.List.Current.Tarefa.Id"));
        // a control of the popup is bound to the record; the dropdown options come from the options aggregate (bare attributes)
        var category = widgets["m:nova-tarefa/1/2/1"];
        Assert.Equal("IDropdown", category.Node.W);
        Assert.EndsWith(".CategoriaId", PrototypeFakes.Prop(category.Spec, "Variable"));
        Assert.DoesNotContain("List.Current", PrototypeFakes.Prop(category.Spec, "Values")!);
        Assert.DoesNotContain("List.Current", PrototypeFakes.Prop(category.Spec, "Labels")!);
    }

    // ---- 3. every attribute is kept: native property or extended property; id -> Name; aria references -----------------------

    [Fact]
    public void EveryAttributeOfTheCaptureIsANativeOrExtendedPropertyAndIdsAreNames()
    {
        if (!PrototypeFakes.Studio()) return;
        Attributes(PrototypeFakes.Minimal);
        Attributes(PrototypeFakes.FarmaVirtual);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Attributes(string fixture)
    {
        var (plan, capture) = PrototypeFakes.Plan(fixture);
        var nodes = PrototypeFakes.Nodes(capture);
        var missing = new List<string>();
        // the names an id got in each owner (two popups of a screen may both have #modal-title: each tree resolves its own)
        var ids = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var (node, spec, owner) in PrototypeFakes.Widgets(plan))
        {
            if (node.K == null || node.W is "IPopup" or "IIfWidget" || node.Role == "wrapper" || !nodes.TryGetValue(node.K, out var source) || source["icon"] != null) continue;
            var dynamic = source["attrExpr"] as JsonObject;
            foreach (var pair in source["a"] as JsonArray ?? [])
            {
                var name = pair![0]!.ToString();
                if (PrototypeFakes.Consumed.Contains(name) || name.StartsWith("on", StringComparison.OrdinalIgnoreCase)) continue;
                if (name == "href" && pair[1]!.ToString().StartsWith('#')) continue;
                if (spec.Extended.Any(e => e.Name == name) || dynamic?.ContainsKey(name) == true) continue;
                missing.Add($"{node.K} ({node.W}) {name}");
            }
            if (Attr(source, "id") is { Length: > 0 } id)
            {
                Assert.True(spec.Name != null && spec.Name.StartsWith(PrototypeNames.WidgetName(id), StringComparison.Ordinal), $"{node.K}: id {id} gave the name {spec.Name}");
                Assert.DoesNotContain(spec.Extended, e => e.Name == "id");
                if (!ids.TryGetValue(owner + "#" + id, out var names)) ids[owner + "#" + id] = names = new HashSet<string>(StringComparer.Ordinal);
                names.Add(spec.Name!);
            }
        }
        Assert.True(missing.Count == 0, "attributes lost: " + string.Join("; ", missing.Take(20)));
        // id references point at the runtime id (the widget name) of the target in the same tree
        var resolved = 0;
        foreach (var (node, spec, owner) in PrototypeFakes.Widgets(plan))
            foreach (var (name, value) in spec.Extended.Where(e => e.Name is "aria-labelledby" or "aria-describedby" or "aria-controls"))
            {
                var original = Attr(nodes[node.K!], name)!;
                if (ids.TryGetValue(owner + "#" + original, out var targets)) { Assert.Contains(value.Trim('"'), targets); resolved++; }
            }
        if (fixture == PrototypeFakes.Minimal) Assert.True(resolved >= 2, "the aria references of the minimal capture resolve to widget names");
    }

    private static string? Attr(JsonObject node, string name)
        => (node["a"] as JsonArray ?? []).OfType<JsonArray>().FirstOrDefault(p => p[0]?.ToString() == name)?[1]?.ToString();

    // ---- 4. effects -> the nodes of the table of 3.4 -------------------------------------------------------------------------

    [Fact]
    public void EachEffectCompilesToTheNodesOfItsTableWithoutJsJsonVisibleOrForEach()
    {
        if (!PrototypeFakes.Studio()) return;
        Effects();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Effects()
    {
        var (plan, capture) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        Assert.Empty(plan.Problems);
        var events = plan.Report["events"]!.AsObject();
        Assert.Empty(events["notCompiled"]!.AsArray());
        // every event compiled, but the background click guarded by its target (3.7, outOfScope)
        // every event compiled, but the background click guarded by its target (3.7, outOfScope) and an event whose trigger no
        // explored state of its owner shows (listed in untriggered, never silent)
        var untriggered = events["untriggered"]!.AsArray().Select(u => u!["event"]!.ToString()).ToHashSet();
        var compiled = events["compiled"]!.GetValue<int>();
        Assert.True(compiled + untriggered.Count + events["targetGuarded"]!.AsArray().Count >= capture.Events.Count, events.ToJsonString());
        var server = PrototypeFakes.Actions(plan, "server").ToDictionary(a => a["name"]!.ToString());
        var screen = PrototypeFakes.Actions(plan, "screen").ToList();
        // one server action per data-changing event (S2), described by its event
        var dataKinds = new HashSet<string>(PrototypeCapture.DataEffects, StringComparer.Ordinal);
        var dataEvents = capture.Events.Where(e => EffectsOf(e).Any(f => dataKinds.Contains(f["kind"]!.ToString()))).Select(e => e["key"]!.ToString()).ToHashSet();
        var described = server.Values.Select(a => a["description"]!.ToString()).Select(d => dataEvents.FirstOrDefault(k => d.Contains(" " + k + " ", StringComparison.Ordinal))).ToList();
        Assert.DoesNotContain(null, described);
        Assert.Equal(dataEvents.Order(StringComparer.Ordinal), described.Distinct().Order(StringComparer.Ordinal));
        // each screen action calls at most one server action, and only through its typed reference
        foreach (var action in screen)
        {
            var calls = PrototypeFakes.AllSteps(action).Count(s => s["call"]?.ToString()?.StartsWith("IServerAction:", StringComparison.Ordinal) == true);
            Assert.True(calls <= 1, $"{action["owner"]}/{action["name"]} calls {calls} server actions");
        }
        // lifecycle handlers only assign or sort on the client (S1): no server call, no aggregate
        foreach (var action in screen.Where(a => a["name"]!.ToString() is "Inicializar" || a["name"]!.ToString().StartsWith("Ordenar", StringComparison.Ordinal)))
            Assert.DoesNotContain(PrototypeFakes.AllSteps(action), s => s["call"]?.ToString()?.StartsWith("IServerAction:", StringComparison.Ordinal) == true || s["get"] != null || s["node"]?.ToString() == "IRefreshDataNode");
        // toggle: Get<E>ForUpdate + not + Update<E>
        var toggleSteps = PrototypeFakes.AllSteps(server["AlternarProdutoAtivo"]).ToList();
        Assert.Contains(toggleSteps, s => s["call"]?.ToString() == "GetProdutoForUpdate");
        Assert.Contains(toggleSteps, s => s["assign"] is JsonObject a && a.Any(p => p.Value!.ToString().StartsWith("not ", StringComparison.Ordinal)));
        Assert.Contains(toggleSteps, s => s["update"]?.ToString() == "Produto");
        // increment: Max(min, Min(max, field + d))
        Assert.Contains(PrototypeFakes.AllSteps(server["AlterarCarrinhoItemQuantidade"]), s => s["assign"] is JsonObject a && a.Any(p => p.Value!.ToString().Contains("Max(") && p.Value!.ToString().Contains("Min(")));
        // remove: Delete<E>
        Assert.Contains(PrototypeFakes.AllSteps(server["RemoverCarrinhoItem"]), s => s["delete"]?.ToString() == "CarrinhoItem");
        // insert: aggregate Max(Id) + Create<E>, the key returned
        var insert = PrototypeFakes.AllSteps(server["CriarPedido"]).ToList();
        Assert.Contains(insert, s => s["get"] != null && s["columns"] is JsonArray cols && cols.Any(c => c!["kind"]?.ToString() == "Max"));
        Assert.Contains(insert, s => s["create"]?.ToString() == "Pedido");
        Assert.Contains(server["CriarPedido"]["outputs"]!.AsArray(), o => o!["name"]!.ToString() == "PedidoId");
        // validate: If + Raise of the user exception; the screen action's handler assigns the message to the observed target
        Assert.Contains(insert, s => s["if"] != null && PrototypeFakes.Steps(s["then"]).Any(t => t["raise"]?.ToString() == "FarmaVirtualValidacao"));
        var checkout = screen.Single(a => a["name"]!.ToString() == "CriarPedido");
        var handler = checkout["handlers"]!.AsArray().Single()!;
        Assert.Equal("FarmaVirtualValidacao", handler["exception"]!.ToString());
        Assert.Contains(PrototypeFakes.Steps(handler["steps"]), s => s["assign"] is JsonObject a && a.ContainsKey("CheckoutErro"));
        // upsert: aggregate by the key fields + If new item -> insert / increment
        Assert.Contains(PrototypeFakes.AllSteps(server["AdicionarCarrinhoItem"]), s => s["if"] != null && s["label"]?.ToString() == "Item novo?");
        // set effects: one parameterized, portable Advanced SQL each
        var sql = server.Values.SelectMany(PrototypeFakes.AllSteps).Where(s => s["sql"]?.GetValue<bool>() == true).ToList();
        Assert.Equal(capture.Events.SelectMany(EffectsOf).Count(f => f["kind"]!.ToString() is "insertFrom" or "updateFrom" or "removeWhere"), sql.Count);
        foreach (var s in sql)
        {
            var text = s["statement"]!.ToString();
            Assert.Matches("^(INSERT INTO \\{|UPDATE \\{|DELETE FROM \\{)", text);
            foreach (var bad in new[] { " TOP ", "ISNULL(", "GETDATE", " LIMIT ", "ILIKE", "::", "NOW()", "IDENTITY", "NEWID", "SERIAL" })
                Assert.DoesNotContain(bad, text, StringComparison.OrdinalIgnoreCase);
            foreach (var (name, _) in s["params"]!.AsObject()) Assert.Contains("@" + name, text);
            Assert.DoesNotContain("'", text);
        }
        // popups and toasts: Assign
        Assert.Contains(PrototypeFakes.AllSteps(screen.Single(a => a["name"]!.ToString() == "AbrirDetalhesDoProduto")), s => s["assign"] is JsonObject a && a["DetalhesDoProdutoIsOpen"]?.ToString() == "True");
        Assert.Contains(screen.SelectMany(PrototypeFakes.AllSteps), s => s["assign"] is JsonObject a && a.Any(p => p.Key.EndsWith("IsOpen", StringComparison.Ordinal) && p.Value!.ToString() == "False"));
        Assert.Contains(screen.SelectMany(PrototypeFakes.AllSteps), s => s["assign"] is JsonObject a && a.ContainsKey("Aviso") && a.ContainsKey("AvisoErro"));
        // a global dimension writes its Client Variable
        Assert.Contains(screen.SelectMany(PrototypeFakes.AllSteps), s => s["assign"] is JsonObject a && a.Any(p => p.Key.StartsWith("Client.FarmaVirtual", StringComparison.Ordinal)));
        // a navigation after other effects: Destination at the end of the action
        Assert.Contains(PrototypeFakes.Steps(checkout["steps"]), s => s["node"]?.ToString() == "IDestinationNode" && s["properties"]!["Destination"]!.ToString() == "IMobileScreen:PedidoDetalhe");
        // nothing the owner's standards forbid, anywhere in the plan
        NoForbiddenConstructs(plan);
        output.WriteLine($"server actions {server.Count}, screen actions {screen.Count}, sql {sql.Count}");
    }

    internal static void NoForbiddenConstructs(PrototypePlan plan)
    {
        var ops = string.Join("\n", PrototypeFakes.Ops(plan).Select(o => o.ToJsonString()));
        foreach (var bad in new[] { "JavaScript", "JSONSerialize", "JSONDeserialize", "\"Visible\"", "ForEach" })
            Assert.DoesNotContain(bad, ops, StringComparison.Ordinal);
        foreach (var (node, spec, _) in PrototypeFakes.Widgets(plan))
        {
            Assert.DoesNotContain(spec.Properties, p => p.Property == "Visible");
            Assert.DoesNotContain("JavaScript", node.W);
            // inline JS attributes never become extended properties (the behavior comes from the observed effects)
            Assert.DoesNotContain(spec.Extended, e => e.Name.Length > 2 && e.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase) && char.IsLower(e.Name[2]));
        }
    }

    private static IEnumerable<JsonObject> EffectsOf(JsonObject e)
        => (e["effects"] as JsonArray ?? []).OfType<JsonObject>().Concat((e["cases"] as JsonArray ?? []).OfType<JsonObject>().SelectMany(c => (c["effects"] as JsonArray ?? []).OfType<JsonObject>()));

    // ---- 5. data: static and regular entities, aggregates, sort and popup index -----------------------------------------------

    [Fact]
    public void CollectionsBecomeStaticOrRegularEntitiesWithFilteredSortedAggregatesListSortAndListIndexOf()
    {
        if (!PrototypeFakes.Studio()) return;
        Data();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Data()
    {
        var (plan, capture) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        var ops = PrototypeFakes.Ops(plan).ToList();
        foreach (var collection in capture.Collections)
        {
            // the singular PascalCase of the collection; the prototype's prefix only when that name is taken (Users -> User,
            // a system entity of the references -> FarmaVirtualUser)
            var name = plan.EntityCollections.Single(e => e.Value == collection["name"]!.ToString()).Key;
            var stem = PrototypeNames.EntityStem(collection["name"]!.ToString());
            Assert.True(name == stem || name == "FarmaVirtual" + stem, $"{collection["name"]} became {name}");
            var create = ops.Single(o => o["op"]?.ToString() == "create" && o["name"]?.ToString() == name && o["parent"]?.ToString() == "@espace");
            var mutated = capture.Mutated(collection["name"]!.ToString());
            Assert.Equal(mutated ? "IServerEntity" : "IStaticEntity", create["type"]!.ToString());
            var alias = create["as"]!.ToString();
            // the key: Integer, never AutoNumber (the prototype's keys show on the screens)
            Assert.Contains(ops, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == alias + ".Id" && o["prop"]?.ToString() == "IsAutoNumber" && o["value"]?.ToString() == "No");
            var records = ops.Count(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() == alias && o["type"]?.ToString() == "IRecord");
            if (mutated) Assert.Equal(0, records);
            else Assert.Equal((collection["rows"] as JsonArray)!.Count, records);
        }
        // the catalog's list: an aggregate with the observed filter and order
        var aggregate = ops.Single(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IScreenAggregate" && o["name"]?.ToString() == "Produtos" && o["parent"]?.ToString() == "$p.scr.catalogo");
        var children = ops.Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() == aggregate["as"]!.ToString()).ToList();
        Assert.Contains(children, c => c["type"]!.ToString() == "IFilter");
        Assert.Equal(2, children.Count(c => c["type"]!.ToString() == "ISort"));
        // Ordenar<Lista>: a Switch with one ListSort per observed value, bare attribute, on OnAfterFetch
        var sorter = PrototypeFakes.Actions(plan, "screen").Single(a => a["name"]!.ToString() == "OrdenarProdutos");
        var sorts = PrototypeFakes.AllSteps(sorter).Where(s => s["call"]?.ToString() == "IClientActionSignature:ListSort").ToList();
        Assert.Equal(3, sorts.Count);
        foreach (var s in sorts) Assert.Matches("^Produto\\.[A-Za-z]+$", s["args"]!["By"]!.ToString());
        Assert.Contains(ops, o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == aggregate["as"] + "/OnAfterFetch" && o["value"]?.ToString()?.EndsWith("/OrdenarProdutos", StringComparison.Ordinal) == true);
        // the popup of a list item: ListIndexOf on the list of the same collection, no search and no refresh
        var open = PrototypeFakes.Actions(plan, "screen").Single(a => a["name"]!.ToString() == "AbrirDetalhesDoProduto");
        var index = PrototypeFakes.AllSteps(open).Single(s => s["call"]?.ToString() == "IClientActionSignature:ListIndexOf");
        Assert.Equal("Produtos.List", index["args"]!["List"]!.ToString());
        Assert.DoesNotContain("List.Current", index["args"]!["Condition"]!.ToString());
        Assert.DoesNotContain(PrototypeFakes.AllSteps(open), s => s["node"]?.ToString() == "IRefreshDataNode");
        // global dimensions are Client Variables, screen dimensions are locals
        foreach (var dim in capture.Dimensions)
        {
            var cv = ops.Any(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IClientVariable" && o["name"]?.ToString() == "FarmaVirtual" + dim["name"]);
            Assert.Equal(dim["scope"]!.ToString() == "global", cv);
        }
    }

    // ---- 6. names over an existing module: marked in place, unmarked renamed, requested collision refused --------------------

    [Fact]
    public void ReimportNamesFollowTheMarkUnmarkedHomonymsAreRenamedAndRequestedCollisionsRefuse()
    {
        if (!PrototypeFakes.Studio()) return;
        Names();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Names()
    {
        // an unmarked homonym of an inferred name: <Prefix><Name> (then 2, 3...), listed, never refused
        var unmarked = new PrototypeModule
        {
            Name = "Haiku_UI", Platform = "o11",
            Elements = [new("IMobileScreen", "Lista", "the user's own screen", "k-lista"), new("IMobileScreen", "MiniLista", null, "k-minilista"), new("IServerEntity", "Tarefa", null, "k-tarefa")],
        };
        var (renamed, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: unmarked);
        Assert.Empty(renamed.Problems);
        Assert.Equal("MiniLista2", renamed.Screens["lista"]);
        var list = renamed.Report["renamed"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Contains(list, r => r["name"]!.ToString() == "MiniLista2" && r["renamedFrom"]!.ToString() == "Lista");
        // an unmarked entity holding the singular of the collection: the prototype's prefix (MiniTarefa)
        Assert.DoesNotContain(PrototypeFakes.Ops(renamed), o => o.ToJsonString().Contains("@k-"));
        // the marked element of an earlier import: updated in place (same key), its content cleared and rebuilt
        var marked = new PrototypeModule { Name = "Haiku_UI", Platform = "o11", Elements = [new("IMobileScreen", "Lista", PrototypeNames.Description("A screen of an earlier import.", "Mini"), "k-lista")] };
        var (inPlace, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: marked);
        Assert.Equal("Lista", inPlace.Screens["lista"]);
        Assert.Equal("@k-lista", inPlace.OwnerRefs["Lista"]);
        Assert.Contains(inPlace.Steps, s => s.Special == "clear" && s.Arguments!["owner"]!.ToString() == "@k-lista");
        Assert.DoesNotContain(PrototypeFakes.Ops(inPlace), o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IMobileScreen" && o["name"]?.ToString() == "Lista");
        // requested names colliding with unmarked elements: PROTOTYPE_NAME_COLLISION with every such name, once
        var requested = new JsonObject { ["mapping"] = new JsonObject { ["screens"] = new JsonObject { ["lista"] = "Lista", ["tarefa"] = "Detalhe" } } };
        var collide = new PrototypeModule { Name = "Haiku_UI", Platform = "o11", Elements = [new("IMobileScreen", "Lista", null, "k1"), new("IMobileScreen", "Detalhe", "", "k2")] };
        var (refused, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: collide, extra: requested);
        var problem = Assert.Single(refused.Problems);
        Assert.Equal(PrototypeCapture.NameCollision, problem.Code);
        Assert.Contains("Lista", problem.Message);
        Assert.Contains("Detalhe", problem.Message);
        Assert.NotNull(problem.Patch);
        Assert.Empty(refused.Steps);
        // a missing seam refuses the capture as an SSAM defect, before anything is planned
        var (noSeam, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, seams: new PrototypeExpander.Seams(null, PrototypeFakes.Css, null));
        Assert.Equal(2, noSeam.Problems.Count);
        Assert.All(noSeam.Problems, p => { Assert.Equal(PrototypeCapture.IrInvalid, p.Code); Assert.True(p.SsamDefect); });
        Assert.Contains(noSeam.Problems, p => p.Message.Contains("Element missing"));
        Assert.Contains(noSeam.Problems, p => p.Message.Contains("Render missing"));
        Assert.Empty(noSeam.Steps);
    }

    [Fact]
    public void TheSameCaptureOverTheModuleItProducedIsNoChangeAndAVanishedElementIsListed()
    {
        if (!PrototypeFakes.Studio()) return;
        NoChange();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void NoChange()
    {
        var (first, capture) = PrototypeFakes.Plan(PrototypeFakes.Minimal);
        Assert.False(first.NoChange);
        // the module after the first import: every element it created, marked, and the flow description with the hashes
        var described = PrototypeFakes.Ops(first).Where(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Description").ToDictionary(o => o["target"]!.ToString(), o => o["value"]!.ToString());
        var flowDescription = first.Steps.Single(s => s.Special == "flow-description").Arguments!["description"]!.ToString();
        var elements = new List<PrototypeElement>();
        var n = 0;
        foreach (var create in PrototypeFakes.Ops(first).Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() is "@espace" or "$p.flow"))
        {
            var type = create["type"]!.ToString();
            elements.Add(new(type, create["name"]!.ToString(), type == "IMobileFlow" ? flowDescription : described.GetValueOrDefault(create["as"]!.ToString()), "k" + n++));
        }
        foreach (var action in PrototypeFakes.Actions(first, "server")) elements.Add(new("IServerAction", action["name"]!.ToString(), action["description"]!.ToString(), "k" + n++));
        var module = new PrototypeModule { Name = "Haiku_UI", Platform = "o11", Elements = elements };
        var (second, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: module);
        Assert.True(second.NoChange, "the same capture over its own result is NO_CHANGE");
        Assert.Equal(first.PlanSha, second.PlanSha);
        Assert.True(second.Report["noChange"]!.GetValue<bool>());
        // an element of the import deleted by hand: imported again, not NO_CHANGE
        var (fifth, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: new PrototypeModule { Name = "Haiku_UI", Platform = "o11", Elements = elements.Where(e => e.Name != "TarefaDetalhe").ToList() });
        Assert.False(fifth.NoChange);
        // a marked element the capture no longer produces: vanished (the session deletes it unless something outside uses it)
        var stale = new PrototypeElement("IMobileScreen", "Antiga", PrototypeNames.Description("A screen of an earlier capture.", "Mini"), "k-old");
        var (third, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: new PrototypeModule { Name = "Haiku_UI", Platform = "o11", Elements = [.. elements, stale] });
        Assert.False(third.NoChange);
        Assert.Equal("k-old", Assert.Single(third.Vanished).Key);
        Assert.Contains(third.Steps, s => s.Special == "vanished");
        // other options over the same module are not NO_CHANGE
        var (fourth, _) = PrototypeFakes.Plan(PrototypeFakes.Minimal, module: module, extra: new JsonObject { ["home"] = true });
        Assert.False(fourth.NoChange);
        Assert.NotEqual(first.PlanSha, fourth.PlanSha);
        Assert.Equal(capture.Sha256, second.Report["source"]!["captureSha256"]!.ToString());
    }

    // ---- 6b. every name is reserved against the base before the ops are generated (the Haiku_UI of 2026-10-11) ----------------

    /// <summary>The members of each owner of a plan: screen actions, and the locals, inputs, aggregates and block events created
    /// directly under it, by owner name.</summary>
    private static (Dictionary<string, HashSet<string>> Actions, Dictionary<string, HashSet<string>> Data) Members(PrototypePlan plan)
    {
        var byRef = plan.OwnerRefs.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        var actions = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var a in PrototypeFakes.Actions(plan, "screen"))
        {
            var owner = a["owner"]!.ToString().Split(':', 2)[1];
            if (!actions.TryGetValue(owner, out var set)) actions[owner] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Assert.True(set.Add(a["name"]!.ToString()), $"screen action {a["name"]} declared twice in {owner}");
        }
        var data = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var o in PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() is "ILocalVariable" or "IInputParameter" or "IScreenAggregate" or "IBlockEvent"))
        {
            if (!byRef.TryGetValue(o["parent"]!.ToString(), out var owner)) continue; // a parameter of a block event
            if (!data.TryGetValue(owner, out var set)) data[owner] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            set.Add(o["name"]!.ToString());
        }
        return (actions, data);
    }

    [Fact]
    public void EveryNameTheBaseAlreadyHoldsIsReservedInItsStudioScopeBeforeTheOpsAreGenerated()
    {
        if (!PrototypeFakes.Studio()) return;
        Reservation();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Reservation()
    {
        // the import over an empty module: every name it would create
        var (clean, _) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        Assert.Empty(clean.Problems);
        var (cleanActions, _) = Members(clean);
        var actionNames = cleanActions.Values.SelectMany(s => s).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToList();
        Assert.Contains("FecharAviso", actionNames); // the screen action of the live refusal (Catalogo)
        // a base that already has an element with every one of those names, of the kind the Studio renames against: half of the
        // screen action names as client actions of the module (the official MCP's FecharAviso), half as client actions of a
        // referenced module (OutSystemsUI's NotificationClose case), and every module-level name with an element of its kind
        var elements = new List<PrototypeElement>();
        var n = 0;
        foreach (var name in actionNames) elements.Add(new(n % 2 == 0 ? "IClientAction" : "IClientActionSignature", name, null, "k-a" + n++));
        foreach (var create in PrototypeFakes.Ops(clean).Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() is "@espace" or "$p.flow"))
            elements.Add(new(create["type"]!.ToString(), create["name"]!.ToString(), "the owner's own element", "k-m" + n++));
        foreach (var action in PrototypeFakes.Actions(clean, "server")) elements.Add(new("IServerAction", action["name"]!.ToString(), null, "k-s" + n++));
        var module = new PrototypeModule { Name = "Haiku_UI", Platform = "o11", Elements = elements };
        var (plan, _) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual, module: module);
        Assert.Empty(plan.Problems);
        Assert.NotEmpty(plan.Steps);

        // 1. no screen action of any screen or block takes the name of a client action of the module or of its references
        var clientActions = new HashSet<string>(elements.Where(e => e.Kind is "IClientAction" or "IClientActionSignature").Select(e => e.Name), StringComparer.OrdinalIgnoreCase);
        var (actions, data) = Members(plan);
        foreach (var (owner, names) in actions)
            foreach (var name in names) Assert.False(clientActions.Contains(name), $"screen action {owner}/{name} has the name of a client action of the base");
        string Counts(Dictionary<string, HashSet<string>> m) => string.Join(", ", m.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => p.Key + "=" + p.Value.Count + "[" + string.Join(" ", p.Value.Order(StringComparer.Ordinal)) + "]"));
        Assert.True(cleanActions.Values.Sum(s => s.Count) == actions.Values.Sum(s => s.Count), "clean: " + Counts(cleanActions) + "\nreserved: " + Counts(actions) + "\nnotCompiled: " + plan.Report["events"]?["notCompiled"]?.ToJsonString() + "\nclean notCompiled: " + clean.Report["events"]?["notCompiled"]?.ToJsonString());
        // 2. no module-level element takes a name the base holds in its scope (the entity, action, ui... scopes of 1.6)
        var taken = new HashSet<string>(elements.Select(e => e.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var create in PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() is "@espace" or "$p.flow"))
            Assert.False(taken.Contains(create["name"]!.ToString()), $"{create["type"]} {create["name"]} takes a name of the base");
        foreach (var action in PrototypeFakes.Actions(plan, "server")) Assert.False(taken.Contains(action["name"]!.ToString()), $"server action {action["name"]} takes a name of the base");
        // 3. every reference uses the final name: the widgets' handlers and block handlers, and the lifecycle wiring
        foreach (var (node, spec, owner) in PrototypeFakes.Widgets(plan))
        {
            if (spec.Handler?.Action is { } handler) Assert.True(actions.TryGetValue(owner, out var own) && own.Contains(handler), $"{owner}: the handler {handler} is no screen action of the owner");
            foreach (var (evt, action) in spec.BlockHandlers) Assert.True(actions.TryGetValue(owner, out var own) && own.Contains(action), $"{owner}: the handler {action} of {evt} is no screen action of the owner");
        }
        var byRef = plan.OwnerRefs.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        foreach (var set in PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() is "Destination" or "Handler" && o["value"] is JsonValue))
        {
            var value = set["value"]!.ToString();
            var cut = value.LastIndexOf('/');
            if (cut < 0 || !byRef.TryGetValue(value[..cut], out var owner)) continue;
            Assert.True(actions.TryGetValue(owner, out var own) && own.Contains(value[(cut + 1)..]), $"the Destination {value} is no screen action of {owner}");
        }
        // 4. the locals, inputs and aggregates of an owner never take the name of one of its widgets (one namespace for the Studio)
        foreach (var group in PrototypeFakes.Widgets(plan).Where(w => w.Spec.Name != null).GroupBy(w => w.Owner))
            if (data.TryGetValue(group.Key, out var own))
                foreach (var w in group) Assert.False(own.Contains(w.Spec.Name!), $"{group.Key}: the widget {w.Spec.Name} has the name of a local, input or aggregate");
        // 5. the receipt says which member got which name and why
        var renamed = plan.Report["renamed"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Contains(renamed, r => r["kind"]!.ToString() == "screen action" && r["renamedFrom"]!.ToString() == "FecharAviso" && r["why"]!.ToString().Contains("client action FecharAviso"));
        Assert.All(renamed.Where(r => r["kind"]!.ToString() == "screen action"), r => Assert.False(clientActions.Contains(r["name"]!.ToString())));
    }

    [Fact]
    public void AnEntityIsTheSingularOfItsCollectionInPascalCase()
    {
        // N1 of the owner's standard: imoveis -> Imovel, the photos inside a property -> ImovelFoto; already singular stays
        Assert.Equal(["Imovel", "ImovelFoto", "Proposta", "Usuario", "Favorito", "CarrinhoItem", "StatusPedido", "User", "Opcao", "Item", "Cor", "ImovelFeature", "Lapis"],
            new[] { "imoveis", "imoveisFotos", "propostas", "usuarios", "favoritos", "CarrinhoItem", "StatusPedido", "Users", "opcoes", "itens", "cores", "ImovelFeatures", "lapis" }.Select(PrototypeNames.EntityStem));
    }

    [Fact]
    public void MappingNamesGivesTheNameOfAGeneratedElementAndEveryReferenceUsesIt()
    {
        if (!PrototypeFakes.Studio()) return;
        MappedNames();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void MappedNames()
    {
        var (clean, _) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual);
        var (cleanActions, _) = Members(clean);
        var owner = cleanActions.First(p => p.Value.Contains("FecharAviso")).Key;
        var names = new JsonObject { [owner + "/FecharAviso"] = "FecharAvisoTela", ["FarmaVirtualTheme"] = "FarmaVirtualTema" };
        var (plan, _) = PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual, extra: new JsonObject { ["mapping"] = new JsonObject { ["names"] = names } });
        Assert.Empty(plan.Problems);
        var (actions, _) = Members(plan);
        Assert.Contains("FecharAvisoTela", actions[owner]);
        Assert.DoesNotContain("FecharAviso", actions[owner]);
        // every reference of the owner to that action (widget handlers, block instance handlers, the Handler and Destination
        // wiring) uses the mapped name
        var ownerRef = plan.OwnerRefs[owner] + "/";
        var references = PrototypeFakes.Widgets(plan).Where(w => w.Owner == owner)
            .SelectMany(w => (w.Spec.Handler?.Action is { } a ? new[] { a } : []).Concat(w.Spec.BlockHandlers.Select(h => h.Action)))
            .Concat(PrototypeFakes.Ops(plan).Where(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() is "Destination" or "Handler" && o["value"] is JsonValue v
                && v.ToString().StartsWith(ownerRef, StringComparison.Ordinal)).Select(o => o["value"]!.ToString()[ownerRef.Length..])).ToList();
        Assert.Contains("FecharAvisoTela", references);
        Assert.DoesNotContain("FecharAviso", references);
        Assert.Equal("FarmaVirtualTema", plan.ThemeName);
        Assert.Contains(PrototypeFakes.Ops(plan), o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IMobileTheme" && o["name"]?.ToString() == "FarmaVirtualTema");
        // a value that is no identifier is INPUT_INVALID at load, with every such entry at once
        var problems = new List<PrototypeCapture.Problem>();
        PrototypeCapture.Load(PrototypeFakes.Data(PrototypeFakes.FarmaVirtual, null, new JsonObject { ["mapping"] = new JsonObject { ["names"] = new JsonObject { ["A/B"] = "1x", ["C"] = 3 } } }), problems);
        Assert.Equal(2, problems.Count(p => p.Code == "INPUT_INVALID" && p.Pointer.StartsWith("/mapping/names/", StringComparison.Ordinal)));
    }

    [Fact]
    public void ALeftoverStudioRenameOfAGeneratedOpIsANameCollisionWithTheReadyNameMap()
    {
        // what Create leaves on the exception when the Studio renamed a newcomer, wrapped as the logic op and the step wrap it
        var inner = new InvalidOperationException("create IScreenAction 'FecharAviso' under IMobileScreen 'Catalogo': the name collides with an element of the same name in that scope and the Studio renamed it to 'FecharAviso2'");
        inner.Data[ModelSession.NameCollisionData] = new JsonObject { ["type"] = "IScreenAction", ["name"] = "FecharAviso", ["actual"] = "FecharAviso2", ["parentType"] = "IMobileScreen", ["parentName"] = "Catalogo" }.ToJsonString();
        var error = new InvalidOperationException("prototype step 'screen and block actions' op #0 (logic): logic op #548 (...)", new InvalidOperationException("logic op #548", inner));
        // without mapping: the patch adds mapping with the map
        var none = ModelSession.PrototypeCollisionProblem(error, new JsonObject { ["source"] = "C:\\p" }, "screen and block actions")!;
        Assert.Equal("/mapping/names/Catalogo~1FecharAviso", none["pointer"]!.ToString());
        Assert.Equal("""[{"op":"add","path":"/mapping","value":{"names":{"Catalogo/FecharAviso":"FecharAviso2"}}}]""", none["patch"]!.ToJsonString());
        Assert.Contains("mapping.names", none["fix"]!.ToString());
        Assert.DoesNotContain("api --op", none["fix"]!.ToString());
        // with mapping and without names: the patch adds names; with names: one entry
        var some = ModelSession.PrototypeCollisionProblem(error, new JsonObject { ["mapping"] = new JsonObject { ["ignore"] = new JsonArray("#x") } }, "s")!;
        Assert.Equal("""[{"op":"add","path":"/mapping/names","value":{"Catalogo/FecharAviso":"FecharAviso2"}}]""", some["patch"]!.ToJsonString());
        var more = ModelSession.PrototypeCollisionProblem(error, new JsonObject { ["mapping"] = new JsonObject { ["names"] = new JsonObject { ["X"] = "Y" } } }, "s")!;
        Assert.Equal("""[{"op":"add","path":"/mapping/names/Catalogo~1FecharAviso","value":"FecharAviso2"}]""", more["patch"]!.ToJsonString());
        // a module-level element is mapped by its bare name; an error without the facts is no collision
        var module = new InvalidOperationException("create IMobileTheme 'FarmaVirtualTheme' under ESpace 'Haiku_UI': ...");
        module.Data[ModelSession.NameCollisionData] = new JsonObject { ["type"] = "IMobileTheme", ["name"] = "FarmaVirtualTheme", ["actual"] = "FarmaVirtualTheme2", ["parentType"] = "IESpace", ["parentName"] = "Haiku_UI" }.ToJsonString();
        Assert.Equal("""[{"op":"add","path":"/mapping","value":{"names":{"FarmaVirtualTheme":"FarmaVirtualTheme2"}}}]""", ModelSession.PrototypeCollisionProblem(module, new JsonObject(), "theme")!["patch"]!.ToJsonString());
        Assert.Null(ModelSession.PrototypeCollisionProblem(new InvalidOperationException("other"), new JsonObject(), "s"));
    }

    // ---- 8 (expansion half): the FarmaVirtual capture expands in at most 3 s ---------------------------------------------------

    [Fact]
    public void TheFarmaVirtualCaptureExpandsWithinThreeSeconds()
    {
        if (!PrototypeFakes.Studio()) return;
        Expansion();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Expansion()
    {
        PrototypeFakes.Plan(PrototypeFakes.Minimal); // the JIT of the planner is not the capture's cost
        // The cost of the expansion, not the load of the machine: the CPU time of this thread, the fastest of three (CpuBudget).
        var runs = CpuBudget.Measure(Enumerable.Range(0, 3).Select(_ => (Func<PrototypePlan>)(() => PrototypeFakes.Plan(PrototypeFakes.FarmaVirtual).Plan)));
        var plan = runs[0].Result; var ms = CpuBudget.Best(runs);
        Assert.Empty(plan.Problems);
        output.WriteLine($"FarmaVirtual expansion {CpuBudget.Describe(runs)}: {plan.OpCount} ops, {PrototypeFakes.Widgets(plan).Count()} widgets, {plan.Screens.Count} screens");
        Assert.True(ms <= 3000, $"expansion took {CpuBudget.Describe(runs)} (budget 3 s, docs/PROTOTIPO-NATIVO.md 6)");
        // the acceptance numbers of 8.1 the plan already decides
        Assert.Equal(["Carrinho", "Catalogo", "GestaoPedidos", "GestaoProdutos", "MeusPedidos", "PedidoDetalhe"], plan.Screens.Values.Order(StringComparer.Ordinal));
        Assert.Equal("FarmaVirtualShell", plan.ShellName);
        Assert.Equal(6, PrototypeFakes.Widgets(plan).Count(w => w.Node.W == "IPopup"));
        Assert.Equal(6, PrototypeFakes.Ops(plan).Count(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IMobileBlockInstanceWidget" && o["source"]?.ToString() == "$p.blk.shell"));
        Assert.Contains(PrototypeFakes.Ops(plan), o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IMobileBlock" && o["name"]?.ToString() == "AtualizarPedido");
        Assert.Equal("FarmaVirtualProducts", PrototypeFakes.Ops(plan).Single(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IImage")["name"]!.ToString());
        Assert.Contains("ssam-icon-plus-w300", plan.IconClasses);
        NoForbiddenConstructs(plan);
    }

    // ---- the preflight: every problem of the capture in one refusal ----------------------------------------------------------

    [Fact]
    public void ThePreflightReportsEveryProblemOfTheCaptureAtOnce()
    {
        if (!PrototypeFakes.Studio()) return;
        Preflight();
    }

    // ---- boolean attributes and conditional values ----------------------------------------------------------------------------

    [Fact]
    public void ABooleanAttributeIsWrittenByItsNameAndAConditionalValueIsAnExpressionNeverItsJson()
    {
        if (!PrototypeFakes.Studio()) return;
        Booleans();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Booleans()
    {
        var dir = Path.Combine(Path.GetTempPath(), "proto-booleans-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            var bundle = Path.Combine(PrototypeFakes.Fixtures, "minimal.bundle");
            foreach (var file in Directory.EnumerateFiles(bundle, "*", SearchOption.AllDirectories))
            {
                var target = Path.Combine(dir, "minimal.bundle", Path.GetRelativePath(bundle, file));
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(file, target);
            }
            var capture = JsonNode.Parse(File.ReadAllText(PrototypeFakes.Minimal))!.AsObject();
            JsonObject Node(string k) => Find(capture["views"]![0]!["root"], k) ?? throw new InvalidOperationException(k);
            // a statically hidden paragraph; a button hidden while the search is empty; a heading whose class, present for one
            // order, is itself a choice (cases)
            ((JsonArray)Node("v:lista/0/1")["a"]!).Add(new JsonArray("hidden", ""));
            Node("v:lista/0/3")["attrExpr"] = JsonNode.Parse("""{"hidden":{"when":{"op":"eq","l":{"dim":"busca"},"r":{"lit":""}},"then":""}}""");
            Node("v:lista/0/0")["attrExpr"] = JsonNode.Parse("""{"class":{"when":{"op":"ne","l":{"dim":"ordem"},"r":{"lit":"nenhuma"}},"then":{"fmt":"cases","cases":[{"when":{"op":"eq","l":{"dim":"ordem"},"r":{"lit":"pontos"}},"value":{"lit":"por-pontos"}}],"else":{"lit":""}}}}""");
            var path = Path.Combine(dir, "minimal.capture.json");
            File.WriteAllText(path, capture.ToJsonString());
            var (plan, _) = PrototypeFakes.Plan(path);
            var specs = PrototypeFakes.Widgets(plan).Where(w => w.Node.K != null).GroupBy(w => w.Node.K!).ToDictionary(g => g.Key, g => g.First().Spec);
            // present by its own name: the runtime drops an empty value
            Assert.Contains(specs["v:lista/0/1"].Extended, e => e.Name == "hidden" && e.Value == "\"hidden\"");
            var hidden = specs["v:lista/0/3"].Extended.Single(e => e.Name == "hidden").Value;
            Assert.StartsWith("If(", hidden);
            Assert.EndsWith(", \"hidden\", \"\")", hidden);
            // the class of the heading: an expression of the order, never the JSON of the cases
            var style = PrototypeFakes.Prop(specs["v:lista/0/0"], "Style")!;
            Assert.Contains("por-pontos", style);
            Assert.DoesNotContain("{", style);
            Assert.DoesNotContain("cases", style);
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }

    private static JsonObject? Find(JsonNode? node, string k)
    {
        if (node is JsonObject o)
        {
            if (o["k"]?.ToString() == k) return o;
            foreach (var (_, value) in o) if (Find(value, k) is { } found) return found;
        }
        else if (node is JsonArray a) foreach (var item in a) if (Find(item, k) is { } found) return found;
        return null;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Preflight()
    {
        Assert.NotNull(PrototypeSeams.Preflight);
        var dir = Path.Combine(Path.GetTempPath(), "proto-preflight");
        Directory.CreateDirectory(dir);
        var broken = JsonNode.Parse(File.ReadAllText(PrototypeFakes.Minimal))!.AsObject();
        broken["views"]![0]!["name"] = "lista minuscula";
        broken["events"]![1]!["effects"]![0]!["dimension"] = "nenhuma";
        broken["store"]!["collections"]![1]!["fields"]![1]!["type"] = "Money";
        var path = Path.Combine(dir, "broken.capture.json");
        File.WriteAllText(path, broken.ToJsonString());
        var op = new JsonObject { ["op"] = "prototype", ["data"] = PrototypeFakes.Data(path, null, new JsonObject { ["prefx"] = "Mini" }) };
        var problems = PrototypeExpander.WithSeams(PrototypeFakes.Seams, () => PrototypeSeams.Preflight!(op, 0).ToList());
        var codes = problems.Select(p => p["code"]!.ToString()).ToList();
        Assert.Contains("INPUT_INVALID", codes);
        Assert.True(codes.Count(c => c == PrototypeCapture.IrInvalid) >= 3, string.Join(" | ", problems.Select(p => p.ToJsonString())));
        Assert.All(problems, p => Assert.StartsWith("/ops/0/data", p["pointer"]!.ToString()));
        Assert.Contains(problems, p => p["patch"] is JsonArray patch && patch.Any(x => x!["path"]!.ToString() == "/ops/0/data/prefx"));
    }
}
