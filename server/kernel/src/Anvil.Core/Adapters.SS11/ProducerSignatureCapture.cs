using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using OutSystems.Communication.ServiceCenter;

namespace Anvil.Core;

/// <summary>Typed refusal of a producer signature capture or re-attestation. Code is one of NotReadOnly, ProducerNotFound,
/// IdentityMismatch, NotActive, VersionIdChanged, SignatureHashChanged, SignatureUnavailable, ElementNotFound, WrongEnvironment.
/// Requested elements the signature does not show are not one of these: they come all at once as the KernelRefusalException
/// PRODUCER_SIGNATURE_MISSING, one problem per element with its cause (A25).</summary>
public sealed class SignatureCaptureException(string code, string message) : InvalidOperationException(code + ": " + message)
{
    public string Code { get; } = code;
}

public sealed record SignatureCaptureRequest(string Producer, IReadOnlyList<string> Elements, string OutPath,
    string? Key = null, string? Kind = null, bool PinXif = false, bool ListOnly = false,
    int Offset = 0, int Limit = 100, string? ExpectedSignatureHash = null);

/// <summary>
/// Read-only acquisition of a producer's public signature through the Studio's own login (Manage Dependencies without
/// the dialog). Contract: docs/tasks/2026-09-26-o11-capacidades-headless.md section 2.1. The session must be a
/// read-only lease; the published version (or, for system producers, the advertised signature hash) is observed
/// before and after the signature read, the requested Tipo:Nome are resolved against the payload itself, and the
/// capture is written as an attested FormatVersion 2 envelope the delivery re-observes before merging. No write
/// operation is issued; the optional .xif stays next to the envelope and is identified only by its SHA-256.
/// </summary>
public static class ProducerSignatureCapture
{
    private sealed record Observation(int? VersionId, bool? IsActive, string Guard, string AdvertisedHash);

    public static JsonObject Capture(HeadlessSession session, SignatureCaptureRequest request, Action<string>? log = null)
    {
        ArgumentNullException.ThrowIfNull(session); ArgumentNullException.ThrowIfNull(request);
        if (!session.IsReadOnly) throw new SignatureCaptureException("NotReadOnly", "the signature capture requires a read-only environment lease");
        var outPath = request.ListOnly ? "" : Path.GetFullPath(request.OutPath);
        if (!request.ListOnly && !outPath.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("--out must name a .avsig file");
        if(request.ListOnly && request.PinXif)throw new ArgumentException("Listing does not download an extension");
        if(request.ListOnly && (request.Offset<0 || request.Limit is <1 or >500))throw new ArgumentException("Listing requires offset >= 0 and limit 1..500");
        if(request.ListOnly && request.Offset>0 && request.ExpectedSignatureHash==null)
            throw new ArgumentException("Subsequent pages require --expected-signature-hash from the first page");
        var environment = session.Host;
        var producer = Identity(session, request.Producer, request.Key, request.Kind);
        var before = Observe(session, producer);
        if (before.IsActive == false) throw new SignatureCaptureException("NotActive", producer.Name + " is not active in " + environment);
        var info = session.GetReferenceSignature(producer.Key, producer.Kind);
        if (info == null || info.SignatureBinary is not { Length: > 0 })
            throw new SignatureCaptureException("SignatureUnavailable", producer.Name + ": the environment returned no signature"
                + (session.LastRestError is { } rest ? " (REST: " + rest + ")" : "") + "; nothing was written");
        var after = Observe(session, producer);
        if (before.VersionId != after.VersionId)
            throw new SignatureCaptureException("VersionIdChanged", $"{producer.Name} was republished during the capture ({before.VersionId} -> {after.VersionId}); nothing was written");
        if (!SameHash(before.AdvertisedHash, after.AdvertisedHash))
            throw new SignatureCaptureException("SignatureHashChanged", $"{producer.Name} advertised another signature during the capture; nothing was written");
        if (!Keys.Parse(info.Key).Equals(Keys.Parse(producer.Key)) || !string.Equals(info.Kind, producer.Kind, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(info.Name, producer.Name, StringComparison.Ordinal))
            throw new SignatureCaptureException("IdentityMismatch", $"the signature returned for {producer.Name} names another producer ({info.Name}, {info.Kind})");
        // Recorded, not enforced: whether the catalog and the signature service report the same hash is a live observation
        // still to be made (docs/proofs/2026-09-26-o11-manage-dependencies.md); the guard is the before/after stability above.
        var advertisedMatches = SameHash(before.AdvertisedHash, info.SignatureHash.ToString());

        if(request.ListOnly) {
            if(request.ExpectedSignatureHash is { } expected && !SameHash(expected,info.SignatureHash.ToString()))
                throw new SignatureCaptureException("SignatureHashChanged","The producer changed between pages; start a new listing");
            // The server's SignatureHash is an opaque revision guard, not the hash of
            // the local signature fragment (see SignatureFixtures). Element hashes are validated by the reader.
            var available=NativeDependencyReader.ListServerSignature(info.Key,info.Name,info.SignatureBinary);
            return new JsonObject { ["producer"]=producer.Name,["key"]=Keys.ToStudio(producer.Key),["kind"]=producer.Kind,
                ["environment"]=environment,["versionId"]=before.VersionId,["signatureHash"]=info.SignatureHash.ToString(),
                ["readOnly"]=true,["total"]=available.Count,["offset"]=request.Offset,["limit"]=request.Limit,
                ["nextOffset"]=request.Offset+request.Limit<available.Count ? request.Offset+request.Limit : null,
                ["elements"]=new JsonArray(available.Skip(request.Offset).Take(request.Limit).Select(e=>(JsonNode)new JsonObject {
                    ["type"]=e.Type,["name"]=e.Name,["path"]=e.Path,["originalKey"]=e.OriginalKey,
                    ["selector"]=e.Type+":"+(e.Path??e.Name),["supported"]=e.Kind!="unsupported",
                    ["signatureImport"]=e.Kind!="unsupported" && NativeReferenceKinds.ForKind(e.Kind).SignatureImport,
                    ["importSource"]=e.Kind=="unsupported" ? null : NativeReferenceKinds.ForKind(e.Kind).SignatureImport ? "avsig-or-oml" : "producer-oml"
                }).ToArray()) };
        }

        NativeSignatureResolution resolution;
        // K1-b: an element named only by its original key ("@key", the owner of a foreign dependency) takes the type the
        // payload itself gives it; a key the payload does not show as a visible export is refused below with the rest.
        var typed = request.Elements.Any(e => e.StartsWith('@') && !e.Contains(':')) ? TypeByKey(info, request.Elements) : request.Elements;
        // Missing elements: PRODUCER_SIGNATURE_MISSING with every element and its cause, before anything is written.
        try { resolution = NativeDependencyReader.ResolveServerSignature(info.Key, info.Name, info.SignatureBinary, typed); }
        catch (KeyNotFoundException missing) { throw new SignatureCaptureException("ElementNotFound", missing.Message.Replace("ElementNotFound: ", "")); }
        var elements = Envelope(resolution);
        var attestation = new NativeReferenceAttestation {
            Source = NativeReferenceAttestation.ServerSignature, VersionId = before.VersionId, IsSystem = IsSystem(producer),
            IsActive = before.IsActive, Guard = before.Guard, AdvertisedSignatureHash = before.AdvertisedHash,
            CapturedAtUtc = DateTime.UtcNow.ToString("O"), Tool = "anvil signature" };
        var snapshot = NativeReferenceCapture.Capture(info, environment, elements, attestation);

        // The .xif is read and its version re-observed before anything is written: a refused pin leaves neither file.
        byte[]? xif = null;
        if (request.PinXif)
        {
            if (!snapshot.IsExtension || before.VersionId is not > 0)
                throw new ArgumentException("--pin-xif applies only to an extension with a published version");
            xif = session.DownloadExtension(producer.Key, before.VersionId.Value);
            var afterDownload = Observe(session, producer);
            if (afterDownload.VersionId != before.VersionId)
                throw new SignatureCaptureException("VersionIdChanged", $"{producer.Name} was republished while its .xif was read; nothing was written");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        snapshot.Write(outPath);
        var avsigSha = Sha256(File.ReadAllBytes(outPath));
        log?.Invoke($"signature {producer.Name}: {info.SignatureBinary.Length} bytes hash={info.SignatureHash} version={before.VersionId?.ToString() ?? "-"} guard={before.Guard} avsig sha256={avsigSha}");

        string? xifPath = null, xifSha = null;
        if (xif != null)
        {
            xifPath = Path.Combine(Path.GetDirectoryName(outPath)!, HeadlessSession.SafeFileName(producer.Name) + "-v" + before.VersionId + ".xif");
            File.WriteAllBytes(xifPath, xif);
            xifSha = Sha256(xif);
            log?.Invoke($"xif {producer.Name} v{before.VersionId}: {xif.Length} bytes sha256={xifSha} (task folder only; never published)");
        }
        static JsonArray Items(IEnumerable<NativeSignatureElement> items) => new(items.Select(e => (JsonNode)new JsonObject {
            ["type"] = e.Type, ["name"] = e.Name, ["path"] = e.Path, ["originalKey"] = e.OriginalKey }).ToArray());
        return new JsonObject {
            ["producer"] = producer.Name, ["key"] = Keys.ToStudio(producer.Key), ["kind"] = producer.Kind, ["system"] = IsSystem(producer),
            ["environment"] = environment, ["guard"] = before.Guard,
            ["versionIdBefore"] = before.VersionId, ["versionIdAfter"] = after.VersionId, ["isActive"] = before.IsActive,
            ["signatureHash"] = info.SignatureHash.ToString(), ["advertisedSignatureHash"] = before.AdvertisedHash,
            ["advertisedMatchesSignature"] = advertisedMatches,
            ["signatureBytes"] = info.SignatureBinary.Length, ["elementSignatures"] = resolution.ElementSignatures,
            ["elements"] = Items(resolution.Elements), ["closure"] = Items(resolution.Closure),
            ["foreignDependencies"] = new JsonArray(resolution.Foreign.Select(f => (JsonNode)f).ToArray()),
            ["unresolvedDependencies"] = new JsonArray(resolution.Unresolved.Select(f => (JsonNode)f).ToArray()),
            ["avsigPath"] = outPath, ["avsigSha256"] = avsigSha, ["xifPath"] = xifPath, ["xifSha256"] = xifSha,
            ["readOnly"] = true
        };
    }

    /// <summary>Re-observes, through a read-only lease, the producer identity an attested envelope claims: same
    /// environment, same key and kind in the referenceable catalog, and the same published version (or, for system
    /// producers, the same advertised signature hash). Offline fixtures are refused before any server call.</summary>
    public static JsonObject Attest(HeadlessSession session, string avsigPath, string environment)
    {
        if (!session.IsReadOnly) throw new SignatureCaptureException("NotReadOnly", "re-attestation requires a read-only environment lease");
        var snapshot = NativeReferenceSnapshot.Read(avsigPath);
        snapshot.RequireDeliverable(environment);
        var attestation = snapshot.Attestation ?? throw new InvalidOperationException("Producer signature has no attestation to re-check: " + snapshot.Name);
        if (!string.Equals(session.Host, environment, StringComparison.OrdinalIgnoreCase))
            throw new SignatureCaptureException("WrongEnvironment", $"the read-only lease is connected to {session.Host}, not {environment}");
        var producer = Identity(session, snapshot.Name, snapshot.ModuleKey, snapshot.IsExtension ? "Extension" : "eSpace");
        var now = Observe(session, producer);
        if (now.Guard != attestation.Guard) throw new SignatureCaptureException("IdentityMismatch", snapshot.Name + " is no longer the kind of producer it was captured as");
        if (now.IsActive == false) throw new SignatureCaptureException("NotActive", snapshot.Name + " is not active in " + environment);
        if (now.Guard == "signature-hash" ? !SameHash(now.AdvertisedHash, attestation.AdvertisedSignatureHash) : now.VersionId != attestation.VersionId)
            throw new SignatureCaptureException(now.Guard == "signature-hash" ? "SignatureHashChanged" : "VersionIdChanged",
                $"{snapshot.Name} changed since its capture ({attestation.VersionId?.ToString() ?? attestation.AdvertisedSignatureHash} -> {now.VersionId?.ToString() ?? now.AdvertisedHash}); capture it again");
        return new JsonObject { ["producer"] = snapshot.Name, ["environment"] = environment, ["guard"] = now.Guard,
            ["versionId"] = now.VersionId, ["advertisedSignatureHash"] = now.AdvertisedHash, ["attested"] = true };
    }

    /// <summary>"@originalKey" entries as "Type:@originalKey", by the visible exports of the payload; a key it does not show
    /// raises ElementNotFound naming every such key.</summary>
    private static IReadOnlyList<string> TypeByKey(ReferenceInfo info, IReadOnlyList<string> elements)
    {
        var visible = NativeDependencyReader.ListServerSignature(info.Key, info.Name, info.SignatureBinary)
            .Where(e => e.Kind != "unsupported").ToDictionary(e => e.OriginalKey, e => e.Type, StringComparer.Ordinal);
        var unknown = elements.Where(e => e.StartsWith('@') && !e.Contains(':') && !visible.ContainsKey(e[1..])).ToArray();
        if (unknown.Length > 0)
            throw new SignatureCaptureException("ElementNotFound", $"{info.Name} shows no visible export with the original key(s) {string.Join(", ", unknown)}");
        return elements.Select(e => e.StartsWith('@') && !e.Contains(':') ? visible[e[1..]] + ":" + e : e).Distinct(StringComparer.Ordinal).ToArray();
    }

    /// <summary>Envelope elements: each requested element with the keys of its same-producer type closure, then the
    /// closure elements themselves (so the import can stub them before the native refresh fills them).</summary>
    internal static NativeReferenceElement[] Envelope(NativeSignatureResolution resolution)
        => resolution.Elements.Select(e => new NativeReferenceElement(e.Kind, e.Name, e.OriginalKey,
                resolution.Requires[e.OriginalKey] is { Length: > 0 } requires ? requires : null, e.ParentKey, e.Path))
            .Concat(resolution.Closure.Select(c => new NativeReferenceElement(c.Kind, c.Name, c.OriginalKey,
                ParentKey:c.ParentKey, Path:c.Path))).ToArray();

    private static ReferenceableSummary Identity(HeadlessSession session, string name, string? key, string? kind)
    {
        var catalog = session.ListReferenceable();
        var matches = catalog.Where(r => key != null ? SameKey(r.Key, key) : string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length == 0) throw new SignatureCaptureException("ProducerNotFound", $"{(string.IsNullOrWhiteSpace(name) ? "producer key " + key : name)} is not referenceable in {session.Host}");
        if (matches.Length > 1) throw new SignatureCaptureException("IdentityMismatch", $"{name} is ambiguous in the referenceable catalog; pass --key");
        var producer = matches[0];
        // A producer named only by its key (K1-b: the owner of a foreign dependency) takes the catalog's name.
        if (key != null && string.IsNullOrWhiteSpace(name)) name = producer.Name;
        if (!string.Equals(producer.Name, name, StringComparison.OrdinalIgnoreCase))
            throw new SignatureCaptureException("IdentityMismatch", $"key {key} belongs to {producer.Name}, not {name}");
        if (kind != null && !string.Equals(producer.Kind, kind, StringComparison.OrdinalIgnoreCase))
            throw new SignatureCaptureException("IdentityMismatch", $"{producer.Name} is {producer.Kind}, not {kind}");
        if (producer.Kind is not ("Extension" or "eSpace")) throw new SignatureCaptureException("IdentityMismatch", $"{producer.Name} has unsupported kind {producer.Kind}");
        return producer;
    }

    /// <summary>Extensions: extensions catalog (VersionId, IsActive). eSpaces: module catalog. System producers expose no
    /// published version to this session, so their guard is the hash the referenceable catalog advertises.</summary>
    private static Observation Observe(HeadlessSession session, ReferenceableSummary producer)
    {
        var advertised = session.ListReferenceable().SingleOrDefault(r => SameKey(r.Key, producer.Key))
            ?? throw new SignatureCaptureException("ProducerNotFound", producer.Name + " left the referenceable catalog");
        if (IsSystem(producer)) return new(null, null, "signature-hash", advertised.SignatureHash);
        var extension = producer.Kind == "Extension";
        var listed = (extension ? session.ListExtensions() : session.ListModules()).Where(m => SameKey(m.Key, producer.Key)).ToArray();
        if (listed.Length != 1)
            throw new SignatureCaptureException("NotActive", $"{producer.Name} has no single published {(extension ? "extension" : "module")} version in {session.Host}");
        return new(listed[0].VersionId, listed[0].IsActive, extension ? "extension-version" : "module-version", advertised.SignatureHash);
    }

    /// <summary>The catalog's Is_System column does not survive into ReferenceableSummary (every row reads false in the
    /// live inventory of 2026-09-26, (System) included), so system producers are also recognized by the platform's own
    /// keys: (System) is the Service Center eSpace.</summary>
    private static bool IsSystem(ReferenceableSummary producer)
    {
        if (producer.IsSystem) return true;
        var key = Keys.Parse(producer.Key);
        return key.Equals(OutSystems.RuntimeCommon.Constants.ServiceCenterESpaceKey);
    }

    private static bool SameKey(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        try { return Keys.Parse(left).Equals(Keys.Parse(right)); } catch (FormatException) { return false; }
    }
    private static bool SameHash(string? left, string? right)
        => Guid.TryParse(left, out var l) && Guid.TryParse(right, out var r) ? l == r : string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

/// <summary>Delivery's producer authority for the connected Studio: every call opens its own read-only lease
/// (no credential file; the login stays in the Studio) and closes it before returning.</summary>
public sealed class StudioProducerAuthority(Func<string, HeadlessSession> openReadOnly, Action<string>? log = null) : IProducerSignatureAuthority
{
    public static StudioProducerAuthority ForBridge(IBridgeClient bridge, Action<string>? log = null)
        => new(environment => HeadlessSession.ConnectStudio(bridge, environment, null, readOnly: true), log);

    public JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment)
        => Guarded(environment, "the published signature", producer, session =>
        {
            if (!string.Equals(session.Host, environment, StringComparison.OrdinalIgnoreCase))
                throw new SignatureCaptureException("WrongEnvironment", $"the read-only lease is connected to {session.Host}, not {environment}");
            return ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest(producer, elements, destination), log);
        });

    public JsonObject CaptureByKey(string producerKey, IReadOnlyList<string> elements, string destination, string environment)
        => Guarded(environment, "the published signature", "the producer with key " + producerKey, session =>
        {
            if (!string.Equals(session.Host, environment, StringComparison.OrdinalIgnoreCase))
                throw new SignatureCaptureException("WrongEnvironment", $"the read-only lease is connected to {session.Host}, not {environment}");
            return ProducerSignatureCapture.Capture(session, new SignatureCaptureRequest("", elements, destination, Key: producerKey), log);
        });

    public JsonObject Attest(string avsigPath, string environment)
        => Guarded(environment, "the re-attestation of the captured signature", Path.GetFileNameWithoutExtension(avsigPath),
            session => ProducerSignatureCapture.Attest(session, avsigPath, environment));

    /// <summary>prazos B: a read the Studio's own client cut (its WCF SendTimeout, a connection that never answered) is
    /// ENVIRONMENT_CALL_CUT naming the producer, the environment operation that was running and how long it ran, instead of
    /// the bridge's raw "environment_session: TimeoutException: ..." text. Every other failure passes as it is.</summary>
    private JsonObject Guarded(string environment, string what, string? producer, Func<HeadlessSession, JsonObject> body)
    {
        HeadlessSession? session = null;
        try
        {
            session = openReadOnly(environment);
            return body(session);
        }
        catch (Exception ex) when (ex is not EnvironmentCallCutException && EnvironmentCut.Classify(ex) is { } cut)
        {
            var connected = session?.Connected;
            int? elapsed = connected?.LastOperationStartedUtc is { } started ? (int)Math.Round((DateTime.UtcNow - started).TotalSeconds) : null;
            throw new EnvironmentCallCutException(what, producer, session?.Host ?? environment, connected?.LastOperation, cut.Cause, cut.AfterSeconds, elapsed, ex,
                EnvironmentCut.RepeatedIn(ex));
        }
        finally { session?.Dispose(); }
    }
}
