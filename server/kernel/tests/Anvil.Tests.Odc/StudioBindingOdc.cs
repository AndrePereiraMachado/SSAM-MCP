using System.Runtime.CompilerServices;
using Anvil.Core;

namespace Anvil.Tests.Odc;

/// <summary>
/// Integration 24-1 familias (review): the resolver of the ODC Studio, registered once when the assembly loads, so a class that
/// touches a Studio type without calling Bind itself passes or fails the same in any batch (Anvil.Tests: StudioBinding). Without
/// an ODC Studio the tests that need one skip as before.
/// </summary>
internal static class StudioBindingOdc
{
    [ModuleInitializer]
    internal static void Bind()
    {
        try { StudioAssembliesOdc.Bind(); }
        catch (Exception) { /* no ODC Studio here: the tests that need one say so and skip */ }
    }
}
