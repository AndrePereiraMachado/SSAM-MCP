using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;
public class HtmlComponentTests
{
    private static readonly string Root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlComponentTests).Assembly.Location)!)!;
    private static string Source=>File.ReadAllText(Path.Combine(Root,"tests/html/components/gallery.html"));
    [Fact] public void SourceAloneProducesNativeBlocksInstancesEventsAndOwnedStyles()
    {
        var contract=HtmlComponents.Compile(Source);var owners=contract["screens"]!.AsArray();Assert.Equal(5,owners.Count);
        Assert.Equal("IMobileBlock",owners[0]!["type"]!.ToString());Assert.Contains(":where(.avc-",owners[0]!["properties"]!["StyleSheet"]!.ToString());
        Assert.Equal(HtmlComponents.Compile(Source).ToJsonString(),contract.ToJsonString());
        Assert.Contains("ITriggerNode",contract.ToJsonString());Assert.Contains("IJavaScriptNode",contract.ToJsonString());
        Assert.Contains("ITextArea",contract.ToJsonString());Assert.Contains("ICheckbox",contract.ToJsonString());
        Assert.Contains("DecodeEvents.Data.Current",contract.ToJsonString());
        Assert.DoesNotContain("data-av",Source);Assert.DoesNotContain("bindings",Source);
    }
    [Fact] public void OneSourceFunctionHasOneNativeHandlerAcrossMultipleConsumers()
    {
        var contract=HtmlComponents.Compile(Source);var actions=contract["logic"]!["actions"]!.AsArray().OfType<JsonObject>();
        Assert.Single(actions.Where(a=>a["owner"]?.ToString()=="IMobileScreen:ComponentGallery" && a["name"]!.ToString().StartsWith("ComponentGallery_Handler_receive_",StringComparison.Ordinal)));
        var repeated="<component name='Page' kind='screen'><script type='module'>export function run(){}</script><button id='A' onclick='run()'>A</button><button id='B' onclick='run()'>B</button></component>";
        Assert.Single(HtmlComponents.Compile(repeated)["logic"]!["actions"]!.AsArray());
    }
    [Theory]
    [InlineData("<input type='file' bind:value='name'>", "unsupported input type")]
    [InlineData("<input bind:value='missing'>", "local state")]
    [InlineData("<label for='missing'>Label</label>", "label target")]
    [InlineData("<div onmouseover='run()'></div>", "unsupported native event")]
    [InlineData("<div onclick='run()'></div>", "native button")]
    [InlineData("<div bind:value='name'></div>", "native control")]
    [InlineData("<Child wrong='value'></Child>", "unknown component attribute")]
    [InlineData("<Child><div slot='Missing'>x</div></Child>", "unknown component slot")]
    public void UnsupportedOrAmbiguousSourceFailsBeforeLoadingRuntime(string body,string error)
    {
        var source="<component name='Page' kind='screen'><script type='module'>export let name=''; export function run(){}</script>"+body+"</component><component name='Child'><div></div></component>";
        Assert.Contains(error,Assert.Throws<ArgumentException>(()=>HtmlComponents.Compile(source)).Message);
    }
    [Fact] public void ForwardCompositionIsOrderedAndCyclesAndUnknownAttributesAreRejected()
    {
        var source="<component name='Page' kind='screen'><Child title='OK'></Child></component><component name='Child' kind='block'><script type='module'>export const inputs={title:'Text'};</script><p>{{ title }}</p></component>";
        var contract=HtmlComponents.Compile(source);Assert.Equal("Child",contract["screens"]![0]!["name"]!.ToString());
        Assert.Contains("unknown component attribute",Assert.Throws<ArgumentException>(()=>HtmlComponents.Compile(source.Replace("title='OK'","title='OK' typo='x'"))).Message);
        Assert.Contains("cycle",Assert.Throws<ArgumentException>(()=>HtmlComponents.Compile("<component name='A'><B></B></component><component name='B'><A></A></component>")).Message);
        Assert.Contains("synchronous",Assert.Throws<ArgumentException>(()=>HtmlComponents.Compile("<component name='A'><script type='module'>export async function run(){}</script></component>")).Message);
    }
    [Fact] public void CssOwnershipHandlesRootsPseudoElementsAndQuotedColons()
    {
        var css=CssStylesheet.Parse(":root > h2::after {content:'::'} [data-value='::'] {color:red} :is(h1,h2)::before {content:'x'}").ScopedOwned(".scope",".owner");
        Assert.Contains(".scope > h2:where(.owner)::after",css);
        Assert.Contains(".scope [data-value='::']:where(.owner)",css);
        Assert.Contains(".scope :is(h1,h2):where(.owner)::before",css);
        Assert.DoesNotContain(".scope :root",css);
        var ids=CssStylesheet.Parse("#Card:hover [data-id='#Card'] {color:red}").MapIds(new Dictionary<string,string>{{"Card","mapped-card"}}).ScopedOwned(".scope",".owner");
        Assert.Contains(":is(#Card,.mapped-card):hover [data-id='#Card']:where(.owner)",ids);
        Assert.Throws<InvalidOperationException>(()=>CssStylesheet.Parse("@import url('other.css');").ScopedOwned(".scope",".owner"));
    }
    [Fact] public void UpdatePreservesBlockContractAndConsumerKeysAfterNativeMerge()
    {
        StudioAssemblies.Bind(null);var work=Path.Combine(Root,".local/review/component-tests");Directory.CreateDirectory(work);var host=new ModelHost(work);
        var fixture=Path.Combine(Root,"tests/fixtures/reactive-ui.oml");var first=Path.Combine(work,"first.oml");var second=Path.Combine(work,"second.oml");
        var seedSource=System.Text.RegularExpressions.Regex.Replace(Source,"<p><button id=\"Rename\".*?</p>","",System.Text.RegularExpressions.RegexOptions.Singleline);
        var initial=HtmlComponents.Compile(seedSource);Run(fixture,initial,first);var proof=host.CheckModuleSpecification(first,initial);Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        var changed=HtmlComponents.Compile(Source.Replace("count += 1;","count += 2;").Replace("function receive(value)","function handle(value)").Replace("@changed=\"receive\"","@changed=\"handle\""));Run(first,changed,second);
        var intended=host.CheckModuleSpecification(second,changed);Assert.True(intended["accepted"]!.GetValue<bool>(),intended["differences"]!.ToJsonString());
        foreach(var reference in proof["expectedTypes"]!.AsObject().Where(p=>p.Key.EndsWith("/reference/SourceBlock",StringComparison.Ordinal)))
            if(intended["expectedTypes"]![reference.Key]!=null)Assert.True(JsonNode.DeepEquals(reference.Value,intended["expectedTypes"]![reference.Key]));
        var merged=Path.Combine(work,"merged.oml");var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(first),File.ReadAllBytes(second),merged);Assert.True(merge.LocalIsValid);Assert.False(merge.HasConflicts);
        var after=host.CheckModuleSpecification(merged,changed,intended["expectedTypes"]!.AsObject());Assert.True(after["accepted"]!.GetValue<bool>(),after["differences"]!.ToJsonString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged,changed),op=>op!["op"]!.ToString() is "screen" or "logic");
        var incompatible=changed.DeepClone().AsObject();incompatible["screens"]![0]!["inputs"]!.AsArray().Clear();
        Assert.Contains("consumer migration",Assert.Throws<InvalidOperationException>(()=>host.PlanModuleSpecification(merged,incompatible)).Message);
        var movedSlot=HtmlComponents.Compile(Source.Replace("<div id=\"FooterRegion\" class=\"footer\"><slot name=\"Footer\"></slot></div>","<section id=\"FooterRegion\" class=\"footer\"><slot name=\"Footer\"></slot></section>"));
        Assert.Contains("moving placeholder",Assert.Throws<InvalidOperationException>(()=>host.PlanModuleSpecification(merged,movedSlot)).Message);
        var smaller=HtmlComponents.Compile(System.Text.RegularExpressions.Regex.Replace(Source,"<button id=\"Burst\"[^>]*>.*?</button>",""));
        var prune=host.PlanModuleSpecification(merged,smaller);Assert.Contains(prune,o=>o!["op"]!.ToString()=="delete");
        var reduced=Path.Combine(work,"reduced.oml");Run(merged,smaller,reduced);
        Assert.True(host.CheckModuleSpecification(reduced,smaller)["accepted"]!.GetValue<bool>());
        Assert.Empty(host.PlanModuleSpecification(reduced,smaller).Where(o=>o!["op"]!.ToString() is "logic" or "screen" or "delete"));
        File.WriteAllText(Path.Combine(work,"evidence.json"),new JsonObject{["passed"]=true,["nativeMerge"]=true,["contractAfterMerge"]=true,["idempotent"]=true,["browser"]=false}.ToJsonString());
        void Run(string source,JsonObject contract,string output){var job=Path.Combine(work,"job.json");File.WriteAllText(job,new JsonObject{["ops"]=host.PlanModuleSpecification(source,contract)}.ToJsonString());var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,source,job,output))!;File.WriteAllText(output+".json",result.ToJsonString());Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());}
    }
}
