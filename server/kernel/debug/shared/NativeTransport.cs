using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using OutSystems.DebuggerClient;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;
using ServiceStudio.ServerCommunications.API;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

// ODC sends hub events as typed payloads ($type) that the Studio binds with Newtonsoft; only payload types of the
// installed client assembly are ever instantiated, whatever the server names.
internal sealed class PayloadBinder : ISerializationBinder {
    static readonly Type Root = typeof(OutSystems.DebuggerClient.Payloads.DebuggerEvent);
    public Type BindToType(string? assemblyName, string typeName) {
        var type = Root.Assembly.GetType(typeName, false);
        if (type == null || type.Namespace != Root.Namespace) throw new DebugFailure("debug_event_type_rejected");
        return type;
    }
    public void BindToName(Type serializedType, out string? assemblyName, out string? typeName) { assemblyName = null; typeName = serializedType.FullName; }
}

// Owner-preserving breakpoint ids, as native Studio builds them: ExtendedBreakpointId(OwnerESpace.Key, node) for every
// enabled breakpoint of every module opened in the session's aggregator, serialized one by one into one start
// (.local/debugger/odc-library-breakpoint-contract/findings.json). One node has one owner: the explicit map, else the
// inspection scope naming it, else the session module where the lane does not require scope owners.
internal static class BreakpointOwners {
    internal static string Ids(Configuration configuration, bool scopesRequired, bool includeCompoundKey) {
        configuration.Inspection?.Validate();
        configuration.ValidateBreakpointOwners();
        var scopes = configuration.Inspection?.Scopes ?? [];
        var declared = configuration.NodeModuleKeys;
        return string.Join(',', configuration.NodeKeys.Select(node => {
            var owners = scopes.Where(scope => scope.NodeKey == node).Select(scope => scope.ModuleKey).Distinct().ToArray();
            // Never silently reinterpret a producer node as a node in the runtime entry.
            if (owners.Length > 1 || scopesRequired && scopes.Length > 0 && owners.Length == 0) throw new DebugFailure("debug_breakpoint_owner_required");
            string? owner = null;
            if (declared != null && (!declared.TryGetValue(node, out owner) || owners.Length == 1 && owners[0] != owner)) throw new DebugFailure("debug_breakpoint_owner_required");
            owner ??= owners.Length == 1 ? owners[0] : configuration.ModuleKey;
            return new BreakpointId(ObjectKey.Parse(owner), ObjectKey.Parse(node), "", "").ToString(includeCompoundKey);
        }));
    }
}

// Read-only reachability check run before the only ODC start attempt. Failure classes only, never native text.
internal sealed record PreflightDiagnostic(string Outcome, string Route, string? Failure, bool? Ipv4Answered, bool Ipv6OnlyFailure, bool Ipv6Disabled);

internal sealed class NativeTransport(Configuration config, Func<Configuration, (string User, string Secret)>? authenticate = null,
    Func<Uri, bool, TimeSpan, string?>? preflight = null) : IDebugTransport {
    public bool IsOfflineSynthetic => false;
    internal PreflightDiagnostic? Preflight { get; private set; }
    readonly RestDebuggerService api = new(config.RuntimeUrl.TrimEnd('/') + "/") { Timeout = TimeSpan.FromSeconds(8) };
    readonly ObjectKey key = ObjectKey.Parse(config.ModuleKey);
    string? sessionToken;
    HubConnection? hub;
    long eventId;
    bool stopAttempted;
    string? startState; // null, "attempted" (no answer yet), "failed" (server answered: no session exists)
    string startPhase = "not-started", stopPhase = "not-started";
    public DebugTransportDiagnostic Diagnostic => new(startPhase, stopPhase, sessionToken != null, startState ?? "not-attempted");
    public event Func<DebugTransportEvent, Task>? Received;
    public event Action<string>? Failed;
    // Only the platform message id survives: native error text can carry tokens or business data.
    internal static string MessageId(string? text) {
        try { if (text != null && text.TrimStart().StartsWith('{')) text = JsonDocument.Parse(text).RootElement.GetProperty("errors")[0].GetString(); }
        catch { return "unknown"; }
        if (text == null) return "unknown";
        if (text.StartsWith("ERROR: ", StringComparison.Ordinal)) text = text["ERROR: ".Length..];
        var id = text.Split('|')[0].Trim();
        return Regex.IsMatch(id, "^[A-Za-z0-9_]{1,80}$") ? id : "unknown";
    }
    static string MessageId(HttpWebResponse answer) {
        try { using var reader = new StreamReader(answer.GetResponseStream()); var body = new char[65536]; return MessageId(new string(body, 0, reader.Read(body, 0, body.Length))); }
        catch { return "unknown"; }
    }
    // A definite start failure means no server session can exist: the server answered with an error, or the request never reached it.
    // The native client re-throws a server error body as a bare WebException(message) without response or inner exception.
    internal static string? DefiniteFailure(WebException e) {
        if (e.Response is HttpWebResponse answer) return "debug_start_rejected:" + (int)answer.StatusCode + ":" + MessageId(answer);
        if (e.Status == WebExceptionStatus.UnknownError && e.Response == null && e.InnerException == null) return "debug_start_rejected:answered:" + MessageId(e.Message);
        if (e.Status is WebExceptionStatus.ConnectFailure or WebExceptionStatus.NameResolutionFailure or WebExceptionStatus.ProxyNameResolutionFailure or WebExceptionStatus.TrustFailure or WebExceptionStatus.SecureChannelFailure) return "debug_start_unreachable:" + e.Status;
        return null; // no answer: uncertain, never retried
    }
    // Sanitized class of a transport failure: socket code, HTTP request error or WebException status.
    internal static string FailureClass(Exception error) {
        string? socket = null, http = null, web = null;
        for (Exception? e = error; e != null; e = e.InnerException) {
            if (e is System.Net.Sockets.SocketException s) socket ??= s.SocketErrorCode.ToString();
            else if (e is HttpRequestException { HttpRequestError: not HttpRequestError.Unknown } h) http ??= h.HttpRequestError.ToString();
            else if (e is WebException { Status: not WebExceptionStatus.UnknownError } w) web ??= w.Status.ToString();
            else if (e is TimeoutException or TaskCanceledException) web ??= "Timeout";
        }
        var name = socket ?? http ?? web ?? "unknown";
        return Regex.IsMatch(name, "^[A-Za-z0-9_]{1,80}$") ? name : "unknown";
    }
    // GET of the runtime root: no credentials, no redirect, body discarded. Any HTTP status proves the origin
    // answered on this stack. ipv4Only is a diagnostic probe through IPv4 addresses only.
    internal static string? Probe(Uri root, bool ipv4Only, TimeSpan budget) {
        try {
            if (!ipv4Only) {
#pragma warning disable SYSLIB0014 // the native RestDebuggerService uses HttpWebRequest; the preflight must share its stack
                var request = (HttpWebRequest)WebRequest.Create(root);
#pragma warning restore SYSLIB0014
                request.Method = "GET"; request.AllowAutoRedirect = false; request.UseDefaultCredentials = false;
                request.Timeout = (int)Math.Max(1, budget.TotalMilliseconds);
                using var response = (HttpWebResponse)request.GetResponse();
                return null;
            }
            using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, ConnectCallback = async (context, token) => {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, System.Net.Sockets.AddressFamily.InterNetwork, token);
                var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp) { NoDelay = true };
                try { await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, token); return new System.Net.Sockets.NetworkStream(socket, true); }
                catch { socket.Dispose(); throw; }
            } };
            using var client = new System.Net.Http.HttpClient(handler) { Timeout = budget > TimeSpan.Zero ? budget : TimeSpan.FromMilliseconds(1) };
            using var answer = client.Send(new HttpRequestMessage(HttpMethod.Get, root), HttpCompletionOption.ResponseHeadersRead);
            return null;
        }
        catch (WebException e) when (e.Response is HttpWebResponse answered) { answered.Dispose(); return null; }
        catch (Exception e) { return FailureClass(e); }
    }
    static bool Ipv6Disabled() => Environment.GetEnvironmentVariable("DOTNET_SYSTEM_NET_DISABLEIPV6") is { } value &&
        (value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase));
    PreflightDiagnostic RunPreflight(TimeSpan budget) {
        var root = new Uri(config.RuntimeUrl.TrimEnd('/') + "/");
        var probe = preflight ?? Probe; var disabled = Ipv6Disabled();
        var failure = probe(root, false, budget);
        if (failure == null) return new("answered", "runtime-root-get", null, null, false, disabled);
        // Only an IPv6-enabled process can have an IPv6-only failure; the host may then relaunch one worker with a
        // process-scoped DOTNET_SYSTEM_NET_DISABLEIPV6=1. This process never retries or changes its own stack.
        bool? ipv4 = disabled ? null : probe(root, true, budget) == null;
        return new("failed", "runtime-root-get", failure, ipv4, ipv4 == true, disabled);
    }
    public async Task Start() {
        startPhase = "preparing";
        var breakpoints = BreakpointOwners.Ids(config, scopesRequired: false, includeCompoundKey: true);
        string user = "", password = "";
#if ODC
        _ = authenticate; // ODC authentication is supplied by the private API-client broker.
        if (string.IsNullOrWhiteSpace(config.Token)) throw new DebugFailure("debug_authentication_required");
        var appKey = ObjectKeyUtils.DatabaseValue(key);
#else
        (user, password) = authenticate != null ? authenticate(config) : O11Authentication.Login(config.Credentials, new Uri(config.RuntimeUrl), (name, secret) => config.AddPrivateValues(name, secret));
        var appKey = ObjectKeyUtils.DatabaseValue(key);
#endif
        config.AddPrivateValues(config.Token, user, password);
#if ODC
        // Native SDK default for a cold application's first debugger request. Only
        // startup gets this budget; Evaluate/control/cleanup retain their short bounds.
        var remaining = config.Deadline - DateTimeOffset.UtcNow;
        if (remaining is { } lifetime && lifetime <= TimeSpan.Zero) throw new DebugFailure("debug_session_expired");
        // 618c60ae: a reset on the default stack left an uncertain start. Probe the same origin on the same
        // HttpWebRequest stack first; a failure proves no start was sent (startState stays not-attempted).
        var preflightBudget = remaining is { } window && window < TimeSpan.FromSeconds(8) ? window : TimeSpan.FromSeconds(8);
        Preflight = await Task.Run(() => RunPreflight(preflightBudget));
        if (Preflight.Outcome != "answered") throw new DebugFailure("debug_start_unreachable:preflight");
        remaining = config.Deadline - DateTimeOffset.UtcNow;
        if (remaining is { } left && left <= TimeSpan.Zero) throw new DebugFailure("debug_session_expired");
        api.Timeout = remaining is { } bounded && bounded < RestDebuggerService.DefaultTimeout ? bounded : RestDebuggerService.DefaultTimeout;
#endif
        // One start attempt. No answer is uncertain; never retry or adopt another session.
        startState = "attempted";
        startPhase = "rest-start";
        string result;
        try { result = await Task.Run(() => api.StartDebugSession(config.Token ?? "", appKey, user, password, false, breakpoints)); }
        catch (WebException e) when (DefiniteFailure(e) is { } code) { startState = "failed"; throw new DebugFailure(code); }
        finally { api.Timeout = TimeSpan.FromSeconds(8); }
        if (!Guid.TryParse(result, out _)) { startState = "failed"; throw new DebugFailure("debug_start_rejected:200:" + MessageId(result)); }
        sessionToken = result;
        startState = "accepted";
        config.AddPrivateValues(sessionToken);
        startPhase = "hub-configure";
        var endpoint = config.RuntimeUrl.TrimEnd('/') + "/" + DebuggerApiRoutes.BaseRoute + "/" + DebuggerApiRoutes.EventsHub + "?eSpaceUID=" + Uri.EscapeDataString(config.ModuleKey) + "&lastEventReceived=0";
        var builder = new HubConnectionBuilder().WithUrl(endpoint, options => {
            options.Headers["OutSystems-dbg-session-token"] = sessionToken;
            options.Headers[DebuggerEventsHubInfo.LastEventReceivedHeaderName] = "0";
            options.Headers[DebuggerEventsHubInfo.IsReconnectHeaderName] = "False";
            if (!string.IsNullOrEmpty(config.Token)) options.AccessTokenProvider = () => Task.FromResult<string?>(config.Token);
        });
#if ODC
        // Same wire contract as ODC Studio: typed Newtonsoft payloads converted by the installed DebuggerPayloadExtensions.
        hub = builder.AddNewtonsoftJsonProtocol(o => { o.PayloadSerializerSettings.TypeNameHandling = TypeNameHandling.Auto; o.PayloadSerializerSettings.SerializationBinder = new PayloadBinder(); }).Build();
        hub.On<OutSystems.DebuggerClient.Payloads.DebuggerEvent>(DebuggerEventsHubInfo.ReceiveEventMethodName, async payload => {
            try {
                var evt = payload.ConvertToPluginApiEvent(key, false, sessionToken, out var id);
                if (evt == null) throw new DebugFailure("debug_event_decode_failed");
                eventId = id;
                if (Received != null) await Received(DebugTransportEvent.FromTyped(evt, payload));
            } catch { Failed?.Invoke("debug_event_decode_failed"); }
        });
#else
        hub = builder.Build();
        hub.On<string>(DebuggerEventsHubInfo.ReceiveEventMethodName, async data => {
            try {
                if (data.Length > 1048576) throw new DebugFailure("debug_event_too_large");
                var provenance = DebugTransportEvent.ReadXmlRequestId(data);
                var evt = ServerDebuggerEventFactory.Create(config.Module, key, data, false, sessionToken, out var reconnect, out _, out eventId);
                if (reconnect) { Failed?.Invoke("debug_reconnect_requires_new_session"); return; }
                if (evt != null && Received != null) await Received(DebugTransportEvent.FromXml(evt, provenance));
            } catch { Failed?.Invoke("debug_event_decode_failed"); }
        });
#endif
        hub.Closed += _ => { if (!stopAttempted) Failed?.Invoke("debug_connection_closed"); return Task.CompletedTask; };
        startPhase = "hub-connect";
        var hubBudget = TimeSpan.FromSeconds(10);
#if ODC
        if (config.Deadline is { } deadline && deadline - DateTimeOffset.UtcNow < hubBudget) hubBudget = deadline - DateTimeOffset.UtcNow;
        if (hubBudget <= TimeSpan.Zero) throw new DebugFailure("debug_session_expired");
#endif
        using var hubDeadline = new CancellationTokenSource(hubBudget);
        await hub.StartAsync(hubDeadline.Token);
        startPhase = "connected";
    }
    public string Evaluate(string thread, string request) {
        // A capture must not hold a business request for the full control-call timeout.
        api.Timeout = config.EvaluationTimeout;
        try {
#if ODC
        return api.Evaluate(config.Token!, sessionToken!, thread, request);
#else
        return api.Evaluate(sessionToken!, thread, request);
#endif
        } finally { api.Timeout = TimeSpan.FromSeconds(8); }
    }
    public void Execute(string op, string thread) {
        var result = op switch {
#if ODC
            "pause" => api.SuspendAllThreads(config.Token!, sessionToken!),
            "continue" => api.ContinueThread(config.Token!, sessionToken!, thread),
            "step-over" => api.StepOver(config.Token!, sessionToken!, thread),
            "step-into" => api.StepInto(config.Token!, sessionToken!, thread),
            "step-out" => api.StepOut(config.Token!, sessionToken!, thread),
#else
            "pause" => api.SuspendAllThreads(sessionToken!),
            "continue" => api.ContinueThread(sessionToken!, thread),
            "step-over" => api.StepOver(sessionToken!, thread),
            "step-into" => api.StepInto(sessionToken!, thread),
            "step-out" => api.StepOut(sessionToken!, thread),
#endif
            _ => throw new DebugFailure("debug_unknown_operation")
        };
        if (result?.StartsWith("ERROR:", StringComparison.Ordinal) == true) throw new DebugFailure("debug_execution_rejected");
    }
    public async Task Stop() {
        if (stopAttempted) return;
        stopAttempted = true;
        try {
            if (startState == "attempted" && sessionToken == null) { stopPhase = "no-session-token"; throw new DebugFailure("debug_start_uncertain"); }
            if (sessionToken != null) {
                stopPhase = "rest-stop";
                await Task.Run(() => {
#if ODC
                api.StopDebugSession(config.Token!, sessionToken, false);
#else
                api.StopDebugSession(sessionToken, false);
#endif
                });
            }
            stopPhase = "completed";
        } finally {
            if (hub != null) {
                // A successful REST stop and failed local hub disposal remain distinguishable.
                var completed = stopPhase == "completed";
                if (completed) stopPhase = "hub-dispose";
                await hub.DisposeAsync();
                if (completed) stopPhase = "completed";
            }
        }
    }
    public async ValueTask DisposeAsync() {
        await Stop();
#if !ODC
        api.Dispose();
#endif
    }
}
