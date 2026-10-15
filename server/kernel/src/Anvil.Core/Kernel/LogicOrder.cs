using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Ordem estavel por dependencias declaradas em call; componentes recursivos compartilham a fase de declaracao.</summary>
public static class LogicOrder
{
    public static string ActionType(JsonObject action) => (action["kind"]?.GetValue<string>() ?? "server").ToLowerInvariant() switch
    {
        "server" => "IServerAction", "service" => "IServiceAction", "client" => "IClientAction",
        "screen" => Owner(action).StartsWith("IMobile", StringComparison.Ordinal) ? "OutSystems.Model.UI.Mobile.IScreenAction" : "OutSystems.Model.UI.Web.IScreenAction",
        "preparation" => "IPreparation", "data" => "IDataAction",
        // An exposed REST method (op rest-expose): its flow is born with Start and End inside its IRestService.
        "rest" => RestServiceAction,
        // A consumed REST client's callback (OnBeforeRequest, OnAfterResponse): its parameters are the platform's own.
        "callback" => RestCallback,
        var kind => throw new InvalidOperationException($"logic: action {action["name"]}: kind '{kind}' desconhecido; permitidos: server, service, client, screen, preparation, data, rest, callback")
    };

    public static bool IsClient(JsonObject action) => string.Equals(action["kind"]?.ToString(), "client", StringComparison.OrdinalIgnoreCase) || !string.Equals(action["kind"]?.ToString(), "data", StringComparison.OrdinalIgnoreCase) && action["owner"]?.ToString().StartsWith("IMobile", StringComparison.Ordinal) == true;
    public static string Owner(JsonObject action)
    {
        var owner = action["owner"]?.GetValue<string>(); var kind = action["kind"]?.ToString().ToLowerInvariant();
        if (kind == "rest")
        {
            if (owner == null || !System.Text.RegularExpressions.Regex.IsMatch(owner, "^IRestService:[A-Za-z_][A-Za-z0-9_]*$"))
                throw new ArgumentException("A rest action (exposed REST method) names its owner: \"owner\": \"IRestService:<Service>\"");
            if (action.ContainsKey("public") || action.ContainsKey("function")) throw new ArgumentException("Exposed REST methods do not declare public/function");
            return owner;
        }
        if (kind == "callback")
        {
            if (owner == null || !System.Text.RegularExpressions.Regex.IsMatch(owner, "^IRestClient:[A-Za-z_][A-Za-z0-9_]*$"))
                throw new ArgumentException("A callback action names its consumed REST client: \"owner\": \"IRestClient:<Client>\"");
            if (action["name"]?.ToString() is not ("OnBeforeRequest" or "OnAfterResponse"))
                throw new ArgumentException($"A callback action is OnBeforeRequest or OnAfterResponse, not '{action["name"]}'");
            if (action.ContainsKey("public") || action.ContainsKey("function") || action.ContainsKey("inputs") || action.ContainsKey("outputs"))
                throw new ArgumentException("A callback action declares no public, function, inputs or outputs: its parameters are the platform's (Request, CustomizedRequest; Request, Response, CustomizedResponse)");
            return owner;
        }
        if (action.ContainsKey("http") || action.ContainsKey("path"))
            throw new ArgumentException($"logic: action {action["name"]}: http/path exist only on kind rest (an exposed REST method)");
        if (kind is not ("screen" or "preparation" or "data"))
        {
            if (owner != null) throw new ArgumentException("Only screen/data actions and preparations declare an owner");
            return "@espace";
        }
        var allowed = kind == "data" ? "IMobileScreen|IMobileBlock" : kind == "screen" ? "IMobileScreen|IMobileBlock|IWebScreen|IWebBlock" : "IWebScreen|IWebBlock|IWebEmail";
        if (owner == null || !System.Text.RegularExpressions.Regex.IsMatch(owner, "^(?:" + allowed + "):[A-Za-z][A-Za-z0-9_]*$"))
            throw new ArgumentException("Action owner must name an existing screen/block/email of the appropriate kind");
        if (action.ContainsKey("public") || action.ContainsKey("function")) throw new ArgumentException("Screen actions and preparations do not declare public/function");
        if (kind == "preparation" && action["name"]?.ToString() != "Preparation") throw new ArgumentException("Preparation name is fixed by Studio: Preparation");
        return owner;
    }

    public static bool Compatible(string type, JsonObject action) => type.Length == 0 || type == "IActionSignature"
        || type == ActionType(action) || type == ActionType(action) + "Signature";

    internal const string MobileScreenAction = "OutSystems.Model.UI.Mobile.IScreenAction";
    internal const string RestServiceAction = "IRestServiceAction";
    internal const string RestCallback = "IRestCallbackActionFlow";
    public static bool IsCallback(JsonObject action) => string.Equals(action["kind"]?.ToString(), "callback", StringComparison.OrdinalIgnoreCase);
    /// <summary>A parameter of a REST callback (O11 IRestCallbackActionFlowInput/Output, ODC their Signature types).</summary>
    public static bool IsCallbackParameter(object o) => o.GetType().GetInterfaces().Any(i => i.Name.StartsWith("IRestCallbackActionFlowInput", StringComparison.Ordinal) || i.Name.StartsWith("IRestCallbackActionFlowOutput", StringComparison.Ordinal));
    public static bool IsRest(JsonObject action) => string.Equals(action["kind"]?.ToString(), "rest", StringComparison.OrdinalIgnoreCase);
    internal const string WebScreenAction = "OutSystems.Model.UI.Web.IScreenAction";

    /// <summary>A declared action is identified by (owner, name): the same screen action name on two screens is two actions
    /// (I5 of the atritos 2 package). The key is "owner/name", the same text a call writes for a scoped action.</summary>
    internal static JsonObject? DeclaredTarget(string reference, IReadOnlyDictionary<string, JsonObject> actions)
    {
        var slash = reference.IndexOf('/');
        if (slash >= 0)
            return !reference.StartsWith(Module + "/", StringComparison.OrdinalIgnoreCase) && actions.TryGetValue(reference, out var scoped) ? scoped : null;
        var parts = reference.Split(':', 2);
        var name = parts[^1]; var type = parts.Length == 2 ? parts[0] : "";
        // A module action first (its name is unique in the module), then an owned action in declaration order.
        if (actions.TryGetValue(Module + "/" + name, out var global) && SafeCompatible(type, global)) return global;
        return actions.Values.FirstOrDefault(a => !string.Equals(SafeOwner(a), Module, StringComparison.Ordinal)
            && string.Equals(NameOf(a), name, StringComparison.OrdinalIgnoreCase) && SafeCompatible(type, a));
    }

    private const string Module = "@espace";

    /// <summary>The declared name, or null when it is missing or not text (a malformed action LogicExpander reports).</summary>
    internal static string? NameOf(JsonObject action) => action["name"] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    /// <summary>Owner(action) of a well-formed action; a malformed one keys under its raw owner text, so ordering never throws.</summary>
    internal static string SafeOwner(JsonObject action)
    {
        try { return Owner(action); }
        catch (Exception) { return "?" + (action["owner"] is JsonValue o && o.TryGetValue<string>(out var text) ? text : ""); }
    }

    /// <summary>"owner/name" (case-insensitive); an action without a name keys by its position.</summary>
    internal static string Key(JsonObject action, int ordinal) => SafeOwner(action) + "/" + (NameOf(action) ?? "#" + ordinal);

    private static bool SafeCompatible(string type, JsonObject action)
    {
        try { return Compatible(type, action); }
        catch (Exception) { return false; }
    }

    internal static LogicCallCandidate[] CallCandidates(string target, JsonObject caller)
    {
        if (target.Contains(':') || target.StartsWith('@') || target.StartsWith('$')) return [new(target)];
        var owner = Owner(caller);
        var global = new[] { "IServerAction:" + target, "IServiceAction:" + target, "IClientAction:" + target,
            "IServerActionSignature:" + target, "IEntityActionSignature:" + target, "IActionSignature:" + target,
            "IExtensionActionSignature:" + target };
        return [.. (ActionType(caller) is MobileScreenAction or WebScreenAction
                ? new[] { new LogicCallCandidate(owner + "/" + target, IsImplicitLocal: true) } : Array.Empty<LogicCallCandidate>()),
            .. (IsClient(caller) ? new[] { "IClientAction:" + target, "IClientActionSignature:" + target } : Array.Empty<string>())
                .Concat(global).Select(reference => new LogicCallCandidate(reference))];
    }

    internal static LogicCallTarget DeclaredCall(JsonObject action)
    {
        var kind = ActionType(action); var owner = Owner(action); var name = action["name"]!.GetValue<string>();
        if (kind is "IDataAction" or "IPreparation") throw new InvalidOperationException("logic: 'call' cannot invoke a data action or preparation: " + name);
        if (kind == RestServiceAction) throw new InvalidOperationException("logic: 'call' cannot invoke an exposed REST method (it answers HTTP requests): " + name);
        if (kind == RestCallback) throw new InvalidOperationException("logic: 'call' cannot invoke a REST callback (the platform runs it around each request): " + name);
        return new(owner == "@espace" ? kind + ":" + name : owner + "/" + name, kind, owner == "@espace" ? null : owner);
    }

    internal static void ValidateCall(JsonObject caller, LogicCallTarget target)
    {
        if (target.Kind == WebScreenAction)
            throw new InvalidOperationException("logic: Traditional screen actions are event destinations, not callable IActionSignature targets; call a server action from the Traditional screen handler");
        var screen = target.Kind is MobileScreenAction or WebScreenAction;
        if (screen && !string.Equals(Owner(caller), target.Owner, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("logic: screen action '" + target.Reference + "' can only be called from its own screen/block owner");
        if ((target.Kind is "IClientAction" or "IClientActionSignature" or MobileScreenAction) && !IsClient(caller))
            throw new InvalidOperationException("logic: client action '" + target.Reference + "' cannot be called by a server/service, data action or Traditional owner");
        if (target.Kind is "IDataAction" or "IPreparation")
            throw new InvalidOperationException("logic: 'call' cannot invoke a data action or preparation: " + target.Reference);
    }
    /// <summary>The first declaration of each (owner, name), keyed "owner/name" (case-insensitive), in declaration order.
    /// Never throws: a repeated key keeps its first declaration (LogicExpander reports the repetition), an action without a
    /// name keys by its position, an entry that is not an object is skipped (LogicExpander reports it).</summary>
    internal static Dictionary<string, JsonObject> Index(JsonArray actions)
    {
        var byKey = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < actions.Count; i++)
            if (actions[i] is JsonObject action) byKey.TryAdd(Key(action, i), action);
        return byKey;
    }

    /// <summary>Every declared action once, in dependency order (I5). Never throws: the same name on different owners is two
    /// actions; a real repetition (same owner and name) comes right after its first declaration; a malformed action keeps its
    /// place and LogicExpander.Expand reports it as a coded problem.</summary>
    public static IReadOnlyList<JsonObject> Sort(JsonArray actions) => Sort(actions, null);

    internal static IReadOnlyList<JsonObject> Sort(JsonArray actions, Func<JsonObject, string, JsonObject?>? bindDeclared)
    {
        var repeats = new Dictionary<string, List<JsonObject>>(StringComparer.OrdinalIgnoreCase);
        var first = Index(actions);
        for (var i = 0; i < actions.Count; i++)
            if (actions[i] is JsonObject action && first.TryGetValue(Key(action, i), out var kept) && !ReferenceEquals(kept, action))
                (repeats.TryGetValue(Key(action, i), out var list) ? list : repeats[Key(action, i)] = []).Add(action);
        var keyOf = KeysOf(first);
        var ordered = new List<JsonObject>();
        foreach (var action in Groups(actions, bindDeclared).SelectMany(group => group))
        {
            ordered.Add(action);
            if (repeats.TryGetValue(keyOf[action], out var again)) ordered.AddRange(again);
        }
        return ordered;
    }

    private static Dictionary<JsonObject, string> KeysOf(Dictionary<string, JsonObject> byKey)
    {
        var keys = new Dictionary<JsonObject, string>(ReferenceEqualityComparer.Instance);
        foreach (var (key, action) in byKey) keys[action] = key;
        return keys;
    }

    // Tarjan emits dependency components in the same postorder as the previous DAG traversal.
    // Only declared, bound actions enter a component; external signatures still require resolution.
    internal static IReadOnlyList<IReadOnlyList<JsonObject>> Groups(JsonArray actions,
        Func<JsonObject, string, JsonObject?>? bindDeclared = null)
    {
        var byKey = Index(actions);
        var keyOf = KeysOf(byKey);
        var declarationOrder = byKey.Keys.Select((key, ordinal) => (key, ordinal))
            .ToDictionary(pair => pair.key, pair => pair.ordinal, StringComparer.OrdinalIgnoreCase);
        var indices = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var low = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var active = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stack = new Stack<string>();
        var result = new List<IReadOnlyList<JsonObject>>();
        void Visit(string key)
        {
            indices[key] = low[key] = indices.Count;
            stack.Push(key); active.Add(key);
            var action = byKey[key];
            foreach (var call in Calls(action["steps"] as JsonArray).Concat((action["handlers"] as JsonArray)?.OfType<JsonObject>().SelectMany(h => Calls(h["steps"] as JsonArray)) ?? []))
            {
                JsonObject? callee;
                // Binding a call can fail (a call the compiler refuses): ordering skips the edge, the compiler reports the step.
                try { callee = bindDeclared == null ? DeclaredTarget(call, byKey) : bindDeclared(action, call); }
                catch (Exception) { callee = null; }
                if (callee == null || !keyOf.TryGetValue(callee, out var next)) continue;
                if (!indices.ContainsKey(next)) { Visit(next); low[key] = Math.Min(low[key], low[next]); }
                else if (active.Contains(next)) low[key] = Math.Min(low[key], indices[next]);
            }
            if (low[key] != indices[key]) return;
            var members = new List<string>();
            string member;
            do { member = stack.Pop(); active.Remove(member); members.Add(member); } while (!string.Equals(member, key, StringComparison.OrdinalIgnoreCase));
            result.Add(members.OrderBy(memberKey => declarationOrder[memberKey]).Select(memberKey => byKey[memberKey]).ToArray());
        }
        foreach (var key in byKey.Keys) if (!indices.ContainsKey(key)) Visit(key);
        return result;
    }

    private static IEnumerable<string> Calls(JsonArray? steps)
    {
        foreach (var step in steps?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>())
        {
            if (step["call"] is JsonValue call && call.TryGetValue<string>(out var target)) yield return target;
            foreach (var branch in (step["switch"] as JsonArray)?.OfType<JsonObject>() ?? []) foreach (var nested in Calls(branch["steps"] as JsonArray)) yield return nested;
            foreach (var key in new[] { "then", "else", "do", "next", "otherwise" })
                foreach (var nested in Calls(step[key] as JsonArray)) yield return nested;
        }
    }
}
