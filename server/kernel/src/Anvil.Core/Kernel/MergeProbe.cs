using ServiceStudio.Merge;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>Deferred: the defaults the merge order delivered in the second native merge (empty when one merge sufficed).</summary>
public sealed record MergeProbeResult(
    int LocalObjects, int ForeignObjects, bool LocalIsValid, int Errors, int Warnings, bool HasConflicts, IReadOnlyList<string> Details, MessageDelta Delta,
    IReadOnlyList<DeferredDefault>? Deferred = null);

/// <summary>
/// Merge de 3 vias HEADLESS, o mesmo MatchTree que a bridge usa no Studio (plano, item 17): local = base recarregada, foreign = o
/// resultado do job, base = a base. Prova de fidelidade: objetos(local depois) == objetos(foreign) e Verify sem erros. Foi assim
/// que se reproduziu, sem Studio, a perda de 56 objetos por referencia oculta (docs/mapa/2026-09-04-fidelidade-do-merge.md).
/// It follows the delivery's merge order (MergeOrder): defaults the Studio drops on elements a merge creates go in a second
/// merge over the first-pass copy, as merge_from_oml does with first_pass_path.
/// </summary>
public static class MergeProbe
{
    /// <summary>The native comparison of a model with the expected one (base = a second copy of the expected): an empty
    /// difference set means the model holds exactly the expected content.</summary>
    public static string CompareDump(ModelHost host, byte[] localBytes, byte[] expectedBytes)
    {
        ESpace? local = null, expected = null, basis = null;
        try
        {
            local = host.Load(localBytes); expected = host.Load(expectedBytes); basis = host.Load(expectedBytes);
            using var tree = new MatchTree(local, expected, basis, false, true);
            return tree.HasNoDifferences ? "" : tree.Dump();
        }
        finally { ModelHost.Release(local); ModelHost.Release(expected); ModelHost.Release(basis); }
    }

    /// <summary>The delivery's merge-order plan for a base and a candidate, and the first-pass copy when it defers defaults.</summary>
    public static (IReadOnlyList<DeferredDefault> Deferred, byte[]? FirstPass) Plan(ModelHost host, byte[] baseBytes, byte[] foreignBytes)
        => MergePlanner.Plan(host, baseBytes, foreignBytes);

    /// <summary>The headless delivery merge. singlePass=true merges the candidate once, as the bridges did before the merge
    /// order: it is kept to prove what the native merge alone drops.</summary>
    public static MergeProbeResult ThreeWay(ModelHost host, byte[] baseBytes, byte[] foreignBytes, string? saveTo = null, bool singlePass = false)
    {
        if (singlePass) return Replay(host, baseBytes, baseBytes, foreignBytes, null, saveTo);
        var (deferred, firstPass) = Plan(host, baseBytes, foreignBytes);
        return Replay(host, baseBytes, baseBytes, foreignBytes, firstPass, saveTo) with { Deferred = deferred };
    }

    /// <summary>merge_from_oml headless: foreign merged into local over basis; with a first-pass copy (MergeOrder), the copy is
    /// merged first and the candidate second, over the copy. The bridges run the same order with the Studio's merge command.</summary>
    public static MergeProbeResult Replay(ModelHost host, byte[] localBytes, byte[] baseBytes, byte[] foreignBytes, byte[]? firstPassBytes, string? saveTo = null)
    {
        using var totalTiming = NativePerformanceCapture.Measure("merge.total", cpu: true);
        ESpace? local = null, foreign = null, baseEs = null, firstPass = null, secondBase = null;
        try
        {
            using (NativePerformanceCapture.Measure("merge.loadLocal", cpu: true)) local = host.Load(localBytes);
            using (NativePerformanceCapture.Measure("merge.loadForeign", cpu: true)) foreign = host.Load(foreignBytes);
            using (NativePerformanceCapture.Measure("merge.loadBase", cpu: true)) baseEs = host.Load(baseBytes);
            int foreignObjects;
            using (NativePerformanceCapture.Measure("merge.describeForeignAndVerify", cpu: true)) foreignObjects = ModelHost.Describe(foreign, 0).Objects;
            IReadOnlyList<MessageInfo> before;
            using (NativePerformanceCapture.Measure("merge.verifyBefore", cpu: true)) before = ModelHost.Messages(local);
            if (firstPassBytes != null) firstPass = host.Load(firstPassBytes);
            var conflicts = Merge(local, firstPass ?? foreign, baseEs);
            if (firstPassBytes != null)
            {
                // Second merge: the candidate over the first-pass copy, so only the deferred defaults remain to merge.
                secondBase = host.Load(firstPassBytes);
                conflicts |= Merge(local, foreign, secondBase);
            }
            IReadOnlyList<MessageInfo> after;
            using (NativePerformanceCapture.Measure("merge.verifyAfter", cpu: true)) after = ModelHost.Messages(local);
            if (saveTo != null)
                using (NativePerformanceCapture.Measure("merge.save", cpu: true)) File.WriteAllBytes(saveTo, host.Save(local));
            using var descriptionTiming = NativePerformanceCapture.Measure("merge.describeAfter", cpu: true);
            var delta = MessageDelta.Compute(before, after);
            var snap = ModelHost.Describe(local, 0, after);
            var errors = snap.Validation.ByType.Where(k => k.Key.Contains("Error", StringComparison.Ordinal)).Sum(k => k.Value);
            var warnings = snap.Validation.ByType.Where(k => k.Key.Contains("Warning", StringComparison.Ordinal)).Sum(k => k.Value);
            return new MergeProbeResult(snap.Objects, foreignObjects, snap.IsValid, errors, warnings, conflicts, ModelHost.ValidationDetails(local, 40, after), delta);
        }
        finally
        {
            using var releaseTiming = NativePerformanceCapture.Measure("merge.release", cpu: true);
            ModelHost.Release(local); ModelHost.Release(foreign); ModelHost.Release(baseEs);
            ModelHost.Release(firstPass); ModelHost.Release(secondBase);
        }
    }

    /// <summary>One native merge of foreign into local over basis; true when the tree had conflicts.</summary>
    private static bool Merge(ESpace local, ESpace foreign, ESpace basis)
    {
        var conflicts = false;
        ReferenceSignatureMergePlan signaturePlan;
        using (NativePerformanceCapture.Measure("merge.signaturePlan", cpu: true)) signaturePlan = ReferenceSignatureMerge.Analyze(local, foreign, basis);
        if (signaturePlan.HasConflicts)
            throw new InvalidOperationException("Reference signature merge conflicts: " + string.Join("; ", signaturePlan.Conflicts.Select(c => c.Message)));
        StudioAdapter.Runtime.Mutate(local, "Anvil: headless 3-way merge (probe)", _ =>
        {
            if (signaturePlan.HasChanges)
            {
                using var signatureTiming = NativePerformanceCapture.Measure("merge.signatureApply", cpu: true);
                ReferenceSignatureMerge.MergeInCurrentCommand(local, foreign, basis, signaturePlan, tree =>
                {
                    using var applyTiming = NativePerformanceCapture.Measure("merge.treeApply", cpu: true);
                    tree.Merge();
                });
            }
            else
            {
                MatchTree tree;
                using (NativePerformanceCapture.Measure("merge.treeBuild", cpu: true)) tree = new MatchTree(local, foreign, basis, false, true);
                try
                {
                    using (NativePerformanceCapture.Measure("merge.conflictCheck", cpu: true)) conflicts = tree.HasConflicts;
                    using (NativePerformanceCapture.Measure("merge.treeApply", cpu: true)) tree.Merge();
                }
                finally
                {
                    using var disposeTiming = NativePerformanceCapture.Measure("merge.treeDispose", cpu: true);
                    tree.Dispose();
                }
            }
        });
        if (signaturePlan.HasChanges)
            using (NativePerformanceCapture.Measure("merge.verifySignature", cpu: true)) ReferenceSignatureMerge.VerifyApplied(local, foreign, basis, signaturePlan);
        return conflicts;
    }
}
