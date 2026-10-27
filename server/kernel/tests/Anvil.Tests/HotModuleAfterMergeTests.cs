using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// L3b (spare pós-merge) with the Service Studio: a delivery that merged in a worker makes its delivered capture the base the
/// worker prepares next (Delivery result nextSpare, BaseModelCache.AfterMerge), in place of the capture before the merge.
/// What must hold: the spare prepared after the merge is structurally a fresh load of the delivered capture (the R3 shape
/// proof, here on the largest O11 fixture); the next apply of that model takes it (loadMs of a spare, hot.reused); a delivery
/// in a cold process (no worker cache) is unchanged and says nothing of a spare. The delivery itself runs end to end headless
/// (DeliveryMergeOrderTests' bridge: the open module is a file, merge_from_oml is the Studio's MatchTree). Without the Service
/// Studio the tests return.
/// </summary>
public sealed class HotModuleAfterMergeTests
{
    private static readonly BaseCacheOptions Unbounded = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HotModuleAfterMergeTests).Assembly.Location)!)!;
    private static readonly string Large = Path.Combine(Root, "tests", "fixtures", "hmisjha", "HMISJHA_CS-v5578.oml");
    private const string Job = """{"ops":[{"op":"spec","data":{"ddl":"create entity L3bPet public (\nId Long Integer identifier auto required,\nName Text(30) required\n);"}}]}""";
    private const string NextJob = """{"ops":[{"op":"spec","data":{"ddl":"create entity L3bToy public (\nId Long Integer identifier auto required,\nLabel Text(30) required\n);"}}]}""";

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string Work(string name)
    {
        var work = Path.Combine(Root, ".local", "test-work", "hot-module-after-merge", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        return work;
    }

    private static JsonObject Apply(BaseModelCache.Own? cache, string work, string basePath, string jobText, string tag)
    {
        var job = Path.Combine(work, tag + ".json"); File.WriteAllText(job, jobText);
        var host = new ModelHost(Path.Combine(work, tag + "-model"));
        return BaseModelCache.Scoped(cache, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, Path.Combine(work, tag + "-candidate.oml")))!.AsObject());
    }

    [Fact]
    public void ADeliveryInAWorkerPreparesItsDeliveredCaptureAndTheNextApplyTakesIt()
    {
        if (!StudioAvailable()) return;
        var cache = new BaseModelCache.Own(Unbounded);
        var (result, bridge, work) = Deliver(cache);
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        var next = result["nextSpare"]!.AsObject();
        var delivered = result["artifacts"]!.AsArray().Select(a => a!["path"]!.ToString()).Single(p => Path.GetFileName(p).StartsWith("delivered-", StringComparison.Ordinal));
        Assert.True(next["wanted"]!.GetValue<bool>());
        Assert.Equal(Path.GetFullPath(delivered), next["file"]!.ToString());
        Assert.Equal(BaseModelCache.ModelSha256(File.ReadAllBytes(delivered)), next["modelSha256"]!.ToString());
        Assert.Equal(BaseModelCache.ModelSha256(File.ReadAllBytes(bridge.Before)), next["superseded"]!.ToString());   // the module before the merge
        Assert.False(next["ready"]!.GetValue<bool>());

        cache.Idle();
        Assert.Equal(1, cache.Held);
        Assert.Empty(cache.Stats()["warming"]!.AsArray());                  // the capture before the merge is not prepared again

        // The next build copies the delivered capture (o11-capture-store) and applies to it: it takes the spare.
        var copy = Path.Combine(work, "build-copy.oml"); File.Copy(delivered, copy);
        var applied = Apply(cache, work, copy, NextJob, "next");
        Assert.True(applied["accepted"]?.GetValue<bool>() == true, applied.ToJsonString()[..Math.Min(600, applied.ToJsonString().Length)]);
        Assert.True(applied["hot"]!["reused"]!.GetValue<bool>(), applied["hot"]!.ToJsonString());
        Assert.True(applied["baseCache"]!["hit"]!.GetValue<bool>());

        // And it is the module: after the apply the spare is prepared again and has the shape of a fresh load.
        cache.Idle();
        var (spare, fresh) = cache.Shapes(copy, File.ReadAllBytes(copy), new ModelHost(Path.Combine(work, "shape")));
        Assert.NotNull(spare);
        Assert.Equal(fresh, spare);
    }

    [Fact]
    public void AColdDeliveryIsUnchangedAndWantsNoSpare()
    {
        if (!StudioAvailable()) return;
        var (result, _, _) = Deliver(null);
        Assert.True(result["delivered"]!.GetValue<bool>(), result["error"]?.ToString());
        Assert.Null(result["nextSpare"]);
    }

    [Fact]
    public void TheSpareAfterTheMergeOfTheLargeModuleIsAFreshLoadOfTheDeliveredCapture()
    {
        if (!StudioAvailable() || !File.Exists(Large)) return;
        var work = Work("large");
        var capture = Path.Combine(work, "capture.oml"); File.Copy(Large, capture);
        var cache = new BaseModelCache.Own(Unbounded);
        var built = Apply(cache, work, capture, Job, "build");                   // the build: the capture before the merge is wanted
        Assert.True(built["accepted"]?.GetValue<bool>() == true);
        cache.Idle();
        Assert.Equal(1, cache.Held);
        // The merge: the delivered capture is a module this worker never loaded (here the candidate the build saved).
        var delivered = Path.Combine(work, "delivered.oml"); File.Copy(Path.Combine(work, "build-candidate.oml"), delivered);
        var next = BaseModelCache.Scoped(cache, () => BaseModelCache.AfterMerge(delivered, capture))!;
        Assert.True(next["wanted"]!.GetValue<bool>());
        Assert.Equal(1, next["releasedSpares"]!.GetValue<int>());               // the spare of the module before the merge went
        Assert.Equal(0, cache.Held);
        cache.Idle();
        Assert.Equal(1, cache.Held);
        var (spare, fresh) = cache.Shapes(delivered, File.ReadAllBytes(delivered), new ModelHost(Path.Combine(work, "shape")));
        Assert.NotNull(spare);
        Assert.Equal(fresh, spare);
        Assert.Equal(1, cache.Stats()["evictedBy"]!["merged"]!.GetValue<int>());
        // Outside a worker (no cache in scope) nothing is wanted and nothing is said.
        Assert.Null(BaseModelCache.AfterMerge(delivered, capture));
    }

    private static (JsonObject Result, HeadlessBridge Bridge, string Work) Deliver(BaseModelCache.Own? cache)
    {
        StudioAssemblies.Bind();
        var work = Work("deliver");
        var job = Path.Combine(work, "job.json"); File.WriteAllText(job, Job);
        var host = new ModelHost(Path.Combine(work, "model"));
        var live = Path.Combine(work, "live.oml"); File.Copy(Path.Combine(Root, "tests", "fixtures", "blank-service.oml"), live);
        var bridge = new HeadlessBridge(host, live);
        var result = BaseModelCache.Scoped(cache, () => Delivery.Run(bridge, new("Headless_CS", job, work, Array.Empty<string>()),
            (basePath, jobPath, output) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Path.GetDirectoryName(output)!, "model")), basePath, jobPath, output))!.AsObject(),
            inspectData: (snapshot, assertions) => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckDataContract(snapshot, assertions),
            mergePlanner: new MergePlanner(directory => new ModelHost(Path.Combine(directory, "order-model")))));
        return (result, bridge, work);
    }

    /// <summary>The Studio boundary of DeliveryMergeOrderTests: the open module is a file and merge_from_oml runs the Studio's
    /// MatchTree headless over it. Before: the first capture (the module before the merge).</summary>
    private sealed class HeadlessBridge(ModelHost host, string live) : IBridgeClient
    {
        public string Before { get; private set; } = "";
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            switch (method)
            {
                case "bridge_manifest": return new() { ["protocolVersion"] = 2, ["capabilities"] = new JsonArray("publish_log", Delivery.MergeOrderCapability) };
                case "open_module": return new() { ["opened"] = true };
                case "get_active_module": return new() { ["name"] = "Headless_CS", ["key"] = "module" };
                case "snapshot_module":
                    File.Copy(live, parameters!["path"]!.ToString(), true);
                    if (Before == "") Before = parameters["path"]!.ToString();
                    return new() { ["key"] = "module", ["snapshot_id"] = Guid.NewGuid().ToString("N"), ["baseline"] = new JsonArray() };
                case "merge_from_oml":
                    var path = parameters!["first_pass_path"]?.ToString();
                    var probe = MergeProbe.Replay(host, File.ReadAllBytes(live), File.ReadAllBytes(parameters["base_path"]!.ToString()),
                        File.ReadAllBytes(parameters["foreign_path"]!.ToString()), path != null ? File.ReadAllBytes(path) : null, live);
                    return new() { ["merged"] = true, ["result"] = "Merge", ["hasConflicts"] = probe.HasConflicts, ["newErrors"] = 0,
                        ["mergeOrder"] = path != null ? new JsonObject { ["passes"] = 2 } : null, ["secondPass"] = path != null ? new JsonObject { ["merged"] = true } : null };
                case "get_errors": return new() { ["newErrors"] = 0, ["new"] = new JsonArray(), ["rawMessages"] = new JsonArray() };
                default: throw new InvalidOperationException("unexpected bridge call " + method);
            }
        }
    }
}
