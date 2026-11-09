using System.Text.Json.Nodes;
using Ssam.Agent;

// This harness intentionally uses only APIs present in f4b301e as well as the corrected core.
var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!;
var root = input["root"]!.GetValue<string>();
var bridge = new BridgeUpdates(root, root, input["publicKey"]!.GetValue<string>(), (_, _) => Task.CompletedTask);
using var channel = new AgentChannel(new Uri(input["server"]!.GetValue<string>()), input["credential"]!.GetValue<string>(), new StateStore(root, false), 4516,
    runtime: root, pack: input["pack"]!.AsObject(), bridgeUpdates: bridge, discoverStudios: () => input["installed"]!.DeepClone().AsObject());
using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
var result = await channel.RunAsync(deadline.Token);
Console.WriteLine(new JsonObject { ["exitCode"] = result }.ToJsonString());
