using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class DependencyFamiliesTests
{
    [Theory]
    [InlineData("IRole", "Operator", "reactive-ui.oml")]
    [InlineData("IScript", "Formatter", "reactive-ui.oml")]
    [InlineData("IMobileBlock", "Card", "reactive-ui.oml")]
    [InlineData("IWebBlock", "Card", "traditional-ui.oml")]
    [InlineData("IResource", "Payload", "reactive-ui.oml")]
    [InlineData("IMobileTheme", "ExportTheme", "reactive-ui.oml")]
    [InlineData("IWebTheme", "ExportTheme", "traditional-ui.oml")]
    public void CapturedPublicFamiliesImportSaveReloadAndRefresh(string type,string name,string fixture)
    { StudioAssemblies.Bind(); Import(type,name,fixture); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Import(string type,string name,string fixture)
    {
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DependencyFamiliesTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/dependency-family-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var host=new ModelHost(work);var basis=Path.Combine(root,"tests/fixtures",fixture);
        var ops=new JsonArray();
        string parent="@espace";
        if(type is "IMobileBlock" or "IWebBlock") {
            ops.Add(JsonNode.Parse($$"""{"op":"create","parent":"@espace","type":"{{(type=="IMobileBlock"?"IMobileFlow":"IWebFlow")}}","name":"Exports","as":"$flow"}"""));
            parent="$flow";
        }
        ops.Add(JsonNode.Parse($$"""{"op":"create","parent":"{{parent}}","type":"{{type}}","name":"{{name}}","as":"$export"}"""));
        ops.Add(JsonNode.Parse("""{"op":"set","target":"$export","prop":"Public","value":true}"""));
        if(type=="IScript")ops.Add(JsonNode.Parse("""{"op":"set","target":"$export","prop":"JavaScript","value":"var formatter = 1;"}"""));
        if(type is "IMobileTheme" or "IWebTheme")ops.Add(JsonNode.Parse("""{"op":"set","target":"$export","prop":"StyleSheet","value":".exported { color: red; }"}"""));
        // A consumer cannot reference itself. Clone the producer through the native API,
        // retaining fixture provenance while acquiring a distinct module identity.
        var clone=System.Reflection.Assembly.Load("ServiceStudio.Framework").GetType("ServiceStudio.Model.ESpace")!.GetMethods()
            .Single(m=>m.Name=="Clone" && m.IsStatic && m.GetParameters().Length==9);
        Action<object> rename=m=>m.GetType().GetMethod("SetName",[typeof(string)])!.Invoke(m,["DependencyProducer"]);
        var callback=Delegate.CreateDelegate(clone.GetParameters()[5].ParameterType,rename.Target,rename.Method);
        using var bytes=new MemoryStream(File.ReadAllBytes(basis));
        // Initialize the headless runtime before calling the native cloning API.
        _=host.Inspect(basis);
        var module=clone.Invoke(null,[bytes,null,null,null,false,callback,null,false,false])!;
        var producerBase=Path.Combine(work,"producer-base.oml");
        try {File.WriteAllBytes(producerBase,(byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host,[module])!);}
        finally {typeof(ModelHost).GetMethod("Release")!.Invoke(null,[module]);}
        var producer=Run("producer",producerBase,ops);
        var selector=type+":"+(parent=="$flow"?"Exports/":"")+name;
        var capture=SignatureFixtures.FromProducerOml(producer,[selector]);var avsig=Path.Combine(work,"producer.avsig");capture.Snapshot.Write(avsig);
        var listed=NativeDependencyReader.ListServerSignature(capture.Snapshot.ModuleKey,capture.Snapshot.Name,capture.Snapshot.SignatureBinary);
        Assert.Contains(listed,e=>e.Name==name && e.Kind==NativeReferenceSnapshot.KindOf(type));
        var signatureImport=NativeReferenceKinds.ForType(type)!.SignatureImport;
        var bindings=new Dictionary<string,string>{{"Exports",signatureImport ? avsig : producer}};
        if(!signatureImport) {
            var forbiddenJob=Path.Combine(work,"unsupported-signature-import.json");
            var forbiddenOut=Path.Combine(work,"unsupported-signature-import.oml");
            File.WriteAllText(forbiddenJob,new JsonObject{["ops"]=new JsonArray(new JsonObject {
                ["op"]="reference",["producer"]="Exports",["elements"]=new JsonArray(selector) })}.ToJsonString());
            var failure=Assert.ThrowsAny<Exception>(()=>JobRunner.Run(host,basis,forbiddenJob,forbiddenOut,
                bindings:new Dictionary<string,string>{{"Exports",avsig}}));
            Assert.Contains("producer OML binding",failure.ToString());
            Assert.False(File.Exists(forbiddenOut));
        }
        var consumer=Run("consumer",basis,new JsonArray(new JsonObject{["op"]="reference",["producer"]="Exports",["elements"]=new JsonArray(selector)}),bindings);
        Assert.True(host.Inspect(consumer).IsValid);
        var refreshed=Run("refreshed",consumer,new JsonArray(new JsonObject{["op"]="reference",["producer"]="Exports",["elements"]=signatureImport ? new JsonArray() : new JsonArray(selector)}),bindings);
        Assert.True(host.Inspect(refreshed).IsValid);
        var read=NativeReferenceSnapshot.Read(avsig);Assert.Equal(name,read.Select(selector).Name);
        Assert.Equal(name,read.Select(type+":@"+read.Select(selector).Key).Name);
        string Run(string file,string from,JsonArray steps,Dictionary<string,string>? bound=null) {
            var job=Path.Combine(work,file+".json");var output=Path.Combine(work,file+".oml");
            var spec=new JsonObject{["ops"]=steps};
            if(type=="IResource" && file=="producer")spec["expectedMessages"]=new JsonArray(new JsonObject {
                ["id"]="UnusedResource",["element"]="DependencyProducer (ESpace) / Payload (Resource)",
                ["why"]="Export fixture intentionally has no usage inside its producer." });
            File.WriteAllText(job,spec.ToJsonString());
            var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,from,job,output,bindings:bound))!;
            Assert.True(result["accepted"]!.GetValue<bool>(),result.ToJsonString());
            Assert.True(result["isValid"]!.GetValue<bool>(),result.ToJsonString());
            return output;
        }
    }
}
