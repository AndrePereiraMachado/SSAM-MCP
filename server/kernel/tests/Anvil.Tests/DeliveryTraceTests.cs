using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;
namespace Anvil.Tests;

/// <summary>F7 (traceability per session): a kernel delivery task records the session (correlationId) and the call
/// (operationId) it runs for, from the --correlation-id/--call-id the facade's kernel runner adds; a resume from another
/// session keeps the task (the trace is never part of the request binding) and adds its run; an id that is not a UUID is
/// never written.</summary>
public class DeliveryTraceTests
{
    private static string Work()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(DeliveryTraceTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/trace-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return work;
    }
    private static readonly string SessionA = "11111111-1111-4111-8111-111111111111", CallA = "22222222-2222-4222-8222-222222222222";
    private static readonly string SessionB = "33333333-3333-4333-8333-333333333333", CallB = "44444444-4444-4444-8444-444444444444";

    [Fact]
    public void TheCreatingCallNamesTheTaskAndEveryRunIsRecorded()
    {
        var work = Work();
        var trace = DeliveryTrace.FromArgs(["deliver", "--module", "M", "--correlation-id", SessionA, "--call-id", CallA]);
        Assert.NotNull(trace);
        string id;
        using (var task = new DeliveryTask(new DeliveryRequest("Probe", Path.Combine(work, "job.json"), work, [], Trace: trace))) id = task.Id;
        var state = DurableJson.Read(Path.Combine(work, "deliver", id, "task.json"));
        Assert.Equal(SessionA, state["correlationId"]!.ToString());
        Assert.Equal(CallA, state["trace"]!["operationId"]!.ToString());
        Assert.Single(state["traces"]!.AsArray());
        // The trace is a property of the call: the request binding is unchanged, so another session resumes the same task.
        Assert.Null(state["request"]!["Trace"]);
        var resume = DeliveryTask.ResumeRequest(work, id) with { Trace = new DeliveryTrace(SessionB, CallB) };
        using (var again = new DeliveryTask(resume)) again.Save("resumed");
        state = DurableJson.Read(Path.Combine(work, "deliver", id, "task.json"));
        Assert.Equal(SessionA, state["correlationId"]!.ToString());
        Assert.Equal(CallA, state["trace"]!["operationId"]!.ToString());
        var runs = state["traces"]!.AsArray();
        Assert.Equal(2, runs.Count);
        Assert.Equal(SessionB, runs[1]!["correlationId"]!.ToString());
        Assert.Equal("resume", runs[1]!["run"]!.ToString());
        // The human-readable projection (result.json) carries the same fields.
        var result = JsonNode.Parse(File.ReadAllText(Path.Combine(work, "deliver", id, "result.json")))!;
        Assert.Equal(SessionA, result["correlationId"]!.ToString());
    }

    [Fact]
    public void AnIdThatIsNotAUuidIsNeverWrittenAndAbsentTraceKeepsTheOldShape()
    {
        Assert.Null(DeliveryTrace.FromArgs(["deliver", "--correlation-id", "not-a-session"]));
        Assert.Null(DeliveryTrace.FromArgs(["deliver", "--module", "M"]));
        Assert.Null(DeliveryTrace.FromArgs(["deliver", "--correlation-id"]));
        var withoutCall = DeliveryTrace.FromArgs(["deliver", "--correlation-id", SessionA, "--call-id", "x"]);
        Assert.Equal(SessionA, withoutCall!.CorrelationId);
        Assert.Null(withoutCall.OperationId);
        var work = Work();
        string id;
        using (var task = new DeliveryTask(new DeliveryRequest("Probe", Path.Combine(work, "job.json"), work, []))) id = task.Id;
        var state = DurableJson.Read(Path.Combine(work, "deliver", id, "task.json"));
        Assert.Null(state["correlationId"]);
        Assert.Null(state["traces"]);
    }

    [Fact]
    public void TheSameRunOfTheSameCallIsRecordedOnceAndTheListIsBounded()
    {
        var state = new JsonObject();
        var trace = new DeliveryTrace(SessionA, CallA);
        DeliveryTask.RecordTrace(state, trace, "create");
        DeliveryTask.RecordTrace(state, trace, "create");
        Assert.Single(state["traces"]!.AsArray());
        for (var i = 0; i < 30; i++) DeliveryTask.RecordTrace(state, new DeliveryTrace(SessionB, Guid.NewGuid().ToString("D")), "resume");
        Assert.Equal(20, state["traces"]!.AsArray().Count);
        Assert.Equal(SessionA, state["correlationId"]!.ToString());
    }
}
