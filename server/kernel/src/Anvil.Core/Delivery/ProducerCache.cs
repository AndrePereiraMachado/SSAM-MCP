using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// C27: producer captures reused between deliveries. A capture (.avsig, written read-only from the environment by
/// IProducerSignatureAuthority.Capture) is kept under &lt;anvilRoot&gt;/.local/producer-cache/, keyed by environment, producer and
/// the referenced elements, with its sha256 and the capture receipt. A delivery reuses it only when the file still has that
/// sha256 and its identity is observed: by the authority (Attest re-observes the server: a republished producer, a new
/// versionId or another advertised hash throws, and the entry is dropped and captured again) or, F5, by the workspace
/// ledger (<see cref="ProducerLedger"/>: the same published state observed lately, no publication since). The task still
/// records its own copy, and the delivery observes every producer on the server right before the merge.
/// F5: a capture covers any request whose elements it holds (<see cref="FindCovering"/>: the exact one, else the one with the
/// fewest elements): the import takes only the elements of the job's reference op (Verbs.PrepareSignatureReference), so a
/// capture with more elements is the same signature. A request that needs an element no capture holds is captured again,
/// and the store drops the captures the new one covers and those of another published state.
/// Only the lane work folder (&lt;...&gt;/.local/work or .local/lane-ss5/work) has a cache: the nearest ".local" above it.
/// </summary>
public sealed class ProducerCache
{
    public string DirectoryPath { get; }
    public ProducerCache(string directory) => DirectoryPath = Path.GetFullPath(directory);

    /// <summary>A capture of the cache: its file, the capture receipt and the elements it was captured for.</summary>
    public sealed record Entry(string Path, JsonObject Receipt, IReadOnlyList<string> Elements, string Environment, string Producer, DateTime StoredAtUtc);

    /// <summary>The cache of a delivery store, or null when the work folder is not a lane work folder.</summary>
    public static ProducerCache? ForWork(string workDirectory)
    {
        var work = new DirectoryInfo(Path.GetFullPath(workDirectory));
        if (!work.Name.Equals("work", StringComparison.OrdinalIgnoreCase)) return null;
        for (var dir = work.Parent; dir != null; dir = dir.Parent)
            if (dir.Name.Equals(".local", StringComparison.OrdinalIgnoreCase)) return new ProducerCache(Path.Combine(dir.FullName, "producer-cache"));
        return null;
    }

    /// <summary>F5: the cache of a file the lane writes under its .local (an `anvil signature --out` of o11_job,
    /// &lt;lane .local&gt;/jobs/captured/...): the nearest ".local" above it, the same folder as <see cref="ForWork"/>.</summary>
    public static ProducerCache? ForLocalFile(string file)
    {
        for (var dir = new FileInfo(Path.GetFullPath(file)).Directory; dir != null; dir = dir.Parent)
            if (dir.Name.Equals(".local", StringComparison.OrdinalIgnoreCase)) return new ProducerCache(Path.Combine(dir.FullName, "producer-cache"));
        return null;
    }

    public static string Key(string environment, string producer, IReadOnlyList<string> elements)
        => DurableJson.Hash(environment.Trim().ToLowerInvariant() + "\n" + producer + "\n"
            + string.Join("\n", elements.Distinct(StringComparer.Ordinal).OrderBy(e => e, StringComparer.Ordinal)));

    private string EntryPath(string key) => Path.Combine(DirectoryPath, key + ".json");
    private string FilePath(string key) => Path.Combine(DirectoryPath, key + ".avsig");

    /// <summary>The cached capture path and receipt when its bytes still have the recorded sha256; null otherwise.</summary>
    public (string Path, JsonObject Receipt)? Find(string environment, string producer, IReadOnlyList<string> elements)
    {
        var key = Key(environment, producer, elements);
        var entry = EntryPath(key); var file = FilePath(key);
        try
        {
            if (!File.Exists(entry) || !File.Exists(file)) return null;
            var recorded = DurableJson.Read(entry);
            if (recorded["sha256"]?.ToString() != DeliveryReceipt.Hash(file)) { Remove(environment, producer, elements); return null; }
            return (file, recorded["receipt"]?.AsObject().DeepClone().AsObject() ?? new JsonObject());
        }
        catch (Exception) { Remove(environment, producer, elements); return null; } // unreadable or corrupt: captured again
    }

    /// <summary>F5: the capture of the producer in the environment that holds every requested element (its file intact):
    /// the exact one, else the one with the fewest elements (then the newest); null when none does.</summary>
    public Entry? FindCovering(string environment, string producer, IReadOnlyList<string> elements)
    {
        if (Find(environment, producer, elements) is { } exact)
            return new Entry(exact.Path, exact.Receipt, elements.Distinct(StringComparer.Ordinal).ToArray(), environment, producer, DateTime.MaxValue);
        var wanted = elements.Distinct(StringComparer.Ordinal).ToArray();
        return EntriesOf(environment, producer).Where(e => wanted.All(w => e.Elements.Contains(w, StringComparer.Ordinal)))
            .OrderBy(e => e.Elements.Count).ThenByDescending(e => e.StoredAtUtc).FirstOrDefault();
    }

    /// <summary>Every intact capture of the producer in the environment.</summary>
    public IReadOnlyList<Entry> EntriesOf(string environment, string producer)
        => EntriesIn(environment).Where(e => string.Equals(e.Producer, producer, StringComparison.OrdinalIgnoreCase)).ToArray();

    /// <summary>Every intact capture of the environment.</summary>
    public IReadOnlyList<Entry> EntriesIn(string environment)
    {
        var found = new List<Entry>();
        if (!Directory.Exists(DirectoryPath)) return found;
        foreach (var entry in Directory.EnumerateFiles(DirectoryPath, "*.json"))
        {
            try
            {
                var recorded = DurableJson.Read(entry);
                if (!string.Equals(recorded["environment"]?.ToString()?.Trim(), environment.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
                var file = Path.ChangeExtension(entry, ".avsig");
                if (!File.Exists(file) || recorded["sha256"]?.ToString() != DeliveryReceipt.Hash(file)) continue;
                var elements = (recorded["elements"] as JsonArray ?? new JsonArray()).Select(e => e?.ToString() ?? "").Where(e => e.Length > 0).ToArray();
                var stored = DateTime.TryParse(recorded["storedAtUtc"]?.ToString(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var at) ? at.ToUniversalTime() : DateTime.MinValue;
                found.Add(new Entry(file, recorded["receipt"]?.AsObject().DeepClone().AsObject() ?? new JsonObject(), elements,
                    recorded["environment"]!.ToString(), recorded["producer"]!.ToString(), stored));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or System.Text.Json.JsonException or InvalidOperationException or NullReferenceException) { }
        }
        return found;
    }

    public void Store(string environment, string producer, IReadOnlyList<string> elements, string capturedPath, JsonObject receipt)
    {
        var key = Key(environment, producer, elements);
        Directory.CreateDirectory(DirectoryPath);
        var bytes = File.ReadAllBytes(capturedPath);
        DurableJson.WriteBytes(FilePath(key), bytes);
        DurableJson.Write(EntryPath(key), new JsonObject { ["environment"] = environment, ["producer"] = producer,
            ["elements"] = new JsonArray(elements.Select(e => (JsonNode)JsonValue.Create(e)!).ToArray()),
            ["sha256"] = DeliveryReceipt.Hash(FilePath(key)), ["receipt"] = receipt.DeepClone(), ["storedAtUtc"] = DateTime.UtcNow.ToString("O") });
        // F5: the captures this one covers (same published state, fewer elements) and those of another published state go.
        var fresh = ProducerIdentity.OfReceipt(receipt, environment);
        foreach (var old in EntriesOf(environment, producer))
        {
            if (string.Equals(Path.GetFullPath(old.Path), Path.GetFullPath(FilePath(key)), StringComparison.OrdinalIgnoreCase)) continue;
            var state = ProducerIdentity.OfReceipt(old.Receipt, environment);
            var stale = fresh != null && state != null && fresh.HasState && state.HasState && !fresh.SameState(state);
            var covered = old.Elements.All(e => elements.Contains(e, StringComparer.Ordinal));
            if (stale || covered) Delete(old.Path);
        }
    }

    public void Remove(string environment, string producer, IReadOnlyList<string> elements)
    {
        var key = Key(environment, producer, elements);
        foreach (var path in new[] { EntryPath(key), FilePath(key) })
            try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { /* the next store replaces it */ }
    }

    /// <summary>F5: drops every capture of the producer in the environment (it changed on the server): the captures cached
    /// under that name and those whose receipt names it (an owner cached under "@&lt;key&gt;").</summary>
    public void RemoveProducer(string environment, string producer)
    {
        foreach (var entry in EntriesIn(environment).Where(e => string.Equals(e.Producer, producer, StringComparison.OrdinalIgnoreCase)
                     || string.Equals(e.Receipt["producer"]?.ToString(), producer, StringComparison.OrdinalIgnoreCase)))
            Delete(entry.Path);
    }

    private static void Delete(string avsig)
    {
        foreach (var path in new[] { Path.ChangeExtension(avsig, ".json"), avsig })
            try { if (File.Exists(path)) File.Delete(path); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}
