using System.Diagnostics;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Hosting;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// L3b (spare pós-merge, pré-aquecimento) without a Studio: the base cache over a fake model whose load is slow and
/// cancellable, served by a real <see cref="WorkerServer"/>. What must hold: `warm` (and <see cref="BaseModelCache{TModel}.Remember"/>)
/// only names what the idle step prepares next and answers at once; a request that does not need the spare being prepared
/// (a delivery, another base) cancels it and never waits for it; a cancelled or unfinished spare is never handed out; an apply
/// of the model being prepared waits for that one prefetch only, never for the spares of other bases; superseding a model
/// stops preparing it and gives its spare back.
/// </summary>
public sealed class HotModuleWarmTests : IDisposable
{
    private sealed class Model { public required byte[] Bytes { get; init; } public bool Complete { get; set; } }

    private readonly string dir = Path.Combine(Path.GetTempPath(), "anvil-hot-warm-tests", Guid.NewGuid().ToString("N"));
    private readonly List<Model> released = new();
    private readonly List<string> log = new();
    private readonly ManualResetEventSlim loading = new();
    private int loadMs;
    private int loads;

    public HotModuleWarmTests() => Directory.CreateDirectory(dir);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    private static readonly BaseCacheOptions Options = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };

    // A load of loadMs that honours the token; the walk marks the instance complete (the cache adds it only after both).
    private BaseModelCache<Model> Cache() => new(Options, () => new BaseRuntime("test", "1.0", "studio", "kernel", "developerId=a"),
        (bytes, cancel) =>
        {
            Interlocked.Increment(ref loads); loading.Set();
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < loadMs) { cancel.ThrowIfCancellationRequested(); Thread.Sleep(5); }
            return new Model { Bytes = bytes };
        },
        (model, cancel) => { cancel.ThrowIfCancellationRequested(); model.Complete = true; return 10; },
        m => { lock (released) released.Add(m); }, m => { lock (log) log.Add(m); }, null, () => 0, () => 0, () => { });

    private string Capture(string name, byte fill)
    {
        var path = Path.Combine(dir, name + ".oml");
        File.WriteAllBytes(path, Enumerable.Repeat(fill, 4000).ToArray());
        return path;
    }

    private static string WarmRequest(params string[] paths) => new JsonObject { ["captures"] = new JsonArray(paths.Select(p => (JsonNode)new JsonObject { ["path"] = p }).ToArray()) }.ToJsonString();

    [Fact]
    public void RememberNamesTheNextSpareAndSupersedingAModelStopsPreparingIt()
    {
        loadMs = 0;
        var cache = Cache();
        var before = Capture("before", 1); var after = Capture("after", 2);
        Assert.Null(cache.Take(before, File.ReadAllBytes(before)).Model);   // the build: the module before the merge is wanted
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);

        var receipt = cache.Remember(after, supersedes: before);
        Assert.True(receipt["wanted"]!.GetValue<bool>());
        Assert.False(receipt["ready"]!.GetValue<bool>());
        Assert.Equal(BaseModelCache.ModelSha256(File.ReadAllBytes(after)), receipt["modelSha256"]!.ToString());
        Assert.Equal(BaseModelCache.ModelSha256(File.ReadAllBytes(before)), receipt["superseded"]!.ToString());
        Assert.Equal(1, receipt["releasedSpares"]!.GetValue<int>());
        Assert.Equal(0, cache.Held);                                        // the spare of the old module went ("merged")
        Assert.Single(released);
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
        var stats = cache.Stats();
        Assert.Equal(1, stats["evictedBy"]!["merged"]!.GetValue<int>());
        Assert.Empty(stats["warming"]!.AsArray());                          // the old module is not prepared again
        Assert.Equal(1, stats["remembered"]!.GetValue<long>());

        // The next build of the delivered model (another copy of the capture) takes that spare.
        var copy = Path.Combine(dir, "build-copy.oml"); File.Copy(after, copy);
        var taken = cache.Take(copy, File.ReadAllBytes(copy));
        Assert.NotNull(taken.Model); Assert.True(taken.Model!.Complete);
        Assert.True(taken.Receipt["hit"]!.GetValue<bool>());

        // Nothing merged (the same model on both sides): nothing superseded, nothing given back.
        var same = cache.Remember(after, supersedes: copy);
        Assert.Null(same["superseded"]); Assert.Equal(0, same["releasedSpares"]!.GetValue<int>());
        // A file that does not exist is said, never thrown.
        Assert.False(cache.Remember(Path.Combine(dir, "gone.oml"))["wanted"]!.GetValue<bool>());
    }

    [Fact]
    public void WarmAnswersAtOnceWithTheFirstCaptureFirstAndAtMostTheEntries()
    {
        loadMs = 0;
        var cache = Cache();
        var a = Capture("a", 1); var b = Capture("b", 2); var c = Capture("c", 3); var d = Capture("d", 4);
        var answer = cache.Warm([WorkerServer.IdleWork.WarmCommand, WarmRequest(a, b, Path.Combine(dir, "missing.oml"), "relative.oml", c, d)]);
        Assert.True(answer["ok"]!.GetValue<bool>());
        var wanted = answer["data"]!["wanted"]!.AsArray();
        Assert.Equal(3, wanted.Count);                                      // the cache's entries
        Assert.Equal([true, true, false], wanted.Select(w => w!["wanted"]!.GetValue<bool>()));
        Assert.Equal(0, loads);                                             // nothing loaded by the command itself
        var order = new List<string>();
        lock (log) log.Clear();
        cache.Idle(CancellationToken.None);
        lock (log) order.AddRange(log.Where(l => l.Contains("ready")).Select(l => l.Split(' ')[4]));
        Assert.Equal(["a.oml", "b.oml"], order);                            // the first named, the first prepared
        Assert.Throws<ArgumentException>(() => cache.Warm([WorkerServer.IdleWork.WarmCommand]));
    }

    [Fact]
    public void ADeliveryThatArrivesDuringThePreparationNeverWaitsForItNorGetsAnUnfinishedSpare()
    {
        loadMs = 3000;
        var cache = Cache();
        var a = Capture("a", 1);
        var seen = new List<(string Command, bool Spare, int Held)>();
        using var server = new WorkerServer(0, args =>
        {
            // a delivery takes nothing of the cache; an apply takes the spare of its --base (JobRunner's acquire)
            var spare = args[0] == "apply" && cache.Take(args[2], File.ReadAllBytes(args[2])).Model is { Complete: true };
            lock (seen) seen.Add((args[0], spare, cache.Held));
            return new JsonObject { ["ok"] = true, ["command"] = args[0] };
        }, idle: cache.Worker);
        var run = server.RunAsync();
        try
        {
            Assert.True(Send(server.Port, ["ping"])["data"]!["warm"]!.GetValue<bool>());
            var watch = Stopwatch.StartNew();
            var warmed = Send(server.Port, [WorkerServer.IdleWork.WarmCommand, WarmRequest(a)]);
            Assert.True(warmed["ok"]!.GetValue<bool>(), warmed.ToJsonString());
            Assert.True(watch.ElapsedMilliseconds < 2000, "warm answered in " + watch.ElapsedMilliseconds + " ms");
            Assert.True(loading.Wait(TimeSpan.FromSeconds(10)), "the idle step prepares the warmed capture");

            watch.Restart();
            var delivered = Send(server.Port, ["deliver", "--job", "x"]);
            var ms = watch.ElapsedMilliseconds;
            Assert.True(delivered["ok"]!.GetValue<bool>());
            Assert.True(ms < loadMs - 500, "the delivery waited " + ms + " ms for a prefetch it does not use");
            lock (seen) Assert.Equal(("deliver", false, 0), seen.Single());  // nothing half-loaded was ever held
            Assert.Equal(1, cache.Stats()["cancels"]!.GetValue<long>());
            lock (released) Assert.Empty(released);                          // a cancelled load never became a spare

            // The idle step after the delivery prepares it again; an apply of it then takes a complete spare.
            var until = DateTime.UtcNow.AddSeconds(20);
            while (cache.Held == 0 && DateTime.UtcNow < until) Thread.Sleep(20);
            Assert.Equal(1, cache.Held);
            Assert.True(Send(server.Port, ["apply", "--base", a])["ok"]!.GetValue<bool>());
            lock (seen) Assert.Equal(("apply", true, 0), seen.Last());
        }
        finally { server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); }
    }

    [Fact]
    public void AnApplyOfTheModelBeingPreparedWaitsForThatPrefetchAloneNeverForOtherBases()
    {
        loadMs = 2000;
        var cache = Cache();
        var a = Capture("a", 1); var b = Capture("b", 2);
        var seen = new List<(bool Spare, int Held, long Prefetches)>();
        using var server = new WorkerServer(0, args =>
        {
            var spare = cache.Take(args[2], File.ReadAllBytes(args[2])).Model is { Complete: true };
            lock (seen) seen.Add((spare, cache.Held, cache.Stats()["prefetches"]!.GetValue<long>()));
            return new JsonObject { ["ok"] = true };
        }, idle: cache.Worker);
        var run = server.RunAsync();
        try
        {
            Send(server.Port, [WorkerServer.IdleWork.WarmCommand, WarmRequest(a, b)]);  // a first, then b
            Assert.True(loading.Wait(TimeSpan.FromSeconds(10)));
            var watch = Stopwatch.StartNew();
            var copy = Path.Combine(dir, "a-build.oml"); File.Copy(a, copy);
            Assert.True(Send(server.Port, ["apply", "--base", copy])["ok"]!.GetValue<bool>());
            var ms = watch.ElapsedMilliseconds;
            Assert.True(ms < 2 * loadMs - 300, "the apply waited " + ms + " ms: it waited for b's prefetch too");
            lock (seen) Assert.Equal((true, 0, 1L), seen.Single());        // a's complete spare; b not prepared before it ran
            Assert.Equal(0, cache.Stats()["cancels"]!.GetValue<long>());   // the prefetch it needed was never thrown away
        }
        finally { server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); }
    }

    [Fact]
    public void AWorkerWithoutTheWarmVerbLeavesItToItsHost()
    {
        var idle = new WorkerServer.IdleWork(_ => { }, _ => false, () => { }, TimeSpan.FromMinutes(1));
        using var server = new WorkerServer(0, args => new JsonObject { ["ok"] = false, ["command"] = args[0], ["error"] = "unknown command" }, idle: idle);
        var run = server.RunAsync();
        try
        {
            Assert.Null(Send(server.Port, ["ping"])["data"]!["warm"]);
            Assert.Equal("unknown command", Send(server.Port, [WorkerServer.IdleWork.WarmCommand, "{}"])["error"]!.ToString());
        }
        finally { server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); }
    }

    private static JsonObject Send(int port, string[] args)
    {
        using var client = new TcpClient("127.0.0.1", port);
        using var stream = client.GetStream();
        var line = new JsonObject { ["args"] = new JsonArray(args.Select(a => (JsonNode)a).ToArray()) }.ToJsonString() + "\n";
        stream.Write(Encoding.UTF8.GetBytes(line));
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return JsonNode.Parse(reader.ReadLine()!)!.AsObject();
    }
}
