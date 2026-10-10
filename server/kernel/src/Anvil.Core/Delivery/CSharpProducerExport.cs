using System.Text.Json.Nodes;
using Anvil.CSharp;

namespace Anvil.Core.Delivery;

/// <summary>Original compiler evidence selected from a successful controller-owned delivery.
/// A receipt is local evidence, not a signature or an attestation of publication. The controller
/// still acquires the published producer; the native reader proves its current model separately.</summary>
public sealed class CSharpProducerExport
{
    private readonly string receiptPath;
    private readonly JsonArray evidenceFiles;
    public string ReceiptSha256 { get; }
    public string TaskId { get; }
    public string DeliveredSnapshotSha256 { get; }
    public FrozenCSharpCompilation Compilation { get; }
    public FrozenFrameworkDependencies? Runtime { get; }

    private CSharpProducerExport(string path, string hash, string taskId, string snapshotHash,
        FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? runtime, JsonArray files)
    {
        receiptPath = path; ReceiptSha256 = hash; TaskId = taskId;
        DeliveredSnapshotSha256 = snapshotHash; Compilation = compilation; Runtime = runtime;
        evidenceFiles = files.DeepClone().AsArray();
    }

    public static CSharpProducerExport FromDelivery(string resultPath)
    {
        var path = Path.GetFullPath(resultPath);
        var originalHash = DeliveryReceipt.Hash(path);
        RequireReceipt(path);
        var result = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var files = new JsonArray();
        var taskId = result["taskId"]?.ToString();
        var directory = Path.GetDirectoryName(path)!;
        if (taskId == null || !Guid.TryParseExact(taskId, "N", out _) ||
            Path.GetFileName(directory) != taskId || result["work"]?.ToString() != directory ||
            result["stage"]?.ToString() != "complete" || result["writeState"]?.ToString() is not ("applied" or "unchanged"))
            throw new InvalidOperationException("C# export requires a completed controller delivery");
        if (result["dataProof"]?["accepted"]?.GetValue<bool>() != true ||
            result["requirementsBeforeMerge"]?["accepted"]?.GetValue<bool>() != true ||
            result["apply"]?["accepted"]?.GetValue<bool>() != true || result["apply"]?["isValid"]?.GetValue<bool>() != true ||
            result["newErrors"]?.GetValue<int>() != 0 || result["failures"] is not JsonArray { Count: 0 })
            throw new InvalidOperationException("C# export has no accepted original model proof");
        var exported = result["csharpExports"]?.AsObject()
            ?? throw new InvalidOperationException("This delivery has no frozen C# exports; source recompilation cannot invent original evidence");
        var decision = result["csharpCompilation"]?.AsObject();
        var compilationPath = Path.Combine(directory, "csharp-compilation.json");
        if (decision?["decision"]?.ToString() != "frozen" || decision["path"]?.ToString() != compilationPath ||
            decision["fingerprint"] == null || !JsonNode.DeepEquals(exported["compilation"], decision))
            throw new InvalidOperationException("C# export differs from the original compilation decision");
        Record(result["sources"], compilationPath);
        var frozen = FrozenCSharpCompilation.Read(compilationPath, decision["fingerprint"]!.ToString());
        if (decision["sourceHash"]?.ToString() != frozen.SourceHash || decision["profile"]?.ToString() != frozen.Profile ||
            exported["sourceHash"]?.ToString() != frozen.SourceHash ||
            !JsonNode.DeepEquals(exported["sourceAbis"], frozen.Compilation.SourceAbis))
            throw new InvalidOperationException("C# exported source/ABI differs from the original compilation");
        var specification = result["request"]?["Specification"];
        if (specification == null || !JsonNode.DeepEquals(result["specification"], specification) ||
            result["contractHash"]?.ToString() != DurableJson.Hash(specification.ToJsonString()))
            throw new InvalidOperationException("C# export differs from the original request contract");
        var source = specification["csharpSource"]
            ?? throw new InvalidOperationException("C# export has no original authored request");
        if (!JsonNode.DeepEquals(SourceBundle.Canonical(source), frozen.Source))
            throw new InvalidOperationException("C# export belongs to another source revision");
        var snapshot = result["deliveredSnapshot"];
        if (snapshot?["key"]?.ToString() != result["moduleKey"]?.ToString() ||
            !string.Equals(snapshot?["environment"]?.ToString(), result["environment"]?.ToString(), StringComparison.OrdinalIgnoreCase) ||
            !JsonNode.DeepEquals(exported["snapshot"], snapshot) || snapshot?["path"] == null)
            throw new InvalidOperationException("C# export has no matching delivered snapshot");
        var snapshotPath = snapshot["path"]!.ToString();
        var snapshotHash = Record(result["artifacts"], snapshotPath);
        if (snapshot["sha256"] != null && !snapshot["sha256"]!.ToString().Equals(snapshotHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("C# delivered snapshot hash differs from its artifact");
        var runtimeDecision = result["runtimeDependencies"];
        if (runtimeDecision?["sourceHash"]?.ToString() != frozen.SourceHash)
            throw new InvalidOperationException("C# export has no original runtime decision");
        FrozenFrameworkDependencies? runtime = null;
        if (runtimeDecision["decision"]?.ToString() == "none")
        {
            if (runtimeDecision["requirementsHash"]?.ToString() != DurableJson.Hash("[]") || frozen.RuntimeFingerprint != null)
                throw new InvalidOperationException("C# export runtime choice changed");
        }
        else
        {
            var runtimePath = Path.Combine(directory, "runtime-lock.json");
            if (runtimeDecision["decision"]?.ToString() != "frozen" || runtimeDecision["path"]?.ToString() != runtimePath ||
                runtimeDecision["fingerprint"]?.ToString() != frozen.RuntimeFingerprint || frozen.RuntimeFingerprint == null)
                throw new InvalidOperationException("C# export requires its original frozen runtime decision");
            Record(result["sources"], runtimePath);
            runtime = FrozenFrameworkDependencies.Read(runtimePath, frozen.RuntimeFingerprint);
            if (runtimeDecision["requirementsHash"]?.ToString() != runtime.RequirementsHash)
                throw new InvalidOperationException("C# exported runtime requirements changed");
            foreach (var producer in runtime.Producers) Record(result["sources"], producer.Path);
            if (runtime.Package.ArtifactPath != null) Record(result["sources"], runtime.Package.ArtifactPath);
        }
        _ = frozen.ReadBound(result["environment"]?.ToString() ?? "", result["moduleKey"]?.ToString() ?? "", runtime);
        var evidence = new CSharpProducerExport(path, originalHash, taskId, snapshotHash, frozen, runtime, files);
        evidence.Validate(frozen.Environment, frozen.ModuleKey);
        return evidence;

        string Record(JsonNode? records, string file)
        {
            var hash = RequireRecorded(records, file);
            files.Add(new JsonObject { ["path"] = file, ["sha256"] = hash }); return hash;
        }
    }

    internal CompilationResult Read(string environment, string moduleKey)
    {
        Validate(environment, moduleKey);
        return Compilation.ReadBound(environment, moduleKey, Runtime);
    }

    public void Validate(string environment, string moduleKey)
    {
        if (DeliveryReceipt.Hash(receiptPath) != ReceiptSha256)
            throw new InvalidOperationException("Original C# export receipt changed");
        RequireReceipt(receiptPath);
        if (DeliveryReceipt.Changed(evidenceFiles).Count != 0)
            throw new InvalidOperationException("Original C# export evidence files changed");
        _ = Compilation.ReadBound(environment, moduleKey, Runtime);
        if (DeliveryReceipt.Hash(receiptPath) != ReceiptSha256)
            throw new InvalidOperationException("Original C# export receipt changed during inspection");
    }

    private static void RequireReceipt(string path)
    {
        var result = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var checkpoint = Path.Combine(Path.GetDirectoryName(path)!, "task.json");
        if (result["delivered"]?.GetValue<bool>() != true || !File.Exists(checkpoint) ||
            !JsonNode.DeepEquals(result, DurableJson.Read(checkpoint)))
            throw new InvalidOperationException("Original C# delivery receipt differs from its successful controller checkpoint");
        // Unlike check-delivery, an import may outlive the author's working file. Its
        // source is the original request+compilation payload, and every file consumed as
        // evidence is checked separately against the original receipt hashes.
    }
    private static string RequireRecorded(JsonNode? records, string path)
    {
        var entries = records is JsonArray array ? array.OfType<JsonObject>().Where(item => item["path"]?.ToString() == path).ToArray() : [];
        if (entries.Length != 1 || entries[0]["sha256"]?.ToString() != DeliveryReceipt.Hash(path))
            throw new InvalidOperationException("C# export artifact is absent from the original receipt: " + path);
        return entries[0]["sha256"]!.ToString();
    }
}
