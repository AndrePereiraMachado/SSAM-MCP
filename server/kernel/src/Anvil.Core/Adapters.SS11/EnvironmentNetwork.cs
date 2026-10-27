using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>A connected-Studio environment call that failed on the network between the Studio's PC and the OutSystems
/// environment (lentidão 2026-10-12: the Studio's HTTP client gave up with "CommunicationException: An error occurred while
/// sending the request" after ~19 s, while new TCP connections of that PC failed about half the time; the next call worked).
/// The bridge answers the failure text (EnvironmentSessionHandler.Describe in the full bridge also names each inner exception
/// with its socket error code and HttpRequestError kind). Rules, deterministic and closed:
/// - only a READ is ever asked again, and only once, on a fresh bridge request (a new SOAP request in the Studio); a write is
///   never repeated: losing its answer leaves an unknown outcome;
/// - the reads in <see cref="RepeatableReads"/> change nothing and answer the same when asked twice;
/// - publish-check is a read that moves the server's message cursor (each answer brings only the messages since the last
///   one, PublicationBatch accumulates them), so it is asked again only when the failure proves the request never left the
///   Studio's PC (<see cref="NeverSent"/>): otherwise a lost answer could hide a compilation error;
/// - a read that still fails is <see cref="EnvironmentUnreachableException"/> (code ENVIRONMENT_UNREACHABLE): the answer says
///   the Studio could not reach the environment, never a generic CLI refusal;
/// - servidor/fase4-24 (with prazos B, EnvironmentCut): a call the Studio's own client gave up on by its deadline (the WCF
///   SendTimeout of 00:01:00, an HttpClient timeout) is never asked again: the second call would wait as long, and the
///   answer is the typed cut (ENVIRONMENT_CALL_CUT in a delivery). This is the ONE retry policy of an environment call:
///   ConnectedEnvironment.Call is the only place that repeats one; the facade and the hosted relay never do;
/// - a proxy or gateway answer (407, 502, 503, 504: <see cref="GatewayStatuses"/>) is the path, not the environment: it is
///   treated as a network failure (asked again under the rules above); a SOAP fault or a refused authentication
///   (UserAuthenticationError) is an answer of the server whatever its status, never asked again.</summary>
public static class EnvironmentNetwork
{
    public const string UnreachableCode = "ENVIRONMENT_UNREACHABLE";
    public const string ServerErrorCode = "ENVIRONMENT_SERVER_ERROR";
    public const string PublishCheck = "publish-check";

    public static readonly IReadOnlySet<string> RepeatableReads = new HashSet<string>(StringComparer.Ordinal)
    {
        "applications", "modules", "application-icon", "catalogs", "referenceable", "extensions", "extension-download",
        "versions", "templates", "template-module", "template-download", "signature", "template-user-provider", "download",
        UserDirectory.Operation, EnvironmentData.ReadOperation,
    };

    private static readonly Regex Network = new(
        @"\b(CommunicationException|HttpRequestException|SocketException|EndpointNotFoundException|WebException)\b|An error occurred while sending the request|No such host is known",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // Only failures that happen before a request can leave: the connection or its TLS handshake never completed, or the
    // host name never resolved. A socket TimedOut alone is not enough (a read timeout after the request was sent says it too).
    private static readonly Regex NotSent = new(
        @"\(http (ConnectionError|NameResolutionError|SecureConnectionError|ProxyTunnelError)\)|\(socket (ConnectionRefused|HostNotFound|HostUnreachable|NetworkUnreachable|NetworkDown|TryAgain|NoData)\)",
        RegexOptions.CultureInvariant);

    /// <summary>The Studio's own client gave up on the call by its deadline (servidor/fase4-24, EnvironmentCut.ClientTimedOut):
    /// never asked again.</summary>
    public static bool ClientTimedOut(string? error) => EnvironmentCut.ClientTimedOut(error);

    // Goal list of 2026-10-20, item 5 (report 81809b7e: an HTTP 500 of the users lookup came back as ENVIRONMENT_UNREACHABLE,
    // because WebException/HttpRequestException name the transport, not the answer). The server answered, however badly:
    // an HTTP status, WCF's "(500) Internal Server Error" / "returned an error" / "unexpected response", a SOAP fault, an
    // HTTP protocol error, the bridge's "Http Error Code: 500 - Internal Server Error" (InternalServerErrorException, the
    // users lookup live on 20/10). That is ENVIRONMENT_SERVER_ERROR (EnvironmentServerErrorException), never asked again and
    // never "the network of the Studio's PC"; but a proxy or gateway status (GatewayStatuses) is the path, not the server.
    private static readonly Regex ServerAnswer = new(
        @"\((?<status>[45]\d{2})\)\s*[A-Z][A-Za-z ]*|\b(?:status code does not indicate success|Response status code)\b[^.\n]*?\b(?<status2>[45]\d{2})\b|\bHTTP(?:/\d(?:\.\d)?)?\s+(?<status3>[45]\d{2})\b|\bHttp Error Code:\s*(?<status4>[45]\d{2})\b|\bInternalServerErrorException\b|\breturned an (?:error|unexpected response)\b|\bFaultException\b|\(http (?:InvalidResponse|HttpProtocolError|UserAuthenticationError)\)",
        RegexOptions.CultureInvariant);

    // Review of 3ab12209, 9b: the statuses a proxy or a gateway between the Studio's PC and the environment answers when it
    // could not take the request to the environment, or the environment's front door while it restarts (407 Proxy
    // Authentication Required, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout). They are the path, not an
    // answer of the environment: a read is asked again as on a network failure (MayRepeat), never ENVIRONMENT_SERVER_ERROR.
    public static readonly IReadOnlySet<int> GatewayStatuses = new HashSet<int> { 407, 502, 503, 504 };

    // The words that make a text an answer whatever its status: a SOAP fault, or the Studio's HTTP client saying the
    // credentials were refused (UserAuthenticationError: asking again with the same credentials is refused again).
    private static readonly Regex OwnAnswer = new(@"\bFaultException\b|\(http UserAuthenticationError\)", RegexOptions.CultureInvariant);

    /// <summary>Every status the text names, then whether the text is a proxy or gateway answer: it names at least one
    /// status, every status it names is one of <see cref="GatewayStatuses"/>, and it has no word of an answer (a SOAP fault,
    /// a refused authentication).</summary>
    public static bool IsGatewayAnswer(string? error)
    {
        if (string.IsNullOrEmpty(error) || OwnAnswer.IsMatch(error)) return false;
        var statuses = HttpStatusesOf(error);
        return statuses.Count > 0 && statuses.All(GatewayStatuses.Contains);
    }

    /// <summary>The environment answered the request (an HTTP status, a SOAP fault, a protocol error): a failure of the
    /// server, never of the network between the Studio and the environment. A proxy or gateway answer
    /// (<see cref="IsGatewayAnswer"/>) is not one.</summary>
    public static bool IsServerAnswer(string? error) => !string.IsNullOrEmpty(error) && ServerAnswer.IsMatch(error) && !IsGatewayAnswer(error);

    /// <summary>The HTTP status the failure text names, when it names one.</summary>
    public static int? HttpStatusOf(string? error) => HttpStatusesOf(error) is { Count: > 0 } statuses ? statuses[0] : null;

    private static List<int> HttpStatusesOf(string? error)
    {
        var found = new List<int>();
        if (string.IsNullOrEmpty(error)) return found;
        for (var m = ServerAnswer.Match(error); m.Success; m = m.NextMatch())
            foreach (var group in new[] { "status", "status2", "status3", "status4" })
                if (m.Groups[group].Success && int.TryParse(m.Groups[group].Value, out var status)) found.Add(status);
        return found;
    }

    /// <summary>The failure is the path between the Studio and the environment (the network, or a proxy or gateway answer),
    /// not an answer of the server.</summary>
    public static bool IsUnreachable(string? error) => !string.IsNullOrEmpty(error)
        && (IsGatewayAnswer(error) || Network.IsMatch(error) && !ServerAnswer.IsMatch(error));

    /// <summary>The failure text proves the request never left the Studio's PC.</summary>
    public static bool NeverSent(string? error) => !string.IsNullOrEmpty(error) && NotSent.IsMatch(error);

    /// <summary>The read may be asked once more after this failure.</summary>
    public static bool MayRepeat(string operation, string? error)
        => IsUnreachable(error) && !ConnectedEnvironment.WriteOperations.Contains(operation) && !ClientTimedOut(error)
           && (RepeatableReads.Contains(operation) || (operation == PublishCheck && NeverSent(error)));
}

/// <summary>A read of the environment the Studio could not reach (EnvironmentNetwork): Operation, Host, whether it was asked
/// twice (Repeated) and the last failure text. Code ENVIRONMENT_UNREACHABLE in the CLI envelope.</summary>
/// <summary>A request the environment answered with a failure (EnvironmentNetwork.IsServerAnswer): Operation, Host, the HTTP
/// status when the text names one, and the failure text. Code ENVIRONMENT_SERVER_ERROR in the CLI envelope. Never asked
/// again; a write's outcome on the server is unknown.</summary>
public sealed class EnvironmentServerErrorException(string operation, string host, string failure, int? httpStatus, bool write)
    : InvalidOperationException($"The OutSystems environment {host} answered '{operation}' with a failure"
        + (httpStatus is { } s ? $" (HTTP {s})" : "") + (write ? "; a write: its outcome on the server is unknown" : "; nothing was changed")
        + ". Server answer: " + failure), ICodedError
{
    public string Code => EnvironmentNetwork.ServerErrorCode;
    public System.Text.Json.Nodes.JsonArray? Problems => null;
    public string Operation { get; } = operation;
    public string Host { get; } = host;
    public int? HttpStatus { get; } = httpStatus;
    public bool Write { get; } = write;
}

public sealed class EnvironmentUnreachableException(string operation, string host, string failure, bool repeated)
    : InvalidOperationException($"The Service Studio could not reach the OutSystems environment {host} for '{operation}' (the network of the Studio's PC"
        + (repeated ? "; asked twice, on two requests" : "") + "); nothing was changed. Last failure: " + failure), ICodedError, IEnvironmentReadFailure
{
    public string Code => EnvironmentNetwork.UnreachableCode;
    public System.Text.Json.Nodes.JsonArray? Problems => null;
    public string Operation { get; } = operation;
    public string Host { get; } = host;
    public bool Repeated { get; } = repeated;
}
