using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Avalonia.Threading;
using OutSystems.ObjectKeys;
using ServiceStudio.Presenter;

// One metadata read through the original authenticated provider. No Core/Bridge,
// secret getter, debugger token, UI mutation, download, publication or scheduler call.
internal static class StartupHook
{
    private static int initialized;
    private const BindingFlags All = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
    private static string Location => typeof(StartupHook).Assembly.Location;
    private sealed class Refusal(string code) : Exception { public string Code { get; } = code; }
    private static void Fail(string code) => throw new Refusal("debug_o11_native_inventory_" + code);
    private static string Text(JsonObject value, string name) => value[name]?.GetValue<string>() ?? throw new Refusal("debug_o11_native_inventory_contract_invalid");
    private static object? Prop(object? value, string name)
    {
        if (value == null) return null;
        var type = value.GetType();
        var property = type.GetProperty(name, All) ?? type.GetInterfaces().Select(t => t.GetProperty(name)).FirstOrDefault(p => p != null);
        return property != null ? property.GetValue(value) : type.GetField(name, All)?.GetValue(value);
    }
    private static string Host(object provider) => Prop(Prop(Prop(provider, "LoginInfo"), "HostInfo"), "HostName")?.ToString()?.ToLowerInvariant() ?? "";
    private sealed record Selected(object Provider, object Login, object Management);
    private static Selected Select(string host)
    {
        var runtime = ServiceStudio.Runtime.Instance as RuntimeImplementation;
        if (runtime == null) Fail("studio_unavailable");
        var providers = runtime!.AggregatorWindows.Select(w => (object?)w.ServerCommunicationsProvider)
            .Concat(runtime.GetAllAggregators().OfType<IAggregatorPresenter>().Select(a => (object?)a.ServerCommunicationsProvider))
            .Where(p => p != null && Host(p) == host && Prop(Prop(p, "LoginInfo"), "UserName") is string u && !string.IsNullOrWhiteSpace(u))
            .Cast<object>().Distinct(ReferenceEqualityComparer.Instance).ToArray();
        if (providers.Length == 0) Fail("environment_not_connected");
        if (providers.Select(p => Prop(p, "LoginInfo")).Distinct(ReferenceEqualityComparer.Instance).Count() != 1) Fail("environment_ambiguous");
        var provider = providers[0]; var login = Prop(provider, "LoginInfo")!;
        var management = Prop(provider, "ApplicationManagementService");
        if (management == null) Fail("native_service_unavailable");
        return new(provider, login, management!);
    }
    private static void Validate(Selected selected, string host)
    {
        var current = Select(host);
        if (!ReferenceEquals(current.Provider, selected.Provider) || !ReferenceEquals(current.Login, selected.Login)
            || !ReferenceEquals(current.Management, selected.Management) || Host(selected.Provider) != host) Fail("login_changed");
    }
    private static void Write(object value)
    {
        var file = Location + ".receipt.json";
        var temporary = file + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value)); File.Move(temporary, file, true);
    }
    public static void Initialize()
    {
        if (Interlocked.Exchange(ref initialized, 1) == 0) _ = Task.Run(Run);
    }
    private static async Task Run()
    {
        string? operationId = null;
        try
        {
            var config = JsonNode.Parse(File.ReadAllText(Location + ".json"))!.AsObject();
            operationId = Text(config, "operationId");
            if (!Guid.TryParseExact(operationId, "D", out _)) Fail("contract_invalid");
            var assemblySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Location))).ToLowerInvariant();
            if (assemblySha256 != Text(config, "assemblySha256")) Fail("assembly_changed");
            var binding = config["binding"]!.AsObject(); var host = Text(binding, "host");
            using var process = Process.GetCurrentProcess();
            if (process.ProcessName != "ServiceStudio" || binding["pid"]?.GetValue<int>() != process.Id || Text(binding, "startedUtc") != process.StartTime.ToUniversalTime().ToString("O")) Fail("process_changed");
            if (!DateTimeOffset.TryParse(Text(config, "expiresAt"), out var expiry) || expiry <= DateTimeOffset.UtcNow || expiry > DateTimeOffset.UtcNow.AddMinutes(2)) Fail("lease_expired");
            if (!Uri.TryCreate("https://" + host + "/", UriKind.Absolute, out var uri) || uri.Host != host || uri.UserInfo.Length != 0 || uri.Port != 443 || uri.AbsolutePath != "/") Fail("contract_invalid");
            if (!Regex.IsMatch(Text(binding, "moduleKey"), "^[A-Za-z0-9_+]{22}$") || !Regex.IsMatch(Text(binding, "applicationKey"), "^[A-Za-z0-9_+]{22}$") ||
                !Regex.IsMatch(Text(binding, "module"), "^[A-Za-z_][A-Za-z0-9_]{0,198}$") || binding["publishedVersionId"]?.GetValue<int>() is not > 0) Fail("contract_invalid");
            var proofFile = Text(config, "proofPath");
            if (!Path.IsPathFullyQualified(proofFile)) Fail("proof_invalid");
            var bytes = File.ReadAllBytes(proofFile);
            if (bytes.Length > 8 * 1024 * 1024 || Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != Text(config, "proofSha256")) Fail("proof_changed");
            var proof = JsonNode.Parse(bytes)!.AsObject();
            if (Text(proof, "host") != host || !DateTimeOffset.TryParse(Text(proof, "capturedAtUtc"), out var captured) || captured > DateTimeOffset.UtcNow.AddSeconds(30) || captured < DateTimeOffset.UtcNow.AddMinutes(-15)) Fail("proof_stale");
            var matching = proof["modules"]!.AsArray().OfType<JsonObject>().Where(r => r["Key"]?.GetValue<string>() == Text(binding, "moduleKey")).ToArray();
            if (matching.Length != 1 || matching[0]["Name"]?.GetValue<string>() != Text(binding, "module") || matching[0]["ApplicationKey"]?.GetValue<string>() != Text(binding, "applicationKey") ||
                matching[0]["VersionId"]?.GetValue<int>() != binding["publishedVersionId"]?.GetValue<int>() || matching[0]["IsActive"]?.GetValue<bool>() != true) Fail("proof_scope_mismatch");
            var selected = await Dispatcher.UIThread.InvokeAsync(() => Select(host));
            await Dispatcher.UIThread.InvokeAsync(() => Validate(selected, host));
            var id = await Task.Run(() => {
                var method = selected.Management.GetType().GetMethod("GetESpaceId", All, new[] { typeof(ObjectKey) })
                    ?? selected.Management.GetType().GetInterfaces().Select(t => t.GetMethod("GetESpaceId", new[] { typeof(ObjectKey) })).FirstOrDefault(m => m != null);
                if (method == null) Fail("native_getter_unavailable");
                return method!.Invoke(selected.Management, new object[] { ObjectKey.Parse(Text(binding, "moduleKey")) });
            }).WaitAsync(TimeSpan.FromSeconds(30));
            await Dispatcher.UIThread.InvokeAsync(() => Validate(selected, host));
            if (id is not int moduleId || moduleId <= 0) Fail("native_id_unavailable");
            var screenRoutes = new Dictionary<string, string>();
            if (config["screenRoutes"] is JsonArray requestedScreens) {
                if (requestedScreens.Count is < 1 or > 4) Fail("route_contract_invalid");
                var service = Prop(selected.Provider, "DebuggerService") as ServiceStudio.ServerCommunications.API.IDebuggerService;
                if (service == null) Fail("route_service_unavailable");
                foreach (var requested in requestedScreens) {
                    var screen = requested?.GetValue<string>() ?? "";
                    if (!Regex.IsMatch(screen, "^[A-Za-z_][A-Za-z0-9_]{0,198}$") || screenRoutes.ContainsKey(screen)) Fail("route_contract_invalid");
                    // Same read-only getter used by OpenInBrowserUtils.GetUri, without opening the URI.
                    var route = await Task.Run(() => service!.GetEntryPointUri(Text(binding, "module"), false, false,
                        screen, true, null, ObjectKey.Parse(Text(binding, "applicationKey")))).WaitAsync(TimeSpan.FromSeconds(30));
                    if (route == null || route.Scheme != "https" || route.Host != host || route.Port != 443 || route.UserInfo.Length != 0 ||
                        route.Fragment.Length != 0 || !route.AbsolutePath.StartsWith("/" + Text(binding, "module") + "/", StringComparison.Ordinal)) Fail("route_scope_mismatch");
                    screenRoutes.Add(screen, route.AbsoluteUri);
                    await Dispatcher.UIThread.InvokeAsync(() => Validate(selected, host));
                }
            }
            var row = matching[0].DeepClone().AsObject(); row["ModuleId"] = (int)id!;
            Write(new { ok = true, phase = "completed", operationId, binding, assemblySha256,
                proof = new { host, capturedAtUtc = DateTimeOffset.UtcNow.ToString("O"), modules = new[] { row } },
                screenRoutes, screenRoutesSource = screenRoutes.Count == 0 ? null : "DebuggerService.GetEntryPointUri",
                source = "ApplicationManagementService.GetESpaceId", hostSource = "LoginInfo.HostInfo.HostName" });
        }
        catch (Exception error)
        {
            try { Write(new { ok = false, phase = "failed", operationId,
                error = error is Refusal refusal ? refusal.Code : "debug_o11_native_inventory_read_failed" }); } catch { }
        }
    }
}
