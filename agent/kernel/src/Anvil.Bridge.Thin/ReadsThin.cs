using System.Text.Json.Nodes;
using ServiceStudio.Model;

namespace Anvil.Bridge;

/// <summary>get_errors of the thin bridge (docs/O11-BRIDGE-FINA.md section 3.4): the Verify messages projected as the
/// kernel does, the counts and the readable lines, without the kernel hints (verify hints and expression checks stay on
/// the server); kernelHints:false says so. Since the ninth release, as the full bridge: module_key names the tab
/// (Studio.Target, C41), and settle with the validation generation (C28, Reads.cs).</summary>
internal static partial class Reads
{
    public static async Task<string> Errors(JsonObject? p)
    {
        var settled = await Settle(p);
        return await OnUi(() => ErrorsNow(p, settled), UiGate.Model, "get_errors");
    }

    /// <summary>The error count of a module, for refresh_references (RefreshReferencesHandler, shared).</summary>
    internal static int ErrorCount(ESpace e) => NativeMessages.Messages(e).Count(m => m.IsError);

    private static string ErrorsNow(JsonObject? p, bool settled)
    {
        var (agg, e) = Studio.Target(p);
        Studio.RequireTarget(agg, e, p);
        var max = p?["max"]?.GetValue<int>() ?? 60;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var messages = NativeMessages.Messages(e);
        var verifyMs = sw.ElapsedMilliseconds;
        var byType = new Dictionary<string, int>();
        foreach (var m in messages) byType[m.Type] = byType.GetValueOrDefault(m.Type) + 1;
        var details = NativeMessages.Details(messages, max);
        var errors = byType.Where(k => k.Key.Contains("Error")).Sum(k => k.Value);
        var warnings = byType.Where(k => k.Key.Contains("Warning")).Sum(k => k.Value);
        var result = new JsonObject
        {
            ["rawMessages"] = System.Text.Json.JsonSerializer.SerializeToNode(messages),
            ["isValid"] = e.IsValid, ["errors"] = errors, ["warnings"] = warnings, ["total"] = messages.Count,
            ["byType"] = new JsonObject(byType.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)k.Value))),
            ["messages"] = new JsonArray(details.Select(d => (JsonNode)d).ToArray()), ["verifyMs"] = verifyMs,
            ["kernelHints"] = false,
        };
        if (p?["since"]?.GetValue<string>() is { } since)
        {
            var snapshot = MergeHandler.Snapshots.RequireSince(e.Key.ToString(), since);
            var delta = MessageDelta.Compute(snapshot.Messages, messages);
            result["snapshot_id"] = since;
            result["new"] = System.Text.Json.JsonSerializer.SerializeToNode(delta.New);
            result["fixed"] = System.Text.Json.JsonSerializer.SerializeToNode(delta.Fixed);
            result["preexisting"] = System.Text.Json.JsonSerializer.SerializeToNode(delta.Preexisting);
            result["newErrors"] = delta.New.Count(m => m.IsError);
        }
        Generation(result, e.Key.ToString(), settled);
        return Server.Ok(result);
    }
}
