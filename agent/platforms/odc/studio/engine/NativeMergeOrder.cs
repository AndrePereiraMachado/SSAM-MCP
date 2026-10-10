using OutSystems.Model;
using OutSystems.Model.Merge;
using ServiceStudio.Model;

// MergeOrder and DeferredDefault are named without a namespace: the ODC bridge compiles its copy (bridge/MergeOrderCopy.cs,
// global namespace, so the agent pack carries no kernel type) and kernel/tests/Anvil.Tests.Odc binds the kernel's own
// (EngineKernelTypes.cs).
// The merge order of one delivery (Anvil.Core.MergeOrder, kernel/src/Anvil.Core/Kernel/MergeOrder.cs). The ODC Studio removes
// a Default Value it marks read-only (an entity attribute of an identifier type, a mandatory input parameter) when a merge
// sets that element's type, so the default of an element the merge creates is lost; merged onto the existing element it is
// kept. Prepare lists those defaults and builds the first-pass copy (each at its base value) in the copy's own transaction;
// SecondPass merges the candidate over that copy once the first merge created the elements. The merge itself is a delegate:
// the bridge passes CompareAndMergeCommands.CompareAndMerge, the kernel tests the same MatchTree headless.
internal static class NativeMergeOrder
{
    public sealed record Plan(IReadOnlyList<DeferredDefault> Deferred, byte[]? FirstPass);
    public sealed record Pass(bool Merged, string? Outcome, string? Reason, bool Conflicts, bool NoDifferences, string Dump);

    public static Plan Prepare(ESpace candidate, ESpace basis, byte[] candidateBytes, Func<byte[], ESpace> load)
    {
        var deferred = MergeOrder.Plan(candidate, basis);
        if (deferred.Count == 0) return new Plan(deferred, null);
        var copy = load(candidateBytes);
        try
        {
            ((IESpace)copy).TransactionsManager.ExecuteTransaction("SSAM: merge order, first pass", (_, _) => { MergeOrder.Strip(copy, deferred); return true; });
            using var stream = copy.SaveToMemoryStream();
            return new Plan(deferred, stream.ToArray());
        }
        finally { copy.Close(); }
    }

    // The candidate over the first-pass copy: the copy differs from the candidate only by the deferred defaults, so the
    // 3-way merge brings exactly those and keeps what the first merge normalized. A conflict or no difference stops here.
    public static Pass SecondPass(ESpace local, byte[] candidateBytes, byte[] firstPass, Func<byte[], ESpace> load, Func<ESpace, ESpace, ESpace, string> merge)
    {
        using var secondBase = load(firstPass);
        var candidate = load(candidateBytes);
        var handedOff = false;
        try
        {
            if (candidate.Key != local.Key || secondBase.Key != local.Key) throw new InvalidOperationException("Native module key mismatch in the second merge of the merge order.");
            bool conflicts, noDifferences; string dump;
            using (var tree = new MatchTree(local, candidate, secondBase, false, true)) { conflicts = tree.HasConflicts; noDifferences = tree.HasNoDifferences; dump = tree.Dump(); }
            if (conflicts || noDifferences) return new Pass(false, null, conflicts ? "conflicts" : "no differences", conflicts, noDifferences, dump);
            handedOff = true;
            var outcome = merge(local, candidate, secondBase);
            return new Pass(outcome is "Merge" or "MergeAndPublish", outcome, null, false, false, dump);
        }
        finally { if (!handedOff) candidate.Close(); }
    }
}
