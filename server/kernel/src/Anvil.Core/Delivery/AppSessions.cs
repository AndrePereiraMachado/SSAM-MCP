using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>Host-captured requests and user-accepted data contracts. App tools cannot create their own source events.</summary>
public sealed class AppSessions(string directory, string? trustedWorkspace = null)
{
    private readonly string? workspace = trustedWorkspace == null ? null : CanonicalDirectory(trustedWorkspace);
    private string FilePath => Path.Combine(directory, "app-sessions.json");
    public JsonObject Capture(JsonObject input)
    {
        if (!InWorkspace(input)) return SuspendOutside(input);
        return Update(state =>
    {
        var session = Need(input, "session_id"); var turn = Need(input, "turn_id"); var prompt = Need(input, "prompt");
        if (prompt.Length > 1_000_000) throw new ArgumentException("Request is too large to capture without truncation");
        var sessions = state["sessions"]!.AsObject(); var tasks = state["tasks"]!.AsObject();
        var previous = sessions[session]?.ToString();
        JsonObject task;
        if (previous == null)
        {
            var id = Guid.NewGuid().ToString("N");
            task = new() { ["taskId"] = id, ["sessionId"] = session, ["state"] = "awaiting-contract", ["source"] = new JsonArray(), ["revisions"] = new JsonArray() };
            tasks[id] = task; sessions[session] = id;
        }
        else
        {
            task = tasks[previous]!.AsObject();
            if (!SameWorkspace(task))
            {
                Suspend(state, session, task);
                return Outside("This session belongs to another or legacy workspace; use a new task in the Hybrid project.");
            }
        }
        var events = task["source"]!.AsArray();
        var existing = events.OfType<JsonObject>().FirstOrDefault(e => e["turnId"]?.ToString() == turn);
        if (existing != null && existing["prompt"]?.ToString() != prompt) throw new InvalidOperationException("Captured user event cannot be replaced");
        if (existing == null) events.Add(new JsonObject { ["turnId"] = turn, ["prompt"] = prompt, ["at"] = DateTimeOffset.UtcNow.ToString("O") });
        if (workspace != null)
        {
            RevokePermits(state, session);
            task["workspaceRoot"] = workspace; task["workspaceActive"] = true; task["workspaceTurnId"] = turn;
        }
        return new() { ["taskId"] = task["taskId"]!.DeepClone(), ["captured"] = true };
    });
    }

    public JsonObject Guard(JsonObject input)
    {
        if (!InWorkspace(input)) return SuspendOutside(input);
        return Update(state =>
    {
        var tool = Need(input, "tool_name"); var session = Need(input, "session_id");
        var allowed = new[] { "mcp__ssam_hybrid__context", "mcp__ssam_hybrid__propose", "mcp__ssam_hybrid__continue", "mcp__ssam_hybrid__status" };
        var taskId = input["tool_input"]?["task_id"]?.ToString();
        var task = taskId == null ? null : state["tasks"]?[taskId]?.AsObject();
        var accepted = allowed.Contains(tool, StringComparer.Ordinal) && taskId != null && state["sessions"]?[session]?.ToString() == taskId;
        if (accepted && task != null && !SameWorkspace(task)) Suspend(state, session, task);
        accepted &= task != null && SameWorkspace(task) && (workspace == null || task["workspaceActive"]?.GetValue<bool>() == true
            && task["workspaceTurnId"]?.ToString() == input["turn_id"]?.ToString());
        if (accepted)
        {
            var permits = state["permits"] as JsonObject ?? new JsonObject();
            if (state["permits"] == null) state["permits"] = permits;
            var key = PermitKey(tool, input["tool_input"]!.AsObject());
            var queue = permits[key] as JsonArray ?? new JsonArray();
            if (permits[key] == null) permits[key] = queue;
            queue.Add(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            if (workspace != null)
            {
                var owners = state["permitSessions"] as JsonObject ?? new JsonObject();
                state["permitSessions"] ??= owners; owners[key] = session;
            }
        }
        return new() { ["allowed"] = accepted, ["inScope"] = true, ["reason"] = accepted ? null : "This app session can only use its own SSAM Hybrid task. Shell, file mutation, other tools and maintenance are unavailable." };
    });
    }

    public JsonObject ConsumePermit(string tool, JsonObject arguments) => Update(state =>
    {
        var taskId = arguments["task_id"]?.ToString();
        var task = taskId == null ? null : state["tasks"]?[taskId]?.AsObject();
        if (task != null && !SameWorkspace(task) || workspace != null && (task == null || task["workspaceActive"]?.GetValue<bool>() != true))
            throw new UnauthorizedAccessException("The Hybrid workspace session is not active for this MCP connection.");
        var key = PermitKey("mcp__ssam_hybrid__" + tool, arguments);
        var queue = state["permits"]?[key]?.AsArray();
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (queue != null) while (queue.Count > 0 && now - queue[0]!.GetValue<long>() > 120) queue.RemoveAt(0);
        if (queue == null || queue.Count == 0) throw new UnauthorizedAccessException("The trusted client hook did not authorize this exact tool call; app session is not active");
        queue.RemoveAt(0);
        return new() { ["authorized"] = true };
    });
    private static string PermitKey(string tool, JsonObject arguments) => Fingerprint(new JsonObject { ["tool"] = tool, ["arguments"] = arguments.DeepClone() });

    public JsonObject Context(string id) => Update(state =>
    {
        var task = Task(state, id);
        return new() { ["taskId"] = id, ["state"] = task["state"]!.DeepClone(), ["source"] = task["source"]!.DeepClone(),
            ["contract"] = task["contract"]?.DeepClone(), ["contractHash"] = task["contractHash"]?.DeepClone(),
            ["supportedScope"] = "data, declared action flow, and HTML/CSS/JS component source", ["schema"] = ModuleSpecification.Schema(), ["deliveryTaskId"] = task["deliveryTaskId"]?.DeepClone(),
            ["result"] = task["result"]?.DeepClone(),
            ["workspace"] = task["workspaceRoot"] == null ? null : new JsonObject {
                ["root"] = task["workspaceRoot"]!.DeepClone(), ["active"] = task["workspaceActive"]?.DeepClone() } };
    });

    public JsonObject Propose(string id, JsonObject proposal) => Update(state =>
    {
        var task = Task(state, id);
        ValidateProposal(proposal);
        var hash = Fingerprint(proposal);
        var previousDelivery = DeliveryState(task);
        var requiresNewDelivery = previousDelivery?["everDelivered"]?.GetValue<bool>() == true && previousDelivery["delivered"]?.GetValue<bool>() == false;
        if (task["contractHash"]?.ToString() == hash && !requiresNewDelivery) return new() { ["accepted"] = true, ["contractHash"] = hash };
        var sourceHash = Fingerprint(task["source"]!);
        if (task["contract"] != null && task["acceptedSourceHash"]?.ToString() == sourceHash)
            throw new InvalidOperationException("The accepted contract is fixed. A compiler error does not authorize changing requirements");
        task["proposal"] = proposal.DeepClone(); task["proposalHash"] = hash; task["proposalSourceHash"] = sourceHash;
        if (task["contract"] == null)
        {
            // The original user request authorizes its initial translation. Only later requirement changes need renewed acceptance.
            task["contract"] = proposal.DeepClone(); task["contractHash"] = hash; task["acceptedSourceHash"] = sourceHash;
            task["acceptedAt"] = DateTimeOffset.UtcNow.ToString("O"); task["state"] = "ready";
            task["interpretation"] = "initial LLM translation of the host-captured user request";
            return new() { ["accepted"] = true, ["contractHash"] = hash, ["contract"] = proposal.DeepClone(),
                ["scope"] = "Normalized module contract; source interpretation remains visible for review" };
        }
        return new() { ["accepted"] = false, ["requiresUserAcceptance"] = true, ["contractHash"] = hash,
            ["sourceHash"] = sourceHash, ["proposal"] = proposal.DeepClone() };
    });

    // Called only by the host's elicitation response handler, never exposed as an app tool.
    public JsonObject Accept(string id, string hash) => Update(state =>
    {
        var task = Task(state, id);
        if (task["proposalHash"]?.ToString() != hash || task["proposalSourceHash"]?.ToString() != Fingerprint(task["source"]!))
            throw new InvalidOperationException("Proposal or user input changed while awaiting acceptance; review the current contract");
        if (task["deliveryTaskId"] != null)
        {
            var checkpoint = DeliveryState(task);
            if (checkpoint?["writeState"]?.ToString() is "intent" or "unknown") throw new InvalidOperationException("Reconcile the pending write before changing requirements");
            var targetChanged = new[] { "module", "environment", "lane" }.Any(key => task["contract"]?[key]?.ToString() != task["proposal"]?[key]?.ToString());
            if (targetChanged && checkpoint?["hasAppliedWrites"]?.GetValue<bool>() == true && checkpoint["delivered"]?.GetValue<bool>() != true)
                throw new InvalidOperationException("Finish the already-applied delivery before changing its target; its changes remain available for review");
            task["revisions"]!.AsArray().Add(new JsonObject { ["contractHash"] = task["contractHash"]?.DeepClone(),
                ["contract"] = task["contract"]?.DeepClone(), ["deliveryTaskId"] = task["deliveryTaskId"]!.DeepClone() });
        }
        task["contract"] = task["proposal"]!.DeepClone(); task["contractHash"] = hash;
        task["acceptedSourceHash"] = task["proposalSourceHash"]!.DeepClone(); task["acceptedAt"] = DateTimeOffset.UtcNow.ToString("O");
        task["state"] = "ready"; task.Remove("deliveryTaskId"); task.Remove("result");
        return new() { ["accepted"] = true, ["contractHash"] = hash };
    });

    public JsonObject PrepareDelivery(string id) => Update(state =>
    {
        var task = Task(state, id);
        var contract = task["contract"]?.AsObject() ?? throw new InvalidOperationException("The user has not accepted a module contract");
        if (task["deliveryTaskId"] == null)
        {
            var lane = contract["lane"]!.ToString();
            var work = Path.Combine(directory, "deliveries", lane);
            var file = Path.Combine(directory, "contracts", id + "-" + task["contractHash"]!.ToString() + ".json");
            var specification = Content(contract);
            var document = specification.DeepClone().AsObject();
            document["expectedMessages"] = contract["expectedMessages"]?.DeepClone() ?? new JsonArray();
            DurableJson.WriteBytes(file, System.Text.Encoding.UTF8.GetBytes(document.ToJsonString()));
            var request = new DeliveryRequest(contract["module"]!.ToString(), file, work, Array.Empty<string>(),
                BridgePort: lane == "ss5" ? 4536 : 4516, Specification: specification, ExpectedEnvironment: contract["environment"]!.ToString(), ReservationOwner: id);
            using var delivery = new DeliveryTask(request);
            task["deliveryTaskId"] = delivery.Id; task["deliveryWork"] = work;
        }
        else DeliveryTask.PrepareRepair(task["deliveryWork"]!.ToString(), task["deliveryTaskId"]!.ToString());
        return new() { ["taskId"] = id, ["deliveryTaskId"] = task["deliveryTaskId"]!.DeepClone(),
            ["work"] = task["deliveryWork"]!.DeepClone(), ["lane"] = contract["lane"]!.DeepClone() };
    });

    public JsonObject Refresh(string id) => Update(state =>
    {
        var task = Task(state, id); var delivery = DeliveryState(task);
        if (delivery != null)
        {
            task["state"] = delivery["delivered"]?.GetValue<bool>() == true ? "complete" : delivery["writeState"]?.ToString() == "unknown" ? "reconcile" : "incomplete";
            task["result"] = new JsonObject { ["scope"] = "accepted module contract", ["delivered"] = delivery["delivered"]?.DeepClone(),
                ["hasAppliedWrites"] = delivery["hasAppliedWrites"]?.DeepClone(), ["writeState"] = delivery["writeState"]?.DeepClone(), ["stage"] = delivery["stage"]?.DeepClone(),
                ["error"] = delivery["error"]?.DeepClone(), ["dataProof"] = ProofSummary(delivery["dataProof"] as JsonObject),
                ["diagnostics"] = new JsonObject {
                    ["newErrors"] = delivery["newErrors"]?.DeepClone(), ["messageContract"] = delivery["contract"]?.DeepClone(),
                    ["preparation"] = delivery["apply"]?["accepted"]?.GetValue<bool>() == false ? new JsonObject {
                        ["details"] = delivery["apply"]?["details"]?.DeepClone(), ["policyMessages"] = delivery["apply"]?["policyMessages"]?.DeepClone(),
                        ["validation"] = delivery["apply"]?["validation"]?.DeepClone() } : null,
                    ["preMergeDifferences"] = delivery["requirementsBeforeMerge"]?["differences"]?.DeepClone() },
                ["elapsedMs"] = delivery["elapsedMs"]?.DeepClone(), ["failures"] = delivery["failures"]?.DeepClone() };
        }
        return new() { ["taskId"] = id, ["state"] = task["state"]!.DeepClone(), ["result"] = task["result"]?.DeepClone() };
    });

    // Full assertions and semantic bindings stay in the checkpoint. Tool responses keep every mismatch, not the proof matrix.
    private static JsonObject? ProofSummary(JsonObject? proof) => proof == null ? null : new JsonObject {
        ["accepted"] = proof["accepted"]?.DeepClone(), ["count"] = proof["count"]?.DeepClone(),
        ["differences"] = proof["differences"]?.DeepClone(), ["scope"] = proof["scope"]?.DeepClone(), ["actions"] = proof["actionSummary"]?.DeepClone(),
        ["elements"] = new JsonArray((proof["dataSummary"]?.AsArray().OfType<JsonObject>() ?? []).Select(element => (JsonNode)new JsonObject {
            ["name"] = element["name"]?.DeepClone(), ["kind"] = element["kind"]?.DeepClone(),
            ["attributes"] = element["attributes"]?.AsArray().Count ?? 0, ["records"] = element["records"]?.AsArray().Count ?? 0,
            ["indexes"] = new JsonArray((element["indexes"]?.AsArray().OfType<JsonObject>() ?? []).Select(index => index["name"]?.DeepClone()).ToArray()) }).ToArray()) };

    private JsonObject? DeliveryState(JsonObject task)
    {
        if (task["deliveryTaskId"] == null) return null;
        return DurableJson.Read(Path.Combine(task["deliveryWork"]!.ToString(), "deliver", task["deliveryTaskId"]!.ToString(), "task.json"));
    }
    private bool SameWorkspace(JsonObject task)
        => string.Equals(task["workspaceRoot"]?.ToString(), workspace, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private bool InWorkspace(JsonObject input)
    {
        if (workspace == null) return true;
        try
        {
            var cwd = CanonicalDirectory(Need(input, "cwd"));
            var relative = Path.GetRelativePath(workspace, cwd);
            return !Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or InvalidOperationException) { return false; }
    }

    private static string CanonicalDirectory(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("Hybrid workspace paths must be absolute.");
        var full = Path.GetFullPath(path);
        if (!Directory.Exists(full)) throw new ArgumentException("Hybrid workspace directory does not exist.");
        var current = Path.GetPathRoot(full)!;
        foreach (var part in full[current.Length..].Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            var directory = new DirectoryInfo(Path.Combine(current, part));
            current = directory.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? directory.FullName;
        }
        return Path.TrimEndingDirectorySeparator(current);
    }

    private JsonObject SuspendOutside(JsonObject input)
    {
        // No authority file or source event is created for an unrelated prompt/tool call.
        if (File.Exists(FilePath))
        {
            using var gate = DurableJson.Lease(FilePath + ".lock");
            var state = DurableJson.Read(FilePath);
            var session = input["session_id"]?.ToString();
            var id = session == null ? null : state["sessions"]?[session]?.ToString();
            if (id != null && state["tasks"]?[id] is JsonObject task && task["workspaceRoot"] != null)
            {
                Suspend(state, session!, task);
                DurableJson.Write(FilePath, state);
            }
        }
        return Outside("Outside the configured Hybrid workspace; no request was captured or tool permit issued.");
    }

    private static JsonObject Outside(string reason) => new() {
        ["captured"] = false, ["allowed"] = false, ["inScope"] = false, ["reason"] = reason };

    private static void Suspend(JsonObject state, string session, JsonObject task)
    {
        if (task["workspaceRoot"] != null) task["workspaceActive"] = false;
        RevokePermits(state, session);
    }

    private static void RevokePermits(JsonObject state, string session)
    {
        if (state["permitSessions"] is not JsonObject owners) return;
        foreach (var key in owners.Where(p => p.Value?.ToString() == session).Select(p => p.Key).ToArray())
        {
            state["permits"]?.AsObject().Remove(key); owners.Remove(key);
        }
    }

    private JsonObject Update(Func<JsonObject, JsonObject> change)
    {
        Directory.CreateDirectory(directory);
        using var gate = DurableJson.Lease(FilePath + ".lock");
        var state = File.Exists(FilePath) ? DurableJson.Read(FilePath) : new JsonObject { ["sessions"] = new JsonObject(), ["tasks"] = new JsonObject() };
        var result = change(state); DurableJson.Write(FilePath, state); return result;
    }
    private static JsonObject Task(JsonObject state, string id) => state["tasks"]?[id]?.AsObject() ?? throw new InvalidOperationException("Unknown host-captured app task");
    private static string Need(JsonObject input, string key) => input[key]?.GetValue<string>() is { Length: > 0 } value ? value : throw new ArgumentException("Missing " + key);
    public static string Fingerprint(JsonNode node) => DurableJson.Hash(Canonical(node).ToJsonString());
    private static JsonNode Canonical(JsonNode node) => node switch {
        JsonObject obj => new JsonObject(obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, p.Value == null ? null : Canonical(p.Value)))),
        JsonArray array => new JsonArray(array.Select(n => n == null ? null : Canonical(n)).ToArray()), _ => node.DeepClone() };
    private static JsonObject Content(JsonObject contract) => new(contract.Where(p => p.Key is "data" or "logic" or "roles" or "exceptions" or "uiSource" or "csharpSource")
        .Select(p => KeyValuePair.Create(p.Key, p.Value?.DeepClone())));

    private static void ValidateProposal(JsonObject proposal)
    {
        var unknown = proposal.Select(p => p.Key).Except(new[] { "module", "lane", "environment", "data", "logic", "roles", "exceptions", "uiSource", "csharpSource", "expectedMessages" }).ToArray();
        if (unknown.Length > 0) throw new ArgumentException("Unknown proposal fields: " + string.Join(", ", unknown));
        var module = Need(proposal, "module");
        if (!System.Text.RegularExpressions.Regex.IsMatch(module, "^[A-Za-z][A-Za-z0-9_]*$")) throw new ArgumentException("Invalid module name");
        if (Need(proposal, "lane") is not ("ss4" or "ss5")) throw new ArgumentException("Choose SS4 or SS5");
        _ = Need(proposal, "environment");
        ModuleSpecification.Validate(Content(proposal));
        MessageExpectations.Read(proposal, "accepted module contract");
    }
}
