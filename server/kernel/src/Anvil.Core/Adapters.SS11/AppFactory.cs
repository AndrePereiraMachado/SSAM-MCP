using System.Diagnostics;
using OutSystems.MetaModel.Enumerations;

namespace Anvil.Core;

public sealed record ModuleSpec(string Name, string Kind);   // Kind: Reactive | Service | Library | Traditional | Mobile

/// <summary>Template: the template key the module came from, or "blank" (null for a module that already existed).
/// LayoutBlank and Content: the saved module has the LayoutBlank block (own or referenced) and its Content placeholder
/// (A16 receipt: a UI module without them cannot take a screen).</summary>
public sealed record ModuleCreationOutcome(
    string Name, string Kind, string? Key, int Objects, ValidationSummary? Validation, bool IsValid,
    long OmlBytes, string? OmlPath, PublishOutcome? Publish, ModuleSummary? ServerModuleAfter, string? Error,
    long PreparationMs = 0, long? PublishStartOffsetMs = null, bool Skipped = false,
    string? Template = null, bool? LayoutBlank = null, bool? Content = null)
{
    public bool Succeeded => Error == null && IsValid && ServerModuleAfter?.Key == Key &&
        (Skipped || Publish is { Started: true, Completed: true, HasErrors: false });
}

public sealed record ApplicationCreationOutcome(
    string ApplicationName, string ApplicationKey, bool ApplicationOk, string? ApplicationMessage, bool ApplicationExisted,
    string ApplicationKind, string? TemplateKey, IReadOnlyList<ModuleCreationOutcome> Modules, string? Host = null)
{
    public bool Succeeded => ApplicationOk && Modules.All(m => m.Succeeded);
}

/// <summary>
/// App + N modulos, sem GUI. Modulos de UI vem do template da app (TemplateModules, o
/// "New Module" do Studio); Service/Library em branco (ESpace.Create, o "New Blank Module").
/// A app recebe cor primaria: sem ela, o tema do modulo novo nasce com "PropertyValue must be set".
/// </summary>
public static class AppFactory
{
    /// <summary>Chave do template "Reactive Web App" observada em todas as apps reativas de personal-2qqw9srv.</summary>
    public const string DefaultReactiveTemplateKey = "Wrm0V2ZyskqM7KobRok75w";

    /// <summary>Cor primaria que o Studio da as apps novas neste ambiente (LogicIrUi, Kanban). Sem cor, o
    /// "New Module" do Studio gera um tema com propriedades obrigatorias vazias (3x "PropertyValue must be set").</summary>
    public const string DefaultPrimaryColor = "#2E86C1";

    /// <summary>Atualiza nome/descricao/cor/icone de uma app existente (CreateOrUpdateApplication com a mesma chave).</summary>
    public static (string Key, bool Ok, string? Message) UpdateApplication(HeadlessSession s, string nameOrKey, string? primaryColor = null, byte[]? icon = null, string? description = null)
    {
        var app = s.FindApplication(nameOrKey) ?? throw new KeyNotFoundException("application not found: " + nameOrKey);
        return Publisher.CreateOrUpdateApplication(s, app.Name, ParseKind(app.Kind ?? "Reactive"), description ?? app.Description, app.Key, app.TemplateKey,
            primaryColor ?? app.PrimaryColor, icon);
    }

    public static SegmentationKind ParseKind(string kind) => kind.Trim().ToLowerInvariant() switch
    {
        "reactive" or "crossdevice" or "reactiveweb" => SegmentationKind.CrossDevice,
        "service" => SegmentationKind.Service,
        "library" or "reactivelibrary" => SegmentationKind.ReactiveLibrary,
        "traditional" or "webresponsive" or "web" => SegmentationKind.WebResponsive,
        "mobile" => SegmentationKind.Mobile,
        _ => throw new ArgumentException("unknown module kind: " + kind),
    };

    /// <summary>The label the Studio shows for a module type ("Reactive Web App", never the enum name CrossDevice), used in
    /// descriptions and receipts (A16: the user read "CrossDevice" and took the modules for the wrong type).</summary>
    public static string PlatformLabel(SegmentationKind kind) => kind switch
    {
        SegmentationKind.CrossDevice => "Reactive Web App",
        SegmentationKind.WebResponsive => "Traditional Web App",
        SegmentationKind.Mobile => "Mobile App",
        SegmentationKind.Service => "Service",
        SegmentationKind.ReactiveLibrary => "Library",
        _ => kind.ToString(),
    };

    /// <summary>PlatformLabel of a module kind as the tools spell it (Reactive, Service, Library, Traditional, Mobile).</summary>
    public static string KindLabel(string kind) => PlatformLabel(ParseKind(kind));

    /// <summary>Kinds that are UI modules: they come from the application template, never blank.</summary>
    public static bool IsUiKind(SegmentationKind kind) =>
        kind is SegmentationKind.CrossDevice or SegmentationKind.Mobile or SegmentationKind.WebResponsive;

    /// <summary>A16: blank creates only Service and Library modules. The UI modules of a blank request, by name (empty when
    /// blank is off or every module is Service/Library). Unknown kinds are left to ValidateSpecs.</summary>
    public static string[] BlankUiModules(IEnumerable<ModuleSpec> modules, bool blankModules)
    {
        if (!blankModules) return [];
        return modules.Where(m => { try { return IsUiKind(ParseKind(m.Kind)); } catch (ArgumentException) { return false; } })
            .Select(m => m.Name).ToArray();
    }

    /// <summary>Refuses a blank request with a UI module before anything reaches the environment (BLANK_UI_MODULE, one
    /// problem per module, fix "omit blank"). The facade refuses the same before the CLI (o11-environment.mjs).</summary>
    public static void RefuseBlankUi(IEnumerable<ModuleSpec> modules, bool blankModules)
    {
        var specs = modules.ToArray();
        var ui = BlankUiModules(specs, blankModules);
        if (ui.Length == 0) return;
        var problems = new System.Text.Json.Nodes.JsonArray(specs.Where(s => ui.Contains(s.Name)).Select(s => (System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonObject
        {
            ["code"] = "BLANK_UI_MODULE", ["module"] = s.Name, ["kind"] = PlatformLabel(ParseKind(s.Kind)),
            ["message"] = $"{s.Name} is a {PlatformLabel(ParseKind(s.Kind))} module: blank would create it without theme, layouts, LayoutBlank and its Content placeholder",
            ["fix"] = "omit blank",
        }).ToArray());
        throw new KernelRefusalException("BLANK_UI_MODULE",
            "blank creates only Service and Library modules; omit blank for " + string.Join(", ", ui) + " (UI modules come from the application template); nothing was created", problems);
    }

    /// <summary>Adiciona modulos a uma app existente (UI do template da app; Service/Library em branco).</summary>
    public static IReadOnlyList<ModuleCreationOutcome> AddModulesToApplication(HeadlessSession s, ModelHost host, string appKey, string? templateKey,
        IEnumerable<ModuleSpec> modules, string outDir, bool blankModules = false, Action<string>? log = null)
    {
        s.RequireWrite("AddModulesToApplication");
        var specs = ValidateSpecs(modules);
        RefuseBlankUi(specs, blankModules);
        Directory.CreateDirectory(outDir);
        var results = new List<ModuleCreationOutcome>();
        if (specs.Length == 0) return results;
        var catalog = s.ListCatalogs().FirstOrDefault();
        var inventory = s.ListModules(refresh: true);
        var up = (templateKey != null ? s.GetTemplateUserProvider(templateKey) : null) ?? HeadlessSession.DefaultUserProvider;
        (byte[] Oml, string FreshName)? templateSource = null;
        log?.Invoke($"preparing {specs.Length} modules before publication");
        foreach (var spec in specs)
        {
            var timer = Stopwatch.StartNew();
            var mk = ParseKind(spec.Kind);
            try
            {
                var already = inventory.FirstOrDefault(m => string.Equals(m.Name, spec.Name, StringComparison.OrdinalIgnoreCase));
                if (already != null)
                {
                    var sameApp = already.ApplicationKey == appKey;
                    results.Add(new(spec.Name, mk.ToString(), already.Key, 0, null, true, 0, null, null, already,
                        sameApp ? null : $"Module already belongs to another application: {already.ApplicationName}",
                        timer.ElapsedMilliseconds, Skipped: sameApp));
                    log?.Invoke($"module {spec.Name} already exists; {(sameApp ? "skipping" : "name conflict")}");
                    continue;
                }
                if (!blankModules && templateKey != null && IsUiKind(mk))
                {
                    templateSource ??= TemplateModules.DownloadTemplateModule(s, templateKey);
                    var t = TemplateModules.CreateModuleFromTemplate(s, host, appKey, spec.Name, outDir, templateKey, null,
                        spec.Name + " (" + PlatformLabel(mk) + ") created headless by SSAM from the application template",
                        publish: false, log: log, templateSource: templateSource);
                    results.Add(new(spec.Name, mk.ToString(), t.ModuleKey, t.Objects, t.Validation, t.IsValid,
                        t.OmlBytes, t.OmlPath, null, null, null, timer.ElapsedMilliseconds,
                        Template: templateKey, LayoutBlank: t.LayoutBlank, Content: t.Content));
                }
                else
                {
                    var espace = Publisher.CreateModule(host, spec.Name, mk,
                        spec.Name + " (" + PlatformLabel(mk) + ") created headless by SSAM", up.Name, up.Key);
                    try
                    {
                        var snap = ModelHost.Describe(espace, 0);
                        var layout = ModuleLayout.Inspect(espace);
                        var bytes = host.Save(espace);
                        var omlPath = Path.Combine(outDir, spec.Name + ".oml");
                        File.WriteAllBytes(omlPath, bytes);
                        results.Add(new(spec.Name, mk.ToString(), espace.Key.ToString(), snap.Objects, snap.Validation,
                            snap.IsValid, bytes.Length, omlPath, null, null, null, timer.ElapsedMilliseconds,
                            Template: ModuleLayout.Blank, LayoutBlank: layout.LayoutBlank, Content: layout.Content));
                    }
                    finally { ModelHost.Release(espace); }
                }
                log?.Invoke($"prepared {spec.Name}: valid={results[^1].IsValid} {timer.ElapsedMilliseconds} ms");
            }
            catch (Exception ex)
            {
                results.Add(new(spec.Name, mk.ToString(), null, 0, null, false, 0, null, null, null,
                    ex.GetType().Name + ": " + ex.Message, timer.ElapsedMilliseconds));
                log?.Invoke($"prepare {spec.Name} failed: {ex.Message}");
            }
        }
        if (results.Any(m => m.Error != null || !m.IsValid))
            return results.Select(m => m.Skipped ? m : m with {
                Error = m.Error ?? "Batch preparation failed; no new module was submitted for publication" }).ToArray();

        var pending = results.Select((m, i) => (Module: m, Index: i)).Where(x => !x.Module.Skipped).ToArray();
        var published = PublicationBatch.Run(pending.Length,
            i => Publisher.StartPublish(s, File.ReadAllBytes(pending[i].Module.OmlPath!), appKey, catalog?.Id,
                "SSHeadless: create " + pending[i].Module.Name, message => log?.Invoke($"{pending[i].Module.Name}: {message}")),
            (i, previous) => Publisher.CheckPublish(s, previous, message => log?.Invoke($"{pending[i].Module.Name}: {message}")));
        for (var i = 0; i < pending.Length; i++)
        {
            var result = published[i];
            results[pending[i].Index] = pending[i].Module with { Publish = result.Outcome,
                PublishStartOffsetMs = result.StartOffsetMs, Error = result.Error };
            log?.Invoke($"publish {pending[i].Module.Name}: completed={result.Outcome.Completed} errors={result.Outcome.HasErrors} " +
                $"startOffset={result.StartOffsetMs} ms total={result.Outcome.TotalMs} ms {result.Error}");
        }
        // One final inventory request, preserving all publication receipts even if it fails.
        if (pending.Length > 0)
        {
            try
            {
                var after = s.ListModules(refresh: true);
                foreach (var (_, index) in pending)
                {
                    var m = results[index];
                    results[index] = m with { ServerModuleAfter = after.FirstOrDefault(x => x.Key == m.Key) };
                }
            }
            catch (Exception ex)
            {
                foreach (var (_, index) in pending)
                    results[index] = results[index] with { Error = results[index].Error ?? "Final inventory failed: " + ex.Message };
            }
        }
        return results;
    }

    private static ModuleSpec[] ValidateSpecs(IEnumerable<ModuleSpec> modules)
    {
        var specs = modules.ToArray();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var spec in specs)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(spec.Name, @"^[A-Za-z_][A-Za-z0-9_]*$"))
                throw new ArgumentException("Invalid module name: " + spec.Name);
            if (!names.Add(spec.Name)) throw new ArgumentException("Duplicate module name: " + spec.Name);
            _ = ParseKind(spec.Kind);
        }
        return specs;
    }

    public static ApplicationCreationOutcome CreateApplicationWithModules(
        HeadlessSession s, ModelHost host, string appName, string appKind, IEnumerable<ModuleSpec> modules,
        string outDir, string? templateKey = null, Action<string>? log = null, string? primaryColor = null, byte[]? icon = null, bool blankModules = false,
        string? preferTemplateLabel = null)
    {
        var specs = ValidateSpecs(modules);
        // Before the application is saved: a refused request creates nothing.
        RefuseBlankUi(specs, blankModules);
        Directory.CreateDirectory(outDir);
        var kind = ParseKind(appKind);
        var existing = s.FindApplication(appName);
        var tpl = templateKey ?? (kind == SegmentationKind.Service || kind == SegmentationKind.ReactiveLibrary ? null
            : s.FindTemplateForKind(kind.ToString(), preferTemplateLabel)?.Key ?? (kind == SegmentationKind.CrossDevice ? DefaultReactiveTemplateKey : null));
        var (appKey, appOk, appMsg) = Publisher.CreateOrUpdateApplication(
            s, appName, kind, "Created headless by SSAM " + DateTime.UtcNow.ToString("u"), existing?.Key, tpl,
            primaryColor ?? existing?.PrimaryColor ?? DefaultPrimaryColor, icon);
        log?.Invoke($"application {appName} ({kind}): key={appKey} ok={appOk} msg={appMsg} existed={existing != null} template={tpl}");

        var results = appOk ? AddModulesToApplication(s, host, appKey, tpl, specs, outDir, blankModules, log)
            : Array.Empty<ModuleCreationOutcome>();
        return new ApplicationCreationOutcome(appName, appKey, appOk, appMsg, existing != null, kind.ToString(), tpl, results);
    }
}
