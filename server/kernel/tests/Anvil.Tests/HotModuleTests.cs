using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R3 (módulo quente) without a Studio: the identity of a module is its model, never its file; the receipt says
/// what was reused and why not; the reference inventories are kept by model and runtime only; the batch lab's ports
/// (no widget defaults for a job of data and flow text, the set-preparation clock).</summary>
public sealed class HotModuleTests : IDisposable
{
    private sealed class Model { public required byte[] Bytes { get; init; } }

    private readonly string dir = Path.Combine(Path.GetTempPath(), "anvil-hot-module-tests", Guid.NewGuid().ToString("N"));
    private readonly List<Model> released = new();
    private int loads;

    public HotModuleTests() => Directory.CreateDirectory(dir);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    private BaseModelCache<Model> Cache() => new(BaseCacheOptions.Default, () => new BaseRuntime("test", "1.0", "studio", "kernel", ""),
        (bytes, _) => { loads++; return new Model { Bytes = bytes }; }, (_, _) => 10, released.Add, null, null, () => 0, () => 0, () => { });   // this process's memory never decides here

    /// <summary>An OML as the Studio writes it: "OML", the header's length (32 bits, little endian), the header text, the model.</summary>
    private static byte[] Oml(string header, string model)
    {
        var text = Encoding.UTF8.GetBytes(header);
        return [.. "OML"u8.ToArray(), .. BitConverter.GetBytes((uint)text.Length), .. text, .. Encoding.UTF8.GetBytes(model)];
    }

    private string File(string name, byte[] bytes) { var path = Path.Combine(dir, name); System.IO.File.WriteAllBytes(path, bytes); return path; }

    [Fact]
    public void TheModelIdentityIsTheBytesAfterTheHeaderAsTheCaptureStoreReadsThem()
    {
        var a = Oml("Version|tree=1.2.3", "model-bytes");
        var b = Oml("Version|tree=9.9|longer window state", "model-bytes");
        Assert.Equal(BaseModelCache.ModelSha256(a), BaseModelCache.ModelSha256(b));
        Assert.NotEqual(BaseModelCache.ModelSha256(a), BaseModelCache.ModelSha256(Oml("Version|tree=1.2.3", "model-bytes!")));
        // The same rule as PrebuiltCandidate (the delivery's reuse of a build) on the same file.
        Assert.Equal(Anvil.Core.Delivery.PrebuiltCandidate.ModelSha256(File("a.oml", a)), BaseModelCache.ModelSha256(a));
        // Not an OML: every byte.
        Assert.Equal(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("x"u8.ToArray())).ToLowerInvariant(), BaseModelCache.ModelSha256("x"u8.ToArray()));
    }

    [Fact]
    public void ACopyOfTheCaptureInAnotherFileIsTheSameHotModule()
    {
        // o11-build-phase.mjs captureByKey copies a known capture to a new file for every build.
        var cache = Cache();
        var first = File("build-1.oml", Oml("h1", "same-model"));
        Assert.Null(cache.Take(first, System.IO.File.ReadAllBytes(first)).Model);
        cache.Idle(CancellationToken.None);
        var copy = File("build-2.oml", Oml("another window state", "same-model"));
        var taken = cache.Take(copy, System.IO.File.ReadAllBytes(copy));
        Assert.NotNull(taken.Model);
        Assert.True(taken.Receipt["hit"]!.GetValue<bool>());
        Assert.Equal(BaseModelCache.ModelSha256(System.IO.File.ReadAllBytes(copy)), taken.Receipt["modelSha256"]!.GetValue<string>());
        // One want per model: the idle step prepares one spare, not one per file.
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
        Assert.Equal(2, loads);
        // Another model is another module: a miss, and the spare of the old one is not handed out.
        var other = File("build-3.oml", Oml("h1", "changed-model"));
        Assert.Null(cache.Take(other, System.IO.File.ReadAllBytes(other)).Model);
        Assert.Empty(released);
    }

    [Fact]
    public void ARequestOnANewCopyOfTheModelBeingPreparedWaitsForItInsteadOfCancellingIt()
    {
        // Measured on a private worker (HMISJHA, 2026-10-24): the next build, right after the first, came with a new copy
        // of the capture; the prefetch was cancelled for it (another path) and the apply loaded the module again.
        var job = File("job.json", "{\"ops\":[]}"u8.ToArray());
        var first = File("build-1.oml", Oml("h1", "same-model"));
        var copy = File("build-2.oml", Oml("h2", "same-model"));
        var other = File("build-3.oml", Oml("h1", "another-model"));
        var verdicts = new List<bool>();
        BaseModelCache<Model>? cache = null;
        cache = new BaseModelCache<Model>(BaseCacheOptions.Default, () => new BaseRuntime("test", "1.0", "studio", "kernel", ""),
            (bytes, _) => new Model { Bytes = bytes }, (_, _) =>
            {
                foreach (var path in new[] { copy, other })
                    verdicts.Add(cache!.Serves(["apply", "--job", job, "--base", path, "--out", "x.oml"]));
                return 1;
            }, released.Add, null, null, () => 0, () => 0, () => { });   // this process's memory never decides here
        cache.Take(first, System.IO.File.ReadAllBytes(first));
        cache.Idle(CancellationToken.None);
        Assert.Equal([true, false], verdicts);
        Assert.NotNull(cache.Take(copy, System.IO.File.ReadAllBytes(copy)).Model);
    }

    [Fact]
    public void AnotherKernelReleaseIsAnotherHotModule()
    {
        var kernel = "kernel-1";
        var cache = new BaseModelCache<Model>(BaseCacheOptions.Default, () => new BaseRuntime("test", "1.0", "studio", kernel, ""),
            (bytes, _) => new Model { Bytes = bytes }, (_, _) => 1, released.Add, null, null, () => 0, () => 0, () => { });   // this process's memory never decides here
        var a = File("a.oml", Oml("h", "m"));
        cache.Take(a, System.IO.File.ReadAllBytes(a)); cache.Idle(CancellationToken.None);
        kernel = "kernel-2";
        var copy = File("b.oml", Oml("h2", "m"));
        Assert.Null(cache.Take(copy, System.IO.File.ReadAllBytes(copy)).Model);
    }

    [Fact]
    public void TheReceiptSaysWhatWasReusedAndWhyNot()
    {
        var hit = HotModule.Receipt(new JsonObject { ["hit"] = true, ["modelSha256"] = "ab", ["prefetch"] = new JsonObject { ["loadMs"] = 700L, ["walkMs"] = 90L } }, cacheOn: true, builtBase: false);
        Assert.True(hit["reused"]!.GetValue<bool>());
        Assert.Equal(790, hit["savedMs"]!.GetValue<long>());
        Assert.Equal("ab", hit["modelSha256"]!.GetValue<string>());
        var miss = HotModule.Receipt(new JsonObject { ["hit"] = false, ["evicted"] = "idle" }, cacheOn: true, builtBase: false);
        Assert.False(miss["reused"]!.GetValue<bool>());
        Assert.Contains("idle", miss["reason"]!.GetValue<string>());
        Assert.Equal(0, miss["savedMs"]!.GetValue<long>());
        Assert.Contains("first apply", HotModule.Receipt(new JsonObject { ["hit"] = false }, true, false)["reason"]!.GetValue<string>());
        Assert.Contains("cold process", HotModule.Receipt(null, false, false)["reason"]!.GetValue<string>());
        Assert.Contains("job:", HotModule.Receipt(null, true, true)["reason"]!.GetValue<string>());
    }

    [Fact]
    public void AJobOfDataAndFlowTextAloneNeedsNoWidgetDefaults()
    {
        JsonArray Ops(params JsonObject[] ops) => new(ops.Select(o => o.DeepClone()).ToArray());
        var ddl = new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "create entity A (Id Long Integer identifier auto)" } };
        var flow = new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("server action X\n  end\n") } };
        var exception = new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IUserException", ["name"] = "E" };
        Assert.True(JobRunner.WithoutWidgets(Ops(ddl, flow, exception)));
        Assert.False(JobRunner.WithoutWidgets(Ops()));
        Assert.False(JobRunner.WithoutWidgets(Ops(ddl, new JsonObject { ["op"] = "html", ["data"] = new JsonObject() })));
        Assert.False(JobRunner.WithoutWidgets(Ops(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray() } })));
        Assert.False(JobRunner.WithoutWidgets(Ops(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "x", ["screens"] = new JsonArray() } })));
        Assert.False(JobRunner.WithoutWidgets(Ops(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow" })));
    }

    [Fact]
    public void SetPreparationGroupsShareOneClockAndDisposeOnce()
    {
        using var capture = NativePerformanceCapture.Begin();
        var measure = NativePerformanceCapture.MeasureSetPreparation(typeof(string), "Length");
        measure.Dispose(); measure.Dispose();
        var phases = capture.Snapshot().Phases;
        Assert.Equal(1, phases["set.prepare"].Calls);
        Assert.Equal(phases["set.prepare"], phases["set.prepare/System.String/Length"]);
    }

    [Fact]
    public void AnInventoryIsKeptByModelAndRuntimeAndASidecarOfAnotherRuntimeIsIgnored()
    {
        ReferenceInventoryCache.ClearForTests();
        var model = new string('a', 64);
        var references = new JsonArray(new JsonObject { ["name"] = "(System)", ["producerKey"] = "k", ["kind"] = "eSpace", ["hash"] = "h", ["exports"] = new JsonArray() });
        if (ReferenceInventoryCache.Runtime() == null) { Assert.Null(ReferenceInventoryCache.Find(model)); return; }   // no Studio runtime here: nothing kept
        Assert.Null(ReferenceInventoryCache.Find(model));
        ReferenceInventoryCache.Remember(model, references, 640, "read:base");
        var kept = ReferenceInventoryCache.Find(model.ToUpperInvariant())!.Value;
        Assert.True(JsonNode.DeepEquals(references, kept.References));
        Assert.Equal(640, kept.CostMs);
        kept.References.Clear();                                    // a copy: the kept one never changes
        Assert.Single(ReferenceInventoryCache.Find(model)!.Value.References);
        var foreign = Path.Combine(dir, "candidate.references.json");
        var other = new string('b', 64);
        System.IO.File.WriteAllText(foreign, new JsonObject { ["schema"] = ReferenceInventoryCache.SidecarSchema, ["runtime"] = "another|studio",
            ["candidate"] = new JsonObject { ["modelSha256"] = other, ["references"] = references.DeepClone() } }.ToJsonString());
        Assert.False(ReferenceInventoryCache.ReadSidecar(foreign));
        Assert.Null(ReferenceInventoryCache.Find(other));
        System.IO.File.WriteAllText(foreign, new JsonObject { ["schema"] = ReferenceInventoryCache.SidecarSchema, ["runtime"] = ReferenceInventoryCache.Runtime(),
            ["candidate"] = new JsonObject { ["modelSha256"] = other, ["ms"] = 12L, ["references"] = references.DeepClone() } }.ToJsonString());
        Assert.True(ReferenceInventoryCache.ReadSidecar(foreign));
        Assert.Equal("sidecar:candidate", ReferenceInventoryCache.Find(other)!.Value.Source);
        Assert.False(ReferenceInventoryCache.ReadSidecar(Path.Combine(dir, "missing.json")));
    }
}
