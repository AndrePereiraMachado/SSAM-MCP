using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// The live part of references in ODC (WS2). ODC has no headless producer import (<see cref="OdcRuntime.ImportReference"/>
/// throws): a consumer's reference is refreshed in the open Studio by the bridge, through the same native calls the
/// Studio's menus make. <c>refresh-references &lt;Consumer&gt;</c> is "Check for dependency updates";
/// <c>refresh-references &lt;Consumer&gt; --producer &lt;Library&gt;</c> is the Library Updates path
/// (<c>RefreshSpecificReferencesByKey</c> with the producer's latest published revision). The bridge writes
/// <c>journal\refresh-&lt;Consumer&gt;-&lt;stamp&gt;.json</c> and refuses when anything outside references changed.
/// After a refresh the module is modified in memory: snapshot again before building the next candidate.
/// </summary>
public sealed class ReferenceServiceOdc(BridgeClientOdc bridge)
{
    public BridgeClientOdc Bridge { get; } = bridge;

    /// <summary>Returns the bridge's JSON as is: <c>ok</c>, the references before and after, and the refusal when there is one.</summary>
    public JsonObject Refresh(string consumer, string? producer = null)
        => string.IsNullOrWhiteSpace(producer) ? Bridge.Call("refresh-references", consumer) : Bridge.Call("refresh-references", consumer, "--producer", producer);
}
