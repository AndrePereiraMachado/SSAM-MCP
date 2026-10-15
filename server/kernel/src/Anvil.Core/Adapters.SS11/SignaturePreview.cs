using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using ServiceStudio.Model;

namespace Anvil.Core.Delivery;

/// <summary>
/// C15: the producer signature postcondition of a merge, checked in a disposable preview before the live merge.
/// The live merge of a candidate that changes a producer signature runs ReferenceSignatureMerge inside the Studio's command;
/// when the postcondition fails there (VerifyApplied), the command rolls the merge back after it started and the delivery
/// became uncertain. Here the same native merge runs headless on copies of the base (local and basis) and the candidate,
/// exactly as MergeProbe does, and a failed plan or postcondition refuses the delivery before anything is merged.
/// Runs only when the candidate changes a producer signature; when the models cannot be loaded here (no Studio runtime) the
/// preview reports ran:false and the delivery continues as before (the live merge keeps its own checks).
/// SS11 only (Adapters.SS11, not compiled in Anvil.Core.Odc): Delivery finds it by name, so the shared delivery code has no
/// compile-time dependency on the O11 merge types.
/// </summary>
public static class SignaturePreview
{
    public static JsonObject Check(string basePath, string foreignPath, string workDirectory)
    {
        try { return Run(basePath, foreignPath, workDirectory); }
        catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or TypeLoadException or TypeInitializationException or MissingMethodException)
        { return new JsonObject { ["ran"] = false, ["reason"] = "the Studio model runtime is not available here: " + ex.Message }; }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static JsonObject Run(string basePath, string foreignPath, string workDirectory)
    {
        var host = new ModelHost(Path.Combine(workDirectory, "signature-preview"));
        ESpace? local = null, foreign = null, basis = null;
        try
        {
            try
            {
                foreign = host.Load(File.ReadAllBytes(foreignPath));
                basis = host.Load(File.ReadAllBytes(basePath));
                local = host.Load(File.ReadAllBytes(basePath));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            { return new JsonObject { ["ran"] = false, ["reason"] = "the base or candidate could not be loaded for the preview: " + Errors.Text(ex) }; }
            var plan = ReferenceSignatureMerge.Analyze(local, foreign, basis);
            // fam-deps R8: the plan itself (producer key, base, local and candidate hashes) travels with the answer, so a
            // rollback of the live merge names the exact references even when the bridge's receipt has no plan.
            var planJson = System.Text.Json.JsonSerializer.SerializeToNode(new { Changes = plan.Changes });
            if (plan.HasConflicts)
                return new JsonObject { ["ran"] = true, ["accepted"] = false, ["changes"] = plan.Changes.Count, ["plan"] = planJson,
                    ["error"] = "Reference signature merge conflicts: " + string.Join("; ", plan.Conflicts.Select(c => c.ProducerKey + " [" + c.Code + "]: " + c.Message)) };
            if (!plan.HasChanges) return new JsonObject { ["ran"] = true, ["accepted"] = true, ["changes"] = 0 };
            try
            {
                StudioAdapter.Runtime.Mutate(local, "Anvil: producer signature preview", _ =>
                    ReferenceSignatureMerge.MergeInCurrentCommand(local, foreign, basis, plan, tree => tree.Merge()));
                ReferenceSignatureMerge.VerifyApplied(local, foreign, basis, plan);
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
            { return new JsonObject { ["ran"] = true, ["accepted"] = false, ["changes"] = plan.Changes.Count, ["plan"] = planJson, ["error"] = Errors.Text(ex) }; }
            return new JsonObject { ["ran"] = true, ["accepted"] = true, ["changes"] = plan.Changes.Count, ["plan"] = planJson };
        }
        finally { ModelHost.Release(local); ModelHost.Release(foreign); ModelHost.Release(basis); }
    }
}
