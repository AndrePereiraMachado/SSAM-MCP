using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.PrivateTransport;
using Xunit;

public sealed class PortalMobileBase64Tests {
    const string Host="personal-test.outsystems.dev",User="user@example.test",Cookie="session=base64-private-cookie";
    static readonly string Hash=new('a',64);
    static PrivateHttpContext Context(){var now=DateTimeOffset.UtcNow;return PrivateHttpContext.Parse(Encoding.UTF8.GetBytes(new JsonObject{
        ["schema"]="ssam-private-http-context/1",["requestSha256"]=Hash,["host"]=Host,["principal"]=User,["cookie"]=Cookie,["csrf"]="",
        ["issuedAt"]=now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),["expiresAt"]=now.AddSeconds(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")}.ToJsonString()),Hash,Host,User,now);}
    sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> answer):HttpMessageHandler {
        internal int Count;protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t){Count++;Assert.Equal(Cookie,r.Headers.GetValues("Cookie").Single());return answer(r);}
    }
    static HttpResponseMessage Json(HttpRequestMessage r,JsonObject body)=>new(HttpStatusCode.OK){RequestMessage=r,Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json")};
    [Theory]
    [InlineData(false,"valid")][InlineData(true,"valid")][InlineData(true,"drift")][InlineData(true,"bad-response")][InlineData(false,"timeout")]
    public async Task NativeConversionAndSaveKeepContentPrivateAndConsumeOnlyOnce(bool secret,string variant){
        var bytes=Encoding.UTF8.GetBytes("private base64 content marker");var encoded=Convert.ToBase64String(bytes);var id=Guid.NewGuid().ToString();var dir=Path.Combine(Path.GetTempPath(),"native-base64-"+id);
        var input=new JsonObject{["operationId"]="mobileExtensibility.convertFile",["method"]="POST",["path"]="/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/ActionBinaryToBase64",["write"]=true,["operationUuid"]=id,["authorizeSha256"]=Hash,["confirmTenant"]=Host,["body"]=new JsonObject{["inputParameters"]=new JsonObject{["BinaryData"]=secret?"":encoded}}};
        if(secret){input["secretRefs"]=new JsonArray(new JsonObject{["pointer"]="/inputParameters/BinaryData",["target"]="SSAM/ODC3/"+Host+"/Setting/File",["field"]="password"});input["mobileExpectedContent"]=new JsonObject{["sha256"]=variant=="drift"?new string('0',64):Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),["byteLength"]=bytes.Length};}
        var handler=new Handler(async r=>{Assert.Equal(encoded,(string?)JsonNode.Parse(await r.Content!.ReadAsStringAsync())?["inputParameters"]?["BinaryData"]);if(variant=="timeout")throw new TaskCanceledException();return Json(r,new JsonObject{["unexpectedTopLevelEcho"]=encoded,["data"]=new JsonObject{["Base64"]=variant=="bad-response"?Convert.ToBase64String(Encoding.UTF8.GetBytes("wrong content")):encoded}});});
        using var client=new HttpClient(handler);var places=new PortalCore.Places(Path.Combine(dir,"writes"),Path.Combine(dir,"downloads"));
        try{
            var request=PortalCore.ParseWebRequest(input.ToJsonString());var answer=await PortalPrivateHttp.Send(client,request,Context(),Host,User,PortalCore.ReadTenants(null),places,_=>new PortalCore.VaultEntry("setting",encoded),CancellationToken.None,()=>throw new Exception("Conversion must not download from S3"));
            Assert.Equal(variant=="valid",(bool?)answer["ok"]);Assert.Equal(variant=="drift"?0:1,handler.Count);Assert.DoesNotContain(encoded,answer.ToJsonString());
            if(variant=="valid"){
                var proof=answer["body"]!["data"]!["UploadProof"]!;Assert.Equal("base64",(string?)proof["transportMode"]);var binding="urn:ssam:mobile-base64:"+id;Assert.Equal(binding,(string?)proof["objectUri"]);
                Assert.Equal(encoded,PortalMobileUpload.Resolve(id,Host,User,binding,DateTimeOffset.UtcNow,false));
                var saveId=Guid.NewGuid().ToString();var saved=new JsonObject{["operationId"]="mobileExtensibility.saveFile",["method"]="POST",["path"]="/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/ActionExtensbilitySettingSave_Wrapper",["write"]=true,["operationUuid"]=saveId,["authorizeSha256"]=Hash,["confirmTenant"]=Host,["mobileUploadOperationUuid"]=id,["mobileObjectUri"]=binding,["body"]=new JsonObject{["inputParameters"]=new JsonObject{["RequiresDecoding"]=false,["ExtensibilitySettingInfo"]=new JsonObject{["Setting"]=new JsonObject{["DataType"]="BinaryUrl",["IsSecret"]=secret,["ValueOrigin"]="Override",["Value"]=""}}}}};
                var saveHandler=new Handler(async r=>{var body=JsonNode.Parse(await r.Content!.ReadAsStringAsync());Assert.Equal(encoded,(string?)body?["inputParameters"]?["ExtensibilitySettingInfo"]?["Setting"]?["Value"]);Assert.Equal(false,(bool?)body?["inputParameters"]?["RequiresDecoding"]);Assert.True(File.Exists(Path.Combine(places.WritesDir,saveId+".json")));Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,binding,DateTimeOffset.UtcNow,false));return Json(r,new JsonObject{["data"]=new JsonObject{["echo"]=encoded}});});
                using var saveClient=new HttpClient(saveHandler);var saveRequest=PortalCore.ParseWebRequest(saved.ToJsonString());
                var result=await PortalPrivateHttp.Send(saveClient,saveRequest,Context(),Host,User,PortalCore.ReadTenants(null),places,_=>null,CancellationToken.None);Assert.True((bool?)result["ok"]);Assert.DoesNotContain(encoded,result.ToJsonString());
                var replay=await PortalPrivateHttp.Send(saveClient,saveRequest,Context(),Host,User,PortalCore.ReadTenants(null),places,_=>null,CancellationToken.None);Assert.False((bool?)replay["ok"]);Assert.Equal(1,saveHandler.Count);
            }else Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,"urn:ssam:mobile-base64:"+id,DateTimeOffset.UtcNow,false));
            if(Directory.Exists(dir))foreach(var f in Directory.GetFiles(dir,"*",SearchOption.AllDirectories))Assert.DoesNotContain(encoded,File.ReadAllText(f));
        }finally{if(Directory.Exists(dir))Directory.Delete(dir,true);}
    }
    [Fact]
    public void Base64CapabilityRefusesChangedContentScopeExpiryAndDuplicateCapture(){
        var now=DateTimeOffset.UtcNow;var id=Guid.NewGuid().ToString();var input=Convert.ToBase64String(new byte[]{1,2,3});var binding="urn:ssam:mobile-base64:"+id;
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.CaptureBase64(Host,User,id,input,"AQIE",now));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.CaptureBase64(Host,User,id,"YR==","YR==",now));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.CaptureBase64(Host,User,id,"","",now));
        PortalMobileUpload.CaptureBase64(Host,User,id,input,input,now);
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.CaptureBase64(Host,User,id,input,input,now));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,"other.outsystems.dev",User,binding,now,false));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,"other@example.test",binding,now,false));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,binding+"extra",now,false));
        Assert.Throws<PortalCore.Refusal>(()=>PortalMobileUpload.Resolve(id,Host,User,binding,now.AddMinutes(11),false));
    }
}
