using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>The worker's base cache without a Studio: a fake model per load, real files for the key. What must hold is
/// what makes a spare safe to hand out (take-once, never returned, any change of the model or the runtime misses; R3: the
/// same model in another file or with another time is the same module) and what keeps it bounded (entries, bytes, idle
/// expiry, memory, cancellation).</summary>
public sealed class BaseModelCacheTests : IDisposable
{
    private sealed class Model
    {
        private static int next;
        public int Id { get; } = Interlocked.Increment(ref next);
        public required byte[] Bytes { get; init; }
    }

    private readonly string dir = Path.Combine(Path.GetTempPath(), "anvil-base-cache-tests", Guid.NewGuid().ToString("N"));
    private readonly List<Model> released = new();
    private readonly List<string> log = new();
    private DateTime now = new(2026, 9, 30, 12, 0, 0, DateTimeKind.Utc);
    private string profile = "developerId=a";
    private long heap;
    private int loads;
    private Func<byte[], CancellationToken, Model>? loadOverride;
    private Func<Model, CancellationToken, int>? walkOverride;

    public BaseModelCacheTests() => Directory.CreateDirectory(dir);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    private BaseModelCache<Model> Cache(BaseCacheOptions? options = null) => new(options ?? BaseCacheOptions.Default,
        () => new BaseRuntime("test", "1.0", "studio", "kernel", profile),
        (bytes, cancel) => { loads++; return loadOverride?.Invoke(bytes, cancel) ?? new Model { Bytes = bytes }; },
        (model, cancel) => walkOverride?.Invoke(model, cancel) ?? 100,
        released.Add, log.Add, () => now, () => heap, () => 0, () => { });

    private string Base(string name, int size = 1000, byte fill = 1)
    {
        var path = Path.Combine(dir, name + ".oml");
        File.WriteAllBytes(path, Enumerable.Repeat(fill, size).ToArray());
        return path;
    }

    private static BaseModelCache<Model>.Taken Take(BaseModelCache<Model> cache, string path) => cache.Take(path, File.ReadAllBytes(path));

    [Fact]
    public void ASpareIsTakenOnceAndNeverComesBack()
    {
        var cache = Cache(); var a = Base("a");
        var first = Take(cache, a);
        Assert.Null(first.Model);
        Assert.False(first.Receipt["hit"]!.GetValue<bool>());
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);

        var hit = Take(cache, a);
        Assert.NotNull(hit.Model);
        Assert.True(hit.Receipt["hit"]!.GetValue<bool>());
        Assert.Equal(first.Receipt["key"]!.GetValue<string>(), hit.Receipt["key"]!.GetValue<string>());
        Assert.Equal(100, hit.Receipt["prefetch"]!["objects"]!.GetValue<int>());
        Assert.Equal(0, cache.Held);
        Assert.Null(Take(cache, a).Model);                 // nothing prepared since: a miss, never the same instance

        cache.Idle(CancellationToken.None);
        var again = Take(cache, a);
        Assert.NotEqual(hit.Model!.Id, again.Model!.Id);    // a fresh instance each time
        Assert.DoesNotContain(released, m => m.Id == hit.Model.Id || m.Id == again.Model.Id); // the taker releases what it took
        var stats = cache.Stats();
        Assert.Equal(2, stats["hits"]!.GetValue<long>()); Assert.Equal(2, stats["misses"]!.GetValue<long>());
        Assert.Equal(2, stats["prefetches"]!.GetValue<long>());
    }

    [Fact]
    public void ChangedBytesWithTheSameLengthAndTimeMiss()
    {
        var cache = Cache(); var a = Base("a");
        Take(cache, a); cache.Idle(CancellationToken.None);
        var stamp = File.GetLastWriteTimeUtc(a);
        File.WriteAllBytes(a, Enumerable.Repeat((byte)2, 1000).ToArray());
        File.SetLastWriteTimeUtc(a, stamp);

        var taken = Take(cache, a);
        Assert.Null(taken.Model);
        Assert.Equal("changed", taken.Receipt["evicted"]!.GetValue<string>());
        Assert.Single(released);                            // the stale spare is released, never handed out
        cache.Idle(CancellationToken.None);
        Assert.Equal(2, Take(cache, a).Model!.Bytes[0]);
    }

    [Fact]
    public void AnMtimeOnlyChangeIsTheSameModel()
    {
        // R3: the key is the model read from the bytes, never the file's stamps.
        var cache = Cache(); var a = Base("a");
        Take(cache, a); cache.Idle(CancellationToken.None);
        File.SetLastWriteTimeUtc(a, File.GetLastWriteTimeUtc(a).AddMinutes(1));
        var taken = Take(cache, a);
        Assert.NotNull(taken.Model);
        Assert.True(taken.Receipt["hit"]!.GetValue<bool>());
        Assert.Empty(released);
    }

    [Fact]
    public void AnotherLoadProfileMisses()
    {
        var cache = Cache(); var a = Base("a");
        Take(cache, a); cache.Idle(CancellationToken.None);
        profile = "developerId=b";                          // ODC stamps the developer id at load
        Assert.Null(Take(cache, a).Model);
        Assert.Single(released);
    }

    [Fact]
    public void TheLeastRecentlyUsedBaseGoesBeyondTheEntryLimit()
    {
        var cache = Cache(BaseCacheOptions.Default with { Entries = 2 }); var a = Base("a", fill: 1); var b = Base("b", fill: 2); var c = Base("c", fill: 3);
        Take(cache, a); Take(cache, b); cache.Idle(CancellationToken.None);
        Assert.Equal(2, cache.Held);
        Take(cache, c); cache.Idle(CancellationToken.None);
        Assert.Equal(2, cache.Held);
        Assert.Equal(1, cache.Stats()["evictedBy"]!["lru"]!.GetValue<int>());
        Assert.Equal(1, Assert.Single(released).Bytes[0]);
        Assert.Null(Take(cache, a).Model);
        Assert.NotNull(Take(cache, b).Model);
    }

    [Fact]
    public void TheByteBudgetKeepsTheMoreRecentBase()
    {
        // 25x the OML size is the floor estimate: 25 KB per 1 KB base, one fits in 40 KB.
        var cache = Cache(BaseCacheOptions.Default with { Bytes = 40_000 }); var a = Base("a"); var b = Base("b");
        Take(cache, a); Take(cache, b); cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
        Assert.NotNull(Take(cache, b).Model);
        Assert.Equal(1, loads);                             // a was not even loaded: it could only fit by evicting b
        var tooBig = Base("big", 2000);
        Assert.Null(Take(cache, tooBig).Model);
        cache.Idle(CancellationToken.None);
        Assert.Equal("budget", Take(cache, tooBig).Receipt["evicted"]!.GetValue<string>());
    }

    [Fact]
    public void SparesExpireAfterThirtyIdleMinutes()
    {
        var cache = Cache(); var a = Base("a");
        Take(cache, a); cache.Idle(CancellationToken.None);
        now = now.AddMinutes(29);
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
        now = now.AddMinutes(2);
        cache.Idle(CancellationToken.None);
        Assert.Equal(0, cache.Held);
        Assert.Single(released);
        Assert.Equal(1, loads);                             // an expired base is not prepared again
        Assert.Equal("idle", Take(cache, a).Receipt["evicted"]!.GetValue<string>());
    }

    [Fact]
    public void ACancelledPrefetchReleasesWhatItLoadedAndIsRetried()
    {
        var cache = Cache(); var a = Base("a");
        Take(cache, a);
        using var cancel = new CancellationTokenSource();
        walkOverride = (model, token) => { cancel.Cancel(); token.ThrowIfCancellationRequested(); return 0; };
        cache.Idle(cancel.Token);
        Assert.Equal(0, cache.Held);
        Assert.Single(released);                            // the partial instance
        using var early = new CancellationTokenSource();
        loadOverride = (bytes, token) => { early.Cancel(); token.ThrowIfCancellationRequested(); return null!; };
        cache.Idle(early.Token);
        Assert.Single(released);                            // nothing was returned to release
        Assert.Equal(2, cache.Stats()["cancels"]!.GetValue<long>());
        loadOverride = null; walkOverride = null;
        cache.Idle(CancellationToken.None);
        Assert.NotNull(Take(cache, a).Model);
    }

    [Fact]
    public void ARequestForTheBaseBeingPreparedWaitsAndAnyOtherCancels()
    {
        var cache = Cache(); var a = Base("a"); var b = Base("b", fill: 2);   // another model (R3: a copy of the same bytes waits too)
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray() }.ToJsonString());
        var verdicts = new List<bool>();
        walkOverride = (model, token) =>
        {
            verdicts.Add(cache.Serves(new[] { "apply", "--job", job, "--base", a, "--out", "x.oml" }));
            verdicts.Add(cache.Serves(new[] { "apply", "--job", job, "--base", b, "--out", "x.oml" }));
            verdicts.Add(cache.Serves(new[] { "leak" }));
            return 1;
        };
        Take(cache, a); cache.Idle(CancellationToken.None);
        Assert.Equal(new[] { true, false, false }, verdicts);
        Assert.False(cache.Serves(new[] { "apply", "--job", job, "--base", a }));   // nothing is being prepared now
    }

    [Fact]
    public void MemoryPressureGivesTheSparesBackAndStopsPrefetching()
    {
        var cache = Cache(); var a = Base("a");
        Take(cache, a); cache.Idle(CancellationToken.None);
        heap = 1600L << 20;                                 // above 1.5 GB of live heap, before the worker's 2 GB recycle
        cache.Shed();
        Assert.Equal(0, cache.Held);
        Assert.Equal(1, cache.Stats()["evictedBy"]!["memory"]!.GetValue<int>());
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, loads);
        heap = 0;
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
    }

    [Fact]
    public void AFailedPrefetchIsNotRetried()
    {
        var cache = Cache(); var a = Base("a");
        Take(cache, a);
        loadOverride = (_, _) => throw new InvalidOperationException("broken base");
        cache.Idle(CancellationToken.None); cache.Idle(CancellationToken.None);
        Assert.Equal(1, loads);
        Assert.Equal("failed: InvalidOperationException", Take(cache, a).Receipt["evicted"]!.GetValue<string>());
    }

    [Fact]
    public void ABaseThisRunBuiltIsNeverPrepared()
    {
        var cache = Cache(); var built = Base("built");
        var taken = cache.Take(built, File.ReadAllBytes(built), reusable: false);
        Assert.Null(taken.Model);
        Assert.NotNull(taken.Receipt["skipped"]);
        cache.Idle(CancellationToken.None);
        Assert.Equal(0, loads);
    }

    [Fact]
    public void OnlyTheOperatorSwitchTurnsItOff()
    {
        Assert.Null(BaseCacheOptions.FromEnvironment(name => name == "ANVIL_BASE_CACHE" ? "off" : null));
        Assert.Equal(BaseCacheOptions.Default, BaseCacheOptions.FromEnvironment(_ => null));
        var tuned = BaseCacheOptions.FromEnvironment(name => name switch { "ANVIL_BASE_CACHE_ENTRIES" => "3", "ANVIL_BASE_CACHE_MB" => "512", _ => null })!;
        Assert.Equal(3, tuned.Entries); Assert.Equal(512L << 20, tuned.Bytes);
        Assert.Equal(TimeSpan.FromMinutes(30), tuned.Expiry);
        Assert.Equal(3, BaseCacheOptions.Default.Entries);
        Assert.Equal(TimeSpan.FromMinutes(5), BaseCacheOptions.FromEnvironment(name => name == "ANVIL_BASE_CACHE_IDLE_MINUTES" ? "5" : null)!.Expiry);
    }
}
