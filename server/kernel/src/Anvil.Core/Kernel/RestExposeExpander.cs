using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// Op `rest-expose` (exposed REST, both lanes, headless): one IRestService and the methods it names. Each method is a
/// logic action of kind `rest` (LogicExpander: owner IRestService:&lt;S&gt;, http, path, parameters with `in`), so its body is
/// the logic language; `action` + `arguments` + `results` is sugar for a call step and an assign step (Start, End, links
/// and layout are generated). A re-declared method is replaced (an exposed method has no in-module consumer; its callers
/// are external and see only the HTTP contract, which the facade protects with REST_EXPOSE_CONTRACT_WORDS). `remove`
/// deletes the methods it lists. Closed keys and every problem of the data before any op (<see cref="Validate"/>, pure);
/// the action, its parameters and the path conflicts with existing methods are checked on the module by the handler.
///
/// {"op":"rest-expose","data":{"service":{"name":"CepService"},
///   "methods":[{"name":"GetCep","http":"GET","path":"/cep/{Cep}","inputs":[{"name":"Cep","type":"Text","in":"url"}],
///               "outputs":[{"name":"Info","type":"CepInfo"}],"action":"IServerAction:CepInfo_Get",
///               "arguments":{"Cep":"Cep"},"results":{"Info":"CepInfo_Get.Info"}}]}}
/// </summary>
public static class RestExposeExpander
{
    public static readonly string[] RootKeys = ["service", "methods", "remove", "breaks"];
    public static readonly string[] ServiceKeys = ["name", "description", "authentication", "httpSecurity", "internalAccess", "documentation"];
    public static readonly string[] MethodKeys = ["name", "http", "path", "description", "inputs", "outputs", "vars", "action", "arguments", "results", "steps"];
    public static readonly string[] InputKeys = ["name", "type", "in", "mandatory", "description"];
    public static readonly string[] OutputKeys = ["name", "type", "in", "description"];
    private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);
    private static readonly Regex Placeholder = new(@"\{([^{}]*)\}", RegexOptions.Compiled);

    public static JsonObject Schema() => new()
    {
        ["op"] = "rest-expose",
        ["data"] = Array(RootKeys),
        ["shapes"] = new JsonObject { ["service"] = Array(ServiceKeys), ["method"] = Array(MethodKeys), ["input"] = Array(InputKeys), ["output"] = Array(OutputKeys) },
        ["http"] = Array(RestExpander.Verbs),
        ["inputIn"] = new JsonArray("url", "header", "body"),
        ["outputIn"] = new JsonArray("body", "header"),
        ["authentication"] = new JsonArray("None"),
        ["rules"] = "One IRestService and the methods it names; a method is a logic action of kind rest (api --op logic): steps, or action+arguments+results "
            + "(a call to the action and an assign of the outputs; arguments default to the method inputs of the same name, results to the action outputs of the same name). "
            + "path starts with '/'; every {X} is an input in:url (an in:url input outside the path is a query parameter); one input in:body at most, none on GET; "
            + "one output in:body at most; two methods never share http and path. Changing http, path or the name of an existing method, or removing it, changes its "
            + "public contract: the user's words name it (REST_EXPOSE_CONTRACT_WORDS). Authentication Basic/Custom needs the OnAuthentication flow: not supported here.",
        ["codes"] = Array(["REST_EXPOSE_UNKNOWN_KEYS", "REST_EXPOSE_KEY_INVALID", "REST_EXPOSE_URLPATH_INVALID", "REST_EXPOSE_PATH_PARAM_WITHOUT_URL_INPUT", "REST_EXPOSE_BODY_INPUTS",
            "REST_EXPOSE_BODY_ON_GET", "REST_EXPOSE_BODY_OUTPUTS", "REST_EXPOSE_PATH_CONFLICT", "REST_EXPOSE_ACTION_NOT_FOUND", "REST_EXPOSE_ARGUMENT_UNMAPPED",
            "REST_EXPOSE_TYPE_MISMATCH", "REST_EXPOSE_AUTH_FLOW_UNSUPPORTED", "REST_EXPOSE_BODY_REQUIRED"]),
    };

    private static JsonArray Array(IEnumerable<string> keys) => new(keys.Select(k => (JsonNode)k).ToArray());

    /// <summary>Every problem the data alone shows (keys, names, verbs, paths, bodies, conflicts between declared methods).</summary>
    public static List<IntegrationProblem> Validate(JsonObject data)
    {
        var problems = new List<IntegrationProblem>();
        Closed(data, RootKeys, "/data", "data", problems);
        if (data["service"] is not JsonObject service)
            problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/service", "rest-expose: service {name} is required", "\"service\": {\"name\": \"<Service>\"}"));
        else
        {
            Closed(service, ServiceKeys, "/data/service", "service", problems);
            Name(service, "/data/service", "service", problems);
            var authentication = service["authentication"]?.ToString() ?? "None";
            if (authentication != "None")
                problems.Add(new("REST_EXPOSE_AUTH_FLOW_UNSUPPORTED", "/data/service/authentication", $"rest-expose: authentication {authentication} needs the service's OnAuthentication flow, which this op does not write",
                    "keep \"authentication\": \"None\" and check the caller inside each method (a header input compared with a site property), or write the OnAuthentication flow in the Studio"));
            if (service["httpSecurity"] is { } security && security.ToString() is not ("SSL" or "None"))
                problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/service/httpSecurity", $"rest-expose: httpSecurity '{security}' is not SSL or None", "\"httpSecurity\": \"SSL\""));
            foreach (var flag in new[] { "internalAccess", "documentation" })
                if (service[flag] is { } value && !(value is JsonValue v && v.TryGetValue<bool>(out _)))
                    problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/service/" + flag, $"rest-expose: {flag} is true or false", $"\"{flag}\": true"));
        }
        var methods = data["methods"] is null ? [] : data["methods"] is JsonArray array && array.All(m => m is JsonObject) ? array.OfType<JsonObject>().ToList() : null;
        if (methods == null) { problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/methods", "rest-expose: methods is a list of objects", null)); methods = []; }
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var routes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var m = 0; m < methods.Count; m++)
        {
            var at = $"/data/methods/{m}";
            var method = methods[m];
            Closed(method, MethodKeys, at, "method", problems);
            var name = Name(method, at, "method", problems);
            if (name != null && !names.Add(name)) problems.Add(new("REST_EXPOSE_KEY_INVALID", at + "/name", $"rest-expose: method '{name}' is declared twice", "keep one declaration"));
            var http = (method["http"]?.ToString() ?? "GET").ToUpperInvariant();
            if (!RestExpander.Verbs.Contains(http)) problems.Add(new("REST_EXPOSE_KEY_INVALID", at + "/http", $"rest-expose: method '{name}' http '{method["http"]}' is not one of {string.Join(", ", RestExpander.Verbs)}", "\"http\": \"GET\""));
            var path = method["path"]?.ToString() ?? "/" + name;
            var placeholders = new List<string>();
            if (RestExpander.PathProblem(path) is { } why)
                problems.Add(new("REST_EXPOSE_URLPATH_INVALID", at + "/path", $"rest-expose: method '{name}' path '{path}': {why}", path.StartsWith('/') ? "balance the braces; each {Name} is one input in:url" : $"\"path\": \"/{path.TrimStart('/')}\""));
            else
            {
                placeholders = Placeholder.Matches(path).Select(x => x.Groups[1].Value).ToList();
                var route = http + " " + Route(path);
                if (routes.TryGetValue(route, out var other))
                    problems.Add(new("REST_EXPOSE_PATH_CONFLICT", at + "/path", $"rest-expose: methods '{other}' and '{name}' answer the same {http} {path} (the platform's UP_SwaggerPathConflit)", "give each method its own path or verb"));
                else routes[route] = name ?? "";
            }
            var inputs = Objects(method, "inputs", at, problems);
            var outputs = Objects(method, "outputs", at, problems);
            var bodyInputs = new List<string>();
            var inputNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < inputs.Count; i++)
            {
                var iat = $"{at}/inputs/{i}";
                Closed(inputs[i], InputKeys, iat, "input", problems);
                var input = Name(inputs[i], iat, "input", problems);
                if (input != null && !inputNames.Add(input)) problems.Add(new("REST_EXPOSE_KEY_INVALID", iat + "/name", $"rest-expose: input '{input}' of '{name}' is declared twice", "keep one declaration"));
                if (inputs[i]["type"] is not JsonValue) problems.Add(new("REST_EXPOSE_KEY_INVALID", iat + "/type", $"rest-expose: input '{input}' needs a type", "\"type\": \"Text\""));
                var place = (inputs[i]["in"]?.ToString() ?? "url").ToLowerInvariant();
                if (place is not ("url" or "header" or "body")) problems.Add(new("REST_EXPOSE_KEY_INVALID", iat + "/in", $"rest-expose: input '{input}' in '{place}' is not url, header or body", "\"in\": \"url\""));
                if (place == "body") bodyInputs.Add(iat);
            }
            foreach (var placeholder in placeholders)
                if (!inputs.Any(i => string.Equals(i["name"]?.ToString(), placeholder, StringComparison.Ordinal) && (i["in"]?.ToString() ?? "url").Equals("url", StringComparison.OrdinalIgnoreCase)))
                    problems.Add(new("REST_EXPOSE_PATH_PARAM_WITHOUT_URL_INPUT", at + "/path", $"rest-expose: path of '{name}' has {{{placeholder}}} and no input {placeholder} in:url", $"add {{\"name\": \"{placeholder}\", \"type\": \"Text\", \"in\": \"url\"}} to inputs (the name is case-sensitive)"));
            if (bodyInputs.Count > 1)
                problems.Add(new("REST_EXPOSE_BODY_INPUTS", at + "/inputs", $"rest-expose: method '{name}' receives {bodyInputs.Count} inputs in the body; a request has one body", "group them in one structure input in:body; the other values go in the URL or headers"));
            if (http == "GET" && bodyInputs.Count > 0)
                problems.Add(new("REST_EXPOSE_BODY_ON_GET", bodyInputs[0], $"rest-expose: method '{name}' is GET and receives a body", "receive it in the URL (\"in\": \"url\") or use POST"));
            var bodyOutputs = 0;
            var outputNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var o = 0; o < outputs.Count; o++)
            {
                var oat = $"{at}/outputs/{o}";
                Closed(outputs[o], OutputKeys, oat, "output", problems);
                var output = Name(outputs[o], oat, "output", problems);
                if (output != null && !outputNames.Add(output)) problems.Add(new("REST_EXPOSE_KEY_INVALID", oat + "/name", $"rest-expose: output '{output}' of '{name}' is declared twice", "keep one declaration"));
                if (outputs[o]["type"] is not JsonValue) problems.Add(new("REST_EXPOSE_KEY_INVALID", oat + "/type", $"rest-expose: output '{output}' needs a type", "\"type\": \"Text\""));
                var place = (outputs[o]["in"]?.ToString() ?? "body").ToLowerInvariant();
                if (place is not ("body" or "header")) problems.Add(new("REST_EXPOSE_KEY_INVALID", oat + "/in", $"rest-expose: output '{output}' in '{place}' is not body or header", "\"in\": \"header\""));
                if (place == "body") bodyOutputs++;
            }
            if (bodyOutputs > 1)
                problems.Add(new("REST_EXPOSE_BODY_OUTPUTS", at + "/outputs", $"rest-expose: method '{name}' sends {bodyOutputs} outputs in the body; a response has one body",
                    "declare a structure with those fields (op spec, structures) and one output of that type in:body; the others go in headers"));
            var hasAction = method.ContainsKey("action");
            if (hasAction && method.ContainsKey("steps"))
                problems.Add(new("REST_EXPOSE_KEY_INVALID", at, $"rest-expose: method '{name}' has both action and steps", "use action (+ arguments/results) for one call, or steps for a longer body"));
            if (!hasAction && (method.ContainsKey("arguments") || method.ContainsKey("results")))
                problems.Add(new("REST_EXPOSE_KEY_INVALID", at, $"rest-expose: method '{name}' has arguments/results without action", "\"action\": \"IServerAction:<Action>\""));
            if (!hasAction && !method.ContainsKey("steps") && outputs.Count > 0)
                problems.Add(new("REST_EXPOSE_BODY_REQUIRED", at, $"rest-expose: method '{name}' has outputs and no body to assign them", "\"action\": \"IServerAction:<Action>\" (outputs come from its outputs of the same name) or \"steps\""));
            foreach (var key in new[] { "arguments", "results" })
                if (method[key] is { } map && (map is not JsonObject mo || mo.Any(p => p.Value is not JsonValue pv || !pv.TryGetValue<string>(out _))))
                    problems.Add(new("REST_EXPOSE_KEY_INVALID", $"{at}/{key}", $"rest-expose: {key} is {{\"Name\": \"<expression>\"}}", null));
            if (method["results"] is JsonObject results)
                foreach (var target in results.Select(p => p.Key).Where(k => !outputNames.Contains(k.Split('.')[0])))
                    problems.Add(new("REST_EXPOSE_KEY_INVALID", $"{at}/results/{target}", $"rest-expose: results '{target}' is not an output of '{name}'", "results map the method's outputs: {\"<Output>\": \"<Action>.<ActionOutput>\"}"));
        }
        foreach (var key in new[] { "remove", "breaks" })
            if (data[key] is { } list && (list is not JsonArray a || a.Any(e => e is not JsonValue v || !v.TryGetValue<string>(out var t) || t.Trim().Length == 0)))
                problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/" + key, $"rest-expose: {key} is a list of names", key == "remove" ? "\"remove\": [\"<Method>\"]" : null));
        return problems;
    }

    /// <summary>The route key of a path: the placeholders' names do not distinguish routes (/a/{X} and /a/{Y} conflict).</summary>
    public static string Route(string path) => Placeholder.Replace(path.Split('?')[0].TrimEnd('/'), "{}").ToLowerInvariant();

    /// <summary>The action a method calls and its signature, read from the module by the handler.</summary>
    public sealed record ActionSignature(string Reference, string Name, IReadOnlyList<(string Name, string Type, bool Mandatory)> Inputs, IReadOnlyList<(string Name, string Type)> Outputs);

    /// <summary>The problems only the module answers: the action exists, its mandatory inputs are mapped, mapped values of
    /// the same name have the same type, and no existing method of the service (other than those the op replaces or
    /// removes) answers the same route.</summary>
    public static List<IntegrationProblem> CheckAgainstModule(JsonObject data, Func<string, ActionSignature?> action, IReadOnlyDictionary<string, string> existingRoutes)
    {
        var problems = new List<IntegrationProblem>();
        var methods = data["methods"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
        var removed = RestExpander.Strings(data["remove"]).Select(r => r.Split(':').Last()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var declared = methods.Select(m => m["name"]?.ToString() ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (var m = 0; m < methods.Count; m++)
        {
            var at = $"/data/methods/{m}";
            var method = methods[m];
            var name = method["name"]?.ToString() ?? "";
            var route = (method["http"]?.ToString() ?? "GET").ToUpperInvariant() + " " + Route(method["path"]?.ToString() ?? "/" + name);
            if (existingRoutes.TryGetValue(route, out var owner) && !declared.Contains(owner) && !removed.Contains(owner))
                problems.Add(new("REST_EXPOSE_PATH_CONFLICT", at + "/path", $"rest-expose: existing method '{owner}' already answers {route}", $"give '{name}' another path or verb, or remove '{owner}' in the same op (\"remove\": [\"{owner}\"])"));
            if (method["action"]?.ToString() is not { } reference) continue;
            var signature = action(reference);
            if (signature == null)
            {
                problems.Add(new("REST_EXPOSE_ACTION_NOT_FOUND", at + "/action", $"rest-expose: action '{reference}' of method '{name}' does not exist in the module or its references", "create it first (op logic) or reference it, then name it as IServerAction:<Action>"));
                continue;
            }
            var inputs = (method["inputs"]?.AsArray().OfType<JsonObject>() ?? []).ToDictionary(i => i["name"]!.ToString(), i => i["type"]?.ToString() ?? "", StringComparer.OrdinalIgnoreCase);
            var outputs = (method["outputs"]?.AsArray().OfType<JsonObject>() ?? []).ToDictionary(o => o["name"]!.ToString(), o => o["type"]?.ToString() ?? "", StringComparer.OrdinalIgnoreCase);
            var arguments = method["arguments"] as JsonObject;
            foreach (var key in arguments?.Select(p => p.Key) ?? [])
                if (!signature.Inputs.Any(i => i.Name.Equals(key, StringComparison.OrdinalIgnoreCase)))
                    problems.Add(new("REST_EXPOSE_KEY_INVALID", $"{at}/arguments/{key}", $"rest-expose: '{key}' is not an input of {signature.Name}", "use one of: " + string.Join(", ", signature.Inputs.Select(i => i.Name))));
            foreach (var input in signature.Inputs)
            {
                var mapped = arguments?[input.Name]?.ToString();
                if (mapped == null && inputs.ContainsKey(input.Name)) mapped = input.Name;
                if (mapped == null)
                {
                    if (input.Mandatory) problems.Add(new("REST_EXPOSE_ARGUMENT_UNMAPPED", at + "/arguments", $"rest-expose: mandatory input '{input.Name}' of {signature.Name} gets no value in method '{name}'",
                        $"\"arguments\": {{\"{input.Name}\": \"<expression>\"}}, or a method input named {input.Name}"));
                    continue;
                }
                if (inputs.TryGetValue(mapped.Trim(), out var given) && !SameType(given, input.Type))
                    problems.Add(new("REST_EXPOSE_TYPE_MISMATCH", at + "/arguments", $"rest-expose: method input '{mapped}' is {given} and {signature.Name}.{input.Name} is {input.Type}", $"declare the method input as {input.Type}, or convert it in arguments (e.g. TextToInteger({mapped}))"));
            }
            var results = method["results"] as JsonObject;
            foreach (var (output, type) in outputs)
            {
                var source = results?[output]?.ToString();
                var actionOutput = source == null ? signature.Outputs.FirstOrDefault(o => o.Name.Equals(output, StringComparison.OrdinalIgnoreCase)) : default;
                if (source == null && actionOutput.Name == null)
                {
                    problems.Add(new("REST_EXPOSE_ARGUMENT_UNMAPPED", at + "/results", $"rest-expose: output '{output}' of method '{name}' gets no value ({signature.Name} has no output of that name)",
                        $"\"results\": {{\"{output}\": \"{signature.Name}.<Output>\"}}"));
                    continue;
                }
                if (actionOutput.Name != null && !SameType(type, actionOutput.Type))
                    problems.Add(new("REST_EXPOSE_TYPE_MISMATCH", at + "/outputs", $"rest-expose: output '{output}' is {type} and {signature.Name}.{actionOutput.Name} is {actionOutput.Type}", $"declare the output as {actionOutput.Type}, or map it in results with a conversion"));
            }
        }
        return problems;
    }

    private static bool SameType(string a, string b) => string.Equals(a.Replace(" ", ""), b.Replace(" ", ""), StringComparison.OrdinalIgnoreCase);

    public sealed record Expansion(List<JsonObject> Ops, List<string> Created, List<string> Updated, List<string> Removed);

    /// <summary>The ops of a valid op: removes, the service (created when missing, its declared properties set), then one
    /// logic op with a rest action per method (replace:true when the method exists).</summary>
    public static Expansion Expand(JsonObject data, string? serviceKey, IReadOnlyDictionary<string, string> existingMethods, Func<string, ActionSignature?> action)
    {
        var ops = new List<JsonObject>(); var created = new List<string>(); var updated = new List<string>(); var removed = new List<string>();
        var service = data["service"]!.AsObject();
        var name = service["name"]!.ToString();
        var s = serviceKey != null ? "@" + serviceKey : "$restExpose." + name;
        var breaks = RestExpander.Strings(data["breaks"]).ToArray();
        foreach (var target in RestExpander.Strings(data["remove"]))
        {
            var method = target.Split(':').Last();
            var delete = RestExpander.Op("delete", ("target", existingMethods.TryGetValue(method, out var key) ? "@" + key : "IRestServiceAction:" + method));
            if (breaks.Length > 0) delete["breaks"] = new JsonArray(breaks.Select(b => (JsonNode)b).ToArray());
            ops.Add(delete); removed.Add("IRestServiceAction:" + method);
        }
        if (serviceKey == null)
        {
            ops.Add(RestExpander.Op("create", ("parent", "@espace"), ("type", "IRestService"), ("name", name), ("as", s)));
            created.Add("IRestService:" + name);
        }
        if (service["description"] is { } description) ops.Add(RestExpander.Set(s, "Description", description.ToString()));
        if (service["httpSecurity"] is { } security) ops.Add(RestExpander.Set(s, "HttpSecurity", security.ToString()));
        if (service["internalAccess"] is JsonValue ia && ia.TryGetValue<bool>(out var internalAccess)) ops.Add(RestExpander.Set(s, "InternalAccess", internalAccess ? "Yes" : "No"));
        if (service["documentation"] is JsonValue sd && sd.TryGetValue<bool>(out var documentation)) ops.Add(RestExpander.Set(s, "ShowDocumentation", documentation ? "Yes" : "No"));
        var actions = new JsonArray();
        foreach (var method in data["methods"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var methodName = method["name"]!.ToString();
            var exists = existingMethods.ContainsKey(methodName);
            (exists ? updated : created).Add("IRestServiceAction:" + methodName);
            var declaration = new JsonObject { ["name"] = methodName, ["kind"] = "rest", ["owner"] = "IRestService:" + name,
                ["http"] = (method["http"]?.ToString() ?? "GET").ToUpperInvariant(), ["path"] = method["path"]?.ToString() ?? "/" + methodName };
            if (exists) declaration["replace"] = true;
            if (method["description"] is { } md) declaration["description"] = md.DeepClone();
            foreach (var section in new[] { "inputs", "outputs", "vars" })
                if (method[section] is JsonArray list) declaration[section] = list.DeepClone();
            declaration["steps"] = method["steps"]?.DeepClone() ?? Steps(method, action);
            actions.Add(declaration);
        }
        if (actions.Count > 0) ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = actions } });
        return new(ops, created, updated, removed);
    }

    /// <summary>action + arguments + results as steps: one call (named after the action) and one assign of the outputs.</summary>
    private static JsonArray Steps(JsonObject method, Func<string, ActionSignature?> action)
    {
        if (method["action"]?.ToString() is not { } reference) return new JsonArray();
        var signature = action(reference);
        var callName = signature?.Name ?? reference.Split(':').Last();
        var args = new JsonObject();
        var inputs = (method["inputs"]?.AsArray().OfType<JsonObject>() ?? []).Select(i => i["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var input in signature?.Inputs ?? [])
        {
            var mapped = method["arguments"]?[input.Name]?.ToString() ?? (inputs.Contains(input.Name) ? input.Name : null);
            if (mapped != null) args[input.Name] = mapped;
        }
        var call = new JsonObject { ["call"] = signature?.Reference ?? reference, ["as"] = callName };
        if (args.Count > 0) call["args"] = args;
        var steps = new JsonArray(call);
        var assign = new JsonObject();
        foreach (var output in (method["outputs"]?.AsArray().OfType<JsonObject>() ?? []).Select(o => o["name"]!.ToString()))
        {
            var source = method["results"]?[output]?.ToString()
                ?? (signature?.Outputs.FirstOrDefault(o => o.Name.Equals(output, StringComparison.OrdinalIgnoreCase)) is { Name: { } actionOutput } ? callName + "." + actionOutput : null);
            if (source != null) assign[output] = source;
        }
        foreach (var (target, value) in method["results"] as JsonObject ?? new JsonObject())
            if (!assign.ContainsKey(target)) assign[target] = value!.DeepClone();
        if (assign.Count > 0) steps.Add(new JsonObject { ["assign"] = assign, ["as"] = "SetResults" });
        return steps;
    }

    private static void Closed(JsonObject o, string[] allowed, string at, string what, List<IntegrationProblem> problems)
    {
        foreach (var key in o.Select(p => p.Key).Where(k => !allowed.Contains(k, StringComparer.Ordinal) && !k.StartsWith('_')))
            problems.Add(new("REST_EXPOSE_UNKNOWN_KEYS", at + "/" + key, $"rest-expose: {what} has unknown key '{key}'", "use only: " + string.Join(", ", allowed)));
    }

    private static string? Name(JsonObject o, string at, string what, List<IntegrationProblem> problems)
    {
        var name = o["name"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        if (name != null && Identifier.IsMatch(name)) return name;
        problems.Add(new("REST_EXPOSE_KEY_INVALID", at + "/name", $"rest-expose: {what} name '{name}' is not an OutSystems name", $"\"name\": \"{Regex.Replace(name ?? what, "[^A-Za-z0-9_]", "")}\""));
        return null;
    }

    private static List<JsonObject> Objects(JsonObject owner, string key, string at, List<IntegrationProblem> problems)
    {
        if (owner[key] is null) return [];
        if (owner[key] is not JsonArray array || array.Any(e => e is not JsonObject)) { problems.Add(new("REST_EXPOSE_KEY_INVALID", $"{at}/{key}", $"rest-expose: {key} is a list of objects", null)); return []; }
        return array.OfType<JsonObject>().ToList();
    }
}
