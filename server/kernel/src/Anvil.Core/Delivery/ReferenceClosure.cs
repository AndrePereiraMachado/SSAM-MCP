using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>One export of a producer reference of a module (a top-level reference element): name, native type, original key.</summary>
public sealed record ReferencedExport(string Name, string Type, string Key);

/// <summary>One producer reference of a module as the model holds it: label, producer key, kind, ReferenceHash and exports.</summary>
public sealed record ModuleReferenceEntry(string Name, string ProducerKey, string Kind, string Hash, IReadOnlyList<ReferencedExport> Exports);

/// <summary>
/// Family E (fam-deps, 2026-10-12, VisitaCerta_UI "conecte nas telas"): the producer references of a consumer are the kernel's,
/// computed and checked, never left to the live merge. Pure: no model, no bridge, no file.
///
/// R5 (OwnersKeptByBase): a delivery changes the signature of a producer only when it needs something the module does not
/// have. An owner of foreign types (K1-b, captured by key with reason foreign-owner-of) that the base already references
/// with every object the dependent producers use is not linked into the apply: the native refresh of the dependent resolves
/// the foreign type against the existing reference (offline proof C:\t\fam-deps\exp: VisitaCerta_CS + _IS imported into the
/// VisitaCerta_UI base without the (System) capture keep (System) at the base hash 25c9070b, same objects, valid; with it,
/// (System) moves to eee5a39e and the live merge needs a ReferenceHash selection, the path that rolled back three times).
///
/// Check: the closure of the job's `reference` ops in a module (the candidate before the merge, the delivered module after
/// it): each named producer is referenced, has every element the job names, and, when the delivery captured it, at the
/// producer's published signature (the attested capture); and no reference of the base changed its signature unless the
/// delivery named or needed that producer. Every problem at once, each with its cause, the exact references and the fix.
/// </summary>
public static class ReferenceClosure
{
    /// <summary>The candidate does not hold the references the job needs (or changed one it must not): refused before the merge.</summary>
    public const string ClosureRefused = "REFERENCE_CLOSURE_REFUSED";
    /// <summary>The merged module lost a reference (or its signature) the validated candidate had: kept for review after the merge.</summary>
    public const string NotRetained = "REFERENCE_NOT_RETAINED";

    public static bool OrdinalKey(string left, string right) => string.Equals(left, right, StringComparison.Ordinal);

    /// <summary>The inventory as JSON (the SS11 reader answers this shape; Anvil.Core.Odc has no reader).</summary>
    public static IReadOnlyList<ModuleReferenceEntry> FromJson(JsonArray? references)
        => (references ?? new JsonArray()).OfType<JsonObject>().Select(r => new ModuleReferenceEntry(
            r["name"]?.ToString() ?? "", r["producerKey"]?.ToString() ?? "", r["kind"]?.ToString() ?? "", r["hash"]?.ToString() ?? "",
            (r["exports"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(e => new ReferencedExport(
                e["name"]?.ToString() ?? "", e["type"]?.ToString() ?? "", e["key"]?.ToString() ?? "")).ToArray())).ToArray();

    public static JsonArray ToJson(IEnumerable<ModuleReferenceEntry> references)
        => new(references.Select(r => (JsonNode)new JsonObject { ["name"] = r.Name, ["producerKey"] = r.ProducerKey, ["kind"] = r.Kind, ["hash"] = r.Hash,
            ["exports"] = new JsonArray(r.Exports.Select(e => (JsonNode)new JsonObject { ["name"] = e.Name, ["type"] = e.Type, ["key"] = e.Key }).ToArray()) }).ToArray());

    /// <summary>A short summary of an inventory for a receipt (no exports): name, key, hash, export count.</summary>
    public static JsonArray Summary(IEnumerable<ModuleReferenceEntry> references)
        => new(references.Select(r => (JsonNode)new JsonObject { ["name"] = r.Name, ["producerKey"] = r.ProducerKey, ["hash"] = r.Hash, ["exports"] = r.Exports.Count }).ToArray());

    public static bool SameHash(string? left, string? right)
    {
        static string N(string? g) => (g ?? "").Replace("{", "").Replace("}", "").Replace("-", "").Trim().ToLowerInvariant();
        return N(left).Length > 0 && N(left) == N(right);
    }

    /// <summary>R5. The owner bindings (capturedProducers entries with ownerKey) the apply must not link because the base
    /// already references the owner with every object its dependents use, and the report of every owner (kept or linked,
    /// with the reason). The dependents are the captured entries whose foreignDependencies name the owner.</summary>
    public static (IReadOnlyList<string> Kept, JsonArray Report) OwnersKeptByBase(JsonObject captured, IReadOnlyList<ModuleReferenceEntry> basis,
        Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        var kept = new List<string>(); var report = new JsonArray();
        foreach (var (binding, value) in captured)
        {
            if (value is not JsonObject owner || owner["ownerKey"]?.ToString() is not { Length: > 0 } ownerKey) continue;
            var needed = new List<string>();
            foreach (var dependent in captured.Select(p => p.Value).OfType<JsonObject>())
                foreach (var (o, objects) in Delivery.OwnerGroups(dependent["foreignDependencies"] as JsonArray))
                    if (same(o, ownerKey)) needed.AddRange(objects.Where(x => !needed.Contains(x, StringComparer.Ordinal)));
            var reference = basis.FirstOrDefault(r => r.ProducerKey.Length > 0 && same(r.ProducerKey, ownerKey));
            var missing = reference == null ? needed : needed.Where(n => !reference.Exports.Any(e => e.Key.Length > 0 && same(e.Key, n))).ToList();
            var keep = reference != null && missing.Count == 0;
            if (keep) kept.Add(binding);
            report.Add(new JsonObject
            {
                ["binding"] = binding, ["producer"] = owner["producer"]?.DeepClone(), ["key"] = ownerKey, ["reason"] = owner["reason"]?.DeepClone(),
                ["linked"] = !keep, ["baseHash"] = reference?.Hash, ["capturedHash"] = owner["signatureHash"]?.DeepClone(),
                ["needed"] = new JsonArray(needed.Select(n => (JsonNode)n).ToArray()),
                ["why"] = keep ? "the module already references " + Label(owner, ownerKey) + " with every object its dependents use: its signature stays as it is (R5)"
                    : reference == null ? "the module does not reference " + Label(owner, ownerKey) + " yet: its capture creates the reference"
                    : "the module's reference of " + Label(owner, ownerKey) + " lacks " + string.Join(", ", missing.Select(m => "@" + m)) + ": its capture adds them",
            });
        }
        return (kept, report);
    }

    private static string Label(JsonObject entry, string key) => entry["producer"]?.ToString() is { Length: > 0 } name ? name : "the producer with key " + key;

    /// <summary>What the job's `reference` ops name, by producer binding (composite jobs included), in job order.</summary>
    public static IReadOnlyList<(string Producer, IReadOnlyList<string> Elements)> ReferenceOps(string jobPath)
    {
        var found = new List<(string Producer, List<string> Elements)>(); var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        Visit(Path.GetFullPath(jobPath));
        return found.Select(f => (f.Producer, (IReadOnlyList<string>)f.Elements)).ToArray();
        void Visit(string file)
        {
            if (!visited.Add(file) || !file.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) return;
            JsonNode? node;
            try { node = JsonNode.Parse(File.ReadAllText(file)); } catch (System.Text.Json.JsonException) { return; }
            var dir = Path.GetDirectoryName(file)!;
            if (node is JsonObject obj)
                foreach (var part in obj["jobs"] as JsonArray ?? new JsonArray())
                    if (part?.ToString() is { Length: > 0 } partPath) Visit(JobRunner.ResolveJobFile(partPath, dir));
            foreach (var op in (node is JsonArray array ? array : node?["ops"] as JsonArray) ?? new JsonArray())
            {
                if (op?["op"]?.ToString() != "reference" || op["producer"]?.ToString() is not { Length: > 0 } producer) continue;
                var entry = found.FirstOrDefault(f => JobSources.SameProducer(f.Producer, producer));
                if (entry.Elements == null) found.Add(entry = (producer, new List<string>()));
                foreach (var element in op["elements"] as JsonArray ?? new JsonArray())
                    if (element?.ToString() is { Length: > 0 } text && !entry.Elements.Contains(text, StringComparer.Ordinal)) entry.Elements.Add(text);
            }
        }
    }

    /// <summary>One producer the job names: its binding, the key and published signature hash when the delivery knows them
    /// (a capture), and the elements (Type:Name, Name or Type:@key).</summary>
    public sealed record Expectation(string Binding, string? ProducerKey, string? PublishedHash, IReadOnlyList<string> Elements, string? ProducerName = null);

    /// <summary>The expectations of a delivery: every producer of the job's reference ops, with the key and the published hash
    /// of its capture (capturedProducers) or of its bound signature (boundKeys: binding -> (key, hash)).</summary>
    public static IReadOnlyList<Expectation> Expectations(IReadOnlyList<(string Producer, IReadOnlyList<string> Elements)> ops, JsonObject? captured,
        IReadOnlyDictionary<string, (string Key, string? Hash)>? bound = null)
    {
        var list = new List<Expectation>();
        foreach (var (producer, elements) in ops)
        {
            var entry = captured?.FirstOrDefault(p => JobSources.SameProducer(p.Key, producer)).Value as JsonObject;
            if (entry != null)
            {
                list.Add(new(producer, entry["key"]?.ToString(), entry["signatureHash"]?.ToString(), elements, entry["producer"]?.ToString()));
                continue;
            }
            if (bound != null && bound.FirstOrDefault(b => JobSources.SameProducer(b.Key, producer)) is { Key: not null } b)
            {
                list.Add(new(producer, b.Value.Key, b.Value.Hash, elements));
                continue;
            }
            list.Add(new(producer, null, null, elements));
        }
        return list;
    }

    /// <summary>The reference a module holds for an expectation: by producer key when known, else by label (the binding or
    /// the producer name).</summary>
    public static ModuleReferenceEntry? Find(Expectation expected, IReadOnlyList<ModuleReferenceEntry> module, Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        if (expected.ProducerKey is { Length: > 0 } key)
            return module.FirstOrDefault(r => r.ProducerKey.Length > 0 && same(r.ProducerKey, key));
        return module.FirstOrDefault(r => string.Equals(r.Name, expected.Binding, StringComparison.OrdinalIgnoreCase)
            || expected.ProducerName != null && string.Equals(r.Name, expected.ProducerName, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Whether a reference holds a job element: Type:@key or @key by original key, Type:Name or Name by export name.</summary>
    public static bool Holds(ModuleReferenceEntry reference, string element, Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        var colon = element.IndexOf(':');
        var tail = colon >= 0 ? element[(colon + 1)..] : element;
        if (tail.StartsWith('@')) return reference.Exports.Any(e => e.Key.Length > 0 && same(e.Key, tail[1..]));
        // A qualified name (Flow\Block) is held by its last segment, the name the export carries.
        var name = tail.Contains('\\') ? tail[(tail.LastIndexOf('\\') + 1)..] : tail.Contains('/') ? tail[(tail.LastIndexOf('/') + 1)..] : tail;
        return reference.Exports.Any(e => string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The references the candidate changes against the base: new references and existing ones whose signature
    /// moved, each {producer, key, baseHash (null when new), candidateHash, exportsAdded}. Informational for the receipt.</summary>
    public static JsonArray Changed(IReadOnlyList<ModuleReferenceEntry> basis, IReadOnlyList<ModuleReferenceEntry> candidate, Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        var changed = new JsonArray();
        foreach (var reference in candidate)
        {
            var original = basis.FirstOrDefault(b => b.ProducerKey.Length > 0 && same(b.ProducerKey, reference.ProducerKey));
            var added = reference.Exports.Count(e => original == null || !original.Exports.Any(o => o.Key.Length > 0 && same(o.Key, e.Key)));
            if (original != null && SameHash(original.Hash, reference.Hash) && added == 0) continue;
            changed.Add(new JsonObject { ["producer"] = reference.Name, ["key"] = reference.ProducerKey, ["baseHash"] = original?.Hash,
                ["candidateHash"] = reference.Hash, ["exportsAdded"] = added, ["signatureChanges"] = original != null && !SameHash(original.Hash, reference.Hash) });
        }
        return changed;
    }

    /// <summary>Before the merge: the candidate holds every producer the job names (when its key is known), at the published
    /// signature of its capture; and no reference of the base changed its signature unless its producer is named by the job
    /// or is an owner the delivery needed (<paramref name="mayChange"/>): any other change is collateral (R5) and would send
    /// the live merge down the ReferenceHash selection path. Elements are the import's to check (it refuses a missing one
    /// with its fix, ProducerSignatureMissing), so this reads keys and hashes only.</summary>
    public static JsonArray CheckCandidate(IReadOnlyList<Expectation> expected, IReadOnlyList<ModuleReferenceEntry> candidate,
        IReadOnlyList<ModuleReferenceEntry> basis, IReadOnlyCollection<string> mayChange, Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        var problems = new JsonArray();
        foreach (var e in expected)
        {
            var label = e.ProducerName ?? e.Binding;
            var reference = Find(e, candidate, same);
            if (reference == null)
            {
                // Without a key the reference is looked up by label, which an alias can change: nothing to decide then.
                if (e.ProducerKey is { Length: > 0 })
                    problems.Add(Problem("missing", label, e.ProducerKey, null, $"The candidate has no reference of {label}, which the job's reference op names.",
                        $"Check that {label} is published and referenceable in this environment (o11_environment referenceable), then deliver again.", ReferencePatch(e)));
                continue;
            }
            if (!string.IsNullOrWhiteSpace(e.PublishedHash) && !SameHash(reference.Hash, e.PublishedHash))
                problems.Add(Problem("outdated", label, reference.ProducerKey, null,
                    $"The candidate references {label} at {reference.Hash}; the published {label} is {e.PublishedHash}.",
                    $"Bring {label} to its published signature with the Studio's own Manage Dependencies (o11_studio refresh-references {{producers:[\"{label}\"], published:true}}) and deliver again; if {label} has unpublished changes, publish it first.",
                    ReferencePatch(e), expectedHash: e.PublishedHash, actualHash: reference.Hash));
        }
        foreach (var reference in candidate)
        {
            var original = basis.FirstOrDefault(b => b.ProducerKey.Length > 0 && same(b.ProducerKey, reference.ProducerKey));
            if (original == null || SameHash(original.Hash, reference.Hash)) continue;
            if (mayChange.Any(k => same(k, reference.ProducerKey))) continue;
            if (expected.Any(x => x.ProducerKey is { Length: > 0 } k ? same(k, reference.ProducerKey)
                : string.Equals(x.Binding, reference.Name, StringComparison.OrdinalIgnoreCase))) continue;
            problems.Add(Problem("collateral", reference.Name, reference.ProducerKey, null,
                $"The candidate changes the signature of {reference.Name} ({original.Hash} -> {reference.Hash}), which the job does not name and no "
                + "named producer needs: the live merge would have to select that signature, the path that rolls back.",
                $"The job is right (SSAM defect, reported). Refresh {reference.Name} in the Studio (o11_studio refresh-references {{producers:[\"{reference.Name}\"]}}) "
                + $"so the module already has that signature, then deliver the same job again; if the Studio says {reference.Name} is up to date, bring it to its published signature with the Studio's own Manage Dependencies "
                + $"(o11_studio refresh-references {{producers:[\"{reference.Name}\"], published:true}}), which also covers an Extension (its signature comes from its extension reference, never from an OML), then deliver the same job again.",
                null, expectedHash: original.Hash, actualHash: reference.Hash, ssamDefect: true));
        }
        return problems;
    }

    /// <summary>After the merge: every reference the delivery changed or named (<paramref name="watched"/>: producer keys) is
    /// in the merged module with the candidate's signature and every export the candidate had (by original key). Class E of
    /// the publication diagnosis: a producer element the delivery uses must resolve in the merged module, at the signature
    /// that was validated; nothing may stay outdated.</summary>
    public static JsonArray CheckDelivered(IReadOnlyList<ModuleReferenceEntry> candidate, IReadOnlyList<ModuleReferenceEntry> delivered,
        IReadOnlyCollection<string> watched, Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        var problems = new JsonArray();
        foreach (var want in candidate.Where(c => c.ProducerKey.Length > 0 && watched.Any(k => same(k, c.ProducerKey))))
        {
            var got = delivered.FirstOrDefault(d => d.ProducerKey.Length > 0 && same(d.ProducerKey, want.ProducerKey));
            if (got == null)
            {
                problems.Add(Problem("not-retained", want.Name, want.ProducerKey, null,
                    $"The merged module has no reference of {want.Name}; the validated candidate had it at {want.Hash}.",
                    $"Ctrl+Z in the Studio undoes the merge (nothing was published); deliver again: the delivery creates the reference of {want.Name}.", null,
                    expectedHash: want.Hash));
                continue;
            }
            if (!SameHash(got.Hash, want.Hash))
                problems.Add(Problem("not-retained", want.Name, want.ProducerKey, null,
                    $"The merged module references {want.Name} at {got.Hash}; the validated candidate had {want.Hash}.",
                    $"Ctrl+Z in the Studio undoes the merge (nothing was published); refresh the references of {want.Name} (o11_studio refresh-references) and deliver again.",
                    null, expectedHash: want.Hash, actualHash: got.Hash));
            var lost = want.Exports.Where(e => e.Key.Length > 0 && !got.Exports.Any(g => g.Key.Length > 0 && same(g.Key, e.Key))).ToList();
            if (lost.Count > 0)
                problems.Add(Problem("not-retained", want.Name, want.ProducerKey, string.Join(", ", lost.Select(l => l.Name)),
                    $"The merged module's reference of {want.Name} lacks {string.Join(", ", lost.Select(l => l.Name + " (@" + l.Key + ")"))}, which the validated candidate had.",
                    $"Ctrl+Z in the Studio undoes the merge (nothing was published); deliver again with the same reference op.", null));
        }
        return problems;
    }

    private static JsonObject Problem(string cause, string producer, string? key, string? element, string message, string fix, JsonObject? patch,
        string? expectedHash = null, string? actualHash = null, bool ssamDefect = false)
    {
        var problem = new JsonObject { ["code"] = cause is "not-retained" ? NotRetained : ClosureRefused, ["severity"] = "error", ["cause"] = cause,
            ["producer"] = producer, ["key"] = key, ["element"] = element, ["message"] = message, ["fix"] = fix, ["patch"] = patch };
        if (expectedHash != null) problem["expectedHash"] = expectedHash;
        if (actualHash != null) problem["actualHash"] = actualHash;
        if (ssamDefect) problem["ssamDefect"] = true;
        return problem;
    }

    /// <summary>The reference op ready to deliver for an expectation (the closure the job needs of that producer).</summary>
    private static JsonObject? ReferencePatch(Expectation e) => e.Elements.Count == 0 ? null : new JsonObject
    {
        ["op"] = "reference", ["producer"] = e.Binding, ["elements"] = new JsonArray(e.Elements.Select(x => (JsonNode)x).ToArray()),
    };

    /// <summary>The producer signature changes of a merge receipt (referenceSignatures.Changes or .changes), each named:
    /// {producer, key, baseHash, candidateHash, namedByJob}. Names come from the captures, then from the base inventory.</summary>
    public static JsonArray SignatureChanges(JsonNode? referenceSignatures, JsonObject? captured, IReadOnlyCollection<string> namedKeys,
        IReadOnlyList<ModuleReferenceEntry>? basis = null, Func<string, string, bool>? sameKey = null)
    {
        var same = sameKey ?? OrdinalKey;
        var changes = new JsonArray();
        var list = referenceSignatures?["Changes"] as JsonArray ?? referenceSignatures?["changes"] as JsonArray ?? new JsonArray();
        foreach (var change in list.OfType<JsonObject>())
        {
            var key = (change["ProducerKey"] ?? change["producerKey"])?.ToString() ?? "";
            var entry = captured?.Select(p => p.Value).OfType<JsonObject>().FirstOrDefault(c => c["key"]?.ToString() is { Length: > 0 } k && same(k, key));
            var name = entry?["producer"]?.ToString() ?? basis?.FirstOrDefault(b => same(b.ProducerKey, key))?.Name ?? key;
            changes.Add(new JsonObject
            {
                ["producer"] = name, ["key"] = key,
                ["baseHash"] = (change["BaseHash"] ?? change["baseHash"])?.ToString(), ["candidateHash"] = (change["ForeignHash"] ?? change["foreignHash"])?.ToString(),
                ["namedByJob"] = namedKeys.Any(k => same(k, key)),
                ["owner"] = entry?["ownerKey"] != null,
            });
        }
        return changes;
    }

    /// <summary>"(System) 25c9070b -> eee5a39e (not named by the job)", one per change.</summary>
    public static string Describe(JsonArray changes)
        => string.Join("; ", changes.OfType<JsonObject>().Select(c => c["producer"] + " " + Short(c["baseHash"]?.ToString()) + " -> " + Short(c["candidateHash"]?.ToString())
            + (c["namedByJob"]?.GetValue<bool>() == true ? " (named by the job)" : c["owner"]?.GetValue<bool>() == true ? " (owner of foreign types, not named by the job)" : " (not named by the job)")));

    private static string Short(string? hash) => string.IsNullOrEmpty(hash) ? "?" : hash.Length > 8 ? hash[..8] : hash;
}
