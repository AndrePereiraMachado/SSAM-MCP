using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Refusal = PortalCore.Refusal;

// The Studio's plugin client is replaced by a fake HttpClient over a counting handler: every assertion is about what
// the bridge would send, how often, and what it would answer. Nothing leaves the machine.
public sealed class PortalCoreTests : IDisposable {
    private const string Host = "personal-test.outsystems.dev";
    private readonly string dir = Path.Combine(Path.GetTempPath(), "odc-bridge-portal-" + Guid.NewGuid().ToString("N"));
    private PortalCore.Places Places => new(Path.Combine(dir, "writes"), Path.Combine(dir, "downloads"));
    private static readonly PortalCore.TenantPolicy Tenants = PortalCore.ReadTenants(
        "{\"default\":\"" + Host + "\",\"tenants\":{\"" + Host + "\":{},\"corporate.outsystems.dev\":{},\"client.outsystems.dev\":{\"readOnly\":true}}}");
    public void Dispose() { try { Directory.Delete(dir, true); } catch { } }

    private sealed class FakeHandler : HttpMessageHandler {
        public int Sends;
        public readonly List<HttpRequestMessage> Seen = new();
        // The bridge disposes its request after the send, so bodies are read when they arrive.
        public readonly List<string?> Bodies = new();
        public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Answer = (r, _) => Task.FromResult(Json(r, 200, "{\"items\":[1]}"));
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            Sends++; Seen.Add(request);
            Bodies.Add(request.Content == null ? null : await request.Content.ReadAsStringAsync(token));
            return await Answer(request, token);
        }
    }
    // Stands for the Studio's AuthenticatedHttpClient, whose handler is the session's token handler.
    private sealed class StudioClient : HttpClient {
        public bool Disposed;
        public StudioClient(HttpMessageHandler handler) : base(handler, disposeHandler: false) { }
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }
    private static HttpResponseMessage Json(HttpRequestMessage request, int status, string body) {
        var response = new HttpResponseMessage((HttpStatusCode)status) { RequestMessage = request, Content = new StringContent(body, Encoding.UTF8, "application/json") };
        response.Headers.Date = DateTimeOffset.UtcNow;
        return response;
    }
    private static PortalCore.ApiRequest Api(string method, string basePath, string path, bool write = false, string? uuid = null, string? query = null, JsonNode? body = null, string? confirm = null) =>
        new("op", "api", method, basePath, path, query, null, body, null, write, write ? uuid ?? Guid.NewGuid().ToString() : uuid, write ? new string('a', 64) : null, confirm);
    private static string Code(JsonObject result) => (string)result["code"]!;
    private static Refusal Refused(Action action) => Assert.Throws<Refusal>(action);

    // ---- allowlist and host
    [Fact]
    public void EveryCatalogFamilyBuildsAnAbsoluteUriOnTheSessionHost() {
        foreach (var basePath in PortalCore.BasePaths) {
            var uri = PortalCore.BuildUri(Host, basePath, "/environments", "limit=1&offset=0");
            Assert.Equal("https://" + Host + basePath + "/environments?limit=1&offset=0", uri.AbsoluteUri);
        }
    }

    [Theory]
    [InlineData("/api/other/v1")]
    [InlineData("/identity")]
    [InlineData("/api/builds/v1/..")]
    [InlineData("/monitoring/screenservices")]
    [InlineData("")]
    public void BasePathOutsideTheCatalogIsNotAllowed(string basePath) =>
        Assert.Equal("NOT_ALLOWED", Refused(() => PortalCore.BuildUri(Host, basePath, "/x", null)).Code);

    [Theory]
    [InlineData("/../../identity/v1/users")]
    [InlineData("/a/./b")]
    [InlineData("/a%2fb")]
    [InlineData("/a%2E%2E/b")]
    [InlineData("//evil.example/x")]
    [InlineData("/a?b=1")]
    [InlineData("/a#b")]
    [InlineData("/a\\b")]
    [InlineData("/a b")]
    [InlineData("users")]
    public void PathsThatClimbOrSmuggleAreRefused(string path) =>
        Assert.Equal("BAD_REQUEST", Refused(() => PortalCore.BuildUri(Host, "/api/identity/v1", path, null)).Code);

    [Theory]
    [InlineData("?limit=1")]
    [InlineData("a=1#x")]
    [InlineData("a=1 b")]
    [InlineData("a=1\r\nHost: evil")]
    public void QueriesMustBeSerializedPlainly(string query) =>
        Assert.Equal("BAD_REQUEST", Refused(() => PortalCore.BuildUri(Host, "/api/identity/v1", "/users", query)).Code);

    [Theory]
    [InlineData("evil.example/x")]
    [InlineData("user@evil.example")]
    [InlineData("evil.example:8443")]
    [InlineData("localhost")]
    public void TheSessionHostMustBeAPlainDnsName(string host) =>
        Assert.Equal("HOST_MISMATCH", Refused(() => PortalCore.BuildUri(host, "/api/identity/v1", "/users", null)).Code);

    // ---- one send, through the Studio's client, never disposed
    [Fact]
    public async Task AReadIsSentOnceAndTheStudioClientIsNeverDisposed() {
        var handler = new FakeHandler();
        var client = new StudioClient(handler);
        var result = await PortalCore.Send(client, Api("GET", "/api/portfolios/v2", "/environments"), Host, "user@example.com", Tenants, Places);
        Assert.True((bool)result["ok"]!);
        Assert.Equal("studio", (string)result["source"]!);
        Assert.Equal(Host, (string)result["host"]!);
        Assert.Equal(200, (int)result["status"]!);
        Assert.Equal(1, (int)result["body"]!["items"]![0]!);
        Assert.Equal(1, handler.Sends);
        Assert.Equal("https://" + Host + "/api/portfolios/v2/environments", handler.Seen[0].RequestUri!.AbsoluteUri);
        Assert.False(client.Disposed);
        // The same client keeps working for the Studio after the call.
        await client.GetAsync("https://" + Host + "/api/portfolios/v2/environments");
        Assert.Equal(2, handler.Sends);
    }

    [Fact]
    public async Task AMutationNotMarkedAsWriteIsNeverSent() {
        var handler = new FakeHandler();
        var result = await PortalCore.Send(new StudioClient(handler), Api("POST", "/api/asset-repository/v1", "/assets"), Host, null, Tenants, Places);
        Assert.Equal("NOT_ALLOWED", Code(result));
        Assert.Equal(0, handler.Sends);
    }

    [Fact]
    public async Task ASearchPostIsARead() {
        var handler = new FakeHandler();
        var result = await PortalCore.Send(new StudioClient(handler), Api("POST", "/api/asset-repository/v1", "/assets/search", body: JsonNode.Parse("{\"keys\":[]}")), Host, null, Tenants, Places);
        Assert.True((bool)result["ok"]!);
        Assert.Equal(1, handler.Sends);
        Assert.Equal("{\"keys\":[]}", handler.Bodies[0]);
        Assert.False(Directory.Exists(Places.WritesDir));
    }

    [Theory]
    [InlineData("not-a-uuid", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("3f2504e0-4f89-11d3-9a0c-0305e82c3301", "the user's words in clear")]
    [InlineData(null, null)]
    public async Task AWriteWithoutItsAuthorizationFieldsIsRefused(string? uuid, string? sha) {
        var handler = new FakeHandler();
        var request = Api("DELETE", "/api/identity/v1", "/groups/g1") with { Write = true, OperationUuid = uuid, AuthorizeSha256 = sha };
        var result = await PortalCore.Send(new StudioClient(handler), request, Host, null, Tenants, Places);
        Assert.Equal("BAD_REQUEST", Code(result));
        Assert.Equal(0, handler.Sends);
    }

    [Fact]
    public async Task AFailedWriteIsUncertainAndItsUuidIsNeverSentAgain() {
        var handler = new FakeHandler { Answer = (_, _) => throw new HttpRequestException("connection reset") };
        var client = new StudioClient(handler);
        var uuid = Guid.NewGuid().ToString();
        var write = Api("POST", "/api/deployments/v1", "/deployment-operations", write: true, uuid: uuid, body: JsonNode.Parse("{\"assetKey\":\"k\"}"));
        var first = await PortalCore.Send(client, write, Host, "user@example.com", Tenants, Places);
        Assert.Equal("UNCERTAIN", Code(first));
        Assert.Equal(1, handler.Sends);
        Assert.Contains("never resend", (string)first["message"]!);
        var reservation = Path.Combine(Places.WritesDir, uuid + ".json");
        Assert.True(File.Exists(reservation));
        Assert.Contains("\"uncertain\"", File.ReadAllText(Path.Combine(Places.WritesDir, uuid + ".outcome.json")));
        // The reservation holds the hash of the words and the body hash, never the body.
        var record = File.ReadAllText(reservation);
        Assert.Contains(new string('a', 64), record);
        Assert.DoesNotContain("assetKey", record);

        handler.Answer = (r, _) => Task.FromResult(Json(r, 200, "{}"));
        var again = await PortalCore.Send(client, write, Host, "user@example.com", Tenants, Places);
        Assert.Equal("NOT_ALLOWED", Code(again));
        Assert.Equal("retry_refused", (string)again["gate"]!);
        Assert.Equal(1, handler.Sends);
        Assert.False(client.Disposed);
    }

    [Fact]
    public async Task AWriteWithoutAnswerInTimeIsUncertainAfterOneSend() {
        var handler = new FakeHandler { Answer = async (r, token) => { await Task.Delay(Timeout.Infinite, token); return Json(r, 200, "{}"); } };
        var result = await PortalCore.Send(new StudioClient(handler), Api("PATCH", "/api/identity/v1", "/users/u1", write: true, body: new JsonObject()), Host, null, Tenants, Places, TimeSpan.FromMilliseconds(200));
        Assert.Equal("UNCERTAIN", Code(result));
        Assert.Equal(1, handler.Sends);
    }

    [Fact]
    public async Task AFailedReadIsARemoteErrorNotAnUncertainty() {
        var handler = new FakeHandler { Answer = (_, _) => throw new HttpRequestException("name not resolved") };
        var result = await PortalCore.Send(new StudioClient(handler), Api("GET", "/api/builds/v1", "/build-operations"), Host, null, Tenants, Places);
        Assert.Equal("REMOTE_ERROR", Code(result));
        Assert.Equal(1, handler.Sends);
    }

    [Fact]
    public async Task AnAnswerFromAnotherHostAfterARedirectIsDiscarded() {
        var handler = new FakeHandler { Answer = (_, _) => Task.FromResult(Json(new HttpRequestMessage(HttpMethod.Get, "https://bucket.s3.example/source.zip?X-Amz-Signature=abc"), 200, "{\"secretish\":1}")) };
        var read = await PortalCore.Send(new StudioClient(handler), Api("GET", "/api/asset-repository/v1", "/assets/a/revisions/1/source-code"), Host, null, Tenants, Places);
        Assert.Equal("HOST_MISMATCH", Code(read));
        Assert.Null(read["body"]);
        Assert.DoesNotContain("X-Amz-Signature=abc", read.ToJsonString());
        var write = await PortalCore.Send(new StudioClient(handler), Api("POST", "/api/code-quality/v1", "/code-analyses", write: true, body: new JsonObject()), Host, null, Tenants, Places);
        Assert.Equal("UNCERTAIN", Code(write));
        Assert.Equal("HOST_MISMATCH", (string)write["reason"]!);
        Assert.Null(write["body"]);
    }

    [Fact]
    public async Task ATokenRenewalFailureMeansSignInAgainAndARealUnauthorizedIsARemoteError() {
        var handler = new FakeHandler { Answer = (r, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized) { RequestMessage = r, ReasonPhrase = "refresh token rejected" }) };
        var synthetic = await PortalCore.Send(new StudioClient(handler), Api("GET", "/api/identity/v1", "/users"), Host, null, Tenants, Places);
        Assert.Equal("STUDIO_NOT_SIGNED_IN", Code(synthetic));
        handler.Answer = (r, _) => Task.FromResult(Json(r, 401, "{\"title\":\"invalid audience\"}"));
        var real = await PortalCore.Send(new StudioClient(handler), Api("GET", "/api/identity/v1", "/users"), Host, null, Tenants, Places);
        Assert.Equal("REMOTE_ERROR", Code(real));
        Assert.Equal(401, (int)real["status"]!);
        Assert.Equal("invalid audience", (string)real["body"]!["title"]!);
    }

    [Fact]
    public async Task AServerErrorOnAWriteIsUncertainAndAClientErrorIsARejection() {
        var uuid = Guid.NewGuid().ToString();
        var handler = new FakeHandler { Answer = (r, _) => Task.FromResult(Json(r, 504, "{}")) };
        var gateway = await PortalCore.Send(new StudioClient(handler), Api("POST", "/api/deployments/v1", "/publish-operations", write: true, uuid: uuid, body: new JsonObject()), Host, null, Tenants, Places);
        Assert.Equal("UNCERTAIN", Code(gateway));
        Assert.Equal(504, (int)gateway["status"]!);
        handler.Answer = (r, _) => Task.FromResult(Json(r, 403, "{\"title\":\"forbidden\"}"));
        var forbidden = await PortalCore.Send(new StudioClient(handler), Api("POST", "/api/deployments/v1", "/publish-operations", write: true, body: new JsonObject()), Host, null, Tenants, Places);
        Assert.Equal("REMOTE_ERROR", Code(forbidden));
        Assert.Equal(403, (int)forbidden["status"]!);
    }

    [Fact]
    public async Task WritesHonorTheTenantGuard() {
        var handler = new FakeHandler();
        var write = Api("PATCH", "/api/asset-configurations/v1", "/environments/e/applications/a/configurations", write: true, body: new JsonObject());
        var corporate = await PortalCore.Send(new StudioClient(handler), write, "corporate.outsystems.dev", null, Tenants, Places);
        Assert.Equal("NOT_ALLOWED", Code(corporate));
        Assert.Equal("tenant_confirmation", (string)corporate["gate"]!);
        var readOnly = await PortalCore.Send(new StudioClient(handler), write with { OperationUuid = Guid.NewGuid().ToString(), ConfirmTenant = "client.outsystems.dev" }, "client.outsystems.dev", null, Tenants, Places);
        Assert.Equal("tenant_read_only", (string)readOnly["gate"]!);
        Assert.Equal(0, handler.Sends);
        var confirmed = await PortalCore.Send(new StudioClient(handler), write with { OperationUuid = Guid.NewGuid().ToString(), ConfirmTenant = "corporate.outsystems.dev" }, "corporate.outsystems.dev", null, Tenants, Places);
        Assert.True((bool)confirmed["ok"]!);
        Assert.Equal(1, handler.Sends);
        // Without tenants.json every write needs the confirmation.
        Assert.Equal("tenant_confirmation", Refused(() => PortalCore.CheckTenant(PortalCore.ReadTenants(null), Host, null)).Gate);
    }

    [Fact]
    public async Task OnlyAllowlistedAnswerHeadersComeBack() {
        var handler = new FakeHandler {
            Answer = (r, _) => {
                var response = Json(r, 201, "{}");
                response.Headers.Location = new Uri("https://" + Host + "/api/deployments/v1/deployment-operations/k1");
                response.Headers.Add("x-request-id", "req-1");
                response.Headers.Add("Set-Cookie", "session=abc");
                response.Headers.Add("x-internal-token", "t0k3n");
                return Task.FromResult(response);
            }
        };
        var result = await PortalCore.Send(new StudioClient(handler), Api("POST", "/api/deployments/v1", "/deployment-operations", write: true, body: new JsonObject()), Host, null, Tenants, Places);
        var headers = (JsonObject)result["headers"]!;
        Assert.Equal(new[] { "content-type", "location", "x-request-id" }, headers.Select(h => h.Key).OrderBy(k => k).ToArray());
        Assert.DoesNotContain("abc", result.ToJsonString());
        Assert.DoesNotContain("t0k3n", result.ToJsonString());
        Assert.Contains("\"accepted\"", File.ReadAllText(Directory.GetFiles(Places.WritesDir, "*.outcome.json").Single()));
    }

    [Fact]
    public async Task BinaryAnswersComeInBase64AndLargeOnesGoToAFile() {
        var small = new byte[] { 0x50, 0x4b, 3, 4 };
        var large = new byte[PortalCore.InlineLimit + 10];
        var bytes = small;
        var handler = new FakeHandler { Answer = (r, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = r, Content = new ByteArrayContent(bytes) { Headers = { ContentType = new("application/zip") } } }) };
        var inline = await PortalCore.Send(new StudioClient(handler), Api("GET", "/api/asset-repository/v1", "/assets/a/revisions/1/source-code"), Host, null, Tenants, Places);
        Assert.Equal(Convert.ToBase64String(small), (string)inline["bodyBase64"]!);
        bytes = large;
        var stored = await PortalCore.Send(new StudioClient(handler), Api("GET", "/api/asset-repository/v1", "/assets/a/revisions/1/source-code"), Host, null, Tenants, Places);
        Assert.Null(stored["bodyBase64"]);
        Assert.Equal(large.Length, (int)stored["bytes"]!);
        Assert.True(File.Exists((string)stored["bodyFile"]!));
        Assert.StartsWith(Places.DownloadsDir, (string)stored["bodyFile"]!);
    }

    [Fact]
    public void TheStudioClientMustCarryTheSessionTenant() {
        var client = new HttpClient();
        Assert.True(PortalCore.TenantHeaderMatches(client, null));
        client.DefaultRequestHeaders.Add("X-OSTenant", "tenant-1");
        Assert.True(PortalCore.TenantHeaderMatches(client, "tenant-1"));
        Assert.False(PortalCore.TenantHeaderMatches(client, "tenant-2"));
        Assert.False(PortalCore.TenantHeaderMatches(client, null));
    }

    // ---- redaction
    [Fact]
    public void SecretsAreRedactedAndKeysAreKept() {
        var node = JsonNode.Parse("""
            {"authToken":"gw-123","clientSecret":"cs","password":"p","applicationKey":"app-1","token":"t","nextOffset":5,
             "Authorization":"Bearer abc.def","note":"sent with Bearer xyz.uvw","settings":[{"name":"Url","isSecret":false,"value":"https://a.example/x"},
             {"name":"ApiPassword","isSecret":true,"value":"hunter2","defaultValue":"d"}],
             "download":"https://bucket.example/f.zip?X-Amz-Signature=sig1&X-Amz-Credential=cred&part=2",
             "connectionString":"Server=db;Password=pw","user":{"privateKey":"k","email":"a@b.c"}}
            """);
        var text = PortalCore.Redact(node)!.ToJsonString();
        foreach (var secret in new[] { "gw-123", "\"cs\"", "\"p\"", "\"t\"", "abc.def", "xyz.uvw", "hunter2", "\"d\"", "sig1", "cred", "pw", "\"k\"" })
            Assert.DoesNotContain(secret, text);
        foreach (var kept in new[] { "app-1", "\"nextOffset\":5", "https://a.example/x", "part=2", "a@b.c", "\"isSecret\":true" })
            Assert.Contains(kept, text);
    }

    [Fact]
    public void TheModuleVersionTokenSurvivesRedaction() {
        // portal-metadata.mjs sends versionToken back as moduleVersion in every screenservice call.
        var url = "https://" + Host + "/monitoring/moduleservices/moduleversioninfo";
        var ok = PortalCore.ShapeWeb(Page(200, url, "{\"versionToken\":\"module-v1\",\"authToken\":\"gw\"}"), Host, false, null, Places.DownloadsDir).Result;
        Assert.Equal("module-v1", (string)ok["body"]!["versionToken"]!);
        Assert.Equal(PortalCore.Redacted, (string)ok["body"]!["authToken"]!);
    }

    // ---- request files
    [Theory]
    [InlineData("{\"method\":\"GET\",\"basePath\":\"/api/identity/v1\",\"path\":\"/users\",\"body\":{}}")]
    [InlineData("{\"method\":\"POST\",\"basePath\":\"/api/identity/v1\",\"path\":\"/users\",\"body\":{},\"bodyBase64\":\"AA==\"}")]
    [InlineData("{\"method\":\"TRACE\",\"basePath\":\"/api/identity/v1\",\"path\":\"/users\"}")]
    [InlineData("{\"method\":\"POST\",\"basePath\":\"/api/identity/v1\",\"path\":\"/users\",\"write\":\"yes\"}")]
    [InlineData("[1,2]")]
    [InlineData("not json")]
    public void MalformedRequestFilesAreBadRequests(string json) =>
        Assert.Equal("BAD_REQUEST", Refused(() => PortalCore.ParseApiRequest(json)).Code);

    // ---- secretRefs: a fake vault stands for CredRead inside the Studio; no real vault is ever read. The request is the
    // external DB test of _notes\scp\fixtures\odc\internal-connections-external-db.json (connections.db.test), whose
    // body takes the database account in four places (Valid and Edited stage configs).
    private const string DbEntry = "SSAM/ODC3/" + Host + "/DB/SyntheticERP";
    private const string DbUser = "synthetic_reader", DbPassword = "Synth-Pa55-not-real";
    private sealed class FakeVault {
        public readonly Dictionary<string, PortalCore.VaultEntry> Entries = new(StringComparer.OrdinalIgnoreCase) { [DbEntry] = new(DbUser, DbPassword) };
        public readonly List<string> Reads = new();
        public Exception? Failure;
        public PortalCore.VaultEntry? Read(string target) {
            Reads.Add(target);
            if (Failure != null) throw Failure;
            return Entries.TryGetValue(target, out var entry) ? entry : null;
        }
    }
    private static string Refs(params (string Pointer, string Target, string Field)[] refs) =>
        "[" + string.Join(",", refs.Select(r => "{\"pointer\":\"" + r.Pointer + "\",\"target\":\"" + r.Target + "\",\"field\":\"" + r.Field + "\"}")) + "]";
    private static readonly string DbRefs = Refs(new[] { "ValidStageConfigs", "EditedStageConfigs" }.SelectMany(list => new[] { "Password", "Username" }.Select(name =>
        ("/inputParameters/" + list + "/List/0/ConnectionDetails_Common/Connection" + name, DbEntry, name.ToLowerInvariant()))).ToArray());
    private const string StageConfig = """
        {"List":[{"ConnectionDetails_Common":{"ConnectionUsername":"","ConnectionPassword":"","AdvancedConnectionString":"trustServerCertificate=true;",
          "ConnectionServer":"db.example.test","ConnectionServerPort":1433,"ConnectionDatabase":"SyntheticERP","IsPrivateGateway":false,"PrivateGatewayPort":0},
          "TenantStage":{"Key":"00000000-0000-4000-8000-00000000e001","Name":"Development","Purpose":"Development","Order":"1","Hosting":""}}]}
        """;
    private static string DbTestRequest(string? secretRefs = null) => """
        {"method":"POST","path":"/connections/screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnections_RelationalDB_Test_Wrapper",
         "body":{"versionInfo":{"moduleVersion":"SYNTH-moduleVersion-connections","apiVersion":"SYNTH-apiVersion-ActionConnections_RelationalDB_Test_Wrapper"},
          "viewName":"Connections.connection",
          "inputParameters":{"ConnectionId":"","ProviderId":"mssql","ForceErrorOnStageKeys":"","IsEditConnection":false,"ValidStageConfigs":@STAGES,
           "ConnectionDetails_Header":{"ConnectionName":"SyntheticERP","ConnectionDescription":"Synthetic external database","PortfolioKey":""},
           "EditedStageConfigs":@STAGES,"IsConfigChanged":true,"Variant":"vanilla"},
          "screenData":{"variables":{}},"clientVariables":{}},
         "write":true,"operationUuid":"00000000-0000-4000-9000-000000001001","authorizeSha256":"d956ad27c6e2cb80a89cb6c91296c778768b68c50fc8444674be972c01668d7a",
         "secretRefs":@REFS}
        """.Replace("@STAGES", StageConfig).Replace("@REFS", secretRefs ?? DbRefs);
    private const string SettingEntry = "SSAM/ODC3/" + Host + "/Setting/ApiKey";
    // A secret setting through the public API (public-asset-configurations.json, PATCH configurations).
    private static PortalCore.ApiRequest SettingWrite(string uuid) =>
        Api("PATCH", "/api/asset-configurations/v1", "/environments/e/applications/a/configurations", write: true, uuid: uuid,
            body: JsonNode.Parse("{\"key\":\"a\",\"revisionBaseline\":7,\"settings\":[{\"key\":\"synthetic-setting-key-1\",\"value\":\"\",\"filename\":null}]}"))
        with { SecretRefs = new[] { new PortalCore.SecretRef("/settings/0/value", SettingEntry, "password") } };
    private static string Sha256Hex(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    [Fact]
    public void TheFacadesDbTestParsesWithItsFourSecretRefsAsAWrite() {
        var r = PortalCore.ParseWebRequest(DbTestRequest());
        Assert.True(PortalCore.CheckWebRoute(r));
        Assert.Equal(4, r.SecretRefs!.Count);
        Assert.Equal(new[] { "password", "username", "password", "username" }, r.SecretRefs.Select(x => x.Field).ToArray());
        Assert.All(r.SecretRefs, x => Assert.Equal(DbEntry, x.Target));
    }

    [Fact]
    public void TheVaultAccountGoesToEveryPointerOfTheCopyThePageSendsAndNowhereElse() {
        var vault = new FakeVault();
        var r = PortalCore.ParseWebRequest(DbTestRequest());
        var (send, placed) = PortalCore.PlaceWebSecrets(r, Host, PortalCore.CheckWebRoute(r), vault.Read);
        // One read of the entry for its four pointers.
        Assert.Equal(new[] { DbEntry }, vault.Reads);
        JsonNode Common(JsonNode body, string list) => body["inputParameters"]![list]!["List"]![0]!["ConnectionDetails_Common"]!;
        foreach (var list in new[] { "ValidStageConfigs", "EditedStageConfigs" }) {
            Assert.Equal(DbPassword, (string)Common(send.Body!, list)["ConnectionPassword"]!);
            Assert.Equal(DbUser, (string)Common(send.Body!, list)["ConnectionUsername"]!);
            // The request as the facade wrote it keeps its placeholders: that is what the reservation hashes.
            Assert.Equal("", (string)Common(r.Body!, list)["ConnectionPassword"]!);
        }
        Assert.DoesNotContain(DbPassword, r.Body!.ToJsonString());
        Assert.Equal(new[] { DbPassword, DbUser }, placed);
        // The page runs the copy with the values, once per pointer.
        var script = PortalCore.StartScript("id1", "https://" + Host, send);
        Assert.Equal(2, script.Split(DbPassword).Length - 1);
        Assert.DoesNotContain(DbPassword, PortalCore.StartScript("id2", "https://" + Host, r));
        // The reservation keeps where each value went and which entry it came from, never a value.
        var record = PortalCore.SecretRefsRecord(r.SecretRefs)!.ToJsonString();
        Assert.Contains(DbEntry, record);
        Assert.DoesNotContain(DbPassword, record);
    }

    [Fact]
    public void ValuesTheRequestCarriedNeverComeBack() {
        var placed = new[] { DbPassword, DbUser };
        var url = "https://" + Host + "/connections/screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnections_RelationalDB_Test_Wrapper";
        var echo = "{\"data\":{\"Out_ConnectionId\":\"00000000-0000-4000-8000-00000000cc01\",\"Detail\":\"Login failed for user 'synthetic_reader' (Synth-Pa55-not-real)\"}}";
        var (ok, state) = PortalCore.ShapeWeb(Page(200, url, echo), Host, true, null, Places.DownloadsDir, placed);
        var answer = PortalCore.MaskAnswer(ok, placed);
        Assert.Equal("accepted", state);
        Assert.DoesNotContain(DbPassword, answer.ToJsonString());
        Assert.DoesNotContain(DbUser, answer.ToJsonString());
        Assert.Equal("00000000-0000-4000-8000-00000000cc01", (string)answer["body"]!["data"]!["Out_ConnectionId"]!);
        Assert.Equal(Host, (string)answer["host"]!);
        // A failed page fetch whose error quotes the value: the uncertain answer's message is masked too.
        var failed = PortalCore.MaskAnswer(PortalCore.ShapeWeb(new JsonObject { ["state"] = "error", ["message"] = "script failed near '" + DbPassword + "'" }, Host, true, null, Places.DownloadsDir, placed).Result, placed);
        Assert.Equal("UNCERTAIN", Code(failed));
        Assert.DoesNotContain(DbPassword, failed.ToJsonString());
        // An answer too large to inline goes to a file already masked.
        var large = new JsonObject();
        PortalCore.Payload(Encoding.UTF8.GetBytes("{\"echo\":\"" + DbPassword + "\",\"pad\":\"" + new string('x', PortalCore.InlineLimit) + "\"}"), "application/json", large, Places.DownloadsDir, placed);
        Assert.DoesNotContain(DbPassword, File.ReadAllText((string)large["bodyFile"]!));
    }

    [Fact]
    public void ShortValuesAreMaskedOnlyAsWholeWords() {
        Assert.Equal("Login failed for user '[REDACTED]'; usage of 4sa1-key", PortalCore.Mask("Login failed for user 'sa'; usage of 4sa1-key", new[] { "sa" }));
        Assert.Equal("x[REDACTED]y", PortalCore.Mask("x" + DbPassword + "y", new[] { DbPassword }));
        Assert.Equal("unchanged", PortalCore.Mask("unchanged", null));
    }

    [Fact]
    public void AnEchoInJsonTextHtmlOrAUrlIsMaskedToo() {
        const string special = "p@ss+w<rd>&\"x'1";
        var vault = new FakeVault(); vault.Entries[DbEntry] = new(DbUser, special);
        var r = PortalCore.ParseWebRequest(DbTestRequest());
        var (send, placed) = PortalCore.PlaceWebSecrets(r, Host, true, vault.Read);
        Assert.Equal(special, (string)send.Body!["inputParameters"]!["ValidStageConfigs"]!["List"]![0]!["ConnectionDetails_Common"]!["ConnectionPassword"]!);
        var forms = new[] { special, System.Net.WebUtility.HtmlEncode(special), Uri.EscapeDataString(special), JsonEncodedText.Encode(special).ToString() };
        var page = "<p>bad password " + forms[1] + "</p><a href=\"/x?p=" + forms[2] + "\">retry</a><script>var s = \"" + forms[3] + "\";</script> raw " + special;
        var answer = new JsonObject();
        PortalCore.Payload(Encoding.UTF8.GetBytes(page), "text/html", answer, Places.DownloadsDir, placed);
        var shown = (string)answer["text"]!;
        foreach (var form in forms) Assert.DoesNotContain(form, shown);
        Assert.Contains("retry", shown);
    }

    [Theory]
    [InlineData("SSAM/ODC3/other.outsystems.dev/DB/SyntheticERP")]
    [InlineData("SSAM/ODC3/" + Host + ".evil.example/DB/SyntheticERP")]
    [InlineData("SSAM/ODC3/" + Host + "/APIClient")]
    [InlineData("SSAM/ODC3/" + Host + "/Portal")]
    [InlineData("SSAM/ODC3/" + Host + "/APIClient/x")]
    [InlineData("SSAM/ODC3/" + Host + "/portal/x")]
    [InlineData("SSAM/ODC3/" + Host + "/DB")]
    [InlineData("SSAM/ODC3/" + Host + "/DB/a/b")]
    [InlineData("SSAM/ODC3/" + Host + "/DB/*")]
    [InlineData("SSAM/O11/" + Host + "/ServiceCenter")]
    public void SecretRefsNameOnlyThisTenantsVaultEntriesAndNeverItsSignIn(string target) {
        var vault = new FakeVault();
        var r = PortalCore.ParseWebRequest(DbTestRequest(Refs(("/inputParameters/ValidStageConfigs/List/0/ConnectionDetails_Common/ConnectionPassword", target, "password"))));
        var refusal = Refused(() => PortalCore.PlaceWebSecrets(r, Host, true, vault.Read));
        Assert.Equal(("NOT_ALLOWED", "secret_ref_target"), (refusal.Code, refusal.Gate));
        Assert.Empty(vault.Reads);
    }

    [Theory]
    [InlineData("[{\"pointer\":\"/inputParameters/ConnectionId\",\"target\":\"@T\",\"field\":\"password\",\"value\":\"x\"}]")]
    [InlineData("[{\"pointer\":\"/inputParameters/ConnectionId\",\"target\":\"@T\",\"field\":\"token\"}]")]
    [InlineData("[{\"pointer\":\"inputParameters/ConnectionId\",\"target\":\"@T\",\"field\":\"password\"}]")]
    [InlineData("[{\"pointer\":\"/inputParameters/ConnectionId\",\"target\":7,\"field\":\"password\"}]")]
    [InlineData("[{\"pointer\":\"/inputParameters/ConnectionId\",\"target\":\"@T\",\"field\":\"password\"},{\"pointer\":\"/inputParameters/ConnectionId\",\"target\":\"@T\",\"field\":\"username\"}]")]
    [InlineData("[\"@T\"]")]
    [InlineData("[]")]
    [InlineData("{}")]
    public void MalformedSecretRefsAreRefusedWhenTheFileIsRead(string refs) {
        Assert.Equal("secret_ref_invalid", Refused(() => PortalCore.ParseWebRequest(DbTestRequest(refs.Replace("@T", DbEntry)))).Gate);
        var api = "{\"method\":\"PATCH\",\"basePath\":\"/api/asset-configurations/v1\",\"path\":\"/x\",\"write\":true,\"body\":{\"value\":\"\"},\"secretRefs\":" + refs.Replace("@T", SettingEntry) + "}";
        Assert.Equal("secret_ref_invalid", Refused(() => PortalCore.ParseApiRequest(api)).Gate);
    }

    [Fact]
    public void SecretRefsNeverPointIntoBodyBase64() {
        var api = "{\"method\":\"PUT\",\"basePath\":\"/api/asset-repository/v1\",\"path\":\"/x\",\"write\":true,\"bodyBase64\":\"AA==\",\"secretRefs\":" + Refs(("/value", SettingEntry, "password")) + "}";
        Assert.Equal("secret_ref_invalid", Refused(() => PortalCore.ParseApiRequest(api)).Gate);
    }

    [Theory]
    [InlineData("/inputParameters/ProviderId")]
    [InlineData("/inputParameters/ValidStageConfigs")]
    [InlineData("/inputParameters/IsEditConnection")]
    [InlineData("/inputParameters/Missing")]
    [InlineData("/inputParameters/ValidStageConfigs/List/1/ConnectionDetails_Common/ConnectionPassword")]
    [InlineData("/inputParameters/ValidStageConfigs/List/01/ConnectionDetails_Common/ConnectionPassword")]
    [InlineData("/inputParameters/ValidStageConfigs/List/-/ConnectionDetails_Common/ConnectionPassword")]
    [InlineData("/versionInfo/moduleVersion")]
    [InlineData("/viewName")]
    [InlineData("/inputParameters")]
    public void SecretRefsGoOnlyIntoEmptyPlaceholdersOfTheScreenData(string pointer) {
        var vault = new FakeVault();
        var r = PortalCore.ParseWebRequest(DbTestRequest(Refs((pointer, DbEntry, "password"))));
        Assert.Equal("secret_ref_invalid", Refused(() => PortalCore.PlaceWebSecrets(r, Host, true, vault.Read)).Gate);
        Assert.Empty(vault.Reads);
    }

    [Fact]
    public async Task SecretRefsGoOnlyWithAWrite() {
        var vault = new FakeVault();
        var page = PortalCore.ParseWebRequest(DbTestRequest()) with { Write = false };
        Assert.Equal("secret_ref_invalid", Refused(() => PortalCore.PlaceWebSecrets(page, Host, false, vault.Read)).Gate);
        var handler = new FakeHandler();
        var search = Api("POST", "/api/asset-repository/v1", "/assets/search", body: JsonNode.Parse("{\"q\":\"\"}")) with { SecretRefs = new[] { new PortalCore.SecretRef("/q", SettingEntry, "password") } };
        var result = await PortalCore.Send(new StudioClient(handler), search, Host, null, Tenants, Places, vault: vault.Read);
        Assert.Equal(("BAD_REQUEST", "secret_ref_invalid"), (Code(result), (string?)result["gate"]));
        Assert.Equal(0, handler.Sends);
        Assert.Empty(vault.Reads);
    }

    [Fact]
    public async Task AMissingOrUnreadableVaultEntrySendsNothingAndReservesNothing() {
        var handler = new FakeHandler();
        var vault = new FakeVault();
        var uuid = Guid.NewGuid().ToString();
        async Task<JsonObject> Attempt(PortalCore.VaultReader? reader) => await PortalCore.Send(new StudioClient(handler), SettingWrite(uuid), Host, null, Tenants, Places, vault: reader);
        var missing = await Attempt(vault.Read);
        Assert.Equal(("BAD_REQUEST", "secret_ref_missing"), (Code(missing), (string?)missing["gate"]));
        vault.Entries[SettingEntry] = new("someone", null);
        Assert.Equal("secret_ref_missing", (string)(await Attempt(vault.Read))["gate"]!);
        vault.Failure = new InvalidOperationException("vault locked");
        Assert.Equal("secret_ref_vault", (string)(await Attempt(vault.Read))["gate"]!);
        Assert.Equal("secret_ref_vault", (string)(await Attempt(null))["gate"]!);
        Assert.Equal(0, handler.Sends);
        // Nothing was reserved, so the same UUID goes once the entry exists.
        Assert.False(Directory.Exists(Places.WritesDir));
        vault.Failure = null; vault.Entries[SettingEntry] = new(null, "Setting-Secret-Value-42");
        Assert.True((bool)(await Attempt(vault.Read))["ok"]!);
        Assert.Equal(1, handler.Sends);
    }

    [Fact]
    public async Task APortalCallWriteSendsTheVaultValueOnceAndRecordsOnlyThePlaceholders() {
        const string secret = "Setting-Secret-Value-42";
        var vault = new FakeVault(); vault.Entries[SettingEntry] = new(null, secret);
        var handler = new FakeHandler { Answer = (r, _) => Task.FromResult(Json(r, 200, "{\"note\":\"stored " + secret + "\",\"key\":\"synthetic-setting-key-1\"}")) };
        var uuid = Guid.NewGuid().ToString();
        var request = SettingWrite(uuid);
        var result = await PortalCore.Send(new StudioClient(handler), request, Host, "user@example.com", Tenants, Places, vault: vault.Read);
        Assert.True((bool)result["ok"]!);
        Assert.Equal(1, handler.Sends);
        Assert.Equal(secret, (string)JsonNode.Parse(handler.Bodies[0]!)!["settings"]![0]!["value"]!);
        Assert.DoesNotContain(secret, result.ToJsonString());
        Assert.Equal("synthetic-setting-key-1", (string)result["body"]!["key"]!);
        // The facade's body keeps its placeholder; the reservation hashes it and names the entry, never the value.
        Assert.Equal("", (string)request.Body!["settings"]![0]!["value"]!);
        var record = File.ReadAllText(Path.Combine(Places.WritesDir, uuid + ".json"));
        Assert.DoesNotContain(secret, record);
        Assert.Contains(Sha256Hex(request.Body.ToJsonString()), record);
        Assert.Contains(SettingEntry, record);
        Assert.DoesNotContain(secret, File.ReadAllText(Path.Combine(Places.WritesDir, uuid + ".outcome.json")));

        // A send that fails with the value in its error is uncertain and still never shows it.
        handler.Answer = (_, _) => throw new HttpRequestException("reset while sending " + secret);
        var uncertain = await PortalCore.Send(new StudioClient(handler), SettingWrite(Guid.NewGuid().ToString()), Host, null, Tenants, Places, vault: vault.Read);
        Assert.Equal("UNCERTAIN", Code(uncertain));
        Assert.DoesNotContain(secret, uncertain.ToJsonString());
    }

    // ---- Portal page routes
    private static PortalCore.WebRequest Web(string method, string path, bool write = false) =>
        new("op", method, path, null, write, write ? Guid.NewGuid().ToString() : null, write ? new string('b', 64) : null, null);

    [Fact]
    public void KnownReadsGoWithoutWordsAndEverythingElseOnlyAsAWrite() {
        Assert.False(PortalCore.CheckWebRoute(Web("POST", "/monitoring/screenservices/monitoring/logs/logs/DataActionLogSearch")));
        Assert.Equal("NOT_ALLOWED", Refused(() => PortalCore.CheckWebRoute(Web("POST", "/connections/screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB"))).Code);
        Assert.True(PortalCore.CheckWebRoute(Web("POST", "/connections/screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB", write: true)));
        Assert.False(PortalCore.CheckWebRoute(Web("GET", "/monitoring/moduleservices/moduleversioninfo")));
        Assert.False(PortalCore.CheckWebRoute(Web("GET", "/monitoring/")));
        Assert.False(PortalCore.CheckWebRoute(Web("GET", "/monitoring/scripts/monitoring.logs.logs.mvc.js?abc123")));
    }

    [Theory]
    [InlineData("POST", "/authentication/screenservices/authentication/UnifiedAuthentication/login/ActionProcessCognitoToken", "NOT_ALLOWED")]
    [InlineData("POST", "/connections/screenservices/connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetDecryptedSecrets", "NOT_ALLOWED")]
    [InlineData("GET", "/api/identity/v1/users", "NOT_ALLOWED")]
    [InlineData("GET", "/monitoring/other/path", "NOT_ALLOWED")]
    [InlineData("POST", "/monitoring/scripts/x.js", "BAD_REQUEST")]
    [InlineData("GET", "/monitoring/screenservices/monitoring/logs/logs/DataActionLogSearch", "BAD_REQUEST")]
    [InlineData("POST", "/monitoring/screenservices/agents/Datasets/Dataset_CreateForm/DataActionGetAgenticApps", "BAD_REQUEST")]
    [InlineData("POST", "/monitoring/screenservices/../../authentication/x/y/z", "BAD_REQUEST")]
    [InlineData("GET", "https://evil.example/monitoring/", "BAD_REQUEST")]
    [InlineData("GET", "//evil.example/monitoring/", "BAD_REQUEST")]
    public void PortalRoutesOutsideTheRulesAreRefused(string method, string path, string code) =>
        Assert.Equal(code, Refused(() => PortalCore.CheckWebRoute(Web(method, path, write: true))).Code);

    [Fact]
    public void ThePageScriptEmbedsValuesAsJsonAndChecksOriginAndCsrfBeforeSending() {
        var request = Web("POST", "/monitoring/screenservices/monitoring/logs/logs/DataActionLogSearch") with { Body = JsonNode.Parse("{\"q\":\"\\\"; alert(1); //\"}") };
        var script = PortalCore.StartScript("id1", "https://" + Host, request);
        Assert.DoesNotContain("\"; alert(1)", script);
        Assert.Contains("location.origin !== origin", script);
        Assert.Contains("reason: 'csrf'", script);
        Assert.Contains("redirect: 'manual'", script);
        Assert.True(script.IndexOf("location.origin !== origin", StringComparison.Ordinal) < script.IndexOf("fetch(", StringComparison.Ordinal));
        Assert.Contains("\"id1\"", PortalCore.PollScript("id1"));
    }

    private static JsonObject Page(int status, string url, string text, string type = "basic", string contentType = "application/json; charset=utf-8") =>
        new() { ["state"] = "done", ["status"] = status, ["type"] = type, ["url"] = url, ["contentType"] = contentType, ["text"] = text };

    [Fact]
    public void PageAnswersAreShapedAndRedacted() {
        var url = "https://" + Host + "/connections/screenservices/connections/Connections/connection/DataActionGetSettings?x=1";
        var (ok, state) = PortalCore.ShapeWeb(Page(200, url, "{\"data\":{\"Password\":\"pw\",\"Server\":\"db\"}}"), Host, false, null, Places.DownloadsDir);
        Assert.Equal("read", state);
        Assert.Equal("studio-web", (string)ok["source"]!);
        Assert.Equal("db", (string)ok["body"]!["data"]!["Server"]!);
        Assert.DoesNotContain("pw", ok.ToJsonString());
        Assert.Equal("https://" + Host + "/connections/screenservices/connections/Connections/connection/DataActionGetSettings", (string)ok["finalUrl"]!);

        // Module scripts and pages (metadata discovery) come back as text, redacted.
        var script = PortalCore.ShapeWeb(Page(200, "https://" + Host + "/monitoring/scripts/a.js?h1", "define(\"screenservices/monitoring/x/y/DataActionZ\",\"api1\"); var h = 'Bearer abc123';", contentType: "application/javascript"), Host, false, null, Places.DownloadsDir).Result;
        Assert.Null(script["body"]);
        Assert.Contains("screenservices/monitoring/x/y/DataActionZ", (string)script["text"]!);
        Assert.DoesNotContain("abc123", (string)script["text"]!);

        Assert.Equal("WEB_SIGN_IN_REQUIRED", Code(PortalCore.ShapeWeb(Page(0, "", "", type: "opaqueredirect"), Host, false, null, Places.DownloadsDir).Result));
        Assert.Equal("WEB_SIGN_IN_REQUIRED", Code(PortalCore.ShapeWeb(Page(401, url, "{}"), Host, false, null, Places.DownloadsDir).Result));
        Assert.Equal("HOST_MISMATCH", Code(PortalCore.ShapeWeb(Page(200, "https://id.example/login", "{}"), Host, false, null, Places.DownloadsDir).Result));
        Assert.Equal("REMOTE_ERROR", Code(PortalCore.ShapeWeb(new JsonObject { ["state"] = "error", ["message"] = "Failed to fetch" }, Host, false, null, Places.DownloadsDir).Result));
    }

    [Fact]
    public void APageWriteWithoutAKnownAnswerIsUncertain() {
        var url = "https://" + Host + "/connections/screenservices/connections/x/y/ActionSave";
        Assert.Equal("UNCERTAIN", Code(PortalCore.ShapeWeb(new JsonObject { ["state"] = "missing" }, Host, true, null, Places.DownloadsDir).Result));
        Assert.Equal("UNCERTAIN", Code(PortalCore.ShapeWeb(null, Host, true, null, Places.DownloadsDir).Result));
        Assert.Equal("UNCERTAIN", Code(PortalCore.ShapeWeb(Page(0, "", "", type: "opaqueredirect"), Host, true, null, Places.DownloadsDir).Result));
        Assert.Equal("UNCERTAIN", Code(PortalCore.ShapeWeb(Page(500, url, "{}"), Host, true, null, Places.DownloadsDir).Result));
        Assert.Equal("UNCERTAIN", Code(PortalCore.ShapeWeb(Page(200, "https://elsewhere.example/x", "{}"), Host, true, null, Places.DownloadsDir).Result));
        var (accepted, state) = PortalCore.ShapeWeb(Page(200, url, "{\"data\":{}}"), Host, true, null, Places.DownloadsDir);
        Assert.True((bool)accepted["ok"]!);
        Assert.Equal("accepted", state);
    }

    [Fact]
    public void ThePageIsSignedInOnlyOnTheTenantOriginWithACsrfToken() {
        JsonObject Probe(string origin, string path, bool csrf) => new() { ["origin"] = origin, ["path"] = path, ["csrf"] = csrf };
        Assert.True(PortalCore.PageSignedIn(Probe("https://" + Host, "/apps", true), Host));
        Assert.False(PortalCore.PageSignedIn(Probe("https://" + Host, "/apps", false), Host));
        Assert.False(PortalCore.PageSignedIn(Probe("https://" + Host, "/authentication/login", true), Host));
        Assert.False(PortalCore.PageSignedIn(Probe("https://login.example", "/", true), Host));
        Assert.False(PortalCore.PageSignedIn(null, Host));
    }
}
