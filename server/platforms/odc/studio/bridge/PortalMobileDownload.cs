using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Ssam.PrivateTransport;

// The persisted setting URL and proxy response never leave the Studio. This is
// a scoped content read, not a generic URL-fetch capability.
internal static class PortalMobileDownload {
    internal const string GetterPath = "/apps/screenservices/apps/ApplicationMobile/extensibillitysetting/DataActionGetExtensibilitySettingInfo";
    internal const string ProxyPath = "/apps/screenservices/apps/Misc/UploadFile_BinarySetting/ActionRequest_SubmitGetRequest";
    internal const string ProxyApiVersion = "SllOAApWtZ3EbzpH4_OwNw";
    internal const int MaxBytes = 1048576;
    private static readonly string[] VariableKeys={"appid","stageid","ActivePortfolioKey","id","libraryid","_appidInDataFetchStatus","_stageidInDataFetchStatus","_idInDataFetchStatus","_libraryidInDataFetchStatus","SelectedStage","GetApplicationStages","GetLatestDeployedAppVersion"};
    internal sealed record Request(JsonObject Body, string Id, string App, string Stage, string Setting, string Library, int? LibraryRevision, string SettingName, string Filename, string Filetype, int Length, string Sha256, string PersistedUri, long Deadline, bool Base64Transport);
    private static PortalCore.Refusal Refuse() => new("MOBILE_DOWNLOAD_UNVERIFIED", "The private persisted mobile file did not verify its exact scope and content. No URL or remote response is exposed.");
    private static bool Keys(JsonObject value, params string[] keys) => value.Count == keys.Length && keys.All(value.ContainsKey);
    internal static Request Parse(JsonObject json, string host, DateTimeOffset now) {
        PortalCore.CheckHost(host);
        try {
            if (!Keys(json,"operationId","method","path","body","expectedContent","downloadId","confirmTenant","deadlineAt")
                || (string?)json["operationId"] != "mobileExtensibility.downloadFile" || (string?)json["method"] != "POST"
                || (string?)json["path"] != GetterPath || (string?)json["confirmTenant"] != host
                || !Guid.TryParseExact((string?)json["downloadId"], "D", out _)) throw Refuse();
            var deadline=json["deadlineAt"]!.GetValue<long>();
            if (deadline<=now.ToUnixTimeMilliseconds() || deadline>now.AddSeconds(30).ToUnixTimeMilliseconds()) throw Refuse();
            if (json["body"] is not JsonObject body || !Keys(body,"versionInfo","viewName","inputParameters","screenData","clientVariables")
                || (string?)body["viewName"]!="ApplicationMobile.extensibillitysetting"
                || body["versionInfo"] is not JsonObject version || !Keys(version,"moduleVersion","apiVersion")
                || new[]{"moduleVersion","apiVersion"}.Any(k=>version[k] is not JsonValue v || !v.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text) || text.Length>512)
                || body["inputParameters"] is not JsonObject inputs || inputs.Count!=0
                || body["clientVariables"] is not JsonObject clients || clients.Count!=0
                || body["screenData"] is not JsonObject screen || !Keys(screen,"variables") || screen["variables"] is not JsonObject vars
                || !Keys(vars,(string?)vars["libraryid"]==""?VariableKeys:VariableKeys.Concat(new[]{"ScreenExtensibilitySettingInformationStructure"}).ToArray())
                || new[]{"appid","stageid","ActivePortfolioKey","id"}.Any(k=>!Guid.TryParseExact((string?)vars[k],"D",out _))
                || ((string?)vars["libraryid"]!=""&&!Guid.TryParseExact((string?)vars["libraryid"],"D",out _)) || new[]{"_appidInDataFetchStatus","_stageidInDataFetchStatus","_idInDataFetchStatus","_libraryidInDataFetchStatus"}.Any(k=>(int?)vars[k]!=1)
                || (string?)vars["SelectedStage"]?["Key"]!=(string?)vars["stageid"] || (string?)vars["SelectedStage"]?["PortfolioKey"]!=(string?)vars["ActivePortfolioKey"]
                || vars["GetApplicationStages"] is not JsonObject || vars["GetLatestDeployedAppVersion"] is not JsonObject
                || json["expectedContent"] is not JsonObject e || !(Keys(e,"settingName","filename","filetype","byteLength","sha256","uploadObjectUri")||Keys(e,"settingName","filename","filetype","byteLength","sha256","uploadObjectUri","libraryRevision"))) throw Refuse();
            var library=(string)vars["libraryid"]!;int? libraryRevision=null;
            if(library.Length>0){
                libraryRevision=e["libraryRevision"]!.GetValue<int>();if(libraryRevision<1||library==(string?)vars["appid"])throw Refuse();
                if(vars["ScreenExtensibilitySettingInformationStructure"] is not JsonObject seed||!Keys(seed,"ExtensibilitySettingInfo")
                    ||seed["ExtensibilitySettingInfo"] is not JsonObject initial||!Keys(initial,"IsFromLibrary","LibraryInfo")||(bool?)initial["IsFromLibrary"]!=true
                    ||initial["LibraryInfo"] is not JsonObject initialLibrary||!Keys(initialLibrary,"Key","Revision","Name")
                    ||(string?)initialLibrary["Key"]!=library||(int?)initialLibrary["Revision"]!=0||(string?)initialLibrary["Name"]!="")throw Refuse();
            }
            else if(e.ContainsKey("libraryRevision"))throw Refuse();
            var name=(string?)e["settingName"]; var filename=(string?)e["filename"]; var type=(string?)e["filetype"]; var sha=(string?)e["sha256"]; var length=e["byteLength"]!.GetValue<int>();
            if (string.IsNullOrWhiteSpace(name)||name.Length>256||name.Any(char.IsControl)
                || string.IsNullOrWhiteSpace(filename)||filename.Length>512||filename.Any(c=>char.IsControl(c)||c=='/'||c=='\\')
                || string.IsNullOrWhiteSpace(type)||!Regex.IsMatch(type,"^[a-zA-Z0-9]{1,16}$")||!filename.EndsWith("."+type,StringComparison.Ordinal)
                || length<1||length>MaxBytes||sha==null||!Regex.IsMatch(sha,"^[a-f0-9]{64}$")) throw Refuse();
            var uploadBinding=(string?)e["uploadObjectUri"]??"";var base64Transport=uploadBinding.StartsWith("urn:ssam:mobile-base64:",StringComparison.Ordinal);
            Uri? upload=null;
            if(base64Transport){if(!Guid.TryParseExact(uploadBinding["urn:ssam:mobile-base64:".Length..],"D",out _))throw Refuse();}
            else {upload=PortalMobileUpload.CheckUri(uploadBinding);if(upload.Query.Length!=0)throw Refuse();}
            var app=(string)vars["appid"]!;var stage=(string)vars["stageid"]!;var setting=(string)vars["id"]!;
            var persisted=(upload?.GetLeftPart(UriPartial.Authority)??"")+"/nativeapporchestration/configurations/management/"+stage+"/binaries/"+app+"/"+setting;
            return new Request((JsonObject)body.DeepClone(),(string)json["downloadId"]!,app,stage,setting,library,libraryRevision,name,filename,type,length,sha,persisted,deadline,base64Transport);
        } catch { throw Refuse(); }
    }
    internal static async Task<JsonObject> Send(HttpClient portal, Request request, PrivateHttpContext context, string host, string user, string downloads, CancellationToken token) {
        var stage="setting-request";int? status=null;string? errorCode=null;string? binaryWireKind=null;int? observedByteLength=null;bool? contentHashMatches=null;
        try {
            PortalCore.CheckHost(host);
            // Receive already verifies host/principal/request hash and expiry
            // before returning the cookie-only private context.
            if(string.IsNullOrWhiteSpace(user))throw Refuse();
            using var deadline=CancellationTokenSource.CreateLinkedTokenSource(token);
            var remaining=request.Deadline-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();if(remaining<=0||remaining>30000)throw Refuse();deadline.CancelAfter(TimeSpan.FromMilliseconds(remaining));token=deadline.Token;
            var getter=await Post(GetterPath,request.Body);
            stage="setting-scope";
            var info=getter["ExtensibilitySettingInfo"];var setting=info?["Setting"];var metadata=setting?["Metadata"];
            var fromLibrary=request.Library.Length>0;
            if((bool?)getter["NotFound"]!=false||(bool?)info?["IsFromLibrary"]!=fromLibrary
                ||fromLibrary&&((string?)info?["LibraryInfo"]?["Key"]!=request.Library||(int?)info?["LibraryInfo"]?["Revision"]!=request.LibraryRevision)
                ||(string?)setting?["Key"]!=request.Setting
                ||(string?)setting?["Name"]!=request.SettingName||(string?)setting?["DataType"]!="BinaryUrl"||(bool?)setting?["IsSecret"]!=false
                ||(string?)setting?["ValueOrigin"]!="Override"||(string?)metadata?["Name"]+"."+(string?)metadata?["Filetype"]!=request.Filename
                ||(string?)metadata?["Filetype"]!=request.Filetype||!Uri.TryCreate((string?)setting?["Value"],UriKind.Absolute,out var value)
                ||value.Scheme!="https"||!value.IsDefaultPort||value.UserInfo.Length!=0||value.Fragment.Length!=0
                ||(request.Base64Transport
                    ?!Regex.IsMatch(value.Host,@"^plat-[a-z0-9]{1,58}\.s3\.[a-z0-9-]+\.amazonaws\.com$",RegexOptions.CultureInvariant)||value.AbsolutePath!=request.PersistedUri
                    :value.GetLeftPart(UriPartial.Path)!=request.PersistedUri))throw Refuse();
            var proxy=new JsonObject { ["versionInfo"]=new JsonObject { ["moduleVersion"]=(string?)request.Body["versionInfo"]?["moduleVersion"],["apiVersion"]=ProxyApiVersion },
                // Native BaseViewController builds action payload from the
                // current model context, not from the action owner's block.
                // Server actions have no data-action screenData/clientVariables.
                ["viewName"]=(string?)request.Body["viewName"],["inputParameters"]=new JsonObject { ["URL"]=value.AbsoluteUri,["Arguments"]="",["Timeout"]=0,["KeepAlive"]=false } };
            stage="content-request";var content=await Post(ProxyPath,proxy);stage="content-hash";
            // ServerDataConverter accepts BinaryData as inline base64 or the
            // {content,url} interface. A returned URL is never followed here.
            var binary=content["BinaryContent"];string? encoded=null;
            if(binary is JsonValue scalar&&scalar.TryGetValue<string>(out var text)){binaryWireKind="inline-string";encoded=text;}
            else if(binary is JsonObject wire&&wire.All(x=>x.Key is "content" or "url")){
                binaryWireKind=wire["content"] is JsonValue val&&val.TryGetValue<string>(out var inline)?"inline-object":"url-or-empty-object";
                if(binaryWireKind=="inline-object")encoded=wire["content"]!.GetValue<string>();
            }else binaryWireKind=binary==null?"missing":"unsupported";
            if(encoded==null||encoded.Length>1398104)throw Refuse();
            var bytes=Convert.FromBase64String(encoded);
            observedByteLength=bytes.Length;
            try {
                contentHashMatches=CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes),Convert.FromHexString(request.Sha256));
                if(bytes.Length!=request.Length||Convert.ToBase64String(bytes)!=encoded||contentHashMatches!=true)throw Refuse();
                stage="content-mime";
                var mime=(string?)content["BinaryContentType"];
                // Native downloadBinary uses the binary payload and filename;
                // the optional Text output can be empty. It is not a content
                // integrity predicate. Preserve nonempty values when valid.
                if(string.IsNullOrWhiteSpace(mime))mime="application/octet-stream";
                if(mime.Length>128||mime.Any(char.IsControl))throw Refuse();
                stage="content-save";Directory.CreateDirectory(downloads);var file=Path.Combine(downloads,"mobile-file-"+request.Id+".bin");var partial=Path.ChangeExtension(file,".partial");
                if(File.Exists(file))throw Refuse();
                await using(var output=new FileStream(partial,FileMode.CreateNew,FileAccess.Write,FileShare.None,8192,FileOptions.Asynchronous)){await output.WriteAsync(bytes,token);await output.FlushAsync(token);}
                File.Move(partial,file,false);
                var answer=new JsonObject { ["ok"]=true,["host"]=host,["user"]=user,["status"]=200,["body"]=new JsonObject { ["data"]=new JsonObject { ["FileDownloadProof"]=new JsonObject {
                    ["downloadId"]=request.Id,["applicationKey"]=request.App,["environmentKey"]=request.Stage,["settingKey"]=request.Setting,["file"]=file,
                    ["filename"]=request.Filename,["mimeType"]=mime,["byteLength"]=bytes.Length,["sha256"]=request.Sha256,["contentReadBackVerified"]=true,["persistedObjectVerified"]=true,["signedUriExposed"]=false } } } };
                if(fromLibrary){var proof=(JsonObject)answer["body"]!["data"]!["FileDownloadProof"]!;proof["libraryKey"]=request.Library;proof["libraryRevision"]=request.LibraryRevision;}
                return answer;
            } finally { CryptographicOperations.ZeroMemory(bytes); }
            async Task<JsonObject> Post(string path,JsonObject body) {
                using var message=new HttpRequestMessage(HttpMethod.Post,"https://"+host+path);
                message.Headers.Add("Cookie",context.Cookie);if(context.Csrf.Length>0)message.Headers.Add("x-csrftoken",context.Csrf);
                message.Headers.Add("x-client-type","browser");message.Headers.Add("Origin","https://"+host);message.Headers.Referrer=new Uri("https://"+host+"/apps/");
                message.Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json");
                using var response=await portal.SendAsync(message,HttpCompletionOption.ResponseHeadersRead,token);status=(int)response.StatusCode;
                if(response.RequestMessage?.RequestUri!=message.RequestUri||response.Content.Headers.ContentType?.MediaType?.Contains("json",StringComparison.OrdinalIgnoreCase)!=true||response.Content.Headers.ContentLength>3*1024*1024)throw Refuse();
                await using var stream=await response.Content.ReadAsStreamAsync(token);using var saved=new MemoryStream();var buffer=new byte[8192];int n;
                while((n=await stream.ReadAsync(buffer,token))>0){if(saved.Length+n>3*1024*1024)throw Refuse();await saved.WriteAsync(buffer.AsMemory(0,n),token);}
                var raw=JsonNode.Parse(saved.ToArray()) as JsonObject;
                if(status!=200&&raw!=null){var match=Regex.Match(raw.ToJsonString(),@"\bOS-[A-Z0-9]{2,8}-[A-Z0-9]{2,12}\b",RegexOptions.CultureInvariant);if(match.Success)errorCode=match.Value;}
                if(status!=200||raw==null||raw["exception"]!=null||raw["error"]!=null||(bool?)raw["versionInfo"]?["hasApiVersionChanged"]==true||(bool?)raw["versionInfo"]?["hasModuleVersionChanged"]==true||raw["data"] is not JsonObject data)throw Refuse();
                return data;
            }
        } catch {
            var refused=PortalCore.Fail("MOBILE_DOWNLOAD_UNVERIFIED","Private persisted file read did not verify its exact content; no URL or remote response is exposed.");
            refused["diagnosticStage"]=stage;if(status!=null)refused["portalStatus"]=status;if(errorCode!=null)refused["portalErrorCode"]=errorCode;
            if(binaryWireKind!=null)refused["binaryWireKind"]=binaryWireKind;if(observedByteLength is >=0 and <=MaxBytes)refused["observedByteLength"]=observedByteLength;if(contentHashMatches!=null)refused["contentHashMatches"]=contentHashMatches;return refused;
        }
    }
}
