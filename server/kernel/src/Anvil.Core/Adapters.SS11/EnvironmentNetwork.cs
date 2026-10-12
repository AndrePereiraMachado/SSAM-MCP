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
///   ConnectedEnvironment.Call is the only place that repeats one; the facade and the hosted relay never do.</summary>
public static class EnvironmentNetwork
{
    public const string UnreachableCode = "ENVIRONMENT_UNREACHABLE";
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

    /// <summary>The failure is the network between the Studio and the environment (not a refusal of the server).</summary>
    public static bool IsUnreachable(string? error) => !string.IsNullOrEmpty(error) && Network.IsMatch(error);

    /// <summary>The failure text proves the request never left the Studio's PC.</summary>
    public static bool NeverSent(string? error) => !string.IsNullOrEmpty(error) && NotSent.IsMatch(error);

    /// <summary>The read may be asked once more after this failure.</summary>
    public static bool MayRepeat(string operation, string? error)
        => IsUnreachable(error) && !ConnectedEnvironment.WriteOperations.Contains(operation) && !ClientTimedOut(error)
           && (RepeatableReads.Contains(operation) || (operation == PublishCheck && NeverSent(error)));
}

/// <summary>A read of the environment the Studio could not reach (EnvironmentNetwork): Operation, Host, whether it was asked
/// twice (Repeated) and the last failure text. Code ENVIRONMENT_UNREACHABLE in the CLI envelope.</summary>
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
