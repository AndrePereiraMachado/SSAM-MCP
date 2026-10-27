using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Anvil.Reading;

/// <summary>
/// T1 "a text value never carries binding syntax or raw markup": the one compile of a text with bindings, for every html write
/// path (the fragment op, the screen or block document, the edit form and its edits[], the page form) and both lanes. In a text
/// node or an attribute value, {{ E }} is the OutSystems expression E; the parts are ScreenHtml.Bindings (a binding closes at the
/// first }} outside its strings and its own braces). What a slot takes decides the rest:
/// <list type="bullet">
/// <item>an expression-typed slot (Prompt, an extended property, Style Classes, a Value, a Url) takes the expression: a whole
/// {{ E }} is E, text with bindings their concatenation with the literal parts quoted (ScreenHtml.Unsugar), a value without a
/// binding its string literal (<see cref="Expression"/>);</item>
/// <item>a literal-typed slot (the Text of a Text widget, the caption of a Label, a Button or a Link) takes a literal: a binding of
/// a constant (a string, a number, True, False) is folded into the text around it (<see cref="Runs"/>, <see cref="Literal"/>); a
/// binding that names something makes the slot a run of Text and Expression children (child text) or is refused
/// (HTML_BINDING_LITERAL, a property that takes a literal);</item>
/// <item>a constant whose text holds the brace pair of a binding is never folded: it stays the expression it is, and the invariant
/// refuses it (a literal never shows a binding).</item>
/// </list>
/// The invariant LITERAL_BINDING_REMNANT (ModelSession.LiteralBindingRemnants, after the apply of every job): no literal-typed
/// value the job wrote, and no string literal of an expression it wrote, holds {{ ... }} after its HTML entities are decoded
/// (<see cref="HoldsPair"/>, <see cref="Remnants"/>). Braces that a page must show are written so that no single literal holds the
/// pair: a lone brace pair in &lt;text&gt; (the reading prints a literal brace as &amp;#123; / &amp;#125;), or an expression whose
/// literals split it ({{ "{" + "{ x }" + "}" }}). HTML_IN_EXPRESSION (<see cref="Markup"/>): an Expression whose value is a constant
/// holding markup shows the markup as text in Reactive and ODC (a Traditional Expression with Escape Content No copied as is).
/// </summary>
internal static class BindingText
{
    internal const string Remnant = "LITERAL_BINDING_REMNANT";
    internal const string HtmlInExpression = "HTML_IN_EXPRESSION";

    /// <summary>The expression of an expression-typed slot: {{ E }} is E (rewritten by <paramref name="scoped"/>, the fragment's
    /// list row), text with bindings their concatenation, a value without binding its string literal. Null, with the fault, for a
    /// malformed value (a {{ that never closes, a }} outside a binding, {{ }} without expression).</summary>
    internal static string? Expression(string raw, out string? fault, Func<string, string>? scoped = null) => ScreenHtml.Unsugar(raw, scoped, out fault);

    /// <summary>The literal of a literal-typed slot: the value itself without binding, the folded text when every binding is a
    /// constant, null when a binding names something (or the fold would hold the brace pair of a binding).</summary>
    internal static string? Literal(string raw)
    {
        if (!ScreenHtml.HoldsBraces(raw)) return raw;
        return ScreenHtml.HasBinding(raw) && ScreenHtml.ConstantText(raw) is { } constant && !HoldsPair(constant) ? constant : null;
    }

    /// <summary>One run of child text as the slot takes it: literal text, or an expression.</summary>
    internal readonly record struct Run(string Text, bool Expression);

    /// <summary>The runs of a text with bindings, in order: the literal parts, each binding of a constant folded into the literal
    /// around it (unless its text holds the brace pair of a binding), every other binding its expression (rewritten by
    /// <paramref name="scoped"/>). Null, with the fault, when the text is malformed.</summary>
    internal static List<Run>? Runs(string raw, out string? fault, Func<string, string>? scoped = null)
    {
        fault = null;
        if (!ScreenHtml.HoldsBraces(raw)) return [new(raw, false)];
        if (ScreenHtml.Bindings(raw, out fault) is not { } parts) return null;
        var runs = new List<Run>();
        var literal = new StringBuilder();
        foreach (var part in parts) {
            if (!part.Expression) { literal.Append(part.Text); continue; }
            var expression = part.Text.Trim();
            if (Constant(expression) is { } constant && !HoldsPair(constant)) { literal.Append(constant); continue; }
            if (literal.Length > 0) { runs.Add(new(literal.ToString(), false)); literal.Clear(); }
            runs.Add(new(scoped == null ? expression : scoped(expression), true));
        }
        if (literal.Length > 0) runs.Add(new(literal.ToString(), false));
        return runs;
    }

    /// <summary>The text a constant expression shows: a string literal (a quote doubled), a number, True or False; null for anything
    /// else (ScreenHtml.ConstantText's rule, for one binding).</summary>
    internal static string? Constant(string expression)
    {
        var e = expression.Trim();
        if (e.Length >= 2 && e[0] == '"' && e[^1] == '"' && !e[1..^1].Replace("\"\"", "", StringComparison.Ordinal).Contains('"')) return e[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal);
        if (Regex.IsMatch(e, @"^-?\d+(\.\d+)?$") || e is "True" or "False") return e;
        return null;
    }

    /// <summary>Whether a literal holds the brace pair of a binding: a {{ with a }} after it, once its HTML entities are decoded
    /// (&amp;#123;&amp;#123; is {{). A lone {{ or }} is no binding.</summary>
    internal static bool HoldsPair(string literal)
    {
        var text = literal.Contains('&') ? WebUtility.HtmlDecode(literal) : literal;
        var open = text.IndexOf("{{", StringComparison.Ordinal);
        return open >= 0 && text.IndexOf("}}", open + 2, StringComparison.Ordinal) >= 0;
    }

    /// <summary>The string literals of an OutSystems expression (their text, a doubled quote undone).</summary>
    internal static IEnumerable<string> StringLiterals(string expression)
    {
        for (var i = 0; i < expression.Length; i++) {
            if (expression[i] != '"') continue;
            var sb = new StringBuilder();
            var j = i + 1;
            for (; j < expression.Length; j++) {
                if (expression[j] != '"') { sb.Append(expression[j]); continue; }
                if (j + 1 < expression.Length && expression[j + 1] == '"') { sb.Append('"'); j++; continue; }
                break;
            }
            yield return sb.ToString();
            i = j;
        }
    }

    /// <summary>Whether an expression has a brace of its own code, outside its string literals (an ODC record literal { A: 1 }, a
    /// value written whole with its binding): the checks of prose and syntax leave such a value to the Verify.</summary>
    internal static bool BracesInCode(string expression)
    {
        for (var i = 0; i < expression.Length; i++) {
            var c = expression[i];
            if (c == '"') { i++; while (i < expression.Length && !(expression[i] == '"' && (i + 1 >= expression.Length || expression[i + 1] != '"'))) i += expression[i] == '"' ? 2 : 1; continue; }
            if (c is '{' or '}') return true;
        }
        return false;
    }

    /// <summary>The string literals of an expression that hold the brace pair of a binding (decoded): what the page would show as
    /// braces. A Prompt "{{ ""Search"" }}" (the literal of a placeholder written with a binding) is one.</summary>
    internal static IEnumerable<string> Remnants(string expression) => StringLiterals(expression).Where(HoldsPair);

    /// <summary>The one fix of a remnant (its text, decoded): the expression its binding stands for, in an expression-typed slot
    /// ({{ "Search" }} is "Search", {{ X }} is X).</summary>
    internal static string FixOf(string remnant)
    {
        var text = remnant.Contains('&') ? WebUtility.HtmlDecode(remnant) : remnant;
        return Expression(text.Trim(), out var fault) is { } expression && fault == null ? expression : ScreenHtml.Literal(text.Replace("{{", "", StringComparison.Ordinal).Replace("}}", "", StringComparison.Ordinal).Trim());
    }

    /// <summary>The one fix of a remnant in a literal-typed slot (child text): the text it shows when every binding is a constant
    /// ({{ "Search" }} is Search), else the binding written as one ({{ X }}).</summary>
    internal static string TextFixOf(string remnant)
    {
        var text = remnant.Contains('&') ? WebUtility.HtmlDecode(remnant) : remnant;
        if (Literal(text.Trim()) is { } literal && !ScreenHtml.HoldsBraces(literal)) return literal;
        return "{{ " + FixOf(text) + " }}";
    }

    private static readonly Regex Tag = new(@"<\s*/?\s*[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?/?\s*>", RegexOptions.Compiled);

    /// <summary>The markup an Expression shows as text: its value is a constant (one string literal, or string literals joined by
    /// +) whose decoded text holds an HTML tag. Null otherwise (a value that names something is the page's data).</summary>
    internal static string? Markup(string expression)
    {
        var e = expression.Trim();
        if (e.Length == 0) return null;
        var constant = new StringBuilder();
        var i = 0;
        while (i < e.Length) {
            while (i < e.Length && char.IsWhiteSpace(e[i])) i++;
            if (i >= e.Length || e[i] != '"') return null;
            var start = i++;
            while (i < e.Length && !(e[i] == '"' && (i + 1 >= e.Length || e[i + 1] != '"'))) i += e[i] == '"' ? 2 : 1;
            if (i >= e.Length) return null;
            constant.Append(e[(start + 1)..i].Replace("\"\"", "\"", StringComparison.Ordinal));
            i++;
            while (i < e.Length && char.IsWhiteSpace(e[i])) i++;
            if (i < e.Length) { if (e[i] != '+') return null; i++; }
        }
        var text = constant.ToString();
        if (text.Contains('&')) text = WebUtility.HtmlDecode(text);
        return Tag.IsMatch(text) ? text : null;
    }
}
