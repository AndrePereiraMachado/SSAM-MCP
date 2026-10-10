using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Anvil.Core.Hosting;

// C02 item 2 (package 3): the resident builder. One process per generation of the builder binaries answers manifest
// requests: the ODC Studio assemblies bound and the JIT warm, the Model API configured once (PrepareManifest.Services), one
// load of the base and one of the candidate per request, each side's Verify read once. A kernel candidate with its receipt
// loads nothing at all (B1). The same plumbing as the resident reader (SnapshotReadServer): loopback WorkerServer, the
// controller key of the local Hybrid authority, a state file the facade reads, exit after 15 idle minutes.
// Request: ["manifest", "{\"root\": <builder root>, \"args\": [--base ..., --candidate ..., ...]}"] -> {ok, data: {manifest}}.
internal static class ManifestServer {
    public static int Run(string stateFile, string generation) {
        var credential = BridgeAccess.ReadCredential();
        if (string.IsNullOrWhiteSpace(credential)) throw new InvalidOperationException("Local Hybrid authority is not initialized");
        var lastRequest = Stopwatch.GetTimestamp();
        using var server = new WorkerServer(0, args => {
            Interlocked.Exchange(ref lastRequest, Stopwatch.GetTimestamp());
            if (args.Length != 2 || args[0] != "manifest") throw new ArgumentException("The manifest server accepts only manifest requests");
            var started = Stopwatch.StartNew();
            var request = JsonNode.Parse(args[1])!.AsObject();
            var argv = request["args"]!.AsArray().Select(a => a!.GetValue<string>()).ToArray();
            var manifest = PrepareManifest.Prepare(argv, request["root"]!.GetValue<string>());
            return new JsonObject { ["ok"] = true, ["command"] = "manifest", ["elapsedMs"] = started.ElapsedMilliseconds,
                ["data"] = new JsonObject { ["manifest"] = manifest, ["resident"] = true } };
        }, initialMetrics: new JsonObject { ["manifestGeneration"] = generation, ["readOnly"] = false },
            authorize: request => BridgeAccess.Matches(request["authorization"]?.GetValue<string>(), credential));
        var state = new JsonObject { ["port"] = server.Port, ["pid"] = Environment.ProcessId,
            ["instanceId"] = server.InstanceId, ["generation"] = generation, ["runtime"] = Environment.Version.ToString() };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(stateFile))!);
        var temporary = stateFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, state.ToJsonString()); File.Move(temporary, stateFile, true);
        using var idle = new Timer(_ => {
            if (Stopwatch.GetElapsedTime(Interlocked.Read(ref lastRequest)).TotalMinutes > 15 && server.Status()["busy"]?.GetValue<bool>() != true)
                server.Stop();
        }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        server.RunAsync().GetAwaiter().GetResult();
        return 0;
    }
}
