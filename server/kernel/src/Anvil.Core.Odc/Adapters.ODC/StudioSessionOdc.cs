using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>What the bridge captured with <c>snapshot &lt;Module&gt;</c>: the OML on disk and its identity (the
/// <c>.oml.json</c> sidecar carries the same facts: module key, tenant host, Studio author, dependencies).</summary>
public sealed record OdcSnapshot(string Module, string ModuleKey, string Path, string Sha256, string CapturedAt, string? Host, string? DeveloperId, bool Modified, JsonObject Json);

/// <summary>Result of the merge sequence. <c>Ok</c> only when check-base, preview and merge all answered <c>ok=true</c>;
/// otherwise <c>FailedStep</c> names the refused step and <c>Refusal</c> is that JSON exactly as the bridge wrote it.</summary>
public sealed record OdcMergeOutcome(bool Ok, string? FailedStep, JsonObject? Refusal, JsonObject? CheckBase, JsonObject? Preview, JsonObject? Merge)
{
    public bool StrictlyEqual => Merge?["strictlyEqual"]?.GetValue<bool>() == true;
    public bool Merged => Merge?["merged"]?.GetValue<bool>() == true;
    public JsonObject ToJson() => new()
    {
        ["ok"] = Ok, ["failedStep"] = FailedStep, ["merged"] = Merged, ["strictlyEqual"] = StrictlyEqual,
        ["checkBase"] = CheckBase?.DeepClone(), ["preview"] = Preview?.DeepClone(), ["merge"] = Merge?.DeepClone(), ["refusal"] = Refusal?.DeepClone()
    };
}

/// <summary>
/// The live ODC Studio session of the Anvil kernel (WS2), over the bridge: capture the open module (snapshot), write
/// the manifest the bridge reads, and merge a candidate through the bridge's gates (check-base, preview, merge).
/// Nothing here edits the open model: the bridge's native CompareAndMerge does, and its receipt (<c>strictlyEqual</c>)
/// is the proof. The candidate comes from the kernel (<see cref="JobRunner"/> over <see cref="ModelHost"/> with
/// <see cref="OdcRuntime"/>, WS1) applied to the captured base, never to a stale file.
/// </summary>
public sealed class StudioSessionOdc(BridgeClientOdc bridge)
{
    public BridgeClientOdc Bridge { get; } = bridge;

    /// <summary><c>snapshot &lt;Module&gt;</c>: the bridge saves the open module to <c>snapshots\&lt;M&gt;-&lt;sha&gt;.oml</c>
    /// and answers path and sha; a refusal (pending merge, module not open) is an error because nothing was written.</summary>
    public OdcSnapshot Snapshot(string module)
    {
        var reply = Bridge.Call("snapshot", module);
        if (!BridgeClientOdc.Ok(reply)) throw new InvalidOperationException("snapshot " + module + " refused: " + reply.ToJsonString());
        return new OdcSnapshot(reply["module"]?.ToString() ?? module, reply["moduleKey"]?.ToString() ?? "", reply["path"]!.ToString(), reply["sha256"]!.ToString(),
            reply["capturedAt"]?.ToString() ?? DateTimeOffset.UtcNow.ToString("o"), reply["host"]?.ToString(), reply["developerId"]?.ToString(), reply["modified"]?.GetValue<bool>() ?? false, reply);
    }

    /// <summary>check-base, preview and merge, in that order, stopping at the first refusal and returning its JSON as is.
    /// The manifest is the one the bridge reads (<c>odc3-manifest/1</c>): see <see cref="WriteManifest"/>.</summary>
    public OdcMergeOutcome Merge(string manifestPath)
    {
        manifestPath = Path.GetFullPath(manifestPath);
        JsonObject? checkBase = null, preview = null, merge = null;
        foreach (var step in new[] { "check-base", "preview", "merge" })
        {
            var reply = Bridge.Call(step, manifestPath);
            switch (step) { case "check-base": checkBase = reply; break; case "preview": preview = reply; break; default: merge = reply; break; }
            if (!BridgeClientOdc.Ok(reply)) return new OdcMergeOutcome(false, step, reply, checkBase, preview, merge);
        }
        return new OdcMergeOutcome(true, null, null, checkBase, preview, merge);
    }

    /// <summary>The manifest the bridge commands read, in the builder's format (studio\shared\Manifest.cs): one module,
    /// one hash-checked base (the snapshot), one hash-checked candidate, one fresh evidence directory. Tenant and author
    /// come from the snapshot itself (host, developerId), as the builder takes them from the sidecar; the author must be
    /// the developer id the kernel stamped on the candidate, or the bridge's authorship gate refuses.</summary>
    public static string WriteManifest(OdcSnapshot snapshot, string candidatePath, string evidenceDir, string feature, IReadOnlyList<string> owners, IReadOnlyList<string> changes,
        string? author = null, string? tenant = null, int maxBaseAgeMinutes = 60)
    {
        candidatePath = Path.GetFullPath(candidatePath); evidenceDir = Path.GetFullPath(evidenceDir);
        var manifestPath = Path.Combine(Path.GetDirectoryName(evidenceDir)!, "manifest.json");
        var manifest = new JsonObject
        {
            ["schema"] = "odc3-manifest/1", ["feature"] = feature, ["module"] = snapshot.Module, ["moduleKey"] = snapshot.ModuleKey,
            ["tenant"] = tenant ?? snapshot.Host ?? throw new InvalidOperationException("The snapshot names no tenant host; pass tenant explicitly."),
            ["author"] = author ?? snapshot.DeveloperId ?? throw new InvalidOperationException("The snapshot names no developer id; pass author explicitly."),
            ["basePath"] = snapshot.Path, ["baseSha256"] = snapshot.Sha256, ["baseCapturedAt"] = snapshot.CapturedAt,
            ["candidatePath"] = candidatePath, ["candidateSha256"] = Hash(File.ReadAllBytes(candidatePath)),
            ["owners"] = new JsonArray(owners.Select(o => (JsonNode)o).ToArray()), ["evidenceDir"] = evidenceDir, ["maxBaseAgeMinutes"] = maxBaseAgeMinutes,
            ["changes"] = new JsonArray(changes.Select(c => (JsonNode)c).ToArray()), ["builderReceipt"] = null, ["smoke"] = false,
            ["publishAuthorization"] = null, ["expectedPublishedRevision"] = null, ["create"] = false, ["createAuthorization"] = null, ["producerPath"] = null, ["producerSha256"] = null
        };
        Directory.CreateDirectory(evidenceDir);
        File.WriteAllText(manifestPath, manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return manifestPath;
    }

    /// <summary>
    /// The whole cycle of one Anvil job on the open module, the ODC counterpart of <c>Delivery.Run</c>: snapshot the open
    /// module, apply the job headless over that snapshot (kernel <see cref="JobRunner"/> on <see cref="ModelHost"/>), write
    /// the manifest, and merge through the bridge. Stops at the first refusal, kernel or bridge, and returns everything
    /// that happened. <paramref name="evidenceDir"/> is fresh per attempt (the bridge allows one merge per evidence
    /// directory). The candidate's author is the developer id of the tenant's Studio session (ANVIL_DEVELOPER_ID is set to
    /// the snapshot's developer id when unset; a different value is refused before applying, because the bridge would
    /// refuse the merge for authorship).
    /// </summary>
    public JsonObject DeliverJob(string module, string jobPath, string evidenceDir, string feature, IReadOnlyList<string> owners, IReadOnlyList<string> changes, Action<string>? log = null)
    {
        var result = new JsonObject { ["module"] = module, ["job"] = Path.GetFullPath(jobPath), ["feature"] = feature, ["delivered"] = false };
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            StudioAssembliesOdc.Bind(); // the kernel's types reference the Studio assemblies, resolved by name from the installation
            log?.Invoke("snapshot " + module);
            var snapshot = Snapshot(module);
            result["snapshot"] = snapshot.Json.DeepClone();
            if (snapshot.DeveloperId != null)
            {
                if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANVIL_DEVELOPER_ID"))) Environment.SetEnvironmentVariable("ANVIL_DEVELOPER_ID", snapshot.DeveloperId);
                if (!string.Equals(OdcRuntime.DeveloperId, snapshot.DeveloperId, StringComparison.OrdinalIgnoreCase))
                    return Fail("apply", "the kernel would stamp '" + OdcRuntime.DeveloperId + "' but the tenant's Studio author is '" + snapshot.DeveloperId + "'; set ANVIL_DEVELOPER_ID to the Studio author before applying (the bridge's authorship gate compares them)");
            }
            var attemptDir = Path.GetFullPath(evidenceDir);
            Directory.CreateDirectory(attemptDir);
            var candidatePath = Path.Combine(attemptDir, snapshot.Module + "-candidate.oml");
            log?.Invoke("apply " + Path.GetFileName(jobPath) + " over " + Path.GetFileName(snapshot.Path));
            var host = new ModelHost(Path.Combine(attemptDir, "work"));
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, snapshot.Path, jobPath, candidatePath, log))!.AsObject();
            result["apply"] = applied;
            if (applied["isValid"]?.GetValue<bool>() != true || applied["accepted"]?.GetValue<bool>() != true)
                return Fail("apply", "job rejected by the kernel's validation contract (isValid=" + applied["isValid"] + ", accepted=" + applied["accepted"] + "); nothing was sent to the bridge: " + applied["policyMessages"]?.ToJsonString());
            var manifest = WriteManifest(snapshot, candidatePath, Path.Combine(attemptDir, "evidence"), feature, owners, changes);
            result["manifest"] = manifest;
            log?.Invoke("merge " + manifest);
            var merge = Merge(manifest);
            result["merge"] = merge.ToJson();
            if (!merge.Ok) return Fail(merge.FailedStep!, "bridge refused at " + merge.FailedStep + ": gate=" + merge.Refusal?["gate"] + " outcome=" + merge.Refusal?["outcome"]);
            result["delivered"] = true; result["strictlyEqual"] = merge.StrictlyEqual;
            return result;
        }
        catch (Exception ex) { return Fail("exception", Errors.Text(ex)); }
        finally { result["elapsedMs"] = clock.ElapsedMilliseconds; }

        JsonObject Fail(string stage, string message) { result["stage"] = stage; result["error"] = message; return result; }
    }

    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
}
