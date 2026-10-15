namespace Anvil.Core;

/// <summary>The lane this build serves, from the assembly the kernel sources are compiled into: Anvil.Core is O11,
/// Anvil.Core.Odc is ODC, and the ODC builder (ODC3.Builder), which links some kernel sources (FlowParse.cs, ...), is ODC.
/// No other type: the builder links this file without the publication and preflight types. MessageExpectations.Lane reads it.</summary>
public static class KernelLane
{
    public static string Current { get; } = typeof(KernelLane).Assembly.GetName().Name is "Anvil.Core.Odc" or "ODC3.Builder" ? "odc" : "o11";

    public static bool IsOdc => Current == "odc";
}
