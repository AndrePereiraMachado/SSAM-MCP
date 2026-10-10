using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class HtmlValueTests
{
    private static readonly string Root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlValueTests).Assembly.Location)!)!;
    private static string Source=>File.ReadAllText(Path.Combine(Root,"tests/html/components/values.html"));
    [Fact] public void OrdinaryValuesProduceNativeStructuresAndWireCodecs()
    {
        var spec=HtmlComponents.Compile(Source);
        Assert.Equal(3,spec["data"]!["structures"]!.AsArray().Count);
        Assert.Equal(3,spec["screens"]![0]!["vars"]!.AsArray().Count);
        Assert.Equal(spec.ToJsonString(),HtmlComponents.Compile(Source).ToJsonString());
        foreach(var node in Descendants(spec).Where(n=>n["node"]?.ToString()=="IJavaScriptNode"))
            Assert.DoesNotContain(node["inputs"]!.AsArray(),p=>p!["type"]!.ToString().StartsWith("AvUi",StringComparison.Ordinal));
        var init=spec["logic"]!["actions"]!.AsArray().Single(a=>a!["name"]!.ToString()=="ValueCard_Handler_onInitialize")!;
        Assert.Equal("Initial_summary",init["steps"]![0]!["as"]!.ToString());
        Assert.Contains("Object.freeze",spec.ToJsonString());Assert.Contains("IJSONSerializeNode",spec.ToJsonString());
    }
    [Theory]
    [InlineData("[]","empty array")]
    [InlineData("{}","empty record")]
    [InlineData("[{x:1},{x:'wrong'}]","consistent structural type")]
    [InlineData("{id:9223372036854775807}","safe JavaScript")]
    [InlineData("{value:null}","nullable type")]
    [InlineData("{Name:'a',name:'b'}","duplicate record field")]
    public void AmbiguousOrLossyInitialValuesAreRejected(string value,string message)
        =>Assert.Contains(message,Assert.Throws<ArgumentException>(()=>HtmlComponents.Compile("<component name='Value'><script type='module'>export let state="+value+";</script><p>{{state}}</p></component>")).Message);
    [Fact] public void ValuesVerifyReloadMergeAndUpdateWithoutDuplicatingTypes()
    {
        StudioAssemblies.Bind(null);var work=Path.Combine(Root,".local/review/value-tests");Directory.CreateDirectory(work);var host=new ModelHost(work);
        var fixture=Path.Combine(Root,"tests/fixtures/reactive-ui.oml");var first=Path.Combine(work,"first.oml");var second=Path.Combine(work,"second.oml");
        var spec=HtmlComponents.Compile(Source);Run(fixture,spec,first);
        var proof=host.CheckModuleSpecification(first,spec);Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        var changed=HtmlComponents.Compile(Source.Replace("amount: 1.5","amount: 2.5"));
        Assert.Equal(spec["data"]!.ToJsonString(),changed["data"]!.ToJsonString());Run(first,changed,second);
        var merged=Path.Combine(work,"merged.oml");var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(first),File.ReadAllBytes(second),merged);
        Assert.True(merge.LocalIsValid);Assert.False(merge.HasConflicts);
        var after=host.CheckModuleSpecification(merged,changed,proof["expectedTypes"]!.AsObject());Assert.True(after["accepted"]!.GetValue<bool>(),after["differences"]!.ToJsonString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged,changed),o=>o!["op"]!.ToString() is "screen" or "logic" or "spec");
        void Run(string basis,JsonObject contract,string output)
        {
            var job=Path.Combine(work,"job.json");File.WriteAllText(job,new JsonObject{["ops"]=host.PlanModuleSpecification(basis,contract)}.ToJsonString());
            var r=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,output))!;Assert.True(r["accepted"]!.GetValue<bool>(),r.ToJsonString());
        }
    }
    private static IEnumerable<JsonObject> Descendants(JsonNode node)
    {
        if(node is JsonObject obj){yield return obj;foreach(var p in obj)if(p.Value!=null)foreach(var item in Descendants(p.Value))yield return item;}
        if(node is JsonArray array)foreach(var p in array)if(p!=null)foreach(var item in Descendants(p))yield return item;
    }
}
