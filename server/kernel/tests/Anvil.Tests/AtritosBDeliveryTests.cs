using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane B of the 2026-10-06 frictions (Astra item 1): every refused or failed delivery task records the job it
/// checked, path and SHA-256, so the correction patch + basedOn {taskId} reads the hash in one call. A refused preflight
/// still drops the sources (the same task re-validates on resume) and keeps the job record.</summary>
public sealed class AtritosBDeliveryTests
{
    private const string RefusedJob = """
    {"ops":[
      {"op":"create","parent":"@espace","type":"IStaticEntity","name":"State","as":"$State"},
      {"op":"create","parent":"$State","type":"IEntityAttribute","name":"Id","as":"$Id"},
      {"op":"set","target":"$Id","prop":"DataType","value":"Integer"},
      {"op":"set","target":"$Id","prop":"IsAutoNumber","value":"No"},
      {"op":"set","target":"$State","prop":"IdentifierAttribute","value":"$Id"},
      {"op":"create","parent":"$State","type":"IRecord","name":"Open","as":"$Open"}]}
    """;

    [Fact]
    public void ARefusedPreflightRecordsTheJobPathAndHashInTheTask()
    {
        var (work, job) = Job(RefusedJob);
        var bridge = new Bridge();
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.Equal(Delivery.PreflightRefused, result["code"]!.ToString());
        Assert.Empty(bridge.Calls);
        // The checkpoint the facade reads (work/deliver/<taskId>/task.json): no sources, the job record with its hash.
        var state = DurableJson.Read(Path.Combine(work, "deliver", result["taskId"]!.ToString(), "task.json"));
        Assert.Null(state["sources"]);
        Assert.Equal(Path.GetFullPath(job), state["job"]!["path"]!.ToString());
        Assert.Equal(DeliveryReceipt.Hash(job), state["job"]!["sha256"]!.ToString());
        Assert.Equal(state["job"]!.ToJsonString(), result["job"]!.ToJsonString());
    }

    [Fact]
    public void AResumeAfterTheJobWasCorrectedInPlaceRecordsTheNewHash()
    {
        var (work, job) = Job(RefusedJob);
        var refused = Delivery.Run(new Bridge(), new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        var id = refused["taskId"]!.ToString();
        var before = refused["job"]!["sha256"]!.ToString();
        File.WriteAllText(job, "{\"ops\":[]}");
        var resumed = Delivery.Run(new Bridge { BlockOpen = true }, DeliveryTask.ResumeRequest(work, id), (_, _, _) => throw new Exception("must not apply"));
        Assert.NotEqual(before, resumed["job"]!["sha256"]!.ToString());
        Assert.Equal(DeliveryReceipt.Hash(job), resumed["job"]!["sha256"]!.ToString());
        Assert.NotNull(resumed["sources"]);
    }

    [Fact]
    public void AFailureAfterThePreflightKeepsTheJobRecordToo()
    {
        // open_module is blocked: the task fails before any write, and its record names the job with the same hash as its sources.
        var (work, job) = Job("{\"ops\":[]}");
        var result = Delivery.Run(new Bridge { BlockOpen = true }, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("open_module is blocked", result["error"]!.ToString());
        var state = DurableJson.Read(Path.Combine(work, "deliver", result["taskId"]!.ToString(), "task.json"));
        Assert.Equal(DeliveryReceipt.Hash(job), state["job"]!["sha256"]!.ToString());
        Assert.Equal(state["job"]!["sha256"]!.ToString(), state["sources"]![0]!["sha256"]!.ToString());
    }

    private static (string Work, string Job) Job(string text)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(AtritosBDeliveryTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "atritos-b-delivery-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, text);
        return (work, job);
    }

    private sealed class Bridge : IBridgeClient
    {
        public bool BlockOpen;
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            return method switch
            {
                "open_module" => BlockOpen ? new() { ["opened"] = false, ["hint"] = "a dialog is open" } : new() { ["opened"] = true },
                _ => throw new Exception("Unexpected call: " + method),
            };
        }
    }
}
