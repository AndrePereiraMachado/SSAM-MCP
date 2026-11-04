using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;
using Xunit;

public class CredentialLifetimeTests
{
    private static string Jwt(long exp) => "e30."+Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"exp\":"+exp+"}")).TrimEnd('=').Replace('+','-').Replace('/','_')+".fixture";
    [Fact]
    public void AccessTokenLimitsLongCookieWithoutChangingSecrets()
    {
        var cookies=new JsonArray(new JsonObject { ["name"]="TenantAccess",["value"]=Jwt(100),["expiresAt"]=999999 },new JsonObject { ["name"]="TenantAccessId",["value"]=Jwt(80) });
        var state=new JsonObject { ["expiresAt"]=999999L,["cookies"]=cookies };var original=cookies.ToJsonString();
        Assert.True(CredentialSessionLifetime.Limit(state));Assert.Equal(80000L,state["expiresAt"]!.GetValue<long>());
        Assert.Equal(original,cookies.ToJsonString());Assert.False(CredentialSessionLifetime.Limit(state));
    }
    [Theory]
    [InlineData("RefreshTenantAccess","e30.eyJleHAiOjF9.fixture")]
    [InlineData("TenantAccess","opaque")]
    [InlineData("TenantAccess","e30.eyJleHAiOiIxIn0.fixture")]
    public void OpaqueAndRefreshCookiesDoNotRedefineLifetime(string name,string token)
    {
        var state=new JsonObject { ["expiresAt"]=100L,["cookies"]=new JsonArray(new JsonObject { ["name"]=name,["value"]=token }) };
        Assert.False(CredentialSessionLifetime.Limit(state));Assert.Equal(100L,state["expiresAt"]!.GetValue<long>());
    }
    [Fact]
    public async Task ExpiredAccessTriggersOneFreshConcurrentLogin()
    {
        var kind=new CredentialKinds(Path.Combine(Path.GetTempPath(),"credential-lifetime-"+Guid.NewGuid()),"fixture",new()) { ForceWindows=true,Lookup=_=>Task.FromResult(new[]{"93.184.216.34"}) };int logins=0;
        kind.Helper=async p=>{
            if(p["op"]!.GetValue<string>()=="status")return new JsonObject { ["ok"]=true,["available"]=true,["authenticated"]=p["privateSession"]?["expiresAt"]?.GetValue<long>()>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            logins++;await Task.Delay(10);
            return new JsonObject { ["ok"]=true,["authenticated"]=true,["privateSession"]=new JsonObject { ["expiresAt"]=DateTimeOffset.UtcNow.AddHours(8).ToUnixTimeMilliseconds(),["cookies"]=new JsonArray(new JsonObject { ["name"]="TenantAccess",["value"]=Jwt(DateTimeOffset.UtcNow.ToUnixTimeSeconds()+(logins==1?-1:300)),["expiresAt"]=DateTimeOffset.UtcNow.AddHours(12).ToUnixTimeMilliseconds() }) } };
        };
        var request=new JsonObject { ["op"]="login",["host"]="tenant.example.test",["service"]="odc-portal",["auth"]="credential",["profile"]=new string('a',64) };
        await kind.Execute(request,CancellationToken.None);
        await Task.WhenAll(Enumerable.Range(0,3).Select(_=>kind.Execute(request,CancellationToken.None)));Assert.Equal(2,logins);
        await kind.Execute(request,CancellationToken.None);Assert.Equal(2,logins);
    }
}
