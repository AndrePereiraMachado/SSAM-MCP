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
    public static void Recompute(WebStyleSheet sheet) => Settle(sheet);

    /// <summary>T18: the one tail of every stylesheet write, on both lanes and for a theme, a screen or a block (the set verb, the
    /// html op's theme blocks, the css op, the native widgets' CSS, the prototype importer): the author CSS through the one
    /// normalization (<see cref="CssPipeline.Normalize"/>), which never changes what the CSS selects nor the cascade (an @import
    /// after a rule, which the browser ignores, goes up keeping the order of the imports; nothing crosses an @layer), then, in a
    /// theme with Theme Editor CSS, the effective StyleSheet composed again with the author's @import statements before the Theme
    /// Editor block. <paramref name="canvas"/>: the write is the author's own CSS on a reactive element; only then, and only in a
    /// theme with Theme Editor CSS (where the platform's composition did it before), a <c>#reactContainer X</c> descendant
    /// selector also selects in the Studio canvas. What changed is reported by <see cref="Changed"/> (<c>cssImportsHoisted</c>,
    /// <c>cssImportsMerged</c>, <c>cssImportsKept</c>, <c>cssRewrites</c>, <c>cssStages</c>).</summary>
    public static void Settle(WebStyleSheet sheet, bool canvas = false)
    {
        var split = IsSplit(sheet);
        var author = Author(sheet);
        var outcome = CssPipeline.Normalize(author, new CssPipeline.Context(split ? "/UserStyleSheet" : "/StyleSheet"), canvas && split);
        if (outcome.Changed)
        {
            if (split) sheet.UserEffectiveValue = outcome.Css; else sheet.EffectiveValue = outcome.Css;
            author = outcome.Css;
        }
        var change = new JsonObject();
        var half = split ? "UserStyleSheet" : "StyleSheet";
        var hoisted = outcome.ImportsHoisted.Select(x => (JsonNode)new JsonObject
        {
            ["path"] = "/" + half, ["from"] = $"{x.Statement} (line {x.Line} of {half}, after a rule: the browser ignored it)", ["to"] = $"before the first rule of {half}",
        }).ToList();
        if (split)
        {
            var generated = sheet.GeneratedEffectiveValue ?? "";
            var (imports, rest) = CssCompat.Imports(author);
            sheet.SetCssSource(imports.Count == 0 ? generated + "\r\n" + author
                : string.Join("\r\n", imports.Select(x => x.Statement)) + "\r\n" + generated + "\r\n" + rest);
            hoisted = imports.Select(x => (JsonNode)new JsonObject
            {
                ["path"] = "/StyleSheet", ["from"] = $"{x.Statement} (line {x.Line} of UserStyleSheet, after the Theme Editor CSS)",
                ["to"] = "the top of the effective StyleSheet, before the Theme Editor CSS",
            }).ToList();
        }
        if (hoisted.Count > 0) change["cssImportsHoisted"] = new JsonArray(hoisted.ToArray());
        if (outcome.ImportsMerged > 0) change["cssImportsMerged"] = outcome.ImportsMerged;
        if (outcome.ImportsKept != null) change["cssImportsKept"] = outcome.ImportsKept;
        if (outcome.CanvasRewrites.Count > 0)
            change["cssRewrites"] = new JsonArray(outcome.CanvasRewrites.Select(x => (JsonNode)new JsonObject
            {
                ["path"] = $"/{half} (line {x.Line})", ["from"] = x.From, ["to"] = x.To,
            }).ToArray());
        if (outcome.StageChanges.Count > 0) change["cssStages"] = new JsonArray(outcome.StageChanges.Select(c => (JsonNode)c.DeepClone()).ToArray());
        if (change.Count == 0) Changes.Remove(sheet); else Changes.AddOrUpdate(sheet, change);
    }

    /// <summary>Whether an element is reactive (O11 Reactive and Mobile, ODC): an O11 mobile element implements the web interface too.</summary>
    public static bool Reactive(object? target)
    {
        if (target == null) return false;
        var names = target.GetType().GetInterfaces().Select(i => i.Name).ToHashSet(StringComparer.Ordinal);
        return names.Overlaps(["IMobileTheme", "IMobileScreen", "IMobileBlock"]) || !names.Overlaps(["IWebTheme", "IWebScreen", "IWebBlock"]);
    }

    /// <summary>The <c>basedOn</c> of a css op: the sha256 (lowercase hex, UTF-8) of the author CSS as the get shows it
    /// (UserStyleSheet in a theme with Theme Editor CSS, StyleSheet otherwise).</summary>
    public static string Sha256(string css) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(css ?? ""))).ToLowerInvariant();

    /// <summary>Whether <paramref name="basedOn"/> names this author CSS: its sha256 as stored, or with its line breaks read as
    /// \n (the Model API may store \r\n).</summary>
    public static bool Matches(string? basedOn, string css)
    {
        if (string.IsNullOrWhiteSpace(basedOn)) return false;
        var wanted = basedOn.Trim().ToLowerInvariant();
        return wanted == Sha256(css) || wanted == Sha256((css ?? "").Replace("\r\n", "\n"));
    }

    /// <summary>The author CSS of any element with a stylesheet (theme, screen or block), or null when it has none.</summary>
    public static string? AuthorOf(object target)
    {
        if (Of(target) is { } sheet) return Author(sheet);
        // A signature of another module (a reference) or a type whose getter the platform does not support has none.
        try { return StyleSheetProperty(target)?.GetValue(target) as string; }
        catch (Exception) { return null; }
    }

    /// <summary>The basedOn of the element's author CSS now (what a css op later in the same job names), or null.</summary>
    public static string? BasedOn(object? target) => target != null && AuthorOf(target) is { } css ? Sha256(css) : null;

    /// <summary>Writes the author CSS of an element through the one path (<see cref="WriteAuthor"/>); an element whose stylesheet
    /// the kernel cannot reach as a WebStyleSheet gets the same normalization through its Model API property.</summary>
    public static void Write(object target, string css)
    {
        if (Of(target) is { } sheet) { WriteAuthor(sheet, css, canvas: Reactive(target)); return; }
        var property = StyleSheetProperty(target) ?? throw new InvalidOperationException("the element has no stylesheet of its own (a theme, a screen or a block has one)");
        property.SetValue(target, CssPipeline.Normalize(css, new CssPipeline.Context("/StyleSheet")).Css);
    }

    /// <summary>T18: the refusal of a write that brings an absolute url to an OutSystems environment host the element's CSS did
    /// not have (an existing one is never refused): every such url at once, with the patch that writes them without the host
    /// when the job holds the whole text at <paramref name="pointer"/> (<paramref name="sent"/>). Null when the write brings none.</summary>
    public static KernelRefusalException? Introduced(string? before, string after, string where, string? pointer = null, string? sent = null)
    {
        var added = CssPipeline.Introduced(before ?? "", after ?? "", new CssPipeline.Context(where)).Where(f => f.Severity == "error").ToList();
        if (added.Count == 0) return null;
        var message = $"{where}: {CssPipeline.Summary(CssPipeline.EnvUrl, added)}; the CSS the element had keeps its own urls";
        var fixedText = sent != null ? CssPipeline.WithoutHosts(sent, added) : null;
        var problem = JobPreflight.Problem(null, pointer, CssPipeline.EnvUrl, "error", message, added[0].Fix,
            pointer != null && fixedText != null && fixedText != sent ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = pointer, ["value"] = fixedText }) : null);
        problem["offenders"] = new JsonArray(added.Select(f => (JsonNode)new JsonObject { ["line"] = f.Line, ["url"] = f.Subject }).ToArray());
        return new KernelRefusalException(CssPipeline.EnvUrl, message, new JsonArray(JobPreflight.PublicProblem(problem)));
    }
    private static System.Reflection.PropertyInfo? StyleSheetProperty(object target) =>
        target.GetType().GetInterfaces().Prepend(target.GetType()).SelectMany(t => t.GetProperties())
            .FirstOrDefault(p => p.Name == "StyleSheet" && p.PropertyType == typeof(string) && p.GetIndexParameters().Length == 0 && p.CanRead);

    /// <summary>O CSS do autor: a metade que a interface do Studio mostra e que o <c>ITheme.StyleSheet</c> escreve.
    /// Quando nao ha CSS gerado, autor e efetiva sao o mesmo texto.</summary>
    public static string Author(WebStyleSheet sheet) => (IsSplit(sheet) ? sheet.UserEffectiveValue : sheet.EffectiveValue) ?? "";

    /// <summary>Escreve a metade do autor e repoe a efetiva. E o caminho seguro para quem quer ACRESCENTAR CSS:
    /// escrever pelo <c>ITheme.StyleSheet</c> obriga a plataforma a recortar o bloco gerado do texto recebido, e um
    /// recorte que falhe (fim de linha diferente, texto gerado alterado entretanto) duplica o bloco gerado dentro do
    /// CSS do autor.</summary>
    public static void WriteAuthor(WebStyleSheet sheet, string css) => WriteAuthor(sheet, css, canvas: false);

    /// <summary><paramref name="canvas"/>: the text is the author's own CSS of a reactive element (see <see cref="Settle"/>).</summary>
    public static void WriteAuthor(WebStyleSheet sheet, string css, bool canvas)
    {
        if (IsSplit(sheet)) sheet.UserEffectiveValue = css; else sheet.EffectiveValue = css;
        Settle(sheet, canvas);
    }

    /// <summary>Grava o CSS do autor TAL COMO VEIO, sem <c>CodeFormat</c>: o desvio explicito e exclusivo do importador de
    /// prototipo (docs/PROTOTIPO-NATIVO.md 4.1), cujo CSS e verbatim por construcao. O <c>set</c> e o <c>InstallStylesheet</c> do
    /// op html continuam formatando. Devolve o relato da gravacao: <c>verbatim</c> (o CSS do autor lido de volta e o mesmo texto),
    /// <c>importsFirst</c> (a efetiva comeca pelos @import, a conferencia da leitura de volta de 4.1 item 2) e o que a
    /// recomposicao mudou.</summary>
    public static JsonObject WriteVerbatim(WebStyleSheet sheet, string css)
    {
        // The one path, without the canvas rewrite: the importer's CSS is verbatim by construction (its @import statements first).
        WriteAuthor(sheet, css, canvas: false);
        var author = Author(sheet);
        var effective = sheet.EffectiveValue ?? "";
        var (first, statement) = ImportsFirst(effective);
        var report = new JsonObject
        {
            // The Model API may store the line breaks as \r\n: the same text modulo line endings is verbatim.
            ["verbatim"] = author.Replace("\r\n", "\n") == css.Replace("\r\n", "\n"),
            ["chars"] = css.Length,
            ["importsFirst"] = first,
            ["firstStatement"] = statement,
        };
        if (IsSplit(sheet)) report["half"] = "UserStyleSheet";
        if (Changed(sheet) is { } change)
            foreach (var (key, value) in change) report[key] = value?.DeepClone();
        return report;
    }

    /// <summary><see cref="WriteVerbatim(WebStyleSheet, string)"/> sobre o objeto que tem a folha (o tema do importador), para
    /// quem nao compila contra os tipos do Studio.</summary>
    public static JsonObject WriteThemeVerbatim(object theme, string css) =>
        WriteVerbatim(Of(theme) ?? throw new InvalidOperationException("the object has no stylesheet of its own: " + theme.GetType().Name), css);

    /// <summary>Se o CSS comeca pelos seus @import (depois de BOM, espacos, comentarios e @charset): o navegador ignora um
    /// @import depois de qualquer outra regra. Sem @import nenhum, true. Devolve tambem a primeira instrucao (ate 120 chars).</summary>
    public static (bool Ok, string First) ImportsFirst(string css)
    {
        var i = 0;
        while (i < css.Length)
        {
            if (char.IsWhiteSpace(css[i]) || css[i] == '﻿') { i++; continue; }
            if (css[i] == '/' && i + 1 < css.Length && css[i + 1] == '*') { var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? css.Length : end + 2; continue; }
            if (string.Compare(css, i, "@charset", 0, 8, StringComparison.OrdinalIgnoreCase) == 0) { var semi = css.IndexOf(';', i); i = semi < 0 ? css.Length : semi + 1; continue; }
            break;
        }
        var rest = css[i..];
        var first = rest.Length > 120 ? rest[..120] : rest;
        var nl = first.IndexOf('\n'); if (nl >= 0) first = first[..nl];
        var hasImport = CssCompat.Imports(css).Imports.Count > 0;
        return (!hasImport || rest.StartsWith("@import", StringComparison.OrdinalIgnoreCase), first.TrimEnd());
    }

    /// <summary>O que dizer no resultado do <c>set</c>: onde o texto caiu de facto, e o que a recomposicao mudou
    /// (<c>cssImportsHoisted</c>, <c>cssRewrites</c>: <c>[{path, from, to}]</c>).</summary>
    public static JsonObject Landing(WebStyleSheet sheet)
    {
        var landing = new JsonObject
        {
            ["wroteInto"] = "UserStyleSheet",
            ["note"] = "this theme has Theme Editor CSS: ITheme.StyleSheet writes the AUTHOR half (UserStyleSheet) and "
                     + "reads the effective one. The text replaced the author's CSS; the effective one was rebuilt as generated + author. "
                     + "To add instead of replacing, read StyleSheet (or UserStyleSheet) first and write the whole.",
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
