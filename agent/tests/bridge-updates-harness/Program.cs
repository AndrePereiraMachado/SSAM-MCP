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
var store = new BridgeUpdates(root, root, key, thumb, (_, _) => accepted ? Task.CompletedTask : Task.FromException(new IOException("Test certificate refused")));
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
        resultsList.Add((JsonNode)new JsonObject { ["changed"] = changed, ["status"] = store.Status?.DeepClone() });
    }
    else
    {
        var selected = await store.Select(lane, version, framework, CancellationToken.None);
        if (selected != null && request?["failLoad"]?.GetValue<bool>() == true) store.RejectLoad(selected);
        resultsList.Add((JsonNode)new JsonObject { ["selected"] = selected?.Protocol, ["status"] = store.Status?.DeepClone() });
    }
}
Console.WriteLine(resultsList.ToJsonString());
