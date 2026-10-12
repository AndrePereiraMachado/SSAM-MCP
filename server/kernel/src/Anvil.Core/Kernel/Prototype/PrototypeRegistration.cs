using System.Runtime.CompilerServices;

namespace Anvil.Core;

/// <summary>The compile lane registers its seam (docs/PROTOTIPO-NATIVO.md 7.3): the static preflight of op prototype. The html lane
/// registers Element, the css lane Css and Render, each in its own module initializer.</summary>
internal static class PrototypeRegistration
{
    // The contract (7.3) registers each seam where its lane lives, before any op runs; the kernel has no other start-up hook.
#pragma warning disable CA2255
    [ModuleInitializer]
#pragma warning restore CA2255
    internal static void Register() => PrototypeSeams.Preflight ??= PrototypePreflight.Analyze;
}
