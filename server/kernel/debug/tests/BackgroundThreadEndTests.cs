using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OutSystems.ObjectKeys;
using ServiceStudio.PluginAPI.Debugger;
using ServerThreadData = ServiceStudio.ServerCommunications.API.ServerThreadData;

// Request-bound background correlation: an interactive stop and the ThreadEnd of the same native request carry
// the same fingerprint; everything else (fallback, missing, mismatched, client thread) gets none, only a
// value-free shape. Native events come from the installed decoders (O11 XML factory, ODC typed payloads).
static class BackgroundThreadEndTests {
    const string Other = "BAQEBAQEBAQEBAQEBAQEBA";
    const string RequestId = "6f1c2c9e-0a0b-4c4d-8e8f-112233445566";
    static string Sha(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, Wire.Options);
    static JsonElement[] Events(DebugSession session, string kind) =>
        Json(session.Status()).GetProperty("events").EnumerateArray().Where(e => e.GetProperty("kind").GetString() == kind).ToArray();
    static string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    internal static async Task Run() {
        ShapeIsValueFree();
#if ODC
        await Session(OdcStop, OdcEnd);
#else
        ThreadEndContract();
        await Session(O11Stop, O11End);
#endif
        Console.WriteLine("Background ThreadEnd: request fingerprint on interactive stops and ThreadEnd, value-free shape otherwise (synthetic native events).");
    }
    static void ShapeIsValueFree() {
        foreach (var (raw, format, bucket) in new (string?, string?, string?)[] { (RequestId, "guid", "33-36"),
            ("0123456789abcdef0123456789ABCDEF", "hex32", "17-32"), ("PRIVATE-REQ", "other", "9-16"), (null, null, null) }) {
            var shape = Json(DebugTransportEvent.RequestIdShape(raw));
            Tests.Check(Text(shape, "format") == format && Text(shape, "lengthBucket") == bucket &&
                (raw == null || !shape.GetRawText().Contains(raw, StringComparison.OrdinalIgnoreCase)), "request id shape must be a bucket and a class, never the value");
        }
    }
#if !ODC
    static DebugTransportEvent Xml(string xml) {
        var evt = ServiceStudio.ServerCommunications.API.ServerDebuggerEventFactory.Create("Fixture", ObjectKey.Parse(Tests.ModuleKey), xml, false,
            "PRIVATE-SESSION", out var reconnect, out _, out _) ?? throw new Exception("native factory rejected fixture");
        Tests.Check(!reconnect, "fixture event asked for reconnect");
        return DebugTransportEvent.FromXml(evt, DebugTransportEvent.ReadXmlRequestId(xml));
    }
    static DebugTransportEvent O11Stop(string thread, long id, string? request, string node) => Xml(O11SoapFixture.StopEventXml(thread, id, request, node));
    static DebugTransportEvent O11End(string thread, long id, string? request, string last) => Xml(O11SoapFixture.ThreadEndEventXml(thread, id, request, last));
    // The installed O11 ThreadEnd has exactly lastBreakpoint/lastCommand on top of the common event fields:
    // no outcome. The PluginAPI conversion keeps only WaitForNextBreakpoint = longLived && lastBreakpoint != null.
    static void ThreadEndContract() {
        var native = typeof(ServiceStudio.ServerCommunications.API.ThreadEndEvent);
        var declared = native.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public |
            System.Reflection.BindingFlags.DeclaredOnly).Select(f => f.Name).Order().ToArray();
        var common = typeof(ServiceStudio.ServerCommunications.API.ServerDebuggerEvent).GetFields(System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public).Select(f => f.Name).Where(n => !n.StartsWith('<')).Order().ToArray();
        Tests.Check(declared.SequenceEqual(["lastBreakpoint", "lastCommand"]) && common.SequenceEqual(["clientThreadId", "eSpaceName", "eventId", "inPTA",
            "isLongLivedRequest", "requestId", "threadId", "threadName", "userName"]), "installed O11 ThreadEnd contract changed: " + string.Join(",", declared) + "|" + string.Join(",", common));
        var xml = O11SoapFixture.ThreadEndEventXml("T1", 43, RequestId, Tests.ModuleKey + ":" + Tests.NodeKey + "::");
        var evt = ServiceStudio.ServerCommunications.API.ServerDebuggerEventFactory.Create("Fixture", ObjectKey.Parse(Tests.ModuleKey), xml, false, "PRIVATE-SESSION", out _, out _, out var eventId);
        Tests.Check(evt is ThreadEndEvent { WaitForNextBreakpoint: true, ThreadData: ServerThreadData { RequestId: RequestId, IsLongLivedRequest: true, UserName: "PRIVATE-USER",
            CallContextId: 7, IsClientSideThread: false } thread } && eventId == 43 && !thread.Stack.Any(), "O11 XML ThreadEnd sample lost a recorded native field");
    }
#else
    static DebugTransportEvent OdcStop(string thread, long id, string? request, string node) => NativeFixture.OdcEnvelope(NativeFixture.OdcEventJson("AtBreakpointEvent", thread, id, request, node));
    static DebugTransportEvent OdcEnd(string thread, long id, string? request, string last) =>
        NativeFixture.OdcEnvelope(NativeFixture.OdcEventJson("ThreadEndEvent", thread, id, request, lastBreakpoint: last));
#endif
    static async Task Session(Func<string, long, string?, string, DebugTransportEvent> stop, Func<string, long, string?, string, DebugTransportEvent> end) {
        var config = new Configuration { SessionId = Guid.NewGuid().ToString("N"), Module = "Fixture", ModuleKey = Tests.ModuleKey,
            RuntimeUrl = "https://example.invalid/App/", NodeKeys = [Tests.NodeKey], AutoContinue = false, Inspection = new() };
        config.Validate();
        var fake = new FakeTransport();
        await using var session = new DebugSession(config, fake);
        await session.Start();
        var expected = Sha(RequestId);
        var sameModule = Tests.ModuleKey + ":" + Tests.NodeKey + "::";
        await fake.Emit(stop("T1", 42, RequestId, Tests.NodeKey));
        var paused = Events(session, "paused").Single();
        var status = Json(session.Status());
        Tests.Check(Text(paused.GetProperty("stop"), "nativeRequestIdSha256") == expected &&
            Text(status.GetProperty("pauses")[0], "nativeRequestIdSha256") == expected, "interactive paused record lost the native request fingerprint");
        Tests.Check(Text(paused.GetProperty("nativeRequestIdShape"), "format") == "guid", "interactive stop has no value-free request shape");
        await session.Execute(new Request { Op = "continue", ThreadId = "T1", EventId = "42" });
        await fake.Emit(end("T1", 43, RequestId, sameModule));
        var ended = Events(session, "thread-end").Single();
        Tests.Check(Text(ended, "nativeRequestIdSha256") == expected && Text(ended, "lastBreakpoint") == Tests.NodeKey &&
            ended.GetProperty("isLongLivedRequest").GetBoolean() && Text(ended.GetProperty("nativeRequestIdShape"), "format") == "guid",
            "ThreadEnd must carry the same fingerprint, the same-module last node and the long-lived flag: " + ended.GetRawText());
        // Fallback, missing, mismatched and client-side identities never manufacture provenance.
        var nativeEnd = end("T2", 44, RequestId, Tests.ModuleKey + ":" + Tests.NodeKey + "::").NativeEvent;
        var clientThread = new ThreadData(ObjectKey.Parse(Tests.ModuleKey), "T5", "Client", "", 47, false, "PRIVATE-SESSION", true, [], true);
        var refused = new (string Name, DebugTransportEvent Event)[] {
            ("missing", end("T3", 45, null, sameModule)),
            ("fallback", new DebugTransportEvent(nativeEnd, new("T2", false, true))),
            ("mismatched", new DebugTransportEvent(nativeEnd, new("OTHER-PRIVATE-REQUEST", true, false))),
            ("client", new DebugTransportEvent(new ThreadEndEvent(false, clientThread, 47), new(RequestId, true, false))),
            ("cross-module", end("T4", 46, RequestId, Other + ":" + Tests.NodeKey + "::")) };
        foreach (var (name, evt) in refused) {
            await fake.Emit(evt);
            var row = Events(session, "thread-end").Last();
            var shape = row.GetProperty("nativeRequestIdShape");
            Tests.Check(row.GetProperty("threadId").GetString() == evt.NativeEvent.ThreadData!.ThreadId, name + " ThreadEnd not recorded");
            if (name == "cross-module") {
                Tests.Check(Text(row, "nativeRequestIdSha256") == expected && row.GetProperty("lastBreakpoint").ValueKind == JsonValueKind.Null,
                    "another module's last breakpoint must not be reported as this module's node");
                continue;
            }
            Tests.Check(row.GetProperty("nativeRequestIdSha256").ValueKind == JsonValueKind.Null, name + " request id manufactured a fingerprint");
            Tests.Check(name switch {
                "missing" => !shape.GetProperty("present").GetBoolean(),
                "fallback" => shape.GetProperty("fallback").GetBoolean(),
                "mismatched" => !shape.GetProperty("threadRequestIdMatch").GetBoolean() && Text(shape, "format") == "other",
                _ => shape.GetProperty("clientThread").GetBoolean() }, name + " shape lost its reason: " + shape.GetRawText());
        }
        await fake.Emit(stop("T6", 48, null, Tests.NodeKey));
        Tests.Check(Events(session, "paused").Last().GetProperty("stop").GetProperty("nativeRequestIdSha256").ValueKind == JsonValueKind.Null,
            "stop without original requestId manufactured a fingerprint");
        var text = Json(session.Status()).GetRawText();
        foreach (var secret in new[] { RequestId, "OTHER-PRIVATE-REQUEST", "PRIVATE-USER", "PRIVATE-SESSION" })
            Tests.Check(!text.Contains(secret, StringComparison.OrdinalIgnoreCase), "session status leaked a raw native identity");
    }
}
