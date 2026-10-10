using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// Provenance stamp of one job execution (`anvil-job-provenance/2`), shared by both lanes (this file is compiled into
/// Anvil.Core and Anvil.Core.Odc). What is stamped: the job text; the base the job DECLARES (a fixture, hashed as
/// resolved by the same policy the runner uses, or job:&lt;name&gt;, whose own result carries the rest of the chain);
/// the lane fixture when the lane has one (ODC: one fixture for the whole suite; O11: none, the declared base is the
/// fixture, so `fixtureSha256` is null and the reader compares `baseSha256`); the kernel DLL of this process; the
/// Studio version and the hash of every Studio assembly this process loaded to run the job (the native dependencies
/// effectively used). Not stamped: producers (O11 `reference` ops rebuild them under the work dir; the ODC kernel
/// imports none headless) and anything outside these files.
/// </summary>
public static class JobProvenance
{
    public const string Schema = "anvil-job-provenance/2";

    public static JsonObject Stamp(string suite, string jobPath, string? laneFixture)
    {
        // D3: an array job is {ops:[...]} (no declared base).
        var job = JobDocument.Read(jobPath);
        var declaredBase = job["base"] is JsonValue b && b.TryGetValue<string>(out var given) ? given : "tests/fixtures/blank-service.oml";
        var baseIsJob = declaredBase.StartsWith("job:", StringComparison.Ordinal);
        var runtime = StudioAdapter.Runtime;
        return new JsonObject
        {
            ["schema"] = Schema,
            ["suite"] = suite, ["at"] = DateTime.UtcNow.ToString("o"),
            ["platform"] = runtime.Platform, ["ideVersion"] = runtime.IdeVersion, ["studioDirectory"] = runtime.StudioDirectory,
            ["jobSha256"] = Sha256(jobPath),
            ["base"] = declaredBase, ["baseKind"] = baseIsJob ? "job" : "fixture",
            ["baseSha256"] = baseIsJob ? null : Sha256(JobSources.FixturePath(declaredBase, Path.GetDirectoryName(jobPath)!, "base")),
            ["fixtureSha256"] = laneFixture != null && File.Exists(laneFixture) ? Sha256(laneFixture) : null,
            ["fixtureNote"] = laneFixture == null ? "no lane fixture on this lane: the declared base (baseSha256) is the fixture the job ran against" : null,
            ["kernelSha256"] = Sha256(typeof(ModelSession).Assembly.Location),
            ["nativeAssemblies"] = LoadedStudioAssemblies(runtime.StudioDirectory),
        };
    }

    public static string Sha256(string file) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();

    private static readonly Dictionary<string, string> AssemblyHashes = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Path (relative to the Studio directory; plugins live in subfolders) and sha256 of every assembly loaded
    /// from that directory in this process (the native dependencies the job really ran against), hashed once per file
    /// per process.</summary>
    public static JsonObject LoadedStudioAssemblies(string studioDirectory)
    {
        var dir = Path.TrimEndingDirectorySeparator(studioDirectory) + Path.DirectorySeparatorChar;
        var stamp = new JsonObject();
        var loaded = AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location) && a.Location.StartsWith(dir, StringComparison.OrdinalIgnoreCase))
            .Select(a => a.Location).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(l => l, StringComparer.OrdinalIgnoreCase);
        lock (AssemblyHashes)
            foreach (var location in loaded)
            {
                if (!AssemblyHashes.TryGetValue(location, out var hash)) AssemblyHashes[location] = hash = Sha256(location);
                stamp[Path.GetRelativePath(dir, location).Replace('\\', '/')] = hash;
            }
        return stamp;
    }
}
