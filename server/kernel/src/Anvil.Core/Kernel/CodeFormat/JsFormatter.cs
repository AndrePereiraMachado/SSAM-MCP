using System.Text;

namespace Anvil.Core;

/// <summary>
/// Formatador conservador de JavaScript, so de espacos. Quebra a linha depois do <c>{</c> de um bloco (corpo de funcao, if,
/// for, while, try, else, arrow com chaves), depois de cada <c>;</c> fora de parenteses e antes do <c>}</c> de bloco; o
/// <c>}</c> fica na linha de <c>else</c>, <c>catch</c>, <c>finally</c>, <c>while</c>, <c>)</c>, <c>,</c>, <c>;</c> e <c>.</c>
/// que o seguem. Indenta 4 espacos por nivel aberto (uma linha que abre varios niveis indenta uma vez). Objetos literais
/// (<c>= {</c>, <c>({</c>, <c>return {</c>) nao sao partidos. As quebras de linha do original ficam (no maximo uma linha em
/// branco seguida); strings, template literals, expressoes regulares e comentarios passam byte a byte.
/// </summary>
public static class JsFormatter
{
    private const int Width = 4;

    internal enum Kind { Word, Str, Template, Regex, LineComment, BlockComment, Punct }

    internal sealed record Token(Kind Kind, string Text, int Newlines, bool SpaceBefore);

    private enum Frame { Block, Inline, Paren, Bracket }

    private static readonly HashSet<string> RegexAfterWords = new(StringComparer.Ordinal)
    { "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await" };
    private static readonly HashSet<string> BlockAfterWords = new(StringComparer.Ordinal) { "else", "try", "finally", "do" };
    private static readonly HashSet<string> SameLineAfterBlock = new(StringComparer.Ordinal) { "else", "catch", "finally", "while" };

    public static int Units(string text)
    {
        try { return Tokens(text).Count(t => t.Kind == Kind.Punct && t.Text is ";" or "{"); }
        catch (CodeFormatException) { return 0; }
    }

    public static string Format(string text)
    {
        var tokens = Tokens(text);
        var lines = new List<(int Indent, StringBuilder Text)>();
        var frames = new Stack<(Frame Kind, int Content)>();
        var blank = false; var breakPending = true;   // a primeira linha comeca no inicio

        StringBuilder Current() => lines[^1].Text;
        void Open(Token t, bool closer)
        {
            var indent = frames.Count == 0 ? 0 : closer ? Math.Max(0, frames.Peek().Content - 1) : frames.Peek().Content;
            if (lines.Count > 0 && Current().Length == 0) lines[^1] = (indent, lines[^1].Text);
            else
            {
                if (blank && lines.Count > 0) lines.Add((0, new StringBuilder()));
                lines.Add((indent, new StringBuilder()));
            }
            blank = false; breakPending = false;
        }
        void Emit(Token t, bool space)
        {
            var closer = t.Kind == Kind.Punct && t.Text is "}" or ")" or "]";
            if (breakPending || lines.Count == 0) Open(t, closer);
            else if (space && Current().Length > 0) Current().Append(' ');
            Current().Append(t.Text);
        }
        void RequestBreak(bool keepBlank = false) { breakPending = true; blank = blank || keepBlank; }
        Token? Next(int at) => at + 1 < tokens.Count ? tokens[at + 1] : null;
        Token? Previous(int at) => at > 0 ? tokens[at - 1] : null;

        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            // Uma quebra do original fica (e uma linha em branco, no maximo); comentario de linha sempre termina a linha.
            if (t.Newlines > 0 && i > 0) RequestBreak(t.Newlines > 1);
            if (t.Kind == Kind.Punct && t.Text == "{")
            {
                var block = IsBlock(tokens, i) && Next(i) is not { Kind: Kind.Punct, Text: "}" };
                var space = t.SpaceBefore || (block && !breakPending && lines.Count > 0 && Current().Length > 0 && Current()[^1] is not ('(' or ' '));
                Emit(t, space);
                frames.Push((block ? Frame.Block : Frame.Inline, lines[^1].Indent + 1));
                if (block && !(Next(i) is { Kind: Kind.LineComment or Kind.BlockComment, Newlines: 0 })) RequestBreak();
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text is "(" or "[")
            {
                Emit(t, t.SpaceBefore);
                frames.Push((t.Text == "(" ? Frame.Paren : Frame.Bracket, lines[^1].Indent + 1));
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text is "}" or ")" or "]")
            {
                if (frames.Count == 0) throw new CodeFormatException($"javascript: unexpected '{t.Text}'");
                var (kind, _) = frames.Peek();
                if (kind == Frame.Block && !breakPending && lines.Count > 0 && Current().Length > 0) RequestBreak();
                Emit(t, t.SpaceBefore);
                frames.Pop();
                if (kind == Frame.Block)
                {
                    var next = Next(i);
                    var sameLine = next == null || next.Newlines > 0
                        || next.Kind == Kind.Punct && next.Text is ")" or "," or ";" or "." or "(" or "]"
                        || next.Kind == Kind.Word && SameLineAfterBlock.Contains(next.Text)
                        || next.Kind is Kind.LineComment or Kind.BlockComment
                        // o '}' de um objeto literal que fecha logo a seguir a uma funcao dele: `} };`
                        || next.Kind == Kind.Punct && next.Text == "}" && frames.Count > 0 && frames.Peek().Kind == Frame.Inline;
                    if (!sameLine) RequestBreak();
                    else if (next is { Kind: Kind.Word } && SameLineAfterBlock.Contains(next.Text) && next.Newlines == 0) tokens[i + 1] = next with { SpaceBefore = true };
                }
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text == ";")
            {
                Emit(t, t.SpaceBefore);
                var inParens = frames.Count > 0 && frames.Peek().Kind is Frame.Paren or Frame.Bracket;
                if (!inParens && !(Next(i) is { Kind: Kind.LineComment or Kind.BlockComment, Newlines: 0 })) RequestBreak();
                continue;
            }
            if (t.Kind == Kind.LineComment)
            {
                Emit(t, t.SpaceBefore);
                RequestBreak();
                continue;
            }
            if (t.Kind == Kind.BlockComment && Previous(i) is { Kind: Kind.Punct, Text: ";" or "{" } && t.Newlines == 0)
            {
                Emit(t, t.SpaceBefore);
                var inParens = frames.Count > 0 && frames.Peek().Kind is Frame.Paren or Frame.Bracket;
                if (!inParens && Next(i) is { } after && after.Newlines == 0 && after.Kind != Kind.LineComment) RequestBreak();
                continue;
            }
            Emit(t, t.SpaceBefore);
        }
        if (frames.Count != 0) throw new CodeFormatException("javascript: unbalanced braces");
        var nl = CodeFormat.NewLine(text);
        return string.Join(nl, lines.Select(l => l.Text.Length == 0 ? "" : new string(' ', l.Indent * Width) + l.Text)).TrimEnd();
    }

    /// <summary>True quando o <c>{</c> em <paramref name="at"/> abre um bloco (e nao um objeto literal): vem depois de
    /// <c>)</c>, <c>=&gt;</c>, <c>else</c>/<c>try</c>/<c>finally</c>/<c>do</c>, ou no inicio de uma instrucao.</summary>
    private static bool IsBlock(List<Token> tokens, int at)
    {
        var p = at - 1;
        while (p >= 0 && tokens[p].Kind is Kind.LineComment or Kind.BlockComment) p--;
        if (p < 0) return true;
        var prev = tokens[p];
        if (prev.Kind == Kind.Punct)
        {
            if (prev.Text is ")" or ";" or "{" or "}") return true;
            if (prev.Text == ">" && p > 0 && tokens[p - 1] is { Kind: Kind.Punct, Text: "=" } && !tokens[p].SpaceBefore) return true;
            return false;
        }
        return prev.Kind == Kind.Word && BlockAfterWords.Contains(prev.Text);
    }

    /// <summary>Os tokens, cada um com as quebras de linha e o espaco antes dele. Strings, template literals (com
    /// <c>${...}</c> aninhados), expressoes regulares e comentarios sao um token so.</summary>
    internal static List<Token> Tokens(string text)
    {
        var tokens = new List<Token>(); var i = 0; var newlines = 0; var space = false;
        while (i < text.Length)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { if (c == '\n') newlines++; space = true; i++; continue; }
            var start = i; Kind kind;
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '/') { while (i < text.Length && text[i] != '\n' && text[i] != '\r') i++; kind = Kind.LineComment; }
            else if (c == '/' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0) throw new CodeFormatException("javascript: unterminated comment");
                i = end + 2; kind = Kind.BlockComment;
            }
            else if (c is '"' or '\'') { i = QuotedEnd(text, i); kind = Kind.Str; }
            else if (c == '`') { i = TemplateEnd(text, i); kind = Kind.Template; }
            else if (c == '/' && RegexAllowed(tokens)) { i = RegexEnd(text, i); kind = Kind.Regex; }
            else if (IsWord(c)) { while (i < text.Length && IsWord(text[i])) i++; kind = Kind.Word; }
            else { i++; kind = Kind.Punct; }
            tokens.Add(new Token(kind, text[start..i], newlines, space));
            newlines = 0; space = false;
        }
        return tokens;
    }

    private static bool RegexAllowed(List<Token> tokens)
    {
        for (var p = tokens.Count - 1; p >= 0; p--)
        {
            var t = tokens[p];
            if (t.Kind is Kind.LineComment or Kind.BlockComment) continue;
            if (t.Kind == Kind.Word) return RegexAfterWords.Contains(t.Text);
            if (t.Kind is Kind.Str or Kind.Template or Kind.Regex) return false;
            return t.Text is not (")" or "]" or "}");
        }
        return true;
    }

    private static bool IsWord(char c) => char.IsLetterOrDigit(c) || c is '_' or '$' || c > 127 && !char.IsWhiteSpace(c);

    private static int QuotedEnd(string text, int start)
    {
        var quote = text[start];
        for (var i = start + 1; i < text.Length; i++)
        {
            if (text[i] == '\\') { i++; continue; }
            if (text[i] == quote) return i + 1;
            if (text[i] == '\n') break;
        }
        throw new CodeFormatException("javascript: unterminated string");
    }

    private static int TemplateEnd(string text, int start)
    {
        for (var i = start + 1; i < text.Length; i++)
        {
            if (text[i] == '\\') { i++; continue; }
            if (text[i] == '`') return i + 1;
            if (text[i] == '$' && i + 1 < text.Length && text[i + 1] == '{') i = ExpressionEnd(text, i + 2) - 1;
        }
        throw new CodeFormatException("javascript: unterminated template literal");
    }

    /// <summary>O indice logo apos o <c>}</c> que fecha um <c>${</c> de template (strings, templates e comentarios dentro
    /// dele contam como texto).</summary>
    private static int ExpressionEnd(string text, int start)
    {
        var depth = 0;
        for (var i = start; i < text.Length; i++)
        {
            var c = text[i];
            if (c is '"' or '\'') { i = QuotedEnd(text, i) - 1; continue; }
            if (c == '`') { i = TemplateEnd(text, i) - 1; continue; }
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*') { var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); if (end < 0) break; i = end + 1; continue; }
            if (c == '{') depth++;
            else if (c == '}') { if (depth == 0) return i + 1; depth--; }
        }
        throw new CodeFormatException("javascript: unterminated template expression");
    }

    private static int RegexEnd(string text, int start)
    {
        var inClass = false;
        for (var i = start + 1; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\\') { i++; continue; }
            if (c == '\n') break;
            if (c == '[') inClass = true;
            else if (c == ']') inClass = false;
            else if (c == '/' && !inClass)
            {
                i++;
                while (i < text.Length && (char.IsLetter(text[i]))) i++;
                return i;
            }
        }
        throw new CodeFormatException("javascript: unterminated regular expression");
    }
}
