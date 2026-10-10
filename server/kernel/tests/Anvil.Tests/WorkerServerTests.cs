using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Hosting;
using Xunit;
namespace Anvil.Tests;
public sealed class WorkerServerTests
{
    private static JsonObject Ok(string[] args) => new() { ["ok"] = true, ["command"] = args[0], ["data"] = new JsonObject { ["value"] = args[0] } };
    private static async Task<JsonObject> Send(int port, string command, string? authorization = null)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var client = new TcpClient(); await client.ConnectAsync("127.0.0.1", port, timeout.Token);
        using var stream = client.GetStream();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        using var reader = new StreamReader(stream, new UTF8Encoding(false));
        await writer.WriteLineAsync(new JsonObject { ["args"] = new JsonArray(command), ["authorization"] = authorization }.ToJsonString());
        return JsonNode.Parse((await reader.ReadLineAsync(timeout.Token))!)!.AsObject();
    }
    [Fact]
    public async Task AuthenticationCannotBeBypassedThroughTheWorkerProxy()
    {
        var calls = 0;
        using var server = new WorkerServer(0, args => { calls++; return Ok(args); },
            authorize: request => request["authorization"]?.ToString() == "test-credential");
        var run = server.RunAsync();
        try
        {
            Assert.True((await Send(server.Port, "ping"))["ok"]!.GetValue<bool>());
            var denied = await Send(server.Port, "deliver");
            Assert.False(denied["ok"]!.GetValue<bool>()); Assert.False(denied["executed"]!.GetValue<bool>());
            Assert.False((await Send(server.Port, "deliver", "wrong"))["ok"]!.GetValue<bool>());
            Assert.Equal(0, calls);
            Assert.True((await Send(server.Port, "deliver", "test-credential"))["ok"]!.GetValue<bool>());
            Assert.Equal(1, calls);
        }
        finally { server.Stop(); await run; }
    }

    [Fact]
    public async Task PingRemainsResponsiveAndTwoCommandsExecuteSerially()
    {
        using var release = new ManualResetEventSlim(); using var entered = new ManualResetEventSlim();
        var order = new List<string>();
        using var server = new WorkerServer(0, args =>
        {
            if (args[0] == "first") { entered.Set(); release.Wait(TimeSpan.FromSeconds(10)); }
            order.Add(args[0]); return Ok(args);
        }, heap: () => 0); // Transport scheduling must not depend on heap retained by other native-model tests.
        var run = server.RunAsync();
        try
        {
            var first = Send(server.Port, "first");
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
            var second = Send(server.Port, "second");
            JsonObject status;
            do { status = (await Send(server.Port, "ping"))["data"]!.AsObject(); } while (status["queued"]!.GetValue<int>() == 0);
            Assert.True(status["busy"]!.GetValue<bool>()); Assert.Equal("first", status["currentCommand"]!.GetValue<string>());
            Assert.Equal(0, status["commands"]!.GetValue<long>()); Assert.True(status["served"]!.GetValue<long>() >= 3);
            release.Set();
            var results = await Task.WhenAll(first, second);
            Assert.All(results, r => Assert.True(r["ok"]!.GetValue<bool>()));
            Assert.Equal(new[] { "first", "second" }, order);
            Assert.True(results[1]["queuedMs"]!.GetValue<long>() >= 0);
            var final = (await Send(server.Port, "ping"))["data"]!;
            Assert.False(final["busy"]!.GetValue<bool>()); Assert.Equal(2, final["commands"]!.GetValue<long>());
        }
        finally { release.Set(); server.Stop(); await run; }
    }
    [Fact]
    public async Task DrainingExplicitlyRejectsQueuedWorkBeforeExecutingIt()
    {
        using var release = new ManualResetEventSlim(); using var entered = new ManualResetEventSlim(); var calls = 0;
        using var server = new WorkerServer(0, args => { calls++; entered.Set(); release.Wait(TimeSpan.FromSeconds(10)); return Ok(args); }, maxCommands: 1);
        var run = server.RunAsync();
        try
        {
            var first = Send(server.Port, "first"); Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
            var second = Send(server.Port, "second");
            while (server.Status()["queued"]!.GetValue<int>() == 0) await Task.Yield();
            release.Set();
            Assert.True((await first)["ok"]!.GetValue<bool>());
            var retry = await second;
            Assert.True(retry["retryable"]!.GetValue<bool>()); Assert.False(retry["executed"]!.GetValue<bool>());
            Assert.Equal(1, calls); await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally { release.Set(); server.Stop(); await run; }
    }
    [Fact]
    public async Task IdleWorkRunsAfterTheReplyAndARequestItDoesNotServeCancelsIt()
    {
        using var started = new SemaphoreSlim(0);
        var cancelled = 0;
        var idle = new WorkerServer.IdleWork(token =>
        {
            started.Release();
            if (token.WaitHandle.WaitOne(TimeSpan.FromSeconds(10))) Interlocked.Increment(ref cancelled);
        }, args => args[0] == "same", () => { }, TimeSpan.FromMinutes(5));
        using var server = new WorkerServer(0, Ok, heap: () => 0, idle: idle);
        var run = server.RunAsync();
        try
        {
            Assert.True((await Send(server.Port, "first"))["ok"]!.GetValue<bool>());  // the reply does not wait for the idle work
            Assert.True(await started.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.True((await Send(server.Port, "ping"))["data"]!["idleWork"]!.GetValue<bool>());
            Assert.True((await Send(server.Port, "other"))["ok"]!.GetValue<bool>());
            Assert.Equal(1, cancelled);
        }
        finally { server.Stop(); await run; }
    }

    [Fact]
    public async Task ARequestTheIdleWorkServesWaitsForItInsteadOfCancellingIt()
    {
        using var started = new ManualResetEventSlim(); using var release = new ManualResetEventSlim();
        var order = new List<string>(); var cancelled = false; var runs = 0;
        var idle = new WorkerServer.IdleWork(token =>
        {
            if (Interlocked.Increment(ref runs) > 1) return;
            started.Set(); release.Wait(TimeSpan.FromSeconds(10));
            cancelled = token.IsCancellationRequested; lock (order) order.Add("idle");
        }, args => args[0] == "same", () => { }, TimeSpan.FromMinutes(5));
        using var server = new WorkerServer(0, args => { lock (order) order.Add(args[0]); return Ok(args); }, heap: () => 0, idle: idle);
        var run = server.RunAsync();
        try
        {
            await Send(server.Port, "first");
            Assert.True(started.Wait(TimeSpan.FromSeconds(5)));
            var same = Send(server.Port, "same");
            while (server.Status()["queued"]!.GetValue<int>() == 0) await Task.Delay(10);
            release.Set();
            Assert.True((await same)["ok"]!.GetValue<bool>());
            Assert.False(cancelled);
            Assert.Equal(new[] { "first", "idle", "same" }, order);
        }
        finally { release.Set(); server.Stop(); await run; }
    }

    [Fact]
    public async Task SheddingRunsBeforeTheHeapRecycleRule()
    {
        var high = true;
        var idle = new WorkerServer.IdleWork(_ => { }, _ => false, () => high = false, TimeSpan.FromMinutes(5));
        using var server = new WorkerServer(0, args => { high = true; return Ok(args); }, heap: () => high ? 3L << 30 : 0, idle: idle);
        var run = server.RunAsync();
        try
        {
            Assert.Null((await Send(server.Port, "one"))["recycling"]);
            Assert.Null((await Send(server.Port, "two"))["recycling"]);   // without the shed the second one recycles (below)
        }
        finally { server.Stop(); await run; }
    }

    [Fact]
    public async Task HeapLimitRequiresTwoCommandsAndPingsDoNotCount()
    {
        using var server = new WorkerServer(0, Ok, heap: () => 3L * 1024 * 1024 * 1024);
        var run = server.RunAsync();
        try
        {
            await Send(server.Port, "ping"); await Send(server.Port, "ping");
            Assert.Null((await Send(server.Port, "one"))["recycling"]);
            Assert.False((await Send(server.Port, "ping"))["data"]!["recycling"]!.GetValue<bool>());
            Assert.True((await Send(server.Port, "two"))["recycling"]!.GetValue<bool>());
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally { server.Stop(); await run; }
    }
}
