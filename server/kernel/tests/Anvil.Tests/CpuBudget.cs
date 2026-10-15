using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Anvil.Tests;

/// <summary>
/// The time budget of an in-memory computation (no Studio, no waiting, one thread), measured as the CPU time of the thread
/// that runs it, the fastest of a few runs. One wall-clock sample is the cost of the work only on an idle machine: with other
/// suites and agents on the cores, the preflight of job 79 took 1.1 to 1.5 s against its 1 s budget, the same work it does in
/// 0.3 s alone (marco-a2, 2026-10-13). The thread's CPU time leaves out the time the scheduler gave to other processes, and the
/// fastest run leaves out a cold cache; a slower algorithm still costs more on every run. Off Windows, the wall clock.
/// </summary>
internal static class CpuBudget
{
    public sealed record Run<T>(T Result, long CpuMs, long WallMs);

    /// <summary>Runs each piece of work on this thread and measures it; the inputs are prepared by the caller, outside.</summary>
    public static List<Run<T>> Measure<T>(IEnumerable<Func<T>> work) => work.Select(Once).ToList();

    public static long Best<T>(IReadOnlyCollection<Run<T>> runs) => runs.Min(r => r.CpuMs);

    public static string Describe<T>(IEnumerable<Run<T>> runs) =>
        string.Join(", ", runs.Select(r => $"{r.CpuMs} ms CPU / {r.WallMs} ms wall")) + (OperatingSystem.IsWindows() ? "" : " (wall clock: no thread CPU time here)");

    private static Run<T> Once<T>(Func<T> work)
    {
        var cpu = ThreadCpu();
        var wall = Stopwatch.StartNew();
        var result = work();
        wall.Stop();
        return new Run<T>(result, cpu is null ? wall.ElapsedMilliseconds : (ThreadCpu()!.Value - cpu.Value) / TimeSpan.TicksPerMillisecond, wall.ElapsedMilliseconds);
    }

    // Kernel plus user time of the calling thread, in 100 ns ticks (GetThreadTimes); null where the call does not exist.
    private static long? ThreadCpu()
    {
        if (!OperatingSystem.IsWindows()) return null;
        return GetThreadTimes(GetCurrentThread(), out _, out _, out var kernel, out var user) ? kernel + user : null;
    }

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetThreadTimes(IntPtr thread, out long creation, out long exit, out long kernel, out long user);
}
