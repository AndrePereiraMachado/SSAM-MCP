using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
namespace Anvil.Tests;
public class DeliveryClosureTests
{
    [Theory][InlineData("unknown")][InlineData("intent")]
    public void UnknownWritesCannotBeClosed(string writeState)
    {
        var (work,id,environment)=Create(writeState);var bridge=new Stub(environment);
        Assert.Throws<InvalidOperationException>(()=>DeliveryTask.CloseKnownFailure(work,id,"new revision",bridge));Assert.Equal(0,bridge.Calls);
    }
    [Fact]public void KnownFailureKeepsItsFailureAndSnapshotAndCannotReplay()
    {
        // The authority stays private to the test run and is never restored to an absent value: a parallel test that reserves a
        // module meanwhile would otherwise write into the user's authority folder.
        var (work,id,environment)=Create("applied");
        if(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ANVIL_AUTHORITY_DIR"))) Environment.SetEnvironmentVariable("ANVIL_AUTHORITY_DIR",Path.Combine(Path.GetDirectoryName(work)!,"authority"));
        var bridge=new Stub(environment);var closed=DeliveryTask.CloseKnownFailure(work,id,"compiler correction",bridge);
        Assert.True(closed["closed"]!.GetValue<bool>());Assert.False(closed["delivered"]!.GetValue<bool>());Assert.Equal("contract mismatch",closed["error"]!.ToString());Assert.True(File.Exists(Path.Combine(work,"deliver",id,"closed-state.oml")));
        var calls=bridge.Calls;Assert.Throws<InvalidOperationException>(()=>Delivery.Run(bridge,DeliveryTask.ResumeRequest(work,id),(_,_,_)=>throw new Exception("must not apply")));Assert.Equal(calls,bridge.Calls);
    }
    private static (string,string,string) Create(string status)
    {
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryClosureTests).Assembly.Location)!)!;var work=Path.Combine(root,".local/closure-tests",Guid.NewGuid().ToString("N"));var environment="fixture-"+Guid.NewGuid().ToString("N");Directory.CreateDirectory(work);
        using var task=new DeliveryTask(new DeliveryRequest("Probe",Path.Combine(work,"source.html"),work,[]));task.State["writeState"]=status;task.State["moduleKey"]="module";task.State["environment"]=environment;task.State["error"]="contract mismatch";task.Save("rejected");return(work,task.Id,environment);
    }
    private sealed class Stub(string environment):IBridgeClient
    {
        public int Calls;
        public JsonObject Call(string method,JsonObject? parameters=null){Calls++;if(method=="get_active_module")return new(){["key"]="module",["environment"]=environment};
            // A17: the close opens or selects the task's own module by key.
            if(method=="open_module"){Assert.Equal("module",parameters!["module_key"]!.ToString());Assert.Equal(environment,parameters["environment"]!.ToString());return new(){["opened"]=true,["alreadyOpen"]=true};}
            if(method=="snapshot_module"){File.WriteAllText(parameters!["path"]!.ToString(),"known snapshot");return new(){["snapshot_id"]="closed-snapshot"};}throw new Exception("Unexpected bridge operation "+method);}
    }
}
