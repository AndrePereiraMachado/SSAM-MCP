using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;

// ODC3 candidate builder, step 3 of the cycle. Runs headless in its own process, never inside the Studio.
// Usage: ODC3.Builder list
//        ODC3.Builder <feature> <base.oml> <baseSha256> <new-output-directory> [--smoke] [--module <Name>] [--producer <producer.oml>]
//        ODC3.Builder new <feature> <new-output-directory> [--module <Name>] [--producer <producer.oml>]
// Module key, tenant and author are resolved from snapshots\modules.json unless the feature overrides them.
// Reads <base.oml>.json when present (written by the bridge snapshot command) to carry the capture time.
// Writes <Module>-candidate.oml, manifest.json, builder-receipt.json and feature-checks.json.
// --smoke skips Apply and names the candidate DO-NOT-DELIVER-*, proving only the pipeline.
// --producer loads a producer model read-only in the same services, for features that add a dependency.
// "new" creates the module headlessly (native CreateESpace) for an INewModule feature; the candidate is a
// whole module, uploaded by the bridge command "create" as a new asset of the tenant.
internal static class Program {
    // The installed ODC Studio, the folder the builder has always loaded its Studio assemblies from.
    private const string InstalledStudio = @"C:\Program Files\OutSystems\ODC Studio\ODC Studio";

    public static int Main(string[] args) {
        // A PRIMEIRA linha do stderr e a unica que a fachada le -- lib.mjs faz
        // `stderr.trim().split(/\r?\n/).find(Boolean)`. Escrevia-se aqui a excepcao inteira, e a primeira linha
        // calhava ser o envelope da ESpaceTransactionsManager ou uma TargetInvocationException: o agente recebia
        // trinta linhas de stack do OutSystems.Model e zero informacao, e tinha de reexecutar o DLL a mao so para
        // ver a causa. Agora a primeira linha e a causa, com a frame que e nossa; o resto vai a seguir, intacto,
        // para quem estiver a ler a consola.
        try {
            // One folder, chosen before any Studio type is touched; an assembly it lacks is never looked up elsewhere.
            var studio = StudioDirectory();
            AssemblyLoadContext.Default.Resolving += (context, name) => {
                var path = Path.Combine(studio, name.Name + ".dll");
                return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
            };
            return Run(args);
        }
        catch (Exception error) {
            Console.Error.WriteLine(ExceptionText.Text(error));
            var nossa = ExceptionText.PrimeiraFrameNossa(error);
            if (nossa != null) Console.Error.WriteLine(nossa);
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    // The ODC Studio this process binds, with the kernel's rule (StudioAssembliesOdc.DefaultDirectory and Bind):
    // ANVIL_ODC_STUDIO_DIR when set, and then it must be an ODC Studio folder or the process stops here, never falling
    // back to the installation; unset, the installed ODC Studio, as before. The value must be absolute: the reader runs
    // in its own cache folder, where a relative path would name another folder than the one the facade hashed.
    private static string StudioDirectory() {
        var configured = Environment.GetEnvironmentVariable("ANVIL_ODC_STUDIO_DIR");
        if (configured == null) return InstalledStudio;
        if (string.IsNullOrWhiteSpace(configured) || !Path.IsPathFullyQualified(configured)
            || !File.Exists(Path.Combine(configured, "OutSystems.ModelAPILoader.dll")) || !File.Exists(Path.Combine(configured, "OutSystems.Model.dll")))
            throw new DirectoryNotFoundException("not an ODC Studio directory: " + configured + " (ANVIL_ODC_STUDIO_DIR)");
        return configured;
    }

    private static IFeature[] Features() => typeof(Program).Assembly.GetTypes()
        .Where(t => typeof(IFeature).IsAssignableFrom(t) && !t.IsAbstract && !t.IsInterface)
        .Select(t => (IFeature)Activator.CreateInstance(t)!).OrderBy(f => f.Name).ToArray();

    private static string? Option(string[] args, string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args) {
        if (args.FirstOrDefault() == "read-serve") return Anvil.Core.Hosting.SnapshotReadServer.Run(
            Option(args, "--state") ?? throw new ArgumentException("--state is required"),
            Option(args, "--generation") ?? throw new ArgumentException("--generation is required"), Inspect.OpenSnapshot);
        if (args.Length >= 1 && args[0] == "manifest") return PrepareManifest.Run(args.Skip(1).ToArray(), ResolveRoot());
        // C02 item 2: the resident builder (builder-resident.mjs starts it once per generation of these binaries).
        if (args.FirstOrDefault() == "manifest-serve") return ManifestServer.Run(
            Option(args, "--state") ?? throw new ArgumentException("--state is required"),
            Option(args, "--generation") ?? throw new ArgumentException("--generation is required"));
        if (args.Length == 1 && args[0] == "list") {
            foreach (var f in Features()) Console.WriteLine(f.Name + "  " + f.Module + "  " + (f is INewModule n ? "new:" + n.Kind : f.Transaction));
            return 0;
        }
        if (args.Length >= 1 && args[0] == "inspect") {
            // Read-only: the developer identity only labels the headless load; nothing is written.
            var catalog = Path.Combine(ResolveRoot(), "snapshots", "modules.json");
            string author = "inspect@ssam-hybrid-odc";
            try { using var doc = JsonDocument.Parse(File.ReadAllText(catalog)); if (doc.RootElement.TryGetProperty("author", out var a) && a.GetString() is string s) author = s; } catch { }
            return Inspect.Run(args.Skip(1).ToArray(), author);
        }
        var start = DateTimeOffset.UtcNow;
        var smoke = args.Contains("--smoke");
        var moduleOverride = Option(args, "--module");
        var producerPath = Option(args, "--producer");
        var tenantOverride = Option(args, "--tenant");
        var valueIndexes = new[] { "--module", "--producer", "--tenant" }.Select(o => Array.IndexOf(args, o)).Where(i => i >= 0).Select(i => i + 1).ToHashSet();
        var positional = args.Where((a, i) => !a.StartsWith("--") && !valueIndexes.Contains(i)).ToArray();
        var creating = positional.Length > 0 && positional[0] == "new";
        Require(creating ? positional.Length == 3 : positional.Length == 4, "Usage: list | new <feature> <new-output-directory> [--module <Name>] [--producer <producer.oml>] [--tenant <host>] | <feature> <base.oml> <baseSha256> <new-output-directory> [--smoke] [--module <Name>] [--producer <producer.oml>] [--tenant <host>]");
        var featureName = creating ? positional[1] : positional[0];
        var feature = Features().SingleOrDefault(f => f.Name == featureName) ?? throw new InvalidOperationException("Unknown feature '" + featureName + "'. Run: ODC3.Builder list");
        Require(!creating || feature is INewModule, "Feature " + featureName + " changes an existing module; run it with a base instead of 'new'.");
        Require(creating || feature is not INewModule, "Feature " + featureName + " creates a module; run it as: new " + featureName + " <output>.");
        Require(!creating || !smoke, "--smoke does not apply to module creation.");
        var basePath = creating ? "" : Path.GetFullPath(positional[1]);
        var baseHash = creating ? "" : positional[2].ToUpperInvariant();
        var output = Path.GetFullPath(positional[creating ? 2 : 3]);
        var root = ResolveRoot();
        var journal = new Journal(Path.Combine(root, "journal", "operations.jsonl"));
        var catalogPath = Path.Combine(root, "snapshots", "modules.json");
        var identity = Resolve(feature, moduleOverride ?? feature.Module, catalogPath, requireKey: !creating, tenantOverride, creating ? new Hint(null, null, null) : BaseHint(basePath), Path.Combine(root, "tenants.json"));
        Manifest? manifest = null; Exception? failure = null;
        try {
            Require(!Directory.Exists(output), "Use a new output directory; evidence is never overwritten.");
            Directory.CreateDirectory(output);
            byte[]? basisBytes = null; DateTimeOffset capturedAt;
            if (creating) {
                Require(!CatalogHas(catalogPath, identity.Module), "The catalog already lists a module named " + identity.Module + "; module creation refuses to shadow it. Run the bridge 'assets' command if the catalog is stale.");
                capturedAt = start;
            } else {
                basisBytes = File.ReadAllBytes(basePath);
                Require(Manifest.Hash(basisBytes) == baseHash, "Base snapshot hash changed: " + basePath);
                capturedAt = CaptureTime(basePath);
            }

            Loader.SetConfiguration(new Configuration { DeveloperId = identity.Author, StorageStrategy = FileStorageStrategy.InMemory, UseSharedCache = false });
            var services = Loader.ModelServicesInstance;
            Anvil.Core.OdcModelPlugins.Register(services); // a Mobile UI app requires MobileUI: from the ODC Studio's plugin cache
            NativeFeatureBootstrap.Initialize(Path.Combine(output, "features"));
            byte[]? producerBytes = producerPath == null ? null : File.ReadAllBytes(Path.GetFullPath(producerPath));
            using var producer = producerBytes == null ? null : services.LoadESpace(producerBytes, loadFlags: LoadFlags.SkipUpgrades, developerId: identity.Author);
            using var model = creating
                ? services.CreateESpace(((INewModule)feature).Kind, name: identity.Module, targetPlatform: PlatformServerVersion.Neo, enableTransactions: true, tool: CreatedByTool.AgentExperience, developerId: identity.Author, trackChanges: true, agentName: "ODC3")
                : services.LoadESpace(basisBytes!, loadFlags: LoadFlags.SkipUpgrades, enableTransactions: true, developerId: identity.Author, trackChanges: true, tool: CreatedByTool.AgentExperience, agentName: "ODC3");
            if (creating) identity = identity with { ModuleKey = model.Key.ToString()! };
            Require(model.Name == identity.Module && model.Key.ToString() == identity.ModuleKey, "Unexpected module identity: " + model.Name + " " + model.Key + "; expected " + identity.Module + " " + identity.ModuleKey);
            var beforeErrors = Errors(model); var beforeWarnings = Warnings(model);
            var beforeStamps = new Dictionary<string, string?>();
            var beforeNames = new Dictionary<string, string>();
            foreach (var node in ModelPath.Descendants(model)) { var key = node.Key.ToString()!; beforeStamps[key] = Value(node, "LastModifiedDate"); beforeNames[key] = node.GetInterface().Name + ":" + node.DisplayName; }
            var context = new BuildContext(services, output, producerPath == null ? null : Path.GetFullPath(producerPath), producer);
            // After Apply, every flow the feature touched is laid out, whether the feature asked for it or not:
            // the layout engine is not optional, so a candidate cannot reach the Studio with a flow drawn in the
            // order its nodes happened to be created. Flows the feature did not touch are left alone.
            var laidOut = Array.Empty<string>();
            if (!smoke) model.TransactionsManager.ExecuteTransaction(feature.Transaction, (_, _) => { feature.Apply(model, context); laidOut = Authoring.LayoutTouched(model, beforeStamps); return true; });
            var candidate = model.Save();
            var candidatePath = Path.Combine(output, (smoke ? "DO-NOT-DELIVER-smoke-" : "") + identity.Module + "-candidate.oml");
            File.WriteAllBytes(candidatePath, candidate);

            using var reload = services.LoadESpace(candidate, loadFlags: LoadFlags.SkipUpgrades, developerId: identity.Author);
            var checks = smoke ? Array.Empty<string>() : feature.Verify(reload).ToArray();
            File.WriteAllText(Path.Combine(output, "feature-checks.json"), JsonSerializer.Serialize(new { informative = true, feature = feature.Name, passed = checks }, Journal.Pretty));
            var addedErrors = Errors(reload).Except(beforeErrors).ToArray();
            Require(addedErrors.Length == 0, "Candidate introduces validation errors: " + string.Join(Environment.NewLine, addedErrors));
            // A03 (owner decision, 2026-10-06): only errors and security warnings block. The bridge's merge gate refuses only
            // errors (StartupHook.cs); a new security warning (SecurityWarnings.IsSecurity) is refused here, every other new
            // warning is accepted and listed in the builder receipt (acceptedWarnings).
            var addedWarnings = Warnings(reload).Except(beforeWarnings).ToArray();
            var judgedWarnings = Anvil.Core.CandidateReceipt.JudgeWithoutReceipt(addedWarnings);
            Require(judgedWarnings.Refused.Count == 0, "Candidate introduces security warnings: " + string.Join(Environment.NewLine, judgedWarnings.Refused));
            var acceptedWarnings = judgedWarnings.Accepted.ToArray();
            // Only elements that are new or whose audit stamp changed count as authored by this transaction.
            // A pure deletion leaves nothing to stamp, so absence of base elements is the proof in that case.
            var authored = ModelPath.Descendants(reload)
                .Where(n => Value(n, "LastModifiedBy") == identity.Author && (!beforeStamps.TryGetValue(n.Key.ToString()!, out var stamp) || stamp != Value(n, "LastModifiedDate")))
                .Select(n => n.GetInterface().Name + ":" + n.DisplayName).Distinct().ToArray();
            var reloadKeys = ModelPath.Descendants(reload).Select(n => n.Key.ToString()!).ToHashSet();
            var deleted = beforeNames.Where(kv => !reloadKeys.Contains(kv.Key)).Select(kv => kv.Value).Distinct().ToArray();
            Require(smoke || authored.Length > 0 || deleted.Length > 0, "No element carries the required author after save and reload and nothing was deleted; native change tracking did not stamp the edit.");

            manifest = new Manifest {
                Feature = feature.Name, Module = identity.Module, ModuleKey = identity.ModuleKey, Tenant = identity.Tenant, Author = identity.Author,
                BasePath = basePath, BaseSha256 = baseHash, BaseCapturedAt = capturedAt.ToString("o"),
                CandidatePath = candidatePath, CandidateSha256 = Manifest.Hash(candidate), Owners = feature.Owners,
                EvidenceDir = Path.Combine(output, "evidence"), Changes = feature.Changes, BuilderReceipt = Path.Combine(output, "builder-receipt.json"), Smoke = smoke,
                Create = creating, ProducerPath = context.ProducerPath, ProducerSha256 = producerBytes == null ? null : Manifest.Hash(producerBytes)
            };
            manifest.Save(Path.Combine(output, "manifest.json"));
            File.WriteAllText(manifest.BuilderReceipt!, JsonSerializer.Serialize(new { ok = true, smoke, create = creating, kind = creating ? ((INewModule)feature).Kind.ToString() : null, feature = feature.Name, module = identity.Module, moduleKey = identity.ModuleKey, tenant = identity.Tenant, author = identity.Author, baseSha256 = baseHash, candidateSha256 = manifest.CandidateSha256, producer = manifest.ProducerPath, producerSha256 = manifest.ProducerSha256, dependencies = reload.Dependencies.Select(d => d.Name).ToArray(), addedErrors, addedWarnings, acceptedWarnings, authoredElements = authored, deletedElements = deleted.Take(50), deletedCount = deleted.Length, checks = checks.Length, laidOutActions = laidOut, flowLayoutEngine = Anvil.Core.FlowLayout.EngineRevision, elapsedMs = (int)(DateTimeOffset.UtcNow - start).TotalMilliseconds, publishInvoked = false, liveMergeInvoked = false, completedAt = DateTimeOffset.UtcNow }, Journal.Pretty));
            Console.WriteLine(Path.Combine(output, "manifest.json"));
            return 0;
        } catch (Exception error) { failure = error; throw; }
        finally {
            journal.Append(new Journal.Entry(start.ToString("o"), DateTimeOffset.UtcNow.ToString("o"), "builder-" + Environment.ProcessId, "builder", smoke ? "smoke" : creating ? "new-module" : "candidate",
                identity.Module, identity.ModuleKey == "" ? null : identity.ModuleKey, baseHash == "" ? null : baseHash, manifest?.CandidateSha256, null, null, Journal.Outcome(failure, false), failure == null ? "none" : Journal.Gate(failure.Message), output, failure?.Message, "live", feature.Name));
        }
    }

    // The SSAM Hybrid-ODC repository root: SSAM_HYBRID_ODC_ROOT or ODC3_ROOT when set, otherwise found upwards from
    // this executable (studio\builder\bin\Release\net10.0) by its studio folder and README.
    private static string ResolveRoot() {
        foreach (var name in new[] { "SSAM_HYBRID_ODC_ROOT", "ODC3_ROOT" }) { var v = Environment.GetEnvironmentVariable(name); if (!string.IsNullOrWhiteSpace(v) && Directory.Exists(v)) return v; }
        for (var d = Path.GetFullPath(AppContext.BaseDirectory); d != null; d = Path.GetDirectoryName(d)) if (Directory.Exists(Path.Combine(d, "studio")) && File.Exists(Path.Combine(d, "README.md"))) return d;
        throw new InvalidOperationException("SSAM Hybrid-ODC root not found above " + AppContext.BaseDirectory + "; set SSAM_HYBRID_ODC_ROOT.");
    }

    // Identity of a run: module key, tenant and author. The base itself is the first source: the snapshot sidecar
    // (<base>.oml.json, written by the bridge) carries moduleKey, host and developerId, and a candidate's manifest
    // carries moduleKey, tenant and author. The catalog (snapshots\modules.json, root tenant plus otherTenants) and
    // tenants.json fill whatever the base does not say. A module name exists in several tenants (a client app does),
    // so the tenant is never guessed from the name; --tenant <host> overrides everything but the feature's own values.
    private sealed record Hint(string? Key, string? Tenant, string? Author);
    private static Hint BaseHint(string basePath) {
        string? key = null, tenant = null, author = null;
        foreach (var file in new[] { basePath + ".json", Path.Combine(Path.GetDirectoryName(basePath)!, "manifest.json") }) {
            try {
                using var d = JsonDocument.Parse(File.ReadAllText(file)); var r = d.RootElement;
                key ??= r.TryGetProperty("moduleKey", out var k) && k.GetString() is string s && s != "" ? s : null;
                tenant ??= r.TryGetProperty("host", out var h) ? h.GetString() : r.TryGetProperty("tenant", out var t) ? t.GetString() : null;
                author ??= r.TryGetProperty("author", out var a) ? a.GetString() : r.TryGetProperty("developerId", out var dev) ? dev.GetString() : null;
            } catch { }
        }
        return new Hint(key, tenant, author);
    }
    private static FeatureIdentity Resolve(IFeature feature, string module, string catalogPath, bool requireKey, string? tenantOverride, Hint hint, string tenantsPath) {
        string? key = feature.ModuleKey, tenant = feature.Tenant ?? tenantOverride ?? hint.Tenant, author = feature.Author;
        JsonElement? section = null;
        if (File.Exists(catalogPath)) {
            using var document = JsonDocument.Parse(File.ReadAllText(catalogPath));
            var root = document.RootElement;
            var sections = new[] { root }.Concat(root.TryGetProperty("otherTenants", out var others) ? others.EnumerateArray() : Enumerable.Empty<JsonElement>()).ToArray();
            string? TenantOf(JsonElement s) => s.TryGetProperty("tenant", out var t) ? t.GetString() : null;
            if (tenant == null) {
                // No tenant from feature, flag or base: the root section, unless only one other section lists the module.
                var listing = sections.Where(s => SectionHas(s, module)).ToArray();
                section = listing.Length == 1 ? listing[0] : root;
                tenant = TenantOf(section.Value);
            } else section = sections.FirstOrDefault(s => string.Equals(TenantOf(s), tenant, StringComparison.OrdinalIgnoreCase)) is { ValueKind: JsonValueKind.Object } found ? found : null;
            if (section != null) {
                var s = section.Value;
                author ??= s.TryGetProperty("author", out var a) ? a.GetString() : null;
                if (key == null && hint.Key == null && s.TryGetProperty("modules", out var modules))
                    foreach (var entry in modules.EnumerateArray()) if (entry.TryGetProperty("name", out var n) && n.GetString() == module && entry.TryGetProperty("key", out var k)) key = k.GetString();
            }
        }
        key ??= hint.Key;
        author ??= StudioAuthor(tenantsPath, tenant) ?? hint.Author;
        Require((key != null || !requireKey) && tenant != null && author != null, "Module " + module + " has no identity: tenant " + (tenant ?? "?") + ", key " + (key ?? "?") + ", author " + (author ?? "?") + ". The base's .oml.json sidecar or manifest, snapshots\\modules.json (bridge command 'assets <host>') or tenants.json must name them, or pass --tenant <host>.");
        return new FeatureIdentity(module, key ?? "", tenant!, author!);
    }
    private static string? StudioAuthor(string tenantsPath, string? tenant) {
        if (tenant == null) return null;
        try { using var d = JsonDocument.Parse(File.ReadAllText(tenantsPath)); return d.RootElement.TryGetProperty("tenants", out var all) && all.TryGetProperty(tenant, out var t) && t.TryGetProperty("studioAuthor", out var a) ? a.GetString() : null; } catch { return null; }
    }
    private static bool SectionHas(JsonElement section, string module) =>
        section.ValueKind == JsonValueKind.Object && section.TryGetProperty("modules", out var modules) && modules.EnumerateArray().Any(e => e.TryGetProperty("name", out var n) && n.GetString() == module);
    private static bool CatalogHas(string catalogPath, string module) {
        if (!File.Exists(catalogPath)) return false;
        using var document = JsonDocument.Parse(File.ReadAllText(catalogPath));
        return document.RootElement.TryGetProperty("modules", out var modules) && modules.EnumerateArray().Any(e => e.TryGetProperty("name", out var n) && string.Equals(n.GetString(), module, StringComparison.OrdinalIgnoreCase));
    }

    private static DateTimeOffset CaptureTime(string basePath) {
        var metadata = basePath + ".json";
        if (File.Exists(metadata)) {
            using var document = JsonDocument.Parse(File.ReadAllText(metadata));
            if (document.RootElement.TryGetProperty("capturedAt", out var captured) && DateTimeOffset.TryParse(captured.GetString(), out var parsed)) return parsed;
        }
        return new DateTimeOffset(File.GetLastWriteTimeUtc(basePath), TimeSpan.Zero);
    }

    private static string? Value(IModelObject node, string property) { try { return node.Descriptor.Properties.SingleOrDefault(p => p.Name == property)?.GetValue(node)?.ToString(); } catch { return null; } }
    private static string[] Errors(IESpace model) => model.GetValidationMessages().Where(x => x.Type.ToString() == "Error").Select(x => x.Owner.Key + "|" + x.Id + "|" + x.Message + "|" + x.Detail).Order().ToArray();
    private static string[] Warnings(IESpace model) => model.GetValidationMessages().Where(x => x.Type.ToString() != "Error").Select(x => x.Owner.Key + "|" + x.Id + "|" + x.Message + "|" + x.Detail).Order().ToArray();
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}

