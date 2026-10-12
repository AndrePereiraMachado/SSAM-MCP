using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Ssam.PrivateTransport;
using Xunit;

public sealed class PortalKnowledgeDownloadTests : IDisposable {
    private const string Host = "personal-test.outsystems.dev", User = "user@example.test", Cookie = "session=private-cookie-sentinel", Secret = "private-signature-sentinel";
    private readonly string dir = Path.Combine(Path.GetTempPath(), "ssam-knowledge-download-" + Guid.NewGuid());
    private static readonly byte[] Bytes = Encoding.UTF8.GetBytes("own proof\n");
    private static string Sha => Convert.ToHexString(SHA256.HashData(Bytes)).ToLowerInvariant();
    private static string Signed => "https://plat-test.s3.eu-west-1.amazonaws.com/knowledgebases/own-file?X-Amz-Date=" + DateTimeOffset.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'") + "&X-Amz-Expires=300&X-Amz-Signature=" + Secret;
    private static JsonObject Input() => new() {
        ["operationId"] = "knowledgeBases.downloadFile", ["method"] = "POST", ["path"] = PortalKnowledgeDownload.Pathname, ["confirmTenant"] = Host,
        ["downloadId"] = Guid.NewGuid().ToString(), ["deadlineAt"] = DateTimeOffset.UtcNow.AddSeconds(25).ToUnixTimeMilliseconds(),
        ["expectedContent"] = new JsonObject { ["filename"] = "proof.txt", ["mimeType"] = "text/plain", ["byteLength"] = Bytes.Length, ["sha256"] = Sha },
        ["body"] = new JsonObject { ["versionInfo"] = new JsonObject { ["moduleVersion"] = "module", ["apiVersion"] = "api" }, ["viewName"] = "DataSources.datasource",
            ["inputParameters"] = new JsonObject { ["KnowledgeBaseId"] = Guid.NewGuid().ToString(), ["DataSourceId"] = Guid.NewGuid().ToString(), ["FileId"] = Guid.NewGuid().ToString(), ["EnvironmentId"] = Guid.NewGuid().ToString(), ["OverrideBaseURL"] = "" },
            ["screenData"] = new JsonObject { ["variables"] = new JsonObject() }, ["clientVariables"] = new JsonObject() } };
    private static PrivateHttpContext Context() {
        var now = DateTimeOffset.UtcNow; var hash = new string('a', 64);
        var json = new JsonObject { ["schema"] = "ssam-private-http-context/1", ["requestSha256"] = hash, ["host"] = Host, ["principal"] = User,
            ["issuedAt"] = now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"), ["expiresAt"] = now.AddSeconds(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"), ["cookie"] = Cookie, ["csrf"] = "private-csrf-sentinel" };
        return PrivateHttpContext.Parse(Encoding.UTF8.GetBytes(json.ToJsonString()), hash, Host, User, now);
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler {
        internal int Count;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { token.ThrowIfCancellationRequested(); Count++; var r = answer(request); r.RequestMessage ??= request; return Task.FromResult(r); }
    }
    private static HttpResponseMessage Native(HttpRequestMessage request, string? url = null, string? filename = null) {
        Assert.Equal(Cookie, request.Headers.GetValues("Cookie").Single()); Assert.Equal("https://" + Host + PortalKnowledgeDownload.Pathname, request.RequestUri!.AbsoluteUri);
        return new(HttpStatusCode.OK) { Content = new StringContent(new JsonObject { ["data"] = new JsonObject { ["FileDownload"] = new JsonObject { ["Url"] = url ?? Signed, ["Filename"] = filename ?? "proof.txt" } } }.ToJsonString(), Encoding.UTF8, "application/json") };
    }
    private static HttpResponseMessage Blob(HttpRequestMessage request, byte[]? bytes = null) {
        Assert.Equal(HttpMethod.Get, request.Method); Assert.Empty(request.Headers); Assert.Null(request.Content);
        return new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes ?? Bytes) };
    }
    private async Task<JsonObject> Run(JsonObject input, Handler portal, Handler storage, Action<HttpClient>? configure = null) {
        using var p = new HttpClient(portal); using var s = new HttpClient(storage); configure?.Invoke(s);
        return await PortalKnowledgeDownload.Send(p, s, PortalKnowledgeDownload.Parse(input, Host, DateTimeOffset.UtcNow), Context(), Host, User, dir, CancellationToken.None);
    }
    [Fact] public async Task ExactBytesAreSavedExclusivelyWithoutReturningSignedUriOrForwardingPortalHeaders() {
        var input = Input(); var portal = new Handler(r => Native(r)); var storage = new Handler(r => Blob(r)); var result = await Run(input, portal, storage);
        Assert.True((bool)result["ok"]!); var proof = result["body"]!["data"]!["FileDownloadProof"]!;
        Assert.Equal(Sha, (string?)proof["sha256"]); Assert.Equal(Bytes, File.ReadAllBytes((string)proof["file"]!)); Assert.False((bool)proof["ingestionVerified"]!);
        Assert.Equal(1, portal.Count); Assert.Equal(1, storage.Count); Assert.DoesNotContain(Secret, result.ToJsonString()); Assert.DoesNotContain(Cookie, result.ToJsonString()); Assert.DoesNotContain("https://", result.ToJsonString());
    }
    [Theory] [InlineData("method")] [InlineData("path")] [InlineData("operationId")] [InlineData("confirmTenant")] [InlineData("downloadId")]
    [InlineData("override")] [InlineData("fileId")] [InlineData("collision")] [InlineData("view")] [InlineData("variables")] [InlineData("clientVariables")]
    [InlineData("hash")] [InlineData("length")] [InlineData("deadline")] [InlineData("extra")] [InlineData("versions")]
    public void ChangedScopeRefusesBeforeAnyHttp(string field) {
        var input = Input(); switch (field) {
            case "override": input["body"]!["inputParameters"]!["OverrideBaseURL"] = "https://other.test/"; break;
            case "fileId": input["body"]!["inputParameters"]!["FileId"] = "invalid"; break;
            case "collision": input["body"]!["inputParameters"]!["FileId"] = (string?)input["body"]!["inputParameters"]!["DataSourceId"]; break;
            case "view": input["body"]!["viewName"] = "DataSourceFile.datasourcefile"; break;
            case "variables": input["body"]!["screenData"]!["variables"]!["Id"] = Guid.NewGuid().ToString(); break;
            case "clientVariables": input["body"]!["clientVariables"]!["x"] = "private"; break;
            case "hash": input["expectedContent"]!["sha256"] = "invalid"; break;
            case "length": input["expectedContent"]!["byteLength"] = PortalKnowledgeDownload.MaxBytes + 1; break;
            case "deadline": input["deadlineAt"] = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(); break;
            case "versions": input["body"]!["versionInfo"]!["apiVersion"] = ""; break;
            default: input[field] = "invalid-private"; break;
        }
        var e = Assert.Throws<PortalCore.Refusal>(() => PortalKnowledgeDownload.Parse(input, Host, DateTimeOffset.UtcNow)); Assert.DoesNotContain("invalid-private", e.Message);
    }
    [Theory] [InlineData("http://plat-test.s3.eu-west-1.amazonaws.com/key")] [InlineData("https://example.test/key")]
    [InlineData("https://127.0.0.1/key")] [InlineData("https://plat-test.s3.eu-west-1.amazonaws.com:444/key")]
    [InlineData("https://u:p@plat-test.s3.eu-west-1.amazonaws.com/key")] [InlineData("https://plat-test.s3.eu-west-1.amazonaws.com/key#fragment")]
    public void UnknownOrCredentialedStorageNeverReceivesHttp(string value) => Assert.Throws<PortalCore.Refusal>(() => PortalKnowledgeDownload.StorageUri(value, DateTimeOffset.UtcNow));
    [Theory]
    [InlineData("https://-invalid.s3.amazonaws.com/own?private=value", "host-s3-global-other")]
    [InlineData("https://different.s3.eu-west-1.amazonaws.com/own?private=value", "host-s3-regional-other")]
    [InlineData("https://different.blob.core.windows.net/own?private=value", "host-azure-blob-other")]
    public void UnsupportedStorageReportsOnlyFixedShape(string url, string reason) {
        var error = Assert.Throws<PortalCore.Refusal>(() => PortalKnowledgeDownload.StorageUri(url, DateTimeOffset.UtcNow));
        Assert.Equal(reason, error.Gate); Assert.DoesNotContain("private=value", error.Message); Assert.DoesNotContain("https://", error.Message);
    }
    [Fact] public async Task GlobalS3KnowledgeStorageUsesIsolatedClientAndVerifiesExactBytes() {
        var url = Signed.Replace("plat-test.s3.eu-west-1.amazonaws.com", "knowledge-test-bucket.s3.amazonaws.com");
        var portal = new Handler(r => { var answer=Native(r);answer.Content=new StringContent(new JsonObject { ["data"]=new JsonObject { ["FileDownload"]=new JsonObject { ["Url"]=url,["Filename"]="proof.txt" } } }.ToJsonString(),Encoding.UTF8,"application/json");return answer; });
        var storage = new Handler(r => Blob(r));var result=await Run(Input(),portal,storage);
        Assert.True((bool)result["ok"]!);Assert.Equal(1,storage.Count);Assert.DoesNotContain(url,result.ToJsonString());
        Assert.Throws<PortalCore.Refusal>(()=>PortalKnowledgeDownload.StorageUri(url.Replace(".amazonaws.com/",".amazonaws.com.attacker.test/"),DateTimeOffset.UtcNow));
    }
    [Theory] [InlineData("wrong-filename")] [InlineData("redirect-native")] [InlineData("redirect-storage")] [InlineData("wrong-bytes")]
    [InlineData("oversized-json")] [InlineData("exception")] [InlineData("version")] [InlineData("short-body")]
    public async Task RemoteFailuresAreSanitizedAndNeverVerifyContent(string kind) {
        var portal = new Handler(r => {
            var response = Native(r, filename: kind == "wrong-filename" ? "other.txt" : null);
            if (kind == "redirect-native") { response.StatusCode = HttpStatusCode.Redirect; response.Headers.Location = new Uri(Signed); }
            if (kind == "oversized-json") response.Content = new StringContent(new string('a', 65537) + Secret, Encoding.UTF8, "application/json");
            if (kind == "exception") response.Content = new StringContent("{\"exception\":{\"message\":\"" + Secret + "\"}}", Encoding.UTF8, "application/json");
            if (kind == "version") response.Content = new StringContent("{\"versionInfo\":{\"hasApiVersionChanged\":true}}", Encoding.UTF8, "application/json");
            return response;
        });
        var storage = new Handler(r => {
            var response = Blob(r, kind == "wrong-bytes" ? Enumerable.Repeat((byte)1, Bytes.Length).ToArray() : kind == "short-body" ? Bytes[..^1] : null);
            if (kind == "redirect-storage") { response.StatusCode = HttpStatusCode.Redirect; response.Headers.Location = new Uri("https://example.test/" + Secret); }
            return response;
        });
        var result = await Run(Input(), portal, storage); Assert.False((bool)result["ok"]!); Assert.DoesNotContain(Secret, result.ToJsonString()); Assert.DoesNotContain("https://", result.ToJsonString()); Assert.Equal(0, Directory.Exists(dir) ? Directory.GetFiles(dir, "*.bin").Length : 0);
        var expectedStage = kind == "redirect-native" ? "portal-response" : kind == "redirect-storage" || kind == "short-body" ? "storage-response" : kind == "wrong-bytes" ? "storage-hash" : "portal-body";
        Assert.Equal(expectedStage, (string?)result["diagnosticStage"]);
        Assert.Equal(kind == "redirect-native" ? 302 : 200, (int?)result["portalStatus"]);
    }
    [Fact] public async Task StorageDefaultHeadersAreRejectedAndExistingFilesAreNeverOverwritten() {
        var input = Input(); var portal = new Handler(r => Native(r)); var storage = new Handler(r => Blob(r));
        Assert.False((bool)(await Run(input, portal, storage, s => s.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "private")))["ok"]!); Assert.Equal(0, storage.Count);
        Directory.CreateDirectory(dir); var file = Path.Combine(dir, "knowledge-file-" + (string?)input["downloadId"] + ".bin"); File.WriteAllText(file, "preserved");
        Assert.False((bool)(await Run(input, portal, storage))["ok"]!); Assert.Equal("preserved", File.ReadAllText(file));
    }
    [Theory] [InlineData(401, "PORTAL_AUTH_REQUIRED")] [InlineData(403, "PORTAL_ACCESS_DENIED")]
    public async Task NativeAuthFailureIsTypedButDoesNotExposeItsBodyOrReachStorage(int status, string code) {
        var portal = new Handler(_ => new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(Secret + Cookie) });
        var storage = new Handler(r => Blob(r)); var result = await Run(Input(), portal, storage);
        Assert.False((bool)result["ok"]!); Assert.Equal(code, (string?)result["code"]); Assert.Equal(0, storage.Count); Assert.DoesNotContain(Secret, result.ToJsonString());
    }
    [Fact] public void ExpiredOrDuplicateStorageCapabilitiesAreRefusedWithoutTheirValues() {
        var now = DateTimeOffset.UtcNow;
        foreach (var url in new[] { Signed + "&X-Amz-Signature=duplicate", Signed.Replace("X-Amz-Expires=300", "X-Amz-Expires=0"), Signed.Replace(now.ToString("yyyyMMdd'T'HHmmss'Z'"), now.AddHours(-1).ToString("yyyyMMdd'T'HHmmss'Z'")) })
            Assert.DoesNotContain(Secret, Assert.Throws<PortalCore.Refusal>(() => PortalKnowledgeDownload.StorageUri(url, now)).Message);
    }
    public void Dispose() { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
}
