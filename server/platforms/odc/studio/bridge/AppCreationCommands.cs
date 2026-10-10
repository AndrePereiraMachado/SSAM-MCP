using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model.DependenciesProviders;
using OutSystems.Model.Implementation.Oml;
using OutSystems.ObjectKeys;
using ServiceStudio.Model;
using ServiceStudio.Presenter;
using ServiceStudio.ServerCommunications.API;
using ServiceStudio.ServerCommunications.API.Services.AssetManagement;

// The tenant side of a new app, as the ODC Studio's "Create app" does it: list the application templates, download
// a template OML, and upload the app the kernel built from it (anvil-odc create-app) under the app name the user gave.
// The model itself is never built here: the bridge reads the tenant through the signed-in session and uploads a
// hash-checked, validated candidate through the same CreateAsset the "create" command uses.
internal static partial class Bridge
{
    // The template GUIDs the Studio's wizard asks the tenant for, per kind (decompiled ApplicationDialogHelper):
    // Web app for Reactive; Mobile UI (preselected) and OutSystems UI phone templates for Mobile. Libraries have none.
    private static readonly Dictionary<string, Guid[]> WizardTemplateKeys = new(StringComparer.OrdinalIgnoreCase) {
        ["agentic"] = new[] { Guid.Parse("4917e928-cb9f-40bb-a3dc-fe9ebacc8b2f") },
        ["reactive"] = new[] { Guid.Parse("57b4b95a-7266-4ab2-8cec-aa1b46893be7") },
        ["mobile"] = new[] { Guid.Parse("e9e19d63-1fef-4043-857a-240f4cda3e3f"), Guid.Parse("6c2bf74b-47e8-4573-aefd-46facf344dba") },
    };

    private static (string[] Words, string? Tenant) TenantArgument(string argument) {
        var parts = argument.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        var index = parts.IndexOf("--tenant");
        string? tenant = null;
        if (index >= 0) { Require(index + 1 < parts.Count, "--tenant requires a host."); tenant = parts[index + 1]; parts.RemoveRange(index, 2); }
        return (parts.ToArray(), tenant);
    }

    // Lists the tenant's application templates through the native TemplatesService the wizard uses.
    // Usage: templates [--kind reactive|mobile|agentic|all] [--tenant <host>]   (all = every ApplicationTemplate, custom ones too)
    private static async Task<object> Templates(string argument, Context c) {
        var (words, tenant) = TenantArgument(argument);
        var kindIndex = Array.IndexOf(words, "--kind");
        var kind = kindIndex >= 0 && kindIndex + 1 < words.Length ? words[kindIndex + 1] : "all";
        Require(kind == "all" || WizardTemplateKeys.ContainsKey(kind), "templates --kind takes reactive, mobile, agentic or all; libraries have no template.");
        var top = await Ui(() => tenant != null ? Top(tenant) : TopAny());
        var host = Host(top);
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        var keys = kind == "all" ? null : WizardTemplateKeys[kind];
        var templates = provider.TemplatesService.ListApplicationTemplates(keys).ToArray();
        var list = templates.Select(t => {
            object? asset = null;
            try {
                var info = provider.AssetManagementService.GetAssetInfo(new RevisionRequest(RevisionRequestType.Latest, t.Key));
                if (info != null) asset = new { name = info.Name, assetType = info.AssetType.ToString(), revision = info.Revision, revisionAt = info.RevisionDateTime.ToString("o") };
            } catch (Exception error) { asset = new { error = error.GetBaseException().Message }; }
            return new { key = t.Key.ToString(), label = t.Label, description = t.Description, applicationKind = t.ApplicationKind.ToString(),
                wizard = WizardTemplateKeys.Where(w => w.Value.Any(g => ObjectKey.NewKey(g).ToString() == t.Key.ToString())).Select(w => w.Key).FirstOrDefault(), asset };
        }).ToArray();
        var result = new { ok = true, tenant = host, kind, listedAt = DateTimeOffset.UtcNow.ToString("o"), source = "TemplatesService.ListApplicationTemplates", count = list.Length, templates = list };
        TryWrite(Path.Combine(Snapshots, "templates", "templates-" + host + ".json"), result);
        return result;
    }

    // Downloads the latest revision of an application template through the native TemplatesService
    // (GetESpaceForApplicationTemplate, what the Studio clones). The file is named by key and content hash and is
    // never overwritten. The answer also names the Studio's model plugin cache and the template's required model
    // plugins, each fetched into it when missing. Usage: template-download <templateKey> [--tenant <host>] [--have <revision>-<sha12>]
    // C25 (capability template-download:have): with --have, a template whose latest revision is the one the caller already
    // holds, and whose file this bridge kept from an earlier download (same revision and sha256 prefix), answers
    // cached:true from that file (GetAssetInfo only, no bytes over the wire); any other answer downloads as always.
    private static async Task<object> TemplateDownload(string argument, Context c) {
        var (all, tenant) = TenantArgument(argument);
        var words = all.ToList();
        string? have = null;
        var at = words.IndexOf("--have");
        if (at >= 0) { Require(at + 1 < words.Count, "--have requires <revision>-<sha12>."); have = words[at + 1]; words.RemoveRange(at, 2); }
        Require(words.Count == 1, "template-download requires one template key, optionally --tenant <host> and --have <revision>-<sha12>.");
        var key = ObjectKey.Parse(words[0]);
        var top = await Ui(() => tenant != null ? Top(tenant) : TopAny());
        var host = Host(top);
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        var info = provider.AssetManagementService.GetAssetInfo(new RevisionRequest(RevisionRequestType.Latest, key));
        Require(info != null, "The tenant " + host + " has no asset with key " + key + ".");
        var dir = Path.Combine(Snapshots, "templates");
        Directory.CreateDirectory(dir);
        var stem = key.ToString().Replace('/', '_').Replace('+', '-') + "-r" + info!.Revision + "-";
        var kept = TemplateCache.Kept(have, info.Revision.ToString(), dir, stem);
        var cached = kept != null;
        var bytes = cached ? File.ReadAllBytes(kept!) : provider.TemplatesService.GetESpaceForApplicationTemplate(key);
        Require(bytes != null && bytes.Length > 0, "The tenant returned no source code for template " + info.Name + " (key " + key + ").");
        var hash = Hash(bytes!);
        var path = Path.Combine(dir, stem + hash[..12] + ".oml");
        if (!File.Exists(path)) File.WriteAllBytes(path, bytes!);
        c.Module = info.Name; c.ModuleKey = key.ToString();
        // The template's model plugins (Template_MobileApp requires MobileUI) must be in the Studio's plugin cache before
        // the kernel clones the template headless: it reads them from that folder (create-app --plugins-dir). A missing
        // one is fetched as the Studio fetches it when it opens such an app: its IModelPluginProvider downloads it through
        // the session (AssetManagementService.GetAssetBinary) and writes <PluginsDirectory>\<AssemblyName>-<Version>.xif.
        var plugins = Providers.Instance.GetModelPlugins();
        var modelPlugins = (Oml.GetOmlHeader(bytes!).RequiredModelPlugins ?? new()).Select(p => {
            var file = Path.Combine(plugins.PluginsDirectory, p.AssemblyName + "-" + p.AssemblyVersion + ".xif");
            var fetched = false; string? error = null;
            if (!File.Exists(file))
                try { plugins.GetModelPlugin(p.ToModelPluginInformation(), top.ServerCommunicationsProvider); fetched = true; }
                catch (Exception e) { error = e.GetBaseException().Message; }
            return new { name = p.AssemblyName, version = p.AssemblyVersion?.ToString(), file, cached = File.Exists(file), fetched, error };
        }).ToArray();
        var result = new { ok = true, cached, tenant = host, key = key.ToString(), name = info.Name, assetType = info.AssetType.ToString(), revision = info.Revision,
            revisionAt = info.RevisionDateTime.ToString("o"), sha256 = hash, bytes = bytes!.Length, path, downloadedAt = DateTimeOffset.UtcNow.ToString("o"),
            source = cached ? "cache (revision unchanged, AssetManagementService.GetAssetInfo)" : "TemplatesService.GetESpaceForApplicationTemplate", pluginsDirectory = plugins.PluginsDirectory, modelPlugins };
        if (!cached) File.WriteAllText(path + ".json", JsonSerializer.Serialize(result, Json));
        return result;
    }

    // Uploads a new app built by anvil-odc create-app. The app (asset) name is the manifest's appName, which may hold
    // spaces while the module name may not, so it is checked here before the "create" gates: the candidate carries it
    // and no asset of the tenant has it. Then "create" runs unchanged (authorization, one attempt, identity,
    // validation, module name free, CreateAsset, receipt). Usage: create-app <manifest>
    private static async Task<object> CreateApp(string manifestPath, Context c) {
        var full = Path.GetFullPath(manifestPath);
        var node = JsonNode.Parse(File.ReadAllText(full)) as JsonObject ?? throw new InvalidOperationException("Manifest is not a JSON object: " + full);
        var appName = node["appName"]?.GetValue<string>();
        Require(!string.IsNullOrWhiteSpace(appName), "create-app requires manifest.appName, the app name the user gave (written by anvil-odc create-app).");
        var m = Manifest.Load(full); c.Bind(m);
        Require(m.Create, "create-app requires a creation manifest (anvil-odc create-app).");
        Require(!string.IsNullOrWhiteSpace(m.CreateAuthorization), "create-app requires manifest.createAuthorization with the user's explicit authorization text.");
        Require(!File.Exists(Path.Combine(m.EvidenceDir, "create-started.json")), "An asset creation was already attempted in this evidence directory; inspect its receipt, never retry here.");
        var top = await Ui(() => Top(m.Tenant));
        var provider = (IServerCommunicationsServicesProvider)top.ServerCommunicationsProvider;
        var host = Host(top);
        using (var candidate = Load(m.ReadCandidate()))
            Require(candidate.AppName == appName, "The candidate's app name '" + candidate.AppName + "' differs from the manifest's '" + appName + "'.");
        var (assets, _) = ListAssets(provider);
        var taken = assets.Where(a => string.Equals(a.Name, appName, StringComparison.OrdinalIgnoreCase)).Select(a => a.Name + " (" + a.AssetType + ", key " + ObjectKey.NewKey(a.AssetKey) + ")").ToArray();
        Require(taken.Length == 0, "An app named " + appName + " already exists in " + host + ": " + string.Join(", ", taken) + ". App creation never shadows an existing asset.");
        var created = await Create(full, c);
        var result = JsonSerializer.SerializeToNode(created) as JsonObject ?? new JsonObject();
        result["appName"] = appName;
        result["appNameFreeIn"] = host;
        return result;
    }
}
