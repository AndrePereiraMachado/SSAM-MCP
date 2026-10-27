using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T12 (Traditional migration, calls 588-601): the Roles of 21 source screens were changed for a comparison and the restore
/// was tracked by hand. The kernel records every change of who may open an existing screen with its exact before-state
/// (accessChanges) and the ops that put it back (accessRestore); applying those ops restores it. A screen the job creates,
/// and a write that leaves the value as it was, have nothing to restore.
/// </summary>
public sealed class AccessChangeCaptureTests
{
    private static JsonObject Run(string work, string baseOml, string name, string job, string outOml)
    {
        var path = Path.Combine(work, name + ".json"); File.WriteAllText(path, job);
        using var policy = JobPreflight.UseAutoPatch(false);
        return System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), baseOml, path, outOml))!.AsObject();
    }

    [Fact]
    public void AnAccessChangeOfAnExistingScreenIsRecordedWithItsBeforeStateAndItsRestoreRestoresIt()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var kernel = JobSources.KernelRoot()!;
        var work = Path.Combine(kernel, ".local", "t12-access-capture", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var created = Path.Combine(work, "created.oml");
        var first = Run(work, Path.Combine(kernel, "tests", "fixtures", "reactive-ui.oml"), "create",
            """{"ops":[{"op":"html","data":{"html":"<screen name=\"AccessProbe\" roles=\"Registered\"><p>probe</p></screen>"}}]}""", created);
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        // A screen the job created has no before-state.
        Assert.Null(first["accessChanges"]);

        var widened = Path.Combine(work, "widened.oml");
        var change = Run(work, created, "widen",
            """{"ops":[{"op":"set","target":"IMobileScreen:AccessProbe","prop":"Roles","value":["IRole:Anonymous","IRole:Registered"]}]}""", widened);
        Assert.True(change["accepted"]!.GetValue<bool>(), change.ToJsonString());
        var entry = Assert.IsType<JsonObject>(Assert.Single(change["accessChanges"]!.AsArray()));
        Assert.Equal(("AccessProbe", "Roles"), (entry["screen"]!.ToString(), entry["property"]!.ToString()));
        Assert.Equal(new[] { "Registered" }, entry["fromNames"]!.AsArray().Select(n => n!.ToString()));
        Assert.Equal(new[] { "Anonymous", "Registered" }, entry["toNames"]!.AsArray().Select(n => n!.ToString()).Order(StringComparer.Ordinal));
        var restore = Assert.IsType<JsonObject>(Assert.Single(change["accessRestore"]!["ops"]!.AsArray()));
        Assert.Equal(("set", "@" + entry["key"], "Roles"), (restore["op"]!.ToString(), restore["target"]!.ToString(), restore["prop"]!.ToString()));
        Assert.True(JsonNode.DeepEquals(entry["from"], restore["value"]));

        // The inverse job puts the screen back as it was: its own receipt shows the change back to the before-state.
        var restored = Path.Combine(work, "restored.oml");
        Assert.True(JsonNode.DeepEquals(entry["to"], restore["ifCurrent"]), "the restore applies only while the screen has the value this job wrote");
        var back = Run(work, widened, "restore", new JsonObject { ["ops"] = change["accessRestore"]!["ops"]!.DeepClone() }.ToJsonString(), restored);
        Assert.True(back["accepted"]!.GetValue<bool>(), back.ToJsonString());
        var undone = Assert.IsType<JsonObject>(Assert.Single(back["accessChanges"]!.AsArray()));
        Assert.True(JsonNode.DeepEquals(entry["from"], undone["to"]));

        // Writing the value the screen already has changes nothing: nothing to restore.
        var plain = new JsonArray(change["accessRestore"]!["ops"]!.AsArray().Select(o => { var c = o!.DeepClone().AsObject(); c.Remove("ifCurrent"); return (JsonNode)c; }).ToArray());
        var same = Run(work, restored, "same", new JsonObject { ["ops"] = plain }.ToJsonString(), Path.Combine(work, "same.oml"));
        Assert.True(same["accepted"]!.GetValue<bool>(), same.ToJsonString());
        Assert.Null(same["accessChanges"]);
    }

    // T12 correction round (finding 5): two temporary changes stacked on one screen (Registered, then Anonymous added, then
    // narrowed back to Registered by a second change). Each restore op carries ifCurrent (the
    // value its change wrote): restored oldest first, the older one meets the newer value and is refused, naming the screen
    // and both values, with nothing written; newest first, both apply and the screen is back as it was.
    [Fact]
    public void StackedChangesRestoreNewestFirstAndARestoreNeverOverwritesALaterChange()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var kernel = JobSources.KernelRoot()!;
        var work = Path.Combine(kernel, ".local", "t12-access-stacked", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var created = Path.Combine(work, "created.oml");
        Assert.True(Run(work, Path.Combine(kernel, "tests", "fixtures", "reactive-ui.oml"), "create",
            """{"ops":[{"op":"html","data":{"html":"<screen name=\"StackProbe\" roles=\"Registered\"><p>probe</p></screen>"}}]}""", created)["accepted"]!.GetValue<bool>());
        var first = Path.Combine(work, "first.oml");
        var one = Run(work, created, "one", """{"ops":[{"op":"set","target":"IMobileScreen:StackProbe","prop":"Roles","value":["IRole:Anonymous","IRole:Registered"]}]}""", first);
        var second = Path.Combine(work, "second.oml");
        var two = Run(work, first, "two", """{"ops":[{"op":"set","target":"IMobileScreen:StackProbe","prop":"Roles","value":["IRole:Registered"]}]}""", second);
        Assert.True(one["accessRestore"] != null, one.ToJsonString()); Assert.True(two["accessRestore"] != null, two.ToJsonString());
        var restoreOne = one["accessRestore"]!["ops"]!; var restoreTwo = two["accessRestore"]!["ops"]!;
        Assert.NotNull(restoreOne[0]!["ifCurrent"]);
        var wrong = Assert.ThrowsAny<Exception>(() => Run(work, second, "wrong", new JsonObject { ["ops"] = restoreOne.DeepClone() }.ToJsonString(), Path.Combine(work, "wrong.oml")));
        Assert.Contains("screen 'StackProbe': this restore applies only while Roles is", wrong.ToString());
        Assert.Contains("(Registered)", wrong.ToString());
        var back = Path.Combine(work, "back.oml");
        Assert.True(Run(work, second, "newest", new JsonObject { ["ops"] = restoreTwo.DeepClone() }.ToJsonString(), back)["accepted"]!.GetValue<bool>());
        var done = Run(work, back, "oldest", new JsonObject { ["ops"] = restoreOne.DeepClone() }.ToJsonString(), Path.Combine(work, "done.oml"));
        Assert.True(done["accepted"]!.GetValue<bool>(), done.ToJsonString());
        Assert.Equal(new[] { "Registered" }, Assert.Single(done["accessChanges"]!.AsArray())!["toNames"]!.AsArray().Select(n => n!.ToString()));
    }
}
