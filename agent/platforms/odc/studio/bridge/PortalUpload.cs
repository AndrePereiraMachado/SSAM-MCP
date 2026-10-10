using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Refusal = PortalCore.Refusal;

// portal-upload (bridge v39+, capability portal-upload): an External Library package to the tenant's generation API
// with the Studio session, in one write. The part that never touches a Studio type, compiled alone by
// studio\bridge\tests. Steps, each refused before the next when its rule fails:
//   1. the request file names a package under journal\portal\uploads whose sha256 it states (the facade staged it);
//   2. GET /api/external-libraries/v1/uploads with the session's client: the presigned uploadUrl and downloadUrl;
//   3. the write reservation journal\portal\writes\<operationUuid>.json (one UUID is one send, forever);
//   4. PUT of the package to uploadUrl with a NEW HttpClient that carries no authentication (the session's handler puts
//      the user's Bearer on any URI, so it never sees this request): https only, default port, no user info, no
//      redirect followed, application/zip, 600 s;
//   5. POST /generation-operations {fileName, highCodeBinaryUri: downloadUrl} with the session's client.
// The answer is {operationKey, bytes, sha256, fileName}: neither URL ever leaves this process, nor reaches a file, an
// answer or the journal. An answer lost after the POST was sent is UNCERTAIN and never resent.
internal static class PortalUpload {
    public const string BasePath = "/api/external-libraries/v1";
    public const string GenerationOperationId = "external-library-generation-api-v1:post:/generation-operations";
    /// <summary>The upload limit of an External Library zip in ODC; the kernel gate is the same (ExternalLibraryPackage.MaxBytes).</summary>
    public const long MaxPackageBytes = 90L * 1024 * 1024;
    public static readonly TimeSpan PutTimeout = TimeSpan.FromSeconds(600);
    private static readonly Regex FileNameRule = new(@"^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,150}\.zip$", RegexOptions.CultureInvariant);
    private static readonly Regex Sha256Rule = new("^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant);

    public sealed record Request(string File, string Sha256, string FileName, string OperationUuid, string AuthorizeSha256, string? ConfirmTenant);

    public static Request Parse(string json) {
        JsonObject o;
        try { o = JsonNode.Parse(json) as JsonObject ?? throw new Refusal("BAD_REQUEST", "The request file must hold one JSON object."); }
        catch (JsonException e) { throw new Refusal("BAD_REQUEST", "The request file is not JSON: " + e.Message); }
        string? Text(string name) => o[name] switch {
            null => null,
            JsonValue v when v.TryGetValue<string>(out var s) => s,
            _ => throw new Refusal("BAD_REQUEST", name + " must be a string.")
        };
        foreach (var (key, _) in o)
            if (key is not ("file" or "sha256" or "fileName" or "operationUuid" or "authorizeSha256" or "confirmTenant"))
                throw new Refusal("BAD_REQUEST", "portal-upload takes file, sha256, fileName, operationUuid, authorizeSha256 and confirmTenant; not " + key + ".");
        var file = Text("file"); var sha256 = Text("sha256"); var fileName = Text("fileName");
        if (string.IsNullOrWhiteSpace(file)) throw new Refusal("BAD_REQUEST", "file names the package under journal\\portal\\uploads.");
        if (sha256 == null || !Sha256Rule.IsMatch(sha256)) throw new Refusal("BAD_REQUEST", "sha256 is the 64-hex digest of the package.");
        if (fileName == null || !FileNameRule.IsMatch(fileName)) throw new Refusal("BAD_REQUEST", "fileName is the remote name of the package (<Name>-<sha16>.zip, letters, digits, _ . -).");
        var uuid = Text("operationUuid"); var authorize = Text("authorizeSha256");
        PortalCore.CheckWriteFields(uuid, authorize);
        return new Request(file, sha256.ToLowerInvariant(), fileName, uuid!, authorize!.ToLowerInvariant(), Text("confirmTenant"));
    }

    /// <summary>The staged package: a file under uploadsDir, within the size limit, whose sha256 is the one requested.</summary>
    public static (string Path, byte[] Bytes) ReadPackage(string uploadsDir, Request r) {
        var root = Path.GetFullPath(uploadsDir).TrimEnd(Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.IsPathRooted(r.File) ? r.File : Path.Combine(root, r.File));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new Refusal("BAD_REQUEST", "The package is read only from journal\\portal\\uploads: " + Path.GetFileName(full));
        var info = new FileInfo(full);
        if (!info.Exists) throw new Refusal("BAD_REQUEST", "The package is not in journal\\portal\\uploads: " + info.Name);
        if (info.Length > MaxPackageBytes) throw new Refusal("PACKAGE_TOO_LARGE", "The package has " + info.Length + " bytes; the upload limit is " + MaxPackageBytes + ".");
        var bytes = File.ReadAllBytes(full);
        if (Sha256(bytes) != r.Sha256) throw new Refusal("BAD_REQUEST", "The package changed after it was staged: its sha256 is not the one requested.", "package_sha256");
        return (full, bytes);
    }

    /// <summary>A presigned target: absolute https, default port, no user info, no fragment. The URL itself is never echoed.</summary>
    public static Uri CheckTarget(string? url, string field) {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw new Refusal("PORTAL_CONTRACT_CHANGED", "The upload schema has no absolute " + field + ".");
        if (uri.Scheme != Uri.UriSchemeHttps) throw new Refusal("NOT_ALLOWED", "The " + field + " of the upload schema is not https; nothing was sent.", "upload_target");
        if (!uri.IsDefaultPort) throw new Refusal("NOT_ALLOWED", "The " + field + " of the upload schema names a port; nothing was sent.", "upload_target");
        if (uri.UserInfo != "") throw new Refusal("NOT_ALLOWED", "The " + field + " of the upload schema carries user info; nothing was sent.", "upload_target");
        if (uri.Fragment != "") throw new Refusal("NOT_ALLOWED", "The " + field + " of the upload schema carries a fragment; nothing was sent.", "upload_target");
        return uri;
    }

    /// <summary>The client of the PUT: new, with no credentials, no cookies and no redirect; never the session's.</summary>
    public static HttpClient NewUploadClient() =>
        new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, Credentials = null, PreAuthenticate = false, UseProxy = true }, disposeHandler: true) { Timeout = PutTimeout };

    public static async Task<JsonObject> Run(HttpClient session, Request r, string host, string? user, PortalCore.TenantPolicy tenants, PortalCore.Places places,
        string uploadsDir, Func<HttpClient> uploadClient, TimeSpan? timeout = null) {
        var started = DateTimeOffset.UtcNow;
        long Elapsed() => (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds;
        string? reservation = null; var posted = false;
        JsonObject Done(JsonObject result, string state) { result["elapsedMs"] = Elapsed(); result["operationUuid"] = r.OperationUuid; result["write"] = true; PortalCore.Settle(reservation, state, result); return result; }
        try {
            PortalCore.CheckHost(host);
            PortalCore.CheckTenant(tenants, host, r.ConfirmTenant);
            var (_, bytes) = ReadPackage(uploadsDir, r);
            if (File.Exists(Path.Combine(places.WritesDir, r.OperationUuid.ToLowerInvariant() + ".json")))
                throw new Refusal("NOT_ALLOWED", "operationUuid " + r.OperationUuid + " was already sent by this bridge; a write is never sent twice. Reconcile by a read.", "retry_refused");
            using var cts = new CancellationTokenSource(timeout ?? PortalCore.WriteTimeout);

            // 1. The upload schema, a read with the session.
            var schemaUri = PortalCore.BuildUri(host, BasePath, "/uploads", null);
            using var schemaRequest = new HttpRequestMessage(HttpMethod.Get, schemaUri);
            schemaRequest.Headers.Accept.ParseAdd("application/json");
            string? uploadUrl, downloadUrl;
            using (var schema = await session.SendAsync(schemaRequest, cts.Token).ConfigureAwait(false)) {
                if (!PortalCore.SameHost(schema.RequestMessage?.RequestUri, host)) throw new Refusal("HOST_MISMATCH", "The upload schema came from another host after a redirect; nothing was sent.");
                if (PortalCore.IsSessionFailure(schema)) throw new Refusal("STUDIO_NOT_SIGNED_IN", "The Studio could not renew its session on " + host + "; sign in again in the Studio. Nothing was sent.");
                if ((int)schema.StatusCode != 200) throw new Refusal("REMOTE_ERROR", "GET /uploads answered " + (int)schema.StatusCode + "; nothing was sent.");
                JsonObject? body;
                try { body = JsonNode.Parse(await schema.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false)) as JsonObject; }
                catch (JsonException) { body = null; }
                uploadUrl = body?["uploadUrl"] is JsonValue u && u.TryGetValue<string>(out var us) ? us : null;
                downloadUrl = body?["downloadUrl"] is JsonValue d && d.TryGetValue<string>(out var ds) ? ds : null;
            }
            var put = CheckTarget(uploadUrl, "uploadUrl");
            var download = CheckTarget(downloadUrl, "downloadUrl");

            // 2. One write, one send: reserved before anything is written anywhere. No URL in the record.
            reservation = PortalCore.Reserve(places.WritesDir, r.OperationUuid, new JsonObject {
                ["state"] = "sending", ["at"] = started.ToString("o"), ["operationUuid"] = r.OperationUuid, ["operationId"] = GenerationOperationId,
                ["method"] = "PUT+POST", ["host"] = host, ["basePath"] = BasePath, ["path"] = "/generation-operations", ["user"] = user,
                ["authorizeSha256"] = r.AuthorizeSha256, ["fileName"] = r.FileName, ["bytes"] = bytes.Length, ["sha256"] = r.Sha256, ["source"] = "studio"
            });

            // 3. The package to the presigned target, outside the session.
            using (var client = uploadClient())
            using (var putRequest = new HttpRequestMessage(HttpMethod.Put, put) { Content = new ByteArrayContent(bytes) }) {
                putRequest.Content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
                HttpResponseMessage response;
                try { response = await client.SendAsync(putRequest, cts.Token).ConfigureAwait(false); }
                catch (Exception error) {
                    // The tenant was not written: the generation POST was not sent. A new upload needs a new operationUuid.
                    return Done(PortalCore.Fail("UPLOAD_FAILED", "The upload of the package did not complete (" + error.GetType().Name + "); the generation was not requested."), "refused");
                }
                using (response) {
                    var status = (int)response.StatusCode;
                    if (status is >= 300 and < 400)
                        return Done(PortalCore.Fail("UPLOAD_REJECTED", "The upload target answered a redirect (" + status + "), which is never followed; the generation was not requested.", "upload_redirect"), "refused");
                    if (status is < 200 or >= 300) {
                        var failed = PortalCore.Fail("UPLOAD_REJECTED", "The upload target answered " + status + "; the generation was not requested.");
                        failed["status"] = status;
                        return Done(failed, "refused");
                    }
                }
            }

            // 4. The generation operation, the one write to the tenant.
            var postUri = PortalCore.BuildUri(host, BasePath, "/generation-operations", null);
            var payload = new JsonObject { ["fileName"] = r.FileName, ["highCodeBinaryUri"] = download.AbsoluteUri }.ToJsonString();
            using var postRequest = new HttpRequestMessage(HttpMethod.Post, postUri) { Content = new StringContent(payload, Encoding.UTF8, "application/json") };
            postRequest.Headers.Accept.ParseAdd("application/json");
            posted = true;
            using var answer = await session.SendAsync(postRequest, cts.Token).ConfigureAwait(false);
            if (!PortalCore.SameHost(answer.RequestMessage?.RequestUri, host))
                return Done(Uncertain("The generation answer came from another host after a redirect; it was discarded.", null), "uncertain");
            if (PortalCore.IsSessionFailure(answer))
                return Done(PortalCore.Fail("STUDIO_NOT_SIGNED_IN", "The Studio could not renew its session on " + host + "; the server processed nothing."), "rejected");
            var code = (int)answer.StatusCode;
            string? operationKey = null;
            try { operationKey = (JsonNode.Parse(await answer.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false)) as JsonObject)?["operationKey"]?.GetValue<string>(); }
            catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException) { operationKey = null; }
            if (code >= 500) return Done(Uncertain("The server answered " + code + " to the generation request.", code), "uncertain");
            if (code >= 400) { var rejected = PortalCore.Fail("REMOTE_ERROR", "The server answered " + code + " to the generation request; nothing was generated."); rejected["status"] = code; return Done(rejected, "rejected"); }
            if (string.IsNullOrWhiteSpace(operationKey)) return Done(Uncertain("The server accepted the generation request without an operationKey.", code), "uncertain");
            return Done(new JsonObject { ["ok"] = true, ["source"] = "studio", ["host"] = host, ["user"] = user, ["status"] = code,
                ["operationKey"] = operationKey, ["bytes"] = bytes.Length, ["sha256"] = r.Sha256, ["fileName"] = r.FileName }, "accepted");
        } catch (Refusal refusal) {
            return Done(PortalCore.Fail(refusal.Code, refusal.Message, refusal.Gate), "refused");
        } catch (Exception error) when (posted) {
            return Done(Uncertain(error is OperationCanceledException ? "No answer to the generation request within the timeout." : "The generation request failed after it was sent (" + error.GetType().Name + ").", null), "uncertain");
        } catch (Exception error) {
            return Done(PortalCore.Fail("BAD_REQUEST", "The upload could not be prepared (" + error.GetType().Name + "); nothing was sent."), reservation == null ? "refused" : "refused");
        }
    }

    private static JsonObject Uncertain(string message, int? status) {
        var result = PortalCore.Fail("UNCERTAIN", message + " The generation may exist: reconcile by reading the generation operations (by file name), never resend.");
        if (status != null) result["status"] = status;
        return result;
    }
    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
