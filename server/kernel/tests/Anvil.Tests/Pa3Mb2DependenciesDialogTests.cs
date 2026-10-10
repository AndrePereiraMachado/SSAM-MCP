using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Package 3, lane mb2 (owner rule 2026-10-07): the Service Studio dialog "Incompatible or missing dependencies found" never
/// stops a call. The bridge closes only that dialog as Cancel (DialogScope, linked from the O11 bridge, with a fake dialog
/// list); the kernel delivery then refreshes every producer of the module by its key and goes on, and its receipt lists
/// referencesRefreshed. A bridge without dialogs:dependencies_auto ignores the request: the delivery stops as before.
/// </summary>
public sealed class Pa3Mb2DependenciesDialogTests
{
    private const string DependenciesText = "Incompatible or missing dependencies found\nSome producers changed.\nManage Dependencies\nCancel";

    [Fact]
    public void OnlyTheDependenciesDialogIsClosed()
    {
        var dialogs = new List<(string? Type, string? Title, string? Text)>
        {
            ("DialogWindow", "", DependenciesText),                                         // the web text names it
            ("DialogWindow", "Recover module", "Open | Discard"),                          // the recovery dialog: the person's
            ("DialogWindow", "Incompatible or missing dependencies found", null),          // the title names it, text unread
            ("Window", "Incompatible or missing dependencies found", DependenciesText),   // not a DialogWindow: never
            ("DialogWindow", "Sign in", "Manage Dependencies Cancel"),                     // other buttons alike: not by its text
        };
        Assert.Equal(new[] { 0, 2 }, DialogScope.DependenciesToClose(dialogs));
        // dismiss_dialog of the release closes it by its exact title only.
        Assert.Equal(new[] { 2 }, DialogScope.DependenciesToClose(dialogs, "incompatible or missing dependencies found"));
        Assert.Empty(DialogScope.DependenciesToClose(dialogs, "Recover module"));
        var answered = DialogScope.Answered("", DependenciesText);
        Assert.Equal("Cancel", answered["answer"]!.ToString());
        Assert.Null(answered["title"]);
        Assert.StartsWith("Incompatible or missing dependencies found Some producers", answered["text"]!.ToString());
    }

    [Fact]
    public void OnlyAWebWindowIsWorthReadingAndACancelledPublicationReachedNothing()
    {
        Assert.False(DialogScope.MayBeDependencies(null));
        Assert.False(DialogScope.MayBeDependencies(new JsonArray(new JsonObject { ["kind"] = DialogPolicy.ManageDependencies, ["source"] = "presenter" })));
        Assert.True(DialogScope.MayBeDependencies(new JsonArray(new JsonObject { ["kind"] = DialogPolicy.WebDialog, ["source"] = "window", ["contentKind"] = "web" })));
        // A process seen is followed; a command that ended with no process for the settle time was cancelled by the Cancel.
        Assert.Equal("follow", DialogScope.AfterDependenciesAnswer(true, true, TimeSpan.FromSeconds(10)));
        Assert.Equal("wait", DialogScope.AfterDependenciesAnswer(true, false, TimeSpan.FromSeconds(1)));
        Assert.Equal("wait", DialogScope.AfterDependenciesAnswer(false, false, TimeSpan.FromSeconds(10)));
        Assert.Equal("not-started", DialogScope.AfterDependenciesAnswer(true, false, DialogScope.DependenciesSettle));
        var cancelled = DialogScope.PublishCancelledByDependencies("Consumer", new JsonArray(DialogScope.Answered("Incompatible or missing dependencies found", null)), new JsonArray(), 4000);
        Assert.False(cancelled["published"]!.GetValue<bool>());
        Assert.Equal(DialogScope.Code, cancelled["code"]!.ToString());
        Assert.Equal("not-started", cancelled["outcome"]!.ToString());
        Assert.Equal(DialogPolicy.ManageDependencies, cancelled["blockedBy"]![0]!["kind"]!.ToString());
        Assert.Equal("refresh_references", cancelled["dependenciesDialog"]!["next"]!.ToString());
    }

    [Fact]
    public void TheDeliveryAnswersTheDialogRefreshesEveryProducerByKeyAndDelivers()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new DependenciesStudio { Capable = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Consumer", job, work, []), Apply);
        Assert.True(result["delivered"]!.GetValue<bool>(), result.ToJsonString());
        Assert.True(bridge.Calls.First(c => c.Method == "open_module").Parameters!["answer_dependencies"]!.GetValue<bool>());
        var refresh = Assert.Single(bridge.Calls, c => c.Method == "refresh_references").Parameters!;
        Assert.Equal("kc", refresh["module_key"]!.ToString());
        Assert.Null(refresh["producers"]);                                       // every producer of the module
        var order = bridge.Calls.Select(c => c.Method).ToList();
        Assert.True(order.IndexOf("refresh_references") < order.IndexOf("snapshot_module"), string.Join(",", order));
        var entry = Assert.Single(result["referencesRefreshed"]!.AsArray())!;
        Assert.Equal("open", entry["stage"]!.ToString());
        Assert.Equal("Consumer", entry["module"]!.ToString());
        Assert.Equal("Cancel", entry["dialog"]![0]!["answer"]!.ToString());
        Assert.Equal("Producer", entry["refreshed"]![0]!.ToString());
        // The receipt on disk keeps it.
        var saved = JsonNode.Parse(File.ReadAllText(Path.Combine(result["work"]!.ToString(), "result.json")))!;
        Assert.Single(saved["referencesRefreshed"]!.AsArray());
    }

    [Fact]
    public void WithoutTheCapabilityTheDeliveryStopsAtTheDialogAsBefore()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new DependenciesStudio { Capable = false };
        var result = Delivery.Run(bridge, new DeliveryRequest("Consumer", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Contains("open_module is blocked", result["error"]!.ToString());
        Assert.DoesNotContain(bridge.Calls, c => c.Method is "refresh_references" or "snapshot_module");
        Assert.Null(result["referencesRefreshed"]);
    }

    [Fact]
    public void ARefreshThatFailsNamesItsCodeTheModuleAndTheNextCall()
    {
        var (work, job) = Pa2F1WarningTests.Job();
        var bridge = new DependenciesStudio { Capable = true, RefreshFails = true };
        var result = Delivery.Run(bridge, new DeliveryRequest("Consumer", job, work, []), (_, _, _) => throw new Exception("must not apply"));
        Assert.False(result["delivered"]!.GetValue<bool>());
        Assert.Equal(Delivery.ReferencesRefreshFailedCode, result["code"]!.ToString());
        Assert.Contains("Consumer", result["error"]!.ToString());
        Assert.Contains("refresh-references", result["error"]!.ToString());
        var failed = result["referencesRefreshFailed"]!;
        Assert.Equal("Consumer", failed["module"]!.ToString());
        Assert.Equal("refresh-references", failed["next"]!["arguments"]!["command"]!.ToString());
        Assert.DoesNotContain(bridge.Calls, c => c.Method == "snapshot_module");
    }

    private static readonly Func<string, string, string, JsonObject> Apply = (_, _, output) =>
    {
        File.WriteAllText(output, "foreign");
        return new JsonObject { ["isValid"] = true, ["accepted"] = true };
    };

    /// <summary>A Studio whose open of Consumer shows the dependencies dialog. Capable: the bridge offers
    /// dialogs:dependencies_auto and, asked with answer_dependencies, answers it (Cancel) and opens; otherwise the open stops
    /// at the dialog with blockedBy, as an older bridge does.</summary>
    private sealed class DependenciesStudio : IBridgeClient
    {
        public bool Capable, RefreshFails;
        public List<(string Method, JsonObject? Parameters)> Calls { get; } = [];
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Calls.Add((method, parameters?.DeepClone().AsObject()));
            switch (method)
            {
                case "bridge_manifest":
                    return new() { ["capabilities"] = Capable ? new JsonArray(Delivery.DependenciesAutoCapability, "refresh_references") : new JsonArray() };
                case "open_module":
                    if (Capable && parameters?["answer_dependencies"]?.GetValue<bool>() == true)
                        return new() { ["opened"] = true, ["alreadyOpen"] = false, ["referencesOutdated"] = true, ["key"] = "kc",
                            ["dependenciesDialog"] = new JsonObject { ["answered"] = new JsonArray(new JsonObject { ["kind"] = "DependenciesDialog",
                                ["title"] = "Incompatible or missing dependencies found", ["answer"] = "Cancel" }), ["next"] = "refresh_references" } };
                    return new() { ["opened"] = false, ["hint"] = "the references dialog is open",
                        ["blockedBy"] = new JsonArray(new JsonObject { ["kind"] = DialogPolicy.WebDialog, ["source"] = "window", ["contentKind"] = "web" }) };
                case "get_active_module": return new() { ["name"] = "Consumer", ["key"] = "kc" };
                case "refresh_references":
                    if (RefreshFails) throw new BridgeCallException("refresh_references: 'Consumer' did not end within 600 s; its outcome is unknown", true);
                    return new() { ["module"] = "Consumer", ["moduleKey"] = "kc", ["changed"] = true, ["refreshed"] = new JsonArray("Producer"), ["upToDate"] = new JsonArray("Other") };
                case "snapshot_module":
                    File.WriteAllText(parameters!["path"]!.ToString(), "snapshot");
                    return new() { ["key"] = "kc", ["snapshot_id"] = "s1" };
                case "merge_from_oml": return new() { ["merged"] = true, ["newErrors"] = 0 };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray() };
                default: throw new Exception("Unexpected call: " + method);
            }
        }
    }
}
