using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// C27: producer captures reused between deliveries. A capture (.avsig, written read-only from the environment by
/// IProducerSignatureAuthority.Capture) is kept under &lt;anvilRoot&gt;/.local/producer-cache/, keyed by environment, producer and
/// the referenced elements, with its sha256 and the capture receipt. A delivery reuses it only when the file still has that
/// sha256 and the authority re-attests it (Attest re-observes the server: a republished producer, a new versionId or another
/// advertised hash throws, and the entry is dropped and captured again). The task still records its own copy and
/// re-attests it before apply and before merge, as for a fresh capture.
/// Only the lane work folder (&lt;...&gt;/.local/work or .local/lane-ss5/work) has a cache: the nearest ".local" above it.
/// </summary>
public sealed class ProducerCache
{
    public string DirectoryPath { get; }
    public ProducerCache(string directory) => DirectoryPath = Path.GetFullPath(directory);

    /// <summary>The cache of a delivery store, or null when the work folder is not a lane work folder.</summary>
    public static ProducerCache? ForWork(string workDirectory)
    {
        var work = new DirectoryInfo(Path.GetFullPath(workDirectory));
        if (!work.Name.Equals("work", StringComparison.OrdinalIgnoreCase)) return null;
        for (var dir = work.Parent; dir != null; dir = dir.Parent)
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

    public void Store(string environment, string producer, IReadOnlyList<string> elements, string capturedPath, JsonObject receipt)
    {
        var key = Key(environment, producer, elements);
        Directory.CreateDirectory(DirectoryPath);
        var bytes = File.ReadAllBytes(capturedPath);
        DurableJson.WriteBytes(FilePath(key), bytes);
        DurableJson.Write(EntryPath(key), new JsonObject { ["environment"] = environment, ["producer"] = producer,
            ["elements"] = new JsonArray(elements.Select(e => (JsonNode)JsonValue.Create(e)!).ToArray()),
            ["sha256"] = DeliveryReceipt.Hash(FilePath(key)), ["receipt"] = receipt.DeepClone(), ["storedAtUtc"] = DateTime.UtcNow.ToString("O") });
    }

    public void Remove(string environment, string producer, IReadOnlyList<string> elements)
    {
        var key = Key(environment, producer, elements);
        foreach (var path in new[] { EntryPath(key), FilePath(key) })
            try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { /* the next store replaces it */ }
    }
}
