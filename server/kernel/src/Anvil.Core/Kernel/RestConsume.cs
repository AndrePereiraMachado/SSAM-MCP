using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// Op `rest-consume` (both lanes): the deterministic generator of a consumed REST integration from URLs and JSON samples, for
/// any API of any domain. The model writes the URLs (and, outside a delivery, the samples); the generator writes the rest:
/// <list type="bullet">
/// <item>the REST client and its methods through the op `rest` (the same IRestClient/IRestAction/IRestStructure the Studio's
/// import creates), with the output structures inferred from the sample and owned by the client (`&lt;Public&gt;Json`);</item>
/// <item>one public structure per resource, the client structure's mirror (same attribute names, nested mirrors), so the
/// mapping is the platform's own conversion (each attribute from the attribute of the same name): a ListAppendAll for a
/// list, an assign for a record; never a For Each, a JavaScript or a hand-written mapping;</item>
/// <item>a public service action per method (O11 and ODC; `expose.serviceActions:false` makes public server actions) that
/// calls the method, returns the public copy and turns any failure into a named user exception, logged.</item>
/// </list>
/// Every element it writes carries the marker `ssam:rest-consume &lt;Client&gt;[/&lt;Base&gt;] #&lt;hash&gt;` in its description: the same op
/// again finds its own elements by the marker and changes nothing when the hash is the same (idempotent); an element of
/// the same name that is not its own is never touched: the generated one takes the next free name (Name2, Name3...).
/// The kernel never reads the network: a method without `sample` is sampled by the facade (one GET, short timeout, no
/// credentials, capped) before the job runs (integration-documents.mjs), or refused here with REST_CONSUME_SAMPLE_MISSING.
///
/// {"op":"rest-consume","data":{"name":"BrasilApi","methods":[
///   {"name":"Feriados","url":"https://brasilapi.com.br/api/feriados/v1/{ano=2026}"}]}}
/// </summary>
public static partial class RestConsume
{
    public const string Op = "rest-consume";
    /// <summary>The generator's version: part of every hash, so a new generator rewrites what an older one wrote.</summary>
    public const string Generator = "rest-consume/2";
    public const string MarkerPrefix = "ssam:rest-consume ";
    public static readonly string[] RootKeys = ["name", "baseUrl", "description", "dateFormat", "methods", "expose", "errors", "auth", "headers", "settings", "timeout", "correlationHeader", "callbacks"];
    public static readonly string[] MethodKeys = ["name", "url", "verb", "params", "try", "sample", "request", "resource", "action", "timeout", "description", "sampledFrom", "headers", "optional"];
    public static readonly string[] ExposeKeys = ["serviceActions", "guard"];
    public static readonly string[] ErrorKeys = ["exception", "status"];
    public static readonly string[] Verbs = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    public static readonly string[] ParamTypes = ["Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Date Time"];
    private static readonly Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);
    private static readonly Regex Placeholder = new(@"\{([^{}=]*)(?:=([^{}]*))?\}", RegexOptions.Compiled);
    private static readonly Regex DateOnly = new(@"^\d{4}-\d{2}-\d{2}$", RegexOptions.Compiled);
    private static readonly Regex DateTimeIso = new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:?\d{2})?$", RegexOptions.Compiled);
    private static readonly Regex VerbPrefix = new("^(Get|List|Listar|Obter|Buscar|Consultar|Fetch|Find|Read|Load|Search|Pesquisar|Retrieve)(?=[A-Z0-9])", RegexOptions.Compiled);
    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase) { "And", "Or", "Not", "True", "False", "Null", "If", "Like", "Current", "Length", "Empty", "List" };
    public const int NameMax = 50;

    public static JsonObject Schema() => new()
    {
        ["op"] = Op,
        ["data"] = Array(RootKeys),
        ["shapes"] = new JsonObject
        {
            ["method"] = Array(MethodKeys), ["expose"] = Array(ExposeKeys), ["errors"] = Array(ErrorKeys), ["auth"] = Array(AuthKeys), ["settings"] = Array(SettingsKeys),
            ["callbacks"] = Array(CallbackKeys), ["callbackSlot"] = Array(SlotKeys),
        },
        ["authTypes"] = Array(AuthTypes),
        ["verbs"] = Array(Verbs),
        ["paramTypes"] = Array(ParamTypes),
        ["example"] = JsonNode.Parse("""{"op":"rest-consume","data":{"name":"BrasilApi","methods":[{"name":"Feriados","url":"https://brasilapi.com.br/api/feriados/v1/{ano=2026}"}]}}"""),
        ["rules"] = "One call generates a consumed REST integration from URLs: the REST client and its methods (op rest), the output structures "
            + "inferred from a JSON sample and owned by the client (<Resource>Json), one public structure per resource (its mirror: same attribute "
            + "names and nested mirrors), the mapping (attribute by attribute: ListAppendAll for a list, assign for a record, private Map* "
            + "functions for deeper records and lists), and a public service action per method named Verb+Client+Object (the method's own verb, "
            + "ListRepos: ListGitHubRepos; else GET Get, POST Send, PUT Save, PATCH Update, DELETE Delete: Feriados: GetBrasilApiFeriados; "
            + "action overrides it; expose.serviceActions:false: public server actions; expose:false: only the client) that calls the method, "
            + "returns Result and raises the user exception errors.exception (default <Client>Error) with logging on any failure. An action that "
            + "changes data (any verb but GET) checks the caller first, if GetUserId() = NullIdentifier() raise AccessDenied, and calls its private "
            + "<Action>_Impl (expose.guard:\"none\" leaves the check out). Booleans are named Is/Has/Can; every element is described. "
            + "url: absolute, or relative to baseUrl (without baseUrl the common part of the absolute urls is the base); {p} or {p=example} in the "
            + "path is a mandatory input; ?k=v in the query is an optional input with default v, ?k={p} a mandatory one; params {p: type} types "
            + "them (else the example decides: digits Integer/Long Integer, decimals Decimal, true/false Boolean, yyyy-MM-dd Date, else Text). "
            + "sample: the JSON response (any shape: object, array, scalar, nested, nulls, empty arrays); without it the facade GETs the url once "
            + "(10 s, 2 MB, no credentials) and pins the sample in the job; request: the JSON body of a POST/PUT/PATCH. Types: Text, Integer, Long "
            + "Integer, Decimal, Boolean, Date (yyyy-MM-dd), Date Time (ISO 8601 with T and seconds); numbers written as strings stay Text; null or [] is guessed "
            + "Text/Text List (warning); a list of lists is left out (warning). resource names the public structure (default: the method name "
            + "without a verb prefix, + Item for a list); action names the service action. Idempotent: the same op again changes nothing (each "
            + "element carries the marker ssam:rest-consume in its description); a name taken by an element it did not write gets the next "
            + "free one (Name2), listed in renamed. "
            + "Authenticated and customized APIs (credentials never in the model: REST_CREDENTIALS_NOT_IN_MODEL): auth {type: none|basic|bearer|apiKey|oauth2}; "
            + "apiKey takes in (header|query, default header) and name (default X-API-Key, or api_key in the query); oauth2 takes tokenUrl (https), scope and "
            + "cacheMinutes (default 50): a token client <Client>Auth and a private Get<Client>AccessToken the platform caches. The generator creates the site "
            + "properties (O11) or settings (ODC) that hold the credentials, empty and secret (<Client>Token, <Client>ApiKey, <Client>BasicCredentials: the Base64 "
            + "of user:password on ODC; on O11 <Client>Username and <Client>Password, encoded at runtime by the system extension BinaryData, "
            + "whose reference op {\"op\":\"reference\",\"producer\":\"BinaryData\",\"elements\":[\"IServerAction:TextToBinaryData\",\"IServerAction:BinaryToBase64\"]} "
            + "the delivery adds; <Client>ClientId/<Client>ClientSecret), reads them in the client's OnBeforeRequest, and the receipt's configure lists what the "
            + "user fills in Service Center or the ODC Portal. headers {Name: literal}: sent by OnBeforeRequest on every request; methods[].headers {Name: "
            + "literal | {input} | {input=example}}: a header the action always sends, or an input the caller passes; methods[].optional [input]: a header or "
            + "query input {p} the caller may leave empty (not sent; =v is its default); correlationHeader: every action takes an optional CorrelationId sent in "
            + "that header; settings.baseUrl: the base URL from <Client>BaseUrl per environment; timeout: the seconds of every method; errors.status "
            + "{\"404\": \"<Exception>\"}: that status raises its own exception (kept by the action), any other status from 400 the client's, with the status and "
            + "the first 300 characters of the body (OnAfterResponse); callbacks {before|after: {steps, vars}}: the logic op's steps after the recipe of "
            + "OnBeforeRequest (Request, CustomizedRequest) or OnAfterResponse (Response, CustomizedResponse), validated by the logic op. A client with any of "
            + "these but timeout and correlationHeader gets both callbacks.",
        ["codes"] = Array(["REST_CONSUME_UNKNOWN_KEYS", "REST_CONSUME_KEY_INVALID", "REST_CONSUME_URL_INVALID", "REST_CONSUME_HOSTS_DIFFER",
            "REST_CONSUME_URL_OUTSIDE_BASE", "REST_CONSUME_PARAM_TYPE", "REST_CONSUME_DUPLICATE_NAME", "REST_CONSUME_SAMPLE_MISSING",
            "REST_CONSUME_SAMPLE_INVALID", "REST_CONSUME_BODY_ON_GET", "REST_CONSUME_NO_METHODS", "REST_CREDENTIALS_NOT_IN_MODEL", "REST_CONSUME_CALLBACK_NOT_OWN", "REST_CONSUME_REFERENCE_MISSING"]),
    };

    private static JsonArray Array(IEnumerable<string> keys) => new(keys.Select(k => (JsonNode)k).ToArray());

    // ---- validation (pure) ----------------------------------------------------------------------------------------------

    /// <summary>Every problem the op's data alone shows (paths relative to the op), with the exact fix; empty when it applies.</summary>
    public static List<IntegrationProblem> Validate(JsonObject data, string lane)
    {
        var problems = new List<IntegrationProblem>();
        Closed(data, RootKeys, "/data", "data", problems);
        var name = data["name"] is JsonValue nv && nv.TryGetValue<string>(out var n) ? n : null;
        if (name == null || !Identifier.IsMatch(name) || name.Length > NameMax)
            problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/name", $"rest-consume: name '{name}' is the REST client's name: an OutSystems name (letter or _ first, then letters, digits, _; at most {NameMax})",
                $"\"name\": \"{Sanitize(name ?? "Api", "Api")}\""));
        if (data["baseUrl"] is { } b && (b is not JsonValue bv || !bv.TryGetValue<string>(out var bs) || !TryAbsolute(bs, out _, out _, out _)))
            problems.Add(new("REST_CONSUME_URL_INVALID", "/data/baseUrl", $"rest-consume: baseUrl '{b}' is not an http(s) URL without query or fragment", "\"baseUrl\": \"https://host[/base]\""));
        if (data["dateFormat"] is { } df && df.ToString() is not ("ISO" or "UNIXTimestamp" or "WCF"))
            problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/dateFormat", $"rest-consume: dateFormat '{df}' is not ISO, UNIXTimestamp or WCF", "\"dateFormat\": \"ISO\""));
        if (data["expose"] is { } expose)
        {
            if (expose is JsonValue ev && ev.TryGetValue<bool>(out _)) { }
            else if (expose is JsonObject eo)
            {
                Closed(eo, ExposeKeys, "/data/expose", "expose", problems);
                if (eo["serviceActions"] is { } sa && !(sa is JsonValue sv && sv.TryGetValue<bool>(out _)))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/expose/serviceActions", "rest-consume: expose.serviceActions is true (service actions) or false (public server actions)", "\"expose\": {\"serviceActions\": true}"));
                if (eo["guard"] is { } guard && guard.ToString() is not ("user" or "none"))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/expose/guard", $"rest-consume: expose.guard '{guard}' is \"user\" (an action that changes data needs a signed-in user, the default) or \"none\"", "\"expose\": {\"guard\": \"user\"}"));
            }
            else problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/expose", "rest-consume: expose is {serviceActions: true|false}, or false for the client only", "\"expose\": {\"serviceActions\": true}"));
        }
        if (data["errors"] is { } errors)
        {
            if (errors is not JsonObject eo) problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/errors", "rest-consume: errors is {exception: <Name>}", "\"errors\": {\"exception\": \"ApiError\"}"));
            else
            {
                Closed(eo, ErrorKeys, "/data/errors", "errors", problems);
                if (eo["exception"] is { } ex && !(ex is JsonValue xv && xv.TryGetValue<string>(out var xs) && Identifier.IsMatch(xs) && xs.Length <= NameMax))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/errors/exception", $"rest-consume: errors.exception '{ex}' is not an OutSystems name", "\"errors\": {\"exception\": \"ApiError\"}"));
                ValidateStatus(eo, problems);
            }
        }
        ValidateCustomization(data, problems);
        var authenticated = AuthType(data) != "none";
        if (data["methods"] is not JsonArray methods || methods.Count == 0 || methods.Any(m => m is not JsonObject))
        {
            problems.Add(new("REST_CONSUME_NO_METHODS", "/data/methods", "rest-consume: methods is a list of {name, url} (at least one)", "\"methods\": [{\"name\": \"GetItems\", \"url\": \"https://host/api/items\"}]"));
            return problems;
        }
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var baseUrl = data["baseUrl"]?.ToString();
        for (var i = 0; i < methods.Count; i++)
        {
            var m = (JsonObject)methods[i]!;
            var at = $"/data/methods/{i}";
            Closed(m, MethodKeys, at, "method", problems);
            var mn = m["name"] is JsonValue mv && mv.TryGetValue<string>(out var ms) ? ms : null;
            if (mn == null || !Identifier.IsMatch(mn) || mn.Length > NameMax)
                problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/name", $"rest-consume: method name '{mn}' is not an OutSystems name", $"\"name\": \"{Sanitize(mn ?? "Method", "Method")}\""));
            else if (!names.Add(mn)) problems.Add(new("REST_CONSUME_DUPLICATE_NAME", at + "/name", $"rest-consume: method '{mn}' is declared twice", "give each method its own name"));
            foreach (var key in new[] { "resource", "action" })
                if (m[key] is { } r && !(r is JsonValue rv && rv.TryGetValue<string>(out var rs) && Identifier.IsMatch(rs) && rs.Length <= NameMax))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", $"{at}/{key}", $"rest-consume: {key} '{r}' of '{mn}' is not an OutSystems name", $"\"{key}\": \"{Sanitize(r.ToString(), "Name")}\""));
            var verb = (m["verb"]?.ToString() ?? "GET").ToUpperInvariant();
            if (!Verbs.Contains(verb)) problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/verb", $"rest-consume: verb '{m["verb"]}' of '{mn}' is not one of {string.Join(", ", Verbs)}", "\"verb\": \"GET\""));
            if (m["timeout"] is { } t && !(t is JsonValue tv && tv.TryGetValue<int>(out var ts) && ts > 0))
                problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/timeout", $"rest-consume: timeout of '{mn}' is a positive number of seconds", "\"timeout\": 30"));
            if (m["url"] is not JsonValue uv || !uv.TryGetValue<string>(out var url) || url.Trim().Length == 0)
                problems.Add(new("REST_CONSUME_URL_INVALID", at + "/url", $"rest-consume: method '{mn}' needs url", "\"url\": \"https://host/api/items/{id=1}\""));
            else if (Regex.IsMatch(url.Trim(), "^[A-Za-z][A-Za-z0-9+.-]*://") && !Regex.IsMatch(url.Trim(), "^https?://", RegexOptions.IgnoreCase))
                problems.Add(new("REST_CONSUME_URL_INVALID", at + "/url", $"rest-consume: url '{url}' of '{mn}' is not http or https", "\"url\": \"https://host/path\""));
            else if (ParseUrl(url, baseUrl) is { Problem: { } why }) problems.Add(new("REST_CONSUME_URL_INVALID", at + "/url", $"rest-consume: url '{url}' of '{mn}': {why}", "an absolute http(s) URL, or a path that starts with '/' and a baseUrl; {p} or {p=example} for each path input"));
            else if (baseUrl == null && !Regex.IsMatch(url.Trim(), "^https?://", RegexOptions.IgnoreCase))
                problems.Add(new("REST_CONSUME_URL_INVALID", at + "/url", $"rest-consume: url '{url}' of '{mn}' is relative and the op has no baseUrl", "an absolute url (\"https://host/path\"), or \"baseUrl\": \"https://host\""));
            foreach (var key in new[] { "params", "try" })
                if (m[key] is { } p && (p is not JsonObject po || po.Any(x => x.Value is not JsonValue)))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", $"{at}/{key}", $"rest-consume: {key} of '{mn}' is {{\"<input>\": {(key == "params" ? "\"<type>\"" : "<example>")}}}", key == "params" ? "\"params\": {\"id\": \"Integer\"}" : "\"try\": {\"id\": 1}"));
            if (m["params"] is JsonObject types)
                foreach (var (pn, pt) in types)
                    if (!ParamTypes.Contains(NormalizeType(pt?.ToString() ?? ""), StringComparer.Ordinal))
                        problems.Add(new("REST_CONSUME_PARAM_TYPE", $"{at}/params/{pn}", $"rest-consume: input '{pn}' of '{mn}' has type '{pt}': a URL value is one of {string.Join(", ", ParamTypes)}", "\"params\": {\"" + pn + "\": \"Text\"}"));
            if (m["sample"] is { } sample && SampleNode(sample) == null)
                problems.Add(new("REST_CONSUME_SAMPLE_INVALID", at + "/sample", $"rest-consume: sample of '{mn}' is a JSON text that does not parse", "the response as JSON (object, array or value), or as its JSON text"));
            if (m["request"] is { } request)
            {
                if (verb == "GET") problems.Add(new("REST_CONSUME_BODY_ON_GET", at + "/request", $"rest-consume: method '{mn}' is GET and has a request body", "drop request, or use \"verb\": \"POST\""));
                if (SampleNode(request) is not (JsonObject { Count: > 0 } or JsonArray { Count: > 0 }))
                    problems.Add(new("REST_CONSUME_SAMPLE_INVALID", at + "/request", $"rest-consume: request of '{mn}' is the JSON body sent: an object or array with one example of each field", "\"request\": {\"title\": \"x\", \"qty\": 1}"));
            }
            if (m["sample"] == null && verb == "GET")
                problems.Add(authenticated
                    ? new("REST_CONSUME_SAMPLE_MISSING", at + "/sample", $"rest-consume: method '{mn}' has no sample and the API is authenticated (auth {AuthType(data)}): the sampler never sends credentials and the kernel never reads the network",
                        "give \"sample\": <the JSON response> (from the API's documentation or a call made with the credentials)")
                    : new("REST_CONSUME_SAMPLE_MISSING", at + "/sample", $"rest-consume: method '{mn}' has no sample and the kernel never reads the network; o11_deliver, studio_deliver and the job tools GET the url once and pin the sample before the job runs",
                        "deliver through o11_deliver/studio_deliver/ssam_job (they sample the url), or give \"sample\": <the JSON response>"));
            ValidateMethodCustomization(m, at, mn, m["url"] is JsonValue cu && cu.TryGetValue<string>(out var curl) && ParseUrl(curl, baseUrl) is { Problem: null } cp ? cp : null, problems);
        }
        if (problems.Count == 0)
        {
            var parsed = methods.OfType<JsonObject>().Select(m => ParseUrl(m["url"]!.ToString(), baseUrl)).ToList();
            if (baseUrl == null && parsed.Select(p => p.Origin!.ToLowerInvariant()).Distinct().Count() > 1)
                problems.Add(new("REST_CONSUME_HOSTS_DIFFER", "/data/methods", "rest-consume: the urls name " + string.Join(", ", parsed.Select(p => p.Origin).Distinct()) + "; one REST client is one host",
                    "one rest-consume op per host (each with its own name)"));
            for (var i = 0; i < parsed.Count; i++)
                if (parsed[i].OutsideBase) problems.Add(new("REST_CONSUME_URL_OUTSIDE_BASE", $"/data/methods/{i}/url", $"rest-consume: url '{methods[i]!["url"]}' does not start with baseUrl '{baseUrl}'",
                    "a path relative to baseUrl (\"/items\"), or drop baseUrl"));
        }
        return problems;
    }

    private static void Closed(JsonObject o, string[] allowed, string at, string what, List<IntegrationProblem> problems)
    {
        foreach (var key in o.Select(p => p.Key).Where(k => !allowed.Contains(k, StringComparer.Ordinal) && !k.StartsWith('_')))
        {
            var near = allowed.FirstOrDefault(a => a.Equals(key, StringComparison.OrdinalIgnoreCase) || (key.Length > 3 && a.StartsWith(key[..3], StringComparison.OrdinalIgnoreCase)));
            problems.Add(new("REST_CONSUME_UNKNOWN_KEYS", at + "/" + key, $"rest-consume: {what} has unknown key '{key}'", (near != null ? $"did you mean '{near}'? " : "") + "use only: " + string.Join(", ", allowed)));
        }
    }

    /// <summary>The sample as JSON: a node, or its JSON text parsed; null when the text does not parse.</summary>
    public static JsonNode? SampleNode(JsonNode? sample)
    {
        if (sample is JsonValue v && v.TryGetValue<string>(out var text))
        {
            var trimmed = text.TrimStart();
            if (trimmed.StartsWith('{') || trimmed.StartsWith('[') || trimmed.StartsWith('"'))
                try { return JsonNode.Parse(text); } catch (JsonException) { return null; }
            return sample; // a JSON string scalar (a plain-text response)
        }
        return sample;
    }

    // ---- URLs -----------------------------------------------------------------------------------------------------------

    public sealed record UrlParam(string Name, string? Example, bool Query, bool Mandatory, string? Default, string? OriginalName, bool Header = false);
    public sealed record ParsedUrl(string? Origin, List<string> Segments, List<UrlParam> Params, string? Problem, bool OutsideBase = false, string? BasePath = null);

    private static bool TryAbsolute(string url, out string origin, out string path, out string query)
    {
        origin = path = query = "";
        var m = Regex.Match(url.Trim(), @"^(https?)://([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?$", RegexOptions.IgnoreCase);
        if (!m.Success) return false;
        origin = m.Groups[1].Value.ToLowerInvariant() + "://" + m.Groups[2].Value;
        path = m.Groups[3].Value;
        query = m.Groups[4].Value.TrimStart('?');
        return true;
    }

    /// <summary>A method url: absolute (origin, path segments) or relative to baseUrl; {p}/{p=example} path inputs and the
    /// query's inputs (k=v optional with default v, k={p} mandatory).</summary>
    public static ParsedUrl ParseUrl(string url, string? baseUrl)
    {
        url = url.Trim();
        string? origin = null; string path; string query;
        var outside = false;
        string? basePath = null;
        if (Regex.IsMatch(url, "^https?://", RegexOptions.IgnoreCase))
        {
            var protectedUrl = Placeholder.Replace(url, m => "\u0001" + m.Value[1..^1].Replace("/", "\u0002") + "\u0003");
            if (!TryAbsolute(protectedUrl, out var o, out var p, out var q)) return new(null, [], [], "not an http(s) URL");
            origin = o; path = Unprotect(p); query = Unprotect(q);
            if (baseUrl != null && TryAbsolute(baseUrl, out var bo, out var bp, out _))
            {
                var prefix = bp.TrimEnd('/');
                if (!string.Equals(bo, origin, StringComparison.OrdinalIgnoreCase) || !(path.Equals(prefix, StringComparison.Ordinal) || path.StartsWith(prefix + "/", StringComparison.Ordinal)))
                    outside = true;
                else { path = path[prefix.Length..]; basePath = prefix; }
            }
        }
        else
        {
            var qi = url.IndexOf('?');
            path = qi >= 0 ? url[..qi] : url; query = qi >= 0 ? url[(qi + 1)..] : "";
            if (!path.StartsWith('/')) path = "/" + path;
            if (baseUrl != null && TryAbsolute(baseUrl, out var bo, out var bp, out _)) { origin = bo; basePath = bp.TrimEnd('/'); }
        }
        var depth = 0;
        foreach (var c in path + query)
        {
            if (c == '{' && ++depth > 1) return new(origin, [], [], "nested braces");
            if (c == '}' && --depth < 0) return new(origin, [], [], "a '}' closes nothing");
        }
        if (depth != 0) return new(origin, [], [], "a '{' is not closed");
        var parameters = new List<UrlParam>();
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries).ToList();
        foreach (Match m in Placeholder.Matches(path))
        {
            var name = m.Groups[1].Value.Trim();
            if (name.Length == 0) return new(origin, [], [], "{} names no input");
            if (parameters.Any(p => p.Name == name)) return new(origin, [], [], $"{{{name}}} appears twice");
            parameters.Add(new(name, m.Groups[2].Success ? Uri.UnescapeDataString(m.Groups[2].Value) : null, false, true, null, null));
        }
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            var key = Uri.UnescapeDataString(eq >= 0 ? pair[..eq] : pair);
            var value = eq >= 0 ? pair[(eq + 1)..] : "";
            if (key.Length == 0) return new(origin, [], [], "a query parameter without a name");
            var ph = Placeholder.Match(value);
            if (ph.Success && ph.Index == 0 && ph.Length == value.Length)
            {
                var name = ph.Groups[1].Value.Trim();
                if (parameters.Any(p => p.Name == name)) return new(origin, [], [], $"{{{name}}} appears twice");
                parameters.Add(new(name, ph.Groups[2].Success ? Uri.UnescapeDataString(ph.Groups[2].Value) : null, true, true, null, key));
            }
            else
            {
                if (value.Contains('{')) return new(origin, [], [], $"query value '{value}' mixes text and an input");
                var literal = Uri.UnescapeDataString(value.Replace('+', ' '));
                if (parameters.Any(p => p.Name == key)) return new(origin, [], [], $"query parameter '{key}' appears twice");
                parameters.Add(new(key, literal, true, false, literal, key));
            }
        }
        return new(origin, segments, parameters, null, outside, basePath);
    }

    private static string Unprotect(string text) => text.Replace('\u0001', '{').Replace('\u0003', '}').Replace('\u0002', '/');

    /// <summary>The client's base URL and each method's path (placeholders without examples, query left to the inputs).</summary>
    public static (string BaseUrl, List<List<string>> Paths) BaseAndPaths(string? baseUrl, List<ParsedUrl> urls)
    {
        if (baseUrl != null) return (baseUrl.TrimEnd('/'), urls.Select(u => u.Segments).ToList());
        var origin = urls[0].Origin!;
        var common = urls.Select(u => u.Segments.TakeWhile(s => !s.Contains('{')).Count()).Min();
        common = Math.Min(common, urls.Select(u => u.Segments.Count - 1).Min());
        var prefix = new List<string>();
        for (var i = 0; i < Math.Max(common, 0); i++)
        {
            var s = urls[0].Segments[i];
            if (urls.All(u => u.Segments[i] == s)) prefix.Add(s); else break;
        }
        return (origin + (prefix.Count > 0 ? "/" + string.Join("/", prefix) : ""), urls.Select(u => u.Segments.Skip(prefix.Count).ToList()).ToList());
    }

    // ---- JSON shapes ----------------------------------------------------------------------------------------------------

    public abstract class Shape { }
    public sealed class UnknownShape : Shape { public static readonly UnknownShape Instance = new(); }
    public sealed class ScalarShape(string type, bool conflict = false) : Shape { public string Type { get; } = type; public bool Conflict { get; } = conflict; }
    public sealed class ArrayShape(Shape item) : Shape { public Shape Item { get; } = item; }
    public sealed class ObjectShape : Shape { public List<KeyValuePair<string, Shape>> Fields { get; } = []; }

    public static Shape Infer(JsonNode? node)
    {
        switch (node)
        {
            case null: return UnknownShape.Instance;
            case JsonObject o:
                var shape = new ObjectShape();
                foreach (var (key, value) in o) shape.Fields.Add(new(key, Infer(value)));
                return shape;
            case JsonArray a:
                Shape item = UnknownShape.Instance;
                foreach (var e in a) item = Merge(item, Infer(e));
                return new ArrayShape(item);
            case JsonValue v:
                var element = v.GetValue<JsonElement>();
                return element.ValueKind switch
                {
                    JsonValueKind.True or JsonValueKind.False => new ScalarShape("Boolean"),
                    JsonValueKind.Number => new ScalarShape(NumberType(element.GetRawText())),
                    JsonValueKind.String => new ScalarShape(StringType(element.GetString() ?? "")),
                    JsonValueKind.Null => UnknownShape.Instance,
                    _ => new ScalarShape("Text"),
                };
            default: return UnknownShape.Instance;
        }
    }

    private static string NumberType(string raw)
    {
        if (raw.Contains('.') || raw.Contains('e') || raw.Contains('E')) return "Decimal";
        if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)) return "Integer";
        if (long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)) return "Long Integer";
        return "Decimal";
    }

    private static string StringType(string s) => DateOnly.IsMatch(s) && DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _) ? "Date"
        : DateTimeIso.IsMatch(s) && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _) ? "Date Time" : "Text";

    /// <summary>The value type of a URL example (path or query): digits without a leading zero are numbers, true/false a
    /// Boolean, yyyy-MM-dd a Date, everything else Text (a code such as 01001000 or SP stays Text).</summary>
    public static string ExampleType(string? example)
    {
        if (string.IsNullOrEmpty(example)) return "Text";
        if (Regex.IsMatch(example, @"^-?(0|[1-9]\d{0,17})$")) return NumberType(example);
        if (Regex.IsMatch(example, @"^-?(0|[1-9]\d*)\.\d+$")) return "Decimal";
        if (example is "true" or "false") return "Boolean";
        if (DateOnly.IsMatch(example)) return "Date";
        return "Text";
    }

    public static Shape Merge(Shape a, Shape b)
    {
        if (a is UnknownShape) return b;
        if (b is UnknownShape) return a;
        if (a is ScalarShape sa && b is ScalarShape sb) return MergeScalar(sa, sb);
        if (a is ArrayShape aa && b is ArrayShape ab) return new ArrayShape(Merge(aa.Item, ab.Item));
        if (a is ObjectShape oa && b is ObjectShape ob)
        {
            var merged = new ObjectShape();
            foreach (var field in oa.Fields)
            {
                var other = ob.Fields.FirstOrDefault(f => f.Key == field.Key);
                merged.Fields.Add(new(field.Key, other.Key == null ? field.Value : Merge(field.Value, other.Value)));
            }
            foreach (var field in ob.Fields.Where(f => oa.Fields.All(x => x.Key != f.Key))) merged.Fields.Add(field);
            return merged;
        }
        return new ScalarShape("Text", conflict: true);
    }

    private static ScalarShape MergeScalar(ScalarShape a, ScalarShape b)
    {
        if (a.Type == b.Type) return a.Conflict ? a : b;
        string[] numbers = ["Integer", "Long Integer", "Decimal"];
        var ia = System.Array.IndexOf(numbers, a.Type); var ib = System.Array.IndexOf(numbers, b.Type);
        if (ia >= 0 && ib >= 0) return new(numbers[Math.Max(ia, ib)]);
        if (a.Type is "Date" or "Date Time" && b.Type is "Date" or "Date Time") return new("Date Time");
        return new("Text", conflict: true);
    }

    // ---- names ----------------------------------------------------------------------------------------------------------

    /// <summary>An OutSystems name from any text: diacritics dropped, each run of other characters a word break (camel
    /// case), first letter upper; a digit first gets an N; a reserved word gets Value; at most 50 characters.</summary>
    public static string Sanitize(string? text, string fallback = "Field")
    {
        var plain = new string((text ?? "").Normalize(NormalizationForm.FormD).Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark).ToArray());
        var words = Regex.Split(plain, "[^A-Za-z0-9]+").Where(w => w.Length > 0).ToList();
        var name = string.Concat(words.Select(w => char.ToUpperInvariant(w[0]) + w[1..]));
        if (name.Length == 0) name = fallback;
        if (char.IsDigit(name[0])) name = "N" + name;
        if (Reserved.Contains(name)) name += "Value";
        return name.Length > NameMax ? name[..NameMax] : name;
    }

    /// <summary>The resource a method returns: the method name without a verb prefix (GetFeriados, ListarEstados: Feriados, Estados).</summary>
    public static string ResourceOf(string method)
    {
        var stripped = VerbPrefix.Replace(method, "");
        return stripped.Length > 0 && char.IsLetter(stripped[0]) ? char.ToUpperInvariant(stripped[0]) + stripped[1..] : method;
    }

    private static string Fit(string name, string suffix = "")
        => name.Length + suffix.Length > NameMax ? name[..(NameMax - suffix.Length)] + suffix : name + suffix;

    // ---- the plan (pure) --------------------------------------------------------------------------------------------------

    public sealed class AttributePlan
    {
        public string Name = "", Json = "";
        public string? Scalar;          // the type of a scalar (or of the items of a scalar list)
        public StructurePlan? Structure; // the structure of an object (or of the items of an object list)
        public bool List, Guessed;
        public string Signature => $"{Name}|{Json}|{(List ? "L:" : "")}{Scalar ?? "S:" + Structure!.Id}";
    }

    public sealed class StructurePlan
    {
        public int Id;
        public string Base = "";       // the public name the plan wants (the client one adds Json)
        public string Method = "";     // the method of its first appearance (descriptions)
        public string Path = "";       // the JSON path of its first appearance
        public bool Request;
        public List<AttributePlan> Attributes = [];
        public string Signature => string.Join(";", Attributes.Select(a => a.Signature).OrderBy(s => s, StringComparer.Ordinal));
    }

    public enum Body { None, Scalar, ScalarList, Record, RecordList, Raw }

    public sealed class MethodPlan
    {
        public int Index;
        public string Name = "", Http = "GET", Path = "", Resource = "", Action = "", Url = "";
        public List<(UrlParam Param, string Type, string RestName, string InputName)> Inputs = [];
        public Body Response, Request;
        public string? ResponseScalar, RequestScalar;
        public StructurePlan? ResponseStructure, RequestStructure;
        public int? Timeout;
        public string? Description;
        // Headers the method always sends (methods[].headers with a literal value): an input in:header the action fills.
        public List<(string RestName, string Header, string Literal)> Fixed = [];
    }

    public sealed class Plan
    {
        public string Client = "", BaseUrl = "", Exception = "", Lane = "o11";
        public string? Description, DateFormat;
        public bool Expose = true, ServiceActions = true, PublicActions = true, Guard = true;
        public List<MethodPlan> Methods = [];
        public List<StructurePlan> Structures = []; // dependency order: a structure comes after the ones its attributes use
        public List<JsonObject> Warnings = [];
        // Authentication and customization (RestConsume.Auth.cs).
        public string AuthType = "none";
        public string? ApiKeyIn, ApiKeyName, TokenUrl, Scope, CorrelationHeader;
        public JsonObject? CustomBefore, CustomAfter;
        public int TokenCacheMinutes = DefaultTokenCacheMinutes;
        public List<(string Name, string Value)> Headers = [];
        public bool BaseUrlSetting;
        public int Timeout = DefaultTimeout;
        public List<(int Status, string Exception)> StatusErrors = [];
        public List<Setting> Settings = [];
    }

    /// <summary>The plan of a valid op: URLs, inputs and their types, the structures of every sample (deduplicated by
    /// shape: the same attributes are one structure), and the names it wants (the handler resolves them in the module). The
    /// lane decides what a lane has (auth basic: O11 encodes the credentials with the BinaryData extension).</summary>
    public static Plan Build(JsonObject data, string lane = "o11")
    {
        var plan = new Plan
        {
            Lane = lane,
            Client = data["name"]!.ToString(),
            Description = data["description"]?.ToString(),
            DateFormat = data["dateFormat"]?.ToString(),
            Expose = !(data["expose"] is JsonValue ev && ev.TryGetValue<bool>(out var e) && !e),
            ServiceActions = !((data["expose"] as JsonObject)?["serviceActions"] is JsonValue sv && sv.TryGetValue<bool>(out var s) && !s),
            Guard = (data["expose"] as JsonObject)?["guard"]?.ToString() != "none",
        };
        plan.Exception = data["errors"]?["exception"]?.ToString() ?? Fit(plan.Client, "Error");
        var methods = data["methods"]!.AsArray().OfType<JsonObject>().ToList();
        var urls = methods.Select(m => ParseUrl(m["url"]!.ToString(), data["baseUrl"]?.ToString())).ToList();
        var (baseUrl, paths) = BaseAndPaths(data["baseUrl"]?.ToString(), urls);
        plan.BaseUrl = baseUrl;
        BuildCustomization(data, plan);
        var bySignature = new Dictionary<string, StructurePlan>(StringComparer.Ordinal);
        var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < methods.Count; i++)
        {
            var m = methods[i];
            var method = new MethodPlan
            {
                Index = i, Name = m["name"]!.ToString(), Http = (m["verb"]?.ToString() ?? "GET").ToUpperInvariant(),
                Timeout = m["timeout"]?.GetValue<int>(), Description = m["description"]?.ToString(),
                Url = Placeholder.Replace(m["url"]!.ToString().Trim(), x => "{" + x.Groups[1].Value.Trim() + "}"),
            };
            if (!Regex.IsMatch(method.Url, "^https?://", RegexOptions.IgnoreCase)) method.Url = plan.BaseUrl + (method.Url.StartsWith('/') ? "" : "/") + method.Url;
            var explicitResource = m["resource"]?.ToString();
            method.Resource = explicitResource ?? ResourceOf(method.Name);
            method.Action = m["action"]?.ToString() ?? ActionName(plan.Client, method.Name, method.Http);
            var types = m["params"] as JsonObject;
            var tries = m["try"] as JsonObject;
            var inputNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Result", "Request" };
            var restNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Request", "Response" };
            var restOf = new Dictionary<string, string>(StringComparer.Ordinal);
            var optional = (m["optional"] as JsonArray)?.Select(x => x!.ToString()).ToHashSet(StringComparer.Ordinal) ?? [];
            foreach (var given in urls[i].Params)
            {
                // optional: a query input k={p} the caller may leave empty (not sent), its =v the default.
                var param = given.Query && given.Mandatory && optional.Contains(given.Name) ? given with { Mandatory = false, Default = given.Example } : given;
                var example = tries?[param.Name]?.ToString() ?? param.Example;
                var type = types?[param.Name] is { } t ? NormalizeType(t.ToString()) : ExampleType(example);
                var restName = Identifier.IsMatch(param.Name) ? Unique(param.Name, restNames) : Unique(Sanitize(param.Name, "Value"), restNames);
                restOf[param.Name] = restName;
                var inputName = Unique(type == "Boolean" ? BooleanName(Sanitize(param.Name, "Value")) : Sanitize(param.Name, "Value"), inputNames);
                method.Inputs.Add((param with { Example = example }, type, restName, inputName));
            }
            PlanHeaders(plan, method, m, types, tries, optional, inputNames, restNames);
            var pathSegments = paths[i].Select(segment => Placeholder.Replace(segment, x => "{" + restOf[x.Groups[1].Value.Trim()] + "}")).ToList();
            method.Path = "/" + string.Join("/", pathSegments);
            // A query key that is not an OutSystems name keeps its own spelling in the URL Path (?api-key={ApiKey}).
            var odd = method.Inputs.Where(x => x.Param.Query && x.RestName != x.Param.OriginalName).ToList();
            if (odd.Count > 0) method.Path += "?" + string.Join("&", odd.Select(x => Uri.EscapeDataString(x.Param.OriginalName!) + "={" + x.RestName + "}"));
            // The response.
            var sample = SampleNode(m["sample"]);
            if (m["sample"] != null) PlanBody(plan, method, sample, request: false, explicitResource != null, bySignature, wanted);
            if (m["request"] is { } request) PlanBody(plan, method, SampleNode(request), request: true, explicitResource != null, bySignature, wanted);
            plan.Methods.Add(method);
        }
        return plan;
    }

    private static readonly string[] BooleanPrefixes = ["Is", "Has", "Can"];

    /// <summary>A boolean's name as the owner's N1 wants it: Is/Has/Can and a capital (Fork: IsFork; IsActive stays).</summary>
    public static string BooleanName(string name)
        => BooleanPrefixes.Any(p => name.Length > p.Length && name.StartsWith(p, StringComparison.Ordinal) && (char.IsUpper(name[p.Length]) || char.IsDigit(name[p.Length]))) ? name : Fit("Is" + name);

    // The verbs a method name may already start with (all of them are verbs of the owner's N1 list).
    private static readonly HashSet<string> MethodVerbs = new(StringComparer.Ordinal) { "Get", "List", "Search", "Find", "Fetch", "Load", "Read", "Count", "Check",
        "Validate", "Create", "Add", "Update", "Delete", "Remove", "Send", "Save", "Post", "Put", "Patch", "Upload", "Download", "Submit", "Cancel", "Set",
        "Calculate", "Compute", "Convert", "Generate", "Sync", "Refresh", "Register", "Approve", "Reject", "Publish", "Import", "Export", "Verify", "Track" };

    /// <summary>The action of a method, Verb + Client + Object (N1): the method's own verb when its name starts with one
    /// (ListRepos of GitHub: ListGitHubRepos), else the verb of its HTTP method: GET Get, POST Send, PUT Save, PATCH Update,
    /// DELETE Delete (Feriados of BrasilApi: GetBrasilApiFeriados).</summary>
    public static string ActionName(string client, string method, string http)
    {
        var first = Regex.Match(method, "^[A-Z][a-z0-9]*").Value;
        if (first.Length > 0 && first.Length < method.Length && MethodVerbs.Contains(first)) return Fit(first + client + method[first.Length..]);
        if (first.Length > 0 && first.Length == method.Length && MethodVerbs.Contains(first)) return Fit(first + client);
        var verb = http switch { "POST" => "Send", "PUT" => "Save", "PATCH" => "Update", "DELETE" => "Delete", _ => "Get" };
        return Fit(verb + client + char.ToUpperInvariant(method[0]) + method[1..]);
    }

    private static string Unique(string name, HashSet<string> taken)
    {
        if (taken.Add(name)) return name;
        for (var n = 2; ; n++) { var next = Fit(name, n.ToString(CultureInfo.InvariantCulture)); if (taken.Add(next)) return next; }
    }

    public static string NormalizeType(string type) => type.Trim() switch
    {
        "LongInteger" or "Long" or "long" => "Long Integer", "DateTime" or "Datetime" => "Date Time", "Bool" or "bool" => "Boolean",
        "String" or "string" => "Text", "Int" or "int" => "Integer", var t => t,
    };

    private static void PlanBody(Plan plan, MethodPlan method, JsonNode? sample, bool request, bool explicitResource, Dictionary<string, StructurePlan> bySignature, HashSet<string> wanted)
    {
        var shape = Infer(sample);
        var root = request ? method.Resource + "Request" : method.Resource + (shape is ArrayShape { Item: ObjectShape } && !explicitResource ? "Item" : "");
        var at = $"/data/methods/{method.Index}/{(request ? "request" : "sample")}";
        Body kind; string? scalar = null; StructurePlan? structure = null;
        switch (shape)
        {
            case ObjectShape { Fields.Count: > 0 } o:
                kind = Body.Record; structure = Structure(plan, method, o, root, "", request, bySignature, wanted, at); break;
            case ArrayShape { Item: ObjectShape { Fields.Count: > 0 } io }:
                kind = Body.RecordList; structure = Structure(plan, method, io, root, "[]", request, bySignature, wanted, at); break;
            case ArrayShape { Item: ScalarShape s }:
                kind = Body.ScalarList; scalar = s.Type;
                if (s.Conflict) Warn(plan, "REST_CONSUME_TYPE_GUESSED", at, $"{method.Name}: the items of the {(request ? "request" : "response")} mix types: Text List");
                break;
            case ArrayShape { Item: UnknownShape }:
                kind = Body.ScalarList; scalar = "Text";
                Warn(plan, "REST_CONSUME_TYPE_GUESSED", at, $"{method.Name}: the {(request ? "request" : "response")} sample is an empty list: Text List (give a sample with one item to type it)");
                break;
            case ScalarShape s:
                kind = Body.Scalar; scalar = s.Type; break;
            case UnknownShape:
                kind = Body.Raw;
                Warn(plan, "REST_CONSUME_TYPE_GUESSED", at, $"{method.Name}: the {(request ? "request" : "response")} sample is null: the body is read as Text");
                break;
            default:
                kind = Body.Raw;
                Warn(plan, "REST_CONSUME_RAW_BODY", at, $"{method.Name}: the {(request ? "request" : "response")} is {(shape is ArrayShape ? "a list of lists" : "an empty object")}, which no structure holds: the body is read as Text (the JSON text)");
                break;
        }
        if (request) { method.Request = kind; method.RequestScalar = scalar; method.RequestStructure = structure; }
        else { method.Response = kind; method.ResponseScalar = scalar; method.ResponseStructure = structure; }
    }

    private static StructurePlan Structure(Plan plan, MethodPlan method, ObjectShape shape, string name, string path, bool request,
        Dictionary<string, StructurePlan> bySignature, HashSet<string> wanted, string at)
    {
        var structure = new StructurePlan { Base = name, Method = method.Name, Path = path.Length == 0 ? "$" : "$" + path, Request = request };
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, fieldShape) in shape.Fields)
        {
            var attribute = new AttributePlan { Json = key };
            var childPath = path + "." + key;
            var childName = Fit(method.Resource + (request ? "Request" : "") + string.Concat(childPath.Replace("[]", "").Split('.', StringSplitOptions.RemoveEmptyEntries).Select(k => Sanitize(k))));
            var value = fieldShape;
            if (value is ArrayShape array)
            {
                attribute.List = true;
                value = array.Item;
                if (value is ArrayShape)
                {
                    Warn(plan, "REST_CONSUME_FIELD_OMITTED", at, $"{method.Name}: {childPath.TrimStart('.')} is a list of lists, which no OutSystems type holds: left out of {name} (the JSON reader skips it)");
                    continue;
                }
            }
            switch (value)
            {
                case ObjectShape { Fields.Count: > 0 } child:
                    attribute.Structure = Structure(plan, method, child, childName, childPath + (attribute.List ? "[]" : ""), request, bySignature, wanted, at); break;
                case ObjectShape:
                    Warn(plan, "REST_CONSUME_FIELD_OMITTED", at, $"{method.Name}: {childPath.TrimStart('.')} is always an empty object in the sample: left out of {name}");
                    continue;
                case ScalarShape s:
                    attribute.Scalar = s.Type;
                    if (s.Conflict) { attribute.Guessed = true; Warn(plan, "REST_CONSUME_TYPE_GUESSED", at, $"{method.Name}: {childPath.TrimStart('.')} mixes types in the sample: Text"); }
                    break;
                default:
                    attribute.Scalar = "Text"; attribute.Guessed = true;
                    Warn(plan, "REST_CONSUME_TYPE_GUESSED", at, $"{method.Name}: {childPath.TrimStart('.')} is {(attribute.List ? "an empty list" : "null")} in the sample: {(attribute.List ? "Text List" : "Text")} (a sample where it has a value types it)");
                    break;
            }
            // N1 of the owner's rules: a boolean is named Is/Has/Can (the JSON key stays its NameInJSON).
            attribute.Name = Unique(attribute.Scalar == "Boolean" && !attribute.List ? BooleanName(Sanitize(key)) : Sanitize(key), names);
            structure.Attributes.Add(attribute);
        }
        if (bySignature.TryGetValue(structure.Signature, out var same)) return same;
        structure.Id = plan.Structures.Count;
        structure.Base = UniqueWanted(structure.Base, wanted);
        bySignature[structure.Signature] = structure;
        plan.Structures.Add(structure);
        return structure;
    }

    private static string UniqueWanted(string name, HashSet<string> wanted)
    {
        // The client mirror adds Json: both spellings are kept free inside the op.
        for (var n = 1; ; n++)
        {
            var candidate = n == 1 ? Fit(name, "") : Fit(name, n.ToString(CultureInfo.InvariantCulture));
            if (wanted.Contains(candidate) || wanted.Contains(Fit(candidate, "Json"))) continue;
            wanted.Add(candidate); wanted.Add(Fit(candidate, "Json"));
            return candidate;
        }
    }

    private static void Warn(Plan plan, string code, string at, string message)
        => plan.Warnings.Add(new JsonObject { ["code"] = code, ["path"] = at, ["message"] = message });

    // ---- the generated elements (after the handler named them) ------------------------------------------------------------

    /// <summary>The names the module gives each wanted name (the handler: own elements keep theirs, taken names move on).</summary>
    public sealed class Names
    {
        public string Client = "", Exception = "", AccessDenied = "AccessDenied";
        public Dictionary<int, string> Public = [], ClientStructures = [];
        public Dictionary<string, string> Methods = new(StringComparer.Ordinal), Actions = new(StringComparer.Ordinal), Impls = new(StringComparer.Ordinal), Functions = new(StringComparer.Ordinal);
        // RestConsume.Auth.cs: the settings by planned name, the exceptions of mapped statuses, the callback structures of
        // the client (canonical name -> "@key" and -> the name it has), the token client (oauth2).
        public Dictionary<string, string> Settings = new(StringComparer.Ordinal), StatusExceptions = new(StringComparer.Ordinal),
            CallbackTypes = new(StringComparer.Ordinal), CallbackTypeNames = new(StringComparer.Ordinal);
        public string AuthClient = "", TokenStructure = "", TokenMethod = "", TokenAction = "";
    }

    public static string Hash(JsonNode node) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Generator + "\n" + node.ToJsonString()))).ToLowerInvariant()[..8];

    public static string Marker(string client, string? element, string hash) => MarkerPrefix + client + (element != null ? "/" + element : "") + " #" + hash;

    private static readonly Regex MarkerPattern = new(@"ssam:rest-consume (?<client>[A-Za-z_][A-Za-z0-9_]*)(?:/(?<element>[A-Za-z_][A-Za-z0-9_]*))? #(?<hash>[0-9a-f]{8})", RegexOptions.Compiled);

    /// <summary>The marker of a description: (client, element or null, hash), or null.</summary>
    public static (string Client, string? Element, string Hash)? ReadMarker(string? description)
    {
        var m = description == null ? Match.Empty : MarkerPattern.Match(description);
        return m.Success ? (m.Groups["client"].Value, m.Groups["element"].Success ? m.Groups["element"].Value : null, m.Groups["hash"].Value) : null;
    }

    private static string WithMarker(string text, string marker) => text.TrimEnd() + "\n" + marker;

    private static string TypeOf(AttributePlan a, Dictionary<int, string> names)
        => (a.Structure != null ? names[a.Structure.Id] : a.Scalar!) + (a.List ? " List" : "");

    /// <summary>The data of the op `rest` that writes the client (without the client's marker: the hash covers it).</summary>
    public static JsonObject RestData(Plan plan, Names names)
    {
        var structures = new JsonArray();
        foreach (var s in plan.Structures)
        {
            var attributes = new JsonArray(s.Attributes.Select(a => (JsonNode)new JsonObject
            {
                ["name"] = a.Name, ["type"] = TypeOf(a, names.ClientStructures), ["json"] = a.Json,
                ["description"] = $"\"{a.Json}\" in the JSON of {plan.Client}.{s.Method}" + (a.Guessed ? " (typed from a null or empty sample value)" : "") + ".",
            }).ToArray());
            structures.Add(new JsonObject
            {
                ["name"] = names.ClientStructures[s.Id],
                ["description"] = WithMarker($"JSON shape of {s.Path} {(s.Request ? "sent to" : "returned by")} {plan.Client}.{s.Method}, inferred from the sample.", Marker(plan.Client, s.Base + "Json", "00000000")),
                ["attributes"] = attributes,
            });
        }
        var methods = new JsonArray();
        foreach (var m in plan.Methods)
        {
            var inputs = new JsonArray();
            foreach (var (param, type, restName, _) in m.Inputs)
            {
                var input = new JsonObject { ["name"] = restName, ["type"] = type };
                if (param.Header)
                {
                    input["in"] = "header"; input["originalName"] = param.OriginalName; input["mandatory"] = param.Mandatory;
                    input["description"] = $"Header \"{param.OriginalName}\"" + (param.Mandatory ? "." : " (optional: not sent when empty).");
                    inputs.Add(input);
                    continue;
                }
                var odd = param.Query && restName != param.OriginalName;
                input["in"] = param.Query && !odd ? "query" : "url";
                input["mandatory"] = param.Mandatory || odd;
                input["description"] = param.Query ? $"Query parameter \"{param.OriginalName}\"" + (param.Default != null ? $" (default \"{param.Default}\")." : ".") : $"Path parameter {{{param.Name}}}.";
                inputs.Add(input);
            }
            foreach (var (restName, header, literal) in m.Fixed)
                inputs.Add(new JsonObject { ["name"] = restName, ["type"] = "Text", ["in"] = "header", ["originalName"] = header, ["mandatory"] = true, ["description"] = $"Header \"{header}\": always \"{literal}\" (the action sends it)." });
            if (m.Request != Body.None) inputs.Add(new JsonObject { ["name"] = "Request", ["type"] = BodyType(m.Request, m.RequestScalar, m.RequestStructure, names.ClientStructures), ["in"] = "body", ["description"] = "The JSON body sent." });
            var method = new JsonObject
            {
                ["name"] = names.Methods[m.Name], ["http"] = m.Http, ["path"] = m.Path,
                ["description"] = WithMarker(m.Description ?? $"{m.Http} {m.Url}", Marker(plan.Client, m.Name, "00000000")),
            };
            if ((m.Timeout ?? (plan.Timeout > 0 ? plan.Timeout : null)) is { } timeout) method["timeout"] = timeout;
            if (inputs.Count > 0) method["inputs"] = inputs;
            if (m.Response != Body.None)
                method["outputs"] = new JsonArray(new JsonObject { ["name"] = "Response", ["type"] = BodyType(m.Response, m.ResponseScalar, m.ResponseStructure, names.ClientStructures, wire: true), ["in"] = "body", ["description"] = m.Response == Body.Scalar ? "The response: one JSON value, read as its text." : "The JSON response." });
            methods.Add(method);
        }
        var client = new JsonObject { ["name"] = names.Client, ["baseUrl"] = plan.BaseUrl };
        if (plan.DateFormat != null) client["dateFormat"] = plan.DateFormat;
        var data = new JsonObject { ["client"] = client, ["methods"] = methods };
        if (structures.Count > 0) data["structures"] = structures;
        return data;
    }

    // A response that is one JSON value: the platform reads a JSON body only into a structure or a list, so the client reads
    // its text (PlainText) and the action converts a number or a boolean; any other value stays the text.
    private static string BodyType(Body body, string? scalar, StructurePlan? structure, Dictionary<int, string> names, bool wire = false) => body switch
    {
        Body.Record => names[structure!.Id], Body.RecordList => names[structure!.Id] + " List",
        Body.Scalar => wire ? "Text" : ScalarResult(scalar!), Body.ScalarList => scalar! + " List", _ => "Text",
    };

    /// <summary>The type of the REST method's Response (wire) and of the action's Result (public), or null without a body.</summary>
    public static string? ResponseType(MethodPlan m, Names names, bool wire)
        => m.Response == Body.None ? null : BodyType(m.Response, m.ResponseScalar, m.ResponseStructure, wire ? names.ClientStructures : names.Public, wire);

    private static string ScalarResult(string scalar) => scalar is "Integer" or "Long Integer" or "Decimal" or "Boolean" ? scalar : "Text";

    private static string ScalarValue(string scalar, string text) => scalar switch
    {
        "Integer" => $"TextToInteger(Trim({text}))", "Long Integer" => $"TextToLongInteger(Trim({text}))", "Decimal" => $"TextToDecimal(Trim({text}))",
        "Boolean" => $"ToLower(Trim({text})) = \"true\"", _ => text,
    };

    /// <summary>The client description with its marker: the hash of everything the op rest writes.</summary>
    public static string ClientDescription(Plan plan, string hash)
        => WithMarker(plan.Description ?? $"REST API {plan.BaseUrl}: methods, inputs and response structures generated from URLs and JSON samples.", Marker(plan.Client, null, hash));

    /// <summary>The public structures, each with its attributes (name, type, json, description) and its hash.</summary>
    public static List<(StructurePlan Plan, string Name, string Description, List<(string Name, string Type, string Json, string Description)> Attributes, string Hash)> PublicStructures(Plan plan, Names names)
    {
        var list = new List<(StructurePlan, string, string, List<(string, string, string, string)>, string)>();
        foreach (var s in plan.Structures)
        {
            var attributes = s.Attributes.Select(a => (a.Name, TypeOf(a, names.Public), a.Json, $"{a.Json} in the JSON of {plan.Client}.{s.Method}.")).ToList();
            var text = $"Public copy of {s.Path} {(s.Request ? "sent to" : "returned by")} {plan.Client}.{s.Method} (the client's {names.ClientStructures[s.Id]}).";
            var hash = Hash(new JsonObject { ["name"] = names.Public[s.Id], ["description"] = text, ["attributes"] = new JsonArray(attributes.Select(a => (JsonNode)new JsonArray(a.Item1, a.Item2, a.Item3, a.Item4)).ToArray()) });
            list.Add((s, names.Public[s.Id], WithMarker(text, Marker(plan.Client, s.Base, hash)), attributes, hash));
        }
        return list;
    }

    /// <summary>The logic declarations of a method, each with its hash (marker included), planned name and kind: its public
    /// action (service, or public server); when it changes data, that entry first and the private &lt;Action&gt;_Impl it calls.</summary>
    public static List<(JsonObject Declaration, string Hash, string Planned, string Kind)> Action(Plan plan, MethodPlan m, Names names)
    {
        var restMethod = names.Methods[m.Name];
        var node = m.Inputs.Any(i => i.InputName.Equals(restMethod, StringComparison.OrdinalIgnoreCase)) ? Fit("Call" + restMethod) : restMethod;
        var inputs = new JsonArray();
        var args = new JsonObject();
        foreach (var (param, type, restName, inputName) in m.Inputs)
        {
            var input = new JsonObject { ["name"] = inputName, ["type"] = type };
            if (!param.Mandatory)
            {
                input["mandatory"] = false;
                if (!string.IsNullOrEmpty(param.Default)) input["default"] = Literal(type, param.Default!);
            }
            input["description"] = param.Header ? $"Header \"{param.OriginalName}\" of the request" + (param.Mandatory ? "." : " (optional: not sent when empty).")
                : param.Query ? $"Query parameter \"{param.OriginalName}\" of the URL" + (param.Default != null ? $" (default \"{param.Default}\")." : ".") : $"The {{{param.Name}}} of the URL path.";
            inputs.Add(input);
            args[restName] = inputName;
        }
        foreach (var (restName, _, literal) in m.Fixed) args[restName] = Literal("Text", literal);
        var vars = new JsonArray();
        var steps = new JsonArray();
        if (m.Request != Body.None)
        {
            var requestType = BodyType(m.Request, m.RequestScalar, m.RequestStructure, names.Public);
            inputs.Add(new JsonObject { ["name"] = "Request", ["type"] = requestType, ["description"] = "The body sent, as the public structure." });
            if (m.Request == Body.RecordList)
            {
                vars.Add(new JsonObject { ["name"] = "RequestBody", ["type"] = BodyType(m.Request, null, m.RequestStructure, names.ClientStructures), ["description"] = "The body in the client's structure." });
                steps.Add(new JsonObject { ["call"] = "ListAppendAll", ["as"] = "MapRequest", ["args"] = new JsonObject { ["List"] = "RequestBody", ["SourceList"] = Mapped("Request", m.RequestStructure!, toClient: true, names) } });
                args["Request"] = "RequestBody";
            }
            else args["Request"] = m.Request == Body.Record ? Mapped("Request", m.RequestStructure!, toClient: true, names) : "Request";
        }
        var call = new JsonObject { ["call"] = "IRestAction:" + restMethod, ["as"] = node };
        if (args.Count > 0) call["args"] = args;
        steps.Add(call);
        var outputs = new JsonArray();
        var result = ResultName(m);
        if (m.Response != Body.None)
        {
            var resultType = BodyType(m.Response, m.ResponseScalar, m.ResponseStructure, names.Public);
            outputs.Add(new JsonObject { ["name"] = result, ["type"] = resultType, ["description"] = $"The response of {m.Http} {m.Url}" + (m.ResponseStructure != null ? $", as the public {names.Public[m.ResponseStructure.Id]}." : ".") });
            if (m.Response == Body.RecordList)
                steps.Add(new JsonObject { ["call"] = "ListAppendAll", ["as"] = "MapResult", ["args"] = new JsonObject { ["List"] = result, ["SourceList"] = Mapped(node + ".Response", m.ResponseStructure!, toClient: false, names) } });
            else steps.Add(new JsonObject { ["assign"] = new JsonObject { [result] = m.Response switch
            {
                Body.Record => Mapped(node + ".Response", m.ResponseStructure!, toClient: false, names),
                Body.Scalar => ScalarValue(m.ResponseScalar!, node + ".Response"),
                _ => node + ".Response",
            } }, ["label"] = "Return the response" });
        }
        var guarded = Guarded(plan, m, restMethod);
        var core = new JsonObject
        {
            ["name"] = guarded ? names.Impls[m.Name] : names.Actions[m.Name],
            ["kind"] = guarded ? "server" : plan.ServiceActions ? "service" : "server", ["public"] = !guarded && plan.PublicActions,
            ["description"] = $"Calls {m.Http} {m.Url} ({names.Client}.{restMethod})" + (m.Response != Body.None ? $" and returns the response in {result}" : "")
                + string.Concat(plan.StatusErrors.Select(s => $"; HTTP {s.Status} raises {names.StatusExceptions[s.Exception]}"))
                + $"; any {(plan.StatusErrors.Count > 0 ? "other " : "")}failure (HTTP error, timeout, unreadable response) raises {names.Exception}, logged."
                + (guarded ? $" Called only by {names.Actions[m.Name]}, which checks the caller first." : ""),
        };
        if (inputs.Count > 0) core["inputs"] = inputs;
        if (outputs.Count > 0) core["outputs"] = outputs;
        if (vars.Count > 0) core["vars"] = vars;
        core["steps"] = steps;
        // A mapped status keeps its own exception (OnAfterResponse raises it inside the call); the rest becomes the client's.
        core["handlers"] = new JsonArray(StatusHandlers(plan, names).Append(new JsonObject
        {
            ["name"] = "AllExceptions", ["exception"] = "AllExceptions", ["abortTransaction"] = true, ["logError"] = true,
            ["steps"] = new JsonArray(new JsonObject { ["raise"] = names.Exception, ["message"] = $"\"{names.Client}.{restMethod} failed: \" + AllExceptions.ExceptionMessage" }),
        }).Select(h => (JsonNode)h).ToArray());
        var list = new List<(JsonObject, string, string, string)>();
        list.Add(Marked(core, plan.Client, guarded ? m.Action + "_Impl" : m.Action, guarded ? "IServerAction" : plan.ServiceActions ? "IServiceAction" : "IServerAction"));
        if (!guarded) return list;
        // AR2 of the owner's rules: a public entry that changes data checks the caller on the server before it; the check lives
        // where no AllExceptions catches it (the entry), the call and its handler in the private _Impl.
        var impl = names.Impls[m.Name];
        var entrySteps = new JsonArray(
            new JsonObject
            {
                // ODC: the user identifier is a text one (GetUserId() = NullIdentifier() is ExpressionComparingDifferentIdentifiers).
                ["if"] = plan.Lane == "odc" ? "GetUserId() = NullTextIdentifier()" : "GetUserId() = NullIdentifier()", ["label"] = "Is the caller anonymous?",
                ["then"] = new JsonArray(new JsonObject { ["raise"] = names.AccessDenied, ["message"] = $"\"{names.Actions[m.Name]} changes data in {names.Client}: it needs a signed-in user.\"" }),
            },
            new JsonObject { ["call"] = impl, ["as"] = impl, ["args"] = new JsonObject(m.Inputs.Select(i => KeyValuePair.Create(i.InputName, (JsonNode?)JsonValue.Create(i.InputName)))
                .Concat(m.Request != Body.None ? [KeyValuePair.Create("Request", (JsonNode?)JsonValue.Create("Request"))] : [])) });
        if (m.Response != Body.None) entrySteps.Add(new JsonObject { ["assign"] = new JsonObject { [result] = impl + "." + result }, ["label"] = "Return the response" });
        var entry = new JsonObject
        {
            ["name"] = names.Actions[m.Name], ["kind"] = plan.ServiceActions ? "service" : "server", ["public"] = plan.PublicActions,
            ["description"] = $"Checks that a user is signed in (it changes data in {names.Client}: {m.Http} {m.Url}), then calls {impl}"
                + (m.Response != Body.None ? $" and returns its {result}" : "") + $"; raises {names.AccessDenied} without a user and {names.Exception} when the call fails.",
        };
        if (inputs.Count > 0) entry["inputs"] = inputs.DeepClone();
        if (outputs.Count > 0) entry["outputs"] = outputs.DeepClone();
        entry["steps"] = entrySteps;
        list.Insert(0, Marked(entry, plan.Client, m.Action, plan.ServiceActions ? "IServiceAction" : "IServerAction"));
        return list;
    }

    private static (JsonObject Declaration, string Hash, string Planned, string Kind) Marked(JsonObject declaration, string client, string planned, string kind)
    {
        var hash = Hash(declaration);
        declaration["description"] = WithMarker(declaration["description"]!.ToString(), Marker(client, planned, hash));
        return (declaration, hash, planned, kind);
    }

    /// <summary>The output of a method's action: Result, IsResult for a single boolean value (N1).</summary>
    public static string ResultName(MethodPlan m) => m.Response == Body.Scalar && m.ResponseScalar == "Boolean" ? "IsResult" : "Result";

    private static readonly Regex WriteName = new("^(CreateOrUpdate|Create|Update|Delete)[A-Z]", RegexOptions.Compiled);

    /// <summary>Whether the action of a method checks the caller first (AR2): it changes data (any verb but GET, or a REST
    /// method named as a write), unless the op says expose.guard "none".</summary>
    public static bool Guarded(Plan plan, MethodPlan m, string restMethod) => plan.Guard && (m.Http != "GET" || WriteName.IsMatch(restMethod));

    // ---- the mapping --------------------------------------------------------------------------------------------------------

    /// <summary>The value with its record mapping written out: every attribute from its namesake, a nested record attribute
    /// by attribute (R.A: R.A, the platform's own flattening of a mapping), a list of records through the mapping function
    /// of its structure. The platform's automatic conversion leaves some shapes empty (a nested record with the same
    /// attributes as its parent: "Empty Mapping"), so the generator never relies on it.</summary>
    public static string Mapped(string source, StructurePlan structure, bool toClient, Names names)
        => source + " mapTo { " + string.Join(", ", Fields(structure, "", 0, toClient, names).Select(f => f.Field + ": " + f.Value)) + " }";

    // A mapping names the attributes of the target and of its records one level down (R.A); a record two levels down, or a
    // list of records anywhere, is one value: the mapping function of its structure (O11 keeps one AttributeMapping for it).
    private static IEnumerable<(string Field, string Value)> Fields(StructurePlan structure, string prefix, int depth, bool toClient, Names names)
    {
        foreach (var a in structure.Attributes)
        {
            var path = prefix + a.Name;
            if (a.Structure != null && !a.List && depth == 0) foreach (var inner in Fields(a.Structure, path + ".", 1, toClient, names)) yield return inner;
            else if (a.Structure != null) yield return (path, names.Functions[FunctionKey(a.Structure, toClient, a.List)] + "(" + path + ")");
            else yield return (path, path);
        }
    }

    public static string FunctionKey(StructurePlan s, bool toClient, bool list) => s.Id + (toClient ? ":to" : ":from") + (list ? ":list" : ":record");

    /// <summary>The mapping functions the plan needs, inner first: the structure, the direction (toClient: a request's public
    /// value into the client's) and whether it maps a list (a list of records anywhere) or a record (two levels down).</summary>
    public static List<(StructurePlan Structure, bool ToClient, bool List)> MapFunctions(Plan plan)
    {
        var list = new List<(StructurePlan, bool, bool)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var roots = new HashSet<string>(StringComparer.Ordinal);
        void Root(StructurePlan s, bool toClient) { if (roots.Add(s.Id + (toClient ? ":to" : ":from"))) Visit(s, 0, toClient); }
        void Visit(StructurePlan s, int depth, bool toClient)
        {
            foreach (var a in s.Attributes.Where(a => a.Structure != null))
            {
                if (!a.List && depth == 0) { Visit(a.Structure!, 1, toClient); continue; }
                Root(a.Structure!, toClient);
                if (seen.Add(FunctionKey(a.Structure!, toClient, a.List))) list.Add((a.Structure!, toClient, a.List));
            }
        }
        foreach (var m in plan.Methods)
        {
            if (m.ResponseStructure != null) Root(m.ResponseStructure, false);
            if (m.RequestStructure != null) Root(m.RequestStructure, true);
        }
        return list;
    }

    /// <summary>The planned name of a mapping function (the handler resolves it like any action name).</summary>
    public static string FunctionBase(StructurePlan s, bool toClient, bool list) => Fit("Map" + s.Base, (list ? "List" : "") + (toClient ? "ToJson" : "FromJson"));

    /// <summary>A mapping function: a private server function from a record (or list) of one structure to its mirror.</summary>
    public static (JsonObject Declaration, string Hash) Function(Plan plan, StructurePlan s, bool toClient, bool list, Names names)
    {
        var from = (toClient ? names.Public : names.ClientStructures)[s.Id] + (list ? " List" : "");
        var to = (toClient ? names.ClientStructures : names.Public)[s.Id] + (list ? " List" : "");
        var step = list
            ? new JsonObject { ["call"] = "ListAppendAll", ["as"] = "MapResult", ["args"] = new JsonObject { ["List"] = "Result", ["SourceList"] = Mapped("Source", s, toClient, names) } }
            : new JsonObject { ["assign"] = new JsonObject { ["Result"] = Mapped("Source", s, toClient, names) }, ["label"] = "Return the mapped record" };
        var declaration = new JsonObject
        {
            ["name"] = names.Functions[FunctionKey(s, toClient, list)], ["kind"] = "server", ["public"] = false, ["function"] = true,
            ["description"] = $"Maps a {from} to a {to}, attribute by attribute (a value inside a record of {plan.Client}).",
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Source", ["type"] = from, ["description"] = "The value to map." }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = to, ["description"] = "The mapped value." }),
            ["steps"] = new JsonArray(step),
        };
        var hash = Hash(declaration);
        declaration["description"] = WithMarker(declaration["description"]!.ToString(), Marker(plan.Client, FunctionBase(s, toClient, list), hash));
        return (declaration, hash);
    }

    /// <summary>A URL default as the literal of its type ("BRL", 10, True, #2026-01-01#).</summary>
    public static string Literal(string type, string value) => type switch
    {
        "Integer" or "Long Integer" or "Decimal" when Regex.IsMatch(value, @"^-?\d+(\.\d+)?$") => value,
        "Boolean" when value is "true" or "false" => value == "true" ? "True" : "False",
        "Date" when DateOnly.IsMatch(value) => "#" + value + "#",
        _ => "\"" + value.Replace("\"", "\"\"") + "\"",
    };
}
