using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// R3 (módulo quente, docs/PLANO-PRIMEIRA-CERTA-E-VELOCIDADE-2026-10-24.md §2). A delivery on a module the worker already
/// knows pays neither the load nor the reference closure again. The identity of a module is its model
/// (<see cref="BaseModelCache.ModelSha256"/>: the rule of the facade's capture store and of PrebuiltCandidate) and the
/// runtime that loads it (Studio, kernel assembly, load profile): another capture of the same model is the same module, a
/// changed model or another kernel release is another one. What is kept is never a model a job changed:
/// <list type="bullet">
/// <item>the base model, as the spare of <see cref="BaseModelCache{TModel}"/>: a fresh instance loaded and walked while the
/// worker is idle, taken once by the next apply of the same model and released by it (no job sees what another did);</item>
/// <item>the producer references of a model (<see cref="ReferenceInventoryCache"/>): pure data the reference closure of a
/// delivery reads (ReferenceInventory), kept by model identity in this process and next to each candidate (the apply's
/// sidecar), so the closure reads the base, the pre-refresh capture and the candidate without loading them.</item>
/// </list>
/// The apply's receipt says what was reused (<see cref="Receipt"/>).
/// </summary>
public static class HotModule
{
    /// <summary>The `hot` field of an apply: whether a spare of this model served it, why not, and the load and walk of that
    /// spare (measured while the worker was idle: what this apply did not pay).</summary>
    internal static JsonObject Receipt(JsonObject? baseCache, bool cacheOn, bool builtBase)
    {
        if (builtBase) return new JsonObject { ["reused"] = false, ["reason"] = "base built by this run (job:)", ["savedMs"] = 0L };
        if (!cacheOn || baseCache == null)
            return new JsonObject { ["reused"] = false, ["reason"] = "no resident worker cache in this process (a cold process, or ANVIL_BASE_CACHE=off)", ["savedMs"] = 0L };
        var hit = baseCache["hit"]?.GetValue<bool>() == true;
        var receipt = new JsonObject { ["reused"] = hit, ["modelSha256"] = baseCache["modelSha256"]?.DeepClone() };
        if (hit)
        {
            var prefetch = baseCache["prefetch"] as JsonObject;
            var load = Number(prefetch?["loadMs"]);
            var walk = Number(prefetch?["walkMs"]);
            receipt["reason"] = "a spare of the same model, loaded and walked while the worker was idle";
            receipt["savedMs"] = load + walk;
            receipt["saved"] = new JsonObject { ["loadMs"] = load, ["walkMs"] = walk, ["measured"] = "on the spare's prefetch" };
            return receipt;
        }
        receipt["reason"] = baseCache["skipped"]?.ToString() is { } skipped ? skipped
            : baseCache["evicted"]?.ToString() is { } evicted ? "the spare of this model was dropped (" + evicted + ")"
            : "first apply of this model in this worker, or the next one came before the worker was idle again";
        receipt["savedMs"] = 0L;
        return receipt;
    }

    /// <summary>A whole number of a receipt (written as an int or a long, or read back from its JSON), else 0.</summary>
    public static long Number(JsonNode? node) => node is JsonValue value
        ? value.TryGetValue<long>(out var l) ? l : value.TryGetValue<int>(out var i) ? i : value.TryGetValue<double>(out var d) ? (long)d : 0
        : 0;
}

/// <summary>
/// The producer references of a model (ReferenceInventory's shape, ReferenceClosure.ToJson), by model identity and runtime:
/// what the delivery's reference closure reads of a base, a pre-refresh capture and a candidate. Pure data of the bytes: an
/// entry is used only for the same model under the same Studio and kernel. Kept in this process (the worker: the build
/// phase and the delivery run in the lane's worker), at most <see cref="Entries"/> models, and in the sidecar the apply
/// writes next to its candidate (`&lt;candidate&gt;.references.json`), which the delivery reads from the apply's result (a
/// prebuilt candidate's result names the sidecar of its build). O11 only: the reference closure runs only there.
/// </summary>
public static class ReferenceInventoryCache
{
    public const string SidecarSchema = "ssam-references/1";
    public const int Entries = 32;

    /// <summary>The O11 reference reader exists in this assembly (Adapters.SS11/ReferenceInventory.cs): only there the
    /// reference closure of a delivery runs, so only there the apply records the inventories.</summary>
    public static readonly bool Available = typeof(ReferenceInventoryCache).Assembly.GetType("Anvil.Core.Delivery.ReferenceInventory") != null;

    private sealed record Entry(JsonArray References, string Source, long CostMs);
    private static readonly object Gate = new();
    private static readonly LinkedList<(string Key, Entry Entry)> Lru = new();
    private static long hits, misses;

    /// <summary>The runtime that reads the references (platform, IDE version, Studio folder, kernel assembly); null when this
    /// process has no Studio runtime (nothing is kept then).</summary>
    internal static string? Runtime()
    {
        try
        {
            var studio = StudioAdapter.Runtime;
            return string.Join("|", studio.Platform, studio.IdeVersion, studio.StudioDirectory, Kernel.Value);
        }
        catch (Exception) { return null; }
    }

    private static readonly Lazy<string> Kernel = new(() => JobProvenance.Sha256(typeof(ModelSession).Assembly.Location));

    private static string? KeyOf(string modelSha256) => Runtime() is { } runtime ? modelSha256.ToLowerInvariant() + "|" + runtime : null;

    /// <summary>Keeps the references of a model read now (or in this apply), with what reading them cost.</summary>
    public static void Remember(string modelSha256, JsonArray references, long costMs, string source)
    {
        if (KeyOf(modelSha256) is not { } key) return;
        lock (Gate)
        {
            for (var node = Lru.First; node != null; node = node.Next)
                if (node.Value.Key == key) { Lru.Remove(node); break; }
            Lru.AddFirst((key, new Entry((JsonArray)references.DeepClone(), source, costMs)));
            while (Lru.Count > Entries) Lru.RemoveLast();
        }
    }

    /// <summary>The references kept for this model under this runtime (a copy), with where they came from and what reading
    /// them cost when they were read; null when none is kept.</summary>
    public static (JsonArray References, string Source, long CostMs)? Find(string modelSha256)
    {
        if (KeyOf(modelSha256) is not { } key) return null;
        lock (Gate)
        {
            for (var node = Lru.First; node != null; node = node.Next)
                if (node.Value.Key == key)
                {
                    Lru.Remove(node); Lru.AddFirst(node);
                    hits++;
                    return ((JsonArray)node.Value.Entry.References.DeepClone(), node.Value.Entry.Source, node.Value.Entry.CostMs);
                }
            misses++;
            return null;
        }
    }

    /// <summary>The references of an OML as the delivery's closure reads them: kept for its model (no load), else read by
    /// <paramref name="reader"/> and kept. Reused: where the kept inventory came from (null: read now); SavedMs: what one
    /// read of it cost when it was read (or the load of the apply that recorded it).</summary>
    public static (JsonArray References, string? Reused, long SavedMs) ReadThrough(string path, Func<string, JsonArray> reader, string what)
    {
        var watch = Stopwatch.StartNew();
        var model = ModelSha256Of(path);
        if (Find(model) is { } kept) return (kept.References, kept.Source, kept.CostMs);
        var references = reader(path);
        Remember(model, references, watch.ElapsedMilliseconds, "read:" + what);
        return (references, null, 0);
    }

    public static JsonObject Stats() { lock (Gate) return new JsonObject { ["entries"] = Lru.Count, ["limit"] = Entries, ["hits"] = hits, ["misses"] = misses }; }

    internal static void ClearForTests() { lock (Gate) { Lru.Clear(); hits = misses = 0; } }

    /// <summary>The model identity of an OML file (<see cref="BaseModelCache.ModelSha256"/>).</summary>
    public static string ModelSha256Of(string path) => BaseModelCache.ModelSha256(File.ReadAllBytes(path));

    /// <summary>The sidecar of a candidate file.</summary>
    public static string SidecarOf(string candidatePath) => Path.ChangeExtension(Path.GetFullPath(candidatePath), ".references.json");

    /// <summary>Writes the sidecar of a candidate: the references of its base and of itself, each with its model identity and
    /// what one read of it costs (ms: a load of the model, the apply's own), and the runtime that read them; registers both
    /// here. Returns the sidecar's path, or null when nothing was written.</summary>
    internal static string? WriteSidecar(string candidatePath, (string ModelSha256, JsonArray References, long Ms) basis,
        (string ModelSha256, JsonArray References, long Ms) candidate)
    {
        if (Runtime() is not { } runtime) return null;
        Remember(basis.ModelSha256, basis.References, basis.Ms, "apply:base");
        Remember(candidate.ModelSha256, candidate.References, candidate.Ms, "apply:candidate");
        var file = SidecarOf(candidatePath);
        var document = new JsonObject
        {
            ["schema"] = SidecarSchema, ["runtime"] = runtime,
            ["base"] = new JsonObject { ["modelSha256"] = basis.ModelSha256, ["ms"] = basis.Ms, ["references"] = basis.References.DeepClone() },
            ["candidate"] = new JsonObject { ["modelSha256"] = candidate.ModelSha256, ["ms"] = candidate.Ms, ["references"] = candidate.References.DeepClone() },
        };
        DurableJson.WriteBytes(file, System.Text.Encoding.UTF8.GetBytes(document.ToJsonString()));
        return file;
    }

    /// <summary>Registers the inventories of a sidecar written under this same runtime (another runtime's is ignored).
    /// Never throws: an unreadable sidecar only means a read.</summary>
    public static bool ReadSidecar(string? file)
    {
        try
        {
            if (string.IsNullOrEmpty(file) || !File.Exists(file) || Runtime() is not { } runtime) return false;
            var document = JsonNode.Parse(File.ReadAllText(file)) as JsonObject;
            if (document?["schema"]?.ToString() != SidecarSchema || document["runtime"]?.ToString() != runtime) return false;
            foreach (var part in new[] { "base", "candidate" })
                if (document[part] is JsonObject entry && entry["modelSha256"]?.ToString() is { Length: 64 } sha && entry["references"] is JsonArray references)
                    Remember(sha, references, HotModule.Number(entry["ms"]), "sidecar:" + part);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException) { return false; }
    }

    /// <summary>The producer references of a loaded module in ReferenceInventory's shape: label, producer key, kind,
    /// ReferenceHash and the exports (the top-level reference elements under each reference: name, native type, original
    /// key), read from the model in memory. The same reads as ReferenceInventory.ReadCore on a loaded file, through the
    /// properties' names (this file compiles in both lanes).</summary>
    internal static JsonArray Of(ESpace espace)
    {
        var list = new List<ModuleReferenceEntry>();
        foreach (var reference in espace.References)
        {
            var exports = new List<ReferencedExport>();
            foreach (var export in Exports(reference))
                exports.Add(new ReferencedExport(ModelHost.Prop(export, "Name")?.ToString() ?? "", export.GetType().Name, ModelHost.Prop(export, "OriginalKey")?.ToString() ?? ""));
            list.Add(new ModuleReferenceEntry(ModelHost.Prop(reference, "Name")?.ToString() ?? "", ModelHost.Prop(reference, "ReferenceKey")?.ToString() ?? "",
                ModelHost.Prop(reference, "ReferenceKind")?.ToString() ?? "", ModelHost.Prop(reference, "ReferenceHash")?.ToString() ?? "", exports));
        }
        return ReferenceClosure.ToJson(list);
    }

    private static IEnumerable<AbstractObject> Exports(AbstractObject root)
    {
        foreach (var child in root.DirectChildren)
        {
            if (child.GetType().GetInterfaces().Any(i => i.Name == "ITopLevelReferenceElement")) yield return child;
            foreach (var nested in Exports(child)) yield return nested;
        }
    }

    /// <summary>The inventory of <paramref name="espace"/> with its cost, or null (and logged) when it cannot be read here.</summary>
    internal static (JsonArray References, long Ms)? TryOf(ESpace espace, Action<string>? log)
    {
        var sw = Stopwatch.StartNew();
        try { return (Of(espace), sw.ElapsedMilliseconds); }
        catch (Exception ex) { log?.Invoke("  reference inventory not read from the model: " + ex.GetType().Name + ": " + ex.Message); return null; }
    }
}
