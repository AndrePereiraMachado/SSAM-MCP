using System.Text;

namespace Anvil.Core;

/// <summary>
/// Formatador do SQL do OutSystems, so de espacos. SELECT, FROM, cada JOIN, WHERE, GROUP BY, HAVING, ORDER BY, UNION/EXCEPT/
/// INTERSECT (e INSERT/UPDATE/DELETE/SET/VALUES/WITH/OFFSET/FETCH/LIMIT) abrem linha no nivel da consulta; as colunas do
/// SELECT ficam uma por linha, indentadas 4 espacos; ON e cada AND/OR de WHERE, HAVING e ON abrem linha indentada (o AND de
/// um BETWEEN e os de dentro de CASE e de parenteses nao); uma subconsulta <c>(SELECT ...)</c> e indentada sob a linha do
/// seu parentese e o <c>)</c> fecha na coluna dessa linha. <c>{Entidade}</c>, <c>[Atributo]</c>, <c>@Parametro</c>, strings,
/// identificadores entre aspas e comentarios passam byte a byte; a caixa das palavras nunca muda. Entre dois tokens na mesma
/// linha fica um espaco quando o original tinha espaco e nenhum quando nao tinha.
/// </summary>
public static class SqlFormatter
{
    private const int Width = 4;

    private enum Kind { Word, Literal, LineComment, BlockComment, Punct }

    private sealed record Token(Kind Kind, string Text, bool SpaceBefore)
    {
        public string Upper => Kind == Kind.Word ? Text.ToUpperInvariant() : "";
    }

    private enum Clause { None, Select, From, Join, On, Where, GroupBy, Having, OrderBy, Other }

    private sealed class Query(int parens, int indent)
    {
        public int Parens { get; } = parens;
        public int Indent { get; } = indent;
        public Clause Clause { get; set; }
        public bool Between { get; set; }
        public int Case { get; set; }
    }

    private static readonly HashSet<string> ClauseWords = new(StringComparer.Ordinal)
    { "SELECT", "FROM", "WHERE", "JOIN", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT", "ON", "SET", "VALUES", "INSERT", "UPDATE", "DELETE" };
    private static readonly HashSet<string> JoinHeads = new(StringComparer.Ordinal) { "INNER", "LEFT", "RIGHT", "FULL", "CROSS" };

    public static int Units(string text) => Tokens(text).Count(t => ClauseWords.Contains(t.Upper));

    public static string Format(string text)
    {
        var tokens = Tokens(text);
        var lines = new List<StringBuilder>(); var indents = new List<int>();
        var queries = new Stack<Query>(); queries.Push(new Query(0, 0));
        var parens = new Stack<(bool Subquery, int CloseIndent)>();
        int? pending = null;   // a quebra pedida: a indentacao da proxima linha

        StringBuilder Line() { if (lines.Count == 0) { lines.Add(new StringBuilder()); indents.Add(0); } return lines[^1]; }
        void Break(int indent)
        {
            if (lines.Count == 0 || lines[^1].Length == 0) { Line(); indents[^1] = indent; }
            else { lines.Add(new StringBuilder()); indents.Add(indent); }
            pending = null;
        }
        void Emit(string text, bool space)
        {
            if (pending is { } indent) Break(indent);
            var line = Line();
            if (space && line.Length > 0) line.Append(' ');
            line.Append(text);
        }
        int Current() => lines.Count == 0 ? 0 : indents[^1];
        bool Word(int at, string word) => at < tokens.Count && tokens[at].Upper == word;
        int Continuation(Query q) => q.Indent + (q.Clause == Clause.None ? 0 : 1);

        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i]; var q = queries.Peek(); var atLevel = parens.Count == q.Parens && q.Case == 0;
            if (t.Kind == Kind.Word)
            {
                var word = t.Upper;
                if (parens.Count == q.Parens)
                {
                    if (word == "CASE") q.Case++;
                    else if (word == "END" && q.Case > 0) q.Case--;
                }
                if (atLevel && ClauseAt(tokens, i, q.Clause == Clause.None) is var (count, clause, own))
                {
                    Break(q.Indent);
                    for (var k = 0; k < count; k++) Emit(tokens[i + k].Text, k > 0);
                    i += count - 1;
                    q.Clause = clause; q.Between = false;
                    if (clause == Clause.Select)
                    {
                        while (Word(i + 1, "DISTINCT") || Word(i + 1, "ALL")) { i++; Emit(tokens[i].Text, true); }
                        if (Word(i + 1, "TOP") && i + 2 < tokens.Count)
                        {
                            i++; Emit(tokens[i].Text, true);
                            i++; Emit(tokens[i].Text, tokens[i].SpaceBefore);
                            if (tokens[i].Text == "(")
                                for (var depth = 1; depth > 0 && i + 1 < tokens.Count;)
                                {
                                    i++; Emit(tokens[i].Text, tokens[i].SpaceBefore);
                                    if (tokens[i].Text == "(") depth++; else if (tokens[i].Text == ")") depth--;
                                }
                        }
                        pending = q.Indent + 1;
                    }
                    else if (own) pending = q.Indent;
                    continue;
                }
                if (atLevel && word == "ON" && q.Clause is Clause.Join or Clause.On)
                {
                    Break(q.Indent + 1); Emit(t.Text, false); q.Clause = Clause.On; q.Between = false; continue;
                }
                if (atLevel && word == "BETWEEN") { q.Between = true; Emit(t.Text, t.SpaceBefore); continue; }
                if (atLevel && word is "AND" or "OR" && q.Clause is Clause.Where or Clause.Having or Clause.On)
                {
                    if (word == "AND" && q.Between) { q.Between = false; Emit(t.Text, t.SpaceBefore); continue; }
                    Break(q.Indent + (q.Clause == Clause.On ? 2 : 1)); Emit(t.Text, false); continue;
                }
                Emit(t.Text, t.SpaceBefore);
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text == "(")
            {
                var next = i + 1 < tokens.Count ? tokens[i + 1].Upper : "";
                Emit("(", t.SpaceBefore);
                if (next is "SELECT" or "WITH")
                {
                    // Na linha da propria clausula (WHERE x IN (...), FROM (...)) a subconsulta fica um nivel abaixo das
                    // condicoes, e o ')' na coluna delas; numa linha ja indentada (uma coluna, um AND) fica sob essa linha.
                    var line = Current() == q.Indent && q.Clause != Clause.None ? q.Indent + 1 : Current();
                    parens.Push((true, line));
                    queries.Push(new Query(parens.Count, line + 1));
                    pending = line + 1;
                }
                else parens.Push((false, 0));
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text == ")")
            {
                if (parens.Count == 0) throw new CodeFormatException("sql: unexpected ')'");
                var (subquery, close) = parens.Pop();
                if (subquery) { queries.Pop(); Break(close); Emit(")", false); }
                else Emit(")", t.SpaceBefore);
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text == "," )
            {
                Emit(",", t.SpaceBefore);
                if (atLevel && q.Clause == Clause.Select) pending = q.Indent + 1;
                continue;
            }
            if (t.Kind == Kind.Punct && t.Text == ";" && parens.Count == 0)
            {
                Emit(";", t.SpaceBefore); q.Clause = Clause.None; pending = 0;
                continue;
            }
            if (t.Kind == Kind.LineComment)
            {
                Emit(t.Text, t.SpaceBefore);
                pending = Continuation(q);
                continue;
            }
            Emit(t.Text, t.SpaceBefore);
        }
        if (parens.Count != 0) throw new CodeFormatException("sql: unbalanced parentheses");
        var nl = CodeFormat.NewLine(text);
        return string.Join(nl, lines.Select((l, n) => new string(' ', indents[n] * Width) + l.ToString()).Where((l, n) => lines[n].Length > 0));
    }

    /// <summary>A clausula que comeca em <paramref name="at"/>: quantos tokens tem o seu nome (GROUP BY, LEFT OUTER JOIN),
    /// o tipo, e se o conteudo vai para a linha seguinte (UNION, EXCEPT, INTERSECT).</summary>
    private static (int Count, Clause Clause, bool OwnLine)? ClauseAt(List<Token> tokens, int at, bool atStart)
    {
        string W(int k) => at + k < tokens.Count && tokens[at + k].Kind == Kind.Word ? tokens[at + k].Upper : "";
        switch (W(0))
        {
            case "SELECT": return (1, Clause.Select, false);
            case "FROM": return (1, Clause.From, false);
            case "WHERE": return (1, Clause.Where, false);
            case "HAVING": return (1, Clause.Having, false);
            case "GROUP" when W(1) == "BY": return (2, Clause.GroupBy, false);
            case "ORDER" when W(1) == "BY": return (2, Clause.OrderBy, false);
            case "UNION": return (W(1) == "ALL" ? 2 : 1, Clause.None, true);
            case "EXCEPT" or "INTERSECT": return (1, Clause.None, true);
            case "JOIN": return (1, Clause.Join, false);
            case var head when JoinHeads.Contains(head):
                if (W(1) == "JOIN") return (2, Clause.Join, false);
                if (W(1) == "OUTER" && W(2) == "JOIN") return (3, Clause.Join, false);
                return null;
            case "WITH" when !atStart: return null;
            case "INSERT" or "UPDATE" or "DELETE" or "SET" or "VALUES" or "WITH" or "OFFSET" or "FETCH" or "LIMIT":
                return (1, Clause.Other, false);
            default: return null;
        }
    }

    /// <summary>Os tokens do texto, cada um com a marca de espaco antes. Strings <c>'...'</c> (com <c>''</c>),
    /// identificadores <c>"..."</c>, <c>[...]</c> e <c>{...}</c> e comentarios <c>--</c> e <c>/* */</c> sao um token so.</summary>
    private static List<Token> Tokens(string text)
    {
        var tokens = new List<Token>(); var i = 0; var space = false;
        while (i < text.Length)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { space = true; i++; continue; }
            var start = i; Kind kind;
            if (c == '-' && i + 1 < text.Length && text[i + 1] == '-') { while (i < text.Length && text[i] != '\n' && text[i] != '\r') i++; kind = Kind.LineComment; }
            else if (c == '/' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0) throw new CodeFormatException("sql: unterminated comment");
                i = end + 2; kind = Kind.BlockComment;
            }
            else if (c is '\'' or '"')
            {
                i++;
                while (true)
                {
                    if (i >= text.Length) throw new CodeFormatException("sql: unterminated literal");
                    if (text[i] == c) { if (i + 1 < text.Length && text[i + 1] == c) { i += 2; continue; } i++; break; }
                    i++;
                }
                kind = Kind.Literal;
            }
            else if (c is '[' or '{')
            {
                var close = c == '[' ? ']' : '}';
                var end = text.IndexOf(close, i + 1);
                if (end < 0) throw new CodeFormatException($"sql: unterminated '{c}'");
                i = end + 1; kind = Kind.Literal;
            }
            else if (IsWord(c)) { while (i < text.Length && IsWord(text[i])) i++; kind = Kind.Word; }
            else { i++; kind = Kind.Punct; }
            tokens.Add(new Token(kind, text[start..i], space));
            space = false;
        }
        return tokens;
    }

    private static bool IsWord(char c) => char.IsLetterOrDigit(c) || c is '_' or '@' or '#' or '$';
}
