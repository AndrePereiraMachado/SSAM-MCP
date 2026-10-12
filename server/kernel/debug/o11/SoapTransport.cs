using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;
using ServiceStudio.ServerCommunications.API;              // ServerDebuggerEventFactory, StopDebugSessionEvent
using ServiceStudio.ServerCommunications.ServiceCenter.Debugger; // installed generated SOAP client
using System.Net;
using System.Net.Http;
using System.ServiceModel;
using System.ServiceModel.Channels;
using System.Text;

// Service Studio 11 debugs a platform-11 server over SOAP (SoapDebuggerService wrapping the generated
// DebuggerSoapEndpointSoapClient at {module}/_debugger.asmx) plus a polled XML event stream
// ({module}/_debuggerEvents.ashx, events separated by "<end/>", parsed by ServerDebuggerEventFactory).
// MinimumVersionForRestEndpoints = 12.0, so the REST/SignalR path (NativeTransport) is never used against
// platform 11. This transport reuses the INSTALLED native client and event factory, with the same safety
// semantics as NativeTransport: one start attempt, definite-failure vs uncertain-no-answer, no retry,
// bounded Evaluate, idempotent Stop, and no secrets in error codes.
internal sealed class SoapTransport(Configuration config, Func<Configuration, (string User, string Secret)>? authenticate = null) : IDebugTransport
{
    public bool IsOfflineSynthetic => false;
    readonly ObjectKey key = ObjectKey.Parse(config.ModuleKey);
    readonly Uri root = new(config.RuntimeUrl);
    // The endpoint belongs to the compiled consumer; the target UID and breakpoint keys still
    // identify the producer. Both published identities are authorized by the private SSO broker.
    readonly string eSpaceName = config.EntryModule ?? config.Module;
    internal const int MaxEventChars = 1048576;
    string? bearer;                 // only StartDebugSession carries it; later calls authenticate by session token
    string? sessionToken;
    long lastEventId;
    int startAttempted;
    int stopAttempted;
    string? startState;             // null, "attempted" (no answer yet), "failed" (server answered: no session exists)
    CancellationTokenSource? poll;
    Task? pollTask;
    int pollRequests, pollResponses, lastPollStatus, nativeEvents;
    string startPhase = "not-started", stopPhase = "not-started";
    public DebugTransportDiagnostic Diagnostic => new(startPhase, stopPhase, sessionToken != null, startState ?? "not-attempted") {
        PollRequests = pollRequests, PollResponses = pollResponses, LastPollStatus = lastPollStatus == 0 ? null : lastPollStatus, NativeEvents = nativeEvents
    };
    public event Func<DebugTransportEvent, Task>? Received;
    public event Action<string>? Failed;

    Uri EndpointUrl() => new UriBuilder(root.Scheme, root.Host, root.Port, "/" + eSpaceName + "/_debugger.asmx").Uri;
    Uri EventsUrl(long last, bool reconnect) => new(
        new UriBuilder(root.Scheme, root.Host, root.Port, "/" + eSpaceName + "/_debuggerEvents.ashx").Uri
        + "?debugSessionToken=" + Uri.EscapeDataString(sessionToken!)
        + "&lastEventReceived=" + last
        + "&eSpaceUID=" + Uri.EscapeDataString(key.ToString())
        + "&isReconnect=" + reconnect);

    // A definite start failure means no server session can exist. SOAP surfaces a server answer as a
    // FaultException, an unreachable host as EndpointNotFoundException, and an answered HTTP error through a
    // CommunicationException wrapping a WebException/HttpRequestException. Everything else (timeout, generic
    // channel abort) is uncertain: the lock stays and the operation is never retried.
    internal static string? DefiniteStartFailure(Exception e)
    {
        if (e is EndpointNotFoundException) return "debug_start_unreachable:EndpointNotFound";
        if (e is FaultException) return "debug_start_rejected:fault";
        for (Exception? x = e; x != null; x = x.InnerException)
        {
            if (x is WebException we && NativeTransport.DefiniteFailure(we) is { } code) return code;
            if (x is HttpRequestException { StatusCode: { } status }) return "debug_start_rejected:" + (int)status + ":unknown";
            // A reset or timeout can happen AFTER the server created the session. Only pre-connection
            // socket failures prove no session exists; uncertain starts retain the session lock.
            if (x is System.Net.Sockets.SocketException socket && socket.SocketErrorCode is
                System.Net.Sockets.SocketError.HostNotFound or System.Net.Sockets.SocketError.NoData or
                System.Net.Sockets.SocketError.ConnectionRefused or System.Net.Sockets.SocketError.NetworkUnreachable or
                System.Net.Sockets.SocketError.HostUnreachable or System.Net.Sockets.SocketError.AddressNotAvailable)
                return "debug_start_unreachable:Socket";
        }
        return null;
    }

    // Native Studio preserves the owner of each enabled breakpoint. Explicit scope metadata must identify one
    // owner per node (scopesRequired); the owner logic is shared with the ODC transport (BreakpointOwners).
    internal static string BreakpointIds(Configuration configuration) => BreakpointOwners.Ids(configuration, scopesRequired: true, includeCompoundKey: false);

    public async Task Start()
    {
        if (Interlocked.Exchange(ref startAttempted, 1) != 0 || Volatile.Read(ref stopAttempted) != 0) throw new DebugFailure("debug_start_already_attempted");
        var breakpoints = BreakpointIds(config);
        if (!string.IsNullOrEmpty(config.Token)) bearer = config.Token; // SSO: a debugging bearer token leased from the logged-in Studio
        string user = "", secret = "";
        if (bearer != null) {
            if (string.IsNullOrEmpty(config.SoapUser) || string.IsNullOrEmpty(config.SoapSecret)) throw new DebugFailure("debug_invalid_auth_context");
            (user, secret) = (config.SoapUser, config.SoapSecret);
        } else (user, secret) = authenticate != null ? authenticate(config) : O11Authentication.Login(config.Credentials, new Uri(config.RuntimeUrl), (name, password) => config.AddPrivateValues(name, password));
        config.AddPrivateValues(bearer, user, secret);
        // SSO is leased from the native Studio: its username and server-call ID token belong in the SOAP
        // body; the separately scoped debugging access token belongs only in the Authorization header.
        var eSpaceUid = ObjectKeyUtils.DatabaseValue(key);
        // One start attempt. No answer is uncertain; never retry or adopt another session.
        startState = "attempted";
        startPhase = "soap-start";
        string result;
        try
        {
            result = await Call(c => c.StartDebugSessionAsync(eSpaceUid, user, secret, false, breakpoints),
                r => r.Body.StartDebugSessionResult, TimeSpan.FromSeconds(8), withBearer: bearer != null) ?? "";
        }
        catch (Exception e) when (DefiniteStartFailure(e) is { } code) { startState = "failed"; throw new DebugFailure(code); }
        if (result.Length == 0 || result.Contains("ERROR", StringComparison.Ordinal))
        {
            startState = "failed";
            throw new DebugFailure("debug_start_rejected:answered:" + NativeTransport.MessageId(result));
        }
        sessionToken = result;
        startState = "accepted";
        startPhase = "poll-starting";
        config.AddPrivateValues(sessionToken);
        poll = new CancellationTokenSource();
        pollTask = Task.Run(() => Poll(poll.Token));
    }

    // The native DebuggerEventsThread long-polls _debuggerEvents.ashx: it reads the stream line by line,
    // builds an event between "<end/>" markers, and reconnects after each close. A dropped stream between
    // polls is normal and never surfaced as a failure; the session lease bounds the whole run.
    async Task Poll(CancellationToken ct)
    {
        // The session token lives in the native events URL. Never forward it to a redirect destination.
        using var http = new System.Net.Http.HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
        bool serverForced = false;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                Interlocked.Increment(ref pollRequests);
                using var answer = await http.GetAsync(EventsUrl(lastEventId, serverForced), HttpCompletionOption.ResponseHeadersRead, ct);
                Interlocked.Increment(ref pollResponses);
                lastPollStatus = (int)answer.StatusCode;
                serverForced = false;
                if (answer.IsSuccessStatusCode)
                {
                    startPhase = "poll-connected";
                    using var stream = await answer.Content.ReadAsStreamAsync(ct);
                    using var reader = new StreamReader(stream);
                    var buffer = new StringBuilder();
                    string? line;
                    while (!ct.IsCancellationRequested && (line = await reader.ReadLineAsync(ct)) != null)
                    {
                        if (line != "<end/>")
                        {
                            if ((long)buffer.Length + line.Length > MaxEventChars) { Failed?.Invoke("debug_event_too_large"); return; }
                            buffer.Append(line);
                            continue;
                        }
                        if (buffer.Length == 0) continue;
                        var chunk = buffer.ToString();
                        buffer.Clear();
                        DebuggerEvent? evt;
                        DebugTransportEvent? envelope;
                        bool reconnect;
                        try {
                            var provenance = DebugTransportEvent.ReadXmlRequestId(chunk);
                            evt = ServerDebuggerEventFactory.Create(config.Module, key, chunk, false, sessionToken!, out reconnect, out serverForced, out var id);
                            envelope = evt == null ? null : DebugTransportEvent.FromXml(evt, provenance);
                            if (id > lastEventId) lastEventId = id;
                        }
                        catch { Failed?.Invoke("debug_event_decode_failed"); continue; }
                        if (reconnect) { Failed?.Invoke("debug_reconnect_requires_new_session"); return; }
                        if (envelope != null && Received != null) { Interlocked.Increment(ref nativeEvents); await Received(envelope); }
                        if (evt is ServiceStudio.PluginAPI.Debugger.StopDebugSessionEvent) return;
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch { /* a transient poll error reconnects, exactly like the native events thread */ }
            if (!serverForced && !ct.IsCancellationRequested)
                try { await Task.Delay(1000, ct); } catch (OperationCanceledException) { return; }
        }
    }

    public string Evaluate(string thread, string request)
        // A capture must not hold a business request for the full control-call timeout.
        => Call(c => c.EvaluateAsync(sessionToken!, thread, request), r => r.Body.EvaluateResult,
            config.EvaluationTimeout, withBearer: false).GetAwaiter().GetResult() ?? "";

    public void Execute(string op, string thread)
    {
        var timeout = TimeSpan.FromSeconds(8);
        var result = (op switch
        {
            "pause" => Call(c => c.SuspendAllThreadsAsync(sessionToken!), r => r.Body.SuspendAllThreadsResult, timeout, false),
            "continue" => Call(c => c.ContinueThreadAsync(sessionToken!, thread), r => r.Body.ContinueThreadResult, timeout, false),
            "step-over" => Call(c => c.StepOverAsync(sessionToken!, thread), r => r.Body.StepOverResult, timeout, false),
            "step-into" => Call(c => c.StepIntoAsync(sessionToken!, thread), r => r.Body.StepIntoResult, timeout, false),
            "step-out" => Call(c => c.StepOutAsync(sessionToken!, thread), r => r.Body.StepOutResult, timeout, false),
            _ => throw new DebugFailure("debug_unknown_operation")
        }).GetAwaiter().GetResult();
        if (result?.StartsWith("ERROR:", StringComparison.Ordinal) == true) throw new DebugFailure("debug_execution_rejected");
    }

    public async Task Stop()
    {
        if (Interlocked.Exchange(ref stopAttempted, 1) != 0) return;
        stopPhase = "stopping";
        try
        {
            if (startState == "attempted" && sessionToken == null) throw new DebugFailure("debug_start_uncertain");
            poll?.Cancel();
            if (sessionToken != null)
                await Call<StopDebugSessionResponse, string?>(c => c.StopDebugSessionAsync(sessionToken!, false), _ => null, TimeSpan.FromSeconds(8), false);
            stopPhase = "stopped";
        }
        finally
        {
            poll?.Cancel();
            if (pollTask != null) { try { await pollTask; } catch { } }
        }
    }

    public async ValueTask DisposeAsync() => await Stop();

    // One client per call, as the native WebServiceBase.MakeCall does: a faulted channel is never reused and a
    // bounded Evaluate abandons the pending call with Abort while later control calls keep working.
    async Task<TResult?> Call<TResponse, TResult>(Func<DebuggerSoapEndpointSoapClient, Task<TResponse>> call,
        Func<TResponse, TResult?> extract, TimeSpan timeout, bool withBearer)
    {
        var client = CreateClient(timeout);
        var ok = false;
        try
        {
            Task<TResponse> pending;
            if (withBearer && bearer != null)
            {
                // The Studio attaches the debugging bearer only to StartDebugSession, through the OperationContext.
                var previous = OperationContext.Current;
                OperationContext.Current = new OperationContext(client.InnerChannel);
                try
                {
                    var header = new HttpRequestMessageProperty();
                    header.Headers["Authorization"] = "Bearer " + bearer;
                    OperationContext.Current.OutgoingMessageProperties[HttpRequestMessageProperty.Name] = header;
                    pending = call(client);
                    var answered = await pending.WaitAsync(timeout);
                    ok = true;
                    return extract(answered);
                }
                finally { OperationContext.Current = previous; }
            }
            pending = call(client);
            var result = await pending.WaitAsync(timeout);
            ok = true;
            return extract(result);
        }
        finally { try { if (ok) client.Close(); else client.Abort(); } catch { try { client.Abort(); } catch { } } }
    }

    DebuggerSoapEndpointSoapClient CreateClient(TimeSpan timeout)
    {
        var https = string.Equals(root.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
        var binding = new BasicHttpBinding
        {
            MaxReceivedMessageSize = int.MaxValue,
            MaxBufferSize = int.MaxValue,
            OpenTimeout = timeout,
            CloseTimeout = timeout,
            SendTimeout = timeout,
            ReceiveTimeout = timeout,
            Security = { Mode = https ? BasicHttpSecurityMode.Transport : BasicHttpSecurityMode.None }
        };
        binding.ReaderQuotas.MaxStringContentLength = int.MaxValue;
        binding.ReaderQuotas.MaxArrayLength = int.MaxValue;
        return new DebuggerSoapEndpointSoapClient(binding, new EndpointAddress(EndpointUrl()));
    }
}
