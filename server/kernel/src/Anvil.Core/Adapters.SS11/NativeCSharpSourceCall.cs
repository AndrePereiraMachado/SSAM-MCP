using System.Reflection;
using Anvil.Authoring.Transport;

namespace Anvil.Core;

/// <summary>Creates a managed caller from source codecs proved by the native reader.
/// The caller supplies its already loaded source assembly, never field mappings or action keys.
/// This factory performs no source execution, acquisition, transport or publication.</summary>
public static class NativeCSharpSourceCall
{
    public static ReferenceGraphCall Create(NativeCSharpSourceReadResult verified,
        NativeDependencyRequirement requirement, Assembly callerAssembly)
    {
        ArgumentNullException.ThrowIfNull(verified);
        ArgumentNullException.ThrowIfNull(requirement);
        ArgumentNullException.ThrowIfNull(callerAssembly);
        var binding = verified.Catalog.Resolve(requirement);
        if (requirement.Kind is not (NativeDependencyKind.ServerAction or NativeDependencyKind.ServiceAction))
            throw new NotSupportedException("C# source calls require a native server or service action.");
        var abi = binding.SourceAbi ?? throw new NotSupportedException(
            "The native action has no proved C# source codec: " + requirement.SourceSymbol);
        if (abi.Id != "anvil.csharp.reference-graph" || abi.Version is not (2 or 3 or 4))
            throw new NotSupportedException("Unsupported native C# source codec: " + abi.Id + " version " + abi.Version);
        return new ReferenceGraphBinding(abi.Payload, callerAssembly, maxSupportedVersion: 4).CreateCall(binding.NativeReference);
    }
}
