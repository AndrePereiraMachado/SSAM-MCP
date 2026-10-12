using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.PrivateTransport;
using Xunit;

public sealed class PortalApiClientSecretTests {
    private const string Host="personal-test.outsystems.dev", User="user@example.test", Secret="SyntheticClientSecret0123456789", ClientId="syntheticclientid1234";
    private static readonly string Hash=new('a',64);
    [Fact]
    public void WindowsVaultFixtureRoundTripRefusesOverwriteAndCleansItsOwnEntry() {
        if (!OperatingSystem.IsWindows()) return;
        var target=PortalApiClientSecret.Target("vault-proof.example.test",Guid.NewGuid().ToString());
        Assert.Null(PortalVault.Read(target));
        try {
            Assert.True(PortalVault.StoreNewApiClient(target,ClientId,Secret));
            Assert.False(PortalVault.StoreNewApiClient(target,"changed-client","changed-synthetic-secret"));
            var saved=PortalVault.Read(target);Assert.Equal(ClientId,saved?.UserName);Assert.Equal(Secret,saved?.Secret);
        } finally { Assert.True(PortalVault.DeleteApiClientFixture(target)); }
        Assert.Null(PortalVault.Read(target));
        foreach(var forbidden in new[]{"SSAM/ODC3/"+Host+"/APIClient","SSAM/ODC3/"+Host+"/Portal","SSAM/ODC3/"+Host+"/APIClientFixture/not-a-uuid"}) {
            Assert.False(PortalVault.StoreNewApiClient(forbidden,ClientId,Secret));
            Assert.False(PortalVault.DeleteApiClientFixture(forbidden));
        }
    }
    private static JsonObject Input() => new() {
        ["operationId"]=PortalApiClientSecret.Operation,["method"]="POST",["path"]=PortalApiClientSecret.Path,["write"]=true,
        ["operationUuid"]=Guid.NewGuid().ToString(),["authorizeSha256"]=Hash,["confirmTenant"]=Host,
        ["body"]=new JsonObject {
            ["inputParameters"]=new JsonObject { ["OIDCClientCreate"]=new JsonObject {
                ["Name"]="SSAMApiClientProof20261010",["Description"]="SSAM disposable permission proof",
                ["SecretExpiresAt"]=DateTimeOffset.UtcNow.AddHours(1).UtcDateTime.ToString("o"),["IsActive"]=true,
                ["IsSendSecretExpiryEmail"]=false,["Permissions"]=new JsonObject { ["List"]=new JsonArray() } } },
            ["screenData"]=new JsonObject { ["variables"]=new JsonObject() },["clientVariables"]=new JsonObject() }
    };
    private static PrivateHttpContext Context() {
        var now=DateTimeOffset.UtcNow;
        var json=new JsonObject { ["schema"]="ssam-private-http-context/1",["requestSha256"]=Hash,["host"]=Host,["principal"]=User,
            ["issuedAt"]=now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),["expiresAt"]=now.AddSeconds(30).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),["cookie"]="session=synthetic-cookie",["csrf"]="" };
        return PrivateHttpContext.Parse(Encoding.UTF8.GetBytes(json.ToJsonString()),Hash,Host,User,now);
    }
    private static JsonObject Response() => new() {
        ["data"]=new JsonObject { ["Key"]=Guid.NewGuid().ToString(),["ClientId"]=ClientId,["ClientSecret"]=Secret,["UnexpectedEcho"]=Secret },
        ["UnexpectedTopLevel"]=Secret };
    private sealed class Handler(JsonObject native, int status=200, bool foreign=false) : HttpMessageHandler {
        public int Sends;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) {
            Sends++;
            var response=new HttpResponseMessage((HttpStatusCode)status) { RequestMessage=foreign?new(HttpMethod.Post,"https://foreign.example/test"):request,
                Content=new StringContent(native.ToJsonString(),Encoding.UTF8,"application/json") };
            response.Headers.TryAddWithoutValidation("x-request-id",Secret);
            response.Headers.TryAddWithoutValidation("Location","https://example.test/"+Secret);
            return Task.FromResult(response);
        }
    }
    [Theory]
    [InlineData("valid")]
    [InlineData("writer-false")]
    [InlineData("writer-throws")]
    [InlineData("missing-secret")]
    [InlineData("invalid-key")]
    [InlineData("remote-exception")]
    [InlineData("version-drift")]
    [InlineData("foreign-response")]
    [InlineData("http400")]
    [InlineData("http500")]
    public async Task OnlyTheVaultWriterReceivesTheOneTimeSecret(string variant) {
        var dir=Path.Combine(Path.GetTempPath(),"ssam-api-client-"+Guid.NewGuid());var native=Response();var input=Input();
        if(variant=="missing-secret")((JsonObject)native["data"]!).Remove("ClientSecret");
        if(variant=="invalid-key")native["data"]!["Key"]="invalid";
        if(variant=="remote-exception")native["exception"]=new JsonObject { ["message"]=Secret };
        if(variant=="version-drift")native["versionInfo"]=new JsonObject { ["hasApiVersionChanged"]=true };
        var status=variant=="http400"?400:variant=="http500"?500:200;
        var handler=new Handler(native,status,variant=="foreign-response");using var client=new HttpClient(handler);int writes=0;
        var request=PortalCore.ParseWebRequest(input.ToJsonString());
        bool Store(string target,string id,string secret) {
            writes++;Assert.Equal(PortalApiClientSecret.Target(Host,request.OperationUuid!),target);Assert.Equal(ClientId,id);Assert.Equal(Secret,secret);
            if(variant=="writer-throws")throw new InvalidOperationException(Secret);
            return variant!="writer-false";
        }
        try {
            var places=new PortalCore.Places(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads"));
            var result=await PortalPrivateHttp.Send(client,request,Context(),Host,User,PortalCore.ReadTenants(null),places,_=>null,CancellationToken.None,apiClientVaultWriter:Store);
            Assert.Equal(variant=="valid",(bool?)result["ok"]==true);Assert.Equal(1,handler.Sends);
            Assert.Equal(variant is "valid" or "writer-false" or "writer-throws"?1:0,writes);
            Assert.DoesNotContain(Secret,result.ToJsonString());Assert.DoesNotContain(ClientId,result.ToJsonString());
            if(variant is "valid" or "writer-false" or "writer-throws") {
                var proof=result["body"]?["data"]?["ApiClientProof"];
                Assert.Equal((string?)native["data"]?["Key"],(string?)proof?["key"]);
                Assert.Equal(variant=="valid",(bool?)proof?["vaultStored"]);Assert.False((bool?)proof?["rawValueExposed"]);
            }
            if(variant!="valid"&&variant!="http400")Assert.Equal("UNCERTAIN",(string?)result["code"]);
            foreach(var file in Directory.GetFiles(dir,"*",SearchOption.AllDirectories)) {
                Assert.DoesNotContain(Secret,File.ReadAllText(file));Assert.DoesNotContain(ClientId,File.ReadAllText(file));
            }
            var replay=await PortalPrivateHttp.Send(client,request,Context(),Host,User,PortalCore.ReadTenants(null),places,_=>null,CancellationToken.None,apiClientVaultWriter:Store);
            Assert.False((bool?)replay["ok"]);Assert.Equal(1,handler.Sends);
        } finally { if(Directory.Exists(dir))Directory.Delete(dir,true); }
    }
    [Theory]
    [InlineData("wrong-name")]
    [InlineData("notification")]
    [InlineData("permission")]
    [InlineData("inactive")]
    [InlineData("expiry-too-far")]
    [InlineData("expiry-expired")]
    [InlineData("extra-input")]
    [InlineData("wrong-operation")]
    [InlineData("writer-missing")]
    [InlineData("vault-existing")]
    public async Task UnsafeOrUnavailablePrivateCaptureNeverCreatesAClient(string variant) {
        var input=Input();var create=input["body"]!["inputParameters"]!["OIDCClientCreate"]!;
        if(variant=="wrong-name")create["Name"]="ExistingBusinessClient";
        if(variant=="notification")create["IsSendSecretExpiryEmail"]=true;
        if(variant=="permission")create["Permissions"]!["List"]!.AsArray().Add(new JsonObject { ["Name"]="ManageOrganization" });
        if(variant=="inactive")create["IsActive"]=false;
        if(variant=="expiry-too-far")create["SecretExpiresAt"]=DateTimeOffset.UtcNow.AddDays(3).UtcDateTime.ToString("o");
        if(variant=="expiry-expired")create["SecretExpiresAt"]=DateTimeOffset.UtcNow.AddHours(-1).UtcDateTime.ToString("o");
        if(variant=="extra-input")input["body"]!["inputParameters"]!["Unexpected"]=true;
        if(variant=="wrong-operation")input["operationId"]="other.create";
        var handler=new Handler(Response());using var client=new HttpClient(handler);var dir=Path.Combine(Path.GetTempPath(),"ssam-api-client-refused-"+Guid.NewGuid());
        try {
            var result=await PortalPrivateHttp.Send(client,PortalCore.ParseWebRequest(input.ToJsonString()),Context(),Host,User,PortalCore.ReadTenants(null),
                new(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads")),_=>variant=="vault-existing"?new(ClientId,Secret):null,CancellationToken.None,
                apiClientVaultWriter:variant=="writer-missing"?null:(_,_,_)=>true);
            Assert.False((bool?)result["ok"]);Assert.False((bool?)result["sent"]);Assert.Equal(0,handler.Sends);
            Assert.False(Directory.Exists(dir));Assert.DoesNotContain(Secret,result.ToJsonString());
        } finally { if(Directory.Exists(dir))Directory.Delete(dir,true); }
    }
}
