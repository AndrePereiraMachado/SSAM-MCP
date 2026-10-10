using System.Text.Json.Nodes;

namespace Anvil.Bridge;

/// <summary>
/// C15, inside the bridge: the proof that a native merge which threw after it started (nativeStarted, no receipt) left the
/// module exactly as its base, because the SDK command rolled it back. MergeHandler computes the facts on the UI thread: the
/// sha256 of the live module (SaveToMemoryStream) against the journal's baseHash and, only when they differ, whether a native
/// MatchTree(local, base, base) has no differences. Equal: the receipt the journal records (merged:false, reason "rolled
/// back"), so merge_status answers not-applied and the kernel's reconcile closes the task and frees the module.
/// Anything else: null, and the outcome stays unknown (never repeated).
/// Pure, no Studio type: linked into Anvil.Tests (Anvil.Tests.csproj) for its rule test.
/// </summary>
internal static class MergeRollbackProof
{
    public const string Reason = "rolled back";
    public const string Capability = "merge_from_oml:rollback_proof";

    public static string Sha256Hex(byte[] bytes) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();

    public static bool SameHash(string? left, string? right)
        => !string.IsNullOrWhiteSpace(left) && !string.IsNullOrWhiteSpace(right)
           && string.Equals(left.Trim(), right.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>treeHasNoDifferences: null when the tree was not built (hashes equal, or the tree could not be built).</summary>
    public static JsonObject? Receipt(string operationId, string? liveSha256, string? baseSha256, bool? treeHasNoDifferences, string error)
    {
        var byHash = SameHash(liveSha256, baseSha256);
        if (!byHash && treeHasNoDifferences != true) return null;
        return new JsonObject
        {
            ["operationId"] = operationId, ["merged"] = false, ["reason"] = Reason, ["rolledBack"] = true,
            ["proof"] = byHash ? "sha256" : "match-tree",
            ["liveSha256"] = liveSha256?.Trim().ToLowerInvariant(), ["baseSha256"] = baseSha256?.Trim().ToLowerInvariant(),
            ["error"] = error,
        };
    }

    /// <summary>C10: the distinct dialogs seen while a publication was followed (Dialogs.BlockedBy entries), as short labels:
    /// "kind: title" (or the kind alone), in the order first seen, at most max.</summary>
    public static void AddSeen(List<string> seen, JsonArray? blockedBy, int max = 10)
    {
        foreach (var entry in blockedBy?.OfType<JsonObject>() ?? [])
        {
            if (seen.Count >= max) return;
            var kind = entry["kind"]?.ToString();
            var title = entry["title"]?.ToString();
            var label = string.IsNullOrWhiteSpace(title) ? kind : string.IsNullOrWhiteSpace(kind) ? title : kind + ": " + title;
            if (!string.IsNullOrWhiteSpace(label) && !seen.Contains(label, StringComparer.Ordinal)) seen.Add(label);
        }
    }
}
