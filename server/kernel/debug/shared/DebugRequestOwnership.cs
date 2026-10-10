using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

// A request is trusted only after a breakpoint dominated by its private header nonce.
// Native graph extraction/qualification belongs to the controller: this class checks its
// pinned artifact and graph, not an arbitrary assertion that a snapshot was verified.
// The nonce is a credential, not a server-side single-use token. A privileged reader of
// the published model can replay it; competing anchors fault the operation rather than
// claiming isolation against that reader. The ordinary client ccid is never an input.
internal sealed class DebugRequestOwnership : IDisposable {
    internal const string ProofSchema = "ssam-debug-request-anchor-native-proof/1";
    static readonly Regex Key = new("^[A-Za-z0-9_+]{22}$");
    static readonly Regex Hash = new("^[a-f0-9]{64}$");
    static readonly Regex Nonce = new("^[a-f0-9]{48}$");
    static readonly JsonSerializerOptions Json = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 12
    };

    internal enum Phase { AwaitAnchor, OwnedThread, Completed, Faulted }
    internal enum Decision { RejectForeign, RejectInvalid, RejectReplay, RejectExpired, RejectAmbiguous, AdoptOwnedThread, AcceptOwnedThread, CompleteOwnedThread }
    internal sealed record Binding(
        string OperationId, string SessionId, string RuntimeOrigin, string ModuleKey,
        long PublishedVersionId, string SourceSha256, string ProofSha256, DateTimeOffset ExpiresAt);
    // These are native event values, obtained before Evaluate. RawRequestIdPresent must
    // describe the original payload, not ServerThreadData's ThreadId fallback.
    internal sealed record Metadata(
        string SessionId, string ModuleKey, string? FunctionModuleKey, string? FunctionKey,
        string? NodeModuleKey, string? NodeKey, [property: JsonIgnore] string? ThreadId, [property: JsonIgnore] string? RawRequestId,
        bool RawRequestIdPresent, bool RequestIdIsFallback, long EventId,
        bool IsServerBreakpoint, bool IsThreadEnd = false) {
        public override string ToString() => "DebugRequestOwnership.Metadata";
    }

    internal sealed class NativeProof {
        public string Schema { get; set; } = "";
        public string OperationId { get; set; } = "";
        public string RuntimeOrigin { get; set; } = "";
        public string ModuleKey { get; set; } = "";
        public long PublishedVersionId { get; set; }
        public string SourceSha256 { get; set; } = "";
        public string FunctionKey { get; set; } = "";
        public string EntryNodeKey { get; set; } = "";
        public string AnchorNodeKey { get; set; } = "";
        public NativeHeader Header { get; set; } = new();
        public NativeGuard Guard { get; set; } = new();
        // The qualified extractor must include every native node/connector in the function.
        // This minimal contract rejects cuts, property errors and exception handlers.
        public string[] CutNodeKeys { get; set; } = [];
        public string[] PropertyErrors { get; set; } = [];
        public NativeNode[] Nodes { get; set; } = [];
        public NativeEdge[] Edges { get; set; } = [];
    }
    internal sealed class NativeHeader {
        public string InputKey { get; set; } = "";
        public string ReceiveIn { get; set; } = "";
        public string ReceiveAs { get; set; } = "";
        public string DataType { get; set; } = "";
    }
    internal sealed class NativeGuard {
        public string NodeKey { get; set; } = "";
        public string HeaderInputKey { get; set; } = "";
        public string Operator { get; set; } = "";
        public string LiteralSha256 { get; set; } = "";
    }
    internal sealed record NativeNode(string Key, string Kind);
    internal sealed record NativeEdge(string From, string Connector, string To);

    readonly Binding binding;
    readonly string functionKey, anchorKey;
    readonly TimeProvider clock;
    Phase phase = Phase.AwaitAnchor;
    string? ownedThread, ownedRequest;
    long lastEventId = -1;
    int rejected;
    internal Phase State => phase;
    internal object SafeStatus() => new { state = phase.ToString(), ownedThreadCaptured = ownedThread != null, rejectedEvents = rejected };
    internal bool ExpireIfNeeded() {
        if (phase is Phase.Completed or Phase.Faulted || binding.ExpiresAt > clock.GetUtcNow()) return false;
        Fault(); return true;
    }
    internal void RequireCurrentOwnedThread() {
        if (ExpireIfNeeded()) throw new DebugFailure("debug_request_ownership_pause_expired");
        if (phase != Phase.OwnedThread) throw new DebugFailure("debug_request_ownership_pause_not_owned");
    }
    internal void RequireForeignThreadRelease(string threadId) {
        if (ExpireIfNeeded()) throw new DebugFailure("debug_request_ownership_pause_expired");
        if (phase == Phase.OwnedThread && threadId == ownedThread) {
            Fault(); throw new DebugFailure("debug_request_ownership_thread_conflict");
        }
    }

    internal DebugRequestOwnership(ReadOnlySpan<byte> proofBytes, Binding binding, string privateNonce, TimeProvider? clock = null) {
        this.clock = clock ?? TimeProvider.System;
        this.binding = binding;
        if (binding == null || !Guid.TryParseExact(binding.OperationId, "N", out _) || !Guid.TryParseExact(binding.SessionId, "N", out _)
            || !Key.IsMatch(binding.ModuleKey ?? "") || binding.PublishedVersionId < 1 || !Hash.IsMatch(binding.SourceSha256 ?? "")
            || !Hash.IsMatch(binding.ProofSha256 ?? "") || !ValidOrigin(binding.RuntimeOrigin)
            || binding.ExpiresAt <= this.clock.GetUtcNow()) throw Failure("binding");
        if (proofBytes.Length is < 1 or > 1048576 || Digest(proofBytes) != binding.ProofSha256) throw Failure("proof");
        NativeProof proof;
        try { proof = JsonSerializer.Deserialize<NativeProof>(proofBytes, Json) ?? throw Failure("proof"); }
        catch (JsonException) { throw Failure("proof"); }
        if (proof.Schema != ProofSchema || proof.OperationId != binding.OperationId || proof.RuntimeOrigin != binding.RuntimeOrigin
            || proof.ModuleKey != binding.ModuleKey || proof.PublishedVersionId != binding.PublishedVersionId || proof.SourceSha256 != binding.SourceSha256
            || !Key.IsMatch(proof.FunctionKey ?? "") || !Key.IsMatch(proof.EntryNodeKey ?? "") || !Key.IsMatch(proof.AnchorNodeKey ?? "")) throw Failure("proof_binding");
        if (privateNonce == null || !Nonce.IsMatch(privateNonce) || proof.Guard == null || !Hash.IsMatch(proof.Guard.LiteralSha256 ?? "")) throw Failure("nonce");
        var nonceBytes = Encoding.UTF8.GetBytes(privateNonce);
        try { if (Digest(nonceBytes) != proof.Guard.LiteralSha256) throw Failure("nonce"); }
        finally { CryptographicOperations.ZeroMemory(nonceBytes); }
        CheckGraph(proof);
        functionKey = proof.FunctionKey!; anchorKey = proof.AnchorNodeKey!; // Validated exact keys above.
        // Do not retain the proof, literal nonce, its UTF-8 buffer, or the caller's artifact.
    }

    internal Decision Observe(Metadata e) {
        if (phase == Phase.Faulted) return Reject(Decision.RejectAmbiguous);
        if (phase == Phase.Completed) return Reject(Decision.RejectForeign);
        if (ExpireIfNeeded()) return Reject(Decision.RejectExpired);
        if (e == null || !e.RawRequestIdPresent || e.RequestIdIsFallback || !PrivateIdentifier(e.RawRequestId) || !PrivateIdentifier(e.ThreadId)
            || e.EventId < 0 || e.IsServerBreakpoint == e.IsThreadEnd) return Reject(Decision.RejectInvalid);
        // This check precedes every foreign scope return: control APIs take ThreadId
        // alone, so a different/unqualified scope must not release that owned slot.
        if (phase == Phase.OwnedThread && e.ThreadId == ownedThread
            && (e.RawRequestId != ownedRequest || e.SessionId != binding.SessionId || e.ModuleKey != binding.ModuleKey)) {
            Fault(); return Reject(Decision.RejectAmbiguous);
        }
        if (e.SessionId != binding.SessionId || e.ModuleKey != binding.ModuleKey) return Reject(Decision.RejectForeign);
        var anchor = e.IsServerBreakpoint && e.FunctionModuleKey == binding.ModuleKey && e.FunctionKey == functionKey
            && e.NodeModuleKey == binding.ModuleKey && e.NodeKey == anchorKey;
        if (phase == Phase.AwaitAnchor) {
            if (!anchor) return Reject(Decision.RejectForeign);
            ownedThread = e.ThreadId; ownedRequest = e.RawRequestId; lastEventId = e.EventId; phase = Phase.OwnedThread;
            return Decision.AdoptOwnedThread;
        }
        if (e.ThreadId != ownedThread || e.RawRequestId != ownedRequest) {
            // Native Evaluate/Continue/Step address only ThreadId, not RequestId. A
            // conflicting request on the adopted ThreadId must never be released as
            // foreign: that command could address the owned pause itself.
            if (anchor || e.ThreadId == ownedThread) { Fault(); return Reject(Decision.RejectAmbiguous); }
            return Reject(Decision.RejectForeign);
        }
        if (e.EventId <= lastEventId) return Reject(Decision.RejectReplay);
        lastEventId = e.EventId;
        if (e.IsThreadEnd) { ownedThread = ownedRequest = null; phase = Phase.Completed; return Decision.CompleteOwnedThread; }
        return Decision.AcceptOwnedThread;
    }

    Decision Reject(Decision decision) { rejected++; return decision; }
    void Fault() { ownedThread = ownedRequest = null; phase = Phase.Faulted; }
    public void Dispose() { ownedThread = ownedRequest = null; phase = Phase.Completed; }
    static bool PrivateIdentifier(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 512 && !value.Any(char.IsControl);
    static DebugFailure Failure(string suffix) => new("debug_request_ownership_" + suffix + "_invalid");
    internal static string Digest(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static byte[] SerializeProof(NativeProof proof) => JsonSerializer.SerializeToUtf8Bytes(proof, Json);
    static bool ValidOrigin(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.UserInfo == ""
        && uri.AbsolutePath == "/" && uri.Query == "" && uri.Fragment == "" && uri.GetLeftPart(UriPartial.Authority) == value;

    static void CheckGraph(NativeProof p) {
        if (p.Header == null || p.Guard == null || p.Nodes == null || p.Edges == null || p.CutNodeKeys == null || p.PropertyErrors == null
            || p.CutNodeKeys.Length != 0 || p.PropertyErrors.Length != 0 || p.Nodes.Length is < 3 or > 1000 || p.Edges.Length is < 2 or > 2000
            || !Key.IsMatch(p.Header.InputKey ?? "") || p.Header.ReceiveIn != "Header" || p.Header.ReceiveAs != "X-SSAM-Debug-Token" || p.Header.DataType != "Text"
            || p.Guard.HeaderInputKey != p.Header.InputKey || p.Guard.Operator != "=" || !Key.IsMatch(p.Guard.NodeKey ?? "")
            || p.Nodes.Any(n => n == null || !Key.IsMatch(n.Key ?? "")) || p.Nodes.Select(n => n.Key).Distinct().Count() != p.Nodes.Length
            || p.Edges.Any(e => e == null || !Key.IsMatch(e.From ?? "") || !Key.IsMatch(e.To ?? ""))
            || p.Edges.Distinct().Count() != p.Edges.Length) throw Failure("graph");
        var nodes = p.Nodes.ToDictionary(n => n.Key);
        if (!nodes.TryGetValue(p.EntryNodeKey, out var entry) || entry.Kind != "IStartNode" || p.Nodes.Count(n => n.Kind == "IStartNode") != 1
            || !nodes.TryGetValue(p.Guard.NodeKey!, out var guard) || guard.Kind != "IIfNode" || !nodes.ContainsKey(p.AnchorNodeKey)
            || p.AnchorNodeKey == p.Guard.NodeKey || p.AnchorNodeKey == p.EntryNodeKey || nodes.ContainsKey(p.Header.InputKey) || nodes.ContainsKey(p.FunctionKey)
            || p.Edges.Any(e => !nodes.ContainsKey(e.From) || !nodes.ContainsKey(e.To))
            || p.Edges.Any(e => e.To == p.EntryNodeKey)) throw Failure("graph");
        var supported = new HashSet<string> { "IStartNode", "IIfNode", "IEndNode", "IRaiseExceptionNode", "IAssignNode", "IJSONDeserializeNode", "IJSONSerializeNode", "IExecuteServerActionNode" };
        foreach (var node in p.Nodes) {
            if (!supported.Contains(node.Kind)) throw Failure("graph");
            var outgoing = p.Edges.Where(e => e.From == node.Key).ToArray();
            if (node.Kind is "IEndNode" or "IRaiseExceptionNode") {
                if (outgoing.Length != 0) throw Failure("graph");
            } else if (node.Kind == "IIfNode") {
                if (outgoing.Length != 2 || outgoing.Count(e => e.Connector == "TrueTarget") != 1 || outgoing.Count(e => e.Connector == "FalseTarget") != 1) throw Failure("graph");
            } else if (outgoing.Length != 1 || outgoing[0].Connector != "Target") throw Failure("graph");
        }
        // REST inputs may be assignable in a flow. Require the nonce check first, so
        // no preceding Assign can replace the actual received header with the literal.
        if (p.Edges.Single(e => e.From == p.EntryNodeKey).To != p.Guard.NodeKey) throw Failure("dominance");
        var reached = Reach(p.EntryNodeKey, p.Edges);
        if (reached.Count != nodes.Count) throw Failure("graph");
        // The minimal wrapper graph is acyclic. This also excludes replay/loop paths and
        // implicit exception/lifecycle routes not represented by this qualified contract.
        var incoming = nodes.Keys.ToDictionary(k => k, k => p.Edges.Count(e => e.To == k));
        var queue = new Queue<string>(incoming.Where(kv => kv.Value == 0).Select(kv => kv.Key));
        var visited = 0;
        while (queue.TryDequeue(out var key)) { visited++; foreach (var e in p.Edges.Where(e => e.From == key)) if (--incoming[e.To] == 0) queue.Enqueue(e.To); }
        if (visited != nodes.Count) throw Failure("graph");
        var trueEdge = p.Edges.Single(e => e.From == p.Guard.NodeKey && e.Connector == "TrueTarget");
        var falseEdge = p.Edges.Single(e => e.From == p.Guard.NodeKey && e.Connector == "FalseTarget");
        if (!Reach(trueEdge.To, p.Edges).Contains(p.AnchorNodeKey) || Reach(falseEdge.To, p.Edges).Contains(p.AnchorNodeKey)
            || Reach(p.EntryNodeKey, p.Edges.Where(e => e != trueEdge).ToArray()).Contains(p.AnchorNodeKey)) throw Failure("dominance");
    }
    static HashSet<string> Reach(string start, NativeEdge[] edges) {
        var seen = new HashSet<string>(); var pending = new Stack<string>(); pending.Push(start);
        while (pending.TryPop(out var key)) if (seen.Add(key)) foreach (var e in edges.Where(e => e.From == key)) pending.Push(e.To);
        return seen;
    }
}
