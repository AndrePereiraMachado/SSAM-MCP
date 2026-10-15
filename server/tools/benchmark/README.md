# Bateria de velocidade SSAM

Este kit mede a execução de pedidos de biblioteca e empréstimos em O11 e ODC. O gerador e o analisador usam Node.js, sem dependências npm, sem LLM e sem acesso ao Studio. A rodada ao vivo é executada pelo operador em chats novos; gerar os pedidos ou analisar transcrições não executa a rodada.

## Preparar e executar uma rodada

Use um número de `01` a `99` para cada combinação de plataforma, cliente, modelo, esforço e política de subagentes. O destino é `BenchSSAM_<RR>_CS` em O11 e a library `BenchSSAM_<RR>` em ODC. Registre cliente, nome exato do modelo, esforço, data, rodada e política de subagentes junto aos resultados. Não reutilize um destino já medido para comparar outro modelo: a existência prévia das actions altera o trabalho.

1. Gere os pedidos. Execute S1 e depois S2 no destino da rodada, sem medir tempo. S1 cria dados; S2 cria `Library_CloseDay` com cerca de 150 linhas e multa diária de `0.50`. S1/S2 são sempre sem subagentes.
2. Execute C1, C2, C3 e C4 nessa ordem, **cada pedido em um chat/sessão novo**. Cole o arquivo integralmente, incluindo a primeira linha `[BenchSSAM ...]`. O mesmo destino é mantido dentro da rodada. C3 depende de `Loan_Checkout` criado em C1; C2 muda a multa de S2 para `0.75`.
3. Aguarde o término completo de cada pedido. Registre falhas e recusas; não substitua resultados ruins por novas tentativas silenciosas. Não há publicação nos pedidos. Cada action deve ser entregue sem erros e o operador pode validar comportamento antes de encerrar a rodada.
4. Analise as transcrições e compare tempo, volume, rodadas e aceites. Guarde os resultados fora das pastas de transcrição, que são somente leitura.

O modelo acrescenta `Name` como rótulo obrigatório às entidades transacionais para que todos os verbos `Exists` tenham a busca por campo único ou `Name` exigida pela bateria. `Fine.LoanId` é único para tornar a rotina diária idempotente. Como não existe `ReadyOn`, a expiração de reserva usa explicitamente `PlacedOn`. São decisões fixas da especificação, iguais para todas as rodadas; não devem ser reinterpretadas pelos modelos.

A matriz medida é **4 casos × 2 políticas de subagentes × 2 modelos (normal/rápido) × 2 plataformas = 32 execuções por cliente**. As oito combinações de plataforma/modelo/subagentes precisam de preparações próprias. Compare modelos mantendo cliente e esforço registrados; repita a matriz por cliente caso queira comparar Codex e Claude Code.

```powershell
$W='C:\Users\<user>\SSAM-Hybrid-integracao-wt\cx-bateria'
$N='C:\Users\<user>\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $N "$W\tools\benchmark\requests.mjs" --all --round 01 --out "$W\tools\benchmark\requests"
& $N "$W\tools\benchmark\requests.mjs" --lane o11 --case C3 --subagents yes --round 02
& $N "$W\tools\benchmark\requests.mjs" --lane odc --case S1 --subagents no --round 03
```

Os arquivos são `<lane>-<case>-<sub>.md` para casos medidos e `<lane>-S1.md` / `<lane>-S2.md` para preparação. **Há 20 arquivos:** `2 × (2 preparações + 4 casos × 2 variantes)`. O pedido original menciona 24, mas também exige S1/S2 sem variante de subagentes; essas condições não permitem 24 arquivos únicos. O kit segue a regra explícita de preparações sem variantes e não cria quatro duplicatas artificiais. A tag das preparações usa `subagents=no`, e `measured:false` está na especificação e no texto. `--tag BenchSSAM` identifica a família inteira, inclusive preparação; descarte S1/S2 ao calcular metas medidas.

## Localizar e analisar transcrições

Codex salva rollouts em `~\.codex\sessions\AAAA\MM\DD\` ou `archived_sessions`. Informe a pasta do dia para encontrar sessões principais e subagentes, inclusive no dia seguinte e nos arquivos arquivados. Claude Code salva sessões em `~\.claude\projects\<projeto>\`, com subagentes em `<sessão>\subagents\`. Só excertos sanitizados por `sanitize-fixture.mjs`, com a varredura do teste, podem entrar no repositório.

```powershell
$R='C:\Users\<user>\.ssam-hybrid\benchmark'
& $N "$W\tools\benchmark\analyze.mjs" --codex-dir 'C:\Users\<user>\.codex\sessions\2026\10\13' --tag BenchSSAM --md "$R\round-results.md" --json "$R\round-results.json"
& $N "$W\tools\benchmark\analyze.mjs" --claude 'C:\Users\<user>\.claude\projects\<projeto>\<sessão>.jsonl' --tag BenchSSAM --md "$R\claude-results.md"
& $N "$W\tools\benchmark\analyze.mjs" --codex '<rollout.jsonl>' --window 'C1=2026-10-13T14:00:00Z/2026-10-13T14:10:00Z' --json "$R\window-results.json"
```

Grave `--md`/`--json` sempre fora do repositório, como em `$R`: o `.gitignore` não cobre resultados dentro de `tools\benchmark`.

`--codex`, `--codex-dir`, `--claude`, `--claude-dir` e `--window` podem ser repetidos. Sem janela, o analisador identifica pedidos automaticamente. `--tag BenchSSAM` seleciona somente prompts cuja primeira linha começa com a tag. As horas de saída usam `-03:00`; os horários ISO das janelas podem especificar `Z` ou um deslocamento. Os caminhos entre `<...>` são exemplos que devem ser substituídos.

## Ler as métricas

| Campo | Interpretação |
|---|---|
| `id`, `client`, `model` | Identidade do pedido, cliente e modelo registrado na transcrição. |
| `case` | Caso da tag `[BenchSSAM ...]`, nome da janela ou `prompt:<hash>`. Substitui a antiga coluna `prompt` no Markdown. |
| `prompt` | Primeiros 120 caracteres do pedido. Só em memória: não vai para `--md` nem `--json` (ver “Fronteiras de persistência”). |
| `start`, `end`, `wallMin` | Início, fim e duração real em minutos. Turno Codex abortado é unido ao seguinte. |
| `toolSecSum` | Soma das durações chamada→resposta; chamadas paralelas podem sobrepor tempo. |
| `toolSecUnion` | Tempo coberto pela união dos intervalos das ferramentas, sem duplicar sobreposição. |
| `ssamSec` | Tempo somado de chamadas SSAM, inclusive dentro de code-mode ou shell reconhecido. Outro MCP não entra. |
| `modelPct` | `100 − 100 × toolSecSum / duração`; é o resíduo da soma, não uma medição de raciocínio. Pode ser negativo quando há muito paralelismo. |
| `writtenKB`, `readKB` | Bytes UTF-8 de entradas/saídas das ferramentas, divididos por 1024. Não são tokens nem o tamanho da prosa final. |
| `rounds` | Chamadas de ferramenta do principal. |
| `outputTokens` | Tokens de saída registrados pelo cliente; Codex usa diferença de contadores, Claude elimina usage duplicado por id de mensagem. |
| `subagents` | Detalhamento de cada subagente: nome, tempo, KB, rodadas e tokens. O caminho do arquivo fica só em memória. Histórico copiado do pai não conta. |
| `writtenKBTotal`, `roundsTotal` | Principal mais todos os subagentes atribuídos ao pedido. |
| `refusals`, `refusalsByCode` | Recusas estruturadas SSAM, seus horários, códigos e problemas. Texto que apenas menciona erro ou recusa não basta. |
| `accepted`, `acceptedAt` | Se houve recibo SSAM de entrega aceita e seu horário. Não equivale a validação funcional completa do app. |
| `refusedOrError` | Contagem de compatibilidade com o protótipo Claude: `is_error` ou marcador textual REFUSED/`"refused"`; não é a contagem estrita de recusas. |

Janelas explícitas são úteis quando uma autorização curta do usuário pertence ao pedido anterior, ou quando o experimento define um intervalo diferente da segmentação automática. O tempo de subagentes pode se sobrepor ao principal: não some `wallMin` para medir latência percebida. Compare `toolSecSum` e `toolSecUnion` para enxergar essa sobreposição.

## Metas

| Caso | Alvo |
|---|---|
| C1 — criar 1 action | < 1 min |
| C2 — alterar 1 linha em aproximadamente 150 | < 1 min (proposta; depende de confirmação do dono) |
| C3 — criar 20 actions | < 3 min |
| C4 — criar 100 actions | < 10 min |

O alvo de qualidade é aceitação na primeira entrega, **zero recusas**; quando houver erro, no máximo uma recusa única. Tempo baixo sem entrega aceita não atende ao alvo. S1 e S2 não entram nas metas.

## Verificar o kit

```powershell
& $N --test "$W\tools\benchmark\analyze.test.mjs" "$W\tools\benchmark\requests.test.mjs"
$env:BENCH_REAL_TRANSCRIPTS='1'
& $N --test "$W\tools\benchmark\analyze.test.mjs"
Remove-Item Env:\BENCH_REAL_TRANSCRIPTS
& $N --test "$W\tests\bench\*.test.mjs"
```

Os testes sintéticos são pequenos e neutros. O gate de transcrições reais só roda quando `BENCH_REAL_TRANSCRIPTS=1`, pula arquivos ausentes e nunca grava nas pastas de origem. Os resultados reais e desvios são documentados em `C:\t\codex\cx6\RESULTADO.md`, fora do repositório. Não há necessidade de build, instalação npm ou acesso às ferramentas SSAM para verificar este kit.

## Medir uma rodada e gravar no ledger

Uma análise serve para qualquer pasta, cliente, faixa e política de subagentes. O ledger contém uma linha por pedido, sem prosa do prompt, caminhos de usuário, hosts, e-mails ou URL do repositório. A versão vem do recibo `ssam_doctor`, depois de `--head` no analisador e finalmente do git da pasta registrado em `session_meta`, marcado `workspace-git`. O nome da pasta e o SHA-256 do prompt permitem relacionar rodadas.

```powershell
$benchmark='C:\Users\<user>\SSAM-Hybrid-integracao-wt\cx-medir-esperas'
& $N "$benchmark\tools\benchmark\speed-ledger.mjs" measure --workspace 'C:\Users\<user>\SSAM-Hybrid-proto' --since '2026-10-13T21:58:52-03:00' --ledger 'C:\Users\<user>\.ssam-hybrid\benchmark\speed-ledger.jsonl' --md 'C:\t\codex\cx10\rodada-noite.md'
$benchmark='C:\Users\<user>\SSAM-Hybrid-integracao-wt\cx-medir-esperas'
& $N "$benchmark\tools\benchmark\speed-ledger.mjs" compare --ledger 'C:\Users\<user>\.ssam-hybrid\benchmark\speed-ledger.jsonl' --case C1
$benchmark='C:\Users\<user>\SSAM-Hybrid-integracao-wt\cx-medir-esperas'
& $N "$benchmark\tools\benchmark\speed-ledger.mjs" cases --cases "$W\tools\benchmark\cases\owner-2026-10-13.json" --md 'C:\t\codex\cx10\casos-13-10.md'
```

Troque `--since` pela hora do primeiro teste. `--workspace` pode ser repetido. `--until` limita o intervalo; `--codex-home` e `--claude-home` permitem homes alternativos. Sem `--ledger`, `measure` apenas imprime a medição, salvo exportações explicitamente pedidas com `--md`/`--json`. A segunda execução acrescenta zero linhas existentes; `--replace` substitui a mesma chave. `analyze --turns` inclui cada requisição no JSON. As ferramentas validam todos os argumentos antes de medir.

| Campo novo | Origem e significado |
| --- | --- |
| `timeSplit` | Partição da parede: dono → partida a frio → SSAM → outras ferramentas → modelo → subagente → sem atribuição. A soma é a parede; as sobreposições são publicadas ao lado. Modelo tem intervalos registrados, sem usar resíduo. |
| `ssamCalls`, `ssamStages` | Duração MCP exata quando registrada, incluindo cessão do exec; soma principal e subagentes. Etapas somente quando a resposta traz tempos explícitos. |
| `waits` | `execYields` conta somente exec ainda rodando, `waitStillRunning` somente wait ainda rodando e `waitCalls` todos os wait. Nos 11 rollouts fixos: 213 = 81 + 132. Sondagens e entrada relida; chamadas acima de 28 s; partida a frio, rede e espera do dono. Codex marca partida a frio como `not-recorded`. |
| `context` | Totais de entrada/cache gravados. Quinze grupos calibrados, por ferramenta, esquemas, instrução do servidor, compactações e cortes. `ssamPct` porta `repFrac` e `pctSSAM` de estimativas.mjs: categorias `ssam:*` + arquivos AGENTS/CLAUDE, divididas pela entrada gravada. `ssamToolsPct` usa só `ssam:*`, com o mesmo denominador; no ledger aparece como `ssamToolsInputPct`. |
| `output` | Saída, raciocínio e texto visível. Claude usa o máximo por `message.id`; contador thinking gravado vence estimadores, ambos publicados quando disponíveis. |
| `lanes` | Faixa pelo argumento ou prefixo. Entregas, publicações separadas, recusas, incerteza, falhas, não classificados, primeira entrega e códigos. `InputValidationError` do cliente recebe `CLIENT_INPUT_INVALID` e refused; uncertain explícito precede recusa deduzida. Paradas parciais com ok:true, merged:false, publishInvoked:false e until:build/preview são staged; ficam separadas de aceites. |
| `repeats` | Subárvores de pelo menos 300 caracteres e respostas inteiras já vistas; `contractRequeries.sameContext` conta reconsultas no mesmo agente; `sameThread`, na raiz compartilhada por principal e filhos. Usa UUIDs inteiros, inclusive históricos anteriores à janela; leituras com assinatura idêntica no pedido. |
| `release` | Head e fonte registrados; nenhum Studio ou servidor é consultado. |

O `ssamSec` antigo continua medindo os wrappers da CX6; `timeSplit.ssamSec` mede a união efetiva no principal e `ssamCalls.secSum` soma chamadas de todos os agentes. `modelPct` antigo permanece o resíduo original. A primeira tabela Markdown mantém seu formato, exceto a troca de `prompt` por `case` declarada em “Fronteiras de persistência”. Duas correções declaradas: prompts injetados de AGENTS não são escolhidos como pedido e o aceite legado reconhece `entregue e publicado`.

`compare` exporta limiares em `REGRESSION_THRESHOLDS`: parede ou modelo acima de +10%, uma recusa adicional, certo de primeira passando de sim para não, ou composição SSAM aumentando pelo menos 5 pontos percentuais. Sem filtros de versão compara a primeira e última medição do caso/faixa; `--base` e `--head` selecionam heads explícitos.

```powershell
& $N --test "$W\tools\benchmark\*.test.mjs"
$env:BENCH_REAL_TRANSCRIPTS='1'
& $N --test --test-concurrency=1 "$W\tools\benchmark\*.test.mjs"
Remove-Item Env:\BENCH_REAL_TRANSCRIPTS
```

Execute testes reais um por vez na máquina. A categoria adicional `staged`, autorizada pelo dono, distingue as 14 paradas parciais ODC em build/preview, mantendo 23 entregas aceitas e zero não classificados na amostra de 98. O ledger e a segunda tabela mostram staged por faixa; arquivos antigos sem esse campo são lidos como zero. Outros formatos desconhecidos continuam sendo contados em unclassified.

O sanitizador remove `creator_user_id` e `creator_account_id`, inclusive em JSON aninhado; a varredura inclui `*.outsystems.app` e os marcadores de tenant da política. `sanitizeExcerpt(rows,{shrinkPaths:[...JSON pointers]})` admite reduzir texto não medido para `[shrunk]`; publica os caminhos em `shrunk` e rejeita redução de contadores, IDs, horários e evidências. O fixture compacted real mede apenas a compactação e os contadores preservados, sem inferir volume do texto encolhido.

### Correção da persistência e identidade Claude

Sanitizador e ledger usam a lista única `PRIVACY_MARKERS` de `privacy.mjs`, incluindo credenciais em texto livre, caminhos de usuário, tenants, IP:porta, Bearer e conteúdo cifrado. O preenchimento usa o ordinal de encontro de cada texto distinto, inclusive textos estruturais, sem hash do conteúdo. Em uma continuação humana, apenas a palavra CONT é mantida; tool_result nunca recebe essa exceção. O nome do workspace é `[user-home]` para uma raiz de home e o ledger recusa um segmento de usuário cru.

Para Claude, a raiz vem do arquivo principal ou da pasta da sessão dos filhos e cada contexto é agentId ou arquivo do subagente. Históricos sidechain copiados são deduplicados por tool_use.id e tool_result.tool_use_id dentro da sessão. W1 seleciona somente sessions[].file do relatório longas-1213; metadados de tamanho/mtime registrados são conferidos, com skip fonte mudou em divergência ou ausência do arquivo. Mesmo sem size/mtime no JSON, o mtime da fonte é comparado ao da saída gravada que ela alimentou: fonte posterior gera skip apenas nessa unidade/sessão. Um rollout novo na mesma pasta não amplia a seleção.

### Continuação, retomada e recusa completa

Na sanitização da continuação humana, ficam a palavra CONT e o caractere de fronteira seguinte; a pontuação continua não-palavra e o restante continua neutralizado. Isso preserva isCont, a espera do dono e o agrupamento dos pedidos.

Em transcrições Claude retomadas, a raiz é o stem do arquivo principal; nos arquivos `subagents/*.jsonl`, é o nome da pasta da sessão acima de `subagents`. O histórico com sessionId antigo continua no mesmo contexto de repetição. Os contextos permanecem separados por agentId ou arquivo do subagente; cópias inline são deduplicadas pelo identificador da chamada.

Caminhos de unidade e UNC usam path.win32. O workspace persiste só o último segmento; vazio permanece vazio, a raiz de home vira `[user-home]` e um segmento igual ao usuário fora da home vira `[user-segment]`. A guarda inclui hosts UNC e caminhos de usuário com barras invertidas.

O ledger valida o lote inteiro antes de escrever. Uma recusa reúne key, campo e rótulo de todos os problemas, sem valores; ledger, temporário e exportações ficam intactos quando há recusa. Os exemplos de privacidade nos testes são sintéticos; a home real só é obtida em runtime.

### Fonte principal, homes e reparo do ledger

A análise de produção encaminha o caminho do arquivo principal à medição de repetição. Assim, histórico S-old em S-new.jsonl compartilha a raiz S-new com S-new/subagents/*.jsonl; cópias inline não dobram consultas nem caracteres.

Raízes de home de qualquer usuário (unidade/Users, POSIX /home ou /Users, UNC Users/home/home$ e WSL) viram `[user-home]`, inclusive a home atual. Isso substitui o antigo `~` para a home atual e o nome/caminho de outras homes; projetos abaixo delas continuam sendo identificados pelo último segmento. A guarda também usa a origem cwd quando disponível para recusar um segmento cru de usuário vindo de raiz de home.

A atualização valida o índice após o merge. --replace pode corrigir uma linha histórica da mesma key; uma linha antiga inválida não substituída aparece na seção “linhas existentes” da recusa única. `speed-ledger repair --ledger X` mostra quantas linhas precisam de reparo e as keys/campos/rótulos, sem valores. Só `--confirm <n>` com a mesma contagem grava o reparo: valores inseguros são substituídos por `[redacted]`, chaves privadas são removidas e contadores irmãos permanecem. Nenhuma linha é apagada. Sempre revise a prévia antes de confirmar; se o arquivo mudar, revise novamente.

A fonte do gate muda quando seu mtime ou algum timestamp de linha JSONL é posterior à saída gravada. Restaurar o mtime depois de um append não contorna a verificação; só a fonte afetada é pulada.

### Fronteiras de persistência

Ledger, `--md` e `--json` são checados juntos, uma vez, antes de qualquer gravação, em `speed-ledger` (measure, cases, compare) e em `analyze`. Se algo for rotulado pela guarda de `privacy.mjs`, uma única recusa lista tudo e nada é gravado: nem ledger, nem temporário, nem exportação.

- `linhas existentes`: linhas do arquivo que esta execução deixa intactas (key, campo, rótulo).
- `linhas novas ou substituídas`: as linhas medidas nesta execução, com ou sem `--ledger`, como antes.
- `exportações`: `target=--md:<arquivo>` ou `target=--json:<arquivo>`, campo e rótulo. No Markdown, o campo é `linha-N/<coluna>`; no JSON, o caminho do campo.

A recusa nunca mostra valores, só o nome do arquivo de destino (sem a pasta). A dica “Reparo disponível” só aparece quando há linha existente suja, porque só aí o `repair` ajuda. Com `--replace`, uma linha nova limpa da mesma key substitui a antiga e a tira da seção `linhas existentes`.

**Mudança de formato das exportações (revisão 4).** `--json` grava só campos medidos: as chaves `file` (caminho do transcrito, do principal e dos subagentes) e `prompt` (texto do pedido) saem em qualquer profundidade. Os pedidos continuam identificados por `id`, `sessionId`, `case`, `tag`, `start` e `promptSha256`. No Markdown de `analyze`, a coluna `prompt` virou `case` e a tabela de subagentes perdeu a coluna `Arquivo`; a saída no console usa a mesma tabela. `cases --json` grava `request` com o mesmo recorte. Em memória, `file` e `prompt` continuam existindo. A guarda segue como rede de segurança sobre o que sobra: um nome de janela ou de caso com tenant, por exemplo, ainda recusa.
