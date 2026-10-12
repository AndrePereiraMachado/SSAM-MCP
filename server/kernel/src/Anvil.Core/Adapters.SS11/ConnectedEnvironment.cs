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

    /// <summary>The last operation submitted on this lease and when (UTC): a call the Studio's own client cut is named by
    /// them (EnvironmentCut), so the answer says which environment call was cut and after how long.</summary>
    public string? LastOperation { get; private set; }
    public DateTime? LastOperationStartedUtc { get; private set; }

    private readonly List<string> _repeated = [];
    /// <summary>The reads this lease asked a second time after a network failure (EnvironmentNetwork), in order.</summary>
    public IReadOnlyList<string> RepeatedReads => _repeated;

    public T Call<T>(string operation, object? arguments = null)
    {
        if (ReadOnly && WriteOperations.Contains(operation))
            throw new InvalidOperationException($"read-only environment {Host}: '{operation}' refused before reaching the Studio");
        // A fresh request each time: a JSON node sent once already belongs to the envelope of that call. Each attempt names
        // the operation and its start (prazos B: a call the Studio's own client cut is named by them, EnvironmentCut).
        JsonObject Request() { LastOperation = operation; LastOperationStartedUtc = DateTime.UtcNow;
            return new() { ["operation"] = operation, ["lease"] = _lease, ["arguments"] = JsonSerializer.SerializeToNode(arguments, Wire) }; }
        JsonObject response;
        // The ONE retry policy of an environment call (servidor/fase4-24: ENVIRONMENT_CALL_CUT and ENVIRONMENT_UNREACHABLE
        // share it): no replay of a write, since losing the response to a write has an unknown outcome; a read that failed on
        // the network between the Studio and the environment is asked once more (EnvironmentNetwork.MayRepeat; never a
        // timeout of the Studio's own client, which would only wait as long again); one that still fails is
        // ENVIRONMENT_UNREACHABLE, which a delivery's capture names as ENVIRONMENT_CALL_CUT (EnvironmentCut) with repeated.
        try { response = _bridge.Call("environment_session", Request()); }
        catch (BridgeCallException first) when (!WriteOperations.Contains(operation) && EnvironmentNetwork.IsUnreachable(first.Message))
        {
            if (!EnvironmentNetwork.MayRepeat(operation, first.Message)) throw new EnvironmentUnreachableException(operation, Host, first.Message, repeated: false);
            _repeated.Add(operation);
            try { response = _bridge.Call("environment_session", Request()); }
            catch (BridgeCallException second) when (EnvironmentNetwork.IsUnreachable(second.Message))
            { throw new EnvironmentUnreachableException(operation, Host, second.Message, repeated: true); }
        }
        return response["value"].Deserialize<T>(Wire)!;
    }

    public void Dispose()
    {
        // Closing a local lease cannot invalidate a confirmed server result.
        try { _bridge.Call("environment_session", new JsonObject { ["operation"] = "close", ["lease"] = _lease }); }
        catch { }
    }
}
