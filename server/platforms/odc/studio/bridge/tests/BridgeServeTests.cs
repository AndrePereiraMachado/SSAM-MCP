using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

// The bridge-hang family without a Studio (BridgeServe.cs): one failed connection never ends the command server, a
// re-attach starts a server that ended, a job queued on a Studio tab either starts within its bound or is abandoned and
// never runs, a command past its deadline blocks nothing but the Studio turn it holds. The pipe tests use real named pipes
// in this process. The source rules check that StartupHook.cs uses them at every site.
public sealed class BridgeServeTests {
    private static string BridgeSource([CallerFilePath] string here = "") =>
        File.ReadAllText(Path.Combine(Path.GetDirectoryName(here)!, "..", "StartupHook.cs"));

    [Fact]
    public async Task A_client_that_left_before_its_answer_never_ends_the_server() {
        var calls = 0; var recorded = new List<Exception>();
        await ServeLoop.Run(async () => {
            calls++;
            await Task.Yield();
            if (calls == 1) throw new IOException("Pipe is broken.");
            return calls < 3; // the third connection is the stop command
        }, recorded.Add, _ => Task.CompletedTask);
        Assert.Equal(3, calls);
        Assert.Single(recorded);
        Assert.IsType<IOException>(recorded[0]);
    }

    [Fact]
    public async Task A_server_that_cannot_create_its_pipe_backs_off_and_gives_up_recorded() {
        var waits = new List<TimeSpan>(); var recorded = new List<Exception>();
        await ServeLoop.Run(() => throw new UnauthorizedAccessException("pipe"), recorded.Add, d => { waits.Add(d); return Task.CompletedTask; }, maxConsecutiveFailures: 4);
        Assert.Equal(new[] { 250, 500, 1000 }, waits.Select(w => (int)w.TotalMilliseconds).ToArray());
        Assert.Equal(5, recorded.Count); // four failures and the reason it stopped
        Assert.Contains("attach again", recorded[^1].Message);
    }

    [Fact]
    public async Task Attaching_again_starts_a_server_that_ended_and_keeps_one_that_runs() {
        var slot = new ServerSlot(); var gate = new TaskCompletionSource();
        Assert.True(slot.Ensure(() => gate.Task));
        Assert.False(slot.Ensure(() => Task.CompletedTask), "a running server is kept: one pipe per version and Studio");
        gate.SetResult();
        for (var i = 0; i < 100 && slot.IsRunning; i++) await Task.Delay(10);
        Assert.False(slot.IsRunning);
        Assert.True(slot.Ensure(() => Task.Delay(Timeout.Infinite)), "an ended server is started again by the next attach");
        Assert.True(slot.IsRunning);
    }

    [Fact]
    public async Task A_queued_job_the_tab_never_ran_is_abandoned_and_never_runs_later() {
        var job = new QueuedJob();
        Assert.False(await job.StartedWithin(TimeSpan.FromMinutes(2), _ => Task.CompletedTask));
        Assert.True(job.IsAbandoned);
        Assert.False(job.TryStart(), "the tab runs the callback later: it must do nothing");
        Assert.False(job.IsStarted);
    }

    [Fact]
    public async Task A_queued_job_that_starts_in_time_runs_once_and_is_never_abandoned() {
        var job = new QueuedJob();
        var never = new TaskCompletionSource();
        var wait = job.StartedWithin(TimeSpan.FromMinutes(2), _ => never.Task);
        Assert.True(job.TryStart());
        Assert.True(await wait);
        Assert.False(job.Abandon());
        Assert.False(job.TryStart(), "runs once");
    }

    [Fact]
    public async Task A_job_that_starts_as_the_bound_passes_is_reported_started_not_abandoned() {
        var job = new QueuedJob();
        Assert.True(await job.StartedWithin(TimeSpan.FromSeconds(1), _ => { job.TryStart(); return Task.CompletedTask; }));
        Assert.True(job.IsStarted);
    }

    [Fact]
    public async Task A_tab_that_never_becomes_idle_gets_a_refusal_at_the_bound_and_the_job_never_runs_later() {
        Action? callback = null; var ran = 0; DateTimeOffset? recorded = null;
        var clock = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<JobNotStartedException>(() => TabQueue.Run(job => { callback = job; return new TaskCompletionSource().Task; }, "merge", "Fixture", TimeSpan.FromMilliseconds(100),
            () => { ran++; return "ran"; }, queuedAt => { recorded = queuedAt; return Task.FromResult<string?>("{\"idle\":false}"); }));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10));
        Assert.Equal("MERGE_NOT_STARTED", error.Token);
        Assert.NotNull(recorded);
        callback!(); // the tab becomes idle after all
        Assert.Equal(0, ran);
    }

    [Fact]
    public async Task A_tab_that_runs_the_job_in_time_answers_its_result_or_its_error() {
        Assert.Equal("ran", await TabQueue.Run(job => { job(); return Task.CompletedTask; }, "merge", "Fixture", TimeSpan.FromSeconds(30), () => "ran", _ => Task.FromResult<string?>(null)));
        var error = await Assert.ThrowsAsync<ArgumentException>(() => TabQueue.Run<string>(job => { job(); return Task.CompletedTask; }, "merge", "Fixture", TimeSpan.FromSeconds(30), () => throw new ArgumentException("native"), _ => Task.FromResult<string?>(null)));
        Assert.Equal("native", error.Message);
    }

    [Fact]
    public async Task A_tab_that_drops_the_job_answers_at_once_and_the_job_never_runs() {
        var clock = Stopwatch.StartNew(); Action? callback = null; var ran = 0;
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => TabQueue.Run(job => { callback = job; return Task.FromException(new InvalidOperationException("the tab closed")); }, "merge", "Fixture", TimeSpan.FromMinutes(2),
            () => { ran++; return "ran"; }, _ => Task.FromResult<string?>(null)));
        Assert.Equal("the tab closed", error.Message);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(30));
        callback!();
        Assert.Equal(0, ran);
    }

    [Fact]
    public void The_refusal_of_a_job_not_started_names_its_token_and_the_studio_busy_gate() {
        var merge = new JobNotStartedException("merge", "OrderPortal", TimeSpan.FromMinutes(2), "{\"idle\":false}");
        Assert.StartsWith("MERGE_NOT_STARTED:", merge.Message);
        Assert.Contains("did not become idle", merge.Message);
        Assert.Contains("nothing was executed", merge.Message);
        Assert.Equal("STUDIO_NOT_IDLE", new JobNotStartedException("close", "OrderPortal", TimeSpan.FromMinutes(2), null).Token);
        var reconcile = new JobNotStartedException("reconcile-merge", "OrderPortal", TimeSpan.FromMinutes(2), null);
        Assert.Equal("STUDIO_NOT_IDLE", reconcile.Token);
        Assert.DoesNotContain("deliver again", reconcile.Message);
        Assert.Contains("deliver again", merge.Message);
    }

    [Fact]
    public void The_command_server_runs_in_ServeLoop_and_Start_revives_it() {
        var source = BridgeSource();
        Assert.Contains("ServeLoop.Run(", source);
        Assert.DoesNotContain("Interlocked.Exchange(ref started", source);
    }

    [Fact]
    public void The_server_writes_nothing_before_its_data_root_is_in_use_and_one_file_per_Studio() {
        var source = BridgeSource();
        var start = Regex.Match(source, @"internal static void Start\(\) \{(.*?)\n    \}", RegexOptions.Singleline).Groups[1].Value;
        Assert.DoesNotContain("TryWrite", start);
        var record = Regex.Match(source, @"private static void RecordServerError\(Exception error\) \{(.*?)\n    \}", RegexOptions.Singleline).Groups[1].Value;
        Assert.Contains("if (rootInUse)", record);
        Assert.DoesNotContain("yyyyMMdd", record);
    }

    [Fact]
    public void Every_job_queued_on_an_idle_tab_is_bounded() {
        // A queued job is bounded when it goes through QueuedOnTab (TabQueue), the verification of a merge (VerifyAfterMerge, which
        // is TabQueue), or (open) waits for its own started signal with a bound.
        var source = BridgeSource();
        var lines = source.Split('\n');
        var unbounded = new List<string>();
        for (var i = 0; i < lines.Length; i++) {
            if (!Regex.IsMatch(lines[i], @"\.ExecuteInContext\(") || lines[i].Contains("executeWhenTopLevelIsIdle: false")) continue;
            var window = string.Join("\n", lines.Skip(Math.Max(0, i - 3)).Take(16));
            if (window.Contains("TabQueue.Run(") || window.Contains("VerifyAfterMerge.Run(") || window.Contains("Task.WhenAny(started.Task")) continue;
            unbounded.Add((i + 1) + ": " + lines[i].Trim());
        }
        Assert.True(unbounded.Count == 0, "Unbounded queued jobs:\n" + string.Join("\n", unbounded));
    }

    [Fact]
    public void Every_deadline_is_read_from_the_one_table_and_no_wait_of_the_server_is_unbounded() {
        var source = BridgeSource();
        Assert.Contains("BridgeDeadlines.For(command, argument)", source);
        Assert.DoesNotContain("TimeSpan.FromMinutes(15)", source);
        // The answer of a late command never waits for a UI that may be what the command holds.
        Assert.DoesNotContain("DescribeDialogs(await Ui(Dialogs));", source);
        Assert.Contains("await Ui(Dialogs).WaitAsync(BridgeDeadlines.Dialogs)", source);
    }

    // ---- real named pipes: one server, one fake Studio per test.

    private sealed class Server : IAsyncDisposable {
        public readonly string Name = "ODC3-Bridge-test-" + Guid.NewGuid().ToString("N");
        public readonly List<Exception> Recorded = new();
        public readonly List<(string Command, Exception Error)> Undelivered = new();
        public readonly Dictionary<string, TaskCompletionSource<object>> Holds = new();
        public readonly CommandGate Gate = new();
        public int Ran;
        private readonly Task loop;
        private readonly TimeSpan deadline;
        private readonly CommandRunner runner;
        public Server(TimeSpan deadline, TimeSpan? turnWait = null) {
            this.deadline = deadline;
            runner = new CommandRunner(Gate, turnWait ?? TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(100));
            var pipes = new PipeServer(Name, Serve, Note, TimeSpan.FromMilliseconds(300), TimeSpan.FromSeconds(5));
            loop = ServeLoop.Run(pipes.AcceptOne, Note, _ => Task.CompletedTask);
        }
        private void Note(Exception error) { lock (Recorded) Recorded.Add(error); }
        // The same answers as StartupHook.cs ServeLine.
        private async Task<PipeAnswer> Serve(string line) {
            if (line == "stop") return new PipeAnswer("{\"stopped\":true}", Stop: true);
            var run = await runner.Run(line, deadline, holder => {
                Interlocked.Increment(ref Ran);
                lock (Holds) return Holds.TryGetValue(line, out var hold) ? hold.Task : Task.FromResult<object>(new { ok = true, ran = line });
            });
            var answer = run.End == CommandEnd.Busy ? JsonSerializer.Serialize(new { ok = false, code = "BRIDGE_BUSY", busyCommand = run.Holder?.Command })
                : run.End == CommandEnd.Overran ? JsonSerializer.Serialize(new { ok = false, outcome = "uncertain", overran = line })
                : JsonSerializer.Serialize(await run.Work!);
            return new PipeAnswer(answer, false, error => { lock (Undelivered) Undelivered.Add((line, error)); });
        }
        public TaskCompletionSource<object> Hold(string command) { var hold = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously); lock (Holds) Holds[command] = hold; return hold; }
        public void Free(string command, TaskCompletionSource<object> hold) { lock (Holds) Holds.Remove(command); hold.TrySetResult(new { ok = true, ran = command }); }
        public async Task<JsonElement> Call(string line) {
            using var client = new NamedPipeClientStream(".", Name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(10000);
            await client.WriteAsync(Encoding.UTF8.GetBytes(line + "\n"));
            using var reader = new StreamReader(client);
            var text = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
            return JsonDocument.Parse(text!).RootElement.Clone();
        }
        // Connects, sends the command and leaves: what a client past its own deadline does.
        public async Task SendAndLeave(string line) {
            using var client = new NamedPipeClientStream(".", Name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(10000);
            await client.WriteAsync(Encoding.UTF8.GetBytes(line + "\n"));
            await client.FlushAsync();
        }
        public async Task<bool> Stopped() { await Call("stop"); return await Task.WhenAny(loop, Task.Delay(5000)) == loop; }
        public async ValueTask DisposeAsync() { if (!loop.IsCompleted) try { await Call("stop"); } catch { } }
    }

    private static async Task Until(Func<bool> condition, string what) {
        var clock = Stopwatch.StartNew();
        while (!condition()) { if (clock.Elapsed > TimeSpan.FromSeconds(20)) throw new TimeoutException(what); await Task.Delay(10); }
    }

    [Fact]
    public async Task A_closed_pipe_during_the_answer_is_recorded_and_the_loop_keeps_accepting() {
        await using var server = new Server(TimeSpan.FromSeconds(30));
        var hold = server.Hold("merge m.json");
        await server.SendAndLeave("merge m.json");
        await Until(() => Volatile.Read(ref server.Ran) == 1, "the command never ran");
        server.Free("merge m.json", hold); // the bridge answers now, onto a closed pipe
        await Until(() => { lock (server.Undelivered) return server.Undelivered.Count == 1; }, "the lost answer was not reported");
        Assert.Equal("merge m.json", server.Undelivered[0].Command);
        var next = await server.Call("snapshot M");
        Assert.True(next.GetProperty("ok").GetBoolean(), "the next call is served");
    }

    [Fact]
    public async Task A_command_past_its_deadline_answers_uncertain_keeps_its_turn_and_the_next_call_is_answered_at_once() {
        await using var server = new Server(TimeSpan.FromMilliseconds(100));
        var hold = server.Hold("merge m.json");
        var late = await server.Call("merge m.json");
        Assert.Equal("uncertain", late.GetProperty("outcome").GetString());
        // The merge still runs: the next write is refused at once, naming it, and never runs on top of it.
        var clock = Stopwatch.StartNew();
        var refused = await server.Call("snapshot M");
        Assert.Equal("BRIDGE_BUSY", refused.GetProperty("code").GetString());
        Assert.Equal("merge m.json", refused.GetProperty("busyCommand").GetString());
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), "refused without waiting for the merge");
        Assert.Equal(1, Volatile.Read(ref server.Ran));
        // Status reads beside it.
        Assert.True((await server.Call("status")).GetProperty("ok").GetBoolean());
        // The late merge ends: the turn is free and nothing stays queued.
        server.Free("merge m.json", hold);
        await Until(() => server.Gate.Holder == null, "the turn stayed held");
        Assert.True((await server.Call("snapshot M")).GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task A_command_that_never_ends_keeps_status_and_refusals_answering() {
        await using var server = new Server(TimeSpan.FromMilliseconds(100));
        var hold = server.Hold("publish m.json");
        Assert.Equal("uncertain", (await server.Call("publish m.json")).GetProperty("outcome").GetString());
        for (var i = 0; i < 20; i++) {
            Assert.True((await server.Call("auth-status")).GetProperty("ok").GetBoolean());
            Assert.Equal("BRIDGE_BUSY", (await server.Call("merge m.json")).GetProperty("code").GetString());
        }
        server.Free("publish m.json", hold);
    }

    [Fact]
    public void A_refusal_past_the_deadline_says_a_restart_ends_it_who_does_it_and_what_it_costs() {
        var holder = new BusyCommand("merge", DateTimeOffset.UtcNow);
        var inTime = BusyCommand.Refusal(holder, "snapshot");
        Assert.Contains("still running", inTime);
        Assert.DoesNotContain("restart", inTime, StringComparison.OrdinalIgnoreCase);
        Assert.Null(holder.Advice);
        holder.Overran = true;
        foreach (var text in new[] { BusyCommand.Refusal(holder, "snapshot"), BusyCommand.Refusal(holder, "status"), holder.Advice! }) {
            Assert.Contains("restarting ODC Studio", text);
            Assert.Contains("that is the person's call, when it suits them", text);
            Assert.Contains("what the open modules had not saved or published may be lost", text);
            // Nothing measured what closing asks for, or what an autosave keeps: no absolute about them.
            Assert.DoesNotContain("no click", text);
            Assert.DoesNotContain("autosave", text);
            Assert.Contains("dismiss-dialog", text);
            Assert.Contains("UI answers again", text);
        }
        // A status is never told that only status is accepted.
        Assert.DoesNotContain("status answers until", BusyCommand.Refusal(holder, "status"));
        Assert.Contains("did not answer this status", BusyCommand.Refusal(holder, "status"));
    }

    [Fact]
    public async Task A_second_command_waits_its_turn_when_the_first_ends_in_time() {
        await using var server = new Server(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(10));
        var hold = server.Hold("snapshot A");
        var first = server.Call("snapshot A");
        await Until(() => server.Gate.Holder != null, "the first command never took the turn");
        var second = server.Call("snapshot B");
        await Task.Delay(100);
        server.Free("snapshot A", hold);
        Assert.Equal("snapshot A", (await first).GetProperty("ran").GetString());
        Assert.Equal("snapshot B", (await second).GetProperty("ran").GetString());
    }

    [Fact]
    public async Task A_client_that_connects_and_says_nothing_holds_nothing() {
        await using var server = new Server(TimeSpan.FromSeconds(30));
        using var silent = new NamedPipeClientStream(".", server.Name, PipeDirection.InOut, PipeOptions.Asynchronous);
        await silent.ConnectAsync(10000);
        Assert.True((await server.Call("status")).GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task The_stop_command_ends_the_loop() {
        var server = new Server(TimeSpan.FromSeconds(30));
        Assert.True(await server.Stopped());
    }

    // ---- the one table of deadlines (platforms/odc/facade/bridge-deadlines.json), against its samples; odc-pipe.mjs reads the same ones.

    private static JsonElement Table() {
        using var stream = typeof(BridgeDeadlines).Assembly.GetManifestResourceStream(BridgeDeadlines.Resource)!;
        return JsonDocument.Parse(stream).RootElement.Clone();
    }

    [Fact]
    public void The_deadlines_of_the_samples_are_the_table_rule() {
        foreach (var sample in Table().GetProperty("samples").EnumerateArray()) {
            var args = sample.GetProperty("args").EnumerateArray().Select(a => a.GetString()!).ToArray();
            var argument = string.Join(' ', args.Skip(1));
            Assert.Equal(sample.GetProperty("bridgeMs").GetInt32(), (int)BridgeDeadlines.For(args[0], argument).TotalMilliseconds);
            Assert.Equal(sample.GetProperty("clientMs").GetInt32(), (int)BridgeDeadlines.ClientWait(args[0], argument).TotalMilliseconds);
        }
    }

    [Fact]
    public void A_client_always_waits_past_the_bridge() {
        var table = Table();
        foreach (var command in table.GetProperty("commandSeconds").EnumerateObject().Select(p => p.Name).Append("publish --wait").Append("anything-else")) {
            var parts = command.Split(' ', 2);
            var argument = parts.Length > 1 ? "m.json " + parts[1] : "m.json";
            Assert.True(BridgeDeadlines.ClientWait(parts[0], argument) > BridgeDeadlines.For(parts[0], argument), command);
        }
        // A queued job gives up well before its command's deadline, and the Studio turn before any client.
        Assert.True(BridgeDeadlines.QueueStart < BridgeDeadlines.For("merge", "m.json"));
        Assert.True(BridgeDeadlines.QueueStart < BridgeDeadlines.For("check-base", "m.json"));
        // Every command that queues on a tab: its deadline outlives the bound of the queue, so "still running" is never said of a job that never runs.
        foreach (var queued in new[] { "close", "publish", "preview", "refresh-references", "reconcile-merge" })
            Assert.True(BridgeDeadlines.QueueStart < BridgeDeadlines.For(queued, "m.json"), queued);
        Assert.True(BridgeDeadlines.TurnWait < BridgeDeadlines.For("snapshot", "M"));
    }
}
