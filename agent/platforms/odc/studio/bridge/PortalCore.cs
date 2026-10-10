using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// Portal lane of the bridge (v32), the part that never touches a Studio type: which requests may leave, the single
// send through the Studio's authenticated HttpClient, the write reservation, the vault values a write names
// (secretRefs) and the redaction of every answer. PortalCommands.cs binds it to the Studio session, to the Portal
// window and to the Windows vault (PortalVault.cs); studio\bridge\tests compiles this file alone, with a fake vault.
// Answers follow _notes\scp\CONTRATO.md: { ok:true, source, host, user, elapsedMs, ... } or { ok:false, code, message }.
internal static class PortalCore {
    // servers[].url of the 14 public API families in portal\catalog\catalog.json. The Studio's handler puts the user's
    // Bearer on ANY URI it is given, so nothing outside these prefixes on the session's own host is ever sent.
    public static readonly string[] BasePaths = {
        "/api/asset-configurations/v1", "/api/asset-repository/v1", "/api/builds/v1", "/api/code-quality/v1",
        "/api/dependency-management/v1", "/api/deployments/v1", "/api/environment-configurations/v1", "/api/external-libraries/v1",
        "/api/native-mobile-builds/v1", "/api/organization/v1", "/api/portfolios/v1", "/api/portfolios/v2",
        "/api/subscription/v1", "/api/identity/v1"
    };
    // The catalog POSTs that only read or search (effect class search-post). Every other non-GET changes the tenant.
    private static readonly (string BasePath, Regex Path)[] ReadPosts = {
        ("/api/asset-repository/v1", new Regex("^/assets/search$")),
        ("/api/dependency-management/v1", new Regex("^/public-elements/search$")),
        ("/api/environment-configurations/v1", new Regex("^/environments/[^/]+/builtin-domains/availability$")),
        ("/api/organization/v1", new Regex("^/builtin-domains/availability$")),
        ("/api/native-mobile-builds/v1", new Regex("^/build-operations/version-suggestions$")),
        ("/api/native-mobile-builds/v1", new Regex("^/build-operations/native-build-validation$")),
    };
    // Internal Portal routes known to only read (tool-surface\odc-portal-internal-routes.csv, class read). Any other
    // screenservice may change the tenant and goes only as an authorized write.
    public static readonly HashSet<string> KnownWebReads = new(StringComparer.Ordinal) {
        "agents/Datasets/Dataset_CreateForm/ActionDataset_GetTemplate_Wrapper", "agents/Datasets/Dataset_CreateForm/DataActionGetAgenticApps",
        "agents/Datasets/Dataset_CreateForm/DataActionGetServiceActionsByApp", "agents/EvaluationRuns/EvaluationRun_DetailedResults/DataActionGetEvaluationRun",
        "agents/Evaluations/evaluation/ActionEvaluationRun_GetStatus_Wrapper", "agents/Evaluations/Evaluation_CreateForm/DataActionGetJudges",
        "agents/MainFlow_Agents/agent/DataActionGetApplicationStages", "agents/MainFlow_Agents/agent/DataActionGetLatestAgentRevision",
        "agents/Mainflow_Evaluations/EvalsHome_DatasetList/DataActionGetDatasets", "agents/Mainflow_Evaluations/EvalsHome_EvaluationList/DataActionGetEvaluations",
        "agents/Mainflow_Evaluations/EvalsHome_RunsList/DataActionGetEvaluationRuns", "agents/Mainflow_Evaluations/evaluations/ActionCheckEvaluationsConsoleAvailability",
        "agents/Tab_AgentElements/Agent_Elements/DataActionGetAgents", "agents/Tab_AgentElements/Agent_Guardrails/DataActionGetAgentGuardrail",
        "connections/Connections/connection/DataActionGetSettings", "connections/Connections/connections/DataActionGetConnections",
        "connections/Connections/connections/DataActionGetProviders", "connections/Connections/elements/ActionConnection_GetEntityAttributes_Wrapper",
        "connections/Connections/elements/DataActionGetActions", "connections/Connections/elements/DataActionGetConnection",
        "connections/Connections/elements/DataActionGetEntities", "connections/Connections/elements/DataActionGetSelectedActions",
        "connections/Connections/elements/DataActionGetSelectedEntities", "connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus",
        "connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnection_CheckNameAvailability_Wrapper",
        "connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetAuthenticationSchemes",
        "connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetAuthenticationTypes",
        "connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetKeyLocations",
        "connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetTransportTypes",
        "connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_CheckNameAvailability_Wrapper",
        "monitoring/logs/log/DataActionGetLogById", "monitoring/logs/logs/ActionLogSearch_Wrapper", "monitoring/logs/logs/ActionStage_GetApplications_Wrapper",
        "monitoring/logs/logs/DataActionGetFilter_Stages", "monitoring/logs/logs/DataActionLogSearch", "monitoring/traces/trace/DataActionGetTraceById",
        "monitoring/traces/traces/ActionTraceSearch_Wrapper", "monitoring/traces/TreeView_multipleRoots/DataActionGetLogsByTraceId",
        "monitoring/traces/TreeView_multipleRoots/DataActionGetSpans",
    };
    // The login flow belongs to the user in the window and the public API to portal-call; no page route reaches either.
    private static readonly string[] DeniedWebModules = { "authentication", "identity", "api" };
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(60), WriteTimeout = TimeSpan.FromSeconds(120);
    public const int InlineLimit = 4 * 1024 * 1024, ReadLimit = 16 * 1024 * 1024;
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    public sealed class Refusal : Exception {
        public string Code { get; }
        public string? Gate { get; }
        public Refusal(string code, string message, string? gate = null) : base(message) { Code = code; Gate = gate; }
    }
    public sealed record ApiRequest(string? OperationId, string? ApiId, string Method, string BasePath, string Path, string? Query, string? ContentType,
        JsonNode? Body, string? BodyBase64, bool Write, string? OperationUuid, string? AuthorizeSha256, string? ConfirmTenant, IReadOnlyList<SecretRef>? SecretRefs = null);
    public sealed record WebRequest(string? OperationId, string Method, string Path, JsonNode? Body, bool Write, string? OperationUuid, string? AuthorizeSha256, string? ConfirmTenant,
        IReadOnlyList<SecretRef>? SecretRefs = null);
    public sealed record TenantPolicy(string? Default, HashSet<string> ReadOnly);
    // Where a write leaves its reservation and outcome, and where an answer too large to inline is stored (redacted).
    public sealed record Places(string WritesDir, string DownloadsDir);

    // ---- request files (written by the facade under journal\portal\requests)
    private static JsonObject ParseObject(string json) {
        JsonObject o;
        try { o = JsonNode.Parse(json) as JsonObject ?? throw new Refusal("BAD_REQUEST", "The request file must hold one JSON object."); }
        catch (JsonException e) { throw new Refusal("BAD_REQUEST", "The request file is not JSON: " + e.Message); }
        return o;
    }
    private static string? Text(JsonObject o, string name) => o[name] switch {
        null => null,
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        _ => throw new Refusal("BAD_REQUEST", name + " must be a string.")
    };
    private static bool Flag(JsonObject o, string name) => o[name] switch {
        null => false,
        JsonValue v when v.TryGetValue<bool>(out var b) => b,
        _ => throw new Refusal("BAD_REQUEST", name + " must be true or false.")
    };
    public static ApiRequest ParseApiRequest(string json) {
        var o = ParseObject(json);
        var method = (Text(o, "method") ?? "").ToUpperInvariant();
        if (method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE")) throw new Refusal("BAD_REQUEST", "method must be GET, POST, PUT, PATCH or DELETE.");
        if (o["body"] != null && o["bodyBase64"] != null) throw new Refusal("BAD_REQUEST", "Send body or bodyBase64, not both.");
        if (method == "GET" && (o["body"] != null || o["bodyBase64"] != null)) throw new Refusal("BAD_REQUEST", "A GET carries no body.");
        var secretRefs = ParseSecretRefs(o);
        if (secretRefs.Count > 0 && o["bodyBase64"] != null) throw new Refusal("BAD_REQUEST", "secretRefs point into a JSON body, never into bodyBase64.", "secret_ref_invalid");
        return new ApiRequest(Text(o, "operationId"), Text(o, "apiId"), method, Text(o, "basePath") ?? "", Text(o, "path") ?? "", Text(o, "query"),
            Text(o, "contentType"), o["body"]?.DeepClone(), Text(o, "bodyBase64"), Flag(o, "write"), Text(o, "operationUuid"), Text(o, "authorizeSha256"), Text(o, "confirmTenant"), secretRefs);
    }
    public static WebRequest ParseWebRequest(string json) {
        var o = ParseObject(json);
        var method = (Text(o, "method") ?? "POST").ToUpperInvariant();
        if (method is not ("GET" or "POST")) throw new Refusal("BAD_REQUEST", "Portal page routes take GET or POST.");
        if (method == "GET" && o["body"] != null) throw new Refusal("BAD_REQUEST", "A GET carries no body.");
        return new WebRequest(Text(o, "operationId"), method, Text(o, "path") ?? "", o["body"]?.DeepClone(), Flag(o, "write"), Text(o, "operationUuid"), Text(o, "authorizeSha256"), Text(o, "confirmTenant"),
            ParseSecretRefs(o));
    }

    // ---- what may leave
    private static readonly Regex HostName = new(@"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", RegexOptions.IgnoreCase);
    private static readonly Regex PathText = new(@"^(/[A-Za-z0-9\-._~%!$&'()*+,;=:@]+)+$");
    private static readonly Regex QueryText = new(@"^[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$");
    private static readonly Regex EncodedSeparator = new("%(2e|2f|5c|00)", RegexOptions.IgnoreCase);
    public static void CheckPath(string path) {
        if (!PathText.IsMatch(path)) throw new Refusal("BAD_REQUEST", "path must be /segment[/segment...] of URL characters, without '?', '#', '\\', spaces or empty segments: " + path);
        if (path.Split('/').Any(s => s is "." or "..") || EncodedSeparator.IsMatch(path)) throw new Refusal("BAD_REQUEST", "path may not climb or encode separators: " + path);
    }
    public static bool SameHost(Uri? uri, string host) =>
        uri != null && uri.IsAbsoluteUri && uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort && uri.UserInfo == "" && string.Equals(uri.IdnHost, host, StringComparison.OrdinalIgnoreCase);
    public static void CheckHost(string host) {
        if (!HostName.IsMatch(host)) throw new Refusal("HOST_MISMATCH", "The session host is not a plain DNS name: " + host);
    }
    // https://<session host><allowlisted basePath><path>?<query>, checked again after Uri normalization.
    public static Uri BuildUri(string host, string basePath, string path, string? query) {
        CheckHost(host);
        if (!BasePaths.Contains(basePath, StringComparer.Ordinal)) throw new Refusal("NOT_ALLOWED", "basePath '" + basePath + "' is not a public API family of the catalog: " + string.Join(", ", BasePaths));
        CheckPath(path);
        if (query != null && (query.StartsWith('?') || !QueryText.IsMatch(query))) throw new Refusal("BAD_REQUEST", "query must be already serialized, without the leading '?', '#', spaces or control characters.");
        var uri = new Uri("https://" + host + basePath + path + (string.IsNullOrEmpty(query) ? "" : "?" + query), UriKind.Absolute);
        if (!SameHost(uri, host) || uri.Fragment != "" || !uri.AbsolutePath.StartsWith(basePath + "/", StringComparison.Ordinal))
            throw new Refusal("HOST_MISMATCH", "The request would leave https://" + host + basePath + "; refused before sending.");
        return uri;
    }
    public static bool IsReadPost(string basePath, string path) => ReadPosts.Any(r => r.BasePath == basePath && r.Path.IsMatch(path));
    public static void CheckWriteFields(string? operationUuid, string? authorizeSha256) {
        if (!Guid.TryParseExact(operationUuid ?? "", "D", out _)) throw new Refusal("BAD_REQUEST", "A write needs operationUuid, the UUID the facade reserved in its journal.");
        if (authorizeSha256 == null || !Regex.IsMatch(authorizeSha256, "^[0-9a-fA-F]{64}$")) throw new Refusal("BAD_REQUEST", "A write needs authorizeSha256, the sha256 (64 hex) of the user's authorization words.");
    }
    // A request is a write when the facade marks it so or when it is not a known read; an unmarked write is refused.
    public static bool Classify(bool knownRead, bool markedWrite, string what) {
        if (!knownRead && !markedWrite) throw new Refusal("NOT_ALLOWED", what + " is not a known read: send it as a write (write:true, operationUuid, authorizeSha256) after the user's words.");
        return markedWrite || !knownRead;
    }

    // ---- tenant guard: tenants.json readOnly refuses every write; any host but the default (personal) tenant needs
    // confirmTenant naming it in the request, the facade's record of the user's explicit instruction for this operation.
    public static TenantPolicy ReadTenants(string? json) {
        var readOnly = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(json)) return new TenantPolicy(null, readOnly);
        try {
            var root = JsonNode.Parse(json) as JsonObject;
            if (root?["tenants"] is JsonObject tenants)
                foreach (var (host, entry) in tenants) if (entry is JsonObject e && e["readOnly"] is JsonValue v && v.TryGetValue<bool>(out var b) && b) readOnly.Add(host);
            return new TenantPolicy(root?["default"] is JsonValue d && d.TryGetValue<string>(out var s) ? s : null, readOnly);
        } catch (JsonException) { return new TenantPolicy(null, readOnly); }
    }
    public static void CheckTenant(TenantPolicy policy, string host, string? confirmTenant) {
        if (policy.ReadOnly.Contains(host)) throw new Refusal("NOT_ALLOWED", host + " is read-only in tenants.json; no write is sent there.", "tenant_read_only");
        if (!string.Equals(host, policy.Default, StringComparison.OrdinalIgnoreCase) && !string.Equals(confirmTenant, host, StringComparison.OrdinalIgnoreCase))
            throw new Refusal("NOT_ALLOWED", "A write on " + host + " (not the default personal tenant) needs confirmTenant = '" + host + "', recorded from the user's explicit instruction for this operation.", "tenant_confirmation");
    }

    // ---- secretRefs: a write names Windows vault entries instead of carrying a secret (the password of an external
    // database, a secret setting). The facade leaves the empty placeholder "" at each JSON pointer of the body; right
    // before the send the bridge reads the entry inside the Studio process and puts its user name or secret there. The
    // value never reaches a file, an answer or a log: the reservation hashes the body as the facade wrote it, and every
    // value placed is masked again in what comes back.
    public sealed record SecretRef(string Pointer, string Target, string Field);
    // A generic credential of the user's vault (CredRead in the Studio process, PortalVault.cs); null when absent.
    public sealed record VaultEntry(string? UserName, string? Secret);
    public delegate VaultEntry? VaultReader(string target);
    public const int MaxSecretRefs = 32;
    // A screenservice body takes vault values only in the data the screen sends, never in versionInfo or viewName.
    public static readonly string[] WebSecretRoots = { "/inputParameters/", "/screenData/variables/", "/clientVariables/" };
    // Entries of the session's tenant, SSAM/ODC3/<host>/<kind>/<name> (DB/<connection> for an external database). The
    // lane's own sign-in entries (SSAM/ODC3/<host>/APIClient and /Portal) are never placed in a body.
    private static readonly Regex SecretTarget = new(@"^SSAM/ODC3/([^/]+)/([A-Za-z0-9_-]{1,32})/([A-Za-z0-9_.-]{1,64})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly string[] SignInKinds = { "APIClient", "Portal" };
    private static readonly Regex PointerIndex = new("^(0|[1-9][0-9]{0,8})$");

    private static IReadOnlyList<SecretRef> ParseSecretRefs(JsonObject o) {
        var node = o["secretRefs"];
        if (node == null) return Array.Empty<SecretRef>();
        if (node is not JsonArray list || list.Count == 0 || list.Count > MaxSecretRefs)
            throw new Refusal("BAD_REQUEST", "secretRefs is a list of 1 to " + MaxSecretRefs + " {pointer, target, field}.", "secret_ref_invalid");
        var refs = new List<SecretRef>();
        foreach (var item in list) {
            // An entry says where the value goes and where it lives; one that carries anything else (a value) is refused.
            if (item is not JsonObject entry || entry.Any(member => member.Key is not ("pointer" or "target" or "field")))
                throw new Refusal("BAD_REQUEST", "Each secretRefs entry is {pointer, target, field} and carries no value.", "secret_ref_invalid");
            string? Named(string name) => entry[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
            var pointer = Named("pointer"); var target = Named("target"); var field = Named("field");
            if (pointer == null || !pointer.StartsWith('/') || target == null || field is not ("password" or "username"))
                throw new Refusal("BAD_REQUEST", "A secretRefs entry needs a JSON pointer (/...), a vault target and field 'password' or 'username'.", "secret_ref_invalid");
            refs.Add(new SecretRef(pointer, target, field));
        }
        if (refs.Select(r => r.Pointer).Distinct(StringComparer.Ordinal).Count() != refs.Count)
            throw new Refusal("BAD_REQUEST", "secretRefs name each pointer once.", "secret_ref_invalid");
        return refs;
    }

    // Before the vault is touched: only a write, only entries of this tenant, only the empty placeholders of a JSON body
    // (under one of roots when given). Nothing is read or sent when a check fails.
    public static void CheckSecretRefs(IReadOnlyList<SecretRef>? refs, bool write, string host, JsonNode? body, string[]? roots = null) {
        if (refs == null || refs.Count == 0) return;
        if (!write) throw new Refusal("BAD_REQUEST", "secretRefs go only with a write (write:true, operationUuid, authorizeSha256).", "secret_ref_invalid");
        foreach (var r in refs) {
            var target = SecretTarget.Match(r.Target);
            if (!target.Success || !string.Equals(target.Groups[1].Value, host, StringComparison.OrdinalIgnoreCase) || SignInKinds.Contains(target.Groups[2].Value, StringComparer.OrdinalIgnoreCase))
                throw new Refusal("NOT_ALLOWED", "secretRefs name only vault entries SSAM/ODC3/" + host + "/<kind>/<name> of this tenant, never its sign-in entries: " + r.Target, "secret_ref_target");
            if (roots != null && !roots.Any(root => r.Pointer.StartsWith(root, StringComparison.Ordinal)))
                throw new Refusal("BAD_REQUEST", "secretRefs pointers start in " + string.Join(", ", roots) + ": " + r.Pointer, "secret_ref_invalid");
            var (parent, key) = Locate(body, r.Pointer);
            if (Step(parent, key, r.Pointer) is not JsonValue value || !value.TryGetValue<string>(out var placeholder) || placeholder != "")
                throw new Refusal("BAD_REQUEST", "secretRefs pointer " + r.Pointer + " must hold the empty placeholder \"\" in the body.", "secret_ref_invalid");
        }
    }
    // RFC 6901: the object or array the pointer ends in and the last member name or index; every step must exist.
    private static (JsonNode Parent, string Key) Locate(JsonNode? body, string pointer) {
        var parts = pointer[1..].Split('/').Select(part => part.Replace("~1", "/").Replace("~0", "~")).ToArray();
        var node = body;
        foreach (var part in parts[..^1]) node = Step(node, part, pointer);
        if (node is not (JsonObject or JsonArray)) throw new Refusal("BAD_REQUEST", "secretRefs pointer " + pointer + " does not exist in the body.", "secret_ref_invalid");
        return (node, parts[^1]);
    }
    private static JsonNode? Step(JsonNode? node, string key, string pointer) => node switch {
        JsonObject o when o.ContainsKey(key) => o[key],
        JsonArray a when PointerIndex.IsMatch(key) && int.Parse(key) < a.Count => a[int.Parse(key)],
        _ => throw new Refusal("BAD_REQUEST", "secretRefs pointer " + pointer + " does not exist in the body.", "secret_ref_invalid")
    };

    // Reads each vault entry once (a body may take the same password several times) and puts the field at its pointer
    // of body, the copy that is sent right away. Answers the values placed and the forms an echo of them takes in JSON
    // text, HTML and URLs, longest first, for the mask of the answer.
    public static IReadOnlyList<string> PlaceSecrets(JsonNode body, IReadOnlyList<SecretRef> refs, VaultReader? vault) {
        if (vault == null) throw new Refusal("BAD_REQUEST", "This bridge reads no vault; nothing was sent.", "secret_ref_vault");
        var entries = new Dictionary<string, VaultEntry>(StringComparer.OrdinalIgnoreCase);
        var placed = new List<string>();
        foreach (var r in refs) {
            if (!entries.TryGetValue(r.Target, out var entry)) {
                VaultEntry? read;
                try { read = vault(r.Target); }
                catch (Refusal) { throw; }
                catch (Exception) { throw new Refusal("BAD_REQUEST", "The Windows vault could not be read inside the Studio; nothing was sent.", "secret_ref_vault"); }
                entries[r.Target] = entry = read ?? throw new Refusal("BAD_REQUEST", "The vault entry " + r.Target + " does not exist: the user stores it in the private prompt first; nothing was sent.", "secret_ref_missing");
            }
            var value = r.Field == "password" ? entry.Secret : entry.UserName;
            if (string.IsNullOrEmpty(value)) throw new Refusal("BAD_REQUEST", "The vault entry " + r.Target + " holds no " + r.Field + "; nothing was sent.", "secret_ref_missing");
            var (parent, key) = Locate(body, r.Pointer);
            if (parent is JsonObject o) o[key] = value; else ((JsonArray)parent)[int.Parse(key)] = value;
            placed.Add(value);
        }
        return placed.SelectMany(value => new[] { value, JsonEncodedText.Encode(value).ToString(), JsonEncodedText.Encode(value, JavaScriptEncoder.UnsafeRelaxedJsonEscaping).ToString(),
            System.Net.WebUtility.HtmlEncode(value), Uri.EscapeDataString(value) }).Distinct(StringComparer.Ordinal).OrderByDescending(v => v.Length).ToArray();
    }
    // The request the page sends: the facade's, with the vault values in a copy of its body when the write names secretRefs.
    public static (WebRequest Send, IReadOnlyList<string> Placed) PlaceWebSecrets(WebRequest r, string host, bool write, VaultReader? vault) {
        CheckSecretRefs(r.SecretRefs, write, host, r.Body, WebSecretRoots);
        if (r.SecretRefs is not { Count: > 0 } refs) return (r, Array.Empty<string>());
        var body = r.Body!.DeepClone();
        return (r with { Body = body }, PlaceSecrets(body, refs, vault));
    }
    // What the reservation keeps of secretRefs: where each value went and which entry it came from, never the value.
    public static JsonArray? SecretRefsRecord(IReadOnlyList<SecretRef>? refs) => refs is not { Count: > 0 } ? null
        : new JsonArray(refs.Select(r => (JsonNode)new JsonObject { ["pointer"] = r.Pointer, ["target"] = r.Target, ["field"] = r.Field }).ToArray());

    // A server may echo what it was sent (a user name in an error). Long values are masked wherever they appear, short
    // ones only as a whole word, so ids and words that merely contain them survive.
    public static string Mask(string text, IReadOnlyList<string>? placed) {
        if (placed == null) return text;
        foreach (var value in placed)
            text = value.Length >= 8 ? text.Replace(value, Redacted, StringComparison.Ordinal)
                : Regex.Replace(text, @"(?<![\p{L}\p{N}])" + Regex.Escape(value) + @"(?![\p{L}\p{N}])", Redacted);
        return text;
    }
    public static JsonNode? Mask(JsonNode? node, IReadOnlyList<string>? placed) => placed is not { Count: > 0 } ? node : node switch {
        JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(p.Key, Mask(p.Value, placed)))),
        JsonArray a => new JsonArray(a.Select(x => Mask(x, placed)).ToArray()),
        JsonValue v when v.TryGetValue<string>(out var text) => JsonValue.Create(Mask(text, placed)),
        _ => node?.DeepClone()
    };
    // The answer's own words (message, bodyError, headers) after a send that carried vault values. body and text were
    // masked before they were inlined or stored; host, user and finalUrl name the session, not the request.
    private static readonly HashSet<string> AnswerFrame = new(StringComparer.Ordinal) { "ok", "source", "host", "user", "studioUser", "finalUrl", "receipt", "operationUuid", "bodyFile", "body", "text", "code", "gate", "reason", "contentType" };
    public static JsonObject MaskAnswer(JsonObject result, IReadOnlyList<string>? placed) {
        if (placed is not { Count: > 0 }) return result;
        foreach (var key in result.Select(p => p.Key).Where(k => !AnswerFrame.Contains(k)).ToArray()) result[key] = Mask(result[key], placed);
        return result;
    }

    // ---- one write, one send: the reservation is created exclusively before sending and never released.
    public static string Reserve(string writesDir, string operationUuid, JsonObject record) {
        Directory.CreateDirectory(writesDir);
        var path = Path.Combine(writesDir, operationUuid.ToLowerInvariant() + ".json");
        try {
            using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            stream.Write(Encoding.UTF8.GetBytes(record.ToJsonString(Pretty)));
        } catch (IOException) when (File.Exists(path)) {
            throw new Refusal("NOT_ALLOWED", "operationUuid " + operationUuid + " was already sent by this bridge (" + path + "); a write is never sent twice. Reconcile by a read.", "retry_refused");
        }
        return path;
    }
    public static void Settle(string? reservation, string state, JsonObject result) {
        if (reservation == null) return;
        try {
            var outcome = new JsonObject { ["state"] = state, ["at"] = DateTimeOffset.UtcNow.ToString("o"), ["code"] = result["code"]?.DeepClone(), ["status"] = result["status"]?.DeepClone(), ["elapsedMs"] = result["elapsedMs"]?.DeepClone() };
            File.WriteAllText(Path.ChangeExtension(reservation, ".outcome.json"), outcome.ToJsonString(Pretty));
        } catch { }
    }
    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    // ---- answers
    public static JsonObject Fail(string code, string message, string? gate = null) {
        var result = new JsonObject { ["ok"] = false, ["code"] = code, ["message"] = RedactText(message) };
        if (gate != null) result["gate"] = gate;
        return result;
    }
    private static JsonObject Uncertain(string message, int? status, string? reservation, string? reason = null) {
        var result = Fail("UNCERTAIN", message + " The write may have been applied: reconcile by a read, never resend it.");
        if (status != null) result["status"] = status;
        if (reason != null) result["reason"] = reason;
        if (reservation != null) result["receipt"] = reservation;
        return result;
    }

    // portal-call: one send through the Studio's authenticated client. The client is the Studio's own and is never
    // disposed (its handler is the session's token handler); only the request and the response are. Nothing here retries.
    // The Studio's handler itself repeats a request once after a 401 with a renewed token: the gateway processed nothing.
    // A write that names secretRefs takes its vault values from vault right before the send (the caller passes the
    // Studio's vault reader, the tests a fake one).
    public static async Task<JsonObject> Send(HttpClient client, ApiRequest r, string host, string? user, TenantPolicy tenants, Places places, TimeSpan? timeout = null, VaultReader? vault = null) {
        var started = DateTimeOffset.UtcNow;
        long Elapsed() => (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
        string? reservation = null; var write = false; var sent = false;
        IReadOnlyList<string> placed = Array.Empty<string>(); byte[]? bytes = null;
        try {
            var uri = BuildUri(host, r.BasePath, r.Path, r.Query);
            var knownRead = r.Method == "GET" || (r.Method == "POST" && IsReadPost(r.BasePath, r.Path));
            write = Classify(knownRead, r.Write, r.Method + " " + r.BasePath + r.Path);
            if (write) { CheckWriteFields(r.OperationUuid, r.AuthorizeSha256); CheckTenant(tenants, host, r.ConfirmTenant); }
            CheckSecretRefs(r.SecretRefs, write, host, r.BodyBase64 == null ? r.Body : null);
            if (r.Body != null) bytes = Encoding.UTF8.GetBytes(r.Body.ToJsonString());
            else if (r.BodyBase64 != null) {
                try { bytes = Convert.FromBase64String(r.BodyBase64); } catch (FormatException) { throw new Refusal("BAD_REQUEST", "bodyBase64 is not base64."); }
            }
            // The reservation describes the body as the facade wrote it (placeholders), never one that holds a vault value.
            var written = bytes;
            if (r.SecretRefs is { Count: > 0 } refs) {
                var body = r.Body!.DeepClone();
                placed = PlaceSecrets(body, refs, vault);
                bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
            }
            using var request = new HttpRequestMessage(new HttpMethod(r.Method), uri);
            request.Headers.Accept.ParseAdd("application/json");
            request.Headers.Accept.ParseAdd("*/*;q=0.5");
            if (bytes != null) {
                request.Content = new ByteArrayContent(bytes);
                try { request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(r.ContentType ?? "application/json"); }
                catch (FormatException) { throw new Refusal("BAD_REQUEST", "contentType is not a media type."); }
            }
            if (write) reservation = Reserve(places.WritesDir, r.OperationUuid!, new JsonObject {
                ["state"] = "sending", ["at"] = started.ToString("o"), ["operationUuid"] = r.OperationUuid, ["operationId"] = r.OperationId, ["apiId"] = r.ApiId,
                ["method"] = r.Method, ["host"] = host, ["basePath"] = r.BasePath, ["path"] = r.Path, ["query"] = r.Query, ["user"] = user,
                ["authorizeSha256"] = r.AuthorizeSha256!.ToLowerInvariant(), ["bodyBytes"] = written?.Length ?? 0, ["bodySha256"] = written == null ? null : Sha256(written),
                ["secretRefs"] = SecretRefsRecord(r.SecretRefs), ["source"] = "studio"
            });
            using var cts = new CancellationTokenSource(timeout ?? (write ? WriteTimeout : ReadTimeout));
            sent = true;
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            var (result, state) = await Shape(response, host, user, write, places, reservation, placed, cts.Token).ConfigureAwait(false);
            result["elapsedMs"] = Elapsed();
            if (write) { result["write"] = true; result["operationUuid"] = r.OperationUuid; }
            Settle(reservation, state, result);
            return MaskAnswer(result, placed);
        } catch (Refusal refusal) {
            var result = Fail(refusal.Code, refusal.Message, refusal.Gate); result["elapsedMs"] = Elapsed();
            Settle(reservation, "refused", result);
            return MaskAnswer(result, placed);
        } catch (Exception error) when (sent) {
            var reason = error is OperationCanceledException ? "No answer within the timeout." : "The send failed: " + error.GetBaseException().Message + ".";
            var result = write ? Uncertain(reason, null, reservation) : Fail("REMOTE_ERROR", reason);
            result["elapsedMs"] = Elapsed();
            Settle(reservation, write ? "uncertain" : "failed", result);
            return MaskAnswer(result, placed);
        } catch (Exception error) {
            var result = Fail("BAD_REQUEST", "The request could not be built: " + error.GetBaseException().Message); result["elapsedMs"] = Elapsed();
            Settle(reservation, "refused", result);
            return MaskAnswer(result, placed);
        } finally {
            // The sent copy is gone with the request; its bytes are wiped so the value does not linger in this buffer.
            if (placed.Count > 0 && bytes != null) Array.Clear(bytes);
        }
    }

    // The plugin client is created once per session object and stamped with its tenant id (X-OSTenant). A client stamped
    // for another tenant belongs to an earlier login: its token is not the current session's, so it is not used.
    public static bool TenantHeaderMatches(HttpClient client, string? tenantId) {
        var stamped = client.DefaultRequestHeaders.TryGetValues("X-OSTenant", out var values) ? values.FirstOrDefault() : null;
        return string.IsNullOrEmpty(tenantId) ? string.IsNullOrEmpty(stamped) : string.Equals(stamped, tenantId, StringComparison.OrdinalIgnoreCase);
    }

    // A token renewal that failed inside the Studio's handler answers with a 401 it made itself (no server headers) or
    // with TransientTokenRenewalFailureResponse; the server saw nothing in both cases.
    public static bool IsSessionFailure(HttpResponseMessage response) =>
        response.GetType() != typeof(HttpResponseMessage) || ((int)response.StatusCode == 401 && !response.Headers.Any());

    private static readonly string[] AnswerHeaders = { "location", "x-request-id" };
    private static async Task<(JsonObject Result, string State)> Shape(HttpResponseMessage response, string host, string? user, bool write, Places places, string? reservation, IReadOnlyList<string> placed, CancellationToken token) {
        var final = response.RequestMessage?.RequestUri;
        if (!SameHost(final, host)) {
            var where = final?.IsAbsoluteUri == true ? final.IdnHost : "(unknown)";
            return write ? (Uncertain("The answer came from " + where + " after a redirect, not from " + host + "; it was discarded.", (int)response.StatusCode, reservation, "HOST_MISMATCH"), "uncertain")
                : (Fail("HOST_MISMATCH", "The answer came from " + where + " after a redirect, not from " + host + "; it was discarded."), "failed");
        }
        if (IsSessionFailure(response))
            return (Fail("STUDIO_NOT_SIGNED_IN", "The Studio could not renew its session on " + host + " (" + (response.ReasonPhrase ?? "token renewal failed") + "); sign in again in the Studio. The server processed nothing."), "rejected");
        var status = (int)response.StatusCode;
        var contentType = response.Content.Headers.ContentType?.ToString();
        var headers = new JsonObject();
        if (contentType != null) headers["content-type"] = contentType;
        foreach (var name in AnswerHeaders)
            if (response.Headers.TryGetValues(name, out var values)) headers[name] = RedactText(string.Join(", ", values));
        var answer = new JsonObject { ["status"] = status, ["contentType"] = contentType, ["headers"] = headers };
        // The status is known once the headers arrived; a body that fails to read never makes the outcome uncertain.
        try { await Body(response.Content, contentType, answer, places.DownloadsDir, placed, token).ConfigureAwait(false); }
        catch (Exception error) { answer["bodyError"] = RedactText(error.GetBaseException().Message); }
        if (status >= 400) {
            if (write && status >= 500) {
                var uncertain = Uncertain("The server answered " + status + " to the write.", status, reservation);
                foreach (var key in new[] { "contentType", "body", "text", "bodyFile" }) if (answer[key] != null) uncertain[key] = answer[key]!.DeepClone();
                return (uncertain, "uncertain");
            }
            var failed = Fail("REMOTE_ERROR", "The server answered " + status + ".");
            foreach (var (key, value) in answer) failed[key] = value?.DeepClone();
            return (failed, write ? "rejected" : "failed");
        }
        var ok = new JsonObject { ["ok"] = true, ["source"] = "studio", ["host"] = host, ["user"] = user };
        foreach (var (key, value) in answer) ok[key] = value?.DeepClone();
        return (ok, write ? "accepted" : "read");
    }

    // JSON answers come back parsed and redacted in body, other text redacted in text, anything else in bodyBase64. Over
    // InlineLimit the redacted answer goes to a file under journal\portal\downloads; over ReadLimit it is not read at all.
    // Vault values the request carried (placed) are masked before the answer is inlined or stored.
    private static async Task Body(HttpContent content, string? contentType, JsonObject answer, string downloadsDir, IReadOnlyList<string> placed, CancellationToken token) {
        if (content.Headers.ContentLength > ReadLimit) { answer["bodyOmitted"] = "larger than " + ReadLimit + " bytes"; return; }
        await using var stream = await content.ReadAsStreamAsync(token).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920]; int read;
        while ((read = await stream.ReadAsync(chunk, token).ConfigureAwait(false)) > 0) {
            buffer.Write(chunk, 0, read);
            if (buffer.Length > ReadLimit) { answer["bodyOmitted"] = "larger than " + ReadLimit + " bytes"; return; }
        }
        Payload(buffer.ToArray(), contentType, answer, downloadsDir, placed);
    }
    public static void Payload(byte[] bytes, string? contentType, JsonObject answer, string downloadsDir, IReadOnlyList<string>? placed = null) {
        if (bytes.Length == 0) return;
        var type = (contentType ?? "").ToLowerInvariant();
        var textual = type.Contains("json") || type.StartsWith("text/") || type.Contains("xml") || type.Contains("javascript");
        if (type.Contains("json") || (type == "" && bytes[0] is (byte)'{' or (byte)'[')) {
            try {
                var redacted = Mask(Redact(JsonNode.Parse(bytes)), placed);
                Inline(answer, "body", redacted, redacted?.ToJsonString() ?? "null", ".json", downloadsDir);
                return;
            } catch (JsonException) { textual = true; }
        }
        if (textual) {
            var text = Mask(RedactText(Encoding.UTF8.GetString(bytes)), placed);
            Inline(answer, "text", JsonValue.Create(text), text, ".txt", downloadsDir);
            return;
        }
        if (bytes.Length <= InlineLimit) { answer["bodyBase64"] = Convert.ToBase64String(bytes); return; }
        answer["bodyFile"] = Store(downloadsDir, bytes, ".bin"); answer["bytes"] = bytes.Length; answer["sha256"] = Sha256(bytes);
    }
    private static void Inline(JsonObject answer, string field, JsonNode? value, string serialized, string extension, string downloadsDir) {
        if (Encoding.UTF8.GetByteCount(serialized) <= InlineLimit) { answer[field] = value; return; }
        var bytes = Encoding.UTF8.GetBytes(serialized);
        answer["bodyFile"] = Store(downloadsDir, bytes, extension); answer["bytes"] = bytes.Length; answer["sha256"] = Sha256(bytes);
    }
    private static string Store(string dir, byte[] bytes, string extension) {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmssfff") + "-" + Sha256(bytes)[..12] + extension);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    // ---- redaction, the same rules as portal\runtime\errors.mjs redact(), plus camelCase *Token keys (authToken of the
    // private gateway answer). isSecret objects lose value, defaultValue and deployedValue.
    private static readonly Regex SensitiveKey = new(@"(?:authorization|cookie|password|passwd|secret|(?:^|_)token(?:$|_)|token$|accessToken|refreshToken|idToken|private.?key|credential|api.?key|subscription.?key|connection.?string|csrf)", RegexOptions.IgnoreCase);
    private static readonly Regex SecretValueKey = new("^(?:value|defaultValue|deployedValue)$", RegexOptions.IgnoreCase);
    // versionToken of /<module>/moduleservices/moduleversioninfo is the module version hash the Portal page itself sends
    // back in every screenservice call (portal-metadata.mjs); masking it would break every Portal route.
    private static readonly HashSet<string> PublicKeys = new(StringComparer.Ordinal) { "versionToken" };
    private static readonly Regex BearerText = new(@"Bearer\s+[A-Za-z0-9._~+/=-]+", RegexOptions.IgnoreCase);
    private static readonly Regex LinkText = new(@"https?://[^\s<>""']+", RegexOptions.IgnoreCase);
    private static readonly Regex SignedParameter = new(@"(?:signature|^sig$|token|secret|api.?key|credential|^x-amz-|^x-goog-)", RegexOptions.IgnoreCase);
    public const string Redacted = "[REDACTED]";
    public static JsonNode? Redact(JsonNode? node) {
        switch (node) {
            case JsonObject o: {
                var secret = o["isSecret"] is JsonValue s && s.TryGetValue<bool>(out var b) && b;
                var copy = new JsonObject();
                foreach (var (key, value) in o)
                    copy[key] = (key != "isSecret" && !PublicKeys.Contains(key) && SensitiveKey.IsMatch(key)) || (secret && SecretValueKey.IsMatch(key)) ? Redacted : Redact(value);
                return copy;
            }
            case JsonArray a: return new JsonArray(a.Select(Redact).ToArray());
            case JsonValue v when v.TryGetValue<string>(out var text): return JsonValue.Create(RedactText(text));
            default: return node?.DeepClone();
        }
    }
    public static string RedactText(string text) {
        var result = BearerText.Replace(text, "Bearer " + Redacted);
        return LinkText.Replace(result, match => {
            if (!Uri.TryCreate(match.Value, UriKind.Absolute, out var uri)) return "[INVALID URL]";
            var changed = uri.UserInfo != "";
            var query = uri.Query.TrimStart('?');
            var parts = query == "" ? Array.Empty<string>() : query.Split('&');
            for (var i = 0; i < parts.Length; i++) {
                var name = Uri.UnescapeDataString(parts[i].Split('=')[0]);
                if (SignedParameter.IsMatch(name)) { parts[i] = parts[i].Split('=')[0] + "=" + Redacted; changed = true; }
            }
            if (!changed) return match.Value;
            var builder = new UriBuilder(uri) { UserName = "", Password = "", Query = string.Join('&', parts) };
            return builder.Uri.GetComponents(UriComponents.SerializationInfoString, UriFormat.UriEscaped).Replace("%5BREDACTED%5D", Redacted);
        });
    }

    // ---- internal Portal routes, reached through the page of the Portal window. Accepted paths:
    //   POST /<module>/screenservices/<module>/<flow>/<screen>/<action>
    //   GET  /<module>/ | /<module>/moduleservices/moduleversioninfo|moduleinfo | /<module>/scripts/<file>.js  (optional ?query)
    private static readonly Regex WebPath = new(@"^/([A-Za-z0-9_-]+)/(.*)$");
    private static readonly Regex WebRoute = new(@"^[A-Za-z0-9_]+(/[A-Za-z0-9_]+){2,4}$");
    private static readonly Regex WebAsset = new(@"^(|moduleservices/moduleversioninfo|moduleservices/moduleinfo|scripts/[A-Za-z0-9_.\-]+\.js)(\?[A-Za-z0-9_=&.%\-]*)?$");
    public static bool CheckWebRoute(WebRequest r) {
        var match = WebPath.Match(r.Path);
        if (!match.Success || r.Path.Contains("..") || r.Path.Contains("//") || r.Path.Contains('#') || EncodedSeparator.IsMatch(r.Path))
            throw new Refusal("BAD_REQUEST", "path must be /<module>/screenservices/<route> or a module asset: " + r.Path);
        var module = match.Groups[1].Value; var rest = match.Groups[2].Value;
        if (DeniedWebModules.Contains(module, StringComparer.OrdinalIgnoreCase)) throw new Refusal("NOT_ALLOWED", "Routes of /" + module + "/ are never called by the bridge.");
        if (rest.StartsWith("screenservices/", StringComparison.Ordinal)) {
            var route = rest["screenservices/".Length..];
            if (r.Method != "POST") throw new Refusal("BAD_REQUEST", "A screenservice takes POST.");
            if (!WebRoute.IsMatch(route) || !route.StartsWith(module + "/", StringComparison.Ordinal)) throw new Refusal("BAD_REQUEST", "screenservice route must be <module>/<flow>/<screen>/<action> of the same module: " + route);
            if (route.Split('/')[^1].Contains("decrypt", StringComparison.OrdinalIgnoreCase)) throw new Refusal("NOT_ALLOWED", "Routes that decrypt secrets are never called: " + route);
            var write = Classify(KnownWebReads.Contains(route), r.Write, "Portal route " + route);
            if (write) CheckWriteFields(r.OperationUuid, r.AuthorizeSha256);
            return write;
        }
        if (!WebAsset.IsMatch(rest)) throw new Refusal("NOT_ALLOWED", "Only screenservices and the module's own metadata and scripts are reachable: " + r.Path);
        if (r.Method != "GET") throw new Refusal("BAD_REQUEST", "Module metadata and scripts take GET.");
        if (r.Write) CheckWriteFields(r.OperationUuid, r.AuthorizeSha256);
        return r.Write;
    }

    // Where the page keeps its CSRF token (2026-10-08: a customer Portal had none of the classic cookies): the classic crf /
    // nr2<module> cookies, the same names behind the __Host-/__Secure- prefixes, any cookie named *csrf*/*crf*, then a web
    // storage entry named that way. Returns the token (stays in the page), where it came from, and the cookie NAMES only.
    private const string CsrfFinder =
        "function ssamCsrf() {\n" +
        "  var names = [], token = '', source = null, list = document.cookie ? document.cookie.split(';') : [];\n" +
        "  list.forEach(function (raw) { var c = raw.trim(), i = c.indexOf('='); if (i < 1) return; var name = c.slice(0, i), value = c.slice(i + 1), bare = name.replace(/^__(Host|Secure)-/i, ''); names.push(name);\n" +
        "    if (token) return; var decoded = value; try { decoded = decodeURIComponent(value); } catch (e) { }\n" +
        "    if (/^crf$/i.test(bare)) { token = decoded; source = 'cookie:' + name; return; }\n" +
        "    var m = /(?:^|;|&)crf=([^;&]*)/i.exec(decoded); if (/^nr2/i.test(bare) && m) { token = m[1]; source = 'cookie:' + name; return; }\n" +
        "    if (/csrf|xsrf|^crf/i.test(bare) && decoded) { token = m ? m[1] : decoded; source = 'cookie:' + name; } });\n" +
        "  [window.sessionStorage, window.localStorage].forEach(function (st, k) { if (token || !st) return; try { for (var j = 0; j < st.length; j++) { var key = st.key(j); if (/csrf|xsrf|crf/i.test(key)) { var v = st.getItem(key) || ''; var mm = /crf=([^;&\"]+)/i.exec(v); token = mm ? mm[1] : v; source = (k ? 'localStorage:' : 'sessionStorage:') + key; if (token) break; } } } catch (e) { } });\n" +
        "  return { token: token, source: source, names: names };\n" +
        "}\n";

    // Starts the call inside the page, with the page's own cookies and CSRF token, and keeps the answer in the page
    // under a random id until PollScript collects it. Nothing is sent when the page is not on the tenant's origin or,
    // for a POST, when it holds no CSRF token (not signed in). The token value never leaves the page. A body with vault
    // values (secretRefs) exists only in this script and the request it starts; the page keeps the answer, not the body.
    public static string StartScript(string id, string origin, WebRequest r) {
        string Js(string? value) => JsonSerializer.Serialize(value);
        return "var origin = " + Js(origin) + ", id = " + Js(id) + ", method = " + Js(r.Method) + ", path = " + Js(r.Path) + ", body = " + Js(r.Body?.ToJsonString()) + ", limit = " + ReadLimit + ";\n" +
            "if (location.origin !== origin) return JSON.stringify({ started: false, reason: 'origin', origin: location.origin });\n" +
            CsrfFinder + "var token = ssamCsrf().token;\n" +
            "if (method === 'POST' && !token) return JSON.stringify({ started: false, reason: 'csrf', origin: location.origin });\n" +
            "var headers = { 'Accept': 'application/json' };\n" +
            "if (method === 'POST') { headers['Content-Type'] = 'application/json; charset=UTF-8'; headers['outsystems-client-env'] = 'browser'; headers['x-csrftoken'] = token; }\n" +
            "var store = window.__ssamPortal || (window.__ssamPortal = {}); store[id] = { state: 'pending' };\n" +
            "fetch(origin + path, { method: method, headers: headers, body: method === 'POST' ? (body === null ? '{}' : body) : undefined, credentials: 'same-origin', redirect: 'manual', cache: 'no-store' })\n" +
            "  .then(function (r) { return r.text().then(function (t) { store[id] = { state: 'done', status: r.status, type: r.type, url: r.url, contentType: r.headers.get('content-type') || '', length: t.length, text: t.length > limit ? null : t }; }); })\n" +
            "  .catch(function (e) { store[id] = { state: 'error', message: String(e && e.message || e) }; });\n" +
            "return JSON.stringify({ started: true });";
    }
    public static string PollScript(string id) =>
        "var s = window.__ssamPortal, r = s && s[" + JsonSerializer.Serialize(id) + "];\n" +
        "if (!r) return JSON.stringify({ state: 'missing', origin: location.origin });\n" +
        "if (r.state === 'pending') return JSON.stringify({ state: 'pending' });\n" +
        "delete s[" + JsonSerializer.Serialize(id) + "]; return JSON.stringify(r);";
    // Where the page is and whether it holds a CSRF token: the sign-in signal of a status. Never a cookie value.
    public const string ProbeScript =
        CsrfFinder + "var f = ssamCsrf();\n" +
        "return JSON.stringify({ origin: location.origin, path: location.pathname, ready: document.readyState, csrf: !!f.token, csrfSource: f.source, cookieNames: f.names });";
    public static bool PageSignedIn(JsonObject? probe, string host) =>
        probe != null && (string?)probe["origin"] == "https://" + host && probe["csrf"] is JsonValue v && v.TryGetValue<bool>(out var b) && b
        && !(((string?)probe["path"]) ?? "").StartsWith("/authentication", StringComparison.OrdinalIgnoreCase);

    // Turns what the page collected into the contract answer. A write whose answer is unknown is uncertain. Vault values
    // the request carried (placed) are masked in the body before it is inlined or stored; MaskAnswer does the rest.
    public static (JsonObject Result, string State) ShapeWeb(JsonObject? page, string host, bool write, string? reservation, string downloadsDir, IReadOnlyList<string>? placed = null) {
        var state = (string?)page?["state"];
        if (state == null || state == "missing" || state == "error") {
            var why = state == "error" ? "The page's fetch failed: " + (string?)page!["message"] + "." : "The page lost the answer (it navigated or reloaded).";
            return write ? (Uncertain(why, null, reservation), "uncertain") : (Fail("REMOTE_ERROR", why), "failed");
        }
        var status = page!["status"] is JsonValue sv && sv.TryGetValue<int>(out var s) ? s : 0;
        var url = (string?)page["url"];
        if ((string?)page["type"] == "opaqueredirect" || status == 0)
            return write ? (Uncertain("The Portal answered the write with a redirect.", null, reservation, "REDIRECT"), "uncertain")
                : (Fail("WEB_SIGN_IN_REQUIRED", "The Portal redirected the call: sign in again in the Portal window (portal-session open)."), "failed");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var final) || !SameHost(final, host))
            return write ? (Uncertain("The answer did not come from " + host + ".", status, reservation, "HOST_MISMATCH"), "uncertain")
                : (Fail("HOST_MISMATCH", "The answer did not come from " + host + "; it was discarded."), "failed");
        if (status == 401) return (Fail("WEB_SIGN_IN_REQUIRED", "The Portal session in the window is not signed in (401): sign in there (portal-session open)."), write ? "rejected" : "failed");
        var contentType = (string?)page["contentType"];
        var answer = new JsonObject { ["status"] = status, ["contentType"] = contentType, ["finalUrl"] = final.GetLeftPart(UriPartial.Path) };
        var text = (string?)page["text"];
        if (text == null) answer["bodyOmitted"] = "larger than " + ReadLimit + " characters";
        else {
            var looksJson = (contentType ?? "").Contains("json", StringComparison.OrdinalIgnoreCase) || final.AbsolutePath.Contains("/screenservices/");
            Payload(Encoding.UTF8.GetBytes(text), looksJson ? "application/json" : string.IsNullOrEmpty(contentType) ? "text/plain" : contentType, answer, downloadsDir, placed);
        }
        if (status >= 400) {
            if (write && status >= 500) {
                var uncertain = Uncertain("The Portal answered " + status + " to the write.", status, reservation);
                foreach (var key in new[] { "body", "text" }) if (answer[key] != null) uncertain[key] = answer[key]!.DeepClone();
                return (uncertain, "uncertain");
            }
            var failed = Fail("REMOTE_ERROR", "The Portal answered " + status + ".");
            foreach (var (key, value) in answer) failed[key] = value?.DeepClone();
            return (failed, write ? "rejected" : "failed");
        }
        var ok = new JsonObject { ["ok"] = true, ["source"] = "studio-web", ["host"] = host, ["user"] = null };
        foreach (var (key, value) in answer) ok[key] = value?.DeepClone();
        return (ok, write ? "accepted" : "read");
    }
}
