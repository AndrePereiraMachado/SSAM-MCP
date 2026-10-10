using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The kernel's receipt next to a candidate (I10): the ODC builder (PrepareManifest) reads `kernel-result.json` in the folder
/// of `--candidate` and accepts the new warnings the kernel's policy judged (K1 verdicts other than `unexpected`), so the
/// kernel and the builder apply one validation policy (C06). The receipt counts only when its `data.outSha256` is the
/// sha256 of the candidate (K6). A03 (owner decision, 2026-10-06): only errors and security warnings block, so without an
/// applying receipt (a C# feature candidate, or a receipt of another candidate) the builder refuses only the warnings of
/// SecurityWarnings.IsSecurity and accepts every other one; with a receipt, a warning the kernel judged `unexpected` stays
/// refused and one the receipt does not cover is judged the same way. New errors are never accepted. Pure: BCL types only,
/// linked into the builder (with Kernel/SecurityWarnings.cs).
/// </summary>
public static class CandidateReceipt
{
    public const string FileName = "kernel-result.json";

    public sealed record Judgement(bool Applies, string? Reason, IReadOnlyList<string> Accepted, IReadOnlyList<string> Refused);

    /// <summary>The receipt beside the candidate, or null when there is none (or it is not JSON).</summary>
    public static JsonObject? Read(string candidatePath)
    {
        var file = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(candidatePath)) ?? ".", FileName);
        if (!File.Exists(file)) return null;
        try { return JsonNode.Parse(File.ReadAllText(file)) as JsonObject; } catch { return null; }
    }

    /// <summary>The added warnings the receipt accepts. <paramref name="addedWarnings"/>: the builder's message strings
    /// `ownerKey|id|message|detail`; a warning is accepted when the receipt has a verdict other than `unexpected` for the same
    /// (ownerKey, id), as many times as the receipt has such verdicts.</summary>
    public static Judgement Judge(JsonObject? receipt, string candidateSha256, IReadOnlyList<string> addedWarnings)
    {
        if (receipt == null) return JudgeWithoutReceipt(addedWarnings, null);
        var data = receipt["data"] as JsonObject ?? receipt;
        var sha = data["outSha256"] is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;
        if (sha == null || !string.Equals(sha, candidateSha256, StringComparison.OrdinalIgnoreCase))
            return JudgeWithoutReceipt(addedWarnings,
                $"{FileName} does not describe this candidate (outSha256 {sha ?? "absent"}, candidate {candidateSha256.ToLowerInvariant()}): its verdicts are ignored");
        var allowed = new Dictionary<(string, string), int>();
        var judgedUnexpected = new HashSet<(string, string)>();
        foreach (var verdict in (data["validation"]?["verdicts"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var key = (verdict["ownerKey"]?.ToString() ?? "", verdict["id"]?.ToString() ?? "");
            if (verdict["verdict"]?.ToString() is null or "unexpected") { judgedUnexpected.Add(key); continue; }
            if (verdict["type"]?.ToString() is { } type && type.Contains("Error", StringComparison.Ordinal)) continue;
            allowed[key] = allowed.GetValueOrDefault(key) + 1;
        }
        var accepted = new List<string>(); var refused = new List<string>();
        foreach (var warning in addedWarnings)
        {
            var (owner, id, detail) = Parts(warning);
            var key = (owner, id);
            if (allowed.TryGetValue(key, out var left) && left > 0) { allowed[key] = left - 1; accepted.Add(warning); }
            // The kernel judged it blocking (a security warning, the anonymous-access warning on a job screen): refused.
            else if (judgedUnexpected.Contains(key)) refused.Add(warning);
            // Not covered by the receipt: the same rule as without one (A03).
            else (SecurityWarnings.IsSecurity(id, detail) ? refused : accepted).Add(warning);
        }
        return new(true, null, accepted, refused);
    }

    /// <summary>What the kernel's receipt proves about one (base, candidate) pair (B1 of C02). SameFiles: `data.outSha256` is
    /// the candidate's sha256 and `data.baseSha256` (written by `anvil-odc apply --base`) the base's. Applies: SameFiles,
    /// `accepted` and `isValid` true, the author of the apply (`data.developerId`, `apply --developer-id`) is
    /// <paramref name="author"/> (the snapshot's: a candidate built under another identity is rebuilt, never merged), and the
    /// footprint names something created or changed (`createdTotal + changedTotal`, I14); then the builder writes the manifest
    /// without loading either model. Reason: why it does not apply.</summary>
    public sealed record KernelProof(bool Applies, bool SameFiles, string? Reason, int Created, int Changed);

    public static KernelProof FastPath(JsonObject? receipt, string candidateSha256, string baseSha256, string? author = null)
    {
        if (receipt == null) return new(false, false, "no " + FileName + " beside the candidate", 0, 0);
        var data = receipt["data"] as JsonObject ?? receipt;
        static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        static bool True(JsonNode? node) => node is JsonValue v && v.TryGetValue<bool>(out var b) && b;
        static int Count(JsonNode? node) => node is JsonValue v && v.TryGetValue<int>(out var n) ? n : 0;
        var footprint = data["footprint"] as JsonObject;
        int created = Count(footprint?["createdTotal"]), changed = Count(footprint?["changedTotal"]);
        var outSha = Text(data["outSha256"]); var baseSha = Text(data["baseSha256"]);
        string? reason =
            !string.Equals(outSha, candidateSha256, StringComparison.OrdinalIgnoreCase) ? "the receipt is of another candidate (outSha256 " + (outSha ?? "absent") + ")"
            : baseSha == null ? "the receipt has no baseSha256 (a kernel CLI from before it)"
            : !string.Equals(baseSha, baseSha256, StringComparison.OrdinalIgnoreCase) ? "the kernel applied the job over another base (baseSha256 " + baseSha + ")"
            : null;
        var same = reason == null;
        var applier = Text(data["developerId"]);
        reason ??= !True(data["accepted"]) || !True(data["isValid"]) ? "the kernel did not accept the candidate as valid"
            : author != null && applier == null ? "the receipt does not name the author of the apply (developerId)"
            : author != null && !string.Equals(applier, author, StringComparison.OrdinalIgnoreCase) ? "the kernel applied the job as " + applier + ", not as the snapshot author"
            : created + changed == 0 ? "the kernel footprint names nothing created or changed" : null;
        return new(reason == null, same, reason, created, changed);
    }

    /// <summary>A03: the judgement of a candidate without an applying kernel receipt (a C# feature of the builder, or a
    /// receipt of another candidate): only the warnings of SecurityWarnings.IsSecurity are refused; every other one is
    /// accepted (the builder lists them in acceptedWarnings). <paramref name="addedWarnings"/>: `ownerKey|id|message|detail`.</summary>
    public static Judgement JudgeWithoutReceipt(IReadOnlyList<string> addedWarnings, string? reason = null)
    {
        var accepted = new List<string>(); var refused = new List<string>();
        foreach (var warning in addedWarnings)
        {
            var (_, id, detail) = Parts(warning);
            (SecurityWarnings.IsSecurity(id, detail) ? refused : accepted).Add(warning);
        }
        return new(false, reason, accepted, refused);
    }

    /// <summary>`ownerKey|id|message|detail`: the owner key, the id and the rest (message and detail, where the anonymous
    /// sentence of the O11 bucket is).</summary>
    private static (string Owner, string Id, string Detail) Parts(string warning)
    {
        var parts = warning.Split('|', 3);
        return (parts[0], parts.Length > 1 ? parts[1] : "", parts.Length > 2 ? parts[2] : "");
    }
}
