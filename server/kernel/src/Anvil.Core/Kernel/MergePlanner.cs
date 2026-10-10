using System.Text.Json.Nodes;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>The delivery's merge order on files, headless (MergeOrder over ModelHost): Plan before the merge, Missing on
/// the delivered snapshot. The O11 deliver path calls it through Delivery.IMergePlanner; MergeProbe uses Plan.</summary>
public sealed class MergePlanner : Delivery.IMergePlanner
{
    private readonly Func<string, ModelHost> host;
    public MergePlanner(Func<string, ModelHost> host) => this.host = host;

    public static (IReadOnlyList<DeferredDefault> Deferred, byte[]? FirstPass) Plan(ModelHost host, byte[] baseBytes, byte[] foreignBytes)
        => Plan(host, baseBytes, foreignBytes, MergeOrder.ReadOnlyRule);

    /// <summary>rule: the Studio's read-only rule, null as in a Studio build without it (every default deferred).</summary>
    internal static (IReadOnlyList<DeferredDefault> Deferred, byte[]? FirstPass) Plan(ModelHost host, byte[] baseBytes, byte[] foreignBytes, System.Reflection.MethodInfo? rule)
    {
        ESpace? foreign = null, basis = null;
        try
        {
            using var timing = NativePerformanceCapture.Measure("merge.order", cpu: true);
            foreign = host.Load(foreignBytes);
            // Only a candidate with a read-only default needs the base: most deliveries load one model here.
            if (!MergeOrder.HasReadOnlyDefault(foreign, rule)) return (Array.Empty<DeferredDefault>(), null);
            basis = host.Load(baseBytes);
            var deferred = MergeOrder.Plan(foreign, basis, rule);
            if (deferred.Count == 0) return (deferred, null);
            StudioAdapter.Runtime.Mutate(foreign, "Anvil: merge order, first pass", _ => MergeOrder.Strip(foreign, deferred));
            return (deferred, host.Save(foreign));
        }
        finally { ModelHost.Release(foreign); ModelHost.Release(basis); }
    }

    public JsonObject Plan(string basePath, string foreignPath, string firstPassPath)
    {
        var (deferred, firstPass) = Plan(host(Path.GetDirectoryName(foreignPath)!), File.ReadAllBytes(basePath), File.ReadAllBytes(foreignPath));
        if (firstPass != null) Delivery.DurableJson.WriteBytes(firstPassPath, firstPass);
        return new JsonObject { ["rule"] = MergeOrder.Rule, ["deferred"] = MergeOrder.ToJson(deferred), ["firstPass"] = firstPass == null ? null : firstPassPath };
    }

    public JsonArray Missing(string snapshotPath, JsonArray deferred)
    {
        var model = host(Path.GetDirectoryName(snapshotPath)!).Load(File.ReadAllBytes(snapshotPath));
        try { return MergeOrder.ToJson(MergeOrder.Missing(model, MergeOrder.FromJson(deferred))); }
        finally { ModelHost.Release(model); }
    }
}
