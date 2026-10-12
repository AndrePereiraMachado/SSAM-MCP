# Protótipo → telas nativas em uma chamada (contrato)

Base: `integracao/liberacao23-20261010` = `cd7e4f11`. Branch deste contrato: `feat/prototipo-nativo-contrato`.
Este documento é o contrato das 5 lanes que constroem o importador. **Revisão 2 (2026-10-10):** aplica os 11 pontos
obrigatórios e os 22 recomendados da crítica, ou os refuta com evidência; o registro ponto a ponto está na seção 10.

Fontes: o diagnóstico da sessão UI-Mockup (`an\prototipo-vs-resultado.md`, `an\html-compiler.md`, `an\refs-validation.md`,
`an\read-errors.md`, `an\replay.md`, `an\counterfactual-23.md`, `an\timeline.md`), os arquivos do gerador do concorrente
(`C:\Users\andre\.codex\native-farmavirtual\`), o rollout do Codex de 2026-10-10 (21:36Z–22:30Z) e as evidências novas da
seção 0.1.

## 0. Por que existe e qual é a meta

| | SSAM 22º (20:25Z) | MCP oficial + Codex (21:58Z) | Meta deste contrato |
|---|---|---|---|
| Telas | 1 tela SPA com as 6 vistas e os modais | 6 telas nativas em `MainFlow` (as telas antigas do flow foram apagadas pelo gerador) | 6 telas nativas, 1 por vista, num flow próprio |
| Tempo | ~25 min (turno 1) + turno 2 "ta tudo sem css" | ~17–18 min até o 1º merge com 6 telas; ajustes até 22:29Z | **5–7 min** de ponta a ponta, com merge, publicação e dados (seção 6) |
| Chamadas | 172 MCP, 28 erros (10 recusas html, uma por vez) | ~114 `exec`; 1,37 MB de C# escrito por um gerador que o modelo escreveu | **1 chamada** (mais as palavras de autorização do dono) |
| Fidelidade | ~90%; 35% do CSS apagado pelo modelo ao contornar uma recusa | 100% visual na avaliação do dono | **100% medido** sobre o modelo construído lido de volta, com o DOM de runtime congelado e o diff de seletores, em cada estado explorado (4.4) |
| Estrutura | 1.853 widgets para 922 elementos | `native-model.cs`: 975 `IContainer`, 856 `IAdvancedHtml`, 154 `IIfWidget`, **0** `IPopup`, **0** `IList`, **0** bloco, **0** `IForm`; listas desenroladas por produto; `Gap=null` em 1.789 widgets | 922 elementos casados 1:1; `IPopup`, `IList`, bloco do shell, `IForm`; wrappers nativos listados |
| Fluxo principal | parcial | funcionando (carrinho, selo, pedido) com 121 Client Variables desenroladas por produto | funcionando, nativo: entidades, aggregates e server actions; 0 actions vazias (3.4) |

O método do concorrente funcionou porque o modelo escreveu um compilador: renderizou cada vista e modal numa árvore DOM em
node (`generate-trees.cjs`), mapeou elemento→widget, eventos, ícones e fontes (`build-native.cjs`, `bindings.json`,
`icons.json`, `fonts.css`) e emitiu Model API em poucas chamadas. O preço foi alto: regras escritas à mão para este
protótipo (`textExpression` por classe CSS, `bindings.json` por produto, `visual-patches.cjs`, `behavior-patches.cjs`,
`orders-enhancements.cjs`), estado desenrolado em Client Variables, o tema `Haiku_UI` do módulo inteiro com
`BaseTheme=null` e o CSS prefixado com `.fv-native-root`.

**Direção do dono (obrigatória):** o SSAM é dono desse compilador, de forma determinística.

1. Uma chamada transforma a pasta do protótipo em telas nativas. O modelo escreve no máximo um mapping mínimo quando o SSAM
   não consegue inferir.
2. Regras determinísticas do motor valem mais que testes e provas ao vivo. Os testes são checagens internas.
3. Sem rodadas de validação para o modelo. Uma recusa traz **todos** os problemas, uma vez, com o patch pronto.
4. Sem verificação de tela por LLM. A fidelidade vem da construção: mesma estrutura DOM, mesmos nomes de classe, CSS
   verbatim. O diff estrutural e o de seletores são calculados pelo motor.
5. É um compilador do desenho do usuário, não um gerador de padrões repetidos: nada de uma action por produto, nada de
   variável por campo de registro, nada de regra escrita para um protótipo específico.

### 0.1 Evidências novas desta revisão

| Evidência | Origem | Uso |
|---|---|---|
| Lista de tags aceitas pelo HTML Element: 103 no O11, 100 no ODC (o ODC não tem `data`, `main`, `picture`); nenhuma das duas tem `dialog`, `svg`, `path`, `template`, `slot`, `br` | IL do validador ao lado de `"' is not a valid HTML tag."`: `ServiceStudio.Plugin.NRWidgets.dll` 11.55.91.65258 e `OutSystems.Model.Plugin.NRWidgets.dll` 13.1431.3 (ODC Studio); sequência de `ldstr` depois da regex `^[0-9a-z]+[0-9a-z-]*` | 3.2 |
| DOM de runtime O11 publicado: `<a data-link="" class="brand" href="#" id="Link8">`, `<span data-advancedhtml="" class="brand-mark" id="Element11">`, `<div data-container="" class="icon OSInline" style="…">`, `<div data-container="" class="OSInline ThemeGrid_MarginGutter" id="Container14">Farma<span …>Virtual</span></div>` (texto sem wrapper), `<span><input data-checkbox="" class="" type="checkbox" id="Input161"></span>` | leituras do navegador no rollout do concorrente em `https://personal-2qqw9srv.outsystemscloud.com/Haiku_UI/FarmaVirtual` | 3.3, 4.2 |
| Instância de bloco: `div.OSBlockWidget` com `data-block` | `kernel/tests/html/dcips-approval.css` (`.av-badges>.OSBlockWidget`), `dcips-masscasualty.css` (`[data-block*="MC_"]`) | 4.2 |
| jsdom 30.1.1 nesta máquina, scripts compilados uma vez (`vm.Script`) e `runScripts:"outside-only"`: janela fria 248 ms, quente mediana 30 ms / p90 46 ms; 6 rotas renderizadas em 73 ms; `innerText` ausente; `requestAnimationFrame` presente com `pretendToBeVisual`; módulos ES não executam (`HTMLScriptElement-impl.js:175`); exports `JSDOM, VirtualConsole, CookieJar, requestInterceptor, toughCookie` (sem `ResourceLoader`) | medição local, `jsdom/lib/api.js:300-306` | 2.1, 2.6, 6 |
| Tempos: entrega 105 com build 123,5 s ao vivo (máquina 46% ocupada) e 82,4 s no replay frio, 70,1 s deles aplicando as ops; merge 55,0 s. Concorrente: `omlPublish` de `Haiku_UI` em 11,8 s (21:48:13→21:48:25) e `omlMerge` + `omlPublish` finais em 27,9 s (22:29:11→22:29:39) | `an\timeline.md:132`, `an\replay.md` seção 4, rollout | 6 |
| Máquina do dono: 32 processadores lógicos | `NUMBER_OF_PROCESSORS` | 2.6 |

## 1. A chamada

### 1.1 Forma

O importador é um **op de job**, `prototype`, que roda dentro das ferramentas de entrega existentes. Assim ele herda a
captura fresca, o build headless (`anvil apply`), o Verify, o merge, o `publish:true` e as palavras de autorização sem
nenhum passo novo.

O11 (Service Studio):

```json
{"tool":"o11_deliver","arguments":{
  "module":"Haiku_UI",
  "job":{"ops":[{"op":"prototype","data":{"source":"C:\\Users\\andre\\GitSSAM\\prototypes\\farmavirtual"}}]},
  "publish":true,
  "authorize":"<palavras do dono, verbatim>"}}
```

ODC (ODC Studio), pelo servidor unificado `ssam` (`platforms/odc/facade/ssam.mjs`): o `job` inline é aceito porque o
proxy o grava em arquivo (`writeInlineJob`, `ssam.mjs:416`); o servidor nativo do ODC recebe `job` só como caminho.
`feature` é obrigatório; com `job`, `owners` e `changes` também (schema de `studio_deliver` em `mcp.mjs:161-168`):

```json
{"tool":"studio_deliver","arguments":{
  "feature":"Protótipo FarmaVirtual",
  "module":"<módulo aberto>",
  "job":{"ops":[{"op":"prototype","data":{"source":"C:\\...\\farmavirtual"}}]},
  "owners":["FarmaVirtual"],
  "changes":["Protótipo FarmaVirtual importado como telas nativas"],
  "publish":true,
  "authorize":"<palavras do dono, verbatim>"}}
```

A rota de descoberta (lane surface, 7.6) entrega as duas formas prontas, com `owners = [<prefix>]` e `changes` preenchidos.

Ensaio sem merge (opcional, nunca exigido): O11 `o11_deliver {..., until:"apply"}` ou `o11_job`/`ssam_job` com o mesmo op;
ODC `studio_deliver {..., until:"preview"}` (valores válidos no ODC: `snapshot`, `build`, `check-base`, `preview`,
`merge`; não existe `apply`). O ensaio devolve o mesmo recibo sem merge, publicação e dados.

São cerca de 300 bytes escritos pelo modelo. O modelo **não lê** `app.js`, `model.js` nem `styles.css`: o SSAM lê.

### 1.2 Campos de `data`

| Campo | Tipo | Obrigatório | Default | Regra |
|---|---|---|---|---|
| `source` | texto (caminho absoluto) | sim | — | Pasta do protótipo ou um arquivo `.html` dentro dela. Lido só para leitura, só pela fachada. |
| `entry` | texto | não | `index.html`; senão o único `.html` da raiz; senão recusa | Relativo a `source`. |
| `app` | `reactive` \| `mobile` | não | o tipo do módulo/app aberto | ODC ou O11 vem da ferramenta. |
| `prefix` | texto `^[A-Za-z][A-Za-z0-9]*$` | não | o `<title>` até o primeiro separador (`\|`, `-`, `–`, `:`), em PascalCase ASCII; senão o nome da pasta | Prefixo de flow, tema, bloco, imagens, entidades e variáveis de cliente. FarmaVirtual → `FarmaVirtual`. |
| `mapping` | objeto (1.3) | não | `{}` | Só quando a inferência pede, com o texto exato que a recusa entrega. |
| `clock` | ISO-8601 UTC | não | o `mtime` mais novo entre os arquivos de `source` lidos pela captura, truncado ao segundo | Relógio fixo da captura: datas relativas a `new Date()` viram valores absolutos estáveis enquanto os arquivos não mudam. Vai no IR e no recibo. |
| `tz` | nome IANA | não | `UTC` | Fuso do processo filho (`TZ`), usado por `Date` e `Intl`. A inferência de formatos compara no mesmo fuso; em runtime o protótipo e o app nativo formatam no fuso do navegador. |
| `home` | booleano | não | `false` | `true` torna a vista padrão a tela padrão do módulo. |
| `seed` | booleano | não | `true` | Depois da publicação, grava as linhas do store nas entidades comuns criadas por esta importação (3.4), pelo Edit Data nativo, só nas que estão vazias. Ignorado sem `publish:true`. |
| `capture` | texto (caminho absoluto) | preenchido pela fachada | — | `capture.json` do pacote da captura (2.9). O modelo nunca escreve. |
| `captureSha256` | texto | preenchido pela fachada | — | Hash do IR. Divergente do arquivo → a fachada recaptura em silêncio (nunca recusa). |

Chaves fechadas: qualquer outra chave é `INPUT_INVALID` com a mais próxima (regra existente do `VerbSurface`).

### 1.3 O mapping mínimo

```json
"mapping": {
  "screens":  {"pedido": "PedidoDetalhe"},
  "default":  "catalogo",
  "routes":   ["#relatorio"],
  "shell":    {"regions": [".demo-strip", ".site-header", ".main-nav", ".site-footer"], "mount": "main"},
  "states":   {"gestao-produtos": {"account-select": "3"}},
  "modals":   {"detalhes-do-produto": "DetalhesProduto"},
  "data":     "FarmaModel.seed()",
  "vendor":   {"https://unpkg.com/react@18.3.1/umd/react.production.min.js": "C:\\...\\vendor\\react.production.min.js"},
  "events":   {"checkout-form:submit": {"action": "ConfirmarPedido"}},
  "ignore":   ["#debug-panel"]
}
```

| Chave | Quando a recusa pede | Efeito |
|---|---|---|
| `screens` | o nome dado colide com elemento não importado e veio de `mapping` | chave = `key` da vista (2.3), valor = nome da tela |
| `default` | nenhuma rota é a inicial (hash vazio cai em fallback) | vista padrão |
| `routes` | uma vista conhecida só por texto (nenhum link, efeito, README ou literal a alcança) | rotas extras na semente da busca (2.3) |
| `shell` | nenhuma região comum, ou mais de um ponto de montagem candidato | seletores das regiões e do ponto de montagem; `{"none":true}` = sem bloco |
| `states` | uma vista só aparece em fallback em todos os estados explorados | estado canônico da vista, por dimensão |
| `modals` | dois modais com o mesmo título normalizado e estruturas diferentes | chave do modal → nome do popup |
| `data` | há coleções no DOM mas nenhum store foi achado (2.7) | expressão JS avaliada na página; a recusa já traz os candidatos |
| `vendor` | script de CDN fora do cache e sem rede, ou de host fora da lista | URL → arquivo local com o mesmo conteúdo |
| `events` | o dono quer ligar um evento a uma action existente em vez da inferida | evento → action existente |
| `ignore` | um elemento de depuração do protótipo não deve virar widget, ou o patch de degradação (1.4.1) | seletores excluídos da captura |

### 1.4 O que a chamada devolve

Entrega aceita: o recibo normal da ferramenta com `report.prototype` (schema `ssam-prototype-receipt/1`; os zeros são
marcadores de posição):

```json
{
  "schema": "ssam-prototype-receipt/1",
  "source": {"root": "C:\\...\\farmavirtual", "entry": "index.html", "kind": "spa-hash", "clock": "2026-10-10T…Z", "tz": "UTC", "captureSha256": "…"},
  "flow": "FarmaVirtual", "theme": "FarmaVirtualTheme",
  "screens": [
    {"name": "Catalogo", "view": "catalogo", "route": "#catalogo", "default": true, "inputs": [],
     "popups": ["DetalhesDoProduto", "EntreNaSuaConta"], "widgets": 0, "elements": 0, "url": "<appLinks>"},
    {"name": "FarmaVirtualCarrinho", "renamedFrom": "Carrinho", "why": "tela Carrinho sem marca já existe no módulo", "…": "…"}
  ],
  "blocks": [{"name": "FarmaVirtualShell", "role": "shell", "instances": 6, "placeholder": "Content",
              "inputs": ["View", "AccountSelect", "CatalogSearch", "UsuarioAtual", "CarrinhoQuantidade", "Aviso", "AvisoErro"],
              "events": ["AccountSelectAlterada", "CatalogSearchAlterada", "FecharAviso"]},
             {"name": "AtualizarPedido", "role": "modal", "instances": 2}],
  "popups": [{"name": "DetalhesDoProduto", "modal": "detalhes-do-produto", "screens": ["Catalogo"], "inputs": ["Id"], "load": "ListIndexOf"}],
  "resources": {"images": [{"name": "FarmaVirtualProducts", "file": "assets/products.png", "bytes": 1476828, "warnings": ["ImageTooBig"]}],
                "icons": {"library": "lucide", "distinct": 33, "instances": 118, "tag": "span"},
                "imports": ["url('https://fonts.googleapis.com/css2?…')"]},
  "data": {"staticEntities": [{"name": "FarmaVirtualCategoria", "records": 3}],
           "entities": [{"name": "FarmaVirtualProduto", "rows": 8, "seeded": 8, "autoNumber": false}],
           "extraAttributes": [], "serverActions": 0, "sql": 0,
           "clientVariables": [{"name": "FarmaVirtualAccountSelect", "type": "Integer", "default": "1"}]},
  "events": {"total": 0, "compiled": 0,
             "byEffect": {"navigate": 0, "openPopup": 0, "closePopup": 0, "setDimension": 0, "toggle": 0, "increment": 0,
                          "remove": 0, "update": 0, "insert": 0, "upsert": 0, "insertFrom": 0, "updateFrom": 0,
                          "removeWhere": 0, "validate": 0, "toast": 0},
             "notCompiled": [], "targetGuarded": [{"event": "modal:click", "handler": "app.js:344", "why": "fecha pelo clique no fundo; IPopup nativo não tem esse evento"}]},
  "fidelity": {"states": 0, "elements": {"prototype": 0, "matched": 0}, "score": 1.0,
               "classes": {"prototype": 0, "matched": 0}, "texts": {"prototype": 0, "matched": 0},
               "attributes": {"prototype": 0, "matched": 0},
               "selectors": {"rules": 0, "selectors": 0, "equal": 0, "gained": 0, "lost": 0},
               "css": {"verbatim": true, "rules": 0, "rewrites": [{"kind": "asset-url", "count": 1}, {"kind": "import-hoist", "count": 1}]},
               "wrappers": [{"widget": "IMobileBlockInstanceWidget", "count": 6, "adapter": "display:contents"}],
               "runtimeUnverified": [], "references": [], "unevaluable": [],
               "perState": [{"state": "v:catalogo@canonical", "score": 1.0, "selectorsDiff": 0}],
               "mismatches": []},
  "verifyWarnings": {"total": 0, "byCode": {"InvalidResourceURL_Offline": 0}},
  "degraded": [],
  "seed": {"entities": 0, "rows": 0, "skippedNotEmpty": []},
  "counts": {"ops": 0, "widgets": 0, "extendedProperties": 0, "screenActions": 0, "serverActions": 0, "ifWidgets": 0, "lists": 0},
  "capture": {"probes": 0, "windows": 0, "pool": 8},
  "timings": {"captureMs": 0, "expandMs": 0, "buildMs": 0, "verifyMs": 0, "fidelityMs": 0, "mergeMs": 0, "publishMs": 0, "seedMs": 0},
  "outOfScope": [{"what": "fechamento do toast após 5500 ms", "where": "app.js:43", "why": "sem timer de cliente nativo sem JS; o toast fecha pelo botão"}],
  "padroes": {"notes": [{"rule": "AR2", "note": "a conta é simulada pelo protótipo (dimensão AccountSelect); as server actions recebem o usuário como parâmetro"}]},
  "modelBytes": 0
}
```

Recusa: **uma** resposta, antes de qualquer captura do Studio quando o problema é do protótipo, com `problems[]` completo,
`patch` pronto (JSON Patch sobre `/ops/<i>/data`) e `correctedJob`. Códigos novos (registrados em `refusal-codes.mjs`):

| Código | Quando | Patch |
|---|---|---|
| `PROTOTYPE_SOURCE_INVALID` | `source` inexistente, sem `.html`, `entry` ambíguo | `replace /ops/i/data/entry` com o candidato |
| `PROTOTYPE_RENDER_FAILED` | erro de script na carga (arquivo:linha:coluna e a mensagem), `document.write`, especificador nu sem import map, script de CDN fora do cache sem rede ou de host fora da lista | `add /ops/i/data/mapping/vendor/<url>` quando a causa é um script externo; senão nenhum |
| `PROTOTYPE_AMBIGUOUS` | vistas, shell, modais ou store ambíguos (2.11) | `add /ops/i/data/mapping/<chave>` com o valor exato |
| `PROTOTYPE_NAME_COLLISION` | só quando um nome **pedido** (`mapping.screens`, `prefix` explícito) colide com elemento sem marca; o nome inferido nunca recusa (1.6) | `replace` do nome pedido pelo candidato livre |
| `PROTOTYPE_IR_INVALID` | IR fora do schema ou pacote com hash divergente (defeito do SSAM; `ssamDefect:true`) | nenhum |

A recaptura por `captureSha256` divergente não é recusa: a fachada recaptura e segue (`warnings: captureRefreshed`).

#### 1.4.1 Erros de build e Verify em ops geradas

São defeitos do SSAM, nunca do modelo. Caminho de degradação determinístico, sem rodada do modelo:

1. Cada problema do build ou do Verify que aponta um widget, propriedade ou action gerado carrega o `k` de origem.
2. Problema de propriedade → a propriedade sai (o widget fica); problema de nó → o nó vira literal (`IAdvancedHtml` com a
   tag substituta e o texto) ou, se ainda falhar, sai com o `k`. A fachada refaz o build **uma vez** sem esses itens.
3. O recibo lista `degraded[]` (`k`, código, mensagem, o que foi feito) e registra a fricção. A fidelidade cai na medida
   exata do que saiu.
4. Se o segundo build ainda falha, a recusa é `VALIDATION_REFUSED` com `ssamDefect:true` e o patch pronto
   `add /ops/i/data/mapping/ignore` com os seletores dos nós restantes.

### 1.5 Onde cada parte roda

```
o11_deliver / studio_deliver / ssam_job
  └─ fachada: expandPrototypeOps(job)                 (lane surface, prototype-op.mjs)
       └─ capturePrototype({source,...})              (lane render, prototype/capture.mjs, pool de processos filhos)
            → <task>\prototype\bundle\capture.json + sheets\<sha>.css + assets\<sha>.<ext>
            → data.capture / data.captureSha256
  └─ kernel: anvil apply --job                        (fase de build existente, headless)
       └─ op "prototype" → PrototypeExpander          (lane compile; lê só o pacote)
            ├─ PrototypeSeams.Element  → elemento→widget (lane html, tabela única)
            ├─ PrototypeSeams.Css      → CSS do tema, classes de ícone, reescritas, adaptadores (lane css)
            ├─ elementos de módulo e lógica pelos verbos existentes (dezenas de ops)
            ├─ widgets pelo construtor direto (PrototypeBuilder, uma passada no Model API)
            └─ depois do Verify: PrototypeSeams.Render → prototype-dom.json (lane css, leitura de volta)
  └─ fachada: prototype/fidelity.mjs                  (lane render: diffs e conjuntos de seletores, jsdom)
  └─ merge nativo, Verify, publish:true               (existentes)
  └─ fachada: prototype-seed.mjs                      (lane surface: Edit Data nativo nas entidades vazias)
```

### 1.6 Reimportação, propriedade e nomes

- A marca `ssam:prototype <prefix>` vai na `Description` (depois do texto descritivo, N1) de flow, tema, telas, blocos,
  screen e server actions, entidades, imagens e Client Variables. **Sem hash na marca:** o `captureSha256` vai só no recibo
  e na descrição do flow. Widgets não têm `Description`: pertencem à tela ou bloco marcado que os contém.
- Reimportar com o mesmo `prefix` **atualiza no lugar, mantendo as keys**: telas e blocos têm o conteúdo limpo e refeito
  (como `ClearScreen`, `HtmlDelta.cs:122`), entidades mantêm a key e têm atributos e registros estáticos atualizados (linhas
  de entidades comuns não são tocadas), actions são atualizadas pelo nome. Elementos marcados da importação anterior que
  sumiram da captura são apagados só se nada fora do prefixo os referencia; senão ficam e são listados.
- Mesma captura sobre o resultado anterior → `NO_CHANGE` (idempotente).
- Homônimo **sem** marca de um nome inferido: o importador usa `<Prefix><Nome>`, depois `<Prefix><Nome>2`…, verificando a
  unicidade pelas regras do Model API para cada tipo, e lista em `renamedFrom`. Nunca recusa por isso.
- Nada fora do prefixo é tocado: o tema do módulo, `MainFlow`, as outras telas e o OutSystems UI ficam como estão.

## 2. Renderização: captura determinística sem navegador

### 2.1 Motor

- **jsdom 30.1.1** (já em `platforms/odc/package.json`) dentro de processos filhos Node (`process.execPath
  --experimental-vm-modules`), ambiente mínimo com `TZ=<tz>` e sem variáveis de proxy, timeout de 20 s por filho.
- Documento: o HTML do `entry`, URL `http://prototype.ssam/<entry>`, `runScripts:"outside-only"`,
  `pretendToBeVisual:true`. Cada `<link rel=stylesheet>` local vira, no mesmo lugar, um `<style data-ssam-href>` com o texto
  do arquivo, para o CSSOM e `element.matches` funcionarem sem carregar recursos.
- `resources: {dispatcher: <dispatcher que rejeita tudo>, interceptors: [requestInterceptor(<arquivos de source>)]}`: o
  interceptador responde só arquivos de dentro de `source`; o que ele não responde cai no dispatcher que rejeita, nunca no
  dispatcher global do undici (a rede). `XMLHttpRequest` síncrono ignora interceptadores (README do jsdom, seção de
  recursos), por isso o `XMLHttpRequest` da janela é substituído (abaixo).
- **Scripts executados pelo SSAM, não pelo jsdom:** cada script clássico é compilado uma vez por captura (`vm.Script`,
  cache por `sha256`) e roda em cada janela por `dom.getInternalVMContext()`, na ordem do documento: clássicos sem
  atributo, depois `defer`, depois `DOMContentLoaded`, depois o grafo de módulos, depois `load`. Módulos ES
  (`type="module"`, que o jsdom não executa) rodam por `vm.SourceTextModule`, ligados por URL relativa dentro de `source`,
  com import maps; especificador nu sem import map → `PROTOTYPE_RENDER_FAILED` com o patch `vendor`. `document.write` →
  `PROTOTYPE_RENDER_FAILED`.
- **Scripts de CDN:** hosts permitidos `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`,
  `cdn.tailwindcss.com`, `code.jquery.com`, `cdn.skypack.dev`. O arquivo vem do cache endereçado por conteúdo
  `%USERPROFILE%\.ssam-hybrid\prototype-vendor\<sha256>`; a fachada baixa para o cache fora do processo filho (GET, sem
  cookies, ≤ 5 MB). Sem rede e sem cache, ou host fora da lista → `PROTOTYPE_RENDER_FAILED` com o patch `mapping.vendor`.
  O IR guarda URL e `sha256`; o determinismo vem do hash. Os testes usam um cache de fixture, nunca a rede.
- **Rede da página:** `fetch` e `XMLHttpRequest` substituídos: GET da mesma origem para arquivo de `source` responde o
  arquivo (com `Content-Type` pela extensão), em síncrono ou assíncrono; qualquer outro host é rejeitado com
  `PrototypeNetworkBlocked` em `warnings`. `WebSocket`, `EventSource` e `navigator.sendBeacon` lançam e vão para `warnings`.
- Relógio fixo: `Date`/`Date.now`/`performance.now` derivam de `clock`. `Math.random` semeado (mulberry32, semente 1);
  `crypto.getRandomValues`/`randomUUID` derivados da mesma semente.
- Timers falsos: atrasos ≤ 1000 ms rodam em ordem na drenagem; `requestAnimationFrame` em passos de 16 ms, até 60 quadros
  por drenagem; atrasos maiores e `setInterval` não rodam e vão para `warnings` com arquivo:linha (ex.: o toast de 5500 ms).
- Polyfills: `HTMLDialogElement.prototype.showModal/show/close` (atributo `open`, evento `close`), `scrollTo`,
  `scrollIntoView`, `matchMedia` (sempre `matches:false`), `IntersectionObserver`/`ResizeObserver` inertes, `localStorage`
  e `sessionStorage` em memória com registro de cada `setItem`, `HTMLElement.prototype.innerText` (leitura = `textContent`
  com `<br>` como `\n`; escrita = `textContent`), `CSS.escape`.
- **Registro de listeners:** `EventTarget.prototype.addEventListener` envolvido antes dos scripts; setters de `on<tipo>`
  em `HTMLElement`, `Document` e `Window` envolvidos; ganchos de framework numa lista fechada: React (`__reactProps$*` com
  `on<Evento>`), Vue 3 (`el._vei`), Preact (`el.l`). Assim se acham alvos de handlers ligados por closure e escondidos pela
  delegação na raiz.
- Determinismo: mesmos arquivos + `clock` + `tz` + `mapping` + `sha256` dos vendors → IR byte a byte igual (JSON canônico,
  chaves ordenadas, listas na ordem do documento). O `sha256` do IR exclui `timings`, `engine.node` e `source.root`.

### 2.2 Tipos de protótipo

Decididos nesta ordem, pelo primeiro critério que vale:

| `kind` | Critério | Vistas |
|---|---|---|
| `multi-page` | ≥ 2 arquivos `.html` na pasta ligados por `<a href="x.html">` a partir do `entry` | cada página alcançável |
| `spa-hash` | listener de `hashchange`, ou âncoras `href="#rota"` cujo destino não é um `id` existente | cada template de rota (2.3) |
| `spa-path` | listener de `popstate` ou `history.pushState` chamado na carga ou num clique, com âncoras de caminho da mesma origem que não são arquivos de `source` | cada template de caminho |
| `spa-sections` | âncoras `href="#id"` ou controles `[data-view]`/`[data-page]`/`[data-screen]`/`[role=tab][aria-controls]` cujos alvos são irmãos de mesmo pai, com só um visível por vez | cada seção-alvo |
| `spa-state` | nenhum dos anteriores, e algum clique troca o **esqueleto** do ponto de montagem sem mudar a URL (2.3) | cada esqueleto alcançado |
| `static` | nenhum dos anteriores | uma vista (a página inteira) |

### 2.3 Descoberta das vistas: ponto fixo sobre estados × rotas

**Esqueleto** de uma renderização do ponto de montagem: a sequência (tag, classes estáveis) dos filhos e netos, com cada
grupo repetido (2.8) reduzido a um item. Esqueletos diferentes = vistas diferentes; mesmo esqueleto com conteúdo diferente
= a mesma vista em outro estado de dimensão. É o que separa navegação de filtro e impede que um SPA de estado vire uma tela
só com dimensões.

**Fontes de rota** (todas, em todo estado explorado):

1. `href` das renderizações (`href^="#"` exceto `#` e `#id` de elemento existente; em `spa-path`, caminhos da mesma
   origem).
2. Navegações observadas como efeito (`location.hash`/`pathname` mudou depois de um gatilho; ex.: o handler de
   `#account-select` faz `location.hash = 'gestao-produtos'`, `app.js:285`).
3. A tabela de rotas de um `README*.md` da raiz (nome `^[A-Z][A-Za-z0-9]*$` e `<entry>#<rota>` na mesma linha).
4. Literais dos scripts que casam com a gramática de rota (`'#x'`, `"x/y"` comparados com `route()`/`location.hash`,
   `'/caminho'` em `pushState`), extraídos do texto dos scripts por tokenização (Acorn, já dependência), não por regex de
   linha.
5. `mapping.routes`.

**Estados:** `S0` (depois da carga) e, para cada dimensão global (2.6) e cada valor dela, o estado `S0` com só essa
dimensão trocada; mais os estados de `mapping.states`. Sem produto cartesiano.

**Ponto fixo:** uma fila de pares (estado, rota). Para cada par: aplicar o estado pelos controles, navegar
(`location.hash = rota` e `hashchange`, ou `pushState` e `popstate`, ou o clique que troca o esqueleto em `spa-state`),
drenar, coletar rotas novas das fontes 1, 2 e 4 e controles de dimensão novos; cada rota ou estado novo entra na fila com
todos os estados ou rotas já conhecidos. Termina quando nada novo aparece. Limites: 64 rotas concretas, 32 estados,
profundidade 4; o excedente vai para `warnings`.

Depois:

1. Template de rota: dividir por `/`; segmento inteiro ou igual a um `data-id` visto vira `{id}`. Mesmo template = mesma
   vista. `pedido/1003` e `pedido/1002` → `pedido/{id}`.
2. **Fallback:** a renderização do ponto de montagem idêntica (espaços normalizados) para ≥ 2 templates no mesmo estado.
3. **Estado canônico** da vista: `S0` se nele a vista não é fallback; senão o primeiro estado (dimensão na ordem do
   documento, valores na ordem das opções) em que não é. `mapping.states` sobrepõe. Nenhum → `PROTOTYPE_AMBIGUOUS`.
4. Concreto canônico de um template com `{id}`: o primeiro valor, na ordem do documento, na vista que o liga no estado
   canônico (para `pedido/{id}`: o primeiro `#pedido/<n>` de `meus-pedidos` → 1003).
5. **Vista padrão:** a do hash/caminho inicial; com hash vazio, a rota cuja renderização é igual à de `""`.
   `mapping.default` sobrepõe.

FarmaVirtual: em `S0` (Marina, cliente) as fontes 1 dão `catalogo`, `carrinho`, `meus-pedidos`, `pedido/1003…1001`; o
README dá as 6 rotas; os literais de `app.js` dão `gestao-produtos`. No estado `account-select = 3` o shell renderiza
`nav-management` (`app.js:62`) com `gestao-produtos` e `gestao-pedidos`, e a gestão de pedidos liga `pedido/1004` e
`pedido/1000`. Ponto fixo: 6 templates. Sem as fontes 2–4 e sem re-coletar em cada estado, a captura acharia 4 vistas.

**Nomes das telas** (precedência): `mapping.screens` → tabela do README com a rota reduzida ao template
(`index.html#pedido/1003` → `pedido/{id}` → `PedidoDetalhe`) → PascalCase ASCII da rota sem parâmetros (`meus-pedidos` →
`MeusPedidos`; `pedido/{id}` → `Pedido`); em `spa-state`, o slug do primeiro `h1`/`h2` do esqueleto, senão o texto do
gatilho. Acentos removidos (NFD sem marcas). `{id}` vira input `Id` (Integer quando todos os valores são inteiros).

FarmaVirtual: `Catalogo`, `Carrinho`, `MeusPedidos`, `PedidoDetalhe` (input `Id`), `GestaoProdutos`, `GestaoPedidos`.

**multi-page:** `key` = nome do arquivo sem extensão; links entre páginas viram navegação. **spa-sections:** `key` = `id`
do alvo ou valor de `data-view`. **static:** `key` = nome do arquivo.

### 2.4 Descoberta dos modais

- **Contêiner de modal:** `<dialog>`, `[role=dialog]`, `[aria-modal=true]`, ou elemento cuja visibilidade alterna
  (`open`/`hidden`/`display`) e cujo conteúdo muda quando um gatilho é clicado.
- **Gatilhos:** em cada vista e estado explorado, todo elemento clicável que não navega (`button`, `a` sem rota,
  `[data-action]`, `[onclick]`, `[role=button]`, `[tabindex]`, alvo com listener próprio ou com handler de framework),
  deduplicado pela chave do gatilho (tag + atributos que não variam entre irmãos; `data-id`/`data-delta` são parâmetros;
  sem atributo de parâmetro, o parâmetro é a chave do registro correlacionado do item da lista que o contém, 2.8).
- **Tipo do modal:** slug do título (`#modal-title`, alvo de `aria-labelledby`, ou o primeiro `h1`–`h3`), sem dígitos e sem
  `#`. "Atualizar pedido #1004" → `atualizar-pedido`. Nome do popup: PascalCase ASCII do título sem dígitos. Dois tipos com
  o mesmo slug e estruturas diferentes → `PROTOTYPE_AMBIGUOUS` com o patch `modals`.
- **Classe do contêiner:** a classe extra posta no contêiner ao abrir (ex.: `product-modal`) é guardada por tipo.
- **Parâmetros:** atributo do gatilho que varia entre aberturas e muda o conteúdo (`data-id` → input `Id`).
- **Modal aberto de dentro de modal** (ex.: `add-modal` como visitante abre o login): o popup filho fica na mesma tela.
- **Telas do popup:** todas as vistas em que algum gatilho abriu aquele tipo, em qualquer estado.
- **Listener com guarda de alvo:** um listener registrado no próprio contêiner (não em `document`/`window`) cujo efeito só
  acontece quando o alvo é o contêiner (sonda: clique no contêiner e no primeiro filho-elemento; efeito só no primeiro) não
  vira evento de elemento, porque um handler nativo não testa o alvo e fecharia o popup em qualquer clique interno. Vai para
  `events.targetGuarded`; no contêiner de modal é o fechamento pelo fundo (`app.js:344`) → `outOfScope`.

FarmaVirtual: 5 tipos.

| Tipo | Popup | Telas | Gatilho | Inputs |
|---|---|---|---|---|
| `detalhes-do-produto` | `DetalhesDoProduto` | Catalogo | `[data-action=product-detail]` | `Id` |
| `entre-na-sua-conta` | `EntreNaSuaConta` | Catalogo | `[data-action=add]` com conta Visitante; `[data-action=add-modal]` idem | — |
| `editar-produto` | `EditarProduto` | GestaoProdutos | `[data-action=edit-product]` | `Id` |
| `novo-produto` | `NovoProduto` | GestaoProdutos | `[data-action=new-product]` | — |
| `atualizar-pedido` | `AtualizarPedido` | GestaoPedidos, PedidoDetalhe | `[data-action=order-status]` | `Id` |

### 2.5 Shell compartilhado

1. **SPA:** considerar o contêiner raiz da app (o elemento cujo conteúdo é reescrito a cada rota; FarmaVirtual `#app`),
   seus filhos e os irmãos dele no `body` que não são contêiner de modal (FarmaVirtual: `#notifications`). O próprio
   contêiner raiz é emitido como raiz do bloco (FarmaVirtual: `div#app` → `IContainer` `app` com a classe `ssam-id-app`),
   para as regras do protótipo sobre ele valerem.
2. **multi-page:** alinhar os filhos do `body` de todas as páginas (LCS com chave, 2.8); o prefixo e o sufixo comuns são as
   regiões, o trecho que difere é o ponto de montagem.
3. Um filho é **região do shell** quando tag, classes e estrutura são iguais em todas as renderizações canônicas, admitidas
   só variações explicadas por predicados de dimensão ou de vista (2.8). O **ponto de montagem** é o único filho cujo
   conteúdo difere entre vistas; se o elemento é igual e só os filhos mudam, ele pertence ao shell e o placeholder fica
   dentro dele.
4. Zero regiões → sem bloco. Mais de um ponto de montagem candidato → `PROTOTYPE_AMBIGUOUS` com o patch `shell`.
5. **Valores dinâmicos do shell entram como inputs do bloco**, passados por cada tela (um bloco Reactive re-renderiza
   quando seus inputs mudam; uma Client Variable gravada pela tela não garante isso): `View` (Text, variações por vista como
   `nav-link active`), cada dimensão global que o shell lê, cada registro ou valor de dados que o shell mostra (a tela os
   lê pelos seus aggregates), e `Aviso`/`AvisoErro` do toast. Gatilhos do shell que mudam dimensão global ou dependem da
   tela viram **eventos do bloco** tratados pela tela (U5); navegação dentro do bloco vai direto para a tela.
6. A árvore do shell no IR é a da vista padrão no seu estado canônico; as variações ficam anotadas com predicados (2.8).

FarmaVirtual: regiões `.demo-strip`, `header.site-header`, `nav.main-nav`, `main` (placeholder `Content`), `footer`,
`#notifications`; inputs `View`, `AccountSelect`, `CatalogSearch`, `UsuarioAtual` (registro de Users), `CarrinhoQuantidade`,
`Aviso`, `AvisoErro`; eventos `AccountSelectAlterada`, `CatalogSearchAlterada`, `FecharAviso`.

### 2.6 Dimensões, efeitos, perturbação e sondas

**Dimensão** é um estado de UI que muda o DOM sem mudar o store e sem trocar o esqueleto. Fontes, em ordem:

- `select`/`input[type=checkbox|radio]` com listener de `change`/`input` cujo disparo muda o DOM (FarmaVirtual:
  `#account-select`, `#catalog-sort`, `#available-filter`, `#management-category`, `#management-active`);
- campo de texto com listener de `input` (`#catalog-search`, `#management-search`);
- grupo de gatilhos com a mesma chave e parâmetros diferentes cujo efeito é só re-renderizar (`category`,
  `customer-status-filter`, `admin-status-filter`);
- gatilho sem parâmetro que alterna o DOM entre duas formas (`toggle-filters`).

Escopo: **global** quando muda o shell ou sobrevive à navegação (Client Variable de tipo básico, E2); **tela** nos demais
(local). Tipo: Integer (todos inteiros), Boolean (checkbox, toggle), Text. Valor inicial: o de `S0`.

**Efeito** é o que um evento faz, observado pela diferença antes/depois (DOM, URL, contêiner de modal, notificações e
store). Classe fechada; cada efeito tem uma compilação única (3.4):

| Efeito | Observado como | Parâmetros |
|---|---|---|
| `navigate` | URL mudou | rota-alvo; `{id}` ← parâmetro do gatilho, do `href` ou chave de registro inserido no mesmo evento |
| `openPopup` | contêiner de modal abriu com um tipo | tipo; inputs ← parâmetros |
| `closePopup` | contêiner fechou | — |
| `setDimension` | DOM igual ao da dimensão D no valor v | D; v literal, ← parâmetro, ← chave inserida; `data-delta` com `input[min/max]` vizinho: `Max(min, Min(max, D + delta))` |
| `toggle` | campo booleano de um registro inverteu | coleção, chave ← parâmetro, campo |
| `increment` | campo numérico de um registro mudou por d | coleção, chave, campo, d ← `data-delta`/constante/valor do controle; limites ← `min`/`max` |
| `remove` | um registro saiu | coleção, chave |
| `update` | campos de um registro mudaram para valores de controles | coleção, chave, campos ← controles (pelo `name`) |
| `insert` | entrou um registro | coleção; campos ← controles, constantes, relógio, dimensão, `count`/`sum(f)`/`sum(f*g)` de uma coleção filtrada (uma junção por chave estrangeira); chave = máximo + 1 |
| `upsert` | para alguns parâmetros `increment`, para outros `insert`, com os mesmos campos-chave | coleção, campos-chave, campo somado |
| `insertFrom` | N registros entraram em T, um por linha de S que satisfaz um predicado da gramática | T, S, predicado; campos ← S, S→R (uma junção), constantes, relógio, chave do registro inserido no mesmo evento, `f*g` |
| `updateFrom` | campo numérico de T mudou por ±Σ S.g nas linhas ligadas por chave estrangeira às linhas de S do predicado | T, S, predicado, campo, sinal |
| `removeWhere` | saíram de T exatamente as linhas de um predicado | T, predicado |
| `validate` | a submissão com o valor inválido de um controle não muda o store e escreve uma mensagem num `[role=alert]` do formulário ou num toast de erro | controle, predicado da tabela de restrições, mensagem exata, alvo |
| `toast` | elemento novo no contêiner de notificações | texto, variante (classe) |

Regras de composição:

- Um evento pode ter vários efeitos em sequência (ex.: `add-modal`: `upsert` + `closePopup` + `toast`).
- Efeito que depende de estado é observado em cada valor da dimensão e compilado com um `If` sobre o predicado que separa os
  valores (ex.: `add` com Visitante → `openPopup(EntreNaSuaConta)`; com cliente → `upsert` + `toast`).
- Efeito que depende de um campo do registro do parâmetro, ou do valor de um controle, é separado por predicado sobre esse
  campo ou controle (ex.: `status-form` com novo status `= 4` → também `updateFrom` do estoque).
- A explicação de uma diferença de store procura, em ordem fixa, a combinação de efeitos da tabela que explica **todas** as
  linhas mudadas. O que sobra (resíduo) vai para `events.notCompiled` com a lista exata, o arquivo:linha do handler e a
  action com as partes explicadas (nunca vazia quando algo foi explicado). `mapping.events` liga o evento a uma action
  existente em vez disso.

**Perturbação de controles** (o envio de um formulário sem mudar nada não mostra `insert`/`update`):

1. Sentinela válida por controle, derivada de `type`, `required`, `minlength`/`maxlength`, `min`/`max`/`step`, `pattern` e
   do valor atual: texto → `"SSAM <name>"` completado com `x` até `minlength` e cortado em `maxlength`; e-mail →
   `ssam@example.test`; número → o atual + `step` dentro de `max`, senão o atual − `step`, senão `min`; data → a de `clock`;
   `select` → a próxima opção com valor não vazio; checkbox → invertido. Em formulário pré-preenchido a sentinela sempre
   difere do valor atual.
2. Envio com todas as sentinelas válidas → diferença do store → cada campo mudado é ligado ao controle de mesmo `name` (ou
   ao campo derivado que a tabela explica).
3. Um controle por vez com o valor inválido (vazio quando `required`; `minlength − 1`; `maxlength + 1` atribuído por
   `value`; `min − step`; `max + step`), os demais válidos → `validate` (com a mensagem e o alvo) ou aceitação (sem
   validação para aquela restrição).
4. Dimensão de texto (busca): sondas determinísticas por campo de texto candidato da coleção da lista dependente — a
   primeira palavra, em minúsculas, da primeira linha que só aparece naquele campo — mais `zzzz-ssam` (nenhum resultado);
   os campos que reagem formam a união do `contains`.

**Isolamento das sondas e orçamento:**

- Sonda = (prefixo de estado, ação). O prefixo (rota + atribuições de dimensão) é refeito pelos controles.
- Cada filho mantém uma janela. Depois de uma sonda cujos efeitos estão em {`navigate`, `openPopup`, `closePopup`,
  `setDimension`, `toast`} e cuja volta ao início (refazer o prefixo) dá o mesmo DOM serializado e o mesmo
  `localStorage` do instantâneo, a janela é reaproveitada. Qualquer escrita no store, envio de formulário ou diferença →
  janela descartada e criada outra (30 ms mediana, 46 ms p90 medidos com scripts compilados).
- Variantes por chave de gatilho: o primeiro item, mais o primeiro item de cada assinatura distinta dos campos de baixa
  cardinalidade do registro do parâmetro (booleanos, chaves estrangeiras, ≤ 8 valores distintos), até 8.
- Estados por gatilho: o canônico da vista mais cada valor de dimensão global em que a vista não é fallback e a chave existe.
- Pool: P = min(8, ⌊CPUs/4⌋) filhos; sondas ordenadas pela chave e distribuídas por hash; resultados juntados na ordem da
  chave (o IR não depende do escalonamento). Limites: 1.500 sondas; excedente → `warnings`.
- Orçamento FarmaVirtual (~300 sondas estimadas): janelas frias em paralelo ~0,3 s + carga e ponto fixo ~1 s + 300 × ≤ 70 ms
  / 8 ≈ 2,6 s + inferência ~0,5 s → **≤ 5 s com P = 8** (≤ 25 s com P = 1). O recibo traz `capture.probes`, `windows`,
  `pool`.

### 2.7 Dados mock (store)

Fonte do store, em ordem:

1. `mapping.data`: expressão JS avaliada na página depois da carga.
2. Função global sem argumentos chamada `seed`, `initialData`, `initialState`, `getInitialState`, `mock` ou `mockData`,
   nas propriedades de `window` criadas pelos scripts e um nível abaixo (FarmaVirtual: `FarmaModel.seed()`), cujo resultado
   é um objeto de arrays de objetos planos.
3. Arquivo JSON local lido por `fetch`/`XMLHttpRequest` (servido pelo polyfill, 2.1) com objeto de arrays (ou array → uma
   coleção com o nome do arquivo); fonte `file:<caminho>`.
4. O primeiro `localStorage.setItem` com JSON nesse formato.

Mutações são observadas pelos `setItem` seguintes e pela comparação do resultado da fonte antes/depois. Sem store e com
coleções no DOM → `PROTOTYPE_AMBIGUOUS` com o patch `data` cujo valor é o primeiro candidato e `alternatives` com os demais
(propriedades de `window` que devolvem arrays de objetos planos ou funções de aridade zero que devolvem objeto de arrays),
para o modelo nunca precisar ler `app.js`.

Coleção: nome = chave do objeto; campos = união das chaves na ordem da 1ª linha; tipo por campo: Integer, Decimal,
Boolean, DateTime (texto ISO-8601), Text (comprimento = o próximo de 50/120/250/2000 acima do maior valor). Chave: `Id` se
existir e for único; senão a 1ª coluna inteira única; senão a posição. Chave estrangeira: campo `<Coleção>Id` cuja coleção
existe e cujos valores existem lá. Coleção **mutada** = algum efeito compilado escreve nela.

Arrays de objetos planos fora do store que alimentam o DOM (ex.: `model.Users`) entram como coleções quando algum slot é
correlacionado com eles (2.8).

### 2.8 Inferência: alinhamento, listas, campos, formatos, condicionais

Tudo sobre as renderizações canônicas e as exploradas, com tabelas fechadas. O que nenhuma regra explica fica **literal da
renderização canônica** e é listado no recibo; nunca é perdido.

**Alinhamento de árvores** (variantes por dimensão e estado, shell, multi-page, fidelidade): LCS por pai sobre as
sequências de filhos, com chave = (tag, `id`, classes estáveis, atributos-chave `data-*`); empate pela ordem do documento.
Subárvores que só existem em parte dos estados (ex.: o botão de status só para admin em `PedidoDetalhe`) alinham pela chave,
não pela posição.

**Grupo repetido.** Irmãos de mesmo pai com a mesma assinatura (tag + classes que não variam + estrutura até a profundidade
3, sem textos), em sequência, ≥ 2. Modo `self` quando o grupo são todos os filhos-elemento do pai; `wrap` nos demais.

**Correlação com coleção.** Para cada slot que varia entre os itens (texto, valor de atributo, classe opcional, presença de
nó), procurar o campo `f` de uma coleção `C` e a transformação `T` da tabela tais que `slot(item_i) = prefixo +
T(C[r_i].f) + sufixo`. A ordem `r_i` vem da chave quando algum slot a tem (`data-id`, `href`), senão da primeira atribuição
consistente. Grupo correlacionado = **lista de `C`**.

**Slot sem explicação dentro de lista correlacionada** (continua correlacionada): vira um atributo extra `<Slot>` (Text) na
entidade de `C`, com o valor da renderização canônica por chave de `C`; listado em `data.extraAttributes`; em coleção
mutada, linhas novas recebem `""` (listado).

**Filtro e ordem.** As linhas de `C` ausentes são explicadas pelo primeiro predicado da gramática que separa exatamente as
presentes; a ordem pelo primeiro critério: ordem da semente, um campo asc/desc, booleano desc + ordem da semente, dois
campos. Por dimensão, o mesmo em cada valor: `D = 0 or Current.f = D`, `Current.f = D`, `contains` (união de campos).

**Grupo sem coleção correlacionada.** Lista sobre uma **entidade estática de snapshot** `<Prefix><Tela><Lista>` com uma linha
por item renderizado e um atributo por slot que varia.

**Opções de `select`.** Todas correlacionadas com uma coleção → aggregate dela. Opções que variam com um campo do registro
do parâmetro (ex.: `#new-order-status` depende do status atual) → entidade estática `<Prefix><Controle>Opcao` (Chave, Value,
Label, Ordem) com uma linha por (valor do campo, opção) observada nas variantes, e o aggregate do dropdown filtrado pelo
campo. Constante ∪ coleção (ex.: "Visitante" + Users) → entidade estática de opções snapshot (exata quando a coleção não é
mutada).

**Gramática de predicados (fechada, nesta ordem):** `f`, `not f`, `f = c`, `f <> c`, `f > 0`, `f = 0`, `f <= k`, `f >= k`
(k = fronteira observada), `D = c`, `D <> c`, `D = c1 or D = c2`, `D = <param>`, `D = 0 or Current.f = D`,
`Length(ctl) >= k`, `Length(ctl) <= k`, `ctl >= k`, `ctl <= k`, `ctl <> ""`, `and`/`or` de dois termos. Empate: menos termos;
depois a ordem acima.

**Transformações de formato (fechadas; cada uma tem uma expressão OutSystems única):**

| `fmt` | Exemplo do protótipo | Expressão (O11 e ODC) |
|---|---|---|
| `text` | `Hidratante facial 50 g` | `v` |
| `integer` | `24` | `IntegerToText(v)` |
| `decimal:<n>:<locale>` | `49,90` | `FormatDecimal(v, n, "<sep. milhar>", "<sep. decimal>")` |
| `currency:<locale>:<code>` | `R$ 49,90` | `"R$" + "<separador exato do Intl, aqui U+00A0>" + FormatDecimal(v, 2, ".", ",")` |
| `date:<locale>:<opções Intl>` | `10 de out. de 2026` | pt-BR `{day:'2-digit',month:'short',year:'numeric'}` → `FormatDateTime(v, "dd") + " de " + Substr("jan.fev.mar.abr.mai.jun.jul.ago.set.out.nov.dez.", (Month(v) - 1) * 4, 4) + " de " + IntegerToText(Year(v))` |
| `time:<locale>` | `21:36` | `FormatDateTime(v, "HH:mm")` |
| `pad:<n>:<c>` | `#001` | `FormatText(IntegerToText(v), n, n, True, "<c>")` |
| `substr-after:<sep>` | `tile-3` de `assets/products.png#tile=3` | `Substr(v, Index(v, "<sep>") + <len(sep)>, Length(v))` |
| `substr-before:<sep>` | `maria` de `maria@x.com` | `Substr(v, 0, Index(v, "<sep>"))` |
| `plural` | `1 pedido` / `5 pedidos` | caso por predicado `v = 1` |
| `cases` | `Disponível em estoque` / `Últimas 8 unidades` / `Indisponível no momento` | `If(p1, e1, If(p2, e2, e3))` |
| `count` / `sum` | `3 itens`, `R$ 99,70` | `<Lista>.Length`, soma de campo da lista (só lista da mesma tela) |

`substr-*` vale quando o separador aparece em todas as linhas correlacionadas. FarmaVirtual: `tile-N` em `.product-photo`
(`app.js:29`) = `substr-after:#tile=` de `ImagemUrl`. Uma transformação nova entra só como linha desta tabela, com teste.

**Variantes por item.** Nó presente em parte dos itens → `if`. Classe presente em parte → `"base" + If(p, " token", "")`.
Atributo com dois valores → expressão. Os mesmos predicados explicam variantes por dimensão.

### 2.9 Ícones, imagens, fontes, CSS e o pacote

- **Lucide e afins.** Depois de `lucide.createIcons()` (o script do protótipo roda), cada `<svg class="lucide lucide-<nome>
  …">` é anotado `icon:{name, strokeWidth}`. `strokeWidth` efetivo = a declaração `stroke-width` vencedora entre as regras do
  protótipo que casam com o elemento (`element.matches`, especificidade e ordem; fora de `@media`), senão o atributo. O IR
  guarda o SVG de cada nome uma vez (`icons.set`) e `icons.defaultStrokeWidth` (FarmaVirtual 1,7). Um ícone conta 1
  elemento, nunca os `path`. Tag do substituto nativo: `span` (inline como o `svg`; aceita nas duas plataformas); nunca `i`
  (seletores do autor sobre `i` não casam o `svg` no navegador).
- **Imagens.** `img[src]`, `url(...)` no CSS e em `style`, `srcset`: arquivo de `source` → asset com `sha256`, `mime`,
  `bytes`, usos. URL externa fica como está.
- **Sprites.** Nada especial: o arquivo é um asset; `.tile-N` e `background-*` ficam no CSS verbatim.
- **Fontes.** `@import` e `@font-face` com URL externa ficam verbatim (4.1 item 2); `@font-face` com arquivo local vira
  asset.
- **Inventário de CSS.** Cada folha (`<link rel=stylesheet>` e `<style>`, na ordem do documento) com `sha256`, contagem de
  regras pelo parser do jsdom, `imports`, `urls`. Mais as `<style>` criadas por script (ex.: Tailwind do CDN), unidas em
  todos os estados explorados na ordem de primeira aparição, com origem `runtime`. Folha usada só por uma página
  (`multi-page`) é marcada `page:<key>` e vai para o `StyleSheet` daquela tela (3.1), não para o tema.
- **Pacote** (`<task>\prototype\bundle\`): `capture.json`, `sheets\<sha>.css`, `assets\<sha>.<ext>`. O kernel lê só o
  pacote (caminhos relativos ao `capture.json`), nunca `source`; no modo servidor ou agente fino, o pacote viaja com o job.

### 2.10 O IR `ssam-prototype-capture/1`

```json
{
  "schema": "ssam-prototype-capture/1",
  "clock": "2026-10-10T21:00:00Z", "tz": "UTC",
  "engine": {"name": "jsdom", "version": "30.1.1", "node": "<fora do hash>"},
  "source": {"root": "<fora do hash>", "entry": "index.html",
             "files": [{"path": "app.js", "bytes": 39327, "sha256": "…"}], "vendor": []},
  "kind": "spa-hash",
  "app": {"prefix": "FarmaVirtual", "title": "FarmaVirtual | Higiene, beleza e bem-estar", "lang": "pt-BR"},
  "document": {"html": [["lang", "pt-BR"]], "body": [], "meta": [{"name": "theme-color", "content": "#18765c"}]},
  "css": {"sheets": [{"path": "styles.css", "bundle": "sheets/<sha>.css", "order": 0, "origin": "file", "page": null,
                      "bytes": 28625, "sha256": "…", "rules": 0,
                      "imports": ["url('https://fonts.googleapis.com/css2?family=DM+Sans…&display=swap')"],
                      "urls": [{"raw": "assets/products.png", "asset": "assets/products.png"}]}]},
  "assets": [{"path": "assets/products.png", "bundle": "assets/<sha>.png", "mime": "image/png", "bytes": 1476828,
              "sha256": "…", "name": "Products", "uses": ["css"]}],
  "icons": {"library": "lucide", "defaultStrokeWidth": 1.7, "tag": "span",
            "set": {"plus": {"viewBox": "0 0 24 24", "svg": "<svg …><path d=\"M5 12h14\"/>…</svg>"}}},
  "dimensions": [{"key": "account-select", "name": "AccountSelect", "control": "select#account-select",
                  "event": "change", "type": "Integer", "values": ["0", "1", "2", "3"], "initial": "1", "scope": "global"}],
  "store": {"source": "global:FarmaModel.seed()",
            "collections": [{"name": "Produto", "key": "Id", "mutated": true,
                             "fields": [{"name": "Id", "type": "Integer"}, {"name": "Nome", "type": "Text", "length": 120}],
                             "references": [{"field": "CategoriaId", "collection": "Categoria"}],
                             "rows": [{"Id": 1, "Nome": "Hidratante facial 50 g"}]}]},
  "shell": {"root": "<Node>", "regions": [0, 1, 2, 3, 4], "mount": {"region": 3, "path": [3]},
            "inputs": [{"name": "View", "type": "Text"}], "events": []},
  "views": [{"key": "catalogo", "route": "#catalogo", "template": "catalogo", "params": [], "name": "Catalogo",
             "nameSource": "readme", "default": true, "state": {"account-select": "1"},
             "root": "<Node>", "elements": 0}],
  "modals": [{"key": "detalhes-do-produto", "name": "DetalhesDoProduto",
              "container": {"tag": "dialog", "attrs": [["id", "modal"], ["aria-labelledby", "modal-title"]], "class": "product-modal"},
              "openedFrom": [{"view": "catalogo", "event": "catalogo:click:product-detail"}],
              "params": [{"name": "Id", "from": "data-id", "type": "Integer"}],
              "root": "<Node>", "elements": 0}],
  "events": [{"key": "catalogo:click:category", "view": "catalogo", "selector": "[data-action=\"category\"]",
              "on": "click", "params": [{"name": "Id", "from": "data-id", "type": "Integer"}],
              "effects": [{"kind": "setDimension", "dimension": "category", "value": {"param": "Id"}}],
              "when": null, "handler": "app.js:239", "compiled": true}],
  "explored": [{"id": "v:catalogo@account-select=0", "view": "catalogo", "assign": {"account-select": "0"}, "tree": "<sha do Node>"}],
  "trees": {"<sha>": "<Node>"},
  "problems": [], "warnings": [],
  "stats": {"elements": 922, "views": 6, "modals": 5, "icons": 33, "iconInstances": 118, "events": 0, "probes": 0},
  "timings": {"loadMs": 0, "crawlMs": 0, "probeMs": 0, "inferMs": 0, "totalMs": 0}
}
```

`explored` = cada estado comparado pela fidelidade: o canônico de cada vista, cada valor de cada dimensão (uma por vez) em
cada vista onde não é fallback, e cada tipo de modal aberto pelo primeiro gatilho no estado canônico. As árvores ficam uma
vez em `trees` (deduplicadas por `sha256`).

**Node** (árvore de cada vista, modal e região do shell):

```json
{"k": "v:catalogo/2/0/1", "t": "div", "a": [["class", "product-grid"], ["data-x", "1"]], "c": ["<Node>"]}
{"k": "v:catalogo/2/0/1/0/3/0", "x": "Hidratante facial 50 g"}
```

- `k`: caminho estável (`v:<view>`, `m:<modal>`, `s:<região>`, depois os índices de filhos). Origem de cada widget e de cada
  problema.
- `t`: tag em minúsculas. `a`: atributos na ordem do documento, valores exatos. `c`: filhos.
- `x`: texto exatamente como no DOM (quem compacta é o compilador, pela regra do HTML).

Anotações (só a lane render escreve; as outras só leem):

| Anotação | Em | Forma |
|---|---|---|
| `icon` | `svg` de ícone | `{"name":"plus","strokeWidth":3,"from":[["class","icon"],["aria-hidden","true"]]}` |
| `list` | pai do grupo | `{"collection":"Produto","mode":"self","filter":<Pred>,"sort":[{"field":"Destaque","dir":"desc"}],"sortBy":{"dimension":"catalog-sort","cases":[{"value":"price-asc","field":"Preco","dir":"asc"}]},"template":<Node>,"items":7,"snapshot":null}` |
| `if` | nó opcional | `<Pred>`; `else` com o `<Node>` alternativo |
| `classExpr` | elemento | `{"base":"stock-label","tokens":[{"token":"out","when":<Pred>}]}` |
| `attrExpr` | elemento | `{"aria-pressed":{"when":<Pred>,"then":"true","else":"false"}}` |
| `expr` | texto ou atributo | `<Expr>` |
| `events` | elemento | `["catalogo:click:category"]` |
| `control` | input/select/textarea | `{"kind":"select","var":"CatalogSort","dimension":"catalog-sort","initial":"featured","options":{"entity":"CatalogSortOpcao"}}` |
| `nav` | âncora/gatilho | `{"view":"pedido","params":{"Id":{"field":"Id"}}}` |
| `viewExpr` | nó do shell | `{"View":"catalogo"}` |

`Pred`: `{"op":"truthy|not|eq|ne|gt|ge|lt|le|in|contains|len-ge|len-le|and|or","l":<Val>,"r":<Val>,"a":[<Pred>]}`.
`Val`: `{"lit":<json>}`, `{"field":"Estoque"}`, `{"dim":"category"}`, `{"param":"Id"}`, `{"control":"NomeDestinatario"}`,
`{"view":true}`. `Expr`: `{"fmt":"<tabela 2.8>","value":<Val>,"prefix":"","suffix":"","locale":"pt-BR","cases":[…],"else":<Expr>}`.

### 2.11 Ambiguidade: recusa única com o mapping pronto

A captura coleta **todos** os problemas e só depois decide. Exemplos:

```json
{"code": "PROTOTYPE_AMBIGUOUS", "path": "/ops/0/data/mapping/states",
 "message": "a vista relatorio só renderiza o fallback 'Acesso não disponível' em todos os estados explorados",
 "patch": [{"op": "add", "path": "/ops/0/data/mapping/states", "value": {"relatorio": {"perfil": "admin"}}}]}
```

```json
{"code": "PROTOTYPE_AMBIGUOUS", "path": "/ops/0/data/mapping/data",
 "message": "a lista .order-row correlaciona com dados, mas nenhum store foi achado",
 "patch": [{"op": "add", "path": "/ops/0/data/mapping/data", "value": "App.db.load()"}],
 "alternatives": ["window.DATA", "Store.initial()"]}
```

Todos os patches de uma recusa juntos formam uma chamada válida; a fachada devolve também `correctedJob`.

## 3. Mapeamento para OutSystems nativo

### 3.1 Estrutura

| Do protótipo | Elemento nativo | Regra |
|---|---|---|
| (a importação) | UI Flow `<Prefix>` | Novo flow; telas e blocos do importador ficam nele. `MainFlow` não é tocado. |
| CSS do protótipo | Tema `<Prefix>Theme`, `BaseTheme = null` | `IMobileFlow.Theme = <Prefix>Theme`. O OutSystems UI não carrega nessas telas; o tema do módulo e as outras telas não mudam. Folha `page:<key>` → `IMobileScreen.StyleSheet` daquela tela. |
| cada vista | Tela `IMobileScreen` no flow | **Uma tela por vista, nunca tudo numa tela.** Sem layout. Acesso anônimo (O11: role Anonymous; ODC: `AnonymousAccess = true`). Template com `{id}` → input `Id`. |
| shell | Bloco `<Prefix>Shell` | Raiz = o contêiner da app; regiões na ordem; `IPlaceholderWidget` `Content` no ponto de montagem; inputs e eventos de 2.5. Cada tela tem uma instância como primeiro widget e o conteúdo da vista no placeholder. |
| cada modal | `IPopup` `<Nome>Popup` em cada tela do modal | `ShowPopup = <Nome>IsOpen` (local Boolean). Conteúdo: o contêiner do modal como `div.ssam-tag-dialog` (3.2) com os filhos. Inputs do modal → locais `<Nome><Input>`. |
| modal em ≥ 2 telas | Bloco `<Nome>` dentro do `IPopup` de cada tela | Inputs do bloco = inputs do modal; eventos `Fechar` e um por efeito sobre dados da tela (U5). |
| toasts | Região do bloco shell + `If` sobre o input `Aviso` | O toast capturado é o template; texto e variante vêm dos inputs. |
| navegação pura | `OnClick` do `ILink`/`IButton` = a tela de destino, com os argumentos | Renderiza `href` real; sem screen action. Com outros efeitos: screen action com nó Destination no fim. |

### 3.2 Elemento → widget (uma tabela, compartilhada)

A tabela é **uma só**: `ElementWidgetMap` (lane html, 7.5), usada pelo op html (formas página e fragmento) e pelo
importador (por `PrototypeSeams.Element`, 7.3). O caminho manual e o importador não divergem.

**Tags aceitas pelo `IAdvancedHtml`** (extraídas do validador instalado, 0.1; a lane html congela as listas em código e um
teste as reextrai das DLLs instaladas e falha na diferença):

- O11 (103): `a abbr address area article aside audio b bdi bdo blockquote button canvas caption cite code col colgroup
  command data datalist dd del details dfn div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6
  header hgroup hr i iframe img input ins kbd keygen label legend li link main map mark menu meter nav noscript object ol
  optgroup option output p param picture pre progress q rp rt ruby s samp section select small source span strong style sub
  summary sup table tbody td textarea tfoot th thead time tr track u ul var video wbr`.
- ODC (100): a mesma lista **sem** `data`, `main`, `picture`.

**Substituição de tag** (tag fora da lista da plataforma): substituto da tabela fixa abaixo, com a classe
`ssam-tag-<tag>` no widget e a reescrita de CSS `T` → `:is(T, :where(.ssam-tag-T))` (4.1 item 4). A igualdade
tag-original ↔ substituto + classe é uma equivalência documentada da fidelidade (4.4).

| Tag original | Substituto | Observação |
|---|---|---|
| `dialog` | `div` | conteúdo do `IPopup`; atributo `open` mantido como extended property (`[open]` casa); regras de UA de `dialog:modal` em 4.1 |
| `br` | `div` vazio | regra existente do Verify (`HtmlExpander.cs:38`) |
| `main` (ODC), `search`, `menuitem`, elementos customizados | `div` | `main` ganha `role="main"` (papel implícito preservado; equivalência documentada) |
| `data`, `picture` (ODC) | `span` | `value` mantido como extended property |
| `svg` não-ícone | `IImage` com a imagem SVG criada do próprio markup | classe `ssam-tag-svg` |
| `template`, `slot`, `script`, `style` dentro do conteúdo | nunca viram widget | `template` não é renderizado pelo navegador |

| Elemento | Widget | Propriedades |
|---|---|---|
| `div` sem evento | `IContainer` | `Style` = `class` exata; propriedades de layout pelos valores que a tabela de runtime (4.2) mapeia para "sem classe"; atributos → extended properties |
| elemento com evento de clique que não é `a`/`button` (ex.: `div.product-image-wrap[role=button]`) | `IAdvancedHtml`, `Tag` = a tag | evento `onclick` do HTML Element (`CreateEvent`/`ExtendedEvent` existem em `NRWidgets.dll` mas não no vocabulário do SSAM — `ScreenVocabulary.json` `mobile:IAdvancedHtml` tem `events:{}`; a lane compile prova no Verify, 7.2 teste 10). Sem a prova: `ILink` com `ssam-tag-<tag>` e o adaptador `display:block` para originais de bloco (a escolha do concorrente para `product-image-wrap`) |
| `button` | `IButton` | filhos compilados (filhos padrão do widget removidos); `Style` = classe; `Enabled` ← `disabled`; vazio com `aria-label`/`title` aceito; **nunca `type=submit`**: o botão de envio de um form tem `OnClick` = a action do envio, `IsDefault = True` e a classe `ssam-submit` (reescrita 4.1 item 7) |
| `a href="#rota"` | `ILink` | `OnClick` = tela de destino (3.1); `Style` = classe; filhos compilados |
| `a href` externo/arquivo | `ILink` | extended property `href` (e `target`, `rel`) |
| `form` | `IForm` | `Style` = classe; submit → `OnClick` do botão de envio |
| `input` text/search/email/number/tel/password/date/time | `IInput` | `Variable` = local `<NomeDoControle>`; `InputType` pelo `type`; `Prompt` ← `placeholder`; `MaxLength` ← `maxlength`; `Mandatory` ← `required`; valor inicial → default da variável; `min`/`max`/`step`/`minlength`/`autocomplete` → extended properties |
| `input[type=checkbox]` | `ICheckbox` | `Variable` Boolean; `checked` → default `True`; o runtime envolve num `span` (0.1) |
| `input[type=radio]` | `IRadioGroup` + `IRadioButton` | `Variable` do grupo pelo `name` |
| `select` | `IDropdown` | `Variable`; `List` pelas regras de opções de 2.8; `Values = Value`, `Labels = Label` |
| `textarea` | `ITextArea` | como `IInput` |
| `label` que envolve o controle | `IAdvancedHtml` `Tag=label` | filhos compilados |
| `label for` só com texto | `ILabel` | `TargetWidget` = o widget do `id` alvo |
| demais tags da lista da plataforma (`table thead tbody tfoot tr th td caption colgroup col`, `ul ol li dl dt dd`, `h1`–`h6`, `p span strong em b i small code pre blockquote figure figcaption section article header footer main nav aside hr`…) | `IAdvancedHtml` `Tag` = a tag | `class` e atributos → extended properties |
| ícone (`icon` no IR) | `IAdvancedHtml` `Tag=span` | classes = as do `<i>` original + `lucide lucide-<nome>` + `ssam-icon` + a classe de máscara (3.5); atributos do `<i>` |
| `img` | `IImage` | Static + imagem do módulo para asset local; External + `Url` para URL; `alt` → extended property |
| texto literal | `ITextWidget` | renderiza texto sem wrapper (0.1) |
| texto com `expr` | `IExpression` | `Value` = expressão de 2.8 |
| `list` | `IList` | `Mode = Custom` (enum `Default`/`Custom` em `ScreenVocabulary.json:2005`), `Tag` = tag do pai (modo `self`), `Style` = classe dele; extended property `disable-virtualization = True`; `Source` = aggregate da tela |
| `if` | `IIfWidget` | `Condition` = predicado; `else` no ramo falso (U1: nunca `Visible`) |

**Padrões do Model API zerados:** todo widget criado tem as propriedades e os filhos que o Model API põe por padrão
reconciliados com `PrototypeWidgetDefaults` (lane compile, 7.2): `Gap` (o concorrente zerou em 1.789 widgets), o `Style`
padrão de botão (`btn btn-primary`, textos `Save`/`Button` no `NRWidgets.dll`), os filhos padrão de `IButton`/`ILink` e as
larguras. O que o protótipo não define fica no valor que não gera classe nem estilo no runtime.

### 3.3 Atributos

- **Todo atributo é preservado.** O que não tem propriedade nativa vira `IExtendedProperty` com o valor literal (ou
  expressão quando `attrExpr`): `data-*`, `aria-*`, `role`, `tabindex`, `title`, `name`, `min`, `max`, `step`, `minlength`,
  `form`, `hidden`, `autocomplete`, `loading`, `rel`, `target`, `open`…
- Consumidos pela propriedade nativa (não duplicados): `class`, `style` (`CustomStyle`), `value`/`checked`/`selected`
  (default da variável), `disabled` (`Enabled`), `placeholder`, `maxlength`, `required`, `type` de input e de botão, `href`
  de rota, `for`, `src`.
- `id`: vira o `Name` do widget (sanitizado, único na tela); não vira atributo (o Verify reserva `id`:
  `InvalidHTMLAttribute_Id`). O runtime põe `id = Name` nos widgets de tela (0.1: `Link8`, `Element11`, `Container14`,
  `Input161`); dentro de bloco o `id` ganha um prefixo (regra exata na etapa 0, 4.2). Seletores `#id` seguem a reescrita
  4.1 item 3.
- Atributos que **referenciam** ids (`aria-labelledby`, `aria-describedby`, `aria-controls`, `form`, `list`) recebem o id de
  runtime do alvo quando ele está na mesma tela fora de bloco; `for` usa `ILabel.TargetWidget`; os demais casos vão para
  `fidelity.references`.
- `on*` (JS inline): nunca vira atributo; o comportamento entra pelo efeito observado.

### 3.4 Dados, estado e lógica

**Decisão (crítica 10): o fluxo principal funciona de ponta a ponta, nativo.** Adicionar ao carrinho atualiza o selo do
shell e a tela Carrinho; "Confirmar pedido" cria o pedido, os itens, baixa o estoque e limpa o carrinho; o cancelamento
devolve o estoque. Sem JSON, sem desenrolar, sem action vazia que exija um op `logic` depois.

**Dados:**

- Coleção **não mutada** → entidade estática `<Prefix><Coleção>` com os registros (op `spec`, `data.static[].records`, que já
  existe), `Id` Integer da chave (L7). Ex.: Categoria, StatusPedido, Users.
- Coleção **mutada** → entidade comum `<Prefix><Coleção>`, `Id` Integer **sem** AutoNumber (as chaves do protótipo aparecem
  na tela: `#1003`, `data-id`), atributos tipados, chaves estrangeiras como Identifier. As linhas da semente são gravadas
  depois da publicação pelo **Edit Data nativo** (fase `seed`, lane surface: O11 pelo caminho do `o11_data`/`EntityData`;
  ODC por `studio_data_insert`), só em entidade vazia, com as palavras de autorização da chamada. Sem timer e sem action de
  carga (instrução do dono de 2026-09-29: dados gravados direto; os timers "When Published" não rodaram em 6 min, duas
  vezes).
- **Leitura:** Screen Aggregate por coleção usada na tela (D1), com filtro e ordem inferidos no próprio aggregate (D2),
  inclusive filtros por dimensão. Ordem que depende de dimensão (ex.: `#catalog-sort`) → screen action `Ordenar<Lista>` com
  um Switch e um `ListSort` por valor observado (atributo puro, sem `List.Current`), chamada no `OnChange` do controle e no
  `OnAfterFetch` do aggregate (só cliente: S1).
- **Registro do popup com parâmetro:** quando o gatilho está num item de uma lista da tela com a mesma coleção →
  `ListIndexOf` (atributo puro) numa local `<Popup>Indice` e o conteúdo liga em `Lista[Indice]`, sem busca; senão aggregate
  filtrado pela local do input e Refresh Data dentro da action que abre.
- Dimensões globais → Client Variables `<Prefix><Dimensão>` de tipo básico (E2); o controle liga numa local iniciada da
  Client Variable no `OnInitialize` (só Assign: S1) e o `OnChange` grava a Client Variable. Dimensões de tela → locais.
- Valores do shell → inputs do bloco (2.5); o toast vive em locais da tela (`Aviso`, `AvisoErro`).

**Escrita:** uma **server action** por evento que muda dados (S2: uma chamada por screen action), nome verbo + objeto. Efeito
de um registro → entity actions (`Get<E>ForUpdate`, `Create<E>`, `Update<E>`, `Delete<E>`). Efeito de conjunto
(`insertFrom`, `updateFrom`, `removeWhere`) → **um** Advanced SQL parametrizado cada (T3 proíbe chamada de banco dentro de
laço; D3 permite SQL quando necessário). Só SQL portável entre SQL Server e PostgreSQL: `INSERT … SELECT`, `UPDATE … SET x =
x − (subconsulta correlacionada) WHERE Id IN (subconsulta)`, `DELETE … WHERE`; chave das linhas inseridas = `COALESCE(MAX(Id),
0) + ROW_NUMBER() OVER (ORDER BY <chave da origem>)`. `validate` → a server action testa os predicados na ordem observada e
lança User Exception com a mensagem exata; o handler de exceção da screen action atribui a mensagem ao alvo observado (local
do elemento de erro do form, ou toast de erro) — como o modelo JS lança e a página mostra. Depois da chamada: Refresh Data só
dos aggregates que leem as coleções escritas (leitura de S2 registrada na seção 10). O usuário vem da dimensão
`AccountSelect` como input `UsuarioId` (a sessão é simulada pelo protótipo; nota AR2 no recibo).

**Efeito → lógica nativa.** Nome (N1, determinístico): verbo do **primeiro** efeito que muda dados (senão do primeiro
efeito), na língua do documento (`lang` começando por `pt` → pt; senão en), mais o objeto em PascalCase ASCII; colisão na
mesma tela → sufixo com a chave do gatilho.

| Efeito | Verbo pt / en | Objeto | Exemplo FarmaVirtual |
|---|---|---|---|
| `navigate` | `IrPara` / `GoTo` | tela | `IrParaCarrinho` (só quando há outros efeitos) |
| `openPopup` / `closePopup` | `Abrir` / `Open`, `Fechar` / `Close` | popup | `AbrirDetalhesDoProduto` |
| `setDimension` | `Definir` / `Set` | dimensão | `DefinirCategory` |
| `toggle` | `Alternar` / `Toggle` | coleção + campo | `AlternarProdutoAtivo` |
| `increment` | `Alterar` / `Change` | coleção + campo | `AlterarCarrinhoItemQuantidade` |
| `remove`, `removeWhere` | `Remover` / `Remove` | coleção | `RemoverCarrinhoItem` |
| `update`, `updateFrom` | `Salvar` / `Save` | coleção | `SalvarProduto` |
| `insert`, `insertFrom` | `Criar` / `Create` | coleção | `CriarPedido` |
| `upsert` | `Adicionar` / `Add` | coleção | `AdicionarCarrinhoItem` |
| `toast` (sozinho) | `Mostrar` / `Show` | `Aviso` / `Notice` | `MostrarAviso` |

| Efeito | Nós |
|---|---|
| `navigate` | `OnClick` = tela (navegação pura) ou Destination no fim da action |
| `openPopup` | Assign dos inputs (ou índice) e `<Nome>IsOpen = True` num só Assign (L4); Refresh Data só sem `ListIndexOf` |
| `closePopup` | Assign `<Nome>IsOpen = False` |
| `setDimension` | Assign (com `Max/Min` quando há limites); Refresh Data dos aggregates filtrados por ela, ou `Ordenar<Lista>` |
| `toggle` | server: `Get<E>ForUpdate` + Assign `not` + `Update<E>`; tela: Refresh Data |
| `increment` | idem com `Max(min, Min(max, campo + d))` |
| `remove` | server: `Delete<E>` |
| `update` | server: `Get<E>ForUpdate` + Assign dos campos ← inputs + `Update<E>` |
| `insert` | server: aggregate `Max(Id)` + `Create<E>` com `Id = Max + 1` e campos de 2.6; devolve a chave |
| `upsert` | server: aggregate pelos campos-chave + If "Item já está no carrinho?" → `increment` / `insert` |
| `insertFrom` / `updateFrom` / `removeWhere` | server: um Advanced SQL parametrizado cada |
| `validate` | server: If com o predicado (pergunta como nome: N1) + Raise User Exception; tela: handler que atribui a mensagem |
| `toast` | Assign `Aviso`, `AvisoErro` |
| dependente de estado/campo | If com o predicado e os ramos acima |

Eventos do bloco shell: navegação vai direto para a tela; mudança de dimensão global dispara o evento do bloco
`<Dimensão>Alterada`, que cada tela trata gravando a Client Variable e atualizando seus aggregates (U5). Efeito que depende
da tela atual usa o input `View`.

Sem JS, sem JSON, sem `Visible`, sem `ForEach`, sem chamada de servidor em evento de ciclo de vida (S1).

### 3.5 Nomes e descrições

- Telas, popups, blocos, entidades, variáveis, actions: PascalCase ASCII, únicos pelas regras do Model API; prefixo onde o
  nome é global (flow, tema, bloco shell, entidades, imagens, Client Variables); homônimo sem marca → `<Prefix><Nome>`
  (1.6).
- Widgets: `id` do protótipo quando existe; senão `<Tag><n>` contado por tela (regra do `HtmlVisual`).
- Descrição em tudo que tem `Description` (N1): de onde veio (`k`, arquivo:linha do handler) e a marca (1.6).
- Classe de máscara de ícone: `ssam-icon-<nome>` quando `strokeWidth = icons.defaultStrokeWidth`; senão
  `ssam-icon-<nome>-w<strokeWidth×100 inteiro>` (FarmaVirtual: `ssam-icon-plus-w300` na marca). A lane compile põe a classe;
  a lane css escreve a regra; as duas derivam o nome por esta regra.
- Imagem do módulo: `<Prefix><NomeDoArquivo em PascalCase>` (`products.png` → `FarmaVirtualProducts`).

### 3.6 O11 × ODC

| Ponto | O11 Reactive/Mobile | ODC |
|---|---|---|
| Ferramenta | `o11_deliver` (ensaio `until:"apply"`) | `studio_deliver` pelo `ssam` (ensaio `until:"preview"`; `feature`, `owners`, `changes`) |
| Tags do HTML Element | 103 (0.1) | 100: `main`, `data`, `picture` substituídos (3.2) |
| Acesso anônimo | role `Anonymous` | `AnonymousAccess = true` |
| URL de imagem no CSS | `/<Módulo>/img/<Módulo>.<Imagem>.<ext>` | `/<App>/img/<App>.<Imagem>.<ext>` (confirmado na etapa 0 contra um publicado ODC; sem confirmação, o asset em CSS é recusado com a causa) |
| Dados da semente | caminho do `o11_data` (Edit Data pelo login do Service Studio) | `studio_data_insert` |
| SQL | SQL Server | PostgreSQL; só as formas portáveis de 3.4 |
| Flow com tema | `IMobileFlow.Theme` | idem (mesmo Model API no kernel ODC) |

### 3.7 Fora de escopo (sempre listado em `outOfScope`, nunca silencioso)

- Fechamento do modal pelo clique no fundo (listener com guarda de alvo, `app.js:344`): o `IPopup` nativo não tem esse
  evento.
- Timers longos (`setTimeout` > 1000 ms, `setInterval`; ex.: o toast some em 5500 ms), foco e teclado programáticos
  (`focus()`, `keydown` que só repete o clique, `app.js:338`), `scrollTo`, animações por JS.
- Validações de JS sem restrição de atributo e não alcançadas pela perturbação (ex.: a regex de `ImagemUrl`,
  `model.js:153`): a escrita acontece sem elas; cada uma listada com o arquivo:linha.
- Segurança de sessão: a conta é uma dimensão simulada pelo protótipo (nota AR2).
- Busca sem acentos (`normalize('NFD')`): compilada como `Index(ToLower(...))` e marcada como aproximação.
- `canvas`, `iframe` com conteúdo, vídeo, gráficos por script.
- Resíduos da explicação de efeitos (2.6), se houver, com a diferença exata.

## 4. Fidelidade por construção, medida no que foi construído

### 4.1 CSS verbatim

- O texto de cada folha do protótipo vai para `<Prefix>Theme.StyleSheet` **inteiro, na ordem do documento**, lido do pacote
  (nunca reescrito pelo modelo). O construtor direto grava o `StyleSheet` pelo Model API **sem** passar pelo
  `CodeFormat.Apply` (`CodeFormatHook.cs`; o `set` e o `InstallStylesheet` formatam, `HtmlDelta.cs:179`): o desvio é
  explícito e só do importador. `css.verbatim` = cada trecho do protótipo igual byte a byte ao original fora das posições
  das reescritas registradas, e mesma contagem de regras pelo mesmo parser.
- **Ordem no tema:** `@import`s içados → `/* ssam:prototype ua */` regras de UA das tags substituídas, todas com `:where()`
  (especificidade zero; antes do protótipo, porque o UA perde para o autor) → CSS do protótipo reescrito, folhas na ordem com
  `/* <caminho> */` entre elas → `/* ssam:prototype icons */` → `/* ssam:prototype adapters */`.
- **Lista fechada de reescritas** (cada uma contada em `fidelity.css.rewrites`; todas preservam a especificidade original,
  porque `:is()` vale o maior argumento e `:where()` vale zero):
  1. `url(<asset local>)` → URL da imagem do módulo (3.6).
  2. `@import` de qualquer linha (inclusive de uma linha minificada de 27 mil caracteres) → içado para o topo, na ordem,
     pelo parser (`CssCompat.Imports`), nunca por regex de linha. A leitura de volta confere que é a primeira instrução do
     `StyleSheet` gravado; a etapa 0 confere que fica primeiro no arquivo CSS publicado do tema. Se não ficar, o fallback é
     o do concorrente (`fonts.css`): a fachada resolve o `@import` de `fonts.googleapis.com` em `@font-face` pelo cache de
     vendors e grava inline.
  3. `#id` → `:is(#id, .ssam-id-<id>)` e a classe `ssam-id-<id>` no widget do `id` (especificidade 1,0,0 mantida).
  4. Tag substituída `T` (3.2) → `:is(T, :where(.ssam-tag-T))`, inclusive em `T[open]`; `T::backdrop` → item 8.
  5. Ícones: `svg` → `:is(svg, :where(.ssam-icon))`; todo composto de tipo `span` → `span:not(:where(.ssam-icon, <spans de
     runtime da tabela 4.2>))` (especificidade do `:not(:where(…))` = 0). FarmaVirtual: `.brand span:last-child` deixa de
     casar o ícone `+` dentro de `.brand-mark` (senão a máscara, `background-color:currentColor`, ficaria verde sobre o verde
     e o `+` sumiria), e `.field>span`/`.sort-control>span`/`.header-link span:not(.cart-number)` deixam de casar os `span` de
     `IExpression` e o wrapper do checkbox.
  6. Wrappers transparentes: para cada linha de wrapper W da tabela 4.2 em volta do widget de tipo Y, o composto `X > Y` →
     `:is(X > Y, X > :where(W) > Y)` e as pseudo-classes posicionais de Y (`:first-child`, `:last-child`, `:nth-child()`,
     `:only-child`, `:*-of-type`) ganham a variante `:where(W):<pc> > Y`. Aplicada só onde o composto pode casar um elemento
     compilado para um widget com wrapper (calculado na árvore `WidgetNode`).
  7. `[type=submit]` → `:is([type=submit], :where(.ssam-submit))`.
  8. `dialog::backdrop` → o mesmo bloco de declarações no seletor do fundo do popup da tabela 4.2.
- **Nenhum escopo:** `:root`, `html`, `body`, `*` e os seletores do protótipo valem como no navegador. Nada de
  `.fv-native-root` na frente.
- **CSS nunca truncado:** o kernel confere o `sha256` de cada folha do pacote com o do IR e conta as regras do texto gravado
  e do original; falta de regra → `PROTOTYPE_IR_INVALID` (`ssamDefect`).
- O recibo leva os avisos do Verify por código (`verifyWarnings`), inclusive os `InvalidResourceURL_Offline` que as máscaras
  `data:` produzem (34 na entrega 105).

Regras de UA das tags substituídas (tabela fixa, do HTML Living Standard), ex.: `:where(.ssam-tag-dialog){position:absolute;
inset-inline:0;width:fit-content;height:fit-content;margin:auto;border:solid;padding:1em;background:Canvas;color:CanvasText}`,
a variante modal (`position:fixed;overflow:auto;inset-block:0;max-width:calc(100% - 6px - 2em);max-height:calc(100% - 6px -
2em)`) e `:where(.ssam-tag-main){display:block}`.

Classe de máscara (uma por nome+traço):

```css
.ssam-icon-plus-w300{display:inline-block;background-color:currentColor;
  -webkit-mask:url("data:image/svg+xml,<svg do set com stroke-width=3, percent-encoded>") center/contain no-repeat;
  mask:url("data:image/svg+xml,<idem>") center/contain no-repeat}
```

Largura, altura, cor, `vertical-align` e `flex-shrink` continuam vindo das regras do protótipo (`.icon`, `.brand-mark
.icon`…), porque o `span` tem as mesmas classes.

### 4.2 DOM de runtime, padrões e adaptadores

O DOM que o runtime acrescenta é **dado congelado por evidência**, não suposição: `RuntimeDomTable.cs` (lane css; tabelas
C#, sem recurso embutido, para não tocar nos `.csproj`), uma por plataforma, com, por widget: elemento, atributos de runtime
(`data-container`…), regra do `id`, classes postas por propriedade, wrappers, status `evidence` | `inferred` e a referência
da evidência. A mesma tabela alimenta as reescritas (4.1 itens 5 e 6), os adaptadores, os valores de propriedade que evitam
classes (3.2) e o renderizador da fidelidade (4.4).

Linhas O11 já com evidência (0.1):

| Widget | DOM de runtime | Status |
|---|---|---|
| `ILink` (OnClick em action) | `<a data-link="" class="<Style>" href="#" id="<Name>">` | evidence |
| `IAdvancedHtml` | `<Tag data-advancedhtml="" class="<class>" id="<Name>">` | evidence |
| `IContainer` | `<div data-container="" class="<Style> [OSInline] [ThemeGrid_MarginGutter]" style="<CustomStyle>" id="<Name>">`; as duas classes aparecem com as larguras padrão | evidence (a regra exata de quando aparecem: etapa 0) |
| `ITextWidget` | nó de texto, sem wrapper | evidence |
| `ICheckbox` | `<span><input data-checkbox="" class="" type="checkbox" id="<Name>"></span>` | evidence |
| instância de bloco | `<div class="OSBlockWidget" data-block="<…>">` | evidence |
| `IIfWidget` | nenhum elemento próprio | inferred |
| `IExpression`, `IButton`, `IInput`, `ITextArea`, `IDropdown` (wrapper e segunda seta, `visual-audit.txt` item 4), `IForm`, `IList` (`Custom` + `Tag`), `IPopup` (fundo e caixa), `IPlaceholderWidget`, `IImage`, `id` dentro de bloco | — | etapa 0 |

**Etapa 0 (integrador, antes de as lanes css e compile fecharem; só leitura):** com o navegador embutido e o login do dono,
abrir telas **já publicadas** e salvar o `outerHTML` de pelo menos uma instância de cada widget da lista acima, mais a lista
das folhas carregadas que definem `OSInline`, `ThemeGrid_*`, `OSFillParent`, `popup-*` (varredura de
`document.styleSheets`). Fontes: as telas do concorrente em `Haiku_UI` (If, Dropdown, Expression, Text, Button, Link,
Checkbox, Input, TextArea, HTML Element, Container) e telas publicadas de outros apps do ambiente com Popup, List, bloco com
placeholder, Form e Image; para o ODC, um app ODC publicado. Sem publicar e sem mudar nada. O resultado fica em
`docs/evidencias/runtime-dom-o11.json` e `runtime-dom-odc.json` e nas tabelas C#. Tipo sem instância publicada fica
`inferred` e cada widget dele entra em `fidelity.runtimeUnverified` (contado, nunca escondido).

**Adaptadores** (algoritmo fixo sobre a tabela, igual para todo protótipo):

- wrapper sem papel no layout do protótipo → `display:contents` + as reescritas 4.1 item 6 (`display:contents` resolve o
  layout, não `>`, `:nth-child` nem `:last-child`; por isso as duas coisas);
- classe posta por propriedade → evitada pelo valor de propriedade que a tabela mapeia para "sem classe"; classe inevitável →
  regra de neutralização da própria tabela (seletor e declarações da evidência), no bloco de adaptadores. Evidência do
  concorrente: precisou de `:where(div.OSInline){display:block}`, `.ThemeGrid_MarginGutter{margin-left:0}`,
  `.fv-native-root{display:block!important;width:100%!important}`, `.product-image-wrap{display:block}` e do tratamento de
  `[data-dropdown]`; `visual-audit.txt` itens 4, 5, 10 e 13;
- `IPopup`: fundo `position:fixed;inset:0;display:flex;align-items:center;justify-content:center` + as declarações de
  `dialog::backdrop` do protótipo; caixa `display:contents`; o `div.ssam-tag-dialog` recebe as regras de UA de 4.1.

### 4.3 Correções de escopo no op html (caminho manual)

1. `CssSource.ScopeSelector` (`CssSource.cs:150`, **lane css**): quando o primeiro composto já é a raiz (`main.app`,
   `[data-x].app`, `.a.app`), ele é a âncora e não ganha prefixo; `*` no início vira `.app, .app *`; `:root`, `html`, `body`
   seguem virando a raiz.
2. Chave do bloco no tema (**lane html**, `HtmlDelta.cs` inteiro e `HtmlVisual.cs:1161`): `InstallStylesheet(string
   blockKey, …)` recebe a chave pronta, composta por quem chama: a forma fragmento passa `"<dono>:<classe>"` (dono = tela ou
   bloco que recebe o fragmento); a forma página (`HtmlDelta.cs:100`) passa `<tela>`. **Adoção do marcador antigo:** quando
   `/* anvil:html <dono>:<classe> */` não existe e existe o legado `/* anvil:html <classe> */`, o primeiro dono que instala
   aquela classe adota o bloco legado (renomeia o marcador e substitui o conteúdo); os seguintes ganham blocos próprios; o
   relatório lista `adoptedLegacy`. Nunca duas cópias.
3. `@import` na forma fragmento (`HtmlVisual.cs:1036`) e na página (`HtmlExpander.cs:218`) (**lane html**): içado para o topo
   do CSS do autor do tema (`CssCompat.HoistImports` + `ThemeCss.Recompute`), com `cssImportsHoisted` no relatório.

A guarda de perda `CSS_RULES_DROPPED` e o aviso de `var(--x)` sem definição ficam em `PreflightRules/StyleSheetRules.cs`
(**lane css**, só ela implementa e testa).

### 4.4 Medida de fidelidade

Não é um autodiff do que o compilador quis construir; mede o que ficou no modelo depois do build e do Verify, renderizado
como o runtime renderiza. Sem navegador e sem LLM.

1. **Lado protótipo:** as árvores de cada estado de `explored` (2.10). `<i data-lucide>` conta 1, `option` conta 1.
   `N_proto` = elementos (922 no canônico da FarmaVirtual, a mesma contagem de `an\proto_inv.py`).
2. **Lado nativo** (`PrototypeSeams.Render`, lane css, C#): depois do Verify, o kernel lê de volta o módulo construído
   (`KernelModelReader` sobre a sessão já gravada: telas, blocos, popups, widgets, propriedades, extended properties,
   expressões, aggregates, entidades e registros) e renderiza cada estado explorado pela tabela widget→DOM da plataforma
   (4.2, com os wrappers e os atributos de runtime). As expressões são avaliadas por um avaliador do subconjunto fechado que
   o compilador emite (tabelas 2.8 e 3.4); função fora dele → nó `unevaluable` (diferença contada). Aggregates são avaliados
   sobre as linhas da semente, com o filtro e a ordem lidos do modelo. Saída `prototype-dom.json`.
3. **Comparação** (`prototype/fidelity.mjs`, lane render, jsdom sem scripts e sem layout):
   - (a) elementos, classes, atributos e textos, alinhados por LCS com chave (2.8), sem as classes `ssam-*`, sem os atributos
     de runtime e com as equivalências documentadas (tag substituída + `ssam-tag-*`, `type=submit` ↔ `ssam-submit`, `href`
     de navegação, `role` implícito, `id` de runtime); wrappers transparentes;
   - (b) **conjuntos de seletores:** para cada regra de estilo de cada folha do protótipo (inclusive dentro de `@media` e
     `@supports`) e cada seletor da lista, sem pseudo-classes dinâmicas e pseudo-elementos (`:hover`, `:focus`,
     `:focus-visible`, `:focus-within`, `:active`, `:visited`, `:target`, `::before`, `::after`, `::placeholder`,
     `::backdrop`, `::-webkit-*`), o conjunto de `k` casados na árvore do protótipo com o seletor original tem de ser igual
     ao conjunto casado na árvore nativa com o seletor **reescrito**; elemento sem `k` (wrapper de runtime) casado = ganho.
4. **Número:** `score` = elementos casados / `N_proto` somados em todos os estados explorados; `selectors` (regras,
   seletores, iguais, ganhos, perdidos, os 50 primeiros com seletor, estado e `k`); `perState`; `runtimeUnverified`;
   `references`; `unevaluable`; `mismatches` (50 primeiros com `k`, esperado e obtido).

O que a medida não cobre, dito no recibo: pixels, estilo computado, carga de fontes e as linhas `inferred` da tabela de
runtime. Abaixo de 1,0 a entrega não é recusada (é o desenho do usuário), mas cada diferença sai listada com o `k`.

## 5. Problemas do op html achados no diagnóstico e as correções

O importador não passa pelo `HtmlExpander`, mas usa a **mesma** tabela elemento→widget (`ElementWidgetMap`): as correções H4–H9
e H13 são implementadas nela uma vez (lane html) e valem para os dois caminhos. Linhas de `cd7e4f11`.

| # | Problema (diagnóstico) | Onde | Correção determinística | Teste |
|---|---|---|---|---|
| H1 | Forma página para no 1º erro: 10 recusas, 1 problema cada; 44 problemas presentes e não ditos | `HtmlExpander.cs:1057` (`Error`) e 123 `throw Error` | Coletar tudo como a forma fragmento (`Record`/`Settle`, `HtmlVisual.cs:261-270`): por elemento, por chave, por statement CSS; cascatas agrupadas | job 79 (`cc36c64b`) → as 9 causas em uma recusa |
| H2 | Regras estruturais só no apply (8–18 s de build por volta) | `HtmlExpander.Preflight` (`:86`) | Passada de widgets sem módulo no preflight (escopo vazio, como `HtmlVisual.Preflight` com `names:false`); `call` checado contra os ops `logic` do job | preflight do job 79 < 1 s, sem base |
| H3 | Op html reprovado no preflight é aplicado de novo | `JobRunner.Diagnosis.cs` `RefusedWhole` | Incluir `HTML_INVALID` estrutural em `SkipOps` | o op não roda no apply depois de reprovado |
| H4 | Atributo fora da lista recusado (`tabindex`, `disabled`, `name`, `min`, `max`, `step`, `selected`, `checked`, `minlength`, `form`) | `HtmlExpander.cs:965` | Extended property literal (como `aria-*`); `disabled` → `Enabled = False`; `checked`/`selected`/`value` → default da variável | 57 atributos do protótipo aceitos |
| H5 | `<button>` vazio recusado | `HtmlExpander.cs:838` | Aceito com `aria-label` ou `title` | 8 switches aceitos |
| H6 | `<label>` sem texto recusado, e filhos descartados em silêncio | `HtmlExpander.cs:893-903`, `:899` | Label com filhos → `IAdvancedHtml Tag=label` (na lista das duas plataformas) com os filhos | `label.input-search` e os 15 labels mantêm os controles |
| H7 | `visible` só em `div` | `HtmlExpander.cs:983`, `:655` | `IIfWidget` em volta de qualquer widget | 3 spans e 19 trs aceitos |
| H8 | `call` só em `button`/`a` | `HtmlExpander.cs:696` | `IAdvancedHtml` com a tag original e evento `onclick` (fallback de 3.2 quando a prova do evento falhar) | 7 `div[role=button]` mantêm a tag |
| H9 | `<table>` estática recusada | `HtmlExpander.cs:907` | `table/thead/tbody/tfoot/tr/th/td/caption/col/colgroup` como `IAdvancedHtml` (todas na lista) | 3 tabelas e 19 linhas sem div+role |
| H10 | `call` para screen action da própria tela impossível; ordem logic×html | `HtmlExpander.cs:876`; `HtmlDelta.cs` `Html(op)` | Resolver screen actions declaradas no mesmo job para a tela da página (criar a tela, o logic, depois o conteúdo) | as 61 actions do job 79 resolvem |
| H11 | `list` só sobre entity/server action | `HtmlExpander.cs:418`, `:426`, `:481` | `source:{variable:"<Lista>"}` aceito | lista sobre variável local |
| H12 | `data-av` repetido recusado | `HtmlExpander.cs:249` | Mesma chave em N elementos = o mesmo binding em cada um, nomes `<Nome>`, `<Nome>2`… | 18 duplicatas aceitas |
| H13 | `id` não nomeia widget na forma página; nota de "skipped" mentiu | `HtmlExpander.cs:978`, `:1000-1009`; `Verbs.Collect.cs:28-34` | `div` sem `data-av` recebe o nome do `id`; a heurística de skip usa os nomes criados (`report.keys`) | 27 contêineres de montagem resolvem |
| H14 | `@import` recusado; o modelo cortou o CSS por regex (27.632 caracteres perdidos) | `HtmlExpander.cs:218`, `HtmlVisual.cs:1036` | Içar (4.3 item 3). A guarda de perda é da lane css (4.3) | `@import` içado nas duas formas |
| H15 | Fix genérico aponta a forma fragmento para erro da página; `patch` nunca preenchido | `JobPreflight.cs:343` (`DefaultFix("html")`) | Fix e `patch` por código (tabela de `an\html-compiler.md` seção 4) | cada código com fix próprio |
| H16 | Contrato publicado sem as regras | `HtmlExpander.Schema()` (`:65-73`) | Publicar kind→tag, a lista de tags da plataforma, atributos, nomes por `id`, `@import` içado, `call` para screen action | schema contém as regras |

## 6. Metas de tempo (FarmaVirtual)

| Fase | Evidência hoje | Mecanismo | Orçamento |
|---|---|---|---|
| Modelo lê o pedido e faz a chamada | — | rota de descoberta com a chamada pronta | ≤ 30 s, ~300 B |
| Captura | janela quente 30 ms, 6 rotas 73 ms (0.1) | pool de 8 filhos, janelas reaproveitadas, scripts compilados uma vez (2.6) | ≤ 5 s |
| Expansão do op em plano | — | em memória | ≤ 3 s |
| Build headless (aplicar + Verify) | 105: 70,1 s aplicando 331 ops (1.853 widgets) no replay frio; 123,5 s ao vivo com a máquina 46% ocupada | **construtor direto** `PrototypeBuilder`: widgets criados numa passada pelo Model API com o pai em mãos, sem `Resolve` por nome, sem `VerbSurface.Check`/`Anotar`/`FootprintScopes` por widget; só os elementos de módulo (flow, tema, entidades, telas, blocos) e a lógica passam pelos verbos existentes | ≤ 30 s (aplicar ≤ 15 s; carga + checagem da base + gravação ~11 s no replay da 105) |
| Leitura de volta + fidelidade | — | `KernelModelReader` + jsdom | ≤ 5 s |
| Merge nativo | 105: 55,0 s | existente | ≤ 70 s |
| Publicação | concorrente: `omlPublish` de `Haiku_UI` 11,8 s; merge + publish finais 27,9 s | existente (`publish:true`) | ≤ 45 s |
| Dados (seed) | — | Edit Data nativo, ~30 linhas em 4 entidades | ≤ 15 s |
| **Soma dos orçamentos** | | | **≈ 3,4 min** |
| **Ponta a ponta (meta do dono)** | | | **5–7 min**, cobrindo a variação medida entre execuções (±50%, `an\replay.md`) e a máquina compartilhada |

Leitura honesta: sem o construtor direto, aplicando ~2.200 widgets pelo caminho de hoje (~38 ms por widget na 105), o build
fica em ~90–150 s e o total em ~4,5–6 min numa máquina livre, chegando a ~7 min com a carga de 2026-10-10. A estimativa de
6,5–8 min da crítica supunha publicação de 120 s; a publicação medida do mesmo módulo é de 12 a 28 s. O construtor direto é
**obrigatório** (gate do teste 8 da lane compile) porque é a folga que mantém os 5–7 min sob carga. Medido no recibo
(`timings`) e no `phases.json` da tarefa.

## 7. Lanes

Cinco lanes em paralelo, todas a partir de `cd7e4f11`. Worktree: `C:\Users\andre\SSAM-Hybrid-integracao-wt\proto-<key>`.
Branch: `fix/proto-<key>`. Regras comuns: caminhos absolutos; nada em pastas de outras sessões; sem Studio, sem MCP ssam,
sem rede, sem workers (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`), TEMP/TMP curtos privados (`C:\t\proto-<key>`),
`ANVIL_ODC_FEATURES_DIR` próprio, `ANVIL_AUTHORITY_DIR=C:\Users\andre\.anvil\authority`; build pelo
`scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipInstall -SkipMcp -SkipDoctor`; `node_modules` copiados de
`C:\Users\andre\SSAM-Hybrid-integracao-wt\rp-juncao` (inclui `platforms\odc\node_modules` com jsdom 30.1.1); nunca
`build.py`/`build_odc.py`/`build.ps1`. Commits com autor/committer Andre Machado `<andre_c_machado@hotmail.com>` e a linha
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Cada lane só escreve nos seus arquivos; cada linha de arquivo
compartilhado tem um dono só (tabela 7.0).

### 7.0 Donos únicos e etapa 0

| Arquivo ou trecho | Dono |
|---|---|
| `PrototypeContracts.cs` | html, css e compile adicionam **byte a byte igual** (7.3); só o integrador muda |
| `ElementWidgetMap.cs` (tabela elemento→widget e listas de tags) | html |
| `HtmlDelta.cs` inteiro (`Html(op)`, `InstallStylesheet`, adoção do marcador) e `HtmlVisual.cs:1161` | html |
| `JobPreflight.cs` inteiro, inclusive o bloco `prototype` (por `PrototypeSeams.Preflight`) | html |
| `Verbs.Collect.cs` inteiro, inclusive o `or "prototype"` | html |
| `CssSource.cs`, `CssCompat.cs`, `ThemeCss.cs`, `PreflightRules/StyleSheetRules.cs` (`CSS_RULES_DROPPED`, `var(--x)`) | css |
| `Verbs.cs` (linha do `switch`), `VerbSurface.cs` (entrada), `CommandSurface.cs` (nome e `Schema`) | compile |
| `platforms/odc/facade/ssam.mjs` (proxy) e `facade/ssam.mjs` (CLI) | surface |

**Etapa 0** (integrador, só leitura, 4.2): congela o DOM de runtime O11 e ODC antes de as lanes css e compile fecharem; as
lanes escrevem contra o schema de `RuntimeDomTable.cs` desde o início, e as linhas da etapa 0 entram sem mudança de código.
As listas de tags das duas plataformas já estão extraídas nesta revisão (3.2).

### 7.1 Lane `render`: protótipo → IR, e a comparação da fidelidade

- Branch `fix/proto-render`, worktree `C:\Users\andre\SSAM-Hybrid-integracao-wt\proto-render`.
- **Arquivos (novos):** `platforms/odc/facade/prototype/` — `capture.mjs` (API e CLI), `child.mjs`, `pool.mjs` (2.6),
  `dom-runtime.mjs` (jsdom, relógio, timers, polyfills, registro de listeners e de `setItem`), `scripts.mjs` (clássicos e
  módulos ES), `network.mjs` (interceptador, dispatcher que rejeita, `fetch`/XHR locais), `vendor.mjs` (cache de CDN),
  `kinds.mjs` (2.2), `crawl.mjs` (2.3), `shell.mjs` (2.5), `modals.mjs` (2.4), `dimensions.mjs`, `effects.mjs`,
  `perturb.mjs` (2.6), `store.mjs` (2.7), `align.mjs`, `infer-lists.mjs`, `predicates.mjs`, `formats.mjs` (2.8),
  `icons.mjs`, `assets.mjs`, `css-inventory.mjs`, `bundle.mjs` (2.9), `names.mjs`, `ir.mjs` (schema, validador, JSON
  canônico, hash), `fidelity.mjs` (4.4 passo 3). Testes `platforms/odc/facade/tests/prototype-render-*.test.mjs` e
  `prototype-fidelity-*.test.mjs`. Fixtures `platforms/odc/facade/tests/fixtures/prototype/`: `farmavirtual/` (cópia
  verbatim de `index.html`, `app.js`, `model.js`, `styles.css`, `README.md`, `assets/lucide.js`, `assets/LUCIDE-LICENSE`;
  `assets/products.png` substituído por um PNG pequeno com o mesmo nome), `multipage/`, `sections/`, `static/`,
  `ambiguous/`, `external-script/`, `esm/`, `cdn/` (com cache de vendor de fixture), `fetch-json/`, `path-router/`,
  `state-machine/`, `react-like/`.
- **Interface:**

```js
// platforms/odc/facade/prototype/capture.mjs
export async function capturePrototype({ source, entry, mapping = {}, clock, tz = 'UTC', out, timeoutMs = 20000, pool }) {}
// → { ok: true, capturePath, bundle, sha256, summary: { kind, views, modals, elements, icons, events, compiled, probes }, problems: [], warnings: [] }
// → { ok: false, problems: [{ code, path, message, patch?, alternatives? }], warnings }   (códigos de 1.4)
// CLI: node platforms/odc/facade/prototype/capture.mjs <source> --out <dir> [--entry x] [--mapping <json>] [--clock <iso>] [--tz <iana>]
// platforms/odc/facade/prototype/fidelity.mjs
export function measureFidelity({ capture, nativeDom }) {}   // → report.prototype.fidelity (4.4)
```

- **Testes obrigatórios:**
  1. FarmaVirtual: `kind = spa-hash`; o ponto fixo acha as 6 vistas (`Catalogo`, `Carrinho`, `MeusPedidos`, `PedidoDetalhe`
     com input `Id`, `GestaoProdutos`, `GestaoPedidos`, nomes do README), inclusive as de gestão, que só aparecem no estado
     `account-select = 3`; o mesmo resultado com o README removido da fixture (fontes 1, 2 e 4); vista padrão `catalogo`;
     estados canônicos 1 nas 4 vistas de cliente e 3 nas 2 de gestão.
  2. 5 tipos de modal com nomes, telas e inputs de 2.4; o listener de `app.js:344` em `targetGuarded`.
  3. Shell: raiz `#app`; regiões `.demo-strip`, `.site-header`, `.main-nav`, `main` (montagem), `footer`, `#notifications`;
     inputs e eventos de 2.5.
  4. `stats.elements = 922`, `icons = 33`, `iconInstances = 118`.
  5. Store `global:FarmaModel.seed()` com 6 coleções (Produto 8 linhas) + Users correlacionado; Produto, CarrinhoItem,
     Pedido e PedidoItem `mutated`.
  6. Efeitos por evento exatamente como a tabela 8.2, com `notCompiled` vazio; perturbação: `product-form` dá `update`
     (Id > 0) e `insert` (Id = 0) com os campos ligados pelo `name`; `checkout-form` dá `validate` (nome 3–120, endereço
     10–500, observação ≤ 500, mensagens exatas do `model.js`) e a composição `insert`+`insertFrom`+`updateFrom`+
     `removeWhere`+`setDimension`+`navigate`; `#catalog-search` dá `contains` sobre os campos certos.
  7. Lista do catálogo: `Produto` filtrado por `Ativo` (7 de 8), `currency:pt-BR:BRL`, `cases` no estoque e
     `substr-after:#tile=` na classe `tile-N`; `#new-order-status` com opções por status.
  8. Determinismo: duas capturas com o mesmo `clock` → mesmo `sha256`, com pool 8 e com pool 1; `timings` e `engine.node`
     fora do hash; `TZ` fixo no filho.
  9. Rede: `external-script` sem cache → `PROTOTYPE_RENDER_FAILED` com o patch `vendor`; `cdn/` com o cache de fixture
     captura; `fetch-json/` lê o JSON local como store; host externo em `fetch` → `warnings`; nenhuma requisição chega ao
     dispatcher global.
  10. `ambiguous/` → uma resposta com todos os problemas e patches que, aplicados, capturam sem problema; `data` com
      `alternatives`.
  11. `multipage/`, `sections/`, `static/`, `esm/`, `path-router/`, `state-machine/` (vistas por esqueleto, não dimensões) e
      `react-like/` (alvos por `__reactProps$`) → vistas, navegação e eventos esperados.
  12. Captura da FarmaVirtual ≤ 5 s com pool 8 (≤ 25 s com pool 1), com `probes` e `windows` no resumo.
  13. Fidelidade: árvore nativa igual → `score = 1.0` e 0 diferenças de seletor; um atributo, uma classe e um texto alterados
      → 3 `mismatches` com `k`; um `span` de runtime sob `.field` sem a reescrita 4.1 item 5 → 1 seletor `gained`.

### 7.2 Lane `compile`: IR → módulo nativo

- Branch `fix/proto-compile`, worktree `C:\Users\andre\SSAM-Hybrid-integracao-wt\proto-compile`.
- **Arquivos (novos):** `kernel/src/Anvil.Core/Kernel/Prototype/` — `PrototypeContracts.cs` (7.3), `PrototypeCapture.cs`
  (leitura e validação do IR e do pacote, hashes), `PrototypeExpander.cs` (ordem, plano), `PrototypeBuilder.cs` (construtor
  direto de widgets, 6), `PrototypeWidgets.cs` (árvore `WidgetNode` pelo `PrototypeSeams.Element`), `PrototypeData.cs`
  (entidades estáticas e comuns, aggregates, Client Variables), `PrototypeLogic.cs` (efeitos → screen e server actions),
  `PrototypeSql.cs` (SQL portável dos efeitos de conjunto), `PrototypeNames.cs` (3.5, colisões, marca),
  `PrototypePreflight.cs` (checagem estática do IR sem módulo: todos os problemas), `PrototypeWidgetDefaults.cs` (padrões do
  Model API por plataforma), `PrototypeRegistration.cs` (`[ModuleInitializer]` que registra `PrototypeSeams.Preflight`);
  `kernel/src/Anvil.Core/Kernel/Verbs.Prototype.cs` (partial `ModelSession.Prototype`). Testes
  `kernel/tests/Anvil.Tests/PrototypeExpanderTests.cs`, `PrototypeBuilderTests.cs`,
  `kernel/tests/Anvil.Tests.Odc/PrototypeExpanderOdcTests.cs`; fixtures IR em
  `kernel/tests/Anvil.Tests/Fixtures/prototype/*.capture.json` (+ pacotes).
- **Costuras (texto exato, e nada mais nesses arquivos):**
  - `Verbs.cs`, no `switch` de `ApplyOne`, depois de `"html" => Html(op),`: `"prototype" => Prototype(op),`
  - `VerbSurface.cs`, logo depois da entrada `new("html", …),`:
    `new("prototype", "write", ["data"], [], "Prototype folder imported as native screens, a shell block, popups, data and logic (data.capture is written by the facade); see `api --op prototype`."),`
  - `CommandSurface.cs`: `"prototype"` no fim de `OperationNames`, e `"prototype" => PrototypeExpander.Schema(),` depois da
    linha `"html-visual" => HtmlVisual.Schema(),`.
- **Ordem:** imagens → `spec` (entidades estáticas: coleções não mutadas, opções, snapshots; entidades comuns das coleções
  mutadas) → tema (`BaseTheme = null`, `StyleSheet` = `PrototypeSeams.Css`, gravado sem `CodeFormat`) → flow (`Theme`) →
  Client Variables → server actions (`logic`) → bloco shell e blocos de modal → por tela: criar, inputs, locais, aggregates,
  screen actions (`logic`), instância do shell, widgets da vista e popups pelo construtor direto → depois do Verify,
  `PrototypeSeams.Render` → `prototype-dom.json`.
- **Saída:** `report.prototype` (1.4) menos a comparação da fidelidade e os tempos de merge, publicação e seed, que a fachada
  completa.
- **Testes obrigatórios (sem Studio aberto; com as DLLs do Service Studio instaladas como o resto da suíte):**
  1. IR mínimo → ops na ordem acima; nomes e marcas; `WidgetNode` igual ao golden.
  2. Cada `ElementMapping` do seam (com um falso nos testes da lane) vira o widget, as propriedades, as extended properties,
     as classes e o `Name` pedidos; tag substituída leva `ssam-tag-*`; botão de envio sem `type=submit`, com `IsDefault`.
  3. Todo atributo do IR vira propriedade nativa ou extended property; `id` → `Name`; referências de `aria-*` resolvidas.
  4. Cada efeito de 3.4 gera exatamente os nós da tabela; nenhum JS, JSON, `Visible`, `ForEach`; server action com uma
     chamada por screen action; SQL só nas formas portáveis.
  5. Coleção não mutada → entidade estática e aggregate; mutada → entidade comum sem AutoNumber, aggregates com filtro e
     ordem, `Ordenar<Lista>` com `ListSort` de atributo puro; popup com `ListIndexOf`.
  6. Reimportação: atualiza no lugar com as mesmas keys; mesma captura → `NO_CHANGE`; homônimo sem marca → `<Prefix><Nome>`
     sem recusa; nome pedido em `mapping.screens` colidindo → `PROTOTYPE_NAME_COLLISION` com todos os nomes.
  7. Mesmo IR em O11 e ODC (`Anvil.Tests.Odc`): mesmos widgets, `main` substituído no ODC, acesso anônimo de cada
     plataforma.
  8. **Desempenho:** expansão do IR da FarmaVirtual ≤ 3 s; aplicar o IR pelo construtor direto sobre a base do replay da 105
     (`Haiku_UI-20261010203638-cabaa3f0.oml`, cópia no TEMP privado) ≤ 15 s, medido no mesmo teste junto do op html da 105
     pelo caminho de hoje (referência ~70 s frio), os dois números na saída.
  9. Apply headless contra uma cópia de `Haiku_UI-20261010202559.oml`: 0 erros de Verify; `Render` devolve o DOM de cada
     estado explorado.
  10. `IAdvancedHtml` com evento `onclick` (`CreateEvent`/`ExtendedEvent`) passa no Verify e é lido de volta com o handler;
      se não passar, o teste prova o fallback `ILink` de 3.2.
  11. `PrototypeWidgetDefaults.cs` igual ao que o Model API instalado cria para cada tipo de widget (o teste cria um de cada
      numa cópia e compara propriedades e filhos padrão; diferença = falha com o diff).

### 7.3 Contrato C# compartilhado (`PrototypeContracts.cs`)

As lanes html, css e compile adicionam este arquivo **byte a byte igual** em
`kernel/src/Anvil.Core/Kernel/Prototype/PrototypeContracts.cs`; nenhuma o altera (mudança só pelo integrador):

```csharp
using System.Text.Json.Nodes;
using OutSystems.Model;
namespace Anvil.Core;

/// <summary>Seams between the prototype compiler lanes (docs/PROTOTIPO-NATIVO.md, section 7.3). The html lane owns the
/// element-to-widget map, the compile lane builds the module, the css lane composes the theme stylesheet and renders the
/// built model back to DOM for the fidelity measure.</summary>
public sealed record PrototypeCssRequest(
    JsonObject Capture,
    string BundleRoot,
    string Platform,
    string ModuleName,
    IReadOnlyDictionary<string, string> AssetUrls,
    IReadOnlyDictionary<string, string> IdClasses,
    IReadOnlyList<string> SubstitutedTags,
    IReadOnlyDictionary<string, WidgetNode> Roots);

public sealed record PrototypeCssResult(string StyleSheet, IReadOnlyDictionary<string, string> IconClasses, JsonObject Report);

/// <summary>One compiled widget: W is the Model API widget type, K the source node key of the capture, Children in order.
/// Attributes as [name, value] pairs; Expr/If/List carry the capture annotations unchanged.</summary>
public sealed record WidgetNode(
    string W,
    string? K,
    string? Tag,
    string? Style,
    IReadOnlyList<(string Name, string Value)> Attributes,
    string? Text,
    JsonNode? Expr,
    JsonNode? If,
    JsonNode? List,
    IReadOnlyList<WidgetNode> Children,
    IReadOnlyList<WidgetNode>? Else = null,
    string? Role = null);

/// <summary>One source element to map. Platform is "o11" or "odc".</summary>
public sealed record ElementRequest(
    string Platform,
    string Tag,
    IReadOnlyList<(string Name, string Value)> Attributes,
    bool Clickable,
    bool Icon,
    bool InsideForm,
    bool HasElementChildren);

/// <summary>The single element-to-widget decision shared by the html op and the prototype importer.</summary>
public sealed record ElementMapping(
    string Widget,
    string? Tag,
    string? Name,
    IReadOnlyList<(string Property, string Value)> Properties,
    IReadOnlyList<(string Name, string Value)> ExtendedProperties,
    IReadOnlyList<string> Classes,
    string? SubstitutedFrom,
    string? Problem);

/// <summary>Roots of the built module read back after the Verify: "shell", "v:&lt;view&gt;", "m:&lt;modal&gt;".</summary>
public sealed record PrototypeRenderRequest(
    JsonObject Capture,
    string Platform,
    IReadOnlyDictionary<string, IObjectSignature> Roots);

public static class PrototypeSeams
{
    public static Func<ElementRequest, ElementMapping>? Element { get; set; }
    public static Func<PrototypeCssRequest, PrototypeCssResult>? Css { get; set; }
    public static Func<PrototypeRenderRequest, JsonObject>? Render { get; set; }
    public static Func<JsonObject, int, IEnumerable<JsonObject>>? Preflight { get; set; }
}
```

- `Roots` do `PrototypeCssRequest`: chave = `shell`, `v:<view>`, `m:<modal>`; a lane css usa para decidir as reescritas 4.1
  itens 5 e 6. `Role = "wrapper"` para instância de bloco, placeholder e popup.
- Registro por `[System.Runtime.CompilerServices.ModuleInitializer]`: html registra `Element`; css registra `Css` e
  `Render`; compile registra `Preflight`. Nos testes de cada lane, os seams das outras são falsos injetados. Sem `Element`,
  `Css` ou `Render` registrado, a expansão recusa a si mesma com `PROTOTYPE_IR_INVALID` (`"<seam> missing"`); nunca segue com
  CSS cru ou sem medida.
- Costura da lane html em `JobPreflight.cs`, em `Analyze`, dentro do `try`, imediatamente antes de `if (kind == "logic")`:

```csharp
                if (kind == "prototype")
                {
                    if (PrototypeSeams.Preflight is { } analyzePrototype)
                        foreach (var problem in analyzePrototype(op, i)) problems.Add(problem);
                    continue;
                }
```

  (cada problema feito por `JobPreflight.Problem(...)` com ponteiro relativo a `/ops/<i>/data`). E em `Verbs.Collect.cs`,
  no `switch` de `relative`: `"logic" or "spec" or "screen" or "prototype" => at == null ? null : at + "/data",`.

### 7.4 Lane `css`: CSS verbatim, reescritas, ícones, runtime, escopo e leitura de volta

- Branch `fix/proto-css`, worktree `C:\Users\andre\SSAM-Hybrid-integracao-wt\proto-css`.
- **Arquivos:** novos em `kernel/src/Anvil.Core/Kernel/Prototype/`: `PrototypeContracts.cs` (7.3), `PrototypeCss.cs`
  (`Compose`, ordem do tema, `Register`), `PrototypeRewrites.cs` (lista fechada 4.1, especificidade preservada),
  `PrototypeIcons.cs` (máscaras, 3.5), `PrototypeAdapters.cs` (4.2), `RuntimeDomTable.cs` (DOM de runtime por plataforma,
  com o schema da etapa 0), `PrototypeRender.cs` (leitura de volta, tabela widget→DOM, avaliador de expressões e aggregates,
  4.4 passo 2); alterados `CssSource.cs` (4.3 item 1; serialização verbatim e contagem sem truncar), `CssCompat.cs`
  (`Imports` robusto em linha minificada; `HoistImports`), `ThemeCss.cs`, `PreflightRules/StyleSheetRules.cs`
  (`CSS_RULES_DROPPED`, `var(--x)` sem definição). Testes `kernel/tests/Anvil.Tests/PrototypeCssTests.cs`,
  `PrototypeRenderTests.cs`, `CssScopeTests.cs`, `StyleSheetLossTests.cs`.
- **Costura:** nenhuma fora dos arquivos acima.
- **Testes obrigatórios:**
  1. `styles.css` da FarmaVirtual → `StyleSheet` com todas as regras (mesma contagem), `@import` no topo, 1 reescrita de
     asset, `:root`/`*`/`body` intactos, nenhum prefixo de escopo, bytes iguais fora das reescritas registradas.
  2. Reescritas com especificidade igual à original: `dialog` → `:is(dialog, :where(.ssam-tag-dialog))` (0,0,1), `#modal` →
     (1,0,0), `span` com `:not(:where(…))` (0,0,1); `.brand span:last-child` não casa o ícone da marca; `main` reescrito só
     no ODC.
  3. 33 ícones → classes por nome; `ssam-icon-plus-w300` na marca; SVG percent-encoded válido; adaptadores e regras de UA
     emitidos uma vez, na ordem de 4.1.
  4. Wrapper transparente: com a linha do checkbox (`span` sem atributos), `.switch > input` vira a forma de 4.1 item 6 e casa
     o `input` dentro do `span`.
  5. `Render` sobre um módulo de teste lido de volta: DOM por estado com os wrappers da tabela; expressão fora do subconjunto
     → `unevaluable`; aggregate avaliado sobre a semente.
  6. Escopo: `main.app{}` sob `.app` não vira `.app main.app`; `*{}` cobre a raiz.
  7. Guarda de perda: o patch da chamada 88 (CSS sem a 1ª linha) → `CSS_RULES_DROPPED` com 271 regras; `var(--green)` sem
     definição → aviso com o nome.

### 7.5 Lane `html`: tabela elemento→widget única e correções do op html (seção 5)

- Branch `fix/proto-html`, worktree `C:\Users\andre\SSAM-Hybrid-integracao-wt\proto-html`.
- **Arquivos:** novo `kernel/src/Anvil.Core/Kernel/ElementWidgetMap.cs` (3.2: tabela, listas de tags por plataforma,
  substituições, regra do botão de envio, nomes por `id`; registra `PrototypeSeams.Element`) e
  `kernel/src/Anvil.Core/Kernel/Prototype/PrototypeContracts.cs` (7.3); alterados `HtmlExpander.cs`, `HtmlVisual.cs`,
  `HtmlSource.cs`, `HtmlComponents.cs`, `HtmlVisualVocabulary.json`, `HtmlDelta.cs` (H10, chave e adoção do marcador),
  `JobPreflight.cs` (H2, H15 e o bloco `prototype` de 7.3), `JobRunner.Diagnosis.cs`, `Verbs.Collect.cs` (H13 e o
  `or "prototype"`), a seção do op html em `kernel/AGENTS.md`. Testes `kernel/tests/Anvil.Tests/HtmlPageCollectAllTests.cs`,
  `ElementWidgetMapTests.cs` e acréscimos nos testes html existentes. Fixtures: o `data` do op html dos jobs `cc36c64b` (79),
  `0f7ceafe` (88) e `cfb79d98` (105) em `kernel/tests/Anvil.Tests/Fixtures/html-page/` (só o op html; sem o PNG).
- **Testes obrigatórios:** H1–H16 de 5, cada um com o caso citado; job 79 → uma recusa com as 9 causas (contagens da tabela
  2.2 de `an\html-compiler.md`) em < 1 s sem módulo; job 105 continua compilando igual (mesmos ops); `ElementWidgetMap`: uma
  linha por linha de 3.2 nas duas plataformas, listas congeladas iguais às reextraídas das DLLs instaladas (103 e 100);
  `InstallStylesheet` com `<dono>:<classe>` em duas telas → dois blocos; bloco legado `/* anvil:html <classe> */` adotado uma
  vez, sem cópia.

### 7.6 Lane `surface`: a chamada, descoberta, recibo, dados e CLI

- Branch `fix/proto-surface`, worktree `C:\Users\andre\SSAM-Hybrid-integracao-wt\proto-surface`.
- **Arquivos:** novos `platforms/odc/facade/prototype-op.mjs` (`expandPrototypeOps`, recusa única, `correctedJob`, recaptura
  silenciosa, degradação de 1.4.1, recibo) e `platforms/odc/facade/prototype-seed.mjs` (fase `seed`: Edit Data nativo nas
  entidades comuns vazias marcadas pelo importador; O11 pelo caminho do `o11_data`, ODC por `studio_data_insert`);
  alterados `o11-cycle.mjs` (`expandPrototypeOps` antes de gravar o job e do `buildBeforeApply`; fidelidade depois do build;
  seed depois do publish), `kernel-delivery.mjs` e `odc-build-phase.mjs` (ODC), `job-runner.mjs` (`ssam_job`/`o11_job`),
  `platforms/odc/facade/ssam.mjs` (job inline com op `prototype` no ODC; `owners`/`changes` padrão), `responses.mjs`,
  `refusal-codes.mjs` (`PROTOTYPE_*`), `next-steps.mjs` (links das telas), `catalog/fragments/B/routes.json` (rota
  `ui.prototype-import`), `discovery-capabilities.json`, `discovery-capabilities-o11.json`,
  `discovery-capabilities-shared.json`, `catalog/tools.json`, `guides/o11.md`, `guides/odc.md` (seção "Protótipo HTML →
  telas nativas"), o CLI `ssam prototype <pasta> --lane o11|odc --module <M> [--base <oml>] [--dry]` em `facade/ssam.mjs`.
  Testes `platforms/odc/facade/tests/prototype-op.test.mjs`, `prototype-seed.test.mjs`, `discovery-prototype.test.mjs` e os
  testes de catálogo de rotas completas.
- **Interfaces:**

```js
// platforms/odc/facade/prototype-op.mjs
export async function expandPrototypeOps(job, { work, capture = capturePrototype, now }) {}
// → { job }       (cada op prototype com data.capture e data.captureSha256; hash divergente → recaptura sem recusa)
// → { refusal }   (PROTOTYPE_*: todos os problemas de todos os ops, patch, correctedJob; nada chega ao Studio)
export function prototypeReceipt(kernelReport, { fidelity, phases, seed, degraded }) {}
// platforms/odc/facade/prototype-seed.mjs
export async function seedPrototypeData({ lane, module, receipt, bundle, authorize, write }) {}   // write injetável nos testes
```

- **Descoberta:** `ssam_discover {intent:"implementar o protótipo … pixel perfect"}` (e "importar protótipo", "html para
  telas", "prototype to screens") devolve na primeira resposta a chamada de 1.1 da lane certa (O11 ou ODC com `feature`,
  `owners`, `changes`), com caminho e módulo pelos slots, e as regras: não ler o protótipo, não converter à mão, uma chamada,
  as palavras do dono cobrem importar, publicar e carregar os dados de demonstração, o mapping só quando a recusa pedir.
- **Testes obrigatórios:**
  1. Job com op `prototype` sem `capture` → `capture` e `captureSha256` preenchidos (captura injetada).
  2. Captura com problemas → uma recusa com todos, `patch` e `correctedJob`; o build não é chamado.
  3. `captureSha256` divergente → recaptura sem recusar (`captureRefreshed`).
  4. Build com problema num `k` gerado → um rebuild sem o item, `degraded[]` no recibo; segundo fracasso →
     `VALIDATION_REFUSED` com `ssamDefect` e o patch `ignore`.
  5. Recibo: telas (com `renamedFrom`), popups, blocos, recursos, dados, eventos, fidelidade por estado, avisos do Verify,
     seed, contagens e `timings` (captura, expansão, build, Verify, fidelidade, merge, publish, seed).
  6. Seed: só entidades marcadas e vazias; linhas com as chaves do protótipo; sem `publish:true` não roda.
  7. Discover com as intents acima → `ui.prototype-import` com a chamada pronta das duas lanes; `tool-routes` completo; o
     exemplo ODC passa no schema de `studio_deliver` (`feature`, `owners`, `changes`; sem `until:"apply"`).
  8. CLI `--dry` contra uma base OML local roda captura, `anvil apply` headless e fidelidade e imprime o recibo.

## 8. Alvos de aceitação: FarmaVirtual em `Haiku_UI`

**Bases:** offline, uma cópia de `Haiku_UI-20261010202559.oml` (ensaio `--dry`, 9); ao vivo, o `Haiku_UI` publicado de
hoje, que já tem em `MainFlow` as telas do concorrente `FarmaVirtual`, `Carrinho`, `MeusPedidos`, `PedidoDetalhe`,
`GestaoProdutos`, `GestaoPedidos` (sem marca; o gerador do concorrente apagou as telas anteriores do flow) e o tema
`Haiku_UI` com `BaseTheme=null`. Ao vivo, as colisões recebem `<Prefix><Tela>` (`FarmaVirtualCarrinho`…) **sem recusa**; o
tema do módulo e as telas do concorrente não mudam.

### 8.1 Números

| Alvo | Valor |
|---|---|
| Telas criadas | **6**, no flow `FarmaVirtual`: `Catalogo` (vista padrão; tela padrão do módulo só com `home:true`), `Carrinho`, `MeusPedidos`, `PedidoDetalhe` (input `Id` Integer), `GestaoProdutos`, `GestaoPedidos`; ao vivo, as 5 últimas como `FarmaVirtual<Tela>` |
| Bloco compartilhado | **1** `FarmaVirtualShell` (raiz `#app`, demo-strip, header, nav, main com placeholder `Content`, footer, notificações), **6 instâncias**, inputs e eventos de 2.5 |
| Popups | **5 tipos**: `DetalhesDoProduto` e `EntreNaSuaConta` em Catalogo; `EditarProduto` e `NovoProduto` em GestaoProdutos; `AtualizarPedido` em GestaoPedidos e PedidoDetalhe (bloco + 2 popups) — **6 widgets `IPopup`** |
| Fidelidade | **Alvo depois da etapa 0** (tabela 4.2 promovida a evidência no publicado, 9.1): `score = 1.0`, **0** diferenças de seletor em **todos** os estados explorados (canônicos, valores de dimensão, modais) só com as equivalências documentadas, 922/922 no canônico, `runtimeUnverified` vazio. **Antes da etapa 0** a garantia não é 100% medido: é a construção (mesma estrutura de DOM, mesmas classes, CSS verbatim) com o `score` sub-1,0 honesto do recibo (ensaio offline **0,968** — 6598/6816, 18945/19080 seletores, 9.1) e `perState`/`runtimeUnverified` ainda com as linhas inferidas da tabela 4.2 |
| CSS | `css.verbatim = true`; todas as regras de `styles.css`; reescritas: 1 `asset-url`, 1 `import-hoist`, `#id`, `dialog`, ícones/`span`, wrappers; nenhum escopo |
| Ícones | 33 nomes, 118 instâncias em `span.ssam-icon`; 1 variante de traço (`plus` 3); o `+` da marca branco sobre verde |
| Imagem | 1 (`FarmaVirtualProducts`, bytes do original; aviso `ImageTooBig` mantido) |
| Dados | estáticas: `FarmaVirtualCategoria` (3), `FarmaVirtualStatusPedido` (4), `FarmaVirtualUsers` (3), opções de select; comuns com seed: `FarmaVirtualProduto` (8), `FarmaVirtualCarrinhoItem` (2), `FarmaVirtualPedido` (5), `FarmaVirtualPedidoItem` (8); 0 variáveis desenroladas; Client Variables só de dimensões globais |
| Eventos | todos os da tabela 8.2 compilados com o efeito indicado; `notCompiled` **vazio**; 0 actions vazias |
| Fluxo principal | adicionar ao carrinho atualiza o selo e a tela Carrinho; confirmar cria pedido e itens, baixa estoque, limpa o carrinho e abre `PedidoDetalhe` com o aviso de sucesso; cancelar devolve o estoque |
| Recusas | **0** |
| Bytes escritos pelo modelo | **≤ 1 KB** (a chamada) |
| Chamadas do modelo | **1** (mais as palavras de autorização) |
| Compilação SSAM | captura ≤ 5 s, expansão ≤ 3 s, build + Verify ≤ 30 s, fidelidade ≤ 5 s |
| Ponta a ponta com merge, publish e seed | **5–7 min** (orçamento somado ≈ 3,4 min, seção 6) |
| Padrões do dono | sem JS, sem JSON, sem `Visible`, sem `ForEach`, sem chamada de servidor em ciclo de vida, uma server action por screen action, nome e descrição em tudo; Verify sem erros |

### 8.2 Eventos esperados

| Evento | Tela | Efeito(s) |
|---|---|---|
| `#account-select` change | todas (bloco shell → evento `AccountSelectAlterada`) | `setDimension AccountSelect` (global) + `SuccessId = 0` e campos de entrega limpos; fora do catálogo, `AccountSelect = 3` → `navigate GestaoProdutos`, senão `navigate Catalogo` |
| `category` | Catalogo | `setDimension Category = Id` (tela); classe `active` e filtro do aggregate por predicado |
| `clear-filters` | Catalogo | `setDimension` de Category, busca, disponíveis e ordem para o inicial |
| `toggle-filters` | Catalogo | `setDimension FiltersOpen = not FiltersOpen` |
| `#catalog-search` input / `header-search` submit | todas (bloco shell) | `setDimension CatalogSearch` (global, `contains`); fora do catálogo `navigate Catalogo` |
| `#catalog-sort`, `#available-filter` | Catalogo | `setDimension`; `Ordenar<Lista>` (ListSort por valor) / filtro do aggregate |
| `product-detail` | Catalogo | `openPopup DetalhesDoProduto(Id)` com `ListIndexOf` |
| `quantity-product` | popup DetalhesDoProduto | `setDimension ProductQuantity` com `Max(1, Min(<max do input>, v + delta))` |
| `add` | Catalogo | Visitante → `openPopup EntreNaSuaConta`; cliente → `upsert CarrinhoItem (ProdutoId, UserId)` + `toast` (server action `AdicionarCarrinhoItem`) |
| `add-modal` | popup DetalhesDoProduto | como `add`, com a quantidade do popup, + `closePopup` |
| `login` | popup EntreNaSuaConta | `setDimension AccountSelect = Id` + `closePopup` |
| `quantity-cart`, input `data-cart-quantity` | Carrinho | `increment CarrinhoItem.Quantidade` com limites do input / `update` pelo valor do controle |
| `remove-cart` | Carrinho | `remove CarrinhoItem` + `toast` |
| `checkout-form` submit | Carrinho | `validate` (nome 3–120, endereço 10–500, observação ≤ 500, mensagens do `model.js`) → `insert Pedido` (campos ← controles, `UserId` ← AccountSelect, status 1, `CriadoEm` ← relógio, `Total` ← Σ Quantidade × Produto.Preco) + `insertFrom PedidoItem` (do carrinho do usuário ⋈ Produto) + `updateFrom Produto.Estoque −` + `removeWhere CarrinhoItem` do usuário + `setDimension SuccessId` ← chave inserida + `navigate PedidoDetalhe(Id)`; server action `CriarPedido` |
| `customer-status-filter` | MeusPedidos | `setDimension CustomerStatus = Id` |
| `dismiss-success` | PedidoDetalhe | `setDimension SuccessId = 0` |
| `#management-search`, `#management-category`, `#management-active` | GestaoProdutos | `setDimension` e filtro do aggregate |
| `new-product` / `edit-product` | GestaoProdutos | `openPopup NovoProduto` / `openPopup EditarProduto(Id)` |
| `product-form` submit | popups de produto | `validate` (restrições dos campos) → `update` (Id > 0) / `insert` (Id = 0) de Produto pelos campos `name` + `closePopup` + `toast` |
| `toggle-product` / `toggle-featured` | GestaoProdutos | `toggle Produto.Ativo` + `toast` / `toggle Produto.Destaque` |
| `admin-status-filter` | GestaoPedidos | `setDimension OrderStatus = Id` |
| `order-status` | GestaoPedidos, PedidoDetalhe | status final → `toast` de erro; senão `openPopup AtualizarPedido(Id)` |
| `status-form` submit | popup AtualizarPedido | `update Pedido.StatusPedidoId` + (novo status `= 4` → `updateFrom Produto.Estoque +` dos itens do pedido) + `closePopup` + `toast` |
| `#new-order-status` change | popup AtualizarPedido | `setDimension NewOrderStatus`; aviso de cancelamento e classe `danger` por predicado `= 4`; opções pela entidade de opções filtrada pelo status atual |
| `close-modal` | todos os popups | `closePopup` |
| clique no fundo do modal | — | `targetGuarded` → `outOfScope` (3.7) |

## 9. Integração

- Etapa 0 (4.2) antes de fechar as lanes css e compile.
- Ordem de merge na branch `integracao/prototipo-nativo` (de `cd7e4f11`): `html`, `css`, `compile`, `render`, `surface`.
  `PrototypeContracts.cs` chega igual por `html`, `css` e `compile`.
- Bateria: `Anvil.Tests` (com `ANVIL_STUDIO_DIR`), `Anvil.Tests.Odc`, `node --test` da fachada, e o ensaio offline
  `ssam prototype C:\Users\andre\GitSSAM\prototypes\farmavirtual --lane o11 --module Haiku_UI --base <cópia de Haiku_UI-20261010202559.oml> --dry`
  com os números de 8.1 (menos merge, publish e seed).
- Prova ao vivo (merge, publish, seed e conferência do DOM de runtime da tabela 4.2 no publicado): só o integrador, só com as
  palavras de autorização do dono, numa sessão própria. A ponte ODC não muda nesta entrega; se mudar, o nome fica na faixa
  v95–v99, uma vez, na integração.

### 9.1 Resultado da integração (2026-10-11, `feat/prototipo-nativo`)

**Costuras entre as lanes.**

- **Dialeto do IR.** A lane `render` escreve `ssam-prototype-capture/1` no dialeto dela; a lane `compile` lê o seu. O kernel
  normaliza na carga (`PrototypeDialect.Normalize`, chamado por `PrototypeCapture.Load` depois da conferência do hash, que
  continua sobre o arquivo cru): listas de snapshot viram coleções estáticas, entradas do shell viram `dimension`/`toast`/
  `View`/`record`/`from.sum`, controles de dimensão ganham `control`, registros de modal viram `{collection, key|new}`,
  nomes de lista e `sortBy`, dimensões por tela ou globais, efeitos no vocabulário do compilador (`agg`→`sum`,
  `insertFrom`, `removeWhere`, `validate` agrupado por controle), `attrExpr`/`classExpr`, alertas de validação, ícones por
  caso, estados explorados com a atribuição da vista e os parâmetros do modal. Coleção sem chave inteira (`key: "#"`) ganha
  `Id` por posição.
- **Fidelidade.** Equivalências novas da medida: popup relocado depois da região do gatilho (o `IPopup` nativo fica no fim
  da tela), atributos que nomeiam ids comparados pelos ids de runtime, `novalidate`/`disable-virtualization` como
  atributos de runtime, o `span` de runtime de `Expression`, e o placeholder do shell multi-página (`div[data-ssam-mount]`)
  transparente. A leitura de volta (`PrototypeRender`) avalia agregados com joins e `OnAfterFetch`, o ciclo de vida
  (`OnInitialize`/`OnParametersChanged` só com Assign), opções de dropdown e `MaxLength` depois de `Variable`.
- **Guarda de CSS em job remendado.** `--based-on <job anterior>` chega a `apply` dos dois CLIs (O11 e ODC) e à fachada
  (`job-runner`, `o11-cycle`): um job remendado que perdeu regras da folha recusa `CSS_RULES_DROPPED` (código de recusa
  na tabela de `refusal-codes.mjs`).
- **Processo frio.** O `apply` do protótipo roda com `DOTNET_TC_QuickJit=0` (17,5 s → 10,7 s no FarmaVirtual).
- **Recibo e atrito.** Degradações vão para `prototype.degraded` e para o friction store (`PROTOTYPE_DEGRADED`), com o
  journal por lane.

**Generalização (formas além do FarmaVirtual, `C:\t\proto-fixtures`).**

- Store em memória: um objeto global de listas (`window.Modelo = {clientes: [...], pedidos: [...]}`) é o store; cada
  snapshot o relê (`store.live`), e uma janela só é reaproveitada se ele não mudou. Listas aninhadas (`pedidos[].itens`)
  viram coleções filhas `<coleção><Campo>` com `<singular>Id` = chave do pai.
- A chave da coleção é o identificador da entidade em todo lugar (`numero`, `id`), nunca um `Id` fixo; entidade que
  referencia entidade comum deixa de ser estática.
- Shell no nível do `<body>`: `main#app` filho do body, com `header` e menu lateral como regiões (spa-hash e spa-sections);
  o menu que só troca `aria-current`/classe por rota não é mais a raiz do app nem aviso (`toast`). Em spa-sections a
  `section` fica como raiz da tela (`keepRoot`). Multi-página: regiões comuns toleram diferenças só de atributo (link ativo
  por página via input `View`) e a tela não repete as regiões do shell.
- `svg` inline monocromático (só `currentColor`/`none`) vira ícone com máscara (`ssam-icon-svg-<hash>`).
- Controle sem dimensão nem campo e rádio solto ficam como elemento HTML (`CONTROL_UNBOUND`, `RADIO_UNGROUPED` em
  `degraded`); `input type=email|tel` usa variável `Email`/`Phone Number`; `IsDefault` só dentro de form; `body` tem
  substituto `Container` (`ssam-tag-body`).
- Navegação para hash que não é vista (popup CSS `:target`) não gera Destination; evento cuja mudança de tela não cabe na
  classe fechada (lista só em variável do script) fica em `events.notCompiled` com o motivo, nunca some.

**Números do ensaio offline (`--dry`, sem Studio, base `Haiku_UI-20261010202559.oml`).**

| Protótipo | Forma | Telas | Popups | Eventos | Verify | Fidelidade | Seletores iguais |
|---|---|---|---|---|---|---|---|
| FarmaVirtual | spa-hash | 6 + shell (6 instâncias) | 5 tipos, 6 `IPopup` | 40/40 | válido, 0 erros, 54 avisos | 0,968 (6598/6816, 45 estados) | 18945/19080 |
| a-site-oficina | multi-page | 4 + shell | 1 | 3/3 | válido, 0 erros | 0,863 | 458/475 |
| b-secoes-condominio | spa-sections | 4 + shell | 2 | 3/3 | válido, 0 erros | 0,957 | 476/516 |
| c-spa-pedidos | spa-hash (shell no body) | 5 + shell | 1 | 8/10 (2 `notCompiled`) | válido, 0 erros | 0,882 | 1028/1104 |

**Lacunas conhecidas.** Inferência da leitura de volta ainda aproximada (ícone por item, classes de template de lista por
dimensão, estado vazio alternativo, atributo condicional `""` × ausente, `MaxLength` padrão 50, `required`, `selected` de
option); etapa 0 (tabela 4.2 no publicado) não feita, `runtimeUnverified` continua com as linhas inferidas; carrinho mantido
só em variável do script (c) não compila; `studio_deliver` (ODC) de job remendado não leva `--based-on` (esquema estrito do
servidor ODC); workers residentes não usam o JIT sem tier 0; prova ao vivo pendente.

## 10. Registro da revisão crítica (2026-10-10)

Obrigatórios:

| # | Ponto | Decisão | Onde |
|---|---|---|---|
| 1 | `dialog` não é tag válida do HTML Element | Aplicado: lista extraída das DLLs (103 O11, 100 ODC); `dialog` → `div.ssam-tag-dialog` com `open`; reescrita `:is(dialog, :where(.ssam-tag-dialog))`; regras de UA com `:where()`; `br`/`svg`/`template`/`slot` tratados; `main`/`data`/`picture` substituídos no ODC | 0.1, 3.2, 4.1 |
| 2 | ícone como `span` casa `.brand span:last-child` | Aplicado: `ssam-icon` nas classes; `span` → `span:not(:where(.ssam-icon, spans de runtime))`; `svg` com `:where()`; o diff de seletores pega qualquer ganho ou perda restante | 2.9, 3.2, 4.1, 4.4 |
| 3 | fidelidade era autodiff | Aplicado: leitura de volta do modelo depois do Verify, tabela widget→DOM com wrappers de runtime, diff de conjuntos de seletores, por estado explorado | 4.4 |
| 4 | DOM de runtime "a confirmar" | Aplicado: tabela congelada por evidência com as linhas já provadas; etapa 0 só leitura para as demais, antes de fechar css e compile; `Gap` e filhos padrão por `PrototypeWidgetDefaults` | 4.2, 3.2, 7.0 |
| 5 | rotas de admin não descobertas | Aplicado: ponto fixo estados × rotas com rotas de efeitos, README e literais | 2.3 |
| 6 | só funciona para roteador de hash | Aplicado: módulos ES por `vm.SourceTextModule`, CDN por cache endereçado por conteúdo, `fetch`/XHR locais servidos, `spa-path`, `spa-state` por esqueleto, handlers por closure e de framework, `innerText` e rAF | 2.1, 2.2, 2.3 |
| 7 | formulários não observáveis | Aplicado: perturbação determinística por controle, sentinelas por tipo e restrições, efeito `validate` | 2.6 |
| 8 | isolamento e orçamento das sondas | Aplicado com medida local: janela reaproveitada só quando limpa, nova nas demais (30/46 ms), variantes limitadas, pool de 8; orçamento ≤ 5 s derivado | 2.6, 0.1 |
| 9 | `tile-N` sem explicação | Aplicado: linhas `substr-after/before` (explica `tile-N`) e a regra do atributo extra para o que sobrar | 2.8 |
| 10 | fluxo principal morto | Aplicado: entidades comuns com seed por Edit Data, server actions, efeitos de conjunto por SQL parametrizado; `notCompiled` vazio na FarmaVirtual. A sugestão `ListAppendAll` sobre listas locais foi recusada: não persiste entre telas (Client Variables só têm tipos básicos, E2) | 3.4, 8.2 |
| 11 | tempo contradiz a evidência | Aplicado em parte, refutado em parte: construtor direto obrigatório com gate medido; a publicação medida é 12–28 s, não 120 s, então o total cabe em 5–7 min mesmo hoje numa máquina livre | 6 |

Recomendados:

| # | Decisão | Onde |
|---|---|---|
| 1 | Forma ODC corrigida (`feature`, `module`, `owners`, `changes`, job inline só pelo `ssam`, ensaio `preview`); proxy na lane surface | 1.1, 7.6 |
| 2 | `requestInterceptor` + dispatcher que rejeita; XHR substituído | 2.1 |
| 3 | Hash sem `timings`/`engine.node`/`source.root`; `TZ` fixo; `clock` pelo `mtime`; marca sem hash | 1.2, 1.6, 2.1 |
| 4 | Gravação sem `CodeFormat`, explícita; avisos do Verify no recibo | 4.1 |
| 5 | Donos únicos por arquivo e trecho | 7.0 |
| 6 | Tabela elemento→widget única (`ElementWidgetMap`, lane html) | 3.2, 7.3 |
| 7 | Adoção do marcador legado | 4.3 |
| 8 | Valores do shell como inputs do bloco | 2.5 |
| 9 | Popup com parâmetro: `ListIndexOf` ou aggregate + Refresh | 3.4 |
| 10 | Nunca `type=submit`; `IsDefault` + `ssam-submit` | 3.2, 4.1 |
| 11 | Listener com guarda de alvo não vira evento | 2.4 |
| 12 | Shell de multi-page por alinhamento; folhas por página no `StyleSheet` da tela; raiz da app emitida | 2.5, 2.9, 3.1 |
| 13 | Alinhamento por LCS com chave | 2.8 |
| 14 | Reimportação no lugar com as keys; marca só onde há `Description` | 1.6 |
| 15 | Bases da aceitação ditas; colisão → `<Prefix><Tela>` sem recusa | 1.6, 8 |
| 16 | Degradação determinística de erros de build/Verify | 1.4.1 |
| 17 | Hash divergente recaptura sem recusa; `PROTOTYPE_CAPTURE_STALE` removido | 1.4 |
| 18 | Pacote endereçado por conteúdo; o kernel nunca lê `source` | 2.9 |
| 19 | `@import` conferido na leitura de volta e na etapa 0; fallback `@font-face` inline | 4.1 |
| 20 | Fidelidade por estado; opções por relação inferidas (entidade de opções por chave), não congeladas | 2.8, 4.4 |
| 21 | Recusa de `data` com candidatos | 2.7 |
| 22 | `IList Mode = Custom`; evento do `IAdvancedHtml` provado no Verify com fallback | 3.2, 7.2 |

Decisão para o dono confirmar (não bloqueia as lanes): S2 é lido como "uma chamada de server action por screen action"; o
Refresh Data dos aggregates afetados depois da escrita é a atualização de dados da própria plataforma (D1) e não conta como
segunda chamada. Se o dono não aceitar, a alternativa é a server action devolver os valores mudados e a tela atribuí-los, ao
custo de mais estado na tela.
