using System.Text.Json.Nodes;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// O CSS de um tema tem TRES metades no modelo, e as duas plataformas guardam-nas do mesmo modo
/// (<c>ServiceStudio.Model.WebStyleSheet</c>, identico no O11 e no ODC):
/// <list type="bullet">
/// <item><c>GeneratedCssSource</c> — o que o Theme Editor gera;</item>
/// <item><c>UserCssSource</c> — o CSS do autor, que e o que a interface do Studio mostra e deixa editar;</item>
/// <item><c>CssSource</c> — a EFETIVA, uma cache que a plataforma recalcula como
/// <c>gerada + "\r\n" + autor</c> (<c>WebStyleSheet.CalculateFinalCssSource</c>).</item>
/// </list>
/// O Model API expoe so a efetiva: <c>ITheme.StyleSheet</c> LE <c>CssSource</c> e ESCREVE por
/// <c>SetCorrectCssSource</c>, que num tema com CSS do Theme Editor grava a metade do AUTOR e deixa a efetiva
/// intacta. Sem esta classe o <c>set</c> parecia perdido: o <c>get</c> seguinte devolvia o texto antigo (prova da
/// frente R) enquanto o CSS do autor tinha, de facto, sido substituido — uma escrita destrutiva invisivel na
/// leitura, e um OML gravado com a efetiva em contradicao com as duas metades.
/// Quem recalcula a efetiva no Studio e o refresh de cache; sem interface ninguem o chama, por isso o kernel
/// refaz a mesma conta depois de escrever, e o <c>get</c> passa a mostrar as tres metades quando elas divergem.
/// </summary>
public static class ThemeCss
{
    /// <summary>A folha nativa do objeto (tema, tela ou bloco), ou null se ele nao tem CSS proprio.
    /// A propriedade publica <c>StyleSheet</c> da classe concreta devolve a folha; a do Model API, com o mesmo
    /// nome, e uma implementacao explicita de interface e nao aparece por reflexao sobre o tipo.</summary>
    public static WebStyleSheet? Of(object? target)
    {
        if (target == null) return null;
        foreach (var p in target.GetType().GetProperties())
        {
            if (p.Name != "StyleSheet" || p.GetIndexParameters().Length > 0 || !typeof(AbstractStyleSheet).IsAssignableFrom(p.PropertyType)) continue;
            try { return p.GetValue(target) as WebStyleSheet; } catch { return null; }
        }
        return null;
    }

    /// <summary>True quando a efetiva e derivada, ou seja, quando ler <c>StyleSheet</c> e escrever <c>StyleSheet</c>
    /// tocam metades diferentes.</summary>
    public static bool IsSplit(WebStyleSheet sheet)
    {
        try { return sheet.IsGeneratedEffectiveValueInUse(); } catch { return false; }
    }

    // O que a ultima recomposicao de cada folha mudou, para o Landing relatar (o Verbs chama Recompute e depois Landing).
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<WebStyleSheet, JsonObject> Changes = new();

    /// <summary>Repoe a efetiva a partir das duas metades, a mesma conta do <c>CalculateFinalCssSource</c> da
    /// plataforma. Chamada depois de escrever <c>StyleSheet</c>, para o modelo ficar coerente consigo proprio. Duas regras do
    /// pacote atritos 3, relatadas pelo <see cref="Landing"/>:
    /// <list type="bullet">
    /// <item>C23: um <c>@import</c> do autor sobe para o topo da efetiva, antes do bloco do Theme Editor (o navegador ignora um
    /// @import depois de regras: as fontes de um cliente nao carregavam). A metade do autor guarda o @import como foi escrito.</item>
    /// <item>C35: um seletor do autor que comeca por <c>#reactContainer</c> vira <c>:is(#reactContainer, body)</c>, na metade
    /// do autor: o canvas do Studio nao tem #reactContainer e os blocos ficavam sem estilo la.</item>
    /// </list></summary>
    public static void Recompute(WebStyleSheet sheet)
    {
        var generated = sheet.GeneratedEffectiveValue ?? "";
        if (generated.Length == 0) { Changes.Remove(sheet); return; }
        var author = sheet.UserEffectiveValue ?? "";
        var (canvas, selectors) = CssCompat.CanvasSelectors(author);
        if (selectors.Count > 0) { sheet.UserEffectiveValue = canvas; author = canvas; }
        var (imports, rest) = CssCompat.Imports(author);
        sheet.SetCssSource(imports.Count == 0 ? generated + "\r\n" + author
            : string.Join("\r\n", imports.Select(x => x.Statement)) + "\r\n" + generated + "\r\n" + rest);
        var change = new JsonObject();
        if (imports.Count > 0)
            change["cssImportsHoisted"] = new JsonArray(imports.Select(x => (JsonNode)new JsonObject
            {
                ["path"] = "/StyleSheet", ["from"] = $"{x.Statement} (line {x.Line} of UserStyleSheet, after the Theme Editor CSS)",
                ["to"] = "the top of the effective StyleSheet, before the Theme Editor CSS",
            }).ToArray());
        if (selectors.Count > 0)
            change["cssRewrites"] = new JsonArray(selectors.Select(x => (JsonNode)new JsonObject
            {
                ["path"] = $"/UserStyleSheet (line {x.Line})", ["from"] = x.From, ["to"] = x.To,
            }).ToArray());
        Changes.AddOrUpdate(sheet, change);
    }

    /// <summary>O CSS do autor: a metade que a interface do Studio mostra e que o <c>ITheme.StyleSheet</c> escreve.
    /// Quando nao ha CSS gerado, autor e efetiva sao o mesmo texto.</summary>
    public static string Author(WebStyleSheet sheet) => (IsSplit(sheet) ? sheet.UserEffectiveValue : sheet.EffectiveValue) ?? "";

    /// <summary>Escreve a metade do autor e repoe a efetiva. E o caminho seguro para quem quer ACRESCENTAR CSS:
    /// escrever pelo <c>ITheme.StyleSheet</c> obriga a plataforma a recortar o bloco gerado do texto recebido, e um
    /// recorte que falhe (fim de linha diferente, texto gerado alterado entretanto) duplica o bloco gerado dentro do
    /// CSS do autor.</summary>
    public static void WriteAuthor(WebStyleSheet sheet, string css)
    {
        if (IsSplit(sheet)) { sheet.UserEffectiveValue = css; Recompute(sheet); }
        else sheet.EffectiveValue = css;
    }

    /// <summary>O que dizer no resultado do <c>set</c>: onde o texto caiu de facto, e o que a recomposicao mudou
    /// (<c>cssImportsHoisted</c>, <c>cssRewrites</c>: <c>[{path, from, to}]</c>).</summary>
    public static JsonObject Landing(WebStyleSheet sheet)
    {
        var landing = new JsonObject
        {
            ["wroteInto"] = "UserStyleSheet",
            ["note"] = "este tema tem CSS do Theme Editor: ITheme.StyleSheet escreve a metade do AUTOR (UserStyleSheet) e "
                     + "le a efetiva. O texto substituiu o CSS do autor; a efetiva foi recomposta como gerada + autor. "
                     + "Para acrescentar em vez de substituir, leia StyleSheet (ou UserStyleSheet) antes e escreva o todo.",
            ["userChars"] = (sheet.UserEffectiveValue ?? "").Length,
            ["generatedChars"] = (sheet.GeneratedEffectiveValue ?? "").Length,
        };
        if (Changed(sheet) is { } change)
            foreach (var (key, value) in change) landing[key] = value?.DeepClone();
        return landing;
    }

    /// <summary>O que a ultima <see cref="Recompute"/> desta folha mudou (<c>cssImportsHoisted</c>, <c>cssRewrites</c>), ou
    /// null quando nao mudou nada.</summary>
    public static JsonObject? Changed(WebStyleSheet sheet) => Changes.TryGetValue(sheet, out var change) && change.Count > 0 ? change : null;

    /// <summary>Acrescenta ao <c>get</c> as metades que o Model API do O11 nao tem (o do ODC ja as publica como
    /// somente-leitura), e so quando elas divergem da efetiva: sem CSS do Theme Editor nao ha o que mostrar.</summary>
    public static void Describe(object target, JsonObject properties)
    {
        if (!properties.ContainsKey("StyleSheet")) return;   // so objetos com CSS proprio; poupa reflexao em cada dump
        if (Of(target) is not { } sheet || !IsSplit(sheet)) return;
        properties["UserStyleSheet"] ??= sheet.UserEffectiveValue;
        properties["GeneratedStyleSheet"] ??= sheet.GeneratedEffectiveValue;
    }
}
