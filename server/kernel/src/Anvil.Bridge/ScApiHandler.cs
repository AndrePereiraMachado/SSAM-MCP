using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using OutSystems.Communication.Identity;
using OutSystems.Communication.Identity.Login;
using OutSystems.Communication.RESTServices.RESTUtils;
using ServiceStudio.Presenter;
using ServiceStudio.ServerCommunications;
using ServiceStudio.ServerCommunications.ServiceCenter;

namespace Anvil.Bridge;

/// <summary>
/// sc_api, sc_session and studio_login: the Service Center through the Studio's own login for the requested host (SSO
/// included). The secret is taken inside this process for each call and never leaves it; answers are projected and
/// redacted (ScOperations, ScProtocol). Contract: CONTRATO.md of the integration, O11 section.
/// sc_api {host, surface, operation, args, write?, operationId?, authorizeSha256?, target?, corporateInstruction?}
/// sc_session {host?}; studio_login {host, waitMs?}
/// </summary>
internal static class ScApiHandler
{
    private sealed record Bound(object Provider, object Info, string Host, string User, string Type);

    private static readonly SemaphoreSlim Gate = new(1);
    private static readonly Dictionary<string, Task<bool>> Logins = new(StringComparer.OrdinalIgnoreCase);

    public static async Task<string> Api(JsonObject? p)
    {
        try
        {
            if (p == null) throw new ScFailure(ScCodes.BadRequest, "sc_api parameters are required");
            var host = ScGuard.Host(ScGuard.Text(p, "host"));
            var call = ScApi.Prepare(p, host);
            await Gate.WaitAsync();
            try
            {
                var login = await OnUi(() => Bind(host));
                var bound = await OnUi(() => Resolve(login));
                var watch = Stopwatch.StartNew();
                var data = await Task.Run(() => ScApi.Execute(call, bound));
                return ScReply.Ok("studio", host, login.User, watch.ElapsedMilliseconds, data);
            }
            finally { Gate.Release(); }
        }
        catch (ScFailure failure) { return ScReply.Fail(failure); }
        catch (Exception error) { return ScReply.Fail(new ScFailure(ScCodes.StudioUnavailable, "sc_api: " + ScReply.Unwrap(error))); }
    }

    public static async Task<string> Session(JsonObject? p)
    {
        try
        {
            var host = p != null && ScGuard.Text(p, "host") is { Length: > 0 } requested ? ScGuard.Host(requested) : null;
            var logins = await OnUi(() => Studio.LoggedInProviders().Where(LoggedIn)
                .Select(provider => Describe(provider)).Where(x => x != null).Cast<JsonObject>().ToArray());
            var mine = host == null ? null : logins.FirstOrDefault(x => ScGuard.SameHost(x["host"]?.ToString(), host));
            bool pending;
            lock (Logins) pending = host != null && Logins.TryGetValue(host, out var task) && !task.IsCompleted;
            var body = new JsonObject
            {
                ["studio"] = host == null ? null : mine?.DeepClone() ?? new JsonObject { ["signedIn"] = false, ["loginPending"] = pending },
                ["signedInHosts"] = new JsonArray(logins.Select(x => x["host"]?.DeepClone()).ToArray()),
                ["web"] = host == null ? null : await ScWebHandler.Describe(host),
                ["bridge"] = Dispatch.BridgeInfo(),
            };
            return ScReply.Ok("studio", host ?? "", mine?["user"]?.ToString(), 0, body);
        }
        catch (ScFailure failure) { return ScReply.Fail(failure); }
        catch (Exception error) { return ScReply.Fail(new ScFailure(ScCodes.StudioUnavailable, "sc_session: " + ScReply.Unwrap(error))); }
    }

    /// <summary>Opens the Studio's own sign-in (ServerOperations.Login -> TryAutoLoginOrShowLoginDialog) for a host the
    /// Studio has no session on. The user types the password or completes SSO there; nothing comes back but the state.
    /// Once signed in, the Studio window works on that environment (the Studio keeps one connection per window).</summary>
    public static async Task<string> Login(JsonObject? p)
    {
        try
        {
            if (p == null) throw new ScFailure(ScCodes.BadRequest, "studio_login parameters are required");
            var host = ScGuard.Host(ScGuard.Text(p, "host"));
            var wait = Math.Clamp(p["waitMs"] is JsonValue w && w.TryGetValue<int>(out var ms) ? ms : 3000, 0, 60000);
            if (await OnUi(() => SignedIn(host)))
                return ScReply.Ok("studio", host, null, 0, new JsonObject { ["signedIn"] = true, ["dialogOpened"] = false });
            Task<bool> task;
            bool started;
            lock (Logins)
            {
                started = !Logins.TryGetValue(host, out task!) || task.IsCompleted;
                if (started) Logins[host] = task = StartLogin(host);
            }
            await Task.WhenAny(task, Task.Delay(wait));
            if (!task.IsCompleted)
                return ScReply.Ok("studio", host, null, 0, new JsonObject { ["signedIn"] = false, ["dialogOpened"] = started, ["pending"] = true,
                    ["note"] = "the Studio shows its sign-in; the user completes it there, then sc_session reports the login" });
            lock (Logins) if (Logins.TryGetValue(host, out var done) && ReferenceEquals(done, task)) Logins.Remove(host);
            // A refusal with its own code (STUDIO_WINDOWLESS) keeps it.
            if (task.IsFaulted) throw task.Exception!.GetBaseException() as ScFailure ?? new ScFailure(ScCodes.StudioUnavailable, "studio_login: " + ScReply.Unwrap(task.Exception!));
            return ScReply.Ok("studio", host, null, 0, new JsonObject { ["signedIn"] = await OnUi(() => SignedIn(host)), ["dialogOpened"] = started,
                ["accepted"] = task.Result });
        }
        catch (ScFailure failure) { return ScReply.Fail(failure); }
        catch (Exception error) { return ScReply.Fail(new ScFailure(ScCodes.StudioUnavailable, "studio_login: " + ScReply.Unwrap(error))); }
    }

    private static Task<bool> StartLogin(string host) => Task.Run(async () =>
    {
        var target = await OnUi(() =>
        {
            var runtime = ServiceStudio.Runtime.Instance as RuntimeImplementation
                ?? throw new ScFailure(ScCodes.StudioUnavailable, "Service Studio runtime is unavailable");
            // D5 (atritos 3): a process whose main window was closed is never the lane's Studio: STUDIO_WINDOWLESS with its pid.
            var window = runtime.AggregatorWindows.FirstOrDefault() ?? throw ScWindowLifetime.Windowless(Environment.ProcessId, "studio_login");
            return (ITopLevelPresenter?)window.ServerPagePresenter ?? window.SelectedTopLevelPresenter
                ?? throw new ScFailure(ScCodes.StudioUnavailable, "the Studio window has no top-level presenter");
        });
        // As LoginHandler: the login runs on a worker, never on the UI thread.
        return ServerOperations.Login(target, HostInfo.GetHostInfo(host));
    });

    // Bounded and withdrawn when the UI thread does not run it (UiGate.cs); also for Validate, called from a worker thread.
    private static Task<T> OnUi<T>(Func<T> action, [System.Runtime.CompilerServices.CallerMemberName] string what = "") => Ui.Run(action, UiGate.Read, "sc: " + what);

    private static bool LoggedIn(object provider) => Studio.Flag(provider, "IsLoggedIn") != false;

    private static bool SignedIn(string host) =>
        Studio.LoggedInProviders().Where(LoggedIn).Any(p => ScGuard.SameHost(Studio.ProviderHost(p), host));

    /// <summary>Whether the Studio itself is signed in on host (sc_session's studio.signedIn), for ScWebHandler: an expired
    /// Service Center window re-enters silently only then (ScWebSession.OnSignInPage). False when the Studio cannot tell.</summary>
    internal static async Task<bool> StudioSignedIn(string host)
    {
        try { return await OnUi(() => SignedIn(host)); }
        catch (Exception) { return false; }
    }

    private static JsonObject? Describe(object provider)
    {
        var info = Studio.Prop(provider, "LoginInfo");
        if (info == null || Studio.ProviderHost(provider) is not { } host) return null;
        return new JsonObject { ["signedIn"] = true, ["host"] = host.ToLowerInvariant(), ["user"] = Studio.Prop(info, "UserName") as string,
            ["loginType"] = LoginType(info), ["serverVersion"] = Studio.Prop(Studio.Prop(info, "HostInfo"), "Version")?.ToString() };
    }

    private static string LoginType(object info)
    {
        var name = info.GetType().Name;
        return name.Contains("Token", StringComparison.Ordinal) ? "token" : name.Contains("Password", StringComparison.Ordinal) ? "password" : name;
    }

    /// <summary>The provider logged in on host (the active one when several are).</summary>
    private static Bound Bind(string host)
    {
        if (ServiceStudio.Runtime.Instance is not RuntimeImplementation)
            throw new ScFailure(ScCodes.StudioUnavailable, "Service Studio runtime is unavailable");
        var providers = Studio.LoggedInProviders().Where(LoggedIn).ToArray();
        var matches = providers.Where(p => ScGuard.SameHost(Studio.ProviderHost(p), host)).ToArray();
        if (matches.Length == 0)
            throw new ScFailure(ScCodes.StudioNotSignedIn, $"Service Studio has no session on {host}; studio_login opens the Studio's own sign-in for it",
                details: new JsonObject { ["signedInHosts"] = new JsonArray(providers.Select(x => (JsonNode?)JsonValue.Create(Studio.ProviderHost(x))).ToArray()) });
        var active = Studio.ActiveAggregator()?.ServerCommunicationsProvider;
        var provider = matches.FirstOrDefault(m => ReferenceEquals(m, active)) ?? matches[0];
        var info = Studio.Prop(provider, "LoginInfo") ?? throw new ScFailure(ScCodes.StudioNotSignedIn, $"Service Studio has no session on {host}");
        var user = Studio.Prop(info, "UserName") as string ?? throw new ScFailure(ScCodes.StudioNotSignedIn, "the Studio login has no user");
        return new Bound(provider, info, host, user, LoginType(info));
    }

    private static ScBound Resolve(Bound login)
    {
        var communications = Communications(login.Provider);
        var serverApi = communications?.ServerApiService;
        var rest = communications?.ServiceCenterRest;
        return new ScBound
        {
            Host = login.Host, User = login.User,
            Secret = () => login.Info.GetType().GetMethod("GetSecretForWebServiceRequest", Type.EmptyTypes)?.Invoke(login.Info, null) as string
                ?? throw new InvalidOperationException("Studio authenticated request capability is unavailable"),
            Soap = Studio.ServiceCenterApi(login.Provider),
            ServerApi = serverApi, ServerApiSingleSend = SingleSend(serverApi),
            Login = login.Info as ILoginInfoBase,
            RestService = rest?.RestService, RestApi = rest,
            Common = (login.Provider as ServerCommunicationsProvider)?.ServerCommonService,
            Validate = () => OnUi(() => { Validate(login); return true; }).GetAwaiter().GetResult(),
            IntegrationStudioHttp = IntegrationStudioPost,
        };
    }

    /// <summary>The HTTP of the integration-studio surface, from inside the Studio process (its proxy and certificate
    /// settings). Not the Studio's IRestService: its BuildRequest sends a byte body as application/octet-stream with Accept
    /// application/json, which IntegrationStudio.asmx (SOAP 1.1, text/xml) refuses. One POST, no redirect, no cookie, no
    /// retry; the envelope carries the user and the fresh secret and is never logged.</summary>
    private static readonly HttpClient IntegrationStudioClient = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
    {
        Timeout = TimeSpan.FromMinutes(5),
    };

    internal static ScHttp IntegrationStudioPost(ScSoapRequest request)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, request.Uri)
        {
            Content = new StringContent(request.Body, System.Text.Encoding.UTF8, "text/xml"),
        };
        message.Headers.TryAddWithoutValidation("SOAPAction", "\"" + request.SoapAction + "\"");
        using var response = IntegrationStudioClient.Send(message);
        var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        return new ScHttp((int)response.StatusCode, response.Content.Headers.ContentType?.ToString(), body);
    }

    private static void Validate(Bound login)
    {
        if (!Studio.LoggedInProviders().Contains(login.Provider, ReferenceEqualityComparer.Instance) ||
            !ReferenceEquals(Studio.Prop(login.Provider, "LoginInfo"), login.Info) ||
            !ScGuard.SameHost(Studio.ProviderHost(login.Provider), login.Host) ||
            !string.Equals(Studio.Prop(login.Info, "UserName") as string, login.User, StringComparison.Ordinal))
            throw new InvalidOperationException("Studio login or environment changed");
    }

    /// <summary>The provider's IServiceCenterCommunications (CommunicationsApi is protected, hence reflection).</summary>
    private static IServiceCenterCommunications? Communications(object provider) =>
        Studio.Prop(provider, "CommunicationsApi") as IServiceCenterCommunications;

    /// <summary>ServerAPIServices keeps one IHttpClient: OAuthHttpClient sends once; IdentityHttpClient can route to
    /// IdentityServiceHttpClient, which resends after 401 and through HttpClient.RetryOnCommunicationError.</summary>
    private static bool SingleSend(object? api)
    {
        for (var type = api?.GetType(); type != null; type = type.BaseType)
            foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                if (typeof(OutSystems.Communication.Identity.Identity.IHttpClient).IsAssignableFrom(field.FieldType))
                    return field.GetValue(api) is OAuthHttpClient;
        return false;
    }
}
