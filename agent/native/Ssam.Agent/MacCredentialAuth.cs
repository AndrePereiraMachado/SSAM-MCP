using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal sealed record MacHttpResponse(int Status, byte[] Body, string ContentType, string Location)
{
    internal string Text => Encoding.UTF8.GetString(Body);
}

// Portable counterpart of credential-auth.ps1. This code parses protocol data;
// it never evaluates a downloaded script or follows an unvalidated redirect.
internal static class MacCredentialAuth
{
    private const string Identity = "https://id.outsystems.com";
    private static AgentFault Fault(string code) => new(code, "Private authentication did not complete.");
    private static string S(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
    private static bool B(JsonNode? n, bool value = true) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b == value;
    private static double N(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : double.NaN;
    private static JsonObject O(params (string Key, object? Value)[] fields)
    {
        var result = new JsonObject();
        foreach (var (key, value) in fields) result[key] = value switch {
            null => null, JsonNode node => node.DeepClone(), string s => JsonValue.Create(s),
            bool b => JsonValue.Create(b), int i => JsonValue.Create(i), long l => JsonValue.Create(l),
            double d => JsonValue.Create(d), _ => throw Fault("CREDENTIAL_AUTH_RESPONSE_INVALID") };
        return result;
    }
    private static IEnumerable<string> Strings(JsonNode? n) => n is JsonArray a ? a.Select(S) : [S(n)];
    private static Match M(string text, string pattern) => Regex.Match(text, pattern, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(2));
    private static MatchCollection Matches(string text, string pattern) => Regex.Matches(text, pattern, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(2));
    private static string Form(IEnumerable<KeyValuePair<string, string>> fields) => string.Join("&", fields.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value)));
    private static Dictionary<string, string> Query(Uri uri)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)) {
            var pair = part.Split('=', 2); var key = Uri.UnescapeDataString(pair[0].Replace('+', ' '));
            if (!result.TryAdd(key, pair.Length == 2 ? Uri.UnescapeDataString(pair[1].Replace('+', ' ')) : "")) throw Fault("CREDENTIAL_AUTH_STATE_INVALID");
        }
        return result;
    }
    private static string Q(Dictionary<string, string> q, string key) => q.GetValueOrDefault(key, "");
    private static Uri WithQuery(Uri uri, Dictionary<string, string> fields) => new UriBuilder(uri) { Query = Form(fields) }.Uri;
    private static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Unbase64(string s) {
        if (!M(s, "^[A-Za-z0-9_-]+$").Success) throw Fault("CREDENTIAL_IDENTITY_TOKEN_INVALID");
        return Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/') + new string('=', (4 - s.Length % 4) % 4));
    }
    internal static bool IsPublicAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        var b = address.GetAddressBytes();
        if (b.Length == 4) return !(b[0] is 0 or 10 or 127 || b[0] >= 224 || b[0] == 100 && b[1] is >= 64 and <= 127 ||
            b[0] == 169 && b[1] == 254 || b[0] == 172 && b[1] is >= 16 and <= 31 ||
            b[0] == 192 && (b[1] == 168 || b[1] == 0 && b[2] == 0) || b[0] == 198 && b[1] is 18 or 19);
        return b[0] is >= 0x20 and <= 0x3f && !(b[0] == 0x20 && b[1] == 2);
    }
    internal static Uri ValidateUri(string host, string value, Uri? basis = null)
    {
        if (M(value.Split('?')[0], @"(?i)%2e|%2f|%5c|\\").Success ||
            !(basis is null ? Uri.TryCreate(value, UriKind.Absolute, out var uri) : Uri.TryCreate(basis, value, out uri)) ||
            uri.Scheme != "https" || uri.Port != 443 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 ||
            uri.Host != host && uri.Host != "id.outsystems.com" && uri.Host != "cognito-idp.us-east-1.amazonaws.com") throw Fault("CREDENTIAL_AUTH_ORIGIN_REFUSED");
        return uri;
    }
    internal static Task<MacHttpResponse> SendAsync(Uri uri, string method, CookieContainer jar, byte[]? body,
        string? contentType, string? token, string authorizationScheme, CancellationToken ct, IReadOnlyDictionary<string, string>? headers = null)
    {
        var combined = headers is null ? new Dictionary<string, string>() : new Dictionary<string, string>(headers);
        if (!string.IsNullOrEmpty(token)) combined["Authorization"] = authorizationScheme + " " + token;
        return Http(uri, method, jar, body, contentType, combined, ct);
    }

    private static async Task<MacHttpResponse> Http(Uri uri, string method, CookieContainer jar, byte[]? body,
        string? contentType, Dictionary<string, string>? headers, CancellationToken ct)
    {
        ValidateUri(uri.Host, uri.OriginalString);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(45));
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false, CookieContainer = jar, UseCookies = true,
            ConnectCallback = async (context, cancellation) => {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellation);
                if (addresses.Length == 0 || addresses.Any(a => !IsPublicAddress(a))) throw Fault("CREDENTIAL_AUTH_ORIGIN_REFUSED");
                // Connect to the addresses that were checked: no second DNS resolution.
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp);
                try { await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, cancellation); return new NetworkStream(socket, true); }
                catch { socket.Dispose(); throw; }
            } };
        using var client = new HttpClient(handler);
        using var request = new HttpRequestMessage(new HttpMethod(method), uri);
        request.Headers.TryAddWithoutValidation("Accept", "application/json,text/html");
        request.Headers.TryAddWithoutValidation("User-Agent", "SSAM-Agent/1");
        if (headers is not null) foreach (var pair in headers) {
            if (pair.Value.Any(c => c is '\r' or '\n')) throw Fault("CREDENTIAL_AUTH_RESPONSE_INVALID");
            request.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
        }
        if (body is not null) { request.Content = new ByteArrayContent(body); request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType ?? "application/json"); }
        try {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.Content.Headers.ContentLength > 4194304) throw Fault("CREDENTIAL_AUTH_RESPONSE_TOO_LARGE");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var memory = new MemoryStream(); var buffer = new byte[65536]; int count;
            while ((count = await stream.ReadAsync(buffer, timeout.Token)) != 0) {
                if (memory.Length + count > 4194304) throw Fault("CREDENTIAL_AUTH_RESPONSE_TOO_LARGE");
                memory.Write(buffer, 0, count);
            }
            return new((int)response.StatusCode, memory.ToArray(), response.Content.Headers.ContentType?.ToString() ?? "", response.Headers.Location?.OriginalString ?? "");
        } catch (AgentFault) { throw; }
        catch (OperationCanceledException) { throw Fault("CREDENTIAL_AUTH_TIMEOUT"); }
        catch (Exception) { throw Fault("CREDENTIAL_AUTH_TRANSPORT_FAILED"); }
    }
    internal static string GetPortalCsrf(CookieContainer jar, Uri uri)
    {
        var cookies = jar.GetCookies(uri).Cast<Cookie>().ToArray();
        static bool Valid(string s) => s.Length is > 0 and <= 4096 && !M(s, @"[\x00-\x20\x7f;]").Success;
        var direct = cookies.Where(c => c.Name == "crf").ToArray();
        if (direct.Length == 1 && Valid(direct[0].Value)) return direct[0].Value;
        foreach (var cookie in cookies.Where(c => M(c.Name, "^nr2[^=]*$").Success)) {
            var m = M(Uri.UnescapeDataString(cookie.Value), "(?:^|;)crf=([^;]*)");
            if (m.Success && Valid(m.Groups[1].Value)) return m.Groups[1].Value;
        }
        return "";
    }
    internal delegate Task<MacHttpResponse> AuthTransport(Uri uri, string method, CookieContainer jar, byte[]? body, string? contentType, IReadOnlyDictionary<string, string>? headers, CancellationToken ct);
    private sealed class Context(string host, CookieContainer jar, CancellationToken ct, AuthTransport? transport = null)
    {
        internal readonly string Host = host;
        internal readonly CookieContainer Jar = jar;
        internal readonly HashSet<Uri> Visited = [];
        internal readonly HashSet<string> Secrets = new(StringComparer.Ordinal);
        internal Uri Uri(string value, Uri? basis = null) => ValidateUri(Host, value, basis);
        internal async Task<MacHttpResponse> Send(string value, string method = "GET", object? body = null,
            Dictionary<string, string>? headers = null, string contentType = "application/json") {
            var uri = Uri(value); byte[]? bytes = body switch { null => null, string s => Encoding.UTF8.GetBytes(s), JsonNode n => Encoding.UTF8.GetBytes(n.ToJsonString()), _ => throw Fault("CREDENTIAL_AUTH_RESPONSE_INVALID") };
            try {
                ct.ThrowIfCancellationRequested();
                var r = transport is null ? await Http(uri, method, Jar, bytes, contentType, headers, ct) : await transport(uri, method, Jar, bytes, contentType, headers, ct);
                if (r.Body.Length > 4194304) throw Fault("CREDENTIAL_AUTH_RESPONSE_TOO_LARGE");
                Visited.Add(uri);
                foreach (Cookie cookie in Jar.GetCookies(uri)) if (cookie.Value.Length != 0) Secrets.Add(cookie.Value);
                return r;
            } finally { if (bytes is not null) CryptographicOperations.ZeroMemory(bytes); }
        }
        internal async Task<JsonNode> Json(string value, string method = "GET", object? body = null,
            Dictionary<string, string>? headers = null, string contentType = "application/json") {
            var r = await Send(value, method, body, headers, contentType);
            if (r.Status is < 200 or >= 300) throw Fault("CREDENTIAL_LOGIN_FAILED");
            try { return JsonNode.Parse(r.Body) ?? throw Fault("CREDENTIAL_AUTH_RESPONSE_INVALID"); }
            catch (System.Text.Json.JsonException) { throw Fault("CREDENTIAL_AUTH_RESPONSE_INVALID"); }
        }
    }

    internal static JsonNode VerifyIdentityJwt(string token, JsonNode jwks, string issuer, string audience = "", string nonce = "", string subject = "")
    {
        try {
            if (token.Length > 20000) throw new FormatException(); var parts = token.Split('.');
            if (parts.Length != 3) throw new FormatException();
            var header = JsonNode.Parse(Unbase64(parts[0]))!; var claims = JsonNode.Parse(Unbase64(parts[1]))!;
            if (S(header["alg"]) != "RS256" || S(header["kid"]).Length == 0 || header.AsObject().Any(p => p.Key is "crit" or "jku" or "x5u")) throw new FormatException();
            var keys = (jwks["keys"]?.AsArray() ?? []).Where(k => S(k?["kid"]) == S(header["kid"]) && S(k?["kty"]) == "RSA" && S(k?["alg"]) is "" or "RS256" && S(k?["use"]) is "" or "sig").ToArray();
            if (keys.Length != 1) throw new FormatException();
            var modulus = Unbase64(S(keys[0]?["n"])); if (modulus.Length < 256) throw new FormatException();
            using var rsa = RSA.Create(); rsa.ImportParameters(new RSAParameters { Modulus = modulus, Exponent = Unbase64(S(keys[0]?["e"])) });
            if (!rsa.VerifyData(Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]), Unbase64(parts[2]), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new FormatException();
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (S(claims["iss"]) != issuer || S(claims["sub"]).Length == 0 || !double.IsFinite(N(claims["exp"])) || !double.IsFinite(N(claims["iat"])) || N(claims["exp"]) <= now || N(claims["iat"]) > now + 30 || claims["nbf"] is not null && (!double.IsFinite(N(claims["nbf"])) || N(claims["nbf"]) > now + 30)) throw new FormatException();
            var audiences = Strings(claims["aud"]).ToArray();
            if (audience.Length != 0 && (!audiences.Contains(audience) || S(claims["azp"]).Length != 0 && S(claims["azp"]) != audience || audiences.Length > 1 && S(claims["azp"]) != audience)) throw new FormatException();
            if (nonce.Length != 0 && S(claims["nonce"]) != nonce || subject.Length != 0 && S(claims["sub"]) != subject) throw new FormatException();
            return claims;
        } catch (Exception) { throw Fault("CREDENTIAL_IDENTITY_TOKEN_INVALID"); }
    }
    private static async Task<JsonNode> Screen(Context c, string origin, string module, string view, string action, JsonObject? input = null, JsonObject? variables = null, string token = "")
    {
        var version = await c.Json($"{origin}/{module}/moduleservices/moduleversioninfo");
        if (S(version["versionToken"]).Length == 0) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
        var page = await c.Send($"{origin}/{module}/"); Uri? bundle = null;
        foreach (Match m in Matches(page.Text, "<script[^>]+src=[\"']([^\"']+)[\"']")) {
            var candidate = c.Uri(m.Groups[1].Value, new Uri($"{origin}/{module}/"));
            if (candidate.AbsolutePath.Contains("_osbundle-", StringComparison.Ordinal) && candidate.AbsolutePath.Contains(".index", StringComparison.Ordinal)) { bundle = candidate; break; }
        }
        if (bundle is null || bundle.GetLeftPart(UriPartial.Authority) != origin) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
        var entry = await c.Send(bundle.AbsoluteUri); var actual = view;
        if (!M(entry.Text, "screenName:[\"']" + Regex.Escape(view) + "[\"']").Success && view.StartsWith(module + ".", StringComparison.Ordinal)) actual = view[(module.Length + 1)..];
        var lazy = M(entry.Text, "screenName:[\"']" + Regex.Escape(actual) + "[\"'][\\s\\S]{0,400}?import\\([\"']([^\"']+)[\"']");
        if (!lazy.Success) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
        var queue = new Queue<Uri>(); queue.Enqueue(c.Uri(lazy.Groups[1].Value, bundle)); var seen = new HashSet<Uri>(); string? apiVersion = null; var bytes = 0;
        while (queue.Count != 0 && seen.Count < 48) {
            var uri = queue.Dequeue(); if (seen.Contains(uri) || uri.GetLeftPart(UriPartial.Authority) != origin || !uri.AbsolutePath.StartsWith($"/{module}/scripts/", StringComparison.Ordinal) || !uri.AbsolutePath.EndsWith(".js", StringComparison.Ordinal)) continue;
            seen.Add(uri); var code = await c.Send(uri.AbsoluteUri); bytes += code.Body.Length;
            if (bytes > 16000000) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
            var match = M(code.Text, "[\"']screenservices/" + Regex.Escape(action) + "[\"']\\s*,\\s*[\"']([^\"']+)[\"']");
            if (match.Success) { apiVersion = match.Groups[1].Value; break; }
            foreach (Match m in Matches(code.Text, "(?:from\\s*|import\\s*\\()[\"'](\\./[^\"']+\\.js)[\"']")) queue.Enqueue(c.Uri(m.Groups[1].Value, uri));
        }
        if (apiVersion is null) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
        var headers = new Dictionary<string, string> { ["Origin"] = origin, ["Referer"] = $"{origin}/{module}/", ["outsystems-client-env"] = "browser" };
        if (token.Length != 0) headers["Authorization"] = "Bearer " + token;
        var csrf = GetPortalCsrf(c.Jar, new Uri($"{origin}/{module}/")); if (csrf.Length != 0) { headers["x-csrftoken"] = csrf; c.Secrets.Add(csrf); }
        var answer = await c.Json($"{origin}/{module}/screenservices/{action}", "POST", O(("versionInfo", O(("moduleVersion", S(version["versionToken"])), ("apiVersion", apiVersion))), ("viewName", view), ("inputParameters", input ?? new()), ("screenData", O(("variables", variables ?? new()))), ("clientVariables", new JsonObject())), headers);
        if (answer["exception"] is not null || answer["error"] is not null || B(answer["versionInfo"]?["hasApiVersionChanged"]) || B(answer["versionInfo"]?["hasModuleVersionChanged"])) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
        return answer;
    }
    private static async Task<Uri> IdentityRedirects(Context c, Uri start, Func<Uri, bool> stop)
    {
        var next = start;
        for (var hop = 0; hop < 8; hop++) {
            if (stop(next)) return next; next = c.Uri(next.AbsoluteUri);
            if (next.Host != "id.outsystems.com") throw Fault("CREDENTIAL_AUTH_ORIGIN_REFUSED");
            var r = await c.Send(next.AbsoluteUri);
            if (r.Status is not (302 or 303 or 307 or 308) || r.Location.Length == 0) throw Fault("CREDENTIAL_AUTH_REDIRECT_INCOMPLETE");
            next = new Uri(next, r.Location);
        }
        throw Fault("CREDENTIAL_AUTH_REDIRECT_LIMIT");
    }
    private static async Task<(JsonNode Tokens, JsonNode Endpoints)> CommunityIdentity(Context c, string username, string password)
    {
        const string client = "client_runtime";
        var d = await c.Json(Identity + "/identity/.well-known/openid-configuration"); var issuer = c.Uri(S(d["issuer"]));
        if (issuer.Host != "id.outsystems.com" || !M(issuer.AbsolutePath, "^/auth/realms/[a-f0-9-]{36}$").Success || issuer.Query.Length != 0) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        foreach (var (key, path) in new[] { ("authorization_endpoint", "auth"), ("token_endpoint", "token"), ("jwks_uri", "certs") }) {
            var uri = c.Uri(S(d[key])); if (uri.Host != "id.outsystems.com" || uri.AbsolutePath != issuer.AbsolutePath + "/protocol/openid-connect/" + path || uri.Query.Length != 0) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        }
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32)); var state = Base64Url(RandomNumberGenerator.GetBytes(24)); var nonce = Base64Url(RandomNumberGenerator.GetBytes(24));
        var start = WithQuery(c.Uri(S(d["authorization_endpoint"])), new() { ["client_id"] = client, ["scope"] = "openid", ["redirect_uri"] = Identity + "/identity", ["response_type"] = "code", ["kc_idp_hint"] = "os-builtin", ["code_challenge"] = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))), ["code_challenge_method"] = "S256", ["state"] = state, ["nonce"] = nonce });
        var landing = await IdentityRedirects(c, start, u => u.GetLeftPart(UriPartial.Authority) == "https://os-community-id.outsystems.app" && u.AbsolutePath == "/identity" && Q(Query(u), "redirect_uri").Length != 0);
        var landingQuery = Query(landing); var resume = c.Uri(Q(landingQuery, "redirect_uri"));
        if (resume.Host != "id.outsystems.com" || resume.AbsolutePath != issuer.AbsolutePath + "/broker/os-builtin/endpoint" || Q(landingQuery, "state").Length == 0) throw Fault("CREDENTIAL_AUTH_STATE_INVALID");
        var config = await c.Json(Identity + "/community/moduleservices/auth/configs");
        var providers = (config["authConfigurations"]?.AsArray() ?? []).Where(p => S(p?["type"]) == "cognito" && S(p?["kc_hint"]) == "os-builtin").ToArray();
        if (providers.Length != 1) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED"); var provider = providers[0]?["configs"];
        if (S(provider?["authFlow"]) != "USER_PASSWORD_AUTH" || S(provider?["region"]) != "us-east-1" || !M(S(provider?["poolId"]), "^us-east-1_[A-Za-z0-9]+$").Success || !M(S(provider?["amplifyClientId"]), "^[a-z0-9]{10,128}$").Success) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        var cognito = await c.Json("https://cognito-idp.us-east-1.amazonaws.com/", "POST", O(("AuthFlow", "USER_PASSWORD_AUTH"), ("ClientId", S(provider?["amplifyClientId"])), ("AuthParameters", O(("USERNAME", username), ("PASSWORD", password)))), new() { ["X-Amz-Target"] = "AWSCognitoIdentityProviderService.InitiateAuth" }, "application/x-amz-json-1.1");
        if (S(cognito["ChallengeName"]).Length != 0) throw Fault("CREDENTIAL_AUTH_INTERACTIVE_REQUIRED"); var ct = cognito["AuthenticationResult"];
        foreach (var key in new[] { "AccessToken", "IdToken", "RefreshToken" }) { var value = S(ct?[key]); if (value.Length is < 10 or > 20000 || value.Any(ch => ch is '\r' or '\n')) throw Fault("CREDENTIAL_IDENTITY_TOKEN_INVALID"); c.Secrets.Add(value); }
        var stored = await c.Json(Identity + "/identityapi/v1alpha1/oidc/store-token", "POST", O(("clientId", S(provider?["amplifyClientId"])), ("idToken", S(ct?["IdToken"])), ("accessToken", S(ct?["AccessToken"])), ("refreshToken", S(ct?["RefreshToken"]))));
        if (S(stored["authCode"]).Length == 0) throw Fault("CREDENTIAL_AUTH_RESPONSE_INVALID"); c.Secrets.Add(S(stored["authCode"]));
        var fields = Query(resume); fields["code"] = S(stored["authCode"]); fields["state"] = Q(landingQuery, "state");
        var callback = await IdentityRedirects(c, WithQuery(resume, fields), u => u.GetLeftPart(UriPartial.Authority) == Identity && u.AbsolutePath == "/identity" && (Q(Query(u), "code").Length != 0 || Q(Query(u), "error").Length != 0));
        var query = Query(callback);
        if (Q(query, "state") != state || Q(query, "error").Length != 0 || Q(query, "code").Length == 0 || Q(query, "iss").Length != 0 && Q(query, "iss") != S(d["issuer"])) throw Fault("CREDENTIAL_AUTH_STATE_INVALID"); c.Secrets.Add(Q(query, "code"));
        var tokens = await c.Json(S(d["token_endpoint"]), "POST", Form(new Dictionary<string, string> { ["grant_type"] = "authorization_code", ["code"] = Q(query, "code"), ["client_id"] = client, ["redirect_uri"] = Identity + "/identity", ["code_verifier"] = verifier }), null, "application/x-www-form-urlencoded");
        if (!S(tokens["token_type"]).Equals("bearer", StringComparison.OrdinalIgnoreCase) || S(tokens["refresh_token"]).Length == 0) throw Fault("CREDENTIAL_IDENTITY_TOKEN_INVALID");
        foreach (var key in new[] { "access_token", "id_token", "refresh_token" }) c.Secrets.Add(S(tokens[key]));
        var jwks = await c.Json(S(d["jwks_uri"])); var identity = VerifyIdentityJwt(S(tokens["id_token"]), jwks, S(d["issuer"]), client, nonce);
        var access = VerifyIdentityJwt(S(tokens["access_token"]), jwks, S(d["issuer"]), subject: S(identity["sub"]));
        if (S(access["azp"]) != client) throw Fault("CREDENTIAL_IDENTITY_TOKEN_INVALID");
        var headers = new Dictionary<string, string> { ["Authorization"] = "Bearer " + S(tokens["access_token"]) };
        var profile = await c.Json(Identity + "/api/user-information/v1/profiles/me?embed=UserIdentityProviders", headers: headers);
        if (S(profile["id"]).Length == 0 || !S(profile["email"]).Trim().Equals(username.Trim(), StringComparison.OrdinalIgnoreCase)) throw Fault("CREDENTIAL_AUTH_PRINCIPAL_MISMATCH");
        var claims = await c.Json(Identity + "/api/user-information/v1/claims", headers: headers);
        if (!Strings(claims["claims"]).Contains("c089d722-19c8-4ed6-a329-cf2e78c54b56.ab2a6b39-1f30-4f20-a069-cf5d18b076f4")) throw Fault("CREDENTIAL_AUTH_ROLE_REQUIRED");
        var sync = await c.Send(Identity + "/community/moduleservices/users/userinfosync", "POST", headers: headers);
        if (sync.Status is not (200 or 204)) throw Fault("CREDENTIAL_LOGIN_FAILED"); return (tokens, d);
    }
    private static async Task<Uri> CommunityCallback(Context c, Uri login, string username, string password, bool serviceCenter = false)
    {
        login = c.Uri(login.AbsoluteUri); if (login.Host != "id.outsystems.com" || login.AbsolutePath != "/community/login") throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        var query = Query(login); var vars = new Dictionary<string, string>();
        foreach (var key in new[] { "response_type", "client_id", "scope", "code_challenge", "code_challenge_method", "redirect_uri", "state", "nonce", "login_hint" }) vars[key] = Q(query, key);
        var callback = c.Uri(vars["redirect_uri"]);
        if (callback.Host != c.Host || callback.Query.Length != 0 || vars["response_type"] != "code" || vars["code_challenge_method"] != "S256" || !M(vars["code_challenge"], "^[A-Za-z0-9_-]{43}$").Success || vars["state"].Length == 0 || vars["client_id"].Length == 0 || !vars["scope"].Split(' ').Contains("openid") || serviceCenter && callback.AbsolutePath != "/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx") throw Fault("CREDENTIAL_AUTH_STATE_INVALID");
        var identity = await CommunityIdentity(c, username, password); var variables = new JsonObject(); foreach (var p in vars) variables[p.Key] = p.Value;
        var answer = await Screen(c, Identity, "community", "Auth.login", "community/Auth/login/DataActionGetSessionData", variables: variables, token: S(identity.Tokens["access_token"])); var session = answer["data"];
        if (!B(session?["HasSession"]) || !B(session?["IsAuthorizedRedirect_Uri"])) throw Fault("CREDENTIAL_LOGIN_FAILED");
        if (!B(session?["NeedsToAcceptTerms"], false)) throw Fault("CREDENTIAL_AUTH_INTERACTIVE_REQUIRED");
        if (S(session?["AuthEndpointKC"]) != S(identity.Endpoints["authorization_endpoint"]) || S(session?["AuthRedirectUriKC"]) != Identity + "/community/rest/redirect/login") throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
        var fields = new Dictionary<string, string>(vars) { ["redirect_uri"] = S(session?["AuthRedirectUriKC"]), ["prompt"] = "none" }; var next = WithQuery(c.Uri(S(session?["AuthEndpointKC"])), fields);
        for (var hop = 0; hop < 8; hop++) {
            next = c.Uri(next.AbsoluteUri);
            if (next.Host == c.Host) { var q = Query(next); if (next.AbsolutePath != callback.AbsolutePath || Q(q, "state") != vars["state"] || Q(q, "code").Length == 0 || Q(q, "error").Length != 0) throw Fault("CREDENTIAL_AUTH_STATE_INVALID"); c.Secrets.Add(Q(q, "code")); return next; }
            if (next.Host != "id.outsystems.com" || next.AbsolutePath != c.Uri(S(identity.Endpoints["authorization_endpoint"])).AbsolutePath && next.AbsolutePath != "/community/rest/redirect/login") throw Fault("CREDENTIAL_AUTH_INTERACTIVE_REQUIRED");
            var r = await c.Send(next.AbsoluteUri); if (r.Status is not (302 or 303) || r.Location.Length == 0) throw Fault("CREDENTIAL_AUTH_INTERACTIVE_REQUIRED"); next = new Uri(next, r.Location);
        }
        throw Fault("CREDENTIAL_AUTH_REDIRECT_LIMIT");
    }
    private static async Task Portal(Context c, string username, string password)
    {
        var origin = "https://" + c.Host; var providers = await Screen(c, origin, "authentication", "UnifiedAuthentication.login", "authentication/UnifiedAuthentication/login/DataActionGetProviders"); var data = providers["data"];
        if (B(data?["CognitoEnabled"]) && S(data?["CognitoConfig"]?["AuthFlow"]) == "USER_SRP_AUTH") throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        var redirect = S(data?["RedirectNowUrl"]); if (redirect.Length == 0) redirect = S(data?["AuthUrlExternalProvider"]); if (redirect.Length == 0) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        var next = c.Uri(redirect, new Uri(origin)); Uri? login = null;
        for (var hop = 0; hop < 10; hop++) { next = c.Uri(next.AbsoluteUri); if (next.Host == "id.outsystems.com" && next.AbsolutePath == "/community/login") { login = next; break; } var r = await c.Send(next.AbsoluteUri); if (r.Status is not (302 or 303 or 307 or 308) || r.Location.Length == 0) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED"); next = new Uri(next, r.Location); }
        if (login is null) throw Fault("CREDENTIAL_AUTH_REDIRECT_LIMIT"); next = await CommunityCallback(c, login, username, password); Uri? complete = null;
        for (var hop = 0; hop < 10; hop++) { next = c.Uri(next.AbsoluteUri); if (next.Host != c.Host) throw Fault("CREDENTIAL_AUTH_ORIGIN_REFUSED"); if (next.AbsolutePath.StartsWith("/authentication/redirect", StringComparison.Ordinal) && Q(Query(next), "code").Length != 0) { complete = next; break; } var r = await c.Send(next.AbsoluteUri); if (r.Status is not (302 or 303 or 307 or 308) || r.Location.Length == 0) throw Fault("CREDENTIAL_LOGIN_FAILED"); next = new Uri(next, r.Location); }
        if (complete is null) throw Fault("CREDENTIAL_AUTH_REDIRECT_LIMIT"); var q = Query(complete); c.Secrets.Add(Q(q, "code"));
        await Screen(c, origin, "authentication", "UnifiedAuthentication.redirect", "authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect", O(("Code", Q(q, "code")), ("State", Q(q, "state")), ("IsFirstLogin", false), ("IsRest", false), ("BId", "")));
        var proof = await Screen(c, origin, "connections", "Connections.connections", "connections/Connections/connections/DataActionGetProviders");
        if (proof["data"]?["Providers"] is not JsonArray && proof["data"]?["Providers"]?["List"] is not JsonArray) throw Fault("CREDENTIAL_AUTH_CONTRACT_CHANGED");
    }
    private sealed class HtmlNode(string tag, Dictionary<string, string> attrs, HtmlNode? parent, string source, int start)
    {
        internal readonly string Tag = tag;
        internal readonly Dictionary<string, string> Attrs = attrs;
        internal readonly HtmlNode? Parent = parent;
        internal int End = source.Length;
        internal string A(string name) => Attrs.GetValueOrDefault(name, "");
        internal bool Within(HtmlNode ancestor) { for (HtmlNode? n = this; n is not null; n = n.Parent) if (ReferenceEquals(n, ancestor)) return true; return false; }
        internal string Caption => Tag == "input" ? A("value") : WebUtility.HtmlDecode(Regex.Replace(source[start..Math.Max(start, End)], "<[^>]+>", "", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(2))).Trim();
    }
    private static List<HtmlNode> Html(string html)
    {
        var clean = Regex.Replace(html, @"<!--[\s\S]*?-->|<script\b[\s\S]*?</script\s*>", "", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(2));
        var nodes = new List<HtmlNode>(); var stack = new List<HtmlNode>();
        foreach (Match match in Matches(clean, "<(/?)([A-Za-z][A-Za-z0-9:-]*)\\b((?:\"[^\"]*\"|'[^']*'|[^'\">])*)>")) {
            var tag = match.Groups[2].Value.ToLowerInvariant();
            if (match.Groups[1].Value.Length != 0) { for (var i = stack.Count - 1; i >= 0; i--) { var node = stack[i]; node.End = match.Index; stack.RemoveAt(i); if (node.Tag == tag) break; } continue; }
            var attrs = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (Match a in Matches(match.Groups[3].Value, "([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+)))?"))
                if (!attrs.TryAdd(a.Groups[1].Value.ToLowerInvariant(), WebUtility.HtmlDecode(a.Groups[2].Value + a.Groups[3].Value + a.Groups[4].Value))) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED");
            var current = new HtmlNode(tag, attrs, stack.LastOrDefault(), clean, match.Index + match.Length); nodes.Add(current);
            if (!(new[] { "input", "br", "hr", "meta", "link", "img", "area", "base", "col", "embed", "param", "source", "track", "wbr" }).Contains(tag) && !match.Groups[3].Value.TrimEnd().EndsWith('/')) stack.Add(current);
        }
        return nodes;
    }
    internal sealed record LoginPlan(Uri Url, Dictionary<string, string> Fields, string User, string Password);
    internal static LoginPlan ParseLoginPlan(string html, Uri uri, bool sso = false)
    {
        var nodes = Html(html); var passwords = nodes.Where(n => n.Tag == "input" && n.A("type").Equals("password", StringComparison.OrdinalIgnoreCase)).ToArray();
        var buttons = nodes.Where(n => n.Tag is "input" or "button" && !n.Attrs.ContainsKey("disabled") && (n.Tag == "button" && n.A("type").Length == 0 || n.A("type").Equals("submit", StringComparison.OrdinalIgnoreCase)) && M(n.Caption, sso ? "(?i)log ?in with|single sign" : "(?i)^(?:Log in|Login|Sign in)$").Success).ToArray();
        if (buttons.Length != 1 || !sso && passwords.Length != 1) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED");
        var button = buttons[0]; var form = button.Parent; while (form is not null && form.Tag != "form") form = form.Parent;
        if (form is null || !form.A("method").Equals("post", StringComparison.OrdinalIgnoreCase) || button.A("formaction").Length != 0 || button.A("form").Length != 0 || M(button.A("onclick"), @"(?i)OsAjax|__doPostBack|\.submit\(").Success) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED");
        var action = ValidateUri(uri.Host, form.A("action"), uri);
        if (action.GetLeftPart(UriPartial.Authority) != uri.GetLeftPart(UriPartial.Authority) || action.AbsolutePath != "/ServiceCenter/Login.aspx") throw Fault("CREDENTIAL_AUTH_ORIGIN_REFUSED");
        HtmlNode? user = null;
        if (!sso) {
            var scopes = nodes.Where(n => n.Within(form) && M(n.A("class"), @"(?i)(?:^|\s)login-form(?:\s|$)").Success).ToArray();
            if (scopes.Length > 1) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED"); var scope = scopes.FirstOrDefault() ?? form;
            var users = nodes.Where(n => n.Tag == "input" && n.A("type").ToLowerInvariant() is "" or "text" or "email" && n.Within(scope)).ToArray();
            if (users.Length != 1 || !passwords[0].Within(scope) || !button.Within(scope)) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED"); user = users[0];
            if (user.A("name").Length == 0 || passwords[0].A("name").Length == 0 || user.A("name") == passwords[0].A("name")) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED");
        }
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in nodes) {
            if (!n.Within(form) || n.Tag is not ("input" or "button" or "select" or "textarea") || n.A("name").Length == 0 || n.Attrs.ContainsKey("disabled")) continue;
            if (n.A("form").Length != 0 || n.Tag is "select" or "textarea") throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED"); var type = n.A("type").ToLowerInvariant();
            if (type is "reset" or "button" or "file" or "image" || type is "checkbox" or "radio" && !n.Attrs.ContainsKey("checked") || (n.Tag == "button" || type == "submit") && !ReferenceEquals(n, button)) continue;
            if (!fields.TryAdd(n.A("name"), n.A("value"))) throw Fault("CREDENTIAL_LOGIN_LAYOUT_CHANGED");
        }
        return new(action, fields, user?.A("name") ?? "", sso ? "" : passwords[0].A("name"));
    }
    internal static bool ProtectedServiceCenter(string html)
    {
        var nodes = Html(html);
        if (nodes.Any(n => n.Tag == "form" && M(n.A("action"), @"(?i)(?:^|/)_?login(?:sso)?\.aspx(?:\?|$)").Success || M(n.A("class"), @"(?i)(?:^|\s)sc-layout-login(?:\s|$)").Success)) return false;
        return nodes.Any(n => n.Tag is "a" or "button" or "input" && (M(n.A("href") + " " + n.A("onclick"), "(?i)logout").Success || M(n.Caption, "(?i)^log ?out$").Success));
    }
    private static async Task ServiceCenter(Context c, string username, string password)
    {
        var start = c.Uri("https://" + c.Host + "/ServiceCenter/Login.aspx"); var r = await c.Send(start.AbsoluteUri); var usedPassword = false;
        if (r.Status == 200 && !ProtectedServiceCenter(r.Text)) {
            var hasPassword = Html(r.Text).Any(n => n.Tag == "input" && n.A("type").Equals("password", StringComparison.OrdinalIgnoreCase));
            var plan = ParseLoginPlan(r.Text, start, !hasPassword);
            if (hasPassword) { plan.Fields[plan.User] = username; plan.Fields[plan.Password] = password; usedPassword = true; }
            r = await c.Send(plan.Url.AbsoluteUri, "POST", Form(plan.Fields), contentType: "application/x-www-form-urlencoded");
        }
        if (r.Status is 302 or 303 && r.Location.Length != 0) {
            var next = c.Uri(r.Location, start);
            if (next.Host == "id.outsystems.com") { if (usedPassword) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED"); next = await CommunityCallback(c, next, username, password, true); }
            for (var hop = 0; hop < 8; hop++) {
                next = c.Uri(next.AbsoluteUri); if (next.Host != c.Host || !next.AbsolutePath.StartsWith("/ServiceCenter/", StringComparison.Ordinal)) throw Fault("CREDENTIAL_AUTH_ORIGIN_REFUSED");
                r = await c.Send(next.AbsoluteUri); if (r.Status is not (302 or 303) || r.Location.Length == 0) break; next = new Uri(next, r.Location);
            }
        }
        var proof = await c.Send("https://" + c.Host + "/ServiceCenter/Error_Logs.aspx");
        if (proof.Status != 200 || !ProtectedServiceCenter(proof.Text)) throw Fault("CREDENTIAL_LOGIN_FAILED");
    }
    internal static async Task<JsonObject> LoginAsync(JsonObject request, JsonObject credential, CookieContainer jar, CancellationToken ct, AuthTransport? transport = null)
    {
        try { return await LoginCore(request, credential, jar, ct, transport); }
        catch (AgentFault) { throw; }
        catch (OperationCanceledException) { throw Fault("CREDENTIAL_AUTH_TIMEOUT"); }
        catch (Exception) { throw Fault("CREDENTIAL_LOGIN_FAILED"); }
    }
    private static async Task<JsonObject> LoginCore(JsonObject request, JsonObject credential, CookieContainer jar, CancellationToken ct, AuthTransport? transport)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(85));
        var c = new Context(S(request["host"]), jar, deadline.Token, transport);
        var username = S(credential["username"]); var password = S(credential["password"]);
        if (username.Length == 0 || password.Length == 0) throw Fault("CREDENTIAL_NOT_FOUND");
        c.Secrets.Add(password); string? token = null; var expires = DateTimeOffset.UtcNow.AddHours(8).ToUnixTimeMilliseconds();
        if (S(request["auth"]) == "api-client") {
            if (S(request["service"]) != "odc-portal") throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
            var discovery = await c.Json($"https://{c.Host}/identity/.well-known/openid-configuration");
            var endpoint = c.Uri(S(discovery["token_endpoint"]));
            if (endpoint.Host != c.Host || endpoint.Query.Length != 0 ||
                discovery["grant_types_supported"] is not null && !Strings(discovery["grant_types_supported"]).Contains("client_credentials") ||
                discovery["token_endpoint_auth_methods_supported"] is not null && !Strings(discovery["token_endpoint_auth_methods_supported"]).Contains("client_secret_post")) throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
            var result = await c.Json(endpoint.AbsoluteUri, "POST", Form(new Dictionary<string, string> { ["grant_type"] = "client_credentials", ["client_id"] = username, ["client_secret"] = password }), null, "application/x-www-form-urlencoded");
            token = S(result["access_token"]); var lifetime = N(result["expires_in"]);
            if (!S(result["token_type"]).Equals("Bearer", StringComparison.OrdinalIgnoreCase) || token.Length is 0 or > 20000 || token.Any(ch => ch is '\r' or '\n') || !double.IsFinite(lifetime) || lifetime <= 0) throw Fault("CREDENTIAL_LOGIN_FAILED");
            try { expires = DateTimeOffset.UtcNow.AddSeconds(lifetime).ToUnixTimeMilliseconds(); } catch (ArgumentOutOfRangeException) { throw Fault("CREDENTIAL_LOGIN_FAILED"); }
            c.Secrets.Add(token);
        } else if (S(request["service"]) == "service-center") await ServiceCenter(c, username, password);
        else if (S(request["service"]) == "odc-portal") await Portal(c, username, password);
        else throw Fault("CREDENTIAL_AUTH_UNSUPPORTED");
        var cookies = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var uri in c.Visited.Where(u => u.Host == c.Host)) foreach (Cookie cookie in jar.GetCookies(uri)) {
            if (cookie.Expired) continue; c.Secrets.Add(cookie.Value);
            cookies[cookie.Name + "|" + cookie.Path] = O(("name", cookie.Name), ("value", cookie.Value), ("path", cookie.Path), ("secure", cookie.Secure), ("httpOnly", cookie.HttpOnly), ("expiresAt", cookie.Expires == DateTime.MinValue ? null : new DateTimeOffset(cookie.Expires.ToUniversalTime()).ToUnixTimeMilliseconds()));
        }
        if (token is null && cookies.Count == 0) throw Fault("CREDENTIAL_LOGIN_FAILED");
        return O(("ok", true), ("authenticated", true), ("principal", username),
            ("privateSession", O(("profile", request["profile"]), ("principal", username), ("cookies", new JsonArray(cookies.Values.Select(v => (JsonNode)v).ToArray())), ("token", token), ("expiresAt", expires))),
            ("secretValues", new JsonArray(c.Secrets.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray())));
    }
}
