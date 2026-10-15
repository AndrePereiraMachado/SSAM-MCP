using System.Runtime.CompilerServices;
using Anvil.Core;

namespace Anvil.Tests;

/// <summary>
/// Integration 24-1 familias (review): every class of this assembly that touches a type of the Service Studio (ModelSession, the
/// expression rules) needs the resolver of StudioAssemblies. The classes that call Bind themselves passed whatever ran first, and
/// a class that never calls it (Pa3KlSetTests: ExpressionRewrite, ExpressionSyntax) passed or failed with FileNotFoundException
/// OutSystems.Model.V1 by the order of the batch. The resolver is now registered once, when the assembly loads, for every class:
/// the same result in any batch and alone. Without a Service Studio the tests that need one skip as before.
/// </summary>
internal static class StudioBinding
{
    [ModuleInitializer]
    internal static void Bind()
    {
        try { StudioAssemblies.Bind(); }
        catch (Exception) { /* no Service Studio here: the tests that need one say so and skip */ }
    }
}
