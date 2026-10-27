using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core.Hosting;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>Identity of a base OML as this process would load it: the file (full path, length, write time), its bytes
/// (sha256, recomputed at every acquire, so an in-place rewrite always misses) and what else shapes the loaded instance
/// (<see cref="BaseRuntime"/>).</summary>
public sealed record BaseKey(string Path, long Length, DateTime MtimeUtc, string Sha256, string Platform, string IdeVersion,
    string StudioDirectory, string KernelSha256, string LoadProfile)
{
    public string Short => (ContentSha256 ?? ModelSha256 ?? Sha256) is var id && id.Length > 16 ? id[..16] : id;

    /// <summary>B2 (C02): the content identity of the capture (`--base-content-sha256`, the facade's contentSha256: the sha256
    /// with the header's volatile fields masked). Two captures of an unchanged module differ in bytes but not in content;
    /// with it on both sides a spare is taken by content and runtime, whatever its file.</summary>
    public string? ContentSha256 { get; init; }

    /// <summary>R3 (módulo quente): the model identity of the bytes, read here (<see cref="BaseModelCache.ModelSha256"/>: the
    /// sha256 after the OML's textual header, the rule of PrebuiltCandidate and of the facade's capture store). The build
    /// phase copies a known capture to a new file for every build: the same model under another path and time.</summary>
    public string? ModelSha256 { get; init; }

    /// <summary>The spare of <paramref name="other"/> serves this request: the same runtime and the same content when both
    /// keys carry a content identity, else the same model when both carry one (any file), else the same file, bytes and
    /// runtime (as before).</summary>
    public bool Serves(BaseKey other)
    {
        var runtime = Platform == other.Platform && IdeVersion == other.IdeVersion && StudioDirectory == other.StudioDirectory
            && KernelSha256 == other.KernelSha256 && LoadProfile == other.LoadProfile;
        if (ContentSha256 != null && other.ContentSha256 != null) return runtime && string.Equals(ContentSha256, other.ContentSha256, StringComparison.OrdinalIgnoreCase);
        if (ModelSha256 != null && other.ModelSha256 != null) return runtime && string.Equals(ModelSha256, other.ModelSha256, StringComparison.OrdinalIgnoreCase);
        return this == other;
    }
}

/// <summary>Studio, kernel (the hash JobProvenance stamps) and load parameters of this process.</summary>
public sealed record BaseRuntime(string Platform, string IdeVersion, string StudioDirectory, string KernelSha256, string LoadProfile);

/// <summary>Limits of the worker's base cache. Spares are given back above <see cref="ShedHeapBytes"/> of live GC heap or
/// <see cref="ShedWorkingSetBytes"/> of working set, below the worker's own recycle (2 GB heap on two commands) and the
/// pool's (2.5 GB working set). R3 (módulo quente): three modules, kept 30 minutes without a use.</summary>
public sealed record BaseCacheOptions(int Entries, long Bytes, TimeSpan Expiry, long ShedHeapBytes, long ShedWorkingSetBytes)
{
    public static readonly BaseCacheOptions Default = new(3, 1024L << 20, TimeSpan.FromMinutes(30), 1536L << 20, 2048L << 20);

    /// <summary>ANVIL_BASE_CACHE_ENTRIES, ANVIL_BASE_CACHE_MB and ANVIL_BASE_CACHE_IDLE_MINUTES tune it; ANVIL_BASE_CACHE=off
    /// (null here) is the operator's emergency switch, read from the worker's own environment, not a user option.</summary>
    public static BaseCacheOptions? FromEnvironment(Func<string, string?> env)
    {
        if (string.Equals(env("ANVIL_BASE_CACHE")?.Trim(), "off", StringComparison.OrdinalIgnoreCase)) return null;
        return Default with
        {
            Entries = int.TryParse(env("ANVIL_BASE_CACHE_ENTRIES"), out var entries) && entries > 0 ? entries : Default.Entries,
            Bytes = long.TryParse(env("ANVIL_BASE_CACHE_MB"), out var mb) && mb > 0 ? mb << 20 : Default.Bytes,
            Expiry = double.TryParse(env("ANVIL_BASE_CACHE_IDLE_MINUTES"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var minutes)
                && minutes > 0 && minutes < 24 * 60 ? TimeSpan.FromMinutes(minutes) : Default.Expiry,
        };
    }
}

/// <summary>
/// Spare base models of a resident worker (tier 1, 'spare'). While the worker's queue is empty its dispatch thread loads a
/// fresh instance of the last used base(s) and walks it once (<see cref="Idle"/>); the next job whose <see cref="BaseKey"/>
/// matches TAKES it (<see cref="Take"/>), uses it once and releases it exactly like a model it loaded itself. An instance
/// handed to a job never comes back, so no job sees what another did. Every member runs on the dispatch thread, except
/// <see cref="Stats"/>, <see cref="Held"/> and <see cref="Serves"/>, which only read.
/// </summary>
public sealed class BaseModelCache<TModel> where TModel : class
{
    /// <summary>What <see cref="Take"/> hands over: the spare (null = miss, the caller loads as always) and the receipt
    /// that goes into the apply result as `baseCache`.</summary>
    public sealed record Taken(TModel? Model, long AcquireMs, JsonObject Receipt);

    private sealed record Entry(BaseKey Key, TModel Model, long Bytes, long LoadMs, long WalkMs, int Objects, DateTime ReadyUtc);

    private readonly BaseCacheOptions options;
    private readonly Func<BaseRuntime> runtime;
    private readonly Func<byte[], CancellationToken, TModel> load;
    private readonly Func<TModel, CancellationToken, int> walk;
    private readonly Action<TModel> release;
    private readonly Action<string>? log;
    private readonly Func<DateTime> clock;
    private readonly Func<long> heap, workingSet;
    private readonly Action collect;
    private readonly object gate = new();
    private readonly List<Entry> entries = new();
    // Most recent first, at most Entries. Context: the execution context of the request that wanted the base. The idle step
    // prepares the spare inside it, so the load and the key see what the request saw: its author (OdcRuntime.WithDeveloperId,
    // carried by LoadProfile) and its content hint. On the dispatch thread alone they are the process's own, the key never
    // equals the request's and no request with --developer-id ever found a spare (offline replay of the friend's labs 27
    // and 40, 2026-10-07: hit:false on all six applies of a resident worker).
    private readonly List<(BaseKey Key, DateTime UsedUtc, ExecutionContext? Context)> wants = new();
    private readonly Dictionary<string, string> dropped = new(StringComparer.OrdinalIgnoreCase); // path -> why its spare went
    private readonly Dictionary<string, int> evictedBy = new(StringComparer.Ordinal);
    private long hits, misses, prefetches, cancels, failures, reads, remembered;
    private volatile string? warming, warmingModel;
    // L3b: a queued request joined the prefetch in course (Serves said it needs it): the idle step stops after that one, so the
    // request never waits for the spares of other bases too.
    private volatile bool joined;

    public BaseModelCache(BaseCacheOptions options, Func<BaseRuntime> runtime, Func<byte[], CancellationToken, TModel> load,
        Func<TModel, CancellationToken, int> walk, Action<TModel> release, Action<string>? log = null, Func<DateTime>? clock = null,
        Func<long>? heap = null, Func<long>? workingSet = null, Action? collect = null)
    {
        this.options = options; this.runtime = runtime; this.load = load; this.walk = walk; this.release = release; this.log = log;
        this.clock = clock ?? (() => DateTime.UtcNow);
        this.heap = heap ?? (() => GC.GetTotalMemory(false));
        this.workingSet = workingSet ?? (() => Environment.WorkingSet);
        this.collect = collect ?? (() => { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); });
    }

    /// <summary>The worker's hook: prefetch while idle, let a request for the base being prepared wait for it, give the
    /// spares back before the heap recycle rule; L3b: `warm` names the captures to prepare next (<see cref="Warm"/>).</summary>
    public WorkerServer.IdleWork Worker => new(Idle, Serves, Shed, TimeSpan.FromMinutes(1)) { Warm = Warm };

    /// <summary>Spares ready now (the loaded modules that are not a leak).</summary>
    public int Held { get { lock (gate) return entries.Count; } }

    /// <summary>The spare of exactly this base, removed from the cache. Either way the base becomes the one the idle step
    /// prepares next, unless <paramref name="reusable"/> is false (a base this run built from a `job:`, never seen again).
    /// <paramref name="contentSha256"/> (else the request's <see cref="BaseModelCache.WithContent{T}"/>): the capture's content
    /// identity, so a spare of another capture of the same content is taken (<see cref="BaseKey.Serves"/>).</summary>
    public Taken Take(string path, byte[] bytes, bool reusable = true, string? contentSha256 = null)
    {
        var sw = Stopwatch.StartNew();
        if (!reusable) return new(null, 0, Receipt(false, null, 0, null, null, "base built by this run (job:)"));
        BaseKey key;
        try { key = KeyOf(path, bytes) with { ContentSha256 = contentSha256 ?? BaseModelCache.ContentOf(path) }; }
        catch (Exception ex)
        {
            log?.Invoke("base cache: no key for " + path + ": " + ex.Message);
            return new(null, sw.ElapsedMilliseconds, Receipt(false, null, sw.ElapsedMilliseconds, null, null, "no key: " + ex.GetType().Name));
        }
        Entry? spare;
        List<Entry> stale;
        string? why;
        lock (gate)
        {
            spare = entries.FirstOrDefault(e => key.Serves(e.Key));
            if (spare != null) { entries.Remove(spare); hits++; }
            else misses++;
            // Same file, other bytes or runtime: that spare can never be taken again.
            stale = entries.Where(e => SameFile(e.Key, key)).ToList();
            foreach (var e in stale) { entries.Remove(e); Count("changed"); }
            why = Recall(key);
            why = spare != null ? null : stale.Count > 0 ? "changed" : why;
            Use(key);
        }
        foreach (var e in stale) Release(e.Model, e.Key, "changed");
        var ms = sw.ElapsedMilliseconds;
        return new(spare?.Model, ms, Receipt(spare != null, key, ms, spare, why, null));
    }

    /// <summary>S14 (leitura quente): runs <paramref name="read"/> over the spare of these bytes' model (<see cref="BaseKey.Serves"/>)
    /// in place, on the dispatch thread: the spare is never taken and stays the next apply's. Only for reads that change
    /// nothing in the model (the snapshot reader's); false, with nothing run, when no spare serves these bytes.</summary>
    public bool TryRead(string path, byte[] bytes, Action<TModel> read, out JsonObject receipt)
    {
        var sw = Stopwatch.StartNew();
        BaseKey key;
        try { key = KeyOf(path, bytes); }
        catch (Exception ex) { receipt = Receipt(false, null, sw.ElapsedMilliseconds, null, null, "no key: " + ex.GetType().Name); return false; }
        Entry? spare;
        lock (gate) spare = entries.FirstOrDefault(e => key.Serves(e.Key));
        if (spare == null) { receipt = Receipt(false, key, sw.ElapsedMilliseconds, null, null, "no spare of this model"); return false; }
        read(spare.Model);
        lock (gate) reads++;
        receipt = Receipt(true, key, sw.ElapsedMilliseconds, spare, null, null);
        return true;
    }

    /// <summary>L3b (spare pós-merge, pré-aquecimento): the capture at <paramref name="path"/> becomes the base this worker
    /// prepares next, as if an apply had just taken it: the most recent want, prepared by the idle step after the current
    /// command (cancellable and invalidated like any other). <paramref name="supersedes"/>: a capture of the same module before
    /// a merge; its model is no longer the module, so it is not prepared again and its spare, if one is held, goes ("merged").
    /// On the dispatch thread. Answers what was wanted and whether a spare of it is already held.</summary>
    public JsonObject Remember(string path, string? supersedes = null, string? contentSha256 = null)
    {
        BaseKey key;
        string? old = null;
        try
        {
            key = KeyOf(path, File.ReadAllBytes(path)) with { ContentSha256 = string.IsNullOrWhiteSpace(contentSha256) ? null : contentSha256.Trim().ToLowerInvariant() };
            if (!string.IsNullOrWhiteSpace(supersedes) && File.Exists(supersedes)) old = BaseModelCache.ModelSha256(File.ReadAllBytes(supersedes));
        }
        catch (Exception ex) { return new JsonObject { ["wanted"] = false, ["file"] = path, ["reason"] = "no key: " + ex.GetType().Name }; }
        if (string.Equals(old, key.ModelSha256, StringComparison.OrdinalIgnoreCase)) old = null;   // nothing merged: the same model
        List<Entry> gone;
        bool ready;
        lock (gate)
        {
            gone = old == null ? new() : entries.Where(e => string.Equals(e.Key.ModelSha256, old, StringComparison.OrdinalIgnoreCase)).ToList();
            if (old != null) wants.RemoveAll(w => string.Equals(w.Key.ModelSha256, old, StringComparison.OrdinalIgnoreCase));
            foreach (var e in gone) { entries.Remove(e); Count("merged"); Forget(e.Key, "merged"); }
            Use(key);
            ready = entries.Any(e => key.Serves(e.Key));
            remembered++;
        }
        foreach (var e in gone) Release(e.Model, e.Key, "merged");
        log?.Invoke($"base cache: {Path.GetFileName(key.Path)} {key.Short} wanted next ({(ready ? "spare held" : "prepared while idle")}{(old != null ? ", supersedes " + old[..16] : "")})");
        return new JsonObject { ["wanted"] = true, ["file"] = key.Path, ["key"] = key.Short, ["modelSha256"] = key.ModelSha256, ["ready"] = ready,
            ["superseded"] = old, ["releasedSpares"] = gone.Count };
    }

    /// <summary>L3b: the worker's `warm` command. One JSON request {captures:[{path, contentSha256?, supersedes?}], developerId?}:
    /// each capture that exists is remembered (<see cref="Remember"/>), the first one last, so it is the first prepared; at most
    /// the cache's entries. developerId: the author the spares are loaded for (the ODC worker keys its spares by it); null, the
    /// process's own. Nothing is loaded here: the idle step after this command prepares them, cancellable as always.</summary>
    public JsonObject Warm(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("warm takes one request: {captures:[{path, contentSha256?, supersedes?}], developerId?}");
        var request = JsonNode.Parse(args[1]) as JsonObject ?? throw new ArgumentException("the warm request must be an object");
        var captures = (request["captures"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Take(options.Entries).ToList();
        var developer = request["developerId"]?.GetValue<string>();
        var answers = new JsonNode?[captures.Count];
        for (var i = captures.Count - 1; i >= 0; i--)
        {
            var path = captures[i]["path"]?.GetValue<string>();
            answers[i] = string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || !File.Exists(path)
                ? new JsonObject { ["wanted"] = false, ["file"] = path, ["reason"] = "missing (an absolute path of an existing capture)" }
                : BaseModelCache.AsAuthor(developer, () => Remember(path, captures[i]["supersedes"]?.GetValue<string>(), captures[i]["contentSha256"]?.GetValue<string>()));
        }
        return new JsonObject { ["ok"] = true, ["command"] = WorkerServer.IdleWork.WarmCommand, ["elapsedMs"] = 0, ["data"] = new JsonObject
        {
            ["wanted"] = new JsonArray(answers), ["held"] = Held, ["limitEntries"] = options.Entries,
        } };
    }

    /// <summary>The idle step: expire, give memory back under pressure, then load and walk a fresh instance of each wanted
    /// base that has no spare. A cancelled prefetch releases what it had loaded and is retried at the next idle step. L3b: a
    /// request that joined a prefetch (<see cref="Serves"/>) ends the step after it.</summary>
    public void Idle(CancellationToken cancel)
    {
        joined = false;
        Expire();
        if (GiveBack()) return;
        while (!cancel.IsCancellationRequested && !joined)
        {
            BaseKey? next; ExecutionContext? context;
            lock (gate) { (next, _, context) = wants.FirstOrDefault(w => entries.All(e => !w.Key.Serves(e.Key))); }
            if (next is not { } want) return;
            if (context == null) Prefetch(want, cancel);
            else ExecutionContext.Run(context, _ => Prefetch(want, cancel), null);
        }
    }

    /// <summary>A request queued during a prefetch waits for it when it is an apply of the base being prepared (its file, or
    /// R3 another file of the same model: the build phase's next copy of the capture); any other request cancels it. L3b: a
    /// `warm` (it only names what to prepare next) lets the prefetch finish too; whoever waits, waits for this prefetch alone.
    /// A `hot-read` of the model being prepared waits for it as an apply does.</summary>
    public bool Serves(string[] args)
    {
        var preparing = warming;
        if (preparing == null) return false;
        bool serves;
        try
        {
            if (args.Length > 0 && args[0] == WorkerServer.IdleWork.WarmCommand) serves = true;
            // S14/L3b: a hot read of the model being prepared waits for that prefetch (WorkerServer caps the wait).
            else if (args.Length == 2 && args[0] == HotModuleRead.Command)
                serves = warmingModel is { } model && JsonNode.Parse(args[1])?["file"]?.GetValue<string>() is { } file && File.Exists(file)
                    && BaseModelCache.ModelSha256(File.ReadAllBytes(file)) == model;
            else if (BasePathOf(args) is not { } path) serves = false;
            else if (string.Equals(Path.GetFullPath(path), preparing, StringComparison.OrdinalIgnoreCase)) serves = true;
            else serves = warmingModel is { } model && File.Exists(path) && BaseModelCache.ModelSha256(File.ReadAllBytes(path)) == model;
        }
        catch { serves = false; }
        if (serves) joined = true;
        return serves;
    }

    /// <summary>After each command, before the worker's heap rule: spares go first when memory nears the recycle limits.</summary>
    public void Shed()
    {
        if (Held > 0) GiveBack();
    }

    public JsonObject Stats()
    {
        lock (gate)
            return new JsonObject
            {
                ["mode"] = "spare", ["entries"] = entries.Count,
                ["keys"] = new JsonArray(entries.Select(e => (JsonNode?)e.Key.Short).ToArray()),
                ["warming"] = new JsonArray(wants.Where(w => entries.All(e => !w.Key.Serves(e.Key))).Select(w => (JsonNode?)w.Key.Short).ToArray()),
                ["bytes"] = entries.Sum(e => e.Bytes), ["mb"] = entries.Sum(e => e.Bytes) >> 20,
                ["limitEntries"] = options.Entries, ["limitMB"] = options.Bytes >> 20,
                ["hits"] = hits, ["misses"] = misses, ["prefetches"] = prefetches, ["cancels"] = cancels, ["failures"] = failures, ["reads"] = reads, ["remembered"] = remembered,
                ["evictions"] = evictedBy.Values.Sum(),
                ["evictedBy"] = new JsonObject(evictedBy.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            };
    }

    /// <summary>The base an `apply` request would load: --base, else the job's own `base` fixture; null for `job:` bases,
    /// bindings and anything else.</summary>
    public static string? BasePathOf(string[] args)
    {
        if (args.Length == 0 || args[0] != "apply") return null;
        var explicitBase = Array.IndexOf(args, "--base");
        if (explicitBase >= 0 && explicitBase + 1 < args.Length) return args[explicitBase + 1];
        var job = Array.IndexOf(args, "--job");
        if (job < 0 || job + 1 >= args.Length) return null;
        var jobPath = Path.GetFullPath(args[job + 1]);
        var spec = JsonNode.Parse(File.ReadAllText(jobPath)) is JsonObject o ? o["base"]?.GetValue<string>() : null;
        spec ??= "tests/fixtures/blank-service.oml";
        // A name (fix/system-reference round 2: anything but .oml, .avsig or job:) is a binding, never a file to warm.
        if (spec.StartsWith("job:", StringComparison.Ordinal) || !JobSources.IsPathSpec(spec)) return null;
        return JobSources.FixturePath(spec, Path.GetDirectoryName(jobPath)!, "base");
    }

    private void Prefetch(BaseKey want, CancellationToken cancel)
    {
        TModel? model = null;
        warming = want.Path; warmingModel = want.ModelSha256;
        try
        {
            if (!File.Exists(want.Path)) { Drop(want, "missing"); return; }
            var bytes = File.ReadAllBytes(want.Path);
            var key = KeyOf(want.Path, bytes) with { ContentSha256 = want.ContentSha256 };
            if (!want.Serves(key)) { Drop(want, "changed"); return; }
            var floor = 25L * bytes.Length;    // measured: 16-40x the OML size once walked
            if (!MakeRoom(floor, want)) { Drop(want, "budget"); return; }
            var before = heap();
            var sw = Stopwatch.StartNew();
            model = load(bytes, cancel);
            var loadMs = sw.ElapsedMilliseconds;
            var objects = walk(model, cancel);
            var entry = new Entry(key, model, Math.Max(heap() - before, floor), loadMs, sw.ElapsedMilliseconds - loadMs, objects, clock());
            model = null;
            lock (gate) { entries.Add(entry); prefetches++; }
            log?.Invoke($"base cache: spare of {Path.GetFileName(key.Path)} {key.Short} ready (load {entry.LoadMs} ms, walk {entry.WalkMs} ms, {objects} objects, ~{entry.Bytes >> 20} MB)");
            if (!MakeRoom(0, want)) { Evict(entry, "budget"); Drop(want, "budget"); }
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            lock (gate) cancels++;
            log?.Invoke($"base cache: prefetch of {Path.GetFileName(want.Path)} {want.Short} cancelled (a request that does not use it arrived)");
        }
        catch (Exception ex)
        {
            lock (gate) failures++;
            Drop(want, "failed: " + ex.GetType().Name);
            log?.Invoke($"base cache: prefetch of {Path.GetFileName(want.Path)} failed, not retried: {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            warming = null; warmingModel = null;
            if (model != null) Release(model, want, null);
        }
    }

    private void Use(BaseKey key)
    {
        // One want per file, and per content or model (a new capture of the same model replaces the old).
        wants.RemoveAll(w => SameFile(w.Key, key) || key.Serves(w.Key));
        wants.Insert(0, (key, clock(), ExecutionContext.Capture()));
        if (wants.Count > options.Entries) wants.RemoveRange(options.Entries, wants.Count - options.Entries);
    }

    /// <summary>Wants unused for longer than the expiry go; spares whose base is no longer wanted go with them.</summary>
    private void Expire()
    {
        var now = clock();
        List<(Entry Entry, string Why)> victims;
        lock (gate)
        {
            var expired = wants.Where(w => now - w.UsedUtc > options.Expiry).Select(w => w.Key).ToList();
            wants.RemoveAll(w => expired.Contains(w.Key));
            foreach (var key in expired) Forget(key, "idle");
            victims = entries.Where(e => wants.All(w => !w.Key.Serves(e.Key))).Select(e => (e, expired.Any(x => x.Serves(e.Key)) ? "idle" : "lru")).ToList();
        }
        foreach (var (entry, why) in victims) Evict(entry, why);
    }

    /// <summary>Evicts spares of bases used less recently than <paramref name="keep"/>, least recent first, until
    /// <paramref name="extra"/> more bytes fit in the budget; false when they still do not.</summary>
    private bool MakeRoom(long extra, BaseKey keep)
    {
        while (true)
        {
            Entry? victim;
            lock (gate)
            {
                if (entries.Sum(e => e.Bytes) + extra <= options.Bytes) return true;
                int Recency(BaseKey key) { var i = wants.FindIndex(w => w.Key.Serves(key)); return i < 0 ? int.MaxValue : i; }
                var mine = Recency(keep);
                victim = entries.Where(e => e.Key != keep && Recency(e.Key) > mine).OrderByDescending(e => Recency(e.Key)).FirstOrDefault();
            }
            if (victim == null) return false;
            Evict(victim, "budget");
        }
    }

    /// <summary>True under memory pressure: the spares went (garbage is collected first, so only live memory counts).</summary>
    private bool GiveBack()
    {
        if (heap() <= options.ShedHeapBytes && workingSet() <= options.ShedWorkingSetBytes) return false;
        collect();
        if (heap() <= options.ShedHeapBytes && workingSet() <= options.ShedWorkingSetBytes) return false;
        List<Entry> victims;
        lock (gate) victims = entries.ToList();
        foreach (var entry in victims) Evict(entry, "memory");
        if (victims.Count > 0) collect();
        return true;
    }

    private void Evict(Entry entry, string why)
    {
        lock (gate)
        {
            if (!entries.Remove(entry)) return;
            Count(why);
            Forget(entry.Key, why);
        }
        Release(entry.Model, entry.Key, why);
    }

    private void Drop(BaseKey want, string why)
    {
        lock (gate)
        {
            wants.RemoveAll(w => w.Key == want);
            Forget(want, why);
        }
    }

    private void Count(string why) => evictedBy[why] = evictedBy.GetValueOrDefault(why) + 1;

    /// <summary>Why the spare of this base went, under its file and its model (a later capture of the same model is another
    /// file); <see cref="Recall"/> takes it back once. Under the gate.</summary>
    private void Forget(BaseKey key, string why)
    {
        dropped[key.Path] = why;
        if (Identity(key) is { } id) dropped[id] = why;
    }

    private string? Recall(BaseKey key)
    {
        string? why = null;
        if (Identity(key) is { } id && dropped.Remove(id, out var byModel)) why = byModel;
        if (dropped.Remove(key.Path, out var byFile)) why ??= byFile;
        return why;
    }

    private static string? Identity(BaseKey key) => key.ContentSha256 != null ? "content:" + key.ContentSha256 : key.ModelSha256 != null ? "model:" + key.ModelSha256 : null;

    private void Release(TModel model, BaseKey key, string? why)
    {
        try { release(model); }
        catch (Exception ex) { log?.Invoke($"base cache: release of {key.Short} failed: {ex.GetType().Name}: {ex.Message}"); }
        if (why != null) log?.Invoke($"base cache: spare of {Path.GetFileName(key.Path)} {key.Short} evicted ({why})");
    }

    private BaseKey KeyOf(string path, byte[] bytes)
    {
        var full = Path.GetFullPath(path);
        var file = new FileInfo(full);
        var r = runtime();
        return new BaseKey(full, file.Length, file.LastWriteTimeUtc, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            r.Platform, r.IdeVersion, r.StudioDirectory, r.KernelSha256, r.LoadProfile) { ModelSha256 = BaseModelCache.ModelSha256(bytes) };
    }

    private static bool SameFile(BaseKey a, BaseKey b) => string.Equals(a.Path, b.Path, StringComparison.OrdinalIgnoreCase);

    private JsonObject Receipt(bool hit, BaseKey? key, long ms, Entry? spare, string? evicted, string? skipped)
    {
        var receipt = new JsonObject
        {
            ["mode"] = "spare", ["hit"] = hit, ["key"] = key?.Short, ["modelSha256"] = key?.ModelSha256, ["acquireMs"] = ms,
            ["prefetch"] = spare == null ? null : new JsonObject
            {
                ["loadMs"] = spare.LoadMs, ["walkMs"] = spare.WalkMs, ["objects"] = spare.Objects,
                ["ageMs"] = (long)(clock() - spare.ReadyUtc).TotalMilliseconds, ["estimatedMB"] = spare.Bytes >> 20,
            },
            ["evicted"] = evicted,
        };
        if (skipped != null) receipt["skipped"] = skipped;
        return receipt;
    }
}

/// <summary>The worker's <see cref="BaseModelCache{TModel}"/> of Studio modules. Only `serve` enables it (both lanes); cold
/// processes and tests never do, so they load every base as always. The CLIs see only Studio-free members.</summary>
public static class BaseModelCache
{
    internal static BaseModelCache<ESpace>? Shared { get; private set; }

    private static readonly AsyncLocal<BaseModelCache<ESpace>?> Scope = new();

    /// <summary>The cache an apply of this request uses: the one <see cref="Scoped{T}"/> gave it (a test's own), else the worker's.</summary>
    internal static BaseModelCache<ESpace>? Current => Scope.Value ?? Shared;

    /// <summary>Runs <paramref name="body"/> with <paramref name="cache"/> as <see cref="Current"/> (null: the worker's), so a
    /// test measures the worker's path without enabling the process-wide cache.</summary>
    internal static T Scoped<T>(Own? cache, Func<T> body)
    {
        var previous = Scope.Value;
        Scope.Value = cache?.Cache;
        try { return body(); }
        finally { Scope.Value = previous; }
    }

    /// <summary>A cache only a <see cref="Scoped{T}"/> uses, with no Studio type in its members (the tests of both lanes
    /// compile without the Studio's assemblies).</summary>
    internal sealed class Own(BaseCacheOptions options)
    {
        internal readonly BaseModelCache<ESpace> Cache = Create(options);
        public void Idle() => Cache.Idle(CancellationToken.None);
        public void Idle(CancellationToken cancel) => Cache.Idle(cancel);
        public JsonObject Stats() => Cache.Stats();
        public int Held => Cache.Held;
        public bool Serves(string[] args) => Cache.Serves(args);
        public JsonObject Warm(string[] args) => Cache.Warm(args);
        public WorkerServer.IdleWork Worker => Cache.Worker;

        /// <summary>The proof that the hot state is the capture: takes the spare of these bytes (when there is one) and loads them
        /// fresh, and answers the shape of each (<see cref="Shape"/>; null: no spare). A save is no proof: two fresh loads of
        /// the same bytes save different bytes.</summary>
        public (string? Spare, string Fresh) Shapes(string path, byte[] bytes, ModelHost host)
        {
            var taken = Cache.Take(path, bytes);
            string? spare = null;
            if (taken.Model is { } model)
                try { spare = Shape(model); } finally { ModelHost.Release(model); }
            var fresh = host.Load(bytes);
            try { return (spare, Shape(fresh)); } finally { ModelHost.Release(fresh); }
        }

        /// <summary>Every object of the module (key, kind, name, number of children) in key order, as one SHA-256 with the count.</summary>
        private static string Shape(ESpace model)
        {
            var reader = new KernelModelReader();
            var lines = reader.Walk((OutSystems.Model.IObjectSignature)model).Select(n => reader.Describe(n)).Select(d => d.Key + "|" + d.Kind + "|" + d.ModelName + "|" + d.Children)
                .Order(StringComparer.Ordinal).ToList();
            return lines.Count + ":" + Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join('\n', lines)))).ToLowerInvariant();
        }
    }

    /// <summary>On by default in every worker; false when the operator switched it off (ANVIL_BASE_CACHE=off).</summary>
    public static bool Enable(Action<string>? log = null)
    {
        var options = BaseCacheOptions.FromEnvironment(Environment.GetEnvironmentVariable);
        if (options == null) log?.Invoke("base cache: off (ANVIL_BASE_CACHE=off in the worker's environment)");
        else log?.Invoke($"base cache: spare, {options.Entries} entries, {options.Bytes >> 20} MB, expiry {options.Expiry.TotalMinutes:0} min");
        Shared = options == null ? null : Create(options, log);
        return Shared != null;
    }

    /// <summary>Spares held now: loaded modules that are not a leak.</summary>
    public static int Held => Shared?.Held ?? 0;

    public static JsonObject Stats() => Shared?.Stats() ?? new JsonObject { ["mode"] = "off" };

    public static WorkerServer.IdleWork? Worker => Shared?.Worker;

    private static readonly AsyncLocal<(string Path, string Sha256)?> Content = new();

    /// <summary>B2 (C02): runs one request with the content identity of its base (`apply --base-content-sha256`), which
    /// <see cref="BaseModelCache{TModel}.Take"/> reads for that file without a change in its caller (JobRunner). Without a
    /// path or a sha256 the request runs as before.</summary>
    public static T WithContent<T>(string? basePath, string? contentSha256, Func<T> body)
    {
        if (string.IsNullOrWhiteSpace(basePath) || string.IsNullOrWhiteSpace(contentSha256)) return body();
        var previous = Content.Value;
        Content.Value = (Path.GetFullPath(basePath), contentSha256.Trim().ToLowerInvariant());
        try { return body(); }
        finally { Content.Value = previous; }
    }

    /// <summary>R3: the model identity of OML bytes, the rule of PrebuiltCandidate.ModelSha256 and of the facade's capture
    /// store (o11-capture-store.mjs modelSha256): the SHA-256 of the bytes after the textual header ("OML", a 32-bit
    /// little-endian length N, N header bytes), which holds only the Studio's window state; any other shape: of every byte.</summary>
    public static string ModelSha256(byte[] bytes)
    {
        if (bytes.Length >= 7 && bytes[0] == (byte)'O' && bytes[1] == (byte)'M' && bytes[2] == (byte)'L')
        {
            var length = BitConverter.ToUInt32(bytes, 3);
            if (length <= (uint)(bytes.Length - 7))
                return Convert.ToHexString(SHA256.HashData(bytes.AsSpan(7 + (int)length))).ToLowerInvariant();
        }
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    /// <summary>L3b (spare pós-merge): a delivery that merged and captured the module again (its delivered snapshot) makes that
    /// capture the base the worker prepares next, in place of the capture before the merge (<paramref name="before"/>), so the
    /// next read and the next delivery of the module find its spare. Null outside a worker with a cache (a cold process, a test
    /// without <see cref="Scoped{T}"/>, ANVIL_BASE_CACHE=off) and without a delivered file; never throws.</summary>
    public static JsonObject? AfterMerge(string? delivered, string? before)
    {
        if (Current is not { } cache || string.IsNullOrWhiteSpace(delivered) || !File.Exists(delivered)) return null;
        try { return cache.Remember(delivered, before); }
        catch (Exception ex) { return new JsonObject { ["wanted"] = false, ["reason"] = ex.GetType().Name + ": " + ex.Message }; }
    }

    // OdcRuntime.WithDeveloperId of the ODC build (this file is compiled into both kernels; the O11 one has no such type).
    private static readonly System.Reflection.MethodInfo? Author = typeof(BaseModelCache).Assembly.GetType("Anvil.Core.OdcRuntime")
        ?.GetMethod("WithDeveloperId")?.MakeGenericMethod(typeof(JsonObject));

    /// <summary>Runs <paramref name="body"/> as the request of <paramref name="developerId"/> would (the ODC worker keys a spare by
    /// its author, OdcRuntime.LoadProfile); the O11 kernel, or no id: as it is.</summary>
    internal static JsonObject AsAuthor(string? developerId, Func<JsonObject> body)
    {
        if (string.IsNullOrWhiteSpace(developerId) || Author == null) return body();
        try { return (JsonObject)Author.Invoke(null, [developerId, body])!; }
        catch (System.Reflection.TargetInvocationException ex) when (ex.InnerException != null) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(ex.InnerException); throw; }
    }

    /// <summary>The content identity the current request gave for this base file, or null.</summary>
    public static string? ContentOf(string path)
    {
        var hint = Content.Value;
        if (hint == null) return null;
        try { return string.Equals(Path.GetFullPath(path), hint.Value.Path, StringComparison.OrdinalIgnoreCase) ? hint.Value.Sha256 : null; }
        catch { return null; }
    }

    /// <summary>A cache over this process's Studio runtime (the worker's, or a test's own instance).</summary>
    public static BaseModelCache<ESpace> Create(BaseCacheOptions options, Action<string>? log = null)
    {
        var studio = StudioAdapter.Runtime;
        var kernel = JobProvenance.Sha256(typeof(ModelSession).Assembly.Location);
        // L3b: a `warm` can make the first load of a fresh worker a prefetch, before any command ran the headless prologue
        // (ModelHost does it); loading first fails ESpace's type initializer for the life of the process. Idempotent.
        var prologue = Path.Combine(Path.GetTempPath(), "anvil-base-cache");
        return new BaseModelCache<ESpace>(options,
            () => new BaseRuntime(studio.Platform, studio.IdeVersion, studio.StudioDirectory, kernel, studio.LoadProfile),
            (bytes, cancel) => { studio.Ensure(prologue); return studio.Load(bytes, cancel); }, Walk, espace => ModelHost.Release(espace), log);
    }

    /// <summary>The read-only walk a job starts with: every child (O11 materializes its lazy collections here, ~0.8 s on
    /// a large client module; ESpaceInstances.ForceFullLoad does not) and the Verify the job reads first. Returns the module's objects.</summary>
    private static int Walk(ESpace espace, CancellationToken cancel)
    {
        var seen = 0;
        int Visit(AbstractObject root)
        {
            var n = 0;
            var stack = new Stack<AbstractObject>(); stack.Push(root);
            while (stack.Count > 0)
            {
                if ((++seen & 1023) == 0) cancel.ThrowIfCancellationRequested();
                var o = stack.Pop(); n++;
                try { foreach (var c in o.DirectChildren) stack.Push(c); } catch { }
            }
            return n;
        }
        var objects = Visit(espace);
        foreach (var reference in espace.References) Visit(reference);
        cancel.ThrowIfCancellationRequested();
        ModelHost.Messages(espace);
        return objects;
    }
}
