using System.Text.Json.Nodes;
using Xunit;

public sealed class PortalApiClientCleanupTests {
    private sealed class Fixture : IDisposable {
        internal readonly string Dir=Path.Combine(Path.GetTempPath(),"ssam-api-client-cleanup-"+Guid.NewGuid().ToString("N"));
        internal readonly string Host="personal-test.outsystems.dev",User="user@example.test",Creation=Guid.NewGuid().ToString(),Deletion=Guid.NewGuid().ToString(),Key=Guid.NewGuid().ToString(),Hash=new('a',64);
        internal const string Name="SSAMApiClientProof20261010",Secret="SyntheticPrivateClientSecret12345";
        internal string Writes=>Path.Combine(Dir,"writes");internal string Receipts=>Path.Combine(Dir,"receipts");
        internal bool Exists=true,FailRemove,ThrowAfterRemove;internal int Removes;
        internal JsonObject Request=>new(){["schema"]="ssam-api-client-fixture-cleanup/1",["creationOperationUuid"]=Creation,["deletionOperationUuid"]=Deletion,["authorizeSha256"]=Hash};
        internal PortalCore.WebRequest CreateRequest=>PortalCore.ParseWebRequest(new JsonObject{["operationId"]=PortalApiClientSecret.Operation,["method"]="POST",["path"]=PortalApiClientSecret.Path,
            ["write"]=true,["operationUuid"]=Creation,["authorizeSha256"]=Hash,["confirmTenant"]=Host,["body"]=new JsonObject{["inputParameters"]=new JsonObject{["OIDCClientCreate"]=new JsonObject{["Name"]=Name}}}}.ToJsonString());
        internal JsonObject Proof=>new(){["key"]=Key,["name"]=Name,["operationUuid"]=Creation,["vaultRef"]="urn:ssam:api-client:"+Creation,["vaultStored"]=true,["rawValueExposed"]=false,["responseProjected"]=true};
        internal Fixture(){
            Directory.CreateDirectory(Writes);Directory.CreateDirectory(Receipts);
            PortalApiClientCleanup.Record(Writes,Host,User,CreateRequest,Proof);
            File.WriteAllText(Path.Combine(Writes,Creation+".json"),new JsonObject{["operationId"]=PortalApiClientSecret.Operation,["path"]=PortalApiClientSecret.Path,["host"]=Host,["user"]=User,["authorizeSha256"]=Hash,["source"]="private-session-pipe"}.ToJsonString());
            File.WriteAllText(Path.Combine(Receipts,Deletion+".json"),new JsonObject{
                ["schema"]="ssam-odc-write/1",["operationUuid"]=Deletion,["state"]="confirmed",
                ["identity"]=new JsonObject{["tenant"]=Host,["operationId"]="apiClients.delete",["target"]=new JsonObject{["apiClientKey"]=Key}},
                ["authorization"]=new JsonObject{["wordsSha256"]=Hash,["source"]=new JsonObject{["threadId"]=Guid.NewGuid().ToString(),["messageId"]=Guid.NewGuid().ToString()}},
                ["reconciliation"]=new JsonObject{["apiClientFixture"]=new JsonObject{["creationOperationUuid"]=Creation,["key"]=Key,["name"]=Name}},
                ["reconciliations"]=new JsonArray(new JsonObject{["observation"]=new JsonObject{["verified"]=true,["inventoryComplete"]=true,["scope"]="complete-unfiltered-api-client-inventory",["key"]=Key,["name"]=Name}})
            }.ToJsonString());
        }
        internal PortalCore.VaultEntry? Read(string target){Assert.Equal(PortalApiClientSecret.Target(Host,Creation),target);if(ThrowAfterRemove&&Removes>0)throw new IOException("Synthetic private transport text "+Secret);return Exists?new("synthetic-client",Secret):null;}
        internal bool Remove(string target){Assert.Equal(PortalApiClientSecret.Target(Host,Creation),target);Removes++;if(!FailRemove)Exists=false;return !FailRemove;}
        internal JsonObject Cleanup(JsonObject? request=null,string? host=null,string? user=null)=>PortalApiClientCleanup.Cleanup(Writes,Receipts,request??Request,host??Host,user??User,Remove,Read);
        internal void Change(string path,Action<JsonObject> change){var file=Path.Combine(Dir,path.Replace('/',Path.DirectorySeparatorChar));var value=JsonNode.Parse(File.ReadAllText(file))!.AsObject();change(value);File.WriteAllText(file,value.ToJsonString());}
        public void Dispose()=>Directory.Delete(Dir,true);
    }
    [Fact] public void CleanupDeletesOnlyOwnedTargetAndRepeatedCallObservesAbsence(){
        using var f=new Fixture();var result=f.Cleanup();Assert.True((bool?)result["ok"]);Assert.True((bool?)result["vaultRemoved"]);Assert.Equal(1,f.Removes);
        Assert.True((bool?)f.Cleanup()["ok"]);Assert.Equal(1,f.Removes);Assert.False(f.Exists);
        foreach(var file in Directory.GetFiles(f.Dir,"*",SearchOption.AllDirectories))Assert.DoesNotContain(Fixture.Secret,File.ReadAllText(file));
    }
    [Theory][InlineData("accepted")][InlineData("uncertain")][InlineData("filtered")][InlineData("incomplete")][InlineData("unverified")][InlineData("foreign-key")][InlineData("foreign-host")][InlineData("foreign-origin")][InlineData("different-words")][InlineData("missing-source")]
    public void InvalidDeletionCannotTouchVault(string kind){
        using var f=new Fixture();f.Change("receipts/"+f.Deletion+".json",r=>{
            if(kind is "accepted" or "uncertain")r["state"]=kind;
            else if(kind=="filtered")r["reconciliations"]![0]!["observation"]!["scope"]="filtered-inventory";
            else if(kind=="incomplete")r["reconciliations"]![0]!["observation"]!["inventoryComplete"]=false;
            else if(kind=="unverified")r["reconciliations"]![0]!["observation"]!["verified"]=false;
            else if(kind=="foreign-key")r["identity"]!["target"]!["apiClientKey"]=Guid.NewGuid().ToString();
            else if(kind=="foreign-host")r["identity"]!["tenant"]="foreign.outsystems.dev";
            else if(kind=="foreign-origin")r["reconciliation"]!["apiClientFixture"]!["creationOperationUuid"]=Guid.NewGuid().ToString();
            else if(kind=="different-words")r["authorization"]!["wordsSha256"]=new string('b',64);
            else r["authorization"]!.AsObject().Remove("source");
        });
        Assert.False((bool?)f.Cleanup()["ok"]);Assert.Equal(0,f.Removes);Assert.True(f.Exists);
    }
    [Theory][InlineData(false)][InlineData(true)] public void LostOrFailedCleanupNeverDeletesTwice(bool lost){
        using var f=new Fixture();f.FailRemove=!lost;f.ThrowAfterRemove=lost;
        var first=f.Cleanup();Assert.False((bool?)first["ok"]);Assert.Equal("UNCERTAIN",(string?)first["code"]);Assert.DoesNotContain(Fixture.Secret,first.ToJsonString());Assert.Equal(1,f.Removes);
        f.ThrowAfterRemove=false;var resumed=f.Cleanup();Assert.Equal(lost,(bool?)resumed["ok"]);Assert.Equal(1,f.Removes);
    }
    [Fact] public void SignInTargetsAndForeignSessionsCannotBeSelected(){
        using var f=new Fixture();Assert.False((bool?)f.Cleanup(user:"other@example.test")["ok"]);Assert.False((bool?)f.Cleanup(host:"foreign.outsystems.dev")["ok"]);
        var request=f.Request;request["target"]="SSAM/ODC3/"+f.Host+"/APIClient";Assert.False((bool?)f.Cleanup(request)["ok"]);Assert.Equal(0,f.Removes);
    }
    [Fact] public void CaptureRecordsPublicIdentityBeforeStoringAndDropsUnexpectedEchoFields(){
        using var f=new Fixture();File.Delete(Path.Combine(f.Writes,f.Creation+".api-client.json"));var calls=0;
        var response=new JsonObject{["data"]=new JsonObject{["Key"]=f.Key,["ClientId"]="synthetic-client",["ClientSecret"]=Fixture.Secret,["Echo"]=Fixture.Secret}};
        var proof=PortalApiClientSecret.Capture(response,f.CreateRequest,f.Host,(target,id,secret)=>{calls++;var record=File.ReadAllText(Path.Combine(f.Writes,f.Creation+".api-client.json"));Assert.Contains(f.Key,record);Assert.DoesNotContain(Fixture.Secret,record);return true;},
            p=>PortalApiClientCleanup.Record(f.Writes,f.Host,f.User,f.CreateRequest,p));
        Assert.Equal(1,calls);Assert.True((bool?)proof["vaultStored"]);Assert.DoesNotContain(Fixture.Secret,File.ReadAllText(Path.Combine(f.Writes,f.Creation+".api-client.json")));
        Assert.Throws<IOException>(()=>PortalApiClientSecret.Capture(response,f.CreateRequest,f.Host,(a,b,c)=>{calls++;return true;},p=>throw new IOException("record unavailable")));Assert.Equal(1,calls);
    }
    private static void Partial(Fixture f){
        File.Delete(Path.Combine(f.Writes,f.Creation+".api-client.json"));
        var deletion=JsonNode.Parse(File.ReadAllText(Path.Combine(f.Receipts,f.Deletion+".json")))!;
        f.Change("receipts/"+f.Deletion+".json",r=>{var e=r["reconciliation"]!["apiClientFixture"]!;e["cleanupMode"]="pending-header";e["privateCaptureProven"]=false;e["baselineSha256"]=new string('b',64);e["headerSha256"]=new string('c',64);});
        File.WriteAllText(Path.Combine(f.Receipts,f.Creation+".json"),new JsonObject{
            ["schema"]="ssam-odc-write/1",["operationUuid"]=f.Creation,["state"]="uncertain",
            ["identity"]=new JsonObject{["tenant"]=f.Host,["operationId"]=PortalApiClientSecret.Operation,["target"]=new JsonObject{["apiClientFixtureName"]=Fixture.Name}},
            ["authorization"]=deletion["authorization"]!.DeepClone(),["response"]=new JsonObject(),
            ["reconciliation"]=new JsonObject{["apiClientFixture"]=new JsonObject{["name"]=Fixture.Name}}
        }.ToJsonString());
    }
    [Theory][InlineData(false)][InlineData(true)] public void MissingCaptureOnlyObservesExactVaultTargetWithoutDeleting(bool exists){
        using var f=new Fixture();Partial(f);f.Exists=exists;
        var result=f.Cleanup();Assert.Equal(!exists,(bool?)result["ok"]);Assert.Equal(0,f.Removes);Assert.Equal(exists,f.Exists);
        Assert.Equal(!exists,(bool?)f.Cleanup()["ok"]);Assert.Equal(0,f.Removes);
    }
    [Theory][InlineData("state")][InlineData("source")][InlineData("name")][InlineData("proof")][InlineData("mode")][InlineData("hash")][InlineData("capture")]
    public void MissingCaptureRefusesUnboundOriginOrCleanup(string kind){
        using var f=new Fixture();Partial(f);f.Exists=false;
        if(kind is "mode" or "hash" or "capture")f.Change("receipts/"+f.Deletion+".json",r=>{
            var e=r["reconciliation"]!["apiClientFixture"]!;
            if(kind=="mode")e["cleanupMode"]="normal";else if(kind=="hash")e["baselineSha256"]="invalid";else e["privateCaptureProven"]=true;
        });else f.Change("receipts/"+f.Creation+".json",r=>{
            if(kind=="state")r["state"]="accepted";else if(kind=="source")r["authorization"]!["source"]!["messageId"]=Guid.NewGuid().ToString();
            else if(kind=="name")r["identity"]!["target"]!["apiClientFixtureName"]="Other";else r["response"]!["ApiClientProof"]=new JsonObject();
        });
        Assert.False((bool?)f.Cleanup()["ok"]);Assert.Equal(0,f.Removes);
    }
}
