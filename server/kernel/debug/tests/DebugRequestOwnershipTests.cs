using System.Text;

static class DebugRequestOwnershipTests {
    const string Module = "AQEBAQEBAQEBAQEBAQEBAQ", Function = "AgICAgICAgICAgICAgICAg", Start = "AwMDAwMDAwMDAwMDAwMDAw",
        Guard = "BAQEBAQEBAQEBAQEBAQEBA", Anchor = "BQUFBQUFBQUFBQUFBQUFBQ", End = "BgYGBgYGBgYGBgYGBgYGBg", Header = "BwcHBwcHBwcHBwcHBwcHBw";
    const string Nonce = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const string PrivateRequest = "PRIVATE-REQUEST-UNICODE-ç", PrivateThread = "PRIVATE-THREAD";
    static readonly string Operation = Guid.NewGuid().ToString("N"), Session = Guid.NewGuid().ToString("N");
    static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-03T18:00:00Z");
    sealed class Clock : TimeProvider { internal DateTimeOffset Now = DebugRequestOwnershipTests.Now; public override DateTimeOffset GetUtcNow() => Now; }
    internal static DebugRequestOwnership.NativeProof Proof() => new() {
        Schema = DebugRequestOwnership.ProofSchema, OperationId = Operation, RuntimeOrigin = "https://example.invalid", ModuleKey = Module,
        PublishedVersionId = 10, SourceSha256 = new('a', 64), FunctionKey = Function, EntryNodeKey = Start, AnchorNodeKey = Anchor,
        Header = new() { InputKey = Header, ReceiveIn = "Header", ReceiveAs = "X-SSAM-Debug-Token", DataType = "Text" },
        Guard = new() { NodeKey = Guard, HeaderInputKey = Header, Operator = "=", LiteralSha256 = DebugRequestOwnership.Digest(Encoding.UTF8.GetBytes(Nonce)) },
        Nodes = [new(Start, "IStartNode"), new(Guard, "IIfNode"), new(Anchor, "IAssignNode"), new(End, "IEndNode")],
        Edges = [new(Start, "Target", Guard), new(Guard, "TrueTarget", Anchor), new(Guard, "FalseTarget", End), new(Anchor, "Target", End)]
    };
    static DebugRequestOwnership.Binding Binding(byte[] bytes) => new(Operation, Session, "https://example.invalid", Module, 10, new('a', 64), DebugRequestOwnership.Digest(bytes), Now.AddMinutes(10));
    static DebugRequestOwnership Gate(DebugRequestOwnership.NativeProof? proof = null, Clock? clock = null) {
        var bytes = DebugRequestOwnership.SerializeProof(proof ?? Proof()); return new(bytes, Binding(bytes), Nonce, clock ?? new Clock());
    }
    static DebugRequestOwnership.Metadata Event(string node = Anchor, string request = PrivateRequest, string thread = PrivateThread, long id = 1) =>
        new(Session, Module, Module, Function, Module, node, thread, request, true, false, id, true);
    static void Refuses(DebugRequestOwnership.NativeProof proof, string expected) {
        try { using var gate = Gate(proof); throw new Exception("ownership proof accepted " + expected); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_request_ownership_" + expected + "_invalid", "fixed ownership refusal " + expected); }
    }
    internal static void Run() {
        using (var gate = Gate()) {
            Tests.Check(gate.Observe(Event(node: Guard)) == DebugRequestOwnership.Decision.RejectForeign && gate.State == DebugRequestOwnership.Phase.AwaitAnchor, "same function before private anchor is not ownership");
            Tests.Check(gate.Observe(Event() with { RawRequestIdPresent = false, RequestIdIsFallback = true }) == DebugRequestOwnership.Decision.RejectInvalid, "native ThreadId fallback is not request evidence");
            Tests.Check(gate.Observe(Event() with { SessionId = Guid.NewGuid().ToString("N") }) == DebugRequestOwnership.Decision.RejectForeign, "foreign session cannot adopt anchor");
            Tests.Check(gate.Observe(Event() with { NodeModuleKey = Header }) == DebugRequestOwnership.Decision.RejectForeign, "node key alone cannot adopt another module");
            Tests.Check(gate.Observe(Event()) == DebugRequestOwnership.Decision.AdoptOwnedThread, "post-nonce anchor adopts exact native tuple");
            Tests.Check(gate.Observe(Event(node: Guard, request: "FOREIGN", thread: "DISTINCT-FOREIGN-THREAD", id: 2)) == DebugRequestOwnership.Decision.RejectForeign, "distinct foreign thread cannot evaluate");
            Tests.Check(gate.Observe(Event(node: Guard, id: 2) with { FunctionKey = Header }) == DebugRequestOwnership.Decision.AcceptOwnedThread, "same owned request may enter another server action");
            Tests.Check(gate.Observe(Event(node: Guard, id: 2)) == DebugRequestOwnership.Decision.RejectReplay, "duplicate pause cannot authorize twice");
            var safe = Wire.Json(gate.SafeStatus());
            Tests.Check(!safe.Contains(Nonce) && !safe.Contains(PrivateRequest) && !safe.Contains(PrivateThread), "ownership status exposes no private correlation or nonce");
            var eventView = Wire.Json(Event());
            Tests.Check(!eventView.Contains(PrivateRequest) && !eventView.Contains(PrivateThread) && !Event().ToString().Contains(PrivateRequest), "accidental event serialization never exports private native tuple");
            Tests.Check(gate.Observe(Event(id: 3) with { IsServerBreakpoint = false, IsThreadEnd = true }) == DebugRequestOwnership.Decision.CompleteOwnedThread, "owned native ThreadEnd closes slot");
            Tests.Check(gate.Observe(Event(request: "REUSED", id: 4)) == DebugRequestOwnership.Decision.RejectForeign, "completed operation never rearms on reused thread");
        }
        using (var gate = Gate()) {
            gate.Observe(Event());
            Tests.Check(gate.Observe(Event(request: "REPLAY-NONCE", thread: "SECOND", id: 2)) == DebugRequestOwnership.Decision.RejectAmbiguous && gate.State == DebugRequestOwnership.Phase.Faulted, "competing private anchor faults rather than choosing first request");
            Tests.Check(gate.Observe(Event(node: Guard, id: 3)) == DebugRequestOwnership.Decision.RejectAmbiguous, "ambiguity cannot be resumed as owned later");
        }
        var clock = new Clock(); using (var gate = Gate(clock: clock)) { clock.Now = Now.AddMinutes(11); Tests.Check(gate.Observe(Event()) == DebugRequestOwnership.Decision.RejectExpired, "expired operation cannot adopt request"); }
        var p = Proof(); p.Edges[2] = new(Guard, "FalseTarget", Anchor); Refuses(p, "dominance");
        p = Proof(); p.Nodes = [..p.Nodes, new("CAgICAgICAgICAgICAgICA", "IAssignNode")];
        p.Edges = [new(Start, "Target", "CAgICAgICAgICAgICAgICA"), new("CAgICAgICAgICAgICAgICA", "Target", Guard), ..p.Edges.Skip(1)]; Refuses(p, "dominance");
        p = Proof(); p.Edges = [new(Start, "Target", Guard), new(Guard, "TrueTarget", Anchor), new(Guard, "FalseTarget", End), new(Anchor, "Target", Guard)]; Refuses(p, "graph");
        p = Proof(); p.Nodes = [..p.Nodes, new(Header, "IExceptionHandlerNode")]; Refuses(p, "graph");
        p = Proof(); p.CutNodeKeys = [Anchor]; Refuses(p, "graph");
        p = Proof(); p.Guard.HeaderInputKey = End; Refuses(p, "graph");
        p = Proof(); p.OperationId = Guid.NewGuid().ToString("N"); Refuses(p, "proof_binding");
        p = Proof(); p.Guard.LiteralSha256 = new('b', 64); Refuses(p, "nonce");
        var bytes = DebugRequestOwnership.SerializeProof(Proof()); var binding = Binding(bytes); bytes[^2] ^= 1;
        try { using var gate = new DebugRequestOwnership(bytes, binding, Nonce, new Clock()); throw new Exception("tampered native proof accepted"); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_request_ownership_proof_invalid", "pinned proof corruption is rejected safely"); }
        bytes = DebugRequestOwnership.SerializeProof(Proof());
        try { using var gate = new DebugRequestOwnership(bytes, Binding(bytes) with { SourceSha256 = new('c', 64) }, Nonce, new Clock()); throw new Exception("mismatched published source accepted"); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_request_ownership_proof_binding_invalid", "published source binding is exact"); }
    }
}
