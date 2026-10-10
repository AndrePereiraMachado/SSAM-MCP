using System.Reflection;

namespace Anvil.Core;

/// <summary>
/// Single access point to the platform adapter. Nothing in the kernel names a platform: the runtime is either set
/// by the host (<see cref="Use"/>) or discovered once, by reflection, as the only <see cref="IStudioRuntime"/>
/// implementation with a parameterless constructor compiled into this assembly (Ss11Runtime in the SS11 build,
/// OdcRuntime in the ODC build). Discovery keeps existing callers (CLI, tests) working without a setup call.
/// </summary>
public static class StudioAdapter
{
    private static readonly object Gate = new();
    private static IStudioRuntime? runtime;

    public static IStudioRuntime Runtime
    {
        get
        {
            if (runtime != null) return runtime;
            lock (Gate) return runtime ??= Discover();
        }
    }

    /// <summary>Selects the runtime explicitly; must happen before the first use.</summary>
    public static void Use(IStudioRuntime studio)
    {
        lock (Gate)
        {
            if (runtime != null && !ReferenceEquals(runtime, studio))
                throw new InvalidOperationException($"StudioAdapter already uses {runtime.Platform}; it cannot switch to {studio.Platform} in the same process");
            runtime = studio;
        }
    }

    private static IStudioRuntime Discover()
    {
        var candidates = typeof(StudioAdapter).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && typeof(IStudioRuntime).IsAssignableFrom(t) && t.GetConstructor(Type.EmptyTypes) != null)
            .ToArray();
        if (candidates.Length != 1)
            throw new InvalidOperationException("Expected exactly one IStudioRuntime in this build, found " + candidates.Length + ": " + string.Join(", ", candidates.Select(c => c.Name)) + ". Call StudioAdapter.Use(...) explicitly.");
        return (IStudioRuntime)Activator.CreateInstance(candidates[0])!;
    }
}
