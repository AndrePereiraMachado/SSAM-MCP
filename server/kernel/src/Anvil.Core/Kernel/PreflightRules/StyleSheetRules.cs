using System.Text.Json.Nodes;

namespace Anvil.Core.PreflightRules;

/// <summary>
/// A raw <c>set StyleSheet</c> with CSS the OutSystems theme does not render (A30 of the atritos 2 package; pluggable preflight
/// rule, interface I1 of the 2026-10-05 package: pure, no I/O, no model). The html op rewrites the same CSS itself
/// (CssCompat in HtmlVisual and HtmlExpander); a raw value cannot be rewritten by a rule, so it is one problem
/// <c>CSS_FUNCTION_UNSUPPORTED</c> per op with what was found and, when every change is mechanical (light-dark expanded into
/// the light value plus a <c>@media (prefers-color-scheme: dark)</c> block, color-mix of literals replaced by the color it
/// computes), the RFC 6902 patch that writes the rendered stylesheet. Pointers are in the <c>{"ops":[...]}</c> form.
/// Two more findings of the atritos 3 package never block (the platform accepts them) and come as one warning
/// <c>CSS_REWRITTEN</c> per op, with the same patch: a selector that starts with <c>#reactContainer</c>, which the Studio canvas
/// does not have (C35), and an <c>@import</c> after a rule, which the browser ignores (C23). In a theme with Theme Editor CSS
/// the kernel applies both at the set (ThemeCss.Recompute) and says so in the result (cssRewrites, cssImportsHoisted).
/// Two guards of the prototype contract (docs/PROTOTIPO-NATIVO.md 4.3, lane css): <c>CSS_VAR_UNDEFINED</c>, a warning per op whose
/// CSS reads <c>var(--x)</c> without a fallback while no CSS of the job defines <c>--x</c> (the custom properties of the
/// OutSystems UI tokens excepted); and <c>CSS_RULES_DROPPED</c> (<see cref="CheckPatched"/>), the CSS of a corrected job that has
/// fewer rules than the same op of the job it corrects (call 88 of 2026-10-10: the first line of a minified stylesheet,
/// 27,632 characters and 271 rules with the 12 custom properties, went away with a line regex, silently).
/// </summary>
public static class StyleSheetRules
{
    public const string Rewritten = "CSS_REWRITTEN";
    public const string VarUndefined = "CSS_VAR_UNDEFINED";
    public const string RulesDropped = "CSS_RULES_DROPPED";

    // The custom properties a theme gets from OutSystems UI and the platform: a var() of one of them is defined outside the job.
    private static readonly string[] PlatformTokens = ["--color-", "--space-", "--font-", "--border-", "--shadow-", "--osui-", "--os-",
        "--header-", "--footer-", "--side-menu-", "--bottom-bar-", "--layout-", "--menu-", "--overlay-", "--z-index-", "--blur-"];

    public static IEnumerable<JsonObject> Check(JsonArray ops, string lane)
    {
        var problems = new List<JsonObject>();
        if (ops == null) return problems;
        // T18: a set StyleSheet and the append of a css op land as written, so both take this check (the same verdict).
        foreach (var (i, pointer, css) in Stylesheets(ops).Where(s => s.Pointer.EndsWith("/value", StringComparison.Ordinal) || s.Pointer.EndsWith("/append", StringComparison.Ordinal)).ToList())
        {
            var label = pointer.EndsWith("/append", StringComparison.Ordinal) ? "css append" : "set StyleSheet";
            CssCompat.Result result;
            IReadOnlyList<CssCompat.Import> hoisted;
            string? mechanical;
            try
            {
                result = CssCompat.Rewrite(css);
                (mechanical, hoisted) = result.Mechanical == null ? (null, CssCompat.HoistImports(css).Hoisted) : CssCompat.HoistImports(result.Mechanical);
            }
            catch (Exception) { continue; }
            var notes = new List<string>();
            if (result.Selectors.Count > 0)
                notes.Add($"{result.Selectors.Count} selector(s) start with #reactContainer, which the Studio canvas does not have, so the blocks render unstyled there "
                    + $"({string.Join(", ", result.Selectors.Take(3).Select(s => $"line {s.Line}: {s.From} -> {s.To}"))}{(result.Selectors.Count > 3 ? ", ..." : "")})");
            if (hoisted.Count > 0)
                notes.Add($"{hoisted.Count} @import after other rules, which the browser ignores ({string.Join(", ", hoisted.Take(3).Select(x => $"line {x.Line}"))}); they belong at the top");
            JsonArray? Patch() => mechanical == null || mechanical == css ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = mechanical });
            if (result.Expanded == 0 && result.Problems.Count == 0)
            {
                if (notes.Count == 0) continue;
                problems.Add(new JsonObject
                {
                    ["op"] = i, ["pointer"] = pointer, ["code"] = Rewritten, ["severity"] = "warning",
                    ["message"] = $"{label}: {string.Join("; ", notes)}",
                    ["fix"] = "write :is(#reactContainer, body) for #reactContainer and the @import statements first (the patch); at the set the kernel moves an @import after a rule up on any stylesheet, and writes a descendant #reactContainer selector so in a theme with Theme Editor CSS (cssImportsHoisted, cssRewrites)",
                    ["patch"] = Patch(),
                });
                continue;
            }
            var found = new List<string>();
            if (result.Expanded > 0) found.Add($"{result.Expanded} light-dark() value(s), which the theme does not render");
            found.AddRange(result.Problems.Select(p => $"{p.Text} at line {p.Line} col {p.Column}"));
            var fixes = new List<string>();
            if (result.Expanded > 0) fixes.Add("write the light value in the rule and the dark one in a @media (prefers-color-scheme: dark) block");
            fixes.AddRange(result.Problems.Select(p => p.Fix));
            problems.Add(new JsonObject
            {
                ["op"] = i, ["pointer"] = pointer, ["code"] = CssCompat.Code, ["severity"] = "error",
                ["message"] = $"{label} carries CSS the OutSystems theme does not render: {string.Join("; ", found)}" + (notes.Count > 0 ? "; also " + string.Join("; ", notes) : ""),
                ["fix"] = string.Join("; ", fixes.Distinct()) + (result.Mechanical != null ? "; the patch writes the rendered stylesheet" : ""),
                ["patch"] = result.Mechanical == null ? null : Patch(),
            });
        }
        // The var() warnings come after the errors, and not for an op already refused for CSS the theme does not render: its
        // fix rewrites the very values that read the custom property (a color-mix of var() becomes a literal).
        var refused = problems.Where(p => p["severity"]?.ToString() == "error").Select(p => p["op"]?.GetValue<int>()).ToHashSet();
        problems.AddRange(Undefined(ops).Where(w => !refused.Contains(w["op"]?.GetValue<int>())));
        problems.AddRange(CssOpShapes(ops));
        problems.AddRange(Hygiene(ops));
        MergePatches(problems, ops);
        return problems;
    }

    /// <summary>T18: one CSS text a job writes, from any path: the op, the pointer of the text, the text, the line of the job
    /// text where it starts (minus one), what writes it, whether the pointer holds exactly this text (a patch can replace it),
    /// whether every offender in it is one the job brings (<see cref="Added"/>: the CSS a css op adds) or may already be in the
    /// element (a whole sheet: judged against it at apply), whether it is CSS of an html op (whose compile refuses #id
    /// selectors itself), and <see cref="Removed"/>, the text the edit takes away (a find/with: its offenders are not new).</summary>
    public sealed record CssText(int Op, string Pointer, string Css, int LineOffset, string Path, bool Whole)
    {
        public bool Added { get; init; }
        public bool Html { get; init; }
        public string? Removed { get; init; }
    }

    private static readonly System.Text.RegularExpressions.Regex StyleElement = new(@"<style\b[^>]*>(?<css>.*?)</style\s*>",
        System.Text.RegularExpressions.RegexOptions.Singleline | System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    // The rule a replaceRule body is judged in: a class nothing else names, so only the body's own offenders count.
    private const string BodyRule = ".t18-edited-rule";

    /// <summary>T18: every CSS text of every write path of a job: <c>set StyleSheet</c> on a theme, screen or block, the
    /// <c>data.css</c> of an html op, each <c>&lt;style&gt;</c> of an html document or fragment, and the CSS a css op adds (an
    /// <c>append</c>, the declarations of a <c>replaceRule</c>, the <c>with</c> of a <c>find</c>). The selector a replaceRule names
    /// is already in the sheet and is not judged again.</summary>
    public static IEnumerable<CssText> Texts(JsonArray ops)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var verb = op["op"]?.ToString();
            if (verb == "set" && op["prop"]?.ToString() == "StyleSheet" && op["value"] is JsonValue value && value.TryGetValue<string>(out var css))
                yield return new(i, $"/ops/{i}/value", css, 0, $"set StyleSheet on {op["target"]}", true);
            else if (verb is "html" or "html-visual")
            {
                if (op["data"]?["css"] is JsonValue data && data.TryGetValue<string>(out var text)) yield return new(i, $"/ops/{i}/data/css", text, 0, "html data.css", true) { Html = true };
                foreach (var (pointer, html) in new[] { ($"/ops/{i}/data/html", op["data"]?["html"]), ($"/ops/{i}/html", op["html"]) })
                {
                    if (html is not JsonValue hv || !hv.TryGetValue<string>(out var document) || document.IndexOf("<style", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    foreach (System.Text.RegularExpressions.Match m in StyleElement.Matches(document))
                        yield return new(i, pointer, m.Groups["css"].Value, CssPipeline.LineAt(document, m.Groups["css"].Index) - 1, "html <style>", false) { Html = true };
                }
            }
            else if (verb == CssEdits.Op && op["edits"] is JsonArray edits)
                for (var j = 0; j < edits.Count; j++)
                {
                    if (edits[j] is not JsonObject edit) continue;
                    if (edit["append"] is JsonValue a && a.TryGetValue<string>(out var add))
                        yield return new(i, $"/ops/{i}/edits/{j}/append", add, 0, $"css append on {op["target"]}", true) { Added = true };
                    else if (edit["replaceRule"] is JsonValue && edit["body"] is JsonValue b && b.TryGetValue<string>(out var body))
                        yield return new(i, $"/ops/{i}/edits/{j}/body", BodyRule + " {\n" + body.Trim() + "\n}", -1, $"css replaceRule on {op["target"]}", false) { Added = true, Removed = BodyRule + " {}" };
                    else if (edit["with"] is JsonValue w && w.TryGetValue<string>(out var with))
                        yield return new(i, $"/ops/{i}/edits/{j}/with", with, 0, $"css find/with on {op["target"]}", false) { Added = true, Removed = edit["find"]?.ToString() ?? "" };
                }
        }
    }

    /// <summary>T18: the hygiene lints (<see cref="CssPipeline.Lint"/>) of every CSS text of the job, the same verdict on every
    /// path: one problem per op, pointer and code, naming every offender of that place with its line (the &lt;style&gt; blocks of
    /// one document included), so no finding hides another. What the job certainly brings (the CSS a css op adds) is judged as
    /// such: an absolute url to an OutSystems environment host there is an error. In a whole sheet the same url may already be in
    /// the element's CSS: a warning here, refused at apply when the element did not have it. Every other code is a warning. A
    /// patch only where the pointer holds the whole text.</summary>
    public static IEnumerable<JsonObject> Hygiene(JsonArray ops)
    {
        var groups = new Dictionary<(int Op, string Pointer, string Code), (CssText Text, List<(CssPipeline.Finding Finding, int Line)> Offenders)>();
        foreach (var text in Texts(ops))
        {
            List<CssPipeline.Finding> findings;
            try
            {
                var context = new CssPipeline.Context(text.Path);
                findings = text.Removed != null ? CssPipeline.Introduced(text.Removed, text.Css, context, idHashes: !text.Html) : CssPipeline.Lint(text.Css, context, idHashes: !text.Html);
            }
            catch (Exception) { continue; }
            foreach (var f in findings)
            {
                var key = (text.Op, text.Pointer, f.Code);
                if (!groups.TryGetValue(key, out var group)) groups[key] = group = (text, []);
                group.Offenders.Add((f, Math.Max(1, f.Line + text.LineOffset)));
            }
        }
        foreach (var ((op, pointer, code), (text, offenders)) in groups)
        {
            var severity = code == CssPipeline.EnvUrl ? (text.Added ? "error" : "warning") : offenders[0].Finding.Severity;
            var findings = offenders.Select(o => o.Finding with { Line = o.Line }).ToList();
            var replaced = code == CssPipeline.EnvUrl && text.Whole ? CssPipeline.WithoutHosts(text.Css, findings) : null;
            var problem = new JsonObject
            {
                ["op"] = op, ["pointer"] = pointer, ["code"] = code, ["severity"] = severity, ["line"] = offenders[0].Line,
                ["message"] = $"{text.Path}: {CssPipeline.Summary(code, findings)}"
                    + (code == CssPipeline.EnvUrl && !text.Added ? "; refused at apply where the element's CSS did not have it" : ""),
                ["fix"] = offenders[0].Finding.Fix,
                ["offenders"] = new JsonArray(offenders.Select(o => (JsonNode)new JsonObject { ["line"] = o.Line, ["subject"] = o.Finding.Subject }).ToArray()),
                ["patch"] = replaced != null && replaced != text.Css ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = replaced }) : null,
            };
            yield return problem;
        }
    }

    /// <summary>T18: two patches of this rule that replace the same whole text (the rendered CSS of CSS_FUNCTION_UNSUPPORTED or
    /// CSS_REWRITTEN, and the urls without their host of CSS_ENV_URL) become one: each problem carries the patch that does both,
    /// so the agent always gets one usable patch for the place.</summary>
    private static void MergePatches(List<JsonObject> problems, JsonArray ops)
    {
        foreach (var group in problems.Where(p => p["patch"] is JsonArray { Count: 1 } a && a[0]?["op"]?.ToString() == "replace")
                     .GroupBy(p => p["patch"]![0]!["path"]!.ToString()).Where(g => g.Select(p => p["patch"]![0]!["value"]?.ToString()).Distinct().Count() > 1))
        {
            var env = group.FirstOrDefault(p => p["code"]?.ToString() == CssPipeline.EnvUrl);
            var rendered = group.FirstOrDefault(p => p["code"]?.ToString() != CssPipeline.EnvUrl)?["patch"]![0]!["value"]?.ToString();
            if (env == null || rendered == null) continue;
            var urls = CssPipeline.Lint(rendered, new("merge")).Where(f => f.Code == CssPipeline.EnvUrl).ToList();
            var combined = CssPipeline.WithoutHosts(rendered, urls);
            foreach (var p in group) p["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = group.Key, ["value"] = combined });
        }
    }
    /// <summary>T18: the shape of every css op, all at once before any build: edits is a non-empty array and each edit has exactly
    /// one action with the keys it takes (CSS_EDIT_INVALID); basedOn, when given, is a sha256 (CSS_BASED_ON_INVALID). A missing
    /// basedOn is said at apply, with the current hash.</summary>
    private static IEnumerable<JsonObject> CssOpShapes(JsonArray ops)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != CssEdits.Op) continue;
            if (op["edits"] is not JsonArray edits || edits.Count == 0)
            {
                yield return Problem(i, $"/ops/{i}/edits", CssEdits.Invalid, "css: edits must be a non-empty array",
                    "write the edits: [{\"append\":\"<css>\"}] | [{\"replaceRule\":\"<selector>\",\"body\":\"<declarations>\"}] | [{\"deleteRule\":\"<selector>\"}] | [{\"find\":\"<text>\",\"with\":\"<text>\"}]");
                continue;
            }
            for (var j = 0; j < edits.Count; j++)
                if ((edits[j] is JsonObject edit ? CssEdits.Shape(edit) : "not an object") is { } wrong)
                    yield return Problem(i, $"/ops/{i}/edits/{j}", CssEdits.Invalid, $"css edit #{j}: {wrong}",
                        "write one of {\"append\":\"<css>\"} | {\"replaceRule\":\"<selector>\",\"body\":\"<declarations>\"} | {\"deleteRule\":\"<selector>\"} | {\"find\":\"<text>\",\"with\":\"<text>\"} (\"in\": the at-rule prelude of a nested rule)");
            if (op["basedOn"] is { } basedOn && !(basedOn is JsonValue v && v.TryGetValue<string>(out var hash) && System.Text.RegularExpressions.Regex.IsMatch(hash.Trim(), "^[0-9a-fA-F]{64}$")))
                yield return Problem(i, $"/ops/{i}/basedOn", "CSS_BASED_ON_INVALID", "css: basedOn must be the sha256 (64 hex digits) of the author CSS",
                    "use the basedOn of the last set StyleSheet or css result on that element, or the one CSS_BASED_ON_MISSING / THEME_CHANGED names");
        }
    }

    private static JsonObject Problem(int op, string pointer, string code, string message, string fix) => new()
    {
        ["op"] = op, ["pointer"] = pointer, ["code"] = code, ["severity"] = "error", ["message"] = message, ["fix"] = fix,
    };

    /// <summary>Every CSS text a job carries, with its RFC 6901 pointer: <c>set StyleSheet</c> values and the <c>data.css</c> of
    /// html and html-visual ops.</summary>
    public static IEnumerable<(int Op, string Pointer, string Css)> Stylesheets(JsonArray ops)
    {
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op) continue;
            var verb = op["op"]?.ToString();
            if (verb == "set" && op["prop"]?.ToString() == "StyleSheet" && op["value"] is JsonValue value && value.TryGetValue<string>(out var css))
                yield return (i, $"/ops/{i}/value", css);
            else if (verb is "html" or "html-visual" && op["data"]?["css"] is JsonValue data && data.TryGetValue<string>(out var text))
                yield return (i, $"/ops/{i}/data/css", text);
            // T18: the CSS a css op appends is a stylesheet text as written (the same normalization as a set StyleSheet).
            else if (verb == CssEdits.Op && op["edits"] is JsonArray edits)
                for (var j = 0; j < edits.Count; j++)
                    if (edits[j]?["append"] is JsonValue add && add.TryGetValue<string>(out var appended))
                        yield return (i, $"/ops/{i}/edits/{j}/append", appended);
        }
    }

    /// <summary><c>CSS_VAR_UNDEFINED</c>: one warning per CSS text with the names it reads by var() (without a fallback) that no
    /// CSS of the job defines, the OutSystems UI tokens excepted. Never blocking: the definition may live in the module theme.</summary>
    private static IEnumerable<JsonObject> Undefined(JsonArray ops)
    {
        var sheets = Stylesheets(ops).ToList();
        if (sheets.Count == 0) yield break;
        var defined = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (_, _, css) in sheets)
            foreach (System.Text.RegularExpressions.Match m in DefinitionPattern.Matches(Uncommented(css))) defined.Add(m.Groups[1].Value);
        foreach (var (op, pointer, css) in sheets)
        {
            var missing = new List<(string Name, int Line)>();
            var text = Uncommented(css);
            foreach (System.Text.RegularExpressions.Match m in UsePattern.Matches(text))
            {
                var name = m.Groups[1].Value;
                if (m.Groups[2].Value == "," || defined.Contains(name) || PlatformTokens.Any(t => name.StartsWith(t, StringComparison.Ordinal))) continue;
                if (missing.All(x => x.Name != name)) missing.Add((name, 1 + text.AsSpan(0, m.Index).Count('\n')));
            }
            if (missing.Count == 0) continue;
            yield return new JsonObject
            {
                ["op"] = op, ["pointer"] = pointer, ["code"] = VarUndefined, ["severity"] = "warning",
                ["message"] = $"the CSS reads {missing.Count} custom propert{(missing.Count == 1 ? "y" : "ies")} no CSS of the job defines: "
                    + string.Join(", ", missing.Select(x => $"var({x.Name}) (line {x.Line})")) + "; the declarations that read them compute to their initial value unless the module theme defines them",
                ["fix"] = "define them (e.g. :root{" + string.Join(";", missing.Take(3).Select(x => x.Name + ":<value>")) + "}) or restore the rules that defined them",
                ["names"] = new JsonArray(missing.Select(x => (JsonNode)x.Name).ToArray()),
            };
        }
    }

    private static readonly System.Text.RegularExpressions.Regex DefinitionPattern = new(@"(?<![\w-])(--[A-Za-z0-9_-]+)\s*:", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex UsePattern = new(@"var\(\s*(--[A-Za-z0-9_-]+)\s*(,|\))", System.Text.RegularExpressions.RegexOptions.Compiled);

    // Comments out (the same length in spaces, so lines keep their numbers).
    private static string Uncommented(string css)
    {
        if (css.IndexOf("/*", StringComparison.Ordinal) < 0) return css;
        var chars = css.ToCharArray();
        for (var i = 0; i + 1 < chars.Length; i++)
        {
            if (chars[i] != '/' || chars[i + 1] != '*') continue;
            var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal);
            var stop = end < 0 ? chars.Length : end + 2;
            for (var k = i; k < stop; k++) if (chars[k] != '\n') chars[k] = ' ';
            i = stop - 1;
        }
        return new string(chars);
    }

    /// <summary><c>CSS_RULES_DROPPED</c>: the corrected job (<paramref name="ops"/>, the job of a patch or a partial job) against the
    /// job it corrects (<paramref name="basedOn"/>, the ops of <c>basedOn</c>): every CSS text at the same pointer of both
    /// (<see cref="Stylesheets"/>) that lost rules by the parser count. One error per op, before any build: how many rules
    /// went, the first selectors that went, the custom properties whose definition went, whether the new text is a suffix of
    /// the old (a cut at the start), and the patch that restores the old text at that pointer (the refusal that led to the
    /// correction names what to change; nothing asked to remove rules). Pure: no model, no I/O; the caller that holds the
    /// base (the facade's job-patch, or a kernel caller with both jobs) runs it.</summary>
    public static IEnumerable<JsonObject> CheckPatched(JsonArray basedOn, JsonArray ops, string lane)
    {
        var before = Stylesheets(basedOn).ToDictionary(x => x.Pointer, x => x.Css, StringComparer.Ordinal);
        foreach (var (op, pointer, css) in Stylesheets(ops))
        {
            if (!before.TryGetValue(pointer, out var old) || old == css) continue;
            var (oldCount, oldRules) = Rules(old);
            var (newCount, newRules) = Rules(css);
            if (newCount >= oldCount) continue;
            var remaining = newRules.GroupBy(r => r).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
            var gone = new List<string>();
            foreach (var rule in oldRules)
            {
                if (remaining.TryGetValue(rule, out var left) && left > 0) { remaining[rule] = left - 1; continue; }
                gone.Add(rule);
            }
            var oldDefined = DefinitionPattern.Matches(Uncommented(old)).Select(m => m.Groups[1].Value).Distinct().ToList();
            var newDefined = DefinitionPattern.Matches(Uncommented(css)).Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
            var lostProperties = oldDefined.Where(d => !newDefined.Contains(d)).ToList();
            var dropped = oldCount - newCount;
            var suffix = old.EndsWith(css, StringComparison.Ordinal) ? $"; the new text is the old one without its first {old.Length - css.Length} characters" : "";
            yield return new JsonObject
            {
                ["op"] = op, ["pointer"] = pointer, ["code"] = RulesDropped, ["severity"] = "error",
                ["message"] = $"the corrected CSS at {pointer} has {newCount} rules, the job it corrects had {oldCount}: {dropped} rule(s) dropped"
                    + (gone.Count > 0 ? " (" + string.Join(", ", gone.Take(5).Select(g => g.Split('{')[0].Trim())) + (gone.Count > 5 ? ", ..." : "") + ")" : "")
                    + (lostProperties.Count > 0 ? $"; {lostProperties.Count} custom propert{(lostProperties.Count == 1 ? "y" : "ies")} lost their definition ({string.Join(", ", lostProperties.Take(12))})" : "")
                    + suffix,
                ["fix"] = "change only what the refusal named; to move @import to the top, keep every rule (the kernel hoists @import itself); the patch restores the CSS of the corrected job",
                ["dropped"] = dropped,
                ["before"] = oldCount,
                ["after"] = newCount,
                ["lostCustomProperties"] = new JsonArray(lostProperties.Select(x => (JsonNode)x).ToArray()),
                ["patch"] = new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = old }),
            };
        }
    }

    // The parser count of the rules of a CSS text (style rules and blocks, inside at-rules too) and each rule as comparable
    // text (enclosing at-rules + selector + declarations). Statements (@import, @charset) are not rules: removing an @import
    // is what a refusal may ask, and the kernel hoists it anyway.
    private static (int Count, List<string> Rules) Rules(string css)
    {
        try
        {
            var sheet = CssStylesheet.Parse(css, lenient: true);
            var rules = sheet.Rules.Select(r => string.Join(" ", r.EnclosingRules) + " " + r.Selector + "{" + string.Join(";", r.Declarations.Select(d => d.Property + ":" + d.Value + (d.Important ? "!important" : ""))) + "}")
                .Concat(sheet.Blocks.Select(b => string.Join(" ", b.EnclosingRules) + " " + b.Prelude + "{" + b.Body + "}")).ToList();
            return (rules.Count, rules);
        }
        catch (InvalidOperationException)
        {
            var all = CssStylesheet.CountRules(css);
            return (all - CssCompat.Imports(css).Imports.Count, []);
        }
    }
}
