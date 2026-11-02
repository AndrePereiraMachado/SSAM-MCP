using OutSystems.Model.Merge;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>F1 conflict (Delivery.ConflictRebase, ODC): the candidate rebased on the live module. The installed MatchTree with
/// the candidate as the local side and the live module as the foreign side, over the first attempt's base: the person's
/// edits come in and, on a conflict, the local side (the delivery's value) stays.</summary>
internal static class NativeConflictRebase
{
    public static void Build(ModelHost host, byte[] candidate, byte[] live, byte[] basis, string outputPath)
    {
        ESpace? local = null, foreign = null, over = null;
        try
        {
            local = host.Load(candidate); foreign = host.Load(live); over = host.Load(basis);
            StudioAdapter.Runtime.Mutate(local, "Anvil: ODC conflict rebase (the delivery's value stays)", _ => {
                using var tree = new MatchTree(local, foreign, over, false, true);
                tree.Merge();
            });
            Delivery.DurableJson.WriteBytes(outputPath, host.Save(local));
        }
        finally { ModelHost.Release(local); ModelHost.Release(foreign); ModelHost.Release(over); }
    }
}