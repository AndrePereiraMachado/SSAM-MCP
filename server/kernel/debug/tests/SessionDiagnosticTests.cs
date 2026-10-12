using System.Text.Json;
internal static class SessionDiagnosticTests {
    internal static async Task Run() {
        static Configuration Config() => new() { SessionId = Guid.NewGuid().ToString("N"), Module = "Fixture",
            ModuleKey = Tests.ModuleKey, RuntimeUrl = "https://example.invalid/App/", NodeKeys = [Tests.NodeKey] };
        var transport = new FailureTransport(new System.Net.WebException("PRIVATE_START", System.Net.WebExceptionStatus.Timeout), new IOException("PRIVATE_STOP"));
        await using (var session = new DebugSession(Config(), transport)) {
            try { await session.Start(); throw new Exception("start unexpectedly accepted"); } catch (System.Net.WebException) { }
            await session.Stop(); await session.Stop();
            var json = Wire.Json(session.Status()); using var parsed = JsonDocument.Parse(json); var status = parsed.RootElement;
            Tests.Check(status.GetProperty("state").GetString() == "stop-uncertain" && transport.Stops == 1, "uncertain stop must remain single-send");
            Tests.Check(status.GetProperty("error").GetString() == "debug_start_timeout_uncertain" && status.GetProperty("startExceptionClass").GetString() == "WebException", "start cause was replaced by cleanup failure");
            Tests.Check(status.GetProperty("stopError").GetString() == "debug_stop_uncertain" && status.GetProperty("stopExceptionClass").GetString() == "IOException", "stop failure is separately diagnosable");
            Tests.Check(!json.Contains("PRIVATE") && !status.GetProperty("transport").GetProperty("tokenObtained").GetBoolean(), "diagnostic leaked private exception or invented token");
        }
        var rejected = new FailureTransport(new DebugFailure("debug_start_rejected:403:Debugger_ConsumerNoDebugPermission"), null);
        await using (var session = new DebugSession(Config(), rejected)) {
            try { await session.Start(); throw new Exception("start unexpectedly accepted"); } catch (DebugFailure) { }
            await session.Stop(); var json = Wire.Json(session.Status());
            Tests.Check(json.Contains("debug_start_rejected:403:Debugger_ConsumerNoDebugPermission") && json.Contains("\"state\":\"stopped\"") && rejected.Stops == 1, "definite rejection or confirmed cleanup lost");
        }
        var config = Config(); config.Seconds = 600; config.CredentialExpiresAt = DateTimeOffset.UtcNow.AddSeconds(20);
        await using (var session = new DebugSession(config, new FailureTransport(null, null))) {
            using var parsed = JsonDocument.Parse(Wire.Json(session.Status()));
            Tests.Check(parsed.RootElement.GetProperty("expiresAt").GetDateTimeOffset() == config.CredentialExpiresAt && session.RemainingLease.TotalSeconds <= 20, "worker extended the credential lease");
        }
        Tests.Check(Wire.SafeExceptionClass(new PrivateException()) == "unknown" && Wire.SafeFailureCode(new DebugFailure("debug_bad:private message"), "debug_native_error") == "debug_native_error", "arbitrary class/message escaped diagnostic allowlist");
        var xmlDiagnostic = Wire.Json(Wire.Error(new System.Xml.XmlException("PRIVATE_NATIVE_VALUE")));
        Tests.Check(xmlDiagnostic.Contains("XmlException") && !xmlDiagnostic.Contains("PRIVATE_NATIVE_VALUE"), "XML parsing diagnostics must identify only the exception class");
        Console.WriteLine("PASS: session diagnostics 4 cases; first failure, single stop, credential deadline and private fields");
    }
    sealed class PrivateException : Exception { }
    sealed class FailureTransport(Exception? start, Exception? stop) : IDebugTransport {
        public bool IsOfflineSynthetic => true;
        public DebugTransportDiagnostic Diagnostic => new("rest-start", Stops == 0 ? "not-started" : "no-session-token", false, "attempted");
        public event Func<DebugTransportEvent, Task>? Received { add { } remove { } }
        public event Action<string>? Failed { add { } remove { } }
        internal int Stops;
        public Task Start() => start == null ? Task.CompletedTask : Task.FromException(start);
        public Task Stop() { Stops++; return stop == null ? Task.CompletedTask : Task.FromException(stop); }
        public string Evaluate(string thread, string request) => throw new InvalidOperationException();
        public void Execute(string op, string thread) => throw new InvalidOperationException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
