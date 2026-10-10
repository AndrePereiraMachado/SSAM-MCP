using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Communication;
using OutSystems.Communication.Identity;
using OutSystems.Communication.ServiceCenter;
using OutSystems.MetaModel.Enumerations;
using OutSystems.ObjectKeys;
using static Anvil.Bridge.EnvironmentWire;

namespace Anvil.Bridge;

/// <summary>
/// The environment_session operations of the thin bridge (docs/O11-BRIDGE-FINA.md section 3.6): each one is ONE call on
/// the Studio's own login (SOAP IServiceCenter, REST ServerAPIServices/TemplateManager, the provider's Edit Data). The
/// bodies are the kernel's in-Studio branches (HeadlessSession, Publisher, TemplateModules, EnvironmentData); finding
/// modules, waiting for publications, template modules, reference refresh and data schemas stay in the CLI on the
/// server. No model, no shell, no credential: the secret is taken per lease call and never leaves the process.
/// </summary>
internal static class EnvironmentPrimitives
{
    public const string ReadOperation = "data-read";
    public const string WriteOperation = "data-write";

    public static readonly string[] Names = [
        "applications", "modules", "application-icon", "catalogs", "referenceable",
        "extensions", "extension-download", "versions", "templates", "template-module",
        "template-download", "signature", "template-user-provider", "download",
        "application-save", "module-associate", "application-delete", "module-delete",
        "publish-start", "publish-check", ReadOperation, WriteOperation
    ];

    /// <summary>Operations that change the server: a read-only lease refuses them.</summary>
    public static readonly IReadOnlySet<string> WriteOperations = new HashSet<string>(StringComparer.Ordinal) {
        "application-save", "module-associate", "application-delete", "module-delete", "publish-start", WriteOperation };

    // (System) and Users hold users, roles and password hashes: never read or written here.
    private static readonly string[] RefusedModuleKeys = ["uXCIR2Atc0+es3zYuZSnNw", "WWAQZTkE5UuwES8B+6Svpg"];

    /// <summary>One borrowed Studio login: the Service Center client, the login, its host and user, the secret of this
    /// call, the lease's read-only flag and the provider (Edit Data).</summary>
    public sealed record Lease(IServiceCenter Client, object Login, string Host, string User, string Secret, bool ReadOnly, object? Provider)
    {
        public HostInfo HostInfo => (HostInfo)Login.GetType().GetProperty("HostInfo")!.GetValue(Login)!;

        /// <summary>Called by every write before talking to the server.</summary>
        public void RequireWrite(string verb)
        {
            if (ReadOnly) throw new InvalidOperationException($"read-only environment {Host}: '{verb}' refused before reaching the server");
        }
    }

    public static JsonObject Execute(Lease lease, string operation, JsonObject? arguments)
    {
        T Get<T>(string name) => arguments?[name] is { } node
            ? node.Deserialize<T>(Options)!
            : default!;
        object? value = operation switch
        {
            "applications" => ListApplications(lease),
            "modules" => ListModules(lease),
            "application-icon" => GetApplicationIcon(lease, Get<string>("nameOrKey")),
            "catalogs" => ListCatalogs(lease),
            "referenceable" => ListReferenceable(lease),
            "extensions" => ListExtensions(lease),
            "extension-download" => DownloadExtension(lease, Get<string>("extensionKey"), Get<int>("versionId")),
            "versions" => ListVersionIds(lease, Get<string>("moduleKey")),
            "templates" => ListApplicationTemplates(lease),
            "template-module" => GetTemplateModule(lease, Get<string>("templateKey")),
            "template-download" => DownloadTemplateModule(lease, Get<string>("templateKey")),
            "signature" => GetReferenceSignature(lease, Get<string>("producerKey"), Get<string>("kind")),
            "template-user-provider" => GetTemplateUserProvider(lease, Get<string>("templateKey")),
            "download" => Download(lease, Get<ModuleSummary>("module"), Get<string?>("outputDirectory"), Get<int?>("versionId")),
            "application-save" => CreateOrUpdateApplication(lease, Get<string>("name"),
                Get<SegmentationKind>("kind"), Get<string?>("description"), Get<string?>("existingKey"),
                Get<string?>("templateKey"), Get<string?>("primaryColor"), Get<byte[]?>("icon")),
            "module-associate" => AddModuleToApplication(lease, Get<string>("appKey"), Get<string>("moduleKey")),
            "application-delete" => DeleteApplication(lease, Get<string>("appKey"), Get<bool>("simulate")),
            "module-delete" => DeleteModule(lease, Get<string>("moduleKey")),
            "publish-start" => StartPublish(lease, Get<byte[]>("oml"), Get<string>("appKey"),
                Get<int?>("catalogId"), Get<string>("commitMessage")),
            "publish-check" => CheckPublish(lease, Get<PublishOutcome>("previous")),
            ReadOperation or WriteOperation => Data(lease, operation, arguments),
            _ => throw new ArgumentException("Unknown environment operation: " + operation)
        };
        return new JsonObject { ["value"] = JsonSerializer.SerializeToNode(value, value?.GetType() ?? typeof(object), Options) };
    }

    // ---- inventory -------------------------------------------------------

    private static IReadOnlyList<ApplicationSummary> ListApplications(Lease s)
        => s.Client.ListApplications(s.User, s.Secret, withIcons: false).Select(ToSummary).ToList();

    private static IReadOnlyList<ModuleSummary> ListModules(Lease s)
        => s.Client.ListEspaces(s.User, s.Secret).Select(ToSummary).ToList();

    private static byte[]? GetApplicationIcon(Lease s, string nameOrKey)
    {
        var apps = s.Client.ListApplications(s.User, s.Secret, withIcons: true);
        var a = apps.FirstOrDefault(x => string.Equals(x.Name, nameOrKey, StringComparison.OrdinalIgnoreCase) || x.Key?.ToString() == nameOrKey);
        return a?.Icon is { Length: > 0 } ? a.Icon : null;
    }

    private static IReadOnlyList<CatalogSummary> ListCatalogs(Lease s)
    {
        var cats = s.Client.ListCatalogs(s.User, s.Secret, out var status);
        return cats.Select(c => new CatalogSummary(c.Id, c.Name, c.Description)).ToList();
    }

    private static IReadOnlyList<ReferenceableSummary> ListReferenceable(Lease s, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var refs = s.Client.ListReferenceable(s.User, s.Secret, ct, out var status);
        return refs.Select(r => new ReferenceableSummary(
            Key: Str(r, "Key") ?? "", Name: Str(r, "Name") ?? "", Kind: Str(r, "Kind") ?? "",
            SignatureHash: Str(r, "SignatureHash") ?? "", IsSystem: Bool(r, "Is_System"),
            ApplicationKey: Str(r, "AppKey"))).ToList();
    }

    private static IReadOnlyList<ModuleSummary> ListExtensions(Lease s)
        => s.Client.ListExtensions(s.User, s.Secret).Select(ToSummary).ToArray();

    private static byte[] DownloadExtension(Lease s, string extensionKey, int versionId)
    {
        if (versionId <= 0) throw new ArgumentOutOfRangeException(nameof(versionId), "An explicit positive extension version is required");
        return s.Client.DownloadExtension(s.User, s.Secret, versionId, BridgeKit.DbKey(extensionKey));
    }

    /// <summary>Version ids of a module, newest first.</summary>
    private static IReadOnlyList<int> ListVersionIds(Lease s, string moduleKey)
        => s.Client.ListVersions(s.User, s.Secret, BridgeKit.DbKey(moduleKey)).Select(v => v.VersionId).OrderByDescending(v => v).ToList();

    // ---- application templates -------------------------------------------

    /// <summary>REST TemplateManager/rest/TemplateServices/Apps_ListTemplates (Basic user:secret); fields read tolerant
    /// of their names.</summary>
    private static IReadOnlyList<TemplateSummary> ListApplicationTemplates(Lease s)
    {
        var url = $"https://{s.Host}/TemplateManager/rest/TemplateServices/Apps_ListTemplates";
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(s.User + ":" + s.Secret)));
        using var resp = http.GetAsync(url).GetAwaiter().GetResult();
        var body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"Apps_ListTemplates failed: HTTP {(int)resp.StatusCode} {body[..Math.Min(body.Length, 300)]}");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.ValueKind == JsonValueKind.Object)
            root = root.EnumerateObject().Select(p => p.Value).FirstOrDefault(v => v.ValueKind == JsonValueKind.Array);
        var list = new List<TemplateSummary>();
        foreach (var e in root.EnumerateArray())
        {
            string? S(params string[] names) { foreach (var n in names) foreach (var pr in e.EnumerateObject()) if (string.Equals(pr.Name, n, StringComparison.OrdinalIgnoreCase)) return pr.Value.ValueKind == JsonValueKind.Null ? null : pr.Value.ToString(); return null; }
            list.Add(new TemplateSummary(
                Key: S("Key", "ESpace_Key", "TemplateKey") ?? "",
                Label: S("Label", "Name") ?? "",
                Description: S("Description"),
                IsMobile: string.Equals(S("IsMobile", "Is_Mobile"), "true", StringComparison.OrdinalIgnoreCase),
                ApplicationKind: S("ApplicationKind", "Kind", "Application_Kind") ?? ""));
        }
        return list;
    }

    /// <summary>The template's model module (SOAP GetESpaceForTemplate).</summary>
    private static (byte[] Oml, string FreshName) GetTemplateModule(Lease s, string templateKey)
    {
        var bytes = s.Client.GetESpaceForTemplate(s.User, s.Secret, templateKey, out var freshName);
        if (bytes == null || bytes.Length == 0) throw new InvalidOperationException($"template {templateKey} returned no module");
        return (bytes, freshName);
    }

    /// <summary>GET https://host/TemplateManager/rest/TemplateServices/Apps_GetTemplateESpace?ESpace_Key=... (Basic user:secret).</summary>
    private static (byte[] Oml, string FreshName) DownloadTemplateModule(Lease s, string templateKey, TimeSpan? timeout = null)
    {
        var dbKey = BridgeKit.DbKey(templateKey);
        var url = $"https://{s.Host}/TemplateManager/rest/TemplateServices/Apps_GetTemplateESpace?ESpace_Key={Uri.EscapeDataString(dbKey)}";
        using var http = new HttpClient { Timeout = timeout ?? TimeSpan.FromSeconds(120) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(s.User + ":" + s.Secret)));
        using var resp = http.GetAsync(url).GetAwaiter().GetResult();
        var body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"template download failed: HTTP {(int)resp.StatusCode} {body[..Math.Min(body.Length, 300)]}");
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        string? Get(string name) => root.TryGetProperty(name, out var v) ? v.GetString() : root.TryGetProperty(name.ToLowerInvariant(), out var w) ? w.GetString() : null;
        var file = Get("File") ?? throw new InvalidOperationException("template response without File");
        return (Convert.FromBase64String(file), Get("Name") ?? "");
    }

    // ---- producer signatures (REST first, SOAP as fallback) ---------------

    /// <summary>A producer's current signature (SignatureBinary + hash): REST ServerAPIServices.GetReferenceDetails (the
    /// Studio passes the "DB" form of the key), then SOAP GetReferenceDetails.</summary>
    private static ReferenceInfo? GetReferenceSignature(Lease s, string producerKey, string kind, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            var dbKey = ObjectKey.Parse(producerKey)?.ToString("DB") ?? producerKey;
            var rest = new ServiceStudio.ServerCommunications.ServiceCenter.ServerAPIServices(s.HostInfo, null!);
            var method = rest.GetType().GetMethods().Single(m => m.Name == "GetReferenceDetails"
                && m.GetParameters().Length == 3 && m.GetParameters()[0].ParameterType.IsInstanceOfType(s.Login));
            var module = method.Invoke(rest, [s.Login, dbKey, ct]);
            if (module != null)
            {
                var info = (ReferenceInfo)Activator.CreateInstance(typeof(ReferenceInfo), module)!;
                if (info.SignatureBinary is { Length: > 0 }) return info;
            }
        }
        catch (Exception) { /* the SOAP fallback answers */ }
        var soap = s.Client.GetReferenceDetails(producerKey, kind, s.User, s.Secret, out var status, ct);
        return soap != null && soap.SignatureBinary is { Length: > 0 } ? soap : null;
    }

    /// <summary>The user provider the application template imposes (SOAP GetTemplateInfo), or null.</summary>
    private static (string Name, string Key)? GetTemplateUserProvider(Lease s, string templateKey)
    {
        try
        {
            s.Client.GetTemplateInfo(s.User, s.Secret, BridgeKit.DbKey(templateKey), out var up);
            if (string.IsNullOrEmpty(up.Name) || up.Key == null) return null;
            return (up.Name, up.Key.ToString());
        }
        catch (Exception) { return null; }
    }

    // ---- download ---------------------------------------------------------

    /// <summary>The published version of a module; version 0 means the newest of ListVersions (the SOAP returns 0 bytes
    /// for version 0). With outputDirectory, writes &lt;dir&gt;\&lt;name&gt;.oml.</summary>
    private static DownloadResult Download(Lease s, ModuleSummary module, string? outputDirectory = null, int? versionId = null, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var sw = Stopwatch.StartNew();
        if (!string.Equals(module.Kind, "eSpace", StringComparison.OrdinalIgnoreCase))
            return new DownloadResult(module.Name, module.Key, module.Kind, 0, 0, null, default, null, false, sw.ElapsedMilliseconds, "skipped: " + module.Kind);
        var vid = versionId ?? module.VersionId;
        if (vid <= 0) vid = ListVersionIds(s, module.Key).FirstOrDefault();
        try
        {
            var data = s.Client.Download(s.User, s.Secret, vid, module.Key, ct,
                out var uploadDate, out var uploadUser, out var isPub, out var msg, out var success);
            if (!success || data == null || data.Length == 0)
                return new DownloadResult(module.Name, module.Key, module.Kind, vid, data?.Length ?? 0, null, uploadDate, uploadUser, isPub, sw.ElapsedMilliseconds,
                    "failed: " + (msg?.Message ?? $"empty payload (versionId {vid})"));
            string? path = null;
            if (outputDirectory != null)
            {
                Directory.CreateDirectory(outputDirectory);
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

    // ---- applications and modules on the server --------------------------

    private static (string Key, bool Ok, string? Message) CreateOrUpdateApplication(
        Lease s, string name, SegmentationKind kind, string? description = null, string? existingKey = null, string? templateKey = null,
        string? primaryColor = null, byte[]? icon = null)
    {
        s.RequireWrite("CreateOrUpdateApplication");
        var info = new ApplicationInfo
        {
            Name = name,
            Description = description ?? "",
            Key = existingKey != null ? BridgeKit.ParseKey(existingKey) : ObjectKey.NewKey(),
            ApplicationKind = kind,
            IsActive = true,
            TemplateKey = templateKey != null ? BridgeKit.ParseKey(templateKey) : null,
            PrimaryColor = primaryColor ?? "",
            Icon = icon,
        };
        var ok = s.Client.CreateOrUpdateApplication(s.User, s.Secret, info, out var msg);
        return (info.Key.ToString(), ok, msg?.Message);
    }

    private static (bool Ok, string? Message) AddModuleToApplication(Lease s, string appKey, string moduleKey)
    {
        s.RequireWrite("AddModuleToApplication");
        var ok = s.Client.AddModuleToApplication(s.User, s.Secret, appKey, "eSpace", moduleKey, out var msg);
        return (ok, msg?.Message);
    }

    /// <summary>Deletes an application (and its modules); with simulate the server only reports the impact.</summary>
    private static DeleteOutcome DeleteApplication(Lease s, string appKey, bool simulate = true)
    {
        s.RequireWrite("DeleteApplication");
        var ok = s.Client.DeleteApplication(s.User, s.Secret, appKey, simulate, out var msgs, out var affected, out var deleted);
        return new DeleteOutcome(ok, simulate,
            (msgs ?? Array.Empty<IMessage>()).Select(m => { var x = ToMessage(m); return $"{x.Type}: {x.Message}{(string.IsNullOrEmpty(x.Detail) ? "" : " | " + x.Detail)}"; }).ToList(),
            (affected ?? Array.Empty<string>()).ToList(), (deleted ?? Array.Empty<string>()).ToList());
    }

    private static (bool Ok, string? Message) DeleteModule(Lease s, string moduleKey)
    {
        s.RequireWrite("DeleteModule");
        var ok = s.Client.DeleteModule(s.User, s.Secret, moduleKey, "eSpace", out var msg);
        return (ok, msg?.Message);
    }

    // ---- publish ------------------------------------------------------------

    /// <summary>Upload and start a server job (Start1CP); the CLI polls with publish-check.</summary>
    private static PublishOutcome StartPublish(Lease s, byte[] oml, string appKey, int? catalogId, string commitMessage)
    {
        s.RequireWrite("Publish");
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
        var result = s.Client.Start1CP(s.User, s.Secret, version, options);
        var startMs = sw.ElapsedMilliseconds;
        var messages = new List<PublishMessage>();
        foreach (var m in result.Messages ?? Array.Empty<IMessage>()) messages.Add(ToMessage(m));
        if (result.HasErrors || result.VersionId <= 0)
            return new PublishOutcome(false, result.HasErrors, false, result.ESpaceId, result.VersionId, result.Key, messages, startMs, sw.ElapsedMilliseconds);
        return new PublishOutcome(true, false, false, result.ESpaceId, result.VersionId, result.Key, messages, startMs, sw.ElapsedMilliseconds);
    }

    private static PublishOutcome CheckPublish(Lease s, PublishOutcome previous)
    {
        if (!previous.Started || previous.Completed || previous.HasErrors) return previous;
        var batch = s.Client.CheckPublishAsync(s.User, s.Secret, previous.VersionId, out var completed);
        var messages = previous.Messages.ToList();
        foreach (var m in batch ?? Array.Empty<IMessage>()) messages.Add(ToMessage(m));
        var hasErrors = messages.Any(m => m.Type.Contains("Error", StringComparison.OrdinalIgnoreCase));
        return previous with { Completed = completed, HasErrors = hasErrors, Messages = messages };
    }

    /// <summary>ModuleVersion only has constructors with parameters (kind, versionId, binary); resolved by type.</summary>
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

    // ---- Edit Data (the provider's own calls) -------------------------------

    /// <summary>The provider's GetRecords, InsertRecords, UpdateRecords and DeleteRecords: keys and text values only, never
    /// the (System) or Users modules.</summary>
    private static object Data(Lease s, string operation, JsonObject? arguments)
    {
        var provider = s.Provider as ServiceStudio.ServerCommunications.ServerCommunicationsProvider
            ?? throw new InvalidOperationException("The Studio data provider is unavailable for this lease");
        var moduleKey = Text(arguments, "moduleKey");
        var entityKey = Text(arguments, "entityKey");
        if (IsRefusedModule(moduleKey)) throw new InvalidOperationException("Users and roles are out of reach of Edit Data here");
        int? tenantId = arguments?["tenantId"] is JsonValue tenant ? tenant.GetValue<int>() : null;
        if (operation == ReadOperation)
        {
            var ids = arguments?["ids"]?.AsArray().Select(x => x!.GetValue<string>()).ToArray();
            var rows = provider.GetRecords(moduleKey, entityKey, tenantId, ids is { Length: > 0 } ? ids : null, false,
                arguments?["includeBinary"]?.GetValue<bool>() ?? false, arguments?["offset"]?.GetValue<int>() ?? 0)
                ?? throw new InvalidOperationException("The environment does not advertise Edit Data (EditDataV4)");
            return rows.Select(r => new Row(r.Id, (r.EntityAttributesInfo ?? []).Select(a => new Cell(a.Key, a.Value)).ToArray())).ToArray();
        }
        if (operation != WriteOperation) throw new ArgumentException("Unknown data operation: " + operation);
        s.RequireWrite("data");
        var kind = Text(arguments, "operation");
        IEnumerable<OutSystems.Communication.RESTServices.DTO.EditDataOperationReport>? reports = kind switch
        {
            "insert" => provider.InsertRecords(moduleKey, entityKey, Records(arguments), tenantId),
            "update" => provider.UpdateRecords(moduleKey, entityKey, Records(arguments), tenantId),
            "delete" => provider.DeleteRecords(moduleKey, entityKey, Ids(arguments), tenantId),
            _ => throw new ArgumentException("operation must be insert, update or delete"),
        };
        if (reports == null) throw new InvalidOperationException("The environment does not advertise Edit Data (EditDataV4)");
        return reports.Select(r => new Report(r.RecordId, r.ClientRecordId, r.Status.ToString(), r.ErrorMessage)).ToArray();
    }

    public static bool IsRefusedModule(string moduleKey)
    {
        string Canonical(string key) { try { return BridgeKit.StudioKey(key); } catch { return key; } }
        var studio = Canonical(moduleKey);
        return RefusedModuleKeys.Any(k => string.Equals(Canonical(k), studio, StringComparison.Ordinal));
    }

    private static string Text(JsonObject? arguments, string name)
        => arguments?[name]?.GetValue<string>() is { Length: > 0 } value ? value : throw new ArgumentException(name + " is required");

    private static OutSystems.Communication.RESTServices.DTO.EntityRecordInfo[] Records(JsonObject? arguments)
    {
        var rows = arguments?["records"]?.AsArray() ?? throw new ArgumentException("records are required");
        if (rows.Count == 0) throw new ArgumentException("records must be nonempty");
        return rows.Select(row =>
        {
            var id = row?["id"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("Each record needs an id (a client id on insert)");
            var cells = row!["attributes"]?.AsArray() ?? throw new ArgumentException("Each record needs attributes");
            return new OutSystems.Communication.RESTServices.DTO.EntityRecordInfo { Id = id, EntityAttributesInfo = cells.Select(c => new OutSystems.Communication.RESTServices.DTO.EntityAttributeInfo {
                Key = c?["key"]?.GetValue<string>() ?? throw new ArgumentException("Each attribute needs a key"),
                Value = c["value"]?.GetValue<string>()! }).ToArray() };
        }).ToArray();
    }

    private static string[] Ids(JsonObject? arguments)
    {
        var ids = arguments?["ids"]?.AsArray().Select(x => x?.GetValue<string>() ?? "").ToArray() ?? throw new ArgumentException("ids are required");
        if (ids.Length == 0 || ids.Any(string.IsNullOrWhiteSpace) || ids.Distinct().Count() != ids.Length)
            throw new ArgumentException("ids must be nonempty and unique");
        return ids;
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

    private static string SafeFileName(string s)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
        return string.IsNullOrWhiteSpace(s) ? "unnamed" : s;
    }
}
