using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Pedido do dono (2026-10-09): o CSS, o SQL e o JavaScript que os agentes geram caiam no modulo numa linha so. O kernel
/// formata o texto antes de o escrever (CodeFormat), so mexendo em espacos, e prova a equivalencia na hora da escrita
/// (CodeEquivalence); se a prova falha, escreve o original e o recibo diz FORMAT_SKIPPED. Testes puros, sem Studio.
/// </summary>
public sealed class CodeFormatTests
{
    // ---- CSS ------------------------------------------------------------------------------------------------------------

    private const string MinifiedCss =
        "/* OSUI-like header */.header{display:flex;align-items:center;padding:var(--space-m) var(--space-base);background-color:var(--color-neutral-0);box-shadow:0 1px 4px rgba(0,0,0,.1)}"
        + ".header .app-title,.header .menu-icon{font-size:var(--font-size-h4);color:var(--color-primary)}"
        + "@media (max-width:768px){.header{padding:0 var(--space-s)}/* tablet */.layout .main-content{margin:0;}}"
        + ".btn::after{content:\"a;b{c}\";background:url(data:image/png;base64,AAAA)}";

    private const string FormattedCss =
        "/* OSUI-like header */\n"
        + ".header {\n"
        + "    display: flex;\n"
        + "    align-items: center;\n"
        + "    padding: var(--space-m) var(--space-base);\n"
        + "    background-color: var(--color-neutral-0);\n"
        + "    box-shadow: 0 1px 4px rgba(0,0,0,.1)\n"
        + "}\n"
        + "\n"
        + ".header .app-title, .header .menu-icon {\n"
        + "    font-size: var(--font-size-h4);\n"
        + "    color: var(--color-primary)\n"
        + "}\n"
        + "\n"
        + "@media (max-width:768px) {\n"
        + "    .header {\n"
        + "        padding: 0 var(--space-s)\n"
        + "    }\n"
        + "\n"
        + "    /* tablet */\n"
        + "    .layout .main-content {\n"
        + "        margin: 0;\n"
        + "    }\n"
        + "}\n"
        + "\n"
        + ".btn::after {\n"
        + "    content: \"a;b{c}\";\n"
        + "    background: url(data:image/png;base64,AAAA)\n"
        + "}";

    [Fact]
    public void MinifiedCssBecomesOneDeclarationPerLineWithNestedMediaIndented()
    {
        Assert.True(CodeFormat.NeedsFormatting(CodeLanguage.Css, MinifiedCss));
        var outcome = CodeFormat.Apply(CodeLanguage.Css, MinifiedCss);
        Assert.True(outcome.Formatted, outcome.Skipped);
        Assert.Equal(FormattedCss, outcome.Text);
        Assert.Equal(1, outcome.LinesBefore);
        Assert.Equal(FormattedCss.Split('\n').Length, outcome.LinesAfter);
        // So espacos mudaram: strings, comentarios, url() e o ';' que faltava na ultima declaracao ficam como estavam.
        Assert.Equal(Strip(MinifiedCss), Strip(outcome.Text));
    }

    [Fact]
    public void CssTrailingCommentStaysOnItsLineAndCrLfIsKept()
    {
        var css = ".a{color:red; /* why */\r\nmargin:0}.b,.c{padding:1px 2px 3px 4px;border:1px solid #ccc;font-family:\"Segoe UI\",Arial}";
        var formatted = CodeFormat.FormatUnchecked(CodeLanguage.Css, css);
        Assert.Equal(".a {\r\n    color: red; /* why */\r\n    margin: 0\r\n}\r\n\r\n.b, .c {\r\n    padding: 1px 2px 3px 4px;\r\n    border: 1px solid #ccc;\r\n    font-family: \"Segoe UI\",Arial\r\n}", formatted);
        Assert.Null(CodeEquivalence.Check(CodeLanguage.Css, css, formatted));
    }

    [Fact]
    public void ALongSelectorListGoesOneSelectorPerLine()
    {
        var selectors = string.Join(",", Enumerable.Range(1, 8).Select(n => $".screen-container .section-{n} .card-title"));
        var formatted = CodeFormat.FormatUnchecked(CodeLanguage.Css, selectors + "{color:red;margin:0}");
        var lines = formatted.Split('\n');
        Assert.Equal(".screen-container .section-1 .card-title,", lines[0]);
        Assert.Equal(".screen-container .section-8 .card-title {", lines[7]);
        Assert.Equal("    color: red;", lines[8]);
    }

    // ---- SQL ------------------------------------------------------------------------------------------------------------

    private const string OneLineSql =
        "SELECT {Ticket}.[Id], {Ticket}.[Title], {User}.[Name] FROM {Ticket} INNER JOIN {User} ON {User}.[Id] = {Ticket}.[CreatedBy] AND {User}.[IsActive] = 1 "
        + "WHERE {Ticket}.[StatusId] IN (SELECT {TicketStatus}.[Id] FROM {TicketStatus} WHERE {TicketStatus}.[Label] <> 'select from where') "
        + "AND {Ticket}.[CreatedOn] BETWEEN @From AND @To OR {Ticket}.[Title] LIKE '%' + @Search + '%' /* busca */ "
        + "GROUP BY {Ticket}.[Id], {Ticket}.[Title], {User}.[Name] ORDER BY {Ticket}.[CreatedOn] DESC";

    private const string FormattedSql =
        "SELECT\n"
        + "    {Ticket}.[Id],\n"
        + "    {Ticket}.[Title],\n"
        + "    {User}.[Name]\n"
        + "FROM {Ticket}\n"
        + "INNER JOIN {User}\n"
        + "    ON {User}.[Id] = {Ticket}.[CreatedBy]\n"
        + "        AND {User}.[IsActive] = 1\n"
        + "WHERE {Ticket}.[StatusId] IN (\n"
        + "        SELECT\n"
        + "            {TicketStatus}.[Id]\n"
        + "        FROM {TicketStatus}\n"
        + "        WHERE {TicketStatus}.[Label] <> 'select from where'\n"
        + "    )\n"
        + "    AND {Ticket}.[CreatedOn] BETWEEN @From AND @To\n"
        + "    OR {Ticket}.[Title] LIKE '%' + @Search + '%' /* busca */\n"
        + "GROUP BY {Ticket}.[Id], {Ticket}.[Title], {User}.[Name]\n"
        + "ORDER BY {Ticket}.[CreatedOn] DESC";

    [Fact]
    public void OneLineSqlGetsAClausePerLineIndentedColumnsConditionsAndSubquery()
    {
        Assert.True(CodeFormat.NeedsFormatting(CodeLanguage.Sql, OneLineSql));
        var outcome = CodeFormat.Apply(CodeLanguage.Sql, OneLineSql);
        Assert.True(outcome.Formatted, outcome.Skipped);
        Assert.Equal(FormattedSql, outcome.Text);
    }

    [Fact]
    public void SqlKeepsKeywordCaseLineCommentsAndParenthesesThatAreNotSubqueries()
    {
        var sql = "select {A}.[Id], Count(*) as Total, Substring({A}.[Name], 1, 3) from {A} -- todos\nleft outer join {B} on {B}.[AId] = {A}.[Id] where ({A}.[X] = @X or {A}.[Y] = @Y) and {B}.[Z] is not null group by {A}.[Id]";
        var formatted = CodeFormat.FormatUnchecked(CodeLanguage.Sql, sql);
        Assert.Equal(
            "select\n    {A}.[Id],\n    Count(*) as Total,\n    Substring({A}.[Name], 1, 3)\nfrom {A} -- todos\n"
            + "left outer join {B}\n    on {B}.[AId] = {A}.[Id]\nwhere ({A}.[X] = @X or {A}.[Y] = @Y)\n    and {B}.[Z] is not null\ngroup by {A}.[Id]", formatted);
        Assert.Null(CodeEquivalence.Check(CodeLanguage.Sql, sql, formatted));
    }

    // ---- JavaScript -------------------------------------------------------------------------------------------------------

    private const string OneLineJs =
        "function fmt(v){var re=/[;{}]\\/x/g;var s=`a;${v.map(function(x){return x+\";\"}).join(\"{\")}b`;if(v.length>2){return s.replace(re,'}');}else{return /* keep; */ s}}"
        + "$parameters.Out=fmt($parameters.In);";

    private const string FormattedJs =
        "function fmt(v) {\n"
        + "    var re=/[;{}]\\/x/g;\n"
        + "    var s=`a;${v.map(function(x){return x+\";\"}).join(\"{\")}b`;\n"
        + "    if(v.length>2) {\n"
        + "        return s.replace(re,'}');\n"
        + "    } else {\n"
        + "        return /* keep; */ s\n"
        + "    }\n"
        + "}\n"
        + "$parameters.Out=fmt($parameters.In);";

    [Fact]
    public void OneLineJavaScriptBreaksAtBlocksAndStatementsAndLeavesTemplatesRegexesAndCommentsAlone()
    {
        Assert.True(CodeFormat.NeedsFormatting(CodeLanguage.JavaScript, OneLineJs));
        var outcome = CodeFormat.Apply(CodeLanguage.JavaScript, OneLineJs);
        Assert.True(outcome.Formatted, outcome.Skipped);
        Assert.Equal(FormattedJs, outcome.Text);
    }

    [Fact]
    public void JavaScriptNestedFunctionsAndObjectLiteralsIndentOnceAndForLoopsStayOnOneLine()
    {
        var js = "var o={a:1,b:[1,2]};for(var i=0;i<3;i++){o.a+=i;}$actions.Run().then(function(r){if(r.Ok){$parameters.Done=true;}});";
        var formatted = CodeFormat.FormatUnchecked(CodeLanguage.JavaScript, js);
        Assert.Equal(
            "var o={a:1,b:[1,2]};\nfor(var i=0;i<3;i++) {\n    o.a+=i;\n}\n$actions.Run().then(function(r) {\n    if(r.Ok) {\n        $parameters.Done=true;\n    }\n});",
            formatted);
        Assert.Null(CodeEquivalence.Check(CodeLanguage.JavaScript, js, formatted));
    }

    // ---- porta, idempotencia e prova ----------------------------------------------------------------------------------------

    [Theory]
    [InlineData(CodeLanguage.Css, MinifiedCss)]
    [InlineData(CodeLanguage.Sql, OneLineSql)]
    [InlineData(CodeLanguage.JavaScript, OneLineJs)]
    public void FormattingTwiceIsFormattingOnce(CodeLanguage language, string text)
    {
        var once = CodeFormat.FormatUnchecked(language, text);
        Assert.Equal(once, CodeFormat.FormatUnchecked(language, once));
        // E o texto ja formatado passa intacto pela porta: nada para formatar.
        var again = CodeFormat.Apply(language, once);
        Assert.False(again.Formatted);
        Assert.Null(again.Skipped);
        Assert.Same(once, again.Text);
    }

    [Theory]
    [InlineData(CodeLanguage.Css, ".a { color: red; }")]
    [InlineData(CodeLanguage.Css, ".a { color: red; }\n.b { margin: 0; padding: 0; }")]
    [InlineData(CodeLanguage.Sql, "SELECT {SqlItem}.* FROM {SqlItem} WHERE {SqlItem}.[Quantity] >= @Minimum")]
    [InlineData(CodeLanguage.Sql, "SELECT {Product}.* FROM {Product}\nWHERE {Product}.[Id] = @Missing")]
    [InlineData(CodeLanguage.JavaScript, "$parameters.Out = String($parameters.In || \"\").replace(/[^0-9]/g, \"\").substring(0, 11);")]
    [InlineData(CodeLanguage.JavaScript, "var d = 1;\nif (d > 0) {\n  $parameters.Out = d;\n}")]
    public void ReasonablyFormattedCodePassesUntouched(CodeLanguage language, string text)
    {
        var outcome = CodeFormat.Apply(language, text);
        Assert.False(outcome.Formatted);
        Assert.Null(outcome.Skipped);
        Assert.Same(text, outcome.Text);
    }

    [Fact]
    public void TheEquivalenceCheckRefusesWhitespaceThatChangesMeaning()
    {
        // CSS: um descendente que vira composto (.a .b -> .a.b) e um espaco tirado de dentro de uma string.
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.Css, ".a .b{color:red}", ".a.b {\n    color: red\n}"));
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.Css, ".a{content:\"x y\"}", ".a {\n    content: \"xy\"\n}"));
        Assert.Null(CodeEquivalence.Check(CodeLanguage.Css, ".a .b{color:red}", ".a .b {\n    color: red\n}"));
        // SQL: duas palavras coladas, um literal mudado e um comentario de linha que engoliria o resto.
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.Sql, "SELECT a FROM b", "SELECTa\nFROM b"));
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.Sql, "WHERE x = 'a b'", "WHERE x = 'a  b'"));
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.Sql, "SELECT a -- c\nFROM b", "SELECT a -- c FROM b"));
        // JavaScript: a insercao automatica de ';' depois de return muda o programa com os mesmos tokens.
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.JavaScript, "return\n$parameters.X;", "return $parameters.X;"));
        Assert.NotNull(CodeEquivalence.Check(CodeLanguage.JavaScript, "var r=/a b/;", "var r=/ab/;"));
    }

    [Fact]
    public void WhenTheProofFailsTheOriginalIsWrittenWithTheReason()
    {
        // 'x'AND: o formatador quebra a linha antes do AND, onde o original nao tinha espaco; a forma canonica do SQL
        // conserva esse espaco e a prova recusa. O texto escrito e o original.
        var sql = "SELECT {A}.[Id], {A}.[Name], {A}.[Code] FROM {A} WHERE {A}.[Code] = 'x'AND {A}.[Name] <> '' ORDER BY {A}.[Name]";
        Assert.NotEqual(sql, CodeFormat.FormatUnchecked(CodeLanguage.Sql, sql));
        var outcome = CodeFormat.Apply(CodeLanguage.Sql, sql);
        Assert.False(outcome.Formatted);
        Assert.Same(sql, outcome.Text);
        Assert.Contains("significant whitespace", outcome.Skipped);
    }

    [Fact]
    public void JavaScriptThatDoesNotParseIsWrittenAsGiven()
    {
        var js = "if (a) { $parameters.X = 1; } else { $parameters.X = 2; } $parameters.Y = ; $parameters.Z = 3; $parameters.W = 4;";
        var outcome = CodeFormat.Apply(CodeLanguage.JavaScript, js);
        Assert.False(outcome.Formatted);
        Assert.Same(js, outcome.Text);
        Assert.Contains("does not parse", outcome.Skipped);
    }

    [Fact]
    public void UnbalancedCssIsWrittenAsGiven()
    {
        var css = ".a{color:red;margin:0;padding:0}.b{color:blue;margin:0;padding:0}.c{color:green;margin:0;padding:0";
        var outcome = CodeFormat.Apply(CodeLanguage.Css, css);
        Assert.False(outcome.Formatted);
        Assert.Same(css, outcome.Text);
        Assert.Contains("unterminated block", outcome.Skipped);
    }

    [Fact]
    public void TheLanguageComesFromThePropertyAndTheSqlNode()
    {
        Assert.Equal(CodeLanguage.Css, CodeFormat.LanguageOf("StyleSheet", _ => false));
        Assert.Equal(CodeLanguage.JavaScript, CodeFormat.LanguageOf("JavaScript", _ => false));
        Assert.Equal(CodeLanguage.Sql, CodeFormat.LanguageOf("Statement", name => name == "ISQLNode"));
        Assert.Null(CodeFormat.LanguageOf("Statement", _ => false));
        Assert.Null(CodeFormat.LanguageOf("Description", _ => true));
    }

    private static string Strip(string text) => CodeEquivalence.Css(text, strip: true);
}
