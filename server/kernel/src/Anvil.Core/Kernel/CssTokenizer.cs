using System.Globalization;
using System.Text;

namespace Anvil.Core;

/// <summary>
/// R2-D, round 3 of the review: the tokenizer of CSS Syntax Level 3 (section 4), the one reader of what two pieces of CSS mean
/// for the shadowed stage. Input preprocessing as the spec (CR LF, CR and FF are LF; NUL is U+FFFD); tokens ident, function,
/// at-keyword, hash, string, url, delim, number, percentage, dimension, whitespace, CDO, CDC, colon, semicolon, comma and the
/// six brackets; comments are consumed and make no token. A string, an ident or a url holds its value with every escape
/// decoded (compared by code point). <see cref="Result.Clean"/> is false on anything the spec calls a parse error that changes
/// what a browser keeps: a bad string, a bad url, an unterminated comment, string or url, a backslash that escapes nothing.
/// Whitespace is only space, tab and line feed (after preprocessing). Pure.
/// </summary>
public static class CssTokenizer
{
    public enum Kind { Ident, Function, AtKeyword, Hash, String, Url, Delim, Number, Percentage, Dimension, Whitespace, Cdo, Cdc, Colon, Semicolon, Comma, OpenSquare, CloseSquare, OpenParen, CloseParen, OpenCurly, CloseCurly }

    /// <summary>One token: its kind and its value (the decoded name or text; a delim's character; a number's representation,
    /// a hash's type flag ("id" or "unrestricted") and a dimension's unit, ASCII lower case, in <see cref="Unit"/>). Every field the spec
    /// gives a token is in the token, so two tokens are equal only when the browser reads them the same.</summary>
    public readonly record struct Token(Kind Kind, string Value, string Unit = "")
    {
        public bool Is(Kind kind, string value) => Kind == kind && Value == value;
        public bool IsDelim(char c) => Kind == Kind.Delim && Value.Length == 1 && Value[0] == c;
    }

    public sealed record Result(List<Token> Tokens, bool Clean);

    public static Result Tokenize(string text)
    {
        var input = Preprocess(text ?? "");
        var reader = new Reader(input);
        var tokens = new List<Token>();
        while (reader.Next() is { } token) tokens.Add(token);
        return new Result(tokens, reader.Clean);
    }

    /// <summary>The key of a token list: injective (each value length-prefixed), so two lists have the same key only when they
    /// are the same tokens.</summary>
    public static string Key(IEnumerable<Token> tokens)
    {
        var sb = new StringBuilder();
        foreach (var t in tokens)
            sb.Append((int)t.Kind).Append(':').Append(t.Value.Length).Append(':').Append(t.Value).Append(':').Append(t.Unit.Length).Append(':').Append(t.Unit).Append(';');
        return sb.ToString();
    }

    /// <summary>ASCII case folding only (A-Z to a-z): CSS is ASCII case-insensitive, never Unicode (U+212A, the Kelvin sign, is no k).</summary>
    public static string AsciiLower(string text)
    {
        if (!text.Any(c => c is >= 'A' and <= 'Z')) return text;
        var chars = text.ToCharArray();
        for (var i = 0; i < chars.Length; i++) if (chars[i] is >= 'A' and <= 'Z') chars[i] = (char)(chars[i] + 32);
        return new string(chars);
    }

    private static string Preprocess(string text)
    {
        if (text.IndexOfAny(['\r', '\f', '\0']) < 0) return text;
        var sb = new StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\r') { sb.Append('\n'); if (i + 1 < text.Length && text[i + 1] == '\n') i++; }
            else if (c == '\f') sb.Append('\n');
            else if (c == '\0') sb.Append('�');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    private sealed class Reader(string s)
    {
        private int _i;
        public bool Clean { get; private set; } = true;
        private char At(int ahead = 0) => _i + ahead < s.Length ? s[_i + ahead] : '\0';
        private bool Eof(int ahead = 0) => _i + ahead >= s.Length;

        private static bool Space(char c) => c is ' ' or '\t' or '\n';
        private static bool Digit(char c) => c is >= '0' and <= '9';
        private static bool Hex(char c) => Digit(c) || c is >= 'a' and <= 'f' || c is >= 'A' and <= 'F';
        private static bool NameStart(char c) => c is >= 'a' and <= 'z' || c is >= 'A' and <= 'Z' || c == '_' || c >= '\u0080';
        private static bool NameChar(char c) => NameStart(c) || Digit(c) || c == '-';
        private static bool NonPrintable(char c) => c is <= '\u0008' or '\u000B' or (>= '\u000E' and <= '\u001F') or '\u007F';

        private bool ValidEscape(int at) => !Eof(at) && s[_i + at] == '\\' && (Eof(at + 1) || s[_i + at + 1] != '\n');
        private bool StartsIdent(int at)
        {
            if (Eof(at)) return false;
            var c = s[_i + at];
            if (c == '-') return !Eof(at + 1) && (NameStart(s[_i + at + 1]) || s[_i + at + 1] == '-') || ValidEscape(at + 1);
            if (NameStart(c)) return true;
            return c == '\\' && ValidEscape(at);
        }
        private bool StartsNumber(int at)
        {
            if (Eof(at)) return false;
            var c = s[_i + at];
            if (c is '+' or '-') return !Eof(at + 1) && (Digit(s[_i + at + 1]) || s[_i + at + 1] == '.' && !Eof(at + 2) && Digit(s[_i + at + 2]));
            if (c == '.') return !Eof(at + 1) && Digit(s[_i + at + 1]);
            return Digit(c);
        }

        public Token? Next()
        {
            while (!Eof() && At() == '/' && At(1) == '*')
            {
                var end = s.IndexOf("*/", _i + 2, StringComparison.Ordinal);
                if (end < 0) { Clean = false; _i = s.Length; return null; }
                _i = end + 2;
            }
            if (Eof()) return null;
            var c = At();
            if (Space(c)) { while (!Eof() && Space(At())) _i++; return new Token(Kind.Whitespace, " "); }
            if (c is '"' or '\'') { _i++; return String(c); }
            if (c == '#')
            {
                // The type flag (4.3.1): "id" when what follows the # would start an ident (only such a hash is an id selector).
                if (!Eof(1) && NameChar(At(1)) || ValidEscape(1)) { var id = StartsIdent(1); _i++; return new Token(Kind.Hash, Name(), id ? "id" : "unrestricted"); }
                _i++; return new Token(Kind.Delim, "#");
            }
            switch (c)
            {
                case '(': _i++; return new Token(Kind.OpenParen, "(");
                case ')': _i++; return new Token(Kind.CloseParen, ")");
                case '[': _i++; return new Token(Kind.OpenSquare, "[");
                case ']': _i++; return new Token(Kind.CloseSquare, "]");
                case '{': _i++; return new Token(Kind.OpenCurly, "{");
                case '}': _i++; return new Token(Kind.CloseCurly, "}");
                case ',': _i++; return new Token(Kind.Comma, ",");
                case ':': _i++; return new Token(Kind.Colon, ":");
                case ';': _i++; return new Token(Kind.Semicolon, ";");
            }
            if (c is '+' or '.' && StartsNumber(0)) return Numeric();
            if (c == '-')
            {
                if (StartsNumber(0)) return Numeric();
                if (At(1) == '-' && At(2) == '>') { _i += 3; return new Token(Kind.Cdc, "-->"); }
                if (StartsIdent(0)) return IdentLike();
            }
            if (c == '<' && At(1) == '!' && At(2) == '-' && At(3) == '-') { _i += 4; return new Token(Kind.Cdo, "<!--"); }
            if (c == '@' && StartsIdent(1)) { _i++; return new Token(Kind.AtKeyword, Name()); }
            if (c == '\\')
            {
                if (ValidEscape(0)) return IdentLike();
                Clean = false; _i++; return new Token(Kind.Delim, "\\");
            }
            if (Digit(c)) return Numeric();
            if (NameStart(c)) return IdentLike();
            _i++;
            return new Token(Kind.Delim, c.ToString());
        }

        private string Name()
        {
            var sb = new StringBuilder();
            while (!Eof())
            {
                if (NameChar(At())) { sb.Append(At()); _i++; }
                else if (ValidEscape(0)) { _i++; sb.Append(Escape()); }
                else break;
            }
            return sb.ToString();
        }

        // After the backslash: a hex escape (1 to 6 digits and one whitespace after them) or the next code point itself.
        private string Escape()
        {
            if (Eof()) return "�";
            if (Hex(At()))
            {
                var start = _i;
                while (!Eof() && _i - start < 6 && Hex(At())) _i++;
                var value = int.Parse(s[start.._i], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                if (!Eof() && Space(At())) _i++;
                return value == 0 || value is >= 0xD800 and <= 0xDFFF || value > 0x10FFFF ? "�" : char.ConvertFromUtf32(value);
            }
            var c = At();
            _i++;
            return c.ToString();
        }

        private Token String(char quote)
        {
            var sb = new StringBuilder();
            while (true)
            {
                if (Eof()) { Clean = false; return new Token(Kind.String, sb.ToString()); }
                var c = At();
                if (c == quote) { _i++; return new Token(Kind.String, sb.ToString()); }
                if (c == '\n') { Clean = false; return new Token(Kind.String, sb.ToString()); }   // a bad string
                if (c == '\\')
                {
                    if (Eof(1)) { _i++; continue; }
                    if (At(1) == '\n') { _i += 2; continue; }
                    _i++; sb.Append(Escape()); continue;
                }
                sb.Append(c); _i++;
            }
        }

        private Token Numeric()
        {
            var start = _i;
            if (At() is '+' or '-') _i++;
            while (!Eof() && Digit(At())) _i++;
            if (At() == '.' && !Eof(1) && Digit(At(1))) { _i++; while (!Eof() && Digit(At())) _i++; }
            if (At() is 'e' or 'E' && (!Eof(1) && Digit(At(1)) || At(1) is '+' or '-' && !Eof(2) && Digit(At(2))))
            {
                _i += 2;
                while (!Eof() && Digit(At())) _i++;
            }
            var repr = s[start.._i];
            // A unit is ASCII case-insensitive (10PX is 10px): folded so; the number keeps its representation (sign, integer or not).
            if (StartsIdent(0)) return new Token(Kind.Dimension, repr, AsciiLower(Name()));
            if (At() == '%') { _i++; return new Token(Kind.Percentage, repr); }
            return new Token(Kind.Number, repr);
        }

        private Token IdentLike()
        {
            var name = Name();
            if (AsciiLower(name) == "url" && At() == '(')
            {
                _i++;
                while (Space(At()) && Space(At(1))) _i++;
                if (At() is '"' or '\'' || Space(At()) && At(1) is '"' or '\'') return new Token(Kind.Function, name);
                return Url();
            }
            if (At() == '(') { _i++; return new Token(Kind.Function, name); }
            return new Token(Kind.Ident, name);
        }

        private Token Url()
        {
            var sb = new StringBuilder();
            while (!Eof() && Space(At())) _i++;
            while (true)
            {
                if (Eof()) { Clean = false; return new Token(Kind.Url, sb.ToString()); }
                var c = At();
                if (c == ')') { _i++; return new Token(Kind.Url, sb.ToString()); }
                if (Space(c))
                {
                    while (!Eof() && Space(At())) _i++;
                    if (Eof()) { Clean = false; return new Token(Kind.Url, sb.ToString()); }
                    if (At() == ')') { _i++; return new Token(Kind.Url, sb.ToString()); }
                    return BadUrl();
                }
                if (c is '"' or '\'' or '(' || NonPrintable(c)) return BadUrl();
                if (c == '\\')
                {
                    if (!ValidEscape(0)) return BadUrl();
                    _i++; sb.Append(Escape()); continue;
                }
                sb.Append(c); _i++;
            }
        }

        private Token BadUrl()
        {
            Clean = false;
            while (!Eof())
            {
                if (At() == ')') { _i++; break; }
                if (ValidEscape(0)) { _i++; Escape(); continue; }
                _i++;
            }
            return new Token(Kind.Url, "� bad url");
        }
    }
}
