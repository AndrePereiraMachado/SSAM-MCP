#if !ODC
using System.Net;
using System.Text;
using System.Xml.Linq;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;

// Offline reproduction of the Service Studio 11 debug protocol: a loopback HTTP server that answers the SOAP
// _debugger.asmx operations (StartDebugSession/Evaluate/ContinueThread/StepOver/StopDebugSession) and streams the
// polled _debuggerEvents.ashx event feed ("<AtBreakpointEvent .../>" followed by a "<end/>" line). It drives the
// real SoapTransport against the installed native SOAP client and ServerDebuggerEventFactory. No live environment.
internal static class O11SoapFixture
{
    internal static void CheckFailureClassification()
    {
        Tests.Check(SoapTransport.DefiniteStartFailure(new System.ServiceModel.EndpointNotFoundException("SECRET")) == "debug_start_unreachable:EndpointNotFound", "SOAP unreachable is definite and sanitized");
        Tests.Check(SoapTransport.DefiniteStartFailure(new System.ServiceModel.FaultException("SECRET")) == "debug_start_rejected:fault", "SOAP fault is definite and sanitized");
        Tests.Check(SoapTransport.DefiniteStartFailure(new HttpRequestException("SECRET", null, HttpStatusCode.Forbidden)) == "debug_start_rejected:403:unknown", "SOAP HTTP refusal is definite and sanitized");
        Tests.Check(SoapTransport.DefiniteStartFailure(new System.Net.Sockets.SocketException((int)System.Net.Sockets.SocketError.ConnectionRefused)) == "debug_start_unreachable:Socket", "pre-connection socket refusal is definite");
        foreach (var error in new Exception[] {
            new TimeoutException("SECRET"), new System.ServiceModel.CommunicationException("SECRET"),
            new System.Net.Sockets.SocketException((int)System.Net.Sockets.SocketError.ConnectionReset),
            new System.Net.Sockets.SocketException((int)System.Net.Sockets.SocketError.TimedOut)
        }) Tests.Check(SoapTransport.DefiniteStartFailure(error) == null, "unanswered/reset SOAP start remains uncertain");
    }

    internal static async Task Run(bool slowEvaluation = false, bool rejectStart = false, bool bearer = false, bool missingRawRequestId = false)
    {
        var reservation = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        reservation.Start();
        var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
        reservation.Stop();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        var soapCalls = new System.Collections.Concurrent.ConcurrentQueue<string>();        // op local name
        var requests = new System.Collections.Concurrent.ConcurrentQueue<(string Path, string Operation, string? Authorization, string[] Values)>();
        var eventRequests = new System.Collections.Concurrent.ConcurrentQueue<(string Path, string? Session, string? Module, string? Last, string? Authorization)>();
        var pollProgress = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? startBreakpoints = null, startEspaceUid = null, startBreakOnAll = null;
        var token = "11111111-1111-1111-1111-111111111111";
        var varsXml = "<vars><local name=\"Response\"><Integer name=\"StatusCode\" value=\"400\"/></local></vars>";
        var breakpointEvent = "<AtBreakpointEvent threadId=\"T1\" eventId=\"42\" requestId=\"R1\" threadName=\"Test\" breakpointType=\"Normal\" isLongLivedRequest=\"false\" inPTA=\"false\"/>";
        if (missingRawRequestId) breakpointEvent = breakpointEvent.Replace(" requestId=\"R1\"", "");

        var server = Task.Run(async () =>
        {
            while (!cancel.IsCancellationRequested)
            {
                HttpListenerContext c;
                try { c = await listener.GetContextAsync().WaitAsync(cancel.Token); } catch { break; }
                _ = Task.Run(async () =>
                {
                    try
                    {
                        var path = c.Request.Url!.AbsolutePath;
                        if (path.EndsWith("_debuggerEvents.ashx"))
                        {
                            eventRequests.Enqueue((path, c.Request.QueryString["debugSessionToken"], c.Request.QueryString["eSpaceUID"], c.Request.QueryString["lastEventReceived"], c.Request.Headers["Authorization"]));
                            var last = long.TryParse(c.Request.QueryString["lastEventReceived"], out var l) ? l : 0;
                            if (last == 42) pollProgress.TrySetResult(true);
                            c.Response.ContentType = "text/plain; charset=utf-8";
                            c.Response.SendChunked = true;
                            if (last < 42)
                            {
                                var payload = Encoding.UTF8.GetBytes(breakpointEvent + "\n<end/>\n");
                                await c.Response.OutputStream.WriteAsync(payload, cancel.Token);
                                await c.Response.OutputStream.FlushAsync(cancel.Token);
                            }
                            c.Response.Close();
                            return;
                        }
                        // SOAP _debugger.asmx
                        var body = await new StreamReader(c.Request.InputStream).ReadToEndAsync(cancel.Token);
                        var root = XDocument.Parse(body).Root!.Descendants().First(e => e.Name.LocalName.EndsWith("Body")).Elements().First();
                        var op = root.Name.LocalName;
                        soapCalls.Enqueue(op);
                        requests.Enqueue((path, op, c.Request.Headers["Authorization"], root.Elements().Select(e => e.Value).ToArray()));
                        string Child(string n) => root.Elements().FirstOrDefault(e => e.Name.LocalName == n)?.Value ?? "";
                        if (op == "StartDebugSession")
                        {
                            startEspaceUid = Child("eSpaceUID"); startBreakOnAll = Child("breakOnAllErrors"); startBreakpoints = Child("breakpointsIds");
                            if (rejectStart)
                            {
                                Reply(c, Soap("<StartDebugSessionResponse xmlns=\"http://tempuri.org/\"><StartDebugSessionResult>" +
                                    "ERROR: Debugger_ConsumerNoDebugPermission|Bearer SECRET-TOKEN</StartDebugSessionResult></StartDebugSessionResponse>"));
                                return;
                            }
                            Reply(c, Soap("<StartDebugSessionResponse xmlns=\"http://tempuri.org/\"><StartDebugSessionResult>" + token + "</StartDebugSessionResult></StartDebugSessionResponse>"));
                        }
                        else if (op == "Evaluate")
                        {
                            if (slowEvaluation) await Task.Delay(3000, cancel.Token);
                            Reply(c, Soap("<EvaluateResponse xmlns=\"http://tempuri.org/\"><EvaluateResult>" + Escape(varsXml) + "</EvaluateResult></EvaluateResponse>"));
                        }
                        else if (op == "ContinueThread")
                            Reply(c, Soap("<ContinueThreadResponse xmlns=\"http://tempuri.org/\"><ContinueThreadResult></ContinueThreadResult></ContinueThreadResponse>"));
                        else if (op == "StepOver" || op == "StepInto" || op == "StepOut")
                            Reply(c, Soap("<" + op + "Response xmlns=\"http://tempuri.org/\"><" + op + "Result></" + op + "Result></" + op + "Response>"));
                        else if (op == "StopDebugSession")
                            Reply(c, Soap("<StopDebugSessionResponse xmlns=\"http://tempuri.org/\"/>"));
                        else
                            Reply(c, Soap("<" + op + "Response xmlns=\"http://tempuri.org/\"/>"));
                    }
                    catch (HttpListenerException) when (slowEvaluation) { }
                    catch (OperationCanceledException) { }
                    catch { try { c.Response.Abort(); } catch { } }
                });
            }
        });

        var config = new Configuration
        {
            Module = "Fixture",
            ModuleKey = Tests.ModuleKey,
            RuntimeUrl = $"http://127.0.0.1:{port}/App/",
            NodeKeys = [Tests.NodeKey],
            Token = bearer ? token : null,
            SoapUser = bearer ? "TEST_SSO_USER" : null,
            SoapSecret = bearer ? "TEST_SSO_ID_TOKEN" : null,
        };
        config.Redactor = new DebugPolicy.PrivateValues();
        var eventSeen = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var chosen = TransportFactory.Create(config);
        Tests.Check(chosen is SoapTransport, "O11 lane must choose SOAP, preserving shared trace/session behavior");
        var authenticationCalls = 0;
        await using var transport = new SoapTransport(config, _ => { authenticationCalls++; return ("TEST_USER", "TEST_PASSWORD"); });
        transport.Received += e => { if (e.NativeEvent.ThreadData?.ThreadId == "T1" && e.NativeEvent.EventId == 42) {
            Tests.Check(e.RawRequestIdPresent == !missingRawRequestId && e.RequestIdIsFallback == missingRawRequestId && e.RawRequestId == (missingRawRequestId ? null : "R1"), "SOAP original requestId presence survives native conversion");
            if (missingRawRequestId) Tests.Check(((ServiceStudio.ServerCommunications.API.ServerThreadData)e.NativeEvent.ThreadData).RequestId == "T1", "native RequestId fallback exists but is never raw evidence");
            eventSeen.TrySetResult(true); } return Task.CompletedTask; };
        transport.Failed += code => eventSeen.TrySetException(new Exception(code));
        try
        {
            if (rejectStart)
            {
                try { await transport.Start(); throw new Exception("rejected start accepted"); }
                catch (DebugFailure failure) { Tests.Check(failure.Message == "debug_start_rejected:answered:Debugger_ConsumerNoDebugPermission", "rejected start code: " + failure.Message); }
                try { await transport.Start(); throw new Exception("rejected start retried"); }
                catch (DebugFailure failure) { Tests.Check(failure.Message == "debug_start_already_attempted", "rejected start cannot replay"); }
                await transport.Stop();
                Tests.Check(soapCalls.Count(o => o == "StartDebugSession") == 1 && !soapCalls.Contains("StopDebugSession"), "rejected start must not retry or stop");
                return;
            }
            await transport.Start();
            Tests.Check(config.Redactor.Contains(token) && config.Redactor.Contains(bearer ? "TEST_SSO_USER" : "TEST_USER") &&
                config.Redactor.Contains(bearer ? "TEST_SSO_ID_TOKEN" : "TEST_PASSWORD"), "native SOAP authentication/session values registered privately");
            await eventSeen.Task.WaitAsync(TimeSpan.FromSeconds(6));
            await pollProgress.Task.WaitAsync(TimeSpan.FromSeconds(4));
            Tests.Check(startBreakpoints == Tests.ModuleKey + ":" + Tests.NodeKey + "::", "exact native breakpoint set: " + startBreakpoints);
            Tests.Check(startBreakOnAll == "false", "unrequested exception breakpoints");
            Tests.Check(startEspaceUid == ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(Tests.ModuleKey)), "StartDebugSession eSpaceUID is the module DatabaseValue");
            Tests.Check(authenticationCalls == (bearer ? 0 : 1), "bearer path must not request developer credentials");
            var startRequest = requests.Single(r => r.Operation == "StartDebugSession");
            Tests.Check(startRequest.Path == "/Fixture/_debugger.asmx", "SOAP endpoint belongs to the configured entry/target module");
            Tests.Check(startRequest.Authorization == (bearer ? "Bearer " + token : null), "bearer header only on the SSO token path");
            Tests.Check(bearer ? !startRequest.Values.Contains("TEST_PASSWORD") && !startRequest.Values.Contains("TEST_USER") : startRequest.Values.Contains("TEST_USER") && startRequest.Values.Contains("TEST_PASSWORD"), "bearer and developer authentication are separate");
            Tests.Check(bearer ? startRequest.Values.Contains("TEST_SSO_USER") && startRequest.Values.Contains("TEST_SSO_ID_TOKEN") : !startRequest.Values.Contains("TEST_SSO_ID_TOKEN"), "native SSO body contains its username and distinct server-call ID token");
            Tests.Check(eventRequests.All(r => r.Path == "/Fixture/_debuggerEvents.ashx" && r.Session == token && r.Module == Tests.ModuleKey && r.Authorization == null), "native polling has its session/module identity and no developer bearer");
            Tests.Check(eventRequests.Any(r => r.Last == "0") && eventRequests.Any(r => r.Last == "42"), "polling resumes with the exact event cursor");
            try { await transport.Start(); throw new Exception("successful start retried"); }
            catch (DebugFailure failure) { Tests.Check(failure.Message == "debug_start_already_attempted", "successful start cannot replay"); }
            if (slowEvaluation)
            {
                var watch = System.Diagnostics.Stopwatch.StartNew();
                var timedOut = false;
                try { transport.Evaluate("T1", Variables.Request(2, 1, ["Response"])); } catch { timedOut = true; }
                Tests.Check(timedOut && watch.Elapsed.TotalSeconds < 2.8, "native capture timeout must bound a slow evaluation");
            }
            else
            {
                var values = System.Text.Json.JsonSerializer.Serialize(Variables.Read(transport.Evaluate("T1", Variables.Request(2, 1, ["Response"]))));
                Tests.Check(values.Contains("400"), "native evaluate response");
            }
            transport.Execute("continue", "T1");
            transport.Execute("step-over", "T1");
            transport.Execute("step-into", "T1");
            transport.Execute("step-out", "T1");
            await transport.Stop();
            await transport.Stop();
            Tests.Check(soapCalls.Count(o => o == "StartDebugSession") == 1, "exactly one start");
            Tests.Check(soapCalls.Count(o => o == "StopDebugSession") == 1, "native stop exactly once");
            Tests.Check(new[] { "ContinueThread", "StepOver", "StepInto", "StepOut" }.All(op => soapCalls.Count(o => o == op) == 1), "all native control operations use SOAP once");
            Tests.Check(requests.Where(r => r.Operation != "StartDebugSession").All(r => r.Authorization == null && r.Values.Contains(token) && !r.Values.Contains("TEST_PASSWORD") && !r.Values.Contains("TEST_USER") && !r.Values.Contains("TEST_SSO_ID_TOKEN") && !r.Values.Contains("TEST_SSO_USER")), "controls authenticate only with debug session token");
        }
        finally { cancel.Cancel(); listener.Stop(); try { await server; } catch { } config.Redactor.Clear(); }
    }

    static string Soap(string body) =>
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>" + body + "</s:Body></s:Envelope>";

    static void Reply(HttpListenerContext c, string xml)
    {
        var bytes = Encoding.UTF8.GetBytes(xml);
        c.Response.ContentType = "text/xml; charset=utf-8";
        c.Response.ContentLength64 = bytes.Length;
        c.Response.OutputStream.Write(bytes, 0, bytes.Length);
        c.Response.Close();
    }

    static string Escape(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
}
#endif
