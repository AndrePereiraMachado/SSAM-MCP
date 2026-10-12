using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The one definition of the raw verb contract, shared by execution and by the public projection.
/// <see cref="ModelSession.ApplyOne"/> calls <see cref="Check"/> before dispatching any op: an op whose verb is not
/// here, that lacks a required key or that carries a key outside required+optional is refused with this table in the
/// message. `api --op verbs` (<see cref="Schema"/>) prints the same table. So a handler cannot read a key the table
/// does not name (the runtime never lets it through), and a key added here without a handler reading it is visible in
/// the suites. Keys prefixed with '_' are author annotations (`_why`) and are always allowed.
/// What stays curated and is NOT enforced: the `Effect` sentences and the reference grammar (they describe semantics,
/// not shape); value types and property names live in the native Model API and in each handler.
/// VerbSurfaceTests pin the verb names to the dispatcher by reflection and every job of the suites to this contract.
/// </summary>
public static class VerbSurface
{
    /// <summary>Required entries may be alternatives separated by '|' ("parent|data": at least one of them).</summary>
    public sealed record VerbShape(string Verb, string Kind, string[] Required, string[] Optional, string Effect);

    /// <summary>Kind: "write" mutates the model inside the job transaction; "read" only observes it.</summary>
    public static readonly IReadOnlyList<VerbShape> Verbs =
    [
        new("create", "write", ["parent", "type"], ["name", "args", "as", "source", "empty"],
            "Creates a child of `type` (Model API interface name, with or without the leading I) under `parent`; `args` fills the Create parameters by name (references for objects, JSON for scalars and enums, base64 text for Byte[] such as an image's `binary`); a type whose only factory is GetOrCreate<X> (ILocale, args.culture) uses it; `as` registers a $alias; `source` binds a block instance to `IMobileBlock:Name`; `empty:true` clears example content."),
        new("set", "write", ["target", "prop"], ["value", "empty"],
            "Writes one property of `target`. Boolean/numeric properties take JSON values; expression properties take OutSystems text; reference properties (Destination, Handler, Action, DataSource, SourceBlock, DataType) take a reference or a native type name; a list the Model API edits only by Add.../Remove... (ISemanticSearchNode.SearchAttributes) takes a JSON array of references and becomes exactly that list. Text the object parses itself goes through From<Prop>(text): CronExpression on the ScheduleConfiguration of an ODC workflow Start."),
        new("link", "write", ["from", "to"], ["connector", "as"],
            "Connects two flow nodes through `connector` (default Target; If: TrueTarget|FalseTarget; ForEach: CycleTarget; Switch: its own connectors)."),
        new("move", "write", ["target"], ["into", "first", "last", "before", "after", "x", "y"],
            "Reorders `target` inside the same parent (first|last|before|after a sibling) or repositions a flow node (x/y). With `into` it changes the parent: a top-level element (action, entity, structure, variable...) changes folder (`into` an IFolder of its tree branch, or `@espace` for none; key kept); any other object goes through the platform's own move into a parent that accepts its kind (consumers follow it, the moved object gets a new key; first|last|before|after then place it in the new parent). An incompatible parent, or a consumer that could not follow, is refused naming both."),
        new("duplicate", "write", ["target"], ["as", "parent"],
            "The Studio's native copy and paste (Ctrl+D): a copy at the end of the same parent, or of `parent` (another compatible parent: container, block, UI flow), inside the native container that holds that kind; name suffixed by the platform, without consumers. Refuses with the reason what the native paste refuses (a kind the platform copies only inside its owner, a model feature the Studio does not load, a parent that does not take it or already has the only one)."),
        new("delete", "write", ["target"], ["force", "reconnect", "breaks"],
            "Deletes `target`; while real consumers exist it refuses (DELETE_HAS_CONSUMERS, each path) unless `force:true` or `breaks` lists exactly those paths (else CONSUMERS_CHANGED). `reconnect:true` on a one-exit flow node first moves its incoming connectors to its next node."),
        new("rename", "write", ["target", "name"], [],
            "Renames `target` through the name the Studio shows for its type (Name; Identifier of a static record; Label of an If/Assign/ForEach/Switch/Message node or a switch condition; Property/Event of an extended property/event), returned as `property`; refuses a clash where the name is unique (Name, Identifier); connectors and types with no name are refused; returns consumers and expressionsRewritten."),
        new("replace", "write", ["from", "to"], ["force"],
            "Repoints every consumer of `from` to `to` (ReplaceReferences); different kinds require `force`."),
        new("reference", "write", ["producer", "elements"], ["as"],
            "Imports public elements (`Tipo:Nome` list) of a producer module (fixture path, `job:<name>` or a producer bound on the command line). On ODC, imports a public module or AI model connection signature captured from the consumer session."),
        new("layout", "write", ["target"], [],
            "Lays out the flow of an action, preparation or process with the shared engine."),
        new("spec", "write", ["data"], [],
            "Compact data language (static, entities, clientEntities, structures, indexes); see `api --op spec`."),
        new("logic", "write", ["data"], [],
            "Compact logic language (actions with steps); see `api --op logic`."),
        new("agent", "write", ["data"], [], "Native ODC agent creation and key-preserving configuration, inputs and tool handlers; see api --op agent."),
        new("screen", "write", ["data"], [],
            "Screen archetypes (`api --op screen`) or the typed owners tree (`data.owners`)."),
        new("html", "write", ["parent|data"], ["file", "html"],
            "Visual fragment inside an existing parent (`parent` + `file`|`html`, see `api --op html-visual`) or a whole page manifest (`data`, see `api --op html`)."),
        new("prototype", "write", ["data"], [], "Prototype folder imported as native screens, a shell block, popups, data and logic (data.capture is written by the facade); see `api --op prototype`."),
        new("rest", "write", ["data"], [],
            "Consumed REST client, declarative over what it names (client, methods, structures, openapi, remove, breaks); see `api --op rest`."),
        new("rest-expose", "write", ["data"], [],
            "Exposed REST service and its methods (service, methods with action/arguments/results or steps, remove, breaks); see `api --op rest-expose`."),
        new("soap", "write", ["data"], [],
            "SOAP client from a pinned WSDL (O11 only; ODC: SOAP_LANE_UNSUPPORTED): port selection, methods, refresh, remove, breaks; the import runs in the Studio through o11_deliver; see `api --op soap`."),
        new("get", "read", ["target"], [],
            "Reads the properties of one object (expression properties appear as `@key.#Prop`; use dump for text)."),
        new("find", "read", [], ["name", "type", "max"],
            "Lists objects by name and/or interface (`max` default 50)."),
        new("dump", "read", ["target"], ["depth"],
            "Reads the subtree of `target` (`depth` default 3)."),
        new("usages", "read", ["target"], ["max", "offset", "scope", "includeInternal"],
            "Lists the consumers of `target`: count, real, byType and entries with `derived:true` for what the Studio maintains by itself; `scope` direct|subtree."),
    ];

    private static readonly IReadOnlyDictionary<string, VerbShape> ByName = Verbs.ToDictionary(v => v.Verb, StringComparer.Ordinal);
    public static IEnumerable<string> Names => Verbs.Select(v => v.Verb);

    /// <summary>
    /// The contract as executed: refuses an unknown verb, a missing required key or a key the verb does not read.
    /// Called by the dispatcher for every op, including the ops the compact languages expand into.
    /// </summary>
    public static void Check(JsonObject op)
    {
        var kind = op["op"]?.GetValue<string>() ?? throw new InvalidOperationException("missing 'op'");
        if (!ByName.TryGetValue(kind, out var shape))
            throw new InvalidOperationException($"unknown op: {kind}; ops: {string.Join(", ", Names)}");
        var missing = shape.Required.Where(group => group.Split('|').All(k => op[k] == null)).ToList();
        var allowed = shape.Required.SelectMany(g => g.Split('|')).Concat(shape.Optional).ToHashSet(StringComparer.Ordinal);
        // allowQueryInLoop {why}: the explicit escape of QUERY_IN_LOOP (QueryInLoopRule), accepted on any write op.
        var unknown = op.Select(p => p.Key).Where(k => k != "op" && !k.StartsWith('_') && !allowed.Contains(k)
            && !(k == QueryInLoopRule.AllowKey && shape.Kind == "write")).ToList();
        if (missing.Count == 0 && unknown.Count == 0) return;
        var problems = new List<string>();
        if (missing.Count > 0) problems.Add("missing " + string.Join(", ", missing.Select(m => m.Contains('|') ? "one of " + m.Replace("|", ", ") : $"'{m}'")));
        if (unknown.Count > 0) problems.Add("unknown key(s) " + string.Join(", ", unknown.Select(k => $"'{k}'")));
        throw new InvalidOperationException($"{kind}: {string.Join("; ", problems)}; required: {string.Join(", ", shape.Required)}; optional: {string.Join(", ", shape.Optional)} (api --op verbs)");
    }

    /// <summary>The reference forms <see cref="ModelSession.Resolve"/> and its child resolver accept, in the order they are tried.</summary>
    public static readonly IReadOnlyList<(string Form, string Meaning)> References =
    [
        ("$alias", "handle registered by `as` in an earlier op of the same job"),
        ("@espace", "the module itself"),
        ("@<ObjectKey>", "exact object key of the same capture; keys are opaque and may contain '/'"),
        ("Tipo:Nome", "interface name plus object name, e.g. IServerEntity:Booking, IMobileScreen:Home; elements of referenced modules resolve through their *Signature interface"),
        (":Nome", "object name with the interface omitted"),
        ("$pai/Filho", "child by name, argument by parameter name, placeholder by name, event handler by event name, or a property that returns an object ($btn/OnClick, $scr/OnReady)"),
        ("$pai/#Tipo[n]", "n-th direct child of that interface (default 1)"),
        ("$pai/**Tipo[n]", "n-th descendant of that interface at any depth"),
        ("$no/arg:Nome", "argument by parameter name when a child with the same name exists (JavaScript nodes)"),
        ("$no/param:Nome", "parameter or child by name, disambiguated from an argument"),
        ("Tipo:@producerKey/elementKey", "element of an imported producer by original key (compiler-bound references)"),
        ("IReference:Producer/Flow/Block", "qualified native block import"),
    ];

    public static JsonObject Schema()
    {
        var verbs = new JsonObject();
        foreach (var v in Verbs)
            verbs[v.Verb] = new JsonObject
            {
                ["kind"] = v.Kind,
                ["required"] = new JsonArray(v.Required.Select(k => (JsonNode)k).ToArray()),
                ["optional"] = new JsonArray(v.Optional.Select(k => (JsonNode)k).ToArray()),
                ["effect"] = v.Effect,
            };
        var references = new JsonObject();
        foreach (var (form, meaning) in References) references[form] = meaning;
        return new JsonObject
        {
            ["op"] = "verbs",
            ["verbs"] = verbs,
            ["references"] = references,
            ["job"] = new JsonArray("description", "base", "expectValid", "expectedMessages", "ops"),
            ["expectedMessage"] = new JsonArray("id", "element", "why"),
            ["rules"] = "A job is one transaction: the target of a set/link must exist before that op (forward references are reported with the op that creates them). "
                + "Write verbs are recorded by the coverage ledger; read verbs are not. Ops beyond this list are refused with 'unknown op'. "
                + "Dispatcher: Anvil.Core/Kernel/Verbs.cs (ModelSession.ApplyOne); reference grammar: ModelSession.Resolve.",
        };
    }
}
