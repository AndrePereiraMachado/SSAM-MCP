using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// The receipt of a merge_from_oml with the merge order (two native merges, MergeHandler), as the journal records it.
/// The second merge runs only on what the first left: merged, or nothing to merge (the first-pass copy equals the base).
/// While it runs, merged is unknown and secondPass reads started, so the journal state is "unknown": an exception or a
/// Studio that dies inside it reconciles as unknown (never repeated), never as the first merge alone. After it, merged is
/// true when either merge merged and undoSteps counts the native merges that merged (each one Studio command, one Ctrl+Z).
/// </summary>
public static class MergeReceipt
{
    public static bool RunsSecondPass(JsonObject receipt, bool firstPassHadNoDifferences)
        => receipt["merged"]?.GetValue<bool>() == true || firstPassHadNoDifferences;

    /// <summary>Marks the second merge as started; returns whether the first one merged.</summary>
    public static bool BeginSecondPass(JsonObject receipt)
    {
        var first = receipt["merged"]?.GetValue<bool>() == true;
        receipt["merged"] = null; receipt["secondPass"] = new JsonObject { ["state"] = "started" };
        return first;
    }

    public static void EndSecondPass(JsonObject receipt, JsonObject second, bool firstMerged)
    {
        var merged = second["merged"]?.GetValue<bool>() == true;
        receipt["secondPass"] = second;
        receipt["merged"] = firstMerged || merged;
        if (merged) receipt["result"] = second["result"]?.DeepClone();
        receipt["undoSteps"] = (firstMerged ? 1 : 0) + (merged ? 1 : 0);
    }
}

/// <summary>Write-ahead operation facts owned by the executor. Existing IDs never execute again.</summary>
public sealed class MergeJournal(string directory)
{
    private string PathFor(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("operation_id must be a GUID without separators");
        return Path.Combine(Path.GetFullPath(directory), id + ".json");
    }

    public JsonObject Status(string id, string? moduleKey = null)
    {
        var path = PathFor(id);
        var record = File.Exists(path) ? DurableJson.Read(path) : new() { ["operationId"] = id, ["state"] = "unknown" };
        if (File.Exists(path) && moduleKey != null && record["binding"]?["module_key"]?.ToString() != moduleKey)
            throw new InvalidOperationException("Operation belongs to another module");
        // fam-deps (finding 5): what the dialog watch of this operation recorded after the bridge answered: every dialog it
        // closed (also in the receipt, the superset of the receipt's own list) and the dialog that waits for the person now.
        var watch = DialogsPath(id);
        if (File.Exists(watch))
        {
            var seen = DurableJson.Read(watch);
            record["dialogWatch"] = true;
            record["dialogs"] = seen["dialogs"]?.DeepClone() ?? new JsonArray();
            var settled = record["state"]?.ToString() is "applied" or "unchanged" or "not-applied";
            record["pendingDialog"] = settled ? null : seen["pendingDialog"]?.DeepClone();
            if (record["receipt"] is JsonObject receipt && seen["dialogs"] is JsonArray all && all.Count > ((receipt["dialogs"] as JsonArray)?.Count ?? 0))
                receipt["dialogs"] = all.DeepClone();
        }
        return record;
    }

    private string DialogsPath(string id) => Path.ChangeExtension(PathFor(id), ".dialogs.json");

    /// <summary>fam-deps (finding 5): the dialogs the watch of operation <paramref name="id"/> closed and the one that now waits
    /// for the person (null: none), beside the journal record (the operation itself holds the record's lease while it runs).</summary>
    public void RecordDialogs(string id, JsonArray dialogs, JsonObject? pending)
        => DurableJson.Write(DialogsPath(id), new JsonObject { ["operationId"] = id, ["dialogs"] = dialogs.DeepClone(),
            ["pendingDialog"] = pending?.DeepClone(), ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O") });

    public Operation Begin(string id, JsonObject binding) => new(PathFor(id), id, binding);

    public sealed class Operation : IDisposable
    {
        private readonly string path;
        private readonly FileStream lease;
        public JsonObject State { get; }
        public bool IsNew { get; }
        internal Operation(string path, string id, JsonObject binding)
        {
            this.path = path;
            lease = DurableJson.Lease(path + ".lock");
            try
            {
                IsNew = !File.Exists(path);
                if (!IsNew)
                {
                    State = DurableJson.Read(path);
                    if (!JsonNode.DeepEquals(State["binding"], binding)) throw new InvalidOperationException("operation_id was already used with different bytes or target");
                }
                else
                {
                    State = new() { ["operationId"] = id, ["binding"] = binding.DeepClone(), ["state"] = "unknown", ["startedAt"] = DateTimeOffset.UtcNow.ToString("O") };
                    DurableJson.Write(path, State);
                }
            }
            catch { lease.Dispose(); throw; }
        }
        public void Record(JsonObject receipt)
        {
            State["receipt"] = receipt.DeepClone();
            State["state"] = receipt["merged"]?.GetValue<bool>() == true ? "applied"
                : receipt["reason"]?.ToString() == "no differences" ? "unchanged"
                : receipt["merged"]?.GetValue<bool>() == false ? "not-applied" : "unknown";
            State["recordedAt"] = DateTimeOffset.UtcNow.ToString("O");
            DurableJson.Write(path, State);
        }
        public void Failure(string error)
        {
            State["error"] = error;
            DurableJson.Write(path, State);
        }
        public void Dispose() => lease.Dispose();
    }
}
