using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Collections.Concurrent;
internal static class NativeFixture {
#if ODC
    // Typed hub payloads ($type + JsonProperty names of the installed OutSystems.DebuggerClient.Payloads), decoded as
    // NativeTransport does: PayloadBinder, then DebuggerPayloadExtensions.ConvertToPluginApiEvent. Synthetic values.
    internal static string OdcEventJson(string type, string threadId, long eventId, string? requestId, string? node = null, string? lastBreakpoint = null, bool longLived = true) =>
        JsonSerializer.Serialize(new Dictionary<string, object?> {
            ["$type"] = "OutSystems.DebuggerClient.Payloads." + type + ", OutSystems.DebuggerClient",
            ["threadId"] = threadId, ["eventId"] = eventId, ["requestId"] = requestId, ["threadName"] = "Timer",
            ["isLongLivedRequest"] = longLived, ["inPTA"] = false, ["clientThreadId"] = 7,
            ["breakpointType"] = node == null ? null : "Normal", ["username"] = type == "ThreadEndEvent" ? "PRIVATE-USER" : null,
            ["lastBreakpoint"] = lastBreakpoint, ["lastCommand"] = type == "ThreadEndEvent" ? "ContinueThread" : null,
            ["stack"] = node == null ? null : new { stackElem = new { eSpaceName = "Fixture", functionName = "Timer", functionType = "ServerAction",
                functionId = Tests.ModuleKey + ":" + Tests.NodeKey + "::", breakpoint = Tests.ModuleKey + ":" + node + "::", breakpointType = "Normal" } }
        }.Where(kv => kv.Value != null).ToDictionary());
    internal static DebugTransportEvent OdcEnvelope(string json) {
        var payload = Newtonsoft.Json.JsonConvert.DeserializeObject<OutSystems.DebuggerClient.Payloads.DebuggerEvent>(json, new Newtonsoft.Json.JsonSerializerSettings {
            TypeNameHandling = Newtonsoft.Json.TypeNameHandling.Auto, SerializationBinder = new PayloadBinder() })!;
        var evt = ServiceStudio.ServerCommunications.API.DebuggerPayloadExtensions.ConvertToPluginApiEvent(payload,
            OutSystems.ObjectKeys.ObjectKey.Parse(Tests.ModuleKey), false, "PRIVATE-SESSION", out _);
        return DebugTransportEvent.FromTyped(evt, payload);
    }
#endif
    internal static async Task Run(bool slowEvaluation = false, bool rejectStart = false) {
        var reservation = new TcpListener(IPAddress.Loopback, 0); reservation.Start();
        var port = ((IPEndPoint)reservation.LocalEndpoint).Port; reservation.Stop();
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var requests = new ConcurrentQueue<(string Route, string Body)>();
        var eventSeen = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var fixtureToken = "00000000-0000-0000-0000-000000000001";
        var server = Task.Run(async () => {
            while (!cancel.IsCancellationRequested) {
                HttpListenerContext c;
                try { c = await listener.GetContextAsync().WaitAsync(cancel.Token); } catch { break; }
                var route = c.Request.Url!.AbsolutePath;
                if (c.Request.IsWebSocketRequest) {
                    Tests.Check(c.Request.Headers["OutSystems-dbg-session-token"] == fixtureToken, "private session header");
                    var ws = (await c.AcceptWebSocketAsync(null)).WebSocket;
                    _ = Task.Run(async () => {
                        try {
                            var buffer = new byte[4096]; await ws.ReceiveAsync(buffer, cancel.Token);
                            await ws.SendAsync(Encoding.UTF8.GetBytes("{}\u001e"), WebSocketMessageType.Text, true, cancel.Token);
#if ODC
                            // ODC hub contract: typed Newtonsoft payload with $type, converted by the installed DebuggerPayloadExtensions.
                            object argument = new Dictionary<string, object?> {
                                ["$type"] = "OutSystems.DebuggerClient.Payloads.AtBreakpointEvent, OutSystems.DebuggerClient",
                                ["threadId"] = "T1", ["eventId"] = 42, ["requestId"] = "R1", ["threadName"] = "Test", ["breakpointType"] = "Normal",
                                ["isLongLivedRequest"] = false, ["inPTA"] = false, ["clientThreadId"] = 0,
                                ["stack"] = new { stackElem = new { eSpaceName = "Fixture", functionName = "Callback", functionType = "ServerAction", breakpoint = Tests.ModuleKey + ":" + Tests.NodeKey + "::", breakpointType = "Normal" } }
                            };
#else
                            object argument = "<AtBreakpointEvent threadId=\"T1\" eventId=\"42\" requestId=\"R1\" threadName=\"Test\" breakpointType=\"Normal\" isLongLivedRequest=\"false\" inPTA=\"false\"/>";
#endif
                            var message = JsonSerializer.Serialize(new { type = 1, target = "ReceiveEvent", arguments = new[] { argument } }) + '\u001e';
                            await ws.SendAsync(Encoding.UTF8.GetBytes(message), WebSocketMessageType.Text, true, cancel.Token);
                            while (!cancel.IsCancellationRequested) { var received = await ws.ReceiveAsync(buffer, cancel.Token); if (received.MessageType == WebSocketMessageType.Close) break; }
                        } catch (OperationCanceledException) { } catch (WebSocketException) { } finally { ws.Dispose(); }
                    }); continue;
                }
                var body = await new StreamReader(c.Request.InputStream).ReadToEndAsync(); requests.Enqueue((route, body));
                if (rejectStart && route.EndsWith("startsession")) {
                    c.Response.StatusCode = 403; c.Response.ContentType = "application/json";
                    await c.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("{\"errors\":[\"ERROR: Debugger_ConsumerNoDebugPermission|Bearer SECRET-TOKEN\"],\"statusCode\":403}")); c.Response.Close(); continue;
                }
                if (slowEvaluation && route.EndsWith("evaluate")) await Task.Delay(3000, cancel.Token);
                object value = route.EndsWith("negotiate")
                    ? new { negotiateVersion = 1, connectionId = "fixture", connectionToken = "fixture", availableTransports = new[] { new { transport = "WebSockets", transferFormats = new[] { "Text", "Binary" } } } }
                    : route.EndsWith("stopsession") ? new { Result = true }
                    : new { Result = route.EndsWith("startsession") ? fixtureToken : route.EndsWith("evaluate") ? "<vars><local name=\"Response\"><Integer name=\"StatusCode\" value=\"400\"/></local></vars>" : "" };
                try { c.Response.ContentType = "application/json"; await c.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value))); c.Response.Close(); }
                catch (HttpListenerException) when (slowEvaluation) { /* The bounded client already closed this request. */ }
            }
        });
        var config = new Configuration { Module = "Fixture", ModuleKey = Tests.ModuleKey, RuntimeUrl = $"http://127.0.0.1:{port}/App/", NodeKeys = [Tests.NodeKey], Token = "TEST_AUTH" };
        config.Redactor = new DebugPolicy.PrivateValues();
        await using var transport = new NativeTransport(config, _ => ("TEST_USER", "TEST_PASSWORD"));
        transport.Received += e => { if (e.NativeEvent.ThreadData?.ThreadId == "T1" && e.NativeEvent.EventId == 42) {
#if ODC
            Tests.Check(e.RawRequestIdPresent && !e.RequestIdIsFallback && e.RawRequestId == "R1", "native ODC typed payload preserves original requestId");
#else
            Tests.Check(e.RawRequestIdPresent && !e.RequestIdIsFallback && e.RawRequestId == "R1", "native REST XML preserves original requestId");
#endif
            eventSeen.TrySetResult(true); } return Task.CompletedTask; };
        transport.Failed += code => eventSeen.TrySetException(new Exception(code));
        try {
            if (rejectStart) {
                // A server answer is a definite failure: sanitized code, no uncertainty, no stop call, no retry.
                try { await transport.Start(); throw new Exception("rejected start accepted"); }
                catch (DebugFailure failure) { Tests.Check(failure.Message is "debug_start_rejected:403:Debugger_ConsumerNoDebugPermission" or "debug_start_rejected:answered:Debugger_ConsumerNoDebugPermission", "rejected start code: " + failure.Message); }
                await transport.Stop();
                Tests.Check(requests.Count(r => r.Route.EndsWith("startsession")) == 1 && !requests.Any(r => r.Route.EndsWith("stopsession")), "rejected start must not retry or stop");
                return;
            }
            await transport.Start(); await eventSeen.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Tests.Check(config.Redactor.Contains("TEST_AUTH") && config.Redactor.Contains(fixtureToken), "native authentication/session tokens registered privately");
#if !ODC
            Tests.Check(config.Redactor.Contains("TEST_USER") && config.Redactor.Contains("TEST_PASSWORD"), "legacy developer authentication registered privately");
#endif
            if (slowEvaluation) {
                var watch = System.Diagnostics.Stopwatch.StartNew(); bool timedOut = false;
                try { transport.Evaluate("T1", Variables.Request(2, 1, ["Response"])); }
                catch { timedOut = true; }
                Tests.Check(timedOut && watch.Elapsed.TotalSeconds < 2.8, "native capture timeout must bound a slow evaluation");
            } else {
                var values = Variables.Read(transport.Evaluate("T1", Variables.Request(2, 1, ["Response"])));
                Tests.Check(JsonSerializer.Serialize(values).Contains("400"), "native evaluate response");
            }
            transport.Execute("continue", "T1"); await transport.Stop();
            var start = JsonDocument.Parse(requests.Single(r => r.Route.EndsWith("startsession")).Body).RootElement;
            Tests.Check(start.GetProperty("breakpointId").GetString() == Tests.ModuleKey + ":" + Tests.NodeKey + "::", "exact native breakpoint set");
            Tests.Check(!start.GetProperty("breakOnAllErrors").GetBoolean(), "unrequested exception breakpoints");
            Tests.Check(requests.Count(r => r.Route.EndsWith("stopsession")) == 1, "native stop exactly once");
        } finally { cancel.Cancel(); listener.Stop(); await server; config.Redactor.Clear(); }
    }
}
