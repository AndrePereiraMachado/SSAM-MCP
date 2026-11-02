using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// F1b stop 4 (owner 2026-11-02: "o ssam deve permitir que o usuario programe junto com ele"): the person works in the same
/// Service Studio while SSAM delivers. When the person's work keeps the Studio's UI thread busy, the bridge withdraws a step
/// before it runs (UI_BUSY, executed:false). The delivery waits briefly and sends the step again, with a note, instead of
/// failing; a step that may have run (it started, outcome unknown) is never sent again.
/// </summary>
[Collection(nameof(F1bStudioBusyTests))]
public sealed class F1bStudioBusyTests
{
    private const string Withdrawn = "the Studio UI thread did not run this step in 30 s (withdrawn from the UI queue; nothing of it ran)";
    private const string Started = "the Studio UI thread did not run this step in 30 s (it started and is still running on the UI thread; outcome unknown)";

    [Fact]
    public void F1bStop4_AStepTheBusyStudioWithdrewWaitsAndGoesAgainWithANote()
    {
        using var _ = Waits("0,0,0");
        var (work, job) = Pa2F1WarningTests.Job();
        // The person is working in the Studio: the capture and the first module read are withdrawn once each.
        var bridge = new BusyStudio { BusyOnce = ["get_active_module", "snapshot_module"] };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(2, bridge.Calls.Count(c => c == "snapshot_module"));
        var waits = result["studioWaits"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(["get_active_module", "snapshot_module"], waits.Select(w => w["method"]!.ToString()));
        Assert.All(waits, w => Assert.Contains("nothing of it ran", w["note"]!.ToString()));
    }

    [Fact]
    public void F1bStop4_AStepThatMayHaveRunIsNeverSentAgain()
    {
        using var _ = Waits("0,0,0");
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new BusyStudio { StartedOnce = ["snapshot_module"] };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(1, bridge.Calls.Count(c => c == "snapshot_module"));
        Assert.Null(result["studioWaits"]);
    }

    [Fact]
    public void F1bStop4_AStudioStillBusyAfterTheWaitsKeepsItsAnswer()
    {
        using var _ = Waits("0,0");
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new BusyStudio { AlwaysBusy = "snapshot_module" };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(3, bridge.Calls.Count(c => c == "snapshot_module"));
        Assert.Equal("not-sent", result["writeState"]!.ToString());
    }

    private static readonly Func<string, string, string, JsonObject> Apply = (_, _, output) =>
    {
        File.WriteAllText(output, "foreign");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true };
    };

    private static IDisposable Waits(string value)
    {
        var before = Environment.GetEnvironmentVariable("ANVIL_STUDIO_BUSY_WAITS_MS");
        Environment.SetEnvironmentVariable("ANVIL_STUDIO_BUSY_WAITS_MS", value);
        return new Restore(() => Environment.SetEnvironmentVariable("ANVIL_STUDIO_BUSY_WAITS_MS", before));
    }
    private sealed class Restore(Action undo) : IDisposable { public void Dispose() => undo(); }

    /// <summary>One Studio with the module Probe (key A) open, whose UI thread is busy with the person's work on given steps.</summary>
    private sealed class BusyStudio : IBridgeClient
    {
        public HashSet<string> BusyOnce = [], StartedOnce = [];
        public string? AlwaysBusy;
        public List<string> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add(method);
            if (AlwaysBusy == method || BusyOnce.Remove(method)) throw new BridgeCallException(method + ": " + method + ": read: " + Withdrawn, executed: false);
            if (StartedOnce.Remove(method)) throw new BridgeCallException(method + ": " + method + ": read: " + Started, executed: null);
            switch (method)
            {
                case "open_module": return new() { ["opened"] = true, ["alreadyOpen"] = true };
                case "get_active_module": return new() { ["name"] = "Probe", ["key"] = "A" };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                    return new() { ["key"] = "A", ["snapshot_id"] = "s1" };
                case "merge_from_oml": return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}

[CollectionDefinition(nameof(F1bStudioBusyTests), DisableParallelization = true)]
public sealed class F1bStudioBusyCollection { }
