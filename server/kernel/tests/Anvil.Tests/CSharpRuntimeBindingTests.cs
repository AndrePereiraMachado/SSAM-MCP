using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class CSharpRuntimeBindingTests
{
    [Fact]
    public void AuthoredOrdinalQueryUsesFrozenNativeDependencyAndRemainsUnchangedAfterReload()
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpRuntimeBindingTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/csharp-runtime-binding-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var source=File.ReadAllText(Path.Combine(root,"tests/csharp/ColdGrouping.cs.txt"));
        var authored=new JsonObject{["csharpSource"]=source};
        // SourceBundle.From(string) supplies the stable public entry name used by the controller.
        var compiled=CSharpCompiler.Compile(SourceBundle.From(authored["csharpSource"]!));
        var host=new ModelHost(work);var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");
        var signature=Path.Combine(root,"tests/contracts/native-reference/ordinal-primitive.avsig");
        var envelope=JsonNode.Parse(File.ReadAllText(signature))!;var intrinsic=Assert.Single(compiled.RequiredIntrinsics!);
        FrozenFrameworkDependencies Lock(string producerFile,JsonNode description)=>FrozenFrameworkDependencies.Create(
            compiled.SourceHash,compiled.RequiredIntrinsics!,"fixture.invalid",host.Inspect(basis).Key,
            new("FixtureOnly","interface-test",new string('a',64)),
            [new("Runtime",producerFile,DeliveryReceipt.Hash(producerFile),description["ModuleKey"]!.ToString(),description["SignatureHash"]!.ToString())],
            [new(intrinsic.Reference,"Runtime",description["Elements"]![0]!["Name"]!.ToString(),description["Elements"]![0]!["Key"]!.ToString(),intrinsic.Inputs,intrinsic.Output)]);
        var runtime=Lock(signature,envelope);
        var missing=Assert.Throws<InvalidOperationException>(()=>host.PlanModuleSpecification(basis,authored));
        Assert.Contains("controller must resolve",missing.Message);
        var ops=host.PlanModuleSpecification(basis,authored,runtime);
        Assert.Equal("reference",ops[0]!["op"]!.ToString());
        Assert.DoesNotContain("IFrameworkIntrinsic:",ops.ToJsonString());
        var sourcePath=Path.Combine(work,"source.json");var output=Path.Combine(work,"query.oml");
        File.WriteAllText(sourcePath,authored.ToJsonString());
        var executor=new CSharpRuntimeDelivery(new DeliveryRequest(host.Inspect(basis).Name,sourcePath,work,[],Specification:authored),"unused-registration");
        var result=executor.Apply(basis,sourcePath,output,runtime);
        var generated=JsonNode.Parse(File.ReadAllText(Path.Combine(work,"generated.json")))!;
        Assert.NotNull(generated["ops"]);Assert.Null(generated["payload"]);
        File.WriteAllText(Path.Combine(work,"result.json"),result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        var proof=host.CheckModuleSpecification(output,authored,runtime:runtime);
        File.WriteAllText(Path.Combine(work,"proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        Assert.True(proof["runtimeDependencies"]!["accepted"]!.GetValue<bool>());
        Assert.Empty(host.PlanModuleSpecification(output,authored,runtime));
        var changed=envelope.DeepClone();changed["SignatureHash"]=Guid.NewGuid().ToString();
        var changedSignature=Path.Combine(work,"changed.avsig");File.WriteAllText(changedSignature,changed.ToJsonString());
        var staleProof=host.CheckModuleSpecification(output,authored,runtime:Lock(changedSignature,changed));
        Assert.False(staleProof["accepted"]!.GetValue<bool>());
        Assert.Contains(staleProof["differences"]!.AsArray(),d=>d!["property"]!.ToString()=="signatureHash");
    }
}
