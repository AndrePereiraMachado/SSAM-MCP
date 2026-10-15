using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

// ---- the facts the generator reads from the module (Verbs.ScreenGenerator.cs reads them; tests build them by hand) ----------

/// <summary>An attribute of an entity, as the generator needs it: its type as the text writes it ("Text", "Customer
/// Identifier"), whether it is mandatory, its length, and the entity an identifier attribute points at.</summary>
public sealed record GenAttribute(string Name, string Type, bool Mandatory = false, int Length = 0, bool AutoNumber = false,
    string? Target = null, string? Label = null);

/// <summary>An entity of the module or of a reference. Producer: the module that owns it (null: this module). Writable: its
/// entity actions (CreateOrUpdate, Delete) can be called from this module.</summary>
public sealed record GenEntity(string Name, string? Producer, bool Static, string IdName, string IdType,
    IReadOnlyList<GenAttribute> Attributes, bool Writable, string? LabelAttribute = null, string? OrderAttribute = null, string? Label = null);

public sealed record GenParam(string Name, string Type, bool Mandatory = false);

/// <summary>A server or service action this module can call (its own or a reference's), with its signature and the attributes
/// of every record or list output (OutputFields: output name -> its attributes).</summary>
public sealed record GenAction(string Name, string Kind, string? Producer, IReadOnlyList<GenParam> Inputs, IReadOnlyList<GenParam> Outputs,
    IReadOnlyDictionary<string, IReadOnlyList<GenParam>>? OutputFields = null);

public sealed record GenEvent(string Name, bool Mandatory, IReadOnlyList<GenParam> Params);

/// <summary>A block this module can instantiate (its own or a reference's): Reference is how a document names it.</summary>
public sealed record GenBlock(string Name, string Reference, string? Producer, IReadOnlyList<GenParam> Inputs, IReadOnlyList<GenEvent> Events,
    IReadOnlyList<string> Placeholders, string? Description = null);

/// <summary>A screen or block that exists: its name, its description (the generator's marker lives there), the layout block its
/// content sits in (null when none), its roles as the reading writes them and its UI flow.</summary>
public sealed record GenRootFact(string Kind, string Name, string? Description, string? Layout, string? Roles, string? Flow, bool Anonymous = false);

/// <summary>Everything the generator reads of a module. Names: every top-level name (to keep the new ones free).</summary>
public sealed record GenModule(string Name, string Lane, string Runtime, IReadOnlyList<GenEntity> Entities, IReadOnlyList<GenAction> Actions,
    IReadOnlyList<GenBlock> Blocks, IReadOnlyList<GenRootFact> Roots, IReadOnlyList<string> Flows, IReadOnlySet<string> Names,
    IReadOnlyDictionary<string, string>? Roles = null, IReadOnlySet<string>? LocalActions = null);

// ---- what the generator plans --------------------------------------------------------------------------------------------

/// <summary>One screen or block to create: the ssam-html/1 document and the ssam-flow/1 texts of its actions (screen actions,
/// block actions and data actions, each with the root as its owner). Sha: the marker the description carries
/// (ssam:gen-screen/1 &lt;sha&gt;), the hash of the text it was generated as, so the same request over the module it produced
/// finds every root unchanged.</summary>
public sealed record GenRoot(string Kind, string Name, string Role, string? Entity, string Html, IReadOnlyList<string> Flows, string Sha)
{
    public int Bytes => Encoding.UTF8.GetByteCount(Html) + Flows.Sum(f => Encoding.UTF8.GetByteCount(f));
}

public sealed record GenPlan(IReadOnlyList<GenRoot> Create, IReadOnlyList<GenRoot> Unchanged, JsonObject Receipt);

/// <summary>
/// Screens from entities and blocks (gen-screen/1): from the module's data model, its actions and its blocks, the standard
/// list, detail and form screens of any entity, as ssam-html/1 documents and ssam-flow/1 texts that the document form of the
/// html op and the logic op compile (ScreenDocument, Verbs.ScreenDocument.cs, Verbs.Flow.cs): the same compile, checks and
/// fixed point as a page a model writes, written by a deterministic family rule instead.
/// <list type="bullet">
/// <item>list: a table (thead + a List with tag tbody) with paging, a filter bar (search over the text attributes, a dropdown
/// per static or entity reference), loading, error and empty states, sortable headers (a dynamic sort), and row links to
/// the detail, the form and a delete that asks first.</item>
/// <item>detail: one record as a two-column table (label, value; a reference shows its target's label), with edit and delete.</item>
/// <item>form: one input per attribute typed from it (text, number, date, checkbox, a dropdown per reference), the built-in
/// validations and the save.</item>
/// </list>
/// Data: read by an aggregate of the entity, or by a data action over a module action found by its signature (a list of
/// the entity with the paging inputs; one record by its identifier); written by a save action found by its signature (one
/// mandatory input that is the entity's record) or by the entity's own CreateOrUpdate/Delete. Without a write path the form
/// and the delete are left out and the receipt says why. Blocks: the module's (or a reference's) blocks for each role
/// (layout, pagination, confirmation, filter bar), found by their signature; a role nothing plays is a block created once
/// in this module (blocks:"auto") or plain markup (blocks:"inline"). The owner's rules hold by construction: no JavaScript,
/// no Visible (If), no For Each (List), data by aggregates and data actions, a table, never cards.
/// Idempotent: every root carries its marker; the same request over the module it produced is NO_CHANGE.
/// </summary>
public static class ScreenGenerator
{
    public const string Marker = "ssam:gen-screen/1";
    public const string Version = "gen-screen/1";

    private static readonly Dictionary<string, string[]> Shapes = new()
    {
        ["generate"] = ["entities", "screens", "blocks", "pageSize", "roles", "flow", "texts", "patterns", "emit"],
        ["entity"] = ["name", "screens", "columns", "search", "filters", "fields", "title", "names"],
        ["names"] = ["list", "detail", "form"],
    };

    public static JsonObject Schema() => new()
    {
        ["form"] = "generate",
        ["shapes"] = new JsonObject(Shapes.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)new JsonArray(p.Value.Select(k => (JsonNode)k).ToArray())))),
        ["example"] = JsonNode.Parse("""{"op":"screen","data":{"generate":{"entities":["Customer","Order","Product"]}}}"""),
        ["rules"] = "generate: the standard list, detail and form screens of each entity named (\"*\": every entity of this module), "
            + "from the module's data model, actions and blocks; the model writes nothing else. entities: names, or objects {name, screens, columns, "
            + "search, filters, fields, title, names{list,detail,form}} to narrow one. screens: list, detail, form (default all three). "
            + "blocks: auto (default: reuse the blocks found by their signature, create the missing ones once in this module), inline "
            + "(plain markup for a missing one). patterns:true creates only the reusable blocks (a Patterns module or library). "
            + "pageSize (default 20), roles (default: the roles most screens have), flow (default MainFlow), texts: en|pt. "
            + "Reads by an aggregate or by a module action found by its signature (Get<E>List, Get<E>ById); writes by a save action "
            + "found by its signature or the entity's CreateOrUpdate/Delete; without one, the form and the delete are left out (receipt). "
            + "A root that exists with the same marker is unchanged (NO_CHANGE); a name taken otherwise is refused with the free name.",
    };

    // ---- texts --------------------------------------------------------------------------------------------------------------
    private static readonly Dictionary<string, Dictionary<string, string>> Texts = new()
    {
        ["en"] = new()
        {
            ["search"] = "Search", ["clear"] = "Clear", ["new"] = "New", ["edit"] = "Edit", ["delete"] = "Delete", ["save"] = "Save",
            ["cancel"] = "Cancel", ["back"] = "Back", ["loading"] = "Loading…", ["empty"] = "No records to show.", ["error"] = "The records could not be loaded.",
            ["notFound"] = "The record was not found.", ["actions"] = "Actions", ["all"] = "All", ["yes"] = "Yes", ["no"] = "No",
            ["confirmDelete"] = "Delete this record? This cannot be undone.", ["confirm"] = "Confirm", ["saved"] = "Saved.", ["deleted"] = "Deleted.",
            ["previous"] = "Previous", ["next"] = "Next", ["of"] = " of ", ["newTitle"] = "New ", ["editTitle"] = "Edit ", ["details"] = " details",
            ["choose"] = "Select…", ["confirmTitle"] = "Please confirm",
        },
        ["pt"] = new()
        {
            ["search"] = "Buscar", ["clear"] = "Limpar", ["new"] = "Novo", ["edit"] = "Editar", ["delete"] = "Excluir", ["save"] = "Salvar",
            ["cancel"] = "Cancelar", ["back"] = "Voltar", ["loading"] = "Carregando…", ["empty"] = "Nenhum registro para mostrar.", ["error"] = "Não foi possível carregar os registros.",
            ["notFound"] = "O registro não foi encontrado.", ["actions"] = "Ações", ["all"] = "Todos", ["yes"] = "Sim", ["no"] = "Não",
            ["confirmDelete"] = "Excluir este registro? Não é possível desfazer.", ["confirm"] = "Confirmar", ["saved"] = "Salvo.", ["deleted"] = "Excluído.",
            ["previous"] = "Anterior", ["next"] = "Próxima", ["of"] = " de ", ["newTitle"] = "Novo: ", ["editTitle"] = "Editar: ", ["details"] = "",
            ["choose"] = "Selecione…", ["confirmTitle"] = "Confirme",
        },
    };

    // ---- the request --------------------------------------------------------------------------------------------------------
    private sealed record EntityRequest(string Name, HashSet<string> Screens, List<string>? Columns, List<string>? Search, List<string>? Filters,
        List<string>? Fields, string? Title, Dictionary<string, string> Names, string Pointer, JsonNode? Original = null);

    private sealed record Request(List<EntityRequest> Entities, string Blocks, int PageSize, string? Roles, string? Flow, Dictionary<string, string> T,
        bool Patterns, bool Emit, string Lang);

    public static bool IsGenerate(JsonObject? data) => data?["generate"] is JsonObject;

    /// <summary>The problems a request has without the module (closed keys, types, values), each with its pointer.</summary>
    public static List<JsonObject> Preflight(JsonObject data, string pointer = "/data")
    {
        var problems = new List<JsonObject>();
        try { Parse(data, null, problems, pointer); } catch (KernelRefusalException) { }
        return problems;
    }

    private static Request Parse(JsonObject data, GenModule? module, List<JsonObject> problems, string pointer)
    {
        void Problem(string at, string code, string message, string fix) =>
            problems.Add(JobPreflight.Problem(null, at, code, "error", message, fix, null, "screen"));
        if (data.Count != 1) Problem(pointer, "GEN_SCREEN_INVALID", "screen: generate goes alone in data", "{\"generate\":{...}}");
        var g = data["generate"] as JsonObject ?? new JsonObject();
        var at = pointer + "/generate";
        Keys(g, "generate", at, Problem);
        var blocks = Text(g["blocks"]) ?? "auto";
        if (blocks is not ("auto" or "inline")) Problem(at + "/blocks", "GEN_SCREEN_INVALID", $"blocks '{blocks}': auto or inline", "\"blocks\":\"auto\"");
        var pageSize = 20;
        if (g["pageSize"] is JsonNode ps)
        {
            if (ps is JsonValue v && v.TryGetValue<int>(out var n) && n is > 0 and <= 500) pageSize = n;
            else Problem(at + "/pageSize", "GEN_SCREEN_INVALID", "pageSize: a whole number from 1 to 500", "\"pageSize\":20");
        }
        var lang = Text(g["texts"]) ?? "en";
        if (!Texts.ContainsKey(lang)) { Problem(at + "/texts", "GEN_SCREEN_INVALID", $"texts '{lang}': en or pt", "\"texts\":\"en\""); lang = "en"; }
        string? roles = null;
        if (g["roles"] is JsonArray ra) roles = string.Join(", ", ra.Select(r => r?.ToString()).Where(r => !string.IsNullOrWhiteSpace(r)));
        else if (g["roles"] is JsonValue rv && rv.TryGetValue<string>(out var rs)) roles = rs;
        var patterns = g["patterns"] is JsonValue pv && pv.TryGetValue<bool>(out var pb) && pb;
        var emit = g["emit"] is JsonValue ev && ev.TryGetValue<bool>(out var eb) && eb;
        var entities = new List<EntityRequest>();
        var list = g["entities"] as JsonArray;
        if (g["entities"] is JsonValue star && star.TryGetValue<string>(out var s) && s == "*") list = new JsonArray("*");
        if (list == null && !patterns) Problem(at + "/entities", "GEN_SCREEN_INVALID", "entities: the entities to generate screens for (names, or \"*\")", "\"entities\":[\"Customer\"]");
        var allScreens = new HashSet<string>(StringComparer.Ordinal) { "list", "detail", "form" };
        var screens = allScreens;
        if (g["screens"] is JsonArray sa)
        {
            screens = sa.Select(x => x?.ToString() ?? "").ToHashSet(StringComparer.Ordinal);
            foreach (var bad in screens.Where(x => !allScreens.Contains(x))) Problem(at + "/screens", "GEN_SCREEN_INVALID", $"screens: '{bad}' is not list, detail or form", "\"screens\":[\"list\",\"detail\",\"form\"]");
        }
        for (var i = 0; i < (list?.Count ?? 0); i++)
        {
            var e = list![i]; var ep = $"{at}/entities/{i}";
            if (e is JsonValue nv && nv.TryGetValue<string>(out var name))
            {
                if (name == "*")
                {
                    if (module == null) continue;
                    foreach (var own in module.Entities.Where(x => x.Producer == null && !x.Static).OrderBy(x => x.Name, StringComparer.Ordinal))
                        if (!entities.Any(x => x.Name.Equals(own.Name, StringComparison.OrdinalIgnoreCase)))
                            entities.Add(new(own.Name, screens, null, null, null, null, null, new(), ep, JsonValue.Create(own.Name)));
                    continue;
                }
                entities.Add(new(name, screens, null, null, null, null, null, new(), ep, JsonValue.Create(name)));
                continue;
            }
            if (e is not JsonObject eo) { Problem(ep, "GEN_SCREEN_INVALID", "an entity is its name or {name, ...}", "\"Customer\""); continue; }
            Keys(eo, "entity", ep, Problem);
            var en = Text(eo["name"]);
            if (string.IsNullOrWhiteSpace(en)) { Problem(ep + "/name", "GEN_SCREEN_INVALID", "entity: name is required", "{\"name\":\"Customer\"}"); continue; }
            var own2 = screens;
            if (eo["screens"] is JsonArray es)
            {
                own2 = es.Select(x => x?.ToString() ?? "").ToHashSet(StringComparer.Ordinal);
                foreach (var bad in own2.Where(x => !allScreens.Contains(x))) Problem(ep + "/screens", "GEN_SCREEN_INVALID", $"screens: '{bad}' is not list, detail or form", "[\"list\",\"detail\",\"form\"]");
            }
            var names = new Dictionary<string, string>(StringComparer.Ordinal);
            if (eo["names"] is JsonObject no)
            {
                Keys(no, "names", ep + "/names", Problem);
                foreach (var (k, v) in no) if (Text(v) is { } nn) { if (Ident(nn)) names[k] = nn; else Problem($"{ep}/names/{k}", "GEN_SCREEN_INVALID", $"'{nn}' is not a name", "letters, digits and _"); }
            }
            entities.Add(new(en!, own2, Strings(eo["columns"]), Strings(eo["search"]), Strings(eo["filters"]), Strings(eo["fields"]), Text(eo["title"]), names, ep, eo.DeepClone()));
        }
        return new(entities, blocks, pageSize, roles, Text(g["flow"]), Texts[lang], patterns, emit, lang);
    }

    private static void Keys(JsonObject o, string shape, string at, Action<string, string, string, string> problem)
    {
        foreach (var key in o.Select(p => p.Key).Where(k => !k.StartsWith('_')).Except(Shapes[shape], StringComparer.Ordinal))
            problem(at + "/" + key, "GEN_SCREEN_INVALID", $"generate {shape}: unknown key '{key}'; allowed: {string.Join(", ", Shapes[shape])}",
                Nearest(key, Shapes[shape]) is { } near ? $"\"{near}\"" : "remove it");
    }

    // ---- the plan -----------------------------------------------------------------------------------------------------------

    /// <summary>The plan of a request over a module: the roots to create and those that are already there as generated, with the
    /// receipt. Every problem of the request (unknown entity or attribute, a name taken) comes at once, as one refusal.</summary>
    public static GenPlan Plan(JsonObject data, GenModule module, string pointer = "/data")
    {
        var problems = new List<JsonObject>();
        var request = Parse(data, module, problems, pointer);
        void Problem(string at, string code, string message, string fix) =>
            problems.Add(JobPreflight.Problem(null, at, code, "error", message, fix, null, "screen"));
        if (module.Runtime is not ("Reactive" or "Mobile" or "Library"))
            Problem(pointer + "/generate", "GEN_SCREEN_RUNTIME", $"module {module.Name} is {module.Runtime}: screens are generated in Reactive and Mobile modules (blocks also in a library)",
                "run it on the Reactive, Mobile or library module");
        if (module.Runtime == "Library" && request.Entities.Count > 0)
            Problem(pointer + "/generate/entities", "GEN_SCREEN_RUNTIME", $"module {module.Name} is a library: it holds blocks, not screens",
                "patterns:true here (the reusable blocks), and the screens in the app that references it");
        var g = new Generator(module, request, Problem) { Raw = problems };
        g.Run();
        if (problems.Count > 0)
            throw new KernelRefusalException("GEN_SCREEN_REFUSED", "screen generate: " + string.Join(" | ", problems.Select(p => p["message"]!.ToString())),
                new JsonArray(problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
        return g.Result();
    }

    // ---- the generator ------------------------------------------------------------------------------------------------------
    private sealed class Generator(GenModule m, Request r, Action<string, string, string, string> problem)
    {
        internal readonly GenModule M = m;
        internal readonly Request R = r;
        internal readonly Action<string, string, string, string> Problem = problem;
        /// <summary>Problems with their patch (Plan adds them to the refusal).</summary>
        internal List<JsonObject> Raw = [];
        private readonly List<GenRoot> create = [], unchanged = [];
        private readonly JsonArray entityReports = [], blockReports = [], gaps = [];
        private readonly Dictionary<string, GenRootFact> existing = m.Roots.GroupBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(x => x.Key, x => x.First(), StringComparer.OrdinalIgnoreCase);
        // Every name a new module element must avoid: the top level, the roots, and the actions inside them (a server action
        // named as a screen action makes a call ambiguous).
        private readonly HashSet<string> taken = new(m.Names.Concat(m.Roots.Select(x => x.Name)).Concat(m.LocalActions ?? new HashSet<string>()), StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, string> T => r.T;
        private string flow = "MainFlow", roles = "", blockFlow = "MainFlow";
        private Layout? layout;
        private PagerUse? pager;
        private ConfirmUse? confirm;
        private FilterUse? filterBar;
        private HeaderUse? header;

        public GenPlan Result()
        {
            var receipt = new JsonObject
            {
                ["generator"] = Version, ["module"] = m.Name, ["lane"] = m.Lane, ["flow"] = flow, ["roles"] = roles,
                ["layout"] = layout == null ? null : new JsonObject { ["block"] = layout.Name, ["content"] = layout.Content, ["title"] = layout.Title, ["actions"] = layout.Actions },
                ["blocks"] = blockReports, ["entities"] = entityReports,
                ["create"] = new JsonArray(create.Select(x => (JsonNode)new JsonObject { ["kind"] = x.Kind, ["name"] = x.Name, ["role"] = x.Role, ["entity"] = x.Entity, ["bytes"] = x.Bytes, ["sha"] = x.Sha }).ToArray()),
                ["unchanged"] = new JsonArray(unchanged.Select(x => (JsonNode)new JsonObject { ["kind"] = x.Kind, ["name"] = x.Name, ["role"] = x.Role, ["entity"] = x.Entity, ["sha"] = x.Sha }).ToArray()),
                ["generatedBytes"] = create.Concat(unchanged).Sum(x => x.Bytes),
            };
            if (gaps.Count > 0) receipt["gaps"] = gaps;
            if (create.Count == 0) receipt["code"] = "NO_CHANGE";
            if (r.Emit) receipt["documents"] = new JsonArray(create.Concat(unchanged).Select(x => (JsonNode)new JsonObject { ["name"] = x.Name, ["html"] = x.Html, ["flow"] = new JsonArray(x.Flows.Select(f => (JsonNode)f).ToArray()) }).ToArray());
            return new(create, unchanged, receipt);
        }

        public void Run()
        {
            // The app's own screens: those not open to anonymous users (a login, an invalid-permissions page are the template's),
            // never the generator's own (they would vote for the flow, the roles and the layout of the next run: the roles the
            // platform stores for Registered in a module with roles of its own are every role, so the next run came out stale).
            var screens = m.Roots.Where(x => x.Kind == "screen" && !x.Anonymous && MarkerOf(x.Description) == null).ToList();
            // The UI flow: the request's, else MainFlow, else the one most app screens are in, else the first.
            flow = r.Flow ?? m.Flows.FirstOrDefault(f => f.Equals("MainFlow", StringComparison.OrdinalIgnoreCase))
                ?? screens.Where(x => x.Flow != null).GroupBy(x => x.Flow!, StringComparer.Ordinal).OrderByDescending(x => x.Count()).ThenBy(x => x.Key, StringComparer.Ordinal).Select(x => x.Key).FirstOrDefault()
                ?? m.Flows.FirstOrDefault() ?? "MainFlow";
            if (r.Flow != null && !m.Flows.Contains(r.Flow, StringComparer.OrdinalIgnoreCase))
                problem("/data/generate/flow", "GEN_SCREEN_INVALID", $"flow '{r.Flow}' is not a UI flow of {m.Name}; flows: {string.Join(", ", m.Flows)}", Nearest(r.Flow, m.Flows) is { } nf ? $"\"flow\":\"{nf}\"" : "leave it out");
            blockFlow = m.Flows.FirstOrDefault(f => f.Equals("Common", StringComparison.OrdinalIgnoreCase)) ?? flow;
            // The roles: the request's, else those most app screens have, else Registered (O11) / authenticated users (ODC).
            roles = r.Roles ?? screens.Where(x => !string.IsNullOrEmpty(x.Roles)).GroupBy(x => x.Roles!, StringComparer.Ordinal).OrderByDescending(x => x.Count()).ThenBy(x => x.Key, StringComparer.Ordinal).Select(x => x.Key).FirstOrDefault()
                ?? (m.Lane == "o11" ? m.Roles?.GetValueOrDefault("Registered") ?? "Registered" : "");
            if (m.Runtime != "Library") layout = FindLayout(screens);
            FindBlocks();
            if (r.Patterns || m.Runtime == "Library") { CreatePatternBlocks(all: true); return; }
            // Every requested entity, known before any screen is planned (a link names the screens of the others).
            var plans = new List<EntityPlan>();
            foreach (var request in r.Entities)
            {
                var entity = m.Entities.FirstOrDefault(e => e.Name.Equals(request.Name, StringComparison.OrdinalIgnoreCase) && !e.Static)
                    ?? m.Entities.FirstOrDefault(e => e.Name.Equals(request.Name, StringComparison.OrdinalIgnoreCase));
                if (entity == null)
                {
                    var near = Nearest(request.Name, m.Entities.Where(e => !e.Static).Select(e => e.Name));
                    problem(request.Pointer, "GEN_SCREEN_ENTITY_UNKNOWN", $"no entity '{request.Name}' in {m.Name} or its references" + (near != null ? $"; nearest: {near}" : ""),
                        near != null ? $"\"{near}\"" : "name an entity of the module (ssam_map view digest lists them), or add its reference first");
                    continue;
                }
                if (entity.Static)
                {
                    problem(request.Pointer, "GEN_SCREEN_ENTITY_STATIC", $"'{entity.Name}' is a static entity: its records are fixed in the model, there is nothing to list or edit at runtime",
                        "generate for the entities that reference it (it becomes their dropdown)");
                    continue;
                }
                plans.Add(new EntityPlan(this, entity, request));
            }
            if (plans.Count == 0) return;
            foreach (var plan in plans) plan.Decide();
            // A role the screens need and no block plays: created once here (auto), or plain markup (inline).
            CreatePatternBlocks(all: false, needPager: plans.Any(p => p.Has("list")), needConfirm: plans.Any(p => p.CanDelete && (p.Has("list") || p.Has("detail"))),
                needFilter: plans.Any(p => p.Has("list")), needHeader: layout?.Title == null);
            foreach (var plan in plans) plan.Emit(plans);
        }

        // ---- the layout and the blocks by their signature ----------------------------------------------------------------
        private sealed record Layout(string Name, string Reference, string Content, string? Title, string? Actions);
        private sealed record PagerUse(string Reference, string Start, string Max, string Total, string Event, string Param, string Source);
        private sealed record ConfirmUse(string Reference, string Show, string? Message, string? Title, string Confirm, string Cancel, string Source);
        private sealed record FilterUse(string Reference, string Search, string? Filters, string? Actions, string Source);
        private sealed record HeaderUse(string Reference, string Title, string? Actions, string Source);

        private Layout? FindLayout(List<GenRootFact> screens)
        {
            static string? Slot(GenBlock b, params string[] names) => names.Select(n => b.Placeholders.FirstOrDefault(p => p.Equals(n, StringComparison.OrdinalIgnoreCase))).FirstOrDefault(p => p != null);
            Layout? Of(GenBlock b) => Slot(b, "MainContent", "Content") is { } content ? new Layout(b.Name, b.Reference, content, Slot(b, "Title"), Slot(b, "Actions")) : null;
            // The layout most screens use, then LayoutTopMenu, Layout (mobile), LayoutSideMenu, then any block with a content slot.
            var used = screens.Where(x => x.Layout != null).GroupBy(x => x.Layout!, StringComparer.OrdinalIgnoreCase).OrderByDescending(x => x.Count()).ThenBy(x => x.Key, StringComparer.Ordinal).Select(x => x.Key);
            foreach (var name in used.Concat(m.Runtime == "Mobile" ? ["Layout", "LayoutTopMenu"] : ["LayoutTopMenu", "LayoutSideMenu", "Layout"]))
                if (m.Blocks.FirstOrDefault(b => b.Name.Equals(name, StringComparison.OrdinalIgnoreCase) || b.Reference.Equals(name, StringComparison.OrdinalIgnoreCase)) is { } block
                    && Of(block) is { } found && !block.Inputs.Any(i => i.Mandatory) && !block.Events.Any(e => e.Mandatory)) return found;
            foreach (var block in m.Blocks.OrderBy(b => b.Name, StringComparer.Ordinal))
                if (block.Name.StartsWith("Layout", StringComparison.OrdinalIgnoreCase) && Of(block) is { } any && !block.Inputs.Any(i => i.Mandatory) && !block.Events.Any(e => e.Mandatory)) return any;
            if (r.Entities.Count > 0 && !r.Patterns)
                problem("/data/generate", "GEN_SCREEN_NO_LAYOUT", $"{m.Name} has no layout block (a block with a MainContent or Content placeholder) for the screens",
                    "create the layout first (the module template has LayoutTopMenu), or reference one");
            return null;
        }

        private static bool Is(string name, params string[] words) => words.Any(w => name.Contains(w, StringComparison.OrdinalIgnoreCase));
        private static bool Integer(string type) => type is "Integer" or "Long Integer";

        private void FindBlocks()
        {
            foreach (var b in m.Blocks.OrderBy(b => b.Producer == null ? 0 : 1).ThenBy(b => b.Name, StringComparer.Ordinal))
            {
                if (b.Events.Count(e => e.Mandatory) > 0 && b.Events.Any(e => e.Mandatory && !Handled(b, e))) continue;
                var source = b.Producer == null ? "module" : "reference " + b.Producer;
                // pagination: a start, a page size and a total (integers), and an event with one integer.
                if (pager == null && b.Inputs.FirstOrDefault(i => Integer(i.Type) && Is(i.Name, "start", "offset", "inicio", "skip")) is { } start
                    && b.Inputs.FirstOrDefault(i => Integer(i.Type) && Is(i.Name, "max", "size", "limit", "records", "porpagina", "limite")) is { } max
                    && b.Inputs.FirstOrDefault(i => Integer(i.Type) && Is(i.Name, "total", "count")) is { } total
                    && b.Events.FirstOrDefault(e => e.Params.Count == 1 && Integer(e.Params[0].Type)) is { } nav
                    && b.Inputs.Where(i => i.Mandatory).All(i => i == start || i == max || i == total))
                    pager = new(b.Reference, start.Name, max.Name, total.Name, nav.Name, nav.Params[0].Name, source);
                // confirmation: a boolean that shows it, two events without parameters (confirm, cancel).
                if (confirm == null && b.Inputs.FirstOrDefault(i => i.Type == "Boolean" && Is(i.Name, "show", "open", "visible", "aberto", "mostrar")) is { } show
                    && b.Events.FirstOrDefault(e => e.Params.Count == 0 && Is(e.Name, "confirm", "ok", "yes", "sim", "confirma")) is { } ok
                    && b.Events.FirstOrDefault(e => e.Params.Count == 0 && Is(e.Name, "cancel", "close", "dismiss", "cancela", "fecha")) is { } no
                    && b.Inputs.Where(i => i.Mandatory).All(i => i == show || i.Type == "Text"))
                {
                    var message = b.Inputs.FirstOrDefault(i => i.Type == "Text" && Is(i.Name, "message", "text", "mensagem", "body"));
                    var title = b.Inputs.FirstOrDefault(i => i.Type == "Text" && Is(i.Name, "title", "titulo", "título", "header"));
                    if (b.Inputs.Where(i => i.Mandatory).All(i => i == show || i == message || i == title))
                        confirm = new(b.Reference, show.Name, message?.Name, title?.Name, ok.Name, no.Name, source);
                }
                // filter bar: a search slot and a filters slot, no mandatory input.
                if (filterBar == null && !b.Inputs.Any(i => i.Mandatory) && b.Events.Count(e => e.Mandatory) == 0
                    && b.Placeholders.FirstOrDefault(p => Is(p, "search", "busca", "pesquisa")) is { } search
                    && b.Placeholders.FirstOrDefault(p => Is(p, "filter", "filtro")) is { } filters)
                    filterBar = new(b.Reference, search, filters, b.Placeholders.FirstOrDefault(p => Is(p, "action", "acoes", "ações")), source);
                // page header: a title slot and an actions slot, no content slot (a layout is not a header).
                if (header == null && !b.Inputs.Any(i => i.Mandatory) && b.Events.Count(e => e.Mandatory) == 0
                    && !b.Placeholders.Any(p => p.Equals("MainContent", StringComparison.OrdinalIgnoreCase) || p.Equals("Content", StringComparison.OrdinalIgnoreCase))
                    && b.Placeholders.FirstOrDefault(p => Is(p, "title", "titulo")) is { } title2
                    && b.Placeholders.FirstOrDefault(p => Is(p, "action", "acoes")) is { } actions2 && Is(b.Name, "header", "cabecalho", "title"))
                    header = new(b.Reference, title2, actions2, source);
            }
        }

        // A mandatory event the generator can handle: the pagination's and the confirmation's are.
        private static bool Handled(GenBlock b, GenEvent e) => e.Params.Count <= 1;

        // ---- the reusable blocks (created once, then found by the signature above) ------------------------------------------
        private void CreatePatternBlocks(bool all, bool needPager = true, bool needConfirm = true, bool needFilter = true, bool needHeader = false)
        {
            void Report(string role, string? reference, string source, string? note = null)
            {
                var o = new JsonObject { ["role"] = role, ["block"] = reference, ["source"] = source };
                if (note != null) o["note"] = note;
                blockReports.Add(o);
            }
            var create = all || r.Blocks == "auto";
            if (needPager || all)
            {
                if (pager != null && !all) Report("pagination", pager.Reference, pager.Source);
                else if (create && Pattern("Pager", PagerBlock) is { } name) { pager = new("MobileBlock:" + name, "StartIndex", "MaxRecords", "TotalCount", "OnNavigate", "NewStartIndex", existing.ContainsKey(name) ? "generated" : "created"); Report("pagination", pager.Reference, pager.Source); }
                else if (!all) Report("pagination", null, "inline", "previous/next markup in each list (blocks:\"inline\")");
            }
            if (needConfirm || all)
            {
                if (confirm != null && !all) Report("confirmation", confirm.Reference, confirm.Source);
                else if (create && Pattern("ConfirmDialog", ConfirmBlock) is { } name) { confirm = new("MobileBlock:" + name, "IsOpen", "Message", "Title", "OnConfirm", "OnCancel", existing.ContainsKey(name) ? "generated" : "created"); Report("confirmation", confirm.Reference, confirm.Source); }
                else if (!all) Report("confirmation", null, "inline", "a popup in each screen (blocks:\"inline\")");
            }
            if (needFilter || all)
            {
                if (filterBar != null && !all) Report("filterBar", filterBar.Reference, filterBar.Source);
                else if (create && Pattern("FilterBar", FilterBlock) is { } name) { filterBar = new("MobileBlock:" + name, "Search", "Filters", "Actions", existing.ContainsKey(name) ? "generated" : "created"); Report("filterBar", filterBar.Reference, filterBar.Source); }
                else if (!all) Report("filterBar", null, "inline", "a container in each list (blocks:\"inline\")");
            }
            if (needHeader || all)
            {
                if (header != null && !all) Report("pageHeader", header.Reference, header.Source);
                else if (create && Pattern("PageHeader", HeaderBlock) is { } name) { header = new("MobileBlock:" + name, "Title", "Actions", existing.ContainsKey(name) ? "generated" : "created"); Report("pageHeader", header.Reference, header.Source); }
                else if (!all) Report("pageHeader", null, "inline", "a heading in each screen (blocks:\"inline\")");
            }
            else if (layout?.Title != null) Report("pageHeader", layout.Name, "layout", "the layout's Title and Actions placeholders");
        }

        /// <summary>A block of the pattern set: the free name (the base name, or base + n), unchanged when the module already has it
        /// with the same marker; a name taken by a block with another marker or none goes to the next one.</summary>
        private string? Pattern(string baseName, Func<string, (string Html, List<string> Flows)> build)
        {
            for (var n = 1; n < 20; n++)
            {
                var name = n == 1 ? baseName : baseName + n;
                var (html, flows) = build(name);
                var sha = Sha(html, flows);
                if (existing.TryGetValue(name, out var fact))
                {
                    if (fact.Kind == "block" && MarkerOf(fact.Description) == sha) { unchanged.Add(new("block", name, "pattern", null, Stamp(html, sha), flows, sha)); return name; }
                    continue;
                }
                if (taken.Contains(name)) continue;
                taken.Add(name);
                create.Add(new("block", name, "pattern", null, Stamp(html, sha), flows, sha));
                return name;
            }
            return null;
        }

        private (string, List<string>) PagerBlock(string name)
        {
            var h = new Html();
            h.Open("block", ("name", name), ("flow", blockFlow), ("description", $"Pagination of a list: the range shown, the total and previous/next. {Marker}"), ("actions", "PreviousOnClick, NextOnClick"));
            h.Leaf("input", ("name", "StartIndex"), ("type", "Integer"), ("mandatory", "True"), ("description", "The position of the first record of the page shown (0 is the first)."));
            h.Leaf("input", ("name", "MaxRecords"), ("type", "Integer"), ("mandatory", "True"), ("description", "How many records a page shows."));
            h.Leaf("input", ("name", "TotalCount"), ("type", "Integer"), ("mandatory", "True"), ("description", "How many records the list has, every page together."));
            h.Open("event", ("name", "OnNavigate"), ("description", "Asks the screen for another page."));
            h.Leaf("input", ("name", "NewStartIndex"), ("type", "Integer"), ("mandatory", "True"), ("description", "The position of the first record of the page asked for."));
            h.Close("event");
            h.Open("div", ("class", "pagination display-flex align-items-center justify-content-space-between margin-top-base"));
            h.Line("div", $"{{{{ If(TotalCount = 0, \"0\", IntegerToText(StartIndex + 1) + \"-\" + IntegerToText(Min(StartIndex + MaxRecords, TotalCount))) + {Q(T["of"])} + IntegerToText(TotalCount) }}}}", ("class", "pagination-counter"));
            h.Open("div", ("class", "pagination-container display-flex"));
            h.Line("button", T["previous"], ("class", "btn pagination-button"), ("enabled", "StartIndex > 0"), ("onclick", "PreviousOnClick"));
            h.Line("button", T["next"], ("class", "btn pagination-button"), ("enabled", "StartIndex + MaxRecords < TotalCount"), ("onclick", "NextOnClick"));
            h.Close("div"); h.Close("div"); h.Close("block");
            var flows = new List<string>
            {
                $"/// Asks for the page before this one.\naction {name}.PreviousOnClick\n  /// The page before this one.\n  trigger OnNavigate(NewStartIndex=Max(0, StartIndex - MaxRecords))\n  end\n",
                $"/// Asks for the page after this one.\naction {name}.NextOnClick\n  /// The page after this one.\n  trigger OnNavigate(NewStartIndex=StartIndex + MaxRecords)\n  end\n",
            };
            return (h.ToString(), flows);
        }

        private (string, List<string>) ConfirmBlock(string name)
        {
            var h = new Html();
            h.Open("block", ("name", name), ("flow", blockFlow), ("description", $"A confirmation popup: a title, a message, confirm and cancel. {Marker}"), ("actions", "ConfirmOnClick, CancelOnClick"));
            h.Leaf("input", ("name", "IsOpen"), ("type", "Boolean"), ("mandatory", "True"), ("description", "True while the confirmation is shown."));
            h.Leaf("input", ("name", "Title"), ("type", "Text"), ("default", Q(T["confirmTitle"])), ("description", "The title of the confirmation."));
            h.Leaf("input", ("name", "Message"), ("type", "Text"), ("mandatory", "True"), ("description", "What the person confirms."));
            h.Leaf("input", ("name", "ConfirmLabel"), ("type", "Text"), ("default", Q(T["confirm"])), ("description", "The label of the button that confirms."));
            h.Leaf("event", ("name", "OnConfirm"), ("description", "The person confirmed."));
            h.Leaf("event", ("name", "OnCancel"), ("description", "The person gave up."));
            h.Open("popup", ("show", "IsOpen"));
            h.Open("div", ("class", "padding-base"));
            h.Line("h4", "{{ Title }}", ("class", "margin-top-none"));
            h.Line("p", "{{ Message }}");
            h.Open("div", ("class", "display-flex justify-content-flex-end margin-top-base"));
            h.Line("button", T["cancel"], ("class", "btn margin-right-s"), ("onclick", "CancelOnClick"));
            h.Line("button", "{{ ConfirmLabel }}", ("class", "btn btn-primary"), ("onclick", "ConfirmOnClick"));
            h.Close("div"); h.Close("div"); h.Close("popup"); h.Close("block");
            var flows = new List<string>
            {
                $"/// Tells the screen the person confirmed.\naction {name}.ConfirmOnClick\n  /// The person confirmed.\n  trigger OnConfirm()\n  end\n",
                $"/// Tells the screen the person gave up.\naction {name}.CancelOnClick\n  /// The person gave up.\n  trigger OnCancel()\n  end\n",
            };
            return (h.ToString(), flows);
        }

        private (string, List<string>) FilterBlock(string name)
        {
            var h = new Html();
            h.Open("block", ("name", name), ("flow", blockFlow), ("description", $"The filter bar of a list: a search, its filters and its actions, in one row. {Marker}"));
            h.Open("div", ("class", "display-flex align-items-center flex-wrap margin-bottom-base"));
            h.Leaf("placeholder", ("name", "Search"), ("class", "flex1 margin-right-s"));
            h.Leaf("placeholder", ("name", "Filters"), ("class", "display-flex align-items-center margin-right-s"));
            h.Leaf("placeholder", ("name", "Actions"), ("class", "display-flex align-items-center"));
            h.Close("div"); h.Close("block");
            return (h.ToString(), []);
        }

        private (string, List<string>) HeaderBlock(string name)
        {
            var h = new Html();
            h.Open("block", ("name", name), ("flow", blockFlow), ("description", $"The header of a page: its title and its actions, in one row. {Marker}"));
            h.Open("div", ("class", "display-flex align-items-center justify-content-space-between margin-bottom-m"));
            h.Leaf("placeholder", ("name", "Title"), ("class", "heading4"));
            h.Leaf("placeholder", ("name", "Actions"), ("class", "display-flex align-items-center"));
            h.Close("div"); h.Close("block");
            return (h.ToString(), []);
        }

        // ---- one entity --------------------------------------------------------------------------------------------------
        private sealed class EntityPlan(Generator g, GenEntity e, EntityRequest q)
        {
            private readonly JsonObject report = new() { ["entity"] = e.Name };
            private readonly JsonArray notes = [];
            public string ListName = "", DetailName = "", FormName = "";
            private HashSet<string> want = q.Screens;
            public bool CanDelete;
            private string? saveCall, deleteCall, readListAction, readOneAction, saveInput, saveIdOut, deleteInput;
            private GenAction? listAction, oneAction, saveAction, deleteAction;
            private List<GenAttribute> columns = [], fields = [], search = [], filters = [], shown = [];
            private GenAttribute? label;
            private string Title => q.Title ?? e.Label ?? Words(e.Name);
            private string IdInput => e.Name + "Id";
            // The empty identifier of an entity: NullTextIdentifier() when its identifier is a Text (or references one), else
            // NullIdentifier() (an Integer Identifier the Verify flags against a Text one).
            private string NullOf(GenEntity? x)
            {
                for (var depth = 0; x != null && depth < 4; depth++)
                {
                    var id = x.Attributes.FirstOrDefault(a => a.Name.Equals(x.IdName, StringComparison.OrdinalIgnoreCase));
                    if (id == null) break;
                    if (id.Type == "Text") return "NullTextIdentifier()";
                    if (id.Target == null) break;
                    x = g.M.Entities.FirstOrDefault(t => t.Name.Equals(id.Target, StringComparison.OrdinalIgnoreCase));
                }
                return "NullIdentifier()";
            }
            // A name of the screen's data (aggregate, data action) that no module element has (a server action GetCustomerList would
            // take a refresh of the screen's GetCustomerList): the first, else the second. Only module names decide, so the same
            // module gives the same name again.
            private string Data(string first, string second) => g.M.Names.Contains(first) ? second : first;
            // The page size: a literal (a local never assigned would be a constant, rule E3).
            private string Size => g.R.PageSize.ToString();

            public bool Has(string screen) => want.Contains(screen);

            private GenAttribute? Attr(string name) => e.Attributes.FirstOrDefault(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

            private List<GenAttribute> Pick(List<string>? names, string what, Func<GenAttribute, bool> fits, IEnumerable<GenAttribute> defaults)
            {
                if (names == null) return defaults.ToList();
                var picked = new List<GenAttribute>();
                foreach (var n in names)
                {
                    if (Attr(n) is not { } a)
                    {
                        var near = Nearest(n, e.Attributes.Select(x => x.Name));
                        g.Problem(q.Pointer + "/" + what, "GEN_SCREEN_ATTRIBUTE_UNKNOWN", $"{e.Name} has no attribute '{n}'" + (near != null ? $"; nearest: {near}" : ""), near != null ? $"\"{near}\"" : "name an attribute of " + e.Name);
                        continue;
                    }
                    if (!fits(a)) { g.Problem(q.Pointer + "/" + what, "GEN_SCREEN_ATTRIBUTE_KIND", $"{e.Name}.{a.Name} ({a.Type}) cannot be one of the {what}", what == "search" ? "a Text attribute" : "a reference to a static or an entity"); continue; }
                    picked.Add(a);
                }
                return picked;
            }

            private bool Shown(GenAttribute a) => !a.Name.Equals(e.IdName, StringComparison.OrdinalIgnoreCase) && a.Type is not ("Binary Data" or "Object") && !a.Type.EndsWith(" List", StringComparison.Ordinal)
                && !(a.Type == "Text" && a.Length > 2000);
            // The identifier is a field only when the platform does not number it (a Text id, an id that references another entity).
            private GenAttribute? IdAttribute => e.Attributes.FirstOrDefault(a => a.Name.Equals(e.IdName, StringComparison.OrdinalIgnoreCase));
            private bool IdIsField => IdAttribute is { AutoNumber: false, Target: null };
            // An identifier that references another entity (an extension of it, one to one): a new record needs that entity's
            // identifier, which the form cannot pick (its value is of the other type); the form edits the existing ones.
            private bool IdIsReference => IdAttribute is { Target: not null };
            private bool CanCreate => Has("form") && !IdIsReference;
            private bool Editable(GenAttribute a) => (!a.Name.Equals(e.IdName, StringComparison.OrdinalIgnoreCase) || IdIsField) && !a.AutoNumber && a.Type is not ("Binary Data" or "Object") && !a.Type.EndsWith(" List", StringComparison.Ordinal)
                && Kind(a) != null;
            private GenEntity? TargetOf(GenAttribute a) => a.Target == null ? null : g.M.Entities.FirstOrDefault(x => x.Name.Equals(a.Target, StringComparison.OrdinalIgnoreCase));

            /// <summary>Which screens, columns, fields, filters, and how the data is read and written.</summary>
            public void Decide()
            {
                ListName = q.Names.GetValueOrDefault("list") ?? e.Name + "List";
                DetailName = q.Names.GetValueOrDefault("detail") ?? e.Name + "Detail";
                FormName = q.Names.GetValueOrDefault("form") ?? e.Name + "Edit";
                label = (e.LabelAttribute != null ? Attr(e.LabelAttribute) : null)
                    ?? e.Attributes.FirstOrDefault(a => a.Type == "Text" && Is(a.Name, "name", "nome", "title", "titulo", "título", "label", "description", "descricao"))
                    ?? e.Attributes.FirstOrDefault(a => a.Type == "Text" && a.Length is > 0 and <= 500);
                shown = e.Attributes.Where(Shown).ToList();
                // List columns: the label first, then the others in model order, at most 6.
                columns = Pick(q.Columns, "columns", Shown, (label != null ? new[] { label } : []).Concat(shown.Where(a => a != label)).Take(6));
                search = Pick(q.Search, "search", a => a.Type is "Text" or "Email" or "Phone Number", (label != null ? new[] { label } : []).Concat(shown.Where(a => a != label && a.Type is "Text" or "Email" && a.Length is > 0 and <= 500)).Take(3));
                filters = Pick(q.Filters, "filters", a => TargetOf(a) is { } t && TargetLabel(t) != null, shown.Where(a => TargetOf(a) is { Static: true } t && TargetLabel(t) != null).Take(2));
                fields = Pick(q.Fields, "fields", Editable, e.Attributes.Where(Editable));

                // Reads: a module action by its signature, else an aggregate of the entity.
                listAction = FindListAction();
                oneAction = FindOneAction();
                if (listAction != null)
                {
                    readListAction = Call(listAction); notes.Add($"list reads {readListAction}");
                    // The action filters what it filters: a dropdown or a search the action does not take would show and do nothing.
                    filters = [];
                    if (!listAction.Inputs.Any(i => PagingRole(i) == "search")) search = [];
                }
                if (oneAction != null) { readOneAction = Call(oneAction); notes.Add($"detail and form read {readOneAction}"); }
                // Writes: a save action and a delete action found by their signature. Without one, when the entity's own actions are
                // callable here, a server action around them (Save<E>, Remove<E>) is created once: a screen never writes the
                // database from the client (the Studio's security warning, which blocks a delivery).
                saveAction = FindSaveAction();
                deleteAction = FindDeleteAction();
                if (saveAction != null) { saveCall = Call(saveAction); saveInput = saveAction.Inputs.Single(i => i.Mandatory).Name; saveIdOut = saveAction.Outputs.FirstOrDefault(o => o.Type == e.IdType)?.Name; }
                else if (e.Writable && want.Contains("form")) { saveCall = Wrapper("Save" + e.Name, "save", SaveWrapper); saveInput = "Source"; saveIdOut = "Id"; }
                if (deleteAction != null) { deleteCall = Call(deleteAction); deleteInput = deleteAction.Inputs.Single(i => i.Mandatory).Name; }
                else if (e.Writable && (want.Contains("list") || want.Contains("detail"))) { deleteCall = Wrapper("Remove" + e.Name, "delete", DeleteWrapper); deleteInput = "Id"; }
                CanDelete = deleteCall != null;
                if (saveCall == null && want.Contains("form"))
                {
                    want = want.Where(s => s != "form").ToHashSet(StringComparer.Ordinal);
                    g.gaps.Add(new JsonObject { ["entity"] = e.Name, ["screen"] = "form", ["code"] = "GEN_SCREEN_NO_WRITE",
                        ["why"] = $"{e.Name} is read-only here ({(e.Producer != null ? "exposed read-only by " + e.Producer : "no entity actions")}) and no action of the module or its references saves it (one mandatory input of type {e.Name}, a save verb in its name)",
                        ["fix"] = $"expose a save action (Save{e.Name}(Source: {e.Name}) -> Id) in {e.Producer ?? "the producer"}, reference it, and generate again: the form comes then" });
                }
                if (IdIsReference && want.Contains("form"))
                    g.gaps.Add(new JsonObject { ["entity"] = e.Name, ["screen"] = "form", ["code"] = "GEN_SCREEN_ID_REFERENCE",
                        ["why"] = $"the identifier of {e.Name} references {IdAttribute!.Target}: a new {e.Name} needs that identifier, which the form does not pick; the form edits the existing ones, the list has no New",
                        ["fix"] = $"create the {e.Name} where its {IdAttribute.Target} is created (a server action), then edit it here" });
                if (!CanDelete)
                    g.gaps.Add(new JsonObject { ["entity"] = e.Name, ["screen"] = "list/detail", ["code"] = "GEN_SCREEN_NO_DELETE",
                        ["why"] = $"no delete for {e.Name} (read-only, and no action deletes it by its identifier)", ["fix"] = $"expose a delete action (Remove{e.Name}(Id: {e.IdType})) in {e.Producer ?? "the producer"}, reference it, and generate again; until then the screens show no delete" });
                // A screen name taken by what was not generated: refused, with the patch that names the free one (every taken
                // name of the entity in one patch, the same in each of its problems).
                var renames = new SortedDictionary<string, string>(StringComparer.Ordinal);
                var taken = new List<string>();
                foreach (var screen in want)
                {
                    var name = screen == "list" ? ListName : screen == "detail" ? DetailName : FormName;
                    if (g.existing.TryGetValue(name, out var fact) && MarkerOf(fact.Description) == null)
                        taken.Add($"{fact.Kind} '{name}' exists and was not generated (no {Marker} marker): the {screen} screen of {e.Name} needs another name");
                    else if (!g.existing.ContainsKey(name) && g.taken.Contains(name))
                        taken.Add($"'{name}' is the name of another element of {g.M.Name}: the {screen} screen of {e.Name} needs another name");
                    else continue;
                    renames[screen] = FreeName(name);
                }
                if (renames.Count > 0)
                {
                    var value = q.Original is JsonObject original ? original.DeepClone().AsObject() : new JsonObject { ["name"] = e.Name };
                    var names = value["names"] as JsonObject ?? new JsonObject();
                    foreach (var (screen, free) in renames) names[screen] = free;
                    value["names"] = names;
                    var patch = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = q.Pointer, ["value"] = value });
                    foreach (var message in taken)
                        g.Raw.Add(JobPreflight.Problem(null, q.Pointer, "GEN_SCREEN_NAME_TAKEN", "error", message, "name the screen: " + value.ToJsonString() + " (the patch)", (JsonArray)patch.DeepClone(), "screen"));
                }
            }

            private string FreeName(string name) { for (var i = 2; ; i++) if (!g.taken.Contains(name + i)) return name + i; }

            /// <summary>A server action of the module around the entity's own action (created once; a next run finds it by its
            /// signature): the free name, its text with the marker.</summary>
            private string Wrapper(string baseName, string role, Func<string, string> text)
            {
                var name = g.taken.Contains(baseName) ? FreeName(baseName) : baseName;
                g.taken.Add(name);
                var flow = text(name);
                var sha = Sha("", [flow]);
                g.create.Add(new GenRoot("action", name, role, e.Name, "", [flow.Replace(Marker + "\n", Marker + " " + sha + "\n", StringComparison.Ordinal)], sha));
                notes.Add($"{role} through the new server action {name} (no action of the module {role}s {e.Name})");
                return name;
            }

            private string SaveWrapper(string name) =>
                $"/// Saves one {e.Name} through its entity action: the generated screens write the database through a server action, never from the client. {Marker}\n"
                + $"server action {name}\n  /// The {e.Name} to create (empty identifier) or to update.\n  in Source: {e.Name}\n  /// The identifier of the {e.Name} saved.\n  out Id: {e.IdType}\n  Result = {Producer("CreateOrUpdate" + e.Name)}(Source=Source)\n  assign Id = Result.Id  # Return the saved identifier\n  end\n";

            private string DeleteWrapper(string name) =>
                $"/// Deletes one {e.Name} by its identifier through its entity action: the generated screens write the database through a server action, never from the client. {Marker}\n"
                + $"server action {name}\n  /// The identifier of the {e.Name} to delete.\n  in Id: {e.IdType}\n  {Producer("Delete" + e.Name)}(Id=Id)\n  end\n";
            private string Producer(string action) => e.Producer == null ? action : e.Producer + "." + action;
            private static string Call(GenAction a) => a.Producer == null ? a.Name : a.Producer + "." + a.Name;
            private bool Names(GenAction a, params string[] verbs) => verbs.Any(v => a.Name.Contains(v, StringComparison.OrdinalIgnoreCase));
            private bool NamesEntity(GenAction a) => a.Name.Contains(e.Name, StringComparison.OrdinalIgnoreCase);
            private IEnumerable<GenAction> Ranked(IEnumerable<GenAction> candidates) => candidates.OrderByDescending(NamesEntity).ThenBy(a => a.Producer == null ? 0 : 1).ThenBy(a => a.Name, StringComparer.Ordinal);

            // A list of the entity: one output E List, every mandatory input a paging integer or a search text; a total output.
            private GenAction? FindListAction()
            {
                var found = Ranked(g.M.Actions.Where(a => a.Outputs.Count(o => o.Type == e.Name + " List") == 1
                    && a.Inputs.Where(i => i.Mandatory).All(i => PagingRole(i) != null)
                    && a.Inputs.Count(i => PagingRole(i) == "start") == 1 && a.Inputs.Count(i => PagingRole(i) == "max") == 1
                    && a.Outputs.Any(o => Integer(o.Type) && Is(o.Name, "count", "total"))
                    && Names(a, "get", "list", "search", "fetch", "listar", "obter", "buscar", "consultar"))).ToList();
                return found.FirstOrDefault();
            }
            private static string? PagingRole(GenParam p) =>
                Integer(p.Type) && Is(p.Name, "start", "offset", "inicio", "skip") ? "start"
                : Integer(p.Type) && Is(p.Name, "max", "size", "limit", "limite", "records", "porpagina") ? "max"
                : p.Type == "Text" && Is(p.Name, "search", "keyword", "filter", "busca", "texto", "termo") ? "search" : null;

            // One record by its identifier: one mandatory input E Identifier, one output E.
            private GenAction? FindOneAction() => Ranked(g.M.Actions.Where(a => a.Inputs.Count(i => i.Mandatory) == 1 && a.Inputs.Single(i => i.Mandatory).Type == e.IdType
                && a.Outputs.Count(o => o.Type == e.Name) == 1 && Names(a, "get", "obter", "read", "ler", "fetch", "byid", "detail", "detalhe"))).FirstOrDefault();

            // Save: one mandatory input that is the record E; nothing else mandatory.
            private GenAction? FindSaveAction() => Ranked(g.M.Actions.Where(a => a.Inputs.Count(i => i.Mandatory) == 1 && a.Inputs.Single(i => i.Mandatory).Type == e.Name
                && Names(a, "save", "createorupdate", "upsert", "salvar", "gravar", "store"))).FirstOrDefault();

            // Delete: one mandatory input E Identifier, no record or list output, a delete verb in its name.
            private GenAction? FindDeleteAction() => Ranked(g.M.Actions.Where(a => a.Inputs.Count(i => i.Mandatory) == 1 && a.Inputs.Single(i => i.Mandatory).Type == e.IdType
                && !a.Outputs.Any(o => o.Type == e.Name || o.Type.EndsWith(" List", StringComparison.Ordinal))
                && Names(a, "delete", "remove", "excluir", "remover", "apagar"))).FirstOrDefault();

            // ---- the documents ------------------------------------------------------------------------------------------
            public void Emit(List<EntityPlan> all)
            {
                var screens = new JsonObject();
                if (Has("list")) screens["list"] = Root("list", ListName, ListScreen());
                if (Has("detail")) screens["detail"] = Root("detail", DetailName, DetailScreen());
                if (Has("form")) screens["form"] = Root("form", FormName, FormScreen());
                report["screens"] = screens;
                report["read"] = new JsonObject { ["list"] = readListAction ?? "aggregate", ["record"] = readOneAction ?? "aggregate" };
                report["write"] = new JsonObject { ["save"] = saveCall, ["delete"] = deleteCall };
                report["columns"] = new JsonArray(columns.Select(c => (JsonNode)c.Name).ToArray());
                report["search"] = new JsonArray(search.Select(c => (JsonNode)c.Name).ToArray());
                report["filters"] = new JsonArray(filters.Select(c => (JsonNode)c.Name).ToArray());
                report["fields"] = new JsonArray(fields.Select(c => (JsonNode)c.Name).ToArray());
                if (notes.Count > 0) report["notes"] = notes;
                g.entityReports.Add(report);
            }

            private string Root(string role, string name, (string Html, List<string> Flows) built)
            {
                var sha = Sha(built.Html, built.Flows);
                var root = new GenRoot("screen", name, role, e.Name, Stamp(built.Html, sha), built.Flows, sha);
                if (g.existing.TryGetValue(name, out var fact) && MarkerOf(fact.Description) is { } was)
                {
                    if (was == sha) { g.unchanged.Add(root); return "unchanged"; }
                    g.gaps.Add(new JsonObject { ["entity"] = e.Name, ["screen"] = role, ["name"] = name, ["code"] = "GEN_SCREEN_STALE",
                        ["why"] = $"{name} was generated from another model or request (marker {was}, now {sha}) or edited after: it is kept as it is",
                        ["fix"] = "delete it and generate again to take the new one, or edit it through its reading (ssam_map view html)" });
                    return "kept";
                }
                g.taken.Add(name);
                g.create.Add(root);
                return "create";
            }

            private string Row(string list) => readListAction != null ? $"{list}.Current" : $"{list}.Current.{e.Name}";
            private string RefLabel(GenAttribute a, string row, bool joined)
            {
                var t = TargetOf(a);
                if (t == null) return $"{row}.{a.Name}";
                var tl = TargetLabel(t);
                return joined && tl != null ? $"{row[..row.LastIndexOf('.')]}.{t.Name}.{tl}" : $"{row}.{a.Name}";
            }
            private static string? TargetLabel(GenEntity t) => t.Static ? (t.LabelAttribute ?? (t.Attributes.Any(x => x.Name == "Label") ? "Label" : null))
                : t.LabelAttribute ?? t.Attributes.FirstOrDefault(x => x.Type == "Text" && Is(x.Name, "name", "nome", "title", "titulo", "label"))?.Name ?? t.Attributes.FirstOrDefault(x => x.Type == "Text")?.Name;

            // The references of the entity a list or a detail joins to show the target's label: one per target entity, at most 4.
            private List<(GenAttribute A, GenEntity T)> Joins(IEnumerable<GenAttribute> over)
            {
                var joins = new List<(GenAttribute, GenEntity)>();
                foreach (var a in over)
                    if (TargetOf(a) is { } t && TargetLabel(t) != null && !t.Name.Equals(e.Name, StringComparison.OrdinalIgnoreCase)
                        && !joins.Any(j => j.Item2.Name.Equals(t.Name, StringComparison.OrdinalIgnoreCase)) && joins.Count < 4) joins.Add((a, t));
                return joins;
            }

            private string Display(GenAttribute a, string value)
            {
                if (a.Type == "Boolean") return $"If({value}, {Q(g.T["yes"])}, {Q(g.T["no"])})";
                return value;
            }

            private void Aggregate(Html h, string name, string? where, List<(GenAttribute A, GenEntity T)> joins, string? max, string? start, string? sort, bool dynamicSort, IEnumerable<string> filtersExtra)
            {
                var what = max == "1" ? $"The {e.Name} the screen shows" : $"The page of {e.Name} records the list shows";
                var also = joins.Count > 0 ? ", with the label of " + string.Join(", ", joins.Select(j => j.T.Name)) : "";
                h.Open("aggregate", ("name", name), ("max", max), ("os-StartIndex", start), ("description", what + also + "."));
                h.Open("os-CombineSourcesOperation");
                h.Leaf("os-AliasedSource", ("name", e.Name), ("os-Source", Source(e)));
                foreach (var (a, t) in joins) h.Leaf("os-AliasedSource", ("name", t.Name), ("os-Source", Source(t)));
                foreach (var (a, t) in joins)
                    h.Leaf("os-Join", ("os-Condition", $"{e.Name}.{a.Name} = {t.Name}.{t.IdName}"), ("os-LeftSource", "AliasedSource:" + e.Name), ("os-RightSource", "AliasedSource:" + t.Name));
                if (where != null) h.Leaf("os-Filter", ("os-Condition", where));
                foreach (var f in filtersExtra) h.Leaf("os-Filter", ("os-Condition", f));
                if (sort != null) h.Leaf("os-Sort", ("os-Attribute", sort), ("os-IsDynamic", dynamicSort ? "True" : null));
                h.Close("os-CombineSourcesOperation");
                h.Close("aggregate");
            }
            private string Source(GenEntity x) => (x.Static ? "StaticEntity" : "ServerEntity") + (x.Producer == null ? "" : "Signature") + ":" + x.Name;

            private void OptionsAggregate(Html h, GenEntity t)
            {
                var order = t.OrderAttribute ?? (t.Static && t.Attributes.Any(x => x.Name == "Order") ? "Order" : TargetLabel(t));
                h.Open("aggregate", ("name", Data($"Get{t.Name}Options", $"{t.Name}Options")), ("max", "500"), ("description", $"The {t.Name} records a dropdown offers."));
                h.Open("os-CombineSourcesOperation");
                h.Leaf("os-AliasedSource", ("name", t.Name), ("os-Source", Source(t)));
                if (order != null) h.Leaf("os-Sort", ("os-Attribute", $"{t.Name}.{order}"));
                h.Close("os-CombineSourcesOperation");
                h.Close("aggregate");
            }

            private void Open(Html h, string name, string title, string actions, string? dataActions, string roleText)
            {
                h.Open("screen", ("name", name), ("flow", g.flow), ("title", Q(title)), ("roles", g.roles.Length > 0 ? g.roles : null),
                    ("description", $"{roleText} of {e.Name}, generated from the data model by SSAM (screens from entities). {Marker}"),
                    ("actions", actions.Length > 0 ? actions : null), ("data-actions", dataActions));
            }

            // The page around the content: the layout's title and actions slots, else the header block, else a heading.
            private void Page(Html h, string titleExpression, Action actions, Action content)
            {
                var l = g.layout!;
                h.Open("Block", ("name", l.Reference));
                if (l.Title != null)
                {
                    h.Open("slot", ("name", l.Title)); h.Text(titleExpression); h.Close("slot");
                    if (l.Actions != null) { h.Open("slot", ("name", l.Actions)); actions(); h.Close("slot"); }
                }
                h.Open("slot", ("name", l.Content));
                if (l.Title == null)
                {
                    if (g.header != null)
                    {
                        h.Open("Block", ("name", g.header.Reference));
                        h.Open("slot", ("name", g.header.Title)); h.Text(titleExpression); h.Close("slot");
                        if (g.header.Actions != null) { h.Open("slot", ("name", g.header.Actions)); actions(); h.Close("slot"); }
                        h.Close("Block");
                    }
                    else
                    {
                        h.Open("div", ("class", "display-flex align-items-center justify-content-space-between margin-bottom-m"));
                        h.Line("h1", titleExpression, ("class", "heading4"));
                        h.Open("div", ("class", "display-flex align-items-center")); actions(); h.Close("div");
                        h.Close("div");
                    }
                }
                else if (l.Actions == null) { h.Open("div", ("class", "display-flex justify-content-flex-end margin-bottom-base")); actions(); h.Close("div"); }
                content();
                h.Close("slot");
                h.Close("Block");
            }

            private void Confirm(Html h, string show)
            {
                if (g.confirm is { } c)
                {
                    var args = new List<(string, string?)> { ("name", c.Reference), (":" + c.Show, show) };
                    if (c.Message != null) args.Add((":" + c.Message, Q(g.T["confirmDelete"])));
                    if (c.Title != null) args.Add((":" + c.Title, Q(g.T["confirmTitle"])));
                    args.Add(("@" + c.Confirm, "DeleteConfirmOnClick"));
                    args.Add(("@" + c.Cancel, "DeleteCancelOnClick"));
                    h.Leaf("Block", args.ToArray());
                    return;
                }
                h.Open("popup", ("show", show));
                h.Open("div", ("class", "padding-base"));
                h.Line("p", g.T["confirmDelete"]);
                h.Open("div", ("class", "display-flex justify-content-flex-end margin-top-base"));
                h.Line("button", g.T["cancel"], ("class", "btn margin-right-s"), ("onclick", "DeleteCancelOnClick"));
                h.Line("button", g.T["delete"], ("class", "btn btn-primary"), ("onclick", "DeleteConfirmOnClick"));
                h.Close("div"); h.Close("div"); h.Close("popup");
            }

            private string DeleteFlows(string owner, string idVar, string after)
            {
                var call = $"{deleteCall}({deleteInput}={idVar})";
                return $"/// Deletes the {e.Name} the person confirmed.\naction {owner}.DeleteConfirmOnClick\n  assign IsDeleteConfirmOpen = False  # Close the confirmation\n  {call}\n{after}";
            }

            private (string, List<string>) ListScreen()
            {
                var h = new Html();
                var flows = new List<string>();
                var list = Data($"Get{e.Name}List", $"{e.Name}ListData");
                // An aggregate or a data action of the same name: both give List and the fetch state.
                var data = list;
                var listExpr = $"{list}.List";
                var row = Row(listExpr);
                var joins = readListAction != null ? new List<(GenAttribute A, GenEntity T)>() : Joins(columns);
                var sortable = readListAction == null;
                var defaultSort = label != null ? $"{{{e.Name}}}.[{label.Name}]" : $"{{{e.Name}}}.[{e.IdName}]";
                // Every link to another screen is a screen action of this one (navigate in its flow): the documents never name
                // each other, so they compile in any order and the flows, after all of them, find every screen.
                // The filter bar only when there is something to filter by (a text attribute to search, a reference to pick).
                var hasSearch = search.Count > 0;
                var hasBar = hasSearch || filters.Count > 0;
                var actions = new List<string>();
                if (hasBar) actions.AddRange(["SearchOnChange", "ClearFiltersOnClick"]);
                if (sortable) actions.Add("SortOnClick");
                actions.Add("PaginationOnNavigate");
                if (CanCreate) actions.Add("NewOnClick");
                if (Has("form")) actions.Add("EditOnClick");
                if (Has("detail")) actions.Add("ViewOnClick");
                if (CanDelete) actions.AddRange(["DeleteOnClick", "DeleteConfirmOnClick", "DeleteCancelOnClick"]);
                Open(h, ListName, Plural(Title), string.Join(", ", actions), readListAction != null ? list : null, "The list");
                if (hasSearch) h.Leaf("var", ("name", "SearchKeyword"), ("type", "Text"), ("description", "The text the list searches for (empty: every record)."));
                foreach (var f in filters) h.Leaf("var", ("name", "Filter" + f.Name), ("type", f.Type), ("description", $"The {Words(StripId(f.Name))} the list shows (empty: all)."));
                h.Leaf("var", ("name", "StartIndex"), ("type", "Integer"), ("default", "0"), ("description", "The position of the first record of the page shown."));
                if (sortable) h.Leaf("var", ("name", "SortColumn"), ("type", "Text"), ("default", Q(defaultSort)), ("description", "The column the list is sorted by, with DESC for the reverse order."));
                if (CanDelete)
                {
                    h.Leaf("var", ("name", "DeleteId"), ("type", e.IdType), ("description", $"The {e.Name} the person asked to delete."));
                    h.Leaf("var", ("name", "IsDeleteConfirmOpen"), ("type", "Boolean"), ("default", "False"), ("description", "True while the delete confirmation is shown."));
                }
                string Like(GenAttribute a) => $"{e.Name}.{a.Name} like \"%\" + SearchKeyword + \"%\"";
                if (readListAction == null)
                {
                    var where = search.Count > 0 ? "SearchKeyword = \"\" or " + string.Join(" or ", search.Select(Like)) : null;
                    var extra = filters.Select(f => $"Filter{f.Name} = {NullOf(TargetOf(f))} or {e.Name}.{f.Name} = Filter{f.Name}");
                    Aggregate(h, list, where, joins, Size, "StartIndex", "SortColumn", true, extra);
                }
                foreach (var t in filters.Select(TargetOf).OfType<GenEntity>().DistinctBy(t => t.Name)) OptionsAggregate(h, t);
                Page(h, Plural(Title), () =>
                {
                    if (CanCreate) h.Line("button", g.T["new"], ("class", "btn btn-primary"), ("onclick", "NewOnClick"));
                }, () =>
                {
                    // The filter bar: the search, the dropdowns, clear.
                    void SearchBox() => h.Leaf("input", ("id", "SearchInput"), ("bind", "SearchKeyword"), ("type", "search"), ("placeholder", Q(g.T["search"])), ("class", "form-control"), ("onchange", "SearchOnChange"));
                    void Dropdowns()
                    {
                        foreach (var f in filters)
                        {
                            var t = TargetOf(f)!;
                            h.Leaf("select", ("id", "Filter" + f.Name + "Dropdown"), ("bind", "Filter" + f.Name), ("options", Data($"Get{t.Name}Options", $"{t.Name}Options") + ".List"), ("value", $"{t.Name}.{t.IdName}"),
                                ("label", $"{t.Name}.{TargetLabel(t)}"), ("empty", Q(g.T["all"] + ": " + Words(f.Label ?? StripId(f.Name)))), ("class", "dropdown margin-right-s"), ("onchange", "SearchOnChange"));
                        }
                    }
                    void Clear() => h.Line("button", g.T["clear"], ("class", "btn"), ("onclick", "ClearFiltersOnClick"));
                    if (!hasBar) { }
                    else if (g.filterBar is { } fb)
                    {
                        h.Open("Block", ("name", fb.Reference));
                        if (hasSearch) { h.Open("slot", ("name", fb.Search)); SearchBox(); h.Close("slot"); }
                        if (fb.Filters != null && filters.Count > 0) { h.Open("slot", ("name", fb.Filters)); Dropdowns(); h.Close("slot"); }
                        if (fb.Actions != null) { h.Open("slot", ("name", fb.Actions)); Clear(); h.Close("slot"); }
                        h.Close("Block");
                    }
                    else
                    {
                        h.Open("div", ("class", "display-flex align-items-center flex-wrap margin-bottom-base"));
                        if (hasSearch) { h.Open("div", ("class", "flex1 margin-right-s")); SearchBox(); h.Close("div"); }
                        Dropdowns(); Clear();
                        h.Close("div");
                    }
                    States(h, data, listExpr, () =>
                    {
                        h.Open("table", ("class", "table"));
                        h.Open("thead");
                        h.Open("tr", ("class", "table-header"));
                        foreach (var c in columns)
                        {
                            var head = ColumnLabel(c);
                            if (sortable)
                            {
                                h.Open("th");
                                // A reference column sorts by what it shows: its target's label (the join's source).
                                var key = joins.FirstOrDefault(j => j.A == c) is { T: { } jt } ? $"{{{jt.Name}}}.[{TargetLabel(jt)}]" : $"{{{e.Name}}}.[{c.Name}]";
                                h.Line("a", head, ("onclick", $"SortOnClick(Column = {Q(key)})"));
                                h.Close("th");
                            }
                            else h.Line("th", head);
                        }
                        h.Line("th", g.T["actions"], ("class", "text-align-right"));
                        h.Close("tr");
                        h.Close("thead");
                        h.Open("tbody", ("list", listExpr), ("disable-virtualization", "{{ True }}"));
                        h.Open("tr", ("class", "table-row"));
                        var first = true;
                        foreach (var c in columns)
                        {
                            var value = Display(c, RefLabel(c, row, joins.Any(j => j.A == c)));
                            h.Open("td");
                            if (first && Has("detail")) h.Line("a", $"{{{{ {value} }}}}", ("onclick", $"ViewOnClick(Id = {row}.{e.IdName})"));
                            else h.Text($"{{{{ {value} }}}}");
                            h.Close("td");
                            first = false;
                        }
                        h.Open("td", ("class", "text-align-right"));
                        if (Has("form")) h.Line("a", g.T["edit"], ("class", "margin-right-s"), ("onclick", $"EditOnClick(Id = {row}.{e.IdName})"));
                        if (CanDelete) h.Line("a", g.T["delete"], ("onclick", $"DeleteOnClick(Id = {row}.{e.IdName})"));
                        h.Close("td");
                        h.Close("tr");
                        h.Close("tbody");
                        h.Close("table");
                        if (g.pager is { } p)
                            h.Leaf("Block", ("name", p.Reference), (":" + p.Start, "StartIndex"), (":" + p.Max, Size), (":" + p.Total, Count(data)),
                                ("@" + p.Event, $"PaginationOnNavigate(NewStartIndex = {p.Param})"));
                        else
                        {
                            h.Open("div", ("class", "pagination display-flex align-items-center justify-content-space-between margin-top-base"));
                            h.Line("div", $"{{{{ IntegerToText(StartIndex + 1) + \"-\" + IntegerToText(Min(StartIndex + {Size}, {Count(data)})) + {Q(g.T["of"])} + IntegerToText({Count(data)}) }}}}", ("class", "pagination-counter"));
                            h.Open("div", ("class", "pagination-container display-flex"));
                            h.Line("button", g.T["previous"], ("class", "btn pagination-button"), ("enabled", "StartIndex > 0"), ("onclick", $"PaginationOnNavigate(NewStartIndex = Max(0, StartIndex - {Size}))"));
                            h.Line("button", g.T["next"], ("class", "btn pagination-button"), ("enabled", $"StartIndex + {Size} < {Count(data)}"), ("onclick", $"PaginationOnNavigate(NewStartIndex = StartIndex + {Size})"));
                            h.Close("div"); h.Close("div");
                        }
                    });
                    if (CanDelete) Confirm(h, "IsDeleteConfirmOpen");
                });
                h.Close("screen");
                // The logic: refresh after each change of the search, a filter, the page or the sort.
                var refresh = $"  refresh {data}\n  end\n";
                if (hasBar)
                {
                    flows.Add($"/// Shows the first page of the records the search and the filters select.\naction {ListName}.SearchOnChange\n  assign StartIndex = 0  # Back to the first page\n{refresh}");
                    var clear = new StringBuilder($"/// Clears the search and the filters and shows the first page.\naction {ListName}.ClearFiltersOnClick\n  assign  # Clear the search and the filters\n");
                    if (hasSearch) clear.Append("    SearchKeyword = \"\"\n");
                    foreach (var f in filters) clear.Append($"    Filter{f.Name} = {NullOf(TargetOf(f))}\n");
                    clear.Append("    StartIndex = 0\n").Append(refresh);
                    flows.Add(clear.ToString());
                }
                if (sortable)
                    flows.Add($"/// Sorts the list by the column clicked; the same column again reverses the order.\naction {ListName}.SortOnClick\n  /// The column clicked, as the dynamic sort names it.\n  in Column: Text\n  assign  # Sort by the column, from the first page\n    SortColumn = If(SortColumn = Column, Column + \" DESC\", Column)\n    StartIndex = 0\n{refresh}");
                flows.Add($"/// Shows the page the pagination asks for.\naction {ListName}.PaginationOnNavigate\n  /// The position of the first record of the page asked for.\n  in NewStartIndex: Integer\n  assign StartIndex = NewStartIndex  # Go to the page\n{refresh}");
                if (Has("form"))
                {
                    if (CanCreate) flows.Add($"/// Opens the form for a new {e.Name}.\naction {ListName}.NewOnClick\n  navigate {FormName}({IdInput}={NullOf(e)})\n");
                    flows.Add($"/// Opens the form of the {e.Name} of the row.\naction {ListName}.EditOnClick\n  /// The {e.Name} of the row.\n  in Id: {e.IdType}\n  navigate {FormName}({IdInput}=Id)\n");
                }
                if (Has("detail")) flows.Add($"/// Opens the detail of the {e.Name} of the row.\naction {ListName}.ViewOnClick\n  /// The {e.Name} of the row.\n  in Id: {e.IdType}\n  navigate {DetailName}({IdInput}=Id)\n");
                if (CanDelete)
                {
                    flows.Add($"/// Asks to confirm the delete of the {e.Name} of the row.\naction {ListName}.DeleteOnClick\n  /// The {e.Name} of the row.\n  in Id: {e.IdType}\n  assign  # Remember the record and ask to confirm\n    DeleteId = Id\n    IsDeleteConfirmOpen = True\n  end\n");
                    // After the delete the row leaves the page on the client (one server call in the path, rule S2).
                    var rowId = $"{row}.{e.IdName}";
                    flows.Add(DeleteFlows(ListName, "DeleteId", $"  Found = (System).ListIndexOf(List={listExpr}, Condition={rowId} = DeleteId)\n  (System).ListRemove(List={listExpr}, Position=Found.Position)\n  message Success: {Q(g.T["deleted"])}\n  end\n"));
                    flows.Add($"/// Closes the confirmation without deleting.\naction {ListName}.DeleteCancelOnClick\n  assign IsDeleteConfirmOpen = False  # Close the confirmation\n  end\n");
                }
                if (readListAction != null) flows.Add(ListDataAction(list));
                return (h.ToString(), flows);
            }

            private string Count(string data) => readListAction != null ? $"{data}.Total" : $"LongIntegerToInteger({data}.Count)";

            private string ListDataAction(string name)
            {
                var a = listAction!;
                var listOut = a.Outputs.First(o => o.Type == e.Name + " List").Name;
                var totalOut = a.Outputs.First(o => Integer(o.Type) && Is(o.Name, "count", "total"));
                var args = new List<string>();
                foreach (var i in a.Inputs)
                {
                    var role = PagingRole(i);
                    if (role == "start") args.Add($"{i.Name}=StartIndex");
                    else if (role == "max") args.Add($"{i.Name}={Size}");
                    else if (role == "search") args.Add($"{i.Name}=SearchKeyword");
                }
                return $"/// Reads the page of {e.Name} records the list shows, through {Call(a)}.\ndata action {ListName}.{name}\n  /// The records of the page.\n  out List: {e.Name} List\n  /// How many records the list has, every page together.\n  out Total: Integer\n  Result = {Call(a)}({string.Join(", ", args)})\n  assign  # The page and the total\n    List = Result.{listOut}\n    Total = {(totalOut.Type == "Long Integer" ? $"LongIntegerToInteger(Result.{totalOut.Name})" : $"Result.{totalOut.Name}")}\n  end\n";
            }

            // Loading, error and empty, then the content.
            private void States(Html h, string data, string listExpr, Action content)
            {
                h.Open("div", ("if", $"{data}.HasFetchError"));
                h.Line("div", g.T["error"], ("class", "feedback-message feedback-message-error"), ("role", "alert"));
                h.Close("div");
                h.Open("div", ("else", null));
                h.Open("div", ("if", $"not {data}.IsDataFetched"));
                h.Line("div", g.T["loading"], ("class", "text-neutral-7 padding-base"), ("role", "status"));
                h.Close("div");
                h.Open("div", ("else", null));
                h.Open("div", ("if", $"{listExpr}.Empty"));
                h.Line("div", g.T["empty"], ("class", "text-neutral-7 padding-base text-align-center"));
                h.Close("div");
                h.Open("div", ("else", null));
                content();
                h.Close("div");
                h.Close("div");
                h.Close("div");
            }

            private string Record(string data) => readOneAction != null ? $"{data}.Record" : $"{data}.List.Current.{e.Name}";

            private string OneDataAction(string owner, string name)
            {
                var a = oneAction!;
                var input = a.Inputs.Single(i => i.Mandatory).Name;
                var output = a.Outputs.First(o => o.Type == e.Name).Name;
                return $"/// Reads the {e.Name} the screen shows, through {Call(a)}.\ndata action {owner}.{name}\n  /// The {e.Name}.\n  out Record: {e.Name}\n  Result = {Call(a)}({input}={IdInput})\n  assign Record = Result.{output}  # The record\n  end\n";
            }

            private (string, List<string>) DetailScreen()
            {
                var h = new Html();
                var flows = new List<string>();
                var data = Data($"Get{e.Name}", $"{e.Name}Data");
                var record = Record(data);
                var joins = readOneAction != null ? new List<(GenAttribute A, GenEntity T)>() : Joins(shown);
                var actionList = new List<string>();
                if (Has("list")) actionList.Add("BackOnClick");
                if (Has("form")) actionList.Add("EditOnClick");
                if (CanDelete) actionList.AddRange(["DeleteOnClick", "DeleteConfirmOnClick", "DeleteCancelOnClick"]);
                Open(h, DetailName, Title + g.T["details"], string.Join(", ", actionList), readOneAction != null ? data : null, "The detail");
                h.Leaf("input", ("name", IdInput), ("type", e.IdType), ("mandatory", "True"), ("description", $"The {e.Name} the screen shows."));
                if (CanDelete) h.Leaf("var", ("name", "IsDeleteConfirmOpen"), ("type", "Boolean"), ("default", "False"), ("description", "True while the delete confirmation is shown."));
                if (readOneAction == null) Aggregate(h, data, $"{e.Name}.{e.IdName} = {IdInput}", joins, "1", null, null, false, []);
                var title = label != null ? $"{{{{ {record}.{label.Name} }}}}" : Title;
                Page(h, title, () =>
                {
                    if (Has("list")) h.Line("button", g.T["back"], ("class", "btn margin-right-s"), ("onclick", "BackOnClick"));
                    if (Has("form")) h.Line("button", g.T["edit"], ("class", "btn btn-primary margin-right-s"), ("onclick", "EditOnClick"));
                    if (CanDelete) h.Line("button", g.T["delete"], ("class", "btn btn-error"), ("onclick", "DeleteOnClick"));
                }, () =>
                {
                    var empty = readOneAction != null ? $"{record}.{e.IdName} = {NullOf(e)}" : $"{data}.List.Empty";
                    h.Open("div", ("if", $"{data}.HasFetchError"));
                    h.Line("div", g.T["error"], ("class", "feedback-message feedback-message-error"), ("role", "alert"));
                    h.Close("div");
                    h.Open("div", ("else", null));
                    h.Open("div", ("if", $"{data}.IsDataFetched and {empty}"));
                    h.Line("div", g.T["notFound"], ("class", "text-neutral-7 padding-base"));
                    h.Close("div");
                    h.Open("div", ("else", null));
                    h.Open("table", ("class", "table"));
                    h.Open("tbody");
                    foreach (var a in shown)
                    {
                        h.Open("tr", ("class", "table-row"));
                        h.Line("th", ColumnLabel(a), ("class", "text-neutral-8"));
                        var joined = joins.Any(j => j.A == a);
                        var value = Display(a, joined ? $"{data}.List.Current.{TargetOf(a)!.Name}.{TargetLabel(TargetOf(a)!)}" : $"{record}.{a.Name}");
                        h.Line("td", $"{{{{ {value} }}}}");
                        h.Close("tr");
                    }
                    h.Close("tbody");
                    h.Close("table");
                    h.Close("div");
                    h.Close("div");
                    if (CanDelete) Confirm(h, "IsDeleteConfirmOpen");
                });
                h.Close("screen");
                if (Has("list")) flows.Add($"/// Goes back to the list.\naction {DetailName}.BackOnClick\n  navigate {ListName}()\n");
                if (Has("form")) flows.Add($"/// Opens the form of this {e.Name}.\naction {DetailName}.EditOnClick\n  navigate {FormName}({IdInput}={IdInput})\n");
                if (CanDelete)
                {
                    flows.Add($"/// Asks to confirm the delete of this {e.Name}.\naction {DetailName}.DeleteOnClick\n  assign IsDeleteConfirmOpen = True  # Ask to confirm\n  end\n");
                    flows.Add(DeleteFlows(DetailName, IdInput, $"  message Success: {Q(g.T["deleted"])}\n" + (Has("list") ? $"  navigate {ListName}()\n" : "  end\n")));
                    flows.Add($"/// Closes the confirmation without deleting.\naction {DetailName}.DeleteCancelOnClick\n  assign IsDeleteConfirmOpen = False  # Close the confirmation\n  end\n");
                }
                if (readOneAction != null) flows.Add(OneDataAction(DetailName, data));
                return (h.ToString(), flows);
            }

            private string? Kind(GenAttribute a)
            {
                if (TargetOf(a) is { } t) return TargetLabel(t) != null ? "select" : null;
                if (a.Type.EndsWith(" Identifier", StringComparison.Ordinal)) return null;
                return a.Type switch
                {
                    "Boolean" => "checkbox",
                    "Text" => a.Length > 500 ? "textarea" : "text",
                    "Email" => "email", "Phone Number" => "tel",
                    "Integer" or "Long Integer" or "Decimal" or "Currency" => "number",
                    "Date" => "date", "Time" => "time", "Date Time" => "datetime",
                    _ => null,
                };
            }

            private (string, List<string>) FormScreen()
            {
                var h = new Html();
                var flows = new List<string>();
                var data = Data($"Get{e.Name}", $"{e.Name}Data");
                var record = Record(data);
                var form = e.Name + "Form";
                Open(h, FormName, Title, Has("list") ? "CancelOnClick, SaveOnClick" : "SaveOnClick", readOneAction != null ? data : null, "The form");
                h.Leaf("input", ("name", IdInput), ("type", e.IdType), ("default", NullOf(e)), ("description", $"The {e.Name} to edit; empty for a new one."));
                if (readOneAction == null) Aggregate(h, data, $"{e.Name}.{e.IdName} = {IdInput}", [], "1", null, null, false, []);
                foreach (var t in fields.Select(TargetOf).OfType<GenEntity>().DistinctBy(t => t.Name)) OptionsAggregate(h, t);
                var title = $"{{{{ If({IdInput} = {NullOf(e)}, {Q(g.T["newTitle"] + Title)}, {Q(g.T["editTitle"] + Title)}) }}}}";
                Page(h, title, () => { }, () =>
                {
                    h.Open("div", ("if", $"{data}.HasFetchError"));
                    h.Line("div", g.T["error"], ("class", "feedback-message feedback-message-error"), ("role", "alert"));
                    h.Close("div");
                    h.Open("div", ("else", null));
                    h.Open("form", ("id", form), ("class", "form"));
                    foreach (var a in fields)
                    {
                        var id = "Input_" + a.Name;
                        var bind = $"{record}.{a.Name}";
                        h.Open("div", ("class", "margin-bottom-base"));
                        h.Line("label", ColumnLabel(a), ("for", id));
                        var kind = Kind(a)!;
                        var required = a.Mandatory ? "True" : null;
                        // An identifier the person types (not numbered) is written once: on a new record only.
                        var enabled = a.Name.Equals(e.IdName, StringComparison.OrdinalIgnoreCase) ? $"{IdInput} = {NullOf(e)}" : null;
                        switch (kind)
                        {
                            case "checkbox": h.Leaf("input", ("id", id), ("type", "checkbox"), ("bind", bind), ("class", "checkbox")); break;
                            case "textarea": h.Leaf("textarea", ("id", id), ("bind", bind), ("maxlength", a.Length > 0 ? a.Length.ToString() : null), ("required", required), ("enabled", enabled), ("class", "form-control")); break;
                            case "select":
                                var t = TargetOf(a)!;
                                h.Leaf("select", ("id", id), ("bind", bind), ("options", Data($"Get{t.Name}Options", $"{t.Name}Options") + ".List"), ("value", $"{t.Name}.{t.IdName}"), ("label", $"{t.Name}.{TargetLabel(t)}"),
                                    ("empty", Q(g.T["choose"])), ("required", required), ("enabled", enabled), ("class", "dropdown"));
                                break;
                            default:
                                // Max. Length as the attribute's Length (the Studio's coherence check: InputMaxLengthMismatch_Input).
                                h.Leaf("input", ("id", id), ("bind", bind), ("type", kind == "text" ? null : kind), ("maxlength", a.Length > 0 ? a.Length.ToString() : null),
                                    ("required", required), ("enabled", enabled), ("class", "form-control"));
                                break;
                        }
                        h.Close("div");
                    }
                    h.Open("div", ("class", "display-flex margin-top-m"));
                    if (Has("list")) h.Line("button", g.T["cancel"], ("class", "btn margin-right-s"), ("onclick", "CancelOnClick"));
                    h.Line("button", g.T["save"], ("class", "btn btn-primary"), ("onclick", "SaveOnClick"), ("os-onclick.BuiltInValidations", "ValidateAndContinue"), ("os-IsDefault", "True"));
                    h.Close("div");
                    h.Close("form");
                    h.Close("div");
                });
                h.Close("screen");
                var input = saveInput!;
                var idOut = saveIdOut;
                var after = Has("detail") && idOut != null ? $"  navigate {DetailName}({IdInput}=SaveRecord.{idOut})\n" : Has("list") ? $"  navigate {ListName}()\n" : "  end\n";
                if (Has("list")) flows.Add($"/// Goes back to the list without saving.\naction {FormName}.CancelOnClick\n  navigate {ListName}()\n");
                flows.Add($"/// Saves the {e.Name} when the form is valid, then shows it.\naction {FormName}.SaveOnClick\n  if not {form}.Valid:  # Is something in the form invalid?\n    end\n  SaveRecord = {saveCall}({input}={record})\n  message Success: {Q(g.T["saved"])}\n{after}");
                if (readOneAction != null) flows.Add(OneDataAction(FormName, data));
                return (h.ToString(), flows);
            }

            private static string ColumnLabel(GenAttribute a) => a.Label is { Length: > 0 } l && l != a.Name ? l : Words(StripId(a.Name));
        }

    }

    // ---- text helpers -------------------------------------------------------------------------------------------------------
    /// <summary>The ssam-html writer: one element per line, indented, attributes in the order given (a null value is left out).</summary>
    internal sealed class Html
    {
        private readonly StringBuilder b = new();
        private int depth;
        private void Indent() => b.Append(' ', Math.Max(0, depth - 1));
        private static string Attrs((string Key, string? Value)[] attrs)
        {
            var s = new StringBuilder();
            foreach (var (k, v) in attrs)
            {
                if (k == "else" && v == null) { s.Append(" else"); continue; }
                if (v == null) continue;
                s.Append(' ').Append(k).Append('=').Append(Attr(v));
            }
            return s.ToString();
        }
        public void Open(string tag, params (string, string?)[] attrs) { Indent(); b.Append('<').Append(tag).Append(Attrs(attrs)).Append(">\n"); depth++; }
        public void Close(string tag) { depth--; Indent(); b.Append("</").Append(tag).Append(">\n"); }
        public void Leaf(string tag, params (string, string?)[] attrs) { Indent(); b.Append('<').Append(tag).Append(Attrs(attrs)).Append("/>\n"); }
        public void Line(string tag, string text, params (string, string?)[] attrs) { Indent(); b.Append('<').Append(tag).Append(Attrs(attrs)).Append('>').Append(TextOf(text)).Append("</").Append(tag).Append(">\n"); }
        public void Text(string text) { Indent(); b.Append(TextOf(text)).Append('\n'); }
        public override string ToString() => b.ToString();
        // A text of one line: a binding stays as written, the rest escaped.
        private static string TextOf(string text) => text.Contains("{{", StringComparison.Ordinal) ? text.Replace("&", "&amp;").Replace("<", "&lt;") : text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        private static string Attr(string v) => !v.Contains('"') ? "\"" + v.Replace("&", "&amp;") + "\"" : !v.Contains('\'') ? "'" + v.Replace("&", "&amp;") + "'" : "\"" + v.Replace("&", "&amp;").Replace("\"", "&quot;") + "\"";
    }

    /// <summary>The OutSystems text literal of a text.</summary>
    internal static string Q(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";

    /// <summary>"OrderItem" -> "Order Item"; "CustomerName" -> "Customer Name".</summary>
    internal static string Words(string name) => Regex.Replace(Regex.Replace(name, "([a-z0-9])([A-Z])", "$1 $2"), "([A-Z]+)([A-Z][a-z])", "$1 $2").Replace('_', ' ').Trim();

    internal static string Plural(string title) => title;

    internal static string StripId(string name) => name.Length > 2 && name.EndsWith("Id", StringComparison.Ordinal) ? name[..^2] : name;

    private static bool Ident(string name) => Regex.IsMatch(name, "^[A-Za-z_][A-Za-z0-9_]*$");

    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static List<string>? Strings(JsonNode? node) => node is JsonArray a ? a.Select(x => x?.ToString() ?? "").ToList() : null;

    internal static string? Nearest(string name, IEnumerable<string> names)
    {
        string? best = null; var bestDistance = int.MaxValue;
        foreach (var candidate in names.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(n => n, StringComparer.Ordinal))
        {
            var d = Distance(name.ToLowerInvariant(), candidate.ToLowerInvariant());
            if (d < bestDistance) { best = candidate; bestDistance = d; }
        }
        return best != null && (bestDistance <= Math.Max(2, name.Length / 3)) ? best : null;
    }

    private static int Distance(string a, string b)
    {
        var previous = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var row = new int[b.Length + 1]; row[0] = i;
            for (var j = 1; j <= b.Length; j++) row[j] = Math.Min(Math.Min(previous[j] + 1, row[j - 1] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            previous = row;
        }
        return previous[b.Length];
    }

    /// <summary>The marker's hash: of the document and its flow texts as generated (before the stamp).</summary>
    internal static string Sha(string html, IEnumerable<string> flows)
    {
        var text = html + "\n" + string.Join("\n", flows) + "\n" + Version;
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.Replace("\r\n", "\n"))))[..16].ToLowerInvariant();
    }

    /// <summary>The document with its marker's hash written after the marker in its description.</summary>
    internal static string Stamp(string html, string sha) => html.Replace(Marker + "\"", Marker + " " + sha + "\"", StringComparison.Ordinal);

    /// <summary>The hash of a description's marker, null when it has none.</summary>
    public static string? MarkerOf(string? description)
    {
        if (string.IsNullOrEmpty(description)) return null;
        var m = Regex.Match(description, Regex.Escape(Marker) + @" ([0-9a-f]{16})");
        return m.Success ? m.Groups[1].Value : null;
    }
}
