using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal delegate Task<MacHttpResponse> MacBackendHttp(Uri uri, string method, CookieContainer jar, byte[]? body, string? contentType, string? authorization, string scheme, CancellationToken token, IReadOnlyDictionary<string,string>? headers);
internal delegate Task<MacDialogResult> MacDialogRunner(JsonObject model, Func<JsonObject, Task<string?>> accept, CancellationToken token, Action? visible);
internal static class MacPrivateBackend
{
    internal static JsonObject Envelope(string family, string mode, string scope, string host, JsonObject request, string dataRoot, string? runtimeRoot, JsonObject? options = null)
        => new() { ["version"] = 1, ["family"] = family, ["mode"] = mode, ["scope"] = scope, ["host"] = host, ["request"] = request.DeepClone(), ["options"] = options?.DeepClone() ?? new JsonObject(), ["context"] = new JsonObject { ["dataRoot"] = dataRoot, ["runtimeRoot"] = runtimeRoot ?? "" } };
    internal static System.Diagnostics.ProcessStartInfo StartInfo()
    {
        var executable = Environment.ProcessPath ?? throw Fail("MAC_PRIVATE_DIALOG_UNAVAILABLE");
        var start = new System.Diagnostics.ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false, true) };
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) start.ArgumentList.Add(Environment.GetCommandLineArgs()[0]);
        start.ArgumentList.Add("private-helper"); return start;
    }
    private const string DefaultProfile = "0000000000000000000000000000000000000000000000000000000000000000";
    private static string S(JsonNode? value) => value is JsonValue v && v.TryGetValue<string>(out var text) ? text : "";
    private static bool B(JsonNode? value) => value is JsonValue v && v.TryGetValue<bool>(out var result) && result;
    private static bool Profile(string value) => Regex.IsMatch(value, "\\A(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\\z");
    private static AgentFault Fail(string code) => new(code, "The private operation did not complete. No automatic retry was made.", false);
    private static JsonObject Good() => new() { ["ok"] = true };
    private static JsonObject? Credential(JsonNode? node)
    {
        if (node is not JsonObject credential) return null;
        var user = S(credential["username"]); var password = S(credential["password"]);
        if (user.Length is < 1 or > 1024 || user.Any(char.IsControl) || password.Length is < 1 or > 8192 || credential.Count != 2) throw Fail("CREDENTIAL_REQUEST_FAILED");
        return credential;
    }
    internal static async Task<JsonObject> ExecuteAsync(JsonObject envelope, CancellationToken token, Action? onVisible = null, IMacPrivateStore? testStore = null, MacDialogRunner? testDialog = null, MacBackendHttp? testHttp = null)
    {
        var family = S(envelope["family"]); var mode = S(envelope["mode"]); var scope = S(envelope["scope"]); var host = S(envelope["host"]);
        if (envelope["version"]?.GetValue<int>() != 1 || family is not ("credential" or "users") || !Regex.IsMatch(scope, "\\A[a-f0-9]{32}\\z")) throw Fail("PARAMS_INVALID");
        UsersKinds.Validate(new JsonObject { ["op"] = "status", ["host"] = host });
        var request = envelope["request"] as JsonObject ?? new JsonObject(); var options = envelope["options"] as JsonObject ?? new JsonObject();
        var context = envelope["context"] as JsonObject ?? throw Fail("PARAMS_INVALID");
        var dataRoot = S(context["dataRoot"]); var runtimeRoot = S(context["runtimeRoot"]);
        if (!Path.IsPathRooted(dataRoot)) throw Fail("PARAMS_INVALID");
        var store = testStore ?? new MacKeychain(scope);
        MacDialogRunner dialog = testDialog ?? ((model, accept, ct, visible) => MacPrivateDialog.RunAsync(MacPrivateDialog.Resolve(runtimeRoot, dataRoot), model, accept, ct, visible));
        MacBackendHttp http = testHttp ?? MacCredentialAuth.SendAsync;
        var prefix = "SSAM/Agent/" + scope[..16] + "/" + scope[16..] + "/";
        try {
            return family == "credential" ? await Credentials(mode, host, prefix, request, options, store, dialog, http, token, onVisible) : await Users(mode, host, prefix, request, options, store, dialog, http, token, onVisible);
        } catch (AgentFault error) {
            var code = error.Code.StartsWith("MAC_KEYCHAIN", StringComparison.Ordinal) ? (error.Code == "MAC_KEYCHAIN_LOCKED" ? "CREDENTIAL_PERMISSION_DENIED" : "CREDENTIAL_STORE_FAILED") : error.Code == "MAC_PRIVATE_DIALOG_UNAVAILABLE" ? "CREDENTIAL_PROMPT_FAILED" : error.Code;
            return new JsonObject { ["ok"] = false, ["code"] = family == "users" && !code.StartsWith("USERS_", StringComparison.Ordinal) ? "USERS_PRIVATE_REQUEST_FAILED" : code };
        }
    }
    private static JsonObject Model(string form, string host, string service, string auth = "credential") => new() { ["form"] = form, ["host"] = host, ["service"] = service, ["auth"] = auth };
    private static JsonArray Profiles(IMacPrivateStore store, string prefix)
    {
        var result = new JsonArray();
        foreach (var item in store.List(prefix).Take(100)) {
            var profile = item.Name[prefix.Length..]; if (!Profile(profile)) continue;
            var credential = store.Read(item.Name); if (credential != null) result.Add((JsonNode)new JsonObject { ["profile"] = profile, ["principal"] = S(credential["username"]) });
        }
        return result;
    }
    private static async Task<JsonObject> Credentials(string mode, string host, string scopePrefix, JsonObject request, JsonObject options, IMacPrivateStore store, MacDialogRunner dialog, MacBackendHttp http, CancellationToken token, Action? visible)
    {
        var service = S(request["service"]); var auth = S(request["auth"]);
        if (service is not ("service-center" or "odc-portal") || (service == "odc-portal" ? auth is not ("credential" or "api-client") : auth is not ("credential" or "basic" or "service-token"))) throw Fail("CREDENTIAL_AUTH_UNSUPPORTED");
        var prefix = scopePrefix + "Credential/" + host + "/" + service + "/" + (auth == "basic" ? "credential" : auth) + "/";
        var profile = S(request["profile"]); if (profile.Length == 0) profile = S(store.Read(prefix + "selected")?["password"]); if (profile.Length == 0) profile = DefaultProfile;
        if (!Profile(profile)) throw Fail("CREDENTIAL_PROFILE_NOT_FOUND");
        var target = prefix + profile; var temporary = Credential(request["privateCredential"]);
        JsonObject? read() => temporary ?? store.Read(target);
        if (mode == "status") {
            var saved = read(); var result = Good(); result["available"] = saved != null; result["principal"] = saved == null ? null : S(saved["username"]); result["profile"] = profile; result["profiles"] = Profiles(store, prefix);
            result["authenticated"] = auth is not ("basic" or "service-token") && saved != null && SessionValid(request["privateSession"], profile, S(saved["username"])); return result;
        }
        if (mode == "sign-out") return new() { ["ok"] = true, ["signedOut"] = true, ["privateSession"] = null };
        if (mode == "forget") {
            var done = await dialog(Model("forget", host, service, auth), values => { if (!B(values["approved"])) return Task.FromResult<string?>("PRIVATE_DIALOG_INVALID_INPUT"); if (temporary == null) store.Delete(target); return Task.FromResult<string?>(null); }, token, visible);
            return done.Accepted ? new() { ["ok"] = true, ["forgotten"] = true, ["privateSession"] = null } : throw Fail("CREDENTIAL_CONFIRMATION_DECLINED");
        }
        if (mode == "prompt") {
            if (S(request["mode"]) == "select-profile") {
                var model = Model("profile", host, service, auth); var profiles = Profiles(store, prefix); model["profiles"] = profiles;
                if (profiles.Count == 0) throw Fail("CREDENTIAL_NOT_FOUND");
                string? principal = null; string? chosen = null;
                var done = await dialog(model, values => {
                    chosen = S(values["profile"]); var item = profiles.FirstOrDefault(p => S(p?["profile"]) == chosen); if (item == null) return Task.FromResult<string?>("PRIVATE_DIALOG_INVALID_INPUT");
                    principal = S(item["principal"]); store.Write(prefix + "selected", new JsonObject { ["username"] = "Selected profile", ["password"] = chosen }); return Task.FromResult<string?>(null);
                }, token, visible);
                return done.Accepted ? new() { ["ok"] = true, ["saved"] = true, ["remembered"] = true, ["profile"] = chosen, ["principal"] = principal } : Cancelled();
            }
            return await LoginPrompt(Model("login", host, service, auth), profile, target, store, dialog, token, visible);
        }
        var credential = read() ?? throw Fail("CREDENTIAL_NOT_FOUND");
        request = (JsonObject)request.DeepClone(); request["host"] = host; request["profile"] = profile;
        var jar = Cookies(request["privateSession"], host);
        if (mode == "login") return await MacCredentialAuth.LoginAsync(request, credential, jar, token);
        if (mode != "request") throw Fail("PARAMS_INVALID");
        var session = request["privateSession"];
        var staticAuth = auth is "basic" or "service-token";
        if (!staticAuth && !SessionValid(session, profile, S(credential["username"]))) throw Fail("CREDENTIAL_SIGN_IN_REQUIRED");
        var uri = new Uri(S(request["url"])); if (uri.Scheme != "https" || uri.Host != host || uri.Port != 443 || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0) throw Fail("PARAMS_INVALID");
        var authorization = auth == "basic" ? Convert.ToBase64String(Encoding.UTF8.GetBytes(S(credential["username"]) + ":" + S(credential["password"]))) : auth == "service-token" ? S(credential["password"]) : S(session?["token"]);
        var body = S(request["body"]); var bytes = body.Length == 0 ? null : Convert.FromBase64String(body);
        var headers = new Dictionary<string,string>();
        if (service == "odc-portal") { headers["Origin"] = "https://" + host; headers["outsystems-client-env"] = "browser"; var csrf = MacCredentialAuth.GetPortalCsrf(jar, uri); if (csrf.Length > 0) headers["x-csrftoken"] = csrf; }
        var response = await http(uri, S(request["method"]), jar, bytes, S(request["contentType"]), authorization, auth == "basic" ? "Basic" : "Bearer", token, headers);
        var cookies = CookieState(jar); var secrets = new JsonArray(S(credential["password"]), authorization);
        foreach (var cookie in cookies) if (CookieSensitivity.IsSensitive(S(cookie?["name"]), S(cookie?["value"]))) secrets.Add((JsonNode?)JsonValue.Create(S(cookie?["value"])));
        if (service == "odc-portal") secrets.Add((JsonNode?)JsonValue.Create(MacCredentialAuth.GetPortalCsrf(jar, uri)));
        return new() { ["ok"] = true, ["status"] = response.Status, ["body"] = Convert.ToBase64String(response.Body), ["contentType"] = response.ContentType, ["url"] = uri.AbsoluteUri, ["location"] = response.Location,
            ["secretValues"] = secrets, ["privateSession"] = staticAuth ? null : new JsonObject { ["profile"] = profile, ["principal"] = S(credential["username"]), ["cookies"] = cookies, ["token"] = authorization, ["expiresAt"] = session?["expiresAt"]?.DeepClone() } };
    }
    private static JsonObject Cancelled() => new() { ["ok"] = true, ["saved"] = false, ["remembered"] = false };
    private static async Task<JsonObject> LoginPrompt(JsonObject model, string? profile, string target, IMacPrivateStore store, MacDialogRunner dialog, CancellationToken token, Action? visible)
    {
        JsonObject? accepted = null; var remembered = false;
        var done = await dialog(model, values => {
            try { accepted = Credential(new JsonObject { ["username"] = S(values["username"]), ["password"] = S(values["password"]) }); } catch (AgentFault) { return Task.FromResult<string?>("PRIVATE_DIALOG_INVALID_INPUT"); }
            remembered = B(values["remember"]); if (remembered) store.Write(target, accepted!); return Task.FromResult<string?>(null);
        }, token, visible);
        if (!done.Accepted) return Cancelled();
        var result = new JsonObject { ["ok"] = true, ["saved"] = true, ["remembered"] = remembered, ["principal"] = S(accepted?["username"]) };
        if (profile != null) result["profile"] = profile;
        if (!remembered) result["privateCredential"] = accepted?.DeepClone(); return result;
    }
    private static bool SessionValid(JsonNode? session, string profile, string principal) => session is JsonObject && S(session["profile"]) == profile && S(session["principal"]) == principal && session["expiresAt"] is JsonValue expiry && expiry.TryGetValue<long>(out var ticks) && ticks > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && (S(session["token"]).Length > 0 || session["cookies"] is JsonArray { Count: > 0 });
    internal static CookieContainer Cookies(JsonNode? session, string host)
    {
        var jar = new CookieContainer(); if (session?["cookies"] is not JsonArray cookies) return jar;
        foreach (var item in cookies) { var cookie = new Cookie(S(item?["name"]), S(item?["value"]), S(item?["path"]).Length == 0 ? "/" : S(item?["path"]), host) { Secure = B(item?["secure"]), HttpOnly = B(item?["httpOnly"]) }; if (item?["expiresAt"] is JsonValue v && v.TryGetValue<long>(out var expiry)) cookie.Expires = DateTimeOffset.FromUnixTimeMilliseconds(expiry).UtcDateTime; jar.Add(cookie); } return jar;
    }
    internal static JsonArray CookieState(CookieContainer jar)
    {
        var result = new JsonArray(); foreach (Cookie cookie in jar.GetAllCookies()) if (!cookie.Expired) result.Add((JsonNode)new JsonObject { ["name"] = cookie.Name, ["value"] = cookie.Value, ["path"] = cookie.Path, ["secure"] = cookie.Secure, ["httpOnly"] = cookie.HttpOnly, ["expiresAt"] = cookie.Expires == DateTime.MinValue ? null : DateTimeOffset.Parse(cookie.Expires.ToUniversalTime().ToString("O")).ToUnixTimeMilliseconds() }); return result;
    }
    private static JsonArray Rows(JsonObject options, JsonObject request)
    {
        if (request["rows"] is JsonArray r) return (JsonArray)r.DeepClone();
        if (options["rows"] is JsonArray a) return (JsonArray)a.DeepClone();
        var encoded = S(options["rows"]); if (encoded.Length == 0) return new JsonArray();
        try { return JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(encoded))) as JsonArray ?? new JsonArray(); } catch (Exception e) when (e is FormatException or System.Text.Json.JsonException) { throw Fail("USERS_PRIVATE_REQUEST_FAILED"); }
    }
    private static async Task<JsonObject> Users(string mode, string host, string scopePrefix, JsonObject request, JsonObject options, IMacPrivateStore store, MacDialogRunner dialog, MacBackendHttp http, CancellationToken token, Action? visible)
    {
        var prefix = scopePrefix + "O11/"; var kind = S(options["kind"]); if (kind.Length == 0) kind = "login";
        var entry = S(options["entry"]); if (kind is not ("login" or "password") || kind == "password" && !Regex.IsMatch(entry, "\\A[a-f0-9]{64}\\z")) throw Fail("USERS_PRIVATE_REQUEST_FAILED");
        var target = prefix + host + (kind == "login" ? "/Users" : "/UsersPassword/" + entry);
        var temporary = Credential(request["privateCredential"]);
        JsonObject? login() => temporary ?? store.Read(prefix + host + "/Users");
        if (mode is not ("prompt" or "confirm")) {
            var installation = scopePrefix[..(scopePrefix.Length - 17)];
            foreach (var item in store.List(installation)) if (!item.Name.StartsWith(scopePrefix, StringComparison.Ordinal)) store.Delete(item.Name);
            foreach (var item in store.List(prefix)) if (item.Name.Contains("/UsersPassword/", StringComparison.Ordinal) && (mode == "sweep" || item.Written < DateTimeOffset.UtcNow.AddMinutes(-15))) store.Delete(item.Name);
        }
        if (mode == "sweep") return Good();
        if (mode == "hosts") { var hosts = new JsonArray(); foreach (var item in store.List(prefix)) if (item.Name.EndsWith("/Users", StringComparison.Ordinal)) hosts.Add((JsonNode?)JsonValue.Create(item.Name[prefix.Length..^6])); return new() { ["ok"] = true, ["hosts"] = hosts }; }
        if (mode == "status") { var saved = kind == "login" ? login() : store.Read(target); return new() { ["ok"] = true, ["available"] = saved != null, ["principal"] = kind == "login" && saved != null ? S(saved["username"]) : null }; }
        if (mode == "sign-out") { if (temporary == null) store.Delete(prefix + host + "/Users"); foreach (var item in store.List(prefix + host + "/UsersPassword/")) store.Delete(item.Name); return Good(); }
        if (mode == "forget") { if (kind != "password") throw Fail("USERS_PRIVATE_REQUEST_FAILED"); store.Delete(target); return Good(); }
        if (mode == "confirm") { var model = Model("approve", host, "users"); model["rows"] = Rows(options, request); var done = await dialog(model, values => Task.FromResult<string?>(B(values["approved"]) ? null : "PRIVATE_DIALOG_INVALID_INPUT"), token, visible); return new() { ["ok"] = true, ["approved"] = done.Accepted, ["timedOut"] = false }; }
        if (mode == "prompt") {
            if (kind == "login") return await LoginPrompt(Model("login", host, "users"), null, target, store, dialog, token, visible);
            var model = Model("password", host, "users"); model["rows"] = Rows(options, request);
            var done = await dialog(model, values => { var password = S(values["password"]); if (password.Length is < 1 or > 8192 || password != S(values["confirmation"])) return Task.FromResult<string?>("PASSWORD_MISMATCH"); store.Write(target, new JsonObject { ["username"] = S(options["subject"]), ["password"] = password }); return Task.FromResult<string?>(null); }, token, visible);
            return new() { ["ok"] = true, ["saved"] = done.Accepted };
        }
        var credential = login() ?? throw Fail("USERS_HOST_NOT_AUTHENTICATED");
        if (mode == "login") return await UsersLogin(host, credential, http, token);
        if (mode != "request") throw Fail("USERS_PRIVATE_REQUEST_FAILED");
        var uri = new Uri(S(request["url"])); var method = S(request["method"]);
        if (uri.Scheme != "https" || uri.Host != host || uri.Port != 443 || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 || !Regex.IsMatch(uri.AbsolutePath, "\\A/Users/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\\.aspx)?\\z") || method is not ("GET" or "POST")) throw Fail("USERS_PRIVATE_REQUEST_FAILED");
        var fields = new List<KeyValuePair<string, string>>(); foreach (var pair in request["fields"] as JsonArray ?? new JsonArray()) if (pair is JsonArray { Count: 2 }) fields.Add(new(S(pair[0]), S(pair[1]))); else throw Fail("USERS_PRIVATE_REQUEST_FAILED");
        var secrets = new List<string> { S(credential["password"]) };
        foreach (var reference in request["secretRefs"] as JsonArray ?? new JsonArray()) {
            var field = S(reference?["field"]); var referenceEntry = S(reference?["entry"]);
            if (method != "POST" || S(reference?["kind"]) != "password" || S(reference?["part"]) != "password" || !Regex.IsMatch(referenceEntry, "\\A[a-f0-9]{64}\\z") || !Regex.IsMatch(field, "(?:^|[$_])wt(?:Password|ConfirmPassword|NewPassword)Input$") || !Regex.IsMatch(uri.AbsolutePath, "\\A/Users/(?:User_Edit|User_Show)\\.aspx\\z")) throw Fail("USERS_PRIVATE_REQUEST_FAILED");
            var saved = store.Read(prefix + host + "/UsersPassword/" + referenceEntry) ?? throw Fail("USERS_PRIVATE_REQUEST_FAILED"); var password = S(saved["password"]); secrets.Add(password); fields.Add(new(field, password));
        }
        var jar = new CookieContainer(); if (S(request["cookie"]).Length > 0) jar.SetCookies(uri, S(request["cookie"]).Replace("; ", ", "));
        foreach (Cookie cookie in jar.GetAllCookies()) secrets.Add(cookie.Value);
        var bytes = method == "POST" ? await new FormUrlEncodedContent(fields).ReadAsByteArrayAsync(token) : null;
        var response = await http(uri, method, jar, bytes, "application/x-www-form-urlencoded", "", "Bearer", token, null);
        if (response.Body.Length > 262144) throw Fail("USERS_PAGE_TOO_LARGE");
        foreach (Cookie cookie in jar.GetAllCookies()) secrets.Add(cookie.Value);
        var body = Encoding.UTF8.GetString(response.Body); var location = response.Location;
        // A cookie may be replaced by this response. Keep both generations in the guard.
        // Exact canonical MIME constants are public protocol metadata, never echoed opaque data.
        if (CredentialKinds.RedactText(secrets, body) != body || CredentialKinds.RedactText(secrets, location) != location ||
            CredentialKinds.ResponseType(response.ContentType) != response.ContentType && CredentialKinds.RedactText(secrets, response.ContentType) != response.ContentType)
            throw Fail("USERS_PRIVATE_RESPONSE_REFUSED");
        return new() { ["ok"] = true, ["status"] = response.Status, ["body"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(body)), ["location"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(location)), ["contentType"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(response.ContentType)), ["setCookie"] = UsersCookies(jar) };
    }
    private static JsonArray UsersCookies(CookieContainer jar) { var result = new JsonArray(); foreach (Cookie cookie in jar.GetAllCookies()) result.Add((JsonNode?)JsonValue.Create(Convert.ToBase64String(Encoding.UTF8.GetBytes(cookie.Name + "=" + cookie.Value + "; path=" + cookie.Path)))); return result; }
    private static string? Attr(string tag, string name) { var match = Regex.Match(tag, "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", RegexOptions.IgnoreCase); return match.Success ? WebUtility.HtmlDecode(match.Groups[1].Value + match.Groups[2].Value + match.Groups[3].Value) : null; }
    private static async Task<JsonObject> UsersLogin(string host, JsonObject credential, MacBackendHttp http, CancellationToken token)
    {
        var uri = new Uri("https://" + host + "/Users/Login.aspx"); var jar = new CookieContainer(); var page = await http(uri, "GET", jar, null, "", "", "Bearer", token, null);
        if (page.Body.Length > 262144) throw Fail("USERS_PAGE_TOO_LARGE");
        var html = Regex.Replace(Encoding.UTF8.GetString(page.Body), "<!--[\\s\\S]*?-->|<script\\b[\\s\\S]*?</script\\s*>", "", RegexOptions.IgnoreCase);
        var tags = Regex.Matches(html, "<input\\b(?:\"[^\"]*\"|'[^']*'|[^'\">])*>", RegexOptions.IgnoreCase).Select(m => m.Value).ToArray();
        var users = tags.Where(t => (Attr(t, "type") ?? "text").Equals("text", StringComparison.OrdinalIgnoreCase) && Attr(t, "name") != null).ToArray();
        var passwords = tags.Where(t => (Attr(t, "type") ?? "").Equals("password", StringComparison.OrdinalIgnoreCase)).ToArray();
        var buttons = tags.Where(t => (Attr(t, "type") ?? "").Equals("submit", StringComparison.OrdinalIgnoreCase) && Attr(t, "value") == "Log In").ToArray();
        if (users.Length != 1 || passwords.Length != 1 || buttons.Length != 1 || Attr(passwords[0], "name") == null || Attr(buttons[0], "name") == null) throw Fail("USERS_LOGIN_LAYOUT_CHANGED");
        var fields = tags.Where(t => (Attr(t, "type") ?? "").Equals("hidden", StringComparison.OrdinalIgnoreCase) && Attr(t, "name") != null).Select(t => new KeyValuePair<string,string>(Attr(t,"name")!, Attr(t,"value") ?? "")).ToList();
        fields.Add(new(Attr(users[0],"name")!,S(credential["username"]))); fields.Add(new(Attr(passwords[0],"name")!,S(credential["password"]))); fields.Add(new(Attr(buttons[0],"name")!,"Log In"));
        var body = await new FormUrlEncodedContent(fields).ReadAsByteArrayAsync(token); var response = await http(uri,"POST",jar,body,"application/x-www-form-urlencoded","","Bearer",token,null);
        if (response.Body.Length > 262144) throw Fail("USERS_PAGE_TOO_LARGE");
        var location = response.Location; var signed = jar.GetAllCookies().Count > 0 && (response.Status is >= 300 and < 400 ? location.Length > 0 && !location.Contains("Login.aspx",StringComparison.OrdinalIgnoreCase) && Uri.TryCreate(uri,location,out var next) && next.Host == host : response.Status == 200 && !Regex.IsMatch(Encoding.UTF8.GetString(response.Body),"type\\s*=\\s*[\"']?password",RegexOptions.IgnoreCase));
        return new() { ["ok"] = true, ["authenticated"] = signed, ["setCookie"] = UsersCookies(jar) };
    }
}
