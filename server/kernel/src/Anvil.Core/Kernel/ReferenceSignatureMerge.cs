using OutSystems.Model;
using OutSystems.MetaModel.Enumerations;
using ServiceStudio.Merge;
using ServiceStudio.Model;

namespace Anvil.Core;

public sealed record ReferenceSignatureChange(string ProducerKey, string LocalReferenceKey,
    string BaseReferenceKey, string ForeignReferenceKey, string Kind,
    Guid BaseHash, Guid LocalHash, Guid ForeignHash);
public sealed record ReferenceSignatureConflict(string ProducerKey, string Code, string Message);
public sealed record ReferenceSignatureMergeResult(int SelectedReferences, int NativeMergeCount);

/// <summary>Immutable observations of existing producer signature changes. Names/aliases are
/// deliberately absent: native merge continues to own their three-way resolution.</summary>
public sealed class ReferenceSignatureMergePlan
{
    public IReadOnlyList<ReferenceSignatureChange> Changes { get; }
    public IReadOnlyList<ReferenceSignatureConflict> Conflicts { get; }
    public bool HasChanges => Changes.Count != 0;
    public bool HasConflicts => Conflicts.Count != 0;
    internal string ModuleKey { get; }
    internal IReadOnlyList<ReferenceSignatureChange> Observations { get; }

    internal ReferenceSignatureMergePlan(string moduleKey, IEnumerable<ReferenceSignatureChange> observations,
        IEnumerable<ReferenceSignatureConflict> conflicts)
    {
        ModuleKey = moduleKey;
        Observations = Array.AsReadOnly(observations.OrderBy(o => o.ProducerKey, StringComparer.Ordinal).ToArray());
        Changes = Array.AsReadOnly(Observations.Where(o => o.LocalHash != o.ForeignHash).ToArray());
        Conflicts = Array.AsReadOnly(conflicts.ToArray());
    }
}

/// <summary>Explicit native selection for ReferenceHash, which the Studio marks IgnoreForDiff.
/// This helper neither assigns hashes nor acquires signatures. The caller must validate the frozen
/// foreign artifact/signatures before merging; model validity alone is not signature attestation.</summary>
public static class ReferenceSignatureMerge
{
    /// <summary>Reads the three models without constructing a MatchTree or mutating model/metadata.
    /// A missing base is a conflict: version selection is deliberately limited to three-way merge.
    /// New references use native creation; existing references whose foreign hash differs from base
    /// require an explicit decision, including changes with no visible action/ABI difference.</summary>
    public static ReferenceSignatureMergePlan Analyze(ESpace local, ESpace foreign, ESpace? basis)
    {
        ArgumentNullException.ThrowIfNull(local); ArgumentNullException.ThrowIfNull(foreign);
        var changes = new List<ReferenceSignatureChange>(); var conflicts = new List<ReferenceSignatureConflict>();
        var moduleKey = local.Key.ToString();
        void Conflict(string producer, string code, string message) => conflicts.Add(new(producer, code, message));
        if (basis == null)
        {
            Conflict("", "missing-base", "Reference signature selection requires the original base model.");
            return new(moduleKey, changes, conflicts);
        }
        if (!local.Key.Equals(foreign.Key) || !local.Key.Equals(basis.Key))
        {
            Conflict("", "module-identity", "Reference signature models belong to different module identities.");
            return new(moduleKey, changes, conflicts);
        }
        var localReferences = local.References.ToArray();
        var baseReferences = basis.References.GroupBy(ProducerKey).ToDictionary(g => g.Key, g => g.ToArray(), StringComparer.Ordinal);
        foreach (var group in foreign.References.GroupBy(ProducerKey))
        {
            var producerKey = group.Key;
            if (!baseReferences.TryGetValue(producerKey, out var originals)) continue;
            var proposed = group.ToArray();
            if (originals.Length != 1 || proposed.Length != 1)
            {
                Conflict(producerKey, "ambiguous-producer", "The base/foreign producer identity is ambiguous."); continue;
            }
            var original = originals[0]; var desired = proposed[0];
            if (original.ReferenceHash == desired.ReferenceHash) continue;
            if (string.IsNullOrWhiteSpace(producerKey) || desired.ReferenceHash == Guid.Empty || desired.HasDeserializationErrors
                || desired.ReferenceKind is not (ReferenceKind.Extension or ReferenceKind.eSpace)
                || !((IObjectSignature)desired).IsValid)
            {
                Conflict(producerKey, "invalid-foreign-signature", "The foreign producer signature is empty, unavailable or invalid."); continue;
            }
            if (original.ReferenceKind != desired.ReferenceKind || !original.Key.Equals(desired.Key))
            {
                Conflict(producerKey, "foreign-reference-identity", "The foreign producer changed reference kind or local reference identity."); continue;
            }
            var originalLocalObjects = localReferences.Where(r => r.Key.Equals(original.Key)).ToArray();
            if (originalLocalObjects.Length == 1 && ProducerKey(originalLocalObjects[0]) != producerKey)
            {
                Conflict(producerKey, "producer-identity-changed", "The local reference now belongs to another producer."); continue;
            }
            var currentReferences = localReferences.Where(r => ProducerKey(r) == producerKey).ToArray();
            if (currentReferences.Length != 1)
            {
                Conflict(producerKey, "local-producer-missing-or-ambiguous", "The original producer is missing or ambiguous in the local model."); continue;
            }
            var current = currentReferences[0];
            if (!current.Key.Equals(original.Key) || current.ReferenceKind != original.ReferenceKind)
            {
                Conflict(producerKey, "local-reference-identity-changed", "The local producer changed reference kind or local reference identity."); continue;
            }
            if (current.ReferenceHash != original.ReferenceHash && current.ReferenceHash != desired.ReferenceHash)
            {
                Conflict(producerKey, "concurrent-signature", "The local producer signature changed concurrently; its revision cannot be overwritten."); continue;
            }
            changes.Add(new(producerKey, current.Key.ToString(), original.Key.ToString(), desired.Key.ToString(), desired.ReferenceKind.ToString(),
                original.ReferenceHash, current.ReferenceHash, desired.ReferenceHash));
        }
        return new(moduleKey, changes, conflicts);
    }

    /// <summary>Runs the native structural merge and pending reference selections sequentially
    /// inside the caller's existing Command. The delegate must synchronously merge the supplied
    /// tree inside that Command, on its thread (the bridge and headless both call tree.Merge(); never
    /// CompareAndMergeCommands.Merge, fix-ext-refs 2026-10-16). The helper owns
    /// both trees and disposes each before constructing the next. Exceptions must escape the
    /// caller's Command so native rollback restores the complete operation.</summary>
    public static ReferenceSignatureMergeResult MergeInCurrentCommand(ESpace local, ESpace foreign, ESpace basis,
        ReferenceSignatureMergePlan plan, Action<MatchTree> mergeTree, bool matchByStructure = false)
        => MergeInCurrentCommandStaged(local, foreign, basis, plan, mergeTree, matchByStructure, null);

    /// <summary>fam-deps R7: MergeInCurrentCommand where <paramref name="stage"/> hears each step as it starts (plan,
    /// structural-tree, structural-merge, replan, reference-tree, reference-selection, reference-merge, verify), so a failure
    /// names where it happened. A separate name keeps MergeInCurrentCommand's signature for its callers.</summary>
    public static ReferenceSignatureMergeResult MergeInCurrentCommandStaged(ESpace local, ESpace foreign, ESpace basis,
        ReferenceSignatureMergePlan plan, Action<MatchTree> mergeTree, bool matchByStructure, Action<string>? stage)
    {
        ArgumentNullException.ThrowIfNull(mergeTree);
        stage?.Invoke("plan");
        var current = ValidatePlan(local, foreign, basis, plan);
        var nativeMergeCount = 0; var selectedReferences = 0;
        stage?.Invoke("structural-tree");
        using (var tree = new MatchTree(local, foreign, basis, matchByStructure, true))
        {
            if (tree.HasConflicts)
                throw new InvalidOperationException("Native merge conflicts must be resolved before merging producer signatures.");
            // Validate every native property before any structural mutation. Selection follows
            // later on explicit roots because ignored metadata may lie below a skipped ancestor.
            ValidatePairs(local, foreign, basis, current, requireReachability: false);
            if (!tree.HasNoDifferences)
            {
                stage?.Invoke("structural-merge");
                mergeTree(tree);
                if (tree.CanMerge) throw new InvalidOperationException("The native structural merge callback did not merge its tree.");
                nativeMergeCount++;
            }
        }
        stage?.Invoke("replan");
        current = ValidatePlan(local, foreign, basis, plan);
        if (current.HasChanges)
        {
            stage?.Invoke("reference-tree");
            using var tree = CreateReferenceTree(local, foreign, basis, current);
            stage?.Invoke("reference-selection");
            selectedReferences = ApplySelection(local, foreign, basis, plan);
            stage?.Invoke("reference-merge");
            mergeTree(tree);
            if (tree.CanMerge) throw new InvalidOperationException("The native reference merge callback did not merge its tree.");
            nativeMergeCount++;
            stage?.Invoke("verify");
            VerifyApplied(local, foreign, basis, plan);
        }
        return new(selectedReferences, nativeMergeCount);
    }
    /// <summary>Read-only postcondition. Call again after the enclosing SDK Command returns:
    /// its cleanup may roll back after the merge delegate has already completed.</summary>
    public static void VerifyApplied(ESpace local, ESpace foreign, ESpace basis, ReferenceSignatureMergePlan plan)
    {
        var current = ValidatePlan(local, foreign, basis, plan);
        // fam-deps R7: the exact references, never the symptom alone.
        if (current.HasChanges)
            throw new InvalidOperationException("Native merge did not retain all validated producer signature selections: "
                + string.Join("; ", current.Changes.Select(c => "producer " + c.ProducerKey + " stays at " + c.LocalHash + " (selected " + c.ForeignHash + ", base " + c.BaseHash + ")")));
    }

    /// <summary>Builds a single native tree whose roots include the changed references. Use only
    /// when the full native comparison has no visible differences: otherwise its normal merge
    /// decisions must be preserved. The caller owns disposal and still calls ApplySelection in
    /// its merge command. No property is selected and no signature hash is assigned here.</summary>
    public static MatchTree CreateMetadataTree(ESpace local, ESpace foreign, ESpace basis, ReferenceSignatureMergePlan plan)
    {
        var current = ValidatePlan(local, foreign, basis, plan);
        var preview = new MatchTree(local, foreign, basis, false, true);
        if (!preview.HasNoDifferences || preview.HasConflicts)
        {
            preview.Dispose();
            throw new InvalidOperationException("A reference-only merge tree cannot omit visible model differences or conflicts.");
        }
        if (!current.HasChanges) return preview;
        preview.Dispose();
        // ReferenceHash is ignored by native Difference. A module-root tree consequently skips
        // the unchanged parent path. Explicit native roots preserve traversal in the same merge.
        return CreateReferenceTree(local, foreign, basis, current);
    }

    private static MatchTree CreateReferenceTree(ESpace local, ESpace foreign, ESpace basis, ReferenceSignatureMergePlan current)
    {
        var tree = new MatchTree((Func<PropertyPair, bool>)null!);
        try
        {
            tree.SetESpaces(local, foreign, basis);
            foreach (var change in current.Changes)
                tree.AddRoot(local.References.Single(r => r.Key.ToString() == change.LocalReferenceKey),
                    foreign.References.Single(r => r.Key.ToString() == change.ForeignReferenceKey),
                    basis.References.Single(r => r.Key.ToString() == change.BaseReferenceKey));
            return tree;
        }
        catch { tree.Dispose(); throw; }
    }
    /// <summary>Revalidates the complete plan and all native pairs before selecting any property.
    /// Call inside the actual merge command, after its MatchTree has been constructed. It also works
    /// in CompareAndMergeCommands.AutomaticMergeHandler via each local Reference's current Match.
    /// Returns the number selected; it never writes ReferenceHash or changes global metadata.</summary>
    public static int ApplySelection(ESpace local, ESpace foreign, ESpace? basis, ReferenceSignatureMergePlan plan)
    {
        var current = ValidatePlan(local, foreign, basis, plan);
        var selections = ValidatePairs(local, foreign, basis!, current, requireReachability: true);
        // No selection occurs until every observation and pair has passed.
        foreach (var pair in selections) pair.MergeAction = MergeAction.Update;
        return selections.Count;
    }

    private static List<PropertyPair> ValidatePairs(ESpace local, ESpace foreign, ESpace basis,
        ReferenceSignatureMergePlan current, bool requireReachability)
    {
        var selections = new List<PropertyPair>();
        foreach (var change in current.Changes)
        {
            var localReference = local.References.Single(r => ProducerKey(r) == change.ProducerKey && r.Key.ToString() == change.LocalReferenceKey);
            var foreignReference = foreign.References.Single(r => ProducerKey(r) == change.ProducerKey && r.Key.ToString() == change.ForeignReferenceKey);
            var match = localReference.Match;
            if (match == null || match.LocalObject != localReference || match.ForeignObject != foreignReference || match.Tree.LocalESpace != local)
                throw new InvalidOperationException("Reference signature selection requires the actual merge tree: " + change.ProducerKey);
            if (match.BaseObject != basis!.References.Single(r => r.Key.ToString() == change.BaseReferenceKey))
                throw new InvalidOperationException("Reference signature selection requires the original merge base: " + change.ProducerKey);
            // Native recursion examines differences, not the selected property. A selection below
            // a skipped ancestor would silently keep the old hash even though MergeAction=Update.
            var roots = match.Tree.Roots.ToHashSet();
            for (var ancestor = match; requireReachability && !roots.Contains(ancestor) && ancestor != match.Tree.RootAtESpace;)
            {
                ancestor = ancestor.Parent;
                if (requireReachability && (ancestor == null || !ancestor.HasDifferencesInChildren && !ancestor.HasConflicts))
                    throw new InvalidOperationException("Reference signature requires an explicit native root before selection: " + change.ProducerKey);
            }
            var pair = match.GetPropertyPair(Reference.ReferenceHashPropertyDescriptor)
                ?? throw new InvalidOperationException("Native ReferenceHash merge property is unavailable: " + change.ProducerKey);
            if (pair.BaseValue is not Guid baseHash || baseHash != change.BaseHash
                || pair.LocalValue is not Guid localHash || localHash != change.LocalHash
                || pair.ForeignValue is not Guid foreignHash || foreignHash != change.ForeignHash)
                throw new InvalidOperationException("Native merge pair differs from the validated producer signature: " + change.ProducerKey);
            if (pair.MergeAction is not (MergeAction.None or MergeAction.Update))
                throw new InvalidOperationException("Native ReferenceHash already has another merge selection: " + change.ProducerKey);
            selections.Add(pair);
        }
        return selections;

    }

    private static ReferenceSignatureMergePlan ValidatePlan(ESpace local, ESpace foreign, ESpace? basis, ReferenceSignatureMergePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        RequireNoConflicts(plan);
        var current = Analyze(local, foreign, basis);
        RequireNoConflicts(current);
        if (current.ModuleKey != plan.ModuleKey || current.Observations.Count != plan.Observations.Count)
            throw new InvalidOperationException("Reference signature models changed after the selection was planned.");
        var expected = plan.Observations.ToDictionary(o => o.ProducerKey, StringComparer.Ordinal);
        foreach (var observed in current.Observations)
        {
            if (!expected.TryGetValue(observed.ProducerKey, out var before)
                || observed.LocalReferenceKey != before.LocalReferenceKey || observed.BaseReferenceKey != before.BaseReferenceKey
                || observed.ForeignReferenceKey != before.ForeignReferenceKey || observed.Kind != before.Kind
                || observed.BaseHash != before.BaseHash || observed.ForeignHash != before.ForeignHash
                || observed.LocalHash != before.LocalHash && observed.LocalHash != before.ForeignHash)
                throw new InvalidOperationException("Producer identity/signature changed after planning: " + observed.ProducerKey);
        }

        return current;
    }

    private static string ProducerKey(Reference reference) => reference.ReferenceKey?.ToString() ?? "";
    private static void RequireNoConflicts(ReferenceSignatureMergePlan plan)
    {
        if (plan.HasConflicts) throw new InvalidOperationException("Reference signature merge conflicts: "
            + string.Join("; ", plan.Conflicts.Select(c => c.ProducerKey + " [" + c.Code + "]: " + c.Message)));
    }
}
