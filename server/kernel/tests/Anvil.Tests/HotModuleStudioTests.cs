using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// R3 (módulo quente) on the installed Service Studio, headless: applies through the worker's base cache (a test's own,
/// BaseModelCache.Scoped) on copies of one capture, as the build phase makes them. What must hold: an apply on a hot module
/// never sees what an earlier apply did (the second of two, refused after it changed the model, leaves the hot state equal
/// to the capture), a hot apply says so with its load near zero, the reference inventory an apply records is the one the
/// delivery's reader reads from the saved files, and the batched measurement of the widget defaults gives the values of one
/// command per probe. Needs the Service Studio; without it the tests return.
/// </summary>
public sealed class HotModuleStudioTests(ITestOutputHelper output)
{
    // The memory of the whole test process (a full suite holds well over the worker's 1.5 GB shed limit) never gives the
    // spare back here, nor do other tests' allocations during a prefetch count against its budget.
    private static readonly BaseCacheOptions Unbounded = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };

    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HotModuleStudioTests).Assembly.Location)!)!;
    private static readonly string Blank = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string Work(string name)
    {
        var work = Path.Combine(Root, ".local", "test-work", "hot-module", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        return work;
    }

    private static string Job(string work, string name, params JsonObject[] ops)
    {
        var path = Path.Combine(work, name + ".json");
        File.WriteAllText(path, new JsonObject { ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) }.ToJsonString());
        return path;
    }

    private static JsonObject Ddl(string entity) => new() { ["op"] = "spec", ["data"] = new JsonObject {
        ["ddl"] = $"create entity {entity} public (\nId Long Integer identifier auto required,\nLabel Text(50) required\n);" } };

    private static JsonObject Flow(string text) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } };

    private static JsonObject Apply(BaseModelCache.Own cache, string work, string job, string name, byte[] bytes)
    {
        var copy = Path.Combine(work, name + "-base.oml");
        File.WriteAllBytes(copy, bytes);   // a new capture file of the same model, as captureByKey copies it
        var host = new ModelHost(Path.Combine(work, name));
        return BaseModelCache.Scoped(cache, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, copy, job, Path.Combine(work, name + "-candidate.oml")))!.AsObject());
    }

    [Fact]
    public void TwoAppliesOnTheSameHotModuleTheSecondRefusedLeaveTheHotStateEqualToTheCapture()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work("refused");
        var bytes = File.ReadAllBytes(Blank);
        var good = Job(work, "good", Ddl("HotGood"), Flow("server action HotTouch\n  in Label: Text\n  out Size: Integer\n  assign\n    Size = Length(Label)\n  end\n"));
        // The entity is created (the model changes), then the Verify refuses the action: the job is refused after the change.
        var bad = Job(work, "bad", Ddl("HotBad"), Flow("server action HotBroken\n  out Size: Integer\n  assign\n    Size = NoSuchVariable + 1\n  end\n"));
        var cache = new BaseModelCache.Own(Unbounded);

        var cold = Apply(cache, work, good, "1-cold", bytes);
        Assert.True(cold["accepted"]!.GetValue<bool>(), cold.ToJsonString());
        Assert.False(cold["hot"]!["reused"]!.GetValue<bool>());

        cache.Idle();
        Assert.Equal(1, cache.Held);
        // A Verify refusal answers accepted:false (a refusal of an earlier phase throws): either way nothing is saved for it.
        JsonObject? refused = null;
        try { refused = Apply(cache, work, bad, "2-refused", bytes); } catch (Exception ex) { output.WriteLine("refused: " + Errors.Text(ex)); }
        if (refused != null)
        {
            output.WriteLine("refused: " + refused["validation"]?["unexpected"]?.ToJsonString());
            Assert.False(refused["accepted"]!.GetValue<bool>());
            Assert.True(refused["hot"]!["reused"]!.GetValue<bool>());     // it ran on the hot module
            Assert.Contains("HotBad", refused["footprint"]!.ToJsonString());  // and changed it
        }
        Assert.Equal(0, cache.Held);                       // the refused apply took the spare and released it, never gave it back

        cache.Idle();
        var hot = Apply(cache, work, good, "3-hot", bytes);
        output.WriteLine("hot: " + hot["hot"]!.ToJsonString() + " timings " + hot["timings"]!.ToJsonString());
        Assert.True(hot["accepted"]!.GetValue<bool>(), hot.ToJsonString());
        Assert.True(hot["hot"]!["reused"]!.GetValue<bool>());
        Assert.True(hot["timings"]!["loadMs"]!.GetValue<long>() < cold["timings"]!["loadMs"]!.GetValue<long>());
        // The hot apply saw the capture, not the refused job's entity: the same module as the cold apply's.
        Assert.Equal(cold["objects"]!.GetValue<int>(), hot["objects"]!.GetValue<int>());
        Assert.Equal(cold["messages"]!.GetValue<int>(), hot["messages"]!.GetValue<int>());
        Assert.DoesNotContain("HotBad", hot["footprint"]!.ToJsonString());

        // And the spare prepared after them is the capture itself: every object as a fresh load of the bytes has it.
        cache.Idle();
        var copy = Path.Combine(work, "4-base.oml");
        File.WriteAllBytes(copy, bytes);
        var (spare, fresh) = cache.Shapes(copy, bytes, new ModelHost(Path.Combine(work, "4")));
        output.WriteLine($"shape: spare {spare}, fresh load {fresh}");
        Assert.NotNull(spare);
        Assert.Equal(fresh, spare);
    }

    [Fact]
    public void TheInventoryAnApplyRecordsIsWhatTheReaderReadsFromTheSavedFiles()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        // consume-reference adds a producer reference (a job: producer) to reactive-ui, which already references (System).
        var job = Path.Combine(Root, "tests", "jobs", "consume-reference.json");
        var basis = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var work = Work("inventory");
        var candidate = Path.Combine(work, "candidate.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, candidate))!.AsObject();
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var recorded = result["referenceInventory"] as JsonObject;
        Assert.NotNull(recorded);
        var sidecar = JsonNode.Parse(File.ReadAllText(recorded["file"]!.ToString()))!.AsObject();
        var readBase = Anvil.Core.Delivery.ReferenceInventory.Read(basis, Path.Combine(work, "read-base"));
        var readCandidate = Anvil.Core.Delivery.ReferenceInventory.Read(candidate, Path.Combine(work, "read-candidate"));
        // The Model API gives the exports in another order on each load: the same set, compared in one order.
        Assert.Equal(Canonical(readBase), Canonical(sidecar["base"]!["references"]));
        Assert.Equal(Canonical(readCandidate), Canonical(sidecar["candidate"]!["references"]));
        Assert.True(readCandidate.Count > readBase.Count);
        Assert.Equal(BaseModelCache.ModelSha256(File.ReadAllBytes(candidate)), sidecar["candidate"]!["modelSha256"]!.ToString());
        Assert.Equal(BaseModelCache.ModelSha256(File.ReadAllBytes(basis)), sidecar["base"]!["modelSha256"]!.ToString());
        // Kept in this process by model: the closure of a delivery reads it without loading the module.
        Assert.Equal(Canonical(readCandidate), Canonical(ReferenceInventoryCache.Find(sidecar["candidate"]!["modelSha256"]!.ToString())!.Value.References));
    }

    private static string Canonical(JsonNode? inventory)
        => string.Join("\n", Anvil.Core.Delivery.ReferenceClosure.FromJson(inventory as JsonArray).OrderBy(r => r.ProducerKey, StringComparer.Ordinal).ThenBy(r => r.Name, StringComparer.Ordinal)
            .Select(r => $"{r.Name}|{r.ProducerKey}|{r.Kind}|{r.Hash}|" + string.Join(",", r.Exports.Select(e => e.Type + ":" + e.Name + "@" + e.Key).Order(StringComparer.Ordinal))));

    [Fact]
    public void BatchedWidgetDefaultsMatchIndividualNativeTransactions()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"));
        var host = new ModelHost(Work("defaults"));
        using var baseline = NativePerformanceCapture.Begin();
        var individual = host.MeasureBorn(bytes, batch: false);
        var before = baseline.Snapshot();
        using var combined = NativePerformanceCapture.Begin();
        var grouped = host.MeasureBorn(bytes, batch: true);
        var after = combined.Snapshot();
        Assert.Equal(JsonSerializer.Serialize(individual.Born), JsonSerializer.Serialize(grouped.Born));
        Assert.Equal(JsonSerializer.Serialize(individual.Roles), JsonSerializer.Serialize(grouped.Roles));
        Assert.Equal(individual.Log, grouped.Log);
        Assert.True(individual.Born.Count > 20);
        var commands = (before.Phases.TryGetValue("mutation.command", out var b) ? b.Calls : 0, after.Phases.TryGetValue("mutation.command", out var a) ? a.Calls : 0);
        output.WriteLine($"native commands: individual {commands.Item1}, batched {commands.Item2}; wall {before.Phases.GetValueOrDefault("mutation.command")?.WallMs:F0} ms -> {after.Phases.GetValueOrDefault("mutation.command")?.WallMs:F0} ms");
        if (commands.Item1 > 0) Assert.True(commands.Item2 < commands.Item1 / 2, $"{commands.Item2} batched commands of {commands.Item1}");
    }
}
