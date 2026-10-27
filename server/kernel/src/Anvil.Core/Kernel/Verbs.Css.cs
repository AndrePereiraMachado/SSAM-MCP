using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// T18: the keyed css edit op, <c>{op:"css", target, basedOn, edits:[...]}</c>, on both lanes. It changes the author CSS of a
/// theme, screen or block by rule or by text, without resending the sheet (the Traditional migration sent a theme of 105-111 KB
/// ten times, 34-43 s each, to change 3-20 lines):
/// <list type="bullet">
/// <item><c>basedOn</c>: the sha256 of the author CSS the edits were written against (<see cref="ThemeCss.Sha256"/>; every set of
/// StyleSheet, every css op, the html op's theme parts and the native widgets' CSS say the new one). A stale one is refused
/// THEME_CHANGED with the current hash and which edits still apply to the current text.</item>
/// <item><c>edits</c>, applied in order: <c>{append}</c> (CSS at the end), <c>{replaceRule: selector, body}</c> (the declarations
/// of that rule, in place), <c>{deleteRule: selector}</c>, <c>{find, with}</c> (one exact occurrence). A rule inside an at-rule is
/// named with <c>in</c> (its exact prelude, e.g. "@media (max-width: 767px)"); a selector written in several rules is named
/// with <c>nth</c> (1-based, in the order of the text). A rule never moves: the cascade keeps its order.</item>
/// </list>
/// Every problem of the op is one refusal (CSS_EDIT_REFUSED with each problem); a sheet whose braces do not balance is refused
/// before any edit. The result goes through the one write path (ThemeCss.WriteAuthor and its normalization), so F1's stylesheet
/// touch and served proof see it as any other stylesheet write. Its hygiene findings are judged against the sheet as it was:
/// only an offender the edits bring counts, and only an absolute url to an OutSystems environment host is an error.
/// </summary>
public sealed partial class ModelSession
{
    public const string ThemeChanged = "THEME_CHANGED";

    private JsonNode Css(JsonObject op)
    {
        var reference = Req(op, "target");
        var target = Resolve(reference);
        var at = "";   // pointers relative to the op: the job runner places them under /ops/<i>
        var current = ThemeCss.AuthorOf(target)
            ?? throw new KernelRefusalException(CssEdits.NoStyleSheet, $"css: {Describe(target)} has no stylesheet of its own (a theme, a screen or a block has one)",
                new JsonArray(JobPreflight.PublicProblem(JobPreflight.Problem(null, at + "/target", CssEdits.NoStyleSheet, "error",
                    $"{Describe(target)} has no stylesheet", "name a theme, a screen or a block (IMobileTheme:<Name>, IWebBlock:<Name>, ...)"))));
        var edits = op["edits"] as JsonArray ?? throw new InvalidOperationException("css: edits must be an array of {append} | {replaceRule, body} | {deleteRule} | {find, with}");
        var plan = CssEdits.Apply(current, edits, at);
        var basedOn = op["basedOn"]?.ToString();
        var actual = ThemeCss.Sha256(current);
        if (!ThemeCss.Matches(basedOn, current))
        {
            var missing = string.IsNullOrWhiteSpace(basedOn);
            var code = missing ? CssEdits.BasedOnMissing : ThemeChanged;
            var problem = JobPreflight.Problem(null, at + "/basedOn", code, "error",
                (missing ? $"css: basedOn is required, the sha256 of the author CSS of {Describe(target)} the edits were written against (now {actual}, {current.Length} chars); "
                    : $"css: the author CSS of {Describe(target)} is not the one basedOn names (basedOn {Short(basedOn)}, now {actual}, {current.Length} chars); ")
                + $"on the current text {plan.Applied.Count(a => a["applied"]?.GetValue<bool>() == true)} of {edits.Count} edit(s) apply"
                + (plan.Problems.Count > 0 ? " and " + string.Join("; ", plan.Problems.Select(p => p["message"]?.ToString())) : ""),
                missing ? $"add basedOn {actual} when the edits were written against the stylesheet as it is now (get {reference})"
                    : $"read the stylesheet again (get {reference}) and write the edits against it with basedOn {actual}",
                new JsonArray(new JsonObject { ["op"] = missing ? "add" : "replace", ["path"] = at + "/basedOn", ["value"] = actual }));
            problem["expected"] = basedOn; problem["actual"] = actual;
            problem["edits"] = new JsonArray(plan.Applied.Select(a => (JsonNode)a.DeepClone()).ToArray());
            throw new KernelRefusalException(code, problem["message"]!.ToString(), new JsonArray(JobPreflight.PublicProblem(problem)));
        }
        // The hygiene verdict: only what the edits bring (by offender, as many times as it is new). An absolute url to an
        // OutSystems environment host the edits bring refuses with the edit problems; the other findings they bring are notes.
        List<CssPipeline.Finding> lints = plan.Unbalanced ? [] : CssPipeline.Introduced(current, plan.Css, new("css " + reference));
        var errors = lints.Where(f => f.Severity == "error").ToList();
        if (errors.Count > 0)
            plan.Problems.Add(JobPreflight.Problem(null, at + "/edits", CssPipeline.EnvUrl, "error",
                $"css {reference}: the edits bring {CssPipeline.Summary(CssPipeline.EnvUrl, errors)}", errors[0].Fix));
        if (plan.Problems.Count > 0)
            throw new KernelRefusalException(CssEdits.Refused, $"css: {plan.Problems.Count} problem(s) in the edits of {Describe(target)}: " + string.Join("; ", plan.Problems.Select(p => p["message"]?.ToString())),
                new JsonArray(plan.Problems.Select(p => (JsonNode)JobPreflight.PublicProblem(p)).ToArray()));
        ThemeCss.Write(target, plan.Css);
        ThemeWritten(target);
        var written = ThemeCss.AuthorOf(target) ?? plan.Css;
        foreach (var group in lints.GroupBy(f => f.Code))
            Note(group.Key, $"css {reference}: the edits bring {CssPipeline.Summary(group.Key, group.ToList())}. Fix: {group.First().Fix}");
        var result = new JsonObject
        {
            ["css"] = TypeResolver.Name(target), ["basedOn"] = ThemeCss.Sha256(written), ["was"] = actual,
            ["chars"] = written.Length, ["charsBefore"] = current.Length,
            ["edits"] = new JsonArray(plan.Applied.Select(a => (JsonNode)a.DeepClone()).ToArray()),
        };
        if (ThemeCss.Of(target) is { } sheet && ThemeCss.Changed(sheet) is { } change)
            foreach (var (key, value) in change) result[key] = value?.DeepClone();
        if (lints.Count > 0) result["lints"] = new JsonArray(lints.Select(f => (JsonNode)new JsonObject { ["code"] = f.Code, ["severity"] = f.Severity, ["line"] = f.Line, ["subject"] = f.Subject }).ToArray());
        return result;
    }

    /// <summary>The set verb's half of the rule, before the write: the author CSS the set replaces; a <c>basedOn</c> that does not
    /// name it is refused THEME_CHANGED (the same check as the css op).</summary>
    private string? StyleSheetBefore(object target, JsonNode? basedOnNode, JsonObject op)
    {
        var current = ThemeCss.AuthorOf(target);
        if (current == null || basedOnNode is not JsonValue given || !given.TryGetValue<string>(out var basedOn)) return current;
        if (ThemeCss.Matches(basedOn, current)) return current;
        var at = "";
        var actual = ThemeCss.Sha256(current);
        var problem = JobPreflight.Problem(null, at + "/basedOn", ThemeChanged, "error",
            $"set StyleSheet: the author CSS of {Describe(target)} is not the one basedOn names (basedOn {Short(basedOn)}, now {actual}, {current.Length} chars): the set would replace a text it did not read",
            $"read the stylesheet again (get {op["target"]}) and write the change against it with basedOn {actual}, or change it by rule with the css op",
            new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = at + "/basedOn", ["value"] = actual }));
        problem["expected"] = basedOn; problem["actual"] = actual;
        throw new KernelRefusalException(ThemeChanged, problem["message"]!.ToString(), new JsonArray(JobPreflight.PublicProblem(problem)));
    }

    /// <summary>The set verb's half of the rule, after the write: an absolute url to an OutSystems environment host the set brings
    /// (one the element's CSS did not have) is refused with the patch of the value; the stylesheet settles through the one
    /// normalization; the result says where the text landed in a theme with Theme Editor CSS, what the normalization changed and
    /// the new <c>basedOn</c>. A set that replaced author CSS without basedOn is noted (CSS_SET_WHOLE): the css op changes one rule.</summary>
    private JsonObject StyleSheetSettled(object target, ServiceStudio.Model.WebStyleSheet sheet, string? before, string? sent, JsonObject op)
    {
        if (ThemeCss.Introduced(before, ThemeCss.Author(sheet), $"set StyleSheet on {Describe(target)}", "/value", sent) is { } refusal) throw refusal;
        ThemeCss.Settle(sheet, canvas: ThemeCss.Reactive(target));
        var landing = ThemeCss.IsSplit(sheet) ? ThemeCss.Landing(sheet) : new JsonObject();
        if (!ThemeCss.IsSplit(sheet) && ThemeCss.Changed(sheet) is { } change)
            foreach (var (key, value) in change) landing[key] = value?.DeepClone();
        var author = ThemeCss.Author(sheet);
        landing["basedOn"] = ThemeCss.Sha256(author);
        if (op["basedOn"] == null && !string.IsNullOrWhiteSpace(before) && before != author)
            Note("CSS_SET_WHOLE", $"set StyleSheet on {Describe(target)} replaced {before!.Length} chars of author CSS with {author.Length}: to change a rule, the css op edits it alone "
                + $"({{\"op\":\"css\",\"target\":\"{op["target"]}\",\"basedOn\":\"{landing["basedOn"]}\",\"edits\":[{{\"replaceRule\":\"<selector>\",\"body\":\"<declarations>\"}}]}})");
        return landing;
    }

    private static string Short(string? hash) => string.IsNullOrWhiteSpace(hash) ? "(none)" : hash.Length > 12 ? hash[..12] + "…" : hash;
}

/// <summary>The edit engine of the css op, pure (no model): the same text in gives the same text out.</summary>
public static class CssEdits
{
    public const string Op = "css";
    public const string Refused = "CSS_EDIT_REFUSED";
    public const string NotFound = "CSS_RULE_NOT_FOUND";
    public const string Ambiguous = "CSS_RULE_AMBIGUOUS";
    public const string Nested = "CSS_RULE_NESTED";
    public const string Unbalanced = "CSS_SHEET_UNBALANCED";
    public const string FindNotFound = "CSS_FIND_NOT_FOUND";
    public const string FindAmbiguous = "CSS_FIND_AMBIGUOUS";
    public const string Invalid = "CSS_EDIT_INVALID";
    public const string NoStyleSheet = "CSS_TARGET_WITHOUT_STYLESHEET";
    public const string BasedOnMissing = "CSS_BASED_ON_MISSING";

    /// <summary>The registration point of the op (the Verbs.cs dispatch line and the VerbSurface table): the verb and its shape.</summary>
    public static VerbSurface.VerbShape Verb { get; } = new(Op, "write", ["target", "edits"], ["basedOn"],
        "Edits the author CSS of a theme, screen or block without resending it: basedOn (required) is the sha256 of that CSS (every StyleSheet write returns it; CSS_BASED_ON_MISSING or THEME_CHANGED say the current one); edits in order: {append} | {replaceRule: selector, body, in?, nth?} (in place) | {deleteRule: selector, in?, nth?} | {find, with} (one occurrence). One refusal for every problem.");

    /// <summary>The contract of the op (api --op css).</summary>
    public static JsonObject Schema() => new()
    {
        ["op"] = Op,
        ["keys"] = new JsonArray("target", "basedOn", "edits"),
        ["edits"] = new JsonObject
        {
            ["append"] = "CSS written at the end of the author CSS",
            ["replaceRule"] = "the selector list of one rule, as written (comments and spaces aside); with body (its declarations), in (the exact prelude of the at-rule that holds it) and nth (which one, 1-based, when the selector is written in several rules); the rule keeps its place",
            ["deleteRule"] = "the selector list of the rule to remove, with in and nth as for replaceRule; an at-rule block it leaves empty goes too",
            ["find"] = "a text that occurs exactly once, with with (its replacement; \"\" removes it)",
        },
        ["basedOn"] = "sha256 (lowercase hex) of the author CSS (UserStyleSheet in a theme with Theme Editor CSS, StyleSheet otherwise) as read",
        ["codes"] = new JsonArray(BasedOnMissing, ModelSession.ThemeChanged, Refused, NotFound, Ambiguous, Nested, Unbalanced, FindNotFound, FindAmbiguous, Invalid, NoStyleSheet, CssPipeline.EnvUrl),
        ["rules"] = "Edits apply in order on the author CSS; a rule never moves; nested rules (&) are edited with find/with; every problem comes in one refusal; the result is written through the one normalization of every stylesheet write and only the hygiene findings the edits bring are reported (an absolute url to an OutSystems environment host is refused).",
    };

    public sealed record Plan(string Css, List<JsonObject> Applied, List<JsonObject> Problems)
    {
        public bool Unbalanced { get; init; }
    }

    /// <summary>One style rule of the text: its at-rule context, its selector as written and as compared, its span, whether its
    /// block holds nested rules, and the at-rule block that holds it (to remove when an edit empties it).</summary>
    public sealed record RuleSpan(string? Context, string Selector, string Normal, int Start, int End, int Line)
    {
        public bool HasNested { get; init; }
        public Block? Parent { get; init; }
    }

    /// <summary>An at-rule block: from its prelude to its closing brace, and the text between its braces.</summary>
    public sealed record Block(int Start, int End, int InnerStart, int InnerEnd, Block? Parent);

    /// <summary>The edits in order on <paramref name="css"/>: the text they give, what each did and every problem (pointers under
    /// <paramref name="at"/>, the op's own pointer). A sheet whose braces, strings or comments do not close is refused before any
    /// edit (never partly rewritten).</summary>
    public static Plan Apply(string css, JsonArray edits, string at = "")
    {
        var text = css ?? "";
        var applied = new List<JsonObject>();
        var problems = new List<JsonObject>();
        if (BalanceProblem(text) is { } unbalanced)
        {
            problems.Add(JobPreflight.Problem(null, at + "/basedOn", Unbalanced, "error",
                $"css: the author CSS does not balance ({unbalanced}): no edit is applied to it, so nothing of it is lost",
                "repair the stylesheet whole once (set StyleSheet with basedOn), then edit it by rule"));
            return new Plan(text, edits.Select((_, j) => new JsonObject { ["edit"] = j, ["applied"] = false }).ToList(), problems) { Unbalanced = true };
        }
        for (var j = 0; j < edits.Count; j++)
        {
            var pointer = $"{at}/edits/{j}";
            if (edits[j] is not JsonObject edit || Shape(edit) is { } wrong)
            {
                problems.Add(JobPreflight.Problem(null, pointer, Invalid, "error", $"edit #{j}: {(edits[j] is JsonObject ? Shape((JsonObject)edits[j]!) : "not an object")}",
                    "write one of {\"append\":\"<css>\"} | {\"replaceRule\":\"<selector>\",\"body\":\"<declarations>\"} | {\"deleteRule\":\"<selector>\"} | {\"find\":\"<text>\",\"with\":\"<text>\"} (\"in\": the at-rule prelude of a nested rule; \"nth\": which rule of a selector written more than once)"));
                applied.Add(new JsonObject { ["edit"] = j, ["applied"] = false });
                continue;
            }
            var (next, entry, problem) = One(text, edit, j, pointer);
            if (problem != null) problems.Add(problem);
            else text = next;
            entry["applied"] = problem == null;
            applied.Add(entry);
        }
        return new Plan(text, applied, problems);
    }

    /// <summary>Why an edit object is malformed, or null when it has exactly one action and the keys that action takes.</summary>
    public static string? Shape(JsonObject edit)
    {
        var keys = edit.Select(p => p.Key).Where(k => !k.StartsWith('_')).ToList();
        string[] actions = ["append", "replaceRule", "deleteRule", "find"];
        var present = actions.Where(keys.Contains).ToList();
        if (present.Count != 1) return present.Count == 0 ? "no action (append, replaceRule, deleteRule or find)" : $"more than one action ({string.Join(", ", present)})";
        string[] allowed = present[0] switch
        {
            "append" => ["append"],
            "replaceRule" => ["replaceRule", "body", "in", "nth"],
            "deleteRule" => ["deleteRule", "in", "nth"],
            _ => ["find", "with"],
        };
        var unknown = keys.Where(k => !allowed.Contains(k)).ToList();
        if (unknown.Count > 0) return $"{present[0]}: unknown key(s) {string.Join(", ", unknown)}; it takes {string.Join(", ", allowed)}";
        foreach (var key in keys.Where(k => k != "nth")) if (edit[key] is not JsonValue v || !v.TryGetValue<string>(out _)) return $"{key} must be a text";
        if (keys.Contains("nth") && !(edit["nth"] is JsonValue n && n.TryGetValue<int>(out var nth) && nth >= 1)) return "nth must be a whole number from 1 (which rule of the selector, in the order of the text)";
        if (present[0] == "replaceRule" && !keys.Contains("body")) return "replaceRule needs body (the declarations of the rule)";
        if (present[0] == "find" && !keys.Contains("with")) return "find needs with (the text that replaces it; \"\" removes it)";
        if (present[0] is "replaceRule" or "deleteRule" && string.IsNullOrWhiteSpace(edit[present[0]]!.ToString())) return $"{present[0]} needs a selector";
        if (present[0] is "replaceRule" or "deleteRule" && edit[present[0]]!.ToString().Contains('&'))
            return $"{present[0]}: {edit[present[0]]} is a nested rule (&): the css op edits top-level and at-rule rules by selector; a nested rule is edited with find/with";
        if (present[0] == "replaceRule" && edit["body"]!.ToString().Contains('{'))
            return "replaceRule: body holds a block ({...}); it takes the declarations of the rule only";
        if (present[0] == "find" && edit["find"]!.ToString().Length == 0) return "find needs a text";
        return null;
    }

    private static (string Css, JsonObject Entry, JsonObject? Problem) One(string css, JsonObject edit, int j, string pointer)
    {
        if (edit["append"] is { } appendNode)
        {
            var add = appendNode.ToString().Trim();
            var head = css.TrimEnd();
            var written = head.Length == 0 ? add + "\n" : head + "\n" + add + "\n";
            if (BalanceProblem(add) is { } open)
                return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/append", Invalid, "error", $"edit #{j}: append does not balance ({open})", "close every brace, string and comment of the CSS it appends"));
            return (written, new JsonObject { ["edit"] = j, ["append"] = add.Length, ["line"] = CssPipeline.LineAt(written, head.Length + 1) }, null);
        }
        if (edit["find"] is { } findNode)
        {
            var find = findNode.ToString();
            var with = edit["with"]!.ToString();
            var first = css.IndexOf(find, StringComparison.Ordinal);
            if (first < 0)
            {
                var spaced = Regex.Replace(find.Trim(), @"\s+", " ");
                var hint = spaced.Length > 0 && Regex.Replace(css, @"\s+", " ").Contains(spaced, StringComparison.Ordinal) ? " (it is there with other spacing or line breaks: copy it from the text as read)" : "";
                return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/find", FindNotFound, "error",
                    $"edit #{j}: find does not occur in the author CSS{hint}: {Clip(find)}", "copy the text exactly from the stylesheet as read (get), or edit by rule ({\"replaceRule\":\"<selector>\",\"body\":\"...\"})"));
            }
            var lines = new List<int>();
            for (var i = first; i >= 0; i = css.IndexOf(find, i + 1, StringComparison.Ordinal)) lines.Add(CssPipeline.LineAt(css, i));
            if (lines.Count > 1)
                return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/find", FindAmbiguous, "error",
                    $"edit #{j}: find occurs {lines.Count} times (lines {string.Join(", ", lines.Take(8))}): {Clip(find)}", "make find longer so it occurs once (include the selector of its rule), or edit by rule with nth"));
            var replaced = css[..first] + with + css[(first + find.Length)..];
            if (BalanceProblem(replaced) is { } broken)
                return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/with", Invalid, "error", $"edit #{j}: the text after find/with does not balance ({broken})", "keep every brace, string and comment of the rule closed in with"));
            return (replaced, new JsonObject { ["edit"] = j, ["line"] = lines[0] }, null);
        }
        var replace = edit["replaceRule"] != null;
        var key = replace ? "replaceRule" : "deleteRule";
        var selector = edit[key]!.ToString().Trim();
        var context = edit["in"]?.ToString() is { Length: > 0 } inside ? ContextKey(inside) : null;
        int? nth = edit["nth"] is JsonValue nv && nv.TryGetValue<int>(out var n) ? n : null;
        var spans = Rules(css);
        var normal = CssPipeline.Normal(selector);
        var matches = spans.Where(r => r.Normal == normal && r.Context == context).ToList();
        if (matches.Count == 0)
        {
            var classes = CssStylesheet.Classes(selector).ToHashSet(StringComparer.Ordinal);
            var near = spans.Where(r => r.Normal == normal || classes.Count > 0 && CssStylesheet.Classes(r.Selector).Any(classes.Contains)).Take(5)
                .Select(r => (r.Context != null ? r.Context + " " : "") + Clip(r.Selector, 80) + $" (line {r.Line})").ToList();
            var fix = replace ? $"append it instead ({{\"append\":\"{selector}{{...}}\"}}), or name the rule as written (selector list and in)" : "name the rule as written (selector list and in)";
            return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/" + key, NotFound, "error",
                $"edit #{j}: no rule {Clip(selector, 80)}{(context != null ? " in " + context : " at the top level")} in the author CSS" + (near.Count > 0 ? "; rules near it: " + string.Join(", ", near) : ""), fix));
        }
        if (nth is int k && k > matches.Count)
            return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/nth", NotFound, "error",
                $"edit #{j}: {Clip(selector, 80)} is written in {matches.Count} rule(s) (lines {string.Join(", ", matches.Select(m => m.Line))}); there is no rule {k}", $"nth from 1 to {matches.Count}"));
        if (matches.Count > 1 && nth == null)
            return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/" + key, Ambiguous, "error",
                $"edit #{j}: {Clip(selector, 80)} is written in {matches.Count} rules (lines {string.Join(", ", matches.Select(m => m.Line))}): an edit by selector would move or merge them and change the cascade",
                $"name the one to {(replace ? "replace" : "delete")} with nth (1 to {matches.Count}, in the order of the text)"));
        var rule = matches[(nth ?? 1) - 1];
        if (replace && rule.HasNested)
            return (css, new JsonObject { ["edit"] = j }, JobPreflight.Problem(null, pointer + "/" + key, Nested, "error",
                $"edit #{j}: the rule {Clip(selector, 80)} at line {rule.Line} holds nested rules: replacing its body would drop them", "edit it with find/with, which keeps what it does not name"));
        var sb = new StringBuilder(css);
        var entry = new JsonObject { ["edit"] = j, ["line"] = rule.Line };
        if (replace)
        {
            // The declarations of the rule in place: its selector as written, its position, the other rules untouched.
            var brace = IndexOfBlock(css, rule.Start, rule.End);
            var body = edit["body"]!.ToString().Trim();
            sb.Remove(brace + 1, rule.End - 1 - (brace + 1)).Insert(brace + 1, " " + body + " ");
            entry["replaced"] = 1;
        }
        else
        {
            var (start, end) = (rule.Start, rule.End);
            if (end < sb.Length && sb[end] == '\r') end++;
            if (end < sb.Length && sb[end] == '\n') end++;
            // An at-rule block the deletion leaves empty goes too (and the one that holds it, when that is left empty as well).
            for (var block = rule.Parent; block != null; block = block.Parent)
            {
                var inner = css[block.InnerStart..start] + css[end..block.InnerEnd];
                if (CssPipeline.Uncommented(inner).Trim().Length > 0) break;
                (start, end) = (block.Start, block.End);
                if (end < css.Length && css[end] == '\r') end++;
                if (end < css.Length && css[end] == '\n') end++;
                entry["blocksRemoved"] = (entry["blocksRemoved"]?.GetValue<int>() ?? 0) + 1;
            }
            sb.Remove(start, end - start);
            entry["deleted"] = 1;
            if (rule.HasNested) entry["nestedRulesDeleted"] = true;
        }
        return (sb.ToString(), entry, null);
    }

    /// <summary>Every style rule of the text with its span (from its selector to its closing brace), inside @media, @supports,
    /// @container, @layer and @document blocks too (their exact prelude is the context). Comments, strings and nested braces are
    /// walked; a text it cannot walk gives the rules found up to there.</summary>
    public static List<RuleSpan> Rules(string css)
    {
        var rules = new List<RuleSpan>();
        try { Walk(css, 0, css.Length, null, null, rules); } catch (Exception) { }
        return rules;
    }

    private static void Walk(string css, int i, int end, string? context, Block? parent, List<RuleSpan> rules)
    {
        while (i < end)
        {
            i = Trivia(css, i, end);
            if (i >= end) return;
            if (css[i] == '}') { i++; continue; }
            var start = i;
            var stop = PreludeEnd(css, i, end);
            if (stop >= end) return;
            if (css[stop] == ';') { i = stop + 1; continue; }
            if (css[stop] == '}') { i = stop + 1; continue; }
            var close = BlockEnd(css, stop + 1, end);
            var prelude = CssPipeline.Uncommented(css[start..stop]).Trim();
            if (prelude.StartsWith('@'))
            {
                if (Regex.IsMatch(prelude, @"^@(media|supports|container|layer|document)\b", RegexOptions.IgnoreCase))
                    Walk(css, stop + 1, close - 1, (context != null ? context + " " : "") + ContextKey(prelude), new Block(start, close, stop + 1, close - 1, parent), rules);
            }
            else rules.Add(new RuleSpan(context, prelude, CssPipeline.Normal(prelude), start, close, CssPipeline.LineAt(css, start))
            { HasNested = HoldsBlock(css, stop + 1, close - 1), Parent = parent });
            i = close;
        }
    }

    // Whether the text between from and to opens a block (a nested rule), outside comments and strings.
    private static bool HoldsBlock(string css, int from, int to)
    {
        for (var i = from; i < to; i++)
        {
            var c = css[i];
            if (c == '/' && i + 1 < to && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? to : close + 1; continue; }
            if (c is '"' or '\'') { i = StringEnd(css, i, to) - 1; continue; }
            if (c == '{') return true;
        }
        return false;
    }

    // The '{' that opens the block of the rule at start.
    private static int IndexOfBlock(string css, int start, int end) => PreludeEnd(css, start, end);

    /// <summary>Why a text does not balance (an unclosed brace, string or comment, a stray '}'), with its line; null when it does.</summary>
    public static string? BalanceProblem(string css)
    {
        var depth = 0; var opened = new Stack<int>();
        for (var i = 0; i < css.Length; i++)
        {
            var c = css[i];
            if (c == '/' && i + 1 < css.Length && css[i + 1] == '*')
            {
                var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (close < 0) return $"a comment opened at line {CssPipeline.LineAt(css, i)} does not close";
                i = close + 1; continue;
            }
            if (c is '"' or '\'')
            {
                var k = i + 1;
                while (k < css.Length && css[k] != c && css[k] != '\n') k += css[k] == '\\' ? 2 : 1;
                if (k >= css.Length || css[k] != c) return $"a string opened at line {CssPipeline.LineAt(css, i)} does not close";
                i = k; continue;
            }
            if (c == '{') { depth++; opened.Push(i); }
            else if (c == '}') { if (--depth < 0) return $"a '}}' at line {CssPipeline.LineAt(css, i)} closes nothing"; opened.Pop(); }
        }
        return depth > 0 ? $"a '{{' opened at line {CssPipeline.LineAt(css, opened.Peek())} does not close" : null;
    }

    private static int Trivia(string css, int i, int end)
    {
        while (i < end)
        {
            if (char.IsWhiteSpace(css[i]) || css[i] == '﻿') { i++; continue; }
            if (css[i] == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
            break;
        }
        return i;
    }

    // The index of the '{', ';' or '}' that ends a prelude (outside strings, parentheses, brackets and comments).
    private static int PreludeEnd(string css, int i, int end)
    {
        var depth = 0;
        while (i < end)
        {
            var c = css[i];
            if (c == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
            if (c is '"' or '\'') { i = StringEnd(css, i, end); continue; }
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (depth <= 0 && c is '{' or ';' or '}') return i;
            i++;
        }
        return end;
    }

    // The index after the '}' that closes the block whose content starts at i.
    private static int BlockEnd(string css, int i, int end)
    {
        var depth = 0;
        while (i < end)
        {
            var c = css[i];
            if (c == '/' && i + 1 < end && css[i + 1] == '*') { var close = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = close < 0 ? end : close + 2; continue; }
            if (c is '"' or '\'') { i = StringEnd(css, i, end); continue; }
            if (c == '{') depth++;
            else if (c == '}') { if (depth == 0) return i + 1; depth--; }
            i++;
        }
        return end;
    }

    private static int StringEnd(string css, int i, int end)
    {
        var quote = css[i++];
        while (i < end && css[i] != quote) i += css[i] == '\\' ? 2 : 1;
        return Math.Min(i + 1, end);
    }

    private static string Collapse(string text) => Regex.Replace(text, @"\s+", " ").Trim();
    // An at-rule prelude compared as the browser reads it: spaces collapsed, none around : ( ) and commas.
    private static string ContextKey(string prelude) => Regex.Replace(Collapse(CssPipeline.Uncommented(prelude)), @"\s*([:(),])\s*", "$1").Replace("@media(", "@media (").Replace("@supports(", "@supports (").Replace("@container(", "@container (");
    private static string Clip(string text, int max = 120) { var one = Collapse(text); return one.Length > max ? one[..(max - 1)] + "…" : one; }
}
