using System.Text.Json.Nodes;

namespace Ssam.Agent;

// The folders the person approved for file.upload: private/upload-roots.json (ssam-upload-roots/1), written atomically,
// read again at every upload, changed only by `ssam-agent roots add|remove|list` (never by a kind, never by the server).
// The rules, texts and file are those of agent/lib/upload-roots.mjs.
internal static class UploadRoots
{
    internal const string Schema = "ssam-upload-roots/1";
    internal sealed record Root(string Path, string Real, string? AddedAt, string? Id = null);
    private static readonly string[] MacSystem = ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/private", "/var", "/dev", "/cores", "/opt", "/Volumes", "/Network"];
    internal static string File(string dataRoot) => System.IO.Path.Combine(dataRoot, "private", "upload-roots.json");

    internal static List<Root> Read(string dataRoot)
    {
        JsonNode? value;
        try { value = JsonNode.Parse(System.IO.File.ReadAllText(File(dataRoot)).TrimStart('\uFEFF')); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { return []; }
        if (value is not JsonObject document || StudioKinds.Text(document["schema"]) != Schema || document["roots"] is not JsonArray roots) return [];
        var result = new List<Root>();
        foreach (var entry in roots)
            if (entry is JsonObject row && StudioKinds.Text(row["path"]) is string path && StudioKinds.Text(row["real"]) is string real)
                result.Add(new(path, real, StudioKinds.Text(row["addedAt"]), StudioKinds.Text(row["id"])));
        return result;
    }

    private static void Write(string dataRoot, List<Root> roots)
    {
        var file = File(dataRoot);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        var array = new JsonArray(roots.Select(r => (JsonNode?)new JsonObject { ["path"] = r.Path, ["real"] = r.Real, ["id"] = r.Id, ["addedAt"] = r.AddedAt }).ToArray());
        var temporary = file + "." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N") + ".tmp";
        System.IO.File.WriteAllText(temporary, new JsonObject { ["schema"] = Schema, ["roots"] = array }.ToJsonString(new() { WriteIndented = true }) + "\n");
        System.IO.File.Move(temporary, file, true);
    }

    private static string Home() => LocalPaths.Mac
        ? (Environment.GetEnvironmentVariable("HOME") is string home && home.StartsWith('/') ? home : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))
        : (Environment.GetEnvironmentVariable("USERPROFILE") is { Length: > 0 } profile ? profile : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

    private static string? SystemProblem(string folder)
    {
        if (LocalPaths.Mac)
        {
            static string Fold(string text) => text.Normalize().ToLowerInvariant().TrimEnd('/');
            bool InsideFold(string parent) => Fold(folder) == Fold(parent) || Fold(folder).StartsWith(Fold(parent) + "/", StringComparison.Ordinal);
            return MacSystem.Append(System.IO.Path.Combine(Home(), "Library")).Any(InsideFold) ? "is a folder of macOS or of the applications" : null;
        }
        var segments = folder[3..].Split('\\', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Any(s => s.Equals("appdata", StringComparison.OrdinalIgnoreCase))) return "is inside AppData, where Windows and the applications keep their own data";
        if (segments.Length > 0 && segments[0].StartsWith("program files", StringComparison.OrdinalIgnoreCase)) return "is a Program Files folder";
        var system = new[] { Environment.GetEnvironmentVariable("SystemRoot"), Environment.GetEnvironmentVariable("windir"), @"C:\Windows", Environment.GetEnvironmentVariable("ProgramData"),
            @"C:\ProgramData", Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramW6432") }
            .Where(v => v is { Length: >= 3 } && char.IsAsciiLetter(v[0]) && v[1] == ':' && v[2] is '\\' or '/');
        return system.Any(parent => LocalPaths.Inside(folder, System.IO.Path.GetFullPath(parent!))) ? "is a folder of Windows or of the applications" : null;
    }

    private static string? FolderProblem(string folder, string dataRoot, string runtimeRoot)
    {
        if (LocalPaths.Network(folder)) return "is a network folder";
        var segments = LocalPaths.Mac ? folder.Split('/', StringSplitOptions.RemoveEmptyEntries) : folder[3..].Split('\\', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return "is the root of a disk";
        var home = System.IO.Path.GetFullPath(Home());
        if (LocalPaths.Same(folder, home)) return "is your user folder itself; approve a folder inside it";
        if (LocalPaths.Inside(home, folder)) return "holds your user folder";
        if (SystemProblem(folder) is string system) return system;
        foreach (var agent in new[] { dataRoot, runtimeRoot }.Select(System.IO.Path.GetFullPath))
            if (LocalPaths.Inside(folder, agent) || LocalPaths.Inside(agent, folder)) return "holds the SSAM agent folder or is inside it";
        return null;
    }

    // (path, real) of a folder that may be approved, or the problem.
    internal static (string? Path, string? Real, string? Problem) Check(string folder, string dataRoot, string runtimeRoot)
    {
        LocalPaths.Parsed parsed;
        try { parsed = LocalPaths.Parse(folder, true); } catch (PathRefusal e) { return (null, null, e.Message); }
        var shown = LocalPaths.Quoted(parsed.Normalized);
        if (FolderProblem(parsed.Normalized, dataRoot, runtimeRoot) is string lexical) return (null, null, shown + " " + lexical);
        string real;
        try
        {
            if (!Directory.Exists(parsed.Normalized)) return (null, null, shown + " is not an existing folder");
            real = NativeFileIdentity.RealDirectory(parsed.Normalized);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return (null, null, shown + " is not an existing folder"); }
        if (FolderProblem(real, dataRoot, runtimeRoot) is string resolved) return (null, null, shown + " leads to a folder that " + resolved);
        return (parsed.Normalized, real, null);
    }

    // roots add | remove | list: the same lines as the Node CLI. -> exit code.
    internal static int Command(string op, string? folder, string dataRoot, string runtimeRoot, bool json, TextWriter output, TextWriter error)
    {
        int Fail(string text) { error.WriteLine("Error: " + text); return 1; }
        var roots = Read(dataRoot);
        if (op == "list")
        {
            if (json) output.WriteLine(new JsonObject { ["schema"] = Schema, ["roots"] = new JsonArray(roots.Select(r => (JsonNode?)new JsonObject { ["path"] = r.Path, ["real"] = r.Real, ["addedAt"] = r.AddedAt }).ToArray()) }.ToJsonString(new() { WriteIndented = true }));
            else if (roots.Count == 0) output.WriteLine("No folder is approved: SSAM cannot read any file of this computer.");
            else { output.WriteLine($"Folders SSAM may read ({roots.Count}):"); for (var i = 0; i < roots.Count; i++) output.WriteLine($"  {i + 1}. {roots[i].Path}"); }
            return 0;
        }
        if (op is not ("add" or "remove")) return Fail("use roots add --folder <folder> | roots remove --folder <folder> | roots list [--json]");
        if (string.IsNullOrEmpty(folder)) return Fail($"roots {op} needs --folder <folder>");
        if (op == "remove")
        {
            var normalized = folder;
            try { normalized = LocalPaths.Parse(folder, true).Normalized; } catch (PathRefusal) { }
            var kept = roots.Where(r => !LocalPaths.Same(r.Path, normalized) && !LocalPaths.Same(r.Real, normalized)).ToList();
            if (kept.Count == roots.Count) return Fail(LocalPaths.Quoted(folder) + " is not an approved folder");
            Write(dataRoot, kept);
            output.WriteLine($"Removed: SSAM can no longer read files in {normalized}.");
            return 0;
        }
        var (path, real, problem) = Check(folder, dataRoot, runtimeRoot);
        if (problem != null) return Fail(problem + ". Nothing was approved.");
        if (roots.Any(r => LocalPaths.Same(r.Path, path!) || LocalPaths.Same(r.Real, real!))) { output.WriteLine($"Already approved: {path}."); return 0; }
        string id;
        try { id = NativeFileIdentity.IdentityOf(real!); } catch (IOException) { return Fail(LocalPaths.Quoted(path!) + " is not an existing folder. Nothing was approved."); }
        roots.Add(new(path!, real!, DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture), id));
        Write(dataRoot, roots);
        output.WriteLine($"Approved: SSAM may read files in {path} when a request names them (one file at a time, up to 64 MiB).");
        return 0;
    }
}
