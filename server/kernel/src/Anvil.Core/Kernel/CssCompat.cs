using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Core;

/// <summary>
/// CSS a prototype writes that the OutSystems theme does not render (A30 of the atritos 2 package: the Cardapio screens came
/// out "preto e branco", 2026-10-06 13:50). Pure: text in, text and problems out.
/// <list type="bullet">
/// <item><c>light-dark(a, b)</c> is expanded: the rule keeps the light value and a <c>@media (prefers-color-scheme: dark)</c>
/// block repeats it with the dark one.</item>
/// <item><c>color-mix(...)</c> is a problem (<see cref="Code"/>) with its substitute: the color it computes when both colors are
/// literals (in srgb, srgb-linear or oklab, or any space when one side is transparent), else a literal to write.</item>
/// <item>A selector that starts with <c>#reactContainer</c> is written <c>:is(#reactContainer, body)</c> (C35 of the atritos 3
/// package): the Studio canvas renders blocks without the runtime's #reactContainer, and a client's Shell and Login blocks
/// came out unstyled there. The specificity is the same (an id). With a descendant combinator (<c>#reactContainer .x</c>) the
/// rule selects, in the published page, the elements the app renders, all inside #reactContainer; with <c>&gt;</c>, <c>+</c>,
/// <c>~</c> or alone it also selects body itself or body's own children, which is another selection. The html compile keeps the
/// C35 rewrite of every form; the one normalization of a stylesheet write (CssPipeline) rewrites only the descendant form
/// (<c>descendantOnly</c>).</item>
/// </list>
/// </summary>
public static class CssCompat
{
    public const string Code = "CSS_FUNCTION_UNSUPPORTED";
    private const string Dark = "@media (prefers-color-scheme: dark)";

    /// <summary>One color-mix the theme would drop: where it is, the exact substitute when it can be computed.</summary>
    public sealed record Problem(string Function, string Text, string Message, string Fix, string? Substitute, int Line, int Column);

    /// <summary>One selector written otherwise, with where it was.</summary>
    public sealed record SelectorRewrite(string From, string To, int Line, int Column);

    /// <summary><paramref name="Css"/>: the stylesheet with light-dark expanded (verbatim when there is none); <paramref name="Mechanical"/>:
    /// the same with every color-mix replaced by its substitute, null when one of them has none. <see cref="Selectors"/>: the
    /// #reactContainer selectors already rewritten in both.</summary>
    public sealed record Result(string Css, int Expanded, IReadOnlyList<Problem> Problems, string? Mechanical)
    {
        public IReadOnlyList<SelectorRewrite> Selectors { get; init; } = [];
    }

    public static Result Rewrite(string css)
    {
        var (canvas, selectors) = CanvasSelectors(css);
        var problems = ColorMixes(canvas);
        var (expanded, count) = ExpandLightDark(canvas);
        string? mechanical = expanded;
        if (problems.Count > 0)
            mechanical = problems.All(p => p.Substitute != null) ? ReplaceColorMix(expanded) : null;
        return new Result(expanded, count, problems, mechanical) { Selectors = selectors };
    }

    // ---- #reactContainer ----------------------------------------------------------------------------------------------

    /// <summary>The stylesheet with every selector that starts with #reactContainer written as :is(#reactContainer, body), and
    /// the list of them. A text rewrite: comments, spacing and every other byte stay as written; nothing changes without one.</summary>
    public static (string Css, IReadOnlyList<SelectorRewrite> Rewrites) CanvasSelectors(string css, bool descendantOnly = false)
    {
        var head = "#" + CssStylesheet.ReactContainer;
        if (css.IndexOf(head, StringComparison.Ordinal) < 0) return (css, []);
        var rewrites = new List<SelectorRewrite>();
        var sb = new StringBuilder(css.Length + 32);
        var i = 0; var depth = 0;
        while (i < css.Length)
        {
            var start = i;
            i = SkipTrivia(css, i);
            sb.Append(css, start, i - start);
            if (i >= css.Length) break;
            if (css[i] == '}') { sb.Append('}'); i++; if (depth > 0) depth--; continue; }
            // A prelude: everything up to its '{' or ';' (strings, comments and parentheses kept whole).
            var preludeStart = i;
            var end = PreludeEnd(css, i);
            var prelude = css[preludeStart..end];
            if (end >= css.Length) { sb.Append(prelude); break; }
            if (css[end] == '}') { sb.Append(prelude); i = end; continue; }   // malformed: the parser reports it
            if (css[end] == ';') { sb.Append(prelude).Append(';'); i = end + 1; continue; }
            var trimmed = prelude.TrimStart();
            if (trimmed.StartsWith('@'))
            {
                sb.Append(prelude).Append('{');
                i = end + 1;
                if (IsNesting(trimmed)) { depth++; continue; }
                var close = BlockEnd(css, i);   // an opaque or unknown at-rule block: copied as written
                sb.Append(css, i, close - i);
                i = close;
                continue;
            }
            sb.Append(SelectorList(prelude, css, preludeStart, head, rewrites, descendantOnly)).Append('{');
            var blockEnd = BlockEnd(css, end + 1);
            sb.Append(css, end + 1, blockEnd - end - 1);
            i = blockEnd;
        }
        return rewrites.Count == 0 ? (css, []) : (sb.ToString(), rewrites);
    }

    private static string SelectorList(string prelude, string css, int offset, string head, List<SelectorRewrite> rewrites, bool descendantOnly = false)
    {
        var parts = new List<string>(); var depth = 0; var from = 0; char? quote = null;
        for (var k = 0; k < prelude.Length; k++)
        {
            var c = prelude[k];
            if (quote != null) { if (c == '\\') k++; else if (c == quote) quote = null; continue; }
            if (c is '"' or '\'') quote = c;
            else if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (c == ',' && depth == 0) { parts.Add(prelude[from..k]); from = k + 1; }
        }
        parts.Add(prelude[from..]);
        var position = offset;
        for (var p = 0; p < parts.Count; p++)
        {
            var part = parts[p];
            var lead = part.Length - part.TrimStart().Length;
            var selector = part.Trim();
            if (selector.StartsWith(head, StringComparison.Ordinal) && (selector.Length == head.Length || " \t\r\n>+~.:[".Contains(selector[head.Length]))
                && (!descendantOnly || Descendant(selector[head.Length..])))
            {
                var written = CssStylesheet.CanvasRoot + selector[head.Length..];
                var (line, column) = Position(css, position + lead);
                rewrites.Add(new SelectorRewrite(HtmlNode.CollapseSpaces(selector), HtmlNode.CollapseSpaces(written), line, column));
                parts[p] = part[..lead] + CssStylesheet.CanvasRoot + part[(lead + head.Length)..];
            }
            position += part.Length + 1;
        }
        return string.Join(",", parts);
    }

    // After #reactContainer: whitespace, then a compound (not a combinator): the descendant form.
    private static bool Descendant(string rest) => rest.Length > 0 && char.IsWhiteSpace(rest[0]) && rest.TrimStart() is { Length: > 0 } next && !">+~".Contains(next[0]);

    // ---- @import -------------------------------------------------------------------------------------------------------

    /// <summary>One top-level @import: its statement as written (with the ';'), where it was, and whether a rule or a block came
    /// before it (a browser ignores an @import that is not at the top of the stylesheet).</summary>
    public sealed record Import(string Statement, int Line, int Column, bool AfterRule);

    /// <summary>The top-level @import statements of <paramref name="css"/> and the stylesheet without them (C23 of the atritos 3
    /// package). Nothing else changes: comments, spacing and every other statement stay as written. Found by the statement
    /// walk, never by lines: an @import inside a minified line of 27 thousand characters, before or after rules, with ';' inside
    /// its url(…) (Google Fonts weights) or behind a byte order mark is found whole, and the rules on the same line stay (call
    /// 88 of 2026-10-10 lost 271 rules to a line regex).</summary>
    public static (IReadOnlyList<Import> Imports, string Others) Imports(string css)
    {
        if (css.IndexOf("@import", StringComparison.OrdinalIgnoreCase) < 0) return ([], css);
        var imports = new List<Import>();
        var sb = new StringBuilder(css.Length);
        var i = 0; var rule = false;
        while (i < css.Length)
        {
            var start = i;
            i = SkipTrivia(css, i);
            sb.Append(css, start, i - start);
            if (i >= css.Length) break;
            if (css[i] == '}') { sb.Append('}'); i++; continue; }
            var end = PreludeEnd(css, i);
            if (end >= css.Length) { sb.Append(css, i, css.Length - i); break; }
            if (css[end] == '}') { sb.Append(css, i, end - i); i = end; continue; }
            if (css[end] == ';')
            {
                var statement = css[i..(end + 1)];
                if (statement.StartsWith("@import", StringComparison.OrdinalIgnoreCase))
                {
                    var (line, column) = Position(css, i);
                    imports.Add(new Import(statement.Trim(), line, column, rule));
                    i = end + 1;
                    // the line break that ended the statement goes with it
                    if (i < css.Length && css[i] == '\r') i++;
                    if (i < css.Length && css[i] == '\n') i++;
                    continue;
                }
                sb.Append(statement); i = end + 1;
                continue;
            }
            var close = BlockEnd(css, end + 1);
            sb.Append(css, i, close - i);
            i = close; rule = true;
        }
        return (imports, imports.Count == 0 ? css : sb.ToString());
    }

    /// <summary>The stylesheet with its @import statements at the top (after @charset, which must stay first), and the ones
    /// that moved; the text itself when every @import is already at the top. <paramref name="inline"/> is the @font-face
    /// fallback hook of the prototype importer (docs/PROTOTIPO-NATIVO.md 4.1 item 2): for an @import it resolves (Google Fonts
    /// through the vendor cache) it returns the CSS to write in its place, else null to keep the statement.</summary>
    public static (string Css, IReadOnlyList<Import> Hoisted) HoistImports(string css, Func<Import, string?>? inline = null)
    {
        var (imports, rest) = Imports(css);
        var inlined = inline == null ? new List<string?>() : imports.Select(x => inline(x)).ToList();
        if (!imports.Any(x => x.AfterRule) && !inlined.Any(x => x != null)) return (css, []);
        var body = rest.TrimStart().TrimStart('\uFEFF').TrimStart();
        var charset = "";
        if (body.StartsWith("@charset", StringComparison.OrdinalIgnoreCase) && body.IndexOf(';') is var semi and > 0)
        { charset = body[..(semi + 1)] + "\n"; body = body[(semi + 1)..].TrimStart(); }
        var head = imports.Select((x, k) => k < inlined.Count && inlined[k] is { Length: > 0 } text ? text.TrimEnd() : x.Statement);
        return (charset + string.Join("\n", head) + "\n" + body, imports.Where(x => x.AfterRule).ToList());
    }

    private static bool IsNesting(string prelude) => prelude.StartsWith("@media", StringComparison.OrdinalIgnoreCase)
        || prelude.StartsWith("@supports", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@container", StringComparison.OrdinalIgnoreCase)
        || prelude.StartsWith("@layer", StringComparison.OrdinalIgnoreCase) || prelude.StartsWith("@document", StringComparison.OrdinalIgnoreCase);

    private static int SkipTrivia(string css, int i)
    {
        while (i < css.Length)
        {
            if (char.IsWhiteSpace(css[i]) || css[i] == '\uFEFF') { i++; continue; }
            if (css[i] == '/' && i + 1 < css.Length && css[i + 1] == '*') { var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? css.Length : end + 2; continue; }
            break;
        }
        return i;
    }

    /// <summary>The index of the '{' or ';' that ends the prelude starting at <paramref name="i"/> (the length when none).</summary>
    private static int PreludeEnd(string css, int i)
    {
        var depth = 0;
        while (i < css.Length)
        {
            var c = css[i];
            if (c == '/' && i + 1 < css.Length && css[i + 1] == '*') { var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? css.Length : end + 2; continue; }
            if (c is '"' or '\'') { var q = c; i++; while (i < css.Length && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (depth == 0 && c is '{' or ';' or '}') return i;
            i++;
        }
        return css.Length;
    }

    /// <summary>The index just after the '}' that closes the block whose content starts at <paramref name="i"/>.</summary>
    private static int BlockEnd(string css, int i)
    {
        var depth = 0;
        while (i < css.Length)
        {
            var c = css[i];
            if (c == '/' && i + 1 < css.Length && css[i + 1] == '*') { var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? css.Length : end + 2; continue; }
            if (c is '"' or '\'') { var q = c; i++; while (i < css.Length && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
            if (c == '{') depth++;
            else if (c == '}') { if (depth == 0) return i + 1; depth--; }
            i++;
        }
        return css.Length;
    }

    // ---- light-dark --------------------------------------------------------------------------------------------------

    private static (string Css, int Count) ExpandLightDark(string css)
    {
        if (css.IndexOf("light-dark(", StringComparison.OrdinalIgnoreCase) < 0) return (css, 0);
        CssStylesheet sheet;
        try { sheet = CssStylesheet.Parse(css); }
        catch (InvalidOperationException) { return (css, 0); } // the caller's own parse reports the malformed stylesheet
        var count = 0;
        var sb = new StringBuilder();
        foreach (var statement in sheet.Statements) sb.Append(statement).Append(";\n");
        // @keyframes and @font-face are kept whole: the rules below are re-serialized, these are not.
        foreach (var block in sheet.Blocks)
        {
            foreach (var enclosing in block.EnclosingRules) sb.Append(enclosing).Append(" {\n");
            sb.Append(block.Prelude).Append(" {").Append(block.Body).Append("}\n");
            for (var k = 0; k < block.EnclosingRules.Count; k++) sb.Append("}\n");
        }
        IReadOnlyList<string> open = [];
        void Emit(IReadOnlyList<string> enclosing, string selector, IEnumerable<CssDeclaration> declarations)
        {
            var common = 0;
            while (common < open.Count && common < enclosing.Count && open[common] == enclosing[common]) common++;
            for (var i = open.Count; i > common; i--) sb.Append("}\n");
            for (var i = common; i < enclosing.Count; i++) sb.Append(enclosing[i]).Append(" {\n");
            open = enclosing;
            sb.Append(open.Count > 0 ? "  " : "").Append(selector).Append(" { ");
            foreach (var d in declarations) sb.Append(d.Property).Append(": ").Append(d.Value).Append(d.Important ? " !important; " : "; ");
            sb.Append("}\n");
        }
        foreach (var rule in sheet.Rules)
        {
            var light = new List<CssDeclaration>(); var dark = new List<CssDeclaration>();
            foreach (var d in rule.Declarations)
            {
                if (d.Value.IndexOf("light-dark(", StringComparison.OrdinalIgnoreCase) < 0) { light.Add(d); continue; }
                light.Add(d with { Value = Branch(d.Value, 0, ref count) });
                dark.Add(d with { Value = Branch(d.Value, 1, ref count) });
            }
            Emit(rule.EnclosingRules, rule.Selector, light);
            if (dark.Count > 0) Emit([.. rule.EnclosingRules, Dark], rule.Selector, dark);
        }
        for (var i = open.Count; i > 0; i--) sb.Append("}\n");
        return (sb.ToString().TrimEnd() + "\n", count / 2);
    }

    /// <summary>The value with every light-dark(a, b) replaced by its branch (0 light, 1 dark).</summary>
    private static string Branch(string value, int branch, ref int count)
    {
        for (var guard = 0; guard < 64; guard++)
        {
            var start = value.IndexOf("light-dark(", StringComparison.OrdinalIgnoreCase);
            if (start < 0) return value;
            var open = start + "light-dark".Length;
            var close = Closing(value, open);
            if (close < 0) return value;
            var args = Arguments(value[(open + 1)..close]);
            if (args.Count != 2) return value;
            count++;
            value = value[..start] + args[branch].Trim() + value[(close + 1)..];
        }
        return value;
    }

    // ---- color-mix ----------------------------------------------------------------------------------------------------

    private static List<Problem> ColorMixes(string css)
    {
        var problems = new List<Problem>();
        foreach (var (start, end) in Calls(css, "color-mix"))
        {
            var text = css[start..(end + 1)];
            var substitute = MixText(css[(start + "color-mix(".Length)..end]);
            var (line, column) = Position(css, start);
            var fix = substitute != null
                ? $"write {substitute} (the color {text} computes) instead"
                : "write a literal color (#rrggbb or rgba(r, g, b, a)) instead; with var() or a polar color space it cannot be computed here, so pick the color once per theme (a variable in :root and in the dark @media)";
            problems.Add(new Problem("color-mix", text, $"css: line {line} col {column}: {text} is not rendered by the OutSystems theme (the rule is dropped)", fix, substitute, line, column));
        }
        return problems;
    }

    private static string ReplaceColorMix(string css)
    {
        var calls = Calls(css, "color-mix");
        var sb = new StringBuilder(css);
        foreach (var (start, end) in calls.OrderByDescending(c => c.Start))
            if (MixText(css[(start + "color-mix(".Length)..end]) is { } substitute) sb.Remove(start, end - start + 1).Insert(start, substitute);
        return sb.ToString();
    }

    /// <summary>One function the theme does not render, written as what it renders: the text as it was, as it is, where, why.</summary>
    public sealed record Rendered(string From, string To, int Line, int Column, string Why);

    /// <summary>Familias (2026-10-12): the stylesheet with every color-mix whose color can be computed written as that color
    /// (MixText) and, with <paramref name="expandLightDark"/>, every light-dark() expanded into the light value and a
    /// @media (prefers-color-scheme: dark) block: the CSS the theme renders the same way. Nothing else changes (comments,
    /// selectors, @import); a color-mix with no single color stays as written (CSS_FUNCTION_UNSUPPORTED says it).</summary>
    public static (string Css, IReadOnlyList<Rendered> Done) Render(string css, bool expandLightDark)
    {
        var done = new List<Rendered>();
        var sb = new StringBuilder(css);
        foreach (var (start, end) in Calls(css, "color-mix").OrderByDescending(c => c.Start))
        {
            if (MixText(css[(start + "color-mix(".Length)..end]) is not { } substitute) continue;
            var (line, column) = Position(css, start);
            done.Insert(0, new Rendered(css[start..(end + 1)], substitute, line, column, "the color it computes"));
            sb.Remove(start, end - start + 1).Insert(start, substitute);
        }
        var text = sb.ToString();
        if (expandLightDark)
        {
            var (expanded, count) = ExpandLightDark(text);
            if (count > 0)
            {
                done.Add(new Rendered("light-dark(...)", "@media (prefers-color-scheme: dark)", 0, 0,
                    $"{count} light-dark() value(s): the light value in the rule, the dark one in a @media (prefers-color-scheme: dark) block"));
                text = expanded;
            }
        }
        return (text, done);
    }

    /// <summary>The stylesheet with every light-dark(a, b) expanded (the light value in the rule, the dark one in a
    /// @media (prefers-color-scheme: dark) block), and how many: before the custom properties are resolved, so a property
    /// written light-dark(...) has its two definitions.</summary>
    public static (string Css, int Count) ExpandLightDarkValues(string css) => ExpandLightDark(css);

    /// <summary>The color a color-mix computes (its arguments as written), or null. Familias (2026-10-12): one side transparent
    /// leaves the other color with its share as alpha in every space, whatever the color's syntax (oklch(...), a hex, a name):
    /// the color is written as it came with that alpha (premultiplied interpolation: a transparent side adds no color and no
    /// hue). Otherwise <see cref="Mix"/> (both literals, srgb, srgb-linear or oklab).</summary>
    public static string? MixText(string inner)
    {
        var args = Arguments(inner);
        if (args.Count == 3 && Regex.IsMatch(args[0].Trim(), @"^in\s+[a-z0-9-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?$", RegexOptions.IgnoreCase)
            && Share(args[1]) is { } first && Share(args[2]) is { } second)
        {
            var transparentFirst = first.Color.Trim().Equals("transparent", StringComparison.OrdinalIgnoreCase);
            var transparentSecond = second.Color.Trim().Equals("transparent", StringComparison.OrdinalIgnoreCase);
            if (transparentFirst != transparentSecond)
            {
                double? p1 = first.Percent, p2 = second.Percent;
                if (p1 == null && p2 == null) { p1 = 50; p2 = 50; }
                else if (p1 == null) p1 = 100 - p2;
                else if (p2 == null) p2 = 100 - p1;
                var sum = p1!.Value + p2!.Value;
                if (sum <= 0 || p1 < 0 || p2 < 0 || p1 > 100 || p2 > 100) return null;
                var weight = (transparentFirst ? p2.Value : p1.Value) / sum * (sum < 100 ? sum / 100 : 1);
                return ColorWithAlpha(transparentFirst ? second.Color : first.Color, weight);
            }
        }
        return Mix(inner);
    }

    private sealed record Shared(string Color, double? Percent);

    private static Shared? Share(string text)
    {
        var value = text.Trim(); double? percent = null;
        var m = Regex.Match(value, @"^(.*?)\s+([0-9.]+)%$|^([0-9.]+)%\s+(.*)$", RegexOptions.Singleline);
        if (m.Success)
        {
            var number = m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value;
            value = (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[4].Value).Trim();
            if (!double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var p)) return null;
            percent = p;
        }
        return value.Length == 0 || value.Contains("var(", StringComparison.OrdinalIgnoreCase) ? null : new Shared(value, percent);
    }

    private static readonly Regex ColorFunction = new(@"^(oklch|oklab|lch|lab|hsla?|hwb|rgba?)\(\s*([^/()]*?)\s*(?:/\s*([0-9.]+%?)\s*)?\)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary><paramref name="color"/> (a literal color as written) with its alpha multiplied by <paramref name="factor"/>,
    /// or null when it is no color this reads (a var(), a keyword other than the named colors).</summary>
    private static string? ColorWithAlpha(string color, double factor)
    {
        color = color.Trim();
        if (Literal(color) is { } rgba) return Format(rgba with { A = rgba.A * factor });
        var m = ColorFunction.Match(color);
        if (!m.Success) return null;
        var fn = m.Groups[1].Value.ToLowerInvariant();
        // The legacy comma forms (rgba(r, g, b, a), hsla(...)) are read by Literal or not at all.
        if (m.Groups[2].Value.Contains(',')) return null;
        var alpha = 1.0;
        if (m.Groups[3].Success)
        {
            var a = m.Groups[3].Value;
            if (!double.TryParse(a.TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out alpha)) return null;
            if (a.EndsWith('%')) alpha /= 100;
        }
        var name = fn is "rgba" ? "rgb" : fn is "hsla" ? "hsl" : fn;
        var written = Math.Round(Math.Clamp(alpha * factor, 0, 1), 3).ToString(CultureInfo.InvariantCulture);
        return $"{name}({HtmlNode.CollapseSpaces(m.Groups[2].Value.Trim())} / {written})";
    }

    // ---- var() inside color-mix (familias, 2026-10-12) ---------------------------------------------------------------------

    /// <summary>One var() of a color-mix written otherwise: the call as it was, what it became, and why.</summary>
    public sealed record VarRewrite(string From, string To, string Why, int Line, int Column);

    /// <summary>A custom property definition: its name, value, the rule that holds it (selector and enclosing at-rules) and
    /// where its declaration ends in the text (after its ';', or the end of the rule's body).</summary>
    private sealed record Definition(string Name, string Value, string Selector, IReadOnlyList<string> AtRules, int DeclarationEnd, bool Important, bool Terminated, int ValueEnd);

    /// <summary>
    /// The stylesheet with every color-mix that reads var(--x) written so the theme renders it with the same colors
    /// (VisitaCerta_UI, 20:33: color-mix(in oklch, var(--card) 60%, transparent) x3, refused without a substitute, then written
    /// as one fixed rgba by hand, which lost the dark theme). The definitions are the custom properties of this stylesheet
    /// (and of <paramref name="others"/>, the job's other CSS, read only for a property defined once in all of them):
    /// <list type="bullet">
    /// <item>every var() the call reads has one definition (a var() inside it resolved the same way): the call with the values
    /// in place, whose color MixText computes, becomes that color;</item>
    /// <item>one var(--x) has several definitions, all in this stylesheet (a :root and a [data-theme="dark"], a @media dark),
    /// each computable: a custom property --x-mix-&lt;hash&gt; is defined next to each definition of --x (the same rule, so the same
    /// selector, cascade and inheritance pick it wherever --x is picked) with the color computed for that definition, and
    /// the call becomes var(--x-mix-&lt;hash&gt;).</item>
    /// </list>
    /// Anything else (a property the OutSystems UI tokens or another CSS may define, two properties with several definitions,
    /// a definition that is no color) is left as written: CSS_FUNCTION_UNSUPPORTED says it, without a substitute.
    /// </summary>
    public static (string Css, IReadOnlyList<VarRewrite> Rewrites) ResolveMixVars(string css, IEnumerable<string>? others = null)
    {
        var calls = Calls(css, "color-mix").Where(c => css.AsSpan(c.Start, c.End - c.Start + 1).Contains("var(", StringComparison.OrdinalIgnoreCase)).ToList();
        if (calls.Count == 0) return (css, []);
        var own = Definitions(css);
        var all = own.Concat((others ?? []).SelectMany(o => { try { return Definitions(o); } catch { return []; } })).ToList();
        var byName = all.GroupBy(d => d.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var ownByName = own.GroupBy(d => d.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var replacements = new List<(int Start, int End, string Text)>();
        var insertions = new List<(int At, string Text)>();
        var rewrites = new List<VarRewrite>();
        var derivedNames = new Dictionary<string, string>(StringComparer.Ordinal);
        string? Global(string name) => Single(name, byName) is { } value && byName[name][0] is { AtRules.Count: 0 } d && RootSelector(d.Selector) ? value : null;
        foreach (var (start, end) in calls)
        {
            var text = css[start..(end + 1)];
            var inner = css[(start + "color-mix(".Length)..end];
            var (line, column) = Position(css, start);
            // Every var() it reads (and every var() inside their values) is defined once, on the root: the values in place.
            if (Substitute(inner, Global, 0) is { } resolved && MixText(resolved) is { } color)
            {
                replacements.Add((start, end, color));
                rewrites.Add(new VarRewrite(text, color, "each custom property it reads is defined once, on :root: the color it computes", line, column));
                continue;
            }
            // The scoped ones (several definitions, or one in a rule other than the root) all in this stylesheet, defined in the
            // same rules (selector and at-rules), once in each: a derived property in each of those rules, with the color
            // computed there, so the cascade and inheritance pick it wherever they pick the properties it reads.
            var names = VarNames(inner).Distinct(StringComparer.Ordinal).ToList();
            var scoped = names.Where(n => Global(n) == null).ToList();
            if (scoped.Count == 0 || scoped.Any(n => Platform(n) || !ownByName.TryGetValue(n, out var o) || !byName.TryGetValue(n, out var b) || o.Count != b.Count)) continue;
            static string Context(Definition d) => string.Join(" ", d.AtRules) + "|" + d.Selector;
            var contexts = ownByName[scoped[0]].Select(Context).ToList();
            if (contexts.Distinct(StringComparer.Ordinal).Count() != contexts.Count
                || scoped.Any(n => ownByName[n].Select(Context).ToList() is var c && (c.Count != contexts.Count || c.Distinct(StringComparer.Ordinal).Count() != c.Count || !c.All(contexts.Contains)))) continue;
            var computed = new List<(Definition Anchor, string Color)>();
            foreach (var context in contexts)
            {
                var here = scoped.ToDictionary(n => n, n => ownByName[n].First(d => Context(d) == context), StringComparer.Ordinal);
                string? Lookup(string name) => here.TryGetValue(name, out var d) ? d.Value : Global(name);
                if (Substitute(inner, Lookup, 0) is not { } each || MixText(each) is not { } eachColor) { computed.Clear(); break; }
                computed.Add((here.Values.OrderBy(d => d.DeclarationEnd).Last(), eachColor));
            }
            if (computed.Count != contexts.Count) continue;
            var x = scoped[0];
            var shape = HtmlNode.CollapseSpaces(inner);
            var key = derivedNames.TryGetValue(shape, out var known) ? known : null;
            if (key == null)
            {
                var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(shape))).ToLowerInvariant()[..6];
                key = derivedNames[shape] = $"{x}-mix-{hash}";
                foreach (var (anchor, eachColor) in computed)
                    insertions.Add((anchor.Terminated ? anchor.DeclarationEnd : anchor.ValueEnd, $"{(anchor.Terminated ? "" : ";")} {key}: {eachColor}{(anchor.Important ? " !important" : "")};"));
            }
            replacements.Add((start, end, $"var({key})"));
            var where = string.Join(", ", contexts.Select(c => c.TrimStart('|').Replace("|", " ")));
            rewrites.Add(new VarRewrite(text, $"var({key})", $"{string.Join(", ", scoped)} {(scoped.Count == 1 ? "is" : "are")} defined in {where}: {key} is defined there with the color it computes in each ({string.Join(", ", computed.Select(c => c.Color))})", line, column));
        }
        if (replacements.Count == 0) return (css, []);
        var edits = replacements.Select(r => (r.Start, Length: r.End - r.Start + 1, r.Text)).Concat(insertions.Select(i => (Start: i.At, Length: 0, i.Text)))
            .OrderByDescending(e => e.Start).ThenBy(e => e.Length).ToList();
        var sb = new StringBuilder(css);
        foreach (var (s, length, written) in edits) sb.Remove(s, length).Insert(s, written);
        return (sb.ToString(), rewrites);
    }

    /// <summary>A selector that matches the document's root element only (:root, html), whose custom properties every element inherits.</summary>
    private static bool RootSelector(string selector) => selector.Split(',').Select(s => s.Trim()).All(s => s is ":root" or "html" or "html:root");

    /// <summary>The value of a custom property defined once (null: none, several, or an OutSystems UI token the base theme may define).</summary>
    private static string? Single(string name, IReadOnlyDictionary<string, List<Definition>> byName)
        => !Platform(name) && byName.TryGetValue(name, out var d) && d.Count == 1 ? d[0].Value : null;

    // The custom properties a theme gets from OutSystems UI and the platform (PreflightRules.StyleSheetRules.PlatformTokens).
    private static readonly string[] PlatformPrefixes = ["--color-", "--space-", "--font-", "--border-", "--shadow-", "--osui-", "--os-",
        "--header-", "--footer-", "--side-menu-", "--bottom-bar-", "--layout-", "--menu-", "--overlay-", "--z-index-", "--blur-"];
    private static bool Platform(string name) => PlatformPrefixes.Any(p => name.StartsWith(p, StringComparison.Ordinal));

    private static readonly Regex VarCall = new(@"var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)", RegexOptions.Compiled);

    private static IEnumerable<string> VarNames(string text) => VarCall.Matches(text).Select(m => m.Groups[1].Value);

    /// <summary>The text with every var() replaced by its value (recursively, at most 8 deep); a var() with no value takes its
    /// fallback; null when one has neither.</summary>
    private static string? Substitute(string text, Func<string, string?> value, int depth)
    {
        if (depth > 8) return null;
        if (text.IndexOf("var(", StringComparison.OrdinalIgnoreCase) < 0) return text;
        var failed = false;
        var written = VarCall.Replace(text, m =>
        {
            var v = value(m.Groups[1].Value) ?? (m.Groups[2].Success ? m.Groups[2].Value.Trim() : null);
            if (v == null) { failed = true; return m.Value; }
            if (Substitute(v, value, depth + 1) is { } resolved) return resolved;
            failed = true;
            return m.Value;
        });
        return failed ? null : written;
    }

    /// <summary>Every custom property definition of the style rules of <paramref name="css"/> (inside @media, @supports,
    /// @container and @layer too), with where its declaration ends.</summary>
    private static List<Definition> Definitions(string css)
    {
        var found = new List<Definition>();
        void Walk(int from, int to, IReadOnlyList<string> atRules)
        {
            var i = from;
            while (i < to)
            {
                i = SkipTrivia(css, i);
                if (i >= to) break;
                if (css[i] == '}') { i++; continue; }
                var end = PreludeEnd(css, i);
                if (end >= to) break;
                if (css[end] == ';' || css[end] == '}') { i = end + 1; continue; }
                var prelude = HtmlNode.CollapseSpaces(css[i..end].Trim());
                var close = BlockEnd(css, end + 1);
                if (prelude.StartsWith('@'))
                {
                    if (IsNesting(prelude)) Walk(end + 1, close - 1, [.. atRules, prelude]);
                }
                else Declarations(end + 1, close - 1, prelude, atRules);
                i = close;
            }
        }
        void Declarations(int from, int to, string selector, IReadOnlyList<string> atRules)
        {
            var i = from;
            while (i < to)
            {
                i = SkipTrivia(css, i);
                if (i >= to) break;
                var end = PreludeEnd(css, i);
                if (end > to) end = to;
                if (end < to && css[end] == '{') { i = BlockEnd(css, end + 1); continue; }   // a nested rule: not a definition of this one
                var declaration = css[i..end];
                var colon = declaration.IndexOf(':');
                if (colon > 0 && declaration[..colon].Trim() is var property && property.StartsWith("--", StringComparison.Ordinal))
                {
                    var value = declaration[(colon + 1)..].Trim();
                    var important = Regex.IsMatch(value, @"!\s*important\s*$", RegexOptions.IgnoreCase);
                    if (important) value = Regex.Replace(value, @"\s*!\s*important\s*$", "", RegexOptions.IgnoreCase);
                    var valueEnd = end;
                    while (valueEnd > i && char.IsWhiteSpace(css[valueEnd - 1])) valueEnd--;
                    found.Add(new Definition(property, value, selector, atRules, end < to ? end + 1 : end, important, end < to, valueEnd));
                }
                i = end + 1;
            }
        }
        Walk(0, css.Length, []);
        return found;
    }

    /// <summary>Every call of <paramref name="function"/> outside comments and strings: (start of the name, index of ")").</summary>
    private static List<(int Start, int End)> Calls(string css, string function)
    {
        var found = new List<(int, int)>();
        var i = 0;
        while (i < css.Length)
        {
            if (css[i] == '/' && i + 1 < css.Length && css[i + 1] == '*') { var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? css.Length : end + 2; continue; }
            if (css[i] is '"' or '\'') { var q = css[i++]; while (i < css.Length && css[i] != q) i += css[i] == '\\' ? 2 : 1; i++; continue; }
            if (string.Compare(css, i, function + "(", 0, function.Length + 1, StringComparison.OrdinalIgnoreCase) == 0
                && (i == 0 || !(char.IsLetterOrDigit(css[i - 1]) || css[i - 1] is '-' or '_')))
            {
                var close = Closing(css, i + function.Length);
                if (close < 0) break;
                found.Add((i, close));
                i = close + 1; continue;
            }
            i++;
        }
        return found;
    }

    private static int Closing(string text, int open)
    {
        var depth = 0;
        for (var i = open; i < text.Length; i++)
        {
            var c = text[i];
            if (c is '"' or '\'') { var q = c; i++; while (i < text.Length && text[i] != q) i += text[i] == '\\' ? 2 : 1; continue; }
            if (c == '(') depth++;
            else if (c == ')' && --depth == 0) return i;
        }
        return -1;
    }

    private static List<string> Arguments(string inner)
    {
        var parts = new List<string>(); var depth = 0; var start = 0;
        for (var i = 0; i < inner.Length; i++)
        {
            var c = inner[i];
            if (c == '(') depth++; else if (c == ')') depth--;
            else if (c == ',' && depth == 0) { parts.Add(inner[start..i]); start = i + 1; }
        }
        parts.Add(inner[start..]);
        return parts;
    }

    private static (int Line, int Column) Position(string text, int index)
    {
        int line = 1, column = 1;
        for (var i = 0; i < index && i < text.Length; i++) { if (text[i] == '\n') { line++; column = 1; } else column++; }
        return (line, column);
    }

    private sealed record Rgba(double R, double G, double B, double A);

    /// <summary>The color color-mix computes, or null when a side is not a literal or the space is not srgb, srgb-linear or
    /// oklab (a side that is transparent leaves the other color with its share as alpha, in any space).</summary>
    private static string? Mix(string inner)
    {
        var args = Arguments(inner);
        if (args.Count != 3) return null;
        var space = Regex.Match(args[0].Trim(), @"^in\s+([a-z0-9-]+)", RegexOptions.IgnoreCase);
        if (!space.Success) return null;
        if (Side(args[1]) is not { } first || Side(args[2]) is not { } second) return null;
        double? p1 = first.Percent, p2 = second.Percent;
        if (p1 == null && p2 == null) { p1 = 50; p2 = 50; }
        else if (p1 == null) p1 = 100 - p2;
        else if (p2 == null) p2 = 100 - p1;
        var sum = p1!.Value + p2!.Value;
        if (sum <= 0 || p1 < 0 || p2 < 0) return null;
        var multiplier = sum < 100 ? sum / 100 : 1;
        double w1 = p1.Value / sum, w2 = p2.Value / sum;
        var a = first.Color; var b = second.Color;
        var alpha = a.A * w1 + b.A * w2;
        Rgba mixed;
        if (alpha <= 0) mixed = new Rgba(0, 0, 0, 0);
        else if (a.A == 0 || b.A == 0)
        {
            // Premultiplied: a transparent side adds no color, whatever the space.
            var color = a.A == 0 ? b : a;
            mixed = color with { A = alpha };
        }
        else
        {
            var name = space.Groups[1].Value.ToLowerInvariant();
            Func<Rgba, double[]> to; Func<double[], Rgba> back;
            switch (name)
            {
                case "srgb": to = c => [c.R, c.G, c.B]; back = v => new Rgba(v[0], v[1], v[2], 1); break;
                case "srgb-linear": to = c => [Linear(c.R), Linear(c.G), Linear(c.B)]; back = v => new Rgba(Gamma(v[0]), Gamma(v[1]), Gamma(v[2]), 1); break;
                case "oklab": to = OkLab; back = FromOkLab; break;
                default: return null;
            }
            var u = to(a); var v = to(b); var mix = new double[3];
            for (var k = 0; k < 3; k++) mix[k] = (u[k] * a.A * w1 + v[k] * b.A * w2) / alpha;
            mixed = back(mix) with { A = alpha };
        }
        return Format(mixed with { A = mixed.A * multiplier });
    }

    private sealed record Part(Rgba Color, double? Percent);

    private static Part? Side(string text)
    {
        var value = text.Trim(); double? percent = null;
        var m = Regex.Match(value, @"^(.*?)\s+([0-9.]+)%$|^([0-9.]+)%\s+(.*)$");
        if (m.Success)
        {
            var number = m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value;
            value = (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[4].Value).Trim();
            if (!double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var p)) return null;
            percent = p;
        }
        return Literal(value) is { } color ? new Part(color, percent) : null;
    }

    private static readonly Dictionary<string, string> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["black"] = "#000000", ["white"] = "#ffffff", ["red"] = "#ff0000", ["green"] = "#008000", ["blue"] = "#0000ff",
        ["gray"] = "#808080", ["grey"] = "#808080", ["silver"] = "#c0c0c0", ["yellow"] = "#ffff00", ["orange"] = "#ffa500",
        ["purple"] = "#800080", ["navy"] = "#000080", ["teal"] = "#008080", ["maroon"] = "#800000", ["lime"] = "#00ff00",
        ["aqua"] = "#00ffff", ["cyan"] = "#00ffff", ["fuchsia"] = "#ff00ff", ["magenta"] = "#ff00ff", ["olive"] = "#808000",
    };

    private static Rgba? Literal(string value)
    {
        value = value.Trim();
        if (value.Equals("transparent", StringComparison.OrdinalIgnoreCase)) return new Rgba(0, 0, 0, 0);
        if (Named.TryGetValue(value, out var hex)) value = hex;
        if (value.StartsWith('#'))
        {
            var h = value[1..];
            if (h.Length is 3 or 4) h = string.Concat(h.Select(c => new string(c, 2)));
            if (h.Length is not (6 or 8) || !h.All(Uri.IsHexDigit)) return null;
            double Byte(int at) => int.Parse(h.Substring(at, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture) / 255.0;
            return new Rgba(Byte(0), Byte(2), Byte(4), h.Length == 8 ? Byte(6) : 1);
        }
        var rgb = Regex.Match(value, @"^rgba?\(\s*([^)]*)\)$", RegexOptions.IgnoreCase);
        if (!rgb.Success) return null;
        var parts = Regex.Split(rgb.Groups[1].Value.Trim(), @"\s*[,/]\s*|\s+").Where(p => p.Length > 0).ToArray();
        if (parts.Length is not (3 or 4)) return null;
        var channels = new double[4]; channels[3] = 1;
        for (var k = 0; k < parts.Length; k++)
        {
            var p = parts[k]; var isPercent = p.EndsWith('%');
            if (!double.TryParse(isPercent ? p[..^1] : p, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
            channels[k] = k < 3 ? (isPercent ? n / 100 : n / 255) : (isPercent ? n / 100 : n);
        }
        return new Rgba(channels[0], channels[1], channels[2], channels[3]);
    }

    private static double Linear(double c) => c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
    private static double Gamma(double c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.Pow(c, 1 / 2.4) - 0.055;

    private static double[] OkLab(Rgba c)
    {
        double r = Linear(c.R), g = Linear(c.G), b = Linear(c.B);
        var l = Math.Cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        var m = Math.Cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        var s = Math.Cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
    }

    private static Rgba FromOkLab(double[] lab)
    {
        var l = Math.Pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
        var m = Math.Pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
        var s = Math.Pow(lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2], 3);
        return new Rgba(Gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), Gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            Gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), 1);
    }

    private static string Format(Rgba c)
    {
        static int Channel(double v) => (int)Math.Round(Math.Clamp(v, 0, 1) * 255, MidpointRounding.AwayFromZero);
        if (c.A >= 0.9995) return $"#{Channel(c.R):x2}{Channel(c.G):x2}{Channel(c.B):x2}";
        return string.Create(CultureInfo.InvariantCulture, $"rgba({Channel(c.R)}, {Channel(c.G)}, {Channel(c.B)}, {Math.Round(Math.Clamp(c.A, 0, 1), 3)})");
    }
}
