using System.IO.Pipes;
using System.Text.Json;

internal static class DebugPipe {
    internal static async Task ServeConnected(NamedPipeServerStream pipe, Func<Request, Task<object>> execute, CancellationToken cancellation) {
        try {
            // Dispose/flush while this connection still exists. Disconnecting
            // before StreamWriter.Dispose used to terminate the whole worker
            // after its first status/inspection request on Windows.
            using var reader = new StreamReader(pipe, leaveOpen: true);
            using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
            object result;
            try {
                var command = await reader.ReadLineAsync(cancellation).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
                if (command == null || command.Length > 1048576) throw new DebugFailure("debug_invalid_request");
                var request = JsonSerializer.Deserialize<Request>(command, Wire.Options) ?? throw new DebugFailure("debug_invalid_request");
                if (request.Op != "bind-scope" && command.Length > 32768) throw new DebugFailure("debug_invalid_request");
                result = await execute(request);
            } catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
            catch (Exception error) { result = Wire.Error(error); }
            await writer.WriteLineAsync(Wire.Json(result));
        } catch (IOException) {
            // A client can close after sending its command. The command is not
            // replayed; losing this connection must not stop the debugger.
        } finally {
            if (pipe.IsConnected) { try { pipe.Disconnect(); } catch (IOException) { } }
        }
    }
}
