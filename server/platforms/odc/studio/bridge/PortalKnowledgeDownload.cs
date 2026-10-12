using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Globalization;
using Ssam.PrivateTransport;

// Only this native read may consume FileDownload.Url. Neither the response,
// signed URL nor storage errors cross the process boundary or enter logs.
internal static class PortalKnowledgeDownload {
    internal const string Pathname = "/knowledgebases/screenservices/knowledgebases/DataSources/datasource/ActionDataSourceFile_Download";
    internal const int MaxBytes = 20 * 1024 * 1024;
    internal sealed record Request(JsonObject Body, string Id, string Filename, string Mime, int Length, string Sha256, long Deadline);
    private static PortalCore.Refusal Refuse() => new("KNOWLEDGE_DOWNLOAD_UNVERIFIED", "Private knowledge-file download could not verify its exact scope and content. No URL or remote response is exposed.");
    private static bool Keys(JsonObject o, params string[] names) => o.Count == names.Length && names.All(o.ContainsKey);
    internal static Request Parse(JsonObject json, string host, DateTimeOffset now) {
        PortalCore.CheckHost(host);
        try {
            if (!Keys(json, "operationId", "method", "path", "body", "expectedContent", "downloadId", "confirmTenant", "deadlineAt")
                || (string?)json["operationId"] != "knowledgeBases.downloadFile" || (string?)json["method"] != "POST"
                || (string?)json["path"] != Pathname || (string?)json["confirmTenant"] != host
                || !Guid.TryParseExact((string?)json["downloadId"], "D", out _)) throw Refuse();
            var deadline = json["deadlineAt"]!.GetValue<long>();
            if (deadline <= now.ToUnixTimeMilliseconds() || deadline > now.AddSeconds(30).ToUnixTimeMilliseconds()) throw Refuse();
            var body = json["body"] as JsonObject; var expected = json["expectedContent"] as JsonObject;
            if (body == null || !Keys(body, "versionInfo", "viewName", "inputParameters", "screenData", "clientVariables")
                || (string?)body["viewName"] != "DataSources.datasource" || body["versionInfo"] is not JsonObject version
                || !Keys(version, "moduleVersion", "apiVersion") || new[] { "moduleVersion", "apiVersion" }.Any(k => version[k] is not JsonValue v || !v.TryGetValue<string>(out var s) || string.IsNullOrWhiteSpace(s) || s.Length > 512)
                || body["screenData"] is not JsonObject screen || !Keys(screen, "variables") || screen["variables"] is not JsonObject vars || vars.Count != 0
                || body["clientVariables"] is not JsonObject clients || clients.Count != 0
                || body["inputParameters"] is not JsonObject p || !Keys(p, "KnowledgeBaseId", "DataSourceId", "FileId", "EnvironmentId", "OverrideBaseURL")
                || new[] { "KnowledgeBaseId", "DataSourceId", "FileId", "EnvironmentId" }.Any(k => !Guid.TryParseExact((string?)p[k], "D", out _))
                || string.Equals((string?)p["FileId"], (string?)p["DataSourceId"], StringComparison.OrdinalIgnoreCase) || (string?)p["OverrideBaseURL"] != ""
                || expected == null || !Keys(expected, "filename", "mimeType", "byteLength", "sha256")) throw Refuse();
            var filename = (string?)expected["filename"]; var mime = (string?)expected["mimeType"]; var sha = (string?)expected["sha256"];
            var length = expected["byteLength"]!.GetValue<int>();
            if (string.IsNullOrWhiteSpace(filename) || filename.Length > 512 || filename.Any(char.IsControl)
                || string.IsNullOrWhiteSpace(mime) || mime.Length > 128 || mime.Any(char.IsControl)
                || length < 1 || length > MaxBytes || sha == null || !Regex.IsMatch(sha, "^[a-f0-9]{64}$")) throw Refuse();
            return new Request((JsonObject)body.DeepClone(), (string)json["downloadId"]!, filename, mime, length, sha, deadline);
        } catch { throw Refuse(); }
    }
    internal static Uri StorageUri(string value, DateTimeOffset now) {
        if (value.Length > 8192 || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort
            || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath.Length < 2) throw StorageRefuse("uri-shape");
        // Knowledge Base source-list downloads use global S3 bucket endpoints,
        // unlike mobile temporary uploads. Both remain isolated from Portal cookies.
        if (!Regex.IsMatch(uri.Host, @"^(?:plat-[a-z0-9]{1,58}\.s3\.[a-z0-9-]+|[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3)\.amazonaws\.com$", RegexOptions.CultureInvariant)) {
            var family = Regex.IsMatch(uri.Host, @"^[a-z0-9-]+\.s3\.amazonaws\.com$") ? "s3-global"
                : Regex.IsMatch(uri.Host, @"^[a-z0-9-]+\.s3[.-][a-z0-9-]+\.amazonaws\.com$") ? "s3-regional"
                : uri.Host.EndsWith(".blob.core.windows.net", StringComparison.Ordinal) ? "azure-blob" : "other";
            throw StorageRefuse("host-" + family + (uri.Host.StartsWith("plat-", StringComparison.Ordinal) ? "-plat" : "-other"));
        }
        var query = uri.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Where(p => p.Length == 2)
            .GroupBy(p => p[0], StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.Select(p => Uri.UnescapeDataString(p[1])).ToArray(), StringComparer.OrdinalIgnoreCase);
        if (!query.TryGetValue("X-Amz-Date", out var dates) || dates.Length != 1 || !DateTimeOffset.TryParseExact(dates[0], "yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var issued)) throw StorageRefuse("signature-date");
        if (issued > now.AddMinutes(5)) throw StorageRefuse("signature-future");
        if (!query.TryGetValue("X-Amz-Expires", out var expires) || expires.Length != 1 || !int.TryParse(expires[0], out var seconds) || seconds < 1 || seconds > 604800) throw StorageRefuse("signature-duration");
        if (issued.AddSeconds(seconds) <= now) throw StorageRefuse("signature-expired");
        if (!query.TryGetValue("X-Amz-Signature", out var sig) || sig.Length != 1 || string.IsNullOrEmpty(sig[0])) throw StorageRefuse("signature-value");
        return uri;
    }
    private static PortalCore.Refusal StorageRefuse(string reason) => new("KNOWLEDGE_DOWNLOAD_UNVERIFIED", "Private storage URL did not match the verified contract.", reason);
    private static async Task<byte[]> Bounded(Stream stream, int max, CancellationToken token) {
        using var memory = new MemoryStream(); var chunk = new byte[8192]; int n;
        while ((n = await stream.ReadAsync(chunk, token)) > 0) { if (memory.Length + n > max) throw Refuse(); await memory.WriteAsync(chunk.AsMemory(0, n), token); }
        return memory.ToArray();
    }
    internal static async Task<JsonObject> Send(HttpClient portal, HttpClient storage, Request request, PrivateHttpContext context,
        string host, string user, string downloads, CancellationToken token) {
        var stage = "portal-request";
        int? portalStatus = null, storageStatus = null;
        try {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            var remaining = request.Deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); if (remaining <= 0 || remaining > 30000) throw Refuse();
            deadline.CancelAfter(TimeSpan.FromMilliseconds(remaining)); token = deadline.Token;
            using var message = new HttpRequestMessage(HttpMethod.Post, "https://" + host + Pathname);
            message.Headers.Add("Cookie", context.Cookie); if (context.Csrf.Length > 0) message.Headers.Add("x-csrftoken", context.Csrf);
            message.Headers.Add("outsystems-client-env", "browser"); message.Headers.Add("Origin", "https://" + host);
            message.Headers.Referrer = new Uri("https://" + host + "/knowledgebases/");
            message.Content = new StringContent(request.Body.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await portal.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, token);
            portalStatus = (int)response.StatusCode;
            stage = "portal-response";
            if ((int)response.StatusCode is 401 or 403) {
                var denied = PortalCore.Fail((int)response.StatusCode == 401 ? "PORTAL_AUTH_REQUIRED" : "PORTAL_ACCESS_DENIED", "The selected Portal session does not authorize this file read.");
                denied["status"] = (int)response.StatusCode; return denied;
            }
            if ((int)response.StatusCode != 200 || response.RequestMessage?.RequestUri != message.RequestUri
                || response.Content.Headers.ContentType?.MediaType?.Contains("json", StringComparison.OrdinalIgnoreCase) != true) throw Refuse();
            await using var raw = await response.Content.ReadAsStreamAsync(token);
            stage = "portal-body";
            var body = JsonNode.Parse(await Bounded(raw, 65536, token)) as JsonObject;
            if (body == null || body["exception"] != null || body["error"] != null || (bool?)body["versionInfo"]?["hasApiVersionChanged"] == true || (bool?)body["versionInfo"]?["hasModuleVersionChanged"] == true
                || body["data"]?["FileDownload"]?["Url"] is not JsonValue link || !link.TryGetValue<string>(out var signed)
                || (string?)body["data"]?["FileDownload"]?["Filename"] != request.Filename) throw Refuse();
            stage = "storage-url";
            var uri = StorageUri(signed, DateTimeOffset.UtcNow);
            // A dedicated client must have no Portal default headers. No redirect
            // is followed by the production factory; also verify the final URI.
            if (storage.DefaultRequestHeaders.Any()) throw Refuse();
            using var get = new HttpRequestMessage(HttpMethod.Get, uri);
            stage = "storage-request";
            using var blob = await storage.SendAsync(get, HttpCompletionOption.ResponseHeadersRead, token);
            storageStatus = (int)blob.StatusCode;
            stage = "storage-response";
            if ((int)blob.StatusCode != 200 || blob.RequestMessage?.RequestUri != uri || blob.Content.Headers.ContentLength is long length && length != request.Length) throw Refuse();
            stage = "storage-file";
            Directory.CreateDirectory(downloads); var partial = Path.Combine(downloads, "knowledge-file-" + request.Id + ".partial"); var file = Path.ChangeExtension(partial, ".bin");
            if (File.Exists(file)) throw Refuse();
            await using var content = await blob.Content.ReadAsStreamAsync(token);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); var buffer = new byte[8192]; long count = 0; string actual;
            try {
                await using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.Asynchronous)) {
                    int n; while ((n = await content.ReadAsync(buffer, token)) > 0) { count += n; if (count > request.Length) throw Refuse(); hash.AppendData(buffer, 0, n); await output.WriteAsync(buffer.AsMemory(0, n), token); }
                    await output.FlushAsync(token);
                }
                actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            } finally { CryptographicOperations.ZeroMemory(buffer); }
            stage = "storage-hash";
            if (count != request.Length || !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(actual), Convert.FromHexString(request.Sha256))) throw Refuse();
            File.Move(partial, file, false);
            return new JsonObject { ["ok"] = true, ["host"] = host, ["user"] = user, ["status"] = 200,
                ["body"] = new JsonObject { ["data"] = new JsonObject { ["FileDownloadProof"] = new JsonObject {
                    ["downloadId"] = request.Id, ["fileId"] = (string?)request.Body["inputParameters"]?["FileId"], ["file"] = file,
                    ["filename"] = request.Filename, ["mimeType"] = request.Mime, ["byteLength"] = count, ["sha256"] = actual,
                    ["contentReadBackVerified"] = true, ["ingestionVerified"] = false, ["signedUriExposed"] = false } } } };
        } catch (Exception error) {
            var result = PortalCore.Fail("KNOWLEDGE_DOWNLOAD_UNVERIFIED", "Private knowledge-file download did not verify its exact content; no URL, credentials or raw remote response is exposed.");
            result["diagnosticStage"] = stage;
            if (stage == "storage-url" && error is PortalCore.Refusal refusal) result["storageUrlCheck"] = refusal.Gate;
            if (portalStatus != null) result["portalStatus"] = portalStatus;
            if (storageStatus != null) result["storageStatus"] = storageStatus;
            return result;
        }
    }
}
