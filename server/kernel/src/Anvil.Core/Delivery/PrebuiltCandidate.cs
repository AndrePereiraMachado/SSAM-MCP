using System.Security.Cryptography;
using System.Text.Json.Nodes;
namespace Anvil.Core.Delivery;

/// <summary>The candidate the BUILD phase of a delivery made headless, outside the Studio lock (lane wp of the atritos 3
/// package: platforms/odc/facade/o11-build-phase.mjs runs `anvil apply` on a capture of the module taken by its key). The
/// APPLY phase (`deliver --prebuilt manifest.json`, under the Studio lock) takes its own registered snapshot as always and
/// reuses that candidate only when it was built from the same model: the snapshot's model bytes (the OML after its header,
/// <see cref="ModelSha256"/>) equal those of the build's base, the job and every file it reads hash as they did, the
/// producer files are the same, and the same kernel assembly built it. Anything else rebuilds the candidate on the fresh
/// snapshot inside the same call (a rebase): never a merge of a candidate built on another base.
/// Manifest (written by the facade): {schema:"ssam-prebuilt/1", job, base, baseSha256, candidate, candidateSha256,
/// result, producers:{Name:{path, sha256}}}. result is the `&lt;candidate&gt;.result.json` that `apply` wrote (the
/// JobRunner result plus provenance and sources).</summary>
public static class PrebuiltCandidate
{
    public const string Schema = "ssam-prebuilt/1";

    /// <summary>The identity of an OML's model: the SHA-256 of the bytes after its textual header ("OML", a 32-bit
    /// little-endian length N, N header bytes). The Service Studio writes its window state into that header on every save
    /// (the tree selection, the presenter state), so two captures of an unchanged module differ there only: in the 898
    /// captures of the local delivery work of 2026-10-07, 589 raw hashes and 582 model hashes. Any other shape: the SHA-256
    /// of the whole file.</summary>
    public static string ModelSha256(string path)
    {
        var bytes = File.ReadAllBytes(path);
        if (bytes.Length >= 7 && bytes[0] == (byte)'O' && bytes[1] == (byte)'M' && bytes[2] == (byte)'L')
        {
            var length = BitConverter.ToUInt32(bytes, 3);
            if (length <= (uint)(bytes.Length - 7))
                return Convert.ToHexString(SHA256.HashData(bytes.AsSpan(7 + (int)length))).ToLowerInvariant();
        }
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    /// <summary>The prebuilt apply result for this delivery's apply (the candidate copied to outputPath, the result with
    /// prebuilt {reused:true}), or null with the reason it cannot be reused. kernelAssembly: the file of the kernel that
    /// would apply now (null skips that check, for tests).</summary>
    public static JsonObject? TryReuse(string manifestPath, string basePath, string jobPath, string outputPath,
        IReadOnlyDictionary<string, string>? producers, string? kernelAssembly, out string reason)
    {
        reason = "";
        JsonObject manifest;
        try { manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject(); }
        catch (Exception ex) { reason = "manifest-unreadable: " + ex.Message; return null; }
        if (manifest["schema"]?.ToString() != Schema) { reason = "manifest-schema"; return null; }
        string Need(string name) => manifest[name]?.ToString() is { Length: > 0 } value ? value : throw new InvalidDataException("missing " + name);
        try
        {
            var buildBase = Need("base"); var candidate = Need("candidate"); var resultPath = Need("result");
            if (!File.Exists(buildBase) || DeliveryReceipt.Hash(buildBase) != Need("baseSha256").ToLowerInvariant()) { reason = "build-base-changed"; return null; }
            if (!File.Exists(candidate) || DeliveryReceipt.Hash(candidate) != Need("candidateSha256").ToLowerInvariant()) { reason = "candidate-changed"; return null; }
            if (!string.Equals(Path.GetFullPath(Need("job")), Path.GetFullPath(jobPath), StringComparison.OrdinalIgnoreCase)) { reason = "job-path"; return null; }
            if (ModelSha256(buildBase) != ModelSha256(basePath)) { reason = "base-changed"; return null; }
            var result = JsonNode.Parse(File.ReadAllText(resultPath))!.AsObject();
            if (result["isValid"]?.GetValue<bool>() != true || result["accepted"]?.GetValue<bool>() != true) { reason = "build-not-accepted"; return null; }
            if (result["patchesApplied"] is JsonArray { Count: > 0 })
            {
                var job = JobDocument.Parse(jobPath);
                var jobDisabled = job is JsonObject document && document["autoPatch"] is JsonValue policy
                    && policy.TryGetValue<bool>(out var enabled) && !enabled;
                if (JobPreflight.AutoPatch.Value == false || jobDisabled) { reason = "auto-patch-disabled"; return null; }
            }
            // The job and every file it reads (composite parts, html sources, producers named by job:) as the build read them.
            if (result["sources"] is not JsonArray built || !JsonNode.DeepEquals(Normalized(built), Normalized(DeliveryReceipt.Sources(jobPath)))) { reason = "job-changed"; return null; }
            if (!SameProducers(manifest["producers"] as JsonObject, producers)) { reason = "producers-changed"; return null; }
            if (kernelAssembly != null && result["provenance"]?["kernelSha256"]?.ToString() != JobProvenance.Sha256(kernelAssembly)) { reason = "kernel-changed"; return null; }
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
            File.Copy(candidate, outputPath, overwrite: true);
            if (DeliveryReceipt.Hash(outputPath) != Need("candidateSha256").ToLowerInvariant()) { reason = "copy-differs"; return null; }
            result.Remove("provenance"); result.Remove("sources");
            result["prebuilt"] = new JsonObject { ["reused"] = true, ["candidate"] = candidate, ["manifest"] = Path.GetFullPath(manifestPath) };
            return result;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException)
        { reason = "manifest-invalid: " + ex.Message; return null; }
    }

    /// <summary>The apply of a delivery with a prebuilt manifest: the prebuilt result when it can be reused, else the
    /// fresh apply with prebuilt {reused:false, reason} (the rebase, in the same call).</summary>
    public static JsonObject Apply(string? manifestPath, string basePath, string jobPath, string outputPath,
        IReadOnlyDictionary<string, string>? producers, string? kernelAssembly, Func<JsonObject> apply, Action<string>? log = null)
    {
        if (string.IsNullOrEmpty(manifestPath)) return apply();
        var reused = TryReuse(manifestPath, basePath, jobPath, outputPath, producers, kernelAssembly, out var reason);
        if (reused != null) { log?.Invoke("deliver: prebuilt candidate reused (built outside the Studio lock)"); return reused; }
        log?.Invoke("deliver: prebuilt candidate not reused (" + reason + "); applying on the fresh snapshot");
        var fresh = apply();
        fresh["prebuilt"] = new JsonObject { ["reused"] = false, ["reason"] = reason };
        return fresh;
    }

    private static JsonArray Normalized(JsonArray files)
    {
        var list = files.OfType<JsonObject>()
            .Select(f => (Path: Path.GetFullPath(f["path"]?.ToString() ?? "").ToLowerInvariant(), Sha: f["sha256"]?.ToString()?.ToLowerInvariant() ?? ""))
            .OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
        var array = new JsonArray();
        foreach (var (path, sha) in list) array.Add(new JsonObject { ["path"] = path, ["sha256"] = sha });
        return array;
    }

    private static bool SameProducers(JsonObject? recorded, IReadOnlyDictionary<string, string>? now)
    {
        var current = now ?? new Dictionary<string, string>();
        var built = recorded ?? new JsonObject();
        if (built.Count != current.Count) return false;
        foreach (var (name, file) in current)
        {
            if (built.FirstOrDefault(p => string.Equals(p.Key, name, StringComparison.OrdinalIgnoreCase)).Value is not JsonObject entry) return false;
            if (!string.Equals(Path.GetFullPath(entry["path"]?.ToString() ?? ""), Path.GetFullPath(file), StringComparison.OrdinalIgnoreCase)) return false;
            if (!File.Exists(file) || entry["sha256"]?.ToString()?.ToLowerInvariant() != DeliveryReceipt.Hash(file)) return false;
        }
        return true;
    }
}
