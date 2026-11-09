using System.Reflection;
using System.Text.Json.Nodes;
using Ssam.Agent;

var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!;
JsonObject Assess(JsonNode row) {
    var type = typeof(AuthenticodeTrust.Evidence);
    var constructor = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).OrderByDescending(c => c.GetParameters().Length).First();
    object?[] args = [row["valid"]?.GetValue<bool>() ?? false, row["thumbprint"]?.GetValue<string>() ?? "owner", row["organization"]?.GetValue<string>() ?? "Microsoft Corporation", row["eku"]?.GetValue<bool>() ?? true, row["root"]?.GetValue<string>() ?? "root", unchecked((int)(row["hresult"]?.GetValue<long>() ?? 0)), row["policyFailure"]?.GetValue<bool>() ?? false, null];
    var evidence = (AuthenticodeTrust.Evidence)constructor.Invoke(args.Take(constructor.GetParameters().Length).ToArray());
    var method = typeof(AuthenticodeTrust).GetMethod("Assess", BindingFlags.Static | BindingFlags.NonPublic);
    // 0.4.14-native: Assess(evidence, signer, roots); the signer class is "microsoft" unless the row names another.
    if (method != null) return (JsonObject)method.Invoke(null, [evidence, row["signer"]?.GetValue<string>() ?? "microsoft", new[] { "root" }])!;
    var ok = AuthenticodeTrust.Accept(evidence, row["signer"]?.GetValue<string>() ?? "microsoft", ["root"]);
    return new() { ["ok"] = ok, ["signatureValid"] = evidence.Valid, ["definitive"] = !ok };
}
void Require(JsonObject evidence, JsonObject manifest) {
    var method = typeof(BridgeUpdates).GetMethod("RequireAuthenticode", BindingFlags.Static | BindingFlags.NonPublic);
    if (method == null) { if (evidence["ok"]?.GetValue<bool>() != true) throw new SignedManifestRefusal(manifest); return; }
    try { method.Invoke(null, [evidence, manifest]); } catch (TargetInvocationException ex) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException!).Throw(); }
}
if (input["evidence"] is JsonArray rows) {
    Console.WriteLine(new JsonArray(rows.Select(row => (JsonNode)Assess(row!)).ToArray()).ToJsonString()); return;
}
if (input["file"] != null) {
    Console.WriteLine(AuthenticodeTrust.Check(input["file"]!.GetValue<string>(), "microsoft").ToJsonString()); return;
}
var root = input["root"]!.GetValue<string>(); JsonObject current = new(); JsonObject decision = new();
using var store = new BridgeUpdates(root, root, input["publicKey"]!.GetValue<string>(), (_, _) => { Require(decision, current); return Task.CompletedTask; });
using var http = new HttpClient { BaseAddress = new Uri(input["server"]!.GetValue<string>()) };
http.DefaultRequestHeaders.Authorization = new("Bearer", "bridge-test-token");
var results = new JsonArray();
foreach (var request in input["requests"]!.AsArray()) {
    if (request?["select"]?.GetValue<bool>() == true) {
        decision = Assess(request["evidence"]!);
        using var reopened = new BridgeUpdates(root, root, input["publicKey"]!.GetValue<string>(), (_, _) => { Require(decision, current); return Task.CompletedTask; });
        var selected = await reopened.Select("odc", "1.7.30", "net10.0", CancellationToken.None);
        results.Add(new JsonObject { ["selected"] = selected?.Protocol, ["reports"] = reopened.Reports(), ["status"] = reopened.Status?.DeepClone(), ["wire"] = reopened.WireStatus() });
        continue;
    }
    var offer = request!["offer"]!.AsObject(); current = JsonNode.Parse(offer["manifest"]!.GetValue<string>())!.AsObject(); decision = Assess(request["evidence"]!);
    // Owner pin used by this generated manifest is independent of the synthetic certificate fixture.
    var changed = await store.Offers(new JsonObject { ["compatible"] = new JsonObject { ["odc"] = new JsonObject { ["bridgeOffer"] = offer.DeepClone() } } }, new JsonObject { ["odc"] = new JsonObject { ["installed"] = new JsonObject { ["version"] = "1.7.30", ["runtime"] = "net10.0" } } }, http, CancellationToken.None);
    results.Add(new JsonObject { ["changed"] = changed, ["reports"] = store.Reports(), ["status"] = store.Status?.DeepClone(), ["wire"] = store.WireStatus(), ["state"] = File.Exists(Path.Combine(root, "private/bridge-state.json")) ? JsonNode.Parse(File.ReadAllText(Path.Combine(root, "private/bridge-state.json"))) : null });
}
Console.WriteLine(results.ToJsonString());
