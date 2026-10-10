using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>An input, output or local variable as a logic action declares it (or as the base has it).</summary>
public sealed record ParamFact(string Name, string? Type, bool Mandatory, int Index = -1);

/// <summary>A logic action of the job: where it is (op, index), its owner, its kind and its declared parameters.</summary>
public sealed record ActionFact(int Op, int Index, JsonObject Declaration, string Name, string Kind, string Owner,
    IReadOnlyList<ParamFact> Inputs, IReadOnlyList<ParamFact> Outputs, IReadOnlyList<ParamFact> Vars, bool Function)
{
    public bool IsScreen => Kind == "screen";
    public bool IsClientSide => Kind is "client" or "screen";
    public bool IsServerSide => Kind is "server" or "service";
    public IEnumerable<ParamFact> Locals => Inputs.Concat(Outputs).Concat(Vars);
}

/// <summary>A callee as a `call` reads it: its reference, its inputs (name, type, mandatory) and its outputs.</summary>
public sealed record CalleeFact(string Reference, IReadOnlyList<ParamFact> Inputs, IReadOnlyList<ParamFact> Outputs);

/// <summary>
/// What only the base module can answer, for the rules that run in JobRunner.CheckAgainstBase (C20): the attributes of an
/// entity or structure, the signature of a callee, whether a name exists, whether a name is a function of the module or of
/// its references, and the module type. Null or false always means "unknown": no rule refuses on an unknown.
/// </summary>
public interface IBaseFacts
{
    IReadOnlyDictionary<string, string>? Attributes(string record);
    bool IsClientEntity(string name);
    CalleeFact? Callee(string target, JsonObject caller);
    bool HasName(string name);
    /// <summary>Every element of the module with this name is an entity or a structure (a type, never a value).</summary>
    bool NamesOnlyTypes(string name);
    bool IsFunction(string name);
    string? ModuleType { get; }
    /// <summary>The expression a raw `set` writes on an element of the base: null when the target does not resolve or the
    /// property holds no expression; with the aggregate the element belongs to, when it is inside one.</summary>
    RawExpressionFact? RawExpression(string target, string prop);
}

/// <summary>Where a raw expression lives: the aggregate (its name, sources, columns, client side), or no aggregate.</summary>
public sealed record RawExpressionFact(string? Aggregate, IReadOnlyList<string> Sources, IReadOnlyList<string> Columns, bool Client);

/// <summary>
/// What the job itself declares, read once from its ops (pure): the logic actions with their parameters, the entities,
/// static entities and structures of its specs with their attributes, and every name it writes as a declaration.
/// </summary>
public sealed class JobFacts
{
    public List<ActionFact> Actions { get; } = [];
    /// <summary>Entity, static entity and structure name -> attribute name -> type (case-insensitive).</summary>
    public Dictionary<string, Dictionary<string, string>> Records { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> ClientEntities { get; } = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Every name the job declares: actions, parameters, created elements, spec types and attributes, renames.</summary>
    public HashSet<string> Names { get; } = new(StringComparer.OrdinalIgnoreCase);

    public static JobFacts From(JsonArray ops)
    {
        var facts = new JobFacts();
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var kind = op["op"]?.ToString();
            if (op["name"] is JsonValue n && n.TryGetValue<string>(out var created)) facts.Names.Add(created);
            if (kind == "logic" && op["data"]?["actions"] is JsonArray actions)
                for (var a = 0; a < actions.Count; a++)
                    if (actions[a] is JsonObject action && action["name"] is JsonValue an && an.TryGetValue<string>(out var name))
                    {
                        var fact = new ActionFact(i, a, action, name, (action["kind"]?.ToString() ?? "server").ToLowerInvariant(), Owner(action),
                            Params(action, "inputs", true), Params(action, "outputs", false), Params(action, "vars", false),
                            action["function"] is JsonValue fv && fv.TryGetValue<bool>(out var function) && function);
                        facts.Actions.Add(fact);
                        facts.Names.Add(name);
                        foreach (var p in fact.Locals) facts.Names.Add(p.Name);
                    }
            if (kind == "spec" && op["data"] is JsonObject data)
                foreach (var section in new[] { "entities", "clientEntities", "static", "structures" })
                    foreach (var record in (data[section] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    {
                        if (record["name"] is not JsonValue rn || !rn.TryGetValue<string>(out var recordName)) continue;
                        facts.Names.Add(recordName);
                        if (section == "clientEntities") facts.ClientEntities.Add(recordName);
                        var attributes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        // The attributes the spec writes by convention (SpecExpander): the Id of an entity, Id/Label/Order of a static.
                        if (section is "entities" or "clientEntities" && !(record["id"] is JsonValue hasId && hasId.TryGetValue<bool>(out var withId) && !withId))
                            attributes["Id"] = recordName + " Identifier";
                        if (section == "static") { attributes["Id"] = recordName + " Identifier"; attributes["Label"] = "Text"; attributes["Order"] = "Integer"; }
                        foreach (var attribute in (record["attributes"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                            if (attribute["name"] is JsonValue atn && atn.TryGetValue<string>(out var attributeName))
                            {
                                attributes[attributeName] = attribute["type"]?.ToString() ?? "Text";
                                facts.Names.Add(attributeName);
                            }
                        facts.Records[recordName] = attributes;
                        foreach (var r in (record["records"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                            if (r["name"] is JsonValue rv && rv.TryGetValue<string>(out var recordValue)) facts.Names.Add(recordValue);
                    }
        }
        return facts;
    }

    /// <summary>The owner a declaration names (LogicOrder.Owner), or what it wrote when the declaration is malformed (the
    /// expansion reports that): actions are keyed by (owner, name), I5.</summary>
    public static string Owner(JsonObject action)
    {
        try { return LogicOrder.Owner(action); }
        catch { return action["owner"]?.ToString() ?? "@espace"; }
    }

    private static IReadOnlyList<ParamFact> Params(JsonObject action, string section, bool inputs)
        => (action[section] as JsonArray ?? new JsonArray()).Select((p, index) => (p as JsonObject, index))
            .Where(x => x.Item1?["name"] is JsonValue)
            .Select(x => new ParamFact(x.Item1!["name"]!.ToString(), x.Item1["type"]?.ToString(),
                inputs && !(x.Item1["mandatory"] is JsonValue m && m.TryGetValue<bool>(out var mandatory) && !mandatory), x.index)).ToArray();

    /// <summary>The job's callee for a `call` target of <paramref name="caller"/>, by the order LogicOrder.CallCandidates
    /// gives (a screen action of the caller's owner, then client actions for a client caller, then module actions).</summary>
    public ActionFact? Callee(string target, ActionFact caller)
    {
        if (target.StartsWith('@') || target.StartsWith('$')) return null;
        var colon = target.IndexOf(':');
        if (colon >= 0)
        {
            var type = KindNames.Normalize(target[..colon]); var name = target[(colon + 1)..];
            if (name.Contains('/')) return null;
            var matches = Actions.Where(a => a.Owner == "@espace" && string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase)
                && (type.Length == 0 || type is "IActionSignature" || ActionTypeOf(a) == type || ActionTypeOf(a) + "Signature" == type)).ToArray();
            return matches.Length == 1 ? matches[0] : null;
        }
        if (caller.IsScreen && Actions.FirstOrDefault(a => a.IsScreen && string.Equals(a.Owner, caller.Owner, StringComparison.OrdinalIgnoreCase)
            && string.Equals(a.Name, target, StringComparison.OrdinalIgnoreCase)) is { } local) return local;
        var module = Actions.Where(a => a.Owner == "@espace" && string.Equals(a.Name, target, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (caller.IsClientSide && module.FirstOrDefault(a => a.Kind == "client") is { } client) return client;
        var server = module.Where(a => a.Kind is "server" or "service").ToArray();
        return server.Length == 1 ? server[0] : module.Length == 1 ? module[0] : null;
    }

    private static string ActionTypeOf(ActionFact a) => a.Kind switch { "client" => "IClientAction", "service" => "IServiceAction", _ => "IServerAction" };
}
