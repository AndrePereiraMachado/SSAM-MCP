using System.Text.Json.Nodes;

namespace Anvil.Core.Delivery;

/// <summary>A reservation survives process death. Expiry never authorizes a second uncertain write.
/// The payload (contract I8 of the atritos 2 package) is {owner, environment, moduleKey, root, pid, since}: root is the kernel
/// root of the process that reserved (JobSources.KernelRoot), pid its process and since the UTC time of the first reservation
/// by that owner, so the doctor of any SSAM root tells its own reservations from another root's (foreign) and a dead process's
/// (stale). A conflict refuses with a code: MODULE_RESERVED for a task of this root (the text keeps "resume task &lt;id&gt;",
/// which the facade reads), MODULE_RESERVED_FOREIGN for a task of another root (only ssam_doctor release frees it).</summary>
public sealed class ModuleReservation : IDisposable
{
    public const string ReservedCode = "MODULE_RESERVED";
    public const string ForeignCode = "MODULE_RESERVED_FOREIGN";
    private readonly string path;
    private readonly FileStream lease;
    private readonly string owner;
    public ModuleReservation(string directory, string environment, string moduleKey, string taskId)
    {
        path = Path.Combine(directory, DurableJson.Hash(environment.ToLowerInvariant() + "\n" + moduleKey) + ".json");
        lease = DurableJson.Lease(path + ".lock"); owner = taskId;
        try
        {
            var root = JobSources.KernelRoot();
            string? since = null;
            if (File.Exists(path))
            {
                var previous = DurableJson.Read(path);
                if (previous["owner"] is { } previousOwner)
                {
                    if (previousOwner.ToString() != taskId) throw Conflict(previous, previousOwner.ToString(), root);
                    since = previous["since"]?.ToString();
                }
            }
            var payload = new JsonObject { ["owner"] = taskId, ["environment"] = environment, ["moduleKey"] = moduleKey };
            if (root != null) payload["root"] = root;
            payload["pid"] = Environment.ProcessId;
            payload["since"] = since ?? DateTimeOffset.UtcNow.ToString("O");
            DurableJson.Write(path, payload);
        }
        catch { lease.Dispose(); throw; }
    }

    /// <summary>The refusal for a module another task holds. A reservation without root (written before I8) or with this
    /// process's root is this root's: the same text as always, with the code MODULE_RESERVED. The exception stays an
    /// InvalidOperationException whose inner exception carries the code (Errors.FindCoded reads it, as the CLI envelope and
    /// Delivery do), so callers that expect that exact type keep working. Another root's task: MODULE_RESERVED_FOREIGN with
    /// its root, pid and time.</summary>
    internal static Exception Conflict(JsonObject previous, string previousOwner, string? currentRoot)
    {
        var previousRoot = previous["root"]?.ToString();
        if (string.IsNullOrWhiteSpace(previousRoot) || currentRoot == null || SameRoot(previousRoot, currentRoot))
        {
            var message = "Module has an unfinished delivery; resume task " + previousOwner + " before starting another";
            return new InvalidOperationException(message, new KernelRefusalException(ReservedCode, message));
        }
        var pid = previous["pid"]?.ToString() is { Length: > 0 } p ? p : "unknown";
        var since = previous["since"]?.ToString() is { Length: > 0 } s ? s : "unknown";
        return new KernelRefusalException(ForeignCode, "Module is reserved by task " + previousOwner + " of another SSAM root (" + previousRoot
            + ", pid " + pid + ", since " + since + "); release it with ssam_doctor {lane:\"o11\", release}");
    }

    /// <summary>Two kernel roots are the same folder: full paths, without a trailing separator, case-insensitive on Windows.</summary>
    public static bool SameRoot(string a, string b)
    {
        static string Normal(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
        return string.Equals(Normal(a), Normal(b), OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    public void Release()
    {
        var state = DurableJson.Read(path);
        if (state["owner"]?.ToString() != owner) throw new InvalidOperationException("Reservation ownership changed");
        state["owner"] = null; DurableJson.Write(path, state);
    }
    public void Dispose() => lease.Dispose();
}
