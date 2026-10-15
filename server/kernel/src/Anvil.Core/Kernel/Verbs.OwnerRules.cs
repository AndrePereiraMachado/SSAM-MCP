using System.Text;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;

namespace Anvil.Core;

/// <summary>
/// The owner's rules on what an op other than the text form writes new in an action: decision 6 (new JavaScript only in an
/// isolated, named client action) and T1/T2 (a new For Each that only filters, copies or maps into a list, refused always,
/// decision 5). The text form judges them itself (FlowDiff); the other forms are judged here, after the ops, on the candidate
/// model, by the same rules (FlowDiff.NewElementRules), as QUERY_IN_LOOP is (QueryInLoopRule.cs): one more failure of the one
/// refusal, with the pointer of the op (and of the action and its step for the JSON form) and the fix in words; the List
/// action's lines of the text form go with a T1/T2 problem when they are certain (text).
///
/// What is judged, and how it is found (the reviews of rounds 1 and 2, and the re-check of the 24.1 fixes):
///  * the JSON form of the logic op ({"op":"logic","data":{"actions":[...]}}): the JavaScript and For Each nodes it wrote, kept
///    as model objects when the op ends, never by the declared name (a rename, a move or a delete of a later op of the job is
///    followed: the node is judged where it is at the end, a node a later op deleted is gone);
///  * a raw create, duplicate or move of the job (decision 6 and T1/T2 were not judged there): the JavaScript and For Each nodes
///    it created, copied or moved into another action;
///  * a logic op the kernel planned (a module specification: a contract, the C# delivery; or a logic op another op of the job
///    ran: html components, a prototype, rest-expose, an agent): an owner decision keeps it, so its problems are listed in
///    highWarnings (FLOW_OWNER_RULE_PLANNED), never refused and never silent.
/// What the action had before a JSON replace is its own (preserved): a JavaScript with the same name and code, a For Each over
/// the same list with the same label, each node of the read for at most one node of the candidate (the same body first; two
/// candidates and no same body: both are judged, two readings are never chosen between); a loop of the read the replace
/// rewrote into T1/T2 is kept as the text form keeps an edited loop, and listed (FLOW_FOREACH_EDITED_KEPT). A node this job
/// wrote is never the action's own. An action with such nodes that cannot be read is a problem (FLOW_OWNER_RULES_UNREAD).
/// </summary>
/// <summary>
/// The escape of T1/T2 on the forms judged here (the JSON form of the logic op, a raw create, duplicate or move):
/// `"allowForEach": {"why": "&lt;at least 15 characters&gt;"}` on the op keeps a For Each that only filters, copies or maps into a
/// list, and the receipt lists it in highWarnings (FLOW_FOREACH_LIST_ACTION_ALLOWED, with the why): never silent. These forms
/// have it because a List action cannot always express the loop (for example a loop with start or max); record mappings
/// are supported in both text and JSON, including O11's native conversions,
/// and the proof jobs written before this rule keep what they prove with it. The text form has no escape (its refusal
/// carries the List action as the patch); a new JavaScript has none in any form (decision 6).
/// </summary>
public static class ForEachEscape
{
    public const string AllowKey = "allowForEach";
    public const string AllowedCode = "FLOW_FOREACH_LIST_ACTION_ALLOWED";

    /// <summary>The ops that take the escape (VerbSurface accepts the key on them).</summary>
    public static bool Takes(string kind) => kind is "logic" or "create" or "duplicate" or "move";

    /// <summary>The why of a valid escape on the op, or null (absent, or too short: then invalid says why).</summary>
    public static string? Allowed(JsonObject? op, out string? invalid)
    {
        invalid = null;
        if (op?[AllowKey] is not { } flag) return null;
        var why = flag is JsonObject o && o["why"] is JsonValue w && w.TryGetValue<string>(out var text) ? text.Trim() : null;
        if (why != null && why.Length >= QueryInLoopRule.MinimumWhy) return why;
        invalid = $"{AllowKey} needs {{\"why\": \"<at least {QueryInLoopRule.MinimumWhy} characters>\"}}";
        return null;
    }
}

public sealed partial class ModelSession
{
    /// <summary>A problem of the owner's rules on a logic op the kernel planned: listed (highWarnings), never refused.</summary>
    public const string OwnerRulePlannedCode = "FLOW_OWNER_RULE_PLANNED";
    /// <summary>A loop of the read a JSON replace rewrote into T1/T2: kept as the action's own (as the text form keeps an edited
    /// loop of the read), listed.</summary>
    public const string ForEachEditedKeptCode = "FLOW_FOREACH_EDITED_KEPT";
    /// <summary>An action with JavaScript or For Each nodes an op wrote that cannot be read after the ops: never skipped.</summary>
    public const string OwnerRulesUnreadCode = "FLOW_OWNER_RULES_UNREAD";

    // What one op of the job wrote new, for the review at the end of the Apply. Nodes: the JavaScript and For Each nodes it wrote
    // (the model objects as written: a later rename keeps them, a later move gives them a replacement that Current follows).
    // Edited: the loops of the read a JSON replace rewrote (the node, as written). Unread: why the action could not be read when
    // the op ended, with the nodes it had.
    private sealed class OwnerClaim
    {
        public required int Op { get; init; }
        public required string Form { get; init; }      // "logic" (the JSON form), "create", "duplicate", "move"
        public int? Index { get; init; }                 // the declared action in the op as written (the JSON form)
        public JsonObject? Declaration { get; init; }
        public string? ListedBy { get; init; }           // not null: a logic op the kernel planned (listed, never refused)
        public string Action { get; init; } = "";
        public List<object> Nodes { get; } = [];
        public List<object> Edited { get; } = [];
        public string? Unread { get; set; }
    }
    private readonly List<OwnerClaim> _ownerClaims = [];
    // The keys of the JavaScript and For Each nodes this job wrote, by any op (nested ones too): never the action's own in a
    // replace of a later op (the job cannot make its own new JavaScript "existing" by writing the action twice).
    private readonly HashSet<string> _jobWrittenNodes = new(StringComparer.Ordinal);
    // The object the running create or duplicate wrote (set by the verb, read by ApplyOne right after it).
    private IObjectSignature? _lastWritten;

    // The logic ops the kernel planned from a module specification in this process (a contract, the C# delivery, the html
    // components: PlanModuleSpecification), by the sha256 of their JSON: the compilation of a contract, not the JSON form a model
    // writes, so the review lists what they write and never refuses it (an owner decision listed in docs/TEXTO-SSAM.md, section
    // 15). A job that only copies such ops, run in another process, is judged as any JSON form.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> PlannedLogic = new(StringComparer.Ordinal);
    private HashSet<int> _plannedOps = [];

    private static string PlannedSha(JsonObject op) =>
        System.Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(op.ToJsonString())));

    internal static JsonArray RememberPlanned(JsonArray ops)
    {
        foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "logic")) {
            if (PlannedLogic.Count > 4096) PlannedLogic.Clear();
            PlannedLogic.TryAdd(PlannedSha(op), 0);
        }
        return ops;
    }

    private static HashSet<int> PlannedOps(JsonArray ops)
    {
        var planned = new HashSet<int>();
        if (PlannedLogic.IsEmpty) return planned;
        for (var i = 0; i < ops.Count; i++)
            if (ops[i] is JsonObject op && op["op"]?.ToString() == "logic" && PlannedLogic.ContainsKey(PlannedSha(op))) planned.Add(i);
        return planned;
    }

    /// <summary>Starts the review of one Apply.</summary>
    private void BeginOwnerRules(JsonArray ops)
    {
        _ownerClaims.Clear();
        _jobWrittenNodes.Clear();
        _plannedOps = PlannedOps(ops);
    }

    /// <summary>The action as the flow reader reads it (model keys), or null when it cannot be read.</summary>
    private FlowItem? FlowItemOf(IObjectSignature action) => FlowItemOf(action, out _);

    private FlowItem? FlowItemOf(IObjectSignature action, out string? why)
    {
        why = null;
        try { return new FlowExtractor<IObjectSignature>(new KernelModelReader(), (IObjectSignature)_es).Action(action, out _); }
        catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or NotSupportedException or ArgumentException or NullReferenceException)
        { why = error.GetType().Name + ": " + error.Message; return null; }
    }

    private static bool JavaScriptOrLoop(object? o) => o is IJavaScriptNode or IForEachNode;

    /// <summary>The object now: itself while it lives; the platform's replacement when a move recreated it; null when it is gone.</summary>
    private static IObjectSignature? Current(object? node)
    {
        var o = node;
        for (var hops = 0; hops < 32 && o is IObjectSignature { WasDeleted: true } dead; hops++)
            o = (dead as ServiceStudio.Model.AbstractObject)?.TryGetReplacement();
        return o is IObjectSignature { WasDeleted: false } live ? live : null;
    }

    /// <summary>Called by ApplyOne after each write op of an Apply: the JavaScript and For Each nodes it wrote join the job's
    /// (never the action's own), and a raw create, duplicate or move of the job itself becomes a claim of the review.</summary>
    private void RememberWrittenNodes(string kind, JsonObject op, IObjectSignature? created, IObjectSignature? moved, IObjectSignature? movedFrom, List<IObjectSignature>? movedOwn)
    {
        if (_applyOps == null || kind is not ("create" or "duplicate" or "move")) return;
        var written = new List<IObjectSignature>();
        if (kind == "move") {
            // A move into another parent recreates the object (Reparent): what this job wrote stays the job's under its new key;
            // a JavaScript or For Each moved into another action is written there.
            if (moved == null) return;
            foreach (var original in movedOwn ?? []) if (Current(original) is { } now && now.ObjectKey?.ToString() is { } key) _jobWrittenNodes.Add(key);
            if (Current(moved) is { } landed && JavaScriptOrLoop(landed) && landed.Parent is IObjectSignature into && !ReferenceEquals(into, movedFrom)) written.Add(landed);
        } else {
            // The object the verb created or pasted (Create, Duplicate: _lastWritten).
            if (created == null || created.WasDeleted) return;
            if (JavaScriptOrLoop(created)) written.Add(created);
            // A copy brings every node of what it copies (an action, a container of nodes).
            if (kind == "duplicate") written.AddRange(created.GetAllDescendantsOfType<IObjectSignature>().Where(JavaScriptOrLoop));
        }
        foreach (var node in written) if (node.ObjectKey?.ToString() is { } key) _jobWrittenNodes.Add(key);
        if (written.Count == 0 || _applyIndex >= _applyOps.Count || !ReferenceEquals(_applyOps[_applyIndex], op)) return;
        var claim = new OwnerClaim { Op = _applyIndex, Form = kind, Action = TypeResolver.Name(written[0].Parent) ?? "" };
        claim.Nodes.AddRange(written);
        _ownerClaims.Add(claim);
    }

    /// <summary>Called by LogicCore after a JSON logic op applied: each action it declared becomes a claim, with the JavaScript
    /// and For Each nodes it wrote as model objects (resolved now, while the declared name is the action's). The op of the job
    /// itself (or its re-run without a failed action) is judged; a logic op the planner wrote, or one another op of the job ran,
    /// is listed.</summary>
    private void RememberJsonLogic(JsonObject data, IReadOnlyDictionary<string, FlowItem> before)
    {
        if (_applyOps == null || _applyIndex >= _applyOps.Count || _applyOps[_applyIndex] is not JsonObject top) return;
        var topKind = top["op"]?.ToString() ?? "";
        var written = topKind == "logic" ? top["data"]?["actions"] as JsonArray : null;
        string? listedBy = written != null && !_plannedOps.Contains(_applyIndex) ? null
            : topKind == "logic" ? "the module-specification planner (a contract, the C# delivery, html components) in op #" + _applyIndex
            : "the " + topKind + " op #" + _applyIndex + " (a logic op the kernel planned from it)";
        foreach (var declaration in (data["actions"] as JsonArray ?? []).OfType<JsonObject>()) {
            var name = declaration["name"]?.ToString() ?? "";
            var owner = LogicOrder.Owner(declaration);
            int? index = null;
            for (var a = 0; a < (written?.Count ?? 0) && index == null; a++)
                if (written![a] is JsonObject w && string.Equals(w["name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(LogicOrder.Owner(w), owner, StringComparison.OrdinalIgnoreCase)) index = a;
            if (listedBy == null && index != null) _ownerClaims.RemoveAll(c => c.Form == "logic" && c.Op == _applyIndex && c.Index == index && c.ListedBy == null);
            var claim = new OwnerClaim { Op = _applyIndex, Form = "logic", Index = listedBy == null ? index : null, Declaration = declaration, ListedBy = listedBy, Action = name };
            _ownerClaims.Add(claim);
            IObjectSignature? action;
            string? missing = null;
            try { action = OwnedAction(name, declaration); } catch (ArgumentException error) { action = null; missing = error.Message; }
            // An action the op declared and the module does not give back, when its steps write JavaScript or a loop: never
            // skipped (the review would not see what it wrote).
            if (action == null) {
                if (WritesJavaScriptOrLoop(declaration)) claim.Unread = missing ?? "the action " + owner + "/" + name + " the op declared is not found in the module after it";
                continue;
            }
            var nodes = FlowNodes(action).OfType<IObjectSignature>().Where(JavaScriptOrLoop).ToList();
            foreach (var node in nodes) if (node.ObjectKey?.ToString() is { } key) _jobWrittenNodes.Add(key);
            if (nodes.Count == 0) continue;
            // Unread now: every node is the op's (none can be matched to the read); the review reads the action at the end.
            if (FlowItemOf(action) is not { } after) { claim.Nodes.AddRange(nodes); continue; }
            var (own, edited) = OwnNodes(after, before.GetValueOrDefault(ReplacementKey(owner, name)));
            foreach (var node in nodes) {
                var key = node.ObjectKey?.ToString() ?? "";
                if (!own.Contains(key)) claim.Nodes.Add(node);
                else if (edited.Contains(key)) claim.Edited.Add(node);
            }
        }
    }

    /// <summary>Whether the steps of a declared action write a JavaScript node or a For Each (at any depth).</summary>
    private static bool WritesJavaScriptOrLoop(JsonNode? node) => node switch
    {
        JsonObject o => o.ContainsKey("foreach") || o["node"]?.ToString() is "IJavaScriptNode" or "IForEachNode" || o.Any(p => WritesJavaScriptOrLoop(p.Value)),
        JsonArray a => a.Any(WritesJavaScriptOrLoop),
        _ => false,
    };

    /// <summary>The nodes of a replaced action that continue a node of its read (the action's own: preserved), one to one, and
    /// those of them whose loop the replace rewrote (edited). A JavaScript: the same name and code. A For Each: the same list and
    /// label, the same body first; else the only candidate (edited); two candidates and no same body: none (both judged). A node
    /// this job wrote is never the action's own.</summary>
    private (HashSet<string> Own, HashSet<string> Edited) OwnNodes(FlowItem after, FlowItem? before)
    {
        var own = new HashSet<string>(StringComparer.Ordinal);
        var edited = new HashSet<string>(StringComparer.Ordinal);
        if (before == null) return (own, edited);
        var candidates = after.Items.Where(i => i.Role == "node" && i.Kind is "JavaScriptNode" or "ForEachNode").ToList();
        var read = before.Items.Where(i => i.Role == "node" && i.Kind is "JavaScriptNode" or "ForEachNode" && !_jobWrittenNodes.Contains(i.Key)).ToList();
        foreach (var b in read.Where(b => b.Kind == "JavaScriptNode"))
            if (candidates.FirstOrDefault(c => c.Kind == "JavaScriptNode" && !own.Contains(c.Key) && c.Name == b.Name && c.Prop("JavaScript") == b.Prop("JavaScript")) is { } same)
                own.Add(same.Key);
        static bool Over(FlowItem b, FlowItem c) => c.Kind == "ForEachNode" && b.Prop("RecordList") == c.Prop("RecordList") && b.Prop("Label") == c.Prop("Label");
        var pending = new List<FlowItem>();
        foreach (var b in read.Where(b => b.Kind == "ForEachNode")) {
            var body = LoopBody(before, b);
            if (candidates.FirstOrDefault(c => !own.Contains(c.Key) && Over(b, c) && LoopBody(after, c) == body) is { } same) own.Add(same.Key);
            else pending.Add(b);
        }
        foreach (var b in pending)
            if (candidates.Where(c => !own.Contains(c.Key) && Over(b, c)).ToList() is [var only]) { own.Add(only.Key); edited.Add(only.Key); }
        return (own, edited);
    }

    /// <summary>The body of a loop without keys: its nodes from CycleTarget in the order of their connectors, each with its
    /// properties and parts, a connector to the loop, to another node of the body (by position) or out.</summary>
    internal static string LoopBody(FlowItem action, FlowItem loop)
    {
        var nodes = action.Items.Where(i => i.Role == "node").GroupBy(i => i.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var order = new Dictionary<string, int>(StringComparer.Ordinal);
        var body = new List<FlowItem>();
        var pending = new Stack<string>();
        if (loop.Edges.GetValueOrDefault("CycleTarget") is { Length: > 0 } first) pending.Push(first);
        while (pending.TryPop(out var key)) {
            if (key == loop.Key || order.ContainsKey(key) || !nodes.TryGetValue(key, out var node)) continue;
            order[key] = body.Count; body.Add(node);
            foreach (var target in node.Edges.Values.Reverse()) if (target.Length > 0) pending.Push(target);
        }
        var text = new StringBuilder();
        foreach (var node in body) {
            var copy = node.Clone();
            Strip(copy);
            text.Append(copy.Canon());
        }
        return text.ToString();
        void Strip(FlowItem item)
        {
            item.Key = "";
            foreach (var edge in item.Edges.Keys.ToList()) {
                var target = item.Edges[edge];
                item.Edges[edge] = target.Length == 0 ? "" : target == loop.Key ? "loop" : order.TryGetValue(target, out var at) ? "#" + at : "out";
            }
            foreach (var part in item.Items) Strip(part);
        }
    }

    /// <summary>The rules of new elements over what the claims wrote: each problem one failure of the refusal (or a listed
    /// warning for what the kernel planned, or the escape). Never throws.</summary>
    private void OwnerRulesReview(JsonArray ops, List<ApplyFailure> failures, string? opsPointer)
    {
        if (_ownerClaims.Count == 0) return;
        var reader = new KernelModelReader();
        HashSet<string>? scope = null;
        bool Taken(string name) => (scope ??= ScopeNames()).Contains(name);
        var refused = new SortedDictionary<int, List<JsonObject>>();
        // Each node is judged once, by the last op that wrote it, where it is now (a later rename keeps it, a later move is
        // followed, a later delete leaves nothing to judge).
        var latest = new Dictionary<IObjectSignature, OwnerClaim>(ReferenceEqualityComparer.Instance);
        foreach (var claim in _ownerClaims)
            foreach (var node in claim.Nodes)
                if (Current(node) is { } now) latest[now] = claim;
        foreach (var claim in _ownerClaims) {
            if (claim.Unread == null) continue;
            // Gone with the nodes (a later op deleted the action and what it wrote): nothing new is left.
            if (claim.Nodes.Count > 0 && claim.Nodes.All(n => Current(n) == null)) continue;
            Emit(claim, null, claim.Action, new FlowProblem(OwnerRulesUnreadCode, "the action " + claim.Action + " cannot be read after the ops (" + claim.Unread
                + "), so the JavaScript and For Each nodes the op wrote are not judged by the owner's rules", null,
                "write the action so that it reads (ssam_map view flow), or in the text form (ssam-flow/1)", null));
        }
        foreach (var byClaim in latest.GroupBy(p => p.Value, p => p.Key)) {
            var claim = byClaim.Key;
            foreach (var byOwner in byClaim.GroupBy(n => n.Parent as IObjectSignature)) {
                var owner = byOwner.Key;
                var name = owner != null ? reader.NameOf(owner) : claim.Action;
                string? why = null;
                if (owner == null || FlowItemOf(owner, out why) is not { } item) {
                    Emit(claim, owner, name, new FlowProblem(OwnerRulesUnreadCode, "the action " + name + " cannot be read after the ops (" + (why ?? "no flow owner")
                        + "), so the JavaScript and For Each nodes the op wrote in it are not judged by the owner's rules", null,
                        "write the action so that it reads (ssam_map view flow), or in the text form (ssam-flow/1)", null));
                    continue;
                }
                var keys = byOwner.Select(n => n.ObjectKey?.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
                List<FlowProblem> found;
                try { found = FlowDiff.NewElementRules(item, node => keys.Contains(node.Key), new ModelFlowTypes(this, owner), Taken); }
                catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException)
                {
                    found = [new FlowProblem(OwnerRulesUnreadCode, "the owner's rules could not judge the action " + name + " (" + error.Message + ")", null,
                        "write the action in the text form (ssam-flow/1)", null)];
                }
                foreach (var problem in found) Emit(claim, owner, name, problem);
            }
        }
        // The loops of the read a JSON replace rewrote into T1/T2: kept as the action's own, listed.
        foreach (var claim in _ownerClaims)
            foreach (var node in claim.Edited) {
                if (Current(node) is not { Parent: IObjectSignature owner } now || FlowItemOf(owner) is not { } item || now.ObjectKey?.ToString() is not { } key) continue;
                List<FlowProblem> found;
                try { found = FlowDiff.NewElementRules(item, n => n.Key == key, new ModelFlowTypes(this, owner), Taken); }
                catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or ArgumentException) { continue; }
                foreach (var problem in found.Where(p => p.Code == "FLOW_FOREACH_LIST_ACTION"))
                    Report("highWarnings", new JsonObject { ["code"] = ForEachEditedKeptCode, ["severity"] = "high", ["op"] = claim.Op, ["pointer"] = PointerOf(claim, problem, opsPointer),
                        ["message"] = "action " + reader.NameOf(owner) + ": the For Each the action had, rewritten by the replace of op #" + claim.Op + ", " + problem.Message[(problem.Message.IndexOf(" only ", StringComparison.Ordinal) is var at && at >= 0 ? at + 1 : 0)..]
                            + "; kept as the action's own (as the text form keeps an edited loop of the read), listed", ["fix"] = problem.Fix, ["flow"] = reader.NameOf(owner), ["text"] = problem.Patch });
            }
        foreach (var (op, problems) in refused) {
            // Each problem has its own patch. Later indices must be replaced first: inserting a filter before a loop
            // would otherwise shift a subsequent loop's JSON pointer. The refusal preserves this safe application order.
            problems.Sort((a, b) => ReversePointer(a["pointer"]?.ToString(), b["pointer"]?.ToString()));
            var source = op < ops.Count && ops[op] is JsonObject o ? o : new JsonObject();
            var kind = source["op"]?.ToString() ?? "op";
            var text = string.Join(" | ", problems.Select(p => p["message"]?.ToString()));
            failures.Add(new ApplyFailure(op, kind, source,
                new KernelRefusalException(problems[0]["code"]!.ToString(), $"op #{op} ({kind}): [{problems[0]["code"]}] {text}",
                    new JsonArray(problems.Select(p => (JsonNode)p.DeepClone()).ToArray())), problems));
        }

        void Emit(OwnerClaim claim, IObjectSignature? owner, string name, FlowProblem problem)
        {
            var at = PointerOf(claim, problem, opsPointer);
            var form = claim.ListedBy != null ? "a logic op the kernel planned" : claim.Form == "logic" ? "JSON form of the logic op" : claim.Form + " op #" + claim.Op;
            var message = "action " + name + " (" + form + "): " + problem.Message;
            var loop = problem.Code == "FLOW_FOREACH_LIST_ACTION";
            var patch = loop && claim.Form == "logic" ? ListActionPatch(claim, problem, at) : null;
            var fix = problem.Fix + (claim.Form == "logic"
                ? "; the JSON form is judged by the same rules as the text form" + (loop ? patch != null
                    ? "; apply the RFC 6902 patch to replace this foreach with its List action calls (apply problems in the order returned)"
                    : " (as steps: the calls of the List action in place of the foreach; or write the action in the text form, ssam-flow/1, whose refusal carries the List action as a verified patch)" : "")
                : "; a raw " + claim.Form + " is judged by the same rules as the text form" + (loop
                    ? " (as raw ops: the List action's calls in place of the For Each; or write the action in the text form, ssam-flow/1, whose refusal carries the List action as a verified patch)"
                    : problem.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED" ? " (as raw ops: a client action of its own with only the script, its inputs and outputs, called where the node is; or the text form, whose refusal carries both as a verified patch)" : ""));
            // What the kernel planned: listed (high), never refused and never silent (an owner decision).
            if (claim.ListedBy != null) {
                Report("highWarnings", new JsonObject { ["code"] = OwnerRulePlannedCode, ["severity"] = "high", ["op"] = claim.Op, ["pointer"] = at, ["rule"] = problem.Code,
                    ["message"] = message + "; written by " + claim.ListedBy + ": kept by the owner's decision on the kernel's planners, listed", ["fix"] = fix, ["flow"] = name, ["text"] = problem.Patch });
                return;
            }
            var why = ForEachEscape.Allowed(claim.Op < ops.Count ? ops[claim.Op] as JsonObject : null, out var invalid);
            // A loop the op keeps with allowForEach: listed (high), never refused and never silent.
            if (why != null && loop) {
                Report("highWarnings", new JsonObject { ["code"] = ForEachEscape.AllowedCode, ["severity"] = "high", ["op"] = claim.Op, ["pointer"] = at,
                    ["message"] = message + $"; kept by {ForEachEscape.AllowKey} on op #{claim.Op}: {why}", ["fix"] = problem.Fix, ["flow"] = name, ["why"] = why });
                return;
            }
            var json = JobPreflight.Problem(claim.Op, at, problem.Code, "error", message + (invalid != null && loop ? "; " + invalid : ""), fix, patch, claim.Form);
            json["phase"] = "apply";
            json["action"] = name;
            if (problem.Patch != null) json["text"] = problem.Patch;
            if (!refused.TryGetValue(claim.Op, out var list)) refused[claim.Op] = list = [];
            list.Add(json);
        }
    }

    // A certain text patch consists only of List calls. Read it with the same parser as the text form, retaining literal
    // argument values, then replace the declared foreach and insert any preceding filter at that same array index.
    private static JsonArray? ListActionPatch(OwnerClaim claim, FlowProblem problem, string? pointer)
    {
        if (problem.Patch == null || pointer == null || claim.Declaration == null || problem.Id == null
            || !Preflight.LogicScan.Of(claim.Declaration).Nodes.TryGetValue(problem.Id, out var fact)
            || !fact.Step.ContainsKey("foreach") || !pointer.EndsWith(fact.Pointer, StringComparison.Ordinal)) return null;
        FlowItem parsed;
        try { parsed = FlowParser.Parse("server action Patch\n" + string.Concat(problem.Patch.Split('\n').Select(line => "  " + line + "\n")) + "  end\n"); }
        catch (FormatException) { return null; }
        var calls = new List<JsonObject>();
        foreach (var node in parsed.Items.Where(n => n.Role == "node" && n.Kind is not ("StartNode" or "EndNode"))) {
            var target = node.Prop("Action")?.Replace("(System).", "", StringComparison.Ordinal);
            if (node.Kind != "Execute" || target is not ("ListFilter" or "ListAppendAll")) return null;
            var arguments = new JsonObject();
            foreach (var arg in node.Items.Where(p => p.Role == "argument")) arguments[arg.Name] = arg.Prop("Value") ?? "";
            calls.Add(new JsonObject { ["call"] = target, ["as"] = node.Name, ["args"] = arguments });
        }
        if (calls.Count == 0 || calls[^1]["call"]?.ToString() != "ListAppendAll") return null;
        // Do not offer a merely parseable patch: replay it over a detached declaration and run the public preflight.
        // This catches duplicate aliases, invalid argument shapes and expression syntax before the caller receives it.
        var corrected = (JsonObject)claim.Declaration.DeepClone();
        var tokens = fact.Pointer.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(t => t.Replace("~1", "/").Replace("~0", "~")).ToArray();
        JsonNode? parent = corrected;
        foreach (var token in tokens.SkipLast(1))
            parent = parent is JsonArray array && int.TryParse(token, out var at) && at < array.Count ? array[at] : parent is JsonObject obj ? obj[token] : null;
        if (parent is not JsonArray steps || !int.TryParse(tokens[^1], out var index) || index >= steps.Count) return null;
        steps[index] = calls[^1].DeepClone();
        for (var i = calls.Count - 2; i >= 0; i--) steps.Insert(index, calls[i].DeepClone());
        var checkedOp = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(corrected) } });
        if (JobPreflight.Analyze(checkedOp)["valid"]?.GetValue<bool>() != true) return null;
        var patch = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = calls[^1] });
        for (var i = calls.Count - 2; i >= 0; i--)
            patch.Add(new JsonObject { ["op"] = "add", ["path"] = pointer, ["value"] = calls[i] });
        return patch;
    }

    private static int ReversePointer(string? a, string? b)
    {
        var left = (a ?? "").Split('/'); var right = (b ?? "").Split('/');
        for (var i = 0; i < Math.Min(left.Length, right.Length); i++) {
            var compared = int.TryParse(left[i], out var x) && int.TryParse(right[i], out var y)
                ? y.CompareTo(x) : string.Compare(right[i], left[i], StringComparison.Ordinal);
            if (compared != 0) return compared;
        }
        return right.Length.CompareTo(left.Length);
    }

    /// <summary>The pointer of a problem: the declared action of the JSON form (and its step, when the declaration gives the
    /// node that name: LogicScan's pointer), else the op.</summary>
    private static string? PointerOf(OwnerClaim claim, FlowProblem problem, string? opsPointer)
    {
        if (opsPointer == null) return null;
        if (claim.Form != "logic" || claim.Index is not { } index || claim.Declaration == null) return $"{opsPointer}/{claim.Op}";
        var at = $"{opsPointer}/{claim.Op}/data/actions/{index}";
        // A name two steps give (one's alias, another's label) points at no step: the action only.
        if (problem.Id is { Length: > 0 } step && Named(claim.Declaration["steps"], step) == 1
            && Preflight.LogicScan.Of(claim.Declaration).Nodes.TryGetValue(step, out var fact)) at += fact.Pointer;
        return at;
        static int Named(JsonNode? node, string name) => node switch
        {
            JsonObject o => (o["as"]?.ToString() == name || o["label"]?.ToString() == name ? 1 : 0) + o.Sum(p => Named(p.Value, name)),
            JsonArray a => a.Sum(n => Named(n, name)),
            _ => 0,
        };
    }
}
