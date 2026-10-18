using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// fix-ext-refs, review round 3 (F1, F2, F3): ONE rule for every Studio write a delivery makes outside its merge. Every
/// refresh_references the delivery sends goes through <see cref="CallStudioWrite"/>: the Studio's Manage Dependencies before
/// the snapshot, the Refresh References before the merge (C26) and its fallback, the Refresh References after the
/// dependencies dialog (MB2: at the open, after the merge, before the verification) and the alignment after a rollback. Each
/// call leaves one record in the task's studioWrites (the only builder of a declaration): {command, stage, module, outcome
/// (changed, unchanged, pending, ended, unknown, failed, refused), added[], requested[], refreshed[], moved[{producer, before,
/// after}], blockedBy, error, fallback, undo, text}. Every answer reads that list: Fail rewrites "nothing was applied/written"
/// to "nothing was merged" once any record wrote or may have written, and says each record once with its undo; the facade
/// projects it as a short protected field. A command the person must answer (the bridge's blocked/outcome running) or a call
/// the Studio stopped answering is pending: it may still write; a later run of the task says it ended by itself after the
/// answer and what that run observed, never "added nothing" or "changed nothing".
/// </summary>
public static partial class Delivery
{
    /// <summary>Outcomes that changed the module or may have changed it: an answer never says that nothing was applied.</summary>
    private static readonly string[] WriteOutcomes = ["changed", "pending", "ended", "unknown"];

    /// <summary>Starts a run of the task. Review round 4 (N1): a record says only what a run observed, so an earlier run's
    /// pending or unknown record stays as it is here; it ends only on evidence (<see cref="EndStudioWrites"/>: the CX14 idle
    /// proof, or the same command answering in this run).</summary>
    internal static void BeginStudioWritesRun(JsonObject result) => result["studioWritesRun"] = Guid.NewGuid().ToString("N");

    /// <summary>Review round 4 (N1): the evidence that the Studio commands of earlier runs whose end was not seen (pending,
    /// unknown) ended: <paramref name="by"/> "idle" (two CX14 idle reads proved the Studio idle) or "answer" (the same command
    /// answered in this run, <see cref="RecordStudioWrite"/>). A pending record becomes ended; an unknown one stays unknown
    /// (what it wrote is still not known) with the evidence of its end.</summary>
    internal static void EndStudioWrites(JsonObject result, string by, string? command = null)
    {
        var run = result["studioWritesRun"]?.ToString();
        foreach (var record in (result["studioWrites"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            if (record["outcome"]?.ToString() is not ("pending" or "unknown") || record["endedBy"] != null || record["run"]?.ToString() == run) continue;
            if (command != null && record["command"]?.ToString() != command) continue;
            record["endedBy"] = by;
            if (record["outcome"]?.ToString() == "pending") record["outcome"] = "ended";
        }
    }

    /// <summary>The one call of refresh_references a delivery makes (any stage): its record is kept before the answer is
    /// read. A call refused before it ran (executed false) leaves none. A stall is pending (the call may still run in the
    /// Studio). Review round 4 (N2): any other failure after the call was sent (the bridge's "its outcome is unknown" or an
    /// exception inside the command, executed null; the client's lost reply or expired deadline, IOException) is an unknown
    /// record, fenced as a UI call that may still run (pendingBridgeOperation, CX14): the next run proves the Studio idle
    /// before anything else and never sends it again blind. Then the exception goes on.</summary>
    internal static JsonObject CallStudioWrite(IBridgeClient bridge, JsonObject result, string stage, JsonObject parameters, string module)
    {
        JsonObject answer;
        try { answer = bridge.Call("refresh_references", parameters); }
        catch (BridgeCallException ex) when (ex.Executed == false) { throw; }
        catch (BridgeCallException ex) when (ex.Stall != null)
        {
            RecordStudioWrite(result, stage, new JsonObject { ["blocked"] = true, ["outcome"] = "stalled", ["verdict"] = ex.Stall["verdict"]?.DeepClone(),
                ["blockedBy"] = ex.Stall["blockedBy"]?.DeepClone() }, parameters, module);
            throw;
        }
        catch (Exception ex) when (ex is BridgeCallException or IOException or TimeoutException)
        {
            var record = RecordStudioWrite(result, stage, new JsonObject { ["unknownOutcome"] = Errors.Text(ex) }, parameters, module);
            if (result["pendingBridgeOperation"] == null)
                result["pendingBridgeOperation"] = new JsonObject { ["method"] = "refresh_references", ["moduleKey"] = result["moduleKey"]?.DeepClone(),
                    ["command"] = record["command"]?.DeepClone(), ["outcomeUnknown"] = record["error"]?.DeepClone() };
            throw;
        }
        RecordStudioWrite(result, stage, answer, parameters, module);
        return answer;
    }

    /// <summary>The record of one refresh_references the delivery sent (<see cref="CallStudioWrite"/>).</summary>
    internal static JsonObject RecordStudioWrite(JsonObject result, string stage, JsonObject answer, JsonObject parameters, string module)
    {
        var manage = parameters["add"] is JsonArray;
        var command = manage ? ManageDependenciesCommand : answer["command"]?.ToString() is { Length: > 0 } named ? named : RefreshReferencesCommand;
        var blocked = answer["blocked"]?.GetValue<bool>() == true;
        string outcome;
        if (answer["unknownOutcome"] is not null) outcome = "unknown";
        else if (blocked) outcome = "pending";
        else if (manage)
            outcome = answer["committed"]?.GetValue<bool>() == true ? (answer["changed"]?.GetValue<bool>() ?? true ? "changed" : "unchanged")
                : answer["problems"] is JsonArray { Count: > 0 } ? "refused" : "failed";
        else outcome = answer["changed"] is null ? "unknown" : answer["changed"]!.GetValue<bool>() ? "changed" : "unchanged";
        var record = new JsonObject
        {
            ["command"] = command, ["stage"] = stage, ["module"] = answer["module"]?.ToString() is { Length: > 0 } name ? name : module, ["outcome"] = outcome,
            ["run"] = result["studioWritesRun"]?.DeepClone(), ["atUtc"] = DateTime.UtcNow.ToString("O"),
            ["added"] = new JsonArray((answer["added"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(a => (JsonNode)new JsonObject {
                ["producer"] = a["producer"]?.DeepClone(), ["element"] = a["element"]?.DeepClone(), ["type"] = a["type"]?.DeepClone() }).ToArray()),
            ["requested"] = new JsonArray((parameters["add"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(a => (JsonNode)new JsonObject {
                ["producer"] = a["producer"]?.DeepClone(), ["elements"] = (a["elements"] as JsonArray ?? new JsonArray()).DeepClone() }).ToArray()),
            ["producers"] = Strings(parameters["producers"]).Count > 0 ? new JsonArray(Strings(parameters["producers"]).Select(p => (JsonNode)p).ToArray())
                : new JsonArray(Strings(answer["refreshed"]).Concat(Strings(answer["upToDate"])).Distinct().Select(p => (JsonNode)p).ToArray()),
            ["refreshed"] = new JsonArray(Strings(answer["refreshed"]).Select(p => (JsonNode)p).ToArray()),
            ["moved"] = new JsonArray((answer["references"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(Moved).Select(r => (JsonNode)new JsonObject {
                ["producer"] = r["producer"]?.DeepClone(), ["before"] = r["hashBefore"]?.DeepClone(), ["after"] = r["hashAfter"]?.DeepClone() }).ToArray()),
        };
        if (blocked && answer["blockedBy"] is JsonObject by) record["blockedBy"] = new JsonObject { ["title"] = by["title"]?.DeepClone(), ["question"] = by["question"]?.DeepClone() };
        if (blocked && answer["outcome"]?.ToString() == "stalled") { record["stalled"] = true; record["verdict"] = answer["verdict"]?.DeepClone(); }
        if (outcome == "failed") record["error"] = answer["error"]?.DeepClone() ?? "no cause reported";
        if (answer["unknownOutcome"] is { } lost) record["error"] = lost.DeepClone();
        if (outcome == "refused") record["problems"] = (answer["problems"] as JsonArray)!.Count;
        if (WriteOutcomes.Contains(outcome)) record["undo"] = "Ctrl+Z in Service Studio undoes it (its own Studio command, \"" + command + "\"); nothing was published";
        // N1: the same command answering in this run is the evidence that the one of an earlier run ended; what this run
        // observes before its own command (the elements already referenced, the references' signature before it ran) is said
        // with it. Never this run's own additions (review round 4, N3).
        if (outcome is "changed" or "unchanged" or "failed" or "refused")
        {
            EndStudioWrites(result, "answer", command);
            foreach (var earlier in (result["studioWrites"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                .Where(e => e["endedBy"] != null && e["run"]?.ToString() != result["studioWritesRun"]?.ToString() && e["command"]?.ToString() == command && e["observed"] == null && outcome is "changed" or "unchanged"))
                earlier["observed"] = new JsonObject
                {
                    ["referenced"] = new JsonArray((answer["alreadyReferenced"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                        .Select(a => (JsonNode)new JsonObject { ["producer"] = a["producer"]?.DeepClone(), ["element"] = a["element"]?.DeepClone() }).ToArray()),
                    ["upToDate"] = new JsonArray(Strings(answer["upToDate"]).Select(p => (JsonNode)p).ToArray()),
                    ["at"] = new JsonArray((answer["references"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(r => (JsonNode)new JsonObject {
                        ["producer"] = r["producer"]?.DeepClone(), ["hash"] = r["hashBefore"]?.DeepClone() }).ToArray()),
                };
        }
        if (result["studioWrites"] is not JsonArray list) result["studioWrites"] = list = new JsonArray();
        list.Add(record);
        record["text"] = StudioWriteText(record, merged: false, result["studioWritesRun"]?.ToString());
        return record;
    }

    /// <summary>Whether a record changed the module or may have changed it.</summary>
    internal static bool StudioWrote(JsonNode? record) => record is JsonObject r && WriteOutcomes.Contains(r["outcome"]?.ToString());

    /// <summary>The last pending or unknown record of the task (the command a stopped refresh_references was), or null.</summary>
    internal static string? PendingStudioCommand(JsonObject result)
        => (result["studioWrites"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().LastOrDefault(r => r["outcome"]?.ToString() is "pending" or "unknown")?["command"]?.ToString();

    /// <summary>The sentence of a record (the only text of a declaration). <paramref name="merged"/>: the task's merge applied
    /// after it, so its undo comes after the merge's own.</summary>
    internal static string StudioWriteText(JsonObject record, bool merged, string? currentRun = null)
    {
        var stage = record["stage"]?.ToString();
        var when = stage switch { "open" => "When the module opened", "merge" => "After the merge", "verify" => "Before the verification", "after-rollback" => "After the rollback", _ => "Before the merge" };
        var command = record["command"]?.ToString() ?? RefreshReferencesCommand;
        var module = record["module"]?.ToString() ?? "the module";
        var manage = command == ManageDependenciesCommand;
        var undoFirst = merged && stage is "open" or "before-merge" ? "After the merge's own undo, one more Ctrl+Z in Service Studio undoes it" : "Ctrl+Z in Service Studio undoes it";
        var undo = undoFirst + "; nothing was published.";
        var producers = Names(Strings(record["producers"]).DefaultIfEmpty("the producers").ToList());
        var requested = (record["requested"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(r => (r["elements"] as JsonArray)?.Count > 0)
            .Select(r => Names((r["elements"] as JsonArray)!.Select(e => ElementOf(e?.ToString())).ToList()) + " of " + r["producer"]).ToList();
        var mayDo = manage ? (requested.Count > 0 ? "add " + string.Join("; ", requested) + " and bring " + producers + " to the published signature" : "bring " + producers + " to the published signature")
            : "refresh the references of " + producers;
        var mayHave = manage ? (requested.Count > 0 ? "added " + string.Join("; ", requested) + " and brought " + producers + " to the published signature" : "brought " + producers + " to the published signature")
            : "refreshed the references of " + producers;
        // N1: "waits for the person" only when a dialog was seen: the bridge's blocked answer, or a stall whose verdict was a dialog.
        var stalled = record["stalled"]?.GetValue<bool>() == true;
        var verdict = record["verdict"]?.ToString();
        var dialogTitle = record["blockedBy"]?["title"]?.ToString();
        var sawDialog = !stalled ? dialogTitle != null : verdict == "dialog";
        var waits = stalled ? "did not finish (the Studio stopped answering" + (verdict == "dialog" && dialogTitle != null ? ": it showed \"" + dialogTitle + "\"" : verdict is { Length: > 0 } ? ": " + verdict : "") + ")"
            : "waits for the person in the Studio" + (dialogTitle != null ? " (\"" + dialogTitle + "\"" + (record["blockedBy"]?["question"] is { } question ? ": " + question : "") + ")" : "");
        var waited = stalled ? waits : "waited for the person" + (dialogTitle != null ? " (\"" + dialogTitle + "\")" : "");
        var earlierRun = currentRun != null && record["run"]?.ToString() is { Length: > 0 } recordRun && recordRun != currentRun;
        var evidence = record["endedBy"]?.ToString() switch { "idle" => "two reads then proved the Studio idle", "answer" => "this run's " + command + " answered", _ => null };
        var observedText = ObservedText(record, manage);
        switch (record["outcome"]?.ToString())
        {
            case "pending" when earlierRun:
                return when + " in an earlier run of this task, the Studio's " + command + " " + waited + "; it may still be waiting or may have ended, and it may "
                    + mayDo + " in " + module + ". " + undoFirst + " whatever it changed; nothing was published.";
            case "pending":
                return when + ", the Studio's " + command + " " + waits + " and may still " + mayDo + " in " + module + (sawDialog ? " after the answer" : "") + ", in its own Studio command. " + undoFirst + ".";
            case "unknown":
            {
                var lost = record["error"]?.ToString() is { Length: > 0 } error ? " (" + error + ")" : "";
                if (!earlierRun)
                    return when + ", the Studio's " + command + " got no answer that says what it did" + lost + ": whether it changed " + module + " is unknown, and it may still "
                        + mayDo + ". " + undoFirst + " whatever it changed; nothing was published.";
                return when + " in an earlier run of this task, the Studio's " + command + " got no answer that says what it did" + lost
                    + (evidence != null ? "; it has ended (" + evidence + "), and whether it changed " + module + " is unknown: it may have " + mayHave + observedText
                        : "; it may still be running or may have ended, and whether it changed " + module + " is unknown: it may " + mayDo)
                    + ". " + undoFirst + " whatever it changed; nothing was published.";
            }
            case "ended":
            {
                return when + " in an earlier run of this task, the Studio's " + command + " " + waited + " and has ended (" + (evidence ?? "a later run saw its end") + "): it may have "
                    + mayHave + " in " + module + observedText + ". " + undo;
            }
            case "failed":
                return when + ", the Studio's Manage Dependencies failed inside the Studio (" + record["error"] + ") and its command rolled back, so it added nothing to " + module
                    + (record["fallback"]?.ToString() is { Length: > 0 } fallback ? "; the delivery went on with the Studio's " + fallback + " instead" : "") + ".";
            case "refused":
                return when + ", the Studio's Manage Dependencies refused the elements (its command rolled back), so it added nothing to " + module + ".";
            case "unchanged":
                return when + ", the Studio's " + command + " changed nothing in " + module + (manage ? ": every element was already referenced at the published signature." : ": its references were up to date.");
        }
        if (manage)
        {
            var added = (record["added"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().GroupBy(a => a["producer"]?.ToString() ?? "?", StringComparer.OrdinalIgnoreCase)
                .Select(g => Names(g.Select(a => a["element"]?.ToString() ?? "?").ToList()) + " of " + g.Key).ToList();
            var moved = (record["moved"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                .Select(r => r["producer"] + " (" + Short(r["before"]?.ToString()) + " -> " + Short(r["after"]?.ToString()) + ")").ToList();
            return when + ", the Studio's Manage Dependencies changed " + module + " in its own Studio command: it " + (added.Count > 0 ? "added " + string.Join("; ", added) : "added no element")
                + (moved.Count > 0 ? " and brought " + string.Join(", ", moved) + " to the published signature" : "") + ". " + undo;
        }
        var refreshed = Strings(record["refreshed"]);
        return when + ", the Studio's " + command + " changed " + module + " in its own Studio command: it refreshed "
            + (refreshed.Count > 0 ? Names(refreshed) : "the references of " + producers) + " to their published signatures. " + undo;
    }

    /// <summary>What a later run observed of the producers of a record whose end it saw (<see cref="RecordStudioWrite"/>):
    /// the elements already referenced and the signature before that run's own command; empty when nothing was observed.</summary>
    private static string ObservedText(JsonObject record, bool manage)
    {
        if (record["observed"] is not JsonObject observed) return "";
        var referenced = (observed["referenced"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .GroupBy(a => a["producer"]?.ToString() ?? "?").Select(g => Names(g.Select(a => a["element"]?.ToString() ?? "?").ToList()) + " of " + g.Key).ToList();
        var at = (observed["at"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(a => a["hash"] != null).Select(a => a["producer"] + " at " + Short(a["hash"]?.ToString())).ToList();
        var upToDate = Strings(observed["upToDate"]);
        return "; this run found " + (manage ? (referenced.Count > 0 ? string.Join("; ", referenced) + " referenced" : "no element of it referenced") + (at.Count > 0 ? ", with " + string.Join(", ", at) : "")
            : (upToDate.Count > 0 ? "the references of " + Names(upToDate) + " up to date" : "nothing left to refresh")) + " (what the module did not have before is that command's write)";
    }

    /// <summary>The sentences of every record worth saying (a write, a possible write, a Manage Dependencies that failed inside
    /// the Studio), each recomputed for the merge's outcome, also copied to the detail fields; empty when none.</summary>
    internal static string StudioWritesText(JsonObject result)
    {
        var merged = result["writeState"]?.ToString() == "applied";
        var sentences = new List<string>();
        var records = (result["studioWrites"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToList();
        foreach (var record in records)
        {
            record["text"] = StudioWriteText(record, merged, result["studioWritesRun"]?.ToString());
            if (StudioWrote(record) || record["outcome"]?.ToString() == "failed") sentences.Add(record["text"]!.ToString());
        }
        // The detail fields (referencesAdded, referencesRefreshedBeforeMerge, referencesAddedAfterRollback) say the text of their record.
        foreach (var field in new[] { "referencesAdded", "referencesRefreshedBeforeMerge", "referencesAddedAfterRollback" })
            if (result[field] is JsonObject detail && detail["write"]?.GetValue<int>() is int index && index >= 0 && index < records.Count)
                detail["text"] = records[index]["text"]!.ToString();
        return string.Join(" ", sentences);
    }

    /// <summary>The detail field <paramref name="field"/> belongs to the last record (its text is that record's).</summary>
    internal static void LinkDetail(JsonObject result, string field)
    {
        if (result[field] is not JsonObject detail || result["studioWrites"] is not JsonArray { Count: > 0 } list) return;
        detail["write"] = list.Count - 1;
        detail["text"] = (list[^1] as JsonObject)?["text"]?.DeepClone();
    }

    /// <summary>An answer of a task whose Studio writes outside the merge changed the module, or may have, never says that
    /// nothing was applied or written (only the merge did not run or rolled back); it says each record once, with its undo.</summary>
    internal static string DeclareStudioWrites(JsonObject result, string message)
    {
        var said = StudioWritesText(result);
        if ((result["studioWrites"] as JsonArray ?? new JsonArray()).Any(StudioWrote))
            message = message.Replace("Nothing was applied", "Nothing was merged", StringComparison.Ordinal)
                .Replace("nothing was applied", "nothing was merged", StringComparison.Ordinal)
                .Replace("Nothing was written", "Nothing was merged", StringComparison.Ordinal)
                .Replace("nothing was written", "nothing was merged", StringComparison.Ordinal);
        if (said.Length == 0 || message.Contains(said, StringComparison.Ordinal)) return message;
        var trimmed = message.TrimEnd();
        return trimmed + (trimmed.EndsWith('.') ? " " : ". ") + said;
    }

    private static List<string> Strings(JsonNode? node)
        => (node as JsonArray ?? new JsonArray()).Select(x => x is JsonObject o ? o["producer"]?.ToString() ?? o["name"]?.ToString() : x?.ToString())
            .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList();

    /// <summary>The element name of a reference op spelling ("IServerActionSignature:GenerateTemplatePowerPoint").</summary>
    private static string ElementOf(string? spec) => spec is null ? "?" : spec.Contains(':') ? spec[(spec.IndexOf(':') + 1)..] : spec;
}
