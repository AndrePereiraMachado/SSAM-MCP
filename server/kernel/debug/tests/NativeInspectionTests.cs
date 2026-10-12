using System.Text.Json;
using System.Xml.Linq;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;
using ServerThreadData = ServiceStudio.ServerCommunications.API.ServerThreadData;

internal static class NativeInspectionTests {
    static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, Wire.Options);
    static InspectionVariable Definition(string category = "local", string path = "Rows") => new() {
        ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey, VariableKey = Tests.NodeKey,
        SourceSha256 = new string('a', 64), Name = path, Path = path, Category = category
    };
    static ThreadData Thread(long eventId = 1, BreakpointType topType = BreakpointType.Normal, bool previous = false) {
        var key = ObjectKey.Parse(Tests.ModuleKey); var point = new Breakpoint(key, ObjectKey.Parse(Tests.NodeKey));
        var stack = new[] { new StackElement(0, "Fixture", "Call", point, "ServerAction", point, previous ? point : null, BreakpointType.Normal, ""),
            new StackElement(1, "Fixture", "Call", point, "ServerAction", point, previous ? point : null, topType, topType == BreakpointType.AtFunctionReturn ? "Callee" : "") };
        return new ThreadData(key, "T1", "Test", "", eventId, false, "PRIVATE-SESSION", true, stack, false);
    }
    static void PrivateChannel() {
        var key = new string('a', 64); var id = new string('b', 32);
        using var wire = new PrivateInspectionWire(key, id);
        var definition = Definition("local", "Secret"); var nativeValue = "private-user-Ω-🔒";
        var nativeCalls = 0;
        var inspection = new NativeInspection(new InspectionOptions { Variables = [definition] }, new(), Thread(), _ => {
            nativeCalls++;
            return new XElement("vars", new XElement("local", new XAttribute("name", "Secret"), nativeValue)).ToString();
        }, privateWire: wire);
        var reference = Json(inspection.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
        JsonElement Read() => Json(inspection.Read(new Request { Op = "private-read", Reference = reference }));
        JsonElement Open(JsonElement result) {
            var payload = result.GetProperty("privatePayload");
            var cipher = Convert.FromBase64String(payload.GetProperty("ciphertext").GetString()!); var clear = new byte[cipher.Length];
            using var aes = new System.Security.Cryptography.AesGcm(Convert.FromHexString(key), 16);
            aes.Decrypt(Convert.FromBase64String(payload.GetProperty("nonce").GetString()!), cipher,
                Convert.FromBase64String(payload.GetProperty("tag").GetString()!), clear,
                System.Text.Encoding.UTF8.GetBytes("ssam-server-private-inspection/1|" + id));
            try { return JsonDocument.Parse(clear).RootElement.Clone(); }
            finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(clear); }
        }
        var first = Read(); var decoded = Open(first);
        Tests.Check(!first.GetRawText().Contains(nativeValue) && !first.GetRawText().Contains(key) &&
            decoded.GetProperty("value").GetProperty("value").GetString() == nativeValue &&
            decoded.GetProperty("variable").GetProperty("ref").GetString() == reference,
            "private native value must round trip only through authenticated encryption");
        Tests.Check(!Read().GetProperty("changed").GetBoolean() && nativeCalls == 2, "private reads must re-evaluate natively");
        nativeValue = "changed-private-value";
        var changed = Read(); Tests.Check(changed.GetProperty("changed").GetBoolean() &&
            Open(changed).GetProperty("value").GetProperty("value").GetString() == nativeValue, "private changes must be observable");
        inspection.Invalidate();
        try { Read(); throw new Exception("stale private reference accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_reference", "wrong stale private error"); }
        wire.Dispose();
        try { wire.Seal(new { value = nativeValue }); throw new Exception("closed private channel accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_private_inspection_closed", "wrong private close error"); }
    }
    // SuspendAllThreads answers with BeforeSuspendEvent in both installed SDKs (DebuggerManager visits it like a
    // breakpoint, empty server stack); BreakpointType has no suspension member. Only that type becomes a stop.
    static DebugTransportEvent Suspension(long eventId) {
#if ODC
        return NativeFixture.OdcEnvelope(NativeFixture.OdcEventJson("BeforeSuspendEvent", "T1", eventId, "PRIVATE-REQUEST-ID"));
#else
        var xml = O11SoapFixture.StopEventXml("T1", eventId, "PRIVATE-REQUEST-ID", Tests.NodeKey, longLived: false, name: "BeforeSuspendEvent");
        var evt = ServiceStudio.ServerCommunications.API.ServerDebuggerEventFactory.Create("Fixture", ObjectKey.Parse(Tests.ModuleKey), xml, false,
            "PRIVATE-SESSION", out _, out _, out _) ?? throw new Exception("native factory rejected suspension");
        return DebugTransportEvent.FromXml(evt, DebugTransportEvent.ReadXmlRequestId(xml));
#endif
    }
    static async Task SuspensionStop() {
        Tests.Check(Enum.GetNames<BreakpointType>().SequenceEqual(["Normal", "AtFunctionReturn", "BetweenAssignments"]), "installed BreakpointType gained a suspension member");
#if ODC
        var payloads = typeof(OutSystems.DebuggerClient.Payloads.DebuggerEvent).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && typeof(OutSystems.DebuggerClient.Payloads.DebuggerEvent).IsAssignableFrom(t)).Select(t => t.Name).ToHashSet();
        Tests.Check(payloads.Contains("BeforeSuspendEvent") && payloads.Contains("AtBreakpointEvent"), "installed ODC payloads lost the suspension event");
#endif
        var config = new Configuration { SessionId = Guid.NewGuid().ToString("N"), RuntimeUrl = "https://example.invalid/App/", Module = "Fixture",
            ModuleKey = Tests.ModuleKey, NodeKeys = [Tests.NodeKey], AutoContinue = false, PauseSeconds = 1, Inspection = new() };
        config.Validate(); var fake = new FakeTransport();
        await using (var session = new DebugSession(config, fake)) {
            await session.Start();
            await session.Execute(new Request { Op = "pause" });
            var suspended = Suspension(5);
            Tests.Check(suspended.NativeEvent is BeforeSuspendEvent && !suspended.NativeEvent.ThreadData!.Stack.Any(), "installed decoder changed the suspension shape");
            await fake.Emit(suspended);
            var status = Json(session.Status());
            Tests.Check(!status.GetProperty("pauseRequest").GetProperty("requested").GetBoolean() && status.GetProperty("pauses").GetArrayLength() == 1 &&
                status.GetProperty("pauses")[0].GetProperty("eventId").GetString() == "5", "native suspension was not recorded as a stop");
            Tests.Check(status.GetProperty("events").EnumerateArray().Any(e => e.GetProperty("kind").GetString() == "paused" &&
                e.GetProperty("reason").GetString() == "suspend"), "suspension stop lost its native reason");
            await Task.Delay(1100); await session.ReleaseExpiredPauses();
            Tests.Check(fake.Ops.SequenceEqual(["pause"]), "suspended thread was resumed automatically");
            try { await session.Execute(new Request { Op = "scope", ThreadId = "T1", EventId = "5" }); throw new Exception("frameless scope accepted"); }
            catch (DebugFailure e) { Tests.Check(e.Message == "debug_native_suspension_without_frames", "wrong frameless suspension refusal: " + e.Message); }
            await session.Execute(new Request { Op = "step-over", ThreadId = "T1", EventId = "5" });
            try { await session.Execute(new Request { Op = "continue", ThreadId = "T1", EventId = "5" }); throw new Exception("stale suspension accepted"); }
            catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_stop" && fake.Ops.SequenceEqual(["pause", "step-over"]), "stale suspension token reached the server"); }
            await fake.Emit(Suspension(5));
            Tests.Check(Json(session.Status()).GetProperty("pauses").GetArrayLength() == 0, "replayed suspension event created a second stop");
        }
        // Outside a manual inspection session a suspension is only observed; it is never answered.
        var auto = new FakeTransport(); config.Inspection = null; config.AutoContinue = true;
        await using (var session = new DebugSession(config, auto)) {
            await session.Start(); await auto.Emit(Suspension(6));
            Tests.Check(auto.Commands == 0 && Json(session.Status()).GetProperty("pauses").GetArrayLength() == 0, "automatic session acted on a suspension");
        }
    }
    // ServerVariableContainerUtils (O11 and ODC, identical apart from logging) types a container only by its element
    // name: "Record.List" is RecordList, any other non-container name is Unknown. Item element names are therefore
    // irrelevant to paging; a list-like container without the native RecordList Length is flagged, never paged.
    static void ListShapes() {
        foreach (var (name, item) in new (string, Func<int, XElement>)[] {
            ("Text", i => new XElement("Text", new XAttribute("debug.field", "[" + i + "]"), "t" + i)),
            ("Integer", i => new XElement("Integer", new XAttribute("debug.field", "[" + i + "]"), i)),
            ("Date", i => new XElement("Date", new XAttribute("debug.field", "[" + i + "]"), "2026-10-" + (1 + i % 28).ToString("00"))),
            ("Aggregate", i => new XElement("Record", new XAttribute("debug.field", "[" + i + "]"),
                new XElement("Entity", new XAttribute("debug.field", "Customer"), new XAttribute("Id", i)))) }) {
            var addresses = new List<string>();
            var inspector = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), Thread(), request => {
                var address = XElement.Parse(request).Elements().Single().Attribute("name")!.Value; addresses.Add(address);
                if (address == "Rows.[150]") return new XElement("vars", new XElement("local", new XAttribute("name", address), item(150))).ToString();
                return new XElement("vars", new XElement("local", new XAttribute("name", "Rows"),
                    new XElement("Record.List", new XAttribute("Length", 151), Enumerable.Range(0, 150).Select(item)))).ToString();
            });
            var reference = Json(inspector.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
            var first = Json(inspector.Read(new Request { Reference = reference, Depth = 2, Limit = 150 }));
            var coverage = first.GetProperty("collectionCoverage");
            Tests.Check(first.GetProperty("value").GetProperty("type").GetString() == "RecordList" && first.GetProperty("availableChildren").GetInt64() == 152 &&
                first.GetProperty("nextOffset").GetInt32() == 150 && coverage.GetProperty("declaredLength").GetInt64() == 151 &&
                !coverage.GetProperty("complete").GetBoolean() && coverage.GetProperty("missingItems").GetInt64() == 1, name + " list lost native length/coverage");
            var tail = Json(inspector.Read(new Request { Reference = reference, Depth = 2, Offset = 150, Limit = 150 }));
            var last = tail.GetProperty("children")[1];
            Tests.Check(addresses.Count(a => a == "Rows.[150]") == 1 && tail.GetProperty("children").GetArrayLength() == 2 &&
                last.GetProperty("path").GetString() == "Rows.[150]" && tail.GetProperty("nextOffset").ValueKind == JsonValueKind.Null, name + " tail was not evaluated natively");
            Tests.Check(name == "Aggregate" ? last.GetProperty("hasChildren").GetBoolean() && last.GetProperty("value").ValueKind == JsonValueKind.Null
                : last.GetProperty("value").GetString() == item(150).Value && last.GetProperty("valueComplete").GetBoolean(), name + " tail value is not the native one");
        }
        var evaluations = 0;
        var unqualified = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), Thread(), _ => {
            evaluations++;
            return new XElement("vars", new XElement("local", new XAttribute("name", "Rows"), new XElement("List", new XAttribute("Length", 151),
                Enumerable.Range(0, 150).Select(i => new XElement("Text", new XAttribute("debug.field", "[" + i + "]"), "t" + i))))).ToString();
        });
        var unqualifiedRef = Json(unqualified.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
        var flagged = Json(unqualified.Read(new Request { Reference = unqualifiedRef, Depth = 2, Offset = 150, Limit = 150 }));
        var flaggedCoverage = flagged.GetProperty("collectionCoverage");
        Tests.Check(flaggedCoverage.ValueKind == JsonValueKind.Object && !flaggedCoverage.GetProperty("complete").GetBoolean() &&
            flaggedCoverage.GetProperty("declaredLength").ValueKind == JsonValueKind.Null && flaggedCoverage.GetProperty("enumeratedItems").GetInt64() == 150 &&
            !flagged.GetProperty("value").GetProperty("valueComplete").GetBoolean() && flagged.GetProperty("value").GetProperty("value").ValueKind == JsonValueKind.Null &&
            evaluations == 1, "list-like container without native RecordList length was paged, completed or summarized silently");
    }
    // Screen/block Aggregates are NRNodes.WebScreenDataSet: not IBreakpointable in either installed model, while a
    // flow Aggregate (Nodes.DataSet) is. The server frame's native functionType is exposed so a reader can refuse it.
    static void AggregateBreakpointability() {
#if ODC
        var model = System.Reflection.Assembly.Load("OutSystems.Model");
#else
        var model = System.Reflection.Assembly.Load("ServiceStudio.Framework");
#endif
        var breakpointable = model.GetType("ServiceStudio.Model.Interfaces.IBreakpointable", true)!;
        var screenAggregate = model.GetType("ServiceStudio.Model.NRNodes+WebScreenDataSet", true)!;
        var flowAggregate = model.GetType("ServiceStudio.Model.Nodes+DataSet", true)!;
        Tests.Check(!breakpointable.IsAssignableFrom(screenAggregate) && breakpointable.IsAssignableFrom(flowAggregate) &&
            screenAggregate.BaseType == model.GetType("ServiceStudio.Model.Nodes+AbstractDataSet", true), "installed model changed Aggregate breakpointability");
        var key = ObjectKey.Parse(Tests.ModuleKey); var point = new Breakpoint(key, ObjectKey.Parse(Tests.NodeKey));
        var frame = new ThreadData(key, "T1", "Test", "", 1, false, "PRIVATE-SESSION", true,
            [new StackElement(0, "Fixture", "GetRows", point, "NRNodes.WebScreenDataSet", point, null, BreakpointType.Normal, "")], false);
        var context = Json(new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), frame, _ => throw new Exception("scope must not evaluate")).Scope())
            .GetProperty("context");
        Tests.Check(context.GetProperty("functionType").GetString() == "NRNodes.WebScreenDataSet", "native frame type unavailable to the scope reader");
    }
    // read-frame: every root of the bound scope plus child pages up to maxNodes, batched per tree level through the
    // installed evaluator, with the same references, redaction, revisions and staleness as read/read-many.
    static XElement FrameItem(int i, int revision, bool field = true) => new("Structure", field ? new XAttribute("debug.field", "[" + i + "]") : null,
        new XAttribute("Count", i + revision), new XAttribute("Password", "private-fixture"));
    static XElement FrameValue(string address, int revision) {
        var match = System.Text.RegularExpressions.Regex.Match(address, @"^(Rows|Order\.Items)\.\[(\d+)\]$");
        if (match.Success) {
            var index = int.Parse(match.Groups[2].Value);
            return match.Groups[1].Value == "Rows" ? FrameItem(index, revision, field: false) : new XElement("Structure", new XAttribute("Sku", "S" + index));
        }
        return address switch {
            "Rows" => new XElement("Record.List", new XAttribute("Length", 151), Enumerable.Range(0, 150).Select(i => FrameItem(i, revision))),
            "Order" => new XElement("Structure", new XAttribute("Total", 3), new XElement("Record.List", new XAttribute("debug.field", "Items"), new XAttribute("Length", 2),
                Enumerable.Range(0, 2).Select(i => new XElement("Structure", new XAttribute("debug.field", "[" + i + "]"), new XAttribute("Sku", "S" + i))))),
            "Order.Items" => new XElement("Record.List", new XAttribute("Length", 2),
                Enumerable.Range(0, 2).Select(i => new XElement("Structure", new XAttribute("debug.field", "[" + i + "]"), new XAttribute("Sku", "S" + i)))),
            "Seed" => new XElement("Text", "7"),
            "ApiToken" => new XElement("Text", "private-fixture-token"),
            _ => throw new Exception("unexpected native address " + address)
        };
    }
    static async Task ReadFrame() {
        var commands = new List<string[]>(); var revision = 0;
        Func<string, string> evaluate = request => {
            var rows = XElement.Parse(request).Elements().ToArray();
            commands.Add(rows.Select(r => r.Attribute("name")!.Value).ToArray());
            return new XElement("vars", rows.Select(row => {
                var value = FrameValue(row.Attribute("name")!.Value, revision);
                return new XElement(row.Name, new XAttribute("name", row.Attribute("name")!.Value), value.Name == "Text" ? value.Value : value);
            })).ToString();
        };
        var options = new InspectionOptions { Variables = [Definition("local", "Rows"), Definition("input", "Seed"), Definition("output", "Order"), Definition("local", "ApiToken")] };
        var inspector = new NativeInspection(options, new(), Thread(), evaluate);
        var scope = Json(inspector.Scope());
        var scopeRefs = scope.GetProperty("variables").EnumerateArray().ToDictionary(v => v.GetProperty("name").GetString()!, v => v.GetProperty("reference").GetString()!);
        var frame = Json(inspector.ReadFrame(new Request { Op = "read-frame", Depth = 2 }));
        var raw = frame.GetRawText();
        Tests.Check(commands[0].OrderBy(a => a).SequenceEqual(new[] { "ApiToken", "Order", "Rows", "Seed" }), "roots were not evaluated in one native command");
        Tests.Check(commands.Count == 4 && commands.Sum(c => c.Length) == 4 + 1 + 152 + 2, "read-frame did not batch each tree level: " + string.Join(" | ", commands.Select(c => c.Length)));
        Tests.Check(frame.GetProperty("complete").GetBoolean() && frame.GetProperty("pending").GetArrayLength() == 0 &&
            frame.GetProperty("nextOffset").ValueKind == JsonValueKind.Null && frame.GetProperty("maxNodes").GetInt32() == 2000, "bounded frame not complete within the default budget");
        Tests.Check(frame.GetProperty("context").GetProperty("generation").GetInt32() == scope.GetProperty("context").GetProperty("generation").GetInt32(),
            "read-frame consumed or changed the inspection generation");
        var values = frame.GetProperty("values").EnumerateArray().ToArray();
        JsonElement ValueOf(string reference) => values.Single(v => v.GetProperty("reference").GetString() == reference);
        var rows = ValueOf(scopeRefs["Rows"]);
        Tests.Check(rows.GetProperty("children").GetArrayLength() == 152 && rows.GetProperty("nextOffset").ValueKind == JsonValueKind.Null &&
            rows.GetProperty("availableChildren").GetInt64() == 152 && rows.GetProperty("children")[151].GetProperty("path").GetString() == "Rows.[150]",
            "frame read did not continue past the first native page of 150");
        Tests.Check(!raw.Contains("private-fixture") && ValueOf(scopeRefs["ApiToken"]).GetProperty("redacted").GetBoolean() &&
            ValueOf(scopeRefs["ApiToken"]).GetProperty("children").GetArrayLength() == 0, "read-frame bypassed redaction");
        Tests.Check(ValueOf(scopeRefs["Seed"]).GetProperty("value").GetProperty("value").GetString() == "7", "scalar root lost its native value");
        var items = values.Where(v => v.GetProperty("value").GetProperty("path").GetString() is "Order.Items.[0]" or "Order.Items.[1]").ToArray();
        Tests.Check(items.Length == 2 && items.All(i => i.GetProperty("children")[0].GetProperty("value").GetString()!.StartsWith('S')), "nested containers not expanded");
        Tests.Check(frame.GetProperty("nodesRead").GetInt32() == 4 + 152 + 2 + 151 * 2 + 3 + 2, "node budget accounting: " + frame.GetProperty("nodesRead"));
        // References are the same identities read/refresh/expand use; a re-read at the same depth is unchanged.
        var reread = Json(inspector.Read(new Request { Op = "refresh", Reference = scopeRefs["Rows"], Depth = 2 }));
        Tests.Check(reread.GetProperty("changed").ValueKind == JsonValueKind.False && reread.GetProperty("evaluationRevision").GetInt32() == 2, "frame reference is not the stable read reference");
        var itemRef = rows.GetProperty("children")[1].GetProperty("reference").GetString();
        Tests.Check(Json(inspector.Read(new Request { Op = "read", Reference = itemRef, Depth = 2 })).GetProperty("value").GetProperty("path").GetString() == "Rows.[0]",
            "child reference from read-frame is not readable");
        revision++;
        var changed = Json(inspector.ReadFrame(new Request { Op = "read-frame", Depth = 2 }));
        Tests.Check(changed.GetProperty("values").EnumerateArray().Single(v => v.GetProperty("reference").GetString() == scopeRefs["Rows"]).GetProperty("changed").GetBoolean(),
            "re-evaluated frame hid a changed value");
        // Budget: page cut with nextOffset/pending continuations; roots beyond the budget continue by root offset.
        var small = Json(inspector.ReadFrame(new Request { Op = "read-frame", Depth = 2, MaxNodes = 10 }));
        Tests.Check(small.GetProperty("nodesRead").GetInt32() <= 10 && !small.GetProperty("complete").GetBoolean() &&
            small.GetProperty("values").EnumerateArray().Any(v => v.GetProperty("nextOffset").ValueKind == JsonValueKind.Number) , "budget cut without continuation");
        var roots = Json(inspector.ReadFrame(new Request { Op = "read-frame", Depth = 2, MaxNodes = 2 }));
        Tests.Check(roots.GetProperty("roots").GetArrayLength() == 2 && roots.GetProperty("nextOffset").GetInt32() == 2, "root continuation missing");
        var rest = Json(inspector.ReadFrame(new Request { Op = "read-frame", Depth = 1, Offset = 2, MaxNodes = 2 }));
        Tests.Check(rest.GetProperty("rootOffset").GetInt32() == 2 && rest.GetProperty("roots").GetArrayLength() == 2 &&
            !rest.GetProperty("roots").EnumerateArray().Select(r => r.GetString()).Intersect(roots.GetProperty("roots").EnumerateArray().Select(r => r.GetString())).Any(),
            "root continuation repeated roots");
        foreach (var invalid in new[] { new Request { Op = "read-frame", MaxNodes = 0 }, new Request { Op = "read-frame", MaxNodes = 20001 },
            new Request { Op = "read-frame", TextOffset = 1 }, new Request { Op = "read-frame", Offset = -1 } }) {
            var before = commands.Count;
            try { inspector.ReadFrame(invalid); throw new Exception("invalid read-frame accepted"); }
            catch (DebugFailure e) { Tests.Check(e.Message is "debug_invalid_inspection_budget" or "debug_invalid_inspection_page" or "debug_invalid_inspection_text_page" && commands.Count == before, "invalid read-frame evaluated: " + e.Message); }
        }
        Tests.Check(Json(inspector.ReadFrame(new Request { Op = "read-frame", MaxNodes = 20000, Depth = 2 })).GetProperty("complete").GetBoolean(), "maximum budget refused");
        // Frame selection invalidates every reference a frame read produced.
        inspector.SelectFrame(0); inspector.SelectFrame(1);
        try { inspector.Read(new Request { Op = "read", Reference = itemRef }); throw new Exception("frame reference survived invalidation"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_reference", "wrong stale frame reference error"); }
        // Session routing: requires the exact observed stop and is refused after the stop is consumed.
        var config = new Configuration { SessionId = Guid.NewGuid().ToString("N"), RuntimeUrl = "https://example.invalid/App/", Module = "Fixture", ModuleKey = Tests.ModuleKey,
            NodeKeys = [Tests.NodeKey], AutoContinue = false, Inspection = new() { Variables = [Definition("local", "Response")] } };
        config.Validate(); var fake = new FakeTransport { EvaluateAnswer = "<vars><local name=\"Response\">400</local></vars>" };
        await using var session = new DebugSession(config, fake); await session.Start(); await fake.Pause(Thread());
        var routed = Json(await session.Execute(new Request { Op = "read-frame", ThreadId = "T1", EventId = "1", Depth = 2 }));
        var evaluations = fake.Evaluations;
        Tests.Check(routed.GetProperty("ok").GetBoolean() && evaluations == 1 && routed.GetProperty("roots").GetArrayLength() == 1 &&
            routed.GetProperty("values")[0].GetProperty("value").GetProperty("value").GetString() == "400", "session read-frame not routed to native inspection");
        try { await session.Execute(new Request { Op = "read-frame", ThreadId = "T1", EventId = "2" }); throw new Exception("foreign stop read"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_stop" && fake.Evaluations == evaluations, "read-frame without the observed stop"); }
        await session.Execute(new Request { Op = "step-over", ThreadId = "T1", EventId = "1" });
        try { await session.Execute(new Request { Op = "read-frame", ThreadId = "T1", EventId = "1" }); throw new Exception("consumed stop read"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_stop" && fake.Evaluations == evaluations, "read-frame after resume"); }
        Console.WriteLine("PASS: read-frame bounded batch, continuations, redaction and staleness");
    }
    internal static async Task Run() {
        await SuspensionStop();
        await ReadFrame();
        ListShapes();
        AggregateBreakpointability();
        PrivateChannel();
        var correlatedThread = new ServerThreadData(ObjectKey.Parse(Tests.ModuleKey), "T1", "PRIVATE-REQUEST-ID", "Fixture", null,
            1, false, false, "PRIVATE-SESSION", Thread().Stack.ToList()) { CallContextId = 3 };
        var correlation = new NativeInspection(new(), new(), correlatedThread, _ => throw new Exception("correlation cannot evaluate"),
            new("PRIVATE-REQUEST-ID", true, false));
        var observed = Json(correlation.Scope());
        var correlationData = observed.GetProperty("context").GetProperty("correlation");
        Tests.Check(correlationData.GetProperty("nativeClientCallContextSha256").GetString() ==
            "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce" &&
            correlationData.GetProperty("nativeRequestIdProvenance").GetBoolean() &&
            !correlationData.GetProperty("requestOwnershipProved").GetBoolean() &&
            !observed.GetRawText().Contains("PRIVATE-REQUEST-ID") && !observed.GetRawText().Contains("PRIVATE-SESSION"),
            "passive native correlation must match the request hash without revealing identities or claiming ownership");
        foreach (var provenance in new DebugTransportEvent.RequestProvenance?[] { null, new(null, false, true),
            new("T1", false, true), new("OTHER-REQUEST", true, false) }) {
            var refused = Json(new NativeInspection(new(), new(), correlatedThread, _ => "", provenance).Scope());
            Tests.Check(!refused.GetProperty("context").GetProperty("correlation").GetProperty("nativeRequestIdProvenance").GetBoolean(),
                "converted fallback or mismatched request cannot manufacture native provenance");
        }
#if ODC
        var payload = new OutSystems.DebuggerClient.Payloads.AtBreakpointEvent { RequestId = "PRIVATE-REQUEST-ID" };
        var nativeEvent = new AtBreakpointEvent(BreakpointType.Normal, "", correlatedThread, 1);
        var envelope = DebugTransportEvent.FromTyped(nativeEvent, payload);
        Tests.Check(envelope.RawRequestIdPresent && !envelope.RequestIdIsFallback, "typed payload lost original request identity");
        payload.RequestId = null;
        Tests.Check(!DebugTransportEvent.FromTyped(nativeEvent, payload).RawRequestIdPresent, "missing typed identity accepted");
        payload.RequestId = "OTHER-REQUEST";
        try { DebugTransportEvent.FromTyped(nativeEvent, payload); throw new Exception("typed mismatch accepted"); }
        catch (DebugFailure error) { Tests.Check(error.Message == "debug_event_request_provenance_mismatch", "wrong typed mismatch error"); }
#endif
        foreach (var name in new[] { "Settings.AuthPassword", "Settings.AuthUserName", "Settings.OcpApimSubscriptionKey" }) {
            var definition = Definition("site", "00000000-0000-0000-0000-000000000001.00000000-0000-0000-0000-000000000002");
#if !ODC
            definition.Path = "Fixture.Setting";
#endif
            definition.Name = name;
            var hidden = new NativeInspection(new InspectionOptions { Variables = [definition] }, new(), Thread(), _ =>
                new XElement("vars", new XElement("site", new XAttribute("name", definition.Path), "PRIVATE-SETTING-FIXTURE")).ToString());
            var hiddenReference = Json(hidden.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
            var hiddenValue = Json(hidden.Read(new Request { Reference = hiddenReference }));
            Tests.Check(hiddenValue.GetProperty("redacted").GetBoolean() && !hiddenValue.GetRawText().Contains("PRIVATE-SETTING-FIXTURE") &&
                !hiddenValue.GetProperty("value").GetProperty("valueComplete").GetBoolean(), "native GUID setting address bypassed display-name privacy");
        }
        var initialScope = new InspectionScopeBinding { ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey,
            NodeKey = Tests.ModuleKey, SourceSha256 = new string('a', 64) };
        var lazyOptions = new InspectionOptions { Scopes = [initialScope] }; lazyOptions.Validate();
        var sourceOptions = new InspectionOptions { Sources = [new() { ModuleKey = Tests.ModuleKey, SourceSha256 = new string('a', 64) }] };
        sourceOptions.Validate();
        var invalidSources = new InspectionOptions { Scopes = [initialScope], Sources = [new() { ModuleKey = Tests.ModuleKey, SourceSha256 = new string('b', 64) }] };
        try { invalidSources.Validate(); throw new Exception("conflicting source hashes accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_invalid_inspection_source_binding", "wrong source pin conflict"); }
        var lazyCalls = 0;
        var lazy = new NativeInspection(lazyOptions, new(), Thread(), request => {
            lazyCalls++; return "<vars><local name=\"Rows\">7</local></vars>";
        });
        InspectionScopeUpdate Update() => new() { ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey,
            NodeKey = Tests.NodeKey, SourceSha256 = new string('a', 64), Generation = 1, Frame = 1,
            Variables = [new InspectionVariable { ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey,
                NodeKey = Tests.NodeKey, VariableKey = Tests.NodeKey, SourceSha256 = new string('a', 64), Name = "Rows", Path = "Rows" }] };
        var lazyBefore = Json(lazy.Scope());
        var sourceOnly = new NativeInspection(sourceOptions, new(), Thread(), _ => throw new Exception("source binding evaluated"));
        Tests.Check(!Json(sourceOnly.Scope()).GetProperty("metadataBound").GetBoolean(), "source pin invented a bound scope");
        Tests.Check(Json(sourceOnly.BindScope(Update())).GetProperty("metadataBound").GetBoolean(), "runner source did not admit exact observed scope");
        var previousScope = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), Thread(previous: true),
            _ => throw new Exception("previous scope binding evaluated"));
        var previousContext = Json(previousScope.Scope());
        Tests.Check(!previousContext.GetProperty("metadataBound").GetBoolean() &&
            previousContext.GetProperty("context").GetProperty("previousNodeKey").GetString() == Tests.NodeKey,
            "previous native breakpoint silently omitted");
        try { previousScope.BindScope(Update()); throw new Exception("missing previous context accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_inspection_scope_frame_mismatch", "wrong previous scope refusal"); }
        var previousUpdate = Update(); previousUpdate.PreviousNodeKey = Tests.NodeKey;
        Tests.Check(Json(previousScope.BindScope(previousUpdate)).GetProperty("metadataBound").GetBoolean(), "exact previous context refused");
        Tests.Check(!lazyBefore.GetProperty("metadataBound").GetBoolean() && lazyBefore.GetProperty("context").GetProperty("moduleKey").GetString() == Tests.ModuleKey,
            "new node lacks exact native source context");
        void Refuse(InspectionScopeUpdate update, string reason) {
            try { lazy.BindScope(update); throw new Exception("invalid lazy binding accepted"); }
            catch (DebugFailure e) { Tests.Check(e.Message == reason, "wrong lazy binding rejection: " + e.Message); }
            Tests.Check(Json(lazy.Scope()).GetProperty("context").GetProperty("generation").GetInt32() == 1 && lazyCalls == 0,
                "rejected metadata mutated references or evaluated values");
        }
        var wrong = Update(); wrong.Generation = 2; Refuse(wrong, "debug_stale_scope_context");
        wrong = Update(); wrong.Frame = 0; Refuse(wrong, "debug_stale_scope_context");
        wrong = Update(); wrong.ModuleKey = Tests.NodeKey; Refuse(wrong, "debug_inspection_scope_frame_mismatch");
        wrong = Update(); wrong.FunctionKey = Tests.ModuleKey; Refuse(wrong, "debug_inspection_scope_frame_mismatch");
        wrong = Update(); wrong.NodeKey = Tests.ModuleKey; Refuse(wrong, "debug_inspection_scope_frame_mismatch");
        wrong = Update(); wrong.SourceSha256 = new string('b', 64); Refuse(wrong, "debug_inspection_scope_source_mismatch");
        wrong = Update(); wrong.Variables[0].NodeKey = Tests.ModuleKey; Refuse(wrong, "debug_inspection_scope_variable_mismatch");
        var lazyBound = Json(lazy.BindScope(Update()));
        Tests.Check(lazyBound.GetProperty("metadataBound").GetBoolean() && lazyBound.GetProperty("context").GetProperty("generation").GetInt32() == 2,
            "binding did not invalidate native generation");
        var lazyReference = lazyBound.GetProperty("variables")[0].GetProperty("reference").GetString();
        Tests.Check(Json(lazy.Read(new Request { Reference = lazyReference })).GetProperty("value").GetProperty("value").GetString() == "7" && lazyCalls == 1,
            "lazy scope did not use installed native evaluator");
        var repeated = Update(); repeated.Generation = 2;
        try { lazy.BindScope(repeated); throw new Exception("lazy bind replay accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_inspection_scope_already_bound", "wrong repeated bind error"); }
        lazy.SelectFrame(0); lazy.SelectFrame(1);
        Tests.Check(Json(lazy.Scope()).GetProperty("metadataBound").GetBoolean(), "frame selection lost validated scope");
        try { lazy.Read(new Request { Reference = lazyReference }); throw new Exception("lazy reference survived frame changes"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_reference", "wrong lazy reference error"); }
        var empty = new NativeInspection(lazyOptions, new(), Thread(), _ => throw new Exception("empty scope evaluated"));
        var emptyUpdate = Update(); emptyUpdate.Variables = [];
        Tests.Check(Json(empty.BindScope(emptyUpdate)).GetProperty("metadataBound").GetBoolean(), "empty native scope mistaken for missing metadata");
        var visible = Definition(); visible.NodeKey = Tests.NodeKey;
        var otherNode = Definition(); otherNode.NodeKey = Tests.ModuleKey;
        var scopedOptions = new InspectionOptions { Variables = [visible, otherNode] }; scopedOptions.Validate();
        var scoped = new NativeInspection(scopedOptions, new(), Thread(), _ => throw new Exception("scope must not evaluate"));
        Tests.Check(Json(scoped.Scope()).GetProperty("variables").GetArrayLength() == 1, "scope from another node leaked into this stop");
        var returnOptions = new InspectionOptions { Variables = [Definition(), Definition("return", "$return")] };
        var ordinary = new NativeInspection(returnOptions, new(), Thread(), _ => throw new Exception("scope must not evaluate"));
        Tests.Check(Json(ordinary.Scope()).GetProperty("variables").GetArrayLength() == 1, "return value appeared outside the native return event");
        var nativeReturn = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(),
            Thread(topType: BreakpointType.AtFunctionReturn), request => {
                var row = XElement.Parse(request).Elements().Single();
                Tests.Check(row.Attribute("name")?.Value == "$return" && row.Attribute("level")?.Value == "1", "return lost native frame/address");
                return "<vars><local name=\"$return\">42</local></vars>";
            });
        var returnRow = Json(nativeReturn.Scope()).GetProperty("variables").EnumerateArray().Single(v => v.GetProperty("category").GetString() == "return");
        Tests.Check(returnRow.GetProperty("variableKey").ValueKind == JsonValueKind.Null, "runtime return invented a model key");
        var returnRef = returnRow.GetProperty("reference").GetString();
        Tests.Check(Json(nativeReturn.Read(new Request { Op = "read", Reference = returnRef })).GetProperty("value").GetProperty("value").GetString() == "42", "native return value unavailable");
        nativeReturn.SelectFrame(0);
        Tests.Check(Json(nativeReturn.Scope()).GetProperty("variables").GetArrayLength() == 1, "top frame return leaked into another frame");
        try { nativeReturn.Read(new Request { Op = "read", Reference = returnRef }); throw new Exception("return reference survived frame change"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_reference", "wrong return invalidation failure"); }
        var unboundReturn = new NativeInspection(new InspectionOptions(), new(), Thread(topType: BreakpointType.AtFunctionReturn), _ => throw new Exception("scope must not evaluate"));
        Tests.Check(Json(unboundReturn.Scope()).GetProperty("variables").GetArrayLength() == 0, "return exposed without its owner source binding");
        var batchCalls = 0; var batchValue = 1;
        var batchInspector = new NativeInspection(new InspectionOptions { Variables = [Definition("input", "Seed"), Definition("output", "Result")] }, new(), Thread(), request => {
            batchCalls++;
            var rows = XElement.Parse(request).Elements().ToArray();
            Tests.Check(rows.Length == 2, "batch split into individual native evaluations");
            return new XElement("vars", rows.Select(row => new XElement(row.Name, new XAttribute("name", row.Attribute("name")!.Value), batchValue))).ToString();
        });
        var batchRefs = Json(batchInspector.Scope()).GetProperty("variables").EnumerateArray().Select(v => v.GetProperty("reference").GetString()!).ToArray();
        var batch = Json(batchInspector.ReadMany(new Request { Op = "read-many", References = batchRefs, Depth = 2 }));
        Tests.Check(batchCalls == 1 && batch.GetProperty("values").GetArrayLength() == 2, "scope values were not evaluated in one native batch");
        batchValue++;
        var refreshedBatch = Json(batchInspector.ReadMany(new Request { Op = "read-many", References = batchRefs, Depth = 2 }));
        Tests.Check(batchCalls == 2 && refreshedBatch.GetProperty("values").EnumerateArray().All(v => v.GetProperty("changed").GetBoolean()), "batch refresh lost changed values");
        try { batchInspector.ReadMany(new Request { References = [batchRefs[0], "stale"] }); throw new Exception("mixed stale batch accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_reference" && batchCalls == 2, "stale batch evaluated before validating all references"); }
        try { batchInspector.ReadMany(new Request { References = [batchRefs[0], batchRefs[0]] }); throw new Exception("duplicate batch accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_invalid_inspection_references" && batchCalls == 2, "duplicate batch evaluated"); }
        foreach (var (nativeValue, isUndefined) in new[] { ("-undefined-", true), ("\"-undefined-\"", false), ("0", false) }) {
            var sentinelInspector = new NativeInspection(new InspectionOptions { Variables = [Definition("timer", "Timers.Nightly")] }, new(), Thread(),
                _ => new XElement("vars", new XElement("timer", new XAttribute("name", "Timers.Nightly"), nativeValue)).ToString());
            var sentinelRef = Json(sentinelInspector.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
            var sentinel = Json(sentinelInspector.Read(new Request { Reference = sentinelRef })).GetProperty("value");
            Tests.Check(sentinel.GetProperty("undefined").GetBoolean() == isUndefined &&
                sentinel.GetProperty("valueComplete").GetBoolean() != isUndefined &&
                !sentinel.GetProperty("unavailable").GetBoolean() && sentinel.GetProperty("value").GetString() == nativeValue,
                "native undefined sentinel was counted as a runtime value or confused with quoted Text/SDK unavailable");
        }
        foreach (var (nativeValue, summary) in new[] { ("BinaryData (0 bytes)", true), ("BinaryData (256 bytes)", true),
            ("\"BinaryData (256 bytes)\"", false), ("42", false) }) {
            var binaryInspector = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), Thread(),
                _ => new XElement("vars", new XElement("local", new XAttribute("name", "Rows"), nativeValue)).ToString());
            var binaryReference = Json(binaryInspector.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
            var displayed = Json(binaryInspector.Read(new Request { Reference = binaryReference })).GetProperty("value");
            Tests.Check(displayed.GetProperty("nativeSummary").GetBoolean() == summary &&
                displayed.GetProperty("valueComplete").GetBoolean() != summary && displayed.GetProperty("value").GetString() == nativeValue,
                "binary byte-count summary must not claim complete bytes or misclassify quoted Text");
        }
        foreach (var category in new[] { "local", "input", "output", "return", "session", "site", "setting", "timer" }) {
            var path = category == "return" ? "$return" : category == "timer" ? "Timers.Nightly" : category == "session" ? "Fixture.UserID" : "Rows";
            if (category is "site" or "setting") {
#if ODC
                path = "00000000-0000-0000-0000-000000000001.00000000-0000-0000-0000-000000000002";
#else
                path = "Fixture.Setting";
#endif
            }
            var definition = Definition(category, path); definition.Validate();
            var container = new NativeInspectionVariable(definition);
            NativeInspectionEvaluator.Evaluate(container, 1, 2, request => {
                var row = XElement.Parse(request).Elements().Single();
                Tests.Check(row.Name.LocalName == definition.Tag && row.Attribute("name")?.Value == path, "native category/path lost");
                Tests.Check(row.Attribute("level")?.Value == (definition.Tag == "local" ? "1" : null), "nonlocal category has frame level");
                return new XElement("vars", new XElement(definition.Tag, new XAttribute("name", path), "42")).ToString();
            });
            Tests.Check(container.Evaluated && container.Type == VariableType.Scalar && container.Value == "42", "installed SDK did not evaluate scalar");
        }
        var revision = 0; var requested = "";
        var inspector = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), Thread(), request => {
            var row = XElement.Parse(request).Elements().Single(); requested = row.Attribute("name")!.Value;
            if (requested == "Rows.[151].Count") return "<vars><local name=\"Rows.[151].Count\">151</local></vars>";
            return new XElement("vars", new XElement("local", new XAttribute("name", "Rows"), new XElement("Record.List", new XAttribute("Length", 201),
                Enumerable.Range(0, 201).Select(i => new XElement("Structure", new XAttribute("debug.field", "[" + i + "]"), new XAttribute("Count", i + revision), new XAttribute("Password", "private-fixture")))))).ToString();
        });
        var scope = Json(inspector.Scope()); var reference = scope.GetProperty("variables")[0].GetProperty("reference").GetString();
        var first = Json(inspector.Read(new Request { Op = "read", Reference = reference, Depth = 2, Limit = 150 }));
        Tests.Check(first.GetProperty("children").GetArrayLength() == 150 && first.GetProperty("nextOffset").GetInt32() == 150, "native children silently cut");
        Tests.Check(first.GetProperty("availableChildren").GetInt32() == 202, "native SDK did not expose all list children");
        Tests.Check(first.GetProperty("children")[1].GetProperty("path").GetString() == "Rows.[0]", "native list child lost protocol separator");
        Tests.Check(!first.GetRawText().Contains("private-fixture"), "compound native InnerText leaked nested secret");
        var page = Json(inspector.Read(new Request { Op = "expand", Reference = reference, Offset = 150, Limit = 150, Depth = 2 }));
        Tests.Check(page.GetProperty("children").GetArrayLength() == 52, "continuation lost list tail");
        Tests.Check(page.GetProperty("changed").GetBoolean() == false, "unchanged reevaluation misreported");
        revision++;
        var refresh = Json(inspector.Read(new Request { Op = "refresh", Reference = reference, Depth = 2 }));
        Tests.Check(refresh.GetProperty("changed").GetBoolean(), "changed value invisible after native reevaluation");
        var child = Json(inspector.Read(new Request { Op = "expand", Reference = reference, ChildPath = "[151].Count" }));
        Tests.Check(requested == "Rows.[151].Count" && child.GetProperty("value").GetProperty("value").GetString() == "151", "native child path beyond first page not evaluated");
        inspector.SelectFrame(0);
        try { inspector.Read(new Request { Op = "read", Reference = reference }); throw new Exception("old frame ref accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_reference", "wrong stale failure"); }
        Tests.Check(first.GetProperty("collectionCoverage").GetProperty("complete").GetBoolean(), "complete native collection reported partial");
        var tailReads = 0; var tailRevision = 0;
        var capped = new NativeInspection(new InspectionOptions { Variables = [Definition()] }, new(), Thread(), request => {
            var row = XElement.Parse(request).Elements().Single(); var address = row.Attribute("name")!.Value;
            if (address == "Rows.[150]") {
                tailReads++;
                return new XElement("vars", new XElement("local", new XAttribute("name", address),
                    new XElement("Structure", new XAttribute("Count", 150 + tailRevision)))).ToString();
            }
            return new XElement("vars", new XElement("local", new XAttribute("name", "Rows"), new XElement("Record.List", new XAttribute("Length", 151),
                Enumerable.Range(0, 150).Select(i => new XElement("Structure", new XAttribute("debug.field", "[" + i + "]"), new XAttribute("Count", i)))))).ToString();
        });
        var cappedRef = Json(capped.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
        var coverage = Json(capped.Read(new Request { Op = "read", Reference = cappedRef, Depth = 2 })).GetProperty("collectionCoverage");
        Tests.Check(!coverage.GetProperty("complete").GetBoolean() && coverage.GetProperty("missingItems").GetInt64() == 1,
            "native list cap was mistaken for complete pagination");
        var tailPage = Json(capped.Read(new Request { Op = "read", Reference = cappedRef, Depth = 2, Offset = 150, Limit = 150 }));
        Tests.Check(tailReads == 1 && tailPage.GetProperty("children").GetArrayLength() == 2 &&
            tailPage.GetProperty("availableChildren").GetInt64() == 152 && tailPage.GetProperty("nextOffset").ValueKind == JsonValueKind.Null,
            "missing native item was not evaluated on the continuation page");
        var tailRef = tailPage.GetProperty("children")[1].GetProperty("reference").GetString(); tailRevision++;
        var tailRead = Json(capped.Read(new Request { Op = "read", Reference = tailRef, Depth = 2 }));
        Tests.Check(tailReads == 2 && tailRead.GetProperty("children")[0].GetProperty("value").GetString() == "151",
            "continued child reference did not reevaluate native value");
        var tailRefresh = Json(capped.Read(new Request { Op = "read", Reference = cappedRef, Depth = 2, Offset = 150, Limit = 150 }));
        Tests.Check(tailRefresh.GetProperty("changed").GetBoolean(), "changed item beyond the native enumeration was invisible in page reevaluation");
        var malformedCalls = 0;
        var malformed = new NativeInspectionVariable(Definition());
        NativeInspectionEvaluator.Evaluate(malformed, 1, 2, request => {
            malformedCalls++; var detail = XElement.Parse(request).Elements().Single().Attribute("detail")!.Value;
            return detail == "2" ? "<vars><local" : "<vars><local name=\"Rows\"><Structure Count=\"150\" /></local></vars>";
        });
        Tests.Check(malformedCalls == 2 && malformed.EvaluationDetail == 3 && malformed.Children["Count"].Value == "150",
            "malformed native detail 2 did not use valid native detail 3");
        var blockedXmlCalls = 0;
        try {
            NativeInspectionEvaluator.Evaluate(new NativeInspectionVariable(Definition()), 1, 2, _ => {
                blockedXmlCalls++; return "<!DOCTYPE vars [<!ENTITY x SYSTEM 'file:///private'>]><vars><local name=\"Rows\">&x;</local></vars>";
            });
            throw new Exception("DTD accepted");
        } catch (System.Xml.XmlException) { Tests.Check(blockedXmlCalls == 1, "blocked XML was retried"); }
        var transportCalls = 0;
        try {
            NativeInspectionEvaluator.Evaluate(new NativeInspectionVariable(Definition()), 1, 2, _ => {
                transportCalls++; throw new System.Net.WebException("PRIVATE_TRANSPORT");
            });
            throw new Exception("transport error accepted");
        } catch (System.Net.WebException) { Tests.Check(transportCalls == 1, "uncertain transport was retried"); }
        var longText = new string('x', 9000) + "TAIL";
        var textInspector = new NativeInspection(new InspectionOptions { Variables = [Definition("local", "Description")] }, new(), Thread(), _ =>
            new XElement("vars", new XElement("local", new XAttribute("name", "Description"), longText)).ToString());
        var textRef = Json(textInspector.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
        var assembled = ""; var offset = 0;
        do {
            var fragment = Json(textInspector.Read(new Request { Op = "read", Reference = textRef, TextOffset = offset, TextLimit = 4096, Depth = 2 })).GetProperty("value");
            assembled += fragment.GetProperty("value").GetString();
            Tests.Check(!fragment.GetProperty("valueComplete").GetBoolean(), "a text fragment was marked as complete value");
            if (fragment.GetProperty("nextTextOffset").ValueKind == JsonValueKind.Null) break;
            offset = fragment.GetProperty("nextTextOffset").GetInt32();
        } while (true);
        Tests.Check(assembled == longText, "inspection cut text beyond 4096 instead of returning continuation");
        var jsonText = JsonSerializer.Serialize(Enumerable.Range(0, 301).Select(i => new { Number = i, Password = "private-fixture" }));
        foreach (var plain in new[] { "[redacted]", "{placeholder}", "[unfinished", "{\"unfinished\":", "[1] trailing", "  [plain Ω😀]  " }) {
            var textValue = DebugPolicy.FullValue("Description", plain, complete: true);
            Tests.Check((string?)textValue == plain, "ordinary bracketed Text was rejected or rewritten as JSON");
            var literalInspector = new NativeInspection(new InspectionOptions { Variables = [Definition("local", "Description")] }, new(), Thread(),
                _ => new XElement("vars", new XElement("local", new XAttribute("name", "Description"), plain)).ToString());
            var literalRef = Json(literalInspector.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
            var literalRead = Json(literalInspector.Read(new Request { Reference = literalRef })).GetProperty("value");
            Tests.Check(literalRead.GetProperty("value").GetString() == plain && literalRead.GetProperty("valueComplete").GetBoolean(),
                "native scalar Text inspection lost a literal or marked it incomplete");
            var nestedText = JsonSerializer.Serialize(new { Description = plain, Password = "private-fixture" });
            var filtered = (string)DebugPolicy.FullValue("Response", nestedText, complete: true)!;
            using var nestedDoc = JsonDocument.Parse(filtered);
            Tests.Check(nestedDoc.RootElement.GetProperty("Description").GetString() == plain && !filtered.Contains("private-fixture"),
                "invalid JSON inside Text prevented sibling secret redaction");
        }
        var privateText = new DebugPolicy.PrivateValues(); privateText.Add("private-fixture");
        Tests.Check((string?)DebugPolicy.FullValue("Description", "[private-fixture]", privateText, complete: true) == DebugPolicy.Redacted,
            "malformed JSON Text bypassed private-value protection");
        try {
            DebugPolicy.FullValue("Response", new string('[', 65) + "0" + new string(']', 65), complete: true);
            throw new Exception("JSON depth limit fell back to unfiltered text");
        } catch (DebugFailure e) { Tests.Check(e.Message == "debug_inspection_json_depth_limit", "wrong JSON depth refusal"); }
        var fullJson = (string)DebugPolicy.FullValue("Response", jsonText, complete: true)!;
        using (var document = JsonDocument.Parse(fullJson)) {
            Tests.Check(document.RootElement.GetArrayLength() == 301 && document.RootElement[300].GetProperty("Number").GetInt32() == 300 && !fullJson.Contains("private-fixture"), "complete JSON inspection lost tail or leaked secrets");
        }
        foreach (var (json, withheld) in new[] {
            ("{\"Number\":5,\"Password\":\"private-fixture\"}", true),
            ("{\"Envelope\":\"{\\\"Password\\\":\\\"private-fixture\\\"}\"}", true),
            ("{ \"Number\" : 5, \"Message\" : \"ordinary text\" }", false)
        }) {
            var jsonInspector = new NativeInspection(new InspectionOptions { Variables = [Definition("local", "Response")] }, new(), Thread(),
                _ => new XElement("vars", new XElement("local", new XAttribute("name", "Response"), json)).ToString());
            var jsonRef = Json(jsonInspector.Scope()).GetProperty("variables")[0].GetProperty("reference").GetString();
            var inspected = Json(jsonInspector.Read(new Request { Reference = jsonRef, TextLimit = 16384 }));
            Tests.Check(inspected.GetProperty("redacted").GetBoolean() == withheld &&
                inspected.GetProperty("value").GetProperty("redacted").GetBoolean() == withheld &&
                inspected.GetProperty("value").GetProperty("valueComplete").GetBoolean() != withheld &&
                !inspected.GetRawText().Contains("private-fixture"),
                "partially redacted JSON claimed a complete runtime value or clean JSON normalization was treated as redaction");
        }
        var config = new Configuration { SessionId = Guid.NewGuid().ToString("N"), RuntimeUrl = "https://example.invalid/App/", Module = "Fixture", ModuleKey = Tests.ModuleKey,
            NodeKeys = [Tests.NodeKey], AutoContinue = false, PauseSeconds = 1, Inspection = new() { Variables = [Definition()] } };
        config.Validate(); var fake = new FakeTransport();
        await using var session = new DebugSession(config, fake); await session.Start(); await fake.Pause(Thread());
        await Task.Delay(1100); await session.ReleaseExpiredPauses();
        Tests.Check(fake.Commands == 0, "interactive stop silently auto-resumed");
        var sessionScope = Json(await session.Execute(new Request { Op = "scope", ThreadId = "T1", EventId = "1" }));
        Tests.Check(sessionScope.GetProperty("variables").GetArrayLength() == 1, "session scope absent");
        await session.Execute(new Request { Op = "step-into", ThreadId = "T1", EventId = "1" });
        var requestedPause = Json(await session.Execute(new Request { Op = "pause" }));
        Tests.Check(requestedPause.GetProperty("pauseRequest").GetProperty("requested").GetBoolean() && fake.Ops.Last() == "pause",
            "manual pause did not call the original session suspend operation");
        var commandCount = fake.Commands;
        try { await session.Execute(new Request { Op = "pause" }); throw new Exception("pending pause replay accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_pause_already_pending_or_stopped" && fake.Commands == commandCount, "pause replay reached server"); }
        await fake.Pause(Thread(2));
        Tests.Check(!Json(session.Status()).GetProperty("pauseRequest").GetProperty("requested").GetBoolean(), "observed native stop did not settle pause request");
        try { await session.Execute(new Request { Op = "scope", ThreadId = "T1", EventId = "1" }); throw new Exception("resumed scope accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_stale_stop", "wrong resumed failure"); }
        var failedTransport = new FakeTransport { ThrowOnExecute = true };
        await using var failedPause = new DebugSession(config, failedTransport); await failedPause.Start();
        try { await failedPause.Execute(new Request { Op = "pause" }); throw new Exception("uncertain pause accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_pause_uncertain", "pause failure was hidden"); }
        try { await failedPause.Execute(new Request { Op = "pause" }); throw new Exception("uncertain pause replay accepted"); }
        catch (DebugFailure e) { Tests.Check(e.Message == "debug_session_not_connected" && failedTransport.Commands == 1, "uncertain pause was repeated"); }
        Console.WriteLine("Native inspection: installed SDK categories, return, pagination, reevaluation, frame invalidation and interactive lease passed (synthetic values).");
    }
}
