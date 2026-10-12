using ServiceStudio.PluginAPI.Debugger;
internal interface IDebugTransport : IAsyncDisposable {
    // Internal test capability, never a caller/configuration flag. Native transports
    // explicitly remain false; a missing implementation is fail-closed.
    bool IsOfflineSynthetic => false;
    // Fixed phases and a boolean only; no remote session token or arbitrary server text.
    DebugTransportDiagnostic? Diagnostic => null;
    event Func<DebugTransportEvent, Task>? Received;
    event Action<string>? Failed;
    Task Start();
    string Evaluate(string thread, string request);
    void Execute(string op, string thread);
    Task Stop();
}
internal sealed record DebugTransportDiagnostic(string StartPhase, string StopPhase, bool TokenObtained, string StartOutcome) {
    public int? PollRequests { get; init; }
    public int? PollResponses { get; init; }
    public int? LastPollStatus { get; init; }
    public int? NativeEvents { get; init; }
}
