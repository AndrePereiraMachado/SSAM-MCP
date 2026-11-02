namespace Anvil.Xif;

/// <summary>
/// The two path families of the XIF lane, apart (F4 review A2, A1):
///   - a path INSIDE an extension ("Source\NET\Helpers.cs", backslashes as Integration Studio writes them) becomes a file of
///     this machine only through Under, one folder per segment, whatever the separator of the system: on Linux (the hosted
///     image) Path.Combine kept the backslashes inside one file name;
///   - a file a spec names is confined to the folders of the account when the caller gives them (hosted: --confine, set by
///     the server for every xif command): anything else is PATH_OUTSIDE_WORKSPACE before the file is opened or even looked
///     for, so the answer says nothing about files of the server or of another account.
/// </summary>
public static class XifPaths
{
    public const string OutsideCode = "PATH_OUTSIDE_WORKSPACE";

    /// <summary>The segments of a path inside the extension (both separators), refused when one leaves it.</summary>
    public static string[] Segments(string xifPath)
    {
        var parts = xifPath.Split('\\', '/');
        if (parts.Length == 0 || parts.Any(p => p is "" or "." or ".." || p.Contains(':')))
            throw XifRefusal.Single(XifCodes.SpecInvalid, $"'{xifPath}' is not a relative path inside the extension.", "Use a relative path such as Source\\NET\\Helpers.cs.");
        return parts;
    }

    /// <summary>The local file of a path inside the extension under root, with the given separator (the system's by default).</summary>
    public static string Under(string root, string xifPath, char separator = '\0')
    {
        var parts = Segments(xifPath);
        if (separator == '\0') return Path.Combine([root, .. parts]);
        return root.TrimEnd('/', '\\') + separator + string.Join(separator, parts);
    }

    /// <summary>The roots of --confine and ANVIL_XIF_CONFINE (system path list), absolute, or null when none is given.</summary>
    public static IReadOnlyList<string>? Roots(IEnumerable<string> given, string? variable)
    {
        var all = given.Concat((variable ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)).ToList();
        if (all.Count == 0) return null;
        if (all.Any(r => !Path.IsPathFullyQualified(r)))
            throw XifRefusal.Single(XifCodes.SpecInvalid, "A confine root is not an absolute folder.", "Pass --confine with absolute folders.");
        return all.Select(r => Path.GetFullPath(r)).ToList();
    }

    private static StringComparison Comparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static bool Within(string path, string root)
    {
        var r = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return path.Equals(r, Comparison) || path.StartsWith(r + Path.DirectorySeparatorChar, Comparison);
    }

    /// <summary>Whether file is inside one of the roots, lexically and with no link on its way from the root (a link that
    /// leads out is refused as outside). Only the folders from the root down are looked at, never the file's content.</summary>
    public static bool Confined(string file, IReadOnlyList<string> roots)
    {
        if (!Path.IsPathFullyQualified(file)) return false;
        var full = Path.GetFullPath(file);
        var root = roots.FirstOrDefault(r => Within(full, r));
        if (root == null) return false;
        var probe = full;
        while (probe.Length > root.TrimEnd(Path.DirectorySeparatorChar).Length)
        {
            try
            {
                FileSystemInfo info = Directory.Exists(probe) ? new DirectoryInfo(probe) : new FileInfo(probe);
                if (info.Exists && info.LinkTarget != null) return false;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return false; }
            var up = Path.GetDirectoryName(probe);
            if (up == null || up == probe) break;
            probe = up;
        }
        return true;
    }
}
