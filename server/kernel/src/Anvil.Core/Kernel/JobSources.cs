using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Politica pura das fontes declaradas no JSON. Snapshots so entram por bindings explicitos.</summary>
public static class JobSources
{
    public sealed record Source(string Path, bool IsJob);
    public static bool IsBindingName(string spec) => Regex.IsMatch(spec, @"^[A-Za-z_][A-Za-z0-9_]*$");

    public static Dictionary<string, string> ParseBindings(IEnumerable<string> values)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var value in values)
        {
            var pair = value.Split('=', 2);
            if (pair.Length != 2 || !IsBindingName(pair[0]) || string.IsNullOrWhiteSpace(pair[1]))
                throw new ArgumentException($"invalid --producer '{value}': use --producer Name=<snapshot.oml>");
            if (!result.TryAdd(pair[0], Path.GetFullPath(pair[1])))
                throw new ArgumentException($"duplicate --producer binding '{pair[0]}'");
        }
        return result;
    }

    public static Source Resolve(string spec, string jobDir, string role,
        IReadOnlyDictionary<string, string>? bindings = null)
    {
        if (IsBindingName(spec))
        {
            var binding = bindings?.FirstOrDefault(x => string.Equals(x.Key, spec, StringComparison.OrdinalIgnoreCase));
            if (binding?.Value == null)
                throw new ArgumentException($"{role} {spec} not bound: o11_deliver binds a producer by its name (captureProducers:[\"{spec}\"] captures it read-only "
                    + $"from the environment), or bind a capture: producers {{\"{spec}\": \"<capture .oml or .avsig>\"}} (CLI: --producer {spec}=<snapshot.oml>)");
            return new Source(Existing(Path.GetFullPath(binding.Value.Value), role), false);
        }
        if (spec.StartsWith("job:", StringComparison.Ordinal))
            return new Source(Path.GetFullPath(JobRunner.ResolveJobFile(spec, jobDir)), true);
        return new Source(Existing(FixturePath(spec, jobDir, role), role), false);
    }

    // Separado de File.Exists para que o guia possa validar a politica sem carregar o runtime ou os fixtures.
    // A raiz vem da pasta do job; um job guardado fora do repositorio (laboratorio, pasta temporaria) usa a raiz do
    // proprio kernel em execucao (a do CLI, senao a do diretorio corrente), de modo que `tests/fixtures/...` continua
    // a apontar para as fixtures deste kernel e nunca para um ficheiro solto.
    // Besides tests/fixtures, the capture folders of the SSAM itself are sources by name (C27): an OML under
    // <kernel>/.local/**/snapshots|downloads|download|download-app|work (o11_studio snapshot; o11_environment download and
    // download-app, which write <lane.local>/environment/<action>/<time>; a delivery's task folder) or under
    // <workspace>/platforms/odc/snapshots. A path the SSAM itself returned is always a valid source (A23). Any other file
    // stays refused.
    public static string FixturePath(string spec, string jobDir, string role)
    {
        var root = JobRunner.RepoRoot(Path.GetFullPath(jobDir)) ?? KernelRoot();
        if (root != null && spec.EndsWith(".oml", StringComparison.OrdinalIgnoreCase))
        {
            var fixtures = Path.Combine(root, "tests", "fixtures") + Path.DirectorySeparatorChar;
            var candidates = Path.IsPathRooted(spec) ? new[] { spec } : new[]
            {
                Path.Combine(jobDir, spec), Path.Combine(root, spec),
                Path.GetFileName(spec) == spec ? Path.Combine(fixtures, spec) : Path.Combine(root, spec)
            };
            foreach (var candidate in candidates)
            {
                var full = Path.GetFullPath(candidate);
                if (full.StartsWith(fixtures, StringComparison.OrdinalIgnoreCase)) return full;
            }
            foreach (var candidate in candidates)
            {
                var full = Path.GetFullPath(candidate);
                if (IsCapturePath(full, root)) return full;
            }
        }
        throw new ArgumentException($"{role} '{spec}' points to an OML outside tests/fixtures and outside the SSAM capture folders "
            + "(<kernel>/.local/**/snapshots|downloads|download|download-app|work, platforms/odc/snapshots): a loose file another run may rewrite. "
            + "Use job:<name>, a fixture, a capture of those folders (o11_studio snapshot, o11_environment download), or bind a snapshot "
            + "on the command: --base <oml> / --producer <Name>=<oml>");
    }

    /// <summary>True for an OML the SSAM itself captured or downloaded: below &lt;root&gt;/.local with a folder named snapshots,
    /// downloads, download, download-app or work on the way (any depth, e.g. .local/lane-ss5/snapshots/M.oml,
    /// .local/environment/download/&lt;time&gt;/Users.oml or .local/work/deliver/&lt;task&gt;/base.oml), or below
    /// &lt;workspace&gt;/platforms/odc/snapshots. Pure: no file is read.</summary>
    public static bool IsCapturePath(string fullPath, string root)
    {
        var separator = Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(fullPath);
        if (!full.EndsWith(".oml", StringComparison.OrdinalIgnoreCase)) return false;
        var kernel = Path.GetFullPath(root).TrimEnd(separator, Path.AltDirectorySeparatorChar);
        var local = kernel + separator + ".local" + separator;
        if (full.StartsWith(local, StringComparison.OrdinalIgnoreCase))
        {
            var folders = full[local.Length..].Split(separator, Path.AltDirectorySeparatorChar)[..^1];
            return folders.Any(f => CaptureFolders.Contains(f, StringComparer.OrdinalIgnoreCase));
        }
        var workspace = Path.GetDirectoryName(kernel);
        if (workspace == null) return false;
        var odc = Path.Combine(workspace, "platforms", "odc", "snapshots") + separator;
        return full.StartsWith(odc, StringComparison.OrdinalIgnoreCase);
    }
    // o11_environment writes <lane.local>/environment/<action>/<time> (o11-environment.mjs): download and download-app (A23).
    private static readonly string[] CaptureFolders = ["snapshots", "downloads", "download", "download-app", "work"];

    /// <summary>The repository root of the kernel that is running (the CLI lives in &lt;root&gt;/.local/&lt;lane&gt;/cli, the
    /// test host in &lt;root&gt;/tests/.../bin), else of the current directory; null when neither is inside a repository. The
    /// Anvil.Core assembly comes before AppContext.BaseDirectory, which on O11 is the Studio's folder after the bind (C01).</summary>
    public static string? KernelRoot()
        => JobRunner.RunningRoots().FirstOrDefault() ?? JobRunner.RepoRoot(Directory.GetCurrentDirectory());

    private static string Existing(string path, string role) => File.Exists(path) ? path
        : throw new FileNotFoundException($"{role} OML not found: {path}", path);
}
