using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class CSharpDataEffectsTests
{
    [Theory]
    [InlineData("DataActions",9)]
    [InlineData("QueryOrdering",18)]
    [InlineData("ColdStock",8)] // Four authored methods and their service wrappers; Trim is a typed runtime call.
    [InlineData("EnumRuntime",3)]
    [InlineData("ColdQueryProjection",5)]
    [InlineData("ColdGrouping",3)]
    [InlineData("ColdAveragePipeline",2)]
    public void CSharpCrudAndQueriesVerifyAndReloadWithPhysicalPresenceAndLogicalRecords(string fixture,int expectedActions)
    {
        StudioAssemblies.Bind();var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CSharpDataEffectsTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/data-logic-translator/native-data-effects",Guid.NewGuid().ToString("N"),fixture);Directory.CreateDirectory(work);
        var source=File.ReadAllText(Path.Combine(root,"tests/csharp/"+fixture+".cs.txt"));
        var contract=new JsonObject {["csharpSource"]=source};ModuleSpecification.Validate(contract);
        File.WriteAllText(Path.Combine(work,"normalized-logic.json"),ModuleSpecification.Logic(contract).ToJsonString());
        var host=new ModelHost(work);var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");
        var runtime=FrameworkRuntimeFixture.For(host,basis,contract,root);
        var output=Path.Combine(work,"inventory.oml");var job=Path.Combine(work,"inventory.json");
        var planned=host.PlanModuleSpecification(basis,contract,runtime);
        // The C# fixtures predate the 2026-10-09 data-access rule: a query inside a loop is accepted only with the explicit escape (QUERY_IN_LOOP).
        foreach(var op in planned.OfType<JsonObject>().Where(op=>op["op"]?.ToString()=="logic"))op[QueryInLoopRule.AllowKey]=new JsonObject {["why"]="C# fixture written before the data-access rule; proves CRUD effects"};
        File.WriteAllText(job,new JsonObject {["ops"]=planned}.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,output,bindings:runtime?.ProducerBindings()))!;
        File.WriteAllText(Path.Combine(work,"apply-result.json"),result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        var proof=host.CheckModuleSpecification(output,contract,runtime:runtime);File.WriteAllText(Path.Combine(work,"proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        var arithmeticHelpers=ModuleSpecification.Logic(contract)["actions"]!.AsArray().Count(action=>action!["description"]?.ToString()=="C# decimal arithmetic; isolated native overflow boundary.");
        Assert.Equal(expectedActions+arithmeticHelpers,proof["actionSummary"]!.AsArray().Count);
        Assert.Empty(host.PlanModuleSpecification(output,contract,runtime));
    }
}
