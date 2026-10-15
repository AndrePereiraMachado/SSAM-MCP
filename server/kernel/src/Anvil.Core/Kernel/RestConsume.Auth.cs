using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// rest-consume for authenticated and customized APIs (RestConsume.cs holds the open-API part). Everything the Studio's
/// Consume REST dialog and the REST callbacks give, on both lanes, without a credential in the model:
/// <list type="bullet">
/// <item>auth none|basic|bearer|apiKey (header or query)|oauth2 (client credentials): the generator creates the site
/// properties (O11) or settings (ODC) that hold the credentials, empty and secret, reads them at runtime in the client's
/// OnBeforeRequest, and lists them in the receipt (configure) for the user to fill in Service Center or the ODC Portal;
/// oauth2 adds a token client (&lt;Client&gt;Auth) and a private Get&lt;Client&gt;AccessToken the platform caches
/// (Cache in Minutes), which OnBeforeRequest calls;</item>
/// <item>headers: static ones of the client (OnBeforeRequest adds them), static and dynamic ones of a method (header
/// inputs: a literal the action always sends, or {input} the caller passes), optional inputs, a correlation id header;</item>
/// <item>settings.baseUrl: the base URL read from a site property/setting per environment (OnBeforeRequest);</item>
/// <item>OnAfterResponse: status &gt;= 400 raises the client's exception with the status and a body excerpt, errors.status
/// maps a status to its own exception (kept by the actions' handlers); callbacks.before/after add the model's own steps
/// (the logic op's steps, validated by that op) after the recipe;</item>
/// <item>timeout: the seconds of every method (a method's own timeout wins).</item>
/// </list>
/// A plain op (none of these keys) writes exactly what it wrote before (same hashes).
/// </summary>
public static partial class RestConsume
{
    /// <summary>The timeout of a method when neither the op nor the method gives one: 0, the platform's own.</summary>
    public const int DefaultTimeout = 0;
    /// <summary>How long the platform keeps an OAuth 2.0 token (Cache in Minutes of the token action) unless auth.cacheMinutes says.</summary>
    public const int DefaultTokenCacheMinutes = 50;
    /// <summary>How much of an error body the exception message carries.</summary>
    public const int BodyExcerpt = 300;
    public static readonly string[] AuthTypes = ["none", "basic", "bearer", "apiKey", "oauth2"];
    public static readonly string[] AuthKeys = ["type", "in", "name", "tokenUrl", "scope", "cacheMinutes"];
    public static readonly string[] SettingsKeys = ["baseUrl"];
    public static readonly string[] CallbackKeys = ["before", "after"];
    public static readonly string[] SlotKeys = ["steps", "vars"];
    /// <summary>The structures a REST client gets with its callbacks (each client its own).</summary>
    public static readonly string[] CallbackStructures = ["HTTPHeader", "URLQueryParameter", "HTTPRequest", "HTTPResponse"];
    private static readonly string[] CredentialKeys = ["username", "user", "password", "pass", "token", "accessToken", "bearer", "key", "apiKey", "value", "secret",
        "clientId", "clientSecret", "credentials"];
    private static readonly HashSet<string> CredentialHeaders = new(StringComparer.OrdinalIgnoreCase)
        { "Authorization", "Proxy-Authorization", "Cookie", "X-API-Key", "Api-Key", "X-Api-Token", "X-Auth-Token", "X-Access-Token" };
    private static readonly Regex HeaderToken = new(@"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$", RegexOptions.Compiled);
    private static readonly Regex WholePlaceholder = new(@"^\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=([^{}]*))?\}$", RegexOptions.Compiled);
    private static readonly Regex CredentialValue = new(@"^\s*(Bearer|Basic|Digest|Token)\s+\S", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>The O11 system extension that encodes the Basic credentials at runtime, and the actions the job references from
    /// it (o11_deliver captures it read-only, as any producer a reference op names; the facade adds the op).</summary>
    public const string BinaryDataProducer = "BinaryData";
    public static readonly string[] BinaryDataElements = ["IServerAction:TextToBinaryData", "IServerAction:BinaryToBase64"];

    /// <summary>Whether the plan encodes Basic credentials with BinaryData: auth basic on O11.</summary>
    public static bool UsesBinaryData(Plan plan) => plan.AuthType == "basic" && plan.Lane == "o11";

    /// <summary>The reference op the job needs for UsesBinaryData.</summary>
    public static JsonObject BinaryDataReference() => new()
    {
        ["op"] = "reference", ["producer"] = BinaryDataProducer, ["elements"] = new JsonArray(BinaryDataElements.Select(e => (JsonNode)e).ToArray()),
    };

    /// <summary>The descriptions of the parameters the platform gives each callback (born without one; N1 of the owner's rules).</summary>
    public static readonly IReadOnlyDictionary<string, string> CallbackParameters = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["Request"] = "The request the platform is about to send: base URL, path, query parameters, headers and body.",
        ["CustomizedRequest"] = "The request sent: the Request with this client's base URL, credential and headers.",
        ["Response"] = "The response the API answered: status code, headers and body.",
        ["CustomizedResponse"] = "The response the calling action reads, after the status checks.",
    };

    /// <summary>A site property (O11) or setting (ODC) the generator creates, empty unless Default: Fill says what the user puts in it.</summary>
    public sealed class Setting { public string Base = "", Description = "", Default = "", Fill = ""; public bool Secret; }

    // ---- validation (pure) ----------------------------------------------------------------------------------------------

    private static string AuthType(JsonObject data) => (data["auth"] as JsonObject)?["type"]?.ToString() ?? "none";

    /// <summary>Every problem of the auth and customization keys of the op (root level), in the op's one refusal.</summary>
    private static void ValidateCustomization(JsonObject data, List<IntegrationProblem> problems)
    {
        if (data["auth"] is { } auth)
        {
            if (auth is not JsonObject ao)
                problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth", "rest-consume: auth is {type: none|basic|bearer|apiKey|oauth2, ...}", "\"auth\": {\"type\": \"bearer\"}"));
            else
            {
                var secrets = ao.Select(p => p.Key).Where(k => CredentialKeys.Contains(k, StringComparer.OrdinalIgnoreCase)).ToList();
                if (secrets.Count > 0)
                    problems.Add(new("REST_CREDENTIALS_NOT_IN_MODEL", "/data/auth",
                        $"rest-consume: credentials never go in the model ({string.Join(", ", secrets)}): the generator creates the empty secret site properties (O11) or settings (ODC) that hold them and the receipt's configure says where to fill them",
                        "drop " + string.Join(", ", secrets) + "; keep {\"type\": ...} (and in/name, tokenUrl/scope); fill the values in Service Center or the ODC Portal after the publish"));
                foreach (var key in ao.Select(p => p.Key).Where(k => !AuthKeys.Contains(k, StringComparer.Ordinal) && !k.StartsWith('_') && !secrets.Contains(k)))
                    problems.Add(new("REST_CONSUME_UNKNOWN_KEYS", "/data/auth/" + key, $"rest-consume: auth has unknown key '{key}'", "use only: " + string.Join(", ", AuthKeys)));
                var type = ao["type"]?.ToString();
                if (type == null || !AuthTypes.Contains(type, StringComparer.Ordinal))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/type", $"rest-consume: auth.type '{type}' is not one of {string.Join(", ", AuthTypes)}",
                        "\"auth\": {\"type\": \"" + (AuthTypes.FirstOrDefault(t => t.Equals(type, StringComparison.OrdinalIgnoreCase)) ?? "bearer") + "\"}"));
                void Only(string key, string owner)
                {
                    if (ao[key] != null && type != owner)
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/" + key, $"rest-consume: auth.{key} belongs to auth type {owner}, not {type}", $"drop auth.{key}, or \"type\": \"{owner}\""));
                }
                Only("in", "apiKey"); Only("name", "apiKey"); Only("tokenUrl", "oauth2"); Only("scope", "oauth2"); Only("cacheMinutes", "oauth2");
                if (type == "apiKey")
                {
                    if (ao["in"] is { } where && where.ToString() is not ("header" or "query"))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/in", $"rest-consume: auth.in '{where}' is header or query (where the API key goes)", "\"in\": \"header\""));
                    if (ao["name"] is { } kn && !(kn is JsonValue knv && knv.TryGetValue<string>(out var ks) && HeaderToken.IsMatch(ks)))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/name", $"rest-consume: auth.name '{kn}' is the header or query parameter name of the API key", "\"name\": \"X-API-Key\""));
                }
                if (type == "oauth2")
                {
                    var tokenUrl = ao["tokenUrl"] is JsonValue tv && tv.TryGetValue<string>(out var ts) ? ts.Trim() : null;
                    if (tokenUrl == null || !TryAbsolute(tokenUrl, out _, out var tokenPath, out var tokenQuery) || tokenQuery.Length > 0 || tokenPath.Trim('/').Length == 0 || tokenUrl.Contains('{'))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/tokenUrl", $"rest-consume: auth.tokenUrl '{tokenUrl}' is the token endpoint: an absolute URL with a path, without query or inputs",
                            "\"tokenUrl\": \"https://auth.example.com/oauth2/token\""));
                    else if (!tokenUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/tokenUrl", $"rest-consume: auth.tokenUrl '{tokenUrl}' receives the client secret: https only", "\"tokenUrl\": \"https://...\""));
                    if (ao["scope"] is { } scope && !(scope is JsonValue sv && sv.TryGetValue<string>(out _)))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/scope", "rest-consume: auth.scope is the text of the scopes (space separated)", "\"scope\": \"read write\""));
                    if (ao["cacheMinutes"] is { } cm && !(cm is JsonValue cv && cv.TryGetValue<int>(out var minutes) && minutes is > 0 and <= 1440))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/auth/cacheMinutes", "rest-consume: auth.cacheMinutes is how long the token is kept: 1 to 1440 minutes (less than the token's lifetime)", $"\"cacheMinutes\": {DefaultTokenCacheMinutes}"));
                }
            }
        }
        if (data["headers"] is { } headers)
        {
            if (headers is not JsonObject ho || ho.Any(p => p.Value is not JsonValue v || !v.TryGetValue<string>(out _)))
                problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/headers", "rest-consume: headers is {\"Header-Name\": \"literal value\"}, sent by OnBeforeRequest on every request", "\"headers\": {\"Accept\": \"application/json\"}"));
            else
                foreach (var (name, value) in ho)
                {
                    var text = value!.ToString();
                    if (text.Contains('{') || text.Contains('}'))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/headers/" + name, $"rest-consume: client header '{name}' is a literal; a value the caller passes goes in a method's headers",
                            "\"methods\": [{..., \"headers\": {\"" + name + "\": \"{" + Sanitize(name, "Value") + "}\"}}]"));
                    HeaderProblems(name, text, "/data/headers/" + name, problems);
                }
        }
        if (data["settings"] is { } settings)
        {
            if (settings is not JsonObject so) problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/settings", "rest-consume: settings is {baseUrl: true}", "\"settings\": {\"baseUrl\": true}"));
            else
            {
                Closed(so, SettingsKeys, "/data/settings", "settings", problems);
                if (so["baseUrl"] is { } b && !(b is JsonValue bv && bv.TryGetValue<bool>(out _)))
                    problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/settings/baseUrl", "rest-consume: settings.baseUrl is true (the base URL comes from a site property/setting per environment) or false", "\"settings\": {\"baseUrl\": true}"));
            }
        }
        if (data["timeout"] is { } t && !(t is JsonValue tv2 && tv2.TryGetValue<int>(out var seconds) && seconds > 0))
            problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/timeout", "rest-consume: timeout is the seconds of every method (a method's own timeout wins)", "\"timeout\": 30"));
        if (data["correlationHeader"] is { } ch && !(ch is JsonValue chv && chv.TryGetValue<string>(out var chs) && HeaderToken.IsMatch(chs) && !CredentialHeaders.Contains(chs)))
            problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/correlationHeader", $"rest-consume: correlationHeader '{ch}' is the name of the header that carries the caller's correlation id", "\"correlationHeader\": \"X-Correlation-Id\""));
        if (data["callbacks"] is { } callbacks)
        {
            if (callbacks is not JsonObject co) problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/callbacks", "rest-consume: callbacks is {before: {steps, vars}, after: {steps, vars}}", "\"callbacks\": {\"before\": {\"steps\": [...]}}"));
            else
            {
                Closed(co, CallbackKeys, "/data/callbacks", "callbacks", problems);
                foreach (var slot in CallbackKeys)
                {
                    if (co[slot] is not { } s) continue;
                    var at = "/data/callbacks/" + slot;
                    var what = slot == "before" ? "OnBeforeRequest: Request, CustomizedRequest" : "OnAfterResponse: Request, Response, CustomizedResponse";
                    if (s is not JsonObject slotObject) { problems.Add(new("REST_CONSUME_KEY_INVALID", at, $"rest-consume: callbacks.{slot} is {{steps, vars}}: the logic op's steps, run after the recipe ({what})", "{\"steps\": [{\"assign\": {...}, \"label\": \"...\"}]}")); continue; }
                    Closed(slotObject, SlotKeys, at, "callbacks." + slot, problems);
                    if (slotObject["steps"] is not JsonArray { Count: > 0 } steps || steps.Any(x => x is not JsonObject))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/steps", $"rest-consume: callbacks.{slot}.steps is a non-empty list of the logic op's steps ({what})", "\"steps\": [{\"assign\": {\"CustomizedRequest.URLPath\": \"...\"}, \"label\": \"...\"}]"));
                    if (slotObject["vars"] is { } vars && (vars is not JsonArray va || va.Any(x => x is not JsonObject vo || vo["name"] is not JsonValue || vo["type"] is not JsonValue)))
                        problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/vars", $"rest-consume: callbacks.{slot}.vars is a list of {{name, type, description}} (HTTPHeader and URLQueryParameter are the client's own)", "\"vars\": [{\"name\": \"Signature\", \"type\": \"Text\", \"description\": \"...\"}]"));
                }
            }
        }
    }

    /// <summary>The status mapping of errors (in the errors block of Validate).</summary>
    private static void ValidateStatus(JsonObject errors, List<IntegrationProblem> problems)
    {
        if (errors["status"] is not { } status) return;
        if (status is not JsonObject so || so.Count == 0) { problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/errors/status", "rest-consume: errors.status is {\"<HTTP status>\": \"<Exception>\"}", "\"status\": {\"404\": \"OrderNotFound\"}")); return; }
        foreach (var (code, exception) in so)
        {
            if (!Regex.IsMatch(code, "^[45][0-9]{2}$"))
                problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/errors/status/" + code, $"rest-consume: errors.status '{code}' is an HTTP error status, 400 to 599", "\"status\": {\"404\": \"OrderNotFound\"}"));
            if (!(exception is JsonValue ev && ev.TryGetValue<string>(out var es) && Identifier.IsMatch(es) && es.Length <= NameMax))
                problems.Add(new("REST_CONSUME_KEY_INVALID", "/data/errors/status/" + code, $"rest-consume: the exception of status {code} ('{exception}') is not an OutSystems name", $"\"{code}\": \"{Sanitize(exception?.ToString(), "ApiError")}\""));
        }
    }

    private static void HeaderProblems(string name, string value, string at, List<IntegrationProblem> problems)
    {
        if (!HeaderToken.IsMatch(name))
            problems.Add(new("REST_CONSUME_KEY_INVALID", at, $"rest-consume: '{name}' is not an HTTP header name (letters, digits and !#$%&'*+.^_`|~-)", "\"X-Header-Name\": \"value\""));
        if (CredentialHeaders.Contains(name) || CredentialValue.IsMatch(value))
            problems.Add(new("REST_CREDENTIALS_NOT_IN_MODEL", at, $"rest-consume: header '{name}' carries a credential, which never goes in the model",
                "\"auth\": {\"type\": \"bearer\"} (or basic, oauth2, or apiKey with \"name\": \"" + name + "\"): the generator creates the empty secret site property/setting and sends it; a token the caller has goes in a method's headers as an input: \"" + name + "\": \"{" + Sanitize(name, "Value") + "}\""));
    }

    /// <summary>A method's headers and optional inputs; the method's parsed url (null when it does not parse).</summary>
    private static void ValidateMethodCustomization(JsonObject m, string at, string? mn, ParsedUrl? url, List<IntegrationProblem> problems)
    {
        var placeholders = new List<string>();
        if (m["headers"] is { } headers)
        {
            if (headers is not JsonObject ho || ho.Any(p => p.Value is not JsonValue v || !v.TryGetValue<string>(out _)))
                problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/headers", $"rest-consume: headers of '{mn}' is {{\"Header-Name\": \"literal\" | \"{{input}}\" | \"{{input=example}}\"}}", "\"headers\": {\"X-Tenant\": \"{tenant}\", \"X-Version\": \"2\"}"));
            else
                foreach (var (name, value) in ho)
                {
                    var text = value!.ToString();
                    var hat = at + "/headers/" + name;
                    var ph = WholePlaceholder.Match(text.Trim());
                    if (ph.Success)
                    {
                        var input = ph.Groups[1].Value;
                        if (!HeaderToken.IsMatch(name)) problems.Add(new("REST_CONSUME_KEY_INVALID", hat, $"rest-consume: '{name}' is not an HTTP header name", "\"X-Header-Name\": \"{input}\""));
                        if (url?.Params.Any(p => p.Name == input) == true || placeholders.Contains(input))
                            problems.Add(new("REST_CONSUME_DUPLICATE_NAME", hat, $"rest-consume: input '{input}' of '{mn}' is named twice (the url or another header names it too)", "give each input its own name"));
                        else placeholders.Add(input);
                    }
                    else
                    {
                        if (text.Contains('{') || text.Contains('}'))
                            problems.Add(new("REST_CONSUME_KEY_INVALID", hat, $"rest-consume: header '{name}' of '{mn}' is a literal or one whole input (\"{{input}}\", \"{{input=example}}\"), not '{text}'", "\"" + name + "\": \"{" + Sanitize(name, "Value") + "}\""));
                        HeaderProblems(name, text, hat, problems);
                    }
                }
        }
        if (m["optional"] is { } optional)
        {
            if (optional is not JsonArray oa || oa.Any(x => x is not JsonValue v || !v.TryGetValue<string>(out _)))
                problems.Add(new("REST_CONSUME_KEY_INVALID", at + "/optional", $"rest-consume: optional of '{mn}' is the list of inputs the caller may leave empty (not sent then)", "\"optional\": [\"tenant\"]"));
            else
                for (var k = 0; k < oa.Count; k++)
                {
                    var name = oa[k]!.ToString();
                    if (placeholders.Contains(name)) continue;
                    var param = url?.Params.FirstOrDefault(p => p.Name == name);
                    if (param == null)
                        problems.Add(new("REST_CONSUME_KEY_INVALID", $"{at}/optional/{k}", $"rest-consume: optional names '{name}', which is no input of '{mn}'",
                            "name an {input} of a header or of the query (?k={input}); a query parameter k=v is already optional with default v"));
                    else if (!param.Query)
                        problems.Add(new("REST_CONSUME_KEY_INVALID", $"{at}/optional/{k}", $"rest-consume: '{name}' of '{mn}' is in the URL path, which always needs a value",
                            $"move it to the query (?{name}={{{name}}}) or a header to make it optional"));
                }
        }
    }

    // ---- the plan ---------------------------------------------------------------------------------------------------------

    /// <summary>The auth and customization of a valid op into the plan (after the base URL, before the methods).</summary>
    private static void BuildCustomization(JsonObject data, Plan plan)
    {
        var auth = data["auth"] as JsonObject;
        plan.AuthType = AuthType(data);
        var c = plan.Client;
        var where = "OnBeforeRequest";
        if (data["settings"]?["baseUrl"] is JsonValue bv && bv.TryGetValue<bool>(out var fromSetting) && fromSetting)
        {
            plan.BaseUrlSetting = true;
            plan.Settings.Add(new Setting
            {
                Base = Fit(c, "BaseUrl"), Default = plan.BaseUrl, Fill = "the base URL of the API on this environment (empty: " + plan.BaseUrl + ")",
                Description = $"Base URL of {c} on this environment; {where} sends every request there (empty: the design one, {plan.BaseUrl}).",
            });
        }
        switch (plan.AuthType)
        {
            // O11: the user and the password, each its own secret site property, encoded at runtime by the system extension
            // BinaryData (TextToBinaryData, BinaryToBase64; the job references it). ODC has no such producer offline: the
            // setting holds the Base64 of user:password (no Base64 built-in on either lane).
            case "basic" when UsesBinaryData(plan):
                plan.Settings.Add(new Setting { Base = Fit(c, "Username"), Secret = true, Fill = "the user of the Basic authorization",
                    Description = $"User of the Basic authorization of {c}; {where} encodes user:password in Base64 (BinaryData) and sends Authorization: Basic <value>." });
                plan.Settings.Add(new Setting { Base = Fit(c, "Password"), Secret = true, Fill = "the password of the Basic authorization",
                    Description = $"Password of the Basic authorization of {c}; {where} encodes user:password in Base64 (BinaryData) and sends Authorization: Basic <value>." });
                break;
            case "basic":
                plan.Settings.Add(new Setting
                {
                    Base = Fit(c, "BasicCredentials"), Secret = true, Fill = "the Base64 of user:password (the platform has no Base64 built-in: the encoded value)",
                    Description = $"Basic credentials of {c}: the Base64 of user:password; {where} sends Authorization: Basic <value>.",
                });
                break;
            case "bearer":
                plan.Settings.Add(new Setting { Base = Fit(c, "Token"), Secret = true, Fill = "the bearer token", Description = $"Bearer token of {c}; {where} sends Authorization: Bearer <value>." });
                break;
            case "apiKey":
                plan.ApiKeyIn = auth?["in"]?.ToString() ?? "header";
                plan.ApiKeyName = auth?["name"]?.ToString() ?? (plan.ApiKeyIn == "query" ? "api_key" : "X-API-Key");
                plan.Settings.Add(new Setting
                {
                    Base = Fit(c, "ApiKey"), Secret = true, Fill = "the API key",
                    Description = $"API key of {c}; {where} sends it in the {plan.ApiKeyName} {(plan.ApiKeyIn == "query" ? "query parameter" : "header")}.",
                });
                break;
            case "oauth2":
                plan.TokenUrl = auth!["tokenUrl"]!.ToString().Trim();
                plan.Scope = auth["scope"]?.ToString();
                plan.TokenCacheMinutes = auth["cacheMinutes"]?.GetValue<int>() ?? DefaultTokenCacheMinutes;
                plan.Settings.Add(new Setting { Base = Fit(c, "ClientId"), Fill = "the OAuth 2.0 client id", Description = $"OAuth 2.0 client id of {c}, sent to {plan.TokenUrl} for an access token." });
                plan.Settings.Add(new Setting { Base = Fit(c, "ClientSecret"), Secret = true, Fill = "the OAuth 2.0 client secret", Description = $"OAuth 2.0 client secret of {c}, sent to {plan.TokenUrl} for an access token." });
                break;
        }
        foreach (var (name, value) in data["headers"] as JsonObject ?? []) plan.Headers.Add((name, value!.ToString()));
        plan.Timeout = data["timeout"] is JsonValue tv && tv.TryGetValue<int>(out var seconds) ? seconds : DefaultTimeout;
        plan.CorrelationHeader = data["correlationHeader"]?.ToString();
        foreach (var (code, exception) in data["errors"]?["status"] as JsonObject ?? [])
            plan.StatusErrors.Add((int.Parse(code, CultureInfo.InvariantCulture), exception!.ToString()));
        plan.StatusErrors.Sort((a, b) => a.Status.CompareTo(b.Status));
        plan.CustomBefore = data["callbacks"]?["before"]?.DeepClone() as JsonObject;
        plan.CustomAfter = data["callbacks"]?["after"]?.DeepClone() as JsonObject;
    }

    /// <summary>The header inputs and fixed headers of a method (after its url inputs): {input} is an input the caller
    /// passes, a literal is a header the action always sends, correlationHeader adds the optional CorrelationId.</summary>
    private static void PlanHeaders(Plan plan, MethodPlan method, JsonObject m, JsonObject? types, JsonObject? tries, HashSet<string> optional,
        HashSet<string> inputNames, HashSet<string> restNames)
    {
        void Input(UrlParam param)
        {
            var example = tries?[param.Name]?.ToString() ?? param.Example;
            var type = types?[param.Name] is { } t ? NormalizeType(t.ToString()) : ExampleType(example);
            var restName = Unique(Identifier.IsMatch(param.Name) ? param.Name : Sanitize(param.Name, "Value"), restNames);
            var inputName = Unique(type == "Boolean" ? BooleanName(Sanitize(param.Name, "Value")) : Sanitize(param.Name, "Value"), inputNames);
            method.Inputs.Add((param with { Example = example }, type, restName, inputName));
        }
        foreach (var (header, value) in m["headers"] as JsonObject ?? [])
        {
            var text = value!.ToString();
            var ph = WholePlaceholder.Match(text.Trim());
            if (ph.Success)
            {
                var name = ph.Groups[1].Value;
                var isOptional = optional.Contains(name);
                var example = ph.Groups[2].Success ? ph.Groups[2].Value : null;
                Input(new UrlParam(name, example, false, !isOptional, isOptional ? example : null, header, Header: true));
            }
            else method.Fixed.Add((Unique(Sanitize(header, "Header"), restNames), header, text));
        }
        if (plan.CorrelationHeader != null) Input(new UrlParam("CorrelationId", null, false, false, null, plan.CorrelationHeader, Header: true));
    }

    /// <summary>Whether the client gets its callbacks: auth, client headers, the base URL setting, a status mapping or the model's steps.</summary>
    public static bool HasCallbacks(Plan plan)
        => plan.AuthType != "none" || plan.Headers.Count > 0 || plan.BaseUrlSetting || plan.StatusErrors.Count > 0 || plan.CustomBefore != null || plan.CustomAfter != null;

    // ---- the generated elements ---------------------------------------------------------------------------------------------

    private static string SettingRef(Plan plan, Names names, string planned) => (plan.Lane == "odc" ? "Settings." : "Site.") + names.Settings[planned];

    private static string Text(string literal) => "\"" + literal.Replace("\"", "\"\"") + "\"";

    /// <summary>The settings with their final descriptions (marker) and hashes.</summary>
    public static List<(Setting Setting, string Name, string Description, string Hash)> Settings(Plan plan, Names names)
    {
        var list = new List<(Setting, string, string, string)>();
        foreach (var s in plan.Settings)
        {
            var name = names.Settings[s.Base];
            var text = s.Description + (s.Secret ? " Secret, empty in the module: fill it in " : " Fill it in ") + (plan.Lane == "odc" ? "the ODC Portal (the app's Settings)." : "Service Center (the module's Site Properties).");
            var hash = Hash(new JsonObject { ["name"] = name, ["description"] = text, ["secret"] = s.Secret, ["default"] = s.Default });
            list.Add((s, name, WithMarker(text, Marker(plan.Client, s.Base, hash)), hash));
        }
        return list;
    }

    /// <summary>What the receipt says the user fills after the publish (never a value).</summary>
    public static JsonArray Configure(Plan plan, Names names, string module)
    {
        var list = new JsonArray();
        foreach (var s in plan.Settings)
            list.Add(new JsonObject
            {
                ["name"] = names.Settings[s.Base], ["kind"] = plan.Lane == "odc" ? "Setting" : "Site Property", ["secret"] = s.Secret,
                ["fill"] = s.Fill, ["default"] = s.Default.Length > 0 ? s.Default : null,
                ["where"] = plan.Lane == "odc" ? $"ODC Portal > Apps > {module} > Configurations > Settings > {names.Settings[s.Base]} (each stage)"
                    : $"Service Center > Factory > Modules > {module} > Site Properties > {names.Settings[s.Base]} (each environment)",
            });
        return list;
    }

    /// <summary>The planned names of the token client's elements (oauth2).</summary>
    public static (string Client, string Method, string Structure, string Action) TokenNames(Plan plan)
        => (Fit(plan.Client, "Auth"), Fit("Request" + plan.Client, "Token"), Fit(plan.Client, "TokenJson"), Fit("Get" + plan.Client, "AccessToken"));

    /// <summary>The op rest of the token client (oauth2): one POST of the form body to the token endpoint, the JSON token back.</summary>
    public static JsonObject TokenRestData(Plan plan, Names names)
    {
        var parsed = ParseUrl(plan.TokenUrl!, null);
        var (baseUrl, paths) = BaseAndPaths(null, [parsed]);
        var (_, plannedMethod, plannedStructure, _) = TokenNames(plan);
        return new JsonObject
        {
            ["client"] = new JsonObject { ["name"] = names.AuthClient, ["baseUrl"] = baseUrl },
            ["structures"] = new JsonArray(new JsonObject
            {
                ["name"] = names.TokenStructure,
                ["description"] = WithMarker($"The token {plan.TokenUrl} answers (OAuth 2.0 client credentials of {plan.Client}).", Marker(plan.Client, plannedStructure, "00000000")),
                ["attributes"] = new JsonArray(
                    new JsonObject { ["name"] = "AccessToken", ["type"] = "Text", ["json"] = "access_token", ["description"] = "\"access_token\": the token OnBeforeRequest sends." },
                    new JsonObject { ["name"] = "TokenType", ["type"] = "Text", ["json"] = "token_type", ["description"] = "\"token_type\": Bearer." },
                    new JsonObject { ["name"] = "ExpiresIn", ["type"] = "Integer", ["json"] = "expires_in", ["description"] = "\"expires_in\": the token's lifetime in seconds." }),
            }),
            ["methods"] = new JsonArray(new JsonObject
            {
                ["name"] = names.TokenMethod, ["http"] = "POST", ["path"] = "/" + string.Join("/", paths[0]),
                ["description"] = WithMarker($"POST {plan.TokenUrl}: an access token for {plan.Client} (grant_type client_credentials).", Marker(plan.Client, plannedMethod, "00000000")),
                ["inputs"] = new JsonArray(
                    new JsonObject { ["name"] = "Body", ["type"] = "Text", ["in"] = "body", ["description"] = "The form body: grant_type, client_id, client_secret and scope, URL-encoded." },
                    new JsonObject { ["name"] = "ContentType", ["type"] = "Text", ["in"] = "header", ["originalName"] = "Content-Type", ["mandatory"] = true, ["description"] = "Header \"Content-Type\": application/x-www-form-urlencoded." }),
                ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Response", ["type"] = names.TokenStructure, ["in"] = "body", ["description"] = "The token the endpoint answered (access_token, token_type, expires_in)." }),
            }),
        };
    }

    /// <summary>The token client's description with its marker (the hash of its op rest).</summary>
    public static string TokenClientDescription(Plan plan, string hash)
        => WithMarker($"Token endpoint of {plan.Client} ({plan.TokenUrl}): OAuth 2.0 client credentials, called by {TokenNames(plan).Action}.", Marker(plan.Client, TokenNames(plan).Client, hash));

    /// <summary>The token action (oauth2): a private server action the platform caches TokenCacheMinutes (set after the logic op).</summary>
    public static (JsonObject Declaration, string Hash, string Planned, string Kind) TokenAction(Plan plan, Names names)
    {
        var body = "\"grant_type=client_credentials&client_id=\" + EncodeUrl(" + SettingRef(plan, names, Fit(plan.Client, "ClientId")) + ") + \"&client_secret=\" + EncodeUrl("
            + SettingRef(plan, names, Fit(plan.Client, "ClientSecret")) + ")" + (string.IsNullOrWhiteSpace(plan.Scope) ? "" : " + " + Text("&scope=" + Uri.EscapeDataString(plan.Scope!)));
        var declaration = new JsonObject
        {
            ["name"] = names.TokenAction, ["kind"] = "server", ["public"] = false,
            ["description"] = $"Gets an access token of {plan.Client} from {plan.TokenUrl} (OAuth 2.0 client credentials with the {names.Settings[Fit(plan.Client, "ClientId")]} and "
                + $"{names.Settings[Fit(plan.Client, "ClientSecret")]} settings); the platform keeps it {plan.TokenCacheMinutes} minutes (Cache in Minutes), so OnBeforeRequest asks the "
                + $"endpoint once in that time; a failure raises {names.Exception}, logged.",
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "AccessToken", ["type"] = "Text", ["description"] = "The access_token the endpoint answered." }),
            ["steps"] = new JsonArray(
                new JsonObject { ["call"] = "IRestAction:" + names.TokenMethod, ["as"] = "RequestToken", ["args"] = new JsonObject { ["Body"] = body, ["ContentType"] = Text("application/x-www-form-urlencoded") } },
                new JsonObject { ["assign"] = new JsonObject { ["AccessToken"] = "RequestToken.Response.AccessToken" }, ["label"] = "Return the access token" }),
            ["handlers"] = new JsonArray(new JsonObject
            {
                ["name"] = "AllExceptions", ["exception"] = "AllExceptions", ["abortTransaction"] = true, ["logError"] = true,
                ["steps"] = new JsonArray(new JsonObject { ["raise"] = names.Exception, ["message"] = $"\"{plan.Client} token request failed: \" + AllExceptions.ExceptionMessage" }),
            }),
        };
        return Marked(declaration, plan.Client, TokenNames(plan).Action, "IServerAction");
    }

    /// <summary>OnBeforeRequest and OnAfterResponse of the client (when HasCallbacks), with the standard recipe and the
    /// model's steps after it; the handler creates them first, so they are always replaced (their keys stay).</summary>
    public static List<(JsonObject Declaration, string Hash, string Planned, string Kind)> Callbacks(Plan plan, Names names)
    {
        var list = new List<(JsonObject, string, string, string)>();
        if (!HasCallbacks(plan)) return list;
        string Type(string structure) => names.CallbackTypes.TryGetValue(structure, out var key) ? key : structure;
        var owner = "IRestClient:" + names.Client;

        // OnBeforeRequest: the base URL of the environment, the credential, the client's headers, then the model's steps.
        var vars = new JsonArray();
        var steps = new JsonArray();
        var does = new List<string>();
        var start = new JsonObject { ["CustomizedRequest"] = "Request" };
        if (plan.BaseUrlSetting)
        {
            var setting = SettingRef(plan, names, Fit(plan.Client, "BaseUrl"));
            start["CustomizedRequest.BaseURL"] = $"If({setting} = \"\", Request.BaseURL, {setting})";
            does.Add($"the base URL of {names.Settings[Fit(plan.Client, "BaseUrl")]}");
        }
        steps.Add(new JsonObject { ["assign"] = start, ["label"] = plan.BaseUrlSetting ? "Start from the request, on this environment's base URL" : "Start from the request" });
        var headers = new List<(string Name, string Value, string Label)>();
        switch (plan.AuthType)
        {
            case "basic" when UsesBinaryData(plan):
                steps.Add(new JsonObject { ["call"] = "TextToBinaryData", ["as"] = "EncodeCredentials", ["args"] = new JsonObject
                {
                    ["Text"] = SettingRef(plan, names, Fit(plan.Client, "Username")) + " + \":\" + " + SettingRef(plan, names, Fit(plan.Client, "Password")), ["Encoding"] = Text("utf-8"),
                } });
                steps.Add(new JsonObject { ["call"] = "BinaryToBase64", ["as"] = "Base64Credentials", ["args"] = new JsonObject { ["Binary"] = "EncodeCredentials.BinaryData" } });
                headers.Add(("Authorization", "\"Basic \" + Base64Credentials.Base64", "Build the Basic Authorization header"));
                does.Add("Basic authorization (user:password in Base64 through BinaryData)");
                break;
            case "basic":
                headers.Add(("Authorization", "\"Basic \" + " + SettingRef(plan, names, Fit(plan.Client, "BasicCredentials")), "Build the Basic Authorization header"));
                does.Add("Basic authorization");
                break;
            case "bearer":
                headers.Add(("Authorization", "\"Bearer \" + " + SettingRef(plan, names, Fit(plan.Client, "Token")), "Build the Bearer Authorization header"));
                does.Add("the bearer token");
                break;
            case "apiKey" when plan.ApiKeyIn == "header":
                headers.Add((plan.ApiKeyName!, SettingRef(plan, names, Fit(plan.Client, "ApiKey")), $"Build the {plan.ApiKeyName} header"));
                does.Add($"the API key in {plan.ApiKeyName}");
                break;
            case "oauth2":
                steps.Add(new JsonObject { ["call"] = names.TokenAction, ["as"] = "GetAccessToken" });
                headers.Add(("Authorization", "\"Bearer \" + GetAccessToken.AccessToken", "Build the Bearer Authorization header"));
                does.Add($"an OAuth 2.0 token ({names.TokenAction}, cached)");
                break;
        }
        foreach (var (name, value) in plan.Headers) headers.Add((name, Text(value), $"Build the {name} header"));
        if (plan.Headers.Count > 0) does.Add("the headers " + string.Join(", ", plan.Headers.Select(h => h.Name)));
        var nodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "GetAccessToken", "EncodeCredentials", "Base64Credentials" };
        if (headers.Count > 0) vars.Add(new JsonObject { ["name"] = "Header", ["type"] = Type("HTTPHeader"), ["description"] = "The header being added." });
        foreach (var (name, value, label) in headers)
        {
            steps.Add(new JsonObject { ["assign"] = new JsonObject { ["Header.Name"] = Text(name), ["Header.Value"] = value }, ["label"] = label });
            steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = Unique(Fit("Add" + Sanitize(name, "Custom"), "Header"), nodes), ["args"] = new JsonObject { ["List"] = "CustomizedRequest.Headers", ["Element"] = "Header" } });
        }
        if (plan.AuthType == "apiKey" && plan.ApiKeyIn == "query")
        {
            vars.Add(new JsonObject { ["name"] = "Parameter", ["type"] = Type("URLQueryParameter"), ["description"] = "The query parameter being added." });
            steps.Add(new JsonObject { ["assign"] = new JsonObject { ["Parameter.Name"] = Text(plan.ApiKeyName!), ["Parameter.Value"] = SettingRef(plan, names, Fit(plan.Client, "ApiKey")) }, ["label"] = $"Build the {plan.ApiKeyName} query parameter" });
            steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AddApiKeyParameter", ["args"] = new JsonObject { ["List"] = "CustomizedRequest.URLQueryParameters", ["Element"] = "Parameter" } });
            does.Add($"the API key in the {plan.ApiKeyName} query parameter");
        }
        Slot(plan.CustomBefore, vars, steps, Type);
        if (plan.CustomBefore != null) does.Add("the module's own steps");
        var before = new JsonObject
        {
            ["name"] = "OnBeforeRequest", ["kind"] = "callback", ["owner"] = owner, ["replace"] = true,
            ["description"] = $"Prepares every request of {names.Client}: " + (does.Count > 0 ? string.Join("; ", does) : "the request as it is") + ".",
        };
        if (vars.Count > 0) before["vars"] = vars;
        before["steps"] = steps;
        list.Add(Marked(before, plan.Client, "OnBeforeRequest", "IRestCallbackActionFlow"));

        // OnAfterResponse: a mapped status raises its exception, any other error the client's, with the status and a body excerpt.
        var afterVars = new JsonArray();
        var afterSteps = new JsonArray { new JsonObject { ["assign"] = new JsonObject { ["CustomizedResponse"] = "Response" }, ["label"] = "Keep the response" } };
        var excerpt = $"Substr(Response.ResponseText, 0, {BodyExcerpt})";
        foreach (var (status, exception) in plan.StatusErrors)
            afterSteps.Add(new JsonObject
            {
                ["if"] = $"Response.StatusCode = {status}", ["label"] = $"Did the API answer {status}?",
                ["then"] = new JsonArray(new JsonObject { ["raise"] = names.StatusExceptions[exception], ["message"] = $"\"{names.Client} answered HTTP {status}: \" + {excerpt}" }),
            });
        afterSteps.Add(new JsonObject
        {
            ["if"] = "Response.StatusCode >= 400", ["label"] = "Did the API answer an error?",
            ["then"] = new JsonArray(new JsonObject { ["raise"] = names.Exception, ["message"] = $"\"{names.Client} answered HTTP \" + Response.StatusCode + \": \" + {excerpt}" }),
        });
        Slot(plan.CustomAfter, afterVars, afterSteps, Type);
        var after = new JsonObject
        {
            ["name"] = "OnAfterResponse", ["kind"] = "callback", ["owner"] = owner, ["replace"] = true,
            ["description"] = $"Checks every response of {names.Client}: "
                + string.Concat(plan.StatusErrors.Select(s => $"HTTP {s.Status} raises {names.StatusExceptions[s.Exception]}; "))
                + $"any other status from 400 raises {names.Exception} with the status and the first {BodyExcerpt} characters of the body"
                + (plan.CustomAfter != null ? "; then the module's own steps" : "") + ".",
        };
        if (afterVars.Count > 0) after["vars"] = afterVars;
        after["steps"] = afterSteps;
        list.Add(Marked(after, plan.Client, "OnAfterResponse", "IRestCallbackActionFlow"));
        return list;
    }

    // The model's own steps after the recipe; a var typed by a callback structure gets this client's (each client has its own).
    private static void Slot(JsonObject? slot, JsonArray vars, JsonArray steps, Func<string, string> type)
    {
        if (slot == null) return;
        foreach (var v in slot["vars"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var copy = (JsonObject)v.DeepClone();
            var t = copy["type"]!.ToString();
            var list = t.EndsWith(" List", StringComparison.Ordinal);
            var bare = list ? t[..^" List".Length] : t;
            if (CallbackStructures.Contains(bare, StringComparer.Ordinal)) copy["type"] = type(bare) + (list ? " List" : "");
            vars.Add(copy);
        }
        foreach (var s in slot["steps"]!.AsArray()) steps.Add(s!.DeepClone());
    }

    /// <summary>The names a valid op plans to write (the job preflight takes them as names of the job: a later op may reference
    /// GetAcmeOrder or AcmeToken, which the job text never spells); empty when the data is not valid. A name the module already
    /// uses moves on at apply (Name2), which no preflight can know.</summary>
    public static IEnumerable<string> PlannedNames(JsonObject data)
    {
        Plan plan;
        try { if (Validate(data, "o11").Count > 0) return []; plan = Build(data); }
        catch (Exception) { return []; } // the op itself refuses at apply, with its problems
        var names = new List<string> { plan.Client, plan.Exception, "AccessDenied" };
        names.AddRange(plan.Methods.SelectMany(m => new[] { m.Name, m.Action, m.Action + "_Impl" }));
        names.AddRange(plan.Structures.SelectMany(s => new[] { s.Base, Fit(s.Base, "Json") }));
        names.AddRange(MapFunctions(plan).Select(f => FunctionBase(f.Structure, f.ToClient, f.List)));
        names.AddRange(plan.Settings.Select(s => s.Base));
        if (plan.AuthType == "basic") names.AddRange([Fit(plan.Client, "Username"), Fit(plan.Client, "Password"), Fit(plan.Client, "BasicCredentials")]);
        names.AddRange(plan.StatusErrors.Select(s => s.Exception));
        if (plan.AuthType == "oauth2") { var t = TokenNames(plan); names.AddRange([t.Client, t.Method, t.Structure, t.Action]); }
        if (HasCallbacks(plan)) names.AddRange(CallbackNames);
        return names;
    }

    private static readonly string[] CallbackNames = ["OnBeforeRequest", "OnAfterResponse"];

    /// <summary>The handlers an action adds before AllExceptions so a mapped status keeps its own exception (OnAfterResponse
    /// raises it inside the call; AllExceptions would turn it into the client's).</summary>
    private static IEnumerable<JsonObject> StatusHandlers(Plan plan, Names names)
        => plan.StatusErrors.Select(s => names.StatusExceptions[s.Exception]).Where(e => !string.Equals(e, names.Exception, StringComparison.Ordinal)).Distinct(StringComparer.Ordinal)
            .Select(e => new JsonObject
            {
                ["name"] = e, ["exception"] = e, ["abortTransaction"] = true, ["logError"] = true,
                ["steps"] = new JsonArray(new JsonObject { ["raise"] = e, ["message"] = e + ".ExceptionMessage" }),
            });
}
