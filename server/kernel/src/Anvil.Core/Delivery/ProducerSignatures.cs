using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>Read-only producer signature authority of a delivery (SS11: StudioProducerAuthority over the Studio's own
/// login). Capture writes an attested .avsig of the producer's current server signature; Attest re-observes the
/// identity an attested envelope claims (environment, key, published version or advertised hash) and throws when it
/// changed. Neither writes to the environment.</summary>
public interface IProducerSignatureAuthority
{
    JsonObject Capture(string producer, IReadOnlyList<string> elements, string destination, string environment);
    JsonObject Attest(string avsigPath, string environment);
    /// <summary>K1-b (atritos 3): captures the producer that owns a foreign dependency, named by its key; elements may be
    /// "@originalKey" (typed by the payload). An authority without it cannot capture owners.</summary>
    JsonObject CaptureByKey(string producerKey, IReadOnlyList<string> elements, string destination, string environment)
        => throw new NotSupportedException("This producer authority captures producers by name only; the owner " + producerKey + " is not captured");
    /// <summary>F5: re-observes several envelopes at once, each with its own outcome (the observation, or the exception
    /// Attest would have thrown), in the order given. The Studio authority does it in one read-only lease with one read of
    /// each catalog; this default attests one by one.</summary>
    IReadOnlyList<ProducerAttestation> AttestAll(IReadOnlyList<string> avsigPaths, string environment)
    {
        var outcomes = new List<ProducerAttestation>();
        foreach (var path in avsigPaths)
        {
            try { outcomes.Add(new ProducerAttestation(path, Attest(path, environment), null)); }
            catch (Exception ex) when (ex is not OutOfMemoryException) { outcomes.Add(new ProducerAttestation(path, null, ex)); }
        }
        return outcomes;
    }
}

/// <summary>The outcome of one re-observation: Observed ({producer, environment, guard, versionId, advertisedSignatureHash,
/// attested}) or the Error that refuses it.</summary>
public sealed record ProducerAttestation(string Path, JsonObject? Observed, Exception? Error);

/// <summary>Pure helpers over the job graph and the recorded producer envelopes (no model, no server).</summary>
public static class ProducerSignatures
{
    /// <summary>Tipo:Nome of every `reference` op that names this producer binding in the job and its composite parts.</summary>
    public static IReadOnlyList<string> ReferencedElements(string jobPath, string producer)
    {
        var elements = new List<string>(); var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        Visit(Path.GetFullPath(jobPath));
        return elements.Distinct(StringComparer.Ordinal).ToArray();
        void Visit(string file)
        {
            if (!visited.Add(file) || !file.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return;
            var node = JsonNode.Parse(File.ReadAllText(file))!;
            var dir = Path.GetDirectoryName(file)!;
            if (node is JsonObject obj)
                foreach (var part in obj["jobs"]?.AsArray() ?? new JsonArray()) Visit(JobRunner.ResolveJobFile(part!.ToString(), dir));
            foreach (var op in (node is JsonArray array ? array : node["ops"]?.AsArray()) ?? new JsonArray())
                if (op?["op"]?.ToString() == "reference" && string.Equals(op["producer"]?.ToString(), producer, StringComparison.OrdinalIgnoreCase))
                    elements.AddRange(op["elements"]?.AsArray().Select(e => e!.GetValue<string>()) ?? []);
        }
    }

    /// <summary>"Binding" or "Binding=Producer" (the environment's producer name, e.g. System=(System)).</summary>
    public static (string Binding, string Producer) ParseCapture(string entry)
    {
        var parts = (entry ?? "").Split('=', 2);
        var binding = parts[0].Trim(); var producer = parts.Length == 2 ? parts[1].Trim() : binding;
        if (!JobSources.IsBindingName(binding) || producer.Length == 0)
            throw new ArgumentException($"invalid --capture-producer '{entry}': use --capture-producer Name or Name=<producer>, e.g. System=(System)");
        return (binding, producer);
    }

    // Keep the model adapter out of the pure delivery path's JIT dependencies.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    public static bool RequiresAttestation(string path)
        => Path.GetExtension(path).Equals(".avsig", StringComparison.OrdinalIgnoreCase) && NativeReferenceSnapshot.Read(path).RequiresServerAttestation;
}
