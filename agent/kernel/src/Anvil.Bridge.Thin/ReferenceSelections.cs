using System.Text.Json.Nodes;
using ServiceStudio.Merge;
using ServiceStudio.Model;

namespace Anvil.Bridge;

internal sealed record ReferencePlanChange(string ProducerKey, string LocalReferenceKey,
    string BaseReferenceKey, string ForeignReferenceKey, string Kind,
    Guid BaseHash, Guid LocalHash, Guid ForeignHash);
internal sealed record ReferencePlanConflict(string ProducerKey, string Code, string Message);
internal sealed record ReferenceSelectionResult(int SelectedReferences, int NativeMergeCount);

/// <summary>The producer signature plan of merge_from_oml (docs/O11-BRIDGE-FINA.md section 3.3): the JSON the server
/// sends in reference_plan, with the same property names as the kernel's plan (Changes, Conflicts, HasChanges,
/// HasConflicts), so the effective plan serializes back into referenceSignatures in the same shape.</summary>
internal sealed class ReferencePlan
{
    public IReadOnlyList<ReferencePlanChange> Changes { get; }
    public IReadOnlyList<ReferencePlanConflict> Conflicts { get; }
    public bool HasChanges => Changes.Count != 0;
    public bool HasConflicts => Conflicts.Count != 0;

    public ReferencePlan(IEnumerable<ReferencePlanChange> changes, IEnumerable<ReferencePlanConflict> conflicts)
    {
        Changes = Array.AsReadOnly(changes.ToArray());
        Conflicts = Array.AsReadOnly(conflicts.ToArray());
    }

    private static readonly string[] PlanFields = ["Changes", "Conflicts", "HasChanges", "HasConflicts"];
    private static readonly string[] ChangeFields = ["ProducerKey", "LocalReferenceKey", "BaseReferenceKey", "ForeignReferenceKey", "Kind", "BaseHash", "LocalHash", "ForeignHash"];
    private static readonly string[] ConflictFields = ["ProducerKey", "Code", "Message"];

    /// <summary>Reads the server's plan strictly: exact property names, string keys, valid GUID hashes, lists, and flags
    /// consistent with the lists. Anything else is a FormatException (the merge is then not executed).</summary>
    public static ReferencePlan Parse(JsonNode? node)
    {
        var root = Object(node, PlanFields, "reference_plan");
        if (root["Changes"] is not JsonArray changes) throw new FormatException("reference_plan.Changes must be a list");
        if (root["Conflicts"] is not JsonArray conflicts) throw new FormatException("reference_plan.Conflicts must be a list");
        var plan = new ReferencePlan(
            changes.Select((item, i) =>
            {
                var change = Object(item, ChangeFields, $"reference_plan.Changes[{i}]");
                foreach (var field in ChangeFields) if (!change.ContainsKey(field)) throw new FormatException($"reference_plan.Changes[{i}].{field} is required");
                return new ReferencePlanChange(Text(change, "ProducerKey", i), Text(change, "LocalReferenceKey", i), Text(change, "BaseReferenceKey", i),
                    Text(change, "ForeignReferenceKey", i), Text(change, "Kind", i), Hash(change, "BaseHash", i), Hash(change, "LocalHash", i), Hash(change, "ForeignHash", i));
            }).ToArray(),
            conflicts.Select((item, i) =>
            {
                var conflict = Object(item, ConflictFields, $"reference_plan.Conflicts[{i}]");
                foreach (var field in ConflictFields)
                    if (conflict[field] is not JsonValue value || !value.TryGetValue<string>(out _)) throw new FormatException($"reference_plan.Conflicts[{i}].{field} must be text");
                return new ReferencePlanConflict(conflict["ProducerKey"]!.GetValue<string>(), conflict["Code"]!.GetValue<string>(), conflict["Message"]!.GetValue<string>());
            }).ToArray());
        if (root.ContainsKey("HasChanges") && Flag(root, "HasChanges") != plan.HasChanges) throw new FormatException("reference_plan.HasChanges contradicts Changes");
        if (root.ContainsKey("HasConflicts") && Flag(root, "HasConflicts") != plan.HasConflicts) throw new FormatException("reference_plan.HasConflicts contradicts Conflicts");
        return plan;

        static JsonObject Object(JsonNode? item, string[] allowed, string where)
        {
            if (item is not JsonObject obj) throw new FormatException(where + " must be an object");
            foreach (var (name, _) in obj) if (!allowed.Contains(name, StringComparer.Ordinal)) throw new FormatException($"{where}.{name} is not a plan field");
            return obj;
        }
        static string Text(JsonObject change, string field, int i) =>
            change[field] is JsonValue value && value.TryGetValue<string>(out var text) ? text : throw new FormatException($"reference_plan.Changes[{i}].{field} must be text");
        static Guid Hash(JsonObject change, string field, int i) =>
            change[field] is JsonValue value && value.TryGetValue<string>(out var text) && Guid.TryParse(text, out var hash)
                ? hash : throw new FormatException($"reference_plan.Changes[{i}].{field} must be a GUID");
        static bool Flag(JsonObject root, string field) =>
            root[field] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : throw new FormatException($"reference_plan.{field} must be true or false");
    }
}

/// <summary>
/// The local guard of the producer signature merge (docs/O11-BRIDGE-FINA.md section 3.3). ReferenceHash is IgnoreForDiff:
/// the native merge would silently keep the old producer signature, so the changes are selected explicitly inside the
/// same SDK command. The server judges base and candidate (ReferenceSignatureMerge.Analyze) and sends the plan; here the
/// bridge only checks what the Studio alone can see: that the plan covers the bytes it loaded (RequireComplete), the live
/// half of Analyze on the open module (Effective), and the native selection itself (MergeInCurrentCommand,
/// VerifyRetained). Codes and texts are the kernel's.
/// </summary>
internal static class ReferenceSelections
{
    public const string CoverageError = "reference_plan does not cover the loaded base/candidate; recompute it on the server";

    /// <summary>Every producer of the candidate that is also in the base, grouped by ReferenceKey as Analyze does, is
    /// covered: ambiguous -> a conflict of that producer; one each with a different ReferenceHash -> a conflict of that
    /// producer or exactly one change with the two reference keys, the candidate kind and the two hashes; and no change
    /// of the plan is left without such a pair. Throws before any native call.</summary>
    public static void RequireComplete(ESpace basis, ESpace foreign, ReferencePlan plan)
    {
        var conflicted = plan.Conflicts.Select(c => c.ProducerKey).ToHashSet(StringComparer.Ordinal);
        var changes = plan.Changes.GroupBy(c => c.ProducerKey, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToArray(), StringComparer.Ordinal);
        var paired = new HashSet<string>(StringComparer.Ordinal);
        var baseReferences = basis.References.GroupBy(ProducerKey).ToDictionary(g => g.Key, g => g.ToArray(), StringComparer.Ordinal);
        foreach (var group in foreign.References.GroupBy(ProducerKey))
        {
            var producerKey = group.Key;
            if (!baseReferences.TryGetValue(producerKey, out var originals)) continue;
            var proposed = group.ToArray();
            if (originals.Length != 1 || proposed.Length != 1)
            {
                if (!conflicted.Contains(producerKey)) throw Incomplete(producerKey, "ambiguous producer without a conflict");
                continue;
            }
            var original = originals[0]; var desired = proposed[0];
            if (original.ReferenceHash == desired.ReferenceHash) continue;
            if (changes.TryGetValue(producerKey, out var mine) && mine.Length == 1
                && mine[0].BaseReferenceKey == original.Key.ToString() && mine[0].ForeignReferenceKey == desired.Key.ToString()
                && mine[0].Kind == desired.ReferenceKind.ToString() && mine[0].BaseHash == original.ReferenceHash && mine[0].ForeignHash == desired.ReferenceHash)
                paired.Add(producerKey);
            else if (!conflicted.Contains(producerKey)) throw Incomplete(producerKey, "signature change without its change or conflict");
        }
        var unpaired = plan.Changes.FirstOrDefault(c => !paired.Contains(c.ProducerKey));
        if (unpaired != null) throw Incomplete(unpaired.ProducerKey, "change without a matching base/candidate pair");
    }

    /// <summary>The plan on the live module: the half of Analyze that reads the local model, per change of the plan.
    /// Changes already at ForeignHash leave; the others carry the live reference key and hash. The plan's conflicts come
    /// first, then the live ones, with Analyze's codes and texts.</summary>
    public static ReferencePlan Effective(ESpace local, ReferencePlan plan)
    {
        var localReferences = local.References.ToArray();
        var observations = new List<ReferencePlanChange>();
        var conflicts = new List<ReferencePlanConflict>(plan.Conflicts);
        void Conflict(string producer, string code, string message) => conflicts.Add(new(producer, code, message));
        foreach (var change in plan.Changes)
        {
            var producerKey = change.ProducerKey;
            var originalLocalObjects = localReferences.Where(r => r.Key.ToString() == change.BaseReferenceKey).ToArray();
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
            if (current.Key.ToString() != change.BaseReferenceKey || current.ReferenceKind.ToString() != change.Kind)
            {
                Conflict(producerKey, "local-reference-identity-changed", "The local producer changed reference kind or local reference identity."); continue;
            }
            if (current.ReferenceHash != change.BaseHash && current.ReferenceHash != change.ForeignHash)
            {
                Conflict(producerKey, "concurrent-signature", "The local producer signature changed concurrently; its revision cannot be overwritten."); continue;
            }
            observations.Add(change with { LocalReferenceKey = current.Key.ToString(), LocalHash = current.ReferenceHash });
        }
        return new(observations.OrderBy(o => o.ProducerKey, StringComparer.Ordinal).Where(o => o.LocalHash != o.ForeignHash), conflicts);
    }

    /// <summary>Runs the native structural merge and the pending reference selections sequentially inside the caller's
    /// existing Command, revalidating the plan on the live module before each tree (the kernel's helper with its plan
    /// check replaced by Effective). The delegate must synchronously merge the supplied tree. Exceptions must escape the
    /// caller's Command so native rollback restores the complete operation.</summary>
    public static ReferenceSelectionResult MergeInCurrentCommand(ESpace local, ESpace foreign, ESpace basis,
        ReferencePlan plan, Action<MatchTree> mergeTree, bool matchByStructure = false)
    {
        ArgumentNullException.ThrowIfNull(mergeTree);
        var current = RequireNoConflicts(Effective(local, plan));
        var nativeMergeCount = 0; var selectedReferences = 0;
        using (var tree = new MatchTree(local, foreign, basis, matchByStructure, true))
        {
            if (tree.HasConflicts)
                throw new InvalidOperationException("Native merge conflicts must be resolved before merging producer signatures.");
            // Validate every native property before any structural mutation. Selection follows
            // later on explicit roots because ignored metadata may lie below a skipped ancestor.
            ValidatePairs(local, foreign, basis, current, requireReachability: false);
            if (!tree.HasNoDifferences)
            {
                mergeTree(tree);
                if (tree.CanMerge) throw new InvalidOperationException("The native structural merge callback did not merge its tree.");
                nativeMergeCount++;
            }
        }
        current = RequireNoConflicts(Effective(local, plan));
        if (current.HasChanges)
        {
            using var tree = CreateReferenceTree(local, foreign, basis, current);
            var selections = ValidatePairs(local, foreign, basis, current, requireReachability: true);
            // No selection occurs until every observation and pair has passed.
            foreach (var pair in selections) pair.MergeAction = MergeAction.Update;
            selectedReferences = selections.Count;
            mergeTree(tree);
            if (tree.CanMerge) throw new InvalidOperationException("The native reference merge callback did not merge its tree.");
            nativeMergeCount++;
            VerifyRetained(local, plan);
        }
        return new(selectedReferences, nativeMergeCount);
    }

    /// <summary>Read-only postcondition: every reference of the received plan still belongs to the same producer, is
    /// unique, keeps its key and kind, and carries the ForeignHash. Call again after the enclosing SDK Command returns:
    /// its cleanup may roll back after the merge delegate has already completed.</summary>
    public static void VerifyRetained(ESpace local, ReferencePlan plan)
    {
        if (RequireNoConflicts(Effective(local, plan)).HasChanges)
            throw new InvalidOperationException("Native merge did not retain all validated producer signature selections.");
    }

    // Explicit native roots: ReferenceHash is ignored by native Difference, so a module-root tree skips the unchanged
    // parent path. The roots keep the three references in the same merge.
    private static MatchTree CreateReferenceTree(ESpace local, ESpace foreign, ESpace basis, ReferencePlan current)
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

    private static List<PropertyPair> ValidatePairs(ESpace local, ESpace foreign, ESpace basis,
        ReferencePlan current, bool requireReachability)
    {
        var selections = new List<PropertyPair>();
        foreach (var change in current.Changes)
        {
            var localReference = local.References.Single(r => ProducerKey(r) == change.ProducerKey && r.Key.ToString() == change.LocalReferenceKey);
            var foreignReference = foreign.References.Single(r => ProducerKey(r) == change.ProducerKey && r.Key.ToString() == change.ForeignReferenceKey);
            var match = localReference.Match;
            if (match == null || match.LocalObject != localReference || match.ForeignObject != foreignReference || match.Tree.LocalESpace != local)
                throw new InvalidOperationException("Reference signature selection requires the actual merge tree: " + change.ProducerKey);
            if (match.BaseObject != basis.References.Single(r => r.Key.ToString() == change.BaseReferenceKey))
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

    private static string ProducerKey(Reference reference) => reference.ReferenceKey?.ToString() ?? "";

    private static ReferencePlan RequireNoConflicts(ReferencePlan plan)
    {
        if (plan.HasConflicts) throw new InvalidOperationException("Reference signature merge conflicts: "
            + string.Join("; ", plan.Conflicts.Select(c => c.ProducerKey + " [" + c.Code + "]: " + c.Message)));
        return plan;
    }

    private static InvalidOperationException Incomplete(string producerKey, string reason) =>
        new($"{CoverageError} (producer '{producerKey}': {reason})");
}
