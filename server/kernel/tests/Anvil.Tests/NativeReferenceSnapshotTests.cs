using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class NativeReferenceSnapshotTests
{
    [Fact]
    public void SameNamedBlocksRequireAQualifiedPathOrOriginalKeyAndIncludeTheirFlow()
    {
        StudioAssemblies.Bind(); QualifiedBlocks();
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void QualifiedBlocks()
    {
        string Key()=>OutSystems.ObjectKeys.ObjectKey.NewKey().ToString();
        var left=Key();var right=Key();var card=Key();
        var raw=Fixture() with {
            FormatVersion=2,
            Attestation=new(){Source=NativeReferenceAttestation.ProducerOml},
            Elements=[new("mobile-flow","Left",left),new("mobile-flow","Right",right),
                new("mobile-block","Card",card,ParentKey:left,Path:"Left/Card"),
                new("mobile-block","Card",Key(),ParentKey:right,Path:"Right/Card")] };
        var kind=typeof(NativeReferenceSnapshot).GetProperty("ModuleKind")!;
        kind.SetValue(raw,Enum.Parse(kind.PropertyType,"eSpace"));
        var snapshot=NativeReferenceSnapshot.Create(raw);
        Assert.Throws<ArgumentException>(()=>snapshot.Select("IBlock:Card"));
        Assert.Equal(card,snapshot.Select("IBlock:Left/Card").Key);
        Assert.Equal(card,snapshot.Select("IBlock:@"+card).Key);
        Assert.Equal(2,snapshot.WithClosure([snapshot.Select("IBlock:Left/Card")]).Count);
        Assert.Throws<ArgumentException>(()=>NativeReferenceSnapshot.Create(snapshot with {
            Elements=[new("mobile-flow","Left",left),new("mobile-block","Card",card,ParentKey:left,Path:"Wrong/Card")] }));
        Assert.Throws<ArgumentException>(()=>NativeReferenceSnapshot.Create(snapshot with {
            Elements=[new("mobile-block","Card",card)] }));
    }
    [Theory]
    [InlineData("another.example")]
    [InlineData(null)]
    public void DeliveryRejectsForeignOrUnknownEnvironmentBeforeSnapshot(string? environment)
    {
        StudioAssemblies.Bind(); RejectDelivery(environment);
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RejectDelivery(string? environment)
    {
        var work=Work();var producer=Path.Combine(work,"primitive.avsig");Fixture().Write(producer);
        var job=Path.Combine(work,"job.json");File.WriteAllText(job,"{\"ops\":[]}");
        var bridge=new EnvironmentBridge(environment);var applied=false;
        var result=Delivery.Run(bridge,new DeliveryRequest("Probe",job,work,[],new Dictionary<string,string>{{"Primitive",producer}}),
            (input,source,output)=>{applied=true;throw new Exception("Must not apply");});
        Assert.False(applied);Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("another environment",result["error"]!.ToString());
        Assert.Equal(new[]{"open_module","get_active_module"},bridge.Calls);
    }
    private sealed class EnvironmentBridge(string? environment):IBridgeClient
    {
        public List<string> Calls {get;}=[];
        public JsonObject Call(string method,JsonObject? parameters=null)
        {
            Calls.Add(method);return method switch {
                "open_module"=>new(){["opened"]=true},
                "get_active_module"=>new(){["name"]="Probe",["key"]="module-key",["environment"]=environment},
                _=>throw new Exception("Unexpected bridge call: "+method)
            };
        }
    }
    [Fact]
    public void SnapshotEnvelopeRoundtripRetainsIdentityAndRejectsUnknownSelections()
    {
        StudioAssemblies.Bind(); Roundtrip();
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Roundtrip()
    {
        var expected=Fixture(); var path=Path.Combine(Work(),"signature.avsig"); expected.Write(path);
        var actual=NativeReferenceSnapshot.Read(path);
        Assert.Equal(expected.ModuleKey,actual.ModuleKey);
        Assert.Equal(expected.SignatureHash,actual.SignatureHash);
        Assert.Equal(expected.SignatureBinary,actual.SignatureBinary);
        Assert.Equal(expected.Elements[0],actual.Select("IServerActionSignature:CompareOrdinal"));
        Assert.Throws<ArgumentException>(()=>actual.Select("IServerActionSignature:Missing"));
        Assert.Throws<ArgumentException>(()=>actual.Select("IClientAction:CompareOrdinal"));
        Assert.StartsWith("IServerActionSignature:@",actual.Bind("IServerActionSignature:CompareOrdinal"));
        actual.RequireEnvironment("LAB.EXAMPLE");
        Assert.Throws<InvalidOperationException>(()=>actual.RequireEnvironment("another.example"));
        Assert.Throws<InvalidOperationException>(()=>actual.RequireEnvironment(null));
    }
    [Theory]
    [InlineData("unknown-field")]
    [InlineData("version")]
    [InlineData("kind")]
    [InlineData("empty-signature")]
    [InlineData("null-signature")]
    [InlineData("duplicate-name")]
    [InlineData("duplicate-key")]
    [InlineData("unattested")]
    [InlineData("legacy-attested")]
    [InlineData("server-without-version")]
    [InlineData("system-without-hash")]
    [InlineData("guard-kind")]
    [InlineData("unknown-source")]
    [InlineData("foreign-closure")]
    public void MalformedEnvelopeCannotBecomeAnAcceptedProducer(string fault)
    {
        StudioAssemblies.Bind(); Reject(fault);
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Reject(string fault)
    {
        var path=Path.Combine(Work(),"signature.avsig"); Fixture().Write(path);
        var json=JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        switch(fault)
        {
            case "unknown-field":json["IgnoreValidation"]=true;break;
            case "version":json["FormatVersion"]=3;break;
            case "kind":json["ModuleKind"]="eSpace";break;
            // Version 2 exists only with an attestation; a bare version bump cannot upgrade a legacy envelope.
            case "unattested":json["FormatVersion"]=2;break;
            case "legacy-attested":json["Attestation"]=new JsonObject{["Source"]="server-signature",["VersionId"]=7,["Guard"]="extension-version",["CapturedAtUtc"]="2026-09-26T00:00:00Z"};break;
            case "server-without-version":json["FormatVersion"]=2;json["Attestation"]=new JsonObject{["Source"]="server-signature",["Guard"]="extension-version",["CapturedAtUtc"]="2026-09-26T00:00:00Z"};break;
            case "system-without-hash":json["FormatVersion"]=2;json["ModuleKind"]="eSpace";json["Attestation"]=new JsonObject{["Source"]="server-signature",["IsSystem"]=true,["Guard"]="signature-hash",["CapturedAtUtc"]="2026-09-26T00:00:00Z"};break;
            case "guard-kind":json["FormatVersion"]=2;json["ModuleKind"]="eSpace";json["Attestation"]=new JsonObject{["Source"]="server-signature",["VersionId"]=7,["Guard"]="extension-version",["CapturedAtUtc"]="2026-09-26T00:00:00Z"};break;
            case "unknown-source":json["FormatVersion"]=2;json["Attestation"]=new JsonObject{["Source"]="handwritten"};break;
            case "foreign-closure":json["FormatVersion"]=2;json["Attestation"]=new JsonObject{["Source"]="producer-oml"};json["Elements"]![0]!["Requires"]=new JsonArray(OutSystems.ObjectKeys.ObjectKey.NewKey().ToString());break;
            case "empty-signature":json["SignatureBinary"]="";break;
            case "null-signature":json["SignatureBinary"]=null;break;
            case "duplicate-name":
                var named=json["Elements"]![0]!.DeepClone();named["Name"]="compareordinal";named["Key"]=OutSystems.ObjectKeys.ObjectKey.NewKey().ToString();json["Elements"]!.AsArray().Add(named);break;
            case "duplicate-key":
                var keyed=json["Elements"]![0]!.DeepClone();keyed["Name"]="Other";json["Elements"]!.AsArray().Add(keyed);break;
        }
        File.WriteAllText(path,json.ToJsonString());
        Assert.ThrowsAny<Exception>(()=>NativeReferenceSnapshot.Read(path));
    }
    // The External Library form is ODC-only: the O11 ReferenceKind has no ExternalLibrary member, so this build cannot even
    // read such an envelope (the ODC build accepts it: OdcExternalLibraryTests), and an unattested extension stays refused.
    [Fact]
    public void O11NeverReadsAnExternalLibraryEnvelopeAndStillRefusesAnUnattestedExtension()
    {
        StudioAssemblies.Bind(); O11ExternalLibrary();
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void O11ExternalLibrary()
    {
        var path = Path.Combine(Work(), "signature.avsig"); Fixture().Write(path);
        var json = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        json["FormatVersion"] = 2; json["ModuleKind"] = NativeReferenceSnapshot.ExternalLibraryKind;
        json["Elements"] = new JsonArray(new JsonObject { ["Kind"] = "action", ["Name"] = "Reverse", ["Key"] = OutSystems.ObjectKeys.ObjectKey.NewKey().ToString() },
            new JsonObject { ["Kind"] = "structure", ["Name"] = "WordCount", ["Key"] = OutSystems.ObjectKeys.ObjectKey.NewKey().ToString() });
        File.WriteAllText(path, json.ToJsonString());
        Assert.ThrowsAny<Exception>(() => NativeReferenceSnapshot.Read(path));
        json["ModuleKind"] = "Extension"; File.WriteAllText(path, json.ToJsonString());
        Assert.ThrowsAny<Exception>(() => NativeReferenceSnapshot.Read(path));
        Assert.False(Fixture().IsExternalLibrary);
    }
    private static NativeReferenceSnapshot Fixture()
    {
        var path=Path.Combine(Work(),"fixture.avsig");
        var json=new JsonObject {
            ["Environment"]="lab.example",["ModuleKey"]=OutSystems.ObjectKeys.ObjectKey.NewKey().ToString(),["ApplicationKey"]="",["Name"]="Primitives",
            ["ModuleKind"]="Extension",["SignatureHash"]=Guid.NewGuid().ToString(),["SignatureBinary"]=Convert.ToBase64String([1,2,3]),
            ["Elements"]=new JsonArray(new JsonObject {["Kind"]="action",["Name"]="CompareOrdinal",["Key"]=OutSystems.ObjectKeys.ObjectKey.NewKey().ToString()})
        };
        File.WriteAllText(path,json.ToJsonString());return NativeReferenceSnapshot.Read(path);
    }
    private static string Work()
    {
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceSnapshotTests).Assembly.Location)!)!;
        var path=Path.Combine(root,".local/native-reference-envelope-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(path);return path;
    }
}
