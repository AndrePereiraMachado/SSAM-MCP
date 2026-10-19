using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>The server half of the thin O11 bridge (docs/O11-BRIDGE-FINA.md section 4). With ANVIL_BRIDGE_FLAVOR=thin,
/// which only the hosted spawn environment sets, the kernel computes here what the full bridge computed inside the
/// Studio: the producer signature plan of merge_from_oml (reference_plan) and find_element over a capture. The verbs
/// the thin bridge does not have are refused here. Every failure before the request reaches the bridge is
/// executed:false, so a delivery records not-sent instead of an unknown write; a failure of send passes as it is.
/// Studio model types are touched only in the NoInlining helpers (the capture is held as object): a pass-through call
/// never loads the Studio assemblies.</summary>
internal sealed class ThinBridge(Func<string, JsonObject?, JsonObject> send)
{
    // No kernel or facade caller needs these in hosted mode; get_flow_nodes is deliberately not emulated.
    private static readonly string[] Refused = ["login", "export_modules", "export_status", "get_flow_nodes"];
    private object? capture;
    private JsonNode? captureModuleKey, captureEnvironment;

    public static bool Enabled => Environment.GetEnvironmentVariable("ANVIL_BRIDGE_FLAVOR") == "thin";

    /// <summary>The socket timeout: at least ANVIL_BRIDGE_TIMEOUT_SECONDS when it is set (hosted: the file mirror of the
    /// relay counts inside it).</summary>
    public static int EffectiveTimeout(int requested)
        => int.TryParse(Environment.GetEnvironmentVariable("ANVIL_BRIDGE_TIMEOUT_SECONDS"), NumberStyles.None, CultureInfo.InvariantCulture, out var floor)
            ? Math.Max(requested, floor) : requested;

    private static string WorkDirectory => Path.Combine(Path.GetTempPath(), "thin-bridge", "model");

    public JsonObject Call(string method, JsonObject? parameters)
    {
        if (method == "find_element") return Find(parameters);
        DropCapture();
        if (Refused.Contains(method)) throw NotSent(method, "not available with the thin bridge (hosted)");
        if (method == "merge_from_oml" && parameters?["base_path"] != null)
            return send(method, BeforeSend(method, () => WithReferencePlan(parameters)));
        // a8 round 2 (IP option D): the thin bridge answers the problems of the Studio's Manage Dependencies with their causes
        // and facts; the explanation and the fix are written here, on the server (ManageDependenciesText).
        if (method == "refresh_references") return ManageDependenciesText.Render(send(method, parameters));
        return send(method, parameters);
    }

    /// <summary>The thin bridge requires reference_plan whenever base_path is present (section 3.3): it is
    /// Analyze(base, candidate, base) over the server's own files, replacing any value the caller set. With the merge
    /// order (first_pass_path, Delivery) the first native merge loads the first-pass copy instead of the candidate, so the
    /// plan is over that copy, as the full bridge's Analyze(local, first pass, base); the second merge (candidate over the
    /// copy) has no reference to select, because the copy differs from the candidate only by the deferred defaults.</summary>
    private static JsonObject WithReferencePlan(JsonObject parameters)
    {
        var basePath = parameters["base_path"]!.GetValue<string>();
        var foreignPath = parameters["first_pass_path"]?.GetValue<string>() ?? parameters["foreign_path"]?.GetValue<string>()
            ?? throw new InvalidOperationException("'foreign_path' is required");
        var plan = ReferencePlan(new ModelHost(WorkDirectory), basePath, foreignPath);
        var forwarded = parameters.DeepClone().AsObject();
        forwarded["reference_plan"] = plan;
        return forwarded;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static JsonNode? ReferencePlan(ModelHost host, string basePath, string foreignPath)
    {
        ESpace? basis = null, foreign = null;
        try
        {
            basis = host.Load(basePath);
            foreign = host.Load(foreignPath);
            return JsonSerializer.SerializeToNode(ReferenceSignatureMerge.Analyze(basis, foreign, basis));
        }
        finally { ModelHost.Release(foreign); ModelHost.Release(basis); }
    }

    /// <summary>find_element over one capture of the open module (section 4.3). The loaded capture serves consecutive
    /// find_element calls with the same module_key and environment; any other verb drops it, and so does the end of the
    /// delivery that asked for it (ReleaseCapture).</summary>
    private JsonObject Find(JsonObject? parameters)
    {
        const string verb = "find_element";
        var (name, max) = BeforeSend(verb, () => (parameters?["name"]?.GetValue<string>() ?? throw new InvalidOperationException("'name' is required"),
            parameters?["max"]?.GetValue<int>() ?? 20));
        var moduleKey = parameters?["module_key"];
        var environment = parameters?["environment"];
        if (capture == null || !JsonNode.DeepEquals(captureModuleKey, moduleKey) || !JsonNode.DeepEquals(captureEnvironment, environment))
        {
            DropCapture();
            var path = BeforeSend(verb, () =>
            {
                var file = Path.Combine(Path.GetTempPath(), "thin-bridge", Guid.NewGuid().ToString("N") + ".oml");
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                return file;
            });
            var snapshot = new JsonObject { ["path"] = path };
            if (moduleKey != null) snapshot["module_key"] = moduleKey.DeepClone();
            if (environment != null) snapshot["environment"] = environment.DeepClone();
            send("snapshot_module", snapshot);
            capture = BeforeSend(verb, () => LoadCapture(path));
            captureModuleKey = moduleKey?.DeepClone();
            captureEnvironment = environment?.DeepClone();
        }
        return BeforeSend(verb, () => FindIn(capture!, name, max));
    }

    private static object LoadCapture(string path)
    {
        byte[] bytes;
        try { bytes = File.ReadAllBytes(path); }
        finally { File.Delete(path); }
        return Load(new ModelHost(WorkDirectory), bytes);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object Load(ModelHost host, byte[] oml) => host.Load(oml);

    /// <summary>The body of the full bridge's Reads.Find (kernel/src/Anvil.Bridge/Reads.cs), as a pure function over
    /// the loaded module: same matching, order, cut and shape {query, count, results:[{name, type, key, parent}]}.</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static JsonObject FindIn(object module, string name, int max)
    {
        var e = (ESpace)module;
        var results = new JsonArray();
        foreach (var o in EntityIndexes.IncludeNative(((IObjectSignature)e).GetAllDescendantsOfType<IObjectSignature>()))
        {
            var n = ModelHost.Prop(o, "Name") as string ?? ModelHost.Prop(o, "Label") as string;
            if (!string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) continue;
            results.Add(new JsonObject { ["name"] = n, ["type"] = EntityIndexes.TypeName(o) ?? ModelHost.Kind(o.GetInterface()?.Name ?? o.GetType().Name), ["key"] = o.ObjectKey?.ToString(), ["parent"] = o.Parent == null ? null : ModelHost.Prop(o.Parent, "Name") as string });
            if (results.Count >= max) break;
        }
        return new JsonObject { ["query"] = name, ["count"] = results.Count, ["results"] = results };
    }

    /// <summary>Releases the capture of find_element now (ModelHost.Release: the module leaves the Studio's statics, as
    /// the exit of a cold process frees it). Delivery.Run calls it when it ends, so a resident worker keeps no module
    /// between deliveries. The bridge stays usable: the next find_element takes a capture again.</summary>
    public void ReleaseCapture() => DropCapture();

    private void DropCapture()
    {
        if (capture is not { } module) return;
        capture = null; captureModuleKey = captureEnvironment = null;
        Release(module);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Release(object module) => ModelHost.Release((ESpace)module);

    private static T BeforeSend<T>(string method, Func<T> work)
    {
        try { return work(); }
        catch (Exception ex) { throw NotSent(method, Errors.Text(ex)); }
    }

    private static BridgeCallException NotSent(string method, string message)
        => new($"{method}: {message}; nothing was sent to the bridge, executed: false", false);
}
