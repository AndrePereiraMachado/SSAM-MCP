namespace Anvil.Core.Delivery;

/// <summary>
/// fam-deps (finding 7): the one-merge-at-a-time slot of a bridge operation queued on a Studio tab (ExecuteInContext), released
/// exactly once. Before, a merge whose tab never ran the queued job kept the slot forever ("Another merge is running" until the
/// Studio restarted) and the job could still run hours later with old bytes. The rule: the job starts only through TryStart;
/// when the caller gives up (its bound passed, or it answered blocked) it calls Abandon: a job that has not started never will
/// (TryStart answers false, it records not-executed and does nothing) and the slot is released at once; a job that started
/// releases the slot when it ends (Ended), when its journal is terminal. Release is idempotent. Pure: no Studio type.
/// </summary>
public sealed class OperationLease(Action release)
{
    private const int Queued = 0, Started = 1, Abandoned = 2, Ended = 3;
    private int state;
    private int releaseOnEnd;
    private int released;

    /// <summary>The queued job calls this first: false when the caller already gave up, so it must not run.</summary>
    public bool TryStart() => Interlocked.CompareExchange(ref state, Started, Queued) == Queued;

    /// <summary>The job ended (its journal is terminal): the slot is released when the caller already gave up.</summary>
    public void End()
    {
        Interlocked.Exchange(ref state, Ended);
        if (Volatile.Read(ref releaseOnEnd) == 1) Release();
    }

    /// <summary>The caller stops waiting. True when the job had not started (it never will; the slot is free now); false when
    /// it runs (the slot is released when it ends).</summary>
    public bool Abandon()
    {
        if (Interlocked.CompareExchange(ref state, Abandoned, Queued) == Queued) { Release(); return true; }
        Interlocked.Exchange(ref releaseOnEnd, 1);
        if (Volatile.Read(ref state) == Ended) Release();
        return false;
    }

    public bool IsAbandoned => Volatile.Read(ref state) == Abandoned;

    /// <summary>Releases the slot once (the answer path of a job that ended while the caller waited).</summary>
    public void Release()
    {
        if (Interlocked.Exchange(ref released, 1) == 0) release();
    }
}
