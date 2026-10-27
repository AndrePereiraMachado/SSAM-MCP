using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>Review of 3ab12209, 9c: the disposable ODC merge (NativeMergePreview) of a candidate in conflict with the module
/// merged nothing, and then compared the candidate with the unchanged module: its answer named every element of the candidate
/// as lost content. Now a conflict is answered as a conflict, with the elements the installed MatchTree marks as in conflict,
/// and no element is named as lost. A real three-way conflict over the installed ODC Studio: the module and the candidate
/// changed the same property of one entity from a common base. Needs the ODC Studio; without it the test returns.</summary>
public class NativeMergePreviewConflictOdcTests(ITestOutputHelper output)
{
    private static string Root { get { var d = Path.GetDirectoryName(typeof(NativeMergePreviewConflictOdcTests).Assembly.Location); while (d != null && !File.Exists(Path.Combine(d, "MANIFESTO.md"))) d = Path.GetDirectoryName(d); return d!; } }

    [Fact]
    public void AConflictNamesTheConflictAndNoElementAsLost()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        Run(output);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void Run(ITestOutputHelper output)
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "merge-preview-conflict", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var blank = Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml");
        string Apply(string from, string name, string job)
        {
            var jobPath = Path.Combine(dir, name + ".json"); File.WriteAllText(jobPath, job);
            var outPath = Path.Combine(dir, name + ".oml");
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, from, jobPath, outPath))!;
            Assert.True(applied["accepted"]!.GetValue<bool>(), name + ": " + applied.ToJsonString()[..Math.Min(2000, applied.ToJsonString().Length)]);
            return outPath;
        }
        // The common base: an entity with two attributes and a static entity (content a lost-content answer would name).
        var basePath = Apply(blank, "base", """
            {"ops":[{"op":"spec","data":{
              "static":[{"name":"ProbeKind","public":true,"records":[{"name":"First","id":1},{"name":"Second","id":2}]}],
              "entities":[{"name":"ProbeItem","public":true,"attributes":[{"name":"Title","type":"Text","length":100},{"name":"Count","type":"Integer"}]}]}}]}
            """);
        // The module and the candidate change the same property of the entity, each to its own value; the candidate also adds an
        // entity of its own (what a comparison with the unchanged module would name as lost).
        var localPath = Apply(basePath, "local", """{"ops":[{"op":"set","target":"Entity:ProbeItem","prop":"Description","value":"the module's description"}]}""");
        var candidatePath = Apply(basePath, "candidate", """
            {"ops":[{"op":"set","target":"Entity:ProbeItem","prop":"Description","value":"the candidate's description"},
                    {"op":"spec","data":{"entities":[{"name":"ProbeExtra","attributes":[{"name":"Label","type":"Text","length":50}]}]}}]}
            """);
        var preview = NativeMergePreview.Check(host, File.ReadAllBytes(localPath), File.ReadAllBytes(candidatePath), null, candidatePath,
            Path.Combine(dir, "preview.oml"), mergeBase: File.ReadAllBytes(basePath));
        File.WriteAllText(Path.Combine(dir, "preview.json"), preview.ToJsonString());
        using (var l = host.Load(File.ReadAllBytes(localPath))) using (var c = host.Load(File.ReadAllBytes(candidatePath))) using (var b = host.Load(File.ReadAllBytes(basePath)))
        using (var tree = new OutSystems.Model.Merge.MatchTree(l, c, b, false, true)) File.WriteAllText(Path.Combine(dir, "dump.txt"), tree.Dump());
        output.WriteLine(preview.ToJsonString()[..Math.Min(4000, preview.ToJsonString().Length)]);
        Assert.True(preview["hasConflicts"]!.GetValue<bool>(), "the installed MatchTree found no conflict: " + preview.ToJsonString());
        Assert.False(preview["accepted"]!.GetValue<bool>());
        var proof = preview["contentProof"]!.AsObject();
        Assert.False(proof["accepted"]!.GetValue<bool>());
        Assert.True(proof["conflict"]?.GetValue<bool>() == true, proof.ToJsonString());
        // No element is named as lost: nothing was merged, nothing was compared.
        Assert.Empty(proof["differences"]!.AsArray());
        Assert.DoesNotContain("ProbeExtra", proof.ToJsonString());
        // The conflict names the element in conflict (the entity both sides changed), on the answer and in its proof.
        var named = preview["conflicts"]!.AsArray().Select(c => c!.GetValue<string>()).ToList();
        Assert.Contains(named, c => c.Contains("ProbeItem", StringComparison.Ordinal));
        Assert.DoesNotContain(named, c => c.Contains("ProbeExtra", StringComparison.Ordinal));
        Assert.Contains("conflict", proof["reason"]!.GetValue<string>());
        // Without a conflict the same candidate over its own base is proven as before (merged, compared, accepted).
        var clean = NativeMergePreview.Check(host, File.ReadAllBytes(basePath), File.ReadAllBytes(candidatePath), null, candidatePath, Path.Combine(dir, "clean.oml"));
        Assert.False(clean["hasConflicts"]!.GetValue<bool>());
        Assert.Null(clean["conflicts"]);
        Assert.True(clean["accepted"]!.GetValue<bool>(), clean["contentProof"]!["differences"]!.ToJsonString());
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(); return true; } catch { return false; }
    }
}
