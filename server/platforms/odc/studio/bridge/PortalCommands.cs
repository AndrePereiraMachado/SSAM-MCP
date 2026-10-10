using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using ServiceStudio.Presenter;
using Refusal = PortalCore.Refusal;

// Portal lane of the bridge (v32): the public ODC APIs through the Studio's own authenticated HttpClient (portal-call),
// the internal Portal routes through a Portal window inside the Studio where the user signs in (portal-session), and
// the Studio sessions per tenant (auth-status). The rules live in PortalCore.cs; this file binds them to the Studio.
// No token or cookie is read here: the Bearer is added by the Studio's handler inside this process, and a Portal route
// runs in the page with the page's own cookies and CSRF token. A password is read only for a write whose request names
// a vault entry (secretRefs): PortalVault reads it in this process right before the send, and it goes only into the
// body being sent, never into a file, an answer or the journal. Answers follow _notes\scp\CONTRATO.md.
// Usage: portal-call <request.json in journal\portal\requests> [--tenant <host>]
//        portal-upload <request.json in journal\portal\requests> --tenant <host>   (package in journal\portal\uploads)
//        portal-session status|open|close [--tenant <host>]
//        portal-session fetch <request.json in journal\portal\requests> [--tenant <host>]
//        auth-status [--tenant <host>]
// A write names its tenant with --tenant and carries write:true, operationUuid and authorizeSha256 in its request file;
// a secret it needs is named there as secretRefs [{pointer, target:'SSAM/ODC3/<host>/<kind>/<name>', field}], never sent.
internal static partial class Bridge {
    // Computed on demand: Root lives in StartupHook.cs and partial-class static initializers have no defined order.
    private static string PortalDir => Path.Combine(Root, "journal", "portal");
    private static PortalCore.Places PortalPlaces => new(Path.Combine(PortalDir, "writes"), Path.Combine(PortalDir, "downloads"));
    private static PortalCore.TenantPolicy PortalTenants() {
        try { return PortalCore.ReadTenants(File.ReadAllText(Path.Combine(Root, "tenants.json"))); } catch { return PortalCore.ReadTenants(null); }
    }

    // The facade writes request files in journal\portal\requests; no other location is read. Each file is deleted once
    // read. A secret never travels in them: a write names its vault entries in secretRefs instead.
    private static string ReadPortalRequest(string name) {
        var dir = Path.Combine(PortalDir, "requests");
        var full = Path.GetFullPath(Path.Combine(dir, Path.GetFileName(name)));
        if (!full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            throw new Refusal("BAD_REQUEST", "Request files are read only from journal\\portal\\requests: " + name);
        try { return File.ReadAllText(full); } finally { try { File.Delete(full); } catch { } }
    }
    private static (string[] Words, string? Tenant) PortalArguments(string argument) {
        var tokens = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var at = tokens.IndexOf("--tenant");
        if (at < 0) return (tokens.ToArray(), null);
        if (at + 1 >= tokens.Count || tokens[at + 1].StartsWith("--")) throw new Refusal("BAD_REQUEST", "--tenant needs a host.");
        var tenant = tokens[at + 1]; tokens.RemoveRange(at, 2);
        return (tokens.ToArray(), tenant);
    }
    // The journal line of every portal command carries its contract code, not the "ok" of a command that answered.
    private static object PortalAnswer(Context c, JsonObject result) {
        var code = (string?)result["code"];
        c.Outcome = code == null ? "ok" : code == "UNCERTAIN" ? "uncertain" : code == "REMOTE_ERROR" ? "native_error" : "gate_refused";
        c.GateName = code == null ? "none" : (string?)result["gate"] ?? code.ToLowerInvariant();
        c.Note = code == null ? null : code + ": " + (string?)result["message"];
        return result;
    }
    private static object PortalRefusal(Context c, Refusal refusal, DateTimeOffset started) {
        var result = PortalCore.Fail(refusal.Code, refusal.Message, refusal.Gate);
        result["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
        return PortalAnswer(c, result);
    }

    private sealed record PortalSession(ITopLevelPresenter Top, string Host, string? User, string? TenantId);
    // The signed-in Studio session of a tenant host (UI thread). Without a host, the only signed-in one; with several,
    // the caller must name the host. The host of the session is the only host the lane ever talks to.
    private static PortalSession ResolvePortalSession(string? tenant) {
        var signedIn = RuntimeImplementation.Instance.GetAllTopLevelPresenters().Where(p => p.ServerCommunicationsProvider?.IsLoggedIn == true && Host(p) != null).ToArray();
        ITopLevelPresenter? top;
        if (tenant != null) top = signedIn.FirstOrDefault(p => string.Equals(Host(p), tenant, StringComparison.OrdinalIgnoreCase));
        else {
            var hosts = signedIn.Select(Host).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (hosts.Length > 1) throw new Refusal("BAD_REQUEST", "The Studio is signed into " + string.Join(", ", hosts) + "; pass --tenant <host>.");
            top = signedIn.FirstOrDefault();
        }
        if (top == null)
            throw new Refusal("STUDIO_NOT_SIGNED_IN", (tenant == null ? "The ODC Studio has no signed-in session" : "The ODC Studio has no signed-in session on " + tenant)
                + "; the user signs in with the Studio's own login (SSO works there). Sessions: " + JsonSerializer.Serialize(Sessions()));
        var login = top.ServerCommunicationsProvider.LoginInfo;
        return new PortalSession(top, Host(top)!, login.Username, login.HostInfo?.TenantId);
    }

    // ---- portal-call: one public API request with the Studio session of the tenant.
    private static async Task<object> PortalCall(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            if (words.Length != 1) throw new Refusal("BAD_REQUEST", "portal-call takes <request.json> [--tenant <host>].");
            var request = PortalCore.ParseApiRequest(ReadPortalRequest(words[0]));
            c.Feature = "portal:" + (request.OperationId ?? request.Method + " " + request.BasePath + request.Path);
            if (request.Write && tenant == null) throw new Refusal("BAD_REQUEST", "A write names its tenant: --tenant <host>.");
            var (session, client) = await Ui(() => {
                var s = ResolvePortalSession(tenant);
                // The plugin surface of the session: a System.Net.Http.HttpClient over the session's own token handler
                // (Bearer and renewal inside the Studio). It is shared with the Studio and never disposed.
                return (s, (s.Top.ServerCommunicationsProvider as ServiceStudio.PluginAPI.IServerCommunicationsProvider)?.AuthenticatedHttpClient);
            });
            if (client == null) throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio session on " + session.Host + " offers no authenticated client; sign in again in the Studio.");
            if (!PortalCore.TenantHeaderMatches(client, session.TenantId))
                throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio's HTTP client still belongs to an earlier login (its tenant id is not " + session.Host + "'s); sign out and in again in the Studio, or restart it.");
            return PortalAnswer(c, await PortalCore.Send(client, request, session.Host, session.User, PortalTenants(), PortalPlaces, vault: PortalVault.Read));
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
    }

    // ---- portal-upload: an External Library package to the tenant's generation API with the Studio session (rules in
    // PortalUpload.cs). The package is read only from journal\portal\uploads, the PUT goes out through a new client
    // without authentication, and the answer carries the operationKey, never the presigned URLs.
    private static async Task<object> PortalUploadCommand(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            if (words.Length != 1 || tenant == null) throw new Refusal("BAD_REQUEST", "portal-upload takes <request.json> --tenant <host>.");
            var request = PortalUpload.Parse(ReadPortalRequest(words[0]));
            c.Feature = "portal-upload:" + request.FileName;
            var (session, client) = await Ui(() => {
                var s = ResolvePortalSession(tenant);
                return (s, (s.Top.ServerCommunicationsProvider as ServiceStudio.PluginAPI.IServerCommunicationsProvider)?.AuthenticatedHttpClient);
            });
            if (client == null) throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio session on " + session.Host + " offers no authenticated client; sign in again in the Studio.");
            if (!PortalCore.TenantHeaderMatches(client, session.TenantId))
                throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio's HTTP client still belongs to an earlier login (its tenant id is not " + session.Host + "'s); sign out and in again in the Studio, or restart it.");
            return PortalAnswer(c, await PortalUpload.Run(client, request, session.Host, session.User, PortalTenants(), PortalPlaces,
                Path.Combine(PortalDir, "uploads"), PortalUpload.NewUploadClient));
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
    }

    // ---- portal-session: the Portal window of a tenant inside the Studio.
    private sealed class PortalWindow {
        public required Avalonia.Controls.Window Window { get; init; }
        public required WebViewControl.WebView View { get; init; }
        public required DateTimeOffset OpenedAt { get; init; }
        public string? LastError { get; set; }
    }
    // Touched only on the UI thread.
    private static readonly Dictionary<string, PortalWindow> PortalWindows = new(StringComparer.OrdinalIgnoreCase);
    private static string PortalTitle(string host) => "SSAM - ODC Portal - " + host;

    private static async Task<object> PortalSessionCommand(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            var action = words.FirstOrDefault() ?? "";
            c.Feature = "portal-session:" + action;
            if (!(action is "status" or "open" or "close" && words.Length == 1) && !(action == "fetch" && words.Length == 2))
                throw new Refusal("BAD_REQUEST", "portal-session status|open|close [--tenant <host>] | fetch <request.json> [--tenant <host>].");
            var session = await Ui(() => ResolvePortalSession(tenant));
            var result = action switch {
                "status" => await PortalWindowStatus(session),
                "open" => await OpenPortal(session),
                "close" => await ClosePortalWindow(session),
                _ => await PortalFetch(session, words[1], tenant != null, c)
            };
            result["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
            return PortalAnswer(c, result);
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
    }

    // A window that was already open reports whether its page is signed in; a new one is still loading (signedIn false).
    private static async Task<JsonObject> OpenPortal(PortalSession s) {
        var (result, entry, created) = await Ui(() => OpenPortalWindow(s));
        JsonObject? probe = null;
        if (!created) try { probe = await PageEval(entry, PortalCore.ProbeScript, TimeSpan.FromSeconds(5)); } catch { }
        result["signedIn"] = PortalCore.PageSignedIn(probe, s.Host);
        return result;
    }
    // The window is a separate top-level window (no owner), so the dialog watchdog never touches it. The browser engine
    // is the Studio's own: a window is only created once the Studio has started it, so its settings stay the Studio's.
    private static (JsonObject Result, PortalWindow Entry, bool Created) OpenPortalWindow(PortalSession s) {
        var created = false;
        if (!PortalWindows.TryGetValue(s.Host, out var entry)) {
            if (!Xilium.CefGlue.Common.CefRuntimeLoader.IsLoaded)
                throw new Refusal("WEB_SIGN_IN_REQUIRED", "The Studio's browser engine has not started yet; open any Studio web panel (for example the start page) and repeat portal-session open.");
            var view = new WebViewControl.WebView { AllowDeveloperTools = false, DisableFileDialogs = true };
            var window = new Avalonia.Controls.Window { Title = PortalTitle(s.Host), Width = 1100, Height = 820, Content = view };
            var opened = new PortalWindow { Window = window, View = view, OpenedAt = DateTimeOffset.UtcNow };
            // A page error would otherwise be rethrown on the Studio's UI thread.
            view.UnhandledAsyncException += e => { e.Handled = true; opened.LastError = PortalCore.RedactText(e.Exception.GetBaseException().Message); };
            // Sign-in popups open in this same window, never in another browser.
            view.PopupOpening += url => Dispatcher.UIThread.Post(() => { if (Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps) view.LoadUrl(url); });
            window.Closed += (_, _) => { if (PortalWindows.TryGetValue(s.Host, out var current) && ReferenceEquals(current, opened)) PortalWindows.Remove(s.Host); };
            PortalWindows[s.Host] = opened;
            view.Address = "https://" + s.Host + "/";
            window.Show();
            entry = opened; created = true;
        } else entry.Window.Activate();
        return (new JsonObject {
            ["ok"] = true, ["source"] = "studio-web", ["host"] = s.Host, ["user"] = null, ["studioUser"] = s.User, ["opened"] = true, ["windowOpen"] = true, ["created"] = created,
            ["title"] = PortalTitle(s.Host), ["openedAt"] = entry.OpenedAt.ToString("o"), ["cachePersistent"] = WebViewControl.WebView.Settings.PersistCache,
            ["instruction"] = "The user signs in to the Portal in the window '" + PortalTitle(s.Host) + "' (SSO works there); then portal-session status reports signedIn."
        }, entry, created);
    }

    private static async Task<JsonObject?> PageEval(PortalWindow entry, string script, TimeSpan timeout) {
        var evaluation = await Ui(() => entry.View.EvaluateScript<string>(script, null, timeout));
        var text = await evaluation.WaitAsync(timeout + TimeSpan.FromSeconds(5));
        return string.IsNullOrEmpty(text) ? null : JsonNode.Parse(text) as JsonObject;
    }

    private static async Task<JsonObject> PortalWindowStatus(PortalSession s) {
        var entry = await Ui(() => PortalWindows.TryGetValue(s.Host, out var e) ? e : null);
        var result = new JsonObject {
            ["ok"] = true, ["source"] = "studio-web", ["host"] = s.Host, ["user"] = null, ["studioUser"] = s.User, ["windowOpen"] = entry != null, ["signedIn"] = false,
            ["cachePersistent"] = Xilium.CefGlue.Common.CefRuntimeLoader.IsLoaded ? WebViewControl.WebView.Settings.PersistCache : null
        };
        if (entry == null) { result["instruction"] = "portal-session open, then the user signs in in the window."; return result; }
        JsonObject? probe = null;
        try { probe = await PageEval(entry, PortalCore.ProbeScript, TimeSpan.FromSeconds(10)); }
        catch (Exception error) { result["pageError"] = PortalCore.RedactText(error.GetBaseException().Message); }
        result["page"] = probe == null ? null : new JsonObject { ["origin"] = probe["origin"]?.DeepClone(), ["path"] = probe["path"]?.DeepClone(), ["ready"] = probe["ready"]?.DeepClone(), ["csrf"] = probe["csrf"]?.DeepClone(), ["csrfSource"] = probe["csrfSource"]?.DeepClone(), ["cookieNames"] = probe["cookieNames"]?.DeepClone() };
        result["signedIn"] = PortalCore.PageSignedIn(probe, s.Host);
        result["signedInBasis"] = "the page is on https://" + s.Host + " outside /authentication and holds a CSRF token; a fetch is the proof";
        result["openedAt"] = entry.OpenedAt.ToString("o");
        if (entry.LastError != null) result["lastPageError"] = entry.LastError;
        return result;
    }

    // Closing ends the Portal session: the window goes, and the tenant host's cookies leave the Studio's browser engine
    // (memory and, when the Studio persists its cache, disk). Cookies of other hosts, the identity provider's included, stay.
    private sealed class CookiesDeleted : Xilium.CefGlue.CefDeleteCookiesCallback {
        public readonly TaskCompletionSource<int> Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override void OnComplete(int numDeleted) => Done.TrySetResult(numDeleted);
    }
    private static async Task<JsonObject> ClosePortalWindow(PortalSession s) {
        var closed = await Ui(() => {
            if (!PortalWindows.TryGetValue(s.Host, out var entry)) return false;
            PortalWindows.Remove(s.Host); entry.Window.Close(); return true;
        });
        int? deleted = null;
        if (Xilium.CefGlue.Common.CefRuntimeLoader.IsLoaded) {
            var callback = new CookiesDeleted();
            var manager = Xilium.CefGlue.CefCookieManager.GetGlobal(null);
            if (manager != null && manager.DeleteCookies("https://" + s.Host, "", callback)) {
                deleted = await callback.Done.Task.WaitAsync(TimeSpan.FromSeconds(10));
                manager.FlushStore(null);
            }
        }
        return new JsonObject { ["ok"] = true, ["source"] = "studio-web", ["host"] = s.Host, ["user"] = null, ["closed"] = closed, ["cookiesDeleted"] = deleted };
    }

    // Runs one Portal route in the page of the tenant's window. A write is reserved before the page is asked to send it,
    // and an answer that never arrives makes it uncertain; nothing is ever sent twice. A write that names secretRefs
    // gets its vault values once everything else is checked and the window is there, right before the reservation and
    // the send; the reservation hashes the body as the facade wrote it.
    private static async Task<JsonObject> PortalFetch(PortalSession s, string requestName, bool tenantNamed, Context c) {
        var started = DateTimeOffset.UtcNow;
        var r = PortalCore.ParseWebRequest(ReadPortalRequest(requestName));
        c.Feature = "portal-web:" + (r.OperationId ?? r.Path);
        var write = PortalCore.CheckWebRoute(r);
        if (write) {
            if (!tenantNamed) throw new Refusal("BAD_REQUEST", "A write names its tenant: --tenant <host>.");
            PortalCore.CheckTenant(PortalTenants(), s.Host, r.ConfirmTenant);
        }
        PortalCore.CheckSecretRefs(r.SecretRefs, write, s.Host, r.Body, PortalCore.WebSecretRoots);
        var entry = await Ui(() => PortalWindows.TryGetValue(s.Host, out var e) ? e : null);
        if (entry == null) throw new Refusal("WEB_SIGN_IN_REQUIRED", "No Portal window is open for " + s.Host + ": portal-session open, the user signs in there, then repeat.");
        var (send, placed) = PortalCore.PlaceWebSecrets(r, s.Host, write, PortalVault.Read);
        string? reservation = null;
        if (write) {
            var body = r.Body?.ToJsonString();
            reservation = PortalCore.Reserve(PortalPlaces.WritesDir, r.OperationUuid!, new JsonObject {
                ["state"] = "sending", ["at"] = started.ToString("o"), ["operationUuid"] = r.OperationUuid, ["operationId"] = r.OperationId, ["method"] = r.Method,
                ["host"] = s.Host, ["path"] = r.Path, ["authorizeSha256"] = r.AuthorizeSha256!.ToLowerInvariant(), ["studioUser"] = s.User, ["source"] = "studio-web",
                ["bodyBytes"] = body == null ? 0 : System.Text.Encoding.UTF8.GetByteCount(body),
                ["bodySha256"] = body == null ? null : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(body))).ToLowerInvariant(),
                ["secretRefs"] = PortalCore.SecretRefsRecord(r.SecretRefs)
            });
        }
        var id = Guid.NewGuid().ToString("N");
        JsonObject? page;
        JsonObject? begin = null; Exception? beginError = null;
        try { begin = await PageEval(entry, PortalCore.StartScript(id, "https://" + s.Host, send), TimeSpan.FromSeconds(15)); }
        catch (Exception error) { beginError = error; }
        var rechecked = false;
        if (NotStarted(begin)) {
            // C34 (atritos 3, capability portal:signin-recheck): after a single sign-on the window may rest on the identity
            // provider's origin, or on a tenant page whose CSRF token is not loaded yet. Nothing was sent: the window goes to
            // https://<host>/ once, the page is given time to settle, and the start is asked once more before the refusal.
            rechecked = true;
            (begin, beginError) = await RecheckSignIn(entry, s, id, send);
        }
        if (NotStarted(begin)) {
            var refusal = PortalCore.Fail("WEB_SIGN_IN_REQUIRED", (string?)begin!["reason"] == "csrf"
                ? "The Portal window holds no signed-in session (no CSRF token), also after reloading https://" + s.Host + "/: the user signs in there."
                : "The Portal window is on " + (string?)begin["origin"] + ", not on https://" + s.Host + ", also after reloading it: the user finishes signing in there.");
            refusal["rechecked"] = rechecked;
            PortalCore.Settle(reservation, "refused", refusal);
            return refusal;
        }
        if (begin == null) {
            // The script may have run and sent the call before its answer was lost.
            page = new JsonObject { ["state"] = "error", ["message"] = "the page did not confirm the start" + (beginError == null ? "" : ": " + beginError.GetBaseException().Message) };
        } else {
            var deadline = started + (write ? PortalCore.WriteTimeout : PortalCore.ReadTimeout);
            try {
                while (true) {
                    page = await PageEval(entry, PortalCore.PollScript(id), TimeSpan.FromSeconds(10));
                    if ((string?)page?["state"] != "pending") break;
                    if (DateTimeOffset.UtcNow > deadline) { page = new JsonObject { ["state"] = "error", ["message"] = "no answer within the timeout" }; break; }
                    await Task.Delay(200);
                }
            } catch (Exception error) { page = new JsonObject { ["state"] = "error", ["message"] = error.GetBaseException().Message }; }
        }
        var (result, state) = PortalCore.ShapeWeb(page, s.Host, write, reservation, PortalPlaces.DownloadsDir, placed);
        result["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
        if (write) { result["write"] = true; result["operationUuid"] = r.OperationUuid; }
        PortalCore.Settle(reservation, state, result);
        // The page's error text (a failed start or fetch) reaches the message and the journal note: masked like the body.
        return PortalCore.MaskAnswer(result, placed);
    }

    // The page answered that it did not start the call (another origin, no CSRF token): nothing was sent.
    private static bool NotStarted(JsonObject? begin) => begin != null && begin["started"] is JsonValue v && v.TryGetValue<bool>(out var began) && !began;
    // One reload of the tenant's root, up to 20 s for the page to show a signed-in session (the probe of portal-session
    // status), then the same start once more. The window and its cookies are the Studio's; nothing is typed.
    private static async Task<(JsonObject? Begin, Exception? Error)> RecheckSignIn(PortalWindow entry, PortalSession s, string id, PortalCore.WebRequest send) {
        try { await Ui(() => { entry.View.LoadUrl("https://" + s.Host + "/"); return true; }); }
        catch (Exception error) { return (null, error); }
        var until = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(20);
        while (DateTimeOffset.UtcNow < until) {
            await Task.Delay(500);
            JsonObject? probe = null;
            try { probe = await PageEval(entry, PortalCore.ProbeScript, TimeSpan.FromSeconds(5)); } catch { }
            if (PortalCore.PageSignedIn(probe, s.Host)) break;
        }
        try { return (await PageEval(entry, PortalCore.StartScript(id, "https://" + s.Host, send), TimeSpan.FromSeconds(15)), null); }
        catch (Exception error) { return (null, error); }
    }

    // ---- auth-status: the signed-in Studio sessions per tenant, without any secret: host, user, tenant id, the expiry
    // instant of the access token (never the token), the user's permissions; and the open Portal windows.
    private static async Task<object> AuthStatus(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            if (words.Length != 0) throw new Refusal("BAD_REQUEST", "auth-status takes only [--tenant <host>].");
            bool Wanted(string? host) => tenant == null || string.Equals(host, tenant, StringComparison.OrdinalIgnoreCase);
            var (sessions, windows) = await Ui(() => {
                var list = new JsonArray();
                foreach (var p in RuntimeImplementation.Instance.GetAllTopLevelPresenters()) {
                    var provider = p.ServerCommunicationsProvider; var host = Host(p);
                    if (provider?.IsLoggedIn != true || host == null || !Wanted(host)) continue;
                    var login = provider.LoginInfo;
                    var entry = new JsonObject { ["host"] = host, ["loggedIn"] = true, ["user"] = login.Username, ["tenantId"] = login.HostInfo?.TenantId, ["tokenValidUntil"] = AccessTokenValidUntil(login) };
                    try { entry["permissions"] = new JsonArray(login.GetPermissions().Select(x => (JsonNode)JsonValue.Create(x.ToString())!).ToArray()); }
                    catch (Exception error) { entry["permissionsError"] = error.GetBaseException().Message; }
                    list.Add(entry);
                }
                return (list, PortalWindows.Where(w => Wanted(w.Key)).Select(w => (Host: w.Key, Entry: w.Value)).ToArray());
            });
            var portalWindows = new JsonArray();
            foreach (var (host, entry) in windows) {
                JsonObject? probe = null;
                try { probe = await PageEval(entry, PortalCore.ProbeScript, TimeSpan.FromSeconds(5)); } catch { }
                portalWindows.Add(new JsonObject { ["host"] = host, ["signedIn"] = PortalCore.PageSignedIn(probe, host) });
            }
            var match = sessions.OfType<JsonObject>().FirstOrDefault();
            // capabilities tells this build from the first v32, which refused secretRefs (secret_refs_unsupported).
            var result = new JsonObject {
                ["ok"] = true, ["source"] = "studio", ["host"] = tenant, ["user"] = tenant == null ? null : match?["user"]?.DeepClone(), ["bridge"] = Version,
                ["capabilities"] = new JsonArray("portal-call", "portal-session", "auth-status", "portal-call:secretRefs", "portal-session:secretRefs",
                    "portal-upload", "reference-snapshot:external-library", "portal:signin-recheck"),
                ["sessions"] = sessions, ["portalWindows"] = portalWindows, ["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds
            };
            if (tenant != null && match == null) result["note"] = "The Studio has no signed-in session on " + tenant + ".";
            return PortalAnswer(c, result);
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
    }
    // Only the expiry instant the Studio computed from the access token at its last renewal; the token is never read.
    private static string? AccessTokenValidUntil(ServiceStudio.Identity.Login.LoginInfo login) {
        var until = login.TokenInfo?.ValidUntil;
        return until == null || until == DateTime.MinValue ? null : DateTime.SpecifyKind(until.Value, DateTimeKind.Utc).ToString("o");
    }
}
