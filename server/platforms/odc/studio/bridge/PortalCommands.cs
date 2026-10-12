using System.Text.Json;
using System.Text.Json.Nodes;
using ServiceStudio.Presenter;
using Refusal = PortalCore.Refusal;

// Public ODC APIs use the Studio's authenticated HttpClient. Internal Portal HTTP
// authentication is not implemented in this bridge; portal-session reports that
// limitation without touching a WebView, browser cookies or the Studio login.
// Vault secretRefs are resolved inside this process only for authorized public writes.
// Usage: portal-call <request.json in journal\portal\requests> [--tenant <host>]
//        portal-upload <request.json in journal\portal\requests> --tenant <host>   (package in journal\portal\uploads)
//        portal-session status|open|close|recheck [--tenant <host>]
//        portal-session fetch <request.json in journal\portal\requests> [--tenant <host>]
//        auth-status [--tenant <host>]
// A write names its tenant with --tenant and carries write:true, operationUuid and authorizeSha256 in its request file;
// a secret it needs is named there as secretRefs [{pointer, target:'SSAM/ODC3/<host>/<kind>/<name>', field}], never sent.
internal static partial class Bridge {
    private static async Task<object> PortalApiClientFixtureCleanup(string argument,Context c){
        var started=DateTimeOffset.UtcNow;
        try{
            var (words,tenant)=PortalArguments(argument);
            if(words.Length!=1||tenant==null)throw new Refusal("BAD_REQUEST","portal-api-client-fixture-cleanup takes one request file and --tenant.");
            var request=JsonNode.Parse(ReadPortalRequest(words[0])) as JsonObject??throw new Refusal("BAD_REQUEST","Expected a fixture cleanup request.");
            var session=await Ui(()=>ResolvePortalSession(tenant));
            if(string.IsNullOrWhiteSpace(session.User))throw new Refusal("HEADLESS_AUTH_UNAVAILABLE","The native Studio principal could not be established.");
            c.Feature="portal-private:api-client-fixture-cleanup";
            return PortalAnswer(c,PortalApiClientCleanup.Cleanup(PortalPlaces.WritesDir,Path.Combine(PortalDir,"receipts"),request,
                session.Host,session.User,PortalVault.DeleteApiClientFixture,PortalVault.Read));
        }catch(Refusal refusal){return PortalRefusal(c,refusal,started);}
        catch{return PortalRefusal(c,new Refusal("UNCERTAIN","Fixture cleanup did not preserve a conclusive result; no private value is exposed."),started);}
    }
    private static async Task<object> PortalPrivateDownload(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            if (words.Length != 2 || tenant == null) throw new Refusal("BAD_REQUEST", "portal-private-download takes <request.json> <pipeId> --tenant <host>.");
            _ = Ssam.PrivateTransport.PrivateHttpContext.PipeName(words[1]);
            var json = ReadPortalRequest(words[0]);
            var session = await Ui(() => ResolvePortalSession(tenant));
            if (string.IsNullOrWhiteSpace(session.User)) throw new Refusal("HEADLESS_AUTH_UNAVAILABLE", "The native Studio principal could not be established.");
            if ((string?)JsonNode.Parse(json)?["operationId"] == "mobileExtensibility.downloadFile")
                return await PortalPrivateMobileDownload(words, tenant, json, c);
            var request = PortalKnowledgeDownload.Parse(JsonNode.Parse(json) as JsonObject ?? throw new Refusal("BAD_REQUEST", "Expected a download request object."), session.Host, DateTimeOffset.UtcNow);
            c.Feature = "portal-private:knowledge-download";
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
            using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(1, request.Deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())));
            var context = await Ssam.PrivateTransport.PrivateHttpContext.Receive(words[1], hash, session.Host, session.User, timeout.Token);
            var current = await Ui(() => ResolvePortalSession(tenant));
            if (!string.Equals(current.User, session.User, StringComparison.OrdinalIgnoreCase) || current.TenantId != session.TenantId) throw new Refusal("HEADLESS_AUTH_UNAVAILABLE", "The Studio login changed during private read handoff.");
            using var portal = PortalPrivateHttp.NewClient(); using var storage = PortalPrivateHttp.NewClient();
            return PortalAnswer(c, await PortalKnowledgeDownload.Send(portal, storage, request, context, session.Host, session.User, PortalPlaces.DownloadsDir, timeout.Token));
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
        catch { return PortalRefusal(c, new Refusal("KNOWLEDGE_DOWNLOAD_UNVERIFIED", "Private knowledge-file read did not return a verified result; no private value is exposed."), started); }
    }
    private static async Task<object> PortalPrivateMobileDownload(string[] words, string tenant, string json, Context c) {
        var started=DateTimeOffset.UtcNow;
        try {
            var session=await Ui(()=>ResolvePortalSession(tenant));
            if(string.IsNullOrWhiteSpace(session.User))throw new Refusal("HEADLESS_AUTH_UNAVAILABLE","The native Studio principal could not be established.");
            var request=PortalMobileDownload.Parse(JsonNode.Parse(json) as JsonObject??throw new Refusal("BAD_REQUEST","Expected a private mobile download request."),session.Host,DateTimeOffset.UtcNow);
            c.Feature="portal-private:mobile-download";
            var hash=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
            using var timeout=new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(1,request.Deadline-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())));
            var context=await Ssam.PrivateTransport.PrivateHttpContext.Receive(words[1],hash,session.Host,session.User,timeout.Token);
            var current=await Ui(()=>ResolvePortalSession(tenant));
            if(!string.Equals(current.User,session.User,StringComparison.OrdinalIgnoreCase)||current.TenantId!=session.TenantId)throw new Refusal("HEADLESS_AUTH_UNAVAILABLE","The Studio login changed during private read handoff.");
            using var portal=PortalPrivateHttp.NewClient();
            return PortalAnswer(c,await PortalMobileDownload.Send(portal,request,context,session.Host,session.User,PortalPlaces.DownloadsDir,timeout.Token));
        }catch(Refusal refusal){return PortalRefusal(c,refusal,started);}
        catch{return PortalRefusal(c,new Refusal("MOBILE_DOWNLOAD_UNVERIFIED","Private persisted file read did not verify; no private value is exposed."),started);}
    }
    // Receives only this broker's own context over a local private pipe. The
    // request file has public metadata and vault references, never credentials.
    private static async Task<object> PortalPrivateCall(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        var enteredSend = false;
        try {
            var (words, tenant) = PortalArguments(argument);
            if (words.Length != 2 || tenant == null)
                throw new Refusal("BAD_REQUEST", "portal-private-call takes <request.json> <pipeId> --tenant <host>.");
            _ = Ssam.PrivateTransport.PrivateHttpContext.PipeName(words[1]);
            var json = ReadPortalRequest(words[0]);
            var request = PortalCore.ParseWebRequest(json);
            var session = await Ui(() => ResolvePortalSession(tenant));
            PortalPrivateHttp.Validate(request, session.Host, PortalTenants());
            if (string.IsNullOrWhiteSpace(session.User))
                throw new Refusal("HEADLESS_AUTH_UNAVAILABLE", "The native Studio principal could not be established.");
            c.Feature = "portal-private:" + (request.OperationId ?? request.Path);
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
            using var receiveTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var context = await Ssam.PrivateTransport.PrivateHttpContext.Receive(words[1], hash, session.Host, session.User, receiveTimeout.Token);
            var current = await Ui(() => ResolvePortalSession(tenant));
            if (!string.Equals(current.User, session.User, StringComparison.OrdinalIgnoreCase) || current.TenantId != session.TenantId)
                throw new Refusal("HEADLESS_AUTH_UNAVAILABLE", "The Studio login changed during private session handoff. Nothing was sent.");
            using var client = PortalPrivateHttp.NewClient();
            using var sendTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            enteredSend = true;
            return PortalAnswer(c, await PortalPrivateHttp.Send(client, request, context, session.Host, session.User,
                PortalTenants(), PortalPlaces, PortalVault.Read, sendTimeout.Token, apiClientVaultWriter: PortalVault.StoreNewApiClient));
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
        catch { return PortalRefusal(c, new Refusal(enteredSend ? "UNCERTAIN" : "HEADLESS_AUTH_UNAVAILABLE", enteredSend
            ? "Private transport did not preserve the write outcome. Reconcile by a read; never resend."
            : "Private session handoff failed before native HTTP send; no session value is exposed."), started); }
    }
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
                + "; authenticated headless access is unavailable. Sessions: " + JsonSerializer.Serialize(Sessions()));
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
            if (client == null) throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio session on " + session.Host + " offers no authenticated client; authenticated headless access is unavailable.");
            if (!PortalCore.TenantHeaderMatches(client, session.TenantId))
                throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio's HTTP client still belongs to an earlier login (its tenant id is not " + session.Host + "'s); the mismatched client cannot be used. No request was sent.");
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
            if (client == null) throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio session on " + session.Host + " offers no authenticated client; authenticated headless access is unavailable.");
            if (!PortalCore.TenantHeaderMatches(client, session.TenantId))
                throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio's HTTP client still belongs to an earlier login (its tenant id is not " + session.Host + "'s); the mismatched client cannot be used. No request was sent.");
            return PortalAnswer(c, await PortalUpload.Run(client, request, session.Host, session.User, PortalTenants(), PortalPlaces,
                Path.Combine(PortalDir, "uploads"), PortalUpload.NewUploadClient));
        } catch (Refusal refusal) { return PortalRefusal(c, refusal, started); }
    }

    // Compatibility surface: status is read-only, close is a no-op, and operations
    // needing an internal session fail before reading a request file or touching UI.
    private static Task<object> PortalSessionCommand(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            var action = words.FirstOrDefault() ?? "";
            c.Feature = "portal-session:" + action;
            var result = PortalCore.HeadlessSession(action, words.Length, tenant);
            result["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
            return Task.FromResult(PortalAnswer(c, result));
        } catch (Refusal refusal) { return Task.FromResult(PortalRefusal(c, refusal, started)); }
    }

    // ---- auth-status: the signed-in Studio sessions per tenant, without any secret: host, user, tenant id, the expiry
    // instant of the access token (never the token), the user's permissions; no browser is inspected.
    private static async Task<object> AuthStatus(string argument, Context c) {
        var started = DateTimeOffset.UtcNow;
        try {
            var (words, tenant) = PortalArguments(argument);
            if (words.Length != 0) throw new Refusal("BAD_REQUEST", "auth-status takes only [--tenant <host>].");
            bool Wanted(string? host) => tenant == null || string.Equals(host, tenant, StringComparison.OrdinalIgnoreCase);
            var sessions = await Ui(() => {
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
                return list;
            });
            var match = sessions.OfType<JsonObject>().FirstOrDefault();
            // capabilities tells this build from the first v32, which refused secretRefs (secret_refs_unsupported).
            var result = new JsonObject {
                ["ok"] = true, ["source"] = "studio", ["host"] = tenant, ["user"] = tenant == null ? null : match?["user"]?.DeepClone(), ["bridge"] = Version,
                ["capabilities"] = new JsonArray("portal-call", "portal-session", "auth-status", "portal-call:secretRefs",
                    "portal-upload", "reference-snapshot:external-library", "portal-private-call:headless:secretRefs", "portal-private-call:optional-csrf", "portal-private-call:mobile-upload", "portal-private-call:knowledge-download", "portal-private-call:mobile-download", "portal-private-call:api-client-vault", "portal-api-client-fixture-cleanup"),
                ["sessions"] = sessions, ["portalWindows"] = new JsonArray(), ["elapsedMs"] = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds
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
