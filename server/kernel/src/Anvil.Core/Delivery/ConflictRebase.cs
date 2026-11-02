using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>F1 conflict (owner 2026-11-02, "o ssam deve permitir que o usuario programe junto com ele"; stopping because the
/// person was programming is "imperdoável"). A planner that can rebase a candidate on the module as it is now: the delivery's
/// value wins where the person and the job changed the same property, every other edit of the person stays.</summary>
public interface IConflictRebaser
{
    /// <summary>Writes to <paramref name="outputPath"/> the candidate rebased on <paramref name="livePath"/> (the module after the
    /// first merge, the person's edits included) over <paramref name="basePath"/> (the first attempt's base): a native
    /// three-way merge whose local side is the candidate, so on a conflict the candidate's value stays.</summary>
    void Rebase(string candidatePath, string livePath, string basePath, string outputPath);
}

/// <summary>When a refused delivery is a same-property conflict that a second attempt in the same call resolves.</summary>
public static class ConflictRebase
{
    /// <summary>The rule, named in the receipt.</summary>
    public const string Rule = "ssam-merge-conflict/1: where the person (in the Studio) and the delivery changed the same property, the delivery's value wins in the same call: the candidate is rebased on the module as it is now (a native three-way merge with the candidate as the local side) and merged again; the person's other edits stay; once per call, and a value the job wrote that the second merge still lacks refuses";

    /// <summary>The conflicting values of a refused first attempt (each the element and property the job wrote that the module
    /// holds otherwise, the element itself present), or null when this is not one: another refusal, an element missing or
    /// added, a known loss of the merge order, a failure outside the proofs, or an attempt that already rebased.</summary>
    public static JsonArray? Eligible(JsonObject result)
    {
        if (result["code"]?.ToString() != "MERGE_CONTENT_MISMATCH" || result["writeState"]?.ToString() != "applied"
            || result["delivered"]?.GetValue<bool>() == true || result["closed"]?.GetValue<bool>() == true
            || result["conflictRebase"] != null || result["mergeOrder"] != null || result["pendingBridgeOperation"] != null) return null;
        // Only when the person may have edited the module (the proof ran by the job's intention, not rule a): every
        // difference is then something the job wrote that the Studio's merge did not keep against the person's edit (the same
        // property, the same element, a renamed or removed parent, an index the person shifted). The second attempt proves
        // all of it again, so a real loss still refuses there; nothing is accepted without that proof.
        if (result["mergeProof"]?["rule"]?.ToString() == "a") return null;
        if (result["contentProof"] is not JsonObject proof || proof["intent"] == null || proof["differences"] is not JsonArray { Count: > 0 } differences) return null;
        if (result["failures"] is JsonArray failures && failures.Any(f => f?["stage"]?.ToString() != "data-proof")) return null;
        var conflicts = new JsonArray();
        foreach (var difference in differences.OfType<JsonObject>())
            conflicts.Add(new JsonObject { ["element"] = difference["element"]?.DeepClone(), ["property"] = difference["property"]?.DeepClone(),
                ["change"] = difference["missing"]?.GetValue<bool>() == true ? "missing" : difference["unexpected"]?.GetValue<bool>() == true ? "unexpected" : "differs",
                ["delivery"] = difference["expectedValue"]?.DeepClone(), ["studio"] = difference["actualValue"]?.DeepClone() });
        return conflicts;
    }

    /// <summary>The note the answer carries after the second attempt.</summary>
    public static string Note(JsonArray conflicts)
        => conflicts.Count + " value(s) this delivery wrote were not kept by the Studio's merge because the person also edited the same element(s) in the Studio while it ran ("
            + string.Join(", ", conflicts.OfType<JsonObject>().Select(c => c["element"] + (c["property"]?.ToString() is { Length: > 0 } p && !p.StartsWith('$') ? " " + p.Replace("api:", "") : "")).Distinct().Take(5))
            + (conflicts.Count > 5 ? ", ..." : "")
            + "): a merge conflict, resolved in this call by a second merge in which the delivery's values win; the person's other edits stay";
}
