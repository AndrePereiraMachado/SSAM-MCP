using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        try
        {
            if (args is ["mac-inspect"]) { Console.WriteLine((await MacPlatform.InspectHost()).ToJsonString(new() { WriteIndented = true })); return 0; }
            if (args.Length > 0 && args[0] is "run" or "setup" or "doctor") return await NativeHost.Command(args);
            if (args is ["check-policy", "--root", var policyRoot])
            {
                var policy = new StudioKinds(policyRoot, AppContext.BaseDirectory, new(), () => null);
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected requests");
                var results = new JsonArray();
                foreach (var request in requests.OfType<JsonObject>())
                {
                    try
                    {
                        JsonNode value = StudioKinds.Text(request["kind"]) == "odc.pipe"
                            ? new JsonArray(policy.MapOdc(request).Select(s => (JsonNode?)JsonValue.Create(s)).ToArray())
                            : policy.MapO11(StudioKinds.Text(request["method"]) ?? "", request["params"] as JsonObject ?? new());
                        results.Add((JsonNode)new JsonObject { ["value"] = value });
                    }
                    catch (AgentFault e) { results.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                    catch (PathRefusal e) { results.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(results.ToJsonString()); return 0;
            }
            if (args is ["check-paths", "--root", var pathRoot])
            {
                var workspace = new Workspace(pathRoot);
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray
                    ?? throw new ArgumentException("Expected a JSON array");
                var answers = new JsonArray();
                foreach (var request in requests)
                {
                    try
                    {
                        var value = request!["value"]!.GetValue<string>();
                        var write = request["write"]?.GetValue<bool>() == true;
                        var result = request["op"]?.GetValue<string>() switch {
                            "absolute" => workspace.CheckAbsolute(value, write),
                            "toAgent" => workspace.ToAgent(value, write),
                            _ => workspace.Resolve(value, write)
                        };
                        answers.Add((JsonNode)new JsonObject { ["value"] = result });
                    }
                    catch (PathRefusal e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            if (args is ["version"])
            {
                Console.WriteLine("{\"runtime\":\"native-aot\",\"protocol\":\"ssam-agent/1\",\"productionReady\":false}");
                return 0;
            }
            // Qualification is deliberately loopback-only until all existing kinds are ported.
            // No production credentials or installed Studio session are used by this mode.
            if (args is not ["qualify", "--root", var root, "--server", var server, "--bridge-port", var portText]
                || !int.TryParse(portText, out var port) || port is < 1 or > 65535)
                throw new ArgumentException("Use qualify --root <empty test directory> --server http://127.0.0.1:<port> --bridge-port <port>");
            var uri = new Uri(server);
            if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.AbsolutePath != "/" || uri.Query != "" || uri.UserInfo != "")
                throw new ArgumentException("Qualification accepts only an IPv4 loopback HTTP server");
            var state = new StateStore(root);
            var credential = await Console.In.ReadLineAsync();
            if (credential != "ssam_native_qualification") throw new ArgumentException("Qualification credential required on stdin");
            using var lifetime = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
            using var transport = new AgentChannel(uri, credential, state, port);
            var run = transport.RunAsync(lifetime.Token);
            while (!run.IsCompleted && !lifetime.IsCancellationRequested)
            {
                if (File.Exists(Path.Combine(state.Private, "agent.stop"))) { lifetime.Cancel(); break; }
                await Task.WhenAny(run, Task.Delay(100));
            }
            return await run;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e is ArgumentException ? e.Message : e.GetType().Name);
            return 1;
        }
    }
}

internal sealed class StateStore
{
    private string? previousState;
    public string Root { get; }
    public string Private { get; }
    public StateStore(string root, bool qualification = true)
    {
        if (!Path.IsPathFullyQualified(root)) throw new ArgumentException("Data root must be absolute");
        Root = Path.GetFullPath(root);
        // The qualification harness must own an empty directory; never adopt a user's agent data.
        if (qualification && Directory.Exists(Root) && Directory.EnumerateFileSystemEntries(Root).Any())
            throw new ArgumentException("Qualification needs an empty test directory");
        Private = Path.Combine(Root, "private");
        Directory.CreateDirectory(Private);
        foreach (var folder in new[] { "odc/snapshots", "odc/journal/staging", "odc/lab", "o11/journal/staging", "o11/downloads", "inbox", "private/tmp" })
            Directory.CreateDirectory(Path.Combine(Root, folder));
    }
    public void Write(string state, int? code = null)
    {
        var json = new JsonObject { ["state"] = state, ["pid"] = Environment.ProcessId,
            ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["exitCode"] = code };
        var destination = Path.Combine(Private, "agent.json");
        var temp = destination + ".tmp";
        File.WriteAllText(temp, json.ToJsonString());
        File.Move(temp, destination, true);
        if (previousState != state) {
            File.AppendAllText(Path.Combine(Private, "agent.log"), json.ToJsonString() + Environment.NewLine);
            previousState = state;
        }
    }
}
