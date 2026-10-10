using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Refusal = PortalCore.Refusal;

// portal-upload (PortalUpload.cs): the Studio session's client is a fake over a counting handler (GET /uploads and POST
// /generation-operations), the upload client another one (the presigned PUT). Every assertion is about what would leave,
// through which client, in which order, and what the answer keeps. Nothing leaves the machine.
public sealed class PortalUploadTests : IDisposable {
    private const string Host = "personal-test.outsystems.dev";
    private const string UploadUrl = "https://bucket.storage.example/upload/lib.zip?X-Amz-Signature=abc123&X-Amz-Credential=key";
    private const string DownloadUrl = "https://bucket.storage.example/download/lib.zip?X-Amz-Signature=def456";
    private readonly string dir = Path.Combine(Path.GetTempPath(), "odc-bridge-upload-" + Guid.NewGuid().ToString("N"));
    private string Uploads => Path.Combine(dir, "uploads");
    private PortalCore.Places Places => new(Path.Combine(dir, "writes"), Path.Combine(dir, "downloads"));
    private static readonly PortalCore.TenantPolicy Tenants = PortalCore.ReadTenants("{\"default\":\"" + Host + "\",\"tenants\":{\"" + Host + "\":{}}}");
    public void Dispose() { try { Directory.Delete(dir, true); } catch { } }

    private sealed class Handler(Func<HttpRequestMessage, string?, HttpResponseMessage> answer) : HttpMessageHandler {
        public readonly List<(HttpMethod Method, Uri Uri, string? Body, bool Authorized, string? ContentType)> Seen = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            var body = request.Content == null ? null : await request.Content.ReadAsStringAsync(token);
            Seen.Add((request.Method, request.RequestUri!, body, request.Headers.Authorization != null, request.Content?.Headers.ContentType?.MediaType));
            var response = answer(request, body);
            response.RequestMessage ??= request;
            response.Headers.Date ??= DateTimeOffset.UtcNow;
            return response;
        }
    }
    private static HttpResponseMessage Json(int status, string body) => new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    // The Studio's AuthenticatedHttpClient: its handler adds the user's Bearer to every request it sends.
    private sealed class BearerHandler(HttpMessageHandler inner) : DelegatingHandler(inner) {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "studio-token");
            return base.SendAsync(request, token);
        }
    }
    private static Handler Session(string uploadUrl = UploadUrl, string downloadUrl = DownloadUrl, Func<HttpRequestMessage, HttpResponseMessage>? post = null) => new((request, _) =>
        request.Method == HttpMethod.Get
            ? Json(200, JsonSerializer.Serialize(new { uploadUrl, downloadUrl }))
            : post?.Invoke(request) ?? Json(200, "{\"operationKey\":\"job-1\"}"));

    private (PortalUpload.Request Request, byte[] Bytes) Staged(string name = "SSAMTextTools-0123456789abcdef.zip", byte[]? bytes = null, string? uuid = null) {
        Directory.CreateDirectory(Uploads);
        bytes ??= Encoding.UTF8.GetBytes("PK fake package");
        File.WriteAllBytes(Path.Combine(Uploads, name), bytes);
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        return (PortalUpload.Parse(JsonSerializer.Serialize(new { file = Path.Combine(Uploads, name), sha256 = sha, fileName = name,
            operationUuid = uuid ?? Guid.NewGuid().ToString(), authorizeSha256 = new string('a', 64) })), bytes);
    }
    private Task<JsonObject> Run(Handler session, Handler upload, PortalUpload.Request request) =>
        PortalUpload.Run(new HttpClient(new BearerHandler(session)), request, Host, "dev@example.test", Tenants, Places, Uploads, () => new HttpClient(upload));

    [Fact]
    public async Task OneUploadIsGetThenAnUnauthenticatedPutThenOnePostAndTheAnswerHasNoUrl() {
        var (request, bytes) = Staged();
        var reservation = Path.Combine(Places.WritesDir, request.OperationUuid.ToLowerInvariant() + ".json");
        var reservedBeforePost = false;
        var session = Session(post: r => { reservedBeforePost = File.Exists(reservation); return Json(200, "{\"operationKey\":\"job-1\"}"); });
        var upload = new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK));
        var result = await Run(session, upload, request);
        Assert.True((bool)result["ok"]!, result.ToJsonString());
        Assert.Equal("job-1", (string)result["operationKey"]!);
        Assert.Equal(bytes.Length, (int)result["bytes"]!);
        // The session saw only the tenant: GET /uploads, then POST /generation-operations with the downloadUrl.
        Assert.Equal(new[] { "GET https://" + Host + "/api/external-libraries/v1/uploads", "POST https://" + Host + "/api/external-libraries/v1/generation-operations" },
            session.Seen.Select(s => s.Method + " " + s.Uri.AbsoluteUri).ToArray());
        Assert.DoesNotContain(session.Seen, s => s.Uri.Host != Host);
        var posted = JsonNode.Parse(session.Seen[1].Body!)!;
        Assert.Equal(request.FileName, (string)posted["fileName"]!);
        Assert.Equal(new Uri(DownloadUrl).AbsoluteUri, (string)posted["highCodeBinaryUri"]!);
        // The PUT went out once, through the other client, without any Authorization, as application/zip.
        var put = Assert.Single(upload.Seen);
        Assert.Equal(HttpMethod.Put, put.Method);
        Assert.Equal("bucket.storage.example", put.Uri.Host);
        Assert.False(put.Authorized);
        Assert.Equal("application/zip", put.ContentType);
        Assert.True(reservedBeforePost, "the reservation exists before the POST");
        var text = result.ToJsonString() + File.ReadAllText(reservation) + File.ReadAllText(Path.ChangeExtension(reservation, ".outcome.json"));
        Assert.DoesNotContain("bucket.storage.example", text);
        Assert.DoesNotContain("X-Amz", text);
        Assert.DoesNotContain("uploadUrl", text);
        Assert.DoesNotContain("downloadUrl", text);
    }

    [Theory]
    [InlineData("http://bucket.storage.example/upload?sig=1")]
    [InlineData("https://user:secret@bucket.storage.example/upload")]
    [InlineData("https://bucket.storage.example:8443/upload")]
    [InlineData("not a url")]
    public async Task AnUploadTargetThatIsNotPlainHttpsIsRefusedBeforeAnyWrite(string target) {
        var (request, _) = Staged();
        var session = Session(uploadUrl: target);
        var upload = new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK));
        var result = await Run(session, upload, request);
        Assert.False((bool)result["ok"]!);
        Assert.Contains((string)result["code"]!, new[] { "NOT_ALLOWED", "PORTAL_CONTRACT_CHANGED" });
        Assert.Empty(upload.Seen);
        Assert.Single(session.Seen); // only the GET of the schema
        Assert.False(File.Exists(Path.Combine(Places.WritesDir, request.OperationUuid.ToLowerInvariant() + ".json")));
        Assert.DoesNotContain("secret", result.ToJsonString());
    }

    [Fact]
    public async Task ARedirectOfThePutIsNeverFollowedAndNoGenerationIsRequested() {
        var (request, _) = Staged();
        var session = Session();
        var upload = new Handler((_, _) => { var r = new HttpResponseMessage(HttpStatusCode.TemporaryRedirect); r.Headers.Location = new Uri("https://elsewhere.example/x"); return r; });
        var result = await Run(session, upload, request);
        Assert.Equal("UPLOAD_REJECTED", (string)result["code"]!);
        Assert.Equal("upload_redirect", (string)result["gate"]!);
        Assert.Single(upload.Seen);
        Assert.DoesNotContain(session.Seen, s => s.Method == HttpMethod.Post);
        Assert.False(PortalUpload.NewUploadClient() is null);
    }

    [Fact]
    public async Task APackageOutsideUploadsOrWithAnotherSha256IsRefusedBeforeAnyRequest() {
        var (request, _) = Staged();
        var outside = Path.Combine(dir, "elsewhere.zip");
        File.WriteAllBytes(outside, new byte[] { 1 });
        var session = Session(); var upload = new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK));
        var moved = await Run(session, upload, request with { File = outside });
        Assert.Equal("BAD_REQUEST", (string)moved["code"]!);
        var changed = await Run(session, upload, request with { Sha256 = new string('b', 64) });
        Assert.Equal("BAD_REQUEST", (string)changed["code"]!);
        Assert.Equal("package_sha256", (string)changed["gate"]!);
        var big = Path.Combine(Uploads, "Big-0123456789abcdef.zip");
        using (var stream = File.Create(big)) stream.SetLength(PortalUpload.MaxPackageBytes + 1);
        var large = await Run(session, upload, request with { File = big });
        Assert.Equal("PACKAGE_TOO_LARGE", (string)large["code"]!);
        Assert.Empty(session.Seen); Assert.Empty(upload.Seen);
    }

    [Fact]
    public async Task TheSameOperationUuidTwiceIsRetryRefusedAndNothingLeaves() {
        var uuid = Guid.NewGuid().ToString();
        var (request, _) = Staged(uuid: uuid);
        var session = Session(); var upload = new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK));
        Assert.True((bool)(await Run(session, upload, request))["ok"]!);
        var calls = session.Seen.Count + upload.Seen.Count;
        var again = await Run(session, upload, request);
        Assert.Equal("NOT_ALLOWED", (string)again["code"]!);
        Assert.Equal("retry_refused", (string)again["gate"]!);
        Assert.Equal(calls, session.Seen.Count + upload.Seen.Count);
    }

    [Fact]
    public async Task ALostGenerationAnswerIsUncertainAndARefusedOneIsRejected() {
        var (request, _) = Staged();
        var lost = await Run(Session(post: _ => throw new HttpRequestException("connection reset")), new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK)), request);
        Assert.Equal("UNCERTAIN", (string)lost["code"]!);
        var outcome = JsonNode.Parse(File.ReadAllText(Path.Combine(Places.WritesDir, request.OperationUuid.ToLowerInvariant() + ".outcome.json")))!;
        Assert.Equal("uncertain", (string)outcome["state"]!);
        var (second, _) = Staged();
        var refused = await Run(Session(post: _ => Json(400, "{\"title\":\"bad file\"}")), new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK)), second);
        Assert.Equal("REMOTE_ERROR", (string)refused["code"]!);
        Assert.Equal(400, (int)refused["status"]!);
    }

    [Fact]
    public void TheRequestFileTakesOnlyItsFieldsAndAWriteNeedsItsUuidAndWords() {
        Assert.Equal("BAD_REQUEST", Assert.Throws<Refusal>(() => PortalUpload.Parse("{\"file\":\"a.zip\"}")).Code);
        Assert.Equal("BAD_REQUEST", Assert.Throws<Refusal>(() => PortalUpload.Parse(JsonSerializer.Serialize(new { file = "a.zip", sha256 = new string('a', 64), fileName = "a.zip",
            operationUuid = Guid.NewGuid().ToString(), authorizeSha256 = new string('a', 64), uploadUrl = "https://x.example/" }))).Code);
        Assert.Equal("BAD_REQUEST", Assert.Throws<Refusal>(() => PortalUpload.Parse(JsonSerializer.Serialize(new { file = "a.zip", sha256 = new string('a', 64), fileName = "../a.zip",
            operationUuid = Guid.NewGuid().ToString(), authorizeSha256 = new string('a', 64) }))).Code);
        Assert.Equal("BAD_REQUEST", Assert.Throws<Refusal>(() => PortalUpload.Parse(JsonSerializer.Serialize(new { file = "a.zip", sha256 = new string('a', 64), fileName = "a.zip",
            operationUuid = "not-a-uuid", authorizeSha256 = new string('a', 64) }))).Code);
        Assert.Equal("NOT_ALLOWED", Assert.Throws<Refusal>(() => PortalUpload.CheckTarget("https://u:p@x.example/a", "uploadUrl")).Code);
    }
}
