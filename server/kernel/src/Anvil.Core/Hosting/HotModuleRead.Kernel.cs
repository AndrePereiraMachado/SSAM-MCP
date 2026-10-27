using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
namespace Anvil.Core.Hosting;

// S14: the part of HotModuleRead that reads over the write worker's spare (BaseModelCache, a Service Studio model).
// Kept apart from WorkerServer.cs, which the ODC builder shares: there the Reader stays null and a hot read answers Busy.
/// <summary>
/// S14 (leitura quente, docs/PLANO-PRIMEIRA-CERTA-E-VELOCIDADE-2026-10-24.md): a read of the snapshot reader
/// (<see cref="Anvil.Reading.SnapshotReadCache"/>: the flow, the selected actions, the digest, ...) answered by the write worker
/// over the spare of the same model (<see cref="BaseModelCache{TModel}.TryRead"/>, the identity of R3), when it holds one: the
/// same code as `read-serve`, the same files written to the same store, without loading the capture again. The spare is read
/// in place and stays the next apply's. `hot-read &lt;request&gt;`: the reader's request plus `indexRoot` (the store the facade
/// reads, absolute). Without a spare of that model, or with the worker not free (refused before the queue, see Handle), it
/// answers executed:false and the caller reads cold. The one wait: while the spare of the same model is being prepared, the
/// read joins that prefetch (BaseModelCache.Serves; the idle step ends after it) for at most JoinWait, else it is withdrawn.
/// </summary>
public static partial class HotModuleRead
{



    /// <summary>The same read over a test's own cache (no Studio type in the signature: both test projects call it).</summary>
    internal static JsonObject ServeFor(BaseModelCache.Own? own, string[] args) => Serve(own?.Cache, args);

    internal static JsonObject Serve(BaseModelCache<ServiceStudio.Model.ESpace>? cache, string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("hot-read takes one reader request");
        var request = JsonNode.Parse(args[1])?.AsObject() ?? throw new ArgumentException("the reader request must be an object");
        var root = request["indexRoot"]?.GetValue<string>();
        request.Remove("indexRoot");
        var file = Path.GetFullPath(request["file"]?.GetValue<string>() ?? throw new ArgumentException("file is required"));
        if (cache == null) return Miss("this worker keeps no spare (ANVIL_BASE_CACHE=off)", null);
        var store = !string.IsNullOrWhiteSpace(root) && Path.IsPathFullyQualified(root) ? new Anvil.Reading.ModuleIndexStore(root, Lane, "kernel") : Anvil.Reading.ModuleIndexStore.Default();
        var bytes = File.ReadAllBytes(file);
        JsonObject? answer = null;
        var hit = cache.TryRead(file, bytes, model =>
        {
            // The snapshot of the read process over the spare, never released by the reading (the cache owns it).
            using var reading = new Anvil.Reading.SnapshotReadCache(_ => new Anvil.Reading.ReadSnapshot<OutSystems.Model.IObjectSignature>(
                (OutSystems.Model.IObjectSignature)model, new KernelModelReader(), model.Name, () => { }), store);
            answer = reading.Read(request);
        }, out var receipt);
        if (!hit || answer == null) return Miss("no spare of this model in this worker", receipt);
        answer["hot"] = new JsonObject { ["reused"] = true, ["modelSha256"] = receipt["modelSha256"]?.DeepClone(), ["spare"] = receipt["prefetch"]?.DeepClone() };
        return answer;
    }

    // The lane of this build, as ModuleIndexStore.Default names it.
    private static string Lane => typeof(Anvil.Reading.ModuleIndexStore).Assembly.GetName().Name == "Anvil.Core.Odc" ? "odc" : "o11";

    private static JsonObject Miss(string why, JsonObject? receipt) => new() { ["ok"] = false, ["command"] = Command, ["executed"] = false, ["code"] = "HOT_READ_MISS",
        ["error"] = why + "; nothing ran", ["baseCache"] = receipt?.DeepClone() };
    static HotModuleRead() { Reader = args => Serve(BaseModelCache.Current, args); }
}
