using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.PrivateTransport;
using Xunit;

public sealed class PortalPrivateHttpTests {
    [Theory]
    [InlineData("valid")]
    [InlineData("hash-drift")]
    [InlineData("size-drift")]
    [InlineData("wrong-pointer")]
    [InlineData("missing-proof")]
    public async Task VaultBinaryIsBoundBeforeSendAndItsBytesNeverEnterReceipts(string variant) {
        var dir=Path.Combine(Path.GetTempPath(),"vault-binary-"+Guid.NewGuid());
        var bytes=Encoding.UTF8.GetBytes("synthetic private binary content");var encoded=Convert.ToBase64String(bytes);
        var sha=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var id=Guid.NewGuid().ToString();var objectUri="https://plat-test.s3.us-east-1.amazonaws.com/tenants/uploads/"+Guid.NewGuid();
        var signed=objectUri+"?X-Amz-Date="+DateTimeOffset.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'")+"&X-Amz-Expires=600&X-Amz-Signature=vault-binary-private-signature";
        var input=new JsonObject{["operationId"]="mobileExtensibility.uploadFile",["method"]="POST",["path"]="/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/ActionFileUpload_Wrapper",["write"]=true,["operationUuid"]=id,["authorizeSha256"]=Hash,["confirmTenant"]=Host,
            ["body"]=new JsonObject{["inputParameters"]=new JsonObject{["FileContent"]=""}},
            ["secretRefs"]=new JsonArray(new JsonObject{["pointer"]=variant=="wrong-pointer"?"/inputParameters/Other":"/inputParameters/FileContent",["target"]="SSAM/ODC3/"+Host+"/Setting/OwnFile",["field"]="password"}),
            ["mobileExpectedContent"]=new JsonObject{["sha256"]=variant=="hash-drift"?new string('0',64):sha,["byteLength"]=variant=="size-drift"?bytes.Length+1:bytes.Length}};
        if(variant=="missing-proof")input.Remove("mobileExpectedContent");
        var handler=new Handler { Answer=async r=>{var body=JsonNode.Parse(await r.Content!.ReadAsStringAsync());Assert.Equal(encoded,(string?)body?["inputParameters"]?["FileContent"]);return new HttpResponseMessage(HttpStatusCode.OK){RequestMessage=r,Content=new StringContent(new JsonObject{["data"]=new JsonObject{["DownloadURL"]=signed}}.ToJsonString(),Encoding.UTF8,"application/json")};}};
        using var client=new HttpClient(handler);
        try {
            var result=await PortalPrivateHttp.Send(client,PortalCore.ParseWebRequest(input.ToJsonString()),Parse(Context()),Host,User,PortalCore.ReadTenants(null),new(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads")),_=>new PortalCore.VaultEntry("setting",encoded),CancellationToken.None,()=>new HttpClient(new MobileDownload(bytes)));
            Assert.Equal(variant=="valid",(bool?)result["ok"]);Assert.Equal(variant=="valid"?1:0,handler.Sends);
            if(variant=="valid"){Assert.Equal(sha,(string?)result["body"]?["data"]?["UploadProof"]?["contentSha256"]);Assert.True((bool?)result["body"]?["data"]?["UploadProof"]?["contentVerified"]);}
            Assert.DoesNotContain(encoded,result.ToJsonString());Assert.DoesNotContain("vault-binary-private-signature",result.ToJsonString());
            if(Directory.Exists(dir))foreach(var f in Directory.GetFiles(dir,"*",SearchOption.AllDirectories)){Assert.DoesNotContain(encoded,File.ReadAllText(f));Assert.DoesNotContain("vault-binary-private-signature",File.ReadAllText(f));}
        } finally { if(Directory.Exists(dir))Directory.Delete(dir,true); }
    }
    private const string Host = "personal-test.outsystems.dev", User = "user@example.test";
    private const string Cookie = "session=fixture-private-cookie", Csrf = "fixture-private-csrf", Password = "fixture-database-password";
    private static readonly string Hash = new('a', 64);
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-08T18:00:00Z");
    private static JsonObject Context() => new() {
        ["schema"] = "ssam-private-http-context/1", ["requestSha256"] = Hash, ["host"] = Host,
        ["principal"] = User, ["issuedAt"] = "2026-10-08T18:00:00.000Z", ["expiresAt"] = "2026-10-08T18:00:30.000Z",
        ["cookie"] = Cookie, ["csrf"] = Csrf
    };
    private static PrivateHttpContext Parse(JsonObject context) => PrivateHttpContext.Parse(Encoding.UTF8.GetBytes(context.ToJsonString()), Hash, Host, User, Now);

    [Fact]
    public void ContextMatchesItsRequestAndNeverPrintsCredentials() {
        var value = Parse(Context());
        Assert.Equal(Cookie, value.Cookie);
        Assert.DoesNotContain(Cookie, value.ToString());
        Assert.DoesNotContain(Csrf, value.ToString());
    }
    [Theory]
    [InlineData("host", "other.outsystems.dev")]
    [InlineData("principal", "other@example.test")]
    [InlineData("requestSha256", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]
    [InlineData("expiresAt", "2026-10-08T18:00:00.000Z")]
    [InlineData("expiresAt", "2026-10-08T18:01:00.000Z")]
    [InlineData("issuedAt", "2026-10-08T18:00:10.000Z")]
    [InlineData("cookie", "private\r\nInjected: value")]
    [InlineData("csrf", "private\nvalue")]
    [InlineData("extra", "private")]
    public void InvalidContextIsRefusedWithoutValues(string field, string value) {
        var context = Context(); context[field] = value;
        var error = Assert.Throws<InvalidOperationException>(() => Parse(context));
        Assert.DoesNotContain(value, error.Message);
    }
    [Fact]
    public async Task CurrentUserPipeReadsAFramedContext() {
        if (!OperatingSystem.IsWindows()) return;
        var id = Guid.NewGuid().ToString();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        // Receive uses current time; generate a fresh, valid context.
        var context = Context(); var now = DateTimeOffset.UtcNow;
        context["issuedAt"] = now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        context["expiresAt"] = now.AddSeconds(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        var receive = PrivateHttpContext.Receive(id, Hash, Host, User, timeout.Token);
        await using var pipe = new System.IO.Pipes.NamedPipeClientStream(".", PrivateHttpContext.PipeName(id), System.IO.Pipes.PipeDirection.Out);
        await pipe.ConnectAsync(timeout.Token);
        var bytes = Encoding.UTF8.GetBytes(context.ToJsonString());
        var prefix = new byte[4]; System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(prefix, bytes.Length);
        await pipe.WriteAsync(prefix, timeout.Token); await pipe.WriteAsync(bytes, timeout.Token); await pipe.FlushAsync(timeout.Token);
        Assert.Equal(Cookie, (await receive).Cookie);
    }

    private sealed class Handler : HttpMessageHandler {
        internal int Sends;
        internal Func<HttpRequestMessage, Task<HttpResponseMessage>> Answer = r => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            RequestMessage = r, Content = new StringContent("{\"data\":{\"echo\":\"" + Password + "\",\"sessionEcho\":\"fixture-private-cookie\"}}", Encoding.UTF8, "application/json")
        });
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
            Sends++;
            Assert.Equal(Cookie, request.Headers.GetValues("Cookie").Single());
            return Answer(request);
        }
    }
    private static PortalCore.WebRequest Request() => PortalCore.ParseWebRequest(new JsonObject {
        ["method"] = "POST", ["path"] = "/connections/screenservices/connections/Connections/connection/ActionConnection_Delete_Wrapper",
        ["write"] = true, ["operationUuid"] = Guid.NewGuid().ToString(), ["authorizeSha256"] = Hash, ["confirmTenant"] = Host,
        ["body"] = new JsonObject { ["inputParameters"] = new JsonObject { ["Password"] = "" } },
        ["secretRefs"] = new JsonArray(new JsonObject { ["pointer"] = "/inputParameters/Password", ["target"] = "SSAM/ODC3/" + Host + "/DB/Fixture", ["field"] = "password" })
    }.ToJsonString());
    private sealed class MobileDownload(byte[] bytes) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            Assert.Null(request.Headers.Authorization);Assert.False(request.Headers.Contains("Cookie"));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {RequestMessage=request,Content=new ByteArrayContent(bytes)});
        }
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PrivateMobileUploadVerifiesContentAndNeverJournalsSignedUri(bool secret) {
        var dir=Path.Combine(Path.GetTempPath(),"ssam-mobile-private-"+Guid.NewGuid());
        var objectUri="https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/"+Guid.NewGuid();
        var signed=objectUri+"?X-Amz-Date="+DateTimeOffset.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'")+"&X-Amz-Expires=600&X-Amz-Signature=private-mobile-url-test";
        var content=Encoding.UTF8.GetBytes("synthetic mobile proof");var id=Guid.NewGuid().ToString();
        var handler=new Handler {Answer=r=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){RequestMessage=r,Content=new StringContent(new JsonObject{["data"]=new JsonObject{["DownloadURL"]=signed}}.ToJsonString(),Encoding.UTF8,"application/json")})};
        using var client=new HttpClient(handler);
        var request=PortalCore.ParseWebRequest(new JsonObject{["operationId"]="mobileExtensibility.uploadFile",["method"]="POST",["path"]="/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/ActionFileUpload_Wrapper",["write"]=true,["operationUuid"]=id,["authorizeSha256"]=Hash,["confirmTenant"]=Host,["body"]=new JsonObject{["inputParameters"]=new JsonObject{["FileContent"]=Convert.ToBase64String(content)}}}.ToJsonString());
        try{
            var result=await PortalPrivateHttp.Send(client,request,Parse(Context()),Host,User,PortalCore.ReadTenants(null),new(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads")),_=>null,CancellationToken.None,()=>new HttpClient(new MobileDownload(content)));
            Assert.True((bool?)result["ok"]);Assert.True((bool?)result["body"]?["data"]?["UploadProof"]?["contentVerified"]);
            Assert.Equal(objectUri,(string?)result["body"]?["data"]?["UploadProof"]?["objectUri"]);
            Assert.Equal(signed,PortalMobileUpload.Resolve(id,Host,User,objectUri,DateTimeOffset.UtcNow,false));
            var saveId=Guid.NewGuid().ToString();
            var saveRequest=PortalCore.ParseWebRequest(new JsonObject{["operationId"]="mobileExtensibility.saveFile",["method"]="POST",["path"]="/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/ActionExtensbilitySettingSave_Wrapper",["write"]=true,["operationUuid"]=saveId,["authorizeSha256"]=Hash,["confirmTenant"]=Host,["mobileUploadOperationUuid"]=id,["mobileObjectUri"]=objectUri,["body"]=new JsonObject{["inputParameters"]=new JsonObject{["RequiresDecoding"]=false,["ExtensibilitySettingInfo"]=new JsonObject{["Setting"]=new JsonObject{["DataType"]="BinaryUrl",["IsSecret"]=false,["ValueOrigin"]="Override",["Value"]=""}}}}}.ToJsonString());
            saveRequest.Body!["inputParameters"]!["ExtensibilitySettingInfo"]!["Setting"]!["IsSecret"]=secret;
            handler.Answer=async r=>{
                var body=JsonNode.Parse(await r.Content!.ReadAsStringAsync());Assert.Equal(signed,(string?)body?["inputParameters"]?["ExtensibilitySettingInfo"]?["Setting"]?["Value"]);
                Assert.True(File.Exists(Path.Combine(dir,"writes",saveId+".json")));
                Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,objectUri,DateTimeOffset.UtcNow,false));
                return new HttpResponseMessage(HttpStatusCode.OK){RequestMessage=r,Content=new StringContent("{\"data\":{}}",Encoding.UTF8,"application/json")};
            };
            var saved=await PortalPrivateHttp.Send(client,saveRequest,Parse(Context()),Host,User,PortalCore.ReadTenants(null),new(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads")),_=>null,CancellationToken.None);
            Assert.True((bool?)saved["ok"]);Assert.Equal("",(string?)saveRequest.Body?["inputParameters"]?["ExtensibilitySettingInfo"]?["Setting"]?["Value"]);
            Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,objectUri,DateTimeOffset.UtcNow,false));
            var replay=await PortalPrivateHttp.Send(client,saveRequest,Parse(Context()),Host,User,PortalCore.ReadTenants(null),new(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads")),_=>null,CancellationToken.None);Assert.False((bool?)replay["ok"]);
            Assert.DoesNotContain("private-mobile-url-test",result.ToJsonString());
            foreach(var file in Directory.GetFiles(dir,"*",SearchOption.AllDirectories)){
                Assert.DoesNotContain("private-mobile-url-test",File.ReadAllText(file));Assert.DoesNotContain("X-Amz-Signature",File.ReadAllText(file));
            }
            Assert.Equal(2,handler.Sends);
        }finally{if(Directory.Exists(dir))Directory.Delete(dir,true);}
    }
    [Fact]
    public async Task CredentialsAreResolvedAtNativeSendRedactedAndUuidCannotBeReplayed() {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-private-test-" + Guid.NewGuid());
        var places = new PortalCore.Places(Path.Combine(dir, "writes"), Path.Combine(dir, "downloads"));
        var handler = new Handler(); using var client = new HttpClient(handler);
        var request = Request(); int reads = 0;
        PortalCore.VaultEntry? Vault(string _) { reads++; return new PortalCore.VaultEntry("fixture-user", Password); }
        try {
            var result = await PortalPrivateHttp.Send(client, request, Parse(Context()), Host, User, PortalCore.ReadTenants(null), places, Vault, CancellationToken.None);
            Assert.True((bool?)result["ok"]);
            Assert.Equal(1, handler.Sends); Assert.Equal(1, reads);
            Assert.DoesNotContain(Password, result.ToJsonString()); Assert.DoesNotContain("fixture-private-cookie", result.ToJsonString());
            foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) {
                Assert.DoesNotContain(Password, File.ReadAllText(file)); Assert.DoesNotContain(Cookie, File.ReadAllText(file));
            }
            var retry = await PortalPrivateHttp.Send(client, request, Parse(Context()), Host, User, PortalCore.ReadTenants(null), places, Vault, CancellationToken.None);
            Assert.Equal("retry_refused", (string?)retry["gate"]); Assert.Equal(1, handler.Sends);
        } finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }
    [Theory]
    [InlineData(302, "application/json")]
    [InlineData(200, "application/octet-stream")]
    [InlineData(500, "application/json")]
    public async Task RedirectUnknownBodyAndServerFailuresStayUncertain(int status, string contentType) {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-private-test-" + Guid.NewGuid());
        var handler = new Handler { Answer = r => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) {
            RequestMessage = r, Content = new StringContent("{}", Encoding.UTF8, contentType)
        }) };
        using var client = new HttpClient(handler);
        try {
            var result = await PortalPrivateHttp.Send(client, Request(), Parse(Context()), Host, User, PortalCore.ReadTenants(null),
                new(Path.Combine(dir, "writes"), Path.Combine(dir, "downloads")), _ => new("user", Password), CancellationToken.None);
            Assert.Equal("UNCERTAIN", (string?)result["code"]); Assert.True((bool?)result["sent"]); Assert.Equal(1, handler.Sends);
        } finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task AuthenticatedBrokerWithoutCsrfDoesNotInventABrowserToken() {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-private-test-" + Guid.NewGuid());
        var handler = new Handler { Answer = r => {
            Assert.False(r.Headers.Contains("x-csrftoken"));
            Assert.Equal("https://" + Host, r.Headers.GetValues("Origin").Single());
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = r, Content = new StringContent("{\"data\":{}}", Encoding.UTF8, "application/json") });
        } };
        var context = Context(); context["csrf"] = "";
        using var client = new HttpClient(handler);
        try {
            var result = await PortalPrivateHttp.Send(client, Request(), Parse(context), Host, User, PortalCore.ReadTenants(null),
                new(Path.Combine(dir, "writes"), Path.Combine(dir, "downloads")), _ => new("user", Password), CancellationToken.None);
            Assert.True((bool?)result["ok"]); Assert.Equal(1, handler.Sends);
        } finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }
}
