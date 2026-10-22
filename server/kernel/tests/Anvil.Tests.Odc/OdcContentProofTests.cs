using System.Text.Json;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The content proof the facade reconciles an uncertain merge with (anvil-odc content-proof, platforms/odc/facade/
/// merge-reconcile.mjs; friction ef7de23f of 2026-10-21): over the ODC Studio's own model, a capture equal to the candidate
/// is accepted with the sha256 of both inputs, and a capture that lacks the candidate's change is refused with its
/// differences, never accepted.
/// </summary>
public class OdcContentProofTests
{
    private static string Root { get { var d = Path.GetDirectoryName(typeof(OdcContentProofTests).Assembly.Location); while (d != null && !File.Exists(Path.Combine(d, "MANIFESTO.md"))) d = Path.GetDirectoryName(d); return d!; } }
    private const string Job = """
    {"ops":[{"op":"spec","data":{"entities":[{"name":"CarrierLimit","public":true,"attributes":[{"name":"Name","type":"Text","length":50},{"name":"Maximum","type":"Integer"}]}]}}]}
    """;

    [Fact]
    public void AnEqualCaptureIsAcceptedAndAMissingChangeIsRefused()
    {
        if (!StudioAvailable()) return;
        Run();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "content-proof-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var basePath = Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml");
        var jobPath = Path.Combine(dir, "carrier-limit.json"); File.WriteAllText(jobPath, Job);
        var candidatePath = Path.Combine(dir, "candidate.oml");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, candidatePath))!;
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied["policyMessages"]?.ToJsonString());
        // The capture of a module that holds the candidate: another file with the same bytes.
        var capturePath = Path.Combine(dir, "capture.oml"); File.Copy(candidatePath, capturePath);

        var equal = MergeContentProof.Check(host, candidatePath, capturePath);
        Assert.Equal("ssam-merge-content-proof/1", equal["schema"]!.GetValue<string>());
        Assert.True(equal["accepted"]!.GetValue<bool>(), equal["differences"]!.ToJsonString());
        Assert.Empty(equal["differences"]!.AsArray());
        Assert.True(equal["checked"]!.GetValue<int>() > 0);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(candidatePath))).ToLowerInvariant();
        Assert.Equal(sha, equal["inputs"]!["expected"]!["sha256"]!.GetValue<string>());
        Assert.Equal(sha, equal["inputs"]!["actual"]!["sha256"]!.GetValue<string>());

        // The module without the change (the base): refused, with its differences listed.
        var missing = MergeContentProof.Check(host, candidatePath, basePath);
        Assert.False(missing["accepted"]!.GetValue<bool>());
        Assert.NotEmpty(missing["differences"]!.AsArray());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(); return true; } catch { return false; }
    }
}
