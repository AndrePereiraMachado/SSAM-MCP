using System.Diagnostics;
using OutSystems.Communication;
using OutSystems.Communication.ServiceCenter;
using OutSystems.MetaModel.Enumerations;
using OutSystems.ObjectKeys;
using ServiceStudio.Commands;
using ServiceStudio.Model;
using ServiceStudio.Model.API.V1;
using ServiceStudio.Presenter.Commands;

namespace Anvil.Core;

// NativePerformanceMetric/Snapshot/Capture live in Kernel/NativePerformanceCapture.cs since WS1 (platform-neutral diagnostics).

// PublishMessage and PublishOutcome live in Kernel/Adapter/PublishOutcome.cs since WS0 (platform-neutral data).

public sealed record SmokeOutcome(
    string ApplicationName, string ApplicationKey, bool ApplicationOk, string? ApplicationMessage, bool ApplicationExisted,
    string ModuleName, string ModuleKey, string ModuleKind, string OmlPath, long OmlBytes,
    string ActionName, string ActionKey, ValidationSummary Validation, bool IsValid, int Objects,
    bool AddModuleOk, string? AddModuleMessage, CatalogSummary? Catalog,
    PublishOutcome Publish, ModuleSummary? ServerModuleAfter);

public sealed record EditOutcome(
    string ModuleName, string ModuleKey, int VersionBefore, int VersionIdBefore, long BytesIn, long BytesOut,
    string ActionName, string ActionKey, ValidationSummary Validation, bool IsValid,
    PublishOutcome Publish, ModuleSummary? ServerModuleAfter, string SavedOmlPath);

/// <summary>
/// Fase 3: criar app e modulo, mutar o modelo sem GUI e publicar (1-Click Publish)
/// pelo mesmo SOAP que o Studio usa (Start1CP + CheckPublish).
/// </summary>
public static class Publisher
{
    // ---- servidor: aplicacoes -------------------------------------------

    /// <summary>Cria (ou atualiza) uma aplicacao. Devolve a chave e a mensagem do servidor.</summary>
    public static (string Key, bool Ok, string? Message) CreateOrUpdateApplication(
        HeadlessSession s, string name, SegmentationKind kind, string? description = null, string? existingKey = null, string? templateKey = null,
        string? primaryColor = null, byte[]? icon = null)
    {
        s.RequireWrite("CreateOrUpdateApplication");
        if (s.Connected != null) return s.Connected.Call<(string, bool, string?)>("application-save",
            new { name, kind, description, existingKey, templateKey, primaryColor, icon });
        var info = new ApplicationInfo
        {
            Name = name,
            Description = description ?? "",
            Key = existingKey != null ? Keys.Parse(existingKey) : ObjectKey.NewKey(),
            ApplicationKind = kind,
            IsActive = true,
            TemplateKey = templateKey != null ? Keys.Parse(templateKey) : null,
            PrimaryColor = primaryColor ?? "",
            Icon = icon,
        };
        var ok = s.Client.CreateOrUpdateApplication(s.Username, s.Secret, info, out var msg);
        return (info.Key.ToString(), ok, msg?.Message);
    }

    public static (bool Ok, string? Message) AddModuleToApplication(HeadlessSession s, string appKey, string moduleKey)
    {
        s.RequireWrite("AddModuleToApplication");
        if (s.Connected != null) return s.Connected.Call<(bool, string?)>("module-associate", new { appKey, moduleKey });
        var ok = s.Client.AddModuleToApplication(s.Username, s.Secret, appKey, "eSpace", moduleKey, out var msg);
        return (ok, msg?.Message);
    }

    public sealed record DeleteOutcome(bool Ok, bool Simulated, IReadOnlyList<string> Messages, IReadOnlyList<string> AffectedApplications, IReadOnlyList<string> DeletedModules);

    /// <summary>Apaga uma app (e seus modulos). Com simulate=true o servidor so relata o impacto.</summary>
    public static DeleteOutcome DeleteApplication(HeadlessSession s, string appKey, bool simulate = true)
    {
        s.RequireWrite("DeleteApplication");
        if (s.Connected != null) return s.Connected.Call<DeleteOutcome>("application-delete", new { appKey, simulate });
        var ok = s.Client.DeleteApplication(s.Username, s.Secret, appKey, simulate, out var msgs, out var affected, out var deleted);
        return new DeleteOutcome(ok, simulate,
            (msgs ?? Array.Empty<IMessage>()).Select(m => { var x = ToMessage(m); return $"{x.Type}: {x.Message}{(string.IsNullOrEmpty(x.Detail) ? "" : " | " + x.Detail)}"; }).ToList(),
            (affected ?? Array.Empty<string>()).ToList(), (deleted ?? Array.Empty<string>()).ToList());
    }

    /// <summary>Apaga um modulo (eSpace). Nao tem simulacao no SOAP: so chamar com confirmacao explicita.</summary>
    public static (bool Ok, string? Message) DeleteModule(HeadlessSession s, string moduleKey)
    {
        s.RequireWrite("DeleteModule");
        if (s.Connected != null) return s.Connected.Call<(bool, string?)>("module-delete", new { moduleKey });
        var ok = s.Client.DeleteModule(s.Username, s.Secret, moduleKey, "eSpace", out var msg);
        return (ok, msg?.Message);
    }

    // ---- modelo: criar modulo e mutar ------------------------------------

    /// <summary>
    /// Modulo novo em memoria com os objetos iniciais do tipo (ESpace.Create). ATENCAO:
    /// o parametro `appKey` de ESpace.Create e usado como chave DO PROPRIO MODULO
    /// (ctor: base(null, appKey, ...)); passar a chave da app faz modulo e app terem
    /// a mesma chave. A associacao com a app e feita no servidor (AddModuleToApplication
    /// + PublishOptions.ApplicationKey). Aqui deixamos o Studio gerar a chave.
    /// </summary>
    /// <summary>Modulo em branco como o "New Module" do Studio (Presenter prs#xumsmgkx): ESpace.Create + user provider
    /// no afterCreateAction. Sem user provider, Service fica sem provider e Library fica com a chave placeholder
    /// (UserManagementProviderEspaceKey, do ExtraOnAfterInit) e o publish avisa "Missing User Provider".</summary>
    public static ESpace CreateModule(ModelHost host, string name, SegmentationKind kind, string description = "",
        string? userProviderName = "Users", string? userProviderKey = null)
        => ESpace.Create(name, null, kind, isTemplatesBundleESpace: false,
            afterCreateAction: userProviderName == null ? null : e => ApplyUserProvider(e, userProviderName, userProviderKey),
            targetPlatform: PlatformServerVersion.V11, appKey: null, moduleDescription: description);

    private static void ApplyUserProvider(ESpace e, string name, string? key)
    {
        e.UserProviderESpaceName = name;
        e.UserProviderESpaceKey = key != null ? Keys.Parse(key) : OutSystems.RuntimeCommon.Constants.UsersESpaceKey;
    }

    /// <summary>Troca o user provider de um modulo ja publicado (download -> mutacao -> publish).</summary>
    public static EditOutcome SetUserProviderAndRepublish(HeadlessSession s, ModelHost host, string moduleNameOrKey, string outDir,
        string? userProviderName = null, string? userProviderKey = null, Action<string>? log = null)
    {
        var (defName, defKey) = HeadlessSession.DefaultUserProvider;
        var name = userProviderName ?? defName;
        var key = userProviderKey ?? (userProviderName == null ? defKey : null);
        if (key == null)
        {
            var found = s.ListReferenceable().FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase) && r.Kind == "eSpace")
                ?? throw new KeyNotFoundException("user provider module not found on server: " + name);
            key = found.Key;
        }
        return EditAndRepublish(s, host, moduleNameOrKey, e => ApplyUserProvider(e, name, key), $"set user provider {name}", outDir,
            $"SSHeadless: user provider {name}", log);
    }

    /// <summary>
    /// Executa uma mutacao dentro de um comando do Studio sem GUI: e o que o Model API
    /// faz (PrepareForSave + MockAggregatorPresenter + MockPresenter + Command.Execute).
    /// Fora de comando o modelo lanca "No command is open".
    /// </summary>
    public static void Mutate(ESpace espace, string description, Action<ESpace> mutation)
    {
        using var totalTiming = NativePerformanceCapture.Measure("mutation.total", cpu: true);
        // ESpace.PrepareForSave e internal (IESpaceServices.PrepareForCommandExecution); reflexao
        using (NativePerformanceCapture.Measure("mutation.prepareForSave", cpu: true))
            typeof(ESpace).GetMethod("PrepareForSave", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public, Type.EmptyTypes)
                ?.Invoke(espace, null);
        using var aggregator = new MockAggregatorPresenter(espace, null, registerAsStaticInstance: false);
        var presenter = new MockPresenter(aggregator);
        try
        {
            using var commandTiming = NativePerformanceCapture.Measure("mutation.command", cpu: true);
            Command.Execute(presenter.GetPresenterContext(), description, () =>
            {
                using var callbackTiming = NativePerformanceCapture.Measure("mutation.callback", cpu: true);
                mutation(espace);
            });
        }
        finally
        {
            // SEGUNDA RAIZ de memoria do worker (medida 2026-09-04): Command.Execute regista o comando no UndoManager (estatico),
            // indexado por ESTE aggregator, com o grafo inteiro que a mutacao criou (1 MB num modulo pequeno, 25 MB no app de
            // tickets, por pedido). Dispose do aggregator nao limpa o historico; ClearHistory limpa undo, redo e pendentes.
            using var historyTiming = NativePerformanceCapture.Measure("mutation.clearHistory", cpu: true);
            try { ServiceStudio.Undo.UndoManager.ClearHistory(aggregator); } catch { /* sem historico para este aggregator */ }
        }
    }

    /// <summary>Server Action publica com Start e End ligados; devolve a chave.</summary>
    public static string AddServerAction(ESpace espace, string name, bool isPublic = true)
    {
        string? key = null;
        Mutate(espace, $"SSHeadless: add server action {name}", e =>
        {
            var action = ((OutSystems.Model.IESpace)e).CreateServerAction(name);
            action.AddStartEndNodes();
            action.Public = isPublic;
            key = action.ObjectKey.ToString();
        });
        return key!;
    }

    /// <summary>Versao para usar DENTRO de um Mutate ja aberto (nao abre outro comando).</summary>
    public static string AddServerActionInCurrentCommand(ESpace espace, string name, bool isPublic = true)
    {
        var action = ((OutSystems.Model.IESpace)espace).CreateServerAction(name);
        action.AddStartEndNodes();
        action.Public = isPublic;
        return action.ObjectKey.ToString();
    }

    // ---- servidor: publish ------------------------------------------------

    /// <summary>Start1CP + poll de CheckPublish ate completar. Erros de compilacao vem em Messages.</summary>
    public static PublishOutcome Publish(HeadlessSession s, byte[] oml, string appKey, int? catalogId, string commitMessage,
        TimeSpan? timeout = null, Action<string>? progress = null)
    {
        var result = PublicationBatch.Run(1,
            _ => StartPublish(s, oml, appKey, catalogId, commitMessage, progress),
            (_, previous) => CheckPublish(s, previous, progress), timeout)[0];
        if (result.Error != null) throw new InvalidOperationException(result.Error);
        return result.Outcome;
    }

    /// <summary>Upload and start a server job; do not wait for compilation/deployment.</summary>
    public static PublishOutcome StartPublish(HeadlessSession s, byte[] oml, string appKey, int? catalogId,
        string commitMessage, Action<string>? progress = null)
    {
        s.RequireWrite("Publish");
        if (s.Connected != null) return s.Connected.Call<PublishOutcome>("publish-start", new { oml, appKey, catalogId, commitMessage });
        var sw = Stopwatch.StartNew();
        var options = new PublishOptions
        {
            ApplicationKey = ObjectKey.Parse(appKey),
            CatalogId = catalogId,
            ReplaceExisting = true,
            CommitMessage = commitMessage,
            CheckServerVersion = false,
            AbortOnNewBrokenReferences = false,
            ReuseTables = false,
        };
        var version = NewModuleVersion(oml);
        var result = s.Client.Start1CP(s.Username, s.Secret, version, options);
        var startMs = sw.ElapsedMilliseconds;
        var messages = new List<PublishMessage>();
        foreach (var m in result.Messages ?? Array.Empty<IMessage>()) messages.Add(ToMessage(m));
        progress?.Invoke($"Start1CP: hasErrors={result.HasErrors} espaceId={result.ESpaceId} versionId={result.VersionId} key={result.Key} ({startMs} ms, {messages.Count} messages)");
        if (result.HasErrors || result.VersionId <= 0)
            return new PublishOutcome(false, result.HasErrors, false, result.ESpaceId, result.VersionId, result.Key, messages, startMs, sw.ElapsedMilliseconds);

        return new PublishOutcome(true, false, false, result.ESpaceId, result.VersionId, result.Key, messages, startMs, sw.ElapsedMilliseconds);
    }

    public static PublishOutcome CheckPublish(HeadlessSession s, PublishOutcome previous, Action<string>? progress = null)
    {
        if (!previous.Started || previous.Completed || previous.HasErrors) return previous;
        if (s.Connected != null) return s.Connected.Call<PublishOutcome>("publish-check", new { previous });
        var batch = s.Client.CheckPublishAsync(s.Username, s.Secret, previous.VersionId, out var completed);
        var messages = previous.Messages.ToList();
        foreach (var m in batch ?? Array.Empty<IMessage>())
        {
            var message = ToMessage(m);
            messages.Add(message);
            progress?.Invoke($"  {message.Type}: {message.Message}");
        }
        var hasErrors = messages.Any(m => m.Type.Contains("Error", StringComparison.OrdinalIgnoreCase));
        return previous with { Completed = completed, HasErrors = hasErrors, Messages = messages };
    }

    /// <summary>
    /// Cenario ponta a ponta: app (Service) + modulo (Service) + uma Server Action publica
    /// + publish + releitura do inventario. Nomes com prefixo ZZ por convencao de teste.
    /// </summary>
    public static SmokeOutcome SmokePublish(HeadlessSession s, ModelHost host, string appName, string moduleName, string actionName, string outDir, Action<string>? log = null)
    {
        Directory.CreateDirectory(outDir);
        var existing = s.FindApplication(appName);
        var (appKey, appOk, appMsg) = CreateOrUpdateApplication(s, appName, SegmentationKind.Service, "SSHeadless smoke (fase 3)", existing?.Key);
        log?.Invoke($"application {appName}: key={appKey} ok={appOk} msg={appMsg} existed={existing != null}");

        var espace = CreateModule(host, moduleName, SegmentationKind.Service, "SSHeadless smoke module");
        log?.Invoke($"module in memory: {espace.Name} key={espace.Key} kind={espace.ESpaceType}");
        var actionKey = AddServerAction(espace, actionName, isPublic: true);
        log?.Invoke($"server action {actionName}: {actionKey}");
        var snap = ModelHost.Describe(espace, 0);
        log?.Invoke($"verify: {snap.Validation.Total} messages ({string.Join(", ", snap.Validation.ByType.Select(k => k.Key + "=" + k.Value))}) isValid={snap.IsValid} objects={snap.Objects}");
        var bytes = host.Save(espace);
        var omlPath = Path.Combine(outDir, moduleName + ".oml");
        File.WriteAllBytes(omlPath, bytes);
        log?.Invoke($"saved {bytes.Length} bytes -> {omlPath}");

        // Ordem provada: o servidor so conhece o modulo depois do primeiro publish
        // (AddModuleToApplication antes devolve "Module Not Found"); PublishOptions.ApplicationKey
        // ja associa. A associacao explicita fica como reforco quando o inventario nao confirmar.
        var catalog = s.ListCatalogs().FirstOrDefault();
        var outcome = Publish(s, bytes, appKey, catalog?.Id, "SSHeadless smoke publish", progress: log);
        log?.Invoke($"publish: started={outcome.Started} completed={outcome.Completed} hasErrors={outcome.HasErrors} versionId={outcome.VersionId} total {outcome.TotalMs} ms");
        var after = s.ListModules(refresh: true).FirstOrDefault(m => string.Equals(m.Name, moduleName, StringComparison.OrdinalIgnoreCase));
        var addOk = after != null && string.Equals(after.ApplicationName, appName, StringComparison.OrdinalIgnoreCase);
        string? addMsg = addOk ? "associated by publish" : null;
        if (!addOk && after != null)
        {
            (addOk, addMsg) = AddModuleToApplication(s, appKey, after.Key);
            log?.Invoke($"add module to app after publish: ok={addOk} msg={addMsg}");
            after = s.ListModules(refresh: true).FirstOrDefault(m => string.Equals(m.Name, moduleName, StringComparison.OrdinalIgnoreCase));
        }
        return new SmokeOutcome(appName, appKey, appOk, appMsg, existing != null,
            moduleName, espace.Key.ToString(), espace.ESpaceType.ToString(), omlPath, bytes.Length,
            actionName, actionKey, snap.Validation, snap.IsValid, snap.Objects,
            addOk, addMsg, catalog, outcome, after);
    }

    /// <summary>
    /// Edita um modulo EXISTENTE do servidor sem GUI: download -> load -> mutacao -> save -> publish.
    /// Prova o ciclo "modificar e republicar" que hoje exige o Studio aberto.
    /// </summary>
    public static EditOutcome EditAndRepublish(HeadlessSession s, ModelHost host, string moduleNameOrKey, Action<ESpace> mutation,
        string mutationDescription, string outDir, string commitMessage, Action<string>? log = null)
    {
        Directory.CreateDirectory(outDir);
        var module = s.FindModule(moduleNameOrKey) ?? throw new KeyNotFoundException($"module not found: {moduleNameOrKey}");
        var dl = s.Download(module, outputDirectory: null);
        if (dl.Status != "ok") throw new InvalidOperationException($"download failed: {dl.Status}");
        var bytes = File.Exists(dl.FilePath ?? "") ? File.ReadAllBytes(dl.FilePath!) : DownloadBytes(s, module);
        log?.Invoke($"downloaded {module.Name} v{module.Version} (versionId {module.VersionId}): {bytes.Length} bytes");

        var espace = host.Load(bytes);
        log?.Invoke($"loaded {espace.Name} key={espace.Key}");
        Mutate(espace, mutationDescription, mutation);
        var snap = ModelHost.Describe(espace, 0);
        log?.Invoke($"after mutation: {snap.Objects} objects, {snap.Validation.Total} messages, isValid={snap.IsValid}");
        var saved = host.Save(espace);
        var savedPath = Path.Combine(outDir, module.Name + ".edited.oml");
        File.WriteAllBytes(savedPath, saved);

        var appKey = module.ApplicationKey ?? throw new InvalidOperationException("module without application key");
        var catalog = s.ListCatalogs().FirstOrDefault();
        var outcome = Publish(s, saved, appKey, catalog?.Id, commitMessage, progress: log);
        log?.Invoke($"publish: started={outcome.Started} completed={outcome.Completed} hasErrors={outcome.HasErrors} versionId={outcome.VersionId} total {outcome.TotalMs} ms");
        var after = s.ListModules(refresh: true).FirstOrDefault(m => m.Key == module.Key);
        return new EditOutcome(module.Name, module.Key, module.Version, module.VersionId, bytes.Length, saved.Length,
            "", "", snap.Validation, snap.IsValid, outcome, after, savedPath);
    }

    /// <summary>Receita pronta para o CLI/runner: baixa, adiciona uma Server Action publica e republica.</summary>
    public static EditOutcome AddServerActionAndRepublish(HeadlessSession s, ModelHost host, string moduleNameOrKey, string actionName, string outDir, Action<string>? log = null)
    {
        string key = "";
        var r = EditAndRepublish(s, host, moduleNameOrKey, e => key = AddServerActionInCurrentCommand(e, actionName, isPublic: true),
            $"SSHeadless: add server action {actionName}", outDir, $"SSHeadless: add server action {actionName}", log);
        return r with { ActionName = actionName, ActionKey = key };
    }

    private static byte[] DownloadBytes(HeadlessSession s, ModuleSummary module)
    {
        var tmp = Path.Combine(Path.GetTempPath(), "sshedless-dl");
        var r = s.Download(module, tmp);
        if (r.Status != "ok" || r.FilePath == null) throw new InvalidOperationException("download failed: " + r.Status);
        return File.ReadAllBytes(r.FilePath);
    }

    /// <summary>ModuleVersion so tem construtor com parametros (kind, versionId, binary); resolve por tipo.</summary>
    private static ModuleVersion NewModuleVersion(byte[] oml)
    {
        var ctors = typeof(ModuleVersion).GetConstructors();
        foreach (var ctor in ctors.OrderByDescending(c => c.GetParameters().Length))
        {
            var ps = ctor.GetParameters();
            if (!ps.Any(x => x.ParameterType == typeof(byte[]))) continue;
            var args = new object?[ps.Length];
            for (var i = 0; i < ps.Length; i++)
            {
                var t = ps[i].ParameterType;
                if (t == typeof(byte[])) args[i] = oml;
                else if (t == typeof(int)) args[i] = 0;
                else if (t == typeof(bool)) args[i] = false;
                else if (t.IsEnum) args[i] = Enum.Parse(t, "eSpace");
                else args[i] = t.IsValueType ? Activator.CreateInstance(t) : null;
            }
            return (ModuleVersion)ctor.Invoke(args);
        }
        throw new InvalidOperationException("no ModuleVersion constructor taking byte[] found: " + string.Join(" | ", ctors.Select(c => string.Join(",", c.GetParameters().Select(x => x.ParameterType.Name)))));
    }

    private static PublishMessage ToMessage(IMessage m)
    {
        string? id = null, detail = null; var type = "?"; var text = "";
        try { id = m.Id; } catch { }
        try { type = m.Type.ToString(); } catch { }
        try { text = m.Message ?? ""; } catch { }
        try { detail = m.Detail; } catch { }
        return new PublishMessage(id, type, text, detail);
    }
}
