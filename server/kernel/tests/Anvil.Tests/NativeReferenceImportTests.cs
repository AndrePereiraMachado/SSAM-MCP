using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class NativeReferenceImportTests
{
    [Fact]
    public void FrozenImportPreservesNativeCallsKeysAndConsumerAliasesAfterReload()
    {
        StudioAssemblies.Bind();var (root,work)=Work();var host=new ModelHost(work);
        var signature=Path.Combine(root,"tests/contracts/native-reference/ordinal-primitive.avsig");
        (string Path,JsonNode Result) Apply(string name,string basis,JsonArray ops)
        {
            var job=Path.Combine(work,name+".json");var output=Path.Combine(work,name+".oml");File.WriteAllText(job,new JsonObject{["ops"]=ops}.ToJsonString());
            var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,output,bindings:new Dictionary<string,string>{{"Primitive",signature}}))!;
            Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
            Assert.True(host.Inspect(output).IsValid);return(output,result);
        }
        JsonObject Find(string name)=>new(){["op"]="find",["name"]=name};
        var first=Apply("first",Path.Combine(root,"tests/fixtures/blank-service.oml"),new JsonArray(Reference(),JsonNode.Parse(Declaration),Find("CSharpTextCompareOrdinal"),Find("ZZHighCodePrimitives")));
        string Key(JsonNode result,int index)=>result["results"]![index]!["result"]!.AsArray().Single()!["key"]!.ToString();
        var actionKey=Key(first.Result,2);var referenceKey=Key(first.Result,3);
        var renamed=Apply("rename",first.Path,new JsonArray(
            new JsonObject{["op"]="rename",["target"]="@"+actionKey,["name"]="ConsumerOrdinal"},
            new JsonObject{["op"]="rename",["target"]="@"+referenceKey,["name"]="ConsumerPrimitives"}));
        var repeated=Apply("repeat",renamed.Path,new JsonArray(Reference(),Find("ConsumerOrdinal"),Find("ConsumerPrimitives")));
        Assert.Equal(actionKey,Key(repeated.Result,1));Assert.Equal(referenceKey,Key(repeated.Result,2));
        Assert.Equal(0,repeated.Result["results"]![0]!["result"]!["added"]!.GetValue<int>());
        Assert.True(repeated.Result["results"]![0]!["result"]!["referenceExisted"]!.GetValue<bool>());
        // Force the native refresh path, as happens when a producer revision changes.
        // Reflection keeps vendor assemblies out of the test output; binding precedes access.
        var module=typeof(ModelHost).GetMethod("Load",[typeof(string)])!.Invoke(host,[repeated.Path])!;
        var stale=Path.Combine(work,"stale.oml");
        try
        {
            Action<object> invalidate=m=>{
                var references=((System.Collections.IEnumerable)ModelHost.Prop(m,"References")!).Cast<object>();
                var reference=references.Single(r=>ModelHost.Prop(r,"Name")?.ToString()=="ConsumerPrimitives");
                reference.GetType().GetProperty("ReferenceHash")!.SetValue(reference,Guid.Empty);
            };
            var mutate=typeof(Publisher).GetMethod("Mutate")!;
            var callback=Delegate.CreateDelegate(mutate.GetParameters()[2].ParameterType,invalidate.Target,invalidate.Method);
            mutate.Invoke(null,[module,"Invalidate reference for refresh regression",callback]);
            File.WriteAllBytes(stale,(byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host,[module])!);
        }
        finally{typeof(ModelHost).GetMethod("Release")!.Invoke(null,[module]);}
        var refreshed=Apply("refresh",stale,new JsonArray(Reference(),Find("ConsumerOrdinal"),Find("ConsumerPrimitives")));
        Assert.Equal(actionKey,Key(refreshed.Result,1));Assert.Equal(referenceKey,Key(refreshed.Result,2));
        var bound=Bind(signature);var boundDeclaration=JsonNode.Parse(Declaration)!;
        boundDeclaration["data"]!["actions"]![0]!["name"]="BoundComparison";
        boundDeclaration["data"]!["actions"]![0]!["access"]=new JsonObject{["authenticated"]=true};
        boundDeclaration["data"]!["actions"]![0]!["steps"]![0]!["call"]=bound;
        var contract=new JsonObject{["logic"]=boundDeclaration["data"]!.DeepClone()};
        var boundResult=Apply("bound-call",refreshed.Path,host.PlanModuleSpecification(refreshed.Path,contract));
        var verification=host.CheckModuleSpecification(boundResult.Path,contract);
        Assert.True(verification["accepted"]!.GetValue<bool>(),verification["differences"]!.ToJsonString());
        // The independent reader must reject a callee from another original identity,
        // even when the action has the same shape and local name.
        var wrong=contract.DeepClone().AsObject();wrong["logic"]!["actions"]![0]!["steps"]![0]!["call"]=bound[..(bound.IndexOf('/')+1)]+Guid.NewGuid();
        Assert.False(host.CheckModuleSpecification(boundResult.Path,wrong)["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void AFrozenReferenceAfterTheEditsIsHoistedAndLeavesTheBaseUntouched()
    {
        // C09: a reference written after the action that calls its import is applied before the edits, never refused.
        StudioAssemblies.Bind();var (root,work)=Work();var host=new ModelHost(work);
        var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");var before=SHA256.HashData(File.ReadAllBytes(basis));
        var signature=Path.Combine(root,"tests/contracts/native-reference/ordinal-primitive.avsig");
        var result=ApplyBound(host,work,"late-reference",basis,new JsonArray(JsonNode.Parse(Declaration),Reference(),new JsonObject{["op"]="find",["name"]="CSharpTextCompareOrdinal"}),
            new Dictionary<string,string>{{"Primitive",signature}});
        Assert.Equal(new[]{1},result["hoistedReferences"]!.AsArray().Select(i=>i!.GetValue<int>()));
        Assert.Single(result["results"]![2]!["result"]!.AsArray());
        Assert.Equal(before,SHA256.HashData(File.ReadAllBytes(basis)));
    }

    [Theory]
    [InlineData("missing-element","not declared")]
    [InlineData("wrong-key","not a visible element")]
    [InlineData("failed-edit","Absent")]
    public void InvalidImportDoesNotWriteOutputOrModifyBase(string scenario,string expected)
    {
        StudioAssemblies.Bind();var (root,work)=Work();var host=new ModelHost(work);
        var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");var before=SHA256.HashData(File.ReadAllBytes(basis));
        var signature=Path.Combine(root,"tests/contracts/native-reference/ordinal-primitive.avsig");var ops=new JsonArray(Reference());
        if(scenario=="missing-element")ops[0]!["elements"]=new JsonArray("IServerActionSignature:Absent");
        if(scenario=="wrong-key")
        {
            var envelope=JsonNode.Parse(File.ReadAllText(signature))!;envelope["Elements"]![0]!["Key"]=Guid.NewGuid().ToString();
            signature=Path.Combine(work,"wrong.avsig");File.WriteAllText(signature,envelope.ToJsonString());
        }
        if(scenario=="failed-edit")ops.Add(new JsonObject{["op"]="set",["target"]="IServerAction:Absent",["prop"]="Public",["value"]=true});
        var job=Path.Combine(work,"job.json");var output=Path.Combine(work,"output.oml");File.WriteAllText(job,new JsonObject{["ops"]=ops}.ToJsonString());
        var failure=Assert.ThrowsAny<Exception>(()=>JobRunner.Run(host,basis,job,output,bindings:new Dictionary<string,string>{{"Primitive",signature}}));
        Assert.Contains(expected,failure.ToString());Assert.False(File.Exists(output));Assert.Equal(before,SHA256.HashData(File.ReadAllBytes(basis)));
    }
    [Fact]
    public void CapturedExtensionSignatureImportsAndIsCallable()
    {
        // `anvil signature` output (FormatVersion 2, attested) is consumed by the same reference op as the legacy envelope.
        StudioAssemblies.Bind();var (root,work)=Work();var host=new ModelHost(work);
        var signature=Path.Combine(work,"Primitive.avsig");CaptureFromStub(signature);
        var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");
        var result=ApplyBound(host,work,"captured",basis,new JsonArray(Reference(),JsonNode.Parse(Declaration),new JsonObject{["op"]="find",["name"]="CSharpTextCompareOrdinal"}),
            new Dictionary<string,string>{{"Primitive",signature}});
        var reference=result["results"]![0]!["result"]!;
        Assert.Equal("server-signature",reference["source"]!.ToString());
        Assert.Equal(7,reference["versionId"]!.GetValue<int>());
        Assert.Equal("Extension",reference["kind"]!.ToString());
        Assert.Equal(reference["signatureHash"]!.ToString(),reference["referenceHash"]!.ToString());
    }

    [Fact]
    public void ESpaceProducerElementsImportWithTheirTypeClosureWithoutTheProducerOml()
    {
        StudioAssemblies.Bind();var (root,work)=Work();var host=new ModelHost(work);
        // The producer OML exists only to build the recorded signature; the consumer job is bound to the .avsig alone.
        var producer=Path.Combine(work,"producer.oml");
        var built=JsonSerializer.SerializeToNode(JobRunner.Run(host,null,Path.Combine(root,"tests/jobs/producer-public.json"),producer))!;
        Assert.True(built["accepted"]!.GetValue<bool>());
        var signature=Path.Combine(work,"Catalog.avsig");
        var fixture=FixtureFromProducer(producer,"IServerActionSignature:Product_GetById",signature);
        File.Delete(producer);
        var basis=Path.Combine(root,"tests/fixtures/reactive-ui.oml");
        var bindings=new Dictionary<string,string>{{"Catalog",signature}};
        var added=ApplyBound(host,work,"espace-add",basis,new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Catalog",["elements"]=new JsonArray("IServerActionSignature:Product_GetById")},
            new JsonObject{["op"]="find",["name"]="Product_GetById"},new JsonObject{["op"]="find",["name"]="ProductSummary"},
            new JsonObject{["op"]="find",["name"]="Product",["type"]="IEntitySignature"}),bindings);
        var reference=added["results"]![0]!["result"]!;
        Assert.Equal("eSpace",reference["kind"]!.ToString());
        Assert.False(reference["referenceExisted"]!.GetValue<bool>());
        Assert.Equal(fixture,reference["referenceHash"]!.ToString());
        Assert.Contains("IStructureSignature:ProductSummary",reference["closure"]!.AsArray().Select(c=>c!.ToString()));
        Assert.Contains("IEntitySignature:Product",reference["closure"]!.AsArray().Select(c=>c!.ToString()));
        for(var i=1;i<=3;i++)Assert.NotEmpty(added["results"]![i]!["result"]!.AsArray());
        // A' refresh of the existing eSpace reference against the signature: empty selection, native refresh, same hash.
        var stale=Invalidate(host,added["outPath"]!.ToString(),reference["producer"]!.ToString(),Path.Combine(work,"stale.oml"));
        var refreshed=ApplyBound(host,work,"espace-refresh",stale,new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Catalog",["elements"]=new JsonArray()}),bindings);
        var refresh=refreshed["results"]![0]!["result"]!;
        Assert.True(refresh["referenceExisted"]!.GetValue<bool>());
        Assert.Equal(Guid.Empty.ToString(),refresh["referenceHashBefore"]!.ToString());
        Assert.Equal(fixture,refresh["referenceHash"]!.ToString());
        Assert.Equal(0,refresh["added"]!.GetValue<int>());
    }

    [Fact]
    public void SystemLoginImportsIntoTheExistingSystemReference()
    {
        StudioAssemblies.Bind();var (root,work)=Work();var host=new ModelHost(work);
        var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");
        var signature=Path.Combine(work,"System.avsig");
        // Recorded (System) payload: every element the two committed consumers reference, each regenerated by the
        // Studio's serializer and checked against the hash the consumer stored from the server (reactive-ui has Login).
        var hash=FixtureFromConsumers(host,[basis,Path.Combine(root,"tests/fixtures/reactive-ui.oml")],SystemKey,"IServerActionSignature:Login",signature);
        var result=ApplyBound(host,work,"system-login",basis,new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="System",["elements"]=new JsonArray("IServerActionSignature:Login")},
            new JsonObject{["op"]="find",["name"]="Login",["type"]="IServerActionSignature"}),new Dictionary<string,string>{{"System",signature}});
        var reference=result["results"]![0]!["result"]!;
        Assert.Equal("(System)",reference["producer"]!.ToString());
        Assert.True(reference["system"]!.GetValue<bool>());
        Assert.True(reference["referenceExisted"]!.GetValue<bool>());
        Assert.Equal(hash,reference["referenceHash"]!.ToString());
        Assert.Contains("IEntitySignature:User",reference["closure"]!.AsArray().Select(c=>c!.ToString()));
        Assert.Single(result["results"]![1]!["result"]!.AsArray());
        // The same payload is offline evidence: the delivery refuses it even in its own environment.
        Assert.Throws<InvalidOperationException>(()=>NativeReferenceSnapshot.Read(signature).RequireDeliverable("lab.example"));
    }

    [Fact]
    public void RefreshValidatesAnExistingNestedBlockBeforeAddingAnUnrelatedExport()
    { StudioAssemblies.Bind(); ExistingNestedBlockCase(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void ExistingNestedBlockCase()
    {
        var (root,work)=Work();var host=new ModelHost(work);
        var basis=Path.Combine(root,"tests/fixtures/reactive-ui.oml");_=host.Inspect(basis);
        var clone=System.Reflection.Assembly.Load("ServiceStudio.Framework").GetType("ServiceStudio.Model.ESpace")!.GetMethods()
            .Single(m=>m.Name=="Clone" && m.IsStatic && m.GetParameters().Length==9);
        Action<object> rename=m=>m.GetType().GetMethod("SetName",[typeof(string)])!.Invoke(m,["NestedSignatureProducer"]);
        var callback=Delegate.CreateDelegate(clone.GetParameters()[5].ParameterType,rename.Target,rename.Method);
        using var bytes=new MemoryStream(File.ReadAllBytes(basis));
        var module=clone.Invoke(null,[bytes,null,null,null,false,callback,null,false,false])!;
        var producerBase=Path.Combine(work,"producer-base.oml");
        try {File.WriteAllBytes(producerBase,(byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host,[module])!);}
        finally {typeof(ModelHost).GetMethod("Release")!.Invoke(null,[module]);}
        var producer=ApplyBound(host,work,"nested-producer",producerBase,new JsonArray(
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileFlow","name":"Exports","as":"$flow"}"""),
            JsonNode.Parse("""{"op":"create","parent":"$flow","type":"IMobileBlock","name":"Card","as":"$block"}"""),
            JsonNode.Parse("""{"op":"set","target":"$block","prop":"Public","value":true}"""),
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IRole","name":"ProbeOperator","as":"$role"}"""),
            JsonNode.Parse("""{"op":"set","target":"$role","prop":"Public","value":true}""")),new());
        var snapshot=SignatureFixtures.FromProducerOml(producer["outPath"]!.ToString(),["IMobileBlock:Exports/Card","IRole:ProbeOperator"]).Snapshot;
        var signature=Path.Combine(work,"nested.avsig");snapshot.Write(signature);
        var consumer=ApplyBound(host,work,"nested-consumer",basis,new JsonArray(new JsonObject {
            ["op"]="reference",["producer"]="Nested",["elements"]=new JsonArray("IMobileBlock:Exports/Card") }),new(){{"Nested",signature}});
        var consumerPath=consumer["outPath"]!.ToString();var before=SHA256.HashData(File.ReadAllBytes(consumerPath));
        var oml=Type.GetType("OutSystems.Model.Implementation.Oml.Oml, OutSystems.Model.Implementation",true)!;
        using var reader=(IDisposable)oml.GetMethod("GetSignatureReader",[typeof(byte[])])!.Invoke(null,[snapshot.SignatureBinary])!;
        var xml=(XElement)reader.GetType().GetMethod("ToXElement",Type.EmptyTypes)!.Invoke(reader,null)!;
        var block=xml.Element("ElementSignatures")!.Elements().Single(e=>e.Elements().Single().Attribute("OriginalName")?.Value=="Card");
        var otherHash=xml.Element("ElementSignatures")!.Elements().First(e=>e!=block && e.Attribute("FullSignatureHash")?.Value!=block.Attribute("FullSignatureHash")?.Value).Attribute("FullSignatureHash")!.Value;
        block.SetAttributeValue("FullSignatureHash",otherHash);
        var corrupted=(byte[])oml.GetMethod("SerializeSignature",[typeof(XElement)])!.Invoke(null,[xml])!;
        (snapshot with {SignatureBinary=corrupted}).Write(signature);
        var job=Path.Combine(work,"nested-refresh.json");var output=Path.Combine(work,"nested-refresh.oml");
        File.WriteAllText(job,new JsonObject { ["ops"]=new JsonArray(new JsonObject {
            ["op"]="reference",["producer"]="Nested",["elements"]=new JsonArray("IRole:ProbeOperator") }) }.ToJsonString());
        var error=Assert.ThrowsAny<Exception>(()=>JobRunner.Run(host,consumerPath,job,output,bindings:new Dictionary<string,string>{{"Nested",signature}}));
        Assert.Contains("Native element payload hash differs",error.ToString());
        Assert.False(File.Exists(output));Assert.Equal(before,SHA256.HashData(File.ReadAllBytes(consumerPath)));
    }

    [Fact]
    public void TextListAndFolderedExportsImportAndRefreshAnExistingReference()
    { StudioAssemblies.Bind(); TextListAndFolderCase(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void TextListAndFolderCase()
    {
        // The Horsie_CS/OutSystemsUI regression (2026-10-04) on a native producer: a public structure with a Text List,
        // kept in a model folder, imported and then validated again as an existing export when another one is added.
        var (root,work)=Work();var host=new ModelHost(work);
        var producer=ApplyBound(host,work,"text-list-producer",Path.Combine(root,"tests/fixtures/blank-service.oml"),new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"Profile","public":true,"attributes":[{"name":"Name","type":"Text"},{"name":"Tags","type":"Text List"}]},{"name":"Plain","public":true,"attributes":[{"name":"Label","type":"Text"}]}]}}"""),
            JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IFolder","name":"Grouped","args":{"parentFolder":"Structures"},"as":"$folder"}"""),
            JsonNode.Parse("""{"op":"move","target":"IStructure:Profile","into":"$folder"}""")),new());
        var snapshot=SignatureFixtures.FromProducerOml(producer["outPath"]!.ToString(),["IStructure:Profile","IStructure:Plain"]).Snapshot;
        var signature=Path.Combine(work,"text-list.avsig");snapshot.Write(signature);
        // The native serializer itself emits both shapes: the platform Text type under the anonymous root and the folder.
        var oml=Type.GetType("OutSystems.Model.Implementation.Oml.Oml, OutSystems.Model.Implementation",true)!;
        var fixedKeys=Type.GetType("OutSystems.Model.Implementation.FixedKeys, OutSystems.Model.Implementation",true)!;
        string Fixed(string name)=>fixedKeys.GetField(name)!.GetValue(null)!.ToString()!;
        using(var reader=(IDisposable)oml.GetMethod("GetSignatureReader",[typeof(byte[])])!.Invoke(null,[snapshot.SignatureBinary])!)
        {
            var xml=(XElement)reader.GetType().GetMethod("ToXElement",Type.EmptyTypes)!.Invoke(reader,null)!;
            var wrappers=xml.Element("ElementSignatures")!.Elements().ToArray();
            var profile=wrappers.Single(w=>w.Elements().Single().Attribute("OriginalName")?.Value=="Profile");
            var folder=wrappers.Single(w=>w.Elements().Single().Name=="ReferenceModelFolder");
            var dependencies=profile.Attribute("ExternalDependencies")!.Value.Split(' ');
            Assert.Contains(Fixed("Key_AnonymousTypesRootESpace")+"*"+Fixed("TextType"),dependencies);
            Assert.Contains(dependencies,d=>d.EndsWith("*"+folder.Attribute("OriginalKey")!.Value,StringComparison.Ordinal));
        }
        var basis=Path.Combine(root,"tests/fixtures/reactive-ui.oml");var bindings=new Dictionary<string,string>{{"Profiles",signature}};
        var added=ApplyBound(host,work,"text-list-add",basis,new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Profiles",["elements"]=new JsonArray("IStructure:Profile")}),bindings);
        Assert.Empty(added["results"]![0]!["result"]!["closure"]!.AsArray());
        var extended=ApplyBound(host,work,"text-list-extend",added["outPath"]!.ToString(),new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Profiles",["elements"]=new JsonArray("IStructure:Plain")},
            new JsonObject{["op"]="find",["name"]="Profile",["type"]="IStructureSignature"},new JsonObject{["op"]="find",["name"]="Plain",["type"]="IStructureSignature"}),bindings);
        Assert.True(extended["results"]![0]!["result"]!["referenceExisted"]!.GetValue<bool>());
        for(var i=1;i<=2;i++)Assert.Single(extended["results"]![i]!["result"]!.AsArray());
    }

    [Fact]
    public void EmptyRefreshValidatesTheExistingExportsAndNotTheRestOfTheProducer()
    { StudioAssemblies.Bind(); EmptyRefreshCase(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void EmptyRefreshCase()
    {
        // An A' refresh changes only the exports the consumer already has: an unrelated export of the producer that fails its
        // hash no longer blocks it (the strict-all gate refused it), while the hash of an existing export still does.
        var (root,work)=Work();var host=new ModelHost(work);
        var producer=ApplyBound(host,work,"refresh-producer",Path.Combine(root,"tests/fixtures/blank-service.oml"),new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"Profile","public":true,"attributes":[{"name":"Name","type":"Text"}]},{"name":"Plain","public":true,"attributes":[{"name":"Label","type":"Text"}]}]}}""")),new());
        var snapshot=SignatureFixtures.FromProducerOml(producer["outPath"]!.ToString(),["IStructure:Profile"],"lab.example").Snapshot;
        var signature=Path.Combine(work,"refresh.avsig");snapshot.Write(signature);var bindings=new Dictionary<string,string>{{"Profiles",signature}};
        var added=ApplyBound(host,work,"refresh-add",Path.Combine(root,"tests/fixtures/reactive-ui.oml"),new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Profiles",["elements"]=new JsonArray("IStructure:Profile")}),bindings);
        var stale=Invalidate(host,added["outPath"]!.ToString(),added["results"]![0]!["result"]!["producer"]!.ToString(),Path.Combine(work,"refresh-stale.oml"));
        JsonArray Refresh()=>new(new JsonObject{["op"]="reference",["producer"]="Profiles",["elements"]=new JsonArray()});
        WithSwappedHash(snapshot,"Plain").Write(signature);
        var refreshed=ApplyBound(host,work,"refresh-unrelated",stale,Refresh(),bindings)["results"]![0]!["result"]!;
        Assert.True(refreshed["referenceExisted"]!.GetValue<bool>());Assert.Equal(snapshot.SignatureHash.ToString(),refreshed["referenceHash"]!.ToString());
        WithSwappedHash(snapshot,"Profile").Write(signature);
        var job=Path.Combine(work,"refresh-existing.json");var output=Path.Combine(work,"refresh-existing.oml");
        File.WriteAllText(job,new JsonObject{["ops"]=Refresh()}.ToJsonString());
        var error=Assert.ThrowsAny<Exception>(()=>JobRunner.Run(host,stale,job,output,bindings:bindings));
        Assert.Contains("Native element payload hash differs",error.ToString());Assert.False(File.Exists(output));
    }

    [Fact]
    public void AnExportTheProducerNoLongerPublishesDoesNotBlockANewImport()
    { StudioAssemblies.Bind(); RemovedExportCase(); }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void RemovedExportCase()
    {
        // Headless_UI against a Headless_CS that removed a public service action: the next producer revision no longer publishes
        // an export the consumer still has. Importing another export validates what the producer publishes and leaves the
        // removed one to the native refresh, as Manage Dependencies does.
        var (root,work)=Work();var host=new ModelHost(work);
        var v1=ApplyBound(host,work,"removed-v1",Path.Combine(root,"tests/fixtures/blank-service.oml"),new JsonArray(
            JsonNode.Parse("""{"op":"spec","data":{"structures":[{"name":"Profile","public":true,"attributes":[{"name":"Name","type":"Text"}]},{"name":"Plain","public":true,"attributes":[{"name":"Label","type":"Text"}]}]}}""")),new());
        var signature=Path.Combine(work,"removed.avsig");var bindings=new Dictionary<string,string>{{"Profiles",signature}};
        var first=SignatureFixtures.FromProducerOml(v1["outPath"]!.ToString(),["IStructure:Plain"]).Snapshot;first.Write(signature);
        var consumer=ApplyBound(host,work,"removed-consumer",Path.Combine(root,"tests/fixtures/reactive-ui.oml"),new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Profiles",["elements"]=new JsonArray("IStructure:Plain")}),bindings);
        var v2=ApplyBound(host,work,"removed-v2",v1["outPath"]!.ToString(),new JsonArray(
            JsonNode.Parse("""{"op":"delete","target":"IStructure:Plain"}""")),new());
        var revision=SignatureFixtures.FromProducerOml(v2["outPath"]!.ToString(),["IStructure:Profile"]).Snapshot;
        // Absent from the revision altogether (not a hidden ABI dependency), and still refused as a new request.
        var plain="IStructureSignature:@"+first.Elements.Single(e=>e.Name=="Plain").Key;
        var validate=typeof(NativeDependencyReader).GetMethod("ValidateExistingServerImports",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)!;
        Assert.Equal(new[]{plain},((NativeSignatureResolution)validate.Invoke(null,[revision.ModuleKey,revision.Name,revision.SignatureBinary,new[]{plain}])!).Absent);
        // A25: refused as PRODUCER_SIGNATURE_MISSING (cause absent), with every missing element at once.
        var refused=Assert.Throws<KernelRefusalException>(()=>NativeDependencyReader.ResolveServerSignature(revision.ModuleKey,revision.Name,revision.SignatureBinary,[plain]));
        Assert.Equal("absent",Assert.Single(refused.Problems!)!["cause"]!.GetValue<string>());
        revision.Write(signature);
        var extended=ApplyBound(host,work,"removed-extend",consumer["outPath"]!.ToString(),new JsonArray(
            new JsonObject{["op"]="reference",["producer"]="Profiles",["elements"]=new JsonArray("IStructure:Profile")},
            new JsonObject{["op"]="find",["name"]="Profile",["type"]="IStructureSignature"}),bindings);
        Assert.True(extended["results"]![0]!["result"]!["referenceExisted"]!.GetValue<bool>());
        Assert.Single(extended["results"]![1]!["result"]!.AsArray());
    }

    /// <summary>The snapshot with one element's FullSignatureHash replaced by another element's: a payload that is not the producer's.</summary>
    private static NativeReferenceSnapshot WithSwappedHash(NativeReferenceSnapshot snapshot,string name)
    {
        var oml=Type.GetType("OutSystems.Model.Implementation.Oml.Oml, OutSystems.Model.Implementation",true)!;
        using var reader=(IDisposable)oml.GetMethod("GetSignatureReader",[typeof(byte[])])!.Invoke(null,[snapshot.SignatureBinary])!;
        var xml=(XElement)reader.GetType().GetMethod("ToXElement",Type.EmptyTypes)!.Invoke(reader,null)!;
        var wrappers=xml.Element("ElementSignatures")!.Elements().ToArray();
        var target=wrappers.Single(e=>e.Elements().Single().Attribute("OriginalName")?.Value==name);
        target.SetAttributeValue("FullSignatureHash",wrappers.First(e=>e.Attribute("FullSignatureHash")?.Value!=target.Attribute("FullSignatureHash")?.Value).Attribute("FullSignatureHash")!.Value);
        return snapshot with {SignatureBinary=(byte[])oml.GetMethod("SerializeSignature",[typeof(XElement)])!.Invoke(null,[xml])!};
    }

    private const string SystemKey="uXCIR2Atc0+es3zYuZSnNw";
    private static JsonNode ApplyBound(ModelHost host,string work,string name,string basis,JsonArray ops,Dictionary<string,string> bindings)
    {
        var job=Path.Combine(work,name+".json");var output=Path.Combine(work,name+".oml");
        File.WriteAllText(job,new JsonObject{["ops"]=ops}.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,output,bindings:bindings))!;
        Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        Assert.True(host.Inspect(output).IsValid);
        Assert.Empty(result["validation"]!["new"]!.AsArray());
        return result;
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void CaptureFromStub(string path)
    {
        using var session=HeadlessSession.ConnectStudio(SignatureEnvironment.Primitive(),"lab.example",null,readOnly:true);
        ProducerSignatureCapture.Capture(session,new SignatureCaptureRequest("ZZHighCodePrimitives",["IServerActionSignature:CSharpTextCompareOrdinal"],path));
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static string FixtureFromProducer(string oml,string element,string path)
    {
        var fixture=SignatureFixtures.FromProducerOml(oml,[element],"lab.example");fixture.Snapshot.Write(path);
        return fixture.Snapshot.SignatureHash.ToString();
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static string FixtureFromConsumers(ModelHost host,string[] consumers,string key,string element,string path)
    {
        var fixture=SignatureFixtures.FromConsumers(host,consumers,key,[element],isSystem:true,environment:"lab.example");
        Assert.DoesNotContain(fixture.Report["keptFirstOnConflict"]!.AsArray(),c=>c!.ToString().StartsWith("Login",StringComparison.Ordinal));
        fixture.Snapshot.Write(path);return fixture.Snapshot.SignatureHash.ToString();
    }
    /// <summary>Forces the native refresh path: the named reference loses its hash, as after a producer republish.</summary>
    private static string Invalidate(ModelHost host,string oml,string referenceName,string output)
    {
        var module=typeof(ModelHost).GetMethod("Load",[typeof(string)])!.Invoke(host,[oml])!;
        try
        {
            Action<object> invalidate=m=>{
                var references=((System.Collections.IEnumerable)ModelHost.Prop(m,"References")!).Cast<object>();
                var reference=references.Single(r=>ModelHost.Prop(r,"Name")?.ToString()==referenceName);
                reference.GetType().GetProperty("ReferenceHash")!.SetValue(reference,Guid.Empty);
            };
            var mutate=typeof(Publisher).GetMethod("Mutate")!;
            var callback=Delegate.CreateDelegate(mutate.GetParameters()[2].ParameterType,invalidate.Target,invalidate.Method);
            mutate.Invoke(null,[module,"Invalidate reference for refresh regression",callback]);
            File.WriteAllBytes(output,(byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host,[module])!);
        }
        finally{typeof(ModelHost).GetMethod("Release")!.Invoke(null,[module]);}
        return output;
    }
    private static JsonObject Reference()=>new(){["op"]="reference",["producer"]="Primitive",["elements"]=new JsonArray("IServerActionSignature:CSharpTextCompareOrdinal")};
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static string Bind(string path)=>NativeReferenceSnapshot.Read(path).Bind("IServerActionSignature:CSharpTextCompareOrdinal");
    private static (string Root,string Work) Work()
    {
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeReferenceImportTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/native-reference-import-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);return(root,work);
    }
    private const string Declaration="""
        {"op":"logic","data":{"actions":[{"name":"CompareText","public":true,"inputs":[{"name":"Left","type":"Text"},{"name":"Right","type":"Text"}],"outputs":[{"name":"Result","type":"Integer"}],"steps":[{"call":"IServerActionSignature:CSharpTextCompareOrdinal","as":"Compare","args":{"Left":"Left","Right":"Right"}},{"assign":{"Result":"Compare.Result"}}]}]}}
        """;
}
