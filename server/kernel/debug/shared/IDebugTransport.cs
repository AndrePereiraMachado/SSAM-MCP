using ServiceStudio.PluginAPI.Debugger;
internal interface IDebugTransport : IAsyncDisposable {
    // Internal test capability, never a caller/configuration flag. Native transports
    // explicitly remain false; a missing implementation is fail-closed.
    bool IsOfflineSynthetic => false;
    event Func<DebugTransportEvent, Task>? Received;
    event Action<string>? Failed;
    Task Start();
    string Evaluate(string thread, string request);
    void Execute(string op, string thread);
    Task Stop();
}
