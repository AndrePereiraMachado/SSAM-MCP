# Plano: o agente escreve uma vez e sai entregue

Escrito em 24/10/2026, reescrito no mesmo dia com três rupturas como eixo. Fontes, ambas só leitura: a fila de
fricção e os recibos do proto (11 a 24/10: 26.860 operações, 1.367 entregas lógicas, 981 recibos do kernel) e
os diagnósticos do `SSAM-Hybrid-batch-lab` (branch `lab/batch-speed`, 17 a 19/10, cerca de 40 ensaios).
Complementa `PLANO-EVOLUCAO-PRODUCTION-GRADE.md` e `docs/proofs/2026-10-20-meta-resolucao-friccoes.md`.

## 1. O que foi medido

### 1.1 Recusas (proto, 11 a 24/10)

| Medida | Valor |
|---|---:|
| `o11_deliver` recusada ou falha (sem continuações) | 47,3% (525 de 1.114) |
| `studio_deliver` idem | 70,0% (163 de 237) |
| Entregas aceitas na primeira tentativa | 60,3% |
| Tentativas por entrega aceita | 1,98; 84 cadeias com 4 ou mais |
| Pares consecutivos com o mesmo código de recusa | 152 |
| Reenvios com exatamente os mesmos problemas | 20 |
| Aceitação O11 por semana (11–16, 17–21, 22–24/10) | 56% → 47% → 50% |

Dos 154 recibos `PREFLIGHT_REFUSED`, só 31 são problema de texto. Cerca de **80% vêm do candidato já
construído** (a API nativa recusou uma op, ou o TrueChange achou erro): a recusa chega depois de 7 a 25 s
de build descartável, e cada fase só aparece quando a anterior passa. Essa cascata é a "recusa múltipla".

Problemas nos 235 recibos recusados (3.405 problemas, mediana 4 por recusa):

| Problema | Ocorrências | Fase | Detectável antes do build, com o digest? |
|---|---:|---|---|
| `ExpressionUnknownObject` | 853 | verify | sim: identificador fora do escopo |
| `FLOW_SYNTAX` | 505 | preflight | sim: separador, indentação, `~`, `else:` |
| `RequiredPropertyValue_Property` | 279 | verify | sim: Link/Button sem destino |
| `CHILD_NOT_FOUND` | 262 | apply | sim: filho inexistente no dono |
| `HTML_NAME_UNKNOWN` | 208 | apply | sim: block ou handler fora do catálogo |
| `LOGIC_INVALID`, `FLOW_NAME_UNKNOWN` | 200 | apply | sim: action chamada não existe |
| `HTML_TRADITIONAL` | 125 | apply | parcial: vocabulário |
| `APPLY_FAILED` | 116 | apply | sim na maior parte: `$alias`, nó proibido no tipo de action |
| `HTML_INVALID`, `PROPERTY_NOT_WRITABLE` | 154 | apply | sim: propriedade sem setter |

Guardas da fachada (voltam em menos de 1,5 s, mas custam uma rodada inteira do agente): `INPUT_INVALID` 29,
`WORDS_REQUIRED` 13, `PATCH_INVALID` 13, `BASED_ON_DELIVERED` 9, `PATCH_PATH_FORBIDDEN` 9. No lab,
`WORDS_REQUIRED` num patch apareceu em 7 de 40 ensaios.

Fricção nova de 22 e 23/10 (ODC): `MERGE_CONTENT_LOSS` 17, `MERGE_CONTENT_PREVIEW_REFUSED` 17,
`EQUIVALENCE_UNCERTAIN` 10; seis relatos apontam falso positivo do comparador e recusa sem diff.

### 1.2 Tempo

| Medida | Valor |
|---|---:|
| Entrega aceita, parede p50 (O11 / ODC) | 20,6 s / 44,0 s |
| Kernel, registered → complete, p50 / p90 | 8,5 s / 29,9 s |
| Fases do kernel acima de 5 s no p90 | reference-closure 22,7 s; merge 7,4 s; preflight 5,3 s; apply 5,4 s (a captura em si tem p90 de 1,4 s na bridge; o "snapshot 5,7 s" da primeira versão media a etapa seguinte, S14) |
| **Leituras nos 15 min antes de uma entrega aceita**, p50 / p90 | **18 / 45** |
| Entregas que precisaram de `continueTask` de 25 s | 24% (324); 72 min somados de espera do agente |
| Parede p50 O11 por semana | 15,9 s → 19,9 s → 32,9 s |

Lab, 100 actions por lote: parte nativa de 23 a 90 s; **preparação pela LLM de 56 a 543 s**; cada build
recusado custa 20 a 120 s. Dois ensaios em cerca de vinte bateram 120 s. O lab escreveu: "Mesmo que toda a
parte nativa fosse instantânea, a preparação já excederia a meta"; "27,4% dos bytes em guardas e 9,6% em
declarações". A linguagem compacta reduziu o texto entre 10% e 41%.

### 1.3 Leitura

Uma entrega comum custa hoje cerca de 22 rodadas do agente: 18 leituras, 2 tentativas, uma continuação a
cada quatro. Cada rodada carrega 10 a 20 s de modelo. O kernel pesa pouco. A ruptura é tirar rodadas, não
milissegundos: **3 a 4 rodadas por entrega**, com a ferramenta absorvendo tudo o que é determinístico.

## 2. As três rupturas

### R1 — A entrega corrige o que pode e só devolve pergunta

Contrato novo de `o11_deliver`, `studio_deliver` e `ssam_code write`: **nada determinístico volta ao agente**.

- Uma fase `scope`, antes do build nativo, resolve cada identificador de expressão, cada action chamada,
  cada nome de block e handler, cada propriedade de widget e cada filho de dono contra o índice do digest
  que `ssam_map` já produz. Caso inequívoco (só a capitalização difere, só falta o prefixo do módulo, o
  block existe no catálogo com outro qualificador, o `On Click` tem um destino único possível) é
  **normalizado e anotado**, não recusado. Caso ambíguo recusa em menos de 1 s com candidatos.
- Sintaxe do `ssam-flow/1` tolerante no parser do kernel: `assign X=v`, `Result=Action(...)`, vírgula sem
  espaço, declaração depois das regras, indentação de um espaço, navegação sem `()`; o que não normaliza
  recusa com o patch da linha.
- O loop de correção deixa de ter atrito próprio: a autorização da escrita original vale para patch,
  job parcial e `resume` da mesma cadeia; a recusa traz `patchByName` e aceita `fix:"apply"` (o servidor
  aplica os patches que ele mesmo propôs); uma correção que repete exatamente os problemas anteriores
  recebe uma resposta diferente (gramática, exemplo provado, linha recusada ao lado da aceita);
  `continueTask` ignora `action`/`lane`/`module` repetidos.
- O build nativo continua a última palavra, mas vira exceção, e a recusa que vier dele é medida à parte.

Meta: aceitas na primeira tentativa ≥ 90%; tentativas por entrega ≤ 1,15; recusa após build nativo ≤ 15%.

### R2 — Escrita incremental: o agente entrega enquanto escreve

`ssam_code` ganha um rascunho com id: `draft` abre, `part` acrescenta uma action, tela, entidade ou
documento (texto nas mesmas formas de hoje), `write {draft}` fecha e entrega. Cada parte é checada ao
chegar (parse, scope, e quando houver captura local, o `check` contra ela), e a resposta de `part` já traz
os problemas daquela parte com `fix`. O build do candidato começa em segundo plano quando o rascunho tem
partes válidas; o `write` final só faz o merge. Efeitos: o tempo de ferramenta sai do caminho crítico; o
erro aparece enquanto o contexto ainda está fresco, em vez de 80 KB depois; não há rascunho sem dono
(`taskId`, mesma autorização, expira).

Meta: numa jornada de 10 a 20 elementos, parede do `write` final ≤ 10 s; zero recusas depois do `write`.

### R3 — Módulo quente: a entrega é só o diff

O worker do kernel mantém, por chave de módulo, a captura e o modelo base carregados, com os índices
de nomes e tipos (o lab mediu: carga, sondagens e defaults de widget são a maior parte do tempo nativo;
171 sondagens → 2 e −15 s de defaults em lotes sem UI). Uma entrega sobre um módulo quente pula load,
reference-closure e sondagens; invalidação por hash da captura e por revisão da release, nunca por
conveniência. O recibo declara `hot:true/false` e o tempo poupado.

Meta: kernel registered → complete p50 ≤ 4 s; p90 ≤ 12 s; `reference-closure` fora do p90.

## 3. Frentes de apoio

- **R0 Medição**: a fila grava módulo, `taskId`, `basedOn.job` e job gerado de cada entrega e distingue
  `ssam_code`; `ssam_friction {view:"delivery-kpi"}` publica as sete linhas da tabela de metas por lane e
  semana. Sem isso a cadeia é inferida.
- **R4 Pacote que basta**: `ssam_discover {packet:true}` traz o índice de escopo, os `basedOn` exatos de
  cada elemento citado (rotulados: textSha do flow, `k` do HTML, hash da captura), a gramática da parte e
  o exemplo provado mais próximo; `ssam_map` nunca recusa seco (`ELEMENT_NOT_FOUND` com candidatos,
  `BUDGET_TOO_SMALL` com a página que cabe). Meta: leituras antes de entregar p50 ≤ 5.
- **R5 Do lab, só correção e parser**: resolução de calls pelo dono em `Verbs.Flow.cs` (chamada homônima
  apontava para outro dono, em silêncio), conectores e ordem do Switch em `FlowDiff`, vírgula em
  `FlowParse`, `LogicLint` sobre a forma texto, job parcial por chave nativa. Fora: `ssam-rules`,
  commands, workflows, features, `batch-source`, identidade em Description, `prototype/*`, configs locais.
- **R6 Prova de conteúdo do merge (ODC e O11)**: identidade canônica de assinaturas importadas e de
  placeholders de block antes de comparar; a recusa traz o diff dos primeiros 20 elementos.
- **Hand-off de 25 s**: o primeiro `deliver` espera até o limite do cliente (50 s por padrão no Claude Code);
  com p90 de 57 s, a maioria termina numa chamada. Tira cerca de 300 rodadas no volume do período.

## 4. Metas

| KPI | Hoje | Meta |
|---|---:|---:|
| Aceitas na primeira tentativa | 60% | ≥ 90% |
| Tentativas por entrega aceita | 1,98 | ≤ 1,15 |
| Pares consecutivos com o mesmo código | 152 | ~0 |
| Leituras antes de uma entrega (p50 / p90) | 18 / 45 | ≤ 5 / 12 |
| Entregas com continuação de 25 s | 24% | ≤ 5% |
| Parede p50 da entrega aceita O11 / ODC | 20,6 / 44 s | ≤ 10 / 20 s |
| Recusa que chega depois de build nativo | ~80% | ≤ 15% |
| Kernel registered → complete p50 | 8,5 s | ≤ 4 s |

## 5. Execução em paralelo: oito sessões, uma integradora

Cada frente roda numa sessão própria (Opus 5.5, worktree próprio cortado de `prova/proto`), com arquivos
donos disjuntos. A sessão integradora (esta) reconcilia, roda as suítes completas e mede o KPI. Nenhuma
sessão usa o Studio ao vivo nem a pasta proto; provas nativas são headless com as DLLs do Service Studio.

| Sessão | Frente | Arquivos donos (só estes) |
|---|---|---|
| `kpi-fila` | R0 | `facade/friction-*.mjs`, `facade/launch.mjs` (registro de `ssam_friction`), `tests/friction*.test.mjs` |
| `escopo-kernel` | R1 kernel | `kernel/src/Anvil.Core/Kernel/Preflight/**`, `kernel/src/Anvil.Core/Kernel/PreflightRules/**`, `JobPreflight.cs`, testes `kernel/tests/Anvil.Tests/Scope*` |
| `loop-correcao` | R1 fachada | `platforms/odc/facade/o11-cycle.mjs`, `job-patch.mjs`, `authorization-context.mjs`, `continuations.mjs`, `tool-input.mjs`, o deliver ODC, gancho mínimo em `ssam-code.mjs` |
| `modulo-quente` | R3 | `ModelHost*.cs`, `BaseModelCache.cs`, `JobRunner.cs`, `StudioBornValues.cs`, `NativePerformanceCapture.cs`, `KernelSnapshotReading.cs`, worker do CLI, `o11-build-phase.mjs`, `o11-capture-store.mjs`, `odc-build-phase.mjs` |
| `lab-correcao` | R5 + parser tolerante | `Verbs.Flow.cs`, `FlowDiff*.cs`, `FlowParse.cs`, `FlowText.cs`, `FlowExtract.cs`, `LogicLint.cs`, `ModuleFlow.cs`, `kernel/tests/Shared/Flow*` |
| `escrita-incremental` | R2 | novo `platforms/odc/facade/code-draft.mjs` e testes; gancho mínimo em `ssam-code.mjs`; `catalog/tools.json` |
| `pacote-que-basta` | R4 | `work-packet.mjs`, `text-packet.mjs`, `discovery.mjs`, `module-map.mjs`, testes |
| `prova-merge` | R6 | `MergeContentProof.cs`, comparador em `Anvil.Core.Odc`, `kernel-delivery.mjs`, `refusal-codes.mjs`, testes ODC |

Ordem de integração: `lab-correcao` e `escopo-kernel` primeiro (base do kernel), depois `modulo-quente`,
`prova-merge`, `loop-correcao`, `pacote-que-basta`, `escrita-incremental`, `kpi-fila` (lê tudo). Suíte O11
completa (~2h16) e ODC (>1h) uma vez por lote integrado, sequenciais, antes de ativar a CLI.

## 6. Como se prova

- `ssam_friction {view:"delivery-kpi"}` semanal contra a tabela acima.
- Bench a frio offline com os corpora do lab que passaram (Portuário, Naval 2º) e dois que falharam por
  recusa (Hx, Museus): `ssam_code check` contra captura local, tempo e problemas por fase, em `pnpm test`.
- Uma jornada viva de 10 a 20 elementos no módulo de teste por lote integrado, do `ssam_discover` ao
  `delivered`, contada em rodadas do agente e em segundos. A ruptura está provada quando a jornada fecha em
  3 ou 4 rodadas e nenhuma recusa chega depois do build nativo.

## 7. O que não se promete

A velocidade com que a LLM escreve e pensa regras de negócio não muda por este plano. Lotes de 100 actions
continuam limitados pela autoria (o lab mediu); o alvo é a entrega comum de 1 a 20 elementos, onde o ganho
é de rodadas (22 → 3 ou 4). Módulos com produtores não capturados caem no build nativo como hoje. A regra
de escopo nunca inventa nome: resolve de forma inequívoca ou recusa com candidatos.

## 8. Estado da integração (24/10/2026, branch `integracao/primeira-certa`)

As oito frentes entregaram no mesmo dia; a integradora reconciliou os branches no worktree `SSAM-Hybrid-integra`.
Números abaixo são os reportados por cada sessão e conferidos pela integradora com os filtros de teste no lote integrado;
nada foi provado ao vivo no Studio ainda, e as suítes completas do kernel rodam depois do último merge.

| Frente | O que entrou | Prova no lote integrado |
|---|---|---|
| R0 medição | fila grava módulo, taskId, basedOn e problemas por fase de cada entrega; `ssam_friction {view:"delivery-kpi"}`; linha de base oficial em `docs/proofs/2026-10-24-delivery-kpi-baseline.md` | 8 testes novos; na fila real reproduz 1.367 entregas, 1,98 tentativas, 18/45 leituras, 20,6/44 s |
| R1 kernel (scope) | fase `scope` antes do primeiro op: CALL_UNKNOWN, SCOPE_UNKNOWN_IDENTIFIER, HTML_NAME_RESOLVED, WIDGET_REQUIRED_PROPERTY, WIDGET_PROPERTY_VOCABULARY, OWNER_CHILD_EXISTS, ACTION_KIND_NODE, SCOPE_BLOCKED_BY_REFUSED_OP; recusa única preflight+base+scope | corpus real: 81,3% dos problemas de apply/Verify pegos antes do build, 0 falso positivo em 30 jobs aceitos; filtros O11 507/511 (2 preexistentes, 2 testes de contrato adaptados), ODC 9/9 |
| R1 fachada | autorização herdada na cadeia, `fix:"apply"` nas duas lanes, `patchByName` consertado, guarda de reenvio igual, `continueTask` tolerante, prazo por ferramenta (escritas 50 s) | teste ponta a ponta: escrita → recusa → `fix:"apply"` sem `authorize` → delivered em duas chamadas; 333/334 |
| R2 escrita incremental | `ssam_code draft/part/write`: parte checada ao chegar, `write` com uma entrega, contrato completo em `ssam_reference` | 9 testes (reconexão, TTL, dono, pré-construção) |
| R3 módulo quente | spare por sha256 do modelo, inventário de referências sem recarga, `hot` no recibo, defaults de widget só em job com UI, sondagens em lote | segunda entrega de um módulo O11 de cliente, 3 actions 6,7 s → 3,7 s (−46%); reference-closure 1,6 s → 11 ms; lotes de 100 actions −12% |
| R4 pacote | `scope` no packet, `basedOn` rotulados com valores reais, `needsReading`, `ssam_map` com candidatos e `corrected`, nunca `BUDGET_TOO_SMALL` seco | 10 intenções respondem nomes e basedOn sem outra chamada; a 8 KB o packet antigo vinha quase só com cortes |
| R5 lab + parser | calls resolvidas pelo dono, conectores desligados antes de religar, ordem do Switch, LogicLint no texto, 13 normalizações do `ssam-flow/1` | corpus de 1.069 `FLOW_SYNTAX`: 852 aceitas, 93 com patch, 81 com a forma ao lado, 37 secas; filtros O11 422/422, ODC 161/161 |
| R6 prova de merge | identidade canônica das chaves que o merge reatribui; recusa com `differences` e `summary`; `EQUIVALENCE_UNCERTAIN` explica cada divergência | 18 pares reais recusados em 22–23/10 passam a ser aceitos; perda real continua recusada; ODC 13/13, O11 72/72 |

Da integradora: listagens compactas re-revisadas (`o11_deliver`, `studio_deliver`, `ssam_code`, `ssam_friction`) com tetos medidos
(168.301 B servidos; núcleo fixo 34.351 B), respostas ODC com `fixCall`/`fixesApplied`/diff, documentação em `kernel/AGENTS.md`
e `docs/TEXTO-LOGICA.md`. Pendentes antes de ativar: `PACKET_DEFAULT_BYTES` 24 KB (R4), verbo `content-proof` no CLI ODC (R6),
suítes completas O11 e ODC, prova viva de 10 a 20 elementos e o KPI da semana seguinte contra a linha de base.

Lote 3 (24/10, noite): sondagens nativas num processo (primeira descoberta após release do kernel 44 s → 2,2 s), spare após o
merge e pré-aquecimento dos módulos abertos (leitura pós-merge 7,5 s → 0,15 s; primeira leitura após subir o worker 7,2 s →
0,3 s), scope ODC para recusas determinísticas e restos de `HTML_EDIT_NOT_APPLIED` (em curso). Decisões da S14: Verify da base
não vale (1 ms nos recibos reais); captura do Studio só medida (p90 1,4 s na bridge).
