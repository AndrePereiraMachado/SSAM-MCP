using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>A module download answered through the published-OML cache: the fields of <see cref="DownloadResult"/> plus
/// whether the cache served it, the file's SHA-256 and the cached file.</summary>
public sealed record CachedDownload(string Name, string Key, string Kind, int VersionId, long Bytes, string? FilePath,
    DateTime UploadDate, string? UploadUser, bool IsPublishedVersion, long ElapsedMs, string Status,
    bool Cached, string? Sha256 = null, string? CachePath = null);

/// <summary>
/// K1-c of the atritos 3 package (C06): the published OML of a module version is downloaded once. 394 downloads in one
/// session, 289 of a version already downloaded (4,376 s). The version is resolved first (the requested one, else the
/// published one of the catalog, a cheap read of the same session); the cache is
/// &lt;cache&gt;/&lt;moduleKey&gt;/&lt;versionId&gt;.oml with &lt;versionId&gt;.json {module, key, versionId, sha256, storedAt}.
/// A hit checks the recorded SHA-256 and copies the file to the output folder; a cached file is never overwritten (a
/// file whose bytes no longer match is not served and stays). A miss downloads once into the output folder and stores
/// the copy. A version that cannot be resolved, or a module that is not an eSpace, is downloaded as before, uncached.
/// </summary>
public static class PublishedOmlCache
{
    public static CachedDownload Download(string cacheRoot, ModuleSummary module, int? versionId, string? outputDirectory,
        Func<ModuleSummary, string?, int?, DownloadResult> download, Func<string, int>? latestVersion = null, Action<string>? log = null)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var vid = versionId ?? module.VersionId;
        if (vid <= 0 && latestVersion != null && string.Equals(module.Kind, "eSpace", StringComparison.OrdinalIgnoreCase)) vid = latestVersion(module.Key);
        if (vid <= 0 || !string.Equals(module.Kind, "eSpace", StringComparison.OrdinalIgnoreCase) || outputDirectory == null)
            return Wrap(download(module, outputDirectory, versionId), false, null, null);
        var folder = Path.Combine(Path.GetFullPath(cacheRoot), SafeKey(module.Key));
        var cached = Path.Combine(folder, vid + ".oml"); var meta = Path.Combine(folder, vid + ".json");
        if (Hit(cached, meta) is { } recorded)
        {
            Directory.CreateDirectory(outputDirectory);
            var target = Path.Combine(outputDirectory, HeadlessSession.SafeFileName(module.Name) + ".oml");
            File.Copy(cached, target, overwrite: true);
            log?.Invoke($"{module.Name} v{vid}: served from the published-OML cache ({cached})");
            return new CachedDownload(module.Name, module.Key, module.Kind, vid, new FileInfo(target).Length, target,
                recorded["uploadDate"] is { } date && DateTime.TryParse(date.ToString(), null, System.Globalization.DateTimeStyles.RoundtripKind, out var at) ? at : default,
                recorded["uploadUser"]?.ToString(), recorded["isPublishedVersion"]?.GetValue<bool>() ?? false, clock.ElapsedMilliseconds, "ok",
                Cached: true, Sha256: recorded["sha256"]!.ToString(), CachePath: cached);
        }
        var result = download(module, outputDirectory, vid);
        if (result.Status != "ok" || result.FilePath == null || !File.Exists(result.FilePath)) return Wrap(result, false, null, null);
        var sha = Sha256(result.FilePath);
        string? stored = null;
        try { stored = Store(folder, cached, meta, result, vid, sha); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { log?.Invoke("published-OML cache not written: " + ex.Message); }
        return Wrap(result, false, sha, stored);
    }

    /// <summary>The recorded entry when both files exist and the cached bytes still have the recorded SHA-256.</summary>
    private static JsonObject? Hit(string cached, string meta)
    {
        try
        {
            if (!File.Exists(cached) || !File.Exists(meta)) return null;
            var recorded = JsonNode.Parse(File.ReadAllText(meta)) as JsonObject;
            return recorded?["sha256"]?.ToString() is { Length: 64 } sha && sha.Equals(Sha256(cached), StringComparison.OrdinalIgnoreCase) ? recorded : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { return null; }
    }

    /// <summary>Copies the downloaded file into the cache under a temporary name and moves it in without overwriting; the
    /// entry is written once. Another process that stored the same version first wins; its file stays.</summary>
    private static string? Store(string folder, string cached, string meta, DownloadResult result, int vid, string sha)
    {
        Directory.CreateDirectory(folder);
        if (!File.Exists(cached))
        {
            var temporary = cached + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.Copy(result.FilePath!, temporary);
            try { File.Move(temporary, cached); }
            catch (IOException) when (File.Exists(cached)) { File.Delete(temporary); }
        }
        if (!Sha256(cached).Equals(sha, StringComparison.OrdinalIgnoreCase)) return null;   // another version of the bytes: never replaced
        if (!File.Exists(meta))
        {
            var entry = new JsonObject { ["module"] = result.Name, ["key"] = result.Key, ["versionId"] = vid, ["sha256"] = sha,
                ["storedAt"] = DateTime.UtcNow.ToString("O"), ["uploadDate"] = result.UploadDate.ToString("O"), ["uploadUser"] = result.UploadUser,
                ["isPublishedVersion"] = result.IsPublishedVersion };
            var temporary = meta + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, entry.ToJsonString());
            try { File.Move(temporary, meta); }
            catch (IOException) when (File.Exists(meta)) { File.Delete(temporary); }
        }
        return cached;
    }

    private static CachedDownload Wrap(DownloadResult r, bool cached, string? sha, string? cachePath)
        => new(r.Name, r.Key, r.Kind, r.VersionId, r.Bytes, r.FilePath, r.UploadDate, r.UploadUser, r.IsPublishedVersion, r.ElapsedMs, r.Status,
            cached, sha, cachePath);

    private static string SafeKey(string key)
        => new(key.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());

    private static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
