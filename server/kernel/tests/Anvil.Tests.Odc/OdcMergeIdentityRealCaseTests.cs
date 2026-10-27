using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>
/// The false MERGE_CONTENT_PREVIEW_REFUSED of 2026-10-22 (ODC): a job built a mobile module whose screens hold block instances
/// of a referenced producer, and the disposable native merge regenerated the ObjectKey of each placeholder content those
/// instances hold. The proof before ssam-merge-identity/2 reported 443 differences across 64 elements ($parent, ordered
/// Widgets, $kind, $parentKind, CustomStyle, Name) on the same semantic paths. The real case is run as the ODC delivery runs
/// it (anvil-odc content-proof: MergeContentProof.Check(host, candidate, preview)), and must be accepted.
/// </summary>
public class OdcMergeIdentityRealCaseTests(ITestOutputHelper output)
{
    /// <summary>expected = the module the job built (kernel-candidate.oml), actual = the native merge preview
    /// (merge-content-preview.oml). The files are a customer module: they live only outside the repository, in the folder
    /// SSAM_MERGE_REAL_CASE_ODC names. Without it the test does nothing.</summary>
    [Fact]
    public void TheCapturedNativeMergeOfPlaceholderContentIsAccepted()
    {
        var folder = Environment.GetEnvironmentVariable("SSAM_MERGE_REAL_CASE_ODC");
        if (string.IsNullOrEmpty(folder) || !File.Exists(Path.Combine(folder, "kernel-candidate.oml")) || !File.Exists(Path.Combine(folder, "merge-content-preview.oml")))
        {
            output.WriteLine("inconclusive: SSAM_MERGE_REAL_CASE_ODC does not name a folder with kernel-candidate.oml and merge-content-preview.oml");
            return;
        }
        try { StudioAssembliesOdc.Bind(); } catch (Exception error) { output.WriteLine("inconclusive: no ODC Studio assemblies: " + error.Message); return; }
        RunRealCase(folder);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void RunRealCase(string folder)
    {
        var work = Path.Combine(Path.GetTempPath(), "odc-merge-real-case-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(work);
        try
        {
            var proof = MergeContentProof.Check(new ModelHost(Path.Combine(work, "model")),
                Path.Combine(folder, "kernel-candidate.oml"), Path.Combine(folder, "merge-content-preview.oml"));
            // The whole proof, when asked, goes to a file outside the repository (it names the customer's elements).
            if (Environment.GetEnvironmentVariable("SSAM_MERGE_REAL_CASE_ODC_OUT") is { Length: > 0 } dump) File.WriteAllText(dump, proof.ToJsonString());
            var differences = proof["differences"]!.AsArray().OfType<JsonObject>().ToList();
            output.WriteLine($"identity={proof["coverage"]?["identity"]} accepted={proof["accepted"]} checked={proof["checked"]} differences={differences.Count}");
            var elements = differences.Select(d => d["element"]?.ToString()).Distinct().Count();
            output.WriteLine($"elements={elements}");
            foreach (var group in differences.GroupBy(d => $"{d["kind"]} | parent {d["parentKind"]} | {d["property"]} | missing={d["missing"]} unexpected={d["unexpected"]}")
                         .OrderByDescending(g => g.Count()))
                output.WriteLine($"{group.Count(),5}  {group.Key}");
            Assert.True(differences.Count == 0, differences.Count + " difference(s) across " + elements + " element(s)");
            Assert.True(proof["accepted"]!.GetValue<bool>());
        }
        finally { try { Directory.Delete(work, true); } catch { } }
    }
}
