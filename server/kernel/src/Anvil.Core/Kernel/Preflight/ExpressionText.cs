using System.Text;

namespace Anvil.Core.Preflight;

public enum TokenKind { Text, Date, Number, Name, Open, Close, OpenIndex, CloseIndex, Comma, Operator, Other }

/// <summary>One token of an OutSystems expression. A Name is a whole dotted path (`GetX.List.Current.Ticket.Title`);
/// a path that follows an index (`List[0].Name`) starts with '.'.</summary>
public sealed record Token(TokenKind Kind, string Text, int Start)
{
    public string[] Segments => Text.TrimStart('.').Split('.', StringSplitOptions.RemoveEmptyEntries);
    public bool Is(string text) => string.Equals(Text, text, StringComparison.OrdinalIgnoreCase);
}

/// <summary>A function call in an expression: the name, its argument texts (top level commas) and the tokens of each.</summary>
public sealed record Call(string Name, int NameIndex, IReadOnlyList<string> Arguments, IReadOnlyList<IReadOnlyList<Token>> ArgumentTokens, string Inner);

/// <summary>
/// The lexical view of an OutSystems expression the preflight rules read: strings ("..." with "" escapes) and date
/// literals (#...#) are single tokens, so nothing inside them is ever read as a name, an operator or a call.
/// </summary>
public static class ExpressionText
{
    private static readonly HashSet<string> WordOperators = new(StringComparer.OrdinalIgnoreCase) { "and", "or", "not", "like" };

    public static List<Token> Tokens(string text)
    {
        var tokens = new List<Token>();
        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            var start = i;
            if (c == '"')
            {
                i++;
                while (i < text.Length)
                {
                    if (text[i] == '"' && i + 1 < text.Length && text[i + 1] == '"') { i += 2; continue; }
                    if (text[i] == '"') { i++; break; }
                    i++;
                }
                tokens.Add(new(TokenKind.Text, text[start..i], start));
                continue;
            }
            if (c == '#')
            {
                var end = text.IndexOf('#', i + 1);
                i = end < 0 ? text.Length : end + 1;
                tokens.Add(new(TokenKind.Date, text[start..i], start));
                continue;
            }
            if (char.IsDigit(c))
            {
                while (i < text.Length && (char.IsDigit(text[i]) || text[i] == '.' && i + 1 < text.Length && char.IsDigit(text[i + 1]))) i++;
                tokens.Add(new(TokenKind.Number, text[start..i], start));
                continue;
            }
            if (char.IsLetter(c) || c == '_' || c == '.' && i + 1 < text.Length && (char.IsLetter(text[i + 1]) || text[i + 1] == '_') && tokens.Count > 0 && tokens[^1].Kind == TokenKind.CloseIndex)
            {
                var sb = new StringBuilder();
                if (c == '.') { sb.Append('.'); i++; }
                while (i < text.Length)
                {
                    if (char.IsLetterOrDigit(text[i]) || text[i] == '_') { sb.Append(text[i]); i++; continue; }
                    if (text[i] == '.' && i + 1 < text.Length && (char.IsLetter(text[i + 1]) || text[i + 1] == '_')) { sb.Append('.'); i++; continue; }
                    break;
                }
                var word = sb.ToString();
                tokens.Add(new(WordOperators.Contains(word) || IsModOperator(text, i, word, tokens) ? TokenKind.Operator : TokenKind.Name, word, start));
                continue;
            }
            switch (c)
            {
                case '(': tokens.Add(new(TokenKind.Open, "(", start)); i++; continue;
                case ')': tokens.Add(new(TokenKind.Close, ")", start)); i++; continue;
                case '[': tokens.Add(new(TokenKind.OpenIndex, "[", start)); i++; continue;
                case ']': tokens.Add(new(TokenKind.CloseIndex, "]", start)); i++; continue;
                case ',': tokens.Add(new(TokenKind.Comma, ",", start)); i++; continue;
            }
            if (c is '<' or '>')
            {
                var two = i + 1 < text.Length ? text.Substring(i, 2) : "";
                if (two is "<=" or ">=" or "<>") { tokens.Add(new(TokenKind.Operator, two, start)); i += 2; continue; }
                tokens.Add(new(TokenKind.Operator, c.ToString(), start)); i++; continue;
            }
            if (c is '+' or '-' or '*' or '/' or '=')
            {
                tokens.Add(new(TokenKind.Operator, c.ToString(), start)); i++; continue;
            }
            tokens.Add(new(TokenKind.Other, c.ToString(), start)); i++;
        }
        return tokens;
    }

    /// <summary>`mod` written between two operands (`i mod 3`): the operator other languages have and OutSystems does not (the
    /// Verify answers ParserUnexpectedElement; ODC "Expecting an expression"). A token, so no rule reads it as a name; `Mod(`
    /// (the built-in: it never follows an operand), `X.mod` and a variable named mod elsewhere stay names.</summary>
    private static bool IsModOperator(string text, int end, string word, List<Token> before)
    {
        if (!word.Equals("mod", StringComparison.OrdinalIgnoreCase) || before.Count == 0
            || before[^1].Kind is not (TokenKind.Name or TokenKind.Number or TokenKind.Text or TokenKind.Date or TokenKind.Close or TokenKind.CloseIndex)) return false;
        var next = end;
        while (next < text.Length && char.IsWhiteSpace(text[next])) next++;
        return next < text.Length && text[next] is not ('.' or ')' or ',' or ']');
    }

    /// <summary>Every call `Name(...)` with its top-level arguments (an empty list for `Name()`).</summary>
    public static List<Call> Calls(string text, List<Token>? tokens = null)
    {
        tokens ??= Tokens(text);
        var calls = new List<Call>();
        for (var k = 0; k + 1 < tokens.Count; k++)
        {
            if (tokens[k].Kind != TokenKind.Name || tokens[k].Text.Contains('.') || tokens[k + 1].Kind != TokenKind.Open) continue;
            var depth = 0; var args = new List<List<Token>> { new() }; var close = -1;
            for (var j = k + 2; j < tokens.Count; j++)
            {
                var t = tokens[j];
                if (t.Kind is TokenKind.Open or TokenKind.OpenIndex) depth++;
                else if (t.Kind is TokenKind.Close or TokenKind.CloseIndex)
                {
                    if (depth == 0) { close = j; break; }
                    depth--;
                }
                else if (t.Kind == TokenKind.Comma && depth == 0) { args.Add(new()); continue; }
                args[^1].Add(t);
            }
            if (close < 0) continue;   // unbalanced: the Studio's parser judges it
            var innerStart = tokens[k + 1].Start + 1;
            var inner = text[innerStart..tokens[close].Start];
            if (args.Count == 1 && args[0].Count == 0) args.Clear();
            calls.Add(new Call(tokens[k].Text, k, args.Select(a => a.Count == 0 ? "" : text[a[0].Start..End(a[^1])].Trim()).ToArray(), args, inner));
        }
        return calls;
    }

    private static int End(Token t) => t.Start + t.Text.Length;

    /// <summary>The first segment of a path token that starts a reference: not a continuation after an index.</summary>
    public static bool IsRoot(List<Token> tokens, int index) => tokens[index].Kind == TokenKind.Name && !tokens[index].Text.StartsWith('.')
        && !(index + 1 < tokens.Count && tokens[index + 1].Kind == TokenKind.Open) && !Continues(tokens, index);

    /// <summary>A name that continues a path after a call or an index (`F(x).Name`, `L[0].Name`): not a whole operand.</summary>
    public static bool Continues(List<Token> tokens, int index) => index > 0 && (tokens[index - 1].Kind == TokenKind.CloseIndex
        || tokens[index - 1].Kind == TokenKind.Other && tokens[index - 1].Text == ".");
}
