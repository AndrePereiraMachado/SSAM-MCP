using System.Text.Json.Nodes;
using Ssam.Agent;

var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!;
var root = input["root"]!.GetValue<string>();
using var updates = new BridgeUpdates(root, root, input["publicKey"]!.GetValue<string>(), input["thumbprint"]!.GetValue<string>(), (_, _) => Task.CompletedTask);
using var channel = new AgentChannel(new Uri(input["server"]!.GetValue<string>()), input["credential"]!.GetValue<string>(), new StateStore(root, false), 4516,
    runtime: root, pack: input["pack"]!.AsObject(), bridgeUpdates: updates, discoverStudios: () => input["installed"]!.DeepClone().AsObject());
using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(40));
var running = channel.RunAsync(deadline.Token);
var commandFile = Path.Combine(root, "private/test-command.json");
while (!running.IsCompleted)
{
    if (!File.Exists(commandFile)) { await Task.Delay(20); continue; }
    var command = JsonNode.Parse(File.ReadAllText(commandFile))!; File.Delete(commandFile);
    if (command["op"]?.GetValue<string>() == "stop") break;
    var result = new JsonObject();
    try { updates.Reconcile((command["running"] as JsonArray)!, input["installed"]!.AsObject()); updates.Changed?.Invoke(); }
    catch (Exception error) { result["error"] = error.GetType().Name; }
    result["reports"] = updates.Reports(); Console.WriteLine(result.ToJsonString());
}
deadline.Cancel(); await running;
