using System.Text.Json.Nodes;
namespace Anvil.Core.Delivery;

/// <summary>
/// F1b stop 4 (owner 2026-11-02: "o ssam deve permitir que o usuario programe junto com ele"): the person works in the same
/// Service Studio, so its UI thread is sometimes busy with the person's own work (a drag, a search, an open) when a delivery
/// step reaches it. The bridge then withdraws the step before it ran and answers UI_BUSY with executed:false (UiGate.cs).
/// Before, that answer failed the delivery. Now the step waits briefly and is sent again (WaitsMs: 2 s, 4 s, 8 s;
/// ANVIL_STUDIO_BUSY_WAITS_MS overrides them, comma separated), and each wait is said in the task (studioWaits).
/// Only a step the bridge proves it did not run is sent again: a UI_BUSY whose step started (outcome unknown), any other
/// failure, and every merge step after "find the module" keep their answer, so nothing that may have written runs twice.
/// </summary>
public class StudioBusyBridge : IBridgeClient
{
    public static readonly int[] DefaultWaitsMs = [2000, 4000, 8000];
    public static int[] WaitsMs => Environment.GetEnvironmentVariable("ANVIL_STUDIO_BUSY_WAITS_MS") is { Length: > 0 } raw
        && raw.Split(',').Select(s => int.TryParse(s.Trim(), out var ms) && ms >= 0 ? ms : -1).ToArray() is { Length: > 0 } given && given.All(ms => ms >= 0)
        ? given : DefaultWaitsMs;
    private readonly IBridgeClient inner;
    private readonly JsonObject result;
    private readonly Action<int> sleep;

    protected StudioBusyBridge(IBridgeClient inner, JsonObject result, Action<int>? sleep)
    {
        this.inner = inner; this.result = result;
        this.sleep = sleep ?? (ms => Thread.Sleep(ms));
    }

    /// <summary>The bridge of one delivery run; the waits of this run go to result["studioWaits"].</summary>
    public static IBridgeClient Wrap(IBridgeClient inner, JsonObject result, Action<int>? sleep = null)
    {
        if (inner is StudioBusyBridge) return inner;
        result.Remove("studioWaits");
        return inner is IBridgeProbeReader reader ? new ProbeReading(inner, reader, result, sleep) : new StudioBusyBridge(inner, result, sleep);
    }

    public JsonObject Call(string method, JsonObject? parameters = null)
    {
        var waitsMs = WaitsMs;
        for (var attempt = 0; ; attempt++)
        {
            try { return inner.Call(method, parameters); }
            catch (BridgeCallException ex) when (attempt < waitsMs.Length && NotRunBecauseBusy(method, ex))
            {
                var waited = waitsMs[attempt];
                var waits = result["studioWaits"] as JsonArray ?? new JsonArray();
                result["studioWaits"] = waits;
                waits.Add(new JsonObject
                {
                    ["code"] = "STUDIO_BUSY", ["method"] = method, ["attempt"] = attempt + 1, ["waitedMs"] = waited,
                    ["note"] = "The Studio was busy with other work (its UI thread did not run this step, so nothing of it ran); SSAM waited "
                        + (waited / 1000.0).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + " s and sent the step again.",
                });
                sleep(waited);
            }
        }
    }

    public void ReleaseCapture() => inner.ReleaseCapture();

    /// <summary>The bridge proved the step did not run, and only because the Studio was busy.</summary>
    public static bool NotRunBecauseBusy(string method, BridgeCallException ex)
    {
        if (ex.Executed != false || ex.Stall != null) return false;
        var text = ex.Message;
        var withdrawn = text.Contains("withdrawn from the UI queue; nothing of it ran", StringComparison.Ordinal);
        if (method == "merge_from_oml")
            // The merge itself is journaled by its operation id: only the step that finds the module, before the journal, is
            // sent again.
            return withdrawn && text.Contains("find the module", StringComparison.Ordinal);
        return withdrawn;
    }

    private sealed class ProbeReading(IBridgeClient inner, IBridgeProbeReader reader, JsonObject result, Action<int>? sleep)
        : StudioBusyBridge(inner, result, sleep), IBridgeProbeReader
    {
        public Task<JsonObject?> ReadProbeAsync(string method, JsonObject? parameters = null, int timeoutMs = 250) => reader.ReadProbeAsync(method, parameters, timeoutMs);
    }
}
