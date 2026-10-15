using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Reading;

public interface IReadSnapshot : IDisposable
{
    string Name { get; }
    JsonObject Read(string? path, ReadingOptions options, string[]? select, string file);
    ModuleIndex BuildIndex(string lane, string adapter, string sourceSha256, long sourceBytes);
    ModuleDigest BuildDigest(string lane, string sourceSha256, long sourceBytes);
    ModuleRichIndex BuildRich(string lane, string sourceSha256, long sourceBytes);
    // ssam-html/1 (ScreenHtml): one screen or block by name, Kind:Name or @key; the module is read once per snapshot.
    ScreenHtmlDocument ReadHtml(string target);
    IReadOnlyList<(string Name, string Kind, string Key)> HtmlRoots();
    DataDdl BuildDdl(string lane, string sourceSha256, long sourceBytes);
    ModuleFlow BuildFlow(string lane, string sourceSha256, long sourceBytes);
}

// Owned exclusively by a read process. Never share these native objects with a write worker.
public sealed class ReadSnapshot<T>(T root, ModelReader<T> reader, string name, Action close,
    Func<T, string, object>? map = null) : IReadSnapshot where T : class
{
    public string Name => name;
    public void Dispose() => close();
    public ModuleIndex BuildIndex(string lane, string adapter, string sourceSha256, long sourceBytes) =>
        ModuleIndex.Build(root, reader, name, lane, adapter, sourceSha256, sourceBytes);
    public ModuleDigest BuildDigest(string lane, string sourceSha256, long sourceBytes) =>
        ModuleDigest.Build(root, reader, lane, sourceSha256, sourceBytes);
    public ModuleRichIndex BuildRich(string lane, string sourceSha256, long sourceBytes) =>
        ModuleRichIndex.Build(root, reader, lane, sourceSha256, sourceBytes);
    private ScreenHtmlModule<T>? html;
    public ScreenHtmlDocument ReadHtml(string target) => (html ??= ScreenHtml.Module(root, reader)).Read(target);
    public IReadOnlyList<(string Name, string Kind, string Key)> HtmlRoots() => (html ??= ScreenHtml.Module(root, reader)).Roots;
    public DataDdl BuildDdl(string lane, string sourceSha256, long sourceBytes) =>
        DataDdl.Build(root, reader, lane, sourceSha256, sourceBytes);
    public ModuleFlow BuildFlow(string lane, string sourceSha256, long sourceBytes) =>
        ModuleFlow.Build(root, reader, lane, sourceSha256, sourceBytes);
    public JsonObject Read(string? path, ReadingOptions options, string[]? select, string file)
    {
        options.Validate();
        object result;
        if (select is not null) {
            if (select.Length is < 1 or > 32 || select.Any(string.IsNullOrWhiteSpace))
                throw new ArgumentException("select must contain between 1 and 32 non-empty relative paths or @keys");
            var scope = reader.Resolve(root, path ?? "/");
            var entries = new JsonArray();
            foreach (var selector in select) {
                try { entries.Add(new JsonObject { ["selector"] = selector, ["ok"] = true,
                    ["data"] = JsonSerializer.SerializeToNode(reader.Read(scope, selector, options)) }); }
                catch (Exception error) { entries.Add(new JsonObject { ["selector"] = selector, ["ok"] = false,
                    ["error"] = error.GetBaseException().Message }); }
            }
            result = new { schema = "ssam-reading-batch/1", path = path ?? "/", requested = select.Length,
                complete = entries.All(e => e!["ok"]!.GetValue<bool>()), entries };
        } else if (path == null && !options.IsQuery && options.Properties == null && !options.Usages && map != null)
            result = map(root, file);
        else result = reader.Read(root, path ?? "/", options);
        return JsonSerializer.SerializeToNode(result)!.AsObject();
    }
}

// One immutable capture at a time; each request reads and hashes the actual source bytes.
// File name/mtime and "50 minutes in this session" are never freshness evidence.
// With a module index store, a listing the index answers exactly (ModuleIndex.Answerable) comes from the index of those
// bytes without loading or evicting the capture, and a loaded capture stores its index when none is valid.
public sealed class SnapshotReadCache(Func<byte[], IReadSnapshot> load, ModuleIndexStore? indexes = null) : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private IReadSnapshot? snapshot;
    private string? hash;
    private string? indexChecked;
    private readonly Dictionary<string, JsonObject> answers = new(StringComparer.Ordinal);
    private readonly List<ModuleIndex> parsed = [];
    private long answerBytes;
    private int loads;
    public void Dispose() { snapshot?.Dispose(); snapshot = null; hash = null; indexChecked = null; answers.Clear(); answerBytes = 0; }

    public JsonObject Read(JsonObject request)
    {
        var total = Stopwatch.StartNew();
        var file = Path.GetFullPath(request["file"]?.GetValue<string>() ?? throw new ArgumentException("file is required"));
        var options = request["options"]?.Deserialize<ReadingOptions>(JsonOptions) ?? new();
        options.Validate();
        var path = request["path"]?.GetValue<string>();
        var select = request["select"]?.Deserialize<string[]>();
        if (select != null && (select.Length is < 1 or > 32 || select.Any(string.IsNullOrWhiteSpace)))
            throw new ArgumentException("select must contain between 1 and 32 non-empty paths");
        var bytes = File.ReadAllBytes(file);
        var actual = Convert.ToHexString(SHA256.HashData(bytes));
        var hashMs = total.Elapsed.TotalMilliseconds;
        if (request["expectedSourceSha256"] is { } expected && !string.Equals(expected.GetValue<string>(), actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Snapshot content changed: expectedSourceSha256 does not match the source bytes");
        if (request["index"] is { } mode) return EnsureIndex(mode.GetValue<string>(), bytes, actual, total);
        if (request["digest"] is { } digestMode) return EnsureDigest(digestMode.GetValue<string>(), bytes, actual, total);
        if (request["rich"] is { } richMode) return EnsureRich(richMode.GetValue<string>(), bytes, actual, total);
        if (request["html"] is { } htmlTarget) return ReadHtml(htmlTarget.GetValue<string>(), request["keys"]?.GetValue<bool>() == true, bytes, actual, total);
        if (request["ddl"] is { } ddlMode) return EnsureDdl(ddlMode.GetValue<string>(), bytes, actual, total);
        if (request["flow"] is { } flowMode) return EnsureFlow(flowMode.GetValue<string>(), bytes, actual, total);
        var cold = request["cold"]?.GetValue<bool>() == true;
        var modelHit = snapshot != null && hash == actual && !cold;
        // Include the file because the legacy module map includes its source path.
        var queryKey = JsonSerializer.Serialize(new { file, path, select, options });
        var phase = total.Elapsed.TotalMilliseconds;
        if (indexes != null && !cold && !(modelHit && answers.ContainsKey(queryKey)) && ModuleIndex.Answerable(path, options, select)
            && Index(actual) is { } index && index.Query(path ?? "/", options) is { } indexed) {
            // Not memoized: the memo belongs to the loaded capture, and this answer may be for another one.
            indexed["model"] = index.ModuleName;
            indexed["sourceSha256"] = actual;
            indexed["identityScope"] = ModuleIndex.IdentityScope;
            return new JsonObject { ["ok"] = true, ["data"] = indexed, ["sourceSha256"] = actual,
                ["cache"] = new JsonObject { ["modelHit"] = modelHit, ["queryHit"] = false, ["loads"] = loads, ["index"] = "hit" },
                ["timings"] = new JsonObject { ["fileHashMs"] = hashMs, ["loadMs"] = 0,
                    ["queryMs"] = total.Elapsed.TotalMilliseconds - phase, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
        }
        phase = total.Elapsed.TotalMilliseconds;
        if (!modelHit) {
            Dispose();
            snapshot = load(bytes); hash = actual; loads++;
        }
        var loadMs = total.Elapsed.TotalMilliseconds - phase;
        phase = total.Elapsed.TotalMilliseconds;
        var queryHit = answers.TryGetValue(queryKey, out var cached);
        var data = queryHit ? cached!.DeepClone().AsObject() : snapshot!.Read(path, options, select, file);
        data["model"] = snapshot!.Name;
        data["sourceSha256"] = actual;
        data["identityScope"] = ModuleIndex.IdentityScope;
        if (!queryHit && !HasFailure(data)) {
            var size = System.Text.Encoding.UTF8.GetByteCount(data.ToJsonString());
            if (size <= 4 * 1024 * 1024) {
                if (answers.Count >= 128 || answerBytes + size > 16 * 1024 * 1024) { answers.Clear(); answerBytes = 0; }
                answers[queryKey] = data.DeepClone().AsObject(); answerBytes += size;
            }
        }
        var queryMs = total.Elapsed.TotalMilliseconds - phase;
        phase = total.Elapsed.TotalMilliseconds;
        var cache = new JsonObject { ["modelHit"] = modelHit, ["queryHit"] = queryHit, ["loads"] = loads };
        var timings = new JsonObject { ["fileHashMs"] = hashMs, ["loadMs"] = loadMs, ["queryMs"] = queryMs };
        if (StoreIndex(bytes.Length) is { } stored) { cache["index"] = stored; timings["indexMs"] = total.Elapsed.TotalMilliseconds - phase; }
        timings["serverMs"] = total.Elapsed.TotalMilliseconds;
        return new JsonObject { ["ok"] = true, ["data"] = data, ["sourceSha256"] = actual, ["cache"] = cache, ["timings"] = timings };
    }

    // {"index":"ensure"}: the capture's index is stored (built from the model when absent or invalid).
    private JsonObject EnsureIndex(string mode, byte[] bytes, string actual, Stopwatch total)
    {
        if (mode != "ensure") throw new ArgumentException("index accepts only \"ensure\"");
        if (indexes == null) throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run the reader inside an SSAM workspace");
        var index = indexes.Load(actual); var built = false;
        if (index == null) {
            if (snapshot == null || hash != actual) { Dispose(); snapshot = load(bytes); hash = actual; loads++; }
            index = snapshot.BuildIndex(indexes.Lane, indexes.Adapter, actual, bytes.Length);
            indexes.Save(index); built = true; indexChecked = actual;
        }
        Remember(index);
        return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual,
            ["index"] = new JsonObject { ["path"] = indexes.PathOf(actual), ["sourceSha256"] = index.SourceSha256, ["built"] = built,
                ["complete"] = index.Complete, ["counts"] = index.Counts() },
            ["cache"] = new JsonObject { ["loads"] = loads }, ["timings"] = new JsonObject { ["serverMs"] = total.Elapsed.TotalMilliseconds } };
    }

    // {"digest":"ensure"}: the capture's module digest is stored beside its index (built from the model, loaded here when
    // needed, when absent or invalid). The facade reads and pages the file; the answer carries its path and sizes.
    private JsonObject EnsureDigest(string mode, byte[] bytes, string actual, Stopwatch total)
    {
        if (mode != "ensure") throw new ArgumentException("digest accepts only \"ensure\"");
        if (indexes == null) throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run the reader inside an SSAM workspace");
        var digest = indexes.LoadDigest(actual); var built = false; double loadMs = 0, buildMs = 0;
        if (digest == null) {
            var phase = total.Elapsed.TotalMilliseconds;
            if (snapshot == null || hash != actual) { Dispose(); snapshot = load(bytes); hash = actual; loads++; }
            loadMs = total.Elapsed.TotalMilliseconds - phase; phase = total.Elapsed.TotalMilliseconds;
            digest = snapshot.BuildDigest(indexes.Lane, actual, bytes.Length);
            indexes.SaveDigest(digest); built = true;
            buildMs = total.Elapsed.TotalMilliseconds - phase;
        }
        return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual, ["digest"] = digest.Answer(indexes.DigestPathOf(actual), built),
            ["cache"] = new JsonObject { ["loads"] = loads },
            ["timings"] = new JsonObject { ["loadMs"] = loadMs, ["digestMs"] = buildMs, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
    }

    // {"flow":"ensure"}: the capture's flow reading (ModuleFlow, ssam-flow/1) is stored beside its index, built from the
    // model (loaded here when needed) when absent or invalid. The facade reads the file and serves it by element.
    private JsonObject EnsureFlow(string mode, byte[] bytes, string actual, Stopwatch total)
    {
        if (mode != "ensure") throw new ArgumentException("flow accepts only \"ensure\"");
        if (indexes == null) throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run the reader inside an SSAM workspace");
        var flow = indexes.LoadFlow(actual); var built = false; double loadMs = 0, buildMs = 0;
        if (flow == null) {
            var phase = total.Elapsed.TotalMilliseconds;
            if (snapshot == null || hash != actual) { Dispose(); snapshot = load(bytes); hash = actual; loads++; }
            loadMs = total.Elapsed.TotalMilliseconds - phase; phase = total.Elapsed.TotalMilliseconds;
            flow = snapshot.BuildFlow(indexes.Lane, actual, bytes.Length);
            indexes.SaveFlow(flow); built = true;
            buildMs = total.Elapsed.TotalMilliseconds - phase;
        }
        return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual, ["flow"] = flow.Answer(indexes.FlowPathOf(actual), built),
            ["cache"] = new JsonObject { ["loads"] = loads },
            ["timings"] = new JsonObject { ["loadMs"] = loadMs, ["flowMs"] = buildMs, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
    }

    // {"rich":"ensure"}: the capture's rich index (ModuleRichIndex) is stored beside its index, built from the model (loaded
    // here when needed) only when absent or invalid. Never built by any other request: it is large and asked for on purpose.
    private JsonObject EnsureRich(string mode, byte[] bytes, string actual, Stopwatch total)
    {
        if (mode != "ensure") throw new ArgumentException("rich accepts only \"ensure\"");
        if (indexes == null) throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run the reader inside an SSAM workspace");
        var rich = indexes.LoadRich(actual); var built = false; double loadMs = 0, buildMs = 0;
        if (rich == null) {
            var phase = total.Elapsed.TotalMilliseconds;
            if (snapshot == null || hash != actual) { Dispose(); snapshot = load(bytes); hash = actual; loads++; }
            loadMs = total.Elapsed.TotalMilliseconds - phase; phase = total.Elapsed.TotalMilliseconds;
            rich = snapshot.BuildRich(indexes.Lane, actual, bytes.Length);
            indexes.SaveRich(rich); built = true;
            buildMs = total.Elapsed.TotalMilliseconds - phase;
        }
        return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual, ["rich"] = rich.Answer(indexes.RichPathOf(actual), built),
            ["cache"] = new JsonObject { ["loads"] = loads },
            ["timings"] = new JsonObject { ["loadMs"] = loadMs, ["richMs"] = buildMs, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
    }

    // {"html":"<screen>"}: the screen or block as ssam-html/1 (ScreenHtml), its key table stored beside the capture's index
    // (ModuleIndexStore.SaveHtmlKeys) so an edit based on {capture, html} finds its keys; {"html":""} lists the screens and
    // blocks. The capture stays loaded, and the module reading with it (the next screen reads in milliseconds).
    private JsonObject ReadHtml(string target, bool withKeys, byte[] bytes, string actual, Stopwatch total)
    {
        var phase = total.Elapsed.TotalMilliseconds; double loadMs = 0;
        if (snapshot == null || hash != actual) { Dispose(); snapshot = load(bytes); hash = actual; loads++; loadMs = total.Elapsed.TotalMilliseconds - phase; }
        if (target.Length == 0)
            return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual, ["html"] = new JsonObject { ["schema"] = ScreenHtml.Schema, ["model"] = snapshot.Name,
                ["roots"] = new JsonArray(snapshot.HtmlRoots().Select(r => (JsonNode)new JsonObject { ["name"] = r.Name, ["kind"] = r.Kind, ["key"] = r.Key }).ToArray()) },
                ["cache"] = new JsonObject { ["loads"] = loads }, ["timings"] = new JsonObject { ["loadMs"] = loadMs, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
        phase = total.Elapsed.TotalMilliseconds;
        var document = snapshot.ReadHtml(target);
        var readMs = total.Elapsed.TotalMilliseconds - phase;
        var answer = document.Json(withKeys);
        answer["model"] = snapshot.Name;
        if (indexes != null) {
            try { answer["keysFile"] = indexes.SaveHtmlKeys(actual, document); }
            catch (Exception error) { answer["keysError"] = error.GetBaseException().Message; }
        }
        return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual, ["html"] = answer, ["cache"] = new JsonObject { ["loads"] = loads },
            ["timings"] = new JsonObject { ["loadMs"] = loadMs, ["readMs"] = readMs, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
    }

    // {"ddl":"ensure"}: the capture's data text (DataDdl, ssam-ddl/1) is stored beside its index (built from the model, loaded
    // here when needed, when absent or invalid). The facade reads and pages the file (ssam_map view:"ddl").
    private JsonObject EnsureDdl(string mode, byte[] bytes, string actual, Stopwatch total)
    {
        if (mode != "ensure") throw new ArgumentException("ddl accepts only \"ensure\"");
        if (indexes == null) throw new InvalidOperationException("No module index store: set SSAM_MODULE_INDEX_ROOT or run the reader inside an SSAM workspace");
        var ddl = indexes.LoadDdl(actual); var built = false; double loadMs = 0, buildMs = 0;
        if (ddl == null) {
            var phase = total.Elapsed.TotalMilliseconds;
            if (snapshot == null || hash != actual) { Dispose(); snapshot = load(bytes); hash = actual; loads++; }
            loadMs = total.Elapsed.TotalMilliseconds - phase; phase = total.Elapsed.TotalMilliseconds;
            ddl = snapshot.BuildDdl(indexes.Lane, actual, bytes.Length);
            indexes.SaveDdl(ddl); built = true;
            buildMs = total.Elapsed.TotalMilliseconds - phase;
        }
        return new JsonObject { ["ok"] = true, ["sourceSha256"] = actual, ["ddl"] = ddl.Answer(indexes.DdlPathOf(actual), built),
            ["cache"] = new JsonObject { ["loads"] = loads },
            ["timings"] = new JsonObject { ["loadMs"] = loadMs, ["ddlMs"] = buildMs, ["serverMs"] = total.Elapsed.TotalMilliseconds } };
    }

    // Once per loaded capture: store its index unless a valid one is already on disk. Never fails the read.
    private string? StoreIndex(long sourceBytes)
    {
        if (indexes == null || snapshot == null || hash == null || indexChecked == hash) return null;
        indexChecked = hash;
        if (indexes.Load(hash) is { } present) { Remember(present); return null; }
        try {
            var index = snapshot.BuildIndex(indexes.Lane, indexes.Adapter, hash, sourceBytes);
            indexes.Save(index); Remember(index);
            return "built";
        } catch (Exception error) {
            Console.Error.WriteLine("module index not stored for " + hash + ": " + error.GetBaseException().Message);
            return "failed";
        }
    }

    private ModuleIndex? Index(string sourceSha256)
    {
        var at = parsed.FindIndex(i => string.Equals(i.SourceSha256, sourceSha256, StringComparison.OrdinalIgnoreCase));
        if (at >= 0) return Remember(parsed[at]);
        return indexes?.Load(sourceSha256) is { } loaded ? Remember(loaded) : null;
    }

    // A few parsed indexes, most recent last; each is only used for the bytes it was validated against.
    private ModuleIndex Remember(ModuleIndex index)
    {
        parsed.RemoveAll(i => i.SourceSha256 == index.SourceSha256);
        if (parsed.Count >= 4) parsed.RemoveAt(0);
        parsed.Add(index);
        return index;
    }

    private static bool HasFailure(JsonNode? node) => node switch {
        JsonObject o => o.Any(p => p.Key is "ok" or "complete" or "searchComplete" && p.Value is JsonValue v && v.TryGetValue<bool>(out var b) && !b
            || p.Key == "propertyErrors" && p.Value is JsonObject errors && errors.Count > 0
            || HasFailure(p.Value)),
        JsonArray a => a.Any(HasFailure), _ => false
    };
}
