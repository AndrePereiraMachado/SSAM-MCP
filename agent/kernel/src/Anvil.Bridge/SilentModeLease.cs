namespace Anvil.Bridge;

/// <summary>One reset for both the queued completion and the timeout/error path.</summary>
internal sealed class SilentModeLease : IDisposable
{
    private Action? reset;
    public SilentModeLease(Func<bool> read, Action enable, Action reset)
    {
        if (read()) throw new InvalidOperationException("open_module: aggregator is already in silent mode; another operation owns it");
        this.reset = reset;
        enable();
    }
    public void Dispose() => Interlocked.Exchange(ref reset, null)?.Invoke();
}
