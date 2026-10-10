using System.Collections;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Avalonia.Threading;
using OutSystems.Communication.Identity;
using OutSystems.Communication.Identity.Login;
using OutSystems.Communication.Identity.Identity;
using OutSystems.Communication.Identity.Identity.ServerIdentity;
using OutSystems.Communication.Identity.Identity.IdentityService;
using OutSystems.Communication.RESTServices.RESTUtils;
using OutSystems.Communication.ServiceCenter;
using OutSystems.ObjectKeys;
using OutSystems.RuntimeCommon;
using ServiceStudio.Common.FeatureManagement;
using ServiceStudio.Model;
using ServiceStudio.Presenter;
using ServiceStudio.ServerCommunications.API;

// Unique assembly per attempt. No bridge/Core reference, mutation, UI automation,
// password/arbitrary-secret getter, credential file, global resolver or console logging.
internal static class StartupHook
{
    private static int initialized;
    public static void Initialize()
    {
        if (Interlocked.Exchange(ref initialized, 1) != 0) return;
        // The diagnostics IPC thread returns immediately. All exchange work is bounded.
        try { _ = Task.Run(Run); } catch { Receipt("failed", "debug_o11_hook_unavailable"); }
    }

    private static string ConfigPath => typeof(StartupHook).Assembly.Location + ".json";
    private static string ReceiptPath => typeof(StartupHook).Assembly.Location + ".receipt.json";
    private static void Receipt(string phase, string? error = null)
    {
        try { File.WriteAllText(ReceiptPath, JsonSerializer.Serialize(new { phase, error, pid = Environment.ProcessId }), new UTF8Encoding(false)); } catch { }
    }

    private static void Refuse(string code) => throw new AuthFailure(code);
    private sealed class AuthFailure(string code) : Exception { public string Code { get; } = code; }
    private const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    private static readonly Regex Key = new("^[A-Za-z0-9_+]{22}$", RegexOptions.CultureInvariant);
    private static readonly Regex Name = new("^[A-Za-z_][A-Za-z0-9_]{0,198}$", RegexOptions.CultureInvariant);
    private static object? Prop(object? value, string name)
    {
        if (value == null) return null;
        var type = value.GetType();
        var property = type.GetProperty(name, All) ?? type.GetInterfaces().Select(t => t.GetProperty(name)).FirstOrDefault(p => p != null);
        return property != null ? property.GetValue(value) : type.GetField(name, All)?.GetValue(value);
    }
    private static string Text(JsonObject value, string name) => value[name]?.GetValue<string>() ?? throw new AuthFailure("debug_o11_token_contract_missing");
    private static int Number(JsonObject value, string name) => value[name]?.GetValue<int>() ?? throw new AuthFailure("debug_o11_token_contract_missing");
    private static JsonObject Object(JsonObject value, string name) => value[name]?.AsObject() ?? throw new AuthFailure("debug_o11_token_contract_missing");
    private static bool Equal(object? a, object? b) => string.Equals(a?.ToString(), b?.ToString(), StringComparison.Ordinal);
    private static bool PrivateText(string? value, int characters, int bytes) => !string.IsNullOrWhiteSpace(value)
        && value.Length <= characters && Encoding.UTF8.GetByteCount(value) <= bytes && !value.Any(char.IsControl);
    private static string Host(object provider) => Prop(Prop(Prop(provider, "LoginInfo"), "HostInfo"), "HostName")?.ToString()?.ToLowerInvariant() ?? "";
    private static IAggregatorPresenter[] Aggregators(RuntimeImplementation runtime) => runtime.GetAllAggregators().OfType<IAggregatorPresenter>().ToArray();

    private sealed record Selected(object Provider, ILoginInfoBase Login, string Username, object Communications, object? Properties, object? ServerApi);
    private static Selected Select(JsonObject binding)
    {
        var runtime = ServiceStudio.Runtime.Instance as RuntimeImplementation ?? throw new AuthFailure("debug_o11_studio_unavailable");
        var aggregators = Aggregators(runtime);
        var providers = runtime.AggregatorWindows.Select(w => (object?)w.ServerCommunicationsProvider)
            .Concat(aggregators.Select(a => (object?)a.ServerCommunicationsProvider))
            .Where(p => p != null && Prop(p, "LoginInfo") is ILoginInfoBase && Prop(Prop(p, "LoginInfo"), "UserName") is string u && !string.IsNullOrEmpty(u))
            .Cast<object>().Distinct(ReferenceEqualityComparer.Instance)
            .Where(p => Host(p) == Text(binding, "host")).ToArray();
        if (providers.Length == 0) Refuse("debug_o11_environment_not_connected");
        // Same host can have more than one live account. Never choose the first silently.
        var logins = providers.Select(p => Prop(p, "LoginInfo")).Distinct(ReferenceEqualityComparer.Instance).ToArray();
        if (logins.Length != 1) Refuse("debug_o11_environment_ambiguous");
        foreach (var target in Targets(binding))
        {
            foreach (var aggregator in aggregators.Where(a => a.ActiveESpace != null && Host(a.ServerCommunicationsProvider) == Text(binding, "host")))
            {
                var module = aggregator.ActiveESpace!;
                if (module.Name == Text(target, "module") || module.Key.ToString() == Text(target, "moduleKey"))
                {
                    if (module.Name != Text(target, "module") || module.Key.ToString() != Text(target, "moduleKey") ||
                        !providers.Contains(aggregator.ServerCommunicationsProvider, ReferenceEqualityComparer.Instance)) Refuse("debug_o11_module_scope_mismatch");
                }
            }
        }
        // No open module is required: the explicit, fresh published inventory contract
        // was validated before selection and binds the closed module by key/name/app/version.
        var provider = providers[0];
        var login = (ILoginInfoBase)Prop(provider, "LoginInfo")!;
        var communications = Prop(provider, "CommunicationsApi");
        if (communications == null || !ReferenceEquals(Prop(communications, "LoginInfo"), login)) Refuse("debug_o11_login_changed");
        return new Selected(provider, login, Prop(login, "UserName")!.ToString()!, communications!, Prop(provider, "ServerProperties"), Prop(provider, "ServerApiService"));
    }

    private static void ValidateLogin(Selected selected, JsonObject binding)
    {
        var live = Select(binding);
        if (!ReferenceEquals(live.Provider, selected.Provider) || !ReferenceEquals(live.Login, selected.Login)
            || !ReferenceEquals(live.Communications, selected.Communications) || !Equal(Prop(live.Login, "UserName"), selected.Username)
            || Host(selected.Provider) != Text(binding, "host") || !ReferenceEquals(Prop(selected.Provider, "LoginInfo"), selected.Login)
            || !ReferenceEquals(Prop(selected.Provider, "CommunicationsApi"), selected.Communications)
            || !ReferenceEquals(Prop(selected.Communications, "LoginInfo"), selected.Login)) Refuse("debug_o11_login_changed");
    }

    private static IEnumerable<JsonObject> Targets(JsonObject binding)
    {
        yield return binding;
        if (binding["entry"] is JsonObject entry) yield return entry;
    }
    private static JsonNode? Property(JsonObject value, string name) => value.FirstOrDefault(p => p.Key.Equals(name, StringComparison.OrdinalIgnoreCase)).Value;
    private static void ValidateProof(JsonObject binding, JsonObject proof)
    {
        var path = Text(proof, "path");
        if (!Path.IsPathFullyQualified(path) || !Regex.IsMatch(Text(proof, "sha256"), "^[a-f0-9]{64}$")) Refuse("debug_o11_publication_proof_invalid");
        var bytes = File.ReadAllBytes(path);
        if (bytes.Length > 8 * 1024 * 1024 || Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != Text(proof, "sha256")) Refuse("debug_o11_publication_proof_changed");
        var data = JsonNode.Parse(bytes)?.AsObject() ?? throw new AuthFailure("debug_o11_publication_proof_invalid");
        if (Property(data, "host")?.GetValue<string>()?.ToLowerInvariant() != Text(binding, "host")) Refuse("debug_o11_module_scope_mismatch");
        if (!DateTimeOffset.TryParse(Property(data, "capturedAtUtc")?.GetValue<string>(), out var captured) ||
            captured > DateTimeOffset.UtcNow.AddSeconds(30) || captured < DateTimeOffset.UtcNow.AddMinutes(-15)) Refuse("debug_o11_publication_proof_stale");
        if (Property(data, "modules") is not JsonArray modules) Refuse("debug_o11_publication_proof_invalid");
        foreach (var target in Targets(binding))
        {
            var rows = ((JsonArray)Property(data, "modules")!).OfType<JsonObject>().Where(r => Equal(Property(r, "Key"), Text(target, "moduleKey"))).ToArray();
            if (rows.Length != 1 || !Equal(Property(rows[0], "Name"), Text(target, "module")) ||
                !Equal(Property(rows[0], "ApplicationKey"), Text(target, "applicationKey")) ||
                Property(rows[0], "VersionId")?.GetValue<int>() != Number(target, "publishedVersionId") ||
                Property(rows[0], "IsActive")?.GetValue<bool>() != true) Refuse("debug_o11_module_scope_mismatch");
        }
    }

    private static void ValidateConfig(JsonObject config, JsonObject binding)
    {
        using var process = Process.GetCurrentProcess();
        if (process.ProcessName != "ServiceStudio" || Number(binding, "pid") != Environment.ProcessId || Text(binding, "startedUtc") != process.StartTime.ToUniversalTime().ToString("O")) Refuse("debug_o11_process_changed");
        if (!Regex.IsMatch(Text(config, "operationId"), "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$") ||
            Text(config, "pipeName") != "ssam-o11-debug-token-" + Text(config, "operationId")) Refuse("debug_o11_token_contract_invalid");
        if (!Uri.TryCreate("https://" + Text(binding, "host") + "/", UriKind.Absolute, out var uri) || uri.Host != Text(binding, "host") || uri.UserInfo.Length > 0 || uri.Port != 443 || uri.AbsolutePath != "/") Refuse("debug_o11_token_contract_invalid");
        if (!Regex.IsMatch(Text(binding, "sessionId"), "^[a-f0-9]{32}$")) Refuse("debug_o11_token_contract_invalid");
        foreach (var target in Targets(binding))
            if (!Name.IsMatch(Text(target, "module")) || !Key.IsMatch(Text(target, "moduleKey")) || !Key.IsMatch(Text(target, "applicationKey")) || Number(target, "publishedVersionId") <= 0) Refuse("debug_o11_token_contract_missing");
        if (!DateTimeOffset.TryParse(Text(config, "expiresAt"), out var expiry) || expiry <= DateTimeOffset.UtcNow || expiry > DateTimeOffset.UtcNow.AddMinutes(2)) Refuse("debug_o11_token_lease_expired");
        ValidateProof(binding, Object(config, "publishedProof"));
    }

    private static (string Token, string Path) Mint(Selected selected, JsonObject binding)
    {
        if (selected.Properties is not IDictionary properties || !properties.Contains("NewDebuggerAuthentication") ||
            !string.Equals(properties["NewDebuggerAuthentication"]?.ToString(), "true", StringComparison.OrdinalIgnoreCase)) Refuse("debug_o11_legacy_authentication_unsupported");
        var scopes = Targets(binding).Select(t => "runtime_debugger_" + ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(Text(t, "moduleKey"))) + "_" + ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(Text(t, "applicationKey")))).Distinct().ToArray();
        if (!FeaturesProvider.Values.IdentityServiceIntegration_EAP)
            return (OAuthTokenManager.ForServiceStudio.GetTokenForDebuggingSession(selected.Login, scopes).TokenInfo.Token, "oauth");
        var method = selected.ServerApi?.GetType().GetMethod("EnvironmentSupportsIdentityServiceAuthentication", new[] { typeof(HostInfo) });
        if (method == null) Refuse("debug_o11_identity_capability_unavailable");
        var supports = method!.Invoke(selected.ServerApi, new object[] { HostInfo.GetHostInfo(Text(binding, "host")) });
        if (supports is not bool) Refuse("debug_o11_identity_capability_unavailable");
        ITokenManager manager = (bool)supports! ? ServiceCenterIdentityTokenManager.ForServiceStudio : ServerIdentityTokenManager.ForServiceStudio;
        return (manager.GetTokenForDebuggingSession(selected.Login, scopes, new List<string>(), strictScopeMatch: true).TokenInfo.AccessToken,
            (bool)supports! ? "identity-service" : "server-identity");
    }

    private static void ValidateSsoContext(Selected selected)
    {
        // The native token-only LoginInfo family exposes no password here. Never
        // call ILoginInfoBase.Secret/GetSecretForWebServiceRequest or wrap a login.
        if (selected.Login is not LoginInfoWithTokens) Refuse("debug_o11_soap_sso_context_unavailable");
        if (!PrivateText(selected.Username, 512, 2048))
            Refuse("debug_o11_soap_sso_context_unavailable");
    }

    private static string AcquireSoapIdToken(Selected selected)
    {
        ValidateSsoContext(selected);
        // Exact installed ExtendedLoginInfoWithTokens implementation calls this
        // manager with its existing login and uses TokenInfo.IdToken for SOAP.
        var idToken = ServiceCenterIdentityTokenManager.ForServiceStudio.GetTokenForServerCall(selected.Login).TokenInfo.IdToken;
        if (!PrivateText(idToken, 65536, 65536)) Refuse("debug_o11_soap_sso_context_unavailable");
        return idToken;
    }

    private sealed record PreflightContext(IServerCommonService Common, IServiceCenter Api, string? DefaultPersonalArea,
        string EntryName, string TargetKey, Uri PingUri, int TimeoutSeconds, MethodInfo ReadData);

    private static object? NativeStatic(string assemblyName, string typeName, string property)
    {
        var assembly = AppDomain.CurrentDomain.GetAssemblies().SingleOrDefault(a => a.GetName().Name == assemblyName);
        return assembly?.GetType(typeName, false)?.GetProperty(property, All)?.GetValue(null);
    }

    private static void ValidateHttps(Uri? uri, JsonObject binding, string? path = null)
    {
        if (uri == null || !uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps || uri.Host != Text(binding, "host")
            || uri.Port != 443 || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || (path != null && uri.AbsolutePath != path)) Refuse("debug_o11_preflight_scope_mismatch");
    }

    private static PreflightContext PreparePreflight(Selected selected, JsonObject binding)
    {
        if (Prop(selected.Provider, "ServerCommonService") is not IServerCommonService common
            || !ReferenceEquals(Prop(common, "ServerCommunications"), selected.Communications)
            || Prop(selected.Communications, "ServiceCenterApi") is not IServiceCenter api || !api.UseHttps)
            throw new AuthFailure("debug_o11_preflight_capability_unavailable");
        ValidateHttps(Prop(selected.Communications, "BaseHostUri") as Uri, binding);
        var defaultProperty = selected.Communications.GetType().GetProperty("DefaultPersonalAreaName", All);
        if (defaultProperty == null) Refuse("debug_o11_preflight_capability_unavailable");
        var defaultValue = defaultProperty!.GetValue(selected.Communications);
        if (defaultValue != null && defaultValue is not string) Refuse("debug_o11_preflight_capability_unavailable");
        var settings = NativeStatic("ServiceStudio.UserSettings", "ServiceStudio.UserSettings.Settings", "Instance");
        if (Prop(settings, "ServerCommunicationShortTimeoutInSeconds") is not int timeout || timeout < 1 || timeout > 60)
            throw new AuthFailure("debug_o11_preflight_timeout_unavailable");
        var extension = AppDomain.CurrentDomain.GetAssemblies().SingleOrDefault(a => a.GetName().Name == "OutSystems.FrameworkExtensions");
        var readData = extension?.GetType("OutSystems.FrameworkExtensions.CommunicationUtils", false)
            ?.GetMethod("ReadData", new[] { typeof(Uri), typeof(int), typeof(WebRequest) });
        if (readData == null) Refuse("debug_o11_preflight_capability_unavailable");
        var entryName = binding["entry"] is JsonObject entry ? Text(entry, "module") : Text(binding, "module");
        // Passing no applicationKey avoids an ALD lookup, and this pure URI method
        // does not call SafeDo, trust-policy mutation, UI, relogin or retries.
        var pingUri = common.GetPageUri(entryName, false, "_ping.aspx", false, null, null, CancellationToken.None);
        ValidateHttps(pingUri, binding, "/" + entryName + "/_ping.aspx");
        return new PreflightContext(common, api, (string?)defaultValue, entryName,
            ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(Text(binding, "moduleKey"))), pingUri, timeout, readData!);
    }

    private static void ValidatePreflight(Selected selected, PreflightContext preflight, JsonObject binding)
    {
        if (!ReferenceEquals(Prop(selected.Provider, "ServerCommonService"), preflight.Common)
            || !ReferenceEquals(Prop(preflight.Common, "ServerCommunications"), selected.Communications)
            || !ReferenceEquals(Prop(selected.Communications, "ServiceCenterApi"), preflight.Api)
            || !Equal(Prop(selected.Communications, "DefaultPersonalAreaName"), preflight.DefaultPersonalArea) || !preflight.Api.UseHttps)
            Refuse("debug_o11_login_changed");
        ValidateHttps(Prop(selected.Communications, "BaseHostUri") as Uri, binding);
        ValidateHttps(preflight.PingUri, binding, "/" + preflight.EntryName + "/_ping.aspx");
    }

    private static void PingPublicEntry(PreflightContext preflight, CancellationToken cancellation)
    {
        // Native ReadData accepts this exact request and leaves redirect policy
        // unchanged. Its default Windows credentials can only reach this pinned
        // origin; no bearer, app credentials, SOAP context, cookies or URI secret.
#pragma warning disable SYSLIB0014 // Exact installed native ReadData contract accepts WebRequest.
        var request = (HttpWebRequest)WebRequest.Create(preflight.PingUri);
#pragma warning restore SYSLIB0014
        request.AllowAutoRedirect = false;
        request.Method = "GET";
        request.CookieContainer = null;
        request.PreAuthenticate = false;
        request.ReadWriteTimeout = preflight.TimeoutSeconds * 1000;
        using var cancelled = cancellation.Register(() => request.Abort());
        string? response;
        try { response = preflight.ReadData.Invoke(null, new object[] { preflight.PingUri, preflight.TimeoutSeconds, request }) as string; }
        catch { throw new AuthFailure("debug_o11_preflight_ping_failed"); }
        if (response == null || response.Length > 65536 || (!response.Contains("OutSystems HubEdition is running", StringComparison.OrdinalIgnoreCase)
            && !response.Contains("OutSystems Platform Server is running", StringComparison.OrdinalIgnoreCase))) Refuse("debug_o11_preflight_ping_failed");
    }

    private static JsonObject CheckAssembly(Selected selected, PreflightContext preflight, string soapSecret)
    {
        OutSystems.Communication.ServiceCenter.AssemblyInfo? info;
        try { info = preflight.Api.GetAssemblyInfo(selected.Username, soapSecret, preflight.TargetKey, preflight.EntryName, false, preflight.DefaultPersonalArea); }
        catch { throw new AuthFailure("debug_o11_preflight_assembly_unavailable"); }
        if (info == null || ReferenceEquals(info, OutSystems.Communication.ServiceCenter.AssemblyInfo.Invalid)) Refuse("debug_o11_preflight_assembly_unavailable");
        if (!info!.InDebug) Refuse("debug_o11_preflight_not_in_debug");
        if (info.DebuggerVersion != 1) Refuse("debug_o11_preflight_protocol_mismatch");
        return new JsonObject { ["pingSucceeded"] = true, ["inDebug"] = true, ["debuggerVersion"] = 1 };
    }

    private static JsonObject AuthDiagnostics(string token, JsonObject binding)
    {
        var decoded = false;
        var targetAllowed = false;
        var entryAllowed = false;
        var notBeforeValid = false;
        var expirationValid = false;
        try
        {
            // Delegate decoding to the same already-loaded JWT handler as native
            // ServerDebuggerAdapter. ReadJwtToken does NOT verify signatures;
            // these booleans never authorize Start, invoke actions, or trigger retry.
            var assembly = AppDomain.CurrentDomain.GetAssemblies().SingleOrDefault(a => a.GetName().Name == "System.IdentityModel.Tokens.Jwt");
            var handlerType = assembly?.GetType("System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler", false);
            var method = handlerType?.GetMethod("ReadJwtToken", new[] { typeof(string) });
            var handler = handlerType == null ? null : Activator.CreateInstance(handlerType);
            var jwt = method?.Invoke(handler, new object[] { token });
            if (jwt != null && Prop(jwt, "Claims") is IEnumerable<Claim> nativeClaims)
            {
                decoded = true;
                var claims = nativeClaims.ToArray();
                var target = ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(Text(binding, "moduleKey")));
                var entry = binding["entry"] is JsonObject selectedEntry
                    ? ObjectKeyUtils.DatabaseValue(ObjectKey.Parse(Text(selectedEntry, "moduleKey"))) : target;
                targetAllowed = claims.Any(c => c.Type == "allow_debug" && c.Value == target);
                entryAllowed = claims.Any(c => c.Type == "allow_debug" && c.Value == entry);
                var now = DateTimeOffset.UtcNow;
                if (long.TryParse(claims.FirstOrDefault(c => c.Type == "nbf")?.Value, out var nbf))
                    try { notBeforeValid = DateTimeOffset.FromUnixTimeSeconds(nbf) <= now; } catch { }
                if (long.TryParse(claims.FirstOrDefault(c => c.Type == "exp")?.Value, out var exp))
                    try { expirationValid = DateTimeOffset.FromUnixTimeSeconds(exp) > now; } catch { }
            }
        }
        catch { }
        return new JsonObject { ["decodeSucceeded"] = decoded, ["notBeforeValid"] = notBeforeValid,
            ["expirationValid"] = expirationValid, ["timeValid"] = decoded && notBeforeValid && expirationValid,
            ["allowDebugTarget"] = targetAllowed, ["allowDebugEntry"] = entryAllowed };
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);

    private static async Task Run()
    {
        string? token = null;
        string? soapSecret = null;
        var mintSubmitted = false;
        var authenticationSubmitted = false;
        var authenticationCompleted = false;
        var preflightSubmitted = false;
        var preflightCompleted = false;
        var consumed = false;
        try
        {
            var config = JsonNode.Parse(File.ReadAllBytes(ConfigPath))?.AsObject() ?? throw new AuthFailure("debug_o11_token_contract_invalid");
            var binding = Object(config, "binding");
            ValidateConfig(config, binding);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            await using var pipe = new NamedPipeServerStream(Text(config, "pipeName"), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            Receipt("ready");
            await pipe.WaitForConnectionAsync(deadline.Token).WaitAsync(TimeSpan.FromSeconds(30));
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var clientPid) || clientPid != Number(config, "clientPid")) Refuse("debug_o11_private_client_mismatch");
            using (var client = Process.GetProcessById((int)clientPid))
                if (client.StartTime.ToUniversalTime().ToString("O") != Text(config, "clientStartedUtc")) Refuse("debug_o11_private_client_mismatch");
            using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true, NewLine = "\n" };
            var line = await reader.ReadLineAsync(deadline.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            if (line == null || line.Length > 16384) Refuse("debug_o11_token_contract_invalid");
            var request = JsonNode.Parse(line!)?.AsObject() ?? throw new AuthFailure("debug_o11_token_contract_invalid");
            if (Text(request, "operationId") != Text(config, "operationId") || !JsonNode.DeepEquals(request["binding"], binding)) Refuse("debug_o11_module_scope_mismatch");
            ValidateConfig(config, binding);
            var selected = await Dispatcher.UIThread.InvokeAsync(() => Select(binding));
            await Dispatcher.UIThread.InvokeAsync(() => ValidateLogin(selected, binding));
            ValidateSsoContext(selected);
            ValidateConfig(config, binding);
            var preflight = await Dispatcher.UIThread.InvokeAsync(() => PreparePreflight(selected, binding));
            Receipt("authenticating");
            authenticationSubmitted = true;
            soapSecret = await Task.Run(() => AcquireSoapIdToken(selected)).WaitAsync(TimeSpan.FromSeconds(30), deadline.Token);
            authenticationCompleted = true;
            await Dispatcher.UIThread.InvokeAsync(() => ValidateLogin(selected, binding));
            ValidatePreflight(selected, preflight, binding);
            ValidateConfig(config, binding);
            Receipt("preflighting");
            preflightSubmitted = true;
            await Task.Run(() => PingPublicEntry(preflight, deadline.Token)).WaitAsync(TimeSpan.FromSeconds(preflight.TimeoutSeconds + 1), deadline.Token);
            await Dispatcher.UIThread.InvokeAsync(() => ValidateLogin(selected, binding));
            ValidatePreflight(selected, preflight, binding);
            ValidateConfig(config, binding);
            var preflightResult = await Task.Run(() => CheckAssembly(selected, preflight, soapSecret)).WaitAsync(TimeSpan.FromSeconds(30), deadline.Token);
            preflightCompleted = true;
            await Dispatcher.UIThread.InvokeAsync(() => ValidateLogin(selected, binding));
            ValidatePreflight(selected, preflight, binding);
            ValidateConfig(config, binding);
            Receipt("minting");
            // Native authentication is not cancellable. Once submitted, a timeout can
            // leave it running; reconciliation must retain the target lock forever
            // until its exact receipt is inspected, rather than minting again.
            mintSubmitted = true;
            var minted = await Task.Run(() => Mint(selected, binding)).WaitAsync(TimeSpan.FromSeconds(60), deadline.Token);
            token = minted.Token;
            if (!PrivateText(token, 65536, 65536)) Refuse("debug_o11_token_unavailable");
            await Dispatcher.UIThread.InvokeAsync(() => ValidateLogin(selected, binding));
            ValidatePreflight(selected, preflight, binding);
            ValidateConfig(config, binding);
            // Sole secret channel: authenticated CurrentUser-only pipe to the pinned private parent process.
            var reply = new JsonObject { ["ok"] = true, ["token"] = token, ["soapUser"] = selected.Username, ["soapSecret"] = soapSecret,
                ["newAuthentication"] = true, ["path"] = minted.Path, ["binding"] = binding.DeepClone(), ["operationId"] = Text(config, "operationId"), ["preflight"] = preflightResult };
            if (config["authDiagnostics"]?.GetValue<bool>() == true) reply["diagnostics"] = AuthDiagnostics(token, binding);
            await writer.WriteLineAsync(reply.ToJsonString().AsMemory(), deadline.Token);
            reply.Clear();
            Receipt("delivered-unconfirmed");
            var ack = await reader.ReadLineAsync(deadline.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(3));
            if (ack == null || ack.Length > 1024 || JsonNode.Parse(ack)?["operationId"]?.GetValue<string>() != Text(config, "operationId")) Refuse("debug_o11_token_delivery_uncertain");
            consumed = true;
            Receipt("consumed");
            // Confirmation is metadata only. A parent that loses this confirmation
            // conservatively reconciles the consumed receipt and cannot mint again.
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, phase = "consumed", operationId = Text(config, "operationId") }).AsMemory(), deadline.Token);
        }
        catch (Exception error)
        {
            var uncertain = mintSubmitted || authenticationSubmitted && !authenticationCompleted
                || preflightSubmitted && !preflightCompleted && error is not AuthFailure;
            Receipt(consumed ? "consumed" : uncertain ? "uncertain" : "failed", error is AuthFailure failure ? failure.Code : "debug_o11_token_exchange_unavailable");
        }
        finally { token = null; soapSecret = null; }
    }
}
