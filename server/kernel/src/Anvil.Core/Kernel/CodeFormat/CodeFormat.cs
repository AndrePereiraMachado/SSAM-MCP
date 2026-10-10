namespace Anvil.Core;

/// <summary>As tres linguagens de codigo que o kernel escreve no modelo como texto.</summary>
public enum CodeLanguage { Css, Sql, JavaScript }

/// <summary>O que a formatacao fez com um texto: o texto a escrever, se mudou, e o motivo quando foi recusada
/// (o texto escrito e entao o original).</summary>
public sealed record CodeFormatOutcome(string Text, bool Formatted, string? Skipped, int LinesBefore, int LinesAfter);

/// <summary>Falha do proprio formatador (chaves desbalanceadas, string sem fim): o texto vai como veio.</summary>
public sealed class CodeFormatException(string message) : Exception(message);

/// <summary>
/// Indentacao multi-linha do CSS, SQL e JavaScript que o kernel escreve no modelo (pedido do dono, 2026-10-09: o codigo
/// gerado pelos agentes caia no modulo numa linha so). Tres regras, nas duas faixas:
/// <list type="number">
/// <item>So formata texto que nao esta razoavelmente formatado: uma linha unica com mais de <see cref="LongSingleLine"/>
/// caracteres e duas ou mais unidades (regras/declaracoes, clausulas, instrucoes), ou, em texto de varias linhas, uma linha
/// com mais de <see cref="LongLine"/> caracteres e duas ou mais unidades. Codigo ja formatado passa intacto.</item>
/// <item>A formatacao so mexe em espacos fora de strings, comentarios e literais (<see cref="CssFormatter"/>,
/// <see cref="SqlFormatter"/>, <see cref="JsFormatter"/>).</item>
/// <item>Prova na hora da escrita (<see cref="CodeEquivalence"/>): o texto formatado tem de ser equivalente ao original por
/// um verificador independente do formatador; se nao for, escreve-se o ORIGINAL e o recibo leva FORMAT_SKIPPED.</item>
/// </list>
/// </summary>
public static class CodeFormat
{
    public const int LongLine = 120;
    public const int LongSingleLine = 80;

    public static string Name(CodeLanguage language) => language switch
    {
        CodeLanguage.Css => "css",
        CodeLanguage.Sql => "sql",
        _ => "javascript",
    };

    /// <summary>A linguagem do texto que um <c>set</c> escreve: <c>StyleSheet</c> (tema, tela, bloco) e CSS,
    /// <c>Statement</c> de um no SQL e SQL, <c>JavaScript</c> (no JavaScript, script, tela, bloco, modulo) e JavaScript.</summary>
    public static CodeLanguage? LanguageOf(string? property, Func<string, bool> implements) => property switch
    {
        "StyleSheet" => CodeLanguage.Css,
        "Statement" when implements("ISQLNode") => CodeLanguage.Sql,
        "JavaScript" => CodeLanguage.JavaScript,
        _ => null,
    };

    /// <summary>True quando o texto pede formatacao (regra 1 do resumo da classe).</summary>
    public static bool NeedsFormatting(CodeLanguage language, string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        var lines = text.Split('\n');
        if (lines.Length == 1) return text.Trim().Length > LongSingleLine && Units(language, text) >= 2;
        return lines.Any(line => line.TrimEnd('\r').Length > LongLine && Units(language, line) >= 2);
    }

    /// <summary>Quantas unidades de codigo o trecho tem fora de strings e comentarios: CSS conta <c>;</c> e <c>}</c>, SQL as
    /// palavras que abrem clausula, JavaScript <c>;</c> e <c>{</c>.</summary>
    public static int Units(CodeLanguage language, string text) => language switch
    {
        CodeLanguage.Css => CssFormatter.Units(text),
        CodeLanguage.Sql => SqlFormatter.Units(text),
        _ => JsFormatter.Units(text),
    };

    /// <summary>A formatacao sem a porta nem a prova (para os testes e para quem ja decidiu formatar).</summary>
    public static string FormatUnchecked(CodeLanguage language, string text) => language switch
    {
        CodeLanguage.Css => CssFormatter.Format(text),
        CodeLanguage.Sql => SqlFormatter.Format(text),
        _ => JsFormatter.Format(text),
    };

    /// <summary>A porta, a formatacao e a prova: o texto que o kernel escreve.</summary>
    public static CodeFormatOutcome Apply(CodeLanguage language, string text)
    {
        var before = Lines(text);
        if (!NeedsFormatting(language, text)) return new(text, false, null, before, before);
        string formatted;
        try { formatted = FormatUnchecked(language, text); }
        catch (Exception ex) { return new(text, false, "the formatter could not read the text (" + ex.Message + ")", before, before); }
        if (formatted == text) return new(text, false, null, before, before);
        string? refusal;
        try { refusal = CodeEquivalence.Check(language, text, formatted); }
        catch (Exception ex) { refusal = "the equivalence check failed (" + ex.Message + ")"; }
        return refusal != null ? new(text, false, refusal, before, before) : new(formatted, true, null, before, Lines(formatted));
    }

    /// <summary>O texto que <see cref="Apply"/> escreveria (para comparar o que o modelo guarda com o que o job pediu).</summary>
    public static string Written(CodeLanguage language, string text) => Apply(language, text).Text;

    public static int Lines(string text) => text.Length == 0 ? 0 : text.Count(c => c == '\n') + 1;

    /// <summary>A quebra de linha do texto original: CRLF quando ele ja a usa, LF nos outros casos.</summary>
    internal static string NewLine(string text) => text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
}
