using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>A call to the OutSystems environment that the Service Studio's own client cut (prazos B, 2026-10-12): the
/// environment_session operations run in the Studio, on its own login and its own Service Center client, from the
/// Studio's PC. Two cuts come from there and never from SSAM: the WCF SendTimeout of that client (00:01:00, "The request
/// channel timed out attempting to send after 00:01:00") and a connection that never answered (CommunicationException,
/// "A connection attempt failed ... (host:443)", or "An error occurred while sending the request"). Classify reads the
/// bridge's error text (the bridge client throws "environment_session: &lt;Type&gt;: &lt;message&gt;"), in any language the
/// Studio speaks; anything else (a refusal, a closed bridge) is not a cut. servidor/fase4-24: an
/// EnvironmentUnreachableException (vel-entrega: a read that failed on the network, already asked again once by
/// ConnectedEnvironment when it may be) is a connection cut too, and the cut carries repeated: one failure, one typed
/// answer, one retry policy (EnvironmentNetwork).</summary>
public static class EnvironmentCut
{
    public const string Code = "ENVIRONMENT_CALL_CUT";

    // The Studio's own client deadline: its WCF channel (TimeoutException, "The request channel timed out ... after 00:01:00",
    // SendTimeout/ReceiveTimeout) or an HttpClient timeout (TaskCanceledException). A socket TimedOut inside a connection that
    // never opened is not one (a fresh request may open).
    private static readonly Regex ClientDeadline = new(
        @"environment_session: (System\.)?TimeoutException|\bTimeoutException: |request channel timed out|\b(SendTimeout|ReceiveTimeout)\b|\bTaskCanceledException\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>servidor/fase4-24: the Studio's own client gave up on the call by its deadline. The kernel never asks such
    /// a call again (EnvironmentNetwork.MayRepeat), and a cut of it is a timeout.</summary>
    public static bool ClientTimedOut(string? error) => !string.IsNullOrEmpty(error) && ClientDeadline.IsMatch(error);

    private static readonly Regex Duration = new(@"\b(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?\b", RegexOptions.CultureInvariant);
    private static readonly string[] TimeoutMarks = ["TimeoutException", "timed out", "tempo limite", "SendTimeout", "ReceiveTimeout",
        "OperationTimeout", "TaskCanceledException", "The operation was canceled", "A operação foi cancelada"];
    private static readonly string[] ConnectionMarks = ["CommunicationException", "EndpointNotFoundException", "HttpRequestException",
        "SocketException", "WebException", "connection attempt failed", "tentativa de conexão falhou", "error occurred while sending the request",
        "erro ao enviar a solicitação", "host conectado não respondeu", "connected host has failed to respond", "No such host is known",
        "Este host não é conhecido", "actively refused", "recusou ativamente", "forcibly closed", "forçado o cancelamento",
        "ENVIRONMENT_NETWORK"];

    /// <summary>(cause "timeout" | "connection", seconds the Studio's client gave the call when its text says so) of an
    /// environment_session failure, or null when the exception is not one.</summary>
    public static (string Cause, int? AfterSeconds)? Classify(Exception? ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is EnvironmentCallCutException cut) return (cut.Cause, cut.AfterSeconds);
            // A read that failed on the network (vel-entrega): a timeout when the Studio's own client deadline ended it.
            if (e is IEnvironmentReadFailure) return ClientTimedOut(e.Message) ? ("timeout", SecondsIn(e.Message)) : ("connection", null);
            var text = e.Message ?? "";
            if (!text.Contains("environment_session", StringComparison.Ordinal)) continue;
            var cause = TimeoutMarks.Any(m => text.Contains(m, StringComparison.OrdinalIgnoreCase)) ? "timeout"
                : ConnectionMarks.Any(m => text.Contains(m, StringComparison.OrdinalIgnoreCase)) ? "connection" : null;
            if (cause == null) return null;
            return (cause, cause == "timeout" ? SecondsIn(text) : null);
        }
        return null;
    }

    // The deadline a timeout text names ("after 00:01:00"), in seconds, or null.
    private static int? SecondsIn(string? text)
        => text != null && Duration.Match(text) is { Success: true } m
            ? int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) * 3600 + int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) * 60
              + int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture)
            : null;

    /// <summary>The first read that failed on the network of the chain (an IEnvironmentReadFailure, also behind a cut, in its
    /// Inner), or null.</summary>
    public static Exception? FindUnreachable(Exception? ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is IEnvironmentReadFailure) return e;
            if (e is EnvironmentCallCutException { Inner: var inner } && FindUnreachable(inner) is { } behind) return behind;
        }
        return null;
    }

    /// <summary>Whether the read that failed on the network in the chain was asked twice, or null without one.</summary>
    public static bool? RepeatedIn(Exception? ex) => (FindUnreachable(ex) as IEnvironmentReadFailure)?.Repeated;

    /// <summary>servidor/fase4-24: a read of a delivery that still failed on the network after the kernel's single retry
    /// (ENVIRONMENT_UNREACHABLE) outside the producer capture, typed as the same cut, so a delivery answers one code.</summary>
    public static EnvironmentCallCutException FromUnreachable(Exception unreachable, string what)
    {
        var failure = unreachable as IEnvironmentReadFailure ?? throw new ArgumentException("not a read that failed on the network", nameof(unreachable));
        var timedOut = ClientTimedOut(unreachable.Message);
        return new(what, null, failure.Host, failure.Operation, timedOut ? "timeout" : "connection", timedOut ? SecondsIn(unreachable.Message) : null, null,
            unreachable, failure.Repeated);
    }

    /// <summary>The first EnvironmentCallCutException of the chain, or null.</summary>
    public static EnvironmentCallCutException? Find(Exception? ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
            if (e is EnvironmentCallCutException cut) return cut;
        return null;
    }
}

/// <summary>A read of the environment that failed on the network between the Studio and the environment after the kernel's
/// single retry (the O11 adapter's EnvironmentUnreachableException, code ENVIRONMENT_UNREACHABLE): seen here by this shape,
/// since this file is also compiled into the ODC kernel.</summary>
public interface IEnvironmentReadFailure
{
    string Operation { get; }
    string Host { get; }
    bool Repeated { get; }
}

/// <summary>ENVIRONMENT_CALL_CUT: a read of the environment the Service Studio's own client cut (EnvironmentCut). Nothing
/// was written: the producer capture, its re-attestation and the inventory reads are read-only. Cut is the machine
/// form {what, producer, host, operation, cause, afterSeconds, elapsedSeconds, cutBy, writeState} the answer carries.</summary>
public sealed class EnvironmentCallCutException : KernelRefusalException
{
    public string What { get; }
    public string? Producer { get; }
    public string? Host { get; }
    public string? Operation { get; }
    public string Cause { get; }
    public int? AfterSeconds { get; }
    public int? ElapsedSeconds { get; }
    /// <summary>Whether the kernel already asked the read a second time (ConnectedEnvironment, EnvironmentNetwork.MayRepeat)
    /// before the cut: true or false for a read that failed on the network, null for any other cut.</summary>
    public bool? Repeated { get; }

    public EnvironmentCallCutException(string what, string? producer, string? host, string? operation, string cause, int? afterSeconds,
        int? elapsedSeconds, Exception inner, bool? repeated = null)
        : base(EnvironmentCut.Code, Describe(what, producer, host, operation, cause, afterSeconds, elapsedSeconds, inner, repeated))
    {
        What = what; Producer = producer; Host = host; Operation = operation; Cause = cause; AfterSeconds = afterSeconds; ElapsedSeconds = elapsedSeconds;
        Inner = inner; Repeated = repeated;
    }

    /// <summary>The bridge failure as it came (kept apart: an InnerException would make the error text the root's).</summary>
    public Exception Inner { get; }

    public JsonObject Cut(string? stage = null)
    {
        var cut = new JsonObject { ["what"] = What };
        if (stage != null) cut["stage"] = stage;
        if (Producer != null) cut["producer"] = Producer;
        if (Host != null) cut["host"] = Host;
        if (Operation != null) cut["operation"] = Operation;
        cut["cause"] = Cause;
        if (AfterSeconds != null) cut["afterSeconds"] = AfterSeconds;
        if (ElapsedSeconds != null) cut["elapsedSeconds"] = ElapsedSeconds;
        if (Repeated != null) cut["repeated"] = Repeated;
        cut["cutBy"] = "service-studio";
        cut["writeState"] = "not-sent";
        return cut;
    }

    private static string Describe(string what, string? producer, string? host, string? operation, string cause, int? afterSeconds,
        int? elapsedSeconds, Exception inner, bool? repeated)
    {
        var target = host ?? "the environment";
        var seconds = afterSeconds ?? elapsedSeconds;
        var how = cause == "timeout" ? "timed out" + (seconds != null ? " after " + seconds + " s" : "")
            : "could not reach " + target + (seconds != null ? " (" + seconds + " s)" : "");
        var detail = Errors.Text(inner);
        if (detail.Length > 240) detail = detail[..239] + "…";
        return $"The Service Studio's own call to {target}{(operation != null ? " (environment operation " + operation + ")" : "")} for {what}"
            + $"{(producer != null ? " of " + producer : "")} {how}{(repeated == true ? " (asked twice, on two requests)" : "")}: {detail}. The call runs on the Studio's PC, from its login to the OutSystems environment, "
            + "outside SSAM; nothing was captured, applied or merged. Repeating the delivery repeats the same environment calls, so first check that "
            + $"the PC reaches {target}{(producer != null ? ", or keep " + producer + " open and unmodified in this Studio, so the delivery binds it from its tab without any environment call" : "")}.";
    }
}
