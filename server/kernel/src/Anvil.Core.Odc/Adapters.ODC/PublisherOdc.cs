using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Result of a publication through the bridge: the authorization record and the publish receipt
/// (<c>publish-receipt.json</c> in the evidence directory when <c>--wait</c> followed the server process to its end).</summary>
public sealed record OdcPublishOutcome(bool Ok, string? FailedStep, JsonObject Authorize, JsonObject? Publish)
{
    public JsonObject ToJson() => new() { ["ok"] = Ok, ["failedStep"] = FailedStep, ["authorize"] = Authorize.DeepClone(), ["publish"] = Publish?.DeepClone() };
}

/// <summary>
/// Publication in ODC (WS2): the bridge's native Publish, after the merge receipt exists in the manifest's evidence
/// directory. Two bridge commands, in order: <c>authorize &lt;manifest&gt; publish &lt;the user's words&gt;</c>, which records
/// the authorization with a timestamp in the manifest, then <c>publish &lt;manifest&gt; --wait</c>, which dispatches,
/// follows the server process, closes the notice, downloads the revision and compares it with the open module.
/// The authorization text is whatever the caller received from the user; this class never invents one, and refuses
/// an empty one before touching the bridge.
/// </summary>
public sealed class PublisherOdc(BridgeClientOdc bridge)
{
    public BridgeClientOdc Bridge { get; } = bridge;

    public OdcPublishOutcome Publish(string manifestPath, string authorization, int? waitMinutes = null)
    {
        if (string.IsNullOrWhiteSpace(authorization)) throw new ArgumentException("publish requires the user's explicit authorization text; none was given, so nothing was sent to the bridge.", nameof(authorization));
        manifestPath = Path.GetFullPath(manifestPath);
        var authorized = Bridge.Call("authorize", manifestPath, "publish", authorization.Trim());
        if (!BridgeClientOdc.Ok(authorized)) return new OdcPublishOutcome(false, "authorize", authorized, null);
        var published = waitMinutes == null ? Bridge.Call("publish", manifestPath, "--wait") : Bridge.Call("publish", manifestPath, "--wait", waitMinutes.Value.ToString());
        return new OdcPublishOutcome(BridgeClientOdc.Ok(published), BridgeClientOdc.Ok(published) ? null : "publish", authorized, published);
    }

    /// <summary><c>publish-status &lt;manifest&gt;</c>: the state of a publication already requested, never a retry.</summary>
    public JsonObject Status(string manifestPath) => Bridge.Call("publish-status", Path.GetFullPath(manifestPath));
}
