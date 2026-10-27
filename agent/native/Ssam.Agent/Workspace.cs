using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

internal sealed class PathRefusal(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

// Only data paths cross the wire. Runtime installation paths are deliberately absent
// from this API. The grammar matches agent/lib/workspace.mjs on both target systems.
internal sealed class Workspace(string root)
{
    private static readonly string[] Writable = ["odc/snapshots", "odc/journal", "odc/lab", "o11"];
    private static readonly string[] Readable = [.. Writable, "inbox"];
    private static readonly Regex Device = new(@"^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])( *\..*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private readonly string root = Path.GetFullPath(root);
    private static PathRefusal Forbidden(string message) => new("PATH_FORBIDDEN", message);
    private static StringComparison Comparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static string Fold(string value) => OperatingSystem.IsWindows() ? value : value.Normalize();
    private static bool Inside(string value, string parent) => Fold(value).Equals(Fold(parent), Comparison)
        || Fold(value).StartsWith(Fold(parent.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar), Comparison);

    internal static string[] Segments(string value)
    {
        if (value.Length == 0 || value[0] is '/' or '\\' || value.Any(c => c < 32 || "<>\"|?*:".Contains(c)))
            throw Forbidden("Path has a forbidden form or character");
        var parts = value.TrimEnd('/', '\\').Split(['/', '\\']);
        foreach (var part in parts)
            if (part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || Device.IsMatch(part))
                throw Forbidden("Path has a forbidden segment");
        return parts;
    }

    private static string Prefix(string[] parts, bool write)
    {
        foreach (var prefix in write ? Writable : Readable)
        {
            var head = prefix.Split('/');
            if (parts.Length < head.Length || write && parts.Length == head.Length) continue;
            if (head.Where((part, index) => !part.Equals(parts[index], StringComparison.OrdinalIgnoreCase)).Any()) continue;
            return prefix;
        }
        throw Forbidden("Path is outside the permitted data folders");
    }

    // Resolve every existing component, not only the leaf: a parent junction is a
    // boundary too. Missing tails are appended only after their nearest existing parent.
    private static string RealPath(string path, int followedLinks = 0)
    {
        if (followedLinks > 40) throw Forbidden("Too many symbolic links");
        var full = Path.GetFullPath(path);
        var prefix = Path.GetPathRoot(full)!;
        foreach (var part in full[prefix.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            prefix = Path.Combine(prefix, part);
            FileSystemInfo info = Directory.Exists(prefix) ? new DirectoryInfo(prefix) : new FileInfo(prefix);
            try
            {
                if (info.LinkTarget != null)
                {
                    var target = info.ResolveLinkTarget(true);
                    if (target == null || !target.Exists) throw Forbidden("Broken link");
                    // ResolveLinkTarget follows the leaf link chain, but its returned
                    // path can still contain linked ancestors (e.g. /var on macOS).
                    // Canonicalize those too before comparing with the real root.
                    prefix = RealPath(target.FullName, followedLinks + 1);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw Forbidden("Path cannot be checked"); }
        }
        return prefix;
    }

    public string Resolve(string value, bool write = false)
    {
        if (!value.StartsWith("agent:", StringComparison.Ordinal))
            throw new PathRefusal("PATH_NOT_AGENT", "Path must use agent:<relative path>");
        var parts = Segments(value[6..]);
        var prefix = Prefix(parts, write);
        var head = prefix.Split('/');
        if (!OperatingSystem.IsWindows()) head.CopyTo(parts, 0);
        var result = Path.Combine([root, .. parts]);
        var allowed = Path.Combine(RealPath(root), Path.Combine(head));
        if (!Inside(RealPath(result), allowed)) throw Forbidden("Path leaves its permitted prefix through a link");
        return result;
    }

    public string? ToAgent(string value, bool write = false)
    {
        if (!Path.IsPathFullyQualified(value) || value.StartsWith("\\\\") || value.StartsWith("//")
            || value.Split(['/', '\\']).Contains("..")) return null;
        var normalized = Path.GetFullPath(value);
        foreach (var candidateRoot in new[] { root, RealPath(root) })
        {
            if (!Inside(normalized, candidateRoot) || normalized.Equals(candidateRoot, Comparison)) continue;
            try
            {
                var parts = Segments(Path.GetRelativePath(candidateRoot, normalized));
                var prefix = Prefix(parts, write);
                if (!OperatingSystem.IsWindows() && string.Join('/', parts.Take(prefix.Split('/').Length)) != prefix) continue;
                return "agent:" + string.Join('/', parts);
            }
            catch (PathRefusal) { }
        }
        return null;
    }

    public string CheckAbsolute(string value, bool write = false)
    {
        var relative = ToAgent(value, write) ?? throw Forbidden("Absolute path is outside the data folders");
        return Resolve(relative, write);
    }

    public void TransformManifest(JsonNode? node, bool incoming)
    {
        if (node is not JsonObject manifest) return;
        foreach (var key in manifest.Select(pair => pair.Key).ToArray())
        {
            var name = key.ToLowerInvariant();
            if (name is not ("basepath" or "candidatepath" or "producerpath" or "builderreceipt" or "evidencedir")) continue;
            if (manifest[key] == null || manifest[key] is JsonValue val && val.TryGetValue<string>(out var text) && text == "") continue;
            if (manifest[key] is not JsonValue value || !value.TryGetValue<string>(out var path)) throw Forbidden("Manifest path must be a string");
            var write = name == "evidencedir";
            if (incoming) manifest[key] = Resolve(path, write);
            else if (path.StartsWith("agent:")) Resolve(path, write);
            else manifest[key] = ToAgent(path, write) ?? throw Forbidden("Manifest path is outside the data folders");
        }
    }
}
