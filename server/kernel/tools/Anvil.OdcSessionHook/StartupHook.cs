using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Avalonia.Threading;
using OutSystems.ObjectKeys;
using ServiceStudio.Presenter;
using ServiceStudio.Identity.Login;
using ServiceStudio.ServerCommunications.API;
using ServiceStudio.ServerCommunications.API.Services.AssetManagement;

// One bounded operation, one unique assembly. No model edits, password getter,
// login, bridge replacement, arbitrary reflection or console output.
internal static class StartupHook
{
    private static int initialized;
    private static string stage = "initializing";
    private static bool tokenDeliveryAttempted;
    private static string ConfigPath => typeof(StartupHook).Assembly.Location + ".json";
    private static string ReceiptPath => typeof(StartupHook).Assembly.Location + ".receipt.json";
    private sealed class Refusal(string code) : Exception { public string Code { get; } = code; }
    private static string Text(JsonObject o, string key) => o[key]?.GetValue<string>() ?? throw new Refusal("debug_odc_session_contract_invalid");
    private static int Number(JsonObject o, string key) => o[key]?.GetValue<int>() ?? throw new Refusal("debug_odc_session_contract_invalid");
    private static void Require(bool yes, string code) { if (!yes) throw new Refusal(code); }
    private static string ExceptionKind(Exception? error) => error switch
    {
        null => "none",
        Refusal => "contract",
        TimeoutException => "timeout",
        OperationCanceledException => "cancelled",
        UnauthorizedAccessException => "access-denied",
        System.Security.SecurityException => "security",
        System.Net.Http.HttpRequestException => "http",
        System.Net.WebException => "web",
        System.Net.Sockets.SocketException => "socket",
        IOException => "io",
        NullReferenceException => "null-reference",
        InvalidOperationException => "invalid-operation",
        ArgumentException => "argument",
        System.Reflection.TargetInvocationException => "invocation",
        AggregateException => "aggregate",
        _ => "native-other"
    };
    private static void Receipt(string phase, string? error = null, Exception? exception = null, bool terminal = false, bool backgroundWorkMayContinue = false)
    {
        try
        {
            var value = new { schema = "ssam-odc-native-session-hook-receipt/2", phase, error, pid = Environment.ProcessId,
                stage, exceptionKind = ExceptionKind(exception), innerExceptionKind = ExceptionKind(exception?.InnerException),
                exceptionTypeSha256 = exception == null ? null : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(exception.GetType().FullName ?? exception.GetType().Name))).ToLowerInvariant(),
                tokenDeliveryAttempted, terminal, backgroundWorkMayContinue, observedAtUtc = DateTimeOffset.UtcNow.ToString("O") };
            File.WriteAllText(ReceiptPath + ".tmp", JsonSerializer.Serialize(value), new UTF8Encoding(false));
            File.Move(ReceiptPath + ".tmp", ReceiptPath, true);
        }
        catch { }
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);
    public static void Initialize()
    {
        if (Interlocked.Exchange(ref initialized, 1) != 0) return;
        try { _ = Task.Run(Run); } catch (Exception error) { Receipt("failed", "debug_odc_session_unavailable", error, terminal: true); }
    }
    private static void Validate(JsonObject config, JsonObject binding)
    {
        using var process = Process.GetCurrentProcess();
        Require(process.ProcessName == "ODCStudio" && Number(binding, "pid") == Environment.ProcessId &&
            Text(binding, "startedUtc") == process.StartTime.ToUniversalTime().ToString("O"), "debug_odc_session_process_changed");
        Require(Regex.IsMatch(Text(config, "operationId"), "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$") &&
            Text(config, "pipeName") == "ssam-odc-session-" + Text(config, "operationId"), "debug_odc_session_contract_invalid");
        var host = Text(binding, "host");
        Require(Uri.TryCreate("https://" + host + "/", UriKind.Absolute, out var uri) && uri.Host == host && uri.Authority == host &&
            uri.AbsolutePath == "/" && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0,
            "debug_odc_session_contract_invalid");
        Require(binding["moduleKey"] == null || Regex.IsMatch(Text(binding, "moduleKey"), "^[A-Za-z0-9_+]{22}$"), "debug_odc_session_contract_invalid");
        Require(binding["includeToken"]?.GetValue<bool>() is true or false, "debug_odc_session_contract_invalid");
        Require(DateTimeOffset.TryParse(Text(config, "expiresAt"), out var expiry) && expiry > DateTimeOffset.UtcNow && expiry < DateTimeOffset.UtcNow.AddMinutes(2), "debug_odc_session_expired");
    }
    private static ITopLevelPresenter Select(JsonObject binding)
    {
        var tops = RuntimeImplementation.Instance.GetAllTopLevelPresenters()
            .Where(p => p.ServerCommunicationsProvider?.IsLoggedIn == true && p.ServerCommunicationsProvider.LoginInfo.HostInfo.Hostname == Text(binding, "host")).ToArray();
        Require(tops.Length > 0, "debug_odc_session_environment_not_connected");
        var accounts = tops.Select(p => (p.ServerCommunicationsProvider.LoginInfo.UserId, p.ServerCommunicationsProvider.LoginInfo.Username)).Distinct().ToArray();
        Require(accounts.Length == 1 && accounts[0].UserId != Guid.Empty && !string.IsNullOrWhiteSpace(accounts[0].Username), "debug_odc_session_account_ambiguous");
        return tops[0];
    }
    private static async Task Run()
    {
        var tokenRequested = false; var consumed = false; Task? nativeWork = null;
        try
        {
            var config = JsonNode.Parse(File.ReadAllBytes(ConfigPath))!.AsObject();
            var binding = config["binding"]!.AsObject(); Validate(config, binding);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(85));
            await using var pipe = new NamedPipeServerStream(Text(config, "pipeName"), PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            stage = "waiting-private-client"; Receipt("ready");
            await pipe.WaitForConnectionAsync(deadline.Token).WaitAsync(TimeSpan.FromSeconds(25));
            Require(GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var peerPid) && peerPid == Number(config, "clientPid"), "debug_odc_session_private_client_mismatch");
            using (var peer = Process.GetProcessById((int)peerPid)) Require(peer.StartTime.ToUniversalTime().ToString("O") == Text(config, "clientStartedUtc"), "debug_odc_session_private_client_mismatch");
            using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true, NewLine = "\n" };
            var line = await reader.ReadLineAsync(deadline.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            Require(line != null && line.Length < 16384, "debug_odc_session_contract_invalid");
            var request = JsonNode.Parse(line!)!.AsObject();
            Require(Text(request, "operationId") == Text(config, "operationId") && JsonNode.DeepEquals(binding, request["binding"]), "debug_odc_session_binding_mismatch");
            Validate(config, binding);
            stage = "selecting-studio-session";
            var top = await Dispatcher.UIThread.InvokeAsync(() => Select(binding));
            var provider = top.ServerCommunicationsProvider;
            var login = provider.LoginInfo;
            var username = login.Username;
            var developerKey = login.UserId;
            void Check()
            {
                Require(ReferenceEquals(Select(binding), top) && ReferenceEquals(top.ServerCommunicationsProvider, provider) &&
                    ReferenceEquals(provider.LoginInfo, login) && login.Username == username && login.UserId == developerKey && login.HostInfo.Hostname == Text(binding, "host"), "debug_odc_session_login_changed");
            }
            var metadata = new JsonObject { ["host"] = Text(binding, "host"), ["developerKey"] = login.UserId.ToString(), ["developerAuthor"] = login.Username };
            if (binding["moduleKey"] != null)
            {
                var key = ObjectKey.Parse(Text(binding, "moduleKey"));
                var native = ((IServerCommunicationsServicesProvider)provider).AssetManagementService;
                stage = "reading-asset"; Receipt("reading");
                var assetWork = Task.Run(() => native.GetAssetInfo(new RevisionRequest(RevisionRequestType.Latest, key))); nativeWork = assetWork;
                var asset = await assetWork.WaitAsync(TimeSpan.FromSeconds(25), deadline.Token);
                Require(asset != null && ObjectKey.NewKey(asset.AssetKey).ToString() == key.ToString(), "debug_odc_session_module_mismatch");
                stage = "reading-application-url";
                var urlWork = Task.Run(() => native.GetApplicationUrl(key, deadline.Token)); nativeWork = urlWork;
                var url = await urlWork.WaitAsync(TimeSpan.FromSeconds(25), deadline.Token);
                Require(Uri.TryCreate(url, UriKind.Absolute, out var runtime) && runtime.Scheme == "https" && runtime.Port == 443 &&
                    runtime.UserInfo.Length == 0 && runtime.Query.Length == 0 && runtime.Fragment.Length == 0, "debug_odc_session_runtime_invalid");
                metadata["moduleKey"] = key.ToString(); metadata["moduleName"] = asset!.Name;
                metadata["revision"] = asset.Revision; metadata["runtimeUrl"] = url;
            }
            stage = "checking-studio-session";
            await Dispatcher.UIThread.InvokeAsync(Check); Validate(config, binding);
            var reply = new JsonObject { ["ok"] = true, ["operationId"] = Text(config, "operationId"), ["binding"] = binding.DeepClone(), ["metadata"] = metadata };
            if (binding["includeToken"]!.GetValue<bool>())
            {
                stage = "getting-access-token"; Receipt("authenticating"); tokenRequested = true;
                // Exact native PhoenixDebuggerAdapter.GetAccessToken implementation.
                var tokenWork = Task.Run(() => login.GetAccessToken(false)); nativeWork = tokenWork;
                var token = await tokenWork.WaitAsync(TimeSpan.FromSeconds(25), deadline.Token);
                Require(!string.IsNullOrWhiteSpace(token) && token.Length <= 65536 && !token.Any(char.IsControl), "debug_odc_session_token_unavailable");
                reply["token"] = token;
            }
            stage = "checking-before-delivery";
            await Dispatcher.UIThread.InvokeAsync(Check); Validate(config, binding);
            stage = "delivering-private-reply"; tokenDeliveryAttempted = tokenRequested;
            await writer.WriteLineAsync(reply.ToJsonString().AsMemory(), deadline.Token); reply.Clear();
            stage = "waiting-consumed-ack";
            Receipt("delivered-unconfirmed");
            var ack = await reader.ReadLineAsync(deadline.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(3));
            Require(ack != null && ack.Length < 1024 && JsonNode.Parse(ack)?["operationId"]?.GetValue<string>() == Text(config, "operationId"), "debug_odc_session_delivery_uncertain");
            consumed = true; stage = "confirming-consumed"; Receipt("consumed", terminal: true);
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, operationId = Text(config, "operationId"), phase = "consumed" }).AsMemory(), deadline.Token);
        }
        catch (Exception error)
        {
            Receipt(consumed ? "consumed" : tokenRequested ? "uncertain" : "failed", error is Refusal r ? r.Code : "debug_odc_session_unavailable", error,
                terminal: true, backgroundWorkMayContinue: nativeWork is { IsCompleted: false });
        }
    }
}
