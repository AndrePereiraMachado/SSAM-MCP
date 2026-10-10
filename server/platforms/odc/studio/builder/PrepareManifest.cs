using System.Text.Json;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;

// A candidate built by another frontend uses the same manifest and native gates as a C# feature.
// Identity comes ONLY from a hash-checked snapshot sidecar, never from the catalog or defaults.
internal static class PrepareManifest {
    // The CLI form: the manifest path is the one line of stdout the facade reads (lib.mjs builder).
    public static int Run(string[] args, string root) { Console.WriteLine(Prepare(args, root)); return 0; }

    // One manifest request, in a cold process or in the resident builder (ManifestServer, C02 item 2): the manifest path, or
    // the refusal as an exception, as before.
    public static string Prepare(string[] args, string root) {
        var start = DateTimeOffset.UtcNow;
        Manifest? manifest = null;
        string? output = null;
        Exception? failure = null;
        try {
            var options = new Dictionary<string, string>();
            for (var i = 0; i < args.Length; i++) {
                var key = args[i];
                Require(key is "--base" or "--candidate" or "--output" or "--feature" or "--owners" or "--changes", "Unknown manifest option: " + key);
                Require(++i < args.Length && !args[i].StartsWith("--"), "Missing value for " + key);
                Require(options.TryAdd(key, args[i]), "Duplicate option: " + key);
            }
            string Need(string key) => options.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException(key + " is required.");
            var basisPath = Path.GetFullPath(Need("--base"));
            var candidatePath = Path.GetFullPath(Need("--candidate"));
            output = Path.GetFullPath(Need("--output"));
            Require(!Directory.Exists(output) && !File.Exists(output), "Use a new output directory; evidence is never overwritten.");
            Require(!Path.GetFileName(candidatePath).StartsWith("DO-NOT", StringComparison.OrdinalIgnoreCase), "DO-NOT-DELIVER candidates never enter delivery.");
            var owners = JsonSerializer.Deserialize<string[]>(Need("--owners"));
            var changes = JsonSerializer.Deserialize<string[]>(Need("--changes"));
            Require(owners is { Length: > 0 } && owners.All(s => !string.IsNullOrWhiteSpace(s)), "owners must be a non-empty array of names.");
            Require(changes is { Length: > 0 } && changes.All(s => !string.IsNullOrWhiteSpace(s)), "changes must be a non-empty array of descriptions.");
            using var metadata = JsonDocument.Parse(File.ReadAllText(basisPath + ".json"));
            var snapshot = metadata.RootElement;
            string Field(string key) => snapshot.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
                ? value.GetString()! : throw new InvalidOperationException("Snapshot metadata requires " + key + "; capture a new snapshot.");
            Require(snapshot.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True, "Snapshot metadata does not describe a successful capture.");
            var basisBytes = File.ReadAllBytes(basisPath);
            var candidateBytes = File.ReadAllBytes(candidatePath);
            var basisHash = Manifest.Hash(basisBytes);
            Require(string.Equals(basisHash, Field("sha256"), StringComparison.OrdinalIgnoreCase), "Captured base changed on disk; capture a new snapshot and rebuild.");
            var captured = Field("capturedAt");
            Require(DateTimeOffset.TryParse(captured, out var capturedAt) && capturedAt <= DateTimeOffset.UtcNow.AddMinutes(1), "Invalid snapshot capturedAt; capture a new snapshot.");
            manifest = new Manifest {
                Feature = Need("--feature"), Module = Field("module"), ModuleKey = Field("moduleKey"),
                Tenant = Field("host"), Author = Field("developerId"), BasePath = basisPath,
                BaseSha256 = basisHash, BaseCapturedAt = captured, CandidatePath = Path.Combine(output, "candidate.oml"),
                CandidateSha256 = Manifest.Hash(candidateBytes), Owners = owners!, Changes = changes!,
                EvidenceDir = Path.Combine(output, "evidence"), BuilderReceipt = Path.Combine(output, "builder-receipt.json")
            };
            manifest.RequireFreshBase();
            var receipt = Anvil.Core.CandidateReceipt.Read(candidatePath);
            // B1 (C02): the kernel already loaded this base, applied the job, ran the Verify and judged every new message; its
            // receipt beside the candidate proves it for exactly these two files (outSha256 of the candidate, baseSha256 of the
            // capture, accepted and valid, something created or changed). Loading both models again (Loader configuration,
            // two loads and a reflection diff: 8 to 12 s per delivery) would only repeat it, so the manifest is written from
            // the receipt and the OML headers. The bridge still proves the merge natively (added errors, conflicts, empty
            // merge) before CompareAndMerge. A C# feature, an external candidate and any receipt that does not match take
            // the model path below, as always.
            var fast = Anvil.Core.CandidateReceipt.FastPath(receipt, manifest.CandidateSha256, basisHash, manifest.Author);
            var headers = fast.Applies ? (Base: OmlHeader.Read(basisBytes), Candidate: OmlHeader.Read(candidateBytes)) : default;
            var sameModule = fast.Applies && headers.Base is { } bh && headers.Candidate is { } ch
                && bh.Key == manifest.ModuleKey && ch.Key == manifest.ModuleKey && bh.Name == manifest.Module && ch.Name == manifest.Module;
            if (sameModule) {
                return Write(output, manifest, candidateBytes, new {
                    ok = true, source = "external-candidate", path = "kernel-receipt", manifest.Module, manifest.ModuleKey, manifest.Tenant, manifest.Author,
                    manifest.BaseSha256, manifest.CandidateSha256, addedErrors = Array.Empty<string>(), addedWarnings = Array.Empty<string>(),
                    acceptedWarnings = Array.Empty<string>(), kernelReceipt = true,
                    change = new { added = fast.Created, removed = 0, changedProperties = fast.Changed, stamped = 0, authored = 0, sample = FootprintSample(receipt), from = "kernel footprint" },
                    publishInvoked = false, liveMergeInvoked = false, elapsedMs = (long)(DateTimeOffset.UtcNow - start).TotalMilliseconds, completedAt = DateTimeOffset.UtcNow
                });
            }
            var services = Services(manifest.Author);
            using var basis = services.LoadESpace(basisBytes, loadFlags: LoadFlags.SkipUpgrades, developerId: manifest.Author);
            using var candidate = services.LoadESpace(candidateBytes, loadFlags: LoadFlags.SkipUpgrades, developerId: manifest.Author);
            Require(basis.Key.ToString() == manifest.ModuleKey && candidate.Key.ToString() == manifest.ModuleKey && basis.Name == manifest.Module && candidate.Name == manifest.Module,
                "Module identity mismatch: expected " + manifest.Module + " (" + manifest.ModuleKey + "), base " + basis.Name + " (" + basis.Key + "), candidate " + candidate.Name + " (" + candidate.Key + ").");
            // One Verify per side (the four calls of before read each model twice).
            var basisMessages = Messages(basis); var candidateMessages = Messages(candidate);
            var addedErrors = candidateMessages.Errors.Except(basisMessages.Errors).ToArray();
            var addedWarnings = candidateMessages.Warnings.Except(basisMessages.Warnings).ToArray();
            Require(addedErrors.Length == 0, "Candidate introduces validation errors: " + string.Join(" | ", addedErrors));
            // One policy with the kernel (I10, A03): the warnings the kernel judged (kernel-result.json beside a kernel candidate,
            // checked by sha256) pass; without that receipt only the security warnings (SecurityWarnings.IsSecurity) are
            // refused and every other new warning is accepted (acceptedWarnings in the builder receipt).
            var judged = Anvil.Core.CandidateReceipt.Judge(receipt, Manifest.Hash(candidateBytes), addedWarnings);
            Require(judged.Refused.Count == 0, "Candidate introduces security warnings"
                + (judged.Applies ? " the kernel's policy did not accept (fix them, or declare them in expectedMessages with why)" : judged.Reason != null ? " (" + judged.Reason + ")" : " (fix them)")
                + ": " + string.Join(" | ", judged.Refused));
            // What the candidate changes is read from the two models, never guessed from audit stamps: the Model API stamps
            // merge units (entities, actions, screens) and new elements, not a property set on an existing child, so a
            // default value, a description or a style sheet set on an existing element changes no stamp at all (QuizLiveWeb
            // and a client app, 2026-10: four real changes refused as "no change").
            var change = CandidateChange.Between(basis, candidate, manifest.Author);
            // The stamps still say WHO built the candidate: when it stamps anything, one stamp is the snapshot author (a
            // candidate built under another identity is rebuilt, never merged). An unstamped edit carries no identity.
            Require(change.Stamped == 0 || change.Authored > 0 || change.Removed > 0,
                "No change carries the snapshot author and nothing was deleted; rebuild with the snapshot developerId (studio_deliver does this automatically).");
            // C09: the kernel's receipt of these two files says what it created and changed; a candidate it changed is never
            // "no change" here (the bridge's merge still refuses a merge with no difference natively).
            Require(change.Added > 0 || change.Removed > 0 || change.Properties > 0 || fast.Created + fast.Changed > 0 && fast.SameFiles,
                "Candidate equals the live module " + manifest.Module + " (snapshot " + basisHash[..12] + "): no element added, removed or changed. "
                + "The module already has what the job asks for; nothing to deliver.");
            return Write(output, manifest, candidateBytes, new {
                ok = true, source = "external-candidate", path = "model", manifest.Module, manifest.ModuleKey, manifest.Tenant, manifest.Author,
                manifest.BaseSha256, manifest.CandidateSha256, addedErrors, addedWarnings, acceptedWarnings = judged.Accepted, kernelReceipt = judged.Applies,
                kernelReceiptFastPath = fast.Reason,
                change = new { added = change.Added, removed = change.Removed, changedProperties = change.Properties, stamped = change.Stamped, authored = change.Authored, sample = change.Sample },
                publishInvoked = false, liveMergeInvoked = false, elapsedMs = (long)(DateTimeOffset.UtcNow - start).TotalMilliseconds, completedAt = DateTimeOffset.UtcNow
            });
        } catch (Exception error) { failure = error; throw; }
        finally {
            new Journal(Path.Combine(root, "journal", "operations.jsonl")).Append(new Journal.Entry(
                start.ToString("o"), DateTimeOffset.UtcNow.ToString("o"), "builder-" + Environment.ProcessId,
                "builder", "manifest", manifest?.Module, manifest?.ModuleKey, manifest?.BaseSha256, manifest?.CandidateSha256,
                null, null, Journal.Outcome(failure, false), failure == null ? "none" : Journal.Gate(failure.Message),
                output, failure?.Message, "live", manifest?.Feature));
        }
    }
    // The first ten elements of the kernel's footprint (I14: created and changed, each {kind, name, path}), as the model path
    // samples its changes: "+Kind:Name" created, "Kind:Name" changed.
    private static string[] FootprintSample(System.Text.Json.Nodes.JsonObject? receipt) {
        var footprint = (receipt?["data"] as System.Text.Json.Nodes.JsonObject ?? receipt)?["footprint"];
        string Line(System.Text.Json.Nodes.JsonNode? e, string mark) => mark + e?["kind"] + ":" + e?["name"];
        return (footprint?["created"] as System.Text.Json.Nodes.JsonArray ?? new()).Select(e => Line(e, "+"))
            .Concat((footprint?["changed"] as System.Text.Json.Nodes.JsonArray ?? new()).Select(e => Line(e, "")))
            .Take(10).ToArray();
    }

    private static readonly object LoaderGate = new();
    private static bool _configured;

    // The Model API takes its configuration once per process, before anything touches Loader.ModelServicesInstance
    // (SetConfiguration throws after that): the first model path of the process configures it, every later request of the
    // same process (a resident builder, the tests) reuses it. Each load passes its own request's author, which is what
    // stamps a model (the configured id is only the default).
    internal static IModelServices Services(string author) {
        lock (LoaderGate) {
            if (!_configured) {
                try { Loader.SetConfiguration(new Configuration { DeveloperId = author, StorageStrategy = FileStorageStrategy.InMemory, UseSharedCache = false }); }
                catch (InvalidOperationException) { /* the host process configured it first; ModelServicesInstance says if it cannot serve */ }
                _configured = true;
            }
        }
        var services = Loader.ModelServicesInstance;
        Anvil.Core.OdcModelPlugins.Register(services); // a Mobile UI app requires MobileUI: from the ODC Studio's plugin cache
        return services;
    }

    // Claims a new attempt atomically (concurrent requests cannot overwrite each other's evidence), then writes the candidate,
    // the builder receipt and the manifest; answers the manifest's path.
    private static string Write(string output, Manifest manifest, byte[] candidateBytes, object builderReceipt) {
        Directory.CreateDirectory(output);
        using (new FileStream(Path.Combine(output, ".manifest-attempt"), FileMode.CreateNew)) { }
        using (var stream = new FileStream(manifest.CandidatePath, FileMode.CreateNew)) stream.Write(candidateBytes);
        File.WriteAllText(manifest.BuilderReceipt!, JsonSerializer.Serialize(builderReceipt, Manifest.Json));
        var manifestPath = Path.Combine(output, "manifest.json");
        using (var stream = new FileStream(manifestPath, FileMode.CreateNew)) JsonSerializer.Serialize(stream, manifest, Manifest.Json);
        return manifestPath;
    }
    private static (string[] Errors, string[] Warnings) Messages(IESpace model) {
        var all = model.GetValidationMessages().Select(m => (Error: m.Type.ToString() == "Error", Text: m.Owner.Key + "|" + m.Id + "|" + m.Message + "|" + m.Detail)).ToArray();
        return (all.Where(m => m.Error).Select(m => m.Text).ToArray(), all.Where(m => !m.Error).Select(m => m.Text).ToArray());
    }
    internal static string? Value(IModelObject node, string property) {
        try { return node.Descriptor.Properties.SingleOrDefault(p => p.Name == property)?.GetValue(node)?.ToString(); }
        catch { return null; }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}

// The difference between the live base and a candidate, element by element (ObjectKey): elements added and removed and,
// for each element present in both, the readable value of every property (a getter that throws on either side is
// skipped). Stamped: elements that are new with an audit stamp or whose LastModifiedDate changed; Authored: those of
// them stamped by the snapshot author. The same two files always give the same counts.
// C09: the module itself (the root) is compared too: a property of the ESpace (DefaultScreen, lab 27 of 2026-10-07) is a
// change like any other, while its own audit stamps (LastModified*) are not. A value that is a model object is compared by
// its key, never by its text. A name that cannot be read (DisplayName throws: "Duplicated object Block1", lab 20) is
// written as kind and key.
internal sealed record CandidateChange(int Added, int Removed, int Properties, int Stamped, int Authored, string[] Sample) {
    public static CandidateChange Between(IModelObject basis, IModelObject candidate, string author) {
        var before = Nodes(basis).ToDictionary(n => n.Key.ToString()!);
        var after = Nodes(candidate).ToArray();
        var afterKeys = after.Select(n => n.Key.ToString()!).ToHashSet();
        int added = 0, properties = 0, stamped = 0, authored = 0;
        var notes = new List<string>();
        void Note(string text) => notes.Add(text);
        foreach (var node in after) {
            var by = PrepareManifest.Value(node, "LastModifiedBy");
            var stamp = PrepareManifest.Value(node, "LastModifiedDate");
            if (!before.TryGetValue(node.Key.ToString()!, out var old)) {
                added++; Note("+" + node.GetType().Name + ":" + SafeName(node));
                if (by != null || stamp != null) { stamped++; if (by == author) authored++; }
                continue;
            }
            if (stamp != null && stamp != PrepareManifest.Value(old, "LastModifiedDate")) { stamped++; if (by == author) authored++; }
            if (old.GetType() != node.GetType()) { properties++; Note(node.GetType().Name + ":" + SafeName(node) + " (kind)"); continue; }
            var root = ReferenceEquals(node, candidate);
            foreach (var property in node.Descriptor.Properties) {
                if (root && property.Name.StartsWith("LastModified", StringComparison.Ordinal)) continue;
                string? was, now;
                try { was = Render(property.GetValue(old)); now = Render(property.GetValue(node)); }
                catch { continue; }
                if (was == now) continue;
                properties++; Note(node.GetType().Name + ":" + SafeName(node) + "." + property.Name);
            }
        }
        // The model's child order is not stable between loads: the sample is the first ten in ordinal order.
        return new(added, before.Keys.Count(key => !afterKeys.Contains(key)), properties, stamped, authored,
            notes.Order(StringComparer.Ordinal).Take(10).ToArray());
    }

    // The root and every descendant (ModelPath.Descendants starts at the children).
    internal static IEnumerable<IModelObject> Nodes(IModelObject root) => ModelPath.Descendants(root).Prepend(root);

    // A model object by its key (its text may be the same for two elements, or change with a rename); anything else by text.
    internal static string? Render(object? value) => value is IModelObject o ? "key:" + o.Key : value?.ToString();

    internal static string SafeName(IModelObject node) {
        try { return node.DisplayName; }
        catch { string key; try { key = node.Key?.ToString() ?? "?"; } catch { key = "?"; } return node.GetType().Name + "#" + key; }
    }
}

// The identity an OML carries in its header, read without loading the model: "OML", a 32-bit little-endian length, then
// text records separated by '|' (11.0.415.100|13.1431.3.60000|155|<module key>|<version key>|True|<module name>|...).
// Null when the bytes do not have that shape: the caller then loads the model, as before.
internal static class OmlHeader {
    public sealed record Identity(string Key, string Name);
    public static Identity? Read(byte[] bytes) {
        if (bytes.Length < 8 || bytes[0] != (byte)'O' || bytes[1] != (byte)'M' || bytes[2] != (byte)'L') return null;
        var length = BitConverter.ToInt32(bytes, 3);
        if (length <= 0) return null;
        var end = (int)Math.Min(bytes.Length, 7 + (long)length);
        var stop = 7;
        while (stop < end && bytes[stop] >= 0x20 && bytes[stop] != 0x7F) stop++;
        string text;
        try { text = new System.Text.UTF8Encoding(false, true).GetString(bytes, 7, stop - 7); } catch { return null; }
        var fields = text.Split('|');
        if (fields.Length < 7 || string.IsNullOrWhiteSpace(fields[3]) || string.IsNullOrWhiteSpace(fields[6])) return null;
        return new Identity(fields[3], fields[6]);
    }
}
