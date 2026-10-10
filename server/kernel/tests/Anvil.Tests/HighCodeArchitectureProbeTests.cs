using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;
public class HighCodeArchitectureProbeTests
{
    [Fact]
    public void NativeBlockKeepsItsContractAndFourConsumersAcrossReloadUpdateAndMerge()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HighCodeArchitectureProbeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/review/architecture/block-proof"); Directory.CreateDirectory(work);
        StudioAssemblies.Bind(null); var host = new ModelHost(work);
        var fixture = Path.Combine(root, "tests/fixtures/reactive-ui.oml");
        var first = Path.Combine(work, "first.oml"); var second = Path.Combine(work, "second.oml");
        var created = Run(fixture, Path.Combine(root, "scripts/probes/highcode/native-block.json"), first);
        Assert.True(created["accepted"]!.GetValue<bool>(), created["details"]!.ToJsonString());
        var refs = new List<string> { "IMobileBlock:ResearchCard", "IMobileBlock:ResearchCard/Title", "IMobileBlock:ResearchCard/Changed", "IMobileBlock:ResearchCard/Footer" };
        for (var s = 1; s <= 2; s++) for (var i = 1; i <= 2; i++) refs.Add($"IMobileScreen:Research{s}/#IMobileBlockInstanceWidget/Content/Card{i}");
        var before = Read(first, refs);
        var update = Path.Combine(work, "update.json");
        File.WriteAllText(update, """{"ops":[{"op":"set","target":"IMobileBlock:ResearchCard/Caption","prop":"Value","value":"Title + \": updated \" + IntegerToText(Counter)"}]}""");
        var changed = Run(first, update, second); Assert.True(changed["accepted"]!.GetValue<bool>());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(first), File.ReadAllBytes(second), merged);
        Assert.True(merge.LocalIsValid); Assert.False(merge.HasConflicts);
        var after = Read(merged, refs);
        for (var i = 0; i < refs.Count; i++) Assert.Equal(before[i]!["key"]!.ToString(), after[i]!["key"]!.ToString());
        var blockKey = after[0]!["key"]!.ToString();
        foreach (var instance in after.Skip(4)) Assert.Equal("@" + blockKey, instance!["properties"]!["SourceBlock"]!.ToString());
        var bindings = new List<string>();
        for (var s = 1; s <= 2; s++) for (var i = 1; i <= 2; i++) {
            var owner=$"IMobileScreen:Research{s}/#IMobileBlockInstanceWidget/Content/Card{i}";
            bindings.Add(owner+"/Title"); bindings.Add(owner+"/Changed/Value"); bindings.Add(owner+"/Footer/#ITextWidget");
        }
        var values = Read(merged, bindings);
        for(var n=0;n<4;n++) {
            Assert.Equal(JsonSerializer.Serialize($"Research{n/2+1} instance {n%2+1}"),values[n*3]!["properties"]!["Value"]!.ToString());
            Assert.Equal("Value",values[n*3+1]!["properties"]!["Value"]!.ToString());
            Assert.Equal($"Research{n/2+1} footer {n%2+1}",values[n*3+2]!["properties"]!["Text"]!.ToString());
        }
        File.WriteAllText(Path.Combine(work,"evidence.json"),new JsonObject { ["passed"]=true,["instances"]=4,["screens"]=2,["verify"]=true,["reload"]=true,["nativeMerge"]=true,["identityPreserved"]=true,["argumentAndSlotValuesPreserved"]=true,["browserExecuted"]=false }.ToJsonString());
        JsonObject Run(string source,string job,string output)=>JsonSerializer.SerializeToNode(JobRunner.Run(host,source,job,output))!.AsObject();
        JsonArray Read(string source,List<string> targets) {
            var job=Path.Combine(work,"read.json");File.WriteAllText(job,new JsonObject{["ops"]=new JsonArray(targets.Select(t=>(JsonNode)new JsonObject{["op"]="get",["target"]=t}).ToArray())}.ToJsonString());
            return new JsonArray(Run(source,job,Path.Combine(work,"read.oml"))["results"]!.AsArray().Select(r=>r!["result"]!.DeepClone()).ToArray());
        }
    }
}
