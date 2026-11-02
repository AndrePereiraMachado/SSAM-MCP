namespace Anvil.Core;

/// <summary>F1 conflict (Delivery.ConflictRebase, O11): the candidate rebased on the live module. A native three-way merge
/// (MergeProbe.Replay, the Studio's own MatchTree) whose local side is the candidate and whose foreign side is the live
/// module, over the first attempt's base: the person's edits come in, and on a conflict the local side (the delivery's value)
/// stays, as the Studio's merge keeps its local side.</summary>
internal static class NativeConflictRebase
{
    public static void Build(ModelHost host, byte[] candidate, byte[] live, byte[] basis, string outputPath)
        => MergeProbe.Replay(host, candidate, basis, live, null, outputPath);
}