using System.Globalization;
using System.Text;

namespace Anvil.Core;

/// <summary>
/// R3-A F2: what a stylesheet reaches outside the document, read on the token stream of CSS Syntax 3 (never on its text): comments
/// and strings as the tokenizer reads them, identifiers and function names with their escapes decoded (<c>u\72l(</c> is
/// <c>url(</c>), the url token of an unquoted <c>url(</c>, and the strings an image function takes in place of a url
/// (<c>image-set</c>, <c>-webkit-image-set</c>, <c>src</c>, <c>image</c>, <c>cross-fade</c>) or an <c>@import</c> names. Each target
/// is decoded before it is judged. <see cref="Neutralize"/> writes the sheet with every target that is not <c>data:</c> or a
/// fragment as <c>#</c> and every @import dropped; <see cref="External"/> lists the targets that leave the machine (a scheme
/// http, https, file or ftp, or a network path // or \\), the renderer's refusal.
/// </summary>
public static class CssReach
{
    private static readonly HashSet<string> TargetFunctions = new(StringComparer.Ordinal) { "url", "src", "image-set", "-webkit-image-set", "image", "-webkit-image", "cross-fade", "-webkit-cross-fade", "element", "-moz-element" };

    /// <summary>The functions whose strings are text (a fallback, a separator), never fetched.</summary>
    private static readonly HashSet<string> TextFunctions = new(StringComparer.Ordinal) { "attr", "counter", "counters" };


    /// <summary>A target that stays in the document: a same-document reference (#id) or data: of an image type.</summary>
    public static bool Inside(string target)
    {
        var t = target.Trim();
        return t.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase) || t.StartsWith('#');
    }

    /// <summary>A target that leaves the machine: a network scheme or a network path.</summary>
    public static bool Leaves(string target)
    {
        var t = target.Trim().Replace('\\', '/');
        return t.StartsWith("//", StringComparison.Ordinal) || System.Text.RegularExpressions.Regex.IsMatch(t, "^(?i)(https?|file|ftp):");
    }

    /// <summary>The targets of a sheet (or, with <paramref name="declarations"/>, of a style attribute: a list of declarations)
    /// that leave the machine (decoded).</summary>
    public static List<string> External(string css, bool declarations = false)
    {
        var found = new List<string>();
        Read(css, found, rewrite: false, declarations, import: false);
        return found.Where(Leaves).ToList();
    }

    /// <summary>The sheet (or a style attribute's declarations) with every target that is not data:image/ or a fragment written
    /// "#" and every @import dropped.</summary>
    public static string Neutralize(string css, bool declarations = false) => Read(css, null, rewrite: true, declarations, import: false);

    /// <summary>
    /// The one reading. The context of each token decides whether it is a target (Y1, Y2, X1): only declaration values and the
    /// prelude of @import fetch. A target is:
    /// <list type="bullet">
    /// <item>the url token of an unquoted url(), and every string inside a fetching function (url, src, image-set,
    /// -webkit-image-set, image, cross-fade, element) at ANY depth of the function stack (a var() fallback inside image-set
    /// included), in any property, content too;</item>
    /// <item>in a declaration value (an @property initial-value and a custom property included), a string that leaves the
    /// machine, except the direct value of content and quotes (outside every function) and a string inside attr(), counter() or
    /// counters() (text);</item>
    /// <item>every string and url of the prelude of @import.</item>
    /// </list>
    /// Never a target: the strings of a selector (an attribute selector, :is/:not/:has), the prelude of @namespace (an identifier,
    /// not a fetch), the prelude of any other at-rule.
    /// </summary>
    private static string Read(string css, List<string>? targets, bool rewrite, bool declarations, bool import)
    {
        var output = new StringBuilder(css.Length);
        var functions = new Stack<string>();
        var i = 0;
        // Z1: a declaration is known by its shape (ident ":" up to the next ";" or "}" with no "{" before), at any depth and in any
        // block (a style rule, a nested @media/@supports/@layer/@container/@starting-style, @scope, an unknown at-rule), never by the
        // name of its container; an "ident :" followed by a "{" first is the selector of a nested rule
        string? atRule = null;      // the at-rule whose prelude is read (until its { or ;)
        string? property = null;    // the property of the declaration read (in a block of declarations)
        bool InFetch() => functions.Any(TargetFunctions.Contains);
        bool InText() => functions.Any(TextFunctions.Contains);
        while (i < css.Length)
        {
            var c = css[i];
            // comment
            if (c == '/' && i + 1 < css.Length && css[i + 1] == '*')
            {
                var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal);
                end = end < 0 ? css.Length : end + 2;
                output.Append(css, i, end - i);
                i = end;
                continue;
            }
            // string
            if (c is '"' or '\'')
            {
                var (value, end) = ReadString(css, i);
                if (import || atRule == null && InFetch())
                {
                    targets?.Add(value);
                    output.Append(rewrite && !Inside(value) ? "\"#\"" : css[i..end]);
                }
                else if (atRule == null && property != null && Leaves(value) && !InText()
                         && !(property is "content" or "quotes" && functions.Count == 0))
                {
                    targets?.Add(value);
                    output.Append(rewrite ? "\"#\"" : css[i..end]);
                }
                else output.Append(css, i, end - i);
                i = end;
                continue;
            }
            // at-keyword
            if (c == '@' && StartsIdent(css, i + 1))
            {
                var (name, end) = ReadIdent(css, i + 1);
                if (name.Equals("import", StringComparison.OrdinalIgnoreCase))
                {
                    var stop = StatementEnd(css, end);
                    var prelude = css[end..stop];
                    foreach (var target in ImportTargets(prelude)) targets?.Add(target);
                    output.Append(rewrite ? "/* @import removed */" : css[i..Math.Min(css.Length, stop + 1)]);
                    i = Math.Min(css.Length, stop + 1);
                    continue;
                }
                if (name.Equals("namespace", StringComparison.OrdinalIgnoreCase))
                {
                    // Y2: a namespace URI names, never fetches: the statement as written
                    var stop = StatementEnd(css, end);
                    var close = Math.Min(css.Length, stop + 1);
                    output.Append(css, i, close - i);
                    i = close;
                    continue;
                }
                atRule = name.ToLowerInvariant();
                output.Append(css, i, end - i);
                i = end;
                continue;
            }
            // identifier, function or url token
            if (StartsIdent(css, i))
            {
                var (name, end) = ReadIdent(css, i);
                if (end < css.Length && css[end] == '(')
                {
                    var lower = name.ToLowerInvariant();
                    if (lower == "url")
                    {
                        var j = end + 1;
                        while (j < css.Length && IsSpace(css[j])) j++;
                        if (j < css.Length && css[j] is not ('"' or '\''))
                        {
                            // the url token: up to the ')' (escapes decoded); a target in a value or an @import prelude
                            var (target, close) = ReadUrl(css, j);
                            if (atRule == null || import) { targets?.Add(target); output.Append(rewrite && !Inside(target) ? "url(\"#\")" : css[i..close]); }
                            else output.Append(css, i, close - i);
                            i = close;
                            continue;
                        }
                    }
                    functions.Push(lower);
                    output.Append(css, i, end + 1 - i);
                    i = end + 1;
                    continue;
                }
                // the property of a declaration: its name before its colon, outside any function, by the declaration's shape
                if (functions.Count == 0 && property == null && atRule == null)
                {
                    // C1: as "consume a declaration" reads it: whitespace and comments between the name and the colon are nothing
                    var j = SkipSpaceAndComments(css, end);
                    if (j < css.Length && css[j] == ':' && IsDeclaration(css, j + 1)) property = name.ToLowerInvariant();
                }
                output.Append(css, i, end - i);
                i = end;
                continue;
            }
            if (functions.Count == 0 && c is ';' or '{' or '}')
            {
                property = null;
                atRule = null;
            }
            if (c == '(') functions.Push("");
            else if (c == ')' && functions.Count > 0) functions.Pop();
            else if (c == '\\' && i + 1 < css.Length) { output.Append(css, i, 2); i += 2; continue; }
            output.Append(c);
            i++;
        }
        return output.ToString();
    }

    private static bool IsSpace(char c) => c is ' ' or '\t' or '\n' or '\r' or '\f';

    /// <summary>The index of the next token that is neither whitespace nor a comment.</summary>
    private static int SkipSpaceAndComments(string s, int i)
    {
        while (i < s.Length)
        {
            if (IsSpace(s[i])) { i++; continue; }
            if (s[i] == '/' && i + 1 < s.Length && s[i + 1] == '*') { var e = s.IndexOf("*/", i + 2, StringComparison.Ordinal); i = e < 0 ? s.Length : e + 2; continue; }
            break;
        }
        return i;
    }

    /// <summary>Whether what follows a colon at <paramref name="i"/> is a declaration's value: the next ';' or '}' outside
    /// functions, strings and comments comes before any '{' (else the colon is a pseudo-class of a nested rule's selector).</summary>
    private static bool IsDeclaration(string s, int i)
    {
        var depth = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '*') { var e = s.IndexOf("*/", i + 2, StringComparison.Ordinal); i = e < 0 ? s.Length : e + 2; continue; }
            if (c is '"' or '\'') { i = ReadString(s, i).End; continue; }
            if (c == '\\') { i += 2; continue; }
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth = Math.Max(0, depth - 1);
            else if (depth == 0 && c == '{') return false;
            else if (depth == 0 && c is ';' or '}') return true;
            i++;
        }
        return true;
    }

    private static bool IsNameStart(char c) => char.IsAsciiLetter(c) || c == '_' || c >= 0x80;

    private static bool IsName(char c) => IsNameStart(c) || char.IsAsciiDigit(c) || c == '-';

    private static bool ValidEscape(string s, int i) => i + 1 < s.Length && s[i] == '\\' && s[i + 1] is not ('\n' or '\r' or '\f');

    private static bool StartsIdent(string s, int i)
    {
        if (i >= s.Length) return false;
        if (s[i] == '-')
            return i + 1 < s.Length && (IsNameStart(s[i + 1]) || s[i + 1] == '-' || ValidEscape(s, i + 1));
        return IsNameStart(s[i]) || ValidEscape(s, i);
    }

    /// <summary>One escape at <paramref name="i"/> (the backslash): its code point and the index after it.</summary>
    private static (string Text, int End) ReadEscape(string s, int i)
    {
        var j = i + 1;
        if (j >= s.Length) return ("�", j);
        var hex = 0;
        while (hex < 6 && j + hex < s.Length && char.IsAsciiHexDigit(s[j + hex])) hex++;
        if (hex == 0) return (s[j].ToString(), j + 1);
        var code = int.Parse(s.AsSpan(j, hex), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var end = j + hex;
        if (end < s.Length && IsSpace(s[end])) end++;
        if (code == 0 || code > 0x10FFFF || code is >= 0xD800 and <= 0xDFFF) return ("�", end);
        return (char.ConvertFromUtf32(code), end);
    }

    private static (string Name, int End) ReadIdent(string s, int i)
    {
        var sb = new StringBuilder();
        while (i < s.Length)
        {
            if (IsName(s[i])) { sb.Append(s[i]); i++; continue; }
            if (ValidEscape(s, i)) { var (text, end) = ReadEscape(s, i); sb.Append(text); i = end; continue; }
            break;
        }
        return (sb.ToString(), i);
    }

    private static (string Value, int End) ReadString(string s, int i)
    {
        var quote = s[i];
        var sb = new StringBuilder();
        var j = i + 1;
        while (j < s.Length)
        {
            var c = s[j];
            if (c == quote) return (sb.ToString(), j + 1);
            if (c is '\n' or '\r' or '\f') return (sb.ToString(), j);   // a bad string ends at the newline
            if (c == '\\')
            {
                if (j + 1 >= s.Length) { j++; continue; }
                if (s[j + 1] is '\n' or '\r' or '\f') { j += 2; continue; }
                var (text, end) = ReadEscape(s, j);
                sb.Append(text); j = end; continue;
            }
            sb.Append(c); j++;
        }
        return (sb.ToString(), j);
    }

    private static (string Value, int End) ReadUrl(string s, int i)
    {
        var sb = new StringBuilder();
        var j = i;
        while (j < s.Length && s[j] != ')')
        {
            if (s[j] == '\\' && ValidEscape(s, j)) { var (text, end) = ReadEscape(s, j); sb.Append(text); j = end; continue; }
            sb.Append(s[j]); j++;
        }
        return (sb.ToString().Trim(), Math.Min(s.Length, j + 1));
    }

    private static int StatementEnd(string s, int i)
    {
        while (i < s.Length && s[i] != ';')
        {
            if (s[i] is '"' or '\'') { i = ReadString(s, i).End; continue; }
            i++;
        }
        return i;
    }

    private static IEnumerable<string> ImportTargets(string prelude)
    {
        var found = new List<string>();
        Read(prelude, found, rewrite: false, declarations: false, import: true);
        return found;
    }
}
