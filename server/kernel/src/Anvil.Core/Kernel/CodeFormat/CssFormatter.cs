using System.Text;

namespace Anvil.Core;

/// <summary>
/// Formatador de CSS, so de espacos. Uma lista de seletores por regra com <c>{</c> na linha do seletor (um seletor por linha
/// quando a lista passa de 120 colunas), uma declaracao por linha indentada 4 espacos (<c>propriedade: valor</c>), <c>}</c>
/// sozinha, linha em branco entre regras, @media/@supports/@keyframes e aninhamento indentados. Strings e comentarios
/// passam byte a byte; um comentario solto fica na sua linha, um comentario logo apos <c>;</c> ou <c>{</c> na mesma linha
/// continua nela. A ultima declaracao sem <c>;</c> fica sem <c>;</c> (nunca se acrescenta nem se tira um caractere que
/// nao seja espaco).
/// </summary>
public static class CssFormatter
{
    private const int Width = 4;

    private enum Item { None, Declaration, Block, Comment }

    public static int Units(string text)
    {
        var units = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*') { var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); if (end < 0) break; i = end + 1; continue; }
            if (c is '"' or '\'') { i = StringEnd(text, i) - 1; continue; }
            if (c is ';' or '}') units++;
        }
        return units;
    }

    public static string Format(string text)
    {
        var lines = new List<string>();
        var kinds = new Stack<Item>(); kinds.Push(Item.None);
        var statement = new StringBuilder(); var space = false;
        var parens = 0; var lastItemLine = -1; var newlineSinceItem = true;

        string Pad() => new(' ', (kinds.Count - 1) * Width);
        void Blank(Item next)
        {
            var previous = kinds.Peek();
            if (previous != Item.None && (previous == Item.Block || (next == Item.Block && previous != Item.Comment))) lines.Add("");
            kinds.Pop(); kinds.Push(next);
        }
        void Append(string token)
        {
            if (space && statement.Length > 0) statement.Append(' ');
            space = false; statement.Append(token);
        }
        void Declaration(string terminator)
        {
            var body = statement.ToString().Trim();
            statement.Clear(); space = false;
            if (body.Length == 0 && terminator.Length == 0) return;
            Blank(Item.Declaration);
            lines.Add(Pad() + SplitDeclaration(body) + terminator);
            lastItemLine = lines.Count - 1; newlineSinceItem = false;
        }

        var i = 0;
        while (i < text.Length)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c))
            {
                var start = i; while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
                if (text.AsSpan(start, i - start).Contains('\n')) newlineSinceItem = true;
                space = true; continue;
            }
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0) throw new CodeFormatException("css: unterminated comment");
                var comment = text[i..(end + 2)]; i = end + 2;
                if (statement.Length > 0) { Append(comment); continue; }
                if (!newlineSinceItem && lastItemLine >= 0) lines[lastItemLine] += " " + comment;
                else { Blank(Item.Comment); lines.Add(Pad() + comment); lastItemLine = lines.Count - 1; }
                newlineSinceItem = false; space = false; continue;
            }
            if (c is '"' or '\'')
            {
                var end = StringEnd(text, i);
                if (end > text.Length) throw new CodeFormatException("css: unterminated string");
                Append(text[i..end]); i = end; continue;
            }
            i++;
            if (c is '(' or '[') { parens++; Append(c.ToString()); continue; }
            if (c is ')' or ']') { parens--; Append(c.ToString()); continue; }
            if (parens > 0) { Append(c.ToString()); continue; }
            if (c == '{')
            {
                var prelude = statement.ToString().Trim(); statement.Clear(); space = false;
                Blank(Item.Block);
                var header = Prelude(prelude, (kinds.Count - 1) * Width);
                for (var h = 0; h < header.Count; h++)
                    lines.Add(Pad() + header[h] + (h == header.Count - 1 ? (header[h].Length > 0 ? " {" : "{") : ""));
                lastItemLine = lines.Count - 1; newlineSinceItem = false;
                kinds.Push(Item.None);
                continue;
            }
            if (c == ';') { Declaration(";"); continue; }
            if (c == '}')
            {
                Declaration("");
                if (kinds.Count == 1) throw new CodeFormatException("css: unexpected '}'");
                kinds.Pop();
                lines.Add(Pad() + "}");
                // Um comentario logo depois de '}' abre a regra seguinte (CSS minificado): vai para a sua linha.
                lastItemLine = -1; newlineSinceItem = false;
                continue;
            }
            Append(c.ToString());
        }
        if (parens != 0) throw new CodeFormatException("css: unbalanced parentheses or brackets");
        if (kinds.Count != 1) throw new CodeFormatException("css: unterminated block");
        if (statement.ToString().Trim().Length > 0) { Blank(Item.Declaration); lines.Add(statement.ToString().Trim()); }
        return string.Join(CodeFormat.NewLine(text), lines);
    }

    /// <summary>A declaracao <c>propriedade: valor</c>, partida no primeiro <c>:</c> de topo; at-rules e textos sem
    /// <c>:</c> ficam como estao.</summary>
    private static string SplitDeclaration(string body)
    {
        if (body.StartsWith('@')) return body;
        var colon = TopLevel(body, ':').FirstOrDefault(-1);
        if (colon < 0) return body;
        var property = body[..colon].TrimEnd(); var value = body[(colon + 1)..].TrimStart();
        return value.Length > 0 ? property + ": " + value : property + ":";
    }

    /// <summary>As linhas do cabecalho de uma regra: a lista de seletores com <c>", "</c>, ou um seletor por linha quando
    /// a lista nao cabe em 120 colunas. Um at-rule fica como esta.</summary>
    private static List<string> Prelude(string prelude, int indent)
    {
        if (prelude.StartsWith('@')) return [prelude];
        var commas = TopLevel(prelude, ',').ToList();
        if (commas.Count == 0) return [prelude];
        var parts = new List<string>(); var start = 0;
        foreach (var comma in commas) { parts.Add(prelude[start..comma].Trim()); start = comma + 1; }
        parts.Add(prelude[start..].Trim());
        var joined = string.Join(", ", parts);
        if (indent + joined.Length + 2 <= CodeFormat.LongLine) return [joined];
        return parts.Select((p, n) => n < parts.Count - 1 ? p + "," : p).ToList();
    }

    /// <summary>As posicoes de <paramref name="mark"/> fora de strings, comentarios, parenteses e colchetes.</summary>
    private static IEnumerable<int> TopLevel(string text, char mark)
    {
        var depth = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*') { var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); if (end < 0) yield break; i = end + 1; continue; }
            if (c is '"' or '\'') { i = StringEnd(text, i) - 1; continue; }
            if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth--;
            else if (c == mark && depth == 0) yield return i;
        }
    }

    /// <summary>O indice logo apos a aspa que fecha a string que abre em <paramref name="start"/> (Length + 1 sem fecho).</summary>
    internal static int StringEnd(string text, int start)
    {
        var quote = text[start];
        for (var i = start + 1; i < text.Length; i++)
        {
            if (text[i] == '\\') { i++; continue; }
            if (text[i] == quote) return i + 1;
        }
        return text.Length + 1;
    }
}
