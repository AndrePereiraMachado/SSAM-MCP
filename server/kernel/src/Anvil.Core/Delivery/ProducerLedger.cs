using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// F5, the family rule of producer signatures (analysis of 2026-10-12, VisitaCerta: 39% of the SSAM write time was the
/// same producer, same published version 6773, attested again on every round). A producer signature is reused while its
/// identity did not change: the environment, the producer and its published state (the module or extension version, or
/// for a system producer the signature hash the referenceable catalog advertises). The ledger keeps, per workspace, the
/// last server observation of that identity and the publications SSAM made, next to the producer captures
/// (<see cref="ProducerCache"/>, the same folder):
///   observed/&lt;id&gt;.json   {schema, environment, producer, key, guard, versionId, advertisedSignatureHash, observedAtUtc, source}
///   published/&lt;id&gt;.json  {schema, environment, module, key, publishedAtUtc, source, publicationId, endedAtUtc?}
///   publishing/&lt;id&gt;.&lt;publicationId&gt;.json  {schema, environment, module, publicationId, startedAtUtc, source}: in flight
/// id = the first 40 hex of SHA-256("environment\nproducer"), both trimmed and lower case. Plain JSON, written whole through
/// a temporary file, so the facade (platforms/odc/facade/producer-signatures.mjs, the same rule) reads and writes the same
/// files: it records the start and the end of every publication SSAM makes (o11_publish, o11_extension, refresh-refs
/// --publish, Service Center extension and solution publish, the debugger's publication, ODC publications).
/// The rule (<see cref="Trust"/>): an envelope's identity counts as observed, with no server call, when the last observation
/// in this workspace is of the same environment, producer and published state, it is not older than the window
/// (ANVIL_PRODUCER_TRUST_SECONDS, default 1800; 0 turns the rule off) and it was made after the end of every publication of
/// that producer SSAM recorded (<see cref="UnsafeUntil"/>): never inside one, never while one runs (a publication whose end
/// is not recorded counts as running for <see cref="MaxPublication"/>). Never another environment. The write itself is never covered:
/// the delivery observes every producer on the server right before the merge (one read-only lease for all of them), and a
/// producer that changed there drops its observation and its captures, so the next round captures it again. A lost or
/// unreadable file only means a server observation.
/// </summary>
public sealed class ProducerLedger
{
    public const string ObservedSchema = "ssam-producer-observed/1";
    public const string PublishedSchema = "ssam-producer-published/1";
    public const string PublishingSchema = "ssam-producer-publishing/1";
    public const string WindowVariable = "ANVIL_PRODUCER_TRUST_SECONDS";
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(30);
    /// <summary>How long a publication whose end was not recorded counts as running (the facade's MAX_PUBLICATION_MS).</summary>
    public static readonly TimeSpan MaxPublication = TimeSpan.FromHours(2);
    /// <summary>Clock skew tolerated between the processes that write the ledger (an observation "from the future").</summary>
    private static readonly TimeSpan Skew = TimeSpan.FromMinutes(1);

    public string DirectoryPath { get; }
    public TimeSpan Window { get; }

    public ProducerLedger(string directory, TimeSpan? window = null)
    {
        DirectoryPath = Path.GetFullPath(directory);
        Window = window ?? WindowFromEnvironment();
    }

    /// <summary>The ledger of a delivery store: the folder of its producer cache; null when the work folder has none.</summary>
    public static ProducerLedger? ForWork(string workDirectory, TimeSpan? window = null)
        => ProducerCache.ForWork(workDirectory) is { } cache ? new ProducerLedger(cache.DirectoryPath, window) : null;

    public static TimeSpan WindowFromEnvironment()
    {
        var text = Environment.GetEnvironmentVariable(WindowVariable);
        return int.TryParse(text, out var seconds) && seconds >= 0 ? TimeSpan.FromSeconds(seconds) : DefaultWindow;
    }

    public static string Id(string environment, string producer)
        => DurableJson.Hash(environment.Trim().ToLowerInvariant() + "\n" + producer.Trim().ToLowerInvariant())[..40];

    private string ObservedPath(string environment, string producer) => Path.Combine(DirectoryPath, "observed", Id(environment, producer) + ".json");
    private string PublishedPath(string environment, string module) => Path.Combine(DirectoryPath, "published", Id(environment, module) + ".json");
    private string PublishingPath(string environment, string module, string publicationId) => Path.Combine(DirectoryPath, "publishing", Id(environment, module) + "." + publicationId + ".json");

    /// <summary>Records a server observation of the identity (a capture or an attestation that just read it). Never throws:
    /// an observation that cannot be written only costs a server read later.</summary>
    public void Observe(ProducerIdentity identity, string source, DateTime atUtc)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(identity.Environment) || string.IsNullOrWhiteSpace(identity.Producer) || !identity.HasState) return;
            var document = new JsonObject { ["schema"] = ObservedSchema, ["environment"] = identity.Environment, ["producer"] = identity.Producer,
                ["key"] = identity.Key, ["guard"] = identity.Guard, ["versionId"] = identity.VersionId, ["advertisedSignatureHash"] = identity.AdvertisedSignatureHash,
                ["observedAtUtc"] = atUtc.ToUniversalTime().ToString("O"), ["source"] = source };
            DurableJson.WriteBytes(ObservedPath(identity.Environment, identity.Producer), System.Text.Encoding.UTF8.GetBytes(document.ToJsonString()));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
    }

    /// <summary>Drops the observation of a producer (it changed on the server, or could not be observed).</summary>
    public void Forget(string environment, string producer)
    {
        try { var file = ObservedPath(environment, producer); if (File.Exists(file)) File.Delete(file); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
    }

    /// <summary>Records that SSAM starts a publication of the module in the environment: from now until its end
    /// (<see cref="PublicationEnded"/>) no observation of it counts, nor any made before. Answers the publication's id.</summary>
    public string Published(string environment, string module, string? key, string source, DateTime atUtc, string? publicationId = null)
    {
        var id = SafeId(publicationId) is { Length: > 0 } given ? given : Guid.NewGuid().ToString("N");
        try
        {
            var at = atUtc.ToUniversalTime().ToString("O");
            var marker = new JsonObject { ["schema"] = PublishingSchema, ["environment"] = environment, ["module"] = module, ["publicationId"] = id,
                ["startedAtUtc"] = at, ["source"] = source };
            DurableJson.WriteBytes(PublishingPath(environment, module, id), System.Text.Encoding.UTF8.GetBytes(marker.ToJsonString()));
            var document = new JsonObject { ["schema"] = PublishedSchema, ["environment"] = environment, ["module"] = module, ["key"] = key,
                ["publishedAtUtc"] = at, ["source"] = source, ["publicationId"] = id };
            DurableJson.WriteBytes(PublishedPath(environment, module), System.Text.Encoding.UTF8.GetBytes(document.ToJsonString()));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
        return id;
    }

    /// <summary>Records the end of a publication (whatever its outcome): its marker goes and the record keeps the latest end.</summary>
    public void PublicationEnded(string environment, string module, string publicationId, DateTime atUtc)
    {
        try
        {
            var file = PublishedPath(environment, module);
            if (ReadJson(file) is { } record && record["schema"]?.ToString() == PublishedSchema
                && !(Time(record["endedAtUtc"]) is { } before && before >= atUtc.ToUniversalTime()))
            {
                record["endedAtUtc"] = atUtc.ToUniversalTime().ToString("O");
                DurableJson.WriteBytes(file, System.Text.Encoding.UTF8.GetBytes(record.ToJsonString()));
            }
            var marker = PublishingPath(environment, module, SafeId(publicationId));
            if (File.Exists(marker)) File.Delete(marker);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
    }

    /// <summary>Until when no observation of the producer in the environment counts (null: SSAM recorded no publication of
    /// it): the latest end of a finished publication; the start plus <see cref="MaxPublication"/> of one without an end (in
    /// flight, a crash, a server job). A publication of unknown modules ("*" producer) or of an unknown tenant ("*"
    /// environment) covers it too.</summary>
    public DateTime? UnsafeUntil(string environment, string producer)
    {
        DateTime? until = null;
        void Extend(DateTime value) { if (until == null || value > until) until = value; }
        var ids = new HashSet<string>(new[] { (environment, producer), ("*", producer), (environment, "*"), ("*", "*") }.Select(p => Id(p.Item1, p.Item2)), StringComparer.Ordinal);
        foreach (var id in ids)
        {
            var record = ReadJson(Path.Combine(DirectoryPath, "published", id + ".json"));
            if (record?["schema"]?.ToString() != PublishedSchema || Time(record["publishedAtUtc"]) is not { } start) continue;
            Extend(Time(record["endedAtUtc"]) is { } end && end >= start ? end : start + MaxPublication);
        }
        try
        {
            var folder = Path.Combine(DirectoryPath, "publishing");
            if (Directory.Exists(folder))
                foreach (var file in Directory.EnumerateFiles(folder, "*.json"))
                {
                    var name = Path.GetFileName(file);
                    if (name.Length < 42 || name[40] != '.' || !ids.Contains(name[..40])) continue;
                    var marker = ReadJson(file);
                    if (marker?["schema"]?.ToString() == PublishingSchema && Time(marker["startedAtUtc"]) is { } start) Extend(start + MaxPublication);
                }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return until;
    }

    private static DateTime? Time(JsonNode? node)
        => DateTime.TryParse(node?.ToString(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var at)
            ? at.ToUniversalTime() : null;

    private static string SafeId(string? id) => new string((id ?? "").Where(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-').Take(64).ToArray());

    /// <summary>The observation that covers this identity now, or null with the reason it does not (no observation, another
    /// published state, too old, published since, a publication in flight, rule off).</summary>
    public LedgerTrust? Trust(ProducerIdentity identity, DateTime nowUtc, out string reason)
    {
        reason = "";
        if (Window <= TimeSpan.Zero) { reason = "rule-off"; return null; }
        if (!identity.HasState) { reason = "no-published-state"; return null; }
        var observed = ReadJson(ObservedPath(identity.Environment, identity.Producer));
        if (observed?["schema"]?.ToString() != ObservedSchema) { reason = "not-observed"; return null; }
        var seen = ProducerIdentity.OfLedger(observed);
        if (seen == null || !string.Equals(seen.Environment, identity.Environment, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(seen.Producer, identity.Producer, StringComparison.OrdinalIgnoreCase)) { reason = "not-observed"; return null; }
        if (!seen.SameState(identity)) { reason = "another-version"; return null; }
        if (!DateTime.TryParse(observed["observedAtUtc"]?.ToString(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var at)) { reason = "not-observed"; return null; }
        at = at.ToUniversalTime(); nowUtc = nowUtc.ToUniversalTime();
        if (at > nowUtc + Skew || nowUtc - at > Window) { reason = "observation-too-old"; return null; }
        // Never an observation made before the end of a publication SSAM recorded, nor while one runs (its end unknown).
        if (UnsafeUntil(identity.Environment, identity.Producer) is { } unsafeUntil && at <= unsafeUntil)
        { reason = unsafeUntil > nowUtc ? "publication-in-progress" : "published-since"; return null; }
        return new LedgerTrust(at, observed["source"]?.ToString() ?? "");
    }

    private static JsonObject? ReadJson(string file)
    {
        try { return File.Exists(file) ? JsonNode.Parse(File.ReadAllText(file)) as JsonObject : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { return null; }
    }
}

/// <summary>When and how the ledger saw the identity it vouches for.</summary>
public sealed record LedgerTrust(DateTime ObservedAtUtc, string Source);

/// <summary>F5 for `anvil signature --out &lt;lane .local&gt;/...` (o11_job captureProducers): the same cache and ledger as the
/// deliveries, so a capture of a job round is reused by the next round or delivery and the other way round.</summary>
public static class SignatureReuse
{
    /// <summary>The cached capture of the producer in the environment that covers the elements, copied to outPath, when the
    /// ledger vouches for its published state: the cached receipt with avsigPath/avsigSha256 of the copy, reused:true and
    /// observed {by:"ledger", observedAtUtc}; null otherwise (the caller captures). No server call.</summary>
    public static JsonObject? Reuse(string outPath, string environment, string producer, IReadOnlyList<string> elements, DateTime nowUtc)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(environment) || ProducerCache.ForLocalFile(outPath) is not { } cache) return null;
            if (cache.FindCovering(environment, producer, elements) is not { } cached) return null;
            if (ProducerIdentity.ReadEnvelope(cached.Path) is not { } identity || !string.Equals(identity.Environment, environment, StringComparison.OrdinalIgnoreCase)) return null;
            if (new ProducerLedger(cache.DirectoryPath).Trust(identity, nowUtc, out _) is not { } trust) return null;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
            File.Copy(cached.Path, outPath, overwrite: true);
            var receipt = cached.Receipt.DeepClone().AsObject();
            receipt["avsigPath"] = Path.GetFullPath(outPath); receipt["avsigSha256"] = DeliveryReceipt.Hash(outPath);
            receipt["reused"] = true; receipt["observed"] = new JsonObject { ["by"] = "ledger", ["observedAtUtc"] = trust.ObservedAtUtc.ToString("O") };
            // Nothing read the server now: the candidate built on this signature is not valid for a merge as it is. o11_deliver
            // observes every producer on the server right before its merge; any other merge must capture the producer again.
            receipt["mergeReady"] = false;
            receipt["beforeMerge"] = "observe the producer on the server (o11_deliver does it right before its merge; a direct OML merge does not)";
            return receipt;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or System.Text.Json.JsonException) { return null; }
    }

    /// <summary>A capture the caller just made goes to the cache and its observation to the ledger. Never throws.</summary>
    public static void Remember(string outPath, string environment, string producer, IReadOnlyList<string> elements, JsonObject receipt, DateTime nowUtc)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(environment) || ProducerCache.ForLocalFile(outPath) is not { } cache || !File.Exists(outPath)) return;
            cache.Store(environment, producer, elements, outPath, receipt);
            if (ProducerIdentity.OfReceipt(receipt, environment) is { } fresh) new ProducerLedger(cache.DirectoryPath).Observe(fresh, "capture", nowUtc);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or System.Text.Json.JsonException) { }
    }
}

/// <summary>F5: what one delivery call observed of its producer signatures on the server (a fresh capture, the attestation
/// of a cached one), by the task's file, with the ledger and the producer cache of its workspace (both null outside a lane
/// work folder: then every signature is observed on the server, as before).</summary>
public sealed class SignatureObservations(ProducerLedger? ledger, ProducerCache? cache)
{
    private readonly Dictionary<string, (string By, DateTime AtUtc)> seen = new(StringComparer.OrdinalIgnoreCase);
    public ProducerLedger? Ledger { get; } = ledger;
    public ProducerCache? Cache { get; } = cache;
    public void Saw(string path, string by, DateTime atUtc) => seen[Path.GetFullPath(path)] = (by, atUtc.ToUniversalTime());
    public (string By, DateTime AtUtc)? Seen(string path) => seen.TryGetValue(Path.GetFullPath(path), out var found) ? found : null;
    /// <summary>A producer whose published state changed on the server: its observation and every cached capture of it go,
    /// so the next round captures it again.</summary>
    public void Changed(ProducerIdentity identity)
    {
        Ledger?.Forget(identity.Environment, identity.Producer);
        try { Cache?.RemoveProducer(identity.Environment, identity.Producer); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}

/// <summary>A producer's identity and published state: the environment, the producer (its catalog name; the key when known),
/// the guard (module-version, extension-version or signature-hash) and the version, or for signature-hash the advertised hash.</summary>
public sealed record ProducerIdentity(string Environment, string Producer, string? Key, string? Guard, int? VersionId, string? AdvertisedSignatureHash)
{
    /// <summary>A published state the rule can compare: a version for the version guards, the advertised hash for (System).</summary>
    public bool HasState => Guard == "signature-hash" ? !string.IsNullOrWhiteSpace(AdvertisedSignatureHash) : !string.IsNullOrWhiteSpace(Guard) && VersionId != null;

    public bool SameState(ProducerIdentity other)
        => string.Equals(Guard, other.Guard, StringComparison.Ordinal)
           && (Guard == "signature-hash" ? SameHash(AdvertisedSignatureHash, other.AdvertisedSignatureHash) : VersionId == other.VersionId && VersionId != null);

    /// <summary>The identity an attested .avsig claims, read as plain JSON (no model assembly is loaded); null when the file
    /// is not an attested server signature.</summary>
    public static ProducerIdentity? ReadEnvelope(string path)
    {
        try
        {
            if (JsonNode.Parse(File.ReadAllText(path)) is not JsonObject envelope || envelope["Attestation"] is not JsonObject attestation) return null;
            if (attestation["Source"]?.ToString() != "server-signature") return null;
            var environment = envelope["Environment"]?.ToString(); var name = envelope["Name"]?.ToString();
            if (string.IsNullOrWhiteSpace(environment) || string.IsNullOrWhiteSpace(name)) return null;
            return new ProducerIdentity(environment, name, envelope["ModuleKey"]?.ToString(), attestation["Guard"]?.ToString(),
                Int(attestation["VersionId"]), attestation["AdvertisedSignatureHash"]?.ToString());
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException) { return null; }
    }

    /// <summary>The identity a capture receipt (ProducerSignatureCapture.Capture) observed.</summary>
    public static ProducerIdentity? OfReceipt(JsonObject? receipt, string environment)
        => receipt?["producer"]?.ToString() is { Length: > 0 } producer
            ? new ProducerIdentity(receipt["environment"]?.ToString() ?? environment, producer, receipt["key"]?.ToString(), receipt["guard"]?.ToString(),
                Int(receipt["versionIdBefore"]), receipt["advertisedSignatureHash"]?.ToString())
            : null;

    /// <summary>The identity an attestation (ProducerSignatureCapture.Attest) observed.</summary>
    public static ProducerIdentity? OfAttestation(JsonObject? observed, string environment, string? key)
        => observed?["producer"]?.ToString() is { Length: > 0 } producer
            ? new ProducerIdentity(observed["environment"]?.ToString() ?? environment, producer, key, observed["guard"]?.ToString(),
                Int(observed["versionId"]), observed["advertisedSignatureHash"]?.ToString())
            : null;

    internal static ProducerIdentity? OfLedger(JsonObject observed)
        => observed["environment"]?.ToString() is { Length: > 0 } environment && observed["producer"]?.ToString() is { Length: > 0 } producer
            ? new ProducerIdentity(environment, producer, observed["key"]?.ToString(), observed["guard"]?.ToString(), Int(observed["versionId"]),
                observed["advertisedSignatureHash"]?.ToString())
            : null;

    private static int? Int(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        if (value.TryGetValue<int>(out var number)) return number;
        if (value.TryGetValue<long>(out var wide) && wide is >= int.MinValue and <= int.MaxValue) return (int)wide;
        return int.TryParse(value.ToString(), out var parsed) ? parsed : null;
    }

    private static bool SameHash(string? left, string? right)
        => Guid.TryParse(left, out var l) && Guid.TryParse(right, out var r) ? l == r
            : !string.IsNullOrWhiteSpace(left) && string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}
