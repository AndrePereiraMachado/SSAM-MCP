using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.PluginAPI.Debugger;

// Tracer: every pause is dumped and immediately stepped; the budget and the focus action end the stepping;
// threads that are not ours are released without a dump; full values still hide credentials.
static class TraceTests {
    const string Target = "AwMDAwMDAwMDAwMDAwMDAw", Other = "BAQEBAQEBAQEBAQEBAQEBA", Inner = "BQUFBQUFBQUFBQUFBQUFBQ";
    // Entry pauses sit on Tests.NodeKey (the configured breakpoint); stepped pauses on Inner.
    static ThreadData Thread(string threadId, long eventId, string nodeKey, params string[] functions) {
        var module = ObjectKey.Parse(Tests.ModuleKey);
        var stack = functions.Select((f, level) => {
            var function = new Breakpoint(module, ObjectKey.Parse(f));
            var node = new Breakpoint(module, ObjectKey.Parse(nodeKey));
            // (level, module, action, functionId, functionType, breakpoint, previousBreakpoint, type, functionLeft); StackTop is the last element.
            return new StackElement(level, "Fixture", "Action" + level, function, "ServerAction", node, node, BreakpointType.Normal, "");
        }).ToArray();
        return new ThreadData(module, threadId, "Test", "", eventId, false, "PRIVATE-SESSION", true, stack, false);
    }
    internal static async Task Run() {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-trace-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try {
            var config = new Configuration {
                SessionId = Guid.NewGuid().ToString("N"), Module = "Fixture", ModuleKey = Tests.ModuleKey, RuntimeUrl = "https://example.invalid/App/",
                NodeKeys = [Tests.NodeKey], ReceiptPath = Path.Combine(dir, "receipt.json"),
                Trace = new TraceOptions { Mode = "step", Steps = 3, FullValues = true, RequireFunctionKey = Other, FocusFunctionKey = Target,
                    Scopes = new() { [Target] = ["Request", "Result"] } }
            };
            config.Validate();
            var fake = new FakeTransport { EvaluateAnswer = "<vars><local name=\"Request\"><Text name=\"Name\" value=\"banana\"/><Text name=\"Password\" value=\"hunter2\"/></local><local name=\"Result\"><Integer name=\"Count\" value=\"3\"/></local></vars>" };
            await using (var session = new DebugSession(config, fake)) {
                await session.Start();
                // Another user's request reaches the same breakpoint: released untouched, nothing recorded.
                await fake.Pause(Thread("U9", 1, Tests.NodeKey, Target));
                Tests.Check(fake.Ops.SequenceEqual(["continue"]) && fake.Evaluations == 0, "foreign thread must be released without a dump");
                // Our request: wrapper (Other) -> target (Target). Three visits stepped, then the budget continues.
                await fake.Pause(Thread("T1", 2, Inner, Other, Target));
                await fake.Pause(Thread("T1", 3, Inner, Other, Target));
                await fake.Pause(Thread("T1", 4, Inner, Other, Target));
                await fake.Pause(Thread("T1", 5, Inner, Other, Target));
                Tests.Check(fake.Ops.SequenceEqual(["continue", "step-into", "step-into", "continue", "continue"]), "step budget: " + string.Join(",", fake.Ops));
                var status = Wire.Json(session.Status());
                Tests.Check(status.Contains("\"count\":3") && status.Contains("banana") && !status.Contains("hunter2") && status.Contains("\"skippedThreads\":1"), "trace summary with full values and hidden secrets");
                // The traced request ends: one thread-end marker; a foreign thread that was never traced adds nothing.
                await fake.Emit(DebugTransportEvent.WithoutProvenance(new ThreadEndEvent(false, Thread("U9", 6, Tests.NodeKey, Target), 6)));
                await fake.Emit(DebugTransportEvent.WithoutProvenance(new ThreadEndEvent(false, Thread("T1", 7, Inner, Other, Target), 7)));
                await fake.Emit(DebugTransportEvent.WithoutProvenance(new ThreadEndEvent(false, Thread("T1", 8, Inner, Other, Target), 8)));
            }
            var lines = File.ReadAllLines(Path.Combine(dir, "trace.jsonl"));
            Tests.Check(lines.Length == 4 && lines.Take(3).All(l => l.Contains("\"functionKey\":\"" + Target + "\"")) && !lines.Any(l => l.Contains("hunter2")), "trace.jsonl holds each visit as it happened");
            Tests.Check(lines[3].Contains("\"kind\":\"thread-end\"") && lines[3].Contains("\"threadId\":\"T1\"") && lines[3].Contains("\"eventId\":\"7\""), "one thread-end marker per traced request: " + lines[3]);

            // Focus: the entry node is in the caller (target not yet on the stack) -> step INTO it; once the target
            // returned the session continues; a new request on a reused thread id starts stepping again at the entry.
            var focus = new FakeTransport();
            config.ReceiptPath = null; config.Trace = new TraceOptions { Mode = "step", Steps = 50, FocusFunctionKey = Target, Scopes = new() };
            await using (var session = new DebugSession(config, focus)) {
                await session.Start();
                await focus.Pause(Thread("T2", 10, Tests.NodeKey, Other));
                await focus.Pause(Thread("T2", 11, Inner, Other, Target));
                await focus.Pause(Thread("T2", 12, Inner, Other));
                await focus.Pause(Thread("T2", 13, Tests.NodeKey, Other));
                Tests.Check(focus.Ops.SequenceEqual(["step-into", "step-into", "continue", "step-into"]) && focus.Evaluations == 0, "focus approach/return: " + string.Join(",", focus.Ops));
            }
            foreach (var bad in new[] { new TraceOptions { Mode = "run" }, new TraceOptions { Steps = 0 }, new TraceOptions { Scopes = new() { ["bad key"] = ["X"] } } }) {
                config.Trace = bad;
                try { config.Validate(); throw new Exception("invalid trace accepted"); } catch (DebugFailure) { }
            }
            config.Trace = new TraceOptions(); config.NodeKeys = Enumerable.Range(0, 21).Select(i => Convert.ToBase64String(Enumerable.Repeat((byte)i, 16).ToArray()).TrimEnd('=').Replace('/', '_')).ToArray();
            config.Validate(); // a trace window may start at more than 20 entry nodes
        } finally { Directory.Delete(dir, true); }
    }
}
