using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model.Implementation.Oml;
using OutSystems.ObjectKeys;
using ServiceStudio.Model;
using ServiceStudio.ModelFeatures;
using ServiceStudio.Presenter.Commands;
using MetaKind = OutSystems.MetaModel.Enumerations.SegmentationKind;
using MetaTool = OutSystems.MetaModel.Enumerations.CreatedByTool;
using MetaVersion = OutSystems.MetaModel.Enumerations.PlatformServerVersion;

namespace Anvil.Core;

/// <summary>What `anvil-odc create-app` builds: the kind, the app (asset) name, the module name and the app settings the
/// ODC Studio's "Create app" dialog asks for. Apps clone a template OML downloaded from the tenant; libraries have none.
/// PluginsDirectory is the signed-in Studio's model plugin cache, as the bridge's template-download reports it: the
/// template's model plugins (MobileUI) are read from there first.</summary>
public sealed record OdcAppSpec(
    string Kind, string AppName, string? Module = null, string? TemplateOml = null, string? TemplateKey = null,
    string? Color = null, string? Description = null, string? IconPath = null, string? Tenant = null, string? Author = null,
    string? PluginsDirectory = null);

/// <summary>
/// A new ODC app or library built headless the way the ODC Studio 1.7 builds it before uploading it (decompiled
/// ServiceStudio.Presenter, ApplicationCommands): an app (Reactive, Mobile) is <c>ESpace.Clone</c> of the tenant's
/// template OML with a new key, the app name, the primary color, the description and no image, then
/// <c>ApplicationCommands.ChangeESpacePrimaryColor(..., isESpaceCreation: true)</c>, which renames the default theme to
/// the module and writes the color into it (the O11 kernel runs the same call over a MockAggregatorPresenter in
/// TemplateModules); a library (Library, Mobile Library) is <c>ESpace.Create</c> with no template, the app settings and
/// the "Users" user provider, as the Studio's NewLibrary does. The model only: the template download, the upload
/// (CreateAsset), opening and publishing belong to the bridge inside the signed-in Studio.
/// The output directory receives the module OML, a receipt and a creation manifest the bridge command "create" accepts.
/// Nothing is overwritten.
/// </summary>
public static class OdcAppFactory
{
    /// <summary>Product kind -> Studio SegmentationKind, as the Studio's wizard maps them. WebResponsive (Traditional
    /// Web) is never produced: the ODC server refuses it (OS-APPS-40015).</summary>
    public static readonly IReadOnlyDictionary<string, MetaKind> Kinds = new Dictionary<string, MetaKind>(StringComparer.OrdinalIgnoreCase)
    {
        ["reactive"] = MetaKind.CrossDevice,
        ["mobile"] = MetaKind.Mobile,
        ["agentic"] = MetaKind.AIAgent,
        ["library"] = MetaKind.ReactiveLibrary,
        ["mobile-library"] = MetaKind.MobileLibrary,
    };

    /// <summary>The tenant's system templates the wizard asks for, by product name: template GUIDs of the wizard filter
    /// as asset ObjectKeys (Guid bytes in base64, '/' as '_').</summary>
    public static readonly IReadOnlyDictionary<string, (string Kind, string Key, string Asset)> Templates = new Dictionary<string, (string, string, string)>(StringComparer.OrdinalIgnoreCase)
    {
        ["agent"] = ("agentic", "KOkXSZ_Lu0Cj3P6eusyLLw", "template_Agent"),
        ["web"] = ("reactive", "Wrm0V2ZyskqM7KobRok75w", "Template Web App"),
        ["mobile-ui"] = ("mobile", "Y53h6e8fQ0CFeiQPTNo+Pw", "Template_MobileApp"),
        ["outsystems-ui"] = ("mobile", "S_crbOhHc0Wu_Ub6zzRNug", "Template Phone App"),
    };

    /// <summary>The default template of each app kind: the wizard preselects Mobile UI for mobile.</summary>
    public static string DefaultTemplate(string kind) => kind.Equals("agentic", StringComparison.OrdinalIgnoreCase) ? "agent" : kind.Equals("mobile", StringComparison.OrdinalIgnoreCase) ? "mobile-ui" : "web";

    /// <summary>The same default as the O11 AppFactory: without a color the theme is left without its required value.</summary>
    public const string DefaultPrimaryColor = "#2E86C1";

    /// <summary>The ODC user provider every new module of the Studio names (Constants.UsersESpaceKey).</summary>
    public const string UsersProviderName = "Users";

    private static readonly Regex ModuleNamePattern = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);
    private static readonly Regex ColorPattern = new("^#[0-9A-Fa-f]{6}$", RegexOptions.CultureInvariant);

    public static bool IsLibrary(string kind) => Kinds.TryGetValue(kind, out var k) && k is MetaKind.ReactiveLibrary or MetaKind.MobileLibrary;

    /// <summary>The module name derived from the app name: the characters a module name cannot hold are dropped
    /// ("Escala Viva" -> "EscalaViva", as the tenant shows for an app created by the Studio).</summary>
    public static string ModuleNameFor(string appName)
    {
        var name = new string(appName.Where(c => c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_').ToArray());
        if (!ModuleNamePattern.IsMatch(name))
            throw new ArgumentException("no module name can be derived from the app name '" + appName + "'; pass --module <Name> (letters, digits, underscore; not starting with a digit)");
        return name;
    }

    /// <summary>The contract refusals, before any model is touched.</summary>
    public static (MetaKind Kind, string Module, string Color) Check(OdcAppSpec spec)
    {
        if (!Kinds.TryGetValue(spec.Kind ?? "", out var kind))
            throw new ArgumentException("unknown --kind '" + spec.Kind + "'; one of: " + string.Join(", ", Kinds.Keys));
        if (string.IsNullOrWhiteSpace(spec.AppName) || spec.AppName.Trim() != spec.AppName || spec.AppName.Length > 50 || spec.AppName.Any(char.IsControl))
            throw new ArgumentException("--name must be a non-empty app name of at most 50 characters, without leading or trailing spaces");
        var module = string.IsNullOrWhiteSpace(spec.Module) ? ModuleNameFor(spec.AppName) : spec.Module!;
        if (!ModuleNamePattern.IsMatch(module)) throw new ArgumentException("--module '" + module + "' is not a module name (letters, digits, underscore; not starting with a digit)");
        var color = string.IsNullOrWhiteSpace(spec.Color) ? DefaultPrimaryColor : spec.Color!;
        if (!ColorPattern.IsMatch(color)) throw new ArgumentException("--color must be #RRGGBB, not '" + color + "'");
        var library = kind is MetaKind.ReactiveLibrary or MetaKind.MobileLibrary;
        if (library && (spec.TemplateOml != null || spec.TemplateKey != null))
            throw new ArgumentException("a " + spec.Kind + " has no template: the ODC Studio creates libraries with ESpace.Create, never from a template");
        if (!library && string.IsNullOrWhiteSpace(spec.TemplateOml))
            throw new ArgumentException("a " + spec.Kind + " app is a clone of the tenant's template: pass --template-oml <the template downloaded by the bridge>");
        if (!library && !File.Exists(spec.TemplateOml)) throw new FileNotFoundException("template OML not found: " + spec.TemplateOml);
        if (spec.IconPath != null && !File.Exists(spec.IconPath)) throw new FileNotFoundException("icon not found: " + spec.IconPath);
        return (kind, module, color);
    }

    public static JsonObject Create(ModelHost host, OdcAppSpec spec, string outDir, Action<string>? log = null)
    {
        var (kind, module, color) = Check(spec);
        outDir = Path.GetFullPath(outDir);
        var omlPath = Path.Combine(outDir, module + ".oml");
        var receiptPath = Path.Combine(outDir, "create-app-receipt.json");
        var manifestPath = Path.Combine(outDir, "manifest.json");
        foreach (var existing in new[] { omlPath, receiptPath, manifestPath })
            if (File.Exists(existing)) throw new IOException("the output already exists (create-app never overwrites): " + existing);
        var icon = spec.IconPath == null ? null : File.ReadAllBytes(spec.IconPath);
        StudioAdapter.Runtime.Ensure(Path.Combine(Path.GetTempPath(), "anvil-odc"));
        var library = kind is MetaKind.ReactiveLibrary or MetaKind.MobileLibrary;

        byte[]? templateBytes = null; IReadOnlyList<MessageInfo> templateMessages = [];
        JsonObject? template = null;
        if (!library)
        {
            // The tenant's templates are OutSystems system modules (RuntimeCommon Constants.ReadonlyESpaces: Template Web App
            // is Template_Reactive, Template_MobileApp is MobileUI_Template_Phone). The Model API refuses to load them
            // ("System modules cannot be loaded with the Model API. Consider using the Clone method instead.") and the
            // Studio never loads them: it clones. So the template is never loaded here: its identity and kind come from
            // the OML header, its content and its own messages (the warning baseline) from a plain clone under another key.
            templateBytes = File.ReadAllBytes(spec.TemplateOml!);
            var header = Oml.GetOmlHeader(templateBytes);
            if (header.ESpaceType != kind)
                throw new InvalidOperationException("the template is a " + header.ESpaceType + " module, not the " + kind + " a " + spec.Kind + " app needs");
            if (!string.IsNullOrWhiteSpace(spec.PluginsDirectory)) OdcModelPlugins.AddDirectory(spec.PluginsDirectory);
            var plugins = new JsonArray((header.RequiredModelPlugins ?? []).Select(p => (JsonNode)new JsonObject
            {
                ["name"] = p.AssemblyName, ["version"] = p.AssemblyVersion?.ToString(),
                ["file"] = p.AssemblyName != null && p.AssemblyVersion != null ? OdcModelPlugins.Find(p.AssemblyName, p.AssemblyVersion) : null,
            }).ToArray());
            var source = CloneTemplate(templateBytes, ObjectKey.NewKey(), null);
            try
            {
                templateMessages = CloneMessages(source);
                template = new JsonObject
                {
                    ["path"] = Path.GetFullPath(spec.TemplateOml!), ["key"] = spec.TemplateKey, ["module"] = header.Name, ["moduleKey"] = header.Key.ToString(),
                    ["kind"] = header.ESpaceType.ToString(), ["systemModule"] = IsSystemModule(header.Key), ["sha256"] = Sha(templateBytes), ["bytes"] = templateBytes.Length,
                    ["content"] = Content(source), ["errors"] = templateMessages.Count(m => m.IsError), ["warnings"] = templateMessages.Count(m => !m.IsError),
                    ["modelPlugins"] = plugins,
                };
            }
            finally { ModelHost.Release(source); }
        }

        var key = ObjectKey.NewKey();
        var description = spec.Description ?? "";
        var steps = new JsonArray();
        var espace = library ? CreateLibrary(module, kind, color, key, description, icon, steps) : CloneApp(templateBytes!, spec.AppName, color, key, description, steps);
        try
        {
            // The module name is the identifier the Studio shows; the clone keeps the template's, so it is set here.
            if (espace.Name != module) { StudioAdapter.Runtime.Mutate(espace, "Set module name", e => e.SetName(module)); steps.Add("SetName(" + module + ")"); }
            if (espace.AppName != spec.AppName) { StudioAdapter.Runtime.Mutate(espace, "Set app name", e => e.AppName = spec.AppName); steps.Add("AppName = " + spec.AppName); }
            // The clone stamps its own effective tool; the module says who created it, as the builder's new modules do.
            if (espace.CreatedByTool != MetaTool.AgentExperience) StudioAdapter.Runtime.Mutate(espace, "Set creating tool", e => e.CreatedByTool = MetaTool.AgentExperience);
            JsonObject? theme = null;
            if (!library && kind != MetaKind.AIAgent) theme = ApplyPrimaryColor(espace, color, steps);
            if (icon != null) ApplyIcon(espace, icon, steps);
            var messages = library ? ModelHost.Messages(espace) : CloneMessages(espace);
            var snapshot = ModelHost.Describe(espace, 0, messages);
            var errors = messages.Where(m => m.IsError).Select(m => m.ToString()).ToArray();
            var templateWarnings = templateMessages.Where(m => !m.IsError).GroupBy(m => m.Id).ToDictionary(g => g.Key, g => g.Count());
            var newWarnings = messages.Where(m => !m.IsError).GroupBy(m => m.Id)
                .Where(g => g.Count() > templateWarnings.GetValueOrDefault(g.Key)).Select(g => g.Key + " x" + (g.Count() - templateWarnings.GetValueOrDefault(g.Key))).ToArray();
            var content = Content(espace);
            var settings = new JsonObject
            {
                ["appName"] = espace.AppName, ["module"] = espace.Name, ["primaryColor"] = espace.PrimaryColor, ["description"] = espace.Description,
                ["userProvider"] = espace.UserProviderESpaceName, ["userProviderKey"] = espace.UserProviderESpaceKey?.ToString(),
                ["createdByTool"] = espace.CreatedByTool.ToString(), ["icon"] = icon != null,
            };
            if (errors.Length > 0)
                throw new InvalidOperationException("the new " + spec.Kind + " " + module + " has " + errors.Length + " validation error(s); nothing was written: " + string.Join(" | ", errors.Take(10)));

            var bytes = host.Save(espace);
            Directory.CreateDirectory(outDir);
            using (var f = new FileStream(omlPath, FileMode.CreateNew, FileAccess.Write)) f.Write(bytes);
            // The proof the bridge can take it: the same runtime load, its identity and validation.
            var reloaded = host.Inspect(bytes);
            var sha = Convert.ToHexString(SHA256.HashData(bytes));
            var receipt = new JsonObject
            {
                ["ok"] = true, ["kind"] = spec.Kind, ["segmentationKind"] = kind.ToString(), ["app"] = spec.AppName, ["module"] = module,
                ["moduleKey"] = key.ToString(), ["reloadedModule"] = reloaded.Name, ["reloadedKey"] = reloaded.Key, ["reloadedKind"] = reloaded.Kind,
                ["omlPath"] = omlPath, ["sha256"] = sha.ToLowerInvariant(), ["bytes"] = bytes.Length, ["template"] = template,
                ["settings"] = settings, ["theme"] = theme, ["content"] = content, ["objects"] = snapshot.Objects,
                ["validation"] = new JsonObject { ["errors"] = 0, ["warnings"] = messages.Count(m => !m.IsError), ["newWarnings"] = new JsonArray(newWarnings.Select(w => (JsonNode)w!).ToArray()),
                    ["sample"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot.Validation.Sample)) },
                ["references"] = JsonNode.Parse(Json.Serialize(snapshot.References, false)), ["steps"] = steps,
                ["path"] = library ? "ESpace.Create (the Studio's NewLibrary)" : "ESpace.Clone of the template (the Studio's NewModule from template)",
                ["createdAt"] = DateTimeOffset.UtcNow.ToString("o"), ["manifest"] = manifestPath,
            };
            if (theme != null && theme["colorApplied"]?.GetValue<bool>() != true)
                receipt["notes"] = new JsonArray((JsonNode)("The template's default theme keeps its own color: it has CSS of its own without the /*primary-color*/ marker, "
                    + "so the Studio's ChangeESpacePrimaryColor only renamed it. The app's PrimaryColor is set; change the theme color in the Studio if wanted.")!);
            File.WriteAllText(receiptPath, receipt.ToJsonString(Json.Pretty));
            WriteManifest(manifestPath, spec, module, key.ToString(), omlPath, sha, outDir, receiptPath);
            log?.Invoke($"{spec.AppName} ({module}, {kind}): {snapshot.Objects} objects, 0 errors, {messages.Count(m => !m.IsError)} warnings, {bytes.Length} bytes");
            return receipt;
        }
        finally { ModelHost.Release(espace); }
    }

    // The Studio's NewModule from a template (prs#cxjfgpmd): clone with a new key and the app settings, no image.
    private static ESpace CloneApp(byte[] template, string appName, string color, ObjectKey key, string description, JsonArray steps)
    {
        var espace = CloneTemplate(template, key, e =>
        {
            e.AppName = appName;
            e.PrimaryColor = color;
            e.Description = description;
            e.Image = null;
            e.RemoveInvalidAnonymousTypes();
        });
        steps.Add("ESpace.Clone(template, newKey, AppName, PrimaryColor, Description, Image = null, forcePlatformVersionV12)");
        return espace;
    }

    // ESpace.Clone, as the Studio clones a template: the only way into a system module, which the Model API's LoadESpace
    // refuses. The clone takes the given key, so it is a module of its own, no longer the system module.
    private static ESpace CloneTemplate(byte[] template, ObjectKey key, Action<ESpace>? settings)
    {
        using var stream = new MemoryStream(template);
        try
        {
            return ESpace.Clone(stream, null, null, null, forceModifiedFlag: false, settings, key, isUnregisteredESpace: false, isIsolated: false,
                forcePlatformVersionV12: true, runtimeProperties: null, tool: MetaTool.AgentExperience, developerId: OdcRuntime.DeveloperId, agentName: "SSAM");
        }
        catch (Exception error) when (OdcModelPlugins.Refusal(error, "the template") is { } refusal)
        {
            // Template_MobileApp requires the MobileUI model plugin: a tenant binary, read here from the Studio's cache.
            throw refusal;
        }
    }

    /// <summary>The messages of a clone. ESpace.Clone enables the clone's model lock, and the verify caches are refreshed
    /// only under its write lock (ESpace.CanRefreshVerifyCacheNow): outside a transaction a fresh clone reports no message
    /// at all. They are read inside one, for the template's baseline and the app alike.</summary>
    private static IReadOnlyList<MessageInfo> CloneMessages(ESpace espace)
    {
        IReadOnlyList<MessageInfo> messages = [];
        StudioAdapter.Runtime.Mutate(espace, "Verify", e => messages = ModelHost.Messages(e));
        return messages;
    }

    /// <summary>What the Model API refuses to load (CommandServicesImplementation.CheckOpenPermissions): the OutSystems
    /// content, protected and read-only modules, by module key.</summary>
    public static bool IsSystemModule(ObjectKey key) =>
        OutSystems.RuntimeCommon.Constants.IsContentESpace(key) || OutSystems.RuntimeCommon.Constants.IsProtectedESpace(key) || OutSystems.RuntimeCommon.Constants.IsReadonlyESpace(key);

    // The Studio's NewLibrary (prs#cxjfgpmb): ESpace.Create with the "Users" provider and the creating tool.
    private static ESpace CreateLibrary(string module, MetaKind kind, string color, ObjectKey key, string description, byte[]? icon, JsonArray steps)
    {
        var espace = ESpace.Create(module, null, kind, color, isTemplatesBundleESpace: false, e =>
        {
            e.UserProviderESpaceName = UsersProviderName;
            e.UserProviderESpaceKey = OutSystems.RuntimeCommon.Constants.UsersESpaceKey;
            e.IsInIsolated = false;
            e.CreatedByTool = MetaTool.AgentExperience;
        }, MetaVersion.V12, key, description, null);
        steps.Add("ESpace.Create(" + kind + ", V12, PrimaryColor, Description, UserProvider = Users)");
        return espace;
    }

    /// <summary>The theme takes the module name and the primary color, the Studio's own command on a mock presenter.</summary>
    private static JsonObject ApplyPrimaryColor(ESpace espace, string color, JsonArray steps)
    {
        var theme = espace.EffectiveDefaultTheme;
        var before = theme?.Name;
        using (var aggregator = new MockAggregatorPresenter(espace, null, registerInstance: false, skipServerServices: true))
        {
            var presenter = new MockPresenter(aggregator);
            ApplicationCommands.ChangeESpacePrimaryColor(presenter.GetPresenterContext(), espace, color, isESpaceCreation: true);
        }
        steps.Add("ApplicationCommands.ChangeESpacePrimaryColor(isESpaceCreation: true)");
        theme = espace.EffectiveDefaultTheme;
        // ThemeProperty lives in a Studio assembly the kernel does not reference; the stored values carry its name.
        string? Value(string property) { try { return theme?.ThemeStyleValues.Select(v => (Name: ModelHost.Prop(v, "PropertyName") as string, Value: ModelHost.Prop(v, "PropertyValue") as string)).FirstOrDefault(v => v.Name == property).Value; } catch { return null; } }
        string styleSheet; try { styleSheet = theme?.StyleSheet?.EffectiveValue ?? ""; } catch { styleSheet = ""; }
        var lower = color.ToLowerInvariant();
        // The command takes one of three paths (theme editor values, Mobile UI design tokens, or a replacement inside
        // the theme's own style sheet when it has custom CSS); the receipt says which one left the color.
        var where = string.Equals(Value("AppPrimaryColor"), lower, StringComparison.OrdinalIgnoreCase) ? "theme values"
            : styleSheet.Contains(lower, StringComparison.OrdinalIgnoreCase) ? "theme style sheet" : null;
        return new JsonObject
        {
            ["themeBefore"] = before, ["theme"] = theme?.Name, ["renamed"] = theme != null && theme.Name == espace.Name,
            ["colorApplied"] = where != null, ["colorIn"] = where, ["styleSheetChars"] = styleSheet.Length,
            ["styleSheetColorMarker"] = styleSheet.Contains("/*primary-color*/", StringComparison.Ordinal),
            ["themeEditor"] = ThemeEditorUsable(espace), ["primaryColor"] = Value("PrimaryColor"),
            ["appPrimaryColor"] = Value("AppPrimaryColor"), ["secondaryColor"] = Value("SecondaryColor"),
        };
    }

    private static bool? ThemeEditorUsable(ESpace espace)
    {
        try { return ServiceStudio.ModelFeatures.ModelFeatures.ThemeEditor.CanBeUsedInServiceStudio(espace); } catch { return null; }
    }

    /// <summary>The icon as the Studio applies it: the module image, the Logo image recreated when something uses it,
    /// and, in a mobile app, the AppIcon image bound to the native splash screen.</summary>
    private static void ApplyIcon(ESpace espace, byte[] icon, JsonArray steps)
    {
        StudioAdapter.Runtime.Mutate(espace, "Set app icon", e =>
        {
            e.Image = icon;
            var logo = e.Images.FirstOrDefault(i => i.Name == "Logo");
            if (logo != null && logo.HasReferers)
            {
                var (name, file) = (logo.Name, logo.OriginalFilename);
                logo.Delete();
                ServiceStudio.Model.Image.Create(name, e, icon, file);
            }
            if (e.IsMobileEspace && !e.IsLibraryEspace)
            {
                var appIcon = ServiceStudio.Presenter.MobileExtensibility.MobileSplashScreen.NativeSplashScreenConfigurationHelper.CreateAppIconImage(e, icon);
                var splash = e.MobileConfigurations?.NativeSplashScreenConfiguration;
                if (appIcon != null && splash != null)
                    ServiceStudio.Presenter.MobileExtensibility.MobileSplashScreen.NativeSplashScreenConfigurationHelper.SetBrandingImage(splash, appIcon);
            }
        });
        steps.Add("Image = icon (Logo recreated when referenced; AppIcon and splash in a mobile app)");
    }

    /// <summary>What a person recognizes as an app: references, flows, screens, themes, blocks, client variables.</summary>
    public static JsonObject Content(ESpace espace)
    {
        var root = (OutSystems.Model.IObjectSignature)espace;
        int Count(string type) { try { return ModelSession.Descendants(root, type).Count; } catch { return -1; } }
        string[] Names(string type) { try { return ModelSession.Descendants(root, type).Select(o => ModelHost.Prop(o, "Name") as string ?? "").Where(n => n.Length > 0).ToArray(); } catch { return []; } }
        return new JsonObject
        {
            ["references"] = new JsonArray(espace.References.Select(r => (JsonNode)r.Name!).ToArray()),
            ["flows"] = new JsonArray(Names("IMobileFlow").Select(n => (JsonNode)n!).ToArray()),
            ["agents"] = Count("IAgent"), ["agentCalls"] = Count("ICallAgentNode"),
            ["screens"] = Count("IMobileScreen"), ["themes"] = Count("IMobileTheme"), ["blocks"] = Count("IMobileBlock"),
            ["clientVariables"] = Count("IClientVariable"), ["images"] = Count("IImage"),
        };
    }

    private static void WriteManifest(string path, OdcAppSpec spec, string module, string moduleKey, string omlPath, string sha, string outDir, string receiptPath)
    {
        // The fields of platforms/odc/studio/shared/Manifest.cs (camelCase), plus appName and kind for the bridge's
        // create-app gate; unknown fields are ignored by the manifest reader.
        var author = spec.Author ?? OdcRuntime.DeveloperId;
        var manifest = new JsonObject
        {
            ["schema"] = "odc3-manifest/1", ["feature"] = "studio_create_app", ["module"] = module, ["moduleKey"] = moduleKey,
            ["appName"] = spec.AppName, ["kind"] = spec.Kind,
            ["tenant"] = spec.Tenant ?? "", ["author"] = author, ["basePath"] = "", ["baseSha256"] = "", ["baseCapturedAt"] = "",
            ["candidatePath"] = omlPath, ["candidateSha256"] = sha, ["owners"] = new JsonArray((JsonNode)author!), ["evidenceDir"] = outDir,
            ["maxBaseAgeMinutes"] = 60, ["changes"] = new JsonArray((JsonNode)("create " + spec.Kind + " app " + spec.AppName)!),
            ["builderReceipt"] = receiptPath, ["smoke"] = false, ["create"] = true,
        };
        if (spec.TemplateKey != null) manifest["templateKey"] = spec.TemplateKey;
        using var f = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        f.Write(System.Text.Encoding.UTF8.GetBytes(manifest.ToJsonString(Json.Pretty)));
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
