using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// Familias (2026-10-12, VisitaCerta_UI by hand, 20:33): CSS a theme or a screen does not render, with one rendering that
/// looks the same, is written so in place and listed (CSS_FUNCTION_REWRITTEN), never refused: every CSS text of the job
/// (`set StyleSheet`, the data.css of html ops).
/// <list type="bullet">
/// <item>color-mix reading var(--x): the custom property resolved (CssCompat.ResolveMixVars: by its single definition; a
/// property defined in several rules of this stylesheet, such as :root and [data-theme="dark"], gets a derived property next
/// to each definition, so the dark theme keeps its color).</item>
/// <item>color-mix whose color can be computed (both colors literals in srgb, srgb-linear or oklab; or one side transparent,
/// in any space, the other color with its share as alpha, oklch(...) included): that color.</item>
/// <item>light-dark(a, b) in a `set StyleSheet`: the light value and a @media (prefers-color-scheme: dark) block (the html op
/// expands it itself when it compiles its css).</item>
/// </list>
/// What has no single rendering (a color-mix of a property the OutSystems UI tokens or another CSS of the module may define,
/// two properties with several definitions) stays as written: PreflightRules.StyleSheetRules and the html compile refuse it
/// (CSS_FUNCTION_UNSUPPORTED), with every other problem of the job.
/// </summary>
public static class StyleSheetNormalizer
{
    public const string Rule = "CSS_FUNCTION_REWRITTEN";

    public static void Normalize(JsonArray ops, string? prefix, List<JsonObject> done)
    {
        var sheets = PreflightRules.StyleSheetRules.Stylesheets(ops).ToList();
        if (sheets.Count == 0) return;
        foreach (var (op, pointer, css) in sheets)
        {
            try
            {
                if (css.IndexOf("color-mix", StringComparison.OrdinalIgnoreCase) < 0 && css.IndexOf("light-dark", StringComparison.OrdinalIgnoreCase) < 0) continue;
                var others = sheets.Where(s => s.Pointer != pointer).Select(s => s.Css).ToList();
                var raw = pointer.EndsWith("/value", StringComparison.Ordinal);
                var at = prefix == null ? null : prefix + pointer["/ops".Length..];
                // light-dark first (a `set StyleSheet`; the html op expands its own css): a custom property written
                // light-dark(...) is then defined twice, light and dark, and a color-mix that reads it keeps both.
                var (expanded, lightDark) = raw ? CssCompat.ExpandLightDarkValues(css) : (css, 0);
                var (resolved, vars) = CssCompat.ResolveMixVars(expanded, others);
                var (written, rendered) = CssCompat.Render(resolved, expandLightDark: false);
                if (written == css) continue;
                if (lightDark > 0)
                    done.Add(JobNormalizer.Entry(Rule, at, "light-dark(...)", "@media (prefers-color-scheme: dark)",
                        $"the theme does not render light-dark(); {lightDark} value(s): the light value in the rule, the dark one in a @media (prefers-color-scheme: dark) block"));
                // Positions in the stylesheet as sent, or in the one light-dark was expanded in (rewritten whole) when it was.
                var place = lightDark > 0 ? "(light-dark expanded) " : "";
                foreach (var v in vars) done.Add(JobNormalizer.Entry(Rule, at, v.From, v.To, $"{place}line {v.Line} col {v.Column}: the theme does not render color-mix(); {v.Why}"));
                foreach (var r in rendered)
                    done.Add(JobNormalizer.Entry(Rule, at, r.From, r.To, r.Line > 0 ? $"{place}line {r.Line} col {r.Column}: the theme does not render {r.From[..r.From.IndexOf('(')]}(); {r.Why}" : $"the theme does not render light-dark(); {r.Why}"));
                if (ops[op] is not JsonObject holder) continue;
                if (raw) holder["value"] = written;
                else if (holder["data"] is JsonObject data) data["css"] = written;
            }
            catch { /* a normalization never refuses: the checks judge what stays */ }
        }
    }
}
