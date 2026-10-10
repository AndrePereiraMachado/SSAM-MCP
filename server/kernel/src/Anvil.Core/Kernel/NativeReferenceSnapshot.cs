using System.Text.Json;
using System.Text.Json.Serialization;

namespace Anvil.Core;

/// <summary>One producer element named by the job. Requires lists the original keys of the same producer's
/// types its signature depends on (structure/entity closure), resolved from the signature at capture time.</summary>
public sealed record NativeReferenceElement(string Kind, string Name, string Key,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? Requires = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ParentKey = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Path = null);

/// <summary>How the signature bytes were acquired and what the controller observed on the server when it read them.
/// Only "server-signature" (the read-only `anvil signature` capture) is deliverable; "producer-oml" and
/// "consumer-reconstruction" are offline evidence fixtures and the delivery refuses them.</summary>
public sealed record NativeReferenceAttestation
{
    public const string ServerSignature = "server-signature";
    public const string ProducerOml = "producer-oml";
    public const string ConsumerReconstruction = "consumer-reconstruction";
    public required string Source { get; init; }
    /// <summary>Published version observed before and after the signature read (extensions/modules); null for (System).</summary>
    public int? VersionId { get; init; }
    public bool IsSystem { get; init; }
    public bool? IsActive { get; init; }
    /// <summary>What the delivery re-checks: extension-version, module-version or signature-hash (system producers).</summary>
    public string? Guard { get; init; }
    /// <summary>SignatureHash the environment's referenceable catalog advertised during the capture (the system guard).</summary>
    public string? AdvertisedSignatureHash { get; init; }
    public string? CapturedAtUtc { get; init; }
    public string? Tool { get; init; }
}

/// <summary>A frozen public producer signature, acquired by the controller, never authored as business logic.
/// Plain data since WS0: the platform adapter wraps it as the Studio's module signature (SS11: NativeReferenceCapture).
/// FormatVersion 1: extension only, no attestation (legacy lab captures). FormatVersion 2: extension or eSpace
/// (including system producers) with an explicit attestation; the producer identity it claims (environment, key,
/// SignatureHash, VersionId) is re-observed on the server by the delivery before any merge. The ODC public module
/// signature (`studio reference-snapshot`) is also version 2, but eSpace or ExternalLibrary without attestation and
/// with the native Digest/Revision/Version (<see cref="IsOdcPublicSignature"/>); only the ODC adapter imports it.</summary>
public sealed record NativeReferenceSnapshot
{
    public const int AttestedFormatVersion = 2;
    public int FormatVersion { get; init; } = 1;
    public required string Environment { get; init; }
    public required string ModuleKey { get; init; }
    public required string ApplicationKey { get; init; }
    public OutSystems.Model.Enumerations.ReferenceKind ModuleKind { get; init; }
    public OutSystems.Model.Enumerations.SegmentationKind ModuleType { get; init; }
    public required string Name { get; init; }
    public string Description { get; init; } = "";
    public byte[] Icon { get; init; } = [];
    public string JQueryVersion { get; init; } = "";
    public string ExtensibilityConfigurations { get; init; } = "";
    public string DatabaseName { get; init; } = "";
    public Guid SignatureHash { get; init; }
    public string Digest { get; init; } = "";
    public string Revision { get; init; } = "";
    public string Version { get; init; } = "";
    public required byte[] SignatureBinary { get; init; }
    public required NativeReferenceElement[] Elements { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public NativeReferenceAttestation? Attestation { get; init; }

    private static readonly string[] LegacyKinds = ["action", "entity"];
    private static readonly string[] AttestedKinds = NativeReferenceKinds.All.Select(f => f.Kind).ToArray();
    /// <summary>Element kinds of the ODC public module signature, as OdcPublicSignature reads them ("block" = mobile block).</summary>
    private const string OdcBlockKind = "block";
    private static readonly string[] OdcPublicKinds = ["action", "entity", "structure", OdcBlockKind, "client-action"];
    /// <summary>Element kinds of an ODC External Library signature: its server actions and structures.</summary>
    private static readonly string[] OdcExternalLibraryKinds = ["action", "structure"];
    /// <summary>The ODC model's ReferenceKind.ExternalLibrary, compared by NAME: Kernel/** also compiles against the O11
    /// Studio, whose ReferenceKind has no such member (there such an envelope cannot even be read).</summary>
    public const string ExternalLibraryKind = "ExternalLibrary";

    private static readonly JsonSerializerOptions JsonOptions = new() {
        WriteIndented = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter() }
    };

    // K1 (atritos 3): the producer signatures bound to the running execution. A frozen import puts the signatures of the
    // producers that own the foreign types of its elements into the same native refresh; only linked signatures go there.
    private static readonly AsyncLocal<IReadOnlyList<NativeReferenceSnapshot>?> LinkedScope = new();
    /// <summary>The attested producer signatures linked to the current execution (empty outside a <see cref="Link"/> scope).</summary>
    public static IReadOnlyList<NativeReferenceSnapshot> Linked => LinkedScope.Value ?? [];
    /// <summary>Links every readable .avsig among the producer bindings while the scope lives: the CLI apply and the delivery
    /// open it around the job, so the owners a delivery captured by themselves reach the import. A binding that cannot be
    /// read is not linked (a job that names it still reads it and refuses); an ODC public signature is never an O11 owner.
    /// A nested scope adds to the outer one; disposing restores it.</summary>
    public static IDisposable Link(IEnumerable<string>? paths)
    {
        var previous = LinkedScope.Value;
        var linked = new List<NativeReferenceSnapshot>(previous ?? []);
        // Lambdas, never a static method group: a method group adds a nested static class (<>O) to this type, and the preflight's
        // rule discovery (JobPreflight.RulesIn, check-job without the Studio assemblies) cannot read a nested static class here.
        foreach (var path in (paths ?? []).Where(p => Path.GetExtension(p).Equals(".avsig", StringComparison.OrdinalIgnoreCase))
                     .Select(p => Path.GetFullPath(p)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            NativeReferenceSnapshot snapshot;
            try { snapshot = Read(path); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or JsonException or FormatException) { continue; }
            if (!snapshot.IsOdcPublicSignature) linked.Add(snapshot);
        }
        LinkedScope.Value = linked;
        return new LinkScope(previous);
    }
    private sealed class LinkScope(IReadOnlyList<NativeReferenceSnapshot>? previous) : IDisposable
    {
        private bool _disposed;
        public void Dispose() { if (_disposed) return; _disposed = true; LinkedScope.Value = previous; }
    }
    /// <summary>Validated construction for adapters that capture a signature from their server.</summary>
    public static NativeReferenceSnapshot Create(NativeReferenceSnapshot snapshot) { snapshot.Validate(); return snapshot; }
    public static NativeReferenceSnapshot Read(string path)
    {
        var snapshot=JsonSerializer.Deserialize<NativeReferenceSnapshot>(File.ReadAllText(path),JsonOptions)
            ?? throw new ArgumentException("Empty native reference snapshot");
        snapshot.Validate(); return snapshot;
    }
    public void Write(string path) { Validate(); File.WriteAllText(path,JsonSerializer.Serialize(this,JsonOptions)); }
    public bool IsExtension => ModuleKind==OutSystems.Model.Enumerations.ReferenceKind.Extension;
    /// <summary>An ODC External Library producer (ModuleKind compared by name, see <see cref="ExternalLibraryKind"/>).</summary>
    [JsonIgnore]
    public bool IsExternalLibrary => ModuleKind.ToString()==ExternalLibraryKind;
    /// <summary>True for envelopes that carry an attestation the delivery must re-observe on the server.</summary>
    public bool RequiresServerAttestation => Attestation != null;
    /// <summary>The ODC public module signature written by `studio reference-snapshot` (platforms/odc/studio/bridge/
    /// ReferenceCommands.cs): version 2, eSpace, no attestation, with the native Digest/Revision/Version of the
    /// producer revision, of a module/library (eSpace) or of an External Library (actions and structures only). Only the
    /// ODC adapter imports it (OdcReferenceImporter).</summary>
    [JsonIgnore]
    public bool IsOdcPublicSignature => FormatVersion==AttestedFormatVersion && Attestation==null
        && (ModuleKind==OutSystems.Model.Enumerations.ReferenceKind.eSpace || IsExternalLibrary || ModuleKind.ToString()==AIModelConnectionKind);
    private string[] OdcKinds => IsExternalLibrary ? OdcExternalLibraryKinds : OdcPublicKinds;
    /// <summary>An ODC AI model connection producer (Codex agents): compared by name like the External Library.</summary>
    private const string AIModelConnectionKind = "AIModelConnection";
    public void RequireEnvironment(string? target)
    {
        if(string.IsNullOrWhiteSpace(target) || !Environment.Equals(target,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Frozen producer signature belongs to another environment: "+Name);
    }
    /// <summary>Delivery gate: same environment and, for attested envelopes, a real server capture (never an offline fixture).</summary>
    public void RequireDeliverable(string? target)
    {
        RequireEnvironment(target);
        if(Attestation != null && Attestation.Source != NativeReferenceAttestation.ServerSignature)
            throw new InvalidOperationException("Producer signature '"+Name+"' is offline evidence ("+Attestation.Source
                +"), not a server capture; capture it with `anvil signature` or deliver --capture-producer");
    }
    public NativeReferenceElement Select(string reference)
    {
        var parts=reference.Split(':',2);
        if(IsOdcPublicSignature)
        {
            // The ODC signature reader names a mobile block "block" (OdcPublicSignature); the other kinds are shared.
            var odcKind=KindOf(parts[0]) is { } shared ? (shared=="mobile-block" ? OdcBlockKind : shared) : null;
            if(odcKind==null || !OdcKinds.Contains(odcKind))
                throw new ArgumentException("Unsupported element kind for this frozen producer signature: "+reference);
            return Match(odcKind);
        }
        var kind=KindOf(parts[0]) ?? throw new ArgumentException((FormatVersion==1
            ? "Native extension references require a server action or entity signature: "
            : "Unsupported producer element type: ")+reference);
        if(!(FormatVersion==1 ? LegacyKinds : AttestedKinds).Contains(kind))
            throw new ArgumentException("Native extension references require a server action or entity signature: "+reference);
        return Match(kind);

        NativeReferenceElement Match(string elementKind)
        {
            if(parts.Length!=2)throw new ArgumentException("Expected a typed reference: "+reference);
            var matches=Elements.Where(e=>e.Kind==elementKind && (e.Name==parts[1] || e.Path==parts[1]
                || parts[1]=="@"+e.Key)).ToArray();
            return matches.Length switch {
                1 => matches[0], 0 => throw new ArgumentException("Element not declared in the frozen producer signature: "+reference),
                _ => throw new ArgumentException("Ambiguous producer element; use Flow/Name or @originalKey: "+reference)
            };
        }
    }
    /// <summary>The requested element and every element of its recorded closure, each once.</summary>
    public IReadOnlyList<NativeReferenceElement> WithClosure(IEnumerable<NativeReferenceElement> selected)
    {
        var byKey=Elements.ToDictionary(e=>Keys.Parse(e.Key).ToString(),StringComparer.Ordinal);
        var result=new List<NativeReferenceElement>();var seen=new HashSet<string>(StringComparer.Ordinal);
        void Add(NativeReferenceElement element)
        {
            if(!seen.Add(Keys.Parse(element.Key).ToString()))return;
            result.Add(element);
            if(element.ParentKey is { } parent)Add(byKey[Keys.Parse(parent).ToString()]);
            foreach(var key in element.Requires ?? [])Add(byKey[Keys.Parse(key).ToString()]);
        }
        foreach(var element in selected)Add(element);
        return result;
    }
    public string Bind(string reference)
    {
        var element=Select(reference);
        return InterfaceOf(element.Kind)+":@"+Keys.Parse(ModuleKey)+"/"+Keys.Parse(element.Key);
    }
    /// <summary>Tipo:Nome prefix (interface or its short form) to the envelope element kind; null when unsupported.</summary>
    public static string? KindOf(string type) => NativeReferenceKinds.ForType(type)?.Kind;
    /// <summary>Envelope element kind to its signature interface; the ODC "block" is the mobile block family.</summary>
    public static string InterfaceOf(string kind) => NativeReferenceKinds.ForKind(kind==OdcBlockKind ? "mobile-block" : kind).Interface;
    private void Validate()
    {
        if(FormatVersion is not (1 or AttestedFormatVersion))
            throw new ArgumentException("Unsupported native reference snapshot version/kind");
        if(FormatVersion==1 && (ModuleKind!=OutSystems.Model.Enumerations.ReferenceKind.Extension || Attestation!=null))
            throw new ArgumentException("Unsupported native reference snapshot version/kind");
        if(FormatVersion==AttestedFormatVersion)
        {
            // An External Library or an AI model connection exists only as the unattested ODC form: no server capture of one
            // is ever attested.
            if(!IsOdcPublicSignature && ModuleKind is not (OutSystems.Model.Enumerations.ReferenceKind.Extension or OutSystems.Model.Enumerations.ReferenceKind.eSpace))
                throw new ArgumentException("Unsupported native reference snapshot version/kind");
            // The ODC public signature is the one version-2 form without an attestation (eSpace or ExternalLibrary); an
            // unattested extension envelope is still refused, and O11 never imports the ODC form (ReferenceRefresher).
            if(!IsOdcPublicSignature) ValidateAttestation();
        }
        if(string.IsNullOrWhiteSpace(Environment) || string.IsNullOrWhiteSpace(Name) || string.IsNullOrWhiteSpace(ModuleKey)
            || SignatureHash==Guid.Empty || SignatureBinary is not {Length:>0})
            throw new ArgumentException("Incomplete native reference snapshot");
        _=Keys.Parse(ModuleKey);
        // An attested version-2 capture without elements is a refresh-only signature for an existing reference; the
        // legacy and ODC forms always name their elements.
        if(Elements is null || ((FormatVersion==1 || IsOdcPublicSignature) && Elements.Length==0) || Elements.Any(e=>e==null)
            || Elements.Select(e=>e.Kind+":"+(e.Path??e.Name)).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=Elements.Length
            || Elements.Select(e=>Keys.Parse(e.Key)).Distinct().Count()!=Elements.Length)
            throw new ArgumentException("Producer elements must be present and unambiguous");
        var kinds=FormatVersion==1 ? LegacyKinds : IsOdcPublicSignature ? OdcKinds : AttestedKinds;
        var keys=Elements.Select(e=>Keys.Parse(e.Key).ToString()).ToHashSet(StringComparer.Ordinal);
        foreach(var element in Elements)
        {
            if(!kinds.Contains(element.Kind) || string.IsNullOrWhiteSpace(element.Name))throw new ArgumentException("Unsupported producer element");
            _=Keys.Parse(element.Key);
            if(element.ParentKey is { } parent) {
                var owner=Elements.SingleOrDefault(e=>Keys.Parse(e.Key).Equals(Keys.Parse(parent)));
                var parentKind=element.Kind switch {
                    "mobile-block" or "mobile-screen" => "mobile-flow",
                    "web-block" or "web-screen" => "web-flow", _ => null
                };
                if(owner==null || owner.Kind!=parentKind || Keys.Parse(parent).Equals(Keys.Parse(element.Key)))
                    throw new ArgumentException("Producer element needs its matching flow parent in the same signature: "+element.Name);
                if(element.Path is { } path && path!=owner.Name+"/"+element.Name)
                    throw new ArgumentException("Producer element path differs from its declared parent: "+element.Name);
            } else if(element.Kind is "mobile-block" or "mobile-screen" or "web-block" or "web-screen")
                throw new ArgumentException("Producer UI element requires its flow parent: "+element.Name);
            else if(element.Path is { } path && path!=element.Name)
                throw new ArgumentException("Top-level producer path must equal its name: "+element.Name);
            if(element.Requires is { } requires && (FormatVersion==1 || requires.Any(k=>!keys.Contains(Keys.Parse(k).ToString()))))
                throw new ArgumentException("Producer element closure must reference elements declared in the same signature: "+element.Name);
        }
    }
    private void ValidateAttestation()
    {
        var attestation=Attestation ?? throw new ArgumentException("An attested producer signature requires its attestation");
        if(attestation.Source is not (NativeReferenceAttestation.ServerSignature or NativeReferenceAttestation.ProducerOml
            or NativeReferenceAttestation.ConsumerReconstruction))
            throw new ArgumentException("Unknown producer signature source: "+attestation.Source);
        if(attestation.Source==NativeReferenceAttestation.ServerSignature)
        {
            if(string.IsNullOrWhiteSpace(attestation.CapturedAtUtc) || attestation.Guard is not ("extension-version" or "module-version" or "signature-hash"))
                throw new ArgumentException("Server producer signature lacks its capture time or guard");
            if(attestation.Guard!="signature-hash" && attestation.VersionId is not > 0)
                throw new ArgumentException("Server producer signature lacks the published version it was captured from");
            if(attestation.Guard=="signature-hash" && string.IsNullOrWhiteSpace(attestation.AdvertisedSignatureHash))
                throw new ArgumentException("System producer signature lacks the advertised signature hash it was captured under");
            if(attestation.Guard=="extension-version" != IsExtension)
                throw new ArgumentException("Producer guard disagrees with its reference kind");
        }
    }
}
