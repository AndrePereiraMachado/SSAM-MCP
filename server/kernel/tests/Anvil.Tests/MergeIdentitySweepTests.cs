using System.Runtime.CompilerServices;
using System.Text.Json;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The fixture sweep of the content proof's identity rule over every O11 job of the repository (MergeIdentitySweep): each job
/// built twice is accepted, the native merge of each candidate over its base is accepted, and a change of one property of
/// each element kind is refused. Long (every job twice): it runs when SSAM_MERGE_IDENTITY_SWEEP is "all" or a comma list of
/// job names (SSAM_MERGE_IDENTITY_MUTATIONS: elements changed per kind, default 2); the counts go to SSAM_MERGE_IDENTITY_OUT (default .local/merge-identity-sweep/o11-sweep.json).
/// </summary>
public class MergeIdentitySweepTests
{
    [Fact]
    public void EachJobBuiltTwiceIsTheSameContentAndEachChangedPropertyRefuses()
    {
        var mode = Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_SWEEP");
        if (string.IsNullOrEmpty(mode)) return;
        StudioAssemblies.Bind();
        Run(mode);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(string mode)
    {
        var root = MergeIdentitySweep.Root;
        var output = Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_OUT") is { Length: > 0 } o ? o : Path.Combine(root, ".local", "merge-identity-sweep");
        Directory.CreateDirectory(output);
        var summary = MergeIdentitySweep.Run(Path.Combine(root, "tests", "jobs"), Path.Combine(output, "o11-" + Guid.NewGuid().ToString("N")[..8]),
            (host, basis, candidate, merged) => { var result = MergeProbe.ThreeWay(host, basis, candidate, merged); return File.Exists(merged) ? null : "no merged module (valid=" + result.LocalIsValid + ")"; },
            mode == "all" ? null : mode, mutationsPerKind: int.TryParse(Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_MUTATIONS"), out var perKind) ? perKind : 2);
        File.WriteAllText(Path.Combine(output, "o11-sweep.json"), summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True((summary["refused:identity"]?.GetValue<int>() ?? 0) == 0, "two builds of the same content refused: see " + Path.Combine(output, "o11-sweep.json"));
        Assert.True((summary["accepted:contentDiffers"]?.GetValue<int>() ?? 0) == 0, "two builds that differ were accepted: see " + Path.Combine(output, "o11-sweep.json"));
        Assert.True((summary["mutation:MISS"]?.GetValue<int>() ?? 0) == 0, "a changed property was accepted: see " + Path.Combine(output, "o11-sweep.json"));
    }
}
