using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Replay of the content proof over preserved delivery evidence (lab/NN-*/kernel-candidate.oml against its
/// merge-content-preview.oml), read only. Runs only with SSAM_PROOF_LABS (lab folders separated by ';') and writes
/// SSAM_PROOF_LABS_OUT (a JSON summary): the incidents' files are not in the repository, so the suite returns early.
/// For each pair it lists the differences by property and, for each element that exists on one side only, whether its key
/// is in the delivery's base capture (a node the merge kept from the base with the candidate's content, or a fresh key).
/// </summary>
public class OdcContentProofLabReplayTests
{
    [Fact]
    public void ReplaysPreservedPairsWhenAsked()
    {
        if (Environment.GetEnvironmentVariable("SSAM_PROOF_LABS") is not { Length: > 0 } labs) return;
        StudioAssembliesOdc.Bind();
        Run(labs.Split(';', StringSplitOptions.RemoveEmptyEntries), Environment.GetEnvironmentVariable("SSAM_PROOF_LABS_OUT"));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(string[] labs, string? output)
    {
        var work = Path.Combine(Path.GetTempPath(), "ssam-proof-lab", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var report = new JsonArray();
        foreach (var lab in labs)
        {
            var candidate = Path.Combine(lab, "kernel-candidate.oml"); var preview = Path.Combine(lab, "merge-content-preview.oml");
            if (!File.Exists(candidate) || !File.Exists(preview)) { report.Add(new JsonObject { ["lab"] = lab, ["skipped"] = "pair missing" }); continue; }
            var proof = MergeContentProof.Check(host, candidate, preview);
            // SSAM_PROOF_LABS_DUMP: a folder for the whole proof of each refused pair.
            if (Environment.GetEnvironmentVariable("SSAM_PROOF_LABS_DUMP") is { Length: > 0 } dump && proof["accepted"]?.GetValue<bool>() != true)
                File.WriteAllText(Path.Combine(dump, Path.GetFileName(lab) + ".json"), proof.ToJsonString());
            var differences = proof["differences"]!.AsArray().OfType<JsonObject>().ToArray();
            var baseKeys = BaseKeys(host, lab);
            JsonArray Roots(Func<JsonObject, bool> side) => new(differences.Where(side).Select(d => d["address"]!.ToString().Split('/')[0]).Distinct()
                .Select(k => (JsonNode)new JsonObject { ["key"] = k, ["element"] = differences.First(d => d["address"]!.ToString().Split('/')[0] == k)["element"]?.ToString(),
                    ["inBase"] = baseKeys == null ? null : baseKeys.Contains(k) }).ToArray());
            report.Add(new JsonObject {
                ["lab"] = Path.GetFileName(lab), ["accepted"] = proof["accepted"]!.DeepClone(), ["checked"] = proof["checked"]!.DeepClone(),
                ["differences"] = differences.Length, ["summary"] = proof["summary"]?.DeepClone(),
                ["byProperty"] = new JsonObject(differences.GroupBy(d => d["property"]!.ToString()).OrderByDescending(g => g.Count())
                    .Select(g => KeyValuePair.Create(g.Key, (JsonNode?)g.Count()))),
                ["missingRoots"] = Roots(d => d["missing"]?.GetValue<bool>() == true),
                ["unexpectedRoots"] = Roots(d => d["unexpected"]?.GetValue<bool>() == true),
                ["changed"] = new JsonArray(differences.Where(d => d["missing"]?.GetValue<bool>() != true && d["unexpected"]?.GetValue<bool>() != true).Take(40)
                    .Select(d => (JsonNode)new JsonObject { ["element"] = d["element"]?.ToString(), ["address"] = d["address"]?.ToString(), ["property"] = d["property"]?.ToString(),
                        ["expected"] = d["expectedValue"]?.ToString() ?? d["expected"]?.ToString(), ["actual"] = d["actualValue"]?.ToString() ?? d["actual"]?.ToString() }).ToArray())
            });
        }
        var text = report.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        if (output is { Length: > 0 }) File.WriteAllText(output, text);
    }

    private static HashSet<string>? BaseKeys(ModelHost host, string lab)
    {
        var result = Path.Combine(lab, "deliver-result.json");
        if (!File.Exists(result)) return null;
        var basePath = JsonNode.Parse(File.ReadAllText(result))?["snapshot"]?["path"]?.ToString();
        if (basePath == null || !File.Exists(basePath)) return null;
        var model = host.Load(File.ReadAllBytes(basePath));
        try
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            var pending = new Stack<IObjectSignature>(); pending.Push((IObjectSignature)model);
            while (pending.TryPop(out var node)) { keys.Add(node.ObjectKey.ToString()); foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child); }
            return keys;
        }
        finally { ModelHost.Release(model); }
    }
}
