using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core.Delivery;

namespace Anvil.Core;

/// <summary>Original delivery selected by the controller, not a caller-authored ABI or current source.</summary>
public sealed record NativeCSharpProducerSource(string ProducerBinding, CSharpProducerExport Export);
/// <summary>A reader-created catalog whose source codecs have passed native model inspection.
/// Deserializing a catalog alone does not recreate this evidence.</summary>
public sealed class NativeCSharpSourceReadResult
{
    private readonly JsonArray sourceProofs;
    public NativeDependencyCatalog Catalog { get; }
    public JsonArray SourceProofs => sourceProofs.DeepClone().AsArray();
    internal NativeCSharpSourceReadResult(NativeDependencyCatalog catalog, JsonArray sourceProofs)
    {
        // Freeze the portable representation too; caller-visible metadata never aliases
        // mutable producer/read buffers and retains the same catalog fingerprint on disk.
        Catalog = NativeDependencyCatalog.FromJson(catalog.ToJson());
        this.sourceProofs = sourceProofs.DeepClone().AsArray();
    }
}

/// <summary>Attaches original source codecs only after the frozen native producer satisfies the
/// originally compiled contract. Public signature hashes alone never authorize an ABI. This reader performs
/// no acquisition, publication, mutation, source execution or default-controller activation.</summary>
public static class NativeCSharpSourceReader
{
    public static NativeCSharpSourceReadResult Read(ModelHost host,
        IReadOnlyList<NativeDependencyRequirement> requirements, IReadOnlyList<NativeDependencyProducer> producers,
        IReadOnlyDictionary<string, string> signaturePaths, IReadOnlyList<NativeCSharpProducerSource> sources)
    {
        ArgumentNullException.ThrowIfNull(host); ArgumentNullException.ThrowIfNull(sources);
        var frozenSources = sources.ToArray();
        if (frozenSources.Select(source => source.ProducerBinding).Distinct(StringComparer.Ordinal).Count() != frozenSources.Length)
            throw new ArgumentException("Duplicate C# producer source binding");
        var catalog = NativeDependencyReader.Read(requirements, producers, signaturePaths);
        var bindings = catalog.Bindings.ToArray(); var proofs = new JsonArray();
        foreach (var source in frozenSources)
        {
            var producer = catalog.Producers.SingleOrDefault(item => item.Binding == source.ProducerBinding)
                ?? throw new ArgumentException("Unknown C# producer source binding: " + source.ProducerBinding);
            var path = signaturePaths[producer.Binding];
            var bytes = File.ReadAllBytes(path); RequireHash(bytes, producer);
            // ABI, model contract and runtime are the exact original compiler decision.
            // Importing with a newer compiler never runs compilation again.
            var compiled = source.Export.Read(producer.Environment, producer.ProducerKey);

            JsonObject proof;
            var module = host.Load(bytes);
            try
            {
                var messages = ModelHost.Messages(module);
                if (messages.Any(message => message.IsError))
                    throw new InvalidOperationException("C# producer model has Verify errors: " + producer.Binding);
                proof = new ModelSession(module).CheckSourceAbiModel(compiled, source.Export.Runtime);
            }
            finally { ModelHost.Release(module); }
            if (proof["accepted"]?.GetValue<bool>() != true)
                throw new InvalidOperationException("C# producer source differs from the frozen native model: " + producer.Binding
                    + "; " + proof["differences"]?.ToJsonString());

            var abis = (compiled.SourceAbis ?? []).OfType<JsonObject>().ToDictionary(
                entry => (entry["kind"]!.ToString(), entry["native"]!.ToString()));
            var actions = (compiled.Specification["logic"]?["actions"]?.AsArray().OfType<JsonObject>() ?? [])
                .ToDictionary(action => action["name"]!.ToString(), StringComparer.Ordinal);
            var attached = new JsonArray();
            for (var index = 0; index < bindings.Length; index++)
            {
                var binding = bindings[index];
                if (binding.ProducerBinding != producer.Binding) continue;
                var kind = binding.Requirement.Kind switch {
                    NativeDependencyKind.ServerAction => "server", NativeDependencyKind.ServiceAction => "service", _ => null };
                if (kind == null || !abis.TryGetValue((kind, binding.Requirement.OriginalElementPath), out var entry)) continue;
                var action = actions[entry["native"]!.ToString()];
                RequireOrder(action, "inputs", binding.OrderedInputs, binding.NativeReference);
                RequireOrder(action, "outputs", binding.OrderedOutputs, binding.NativeReference);
                var payload = entry["abi"]!.AsObject();
                bindings[index] = binding with { SourceAbi = new NativeSourceAbi(payload["id"]!.ToString(), payload["version"]!.GetValue<int>(), payload) };
                attached.Add(new JsonObject { ["sourceSymbol"] = binding.Requirement.SourceSymbol,
                    ["nativeReference"] = binding.NativeReference, ["source"] = entry["source"]!.DeepClone() });
            }
            proofs.Add(new JsonObject { ["producerBinding"] = producer.Binding, ["producerKey"] = producer.ProducerKey,
                ["snapshotSha256"] = producer.SignatureFileSha256, ["signatureHash"] = producer.SignatureHash,
                ["publishedVersion"] = producer.PublishedVersion, ["sourceHash"] = compiled.SourceHash,
                ["deliveryTaskId"] = source.Export.TaskId, ["deliveryReceiptSha256"] = source.Export.ReceiptSha256,
                ["deliveredSnapshotSha256"] = source.Export.DeliveredSnapshotSha256,
                ["compilationFingerprint"] = source.Export.Compilation.Fingerprint,
                ["compiledContractSha256"] = DurableJson.Hash(compiled.Specification.ToJsonString()),
                ["sourceAbisSha256"] = DurableJson.Hash((compiled.SourceAbis ?? []).ToJsonString()),
                ["attached"] = attached, ["modelProof"] = proof,
                ["scope"] = "Frozen acquired OML compared with the original delivered compiler contract/ABI/runtime, without recompilation. Environment/version provenance is supplied by the controller; published behavior is a separate proof." });
        }
        // No partial catalog escapes if another producer or a concurrently changed file fails.
        foreach (var producer in catalog.Producers) RequireHash(File.ReadAllBytes(signaturePaths[producer.Binding]), producer);
        foreach (var source in frozenSources)
        {
            var producer = catalog.Producers.Single(item => item.Binding == source.ProducerBinding);
            source.Export.Validate(producer.Environment, producer.ProducerKey);
        }
        return new(new NativeDependencyCatalog(catalog.Producers, bindings), proofs);
    }

    private static void RequireHash(byte[] bytes, NativeDependencyProducer producer)
    {
        if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(producer.SignatureFileSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Frozen C# producer OML changed: " + producer.Binding);
    }
    private static void RequireOrder(JsonObject action, string key, IReadOnlyList<NativeParameter> parameters, string reference)
    {
        var names = (action[key]?.AsArray() ?? []).Select(parameter => parameter!["name"]!.ToString());
        if (!names.SequenceEqual(parameters.Select(parameter => parameter.Name), StringComparer.Ordinal))
            throw new InvalidOperationException("C# producer ordered " + key + " differ from frozen native signature: " + reference);
    }
}

public sealed partial class ModelSession
{
    internal JsonObject CheckSourceAbiModel(CompilationResult compiled, FrozenFrameworkDependencies? runtime)
    {
        var result = CheckModuleSpecification(compiled.Specification);
        if (runtime != null)
        {
            var dependencies = CheckFrameworkDependencies(runtime);
            result["runtimeDependencies"] = dependencies;
            foreach (var key in new[] { "assertions", "differences" })
                foreach (var item in dependencies[key]!.AsArray()) result[key]!.AsArray().Add(item!.DeepClone());
            result["count"] = result["assertions"]!.AsArray().Count;
            result["accepted"] = result["differences"]!.AsArray().Count == 0;
        }
        return result;
    }
}
