using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
// ODC start preflight (618c60ae class): a read-only GET of the runtime root on the same HttpWebRequest stack runs
// before StartDebugSession. A transport failure there proves no start was sent: startState stays not-attempted.
internal static class TransportPreflightTests {
#if ODC
    sealed class Loopback : IAsyncDisposable {
        readonly HttpListener listener = new(); readonly CancellationTokenSource cancel = new(TimeSpan.FromSeconds(15)); readonly Task server;
        internal readonly ConcurrentQueue<(string Method, string Route, string Body, bool Authorized)> Requests = new();
        internal readonly string Url;
        internal Loopback(Func<HttpListenerContext, string, Task> handle) {
            var reservation = new TcpListener(IPAddress.Loopback, 0); reservation.Start();
            var port = ((IPEndPoint)reservation.LocalEndpoint).Port; reservation.Stop();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start(); Url = $"http://127.0.0.1:{port}/App/";
            server = Task.Run(async () => {
                while (!cancel.IsCancellationRequested) {
                    HttpListenerContext c;
                    try { c = await listener.GetContextAsync().WaitAsync(cancel.Token); } catch { break; }
                    var route = c.Request.Url!.AbsolutePath; var body = await new StreamReader(c.Request.InputStream).ReadToEndAsync();
                    Requests.Enqueue((c.Request.HttpMethod, route, body, c.Request.Headers["Authorization"] != null || c.Request.Headers["OutSystems-dbg-session-token"] != null));
                    try { await handle(c, route); } catch (HttpListenerException) { }
                }
            });
        }
        public async ValueTask DisposeAsync() { cancel.Cancel(); listener.Stop(); try { await server; } catch { } listener.Close(); }
    }
    static Configuration Config(string url) => new() { Module = "Fixture", ModuleKey = Tests.ModuleKey, RuntimeUrl = url, NodeKeys = [Tests.NodeKey], Token = "TEST_AUTH",
        Redactor = new DebugPolicy.PrivateValues() };
    static async Task Json(HttpListenerContext c, int status, object value) {
        c.Response.StatusCode = status; c.Response.ContentType = "application/json";
        await c.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value))); c.Response.Close();
    }
    static async Task<DebugFailure> StartFails(NativeTransport transport) {
        try { await transport.Start(); throw new Exception("start accepted"); } catch (DebugFailure failure) { return failure; }
    }
    internal static async Task Run() {
        // 1. Connection reset on the preflight route: StartDebugSession is never sent, nothing remote to stop.
        await using (var reset = new Loopback(async (c, route) => {
            if (c.Request.HttpMethod == "GET") { c.Response.Abort(); return; }
            await Json(c, 200, new { Result = "00000000-0000-0000-0000-000000000001" });
        })) {
            var config = Config(reset.Url); var transport = new NativeTransport(config);
            var failure = await StartFails(transport);
            Tests.Check(failure.Message == "debug_start_unreachable:preflight", "preflight failure code: " + failure.Message);
            Tests.Check(transport.Diagnostic.StartOutcome == "not-attempted" && !transport.Diagnostic.TokenObtained, "preflight failure claimed an attempted start");
            Tests.Check(!reset.Requests.Any(r => r.Route.EndsWith("startsession")), "StartDebugSession sent after a failed preflight");
            Tests.Check(reset.Requests.All(r => r.Method == "GET" && r.Route == "/App/" && !r.Authorized), "preflight was not a credential-free GET of the runtime root");
            Tests.Check(transport.Preflight is { Outcome: "failed", Route: "runtime-root-get" } && transport.Preflight.Failure != null, "preflight failure not recorded");
            await transport.Stop(); // definite: no session can exist, so no stop call and no uncertainty
            Tests.Check(transport.Diagnostic.StopPhase == "completed" && !reset.Requests.Any(r => r.Route.EndsWith("stopsession")), "not-attempted start made a remote stop");
        }
        // 2. Any HTTP answer passes the preflight (404 here); the single start attempt follows, carrying both owners.
        const string library = "AwMDAwMDAwMDAwMDAwMDAw", libraryNode = "BAQEBAQEBAQEBAQEBAQEBA";
        await using (var answered = new Loopback(async (c, route) => {
            if (c.Request.HttpMethod == "GET") { await Json(c, 404, new { }); return; }
            await Json(c, 403, new { errors = new[] { "ERROR: Debugger_ConsumerNoDebugPermission|Bearer SECRET" }, statusCode = 403 });
        })) {
            var config = Config(answered.Url); config.NodeKeys = [Tests.NodeKey, libraryNode];
            config.NodeModuleKeys = new() { [Tests.NodeKey] = Tests.ModuleKey, [libraryNode] = library };
            var transport = new NativeTransport(config);
            var failure = await StartFails(transport);
            Tests.Check(failure.Message.StartsWith("debug_start_rejected:", StringComparison.Ordinal), "answered preflight did not reach the start: " + failure.Message);
            var order = answered.Requests.Select(r => r.Method + " " + r.Route).ToArray();
            Tests.Check(order.SequenceEqual(["GET /App/", "POST /App/moduleservices/debugger/startsession"]), "preflight/start order: " + string.Join(", ", order));
            var start = JsonDocument.Parse(answered.Requests.Single(r => r.Route.EndsWith("startsession")).Body).RootElement;
            Tests.Check(start.GetProperty("breakpointId").GetString() == Tests.ModuleKey + ":" + Tests.NodeKey + "::," + library + ":" + libraryNode + "::", "start lost per-node owners");
            Tests.Check(transport.Preflight is { Outcome: "answered", Failure: null }, "answered preflight not recorded");
            await transport.Stop();
        }
        // 3. IPv6-only failure: the default stack fails and the IPv4-only probe answers. Still not-attempted; the
        //    classification is recorded so the host may relaunch a process-scoped IPv6-disabled worker once.
        var probes = new List<bool>();
        var unreachable = Config("http://127.0.0.1:9/App/");
        var ipv6Only = new NativeTransport(unreachable, preflight: (uri, ipv4Only, budget) => { probes.Add(ipv4Only); return ipv4Only ? null : "ConnectionReset"; });
        Tests.Check((await StartFails(ipv6Only)).Message == "debug_start_unreachable:preflight", "IPv6-only failure code");
        Tests.Check(probes.SequenceEqual([false, true]) && ipv6Only.Preflight is { Outcome: "failed", Failure: "ConnectionReset", Ipv4Answered: true, Ipv6OnlyFailure: true },
            "IPv6-only failure not recorded");
        var both = new NativeTransport(Config("http://127.0.0.1:9/App/"), preflight: (_, _, _) => "ConnectFailure");
        await StartFails(both);
        Tests.Check(both.Preflight is { Ipv4Answered: false, Ipv6OnlyFailure: false }, "general failure reported as IPv6-only");
        var previous = Environment.GetEnvironmentVariable("DOTNET_SYSTEM_NET_DISABLEIPV6");
        try {
            Environment.SetEnvironmentVariable("DOTNET_SYSTEM_NET_DISABLEIPV6", "1");
            var relaunched = new NativeTransport(Config("http://127.0.0.1:9/App/"), preflight: (_, ipv4Only, _) => ipv4Only ? null : "ConnectionReset");
            await StartFails(relaunched);
            Tests.Check(relaunched.Preflight is { Ipv6Disabled: true, Ipv6OnlyFailure: false }, "process-scoped IPv6 disable not recorded or misclassified");
        } finally { Environment.SetEnvironmentVariable("DOTNET_SYSTEM_NET_DISABLEIPV6", previous); }
        // 4. Through the session: start-failed, then a confirmed local stop; the receipt status names the preflight.
        var sessionConfig = Config("http://127.0.0.1:9/App/"); sessionConfig.SessionId = Guid.NewGuid().ToString("N");
        var sessionTransport = new NativeTransport(sessionConfig, preflight: (_, _, _) => "ConnectionReset");
        await using (var session = new DebugSession(sessionConfig, sessionTransport)) {
            try { await session.Start(); throw new Exception("session start accepted"); } catch (DebugFailure) { }
            await session.Stop();
            var status = JsonSerializer.SerializeToElement(session.Status(), Wire.Options);
            Tests.Check(status.GetProperty("state").GetString() == "stopped" && status.GetProperty("startError").GetString() == "debug_start_unreachable:preflight" &&
                status.GetProperty("transport").GetProperty("startOutcome").GetString() == "not-attempted" &&
                status.GetProperty("transportPreflight").GetProperty("outcome").GetString() == "failed", "session receipt lost the not-attempted preflight");
        }
        Console.WriteLine("PASS: ODC start preflight is read-only, precedes the single start and fails as not-attempted");
    }
#else
    // Platform 11 has no REST start (SoapTransport); the O11 build keeps NativeTransport without a preflight.
    internal static Task Run() => Task.CompletedTask;
#endif
}
