using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane F1 of the atritos 2 package (docs/PACOTE-ATRITOS-2.md), A08, kernel part: two sessions writing to two modules of the
/// same Studio (the Cardapio UI and BackOffice agents, 2026-10-06) select each other's tab. The delivery selects its own
/// module again (open_module by the task's key) before the snapshot and before the verification, instead of failing with
/// "active module changed"; it fails only when the module cannot be selected.
/// </summary>
public sealed class Pa2F1ReselectTests
{
    [Fact]
    public void AnotherTabSelectedBeforeTheSnapshotIsSelectedAgain()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new SharedStudio { StealFirstActive = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(2, bridge.Calls.Count(c => c.Method == "open_module"));
        Assert.Equal("Other", result["reselected"]![0]!["from"]!.ToString());
        Assert.Equal("active-module", result["reselected"]![0]!["stage"]!.ToString());
    }

    [Fact]
    public void AnotherTabSelectedAfterTheMergeIsSelectedByKeyBeforeTheVerification()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new SharedStudio { SwitchAfterMerge = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        var reopen = bridge.Calls.Last(c => c.Method == "open_module").Parameters!;
        Assert.Equal("A", reopen["module_key"]!.ToString());
        var order = bridge.Calls.Select(c => c.Method).ToList();
        Assert.True(order.LastIndexOf("open_module") < order.IndexOf("get_errors"), string.Join(",", order));
        Assert.Equal("verify", result["reselected"]![0]!["stage"]!.ToString());
    }

    [Fact]
    public void AModuleThatCannotBeSelectedAgainStillStopsBeforeTheSnapshot()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new SharedStudio { Active = "Other", Sticky = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("could not be selected again", result["error"]!.ToString());
        Assert.DoesNotContain(bridge.Calls, c => c.Method == "snapshot_module");
    }

    [Fact]
    public void AModuleOpenInASecondWindowIsDeliveredByKey()
    {
        // 2026-10-07 (DCIPS): with about ten tabs the Studio moves some into a second window. open_module selects the tab in
        // its own window, but the bridge's active module is the selected tab of the first window, so every delivery to a
        // module of the second window failed with "active module changed before snapshot". A bridge whose calls target
        // module_key finds the tab in list_open_modules and the delivery goes on by key.
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new SharedStudio { Active = "Other", Sticky = true, SecondWindow = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Probe", job, work, []), Apply);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal("A", bridge.Calls.Single(c => c.Method == "snapshot_module").Parameters!["module_key"]!.ToString());
        Assert.Equal("A", bridge.Calls.Single(c => c.Method == "get_errors").Parameters!["module_key"]!.ToString());
        Assert.True(result["reselected"]![0]!["byKey"]!.GetValue<bool>());
        Assert.Equal("Other", result["reselected"]![0]!["from"]!.ToString());
    }

    [Fact]
    public void ASecondWindowTabIsNotTakenWithoutABridgeThatTargetsKeysNorWhenTwoTabsShareTheName()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var old = new SharedStudio { Active = "Other", Sticky = true, SecondWindow = true, ModuleKeyCapability = false };
        Assert.False(Delivery.Run(old, new DeliveryRequest("Probe", job, work, []), (_, _, _) => throw new Exception("must not apply"))["delivered"]!.GetValue<bool>());
        Assert.DoesNotContain(old.Calls, c => c.Method == "snapshot_module");
        var (work2, job2) = Pa2F1WarningTests.Job();
        var twins = new SharedStudio { Active = "Other", Sticky = true, SecondWindow = true, TwinTabs = true };
        Assert.False(Delivery.Run(twins, new DeliveryRequest("Probe", job2, work2, []), (_, _, _) => throw new Exception("must not apply"))["delivered"]!.GetValue<bool>());
        Assert.DoesNotContain(twins.Calls, c => c.Method == "snapshot_module");
    }

    private static readonly Func<string, string, string, JsonObject> Apply = (_, _, output) =>
    {
        File.WriteAllText(output, "foreign");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true };
    };

    /// <summary>One Studio with two open modules: Probe (key A) and Other (key B). open_module selects Probe unless Sticky.</summary>
    private sealed class SharedStudio : IBridgeClient
    {
        public string Active = "Probe";
        public bool SwitchAfterMerge, Sticky, StealFirstActive, SecondWindow, TwinTabs, ModuleKeyCapability = true;
        public List<(string Method, JsonObject? Parameters)> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add((method, parameters?.DeepClone().AsObject()));
            switch (method)
            {
                case "bridge_manifest" when SecondWindow:
                    return new() { ["capabilities"] = ModuleKeyCapability ? new JsonArray("merge_from_oml:module_key") : new JsonArray() };
                case "list_open_modules" when SecondWindow:
                    var modules = new JsonArray(
                        new JsonObject { ["name"] = "Other", ["key"] = "B", ["hasOpenedActiveESpace"] = true },
                        new JsonObject { ["name"] = "Probe", ["key"] = "A", ["hasOpenedActiveESpace"] = true });
                    if (TwinTabs) modules.Add(new JsonObject { ["name"] = "Probe", ["key"] = "C", ["hasOpenedActiveESpace"] = true });
                    return new() { ["count"] = modules.Count, ["modules"] = modules };
                case "open_module":
                    if (!Sticky) Active = "Probe";
                    return new() { ["opened"] = true, ["alreadyOpen"] = true };
                case "get_active_module":
                    // Another session selects its own tab right after this one opened Probe.
                    if (StealFirstActive) { StealFirstActive = false; Active = "Other"; }
                    return new() { ["name"] = Active, ["key"] = Active == "Probe" ? "A" : "B" };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                    return new() { ["key"] = "A", ["snapshot_id"] = "s1" };
                case "merge_from_oml":
                    if (SwitchAfterMerge) Active = "Other";
                    return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
