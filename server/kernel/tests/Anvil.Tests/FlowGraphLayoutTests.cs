using Anvil.Core;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.Tests;

public sealed class FlowGraphLayoutTests
{
    private static FlowGraphLayout.Vertex V(params int[] edges) => new(edges);
    private static FlowGraphLayout.Cell[] Layout(params FlowGraphLayout.Vertex[] graph) => FlowGraphLayout.Arrange(graph, 0);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LargerIfBranchIsVerticalRegardlessOfItsBooleanConnector(bool reverse)
    {
        var graph=new[]{V(1),reverse?V(3,2):V(2,3),V(6),V(4),V(5),V(6),V()};
        var p=FlowGraphLayout.Arrange(graph,0);
        Assert.Equal(p[1].Column,p[3].Column);
        Assert.Equal(p[3].Column,p[4].Column);
        Assert.Equal(p[4].Column,p[5].Column);
        Assert.True(p[2].Column>p[1].Column);
        Assert.True(p[6].Row>Math.Max(p[2].Row,p[5].Row));
    }

    [Fact]
    public void IndependentHandlersBeginBesideMainFlowAtStartHeight()
    {
        var graph=new[]{V(1),V(2,3),V(4),V(4),V(),
            new FlowGraphLayout.Vertex([6],Handler:true),V(7),V(),
            new FlowGraphLayout.Vertex([9],Handler:true),V()};
        var p=FlowGraphLayout.Arrange(graph,0);
        Assert.Equal(p[0].Row,p[5].Row);
        Assert.Equal(p[0].Row,p[8].Row);
        Assert.True(p[5].Column>p.Take(5).Max(c=>c.Column));
        Assert.True(p[8].Column>p.Skip(5).Take(3).Max(c=>c.Column));
        Assert.Equal(p[5].Column,p[7].Column);
        Assert.Equal(p.Length,p.Distinct().Count());
        Assert.Equal(p,FlowGraphLayout.Arrange(graph,0));
    }

    [Fact]
    public void SharedTerminalReusesCompletedBranchLanesAndKeepsEdgesClear()
    {
        var graph=new FlowGraphLayout.Vertex[]{
            V(1),V(2,15),V(3,4),V(5,6),V(15),V(7,8),V(15),
            V(9),V(15),V(10),V(11),V(12),V(13),V(14),V(15),new([],Terminal:true)
        };
        var original=graph.Select(v=>v.Targets.ToArray()).ToArray();
        var cells=FlowGraphLayout.Arrange(graph,0);
        Assert.InRange(cells.Max(c=>c.Column),1,3);
        Assert.Equal(graph.Length,cells.Distinct().Count());
        for(var from=0;from<graph.Length;from++)
        {
            Assert.Equal(original[from],graph[from].Targets);
            foreach(var to in graph[from].Targets)
                foreach(var node in Enumerable.Range(0,graph.Length).Except(new[]{from,to}))
                {
                    var a=cells[from];var b=cells[to];var q=cells[node];
                    var dx=(double)b.Column-a.Column;var dy=(double)b.Row-a.Row;
                    var x=(double)q.Column-a.Column;var y=(double)q.Row-a.Row;
                    var length=dx*dx+dy*dy;var dot=x*dx+y*dy;var cross=x*dy-y*dx;
                    Assert.False(dot>0 && dot<length && cross*cross<.15*.15*length,
                        $"edge {from}->{to} passes node {node}");
                }
        }
        Assert.Equal(cells,FlowGraphLayout.Arrange(graph,0));
    }

    [Fact]
    public void NestedLoopExitToEnclosingHeaderKeepsItsBodyBesideTheHeader()
    {
        // The inner loop exit is a back edge to its enclosing loop, not a
        // forward continuation. Removing it for ranking must not collapse Cycle.
        var graph = new FlowGraphLayout.Vertex[] {
            V(1), new([2,8],Main:8), new([3,1],Main:1), V(4),
            new([5,2],Main:2), V(6), V(7), V(4), V()
        };
        var p = FlowGraphLayout.Arrange(graph,0);
        Assert.Equal(p[1].Column+1,p[2].Column);
        Assert.Equal(p[2].Column+1,p[3].Column);
        Assert.Equal(p[3].Column,p[4].Column);
        Assert.Equal(p[4].Column+1,p[5].Column);
        Assert.Equal(p[5].Column,p[7].Column);
        Assert.True(p[8].Row>p[7].Row);
        Assert.Equal(graph.Length,p.Distinct().Count());
        // No other node center may lie on any return edge in this fixture.
        foreach(var (from,to) in new[]{(2,1),(4,2),(7,4)})
        {
            var a=p[from];var b=p[to];
            foreach(var i in Enumerable.Range(0,p.Length).Except(new[]{from,to}))
            {
                var q=p[i];
                var cross=(q.Column-a.Column)*(b.Row-a.Row)-(q.Row-a.Row)*(b.Column-a.Column);
                var dot=(q.Column-a.Column)*(b.Column-a.Column)+(q.Row-a.Row)*(b.Row-a.Row);
                var length=(b.Column-a.Column)*(b.Column-a.Column)+(b.Row-a.Row)*(b.Row-a.Row);
                Assert.False(cross==0 && dot>0 && dot<length);
            }
        }
    }

    [Fact]
    public void LoopWithConditionalBodiesFinishesBeforeExitReusesItsColumns()
    {
        var p=Layout(V(1),new([2,7],Main:7),V(4,3),V(4),V(1,5),V(1),V(),V(10,8),V(9),V(10),V());
        Assert.True(p[7].Row>new[]{p[2].Row,p[3].Row,p[4].Row,p[5].Row}.Max());
        Assert.Equal(p[1].Column,p[7].Column);
        Assert.Equal(p[2].Column+1,p[3].Column); // Optional work returns to the loop-body continuation.
        Assert.Equal(p[7].Column,p[8].Column);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SequentialOptionalAssignmentsKeepOneVerticalContinuation(bool reverse)
    {
        var graph = new[]{V(1), V(3,2), V(3), V(5,4), V(5), V(7,6), V(7), V(8), V()};
        if(reverse) graph=graph.Select(v=>v with {Targets=v.Targets.Reverse().ToArray()}).ToArray();
        var p = FlowGraphLayout.Arrange(graph,0);
        foreach (var decision in new[]{1,3,5})
        {
            Assert.Equal(0,p[decision].Column);
            Assert.Equal(p[decision].Column,p[decision+2].Column);
            Assert.Equal(p[decision].Column+1,p[decision+1].Column);
            Assert.Equal(p[decision].Row,p[decision+1].Row);
            Assert.True(p[decision+2].Row>p[decision+1].Row);
        }
        Assert.Equal(1,p.Max(c=>c.Column));
        Assert.Equal(p,FlowGraphLayout.Arrange(graph,0));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(8)]
    public void OptionalBodiesReturnToTheSpineRegardlessOfTheirLength(int length)
    {
        var graph=new List<FlowGraphLayout.Vertex>{V(1),V(2,4),V(3),V()};
        for(var i=0;i<length;i++)graph.Add(V(i+1==length?2:i+5));
        var p=FlowGraphLayout.Arrange(graph,0);
        Assert.Equal(p[0].Column,p[1].Column);
        Assert.Equal(p[1].Column,p[2].Column);
        Assert.Equal(p[2].Column,p[3].Column);
        foreach(var i in Enumerable.Range(4,length))Assert.Equal(p[1].Column+1,p[i].Column);
        Assert.Equal(p[1].Row,p[4].Row);
        Assert.Equal(p[^1].Row+1,p[2].Row);
        Assert.Equal(graph.Count,p.Distinct().Count());
    }

    [Fact]
    public void SequentialValidationExceptionsReuseOneAdjacentColumn()
    {
        var graph = new List<FlowGraphLayout.Vertex> { V(1) };
        for(var i=0;i<12;i++)
        {
            graph.Add(V(i==11?25:3+2*i,2+2*i));
            graph.Add(new([],Terminal:true));
        }
        graph.Add(new([],Terminal:true));
        var p=FlowGraphLayout.Arrange(graph,0);
        for(var i=0;i<12;i++)
        {
            Assert.Equal(p[1+2*i].Column+1,p[2+2*i].Column);
            Assert.Equal(p[1+2*i].Row,p[2+2*i].Row);
        }
        Assert.Equal(1,p.Max(c=>c.Column));
    }

    [Fact]
    public void SequentialEarlyReturnBodiesDoNotCrossTheNextDecision()
    {
        var p=Layout(V(1),V(5,2),V(3),V(4),new([],Terminal:true),V(9,6),V(7),V(8),new([],Terminal:true),V());
        Assert.True(p[2].Column>p[1].Column); // Five-node continuation outweighs this three-node return.
        Assert.Equal(p[5].Column,p[6].Column); // The next return outweighs its one-node alternative.
        Assert.Equal(p[1].Row+1,p[5].Row);
        Assert.True(p[9].Column>p[5].Column);
        Assert.Equal(p[5].Row+1,p[6].Row);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConsecutiveLinearEarlyReturnsStayHorizontalAtTheirDecisionHeight(bool reverse)
    {
        // Repeated validation guards, each with two work nodes and its own End.
        var graph = new List<FlowGraphLayout.Vertex> { V(1) };
        for (var i = 0; i < 6; i++)
        {
            var decision = graph.Count;
            graph.Add(V(decision + 4, decision + 1));
            graph.Add(V(decision + 2));
            graph.Add(V(decision + 3));
            graph.Add(new([], Terminal: true));
        }
        // Keep the final guard's larger continuation on the spine too.
        for (var i = 0; i < 4; i++) graph.Add(V(graph.Count + 1));
        graph.Add(new([], Terminal: true));
        if (reverse) graph = graph.Select(v => v with { Targets = v.Targets.Reverse().ToArray() }).ToList();
        var before = graph.Select(v => v.Targets.ToArray()).ToArray();
        var p = FlowGraphLayout.Arrange(graph, 0);
        for (var i = 0; i < 6; i++)
        {
            var decision = 1 + 4 * i;
            Assert.Equal(0, p[decision].Column);
            Assert.Equal(p[decision].Row + 1, p[decision + 4].Row);
            for (var step = 1; step <= 3; step++)
            {
                Assert.Equal(p[decision].Row, p[decision + step].Row);
                Assert.Equal(step, p[decision + step].Column);
            }
        }
        Assert.Equal(3, p.Max(c => c.Column));
        Assert.Equal(graph.Count, p.Distinct().Count());
        Assert.Equal(p, FlowGraphLayout.Arrange(graph, 0));
        for (var i = 0; i < graph.Count; i++) Assert.Equal(before[i], graph[i].Targets);
    }

    [Fact]
    public void EarlyReturnInsideNestedDecisionIsHorizontalWithoutFlatteningItsParent()
    {
        var graph = new[] { V(1), V(2, 3), V(15), V(4, 7), V(5), V(6),
            new FlowGraphLayout.Vertex([], Terminal: true), V(8), V(9), V(10), V(11),
            V(12), V(13), V(14), V(15), V() };
        var p = FlowGraphLayout.Arrange(graph, 0);
        Assert.Equal(p[1].Column, p[3].Column); // Larger nested body stays vertical.
        Assert.Equal(p[3].Row, p[4].Row);
        Assert.Equal(p[3].Row, p[5].Row);
        Assert.Equal(p[3].Row, p[6].Row);
        Assert.Equal(p[4].Column + 1, p[5].Column);
        Assert.Equal(p[5].Column + 1, p[6].Column);
        Assert.Equal(p[3].Column, p[7].Column);
        Assert.Equal(graph.Length, p.Distinct().Count());
    }

    [Fact]
    public void UnequalBranchesJoinBelowBothTailsAndKeepContinuationBelowJoin()
    {
        var p = Layout(V(1), V(2, 3), V(6), V(4), V(5), V(6), V(7), V());
        Assert.True(p[6].Row > Math.Max(p[2].Row, p[5].Row));
        Assert.True(p[7].Row > p[6].Row);
        Assert.Equal(0, p[6].Column);
        Assert.Equal(p.Length, p.Distinct().Count());
    }

    [Fact]
    public void SideBodyWithSharedTerminalIsNotMistakenForAnIndependentEarlyReturn()
    {
        var graph = new[] { V(1), V(5, 2), V(3), V(4),
            new FlowGraphLayout.Vertex([], Terminal: true), V(6), V(7), V(8), V(4) };
        var p = FlowGraphLayout.Arrange(graph, 0);
        Assert.Equal(p[2].Column, p[3].Column);
        Assert.Equal(p[2].Row + 1, p[3].Row);
        Assert.True(p[4].Row > Math.Max(p[3].Row, p[8].Row));
        Assert.Equal(graph.Length, p.Distinct().Count());
    }

    [Fact]
    public void NestedDiamondsReserveSeparateLanesAndSequentialDiamondsReuseThem()
    {
        var p = Layout(V(1), V(2,3), V(8), V(4,5), V(7), V(6), V(7), V(8), V(9,10), V(11), V(11), V());
        Assert.True(p[7].Row > Math.Max(p[4].Row, p[6].Row));
        Assert.True(p[8].Row > Math.Max(p[2].Row, p[7].Row));
        Assert.True(p[11].Row > Math.Max(p[9].Row, p[10].Row));
        Assert.InRange(p.Max(c => c.Column), 1, 2);
        Assert.Equal(p.Length, p.Distinct().Count());
    }

    [Fact]
    public void SwitchSiblingsHaveSeparateLanesAndEndWaitsForEveryBranch()
    {
        var p = Layout(V(1), V(2,3,4,5), V(6), V(6), V(6), V(6), V());
        Assert.Equal(4, new[] {p[2].Column,p[3].Column,p[4].Column,p[5].Column}.Distinct().Count());
        Assert.True(p[6].Row > Enumerable.Range(2,4).Max(n => p[n].Row));
    }

    [Fact]
    public void WhileKeepsBodyToRightAndExitDownwardEvenWithLongBody()
    {
        var graph = new[] {V(1),V(5,2),V(3),V(4),V(1),V(6),V()};
        var before = graph.Select(v => string.Join(',',v.Targets)).ToArray();
        var p = FlowGraphLayout.Arrange(graph,0);
        Assert.Equal(p[1].Column,p[5].Column);
        Assert.True(p[2].Column > p[1].Column);
        Assert.Equal(p[1].Row,p[2].Row);
        Assert.True(p[4].Row > p[3].Row);
        Assert.Equal(before,graph.Select(v => string.Join(',',v.Targets)));
        Assert.Equal(p,FlowGraphLayout.Arrange(graph,0));
    }

    [Fact]
    public void MultipleTerminalsDoNotGetCollapsedIntoMainLane()
    {
        var p = Layout(V(1),V(2,3),new([],Terminal:true),new([],Terminal:true),V(5),V());
        Assert.NotEqual(p[2].Column,p[3].Column);
        Assert.True(p[4].Row > Math.Max(p[2].Row,p[3].Row));
    }

    [Fact]
    public void ForwardGraphsNeverOverlapOrPointUpwardAfterCollisionResolution()
    {
        var random=new Random(20260909);
        for(var sample=0;sample<100;sample++)
        {
            var graph=Enumerable.Range(0,30).Select(n=>V(Enumerable.Range(n+1,29-n).Where(t=>t==n+1||random.Next(12)==0).ToArray())).ToArray();
            var p=FlowGraphLayout.Arrange(graph,0);
            Assert.Equal(p.Length,p.Distinct().Count());
            foreach(var n in Enumerable.Range(0,graph.Length))
                foreach(var t in graph[n].Targets)
                    Assert.True(p[t].Row>p[n].Row || p[t].Row==p[n].Row && p[t].Column>p[n].Column,$"edge {n}->{t}");
        }
    }

    [Fact]
    public void NestedLoopsWithASharedTerminalCanUseAnAdditionalClearLane()
    {
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FlowGraphLayoutTests).Assembly.Location)!)!;
        var fixture=JsonNode.Parse(File.ReadAllText(Path.Combine(root,"tests/fixtures/flow-layout-nested-shared-terminal.json")))!;
        var graph=System.Text.Json.JsonSerializer.Deserialize<FlowGraphLayout.Vertex[]>(fixture["graph"]!.ToJsonString())!;
        var original=graph.Select(v=>string.Join(',',v.Targets)).ToArray();
        var start=fixture["start"]!.GetValue<int>();
        var p=FlowGraphLayout.Arrange(graph,start);
        Assert.Equal(graph.Length,p.Distinct().Count());
        Assert.InRange(p.Max(c=>c.Column)*80,80,1200); // Preserve the physical width bound after reducing the grid from 240 to 80 px.
        Assert.Equal(original,graph.Select(v=>string.Join(',',v.Targets)));
        Assert.Equal(p,FlowGraphLayout.Arrange(graph,start));
        for(var from=0;from<graph.Length;from++)
            foreach(var to in graph[from].Targets)
            {
                var ax=p[from].Column*80d;var ay=p[from].Row*80d;
                var dx=(p[to].Column-p[from].Column)*80d;var dy=(p[to].Row-p[from].Row)*80d;
                var length=dx*dx+dy*dy;
                if(length==0)continue;
                for(var node=0;node<p.Length;node++)
                {
                    if(node==from||node==to)continue;
                    var x=p[node].Column*80d;var y=p[node].Row*80d;
                    var t=((x-ax)*dx+(y-ay)*dy)/length;
                    if(t<=0||t>=1)continue;
                    var distance=Math.Sqrt(Math.Pow(x-ax-t*dx,2)+Math.Pow(y-ay-t*dy,2));
                    Assert.True(distance>=12,$"Edge {from}->{to} intersects node {node}");
                }
            }
    }

    [Fact]
    public void ArrangementWithoutAClearCellIsATypedRefusalThatLeavesTheGraphIntact()
    {
        // Real topology (HMISJHA_CS DispatchToolCall): a wide Switch rejoining one node.
        // Callers catch this type to keep the flow's geometry instead of aborting the job.
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FlowGraphLayoutTests).Assembly.Location)!)!;
        var fixture=JsonNode.Parse(File.ReadAllText(Path.Combine(root,"tests/fixtures/flow-layout-refused-switch-join.json")))!;
        var graph=System.Text.Json.JsonSerializer.Deserialize<FlowGraphLayout.Vertex[]>(fixture["graph"]!.ToJsonString())!;
        var original=graph.Select(v=>string.Join(',',v.Targets)).ToArray();
        var refusal=Assert.Throws<FlowLayoutRefusedException>(()=>FlowGraphLayout.Arrange(graph,fixture["start"]!.GetValue<int>()));
        Assert.IsAssignableFrom<InvalidOperationException>(refusal);
        Assert.Contains("could not find a clear grid position",refusal.Message);
        Assert.Equal(original,graph.Select(v=>string.Join(',',v.Targets)));
        Assert.Throws<ArgumentException>(()=>FlowGraphLayout.Arrange([new FlowGraphLayout.Vertex([7])],0));
    }

    [Fact]
    public void DefaultIfLabelsDescribeThePredicateAndExplicitNamesArePreserved()
    {
        var source=JsonNode.Parse("""{"actions":[{"name":"Decide","inputs":[{"name":"Amount","type":"Integer"}],"steps":[{"if":"Amount > 10","then":[]},{"if":"Amount < 0","as":"RejectNegativeAmount","then":[]},{"while":"Amount > 100","do":[{"break":true}]}]}]}""")!.AsObject();
        var ops=LogicExpander.Expand(source);
        var labels=ops.Where(o=>o["op"]?.ToString()=="set" && o["prop"]?.ToString()=="Label")
            .GroupBy(o=>o["target"]!.ToString()).Select(g=>g.Last()["value"]!.ToString()).ToArray();
        Assert.Contains("Amount > 10",labels);
        Assert.Contains("Amount > 100",labels);
        Assert.Contains("RejectNegativeAmount",labels);
        Assert.DoesNotContain("If1",labels);
    }

    [Fact]
    public void CSharpLabelsKeepSourcePredicateBeforeShortCircuitLowering()
    {
        var compiled=Anvil.CSharp.CSharpCompiler.Compile(new Dictionary<string,string>{["Decision.cs"]="""
            public static class Rules {
                internal static int Decide(int amount, bool approved) {
                    if (approved && amount > 10) return 1;
                    while (amount < 0) amount++;
                    return amount;
                }
            }
            """});
        var ops=LogicExpander.Expand(compiled.Specification["logic"]!.AsObject());
        var labels=ops.Where(o=>o["op"]?.ToString()=="set" && o["prop"]?.ToString()=="Label").Select(o=>o["value"]!.ToString());
        Assert.Contains("approved && amount > 10",labels);
        Assert.Contains("amount < 0",labels);
    }

    [Fact]
    public void NativeVerifyReloadAndSecondLayoutPreserveTheGraph()
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
        var work=Path.Combine(root,".local/flow-layout-tests",Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host=new ModelHost(work); var output=Path.Combine(work,"decisions.oml");
        var result=System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host,null,Path.Combine(root,"tests/jobs/flow-layout-decisions.json"),output))!;
        Assert.True(result["isValid"]!.GetValue<bool>());
        var roundtrip=host.RoundTrip(File.ReadAllBytes(output));
        Assert.True(roundtrip.SameKey && roundtrip.SameObjectCount && roundtrip.SameValidation && roundtrip.Reloaded.IsValid);
        var second=System.Text.Json.JsonSerializer.SerializeToNode(host.RelayoutFromOml(File.ReadAllBytes(output),Path.Combine(work,"again.oml"),null,null))!;
        Assert.True(second["isValid"]!.GetValue<bool>());
        foreach(var action in second["actions"]!.AsArray()) Assert.Equal(0,action!["Moved"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("server", "IServerAction")]
    [InlineData("service", "IServiceAction")]
    public void ServerAndServiceDecisionGraphsKeepTheirDeclaredConnectionsAfterLocalMerge(string kind, string nativeType)
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FlowGraphLayoutTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/server-flow-audit", kind, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work); var basis = Path.Combine(root, "tests/fixtures/blank-service.oml");
        var job = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests/jobs/flow-layout-decisions.json")))!.AsObject();
        var logic = job["ops"]![0]!["data"]!;
        foreach (var action in logic["actions"]!.AsArray())
        {
            action!["kind"] = kind;
            action["access"] = new JsonObject { ["authenticated"] = true };
        }
        var specification = new JsonObject { ["logic"] = logic.DeepClone() };
        job["ops"] = host.PlanModuleSpecification(basis, specification);
        var input = Path.Combine(work, "job.json"); var output = Path.Combine(work, "generated.oml");
        File.WriteAllText(input, job.ToJsonString());
        var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, input, output))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["validation"]!.ToJsonString());
        var proof = host.CheckModuleSpecification(output, specification);
        File.WriteAllText(Path.Combine(work, "before-merge.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        var merge = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(output), merged);
        Assert.True(merge.LocalIsValid); Assert.False(merge.HasConflicts);
        var after = host.CheckModuleSpecification(merged, specification);
        File.WriteAllText(Path.Combine(work, "after-merge.json"), after.ToJsonString());
        Assert.True(after["accepted"]!.GetValue<bool>(), after.ToJsonString());
        var relayout = new JsonArray(logic["actions"]!.AsArray().Select(a => (JsonNode)new JsonObject {
            ["op"] = "layout", ["target"] = nativeType + ":" + a!["name"] }).ToArray());
        var repeatJob = Path.Combine(work, "repeat.json"); File.WriteAllText(repeatJob, new JsonObject { ["ops"] = relayout }.ToJsonString());
        var repeat = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, merged, repeatJob, Path.Combine(work, "repeat.oml")))!;
        Assert.True(repeat["accepted"]!.GetValue<bool>());
        foreach (var item in repeat["results"]!.AsArray()) Assert.Equal(0, item!["result"]!["moved"]!.GetValue<int>());
        File.WriteAllText(Path.Combine(work, "repeat-result.json"), repeat.ToJsonString());
    }
}
