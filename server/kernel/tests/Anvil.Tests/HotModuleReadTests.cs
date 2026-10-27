using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Hosting;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// S14 (leitura quente): the write worker answers a reader's request over the spare of the same model
/// (<see cref="HotModuleRead"/>, <see cref="BaseModelCache{TModel}.TryRead"/>). What must hold: ten reads answered hot are the
/// cold reader's answers to the same requests and write the same files (timings, cache counters and store root aside); the
/// spare read in place is still the capture afterwards; without a spare nothing runs; and the worker refuses a hot read at
/// once, never queued, while it is busy. The reads need the Service Studio (they return without it); the transport does not.
/// </summary>
public sealed class HotModuleReadTests(ITestOutputHelper output)
{
    private static readonly BaseCacheOptions Unbounded = BaseCacheOptions.Default with { Bytes = long.MaxValue, ShedHeapBytes = long.MaxValue, ShedWorkingSetBytes = long.MaxValue };
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HotModuleReadTests).Assembly.Location)!)!;
    private static readonly string Large = Path.Combine(Root, "tests", "fixtures", "hmisjha", "HMISJHA_CS-v5578.oml");

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string Work(string name)
    {
        var work = Path.Combine(Root, ".local", "test-work", "hot-module-read", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        return work;
    }

    [Fact]
    public void TenHotReadsAreTheColdReadsOfTheSameCapture()
    {
        if (!StudioAvailable() || !File.Exists(Large)) return;
        HotModuleReadScenarios.TenHotReadsAreTheColdReadsOfTheSameCapture(Work("equal"), Large, "o11", Unbounded, output.WriteLine);
    }

    [Fact]
    public void AHotReadWithoutASpareRunsNothing()
    {
        if (!StudioAvailable() || !File.Exists(Large)) return;
        HotModuleReadScenarios.AHotReadWithoutASpareRunsNothing(Work("miss"), Large, Unbounded);
    }

    [Fact]
    public void TheWorkerRefusesAHotReadAtOnceWhileBusyAndWithoutSpares() => HotModuleReadScenarios.TheWorkerRefusesAHotReadAtOnceWhileBusyAndWithoutSpares();
}

/// <summary>The scenarios of <see cref="HotModuleReadTests"/>; the ODC lane runs the same ones (HotModuleReadOdcTests).</summary>
internal static class HotModuleReadScenarios
{
    private static string Sha(byte[] bytes) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();

    // The spare a worker keeps after an apply on this capture: one small job applied through the cache (the base becomes
    // wanted), then the idle step that prepares it.
    public static BaseModelCache.Own SpareAfterAnApply(string work, string file, BaseCacheOptions options)
    {
        var cache = new BaseModelCache.Own(options);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject {
            ["ddl"] = "create entity S14HotReadProbe public (\nId Long Integer identifier auto required,\nLabel Text(50) required\n);" } }) }.ToJsonString());
        var host = new ModelHost(Path.Combine(work, "apply"));
        var result = BaseModelCache.Scoped(cache, () => JsonSerializer.SerializeToNode(JobRunner.Run(host, file, job, Path.Combine(work, "candidate.oml")))!.AsObject());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString()[..Math.Min(600, result.ToJsonString().Length)]);
        cache.Idle();
        Assert.Equal(1, cache.Held);
        return cache;
    }

    public static void TenHotReadsAreTheColdReadsOfTheSameCapture(string work, string capture, string lane, BaseCacheOptions options, Action<string> log)
    {
        var file = Path.Combine(work, "capture.oml");
        File.Copy(capture, file);
        var bytes = File.ReadAllBytes(file); var sha = Sha(bytes);
        var cache = SpareAfterAnApply(work, file, options);
        var coldRoot = Path.Combine(work, "cold-index"); var hotRoot = Path.Combine(work, "hot-index");
        var host = new ModelHost(Path.Combine(work, "reader"));
        // Cold: the read process's own cache over a fresh load (KernelSnapshotReading.Serve), in its own store.
        using var reader = new SnapshotReadCache(b => KernelSnapshotReading.Open(host, b), new ModuleIndexStore(coldRoot, lane, "kernel"));
        long coldMs = 0, hotMs = 0;
        var reads = 0;
        JsonObject Both(Action<JsonObject> set)
        {
            var request = new JsonObject { ["file"] = file, ["expectedSourceSha256"] = sha }; set(request);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var cold = reader.Read(request.DeepClone().AsObject());
            coldMs += clock.ElapsedMilliseconds; clock.Restart();
            var body = request.DeepClone().AsObject(); body["indexRoot"] = hotRoot;
            var hot = HotModuleRead.ServeFor(cache, [HotModuleRead.Command, body.ToJsonString()]);
            hotMs += clock.ElapsedMilliseconds;
            Assert.True(hot["ok"]?.GetValue<bool>() == true, hot.ToJsonString());
            Assert.True(hot["hot"]?["reused"]?.GetValue<bool>() == true);
            Assert.True(Same(cold, coldRoot, hot, hotRoot, out var why), "read " + reads + " " + request.ToJsonString() + ": " + why);
            reads++;
            return hot;
        }
        JsonNode List(params string[] names) => new JsonArray(names.Select(n => (JsonNode)n).ToArray());
        // 1: a selection that names no action answers the catalog of the module (the names of every action).
        var probe = Both(r => r["flowElements"] = List("S14NoSuchActionAnywhere"));
        var names = probe["flowSelection"]!["catalog"]!.AsArray().Select(a => a!["name"]!.ToString()).Distinct().ToList();
        Assert.True(names.Count >= 20, "actions: " + names.Count);
        string Pick(int i) => names[(int)((i + 0.5) * names.Count / 9)];
        Both(r => r["index"] = "ensure");
        Both(r => r["flowElements"] = List(Pick(0), Pick(1)));
        Both(r => r["flowElements"] = List(Pick(2), Pick(3)));
        Both(r => r["flowElements"] = List(Pick(4)));
        Both(r => r["flowElements"] = List(Pick(5), Pick(6), Pick(7)));
        Both(r => r["signatureElements"] = List(Pick(0), Pick(8)));
        Both(r => r["digest"] = "ensure");
        Both(r => r["ddl"] = "ensure");
        Both(r => r["html"] = "");
        Both(r => r["flow"] = "ensure");
        Assert.Equal(11, reads);
        log($"{lane} {Path.GetFileName(capture)}: {reads} reads cold {coldMs} ms (one load), hot {hotMs} ms over the spare");
        // The same files, with the same contents (their creation times aside).
        var coldFiles = Files(coldRoot); var hotFiles = Files(hotRoot);
        Assert.Equal(coldFiles.Keys.Order(StringComparer.Ordinal), hotFiles.Keys.Order(StringComparer.Ordinal));
        foreach (var (name, text) in coldFiles) Assert.True(Normalized(text, coldRoot) == Normalized(hotFiles[name], hotRoot), "stored file " + name + " differs");
        // The digest carries its extractor in its name (T12, ModuleIndexStore.DigestSuffix; integ/proto-into-product).
        foreach (var kind in new[] { ".kernel.json", ".kernel" + ModuleIndexStore.DigestSuffix, ".kernel.ddl.json", ".kernel.flow.json" })
            Assert.True(coldFiles.Keys.Any(k => k.EndsWith(kind, StringComparison.Ordinal)), "not stored: " + kind + " (stored: " + string.Join(", ", coldFiles.Keys) + ")");
        // The spare was read in place, never taken, and is still the capture.
        Assert.Equal(1, cache.Held);
        Assert.Equal((long)reads, cache.Stats()["reads"]!.GetValue<long>());
        var (spare, fresh) = cache.Shapes(file, bytes, host);
        Assert.NotNull(spare);
        Assert.Equal(fresh, spare);
    }

    public static void AHotReadWithoutASpareRunsNothing(string work, string capture, BaseCacheOptions options)
    {
        var file = Path.Combine(work, "capture.oml");
        File.Copy(capture, file);
        var bytes = File.ReadAllBytes(file);
        var request = new JsonObject { ["file"] = file, ["expectedSourceSha256"] = Sha(bytes), ["digest"] = "ensure", ["indexRoot"] = Path.Combine(work, "index") }.ToJsonString();
        var cache = new BaseModelCache.Own(options);
        var miss = HotModuleRead.ServeFor(cache, [HotModuleRead.Command, request]);
        Assert.False(miss["ok"]!.GetValue<bool>()); Assert.False(miss["executed"]!.GetValue<bool>());
        Assert.Equal("HOT_READ_MISS", miss["code"]!.ToString());
        var none = HotModuleRead.ServeFor(null, [HotModuleRead.Command, request]);
        Assert.Equal("HOT_READ_MISS", none["code"]!.ToString());
        Assert.False(Directory.Exists(Path.Combine(work, "index")), "a miss writes nothing");
        Assert.Equal(0L, cache.Stats()["reads"]!.GetValue<long>());
    }

    public static void TheWorkerRefusesAHotReadAtOnceWhileBusyAndWithoutSpares()
    {
        using var release = new ManualResetEventSlim();
        var executed = new List<string>();
        var idle = new WorkerServer.IdleWork(_ => { }, _ => false, () => { }, TimeSpan.FromMinutes(1));
        using var server = new WorkerServer(0, args => { lock (executed) executed.Add(args[0]); if (args[0] == "slow") release.Wait(TimeSpan.FromSeconds(20)); return new JsonObject { ["ok"] = true }; }, idle: idle);
        var run = server.RunAsync();
        Assert.True(Status(server.Port)["hotRead"]?.GetValue<bool>() == true);
        var slow = Task.Run(() => Send(server.Port, ["slow"]));
        var until = DateTime.UtcNow.AddSeconds(10);
        while (Status(server.Port)["busy"]?.GetValue<bool>() != true && DateTime.UtcNow < until) Thread.Sleep(20);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var busy = Send(server.Port, [HotModuleRead.Command, "{}"]);
        Assert.True(watch.ElapsedMilliseconds < 2000, "refused in " + watch.ElapsedMilliseconds + " ms");
        Assert.Equal("WORKER_BUSY", busy["code"]?.ToString()); Assert.False(busy["executed"]!.GetValue<bool>());
        release.Set(); slow.Wait(TimeSpan.FromSeconds(20));
        lock (executed) Assert.DoesNotContain(HotModuleRead.Command, executed);
        server.Stop(); run.Wait(TimeSpan.FromSeconds(10));

        // A worker without spares (the read process: no idle work) never runs one and does not say it can.
        using var reader = new WorkerServer(0, args => { lock (executed) executed.Add("reader:" + args[0]); return new JsonObject { ["ok"] = true }; });
        var readerRun = reader.RunAsync();
        Assert.Null(Status(reader.Port)["hotRead"]);
        var refused = Send(reader.Port, [HotModuleRead.Command, "{}"]);
        Assert.Equal("WORKER_BUSY", refused["code"]?.ToString()); Assert.Contains("no spare", refused["error"]!.ToString());
        lock (executed) Assert.DoesNotContain("reader:" + HotModuleRead.Command, executed);
        reader.Stop(); readerRun.Wait(TimeSpan.FromSeconds(10));
    }

    private static JsonObject Status(int port) => Send(port, ["ping"])["data"]!.AsObject();

    private static JsonObject Send(int port, string[] args)
    {
        using var client = new TcpClient("127.0.0.1", port);
        using var stream = client.GetStream();
        var line = new JsonObject { ["args"] = new JsonArray(args.Select(a => (JsonNode)a).ToArray()) }.ToJsonString() + "\n";
        stream.Write(Encoding.UTF8.GetBytes(line));
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return JsonNode.Parse(reader.ReadLine()!)!.AsObject();
    }

    // An answer without what differs by process and run: its timings, its cache counters, the hot receipt, the queue time,
    // creation times; the store root of each side named alike.
    private static bool Same(JsonObject cold, string coldRoot, JsonObject hot, string hotRoot, out string why)
    {
        var a = Normalized(cold.ToJsonString(), coldRoot); var b = Normalized(hot.ToJsonString(), hotRoot);
        why = a == b ? "" : "cold " + a[..Math.Min(400, a.Length)] + " / hot " + b[..Math.Min(400, b.Length)];
        return a == b;
    }

    private static string Normalized(string json, string root)
    {
        string text;
        try { var node = JsonNode.Parse(json)!; Strip(node); text = node.ToJsonString(); }
        catch (JsonException) { text = json; }
        return text.Replace(JsonSerializer.Serialize(Path.GetFullPath(root))[1..^1], "<root>", StringComparison.OrdinalIgnoreCase);
    }

    private static void Strip(JsonNode? node)
    {
        if (node is JsonObject o)
        {
            foreach (var key in o.Select(p => p.Key).Where(k => k is "timings" or "cache" or "hot" or "queuedMs" or "createdAt").ToList()) o.Remove(key);
            foreach (var p in o) Strip(p.Value);
        }
        else if (node is JsonArray a) foreach (var item in a) Strip(item);
    }

    private static Dictionary<string, string> Files(string root) => Directory.Exists(root)
        ? Directory.GetFiles(root, "*", SearchOption.AllDirectories).ToDictionary(f => Path.GetRelativePath(root, f), File.ReadAllText, StringComparer.Ordinal)
        : new();
}
