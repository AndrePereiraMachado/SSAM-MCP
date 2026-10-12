using ServiceStudio.PluginAPI.Debugger;
using System.Diagnostics;

internal sealed class DebugSession : IAsyncDisposable {
    readonly Configuration config;
    readonly DebugPolicy.PrivateValues privateValues = new();
    readonly IDebugTransport transport;
    readonly DebugRequestOwnership? ownership;
    readonly PrivateInspectionWire? privateInspectionWire;
    readonly SemaphoreSlim gate = new(1);
    readonly Dictionary<string, Pause> pauses = new();
    readonly Queue<object> events = new();
    readonly HashSet<(string ThreadId, long EventId)> seenStops = new();
    readonly DateTime expires;
    readonly long opened = Stopwatch.GetTimestamp();
    readonly Queue<object> recentTrace = new();
    readonly HashSet<string> focusEntered = new(); // threads whose stack already held the focus action
    readonly HashSet<string> tracedThreads = new(); // threads with at least one recorded visit (thread-end marker)
    readonly StreamWriter? traceFile;
    int traceCount, traceSkipped;
    string state = "starting";
    string? fault;
    bool pauseRequested;
    int pauseRequests;
    string? startError, startExceptionClass, stopError, stopExceptionClass;
    Task? stopTask;
    int ownershipFaultStopScheduled;
    internal bool Finished => state is "stopped" or "stop-uncertain";
    sealed class Pause(ThreadData thread, DebugRequestOwnership.Metadata? metadata = null, string? nativeRequestIdSha256 = null) {
        internal readonly ThreadData Thread = thread;
        internal readonly DebugRequestOwnership.Metadata? OwnershipMetadata = metadata;
        internal readonly string? NativeRequestIdSha256 = nativeRequestIdSha256;
        internal readonly long Started = Stopwatch.GetTimestamp();
        internal bool Consumed;
        internal NativeInspection? Inspection;
    }
    internal DebugSession(Configuration config, IDebugTransport? transport = null, TimeProvider? ownershipClock = null,
        Func<Configuration, StreamWriter?>? traceWriterFactory = null) {
        IDebugTransport? preparedTransport = null; StreamWriter? preparedTrace = null;
        try {
            config.ValidatePrivateValues();
            config.Inspection?.Validate();
            if (config.Inspection != null && (config.AutoContinue || config.Trace != null)) throw new DebugFailure("debug_inspection_requires_manual_session");
            config.ValidateRequestOwnership();
            if (config.RequestOwnership is { } requestOwnership) {
                // This qualification executes synthetic events only. An explicitly injected
                // internal transport is mandatory; never consult developer credentials or
                // construct a native client from a caller-asserted offline configuration.
                if (transport?.IsOfflineSynthetic != true) throw new DebugFailure("debug_request_ownership_offline_transport_required");
                privateValues.Add(requestOwnership.PrivateNonce);
                ownership = new(requestOwnership.ProofBytes, requestOwnership.Binding!, requestOwnership.PrivateNonce!, ownershipClock);
                // The sole initial breakpoint must be the proof's anchor. Parse only after the
                // gate verified the hash, strict schema and native graph binding.
                var proof = System.Text.Json.JsonSerializer.Deserialize<DebugRequestOwnership.NativeProof>(requestOwnership.ProofBytes, Wire.Options)!;
                if (config.NodeKeys[0] != proof.AnchorNodeKey) throw new DebugFailure("debug_request_ownership_anchor_breakpoint_required");
            }
            privateValues.Add(config.PrivateValues);
            privateValues.Add(config.Token, config.SoapUser, config.SoapSecret);
            Array.Clear(config.PrivateValues); config.PrivateValues = [];
            config.Redactor = privateValues;
            preparedTransport = transport ?? TransportFactory.Create(config);
            // The map is written as it happens: a viewer can follow trace.jsonl while the request runs.
            if (config.Trace != null && config.ReceiptPath != null)
                preparedTrace = traceWriterFactory != null ? traceWriterFactory(config)
                    : new StreamWriter(Path.Combine(Path.GetDirectoryName(config.ReceiptPath)!, "trace.jsonl"), true) { AutoFlush = true };
            preparedTransport.Received += OnEvent;
            preparedTransport.Failed += code => { if (!Finished && state != "stopping") { fault = code; state = "faulted"; } };
            this.config = config; this.transport = preparedTransport; traceFile = preparedTrace;
            var deadline = DateTimeOffset.UtcNow.AddSeconds(config.Seconds);
            if (config.CredentialExpiresAt is { } credentialExpiry && credentialExpiry < deadline) deadline = credentialExpiry;
            config.Deadline = deadline;
            expires = deadline.UtcDateTime;
            if (config.PrivateInspectionKey != null) {
                if (config.Inspection == null) throw new DebugFailure("debug_private_inspection_not_enabled");
                privateInspectionWire = new(config.PrivateInspectionKey, config.SessionId);
                config.PrivateInspectionKey = null;
            }
        } catch {
            // Preserve the preparation error even if disposal of an incomplete writer/client
            // also fails. The supplied transport remains the injecting caller's resource.
            try { preparedTrace?.Dispose(); } catch { }
            try { if (transport == null && preparedTransport != null) preparedTransport.DisposeAsync().AsTask().GetAwaiter().GetResult(); } catch { }
            ClearPrivateResources(config);
            if (config.PrivateValues != null) Array.Clear(config.PrivateValues); config.PrivateValues = [];
            throw;
        }
        finally { config.RequestOwnership?.Clear(); config.RequestOwnership = null; }
    }
    internal TimeSpan RemainingLease { get { var left = expires - DateTime.UtcNow; return left > TimeSpan.Zero ? left : TimeSpan.Zero; } }
    internal async Task Start() {
        try { await transport.Start(); if (fault == null) state = "connected"; }
        catch (Exception e) {
            startError = Wire.SafeFailureCode(e, e is System.Net.WebException { Status: System.Net.WebExceptionStatus.Timeout }
                ? "debug_start_timeout_uncertain" : "debug_start_failed_or_uncertain");
            startExceptionClass = Wire.SafeExceptionClass(e);
            fault ??= startError; state = "start-failed"; throw;
        }
    }
    internal object Status() => new {
        ok = fault == null, sessionId = config.SessionId, headless = true,
#if ODC
        lane = "odc",
#else
        lane = "o11",
#endif
        processId = Environment.ProcessId, state, error = fault, expiresAt = expires, module = config.Module,
        startError, startExceptionClass, stopError, stopExceptionClass, transport = transport.Diagnostic,
        breakpoints = config.NodeKeys, breakpointOwners = config.NodeModuleKeys, breakOnAllErrors = false, autoContinue = config.AutoContinue,
        // ODC start preflight: a failed one means no start was sent (transport.startOutcome not-attempted).
        transportPreflight = (transport as NativeTransport)?.Preflight,
        pauseRequest = new { requested = pauseRequested, attempts = pauseRequests, scope = "native-debug-session-threads" },
        inspectionMode = config.Inspection == null ? "bounded-capture" : "interactive", remainingLeaseMs = Math.Round(RemainingLease.TotalMilliseconds),
        requestOwnership = ownership == null ? new { mode = "legacy-unbound", productionQualified = false, gate = (object?)null }
            : new { mode = "offline-synthetic", productionQualified = false, gate = (object?)ownership.SafeStatus() },
        pauses = pauses.Values.Where(p => !p.Consumed).Select(p => View(p.Thread, p.NativeRequestIdSha256)).ToArray(), events = events.ToArray(),
        trace = config.Trace == null ? null : new { mode = config.Trace.Mode, count = traceCount, steps = config.Trace.Steps, skippedThreads = traceSkipped, file = traceFile != null ? "trace.jsonl" : null, last = recentTrace.ToArray() }
    };
    // The fingerprint exists only for an original requestId equal to the server thread's RequestId (DebugTransportEvent).
    static object View(ThreadData t, string? nativeRequestIdSha256 = null) => new {
        threadId = t.ThreadId, eventId = t.EventId.ToString(System.Globalization.CultureInfo.InvariantCulture), nativeRequestIdSha256,
        stack = t.Stack.Take(100).Select(f => new { frame = f.StackLevel, module = f.ESpaceName, moduleKey = f.FunctionId?.ESpaceKey.ToString(), action = f.FunctionName, nodeKey = f.Breakpoint?.ObjectKey.ToString(), functionKey = f.FunctionId?.ObjectKey.ToString(), functionType = f.FunctionType }).ToArray()
    };
    void Record(object item) {
        if (Wire.Json(item).Length > 65536) item = new { kind = "capture-truncated", error = "debug_event_output_limit" };
        events.Enqueue(item); while (events.Count > 50) events.Dequeue();
    }
    async Task OnEvent(DebugTransportEvent envelope) {
        bool stopForOwnershipFault = false;
        await gate.WaitAsync();
        try {
            var evt = envelope.NativeEvent;
            var thread = evt.ThreadData;
            if (Finished || state is "stopping" or "faulted") return;
            if (evt is StopDebugSessionEvent) { fault = "debug_server_ended_session"; state = "faulted"; return; }
            // Session-level native events (including readiness) can have no
            // application thread. Keep them observable before inspecting frames.
            if (thread == null) { Record(new { kind = evt.GetType().Name, eventId = evt.EventId.ToString(System.Globalization.CultureInfo.InvariantCulture) }); return; }
            DebugRequestOwnership.Metadata? metadata = null;
            if (ownership != null && evt is (AtBreakpointEvent or ThreadEndEvent)) {
                metadata = Metadata(envelope);
                var decision = ownership.Observe(metadata);
                if (decision is DebugRequestOwnership.Decision.RejectInvalid or DebugRequestOwnership.Decision.RejectExpired or DebugRequestOwnership.Decision.RejectAmbiguous) {
                    state = "faulted"; fault = "debug_request_ownership_event_refused";
                    stopForOwnershipFault = true; return;
                }
                if (decision == DebugRequestOwnership.Decision.CompleteOwnedThread) {
                    pauses.Remove(thread.ThreadId); focusEntered.Remove(thread.ThreadId); return;
                }
                if (decision is not (DebugRequestOwnership.Decision.AdoptOwnedThread or DebugRequestOwnership.Decision.AcceptOwnedThread)) {
                    if (evt is AtBreakpointEvent && !thread.IsClientSideThread && decision != DebugRequestOwnership.Decision.RejectReplay) {
                        traceSkipped++;
                        if (seenStops.Count >= 2048) { state = "faulted"; fault = "debug_event_limit"; stopForOwnershipFault = true; return; }
                        if (seenStops.Add((thread.ThreadId, thread.EventId))) ReleaseForeignPause(thread);
                    }
                    return;
                }
                privateValues.Add(metadata.ThreadId, metadata.RawRequestId);
            }
            // SuspendAllThreads answers with BeforeSuspendEvent (frameless server stack); the installed DebuggerManager
            // registers it like a breakpoint stop. It is a stop only where pause is permitted; elsewhere it is observed.
            var suspension = evt is BeforeSuspendEvent && config.Inspection != null && !config.AutoContinue && config.Trace == null && ownership == null;
            if ((evt is AtBreakpointEvent || suspension) && !thread.IsClientSideThread) {
                if (seenStops.Count >= 2048) { state = "faulted"; fault = "debug_event_limit"; return; }
                if (!seenStops.Add((thread.ThreadId, thread.EventId))) return;
                if (pauses.TryGetValue(thread.ThreadId, out var old) && old.Thread.EventId >= thread.EventId) return;
                var pause = pauses[thread.ThreadId] = new(thread, metadata, envelope.NativeRequestIdSha256);
                pauseRequested = false;
                if (config.Inspection is { } inspection && thread.Stack.Any()) pause.Inspection = new(inspection, privateValues, thread, request => transport.Evaluate(thread.ThreadId, request),
                    new(envelope.RawRequestId, envelope.RawRequestIdPresent, envelope.RequestIdIsFallback), privateInspectionWire);
                if (config.Trace is { } trace) { TraceStop(pause, trace, envelope.NativeRequestIdSha256); return; }
                Record(new { kind = "paused", reason = suspension ? "suspend" : "breakpoint", stop = View(thread, envelope.NativeRequestIdSha256),
                    nativeRequestIdShape = envelope.NativeRequestIdShape });
                if (config.AutoContinue) {
                    try {
                        if (config.Paths.Length > 0) Record(new { kind = "variables", stop = View(thread), values = Inspect(pause, thread.StackTop.StackLevel, 2, config.Paths) });
                    } catch { Record(new { kind = "capture-error", error = "debug_evaluation_failed" }); }
                    finally { Continue(pause, "continue"); }
                }
            } else if (evt is ContinueEvent or ThreadEndEvent) {
                // ThreadEnd carries no outcome natively; scheduling, ThreadEnd and completion stay separate facts.
                if (evt is ThreadEndEvent && config.Inspection != null)
                    Record(new { kind = "thread-end", threadId = thread.ThreadId, eventId = thread.EventId.ToString(),
                        nativeRequestIdSha256 = envelope.NativeRequestIdSha256, nativeRequestIdShape = envelope.NativeRequestIdShape,
                        lastBreakpoint = envelope.LastBreakpointNodeKey,
                        isLongLivedRequest = (thread as ServiceStudio.ServerCommunications.API.ServerThreadData)?.IsLongLivedRequest });
                // The map of one request ends here: a runner segments scenarios by this marker instead of waiting for silence.
                if (evt is ThreadEndEvent && config.Trace != null && tracedThreads.Remove(thread.ThreadId))
                    AppendTrace(new { kind = "thread-end", ms = Math.Round(Stopwatch.GetElapsedTime(opened).TotalMilliseconds), threadId = thread.ThreadId,
                        nativeRequestIdSha256 = envelope.NativeRequestIdSha256,
                        eventId = thread.EventId.ToString(System.Globalization.CultureInfo.InvariantCulture) });
                if (ownership == null || pauses.TryGetValue(thread.ThreadId, out var p) && MatchesPause(envelope, p)) {
                    pauses.Remove(thread.ThreadId); if (evt is ThreadEndEvent) focusEntered.Remove(thread.ThreadId);
                }
            }
            else Record(new { kind = evt.GetType().Name, eventId = evt.EventId.ToString(System.Globalization.CultureInfo.InvariantCulture) });
        } finally {
            gate.Release();
            // Stop drains the polling callback. Schedule it instead of awaiting it from
            // inside that same callback, retaining the existing one-shot Stop semantics.
            if (stopForOwnershipFault || ownership?.State == DebugRequestOwnership.Phase.Faulted) ScheduleOwnershipFaultStop();
        }
    }
    DebugRequestOwnership.Metadata Metadata(DebugTransportEvent envelope) {
        var evt = envelope.NativeEvent; var thread = evt.ThreadData!;
        var top = thread.Stack.LastOrDefault();
        return new(config.SessionId, thread.ESpaceKey.ToString(), top?.FunctionId?.ESpaceKey.ToString(), top?.FunctionId?.ObjectKey.ToString(),
            top?.Breakpoint?.ESpaceKey.ToString(), top?.Breakpoint?.ObjectKey.ToString(), thread.ThreadId, envelope.RawRequestId,
            envelope.RawRequestIdPresent, envelope.RequestIdIsFallback, thread.EventId, evt is AtBreakpointEvent && !thread.IsClientSideThread, evt is ThreadEndEvent);
    }
    bool MatchesPause(DebugTransportEvent envelope, Pause p) => p.OwnershipMetadata is { } owned && envelope.RawRequestIdPresent && !envelope.RequestIdIsFallback
        && envelope.NativeEvent.ThreadData is { } thread && thread.ESpaceKey.ToString() == owned.ModuleKey
        && thread.ThreadId == owned.ThreadId && envelope.RawRequestId == owned.RawRequestId
        && thread.DebugSessionToken == p.Thread.DebugSessionToken && !thread.IsClientSideThread && thread.EventId >= p.Thread.EventId;
    void EnsureOwned(Pause p) {
        if (ownership == null) return;
        try {
            if (p.OwnershipMetadata == null) throw new DebugFailure("debug_request_ownership_pause_not_owned");
            ownership.RequireCurrentOwnedThread();
        } catch (DebugFailure) { state = "faulted"; fault = "debug_request_ownership_pause_not_owned"; throw; }
    }
    void ScheduleOwnershipFaultStop() {
        if (ownership != null && state == "faulted" && Interlocked.Exchange(ref ownershipFaultStopScheduled, 1) == 0) _ = Task.Run(Stop);
    }
    void ReleaseForeignPause(ThreadData thread) {
        // A Continue releases an observed foreign pause; it does not inspect or step it.
        try { ownership?.RequireForeignThreadRelease(thread.ThreadId); }
        catch (DebugFailure) { state = "faulted"; fault = "debug_request_ownership_thread_conflict"; throw; }
        if (string.IsNullOrWhiteSpace(thread.ThreadId) || thread.ThreadId.Length > 512 || thread.ThreadId.Any(char.IsControl))
            throw new DebugFailure("debug_request_ownership_event_refused");
        try { transport.Execute("continue", thread.ThreadId); }
        catch { state = "faulted"; fault = "debug_execution_uncertain"; throw; }
    }
    // One node visit: dump the scope of the action on top of the stack, record it, then step into the next node
    // (or continue once the budget is spent or the focus action returned). RequireFunctionKey filters actions only;
    // it does not distinguish another user's request executing the same action.
    void TraceStop(Pause pause, TraceOptions t, string? nativeRequestIdSha256) {
        EnsureOwned(pause);
        var thread = pause.Thread;
        var functions = thread.Stack.Select(f => f.FunctionId?.ObjectKey.ToString()).ToArray();
        if (t.RequireFunctionKey != null && !functions.Contains(t.RequireFunctionKey)) { traceSkipped++; Continue(pause, "continue", quiet: true); return; }
        var next = "continue";
        if (traceCount < t.Steps) {
            traceCount++;
            var top = thread.StackTop;
            var function = top.FunctionId?.ObjectKey.ToString();
            object[] values = []; string? error = null;
            if (function != null && t.Scopes.TryGetValue(function, out var roots) && roots.Length > 0) {
                try { values = Variables.Read(transport.Evaluate(thread.ThreadId, Variables.Request(top.StackLevel, t.Depth, roots, TraceOptions.MaxRoots)), t.FullValues, TraceOptions.MaxRoots, privateValues); }
                catch { error = "debug_evaluation_failed"; }
            }
            AppendTrace(new {
                seq = traceCount, ms = Math.Round(Stopwatch.GetElapsedTime(opened).TotalMilliseconds), threadId = thread.ThreadId,
                nativeRequestIdSha256,
                eventId = thread.EventId.ToString(System.Globalization.CultureInfo.InvariantCulture), module = top.ESpaceName, action = top.FunctionName,
                functionKey = function, nodeKey = top.Breakpoint?.ObjectKey.ToString(), stackDepth = thread.Stack.Count(),
                stack = thread.Stack.Take(30).Select(f => new { module = f.ESpaceName, action = f.FunctionName, functionKey = f.FunctionId?.ObjectKey.ToString(), nodeKey = f.Breakpoint?.ObjectKey.ToString() }).ToArray(),
                values, error
            });
            tracedThreads.Add(thread.ThreadId);
            // Step towards the focus action (the entry node usually sits in its caller), through it, and continue once
            // it has returned. An entry breakpoint starts a new traversal: thread ids may be reused across requests.
            if (top.Breakpoint != null && config.NodeKeys.Contains(top.Breakpoint.ObjectKey.ToString())) focusEntered.Remove(thread.ThreadId);
            var inFocus = t.FocusFunctionKey != null && functions.Contains(t.FocusFunctionKey);
            if (inFocus) focusEntered.Add(thread.ThreadId);
            var stepping = t.FocusFunctionKey == null || inFocus || !focusEntered.Contains(thread.ThreadId);
            if (t.Mode == "step" && stepping && traceCount < t.Steps) next = "step-into";
        }
        Continue(pause, next, quiet: true);
    }
    void AppendTrace(object entry) {
        var line = Wire.Json(entry);
        if (line.Length > 1048576) { entry = new { seq = traceCount, error = "debug_trace_entry_limit" }; line = Wire.Json(entry); }
        traceFile?.WriteLine(line);
        recentTrace.Enqueue(entry); while (recentTrace.Count > 20) recentTrace.Dequeue();
    }
    object[] Inspect(Pause p, int frame, int depth, string[] paths) {
        EnsureOwned(p); var t = p.Thread;
        if (!t.Stack.Any(f => f.StackLevel == frame)) throw new DebugFailure("debug_frame_missing");
        return Variables.Read(transport.Evaluate(t.ThreadId, Variables.Request(frame, depth, paths)), privateValues: privateValues);
    }
    void Continue(Pause p, string op, bool quiet = false) {
        EnsureOwned(p);
        p.Consumed = true; // Consume BEFORE the network call, including uncertain outcomes.
        p.Inspection?.Invalidate();
        try {
            transport.Execute(op, p.Thread.ThreadId);
            if (!quiet) Record(new { kind = op, threadId = p.Thread.ThreadId, eventId = p.Thread.EventId.ToString(), pauseObservedMs = Math.Round(Stopwatch.GetElapsedTime(p.Started).TotalMilliseconds, 1) });
        }
        catch { state = "faulted"; fault = "debug_execution_uncertain"; throw; }
    }
    internal async Task<object> Execute(Request r) {
        // Stop closes the event hub. Never hold the gate while it drains event callbacks.
        if (r.Op == "stop") { await Stop(); }
        await gate.WaitAsync();
        try {
            if (r.Op is "status" or "stop") return Status();
            if (state != "connected") throw new DebugFailure("debug_session_not_connected");
            if (RemainingLease <= TimeSpan.Zero) throw new DebugFailure("debug_session_expired");
            if (r.Op == "pause") {
                if (config.Inspection == null || config.AutoContinue || config.Trace != null || ownership != null)
                    throw new DebugFailure("debug_pause_requires_manual_session");
                if (r.ThreadId != null || r.EventId != null || pauseRequested || pauses.Values.Any(p => !p.Consumed))
                    throw new DebugFailure("debug_pause_already_pending_or_stopped");
                if (pauseRequests >= 64) throw new DebugFailure("debug_pause_limit");
                // Reserve before I/O. An uncertain native command is never
                // repeated; only a new observed stop clears the pending state.
                pauseRequested = true; pauseRequests++;
                try { transport.Execute("pause", ""); }
                catch { state = "faulted"; fault = "debug_pause_uncertain"; throw new DebugFailure(fault); }
                return Status();
            }
            if (r.ThreadId == null || !pauses.TryGetValue(r.ThreadId, out var p) || p.Consumed || r.EventId != p.Thread.EventId.ToString()) throw new DebugFailure("debug_stale_stop");
            EnsureOwned(p);
            if (r.Op is "scope" or "read" or "private-read" or "read-many" or "read-frame" or "expand" or "refresh" or "frame" or "bind-scope") {
                if (p.Inspection == null) throw new DebugFailure(config.Inspection != null && p.Thread.StackTop == null
                    ? "debug_native_suspension_without_frames" : "debug_inspection_not_enabled");
                if (r.Op == "bind-scope") return p.Inspection.BindScope(r.ScopeUpdate ?? throw new DebugFailure("debug_invalid_inspection_scope"));
                if (r.Op == "scope") return p.Inspection.Scope();
                if (r.Op == "frame") return p.Inspection.SelectFrame(r.Frame);
                if (r.Op == "read-many") return p.Inspection.ReadMany(r);
                if (r.Op == "read-frame") return p.Inspection.ReadFrame(r);
                return p.Inspection.Read(r);
            }
            if (r.Op == "variables") return new { ok = true, threadId = r.ThreadId, eventId = r.EventId, values = Inspect(p, r.Frame, r.Depth, r.Paths) };
            if (r.Op is not ("continue" or "step-over" or "step-into" or "step-out")) throw new DebugFailure("debug_unknown_operation");
            Continue(p, r.Op); return Status();
        } finally { gate.Release(); ScheduleOwnershipFaultStop(); }
    }
    internal async Task ReleaseExpiredPauses() {
        bool shouldStop = false;
        await gate.WaitAsync();
        try {
            if (ownership?.ExpireIfNeeded() == true) { state = "faulted"; fault = "debug_request_ownership_pause_expired"; }
            if (state == "faulted") shouldStop = true;
            else if (state == "connected" && config.Inspection == null) foreach (var p in pauses.Values.Where(p => !p.Consumed && Stopwatch.GetElapsedTime(p.Started).TotalSeconds >= config.PauseSeconds).ToArray()) {
                try { Continue(p, "continue"); } catch { shouldStop = true; break; }
            }
        } finally { gate.Release(); }
        if (shouldStop) await Stop();
    }
    internal async Task Stop() {
        TaskCompletionSource? completion = null;
        Task pending;
        await gate.WaitAsync();
        try {
            if (stopTask == null) {
                completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
                stopTask = completion.Task;
                state = "stopping";
                foreach (var pause in pauses.Values) pause.Inspection?.Invalidate();
                privateInspectionWire?.Dispose();
            }
            pending = stopTask;
        } finally { gate.Release(); }
        if (completion == null) { await pending; return; }
        bool confirmed = false;
        try { await transport.Stop(); confirmed = true; }
        catch (Exception e) {
            // Keep the first failure: cleanup failure must not erase why startup failed.
            stopError = Wire.SafeFailureCode(e, e is System.Net.WebException { Status: System.Net.WebExceptionStatus.Timeout }
                ? "debug_stop_timeout_uncertain" : "debug_stop_uncertain");
            stopExceptionClass = Wire.SafeExceptionClass(e);
        }
        await gate.WaitAsync();
        try {
            state = confirmed ? "stopped" : "stop-uncertain";
            ownership?.Dispose();
            if (confirmed) pauses.Clear(); else fault ??= "debug_stop_uncertain";
            Record(new { kind = state });
        } finally { gate.Release(); completion.SetResult(); }
    }
    public async ValueTask DisposeAsync() {
        try { await Stop(); await transport.DisposeAsync(); }
        finally {
            try { traceFile?.Dispose(); }
            finally { ClearPrivateResources(config); }
        }
    }
    void ClearPrivateResources(Configuration source) {
        privateInspectionWire?.Dispose(); source.PrivateInspectionKey = null;
        privateValues.Clear(); ownership?.Dispose();
        if (ReferenceEquals(source.Redactor, privateValues)) source.Redactor = null;
    }
}
