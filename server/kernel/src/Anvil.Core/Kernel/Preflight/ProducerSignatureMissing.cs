using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// A25 of the atritos 2 package: the producer elements a job references that the producer's signature does not show, all
/// in one refusal (PRODUCER_SIGNATURE_MISSING), one problem per element with its cause (I6) and the exact fix:
/// <list type="bullet">
/// <item>private: the published producer has it only as a hidden dependency (it is not Public);</item>
/// <item>unpublished: the capture named it, and the producer's published signature, refreshed natively, does not keep it;</item>
/// <item>theme: a theme, which a signature capture cannot import (it needs the producer OML binding);</item>
/// <item>absent: no element of that kind and name in the producer's signature;</item>
/// <item>foreign (atritos 3, K1): the element uses a type of another producer whose signature is not linked in the execution
/// (the problem names it in owner); the delivery captures that owner by itself, nothing is published.</item>
/// </list>
/// The capture runs in the producer-signatures stage of the delivery, and the import in the disposable copy, both before
/// any write; the delivery carries the code and the problems (Delivery.cs).
/// </summary>
public static class ProducerSignatureMissing
{
    public const string Code = "PRODUCER_SIGNATURE_MISSING";

    public static JsonObject Problem(string element, string producer, string cause, string message, string fix)
    {
        var problem = JobPreflight.PublicProblem(JobPreflight.Problem(null, null, Code, "error", message, fix));
        problem["cause"] = cause; problem["element"] = element; problem["producer"] = producer;
        return problem;
    }

    public static KernelRefusalException Refusal(string producer, IReadOnlyList<JsonObject> problems)
    {
        var lines = problems.Select(p => $"{p["element"]} ({p["cause"]}): {p["message"]} Fix: {p["fix"]}");
        // Cause foreign (K1, atritos 3): the producer has the element; another producer it uses is missing from the execution.
        var summary = problems.Count > 0 && problems.All(p => p["cause"]?.ToString() == "foreign")
            ? $"{problems.Count} element(s) of {producer} use producers that are not linked in this execution, all listed: "
            : $"{problems.Count} element(s) of {producer} are not in its published signature, all listed: ";
        return new KernelRefusalException(Code, $"{Code}: " + summary
            + string.Join(" | ", lines), new JsonArray(problems.Select(p => (JsonNode)p.DeepClone()).ToArray()));
    }
}
