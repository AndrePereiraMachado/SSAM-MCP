# WS4 — Compilador HTML visual no kernel

```
WS4 Compilador HTML visual no kernel (widgets e CSS; nenhuma logica) — estado: concluido (T1 a T6); T7 aguarda WS1
Branch/pasta: C:\Users\andre\Anvil-ws4, branch ws/4-html-visual (de anvil 53ef2cb), commit 370ab77
Tarefas: [x] T1 [x] T2 [x] T3 [x] T4 [x] T5 [x] T6 [ ] T7 (aguarda ws/1: a fixture ODC e tests\jobs-odc\ sao do WS1)
```

## Provas (comando -> saida colada)

**Pre-condicao / base**, antes de tocar em qualquer ficheiro, no worktree limpo em `53ef2cb`:

```
dotnet test tests/Anvil.Tests -c Release
Com falha! - Com falha:   151, Aprovado:  1005, Ignorado:     0, Total:  1156, Duracao: 25 m 27 s - Anvil.Tests.dll (net8.0)
```

E exatamente o conjunto que o WS0 mediu e que a regra 1.8 do plano atribui ao integrador (fixture
`outsystems-ui.oml` fora do repositorio, `base` em `.local\work\deliver`, `Incidents_CS` nao ligado, jobs
`incidents-*` em curso). Nenhuma falha cita tipo ou ficheiro do WS4.

**T1 (tabela e recusas, sem Studio) e T5 (contra-provas)**

```
dotnet test tests/Anvil.Tests -c Release --filter HtmlVisualTests
Aprovado!  - Com falha:     0, Aprovado:    48, Ignorado:     0, Total:    48, Duracao: 125 ms - Anvil.Tests.dll (net8.0)
```

**T2 (alerta sobre `reactive-ui.oml`: painel, icone, titulo, tres textos, dois inputs, botao)**

```
python scripts\run_job.py tests\jobs\html-visual-alert.json
== html-visual-alert.json: ok=True {'ops': 22, 'objects': 11354, 'isValid': True, 'messages': 0, 'applyMs': 1746}
```

O `<style>` do fragmento entra no tema do modulo. O ultimo op do job le o tema; `run_job` corta a impressao a 1500
caracteres, por isso a prova esta no result.json inteiro
(`.local\lane-ss5\jobs\html-visual-alert.result.json`, `data.results[-1].result.properties.StyleSheet`):

```
/* anvil:html wf-alert */
.wf-alert { border: 1px solid #f0b429; border-radius: 6px; padding: 12px; background: #fffaf0; }
.wf-alert .wf-alert-head { display: flex; gap: 8px; align-items: center; }
.wf-alert .wf-alert-title { font-weight: 600; font-size: 16px; }
.wf-alert .wf-alert-body { margin: 4px 0; color: #4b5563; }
.wf-alert .wf-alert-field { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
/* /anvil:html wf-alert */
```

**T3 (lista sobre um aggregate existente, com `{{ Row.X }}`)**

```
python scripts\run_job.py tests\jobs\html-visual-list.json
== html-visual-list.json: ok=True {'ops': 8, 'objects': 11275, 'isValid': True, 'messages': 0, 'applyMs': 668}
           IList UserList
                   IExpression  = GetUsers.List.Current.User.Name
                   IExpression  = GetUsers.List.Current.User.Email
```

**T4 (instancia de bloco com input e handler)**

```
python scripts\run_job.py tests\jobs\html-visual-block.json
== html-visual-block.json: ok=True {'ops': 26, 'objects': 11250, 'isValid': True, 'messages': 1, 'applyMs': 732}
           IMobileBlockInstanceWidget BookingDate
               IExpression  = "yyyy-MM-dd"
             IPlaceholderContentWidget Datepicker
               IInput Input_SelectedDate
                 IExpression  = SelectedDate
             IEventHandler
                 IExpression  = DatePickerId
                 IExpression  = SelectedDateTime
```

A unica mensagem e o `UnusedElement` declarado em `expectedMessages` (`DatePickerId` faz parte do contrato do evento).

**Build**

```
dotnet build src/Anvil.Cli -c Release
Compilacao com exito.    10 Aviso(s)    0 Erro(s)
```

Os 10 avisos sao os da base (`NativeDependencyReader`, `VacationRentalRecipe`, `TemporadaRecipe`, `Publisher`,
`HtmlExpander`, `UiGallery`); nenhum vem de `HtmlVisual.cs`.

**Suite completa depois do diff**

```
dotnet test tests/Anvil.Tests -c Release
Com falha! - Com falha:   151, Aprovado:  1056, Ignorado:     0, Total:  1207, Duracao: 24 m 44 s - Anvil.Tests.dll (net8.0)
```

Mesmas 151 falhas, +51 testes, todos verdes (48 do `HtmlVisualTests` e os 3 jobs novos que entram no theory do
`JobTests`). Comparacao nome a nome dos dois logs (regex sobre as linhas `Com falha <nome>`):

```
base: 151 nomes unicos | after: 151 nomes unicos
novas (regressao): 0
desaparecidas: 0
```

Nenhuma falha cita `HtmlVisual`.

## Arquivos criados/alterados

Novos (meus, pela lista do brief):

- `src\Anvil.Core\Kernel\HtmlVisual.cs` — `HtmlVisual.Expand(html, parentRef, resolve)`, `Preflight`, `Schema()`, e a
  partial de `ModelSession` que aplica o op e instala o tema.
- `src\Anvil.Core\Kernel\HtmlVisualVocabulary.json` — a sintaxe fechada, legivel por maquina.
- `tests\html\visual\alert.html`, `list.html`, `block.html`
- `tests\jobs\html-visual-alert.json`, `html-visual-list.json`, `html-visual-block.json`
- `tests\Anvil.Tests\HtmlVisualTests.cs` — 48 casos.
- `docs\UI-HTML-VISUAL.md`
- `docs\tasks\ws4-relatorio.md` (este ficheiro)

Alterados (registo da op, uma linha cada):

- `src\Anvil.Core\Kernel\HtmlDelta.cs` — `if (op["parent"] != null) return ApplyHtmlVisual(op);` no topo de `Html(op)`.
- `src\Anvil.Core\Kernel\JobPreflight.cs` — `if (op["parent"] != null) HtmlVisual.PreflightOp(op);` no ramo `html`.

`Verbs.cs`, `JobRunner.cs`, `AGENTS.md`, `CLAUDE.md`, `*.csproj`, `HtmlExpander.cs`, `HtmlSource.cs` e
`ScreenVocabulary.json`: **nao tocados**.

## Fora do brief

1. **O registo da op ficou em dois pontos, nao um.** O brief prevê "um ponto, indicado pelo WS0 no inventario"; o
   inventario do WS0 e sobre o contrato do adaptador e nao indica nenhum. `Verbs.cs:103` ja encaminha
   `"html" => Html(op)` (nada a fazer la, e nao toquei). O encaminhamento real da forma nova esta em
   `ModelSession.Html` (`Kernel\HtmlDelta.cs`) e, sem uma segunda linha em `Kernel\JobPreflight.cs`, o preflight
   rejeita o op com `html: 'data' is required` e nenhum job chega a correr. Fiz as duas linhas, uma em cada, sem
   mais nada; o corpo do handler vive no meu ficheiro. Diff exato em `lab\ws4-html-visual\BLOCKER.md` (D1) — se o
   integrador as preferir suas, basta reverter essas duas linhas.
2. **`HtmlVisualVocabulary.json` nao e EmbeddedResource** (o `*.csproj` e partilhado, 1.2): a fonte da sintaxe e
   `HtmlVisual.Schema()` em codigo, e o JSON e a copia publicada; o teste `TheVocabularyFileIsExactlyTheCompiledSyntax`
   prova que nao divergem. Detalhe em D2 do BLOCKER.
3. **`weight` do `<i>`.** O `IIcon` do O11 (Model API 11.55.69) nao tem propriedade `Weight`; o do ODC tem. Mantive o
   `weight` **obrigatorio na sintaxe** nas duas faixas (T5 prova a recusa sem ele) e emito `set Weight` so onde o
   widget o pode guardar — quem responde e o `HtmlVisualScope.Supports`, que o `Adapters.ODC` fornece; sem ele vale o
   `ScreenVocabulary.json` do kernel. Isto e o que torna a mesma tabela valida nas duas plataformas.
4. **Ligacao dos parametros de evento.** Para `@Evento="Acao"`, emito tambem `set $bloco/<Evento>/<Param> Value <Param>`
   para cada parametro que o handler declara com o mesmo nome. Nao esta escrito no brief, mas sem isso a instancia de
   bloco nao passa no Verify (e o mesmo que o `HtmlExpander` ja faz para o DatePicker).
5. **`parent` dos jobs de prova.** O brief exemplifica `{"op":"html","parent":"$tela",...}`; nos jobs usei
   `"$tela/#IMobileBlockInstanceWidget/MainContent"`, o placeholder de conteudo do layout Reactive, porque e o pai
   correto para `isValid=True`. A forma do op nao muda.

## Duvidas para o integrador

1. **`AGENTS.md`** (B2 do BLOCKER): os tres jobs novos precisam de uma linha na seccao 3.5, senao
   `GuideTests.EveryTestJobIsMentionedInTheGuide` conta-os como orfaos. O ficheiro e partilhado; texto sugerido no
   BLOCKER.
2. **T7.** Assim que `ws/1` fechar, os mesmos tres fragmentos correm em `tests\jobs-odc\` com a fixture ODC. O
   `Adapters.ODC` so precisa de passar um `Supports` que conheca `IIcon.Weight`; nada em `HtmlVisual.cs` muda.
3. **Base do branch.** `ws/4-html-visual` nasceu de `anvil` 53ef2cb, antes dos merges de `ws/0` (`d6f7dd0`) e `ws/3`
   (`03dbf4d`). O meu diff nao toca em nada do contrato do adaptador, mas o merge e do integrador.
