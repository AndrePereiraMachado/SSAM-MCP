using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane D1, C28: the verify of a merged O11 module. An empty TrueChange after a base with messages is
/// VERIFY_UNAVAILABLE (never "0 errors"); the live contract follows the apply's verdicts when they exist; the get_errors call
/// asks the bridge to settle; a refused preflight answers PREFLIGHT_REFUSED with every problem before any Studio call.</summary>
public sealed class PacoteD1VerifyTests
{
    private static readonly JsonArray Baseline = new(
        new JsonObject { ["id"] = "W1", ["type"] = "Warning", ["key"] = "k1", ["path"] = "Screen1", ["detail"] = "unused" },
        new JsonObject { ["id"] = "W2", ["type"] = "Warning", ["key"] = "k2", ["path"] = "Screen2", ["detail"] = "unused" });

    [Fact]
    public void EmptyListWithAFullBaselineIsVerifyUnavailable()
    {
        var (work, job) = Job();
        var bridge = new Bridge { Baseline = Baseline, Current = new JsonArray() };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply());
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(Delivery.VerifyUnavailableCode, result["code"]!.ToString());
        Assert.Contains("VERIFY_UNAVAILABLE", result["error"]!.ToString());
        Assert.Contains("merge kept for review", result["error"]!.ToString());
        Assert.Equal("applied", result["writeState"]!.ToString());
        Assert.True(bridge.Settle);
    }

    [Fact]
    public void ASettledEmptyListAfterTheBridgeWaitedIsTrusted()
    {
        var (work, job) = Job();
        var bridge = new Bridge { Baseline = Baseline, Current = new JsonArray(), Settled = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply());
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Null(LiveContract.VerifyUnavailable(new JsonArray(), new JsonObject { ["rawMessages"] = new JsonArray() }));
        Assert.Null(LiveContract.VerifyUnavailable(Baseline, new JsonObject { ["new"] = new JsonArray() }));   // an older answer without rawMessages
    }

    [Fact]
    public void TheLiveContractFollowsTheVerdictsOfTheApply()
    {
        var verdicts = new JsonArray(new JsonObject { ["id"] = "W3", ["type"] = "Warning", ["path"] = "Screen3", ["verdict"] = "allowlisted", ["reason"] = "unused-created-by-job" });
        var current = Baseline.DeepClone().AsArray();
        current.Add(new JsonObject { ["id"] = "W3", ["type"] = "Warning", ["key"] = "k3", ["path"] = "Screen3", ["detail"] = "unused" });

        // Foreseen and accepted by the apply: delivered, although expectedMessages does not list it.
        var (work, job) = Job();
        var accepted = Delivery.Run(new Bridge { Baseline = Baseline, Current = current }, new DeliveryRequest("Probe", job, work, []), Apply(verdicts));
        Assert.True(accepted["delivered"]!.GetValue<bool>(), accepted.ToJsonString());
        Assert.Equal("verdicts", accepted["contract"]!["source"]!.ToString());

        // A live warning the apply did not foresee blocks nothing since A03 (atritos 2): delivered, with the warning.
        var surprise = current.DeepClone().AsArray();
        surprise.Add(new JsonObject { ["id"] = "W4", ["type"] = "Warning", ["key"] = "k4", ["path"] = "Screen4", ["detail"] = "new" });
        var (work2, job2) = Job();
        var warned = Delivery.Run(new Bridge { Baseline = Baseline, Current = surprise }, new DeliveryRequest("Probe", job2, work2, []), Apply(verdicts));
        Assert.True(warned["delivered"]!.GetValue<bool>(), warned.ToJsonString());
        Assert.Contains(warned["contract"]!["matched"]!.AsArray(), e => e!["id"]!.ToString() == "W4" && e["verdict"]!.ToString() == "nonblocking");
        Assert.Equal("W4", Assert.Single(warned["warnings"]!.AsArray())!["id"]!.ToString());

        // A live security warning the apply did not foresee is unexpected.
        var security = current.DeepClone().AsArray();
        security.Add(new JsonObject { ["id"] = "SQLInjection", ["type"] = "Warning", ["key"] = "k5", ["path"] = "Screen5", ["detail"] = "injection" });
        var (work3, job3) = Job();
        var refused = Delivery.Run(new Bridge { Baseline = Baseline, Current = security }, new DeliveryRequest("Probe", job3, work3, []), Apply(verdicts));
        Assert.False(refused["delivered"]!.GetValue<bool>());
        Assert.False(refused["contract"]!["accepted"]!.GetValue<bool>());
        Assert.Equal("SQLInjection", refused["contract"]!["unexpected"]![0]!["id"]!.ToString());
        Assert.Equal("security:SQLInjection", refused["contract"]!["unexpected"]![0]!["reason"]!.ToString());

        // A verdict "unexpected" never accepts its message.
        var live = LiveContract.Evaluate([new MessageInfo("W3", "Warning", "k3", "Screen3", "unused")],
            new JsonArray(new JsonObject { ["id"] = "W3", ["path"] = "Screen3", ["verdict"] = "unexpected" }));
        Assert.False(live["accepted"]!.GetValue<bool>());
    }

    [Fact]
    public void ARefusedPreflightAnswersEveryProblemBeforeAnyStudioCall()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PacoteD1VerifyTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "pacote-d1-verify-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, """
        {"ops":[
          {"op":"create","parent":"@espace","type":"IStaticEntity","name":"State","as":"$State"},
          {"op":"create","parent":"$State","type":"IEntityAttribute","name":"Id","as":"$Id"},
          {"op":"set","target":"$Id","prop":"DataType","value":"Integer"},
          {"op":"set","target":"$Id","prop":"IsAutoNumber","value":"No"},
          {"op":"set","target":"$State","prop":"IdentifierAttribute","value":"$Id"},
          {"op":"create","parent":"$State","type":"IRecord","name":"Open","as":"$Open"}]}
        """);
        var bridge = new Bridge();
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.Equal(Delivery.PreflightRefused, result["code"]!.ToString());
        Assert.False(result["preflight"]!["valid"]!.GetValue<bool>());
        var problems = result["problems"]!.AsArray();
        Assert.NotEmpty(problems);
        Assert.All(problems, p => { Assert.Equal("error", p!["severity"]!.ToString()); Assert.False(string.IsNullOrEmpty(p["code"]?.ToString())); });
        Assert.Contains("has no Id", result["error"]!.ToString());
        Assert.Empty(bridge.Calls);
        // The preflight's own structured problems (contract I2) pass through unchanged.
        var own = new JsonArray(new JsonObject { ["op"] = 2, ["code"] = "X_CODE", ["severity"] = "error", ["message"] = "m", ["fix"] = "f" });
        Assert.Equal("X_CODE", Delivery.PreflightProblems(new JsonObject { ["problems"] = own, ["errors"] = new JsonArray("x") })[0]!["code"]!.ToString());
    }

    [Fact]
    public void ACodedRefusalRaisedByTheApplyKeepsItsCodeAndProblems()
    {
        // The kernel's base check (lane B) refuses inside the apply, before the first op: the task result keeps
        // PREFLIGHT_REFUSED and every problem, as the CLI envelope does, and nothing is merged (integration of D1 and B).
        var (work, job) = Job();
        var bridge = new Bridge();
        var problem = JobPreflight.Problem(0, "/ops/0/target", "REFERENCE_UNRESOLVED", "error", "IServerAction:X does not resolve", "use one of: IServerAction:Y");
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw JobPreflightException.Of([problem]));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(JobPreflightException.PreflightRefused, result["code"]!.ToString());
        Assert.Equal("REFERENCE_UNRESOLVED", result["problems"]![0]!["code"]!.ToString());
        Assert.DoesNotContain("merge_from_oml", bridge.Calls);
    }

    // ---- helpers
    private static Func<string, string, string, JsonObject> Apply(JsonArray? verdicts = null) => (_, _, output) =>
    {
        File.WriteAllText(output, "foreign");
        var applied = new JsonObject { ["isValid"] = true, ["accepted"] = true };
        if (verdicts != null) applied["validation"] = new JsonObject { ["verdicts"] = verdicts.DeepClone() };
        return applied;
    };

    private static (string Work, string Job) Job()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(PacoteD1VerifyTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "pacote-d1-verify-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, "{\"ops\":[]}");
        return (work, job);
    }

    private sealed class Bridge : IBridgeClient
    {
        public JsonArray? Baseline, Current;
        public bool Settled, Settle;
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                    var shot = new JsonObject { ["key"] = "A", ["snapshot_id"] = "base-id" };
                    if (Baseline != null) shot["baseline"] = Baseline.DeepClone();
                    return shot;
                case "merge_from_oml": return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors":
                    Settle = parameters?["settle"]?.GetValue<bool>() == true;
                    return new() { ["rawMessages"] = (Current ?? new JsonArray()).DeepClone(), ["settled"] = Settled, ["generation"] = Settled ? 1 : 0,
                        ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
