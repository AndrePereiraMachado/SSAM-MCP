using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the selective reading of actions (S10, ModuleFlow.BuildSelected, the reader's
/// {"flowElements"}) on a real capture of hundreds of actions. The selected actions are the whole reading of them (same
/// text, ids, fixed point and textSha, from another load of the same bytes); the selection is partial, says what it did not
/// build and is never stored or parsed as the module's flow; the contracts ({"signatureElements"}) are the parameters of
/// the whole reading; and an edit whose basedOn is the textSha of a selective read merges three ways on the same base.
/// </summary>
public static class FlowReadSelectiveScenarios
{
    private static string Sha(byte[] bytes) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();

    private static FlowEntry EntryOf(JsonNode a) => new(a["key"]!.ToString(), a["kind"]!.ToString(), a["name"]!.ToString(), a["text"]!.GetValue<string>(),
        a["ids"]!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal),
        a["problems"]!.AsArray().Select(p => p!.ToString()).ToList(), a["fixedPoint"]!.GetValue<bool>(), a["nodes"]!.GetValue<int>(), a["digestBytes"]!.GetValue<int>(),
        a["opaque"] is JsonArray opaque ? opaque.Select(o => o!.ToString()).ToList() : null);

    // count actions spread over the module (name order), deterministic.
    private static List<FlowEntry> Spread(IReadOnlyList<FlowEntry> actions, int count) =>
        Enumerable.Range(0, count).Select(i => actions[(int)((i + 0.5) * actions.Count / count)]).ToList();

    public static void SelectedActionsAreTheWholeReadingOfThem(string work, string capture, string lane, Action<string> log)
    {
        var host = new ModelHost(work);
        var bytes = File.ReadAllBytes(capture); var sha = Sha(bytes);
        ModuleFlow full; double fullMs;
        using (var snapshot = KernelSnapshotReading.Open(host, bytes)) {
            var clock = Stopwatch.StartNew();
            full = snapshot.BuildFlow(lane, sha, bytes.Length);
            fullMs = clock.Elapsed.TotalMilliseconds;
        }
        Assert.True(full.Actions.Count >= 100, capture + " has " + full.Actions.Count + " actions");

        var picked = Spread(full.Actions, 20);
        // Another load of the same bytes: the selection is read by another reader process than the whole flow.
        JsonObject selection, byName, two, ten;
        double selectedMs, twoMs, tenMs;
        using (var again = KernelSnapshotReading.Open(host, bytes)) {
            var clock = Stopwatch.StartNew();
            two = again.BuildFlowSelection(lane, "kernel", sha, bytes.Length, picked.Take(2).Select(a => "@" + a.Key).ToList());
            twoMs = clock.Elapsed.TotalMilliseconds; clock.Restart();
            ten = again.BuildFlowSelection(lane, "kernel", sha, bytes.Length, picked.Take(10).Select(a => "@" + a.Key).ToList());
            tenMs = clock.Elapsed.TotalMilliseconds; clock.Restart();
            selection = again.BuildFlowSelection(lane, "kernel", sha, bytes.Length, picked.Select(a => "@" + a.Key).ToList());
            selectedMs = clock.Elapsed.TotalMilliseconds;
            byName = again.BuildFlowSelection(lane, "kernel", sha, bytes.Length, picked.Select(a => a.Name).ToList());
        }
        log($"{lane} {Path.GetFileName(capture)}: {full.Actions.Count} actions; whole flow {fullMs:F0} ms; "
            + $"selected (fresh load) 2 {twoMs:F0} ms, then 10 {tenMs:F0} ms, then 20 {selectedMs:F0} ms");
        Assert.Equal(2, two["actions"]!.AsArray().Count); Assert.Equal(10, ten["actions"]!.AsArray().Count);
        // The catalog is Build's list of actions, names and order included (what the facade resolves an element against).
        Assert.Equal(full.Actions.Select(a => (a.Key, a.Kind, a.Name)),
            selection["catalog"]!.AsArray().Select(a => (a!["key"]!.ToString(), a["kind"]!.ToString(), a["name"]!.ToString())));

        Assert.Equal(ModuleFlow.SelectionSchema, selection["schema"]!.ToString());
        Assert.True(selection["partial"]!.GetValue<bool>());
        var scope = selection["scope"]!;
        Assert.False(scope["completeModule"]!.GetValue<bool>());
        Assert.Equal(full.Actions.Count, scope["availableActions"]!.GetValue<int>());
        Assert.Equal(20, scope["builtActions"]!.GetValue<int>());
        Assert.Equal(full.Actions.Count - 20, scope["notBuilt"]!["actions"]!.GetValue<int>());
        Assert.Equal(full.Actions.Count, selection["catalog"]!.AsArray().Count);
        var selected = selection["actions"]!.AsArray().Select(a => EntryOf(a!)).ToDictionary(e => e.Key);
        Assert.Equal(20, selected.Count);
        foreach (var whole in picked) {
            var part = selected[whole.Key];
            Assert.Equal(whole.Name, part.Name); Assert.Equal(whole.Kind, part.Kind);
            Assert.Equal(whole.Text, part.Text);
            Assert.Equal(whole.TextSha, part.TextSha);
            Assert.Equal(whole.Ids, part.Ids);
            Assert.Equal(whole.FixedPoint, part.FixedPoint); Assert.Equal(whole.Nodes, part.Nodes);
            Assert.Equal(whole.Problems, part.Problems); Assert.Equal(whole.Opaque, part.Opaque);
            Assert.Equal(0, part.DigestBytes);
            // The base of the three-way merge: the same file, byte for byte, whichever reading served the action.
            Assert.Equal(FlowReading.Of(whole, lane, sha).ToJson("kernel"), FlowReading.Of(part, lane, sha).ToJson("kernel"));
        }
        // By names the selection may build more (a name another action ends with), never fewer.
        var named = byName["actions"]!.AsArray().Select(a => a!["key"]!.ToString()).ToHashSet();
        Assert.All(picked, a => Assert.Contains(a.Key, named));
        Assert.All(byName["actions"]!.AsArray(), a => Assert.Equal(full.Actions.Single(w => w.Key == a!["key"]!.ToString()).TextSha, ModuleFlow.TextSha(a!["text"]!.GetValue<string>())));
        // Never read back as the module's flow.
        Assert.ThrowsAny<Exception>(() => ModuleFlow.Parse(Encoding.UTF8.GetBytes(selection.ToJsonString()), lane, "kernel", sha));
    }

    // The reader's cache (SnapshotReadCache): {"flowElements"} answers a selection and stores no flow file; once the whole flow
    // is stored, the same request is answered by it; {"signatureElements"} answers the contracts of the whole reading.
    public static void TheReaderNeverStoresASelectionAsTheModulesFlow(string work, string capture, string lane)
    {
        var host = new ModelHost(work);
        var store = new ModuleIndexStore(Path.Combine(work, "index"), lane, "kernel");
        var bytes = File.ReadAllBytes(capture); var sha = Sha(bytes);
        var loads = 0;
        using var cache = new SnapshotReadCache(b => {
            loads++;
            return KernelSnapshotReading.Open(host, b);
        }, store);
        var whole = host.BuildFlow(bytes, sha, lane);
        var picked = Spread(whole.Actions, 3);
        var request = new JsonObject { ["file"] = capture, ["flow"] = "ensure", ["expectedSourceSha256"] = sha,
            ["flowElements"] = new JsonArray(picked.Select(a => (JsonNode)JsonValue.Create(a.Name)!).ToArray()) };
        var first = cache.Read(request.DeepClone().AsObject());
        var selection = first["flowSelection"]!;
        Assert.Null(first["flow"]);
        Assert.True(selection["partial"]!.GetValue<bool>());
        Assert.False(File.Exists(store.FlowPathOf(sha)));
        Assert.Null(store.LoadFlow(sha));
        foreach (var a in picked)
            Assert.Equal(a.TextSha, ModuleFlow.TextSha(selection["actions"]!.AsArray().Single(s => s!["key"]!.ToString() == a.Key)!["text"]!.GetValue<string>()));
        // The same request again: memoized beside the loaded capture, still nothing stored.
        var second = cache.Read(request.DeepClone().AsObject());
        Assert.True(second["cache"]!["queryHit"]!.GetValue<bool>());
        Assert.False(File.Exists(store.FlowPathOf(sha)));
        Assert.Equal(1, loads);

        // Contracts without bodies: the parameters of the whole reading, in its order.
        var contracts = cache.Read(new JsonObject { ["file"] = capture, ["expectedSourceSha256"] = sha,
            ["signatureElements"] = new JsonArray(picked.Select(a => (JsonNode)JsonValue.Create("@" + a.Key)!).ToArray()) })["flowSignatures"]!;
        Assert.Equal(ModuleFlow.SignaturesSchema, contracts["schema"]!.ToString());
        Assert.False(contracts["scope"]!["bodiesRead"]!.GetValue<bool>());
        foreach (var a in picked) {
            var contract = contracts["actions"]!.AsArray().Single(c => c!["key"]!.ToString() == a.Key)!;
            var read = ModuleFlow.Read(a.Text, a.Ids);
            foreach (var role in new[] { "in", "out" })
                Assert.Equal(read.Items.Where(p => p.Role == role).Select(p => (p.Key, p.Name, p.Prop("DataType"))),
                    contract[role == "in" ? "inputs" : "outputs"]!.AsArray().Select(p => (p!["key"]!.ToString(), p["name"]!.ToString(), p["type"]?.ToString())));
        }
        Assert.False(File.Exists(store.FlowPathOf(sha)));

        // The whole flow stored ({"flow":"ensure"}): the selective request is then answered by it.
        cache.Read(new JsonObject { ["file"] = capture, ["flow"] = "ensure", ["expectedSourceSha256"] = sha });
        Assert.True(File.Exists(store.FlowPathOf(sha)));
        var stored = cache.Read(request.DeepClone().AsObject());
        Assert.Null(stored["flowSelection"]);
        Assert.NotNull(stored["flow"]);
        Assert.Equal(whole.Actions.Count, store.LoadFlow(sha)!.Actions.Count);
    }

    private const string Text = "server action SelCount\n  in Limit: Integer\n  out Total: Integer\n  local Seen: Integer\n"
        + "  assign Total = 0  # Reset\n  assign Seen = Limit  # Take\n  assign Total = Total + Seen  # Add\n  end\n";

    private static JsonNode Run(string dir, string name, string job, string? basePath = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static string Flow(string text, string? basedOn) =>
        new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = text, ["basedOn"] = basedOn } }) }.ToJsonString();

    // The action read alone (the selective reading) from a saved module, and as the whole reading reads it.
    private static (FlowEntry Selected, FlowEntry Whole, string Sha) Read(string dir, string name, string lane, string action)
    {
        var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml")); var sha = Sha(bytes);
        var host = new ModelHost(Path.Combine(dir, "work"));
        JsonObject selection;
        using (var snapshot = KernelSnapshotReading.Open(host, bytes)) selection = snapshot.BuildFlowSelection(lane, "kernel", sha, bytes.Length, [action]);
        var selected = EntryOf(selection["actions"]!.AsArray().Single(a => a!["name"]!.ToString() == action)!);
        var whole = host.BuildFlow(bytes, sha, lane).Actions.Single(a => a.Name == action);
        Assert.True(selected.FixedPoint, string.Join("\n", selected.Problems));
        return (selected, whole, sha);
    }

    // An edit written on a selective read (its textSha the basedOn, its FlowReading the one kept), delivered after the action
    // changed, is merged three ways exactly as on a read of the whole flow: both edits stay, the element both changed keeps
    // the delivery's and is listed, and the action reads back, by the selective reading and the whole one alike.
    public static void AnEditOfASelectiveReadMergesOnTheSameBase(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;   // no store here (no workspace, no SSAM_MODULE_INDEX_ROOT): nothing keeps the read
        var created = Run(dir, "sel-base", Flow(Text, null), fixture);
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var (read, whole, baseSha) = Read(dir, "sel-base", lane, "SelCount");
        Assert.Equal(whole.TextSha, read.TextSha);
        store.SaveFlowReading(FlowReading.Of(read, lane, baseSha));
        // The Studio's change after the read: another reset value and a step after Take.
        var take = read.Text.Split('\n').Single(l => l.Contains("assign Seen = Limit", StringComparison.Ordinal));
        var studio = read.Text.Replace("assign Total = 0", "assign Total = 5").Replace(take + "\n", take + "\n  assign Total = Total + 10\n");
        var changed = Run(dir, "sel-studio", Flow(studio, read.TextSha), Path.Combine(dir, "sel-base.oml"));
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed["policyMessages"]?.ToJsonString() + changed["details"]);
        // The model's edit on the selective read: the sum (only it changed it) and the reset (both did).
        var edited = read.Text.Replace("assign Total = Total + Seen", "assign Total = Total + Seen * 2").Replace("assign Total = 0", "assign Total = 9");
        var result = Run(dir, "sel-merge", Flow(edited, read.TextSha), Path.Combine(dir, "sel-studio.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var receipt = result["results"]![0]!["result"]!["flow"]![0]!;
        Assert.Equal("three-way", receipt["merged"]!["merge"]!.ToString());
        Assert.Equal(read.TextSha, receipt["merged"]!["basedOn"]!.ToString());
        var conflict = Assert.Single(receipt["merged"]!["conflicts"]!.AsArray())!;
        Assert.Contains("Total = 5", conflict["studio"]!.ToString());
        Assert.Contains("Total = 9", conflict["delivered"]!.ToString());
        var (after, afterWhole, _) = Read(dir, "sel-merge", lane, "SelCount");
        Assert.Equal(afterWhole.Text, after.Text);
        Assert.Contains("assign Total = Total + Seen * 2", after.Text);
        Assert.Contains("assign Total = Total + 10", after.Text);
        Assert.Contains("assign Total = 9", after.Text);
        Assert.DoesNotContain("assign Total = 5", after.Text);
        var (studioRead, _, _) = Read(dir, "sel-studio", lane, "SelCount");
        Assert.All(studioRead.Ids.Values, key => Assert.Contains(key, after.Ids.Values));
        // The receipt's text is the action as both readings read it now.
        Assert.Equal(after.TextSha, receipt["textSha"]?.ToString() ?? after.TextSha);
    }
}
