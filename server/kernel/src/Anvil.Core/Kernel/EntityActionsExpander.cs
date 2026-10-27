using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// Op `entity-actions` (both lanes, headless): the standard server actions of a data model, generated from the module's own
/// data (its ssam-ddl/1 reading: entities, attributes, references, delete rules, indexes, active and label attributes) as
/// ssam-flow/1 texts that the logic op's text form writes (Verbs.Flow.cs: created, read back, FLOW_NOT_EXACT otherwise).
/// A pure function of the data model and the op's data: the same model and the same data give the same texts, byte for byte.
/// Per server entity of the module that has an identifier:
/// <list type="bullet">
/// <item>Get{E}List: one aggregate (joins to the entities its references name, filters by its references, indexed texts and
/// dates, a search over its label and indexed texts, the owner and the active attribute), sort, paging by an SQL with OFFSET and
/// FETCH NEXT (T3: the runtime ignores START on a server aggregate, the Studio hides it there), the total by an aggregate of the
/// same sources, joins and filters,
/// the page (a {E}ListItem structure that mirrors the aggregate's record) and the total;</item>
/// <item>Get{E}ById: the record, NotFound, the owner check;</item>
/// <item>Save{E}: existence and owner checks, required fields, text lengths, references that must exist, unique keys, then
/// Create or Update (CreateOrUpdate without an auto number), typed errors;</item>
/// <item>Remove{E}: existence and owner checks, the records that still reference it (Delete Rule Protect), then Delete (or
/// the active attribute set to False);</item>
/// <item>a service action per server action when asked (expose.service), calling it with the same contract.</item>
/// </list>
/// No JavaScript, no For Each, no aggregate in a loop; every action, parameter, aggregate, structure and exception is named and
/// described; every If is a question, every Assign says its intent. Existing actions are never overwritten: an action of the
/// same name that reads as the generated text is kept as it is (unchanged), any other is kept and listed (kept). The receipt
/// lists everything.
///
/// {"op":"entity-actions","data":{"entities":"all","owner":{"attribute":"CriadoPor"},"expose":{"server":true,"service":true}}}
/// </summary>
public static class EntityActionsExpander
{
    public const string Op = "entity-actions";
    public static readonly string[] RootKeys = ["entities", "exclude", "actions", "owner", "expose", "list", "softDelete", "validations", "errors", "names", "language"];
    public static readonly string[] ActionKinds = ["list", "byId", "save", "delete"];
    private static readonly string[] OwnerKeys = ["attribute", "kind"];
    private static readonly string[] ExposeKeys = ["server", "service"];
    private static readonly string[] ListKeys = ["filters", "sort", "paging", "pageSize", "joins", "search"];
    private static readonly string[] ErrorKeys = ["validation", "notFound", "forbidden"];
    private static readonly string[] NameKeys = ["list", "byId", "save", "delete", "service", "item"];
    private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    public static JsonObject Schema() => new()
    {
        ["op"] = Op,
        ["data"] = Array(RootKeys),
        ["shapes"] = new JsonObject
        {
            ["entities"] = "\"all\" (every server entity of the module with an identifier) or a list of entity names",
            ["exclude"] = "a list of entity names left out",
            ["actions"] = Array(ActionKinds),
            ["owner"] = new JsonObject { ["attribute"] = "name (or list of names) of a User Identifier attribute; entities without it have no owner check", ["kind"] = "UserId (the only kind)" },
            ["expose"] = new JsonObject { ["server"] = "true: public server actions (O11, ODC library; an ODC app keeps them private)", ["service"] = "true: a service action per server action" },
            ["list"] = new JsonObject { ["filters"] = "\"auto\" | \"none\" | [attribute names]", ["sort"] = "\"auto\" | \"Attr\" | \"-Attr\" | {\"<Entity>\": \"-Attr\"}",
                ["paging"] = "true (StartIndex, MaxRecords) | false", ["pageSize"] = "default MaxRecords (50)", ["joins"] = "\"auto\" (the entities its references name) | \"none\"", ["search"] = "\"auto\" | \"none\"" },
            ["softDelete"] = "\"auto\" (the entity's active attribute) | {\"attribute\": \"<Boolean attribute>\"} | false",
            ["validations"] = "\"auto\" (required, lengths, references, unique keys) | \"none\"",
            ["errors"] = new JsonObject { ["validation"] = "ValidationFailed", ["notFound"] = "NotFound", ["forbidden"] = "AccessDenied" },
            ["names"] = new JsonObject { ["list"] = "Get{E}List", ["byId"] = "Get{E}ById", ["save"] = "Save{E}", ["delete"] = "Remove{E}", ["service"] = "{A}Service", ["item"] = "{E}ListItem" },
            ["language"] = "en | pt (descriptions and error messages)",
        },
        ["rules"] = "Generated from the module's data model, never from a scenario: the same model and data give the same texts. Writes the texts through the logic op's "
            + "text form (each created action reads back as its text). An action of the same name that reads as the generated text is unchanged (NO_CHANGE when all are); "
            + "an action of the same name that reads otherwise, or any other element of that name, is kept and listed in kept with the generated text, never overwritten. "
            + "The exceptions and {E}ListItem structures it needs are created when missing (reused when present with that shape). Business actions go in the same job as "
            + "logic texts after this op. The names follow the owner's rule N1, verb first: Get{E}List, Get{E}ById, Save{E}, Remove{E} and {A}Service; names {...} only "
            + "overrides them. Required fields checked: texts (empty), references (NullIdentifier) and dates (NullDate); never numbers, Booleans or times, where the "
            + "empty value (0, False) is also data.",
        // What a business action calls: the signatures every generated action has (the names by default).
        ["signatures"] = new JsonObject
        {
            ["Get{E}List"] = "in <Reference>? per reference (empty: any), <IndexedText>?, <IndexedDate>From?/To?, SearchText?, IsInactiveIncluded? (active attribute), StartIndex?, MaxRecords? = pageSize; out List: {E}ListItem List (each row: .{E} and one record per joined reference, by its entity name), TotalCount: Long Integer",
            ["Get{E}ById"] = "in Id: {E} Identifier; out {E}Record: {E}; raises NotFound, AccessDenied (owner)",
            ["Save{E}"] = "in {E}Record: {E} (empty identifier creates); out Id: {E} Identifier; raises ValidationFailed, NotFound, AccessDenied",
            ["Remove{E}"] = "in Id: {E} Identifier; raises NotFound, AccessDenied, ValidationFailed (still referenced)",
            ["{A}Service"] = "the same inputs and outputs as {A}, calling it",
        },
        ["codes"] = Array(["ENTITY_ACTIONS_INVALID", "ENTITY_ACTIONS_UNKNOWN_ENTITY", "ENTITY_ACTIONS_NOT_SERVER_ENTITY", "ENTITY_ACTIONS_UNKNOWN_ATTRIBUTE"]),
        ["example"] = "{\"op\":\"entity-actions\",\"data\":{\"entities\":\"all\",\"owner\":{\"attribute\":\"CreatedBy\"},\"expose\":{\"server\":true,\"service\":true}}}",
    };

    private static JsonArray Array(IEnumerable<string> keys) => new(keys.Select(k => (JsonNode)k).ToArray());

    // ---- the data model the expander reads ------------------------------------------------------------------------------

    public sealed record Attribute(string Name, string Type, bool Mandatory, int? Length, string? References, string? DeleteRule, bool Auto);
    public sealed record Index(string Name, bool Unique, IReadOnlyList<string> Columns);
    public sealed record Entity(string Name, string Kind, bool Public, string? IdentifierName, IReadOnlyList<Attribute> Attributes, IReadOnlyList<Index> Indexes,
        string? LabelAttribute, string? ActiveAttribute)
    {
        public Attribute? Id => IdentifierName == null ? null : Attributes.FirstOrDefault(a => a.Name == IdentifierName);
        public Attribute? Find(string name) => Attributes.FirstOrDefault(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase));
    }
    /// <summary>What the module says of an entity a reference names: whether it is static, public (reachable from a public signature),
    /// its identifier's name, and whether it is an entity of this module.</summary>
    public sealed record Referenced(bool Exists, bool Static, bool Public, string IdentifierName, bool Own);
    /// <summary>An existing element of a name the op would create: its kind (an action kind, or another), and for an action of this
    /// module its text as read now (ids stripped).</summary>
    public sealed record Existing(string Kind, string? Text, string? Key, string? TextSha);

    public sealed class Model
    {
        public string Lane = "o11";
        public bool OdcApplication;
        public List<Entity> Entities = [];
        public List<(string Name, IReadOnlyList<(string Attribute, string Type)> Attributes)> Structures = [];
        public Func<string, Referenced> Reference = _ => new(false, false, false, "Id", false);
        /// <summary>The element that holds a name in the scope of a new module action (null when free).</summary>
        public Func<string, Existing?> Existing = _ => null;
        /// <summary>The kind of the element of a name among the module's exceptions, structures and other top elements.</summary>
        public Func<string, string?> TopElement = _ => null;
    }

    // ---- the plan --------------------------------------------------------------------------------------------------------

    public sealed record Generated(string Name, string Kind, string Entity, string Role, string Text, bool Public);
    public sealed class Plan
    {
        public List<JsonObject> Ops = [];                 // exceptions and structures, before the texts
        public List<Generated> Create = [];              // the texts the logic op writes
        public List<Generated> Unchanged = [];           // existing actions that read as the generated text
        public JsonArray Kept = [];                      // a name held by something else: kept, listed with the generated text
        public JsonArray Skipped = [];                   // entities or actions not generated, and why
        public JsonArray Notes = [];                     // decisions the receipt names (an ODC app keeps server actions private...)
        public JsonArray Exceptions = [];
        public JsonArray Structures = [];
        public bool NoChange => Ops.Count == 0 && Create.Count == 0;
    }

    /// <summary>Every problem of the data alone (closed keys, types, names). Empty when valid.</summary>
    public static List<JsonObject> Validate(JsonObject data)
    {
        var problems = new List<JsonObject>();
        void Problem(string pointer, string message, string? fix = null, string code = "ENTITY_ACTIONS_INVALID") =>
            problems.Add(JobPreflight.Problem(null, pointer, code, "error", "entity-actions: " + message, fix, null, Op));
        void Closed(JsonObject o, string[] allowed, string at)
        {
            foreach (var key in o.Select(p => p.Key).Where(k => !k.StartsWith('_') && !allowed.Contains(k, StringComparer.Ordinal)))
                Problem(at + "/" + key, $"unknown key '{key}'", "use only: " + string.Join(", ", allowed));
        }
        Closed(data, RootKeys, "");
        if (data["entities"] is { } entities && !(entities is JsonValue v && v.TryGetValue<string>(out var all) && all == "all") && !IsNameList(entities))
            Problem("/entities", "entities is \"all\" or a list of entity names", "\"entities\": \"all\"");
        if (data["exclude"] is { } exclude && !IsNameList(exclude)) Problem("/exclude", "exclude is a list of entity names");
        if (data["actions"] is { } actions)
        {
            if (actions is not JsonArray list || list.Any(a => a is not JsonValue av || !av.TryGetValue<string>(out var s) || !ActionKinds.Contains(s)))
                Problem("/actions", "actions is a list of " + string.Join(", ", ActionKinds), "\"actions\": [\"list\", \"byId\", \"save\", \"delete\"]");
        }
        if (data["owner"] is { } owner)
        {
            if (owner is not JsonObject o) Problem("/owner", "owner is {\"attribute\": \"<User Identifier attribute>\"}");
            else
            {
                Closed(o, OwnerKeys, "/owner");
                if (o["attribute"] is not { } attribute || !(IsName(attribute) || IsNameList(attribute))) Problem("/owner/attribute", "owner.attribute is the name (or a list of names) of a User Identifier attribute", "\"attribute\": \"CreatedBy\"");
                if (o["kind"] is { } kind && !(kind is JsonValue kv && kv.TryGetValue<string>(out var k) && k == "UserId")) Problem("/owner/kind", "owner.kind is UserId (the owner is GetUserId())", "\"kind\": \"UserId\"");
            }
        }
        if (data["expose"] is { } expose)
        {
            if (expose is not JsonObject o) Problem("/expose", "expose is {\"server\": true, \"service\": false}");
            else { Closed(o, ExposeKeys, "/expose"); foreach (var key in ExposeKeys) if (o[key] is { } flag && !IsBool(flag)) Problem("/expose/" + key, key + " is true or false"); }
        }
        if (data["list"] is { } listOptions)
        {
            if (listOptions is not JsonObject o) Problem("/list", "list is {\"filters\", \"sort\", \"paging\", \"pageSize\", \"joins\", \"search\"}");
            else
            {
                Closed(o, ListKeys, "/list");
                if (o["filters"] is { } filters && !(IsWord(filters, "auto", "none") || IsNameList(filters))) Problem("/list/filters", "filters is \"auto\", \"none\" or a list of attribute names");
                if (o["sort"] is { } sort && !(IsWord(sort, "auto") || sort is JsonValue sv && sv.TryGetValue<string>(out var st) && Identifier.IsMatch(st.TrimStart('-'))
                    || sort is JsonObject so && so.All(p => p.Value is JsonValue pv && pv.TryGetValue<string>(out var ps) && Identifier.IsMatch(ps.TrimStart('-')))))
                    Problem("/list/sort", "sort is \"auto\", \"Attr\", \"-Attr\" (descending) or {\"<Entity>\": \"-Attr\"}");
                if (o["paging"] is { } paging && !IsBool(paging)) Problem("/list/paging", "paging is true or false");
                if (o["pageSize"] is { } size && !(size is JsonValue zv && zv.TryGetValue<int>(out var z) && z > 0 && z <= 10000)) Problem("/list/pageSize", "pageSize is an integer from 1 to 10000");
                if (o["joins"] is { } joins && !IsWord(joins, "auto", "none")) Problem("/list/joins", "joins is \"auto\" or \"none\"");
                if (o["search"] is { } search && !IsWord(search, "auto", "none")) Problem("/list/search", "search is \"auto\" or \"none\"");
            }
        }
        if (data["softDelete"] is { } soft && !(IsWord(soft, "auto") || soft is JsonValue fv && fv.TryGetValue<bool>(out var f) && !f
            || soft is JsonObject sd && sd.Count == 1 && sd["attribute"] is { } sa && IsName(sa)))
            Problem("/softDelete", "softDelete is \"auto\", false or {\"attribute\": \"<Boolean attribute>\"}");
        if (data["validations"] is { } validations && !IsWord(validations, "auto", "none")) Problem("/validations", "validations is \"auto\" or \"none\"");
        if (data["errors"] is { } errors)
        {
            if (errors is not JsonObject o) Problem("/errors", "errors is {\"validation\", \"notFound\", \"forbidden\"} with exception names");
            else { Closed(o, ErrorKeys, "/errors"); foreach (var (key, value) in o) if (ErrorKeys.Contains(key) && (value == null || !IsName(value))) Problem("/errors/" + key, key + " is the name of a user exception"); }
        }
        if (data["names"] is { } names)
        {
            if (names is not JsonObject o) Problem("/names", "names is {\"list\", \"byId\", \"save\", \"delete\", \"service\", \"item\"} with templates");
            else
            {
                Closed(o, NameKeys, "/names");
                foreach (var (key, value) in o)
                {
                    if (!NameKeys.Contains(key)) continue;
                    var template = value is JsonValue tv && tv.TryGetValue<string>(out var t) ? t : null;
                    var hole = key == "service" ? "{A}" : "{E}";
                    if (template == null || !template.Contains(hole) || !Identifier.IsMatch(template.Replace(hole, "X")))
                        Problem("/names/" + key, $"names.{key} is a name template with {hole}", $"\"{key}\": \"{DefaultNames[key]}\"");
                }
            }
        }
        if (data["language"] is { } language && !IsWord(language, "en", "pt")) Problem("/language", "language is \"en\" or \"pt\"");
        return problems;
    }

    private static readonly Dictionary<string, string> DefaultNames = new()
    {
        ["list"] = "Get{E}List", ["byId"] = "Get{E}ById", ["save"] = "Save{E}", ["delete"] = "Remove{E}", ["service"] = "{A}Service", ["item"] = "{E}ListItem",
    };

    private static bool IsName(JsonNode node) => node is JsonValue v && v.TryGetValue<string>(out var s) && Identifier.IsMatch(s);
    private static bool IsNameList(JsonNode node) => node is JsonArray a && a.Count > 0 && a.All(e => e != null && IsName(e));
    private static bool IsBool(JsonNode node) => node is JsonValue v && v.TryGetValue<bool>(out _);
    private static bool IsWord(JsonNode node, params string[] words) => node is JsonValue v && v.TryGetValue<string>(out var s) && words.Contains(s);
    private static IEnumerable<string> Names(JsonNode? node) => node switch
    {
        JsonArray a => a.OfType<JsonValue>().Select(v => v.ToString()),
        JsonValue v when v.TryGetValue<string>(out var s) => [s],
        _ => [],
    };

    /// <summary>The problems only the module answers: an entity named that is not a server entity of the module with an identifier,
    /// a list filter or sort that names no attribute, a softDelete attribute that is not Boolean.</summary>
    public static List<JsonObject> CheckAgainstModel(JsonObject data, Model model)
    {
        var problems = new List<JsonObject>();
        void Problem(string pointer, string code, string message, string? fix) =>
            problems.Add(JobPreflight.Problem(null, pointer, code, "error", "entity-actions: " + message, fix, null, Op));
        var server = model.Entities.ToDictionary(e => e.Name, StringComparer.OrdinalIgnoreCase);
        var names = data["entities"] is JsonArray ? Names(data["entities"]).ToList() : [];
        for (var i = 0; i < names.Count; i++)
        {
            if (server.ContainsKey(names[i])) continue;
            var reference = model.Reference(names[i]);
            if (reference.Exists)
                Problem("/entities/" + i, "ENTITY_ACTIONS_NOT_SERVER_ENTITY", $"{names[i]} is {(reference.Static ? "a static entity" : reference.Own ? "not a server entity" : "an entity of another module")}: actions are generated for the server entities of this module",
                    "leave it out (\"entities\": \"all\" takes every server entity of the module)");
            else
                Problem("/entities/" + i, "ENTITY_ACTIONS_UNKNOWN_ENTITY", $"{names[i]} is not an entity of this module",
                    "use one of: " + string.Join(", ", model.Entities.Select(e => e.Name).Take(30)));
        }
        foreach (var (name, i) in Names(data["exclude"]).Select((n, i) => (n, i)))
            if (!server.ContainsKey(name)) Problem("/exclude/" + i, "ENTITY_ACTIONS_UNKNOWN_ENTITY", $"{name} is not a server entity of this module", null);
        var chosen = Chosen(data, model);
        if (data["list"]?["filters"] is JsonArray filters)
            foreach (var (attribute, i) in Names(filters).Select((n, i) => (n, i)))
                if (!chosen.Any(e => e.Find(attribute) != null))
                    Problem("/list/filters/" + i, "ENTITY_ACTIONS_UNKNOWN_ATTRIBUTE", $"no entity of the op has an attribute {attribute}", null);
        if (data["list"]?["sort"] is JsonObject sorts)
            foreach (var (entity, value) in sorts)
            {
                if (!server.TryGetValue(entity, out var e)) { Problem("/list/sort/" + entity, "ENTITY_ACTIONS_UNKNOWN_ENTITY", $"{entity} is not a server entity of this module", null); continue; }
                if (e.Find(value!.ToString().TrimStart('-')) == null) Problem("/list/sort/" + entity, "ENTITY_ACTIONS_UNKNOWN_ATTRIBUTE", $"{entity} has no attribute {value.ToString().TrimStart('-')}",
                    "one of: " + string.Join(", ", e.Attributes.Select(a => a.Name)));
            }
        if (data["softDelete"]?["attribute"] is JsonValue soft)
            if (!chosen.Any(e => e.Find(soft.ToString()) is { Type: "Boolean" }))
                Problem("/softDelete/attribute", "ENTITY_ACTIONS_UNKNOWN_ATTRIBUTE", $"no entity of the op has a Boolean attribute {soft}", "name a Boolean attribute, or \"softDelete\": \"auto\" (the entity's active attribute)");
        return problems;
    }

    private static List<Entity> Chosen(JsonObject data, Model model)
    {
        var exclude = Names(data["exclude"]).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var named = data["entities"] is JsonArray ? Names(data["entities"]).ToHashSet(StringComparer.OrdinalIgnoreCase) : null;
        return model.Entities.Where(e => (named == null || named.Contains(e.Name)) && !exclude.Contains(e.Name)).OrderBy(e => e.Name, StringComparer.Ordinal).ToList();
    }

    // ---- the expansion ---------------------------------------------------------------------------------------------------

    public static Plan Expand(JsonObject data, Model model)
    {
        var plan = new Plan();
        var context = new Context(data, model, plan);
        foreach (var entity in Chosen(data, model)) context.Entity(entity);
        context.Finish();
        return plan;
    }

    private sealed class Context
    {
        private readonly JsonObject data;
        private readonly Model model;
        private readonly Plan plan;
        private readonly Texts t;
        private readonly HashSet<string> kinds;
        private readonly string[] owners;
        private readonly bool exposeServer, exposeService, validations, paging, joins, search;
        private readonly int pageSize;
        private readonly Dictionary<string, string> exceptions = new(StringComparer.Ordinal);   // role -> the exception's name
        private readonly HashSet<string> exceptionsUsed = new(StringComparer.Ordinal);
        private readonly HashSet<string> taken = new(StringComparer.OrdinalIgnoreCase);         // names this plan creates

        public Context(JsonObject data, Model model, Plan plan)
        {
            this.data = data; this.model = model; this.plan = plan;
            t = new Texts(data["language"]?.ToString() == "pt");
            kinds = data["actions"] is JsonArray ? Names(data["actions"]).ToHashSet(StringComparer.Ordinal) : ActionKinds.ToHashSet(StringComparer.Ordinal);
            owners = Names(data["owner"]?["attribute"]).ToArray();
            exposeServer = data["expose"]?["server"]?.GetValue<bool>() ?? true;
            exposeService = data["expose"]?["service"]?.GetValue<bool>() ?? false;
            validations = data["validations"]?.ToString() != "none";
            paging = data["list"]?["paging"]?.GetValue<bool>() ?? true;
            pageSize = data["list"]?["pageSize"]?.GetValue<int>() ?? 50;
            joins = data["list"]?["joins"]?.ToString() != "none";
            search = data["list"]?["search"]?.ToString() != "none";
            if (exposeServer && model.OdcApplication)
                Note("ODC_APP_SERVER_PRIVATE", "an ODC app does not expose server actions: they stay private" + (exposeService ? "; the service actions are the app's public entry" : "; expose.service:true gives the app's public entry"));
            foreach (var (role, fallback) in new[] { ("validation", "ValidationFailed"), ("notFound", "NotFound"), ("forbidden", "AccessDenied") })
                exceptions[role] = ExceptionName(data["errors"]?[role]?.ToString() ?? fallback);
        }

        private void Note(string code, string message) => plan.Notes.Add(new JsonObject { ["code"] = code, ["message"] = message });

        private string Name(string key, string entity) => (data["names"]?[key]?.ToString() ?? DefaultNames[key]).Replace("{E}", entity);
        private string ServiceName(string action) => (data["names"]?["service"]?.ToString() ?? DefaultNames["service"]).Replace("{A}", action);

        // An exception name another kind of element holds gets "Exception" after it (the user exception is created under that name).
        private string ExceptionName(string name)
        {
            var kind = model.TopElement(name);
            return kind == null || kind == "UserException" ? name : name + "Exception";
        }

        private string Raise(string role, string message)
        {
            exceptionsUsed.Add(role);
            return "raise " + exceptions[role] + "(" + Quote(message) + ")";
        }

        public void Finish()
        {
            foreach (var role in new[] { "validation", "notFound", "forbidden" })
            {
                if (!exceptionsUsed.Contains(role)) continue;
                var name = exceptions[role];
                if (model.TopElement(name) == "UserException") { plan.Exceptions.Add(new JsonObject { ["name"] = name, ["created"] = false }); continue; }
                plan.Ops.Insert(0, new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IUserException", ["name"] = name, ["as"] = "$entityActions.exception." + name });
                plan.Exceptions.Add(new JsonObject { ["name"] = name, ["created"] = true, ["description"] = t.Exception(role) });
            }
        }

        // ---- one entity ----

        public void Entity(Entity e)
        {
            var id = e.Id;
            if (id == null) { plan.Skipped.Add(new JsonObject { ["entity"] = e.Name, ["why"] = "it has no identifier attribute: no record can be read, saved or deleted by it" }); return; }
            var owner = owners.Select(e.Find).FirstOrDefault(a => a != null && string.Equals(a.Type, "User Identifier", StringComparison.OrdinalIgnoreCase));
            if (owners.Length > 0 && owner == null && owners.Select(e.Find).FirstOrDefault(a => a != null) is { } wrong)
                plan.Skipped.Add(new JsonObject { ["entity"] = e.Name, ["what"] = "owner", ["why"] = $"{wrong.Name} is {wrong.Type}, not User Identifier: no owner check on {e.Name}" });
            var active = ActiveAttribute(e);
            // An entity a public signature cannot carry (not public) keeps its actions private.
            var publicServer = exposeServer && !model.OdcApplication && e.Public;
            // A service action is public: it takes and returns the entity, so only a public entity has them.
            var services = exposeService && e.Public;
            if ((exposeServer && !model.OdcApplication || exposeService) && !e.Public)
                Note("ENTITY_NOT_PUBLIC", $"{e.Name} is not public: its server actions stay private" + (exposeService ? " and it has no service actions" : "")
                    + " (a public action cannot take or return a record of an entity that is not public); make the entity public to expose them");
            var shape = new Shape(e, id, owner, active, publicServer, services);
            if (kinds.Contains("list")) Add(e, "list", Name("list", e.Name), shape, List);
            if (kinds.Contains("byId")) Add(e, "byId", Name("byId", e.Name), shape, ById);
            if (kinds.Contains("save")) Add(e, "save", Name("save", e.Name), shape, Save);
            if (kinds.Contains("delete")) Add(e, "delete", Name("delete", e.Name), shape, Delete);
        }

        private sealed record Shape(Entity E, Attribute Id, Attribute? Owner, Attribute? Active, bool Public, bool Services)
        {
            /// <summary>Whether a public signature carries the entity's types (its public server actions or its service actions).</summary>
            public bool Exposed => Public || Services;
            public string Record => E.Name + "Record";
        }

        private Attribute? ActiveAttribute(Entity e)
        {
            var soft = data["softDelete"];
            if (soft is JsonValue v && v.TryGetValue<bool>(out var off) && !off) return null;
            var name = soft?["attribute"]?.ToString() ?? e.ActiveAttribute;
            return name == null ? null : e.Find(name) is { Type: "Boolean" } a ? a : null;
        }

        private delegate (string Text, Signature Signature)? Writer(Shape shape, string name);

        /// <summary>The inputs and outputs of a generated server action, for its service action.</summary>
        private sealed record Signature(List<(string Name, string Type, bool Mandatory, string? Default, string Description)> Inputs, List<(string Name, string Type, string Description)> Outputs, string Purpose);

        private void Add(Entity e, string role, string name, Shape shape, Writer writer)
        {
            if (writer(shape, name) is not { } generated) return;
            var placed = Place(new Generated(name, "ServerAction", e.Name, role, generated.Text, shape.Public));
            if (!shape.Services) return;
            var service = ServiceName(name);
            // A service action calls its server action by name: when the module keeps another action under that name, the
            // service would call that one (another signature), so it is not generated either.
            if (!placed)
            {
                plan.Kept.Add(new JsonObject { ["name"] = service, ["entity"] = e.Name, ["role"] = role + "Service",
                    ["why"] = $"its server action {name} is kept (the name is taken in the module), so the service action that would call it is not generated",
                    ["fix"] = "give the generated actions other names (names {...}), or rename the module's own action" });
                return;
            }
            Place(new Generated(service, "ServiceAction", e.Name, role + "Service", ServiceText(service, name, generated.Signature), true));
        }

        /// <summary>True when the generated action is in the module after the op (created, or there already as its text);
        /// false when its name is kept for another element.</summary>
        private bool Place(Generated generated)
        {
            if (!taken.Add(generated.Name))
            {
                plan.Kept.Add(new JsonObject { ["name"] = generated.Name, ["entity"] = generated.Entity, ["why"] = "two generated actions take this name (a names template that gives the same name twice)" });
                return false;
            }
            var existing = model.Existing(generated.Name);
            if (existing == null) { plan.Create.Add(generated); return true; }
            if (existing.Kind == generated.Kind && existing.Text != null && existing.Text == Strip(generated.Text)) { plan.Unchanged.Add(generated); return true; }
            var kept = new JsonObject
            {
                ["name"] = generated.Name, ["entity"] = generated.Entity, ["role"] = generated.Role,
                ["why"] = existing.Kind == generated.Kind && generated.Role == "list" && existing.Text != null && Regex.IsMatch(existing.Text, @"^\s*\w+ = aggregate .* START \S", RegexOptions.Multiline)
                    ? $"the module has {generated.Name} in the earlier generated form, which pages by START on a server aggregate (the runtime ignores it there, LOGIC_START_SERVER_IGNORED: every page shows the first rows): kept as it is; adopt the generated text with the edit below"
                    : existing.Kind == generated.Kind
                    ? $"the module has a {Label(existing.Kind)} {generated.Name} that reads otherwise than the generated one: kept as it is"
                    : $"{generated.Name} is the name of {Article(Label(existing.Kind))} of the module (or of a screen, block or reference in its scope): kept, the {Label(generated.Kind)} is not generated",
                ["generated"] = generated.Text,
                ["fix"] = "names {...} gives the generated actions other names, or rename the module's own action",
            };
            if (existing.Key != null && existing.TextSha != null && existing.Kind == generated.Kind)
                kept["edit"] = new JsonObject { ["key"] = "@" + existing.Key, ["basedOn"] = existing.TextSha, ["how"] = "to adopt the generated text: read the action (ssam_map view flow), replace its body with the generated lines and send it as a logic text with basedOn" };
            plan.Kept.Add(kept);
            return false;
        }

        private static string Label(string kind) => kind switch { "ServerAction" => "server action", "ServiceAction" => "service action", "ClientAction" => "client action", "Action" => "action", _ => kind };
        private static string Article(string label) => ("aeiouAEIOU".Contains(label[0]) ? "an " : "a ") + label;

        // ---- Get{E}List ----

        private (string, Signature)? List(Shape s, string name)
        {
            var e = s.E;
            var item = Name("item", e.Name);
            // The sources: the entity and, per reference, the entity it names (a second reference to the same entity is <R>2).
            var sources = new List<(string Alias, string Entity)> { (e.Name, e.Name) };
            var joinTexts = new List<string>();
            // T3: the page is an SQL with OFFSET (the runtime ignores START on a server aggregate; the Studio hides it there);
            // the same joins and filters in SQL form, every value a parameter, so no dialect writes a literal.
            var sqlJoins = new List<string>(); var sqlWhere = new List<string>(); var sqlParams = new List<(string Name, string Type, string Value)>();
            if (joins)
                foreach (var a in e.Attributes.Where(a => a.References != null && a.Name != e.IdentifierName))
                {
                    var target = a.References!;
                    if (string.Equals(target, e.Name, StringComparison.OrdinalIgnoreCase)) continue;   // a self reference: a filter, not a join
                    var r = model.Reference(target);
                    if (!r.Exists) continue;
                    if (s.Exposed && r.Own && !r.Public)
                    {
                        Note("JOIN_NOT_PUBLIC", $"{name}: {target} is not public, so the public page of {e.Name} does not carry it (the {a.Name} filter stays)");
                        continue;
                    }
                    var alias = target;
                    for (var n = 2; sources.Any(x => string.Equals(x.Alias, alias, StringComparison.OrdinalIgnoreCase)); n++) alias = target + n;
                    sources.Add((alias, target));
                    var inner = a.Mandatory && !string.Equals(a.DeleteRule, "Ignore", StringComparison.OrdinalIgnoreCase);
                    joinTexts.Add((inner ? "Inner " : "Left ") + e.Name + "~" + alias + " ON " + alias + "." + r.IdentifierName + " = " + e.Name + "." + a.Name);
                    var lookup = "(SELECT {" + target + "}.* FROM {" + target + "} WHERE {" + target + "}.[" + r.IdentifierName + "] = {" + e.Name + "}.[" + a.Name + "]) " + alias;
                    sqlJoins.Add(alias == target
                        ? (inner ? "INNER JOIN {" : "LEFT JOIN {") + target + "} ON {" + target + "}.[" + r.IdentifierName + "] = {" + e.Name + "}.[" + a.Name + "]"
                        : model.Lane == "odc" ? (inner ? "JOIN LATERAL " : "LEFT JOIN LATERAL ") + lookup + " ON TRUE" : (inner ? "CROSS APPLY " : "OUTER APPLY ") + lookup);
                }
            // The structure of a row: the aggregate's record (each source, by its name).
            var attributes = sources.Select(x => (x.Alias, x.Entity)).ToList();
            if (!Structure(item, e, attributes, s.Exposed, name)) return null;
            var inputs = new List<(string Name, string Type, bool Mandatory, string? Default, string Description)>();
            var filters = new List<string>();
            var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "List", "TotalCount", "SearchText", "StartIndex", "MaxRecords", "IsInactiveIncluded" };
            // Inside the aggregate a source's name hides an input of the same name (a reference named after its entity,
            // ConstructionType: ConstructionType Identifier): such an input takes another name.
            foreach (var source in sources) used.Add(source.Alias);
            string Input(string wanted) { var n = wanted; for (var k = 2; !used.Add(n); k++) n = wanted + "Filter" + (k > 2 ? k.ToString(System.Globalization.CultureInfo.InvariantCulture) : ""); return n; }
            var filterSetting = data["list"]?["filters"];
            var named = filterSetting is JsonArray ? Names(filterSetting).ToHashSet(StringComparer.OrdinalIgnoreCase) : null;
            var none = filterSetting?.ToString() == "none";
            bool Wanted(Attribute a) => !none && (named == null || named.Contains(a.Name));
            var indexed = e.Indexes.SelectMany(i => i.Columns.Take(1)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var a in e.Attributes)
            {
                if (a.Name == e.IdentifierName || s.Owner != null && a.Name == s.Owner.Name || s.Active != null && a.Name == s.Active.Name || !Wanted(a)) continue;
                if (a.References != null)
                {
                    var input = Input(a.Name);
                    inputs.Add((input, a.Type, false, null, t.FilterReference(e.Name, a.References)));
                    filters.Add($"{input} = NullIdentifier() or {e.Name}.{a.Name} = {input}");
                    SqlFilter(input, a.Type, $"If({input} = NullIdentifier(), 1, 0)", $"{{{e.Name}}}.[{a.Name}] = @{input}");
                }
                else if ((named != null && named.Contains(a.Name) || indexed.Contains(a.Name)) && TextLike(a.Type))
                {
                    var input = Input(a.Name);
                    inputs.Add((input, "Text", false, null, t.FilterText(e.Name, a.Name)));
                    filters.Add($"{input} = \"\" or {e.Name}.{a.Name} = {input}");
                    SqlFilter(input, "Text", $"If({input} = \"\", 1, 0)", $"{{{e.Name}}}.[{a.Name}] = @{input}");
                }
                else if ((named != null && named.Contains(a.Name) || indexed.Contains(a.Name)) && a.Type is "Date" or "Date Time")
                {
                    var from = Input(a.Name + "From"); var to = Input(a.Name + "To");
                    inputs.Add((from, a.Type, false, null, t.FilterFrom(e.Name, a.Name)));
                    inputs.Add((to, a.Type, false, null, t.FilterTo(e.Name, a.Name)));
                    filters.Add($"{from} = NullDate() or {e.Name}.{a.Name} >= {from}");
                    filters.Add($"{to} = NullDate() or {e.Name}.{a.Name} <= {to}");
                    SqlFilter(from, a.Type, $"If({from} = NullDate(), 1, 0)", $"{{{e.Name}}}.[{a.Name}] >= @{from}");
                    SqlFilter(to, a.Type, $"If({to} = NullDate(), 1, 0)", $"{{{e.Name}}}.[{a.Name}] <= @{to}");
                }
            }
            var searched = new List<string>();
            if (search)
            {
                // The identifier is never searched as text (a Text identifier is an Identifier in expressions).
                if (e.LabelAttribute is { } label && label != e.IdentifierName && e.Find(label) is { } la && TextLike(la.Type) && Searchable(la)) searched.Add(la.Name);
                foreach (var a in e.Attributes.Where(a => a.Name != e.IdentifierName && indexed.Contains(a.Name) && TextLike(a.Type) && Searchable(a))) if (!searched.Contains(a.Name)) searched.Add(a.Name);
                if (searched.Count == 0 && e.Attributes.FirstOrDefault(a => a.Mandatory && TextLike(a.Type) && Searchable(a) && a.Name != e.IdentifierName) is { } first) searched.Add(first.Name);
            }
            if (searched.Count > 0)
            {
                inputs.Add(("SearchText", "Text", false, null, t.Search(e.Name, searched)));
                filters.Add("Trim(SearchText) = \"\"" + string.Concat(searched.Select(a => $" or {e.Name}.{a} like \"%\" + Trim(SearchText) + \"%\"")));
                sqlParams.Add(("NoSearchText", "Integer", "If(Trim(SearchText) = \"\", 1, 0)"));
                sqlParams.Add(("SearchPattern", "Text", "\"%\" + ToLower(Trim(SearchText)) + \"%\""));
                sqlWhere.Add("(@NoSearchText = 1" + string.Concat(searched.Select(a => $" OR LOWER({{{e.Name}}}.[{a}]) LIKE @SearchPattern")) + ")");
            }
            if (s.Active != null)
            {
                inputs.Add(("IsInactiveIncluded", "Boolean", false, null, t.IncludeInactive(e.Name)));
                filters.Add($"IsInactiveIncluded or {e.Name}.{s.Active.Name}");
                sqlParams.Add(("InactiveIncluded", "Integer", "If(IsInactiveIncluded, 1, 0)"));
                sqlParams.Add(("ActiveValue", "Boolean", "True"));
                sqlWhere.Add($"(@InactiveIncluded = 1 OR {{{e.Name}}}.[{s.Active.Name}] = @ActiveValue)");
            }
            if (s.Owner != null)
            {
                filters.Add($"{e.Name}.{s.Owner.Name} = GetUserId()");
                sqlParams.Add(("SignedInUser", s.Owner.Type, "GetUserId()"));
                sqlWhere.Add($"({{{e.Name}}}.[{s.Owner.Name}] = @SignedInUser)");
            }
            void SqlFilter(string input, string type, string off, string condition)
            {
                sqlParams.Add((input, type, input));
                sqlParams.Add(("No" + input, "Integer", off));
                sqlWhere.Add($"(@No{input} = 1 OR {condition})");
            }
            if (paging)
            {
                inputs.Add(("StartIndex", "Integer", false, null, t.StartIndex()));
                inputs.Add(("MaxRecords", "Integer", false, pageSize.ToString(System.Globalization.CultureInfo.InvariantCulture), t.MaxRecords()));
            }
            var outputs = new List<(string Name, string Type, string Description)>
            {
                ("List", item + " List", t.ListOutput(e.Name, sources.Skip(1).Select(x => x.Alias).ToList())),
                ("TotalCount", "Long Integer", t.TotalCount(e.Name)),
            };
            var sort = Sort(e);
            var aggregate = "Read" + e.Name + "Page";
            var query = new StringBuilder("aggregate FROM ").Append(string.Join(", ", sources.Select(x => x.Alias == x.Entity ? x.Entity : x.Alias + "=" + x.Entity).Order(StringComparer.Ordinal)));
            if (joinTexts.Count > 0) query.Append(" JOIN ").Append(string.Join(" | ", joinTexts.Order(StringComparer.Ordinal)));
            if (filters.Count > 0) query.Append(" WHERE ").Append(string.Join(" AND ", filters.Select(f => "(" + f + ")").Order(StringComparer.Ordinal)));
            query.Append(" SORT ").Append(sort);
            query.Append(" MAX ").Append(paging ? "MaxRecords" : pageSize.ToString(System.Globalization.CultureInfo.InvariantCulture));
            var w = new FlowWriter();
            w.Header("server action", name, s.Public, t.ListPurpose(e.Name, filters.Count > 0, sources.Count > 1, s.Owner != null));
            foreach (var p in inputs) w.Input(p.Name, p.Type, p.Mandatory, p.Default, p.Description);
            foreach (var p in outputs) w.Output(p.Name, p.Type, p.Description);
            var total = aggregate + ".Count";
            if (!paging) w.Node(1, aggregate + " = " + query, t.PageAggregate(e.Name));
            else
            {
                // The page: ORDER BY the sort and the identifier (a total order, so pages never overlap), OFFSET/FETCH (SQL Server
                // 2012+, Oracle 12c+, PostgreSQL); the total: COUNT(*) OVER() of the same query (the window counts before OFFSET),
                // so the total and the rows never disagree, whatever the collation. Skip is never negative and Take never 0 (FETCH
                // NEXT 0 is an error on SQL Server, 10744).
                var size = $"If(MaxRecords <= 0, {pageSize.ToString(System.Globalization.CultureInfo.InvariantCulture)}, MaxRecords)";
                var counted = CountStructure(s.Exposed, name);
                w.Node(1, aggregate + " = sql -> " + string.Join(", ", sources.Select(x => x.Entity)) + ", " + counted + " max " + size, t.PageAggregate(e.Name));
                foreach (var (pn, pt, pv) in sqlParams) w.Line(2, $"in {pn}: {pt} = {pv}");
                w.Line(2, "in Skip: Integer = Max(0, StartIndex)");
                w.Line(2, "in Take: Integer = " + size);
                w.Line(2, "| SELECT " + string.Join(", ", sources.Select(x => x.Alias == x.Entity ? "{" + x.Entity + "}.*" : x.Alias + ".*")) + ", COUNT(*) OVER()");
                w.Line(2, "| FROM {" + e.Name + "}");
                foreach (var j in sqlJoins.Order(StringComparer.Ordinal)) w.Line(2, "| " + j);
                if (sqlWhere.Count > 0) w.Line(2, "| WHERE " + string.Join(" AND ", sqlWhere.Order(StringComparer.Ordinal)));
                w.Line(2, "| ORDER BY " + SqlSort(e, sort));
                w.Line(2, "| OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY");
                total = $"If({aggregate}.List.Empty, 0, {aggregate}.List.Current.List_{sources.Count + 1}.{CountAttribute})";
            }
            // The page is the aggregate's list: O11 converts it to the row structure by itself (same names); ODC keeps that
            // conversion as a mapping of every row field from the source of the same name, which the text writes as it reads.
            var page = paging
                ? aggregate + ".List mapTo { " + string.Join(", ", sources.Select((x, i) => x.Alias + ": List" + (i == 0 ? "" : "_" + (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)))) + " }"
                : model.Lane == "odc" ? aggregate + ".List mapTo { " + string.Join(", ", sources.Select(x => x.Alias + ": " + x.Alias)) + " }" : aggregate + ".List";
            w.Assign(1, t.ReturnPage(), ("List", page), ("TotalCount", total));
            w.End(1);
            return (w.Text(), new Signature(inputs, outputs, t.ListPurpose(e.Name, filters.Count > 0, sources.Count > 1, s.Owner != null)));
        }

        private static bool TextLike(string type) => type is "Text" or "Email" or "Phone Number";

        private const string CountAttribute = "Total";
        private string? countStructure;

        /// <summary>The structure the page's COUNT(*) OVER() fills (one attribute, Total: Long Integer): PagedRowCount, created once
        /// per module when missing, reused when the module has it with that shape; another element of that name moves it to
        /// PagedRowCount2, 3, ... Public when a public list uses it.</summary>
        private string CountStructure(bool isPublic, string action)
        {
            if (countStructure != null)
            {
                if (isPublic && plan.Ops.OfType<JsonObject>().LastOrDefault(o => o["data"]?["structures"]?[0]?["name"]?.ToString() == countStructure) is { } created
                    && created["data"]!["structures"]![0]!["public"]?.GetValue<bool>() == false) created["data"]!["structures"]![0]!["public"] = true;
                return countStructure;
            }
            for (var n = 1; ; n++)
            {
                var name = "PagedRowCount" + (n == 1 ? "" : n.ToString(System.Globalization.CultureInfo.InvariantCulture));
                var existing = model.Structures.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
                if (existing.Name != null)
                {
                    if (existing.Attributes.Count == 1 && string.Equals(existing.Attributes[0].Attribute, CountAttribute, StringComparison.OrdinalIgnoreCase)
                        && string.Equals(existing.Attributes[0].Type, "Long Integer", StringComparison.OrdinalIgnoreCase))
                    {
                        plan.Structures.Add(new JsonObject { ["name"] = existing.Name, ["created"] = false });
                        return countStructure = existing.Name;
                    }
                    continue;
                }
                if (model.TopElement(name) != null || !taken.Add(name)) continue;
                var spec = new JsonObject
                {
                    ["name"] = name, ["public"] = isPublic, ["description"] = t.CountItem(),
                    ["attributes"] = new JsonArray(new JsonObject { ["name"] = CountAttribute, ["type"] = "Long Integer", ["description"] = t.CountItemTotal() }),
                };
                plan.Ops.Add(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["structures"] = new JsonArray(spec) } });
                plan.Structures.Add(new JsonObject { ["name"] = name, ["created"] = true, ["public"] = isPublic });
                return countStructure = name;
            }
        }

        /// <summary>The ORDER BY of the SQL page: the aggregate's sort ("E.Attr [desc]"), then the identifier, so the order is
        /// total and two pages never share a row.</summary>
        private static string SqlSort(Entity e, string sort)
        {
            var desc = sort.EndsWith(" desc", StringComparison.Ordinal);
            var attribute = (desc ? sort[..^5] : sort)[(e.Name.Length + 1)..];
            var order = "{" + e.Name + "}.[" + attribute + "]" + (desc ? " DESC" : "");
            return e.IdentifierName == null || attribute == e.IdentifierName ? order : order + ", {" + e.Name + "}.[" + e.IdentifierName + "]";
        }
        private static bool Searchable(Attribute a) => a.Length is null or <= 2000;

        private string Sort(Entity e)
        {
            var setting = data["list"]?["sort"];
            string? chosen = setting switch
            {
                JsonObject per when per[e.Name] is JsonValue v => v.ToString(),
                JsonObject per when per.FirstOrDefault(p => string.Equals(p.Key, e.Name, StringComparison.OrdinalIgnoreCase)).Value is JsonValue v => v.ToString(),
                JsonValue v when v.ToString() != "auto" && e.Find(v.ToString().TrimStart('-')) != null => v.ToString(),
                _ => null,
            };
            if (chosen != null)
            {
                var attribute = e.Find(chosen.TrimStart('-'))!;
                return e.Name + "." + attribute.Name + (chosen.StartsWith('-') ? " desc" : "");
            }
            if (e.LabelAttribute is { } label && e.Find(label) is { } la && la.Type != "Binary Data" && Searchable(la)) return e.Name + "." + la.Name;
            if (e.Attributes.FirstOrDefault(a => a.Mandatory && TextLike(a.Type) && Searchable(a) && a.Name != e.IdentifierName) is { } first) return e.Name + "." + first.Name;
            return e.Name + "." + e.IdentifierName + " desc";
        }

        /// <summary>The {E}ListItem structure: created when missing, reused when the module has it with the same attributes; any
        /// other element of that name keeps the list action from being generated (kept, listed).</summary>
        private bool Structure(string name, Entity e, List<(string Alias, string Entity)> attributes, bool isPublic, string action)
        {
            var existing = model.Structures.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (existing.Name != null)
            {
                var same = existing.Attributes.Count == attributes.Count && existing.Attributes.Zip(attributes).All(p => string.Equals(p.First.Attribute, p.Second.Alias, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(p.First.Type, p.Second.Entity, StringComparison.OrdinalIgnoreCase));
                if (same) { plan.Structures.Add(new JsonObject { ["name"] = existing.Name, ["created"] = false }); return true; }
                plan.Kept.Add(new JsonObject { ["name"] = action, ["entity"] = e.Name, ["role"] = "list",
                    ["why"] = $"the module has a structure {existing.Name} with other attributes ({string.Join(", ", existing.Attributes.Select(a => a.Attribute + ": " + a.Type))}): the page of {e.Name} needs {string.Join(", ", attributes.Select(a => a.Alias + ": " + a.Entity))}; kept, the list action is not generated",
                    ["fix"] = "rename that structure, or give the item another name (names.item)" });
                return false;
            }
            if (model.TopElement(name) is { } other)
            {
                plan.Kept.Add(new JsonObject { ["name"] = action, ["entity"] = e.Name, ["role"] = "list", ["why"] = $"{name} is the name of a {other} of the module: the list action is not generated", ["fix"] = "give the item another name (names.item)" });
                return false;
            }
            if (!taken.Add(name)) return true;   // two entities never share an item name ({E} is in it); a template without {E} is refused
            var spec = new JsonObject
            {
                ["name"] = name, ["public"] = isPublic, ["description"] = t.Item(e.Name),
                ["attributes"] = new JsonArray(attributes.Select(a => (JsonNode)new JsonObject { ["name"] = a.Alias, ["type"] = a.Entity, ["description"] = t.ItemAttribute(e.Name, a.Alias, a.Entity) }).ToArray()),
            };
            plan.Ops.Add(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["structures"] = new JsonArray(spec) } });
            plan.Structures.Add(new JsonObject { ["name"] = name, ["created"] = true, ["public"] = isPublic });
            return true;
        }

        // ---- Get{E}ById ----

        private (string, Signature)? ById(Shape s, string name)
        {
            var e = s.E;
            var read = "Read" + e.Name;
            var w = new FlowWriter();
            var purpose = t.ByIdPurpose(e.Name, s.Owner != null);
            w.Header("server action", name, s.Public, purpose);
            var inputs = new List<(string, string, bool, string?, string)> { ("Id", e.Name + " Identifier", true, null, t.IdInput(e.Name, "read")) };
            var outputs = new List<(string, string, string)> { (s.Record, e.Name, t.RecordOutput(e.Name)) };
            w.Input("Id", e.Name + " Identifier", true, null, t.IdInput(e.Name, "read"));
            w.Output(s.Record, e.Name, t.RecordOutput(e.Name));
            w.Node(1, $"{read} = aggregate FROM {e.Name} WHERE ({e.Name}.{s.Id.Name} = Id) MAX 1", t.ReadOne(e.Name));
            w.If(1, $"{read}.List.Empty", t.AskMissing(e.Name));
            w.Line(2, Raise("notFound", t.NotFound(e.Name)));
            if (s.Owner != null)
            {
                w.If(1, $"{read}.List.Current.{e.Name}.{s.Owner.Name} <> GetUserId()", t.AskOtherOwner(e.Name));
                w.Line(2, Raise("forbidden", t.Forbidden(e.Name)));
            }
            w.Assign(1, t.ReturnRecord(), (s.Record, $"{read}.List.Current.{e.Name}"));
            w.End(1);
            return (w.Text(), new Signature(inputs, outputs, purpose));
        }

        // ---- Save{E} ----

        private (string, Signature)? Save(Shape s, string name)
        {
            var e = s.E;
            var r = s.Record;
            var read = "Read" + e.Name;
            var auto = s.Id.Auto;
            var w = new FlowWriter();
            var purpose = t.SavePurpose(e.Name, validations, s.Owner != null);
            w.Header("server action", name, s.Public, purpose);
            w.Input(r, e.Name, true, null, t.SaveInput(e.Name, auto));
            w.Output("Id", e.Name + " Identifier", t.IdOutput(e.Name));
            w.Comment(t.SaveComment());
            // The stored record: it must exist to be updated, and its owner is kept.
            if (auto || s.Owner != null)
            {
                w.Node(1, $"{read} = aggregate FROM {e.Name} WHERE ({e.Name}.{s.Id.Name} = {r}.{s.Id.Name}) MAX 1", t.ReadStored(e.Name));
                if (auto)
                {
                    w.If(1, $"{r}.{s.Id.Name} <> NullIdentifier() and {read}.List.Empty", t.AskUpdateMissing(e.Name));
                    w.Line(2, Raise("notFound", t.NotFound(e.Name)));
                }
                if (s.Owner != null)
                {
                    w.If(1, $"not {read}.List.Empty and {read}.List.Current.{e.Name}.{s.Owner.Name} <> GetUserId()", t.AskOtherOwner(e.Name));
                    w.Line(2, Raise("forbidden", t.Forbidden(e.Name)));
                    w.Assign(1, t.SetOwner(), ($"{r}.{s.Owner.Name}", $"If({read}.List.Empty, GetUserId(), {read}.List.Current.{e.Name}.{s.Owner.Name})"));
                }
            }
            if (validations) Validations(w, s, r);
            if (auto)
            {
                w.If(1, $"{r}.{s.Id.Name} = NullIdentifier()", t.AskNew(e.Name));
                w.Line(2, $"Create{e.Name}(Source={r})");
                w.Assign(2, t.ReturnNewId(), ("Id", $"Create{e.Name}.Id"));
                w.End(2);
                w.Line(1, $"Update{e.Name}(Source={r})");
                w.Assign(1, t.ReturnId(), ("Id", $"{r}.{s.Id.Name}"));
                w.End(1);
            }
            else
            {
                w.Line(1, $"CreateOrUpdate{e.Name}(Source={r})");
                w.Assign(1, t.ReturnId(), ("Id", $"CreateOrUpdate{e.Name}.Id"));
                w.End(1);
            }
            return (w.Text(), new Signature([(r, e.Name, true, null, t.SaveInput(e.Name, auto))], [("Id", e.Name + " Identifier", t.IdOutput(e.Name))], purpose));
        }

        private void Validations(FlowWriter w, Shape s, string r)
        {
            var e = s.E;
            foreach (var a in e.Attributes)
            {
                if (a.Name == e.IdentifierName || s.Owner != null && a.Name == s.Owner.Name) continue;
                if (a.Mandatory)
                {
                    // A required number, Boolean, Time or Binary Data is never checked: OutSystems has no null for them (0,
                    // False, 00:00:00 are the values the platform writes and a record may mean them), so no one rule tells
                    // "missing" from "zero"; only the types whose empty value is never data are checked.
                    string? missing = a.References != null ? $"{r}.{a.Name} = NullIdentifier()"
                        : TextLike(a.Type) ? $"Trim({r}.{a.Name}) = \"\""
                        : a.Type is "Date" or "Date Time" ? $"{r}.{a.Name} = NullDate()"
                        : null;
                    if (missing != null)
                    {
                        w.If(1, missing, t.AskRequired(a.Name));
                        w.Line(2, Raise("validation", t.Required(e.Name, a.Name)));
                    }
                }
                if (TextLike(a.Type) && a.Length is { } length and > 0 and < 2000)
                {
                    w.If(1, $"Length({r}.{a.Name}) > {length.ToString(System.Globalization.CultureInfo.InvariantCulture)}", t.AskTooLong(a.Name, length));
                    w.Line(2, Raise("validation", t.TooLong(e.Name, a.Name, length)));
                }
            }
            // A reference must name a record that exists (the static ones are values of the module).
            foreach (var a in e.Attributes.Where(a => a.References != null && a.Name != e.IdentifierName && (s.Owner == null || a.Name != s.Owner.Name)))
            {
                var target = model.Reference(a.References!);
                if (!target.Exists || target.Static) continue;
                var check = w.NodeName("Check" + a.Name);
                w.Node(1, $"{check} = aggregate FROM {a.References} WHERE ({a.References}.{target.IdentifierName} = {r}.{a.Name}) MAX 1", t.CheckReference(a.References!, a.Name));
                w.If(1, $"{r}.{a.Name} <> NullIdentifier() and {check}.List.Empty", t.AskReferenceMissing(a.References!));
                w.Line(2, Raise("validation", t.ReferenceMissing(e.Name, a.Name, a.References!)));
            }
            // Unique keys: another record with the same values.
            foreach (var index in e.Indexes.Where(i => i.Unique && i.Columns.Count > 0 && !(i.Columns.Count == 1 && i.Columns[0] == e.IdentifierName)))
            {
                var columns = index.Columns.Select(c => e.Find(c)).ToList();
                if (columns.Any(c => c == null)) continue;
                var find = w.NodeName("Find" + e.Name + "By" + string.Concat(columns.Select(c => c!.Name)));
                var where = columns.Select(c => $"({e.Name}.{c!.Name} = {r}.{c.Name})").Append($"({e.Name}.{s.Id.Name} <> {r}.{s.Id.Name})").Order(StringComparer.Ordinal);
                w.Node(1, $"{find} = aggregate FROM {e.Name} WHERE {string.Join(" AND ", where)} MAX 1", t.FindDuplicate(e.Name, columns.Select(c => c!.Name).ToList()));
                w.If(1, $"not {find}.List.Empty", t.AskDuplicate(columns.Select(c => c!.Name).ToList()));
                w.Line(2, Raise("validation", t.Duplicate(e.Name, columns.Select(c => c!.Name).ToList())));
            }
        }

        // ---- Remove{E} ----

        private (string, Signature)? Delete(Shape s, string name)
        {
            var e = s.E;
            var read = "Read" + e.Name;
            var w = new FlowWriter();
            var children = s.Active != null ? [] : model.Entities.SelectMany(c => c.Attributes.Where(a => string.Equals(a.References, e.Name, StringComparison.OrdinalIgnoreCase)
                && string.Equals(a.DeleteRule, "Protect", StringComparison.OrdinalIgnoreCase) && !(c.Name == e.Name && a.Name == e.IdentifierName)).Select(a => (Child: c, Attribute: a)))
                .OrderBy(p => p.Child.Name, StringComparer.Ordinal).ThenBy(p => p.Attribute.Name, StringComparer.Ordinal).ToList();
            var purpose = t.DeletePurpose(e.Name, s.Owner != null, children.Count > 0, s.Active?.Name);
            w.Header("server action", name, s.Public, purpose);
            w.Input("Id", e.Name + " Identifier", true, null, t.IdInput(e.Name, "delete"));
            w.Comment(t.DeleteComment());
            w.Node(1, $"{read} = aggregate FROM {e.Name} WHERE ({e.Name}.{s.Id.Name} = Id) MAX 1", t.ReadStored(e.Name));
            w.If(1, $"{read}.List.Empty", t.AskMissing(e.Name));
            w.Line(2, Raise("notFound", t.NotFound(e.Name)));
            if (s.Owner != null)
            {
                w.If(1, $"{read}.List.Current.{e.Name}.{s.Owner.Name} <> GetUserId()", t.AskOtherOwner(e.Name));
                w.Line(2, Raise("forbidden", t.Forbidden(e.Name)));
            }
            var counted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (child, attribute) in children)
            {
                if (!counted.Add(child.Name + "." + attribute.Name)) continue;
                var count = w.NodeName("Read" + child.Name + "By" + attribute.Name);
                w.Node(1, $"{count} = aggregate FROM {child.Name} WHERE ({child.Name}.{attribute.Name} = Id) MAX 1", t.ReadChild(child.Name, attribute.Name, e.Name));
                w.If(1, $"not {count}.List.Empty", t.AskReferenced(child.Name));
                w.Line(2, Raise("validation", t.Referenced(e.Name, child.Name)));
            }
            if (s.Active != null)
            {
                w.Assign(1, t.MarkInactive(), ($"{read}.List.Current.{e.Name}.{s.Active.Name}", "False"));
                w.Line(1, $"Update{e.Name}(Source={read}.List.Current.{e.Name})");
            }
            else w.Line(1, $"Delete{e.Name}(Id)");
            w.End(1);
            return (w.Text(), new Signature([("Id", e.Name + " Identifier", true, null, t.IdInput(e.Name, "delete"))], [], purpose));
        }

        // ---- the service action of a server action ----

        private string ServiceText(string name, string action, Signature signature)
        {
            var w = new FlowWriter();
            w.Header("service action", name, true, t.ServicePurpose(action, signature.Purpose));
            foreach (var p in signature.Inputs) w.Input(p.Name, p.Type, p.Mandatory, p.Default, p.Description);
            foreach (var p in signature.Outputs) w.Output(p.Name, p.Type, p.Description);
            w.Line(1, action + "(" + string.Join(", ", signature.Inputs.Select(p => p.Name).Order(StringComparer.Ordinal)) + ")");
            if (signature.Outputs.Count > 0) w.Assign(1, t.ReturnOutputs(action), signature.Outputs.Select(o => (o.Name, action + "." + o.Name)).ToArray());
            w.End(1);
            return w.Text();
        }
    }

    // ---- the text ------------------------------------------------------------------------------------------------------------

    /// <summary>Writes an action in the printer's own form (FlowPrinter), so a created action reads back as its text byte for byte:
    /// /// descriptions above their element, the header without a key, parameters (in, out), comments, then the flow; an If's
    /// true branch indented under it and its false branch below; one End per branch.</summary>
    private sealed class FlowWriter
    {
        private readonly List<string> lines = [];
        private readonly List<string> body = [];
        private readonly List<string> comments = [];
        private readonly HashSet<string> nodeNames = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>A node name the Studio keeps whole: at most 50 characters (it cuts a longer one), unique in the action (a
        /// number at its end when two would be the same).</summary>
        public string NodeName(string wanted)
        {
            const int Max = 50;
            var name = wanted.Length <= Max ? wanted : wanted[..Max];
            for (var n = 2; !nodeNames.Add(name); n++)
            {
                var suffix = n.ToString(System.Globalization.CultureInfo.InvariantCulture);
                name = (wanted.Length + suffix.Length <= Max ? wanted : wanted[..(Max - suffix.Length)]) + suffix;
            }
            return name;
        }

        public void Header(string label, string name, bool isPublic, string description)
        {
            Describe(lines, 0, description);
            lines.Add(label + " " + name + (isPublic ? " public" : ""));
        }

        public void Input(string name, string type, bool mandatory, string? value, string description)
        {
            Describe(lines, 1, description);
            lines.Add("  in " + name + (mandatory ? "" : "?") + ": " + type + (value != null ? " = " + value : ""));
        }

        public void Output(string name, string type, string description)
        {
            Describe(lines, 1, description);
            lines.Add("  out " + name + ": " + type);
        }

        public void Comment(string text) => comments.Add("  // " + text);

        public void Line(int depth, string text) => body.Add(new string(' ', depth * 2) + text);
        public void Node(int depth, string text, string description) { Describe(body, depth, description); Line(depth, text); }
        public void If(int depth, string condition, string question) => Line(depth, "if " + condition + ":  # " + question);
        public void End(int depth) => Line(depth, "end");

        public void Assign(int depth, string label, params (string Variable, string Value)[] assignments)
        {
            if (assignments.Length == 1) { Line(depth, "assign " + assignments[0].Variable + " = " + assignments[0].Value + "  # " + label); return; }
            Line(depth, "assign  # " + label);
            foreach (var (variable, value) in assignments) Line(depth + 1, variable + " = " + value);
        }

        private static void Describe(List<string> to, int depth, string description)
        {
            foreach (var line in description.Split('\n')) to.Add(new string(' ', depth * 2) + (line.Length == 0 ? "///" : "/// " + line));
        }

        public string Text() => string.Join("\n", lines.Concat(comments.Order(StringComparer.Ordinal)).Concat(body)) + "\n";
    }

    /// <summary>What the platform writes on an element the text creates and the text cannot write (the master source of an ODC
    /// aggregate with joins, read as @{MasterSource=&amp;"E"}): left out of the read that a generated text compares with.</summary>
    private static readonly HashSet<string> CreationDefaults = new(StringComparer.Ordinal) { "MasterSource" };

    /// <summary>A read text without its ids: the header's key and every element's id gone, so a generated text (which has none)
    /// compares with the read of the action it would be; an @{...} line of only what the platform fills on creation goes too.</summary>
    public static string Strip(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        for (var i = lines.Count - 1; i >= 0; i--)
        {
            var trimmed = lines[i].Trim();
            if (!trimmed.StartsWith("@{", StringComparison.Ordinal) || !trimmed.EndsWith('}')) continue;
            try { if (Anvil.Reading.FlowSyntax.ReadPassthrough(trimmed).All(p => CreationDefaults.Contains(p.Key))) lines.RemoveAt(i); }
            catch (FormatException) { }
        }
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            if (line.TrimStart().StartsWith("///", StringComparison.Ordinal) || line.TrimStart().StartsWith("| ", StringComparison.Ordinal)) continue;
            var at = line.LastIndexOf(" @", StringComparison.Ordinal);
            if (at < 0) continue;
            var token = line[(at + 2)..];
            if (token.Length > 0 && token.All(c => char.IsLetterOrDigit(c) || c is '+' or '/' or '_' or '-' or '=' or '.' or '#')) lines[i] = line[..at];
        }
        return string.Join("\n", lines);
    }

    private static string Quote(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";

    // ---- descriptions and messages (en, pt) ---------------------------------------------------------------------------------

    private sealed class Texts(bool pt)
    {
        private string L(string en, string ptText) => pt ? ptText : en;
        private static string Join(IReadOnlyList<string> items) => string.Join(", ", items);

        public string Exception(string role) => role switch
        {
            "validation" => L("Raised when a record breaks a rule of the data model (a required field, a length, a reference, a unique key).", "Lançada quando um registro quebra uma regra do modelo de dados (campo obrigatório, tamanho, referência, chave única)."),
            "notFound" => L("Raised when the record asked for does not exist.", "Lançada quando o registro pedido não existe."),
            _ => L("Raised when the signed-in user does not own the record.", "Lançada quando o usuário logado não é o dono do registro."),
        };

        public string ListPurpose(string e, bool filtered, bool joined, bool owned) =>
            L($"Lists {e} records one page at a time{(filtered ? ", filtered on the server" : "")}{(joined ? ", each with the records it references" : "")}{(owned ? ", only those of the signed-in user" : "")}, so screens and services never filter or join on the client.",
              $"Lista registros de {e} uma página por vez{(filtered ? ", filtrados no servidor" : "")}{(joined ? ", cada um com os registros que referencia" : "")}{(owned ? ", só os do usuário logado" : "")}, para que telas e serviços não filtrem nem juntem no cliente.");
        public string FilterReference(string e, string r) => L($"Only {e} records that reference this {r}; empty for any.", $"Só registros de {e} que referenciam este {r}; vazio para qualquer um.");
        public string FilterText(string e, string a) => L($"Only {e} records whose {a} is exactly this text; empty for any.", $"Só registros de {e} cujo {a} é exatamente este texto; vazio para qualquer um.");
        public string FilterFrom(string e, string a) => L($"Only {e} records whose {a} is on or after this value; empty for no lower bound.", $"Só registros de {e} com {a} a partir deste valor; vazio para sem limite inferior.");
        public string FilterTo(string e, string a) => L($"Only {e} records whose {a} is on or before this value; empty for no upper bound.", $"Só registros de {e} com {a} até este valor; vazio para sem limite superior.");
        public string Search(string e, IReadOnlyList<string> attributes) => L($"Text searched in {Join(attributes)} of {e}; empty for no search.", $"Texto procurado em {Join(attributes)} de {e}; vazio para não procurar.");
        public string IncludeInactive(string e) => L($"True to list inactive {e} records too; by default only the active ones.", $"Verdadeiro para listar também os registros inativos de {e}; por padrão só os ativos.");
        public string StartIndex() => L("Zero-based index of the first row of the page, applied as the OFFSET of the page query.", "Índice (a partir de zero) da primeira linha da página, aplicado como o OFFSET da consulta da página.");
        public string MaxRecords() => L("Rows per page, applied as the FETCH NEXT of the page query.", "Linhas por página, aplicadas como o FETCH NEXT da consulta da página.");
        public string CountItem() => L("The total of a page query: how many rows its filters select, counted by the same query (COUNT(*) OVER()).", "O total de uma consulta paginada: quantas linhas os filtros dela selecionam, contadas pela mesma consulta (COUNT(*) OVER()).");
        public string CountItemTotal() => L("How many rows the filters select, before the page is cut.", "Quantas linhas os filtros selecionam, antes do corte da página.");
        public string ListOutput(string e, IReadOnlyList<string> joined) => L($"The rows of the page: each {e}" + (joined.Count > 0 ? $" with {Join(joined)}" : "") + ", already filtered and sorted.",
            $"As linhas da página: cada {e}" + (joined.Count > 0 ? $" com {Join(joined)}" : "") + ", já filtradas e ordenadas.");
        public string TotalCount(string e) => L($"How many {e} records match the filters, for the pager.", $"Quantos registros de {e} atendem aos filtros, para o paginador.");
        public string PageAggregate(string e) => L($"One page of {e}: filters, joins, sort and paging run in the database.", $"Uma página de {e}: filtros, junções, ordenação e paginação rodam no banco.");
        public string ReturnPage() => L("Return the page and the total", "Devolver a página e o total");
        public string Item(string e) => L($"One row of the {e} page: the {e} and the records its references name, as the list aggregate reads them.", $"Uma linha da página de {e}: o {e} e os registros que as referências dele apontam, como o aggregate da lista os lê.");
        public string ItemAttribute(string e, string alias, string entity) => alias == e ? L($"The {e} of the row.", $"O {e} da linha.")
            : L($"The {entity} this {e} references (empty when the reference is empty).", $"O {entity} que este {e} referencia (vazio quando a referência está vazia).");

        public string ByIdPurpose(string e, bool owned) => L($"Reads one {e} by its identifier for the screens and services that show or edit it; raises an error when it does not exist{(owned ? " or belongs to another user" : "")}.",
            $"Lê um {e} pelo identificador para as telas e serviços que o mostram ou editam; lança erro quando ele não existe{(owned ? " ou é de outro usuário" : "")}.");
        public string IdInput(string e, string verb) => verb == "read" ? L($"Identifier of the {e} to read.", $"Identificador do {e} a ler.") : L($"Identifier of the {e} to delete.", $"Identificador do {e} a apagar.");
        public string RecordOutput(string e) => L($"The {e} as stored.", $"O {e} como está gravado.");
        public string ReadOne(string e) => L($"The {e} with this identifier (at most one row).", $"O {e} com este identificador (no máximo uma linha).");
        public string AskMissing(string e) => L($"{e} not found?", $"{e} não encontrado?");
        public string AskOtherOwner(string e) => L($"{e} owned by another user?", $"{e} é de outro usuário?");
        public string ReturnRecord() => L("Return the record", "Devolver o registro");
        public string NotFound(string e) => L($"{e} not found.", $"{e} não encontrado.");
        public string Forbidden(string e) => L($"This {e} belongs to another user.", $"Este {e} pertence a outro usuário.");

        public string SavePurpose(string e, bool validated, bool owned) => L($"Creates or updates one {e}{(validated ? " after checking its required fields, text lengths, references and unique keys" : "")}{(owned ? ", only for its owner" : "")}, so every write of {e} goes through the same rules.",
            $"Cria ou atualiza um {e}{(validated ? " depois de conferir campos obrigatórios, tamanhos, referências e chaves únicas" : "")}{(owned ? ", só para o dono" : "")}, para que toda gravação de {e} passe pelas mesmas regras.");
        public string SaveInput(string e, bool auto) => auto ? L($"The {e} to save: an empty identifier creates it, any other updates it.", $"O {e} a gravar: identificador vazio cria, qualquer outro atualiza.")
            : L($"The {e} to save (created when its identifier is new, updated otherwise).", $"O {e} a gravar (criado quando o identificador é novo, atualizado senão).");
        public string IdOutput(string e) => L($"Identifier of the {e} created or updated.", $"Identificador do {e} criado ou atualizado.");
        public string SaveComment() => L("Checks first (existence, owner, data rules), then one write", "Primeiro as checagens (existência, dono, regras dos dados), depois uma gravação");
        public string ReadStored(string e) => L($"The stored {e}, to check that it exists and who owns it.", $"O {e} gravado, para conferir que existe e quem é o dono.");
        public string AskUpdateMissing(string e) => L($"{e} to update not found?", $"{e} a atualizar não encontrado?");
        public string SetOwner() => L("Keep the owner, or set the signed-in user on a new record", "Manter o dono, ou pôr o usuário logado num registro novo");
        public string AskRequired(string a) => L($"{a} missing?", $"{a} ausente?");
        public string Required(string e, string a) => L($"{e}: {a} is required.", $"{e}: {a} é obrigatório.");
        public string AskTooLong(string a, int length) => L($"{a} longer than {length}?", $"{a} maior que {length}?");
        public string TooLong(string e, string a, int length) => L($"{e}: {a} has more than {length} characters.", $"{e}: {a} tem mais de {length} caracteres.");
        public string CheckReference(string r, string a) => L($"The {r} that {a} names, which must exist.", $"O {r} que {a} aponta, que precisa existir.");
        public string AskReferenceMissing(string r) => L($"{r} not found?", $"{r} não encontrado?");
        public string ReferenceMissing(string e, string a, string r) => L($"{e}: the {r} in {a} does not exist.", $"{e}: o {r} em {a} não existe.");
        public string FindDuplicate(string e, IReadOnlyList<string> columns) => L($"Another {e} with the same {Join(columns)} (a unique key).", $"Outro {e} com o mesmo {Join(columns)} (chave única).");
        public string AskDuplicate(IReadOnlyList<string> columns) => L($"{Join(columns)} already used?", $"{Join(columns)} já usado?");
        public string Duplicate(string e, IReadOnlyList<string> columns) => L($"{e}: another record already has this {Join(columns)}.", $"{e}: outro registro já tem este {Join(columns)}.");
        public string AskNew(string e) => L($"New {e}?", $"{e} novo?");
        public string ReturnNewId() => L("Return the new identifier", "Devolver o identificador novo");
        public string ReturnId() => L("Return the identifier", "Devolver o identificador");

        public string DeletePurpose(string e, bool owned, bool referenced, string? active) => L($"{(active != null ? $"Marks one {e} inactive ({active} False)" : $"Deletes one {e}")} after checking that it exists{(owned ? ", that the signed-in user owns it" : "")}{(referenced ? " and that no record still references it" : "")}, so a delete never breaks the data.",
            $"{(active != null ? $"Marca um {e} como inativo ({active} falso)" : $"Apaga um {e}")} depois de conferir que ele existe{(owned ? ", que o usuário logado é o dono" : "")}{(referenced ? " e que nenhum registro ainda o referencia" : "")}, para que apagar nunca quebre os dados.");
        public string DeleteComment() => L("Checks first (existence, owner, references), then the delete", "Primeiro as checagens (existência, dono, referências), depois a exclusão");
        public string ReadChild(string child, string attribute, string e) => L($"A {child} whose {attribute} still names this {e} (Delete Rule Protect).", $"Um {child} cujo {attribute} ainda aponta este {e} (Delete Rule Protect).");
        public string AskReferenced(string child) => L($"Still referenced by a {child}?", $"Ainda referenciado por um {child}?");
        public string Referenced(string e, string child) => L($"{e} is still referenced by {child} records.", $"{e} ainda é referenciado por registros de {child}.");
        public string MarkInactive() => L("Mark it inactive", "Marcar como inativo");

        public string ServicePurpose(string action, string purpose) => L($"Service entry of {action} for other modules and apps, with the same contract and checks: {purpose}",
            $"Entrada de serviço de {action} para outros módulos e apps, com o mesmo contrato e as mesmas checagens: {purpose}");
        public string ReturnOutputs(string action) => L($"Return what {action} returned", $"Devolver o que {action} devolveu");
    }
}
