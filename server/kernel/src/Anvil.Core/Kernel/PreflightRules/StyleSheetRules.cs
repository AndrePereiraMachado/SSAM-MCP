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
/// </summary>
public static class StyleSheetRules
{
    public const string Rewritten = "CSS_REWRITTEN";

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
        return problems;
    }
}
