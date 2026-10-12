using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// Local-only cleanup of one native-created fixture. Public durable receipts
// bind the remote absence proof; no credential value is read into an answer.
internal static class PortalApiClientCleanup {
    private static PortalCore.Refusal Bad() => new("NOT_ALLOWED","API Client vault cleanup requires the original native fixture and its confirmed owned deletion.");
    private static string Uuid(JsonNode? value) {
        var text=value is JsonValue v&&v.TryGetValue<string>(out var s)?s:null;
        if(!Guid.TryParseExact(text,"D",out var id)||id.ToString()!=text)throw Bad();
        return text!;
    }
    private static JsonObject Read(string file) {
        if(!File.Exists(file)||new FileInfo(file).Length>32768)throw Bad();
        return JsonNode.Parse(File.ReadAllText(file)) as JsonObject??throw Bad();
    }
    private static void Save(string file,JsonObject value,bool first=false) {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary=first?file:file+"."+Guid.NewGuid().ToString("N")+".tmp";
        using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
            var bytes=System.Text.Encoding.UTF8.GetBytes(value.ToJsonString());stream.Write(bytes);stream.Flush(true);
        }
        if(!first)File.Move(temporary,file,true);
    }
    internal static void Record(string writesDir,string host,string user,PortalCore.WebRequest request,JsonObject proof) {
        var id=Uuid(JsonValue.Create(request.OperationUuid));
        var file=Path.Combine(writesDir,id+".api-client.json");
        var projected=new JsonObject();
        foreach(var field in new[]{"key","name","operationUuid","vaultRef","vaultStored","rawValueExposed","responseProjected"})projected[field]=proof[field]?.DeepClone();
        var record=new JsonObject { ["schema"]="ssam-native-api-client-fixture/1",["host"]=host,["user"]=user,
            ["authorizeSha256"]=request.AuthorizeSha256,["proof"]=projected };
        if(File.Exists(file)){
            var previous=Read(file);
            if((string?)previous["host"]!=host||(string?)previous["user"]!=user
                ||(string?)previous["authorizeSha256"]!=request.AuthorizeSha256
                ||(string?)previous["proof"]?["key"]!=(string?)proof["key"]
                ||(string?)previous["proof"]?["name"]!=(string?)proof["name"])throw Bad();
            Save(file,record);
        }else Save(file,record,true);
    }
    internal static JsonObject Cleanup(string writesDir,string receiptsDir,JsonObject request,string host,string user,
        Func<string,bool> remove,PortalCore.VaultReader vault) {
        try {
            PortalCore.CheckHost(host);
            if(request.Count!=4||(string?)request["schema"]!="ssam-api-client-fixture-cleanup/1"||string.IsNullOrWhiteSpace(user))throw Bad();
            var creation=Uuid(request["creationOperationUuid"]);var deletion=Uuid(request["deletionOperationUuid"]);
            var words=(string?)request["authorizeSha256"];
            if(words==null||!Regex.IsMatch(words,"^[a-f0-9]{64}$"))throw Bad();
            var receipt=Read(Path.Combine(receiptsDir,deletion+".json"));
            var expected=receipt["reconciliation"]?["apiClientFixture"];
            var nativeFile=Path.Combine(writesDir,creation+".api-client.json");
            var missingCapture=!File.Exists(nativeFile);
            string key;string? name;
            if(missingCapture){
                // A failed capture is never upgraded into a successful proof.
                // Only observe absence at the UUID-derived vault target; an
                // unexpected existing entry requires separate reconciliation.
                var origin=Read(Path.Combine(receiptsDir,creation+".json"));
                key=Uuid(expected?["key"]);name=(string?)expected?["name"];
                if((string?)expected?["cleanupMode"]!="pending-header"||(bool?)expected?["privateCaptureProven"]!=false
                    ||!Regex.IsMatch((string?)expected?["baselineSha256"]??"","^[a-f0-9]{64}$")
                    ||!Regex.IsMatch((string?)expected?["headerSha256"]??"","^[a-f0-9]{64}$")
                    ||(string?)origin["schema"]!="ssam-odc-write/1"||(string?)origin["operationUuid"]!=creation
                    ||(string?)origin["state"]!="uncertain"||(string?)origin["identity"]?["tenant"]!=host
                    ||(string?)origin["identity"]?["operationId"]!=PortalApiClientSecret.Operation
                    ||(string?)origin["identity"]?["target"]?["apiClientFixtureName"]!=name
                    ||(string?)origin["reconciliation"]?["apiClientFixture"]?["name"]!=name
                    ||origin["response"]?["ApiClientProof"]!=null||(string?)origin["authorization"]?["wordsSha256"]!=words
                    ||origin["authorization"]?["source"]==null
                    ||!JsonNode.DeepEquals(origin["authorization"]?["source"],receipt["authorization"]?["source"]))throw Bad();
            }else{
                var native=Read(nativeFile);var proof=native["proof"];
                key=Uuid(proof?["key"]);name=(string?)proof?["name"];
                if((string?)native["schema"]!="ssam-native-api-client-fixture/1"||(string?)native["host"]!=host
                ||!string.Equals((string?)native["user"],user,StringComparison.OrdinalIgnoreCase)||(string?)native["authorizeSha256"]!=words
                ||(string?)proof?["operationUuid"]!=creation||(string?)proof?["vaultRef"]!="urn:ssam:api-client:"+creation
                ||(bool?)proof?["rawValueExposed"]!=false||(bool?)proof?["responseProjected"]!=true
                )throw Bad();
            }
            if(name==null||!Regex.IsMatch(name,"^SSAMApiClientProof[0-9]{8}[A-Za-z0-9]{0,16}$"))throw Bad();
            var reservation=Read(Path.Combine(writesDir,creation+".json"));
            if((string?)reservation["operationId"]!=PortalApiClientSecret.Operation||(string?)reservation["path"]!=PortalApiClientSecret.Path
                ||(string?)reservation["host"]!=host||!string.Equals((string?)reservation["user"],user,StringComparison.OrdinalIgnoreCase)
                ||(string?)reservation["authorizeSha256"]!=words||(string?)reservation["source"]!="private-session-pipe")throw Bad();
            var observations=receipt["reconciliations"] as JsonArray;
            var observation=observations is {Count:>0}?observations[^1]?["observation"]:null;
            if((string?)receipt["schema"]!="ssam-odc-write/1"||(string?)receipt["operationUuid"]!=deletion||(string?)receipt["state"]!="confirmed"
                ||(string?)receipt["identity"]?["tenant"]!=host||(string?)receipt["identity"]?["operationId"]!="apiClients.delete"
                ||(string?)receipt["identity"]?["target"]?["apiClientKey"]!=key||(string?)receipt["authorization"]?["wordsSha256"]!=words
                ||receipt["authorization"]?["source"]==null||(string?)expected?["creationOperationUuid"]!=creation
                ||(string?)expected?["key"]!=key||(string?)expected?["name"]!=name
                ||(bool?)observation?["verified"]!=true||(bool?)observation?["inventoryComplete"]!=true
                ||(string?)observation?["scope"]!="complete-unfiltered-api-client-inventory"
                ||(string?)observation?["key"]!=key||(string?)observation?["name"]!=name)throw Bad();
            var cacheFile=Path.Combine(writesDir,"api-client-cleanup",deletion+".json");
            var target=PortalApiClientSecret.Target(host,creation);
            if(missingCapture&&vault(target)!=null)return PortalCore.Fail("UNCERTAIN","A partial creation has an existing fixture credential without its capture proof; no local deletion was attempted.");
            var answer=new JsonObject {["ok"]=true,["host"]=host,["user"]=user,["key"]=key,["name"]=name,
                ["creationOperationUuid"]=creation,["deletionOperationUuid"]=deletion,["vaultRemoved"]=true,
                ["remoteDeletionVerified"]=true,["rawValueExposed"]=false};
            if(File.Exists(cacheFile)){
                var cache=Read(cacheFile);
                if((string?)cache["host"]!=host||(string?)cache["creationOperationUuid"]!=creation||(string?)cache["key"]!=key)throw Bad();
                // After a lost answer, observe the vault instead of deleting twice.
                if(vault(target)!=null)return PortalCore.Fail("UNCERTAIN","A previous fixture cleanup has no confirmed absence; no deletion was repeated.");
            }else{
                Save(cacheFile,new JsonObject {["state"]="attempted",["host"]=host,["creationOperationUuid"]=creation,["key"]=key},true);
                if(vault(target)!=null){remove(target);if(vault(target)!=null)return PortalCore.Fail("UNCERTAIN","Fixture credential absence could not be confirmed; inspect the original cleanup.");}
            }
            Save(cacheFile,answer);return answer;
        }catch(PortalCore.Refusal refusal){return PortalCore.Fail(refusal.Code,refusal.Message);}
        catch{return PortalCore.Fail("UNCERTAIN","Fixture vault cleanup did not preserve a conclusive result; no private value is exposed.");}
    }
}
