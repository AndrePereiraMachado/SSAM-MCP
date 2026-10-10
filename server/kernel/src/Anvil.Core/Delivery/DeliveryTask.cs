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
            state["closed"] = true; state["closedReason"] = reason; state["closedWithoutStudio"] = true; state["delivered"] = false;
            ReleaseReservation(state, request, id);
            task.Save("closed-for-revision");
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
        if (uncertain && state["operationId"]?.ToString() is { Length: > 0 } operationId)
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
                task.Save("close-refused-live-differs");
                throw new InvalidOperationException($"The live module differs from this task's base (live sha256 {liveSha}, base {baseSha}): the merge may be applied, "
                    + "so the task stays uncertain and is not closed. Resume it to reconcile; nothing was repeated");
            }
            state["merge"] = proof; state["writeState"] = "not-applied";
            state["error"] ??= "Merge outcome was unknown; closed with the proof that nothing was applied";
        }
        using var reservation = new ModuleReservation(Path.Combine(BridgeAccess.DirectoryPath, "reservations"), state["environment"]!.ToString(), state["moduleKey"]!.ToString(), request.ReservationOwner ?? id);
        state["closed"] = true; state["closedReason"] = reason; state["closedSnapshot"] = snapshot; state["delivered"] = false;
        task.Save("closed-for-revision"); reservation.Release(); return state;

        // A17: the module of this task no longer exists in the environment: nothing is left to prove or to protect there.
        JsonObject CloseGone(string evidence)
        {
            state["closed"] = true; state["closedReason"] = ModuleGoneReason; state["closeRequestReason"] = reason;
            state["moduleGone"] = new JsonObject { ["module"] = moduleName, ["moduleKey"] = moduleKey, ["evidence"] = evidence };
            state["delivered"] = false;
            ReleaseReservation(state, request, id);
            task.Save("closed-module-gone");
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
