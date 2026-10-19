using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Politica pura das fontes declaradas no JSON. Snapshots so entram por bindings explicitos.</summary>
public static class JobSources
{
    public sealed record Source(string Path, bool IsJob);
    /// <summary>The hash-bound, disclosed origin of a corrected job preserves relative source semantics when it moves.</summary>
    internal static string DirectoryOf(string jobPath)
    {
        var originPath = Path.GetFullPath(jobPath) + ".source.json";
        if (!File.Exists(originPath)) return Path.GetDirectoryName(Path.GetFullPath(jobPath))!;
        try
        {
            var origin = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(originPath))!;
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(jobPath))).ToLowerInvariant();
            var dir = origin["sourceDirectory"]!.GetValue<string>();
            if (origin["jobSha256"]?.ToString() != hash || !Path.IsPathFullyQualified(dir) || !Directory.Exists(dir))
                throw new InvalidOperationException("the corrected job's source provenance does not match its bytes or directory");
            return dir;
        }
        catch (Exception error) { throw new KernelRefusalException("SOURCE_PROVENANCE_INVALID", $"{originPath}: {Errors.Text(error)}. If you intentionally edited this job, delete its stale sidecar '{originPath}' and resolve the job's relative sources from its current directory."); }
    }
    public static bool IsBindingName(string spec) => Regex.IsMatch(spec, @"^[A-Za-z_][A-Za-z0-9_]*$");

    // fix/system-reference: the Studio lists the system producer as "(System)" (ODC Manage Dependencies and
    // ReferencesService.ListReferenceable, the O11 referenceable catalog), and a job may name it that way. Its binding is the
    // bare name inside the parentheses: "(System)" and "System" are one producer, bound as System. Any other producer the
    // Studio lists in the same "(Name)" form follows the same rule.
    // Round 2 (H1): a producer value is a PATH only when it ends in .oml or .avsig (any case) or starts with job:; anything
    // else is a NAME and never touches the disk. A name is read without its outer spaces and one pair of parentheses; its
    // binding key is the name itself when it is an identifier, else its letters and digits ("OutSystems UI" -> OutSystemsUI,
    // "Flood-Utils" -> FloodUtils: the rule of the facade's producer-names.mjs and studio-module.mjs compactName). A name
    // with / or \ has no binding key (it is never bound: its capture file would be named after it).
    private static readonly char[] Separators = ['/', '\\'];

    /// <summary>True for a capture or job source: a value ending in .oml or .avsig (any case), or job:&lt;name&gt;.</summary>
    public static bool IsPathSpec(string? spec)
        => spec != null && (spec.EndsWith(".oml", StringComparison.OrdinalIgnoreCase) || spec.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)
            || spec.StartsWith("job:", StringComparison.Ordinal));

    /// <summary>A producer name without its outer spaces and one pair of parentheses ("(System) " -> "System"); null for a path
    /// or nothing.</summary>
    public static string? NormalizedName(string? spec)
    {
        if (string.IsNullOrEmpty(spec) || IsPathSpec(spec)) return null;
        var text = spec.Trim();
        if (text.Length >= 2 && text[0] == '(' && text[^1] == ')') text = text[1..^1].Trim();
        return text.Length == 0 ? null : text;
    }

    /// <summary>The letters and digits of a name, accents dropped, case kept ("OutSystems UI" -> "OutSystemsUI").</summary>
    public static string CompactName(string? name)
        => new((name ?? "").Normalize(System.Text.NormalizationForm.FormD).Where(c => c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9').ToArray());

    /// <summary>The binding key of a producer name: the name itself ("Users"), the bare name of the "(Name)" form the Studio
    /// lists a system producer under ("(System)" -> "System"), else its letters and digits ("OutSystems UI" ->
    /// "OutSystemsUI"); null for a path, job:&lt;name&gt;, a name with / or \, or a name with no letter or digit.</summary>
    public static string? BindingKey(string? spec)
    {
        var name = NormalizedName(spec);
        if (name == null || name.IndexOfAny(Separators) >= 0) return null;
        if (IsBindingName(name)) return name;
        var compact = CompactName(name);
        return compact.Length == 0 ? null : compact;
    }

    /// <summary>Round 2 (H1, M4): the name a Studio listing (the O11 referenceable catalog, the ODC consumer session) has for
    /// the producer a job writes, the first step with exactly one listed name winning: the same text (any case), the same
    /// name without outer spaces and one pair of parentheses ("Tools" and "(Tools)"), then the same letters and digits
    /// ("OutSystems UI" and "OutSystemsUI"); a name with / or \ only by the first two. Two listed names at the step that
    /// matches are never guessed: null, with both in <paramref name="ambiguous"/>. The rule of producer-names.mjs
    /// resolveListedName.</summary>
    public static string? ResolveListedName(string? name, IReadOnlyList<string> listed, out string[] ambiguous)
    {
        ambiguous = [];
        var normalized = NormalizedName(name);
        if (normalized == null) return null;
        var text = name!.Trim();
        var compact = normalized.IndexOfAny(Separators) >= 0 ? "" : CompactName(normalized);
        var steps = new Func<string, bool>[] {
            n => string.Equals(n.Trim(), text, StringComparison.OrdinalIgnoreCase),
            n => string.Equals(NormalizedName(n), normalized, StringComparison.OrdinalIgnoreCase),
            n => compact.Length > 0 && string.Equals(CompactName(NormalizedName(n) ?? n), compact, StringComparison.OrdinalIgnoreCase) };
        foreach (var step in steps)
        {
            var found = listed.Where(n => !string.IsNullOrEmpty(n) && step(n)).Distinct(StringComparer.Ordinal).ToArray();
            if (found.Length == 1) return found[0];
            if (found.Length > 1) { ambiguous = found; return null; }
        }
        return null;
    }

    /// <summary>Round 3 (H1-R): the key of the slot a producer name takes, a name with / or \ included: its binding key, else
    /// the letters and digits of a separated name ("Acme/Core Lib" -> AcmeCoreLib). A separated name is bound through
    /// it only to a capture whose envelope names exactly that producer (<see cref="Resolve"/>): its letters alone never bind
    /// it, so "..\System" never binds the System capture. Null for a path or a name with no letter or digit.</summary>
    public static string? SlotKey(string? spec)
    {
        var name = NormalizedName(spec);
        if (name == null) return null;
        if (name.IndexOfAny(Separators) < 0) return BindingKey(spec);
        var compact = CompactName(name);
        return compact.Length == 0 ? null : compact;
    }

    /// <summary>True when the two names take the same slot (case-insensitive): "(System)", "System" and "system" are one
    /// producer. A name that is not a producer name only equals itself.</summary>
    public static bool SameProducer(string? a, string? b)
        => string.Equals(SlotKey(a) ?? a, SlotKey(b) ?? b, StringComparison.OrdinalIgnoreCase);

    /// <summary>The name the Studio knows a producer by: "(System)" for the system producer when the name IS System without
    /// its outer spaces and parentheses ("System", "system", "(system)"; never "System." or "Sys tem", round 3 M5), "(Name)"
    /// for another wrapped name, else the name without its outer spaces (a name with / or \ as written).</summary>
    public static string StudioName(string spec)
    {
        var name = NormalizedName(spec);
        if (name == null || SlotKey(spec) == null) return spec;
        if (string.Equals(name, "System", StringComparison.OrdinalIgnoreCase)) return "(System)";
        var trimmed = spec.Trim();
        return trimmed.StartsWith('(') && trimmed.EndsWith(')') ? "(" + name + ")" : name;
    }

    public static Dictionary<string, string> ParseBindings(IEnumerable<string> values)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var value in values)
        {
            var pair = value.Split('=', 2);
            var key = pair.Length == 2 ? BindingKey(pair[0]) : null;
            if (key == null || string.IsNullOrWhiteSpace(pair[1]))
                throw new ArgumentException($"invalid --producer '{value}': use --producer Name=<snapshot.oml>");
            if (!result.TryAdd(key, Path.GetFullPath(pair[1])))
                throw new ArgumentException($"duplicate --producer binding '{key}'");
        }
        return result;
    }

    public static Source Resolve(string spec, string jobDir, string role,
        IReadOnlyDictionary<string, string>? bindings = null)
    {
        if (spec.StartsWith("job:", StringComparison.Ordinal))
            return new Source(Path.GetFullPath(JobRunner.ResolveJobFile(spec, jobDir)), true);
        if (IsPathSpec(spec)) return new Source(Existing(FixturePath(spec, jobDir, role), role), false);
        // Round 2 (H1): a name is bound or refused by its name; it never becomes a path.
        if (BindingKey(spec) is not { } key)
        {
            // Round 3 (H1-R): a name with / or \ binds only to a capture (.avsig) bound by its letters and digits whose
            // envelope names exactly that producer (the one the listing has under that text): never by its letters alone.
            var slot = SlotKey(spec) ?? throw new ArgumentException(NotAName(spec, role));
            var bound = bindings?.FirstOrDefault(x => string.Equals(SlotKey(x.Key) ?? x.Key, slot, StringComparison.OrdinalIgnoreCase));
            if (bound?.Value is { } file && file.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)
                && string.Equals(NormalizedName(CapturedName(Existing(Path.GetFullPath(file), role))), NormalizedName(spec), StringComparison.OrdinalIgnoreCase))
                return new Source(Path.GetFullPath(file), false);
            throw new ArgumentException(NotAName(spec, role, slot));
        }
        var binding = bindings?.FirstOrDefault(x => string.Equals(BindingKey(x.Key) ?? x.Key, key, StringComparison.OrdinalIgnoreCase));
        if (binding?.Value == null) throw new ArgumentException(NotBound(spec, key, role));
        return new Source(Existing(Path.GetFullPath(binding.Value.Value), role), false);
    }

    /// <summary>The producer a capture envelope (.avsig) names (its "Name"), or null when it names none.</summary>
    private static string? CapturedName(string file)
    {
        try { return System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(file))?["Name"]?.GetValue<string>(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException) { return null; }
    }

    /// <summary>The refusal of a value that is neither a path (.oml, .avsig, job:) nor a name with a binding key (a name with
    /// / or \, or no letter or digit). Nothing was read by that name.</summary>
    public static string NotAName(string spec, string role, string? slot = null)
        => slot != null
            ? $"{role} '{spec}' is not a producer name the SSAM binds by its letters: a name with / or \\ binds only to a capture (.avsig) of the producer "
                + $"listed with exactly that name, bound by its letters and digits (producers {{\"{spec.Trim()}\": \"<that capture .avsig>\"}}; CLI: --producer {slot}=<that capture .avsig>); "
                + "no such capture is bound. A delivery resolves it by its exact text in the consumer session. Nothing was read by that name."
            : $"{role} '{spec}' is not a producer name the SSAM binds: name the producer as the Studio lists it (letters, digits, spaces; "
                + "a name with / or \\ is never resolved by its letters), or give a capture path ending in .oml or .avsig (or job:<name>). Nothing was read.";

    /// <summary>The refusal of a producer the job names with no binding: the one continuation of each lane (a delivery
    /// captures it by itself) and the binding of an existing capture.</summary>
    public static string NotBound(string spec, string key, string role)
    {
        var studio = StudioName(spec);
        var capture = string.Equals(studio, key, StringComparison.Ordinal) ? key : key + "=" + studio;
        return $"{role} {spec} not bound: a delivery captures a producer by its name, read-only (o11_deliver: captureProducers:[\"{capture}\"]; "
            + $"studio_deliver: by itself from the consumer session, as \"{studio}\"), or bind a capture: producers {{\"{key}\": \"<capture .oml or .avsig>\"}} "
            + $"(CLI: --producer {key}=<snapshot.oml>)";
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
    // fix/system-reference: a producer may also be a captured signature (.avsig) of those folders, the file
    // studio_reference_snapshot or o11_dependencies capture returned (A23); a base is always an OML.
    public static string FixturePath(string spec, string jobDir, string role)
    {
        var root = JobRunner.RepoRoot(Path.GetFullPath(jobDir)) ?? KernelRoot();
        if (root != null && (spec.EndsWith(".oml", StringComparison.OrdinalIgnoreCase)
            || role == "producer" && spec.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)))
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
    /// &lt;workspace&gt;/platforms/odc/snapshots. A captured producer signature (.avsig) of the same folders counts too.
    /// Pure: no file is read.</summary>
    public static bool IsCapturePath(string fullPath, string root)
    {
        var separator = Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(fullPath);
        if (!full.EndsWith(".oml", StringComparison.OrdinalIgnoreCase) && !full.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase)) return false;
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
