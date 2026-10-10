using System.Text;
using Esprima;
using Esprima.Utils;

namespace Anvil.Core;

/// <summary>
/// A prova da formatacao, corrida na hora da escrita e escrita SEM reaproveitar os lexers dos formatadores (um erro de
/// leitura comum aos dois passaria despercebido). Duas verificacoes:
/// <list type="number">
/// <item>Sem espacos: tirando todo espaco fora de strings, comentarios e literais (no SQL tambem fora de <c>[...]</c> e
/// <c>{...}</c>), os dois textos sao iguais.</item>
/// <item>Forma canonica, mais estrita (pega o espaco que muda o sentido, como <c>.a .b</c> contra <c>.a.b</c>). CSS: espacos
/// seguidos viram um; caem os vizinhos de <c>{ } ; ,</c>, os do primeiro <c>:</c> de uma declaracao e os de um comentario
/// no inicio de uma instrucao. SQL: espacos seguidos viram um; caem os vizinhos de <c>( ) , ;</c>; um comentario <c>--</c>
/// termina sempre a linha. JavaScript: o programa lido pelo Esprima (arvore, tokens e comentarios, sem posicoes) e o mesmo,
/// o que cobre tambem a insercao automatica de <c>;</c>.</item>
/// </list>
/// Devolve null quando os textos sao equivalentes, ou o motivo da recusa.
/// </summary>
public static class CodeEquivalence
{
    public static string? Check(CodeLanguage language, string original, string formatted) => language switch
    {
        CodeLanguage.Css => Compare("css", Css(original, strip: true), Css(formatted, strip: true), Css(original, strip: false), Css(formatted, strip: false)),
        CodeLanguage.Sql => Compare("sql", Sql(original, strip: true), Sql(formatted, strip: true), Sql(original, strip: false), Sql(formatted, strip: false)),
        _ => JavaScript(original, formatted),
    };

    private static string? Compare(string language, string strippedA, string strippedB, string canonicalA, string canonicalB)
    {
        if (strippedA != strippedB) return $"{language}: the formatted text differs from the original outside whitespace (at character {Diverge(strippedA, strippedB)})";
        if (canonicalA != canonicalB) return $"{language}: the formatted text changes significant whitespace (at character {Diverge(canonicalA, canonicalB)} of the canonical form)";
        return null;
    }

    private static int Diverge(string a, string b)
    {
        var n = Math.Min(a.Length, b.Length);
        for (var i = 0; i < n; i++) if (a[i] != b[i]) return i;
        return n;
    }

    // ---- CSS ----------------------------------------------------------------------------------------------------------

    private enum CssKind { Space, Comment, Text, Char }

    /// <summary>A forma canonica (ou, com <paramref name="strip"/>, o texto sem espaco nenhum) de um CSS.</summary>
    public static string Css(string text, bool strip)
    {
        var tokens = new List<(CssKind Kind, string Text)>();
        for (var i = 0; i < text.Length;)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { while (i < text.Length && char.IsWhiteSpace(text[i])) i++; tokens.Add((CssKind.Space, " ")); continue; }
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); end = end < 0 ? text.Length : end + 2;
                tokens.Add((CssKind.Comment, text[i..end])); i = end; continue;
            }
            if (c is '"' or '\'')
            {
                var j = i + 1;
                while (j < text.Length && text[j] != c) j += text[j] == '\\' ? 2 : 1;
                j = Math.Min(j + 1, text.Length);
                tokens.Add((CssKind.Text, text[i..j])); i = j; continue;
            }
            tokens.Add((CssKind.Char, c.ToString())); i++;
        }
        if (strip) return string.Concat(tokens.Where(t => t.Kind != CssKind.Space).Select(t => t.Text));

        var output = new StringBuilder(); var statement = new List<(CssKind Kind, string Text)>(); var depth = 0;
        foreach (var token in tokens)
        {
            if (token.Kind == CssKind.Char && depth <= 0 && token.Text is "{" or "}" or ";") { CssStatement(statement, token.Text, output); statement.Clear(); continue; }
            if (token.Kind == CssKind.Char && token.Text is "(" or "[") depth++;
            else if (token.Kind == CssKind.Char && token.Text is ")" or "]") depth--;
            statement.Add(token);
        }
        CssStatement(statement, "", output);
        return output.ToString();
    }

    private static void CssStatement(List<(CssKind Kind, string Text)> statement, string terminator, StringBuilder output)
    {
        var k = 0;
        for (; k < statement.Count && statement[k].Kind is CssKind.Space or CssKind.Comment; k++)
            if (statement[k].Kind == CssKind.Comment) output.Append(statement[k].Text);
        var body = new List<(CssKind Kind, string Text)>();
        foreach (var token in statement.Skip(k))
            if (token.Kind != CssKind.Space || body.Count == 0 || body[^1].Kind != CssKind.Space) body.Add(token);
        while (body.Count > 0 && body[^1].Kind == CssKind.Space) body.RemoveAt(body.Count - 1);
        var drop = new HashSet<int>();
        void DropAround(int at) { if (at > 0 && body[at - 1].Kind == CssKind.Space) drop.Add(at - 1); if (at + 1 < body.Count && body[at + 1].Kind == CssKind.Space) drop.Add(at + 1); }
        if (terminator is ";" or "}" && body.Count > 0 && !body[0].Text.StartsWith('@'))
        {
            var depth = 0;
            for (var i = 0; i < body.Count; i++)
            {
                if (body[i].Kind != CssKind.Char) continue;
                if (body[i].Text is "(" or "[") depth++;
                else if (body[i].Text is ")" or "]") depth--;
                else if (body[i].Text == ":" && depth == 0) { DropAround(i); break; }
            }
        }
        for (var i = 0; i < body.Count; i++) if (body[i] is (CssKind.Char, ",")) DropAround(i);
        for (var i = 0; i < body.Count; i++) if (!drop.Contains(i)) output.Append(body[i].Text);
        output.Append(terminator);
    }

    // ---- SQL ----------------------------------------------------------------------------------------------------------

    /// <summary>A forma canonica (ou, com <paramref name="strip"/>, o texto sem espaco nenhum) de um SQL.</summary>
    public static string Sql(string text, bool strip)
    {
        var output = new StringBuilder(); var space = false; var afterLineComment = false;
        void Put(string token, bool glue)
        {
            if (!strip && space && !afterLineComment && output.Length > 0 && !glue && output[^1] is not ('(' or ')' or ',' or ';')) output.Append(' ');
            output.Append(token); space = false; afterLineComment = false;
        }
        for (var i = 0; i < text.Length;)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { space = true; i++; continue; }
            int end;
            if (c == '-' && i + 1 < text.Length && text[i + 1] == '-')
            {
                end = i; while (end < text.Length && text[end] != '\n' && text[end] != '\r') end++;
                Put(text[i..end], false); if (!strip) output.Append('\n'); afterLineComment = true; i = end; continue;
            }
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*') { end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); end = end < 0 ? text.Length : end + 2; }
            else if (c is '\'' or '"')
            {
                end = i + 1;
                while (end < text.Length) { if (text[end] == c) { if (end + 1 < text.Length && text[end + 1] == c) { end += 2; continue; } end++; break; } end++; }
            }
            else if (c is '[' or '{') { end = text.IndexOf(c == '[' ? ']' : '}', i + 1); end = end < 0 ? text.Length : end + 1; }
            else end = i + 1;
            Put(text[i..end], c is '(' or ')' or ',' or ';');
            i = end;
        }
        return output.ToString();
    }

    // ---- JavaScript -----------------------------------------------------------------------------------------------------

    private static readonly AstToJsonOptions JsonOptions = new() { IncludeTokens = true, IncludeComments = true, IncludeLineColumn = false, IncludeRange = false };

    private static string? JavaScript(string original, string formatted)
    {
        string? a, b;
        try { a = Program(original); }
        catch (ParserException ex) { return "javascript: the original text does not parse (" + ex.Description + "), so its equivalence cannot be proved"; }
        try { b = Program(formatted); }
        catch (ParserException ex) { return "javascript: the formatted text does not parse (" + ex.Description + ")"; }
        return a == b ? null : "javascript: the formatted text is not the same program (syntax tree, tokens or comments differ)";
    }

    /// <summary>O programa como JSON sem posicoes. O texto e o corpo de uma funcao assincrona: um no JavaScript do OutSystems
    /// pode ter <c>return</c> e <c>await</c> no topo.</summary>
    private static string Program(string code)
    {
        var parser = new JavaScriptParser(new ParserOptions { Tokens = true, Comments = true, Tolerant = false, RegExpParseMode = RegExpParseMode.Skip });
        var program = parser.ParseScript("async function __ssamFormat__() {\n" + code + "\n}");
        return AstToJson.ToJsonString(program, JsonOptions);
    }
}
