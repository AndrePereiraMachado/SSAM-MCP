namespace Anvil.Core;

/// <summary>Outcome data of a publication, platform-neutral (was in Adapters.SS11/Publisher.cs; PublicationBatch uses it).</summary>
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
