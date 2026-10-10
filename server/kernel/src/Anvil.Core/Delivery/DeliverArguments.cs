using System.Text.RegularExpressions;

namespace Anvil.Core.Delivery;

/// <summary>
/// The arguments of `anvil deliver --job` that fix what one delivery may touch, shared by the CLI and by the prepared
/// commands of `access apply`, so a printed command means exactly the request the CLI builds from it. --expected-environment
/// is the environment attestation: the delivery stops before any snapshot or merge when the selected Studio is connected to
/// another environment (Delivery.Run, stage active-module).
/// </summary>
public static class DeliverArguments
{
    private static readonly Regex Host = new(@"^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$", RegexOptions.Compiled);

    public static string? Option(IReadOnlyList<string> args, string name)
    {
        for (var i = 0; i < args.Count; i++)
            if (args[i] == name) return i + 1 < args.Count ? args[i + 1] : null;
        return null;
    }

    /// <summary>The bare host name of an environment, lower case; anything else (scheme, path, port) is refused.</summary>
    public static string NormalizeEnvironment(string value)
    {
        var host = value.Trim().ToLowerInvariant();
        return Host.IsMatch(host) ? host : throw new ArgumentException($"environment '{value}' must be a bare host name, e.g. personal-x.outsystemscloud.com");
    }

    /// <summary>--expected-environment, normalized; null when the option is absent.</summary>
    public static string? ExpectedEnvironment(IReadOnlyList<string> args)
    {
        if (!args.Contains("--expected-environment")) return null;
        var value = Option(args, "--expected-environment");
        if (value == null || value.StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException("missing --expected-environment value: use --expected-environment <host>");
        return NormalizeEnvironment(value);
    }

    /// <summary>A resumed or closed task keeps the environment it was registered with; naming another one is refused.</summary>
    public static void RequireRecordedEnvironment(IReadOnlyList<string> args, DeliveryRequest recorded)
    {
        if (ExpectedEnvironment(args) is { } expected && !string.Equals(expected, recorded.ExpectedEnvironment, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"this task was registered for environment {recorded.ExpectedEnvironment ?? "(none)"}; resume or close it without another --expected-environment");
    }

    public static Dictionary<string, string> ProducerBindings(IReadOnlyList<string> args)
    {
        var values = new List<string>();
        for (var i = 0; i < args.Count; i++)
            if (args[i] == "--producer")
            {
                if (++i >= args.Count || args[i].StartsWith("--", StringComparison.Ordinal))
                    throw new ArgumentException("missing --producer value: use --producer Name=<snapshot.oml>");
                values.Add(args[i]);
            }
        return JobSources.ParseBindings(values);
    }

    /// <summary>--capture-producer values (Name or Name=Producer): producers read through the lane's Studio before the apply.</summary>
    public static List<string> CaptureBindings(IReadOnlyList<string> args)
    {
        var values = new List<string>();
        for (var i = 0; i < args.Count; i++)
            if (args[i] == "--capture-producer")
            {
                if (++i >= args.Count || args[i].StartsWith("--", StringComparison.Ordinal))
                    throw new ArgumentException("missing --capture-producer value: use --capture-producer <Name> or <Name>=<producer>");
                _ = ProducerSignatures.ParseCapture(args[i]);
                values.Add(args[i]);
            }
        return values;
    }

    /// <summary>The request of `deliver --module M --job J [--checks a,b] [--producer N=oml|avsig]... [--capture-producer N[=P]]...
    /// [--expected-environment host] [--close-opened-tab]`.</summary>
    public static DeliveryRequest ForJob(IReadOnlyList<string> args, string work, int port)
    {
        var module = Option(args, "--module") ?? throw new ArgumentException("missing --module");
        var job = Path.GetFullPath(Option(args, "--job") ?? throw new ArgumentException("missing --job"));
        JobRunner.CheckJobName(job); JobRunner.ValidateJob(job);
        var captures = CaptureBindings(args);
        return new(module, job, work, (Option(args, "--checks") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            ProducerBindings(args), BridgePort: port, ExpectedEnvironment: ExpectedEnvironment(args),
            CaptureProducers: captures.Count > 0 ? captures : null, CloseOpenedTab: CloseOpenedTab(args));
    }

    /// <summary>K1-g: --close-opened-tab, the delivery closes the tab it opened when it ends in a saved state (the facade passes
    /// it when nothing is published in the same call; with a publication it closes the tab after the publish).</summary>
    public static bool CloseOpenedTab(IReadOnlyList<string> args) => args.Contains("--close-opened-tab");
}
