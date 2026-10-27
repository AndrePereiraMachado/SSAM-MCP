using System.Diagnostics;

namespace Anvil.Core;

public sealed record NativePerformanceMetric(long Calls, double WallMs, double? CpuMs, long CpuSamples, bool Derived = false);
public sealed record NativePerformanceSnapshot(int FormatVersion, IReadOnlyDictionary<string, NativePerformanceMetric> Phases);

/// <summary>Optional invocation-scoped diagnostics. Phases and container verbs are
/// inclusive, so their durations must not be summed with nested phases. CPU is the
/// current process delta and is sampled only for coarse phases, never per verb.
/// This type has no vendor-model dependencies and does not enable native tracing.</summary>
public sealed class NativePerformanceCapture : IDisposable
{
    private static readonly AsyncLocal<NativePerformanceCapture?> Ambient = new();
    private readonly NativePerformanceCapture? previous;
    private readonly object sync = new();
    private readonly Dictionary<string, Totals> phases = new(StringComparer.Ordinal);
    private bool disposed;
    private sealed class Totals { internal long Calls, WallTicks, CpuTicks, CpuSamples; }
    private sealed class NoMeasurement : IDisposable
    {
        internal static readonly NoMeasurement Instance = new();
        public void Dispose() { }
    }

    private NativePerformanceCapture() { previous = Ambient.Value; Ambient.Value = this; }
    public static NativePerformanceCapture Begin() => new();

    internal static IDisposable Measure(string phase, bool cpu = false) => Ambient.Value is { } capture
        ? new Measurement(capture, phase, cpu) : NoMeasurement.Instance;
    internal static IDisposable MeasureVerb(string verb) => Ambient.Value is { } capture
        ? new Measurement(capture, "verb." + verb, false) : NoMeasurement.Instance;
    /// <summary>Batch lab: the preparation of a set (the value converted for the property), by native type and property, and
    /// all of them under "set.prepare", on one clock.</summary>
    internal static IDisposable MeasureSetPreparation(Type nativeType, string property) => Ambient.Value is { } capture
        ? new Measurement(capture, "set.prepare/" + (nativeType.FullName ?? nativeType.Name) + "/" + property, false, "set.prepare")
        : NoMeasurement.Instance;
    // Use runtime type metadata and API property names only: never instance names,
    // source expressions, business values, credentials or paths.
    internal static IDisposable MeasureSet(Type nativeType, string property, string route) => Ambient.Value is { } capture
        ? new Measurement(capture, "set.write/" + (nativeType.FullName ?? nativeType.Name) + "/" + property + "/" + route, false)
        : NoMeasurement.Instance;

    private sealed class Measurement : IDisposable
    {
        private NativePerformanceCapture? owner;
        private readonly string phase;
        private readonly string? totalPhase;
        private readonly long started;
        private readonly long? cpuStarted;
        internal Measurement(NativePerformanceCapture owner, string phase, bool cpu, string? totalPhase = null)
        {
            this.owner = owner; this.phase = phase; this.totalPhase = totalPhase;
            cpuStarted = cpu ? CpuNow() : null;
            started = Stopwatch.GetTimestamp();
        }
        public void Dispose()
        {
            var capture = Interlocked.Exchange(ref owner, null);
            if (capture == null) return;
            var elapsed = Stopwatch.GetTimestamp() - started;
            var cpuFinished = cpuStarted.HasValue ? CpuNow() : null;
            var cpu = cpuStarted.HasValue && cpuFinished.HasValue ? cpuFinished.Value - cpuStarted.Value : (long?)null;
            capture.Record(phase, elapsed, cpu);
            if (totalPhase != null) capture.Record(totalPhase, elapsed, cpu);
        }
    }

    private static long? CpuNow()
    {
        try { using var process = Process.GetCurrentProcess(); return process.TotalProcessorTime.Ticks; }
        catch (System.ComponentModel.Win32Exception) { return null; }
        catch (InvalidOperationException) { return null; }
    }
    private void Record(string phase, long wallTicks, long? cpuTicks)
    {
        lock (sync)
        {
            if (!phases.TryGetValue(phase, out var total)) phases.Add(phase, total = new Totals());
            total.Calls++; total.WallTicks += wallTicks;
            if (cpuTicks.HasValue) { total.CpuTicks += cpuTicks.Value; total.CpuSamples++; }
        }
    }
    public NativePerformanceSnapshot Snapshot()
    {
        lock (sync)
        {
            var result = phases.OrderBy(pair => pair.Key, StringComparer.Ordinal).ToDictionary(pair => pair.Key,
                pair => Metric(pair.Value.Calls, pair.Value.WallTicks, pair.Value.CpuTicks, pair.Value.CpuSamples), StringComparer.Ordinal);
            if (phases.TryGetValue("mutation.command", out var command))
            {
                phases.TryGetValue("mutation.callback", out var callback);
                var cpuComplete = command.CpuSamples == command.Calls && (callback == null || callback.CpuSamples == callback.Calls);
                result["mutation.commandRemainder"] = Metric(command.Calls,
                    Math.Max(0, command.WallTicks - (callback?.WallTicks ?? 0)),
                    Math.Max(0, command.CpuTicks - (callback?.CpuTicks ?? 0)), cpuComplete ? command.Calls : 0, true);
            }
            return new(1, new System.Collections.ObjectModel.ReadOnlyDictionary<string, NativePerformanceMetric>(result));
        }
    }
    private static NativePerformanceMetric Metric(long calls, long wall, long cpu, long cpuSamples, bool derived = false)
        => new(calls, wall * 1000d / Stopwatch.Frequency, cpuSamples == 0 ? null : cpu / (double)TimeSpan.TicksPerMillisecond, cpuSamples, derived);

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (!ReferenceEquals(Ambient.Value, this)) return;
        var restore = previous;
        while (restore?.disposed == true) restore = restore.previous;
        Ambient.Value = restore;
    }
}
