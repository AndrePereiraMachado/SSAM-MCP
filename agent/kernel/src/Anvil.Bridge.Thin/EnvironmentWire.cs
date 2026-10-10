using System.Text.Json;

namespace Anvil.Bridge;

/// <summary>The records of the environment_session wire, with the same names and field order as the kernel's (Dtos.cs,
/// PublishOutcome.cs, Publisher.DeleteOutcome, EnvironmentData.Row/Cell/Report): the server deserializes each value into
/// its own record. Studio types (ReferenceInfo, ApplicationInfo, ModuleInfo, ...) cross the wire as themselves.</summary>
internal static class EnvironmentWire
{
    /// <summary>The kernel's ConnectedEnvironment.Wire options: public fields included (Studio DTOs, value tuples).</summary>
    public static readonly JsonSerializerOptions Options = new() { IncludeFields = true };

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
        string Kind,
        string? ESpaceKind,
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

    public sealed record ReferenceableSummary(
        string Key,
        string Name,
        string Kind,
        string SignatureHash,
        bool IsSystem,
        string? ApplicationKey);

    public sealed record TemplateSummary(string Key, string Label, string? Description, bool IsMobile, string ApplicationKind);

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
        string Status);

    public sealed record PublishMessage(string? Id, string Type, string Message, string? Detail);

    public sealed record PublishOutcome(
        bool Started,
        bool HasErrors,
        bool Completed,
        int ESpaceId,
        int VersionId,
        string? Key,
        IReadOnlyList<PublishMessage> Messages,
        long StartMs,
        long TotalMs);

    public sealed record DeleteOutcome(bool Ok, bool Simulated, IReadOnlyList<string> Messages, IReadOnlyList<string> AffectedApplications, IReadOnlyList<string> DeletedModules);

    public sealed record Cell(string Key, string? Value);
    public sealed record Row(string Id, Cell[] Attributes);
    public sealed record Report(string? RecordId, string? ClientRecordId, string Status, string? Error);
}
