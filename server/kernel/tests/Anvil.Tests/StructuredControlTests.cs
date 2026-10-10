using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class StructuredControlTests
{
    private static JsonObject Contract() => JsonNode.Parse("""
    {"actions":[
      {"name":"CountSelected","inputs":[{"name":"Limit","type":"Integer"}],
       "outputs":[{"name":"Total","type":"Integer"}],"vars":[{"name":"Index","type":"Integer"}],
       "steps":[{"assign":{"Total":"0","Index":"0"}},
         {"if":"Limit < 0","then":[{"assign":{"Total":"-1"}},{"return":true}]},
         {"while":"Index < Limit","as":"CountLoop","do":[
           {"if":"Index = 1","then":[{"continue":true}]},
           {"if":"Index = 5","then":[{"break":true}]},
           {"assign":{"Total":"Total + Index"}}
         ],"next":[{"assign":{"Index":"Index + 1"},"as":"Advance"}]},
         {"assign":{"Total":"Total + 100"}},{"return":true}]},
      {"name":"FindSmall","inputs":[{"name":"Values","type":"Integer List"}],
       "outputs":[{"name":"Total","type":"Integer"}],"vars":[{"name":"Index","type":"Integer"}],
       "steps":[{"assign":{"Total":"0","Index":"0"}},
         {"while":"Index < Values.Length","as":"Each","do":[
           {"if":"Values[Index] = 0","then":[{"continue":true}]},
           {"if":"Values[Index] > 10","then":[{"break":true}]},
           {"assign":{"Total":"Total + Values[Index]"}}
         ],"next":[{"assign":{"Index":"Index + 1"}}]},{"return":true}]},
      {"name":"SumNonzero","inputs":[{"name":"Values","type":"Integer List"}],
       "outputs":[{"name":"Total","type":"Integer"}],
       "steps":[{"assign":{"Total":"0"}},
         {"foreach":"Values","do":[{"if":"Values.Current = 0","then":[{"continue":true}]},
           {"assign":{"Total":"Total + Values.Current"}}]},{"return":true}]},
      {"name":"Nested","inputs":[{"name":"Limit","type":"Integer"}],
       "outputs":[{"name":"Total","type":"Integer"}],
       "vars":[{"name":"Row","type":"Integer"},{"name":"Column","type":"Integer"}],
       "steps":[{"assign":{"Total":"0","Row":"0"}},
         {"while":"Row < Limit","do":[{"assign":{"Column":"0"}},
           {"while":"Column < 3","do":[
             {"if":"Column = 2","then":[{"break":true}]},
             {"assign":{"Total":"Total + 1"}}
           ],"next":[{"assign":{"Column":"Column + 1"}}]}
         ],"next":[{"assign":{"Row":"Row + 1"}}]},{"return":true}]}
    ]}
    """)!.AsObject();

    [Fact]
    public void LoopTransfersCompileDeterministicallyAndContinueExecutesIncrement()
    {
        var first = LogicExpander.Expand(Contract());
        Assert.Equal(JsonSerializer.Serialize(first), JsonSerializer.Serialize(LogicExpander.Expand(Contract())));
        Assert.Contains(first, op => op["op"]?.ToString() == "link" && op["from"]?.ToString() == "$CountSelected.If2" && op["connector"]?.ToString() == "TrueTarget" && op["to"]?.ToString() == "$CountSelected.Advance");
        Assert.Contains(first, op => op["op"]?.ToString() == "link" && op["from"]?.ToString() == "$CountSelected.Advance" && op["to"]?.ToString() == "$CountSelected.CountLoop");
    }

    [Theory]
    [InlineData("{\"break\":true}")]
    [InlineData("{\"continue\":true}")]
    [InlineData("{\"return\":false}")]
    [InlineData("{\"while\":\"True\",\"do\":[],\"next\":false}")]
    public void InvalidTransfersFailBeforeMutation(string step)
        => Assert.Throws<ArgumentException>(() => LogicExpander.Expand(JsonNode.Parse("{\"actions\":[{\"name\":\"Bad\",\"steps\":[" + step + "]}]}")!.AsObject()));

    [Fact]
    public void DirectNativeForeachBreakIsDiagnosedBeforeCreatingAnAmbiguousGraph()
    {
        var source = JsonNode.Parse("""{"actions":[{"name":"Bad","inputs":[{"name":"Values","type":"Integer List"}],"steps":[{"foreach":"Values","do":[{"break":true}]}]}]}""")!.AsObject();
        Assert.Contains("indexed while",Assert.Throws<ArgumentException>(() => LogicExpander.Expand(source)).Message);
    }

    [Fact]
    public void NativeLoopsAndReturnGraphsSurviveVerifyAndReload()
    {
        StudioAssemblies.Bind(); var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(StructuredControlTests).Assembly.Location)!)!;
        var work = Path.Combine(root,".local/data-logic-translator/native-control"); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var output = Path.Combine(work,"loops.oml"); var job = Path.Combine(work,"loops.json");
        var contract = new JsonObject { ["logic"] = Contract() };
        foreach (var action in contract["logic"]!["actions"]!.AsArray())
        { action!["public"] = true; action["access"] = new JsonObject { ["authenticated"] = true }; }
        var ops = host.PlanModuleSpecification(Path.Combine(root,"tests/fixtures/blank-service.oml"), contract);
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host,Path.Combine(root,"tests/fixtures/blank-service.oml"),job,output))!;
        File.WriteAllText(output+".result.json",result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(),result.ToJsonString());
        var proof = host.CheckModuleSpecification(output,contract);
        File.WriteAllText(Path.Combine(work,"proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof.ToJsonString());
        Assert.Empty(host.PlanModuleSpecification(output,contract));
    }
    [Theory]
    [InlineData("disabled-return")]
    [InlineData("orphan-return")]
    public void EquivalentEndsDoNotHideDisabledOrUnmatchedTerminals(string tamper)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(StructuredControlTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/terminal-contract",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");var host=new ModelHost(work);
        var declaration=Contract();
        foreach(var action in declaration["actions"]!.AsArray())
        {action!["public"]=true;action["access"]=new JsonObject{["authenticated"]=true};}
        var contract=new JsonObject{["logic"]=declaration};
        var input=Path.Combine(work,"job.json");var output=Path.Combine(work,"valid.oml");
        File.WriteAllText(input,new JsonObject{["ops"]=host.PlanModuleSpecification(basis,contract)}.ToJsonString());
        var created=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,input,output))!;
        Assert.True(created["accepted"]!.GetValue<bool>(),created.ToJsonString());
        var valid=host.CheckModuleSpecification(output,contract);
        Assert.True(valid["accepted"]!.GetValue<bool>(),valid.ToJsonString());
        Assert.True(valid["actionSummary"]!.AsArray().Any(a=>a!["equivalentEndCopies"]!.GetValue<int>()>0));
        JsonArray edits;
        if(tamper=="orphan-return")
            edits=new JsonArray(new JsonObject{["op"]="create",["parent"]="IServerAction:FindSmall",["type"]="IEndNode"});
        else
        {
            var model=typeof(ModelHost).GetMethod("Load",[typeof(string)])!.Invoke(host,[output])!;
            try
            {
                var session=Activator.CreateInstance(typeof(ModelSession),model)!;
                var owner=typeof(ModelSession).GetMethod("Resolve")!.Invoke(session,["IServerAction:FindSmall"])!;
                var ends=((System.Collections.IEnumerable)ModelHost.Prop(owner,"Nodes")!).Cast<object>()
                    .Where(n=>n.GetType().GetInterfaces().Any(t=>t.Name=="IEndNode")).ToArray();
                Assert.Equal(2,ends.Length);
                edits=new JsonArray(ends.Select(n=>(JsonNode)new JsonObject{["op"]="set",
                    ["target"]="@"+ModelHost.Prop(n,"ObjectKey"),["prop"]="IsDisabled",["value"]=true}).ToArray());
            }
            finally{typeof(ModelHost).GetMethod("Release")!.Invoke(null,[model]);}
        }
        File.WriteAllText(input,new JsonObject{["ops"]=edits}.ToJsonString());
        var changed=Path.Combine(work,"tampered.oml");
        JobRunner.Run(host,output,input,changed); // Invalid fixtures are saved for independent contract inspection.
        var rejected=host.CheckModuleSpecification(changed,contract);
        Assert.False(rejected["accepted"]!.GetValue<bool>());
        var properties=rejected["differences"]!.AsArray().Select(d=>d!["property"]!.ToString()).ToArray();
        Assert.Contains(tamper=="disabled-return"?"IsDisabled":"unmatchedNode",properties);
        File.WriteAllText(Path.Combine(work,"rejected-proof.json"),rejected.ToJsonString());
    }

}
