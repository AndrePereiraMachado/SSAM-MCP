using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// C15: the proof that a merge which failed after it started applied nothing, so its task closes and the module's
/// reservation is released instead of blocking the module until a person intervenes.
/// The bridge with merge_from_oml:rollback_proof proves it itself (MergeHandler) and its journal answers not-applied.
/// For an older bridge the kernel proves it: the journal recorded the failure of an operation that had started (an error and
/// no receipt, so the operation is over and nothing is still running), and the live module captured now has exactly the
/// bytes of the attempt's base snapshot. Anything else stays unknown and nothing is ever repeated.
/// Pure: no bridge, no file.
/// </summary>
public static class RollbackProof
{
    public const string BridgeReason = "rolled back";
    public const string KernelReason = "rolled back (kernel hash proof)";

    public static bool SameSha256(string? left, string? right)
        => !string.IsNullOrWhiteSpace(left) && !string.IsNullOrWhiteSpace(right)
           && string.Equals(left.Trim(), right.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>Whether a merge_status answer allows the kernel hash proof: a journal record that ended with an error and has
    /// no receipt. A missing record (the request may still be queued), a record without error (it may still be running) or
    /// one with a receipt (its own state decides) never does.</summary>
    public static bool KernelProofApplies(JsonObject? status)
        => status != null && status["binding"] is JsonObject && status["receipt"] == null
           && !string.IsNullOrWhiteSpace(status["error"]?.ToString())
           && status["state"]?.ToString() is null or "unknown";

    /// <summary>The receipt the kernel records when the live module equals the base; null when the hashes are unknown or differ.</summary>
    public static JsonObject? KernelReceipt(string? operationId, string? liveSha256, string? baseSha256, string? error)
    {
        if (!SameSha256(liveSha256, baseSha256)) return null;
        return new JsonObject
        {
            ["operationId"] = operationId, ["merged"] = false, ["reason"] = KernelReason, ["rolledBack"] = true, ["proof"] = "kernel-sha256",
            ["liveSha256"] = liveSha256!.Trim().ToLowerInvariant(), ["baseSha256"] = baseSha256!.Trim().ToLowerInvariant(),
            ["error"] = string.IsNullOrWhiteSpace(error) ? null : error,
        };
    }

    /// <summary>The sha256 of the attempt's base: the bridge's own snapshot hash, else the recorded base artifact.</summary>
    public static string? BaseSha256(JsonObject state)
    {
        if (state["snapshot"]?["sha256"]?.ToString() is { Length: > 0 } registered) return registered;
        return (state["artifacts"] as JsonArray)?.OfType<JsonObject>()
            .FirstOrDefault(a => Path.GetFileName(a["path"]?.ToString() ?? "").Equals("base.oml", StringComparison.OrdinalIgnoreCase))?["sha256"]?.ToString();
    }
}
