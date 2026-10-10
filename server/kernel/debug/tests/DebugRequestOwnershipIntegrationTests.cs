using System.Text;
using System.Text.Json;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;
using ServerThreadData = ServiceStudio.ServerCommunications.API.ServerThreadData;

static class DebugRequestOwnershipIntegrationTests {
    const string Nonce = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const string Request = "SYNTHETIC-OWNED-REQUEST", ForeignRequest = "SYNTHETIC-FOREIGN-REQUEST", Thread = "SYNTHETIC-OWNED-THREAD";
    const string QualifiedNativeProofSha = "0c845bf7c524b4c74ef3bebc1c4b3bd699f981ba0b8f52abe4011b353b593892";
    internal static byte[]? NativeProofBytes;
    sealed class Clock : TimeProvider {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
    sealed class FailingDisposeWriter() : StreamWriter(new MemoryStream()) {
        protected override void Dispose(bool disposing) {
            base.Dispose(disposing); throw new IOException("synthetic_writer_disposal_failed");
        }
    }
    static int assertions;
    static void Check(bool condition, string description) { assertions++; Tests.Check(condition, description); }
    static Configuration Config(bool trace = false) {
        var bytes = NativeProofBytes?.ToArray() ?? DebugRequestOwnership.SerializeProof(DebugRequestOwnershipTests.Proof());
        var proof = JsonSerializer.Deserialize<DebugRequestOwnership.NativeProof>(bytes, Wire.Options)!;
        var sessionId = Guid.NewGuid().ToString("N");
        return new() {
            SessionId = sessionId, Module = "Fixture", ModuleKey = proof.ModuleKey, RuntimeUrl = "https://example.invalid/Fixture/",
            NodeKeys = [proof.AnchorNodeKey], AutoContinue = false, Seconds = 120,
            Trace = trace ? new() { Mode = "step", Steps = 20, FullValues = true, Scopes = new() { [proof.FunctionKey] = ["Alias"] } } : null,
            RequestOwnership = new() { Qualification = RequestOwnershipQualification.OfflineSynthetic, ProofBytes = bytes, PrivateNonce = Nonce,
                Binding = new(proof.OperationId, sessionId, proof.RuntimeOrigin, proof.ModuleKey, proof.PublishedVersionId,
                    proof.SourceSha256, DebugRequestOwnership.Digest(bytes), DateTimeOffset.UtcNow.AddSeconds(60)) }
        };
    }
    static DebugRequestOwnership.NativeProof Source(Configuration c) => JsonSerializer.Deserialize<DebugRequestOwnership.NativeProof>(c.RequestOwnership!.ProofBytes, Wire.Options)!;
    static ThreadData NativeThread(DebugRequestOwnership.NativeProof p, string thread, string request, long id, string? node = null, string? function = null) {
        var module = ObjectKey.Parse(p.ModuleKey); var point = new Breakpoint(module, ObjectKey.Parse(node ?? p.AnchorNodeKey));
        var action = new Breakpoint(module, ObjectKey.Parse(function ?? p.FunctionKey));
        return new ServerThreadData(module, thread, request, "Synthetic", "", id, false, false, "SYNTHETIC-NATIVE-SESSION",
            [new StackElement(0, "Fixture", "SyntheticFunction", action, "ServerAction", point, point, BreakpointType.Normal, "")]);
    }
    static DebugTransportEvent Breakpoint(DebugRequestOwnership.NativeProof p, string request = Request, string thread = Thread, long id = 1, string? node = null) {
        var t = NativeThread(p, thread, request, id, node);
        return new(new AtBreakpointEvent(BreakpointType.Normal, "", t, id), new(request, true, false));
    }
    static DebugTransportEvent End(DebugRequestOwnership.NativeProof p, string request = Request, long id = 20, string thread = Thread) {
        var t = NativeThread(p, thread, request, id);
        return new(new ThreadEndEvent(false, t, id), new(request, true, false));
    }
    static async Task RefusesControl(DebugSession session, string op, string id = "1") {
        try { await session.Execute(new() { Op = op, ThreadId = Thread, EventId = id, Frame = 0, Paths = ["Alias"] }); throw new Exception("unowned control accepted"); }
        catch (DebugFailure) { assertions++; }
    }
    internal static async Task Run() {
        // The native constructor falls back, while the envelope retains original absence.
        var explicitId = DebugTransportEvent.ReadXmlRequestId("<AtBreakpointEvent threadId='T' requestId='T'/>");
        var missing = DebugTransportEvent.ReadXmlRequestId("<AtBreakpointEvent threadId='T'/>");
        Check(explicitId.Present && !explicitId.IsFallback && explicitId.RawRequestId == "T" && !missing.Present && missing.IsFallback && missing.RawRequestId == null,
            "raw XML presence is independent of RequestId==ThreadId");
        Check(!DebugTransportEvent.ReadXmlRequestId("<AtBreakpointEvent RequestId='R'/>").Present, "request attribute casing is exact");
        try { DebugTransportEvent.ReadXmlRequestId("<!DOCTYPE e [<!ENTITY x SYSTEM 'file:///no'>]><e requestId='&x;'/>"); throw new Exception("event XXE accepted"); }
        catch (System.Xml.XmlException) { assertions++; }
        var metadata = new DebugTransportEvent.RequestProvenance(Request, true, false);
        Check(!Wire.Json(metadata).Contains(Request) && !metadata.ToString().Contains(Request), "raw provenance never serializes identifiers");
        var mismatchSource = DebugRequestOwnershipTests.Proof();
        var nativeEvent = Breakpoint(mismatchSource).NativeEvent;
        Check(!Wire.Json(new DebugTransportEvent(nativeEvent, metadata)).Contains(Request), "native envelope cannot serialize raw event identifiers");
        try { DebugTransportEvent.FromXml(nativeEvent, new(ForeignRequest, true, false)); throw new Exception("native/raw mismatch accepted"); }
        catch (DebugFailure e) { Check(e.Message == "debug_event_request_provenance_mismatch", "raw/native request mismatch fails closed"); }
        if (NativeProofBytes != null) Check(DebugRequestOwnership.Digest(NativeProofBytes) == QualifiedNativeProofSha, "actual SDK-extracted artifact is pinned");

        var denied = Config(); denied.RequestOwnership!.Qualification = RequestOwnershipQualification.ProductionQualified;
        try { denied.Validate(); throw new Exception("caller asserted production qualification accepted"); }
        catch (DebugFailure e) { Check(e.Message ==
#if ODC
            "debug_request_ownership_lane_not_qualified",
#else
            "debug_request_ownership_qualification_pending",
#endif
            "production/cross-lane qualification is never caller asserted"); }
#if ODC
        var odc = Config(); var reference = odc.RequestOwnership!; var proofReference = reference.ProofBytes;
        try { await using var unused = new DebugSession(odc, new FakeTransport()); throw new Exception("ODC ownership enabled"); }
        catch (DebugFailure e) { Check(e.Message == "debug_request_ownership_lane_not_qualified", "ODC ownership remains disabled"); }
        Check(odc.RequestOwnership == null && reference.PrivateNonce == null && reference.ProofBytes.Length == 0 && proofReference.All(b => b == 0), "rejected private bootstrap references cleared");
#else
        var live = Config(); live.RuntimeUrl = "https://personal.example/Fixture/";
        try { live.Validate(); throw new Exception("offline qualifier enabled on a real host"); }
        catch (DebugFailure e) { Check(e.Message == "debug_request_ownership_offline_binding_invalid", "offline qualification cannot authorize a real runtime"); }
        var badAnchor = Config(); badAnchor.NodeKeys = [Source(badAnchor).Guard.NodeKey];
        try { await using var unused = new DebugSession(badAnchor, new FakeTransport()); throw new Exception("non-anchor initial breakpoint enabled"); }
        catch (DebugFailure e) { Check(e.Message == "debug_request_ownership_anchor_breakpoint_required", "sole initial breakpoint is the qualified anchor"); }
        var defaultFactory = Config(); var defaultPrivate = defaultFactory.RequestOwnership!; var defaultBytes = defaultPrivate.ProofBytes;
        try { await using var unused = new DebugSession(defaultFactory); throw new Exception("offline native factory accepted"); }
        catch (DebugFailure e) { Check(e.Message == "debug_request_ownership_offline_transport_required", "offline ownership refuses default factory before auth/environment/network"); }
        Check(defaultFactory.Redactor == null && defaultFactory.RequestOwnership == null && defaultPrivate.PrivateNonce == null && defaultBytes.All(b => b == 0), "offline factory refusal clears private bootstrap references");
        foreach (var soap in new[] { false, true }) {
            var nativeConfig = Config(); var nativePrivate = nativeConfig.RequestOwnership!; var nativeBytes = nativePrivate.ProofBytes; var authentications = 0;
            (string User, string Secret) NativeAuth(Configuration _) { authentications++; throw new Exception("synthetic_native_auth_must_not_run"); }
            await using IDebugTransport native = soap ? new SoapTransport(nativeConfig, NativeAuth) : new NativeTransport(nativeConfig, NativeAuth);
            Check(!native.IsOfflineSynthetic, "installed native transport explicitly has no offline capability");
            try { await using var unused = new DebugSession(nativeConfig, native); throw new Exception("explicit native transport enabled offline ownership"); }
            catch (DebugFailure e) { Check(e.Message == "debug_request_ownership_offline_transport_required", "offline ownership rejects explicitly supplied native transport before Start"); }
            Check(authentications == 0 && nativeConfig.Redactor == null && nativeConfig.RequestOwnership == null && nativePrivate.PrivateNonce == null && nativeBytes.All(b => b == 0), "explicit native refusal never authenticates and clears bootstrap");
        }
        var missingDirectory = Config(trace: true); var failedPrivate = missingDirectory.RequestOwnership!; var failedBytes = failedPrivate.ProofBytes;
        missingDirectory.ReceiptPath = Path.Combine(Path.GetTempPath(), "SSAM.Ownership." + Guid.NewGuid().ToString("N"), "receipt.json");
        try { await using var unused = new DebugSession(missingDirectory, new FakeTransport()); throw new Exception("missing trace directory accepted"); }
        catch (DirectoryNotFoundException) { assertions++; }
        Check(missingDirectory.Redactor == null && missingDirectory.RequestOwnership == null && failedPrivate.PrivateNonce == null && failedBytes.All(b => b == 0), "writer preparation failure clears attached redactor and bootstrap");
        var disposeFailure = Config(trace: true); disposeFailure.ReceiptPath = Path.Combine(Path.GetTempPath(), "receipt.json");
        var brokenWriterSession = new DebugSession(disposeFailure, new FakeTransport(), traceWriterFactory: _ => new FailingDisposeWriter());
        var retainedRedactor = disposeFailure.Redactor!;
        Check(retainedRedactor.Contains(Nonce), "writer failure fixture owns private redactor before disposal");
        try { await brokenWriterSession.DisposeAsync(); throw new Exception("writer disposal failure hidden"); }
        catch (IOException) { assertions++; }
        Check(disposeFailure.Redactor == null && !retainedRedactor.Contains(Nonce), "writer disposal failure cannot skip private cleanup");

        // Same action/function is insufficient. Nothing from the foreign native frame reaches a View or Evaluate.
        var traced = Config(trace: true); var p = Source(traced); var privateConfig = traced.RequestOwnership!; var proofBytes = privateConfig.ProofBytes;
        var spy = new FakeTransport { EvaluateAnswer = "<vars><local name='Alias'><Text name='Copied' value='" + Nonce + "'/></local></vars>" };
        await using (var session = new DebugSession(traced, spy)) {
            Check(traced.RequestOwnership == null && privateConfig.PrivateNonce == null && proofBytes.All(b => b == 0), "private nonce/proof bootstrap references released");
            await session.Start(); await spy.Emit(Breakpoint(p, ForeignRequest, "SYNTHETIC-FOREIGN-THREAD", 1, p.Guard.NodeKey));
            var status = Wire.Json(session.Status());
            Check(spy.Evaluations == 0 && spy.Ops.SequenceEqual(["continue"]) && !status.Contains("SYNTHETIC-FOREIGN") && !status.Contains("SyntheticFunction") && status.Contains("\"productionQualified\":false"), "foreign same-action pause releases without Evaluate/step/View");
            await RefusesControl(session, "variables"); await RefusesControl(session, "step-into");
            await spy.Emit(Breakpoint(p, id: 2));
            Check(spy.Evaluations == 1 && spy.Ops.SequenceEqual(["continue", "step-into"]), "qualified anchor authorizes one evaluation and step");
            await spy.Emit(Breakpoint(p, id: 2));
            Check(spy.Evaluations == 1 && spy.Ops.Count == 2, "replayed owned stop never evaluates or controls twice");
            status = Wire.Json(session.Status());
            Check(!status.Contains(Nonce) && !status.Contains(Request) && status.Contains("[redacted]"), "nonce copied under an innocent local is redacted");
        }

        // A distinct foreign ThreadEnd or nonmatching/stale Continue cannot evict an owned pause.
        var manual = Config(); p = Source(manual); spy = new FakeTransport();
        await using (var session = new DebugSession(manual, spy)) {
            await session.Start(); await spy.Emit(Breakpoint(p));
            await spy.Emit(End(p, ForeignRequest, 3, "SYNTHETIC-DISTINCT-FOREIGN-THREAD"));
            var foreign = NativeThread(p, Thread, ForeignRequest, 4);
            await spy.Emit(new(new ContinueEvent(foreign, 4), new(ForeignRequest, true, false)));
            var stale = NativeThread(p, Thread, Request, 0);
            await spy.Emit(new(new ContinueEvent(stale, 0), new(Request, true, false)));
            await session.Execute(new() { Op = "variables", ThreadId = Thread, EventId = "1", Frame = 0, Paths = ["Alias"] });
            Check(spy.Evaluations == 1, "foreign/stale terminal notifications do not evict an owned pause");
            await spy.Emit(End(p)); await RefusesControl(session, "variables"); await RefusesControl(session, "step-over");
            await spy.Emit(Breakpoint(p, id: 21));
            Check(spy.Evaluations == 1 && spy.Ops.All(op => op == "continue"), "ThreadEnd closes slot and reused anchor never rearms");
        }

        // A fault must stop outside the event callback, which the native transport drains during Stop.
        var ambiguous = Config(); p = Source(ambiguous); spy = new FakeTransport();
        var callbackExited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        spy.OnStop = () => callbackExited.Task;
        await using (var session = new DebugSession(ambiguous, spy)) {
            await session.Start(); await spy.Emit(Breakpoint(p));
            await spy.Emit(Breakpoint(p, "SYNTHETIC-COMPETING", "SYNTHETIC-SECOND-THREAD", 2)).WaitAsync(TimeSpan.FromSeconds(2));
            callbackExited.SetResult(); await session.Stop().WaitAsync(TimeSpan.FromSeconds(2));
            await RefusesControl(session, "variables"); await RefusesControl(session, "step-into");
            Check(spy.Stops == 1 && spy.Evaluations == 0 && spy.Ops.Count == 0, "competing anchor stops once outside callback without inspecting or stepping");
        }
        var absent = Config(); p = Source(absent); spy = new FakeTransport();
        await using (var session = new DebugSession(absent, spy)) {
            await session.Start(); var actual = NativeThread(p, Thread, Thread, 1);
            await spy.Emit(DebugTransportEvent.WithoutProvenance(new AtBreakpointEvent(BreakpointType.Normal, "", actual, 1)));
            await session.Stop().WaitAsync(TimeSpan.FromSeconds(2));
            await RefusesControl(session, "variables");
            Check(spy.Stops == 1 && spy.Evaluations == 0 && spy.Ops.Count == 0 && !Wire.Json(session.Status()).Contains("SyntheticFunction"), "native fallback/raw absence refuses before View/Evaluate/control");
        }
        foreach (var conflictKind in new[] { "breakpoint", "thread-end", "foreign-module-foreign-request", "foreign-module-owned-request" }) {
            var collision = Config(); p = Source(collision); spy = new FakeTransport();
            var callbackDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            spy.OnStop = () => callbackDone.Task;
            await using var session = new DebugSession(collision, spy);
            await session.Start(); await spy.Emit(Breakpoint(p));
            DebugTransportEvent conflict;
            if (conflictKind == "thread-end") conflict = End(p, ForeignRequest, 2);
            else if (conflictKind.StartsWith("foreign-module", StringComparison.Ordinal)) {
                var foreignProof = JsonSerializer.Deserialize<DebugRequestOwnership.NativeProof>(DebugRequestOwnership.SerializeProof(p), Wire.Options)!;
                foreignProof.ModuleKey = p.Header.InputKey;
                conflict = Breakpoint(foreignProof, conflictKind.EndsWith("owned-request", StringComparison.Ordinal) ? Request : ForeignRequest, Thread, 2, p.Guard.NodeKey);
            } else conflict = Breakpoint(p, ForeignRequest, Thread, 2, p.Guard.NodeKey);
            await spy.Emit(conflict).WaitAsync(TimeSpan.FromSeconds(2));
            callbackDone.SetResult(); await session.Stop().WaitAsync(TimeSpan.FromSeconds(2));
            Check(spy.Stops == 1 && spy.Evaluations == 0 && spy.Ops.Count == 0, "same native ThreadId with conflicting request/scope stops without foreign Continue: " + conflictKind);
        }
        // No new event is required to expire an already adopted pause. Every manual
        // operation and the pause-release ticker must check the same injected clock.
        foreach (var op in new[] { "variables", "step-into", "continue", "release-expired" }) {
            var expired = Config(); p = Source(expired); spy = new FakeTransport(); var clock = new Clock();
            await using var session = new DebugSession(expired, spy, clock);
            await session.Start(); await spy.Emit(Breakpoint(p)); clock.Now = clock.Now.AddMinutes(2);
            if (op == "release-expired") await session.ReleaseExpiredPauses();
            else await RefusesControl(session, op);
            await session.Stop().WaitAsync(TimeSpan.FromSeconds(2));
            Check(spy.Stops == 1 && spy.Evaluations == 0 && spy.Ops.Count == 0 && Wire.Json(session.Status()).Contains("\"state\":\"stopped\""), "expired ownership refuses " + op + " without event, evaluation or control");
        }
#endif
        Console.WriteLine("PASS: request ownership integration (" + assertions + " assertions; production qualification refused)");
    }
}
