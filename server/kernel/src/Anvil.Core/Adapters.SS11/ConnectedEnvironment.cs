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
    private string _lease;
    private readonly string? _requestedHost, _requestedModule;
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
        _requestedHost = host; _requestedModule = module;
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
        // The server refused the session's identity (its login token): a read is asked once more on a renewed lease of the
        // Studio's current login; a write never; what is still refused is ENVIRONMENT_SESSION_EXPIRED.
        catch (BridgeCallException expired) when (EnvironmentNetwork.IsSessionExpired(expired.Message))
        { response = Renew(operation, Request, expired.Message); }
        // The server answered with a failure (an HTTP 500, a SOAP fault): its own code, with the status; never asked again. A
        // proxy or gateway answer (407, 502, 503, 504) is the path, not the server: the network rule below (EnvironmentNetwork).
        catch (BridgeCallException answered) when (EnvironmentNetwork.IsServerAnswer(answered.Message))
        { throw new EnvironmentServerErrorException(operation, Host, answered.Message, EnvironmentNetwork.HttpStatusOf(answered.Message), WriteOperations.Contains(operation)); }
        catch (BridgeCallException first) when (!WriteOperations.Contains(operation) && EnvironmentNetwork.IsUnreachable(first.Message))
        {
            if (!EnvironmentNetwork.MayRepeat(operation, first.Message)) throw new EnvironmentUnreachableException(operation, Host, first.Message, repeated: false);
            _repeated.Add(operation);
            try { response = _bridge.Call("environment_session", Request()); }
            catch (BridgeCallException second) when (EnvironmentNetwork.IsUnreachable(second.Message))
            { throw new EnvironmentUnreachableException(operation, Host, second.Message, repeated: true); }
            // The second request reached the environment and it answered with a failure: the server's, as on a first one.
            catch (BridgeCallException second) when (EnvironmentNetwork.IsServerAnswer(second.Message))
            { throw new EnvironmentServerErrorException(operation, Host, second.Message, EnvironmentNetwork.HttpStatusOf(second.Message), write: false); }
        }
        return response["value"].Deserialize<T>(Wire)!;
    }

    private readonly List<string> _renewed = [];
    /// <summary>The reads this lease asked again on a renewed session after the server refused its identity, in order.</summary>
    public IReadOnlyList<string> RenewedReads => _renewed;

    private JsonObject Renew(string operation, Func<JsonObject> request, string failure)
    {
        var write = WriteOperations.Contains(operation);
        if (write || !EnvironmentNetwork.RepeatableReads.Contains(operation))
            throw new EnvironmentSessionExpiredException(operation, Host, failure, renewed: false, write);
        // One renewal per session (review W2-DIAG): a later read the server refuses for its identity on this same session is
        // the session expired again, never a second renewal.
        if (_renewed.Count > 0)
            throw new EnvironmentSessionExpiredException(operation, Host, failure, renewed: true, write: false);
        // A fresh lease takes the Studio's current login (a Studio signed in again answers with a new token), on the same
        // environment, or nothing is asked again.
        JsonObject renewed;
        try
        {
            renewed = _bridge.Call("environment_session", new JsonObject {
                ["operation"] = "connect", ["host"] = _requestedHost ?? Host, ["module"] = _requestedModule, ["readOnly"] = ReadOnly });
        }
        catch (BridgeCallException refused)
        { throw new EnvironmentSessionExpiredException(operation, Host, failure + " <- renewal: " + refused.Message, renewed: false, write: false); }
        var lease = renewed["lease"]?.GetValue<string>();
        if (lease == null || !string.Equals(renewed["host"]?.GetValue<string>(), Host, StringComparison.OrdinalIgnoreCase))
        {
            // The lease the Studio opened on another environment is closed, never kept.
            if (lease != null) { try { _bridge.Call("environment_session", new JsonObject { ["operation"] = "close", ["lease"] = lease }); } catch { } }
            throw new EnvironmentSessionExpiredException(operation, Host, failure + " <- renewal: the Studio answered another environment", renewed: false, write: false);
        }
        try { _bridge.Call("environment_session", new JsonObject { ["operation"] = "close", ["lease"] = _lease }); }
        catch { }
        _lease = lease;
        _renewed.Add(operation);
        try { return _bridge.Call("environment_session", request()); }
        catch (BridgeCallException again) when (EnvironmentNetwork.IsSessionExpired(again.Message))
        { throw new EnvironmentSessionExpiredException(operation, Host, again.Message, renewed: true, write: false); }
        catch (BridgeCallException answered) when (EnvironmentNetwork.IsServerAnswer(answered.Message))
        { throw new EnvironmentServerErrorException(operation, Host, answered.Message, EnvironmentNetwork.HttpStatusOf(answered.Message), false); }
        // The renewed read lost on the network between the Studio and the environment: its code, never a bare bridge error,
        // and never a third request.
        catch (BridgeCallException lost) when (EnvironmentNetwork.IsUnreachable(lost.Message))
        { throw new EnvironmentUnreachableException(operation, Host, lost.Message, repeated: false); }
    }

    public void Dispose()
    {
        // Closing a local lease cannot invalidate a confirmed server result.
        try { _bridge.Call("environment_session", new JsonObject { ["operation"] = "close", ["lease"] = _lease }); }
        catch { }
    }
}
