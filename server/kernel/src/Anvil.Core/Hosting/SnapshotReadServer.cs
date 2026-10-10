using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;
using Anvil.Reading;

namespace Anvil.Core.Hosting;

public static class SnapshotReadServer
{
    public static int Run(string stateFile, string generation, Func<byte[], IReadSnapshot> load)
    {
        var credential = BridgeAccess.ReadCredential();
        if (string.IsNullOrWhiteSpace(credential)) throw new InvalidOperationException("Local Hybrid authority is not initialized");
        // A read request may also carry "index":"ensure" (SnapshotReadCache.EnsureIndex).
        var indexes = ModuleIndexStore.Default();
        var cache = new SnapshotReadCache(load, indexes);
        var lastRead = Stopwatch.GetTimestamp();
        using var server = new WorkerServer(0, args => {
            Interlocked.Exchange(ref lastRead, Stopwatch.GetTimestamp());
            if (args.Length != 2 || args[0] != "read") throw new ArgumentException("Read server accepts only read requests");
            return cache.Read(JsonNode.Parse(args[1])!.AsObject());
        }, initialMetrics: new JsonObject { ["readerGeneration"] = generation, ["readOnly"] = true, ["moduleIndex"] = indexes?.Root },
            authorize: request => BridgeAccess.Matches(request["authorization"]?.GetValue<string>(), credential));
        var state = new JsonObject { ["port"] = server.Port, ["pid"] = Environment.ProcessId,
            ["instanceId"] = server.InstanceId, ["generation"] = generation, ["runtime"] = Environment.Version.ToString() };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(stateFile))!);
        var temporary = stateFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, state.ToJsonString()); File.Move(temporary, stateFile, true);
        using var idle = new Timer(_ => {
            if (Stopwatch.GetElapsedTime(Interlocked.Read(ref lastRead)).TotalMinutes > 15 && server.Status()["busy"]?.GetValue<bool>() != true)
                server.Stop();
        }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        server.RunAsync().GetAwaiter().GetResult();
        // Native objects were created on the dispatch thread. Process exit releases the final
        // capture; replacement/eviction disposes earlier captures on that same thread.
        return 0;
    }
}
