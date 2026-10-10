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

internal sealed class NativeTransport(Configuration config, Func<Configuration, (string User, string Secret)>? authenticate = null) : IDebugTransport {
    public bool IsOfflineSynthetic => false;
    readonly RestDebuggerService api = new(config.RuntimeUrl.TrimEnd('/') + "/") { Timeout = TimeSpan.FromSeconds(8) };
    readonly ObjectKey key = ObjectKey.Parse(config.ModuleKey);
    string? sessionToken;
    HubConnection? hub;
    long eventId;
    bool stopAttempted;
    string? startState; // null, "attempted" (no answer yet), "failed" (server answered: no session exists)
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
    public async Task Start() {
        var breakpoints = string.Join(',', config.NodeKeys.Select(n => new BreakpointId(key, ObjectKey.Parse(n), "", "").ToString(true)));
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
        // One start attempt. No answer is uncertain; never retry or adopt another session.
        startState = "attempted";
        string result;
        try { result = await Task.Run(() => api.StartDebugSession(config.Token ?? "", appKey, user, password, false, breakpoints)); }
        catch (WebException e) when (DefiniteFailure(e) is { } code) { startState = "failed"; throw new DebugFailure(code); }
        if (!Guid.TryParse(result, out _)) { startState = "failed"; throw new DebugFailure("debug_start_rejected:200:" + MessageId(result)); }
        sessionToken = result;
        config.AddPrivateValues(sessionToken);
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
                if (Received != null) await Received(DebugTransportEvent.WithoutProvenance(evt));
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
        await hub.StartAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);
    }
    public string Evaluate(string thread, string request) {
        // A capture must not hold a business request for the full control-call timeout.
        api.Timeout = TimeSpan.FromSeconds(Math.Min(config.PauseSeconds, 2));
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
            "continue" => api.ContinueThread(config.Token!, sessionToken!, thread),
            "step-over" => api.StepOver(config.Token!, sessionToken!, thread),
            "step-into" => api.StepInto(config.Token!, sessionToken!, thread),
            "step-out" => api.StepOut(config.Token!, sessionToken!, thread),
#else
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
            if (startState == "attempted" && sessionToken == null) throw new DebugFailure("debug_start_uncertain");
            if (sessionToken != null) await Task.Run(() => {
#if ODC
                api.StopDebugSession(config.Token!, sessionToken, false);
#else
                api.StopDebugSession(sessionToken, false);
#endif
            });
        } finally { if (hub != null) await hub.DisposeAsync(); }
    }
    public async ValueTask DisposeAsync() {
        await Stop();
#if !ODC
        api.Dispose();
#endif
    }
}
