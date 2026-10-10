using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Communication.Identity.Login;
using OutSystems.Communication.Rest;
using OutSystems.Communication.ServiceCenter;
using OutSystems.ObjectKeys;
using ServiceStudio.ServerCommunications.API;
using ServiceStudio.ServerCommunications.ServiceCenter;

namespace Anvil.Bridge;

// sc_api: closed lists of Service Center operations over the Studio's own authenticated clients, and the single-send
// executor. Studio objects arrive through ScBound, so the tests drive this file with fakes of the Studio interfaces.

internal delegate object? ScSoapSend(IServiceCenter api, string user, string secret);
internal delegate object? ScServerApiSend(IServerAPI api, ILoginInfoBase login);
internal delegate object? ScRestSend(ScRestContext context);
internal delegate object? ScIntegrationStudioSend(ScIntegrationStudioContext context);

internal sealed record ScRestContext(IRestService? Rest, IServiceCenterREST? Api, IServerCommonService? Common, ILoginInfoBase? Login,
    string Host, string User, string Secret);

/// <summary>IntegrationStudio.asmx through one HTTP POST of the Studio process (ScApiHandler), with the Studio's user and a
/// fresh secret. Http sends exactly once and returns the answer as it came.</summary>
internal sealed record ScIntegrationStudioContext(Func<ScSoapRequest, ScHttp> Http, string Host, string User, string Secret);

/// <summary>A binary result: written to args.outFile (absolute) or returned as base64 up to 16 MiB.</summary>
internal sealed record ScBinary(byte[]? Bytes, object? Meta);

/// <summary>One HTTP answer of a request the bridge sent itself (no Studio retry layer in between).</summary>
internal sealed record ScHttp(int Status, string? ContentType, string Body);

/// <summary>One allowlisted operation: Prepare parses the arguments (BAD_REQUEST before anything is sent) and returns the
/// single send. Destroys names the target of a destructive write (the raw and the database form of its key).</summary>
internal sealed record ScOp<TSend>(Func<ScArgs, TSend> Prepare, bool Write = false, Func<ScArgs, string?[]>? Destroys = null,
    Func<ScArgs, bool>? WriteWhen = null)
{
    public bool IsWrite(ScArgs args) => WriteWhen?.Invoke(args) ?? Write;
}

internal sealed record ScPrepared(string Surface, string Operation, bool Write, bool Destructive, string? OperationId, ScArgs Args,
    Delegate Send, string? OutFile);

/// <summary>The Studio side of a call, resolved by the handler for the requested host.</summary>
internal sealed class ScBound
{
    public required string Host { get; init; }
    public required string User { get; init; }
    /// <summary>A fresh secret for this call (GetSecretForWebServiceRequest inside the Studio; the id_token in SSO).</summary>
    public required Func<string> Secret { get; init; }
    public IServiceCenter? Soap { get; init; }
    public IServerAPI? ServerApi { get; init; }
    /// <summary>The server.api client of this Studio sends once (OAuthHttpClient). The identity-service client resends.</summary>
    public bool ServerApiSingleSend { get; init; }
    public ILoginInfoBase? Login { get; init; }
    public IRestService? RestService { get; init; }
    public IServiceCenterREST? RestApi { get; init; }
    public IServerCommonService? Common { get; init; }
    /// <summary>Re-checks on the UI thread that the Studio login is still the one bound; throws when it changed.</summary>
    public Action? Validate { get; init; }
    /// <summary>One POST to IntegrationStudio.asmx (integration-studio surface), sent once.</summary>
    public Func<ScSoapRequest, ScHttp>? IntegrationStudioHttp { get; init; }
}

internal sealed class ScArgs(JsonObject? values)
{
    public const long FileLimit = 256L * 1024 * 1024;
    public JsonObject Values { get; } = values ?? new JsonObject();

    private static ScFailure Bad(string message) => new(ScCodes.BadRequest, message);

    public string? Raw(string name) => Values[name] is JsonValue value ? value.ToString() : null;

    public string Text(string name) => Raw(name) is { Length: > 0 } text ? text : throw Bad($"args.{name} is required");

    /// <summary>An object key in the database form the Service Center APIs take (Studio and GUID forms accepted).</summary>
    public string Key(string name)
    {
        var text = Text(name);
        try { return BridgeKit.DbKey(text); }
        catch (Exception) { throw Bad($"args.{name} is not an object key"); }
    }

    public ObjectKey? OptionalObjectKey(string name)
    {
        if (Raw(name) is not { Length: > 0 } text) return null;
        try { return BridgeKit.ParseKey(text); }
        catch (Exception) { throw Bad($"args.{name} is not an object key"); }
    }

    public int Int(string name, int? fallback = null)
    {
        if (Values[name] is null && fallback is { } value) return value;
        if (Values[name] is JsonValue node && (node.TryGetValue<int>(out var number) ||
            int.TryParse(node.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number))) return number;
        throw Bad($"args.{name} must be an integer");
    }

    public bool Bool(string name, bool fallback) => Values[name] switch
    {
        null => fallback,
        JsonValue node when node.TryGetValue<bool>(out var flag) => flag,
        _ => throw Bad($"args.{name} must be true or false"),
    };

    public DateTime Date(string name) =>
        DateTime.TryParse(Text(name), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date)
            ? date : throw Bad($"args.{name} must be an ISO date");

    public string OneOf(string name, params string[] allowed)
    {
        var text = Text(name);
        return allowed.FirstOrDefault(a => string.Equals(a, text, StringComparison.OrdinalIgnoreCase))
            ?? throw Bad($"args.{name} must be one of {string.Join(", ", allowed)}");
    }

    /// <summary>The bytes of a local file (absolute path), read before anything is sent.</summary>
    public byte[] Bytes(string name, long limit = FileLimit)
    {
        var path = Path(name);
        var info = new FileInfo(path);
        if (!info.Exists || info.Length == 0 || info.Length > limit)
            throw Bad($"args.{name} must be an existing nonempty file of at most {limit / (1024 * 1024)} MiB");
        return System.IO.File.ReadAllBytes(path);
    }

    /// <summary>args.outFile: an absolute path that does not exist yet (a download never overwrites a file).</summary>
    public string? OutFile()
    {
        if (Raw("outFile") is null) return null;
        var path = Path("outFile");
        if (System.IO.File.Exists(path) || Directory.Exists(path)) throw Bad("args.outFile already exists");
        return path;
    }

    public string Path(string name)
    {
        try { return BridgeKit.Absolute("sc_api", "args." + name, Raw(name)); }
        catch (ArgumentException error) { throw Bad(error.Message); }
    }
}

internal static class ScApi
{
    public const string Soap = "soap";
    public const string ServerApi = "server-api";
    public const string ScRest = "sc-rest";
    public const string IntegrationStudio = "integration-studio";
    public const int Base64Limit = 16 * 1024 * 1024;

    private static ScOp<T> Read<T>(Func<ScArgs, T> prepare) => new(prepare);
    private static ScOp<T> Write<T>(Func<ScArgs, T> prepare, Func<ScArgs, string?[]>? destroys = null) => new(prepare, true, destroys);
    private static string?[] Target(ScArgs args, string name) => [args.Raw(name), args.Key(name)];

    /// <summary>Dangerous ServiceStudio.asmx operations, closed by name: admin setup, server-side code and SQL execution,
    /// licenses, Forge synchronization, producer pushes, data import, operation registration and metrics.</summary>
    public static readonly IReadOnlySet<string> Closed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "SetupAdminUser", "TestAction", "TestQuery", "UploadProductLicense", "DeleteProductLicense", "SynchronizeApps",
        "PushProducerToConsumer", "ImportTable", "RegisterOperation", "Metrics_Synchronized",
    };

    public static bool IsClosed(string operation) => Closed.Contains(operation) || operation.StartsWith("Metrics_", StringComparison.OrdinalIgnoreCase);

    /// <summary>ServiceStudio.asmx through the raw IServiceCenter: one call, the user and a fresh secret, no wrapper.</summary>
    public static readonly IReadOnlyDictionary<string, ScOp<ScSoapSend>> SoapOperations = new Dictionary<string, ScOp<ScSoapSend>>(StringComparer.OrdinalIgnoreCase)
    {
        ["ListApplications"] = Read<ScSoapSend>(a => { var icons = a.Bool("withIcons", false); return (sc, u, s) => sc.ListApplications(u, s, icons); }),
        ["LandingPageListApplications"] = Read<ScSoapSend>(_ => (sc, u, s) => sc.LandingPageListApplications(u, s)),
        ["GetApplicationDetails"] = Read<ScSoapSend>(a => { var key = a.Key("appKey"); return (sc, u, s) => sc.GetApplicationDetails(u, s, key); }),
        ["GetApplicationDependenciesDetails"] = Read<ScSoapSend>(a => { var key = a.Key("appKey"); return (sc, u, s) => sc.GetApplicationDependenciesDetails(u, s, key); }),
        ["GetApplicationAPI"] = Read<ScSoapSend>(a => { var key = a.Key("appKey"); return (sc, u, s) => sc.GetApplicationAPI(u, s, key); }),
        ["GetApplicationConsumedAPI"] = Read<ScSoapSend>(a => { var key = a.Key("appKey"); return (sc, u, s) => sc.GetApplicationConsumedAPI(u, s, key); }),
        ["ListEspaces"] = Read<ScSoapSend>(_ => (sc, u, s) => sc.ListEspaces(u, s)),
        ["ListExtensions"] = Read<ScSoapSend>(_ => (sc, u, s) => sc.ListExtensions(u, s)),
        ["ListVersions"] = Read<ScSoapSend>(a => { var key = a.Key("eSpaceKey"); return (sc, u, s) => sc.ListVersions(u, s, key); }),
        ["GetESpaceId"] = Read<ScSoapSend>(a => { var key = a.Key("eSpaceKey"); return (sc, u, s) => sc.GetESpaceId(u, s, key); }),
        ["EspaceTenants"] = Read<ScSoapSend>(a => { var key = a.Key("eSpaceKey"); return (sc, u, s) => sc.EspaceTenants(u, s, key); }),
        ["GetConsumers"] = Read<ScSoapSend>(a =>
        {
            // The Studio passes null for "every element of the producer" (ApplicationManagementService.GetConsumers).
            var producer = a.Key("producerESpaceKey"); var element = a.Raw("referenceableElementKey") is { Length: > 0 } ? a.Key("referenceableElementKey") : null;
            return (sc, u, s) => sc.GetConsumers(u, s, producer, element!);
        }),
        ["GetPublicElements"] = Read<ScSoapSend>(_ => (sc, u, s) => { var elements = sc.GetPublicElements(u, s, out var status); return new { status, elements }; }),
        ["ListReferenceable"] = Read<ScSoapSend>(_ => (sc, u, s) =>
        {
            var referenceable = sc.ListReferenceable(u, s, CancellationToken.None, out var status);
            return new { status, referenceable };
        }),
        ["GetReferenceDetails"] = Read<ScSoapSend>(a =>
        {
            var key = a.Key("key"); var kind = a.Text("kind");
            return (sc, u, s) => { var reference = sc.GetReferenceDetails(key, kind, u, s, out var status); return new { status, reference }; };
        }),
        ["ListCommits"] = Read<ScSoapSend>(a =>
        {
            var modules = a.Int("eSpacesStartVersion", 0); var extensions = a.Int("extensionsStartVersion", 0); var since = a.Date("startDate");
            return (sc, u, s) => sc.ListCommits(u, s, modules, extensions, since);
        }),
        ["ListSolutionComponents"] = Read<ScSoapSend>(a => { var name = a.Text("solutionName"); return (sc, u, s) => sc.ListSolutionComponents(u, s, name); }),
        ["GetDeveloperOperations"] = Read<ScSoapSend>(a => { var since = a.Date("startDate"); return (sc, u, s) => sc.GetDeveloperOperations(u, s, since); }),
        ["ListCatalogs"] = Read<ScSoapSend>(_ => (sc, u, s) => { var catalogs = sc.ListCatalogs(u, s, out var status); return new { status, catalogs }; }),
        ["GetLicenseInformation"] = Read<ScSoapSend>(_ => (sc, u, s) =>
        {
            sc.GetLicenseInformation(u, s, out var license, out var softwareUnits, out var namedUsers, out var serverDate, out var trial);
            return new { license, softwareUnits, namedUsers, serverDate, trialCommunityInstalled = trial };
        }),
        ["GetInstallationKind"] = Read<ScSoapSend>(_ => (sc, _, _) =>
        {
            var kind = sc.GetInstallationKind(out var databaseKind, out var applicationServerType);
            return new { kind, databaseKind, applicationServerType };
        }),
        ["GetPropertiesForHandshake"] = Read<ScSoapSend>(_ => (sc, _, _) => sc.GetPropertiesForHandshake()),
        ["GetProperties"] = Read<ScSoapSend>(_ => (sc, u, s) => sc.GetProperties(u, s)),
        ["GetUserProviders"] = Read<ScSoapSend>(a => { var key = a.Key("selfESpaceKey"); return (sc, u, s) => sc.GetUserProviders(u, s, key); }),
        ["GetEntryPoints"] = Read<ScSoapSend>(a =>
        {
            var key = a.Key("eSpaceKey"); var inPta = a.Bool("inPTA", false); var pta = a.Raw("targetPTA");
            return (sc, u, s) => sc.GetEntryPoints(u, s, key, inPta, pta!);
        }),
        ["GetPossibleEntryESpaces"] = Read<ScSoapSend>(a => { var key = a.Key("eSpaceKey"); return (sc, u, s) => sc.GetPossibleEntryESpaces(u, s, key); }),
        ["GetEspaceEntitiesDBProviderKeys"] = Read<ScSoapSend>(a => { var key = a.Key("eSpaceKey"); return (sc, u, s) => sc.GetEspaceEntitiesDBProviderKeys(u, s, key); }),
        ["ListTemplates"] = Read<ScSoapSend>(_ => (sc, u, s) => sc.ListTemplates(u, s)),
        ["GetTemplateInfo"] = Read<ScSoapSend>(a =>
        {
            var key = a.Key("templateKey");
            return (sc, u, s) => { sc.GetTemplateInfo(u, s, key, out var userProvider); return new { userProvider }; };
        }),
        ["ListPersonalAreas"] = Read<ScSoapSend>(_ => (sc, u, s) => sc.ListPersonalAreas(u, s)),
        ["CheckSolutionPublish"] = Read<ScSoapSend>(a =>
        {
            var id = a.Int("solutionPublishId"); var lastSeen = a.Int("lastSeenMessageId", 0);
            return (sc, u, s) => { var messages = sc.CheckSolutionPublish(u, s, id, lastSeen, out var lastMessageId); return new { messages, lastMessageId }; };
        }),
        ["Download"] = Read<ScSoapSend>(a =>
        {
            var version = a.Int("versionId"); var key = a.Key("eSpaceKey");
            return (sc, u, s) =>
            {
                var bytes = sc.Download(u, s, version, key, CancellationToken.None, out var uploadDate, out var uploadUser, out var published, out var message, out var success);
                return new ScBinary(bytes, new { success, message, uploadDate, uploadUser, isPublishedVersion = published, versionId = version });
            };
        }),
        ["DownloadExtension"] = Read<ScSoapSend>(a =>
        {
            var version = a.Int("versionId"); var key = a.Key("extensionKey");
            return (sc, u, s) => new ScBinary(sc.DownloadExtension(u, s, version, key), new { versionId = version });
        }),
        ["DownloadApplication"] = Read<ScSoapSend>(a =>
        {
            var key = a.Key("appKey");
            return (sc, u, s) => { var bytes = sc.DownloadApplication(u, s, key, out var message, out var success); return new ScBinary(bytes, new { success, message }); };
        }),
        // Simulation by default: only simulate:false deletes, and then it is a destructive write.
        ["DeleteApplication"] = new ScOp<ScSoapSend>(a =>
        {
            var key = a.Key("appKey"); var simulate = a.Bool("simulate", true);
            return (sc, u, s) =>
            {
                var success = sc.DeleteApplication(u, s, key, simulate, out var messages, out var affected, out var deleted);
                return new { success, simulated = simulate, messages, affectedApplications = affected, deletedModules = deleted };
            };
        }, Destroys: a => Target(a, "appKey"), WriteWhen: a => !a.Bool("simulate", true)),
        ["DeleteModule"] = Write<ScSoapSend>(a =>
        {
            var key = a.Key("moduleKey"); var kind = a.OneOf("moduleKind", "eSpace", "Extension");
            return (sc, u, s) => { var success = sc.DeleteModule(u, s, key, kind, out var message); return new { success, message }; };
        }, a => Target(a, "moduleKey")),
        ["MoveModuleBetweenApps"] = Write<ScSoapSend>(a =>
        {
            var from = a.Key("fromAppKey"); var to = a.Key("toAppKey"); var kind = a.OneOf("moduleKind", "eSpace", "Extension"); var key = a.Key("moduleKey");
            return (sc, u, s) => { var success = sc.MoveModuleBetweenApps(u, s, from, to, kind, key, out var message); return new { success, message }; };
        }),
        ["AddModuleToApplication"] = Write<ScSoapSend>(a =>
        {
            var app = a.Key("appKey"); var kind = a.OneOf("moduleKind", "eSpace", "Extension"); var key = a.Key("moduleKey");
            return (sc, u, s) => { var success = sc.AddModuleToApplication(u, s, app, kind, key, out var message); return new { success, message }; };
        }),
        ["ChangeCommitMessage"] = Write<ScSoapSend>(a =>
        {
            var version = a.Int("eSpaceVersionId"); var message = a.Text("newCommitMessage");
            return (sc, u, s) => { sc.ChangeCommitMessage(u, s, version, message); return new { changed = true }; };
        }),
        ["UploadAndPublishExtension"] = Write<ScSoapSend>(a =>
        {
            var bytes = a.Bytes("file"); var commit = a.Raw("commitMessage") ?? ""; var app = a.OptionalObjectKey("applicationKey");
            return (sc, u, s) =>
            {
                var messages = sc.UploadAndPublishExtension(u, s, bytes, commit, app!, out var extensionId, out var extensionVersionId);
                return new { messages, extensionId, extensionVersionId };
            };
        }),
        ["PublishSolution"] = Write<ScSoapSend>(a =>
        {
            var bytes = a.Bytes("file"); var name = a.Raw("filename") is { Length: > 0 } given ? given : System.IO.Path.GetFileName(a.Path("file"));
            return (sc, u, s) =>
            {
                var messages = sc.PublishSolution(u, s, bytes, name, out var solutionPublishId, out var packUID, out var needsConfiguration);
                return new { messages, solutionPublishId, packUID, needsConfiguration };
            };
        }),
    };

    /// <summary>server.api/v1 through the provider's ServerApiService (bearer from the Studio's login).</summary>
    public static readonly IReadOnlyDictionary<string, ScOp<ScServerApiSend>> ServerApiOperations = new Dictionary<string, ScOp<ScServerApiSend>>(StringComparer.OrdinalIgnoreCase)
    {
        ["ListDatabases"] = Read<ScServerApiSend>(a => { var apps = a.Bool("withAppsInfo", false); return (api, login) => api.ListDatabases(login, apps); }),
        ["GetDatabaseByApplicationKey"] = Read<ScServerApiSend>(a => { var key = a.Key("applicationKey"); return (api, login) => api.GetDatabaseByApplicationKey(login, key); }),
        ["AssociateAppWithDatabase"] = Write<ScServerApiSend>(a =>
        {
            var key = a.Key("applicationKey"); var database = a.Text("databaseId");
            return (api, login) => new { associated = api.AssociateAppWithDatabase(login, key, database) };
        }),
        ["IsPWA"] = Read<ScServerApiSend>(a => { var module = a.Text("moduleName"); return (api, login) => new { isPWA = api.IsPWA(login, module) }; }),
        ["SetIsPWA"] = Write<ScServerApiSend>(a =>
        {
            var key = a.Key("applicationKey");
            if (a.Values["value"] is null) throw new ScFailure(ScCodes.BadRequest, "args.value is required");
            var value = a.Bool("value", false);
            return (api, login) => new { changed = api.SetIsPWA(login, key, value) };
        }),
        ["ListModules"] = Read<ScServerApiSend>(a =>
        {
            var apps = a.Bool("withAppInfo", false); var versions = a.Bool("withLastVersionInfo", false);
            return (api, login) => api.ListModules(login, apps, versions);
        }),
        ["GetModuleByModuleKey"] = Read<ScServerApiSend>(a =>
        {
            var key = a.Key("eSpaceKey"); var apps = a.Bool("withAppInfo", false);
            return (api, login) => api.GetModuleByModuleKey(login, key, apps, CancellationToken.None);
        }),
        ["ListVersions"] = Read<ScServerApiSend>(a => { var key = a.Key("eSpaceKey"); return (api, login) => api.ListVersions(login, key); }),
        ["ListReferenceable"] = Read<ScServerApiSend>(a =>
        {
            var key = a.Key("eSpaceKey"); var app = a.Key("appKey");
            return (api, login) => api.ListReferenceable(login, key, app, CancellationToken.None);
        }),
        ["GetReferenceDetails"] = Read<ScServerApiSend>(a => { var key = a.Key("referencedKey"); return (api, login) => api.GetReferenceDetails(login, key, CancellationToken.None); }),
        ["Download"] = Read<ScServerApiSend>(a =>
        {
            var key = a.Key("eSpaceKey"); var version = a.Int("versionToDownload");
            return (api, login) => new ScBinary(api.Download(login, key, version), new { versionId = version });
        }),
        ["GetApplicationUrl"] = Read<ScServerApiSend>(a =>
        {
            var key = a.OptionalObjectKey("key") ?? throw new ScFailure(ScCodes.BadRequest, "args.key is required");
            return (api, login) => new { url = api.GetApplicationUrl(login, key, CancellationToken.None) };
        }),
        // Never embed=configurations: its outputs carry usernames and passwords.
        ["GetEnvironment"] = Read<ScServerApiSend>(_ => (api, login) =>
        {
            var environment = api.GetEnvironment(login, "");
            return environment == null ? null : new { environment.EnvironmentKey, environment.LifetimeUrl };
        }),
        ["CheckPlatformHealth"] = Read<ScServerApiSend>(_ => (api, login) => new { healthy = api.CheckPlatformHealth(login.HostInfo) }),
        ["CanActivationFeatureBeUsed"] = Read<ScServerApiSend>(a =>
        {
            var feature = a.Text("featureId");
            return (api, login) => new { canBeUsed = api.CanActivationFeatureBeUsed(login, false, feature) };
        }),
    };

    /// <summary>/ServiceCenter/rest: reads through the Studio's services; the apply-settings write is the same PUT the
    /// Studio builds (ServiceCenterRESTServices.StartApplySettings) sent once, without SafeDoAuthenticatedOperation and
    /// HttpClient.RetryOnCommunicationError, which resend on 500 and timeouts.</summary>
    public static readonly IReadOnlyDictionary<string, ScOp<ScRestSend>> RestOperations = new Dictionary<string, ScOp<ScRestSend>>(StringComparer.OrdinalIgnoreCase)
    {
        ["environment-features"] = Read<ScRestSend>(_ => c =>
            (c.Api ?? throw Unavailable("ServiceCenterRest")).GetServerModelFeatures(c.Login!, Uri.UriSchemeHttps)),
        ["apply-settings-status"] = Read<ScRestSend>(a =>
        {
            var id = a.Int("id");
            return c => (c.Common ?? throw Unavailable("ServerCommonService")).GetApplySettingsStatus(id);
        }),
        ["apply-settings"] = Write<ScRestSend>(a => { var key = a.Key("applicationKey"); return c => StartApplySettings(c, key); }),
    };

    /// <summary>/ServiceCenter/IntegrationStudio.asmx, READS only (what Integration Studio asks before it builds an extension):
    /// the handshake with the engine version, the source stubs of a model XIF, the platform DLLs to compile against, and
    /// whether this exact extension version is already running. No write: nothing here takes an operationId or the write
    /// guard; uploads and publications stay on soap UploadAndPublishExtension. The zips go to args.outFile (or base64).</summary>
    public static readonly IReadOnlyDictionary<string, ScOp<ScIntegrationStudioSend>> IntegrationStudioOperations = new Dictionary<string, ScOp<ScIntegrationStudioSend>>(StringComparer.OrdinalIgnoreCase)
    {
        ["Handshake"] = Read<ScIntegrationStudioSend>(a =>
        {
            var version = a.Text("version"); var last = a.Raw("lastUpgradeVersion") ?? "";
            return c =>
            {
                var answer = IntegrationStudioCall(c, "Handshake", ("version", version), ("lastUpgradeVersion", last));
                return new JsonObject { ["ok"] = answer.Bool("ok") ?? false, ["error"] = Redacted(answer.Text("error"), c), ["platform"] = answer.Text("platform"), ["database"] = answer.Text("database") };
            };
        }),
        ["GenerateSourceCodeStubs"] = Read<ScIntegrationStudioSend>(a =>
        {
            var bytes = a.Bytes("file");
            return c =>
            {
                var answer = IntegrationStudioCall(c, "GenerateSourceCodeStubs", ("extension", Convert.ToBase64String(bytes)));
                return new ScBinary(answer.Bytes("sourceCodeZip"), Messages(answer, c));
            };
        }),
        ["GetSourceCodeDependencies"] = Read<ScIntegrationStudioSend>(_ => c =>
        {
            var answer = IntegrationStudioCall(c, "GetSourceCodeDependencies");
            return new ScBinary(answer.Bytes("dependenciesZip"), Messages(answer, c));
        }),
        ["UploadNeeded"] = Read<ScIntegrationStudioSend>(a =>
        {
            var key = a.Key("extensionKey"); var hash = a.Text("extensionHash");
            return c =>
            {
                var answer = IntegrationStudioCall(c, "UploadNeeded", ("ExtensionGUID", key), ("ExtensionHash", hash));
                var result = Messages(answer, c);
                result["needs"] = answer.Bool("Needs"); result["extensionId"] = answer.Int("ExtensionId");
                result["equalVersionId"] = answer.Int("equalVersionId"); result["runningVersionId"] = answer.Int("runningVersionId");
                return result;
            };
        }),
    };

    private static JsonObject Messages(ScSoapAnswer answer, ScIntegrationStudioContext c) => new()
    {
        ["messages"] = ScRedaction.Node(new JsonArray(answer.Messages.Select(m => (JsonNode)m.DeepClone()).ToArray()), c.Secret),
        ["errors"] = answer.Errors.Count,
    };

    public static JsonObject Catalog() => new()
    {
        ["soap"] = Names(SoapOperations.Keys), ["server-api"] = Names(ServerApiOperations.Keys), ["sc-rest"] = Names(RestOperations.Keys),
        ["integration-studio"] = Names(IntegrationStudioOperations.Keys),
        ["closed"] = Names(Closed.Append("Metrics_*")),
    };

    /// <summary>One POST to IntegrationStudio.asmx and its reading. HTTP not 2xx or a SOAP fault is a REMOTE_ERROR (a read:
    /// nothing changed on the server), its text redacted of the secret.</summary>
    private static ScSoapAnswer IntegrationStudioCall(ScIntegrationStudioContext c, string operation, params (string Name, string Value)[] fields)
    {
        var http = c.Http(ScIntegrationStudioSoap.Request(c.Host, operation, c.User, c.Secret, fields));
        var answer = ScIntegrationStudioSoap.Parse(operation, http.Status, http.Body);
        if (http.Status is < 200 or >= 300 || answer.Fault != null)
            throw new ScFailure(ScCodes.RemoteError, $"integration-studio {operation}: HTTP {http.Status}" + (answer.Fault != null ? ": " + Redacted(answer.Fault, c) : ""), true,
                new JsonObject { ["status"] = http.Status, ["fault"] = Redacted(answer.Fault, c) });
        return answer;
    }

    private static string? Redacted(string? text, ScIntegrationStudioContext c) => text == null ? null : ScRedaction.Text(text.Length > 2000 ? text[..2000] : text, c.Secret);

    private static JsonArray Names(IEnumerable<string> names) => new(names.Order(StringComparer.Ordinal).Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());

    private static ScFailure Unavailable(string what) => new(ScCodes.StudioUnavailable, $"the Studio's {what} is unavailable for this login");

    /// <summary>Everything that can be refused is refused here, before the Studio is touched: unknown or closed
    /// operations, arguments, files, and the write fields.</summary>
    public static ScPrepared Prepare(JsonObject request, string host)
    {
        var surface = ScGuard.Text(request, "surface") ?? Soap;
        var operation = ScGuard.Text(request, "operation") is { Length: > 0 } name ? name : throw new ScFailure(ScCodes.BadRequest, "operation is required");
        if (request["args"] is not (null or JsonObject)) throw new ScFailure(ScCodes.BadRequest, "args must be an object");
        var args = new ScArgs(request["args"] as JsonObject);
        return surface switch
        {
            Soap when IsClosed(operation) => throw new ScFailure(ScCodes.NotAllowed, $"{operation} is closed: it is never executed through the bridge"),
            Soap => Build(surface, operation, SoapOperations, args, request, host),
            ServerApi => Build(surface, operation, ServerApiOperations, args, request, host),
            ScRest => Build(surface, operation, RestOperations, args, request, host),
            IntegrationStudio => Build(surface, operation, IntegrationStudioOperations, args, request, host),
            _ => throw new ScFailure(ScCodes.BadRequest, "surface must be soap, server-api, sc-rest or integration-studio"),
        };
    }

    private static ScPrepared Build<T>(string surface, string operation, IReadOnlyDictionary<string, ScOp<T>> table, ScArgs args,
        JsonObject request, string host) where T : Delegate
    {
        if (!table.TryGetValue(operation, out var op))
            throw new ScFailure(ScCodes.NotAllowed, $"{surface} operation '{operation}' is not in the allowlist (see bridge_manifest serviceCenter)");
        var canonical = table.Keys.First(k => string.Equals(k, operation, StringComparison.OrdinalIgnoreCase));
        var write = op.IsWrite(args);
        var targets = write && op.Destroys != null ? op.Destroys(args) : null;
        var operationId = write ? ScGuard.Write(request, host, targets != null, targets ?? []) : null;
        var send = op.Prepare(args);
        var outFile = args.OutFile();
        return new ScPrepared(surface, canonical, write, targets != null, operationId, args, send, outFile);
    }

    /// <summary>One send. The Studio's secret is taken fresh; the login is re-validated; the operationId is claimed; then
    /// the call goes out ONCE. Any exception after that point is UNCERTAIN for a write.</summary>
    public static JsonObject Execute(ScPrepared call, ScBound studio)
    {
        string secret;
        try { secret = studio.Secret(); }
        catch (Exception error) { throw new ScFailure(ScCodes.StudioNotSignedIn, "the Studio could not provide its session for this call: " + ScReply.Unwrap(error)); }
        Func<object?> send = call.Send switch
        {
            ScSoapSend soap => Bind(studio.Soap, "Service Center API", api => () => soap(api, studio.User, secret)),
            ScServerApiSend rest => Bind(studio.ServerApi, "ServerApiService", api => () => rest(api, studio.Login!)),
            ScRestSend rest => () => rest(new ScRestContext(studio.RestService, studio.RestApi, studio.Common, studio.Login, studio.Host, studio.User, secret)),
            ScIntegrationStudioSend integration => Bind(studio.IntegrationStudioHttp, "HTTP client", http => () => integration(new ScIntegrationStudioContext(http, studio.Host, studio.User, secret))),
            _ => throw new ScFailure(ScCodes.BadRequest, "unknown operation kind"),
        };
        if (call.Surface == ServerApi && call.Write && !studio.ServerApiSingleSend)
            throw new ScFailure(ScCodes.NotAllowed, "this Studio sends server.api through a client that resends after errors; server.api writes are refused here");
        if (call.Surface == ScRest && call.Write && studio.RestService == null) throw Unavailable("RestService");
        if (call.Surface == ServerApi && studio.Login == null) throw Unavailable("login object");
        try { studio.Validate?.Invoke(); }
        catch (Exception error) { throw new ScFailure(ScCodes.StudioNotSignedIn, "the Studio login or environment changed; nothing was sent: " + ScReply.Unwrap(error)); }
        if (call.OperationId != null) ScLedger.Claim(call.OperationId);
        object? raw;
        try { raw = send(); }
        catch (ScFailure) { throw; }
        catch (Exception error)
        {
            throw call.Write ? ScReply.Uncertain($"{call.Surface} {call.Operation}", error, secret)
                : new ScFailure(ScCodes.RemoteError, ScRedaction.Text($"{call.Surface} {call.Operation}: {ScReply.Unwrap(error)}", secret), true);
        }
        JsonNode? result;
        try { result = Result(call, raw, secret); }
        catch (ScFailure) { throw; }
        catch (Exception error)
        {
            // The server answered but the answer could not be read: a write stays uncertain.
            throw call.Write ? ScReply.Uncertain($"{call.Surface} {call.Operation} (unreadable answer)", error, secret)
                : new ScFailure(ScCodes.RemoteError, ScRedaction.Text($"{call.Surface} {call.Operation}: unreadable answer: {ScReply.Unwrap(error)}", secret), true);
        }
        return new JsonObject
        {
            ["surface"] = call.Surface, ["operation"] = call.Operation, ["write"] = call.Write, ["operationId"] = call.OperationId,
            ["result"] = result,
        };
    }

    private static Func<object?> Bind<T>(T? api, string what, Func<T, Func<object?>> send) where T : class =>
        send(api ?? throw Unavailable(what));

    private static JsonNode? Result(ScPrepared call, object? raw, string secret)
    {
        switch (raw)
        {
            case ScHttp http when http.Status is >= 200 and < 300:
                return ScRedaction.Node(new JsonObject { ["status"] = http.Status, ["body"] = Body(http) }, secret);
            case ScHttp http:
                var detail = new JsonObject { ["status"] = http.Status, ["body"] = ScRedaction.Node(Body(http), secret) };
                if (call.Write && (http.Status is 0 or 408 or >= 500))
                    throw new ScFailure(ScCodes.Uncertain, $"{call.Surface} {call.Operation}: HTTP {http.Status}; the server may have applied it; it is never resent: reconcile by a read", true,
                        new JsonObject { ["outcome"] = "uncertain", ["status"] = http.Status });
                throw new ScFailure(ScCodes.RemoteError, $"{call.Surface} {call.Operation}: HTTP {http.Status}", true, detail);
            case ScBinary binary:
                return Binary(call, binary, secret);
            default:
                return ScRedaction.Node(Project(raw), secret);
        }
    }

    private static JsonNode? Body(ScHttp http)
    {
        if (string.IsNullOrWhiteSpace(http.Body)) return null;
        try { return JsonNode.Parse(http.Body); }
        catch (JsonException) { return JsonValue.Create(http.Body.Length > 4000 ? http.Body[..4000] : http.Body); }
    }

    private static JsonObject Binary(ScPrepared call, ScBinary binary, string secret)
    {
        var bytes = binary.Bytes ?? [];
        var result = new JsonObject { ["bytes"] = bytes.Length, ["meta"] = ScRedaction.Node(Project(binary.Meta), secret) };
        if (bytes.Length == 0) return result;
        result["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (call.OutFile != null)
        {
            try
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(call.OutFile)!);
                using (var file = new FileStream(call.OutFile, FileMode.CreateNew, FileAccess.Write)) file.Write(bytes);
            }
            catch (Exception error) { throw new ScFailure(ScCodes.BadRequest, "the result was read but args.outFile could not be written: " + error.Message, true); }
            result["file"] = call.OutFile;
        }
        else if (bytes.Length <= Base64Limit) result["base64"] = Convert.ToBase64String(bytes);
        else throw new ScFailure(ScCodes.BadRequest, $"the result has {bytes.Length} bytes, above {Base64Limit}: pass args.outFile (absolute path)", true);
        return result;
    }

    /// <summary>Studio DTOs as JSON; string dictionaries (properties) as objects so their names stay visible to redaction.</summary>
    public static JsonNode? Project(object? value) => value switch
    {
        JsonNode node => node.DeepClone(),
        IDictionary<string, string> map => new JsonObject(map.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)JsonValue.Create(p.Value)))),
        _ => BridgeKit.Project(value),
    };

    /// <summary>PUT /ServiceCenter/rest/PlatformServices/applysettings/application/{key}, Basic user:secret, once.</summary>
    private static ScHttp StartApplySettings(ScRestContext context, string applicationKey)
    {
        var parameters = new HttpRequestParameters(
            new Uri($"https://{context.Host}/ServiceCenter/rest/PlatformServices/applysettings/application/{Uri.EscapeDataString(applicationKey)}"),
            timeout: TimeSpan.FromMinutes(2), retryOnCommunicationError: false, handleCommunicationError: false);
        parameters.AddAuthenticationHeader(context.User, context.Secret);
        using var response = context.Rest!.Put(parameters) ?? throw new InvalidOperationException("no HTTP response");
        return new ScHttp((int)response.StatusCode, response.Content?.Headers.ContentType?.ToString(),
            response.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? "");
    }
}
