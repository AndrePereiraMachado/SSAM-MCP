using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Explicit maintenance profiling (ported from the batch lab). Replays a supplied job against a disk capture, never the open
// Studio. Not a cold-authorship benchmark or runtime proof. Both tests return at once unless SSAM_PROFILE_JOB names a job.
public sealed class BatchApplyProfileTests(ITestOutputHelper output)
{
    // The memory of the whole test process (a full suite holds well over the worker's 1.5 GB shed limit) never gives the
    // spare back here, nor do other tests' allocations during a prefetch count against its budget.
    private static readonly BaseCacheOptions Unbounded = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };

    [Fact]
    public void ProfileCapturedJobWithoutStudioMutation()
    {
        var basis = Environment.GetEnvironmentVariable("SSAM_PROFILE_BASE");
        var job = Environment.GetEnvironmentVariable("SSAM_PROFILE_JOB");
        if (string.IsNullOrEmpty(basis) || string.IsNullOrEmpty(job)) return;
        var work = Work();
        var host = new ModelHost(work);
        using var metrics = NativePerformanceCapture.Begin();
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, Path.Combine(work, "candidate.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        foreach (var phase in metrics.Snapshot().Phases.OrderByDescending(p => p.Value.WallMs).Take(35))
            output.WriteLine($"{phase.Key}: {phase.Value.WallMs:F2}ms calls={phase.Value.Calls} cpu={phase.Value.CpuMs:F2}ms");
        output.WriteLine("Profile replay only. Inclusive timings overlap; no Studio merge or new authorship.");
    }

    /// <summary>R3 (módulo quente): the same job applied to copies of one capture, as the facade's build phase does (a new file
    /// each time, the same model): the first call of the process, a second call without the worker's cache, then
    /// SSAM_PROFILE_REPEAT (default 2) pairs through the worker's base cache: "worker-miss" (no idle step since the last
    /// apply: no spare) and "worker-hot" (after the idle step). Each call also reads the references of its base and of its
    /// candidate as the delivery's reference closure does: with the Studio's reader alone without the cache, through the
    /// inventories kept by model with it (ReferenceInventoryCache.ReadThrough). The table (per phase, ms) goes to the output
    /// and to SSAM_PROFILE_OUT (or .local/batch-apply-profile/&lt;run&gt;/profile.json).</summary>
    [Fact]
    public void ProfileFirstAndSecondApplyOnTheSameModule()
    {
        var job = Environment.GetEnvironmentVariable("SSAM_PROFILE_JOB");
        if (string.IsNullOrEmpty(job)) return;
        var root = PacoteBPolicyTests.FindRoot();
        var basis = Environment.GetEnvironmentVariable("SSAM_PROFILE_BASE") is { Length: > 0 } b ? b : Path.Combine(root, "tests", "fixtures", "blank-service.oml");
        var work = Work();
        var bytes = File.ReadAllBytes(basis);
        var cache = new BaseModelCache.Own(Unbounded);
        var runs = new JsonArray();
        var repeat = int.TryParse(Environment.GetEnvironmentVariable("SSAM_PROFILE_REPEAT"), out var r) && r > 0 ? r : 2;
        ReferenceInventoryCache.ClearForTests();
        var plan = new List<(string Name, bool Cached, bool Idle)> { ("first", false, false), ("second", false, false) };
        for (var i = 1; i <= repeat; i++) { plan.Add(("worker-miss-" + i, true, false)); plan.Add(("worker-hot-" + i, true, true)); }
        foreach (var (name, cached, idle) in plan)
        {
            // A new capture file with the same bytes: what o11-build-phase.mjs captureByKey copies for every build.
            var copy = Path.Combine(work, name + "-base.oml");
            File.WriteAllBytes(copy, bytes);
            var host = new ModelHost(Path.Combine(work, name));
            var candidate = Path.Combine(work, name + "-candidate.oml");
            if (idle) cache.Idle();
            var wall = Stopwatch.StartNew();
            var result = BaseModelCache.Scoped(cached ? cache : null, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, copy, job, candidate))!.AsObject());
            var applyWallMs = wall.ElapsedMilliseconds;
            wall.Restart();
            // SSAM_PROFILE_PLAIN_REFERENCES=1: the Studio's reader alone in every row (the measurement of a kernel without the cache).
            JsonArray Read(string oml, string what) => cached && Environment.GetEnvironmentVariable("SSAM_PROFILE_PLAIN_REFERENCES") != "1"
                ? ReferenceInventoryCache.ReadThrough(oml, file => ReadReferences(file, Path.Combine(work, name)), what).References
                : ReadReferences(oml, Path.Combine(work, name));
            var baseReferences = Read(copy, "base");
            var baseReferencesMs = wall.ElapsedMilliseconds;
            wall.Restart();
            var candidateReferences = File.Exists(candidate) ? Read(candidate, "candidate") : null;
            var candidateReferencesMs = wall.ElapsedMilliseconds;
            var row = new JsonObject
            {
                ["run"] = name, ["accepted"] = result["accepted"]?.DeepClone(), ["applyWallMs"] = applyWallMs,
                ["timings"] = result["timings"]?.DeepClone(), ["hotTimings"] = result["hotTimings"]?.DeepClone(), ["baseCache"] = result["baseCache"]?.DeepClone(), ["hot"] = result["hot"]?.DeepClone(),
                ["referenceClosure"] = new JsonObject { ["baseMs"] = baseReferencesMs, ["candidateMs"] = candidateReferencesMs,
                    ["baseReferences"] = baseReferences?.Count, ["candidateReferences"] = candidateReferences?.Count },
            };
            runs.Add(row);
            output.WriteLine(row.ToJsonString());
        }
        var file = Environment.GetEnvironmentVariable("SSAM_PROFILE_OUT") is { Length: > 0 } o ? o : Path.Combine(work, "profile.json");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        File.WriteAllText(file, new JsonObject { ["job"] = Path.GetFullPath(job), ["base"] = Path.GetFullPath(basis), ["runs"] = runs }
            .ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine("profile: " + file);
    }

    private static JsonArray ReadReferences(string oml, string work)
        => Anvil.Core.Delivery.ReferenceInventory.Read(oml, work);

    private static string Work()
    {
        var work = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "batch-apply-profile", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        return work;
    }
}
