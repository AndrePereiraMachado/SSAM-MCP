using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Anvil.Core;
using Avalonia.Threading;
using OutSystems.Communication.ServiceCenter;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>Borrow the selected Studio login for remote engine operations.
/// The credential and SOAP client never leave this process. All requests remain
/// subject to the existing bridge authentication.</summary>
internal static class EnvironmentSessionHandler
{
    private sealed record Session(object Provider, object Login, string Host, string User, bool ReadOnly)
    {
        public DateTime LastUsedUtc = DateTime.UtcNow;
    }
    private static readonly ConcurrentDictionary<string, Session> Sessions = new();
    private static readonly SemaphoreSlim Gate = new(1);

    public static async Task<string> Handle(JsonObject? request)
    {
        try
        {
            if (request == null) throw new ArgumentException("Environment session request is required");
            var operation = request["operation"]?.GetValue<string>() ?? throw new ArgumentException("operation is required");
            if (operation == "connect") return await Connect(request);
            var lease = request["lease"]?.GetValue<string>() ?? throw new ArgumentException("lease is required");
            if (operation == "close")
            {
                Sessions.TryRemove(lease, out _);
                return Server.Ok(new JsonObject { ["closed"] = true });
            }
            if (!EnvironmentOperations.Names.Contains(operation))
                throw new ArgumentException("Unknown environment operation: " + operation);
            if (!Sessions.TryGetValue(lease, out var session) || DateTime.UtcNow - session.LastUsedUtc > TimeSpan.FromHours(1))
                throw new InvalidOperationException("The connected environment lease expired; reconnect before submitting another operation");
            await Gate.WaitAsync();
            try
            {
                await Ui.Run(() => Validate(session), UiGate.Read, "environment_session: validate the login");
                session.LastUsedUtc = DateTime.UtcNow;
                var result = await Task.Run(() =>
                {
                    var secret = session.Login.GetType().GetMethod("GetSecretForWebServiceRequest", Type.EmptyTypes)?.Invoke(session.Login, null) as string
                        ?? throw new InvalidOperationException("Studio authenticated request capability is unavailable");
                    var api = ExportHandler.ServiceCenterApi(session.Provider)
                        ?? throw new InvalidOperationException("Studio Service Center API is unavailable");
                    using var borrowed = HeadlessSession.Borrow(api, session.Login, session.Host, session.User, secret, session.ReadOnly, session.Provider);
                    return EnvironmentOperations.Execute(borrowed, operation, request["arguments"]?.AsObject());
                });
                TrackPublication(operation, session.Host, result);
                return Server.Ok(result);
            }
            finally { Gate.Release(); }
        }
        catch (Exception error) { return Server.Fail(Server.Unwrap(error)); }
    }

    /// <summary>Pattern 2 (2026-10-08, UiGate.cs HeadlessPublications): a publish-start that started and did not end yet
    /// keeps its module key in flight until the publish-check that ends it; the Studio's own open, close and publish of
    /// that module wait for it. Value shape: EnvironmentOperations wraps the PublishOutcome in {value}.</summary>
    private static void TrackPublication(string operation, string host, JsonObject result)
    {
        if (operation is not ("publish-start" or "publish-check")) return;
        try
        {
            var value = result["value"] as JsonObject;
            bool Flag(string name) => value?.FirstOrDefault(kv => string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase)).Value?.GetValue<bool>() == true;
            var key = value?.FirstOrDefault(kv => string.Equals(kv.Key, "Key", StringComparison.OrdinalIgnoreCase)).Value?.ToString();
            var ended = !Flag("Started") || Flag("Completed") || Flag("HasErrors");
            if (operation == "publish-start" && !ended) HeadlessPublications.Started(key, host, DateTime.UtcNow);
            else HeadlessPublications.Checked(key, ended, DateTime.UtcNow);
        }
        catch (Exception ex) { Server.Log("headless publication tracking: " + Server.Unwrap(ex)); }
    }

    private static Task<string> Connect(JsonObject request) => Ui.Run(() =>
    {
        foreach (var expired in Sessions.Where(pair => DateTime.UtcNow - pair.Value.LastUsedUtc > TimeSpan.FromHours(1)).ToArray())
            Sessions.TryRemove(expired.Key, out _);
        if (Sessions.Count >= 128) throw new InvalidOperationException("Too many open environment sessions; close an existing session");
        var requestedHost = request["host"]?.GetValue<string>();
        var requestedModule = request["module"]?.GetValue<string>();
        if (ServiceStudio.Runtime.Instance is not RuntimeImplementation)
            throw new InvalidOperationException("Service Studio runtime is unavailable");
        var providers = Studio.LoggedInProviders();
        string? Host(object p) => Studio.ProviderHost(p);
        object? selected = null;
        if (!string.IsNullOrWhiteSpace(requestedHost))
        {
            var matches = providers.Where(p => string.Equals(Host(p), requestedHost, StringComparison.OrdinalIgnoreCase)).ToArray();
            selected = matches.FirstOrDefault() ?? throw new InvalidOperationException("Requested environment is not connected in Studio");
        }
        else if (!string.IsNullOrWhiteSpace(requestedModule))
        {
            var modules = Studio.Aggregators().Where(a => a.ActiveESpace != null &&
                (a.ActiveESpace.Name.Equals(requestedModule, StringComparison.OrdinalIgnoreCase) || a.ActiveESpace.Key.ToString() == requestedModule)).ToArray();
            var hosts = modules.Select(a => Studio.EnvironmentHost(a)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (hosts.Length > 1) throw new InvalidOperationException("Module is open in multiple environments; specify --host");
            selected = modules.FirstOrDefault()?.ServerCommunicationsProvider;
        }
        var active = Studio.ActiveAggregator()?.ServerCommunicationsProvider;
        if (selected == null && active != null && providers.Contains(active, ReferenceEqualityComparer.Instance)) selected = active;
        if (selected == null && providers.Select(Host).Distinct(StringComparer.OrdinalIgnoreCase).Count() == 1)
            selected = providers.FirstOrDefault();
        if (selected == null || !providers.Contains(selected, ReferenceEqualityComparer.Instance))
            throw new InvalidOperationException("No unambiguous connected Studio environment; specify --host");
        var login = Studio.Prop(selected, "LoginInfo") ?? throw new InvalidOperationException("Studio is not logged in");
        var host = Host(selected) ?? throw new InvalidOperationException("Studio login has no host");
        var user = Studio.Prop(login, "UserName") as string ?? throw new InvalidOperationException("Studio login has no user");
        var id = Guid.NewGuid().ToString("N");
        Sessions[id] = new Session(selected, login, host, user, request["readOnly"]?.GetValue<bool>() ?? false);
        return Server.Ok(new JsonObject { ["lease"] = id, ["host"] = host, ["username"] = user,
            ["ideVersion"] = System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(
                Path.GetDirectoryName(typeof(IServiceCenter).Assembly.Location)!, "ServiceStudio.Framework.dll")).FileVersion,
            ["serverVersion"] = Studio.Prop(Studio.Prop(login, "HostInfo"), "Version")?.ToString(),
            ["operations"] = new JsonArray(EnvironmentOperations.Names.Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()) });
    }, UiGate.Read, "environment_session: connect");

    private static void Validate(Session session)
    {
        var runtime = ServiceStudio.Runtime.Instance as RuntimeImplementation;
        if (runtime == null || !(runtime.AggregatorWindows.Any(w => ReferenceEquals(w.ServerCommunicationsProvider, session.Provider)) ||
                Studio.Aggregators().Any(a => ReferenceEquals(a.ServerCommunicationsProvider, session.Provider))) ||
            !ReferenceEquals(Studio.Prop(session.Provider, "LoginInfo"), session.Login) ||
            !string.Equals(Studio.Prop(Studio.Prop(session.Login, "HostInfo"), "HostName")?.ToString(), session.Host, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Studio.Prop(session.Login, "UserName")?.ToString(), session.User, StringComparison.Ordinal))
            throw new InvalidOperationException("Studio login or environment changed; operation was not submitted");
    }
}
