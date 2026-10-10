using System.Security.Cryptography;
namespace Anvil.Core.Delivery;

public sealed record RegisteredSnapshot(string Id, string ModuleKey, string Sha256, IReadOnlyList<MessageInfo> Messages);

/// <summary>Session-local provenance by module identity and bytes; paths alone never establish a merge base.</summary>
public sealed class SnapshotRegistry
{
    private readonly Dictionary<string, RegisteredSnapshot> snapshots = new(StringComparer.Ordinal);
    private readonly object gate = new();
    public RegisteredSnapshot Register(string moduleKey, byte[] bytes, IReadOnlyList<MessageInfo> messages)
    {
        var snapshot = new RegisteredSnapshot(Guid.NewGuid().ToString("N"), moduleKey, Hash(bytes), Array.AsReadOnly(messages.ToArray()));
        lock (gate) snapshots.Add(snapshot.Id, snapshot);
        return snapshot;
    }
    public RegisteredSnapshot RequireBase(string moduleKey, byte[]? bytes, string? path)
    {
        var hash = bytes == null ? null : Hash(bytes);
        lock (gate)
            return snapshots.Values.LastOrDefault(s => s.ModuleKey == moduleKey && s.Sha256 == hash)
                ?? throw new InvalidOperationException($"base '{path ?? "(missing)"}' is not a snapshot of this module taken in this session: use snapshot_module");
    }
    public RegisteredSnapshot RequireSince(string moduleKey, string id)
    {
        lock (gate)
        {
            if (!snapshots.TryGetValue(id, out var snapshot)) throw new InvalidOperationException($"snapshot '{id}' is not registered in this session: use snapshot_module");
            if (snapshot.ModuleKey != moduleKey) throw new InvalidOperationException($"snapshot '{id}' belongs to another module; select its module or take a new snapshot");
            return snapshot;
        }
    }
    public static void RequireForeignIdentity(string localKey, string foreignKey)
    {
        if (!string.Equals(localKey, foreignKey, StringComparison.Ordinal))
            throw new InvalidOperationException($"foreign module key '{foreignKey}' differs from local module key '{localKey}': apply the job to snapshot_module output, then merge that result");
    }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
}
