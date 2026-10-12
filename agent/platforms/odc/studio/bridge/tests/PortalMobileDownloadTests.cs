using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Ssam.PrivateTransport;
using Xunit;

public sealed class PortalMobileDownloadTests : IDisposable {
    private const string Host="personal-test.outsystems.dev",User="user@example.test",Cookie="private-cookie-sentinel",Signature="private-signed-sentinel";
    private readonly string dir=Path.Combine(Path.GetTempPath(),"ssam-mobile-download-"+Guid.NewGuid());
    private static readonly byte[] Bytes=Encoding.UTF8.GetBytes("own persisted proof\n");
    private static string Sha=>Convert.ToHexString(SHA256.HashData(Bytes)).ToLowerInvariant();
    private static JsonObject Input(){
        var app=Guid.NewGuid().ToString();var stage=Guid.NewGuid().ToString();var portfolio=Guid.NewGuid().ToString();var setting=Guid.NewGuid().ToString();
        return new JsonObject { ["operationId"]="mobileExtensibility.downloadFile",["method"]="POST",["path"]=PortalMobileDownload.GetterPath,["confirmTenant"]=Host,["downloadId"]=Guid.NewGuid().ToString(),["deadlineAt"]=DateTimeOffset.UtcNow.AddSeconds(25).ToUnixTimeMilliseconds(),
            ["expectedContent"]=new JsonObject { ["settingName"]="OwnFile",["filename"]="own-proof.txt",["filetype"]="txt",["byteLength"]=Bytes.Length,["sha256"]=Sha,["uploadObjectUri"]="https://plat-test.s3.eu-west-1.amazonaws.com/tenants/uploads/"+Guid.NewGuid() },
            ["body"]=new JsonObject { ["versionInfo"]=new JsonObject { ["moduleVersion"]="module",["apiVersion"]="getter-api" },["viewName"]="ApplicationMobile.extensibillitysetting",["inputParameters"]=new JsonObject(),["clientVariables"]=new JsonObject(),
                ["screenData"]=new JsonObject { ["variables"]=new JsonObject { ["appid"]=app,["stageid"]=stage,["ActivePortfolioKey"]=portfolio,["id"]=setting,["libraryid"]="",["_appidInDataFetchStatus"]=1,["_stageidInDataFetchStatus"]=1,["_idInDataFetchStatus"]=1,["_libraryidInDataFetchStatus"]=1,
                    ["SelectedStage"]=new JsonObject { ["Key"]=stage,["PortfolioKey"]=portfolio },["GetApplicationStages"]=new JsonObject(),["GetLatestDeployedAppVersion"]=new JsonObject() } } } };
    }
    private static void SetLibrary(JsonObject input,string library,int revision){
        input["body"]!["screenData"]!["variables"]!["libraryid"]=library;input["expectedContent"]!["libraryRevision"]=revision;
        input["body"]!["screenData"]!["variables"]!["ScreenExtensibilitySettingInformationStructure"]=new JsonObject { ["ExtensibilitySettingInfo"]=new JsonObject { ["IsFromLibrary"]=true,["LibraryInfo"]=new JsonObject { ["Key"]=library,["Revision"]=0,["Name"]="" } } };
    }
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> answer):HttpMessageHandler {
        internal int Count;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){token.ThrowIfCancellationRequested();Count++;var r=answer(request);r.RequestMessage??=request;return Task.FromResult(r);}
    }
    private static HttpResponseMessage Json(JsonObject data)=>new(HttpStatusCode.OK) { Content=new StringContent(new JsonObject { ["data"]=data }.ToJsonString(),Encoding.UTF8,"application/json") };
    [Theory]
    [InlineData("")][InlineData("empty-mime")][InlineData("missing-mime")][InlineData("object")][InlineData("url-only")][InlineData("secret")][InlineData("library")][InlineData("not-found")][InlineData("wrong-name")][InlineData("wrong-key")][InlineData("wrong-stage")][InlineData("wrong-host")][InlineData("bad-hash")][InlineData("bad-mime")][InlineData("bad-version")][InlineData("redirect")][InlineData("portal250")]
    public async Task Persisted_scope_is_read_before_private_proxy_and_exact_bytes_are_saved(string mutation){
        var request=PortalMobileDownload.Parse(Input(),Host,DateTimeOffset.UtcNow);
        var handler=new Handler(message=>{
            Assert.Equal(Cookie,message.Headers.GetValues("Cookie").Single());Assert.Equal(HttpMethod.Post,message.Method);Assert.Equal("https://"+Host,message.RequestUri!.GetLeftPart(UriPartial.Authority));
            var body=JsonNode.Parse(message.Content!.ReadAsStringAsync().GetAwaiter().GetResult())!;
            if(message.RequestUri.AbsolutePath==PortalMobileDownload.GetterPath){
                Assert.Equal(request.Setting,(string?)body["screenData"]?["variables"]?["id"]);
                var uri=request.PersistedUri+"?X-Amz-Signature="+Signature;
                if(mutation=="wrong-stage")uri=uri.Replace(request.Stage,Guid.NewGuid().ToString());if(mutation=="wrong-host")uri="https://evil.example.test/object?signature="+Signature;
                return Json(new JsonObject { ["NotFound"]=mutation=="not-found",["ExtensibilitySettingInfo"]=new JsonObject { ["IsFromLibrary"]=mutation=="library",["Setting"]=new JsonObject {
                    ["Key"]=mutation=="wrong-key"?Guid.NewGuid().ToString():request.Setting,["Name"]=mutation=="wrong-name"?"Other":request.SettingName,["DataType"]="BinaryUrl",["IsSecret"]=mutation=="secret",["ValueOrigin"]="Override",["Value"]=uri,["Metadata"]=new JsonObject { ["Name"]="own-proof",["Filetype"]="txt" } } } });
            }
            Assert.Equal(PortalMobileDownload.ProxyPath,message.RequestUri.AbsolutePath);Assert.Equal("ApplicationMobile.extensibillitysetting",(string?)body["viewName"]);Assert.Equal(PortalMobileDownload.ProxyApiVersion,(string?)body["versionInfo"]?["apiVersion"]);
            Assert.Equal(new[]{"inputParameters","versionInfo","viewName"},((JsonObject)body).Select(x=>x.Key).OrderBy(x=>x,StringComparer.Ordinal));
            Assert.Equal(request.PersistedUri+"?X-Amz-Signature="+Signature,(string?)body["inputParameters"]?["URL"]);Assert.Equal("",(string?)body["inputParameters"]?["Arguments"]);Assert.Equal(0,(int?)body["inputParameters"]?["Timeout"]);Assert.False((bool)body["inputParameters"]!["KeepAlive"]!);
            if(mutation=="redirect")return new(HttpStatusCode.Redirect);
            if(mutation=="portal250")return new((HttpStatusCode)250) { Content=new StringContent("{\"exception\":{\"message\":\"OS-BERT-00000 private-signed-sentinel private-cookie-sentinel\"}}",Encoding.UTF8,"application/json") };
            if(mutation=="bad-version")return new(HttpStatusCode.OK) { Content=new StringContent("{\"versionInfo\":{\"hasApiVersionChanged\":true},\"data\":{}}",Encoding.UTF8,"application/json") };
            JsonNode binary=mutation=="object"?new JsonObject { ["content"]=Convert.ToBase64String(Bytes),["url"]="https://untrusted.example.test/"+Signature }:mutation=="url-only"?new JsonObject { ["url"]="https://untrusted.example.test/"+Signature }:JsonValue.Create(Convert.ToBase64String(mutation=="bad-hash"?Encoding.UTF8.GetBytes("other bytes"):Bytes))!;
            var data=new JsonObject { ["BinaryContent"]=binary,["BinaryContentType"]=mutation=="bad-mime"?"text/plain\r\nInjected: x":mutation=="empty-mime"?"":"text/plain",["TextContent"]="private-text-sentinel" };if(mutation=="missing-mime")data.Remove("BinaryContentType");return Json(data);
        });
        using var client=new HttpClient(handler);var result=await PortalMobileDownload.Send(client,request,new PrivateHttpContext(Cookie,"csrf"),Host,User,dir,CancellationToken.None);
        var output=result.ToJsonString();Assert.DoesNotContain(Signature,output);Assert.DoesNotContain(Cookie,output);Assert.DoesNotContain("private-text-sentinel",output);
        if(mutation is "" or "object" or "empty-mime" or "missing-mime"){
            Assert.True((bool)result["ok"]!);Assert.Equal(2,handler.Count);var proof=result["body"]!["data"]!["FileDownloadProof"]!;
            Assert.True((bool)proof["persistedObjectVerified"]!);Assert.True((bool)proof["contentReadBackVerified"]!);Assert.False((bool)proof["signedUriExposed"]!);
            Assert.Equal(Bytes,File.ReadAllBytes((string)proof["file"]!));Assert.Equal(Sha,(string?)proof["sha256"]);
            var repeated=await PortalMobileDownload.Send(client,request,new PrivateHttpContext(Cookie,"csrf"),Host,User,dir,CancellationToken.None);Assert.False((bool)repeated["ok"]!);Assert.Equal(Bytes,File.ReadAllBytes((string)proof["file"]!));
        }else{Assert.False((bool)result["ok"]!);Assert.Equal("MOBILE_DOWNLOAD_UNVERIFIED",(string?)result["code"]);Assert.False(Directory.Exists(dir));
            Assert.Equal(new[]{"secret","library","not-found","wrong-name","wrong-key","wrong-stage","wrong-host"}.Contains(mutation)?1:2,handler.Count);if(mutation=="portal250")Assert.Equal("OS-BERT-00000",(string?)result["portalErrorCode"]);}
    }
    [Fact]
    public void Parse_rejects_scope_overrides_arbitrary_urls_and_invalid_expected_content(){
        foreach(var change in new Action<JsonObject>[] { j=>j["path"]="/arbitrary",j=>j["confirmTenant"]="other.outsystems.dev",j=>j["deadlineAt"]=0,j=>j["extra"]=true,
            j=>j["body"]!["inputParameters"]!["URL"]="https://evil.example.test",j=>j["body"]!["screenData"]!["variables"]!["libraryid"]=Guid.NewGuid().ToString(),j=>j["body"]!["screenData"]!["variables"]!["SelectedStage"]!["Key"]=Guid.NewGuid().ToString(),
            j=>j["expectedContent"]!["uploadObjectUri"]="https://evil.example.test/tenants/uploads/"+Guid.NewGuid(),j=>j["expectedContent"]!["uploadObjectUri"]="https://plat-test.s3.eu-west-1.amazonaws.com/tenants/uploads/"+Guid.NewGuid()+"?secret=x",j=>j["expectedContent"]!["filename"]="../proof.txt",j=>j["expectedContent"]!["byteLength"]=1048577,j=>j["expectedContent"]!["sha256"]="invalid" }){
            var input=Input();change(input);Assert.Throws<PortalCore.Refusal>(()=>PortalMobileDownload.Parse(input,Host,DateTimeOffset.UtcNow));
        }
    }
    [Theory]
    [InlineData("valid")][InlineData("wrong-host")][InlineData("wrong-setting")][InlineData("wrong-hash")]
    public async Task Converted_Base64_download_requires_exact_persisted_scope_and_content(string variant){
        var input=Input();input["expectedContent"]!["uploadObjectUri"]="urn:ssam:mobile-base64:"+Guid.NewGuid();
        var request=PortalMobileDownload.Parse(input,Host,DateTimeOffset.UtcNow);Assert.True(request.Base64Transport);
        var uri="https://plat-test.s3.eu-west-1.amazonaws.com"+request.PersistedUri+"?X-Amz-Signature="+Signature;
        if(variant=="wrong-host")uri=uri.Replace("plat-test.s3.eu-west-1.amazonaws.com","evil.example.test");
        if(variant=="wrong-setting")uri=uri.Replace(request.Setting,Guid.NewGuid().ToString());
        var handler=new Handler(message=>{
            if(message.RequestUri!.AbsolutePath==PortalMobileDownload.GetterPath)return Json(new JsonObject{["NotFound"]=false,["ExtensibilitySettingInfo"]=new JsonObject{["IsFromLibrary"]=false,["Setting"]=new JsonObject{
                ["Key"]=request.Setting,["Name"]=request.SettingName,["DataType"]="BinaryUrl",["IsSecret"]=false,["ValueOrigin"]="Override",["Value"]=uri,["Metadata"]=new JsonObject{["Name"]="own-proof",["Filetype"]="txt"}}}});
            Assert.Equal(PortalMobileDownload.ProxyPath,message.RequestUri.AbsolutePath);
            Assert.Equal(uri,(string?)JsonNode.Parse(message.Content!.ReadAsStringAsync().GetAwaiter().GetResult())?["inputParameters"]?["URL"]);
            return Json(new JsonObject{["BinaryContent"]=Convert.ToBase64String(variant=="wrong-hash"?new byte[]{0}:Bytes)});
        });
        using var client=new HttpClient(handler);var result=await PortalMobileDownload.Send(client,request,new PrivateHttpContext(Cookie,"csrf"),Host,User,dir,CancellationToken.None);
        Assert.Equal(variant=="valid",(bool?)result["ok"]);Assert.DoesNotContain(Signature,result.ToJsonString());
        Assert.Equal(variant is "wrong-host" or "wrong-setting"?1:2,handler.Count);
        if(variant=="valid")Assert.Equal(Bytes,File.ReadAllBytes((string)result["body"]!["data"]!["FileDownloadProof"]!["file"]!));
        else Assert.False(Directory.Exists(dir));
    }
    [Theory]
    [InlineData(0)][InlineData(1)][InlineData(2)][InlineData(3)]
    public async Task Library_key_and_revision_are_checked_before_private_proxy(int mutation){
        var input=Input();var library=Guid.NewGuid().ToString();SetLibrary(input,library,2);
        var request=PortalMobileDownload.Parse(input,Host,DateTimeOffset.UtcNow);
        var handler=new Handler(message=>{
            if(message.RequestUri!.AbsolutePath==PortalMobileDownload.GetterPath)return Json(new JsonObject { ["NotFound"]=false,["ExtensibilitySettingInfo"]=new JsonObject {
                ["IsFromLibrary"]=mutation!=3,["LibraryInfo"]=new JsonObject { ["Key"]=mutation==2?Guid.NewGuid().ToString():library,["Revision"]=mutation==1?3:2 },
                ["Setting"]=new JsonObject { ["Key"]=request.Setting,["Name"]=request.SettingName,["DataType"]="BinaryUrl",["IsSecret"]=false,["ValueOrigin"]="Override",["Value"]=request.PersistedUri+"?X-Amz-Signature="+Signature,["Metadata"]=new JsonObject { ["Name"]="own-proof",["Filetype"]="txt" } } } });
            Assert.Equal(PortalMobileDownload.ProxyPath,message.RequestUri.AbsolutePath);return Json(new JsonObject { ["BinaryContent"]=Convert.ToBase64String(Bytes) });
        });
        using var client=new HttpClient(handler);var result=await PortalMobileDownload.Send(client,request,new PrivateHttpContext(Cookie,"csrf"),Host,User,dir,CancellationToken.None);
        Assert.DoesNotContain(Signature,result.ToJsonString());Assert.Equal(mutation==0,(bool)result["ok"]!);Assert.Equal(mutation==0?2:1,handler.Count);
        if(mutation==0){Assert.Equal(library,(string?)result["body"]?["data"]?["FileDownloadProof"]?["libraryKey"]);Assert.Equal(2,(int?)result["body"]?["data"]?["FileDownloadProof"]?["libraryRevision"]);Assert.Equal(Bytes,File.ReadAllBytes((string)result["body"]!["data"]!["FileDownloadProof"]!["file"]!));}
        else Assert.False(Directory.Exists(dir));
    }
    [Fact]
    public void Library_revision_cannot_be_added_to_an_app_or_omitted_from_a_library(){
        var orphan=Input();orphan["expectedContent"]!["libraryRevision"]=2;Assert.Throws<PortalCore.Refusal>(()=>PortalMobileDownload.Parse(orphan,Host,DateTimeOffset.UtcNow));
        foreach(var revision in new[]{0,-1}){var input=Input();SetLibrary(input,Guid.NewGuid().ToString(),revision);Assert.Throws<PortalCore.Refusal>(()=>PortalMobileDownload.Parse(input,Host,DateTimeOffset.UtcNow));}
        var forged=Input();SetLibrary(forged,Guid.NewGuid().ToString(),2);forged["body"]!["screenData"]!["variables"]!["ScreenExtensibilitySettingInformationStructure"]!["ExtensibilitySettingInfo"]!["LibraryInfo"]!["Key"]=Guid.NewGuid().ToString();Assert.Throws<PortalCore.Refusal>(()=>PortalMobileDownload.Parse(forged,Host,DateTimeOffset.UtcNow));
    }
    public void Dispose(){if(Directory.Exists(dir))Directory.Delete(dir,true);}
}
