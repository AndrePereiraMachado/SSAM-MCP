using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Hosting;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// L3b (spare pós-merge, pré-aquecimento) on the ODC lane, over the largest ODC capture of the fixtures: the spare prepared
/// for a delivered capture (BaseModelCache.AfterMerge) is structurally a fresh load of it (the R3 shape proof), and a `warm`
/// that names the author (developerId) prepares a spare the apply of that author takes, never another author's (the ODC
/// worker keys a spare by OdcRuntime.LoadProfile). Needs the ODC Studio; without it the tests return.
/// </summary>
public sealed class HotModuleAfterMergeOdcTests
{
    private static readonly BaseCacheOptions Unbounded = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };
    private static readonly string Root = FindRoot();
    private static readonly string Large = Path.Combine(Root, "tests", "fixtures", "odc", "wrightflood-personal-r8.oml");

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(HotModuleAfterMergeOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string Work(string name)
    {
        var work = Path.Combine(Root, ".local", "lane-odc", "test-work", "hot-module-after-merge", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        return work;
    }

    [Fact]
    public void TheSpareAfterAMergeIsAFreshLoadOfTheDeliveredCapture()
    {
        if (!StudioAvailable() || !File.Exists(Large)) return;
        var work = Work("merge");
        var capture = Path.Combine(work, "capture.oml"); File.Copy(Large, capture);
        var cache = HotModuleReadOdcScenarios.SpareAfterAnApply(work, capture, Unbounded);    // the build: a spare of the module before
        var delivered = Path.Combine(work, "delivered.oml"); File.Copy(Path.Combine(work, "candidate.oml"), delivered);
        var next = BaseModelCache.Scoped(cache, () => BaseModelCache.AfterMerge(delivered, capture))!;
        Assert.True(next["wanted"]!.GetValue<bool>());
        Assert.Equal(1, next["releasedSpares"]!.GetValue<int>());
        cache.Idle();
        Assert.Equal(1, cache.Held);
        Assert.Empty(cache.Stats()["warming"]!.AsArray());
        var (spare, fresh) = cache.Shapes(delivered, File.ReadAllBytes(delivered), new ModelHost(Path.Combine(work, "shape")));
        Assert.NotNull(spare);
        Assert.Equal(fresh, spare);
    }

    [Fact]
    public void AWarmForAnAuthorServesThatAuthorsApplyOnly()
    {
        if (!StudioAvailable() || !File.Exists(Large)) return;
        var work = Work("author");
        var capture = Path.Combine(work, "capture.oml"); File.Copy(Large, capture);
        var cache = new BaseModelCache.Own(Unbounded);
        new ModelHost(Path.Combine(work, "prologue"));
        var answer = cache.Warm([WorkerServer.IdleWork.WarmCommand, new JsonObject { ["developerId"] = "l3b-author@ssam.local",
            ["captures"] = new JsonArray(new JsonObject { ["path"] = capture }) }.ToJsonString()]);
        Assert.True(answer["data"]!["wanted"]![0]!["wanted"]!.GetValue<bool>(), answer.ToJsonString());
        cache.Idle();
        Assert.Equal(1, cache.Held);
        var host = new ModelHost(Path.Combine(work, "shape"));
        // Another author's apply (on its build's own copy of the capture) never takes it: its load would stamp another
        // LastModifiedBy. (The same file under another runtime evicts the spare: BaseModelCache.Take, "changed".)
        var otherCopy = Path.Combine(work, "build-other.oml"); File.Copy(capture, otherCopy);
        var other = OdcRuntime.WithDeveloperId("someone-else@ssam.local", () => cache.Shapes(otherCopy, File.ReadAllBytes(otherCopy), host));
        Assert.Null(other.Spare);
        Assert.Equal(1, cache.Held);
        var copy = Path.Combine(work, "build-author.oml"); File.Copy(capture, copy);
        var (spare, fresh) = OdcRuntime.WithDeveloperId("l3b-author@ssam.local", () => cache.Shapes(copy, File.ReadAllBytes(copy), host));
        Assert.NotNull(spare);
        Assert.Equal(fresh, spare);
    }
}
