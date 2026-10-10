using System.Text.Json.Nodes;
using Anvil.Core;
using Avalonia.Threading;
using OutSystems.Model;
using ServiceStudio.Model;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>The reads that use kernel knowledge (verify hints, element search, flow nodes): full bridge only. The thin
/// bridge answers get_errors from ReadsThin.cs and has no find_element or get_flow_nodes.</summary>
internal static partial class Reads
{
    // C28: settle and the validation generation (Reads.cs); C41: module_key names the tab (Studio.Target).
    public static async Task<string> Errors(JsonObject? p)
    {
        var settled = await Settle(p);
        return await OnUi(() => ErrorsNow(p, settled), UiGate.Model, "get_errors");
    }

    /// <summary>The error count of a module, for refresh_references (RefreshReferencesHandler, shared): here the kernel's
    /// projection; the thin bridge counts its own (ReadsThin.cs).</summary>
    internal static int ErrorCount(ESpace e) => ModelHost.Messages(e).Count(m => m.IsError);

    private static string ErrorsNow(JsonObject? p, bool settled)
    {
        var (agg, e) = Studio.Target(p);
        Studio.RequireTarget(agg, e, p);
        var max = p?["max"]?.GetValue<int>() ?? 60;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var messages = ModelHost.Messages(e);
        var verifyMs = sw.ElapsedMilliseconds;
        var snap = ModelHost.Describe(e, 0, messages);
        var details = ModelHost.ValidationDetails(e, max, messages);
        var errors = snap.Validation.ByType.Where(k => k.Key.Contains("Error")).Sum(k => k.Value);
        var warnings = snap.Validation.ByType.Where(k => k.Key.Contains("Warning")).Sum(k => k.Value);
        var result = new JsonObject
        {
            ["rawMessages"] = System.Text.Json.JsonSerializer.SerializeToNode(messages),
            ["isValid"] = snap.IsValid, ["errors"] = errors, ["warnings"] = warnings, ["total"] = snap.Validation.Total,
            ["byType"] = new JsonObject(snap.Validation.ByType.Select(k => KeyValuePair.Create(k.Key, (JsonNode?)k.Value))),
            ["messages"] = new JsonArray(details.Select(d => (JsonNode)d).ToArray()), ["verifyMs"] = verifyMs,
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

    public static Task<string> Find(JsonObject? p) => OnUi(() =>
    {
        var name = p?["name"]?.GetValue<string>() ?? throw new InvalidOperationException("'name' is required");
        var max = p?["max"]?.GetValue<int>() ?? 20;
        var (agg, e) = Studio.Target(p);
        Studio.RequireTarget(agg, e, p);
        var results = new JsonArray();
        foreach (var o in EntityIndexes.IncludeNative(((IObjectSignature)e).GetAllDescendantsOfType<IObjectSignature>()))
        {
            var n = ModelHost.Prop(o, "Name") as string ?? ModelHost.Prop(o, "Label") as string;
            if (!string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) continue;
            results.Add(new JsonObject { ["name"] = n, ["type"] = EntityIndexes.TypeName(o) ?? ModelHost.Kind(o.GetInterface()?.Name ?? o.GetType().Name), ["key"] = o.ObjectKey?.ToString(), ["parent"] = o.Parent == null ? null : ModelHost.Prop(o.Parent, "Name") as string });
            if (results.Count >= max) break;
        }
        return Server.Ok(new JsonObject { ["query"] = name, ["count"] = results.Count, ["results"] = results });
    });

    public static Task<string> FlowNodes(JsonObject? p) => OnUi(() =>
    {
        var name = p?["name"]?.GetValue<string>() ?? throw new InvalidOperationException("'name' is required");
        var (agg, e) = Studio.Target(p);
        Studio.RequireTarget(agg, e, p);
        var nodes = ModelHost.FlowNodes(e, name);
        return Server.Ok(new JsonObject { ["action"] = name, ["count"] = nodes.Count, ["nodes"] = new JsonArray(nodes.Select(n => (JsonNode)new JsonObject { ["name"] = n.Name, ["kind"] = n.Kind, ["x"] = n.X, ["y"] = n.Y, ["targets"] = new JsonArray(n.Targets.Select(t => (JsonNode)t).ToArray()) }).ToArray()) });
    });
}
