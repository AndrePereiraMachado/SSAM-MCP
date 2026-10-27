using System.Diagnostics;
using System.Text.Json.Nodes;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;

namespace Anvil.Core;

/// <summary>The delivery's merge order on files, headless (MergeOrder over ModelHost): Plan before the merge, Missing on
/// the delivered snapshot. The O11 deliver path calls it through Delivery.IMergePlanner; MergeProbe uses Plan.</summary>
public sealed class MergePlanner : Delivery.IMergePlanner, Delivery.IMergeContentVerifier
{
    private readonly Func<string, ModelHost> host;
    public MergePlanner(Func<string, ModelHost> host) => this.host = host;

    public JsonObject VerifyContent(string expectedPath, string snapshotPath)
        => MergeContentProof.Check(host(Path.GetDirectoryName(snapshotPath)!), expectedPath, snapshotPath);

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

    public JsonObject Plan(string basePath, string foreignPath, string firstPassPath) => Plan(basePath, foreignPath, firstPassPath, preview: true);

    /// <summary>The merge order alone, without the disposable native merge: the delivery's rule (a), when the open module
    /// equals the delivery's base, so the live merge takes the candidate as is and the proof after it is the only one.</summary>
    public JsonObject PlanOrder(string basePath, string foreignPath, string firstPassPath) => Plan(basePath, foreignPath, firstPassPath, preview: false);

    private JsonObject Plan(string basePath, string foreignPath, string firstPassPath, bool preview)
    {
        var clock = Stopwatch.StartNew();
        var modelHost = host(Path.GetDirectoryName(foreignPath)!);
        var baseBytes = File.ReadAllBytes(basePath); var foreignBytes = File.ReadAllBytes(foreignPath);
        var (deferred, firstPass) = Plan(modelHost, baseBytes, foreignBytes);
        if (firstPass != null) Delivery.DurableJson.WriteBytes(firstPassPath, firstPass);
        var timings = new JsonObject { ["orderMs"] = clock.ElapsedMilliseconds };
        var plan = new JsonObject { ["rule"] = MergeOrder.Rule, ["deferred"] = MergeOrder.ToJson(deferred), ["firstPass"] = firstPass == null ? null : firstPassPath };
        if (!preview)
        {
            plan["contentPreviewSupported"] = false; plan["contentPreview"] = null; plan["contentPreviewSkipped"] = true; plan["timings"] = timings;
            return plan;
        }
        var previewPath = Path.Combine(Path.GetDirectoryName(firstPassPath)!, "merge-content-preview.oml");
        // The disposable native merge is a proof before the live one, never a new way for the plan to fail: a preview that
        // cannot run is said (contentPreviewError) and the delivery keeps the merge of before, proved after it.
        JsonObject? previewed = null; string? previewError = null;
        var previewClock = Stopwatch.StartNew();
        try { previewed = NativeMergePreview.Check(modelHost, baseBytes, foreignBytes, firstPass, foreignPath, previewPath); }
        catch (Exception error) when (error is not OutOfMemoryException) { previewError = Errors.Text(error); }
        timings["previewMs"] = previewClock.ElapsedMilliseconds;
        plan["contentPreviewSupported"] = previewed != null; plan["contentPreview"] = previewed; plan["contentPreviewError"] = previewError; plan["timings"] = timings;
        return plan;
    }

    public JsonArray Missing(string snapshotPath, JsonArray deferred)
    {
        var model = host(Path.GetDirectoryName(snapshotPath)!).Load(File.ReadAllBytes(snapshotPath));
        try { return MergeOrder.ToJson(MissingByName(model, MergeOrder.FromJson(deferred))); }
        finally { ModelHost.Release(model); }
    }

    /// <summary>The deferred defaults the delivered module does not carry. Each element is found by its name path (the names
    /// of its owners below the module, MergeOrder's Element), never by its local key: the native merge may give an element
    /// a new key (MergeContentProof.IdentityRule). A missing entry carries the delivered element's keys, so its repair
    /// targets the element as it is now; an element the module does not have (or that two elements answer) keeps the
    /// planned keys.</summary>
    internal static IReadOnlyList<DeferredDefault> MissingByName(ESpace live, IReadOnlyList<DeferredDefault> deferred)
    {
        var owners = live.GetAllChildrenOfType<IObjectWithDefaultValue>().Where(o => o is AbstractObject a && a.FindParent<ITopLevelReferenceElement>() == null)
            .GroupBy(ElementName, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var missing = new List<DeferredDefault>();
        foreach (var d in deferred)
        {
            var found = owners.GetValueOrDefault(d.Element) ?? [];
            if (found.Any(o => (o.DefaultValue?.GetText() ?? "") == d.Value)) continue;
            missing.Add(found.Count == 1 ? d with { Key = ((AbstractObject)found[0]).Key.ToString()!, ObjectKey = ObjectKeyOf(found[0]) } : d);
        }
        return missing;
    }

    /// <summary>MergeOrder's Element: the names of the element and its owners below the module, joined by '.'.</summary>
    internal static string ElementName(IObjectWithDefaultValue o)
    {
        var names = new List<string>();
        for (var x = (AbstractObject?)o; x != null && x is not ESpace; x = x.GetParent())
            if (!string.IsNullOrEmpty(x.Name)) names.Add(x.Name);
        names.Reverse();
        return string.Join(".", names);
    }

    private static string ObjectKeyOf(IObjectWithDefaultValue o)
        => (o as OutSystems.Model.IObjectSignature)?.ObjectKey?.ToString() ?? ((AbstractObject)o).Key.ToString()!.Split('/').Last().Split('.').Last();
}
