using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public class UiSourceImportsTests
{
    private static JsonObject Bundle()=>new() { ["entry"]="main.html",["files"]=new JsonObject {
        ["main.html"]="""
        <component name="ImportGallery" kind="screen">
          <script type="module">
            import { Panel as First } from './panel.html';
            import { Panel as Second } from '././panel.html';
          </script>
          <First id="One"></First><Second id="Two"></Second>
        </component>
        """,
        ["panel.html"]="""
        <component name="Panel">
          <script type="module">import Card from './card.html';</script>
          <Card id="Card" title="Shared"><span slot="Footer">Projected</span></Card>
        </component>
        <component name="UnusedScreen" kind="screen"><p>Must not be delivered</p></component>
        """,
        ["card.html"]="""
        <component name="Card">
          <script type="module">export const inputs={title:'string'}; export let count=0; export function increment(){count+=1;}</script>
          <style>article {padding:20px}</style>
          <article><h2>{{title}}</h2><p>{{count}}</p><button id="Increment" onclick="increment()">Increment</button><slot name="Footer"></slot></article>
        </component>
        """
    }};
    private static JsonObject Compile(JsonObject bundle)=>HtmlComponents.Compile(UiSourceBundle.From(bundle));

    [Fact] public void NestedAliasesShareDefinitionsAndDoNotImportUnreachableScreens()
    {
        var contract=Compile(Bundle());var owners=contract["screens"]!.AsArray();
        Assert.Equal(3,owners.Count);Assert.DoesNotContain("UnusedScreen",contract.ToJsonString());
        Assert.Equal("ImportGallery",owners[2]!["name"]!.ToString());
        var widgets=owners[2]!["widgets"]![0]!["slots"]!["Content"]![0]!["children"]!.AsArray();
        Assert.Equal(widgets[0]!["source"]!.ToString(),widgets[1]!["source"]!.ToString());
        Assert.Contains("Panel_U",widgets[0]!["source"]!.ToString());
        Assert.Equal(contract.ToJsonString(),Compile(Bundle()).ToJsonString());
    }
    [Fact] public void SameExportNameInDifferentFilesHasSeparateNativeIdentityAndCss()
    {
        var bundle=Bundle();bundle["files"]!["other.html"]=bundle["files"]!["card.html"]!.DeepClone();
        bundle["files"]!["main.html"]="""
        <component name="Page" kind="screen"><script type="module">import Left from './card.html';import Right from './other.html';</script><Left title="one"></Left><Right title="two"></Right></component>
        """;
        var owners=Compile(bundle)["screens"]!.AsArray();Assert.Equal(3,owners.Count);
        Assert.NotEqual(owners[0]!["name"]!.ToString(),owners[1]!["name"]!.ToString());
        Assert.NotEqual(owners[0]!["properties"]!["StyleSheet"]!.ToString(),owners[1]!["properties"]!["StyleSheet"]!.ToString());
    }
    [Fact] public void ComponentAliasDoesNotHijackAnHtmlButton()
    {
        var bundle=Bundle();bundle["files"]!["main.html"]="""
        <component name="Page" kind="screen"><script type="module">import Button from './card.html'; export function click(){}</script><Button title="Component"></Button><button id="Native" onclick="click()">Native</button></component>
        """;
        var contract=Compile(bundle);var widgets=contract["screens"]![1]!["widgets"]![0]!["slots"]!["Content"]![0]!["children"]!.AsArray();
        Assert.Equal("IMobileBlockInstanceWidget",widgets[0]!["type"]!.ToString());
        Assert.Equal("IButton",widgets[1]!["type"]!.ToString());
    }
    [Theory]
    [InlineData("import {Missing} from './card.html';", "matching export")]
    [InlineData("import Card from './missing.html';", "not supplied")]
    [InlineData("import Card from '../outside.html';", "escapes")]
    [InlineData("import Card from 'OtherModule';", "native module imports")]
    [InlineData("import Card from './helper.js';", ".html")]
    [InlineData("import * as Cards from './card.html';", "default or named")]
    public void InvalidImportsAreDiagnosedBeforeNativeRuntime(string import,string expected)
    {
        var bundle=Bundle();bundle["files"]!["main.html"]="<component name='Page' kind='screen'><script type='module'>"+import+"</script><p>Page</p></component>";
        Assert.Contains(expected,Assert.Throws<ArgumentException>(()=>Compile(bundle)).Message);
    }
    [Fact] public void FileCyclesReportOriginAndImportChain()
    {
        var bundle=Bundle();bundle["files"]!["card.html"]="<component name='Card'><script type='module'>import { Panel } from './panel.html';</script><Panel></Panel></component>";
        var error=Assert.Throws<ArgumentException>(()=>Compile(bundle));Assert.Contains("cycle",error.Message);Assert.Contains("card.html",error.Message);Assert.Contains("panel.html",error.Message);
    }
    [Fact] public void ImportedFilesAreFrozenAndEveryTransitiveEditInvalidatesTheReceipt()
    {
        var directory=Path.Combine(Path.GetTempPath(),"anvil-ui-imports-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        foreach(var file in Bundle()["files"]!.AsObject())File.WriteAllText(Path.Combine(directory,file.Key),file.Value!.ToString());
        var path=Path.Combine(directory,"main.html");var frozen=ModuleSpecification.Read(path);var sources=DeliveryReceipt.Sources(path);
        Assert.Equal(3,sources.Count);DeliveryReceipt.RequireFrozenSource(path,frozen);
        var old=ModuleSpecification.Normalize(frozen).ToJsonString();
        File.AppendAllText(Path.Combine(directory,"card.html"),"<!-- next revision -->");
        Assert.Single(DeliveryReceipt.Changed(sources));
        Assert.Throws<InvalidOperationException>(()=>DeliveryReceipt.RequireFrozenSource(path,frozen));
        Assert.Equal(old,ModuleSpecification.Normalize(frozen).ToJsonString());
    }
    [Fact] public void RepositoryEntryPathsUsePortableSeparatorsAndIncludeNestedFiles()
    {
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(UiSourceImportsTests).Assembly.Location)!)!;
        var path=Path.Combine(root,"tests/html/components/imports/main.html");
        var bundle=UiSourceBundle.Read(path);
        Assert.Equal("tests/html/components/imports/main.html",bundle.Entry);
        Assert.Equal(3,bundle.Files.Count);Assert.Equal(3,DeliveryReceipt.Sources(path).Count);
        Assert.Equal(3,HtmlComponents.Compile(bundle)["screens"]!.AsArray().Count);
    }
    [Fact] public void BundleThroughAppBoundaryRemainsImmutableAndHasNoFilesystemDependency()
    {
        var directory=Path.Combine(Path.GetTempPath(),"anvil-ui-app-"+Guid.NewGuid().ToString("N"));var sessions=new AppSessions(directory);
        var id=sessions.Capture(new JsonObject{["session_id"]="imports",["turn_id"]="one",["prompt"]="Create a screen from reusable blocks"})["taskId"]!.ToString();
        var proposal=new JsonObject{["module"]="Probe",["lane"]="ss5",["environment"]="fixture.test",["uiSource"]=Bundle()};
        Assert.True(sessions.Propose(id,proposal)["accepted"]!.GetValue<bool>());
        var changed=proposal.DeepClone().AsObject();changed["uiSource"]!["files"]!["card.html"]+="<!-- revision -->";
        Assert.Throws<InvalidOperationException>(()=>sessions.Propose(id,changed));
        var prepared=sessions.PrepareDelivery(id);
        var request=DeliveryTask.ResumeRequest(prepared["work"]!.ToString(),prepared["deliveryTaskId"]!.ToString());
        Assert.Equal(Compile(Bundle()).ToJsonString(),ModuleSpecification.Normalize(request.Specification!).ToJsonString());
    }
    [Fact] public void ImportedComponentUpdateAndAliasRenamePreserveNativeConsumersAfterMerge()
    {
        StudioAssemblies.Bind(null);var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(UiSourceImportsTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/review/import-tests");Directory.CreateDirectory(work);var host=new ModelHost(work);
        var initial=Compile(Bundle());var first=Path.Combine(work,"first.oml");Run(Path.Combine(root,"tests/fixtures/reactive-ui.oml"),initial,first);
        var expected=host.CheckModuleSpecification(first,initial);Assert.True(expected["accepted"]!.GetValue<bool>());
        var bundle=Bundle();bundle["files"]!["main.html"]=bundle["files"]!["main.html"]!.ToString().Replace("Second","Another");
        bundle["files"]!["card.html"]=bundle["files"]!["card.html"]!.ToString().Replace("count+=1","count+=2");
        var changed=Compile(bundle);var second=Path.Combine(work,"second.oml");Run(first,changed,second);
        var intended=host.CheckModuleSpecification(second,changed,expected["expectedTypes"]!.AsObject());Assert.True(intended["accepted"]!.GetValue<bool>(),intended["differences"]!.ToJsonString());
        var merged=Path.Combine(work,"merged.oml");var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(first),File.ReadAllBytes(second),merged);
        Assert.True(merge.LocalIsValid);Assert.False(merge.HasConflicts);
        var proof=host.CheckModuleSpecification(merged,changed,expected["expectedTypes"]!.AsObject());Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged,changed),op=>op!["op"]!.ToString() is "screen" or "logic" or "delete");
        void Run(string source,JsonObject contract,string output)
        {
            var job=Path.Combine(work,"job.json");File.WriteAllText(job,new JsonObject{["ops"]=host.PlanModuleSpecification(source,contract)}.ToJsonString());
            var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,source,job,output))!;
            Assert.True(result["accepted"]!.GetValue<bool>(),result["details"]!.ToJsonString());
        }
    }
}
