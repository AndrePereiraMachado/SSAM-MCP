using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Anvil.Core;

/// <summary>One declared message. `count` (an integer of at least 1) covers that many messages of the id under the suffix,
/// `all:true` every one of them; without either the entry covers exactly one.</summary>
public sealed record ExpectedMessage(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("element")] string Element,
    [property: JsonPropertyName("why")] string Why)
{
    [JsonPropertyName("count"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Count { get; init; }
    [JsonPropertyName("all"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool All { get; init; }
}
public sealed record AmbiguousExpectation(
    [property: JsonPropertyName("expected")] ExpectedMessage Expected,
    [property: JsonPropertyName("candidates")] IReadOnlyList<MessageInfo> Candidates);

/// <summary>The verdict of one new message (K1, I3 of the atritos 2 package): matched by an expectation, tolerated (the
/// anonymous-access warning outside the job's screens), allowlisted (a mechanical warning: offline font/CDN url, Unused* on an
/// element this job created), nonblocking (any other warning, A03) or unexpected (an error, a security warning, the
/// anonymous-access warning on a job screen). `reason` names the rule: anonymous-outside-footprint, anonymous-in-job-screen,
/// offline-font-url, unused-created-by-job, warning-non-blocking, security:&lt;id&gt; or null.</summary>
public sealed record MessageVerdict(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("key")] string Key,
    [property: JsonPropertyName("ownerKey")] string? OwnerKey,
    [property: JsonPropertyName("detail")] string Detail,
    [property: JsonPropertyName("verdict")] string Verdict,
    [property: JsonPropertyName("expectation")] ExpectedMessage? Expectation,
    [property: JsonPropertyName("reason")] string? Reason);

/// <summary>An expectation that was satisfied (K2): by new messages, or by a message the base already had (preexisting).</summary>
public sealed record MatchedExpectation(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("element")] string Element,
    [property: JsonPropertyName("why")] string Why,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("preexisting")] bool Preexisting,
    [property: JsonPropertyName("count")] int Count);

/// <summary>What the job created and changed (K7), by object key. Screens are those created, or holding an element the job
/// created or changed. The policy reads it; the JobRunner computes it from the model before and after the apply.</summary>
public sealed record JobFootprint(IReadOnlySet<string> Created, IReadOnlySet<string> Changed, IReadOnlySet<string> Screens)
{
    public static JobFootprint Empty { get; } = new(new HashSet<string>(), new HashSet<string>(), new HashSet<string>());
    /// <summary>C08 (atritos 3): the keys of the screens the job declares open to anonymous users (a `set AnonymousAccess
    /// true`, Roles with Anonymous) or that were already anonymous in the base. The anonymous-access family on them is
    /// tolerated (anonymous-declared-by-job), never one expectation per node.</summary>
    public IReadOnlySet<string> AnonymousIntent { get; init; } = new HashSet<string>();
}

/// <summary>One problem of the job's expectation contract (N3 of the atritos 3 package): the preflight collects it with
/// the others (EXPECTED_MESSAGES_INVALID), with its JSON pointer and the exact fix.</summary>
public sealed record ExpectationProblem(string Pointer, string Message, string Fix);

/// <summary>What MessageExpectations.Inspect read: the valid expectations, the problems of the others, the notes
/// (VERIFY_IDS_UNCHECKED when no id list was found) and where the ids came from.</summary>
public sealed record ExpectationReading(IReadOnlyList<ExpectedMessage> Expected, IReadOnlyList<ExpectationProblem> Problems,
    IReadOnlyList<JsonObject> Notes, string? IdSource);

public sealed record ExpectationResult(
    [property: JsonPropertyName("unexpected")] IReadOnlyList<MessageInfo> Unexpected,
    [property: JsonPropertyName("missingExpected")] IReadOnlyList<ExpectedMessage> MissingExpected,
    [property: JsonPropertyName("ambiguous")] IReadOnlyList<AmbiguousExpectation> Ambiguous)
{
    [JsonPropertyName("tolerated")] public IReadOnlyList<MessageInfo> Tolerated { get; init; } = [];
    /// <summary>Mechanical warnings released by the small allowlist (never a general release); listed, never hidden.</summary>
    [JsonPropertyName("allowlisted")] public IReadOnlyList<MessageInfo> Allowlisted { get; init; } = [];
    /// <summary>A03: the new warnings that block nothing (verdict nonblocking); they come back as warnings, never as a refusal.</summary>
    [JsonPropertyName("nonBlocking")] public IReadOnlyList<MessageInfo> NonBlocking { get; init; } = [];
    /// <summary>Expectations no message used: informative only (the Studio would not refuse the module).</summary>
    [JsonPropertyName("unusedExpectations")] public IReadOnlyList<ExpectedMessage> UnusedExpectations { get; init; } = [];
    [JsonPropertyName("matched")] public IReadOnlyList<MatchedExpectation> Matched { get; init; } = [];
    [JsonPropertyName("verdicts")] public IReadOnlyList<MessageVerdict> Verdicts { get; init; } = [];
    /// <summary>Blocking: a new message nobody declared, or a declaration that cannot pick its message. A stale expectation
    /// does not block (unusedExpectations).</summary>
    [JsonIgnore] public bool Accepted => Unexpected.Count == 0 && MissingExpected.Count == 0 && Ambiguous.Count == 0;
    public IEnumerable<string> Diagnostics()
    {
        foreach (var m in Unexpected) yield return $"Unexpected {m.Id} @ {m.Path}: corrija ou declare em expectedMessages com why "
            + $"({{\"id\":\"{m.Id}\",\"element\":\"{Suffix(m.Path)}\",\"why\":\"...\"}}; \"count\":n or \"all\":true covers several).";
        foreach (var e in MissingExpected) yield return $"Missing expected message {e.Id} @ {e.Element}: remove the stale expectation or restore the intended scenario ({e.Why}).";
        foreach (var e in Ambiguous) yield return $"Ambiguous expected message {e.Expected.Id} @ {e.Expected.Element}: {e.Candidates.Count} messages match; use a longer unique suffix, "
            + $"or \"count\":{e.Candidates.Count} / \"all\":true to cover them. Candidates: {string.Join(" | ", e.Candidates.Select(m => m.Path))}";
        // unusedExpectations stay in their own field: informative, never a policy message (they block nothing).
    }
    private static string Suffix(string path)
    {
        var levels = path.Split(" / ");
        return string.Join(" / ", levels.Skip(Math.Max(0, levels.Length - 2)));
    }
}

/// <summary>
/// Expectativas explicitas sobre mensagens NOVAS, uma politica para o kernel, o deliver O11 e o builder ODC:
/// <list type="bullet">
/// <item>cada mensagem nova recebe um veredito (matched, tolerated, allowlisted, nonblocking, unexpected); so unexpected e ambiguous bloqueiam;</item>
/// <item>A03 (decisao do dono, 06/10): so ERRORS bloqueiam; um warning novo e nonblocking, salvo os de seguranca (SecurityWarnings);</item>
/// <item>expectedMessages e opcional: o path exato que a mensagem imprime, ou um sufixo de um nivel ou mais, cada nivel pelo
/// texto inteiro ("Calculo (ServerAction)") ou so pelo nome ("Calculo");</item>
/// <item>uma expectativa satisfeita por uma mensagem que a base ja tinha conta como satisfeita (preexisting);</item>
/// <item>uma expectativa sem nenhuma mensagem e informativa (unusedExpectations): o Studio nao recusaria o modulo;</item>
/// <item>a allowlist e pequena e mecanica: InvalidResourceURL_Offline de fonte/CDN e Unused* num elemento criado pelo proprio job;</item>
/// <item>o aviso de acesso anonimo e tolerado fora das telas do job e inesperado nelas, salvo declarado com why.</item>
/// </list>
/// </summary>
public static class MessageExpectations
{
    private const string Shape = "{\"id\":\"<Verify id>\",\"element\":\"<the path the message prints, or its last level(s): Element (Kind) or Element>\",\"why\":\"<reason>\"} with optional \"count\":n (n >= 1) or \"all\":true (with all:true the element may be left out: every message of that id)";

    /// <summary>The expectations of a job; the first malformed entry throws (the callers that read a valid job).</summary>
    public static IReadOnlyList<ExpectedMessage> Parse(JsonNode? node, IReadOnlySet<string> knownIds, string lookup = "verify-message --find <part of id>")
    {
        var problems = new List<ExpectationProblem>();
        var result = ParseAll(node, knownIds, lookup, problems);
        if (problems.Count > 0) throw new ArgumentException(problems[0].Message);
        return result;
    }

    /// <summary>A malformed field of one entry: the pointer suffix of the field and the text the refusal always had.</summary>
    private sealed class EntryProblem(string field, string message, string fix) : ArgumentException(message)
    {
        public string Field { get; } = field;
        public string Fix { get; } = fix;
    }

    /// <summary>Every entry at once (N3): a malformed entry is a problem with its pointer (/expectedMessages/&lt;i&gt;/&lt;field&gt;) and
    /// the next entry is still read. <paramref name="knownIds"/> null: the ids are not checked (no id list was found, C01).</summary>
    internal static List<ExpectedMessage> ParseAll(JsonNode? node, IReadOnlySet<string>? knownIds, string lookup, List<ExpectationProblem> problems)
    {
        var result = new List<ExpectedMessage>();
        if (node == null) return result;
        if (node is not JsonArray entries)
        {
            problems.Add(new("/expectedMessages", "expectedMessages must be an array of " + Shape, "write expectedMessages as an array: [" + Shape + "]"));
            return result;
        }
        for (var i = 0; i < entries.Count; i++)
        {
            try
            {
                if (Entry(entries[i], knownIds, lookup, result) is { } parsed) result.Add(parsed);
            }
            catch (EntryProblem p) { problems.Add(new($"/expectedMessages/{i}{(p.Field.Length > 0 ? "/" + p.Field : "")}", p.Message, p.Fix)); }
        }
        return result;
    }

    /// <summary>One entry, or null when it merged into an identical earlier one.</summary>
    private static ExpectedMessage? Entry(JsonNode? entry, IReadOnlySet<string>? knownIds, string lookup, List<ExpectedMessage> result)
    {
        if (entry is not JsonObject obj)
            throw new EntryProblem("", "expectedMessages accepts only " + Shape, "write the entry as " + Shape);
        if (obj.FirstOrDefault(kv => kv.Key is not ("id" or "element" or "why" or "count" or "all")) is { Key: { } unknown })
            throw new EntryProblem(unknown, "expectedMessages accepts only " + Shape, $"remove '{unknown}': the keys are id, element, why, count and all");
        string? Text(string name) => obj[name] is JsonValue v && v.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text) ? text.Trim() : null;
        string Required(string name) => Text(name) ?? throw new EntryProblem(name, $"expectedMessages requires non-empty '{name}': {Shape}",
            name == "element" ? "give the path the message prints (or its last level), or \"all\":true to cover every message of the id" : $"write '{name}' as non-empty text");
        var id = Required("id");
        var all = false;
        if (obj.ContainsKey("all") && (obj["all"] is not JsonValue a || !a.TryGetValue<bool>(out all)))
            throw new EntryProblem("all", $"expectedMessages '{id}': all must be true or false (\"all\":true)", "\"all\": true");
        // N3: with all:true the element is optional and covers every message of that id (lab 11: {id, all:true, why}).
        var element = all && Text("element") == null ? "" : Required("element");
        var why = Required("why");
        int? count = null;
        if (obj.ContainsKey("count"))
        {
            if (obj["count"] is not JsonValue c || !c.TryGetValue<int>(out var n) || n < 1)
                throw new EntryProblem("count", $"expectedMessages '{id}' @ {element}: count must be an integer of at least 1 (\"count\":2), or use \"all\":true", "\"count\": 2, or \"all\": true");
            count = n;
        }
        if (all && count != null) throw new EntryProblem("count", $"expectedMessages '{id}' @ {element}: use count or all, not both", "keep \"all\": true and remove count");
        if (knownIds != null && !knownIds.Contains(id))
            throw new EntryProblem("id", $"unknown expectedMessages id '{id}': use {lookup}", $"use {lookup}" + (NameSuggestions.Closest(id, knownIds) is { Count: > 0 } close ? "; closest: " + string.Join(", ", close) : ""));
        // A03: the exact path the message prints, or a suffix of one level or more (a level that names several messages
        // is reported as ambiguous with its candidates when evaluated). Only an empty level is malformed.
        if (element.Length > 0 && element.Split(" / ", StringSplitOptions.None).Any(string.IsNullOrWhiteSpace))
            throw new EntryProblem("element", $"expectedMessages element '{element}' has an empty level: give the path the message prints, or its last level(s) separated by ' / ' (\"Element (Kind)\" or \"Element\")",
                "remove the empty level: \"Element (Kind)\" or \"Parent / Element\"");
        var parsed = new ExpectedMessage(id, element, why) { Count = count, All = all };
        var same = result.FindIndex(e => e.Id == id && e.Element == element);
        if (same < 0) return parsed;
        var previous = result[same];
        // An identical entry written twice covers two messages: the two merge into one entry with the sum.
        if (previous.Why == why && previous.All == all)
        {
            result[same] = all ? previous : previous with { Count = (previous.Count ?? 1) + (count ?? 1) };
            return null;
        }
        throw new EntryProblem("", $"duplicate expectedMessages entry '{id}' @ {element} with a different why or all: write it once, "
            + $"with \"count\":{(previous.Count ?? 1) + (count ?? 1)} or \"all\":true to cover several messages",
            $"write '{id}' @ {element} once, with \"count\":{(previous.Count ?? 1) + (count ?? 1)} or \"all\":true");
    }

    public static ExpectationResult Evaluate(IReadOnlyList<MessageInfo> fresh, IReadOnlyList<ExpectedMessage> expected)
        => Evaluate(fresh, expected, null, null);

    /// <summary>The verdict of every new message. <paramref name="preexisting"/>: the messages the base already had (an
    /// expectation they satisfy counts as satisfied). <paramref name="footprint"/>: what the job created and changed; without
    /// it, no Unused* allowlist and the anonymous-access warning stays tolerated everywhere (the old contract).</summary>
    public static ExpectationResult Evaluate(IReadOnlyList<MessageInfo> fresh, IReadOnlyList<ExpectedMessage> expected,
        IReadOnlyList<MessageInfo>? preexisting, JobFootprint? footprint)
    {
        var consumed = new Dictionary<string, ExpectedMessage>(StringComparer.Ordinal);
        var ambiguous = new List<AmbiguousExpectation>();
        var unused = new List<ExpectedMessage>();
        var matched = new List<MatchedExpectation>();
        // An entry without element (all:true, N3) covers every message of its id.
        static bool Under(MessageInfo m, ExpectedMessage e) => m.Id == e.Id && (e.Element.Length == 0 || PathMatches(m.Path, e.Element));
        foreach (var e in expected)
        {
            var candidates = fresh.Where(m => Under(m, e)).ToArray();
            var open = candidates.Where(m => !consumed.ContainsKey(m.Key)).ToArray();
            if (candidates.Length == 0)
            {
                var old = (preexisting ?? []).Where(m => Under(m, e)).ToArray();
                if (old.Length > 0) matched.Add(new(e.Id, e.Element, e.Why, old[0].Path, true, old.Length));
                else unused.Add(e);
                continue;
            }
            MessageInfo[] taken;
            if (e.All) taken = open;
            else if (e.Count is { } n) taken = open.Take(n).ToArray();
            else if (candidates.Length == 1 && open.Length == 1) taken = open;
            else { ambiguous.Add(new(e, candidates)); continue; }
            if (taken.Length == 0) { ambiguous.Add(new(e, candidates)); continue; }
            foreach (var m in taken) consumed[m.Key] = e;
            matched.Add(new(e.Id, e.Element, e.Why, taken[0].Path, false, taken.Length));
        }
        var verdicts = new List<MessageVerdict>();
        var unexpected = new List<MessageInfo>();
        var tolerated = new List<MessageInfo>();
        var allowlisted = new List<MessageInfo>();
        var nonBlocking = new List<MessageInfo>();
        MessageVerdict Verdict(MessageInfo m, string verdict, ExpectedMessage? expectation, string? reason)
            => new(m.Id, m.Type, m.Path, m.Key, m.OwnerKey, m.Detail, verdict, expectation, reason);
        foreach (var m in fresh)
        {
            if (consumed.TryGetValue(m.Key, out var expectation)) { verdicts.Add(Verdict(m, "matched", expectation, null)); continue; }
            // A03: a new error always blocks (the Studio refuses to publish it).
            if (m.IsError) { unexpected.Add(m); verdicts.Add(Verdict(m, "unexpected", null, null)); continue; }
            if (IsAnonymousAccessWarning(m))
            {
                // C08 (atritos 3): a screen the job declares open to anonymous users (set AnonymousAccess true, Roles with
                // Anonymous) or that was already anonymous in the base: the whole family of that screen, never one per node.
                if (footprint != null && InScreens(m, footprint.AnonymousIntent))
                {
                    tolerated.Add(m); verdicts.Add(Verdict(m, "tolerated", null, AnonymousDeclaredReason));
                }
                // C37: a screen this job creates or changes may not stay open to anonymous users unless the job says why.
                else if (footprint != null && InFootprintScreens(m, footprint))
                {
                    unexpected.Add(m); verdicts.Add(Verdict(m, "unexpected", null, "anonymous-in-job-screen"));
                }
                else { tolerated.Add(m); verdicts.Add(Verdict(m, "tolerated", null, "anonymous-outside-footprint")); }
                continue;
            }
            // A03: the explicit SECURITY list blocks whenever new, unless the job declares it with why.
            if (SecurityWarnings.Ids.Contains(m.Id)) { unexpected.Add(m); verdicts.Add(Verdict(m, "unexpected", null, "security:" + m.Id)); continue; }
            if (Allowlist(m, footprint) is { } reason) { allowlisted.Add(m); verdicts.Add(Verdict(m, "allowlisted", null, reason)); continue; }
            // A03: every other new warning is returned, never refused, and never needs expectedMessages.
            nonBlocking.Add(m); verdicts.Add(Verdict(m, "nonblocking", null, NonBlockingReason));
        }
        return new(unexpected, [], ambiguous)
        {
            Tolerated = tolerated, Allowlisted = allowlisted, NonBlocking = nonBlocking, UnusedExpectations = unused, Matched = matched, Verdicts = verdicts
        };
    }

    /// <summary>The verdict and reason of a warning that blocks nothing (A03, I3).</summary>
    public const string NonBlockingVerdict = "nonblocking";
    public const string NonBlockingReason = "warning-non-blocking";

    /// <summary>Whether an expectation's element names the message path (A03): the exact path, or a suffix of one level or
    /// more, each level equal to the message level as printed ("Calculo (ServerAction)") or to its name before " ("
    /// ("Calculo"). Pure.</summary>
    public static bool PathMatches(string path, string element)
    {
        if (string.Equals(path, element, StringComparison.Ordinal)) return true;
        var levels = (path ?? "").Split(" / ", StringSplitOptions.None);
        var wanted = (element ?? "").Split(" / ", StringSplitOptions.None);
        if (wanted.Length == 0 || wanted.Length > levels.Length) return false;
        var offset = levels.Length - wanted.Length;
        for (var i = 0; i < wanted.Length; i++)
        {
            var level = levels[offset + i].Trim();
            var want = wanted[i].Trim();
            if (want.Length == 0) return false;
            if (!string.Equals(level, want, StringComparison.Ordinal) && !string.Equals(LevelName(level), want, StringComparison.Ordinal)) return false;
        }
        return true;
    }

    /// <summary>"Calculo (ServerAction)" names "Calculo"; a level without a kind is its own name.</summary>
    private static string LevelName(string level)
    {
        var open = level.LastIndexOf(" (", StringComparison.Ordinal);
        return open > 0 && level.EndsWith(')') ? level[..open] : level;
    }

    private static bool InFootprintScreens(MessageInfo m, JobFootprint footprint) => InScreens(m, footprint.Screens);

    private static bool InScreens(MessageInfo m, IReadOnlySet<string> screens)
        => m.ScreenKey != null ? screens.Contains(m.ScreenKey) : m.OwnerKey != null && screens.Contains(m.OwnerKey);

    /// <summary>I4 (atritos 3): the reason of the anonymous-access family on a screen of JobFootprint.AnonymousIntent.</summary>
    public const string AnonymousDeclaredReason = "anonymous-declared-by-job";

    /// <summary>Fonts and CDNs: an url there is a stylesheet or font the browser fetches; the offline cache warning about it
    /// is mechanical. Any other host (an app's own api, an image) stays unexpected.</summary>
    private static readonly string[] FontAndCdnHosts =
    [
        "fonts.googleapis.com", "fonts.gstatic.com", "use.typekit.net", "p.typekit.net", "fonts.bunny.net", "rsms.me",
        "use.fontawesome.com", "kit.fontawesome.com", "ka-f.fontawesome.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net",
        "unpkg.com", "fastly.jsdelivr.net", "maxcdn.bootstrapcdn.com", "stackpath.bootstrapcdn.com", "code.jquery.com",
    ];

    /// <summary>The allowlist: only warnings, only these two mechanical cases. Null when the message is not allowlisted.</summary>
    public static string? Allowlist(MessageInfo m, JobFootprint? footprint)
    {
        if (m.Type != "Warning") return null;
        if (m.Id == "InvalidResourceURL_Offline" && OfflineUrlHost(m.Detail) is { } host
            && FontAndCdnHosts.Any(h => host.Equals(h, StringComparison.OrdinalIgnoreCase) || host.EndsWith("." + h, StringComparison.OrdinalIgnoreCase)))
            return "offline-font-url";
        if (m.Id.StartsWith("Unused", StringComparison.Ordinal) && footprint != null && m.OwnerKey != null && footprint.Created.Contains(m.OwnerKey))
            return "unused-created-by-job";
        return null;
    }

    private static string? OfflineUrlHost(string detail)
    {
        var start = detail.IndexOf("url '", StringComparison.OrdinalIgnoreCase);
        if (start < 0) return null;
        var end = detail.IndexOf('\'', start + 5);
        var url = end > start ? detail[(start + 5)..end] : detail[(start + 5)..];
        return Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" ? uri.Host : null;
    }

    // O mesmo aviso do Studio chega diferente nas duas plataformas, e a tolerancia tem de valer nas duas:
    //   SS11: id CustomObjectWarning (um balde generico, titulo "{0}" e detalhe "{1}"), com a frase
    //         "Consider removing the Anonymous Role from this Screen.";
    //   ODC:  id proprio ServerActionInScreenAccessibleByEveryone, titulo "Security Warning", com a frase
    //         "Consider restricting Screen accessibility to Authenticated Users."
    // A primeira frase e identica nas duas e e ela que identifica o caso. O balde CustomObjectWarning carrega
    // diagnosticos sem relacao, por isso nele o texto continua obrigatorio: nunca se tolera o ID inteiro.
    // A familia inteira (os ids anonimos do ODC e o balde do O11 com as duas frases) vive em SecurityWarnings (I2).
    public static bool IsAnonymousAccessWarning(MessageInfo message) => message.Type == "Warning" &&
        SecurityWarnings.IsAnonymous(message.Id, message.Detail);

    /// <summary>The lane whose Verify ids a job declares: the build this file is compiled into (Anvil.Core: O11, whose
    /// manifests are catalog/verify-messages-*.json; Anvil.Core.Odc: ODC, catalog/odc/). The ODC verifier has ids the
    /// O11 one never emits (UnusedGlobalEvent, ...) and the other way round, so neither lane accepts the other's list.</summary>
    public static string Lane => typeof(MessageExpectations).Assembly.GetName().Name == "Anvil.Core.Odc" ? "odc" : "o11";

    public static string CatalogDirectory(string root, string lane)
        => lane == "odc" ? Path.Combine(root, "catalog", "odc") : Path.Combine(root, "catalog");

    /// <summary>Schema and ids of the job's expectedMessages, against the ids of <paramref name="lane"/> (default: this build's
    /// lane; a test that checks every suite passes the lane of each folder). Throws on the first problem; the preflight reads
    /// them all with <see cref="Inspect"/>.</summary>
    public static IReadOnlyList<ExpectedMessage> Read(JsonNode job, string jobPath, string? lane = null)
    {
        var reading = Inspect(job, jobPath, lane);
        if (reading.Problems.Count > 0) throw new ArgumentException(string.Join("; ", reading.Problems.Select(p => p.Message)));
        return reading.Expected;
    }

    /// <summary>The expectation contract of a job without throwing (C01, N3 of the atritos 3 package): every malformed entry
    /// is a problem with its pointer; the ids are checked against the first list found (KnownIds), and when none is found the
    /// shape is still checked and the note VERIFY_IDS_UNCHECKED says so. A missing id list never fails a job.</summary>
    public static ExpectationReading Inspect(JsonNode job, string? jobPath, string? lane = null)
    {
        var problems = new List<ExpectationProblem>();
        var notes = new List<JsonObject>();
        if (job is not JsonObject obj) return new([], problems, notes, null);
        if (obj.ContainsKey("maxNewMessages"))
            problems.Add(new("/maxNewMessages", $"{jobPath}: campo removido: use expectedMessages [{{id, element, why}}] instead of maxNewMessages",
                "remove maxNewMessages; declare each expected Verify message in expectedMessages [{id, element, why}]"));
        if (obj.ContainsKey("expectValid") && (obj["expectValid"] is not JsonValue value || !value.TryGetValue<bool>(out _)))
            problems.Add(new("/expectValid", $"{jobPath}: expectValid must be a boolean", "\"expectValid\": true (the default) or false"));
        if (!obj.ContainsKey("expectedMessages")) return new([], problems, notes, null);
        if (obj["expectedMessages"] == null)
        {
            problems.Add(new("/expectedMessages", "expectedMessages must be an array, not null", "remove expectedMessages, or write it as an array"));
            return new([], problems, notes, null);
        }
        lane ??= Lane;
        var lookup = lane == "odc"
            ? "anvil-odc verify-catalog --id <id> (manifests: catalog/odc/verify-messages-<version>.json, written by anvil-odc verify-catalog --out)"
            : "verify-message --find <part of id>";
        var entries = obj["expectedMessages"];
        // An empty or malformed list needs no ids.
        var (known, source) = entries is JsonArray { Count: > 0 } ? KnownIds(lane, jobPath) : (null, null);
        if (known == null && entries is JsonArray { Count: > 0 })
            notes.Add(new JsonObject { ["code"] = "VERIFY_IDS_UNCHECKED",
                ["message"] = $"no list of {lane} Verify ids was found (no bound Studio, no catalog/ next to the kernel, the job or the current folder): the shape of expectedMessages was checked, the ids were not" });
        var expected = ParseAll(entries, known, lookup, problems);
        return new(expected, problems, notes, source);
    }

    /// <summary>The Verify ids of <paramref name="lane"/> (C01): the live VerifyCatalog when this process already bound the
    /// Studio of this build's lane (never binding one only for this), together with the first catalog/ folder found under
    /// the repository root of the Anvil.Core assembly, of AppContext.BaseDirectory, of the job's folder and of the current
    /// directory, in that order (the CLI lives in &lt;kernel&gt;/.local/&lt;lane&gt;/cli, like ApiCatalog, Builtins and VerifyHints
    /// read it; on O11, after StudioAssemblies.Bind, AppContext.BaseDirectory is the Studio's folder, so the assembly comes
    /// first). Null when none exists.</summary>
    internal static (IReadOnlySet<string>? Ids, string? Source) KnownIds(string lane, string? jobPath)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var sources = new List<string>();
        if (lane == Lane && LiveVerifyIds() is { } live) { ids.UnionWith(live); sources.Add("studio"); }
        var jobDir = jobPath == null ? null : Path.GetDirectoryName(Path.GetFullPath(jobPath));
        foreach (var root in JobRunner.RunningRoots().Concat(jobDir == null ? [] : [JobRunner.RepoRoot(jobDir)]).Append(JobRunner.RepoRoot(Directory.GetCurrentDirectory()))
                     .OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var catalog = CatalogDirectory(root, lane);
            var files = Directory.Exists(catalog) ? Directory.GetFiles(catalog, "verify-messages-*.json") : [];
            if (files.Length == 0) continue;
            foreach (var file in files) ids.UnionWith(JsonNode.Parse(File.ReadAllText(file))!.AsArray().Select(x => x!["id"]!.GetValue<string>()));
            sources.Add(catalog);
            break;
        }
        return sources.Count == 0 ? (null, null) : (ids, string.Join(", ", sources));
    }

    /// <summary>The ids of the bound Studio's VerifyCatalog, or null when this process has not bound the Studio of its lane
    /// (StudioAssemblies / StudioAssembliesOdc .Directory throws until Bind runs).</summary>
    private static IEnumerable<string>? LiveVerifyIds()
    {
        var binding = typeof(MessageExpectations).Assembly.GetType(Lane == "odc" ? "Anvil.Core.StudioAssembliesOdc" : "Anvil.Core.StudioAssemblies");
        try
        {
            if (binding?.GetProperty("Directory", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)?.GetValue(null) is not string { Length: > 0 }) return null;
            return StudioAdapter.Runtime.VerifyDefinitions.Select(d => d.Id).ToArray();
        }
        catch { return null; }
    }
}
