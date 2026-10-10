using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SSAM.QueryTesting;

public sealed record QueryTestWork(JsonObject Description, Func<JsonObject> Send, Func<Task> Close, Func<Task>? BeforeSend = null);

/// <summary>At-most-once dispatch by UUID, with durable uncertainty and a per-target reservation.
/// Receipts persist metadata only. Row values, SQL, test values and native errors stay in memory.</summary>
public sealed class QueryTestRunner(string directory)
{
    private sealed class Entry
    {
        public required JsonObject State;
        public TaskCompletionSource Stop = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task Completion = Task.CompletedTask;
    }
    private readonly object gate = new();
    private readonly ConcurrentDictionary<string, Entry> entries = new();
    private string Receipt(string id) => Path.Combine(directory, id + ".json");
    private void Save(string id, JsonObject state)
    {
        var metadata = (JsonObject)state.DeepClone();
        foreach (var key in new[] { "rows", "columns", "sql", "parameters", "error" }) metadata.Remove(key);
        metadata["resultAvailable"] = false;
        var file = Receipt(id); var temp = file + ".tmp";
        File.WriteAllText(temp, metadata.ToJsonString()); File.Move(temp, file, true);
    }
    private JsonObject Read(string id)
    {
        if (entries.TryGetValue(id, out var entry)) return (JsonObject)entry.State.DeepClone();
        if (!File.Exists(Receipt(id))) return new() { ["ok"] = false, ["code"] = "QUERY_TEST_NOT_FOUND", ["operationId"] = id, ["execution"] = "unknown", ["next"] = "No receipt on this bridge. Confirm the original lane/process; absence is not permission to replay." };
        var state = JsonNode.Parse(File.ReadAllText(Receipt(id)))!.AsObject();
        if (state["state"]?.ToString() == "running") { state["state"] = "uncertain"; state["ok"] = false; state["execution"] = "uncertain"; }
        return state;
    }
    public async Task<JsonObject> Handle(JsonObject request, Func<Task<QueryTestWork>> prepare)
    {
        try
        {
            QueryTestContract.Validate(request);
            var op = request["op"]!.ToString();
            if (op == "describe") { var work = await prepare(); try { return work.Description; } finally { await work.Close(); } }
            var id = Guid.Parse(request["operationId"]!.ToString()).ToString("D");
            Entry entry;
            lock (gate)
            {
                if (op is "status" or "cancel")
                {
                    if (op == "cancel" && entries.TryGetValue(id, out var pending)) pending.Stop.TrySetResult();
                    var current = Read(id);
                    if (op == "cancel") { current["waitCancelled"] = true; current["serverCancelled"] = false; }
                    return current;
                }
                if (entries.ContainsKey(id) || File.Exists(Receipt(id))) return Read(id);
                // Bound private result retention in the resident Studio, not just individual responses.
                if (entries.Count >= 32)
                {
                    var old = entries.Where(e => e.Value.State["state"]?.ToString() == "completed").OrderBy(e => e.Value.State["completedAt"]?.ToString()).FirstOrDefault();
                    if (old.Key != null) entries.TryRemove(old.Key, out _);
                    else return new() { ["ok"] = false, ["code"] = "QUERY_TEST_CAPACITY", ["execution"] = "not-sent", ["next"] = "Reconcile existing operations; this bridge retains at most 32 active/result entries." };
                }
                Directory.CreateDirectory(directory);
                // Atomic across bridge instances. Stale/uncertain reservations are deliberately never stolen.
                var target = request["lane"] + "|" + request["environment"]!.ToString().ToLowerInvariant() + "|" + request["moduleKey"];
                var reservation = Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(target))) + ".pending");
                try { using var stream = new FileStream(reservation, FileMode.CreateNew, FileAccess.Write, FileShare.Read); using var writer = new StreamWriter(stream); writer.Write(id); }
                catch (IOException) when (File.Exists(reservation)) { return new() { ["ok"] = false, ["code"] = "QUERY_TEST_PENDING", ["execution"] = "not-sent", ["operationId"] = id, ["pendingOperationId"] = File.ReadAllText(reservation), ["next"] = "Read the pending operation status on its original bridge. Do not replay." }; }
                entry = new() { State = new() { ["ok"] = true, ["operationId"] = id, ["lane"] = request["lane"]!.DeepClone(), ["environment"] = request["environment"]!.DeepClone(), ["moduleKey"] = request["moduleKey"]!.DeepClone(), ["query"] = request["query"]!.DeepClone(), ["state"] = "running", ["execution"] = "uncertain", ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["next"] = "Use status with this operationId; never replay." } };
                // A durable receipt must exist BEFORE starting the native operation.
                try
                {
                    using var stream = new FileStream(Receipt(id), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                    var bytes = Encoding.UTF8.GetBytes(entry.State.ToJsonString()); stream.Write(bytes); stream.Flush(true);
                }
                catch (IOException) when (File.Exists(Receipt(id))) { File.Delete(reservation); return Read(id); }
                entries[id] = entry;
                entry.Completion = Task.Run(async () =>
                {
                    QueryTestWork? work = null; var sent = false; JsonObject result;
                    try { work = await prepare(); if(work.BeforeSend != null) await work.BeforeSend(); sent = true; result = work.Send(); }
                    catch (Exception error) { result = QueryTestContract.Failure(error, sent); }
                    finally { if (work != null) { try { await work.Close(); } catch { /* The detached model is never reused. */ } } }
                    lock (gate)
                    {
                        result["operationId"] = id; result["state"] = result["execution"]?.ToString() == "uncertain" ? "uncertain" : "completed";
                        result["completedAt"] = DateTimeOffset.UtcNow.ToString("O"); result["resultAvailable"] = true;
                        entry.State = result;
                        try { Save(id, result); if (result["state"]!.ToString() == "completed") File.Delete(reservation); }
                        catch { result["receiptWriteFailed"] = true; /* Keep reservation on persistence failure. */ }
                    }
                });
            }
            await Task.WhenAny(entry.Completion, entry.Stop.Task, Task.Delay(TimeSpan.FromSeconds(QueryTestContract.Integer(request, "timeoutSeconds", 30, 1, 120))));
            lock (gate)
            {
                var state = Read(id);
                if (state["state"]?.ToString() == "running") { state["waitEnded"] = entry.Stop.Task.IsCompleted ? "cancelled" : "timeout"; state["serverCancelled"] = false; }
                return state;
            }
        }
        catch (Exception error)
        {
            // A damaged/missing-readable receipt must never turn an earlier dispatch into "not-sent".
            var hasId = Guid.TryParse(request["operationId"]?.ToString(), out var operationId);
            var reconcile = hasId && (request["op"]?.ToString() is "status" or "cancel" || File.Exists(Receipt(operationId.ToString("D"))));
            var failure = QueryTestContract.Failure(error, reconcile);
            if (hasId) failure["operationId"] = operationId.ToString("D");
            return failure;
        }
    }
}
