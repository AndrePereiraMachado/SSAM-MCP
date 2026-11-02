using System.Security.Cryptography;

namespace Anvil.Core;

/// <summary>
/// B15 (review of W3-CSS, R2-1): which module images a job may fill with new content (SetImageContent instead of the
/// NAME_COLLISION of an existing name). The authorization never comes from the job's text (a field such as _from:"file" could be
/// written by hand or copied from a generated job): the facade passes it to the kernel call as arguments,
/// <c>--image-fill &lt;name&gt;=&lt;sha256 of the bytes&gt;</c>, one per image FILE it read itself (ssam_code files,
/// module-images.mjs; on a hosted server only files of the customer's workspace, confined by the gate). The kernel fills an
/// existing image only when the create's name and the sha256 of its bytes are both among them. Set per call by the CLI's
/// Dispatch (the cold process and the resident worker alike); empty for every other call.
/// </summary>
public static class ImageFills
{
    public const string Argument = "--image-fill";
    private static readonly AsyncLocal<HashSet<string>?> Granted = new();

    /// <summary>The grants of this call, from its arguments (none: an empty set).</summary>
    public static void Use(string[] args)
    {
        HashSet<string>? set = null;
        for (var i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] != Argument) continue;
            var value = args[i + 1];
            var eq = value.LastIndexOf('=');
            if (eq <= 0 || eq == value.Length - 1) continue;
            (set ??= new HashSet<string>(StringComparer.Ordinal)).Add(Key(value[..eq], value[(eq + 1)..]));
        }
        Granted.Value = set;
    }

    /// <summary>For tests: the grants of this flow, as the arguments would set them.</summary>
    public static IDisposable For(params (string Name, string Sha256)[] grants)
    {
        var previous = Granted.Value;
        Granted.Value = grants.Length == 0 ? null : grants.Select(g => Key(g.Name, g.Sha256)).ToHashSet(StringComparer.Ordinal);
        return new Restore(previous);
    }

    /// <summary>Whether this call may fill the existing image <paramref name="name"/> with <paramref name="base64"/>.</summary>
    public static bool Allows(string name, string? base64)
    {
        if (Granted.Value is not { Count: > 0 } set || string.IsNullOrEmpty(base64)) return false;
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); } catch (FormatException) { return false; }
        return set.Contains(Key(name, Convert.ToHexString(SHA256.HashData(bytes))));
    }

    private static string Key(string name, string sha256) => name.Trim().ToLowerInvariant() + "\n" + sha256.Trim().ToLowerInvariant();

    private sealed class Restore(HashSet<string>? previous) : IDisposable { public void Dispose() => Granted.Value = previous; }
}
