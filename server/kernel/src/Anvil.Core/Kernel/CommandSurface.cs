using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>Read-only projections. Knowledge inputs are explicit; no OML or Studio state is accessed here.</summary>
public static class CommandSurface
{
    // Catalogs are checked out with CRLF on Windows and LF in git. Hash content consistently.
    public static string CatalogHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(System.Text.Encoding.UTF8.GetString(bytes).Replace("\r\n", "\n")))).ToLowerInvariant();

    /// <summary>The ops `api --op` projects: the compact languages plus the raw verb table (VerbSurface).</summary>
    public static readonly IReadOnlyList<string> OperationNames = ["logic", "spec", "screen", "html", "html-visual", "verbs", "rest", "rest-consume", "rest-expose", "soap", "agent", "entity-actions", "css"];

    public static JsonObject Schema(string op) => op switch
    {
        "agent" => AgentExpander.Schema(), "logic" => LogicExpander.Schema(), "spec" => SpecExpander.Schema(), "screen" => ScreenExpander.Schema(), "html" => HtmlExpander.Schema(),
        // The integration ops (docs/integracoes-rest-soap.md): consumed REST, exposed REST, SOAP (O11).
        "rest" => RestExpander.Schema(), "rest-expose" => RestExposeExpander.Schema(), "soap" => SoapPlan.Schema(),
        // The generator of a consumed REST integration from URLs and JSON samples (RestConsume.cs).
        "rest-consume" => RestConsume.Schema(),
        // A forma VISUAL da op html (fragmento dentro de um pai existente, WS4): mesma op, sintaxe propria.
        "html-visual" => HtmlVisual.Schema(),
        // The standard actions of a data model, generated from the module (EntityActionsExpander).
        "entity-actions" => EntityActionsExpander.Schema(),
        // Os verbos crus (create, set, link, ...) e a gramatica de referencias, presos ao dispatcher por VerbSurfaceTests.
        "verbs" => VerbSurface.Schema(),
        // T18: the keyed css edit op (Verbs.Css.cs).
        "css" => CssEdits.Schema(),
        _ => VerbLine(op) ?? throw new ArgumentException(UnknownOp(op))
    };

    /// <summary>
    /// `api --op create` (a job verb, not a grammar): the verb's own line of <see cref="VerbSurface.Schema"/>, as the
    /// table prints it (A18 of the 2026-10-06 package: "unknown op 'reference'" cost a round). Nothing is added to the
    /// shared table; the whole table stays `api --op verbs`.
    /// </summary>
    private static JsonObject? VerbLine(string op)
    {
        var verbs = VerbSurface.Schema()["verbs"]!.AsObject();
        var key = verbs.Select(p => p.Key).FirstOrDefault(k => k.Equals(op?.Trim(), StringComparison.OrdinalIgnoreCase));
        if (key == null) return null;
        var line = verbs[key]!.DeepClone().AsObject();
        line["op"] = "verbs";
        line["verb"] = key;
        return line;
    }

    // An op that is neither a grammar nor a verb: both lists and the closest name.
    private static string UnknownOp(string op)
    {
        var known = OperationNames.Concat(VerbSurface.Names).Distinct(StringComparer.Ordinal).ToArray();
        var closest = known.Select(k => (Name: k, Distance: Distance((op ?? "").ToLowerInvariant(), k)))
            .Where(c => c.Distance <= Math.Max(1, Math.Min(3, (op ?? "").Length / 3))).OrderBy(c => c.Distance).ThenBy(c => c.Name, StringComparer.Ordinal)
            .Select(c => c.Name).FirstOrDefault();
        return $"unknown op '{op}'{(closest != null ? $"; closest: '{closest}'" : "")}; allowed: {string.Join(", ", OperationNames)}; verbs (their line): {string.Join(", ", VerbSurface.Names)}";
    }

    private static int Distance(string a, string b)
    {
        var previous = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var row = new int[b.Length + 1];
            row[0] = i;
            for (var j = 1; j <= b.Length; j++)
                row[j] = Math.Min(Math.Min(previous[j] + 1, row[j - 1] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            previous = row;
        }
        return previous[b.Length];
    }

    public static object VerifyMessages(IEnumerable<VerifyDefinition> definitions, IReadOnlyDictionary<string, VerifyHint> hints, string query, bool exact)
    {
        var hits = definitions.Where(m => exact ? m.Id.Equals(query, StringComparison.OrdinalIgnoreCase)
            : (m.Id + " " + m.Title + " " + m.Detail + " " + hints.GetValueOrDefault(m.Id)?.Hint).Contains(query, StringComparison.OrdinalIgnoreCase));
        return hits.Select(m => new { id = m.Id, severity = m.Severity, title = m.Title, detail = m.Detail,
            hint = hints.GetValueOrDefault(m.Id)?.Hint, hintOrigin = hints.GetValueOrDefault(m.Id)?.Origin }).ToArray();
    }

    /// <summary>`ui-block --catalog &lt;json&gt; --name &lt;Block&gt; | --find &lt;text&gt;`: the block of that name (any case), or
    /// the blocks whose name or description contains the text. A name the catalog does not have is UI_BLOCK_NOT_FOUND (R1
    /// item 3: it came back as CLI_REFUSED, the code of a failure of the CLI), with the closest block names.</summary>
    public static object UiBlock(string catalogPath, string? name, string? find)
    {
        var m = UiCatalog.ReadJson(catalogPath);
        if (name != null)
            return m.Blocks.FirstOrDefault(b => string.Equals(b.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? throw NotFound("UI_BLOCK_NOT_FOUND", $"block '{name}' not in {m.Name} {m.Version}; try --find", name, m.Blocks.Select(b => b.Name));
        var text = find ?? throw new ArgumentException("missing --find");
        return m.Blocks.Where(b => b.Name.Contains(text, StringComparison.OrdinalIgnoreCase) || (b.Description ?? "").Contains(text, StringComparison.OrdinalIgnoreCase))
            .Select(b => new { b.Name, b.Flow, b.Public, b.Description, Inputs = b.Inputs.Select(i => i.Name), Placeholders = b.Placeholders.Select(x => x.Name), Events = b.Events.Select(e => e.Name) }).ToList();
    }

    /// <summary>A name a reference lookup does not have: its own code (never a failure of the CLI), the closest names in the
    /// message and as the envelope's `candidates` (Errors.Envelope copies the fields of Errors.DiagnosisKey).</summary>
    internal static KernelRefusalException NotFound(string code, string message, string asked, IEnumerable<string> known)
    {
        var closest = ClosestNames(asked, known);
        var refusal = new KernelRefusalException(code, message + (closest.Count > 0 ? "; closest: " + string.Join(", ", closest) : ""));
        refusal.Data[Errors.DiagnosisKey] = new JsonObject { ["candidates"] = new JsonArray(closest.Select(c => (JsonNode?)JsonValue.Create(c)).ToArray()) };
        return refusal;
    }

    // Up to five known names nearest to the asked one: by edit distance, then the ones that contain a word of it (3+ letters).
    private static List<string> ClosestNames(string asked, IEnumerable<string> known)
    {
        var folded = (asked ?? "").Trim().ToLowerInvariant();
        var words = Regex.Split(Regex.Replace(asked ?? "", "([a-z0-9])([A-Z])", "$1 $2"), "[^A-Za-z0-9]+").Where(w => w.Length >= 3).Select(w => w.ToLowerInvariant()).Distinct().ToArray();
        return known.Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(k => (Name: k, Distance: Distance(folded, k.ToLowerInvariant()), Words: words.Count(w => k.Contains(w, StringComparison.OrdinalIgnoreCase))))
            .Where(c => c.Distance <= Math.Max(2, folded.Length / 3) || c.Words > 0)
            .OrderBy(c => c.Distance <= Math.Max(2, folded.Length / 3) ? 0 : 1).ThenByDescending(c => c.Words).ThenBy(c => c.Distance).ThenBy(c => c.Name, StringComparer.Ordinal)
            .Take(5).Select(c => c.Name).ToList();
    }

    public static object WhereCan(string root, string catalogPath, string name)
    {
        var bytes = File.ReadAllBytes(catalogPath);
        var hash = CatalogHash(bytes);
        var creatables = JsonNode.Parse(bytes)!["Creatables"]!.AsArray();
        bool Matches(string type) => type.Equals(name, StringComparison.OrdinalIgnoreCase) || type.Split('.').Last().Equals(name, StringComparison.OrdinalIgnoreCase);
        var possibilities = creatables.Where(c => Matches(c!["Type"]!.GetValue<string>())).ToArray();
        if (possibilities.Length == 0) return new { notFound = name, hint = "use api --name with the short or full interface name" };
        var lanes = new[] { ("Service", "blank-service"), ("Reactive", "reactive-ui"), ("Mobile", "mobile-ui"), ("Traditional", "traditional-ui") };
        var results = lanes.Select(lane =>
        {
            var path = Path.Combine(root, "docs", "mapa", "criar-" + lane.Item2 + ".json");
            // R1 item 2: a proof map this installation does not carry leaves that runtime unproved, named, and never brings
            // the whole answer down (the parents the catalog lists still answer).
            if (!File.Exists(path))
                return (object)new { runtime = lane.Item1, fixture = lane.Item2 + ".oml", status = "unproved",
                    skipped = $"the proof map docs/mapa/criar-{lane.Item2}.json is not in this installation: this runtime is not proved here" };
            var map = JsonNode.Parse(File.ReadAllText(path))!;
            var rows = map["rows"]!.AsArray();
            if (map["catalogCreatables"]?.GetValue<int>() != creatables.Count || rows.Count != creatables.Count
                || map["catalogSha256"]?.GetValue<string>() != hash || map["partial"]?.GetValue<bool>() != false)
                throw new InvalidOperationException($"stale map {path}: regenerate with anvil prove --fixture tests/fixtures/{lane.Item2}.oml --catalog {catalogPath} --out {path}");
            var matched = rows.Where(r => Matches((r!["FullType"] ?? r["Type"])!.GetValue<string>())).ToArray();
            return (object)new { runtime = lane.Item1, fixture = lane.Item2 + ".oml", studioVersion = map["studioVersion"]?.GetValue<string>(),
                status = Best(matched.Select(r => r!["Status"]!.GetValue<string>())),
                evidence = matched.Select(r => new { parent = (r!["FullParent"] ?? r["Parent"])!.GetValue<string>(),
                    via = r["Via"]!.GetValue<string>(), status = r["Status"]!.GetValue<string>(), error = r["Error"]?.GetValue<string>() }).ToArray() };
        }).ToArray();
        return new { name, possibleParents = possibilities.Select(c => new { type = c!["Type"]!.GetValue<string>(), parent = c["Parent"]!.GetValue<string>(), via = c["Via"]!.GetValue<string>() }).ToArray(),
            runtimes = results, library = "no fixture, no proof", noParent = "parent not reachable down to depth 4 in this fixture; it does not mean not-allowed" };
    }

    private static string Best(IEnumerable<string> statuses)
    {
        var values = statuses.ToHashSet();
        return new[] { "created", "created-needs-config", "created-with-messages", "needs-args", "not-allowed", "no-parent", "failed", "skipped" }
            .FirstOrDefault(values.Contains) ?? "unproved";
    }

    // Words of a recipe query that carry no meaning on their own (PT/EN).
    private static readonly HashSet<string> RecipeStopWords = new(StringComparer.Ordinal)
    { "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "no", "na", "um", "uma", "com", "para", "por", "the", "of", "an", "and", "in", "on", "with", "to", "for" };

    // Accent- and case-insensitive text, so "tela padrao" finds "padrão" and "default screen" finds "DefaultScreen".
    private static string Fold(string text)
    {
        var decomposed = text.Normalize(System.Text.NormalizationForm.FormD);
        var kept = decomposed.Where(c => System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark);
        return new string(kept.ToArray()).ToLowerInvariant();
    }

    // The folded words of the Portuguese prose each suite job had before 16/10 (tests/jobs-search-aliases.json, written by
    // platforms/odc/scripts/job-search-aliases.mjs): "jobs/<name>" -> words. Search only, never served; none: English only.
    private static Dictionary<string, string> JobSearchAliases(string root)
    {
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        var file = Path.Combine(root, "tests", "jobs-search-aliases.json");
        if (!File.Exists(file)) return aliases;
        try
        {
            if (JsonNode.Parse(File.ReadAllText(file))?["jobs"] is JsonObject jobs)
                foreach (var (key, value) in jobs)
                    if (value?["words"]?.GetValue<string>() is { } words) aliases[key] = words;
        }
        catch (JsonException) { /* unreadable: English only */ }
        return aliases;
    }

    // A job without its prose (the description, every op _why, the why of an expected message or of a lab flag), as text:
    // what a recipe query matches besides the alias words (search-aliases.mjs withoutProse).
    private static string WithoutProse(JsonNode job)
    {
        var copy = job.DeepClone();
        Strip(copy, "");
        return copy.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

        static void Strip(JsonNode? node, string at)
        {
            if (node is JsonObject o)
                foreach (var key in o.Select(p => p.Key).ToList())
                {
                    if ((at.Length == 0 && key == "description") || key == "_why"
                        || (key == "why" && (Regex.IsMatch(at, @"^/expectedMessages/\d+$") || at.EndsWith("/allowSoapWithoutImport", StringComparison.Ordinal)))) o.Remove(key);
                    else Strip(o[key], at + "/" + key);
                }
            else if (node is JsonArray a)
                for (var i = 0; i < a.Count; i++) Strip(a[i], at + "/" + i);
        }
    }

    /// <summary>
    /// Proven job recipes by text. The curated table of AGENTS.md ("| Task |") comes first, as before; a query of
    /// several words also reaches every job of the suite (tests/jobs) whose name, description or ops contain ALL the
    /// words, so "default screen" finds the jobs that set DefaultScreen and "screen roles" the ones that set the Roles of
    /// a screen (2026-10-05: both answered nothing, sessions dd2b79c0 and 62a884e8). An exact job name answers that job.
    /// </summary>
    public static object Recipes(string root, string query, bool includeOps = false, int? max = null,
        Func<JsonNode, string, JsonArray>? expand = null)
    {
        expand ??= (job, directory) => JobRunner.CollectOps(job, directory);
        if (includeOps && (max == null || max <= 0)) throw new ArgumentException("recipe --ops requires --max <positive number>; output is bounded across all matches");
        // R1 item 2 (2026-10-28: one recipe query answered "Could not find file" for the whole search): a file of the recipe
        // surface that this installation does not have or cannot read (the guide, a suite job, a part of a composite job) is
        // skipped and named after the recipes found ({name, path, skipped: why}); the rest is searched as before.
        var skipped = new List<object>();
        string[] guide;
        try { guide = File.ReadAllLines(Path.Combine(root, "AGENTS.md")); }
        catch (Exception ex) when (UnreadableRecipe(ex))
        {
            guide = [];
            skipped.Add(new { name = "AGENTS.md", path = "AGENTS.md", skipped = "the guide " + RecipeTrouble(ex, root) + ": its curated rows are missing, only the suite jobs were searched" });
        }
        // The header is English since 16/10 ("| Task |"); the Portuguese one of the guide before ("| Tarefa |") is read too.
        var table = guide.SkipWhile(l => !l.StartsWith("| Task |", StringComparison.Ordinal) && !l.StartsWith("| Tarefa |", StringComparison.Ordinal)).Skip(2).TakeWhile(l => l.StartsWith('|'));
        var entries = new Dictionary<string, (string Path, List<string> Rows)>(StringComparer.Ordinal);
        foreach (var row in table)
            foreach (Match match in Regex.Matches(row, @"(?<![\w.-])([a-z][a-z0-9-]*)\.json\b"))
            {
                var name = match.Groups[1].Value;
                var path = Path.Combine(root, "tests", "jobs", name + ".json");
                if (!File.Exists(path)) continue; // the recipe surface points only at suite jobs
                if (!entries.ContainsKey(name)) entries[name] = (path, new List<string>());
                if (!entries[name].Rows.Contains(row, StringComparer.Ordinal)) entries[name].Rows.Add(row);
            }
        var curated = entries.Keys.ToHashSet(StringComparer.Ordinal);
        var words = Regex.Split(Fold(query ?? ""), "[^a-z0-9_]+").Where(w => w.Length > 1 && !RecipeStopWords.Contains(w)).Distinct().ToArray();
        var suite = Path.Combine(root, "tests", "jobs");
        if (words.Length > 0 && Directory.Exists(suite))
            foreach (var file in Directory.GetFiles(suite, "*.json").OrderBy(f => f, StringComparer.Ordinal))
            {
                var name = Path.GetFileNameWithoutExtension(file);
                if (!entries.ContainsKey(name)) entries[name] = (file, new List<string>());
            }
        // The words of the Portuguese prose a suite job had before 16/10 (tests/jobs-search-aliases.json, search only, never
        // served): a Portuguese query keeps finding the jobs it found when the prose was Portuguese.
        var aliases = JobSearchAliases(root);
        var result = new List<object>();
        var remaining = max ?? 0;
        foreach (var entry in entries.OrderBy(e => curated.Contains(e.Key) ? 0 : 1).ThenBy(e => e.Key, StringComparer.Ordinal))
        {
            if (entries.ContainsKey(query) && entry.Key != query) continue;
            string text; JsonNode job; string description;
            try
            {
                text = File.ReadAllText(entry.Value.Path);
                job = JsonNode.Parse(text) ?? throw new JsonException("the file is empty");
                if (job is not JsonObject && job is not JsonArray) throw new JobShapeException("job must be an object or an array of ops");
                var descriptionNode = (job as JsonObject)?["description"];
                if (descriptionNode != null && (descriptionNode is not JsonValue value || !value.TryGetValue<string>(out _)))
                    throw new JobShapeException("job description must be text");
                description = descriptionNode?.GetValue<string>() ?? "";
            }
            catch (Exception ex) when (UnreadableRecipe(ex))
            {
                skipped.Add(new { name = entry.Key, path = "tests/jobs/" + entry.Key + ".json", skipped = "the job " + RecipeTrouble(ex, root) });
                continue;
            }
            var head = entry.Key + " " + description + " " + string.Join(" ", entry.Value.Rows);
            // A job with an alias is matched on the text it had before 16/10 (its Portuguese prose and table rows, then the
            // rest of the job without its prose), so the English prose never changes what a query finds.
            var hasAlias = aliases.TryGetValue("jobs/" + entry.Key, out var alias);
            var phrase = hasAlias ? Fold(entry.Key + " " + alias).Contains(Fold(query), StringComparison.Ordinal) : head.Contains(query, StringComparison.OrdinalIgnoreCase);
            if (!curated.Contains(entry.Key) && entry.Key != query && string.IsNullOrWhiteSpace(description)) continue;
            if (!phrase)
            {
                var folded = Fold(hasAlias ? entry.Key + " " + alias + " " + WithoutProse(job) : head + " " + text);
                if (words.Length == 0 || !words.All(w => folded.Contains(w, StringComparison.Ordinal))) continue;
            }
            JsonArray ops;
            try
            {
                var directory = Path.GetDirectoryName(entry.Value.Path)!;
                ValidateRecipeShape(job, directory, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
                ops = expand(job, directory);
            }
            catch (Exception ex) when (UnreadableRecipe(ex))
            {
                skipped.Add(new { name = entry.Key, path = "tests/jobs/" + entry.Key + ".json", description, skipped = "the job matched, but " + RecipeTrouble(ex, root) });
                continue;
            }
            var take = includeOps ? Math.Min(remaining, ops.Count) : 0;
            result.Add(new { name = entry.Key, path = "tests/jobs/" + entry.Key + ".json", description, rows = entry.Value.Rows,
                opCount = ops.Count, ops = includeOps ? ops.Take(take).Select(o => o!.DeepClone()).ToArray() : null,
                truncated = includeOps && take < ops.Count });
            remaining -= take;
        }
        result.AddRange(skipped);
        return result;
    }

    // Shape policy belongs to recipe lookup only. The job runner keeps its established interpretation and errors.
    private static void ValidateRecipeShape(JsonNode job, string directory, HashSet<string> active)
    {
        if (job is JsonArray) return;
        if (job is not JsonObject obj) throw new JobShapeException("job must be an object or an array of ops");
        if (obj["jobs"] == null)
        {
            if (obj["ops"] is not JsonArray) throw new JobShapeException("job without an array of 'ops' or 'jobs'");
            return;
        }
        if (obj["jobs"] is not JsonArray parts) throw new JobShapeException("composite job: 'jobs' must be an array");
        if (obj["ops"] != null && (obj["ops"] is not JsonArray own || own.Count > 0))
            throw new JobShapeException("composite job: use 'jobs' OR 'ops', not both");
        foreach (var part in parts)
        {
            if (part is not JsonValue value || !value.TryGetValue<string>(out var spec) || string.IsNullOrWhiteSpace(spec))
                throw new JobShapeException("composite job: each part must be a nonempty job name or path");
            var path = Path.GetFullPath(JobRunner.ResolveJobFile(spec, directory));
            // A cycle is a runner error, not an unreadable shape; let the runner report it unchanged.
            if (!active.Add(path)) continue;
            try
            {
                var nested = JsonNode.Parse(File.ReadAllText(path)) ?? throw new JsonException("the job part is empty");
                ValidateRecipeShape(nested, JobSources.DirectoryOf(path), active);
            }
            finally { active.Remove(path); }
        }
    }

    // A recipe file that is missing or unreadable (I/O, access, invalid JSON, a composite job whose part is missing or that
    // is no job): skipped with its note. Anything else is a fault of the kernel and still fails the lookup.
    private static bool UnreadableRecipe(Exception ex) => ex is IOException or UnauthorizedAccessException or JsonException or JobShapeException;

    // Why a recipe file was skipped, without the folders of this installation (the answer of a hosted server names none).
    private static string RecipeTrouble(Exception ex, string root)
    {
        var detail = Regex.Replace(ex.Message.Replace(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, ""), @"\s+", " ").Trim();
        // "jobs: part not found: job:x (looked in <folders>)": the part, never the folders it was looked for in.
        if (detail.IndexOf(" (looked in ", StringComparison.Ordinal) is var looked and > 0) detail = detail[..looked];
        if (detail.Length > 200) detail = detail[..200] + "...";
        return ex switch
        {
            FileNotFoundException f => "needs a file this installation does not have" + (f.FileName is { Length: > 0 } name ? " (" + Path.GetFileName(name) + ")" : detail.StartsWith("jobs: part not found", StringComparison.Ordinal) ? " (" + detail + ")" : ""),
            DirectoryNotFoundException => "needs a folder this installation does not have",
            UnauthorizedAccessException => "cannot be read here (access denied)",
            JsonException => "is not valid JSON (" + detail + ")",
            IOException => "cannot be read here (" + ex.GetType().Name + ")",
            _ => "is not a job the suite can read (" + detail + ")",
        };
    }
}
