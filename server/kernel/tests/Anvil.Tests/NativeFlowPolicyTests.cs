using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class NativeFlowPolicyTests
{
    [Theory]
    [InlineData("server", "IServerAction", "blank-service")]
    [InlineData("service", "IServiceAction", "blank-service")]
    [InlineData("client", "IClientAction", "reactive-ui")]
    public void LinearEarlyReturnsKeepTheirHorizontalRowsThroughNativeReloadAndMerge(string kind, string type, string fixture)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeFlowPolicyTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/native-terminal-row-policy", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests/fixtures", fixture + ".oml");
        JsonObject Assign(string name, string value) => new() {
            ["assign"] = new JsonObject { ["Result"] = value }, ["as"] = name };
        var steps = new JsonArray();
        for (var i = 1; i <= 4; i++) steps.Add(new JsonObject {
            ["if"] = "Option = " + i, ["as"] = "RejectCase" + i,
            ["then"] = new JsonArray(Assign("SetFailure" + i, i.ToString()),
                Assign("RecordFailure" + i, "Result + 10"), new JsonObject { ["return"] = true }) });
        for (var i = 1; i <= 4; i++) steps.Add(Assign("ContinueProcessing" + i, "Result + 1"));
        var declaration = new JsonObject { ["name"] = "ValidateOptions", ["kind"] = kind, ["public"] = true,
            ["description"] = "Return an error code for rejected options and continue processing accepted options.",
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Option", ["type"] = "Integer" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Integer" }), ["steps"] = steps };
        if (kind is "server" or "service") declaration["access"] = new JsonObject { ["authenticated"] = true };
        var specification = new JsonObject { ["logic"] = new JsonObject { ["actions"] = new JsonArray(declaration) } };
        var input = Path.Combine(work, "job.json"); var output = Path.Combine(work, "created.oml");
        File.WriteAllText(input, new JsonObject { ["ops"] = host.PlanModuleSpecification(basis, specification) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, input, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var first = Read(host, output, type + ":ValidateOptions");
        for (var i = 1; i <= 4; i++)
        {
            var decision = first.Single(n => n.Name == "RejectCase" + i);
            var node = decision;
            for (var step = 1; step <= 3; step++)
            {
                var target = step == 1 ? node.TrueTarget : node.Target;
                node = first.Single(n => n.Key == target);
                Assert.Equal(decision.Y, node.Y);
                Assert.Equal(decision.X + step * FlowLayout.ColStep, node.X);
            }
            Assert.Equal("IEndNode", node.Type);
            var continuation = first.Single(n => n.Key == decision.FalseTarget);
            Assert.Equal(decision.X, continuation.X);
            Assert.Equal(decision.Y + FlowLayout.RowStep, continuation.Y);
        }
        Assert.True(host.CheckModuleSpecification(output, specification)["accepted"]!.GetValue<bool>());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(output), merged);
        Assert.True(merge.LocalIsValid); Assert.False(merge.HasConflicts);
        Assert.Equal(first, Read(host, merged, type + ":ValidateOptions"));
        Assert.True(host.CheckModuleSpecification(merged, specification)["accepted"]!.GetValue<bool>());
        var repeat = Path.Combine(work, "repeat.json"); var again = Path.Combine(work, "again.oml");
        File.WriteAllText(repeat, new JsonObject { ["ops"] = new JsonArray(new JsonObject {
            ["op"] = "layout", ["target"] = type + ":ValidateOptions" }) }.ToJsonString());
        var repeated = JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, repeat, again))!;
        Assert.True(repeated["accepted"]!.GetValue<bool>(), repeated.ToJsonString());
        Assert.Equal(0, repeated["results"]![0]!["result"]!["moved"]!.GetValue<int>());
        Assert.Equal(first, Read(host, again, type + ":ValidateOptions"));
        File.WriteAllText(Path.Combine(work, "proof.json"), JsonSerializer.Serialize(first));
    }

    [Theory]
    [InlineData("server", "IServerAction", "blank-service")]
    [InlineData("service", "IServiceAction", "blank-service")]
    [InlineData("client", "IClientAction", "reactive-ui")]
    public void OptionalDecisionsKeepTheirSpineThroughNativeReloadAndMerge(string kind, string type, string fixture)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeFlowPolicyTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/native-spine-policy",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var host=new ModelHost(work);var basis=Path.Combine(root,"tests/fixtures",fixture+".oml");
        var steps=new JsonArray(new JsonObject{["assign"]=new JsonObject{["Result"]="0"},["as"]="InitializeResult"});
        for(var i=1;i<=5;i++)steps.Add(new JsonObject{
            ["if"]="Option = "+i,["as"]="IsCase"+i,
            ["then"]=new JsonArray(new JsonObject{["assign"]=new JsonObject{["Result"]=i.ToString()},["as"]="SelectCase"+i})});
        var declaration=new JsonObject{["name"]="ChooseCase",["kind"]=kind,["public"]=true,
            ["description"]="Choose the result using independent optional decisions.",
            ["inputs"]=new JsonArray(new JsonObject{["name"]="Option",["type"]="Integer"}),
            ["outputs"]=new JsonArray(new JsonObject{["name"]="Result",["type"]="Integer"}),["steps"]=steps};
        if(kind is "server" or "service")declaration["access"]=new JsonObject{["authenticated"]=true};
        var specification=new JsonObject{["logic"]=new JsonObject{["actions"]=new JsonArray(declaration)}};
        var input=Path.Combine(work,"job.json");var output=Path.Combine(work,"created.oml");
        File.WriteAllText(input,new JsonObject{["ops"]=host.PlanModuleSpecification(basis,specification)}.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,input,output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(),result.ToJsonString());
        var first=Read(host,output,type+":ChooseCase");
        var start=first.Single(n=>n.Type=="IStartNode");
        for(var i=1;i<=5;i++)
        {
            var decision=first.Single(n=>n.Name=="IsCase"+i);
            var body=first.Single(n=>n.Key==decision.TrueTarget);
            Assert.Equal(start.X,decision.X);
            if(i<5)
            {
                var continuation=first.Single(n=>n.Key==decision.FalseTarget);
                Assert.Equal(start.X,continuation.X);
                Assert.Equal(decision.X+1600,body.X);Assert.Equal(decision.Y,body.Y);
                Assert.Equal(continuation.Key,body.Target);
                Assert.Equal(decision.Y+1600,continuation.Y);
            }
            else Assert.Equal(start.X,body.X);
        }
        var beforeProof=host.CheckModuleSpecification(output,specification);
        Assert.True(beforeProof["accepted"]!.GetValue<bool>(),beforeProof.ToJsonString());
        var merged=Path.Combine(work,"merged.oml");
        var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(basis),File.ReadAllBytes(output),merged);
        Assert.True(merge.LocalIsValid);Assert.False(merge.HasConflicts);
        Assert.Equal(first,Read(host,merged,type+":ChooseCase"));
        var afterProof=host.CheckModuleSpecification(merged,specification);
        Assert.True(afterProof["accepted"]!.GetValue<bool>(),afterProof.ToJsonString());
        File.WriteAllText(Path.Combine(work,"proof.json"),JsonSerializer.Serialize(first));
    }

    [Theory]
    [InlineData("server", "IServerAction")]
    [InlineData("service", "IServiceAction")]
    public void HandlersAndIndependentEndsSurviveVerifyReloadAndMerge(string kind, string type)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeFlowPolicyTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/native-flow-policy",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var basis=Path.Combine(root,"tests/fixtures/blank-service.oml");
        var host=new ModelHost(work);
        var logic=JsonNode.Parse("""
        {"actions":[{"name":"EvaluateRequest","kind":"server","public":true,
          "inputs":[{"name":"Accepted","type":"Boolean"}],"outputs":[{"name":"Result","type":"Integer"}],
          "steps":[{"if":"Accepted","as":"IsRequestAccepted","then":[
            {"assign":{"Result":"1"},"as":"InitializeAcceptedResult"},
            {"assign":{"Result":"Result + 1"},"as":"CompleteAcceptedResult"}],
            "else":[{"assign":{"Result":"0"},"as":"RejectRequest"}]}],
          "handlers":[{"name":"HandleFailure","exception":"IUserException:Failure","abortTransaction":true,"logError":true,
            "steps":[{"assign":{"Result":"-1"},"as":"ReportFailure"}]}]
        }]}
        """)!.AsObject();
        logic["actions"]![0]!["kind"]=kind;
        var job=new JsonObject {["ops"]=new JsonArray(
            new JsonObject{["op"]="create",["parent"]="@espace",["type"]="IUserException",["name"]="Failure"},
            new JsonObject{["op"]="logic",["data"]=logic})};
        var input=Path.Combine(work,"job.json");var output=Path.Combine(work,"created.oml");
        File.WriteAllText(input,job.ToJsonString());
        var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,input,output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(),result.ToJsonString());
        var first=Read(host,output,type+":EvaluateRequest");
        File.WriteAllText(Path.Combine(work,"read.json"),JsonSerializer.Serialize(first));
        Check(first);
        var merged=Path.Combine(work,"merged.oml");
        var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(basis),File.ReadAllBytes(output),merged);
        Assert.True(merge.LocalIsValid);Assert.False(merge.HasConflicts);
        Assert.Equal(first,Read(host,merged,type+":EvaluateRequest"));
        File.WriteAllText(input,new JsonObject{["ops"]=new JsonArray(new JsonObject{["op"]="layout",["target"]=type+":EvaluateRequest"})}.ToJsonString());
        var again=Path.Combine(work,"again.oml");
        var repeated=JsonSerializer.SerializeToNode(JobRunner.Run(host,merged,input,again))!;
        Assert.True(repeated["accepted"]!.GetValue<bool>(),repeated.ToJsonString());
        Assert.Equal("anvil-d4d8ece", repeated["results"]![0]!["result"]!["engineRevision"]!.GetValue<string>());
        Assert.Equal(0,repeated["results"]![0]!["result"]!["moved"]!.GetValue<int>());
        Assert.Equal(0,repeated["results"]![0]!["result"]!["separatedEnds"]!.GetValue<int>());
        Assert.Equal(first,Read(host,again,type+":EvaluateRequest"));
        File.WriteAllText(Path.Combine(work,"proof.json"),JsonSerializer.Serialize(first));
    }

    [Fact]
    public void RefusedLayoutRestoresSharedEndsAndKeepsCoordinatesAndLabels()
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeFlowPolicyTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/native-flow-refusal",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var host=new ModelHost(work);
        var module=typeof(ModelHost).GetMethod("Load",[typeof(string)])!.Invoke(host,[Path.Combine(root,"tests/fixtures/blank-service.oml")])!;
        try
        {
            var session=(ModelSession)Activator.CreateInstance(typeof(ModelSession),[module])!;
            // Raw ops, no automatic layout: both branches share one End.
            var ops=JsonNode.Parse("""
            [
              {"op":"create","parent":"@espace","type":"IServerAction","name":"RefusalProbe","as":"$action"},
              {"op":"create","parent":"$action","type":"IInputParameter","name":"Flag","as":"$flag"},
              {"op":"set","target":"$flag","prop":"DataType","value":"Boolean"},
              {"op":"create","parent":"$action","type":"ILocalVariable","name":"Result","as":"$result"},
              {"op":"set","target":"$result","prop":"DataType","value":"Boolean"},
              {"op":"create","parent":"$action","type":"IStartNode","as":"$start"},
              {"op":"create","parent":"$action","type":"IIfNode","as":"$if"},
              {"op":"set","target":"$if","prop":"Condition","value":"Flag"},
              {"op":"create","parent":"$action","type":"IAssignNode","as":"$assign"},
              {"op":"create","parent":"$assign","type":"IAssignment","as":"$assignment"},
              {"op":"set","target":"$assignment","prop":"Variable","value":"Result"},
              {"op":"set","target":"$assignment","prop":"Value","value":"True"},
              {"op":"create","parent":"$action","type":"IEndNode","as":"$end"},
              {"op":"link","from":"$start","to":"$if"},
              {"op":"link","from":"$if","connector":"TrueTarget","to":"$assign"},
              {"op":"link","from":"$if","connector":"FalseTarget","to":"$end"},
              {"op":"link","from":"$assign","to":"$end"}
            ]
            """)!.AsArray();
            List<string>? before=null,afterRefusal=null,afterLayout=null;object? refused=null,laidOut=null;var seen=0;
            Mutate(module,()=>
            {
                foreach(var op in ops) session.ApplyOne(op!.AsObject());
                var owner=typeof(ModelSession).GetMethod("Resolve")!.Invoke(session,["IServerAction:RefusalProbe"])!;
                before=State(owner);
                var withArrange=typeof(FlowLayout).GetMethods(BindingFlags.NonPublic|BindingFlags.Static).Single(m=>m.Name=="Apply"&&m.GetParameters().Length==3);
                Func<IReadOnlyList<FlowGraphLayout.Vertex>,int,FlowGraphLayout.Cell[]> refuse=(graph,_)=>{seen=graph.Count;throw new FlowLayoutRefusedException("probe refusal");};
                refused=withArrange.Invoke(null,[ModelHost.Prop(owner,"Nodes"),"RefusalProbe",refuse]);
                afterRefusal=State(owner);
                var engine=typeof(FlowLayout).GetMethods(BindingFlags.Public|BindingFlags.Static).Single(m=>m.Name=="Apply"&&m.GetParameters().Length==2);
                laidOut=engine.Invoke(null,[ModelHost.Prop(owner,"Nodes"),"RefusalProbe"]);
                afterLayout=State(owner);
            });
            var refusal=(LayoutOutcome)refused!;
            Assert.Equal("probe refusal",refusal.Refused);
            Assert.Equal((4,0,0),(refusal.Nodes,refusal.Moved,refusal.SeparatedEnds));
            Assert.Equal(5,seen); // the engine saw the separated End copy, then it was undone
            Assert.Equal(before,afterRefusal); // same nodes, coordinates, connectors and labels
            var layout=(LayoutOutcome)laidOut!;
            Assert.Null(layout.Refused);
            Assert.Equal((5,1),(layout.Nodes,layout.SeparatedEnds));
            Assert.NotEqual(before,afterLayout);
        }
        finally{typeof(ModelHost).GetMethod("Release")!.Invoke(null,[module]);}
    }

    private static List<string> State(object owner)=>((IEnumerable)ModelHost.Prop(owner,"Nodes")!).Cast<object>().Select(n=>
    {
        string K(string p)=>ModelHost.Prop(ModelHost.Prop(n,p)??new object(),"ObjectKey")?.ToString()??"";
        var type=n.GetType().GetInterfaces().Select(i=>i.Name).FirstOrDefault(t=>t is "IStartNode" or "IEndNode" or "IIfNode" or "IAssignNode")??"?";
        return $"{ModelHost.Prop(n,"ObjectKey")}|{type}|{ModelHost.Prop(n,"HorizontalPosition")},{ModelHost.Prop(n,"VerticalPosition")}|{K("Target")}|{K("TrueTarget")}|{K("FalseTarget")}|{ModelHost.Prop(n,"Label")}";
    }).OrderBy(s=>s,StringComparer.Ordinal).ToList();

    private static void Mutate(object module,Action body)
    {
        var runtime=typeof(StudioAdapter).GetProperty("Runtime")!.GetValue(null)!;
        var mutate=runtime.GetType().GetMethods().Single(m=>m.Name=="Mutate"&&m.GetParameters().Length==3);
        var callback=new MutationCallback(body);
        var mutation=Delegate.CreateDelegate(typeof(Action<>).MakeGenericType(mutate.GetParameters()[0].ParameterType),callback,typeof(MutationCallback).GetMethod(nameof(MutationCallback.Run))!);
        mutate.Invoke(runtime,[module,"layout refusal probe",mutation]);
    }

    private sealed class MutationCallback(Action body){public void Run(object _)=>body();}

    private record Node(string Key,string Type,string Name,int X,int Y,string Target,string TrueTarget,string FalseTarget,string Exception,string Abort,string Log);
    private static Node[] Read(ModelHost host,string path,string action)
    {
        var model=typeof(ModelHost).GetMethod("Load",[typeof(string)])!.Invoke(host,[path])!;
        try
        {
            var session=Activator.CreateInstance(typeof(ModelSession),model)!;
            var owner=typeof(ModelSession).GetMethod("Resolve")!.Invoke(session,[action])!;
            return ((IEnumerable)ModelHost.Prop(owner,"Nodes")!).Cast<object>().Select(n=>
            {
                string P(string p)=>ModelHost.Prop(n,p)?.ToString()??"";
                string K(string p)=>ModelHost.Prop(ModelHost.Prop(n,p)??new object(),"ObjectKey")?.ToString()??"";
                var type=new[]{"IStartNode","IEndNode","IIfNode","IExceptionHandlerNode","IAssignNode"}.FirstOrDefault(name=>n.GetType().GetInterfaces().Any(t=>t.Name==name))??n.GetType().FullName!;
                return new Node(P("ObjectKey"),type,P("Name")+P("Label"),(int)ModelHost.Prop(n,"HorizontalPosition")!,
                    (int)ModelHost.Prop(n,"VerticalPosition")!,K("Target"),K("TrueTarget"),K("FalseTarget"),K("Exception"),P("AbortTransaction"),P("LogError"));
            }).OrderBy(n=>n.Key).ToArray();
        }
        finally{typeof(ModelHost).GetMethod("Release")!.Invoke(null,[model]);}
    }
    private static void Check(Node[] nodes)
    {
        var start=nodes.Single(n=>n.Type=="IStartNode");
        var handler=nodes.Single(n=>n.Type=="IExceptionHandlerNode");
        var decision=nodes.Single(n=>n.Type=="IIfNode");
        var larger=nodes.Single(n=>n.Key==decision.TrueTarget);
        var smaller=nodes.Single(n=>n.Key==decision.FalseTarget);
        Assert.Equal(decision.X,larger.X);Assert.Equal(1600,smaller.X-decision.X);
        Assert.Equal(1600,larger.Y-decision.Y);Assert.Equal(decision.Y,smaller.Y);
        Assert.Equal(start.Y,handler.Y);Assert.True(handler.X>smaller.X);
        Assert.Equal("True",handler.Abort);Assert.Equal("True",handler.Log);Assert.NotEmpty(handler.Exception);
        var ends=nodes.Where(n=>n.Type=="IEndNode").ToArray();Assert.Equal(3,ends.Length);
        foreach(var end in ends)
            Assert.Single(nodes.SelectMany(n=>new[]{n.Target,n.TrueTarget,n.FalseTarget}).Where(k=>k==end.Key));
    }
}

