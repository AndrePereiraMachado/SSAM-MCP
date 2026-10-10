using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class CSharpTemporalTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("TemporalValues",21)]
    [InlineData("TemporalInstants",45)]
    public void TemporalValuesVerifySaveReloadAndProduceAnEmptyRepeatPlan(string fixture,int expectedMethods)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpTemporalTests).Assembly.Location)!)!;
        var lane=Environment.GetEnvironmentVariable("ANVIL_LANE") ?? "ss4";
        var work=Path.Combine(root,".local",lane=="ss5"?"lane-ss5":"","data-logic-translator","native-temporal",fixture);
        Directory.CreateDirectory(work);
        var sourcePath=Path.Combine(root,"tests/csharp/"+fixture+".cs.txt");
        var source=File.ReadAllText(sourcePath);
        var compiled=CSharpCompiler.Compile(new Dictionary<string,string> {[fixture+".cs"]=source});
        Assert.Empty(compiled.RequiredIntrinsics ?? []);
        var contract=new JsonObject {["csharpSource"]=source};
        ModuleSpecification.Validate(contract);
        File.WriteAllText(Path.Combine(work,"compiled.json"),compiled.Specification.ToJsonString());
        Assert.Equal(compiled.Specification.ToJsonString(),ModuleSpecification.Normalize(contract).ToJsonString());
        var actions=compiled.Specification["logic"]!["actions"]!.AsArray();
        var arithmeticHelpers=actions.Count(action=>action!["description"]?.ToString()=="C# decimal arithmetic; isolated native overflow boundary.");
        Assert.Equal(expectedMethods+arithmeticHelpers,actions.Count);
        var host=new ModelHost(work);var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");
        var initial=host.PlanModuleSpecification(basis,contract);
        var job=Path.Combine(work,"temporal-values.json");
        var module=Path.Combine(work,"temporal-values.oml");
        File.WriteAllText(job,new JsonObject {["expectValid"]=true,["expectedMessages"]=new JsonArray(),["ops"]=initial}.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,module))!;
        File.WriteAllText(Path.Combine(work,"apply-result.json"),result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>());
        Assert.Equal(0,result["messages"]!.GetValue<int>());
        var saved=Path.Combine(work,"temporal-values-reloaded.oml");
        var roundTrip=host.RoundTrip(File.ReadAllBytes(module),saved);
        File.WriteAllText(Path.Combine(work,"round-trip.json"),JsonSerializer.Serialize(roundTrip));
        Assert.True(roundTrip.Original.IsValid);Assert.True(roundTrip.Reloaded.IsValid);
        Assert.Equal(0,roundTrip.Original.Validation.Total);Assert.Equal(0,roundTrip.Reloaded.Validation.Total);
        Assert.True(roundTrip.SameKey);Assert.True(roundTrip.SameObjectCount);Assert.True(roundTrip.SameValidation);
        var proof=host.CheckModuleSpecification(saved,contract);
        File.WriteAllText(Path.Combine(work,"proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        Assert.Equal(expectedMethods+arithmeticHelpers,proof["actionSummary"]!.AsArray().Count);
        var repeated=host.PlanModuleSpecification(saved,contract);
        File.WriteAllText(Path.Combine(work,"unchanged-plan.json"),repeated.ToJsonString());
        Assert.Empty(repeated);
        var summary=new JsonObject
        {
            ["lane"]=lane,["studioDirectory"]=StudioAssemblies.Directory,["sourceSha256"]=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourcePath))).ToLowerInvariant(),
            ["moduleSha256"]=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(saved))).ToLowerInvariant(),
            ["fixture"]=fixture,["sourceMethods"]=expectedMethods,["arithmeticHelpers"]=arithmeticHelpers,["actions"]=actions.Count,["structures"]=compiled.Specification["data"]!["structures"]!.AsArray().Count,
            ["ops"]=result["ops"]!.DeepClone(),["objects"]=result["objects"]!.DeepClone(),
            ["applyAccepted"]=true,["verifyMessages"]=0,["reloadMessages"]=0,["contractAccepted"]=true,["repeatOps"]=repeated.Count,
            ["assertions"]=proof["assertions"]!.AsArray().Count,["differences"]=proof["differences"]!.AsArray().Count,
            ["sameObjectCount"]=roundTrip.SameObjectCount,["sameValidation"]=roundTrip.SameValidation,
            ["liveExecution"]=false,["coldDateCorpusExecuted"]=false
        };
        File.WriteAllText(Path.Combine(work,"summary.json"),summary.ToJsonString(new JsonSerializerOptions {WriteIndented=true}));
        output.WriteLine(summary.ToJsonString());
    }
}
