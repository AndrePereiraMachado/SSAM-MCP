using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class ManagedCSharpTypesTests
{
    [Theory]
    [InlineData(false,false)]
    [InlineData(true,false)]
    [InlineData(false,true)]
    public void DeletingTheLastConsumerRetiresOnlyUntouchedOwnedTypes(bool edited,bool keepConsumer)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ManagedCSharpTypesTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/data-logic-translator/type-consumer-retirement",edited+"-"+keepConsumer);Directory.CreateDirectory(work);
        var source=Source.Replace("public static List<Ledger>","public static int Ping()=>1; public static List<Ledger>");
        if(keepConsumer)source=source.Replace("public static int Ping()=>1;","public static List<Ledger> Keep(IDataSession db)=>db.Query<Ledger>().ToList(); public static int Ping()=>1;");
        var compiled=CSharpCompiler.Compile(new Dictionary<string,string>{["Ledger.cs"]=source});
        var schema=compiled.Specification["data"]!["structures"]!.AsArray().Single(type=>type!["name"]!.ToString().StartsWith("AvSqlProjection_",StringComparison.Ordinal))!;
        var host=new ModelHost(work);var fixture=Path.Combine(root,"tests/fixtures/blank-service.oml");var before=Path.Combine(work,"before.oml");var after=Path.Combine(work,"after.oml");var job=Path.Combine(work,"job.json");
        File.WriteAllText(job,new JsonObject {["ops"]=host.PlanModuleSpecification(fixture,new JsonObject {["csharpSource"]=source})}.ToJsonString());
        var setup=JsonSerializer.SerializeToNode(JobRunner.Run(host,fixture,job,before))!;Assert.True(setup["accepted"]!.GetValue<bool>(),setup["details"]!.ToJsonString());
        var ops=new JsonArray();
        if(edited)ops.Add(new JsonObject {["op"]="set",["target"]="IStructure:"+schema["name"]+"/"+schema["attributes"]![0]!["name"],["prop"]="Description",["value"]="Human annotation"});
        ops.Add(new JsonObject {["op"]="delete",["target"]="IServerAction:ReadRows"});
        File.WriteAllText(job,new JsonObject {["ops"]=ops}.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,before,job,after))!;
        File.WriteAllText(Path.Combine(work,"result.json"),result.ToJsonString());
        // A03 (owner, 2026-10-06): only Verify errors block. The edited type is kept, and its UnusedElement warning comes back
        // as a non-blocking leftover of the delivery instead of refusing it.
        Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        Assert.Equal(edited,result["validation"]!["verdicts"]!.AsArray().Any(v=>v!["id"]?.ToString()=="UnusedElement"&&v["verdict"]?.ToString()=="nonblocking"&&v["path"]!.ToString().Contains(schema["name"]!.ToString(),StringComparison.Ordinal)));
        var removed=!edited&&!keepConsumer;
        Assert.Equal(removed?1:0,result["results"]!.AsArray().Count(item=>item!["generated"]?.ToString()=="csharp-type-lifecycle"));
        var present=host.CheckDataSpecification(after,new JsonObject {["structures"]=new JsonArray(schema.DeepClone())});
        Assert.Equal(!removed,present["accepted"]!.GetValue<bool>());
    }

    private const string Source = """
        using System.Linq;
        using System.Collections.Generic;
        using Anvil.Authoring;
        [Entity] public record Ledger(Id<Ledger> Id, int Quantity);
        public static class Queries { public static List<Ledger> ReadRows(IDataSession db) => db.Query<Ledger>().ToList(); }
        """;

    [Theory]
    [InlineData(false,false,true,false)]
    [InlineData(true,false,false,false)]
    [InlineData(false,true,false,false)]
    [InlineData(false,false,true,true)]
    [InlineData(true,false,false,true)]
    public void LegacyQueryRowsAreRetiredOnlyWithExactShapeAndNoUnchangedConsumer(bool changedField,bool otherConsumer,bool removed,bool marked)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ManagedCSharpTypesTests).Assembly.Location)!)!;var work=Path.Combine(root,".local/data-logic-translator/type-evolution",changedField+"-"+otherConsumer+"-"+marked);
        Directory.CreateDirectory(work);var host=new ModelHost(work);
        var compiled=CSharpCompiler.Compile(new Dictionary<string,string>{["Ledger.cs"]=Source});
        var legacy=compiled.RetiredStructures![0]!.DeepClone().AsObject();
        if(marked){legacy["name"]="AvSqlProjection_Previous";legacy["description"]="anvil:csharp sql schema\n"+legacy.ToJsonString();}
        var name=legacy["name"]!.ToString();
        var data=compiled.Specification["data"]!.DeepClone().AsObject();
        var structures=data["structures"]!.AsArray();
        foreach(var helper in structures.Where(s=>s!["name"]!.ToString().StartsWith("AvSql",StringComparison.Ordinal)).ToArray())structures.Remove(helper);
        if(changedField)legacy["attributes"]![1]!["description"]="Human annotation; retain this structure";
        structures.Add(legacy);
        var outputType=compiled.Specification["logic"]!["actions"]![0]!["outputs"]![0]!["type"]!.ToString();
        JsonObject Reader(string actionName)=>new(){["name"]=actionName,["public"]=true,["access"]=new JsonObject{["authenticated"]=true},["outputs"]=new JsonArray(new JsonObject{["name"]="AvResult",["type"]=outputType}),
            ["steps"]=new JsonArray(new JsonObject{["get"]=name,["sql"]=true,["as"]="Rows",["statement"]="SELECT {Ledger}.* FROM {Ledger}",["params"]=new JsonObject()},
                new JsonObject{["foreach"]="Rows.List",["do"]=new JsonArray(new JsonObject{["call"]="ListAppend",["as"]="Append",["args"]=new JsonObject{["List"]="AvResult",["Element"]="Rows.List.Current.List"}})})};
        var actions=new JsonArray(Reader("ReadRows"));if(otherConsumer)actions.Add(Reader("KeepLegacy"));
        var setup=new JsonObject{["data"]=data,["logic"]=new JsonObject{["actions"]=actions}};
        var fixture=Path.Combine(root,"tests/fixtures/blank-service.oml");var before=Path.Combine(work,"before.oml");var job=Path.Combine(work,"setup.json");
        File.WriteAllText(job,new JsonObject{["ops"]=host.PlanModuleSpecification(fixture,setup)}.ToJsonString());
        var applied=JsonSerializer.SerializeToNode(JobRunner.Run(host,fixture,job,before))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(),applied["details"]!.ToJsonString());
        var source=new JsonObject{["csharpSource"]=Source};var plan=host.PlanModuleSpecification(before,source);
        File.WriteAllText(Path.Combine(work,"legacy-proof.json"),host.CheckDataSpecification(before,new JsonObject{["structures"]=new JsonArray(compiled.RetiredStructures![0]!.DeepClone())}).ToJsonString());
        var inspect=Path.Combine(work,"inspect.json");
        File.WriteAllText(inspect,new JsonObject{["ops"]=new JsonArray(new JsonObject{["op"]="usages",["target"]="IStructure:"+name},new JsonObject{["op"]="get",["target"]="IStructure:"+name})}.ToJsonString());
        File.WriteAllText(Path.Combine(work,"legacy-usage.json"),JsonSerializer.Serialize(JobRunner.Run(host,before,inspect,Path.Combine(work,"inspected.oml"))));
        var deletions=plan.OfType<JsonObject>().Count(o=>o["op"]?.ToString()=="delete");
        Assert.Equal(removed?1:0,deletions);
        if(!removed)return;
        var after=Path.Combine(work,"after.oml");File.WriteAllText(job,new JsonObject{["ops"]=plan}.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,before,job,after))!;
        Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        Assert.True(host.CheckModuleSpecification(after,source)["accepted"]!.GetValue<bool>());
        Assert.Empty(host.PlanModuleSpecification(after,source));
    }
}
