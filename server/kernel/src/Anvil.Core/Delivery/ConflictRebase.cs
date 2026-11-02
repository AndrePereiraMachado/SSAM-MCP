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
        if (result["delivered"]?.GetValue<bool>() == true || result["closed"]?.GetValue<bool>() == true
            || result["conflictRebase"] != null || result["mergeOrder"] != null || result["pendingBridgeOperation"] != null) return null;
        // The real bridge (Anvil.Bridge MergeHandler, mode auto) merges nothing when the Studio's MatchTree has conflicts:
        // writeState not-applied, hasConflicts, "conflicts: use mode=dialog". The candidate rebased on the module as it is
        // now (the person's side of every conflict replaced by the delivery's) merges without a conflict.
        // A producer signature changed concurrently (the person refreshed a reference) is no conflict a rebase settles: the
        // refusal stands and the next delivery captures the new signature.
        if (result["writeState"]?.ToString() == "not-applied" && result["merge"]?["hasConflicts"]?.GetValue<bool>() == true
            && result["merge"]?["reason"]?.ToString()?.Contains("producer signature", StringComparison.Ordinal) != true)
            return new JsonArray(new JsonObject { ["element"] = "the elements the Studio's merge reported in conflict", ["property"] = "", ["change"] = "conflict" });
        if (result["code"]?.ToString() != "MERGE_CONTENT_MISMATCH" || result["writeState"]?.ToString() != "applied") return null;
        // Every difference is something the job wrote that the Studio's merge did not keep against the person's edit (the same
        // property, the same element, a renamed or removed parent, an index the person shifted). The second attempt proves
        // all of it again, so a real loss still refuses there; nothing is accepted without that proof.
        if (result["contentProof"] is not JsonObject proof || proof["intent"] == null || proof["differences"] is not JsonArray { Count: > 0 } differences) return null;
        if (result["failures"] is JsonArray failures && failures.Any(f => f?["stage"]?.ToString() != "data-proof")) return null;
        var conflicts = new JsonArray();
        foreach (var difference in differences.OfType<JsonObject>())
            conflicts.Add(new JsonObject { ["element"] = difference["element"]?.DeepClone(), ["property"] = difference["property"]?.DeepClone(),
                ["change"] = difference["missing"]?.GetValue<bool>() == true ? "missing" : difference["unexpected"]?.GetValue<bool>() == true ? "unexpected" : "differs",
                ["delivery"] = difference["expectedValue"]?.DeepClone(), ["studio"] = difference["actualValue"]?.DeepClone() });
        return conflicts;
    }

    /// <summary>merge_from_oml {prefer:"foreign"}: the list a bridge returns of the conflicts it resolved inside the Studio's merge in
    /// favour of the delivery (receipt merge.resolvedConflicts, Anvil.Bridge PreferForeign), or null when it resolved none.</summary>
    public static JsonObject? Preferred(JsonNode? merge)
        => merge?["resolvedConflicts"] is JsonObject resolved && resolved["entries"] is JsonArray { Count: > 0 } ? resolved : null;

    /// <summary>The note of a merge in which the bridge resolved conflicts for the delivery: every value of the person it replaced,
    /// with the person's value and the delivery's, up to five, and how many in all.</summary>
    public static string PreferredNote(JsonObject resolved)
    {
        // Review A4: the values the delivery also changed (conflict) and the other edits of the person the delivery's version replaced
        // (in the same element, a parent or a dependency the Studio's selection took) are counted and named apart.
        var entries = resolved["entries"]!.AsArray().OfType<JsonObject>().ToList();
        bool IsConflict(JsonObject e) => e["conflict"]?.GetValue<bool>() == true;
        var total = resolved["count"]?.GetValue<int>() is int n && n > entries.Count ? n : entries.Count;
        var conflicts = resolved["conflicts"]?.GetValue<int>() ?? entries.Count(IsConflict);
        var others = total - conflicts;
        string Value(JsonNode? v) => v == null ? "(none)" : "\"" + (v.ToString() is { Length: > 60 } s ? s[..60] + "..." : v.ToString()) + "\"";
        string One(JsonObject e) => e["element"] + (e["property"]?.ToString() is { Length: > 0 } p ? " " + p : "") + ": the person's " + Value(e["user"]) + ", now the delivery's " + Value(e["delivery"])
            + (IsConflict(e) || e["cause"] is null ? "" : " (" + e["cause"] + ")");
        string Named(IEnumerable<JsonObject> list, int count) { var shown = list.Take(5).ToList(); return string.Join("; ", shown.Select(One)) + (count > shown.Count ? "; and " + (count - shown.Count) + " more (resolvedConflicts)" : ""); }
        var text = "While this delivery ran the person edited in the Studio what the delivery also changed; the Studio's merge resolved it in this same merge in favour of the delivery (prefer foreign), replacing "
            + total + " value(s) of the person: " + conflicts + " the delivery also changed (" + Named(entries.Where(IsConflict), conflicts) + ")";
        if (others > 0) text += ", and " + others + " other edit(s) of the person that came with the delivery's version of those elements (" + Named(entries.Where(e => !IsConflict(e)), others) + ")";
        return text + ". Every value of the person it replaced is listed in resolvedConflicts; the person's other edits stay.";
    }

    /// <summary>The note the answer carries after the second attempt.</summary>
    public static string Note(JsonArray conflicts)
        => conflicts.OfType<JsonObject>().Any(c => c["change"]?.ToString() == "conflict")
            ? "The Studio's merge found a conflict with edits the person made in the Studio while the delivery ran, and merged nothing: the delivery was rebased on the module as it is now and merged again in this call, the delivery's values winning where both changed the same element; the person's other edits stay"
            : conflicts.Count + " value(s) this delivery wrote were not kept by the Studio's merge because the person also edited the same element(s) in the Studio while it ran ("
            + string.Join(", ", conflicts.OfType<JsonObject>().Select(c => c["element"] + (c["property"]?.ToString() is { Length: > 0 } p && !p.StartsWith('$') ? " " + p.Replace("api:", "") : "")).Distinct().Take(5))
            + (conflicts.Count > 5 ? ", ..." : "")
            + "): a merge conflict, resolved in this call by a second merge in which the delivery's values win; the person's other edits stay";
}
