using System.Text;
using System.Text.RegularExpressions;
using Anvil.Reading;

namespace Anvil.Core;

/// <summary>
/// The space a parent puts between its items, read one way (CX17 review 2, M5): the gutter decision of F3 asks it, and nothing
/// else reads a gap. Per axis (the column gap spaces items side by side, the row gap the lines), per condition (the rules without
/// one decide; a @media or @supports block under which the parent spaces its items otherwise is said, never assumed), by the
/// cascade (importance, the style attribute, specificity, then order: the declaration that wins prevails, gap or its longhand),
/// over OutSystems UI's layout utilities (a table taken from the fixture), the module theme and the page.
/// </summary>
public static partial class ScreenVisual
{
    // ---- OutSystems UI 2.28.1: the layout utilities ---------------------------------------------------------------------------

    private static readonly string[] SpaceSizes = ["xs", "s", "base", "m", "l", "xl", "xxl"];

    /// <summary>The layout utilities of OutSystems UI 2.28.1 as the theme of the fixture outsystems-ui.oml writes them (sections
    /// 7.16 Display and 7.17 Display - Flex: display-*, gap-*, row-gap-*, column-gap-*; the vendor-prefixed declarations left
    /// out) and the space tokens of its :root (--space-none 0 to --space-xxl 48px). A test compares every rule with the fixture.</summary>
    public static readonly string OutSystemsUiLayoutCss = BuildOutSystemsUiLayoutCss();

    private static string BuildOutSystemsUiLayoutCss()
    {
        var sb = new StringBuilder(":root{--space-none:0;--space-xs:4px;--space-s:8px;--space-base:16px;--space-m:24px;--space-l:32px;--space-xl:40px;--space-xxl:48px}\n");
        foreach (var display in new[] { "none", "block", "contents", "inline", "inline-block", "inline-flex", "grid", "flex" })
            sb.Append(".display-").Append(display).Append("{display:").Append(display).Append("}\n");
        foreach (var property in new[] { "gap", "row-gap", "column-gap" })
            foreach (var size in SpaceSizes)
                sb.Append('.').Append(property).Append('-').Append(size).Append('{').Append(property).Append(":var(--space-").Append(size).Append(")}\n");
        return sb.ToString();
    }

    // ---- the reading ------------------------------------------------------------------------------------------------------------

    /// <summary>The spacing of a parent under one set of rules: its display, its column gap (between items side by side) and its
    /// row gap (between lines), each the value of the declaration that wins with its var() read, and where the column gap comes
    /// from.</summary>
    public sealed record AxisSpacing(string? Display, string? ColumnGap, string? RowGap, string? ColumnGapFrom)
    {
        /// <summary>A flex or grid parent.</summary>
        public bool Layout => IsLayoutDisplay(Display);
        /// <summary>Its items side by side have a gap between them: a flex or grid parent whose column gap is not zero.</summary>
        public bool Horizontal => Layout && ColumnGap != null && !IsZeroLength(ColumnGap);
        /// <summary>The words of a note: display, column gap and where it comes from.</summary>
        public string Describe() => $"display {Display ?? "not flex or grid"}, column-gap {ColumnGap ?? "none"}" + (ColumnGapFrom != null ? " from " + ColumnGapFrom : "");
    }

    /// <summary>A parent's spacing: what the rules without a condition give (the decision), and each condition (its @media or
    /// @supports text) under which the parent spaces its items side by side otherwise.</summary>
    public sealed record Spacing(AxisSpacing Always, IReadOnlyList<(string Condition, AxisSpacing There)> Conditional);

    /// <summary>The CSS texts that reach a page, in the order of the cascade (OutSystems UI, the theme, the page), parsed once;
    /// <see cref="Of"/> reads one parent. Only the rules that set display, a gap or a custom property are kept.</summary>
    public sealed class SpacingReader
    {
        private sealed record Rule(CssRule Css, int Order, string Where, string Condition, List<(ComplexSelector Complex, (int A, int B, int C) Specificity)> Selectors);
        private readonly List<Rule> rules = [];
        private readonly Dictionary<string, string> tokens = new(StringComparer.Ordinal);

        public SpacingReader(IEnumerable<(string Where, string? Css)> sheets)
        {
            var order = 0;
            foreach (var (where, css) in sheets)
                foreach (var rule in RulesOf([css]))
                {
                    order++;
                    var condition = string.Join(" ", rule.EnclosingRules.Where(e => !e.StartsWith("@layer", StringComparison.OrdinalIgnoreCase)));
                    // The custom properties of :root and html (without a condition), the last one wins: var() reads them.
                    if (condition.Length == 0 && CssStylesheet.SplitSelectors(rule.Selector).Select(x => x.Trim()).All(x => x is ":root" or "html"))
                        foreach (var d in rule.Declarations.Where(d => d.Property.StartsWith("--", StringComparison.Ordinal))) tokens[d.Property] = d.Value.Trim();
                    if (!rule.Declarations.Any(d => Longhands(d.Property) != null)) continue;
                    var selectors = new List<(ComplexSelector, (int, int, int))>();
                    foreach (var text in CssStylesheet.SplitSelectors(rule.Selector))
                        try { foreach (var complex in CssSelectors.ParseList(text)) selectors.Add((complex, CssSelectors.Specificity(complex))); }
                        catch (Exception) { /* a selector the matcher does not read reaches nothing here */ }
                    if (selectors.Count > 0) rules.Add(new Rule(rule, order, where, condition, selectors));
                }
        }

        /// <summary>The spacing of one element of the author's DOM.</summary>
        public Spacing Of(DomNode element)
        {
            // Every declaration that reaches the element, with its rank in the cascade.
            var reaching = new List<(CssDeclaration Declaration, (int Important, int Inline, (int, int, int) Specificity, int Order, int Index) Rank, string Where, string Selector, string Condition)>();
            foreach (var rule in rules)
            {
                (int, int, int)? best = null;
                foreach (var (complex, specificity) in rule.Selectors)
                {
                    bool hit;
                    try { hit = CssSelectors.Matches(element, complex); } catch (Exception) { hit = false; }
                    if (hit && (best == null || specificity.CompareTo(best.Value) > 0)) best = specificity;
                }
                if (best == null) continue;
                for (var i = 0; i < rule.Css.Declarations.Count; i++)
                {
                    var d = rule.Css.Declarations[i];
                    if (Longhands(d.Property) != null) reaching.Add((d, (d.Important ? 1 : 0, 0, best.Value, rule.Order, i), rule.Where, rule.Css.Selector, rule.Condition));
                }
            }
            // The style attribute (a literal one: a binding is the runtime's) above every selector.
            if (element.Attr("style") is { Length: > 0 } inline && !inline.Contains("{{", StringComparison.Ordinal))
            {
                var declarations = RulesOf(["x{" + inline + "}"]).SelectMany(r => r.Declarations).ToList();
                for (var i = 0; i < declarations.Count; i++)
                    if (Longhands(declarations[i].Property) != null) reaching.Add((declarations[i], (declarations[i].Important ? 1 : 0, 1, (0, 0, 0), int.MaxValue, i), "the style attribute", "style", ""));
            }
            AxisSpacing Under(string? condition)
            {
                var winners = new Dictionary<string, (string Value, string From)>(StringComparer.Ordinal);
                var ranks = new Dictionary<string, (int, int, (int, int, int), int, int)>(StringComparer.Ordinal);
                foreach (var (d, rank, where, selector, c) in reaching.Where(x => x.Condition.Length == 0 || x.Condition == condition).OrderBy(x => x.Rank))
                {
                    var value = Resolve(d.Value.Trim());
                    var parts = Parts(value);
                    foreach (var (longhand, index) in Longhands(d.Property)!)
                    {
                        if (ranks.TryGetValue(longhand, out var had) && had.CompareTo(rank) > 0) continue;
                        ranks[longhand] = rank;
                        var part = index < 0 ? value : parts.Count == 0 ? value : parts[Math.Min(index, parts.Count - 1)];
                        winners[longhand] = (part, $"{selector} ({where}{(c.Length > 0 ? ", " + c : "")})");
                    }
                }
                var column = winners.TryGetValue("column-gap", out var col) ? col : default;
                return new AxisSpacing(winners.TryGetValue("display", out var display) ? display.Value : null,
                    column.Value, winners.TryGetValue("row-gap", out var row) ? row.Value : null, column.From);
            }
            var always = Under(null);
            var conditional = new List<(string, AxisSpacing)>();
            foreach (var condition in reaching.Select(x => x.Condition).Where(c => c.Length > 0).Distinct(StringComparer.Ordinal))
            {
                var there = Under(condition);
                if (there.Horizontal != always.Horizontal) conditional.Add((condition, there));
            }
            return new Spacing(always, conditional);
        }

        // var(--name) and var(--name, fallback) read from the tokens of :root; one the CSS does not declare stays as written.
        private static readonly Regex Var = new(@"var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)", RegexOptions.Compiled);
        private string Resolve(string value)
        {
            for (var depth = 0; depth < 8 && value.Contains("var(", StringComparison.Ordinal); depth++)
            {
                var next = Var.Replace(value, m => tokens.TryGetValue(m.Groups[1].Value, out var token) ? token : m.Groups[2].Success ? m.Groups[2].Value.Trim() : m.Value);
                if (next == value) break;
                value = next;
            }
            return value;
        }
    }

    // The longhands a declaration sets (gap is row-gap then column-gap; grid-* are their old names), with the index of its part
    // (-1: the whole value); null for a property the spacing does not read.
    private static IReadOnlyList<(string Longhand, int Part)>? Longhands(string property) => property.ToLowerInvariant() switch
    {
        "display" => [("display", -1)],
        "gap" or "grid-gap" => [("row-gap", 0), ("column-gap", 1)],
        "column-gap" or "grid-column-gap" => [("column-gap", -1)],
        "row-gap" or "grid-row-gap" => [("row-gap", -1)],
        _ => null,
    };

    // The values of a shorthand at the top level (the spaces inside parentheses do not split).
    private static List<string> Parts(string value)
    {
        var parts = new List<string>();
        var depth = 0; var start = 0;
        for (var i = 0; i <= value.Length; i++)
        {
            if (i < value.Length && value[i] == '(') depth++;
            else if (i < value.Length && value[i] == ')') depth--;
            else if (i == value.Length || char.IsWhiteSpace(value[i]) && depth == 0)
            {
                if (i > start) parts.Add(value[start..i]);
                start = i + 1;
            }
        }
        return parts;
    }

    /// <summary>A length that is zero: 0 with or without a unit, or normal (and the keywords that give it: initial, unset, revert),
    /// which is no gap in a flex or grid container. A value this side cannot read (an undeclared var()) is not zero.</summary>
    public static bool IsZeroLength(string value)
    {
        var v = value.Trim().ToLowerInvariant();
        return v is "normal" or "initial" or "unset" or "revert" or "revert-layer" or "" || Regex.IsMatch(v, @"^[+-]?(0+(\.0*)?|\.0+)([a-z%]+)?$");
    }
}
