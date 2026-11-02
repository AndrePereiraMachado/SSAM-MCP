using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class MacPrivateBackendTests
{
    sealed class Store : IMacPrivateStore {
        internal Dictionary<string,JsonObject> Items = new();
        public JsonObject? Read(string name) => Items.TryGetValue(name,out var v) ? (JsonObject)v.DeepClone() : null;
        public void Write(string name,JsonObject value) => Items[name]=(JsonObject)value.DeepClone();
        public void Delete(string name) => Items.Remove(name);
        public IReadOnlyList<MacStoredItem> List(string prefix) => Items.Keys.Where(k=>k.StartsWith(prefix,StringComparison.Ordinal)).Select(k=>new MacStoredItem(k,DateTimeOffset.UtcNow)).ToArray();
    }
    static JsonObject Envelope(string mode,string family="credential",string scope="aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb") => MacPrivateBackend.Envelope(family,mode,scope,"tenant.example",new JsonObject { ["service"]="service-center",["auth"]="credential" },Path.GetTempPath(),Path.GetTempPath());
    static MacDialogRunner Dialog(bool remember) => async (model,accept,ct,visible) => { visible?.Invoke(); var values=new JsonObject { ["username"]="synthetic@example.invalid",["password"]="synthetic-password",["remember"]=remember }; Assert.Null(await accept(values)); return new(true,values); };
    [Theory]
    [InlineData("credential")]
    [InlineData("users")]
    public async Task RememberSurvivesNewBackendCallOnlyWithinSameScope(string family) {
        var store=new Store(); var result=await MacPrivateBackend.ExecuteAsync(Envelope("prompt",family),default,testStore:store,testDialog:Dialog(true));
        Assert.True(result["remembered"]!.GetValue<bool>()); Assert.Null(result["privateCredential"]);
        var status=await MacPrivateBackend.ExecuteAsync(Envelope("status",family),default,testStore:store);
        Assert.True(status["available"]!.GetValue<bool>());
        var other=await MacPrivateBackend.ExecuteAsync(Envelope("status",family,"ccccccccccccccccdddddddddddddddd"),default,testStore:store);
        Assert.False(other["available"]!.GetValue<bool>());
    }
    [Theory]
    [InlineData("credential")]
    [InlineData("users")]
    public async Task UncheckedReturnsPrivateCredentialWithoutReplacingSavedValue(string family) {
        var store=new Store(); await MacPrivateBackend.ExecuteAsync(Envelope("prompt",family),default,testStore:store,testDialog:Dialog(true));
        var original=store.Items.Single().Value.ToJsonString();
        var result=await MacPrivateBackend.ExecuteAsync(Envelope("prompt",family),default,testStore:store,testDialog:Dialog(false));
        Assert.False(result["remembered"]!.GetValue<bool>()); Assert.NotNull(result["privateCredential"]); Assert.Equal(original,store.Items.Single().Value.ToJsonString());
    }
    [Fact]
    public async Task CancelledLoginDoesNotWriteStore() {
        var store=new Store(); var result=await MacPrivateBackend.ExecuteAsync(Envelope("prompt"),default,testStore:store,testDialog:(m,a,c,v)=>Task.FromResult(new MacDialogResult(false,null)));
        Assert.False(result["saved"]!.GetValue<bool>()); Assert.Empty(store.Items);
    }
    [Fact]
    public async Task FrameParserRejectsMalformedUtf8AndOverLimit() {
        await Assert.ThrowsAnyAsync<Exception>(()=>MacPrivateDialog.ReadFrameAsync(new MemoryStream(new byte[]{0xff,10}),default));
        await Assert.ThrowsAnyAsync<Exception>(()=>MacPrivateDialog.ReadFrameAsync(new MemoryStream(Encoding.UTF8.GetBytes(new string('a',32769)+"\n")),default));
    }
    [Fact]
    public async Task FrameParserPreservesUnicode() {
        var value=await MacPrivateDialog.ReadFrameAsync(new MemoryStream(Encoding.UTF8.GetBytes("{\"value\":\"ação\"}\n")),default);
        Assert.Equal("ação",value!["value"]!.GetValue<string>());
    }
    [Fact]
    public void KeychainOffMacFailsBeforeCallingNativeLibrary() {
        if(OperatingSystem.IsMacOS()) return;
        var store=new MacKeychain("aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb");
        var error=Assert.Throws<AgentFault>(()=>store.Write("SSAM/Agent/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/test",new JsonObject()));
        Assert.Equal("MAC_KEYCHAIN_UNAVAILABLE",error.Code);
    }

    [Fact]
    public async Task FrameParserSkipsOnlyBoundedEmptyStartupLines() {
        var result=await MacPrivateDialog.ReadFrameAsync(new MemoryStream(Encoding.UTF8.GetBytes("\r\n\n{\"ok\":true}\n")),default);
        Assert.True(result!["ok"]!.GetValue<bool>());
        await Assert.ThrowsAnyAsync<Exception>(()=>MacPrivateDialog.ReadFrameAsync(new MemoryStream(Encoding.UTF8.GetBytes(new string('\n',9))),default));
    }
    [Fact]
    public async Task UsersLoginSendsSecretOnlyToExactLoginEndpointAndReturnsCookieState() {
        var store=new Store(); await MacPrivateBackend.ExecuteAsync(Envelope("prompt","users"),default,testStore:store,testDialog:Dialog(true));
        var count=0;
        var result=await MacPrivateBackend.ExecuteAsync(Envelope("login","users"),default,testStore:store,testHttp:(uri,method,jar,body,type,auth,scheme,ct,headers)=> {
            count++; Assert.Equal("https://tenant.example/Users/Login.aspx",uri.AbsoluteUri);
            if(method=="GET") return Task.FromResult(new MacHttpResponse(200,Encoding.UTF8.GetBytes("<input name='user'><input type='password' name='pwd'><input type='submit' name='submit' value='Log In'>"),"text/html",""));
            Assert.Contains("pwd=synthetic-password",Encoding.UTF8.GetString(body!));
            jar.Add(uri,new System.Net.Cookie("session","synthetic-cookie","/Users/"));
            return Task.FromResult(new MacHttpResponse(302,Array.Empty<byte>(),"text/html","/Users/User_List.aspx"));
        });
        Assert.Equal(2,count); Assert.True(result["authenticated"]!.GetValue<bool>()); Assert.Single(result["setCookie"]!.AsArray());
    }
    [Fact]
    public async Task UsersRequestRejectsForeignHostBeforeSending() {
        var store=new Store(); await MacPrivateBackend.ExecuteAsync(Envelope("prompt","users"),default,testStore:store,testDialog:Dialog(true));
        var envelope=Envelope("request","users"); envelope["request"]!["url"]="https://other.example/Users/User_List.aspx"; envelope["request"]!["method"]="GET";
        var result=await MacPrivateBackend.ExecuteAsync(envelope,default,testStore:store,testHttp:(u,m,j,b,t,a,s,c,h)=>throw new Xunit.Sdk.XunitException("must not send"));
        Assert.False(result["ok"]!.GetValue<bool>()); Assert.Equal("USERS_PRIVATE_REQUEST_FAILED",result["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task NativeUsersDispatchesMacBackendThroughPublicKind() {
        var calls=0;
        var root=Path.Combine(@"C:\t\r4\tmp-r40-cred", "mac-dispatch-"+Guid.NewGuid().ToString("N"));
        var users=new UsersKinds(root,"synthetic-license",root) { ForceMac=true,
            MacBackend=(envelope,ct)=> { calls++; Assert.Equal("users",envelope["family"]!.GetValue<string>()); Assert.Equal("status",envelope["mode"]!.GetValue<string>()); return Task.FromResult(new JsonObject { ["ok"]=true,["available"]=true,["principal"]="synthetic" }); } };
        var result=await users.Execute(new JsonObject { ["op"]="status",["host"]="tenant.example" },default);
        Assert.True(result!["available"]!.GetValue<bool>()); Assert.Equal(1,calls);
    }

    [Theory]
    [InlineData("body","old")]
    [InlineData("body","new")]
    [InlineData("location","old")]
    [InlineData("location","new")]
    [InlineData("contentType","old")]
    [InlineData("contentType","new")]
    public async Task FullUsersKindWithholdsOldAndNewCookieEchoes(string field,string generation) {
        var root=Path.Combine(@"C:\t\r4\tmp-r40-cred","mac-cookie-"+Guid.NewGuid().ToString("N"));
        var oldCookie="sentinel-old-cookie"; var newCookie="sentinel-new-cookie";
        var users=new UsersKinds(root,"synthetic",root) { ForceMac=true, Lookup=_=>Task.FromResult(new[]{"93.184.216.34"}) };
        users.MacBackend=(envelope,ct)=> {
            if(envelope["mode"]!.GetValue<string>()=="login") return Task.FromResult(new JsonObject { ["ok"]=true,["authenticated"]=true,["setCookie"]=new JsonArray(Convert.ToBase64String(Encoding.UTF8.GetBytes("session="+oldCookie+"; path=/"))) });
            return MacPrivateBackend.ExecuteAsync(envelope,ct,testStore:new Store(),testHttp:(uri,method,jar,body,type,auth,scheme,c,h)=> {
                Assert.Contains(oldCookie,jar.GetCookieHeader(uri)); jar.Add(uri,new System.Net.Cookie("session",newCookie,"/"));
                var echo=generation=="old"?oldCookie:newCookie;
                return Task.FromResult(new MacHttpResponse(200,Encoding.UTF8.GetBytes(field=="body"?echo:"<html>safe</html>"),field=="contentType"?"text/"+echo:"text/html",field=="location"?"/Users/"+echo:""));
            });
        };
        users.ApplyLoginCompletion("tenant.example","{\"ok\":true,\"saved\":true,\"remembered\":false,\"privateCredential\":{\"username\":\"synthetic\",\"password\":\"synthetic-password\"}}",0);
        await users.Execute(new JsonObject { ["op"]="login",["host"]="tenant.example" },default);
        var error=await Assert.ThrowsAsync<AgentFault>(()=>users.Execute(new JsonObject { ["op"]="request",["host"]="tenant.example",["url"]="https://tenant.example/Users/User_List.aspx" },default));
        Assert.Equal("USERS_PRIVATE_RESPONSE_REFUSED",error.Code); Assert.DoesNotContain(oldCookie,error.Message); Assert.DoesNotContain(newCookie,error.Message); Assert.False(error.Executed);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShortCookiesDoNotCorruptCanonicalMimeButBodyEchoIsRefused(bool echo) {
        var envelope=Envelope("request","users"); var request=envelope["request"]!.AsObject();
        request["privateCredential"]=new JsonObject { ["username"]="synthetic",["password"]="synthetic-password" };
        request["url"]="https://tenant.example/Users/User_List.aspx"; request["method"]="GET"; request["cookie"]="session=a";
        var result=await MacPrivateBackend.ExecuteAsync(envelope,default,testStore:new Store(),testHttp:(u,m,j,b,t,a,s,c,h)=>Task.FromResult(new MacHttpResponse(200,Encoding.UTF8.GetBytes(echo?"a":"{}"),"application/json","")));
        Assert.Equal(!echo,result["ok"]!.GetValue<bool>());
        if(!echo) Assert.Equal("application/json",Encoding.UTF8.GetString(Convert.FromBase64String(result["contentType"]!.GetValue<string>())));
        else Assert.Equal("USERS_PRIVATE_RESPONSE_REFUSED",result["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task FullUsersKindReportsUncertainPostAfterCookieEchoRefusal() {
        var root=Path.Combine(@"C:\t\r4\tmp-r40-cred","mac-cookie-post-"+Guid.NewGuid().ToString("N")); var posts=0;
        var users=new UsersKinds(root,"synthetic",root) { ForceMac=true, Lookup=_=>Task.FromResult(new[]{"93.184.216.34"}) };
        users.MacBackend=(envelope,ct)=>MacPrivateBackend.ExecuteAsync(envelope,ct,testStore:new Store(),testHttp:(uri,method,jar,body,type,auth,scheme,c,h)=> {
            if(method=="POST") { posts++; jar.Add(uri,new System.Net.Cookie("session","sentinel-new-cookie","/")); return Task.FromResult(new MacHttpResponse(200,Encoding.UTF8.GetBytes("sentinel-new-cookie"),"text/html","")); }
            return Task.FromResult(new MacHttpResponse(200,Encoding.UTF8.GetBytes("<html><form method='post' action='User_List.aspx'><input type='hidden' name='__OSVSTATE' value='s'><input id='x_wtSearchInput' name='s'><input type='submit' name='b' value='Search'></form></html>"),"text/html",""));
        });
        users.ApplyLoginCompletion("tenant.example","{\"ok\":true,\"saved\":true,\"remembered\":false,\"privateCredential\":{\"username\":\"synthetic\",\"password\":\"synthetic-password\"}}",0);
        var error=await Assert.ThrowsAsync<AgentFault>(()=>users.Execute(new JsonObject { ["op"]="search",["host"]="tenant.example",["text"]="test" },default));
        Assert.Equal("USERS_PRIVATE_RESPONSE_REFUSED",error.Code); Assert.Null(error.Executed); Assert.Equal(1,posts); Assert.DoesNotContain("nothing was sent",error.Message);
    }

    [Theory]
    [InlineData("CREDENTIAL_PERMISSION_DENIED")]
    [InlineData("CREDENTIAL_STORE_FAILED")]
    [InlineData("CREDENTIAL_PRIVATE_HELPER_FAILED")]
    [InlineData("CREDENTIAL_HELPER_UNAVAILABLE")]
    public async Task CredentialKindPreservesFixedPrivateBackendErrorCodes(string code) {
        var root=Path.Combine(@"C:\t\r4\tmp-r40-cred","mac-code-"+Guid.NewGuid().ToString("N"));
        var kind=new CredentialKinds(root,"synthetic",new PrivateSessionRuntime()) { ForceWindows=true, Lookup=_=>Task.FromResult(new[]{"93.184.216.34"}), Helper=_=>Task.FromResult(new JsonObject { ["ok"]=false,["code"]=code }) };
        var error=await Assert.ThrowsAsync<AgentFault>(()=>kind.Execute(new JsonObject { ["op"]="status",["host"]="tenant.example",["service"]="service-center",["auth"]="credential" },default));
        Assert.Equal(code,error.Code); Assert.Contains("No automatic retry",error.Message);
    }
}
