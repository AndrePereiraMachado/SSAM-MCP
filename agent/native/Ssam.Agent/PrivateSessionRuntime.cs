namespace Ssam.Agent;

// One window budget for the whole account, shared by Users and credential sessions.
internal sealed class PrivateSessionRuntime
{
    internal readonly object Sync = new();
    internal readonly List<DateTimeOffset> Opened = [], Refusals = [];
    private readonly List<Func<bool>> busy = [];
    internal void Register(Func<bool> isBusy) { lock (Sync) busy.Add(isBusy); }
    internal void TakeWindow(DateTimeOffset now, string prefix)
    {
        lock (Sync)
        {
            if (busy.Any(check => check()))
                throw new AgentFault(prefix + "_WINDOW_BUSY", "Another window of this agent is open: answer that one first.", false);
            Opened.RemoveAll(at => now - at >= TimeSpan.FromMinutes(10));
            Refusals.RemoveAll(at => now - at >= TimeSpan.FromMinutes(10));
            if (Opened.Count >= 20 || Refusals.Count >= 3)
                throw new AgentFault(prefix + "_WINDOW_LIMIT", "Too many windows in a few minutes, so no other was opened.", false);
            Opened.Add(now);
        }
    }
}
