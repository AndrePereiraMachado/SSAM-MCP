using System.Diagnostics;
using OutSystems.Communication.Identity;
using OutSystems.Communication.Identity.Login;
using OutSystems.Communication.ServiceCenter;
using OutSystems.Communication.WebServices;

namespace Anvil.Core;

/// <summary>
/// Sessao autenticada com o Service Center de UM ambiente O11, pelo mesmo cliente
/// SOAP que o Service Studio usa no "Open from environment" (OutSystems.Communication).
/// Nao precisa do Runtime do Studio: so das DLLs de comunicacao.
///
/// Sequencia provada em 2026-09-03 (personal-2qqw9srv, servidor 11.41, IDE 11.55.69):
///   HostInfo.GetHostInfo -> WebServicesFactory.CreateServiceCenterWebService ->
///   GetPropertiesForHandshake["HubServerVersion"] -> LoginInfoWithPassword.GetSecretForWebServiceRequest
///   -> Handshake -> ListApplications / ListEspaces / ListCatalogs / ListReferenceable / Download.
/// </summary>
/// <summary>Stands in for the Service Center client of a connected session. Operations that run in the Studio are
/// routed before any client call; anything else fails here with an explicit message instead of a null reference.</summary>
public class ConnectedOnlyClient : System.Reflection.DispatchProxy
{
    public static IServiceCenter Create() => Create<IServiceCenter, ConnectedOnlyClient>();

    protected override object? Invoke(System.Reflection.MethodInfo? targetMethod, object?[]? args)
        => throw new NotSupportedException($"'{targetMethod?.Name}' has no connected-Studio operation " +
            $"(supported: {string.Join(", ", EnvironmentOperations.Names)}); use --credentials for this command");
}

public sealed class HeadlessSession : IDisposable
{
    private readonly IServiceCenter _sc;
    private readonly string _secret;
    private readonly LoginInfoWithPassword _login;
    private readonly object? _borrowedLogin;
    private readonly bool _ownsClient = true;
    internal ConnectedEnvironment? Connected { get; }
    private ModuleInfo[]? _modulesCache;
    private ApplicationInfo[]? _appsCache;

    public string Host { get; }
    public string Username { get; }
    /// <summary>Do arquivo de credenciais (`readOnly: true`) ou de `--read-only`: escrita recusada no cliente.</summary>
    public bool IsReadOnly { get; private set; }
    public void MarkReadOnly() => IsReadOnly = true;
    /// <summary>Chamado por todo verbo de escrita antes de falar com o servidor.</summary>
    public void RequireWrite(string verb)
    {
        if (IsReadOnly) throw new InvalidOperationException($"read-only environment {Host}: '{verb}' refused before reaching the server");
    }
    public Version? ServerVersion { get; }
    public string IdeVersion { get; }
    public bool HandshakeOk { get; }
    public string? HandshakeError { get; }
    public IReadOnlyDictionary<string, string> ServerProperties { get; }
    public long ConnectMs { get; }

    /// <summary>Cliente SOAP e segredo por chamada, para as operacoes de Publisher.</summary>
    internal IServiceCenter Client => _sc;
    internal string Secret => _secret;
    internal LoginInfoWithPassword Login => _login;
    internal HostInfo HostInfo => _borrowedLogin == null ? _login.HostInfo :
        (HostInfo)_borrowedLogin.GetType().GetProperty("HostInfo")!.GetValue(_borrowedLogin)!;

    private HeadlessSession(ConnectedEnvironment connected)
    {
        Connected = connected; _sc = ConnectedOnlyClient.Create(); _secret = ""; _login = null!;
        Host = connected.Host; Username = connected.Username; IdeVersion = connected.IdeVersion;
        ServerVersion = connected.ServerVersion; HandshakeOk = true;
        ServerProperties = new Dictionary<string, string>(); IsReadOnly = connected.ReadOnly;
        _ownsClient = false;
    }

    /// <summary>Use the current Studio login. No credential file or alternate login.</summary>
    public static HeadlessSession ConnectStudio(Anvil.Core.Delivery.IBridgeClient bridge,
        string? host = null, string? module = null, bool readOnly = false)
        => new(new ConnectedEnvironment(bridge, host, module, readOnly));

    /// <summary>For the in-Studio transport only. Never owns or disposes Studio's client. The provider is the
    /// Studio's logged-in ServerCommunicationsProvider, used only by the Edit Data operations.</summary>
    public static HeadlessSession Borrow(IServiceCenter client, object login, string host, string user, string secret, bool readOnly,
        object? provider = null)
        => new(client, login, host, user, secret, readOnly) { StudioProvider = provider };

    /// <summary>Studio-side only: the provider of the borrowed login (null in the CLI and with --credentials).</summary>
    internal object? StudioProvider { get; private init; }

    private HeadlessSession(IServiceCenter client, object login, string host, string user, string secret, bool readOnly)
    {
        _sc = client; _borrowedLogin = login; _login = null!; _secret = secret; _ownsClient = false;
        Host = host; Username = user;
        IdeVersion = FileVersionInfo.GetVersionInfo(Path.Combine(Path.GetDirectoryName(typeof(IServiceCenter).Assembly.Location)!,
            "ServiceStudio.Framework.dll")).FileVersion ?? "unknown";
        ServerVersion = HostInfo.Version; HandshakeOk = true; IsReadOnly = readOnly;
        ServerProperties = new Dictionary<string, string>();
    }

    private HeadlessSession(IServiceCenter sc, HeadlessCredentials creds, string secret, LoginInfoWithPassword login, Version? serverVersion,
        string ideVersion, bool handshakeOk, string? handshakeError, IReadOnlyDictionary<string, string> props, long connectMs)
    {
        _sc = sc; _secret = secret; _login = login;
        Host = creds.Host; Username = creds.Username; ServerVersion = serverVersion; IdeVersion = ideVersion;
        HandshakeOk = handshakeOk; HandshakeError = handshakeError; ServerProperties = props; ConnectMs = connectMs;
    }

    /// <summary>Abre a sessao. Lanca se o handshake for recusado.</summary>
    public static HeadlessSession Connect(HeadlessCredentials creds, string? ideVersion = null, bool allowUntrustedCertificates = false)
    {
        var sw = Stopwatch.StartNew();
        var hostInfo = HostInfo.GetHostInfo(creds.Host);
        var defaults = new ServerCommunicationsDefaultBehaviours();
        var sc = WebServicesFactory.CreateServiceCenterWebService(
            hostInfo, defaults, allowUntrustedCertificates, permissionToDowngradeToHTTP: false, isUnattended: true);

        var props = sc.GetPropertiesForHandshake();
        var propsCopy = new Dictionary<string, string>(props);
        Version? serverVersion = null;
        if (props.TryGetValue("HubServerVersion", out var raw))
        {
            // "11.41.0.46924 Internal Version" -> primeiro token
            var token = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
            if (Version.TryParse(token, out var parsed)) { serverVersion = parsed; hostInfo.Version = parsed; }
        }

        var login = new LoginInfoWithPassword { HostInfo = hostInfo, UserName = creds.Username, Password = new Password(creds.Password) };
        var secret = login.GetSecretForWebServiceRequest();
        var ide = ideVersion ?? StudioAssemblies.IdeVersion;
        var ok = sc.Handshake(creds.Username, secret, ide, "11.0.0.200", out var error);
        if (!ok) throw new InvalidOperationException($"handshake refused by {creds.Host}: {error}");
        var session = new HeadlessSession(sc, creds, secret, login, serverVersion, ide, ok, error, propsCopy, sw.ElapsedMilliseconds);
        if (creds.ReadOnly) session.MarkReadOnly();
        return session;
    }

    // ---- inventario -------------------------------------------------------

    public IReadOnlyList<ApplicationSummary> ListApplications(bool refresh = false)
    {
        if (Connected != null) return Connected.Call<ApplicationSummary[]>("applications");
        _appsCache = refresh ? null : _appsCache;
        _appsCache ??= _sc.ListApplications(Username, _secret, withIcons: false);
        return _appsCache.Select(ToSummary).ToList();
    }

    public IReadOnlyList<ModuleSummary> ListModules(bool refresh = false)
    {
        if (Connected != null) return Connected.Call<ModuleSummary[]>("modules");
        _modulesCache = refresh ? null : _modulesCache;
        _modulesCache ??= _sc.ListEspaces(Username, _secret);
        return _modulesCache.Select(ToSummary).ToList();
    }

    /// <summary>Modulos de uma app, por nome (case-insensitive) ou chave.</summary>
    public IReadOnlyList<ModuleSummary> ModulesOf(string applicationNameOrKey)
        => ListModules().Where(m =>
                string.Equals(m.ApplicationName, applicationNameOrKey, StringComparison.OrdinalIgnoreCase)
                || string.Equals(m.ApplicationKey, applicationNameOrKey, StringComparison.Ordinal))
            .ToList();

    /// <summary>Por nome (case-insensitive) ou chave. Se nao estiver no cache, recarrega UMA vez:
    /// a propria sessao cria modulos/apps e o inventario do servidor muda debaixo dela.</summary>
    // Through the connected Studio there is no client cache: every list is already a fresh server read, so a miss is not
    // read again (it was the same request a few milliseconds later: one environment call of ~3 s less per create-app,
    // add-modules, create-module --replace and cached download).
    public ModuleSummary? FindModule(string nameOrKey, bool refreshOnMiss = true)
    {
        bool Match(ModuleSummary m) => string.Equals(m.Name, nameOrKey, StringComparison.OrdinalIgnoreCase) || m.Key == nameOrKey;
        return ListModules().FirstOrDefault(Match) ?? (refreshOnMiss && Connected == null ? ListModules(refresh: true).FirstOrDefault(Match) : null);
    }

    public ApplicationSummary? FindApplication(string nameOrKey, bool refreshOnMiss = true)
    {
        bool Match(ApplicationSummary a) => string.Equals(a.Name, nameOrKey, StringComparison.OrdinalIgnoreCase) || a.Key == nameOrKey;
        return ListApplications().FirstOrDefault(Match) ?? (refreshOnMiss && Connected == null ? ListApplications(refresh: true).FirstOrDefault(Match) : null);
    }

    /// <summary>Icone (PNG) de uma app existente; util para reaproveitar num app nova.</summary>
    public byte[]? GetApplicationIcon(string nameOrKey)
    {
        if (Connected != null) return Connected.Call<byte[]?>("application-icon", new { nameOrKey });
        var apps = _sc.ListApplications(Username, _secret, withIcons: true);
        var a = apps.FirstOrDefault(x => string.Equals(x.Name, nameOrKey, StringComparison.OrdinalIgnoreCase) || x.Key?.ToString() == nameOrKey);
        return a?.Icon is { Length: > 0 } ? a.Icon : null;
    }

    public IReadOnlyList<CatalogSummary> ListCatalogs()
    {
        if (Connected != null) return Connected.Call<CatalogSummary[]>("catalogs");
        var cats = _sc.ListCatalogs(Username, _secret, out var status);
        return cats.Select(c => new CatalogSummary(c.Id, c.Name, c.Description)).ToList();
    }

    /// <summary>Catalogo de produtores referenciaveis do ambiente (sem assinaturas).</summary>
    public IReadOnlyList<ReferenceableSummary> ListReferenceable(CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (Connected != null) return Connected.Call<ReferenceableSummary[]>("referenceable");
        var refs = _sc.ListReferenceable(Username, _secret, ct, out var status);
        return refs.Select(r => new ReferenceableSummary(
            Key: Str(r, "Key") ?? "", Name: Str(r, "Name") ?? "", Kind: Str(r, "Kind") ?? "",
            SignatureHash: Str(r, "SignatureHash") ?? "", IsSystem: Bool(r, "Is_System"),
            ApplicationKey: Str(r, "AppKey"))).ToList();
    }

    /// <summary>Fresh extension catalog, including the server-advertised version and active state.</summary>
    public IReadOnlyList<ModuleSummary> ListExtensions()
        => Connected != null ? Connected.Call<ModuleSummary[]>("extensions")
            : _sc.ListExtensions(Username,_secret).Select(ToSummary).ToArray();

    /// <summary>Read an explicit extension version. Zero has no assumed published-version semantics.</summary>
    public byte[] DownloadExtension(string extensionKey,int versionId)
    {
        if(versionId<=0)throw new ArgumentOutOfRangeException(nameof(versionId),"An explicit positive extension version is required");
        if (Connected != null) return Connected.Call<byte[]>("extension-download", new { extensionKey, versionId });
        return _sc.DownloadExtension(Username,_secret,versionId,Keys.ToDb(extensionKey));
    }

    /// <summary>Versoes de um modulo (ids), da mais recente para a mais antiga.</summary>
    public IReadOnlyList<int> ListVersionIds(string moduleKey)
        => Connected != null ? Connected.Call<int[]>("versions", new { moduleKey })
            : _sc.ListVersions(Username, _secret, Keys.ToDb(moduleKey)).Select(v => v.VersionId).OrderByDescending(v => v).ToList();

    // ---- templates de aplicacao (o "New Application"/"New Module" do Studio) ----

    /// <summary>
    /// Templates de aplicacao do servidor (Reactive Web App, Phone App, Tablet App, ...).
    /// REST `TemplateManager/rest/TemplateServices/Apps_ListTemplates` (Basic user:segredo); o SOAP
    /// `Apps_ListTemplates` nao existe mais no 11.41. Campos lidos de forma tolerante ao nome.
    /// </summary>
    public IReadOnlyList<TemplateSummary> ListApplicationTemplates()
    {
        if (Connected != null) return Connected.Call<TemplateSummary[]>("templates");
        var url = $"https://{Host}/TemplateManager/rest/TemplateServices/Apps_ListTemplates";
        using var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(Username + ":" + _secret)));
        using var resp = http.GetAsync(url).GetAwaiter().GetResult();
        var body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"Apps_ListTemplates failed: HTTP {(int)resp.StatusCode} {body[..Math.Min(body.Length, 300)]}");
        LastTemplatesJson = body;
        using var doc = System.Text.Json.JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.ValueKind == System.Text.Json.JsonValueKind.Object)
            root = root.EnumerateObject().Select(p => p.Value).FirstOrDefault(v => v.ValueKind == System.Text.Json.JsonValueKind.Array);
        var list = new List<TemplateSummary>();
        foreach (var e in root.EnumerateArray())
        {
            string? S(params string[] names) { foreach (var n in names) foreach (var pr in e.EnumerateObject()) if (string.Equals(pr.Name, n, StringComparison.OrdinalIgnoreCase)) return pr.Value.ValueKind == System.Text.Json.JsonValueKind.Null ? null : pr.Value.ToString(); return null; }
            list.Add(new TemplateSummary(
                Key: S("Key", "ESpace_Key", "TemplateKey") ?? "",
                Label: S("Label", "Name") ?? "",
                Description: S("Description"),
                IsMobile: string.Equals(S("IsMobile", "Is_Mobile"), "true", StringComparison.OrdinalIgnoreCase),
                ApplicationKind: S("ApplicationKind", "Kind", "Application_Kind") ?? ""));
        }
        return list;
    }

    public string? LastTemplatesJson { get; private set; }

    private IReadOnlyList<TemplateSummary>? _knownTemplates;

    /// <summary>Templates read earlier from THIS environment (the o11_environment templates cache, create-app --templates):
    /// FindTemplateForKind picks from them without an environment call when they hold a template of the kind asked (and the
    /// preferred label, when one is given); otherwise it reads the server as before. False (nothing kept) for another host
    /// or an empty list.</summary>
    public bool UseKnownTemplates(string? host, IReadOnlyList<TemplateSummary>? templates)
    {
        if (templates is not { Count: > 0 } || !string.Equals(host?.Trim(), Host, StringComparison.OrdinalIgnoreCase)) return false;
        _knownTemplates = templates;
        return true;
    }

    /// <summary>Template padrao por tipo de app: ReactiveWebApp, PhoneApp (ou TabletApp), TraditionalWeb.</summary>
    public TemplateSummary? FindTemplateForKind(string applicationKind, string? preferLabel = null)
    {
        if (_knownTemplates != null)
        {
            var known = _knownTemplates.Where(x => string.Equals(x.ApplicationKind, applicationKind, StringComparison.OrdinalIgnoreCase)).ToList();
            if (known.Count > 0 && (preferLabel == null || known.Any(x => string.Equals(x.Label, preferLabel, StringComparison.OrdinalIgnoreCase))))
                return PickTemplate(known, applicationKind, preferLabel);
        }
        return PickTemplate(ListApplicationTemplates().Where(x => string.Equals(x.ApplicationKind, applicationKind, StringComparison.OrdinalIgnoreCase)).ToList(),
            applicationKind, preferLabel);
    }

    private static TemplateSummary? PickTemplate(List<TemplateSummary> byKind, string applicationKind, string? preferLabel)
    {
        if (preferLabel != null && byKind.FirstOrDefault(x => string.Equals(x.Label, preferLabel, StringComparison.OrdinalIgnoreCase)) is { } pref) return pref;
        var preferred = applicationKind.ToLowerInvariant() switch
        {
            "crossdevice" => "ReactiveWebApp",
            "mobile" => "PhoneApp",
            "webresponsive" => "TraditionalWeb",
            _ => null,
        };
        return (preferred != null ? byKind.FirstOrDefault(x => string.Equals(x.Label, preferred, StringComparison.OrdinalIgnoreCase)) : null) ?? byKind.FirstOrDefault();
    }

    /// <summary>OML do modulo-modelo de um template (o Studio o carrega, renomeia e publica como primeiro modulo).</summary>
    public (byte[] Oml, string FreshName) GetTemplateModule(string templateKey)
    {
        if (Connected != null) return Connected.Call<(byte[], string)>("template-module", new { templateKey });
        var bytes = _sc.GetESpaceForTemplate(Username, _secret, templateKey, out var freshName);
        if (bytes == null || bytes.Length == 0) throw new InvalidOperationException($"template {templateKey} returned no module");
        return (bytes, freshName);
    }

    // ---- assinaturas de produtores (REST primeiro, SOAP como fallback) ---------

    private ServiceStudio.ServerCommunications.ServiceCenter.ServerAPIServices? _rest;

    /// <summary>
    /// Servicos REST do Service Center (o mesmo `ServerAPIServices` do Studio). Em servidores
    /// recentes o SOAP `GetReferenceDetails` responde "Missing" e o Studio usa REST
    /// (`GetReferenceDetailsMigratedToServerApi`). Exige `Settings.Instance` (prologo do runtime).
    /// </summary>
    internal ServiceStudio.ServerCommunications.ServiceCenter.ServerAPIServices Rest
        => _rest ??= new ServiceStudio.ServerCommunications.ServiceCenter.ServerAPIServices(HostInfo, null!);

    /// <summary>Assinatura atual de um produtor (SignatureBinary + hash). REST, depois SOAP.</summary>
    public ReferenceInfo? GetReferenceSignature(string producerKey, string kind, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (Connected != null) return Connected.Call<ReferenceInfo?>("signature", new { producerKey, kind });
        try
        {
            // o Studio passa a forma "DB" da chave (ObjectKey.DatabaseValue): chaves com '+' quebram a URL REST
            var dbKey = OutSystems.ObjectKeys.ObjectKey.Parse(producerKey)?.ToString("DB") ?? producerKey;
            LastRestKey = dbKey;
            var actualLogin = _borrowedLogin ?? _login;
            var method = Rest.GetType().GetMethods().Single(m => m.Name == "GetReferenceDetails"
                && m.GetParameters().Length == 3 && m.GetParameters()[0].ParameterType.IsInstanceOfType(actualLogin));
            var module = method.Invoke(Rest, [actualLogin, dbKey, ct]);
            if (module != null)
            {
                var info = (ReferenceInfo)Activator.CreateInstance(typeof(ReferenceInfo), module)!;
                if (info.SignatureBinary is { Length: > 0 }) return info;
            }
        }
        catch (Exception ex) { LastRestError = ex.GetType().Name + ": " + ex.Message; }
        var soap = _sc.GetReferenceDetails(producerKey, kind, Username, _secret, out var status, ct);
        return soap != null && soap.SignatureBinary is { Length: > 0 } ? soap : null;
    }

    public string? LastRestError { get; private set; }

    /// <summary>User provider que o template da app impoe (SOAP GetTemplateInfo). E o que o Studio consulta
    /// no "New Module" em branco (Presenter prs#xumsmglc); sem template, ou em falha, o padrao e ("Users", UsersESpaceKey).</summary>
    public (string Name, string Key)? GetTemplateUserProvider(string templateKey)
    {
        if (Connected != null) return Connected.Call<(string, string)?>("template-user-provider", new { templateKey });
        try
        {
            _sc.GetTemplateInfo(Username, _secret, Keys.ToDb(templateKey), out var up);
            if (string.IsNullOrEmpty(up.Name) || up.Key == null) return null;
            return (up.Name, up.Key.ToString());
        }
        catch (Exception ex) { LastRestError = ex.GetType().Name + ": " + ex.Message; return null; }
    }

    /// <summary>Par padrao do Studio para modulos novos: ("Users", Constants.UsersESpaceKey).</summary>
    public static (string Name, string Key) DefaultUserProvider => ("Users", OutSystems.RuntimeCommon.Constants.UsersESpaceKey.ToString());
    public string? LastRestKey { get; private set; }

    // ---- Edit Data (connected sessions only) --------------------------------

    /// <summary>One page of records of an entity, through the Studio's own login (keys in database form).</summary>
    public EnvironmentData.Row[] ReadRecords(string moduleKey, string entityKey, int? tenantId, string[]? ids, int offset)
        => (Connected ?? throw new NotSupportedException("Edit Data runs only through the Studio's own login"))
            .Call<EnvironmentData.Row[]>(EnvironmentData.ReadOperation, new { moduleKey, entityKey, tenantId, ids, offset, includeBinary = false });

    /// <summary>Whether the Studio's bridge serves an environment operation on this lease (false without a Studio lease).</summary>
    public bool Serves(string operation) => Connected?.Operations.Contains(operation, StringComparer.Ordinal) == true;

    /// <summary>A13: one users-read of the closed user and role lookup (UserDirectory.Execute runs in the Studio).</summary>
    public System.Text.Json.Nodes.JsonObject ReadDirectory(object arguments)
        => (Connected ?? throw new NotSupportedException("The users lookup runs only through the Studio's own login"))
            .Call<System.Text.Json.Nodes.JsonObject>(UserDirectory.Operation, arguments);

    /// <summary>Insert, update or delete records through the Studio's own login; one report per record.</summary>
    public EnvironmentData.Report[] WriteRecords(string moduleKey, string entityKey, int? tenantId, string operation,
        System.Text.Json.Nodes.JsonArray? records, string[]? ids)
    {
        RequireWrite("data");
        return (Connected ?? throw new NotSupportedException("Edit Data runs only through the Studio's own login"))
            .Call<EnvironmentData.Report[]>(EnvironmentData.WriteOperation, new { moduleKey, entityKey, tenantId, operation, records, ids });
    }

    // ---- download ---------------------------------------------------------

    /// <summary>
    /// Baixa a versao publicada de um modulo. Sem versao explicita usa
    /// ModuleSummary.VersionId (o SOAP puro devolve 0 bytes para versionId 0).
    /// </summary>
    public DownloadResult Download(ModuleSummary module, string? outputDirectory = null, int? versionId = null, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (Connected != null) return Connected.Call<DownloadResult>("download", new {
            module, outputDirectory = outputDirectory == null ? null : Path.GetFullPath(outputDirectory), versionId });
        var sw = Stopwatch.StartNew();
        if (!string.Equals(module.Kind, "eSpace", StringComparison.OrdinalIgnoreCase))
            return new DownloadResult(module.Name, module.Key, module.Kind, 0, 0, null, default, null, false, sw.ElapsedMilliseconds, "skipped: " + module.Kind);
        var vid = versionId ?? module.VersionId;
        if (vid <= 0) vid = ListVersionIds(module.Key).FirstOrDefault();
        try
        {
            var data = _sc.Download(Username, _secret, vid, module.Key, ct,
                out var uploadDate, out var uploadUser, out var isPub, out var msg, out var success);
            if (!success || data == null || data.Length == 0)
                return new DownloadResult(module.Name, module.Key, module.Kind, vid, data?.Length ?? 0, null, uploadDate, uploadUser, isPub, sw.ElapsedMilliseconds,
                    "failed: " + (msg?.Message ?? $"empty payload (versionId {vid})"));
            string? path = null;
            if (outputDirectory != null)
            {
                System.IO.Directory.CreateDirectory(outputDirectory);
                path = Path.Combine(outputDirectory, SafeFileName(module.Name) + ".oml");
                File.WriteAllBytes(path, data);
            }
            return new DownloadResult(module.Name, module.Key, module.Kind, vid, data.Length, path, uploadDate, uploadUser, isPub, sw.ElapsedMilliseconds, "ok");
        }
        catch (Exception ex)
        {
            return new DownloadResult(module.Name, module.Key, module.Kind, vid, 0, null, default, null, false, sw.ElapsedMilliseconds, "exception: " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    public DownloadResult Download(string moduleNameOrKey, string? outputDirectory = null, int? versionId = null, CancellationToken ct = default)
    {
        var m = FindModule(moduleNameOrKey) ?? throw new KeyNotFoundException($"module not found in {Host}: {moduleNameOrKey}");
        return Download(m, outputDirectory, versionId, ct);
    }

    /// <summary>Baixa todos os modulos que passam no filtro (todos, se nulo). Sequencial: o cliente SOAP nao e thread-safe.</summary>
    public IReadOnlyList<DownloadResult> DownloadAll(string outputDirectory, Func<ModuleSummary, bool>? filter = null, Action<DownloadResult>? progress = null, CancellationToken ct = default)
    {
        var results = new List<DownloadResult>();
        foreach (var m in ListModules().Where(m => filter == null || filter(m)))
        {
            ct.ThrowIfCancellationRequested();
            var r = Download(m, outputDirectory, null, ct);
            results.Add(r);
            progress?.Invoke(r);
        }
        return results;
    }

    /// <summary>Baixa todos os modulos de uma ou mais apps (nome ou chave), um subdiretorio por app.</summary>
    public IReadOnlyList<DownloadResult> DownloadApplications(string outputDirectory, IEnumerable<string> applications, Action<DownloadResult>? progress = null, CancellationToken ct = default)
    {
        var results = new List<DownloadResult>();
        foreach (var app in applications)
        {
            var mods = ModulesOf(app);
            if (mods.Count == 0) throw new KeyNotFoundException($"application not found or without modules in {Host}: {app}");
            var dir = Path.Combine(outputDirectory, SafeFileName(mods[0].ApplicationName ?? app));
            foreach (var m in mods)
            {
                ct.ThrowIfCancellationRequested();
                var r = Download(m, dir, null, ct);
                results.Add(r);
                progress?.Invoke(r);
            }
        }
        return results;
    }

    // ---- helpers ----------------------------------------------------------

    private static ApplicationSummary ToSummary(ApplicationInfo a) => new(
        Name: a.Name, Key: a.Key?.ToString() ?? "", Description: a.Description,
        Kind: a.ApplicationKind?.ToString(), TemplateKey: a.TemplateKey?.ToString(),
        IsActive: a.IsActive, IsIsolated: a.IsIsolated, DatabaseName: a.DatabaseName, HasFullControl: a.HasFullControl,
        PrimaryColor: a.PrimaryColor, HasIcon: a.Icon is { Length: > 0 });

    private static ModuleSummary ToSummary(ModuleInfo m) => new(
        Name: m.Name, Key: m.Key?.ToString() ?? "", Kind: m.Kind.ToString(), ESpaceKind: m.ESpaceKind.ToString(),
        VersionId: m.VersionId, Version: m.Version, ApplicationName: m.ApplicationName,
        ApplicationKey: m.ApplicationKey?.ToString(), UploadDate: m.UploadDate, UploaderUsername: m.UploaderUsername,
        IsActive: m.IsActive, CanDownloadFlag: m.CanDownload, Description: m.Description);

    private static string? Str(object o, string member)
    {
        var t = o.GetType();
        var p = t.GetProperty(member); if (p != null) return p.GetValue(o)?.ToString();
        var f = t.GetField(member); return f?.GetValue(o)?.ToString();
    }

    private static bool Bool(object o, string member) => string.Equals(Str(o, member), "True", StringComparison.OrdinalIgnoreCase);

    public static string SafeFileName(string s)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
        return string.IsNullOrWhiteSpace(s) ? "unnamed" : s;
    }

    public void Dispose()
    {
        if (Connected != null) Connected.Dispose();
        else if (_ownsClient) _sc.Dispose();
    }
}
