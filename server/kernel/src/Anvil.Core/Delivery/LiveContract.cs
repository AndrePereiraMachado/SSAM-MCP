using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// C28: the TrueChange contract of a merged module, decided on the live messages.
/// VerifyUnavailable: an empty message list after a base that had messages is a validation that did not run on the merged
/// module, never "0 errors" (unless a bridge with get_errors:generation says it read a settled validation).
/// Evaluate: with the apply's verdicts (contract I3, result.apply.validation.verdicts) each new live message needs a verdict
/// with the same (id, path) other than "unexpected". A live message the apply did not foresee is, after A03 (owner decision,
/// 2026-10-06), nonblocking when it is a warning outside SecurityWarnings (the list and the anonymous-access family), and
/// unexpected when it is an error or a security warning. New errors always refuse (the caller checks newErrors). Pure.
/// </summary>
public static class LiveContract
{
    public static string? VerifyUnavailable(JsonArray? baseline, JsonObject validation)
    {
        if (validation["rawMessages"] is not JsonArray current || current.Count != 0) return null;
        if (validation["settled"]?.GetValue<bool>() == true) return null;
        var before = baseline?.Count ?? 0;
        var fixedCount = (validation["fixed"] as JsonArray)?.Count ?? 0;
        if (before == 0 && fixedCount == 0) return null;
        return $"the Studio returned no TrueChange message for the merged module while its base had {Math.Max(before, fixedCount)}: "
            + "the validation of the merged module is unavailable (VERIFY_UNAVAILABLE), so no \"0 errors\" is claimed. "
            + "Read o11_studio errors once the Studio is idle before publishing.";
    }

    public static JsonObject Evaluate(IReadOnlyList<MessageInfo> fresh, JsonArray verdicts)
    {
        var known = verdicts.OfType<JsonObject>()
            .Select(v => (Id: v["id"]?.ToString() ?? "", Path: v["path"]?.ToString() ?? "", Verdict: v["verdict"]?.ToString() ?? "unexpected", Node: v))
            .ToList();
        var accepted = new JsonArray(); var unexpected = new JsonArray();
        foreach (var message in fresh)
        {
            var match = known.FirstOrDefault(v => v.Id == message.Id && v.Path == (message.Path ?? "") && v.Verdict != "unexpected");
            var entry = new JsonObject { ["id"] = message.Id, ["type"] = message.Type, ["path"] = message.Path, ["detail"] = message.Detail };
            if (message.OwnerKey != null) entry["ownerKey"] = message.OwnerKey;
            var judgedUnexpected = known.Any(v => v.Id == message.Id && v.Path == (message.Path ?? ""));
            if (match.Node != null) { entry["verdict"] = match.Verdict; if (match.Node["reason"] is JsonValue reason) entry["reason"] = reason.DeepClone(); accepted.Add(entry); }
            // A03: a warning the apply did not foresee blocks nothing unless it is a security warning.
            else if (!judgedUnexpected && !message.IsError && !SecurityWarnings.IsSecurity(message.Id, message.Detail))
            {
                entry["verdict"] = MessageExpectations.NonBlockingVerdict; entry["reason"] = MessageExpectations.NonBlockingReason;
                accepted.Add(entry);
            }
            else
            {
                entry["verdict"] = "unexpected";
                entry["reason"] = judgedUnexpected ? "unexpected-in-apply"
                    : !message.IsError && SecurityWarnings.Ids.Contains(message.Id) ? "security:" + message.Id : "not-foreseen-by-apply";
                unexpected.Add(entry);
            }
        }
        return new JsonObject { ["source"] = "verdicts", ["accepted"] = unexpected.Count == 0, ["matched"] = accepted, ["unexpected"] = unexpected };
    }
}
