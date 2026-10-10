namespace Anvil.Core;

// DTOs proprios, serializaveis, desacoplados dos tipos do Studio. Tudo que sai
// da biblioteca para o CLI ou para o runner Python passa por aqui.

public sealed record ApplicationSummary(
    string Name,
    string Key,
    string? Description,
    string? Kind,
    string? TemplateKey,
    bool IsActive,
    bool IsIsolated,
    string? DatabaseName,
    bool HasFullControl,
    string? PrimaryColor = null,
    bool HasIcon = false);

public sealed record ModuleSummary(
    string Name,
    string Key,
    string Kind,               // eSpace | Extension
    string? ESpaceKind,        // Service, CrossDevice (reactive), WebResponsive, Mobile, ReactiveLibrary
    int VersionId,
    int Version,
    string? ApplicationName,
    string? ApplicationKey,
    DateTime UploadDate,
    string? UploaderUsername,
    bool IsActive,
    bool CanDownloadFlag,
    string? Description);

public sealed record CatalogSummary(int Id, string Name, string? Description);

/// <summary>Um produtor referenciavel do ambiente (catalogo do servidor).</summary>
public sealed record ReferenceableSummary(
    string Key,
    string Name,
    string Kind,
    string SignatureHash,
    bool IsSystem,
    string? ApplicationKey);

/// <summary>Uma referencia que um modulo consome (lida do OML, sem servidor).</summary>
public sealed record ModuleReference(
    string Name,
    string Key,
    string Kind,               // eSpace | Extension
    string ReferenceHash,
    int Elements,
    IReadOnlyDictionary<string, int> ElementsByType);

public sealed record DownloadResult(
    string Name,
    string Key,
    string Kind,
    int VersionId,
    long Bytes,
    string? FilePath,
    DateTime UploadDate,
    string? UploadUser,
    bool IsPublishedVersion,
    long ElapsedMs,
    string Status);           // ok | failed: ... | skipped: ...

public sealed record ValidationSummary(
    int Total,
    IReadOnlyDictionary<string, int> ByType,
    IReadOnlyList<string> Sample);

public sealed record ModelSnapshot(
    string Name,
    string Kind,
    string Key,
    bool IsValid,
    int Objects,
    IReadOnlyDictionary<string, int> TopObjectTypes,
    ValidationSummary Validation,
    IReadOnlyList<ModuleReference> References,
    long LoadMs,
    long VerifyMs,
    bool IsUserProvider = false,
    string? UserProviderName = null,
    string? UserProviderKey = null);

public sealed record RoundTripResult(
    ModelSnapshot Original,
    ModelSnapshot Reloaded,
    long BytesIn,
    long BytesOut,
    long SaveMs,
    bool SameKey,
    bool SameObjectCount,
    bool SameValidation,
    string? SavedPath);

public sealed record TemplateSummary(string Key, string Label, string? Description, bool IsMobile, string ApplicationKind);

public sealed record FlowNodeInfo(string Name, string Kind, int X, int Y, IReadOnlyList<string> Targets);
