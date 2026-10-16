using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>One delivery identity across retries. A checkpoint records facts, not permission to weaken a request.</summary>
public sealed class DeliveryTask : IDisposable
{
    private readonly FileStream lease;
    public string DirectoryPath { get; }
    public JsonObject State { get; }
    public string Id => State["taskId"]!.ToString();

    public DeliveryTask(DeliveryRequest request)
    {
        var id = request.TaskId ?? Guid.NewGuid().ToString("N");
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid delivery task ID");
        DirectoryPath = Path.Combine(Path.GetFullPath(request.WorkDirectory), "deliver", id);
        Directory.CreateDirectory(DirectoryPath);
        lease = DurableJson.Lease(Path.Combine(DirectoryPath, "run.lock"));
        try
        {
            var file = Path.Combine(DirectoryPath, "task.json");
            var binding = JsonSerializer.SerializeToNode(request with { TaskId = null })!;
            if (File.Exists(file))
            {
                State = DurableJson.Read(file);
                if (!JsonNode.DeepEquals(State["request"], binding)) throw new InvalidOperationException("Task request is fixed; resume without replacing its job, target or checks");
            }
            else
            {
                if (request.TaskId != null) throw new InvalidOperationException("Unknown delivery task; no operation was started");
                State = new() { ["taskId"] = id, ["request"] = binding, ["module"] = request.Module,
                    ["work"] = DirectoryPath, ["delivered"] = false, ["writeState"] = "not-sent", ["history"] = new JsonArray() };
                Save("registered");
            }
        }
        catch { lease.Dispose(); throw; }
    }

    public void Save(string stage)
    {
        State["stage"] = stage;
        State["sequence"] = (State["sequence"]?.GetValue<long>() ?? 0) + 1;
        State["updatedAt"] = DateTimeOffset.UtcNow.ToString("O");
        State["history"]!.AsArray().Add(new JsonObject { ["sequence"] = State["sequence"]!.DeepClone(), ["stage"] = stage,
            ["operationId"] = State["operationId"]?.DeepClone(), ["error"] = State["error"]?.DeepClone(),
            ["merge"] = stage == "merge-recorded" ? State["merge"]?.DeepClone() : null,
            ["writeState"] = State["writeState"]?.DeepClone(), ["time"] = State["updatedAt"]!.DeepClone() });
        DurableJson.Write(Path.Combine(DirectoryPath, "task.json"), State);
        // Human-readable projection; task.json is the checkpoint used for resumption.
        DurableJson.WriteBytes(Path.Combine(DirectoryPath, "result.json"), System.Text.Encoding.UTF8.GetBytes(State.ToJsonString(new JsonSerializerOptions(JsonSerializerOptions.Default) { WriteIndented = true })));
    }

    public static bool PrepareRepair(string work, string id)
    {
        var request = ResumeRequest(work, id);
        if (request.Specification == null) return false;
        using var task = new DeliveryTask(request);
        var state = task.State;
        if (state["everDelivered"]?.GetValue<bool>() == true || state["writeState"]?.ToString() is not ("applied" or "unchanged") ||
            state["dataProof"]?["accepted"]?.GetValue<bool>() != false || state["dataProof"]?["differences"] is not JsonArray { Count: > 0 } differences) return false;
        var fingerprint = AppSessions.Fingerprint(differences);
        var attempted = state["repairFingerprints"] as JsonArray ?? new JsonArray();
        if (attempted.Any(f => f?.ToString() == fingerprint)) return false;
        if (state["repairFingerprints"] == null) state["repairFingerprints"] = attempted;
        attempted.Add(fingerprint);
        var previous = new JsonObject();
        foreach (var key in new[] { "operationId", "snapshot", "apply", "merge", "mergePlan", "mergeOrder", "validation", "dataProof", "artifacts", "writeState" })
            previous[key] = state[key]?.DeepClone();
        var attempts = state["attempts"] as JsonArray ?? new JsonArray();
        if (state["attempts"] == null) state["attempts"] = attempts;
        attempts.Add(previous);
        state["attempt"] = (state["attempt"]?.GetValue<int>() ?? 0) + 1;
        state["hasAppliedWrites"] = state["hasAppliedWrites"]?.GetValue<bool>() == true || state["writeState"]?.ToString() == "applied";
        // The merge order's plan and losses belong to the attempt they were computed for (Delivery plans again).
        foreach (var key in new[] { "operationId", "snapshot", "apply", "merge", "mergePlan", "mergeOrder", "validation", "dataProof", "artifacts", "assertions", "failures", "error", "code" }) state.Remove(key);
        state["writeState"] = "not-sent"; state["delivered"] = false;
        task.Save("repair-prepared");
        return true;
    }

    /// <summary>Close a rejected, reconciled maintenance delivery so a corrected contract can be submitted.
    /// Never converts failure to success or permits replay of an uncertain write.
    /// A17: a task whose write never reached the module (writeState not-sent) or was proven not applied (not-applied) closes
    /// without any Studio call, and its reservation is released. A task with something to prove (applied, unchanged or
    /// uncertain) opens or selects its own module by key (open_module {module_key, environment}), never requiring the selected
    /// tab; a module that no longer exists (open_module answers not found, or the name now opens another identity) closes as
    /// closedReason "module gone".
    /// An uncertain task (writeState unknown or intent) closes only with the hash proof of C15: the live module captured now
    /// has exactly the bytes of the attempt's base, so nothing was applied (writeState becomes not-applied). Without a recorded
    /// base, or with a live module that differs, it stays uncertain and nothing is closed.</summary>
    public static JsonObject CloseKnownFailure(string work, string id, string reason, IBridgeClient bridge)
    {
        if (string.IsNullOrWhiteSpace(reason)) throw new ArgumentException("Closing requires a reason");
        var request = ResumeRequest(work, id);
        using var task = new DeliveryTask(request); var state = task.State;
        if (state["closed"]?.GetValue<bool>() == true) return state;
        // CX14 N6: what this close sends again after the proof of a call it settles (its open_module), for its notes.
        CountingBridge? settledBy = null;
        state.Remove("sentAgainAfterIdle");
        void Save(string stage) { FinishSettledNotes(state, settledBy); task.Save(stage); }
        // CX14: a queued UI operation may outlive the client. Inspect its journal BEFORE open_module, which would
        // block behind the very same modal. Unknown is not a rollback proof while that Studio can still run the work.
        // CX14 N3: a UI call that may still run (the pending one without a journal, or one stopped beside a pending merge,
        // pendingBridgeOperation.after) is proven idle before anything else, the merge's journal included.
        if (UnsettledUiCall(state) is { } running)
        {
            if (!InspectPendingUi(state, bridge)["idle"]!.GetValue<bool>())
            {
                task.Save("close-refused-pending-operation");
                throw new InvalidOperationException("The original Studio UI operation (" + running + ") is still pending or idle could not be proven twice; nothing was closed or repeated. Resolve its current blocker and resume inspection");
            }
            // CX14 R3: two idle reads proved that the UI call ended. Its fence is lifted and the task closes by its own
            // writeState below, which that call never changes: a known failure as before CX14, an uncertain merge only
            // with the hash proof.
            settledBy = CountingBridge.Wrap(bridge);
            settledBy.Settled.AddRange(SettlePendingUi(state));
            task.Save("pending-ui-settled");
            bridge = settledBy;
        }
        if (state["pendingBridgeOperation"] is JsonObject pending)
        {
            JsonObject? status = null;
            if (pending["operationId"]?.ToString() is { Length: > 0 } pendingId)
            {
                try { status = bridge.Call("merge_status", new JsonObject { ["operation_id"] = pendingId, ["module_key"] = pending["moduleKey"]?.DeepClone() }); }
                catch (Exception ex) when (ex is not OutOfMemoryException) { state["closeStatusError"] = Errors.Text(ex); }
                if (status != null) state["closeStatus"] = status.DeepClone();
                if (status?["state"]?.ToString() is "applied" or "unchanged")
                    throw new InvalidOperationException("The Studio's journal records this merge as " + status["state"] + "; resume the task to record it instead of closing it");
                if (status?["state"]?.ToString() == "not-applied")
                {
                    state["writeState"] = "not-applied";
                    if (status["receipt"] != null) state["merge"] = status["receipt"]!.DeepClone();
                    state.Remove("pendingBridgeOperation"); state.Remove("stalled");
                }
            }
            if (state["pendingBridgeOperation"] != null)
            {
                JsonObject? ping = null;
                try { ping = bridge.Call("ping"); }
                catch (Exception ex) when (ex is not OutOfMemoryException) { state["closePingError"] = Errors.Text(ex); }
                // CX14 R4: the Studio that ran the pending operation is the one recorded with it (pending.stall); the stop of
                // a later call (stalled, e.g. the resume's open_module in a restarted Studio) never stands for it.
                var known = (pending["stall"]?["studio"] ?? state["stalled"]?["studio"]) as JsonObject;
                var knownPid = PositivePid(known?["pid"]); var currentPid = PositivePid(ping?["pid"]);
                var previousStart = known?["startedUtc"]?.ToString(); var currentStart = ping?["startedUtc"]?.ToString();
                var anotherStudio = (knownPid != null && currentPid != null && knownPid != currentPid)
                    || (knownPid != null && currentPid == knownPid && !string.IsNullOrWhiteSpace(previousStart)
                        && !string.IsNullOrWhiteSpace(currentStart) && previousStart != currentStart);
                if (!anotherStudio)
                {
                    // CX14 R4: name the dialog that blocks the Studio now (one bounded read), never one that was closed.
                    ObserveBlocker(state, ReadWindows(bridge));
                    var title = state["stalled"]?["blockedBy"]?["title"]?.ToString();
                    state["next"] = (string.IsNullOrWhiteSpace(title) ? "Resolve the pending Studio operation" : "Close the Studio dialog \"" + title + "\"")
                        + " and resume task " + id + "; " + NotRepeated(settledBy);
                    Save("close-refused-pending-operation");
                    throw new InvalidOperationException("The original operation is still pending or unknown in the same Studio; a missing or malformed ping cannot prove that its queue ended. "
                        + state["next"] + ". The task was not closed and open_module was not called");
                }
                state["closeStudioChanged"] = new JsonObject { ["previous"] = known?.DeepClone(), ["current"] = ping?.DeepClone() };
            }
        }
        var writeState = state["writeState"]?.ToString();
        var uncertain = writeState is "unknown" or "intent";
        var baseSha = uncertain ? RollbackProof.BaseSha256(state) : null;
        if (state["delivered"]?.GetValue<bool>() == true || (uncertain ? baseSha == null || state["moduleKey"] == null || state["environment"] == null
                : state["error"] == null || writeState is not ("applied" or "unchanged" or "not-sent" or "not-applied")))
            throw new InvalidOperationException(uncertain
                ? "This uncertain delivery has no recorded base to prove that nothing was applied; resume it to reconcile instead"
                : "Only a known failed delivery can be closed; reconcile uncertain writes first");
        // A17: nothing of this task is in the module (never sent, or proven not applied): nothing to prove in the Studio.
        if (writeState is "not-sent" or "not-applied")
        {
            state["closed"] = true; state["closedReason"] = ClosedReason(state, reason, settledBy); state["closedWithoutStudio"] = true; state["delivered"] = false;
            state.Remove("pendingBridgeOperation"); state.Remove("stalled"); state.Remove("next"); state.Remove("pendingOperationRecovery");
            ReleaseReservation(state, request, id);
            Save("closed-for-revision");
            return state;
        }
        if (state["moduleKey"] == null || state["environment"] == null)
            throw new InvalidOperationException("This delivery has no recorded module identity to prove its state against; resume it to reconcile instead");
        var moduleKey = state["moduleKey"]!.ToString();
        var moduleName = state["module"]?.ToString() ?? request.Module;
        // A17: the task's own module, opened or selected by its key: the selected tab of the Studio does not matter.
        JsonObject opened;
        try
        {
            opened = bridge.Call("open_module", new JsonObject { ["name"] = moduleName, ["module_key"] = moduleKey,
                ["environment"] = state["environment"]!.DeepClone(), ["timeout"] = 20 });
        }
        catch (BridgeCallException ex) when (ModuleGone(ex.Message)) { return CloseGone(ex.Message); }
        state["closeOpen"] = opened.DeepClone();
        if (opened["opened"]?.GetValue<bool>() != true && opened["alreadyOpen"]?.GetValue<bool>() != true)
            throw new InvalidOperationException("The module of this task cannot be opened to close it: open_module is blocked: "
                + (opened["hint"]?.ToString() ?? opened["blockedBy"]?.ToJsonString()) + "; resolve it in Studio and close again");
        if (uncertain && state["pendingBridgeOperation"] == null && state["operationId"]?.ToString() is { Length: > 0 } operationId)
        {
            // The bridge's journal knows a merge that ended with a receipt: that one is resumed and recorded, never closed here.
            JsonObject? status = null;
            try { status = bridge.Call("merge_status", new JsonObject { ["operation_id"] = operationId, ["module_key"] = state["moduleKey"]!.DeepClone() }); }
            catch (Exception ex) when (ex is not OutOfMemoryException) { state["closeStatusError"] = ex.Message; }
            if (status?["receipt"] is JsonObject && status["state"]?.ToString() is "applied" or "unchanged")
                throw new InvalidOperationException("The Studio's journal records this merge as " + status["state"] + "; resume the task to record it instead of closing it");
        }
        var closedPath = Path.Combine(task.DirectoryPath, "closed-state.oml");
        JsonObject snapshot;
        try { snapshot = bridge.Call("snapshot_module", new JsonObject { ["path"] = closedPath, ["module_key"] = state["moduleKey"]!.DeepClone(), ["environment"] = state["environment"]!.DeepClone() }); }
        // The module opened by name, yet no tab has this task's key: the name now belongs to another module (the original was
        // deleted, maybe recreated). A bridge with module_key says so before capturing anything.
        catch (BridgeCallException ex) when (ex.Message.Contains("not open in any Studio tab", StringComparison.Ordinal)) { return CloseGoneByIdentity(ex.Message); }
        // An older bridge snapshots the selected tab, which open_module just selected: another key under the same name is gone too.
        if (snapshot["key"]?.ToString() is { Length: > 0 } capturedKey && capturedKey != moduleKey)
        {
            if (snapshot["name"]?.ToString() is not { Length: > 0 } capturedName || string.Equals(capturedName, moduleName, StringComparison.OrdinalIgnoreCase))
                return CloseGoneByIdentity("the module named " + moduleName + " now has the key " + capturedKey + ", not " + moduleKey);
            throw new InvalidOperationException("The Studio captured another module (" + capturedName + ") instead of " + moduleName + "; nothing was closed. Close again");
        }
        if (uncertain)
        {
            var liveSha = snapshot["sha256"]?.ToString() ?? (File.Exists(closedPath) ? DeliveryReceipt.Hash(closedPath) : null);
            var proof = RollbackProof.KernelReceipt(state["operationId"]?.ToString(), liveSha, baseSha, state["error"]?.ToString());
            state["closeProof"] = new JsonObject { ["liveSha256"] = liveSha, ["baseSha256"] = baseSha, ["equal"] = proof != null };
            if (proof == null)
            {
                Save("close-refused-live-differs");
                throw new InvalidOperationException($"The live module differs from this task's base (live sha256 {liveSha}, base {baseSha}): the merge may be applied, "
                    + "so the task stays uncertain and is not closed. Resume it to reconcile; " + NotRepeated(settledBy));
            }
            state["merge"] = proof; state["writeState"] = "not-applied";
            state["error"] ??= "Merge outcome was unknown; closed with the proof that nothing was applied";
        }
        using var reservation = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), state["environment"]!.ToString(), state["moduleKey"]!.ToString(), request.ReservationOwner ?? id);
        state["closed"] = true; state["closedReason"] = ClosedReason(state, reason, settledBy); state["closedSnapshot"] = snapshot; state["delivered"] = false;
        state.Remove("pendingBridgeOperation"); state.Remove("stalled"); state.Remove("next"); state.Remove("pendingOperationRecovery");
        Save("closed-for-revision"); reservation.Release(); return state;

        // A17: the module of this task no longer exists in the environment: nothing is left to prove or to protect there.
        JsonObject CloseGone(string evidence)
        {
            state["closed"] = true; state["closedReason"] = ModuleGoneReason; state["closeRequestReason"] = reason;
            state["moduleGone"] = new JsonObject { ["module"] = moduleName, ["moduleKey"] = moduleKey, ["evidence"] = evidence };
            state["delivered"] = false;
            ReleaseReservation(state, request, id);
            Save("closed-module-gone");
            return state;
        }
        // The name opens another identity: the original module is gone for a known failure; an uncertain write is never closed
        // on that inference (a renamed module keeps its key), only with the hash proof or the bridge's own "not found".
        JsonObject CloseGoneByIdentity(string evidence)
        {
            if (uncertain)
                throw new InvalidOperationException("No Studio tab holds this task's module key (" + evidence + "): the uncertain delivery stays open; resume it to reconcile");
            return CloseGone(evidence);
        }
    }

    private static int? PositivePid(JsonNode? node) => node is JsonValue value && value.TryGetValue<int>(out var pid) && pid > 0 ? pid : null;

    /// <summary>CX14 R3: the unjournaled UI call (open_module, close_module, refresh_references) this task left pending has
    /// ended: two current positive reads (InspectPendingUi) proved the Studio idle. Its fence is lifted and the call stays in
    /// settledBridgeOperations with its stop and that proof. Its outcome never changes the merge's writeState: the task goes
    /// on as any task of that writeState (a known failure closes, an applied merge is re-verified, an unknown one is
    /// reconciled through its journal). Nothing is sent here.</summary>
    /// CX14 N3: the same for a UI call that stopped beside a pending merge (pendingBridgeOperation.after): it is settled and
    /// the merge stays pending with its journal and its own evidence. N2: a settled refresh_references carries a note: it
    /// may have changed the module's references, Ctrl+Z in the Studio undoes it.
    internal static List<JsonObject> SettlePendingUi(JsonObject state)
    {
        var added = new List<JsonObject>();
        if (state["pendingBridgeOperation"] is not JsonObject pending) return added;
        var settled = state["settledBridgeOperations"] as JsonArray;
        if (settled == null) state["settledBridgeOperations"] = settled = new JsonArray();
        JsonObject Entry(JsonNode? call, JsonNode? stall)
        {
            // CX14 N6 (r4 guard): what the settling call sends again after its proof is not known until it ends; its end
            // (FinishSettledNotes) records the counts. A receipt whose call never ended keeps "ended": false.
            state["sentAgainAfterIdle"] = new JsonObject { ["ended"] = false };
            var method = call?["method"]?.ToString();
            var entry = new JsonObject { ["method"] = method, ["moduleKey"] = call?["moduleKey"]?.DeepClone(), ["stall"] = stall?.DeepClone(),
                ["idleProof"] = state["pendingUiProof"]?.DeepClone(), ["settledAt"] = DateTimeOffset.UtcNow.ToString("O") };
            // CX14 N6: the note is finished when the call that settled it ends (FinishSettledNotes): what that call sent again
            // and whether the merge was ever sent are facts of its end, not of this moment. Until then it says what may happen.
            if (method == "refresh_references") { entry["note"] = RefreshNoteFor(null, state["writeState"]?.ToString()); entry["noteOpen"] = true; }
            added.Add(entry);
            return entry;
        }
        if (string.IsNullOrWhiteSpace(pending["operationId"]?.ToString()))
        {
            settled.Add(Entry(pending, pending["stall"] ?? state["stalled"]));
            if (pending["after"] is JsonArray { Count: > 0 } rest) foreach (var call in rest) settled.Add(Entry(call, call?["stall"]));
            foreach (var name in new[] { "pendingBridgeOperation", "stalled", "pendingUiProof", "pendingOperationRecovery", "next" }) state.Remove(name);
            return added;
        }
        if (pending["after"] is not JsonArray { Count: > 0 } after) return added;
        foreach (var call in after) settled.Add(Entry(call, call?["stall"]));
        pending.Remove("after");
        foreach (var name in new[] { "pendingUiProof", "pendingOperationRecovery", "next" }) state.Remove(name);
        return added;
    }

    /// <summary>CX14 N2: what a settled Refresh References of this task means for the module.</summary>
    internal const string RefreshNote = "The Studio's Refresh References of this task stopped and then ended (two idle reads proved it): it may have changed the module's references, and Ctrl+Z in the Studio undoes it.";

    /// <summary>CX14 N6: the Studio UI calls of the delivery's normal steps that the stall rule fences: after the proven idle
    /// a resume (and a close, open_module) may send them again; merge_from_oml never twice.</summary>
    internal static readonly string[] UiCalls = ["refresh_references", "open_module", "close_module"];

    /// <summary>CX14 N6 (declared): what a note says while the call that settled it has not ended.</summary>
    internal const string MaySendAgain = " After that proof the delivery's normal steps may send refresh_references, open_module and close_module again; merge_from_oml is sent at most once per task.";

    /// <summary>CX14 N6: the note of a settled Refresh References. sentAgain null: the call that settled it has not ended (what
    /// it may still send); else what that call sent again after its proof, by the delivery's normal steps (MB2 when the
    /// dependencies dialog comes back, C26 when the task captured producers, the open and the tab close). "Never sent" only
    /// while the task's writeState is not-sent.</summary>
    internal static string RefreshNoteFor(JsonObject? sentAgain, string? writeState)
    {
        string again;
        if (sentAgain == null) again = MaySendAgain;
        else
        {
            var sent = SentNames(sentAgain);
            again = sent.Length > 0
                ? " After that proof the call that settled it sent again, as the delivery's normal steps do: " + string.Join(", ", sent) + "; merge_from_oml is sent at most once per task."
                : " After that proof the call that settled it sent none of refresh_references, open_module or close_module again.";
        }
        return RefreshNote + again + (writeState == "not-sent" ? " The merge of this task was never sent." : "");
    }

    /// <summary>CX14 N7: what an answer of a delivery or a close says of repetition. "nothing was repeated" only when the
    /// call settled no stopped UI call, or sent none of refresh_references, open_module and close_module again after its
    /// proof; otherwise only what is true: the merge was not repeated (merge_from_oml at most once per task). What the call
    /// sent again is in sentAgainAfterIdle and in the notes. sentence: capitalized, to start a sentence. Delivery.Run says it
    /// only in answers of an unsettled merge (intent, unknown), after which it sends nothing more (its tab stays open for
    /// the reconciliation), so the counts it reads are the call's final ones.</summary>
    internal static string NotRepeated(CountingBridge? settledBy, bool sentence = false)
    {
        var text = settledBy != null && UiCalls.Any(m => settledBy.Count(m) > 0) ? "the merge was not repeated" : "nothing was repeated";
        return sentence ? char.ToUpperInvariant(text[0]) + text[1..] : text;
    }

    /// <summary>"refresh_references 2x", ... for each UI call counted in sentAgain.</summary>
    internal static string[] SentNames(JsonObject sentAgain)
        => UiCalls.Select(m => (Method: m, Count: sentAgain[m] is JsonValue v && v.TryGetValue<int>(out var n) ? n : 0))
            .Where(x => x.Count > 0).Select(x => x.Method + " " + x.Count + "x").ToArray();

    /// <summary>CX14 N6: at the end of a call (and at each save of a close after its settlement). The call that settled
    /// (settledBy) records what it sent again after its proof, in the entries it settled (sentAgain) and for its answer
    /// (sentAgainAfterIdle, ended). Every refresh note then follows the task's writeState now; a note whose call never ended
    /// (noteOpen) keeps what may happen, never a count.</summary>
    internal static void FinishSettledNotes(JsonObject state, CountingBridge? settledBy)
    {
        if (settledBy != null)
        {
            var sent = new JsonObject { ["ended"] = true };
            foreach (var method in UiCalls) sent[method] = settledBy.Count(method);
            state["sentAgainAfterIdle"] = sent;
            foreach (var entry in settledBy.Settled.Where(e => e["method"]?.ToString() == "refresh_references"))
            {
                entry["sentAgain"] = sent.DeepClone(); entry.Remove("noteOpen");
            }
        }
        foreach (var entry in (state["settledBridgeOperations"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(e => e["method"]?.ToString() == "refresh_references"))
            entry["note"] = RefreshNoteFor(entry["noteOpen"] == null ? entry["sentAgain"] as JsonObject : null, state["writeState"]?.ToString());
    }

    /// <summary>CX14 N3: the UI call of this task that may still run in the Studio (its method), or null: the pending call
    /// without a journal, or one that stopped beside a pending merge (pendingBridgeOperation.after).</summary>
    internal static string? UnsettledUiCall(JsonObject state)
    {
        if (state["pendingBridgeOperation"] is not JsonObject pending) return null;
        if (string.IsNullOrWhiteSpace(pending["operationId"]?.ToString())) return pending["method"]?.ToString() ?? "UI operation";
        return pending["after"] is JsonArray { Count: > 0 } after ? after[0]?["method"]?.ToString() ?? "UI operation" : null;
    }

    /// <summary>CX14 N2: the reason a task closed with, plus what a settled Refresh References of it may have changed.</summary>
    private static string ClosedReason(JsonObject state, string reason, CountingBridge? settledBy)
    {
        // CX14 N6: the notes settled by this close end here, with what it sent again (its open_module) and the final writeState.
        FinishSettledNotes(state, settledBy);
        var note = (state["settledBridgeOperations"] as JsonArray)?.OfType<JsonObject>().LastOrDefault(e => e["method"]?.ToString() == "refresh_references")?["note"]?.ToString();
        return note != null ? reason + " (" + note + ")" : reason;
    }

    /// <summary>Two current positive reads prove that an unjournaled UI operation has ended, never that it rolled back.
    /// This observation authorizes only the existing close proof, not another attempt at its write.</summary>
    internal static JsonObject InspectPendingUi(JsonObject state, IBridgeClient bridge)
    {
        var reads = new JsonArray(); var idle = true;
        for (var sample = 0; sample < 2; sample++)
        {
            var errors = new JsonObject();
            JsonObject? Read(string method, JsonObject? arguments = null)
            {
                try { return bridge.Call(method, arguments); }
                catch (Exception ex) when (ex is not OutOfMemoryException) { errors[method] = Errors.Text(ex); return null; }
            }
            JsonArray? windows, modules; JsonObject? alive;
            if (bridge is IBridgeProbeReader reader)
            {
                // Each read owns a 250ms cancellable socket; all three run together. No abandoned UI tasks or long
                // normal-call deadlines. A timeout is null/no evidence, so two samples cost about 500ms at most.
                var windowRead = reader.ReadProbeAsync("windows", new() { ["max_texts"] = BridgeStallRule.MaxTexts }, 250);
                var aliveRead = reader.ReadProbeAsync("ui_alive", new() { ["timeout_ms"] = 200 }, 250);
                var moduleRead = reader.ReadProbeAsync("list_open_modules", timeoutMs: 250);
                Task.WhenAll(windowRead, aliveRead, moduleRead).GetAwaiter().GetResult();
                windows = windowRead.Result?["windows"] as JsonArray; alive = aliveRead.Result; modules = moduleRead.Result?["modules"] as JsonArray;
            }
            else
            {
                // Deterministic in-process bridges used by the kernel's tests need no transport wrapper.
                windows = Read("windows", new() { ["max_texts"] = BridgeStallRule.MaxTexts })?["windows"] as JsonArray;
                alive = Read("ui_alive", new() { ["timeout_ms"] = 1000 });
                modules = Read("list_open_modules")?["modules"] as JsonArray;
            }
            var observed = ObserveBlocker(state, windows);
            var validWindows = observed != null;
            var dialogs = observed ?? [];
            var validModules = modules != null && modules.All(n => n is JsonObject m && OptionalFlag(m["serverSilentMode"])
                && OptionalFlag(m["hasOpenedActiveESpace"]) && (m["serverOperation"] == null
                    || m["serverOperation"] is JsonObject operation && OptionalFlag(operation["running"])));
            var opening = validModules ? modules!.OfType<JsonObject>().Count(m => Flag(m["serverSilentMode"]) == true || Flag(m["hasOpenedActiveESpace"]) == false) : 0;
            var running = validModules ? modules!.OfType<JsonObject>().Count(m => Flag(m["serverOperation"]?["running"]) == true) : 0;
            var uiAlive = Flag(alive?["alive"]) == true;
            idle &= validWindows && dialogs.Length == 0 && uiAlive && validModules && opening == 0 && running == 0;
            reads.Add(new JsonObject { ["windowsRead"] = validWindows, ["uiAlive"] = uiAlive,
                ["opening"] = validModules ? JsonValue.Create(opening) : null, ["serverOperations"] = validModules ? JsonValue.Create(running) : null,
                ["blockedByPresent"] = validWindows ? JsonValue.Create(dialogs.Length > 0) : null, ["errors"] = errors.Count > 0 ? errors : null });
        }
        var proof = new JsonObject { ["idle"] = idle, ["reads"] = reads, ["observedAt"] = DateTimeOffset.UtcNow.ToString("O") };
        state["pendingUiProof"] = proof;
        state["pendingOperationRecovery"] = new JsonObject { ["action"] = idle ? (state["delivered"]?.GetValue<bool>() == true ? "inspect-confirmed-delivery" : "close-with-hash-proof") : "wait-for-idle",
            ["taskId"] = state["taskId"]?.DeepClone(), ["idleProven"] = idle, ["baseRecorded"] = RollbackProof.BaseSha256(state) != null };
        return proof;
    }

    /// <summary>One `windows` read against the saved blocker (stalled.blockedBy): a valid read supersedes it with the dialog
    /// that counts now (the same one while it is still shown) or with none, so no answer offers to close a dialog that is no
    /// longer open. An unreadable read changes nothing and returns null; else the dialogs that count.</summary>
    private static JsonObject[]? ObserveBlocker(JsonObject state, JsonArray? windows)
    {
        var valid = windows != null && windows.All(n => n is JsonObject w && OptionalFlag(w["isVisible"])
            && OptionalFlag(w["isModal"]) && OptionalText(w["title"]) && OptionalText(w["type"])
            && (w["texts"] == null || w["texts"] is JsonArray texts && texts.All(t => t is JsonValue v && v.TryGetValue<string>(out _))));
        if (!valid) return null;
        // CX14 R2: typed text never classifies a window (the same rule as the stall verdict).
        static string[] Shown(JsonObject w) => BridgeStallRule.WithoutTypedText((w["texts"] as JsonArray)?.Select(Text) ?? []);
        var dialogs = windows!.OfType<JsonObject>().Where(w => Flag(w["isVisible"]) != false
            && (Flag(w["isModal"]) == true || Text(w["type"]).Contains("DialogWindow", StringComparison.Ordinal)))
            .Where(w => DialogPolicy.ClassifyWindow(Text(w["title"]), Shown(w)) != DialogPolicy.Progress).ToArray();
        if (state["stalled"] is JsonObject stalled)
        {
            var saved = Text(stalled["blockedBy"]?["title"]);
            if ((dialogs.FirstOrDefault(w => saved.Length > 0 && Text(w["title"]) == saved) ?? dialogs.FirstOrDefault()) is { } dialog)
            {
                stalled["blockedBy"] = new JsonObject { ["title"] = Text(dialog["title"]), ["type"] = Text(dialog["type"]),
                    ["kind"] = DialogPolicy.ClassifyWindow(Text(dialog["title"]), Shown(dialog)) };
                stalled.Remove("blockedByClearedAt");
            }
            else if (stalled["blockedBy"] != null)
            {
                stalled.Remove("blockedBy"); stalled["blockedByClearedAt"] = DateTimeOffset.UtcNow.ToString("O");
            }
            if (state["blockedBy"] is JsonObject old && !dialogs.Any(w => Text(w["title"]) == Text(old["title"])))
            { state.Remove("blockedBy"); state.Remove("question"); }
        }
        return dialogs;
    }

    /// <summary>One bounded `windows` read for an answer that names the Studio's blocker (CX14 R4); null when unreadable.</summary>
    private static JsonArray? ReadWindows(IBridgeClient bridge)
    {
        try
        {
            var reply = bridge is IBridgeProbeReader reader
                ? reader.ReadProbeAsync("windows", new() { ["max_texts"] = BridgeStallRule.MaxTexts }, 250).GetAwaiter().GetResult()
                : bridge.Call("windows", new() { ["max_texts"] = BridgeStallRule.MaxTexts });
            return reply?["windows"] as JsonArray;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return null; }
    }

    private static bool? Flag(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;
    private static bool OptionalFlag(JsonNode? node) => node == null || Flag(node) != null;
    private static string Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
    private static bool OptionalText(JsonNode? node) => node == null || node is JsonValue value && value.TryGetValue<string>(out _);

    /// <summary>The closedReason of a task whose module no longer exists (A17).</summary>
    public const string ModuleGoneReason = "module gone";

    /// <summary>The bridge's answer to open_module for a module the environment no longer has.</summary>
    public static bool ModuleGone(string? message)
        => message != null && System.Text.RegularExpressions.Regex.IsMatch(message,
            @"\b(not found|does not exist|doesn't exist|no longer exists|was deleted|has been deleted|no module named|unknown module)\b",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    /// <summary>Frees the module reservation of a closed task, when it has a module identity. A reservation another task holds
    /// is not this task's to free: it is left as it is and named in the task.</summary>
    private static void ReleaseReservation(JsonObject state, DeliveryRequest request, string id)
    {
        if (state["moduleKey"]?.ToString() is not { Length: > 0 } moduleKey || state["environment"]?.ToString() is not { Length: > 0 } environment) return;
        try
        {
            using var reservation = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), environment, moduleKey, request.ReservationOwner ?? id);
            reservation.Release();
        }
        catch (InvalidOperationException ex) { state["reservationNotReleased"] = ex.Message; }
    }

    public static DeliveryRequest ResumeRequest(string work, string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid delivery task ID");
        var file = Path.Combine(Path.GetFullPath(work), "deliver", id, "task.json");
        var state = DurableJson.Read(file);
        var request = state["request"]!.Deserialize<DeliveryRequest>()!;
        if (Path.GetFullPath(request.WorkDirectory) != Path.GetFullPath(work)) throw new InvalidOperationException("Task belongs to another delivery store");
        return request with { TaskId = id };
    }

    public void Dispose() => lease.Dispose();
}
