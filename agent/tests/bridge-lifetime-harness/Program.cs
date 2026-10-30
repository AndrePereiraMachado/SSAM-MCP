using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json.Nodes;
using Ssam.Agent;

// The test adapter also compiles against c308892. Optional new APIs are accessed only here by reflection.
var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!;
var root = input["root"]!.GetValue<string>();
BridgeUpdates Store() => new(root, root, input["publicKey"]!.GetValue<string>(), input["thumbprint"]!.GetValue<string>(), (_, _) => Task.CompletedTask,
    new JsonObject { ["odcBridge"] = "v98", ["odcRuntime"] = "net8.0" });
var store = Store(); BridgeLease? lease = null; InstalledBridge? selected = null; FileStream? hold = null;
var results = new JsonArray();
using var http = new HttpClient { BaseAddress = new Uri(input["server"]!.GetValue<string>()) };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "bridge-test-token");
var context = new JsonObject { ["pid"] = 2000000000, ["startedUtc"] = "2026-10-28T10:00:16.9925336Z" };
var installed = new JsonObject { ["odc"] = new JsonObject { ["installed"] = new JsonObject { ["version"] = "1.7.30", ["runtime"] = "net10.0" } } };
foreach (var action in input["actions"]!.AsArray())
{
    var result = new JsonObject();
    try
    {
        if (action!["context"] is JsonObject supplied) context = (JsonObject)supplied.DeepClone();
        switch (action!["op"]!.GetValue<string>())
        {
            case "offer":
                var studios = (JsonObject)installed.DeepClone(); if (action["runtimeNull"]?.GetValue<bool>() == true) studios["odc"]!["installed"]!["runtime"] = null;
                result["changed"] = await store.Offers(new JsonObject { ["compatible"] = new JsonObject { ["odc"] = new JsonObject { ["bridgeOffer"] = action["offer"]!.DeepClone() } } }, studios, http, CancellationToken.None); break;
            case "select": selected = await store.Select("odc", "1.7.30", "net10.0", CancellationToken.None, context); result["selected"] = selected?.Protocol; break;
            case "prepare": lease = await store.PrepareAttach(selected!, context, CancellationToken.None); break;
            case "active": store.MarkActive(selected!, context); break;
            case "failed": store.RejectLoad(selected!, "load failure", context, true, true); break;
            case "retain": lease!.GetType().GetMethod("Retain", BindingFlags.Instance | BindingFlags.NonPublic)?.Invoke(lease, null); break;
            case "dispose-lease": lease!.Dispose(); break;
            case "hold": hold = File.Open(lease!.Bridge.FileNamed("ODC3.Bridge.v100.dll"), FileMode.Open, FileAccess.Read, FileShare.Read); break;
            case "unhold": hold?.Dispose(); hold = null; break;
            case "reconcile": store.Reconcile((action["running"] as JsonArray)!, installed); break;
            case "restart-without-report":
                var file = Path.Combine(root, "private/bridge-state.json"); var state = JsonNode.Parse(File.ReadAllText(file))!; state["reports"] = new JsonObject(); File.WriteAllText(file, state.ToJsonString()); store.Dispose(); store = Store(); break;
            case "initialize":
                if (typeof(BridgeUpdates).GetMethod("Initialize", BindingFlags.Instance | BindingFlags.NonPublic)?.Invoke(store, [installed, CancellationToken.None]) is Task task) await task; break;
        }
    }
    catch (Exception e) { result["error"] = e.GetType().Name; }
    result["reports"] = store.Reports(); result["protocol"] = store.ProtocolFor("odc", "1.7.30", context);
    result["needs"] = typeof(BridgeUpdates).GetProperty("NeedsReconcile", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(store) is bool needs ? JsonValue.Create(needs) : null;
    if (lease != null)
    {
        result["directory"] = Directory.Exists(lease.Bridge.Root); result["index"] = File.Exists(lease.Bridge.Root + ".json");
        try { using var writer = File.Open(lease.Bridge.FileNamed("ODC3.Bridge.v100.dll"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite); result["locked"] = false; }
        catch (IOException) { result["locked"] = true; }
    }
    results.Add((JsonNode)result);
}
hold?.Dispose(); store.Dispose(); Console.WriteLine(results.ToJsonString());
