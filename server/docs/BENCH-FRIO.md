# Bench a frio offline (R8)

A seção 6 do `PLANO-PRIMEIRA-CERTA-E-VELOCIDADE-2026-10-24.md` pede que os corpora do laboratório virem um teste
repetível: `ssam_code {action:"check"}` contra uma captura local, sem Studio, medindo tempo e problemas por fase.
Este documento traz os números da rodada de 24/10/2026 (branch `integracao/primeira-certa`, commit `e2d137e9`),
como repetir e o que o bench não prova.

- Teste: `platforms/odc/facade/tests/bench-frio.test.mjs`. Medição: `platforms/odc/facade/bench-frio.mjs` (não é
  ferramenta MCP; só compõe a chamada e mede por fora).
- Corpora: `platforms/odc/facade/tests/fixtures/bench-frio/`, com a origem de cada um no lab no `README.md` da pasta.
- Captura: `kernel/tests/fixtures/blank-service.oml` (O11) e `kernel/tests/fixtures/odc/blank-mobile.oml` (ODC, o
  módulo vazio de `Anvil.Tests.Odc`).
- Kernel: as CLIs locais do worktree (`kernel/.local/cli/anvil.dll`, `kernel/.local/lane-odc/cli/anvil-odc.dll`), um
  processo frio por check (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`), sem módulo quente.

## Números desta rodada

Uma máquina, um check por vez (`node --test` só deste arquivo). "Fachada" é a parede da chamada `codeCheck` inteira;
"Kernel (processo)" é a parede do processo `dotnet anvil apply`; "Kernel total / scope" são `timings.totalMs` e
`timings.scopeMs` do recibo do kernel, que só vêm quando o job é aceito. Problemas na ordem
input / preflight / base / scope / apply / verify. Normalizações: só as reescritas do texto pelo kernel (regras em
maiúsculas); as notas da fachada sobre como leu os arquivos (`files`, `logic-split`, `parts-order`) ficam fora.

| Corpus | Lane | Bytes | Entidades / actions | Fachada (parede) | Kernel (processo) | Kernel total / scope | Problemas input / preflight / base / scope / apply / verify | Normalizações do kernel | Veredito |
|---|---|---:|---|---:|---:|---:|---|---|---|
| Portuário, 100 actions | o11 | 216.084 | 10 / 100 | 21,0 s | 20,9 s | 17,9 s / 139 ms | 0 / 0 / 0 / 0 / 0 / 0 | — | aceito sem problema |
| Naval 2º corpus, 100 actions | o11 | 265.107 | 120 / 100 | 28,3 s | 28,2 s | 24,7 s / 389 ms | 0 / 0 / 0 / 0 / 0 / 0 | — | aceito sem problema |
| Hx logística, 100 actions | o11 | 116.294 | 11 / 100 | 24,1 s | 24,0 s | 20,3 s / 196 ms | 0 / 0 / 0 / 0 / 0 / 0 | FLOW_ASSIGN_SPACING 133 | aceito com normalizações |
| Museus, 100 entidades | o11 | 80.049 | 105 / 0 | 14,0 s | 13,8 s | — / — | 0 / 0 / 0 / 0 / 3 / 0 | — | recusado no build (DDL_NOT_CONVERGED) |
| Museus, 100 entidades | odc | 80.049 | 105 / 0 | 13,2 s | 13,1 s | — / — | 0 / 0 / 0 / 0 / 3 / 0 | — | recusado no build (DDL_NOT_CONVERGED) |

Uma rodada anterior, no mesmo dia e na mesma máquina, deu 18,6 / 21,9 / 18,7 s para Portuário / Naval / Hx e 11,0 / 14,3 s
para o Museus O11 / ODC, com os mesmos vereditos e as mesmas contagens.

Índice de descoberta: a orientação que acompanha uma recusa (`job-guidance.mjs`) lê o índice de descoberta da lane. Frio,
ele custa cerca de 45 a 50 s na primeira recusa depois de uma release (medido: ODC 45,1 s; O11 cerca de 50 s, que na
primeira rodada caíram em cima do Museus e fizeram a fachada marcar 62,0 s contra 11,6 s de kernel). O bench constrói o
índice antes dos corpora (`warmDiscoveryIndex`) e o reporta à parte, para nenhum corpus pagar por sua posição na fila.

### O que a rodada mostra

- **Hx, recusado no lab, agora é aceito.** As 133 linhas `assign X=v` que derrubaram o build nativo em 18/10 viram
  `assign X = v` pelo parser tolerante da R5 (`FLOW_ASSIGN_SPACING` 133, exatamente a contagem do lab). O teste exige
  essa contagem.
- **Portuário e Naval 2º continuam aceitos de primeira**, sem nenhuma reescrita do kernel.
- **A fase scope da R1 roda em todos** e não acusou nada nesses textos: 117 a 389 ms (`timings.scopeMs`, nas duas
  rodadas) para 100 actions, 0 problema de scope. Nenhum dos três tinha os erros que ela pega (identificador fora do escopo, action
  inexistente, widget); o que ela prova aqui é custo baixo e zero falso positivo em 300 actions aceitas.
- **Museus, 100 entidades, é recusado no build nas duas lanes**: `DDL_NOT_CONVERGED` em
  `MxRights`, `MxObjectAlias` e `MxLabAnalysis` ("the module keeps another value after two rounds (set LabelPlural =
  "Mx Rightses")"). O mesmo texto foi entregue no lab em 19/10, e o mesmo texto contra a base do lab
  (`FarmaSpeed_UI`, cópia de `attempt-0/base.oml` do recibo `e649fede…`) recusa igual: é o kernel, não a captura.
  Causa: `DataDdl.Pluralize` deriva o plural em inglês ("Rightses", "Analysises"), o módulo guarda o plural da
  plataforma, e o laço de convergência de `Verbs.Ddl.cs` tenta escrever o derivado duas vezes. O lab corrigiu isso em
  `Verbs.Ddl.cs` (plural omitido de entidade nova segue a plataforma, nota `DDL_NATIVE_PLURAL`); essa correção não foi
  integrada (a R5 levou do lab só calls, FlowDiff, FlowParse, LogicLint e job parcial). Até ela entrar, os dois
  subtestes do Museus são `todo` com essa razão: rodam e medem, a falha aparece como TODO e não derruba o `pnpm test`.
- **Tempo.** 100 actions: 18,6 a 28,3 s de parede nas duas rodadas, quase tudo kernel (a fachada acrescenta 35 a 150 ms).
  Dentro do kernel o apply do job domina (12,4 a 21,4 s de `applyMs`); load, normalização, checagem de base e scope
  somam 1 a 3 s, e a gravação do candidato 1,2 a 2,2 s.

## Vereditos e limites declarados no teste

| Corpus | Lanes | Esperado hoje | Limite (fachada + kernel) |
|---|---|---|---:|
| Portuário | o11 | aceito, com ou sem normalizações | 60 s |
| Naval 2º | o11 | aceito, com ou sem normalizações | 60 s |
| Hx | o11 | aceito com normalizações (`FLOW_ASSIGN_SPACING` 133) ou recusado antes do build | 60 s |
| Museus 100 entidades | o11, odc | aceito, ou recusado antes do build (hoje `todo`: DDL_NATIVE_PLURAL pendente) | 40 s |

Os limites são duas a três vezes o medido: uma máquina com metade da velocidade passa, com alguma folga para o
`pnpm test`, que roda os arquivos em processos paralelos; um check três vezes mais lento falha. `SSAM_BENCH_LIMIT_FACTOR`
multiplica todos os limites numa máquina mais lenta. Recusa no build (apply, verify) falha o teste com os problemas.

Os três corpora de 100 actions só rodam na O11: foram escritos para um módulo O11 (server actions `public`, referências a
`User` com a regra de exclusão padrão Protect), e um app ODC recusa as duas coisas por regra. No ODC eles mediriam a lane,
não o corpus; o teste os pula com esse motivo. O Museus (só DDL, sem `User`) é neutro e roda nas duas.

## Como repetir

1. Prepare o worktree (compila as CLIs locais):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-dev.ps1 -Yes -NoUserEnv -SkipMcp -SkipDoctor`.
2. Da raiz: `node --test 'platforms/odc/facade/tests/bench-frio*.test.mjs'` (glob entre aspas). Sem a CLI de uma lane, os
   testes daquela lane pulam com o motivo. Outras CLIs: `SSAM_BENCH_CLI_O11`, `SSAM_BENCH_CLI_ODC`.
3. Cada linha sai como `t.diagnostic` (JSON) e a rodada grava `.local/bench-frio/last.json` e `.local/bench-frio/last.md`
   (a tabela acima, pronta para colar aqui).

Um novo corpus: uma pasta em `tests/fixtures/bench-frio/` com `ops.json`, `dados.ddl` e/ou `logica.flow`, uma linha no
`README.md` da pasta com a origem, uma entrada em `CORPORA` (`bench-frio.mjs`) e o limite e o veredito esperado no teste.

## O que o bench não prova

- **Nem merge nem Studio.** O check constrói o candidato headless e para: não há merge nativo, `check-base`, prova de
  conteúdo do merge (R6), publicação ou Studio aberto. Uma entrega real ainda pode recusar nessas etapas.
- **Nem a autoria da LLM.** Os textos são os que o lab já escreveu; o bench não mede o tempo de escrever nem de corrigir
  (no lab, a preparação levou de 56 a 543 s por 100 actions, contra 19 a 28 s de check aqui).
- **Nem o módulo quente (R3) nem o worker.** Cada check é um processo frio contra um módulo vazio; um módulo real, com
  produtores e milhares de elementos, carrega mais e pode cair em regras que um módulo vazio não exercita.
- **Fora do bench, o `check` pelo worker (S9)** reaproveita o módulo quente e traz `timings {via, hot}`; é o caminho de produção quando o worker da lane está de pé. O bench continua frio por desenho.
- **Nem ODC para os corpora O11.** Só o Museus rodou nas duas lanes.
- **Nem execução.** Nenhuma action rodou com dados; aceito quer dizer que o kernel e o Verify headless aceitaram o modelo.
- **Nem estabilidade de tempo.** Uma máquina, poucas rodadas; entre duas rodadas os tempos variaram até 20%.

## Lacunas encontradas (para a integradora)

- O check não expõe o tempo do kernel numa recusa: `timings` só vem no recibo de um job aceito, e a resposta do check
  traz `wallMs` só do `runJob` e nenhum `phases` com tempos. O bench mede por fora (relógio em volta do processo e
  `elapsedMs` do envelope).
- No ODC, o que recusa os corpora O11 é determinístico e pode ser pego antes do build, mas chega como fase `apply`:
  `APPLY_FAILED` "IServerAction ... ODC apps do not expose public server actions" (o op `set Public`) e
  `ODC_DELETE_RULE_FORCED` (FK para `User` com Protect), este último com `refusalCode` `PREFLIGHT_REFUSED`/`DDL_REFUSED`
  mas `phase:"apply"` e `verifyRan:true`.
- A primeira recusa depois de uma release paga o índice de descoberta frio (45 a 50 s) dentro da resposta do check.
