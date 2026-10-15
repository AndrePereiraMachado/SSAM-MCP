using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>
/// Family F2 (fam-deps, 2026-10-12): the client never gives up on a bridge call before the bridge does. The kernel's
/// BridgeClient answered every verb after 120 s of socket silence, while the bridge bounds merge_from_oml at UiGate.Heavy
/// (14 min) and refresh_references at its own `timeout` (600 s by default): at 21:48:21 the merge of VisitaCerta_UI lost
/// its reply after 120 s (SocketException), the delivery became DELIVERY_UNCERTAIN and the resume loop began, while the
/// merge was still waiting in the Studio. The socket deadline of each verb is now the bridge's own bound plus a margin,
/// never less than the client's default. The bridge answers sooner whenever it can (a dialog it cannot answer comes back
/// as blockedBy in seconds, OperationDialogLoop). Pure; the numbers mirror Anvil.Bridge UiGate (Read 30 s, Model 240 s,
/// Heavy 14 min) and the handlers' own limits; a test keeps them in step.
/// </summary>
public static class BridgeDeadlines
{
    public const int Read = 30;
    public const int Model = 240;
    public const int Heavy = 14 * 60;
    public const int Margin = 60;

    /// <summary>The socket deadline, in seconds, of one call: the bridge's bound for this verb and these parameters plus the
    /// margin, and never less than <paramref name="fallback"/> (the client's default).</summary>
    public static int Seconds(string method, JsonObject? parameters, int fallback)
    {
        int? Int(string name) { try { return parameters?[name]?.GetValue<int>(); } catch (Exception) { return null; } }
        var bound = method switch
        {
            // MergeHandler: the target check (Read) and the tab's run of the merge, validations included (Heavy)
            "merge_from_oml" => Read + Heavy,
            // RefreshReferencesHandler: its own timeout (600 s by default, 10..1800) and the two model reads around it
            "refresh_references" => Math.Clamp(Int("timeout") ?? 600, 10, 1800) + 2 * Model,
            // PublishHandler: its timeout (300 s by default), the settle after it (45 s) and a model read
            "publish" => (Int("timeout") ?? 300) + 45 + Model,
            // OpenHandler: its timeout (120 s by default, at most 300) and the wait for a headless publication (at most 120 s)
            "open_module" => Math.Clamp(Int("timeout") ?? 120, 0, 300) + 120 + Read,
            "snapshot_module" or "list_open_modules" => Model,
            // Reads.Errors: the settle (30 s) and the TrueChange read (Model)
            "get_errors" => 30 + Model,
            "integration_import" => 110 + Model,
            _ => 0,
        };
        return Math.Max(fallback, bound == 0 ? 0 : bound + Margin);
    }
}
