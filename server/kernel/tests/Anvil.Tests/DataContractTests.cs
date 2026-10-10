using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
namespace Anvil.Tests;

public class DataContractTests
{
    [Fact]
    public void LegacyRecoveryRequiresADeclarativeDataSourceWithoutRawDataMutations()
    {
        var job = JsonNode.Parse("""{"ops":[{"op":"spec","data":{"static":[{"name":"State","records":[{"name":"Active"}]}]}},{"op":"html","data":{}}]}""")!;
        Assert.NotNull(Anvil.Core.Delivery.Delivery.FlatDataSpecification(job));
        job["ops"]!.AsArray().Add(JsonNode.Parse("""{"op":"set","target":"IStaticEntity:State/Active/Label","prop":"Value","value":"\"Different\""}"""));
        Assert.Null(Anvil.Core.Delivery.Delivery.FlatDataSpecification(job));
    }

    [Fact]
    public void StaticValuesKeepAStableAddressAcrossMergeAndStillDetectCorruption()
    {
        StudioAssemblies.Bind();
        var dir = Path.Combine(Root, ".local", "static-value-proof"); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir); var job = Path.Combine(dir, "create.json");
        File.WriteAllText(job, """{"base":"reactive-ui.oml","ops":[{"op":"spec","data":{"static":[{"name":"ProofState","public":true,"records":[{"name":"Active","label":"Ativo"},{"name":"Closed","label":"Fechado"}]}]}}]}""");
        var foreign = Path.Combine(dir, "foreign.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, foreign))!;
        Assert.True(result["accepted"]!.GetValue<bool>());
        var assertions = result["dataContract"]!["assertions"]!.AsArray();
        // Since phase 3 (2026-09-23) a record value is anchored on the record key AND the attribute key ("@record/@attribute"),
        // so the address survives a rename of either and the merge alike.
        Assert.Contains(assertions, a => a?["property"]?.ToString() == "Value" && a?["reference"]?.ToString().Contains("/@") == true);
        var merged = Path.Combine(dir, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml")), File.ReadAllBytes(foreign), merged);
        Assert.False(merge.HasConflicts);
        Assert.True(host.CheckDataContract(merged, assertions)["accepted"]!.GetValue<bool>());
        var change = Path.Combine(dir, "change.json"); File.WriteAllText(change, """{"ops":[{"op":"set","target":"IStaticEntity:ProofState/Active/Label","prop":"Value","value":"\"Incorrect\""}]}""");
        var corrupted = Path.Combine(dir, "corrupted.oml"); JobRunner.Run(host, merged, change, corrupted);
        var proof = host.CheckDataContract(corrupted, assertions);
        Assert.False(proof["accepted"]!.GetValue<bool>());
        Assert.Contains("Incorrect", proof["differences"]!.ToJsonString());
    }
    private static string Root => JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DataContractTests).Assembly.Location)!)!;
    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();
    [Fact]
    public void PreflightReportsIndependentOrderEnumLengthAndUnsupportedTypeErrors()
    {
        var r = JobPreflight.Analyze(Ops("""
        [{"op":"spec","data":{"entities":[{"name":"Incident","attributes":[{"name":"PriorityId","type":"Priority Identifier"},{"name":"Bad","type":"Int64","length":-1}],"updateBehavior":"Sometimes"}]}},
         {"op":"create","parent":"@espace","type":"IStaticEntity","name":"Priority","as":"$Priority"}]
        """));
        Assert.False(r["valid"]!.GetValue<bool>());
        var errors = r["errors"]!.ToJsonString();
        Assert.Contains("before its declaration", errors); Assert.Contains("Optimized", errors);
        Assert.Contains("positive integer", errors); Assert.Contains("Int64", errors);
        // The name the Studio shows (Changed Attributes) is the stored Optimized, never an enum error (C09).
        var alias = JobPreflight.Analyze(Ops("""[{"op":"spec","data":{"entities":[{"name":"Incident","attributes":[{"name":"Title","type":"Text"}],"updateBehavior":"Changed Attributes"}]}}]"""));
        Assert.DoesNotContain("UpdateBehavior", alias["errors"]!.ToJsonString());
    }
    [Fact]
    public void SingleSpecDeclaresIdentifiersBeforeForwardAndCyclicForeignKeys()
    {
        var result = Run("cycles", """
        {"base":"blank-service.oml","ops":[{"op":"spec","data":{"entities":[
          {"name":"First","attributes":[{"name":"Other","type":"Second Identifier"}]},
          {"name":"Second","attributes":[{"name":"Other","type":"First Identifier"}]}]}}]}
        """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
    }
    [Fact]
    public void CompactDataContractSurvivesReloadAndDetectsChangedLength()
    {
        var (path, result) = RunFile("contract", """
        {"base":"blank-service.oml","ops":[{"op":"spec","data":{
          "static":[{"name":"Priority","attributes":[{"name":"Label","type":"Text","length":30},{"name":"Minutes","type":"Integer"}],"records":[{"name":"Low","Minutes":4320}]}],
          "entities":[{"name":"Incident","updateBehavior":"Optimized","attributes":[{"name":"Title","type":"Text","length":120,"mandatory":true},{"name":"Description","type":"Long Text","mandatory":true},{"name":"PriorityId","type":"Priority Identifier"}],
            "indexes":[{"name":"IX_Title","attributes":["Title"]}]}]}}]}
        """);
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var summary = result["dataContract"]!["dataSummary"]!.AsArray();
        var incident = summary.Single(x => x!["name"]!.ToString() == "Incident")!;
        Assert.Contains(incident["attributes"]!.AsArray(), a => a!["name"]!.ToString() == "PriorityId" && a["type"]!.ToString() == "Priority Identifier");
        Assert.Equal(4320,summary.Single(x=>x!["name"]!.ToString()=="Priority")!["records"]![0]!["values"]!["Minutes"]!.GetValue<decimal>());
        var assertions = result["dataContract"]!["assertions"]!.AsArray();
        Assert.Contains(assertions, x => x!["property"]!.ToString() == "Length" && x["expected"]!.ToString() == "2000000");
        Assert.Contains(assertions, x => x!["property"]!.ToString() == "Value" && x["expected"]!.ToString() == "4320");
        var host = new ModelHost(Path.GetDirectoryName(path)!);
        Assert.True(host.CheckDataContract(path, assertions)["accepted"]!.GetValue<bool>());
        var mutation = Path.Combine(Path.GetDirectoryName(path)!, "mutation.json");
        File.WriteAllText(mutation, """{"base":"blank-service.oml","ops":[{"op":"set","target":"IServerEntity:Incident/Description","prop":"Length","value":50}]}""");
        var changed = Path.Combine(Path.GetDirectoryName(path)!, "changed.oml");
        JobRunner.Run(host,path,mutation,changed);
        var proof = host.CheckDataContract(changed,assertions);
        Assert.False(proof["accepted"]!.GetValue<bool>());
        Assert.Contains("Length",proof["differences"]!.ToJsonString());

    }
    [Fact]
    public void ReceiptRejectsChangesToCompositePartsAndSavedArtifacts()
    {
        var work = Path.Combine(Root, ".local", "data-contract-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var part = Path.Combine(work, "part.json"); File.WriteAllText(part,"{\"ops\":[]}");
        var job = Path.Combine(work,"job.json"); File.WriteAllText(job,"{\"jobs\":[\"job:part\"]}");
        var artifact = Path.Combine(work,"delivered.oml"); File.WriteAllText(artifact,"snapshot");
        var receipt = new JsonObject { ["delivered"] = true, ["sources"] = DeliveryReceipt.Sources(job),
            ["artifacts"] = new JsonArray(new JsonObject { ["path"] = artifact, ["sha256"] = DeliveryReceipt.Hash(artifact) }) };
        var path = Path.Combine(work,"result.json"); File.WriteAllText(path,receipt.ToJsonString());
        Assert.True(DeliveryReceipt.Check(path)["accepted"]!.GetValue<bool>());
        File.AppendAllText(part," ");
        Assert.False(DeliveryReceipt.Check(path)["accepted"]!.GetValue<bool>());
        File.WriteAllText(part,"{\"ops\":[]}"); File.AppendAllText(artifact,"changed");
        Assert.False(DeliveryReceipt.Check(path)["accepted"]!.GetValue<bool>());
    }
    [Fact]
    public void UnknownBaseTypesAreReportedTogetherBeforeApplying()
    {
        // One coded refusal (C20) with both unresolved types, before the first op is applied.
        var ex = Assert.Throws<JobPreflightException>(() => Run("unknowns", """
        {"base":"blank-service.oml","ops":[{"op":"spec","data":{"entities":[{"name":"Probe","attributes":[{"name":"A","type":"AbsentA Identifier"},{"name":"B","type":"AbsentB"}]}]}}]}
        """));
        Assert.Contains("AbsentA",ex.Message); Assert.Contains("AbsentB",ex.Message);
        Assert.Equal(JobPreflightException.PreflightRefused, ex.Code); Assert.Equal(2, ex.Problems.Count);
    }
    [Fact]
    public void EnumCatalogExposesOptimizedWithoutLoadingAModule()
        => Assert.Contains("Optimized", ApiCatalog.EnumValues("UpdateEntityBehaviorType")!);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DeliveryCannotSucceedAfterSourceChangeOrDataProofFailure(bool changeSource)
    {
        var work=Path.Combine(Root,".local","data-contract-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var job=Path.Combine(work,"job.json");File.WriteAllText(job,"{\"ops\":[]}");
        var bridge=new ProofBridge();
        var result=Anvil.Core.Delivery.Delivery.Run(bridge,new("Probe",job,work,Array.Empty<string>()),
            (_,_,output)=>{
                File.WriteAllText(output,"foreign");
                if(changeSource) File.AppendAllText(job," ");
                return new JsonObject { ["isValid"]=true,["accepted"]=true,["dataContract"]=new JsonObject {
                    ["accepted"]=true,["assertions"]=new JsonArray(new JsonObject { ["key"]="field",["property"]="Length",["expected"]="2000000" }) }};
            },inspectData:(_,_)=>new JsonObject { ["accepted"]=false,["count"]=1,["differences"]=new JsonArray("Length mismatch") });
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(changeSource?0:1,bridge.Merges);
        Assert.Contains(changeSource?"changed":"differs",result["error"]!.ToString());
    }
    private sealed class ProofBridge : IBridgeClient
    {
        public int Merges;
        public JsonObject Call(string method,JsonObject? parameters=null)
        {
            if(method=="snapshot_module") { File.WriteAllText(parameters!["path"]!.ToString(),"snapshot"); return new() { ["key"]="module",["snapshot_id"]="snapshot" }; }
            if(method=="merge_from_oml") { Merges++;return new() { ["merged"]=true,["newErrors"]=0 }; }
            return method switch {
                "open_module"=>new() { ["opened"]=true },
                "get_active_module"=>new() { ["name"]="Probe",["key"]="module" },
                "get_errors"=>new() { ["newErrors"]=0,["new"]=new JsonArray() },
                _=>throw new Exception(method)
            };
        }
    }

    [Fact]
    public void NonAutoStaticIdentifiersRequireExplicitRecordValues()
    {
        var ops=Ops("""
        [
          {"op":"create","parent":"@espace","type":"IStaticEntity","name":"State","as":"$State"},
          {"op":"create","parent":"$State","type":"IEntityAttribute","name":"Id","as":"$Id"},
          {"op":"set","target":"$Id","prop":"DataType","value":"Integer"},
          {"op":"set","target":"$Id","prop":"IsAutoNumber","value":"No"},
          {"op":"set","target":"$State","prop":"IdentifierAttribute","value":"$Id"},
          {"op":"create","parent":"$State","type":"IRecord","name":"Open","as":"$Open"}]
        """);
        Assert.Contains("has no Id",JobPreflight.Analyze(ops)["errors"]!.ToJsonString());
        ops.Add(new JsonObject { ["op"]="set",["target"]="$Open/Id",["prop"]="Value",["value"]="1" });
        Assert.True(JobPreflight.Analyze(ops)["valid"]!.GetValue<bool>());
    }

    [Fact]
    public void StaticEntityIdIsNeverAutoNumber()
    {
        // The ODC Studio refuses 'StaticEntity Auto Number' live while the headless Verify accepts it.
        var spec = SpecExpander.Expand(JsonNode.Parse("""{"static":[{"name":"State","records":[{"name":"Open"},{"name":"Closed","id":10},{"name":"Gone"}]}]}""")!.AsObject());
        Assert.Contains(spec, o => o["target"]?.ToString()=="$State.Id" && o["prop"]?.ToString()=="IsAutoNumber" && o["value"]?.ToString()=="No");
        Assert.DoesNotContain(spec, o => o["prop"]?.ToString()=="IsAutoNumber" && o["value"]?.ToString()=="Yes");
        string? Id(string record) => spec.FirstOrDefault(o => o["target"]?.ToString()==$"$State.{record}/Id" && o["prop"]?.ToString()=="Value")?["value"]?.ToString();
        Assert.Equal("1", Id("Open")); Assert.Equal("10", Id("Closed")); Assert.Equal("3", Id("Gone"));
        Assert.Throws<InvalidOperationException>(() => SpecExpander.Expand(JsonNode.Parse("""{"static":[{"name":"S","records":[{"name":"A","id":2},{"name":"B","id":2}]}]}""")!.AsObject()));
        Assert.Throws<InvalidOperationException>(() => SpecExpander.Expand(JsonNode.Parse("""{"static":[{"name":"S","records":[{"name":"A","id":0}]}]}""")!.AsObject()));

        var raw = Ops("""
        [
          {"op":"create","parent":"@espace","type":"IStaticEntity","name":"State","as":"$State"},
          {"op":"create","parent":"$State","type":"IEntityAttribute","name":"Id","as":"$Id"},
          {"op":"set","target":"$Id","prop":"IsAutoNumber","value":"Yes"},
          {"op":"set","target":"IStaticEntity:Legacy/Id","prop":"IsAutoNumber","value":"Yes"},
          {"op":"set","target":"$State","prop":"IdentifierAttribute","value":"$Id"},
          {"op":"create","parent":"$State","type":"IRecord","name":"Open","as":"$Open"}]
        """);
        var errors = JobPreflight.Analyze(raw)["errors"]!.ToJsonString();
        Assert.Contains("IsAutoNumber Yes on $Id", errors);
        Assert.Contains("IsAutoNumber Yes on IStaticEntity:Legacy/Id", errors);
        Assert.Contains("has no Id", errors);
    }
    private static JsonNode Run(string name,string json) => RunFile(name,json).Result;
    private static (string Path,JsonNode Result) RunFile(string name,string json)
    {
        StudioAssemblies.Bind();
        var work=Path.Combine(Root,".local","data-contract-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var job=Path.Combine(work,name+".json");
        if(name=="contract") { var parsed=JsonNode.Parse(json)!; parsed["ops"]!.AsArray().Add(new JsonObject { ["op"]="get",["target"]="$Incident" }); json=parsed.ToJsonString(); }
        File.WriteAllText(job,json);
        var output=Path.Combine(work,name+".oml");
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work),null,job,output))!;
        File.WriteAllText(Path.Combine(work,"result.json"),result.ToJsonString());
        return (output,result);
    }
}
