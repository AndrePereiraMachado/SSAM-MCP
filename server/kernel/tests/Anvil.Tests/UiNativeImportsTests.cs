using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class UiNativeImportsTests
{
    private const string Source="""
        <component name="NativeImportPage" kind="screen">
          <script type="module">
            import { Card as First } from 'outsystems:OutSystemsUI/Content';
            import Second from 'outsystems:OutSystemsUI/Content/Card';
          </script>
          <First id="One"><p>First native card</p></First>
          <Second id="Two" :UsePadding="false"><p>Second native card</p></Second>
        </component>
        """;
    private static JsonObject Specification(string source=Source)=>new(){["uiSource"]=source};

    [Fact] public void SourceCanBeFrozenWithoutLoadingOrInventingNativeSignatures()
    {
        ModuleSpecification.Validate(Specification());
        Assert.Contains("target module snapshot",Assert.Throws<ArgumentException>(()=>ModuleSpecification.Normalize(Specification())).Message);
        var bound=UiSourceProgram.Bind(UiSourceBundle.From(JsonValue.Create(Source)!));
        Assert.Single(bound.Components);Assert.Equal(2,bound.Components[0].NativeSymbols.Count);
        Assert.Equal(bound.Components[0].NativeSymbols["First"],bound.Components[0].NativeSymbols["Second"]);
    }
    [Theory]
    [InlineData("outsystems:OutSystemsUI", "Card")]
    [InlineData("outsystems:OutSystemsUI/../Content", "Card")]
    [InlineData("outsystems:OutSystemsUI/Content/Card", "Card")]
    [InlineData("outsystems:OutSystemsUI/Content", null)]
    [InlineData("x", null)]
    public void NativeImportRequiresAnUnambiguousProducerFlowAndExport(string path,string? export)
        =>Assert.Throws<ArgumentException>(()=>UiNativeImport.Parse(new(path,export,"Alias",1,1)));

    [Fact] public void ImportUsesProducerNameWhenNativeImportAliasesTheFlow()
    {
        StudioAssemblies.Bind(null);
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(UiNativeImportsTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/review/native-import-tests/producer");Directory.CreateDirectory(work);
        var host=new ModelHost(work);var fixture=Path.Combine(root,"tests/fixtures/reactive-ui.oml");
        // The same public template clone operation as TemplateModules, without server calls.
        // Reflection keeps the test project from redistributing/referencing the proprietary assembly.
        var type=typeof(ModelHost).GetMethods().Single(m=>m.Name=="Save").GetParameters()[0].ParameterType;
        var clone=type.GetMethods().Single(m=>m.Name=="Clone"&&m.IsStatic&&m.GetParameters().Length==9);
        var delegateType=clone.GetParameters()[5].ParameterType;
        var parameter=System.Linq.Expressions.Expression.Parameter(type,"module");
        var setName=type.GetMethod("SetName",[typeof(string)])!;
        var configure=System.Linq.Expressions.Expression.Lambda(delegateType,
            System.Linq.Expressions.Expression.Call(parameter,setName,System.Linq.Expressions.Expression.Constant("UiImportedProducer")),parameter).Compile();
        using var stream=new MemoryStream(File.ReadAllBytes(fixture));
        var module=clone.Invoke(null,[stream,null,null,null,false,configure,null,false,false])!;
        var producerBase=Path.Combine(work,"producer-base.oml");
        try {File.WriteAllBytes(producerBase,(byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host,[module])!);}
        finally {typeof(ModelHost).GetMethod("Release")!.Invoke(null,[module]);}
        var producer=Path.Combine(work,"producer.oml");var job=Path.Combine(work,"job.json");
        var block=HtmlComponents.Compile("<component name='Shared'><p>Shared block</p></component>");
        File.WriteAllText(job,new JsonObject{["ops"]=host.PlanModuleSpecification(producerBase,block)}.ToJsonString());
        Require(JobRunner.Run(host,producerBase,job,producer));
        var consumer=Path.Combine(work,"consumer.oml");
        File.WriteAllText(job,new JsonObject{["ops"]=new JsonArray(new JsonObject{
            ["op"]="reference",["producer"]="UiProducer",["elements"]=new JsonArray("IMobileBlock:Shared")})}.ToJsonString());
        Require(JobRunner.Run(host,fixture,job,consumer,bindings:new Dictionary<string,string>{{"UiProducer",producer}}));
        var spec=Specification("""
            <component name="Consumer" kind="screen"><script type="module">
            import { Shared } from 'outsystems:UiImportedProducer/MainFlow';
            </script><Shared id="One"></Shared><Shared id="Two"></Shared></component>
            """);
        var output=Path.Combine(work,"output.oml");
        File.WriteAllText(job,new JsonObject{["ops"]=host.PlanModuleSpecification(consumer,spec)}.ToJsonString());
        Require(JobRunner.Run(host,consumer,job,output));
        var proof=host.CheckModuleSpecification(output,spec);Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        Assert.Single(proof["nativeImports"]!.AsObject());
        Assert.DoesNotContain(host.PlanModuleSpecification(output,spec),o=>o!["op"]!.ToString() is "screen" or "logic");
        static void Require(object result){var r=JsonSerializer.SerializeToNode(result)!;Assert.True(r["accepted"]!.GetValue<bool>(),r.ToJsonString());}
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NativeBlockReusesReferenceAfterReloadAndMergeAndFreezesItsFingerprint(bool withEvents)
    {
        StudioAssemblies.Bind(null);
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(UiNativeImportsTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/review/native-import-tests/"+(withEvents?"events":"cards"));Directory.CreateDirectory(work);
        var host=new ModelHost(work);var fixture=Path.Combine(root,"tests/fixtures/reactive-ui.oml");
        var spec=withEvents?ModuleSpecification.Read(Path.Combine(root,"tests/html/components/native-imports.html")):Specification();var ops=host.PlanModuleSpecification(fixture,spec);
        Assert.DoesNotContain(ops.Where(o=>o!["op"]!.ToString()=="screen"),o=>o!["data"]!["owners"]!.AsArray().Any(n=>n!["type"]!.ToString()=="IMobileBlock"));
        var output=Path.Combine(work,"native.oml");var job=Path.Combine(work,"job.json");
        File.WriteAllText(job,new JsonObject{["ops"]=ops}.ToJsonString());
        var applied=JsonSerializer.SerializeToNode(JobRunner.Run(host,fixture,job,output))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(),applied["details"]!.ToJsonString());
        var proof=host.CheckModuleSpecification(output,spec);
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof["differences"]!.ToJsonString());
        Assert.Equal(withEvents?2:1,proof["nativeImports"]!.AsObject().Count);
        var binding=proof["nativeImports"]!["IReference:OutSystemsUI/Content/Card"]!;
        Assert.False(string.IsNullOrEmpty(binding["blockKey"]!.ToString()));
        Assert.False(string.IsNullOrEmpty(binding["referenceHash"]!.ToString()));
        var merged=Path.Combine(work,"merged.oml");var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(fixture),File.ReadAllBytes(output),merged);
        Assert.True(merge.LocalIsValid);Assert.False(merge.HasConflicts);
        var after=host.CheckModuleSpecification(merged,spec,proof["expectedTypes"]!.AsObject());
        Assert.True(after["accepted"]!.GetValue<bool>(),after["differences"]!.ToJsonString());
        Assert.DoesNotContain(host.PlanModuleSpecification(merged,spec),o=>o!["op"]!.ToString() is "screen" or "logic");
        var tampered=proof["expectedTypes"]!.DeepClone().AsObject();
        tampered["uiImport/IReference:OutSystemsUI/Content/Card"]!["referenceHash"]="different version";
        Assert.False(host.CheckModuleSpecification(merged,spec,tampered)["accepted"]!.GetValue<bool>());
        if(withEvents)
        {
            var source=File.ReadAllText(Path.Combine(root,"tests/html/components/native-imports.html"));
            Assert.Contains("missing event handler",Assert.Throws<ArgumentException>(()=>host.PlanModuleSpecification(fixture,Specification(source.Replace("@OnNavigate=\"navigate\"","")))).Message);
            Assert.Contains("codec",Assert.Throws<ArgumentException>(()=>host.PlanModuleSpecification(fixture,Specification(source.Replace("TotalCount=\"34\"",":TotalCount=\"34\"")))).Message);
        }
        Assert.Contains("registered producer",Assert.Throws<ArgumentException>(()=>host.PlanModuleSpecification(fixture,Specification(Source.Replace("OutSystemsUI","MissingProducer")))).Message);
    }
}
