using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// Absolute paths of this machine that the server names (file.upload) or the person approves (roots add). The same
// grammar and messages as agent/lib/local-paths.mjs: Windows drive letter paths compared without case, macOS POSIX
// paths compared in NFC with case; relative, ~, UNC, \\?\, \\.\, ':' streams, control characters, wildcards, empty,
// '.' and '..' segments, segments ending in a dot or a space and device names are refused before any file access.
internal static class LocalPaths
{
    internal static readonly Regex Extension = new(@"^\.[a-z0-9]{1,12}$", RegexOptions.CultureInvariant);
    private static readonly Regex Device = new(@"^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])( *\..*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    internal const int MaxText = 4096;
    internal static bool Mac => OperatingSystem.IsMacOS();
    private static PathRefusal Forbidden(string message) => new("PATH_FORBIDDEN", message);
    private static readonly JsonSerializerOptions Relaxed = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    internal static string Quoted(string text) => JsonValue.Create(text.Length > 300 ? text[..300] + "..." : text).ToJsonString(Relaxed);

    internal sealed record Parsed(string[] Segments, string Normalized);

    internal static Parsed Parse(string text, bool folder = false)
    {
        if (string.IsNullOrEmpty(text)) throw Forbidden("The path is empty");
        if (text.Length > MaxText) throw Forbidden($"The path has more than {MaxText} characters");
        var shown = Quoted(text);
        if (text.StartsWith('~')) throw Forbidden($"{shown} starts with ~; give the full path");
        if (text.Any(c => c < 32 || c == 127)) throw Forbidden($"{shown} has a control character");
        string rest, prefix; char separator;
        if (Mac)
        {
            if (text.StartsWith("//")) throw Forbidden($"{shown} is a network path");
            if (!text.StartsWith('/')) throw Forbidden($"{shown} is not an absolute path");
            if (text.Any(c => "\\:*?<>|\"".Contains(c))) throw Forbidden($"{shown} has a forbidden character (backslash, ':', wildcard or quote)");
            rest = text[1..]; prefix = "/"; separator = '/';
        }
        else
        {
            if (text.Length >= 2 && text[0] is '\\' or '/' && text[1] is '\\' or '/') throw Forbidden($"{shown} is a network (UNC) or device path");
            if (!(text.Length >= 3 && char.IsAsciiLetter(text[0]) && text[1] == ':' && text[2] is '\\' or '/')) throw Forbidden($"{shown} is not an absolute path with a drive letter");
            rest = text[3..];
            if (rest.Contains(':')) throw Forbidden($"{shown} has ':' outside the drive letter (an alternate data stream)");
            if (rest.Any(c => "*?<>|\"".Contains(c))) throw Forbidden($"{shown} has a wildcard or a quote");
            prefix = char.ToUpperInvariant(text[0]) + ":\\"; separator = '\\';
        }
        var body = folder && rest.Length > 0 && rest[^1] is '\\' or '/' ? rest[..^1] : rest;
        var segments = body.Length == 0 ? [] : Mac ? body.Split('/') : body.Split('\\', '/');
        foreach (var segment in segments)
        {
            if (segment.Length == 0) throw Forbidden($"{shown} has an empty segment");
            if (segment is "." or "..") throw Forbidden($"{shown} has a '.' or '..' segment");
            if (segment.EndsWith('.') || segment.EndsWith(' ')) throw Forbidden($"{shown} has a segment ending in a dot or a space");
            if (Device.IsMatch(segment)) throw Forbidden($"{shown} names a device ({segment})");
        }
        if (!folder && segments.Length == 0) throw Forbidden($"{shown} names no file");
        return new(segments, prefix + string.Join(separator, segments));
    }

    // The extension as Node's path.extname gives it: none for a name whose only dot leads it (.env).
    internal static string ExtensionOf(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot <= 0 ? "" : name[dot..];
    }

    internal static bool Inside(string child, string parent)
    {
        if (Mac)
        {
            var c = child.Normalize(); var p = parent.Normalize().TrimEnd('/');
            return p.Length == 0 || c == p || c.StartsWith(p + "/", StringComparison.Ordinal);
        }
        var lc = child.ToLowerInvariant(); var lp = parent.ToLowerInvariant().TrimEnd('\\', '/');
        return lc == lp || lc.StartsWith(lp + "\\", StringComparison.Ordinal);
    }
    internal static bool Same(string a, string b) => Inside(a, b) && Inside(b, a);
    internal static bool Network(string real) => !Mac && real.Length >= 2 && real[0] is '\\' or '/' && real[1] is '\\' or '/';
    internal static string Full(string folder) => Path.GetFullPath(folder);

    // The relative path from base to child with '/' (child under base).
    internal static string Relative(string root, string child) => Path.GetRelativePath(root, child).Replace('\\', '/');
}
