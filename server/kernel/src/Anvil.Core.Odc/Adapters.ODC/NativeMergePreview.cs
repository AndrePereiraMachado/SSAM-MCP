using System.Text.Json.Nodes;
using OutSystems.Model.Merge;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>Disposable replay with the installed ODC MatchTree and the delivery's two-pass order.
/// This checks model preservation before the live bridge; publication/runtime remain separate proofs.
/// A merge with conflicts merges nothing (the native merge refuses it): the preview is then the module as it was, so no content
/// is compared (a comparison would name every element of the candidate as lost) and the answer names the conflict and the
/// elements the installed MatchTree marks as in conflict (review of 3ab12209, 9c).</summary>
internal static class NativeMergePreview
{
    /// <summary><paramref name="mergeBase"/>: the common ancestor of the first merge (null: the module itself, as the delivery
    /// merges a candidate built on a capture of the module).</summary>
    public static JsonObject Check(ModelHost host, byte[] basis, byte[] candidate, byte[]? firstPass, string candidatePath, string previewPath, byte[]? mergeBase = null)
    {
        ESpace? local = null;
        try
        {
            local = host.Load(basis);
            var before = ModelHost.Messages(local);
            var inConflict = new List<string>();
            bool Merge(byte[] foreignBytes, byte[] baseBytes)
            {
                ESpace? foreign = null, over = null;
                try
                {
                    foreign = host.Load(foreignBytes); over = host.Load(baseBytes);
                    var conflicts = false;
                    StudioAdapter.Runtime.Mutate(local, "Anvil: ODC disposable native merge", _ => {
                        using var tree = new MatchTree(local, foreign, over, false, true);
                        conflicts = tree.HasConflicts;
                        if (!conflicts) tree.Merge();
                        else inConflict.AddRange(Conflicts(tree));
                    });
                    return conflicts;
                }
                finally { ModelHost.Release(foreign); ModelHost.Release(over); }
            }
            var conflicts = Merge(firstPass ?? candidate, mergeBase ?? basis);
            // The live facade captures the result of pass 1 and uses that capture as the next base.
            if (!conflicts && firstPass != null) conflicts = Merge(candidate, host.Save(local));
            var after = ModelHost.Messages(local);
            var delta = MessageDelta.Compute(before, after);
            Delivery.DurableJson.WriteBytes(previewPath, host.Save(local));
            var content = conflicts ? ConflictProof(inConflict) : MergeContentProof.Check(host, candidatePath, previewPath);
            var answer = new JsonObject {
                ["path"] = previewPath, ["sha256"] = Delivery.DeliveryReceipt.Hash(previewPath),
                ["accepted"] = !conflicts && !delta.New.Any(m => m.IsError) && content["accepted"]!.GetValue<bool>(),
                ["isValid"] = ModelHost.Describe(local, 0, after).IsValid,
                ["newErrors"] = delta.New.Count(m => m.IsError),
                ["messages"] = System.Text.Json.JsonSerializer.SerializeToNode(delta),
                ["hasConflicts"] = conflicts, ["contentProof"] = content
            };
            if (conflicts) answer["conflicts"] = new JsonArray(inConflict.Select(e => (JsonNode?)e).ToArray());
            return answer;
        }
        finally { ModelHost.Release(local); }
    }

    // The elements the MatchTree marks as in conflict (their own difference, not a parent's DifferenceInLocalChildren), by
    // readable path below the module, distinct, in the tree's order; at most 50.
    private static IEnumerable<string> Conflicts(MatchTree tree)
    {
        static string PathOf(Match m)
        {
            var parts = new List<string>();
            for (var x = m; x?.Parent != null; x = x.Parent) parts.Add(x.AnyObject?.DisplayName ?? "?");
            parts.Reverse();
            return parts.Count == 0 ? "(the module)" : string.Join("/", parts);
        }
        var found = tree.GetMatches(x => ((x.Difference | x.VisibleDifference) & DifferenceType.Conflict) != 0).Select(PathOf).Distinct(StringComparer.Ordinal).Take(50).ToList();
        return found.Count > 0 ? found : FromDump(tree.Dump());
    }

    // The same from the tree's dump (a conflict of a property is flagged on its ">> Name[local] / Name[foreign]" line): the
    // element of each flagged line, by the names of its nodes, and the property.
    private static readonly System.Text.RegularExpressions.Regex NodeLine = new(@"^(?<pad>(?:\|    )*)(?<arm>\+-- )?\((?:Object [^)]+|Folder)\) (?<name>.*?)(?: \[(?<flags>[A-Za-z]+(?:, [A-Za-z]+)*)\])?\r?$");
    private static readonly System.Text.RegularExpressions.Regex PropertyLine = new(@"^(?:\|    )*\|\s+>> (?<name>[^\[]*)\[.*\[(?<flags>[A-Za-z]+(?:, [A-Za-z]+)*)\]\r?$");
    internal static List<string> FromDump(string dump)
    {
        var path = new List<string>();
        var found = new List<string>();
        foreach (var line in dump.Split('\n')) {
            if (NodeLine.Match(line) is { Success: true } node) {
                var depth = node.Groups["pad"].Length / 5 + (node.Groups["arm"].Success ? 1 : 0);
                if (path.Count > depth) path.RemoveRange(depth, path.Count - depth);
                while (path.Count < depth) path.Add("?");
                path.Add(node.Groups["name"].Value);
                if (node.Groups["flags"].Value.Split(", ").Contains("Conflict")) found.Add(string.Join("/", path.Skip(1)));
            }
            else if (PropertyLine.Match(line) is { Success: true } property && property.Groups["flags"].Value.Split(", ").Contains("Conflict"))
                found.Add(string.Join("/", path.Skip(1)) + "." + property.Groups["name"].Value.Trim());
        }
        return found.Select(f => f.Length == 0 || f.StartsWith('.') ? "(the module)" + f : f).Distinct(StringComparer.Ordinal).Take(50).ToList();
    }

    // The content proof of a merge that merged nothing: never a comparison of the candidate with the unchanged module.
    private static JsonObject ConflictProof(List<string> inConflict) => new() {
        ["schema"] = "ssam-merge-content-proof/1", ["accepted"] = false, ["conflict"] = true,
        ["reason"] = "the disposable native merge has conflicts with the module and merged nothing: no content was compared, so no element is named as lost"
            + (inConflict.Count > 0 ? "; in conflict: " + string.Join(", ", inConflict.Take(8)) + (inConflict.Count > 8 ? ", ..." : "") : ""),
        ["conflicts"] = new JsonArray(inConflict.Select(e => (JsonNode?)e).ToArray()),
        ["checked"] = 0, ["differences"] = new JsonArray(),
    };
}
