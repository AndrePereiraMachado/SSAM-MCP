using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Ssam.Agent;

// Test-only process: no production entry point accepts keys or certificate-verifier overrides.
var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!;
var key = input["publicKey"]!.GetValue<string>();
if (input["verify"] is JsonArray checks)
{
    var results = checks.Select(c => BridgeTrust.Verify(Convert.FromBase64String(c!["message"]!.GetValue<string>()), Convert.FromBase64String(c["signature"]!.GetValue<string>()), key));
    Console.WriteLine(new JsonArray(results.Select(b => (JsonNode?)JsonValue.Create(b)).ToArray()).ToJsonString());
    return;
}
var root = input["root"]!.GetValue<string>();
var thumb = input["thumbprint"]!.GetValue<string>();
var accepted = input["authenticode"]?.GetValue<bool>() != false;
var checksCount = 0;
using var store = new BridgeUpdates(root, root, key, thumb, (_, _) => { checksCount++; return accepted ? Task.CompletedTask : Task.FromException(new IOException("Test certificate refused")); }, input["pack"] as JsonObject);
if (input["channel"]?.GetValue<bool>() == true)
{
    using var channel = new AgentChannel(new Uri(input["server"]!.GetValue<string>()), "bridge-test-token", new StateStore(root, false), 4516,
        pack: new JsonObject { ["id"] = "bridge-test", ["lanes"] = new JsonArray("odc"), ["odcBridge"] = "v98" }, bridgeUpdates: store,
        discoverStudios: () => (JsonObject)input["installed"]!.DeepClone());
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    var code = await channel.RunAsync(timeout.Token);
    Console.WriteLine(new JsonObject { ["exitCode"] = code }.ToJsonString());
    return;
}
using var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false }) { BaseAddress = new Uri(input["server"]!.GetValue<string>()) };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "bridge-test-token");
var resultsList = new JsonArray();
foreach (var request in input["requests"]!.AsArray())
{
    var lane = request?["lane"]?.GetValue<string>() ?? "odc";
    var version = request?["version"]?.GetValue<string>() ?? "1.7.30";
    var framework = request?["runtime"]?.GetValue<string>() ?? "net10.0";
    if (request?["offer"] is JsonObject offer)
    {
        var welcome = new JsonObject { ["compatible"] = new JsonObject { [lane] = new JsonObject { ["bridgeOffer"] = offer.DeepClone() } } };
        var studios = new JsonObject { [lane] = new JsonObject { ["installed"] = new JsonObject { ["version"] = version, ["runtime"] = framework } } };
        var changed = await store.Offers(welcome, studios, http, CancellationToken.None);
        resultsList.Add((JsonNode)new JsonObject { ["changed"] = changed, ["checks"] = checksCount, ["reports"] = store.Reports(), ["status"] = store.Status?.DeepClone() });
    }
    else
    {
        var context = new JsonObject { ["pid"] = 1234, ["startedUtc"] = request?["startedUtc"]?.GetValue<string>() ?? "S" };
        var selected = await store.Select(lane, version, framework, CancellationToken.None, context);
        if (selected != null && request?["failLoad"]?.GetValue<bool>() == true) store.RejectLoad(selected, "Test bridge failure", context,
            request?["attempted"]?.GetValue<bool>() ?? true, request?["bridgeFailure"]?.GetValue<bool>() ?? true);
        var protectedCopy = false;
        if (selected != null && request?["prepare"]?.GetValue<bool>() == true)
        {
            using var snapshot = await store.PrepareAttach(selected, context, CancellationToken.None);
            try { File.WriteAllText(snapshot.Bridge.FileNamed("ODC3.Bridge.dll", "ODC3.Bridge.v100.dll", "ODC3.Bridge.v101.dll"), "tampered"); }
            catch (IOException) { protectedCopy = true; }
        }
        resultsList.Add((JsonNode)new JsonObject { ["selected"] = selected?.Protocol, ["sequence"] = selected?.Manifest["sequence"]?.DeepClone(),
            ["checks"] = checksCount, ["protectedCopy"] = protectedCopy, ["reports"] = store.Reports(), ["status"] = store.Status?.DeepClone() });
    }
}
Console.WriteLine(resultsList.ToJsonString());
