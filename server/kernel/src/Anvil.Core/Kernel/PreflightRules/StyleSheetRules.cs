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
        for (var i = 0; i < ops.Count; i++)
        {
            if (ops[i] is not JsonObject op || op["op"]?.ToString() != "set" || op["prop"]?.ToString() != "StyleSheet"
                || op["value"] is not JsonValue value || !value.TryGetValue<string>(out var css)) continue;
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
            var pointer = $"/ops/{i}/value";
            JsonArray? Patch() => mechanical == null || mechanical == css ? null : new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = mechanical });
            if (result.Expanded == 0 && result.Problems.Count == 0)
            {
                if (notes.Count == 0) continue;
                problems.Add(new JsonObject
                {
                    ["op"] = i, ["pointer"] = pointer, ["code"] = Rewritten, ["severity"] = "warning",
                    ["message"] = $"set StyleSheet: {string.Join("; ", notes)}",
                    ["fix"] = "write :is(#reactContainer, body) for #reactContainer and the @import statements first (the patch); a theme with Theme Editor CSS gets both at the set (cssRewrites, cssImportsHoisted)",
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
                ["message"] = $"set StyleSheet carries CSS the OutSystems theme does not render: {string.Join("; ", found)}" + (notes.Count > 0 ? "; also " + string.Join("; ", notes) : ""),
                ["fix"] = string.Join("; ", fixes.Distinct()) + (result.Mechanical != null ? "; the patch writes the rendered stylesheet" : ""),
                ["patch"] = result.Mechanical == null ? null : Patch(),
            });
        }
        // The var() warnings come after the errors, and not for an op already refused for CSS the theme does not render: its
        // fix rewrites the very values that read the custom property (a color-mix of var() becomes a literal).
        var refused = problems.Where(p => p["severity"]?.ToString() == "error").Select(p => p["op"]?.GetValue<int>()).ToHashSet();
        problems.AddRange(Undefined(ops).Where(w => !refused.Contains(w["op"]?.GetValue<int>())));
        return problems;
    }

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
