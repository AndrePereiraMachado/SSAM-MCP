using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core.Preflight;

/// <summary>
/// N1_ABBREVIATION (R3-C, 2026-10-29; K9 of the review of 28/10). N1 of the OutSystems standards (kernel/scripts/
/// outsystems_padroes/RULES.md: every element has a short, meaningful name) lived only in the Python ruler, which no delivery's
/// preflight runs: node names like GetAcc, RefGen and Cur passed, and the rename the owner asked for afterwards cost a
/// destructive round.
/// <para>A word of a NEW name abbreviates when the element's OWN context (the action it calls and the parameters it passes, the
/// entities it reads and the attributes it filters by, the structure a SQL returns, its type; for an action, all of that of its
/// elements) has a longer word that starts with it (Acc of Account, Gen of Generate) or that keeps its consonants in order from
/// the same first letter (Cd of Card), and the word is no whole word of the job: a word some name the rule does not judge uses
/// whole (an entity, an attribute, a callee, a type, a member of an expression), an inflection of one (Card beside Cards), or a
/// name the platform itself gives in every module (Id, List, Record, Current, Count, Length, Empty), and no whole English
/// word of the fixed dictionary shipped as data (Kernel/Preflight/EnglishWords.txt: Add of Address, Log of Login, Pay of
/// Payment are words). No list of abbreviations: the expansions come only from the element's own context. A word in
/// capitals (URL, IBAN) is an acronym, never an abbreviation.</para>
/// <para>Certain only when it is proved (R3-C review, 2026-10-29): the abbreviated word stands for exactly one word of the
/// context, and the corrected text names no two elements of one scope alike (its inputs, outputs and locals; its nodes)
/// where the author's text did not: two abbreviations of one action whose whole names meet (Cust and Cst, both Customer)
/// are both a choice, without a patch.</para>
/// <para>Rodada 2 of the review: a dictionary can have gaps, so certainty never depends on it. A reading is certain only
/// when the name abbreviates, word by word and in order, the very name it is named after (its callee, its type as written,
/// its source): GetWare of GetWarehouse, TrkGen of Tracking_Generate, Whs of Warehouse. SumOrder of Order_SummaryRead is
/// not (Order comes first there): at most a candidate without a patch. The names of the lane's built-in functions
/// (FunctionCatalog: Sum, Max, If...) are words of the platform, never abbreviations.</para>
/// <para>A warning (A03: only errors block), in the preflight of every job (PreflightChecks.Pure). The names judged are the new
/// ones of the logic texts (ssam-flow/1: an action without @key and all it declares; in an action with @key, what has no id)
/// and of the JSON declaration form. One reading (each abbreviated word stands for exactly one word of the context, the whole
/// name is free in its action, and the text read back with it renamed is the same action renamed): the patch is the text with
/// the whole name, ABBREVIATION_EXPANDED, certain. Several readings: the candidates, each with its patch, ABBREVIATION_CHOICE.
/// The JSON form names the whole name in the fix (its uses are not rewritten here).</para>
/// </summary>
public static class AbbreviationRules
{
    public const string Code = "N1_ABBREVIATION";
    /// <summary>The certainty rule of the one reading (PatchCertainty).</summary>
    public const string Expanded = "ABBREVIATION_EXPANDED";
    /// <summary>The certainty rule of several readings (PatchCertainty).</summary>
    public const string Choice = "ABBREVIATION_CHOICE";

    /// <summary>A word of a name and where it starts in it.</summary>
    public sealed record Word(string Text, int Index);

    /// <summary>A word of the element's own context and what it comes from ("the call of GetAccount", "its type Customer").</summary>
    public sealed record ContextWord(string Text, string From);

    /// <summary>An abbreviated word of a name and the context words it can stand for (one: one reading).</summary>
    public sealed record Finding(Word Word, IReadOnlyList<ContextWord> Expansions);

    private static readonly Regex WordPattern = new(@"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+", RegexOptions.CultureInvariant);
    // A word followed by one of these endings is still that word (Card and Cards, Count and Counter, Post and Posted).
    private static readonly string[] Inflections = ["s", "es", "d", "ed", "ing", "er", "ers"];
    // What the platform names in every module: the identifier attribute of an entity and the outputs and members of an
    // aggregate, a query and a list. Never the abbreviation of a longer word of the context (Id of Identifier).
    private static readonly HashSet<string> PlatformWords = new(StringComparer.OrdinalIgnoreCase) { "Id", "List", "Record", "Current", "Count", "Length", "Empty" };
    private static readonly Regex Identifier = new(@"[A-Za-z_][A-Za-z0-9_]*", RegexOptions.CultureInvariant);
    private static readonly Regex Literal = new("\"(?:[^\"]|\"\")*\"|`[^`]*`", RegexOptions.CultureInvariant);

    /// <summary>The words of a name: its CamelCase and underscore parts, a run of capitals one word (URLPath: URL, Path).</summary>
    public static IReadOnlyList<Word> Words(string name) => WordPattern.Matches(name).Select(m => new Word(m.Value, m.Index)).ToList();

    /// <summary>The abbreviated words of <paramref name="name"/> against its own <paramref name="context"/>; <paramref name="whole"/>
    /// is the job's set of whole words (case-insensitive).</summary>
    public static IReadOnlyList<Finding> Findings(string name, IReadOnlyList<ContextWord> context, IReadOnlySet<string> whole)
    {
        var findings = new List<Finding>();
        foreach (var word in Words(name))
        {
            var s = word.Text;
            if (!s.All(char.IsLetter) || s.Length >= 2 && s.All(char.IsUpper) || Whole(s, context, whole)) continue;
            var expansions = context.Where(c => c.Text.Length > s.Length && (Starts(c.Text, s) || Contracts(s, c.Text)))
                .DistinctBy(c => c.Text, StringComparer.OrdinalIgnoreCase).ToList();
            if (expansions.Count > 0) findings.Add(new(word, expansions));
        }
        return findings;
    }

    /// <summary>Every reading of a name's findings (one word of its expansions for each), at most <paramref name="max"/>, each
    /// with the written word's first letter in its case (Acc: Account, acc: account).</summary>
    public static List<string> Readings(string name, IReadOnlyList<Finding> findings, int max = 4)
    {
        var readings = new List<string> { name };
        for (var i = findings.Count - 1; i >= 0; i--)
        {
            var word = findings[i].Word;
            readings = readings.SelectMany(r => findings[i].Expansions.Select(e => r[..word.Index] + Cased(e.Text, word.Text) + r[(word.Index + word.Text.Length)..]))
                .Distinct(StringComparer.Ordinal).Take(max).ToList();
        }
        return readings;
    }

    private static string Cased(string expansion, string written) =>
        (char.IsUpper(written[0]) ? char.ToUpperInvariant(expansion[0]) : char.ToLowerInvariant(expansion[0])) + expansion[1..];

    private static bool Starts(string word, string s) =>
        word.StartsWith(s, StringComparison.OrdinalIgnoreCase) && !Inflections.Contains(word[s.Length..].ToLowerInvariant());

    // The consonants of s, in order, from the first letter of word (Cd of Card, Ln of Loan); y counts as a vowel (By, My).
    private static bool Contracts(string s, string word)
    {
        if (s.Length < 2 || s.Any(c => "aeiouyAEIOUY".IndexOf(c) >= 0) || char.ToUpperInvariant(s[0]) != char.ToUpperInvariant(word[0])) return false;
        var at = 0;
        foreach (var c in word) if (at < s.Length && char.ToUpperInvariant(c) == char.ToUpperInvariant(s[at])) at++;
        return at == s.Length;
    }

    private static bool Whole(string s, IReadOnlyList<ContextWord> context, IReadOnlySet<string> whole)
    {
        bool Inflected(string w) => w.Length > s.Length && w.StartsWith(s, StringComparison.OrdinalIgnoreCase) && Inflections.Contains(w[s.Length..].ToLowerInvariant());
        return PlatformWords.Contains(s) || IsBuiltin(s) || IsEnglishWord(s) || whole.Contains(s) || context.Any(c => string.Equals(c.Text, s, StringComparison.OrdinalIgnoreCase))
            || context.Any(c => Inflected(c.Text)) || whole.Any(Inflected);
    }

    /// <summary>The fixed dictionary of whole English words (Kernel/Preflight/EnglishWords.txt, an embedded resource of both
    /// lanes): a word of a name found there is a word, never an abbreviation (Add of Address, Log of Login, Pay of Payment).</summary>
    public static IReadOnlySet<string> Dictionary => Words_.Value;

    private static readonly Lazy<HashSet<string>> Words_ = new(() =>
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var stream = typeof(AbbreviationRules).Assembly.GetManifestResourceStream("Anvil.Core.Kernel.Preflight.EnglishWords.txt")
            ?? throw new InvalidOperationException("N1_ABBREVIATION: the embedded dictionary Anvil.Core.Kernel.Preflight.EnglishWords.txt is missing");
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
            if (!line.StartsWith('#')) foreach (var word in line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)) set.Add(word);
        return set;
    });

    /// <summary>A whole English word of the dictionary, as written or inflected (Logs, Paid is not: only regular endings;
    /// Closing and Closed of close).</summary>
    public static bool IsEnglishWord(string s)
    {
        if (Dictionary.Contains(s)) return true;
        var lower = s.ToLowerInvariant();
        foreach (var ending in Inflections)
            if (lower.Length - ending.Length >= 3 && lower.EndsWith(ending, StringComparison.Ordinal))
            {
                var stem = lower[..^ending.Length];
                if (Dictionary.Contains(stem) || ending[0] is 'e' or 'i' && Dictionary.Contains(stem + "e")) return true;
            }
        return false;
    }

    /// <summary>A name of a built-in function of the lane (FunctionCatalog: Sum, Max, If, Abs...): a word of the platform,
    /// never an abbreviation. No catalog in this host: none.</summary>
    public static bool IsBuiltin(string word)
    {
        try { return FunctionCatalog.Names.Contains(word); }
        catch { return false; }
    }

    // The names an element of a text is named after: the action it calls, its type as written, the entities it reads, the
    // records a query returns.
    private static List<string> SourcesOf(FlowItem item)
    {
        var sources = new List<string>();
        if (item.Role is "in" or "out" or "local") { if (item.Prop("DataType") is { Length: > 0 } type) sources.Add(type); return sources; }
        if (item.Kind == "Execute") sources.Add(Callee(item.Prop("Action") ?? ""));
        else if (item.Kind == "AggregateNode")
            foreach (var source in item.Items.Where(p => p.Role == "source")) { if (source.Prop("Source") is { } s) sources.Add(s); sources.Add(source.Name); }
        else if (item.Kind == "SQLNode")
            foreach (var output in item.Items.Where(p => p.Role == "output")) { if (output.Prop("EntityOrStructure") is { } o) sources.Add(o); }
        else foreach (var value in item.Props.Values.Where(v => v.Type == 'r')) sources.Add(Callee(value.Text));
        return sources.Where(s => s.Length > 0).ToList();
    }

    // The name abbreviates one of its sources word by word: each word of the name, in order, is a later word of that source,
    // or (an abbreviated word) the one word it stands for.
    private static bool Aligned(Judged j, IReadOnlyList<Finding> findings)
    {
        var expansions = findings.Where(f => f.Expansions.Count == 1).ToDictionary(f => f.Word.Index, f => f.Expansions[0].Text);
        foreach (var source in j.Sources ?? [])
        {
            var words = Identifier.Matches(source).SelectMany(m => Words(m.Value)).Select(w => w.Text).ToList();
            var at = 0; var ok = true;
            foreach (var word in Words(j.Name))
            {
                var expected = expansions.TryGetValue(word.Index, out var expansion) ? expansion : word.Text;
                var next = words.FindIndex(at, w => string.Equals(w, expected, StringComparison.OrdinalIgnoreCase));
                if (next < 0) { ok = false; break; }
                at = next + 1;
            }
            if (ok) return true;
        }
        return false;
    }

    // How many elements of an action share a name with another of the same scope (its inputs, outputs and locals are one
    // scope, its nodes another), any case.
    private static int Namesakes(FlowItem action) => action.Items.Where(i => FlowItem.Keyed(i.Role) && i.Name.Length > 0)
        .GroupBy(i => (i.Role == "node" ? "node" : "variable", i.Name.ToLowerInvariant())).Where(g => g.Count() > 1).Sum(g => g.Count());

    // ---- the job ----------------------------------------------------------------------------------------------------------

    // A name the rule judges: where it is, what it is, its own context, and (text form) the text, the action and its item.
    private sealed record Judged(int Op, string Pointer, string Name, string What, List<ContextWord> Context,
        int Text = -1, FlowItem? Action = null, FlowItem? Item = null, IReadOnlyList<string>? Sources = null);

    /// <summary>The N1_ABBREVIATION warnings of a job (pointers under <paramref name="prefix"/>; null: none, nor patches).</summary>
    public static List<JsonObject> Check(JsonArray ops, string? prefix)
    {
        var judged = new List<Judged>();
        var texts = new Dictionary<int, (JsonObject Data, List<(string Text, string? BasedOn, string Pointer)> Texts, FlowItem?[] Actions)>();
        var corpus = new List<string>();
        // 1. The new names of the logic texts and of the JSON declarations, with their contexts; and every other name of the job.
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "logic" || op["data"] is not JsonObject data) continue;
            if (data.ContainsKey("flow"))
            {
                List<(string Text, string? BasedOn, string Pointer)> list;
                try { list = FlowTextForm.Texts(data); }
                catch { continue; }
                var actions = new FlowItem?[list.Count];
                for (var t = 0; t < list.Count; t++)
                {
                    try { actions[t] = ModuleFlow.Read(list[t].Text); }
                    catch { continue; }
                    FromText(i, t, list[t].Pointer, actions[t]!, judged, corpus);
                }
                texts[i] = (data, list, actions);
            }
            else if (data["actions"] is JsonArray declared)
                for (var a = 0; a < declared.Count; a++)
                    if (declared[a] is JsonObject action) FromDeclaration(i, a, action, judged, corpus);
        }
        foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "spec" && o["data"] is JsonObject))
            try
            {
                var data = SpecExpander.Sections(op["data"]!.AsObject());
                foreach (var section in new[] { "entities", "clientEntities", "static", "structures" })
                    foreach (var record in (data[section] as JsonArray ?? []).OfType<JsonObject>())
                    {
                        corpus.Add(record["name"]?.ToString() ?? "");
                        foreach (var attribute in (record["attributes"] as JsonArray ?? []).OfType<JsonObject>())
                        { corpus.Add(attribute["name"]?.ToString() ?? ""); corpus.Add(attribute["type"]?.ToString() ?? ""); }
                    }
            }
            catch { /* the spec's own rules say what is wrong with it */ }
        var judgedNames = judged.Select(j => j.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var whole = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in corpus)
            foreach (Match token in Identifier.Matches(name))
                if (!judgedNames.Contains(token.Value)) foreach (var word in Words(token.Value)) whole.Add(word.Text);

        // 2. The findings, and for each text form op the one patch of its certain renames (each proved by reading it again).
        var found = new List<(Judged Judged, IReadOnlyList<Finding> Findings, List<string> Readings, bool Free)>();
        foreach (var j in judged)
        {
            var findings = Findings(j.Name, j.Context, whole);
            if (findings.Count == 0) continue;
            var readings = Readings(j.Name, findings);
            found.Add((j, findings, readings, readings.Count == 1 && Free(j, readings[0])));
        }
        // Two certain renames of one action that give the same whole name are a dispute: neither is certain (the author
        // chooses a name for each).
        // A reading is certain only when the name abbreviates, word by word and in order, the name it is named after (its
        // callee, its type as written, its source): an expansion found elsewhere in the context is at most a candidate.
        var unaligned = found.Where(f => f.Free && !Aligned(f.Judged, f.Findings)).Select(f => f.Judged).ToHashSet();
        var disputed = found.Where(f => f.Free).GroupBy(f => (f.Judged.Op, f.Judged.Text, Name: f.Readings[0].ToLowerInvariant()))
            .Where(g => g.Count() > 1).SelectMany(g => g.Select(f => f.Judged)).ToHashSet();
        var corrected = new Dictionary<int, string?[]>();
        var proved = new HashSet<Judged>();
        foreach (var (j, _, readings, _) in found.Where(f => f.Free && f.Judged.Action != null && !disputed.Contains(f.Judged) && !unaligned.Contains(f.Judged)))
        {
            var (_, list, _) = texts[j.Op];
            var current = corrected.TryGetValue(j.Op, out var made) && made[j.Text] != null ? made[j.Text]! : list[j.Text].Text;
            FlowItem now;
            try { now = ModuleFlow.Read(current); }
            catch { continue; }
            if (Renamed(current, now, j.Item!, j.Name, readings[0]) is not { } next) continue;
            // The corrected text never names two elements of one scope alike where the text did not.
            try { if (Namesakes(ModuleFlow.Read(next)) > Namesakes(now)) continue; }
            catch (FormatException) { continue; }
            if (!corrected.TryGetValue(j.Op, out made)) corrected[j.Op] = made = new string?[list.Count];
            made[j.Text] = next;
            proved.Add(j);
        }
        JsonArray? OpPatch(int op, string?[]? extra = null)
        {
            if (prefix == null || !texts.TryGetValue(op, out var form)) return null;
            var edits = corrected.TryGetValue(op, out var made) ? made.ToArray() : new string?[form.Texts.Count];
            if (extra != null) for (var t = 0; t < extra.Length; t++) if (extra[t] != null) edits[t] = extra[t];
            if (edits.All(e => e == null)) return null;
            var patch = FlowTextForm.Patch(form.Data, form.Texts, edits, []);
            foreach (var step in patch.OfType<JsonObject>()) step["path"] = prefix + "/" + op + "/data" + step["path"]!.GetValue<string>();
            return patch;
        }

        // 3. One warning per name.
        var problems = new List<JsonObject>();
        foreach (var (j, findings, readings, _) in found)
        {
            var said = string.Join("; ", findings.Select(f => "'" + f.Word.Text + "' of " + string.Join(" or ", f.Expansions.Select(e => "'" + e.Text + "' (" + e.From + ")"))));
            var message = $"logic: the name '{j.Name}' ({j.What}) abbreviates {said}: N1 names an element with whole words of its own context";
            JsonObject problem;
            if (proved.Contains(j))
            {
                problem = JobPreflight.Problem(j.Op, Pointer(j), Code, "warning", message,
                    $"rename it {readings[0]}: the patch writes it, and every use of it in its text", OpPatch(j.Op), "logic", Expanded);
                problem["wholeName"] = readings[0];
            }
            else if (disputed.Contains(j))
            {
                problem = JobPreflight.Problem(j.Op, Pointer(j), Code, "warning", message,
                    $"rename it with a whole name: {readings[0]} is also the whole name of another abbreviated element of its action, so choose one name for each", null, "logic", Choice);
                problem["candidates"] = new JsonArray(new JsonObject { ["name"] = readings[0], ["patch"] = null });
                problem["wholeName"] = readings[0];
            }
            else if (unaligned.Contains(j))
            {
                problem = JobPreflight.Problem(j.Op, Pointer(j), Code, "warning", message,
                    $"rename it {readings[0]} if that is what it stands for: its words do not abbreviate, in order, the name of what it calls, reads or is typed by, so the author chooses", null, "logic", Choice);
                problem["candidates"] = new JsonArray(new JsonObject { ["name"] = readings[0], ["patch"] = null });
                problem["wholeName"] = readings[0];
            }
            else if (readings.Count > 1)
            {
                problem = JobPreflight.Problem(j.Op, Pointer(j), Code, "warning", message,
                    "rename it with the whole word of what it names: " + string.Join(" or ", readings) + " (the candidates)", null, "logic", Choice);
                problem["candidates"] = new JsonArray(readings.Select(r => (JsonNode)new JsonObject { ["name"] = r, ["patch"] = CandidatePatch(j, r) }).ToArray());
            }
            else
            {
                problem = JobPreflight.Problem(j.Op, Pointer(j), Code, "warning", message,
                    $"rename it {readings[0]}" + (j.Action == null ? ", here and where the action uses it" : ReferenceEquals(j.Item, j.Action) ? ", and every call of it" : ", here and in every use of it") + (Taken(j, readings[0]) ? " (that name is taken in its action: choose another whole name)" : ""),
                    null, "logic");
                problem["wholeName"] = readings[0];
            }
            problem["name"] = j.Name;
            problems.Add(problem);
        }
        return problems;

        string? Pointer(Judged j) => prefix == null ? null : prefix + j.Pointer;

        JsonArray? CandidatePatch(Judged j, string reading)
        {
            if (!Free(j, reading)) return null;
            var (_, list, _) = texts[j.Op];
            var current = corrected.TryGetValue(j.Op, out var made) && made[j.Text] != null ? made[j.Text]! : list[j.Text].Text;
            FlowItem now;
            try { now = ModuleFlow.Read(current); }
            catch { return null; }
            if (Renamed(current, now, j.Item!, j.Name, reading) is not { } next) return null;
            try { if (Namesakes(ModuleFlow.Read(next)) > Namesakes(now)) return null; }
            catch (FormatException) { return null; }
            var extra = new string?[list.Count];
            extra[j.Text] = next;
            return OpPatch(j.Op, extra);
        }
    }

    // ---- the text form ----------------------------------------------------------------------------------------------------

    private static void FromText(int op, int text, string at, FlowItem action, List<Judged> judged, List<string> corpus)
    {
        var fresh = action.Key.Length == 0;
        bool New(FlowItem item) => fresh || item.Key.StartsWith(FlowParser.FreshPrefix, StringComparison.Ordinal);
        var pointer = "/" + op + "/data" + at;
        var all = new List<ContextWord>();
        var owner = action.Name;
        foreach (var item in action.Items)
        {
            var context = ContextOf(item);
            all.AddRange(context);
            if (item.Name.Length == 0 || !FlowItem.Keyed(item.Role) || !New(item)) continue;
            // A call the text did not name is named after its action: no name of the author's.
            if (item.Kind == "Execute" && string.Equals(item.Name, Callee(item.Prop("Action") ?? ""), StringComparison.Ordinal)) continue;
            var what = item.Role switch { "in" => "input", "out" => "output", "local" => "local", _ => "node" } + " of " + owner;
            judged.Add(new(op, pointer, item.Name, what, context, text, action, item, SourcesOf(item)));
        }
        if (fresh && action.Name.Length > 0) judged.Add(new(op, pointer, action.Name, "action", all.DistinctBy(c => c.Text, StringComparer.OrdinalIgnoreCase).ToList(), text, action, action));
        Names(action, corpus);
    }

    // What an element of a text is named after: its type (a parameter, a local), what it calls and the parameters it passes,
    // the entities it reads and the attributes it filters, joins and sorts by, the record a query returns.
    private static List<ContextWord> ContextOf(FlowItem item)
    {
        var words = new List<ContextWord>();
        void Add(string? name, string from)
        {
            if (string.IsNullOrWhiteSpace(name)) return;
            foreach (Match token in Identifier.Matches(name)) foreach (var word in Words(token.Value)) words.Add(new(word.Text, from));
        }
        if (item.Role is "in" or "out" or "local") { if (TypeName(item.Prop("DataType")) is { } type) Add(type, "its type " + type); return words; }
        if (item.Role != "node") return words;
        switch (item.Kind)
        {
            case "Execute":
                var callee = Callee(item.Prop("Action") ?? "");
                Add(callee, "the call of " + callee);
                foreach (var argument in item.Items.Where(p => p.Role == "argument")) Add(argument.Name, "a parameter of " + callee);
                break;
            case "AggregateNode":
                var sources = item.Items.Where(p => p.Role == "source").ToList();
                foreach (var source in sources) { Add(source.Prop("Source"), "its source " + source.Prop("Source")); Add(source.Name, "its source " + source.Name); }
                foreach (var part in item.Items.Where(p => p.Role is not "source"))
                    foreach (var value in part.Props.Values.Where(v => v.Type == 'e'))
                        foreach (var source in sources)
                            foreach (Match member in Regex.Matches(CodeOf(value.Text), @"(?<![\w.])" + Regex.Escape(source.Name) + @"\.([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.IgnoreCase))
                                Add(member.Groups[1].Value, "the attribute " + source.Name + "." + member.Groups[1].Value);
                break;
            case "SQLNode":
                foreach (var output in item.Items.Where(p => p.Role == "output")) Add(output.Prop("EntityOrStructure"), "its output " + output.Prop("EntityOrStructure"));
                foreach (Match entity in Regex.Matches(item.Prop("Statement") ?? "", @"\{([A-Za-z_][A-Za-z0-9_]*)\}")) Add(entity.Groups[1].Value, "its entity " + entity.Groups[1].Value);
                break;
            default:
                foreach (var value in item.Props.Values.Where(v => v.Type == 'r')) Add(Callee(value.Text), "its " + Callee(value.Text));
                foreach (var argument in item.Items.Where(p => p.Role == "argument")) Add(argument.Name, "a parameter it passes");
                break;
        }
        return words;
    }

    // Every name of a text the rule may count as whole words: its references, the identifiers of its expressions and the
    // names of its parts (the judged names are taken out by the caller).
    private static void Names(FlowItem item, List<string> corpus)
    {
        foreach (var value in item.Props.Values)
            if (value.Type == 'r') corpus.Add(value.Text);
            else if (value.Type == 'e') corpus.Add(CodeOf(value.Text));
        if (!FlowItem.Keyed(item.Role)) corpus.Add(item.Name);
        foreach (var child in item.Items) Names(child, corpus);
    }

    // ---- the JSON declaration form --------------------------------------------------------------------------------------

    private static void FromDeclaration(int op, int index, JsonObject action, List<Judged> judged, List<string> corpus)
    {
        var name = action["name"]?.ToString() ?? "";
        var at = "/" + op + "/data/actions/" + index;
        var all = new List<ContextWord>();
        void Parameters(string section, string what)
        {
            var list = action[section] as JsonArray ?? [];
            for (var p = 0; p < list.Count; p++)
                if (list[p] is JsonObject parameter && parameter["name"]?.ToString() is { Length: > 0 } parameterName)
                {
                    var context = new List<ContextWord>();
                    if (TypeName(parameter["type"]?.ToString()) is { } type) foreach (var word in Words(type)) context.Add(new(word.Text, "its type " + type));
                    corpus.Add(parameter["type"]?.ToString() ?? "");
                    all.AddRange(context);
                    judged.Add(new(op, at + "/" + section + "/" + p + "/name", parameterName, what + " of " + name, context));
                }
        }
        Parameters("inputs", "input"); Parameters("outputs", "output"); Parameters("vars", "local");
        var scan = LogicScan.Of(action);
        foreach (var node in scan.Nodes.Values)
        {
            var context = new List<ContextWord>();
            void Add(string? text, string from) { if (text is { Length: > 0 }) foreach (Match token in Identifier.Matches(text)) foreach (var word in Words(token.Value)) context.Add(new(word.Text, from)); }
            if (node.Kind == "call") { var callee = Callee(node.Target ?? ""); Add(callee, "the call of " + callee); foreach (var (key, _) in node.Step["args"] as JsonObject ?? []) Add(key, "a parameter of " + callee); corpus.Add(node.Target ?? ""); }
            else if (node.Kind is "aggregate" or "sql") foreach (var source in node.Sources.Append(node.Step["get"]?.ToString() ?? "")) { Add(source, "its source " + source); corpus.Add(source); }
            else if (node.Kind == "entity" && new[] { "save", "create", "update", "delete" }.FirstOrDefault(node.Step.ContainsKey) is { } verb) { Add(node.Step[verb]?.ToString(), "its entity " + node.Step[verb]); corpus.Add(node.Step[verb]?.ToString() ?? ""); }
            all.AddRange(context);
            if (node.Step["as"] is not JsonValue && node.Kind != "handler") continue;   // a name the job did not write
            judged.Add(new(op, at + node.Pointer + (node.Kind == "handler" ? "/name" : "/as"), node.Name, "node of " + name, context));
        }
        foreach (var expression in scan.Expressions) corpus.Add(CodeOf(expression.Text));
        if (name.Length > 0) judged.Add(new(op, at + "/name", name, "action", all.DistinctBy(c => c.Text, StringComparer.OrdinalIgnoreCase).ToList()));
    }

    // ---- helpers --------------------------------------------------------------------------------------------------------

    /// <summary>The name a written callee reaches (Kind:Producer.Name, (System).Name, Name): the name R2-A's one reading of a
    /// written name gives (<see cref="NameResolution.Parse"/>), so the words N1 reads are the ones the resolver resolves.</summary>
    internal static string Callee(string written) => NameResolution.Parse(written).Name;

    // The type a name may be named after: the record of an identifier, a list or a record (Customer Identifier: Customer),
    // never a basic type of the platform (an index named I of an Integer is no abbreviation of Integer).
    private static string? TypeName(string? type)
    {
        if (string.IsNullOrWhiteSpace(type)) return null;
        var bare = Regex.Replace(type.Trim(), @"\s+(Identifier|List|Record)$", "", RegexOptions.IgnoreCase);
        return DataPreflight.IsBasic(bare) || DataPreflight.IsBasic(type) ? null : type.Trim();
    }

    // The code of an expression without its text literals.
    private static string CodeOf(string expression) => Literal.Replace(expression, " ");

    // The whole name is free in its action: no other element of the action has it. An action's own name is never patched
    // here: the module's actions and the callers in other ops are the base's to judge (FLOW_ACTION_NAME_TAKEN).
    private static bool Free(Judged j, string to) => j.Item != null && !ReferenceEquals(j.Item, j.Action) && !Taken(j, to);

    private static bool Taken(Judged j, string to) => j.Action != null && !ReferenceEquals(j.Item, j.Action)
        && (string.Equals(j.Action.Name, to, StringComparison.OrdinalIgnoreCase)
            || j.Action.Items.Any(i => !ReferenceEquals(i, j.Item) && FlowItem.Keyed(i.Role) && string.Equals(i.Name, to, StringComparison.OrdinalIgnoreCase)));

    /// <summary>The text with one element renamed, or null when that cannot be proved: every use of the name in the text's code
    /// (outside text literals, labels, descriptions, comments and SQL or JavaScript code; never the parameter name of an argument
    /// nor a member after a dot; for a node, never a call of that name), and the text read back must be the action read from
    /// <paramref name="text"/> with that one element renamed (its expressions rewritten as the rename verb rewrites them).</summary>
    internal static string? Renamed(string text, FlowItem action, FlowItem element, string from, string to)
    {
        var node = element.Role == "node";
        var word = new Regex(@"(?<![\w.])" + Regex.Escape(from) + @"(?!\w)" + (node ? @"(?!\s*\()" : ""), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var lines = text.Split('\n');
        for (var n = 0; n < lines.Length; n++)
        {
            var line = lines[n];
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("//", StringComparison.Ordinal) || trimmed.StartsWith('|')) continue;
            var label = LabelStart(line);
            var code = label < 0 ? line : line[..label];
            var rest = label < 0 ? "" : line[label..];
            var built = new System.Text.StringBuilder();
            var at = 0;
            foreach (Match literal in Literal.Matches(code))
            {
                built.Append(Replace(code[at..literal.Index], word, to, code, at)).Append(literal.Value);
                at = literal.Index + literal.Length;
            }
            built.Append(Replace(code[at..], word, to, code, at));
            lines[n] = built + rest;
        }
        var renamed = string.Join("\n", lines);
        if (renamed == text) return null;
        // The proof: the same action, with that one element renamed.
        var expected = action.Clone();
        var target = ReferenceEquals(element, action) ? expected : Find(expected, element);
        if (target == null) return null;
        target.Name = to;
        void Visit(FlowItem item)
        {
            foreach (var (property, value) in item.Props.ToList())
                if (value.Type == 'e') item.Props[property] = new('e', node ? FlowEdits.RenamedNode(value.Text, from, to) : FlowEdits.Renamed(value.Text, from, to));
                else if (value.Type == 'r' && ReferenceEquals(element, action) && string.Equals(value.Text, from, StringComparison.OrdinalIgnoreCase)) item.Props[property] = new('r', to);
            foreach (var child in item.Items) Visit(child);
        }
        Visit(expected);
        try { return ModuleFlow.Read(renamed).Canon() == expected.Canon() ? renamed : null; }
        catch (FormatException) { return null; }
    }

    // One match outside a literal is written unless it is the parameter name of an argument: after "(" or ",", before "=".
    private static string Replace(string piece, Regex word, string to, string code, int offset) => word.Replace(piece, m =>
    {
        var before = code[..(offset + m.Index)].TrimEnd();
        var after = code[(offset + m.Index + m.Length)..];
        return (before.EndsWith('(') || before.EndsWith(',')) && after.StartsWith('=') ? m.Value : to;
    });

    // Where a line's label starts ("  # " outside text literals), or -1.
    private static int LabelStart(string line)
    {
        var inText = false;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '"') inText = !inText;
            else if (!inText && line[i] == '#' && i >= 2 && line[i - 1] == ' ' && line[i - 2] == ' ' && i + 1 < line.Length && line[i + 1] == ' ') return i - 2;
        }
        return -1;
    }

    private static FlowItem? Find(FlowItem root, FlowItem element)
    {
        foreach (var item in root.Items)
        {
            if (item.Role == element.Role && item.Key == element.Key && item.Name == element.Name) return item;
            if (Find(item, element) is { } deeper) return deeper;
        }
        return null;
    }
}
