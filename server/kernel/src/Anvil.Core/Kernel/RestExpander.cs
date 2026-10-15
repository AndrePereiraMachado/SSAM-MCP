using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// Op `rest` (consumed REST, both lanes, headless): a declarative description of one REST client that expands only into
/// the raw verbs the suites already prove (tests/jobs/rest-consume-get|post|call, rest-query-nested). The op names what it
/// changes: a missing element is created, an existing one is updated in place by key (callers stay bound), what it does not
/// name is untouched, `remove` deletes what it lists (`breaks` names the consumers that may break). Closed keys and every
/// problem of the op before any raw op is applied (<see cref="Validate"/>, pure; the model checks run in the handler before
/// its first op). Same data and same module, same ops (SameSpecSameOps).
///
/// {"op":"rest","data":{
///   "client":{"name":"ViaCepApi","baseUrl":"https://viacep.com.br","headers":{"Accept":"\"application/json\""}},
///   "structures":[{"name":"Address","attributes":[{"name":"Cep","type":"Text","json":"cep"}]}],
///   "methods":[{"name":"GetAddress","http":"GET","path":"/ws/{CEP}/json/","inputs":[{"name":"CEP","type":"Text","in":"url"}],
///               "response":{"structure":"Address"}}],
///   "remove":["OldMethod","IRestStructure:OldShape"], "breaks":["ServerAction:Cep_Lookup/ExecuteServerAction:OldMethod"]}}
/// </summary>
public static class RestExpander
{
    public static readonly string[] RootKeys = ["client", "methods", "structures", "openapi", "remove", "breaks"];
    public static readonly string[] ClientKeys = ["name", "baseUrl", "description", "auth", "headers", "dateFormat"];
    public static readonly string[] AuthKeys = ["type"];
    public static readonly string[] MethodKeys = ["name", "http", "path", "description", "timeout", "inputs", "request", "response", "outputs"];
    public static readonly string[] InputKeys = ["name", "type", "in", "mandatory", "originalName", "description"];
    public static readonly string[] OutputKeys = ["name", "type", "in", "originalName", "description"];
    public static readonly string[] BodyKeys = ["structure", "sample", "type", "format"];
    public static readonly string[] StructureKeys = ["name", "description", "attributes"];
    public static readonly string[] AttributeKeys = ["name", "type", "json", "mandatory", "description"];
    public static readonly string[] OpenApiKeys = ["path", "sha256", "source", "operations", "external"];
    public static readonly string[] Verbs = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    private static readonly string[] Primitive = ["Text", "Integer", "Long Integer", "LongInteger", "Decimal", "Boolean", "Date", "Date Time", "DateTime", "Time", "Currency", "Email", "Phone Number", "PhoneNumber"];
    private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);
    private static readonly Regex BaseUrl = new(@"^https?://[^?#\s]+$", RegexOptions.Compiled);
    private static readonly Regex Placeholder = new(@"\{([^{}]*)\}", RegexOptions.Compiled);

    public static JsonObject Schema() => new()
    {
        ["op"] = "rest",
        ["data"] = Array(RootKeys),
        ["shapes"] = new JsonObject
        {
            ["client"] = Array(ClientKeys), ["auth"] = Array(AuthKeys), ["method"] = Array(MethodKeys), ["input"] = Array(InputKeys),
            ["output"] = Array(OutputKeys), ["body"] = Array(BodyKeys), ["structure"] = Array(StructureKeys), ["attribute"] = Array(AttributeKeys),
            ["openapi"] = Array(OpenApiKeys),
        },
        ["http"] = Array(Verbs),
        ["inputIn"] = new JsonArray("url", "query", "header", "body"),
        ["outputIn"] = new JsonArray("body", "header"),
        ["authTypes"] = new JsonArray("None"),
        ["rules"] = "Declarative over what it names: missing elements are created, existing ones updated in place by key, what it does not name is untouched; "
            + "remove deletes the methods/structures it lists (IRestAction:Name, IRestStructure:Name or a method name), breaks names their consumers exactly. "
            + "path starts with '/'; every {X} needs an input in:url; query inputs are appended as ?a={a} (UrlPlacement, DontSend); one Body at most each way "
            + "(request/response or an input/output in:body); no Body on GET; url/query/header inputs are scalars. A sample (JSON object or array) becomes "
            + "structures as the Studio's own dialog builds them (<Method>Request|Response). Credentials never go in the model (REST_CREDENTIALS_NOT_IN_MODEL): "
            + "pass an Authorization header input. openapi {path, sha256, operations} imports the chosen operations (ODC headless; O11 through o11_deliver).",
        ["codes"] = Array(["REST_UNKNOWN_KEYS", "REST_KEY_INVALID", "REST_BASEURL_INVALID", "REST_BASEURL_REQUIRED", "REST_URLPATH_INVALID", "REST_PATH_PARAM_WITHOUT_INPUT",
            "REST_URL_INPUT_UNUSED", "REST_BODY_ON_GET", "REST_REQUEST_BODY_COUNT", "REST_RESPONSE_BODY_COUNT", "REST_HEADER_TYPE", "REST_SAMPLE_INVALID",
            "REST_CLIENT_NO_METHODS", "REST_NAME_TAKEN", "REST_CREDENTIALS_NOT_IN_MODEL", "REST_DUPLICATE_NAME", "REST_REMOVE_NOT_FOUND", "OPENAPI_INVALID",
            "OPENAPI_OPERATION_NOT_FOUND", "OPENAPI_EXTERNAL_REF_MISSING", "OPENAPI_NETWORK_REFUSED", "DOCUMENT_SHA256_MISMATCH", "DELETE_HAS_CONSUMERS", "CONSUMERS_CHANGED"]),
    };

    private static JsonArray Array(IEnumerable<string> keys) => new(keys.Select(k => (JsonNode)k).ToArray());

    // ---- validation (pure) ----------------------------------------------------------------------------------------------

    /// <summary>Every problem the op's data alone shows, each with its place and exact fix; empty when it can be applied.</summary>
    public static List<IntegrationProblem> Validate(JsonObject data, string lane)
    {
        var problems = new List<IntegrationProblem>();
        Closed(data, RootKeys, "/data", "data", problems);
        var client = data["client"] as JsonObject;
        if (client == null) problems.Add(new("REST_KEY_INVALID", "/data/client", "rest: client {name, baseUrl} is required", "\"client\": {\"name\": \"<Api>\", \"baseUrl\": \"https://host\"}"));
        else
        {
            Closed(client, ClientKeys, "/data/client", "client", problems);
            Name(client, "/data/client", "client", problems);
            if (client["baseUrl"] is { } url && !BaseUrl.IsMatch(url.ToString()))
                problems.Add(new("REST_BASEURL_INVALID", "/data/client/baseUrl", $"rest: baseUrl '{url}' is not an http(s) URL without query or fragment (the platform answers \"Invalid URL\")",
                    "\"baseUrl\": \"https://host[/base]\"; the path of each method goes in its own path"));
            if (client["auth"] is { } auth)
            {
                if (auth is not JsonObject authObject) problems.Add(new("REST_KEY_INVALID", "/data/client/auth", "rest: auth is {type}", "\"auth\": {\"type\": \"None\"}"));
                else
                {
                    var secrets = authObject.Select(p => p.Key).Where(k => k is "username" or "password" or "clientSecret" or "clientId" or "user" or "secret").ToList();
                    var type = authObject["type"]?.ToString() ?? "None";
                    if (secrets.Count > 0 || type is not "None")
                        problems.Add(new("REST_CREDENTIALS_NOT_IN_MODEL", "/data/client/auth",
                            $"rest: credentials never go in the model ({(secrets.Count > 0 ? string.Join(", ", secrets) : "auth type " + type)}): "
                            + (lane == "odc" ? "the ODC platform refuses Username/Password in a consumed REST client" : "SSAM never writes a literal secret into an O11 module"),
                            "declare a mandatory input {\"name\": \"Authorization\", \"type\": \"Text\", \"in\": \"header\"} on each method and pass the value from a site property or setting at the call; or let the user type the credentials in the Studio",
                            SsamRule: lane != "odc"));
                    else Closed(authObject, AuthKeys, "/data/client/auth", "auth", problems);
                }
            }
            if (client["headers"] is { } headers && (headers is not JsonObject h || h.Any(p => p.Value is not JsonValue v || !v.TryGetValue<string>(out _))))
                problems.Add(new("REST_KEY_INVALID", "/data/client/headers", "rest: headers is {\"Header\": \"<expression>\"}", "\"headers\": {\"Accept\": \"\\\"application/json\\\"\"}"));
            if (client["dateFormat"] is { } df && df.ToString() is not ("ISO" or "UNIXTimestamp" or "WCF"))
                problems.Add(new("REST_KEY_INVALID", "/data/client/dateFormat", $"rest: dateFormat '{df}' is not ISO, UNIXTimestamp or WCF", "\"dateFormat\": \"ISO\""));
        }
        var structures = Objects(data, "structures", "/data/structures", problems);
        var declaredStructures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var s = 0; s < structures.Count; s++)
        {
            var at = $"/data/structures/{s}";
            Closed(structures[s], StructureKeys, at, "structure", problems);
            var name = Name(structures[s], at, "structure", problems);
            if (name != null && !declaredStructures.Add(name)) problems.Add(new("REST_DUPLICATE_NAME", at + "/name", $"rest: structure '{name}' is declared twice", "keep one declaration"));
            var attributes = Objects(structures[s], "attributes", at + "/attributes", problems);
            if (attributes.Count == 0) problems.Add(new("REST_KEY_INVALID", at + "/attributes", $"rest: structure '{name}' needs at least one attribute (the platform refuses an empty structure)", "\"attributes\": [{\"name\": \"Id\", \"type\": \"Integer\", \"json\": \"id\"}]"));
            var attributeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var a = 0; a < attributes.Count; a++)
            {
                Closed(attributes[a], AttributeKeys, $"{at}/attributes/{a}", "attribute", problems);
                var attribute = Name(attributes[a], $"{at}/attributes/{a}", "attribute", problems);
                if (attribute != null && !attributeNames.Add(attribute)) problems.Add(new("REST_DUPLICATE_NAME", $"{at}/attributes/{a}/name", $"rest: attribute '{attribute}' of '{name}' is declared twice", "keep one declaration"));
                if (attributes[a]["type"] is not JsonValue) problems.Add(new("REST_KEY_INVALID", $"{at}/attributes/{a}/type", $"rest: attribute '{attribute}' needs a type", "\"type\": \"Text\""));
            }
        }
        var methods = Objects(data, "methods", "/data/methods", problems);
        var methodNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var m = 0; m < methods.Count; m++)
            Method(methods[m], $"/data/methods/{m}", declaredStructures, methodNames, problems);
        if (data["openapi"] is { } openapi)
        {
            if (openapi is not JsonObject o) problems.Add(new("REST_KEY_INVALID", "/data/openapi", "rest: openapi is {path, sha256, operations}", null));
            else RestOpenApi.Plan(o, problems);
        }
        foreach (var key in new[] { "remove", "breaks" })
            if (data[key] is { } list && (list is not JsonArray array || array.Any(e => e is not JsonValue v || !v.TryGetValue<string>(out var t) || t.Trim().Length == 0)))
                problems.Add(new("REST_KEY_INVALID", "/data/" + key, $"rest: {key} is a list of names", key == "remove" ? "\"remove\": [\"<Method>\", \"IRestStructure:<Name>\"]" : "\"breaks\": [\"<consumer path from the refusal>\"]"));
        foreach (var target in Strings(data["remove"]))
            if (target.Contains(':') && !target.StartsWith("IRestAction:", StringComparison.Ordinal) && !target.StartsWith("IRestStructure:", StringComparison.Ordinal))
                problems.Add(new("REST_KEY_INVALID", "/data/remove", $"rest: remove '{target}' is not a method or structure of the client", "\"remove\": [\"<Method>\", \"IRestAction:<Method>\", \"IRestStructure:<Name>\"]"));
        return problems;
    }

    private static void Method(JsonObject method, string at, HashSet<string> structures, HashSet<string> names, List<IntegrationProblem> problems)
    {
        Closed(method, MethodKeys, at, "method", problems);
        var name = Name(method, at, "method", problems);
        if (name != null && !names.Add(name)) problems.Add(new("REST_DUPLICATE_NAME", at + "/name", $"rest: method '{name}' is declared twice", "keep one declaration"));
        var http = method["http"]?.ToString()?.ToUpperInvariant();
        if (http == null || !Verbs.Contains(http)) problems.Add(new("REST_KEY_INVALID", at + "/http", $"rest: method '{name}' http '{method["http"]}' is not one of {string.Join(", ", Verbs)}", "\"http\": \"GET\""));
        var path = method["path"]?.ToString();
        var placeholders = new List<string>();
        if (path == null) problems.Add(new("REST_URLPATH_INVALID", at + "/path", $"rest: method '{name}' needs path", "\"path\": \"/resource/{Id}\""));
        else
        {
            var reason = PathProblem(path);
            if (reason != null) problems.Add(new("REST_URLPATH_INVALID", at + "/path", $"rest: method '{name}' path '{path}': {reason}", path.StartsWith('/') ? "balance the braces; each {Name} is one input in:url" : $"\"path\": \"/{path.TrimStart('/')}\""));
            else placeholders = Placeholder.Matches(path).Select(x => x.Groups[1].Value).ToList();
        }
        if (method["timeout"] is { } timeout && !(timeout is JsonValue tv && tv.TryGetValue<int>(out var seconds) && seconds > 0))
            problems.Add(new("REST_KEY_INVALID", at + "/timeout", $"rest: method '{name}' timeout is a positive number of seconds", "\"timeout\": 30"));
        var inputs = Objects(method, "inputs", at + "/inputs", problems);
        var outputs = Objects(method, "outputs", at + "/outputs", problems);
        var bodies = new List<string>();
        var inputNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < inputs.Count; i++)
        {
            var iat = $"{at}/inputs/{i}";
            Closed(inputs[i], InputKeys, iat, "input", problems);
            var input = Name(inputs[i], iat, "input", problems);
            if (input != null && !inputNames.Add(input)) problems.Add(new("REST_DUPLICATE_NAME", iat + "/name", $"rest: input '{input}' of '{name}' is declared twice", "keep one declaration"));
            var type = inputs[i]["type"]?.ToString();
            if (type == null) problems.Add(new("REST_KEY_INVALID", iat + "/type", $"rest: input '{input}' of '{name}' needs a type", "\"type\": \"Text\""));
            var place = InputIn(inputs[i], input, placeholders, http);
            if (place == null) { problems.Add(new("REST_KEY_INVALID", iat + "/in", $"rest: input '{input}' in '{inputs[i]["in"]}' is not url, query, header or body", "\"in\": \"url\"")); continue; }
            if (place == "body") bodies.Add(iat);
            if (place == "url" && input != null && !placeholders.Contains(input, StringComparer.Ordinal))
                problems.Add(new("REST_URL_INPUT_UNUSED", iat, $"rest: input '{input}' of '{name}' is in:url but the path has no {{{input}}}", $"put {{{input}}} in the path, or use \"in\": \"query\""));
            if (place is "url" or "query" or "header" && type != null && !Scalar(type, structures))
                problems.Add(new("REST_HEADER_TYPE", iat + "/type", $"rest: input '{input}' of '{name}' ({place}) has type {type}: URL and header values are text, a number, a date or a boolean", "send a list, structure or binary in the body (\"in\": \"body\"), or pass it as Text"));
        }
        foreach (var placeholder in placeholders)
            if (!inputs.Any(i => string.Equals(i["name"]?.ToString(), placeholder, StringComparison.Ordinal) && InputIn(i, placeholder, placeholders, http) is "url" or "query"))
                problems.Add(new("REST_PATH_PARAM_WITHOUT_INPUT", at + "/path", $"rest: path of '{name}' has {{{placeholder}}} and no input {placeholder} in:url", $"add {{\"name\": \"{placeholder}\", \"type\": \"Text\", \"in\": \"url\"}} to inputs (the name is case-sensitive)"));
        if (method["request"] is { } request)
        {
            if (Body(request, at + "/request", name, structures, problems)) bodies.Add(at + "/request");
        }
        if (http == "GET" && bodies.Count > 0)
            problems.Add(new("REST_BODY_ON_GET", bodies[0], $"rest: method '{name}' is GET and sends a body", "send it as query inputs (\"in\": \"query\"), or use POST"));
        if (bodies.Count > 1)
            problems.Add(new("REST_REQUEST_BODY_COUNT", at, $"rest: method '{name}' has {bodies.Count} bodies ({string.Join(", ", bodies)}); a JSON request has exactly one Body (one structure or list)", "group them in one structure and send it as the single body (request {structure} or one input in:body)"));
        var responses = new List<string>();
        if (method["response"] is { } response && Body(response, at + "/response", name, structures, problems)) responses.Add(at + "/response");
        var outputNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var o = 0; o < outputs.Count; o++)
        {
            var oat = $"{at}/outputs/{o}";
            Closed(outputs[o], OutputKeys, oat, "output", problems);
            var output = Name(outputs[o], oat, "output", problems);
            if (output != null && !outputNames.Add(output)) problems.Add(new("REST_DUPLICATE_NAME", oat + "/name", $"rest: output '{output}' of '{name}' is declared twice", "keep one declaration"));
            if (outputs[o]["type"] is not JsonValue) problems.Add(new("REST_KEY_INVALID", oat + "/type", $"rest: output '{output}' needs a type", "\"type\": \"Text\""));
            var place = (outputs[o]["in"]?.ToString() ?? "body").ToLowerInvariant();
            if (place is not ("body" or "header")) problems.Add(new("REST_KEY_INVALID", oat + "/in", $"rest: output '{output}' in '{place}' is not body or header", "\"in\": \"header\""));
            if (place == "body") responses.Add(oat);
            if (place == "header" && outputs[o]["type"]?.ToString() is { } t && !Scalar(t, structures))
                problems.Add(new("REST_HEADER_TYPE", oat + "/type", $"rest: header output '{output}' has type {t}", "a header is text, a number, a date or a boolean"));
        }
        if (method["response"] != null && outputNames.Contains("Response"))
            problems.Add(new("REST_DUPLICATE_NAME", at + "/outputs", $"rest: method '{name}' declares response and an output named Response", "keep one of them"));
        if (method["request"] != null && inputNames.Contains("Request"))
            problems.Add(new("REST_DUPLICATE_NAME", at + "/inputs", $"rest: method '{name}' declares request and an input named Request", "keep one of them"));
        if (responses.Count > 1)
            problems.Add(new("REST_RESPONSE_BODY_COUNT", at, $"rest: method '{name}' has {responses.Count} response bodies ({string.Join(", ", responses)}); a response has one Body", "keep one body (response or one output in:body); other values go in headers"));
    }

    /// <summary>A request/response body: exactly one of structure, sample, type; a sample is a JSON object or array.</summary>
    private static bool Body(JsonNode node, string at, string? method, HashSet<string> structures, List<IntegrationProblem> problems)
    {
        if (node is not JsonObject body) { problems.Add(new("REST_KEY_INVALID", at, $"rest: {at.Split('/').Last()} of '{method}' is {{structure|sample|type, format?}}", "{\"structure\": \"<Name>\"}")); return false; }
        Closed(body, BodyKeys, at, at.Split('/').Last(), problems);
        var forms = new[] { "structure", "sample", "type" }.Where(body.ContainsKey).ToList();
        if (forms.Count != 1) { problems.Add(new("REST_KEY_INVALID", at, $"rest: {at.Split('/').Last()} of '{method}' has {(forms.Count == 0 ? "none" : string.Join(" and ", forms))} of structure, sample, type", "use exactly one: {\"structure\": \"<Name>\"}, {\"sample\": {...}} or {\"type\": \"Text\"}")); return false; }
        if (forms[0] == "sample" && SampleProblem(body["sample"]) is { } why)
            problems.Add(new("REST_SAMPLE_INVALID", at + "/sample", $"rest: sample of '{method}': {why}", "a JSON object or array with one example of each field, e.g. {\"id\": 1, \"name\": \"x\", \"tags\": [\"a\"]}"));
        if (body["format"] is { } format && format.ToString() is not ("JSON" or "PlainText" or "Binary" or "FormURLEncoded"))
            problems.Add(new("REST_KEY_INVALID", at + "/format", $"rest: format '{format}' is not JSON, PlainText, Binary or FormURLEncoded", "\"format\": \"JSON\""));
        return true;
    }

    /// <summary>Why a sample cannot become structures; null when it is a JSON object or array (also given as a JSON string).</summary>
    public static string? SampleProblem(JsonNode? sample)
    {
        var node = sample;
        if (sample is JsonValue v && v.TryGetValue<string>(out var text))
        {
            try { node = JsonNode.Parse(text); }
            catch (System.Text.Json.JsonException ex) { return "not valid JSON: " + ex.Message.Split('.')[0]; }
        }
        return node switch
        {
            JsonObject o when o.Count == 0 => "an empty object has no field to type",
            JsonObject => null,
            JsonArray a when a.Count == 0 => "an empty array has no element to type",
            JsonArray => null,
            _ => "a sample is a JSON object or array (a scalar response is {\"type\": \"Text\"})",
        };
    }

    public static string SampleText(JsonNode sample) => sample is JsonValue v && v.TryGetValue<string>(out var text) ? text : sample.ToJsonString();

    /// <summary>Why a URL path is refused, or null: it starts with '/', braces are balanced and not nested, each {X} is a name.</summary>
    public static string? PathProblem(string path)
    {
        if (!path.StartsWith('/')) return "it must start with '/'";
        var depth = 0;
        foreach (var c in path)
        {
            if (c == '{' && ++depth > 1) return "nested braces";
            if (c == '}' && --depth < 0) return "a '}' closes nothing";
        }
        if (depth != 0) return "a '{' is not closed";
        foreach (Match m in Placeholder.Matches(path))
            if (!Identifier.IsMatch(m.Groups[1].Value)) return $"{{{m.Groups[1].Value}}} is not an input name";
        return null;
    }

    private static string? InputIn(JsonObject input, string? name, IReadOnlyCollection<string> placeholders, string? http)
    {
        var given = input["in"]?.ToString()?.ToLowerInvariant();
        if (given != null) return given is "url" or "query" or "header" or "body" ? given : null;
        if (name != null && placeholders.Contains(name, StringComparer.Ordinal)) return "url";
        return http is "GET" or "DELETE" ? "query" : "body";
    }

    private static bool Scalar(string type, HashSet<string> structures)
        => !type.EndsWith(" List", StringComparison.OrdinalIgnoreCase) && !structures.Contains(type)
           && !type.Replace(" ", "").Equals("BinaryData", StringComparison.OrdinalIgnoreCase) && !type.EndsWith(" Record", StringComparison.OrdinalIgnoreCase);

    private static void Closed(JsonObject o, string[] allowed, string at, string what, List<IntegrationProblem> problems)
    {
        foreach (var key in o.Select(p => p.Key).Where(k => !allowed.Contains(k, StringComparer.Ordinal) && !k.StartsWith('_')))
        {
            if (what == "auth" || (what == "client" && key is "username" or "password")) continue; // reported as credentials
            problems.Add(new("REST_UNKNOWN_KEYS", at + "/" + key, $"rest: {what} has unknown key '{key}'", "use only: " + string.Join(", ", allowed)));
        }
        if (what == "client" && o.Select(p => p.Key).Any(k => k is "username" or "password"))
            problems.Add(new("REST_CREDENTIALS_NOT_IN_MODEL", at, "rest: credentials never go in the model (username/password)",
                "declare a mandatory input {\"name\": \"Authorization\", \"type\": \"Text\", \"in\": \"header\"} on each method", SsamRule: MessageExpectations.Lane != "odc"));
    }

    private static string? Name(JsonObject o, string at, string what, List<IntegrationProblem> problems)
    {
        var name = o["name"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        if (name == null || !Identifier.IsMatch(name))
        {
            problems.Add(new("REST_KEY_INVALID", at + "/name", $"rest: {what} name '{name}' is not an OutSystems name (letter or _ first, then letters, digits, _)", $"\"name\": \"{Regex.Replace(name ?? what, "[^A-Za-z0-9_]", "")}\""));
            return null;
        }
        return name;
    }

    private static List<JsonObject> Objects(JsonObject owner, string key, string at, List<IntegrationProblem> problems)
    {
        if (owner[key] is null) return [];
        if (owner[key] is not JsonArray array || array.Any(e => e is not JsonObject)) { problems.Add(new("REST_KEY_INVALID", at, $"rest: {key} is a list of objects", null)); return []; }
        return array.OfType<JsonObject>().ToList();
    }

    internal static IEnumerable<string> Strings(JsonNode? node) => node is JsonArray a ? a.OfType<JsonValue>().Select(v => v.TryGetValue<string>(out var s) ? s.Trim() : "").Where(s => s.Length > 0) : [];

    // ---- expansion ------------------------------------------------------------------------------------------------------

    /// <summary>What the module already has under the client's name, read by the handler before expanding: keys address
    /// existing elements (@key), so an update keeps them and their callers.</summary>
    public sealed record Existing(string Key, IReadOnlyDictionary<string, ExistingMethod> Methods, IReadOnlyDictionary<string, ExistingStructure> Structures,
        IReadOnlyDictionary<string, string> Headers);
    public sealed record ExistingMethod(string Key, IReadOnlyDictionary<string, string> Inputs, IReadOnlyDictionary<string, string> Outputs);
    public sealed record ExistingStructure(string Key, IReadOnlyDictionary<string, string> Attributes);

    /// <summary>A body the plugin types from a sample (StructureHelper), after the raw ops created its parameter.</summary>
    public sealed record SampleBody(string Alias, string Method, string StructureName, string Sample, bool Request);

    public sealed record Expansion(List<JsonObject> Ops, List<SampleBody> Samples, List<string> Created, List<string> Updated, List<string> Removed);

    /// <summary>The raw ops of a valid op over the module's current state (null: the client does not exist).</summary>
    public static Expansion Expand(JsonObject data, Existing? existing = null)
    {
        var ops = new List<JsonObject>(); var samples = new List<SampleBody>();
        var created = new List<string>(); var updated = new List<string>(); var removed = new List<string>();
        var client = data["client"]!.AsObject();
        var clientName = client["name"]!.ToString();
        var c = existing != null ? "@" + existing.Key : "$rest." + clientName;
        var clientAlias = "$rest." + clientName;
        var breaks = Strings(data["breaks"]).ToArray();
        foreach (var target in Strings(data["remove"]))
        {
            var (kind, name) = target.StartsWith("IRestStructure:", StringComparison.Ordinal) ? ("IRestStructure", target["IRestStructure:".Length..])
                : ("IRestAction", target.StartsWith("IRestAction:", StringComparison.Ordinal) ? target["IRestAction:".Length..] : target);
            var key = kind == "IRestAction" ? existing?.Methods.GetValueOrDefault(name)?.Key : existing?.Structures.GetValueOrDefault(name)?.Key;
            var delete = Op("delete", ("target", key != null ? "@" + key : kind + ":" + name));
            if (breaks.Length > 0) delete["breaks"] = new JsonArray(breaks.Select(b => (JsonNode)b).ToArray());
            ops.Add(delete);
            removed.Add(kind + ":" + name);
        }
        if (existing == null)
        {
            ops.Add(Op("create", ("parent", "@espace"), ("type", "IRestClient"), ("name", clientName), ("as", clientAlias)));
            created.Add("IRestClient:" + clientName);
        }
        else updated.Add("IRestClient:" + clientName);
        if (client["baseUrl"] is { } baseUrl) ops.Add(Set(c, "BaseURL", baseUrl.ToString()));
        if (client["description"] is { } description) ops.Add(Set(c, "Description", description.ToString()));
        if (client["dateFormat"] is { } dateFormat) ops.Add(Set(c, "DateFormat", dateFormat.ToString()));
        var h = 0;
        foreach (var (header, value) in client["headers"] as JsonObject ?? new JsonObject())
        {
            if (existing?.Headers.GetValueOrDefault(header) is { } headerKey) { ops.Add(Set("@" + headerKey, "Value", value!.ToString())); continue; }
            var alias = $"{clientAlias}.header{++h}";
            ops.Add(Op("create", ("parent", c), ("type", "IExtendedProperty"), ("as", alias)));
            ops.Add(Set(alias, "Property", header));
            ops.Add(Set(alias, "Value", value!.ToString()));
        }
        foreach (var structure in Ordered(data["structures"] as JsonArray))
        {
            var name = structure["name"]!.ToString();
            var current = existing?.Structures.GetValueOrDefault(name);
            var s = current != null ? "@" + current.Key : $"{clientAlias}.{name}";
            if (current == null)
            {
                ops.Add(Op("create", ("parent", c), ("type", "IRestStructure"), ("name", name), ("as", s)));
                created.Add("IRestStructure:" + name);
            }
            else updated.Add("IRestStructure:" + name);
            if (structure["description"] is { } sd) ops.Add(Set(s, "Description", sd.ToString()));
            var declared = new HashSet<string>(StringComparer.Ordinal);
            var a = 0;
            foreach (var attribute in structure["attributes"]!.AsArray().OfType<JsonObject>())
            {
                var attributeName = attribute["name"]!.ToString(); declared.Add(attributeName); a++;
                var key = current?.Attributes.GetValueOrDefault(attributeName);
                var target = key != null ? "@" + key : $"{s}.a{a}";
                if (key == null) ops.Add(Op("create", ("parent", s), ("type", "IRestStructureAttribute"), ("name", attributeName), ("as", target)));
                ops.Add(Set(target, "DataType", attribute["type"]!.ToString()));
                ops.Add(Set(target, "NameInJSON", attribute["json"]?.ToString() ?? attributeName));
                if (attribute["mandatory"] is JsonValue mv && mv.TryGetValue<bool>(out var mandatory)) ops.Add(Set(target, "IsMandatory", mandatory));
                if (attribute["description"] is { } ad) ops.Add(Set(target, "Description", ad.ToString()));
            }
            foreach (var (stale, key) in current?.Attributes.Where(x => !declared.Contains(x.Key)) ?? [])
            { ops.Add(Op("delete", ("target", "@" + key))); removed.Add($"IRestStructureAttribute:{name}.{stale}"); }
        }
        foreach (var method in data["methods"]?.AsArray().OfType<JsonObject>() ?? [])
            ExpandMethod(method, c, clientAlias, existing, ops, samples, created, updated, removed);
        return new(ops, samples, created, updated, removed);
    }

    private static void ExpandMethod(JsonObject method, string c, string clientAlias, Existing? existing, List<JsonObject> ops, List<SampleBody> samples,
        List<string> created, List<string> updated, List<string> removed)
    {
        var name = method["name"]!.ToString();
        var http = method["http"]!.ToString().ToUpperInvariant();
        var current = existing?.Methods.GetValueOrDefault(name);
        var m = current != null ? "@" + current.Key : $"{clientAlias}.{name}";
        if (current == null) { ops.Add(Op("create", ("parent", c), ("type", "IRestAction"), ("name", name), ("as", m))); created.Add("IRestAction:" + name); }
        else updated.Add("IRestAction:" + name);
        var path = method["path"]!.ToString();
        var placeholders = Placeholder.Matches(path).Select(x => x.Groups[1].Value).ToList();
        var inputs = method["inputs"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
        // The Studio's own generator appends query inputs to the URL Path (?a={a}&b={b}) with UrlPlacement.
        var query = inputs.Where(i => InputIn(i, i["name"]!.ToString(), placeholders, http) == "query" && !placeholders.Contains(i["name"]!.ToString(), StringComparer.Ordinal))
            .Select(i => i["name"]!.ToString()).ToList();
        if (query.Count > 0) path += (path.Contains('?') ? "&" : "?") + string.Join("&", query.Select(q => $"{q}={{{q}}}"));
        ops.Add(Set(m, "HTTPMethod", http));
        ops.Add(Set(m, "URLPath", path));
        var request = method["request"] as JsonObject;
        var response = method["response"] as JsonObject;
        var bodyInput = inputs.FirstOrDefault(i => InputIn(i, i["name"]!.ToString(), placeholders, http) == "body");
        if (request != null || bodyInput != null) ops.Add(Set(m, "RequestFormat", Format(request ?? new JsonObject { ["type"] = bodyInput!["type"]!.DeepClone() })));
        var bodyOutput = method["outputs"]?.AsArray().OfType<JsonObject>().FirstOrDefault(o => (o["in"]?.ToString() ?? "body").Equals("body", StringComparison.OrdinalIgnoreCase));
        if (response != null || bodyOutput != null) ops.Add(Set(m, "ResponseFormat", Format(response ?? new JsonObject { ["type"] = bodyOutput!["type"]!.DeepClone() })));
        if (method["timeout"] is { } timeout) ops.Add(Set(m, "TimeoutinSeconds", timeout.GetValue<int>()));
        if (method["description"] is { } description) ops.Add(Set(m, "Description", description.ToString()));
        var declaredInputs = new HashSet<string>(StringComparer.Ordinal);
        var n = 0;
        if (request != null)
        {
            declaredInputs.Add("Request");
            var target = Param(m, "IRestActionInput", "Request", current?.Inputs, ref n, ops);
            if (request["sample"] is { } sample) samples.Add(new(target, name, name + "Request", SampleText(sample), true));
            else ops.Add(Set(target, "DataType", request["structure"]?.ToString() ?? request["type"]!.ToString()));
            ops.Add(Set(target, "IsMandatory", true));
            ops.Add(Set(target, "InputPlacement", "BodyPlacement"));
        }
        foreach (var input in inputs)
        {
            var inputName = input["name"]!.ToString(); declaredInputs.Add(inputName);
            var place = InputIn(input, inputName, placeholders, http)!;
            var target = Param(m, "IRestActionInput", inputName, current?.Inputs, ref n, ops);
            ops.Add(Set(target, "DataType", input["type"]!.ToString()));
            var mandatory = input["mandatory"] is JsonValue mv && mv.TryGetValue<bool>(out var flag) ? flag : place != "query";
            ops.Add(Set(target, "IsMandatory", place == "url" && !query.Contains(inputName) || mandatory));
            ops.Add(Set(target, "InputPlacement", place switch { "header" => "HeaderPlacement", "body" => "BodyPlacement", _ => "UrlPlacement" }));
            if (input["originalName"] is { } original) ops.Add(Set(target, "OriginalName", original.ToString()));
            // An optional query parameter or header is not sent when the caller leaves it empty.
            if (place is "query" or "header" && !mandatory) ops.Add(Set(target, "DefaultValueBehavior", "DontSend"));
            if (input["description"] is { } d) ops.Add(Set(target, "Description", d.ToString()));
        }
        var declaredOutputs = new HashSet<string>(StringComparer.Ordinal);
        if (response != null)
        {
            declaredOutputs.Add("Response");
            var target = Param(m, "IRestActionOutput", "Response", current?.Outputs, ref n, ops);
            if (response["sample"] is { } sample) samples.Add(new(target, name, name + "Response", SampleText(sample), false));
            else ops.Add(Set(target, "DataType", response["structure"]?.ToString() ?? response["type"]!.ToString()));
            ops.Add(Set(target, "OutputPlacement", "BodyPlacement"));
        }
        foreach (var output in method["outputs"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var outputName = output["name"]!.ToString(); declaredOutputs.Add(outputName);
            var target = Param(m, "IRestActionOutput", outputName, current?.Outputs, ref n, ops);
            ops.Add(Set(target, "DataType", output["type"]!.ToString()));
            var header = (output["in"]?.ToString() ?? "body").Equals("header", StringComparison.OrdinalIgnoreCase);
            ops.Add(Set(target, "OutputPlacement", header ? "HeaderPlacement" : "BodyPlacement"));
            if (output["originalName"] is { } original) ops.Add(Set(target, "OriginalName", original.ToString()));
            else if (header) ops.Add(Set(target, "OriginalName", outputName));
            if (output["description"] is { } d) ops.Add(Set(target, "Description", d.ToString()));
        }
        // A re-declared method has exactly the parameters it declares: the others go (a caller's argument is a consumer).
        foreach (var (stale, key) in current?.Inputs.Where(p => !declaredInputs.Contains(p.Key)) ?? [])
        { ops.Add(Op("delete", ("target", "@" + key))); removed.Add($"IRestActionInput:{name}.{stale}"); }
        foreach (var (stale, key) in current?.Outputs.Where(p => !declaredOutputs.Contains(p.Key)) ?? [])
        { ops.Add(Op("delete", ("target", "@" + key))); removed.Add($"IRestActionOutput:{name}.{stale}"); }
    }

    private static string Param(string method, string type, string name, IReadOnlyDictionary<string, string>? existing, ref int n, List<JsonObject> ops)
    {
        n++;
        if (existing?.GetValueOrDefault(name) is { } key) return "@" + key;
        var alias = $"{method}.{(type.EndsWith("Input", StringComparison.Ordinal) ? "in" : "out")}.{name}";
        if (method.StartsWith('@')) alias = "$rest" + method.Replace('/', '_') + "." + name + "." + n;
        ops.Add(Op("create", ("parent", method), ("type", type), ("name", name), ("as", alias)));
        return alias;
    }

    private static string Format(JsonObject body)
    {
        if (body["format"] is { } format) return format.ToString();
        if (body.ContainsKey("structure") || body.ContainsKey("sample")) return "JSON";
        var type = body["type"]?.ToString() ?? "";
        return type.Replace(" ", "").Equals("BinaryData", StringComparison.OrdinalIgnoreCase) ? "Binary"
            : type.Equals("Text", StringComparison.OrdinalIgnoreCase) ? "PlainText" : "JSON";
    }

    /// <summary>Structures in an order where an attribute typed by another declared structure (or a list of it) comes after it.</summary>
    private static List<JsonObject> Ordered(JsonArray? structures)
    {
        var list = structures?.OfType<JsonObject>().ToList() ?? [];
        var names = list.Select(s => s["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<JsonObject>();
        void Visit(JsonObject s, HashSet<string> path)
        {
            var name = s["name"]!.ToString();
            if (done.Contains(name) || !path.Add(name)) return;
            foreach (var type in s["attributes"]?.AsArray().OfType<JsonObject>().Select(a => Regex.Replace(a["type"]?.ToString() ?? "", " List$", "")) ?? [])
                if (names.Contains(type) && list.FirstOrDefault(x => string.Equals(x["name"]!.ToString(), type, StringComparison.OrdinalIgnoreCase)) is { } dependency) Visit(dependency, path);
            if (done.Add(name)) result.Add(s);
        }
        foreach (var s in list) Visit(s, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        return result;
    }

    internal static JsonObject Op(string op, params (string Key, object Value)[] fields)
    {
        var o = new JsonObject { ["op"] = op };
        foreach (var (k, v) in fields) o[k] = v is JsonNode node ? node : V(v);
        return o;
    }
    internal static JsonObject Set(string target, string prop, object value) => new() { ["op"] = "set", ["target"] = target, ["prop"] = prop, ["value"] = V(value) };
    private static JsonNode V(object v) => v switch { string s => JsonValue.Create(s)!, bool b => JsonValue.Create(b), int i => JsonValue.Create(i), JsonNode n => n, _ => JsonValue.Create(v.ToString())! };
}
