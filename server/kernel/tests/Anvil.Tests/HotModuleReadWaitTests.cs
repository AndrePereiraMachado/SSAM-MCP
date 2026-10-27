using System.Diagnostics;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Hosting;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// S14 follow-up of L3b, without a Studio: a hot read that arrives while the worker prepares the spare of the SAME model waits
/// for that prefetch (at most <see cref="HotModuleRead.JoinWait"/>) and reads hot; a hot read of another model, or with a
/// command running, is refused at once and never stops the prefetch; past the cap the read is withdrawn (never run) and the
/// prefetch goes on; the read waits for that one prefetch only, never for the spares of other bases. The base cache over a fake
/// model whose load is slow and cancellable, served by a real <see cref="WorkerServer"/>; the ODC lane runs the same
/// (HotModuleReadWaitOdcTests).
/// </summary>
public sealed class HotModuleReadWaitTests : IDisposable
{
    private readonly HotModuleReadWaitScenarios scenarios = new();
    public void Dispose() => scenarios.Dispose();

    [Fact] public void AReadOfTheModelBeingPreparedWaitsForThatPrefetchAndReadsHot() => scenarios.AReadOfTheModelBeingPreparedWaitsForThatPrefetchAndReadsHot();
    [Fact] public void AReadOfAnotherModelIsRefusedAtOnceAndNeverStopsThePrefetch() => scenarios.AReadOfAnotherModelIsRefusedAtOnceAndNeverStopsThePrefetch();
    [Fact] public void PastTheCapTheReadIsWithdrawnAndThePrefetchGoesOn() => scenarios.PastTheCapTheReadIsWithdrawnAndThePrefetchGoesOn();
    [Fact] public void TheReadWaitsForItsOwnPrefetchAloneNeverForOtherBases() => scenarios.TheReadWaitsForItsOwnPrefetchAloneNeverForOtherBases();
}

internal sealed class HotModuleReadWaitScenarios : IDisposable
{
    private sealed class Model { public required byte[] Bytes { get; init; } public bool Complete { get; set; } }

    private readonly string dir = Path.Combine(Path.GetTempPath(), "anvil-hot-read-wait-tests", Guid.NewGuid().ToString("N"));
    private readonly ManualResetEventSlim loading = new();
    private readonly List<string> reads = new();
    private int loadMs, loads;

    public HotModuleReadWaitScenarios() => Directory.CreateDirectory(dir);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    private static readonly BaseCacheOptions Options = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };

    private BaseModelCache<Model> Cache() => new(Options, () => new BaseRuntime("test", "1.0", "studio", "kernel", "developerId=a"),
        (bytes, cancel) =>
        {
            Interlocked.Increment(ref loads); loading.Set();
            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < loadMs) { cancel.ThrowIfCancellationRequested(); Thread.Sleep(5); }
            return new Model { Bytes = bytes };
        },
        (model, cancel) => { cancel.ThrowIfCancellationRequested(); model.Complete = true; return 10; },
        _ => { }, null, null, () => 0, () => 0, () => { });

    private string Capture(string name, byte fill)
    {
        var path = Path.Combine(dir, name + ".oml");
        File.WriteAllBytes(path, Enumerable.Repeat(fill, 4000).ToArray());
        return path;
    }

    // The worker over this cache with a reader that reads its spare in place (the kernel's reader does the same over a model).
    private (WorkerServer Server, Task Run) Worker(BaseModelCache<Model> cache)
    {
        var server = new WorkerServer(0, args => new JsonObject { ["ok"] = true, ["command"] = args[0] }, idle: cache.Worker);
        HotModuleRead.ReaderOverride.Value = args =>
        {
            var file = JsonNode.Parse(args[1])!["file"]!.GetValue<string>();
            var hit = cache.TryRead(file, File.ReadAllBytes(file), model => Assert.True(model.Complete, "a hot read never sees an unfinished spare"), out _);
            lock (reads) reads.Add(Path.GetFileName(file) + (hit ? ":hot" : ":miss"));
            return hit ? new JsonObject { ["ok"] = true, ["command"] = HotModuleRead.Command, ["hot"] = new JsonObject { ["reused"] = true } }
                : new JsonObject { ["ok"] = false, ["command"] = HotModuleRead.Command, ["executed"] = false, ["code"] = "HOT_READ_MISS" };
        };
        try { return (server, server.RunAsync()); }
        finally { HotModuleRead.ReaderOverride.Value = null; }
    }

    private static string Warm(params string[] paths) => new JsonObject { ["captures"] = new JsonArray(paths.Select(p => (JsonNode)new JsonObject { ["path"] = p }).ToArray()) }.ToJsonString();
    private static string Read(string file) => new JsonObject { ["file"] = file, ["flowElements"] = new JsonArray("A") }.ToJsonString();

    public void AReadOfTheModelBeingPreparedWaitsForThatPrefetchAndReadsHot()
    {
        loadMs = 1500;
        var cache = Cache();
        var a = Capture("a", 1);
        var (server, run) = Worker(cache);
        try
        {
            Send(server.Port, [WorkerServer.IdleWork.WarmCommand, Warm(a)]);
            Assert.True(loading.Wait(TimeSpan.FromSeconds(10)));
            // another file of the same model (a new capture of an unchanged module)
            var copy = Path.Combine(dir, "a-again.oml"); File.Copy(a, copy);
            var watch = Stopwatch.StartNew();
            var answer = Send(server.Port, [HotModuleRead.Command, Read(copy)]);
            var ms = watch.ElapsedMilliseconds;
            Assert.True(answer["ok"]?.GetValue<bool>() == true, answer.ToJsonString());
            Assert.True(ms < loadMs + 1500, "the read waited " + ms + " ms");
            lock (reads) Assert.Equal(["a-again.oml:hot"], reads);
            Assert.Equal(0, cache.Stats()["cancels"]!.GetValue<long>());   // the prefetch it joined was never thrown away
            Assert.Equal(1, loads);
            Assert.Equal(1, cache.Held);                                    // read in place: the spare stays the next apply's
        }
        finally { server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); server.Dispose(); }
    }

    public void AReadOfAnotherModelIsRefusedAtOnceAndNeverStopsThePrefetch()
    {
        loadMs = 2500;
        var cache = Cache();
        var a = Capture("a", 1); var b = Capture("b", 2);
        var (server, run) = Worker(cache);
        try
        {
            Send(server.Port, [WorkerServer.IdleWork.WarmCommand, Warm(a)]);
            Assert.True(loading.Wait(TimeSpan.FromSeconds(10)));
            var watch = Stopwatch.StartNew();
            var refused = Send(server.Port, [HotModuleRead.Command, Read(b)]);
            Assert.True(watch.ElapsedMilliseconds < 1000, "refused in " + watch.ElapsedMilliseconds + " ms");
            Assert.Equal("WORKER_BUSY", refused["code"]?.ToString()); Assert.False(refused["executed"]!.GetValue<bool>());
            Assert.Contains("another model", refused["error"]!.ToString());
            var until = DateTime.UtcNow.AddSeconds(20);
            while (cache.Held == 0 && DateTime.UtcNow < until) Thread.Sleep(20);
            Assert.Equal(1, cache.Held);                                    // a's prefetch went on to the end
            Assert.Equal(0, cache.Stats()["cancels"]!.GetValue<long>()); Assert.Equal(1, loads);
            lock (reads) Assert.Empty(reads);
        }
        finally { server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); server.Dispose(); }
    }

    public void PastTheCapTheReadIsWithdrawnAndThePrefetchGoesOn()
    {
        loadMs = 2500;
        var cache = Cache();
        var a = Capture("a", 1);
        var previous = HotModuleRead.JoinWait;
        HotModuleRead.JoinWait = TimeSpan.FromMilliseconds(300);
        var (server, run) = Worker(cache);
        try
        {
            Send(server.Port, [WorkerServer.IdleWork.WarmCommand, Warm(a)]);
            Assert.True(loading.Wait(TimeSpan.FromSeconds(10)));
            var watch = Stopwatch.StartNew();
            var refused = Send(server.Port, [HotModuleRead.Command, Read(a)]);
            var ms = watch.ElapsedMilliseconds;
            Assert.Equal("WORKER_BUSY", refused["code"]?.ToString()); Assert.False(refused["executed"]!.GetValue<bool>());
            Assert.Contains("still being prepared", refused["error"]!.ToString());
            Assert.True(ms >= 250 && ms < 1500, "gave up after " + ms + " ms");
            var until = DateTime.UtcNow.AddSeconds(20);
            while (cache.Held == 0 && DateTime.UtcNow < until) Thread.Sleep(20);
            Assert.Equal(1, cache.Held); Assert.Equal(0, cache.Stats()["cancels"]!.GetValue<long>());
            lock (reads) Assert.Empty(reads);                               // the withdrawn read never ran
            until = DateTime.UtcNow.AddSeconds(10);
            while (Send(server.Port, ["ping"])["data"]!["idleWork"]!.GetValue<bool>() && DateTime.UtcNow < until) Thread.Sleep(20);
            Assert.True(Send(server.Port, [HotModuleRead.Command, Read(a)])["ok"]!.GetValue<bool>());   // the next one reads hot
            lock (reads) Assert.Equal(["a.oml:hot"], reads);
        }
        finally { HotModuleRead.JoinWait = previous; server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); server.Dispose(); }
    }

    public void TheReadWaitsForItsOwnPrefetchAloneNeverForOtherBases()
    {
        loadMs = 1500;
        var cache = Cache();
        var a = Capture("a", 1); var b = Capture("b", 2);
        var (server, run) = Worker(cache);
        try
        {
            Send(server.Port, [WorkerServer.IdleWork.WarmCommand, Warm(a, b)]);   // a first, then b
            Assert.True(loading.Wait(TimeSpan.FromSeconds(10)));
            var watch = Stopwatch.StartNew();
            Assert.True(Send(server.Port, [HotModuleRead.Command, Read(a)])["ok"]!.GetValue<bool>());
            var ms = watch.ElapsedMilliseconds;
            Assert.True(ms < 2 * loadMs - 300, "the read waited " + ms + " ms: it waited for b's prefetch too");
            Assert.Equal(1, cache.Stats()["prefetches"]!.GetValue<long>());   // b not prepared before the read ran
            var until = DateTime.UtcNow.AddSeconds(20);
            while (cache.Held < 2 && DateTime.UtcNow < until) Thread.Sleep(20);
            Assert.Equal(2, cache.Held);                                     // b next, after the read
        }
        finally { server.Stop(); run.Wait(TimeSpan.FromSeconds(10)); server.Dispose(); }
    }

    private static JsonObject Send(int port, string[] args)
    {
        using var client = new TcpClient("127.0.0.1", port);
        using var stream = client.GetStream();
        stream.Write(Encoding.UTF8.GetBytes(new JsonObject { ["args"] = new JsonArray(args.Select(a => (JsonNode)a).ToArray()) }.ToJsonString() + "\n"));
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return JsonNode.Parse(reader.ReadLine()!)!.AsObject();
    }
}
