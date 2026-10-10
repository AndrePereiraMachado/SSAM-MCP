using System.Text.Json.Nodes;
using ServiceStudio.Model;

namespace Anvil.Bridge;

/// <summary>Thin bridge: no resolution of quoted names to model elements (kernel model reading); a message gets an
/// element only from its ExtraInfo (Name;Key), as docs/O11-BRIDGE-FINA.md section 3.5 says.</summary>
internal static partial class PublishLogHandler
{
    private static partial Func<string, JsonObject?>? ResolverFor(ESpace e) => null;
}
