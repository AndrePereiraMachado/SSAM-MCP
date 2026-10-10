using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class CSharpLogicTests
{
    [Theory]
    [InlineData("LogicBasics",40)]
    [InlineData("NullableMembers",6)]
    [InlineData("TextSemantics",7)]
    [InlineData("Utf16TextRules",2)]
    [InlineData("ColdSwitch",12)]
    [InlineData("PatternSemantics",7)]
    public void AuthoredCSharpActionsVerifyReloadAndUseTheExistingContractProof(string fixture,int expectedActions)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpLogicTests).Assembly.Location)!)!;
        var work = Path.Combine(root,".local/data-logic-translator/native-unicode-csharp-logic",Guid.NewGuid().ToString("N"),fixture); Directory.CreateDirectory(work);
        var source = File.ReadAllText(Path.Combine(root,"tests/csharp/"+fixture+".cs.txt"));
        var compiled = CSharpCompiler.Compile(new Dictionary<string,string> { ["Rules.cs"] = source });
        var contract = new JsonObject { ["csharpSource"] = source };
        Assert.Equal(compiled.Specification.ToJsonString(),ModuleSpecification.Normalize(contract).ToJsonString());
        File.WriteAllText(Path.Combine(work,"compiled.json"),compiled.Specification.ToJsonString());
        ModuleSpecification.Validate(contract);
        var host = new ModelHost(work); var basis = Path.Combine(root,"tests/fixtures/blank-service.oml");
        var runtime = FrameworkRuntimeFixture.For(host,basis,contract,root);
        var output = Path.Combine(work,"actions.oml"); var job = Path.Combine(work,"actions.json");
        File.WriteAllText(job,new JsonObject { ["ops"] = host.PlanModuleSpecification(basis,contract,runtime) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,output,bindings:runtime?.ProducerBindings()))!;
        File.WriteAllText(Path.Combine(work,"apply-result.json"),result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        var saved = Path.Combine(work,"actions-reloaded.oml");
        var roundTrip = host.RoundTrip(File.ReadAllBytes(output),saved);
        File.WriteAllText(Path.Combine(work,"round-trip.json"),JsonSerializer.Serialize(roundTrip));
        Assert.True(roundTrip.Original.IsValid && roundTrip.Reloaded.IsValid);
        Assert.True(roundTrip.SameKey && roundTrip.SameObjectCount && roundTrip.SameValidation);
        var proof = host.CheckModuleSpecification(saved,contract,runtime:runtime);
        File.WriteAllText(Path.Combine(work,"proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        var arithmeticHelpers=compiled.Specification["logic"]!["actions"]!.AsArray().Count(action=>action!["description"]?.ToString()=="C# decimal arithmetic; isolated native overflow boundary.");
        Assert.Equal(expectedActions+arithmeticHelpers,proof["actionSummary"]!.AsArray().Count);
        var merged = Path.Combine(work,"actions-merged.oml");
        var merge = MergeProbe.ThreeWay(host,File.ReadAllBytes(basis),File.ReadAllBytes(saved),merged);
        File.WriteAllText(Path.Combine(work,"merge.json"),JsonSerializer.Serialize(merge));
        Assert.True(merge.LocalIsValid,JsonSerializer.Serialize(merge));
        Assert.False(merge.HasConflicts,JsonSerializer.Serialize(merge));
        var after = host.CheckModuleSpecification(merged,contract,proof["expectedTypes"]!.AsObject(),runtime:runtime);
        File.WriteAllText(Path.Combine(work,"after-merge-proof.json"),after.ToJsonString());
        Assert.True(after["accepted"]!.GetValue<bool>(),after["differences"]!.ToJsonString());
        var same = host.PlanModuleSpecification(merged,contract,runtime);
        File.WriteAllText(Path.Combine(work,"unchanged-plan.json"),same.ToJsonString());
        Assert.Empty(same);
    }
}
