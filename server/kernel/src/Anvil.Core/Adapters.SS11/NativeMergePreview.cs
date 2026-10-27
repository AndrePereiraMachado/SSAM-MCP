using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>O11's disposable native merge, using the same first-pass plan as the live bridge. timings: the merge (with its
/// save) and the content proof, each in milliseconds, for the delivery's receipt.</summary>
internal static class NativeMergePreview
{
    public static JsonObject Check(ModelHost host, byte[] basis, byte[] candidate, byte[]? firstPass, string candidatePath, string previewPath)
    {
        var clock = Stopwatch.StartNew();
        var replay = MergeProbe.Replay(host, basis, basis, candidate, firstPass, previewPath);
        var mergeMs = clock.ElapsedMilliseconds; clock.Restart();
        var content = MergeContentProof.Check(host, candidatePath, previewPath);
        var proofMs = clock.ElapsedMilliseconds;
        return new JsonObject { ["path"] = previewPath, ["sha256"] = Delivery.DeliveryReceipt.Hash(previewPath),
            ["accepted"] = !replay.Delta.New.Any(m => m.IsError) && !replay.HasConflicts && content["accepted"]!.GetValue<bool>(),
            ["isValid"] = replay.LocalIsValid, ["newErrors"] = replay.Delta.New.Count(m => m.IsError),
            ["messages"] = System.Text.Json.JsonSerializer.SerializeToNode(replay.Delta),
            ["hasConflicts"] = replay.HasConflicts, ["contentProof"] = content,
            ["timings"] = new JsonObject { ["mergeMs"] = mergeMs, ["contentProofMs"] = proofMs } };
    }
}
