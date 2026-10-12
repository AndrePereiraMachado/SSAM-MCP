using System.IO.Pipes;
using System.Text.Json;

internal static class DebugPipeTests {
    internal static async Task Run() {
        var name = "ssam-debug-test-" + Guid.NewGuid().ToString("N");
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var executions = 0;
        var commands = new[] { "{\"op\":\"status\"}", "null", "{\"op\":\"status\"}", "{\"op\":\"status\"}",
            Wire.Json(new Request { Op = "bind-scope", ScopeUpdate = new() { Variables = Enumerable.Range(0, 500)
                .Select(i => new InspectionVariable { Name = "Native scope variable " + i, Path = new string('x', 100),
                    ModuleKey = Tests.ModuleKey, FunctionKey = Tests.NodeKey, VariableKey = Tests.NodeKey, SourceSha256 = new string('a', 64) }).ToArray() } }),
            Wire.Json(new Request { Op = "status", ThreadId = new string('x', 33000) }) };
        Tests.Check(commands[4].Length > 32768, "lazy metadata fixture does not exercise pipe budget");
        var loop = Task.Run(async () => {
            for (var i = 0; i < commands.Length; i++) {
                await server.WaitForConnectionAsync(cancel.Token);
                await DebugPipe.ServeConnected(server, request => {
                    executions++;
                    return Task.FromResult<object>(new { ok = true, sequence = executions, op = request.Op });
                }, cancel.Token);
            }
        });
        for (var i = 0; i < commands.Length; i++) {
            using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            await client.ConnectAsync(cancel.Token);
            using var reader = new StreamReader(client, leaveOpen: true);
            using var writer = new StreamWriter(client, leaveOpen: true) { AutoFlush = true };
            await writer.WriteLineAsync(commands[i]);
            var line = await reader.ReadLineAsync(cancel.Token);
            using var response = JsonDocument.Parse(line!);
            Tests.Check(response.RootElement.GetProperty("ok").GetBoolean() == (i != 1 && i != 5), "pipe response lost after reconnect/invalid command");
        }
        await loop;
        Tests.Check(executions == 4, "invalid request executed or a connection caused replay");
        Console.WriteLine("PASS: real named pipe serves repeated connections and invalid input without ending worker");
    }
}
