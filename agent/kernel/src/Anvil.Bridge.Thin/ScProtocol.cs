using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Bridge;

// Service Center verbs (sc_api, sc_web, studio_login, sc_session): the contract parts that need no Studio type, so the
// tests compile this file as is. Contract: _notes/scp/CONTRATO.md of the integration, O11 section.

internal static class ScCodes
{
    public const string StudioNotSignedIn = "STUDIO_NOT_SIGNED_IN";
    public const string WebSignInRequired = "WEB_SIGN_IN_REQUIRED";
    public const string NotAllowed = "NOT_ALLOWED";
    public const string HostMismatch = "HOST_MISMATCH";
    public const string Uncertain = "UNCERTAIN";
    public const string RemoteError = "REMOTE_ERROR";
    public const string BadRequest = "BAD_REQUEST";
    public const string StudioUnavailable = "STUDIO_UNAVAILABLE";
    /// <summary>A secretRefs entry is missing from the Windows vault (the answer names the target, never a value).</summary>
    public const string SecretNotFound = "SECRET_NOT_FOUND";
    /// <summary>sc_web login: the sign-in form answered the stored login with the form again (wrong e-mail or password).
    /// It is never resubmitted (account lockout): the user stores the login again.</summary>
    public const string WebLoginRejected = "WEB_LOGIN_REJECTED";
    /// <summary>sc_web login: the sign-in needs the user (an identity provider SSAM does not fill, MFA, a consent page).</summary>
    public const string WebSignInInteractive = "WEB_SIGN_IN_INTERACTIVE";
    /// <summary>sc_web login {session:"studio"}: the Studio's own session (its browser profile's single sign-on) did not
    /// sign the window in and the page asks for a typed login; nothing was typed and the vault was not read.</summary>
    public const string WebSignInNeedsLogin = "WEB_SIGN_IN_NEEDS_LOGIN";
    /// <summary>D5 (atritos 3): this Service Studio process has no main window left (the user closed it); SSAM ignores it
    /// and the Studio with a window is the one of the lane.</summary>
    public const string StudioWindowless = "STUDIO_WINDOWLESS";
}

/// <summary>
/// D5 of the atritos 3 package (session of 2026-10-06 22:58Z): the user closed the Studio's main window, the hidden Service
/// Center window of SSAM stayed open (CEF needs a shown window, off screen, out of the taskbar) with its keep-alive timer,
/// so the process never ended and kept the O11 lane; the next sign-in failed with "the Studio has no window". The rule: a
/// Service Center window lives only while the Studio has a main window. Each window registers how it closes itself (and
/// stops its keep-alive); the first observation of the Studio without any main window runs every closer once, and from
/// then on a window is never opened again (STUDIO_WINDOWLESS). The process may then end as the Studio meant it to. Pure:
/// the handler (ScWebHandler) counts the Studio's windows on its UI thread and calls Observe.
/// </summary>
internal sealed class ScWindowLifetime
{
    private readonly object gate = new();
    private readonly List<Action> closers = new();
    private bool ownerGone;

    /// <summary>The Studio's main window was seen gone: no Service Center window may live in this process any more.</summary>
    public bool OwnerGone { get { lock (gate) return ownerGone; } }

    /// <summary>Registers what closes one window. After the owner is gone it runs at once and answers false.</summary>
    public bool Register(Action close)
    {
        lock (gate) { if (!ownerGone) { closers.Add(close); return true; } }
        Run(close);
        return false;
    }

    /// <summary>A window that closed by itself (the close action of the user or of sc_web close) leaves the list.</summary>
    public void Unregister(Action close) { lock (gate) closers.Remove(close); }

    /// <summary>One look at the Studio: studioWindows is the number of its main windows. The first look with none closes
    /// every registered window once and answers true; any later look answers false.</summary>
    public bool Observe(int studioWindows)
    {
        Action[] run;
        lock (gate)
        {
            if (ownerGone || studioWindows > 0) return false;
            ownerGone = true;
            run = closers.ToArray();
            closers.Clear();
        }
        foreach (var close in run) Run(close);
        return true;
    }

    /// <summary>Whether a window may open (or its keep-alive run) now.</summary>
    public bool MayOpen(int studioWindows) => !Observe(studioWindows) && !OwnerGone;

    private static void Run(Action close) { try { close(); } catch (Exception) { /* a window already gone */ } }

    /// <summary>The refusal of a call that needs the Studio's window in a process that has none.</summary>
    public static ScFailure Windowless(int pid, string what) => new(ScCodes.StudioWindowless,
        $"{what}: Service Studio {pid} has no main window (it was closed); SSAM ignores this process and never closes or ends a Studio. Open Service Studio normally and connect it (ssam_connect {{lane:\"o11\"}}); nothing was sent",
        details: new JsonObject { ["pid"] = pid, ["windowless"] = true });
}

/// <summary>A refusal or failure with its contract code. Sent=false means nothing left the Studio for this request.</summary>
internal sealed class ScFailure(string code, string message, bool sent = false, JsonObject? details = null) : Exception(message)
{
    public string Code { get; } = code;
    public bool Sent { get; } = sent;
    public JsonObject? Details { get; } = details;
}

/// <summary>Bridge envelope {success, data, error} carrying the contract answer in data, on success and on failure.</summary>
internal static class ScReply
{
    public static string Ok(string source, string host, string? user, long elapsedMs, JsonObject body)
    {
        var data = new JsonObject { ["ok"] = true, ["source"] = source, ["host"] = host, ["user"] = user, ["elapsedMs"] = elapsedMs };
        foreach (var name in body.Select(p => p.Key).ToArray())
        {
            var value = body[name];
            body.Remove(name);
            data[name] = value;
        }
        return new JsonObject { ["success"] = true, ["data"] = data, ["error"] = null }.ToJsonString();
    }

    public static string Fail(ScFailure failure, string? secret = null)
    {
        var message = ScRedaction.Text(failure.Message, secret);
        var data = new JsonObject { ["ok"] = false, ["code"] = failure.Code, ["message"] = message };
        if (failure.Details != null)
            foreach (var (name, value) in failure.Details) data[name] = ScRedaction.Node(value?.DeepClone(), secret);
        var reply = new JsonObject { ["success"] = false, ["data"] = data, ["error"] = failure.Code + ": " + message, ["code"] = failure.Code };
        if (!failure.Sent) reply["executed"] = false;
        return reply.ToJsonString();
    }

    public static ScFailure Uncertain(string what, Exception error, string? secret) => new(ScCodes.Uncertain,
        ScRedaction.Text($"{what}: the request may have reached the server ({Unwrap(error)}); it is never resent: reconcile by a read", secret),
        sent: true, new JsonObject { ["outcome"] = "uncertain" });

    public static string Unwrap(Exception error)
    {
        while (error is System.Reflection.TargetInvocationException { InnerException: not null } tie) error = tie.InnerException!;
        while (error is AggregateException { InnerException: not null } ae) error = ae.InnerException!;
        return error.GetType().Name + ": " + error.Message;
    }
}

/// <summary>Host, write and corporate guards. Every write arrives authorized by the facade, which keeps the user's
/// words; here only their sha256 and the operationId are checked again (defense in depth).</summary>
internal static class ScGuard
{
    private static readonly Regex HostName = new("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Hex = new("^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant);

    /// <summary>The bare DNS name of the environment: no scheme, port, user or path.</summary>
    public static string Host(string? host)
    {
        var name = host?.Trim().TrimEnd('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(name) || name.Length > 253 || !HostName.IsMatch(name))
            throw new ScFailure(ScCodes.BadRequest, "host must be the bare DNS name of the environment (no scheme, port or path)");
        return name;
    }

    public static bool SameHost(string? candidate, string host) =>
        string.Equals(candidate?.Trim().TrimEnd('.'), host, StringComparison.OrdinalIgnoreCase);

    /// <summary>%USERPROFILE%\.ssam-hybrid\config.json, with the USERPROFILE variable first (the rule of the runtime
    /// contract, docs/DISTRIBUICAO.md section 3).</summary>
    public static string ConfigFile
    {
        get
        {
            var profile = Environment.GetEnvironmentVariable("USERPROFILE");
            var root = !string.IsNullOrWhiteSpace(profile) ? Path.GetFullPath(profile) : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(root, ".ssam-hybrid", "config.json");
        }
    }

    /// <summary>The corporate environments: writes need an explicit instruction for each operation. No host name is
    /// compiled in. The hosts are "corporateHosts" of config.json (docs/DISTRIBUICAO.md section 4), an array of host
    /// names (a name also covers its subdomains), read on every write. Without the file or the field,
    /// BridgeKit.CorporateWhenUnconfigured decides: the full bridge counts no host as corporate (the controller's own host
    /// policy still applies), the thin bridge of the hosted pack counts every host as corporate (fail closed). A
    /// config.json that cannot be read, or a field that is not an array of names, refuses the write.</summary>
    public static bool Corporate(string host) => Corporate(host, ConfigFile);

    public static bool Corporate(string host, string configFile) =>
        CorporateHosts(configFile) is { } names ? names.Any(name => host.Equals(name, StringComparison.OrdinalIgnoreCase) ||
            host.EndsWith("." + name, StringComparison.OrdinalIgnoreCase)) : BridgeKit.CorporateWhenUnconfigured;

    /// <summary>The configured names, trimmed and without the final dot; null when nothing is configured.</summary>
    public static string[]? CorporateHosts(string configFile)
    {
        if (!File.Exists(configFile)) return null;
        JsonNode? hosts;
        try { hosts = JsonNode.Parse(File.ReadAllText(configFile))?["corporateHosts"]; }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or InvalidOperationException)
        { throw new ScFailure(ScCodes.NotAllowed, "config.json could not be read to check corporateHosts (" + error.GetType().Name + "); the write was not sent"); }
        if (hosts == null) return null;
        if (hosts is not JsonArray names || names.Any(name => name is not JsonValue value || !value.TryGetValue<string>(out _)))
            throw new ScFailure(ScCodes.NotAllowed, "config.json corporateHosts must be an array of host names; the write was not sent");
        return names.Select(name => name!.GetValue<string>().Trim().TrimEnd('.')).Where(name => name.Length > 0).ToArray();
    }

    public static string? Text(JsonObject request, string name) =>
        request[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    public static bool Flag(JsonObject request, string name) =>
        request[name] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    /// <summary>Checks the write fields and returns the operationId. A destructive operation needs a `target` that names
    /// the same object as its arguments (the facade sends the key its words named): without one it is NOT_ALLOWED.</summary>
    public static string Write(JsonObject request, string host, bool destructive, params string?[] identity)
    {
        if (!Flag(request, "write"))
            throw new ScFailure(ScCodes.NotAllowed, "this operation writes: it needs write:true, operationId and authorizeSha256 from the facade");
        var operationId = Text(request, "operationId");
        if (!Guid.TryParseExact(operationId, "D", out _))
            throw new ScFailure(ScCodes.BadRequest, "operationId must be a UUID");
        if (!Sha256Hex.IsMatch(Text(request, "authorizeSha256") ?? ""))
            throw new ScFailure(ScCodes.BadRequest, "authorizeSha256 must be the sha256 (64 hex) of the user's authorization words");
        if (Corporate(host) && !Flag(request, "corporateInstruction"))
            throw new ScFailure(ScCodes.NotAllowed, $"{host} is a corporate environment for this bridge (corporateHosts of {ConfigFile}; without it the "
                + (BridgeKit.CorporateWhenUnconfigured ? "hosted bridge counts every host" : "bridge counts no host")
                + "): a write needs the user's explicit instruction for this operation (corporateInstruction:true)");
        if (destructive && Text(request, "target") is not { Length: > 0 })
            throw new ScFailure(ScCodes.NotAllowed, "this operation destroys an object: it needs target, the key of that object as the user's words named it");
        if (destructive && Text(request, "target") is { } target &&
            !identity.Any(id => id != null && string.Equals(id, target, StringComparison.OrdinalIgnoreCase)))
            throw new ScFailure(ScCodes.BadRequest, "target does not name the object of this destructive operation");
        return operationId!;
    }
}

/// <summary>OperationIds already sent by this Studio process. A second request with the same id is refused: an uncertain
/// write is reconciled by a read, never resent.</summary>
internal static class ScLedger
{
    private static readonly ConcurrentDictionary<string, DateTime> Sent = new(StringComparer.OrdinalIgnoreCase);

    public static void Claim(string operationId)
    {
        if (!Sent.TryAdd(operationId, DateTime.UtcNow))
            throw new ScFailure(ScCodes.NotAllowed, "operationId was already submitted in this Studio session; it is never resent: reconcile by a read");
    }
}

/// <summary>Secret removal for every answer, the same rules as the Portal redaction (platforms/odc/portal/runtime/errors.mjs)
/// plus the Studio's own secret (the id_token in SSO), JWTs and connection-string passwords.</summary>
internal static class ScRedaction
{
    public const string Mask = "[REDACTED]";
    private static readonly Regex SensitiveKey = new(
        "(?:authorization|cookie|password|passwd|^pwd$|secret|(?:^|_)token(?:$|_)|accesstoken|refreshtoken|idtoken|private.?key|credential|api.?key|subscription.?key|connection.?string|activation.?code|^serial$|^ForceSecureAlgorithmsInAuthentication$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Scheme = new("\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Jwt = new("eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", RegexOptions.CultureInvariant);
    private static readonly Regex PasswordPair = new("\\b(password|pwd)\\s*=\\s*[^;\"'\\s]*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex PasswordInput = new("<input\\b[^>]*\\btype\\s*=\\s*[\"']?password\\b[^>]*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex ValueAttribute = new("\\bvalue\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool IsSensitiveKey(string name) => SensitiveKey.IsMatch(name);

    public static string Text(string? text, string? secret)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        if (!string.IsNullOrEmpty(secret))
            text = text.Replace(secret, Mask, StringComparison.Ordinal).Replace(Uri.EscapeDataString(secret), Mask, StringComparison.Ordinal);
        text = Scheme.Replace(text, m => m.Groups[1].Value + " " + Mask);
        text = Jwt.Replace(text, Mask);
        return PasswordPair.Replace(text, m => m.Groups[1].Value + "=" + Mask);
    }

    public static JsonNode? Node(JsonNode? node, string? secret)
    {
        switch (node)
        {
            case null: return null;
            case JsonArray array:
                return new JsonArray(array.Select(item => Node(item?.DeepClone(), secret)).ToArray());
            case JsonObject obj:
            {
                // {Key|Name, Value} pairs (dictionaries projected as lists) hide the value of a sensitive name.
                var pairName = (obj["Key"] ?? obj["Name"]) is JsonValue n && n.TryGetValue<string>(out var s) ? s : null;
                var result = new JsonObject();
                foreach (var (name, value) in obj)
                    result[name] = value != null && (IsSensitiveKey(name) || (name == "Value" && pairName != null && IsSensitiveKey(pairName)))
                        ? Mask : Node(value?.DeepClone(), secret);
                return result;
            }
            case JsonValue value when value.TryGetValue<string>(out var text):
                return JsonValue.Create(Text(text, secret));
            default:
                return node.DeepClone();
        }
    }

    /// <summary>HTML keeps its form state (the facade posts it back); only password inputs lose their value.</summary>
    public static string Html(string html) =>
        PasswordInput.Replace(html, tag => ValueAttribute.Replace(tag.Value, "value=\"\""));
}

/// <summary>The Service Center origin and path allowlist of sc_web (the rules of kernel/scripts/service_center/http.py:219).</summary>
internal static class ScWebPaths
{
    private static readonly Regex Encoded = new("%2f|%5c|%2e", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static string Root(string host) => $"https://{host}/ServiceCenter/";

    /// <summary>Absolute URL under https://host/ServiceCenter/ for a relative or absolute path; anything else is refused.</summary>
    public static string Resolve(string host, string? path)
    {
        var raw = string.IsNullOrWhiteSpace(path) ? "/ServiceCenter/" : path.Trim();
        var pathPart = raw.Split('?', 2)[0];
        if (raw.Contains('\\') || raw.Contains('#') || raw.StartsWith("//", StringComparison.Ordinal) || Encoded.IsMatch(pathPart) ||
            pathPart.Split('/').Any(segment => segment is "." or ".."))
            throw new ScFailure(ScCodes.NotAllowed, "sc_web path must stay under /ServiceCenter/ (no encoded separators, dot segments, fragments or backslashes)");
        if (!Uri.TryCreate(new Uri(Root(host)), raw, out var uri) || !Allowed(host, uri.AbsoluteUri))
            throw new ScFailure(ScCodes.NotAllowed, $"sc_web only reaches https://{host}/ServiceCenter/");
        return uri.AbsoluteUri;
    }

    public static bool Allowed(string host, string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort &&
        string.IsNullOrEmpty(uri.UserInfo) && ScGuard.SameHost(uri.Host, host) &&
        uri.AbsolutePath.StartsWith("/ServiceCenter/", StringComparison.OrdinalIgnoreCase) &&
        !uri.AbsolutePath.Split('/').Any(segment => segment is "." or "..");

    /// <summary>Navigation policy of the web window: the Service Center always; other https pages only while the user is
    /// signing in (the identity provider); never another scheme.</summary>
    public static bool MayNavigate(string host, string? url, bool signingIn) =>
        url == "about:blank" || Allowed(host, url) ||
        (signingIn && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps);

    public static bool IsLoginPage(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        Regex.IsMatch(uri.AbsolutePath, "/_?login(sso)?\\.aspx$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>What an answer may say about a location: the path on the Service Center host, only the origin elsewhere
    /// (an identity provider URL can carry codes and state).</summary>
    public static string? Describe(string host, string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        return ScGuard.SameHost(uri.Host, host) && uri.Scheme == Uri.UriSchemeHttps ? uri.AbsolutePath : uri.GetLeftPart(UriPartial.Authority);
    }
}

/// <summary>Fixed scripts of the web window. Arguments go in as JSON; the page answers through a non-enumerable store
/// that the bridge reads and deletes. They never read document.cookie and never return headers other than content-type.</summary>
internal static class ScWebScripts
{
    public const int HtmlLimit = 8 * 1024 * 1024;
    public const int XlsxLimit = 32 * 1024 * 1024;

    public const string Status =
        "return JSON.stringify({href:location.href,password:!!document.querySelector('input[type=password]')," +
        "logout:Array.prototype.some.call(document.querySelectorAll('a,input,button'),function(n){" +
        "return /log ?out|sign ?out/i.test((n.getAttribute('href')||'')+' '+(n.textContent||'')+' '+(n.value||''));})});";

    public static string Fetch(string id, string origin, string url, string method, JsonObject? form, string accept)
    {
        var arguments = new JsonObject
        {
            ["id"] = id, ["origin"] = origin, ["url"] = url, ["method"] = method, ["form"] = form?.DeepClone(), ["accept"] = accept,
            ["max"] = accept == "html" ? HtmlLimit : XlsxLimit,
        };
        return "(function(){var a=" + arguments.ToJsonString() + ";" +
            "var s=window.__ssamScFetch;if(!s){s={};Object.defineProperty(window,'__ssamScFetch',{value:s,enumerable:false});}" +
            "function done(v){s[a.id]=JSON.stringify(v);}" +
            "if(location.origin!==a.origin){done({error:'origin'});return;}" +
            "var init={method:a.method,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:a.method==='GET'?'follow':'manual'};" +
            "if(a.form){var b=new URLSearchParams();Object.keys(a.form).forEach(function(k){var v=a.form[k];" +
            "(Array.isArray(v)?v:[v]).forEach(function(x){b.append(k,x==null?'':String(x));});});init.body=b;}" +
            "fetch(a.url,init).then(function(r){var h={status:r.status,finalUrl:r.url,redirected:r.redirected,type:r.type," +
            "contentType:r.headers.get('content-type')||''};" +
            "if(r.type==='opaqueredirect'){done(h);return;}" +
            "if(a.accept!=='html'&&!/html/i.test(h.contentType))return r.arrayBuffer().then(function(buf){" +
            "if(buf.byteLength>a.max){h.tooLarge=buf.byteLength;done(h);return;}" +
            "var u=new Uint8Array(buf),t='';for(var i=0;i<u.length;i+=32768)t+=String.fromCharCode.apply(null,u.subarray(i,i+32768));" +
            "h.bodyBase64=btoa(t);done(h);});" +
            "return r.text().then(function(t){if(t.length>a.max)h.tooLarge=t.length;else h.html=t;done(h);});" +
            "}).catch(function(e){done({error:'network',message:String(e&&e.message||e)});});})();";
    }

    public static string Take(string id)
    {
        var key = JsonSerializer.Serialize(id);
        return $"var s=window.__ssamScFetch,v=s&&s[{key}];if(v!==undefined)delete s[{key}];return v===undefined?null:v;";
    }
}

/// <summary>
/// sc_web login: the hidden Service Center window signs in with the login the user stored in the Windows vault
/// (SSAM/O11/&lt;host&gt;/ServiceCenter, written by the private prompt windows-o11-credential.ps1). The values are read in
/// the Studio process (ScVault.cs) and go into exactly one place: the sign-in form of a page on the environment host itself
/// or on the OutSystems identity provider. Any other origin (a corporate IdP), MFA or a consent page is left to the user
/// in the revealed window. One submit per call, never repeated: a rejected login is stored again by the user.
/// </summary>
internal static class ScWebLogin
{
    /// <summary>Identity providers whose sign-in form SSAM fills (the OutSystems account login of personal environments).</summary>
    public static readonly string[] IdentityOrigins = ["https://id.outsystems.com"];
    public static readonly TimeSpan Limit = TimeSpan.FromSeconds(60);
    /// <summary>The form still shows its password field this long after the submit: the login was rejected.</summary>
    public static readonly TimeSpan RejectAfter = TimeSpan.FromSeconds(15);

    public static string Target(string host) => $"SSAM/O11/{host}/ServiceCenter";
    public static string ProfileTarget(string host, string? target)
    {
        var legacy = Target(host);
        if (string.IsNullOrEmpty(target) || target == legacy) return legacy;
        if (System.Text.RegularExpressions.Regex.IsMatch(target, "^" + System.Text.RegularExpressions.Regex.Escape(legacy) + "/Profiles/[a-f0-9]{64}/[a-f0-9-]{36}$")) return target;
        throw new ScFailure(ScCodes.BadRequest, "credential profile must belong to this exact Service Center host");
    }

    public static bool MayFill(string host, string? origin) =>
        origin != null && (IdentityOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase) ||
            string.Equals(origin, "https://" + host, StringComparison.OrdinalIgnoreCase));

    /// <summary>What the page shows: its origin, whether a visible password field sits in a form with a user field, whether
    /// an error message is visible next to it, and whether a single sign-on choice (LoginSSO.aspx, the OutSystems identity
    /// provider, "Log in with ...") is visible. No field value is read.</summary>
    public const string State =
        "var p=Array.prototype.filter.call(document.querySelectorAll('input[type=password]'),function(n){return n.offsetParent!==null;})[0];" +
        "var f=p&&p.form,u=f&&Array.prototype.filter.call(f.querySelectorAll('input[type=email],input[type=text],input:not([type])'),function(n){return n.offsetParent!==null;})[0];" +
        "var e=Array.prototype.some.call(document.querySelectorAll('.feedback-message-error,.feedback-message,[role=alert],.validation-message,.error-message'),function(n){return n.offsetParent!==null&&/\\S/.test(n.textContent||'');});" +
        "var s=Array.prototype.some.call(document.querySelectorAll(" + SsoSelector + "),function(n){return n.offsetParent!==null&&" + SsoTest + ";});" +
        "return JSON.stringify({origin:location.origin,form:!!(p&&f&&u),error:e,sso:s});";

    private const string SsoSelector = "'a[href],button,input[type=submit],input[type=button]'";
    private const string SsoTest = "/loginsso\\.aspx|id\\.outsystems\\.com|single sign|log ?in with/i.test((n.getAttribute('href')||'')+' '+(n.textContent||'')+' '+(n.getAttribute('value')||''))";

    /// <summary>Follows the single sign-on choice of the Service Center sign-in page once (no credential): with the
    /// identity provider session the Studio's browser profile already holds, the provider answers by itself.</summary>
    public const string SsoClick =
        "(function(){var n=Array.prototype.filter.call(document.querySelectorAll(" + SsoSelector + "),function(n){return n.offsetParent!==null&&" + SsoTest + ";})[0];" +
        "if(n)n.click();})();";

    /// <summary>Fills the user and password fields of the sign-in form and submits it once. The values exist only in this
    /// script text; the page answers nothing back.</summary>
    public static string Fill(string user, string password)
    {
        var arguments = new JsonObject { ["u"] = user, ["p"] = password };
        return "(function(){var a=" + arguments.ToJsonString() + ";" +
            "var p=Array.prototype.filter.call(document.querySelectorAll('input[type=password]'),function(n){return n.offsetParent!==null;})[0];" +
            "var f=p&&p.form;if(!f){a=null;return;}" +
            "var u=f.querySelector('#Input_Email')||Array.prototype.filter.call(f.querySelectorAll('input[type=email],input[type=text],input:not([type])'),function(n){return n.offsetParent!==null;})[0];" +
            "if(!u){a=null;return;}" +
            "var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;" +
            "function put(n,v){n.focus();set.call(n,v);['input','change','blur'].forEach(function(t){n.dispatchEvent(new Event(t,{bubbles:true}));});}" +
            "put(u,a.u);put(p,a.p);a=null;" +
            "setTimeout(function(){var b=f.querySelector('button[type=submit],input[type=submit]');if(b)b.click();else if(f.requestSubmit)f.requestSubmit();else f.submit();},200);})();";
    }

    public enum Step { SignedIn, Fill, Wait, Rejected, Interactive, Sso, NeedsLogin }

    /// <summary>The next step of a sign-in through the Studio's own session only (sc_web login {session:"studio"}, capability
    /// sc_web:studioSession, A13 of the 2026-10-06 package): the single sign-on choice of the Service Center page is followed
    /// once even when the page also shows its form; a form on the host or on the OutSystems identity provider is NeedsLogin
    /// (never filled here: the vault is not read in this mode); a form of another provider is Interactive.</summary>
    public static Step NextStudioSession(string host, JsonObject status, string? state, bool ssoFollowed)
    {
        if (status["signedIn"]?.GetValue<bool>() == true) return Step.SignedIn;
        JsonObject? page = null;
        try { page = string.IsNullOrEmpty(state) ? null : JsonNode.Parse(state) as JsonObject; } catch (JsonException) { }
        if (page == null) return Step.Wait;
        var origin = page["origin"]?.ToString();
        var onHost = string.Equals(origin, "https://" + host, StringComparison.OrdinalIgnoreCase);
        if (!ssoFollowed && onHost && page["sso"]?.GetValue<bool>() == true) return Step.Sso;
        if (page["form"]?.GetValue<bool>() == true) return MayFill(host, origin) ? Step.NeedsLogin : Step.Interactive;
        return Step.Wait;
    }

    /// <summary>The next step of the sign-in loop. status: ScWebResult.Status of the window; state: the State script answer;
    /// sinceSubmit: null before the one submit; ssoFollowed: the single sign-on choice was already clicked once.</summary>
    public static Step Next(string host, JsonObject status, string? state, TimeSpan? sinceSubmit) => Next(host, status, state, sinceSubmit, ssoFollowed: true);

    public static Step Next(string host, JsonObject status, string? state, TimeSpan? sinceSubmit, bool ssoFollowed)
    {
        if (status["signedIn"]?.GetValue<bool>() == true) return Step.SignedIn;
        JsonObject? page = null;
        try { page = string.IsNullOrEmpty(state) ? null : JsonNode.Parse(state) as JsonObject; } catch (JsonException) { }
        if (page == null) return Step.Wait;
        var form = page["form"]?.GetValue<bool>() == true;
        var fillable = form && MayFill(host, page["origin"]?.ToString());
        if (sinceSubmit == null)
        {
            // The Service Center sign-in page with only a single sign-on choice: follow it once, silently (C05).
            if (!form && !ssoFollowed && page["sso"]?.GetValue<bool>() == true &&
                string.Equals(page["origin"]?.ToString(), "https://" + host, StringComparison.OrdinalIgnoreCase)) return Step.Sso;
            return fillable ? Step.Fill : form ? Step.Interactive : Step.Wait;
        }
        if (form && (page["error"]?.GetValue<bool>() == true || sinceSubmit >= RejectAfter)) return Step.Rejected;
        return Step.Wait;
    }
}

/// <summary>
/// The session of the hidden Service Center window (C05 of the 2026-10-05 package), the parts that need no Studio type:
/// whether a page is signed in, on a sign-in page or loading; what an expired read does (re-enter through the Studio's
/// own sign-in, never ask while the Studio is signed in); when a login is asked; when the bridge's own keep-alive runs
/// (only while the window exists and is signed in, never from the model). ScWebHandler only calls these.
/// </summary>
internal static class ScWebSession
{
    /// <summary>The Service Center session of the window expired in about four minutes in the sessions (dd2b79c0,
    /// 2026-10-05 01:06 -> 01:10); the keep-alive reads the Service Center home well inside that.</summary>
    public static readonly TimeSpan KeepAliveInterval = TimeSpan.FromMinutes(2);
    /// <summary>How often the window's timer looks whether a keep-alive is due.</summary>
    public static readonly TimeSpan KeepAliveTick = TimeSpan.FromSeconds(30);
    /// <summary>The value of the answers' reentry field: the window re-enters by itself through the identity session of
    /// the Studio's browser profile (single sign-on), else with the stored login. Its presence is how the facade knows.</summary>
    public const string Reentry = "studio-sso";

    /// <summary>Manifest capability (Dispatch.Capabilities): sc_web login takes session:"studio" and signs the window in
    /// through the Studio's own session only (NextStudioSession), answering WEB_SIGN_IN_NEEDS_LOGIN instead of reading the
    /// vault. The facade asks the vault login only after that answer; a bridge without it keeps the former path.</summary>
    public const string StudioSessionCapability = "sc_web:studioSession";

    /// <summary>The session value of sc_web login that selects the Studio-session sign-in.</summary>
    public const string StudioSession = "studio";

    public enum Page { Loading, SignedIn, SignInForm, IdentityProvider, SingleSignOn, Other }

    /// <summary>What the window shows. status: ScWebResult.Status; state: the ScWebLogin.State answer (null while loading).
    /// A Service Center page never counts as signed in once a read was answered by the sign-in page (expired).</summary>
    public static Page Classify(string host, JsonObject status, string? state, bool expired = false)
    {
        if (!expired && status["signedIn"]?.GetValue<bool>() == true) return Page.SignedIn;
        if (status["loading"]?.GetValue<bool>() == true) return Page.Loading;
        JsonObject? page = null;
        try { page = string.IsNullOrEmpty(state) ? null : JsonNode.Parse(state) as JsonObject; } catch (JsonException) { }
        if (page == null) return Page.Loading;
        var onHost = string.Equals(page["origin"]?.ToString(), "https://" + host, StringComparison.OrdinalIgnoreCase);
        if (page["form"]?.GetValue<bool>() == true) return onHost ? Page.SignInForm : Page.IdentityProvider;
        if (onHost && page["sso"]?.GetValue<bool>() == true) return Page.SingleSignOn;
        return onHost ? Page.Other : Page.IdentityProvider;
    }

    public enum Expired { Reenter, StudioSignIn, Uncertain, Refuse }

    /// <summary>A request answered by the Service Center sign-in page. A write is never resent (uncertain); with the Studio
    /// logged out the only login asked is the Studio's own; a read (GET) re-enters silently once and is read again.</summary>
    public static Expired OnSignInPage(bool studioSignedIn, bool write, string method, bool reentered) =>
        write ? Expired.Uncertain
        : !studioSignedIn ? Expired.StudioSignIn
        : !reentered && string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase) ? Expired.Reenter
        : Expired.Refuse;

    public enum Ask { Nothing, StudioSignIn, StoredLogin, User }

    /// <summary>When a login is asked during a sign-in step. Never while the window can still re-enter by itself; the
    /// stored login only for a form SSAM may fill; the user only for a page SSAM never fills (another provider, MFA).</summary>
    public static Ask AskFor(bool studioSignedIn, ScWebLogin.Step step, bool storedLogin) =>
        !studioSignedIn ? Ask.StudioSignIn
        : step switch
        {
            ScWebLogin.Step.Fill => storedLogin ? Ask.Nothing : Ask.StoredLogin,
            ScWebLogin.Step.Rejected => Ask.StoredLogin,
            ScWebLogin.Step.Interactive => Ask.User,
            _ => Ask.Nothing,
        };

    /// <summary>Whether the keep-alive read runs now: only with the window open and signed in, not while another request
    /// holds the window, and only when nothing touched the session for KeepAliveInterval.</summary>
    public static bool KeepAliveDue(bool windowOpen, bool signedIn, bool busy, DateTime lastActivityUtc, DateTime nowUtc) =>
        windowOpen && signedIn && !busy && nowUtc - lastActivityUtc >= KeepAliveInterval;

    /// <summary>When the next keep-alive is due (null: none is scheduled, the window is closed or not signed in).</summary>
    public static TimeSpan? NextKeepAlive(bool windowOpen, bool signedIn, DateTime lastActivityUtc, DateTime nowUtc)
    {
        if (!windowOpen || !signedIn) return null;
        var left = KeepAliveInterval - (nowUtc - lastActivityUtc);
        return left < TimeSpan.Zero ? TimeSpan.Zero : left;
    }

    /// <summary>The fields every sc_web answer carries for the facade: reentry and keepAlive {intervalSeconds, active, lastAt}.</summary>
    public static void Describe(JsonObject body, bool windowOpen, bool signedIn, DateTime? lastKeepAliveUtc)
    {
        body["reentry"] = Reentry;
        body["keepAlive"] = new JsonObject
        {
            ["intervalSeconds"] = (int)KeepAliveInterval.TotalSeconds,
            ["active"] = windowOpen && signedIn,
            ["lastAt"] = lastKeepAliveUtc?.ToString("o"),
        };
    }
}

/// <summary>The request part of sc_web fetch, checked before the page is touched. SecretRefs name vault entries for
/// form fields of a write postback (ScSecrets.cs); their values are read only right before the send.</summary>
internal sealed record ScWebRequest(string Method, string Url, string Accept, JsonObject? Form, bool Write, string? OperationId, TimeSpan Timeout,
    IReadOnlyList<ScSecretRef> SecretRefs)
{
    public static ScWebRequest Parse(JsonObject request, string host)
    {
        var method = (ScGuard.Text(request, "method") ?? "GET").ToUpperInvariant();
        if (method is not ("GET" or "POST")) throw new ScFailure(ScCodes.BadRequest, "method must be GET or POST");
        var url = ScWebPaths.Resolve(host, ScGuard.Text(request, "path"));
        // binary (a solution .osp download) reads like xlsx: a non-HTML answer comes back as bodyBase64.
        var accept = ScGuard.Text(request, "accept") ?? "html";
        if (accept is not ("html" or "xlsx" or "binary")) throw new ScFailure(ScCodes.BadRequest, "accept must be html, xlsx or binary");
        if (request["form"] is not (null or JsonObject)) throw new ScFailure(ScCodes.BadRequest, "form must be an object of field names to values");
        var form = request["form"] as JsonObject;
        if (form != null && method != "POST") throw new ScFailure(ScCodes.BadRequest, "form goes with POST");
        foreach (var (name, value) in form ?? new JsonObject())
            if (!(value is null or JsonValue || (value is JsonArray list && list.All(x => x is null or JsonValue))))
                throw new ScFailure(ScCodes.BadRequest, $"form field '{name}' must be a scalar or a list of scalars");
        // A postback that changes state carries write:true; a postback that only reads (paging, filters) does not.
        var write = ScGuard.Flag(request, "write");
        var operationId = write ? ScGuard.Write(request, host, destructive: false) : null;
        var secretRefs = ScSecretRefs.Parse(request, host, write, method, accept, form);
        var timeout = request["timeoutMs"] is JsonValue t && t.TryGetValue<int>(out var ms) ? ms : 60000;
        return new ScWebRequest(method, url, accept, form, write, operationId, TimeSpan.FromMilliseconds(Math.Clamp(timeout, 1000, 300000)), secretRefs);
    }
}

/// <summary>Reads what the page answered. Bodies outside the allowlist are dropped before anything is returned.</summary>
internal static class ScWebResult
{
    // SSO login pages can return HTTP 200 at the protected URL and include the
    // word "logout" in shared scripts. Neither proves an authenticated session.
    public static bool LoginHtml(string html) => Regex.IsMatch(html,
        "<form\\b[^>]*\\baction\\s*=\\s*[\"'][^\"']*\\b_?login(?:sso)?\\.aspx(?:[?][^\"']*)?[\"']|class\\s*=\\s*[\"'][^\"']*\\bsc-layout-login\\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    public static bool ProtectedHtml(string host, string url, int status, string html)
    {
        if (status != 200 || !ScWebPaths.Allowed(host, url) || ScWebPaths.IsLoginPage(url) || LoginHtml(html)) return false;
        // Web Forms names the real control wtLogoutLink inside a postback URL.
        // Markup embedded in shared scripts or comments is not a live control.
        var markup = Regex.Replace(html, "<(script|style)\\b[^>]*>[\\s\\S]*?</\\1\\s*>|<!--[\\s\\S]*?-->", "",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        return Regex.IsMatch(markup, "<(?:a|input|button)\\b[^>]*\\b(?:href|onclick)\\s*=\\s*[\"'][^\"']*logout",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    }

    public static JsonObject Status(string host, string? raw)
    {
        var page = Parse(raw);
        var href = page?["href"]?.ToString();
        var onServiceCenter = ScWebPaths.Allowed(host, href);
        var signedIn = onServiceCenter && page?["password"]?.GetValue<bool>() == false && page["logout"]?.GetValue<bool>() == true &&
            !ScWebPaths.IsLoginPage(href!);
        return new JsonObject { ["open"] = true, ["signedIn"] = signedIn, ["location"] = ScWebPaths.Describe(host, href), ["loading"] = page == null };
    }

    /// <summary>raw is null on timeout. write: the request carried write:true (a state-changing postback). injected: the
    /// vault values the postback carried (secretRefs), masked out of the answer.</summary>
    public static JsonObject Fetch(string host, string method, bool write, string? raw, ScInjected? injected = null)
    {
        if (raw == null)
            throw write ? new ScFailure(ScCodes.Uncertain, "sc_web: no answer from the page in time; the postback may have reached the server; it is never resent: reconcile by a read", true, new JsonObject { ["outcome"] = "uncertain" })
                : new ScFailure(ScCodes.RemoteError, "sc_web: no answer from the page in time", true);
        var page = Parse(raw) ?? throw new ScFailure(write ? ScCodes.Uncertain : ScCodes.RemoteError, "sc_web: unreadable answer from the page", true);
        switch (page["error"]?.ToString())
        {
            case "origin":
                throw new ScFailure(ScCodes.WebSignInRequired, $"the native HTTP session is not authenticated on https://{host}; no interactive sign-in was attempted");
            case "network" when write:
                throw new ScFailure(ScCodes.Uncertain, "sc_web: the postback failed in the browser; it may have reached the server; it is never resent: reconcile by a read", true, new JsonObject { ["outcome"] = "uncertain" });
            case "network" when method == "GET":
                throw new ScFailure(ScCodes.WebSignInRequired, "sc_web: the request left the Service Center origin (a sign-in redirect) or the network failed: check sc_web action=status, then open and sign in", true);
            case "network":
                throw new ScFailure(ScCodes.RemoteError, "sc_web: the request failed in the browser", true);
        }
        var status = page["status"]?.GetValue<int>() ?? 0;
        if (page["type"]?.ToString() == "opaqueredirect")
            return new JsonObject { ["status"] = status, ["redirected"] = true, ["finalUrl"] = null, ["contentType"] = null,
                ["note"] = "the server answered the postback with a redirect; read the page again to see the outcome" };
        var finalUrl = page["finalUrl"]?.ToString();
        if (!ScWebPaths.Allowed(host, finalUrl))
            throw new ScFailure(ScCodes.HostMismatch, $"sc_web: the answer came from {ScWebPaths.Describe(host, finalUrl) ?? "an unknown location"}, outside https://{host}/ServiceCenter/; its body was dropped", true);
        if (ScWebPaths.IsLoginPage(finalUrl!) || status is 401 or 403 || LoginHtml(page["html"]?.ToString() ?? ""))
            throw write ? new ScFailure(ScCodes.Uncertain, "sc_web: the postback was answered by the sign-in page; it is never resent: sign in (sc_web action=open), then reconcile by a read", true,
                    new JsonObject { ["outcome"] = "uncertain", ["signInRequired"] = true })
                : new ScFailure(ScCodes.WebSignInRequired, "Service Center requires authentication; headless HTTP did not open a login window", true);
        if (page["tooLarge"] is { } size)
            throw new ScFailure(ScCodes.RemoteError, $"sc_web: response of {size} exceeds the limit", true);
        var body = new JsonObject { ["status"] = status, ["finalUrl"] = finalUrl, ["redirected"] = page["redirected"]?.GetValue<bool>() ?? false,
            ["contentType"] = page["contentType"]?.ToString() };
        if (page["bodyBase64"] is { } base64) body["bodyBase64"] = base64.ToString();
        else body["html"] = ScRedaction.Html(page["html"]?.ToString() ?? "");
        injected?.Clean(body);
        return body;
    }

    private static JsonObject? Parse(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        try { return JsonNode.Parse(raw) as JsonObject; }
        catch (JsonException) { return null; }
    }
}
