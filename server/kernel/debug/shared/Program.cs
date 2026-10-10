using System.IO.Pipes;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

internal static class Program {
    // Corrected console host: the protocol writer is captured in an explicit static constructor (no beforefieldinit),
    // BEFORE stdout is silenced, so native SDK console writes can never corrupt the one-line JSON protocol and the
    // protocol can never be captured as TextWriter.Null. Only Output carries protocol lines.
    static readonly TextWriter Output;
    static Program() { Output = Console.Out; Console.SetOut(TextWriter.Null); }
    static void Emit(object value) { Output.WriteLine(Wire.Json(value)); Output.Flush(); }
    static async Task<int> Main(string[] args) {
        // Resolution happens before any native type is JIT-loaded. No Studio process or bridge.
        if (args.Length != 1 || !Directory.Exists(args[0])) { Emit(new { ok = false, error = "debug_installation_required" }); return 1; }
        var dir = Path.GetFullPath(args[0]);
        AssemblyLoadContext.Default.Resolving += (context, name) => {
            var file = Path.Combine(dir, name.Name + ".dll");
            return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
        };
        try { return await Run(); } catch (Exception e) { Emit(Wire.Error(e)); return 1; }
    }
    [MethodImpl(MethodImplOptions.NoInlining)] static async Task<int> Run() {
        var line = await Console.In.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
        if (line == null || line.Length > 65536) throw new DebugFailure("debug_bootstrap_required");
        var config = JsonSerializer.Deserialize<Configuration>(line, Wire.Options)!;
        line = null; // Release the private bootstrap string; immutable strings are not forensic-zeroable.
        config.Validate();
        await using var session = new DebugSession(config);
        // Bind the user-only pipe before starting any remote operation.
        using var lease = new CancellationTokenSource(TimeSpan.FromSeconds(config.Seconds));
        using var pipe = NewPipe(config.SessionId);
        try {
            await session.Start();
            Emit(await session.Execute(new Request()));
            var watchdog = Task.Run(async () => {
                while (!lease.IsCancellationRequested) { await Task.Delay(250, lease.Token); await session.ReleaseExpiredPauses(); if (session.Finished) lease.Cancel(); }
            }, lease.Token);
            try {
                while (!lease.IsCancellationRequested && !session.Finished) {
                    await pipe.WaitForConnectionAsync(lease.Token);
                    using var reader = new StreamReader(pipe, leaveOpen: true);
                    using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
                    try {
                        var command = await reader.ReadLineAsync(lease.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
                        if (command == null || command.Length > 32768) throw new DebugFailure("debug_invalid_request");
                        var request = JsonSerializer.Deserialize<Request>(command, Wire.Options)!;
                        var result = await session.Execute(request);
                        await writer.WriteLineAsync(Wire.Json(result));
                    } catch (Exception e) { try { await writer.WriteLineAsync(Wire.Json(Wire.Error(e))); } catch { } }
                    finally { pipe.Disconnect(); }
                }
            } catch (OperationCanceledException) { }
            finally { lease.Cancel(); try { await watchdog; } catch (OperationCanceledException) { } }
            return 0;
        } finally {
            await session.Stop();
            if (config.ReceiptPath != null) {
                var temp = config.ReceiptPath + ".tmp";
                await File.WriteAllTextAsync(temp, Wire.Json(session.Status()));
                File.Move(temp, config.ReceiptPath, true);
            }
        }
    }
    static NamedPipeServerStream NewPipe(string id) => new("ssam-debug-" + id, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
}
