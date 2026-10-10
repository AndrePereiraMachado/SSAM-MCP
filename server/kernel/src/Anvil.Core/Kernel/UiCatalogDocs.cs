using System.Text;

namespace Anvil.Core;

/// <summary>
/// Markdown gerado do catalogo de UI: um README por modulo (indice por UI flow) e uma pagina por bloco com o
/// contrato, placeholders, eventos, valores de configuracao, JS, CSS e o trecho de verbos para instanciar.
/// E a referencia que uma LLM le antes de por um padrao do OutSystems UI numa tela.
/// </summary>
public static class UiCatalogDocs
{
    public static void Write(UiModule m, string dir)
    {
        Directory.CreateDirectory(Path.Combine(dir, "blocks"));
        var statics = m.StaticEntities.ToDictionary(s => s.Name, s => s, StringComparer.OrdinalIgnoreCase);
        File.WriteAllText(Path.Combine(dir, "README.md"), Index(m));
        foreach (var b in m.Blocks)
            File.WriteAllText(Path.Combine(dir, "blocks", Safe(b.Name) + ".md"), BlockPage(m, b, statics));
        File.WriteAllText(Path.Combine(dir, "config-values.md"), ConfigValues(m));
        File.WriteAllText(Path.Combine(dir, "actions.md"), Actions(m));
        File.WriteAllText(Path.Combine(dir, "themes.md"), Themes(m));
    }

    private static string Index(UiModule m)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {m.Name} {m.Version} ({m.Kind})");
        sb.AppendLine();
        sb.AppendLine($"Gerado em {m.GeneratedAt} de `{m.Source}` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.");
        sb.AppendLine();
        sb.AppendLine($"{m.Blocks.Count} blocos ({m.Blocks.Count(b => b.Public)} publicos), {m.StaticEntities.Count} static entities de configuracao, {m.Actions.Count(a => a.Public)} actions publicas, {m.Scripts.Count} scripts, {m.Themes.Count} temas.");
        sb.AppendLine();
        sb.AppendLine("## Como instanciar um bloco com os verbos");
        sb.AppendLine();
        sb.AppendLine("O modulo alvo precisa referenciar a biblioteca (`references`). Um bloco entra na tela como block instance:");
        sb.AppendLine();
        var web = m.Blocks.Count > 0 && m.Blocks.All(b => b.Runtime == "Traditional");
        sb.AppendLine("```json");
        if (web)
        {
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"IWebFlow:MainFlow\",\"type\":\"IWebScreen\",\"name\":\"Minha\",\"as\":\"$scr\"}   // nasce com o layout do tema e placeholders Title/MainContent/...");
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"$scr/#IWebBlockInstanceWidget/MainContent\",\"type\":\"IWebBlockInstanceWidget\",\"name\":\"Card1\",\"source\":\"IWebBlock:Card\",\"empty\":true,\"as\":\"$card\"}");
            sb.AppendLine("// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders");
            sb.AppendLine("{\"op\":\"set\",\"target\":\"$card/ExtendedClass\",\"prop\":\"Value\",\"value\":\"\\\"padding-m\\\"\"}   // input -> IArgument.Value (expressao)");
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"$card/Content\",\"type\":\"IExpressionWidget\",\"as\":\"$e\"}   // placeholder por nome; widgets Web usam o sufixo Widget");
            sb.AppendLine("{\"op\":\"set\",\"target\":\"$e\",\"prop\":\"Value\",\"value\":\"\\\"Ola\\\"\"}");
        }
        else
        {
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"$scr/#IMobileBlockInstanceWidget/MainContent\",\"type\":\"IMobileBlockInstanceWidget\",\"name\":\"Accordion1\",\"source\":\"IMobileBlock:Accordion\",\"empty\":true,\"as\":\"$acc\"}");
            sb.AppendLine("// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders (nasce ao definir o SourceBlock)");
            sb.AppendLine("{\"op\":\"set\",\"target\":\"$acc/MultipleItems\",\"prop\":\"Value\",\"value\":\"True\"}          // input -> IArgument.Value");
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"$acc/Content\",\"type\":\"IContainer\",\"name\":\"Inner\"}      // placeholder por nome");
        }
        sb.AppendLine("```");
        sb.AppendLine();
        sb.AppendLine(web
            ? "Widgets nativos do Traditional: IContainerWidget, IExpressionWidget, IInputWidget, IButtonWidget, ILinkWidget, ITableRecordsWidget, IListRecordsWidget, IIfWidget, IEditRecordWidget, IComboBoxWidget, ICheckBoxWidget (namespace OutSystems.Model.UI.Web.Widgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos."
            : "Widgets nativos do Reactive/Mobile: IContainer, IExpression, IInput, IButton, ILink, IList, IListItem, ITableRecords, IDropdown, ICheckbox, ISwitch, IIcon, IImage, IForm (plugin NRWidgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos e eventos obrigatorios precisam de handler (secao 'Como ligar um evento' da pagina).");
        sb.AppendLine();
        foreach (var g in m.Blocks.GroupBy(b => b.Flow).OrderBy(g => g.Key))
        {
            sb.AppendLine($"## {g.Key} ({g.Count()})");
            sb.AppendLine();
            sb.AppendLine("| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |");
            sb.AppendLine("|---|---|---|---|---|---|");
            foreach (var b in g.OrderBy(b => b.Name))
                sb.AppendLine($"| [{b.Name}](blocks/{Safe(b.Name)}.md) | {(b.Public ? "sim" : "nao")} | {FirstSentence(b.Description)} | {b.Inputs.Count} | {string.Join(", ", b.Placeholders.Select(p => p.Name))} | {string.Join(", ", b.Events.Select(e => e.Name))} |");
            sb.AppendLine();
        }
        sb.AppendLine("Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).");
        return sb.ToString();
    }

    private static string BlockPage(UiModule m, UiBlock b, IReadOnlyDictionary<string, UiStaticEntity> statics)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {b.Name}");
        sb.AppendLine();
        sb.AppendLine($"{m.Name} {m.Version} | {b.Runtime} | UI flow **{b.Flow}** | {(b.Public ? "publico" : "privado")} | {b.Widgets} widgets internos");
        sb.AppendLine();
        if (!string.IsNullOrWhiteSpace(b.Description)) { sb.AppendLine(b.Description.Trim()); sb.AppendLine(); }

        sb.AppendLine("## Inputs");
        sb.AppendLine();
        if (b.Inputs.Count == 0) sb.AppendLine("Nenhum.");
        else
        {
            sb.AppendLine("| Nome | Tipo | Obrigatorio | Default | Descricao |");
            sb.AppendLine("|---|---|---|---|---|");
            foreach (var i in b.Inputs) sb.AppendLine($"| {i.Name} | {i.Type} | {(i.Mandatory ? "sim" : "nao")} | {Cell(i.Default)} | {Cell(i.Description)} |");
        }
        var cfg = b.Inputs.Select(i => i.Type).Where(t => t.EndsWith(" Identifier")).Select(t => t[..^11]).Distinct().Where(statics.ContainsKey).ToList();
        if (cfg.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("Valores possiveis (static entities):");
            sb.AppendLine();
            foreach (var c in cfg)
            {
                var s = statics[c];
                sb.AppendLine($"- **Entities.{s.Name}**: {string.Join(", ", s.Records.Select(r => r.Id))}");
            }
        }
        sb.AppendLine();

        sb.AppendLine("## Placeholders");
        sb.AppendLine();
        if (b.Placeholders.Count == 0) sb.AppendLine("Nenhum.");
        else foreach (var p in b.Placeholders) sb.AppendLine($"- **{p.Name}**{(string.IsNullOrWhiteSpace(p.Description) ? "" : ": " + p.Description.Trim())}{(string.IsNullOrEmpty(p.Path) ? "" : $" (em `{p.Path}`)")}{(p.Defaults.Count == 0 ? "" : p.Defaults.Any(x => x.StartsWith("Input", StringComparison.Ordinal)) ? $" | nasce com: {string.Join(", ", p.Defaults)}. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/{p.Name}/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)" : $" | nasce com: {string.Join(", ", p.Defaults)} (use `\"empty\": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)")}");
        sb.AppendLine();

        sb.AppendLine("## Eventos");
        sb.AppendLine();
        if (b.Events.Count == 0) sb.AppendLine("Nenhum.");
        else foreach (var e in b.Events)
            sb.AppendLine($"- **{e.Name}**({string.Join(", ", e.Params.Select(p => $"{p.Name}: {p.Type}"))}){(e.Mandatory ? " [obrigatorio]" : "")}{(string.IsNullOrWhiteSpace(e.Description) ? "" : ": " + e.Description.Trim())}");
        sb.AppendLine();

        if (b.Uses.Count > 0 || b.RequiredScripts.Count > 0 || b.Lifecycle.Count > 0 || b.Actions.Count > 0 || b.Calls.Count > 0)
        {
            sb.AppendLine("## Composicao interna");
            sb.AppendLine();
            if (b.Uses.Count > 0) sb.AppendLine($"- Usa os blocos: {string.Join(", ", b.Uses)}");
            if (b.RequiredScripts.Count > 0) sb.AppendLine($"- Scripts exigidos: {string.Join(", ", b.RequiredScripts)}");
            if (b.Lifecycle.Count > 0) sb.AppendLine($"- Ciclo de vida: {string.Join("; ", b.Lifecycle)}");
            if (b.Actions.Count > 0) sb.AppendLine($"- Actions do bloco: {string.Join(", ", b.Actions)}");
            if (b.Calls.Count > 0) sb.AppendLine($"- Chama actions do modulo: {string.Join(", ", b.Calls)} (contratos em [actions.md](../actions.md))");
            sb.AppendLine();
        }

        sb.AppendLine("## JavaScript");
        sb.AppendLine();
        if (b.OsuiApi.Count > 0) { sb.AppendLine("APIs OSUI alcancadas (direto ou pelas actions chamadas): " + string.Join(", ", b.OsuiApi.Select(a => $"`{a}`"))); sb.AppendLine(); }
        if (!string.IsNullOrWhiteSpace(b.JavaScript)) { sb.AppendLine("JavaScript do bloco:"); sb.AppendLine(); sb.AppendLine("```js"); sb.AppendLine(Trunc(b.JavaScript, 6000)); sb.AppendLine("```"); sb.AppendLine(); }
        if (b.JsNodes.Count == 0 && string.IsNullOrWhiteSpace(b.JavaScript)) sb.AppendLine("Sem JavaScript proprio.");
        foreach (var j in b.JsNodes)
        {
            sb.AppendLine($"`{j.Action}` / no `{j.Node}`:");
            sb.AppendLine();
            sb.AppendLine("```js");
            sb.AppendLine(Trunc(j.Code, 6000));
            sb.AppendLine("```");
            sb.AppendLine();
        }

        sb.AppendLine("## CSS");
        sb.AppendLine();
        if (b.Css == null) sb.AppendLine("Sem CSS proprio (estilo vem do tema).");
        else
        {
            if (b.CssClasses.Count > 0) sb.AppendLine("Classes: " + string.Join(", ", b.CssClasses.Select(c => $"`.{c}`")));
            if (b.CssVars.Count > 0) { sb.AppendLine(); sb.AppendLine("Variaveis: " + string.Join(", ", b.CssVars.Select(v => $"`{v}`"))); }
            sb.AppendLine();
            sb.AppendLine("```css");
            sb.AppendLine(Trunc(b.Css, 12000));
            sb.AppendLine("```");
        }
        sb.AppendLine();

        sb.AppendLine("## Como criar (verbos)");
        sb.AppendLine();
        var instType = b.Runtime == "Traditional" ? "IWebBlockInstanceWidget" : "IMobileBlockInstanceWidget";
        var blockType = b.Runtime == "Traditional" ? "IWebBlock" : "IMobileBlock";
        sb.AppendLine("```json");
        var hasDefaults = b.Placeholders.Any(p => p.Defaults.Count > 0 && !p.Defaults.Any(x => x.StartsWith("Input", StringComparison.Ordinal)));
        sb.AppendLine($"{{\"op\":\"create\",\"parent\":\"<placeholder ou container da tela>\",\"type\":\"{instType}\",\"name\":\"{b.Name}1\",\"source\":\"{blockType}:{b.Name}\"{(hasDefaults ? ",\"empty\":true" : "")},\"as\":\"$b\"}}");
        foreach (var i in b.Inputs.Where(i => i.Mandatory).Take(6))
            sb.AppendLine($"{{\"op\":\"set\",\"target\":\"$b/{i.Name}\",\"prop\":\"Value\",\"value\":\"<{i.Type}>\"}}");
        var childWidget = b.Runtime == "Traditional" ? "IExpressionWidget" : "IExpression";
        foreach (var p in b.Placeholders.Take(4))
        {
            if (p.Defaults.Any(x => x.StartsWith("Input", StringComparison.Ordinal)))
            {
                sb.AppendLine($"{{\"op\":\"set\",\"target\":\"$b/{p.Name}/#IInput\",\"prop\":\"Variable\",\"value\":\"<variavel local>\"}}");
                continue;
            }
            if (p.Defaults.Count > 0) continue;
            // o bloco filho esperado e o que a descricao do placeholder cita ("Drag TabsContentItem blocks...") e o bloco usa por dentro
            var child = b.Uses.FirstOrDefault(u => p.Description != null && p.Description.Contains(u, StringComparison.Ordinal));
            var expected = child != null
                ? $"{instType}\",\"source\":\"{blockType}:{child}\",\"name\":\"{child}1"
                : $"{childWidget}\",\"as\":\"$e{p.Name}";
            sb.AppendLine($"{{\"op\":\"create\",\"parent\":\"$b/{p.Name}\",\"type\":\"{expected}\"}}");
        }
        sb.AppendLine("```");
        if (b.Events.Count > 0 && b.Runtime != "Traditional")
        {
            var ev = b.Events[0];
            sb.AppendLine();
            sb.AppendLine("## Como ligar um evento (handler)");
            sb.AppendLine();
            sb.AppendLine($"O handler e uma screen action com um input por parametro do evento; `$b/{ev.Name}` resolve o IEventHandler pelo nome do evento e `$b/{ev.Name}/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).");
            sb.AppendLine();
            sb.AppendLine("```json");
            sb.AppendLine($"{{\"op\":\"create\",\"parent\":\"$scr\",\"type\":\"IScreenAction\",\"name\":\"{b.Name}1_{ev.Name}\",\"as\":\"$h\"}}");
            var k = 0;
            foreach (var p in ev.Params)
            {
                k++;
                sb.AppendLine($"{{\"op\":\"create\",\"parent\":\"$h\",\"type\":\"IInputParameter\",\"name\":\"{p.Name}\",\"as\":\"$p{k}\"}}");
                sb.AppendLine($"{{\"op\":\"set\",\"target\":\"$p{k}\",\"prop\":\"DataType\",\"value\":\"{p.Type}\"}}");
            }
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"$h\",\"type\":\"IStartNode\",\"as\":\"$hs\"}");
            sb.AppendLine("{\"op\":\"create\",\"parent\":\"$h\",\"type\":\"IEndNode\",\"as\":\"$he\"}");
            sb.AppendLine("{\"op\":\"link\",\"from\":\"$hs\",\"to\":\"$he\"}   // ponha a logica entre Start e End");
            sb.AppendLine("{\"op\":\"layout\",\"target\":\"$h\"}");
            sb.AppendLine($"{{\"op\":\"set\",\"target\":\"$b/{ev.Name}\",\"prop\":\"Handler\",\"value\":\"$h\"}}");
            foreach (var p in ev.Params)
                sb.AppendLine($"{{\"op\":\"set\",\"target\":\"$b/{ev.Name}/{p.Name}\",\"prop\":\"Value\",\"value\":\"{p.Name}\"}}");
            sb.AppendLine("```");
        }
        return sb.ToString();
    }

    private static string ConfigValues(UiModule m)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {m.Name} {m.Version}: valores de configuracao (static entities)");
        sb.AppendLine();
        foreach (var s in m.StaticEntities.OrderBy(s => s.Name))
        {
            sb.AppendLine($"## Entities.{s.Name}");
            sb.AppendLine();
            if (!string.IsNullOrWhiteSpace(s.Description)) { sb.AppendLine(s.Description.Trim()); sb.AppendLine(); }
            var cols = s.Attributes.Where(a => a != "Id").ToList();
            sb.AppendLine("| Id | " + string.Join(" | ", cols) + " |");
            sb.AppendLine("|---|" + string.Concat(cols.Select(_ => "---|")));
            foreach (var r in s.Records)
                sb.AppendLine($"| {r.Id} | " + string.Join(" | ", cols.Select(c => Cell(r.Values.TryGetValue(c, out var v) ? v : ""))) + " |");
            sb.AppendLine();
        }
        if (m.Structures.Count > 0)
        {
            sb.AppendLine("# Structures");
            sb.AppendLine();
            foreach (var s in m.Structures.OrderBy(s => s.Name))
            {
                sb.AppendLine($"## {s.Name}");
                sb.AppendLine();
                if (!string.IsNullOrWhiteSpace(s.Description)) { sb.AppendLine(s.Description.Trim()); sb.AppendLine(); }
                foreach (var a in s.Attributes) sb.AppendLine($"- {a.Name}: {a.Type}{(a.Mandatory ? " [obrigatorio]" : "")}{(string.IsNullOrEmpty(a.Default) ? "" : $" = {a.Default}")}{(string.IsNullOrWhiteSpace(a.Description) ? "" : " - " + a.Description.Trim())}");
                sb.AppendLine();
            }
        }
        return sb.ToString();
    }

    private static string Actions(UiModule m)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {m.Name} {m.Version}: actions publicas");
        sb.AppendLine();
        foreach (var a in m.Actions.Where(a => a.Public).OrderBy(a => a.Kind).ThenBy(a => a.Name))
        {
            sb.AppendLine($"## {a.Name} ({a.Kind}{(a.Function ? ", function" : "")})");
            sb.AppendLine();
            if (!string.IsNullOrWhiteSpace(a.Description)) { sb.AppendLine(a.Description.Trim()); sb.AppendLine(); }
            foreach (var i in a.Inputs) sb.AppendLine($"- in {i.Name}: {i.Type}{(i.Mandatory ? " [obrigatorio]" : "")}{(string.IsNullOrEmpty(i.Default) ? "" : $" = {i.Default}")}{(string.IsNullOrWhiteSpace(i.Description) ? "" : " - " + i.Description.Trim())}");
            foreach (var o in a.Outputs) sb.AppendLine($"- out {o.Name}: {o.Type}{(string.IsNullOrWhiteSpace(o.Description) ? "" : " - " + o.Description.Trim())}");
            if (a.Calls.Count > 0) sb.AppendLine("- chama: " + string.Join(", ", a.Calls));
            if (a.OsuiApi.Count > 0) sb.AppendLine("- APIs OSUI: " + string.Join(", ", a.OsuiApi.Select(x => $"`{x}`")));
            sb.AppendLine();
        }
        return sb.ToString();
    }

    private static string Themes(UiModule m)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {m.Name} {m.Version}: temas, tokens e scripts");
        sb.AppendLine();
        foreach (var t in m.Themes)
        {
            sb.AppendLine($"## {t.Name} ({t.Runtime}{(t.BaseTheme == null ? "" : ", base " + t.BaseTheme)}) - CSS {t.CssBytes / 1024} KB{(t.File == null ? "" : ", copia local em `" + t.File + "`")}");
            sb.AppendLine();
            if (t.Tokens.Count > 0)
            {
                sb.AppendLine("| Token | Valor |");
                sb.AppendLine("|---|---|");
                foreach (var kv in t.Tokens) sb.AppendLine($"| `{kv.Key}` | {Cell(kv.Value)} |");
            }
            sb.AppendLine();
        }
        sb.AppendLine("## Scripts");
        sb.AppendLine();
        foreach (var s in m.Scripts.OrderBy(s => s.Name))
            sb.AppendLine($"- {s.Name}{(s.Public ? " (publico)" : "")}: {s.Bytes / 1024} KB{(string.IsNullOrWhiteSpace(s.Description) ? "" : " - " + FirstSentence(s.Description))}{(s.File == null ? "" : $" (`{s.File}`)")}");
        return sb.ToString();
    }

    private static string FirstSentence(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        s = s.Replace("\r", " ").Replace("\n", " ").Trim();
        var i = s.IndexOf(". ", StringComparison.Ordinal);
        var r = i > 0 ? s[..(i + 1)] : s;
        return Cell(r.Length > 160 ? r[..157] + "..." : r);
    }

    private static string Cell(string? s) => (s ?? "").Replace("\r", " ").Replace("\n", " ").Replace("|", "\\|").Trim();
    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..max] + "\n/* ... truncado: " + (s.Length - max) + " chars a mais no JSON do catalogo */";
    private static string Safe(string s) { foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_'); return s; }
}
