using System.Runtime.CompilerServices;
using System.Text.Json;
using Anvil.Core;
using OutSystems.Model;
using OutSystems.Model.Merge;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// The fixture sweep of the content proof's identity rule over every ODC job of the repository (MergeIdentitySweep): each job
/// built twice is accepted, the Studio's merge (MatchTree, as CompareAndMerge) of each candidate over its base is accepted, and
/// a change of one property of each element kind is refused. Long: it runs when SSAM_MERGE_IDENTITY_SWEEP is "all" or a comma
/// list of job names (SSAM_MERGE_IDENTITY_MUTATIONS: elements changed per kind, default 2); the counts go to SSAM_MERGE_IDENTITY_OUT (default .local/merge-identity-sweep/odc-sweep.json).
/// </summary>
public class OdcMergeIdentitySweepTests
{
    [Fact]
    public void EachJobBuiltTwiceIsTheSameContentAndEachChangedPropertyRefuses()
    {
        var mode = Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_SWEEP");
        if (string.IsNullOrEmpty(mode)) return;
        StudioAssembliesOdc.Bind();
        Run(mode);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(string mode)
    {
        var root = MergeIdentitySweep.Root;
        var output = Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_OUT") is { Length: > 0 } o ? o : Path.Combine(root, ".local", "merge-identity-sweep");
        Directory.CreateDirectory(output);
        var summary = MergeIdentitySweep.Run(Path.Combine(root, "tests", "jobs-odc"), Path.Combine(output, "odc-" + Guid.NewGuid().ToString("N")[..8]), Merge,
            mode == "all" ? null : mode, mutationsPerKind: int.TryParse(Environment.GetEnvironmentVariable("SSAM_MERGE_IDENTITY_MUTATIONS"), out var perKind) ? perKind : 2);
        File.WriteAllText(Path.Combine(output, "odc-sweep.json"), summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True((summary["refused:identity"]?.GetValue<int>() ?? 0) == 0, "two builds of the same content refused: see " + Path.Combine(output, "odc-sweep.json"));
        Assert.True((summary["accepted:contentDiffers"]?.GetValue<int>() ?? 0) == 0, "two builds that differ were accepted: see " + Path.Combine(output, "odc-sweep.json"));
        Assert.True((summary["mutation:MISS"]?.GetValue<int>() ?? 0) == 0, "a changed property was accepted: see " + Path.Combine(output, "odc-sweep.json"));
    }

    /// <summary>The Studio's merge of the candidate over its base, headless (as OdcMergeOrderTests): the merged module.</summary>
    private static string? Merge(ModelHost host, byte[] basis, byte[] candidate, string merged)
    {
        var local = host.Load(basis);
        try
        {
            var foreign = host.Load(candidate); var original = host.Load(basis);
            string? conflict = null;
            try
            {
                ((IESpace)local).TransactionsManager.ExecuteTransaction("sweep: native merge", (_, _) =>
                {
                    using var tree = new MatchTree(local, foreign, original, false, true);
                    if (tree.HasConflicts) { conflict = "native merge has conflicts"; return false; }
                    tree.Merge(); return true;
                });
            }
            finally { ModelHost.Release(foreign); ModelHost.Release(original); }
            if (conflict != null) return conflict;
            File.WriteAllBytes(merged, host.Save(local));
            return null;
        }
        finally { ModelHost.Release(local); }
    }
}
