using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core.Delivery;

namespace Anvil.Core;

/// <summary>Typed transport for the existing environment operations. Login secrets
/// remain in Service Studio; model generation still runs in the CLI.</summary>
public sealed class ConnectedEnvironment : IDisposable
{
    public static readonly JsonSerializerOptions Wire = new() { IncludeFields = true };
    private readonly IBridgeClient _bridge;
    private readonly string _lease;
    public string Host { get; }
    public string Username { get; }
    public string IdeVersion { get; }
    public Version? ServerVersion { get; }
    public bool ReadOnly { get; }
    /// <summary>The operations the Studio's bridge serves on this lease (connect answer); empty for a bridge that predates the list.</summary>
    public IReadOnlyList<string> Operations { get; }

    public ConnectedEnvironment(IBridgeClient bridge, string? host, string? module, bool readOnly)
    {
        _bridge = bridge;
        var response = bridge.Call("environment_session", new JsonObject {
            ["operation"] = "connect", ["host"] = host, ["module"] = module, ["readOnly"] = readOnly });
        _lease = response["lease"]?.GetValue<string>() ?? throw new InvalidOperationException("Studio session lease is absent");
        Host = response["host"]!.GetValue<string>();
        Username = response["username"]!.GetValue<string>();
        IdeVersion = response["ideVersion"]!.GetValue<string>();
        ServerVersion = Version.TryParse(response["serverVersion"]?.ToString(), out var version) ? version : null;
        ReadOnly = readOnly;
        Operations = (response["operations"] as JsonArray)?.Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToArray() ?? [];
    }

    /// <summary>Environment operations that change the server. The Studio-side RequireWrite also refuses them on a
    /// read-only lease; the client refuses first so a read-only caller never submits one at all.</summary>
    public static readonly IReadOnlySet<string> WriteOperations = new HashSet<string>(StringComparer.Ordinal) {
        "application-save", "module-associate", "application-delete", "module-delete", "publish-start", EnvironmentData.WriteOperation };

    public T Call<T>(string operation, object? arguments = null)
    {
        if (ReadOnly && WriteOperations.Contains(operation))
            throw new InvalidOperationException($"read-only environment {Host}: '{operation}' refused before reaching the Studio");
        var request = new JsonObject { ["operation"] = operation, ["lease"] = _lease,
            ["arguments"] = JsonSerializer.SerializeToNode(arguments, Wire) };
        // No replay: losing the response to a write has an unknown outcome.
        var response = _bridge.Call("environment_session", request);
        return response["value"].Deserialize<T>(Wire)!;
    }

    public void Dispose()
    {
        // Closing a local lease cannot invalidate a confirmed server result.
        try { _bridge.Call("environment_session", new JsonObject { ["operation"] = "close", ["lease"] = _lease }); }
        catch { }
    }
}
