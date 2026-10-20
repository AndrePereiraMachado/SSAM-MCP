using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>An element of the module the planner needs to know (kind = the Model API interface name).</summary>
public sealed record PrototypeElement(string Kind, string Name, string? Description, string Key);

/// <summary>What the planner reads of the module: the elements that share a name scope with what the importer creates, the
/// children of entities (attributes, records), and the platform. Built by the session at apply; empty in the preflight.</summary>
public sealed class PrototypeModule
{
    public required string Name { get; init; }
    public required string Platform { get; init; }
    public string AppKind { get; init; } = "reactive";
    public IReadOnlyList<PrototypeElement> Elements { get; init; } = [];
    public Func<string, IReadOnlyList<PrototypeElement>> ChildrenOf { get; init; } = _ => [];
    public static PrototypeModule Empty(string platform, string name = "Module") => new() { Name = name, Platform = platform };
}

/// <summary>One step of the plan, in the documented order (7.2). Ops go through the existing verbs; Widgets through the direct
/// builder; Special names a step the session runs itself (theme stylesheet without CodeFormat, clearing a marked screen).</summary>
public sealed record PrototypeStep(string Phase, string Label, List<JsonObject>? Ops = null, PrototypeWidgetsJob? Widgets = null, string? Special = null, JsonObject? Arguments = null);

/// <summary>The widgets of one owner (screen, block) for the direct builder: the parent (a placeholder content or the owner),
/// the roots in order and the spec of each widget.</summary>
public sealed record PrototypeWidgetsJob(string Owner, string Parent, IReadOnlyList<WidgetNode> Roots, IReadOnlyDictionary<WidgetNode, PrototypeWidgetSpec> Specs, string OwnerName);

/// <summary>The compiled importation: steps, the roots for the stylesheet and the read-back, and the receipt part the kernel fills.</summary>
public sealed class PrototypePlan
{
    public required PrototypeCapture Capture { get; init; }
    public required string Platform { get; init; }
    public List<PrototypeStep> Steps { get; } = [];
    public List<PrototypeCapture.Problem> Problems { get; } = [];
    public Dictionary<string, WidgetNode> Roots { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> AssetUrls { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> IdClasses { get; } = new(StringComparer.Ordinal);
    public SortedSet<string> SubstitutedTags { get; } = new(StringComparer.Ordinal);
    public HashSet<string> IconClasses { get; } = new(StringComparer.Ordinal);
    public JsonObject Report { get; } = new();
    public string? StyleSheet { get; set; }
    public JsonObject? CssReport { get; set; }
    public string FlowName { get; set; } = "";
    public string ThemeName { get; set; } = "";
    public string? ShellName { get; set; }
    public Dictionary<string, string> Screens { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> OwnerRefs { get; } = new(StringComparer.Ordinal);
    /// <summary>The @keys of the marked elements an import in place changes (entities, flow, theme, variables).</summary>
    public List<string> ExistingRefs { get; } = [];
    public string PlanSha { get; set; } = "";
    public bool NoChange { get; set; }
    /// <summary>The records of the static entities the compiler creates itself (the options of the selects): the read-back
    /// evaluates their aggregates over these rows, as it does with the store's.</summary>
    public JsonObject StaticRows { get; } = new();
    /// <summary>The collection of the store each entity holds (entity name -> collection): the read-back finds the seed rows of
    /// an entity by it (the entity is the collection's singular, prefixed only on a collision).</summary>
    public Dictionary<string, string> EntityCollections { get; } = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Marked elements of a previous import that this capture no longer produces (1.6): the session deletes each one
    /// nothing outside the prefix references, and keeps and lists the others.</summary>
    public List<PrototypeElement> Vanished { get; } = [];
    /// <summary>Event key -> the screen action that runs it (the offline validation of a binding proposal maps a failing action
    /// back to its event).</summary>
    public Dictionary<string, string> EventActions { get; } = new(StringComparer.Ordinal);
    public int OpCount => Steps.Sum(s => s.Ops?.Count ?? 0);
}

/// <summary>
/// The importer of docs/PROTOTIPO-NATIVO.md (op prototype): reads the capture bundle (never the source), checks that the seams of
/// the other lanes are registered, and plans the native module in the documented order: images, data (static entities for the
/// collections nothing writes, regular entities without AutoNumber for the mutated ones, options entities), the theme
/// &lt;Prefix&gt;Theme (BaseTheme null, the stylesheet of PrototypeSeams.Css), the UI flow &lt;Prefix&gt; with that theme, the Client
/// Variables of the global dimensions, one server action per data-changing event, the shell block and the modal blocks, and per
/// view a screen with its inputs, locals, aggregates, screen actions, the shell instance and the widgets of the view and its
/// popups. Names follow 1.6/3.5 (marked elements are updated in place; an unmarked homonym gets &lt;Prefix&gt;&lt;Name&gt;; a
/// requested name that collides is PROTOTYPE_NAME_COLLISION with every such name, once).
/// </summary>
public static class PrototypeExpander
{
    public const string Op = "prototype";

    /// <summary>The seams the importer runs with: the registered ones (PrototypeSeams), or, in a test, an override that only
    /// that test's flow sees.</summary>
    public sealed record Seams(Func<ElementRequest, ElementMapping>? Element, Func<PrototypeCssRequest, PrototypeCssResult>? Css, Func<PrototypeRenderRequest, JsonObject>? Render);

    private static readonly AsyncLocal<Seams?> Override = new();

    /// <summary>Runs <paramref name="work"/> with these seams instead of the registered ones (tests of this lane; the seams of the
    /// other lanes are fakes there).</summary>
    public static T WithSeams<T>(Seams seams, Func<T> work)
    {
        var previous = Override.Value;
        Override.Value = seams;
        try { return work(); }
        finally { Override.Value = previous; }
    }

    public static Seams Current => Override.Value ?? new Seams(PrototypeSeams.Element, PrototypeSeams.Css, PrototypeSeams.Render);

    public static JsonObject Schema() => new()
    {
        ["op"] = Op,
        ["shape"] = new JsonObject
        {
            ["source"] = "absolute path of the prototype folder, of an .html inside it or of its .zip (read only by the facade; a .zip is extracted once, safely)",
            ["entry"] = "relative to source; default index.html, else the only .html of the root",
            ["app"] = "reactive | mobile (default: the open module)",
            ["prefix"] = "^[A-Za-z][A-Za-z0-9]*$; default: the <title> up to the first separator, in PascalCase ASCII",
            ["mapping"] = "only when a refusal asks for it, with the exact value it gives: screens, default, routes, shell, states, modals, data, vendor, events, ignore, names, version",
            ["clock"] = "ISO-8601 UTC fixed clock of the capture", ["tz"] = "IANA time zone of the capture (default UTC)",
            ["home"] = "true makes the default view the module's default screen", ["seed"] = "write the store rows after publication (default true)",
            ["capture"] = "written by the facade: capture.json of the content-addressed bundle", ["captureSha256"] = "written by the facade: canonical hash of the capture",
        },
        ["order"] = new JsonArray("images", "spec", "theme", "flow", "clientVariables", "logic:server", "blocks", "screens (create, inputs, locals, aggregates, logic, shell instance, widgets)", "render"),
        ["rules"] = "One call turns the capture into native elements: one screen per view in the flow <Prefix> (theme <Prefix>Theme, BaseTheme null, the prototype CSS verbatim), "
            + "the shell as block <Prefix>Shell with the placeholder Content, each modal an IPopup <Name>Popup (a block <Name> when on two screens or more), data as entities "
            + "(static when nothing writes the collection, regular without AutoNumber otherwise), one server action per data-changing event (entity actions; one portable "
            + "Advanced SQL per set effect), screen actions with exception handlers and Refresh Data of the affected aggregates. No JavaScript, JSON, Visible, ForEach or "
            + "server call in a lifecycle event. Names: marked elements (Description 'ssam:prototype <prefix>') are updated in place; an unmarked homonym gets <Prefix><Name>; "
            + "a requested name that collides is PROTOTYPE_NAME_COLLISION. The same capture again is NO_CHANGE.",
        ["refusals"] = new JsonArray("PROTOTYPE_IR_INVALID", "PROTOTYPE_NAME_COLLISION", "INPUT_INVALID"),
    };

    /// <summary>The whole plan, or the problems (all of them) when the capture or a requested name refuses it.</summary>
    public static PrototypePlan Plan(PrototypeCapture capture, PrototypeModule module, Seams seams)
    {
        var planner = new PrototypePlanner(capture, module, seams);
        return planner.Run();
    }

    /// <summary>A widgets job as canonical JSON: each widget's type, capture key, tag, name, properties, extended properties,
    /// handler, block and children (the golden form of the lane tests).</summary>
    public static JsonObject Canonical(PrototypeWidgetsJob job) => PrototypePlanner.WidgetsCanonical(job);

    /// <summary>The build of this compiler: a capture imported by another build is imported again once.</summary>
    public static string CompilerId { get; } = typeof(PrototypeExpander).Assembly.ManifestModule.ModuleVersionId.ToString("N");

    /// <summary>sha256 of a text, hex lower case.</summary>
    public static string Sha(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}

/// <summary>A local variable of an owner.</summary>
public sealed record PrototypeLocal(string Name, string Type, string? Default);

/// <summary>An aggregate of an owner: the collection it reads, the joins by foreign key, the filter and order of the capture,
/// the aggregation columns of a count or sum, and the screen action OnAfterFetch calls (Ordenar&lt;Lista&gt;).</summary>
public sealed class PrototypeAggregate
{
    public required string Name { get; init; }
    public required string Alias { get; init; }
    public required string Collection { get; init; }
    public required string Entity { get; init; }
    public Dictionary<string, string> Joins { get; } = new(StringComparer.Ordinal);
    public List<string> Filters { get; } = [];
    public List<(string Attribute, bool Descending)> Sort { get; } = [];
    public List<(string Name, string Kind, string Attribute)> Columns { get; } = [];
    public string? AfterFetch { get; set; }
    public JsonObject? SortBy { get; set; }
    public string? ListName { get; set; }
    public HashSet<string> Reads { get; } = new(StringComparer.Ordinal);
}

/// <summary>A popup of a screen: its widget, the Boolean that shows it, the locals of its inputs, and how its record is read
/// (ListIndexOf into a list of the screen, an aggregate refreshed when it opens, or a new record local).</summary>
public sealed class PrototypePopup
{
    public required string Modal { get; init; }
    public required string Name { get; init; }
    public required string Widget { get; init; }
    public required string IsOpen { get; init; }
    public Dictionary<string, string> Inputs { get; } = new(StringComparer.Ordinal);
    public string? Index { get; set; }
    public PrototypeAggregate? List { get; set; }
    public PrototypeAggregate? Record { get; set; }
    public string? NewRecord { get; set; }
    public string? Block { get; set; }
    public string? Collection { get; set; }
}

/// <summary>A screen or block of the importation, with everything the steps write in it.</summary>
public sealed class PrototypeOwner
{
    public required string Kind { get; init; }
    public required string Name { get; init; }
    public required string Ref { get; init; }
    public string? ExistingKey { get; init; }
    public string? View { get; init; }
    public string? Modal { get; init; }
    public JsonObject? Node { get; init; }
    public List<(string Name, string Type, bool Mandatory)> Inputs { get; } = [];
    public List<PrototypeLocal> Locals { get; } = [];
    public Dictionary<string, string> DimLocals { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, (string Local, string Type)> Controls { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, PrototypeAggregate> Aggregates { get; } = new(StringComparer.Ordinal);
    public Dictionary<JsonObject, PrototypeAggregate> ByList { get; } = new(ReferenceEqualityComparer.Instance);
    public Dictionary<string, PrototypeAggregate> ListsByName { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, PrototypeAggregate> Records { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, PrototypeAggregate> Sums { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, PrototypeAggregate> Options { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, PrototypePopup> Popups { get; } = new(StringComparer.Ordinal);
    public List<JsonObject> Actions { get; } = [];
    public Dictionary<string, PrototypeEventBinding> Bindings { get; } = new(StringComparer.Ordinal);
    public List<JsonObject> Wiring { get; } = [];
    public required PrototypeNameScope WidgetNames { get; init; }
    public required PrototypeNameScope LocalNames { get; init; }
    public required PrototypeNameScope ActionNames { get; init; }
    public List<(string Event, List<(string Name, string Type)> Params)> BlockEvents { get; } = [];
    public List<(string Local, string Value)> Initialize { get; } = [];
    public List<WidgetNode> Roots { get; } = [];
    /// <summary>The popups of a screen whose prototype modal was a child of the body (a React portal): beside the shell
    /// instance, at the screen's own level, never inside the shell's placeholder (an ancestor there may hold position:fixed).</summary>
    public List<WidgetNode> PortalRoots { get; } = [];
    public Dictionary<WidgetNode, PrototypeWidgetSpec> Specs { get; } = new(ReferenceEqualityComparer.Instance);
    public string Parent { get; set; } = "";
    public string? Description { get; set; }
    public PrototypeWidgets.Context? Widgets { get; set; }
    public HashSet<string> EventKeys { get; } = new(StringComparer.Ordinal);
    /// <summary>The Data Actions data.bind gives the owner (2.12): the source, its alias in the plan and whether it is fetched on
    /// demand (a popup's, refreshed when the popup opens).</summary>
    public List<(PrototypeBindSource Source, string Alias, bool OnDemand)> DataActions { get; } = [];
}

/// <summary>The planner behind <see cref="PrototypeExpander.Plan"/>; one instance per importation.</summary>
internal sealed class PrototypePlanner
{
    private readonly PrototypeCapture _ir;
    private readonly PrototypeModule _module;
    private readonly PrototypeExpander.Seams _seams;
    private readonly PrototypePlan _plan;
    private readonly PrototypeDataModel _data = new();
    private readonly Dictionary<string, PrototypeNameScope> _scopes = new(StringComparer.Ordinal);
    private readonly List<PrototypeOwner> _owners = [];
    private readonly JsonArray _renamed = [];
    private readonly HashSet<(string Scope, string Name)> _produced = new(ScopeNameComparer.Instance);

    private sealed class ScopeNameComparer : IEqualityComparer<(string Scope, string Name)>
    {
        public static readonly ScopeNameComparer Instance = new();
        public bool Equals((string Scope, string Name) a, (string Scope, string Name) b)
            => string.Equals(a.Scope, b.Scope, StringComparison.Ordinal) && string.Equals(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        public int GetHashCode((string Scope, string Name) v) => HashCode.Combine(v.Scope, StringComparer.OrdinalIgnoreCase.GetHashCode(v.Name));
    }
    private readonly List<string> _collisions = [];
    private readonly Dictionary<string, string> _entityRef = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _cvNames = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _imageNames = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _modalBlocks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _optionEntities = new(StringComparer.Ordinal);
    private string _exception = "";
    private string _exceptionRef = "";
    private string _flowRef = "$p.flow";
    private string _themeRef = "$p.theme";
    private readonly List<JsonObject> _dataOps = [];
    private readonly List<JsonObject> _imageOps = [];
    private readonly List<JsonObject> _cvOps = [];
    private PrototypeLogic? _logic;

    public PrototypePlanner(PrototypeCapture ir, PrototypeModule module, PrototypeExpander.Seams seams)
    {
        _ir = ir; _module = module; _seams = seams;
        _plan = new PrototypePlan { Capture = ir, Platform = module.Platform };
    }

    internal PrototypeCapture Capture => _ir;
    internal PrototypeDataModel Data => _data;
    internal PrototypePlan PlanResult => _plan;
    internal IReadOnlyList<PrototypeOwner> Owners => _owners;
    internal string ExceptionName => _exception;
    internal string Prefix => _ir.Prefix;
    internal bool Pt => _ir.Portuguese;
    internal string Platform => _module.Platform;
    internal string EntityName(string collection) => _data.ByCollection(collection)?.Name ?? PrototypeNames.EntityStem(collection);
    internal string CvName(string dimension) => _cvNames[dimension];
    internal string? ModalBlock(string modal) => _modalBlocks.GetValueOrDefault(modal);
    internal PrototypeOwner? Owner(string name) => _owners.FirstOrDefault(o => o.Name == name);
    internal PrototypeOwner? Shell => _owners.FirstOrDefault(o => o.Kind == "block" && o.Modal == null && o.View == null);
    internal PrototypeOwner? ScreenOf(string view) => _owners.FirstOrDefault(o => o.Kind == "screen" && o.View == view);
    internal PrototypeOwner? ModalBlockOwner(string modal) => _owners.FirstOrDefault(o => o.Kind == "block" && o.Modal == modal);

    // The module-level scopes (1.6): entities, static entities and structures are one namespace of data types; server, service and
    // client actions one namespace of actions (a client flow that calls a name takes a client action of that name first, so a
    // referenced client action is avoided too); images avoid resources; the rest are a namespace of their own kind. Wider than the
    // Studio is harmless (a free name is picked), narrower is a silent rename.
    private static readonly Dictionary<string, string[]> ScopeKinds = new(StringComparer.Ordinal)
    {
        ["ui"] = ["IMobileScreen", "IMobileBlock"], ["flow"] = ["IMobileFlow"], ["theme"] = ["IMobileTheme"],
        ["entity"] = ["IServerEntity", "IStaticEntity", "IStructure", "IClientEntity", "IServerEntitySignature", "IStaticEntitySignature", "IStructureSignature"], ["action"] = ["IServerAction", "IServiceAction", "IClientAction", "IClientActionSignature"],
        ["clientVariable"] = ["IClientVariable"], ["image"] = ["IImage", "IResource"], ["exception"] = ["IUserException"],
    };

    internal PrototypeNameScope Scope(string scope)
    {
        if (_scopes.TryGetValue(scope, out var s)) return s;
        var kinds = ScopeKinds[scope];
        var elements = _module.Elements.Where(e => kinds.Contains(e.Kind)).ToList();
        s = new PrototypeNameScope(Prefix, elements.Select(e => e.Name), elements.Where(e => PrototypeNames.IsMarked(e.Description, Prefix)).Select(e => e.Name), renames: ModuleRenames);
        _scopes[scope] = s;
        return s;
    }

    // ---- the reservation of the members of a screen or block (observed on the Model API, 2026-10-11) -------------------------
    // A screen action is renamed by the Studio when a client action of the module, or of a module it references (OutSystemsUI's
    // NotificationClose...), has its name (case-insensitive); the locals, inputs, aggregates and block events collide with none
    // of the module's elements; the locals, inputs and aggregates of an owner are one namespace with its widgets, the screen
    // actions with its locals but not with its widgets. Every member name is chosen against these BEFORE any op is generated.

    /// <summary>The kinds of the base whose names a screen action of any screen or block must avoid.</summary>
    internal static readonly string[] ScreenActionReservedKinds = ["IClientAction", "IClientActionSignature"];

    private HashSet<string>? _screenActionReserved;

    /// <summary>The names of the base a screen action never takes (module client actions and those of its references).</summary>
    internal HashSet<string> ScreenActionReserved => _screenActionReserved ??= new HashSet<string>(
        _module.Elements.Where(e => ScreenActionReservedKinds.Contains(e.Kind)).Select(e => e.Name), StringComparer.OrdinalIgnoreCase);

    private Dictionary<string, string>? _moduleRenames;
    private Dictionary<string, Dictionary<string, string>>? _memberRenames;

    /// <summary>mapping.names entries without an owner ("FarmaVirtualTheme": "FarmaVirtualTema"): module-level names.</summary>
    internal Dictionary<string, string> ModuleRenames { get { ReadRenames(); return _moduleRenames!; } }

    /// <summary>mapping.names entries of one owner ("Catalogo/FecharAviso": "FecharAviso2"), by the owner's final name.</summary>
    internal IReadOnlyDictionary<string, string> MemberRenames(string owner)
    {
        ReadRenames();
        return _memberRenames!.TryGetValue(owner, out var map) ? map : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }

    private void ReadRenames()
    {
        if (_moduleRenames != null) return;
        _moduleRenames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        _memberRenames = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
        if (_ir.Mapping["names"] is not JsonObject names) return;
        foreach (var (key, value) in names)
        {
            if (value is not JsonValue v || !v.TryGetValue<string>(out var to) || string.IsNullOrWhiteSpace(to)) continue;
            var slash = key.LastIndexOf('/');
            if (slash < 0) { _moduleRenames[key] = to; continue; }
            var owner = key[..slash];
            if (!_memberRenames.TryGetValue(owner, out var map)) _memberRenames[owner] = map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            map[key[(slash + 1)..]] = to;
        }
    }

    /// <summary>A member of an owner whose generated name was taken by the base (or mapped by mapping.names): reported once in
    /// renamed, so the receipt says which name each element got and why.</summary>
    internal void MemberRenamed(PrototypeOwner owner, string kind, string wanted, string name, string why)
    {
        if (string.Equals(wanted, name, StringComparison.Ordinal)) return;
        _renamed.Add(new JsonObject { ["kind"] = kind, ["owner"] = owner.Name, ["name"] = name, ["renamedFrom"] = wanted, ["why"] = why });
    }

    /// <summary>Why a generated member name cannot be used as it is (null when it can): the base element that holds it.</summary>
    internal string? MemberHolder(PrototypeOwner owner, string wanted, bool action)
    {
        var mapped = owner.ActionNames.Mapped(wanted);
        if (!string.Equals(mapped, wanted, StringComparison.Ordinal)) return $"mapping.names maps {owner.Name}/{wanted} to {mapped}";
        if (action && ScreenActionReserved.Contains(wanted))
        {
            var holder = _module.Elements.First(e => ScreenActionReservedKinds.Contains(e.Kind) && string.Equals(e.Name, wanted, StringComparison.OrdinalIgnoreCase));
            return holder.Kind == "IClientAction" ? $"the module has the client action {holder.Name} (the Studio would rename the screen action)"
                : $"a referenced module has the client action {holder.Name} (the Studio would rename the screen action)";
        }
        return null;
    }

    /// <summary>The marked element of this importation with this name, when a previous import created it.</summary>
    internal PrototypeElement? Existing(string scope, string name)
        => _module.Elements.FirstOrDefault(e => ScopeKinds[scope].Contains(e.Kind) && string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase) && PrototypeNames.IsMarked(e.Description, Prefix));

    /// <summary>A name of a scope (1.6): the rename reported, a requested collision collected.</summary>
    internal string Name(string scope, string wanted, string kind, bool requested = false)
    {
        var choice = Scope(scope).Take(wanted, requested, kind);
        if (choice.Collision) { _collisions.Add(choice.Why!); return wanted; }
        if (choice.RenamedFrom != null) _renamed.Add(new JsonObject { ["kind"] = kind, ["name"] = choice.Name, ["renamedFrom"] = choice.RenamedFrom, ["why"] = choice.Why });
        _produced.Add((scope, choice.Name));
        return choice.Name;
    }

    internal static JsonObject OpOf(params (string Key, JsonNode? Value)[] pairs)
    {
        var o = new JsonObject();
        foreach (var (k, v) in pairs) if (v != null) o[k] = v;
        return o;
    }
    internal static JsonObject Create(string parent, string type, string? name, string alias, JsonObject? args = null)
        => OpOf(("op", "create"), ("parent", parent), ("type", type), ("name", name), ("as", alias), ("args", args));
    internal static JsonObject Set(string target, string prop, JsonNode? value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = value };

    internal string Describe(string text) => PrototypeNames.Description(text, Prefix);

    /// <summary>A capture key as part of an alias (letters, digits and _ only: logic references accept nothing else).</summary>
    internal static string Safe(string key) => new(key.Select(ch => char.IsAsciiLetterOrDigit(ch) || ch == '_' ? ch : '_').ToArray());

    public PrototypePlan Run()
    {
        if (_seams.Element == null) _plan.Problems.Add(new(PrototypeCapture.IrInvalid, "/capture", "prototype: Element missing (the element map of the html lane is not registered)", true, null));
        if (_seams.Css == null) _plan.Problems.Add(new(PrototypeCapture.IrInvalid, "/capture", "prototype: Css missing (the stylesheet seam of the css lane is not registered)", true, null));
        if (_seams.Render == null) _plan.Problems.Add(new(PrototypeCapture.IrInvalid, "/capture", "prototype: Render missing (the read-back seam of the css lane is not registered)", true, null));
        if (_plan.Problems.Count > 0) return _plan;
        NamesAndData();
        if (_collisions.Count > 0)
        {
            var patch = new JsonArray();
            foreach (var view in _ir.Views)
                if (_ir.Mapping["screens"]?[view["key"]!.ToString()] is JsonValue requested)
                    patch.Add(new JsonObject { ["op"] = "replace", ["path"] = "/mapping/screens/" + view["key"], ["value"] = Prefix + requested });
            if (_ir.PrefixRequested) patch.Add(new JsonObject { ["op"] = "replace", ["path"] = "/prefix", ["value"] = Prefix + "App" });
            _plan.Problems.Add(new(PrototypeCapture.NameCollision, "/mapping", "prototype: requested names collide with unmarked elements of the module: " + string.Join("; ", _collisions), false, patch.Count > 0 ? patch : null));
            return _plan;
        }
        OwnersAndData();
        _logic = new PrototypeLogic(this);
        _logic.Compile();
        Widgets();
        Stylesheet();
        Steps();
        ReportAll();
        return _plan;
    }

    // ---- names and data ---------------------------------------------------------------------------------------------------

    private string Ref(string scope, string name, string alias)
    {
        if (Existing(scope, name) is not { } e) return alias;
        _plan.ExistingRefs.Add("@" + e.Key);
        return "@" + e.Key;
    }

    private void NamesAndData()
    {
        _plan.FlowName = Name("flow", Prefix, "UI flow", _ir.PrefixRequested);
        _flowRef = Ref("flow", _plan.FlowName, "$p.flow");
        _plan.ThemeName = Name("theme", Prefix + "Theme", "theme", _ir.PrefixRequested);
        _themeRef = Ref("theme", _plan.ThemeName, "$p.theme");
        if (_ir.Shell != null && _ir.Mapping["shell"]?["none"]?.GetValue<bool>() != true)
            _plan.ShellName = Name("ui", Prefix + "Shell", "block", _ir.PrefixRequested);
        foreach (var view in _ir.Views)
        {
            var key = view["key"]!.ToString();
            var requested = _ir.Mapping["screens"]?[key]?.ToString();
            _plan.Screens[key] = Name("ui", requested ?? view["name"]!.ToString(), "screen", requested != null);
        }
        foreach (var modal in _ir.Modals)
        {
            var key = modal["key"]!.ToString();
            var screens = ModalViews(modal);
            if (screens.Count >= 2)
            {
                var requested = _ir.Mapping["modals"]?[key]?.ToString();
                _modalBlocks[key] = Name("ui", requested ?? modal["name"]!.ToString(), "block", requested != null);
            }
        }
        foreach (var asset in _ir.Assets)
        {
            var path = asset["path"]!.ToString();
            var name = Name("image", PrototypeNames.Image(Prefix, path), "image");
            _imageNames[path] = name;
            // the type of the bytes, not the file's name (a JPEG saved as .png): the Studio checks the stylesheet URL by it
            var ext = PrototypeNames.ImageExtension(AssetHead(asset), path);
            _plan.AssetUrls[path] = $"/{_module.Name}/img/{_module.Name}.{name}{(ext.Length > 0 ? "." + ext : "")}";
        }
        foreach (var dim in _ir.Dimensions.Where(d => d["scope"]?.ToString() == "global"))
            _cvNames[dim["key"]!.ToString()] = Name("clientVariable", Prefix + dim["name"], "client variable");
        // a User Exception has no Description to carry the mark: the prefixed name is the importation's own
        var exceptionName = Prefix + (Pt ? "Validacao" : "Validation");
        var existingException = _module.Elements.FirstOrDefault(e => e.Kind == "IUserException" && string.Equals(e.Name, exceptionName, StringComparison.OrdinalIgnoreCase));
        _exception = existingException?.Name ?? Name("exception", exceptionName, "user exception");
        _exceptionRef = existingException != null ? "@" + existingException.Key : "$p.exception";
        // entities: static for the collections nothing writes, regular (Integer Id, no AutoNumber) for the mutated; a static
        // entity cannot reference a regular one, so a collection that references a regular entity is regular too
        var regular = new HashSet<string>(_ir.Collections.Select(c => c["name"]!.ToString()).Where(_ir.Mutated), StringComparer.Ordinal);
        for (var changed = true; changed;)
        {
            changed = false;
            foreach (var c in _ir.Collections)
            {
                var collection = c["name"]!.ToString();
                if (regular.Contains(collection)) continue;
                if (PrototypeCapture.Objects(c["references"]).Any(r => r["collection"]?.ToString() is { } target && regular.Contains(target))) { regular.Add(collection); changed = true; }
            }
        }
        foreach (var c in _ir.Collections)
        {
            var collection = c["name"]!.ToString();
            // N1: the singular of the collection in PascalCase (imoveis -> Imovel); the prefix only when the base holds the name
            var name = Name("entity", PrototypeNames.EntityStem(collection), "entity");
            var fields = PrototypeCapture.Objects(c["fields"]).Select(f => new PrototypeDataModel.Field(f["name"]!.ToString(), f["type"]!.ToString(),
                f["length"]?.GetValue<int>(), PrototypeCapture.Objects(c["references"]).FirstOrDefault(r => r["field"]?.ToString() == f["name"]!.ToString())?["collection"]?.ToString())).ToList();
            _data.Entities.Add(new(collection, name, !regular.Contains(collection), fields, c["rows"] as JsonArray ?? [], c["key"]?.ToString() ?? "Id"));
            _entityRef[collection] = Ref("entity", name, "$p.ent." + Safe(collection));
            _plan.EntityCollections[name] = collection;
        }
    }

    /// <summary>The first bytes of a bundled asset (its image type); empty when the bundle file cannot be read (the build
    /// refuses it where it reads the whole file).</summary>
    private byte[] AssetHead(JsonObject asset)
    {
        try
        {
            if (_ir.BundleFile(asset["bundle"]?.ToString() ?? "") is not { } file || !File.Exists(file)) return [];
            using var stream = File.OpenRead(file);
            var buffer = new byte[4096];
            var read = stream.Read(buffer, 0, buffer.Length);
            return buffer[..read];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { return []; }
    }

    internal string EntityAlias(string collection) => _entityRef[collection];

    /// <summary>The views a modal opens on: openedFrom, and the views whose events open it.</summary>
    internal List<string> ModalViews(JsonObject modal)
    {
        var key = modal["key"]!.ToString();
        var views = new List<string>();
        foreach (var o in PrototypeCapture.Objects(modal["openedFrom"])) if (o["view"]?.ToString() is { } v && !views.Contains(v)) views.Add(v);
        foreach (var e in _ir.Events)
            if (Effects(e).Any(x => x["kind"]?.ToString() == "openPopup" && x["modal"]?.ToString() == key) && e["view"]?.ToString() is { } ev && !views.Contains(ev)) views.Add(ev);
        // a modal opened from inside another modal lives on the screens of the outer one
        foreach (var e in _ir.Events)
            if (e["modal"]?.ToString() is { } outer && outer != key && Effects(e).Any(x => x["kind"]?.ToString() == "openPopup" && x["modal"]?.ToString() == key) && _ir.Modal(outer) is { } outerModal)
                foreach (var v in PrototypeCapture.Objects(outerModal["openedFrom"]).Select(o => o["view"]?.ToString()).OfType<string>()) if (!views.Contains(v)) views.Add(v);
        return views;
    }

    internal static IEnumerable<JsonObject> Effects(JsonObject e)
    {
        foreach (var x in e["effects"] as JsonArray ?? []) if (x is JsonObject o) yield return o;
        foreach (var c in e["cases"] as JsonArray ?? []) foreach (var x in c?["effects"] as JsonArray ?? []) if (x is JsonObject o) yield return o;
    }

    // ---- owners: blocks and screens, their locals, inputs and aggregates ---------------------------------------------------

    private PrototypeOwner NewOwner(string kind, string name, string alias, string? view = null, string? modal = null, JsonObject? node = null)
    {
        var existing = Existing("ui", name);
        // What lives directly in the owner is one namespace for the Model API (inputs, block events, locals, aggregates, screen
        // actions); the widgets share it with the locals, inputs and aggregates (not with the screen actions); a screen action
        // also avoids every client action of the module and of its references. Reserved here, before any op is generated
        // (a marked owner imported again is cleared first, so its own members never count).
        var renames = MemberRenames(name);
        var locals = new PrototypeNameScope(Prefix, [], [], renames: renames);
        var actions = new PrototypeNameScope(Prefix, [], [], reserved: ScreenActionReserved, renames: renames);
        var widgets = new PrototypeNameScope(Prefix, [], [], renames: renames);
        PrototypeNameScope.Share(locals, actions);
        PrototypeNameScope.Share(locals, widgets);
        var owner = new PrototypeOwner
        {
            Kind = kind, Name = name, Ref = existing != null ? "@" + existing.Key : alias, ExistingKey = existing?.Key, View = view, Modal = modal, Node = node,
            WidgetNames = widgets, LocalNames = locals, ActionNames = actions,
        };
        _owners.Add(owner);
        _plan.OwnerRefs[name] = owner.Ref;
        return owner;
    }

    /// <summary>data.bind (2.12): the Data Actions of an owner ("v:&lt;view&gt;" or "m:&lt;modal&gt;"). Their names are the ones the bound
    /// expressions read, so they are claimed before any generated local, input, aggregate or widget of the owner.</summary>
    private void BindSources(PrototypeOwner owner, string key, bool onDemand)
    {
        if (_ir.Bind == null) return;
        foreach (var declared in _ir.Bind.Sources.Where(s => s.Owner == key))
        {
            var source = declared;
            // a popup's source reads the popup's parameters by their names (the modal's Dia): on a screen they are its locals
            if (key.StartsWith("m:", StringComparison.Ordinal) && owner.Kind == "screen" && owner.Popups.TryGetValue(key[2..], out var popup) && popup.Inputs.Count > 0)
                source = declared with { Args = declared.Args.ToDictionary(a => a.Key, a => Rename(a.Value, popup.Inputs), StringComparer.Ordinal) };
            if (owner.DataActions.Any(d => d.Source.As.Equals(source.As, StringComparison.OrdinalIgnoreCase))) continue;
            if (!owner.LocalNames.Claim(source.As))
            {
                _plan.Problems.Add(new("INPUT_INVALID", "/bind", $"prototype: the data action '{source.As}' of {owner.Name} collides with another member of it; give the source another \"as\"", false, null));
                continue;
            }
            var alias = $"{(owner.Kind == "screen" ? "$p.scr." + Safe(owner.View!) : "$p.blk." + Safe(owner.Name))}.da.{source.As}";
            owner.DataActions.Add((source, alias, onDemand));
        }
    }

    /// <summary>An expression with each whole name of <paramref name="names"/> (outside text literals, not after a dot) replaced.</summary>
    internal static string Rename(string expression, IReadOnlyDictionary<string, string> names)
    {
        var masked = PrototypeBind.StripStrings(expression);
        var sb = new StringBuilder(expression);
        foreach (var m in System.Text.RegularExpressions.Regex.Matches(masked, @"(?<![\w.])[A-Za-z_][A-Za-z0-9_]*(?![\w(])").Cast<System.Text.RegularExpressions.Match>().Reverse())
            if (names.TryGetValue(m.Value, out var to)) { sb.Remove(m.Index, m.Length); sb.Insert(m.Index, to); }
        return sb.ToString();
    }

    internal string DimType(string key) => _ir.Dimension(key)?["type"]?.ToString() switch { "Integer" => "Integer", "Boolean" => "Boolean", "Decimal" => "Decimal", _ => "Text" };

    internal static string DefaultLiteral(string type, string? value)
        => PrototypeExpr.Literal(value == null ? null : JsonValue.Create(value), type);

    internal string Local(PrototypeOwner owner, string wanted, string type, string? defaultValue)
    {
        var name = owner.LocalNames.Free(wanted, 0);
        owner.Locals.Add(new(name, type, defaultValue));
        return name;
    }

    private void OwnersAndData()
    {
        // the shell block
        if (_plan.ShellName != null && _ir.Shell is JsonObject shell)
        {
            var owner = NewOwner("block", _plan.ShellName, "$p.blk.shell", node: shell["root"] as JsonObject);
            owner.Description = "Shell of the prototype (regions around the mount point of every view).";
            foreach (var input in PrototypeCapture.Objects(shell["inputs"]))
            {
                var type = input["type"]?.ToString() ?? "Text";
                // a record the shell shows (the current user) arrives as a record of its entity, read by each screen
                if (input["record"]?["collection"]?.ToString() is { } recordCollection && _ir.Collection(recordCollection) != null) type = EntityName(recordCollection);
                owner.Inputs.Add((input["name"]!.ToString(), type, false));
                owner.LocalNames.Claim(input["name"]!.ToString());
                if (input["dimension"]?.ToString() is { } dim) owner.DimLocals[dim] = input["name"]!.ToString();
            }
            if (!owner.Inputs.Any(i => i.Name == "View")) { owner.Inputs.Insert(0, ("View", "Text", false)); owner.LocalNames.Claim("View"); }
            foreach (var e in PrototypeCapture.Objects(shell["events"]))
            {
                owner.BlockEvents.Add((e["name"]!.ToString(), PrototypeCapture.Objects(e["params"]).Select(p => (p["name"]!.ToString(), p["type"]?.ToString() ?? "Text")).ToList()));
                owner.LocalNames.Claim(e["name"]!.ToString());
            }
            foreach (var key in ShellEventKeys()) owner.EventKeys.Add(key);
            // a control of the shell bound to a global dimension edits a local copy of its input (the inputs of a block are read
            // only): the local follows the input (OnInitialize, OnParametersChanged, only Assign) and the block event carries the
            // new value to the screen
            void ShellControls(JsonNode? n)
            {
                switch (n)
                {
                    case JsonObject o:
                        if (o["control"] is JsonObject control && control["dimension"]?.ToString() is { } dim && control["var"]?.ToString() is { } name
                            && owner.DimLocals.TryGetValue(dim, out var input) && !owner.Controls.ContainsKey(name))
                        {
                            var type = owner.Inputs.First(i => i.Name == input).Type;
                            var local = Local(owner, input + (Pt ? "Valor" : "Value"), type, null);
                            owner.Controls[name] = (local, type);
                            owner.Initialize.Add((local, input));
                        }
                        foreach (var (key, value) in o) if (key is "c" or "else" or "list") ShellControls(value);
                        if (o["template"] is JsonObject template) ShellControls(template);
                        break;
                    case JsonArray a: foreach (var v in a) ShellControls(v); break;
                }
            }
            ShellControls(shell["root"]);
            ShellControls(shell["after"]);
            Aggregates(owner, [shell["root"] as JsonObject, .. PrototypeCapture.Objects(shell["after"])]);
        }
        // modal blocks (a modal on two screens or more)
        foreach (var (modalKey, blockName) in _modalBlocks)
        {
            var modal = _ir.Modal(modalKey)!;
            var owner = NewOwner("block", blockName, "$p.blk.m." + Safe(modalKey), modal: modalKey, node: modal["root"] as JsonObject);
            owner.Description = $"Modal {modalKey} of the prototype, shown in a popup of each screen that opens it.";
            // the block is rendered when its popup shows: its bound source fetches at start with the inputs it received
            BindSources(owner, "m:" + modalKey, onDemand: false);
            // the record of the modal arrives as an input: the screen reads it (a list row or its own aggregate), so the block
            // re-renders when it changes and never refetches in a lifecycle event (S1)
            if (modal["record"]?["collection"]?.ToString() is { } rc && _ir.Collection(rc) != null)
            {
                var input = Pt ? "Registro" : "Record";
                owner.Inputs.Add((input, EntityName(rc), false));
                owner.LocalNames.Claim(input);
            }
            else
                foreach (var p in PrototypeCapture.Objects(modal["params"])) { owner.Inputs.Add((p["name"]!.ToString(), p["type"]?.ToString() ?? "Integer", false)); owner.LocalNames.Claim(p["name"]!.ToString()); }
            DimensionLocals(owner, modal["root"], EventsOf(modalKey));
            ControlLocals(owner, modal["root"] as JsonObject);
            Aggregates(owner, [modal["root"] as JsonObject]);
            foreach (var eventKey in EventsOf(modalKey)) owner.EventKeys.Add(eventKey);
        }
        // screens
        foreach (var view in _ir.Views)
        {
            var key = view["key"]!.ToString();
            var owner = NewOwner("screen", _plan.Screens[key], "$p.scr." + Safe(key), view: key, node: view["root"] as JsonObject);
            owner.Description = $"View {key} of the prototype ({view["route"]}).";
            BindSources(owner, "v:" + key, onDemand: false);
            foreach (var p in PrototypeCapture.Objects(view["params"])) { owner.Inputs.Add((p["name"]!.ToString(), p["type"]?.ToString() ?? "Integer", true)); owner.LocalNames.Claim(p["name"]!.ToString()); }
            // the global dimensions: locals initialized from their Client Variables in OnInitialize (only Assign)
            foreach (var dim in _ir.Dimensions.Where(d => d["scope"]?.ToString() == "global"))
            {
                var dk = dim["key"]!.ToString();
                // the default is the dimension's initial value (the screen's first render, before OnInitialize reads the variable)
                var local = Local(owner, dim["name"]!.ToString(), DimType(dk), DefaultLiteral(DimType(dk), dim["initial"]?.ToString()));
                owner.DimLocals[dk] = local;
                owner.Initialize.Add((local, "Client." + _cvNames[dk]));
            }
            // popups of the screen
            var modals = _ir.Modals.Where(m => ModalViews(m).Contains(key)).ToList();
            var trees = new List<JsonObject?> { view["root"] as JsonObject };
            var events = new List<string>(EventsOfView(key));
            foreach (var modal in modals)
            {
                var mk = modal["key"]!.ToString();
                var name = modal["name"]!.ToString();
                var popup = new PrototypePopup { Modal = mk, Name = name, Widget = owner.WidgetNames.Free(name + "Popup", 0), IsOpen = Local(owner, name + "IsOpen", "Boolean", "False") };
                foreach (var p in PrototypeCapture.Objects(modal["params"])) popup.Inputs[p["name"]!.ToString()] = Local(owner, name + p["name"], p["type"]?.ToString() ?? "Integer", null);
                popup.Block = _modalBlocks.GetValueOrDefault(mk);
                popup.Collection = modal["record"]?["collection"]?.ToString();
                owner.Popups[mk] = popup;
                if (popup.Block == null)
                {
                    trees.Add(modal["root"] as JsonObject);
                    events.AddRange(EventsOf(mk));
                    // a popup of the screen: its bound source is fetched on demand, when the popup opens
                    BindSources(owner, "m:" + mk, onDemand: true);
                }
            }
            foreach (var e in events) owner.EventKeys.Add(e);
            // toast of the shell
            owner.DimLocals["@aviso"] = Local(owner, "Aviso", "Text", null);
            owner.DimLocals["@avisoErro"] = Local(owner, "AvisoErro", "Boolean", null);
            DimensionLocals(owner, new JsonArray(trees.Select(t => (JsonNode?)t?.DeepClone()).ToArray()), events);
            foreach (var tree in trees) ControlLocals(owner, tree);
            // view records (a record by the screen input), lists, counts and sums
            foreach (var record in PrototypeCapture.Objects(view["records"]))
                if (record["collection"]?.ToString() is { } rc && record["key"]?["param"]?.ToString() is { } param)
                {
                    var agg = NewAggregate(owner, (Pt ? "Obter" : "Get") + PrototypeNames.Pascal(record["name"]!.ToString()), rc);
                    agg.Filters.Add(KeyFilter(rc, param));
                    JoinsFor(agg, view["root"] as JsonObject);
                    owner.Records[record["name"]!.ToString()] = agg;
                }
            Aggregates(owner, trees);
            // popup records: ListIndexOf into a list of the same collection, else an aggregate refreshed when it opens
            foreach (var popup in owner.Popups.Values)
            {
                var modal = _ir.Modal(popup.Modal)!;
                if (modal["record"] is not JsonObject record) continue;
                if (record["new"] is JsonObject)
                {
                    popup.NewRecord = Local(owner, popup.Name + "Registro", EntityName(popup.Collection!), null);
                    continue;
                }
                var listName = record["list"]?.ToString();
                var list = listName != null && owner.ListsByName.TryGetValue(listName, out var l) && l.Collection == popup.Collection ? l
                    : owner.ByList.Values.FirstOrDefault(a => a.Collection == popup.Collection && a.Columns.Count == 0);
                if (list != null)
                {
                    popup.List = list;
                    popup.Index = Local(owner, popup.Name + "Indice", "Integer", "-1");
                    JoinsFor(list, modal["root"] as JsonObject);
                }
                else if (record["key"]?["param"]?.ToString() is { } param && popup.Inputs.TryGetValue(param, out var inputLocal))
                {
                    var agg = NewAggregate(owner, (Pt ? "Obter" : "Get") + popup.Name, popup.Collection!);
                    agg.Filters.Add(KeyFilter(popup.Collection!, inputLocal));
                    JoinsFor(agg, modal["root"] as JsonObject);
                    popup.Record = agg;
                }
            }
            // the shell inputs computed by the screen (a sum of a collection)
            if (_ir.Shell is JsonObject shellNode)
                foreach (var input in PrototypeCapture.Objects(shellNode["inputs"]).Where(i => i["from"]?["sum"] is JsonObject))
                {
                    var sum = (JsonObject)input["from"]!["sum"]!;
                    var agg = NewAggregate(owner, input["name"]!.ToString(), sum["collection"]!.ToString());
                    var scope = AggregateScope(owner, agg);
                    if (sum["where"] is JsonObject where) agg.Filters.Add(PrototypeExpr.Pred(where, scope));
                    agg.Columns.Add((input["name"]!.ToString(), "Sum", ColumnExpression(sum["field"], scope)));
                    owner.Sums["shell:" + input["name"]] = agg;
                }
            // the record inputs of the shell (the record a global dimension selects): an aggregate of the screen by that key
            if (_ir.Shell is JsonObject shellRecords)
                foreach (var input in PrototypeCapture.Objects(shellRecords["inputs"]).Where(i => i["record"] is JsonObject))
                {
                    var record = (JsonObject)input["record"]!;
                    if (record["collection"]?.ToString() is not { } collection || _ir.Collection(collection) == null) continue;
                    if (record["by"]?.ToString() is not { } by || !owner.DimLocals.TryGetValue(by, out var byLocal)) continue;
                    var agg = NewAggregate(owner, input["name"]!.ToString(), collection);
                    agg.Filters.Add(KeyFilter(collection, byLocal));
                    owner.Records["shell:" + input["name"]] = agg;
                }
        }
    }

    internal IEnumerable<string> ShellEventKeys()
    {
        if (_ir.Shell == null) return [];
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var k in PrototypeCapture.EventsOf(_ir.Shell["root"])) keys.Add(k);
        foreach (var n in PrototypeCapture.Objects(_ir.Shell["after"])) foreach (var k in PrototypeCapture.EventsOf(n)) keys.Add(k);
        foreach (var e in PrototypeCapture.Objects(_ir.Shell["events"])) if (e["from"]?.ToString() is { } from) keys.Add(from);
        foreach (var e in _ir.Events) if (e["key"]?.ToString() is { } k && k.StartsWith("shell:", StringComparison.Ordinal)) keys.Add(k);
        return keys;
    }

    internal IEnumerable<string> EventsOf(string modal)
        => _ir.Events.Where(e => e["modal"]?.ToString() == modal).Select(e => e["key"]!.ToString())
            .Concat(PrototypeCapture.EventsOf(_ir.Modal(modal)?["root"])).Distinct(StringComparer.Ordinal);

    internal IEnumerable<string> EventsOfView(string view)
        => _ir.Events.Where(e => e["view"]?.ToString() == view && e["modal"] == null).Select(e => e["key"]!.ToString())
            .Concat(PrototypeCapture.EventsOf(_ir.View(view)?["root"])).Distinct(StringComparer.Ordinal);

    /// <summary>Locals of the screen dimensions this owner reads (in its trees or its events) and of the form controls.</summary>
    private void DimensionLocals(PrototypeOwner owner, JsonNode? trees, IEnumerable<string> events)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var bound = new HashSet<string>(StringComparer.Ordinal);
        void Scan(JsonNode? n)
        {
            switch (n)
            {
                case JsonObject o:
                    if (o["dim"]?.ToString() is { } d) used.Add(d);
                    if (o["dimension"]?.ToString() is { } dd) used.Add(dd);
                    if ((o["control"] as JsonObject)?["dimension"]?.ToString() is { } cd) bound.Add(cd);
                    foreach (var (_, v) in o) Scan(v);
                    break;
                case JsonArray a: foreach (var v in a) Scan(v); break;
            }
        }
        Scan(trees);
        foreach (var key in events) Scan(_ir.Event(key));
        // the dimensions a modal block owns stay in the block (its controls and its reset), never on the screens around it
        var blockDims = owner.Kind == "screen" ? BlockDimensions() : [];
        foreach (var dim in _ir.Dimensions)
        {
            var dk = dim["key"]!.ToString();
            if (owner.DimLocals.ContainsKey(dk) || blockDims.Contains(dk)) continue;
            var views = dim["views"] as JsonArray;
            if (!used.Contains(dk) && !(owner.View != null && views?.Any(v => v?.ToString() == owner.View) == true)) continue;
            if (dim["scope"]?.ToString() == "global")
            {
                // a control of a modal block bound to a global dimension (the account chosen in a login dialog) edits a local
                // copy of the Client Variable, read when the block starts; its setDimension writes both (a native Dropdown
                // needs a variable of its own owner)
                if (owner.Kind != "block" || owner.Modal == null || !bound.Contains(dk) || !_cvNames.TryGetValue(dk, out var cv)) continue;
                var copy = Local(owner, dim["name"]!.ToString(), DimType(dk), DefaultLiteral(DimType(dk), dim["initial"]?.ToString()));
                owner.DimLocals[dk] = copy;
                owner.Initialize.Add((copy, "Client." + cv));
                continue;
            }
            owner.DimLocals[dk] = Local(owner, dim["name"]!.ToString(), DimType(dk), DefaultLiteral(DimType(dk), dim["initial"]?.ToString()));
        }
    }

    private HashSet<string>? _blockDims;

    /// <summary>The dimensions whose control is inside a modal shown by a block (they live in that block).</summary>
    internal HashSet<string> BlockDimensions()
    {
        if (_blockDims != null) return _blockDims;
        _blockDims = new HashSet<string>(StringComparer.Ordinal);
        void Walk(JsonNode? n)
        {
            switch (n)
            {
                case JsonObject o:
                    if (o["control"]?["dimension"]?.ToString() is { } d) _blockDims.Add(d);
                    foreach (var (_, v) in o) Walk(v);
                    break;
                case JsonArray a: foreach (var v in a) Walk(v); break;
            }
        }
        foreach (var modal in _modalBlocks.Keys) Walk(_ir.Modal(modal)?["root"]);
        return _blockDims;
    }

    private void ControlLocals(PrototypeOwner owner, JsonObject? tree)
    {
        void Walk(JsonObject? n)
        {
            if (n == null) return;
            if (n["control"] is JsonObject control && control["var"]?.ToString() is { } name && control["dimension"] == null && !owner.Controls.ContainsKey(name))
            {
                var type = control["kind"]?.ToString() == "checkbox" ? "Boolean" : ControlType(n);
                var initial = control["initial"]?.ToString();
                owner.Controls[name] = (Local(owner, name, type, initial == null ? null : DefaultLiteral(type, initial)), type);
            }
            if (n["message"]?["local"]?.ToString() is { } message && !owner.Controls.ContainsKey(message))
                owner.Controls[message] = (Local(owner, message, "Text", null), "Text");
            foreach (var c in n["c"] as JsonArray ?? []) Walk(c as JsonObject);
            Walk(n["list"]?["template"] as JsonObject);
            foreach (var c in n["else"] as JsonArray ?? []) Walk(c as JsonObject);
        }
        Walk(tree);
    }

    private static string ControlType(JsonObject node)
    {
        string? Attr(string name) => (node["a"] as JsonArray ?? []).OfType<JsonArray>().FirstOrDefault(p => p.Count == 2 && p[0]?.ToString() == name)?[1]?.ToString();
        if (Attr("type") == "number") return Attr("step") is { } step && step.Contains('.') ? "Decimal" : "Integer";
        if (Attr("type") is "date") return "Date";
        if (Attr("type") is "checkbox") return "Boolean";
        // an Input whose type is Email or Phone needs a variable of that type (Verify: Input Type Mismatch)
        if (Attr("type") is "email") return "Email";
        if (Attr("type") is "tel") return "Phone Number";
        return "Text";
    }

    internal PrototypeAggregate NewAggregate(PrototypeOwner owner, string wanted, string collection, string? entity = null)
    {
        var name = owner.LocalNames.Free(wanted, 0);
        var agg = new PrototypeAggregate { Name = name, Alias = $"{(owner.Kind == "screen" ? "$p.scr." + Safe(owner.View!) : "$p.blk." + owner.Name)}.agg.{name}", Collection = collection, Entity = entity ?? EntityName(collection) };
        agg.Reads.Add(collection);
        owner.Aggregates[name] = agg;
        return agg;
    }

    /// <summary>The joins an aggregate needs for the fields read through a foreign key (via) in a tree.</summary>
    internal void JoinsFor(PrototypeAggregate agg, JsonObject? tree)
    {
        void Scan(JsonNode? n)
        {
            switch (n)
            {
                case JsonObject o:
                    if (o["field"] != null && o["via"]?.ToString() is { } via) Join(agg, via);
                    foreach (var (_, v) in o) Scan(v);
                    break;
                case JsonArray a: foreach (var v in a) Scan(v); break;
            }
        }
        Scan(tree);
    }

    internal void Join(PrototypeAggregate agg, string via)
    {
        if (agg.Joins.ContainsKey(via)) return;
        var target = _ir.Collection(agg.Collection)?["references"] is JsonArray refs
            ? refs.OfType<JsonObject>().FirstOrDefault(r => r["field"]?.ToString() == via)?["collection"]?.ToString() : null;
        if (target == null) return;
        agg.Joins[via] = EntityName(target);
        agg.Reads.Add(target);
    }

    /// <summary>The aggregates of the lists, counts and sums of an owner's trees (lists keep the template's joins).</summary>
    private void Aggregates(PrototypeOwner owner, IEnumerable<JsonObject?> trees)
    {
        void Walk(JsonObject? n, JsonObject? tree)
        {
            if (n == null) return;
            if (n["list"] is JsonObject list && list["collection"]?.ToString() is { } collection && _ir.Collection(collection) != null)
            {
                var listName = list["name"]?.ToString() ?? (Pt ? "Lista" : "List") + collection;
                var agg = NewAggregate(owner, PrototypeNames.Pascal(listName), collection);
                agg.ListName = listName;
                JoinsFor(agg, list["template"] as JsonObject);
                var scope = AggregateScope(owner, agg);
                if (list["filter"] is JsonObject filter)
                {
                    try { agg.Filters.Add(PrototypeExpr.Pred(filter, scope)); }
                    catch (PrototypeExpressionException ex) { _plan.Report["unevaluableFilters"] ??= new JsonArray(); ((JsonArray)_plan.Report["unevaluableFilters"]!).Add(new JsonObject { ["k"] = n["k"]?.ToString(), ["why"] = ex.Message }); }
                }
                foreach (var s in PrototypeCapture.Objects(list["sort"]))
                    agg.Sort.Add(($"{agg.Entity}.{s["field"]}", s["dir"]?.ToString() == "desc"));
                if (list["sortBy"] is JsonObject sortBy) agg.SortBy = sortBy;
                owner.ByList[list] = agg;
                owner.ListsByName[listName] = agg;
                Walk(list["template"] as JsonObject, tree);
            }
            if (n["control"] is JsonObject control && n["t"]?.ToString() == "select") Options(owner, control, n);
            foreach (var c in n["c"] as JsonArray ?? []) Walk(c as JsonObject, tree);
            foreach (var c in n["else"] as JsonArray ?? []) Walk(c as JsonObject, tree);
            if (n["toast"]?["template"] is JsonObject t) Walk(t, tree);
        }
        foreach (var tree in trees) Walk(tree, tree);
        // counts read the list; sums get an aggregate of their own (same collection and filter, a Sum column)
        foreach (var tree in trees) SumAggregates(owner, tree);
    }

    private void SumAggregates(PrototypeOwner owner, JsonNode? n)
    {
        switch (n)
        {
            case JsonObject o:
                if (o["sum"] is JsonObject sum && sum["list"]?.ToString() is { } listName && owner.ListsByName.TryGetValue(listName, out var list))
                {
                    var key = listName + ":" + sum["field"]!.ToJsonString();
                    if (!owner.Sums.ContainsKey(key))
                    {
                        var agg = NewAggregate(owner, list.Name + "Total", list.Collection);
                        agg.Filters.AddRange(list.Filters);
                        foreach (var (via, _) in list.Joins) Join(agg, via);
                        JoinsInValue(agg, sum["field"]);
                        agg.Columns.Add(("Total", "Sum", ColumnExpression(sum["field"], AggregateScope(owner, agg))));
                        owner.Sums[key] = agg;
                    }
                }
                foreach (var (_, v) in o) SumAggregates(owner, v);
                break;
            case JsonArray a: foreach (var v in a) SumAggregates(owner, v); break;
        }
    }

    private void JoinsInValue(PrototypeAggregate agg, JsonNode? value)
    {
        switch (value)
        {
            case JsonObject o:
                if (o["field"] != null && o["via"]?.ToString() is { } via) Join(agg, via);
                foreach (var (_, v) in o) JoinsInValue(agg, v);
                break;
            case JsonArray a: foreach (var v in a) JoinsInValue(agg, v); break;
        }
    }

    internal string ColumnExpression(JsonNode? field, PrototypeScope scope)
        => field is JsonValue v ? scope.Field!(v.ToString(), null) : PrototypeExpr.Val(field, scope);

    /// <summary>The options of a select: a static options entity per control (snapshot of its options, or rows by a key field),
    /// read by an aggregate of the owner; or an aggregate of a store collection.</summary>
    private void Options(PrototypeOwner owner, JsonObject control, JsonObject node)
    {
        var key = control["var"]?.ToString() ?? control["field"]?.ToString() ?? node["k"]!.ToString();
        if (owner.Options.ContainsKey(key)) return;
        var options = control["options"] as JsonObject;
        if (options?["collection"]?.ToString() is { } collection && _ir.Collection(collection) != null)
        {
            var agg = NewAggregate(owner, (Pt ? "Opcoes" : "Options") + PrototypeNames.Pascal(key), collection);
            if (options["where"] is JsonObject where) agg.Filters.Add(PrototypeExpr.Pred(where, AggregateScope(owner, agg)));
            // the options in the order of the store (the prototype lists them as the collection holds them)
            agg.Sort.Add(($"{agg.Entity}.{_data.ByCollection(collection)?.Key ?? "Id"}", false));
            owner.Options[key] = agg;
            return;
        }
        var valueType = control["dimension"]?.ToString() is { } dim ? DimType(dim)
            : control["field"]?.ToString() is { } field ? FieldOptionType(owner, field) : "Text";
        var entityName = OptionsEntity(key, control, node, valueType);
        if (entityName == null) return;
        var optionsAgg = NewAggregate(owner, (Pt ? "Opcoes" : "Options") + PrototypeNames.Pascal(key), "@options:" + entityName, entityName);
        optionsAgg.Reads.Clear();
        optionsAgg.Sort.Add(($"{entityName}.Order", false));
        var entity = _data.Options.First(o => o.Name == entityName);
        if (entity.ByKey && options?["byField"]?.ToString() is { } byField)
            optionsAgg.Filters.Add($"{entityName}.Chave = {PopupFieldFor(owner, node, byField)}");
        owner.Options[key] = optionsAgg;
    }

    private string FieldOptionType(PrototypeOwner owner, string field) => "Text";

    /// <summary>The record field a by-key options filter reads (the modal record of this tree).</summary>
    private string PopupFieldFor(PrototypeOwner owner, JsonObject node, string field)
    {
        if (owner.Kind == "block" && owner.Modal != null) return (Pt ? "Registro" : "Record") + "." + field;
        foreach (var popup in owner.Popups.Values)
        {
            if (popup.List != null && popup.Index != null) return $"{popup.List.Name}.List[{popup.Index}].{popup.List.Entity}.{field}";
            if (popup.Record != null) return $"{popup.Record.Name}.List.Current.{popup.Record.Entity}.{field}";
        }
        return "0";
    }

    private string? OptionsEntity(string key, JsonObject control, JsonObject node, string valueType)
    {
        var options = control["options"] as JsonObject;
        var rows = new List<(JsonNode? Key, string Value, string Label, int Order)>();
        var byKey = false;
        string? keyType = null;
        if (options?["rows"] is JsonArray given)
        {
            byKey = options["byField"] != null;
            keyType = "Integer";
            foreach (var r in given.OfType<JsonObject>()) rows.Add((r["key"]?.DeepClone(), r["value"]?.ToString() ?? "", r["label"]?.ToString() ?? "", r["order"]?.GetValue<int>() ?? rows.Count + 1));
        }
        else
        {
            var order = 0;
            foreach (var option in (node["c"] as JsonArray ?? []).OfType<JsonObject>().Where(o => o["t"]?.ToString() == "option"))
            {
                var label = string.Concat((option["c"] as JsonArray ?? []).OfType<JsonObject>().Select(t => t["x"]?.ToString()));
                var value = (option["a"] as JsonArray ?? []).OfType<JsonArray>().FirstOrDefault(p => p[0]?.ToString() == "value")?[1]?.ToString() ?? label;
                rows.Add((null, value, label.Trim(), ++order));
            }
        }
        if (rows.Count == 0) return null;
        var wanted = options?["entity"]?.ToString() is { } e ? e : PrototypeNames.Pascal(key) + (Pt ? "Opcao" : "Option");
        if (_optionEntities.TryGetValue(wanted, out var known)) return known;
        var name = Name("entity", wanted, "options entity");
        _optionEntities[wanted] = name;
        _entityRef["@options:" + name] = Ref("entity", name, "$p.opt." + name);
        _data.Options.Add(new(name, valueType, byKey, keyType, rows, key));
        return name;
    }

    /// <summary>The scope of an aggregate filter or column: attributes of its sources, the owner's locals and inputs.</summary>
    internal PrototypeScope AggregateScope(PrototypeOwner owner, PrototypeAggregate agg)
    {
        var baseScope = OwnerScope(owner);
        return baseScope.With(
            field: (field, via) => via != null && agg.Joins.TryGetValue(via, out var joined) ? $"{joined}.{field}" : via != null ? JoinAndName(agg, via, field) : $"{agg.Entity}.{field}",
            fieldType: (field, via) => FieldType(via != null ? JoinedCollection(agg.Collection, via) : agg.Collection, field));
    }

    private string JoinAndName(PrototypeAggregate agg, string via, string field)
    {
        Join(agg, via);
        return agg.Joins.TryGetValue(via, out var joined) ? $"{joined}.{field}" : $"{agg.Entity}.{field}";
    }

    internal string? JoinedCollection(string collection, string via)
        => _ir.Collection(collection)?["references"] is JsonArray refs ? refs.OfType<JsonObject>().FirstOrDefault(r => r["field"]?.ToString() == via)?["collection"]?.ToString() : null;

    /// <summary>The type of a collection field as expressions see it: Identifier for the key and the foreign keys (an entity
    /// identifier, compared with integers through IdentifierToInteger), else the capture type.</summary>
    internal string? FieldType(string? collection, string field) => FieldTypeOf(_ir, collection, field);

    internal static string? FieldTypeOf(PrototypeCapture ir, string? collection, string field)
    {
        if (collection == null || ir.Collection(collection) is not { } c) return null;
        if (string.Equals(c["key"]?.ToString() ?? "Id", field, StringComparison.Ordinal)) return "Identifier";
        if (PrototypeCapture.Objects(c["references"]).Any(r => r["field"]?.ToString() == field)) return "Identifier";
        return (c["fields"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(f => f["name"]?.ToString() == field)?["type"]?.ToString();
    }

    /// <summary>A filter of the record by its key: the key is an identifier, the parameter an integer.</summary>
    internal string KeyFilter(string collection, string value) => $"IdentifierToInteger({EntityName(collection)}.{_data.ByCollection(collection)!.Key}) = {value}";

    /// <summary>The scope of an owner outside any list: its dimensions (locals or block inputs), inputs, controls, records,
    /// counts and sums. Popup trees add their record on top (<see cref="PopupScope"/>).</summary>
    internal PrototypeScope OwnerScope(PrototypeOwner owner)
    {
        return new PrototypeScope
        {
            Dim = key => owner.DimLocals.TryGetValue(key, out var local) ? local : throw new PrototypeExpressionException($"dimension {key} has no local in {owner.Name}"),
            DimType = key => DimType(key),
            Param = name => owner.Inputs.Any(i => i.Name == name) ? name : throw new PrototypeExpressionException($"{owner.Name} has no input {name}"),
            ParamType = name => owner.Inputs.FirstOrDefault(i => i.Name == name).Type,
            Control = name => owner.Controls.TryGetValue(name, out var c) ? c.Local : throw new PrototypeExpressionException($"control {name} has no local in {owner.Name}"),
            ControlType = name => owner.Controls.TryGetValue(name, out var c) ? c.Type : null,
            Input = name => owner.Kind == "block" && owner.Inputs.Any(i => i.Name == name) ? name
                : name == "Aviso" && owner.DimLocals.TryGetValue("@aviso", out var aviso) ? aviso
                : name == "AvisoErro" && owner.DimLocals.TryGetValue("@avisoErro", out var erro) ? erro
                : throw new PrototypeExpressionException($"{owner.Name} has no input {name}"),
            View = owner.Kind == "screen" ? owner.View : null,
            Record = (record, field, via) => RecordField(owner, record, field, via),
            RecordType = (record, field, via) => RecordFieldType(owner, record, field, via),
            Count = list => owner.ListsByName.TryGetValue(list, out var agg) ? $"{agg.Name}.List.Length" : throw new PrototypeExpressionException($"list {list} is not on {owner.Name}"),
            Sum = (list, sum) => owner.Sums.TryGetValue(list + ":" + sum["field"]!.ToJsonString(), out var agg)
                ? (sum["field"] is JsonValue fv && FieldType(agg.Collection, fv.ToString()) == "Integer" ? $"LongIntegerToInteger({agg.Name}.List.Current.Total)" : $"{agg.Name}.List.Current.Total")
                : throw new PrototypeExpressionException($"sum of {list} is not on {owner.Name}"),
            Local = name => owner.Controls.TryGetValue(name, out var c) ? c.Local : name,
            First = (first, scope) => FirstOption(owner, first, scope),
            FieldType = (_, _) => null,
            InputFieldType = (input, field) => PrototypeCapture.Objects(_ir.Shell?["inputs"]).FirstOrDefault(i => i["name"]?.ToString() == input)?["record"]?["collection"]?.ToString() is { } c
                ? FieldType(c, field) : null,
        };
    }

    private string RecordField(PrototypeOwner owner, string record, string field, string? via)
    {
        if (owner.Records.TryGetValue(record, out var agg))
        {
            if (via != null) { var joined = JoinAndName(agg, via, field); return $"{agg.Name}.List.Current.{joined}"; }
            return $"{agg.Name}.List.Current.{agg.Entity}.{field}";
        }
        var popup = owner.Popups.Values.FirstOrDefault(p => p.Name == record);
        if (popup != null && PopupRecord(popup) is { } expression)
            return via != null && (popup.List ?? popup.Record) is { } source && source.Joins.TryGetValue(via, out var j) ? PopupBase(popup) + "." + j + "." + field : expression + "." + field;
        throw new PrototypeExpressionException($"record {record} is not on {owner.Name}");
    }

    private string? RecordFieldType(PrototypeOwner owner, string record, string field, string? via)
    {
        var collection = owner.Records.TryGetValue(record, out var agg) ? agg.Collection : owner.Popups.Values.FirstOrDefault(p => p.Name == record)?.Collection;
        if (collection != null && via != null) collection = JoinedCollection(collection, via);
        return FieldType(collection, field);
    }

    internal static string? PopupBase(PrototypePopup popup)
        => popup.List != null && popup.Index != null ? $"{popup.List.Name}.List[{popup.Index}]"
            : popup.Record != null ? $"{popup.Record.Name}.List.Current" : null;

    internal string? PopupRecord(PrototypePopup popup)
        => popup.NewRecord ?? (PopupBase(popup) is { } b ? b + "." + EntityName(popup.Collection!) : null);

    /// <summary>The scope inside a popup tree: Val field reads the popup record, Val param the popup inputs.</summary>
    internal PrototypeScope PopupScope(PrototypeOwner owner, PrototypePopup popup)
    {
        var baseScope = OwnerScope(owner);
        var source = popup.List ?? popup.Record;
        return new PrototypeScope
        {
            Dim = baseScope.Dim, DimType = baseScope.DimType, Control = baseScope.Control, ControlType = baseScope.ControlType, Input = baseScope.Input,
            View = baseScope.View, Record = baseScope.Record, RecordType = baseScope.RecordType, Count = baseScope.Count, Sum = baseScope.Sum, Local = baseScope.Local, First = baseScope.First,
            Param = name => popup.Inputs.TryGetValue(name, out var local) ? local : baseScope.Param!(name),
            ParamType = name => popup.Inputs.ContainsKey(name) ? "Integer" : baseScope.ParamType!(name),
            Field = (field, via) =>
            {
                if (popup.NewRecord != null) return $"{popup.NewRecord}.{field}";
                var b = PopupBase(popup) ?? throw new PrototypeExpressionException($"popup {popup.Name} has no record");
                if (via != null && source != null)
                {
                    Join(source, via);
                    if (source.Joins.TryGetValue(via, out var joined)) return $"{b}.{joined}.{field}";
                }
                return $"{b}.{EntityName(popup.Collection!)}.{field}";
            },
            FieldType = (field, via) => FieldType(via != null && popup.Collection != null ? JoinedCollection(popup.Collection, via) : popup.Collection, field),
        };
    }

    /// <summary>The scope of a modal block: the record of its own aggregate, its inputs and locals.</summary>
    internal PrototypeScope ModalBlockScope(PrototypeOwner owner)
    {
        var baseScope = OwnerScope(owner);
        var collection = _ir.Modal(owner.Modal!)?["record"]?["collection"]?.ToString();
        var input = Pt ? "Registro" : "Record";
        return baseScope.With(
            field: (field, via) =>
            {
                if (collection == null) throw new PrototypeExpressionException($"block {owner.Name} has no record");
                if (via != null) throw new PrototypeExpressionException($"block {owner.Name} receives its record only; {via}.{field} is another collection");
                return $"{input}.{field}";
            },
            fieldType: (field, via) => collection == null || via != null ? null : FieldType(collection, field));
    }

    private string FirstOption(PrototypeOwner owner, JsonObject first, PrototypeScope scope)
    {
        // the first option of a by-key options entity for the key of the record (an If over the rows, all known now)
        // the name the options entity got (renamed when the base holds <Prefix><Options>), never the one it wanted
        var entityName = _optionEntities.GetValueOrDefault(first["options"]!.ToString()) ?? first["options"]!.ToString();
        var entity = _data.Options.FirstOrDefault(o => o.Name == entityName || o.Name.EndsWith(first["options"]!.ToString(), StringComparison.Ordinal))
            ?? throw new PrototypeExpressionException($"options {first["options"]} are unknown");
        var key = PrototypeExpr.Val(first["key"], scope);
        if (PrototypeExpr.TypeOf(first["key"], scope) == "Identifier") key = $"IdentifierToInteger({key})";
        var text = entity.ValueType is "Integer" or "Decimal" ? "0" : "\"\"";
        foreach (var group in entity.Rows.Where(r => r.Key != null).GroupBy(r => r.Key!.ToJsonString()).Reverse())
        {
            var row = group.OrderBy(r => r.Order).First();
            text = $"If({key} = {PrototypeExpr.Literal(row.Key, "Integer")}, {PrototypeExpr.Literal(JsonValue.Create(row.Value), entity.ValueType)}, {text})";
        }
        return text;
    }

    // ---- widgets ------------------------------------------------------------------------------------------------------------

    private PrototypeWidgets.Context WidgetContext(PrototypeOwner owner, PrototypeScope scope)
    {
        var context = new PrototypeWidgets.Context
        {
            Platform = Platform, Capture = _ir, Element = _seams.Element!, Scope = scope, Names = owner.WidgetNames,
            ImageOf = path => _imageNames.GetValueOrDefault(path),
            Event = (key, _) => owner.Bindings.GetValueOrDefault(key),
            // a list bound by data.bind iterates the producer's output list (2.12); the others their aggregate
            List = list => list["bound"]?.GetValue<bool>() == true && list["source"]?.ToString() is { } bound
                ? new PrototypeListBinding("", list["itemType"]?.ToString() ?? "", "", new Dictionary<string, string>(), bound, list["item"]?.ToString() ?? bound + ".Current")
                : owner.ByList.TryGetValue(list, out var agg) ? new PrototypeListBinding(agg.Name, agg.Entity, agg.Collection, agg.Joins) : null,
            Variable = (control, s) =>
            {
                // the shell's control of a global dimension edits its local copy of the input (OwnersAndData)
                if (control["dimension"]?.ToString() is { } dim)
                    return owner.Kind == "block" && owner.Modal == null && control["var"]?.ToString() is { } shellControl && owner.Controls.TryGetValue(shellControl, out var copy)
                        ? copy.Local : owner.DimLocals.GetValueOrDefault(dim);
                if (control["var"]?.ToString() is { } v) return owner.Controls.TryGetValue(v, out var c) ? c.Local : null;
                if (control["field"]?.ToString() is { } f && s.Field != null)
                {
                    try { return s.Field(f, null); } catch (PrototypeExpressionException) { return null; }
                }
                return null;
            },
            Options = (control, node) =>
            {
                var key = control["var"]?.ToString() ?? control["field"]?.ToString() ?? node["k"]!.ToString();
                if (!owner.Options.TryGetValue(key, out var agg)) return null;
                var options = control["options"] as JsonObject;
                // Values and Labels read the record of the list by its attributes (Entity.Attribute), as the Studio writes them
                if (options?["collection"] != null)
                    return (agg.Name + ".List", $"{agg.Entity}.{options["value"] ?? "Id"}", $"{agg.Entity}.{options["label"] ?? "Label"}");
                return (agg.Name + ".List", $"{agg.Entity}.Value", $"{agg.Entity}.Label");
            },
            ScreenOf = view => _plan.Screens.GetValueOrDefault(view) ?? view,
        };
        owner.Widgets = context;
        return context;
    }

    private void Collect(PrototypeWidgets.Context context)
    {
        foreach (var (id, cls) in context.IdClasses) _plan.IdClasses[id] = cls;
        foreach (var tag in context.SubstitutedTags) _plan.SubstitutedTags.Add(tag);
        foreach (var cls in context.IconClasses) _plan.IconClasses.Add(cls);
    }

    private void Widgets()
    {
        foreach (var owner in _owners)
        {
            if (owner.Kind == "block" && owner.Modal == null && _ir.Shell is JsonObject shell)
            {
                var context = WidgetContext(owner, OwnerScope(owner));
                var builder = new PrototypeWidgets(context);
                if (shell["root"] is JsonObject root) owner.Roots.AddRange(builder.Nodes(root, context.Scope));
                foreach (var after in PrototypeCapture.Objects(shell["after"])) owner.Roots.AddRange(builder.Nodes(after, context.Scope));
                foreach (var (node, spec) in context.Specs) owner.Specs[node] = spec;
                owner.Parent = owner.Ref;
                _plan.Roots["shell"] = new WidgetNode("IMobileBlock", "shell", null, null, [], null, null, null, null, owner.Roots.ToList(), null, null);
                Collect(context);
            }
            else if (owner.Kind == "block" && owner.Modal is { } modalKey)
            {
                var context = WidgetContext(owner, ModalBlockScope(owner));
                var builder = new PrototypeWidgets(context);
                if (_ir.Modal(modalKey)?["root"] is JsonObject root) owner.Roots.AddRange(builder.Nodes(root, context.Scope));
                foreach (var (node, spec) in context.Specs) owner.Specs[node] = spec;
                owner.Parent = owner.Ref;
                Collect(context);
            }
            else if (owner.Kind == "screen" && owner.View is { } viewKey)
            {
                var view = _ir.View(viewKey)!;
                var context = WidgetContext(owner, OwnerScope(owner));
                var builder = new PrototypeWidgets(context);
                // popups first get their widget names (the view's ids keep theirs)
                // the view's root is the mount itself (its children go in the placeholder), or an element inside it (keepRoot: a
                // section of a spa-sections page, kept with its classes)
                if (view["root"] is JsonObject root) owner.Roots.AddRange(view["keepRoot"]?.GetValue<bool>() == true ? builder.Nodes(root, context.Scope) : builder.Children(root, context.Scope));
                foreach (var popup in owner.Popups.Values)
                {
                    var modal = _ir.Modal(popup.Modal)!;
                    var spec = new PrototypeWidgetSpec { Name = popup.Widget, SourceKey = "m:" + popup.Modal };
                    spec.Properties.Add(("ShowPopup", popup.IsOpen));
                    spec.Properties.Add(("Style", "\"\""));
                    var children = new List<WidgetNode>();
                    if (popup.Block != null)
                    {
                        var instance = new WidgetNode("IMobileBlockInstanceWidget", "m:" + popup.Modal + "/block", null, null, [], null, null, null, null, [], null, "wrapper");
                        var instanceSpec = new PrototypeWidgetSpec { Block = popup.Block, SourceKey = "m:" + popup.Modal, Name = "$p.inst." + Safe(viewKey) + "." + Safe(popup.Modal) };
                        if (PopupRecord(popup) is { } recordExpression) instanceSpec.BlockArguments.Add((Pt ? "Registro" : "Record", recordExpression));
                        else foreach (var (input, local) in popup.Inputs) instanceSpec.BlockArguments.Add((input, local));
                        context.Specs[instance] = instanceSpec;
                        children.Add(instance);
                    }
                    else if (modal["root"] is JsonObject modalRoot) children.AddRange(builder.Nodes(modalRoot, PopupScope(owner, popup)));
                    var widget = new WidgetNode("IPopup", "m:" + popup.Modal, null, null, [], null, null, null, null, children, null, "wrapper");
                    context.Specs[widget] = spec;
                    // a modal the prototype mounted on the body (VisitaCerta 2026-10-12: the page's own transform animation made the
                    // fixed backdrop of a popup inside the placeholder cover only the page) sits beside the shell instance
                    if (_plan.ShellName != null && modal["portal"]?.GetValue<bool>() == true) owner.PortalRoots.Add(widget);
                    else owner.Roots.Add(widget);
                    if (!_plan.Roots.ContainsKey("m:" + popup.Modal)) _plan.Roots["m:" + popup.Modal] = widget;
                }
                foreach (var (node, s) in context.Specs) owner.Specs[node] = s;
                owner.Parent = _plan.ShellName != null ? ShellInstance(owner) + "/Content" : owner.Ref;
                _plan.Roots["v:" + viewKey] = new WidgetNode("Content", view["root"]?["k"]?.ToString() ?? "v:" + viewKey, null, null, [], null, null, null, null, owner.Roots.ToList(), null, "wrapper");
                Collect(context);
            }
        }
        // a modal block's content is the popup content on every screen that shows it
        foreach (var owner in _owners.Where(o => o.Kind == "block" && o.Modal != null))
            if (_plan.Roots.TryGetValue("m:" + owner.Modal, out var popupRoot))
                _plan.Roots["m:" + owner.Modal] = popupRoot with { Children = [new WidgetNode("IMobileBlockInstanceWidget", "m:" + owner.Modal + "/block", null, null, [], null, null, null, null, owner.Roots.ToList(), null, "wrapper")] };
    }

    private void Stylesheet()
    {
        var request = new PrototypeCssRequest(_ir.Json, _ir.BundleRoot, Platform, _module.Name, _plan.AssetUrls, _plan.IdClasses, _plan.SubstitutedTags.ToList(), _plan.Roots);
        var result = _seams.Css!(request);
        _plan.StyleSheet = result.StyleSheet;
        _plan.CssReport = result.Report;
        NativeLayout();
        var missing = _plan.IconClasses.Where(c => result.IconClasses.Count > 0 && !result.IconClasses.Values.Contains(c)).OrderBy(c => c, StringComparer.Ordinal).ToList();
        if (missing.Count > 0) _plan.Report["iconClassesWithoutRule"] = new JsonArray(missing.Select(m => (JsonNode)m).ToArray());
    }

    /// <summary>F1 of the html op in the import (round 6 of fix/data-table): when a List of the import is a part of a table (it carries
    /// the rows marker, PrototypeWidgets.ListWidget), the import's theme carries the native layout block (ScreenVisual.NativeLayoutCss,
    /// once, after the prototype's CSS) that lays it out as the table's row group, and the receipt says it (nativeLayout). No such
    /// List, no block: an import of native Tables only is what it was. B2 of the review of round 6 (round 7): a marker of the engine
    /// the prototype writes itself (data-ssam-page, data-ssam-gap, data-ssam-rows on an element that is no table part; the importer
    /// neither refuses nor removes it) is said apart (prototypeMarkers), so the note stays true: the block's rules reach those
    /// elements too, from the import on.</summary>
    private void NativeLayout()
    {
        var lists = new List<(string Key, string Why)>();
        var marked = new List<(string Key, string Marker)>();
        var rows = false;
        var seen = new HashSet<WidgetNode>(ReferenceEqualityComparer.Instance);
        void Walk(WidgetNode node)
        {
            if (!seen.Add(node)) return;
            var part = node.W == "IList" ? ScreenVisual.TablePartReason(node.Tag ?? "") : null;
            foreach (var (name, _) in node.Attributes)
            {
                if (ScreenVisual.EngineMarkers.FirstOrDefault(m => string.Equals(m, name, StringComparison.OrdinalIgnoreCase)) is not { } marker) continue;
                // the importer writes only the rows marker, only on the List of a table part: any other marker is the prototype's
                if (marker == ScreenVisual.RowsMarker && node.W == "IList") rows = true;
                if (marker == ScreenVisual.RowsMarker && part != null) lists.Add((node.K ?? "", part));
                else marked.Add((node.K ?? "", marker));
            }
            foreach (var child in node.Children) Walk(child);
            foreach (var child in node.Else ?? []) Walk(child);
        }
        foreach (var root in _plan.Roots.Values) Walk(root);
        // the block is written for a List that carries the rows marker (round 6), whoever wrote it
        if (!rows) return;
        _plan.StyleSheet = ScreenVisual.WithNativeLayout(_plan.StyleSheet ?? "", out var action);
        var keys = lists.Select(l => l.Key).Distinct(StringComparer.Ordinal).ToList();
        var layout = new JsonObject
        {
            ["code"] = ScreenVisual.ThemeNativeLayout, ["theme"] = _plan.ThemeName, ["version"] = ScreenVisual.NativeLayoutVersion, ["action"] = action,
            ["note"] = marked.Count == 0
                ? $"the theme of the import carries the native layout block of the html op after the prototype's CSS; only its rules of {ScreenVisual.RowsMarker} reach the import (the importer marks only the List of a table part)"
                : $"the theme of the import carries the native layout block of the html op after the prototype's CSS; its rules reach "
                    + (keys.Count > 0 ? $"the List(s) of a table part the importer marks ({ScreenVisual.RowsMarker}, lists) and " : "")
                    + $"the {marked.Count} marker(s) of the engine the prototype writes itself (prototypeMarkers), from the import on",
        };
        if (keys.Count > 0)
            layout["lists"] = new JsonObject
            {
                ["code"] = ScreenVisual.ListRendersAllRows, ["element"] = "List", ["count"] = keys.Count,
                ["keys"] = new JsonArray(keys.Take(10).Select(k => (JsonNode)k).ToArray()),
                ["note"] = ScreenVisual.AllRowsNote(string.Join("; ", lists.Select(l => l.Why).Where(w => w.Length > 0).Distinct(StringComparer.Ordinal))),
            };
        if (marked.Count > 0)
            layout["prototypeMarkers"] = new JsonObject
            {
                ["count"] = marked.Count,
                ["elements"] = new JsonArray(marked.Take(10).Select(m => (JsonNode)$"{m.Key} ({m.Marker})").ToArray()),
                ["note"] = $"markers of the engine the prototype writes itself ({string.Join(", ", ScreenVisual.EngineMarkers.Where(e => marked.Any(m => m.Marker == e)))}): the importer neither writes nor removes them and the block's rules reach those elements from the import on; an html edit of the screen decides {ScreenVisual.GapMarker} again on its links, buttons and forms (HTML_MARKER_DECIDED) and keeps {ScreenVisual.PageMarker} and {ScreenVisual.RowsMarker} as written",
            };
        _plan.Report["nativeLayout"] = layout;
    }

    // ---- steps ------------------------------------------------------------------------------------------------------------

    private static string NativeType(string type) => PrototypeDataModel.NativeType(type);

    private void Steps()
    {
        var steps = _plan.Steps;
        // data.bind (2.12): the producer's elements the binding reads, referenced first (Manage Dependencies headless, the verb
        // reference); a frozen signature (.avsig) was imported before the edit transaction by the job runner
        if (_ir.Bind is { ProducerFile: { } producerFile } bind && !producerFile.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase) && bind.Elements.Count > 0)
            steps.Add(new("reference", "producer reference", [new JsonObject { ["op"] = "reference", ["producer"] = producerFile, ["elements"] = new JsonArray(bind.Elements.Select(e => (JsonNode)e).ToArray()) }]));
        // images
        var images = new List<JsonObject>();
        foreach (var asset in _ir.Assets)
        {
            var path = asset["path"]!.ToString();
            var name = _imageNames[path];
            var existing = Existing("image", name);
            if (existing != null) continue;
            var alias = "$p.img." + name;
            images.Add(Create("@espace", "IImage", name, alias, new JsonObject { ["binary"] = Convert.ToBase64String(_ir.AssetBytes(asset)) }));
            images.Add(Set(alias, "Description", Describe($"Asset {path} of the prototype (sha256 {asset["sha256"]}).")));
        }
        steps.Add(new("images", "images", images));
        steps.Add(new("spec", "spec", DataOps()));
        // theme: BaseTheme null; its stylesheet is written without CodeFormat by the session (special step)
        var theme = new List<JsonObject>();
        if (_themeRef.StartsWith('$')) theme.Add(Create("@espace", "IMobileTheme", _plan.ThemeName, _themeRef));
        theme.Add(Set(_themeRef, "Description", Describe("Stylesheet of the prototype, verbatim, with the closed list of rewrites (docs/PROTOTIPO-NATIVO.md 4.1).")));
        theme.Add(Set(_themeRef, "BaseTheme", null));
        steps.Add(new("theme", "theme", theme));
        steps.Add(new("theme", "theme stylesheet", Special: "stylesheet", Arguments: new JsonObject { ["theme"] = _themeRef, ["styleSheet"] = _plan.StyleSheet ?? "" }));
        // flow
        var flow = new List<JsonObject>();
        if (_flowRef.StartsWith('$')) flow.Add(Create("@espace", "IMobileFlow", _plan.FlowName, _flowRef));
        flow.Add(Set(_flowRef, "Theme", _themeRef));
        steps.Add(new("flow", "flow", flow));
        // client variables of the global dimensions
        var cvs = new List<JsonObject>();
        foreach (var dim in _ir.Dimensions.Where(d => d["scope"]?.ToString() == "global"))
        {
            var key = dim["key"]!.ToString();
            var name = _cvNames[key];
            var existing = Existing("clientVariable", name);
            var reference = existing != null ? "@" + existing.Key : "$p.cv." + name;
            if (existing == null) cvs.Add(Create("@espace", "IClientVariable", name, reference));
            cvs.Add(Set(reference, "DataType", DimType(key)));
            cvs.Add(Set(reference, "DefaultValue", DefaultLiteral(DimType(key), dim["initial"]?.ToString())));
            cvs.Add(Set(reference, "Description", Describe($"Dimension {key} of the prototype (global: it changes the shell or survives navigation).")));
            _plan.Report["clientVariables"] ??= new JsonArray();
            ((JsonArray)_plan.Report["clientVariables"]!).Add(new JsonObject { ["name"] = name, ["type"] = DimType(key), ["default"] = dim["initial"]?.ToString() });
        }
        steps.Add(new("clientVariables", "client variables", cvs));
        // server actions
        var server = _logic!.ServerDeclarations().ToList();
        steps.Add(new("logic:server", "server actions", server.Count > 0 ? [new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(server.Select(d => (JsonNode)d.DeepClone()).ToArray()) } }] : []));
        // every block and screen exists before any content (navigation and block instances point forward), then the blocks,
        // then the screens
        var declarations = new List<JsonObject>();
        foreach (var owner in _owners.Where(o => o.Kind == "block").Concat(_owners.Where(o => o.Kind == "screen")))
        {
            if (owner.ExistingKey == null) declarations.Add(Create(_flowRef, owner.Kind == "block" ? "IMobileBlock" : "IMobileScreen", owner.Name, owner.Ref));
        }
        steps.Add(new("ui", "blocks and screens", declarations));
        // the canonical references of the blocks and screens (IMobileScreen:Name) answer from the session's handles, so the
        // logic's Destination, owner and trigger references never sweep the module
        var names = new JsonObject();
        foreach (var owner in _owners) names[(owner.Kind == "block" ? "IMobileBlock:" : "IMobileScreen:") + owner.Name] = owner.Ref;
        steps.Add(new("ui", "references", Special: "handles", Arguments: names));
        // a cleared owner gets its inputs again; the inputs exist before any Destination or instance passes them
        var inputs = new List<JsonObject>();
        foreach (var owner in _owners)
        {
            if (owner.ExistingKey != null) steps.Add(new(owner.Kind, $"clear {owner.Name}", Special: "clear", Arguments: new JsonObject { ["owner"] = owner.Ref, ["kind"] = owner.Kind }));
            foreach (var (name, type, mandatory) in owner.Inputs)
            {
                var alias = $"{owner.Ref}.in.{name}";
                inputs.Add(Create(owner.Ref, "IInputParameter", name, alias));
                inputs.Add(Set(alias, "DataType", NativeType(type)));
                inputs.Add(Set(alias, "IsMandatory", mandatory));
            }
        }
        steps.Add(new("ui", "inputs", inputs));
        // the content of the blocks, then of the screens; then ONE logic op with every screen and block action (the module is
        // read once for its names), the wiring of lifecycle and aggregate events, and the widgets of each owner
        var ordered = _owners.Where(o => o.Kind == "block").Concat(_owners.Where(o => o.Kind == "screen")).ToList();
        foreach (var owner in ordered) OwnerSteps(owner);
        var actions = ordered.SelectMany(o => o.Actions).Select(a => (JsonNode)a.DeepClone()).ToArray();
        steps.Add(new("logic:ui", "screen and block actions", actions.Length > 0 ? [new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(actions) } }] : []));
        steps.Add(new("wiring", "wiring", ordered.SelectMany(o => o.Wiring.Where(w => !(w["target"]?.ToString() ?? "").StartsWith("$p.inst.", StringComparison.Ordinal))).ToList()));
        foreach (var owner in ordered)
        {
            steps.Add(new("widgets", $"widgets {owner.Name}", Widgets: new PrototypeWidgetsJob(owner.Ref, owner.Parent, owner.Roots, owner.Specs, owner.Name)));
            if (owner.PortalRoots.Count > 0) steps.Add(new("widgets", $"popups {owner.Name}", Widgets: new PrototypeWidgetsJob(owner.Ref, owner.Ref, owner.PortalRoots, owner.Specs, owner.Name)));
        }
        steps.Add(new("wiring", "block instance handlers", ordered.SelectMany(o => o.Wiring.Where(w => (w["target"]?.ToString() ?? "").StartsWith("$p.inst.", StringComparison.Ordinal))).ToList()));
        if (_ir.Data["home"]?.GetValue<bool>() == true && _ir.Views.FirstOrDefault(v => v["default"]?.GetValue<bool>() == true)?["key"]?.ToString() is { } home)
            steps.Add(new("home", "default screen", [Set("@espace", "DefaultScreen", ScreenOf(home)!.Ref)]));
        // 1.6: the marked elements of a previous import that this capture no longer produces
        foreach (var element in _module.Elements)
        {
            var scope = ScopeKinds.FirstOrDefault(s => s.Key != "exception" && s.Value.Contains(element.Kind)).Key;
            if (scope == null || !PrototypeNames.IsMarked(element.Description, Prefix) || _produced.Contains((scope, element.Name))) continue;
            _plan.Vanished.Add(element);
        }
        if (_plan.Vanished.Count > 0) steps.Add(new("vanished", "vanished marked elements", Special: "vanished"));
        steps.Add(new("flow", "flow description", Special: "flow-description", Arguments: new JsonObject { ["flow"] = _flowRef }));
        steps.Add(new("render", "render", Special: "render"));
        // the plan's hash depends on what decides the plan and not on the module: the capture, the options of the call and the
        // build of the compiler. The same capture over the module it produced (every element there, marked, nothing vanished)
        // is NO_CHANGE.
        var options = _ir.Data.DeepClone().AsObject();
        foreach (var key in new[] { "capture", "captureSha256", "source", "entry", "seed" }.Concat(options.Select(p => p.Key).Where(k => k.StartsWith('_')).ToList())) options.Remove(key);
        _plan.PlanSha = PrototypeExpander.Sha(PrototypeCapture.Canonical(new JsonObject
        {
            ["capture"] = _ir.Sha256, ["options"] = options, ["platform"] = Platform, ["module"] = _module.Name, ["compiler"] = PrototypeExpander.CompilerId,
        }));
        var flowElement = _module.Elements.FirstOrDefault(e => e.Kind == "IMobileFlow" && e.Name == _plan.FlowName && PrototypeNames.IsMarked(e.Description, Prefix));
        var complete = _produced.All(p => p.Scope == "exception" ? _module.Elements.Any(e => e.Kind == "IUserException" && string.Equals(e.Name, p.Name, StringComparison.OrdinalIgnoreCase)) : Existing(p.Scope, p.Name) != null);
        if (flowElement?.Description is { } fd && fd.Contains("capture " + _ir.Sha256, StringComparison.Ordinal) && fd.Contains("plan " + _plan.PlanSha, StringComparison.Ordinal)
            && complete && _plan.Vanished.Count == 0)
            _plan.NoChange = true;
        foreach (var step in steps.Where(s => s.Special == "flow-description")) step.Arguments!["description"] = FlowDescription();
    }

    /// <summary>A regular entity of the receipt; attributes (field of the capture -> attribute) when a field got another name, so
    /// the seed writes each row value to its attribute.</summary>
    private JsonObject EntityReport(PrototypeDataModel.Entity e)
    {
        var o = new JsonObject { ["name"] = e.Name, ["collection"] = e.Collection, ["rows"] = e.Rows.Count, ["autoNumber"] = false };
        var attributes = new JsonObject();
        foreach (var (field, attribute) in _ir.AttributeMap) if (e.Fields.Any(f => f.Name == attribute)) attributes[field] = attribute;
        if (attributes.Count > 0) o["attributes"] = attributes;
        return o;
    }

    internal string FlowDescription() => Describe($"Prototype {Prefix} imported as native screens.\ncapture {_ir.Sha256}\nplan {_plan.PlanSha}");

    internal static JsonObject WidgetsCanonical(PrototypeWidgetsJob job)
    {
        JsonObject Node(WidgetNode n)
        {
            var spec = job.Specs.GetValueOrDefault(n);
            return new JsonObject
            {
                ["w"] = n.W, ["k"] = n.K, ["tag"] = n.Tag, ["name"] = spec?.Name,
                ["p"] = spec == null ? null : new JsonArray(spec.Properties.Select(p => (JsonNode)new JsonArray(p.Property, p.Value)).ToArray()),
                ["x"] = spec == null ? null : new JsonArray(spec.Extended.Select(p => (JsonNode)new JsonArray(p.Name, p.Value)).ToArray()),
                ["h"] = spec?.Handler == null ? null : $"{spec.Handler.Event}:{spec.Handler.Screen}:{spec.Handler.Action}:{string.Join(",", spec.Handler.Arguments.Select(a => a.Argument + "=" + a.Value))}",
                ["b"] = spec?.Block, ["c"] = new JsonArray(n.Children.Select(c => (JsonNode)Node(c)).ToArray()),
                ["e"] = n.Else == null ? null : new JsonArray(n.Else.Select(c => (JsonNode)Node(c)).ToArray()),
            };
        }
        return new JsonObject { ["owner"] = job.OwnerName, ["parent"] = job.Parent, ["roots"] = new JsonArray(job.Roots.Select(r => (JsonNode)Node(r)).ToArray()) };
    }

    private List<JsonObject> DataOps()
    {
        var ops = new List<JsonObject>();
        var fields = new List<JsonObject>();
        var records = new List<JsonObject>();
        // the user exception of the validations
        if (_exceptionRef.StartsWith('$')) ops.Add(Create("@espace", "IUserException", _exception, _exceptionRef));
        foreach (var entity in _data.Entities)
        {
            var reference = _entityRef[entity.Collection];
            var existing = reference.StartsWith('@') ? _module.ChildrenOf(reference[1..]) : [];
            var kind = entity.Static ? "IStaticEntity" : "IServerEntity";
            if (!reference.StartsWith('@'))
            {
                ops.Add(Create("@espace", kind, entity.Name, reference));
                ops.Add(Create(reference, "IEntityAttribute", entity.Key, reference + "." + entity.Key));
                // the key of a collection of one reference (a Set of favorite properties) is that reference
                var keyField = entity.Fields.FirstOrDefault(f => f.Name == entity.Key);
                ops.Add(Set(reference + "." + entity.Key, "DataType", keyField?.References != null ? _data.FieldDataType(entity, keyField) : "Integer"));
                ops.Add(Set(reference + "." + entity.Key, "Description", keyField?.References != null
                    ? $"Key: the {_data.ByCollection(keyField.References)?.Name ?? keyField.References} it holds (field {keyField.Name} of the prototype collection {entity.Collection})."
                    : $"Key of {entity.Name}: the id the prototype collection {entity.Collection} shows (no AutoNumber)."));
                ops.Add(Set(reference + "." + entity.Key, "IsAutoNumber", "No"));
                ops.Add(Set(reference, "IdentifierAttribute", reference + "." + entity.Key));
                if (entity.Static)
                {
                    ops.Add(Create(reference, "IEntityAttribute", "Label", reference + ".Label"));
                    ops.Add(Set(reference + ".Label", "DataType", "Text"));
                    ops.Add(Set(reference + ".Label", "Length", 250));
                    ops.Add(Set(reference + ".Label", "Description", "Label of the record, what a list or a select of the prototype shows."));
                    ops.Add(Set(reference, "LabelAttribute", reference + ".Label"));
                    ops.Add(Create(reference, "IEntityAttribute", "Order", reference + ".Order"));
                    ops.Add(Set(reference + ".Order", "DataType", "Integer"));
                    ops.Add(Set(reference + ".Order", "Description", "Order of the record, the order of the prototype data."));
                    ops.Add(Set(reference, "OrderByAttribute", reference + ".Order"));
                }
            }
            ops.Add(Set(reference, "Description", Describe(entity.Static
                ? $"Collection {entity.Collection} of the prototype store; no event writes it, so its rows are static records."
                : $"Collection {entity.Collection} of the prototype store, written by its events; Integer Id without AutoNumber (the prototype keys show on screen), rows written by the seed after publication.")));
            // a field label/order of a static entity IS its built-in Label/Order, in any case (PrototypeFieldNames gave it that name)
            foreach (var field in entity.Fields.Where(f => f.Name != entity.Key && !(entity.Static && PrototypeDataModel.IsBuiltIn(f.Name))))
            {
                var attribute = existing.FirstOrDefault(c => c.Kind == "IEntityAttribute" && c.Name == field.Name);
                var attrRef = attribute != null ? "@" + attribute.Key : reference + "." + field.Name;
                if (attribute == null) fields.Add(Create(reference, "IEntityAttribute", field.Name, attrRef));
                fields.Add(Set(attrRef, "DataType", _data.FieldDataType(entity, field)));
                if (field.Type == "Text" && field.References == null) fields.Add(Set(attrRef, "Length", field.Length ?? 250));
                fields.Add(Set(attrRef, "Description", field.References != null
                    ? $"Reference to {_data.ByCollection(field.References)?.Name ?? field.References} (field {field.Name} of the prototype collection {entity.Collection})."
                    : $"Field {field.Name} of the prototype collection {entity.Collection} ({field.Type})."));
            }
            if (!entity.Static) continue;
            var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var order = 0;
            foreach (var row in entity.Rows.OfType<JsonObject>())
            {
                order++;
                var name = PrototypeDataModel.RecordName(entity, row, taken);
                var record = existing.FirstOrDefault(c => c.Kind == "IRecord" && c.Name == name);
                var recordRef = record != null ? "@" + record.Key : $"{reference}.rec.{name}";
                if (record == null) records.Add(Create(reference, "IRecord", name, recordRef));
                records.Add(Set(recordRef + "/" + entity.Key, "Value", PrototypeExpr.Literal(row[entity.Key], "Integer")));
                records.Add(Set(recordRef + "/Label", "Value", PrototypeExpr.Quote(Truncate(PrototypeDataModel.RecordLabel(entity, row), 250))));
                records.Add(Set(recordRef + "/Order", "Value", PrototypeDataModel.BuiltInValue(entity, row, "Order") is { } ownOrder ? ownOrder.ToString() : order.ToString()));
                foreach (var field in entity.Fields.Where(f => f.Name != entity.Key && !PrototypeDataModel.IsBuiltIn(f.Name)))
                    if (row[field.Name] is { } v) records.Add(Set(recordRef + "/" + field.Name, "Value", field.References != null ? PrototypeExpr.Literal(v, "Integer") : PrototypeDataModel.FieldLiteral(field, v)));
            }
        }
        foreach (var options in _data.Options)
        {
            var reference = _entityRef["@options:" + options.Name];
            var existing = reference.StartsWith('@') ? _module.ChildrenOf(reference[1..]) : [];
            if (!reference.StartsWith('@'))
            {
                ops.Add(Create("@espace", "IStaticEntity", options.Name, reference));
                ops.Add(Create(reference, "IEntityAttribute", "Id", reference + ".Id"));
                ops.Add(Set(reference + ".Id", "DataType", "Integer"));
                ops.Add(Set(reference + ".Id", "IsAutoNumber", "No"));
                ops.Add(Set(reference + ".Id", "Description", "Key of the option, its position among the options."));
                ops.Add(Set(reference, "IdentifierAttribute", reference + ".Id"));
                ops.Add(Create(reference, "IEntityAttribute", "Label", reference + ".Label"));
                ops.Add(Set(reference + ".Label", "DataType", "Text"));
                ops.Add(Set(reference + ".Label", "Length", 250));
                ops.Add(Set(reference + ".Label", "Description", "Text the option shows."));
                ops.Add(Set(reference, "LabelAttribute", reference + ".Label"));
                ops.Add(Create(reference, "IEntityAttribute", "Order", reference + ".Order"));
                ops.Add(Set(reference + ".Order", "DataType", "Integer"));
                ops.Add(Set(reference + ".Order", "Description", "Order of the option in the control."));
                ops.Add(Set(reference, "OrderByAttribute", reference + ".Order"));
            }
            ops.Add(Set(reference, "Description", Describe($"Options of the control {options.Control} of the prototype" + (options.ByKey ? ", by the key of the record shown." : "."))));
            foreach (var (attribute, type) in new[] { ("Value", options.ValueType) }.Concat(options.ByKey ? [("Chave", "Integer")] : []))
            {
                var current = existing.FirstOrDefault(c => c.Kind == "IEntityAttribute" && c.Name == attribute);
                var attrRef = current != null ? "@" + current.Key : reference + "." + attribute;
                if (current == null) fields.Add(Create(reference, "IEntityAttribute", attribute, attrRef));
                fields.Add(Set(attrRef, "DataType", NativeType(type)));
                if (type == "Text") fields.Add(Set(attrRef, "Length", 250));
                fields.Add(Set(attrRef, "Description", attribute == "Value" ? $"Value the control {options.Control} sends when this option is chosen." : "Key of the record whose options these are."));
            }
            var n = 0;
            var staticRows = new JsonArray();
            _plan.StaticRows[options.Name] = staticRows;
            foreach (var row in options.Rows)
            {
                n++;
                var staticRow = new JsonObject { ["Id"] = n, ["Label"] = row.Label, ["Order"] = row.Order, ["Value"] = TypedValue(row.Value, options.ValueType) };
                if (options.ByKey) staticRow["Chave"] = row.Key?.DeepClone();
                staticRows.Add(staticRow);
                var name = "Opcao" + n;
                var current = existing.FirstOrDefault(c => c.Kind == "IRecord" && c.Name == name);
                var recordRef = current != null ? "@" + current.Key : $"{reference}.rec.{name}";
                if (current == null) records.Add(Create(reference, "IRecord", name, recordRef));
                records.Add(Set(recordRef + "/Id", "Value", n.ToString()));
                records.Add(Set(recordRef + "/Label", "Value", PrototypeExpr.Quote(Truncate(row.Label, 250))));
                records.Add(Set(recordRef + "/Order", "Value", row.Order.ToString()));
                records.Add(Set(recordRef + "/Value", "Value", PrototypeExpr.Literal(JsonValue.Create(row.Value), options.ValueType)));
                if (options.ByKey) records.Add(Set(recordRef + "/Chave", "Value", PrototypeExpr.Literal(row.Key, "Integer")));
            }
        }
        ops.AddRange(fields);
        ops.AddRange(records);
        return ops;
    }

    private static string Truncate(string text, int length) => text.Length > length ? text[..length] : text;

    /// <summary>An option value as the JSON of its type (the read-back compares it with the bound variable).</summary>
    private static JsonNode? TypedValue(string value, string type) => type switch
    {
        "Integer" when long.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var i) => i,
        "Decimal" when decimal.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) => d,
        "Boolean" when bool.TryParse(value, out var b) => b,
        _ => value,
    };

    private void OwnerSteps(PrototypeOwner owner)
    {
        var steps = _plan.Steps;
        var ops = new List<JsonObject>();
        var phase = owner.Kind == "block" ? "block" : "screen";
        ops.Add(Set(owner.Ref, "Description", Describe(owner.Description ?? owner.Name)));
        if (owner.Kind == "screen")
        {
            // everyone gets in: O11 role Anonymous, ODC AnonymousAccess (3.6)
            if (Platform == "odc") ops.Add(Set(owner.Ref, "AnonymousAccess", true));
            else ops.Add(Set(owner.Ref, "Roles", new JsonArray("IRole:Anonymous")));
        }
        foreach (var (eventName, parameters) in owner.BlockEvents)
        {
            var alias = $"{owner.Ref}.ev.{eventName}";
            ops.Add(Create(owner.Ref, "IBlockEvent", eventName, alias));
            ops.Add(Set(alias, "IsMandatory", false));
            foreach (var (name, type) in parameters)
            {
                ops.Add(Create(alias, "IInputParameter", name, $"{alias}.{name}"));
                ops.Add(Set($"{alias}.{name}", "DataType", NativeType(type)));
            }
        }
        foreach (var local in owner.Locals)
        {
            var alias = $"{owner.Ref}.var.{local.Name}";
            ops.Add(Create(owner.Ref, "ILocalVariable", local.Name, alias));
            ops.Add(Set(alias, "DataType", NativeType(local.Type)));
            if (local.Default != null) ops.Add(Set(alias, "DefaultValue", local.Default));
        }
        foreach (var agg in owner.Aggregates.Values) ops.AddRange(AggregateOps(owner, agg));
        foreach (var (source, alias, onDemand) in owner.DataActions) ops.AddRange(DataActionOps(owner, source, alias, onDemand));
        if (owner.Kind == "screen")
        {
            if (_plan.ShellName != null && Shell is { } shell)
            {
                // the shell instance is the screen's first widget (a screen of a flow whose theme has no layout is born empty);
                // a screen imported before keeps its instance (and its key)
                var layout = ShellInstance(owner);
                if (owner.ExistingKey == null)
                {
                    var create = Create(owner.Ref, "IMobileBlockInstanceWidget", null, layout);
                    create["source"] = shell.Ref;
                    ops.Add(create);
                }
                else
                {
                    var setLayout = Set(layout, "SourceBlock", shell.Ref);
                    setLayout["empty"] = true;
                    ops.Add(setLayout);
                }
                foreach (var (input, type, _) in shell.Inputs)
                {
                    var value = ShellArgument(owner, input, type);
                    if (value != null) ops.Add(Set(layout + "/" + input, "Value", value));
                }
            }
        }
        steps.Add(new(phase, $"{owner.Kind} {owner.Name}", ops));
    }

    /// <summary>The shell instance of a screen: created by this import (an alias), or the one a previous import left.</summary>
    internal string ShellInstance(PrototypeOwner screen)
        => screen.ExistingKey != null ? screen.Ref + "/#IMobileBlockInstanceWidget" : "$p.inst.shell." + Safe(screen.View!);

    /// <summary>The value a screen passes to an input of the shell: the view, a dimension local, a sum aggregate, the toast.</summary>
    private string? ShellArgument(PrototypeOwner screen, string input, string type)
    {
        if (input == "View") return PrototypeExpr.Quote(screen.View ?? "");
        var shellInput = PrototypeCapture.Objects(_ir.Shell?["inputs"]).FirstOrDefault(i => i["name"]?.ToString() == input);
        if (shellInput?["dimension"]?.ToString() is { } dim && screen.DimLocals.TryGetValue(dim, out var local)) return local;
        if (shellInput?["toast"]?.ToString() == "text") return screen.DimLocals["@aviso"];
        if (shellInput?["toast"]?.ToString() == "error") return screen.DimLocals["@avisoErro"];
        if (input == "Aviso") return screen.DimLocals["@aviso"];
        if (input == "AvisoErro") return screen.DimLocals["@avisoErro"];
        if (screen.Sums.TryGetValue("shell:" + input, out var agg))
            return type == "Integer" ? $"LongIntegerToInteger({agg.Name}.List.Current.{agg.Columns[0].Name})" : $"{agg.Name}.List.Current.{agg.Columns[0].Name}";
        if (screen.Records.TryGetValue("shell:" + input, out var record)) return $"{record.Name}.List.Current.{record.Entity}";
        return null;
    }

    /// <summary>A Data Action that calls the producer's server action and exposes its outputs: the ops of HtmlExpander.ActionSource
    /// (data action, outputs, Start, one Execute Server Action, one Assign, End, layout), fetched at start or on demand.</summary>
    private IEnumerable<JsonObject> DataActionOps(PrototypeOwner owner, PrototypeBindSource source, string alias, bool onDemand)
    {
        yield return Create(owner.Ref, "IDataAction", source.As, alias);
        yield return OpOf(("op", "delete"), ("target", alias + "/Out1"));
        yield return Set(alias, "Description", Describe($"Data of the prototype {(source.Owner.StartsWith("m:", StringComparison.Ordinal) ? "popup " + source.Owner[2..] : "view " + source.Owner[2..])}: {_ir.Bind!.Producer}.{source.Action} (data.bind)."));
        if (onDemand) yield return Set(alias, "Fetch", "OnDemand");
        foreach (var output in source.Outputs)
        {
            yield return Create(alias, "IOutputParameter", output.Name, $"{alias}.out.{output.Name}");
            yield return Set($"{alias}.out.{output.Name}", "DataType", output.Type);
        }
        yield return Create(alias, "IStartNode", null, alias + ".start");
        yield return Create(alias, "IExecuteServerActionNode", "ReadSource", alias + ".call");
        yield return Set(alias + ".call", "Action", "IServerAction:" + source.Action);
        foreach (var (input, value) in source.Args) yield return Set(alias + ".call/" + input, "Value", value);
        yield return Create(alias, "IAssignNode", null, alias + ".assign");
        yield return Set(alias + ".assign", "Label", "SetOutputs");
        var i = 0;
        foreach (var output in source.Outputs)
        {
            i++;
            yield return Create(alias + ".assign", "IAssignment", null, $"{alias}.assign.{i}");
            yield return Set($"{alias}.assign.{i}", "Variable", output.Name);
            yield return Set($"{alias}.assign.{i}", "Value", "ReadSource." + output.Name);
        }
        yield return Create(alias, "IEndNode", null, alias + ".end");
        yield return OpOf(("op", "link"), ("from", alias + ".start"), ("to", alias + ".call"));
        yield return OpOf(("op", "link"), ("from", alias + ".call"), ("to", alias + ".assign"));
        yield return OpOf(("op", "link"), ("from", alias + ".assign"), ("to", alias + ".end"));
        yield return OpOf(("op", "layout"), ("target", alias));
    }

    private IEnumerable<JsonObject> AggregateOps(PrototypeOwner owner, PrototypeAggregate agg)
    {
        yield return Create(owner.Ref, "IScreenAggregate", agg.Name, agg.Alias);
        var main = _entityRef.GetValueOrDefault(agg.Collection) ?? throw new InvalidOperationException("no entity for " + agg.Collection);
        yield return Create(agg.Alias, "IAliasedSource", agg.Entity, agg.Alias + ".s0", new JsonObject { ["dataSource"] = main });
        var i = 0;
        var sourceNames = new HashSet<string>(StringComparer.Ordinal) { agg.Entity };
        foreach (var (via, joined) in agg.Joins)
        {
            i++;
            var collection = JoinedCollection(agg.Collection, via)!;
            var name = joined;
            for (var n = 2; !sourceNames.Add(name); n++) name = joined + n;
            yield return Create(agg.Alias, "IAliasedSource", name, $"{agg.Alias}.s{i}", new JsonObject { ["dataSource"] = _entityRef[collection] });
            yield return Create(agg.Alias, "IJoin", null, $"{agg.Alias}.j{i}");
            yield return Set($"{agg.Alias}.j{i}", "LeftSource", agg.Alias + ".s0");
            yield return Set($"{agg.Alias}.j{i}", "RightSource", $"{agg.Alias}.s{i}");
            yield return Set($"{agg.Alias}.j{i}", "JoinType", "Left");
            yield return Set($"{agg.Alias}.j{i}", "Condition", $"{agg.Entity}.{via} = {name}.{_data.ByCollection(collection)?.Key ?? "Id"}");
        }
        foreach (var filter in agg.Filters) yield return OpOf(("op", "create"), ("parent", agg.Alias), ("type", "IFilter"), ("args", new JsonObject { ["condition"] = filter }));
        var s = 0;
        foreach (var (attribute, descending) in agg.Sort)
        {
            s++;
            yield return Create(agg.Alias, "ISort", null, $"{agg.Alias}.o{s}");
            yield return Set($"{agg.Alias}.o{s}", "Attribute", attribute);
            yield return Set($"{agg.Alias}.o{s}", "SortDirection", descending ? "Descending" : "Ascending");
        }
        var c = 0;
        foreach (var (name, kind, attribute) in agg.Columns)
        {
            c++;
            // An aggregated column names one attribute (CompileCheck: AGGREGATE_COLUMN_NOT_ATTRIBUTE): a computed value, such as
            // Sum(A.Qty * B.Price), is a calculated column aggregated by name, the published form (AGG X=Sum(XRow) CALC XRow=...).
            var value = attribute;
            if (AggregateSortRule.Plain(attribute) == null)
            {
                value = name + "Row";
                yield return Create(agg.Alias, "ICalculatedAttribute", value, $"{agg.Alias}.k{c}");
                yield return Set($"{agg.Alias}.k{c}", "Value", attribute);
            }
            yield return Create(agg.Alias, "IAggregateAttribute", name, $"{agg.Alias}.c{c}");
            yield return Set($"{agg.Alias}.c{c}", "Attribute", value);
            yield return Set($"{agg.Alias}.c{c}", "AggregationType", kind);
        }
        yield return Set(agg.Alias, "Name", agg.Name);
    }

    // ---- report -----------------------------------------------------------------------------------------------------------

    private void ReportAll()
    {
        var r = _plan.Report;
        r["schema"] = "ssam-prototype-receipt/1";
        r["source"] = new JsonObject
        {
            ["root"] = _ir.Json["source"]?["root"]?.ToString(), ["entry"] = _ir.Json["source"]?["entry"]?.ToString(), ["kind"] = _ir.Json["kind"]?.ToString(),
            ["clock"] = _ir.Json["clock"]?.ToString(), ["tz"] = _ir.Json["tz"]?.ToString() ?? "UTC", ["captureSha256"] = _ir.Sha256,
        };
        r["prefix"] = Prefix;
        r["flow"] = _plan.FlowName; r["theme"] = _plan.ThemeName;
        var screens = new JsonArray();
        foreach (var owner in _owners.Where(o => o.Kind == "screen"))
        {
            var view = _ir.View(owner.View!)!;
            var screen = new JsonObject
            {
                ["name"] = owner.Name, ["view"] = owner.View, ["route"] = view["route"]?.ToString(), ["default"] = view["default"]?.GetValue<bool>() == true,
                ["inputs"] = new JsonArray(owner.Inputs.Select(i => (JsonNode)i.Name).ToArray()),
                ["popups"] = new JsonArray(owner.Popups.Values.Select(p => (JsonNode)p.Name).ToArray()),
                ["widgets"] = owner.Widgets?.Widgets ?? 0, ["elements"] = view["elements"]?.GetValue<int>() ?? owner.Widgets?.Elements ?? 0,
                ["existing"] = owner.ExistingKey != null,
            };
            if (_renamed.OfType<JsonObject>().FirstOrDefault(x => x["name"]?.ToString() == owner.Name && x["kind"]?.ToString() == "screen") is { } renamed)
            { screen["renamedFrom"] = renamed["renamedFrom"]?.ToString(); screen["why"] = renamed["why"]?.ToString(); }
            screens.Add(screen);
        }
        r["screens"] = screens;
        r["blocks"] = new JsonArray(_owners.Where(o => o.Kind == "block").Select(b => (JsonNode)new JsonObject
        {
            ["name"] = b.Name, ["role"] = b.Modal == null ? "shell" : "modal",
            ["instances"] = b.Modal == null ? _owners.Count(o => o.Kind == "screen") : _owners.Count(o => o.Kind == "screen" && o.Popups.ContainsKey(b.Modal)),
            ["placeholder"] = b.Modal == null ? "Content" : null,
            ["inputs"] = new JsonArray(b.Inputs.Select(i => (JsonNode)i.Name).ToArray()),
            ["events"] = new JsonArray(b.BlockEvents.Select(e => (JsonNode)e.Event).ToArray()),
        }).ToArray());
        r["popups"] = new JsonArray(_ir.Modals.Select(m => (JsonNode)new JsonObject
        {
            ["name"] = m["name"]?.ToString(), ["modal"] = m["key"]?.ToString(),
            ["screens"] = new JsonArray(_owners.Where(o => o.Kind == "screen" && o.Popups.ContainsKey(m["key"]!.ToString())).Select(o => (JsonNode)o.Name).ToArray()),
            ["inputs"] = new JsonArray(PrototypeCapture.Objects(m["params"]).Select(p => (JsonNode)p["name"]!.ToString()).ToArray()),
            ["load"] = _owners.SelectMany(o => o.Popups.Values).FirstOrDefault(p => p.Modal == m["key"]!.ToString()) is { } p0
                ? p0.Block != null ? "block" : p0.List != null ? "ListIndexOf" : p0.Record != null ? "aggregate" : p0.NewRecord != null ? "new" : "none" : "none",
        }).ToArray());
        var iconInstances = _owners.Sum(o => o.Specs.Count(s => s.Value.Properties.Any(p => p.Property == "Style" && p.Value.Contains("ssam-icon", StringComparison.Ordinal)) || s.Value.Extended.Any(e => e.Value.Contains("ssam-icon", StringComparison.Ordinal))));
        r["resources"] = new JsonObject
        {
            ["images"] = new JsonArray(_ir.Assets.Select(a => (JsonNode)new JsonObject { ["name"] = _imageNames[a["path"]!.ToString()], ["file"] = a["path"]?.ToString(), ["bytes"] = a["bytes"]?.GetValue<long>() ?? 0, ["url"] = _plan.AssetUrls[a["path"]!.ToString()] }).ToArray()),
            ["icons"] = new JsonObject { ["library"] = _ir.Icons["library"]?.ToString(), ["distinct"] = (_ir.Icons["set"] as JsonObject)?.Count ?? 0, ["classes"] = _plan.IconClasses.Count, ["tag"] = "span" },
            ["imports"] = new JsonArray(_ir.Sheets.SelectMany(s => s["imports"] as JsonArray ?? []).Select(i => (JsonNode)i!.ToString()).ToArray()),
        };
        r["data"] = new JsonObject
        {
            ["staticEntities"] = new JsonArray(_data.Entities.Where(e => e.Static).Select(e => (JsonNode)new JsonObject { ["name"] = e.Name, ["records"] = e.Rows.Count }).Concat(
                _data.Options.Select(o => (JsonNode)new JsonObject { ["name"] = o.Name, ["records"] = o.Rows.Count, ["options"] = o.Control, ["byKey"] = o.ByKey })).ToArray()),
            ["entities"] = new JsonArray(_data.Entities.Where(e => !e.Static).Select(e => (JsonNode)EntityReport(e)).ToArray()),
            ["extraAttributes"] = new JsonArray(),
            ["serverActions"] = _logic!.ServerDeclarations().Count(),
            ["clientVariables"] = r["clientVariables"]?.DeepClone() ?? new JsonArray(),
            ["exception"] = _exception,
        };
        r.Remove("clientVariables");
        foreach (var owner in _owners) foreach (var (key, binding) in owner.Bindings) if (binding.Action != null) _plan.EventActions.TryAdd(key, binding.Action);
        if (_ir.Bind is { } bind)
        {
            var bound = bind.Report.DeepClone().AsObject();
            bound["producer"] = bind.Producer;
            bound["references"] = new JsonArray(bind.Elements.Select(e => (JsonNode)e).ToArray());
            bound["dataActions"] = new JsonArray(_owners.SelectMany(o => o.DataActions.Select(d => (JsonNode)new JsonObject
            {
                ["owner"] = o.Name, ["name"] = d.Source.As, ["action"] = d.Source.Action, ["fetch"] = d.OnDemand ? "OnDemand" : "AtStart",
                ["args"] = new JsonObject(d.Source.Args.Select(a => KeyValuePair.Create(a.Key, (JsonNode?)a.Value))),
                ["outputs"] = new JsonArray(d.Source.Outputs.Select(p => (JsonNode)(p.Name + ": " + p.Type)).ToArray()),
            })).ToArray());
            bound["collections"] = new JsonArray(bind.BoundCollections.Order(StringComparer.Ordinal).Select(c => (JsonNode)c).ToArray());
            ((JsonObject)r["data"]!)["bound"] = bound;
        }
        var degraded = new JsonArray(); var unevaluable = new JsonArray(); var references = new JsonArray();
        foreach (var owner in _owners.Where(o => o.Widgets != null))
        {
            foreach (var d in owner.Widgets!.Degraded) degraded.Add(d.DeepClone());
            foreach (var u in owner.Widgets.Unevaluable) unevaluable.Add(u.DeepClone());
            foreach (var x in owner.Widgets.References) references.Add(x.DeepClone());
        }
        r["degraded"] = degraded;
        // the selector map of the rewrites goes to prototype-dom.json (the measure), not to the receipt
        var css = _plan.CssReport?.DeepClone() as JsonObject;
        css?.Remove("selectors");
        r["fidelity"] = new JsonObject { ["unevaluable"] = unevaluable, ["references"] = references, ["css"] = css };
        var allRenamed = _renamed.DeepClone().AsArray();
        foreach (var a in _ir.AttributeRenames) allRenamed.Add(a!.DeepClone());
        r["renamed"] = allRenamed;
        r["vanished"] = new JsonArray(_plan.Vanished.Select(v => (JsonNode)new JsonObject { ["kind"] = v.Kind, ["name"] = v.Name, ["key"] = v.Key }).ToArray());
        r["counts"] = new JsonObject
        {
            ["ops"] = _plan.OpCount, ["widgets"] = _owners.Sum(o => o.Widgets?.Widgets ?? 0), ["elements"] = _owners.Sum(o => o.Widgets?.Elements ?? 0),
            ["extendedProperties"] = _owners.Sum(o => o.Widgets?.ExtendedProperties ?? 0), ["screenActions"] = _owners.Sum(o => o.Actions.Count),
            ["serverActions"] = _logic.ServerDeclarations().Count(), ["ifWidgets"] = _owners.Sum(o => o.Widgets?.Ifs ?? 0), ["lists"] = _owners.Sum(o => o.Widgets?.Lists ?? 0),
            ["aggregates"] = _owners.Sum(o => o.Aggregates.Count), ["iconInstances"] = iconInstances,
        };
        r["capture"] = new JsonObject { ["probes"] = _ir.Json["stats"]?["probes"]?.DeepClone(), ["elements"] = _ir.Json["stats"]?["elements"]?.DeepClone() };
        var outOfScope = new JsonArray();
        // what the capture itself says it leaves out (3.7): timers, keyboard repeats, rules the perturbation did not reach
        foreach (var o in PrototypeCapture.Objects(_ir.Json["outOfScope"])) outOfScope.Add(o.DeepClone());
        foreach (var w in PrototypeCapture.Objects(_ir.Json["warnings"]).Where(w => w["code"]?.ToString() != "PrototypeTimerSkipped")) outOfScope.Add(new JsonObject { ["what"] = w["message"]?.ToString() ?? w["code"]?.ToString(), ["where"] = w["where"]?.ToString(), ["why"] = "captured as a warning of the prototype run" });
        foreach (var e in _ir.Events.Where(e => e["compiled"]?.GetValue<bool>() == false)) outOfScope.Add(new JsonObject { ["what"] = e["key"]?.ToString(), ["where"] = e["handler"]?.ToString(), ["why"] = "the capture did not compile this event" });
        r["outOfScope"] = outOfScope;
        r["padroes"] = new JsonObject { ["notes"] = new JsonArray(new JsonObject { ["rule"] = "AR2", ["note"] = "the account is simulated by the prototype (a dimension); server actions receive it as a parameter" }) };
        r["noChange"] = _plan.NoChange;
        r["planSha256"] = _plan.PlanSha;
    }
}
