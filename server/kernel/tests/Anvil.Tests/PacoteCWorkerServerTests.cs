using System.Diagnostics;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core.Hosting;
using Xunit;
namespace Anvil.Tests;

/// <summary>Lane C, C35: an idle worker exits by itself after ANVIL_WORKER_IDLE_MINUTES (read in WorkerServer, no host
/// change); pings never keep it alive, a command restarts the wait, 0 turns it off.</summary>
public sealed class PacoteCWorkerServerTests
{
    private static JsonObject Ok(string[] args) => new() { ["ok"] = true, ["command"] = args[0], ["data"] = new JsonObject() };
    private static async Task<JsonObject> Send(int port, string command)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var client = new TcpClient(); await client.ConnectAsync("127.0.0.1", port, timeout.Token);
        using var stream = client.GetStream();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        using var reader = new StreamReader(stream, new UTF8Encoding(false));
        await writer.WriteLineAsync(new JsonObject { ["args"] = new JsonArray(command) }.ToJsonString());
        return JsonNode.Parse((await reader.ReadLineAsync(timeout.Token))!)!.AsObject();
    }

    [Fact]
    public async Task AnIdleWorkerExitsByItselfAndPingsDoNotKeepItAlive()
    {
        var logs = new List<string>();
        using var server = new WorkerServer(0, Ok, heap: () => 0, log: line => { lock (logs) logs.Add(line); }, idleExit: TimeSpan.FromMilliseconds(600));
        Assert.Equal(TimeSpan.FromMilliseconds(600), server.IdleExit);
        var watch = Stopwatch.StartNew();
        var run = server.RunAsync();
        var status = (await Send(server.Port, "ping"))["data"]!;
        Assert.Equal(0.01, status["idleExitMinutes"]!.GetValue<double>());
        // Pings every 100 ms: the worker still exits, about when the idle time ends.
        while (!run.IsCompleted && watch.Elapsed < TimeSpan.FromSeconds(10))
        {
            try { await Send(server.Port, "ping"); } catch (SocketException) { break; } catch (IOException) { break; }
            await Task.Delay(100);
        }
        Assert.True(await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(10))) == run, "the idle worker exited");
        Assert.InRange(watch.Elapsed.TotalMilliseconds, 500, 9000);
        lock (logs) Assert.Contains(logs, l => l.Contains("no command for") && l.Contains(WorkerServer.IdleExitVariable));
    }

    [Fact]
    public async Task ACommandRestartsTheIdleWait()
    {
        using var server = new WorkerServer(0, Ok, heap: () => 0, idleExit: TimeSpan.FromMilliseconds(700));
        var run = server.RunAsync();
        try
        {
            var watch = Stopwatch.StartNew();
            while (watch.Elapsed < TimeSpan.FromMilliseconds(1800))
            {
                Assert.True((await Send(server.Port, "work"))["ok"]!.GetValue<bool>());
                await Task.Delay(150);
            }
            Assert.False(run.IsCompleted, "commands every 150 ms keep a 700 ms idle exit away");
            Assert.True(await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(10))) == run, "then, without commands, it exits");
        }
        finally { server.Stop(); await run; }
    }

    [Fact]
    public void TheIdleTimeComesFromTheEnvironmentVariableAndZeroTurnsItOff()
    {
        Assert.Equal(WorkerServer.DefaultIdleExit, WorkerServer.IdleExitFrom(null));
        Assert.Equal(WorkerServer.DefaultIdleExit, WorkerServer.IdleExitFrom(" "));
        Assert.Equal(WorkerServer.DefaultIdleExit, WorkerServer.IdleExitFrom("soon"));
        Assert.Equal(TimeSpan.FromSeconds(90), WorkerServer.IdleExitFrom("1.5"));
        Assert.Equal(TimeSpan.FromMinutes(30), WorkerServer.IdleExitFrom(" 30 "));
        Assert.Null(WorkerServer.IdleExitFrom("0"));
        Assert.Null(WorkerServer.IdleExitFrom("-5"));
        Assert.Equal("ANVIL_WORKER_IDLE_MINUTES", WorkerServer.IdleExitVariable);
        using var never = new WorkerServer(0, Ok, idleExit: TimeSpan.Zero);
        Assert.Null(never.IdleExit);
        Assert.Null(never.Status()["idleExitMinutes"]);
    }
}
