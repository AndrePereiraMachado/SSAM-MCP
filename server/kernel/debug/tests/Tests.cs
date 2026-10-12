using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;
class Tests {
    internal const string ModuleKey = "AQEBAQEBAQEBAQEBAQEBAQ", NodeKey = "AgICAgICAgICAgICAgICAg";
    static async Task Main(string[] args) {
        var dir = Path.GetFullPath(args[0]);
        AssemblyLoadContext.Default.Resolving += (c, n) => File.Exists(Path.Combine(dir, n.Name + ".dll")) ? c.LoadFromAssemblyPath(Path.Combine(dir, n.Name + ".dll")) : null;
        if (args.Length == 2 && args[1] == "--trace-options-only") { TraceFunctionKeyTests.Run(); return; }
        if (args.Length == 2 && args[1] == "--trace-only") { await TraceTests.Run(); Console.WriteLine("PASS: trace and native request provenance"); return; }
        if (args.Length == 2 && args[1] == "--session-diagnostics-only") { await SessionDiagnosticTests.Run(); return; }
        if (args.Length == 2 && args[1] == "--native-inspection-only") { await NativeInspectionTests.Run(); return; }
        if (args.Length == 2 && args[1] == "--pipe-only") { await DebugPipeTests.Run(); return; }
        if (args.Length == 2 && args[1] == "--breakpoint-owners-only") { BreakpointOwnerTests.Run(); return; }
        if (args.Length == 2 && args[1] == "--transport-preflight-only") { await TransportPreflightTests.Run(); return; }
#if !ODC
        if (args.Length == 2 && args[1] == "--soap-breakpoints-only") { O11SoapFixture.CheckBreakpointOwners(); await O11SoapFixture.Run(bearer: true, separateEntry: true); Console.WriteLine("PASS: native SOAP breakpoint owners and entry binding"); return; }
#endif
        if (args.Length > 1) DebugRequestOwnershipIntegrationTests.NativeProofBytes = File.ReadAllBytes(Path.GetFullPath(args[1]));
        if (args.Length > 2 && args[2] == "ownership-only") {
            DebugRequestOwnershipTests.Run(); await DebugRequestOwnershipIntegrationTests.Run(); return;
        }
        await Run();
    }
    internal static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    [MethodImpl(MethodImplOptions.NoInlining)] static async Task Run() {
        BodyPolicyTests.Run();
        await DebugPipeTests.Run();
        NativeVariableTests.Run();
        await NativeInspectionTests.Run();
        TraceFunctionKeyTests.Run();
        await SessionDiagnosticTests.Run();
        DebugRequestOwnershipTests.Run();
        await DebugRequestOwnershipIntegrationTests.Run();
        await PrivateValuePolicyTests.Run();
        await TraceTests.Run();
        BlockedBindingTests.Run();
#if !ODC
        PacoteFDeveloperCredentialTests.Run();
#endif
        Check((string?)DebugPolicy.Value("Response.Headers.Authorization", "secret") == "[redacted]", "secret filtering");
        var response = JsonSerializer.Serialize(Variables.Read("<vars><local name=\"Response\"><Text name=\"Body\" value='{&quot;statusCode&quot;:400,&quot;access_token&quot;:&quot;secret&quot;}'/></local></vars>"));
        Check(!response.Contains("secret") && response.Contains("400"), "body filtering");
        try { Variables.Read("<!DOCTYPE vars [<!ENTITY x SYSTEM 'file:///no'>]><vars>&x;</vars>"); throw new Exception("XXE accepted"); } catch (System.Xml.XmlException) { }
        var key = ObjectKey.Parse(ModuleKey);
        var point = new Breakpoint(key, ObjectKey.Parse(NodeKey));
        var stack = new[] { new StackElement(0, "Fixture", "Callback", point, "ServerAction", point, point, BreakpointType.Normal, "") };
        var thread = new ThreadData(key, "T1", "Test", "", 9223372036854775806L, false, "PRIVATE-SESSION", true, stack, false);
        Check(new Configuration().AutoContinue, "troubleshoot defaults to automatic continuation");
        var config = new Configuration { SessionId = Guid.NewGuid().ToString("N"), Module = "Fixture", ModuleKey = ModuleKey, RuntimeUrl = "https://example.invalid/App/", NodeKeys = [NodeKey], AutoContinue = false };
        config.Validate();
        foreach (var fields in new (string? User, string? Secret)[] { (null, null), ("PRIVATE_USER", null), (null, "PRIVATE_ID_TOKEN"), ("PRIVATE_USER\n", "PRIVATE_ID_TOKEN"), ("PRIVATE_USER", "PRIVATE_ID_TOKEN\r") }) {
            var authConfig = new Configuration { SessionId = config.SessionId, Module = config.Module, RuntimeUrl = config.RuntimeUrl, NodeKeys = config.NodeKeys, Token = "PRIVATE_BEARER", SoapUser = fields.User, SoapSecret = fields.Secret };
#if ODC
            if (fields.User == null && fields.Secret == null) { authConfig.Validate(); continue; }
#endif
            try { authConfig.Validate(); throw new Exception("invalid private SOAP context accepted"); } catch (DebugFailure error) { Check(error.Message == "debug_invalid_auth_context", "private authentication rejection is sanitized"); }
        }
#if !ODC
        var completeAuth = new Configuration { SessionId = config.SessionId, Module = config.Module, RuntimeUrl = config.RuntimeUrl, NodeKeys = config.NodeKeys, Token = "PRIVATE_BEARER", SoapUser = "PRIVATE_USER", SoapSecret = "PRIVATE_ID_TOKEN" };
        completeAuth.Validate();
        completeAuth.Token = null;
        try { completeAuth.Validate(); throw new Exception("SOAP context without bearer accepted"); } catch (DebugFailure) { }
#endif
        var fake = new FakeTransport(); await using var session = new DebugSession(config, fake);
        await session.Start(); await fake.Pause(thread);
        var status = Wire.Json(await session.Execute(new Request()));
        Check(status.Contains("9223372036854775806") && !status.Contains("PRIVATE-SESSION"), "safe exact event id");
        try { await session.Execute(new Request { Op = "continue", ThreadId = "T1", EventId = "42" }); throw new Exception("stale event accepted"); } catch (DebugFailure) { }
        Check(fake.Commands == 0, "stale event reached server");
        var command = new Request { Op = "continue", ThreadId = "T1", EventId = "9223372036854775806" };
        fake.ThrowOnExecute = true;
        try { await session.Execute(command); throw new Exception("expected transport failure"); } catch (IOException) { }
        try { await session.Execute(command); throw new Exception("replay accepted"); } catch (DebugFailure) { }
        Check(fake.Commands == 1, "uncertain command repeated");
        await session.Stop(); await session.Stop(); Check(fake.Stops == 1, "duplicate stop");
        var autoFake = new FakeTransport(); config.AutoContinue = true; config.Paths = ["Response"];
        await using var capture = new DebugSession(config, autoFake); await capture.Start(); await autoFake.Pause(thread);
        Check(autoFake.Commands == 1 && autoFake.Evaluations == 1, "auto capture resumes");
        await autoFake.Pause(thread); Check(autoFake.Commands == 1, "replayed event resumed twice");
        var captureFailure = new FakeTransport { ThrowOnEvaluate = true };
        await using var failedCapture = new DebugSession(config, captureFailure); await failedCapture.Start(); await captureFailure.Pause(thread);
        Check(captureFailure.Commands == 1, "failed capture left request suspended");
        var expiring = new FakeTransport(); config.AutoContinue = false; config.PauseSeconds = 1;
        await using var deadline = new DebugSession(config, expiring); await deadline.Start(); await expiring.Pause(thread);
        await Task.Delay(1100); await deadline.ReleaseExpiredPauses(); Check(expiring.Commands == 1, "pause deadline did not resume");
        var stopFailure = new FakeTransport { ThrowOnStop = true };
        await using var uncertainStop = new DebugSession(config, stopFailure); await uncertainStop.Start(); await uncertainStop.Stop(); await uncertainStop.Stop();
        Check(stopFailure.Stops == 1 && Wire.Json(uncertainStop.Status()).Contains("stop-uncertain"), "uncertain stop retried or hidden");
        var draining = new FakeTransport();
        await using var concurrentStop = new DebugSession(config, draining); await concurrentStop.Start();
        // The native hub can drain a callback during Stop. This used to deadlock on the session gate.
        draining.OnStop = () => draining.Pause(thread);
        await Task.WhenAll(concurrentStop.Execute(new Request { Op = "stop" }), concurrentStop.Stop()).WaitAsync(TimeSpan.FromSeconds(2));
        Check(draining.Stops == 1 && draining.Commands == 0 && Wire.Json(concurrentStop.Status()).Contains("\"state\":\"stopped\""), "stop must drain events once without pausing or deadlocking");
#if ODC
        var binder = new PayloadBinder();
        Check(binder.BindToType("OutSystems.DebuggerClient", "OutSystems.DebuggerClient.Payloads.AtBreakpointEvent") == typeof(OutSystems.DebuggerClient.Payloads.AtBreakpointEvent), "payload type binding");
        foreach (var hostile in new[] { "System.Diagnostics.Process", "OutSystems.DebuggerClient.RestDebuggerService", "OutSystems.DebuggerClient.Payloads.Missing" }) {
            try { binder.BindToType(null, hostile); throw new Exception("bound " + hostile); } catch (DebugFailure) { }
        }
#endif
        Check(NativeTransport.MessageId("{\"errors\":[\"ERROR: Debugger_ConsumerNoDebugPermission|Bearer secret\"],\"statusCode\":403}") == "Debugger_ConsumerNoDebugPermission", "message id from json errors");
        Check(NativeTransport.MessageId("ERROR: Debugger_Exception|token abc") == "Debugger_Exception" && NativeTransport.MessageId("<html>oops</html>") == "unknown" && NativeTransport.MessageId("{\"x\":1}") == "unknown", "message id sanitization");
        Check(NativeTransport.DefiniteFailure(new System.Net.WebException("ERROR: Debugger_SessionEnded|secret")) == "debug_start_rejected:answered:Debugger_SessionEnded", "native client re-thrown server error is definite");
        Check(NativeTransport.DefiniteFailure(new System.Net.WebException("timeout", System.Net.WebExceptionStatus.Timeout)) == null && NativeTransport.DefiniteFailure(new System.Net.WebException("x", new IOException(), System.Net.WebExceptionStatus.UnknownError, null)) == null, "no answer stays uncertain");
        Check(NativeTransport.DefiniteFailure(new System.Net.WebException("dns", System.Net.WebExceptionStatus.NameResolutionFailure)) == "debug_start_unreachable:NameResolutionFailure", "unreachable server is definite");
        await NativeFixture.Run();
        await NativeFixture.Run(slowEvaluation: true);
        await NativeFixture.Run(rejectStart: true);
        BreakpointOwnerTests.Run();
        await TransportPreflightTests.Run();
#if !ODC
        O11SoapFixture.CheckFailureClassification();
        O11SoapFixture.CheckBreakpointOwners();
        await O11SoapFixture.Run();
        await O11SoapFixture.Run(slowEvaluation: true);
        await O11SoapFixture.Run(rejectStart: true);
        await O11SoapFixture.Run(bearer: true);
        await O11SoapFixture.Run(missingRawRequestId: true);
        await O11SoapFixture.Run(bearer: true, separateEntry: true);
#endif
        Console.WriteLine("PASS: filtering, XXE, exact event ids, uncertain execution, exclusive session, auto capture, concurrent stop, native transport and bounded slow capture");
    }
}
class FakeTransport : IDebugTransport {
    public bool IsOfflineSynthetic => true;
    public event Func<DebugTransportEvent, Task>? Received;
    public event Action<string>? Failed { add { } remove { } }
    internal int Commands, Stops, Evaluations;
    internal bool ThrowOnExecute, ThrowOnEvaluate, ThrowOnStop;
    internal Func<Task>? OnStop;
    internal readonly List<string> Ops = new();
    internal string EvaluateAnswer = "<vars><local name=\"Response\"><Integer name=\"StatusCode\" value=\"400\"/></local></vars>";
    public Task Start() => Task.CompletedTask;
    internal Task Pause(ThreadData t) => Emit(DebugTransportEvent.WithoutProvenance(new AtBreakpointEvent(BreakpointType.Normal, "", t, t.EventId)));
    internal Task Emit(DebugTransportEvent evt) => Received!(evt);
    public string Evaluate(string thread, string request) { Evaluations++; if (ThrowOnEvaluate) throw new IOException(); return EvaluateAnswer; }
    public void Execute(string op, string thread) { Commands++; Ops.Add(op); if (ThrowOnExecute) throw new IOException(); }
    public async Task Stop() { Stops++; if (ThrowOnStop) throw new IOException(); if (OnStop != null) await OnStop(); }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
