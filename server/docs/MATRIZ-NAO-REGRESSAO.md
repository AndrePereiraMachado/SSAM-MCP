# Matriz de não regressão e portão de ativação

Para quem integra e ativa lotes do SSAM. O dono exige que nenhuma funcionalidade regrida. Este documento diz, para cada
funcionalidade, plataforma e operação, o que a prova hoje e com que força. Também diz como rodar o portão que compara
as suítes com uma lista versionada de falhas conhecidas antes de qualquer ativação.

- Fonte da matriz: [`scripts/gate/matrix.json`](../scripts/gate/matrix.json). A seção "Matriz" abaixo é gerada dela.
- Portão: [`scripts/gate/run-gate.mjs`](../scripts/gate/run-gate.mjs). Lista de falhas conhecidas: [`scripts/gate/known-failures.json`](../scripts/gate/known-failures.json).
- Testes do próprio portão e da matriz: [`tests/gate.test.mjs`](../tests/gate.test.mjs). Ele roda com a fachada e falha se a matriz citar
  uma classe, um teste ou um job que não existe mais, ou se a seção gerada estiver desatualizada.

## 1. O portão

### Ordem

1. `build`: `scripts/setup-dev.ps1 -Yes -NoUserEnv -SkipMcp -SkipDoctor`. Cada linha "Build: ..." do resumo é um teste. Pega componente que não compila,
   como o builder ODC, que nenhuma suíte compila.
2. `o11`: `dotnet test kernel/tests/Anvil.Tests -c Release -p:SSDir=<Service Studio>` com trx.
3. `odc`: `dotnet test kernel/tests/Anvil.Tests.Odc -c Release` com trx.
4. `facade`: `node --test` da raiz, da fachada, do Portal e de `platforms/odc` (os quatro globs de `package.json`), sempre inteira.
   Um reporter próprio (`scripts/gate/node-reporter.mjs`) grava uma linha JSON por teste folha.

As suítes rodam uma de cada vez, com `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, `TEMP`/`TMP` curtos e privados
(`%LOCALAPPDATA%\Temp\sg\<execução>`), `ANVIL_STUDIO_DIR` do Service Studio 11 e `ANVIL_ODC_FEATURES_DIR` com uma cópia privada do
`Features.xml` do ODC Studio.

### Níveis

| Nível | O que roda | Tempo (esta máquina, sob carga de outras sessões) |
|---|---|---|
| `quick` | build, as classes críticas da matriz no kernel (`quick` de cada funcionalidade: 113 O11, 35 ODC) e a fachada inteira | 33 min no lote 2 (25/10): build 31 s; O11 13m58 (1.383 testes); ODC 9m11 (315); fachada 7 min + 2 min de repetição. Achou as mesmas 6 regressões do full |
| `full` | build, as duas suítes do kernel inteiras e a fachada inteira | 5h17 na linha de base: build 33 s; O11 2h34 + 25 min de repetição; ODC 1h23 + 39 min; fachada 7 min + 7 min |
| `--feature a,b` | build, no kernel todas as classes que a matriz cita para essas funcionalidades, e a fachada | depende |

A ordem é build, O11, ODC, fachada. A fachada vem por último porque `JobTests` e `OdcJobTests` gravam em `kernel/.local/test-work` e
`kernel/.local/lane-odc/test-work` os selos dos jobs (`<job>.result.json`) que os testes de descoberta da fachada (`catalog-*`) leem como prova
atual. Com a fachada antes do kernel num worktree novo, a linha de base deu 78 falhas na fachada em vez de 23. O `quick` não roda `OdcJobTests`
(22 min sozinho): ele reaproveita os selos ODC da última rodada `full` do mesmo worktree. Num worktree novo, rode o `full` primeiro.

A regra do `quick` (em `scripts/gate/matrix.json`, campo `about`): classes citadas na matriz com até 30 s na rodada full da linha de base, mais
`JobTests`, `NegativeJobTests`, `TextRoundTripDataTests`, `HtmlComponentTests` (O11) e `HtmlCrossPlatformLifecycleTests`, `ScreenVisualOdcTests`,
`OdcAppFactoryTests`, `ScreenHtmlFamilyOdcTests`, `ModelReadingTests` (ODC). Ficam só no `full` as classes longas: `ScreenHtmlEditJobTests` (26 min),
`FlowBatteryCorpusTests` (17 min), `ScreenRecreationTests`, `EntityActionsCorpusTests`, `ExamplesOdcTests` (24 min), `OdcJobTests` e outras.
Recalibre com `durations-o11.json` e `durations-odc.json` de uma rodada full.

```bash
node scripts/gate/run-gate.mjs --level quick
```

```bash
node scripts/gate/run-gate.mjs --level full
```

Opções: `--only build,facade,o11,odc` (suítes), `--feature entidades,actions`, `--strict`, `--out <pasta>`, `--from <pasta>`,
`--studio-dir <pasta>`, `--temp <pasta curta>`. Resultados em `.local/gate/<data>-<nível>/`: `report.md`, `report.json`, `stages.json`,
`facade.jsonl`, `o11.trx`, `odc.trx`, logs e `durations-o11.json`/`durations-odc.json` (tempo por classe, para recalibrar o `quick`).

### Critério

- **Passa** quando toda suíte terminou e nenhuma falha está fora da lista de falhas conhecidas. Sai com código 0; senão 1 (2 é erro de uso).
- **Instável**: a fachada repete a sós (`--test-concurrency=1`) cada arquivo com falha fora da lista; o kernel repete a sós os métodos com falha
  fora da lista (até 40). Teste que passa a sós sai como instável, listado, e não bloqueia. Sob carga, dezenas de testes de tempo da fachada
  falham e passam sozinhos.
- **Suíte que não terminou bloqueia**: build quebrado do projeto de testes, host do dotnet que caiu, trava acima de 30 min (`--blame-hang-timeout`),
  ou Studio da plataforma ausente. Sem o Studio, os testes nativos voltam cedo como aprovados e um verde não prova nada; por isso o portão recusa
  rodar o kernel sem o `OutSystems.Model.V1.dll` da plataforma. Sem Integration Studio ou sem `Features.xml` o relatório traz um aviso.
- **Corrigidas**: entrada da lista cujo glob casou testes executados e todos passaram. O relatório pede para remover a entrada.
- **Regressões conhecidas** (`kind: "regressao"`): não bloqueiam por padrão, para o lote seguinte poder comparar contra a linha de base, mas
  aparecem em toda execução. `--strict` faz delas bloqueio. Use `--strict` na ativação final.

### Lista de falhas conhecidas

`scripts/gate/known-failures.json`: `{suite, match, kind, reason, since}`. `match` é um glob (`*` e `?`) sobre o id do teste:
- kernel: o `testName` do trx (`Anvil.Tests.Classe.Metodo(args)`), com caminhos de pastas temporárias trocados por `<tmp>`;
- fachada: `<arquivo relativo> :: <describe> > <teste>`;
- build: o nome do passo (`Build: builder ODC`).

`kind`: `ambiente` (falta algo da máquina: fixture, catálogo, Studio de outra versão), `preexistente` (falha antiga de produto ou de teste, já
conhecida antes desta linha de base), `regressao` (quebrou em um lote integrado e precisa de dono).

O portão nunca escreve na lista. Uma falha nova sai em `report.json` (`verdict.unknown`) e em `report.md`. Uma pessoa a classifica e, só se for
ambiente ou preexistente, acrescenta a entrada com motivo e data. Depois de editar a lista, reavalie a mesma rodada sem rodar nada:

```bash
node scripts/gate/run-gate.mjs --from .local/gate/<pasta da rodada>
```

## 2. Linha de base do portão (HEAD 0388bd65, 24/10/2026)

Rodada `full` em 24/10/2026 neste worktree, com outras sessões rodando suítes `dotnet` na mesma máquina. Build, O11 e ODC vêm da rodada
completa (13:56–20:00). A fachada vem da rodada `--only facade` das 19:21, já com os selos do kernel. A primeira rodada pôs a fachada antes do kernel,
e isso mostrou a dependência dos selos. Classificação: cada falha fora da lista do dono foi repetida em `3e461d02`, o estado anterior ao lote 1
(`wip(proto): estado de 24/10 antes das sessões paralelas`). Quem falha lá também é preexistente. Quem passa lá e falha em `0388bd65` é regressão.

| Suíte | Total | Passou | Falhou | Pulou | Instável (passou a sós) | Tempo |
|---|---|---|---|---|---|---|
| build (setup-dev) | 7 passos | 6 | 1 | 0 | 0 | 33 s |
| kernel O11 (`Anvil.Tests`) | 4.260 | 4.188 | 69 | 0 | 3 | 2h34 + 25 min de repetição |
| kernel ODC (`Anvil.Tests.Odc`) | 1.404 | 1.396 | 7 | 1 | 0 | 1h23 + 39 min de repetição |
| fachada (4 globs) | 6.297 | 6.176 | 23 | 93 | 5 | 7 min + 7 min de repetição |

Veredito: **passa** no critério padrão (todas as falhas estão na lista). **Falha com `--strict`**: há 8 entradas de regressão abertas, com 9 falhas.

Falhas por classificação. As entradas estão em `scripts/gate/known-failures.json`; as de regressão saíram de lá quando o lote 2 as
corrigiu (seção 7).

- **Regressão (9 falhas, 2 causas):**
  - O builder ODC não compila. `Build: builder ODC` falha com `FlowTextNormalize.cs(90,53): CS0246 IFlowSchema`, que veio de `2d7a34fa` (R7).
    Por causa dele falham também na fachada `manifest-inspect` (2), `discovery` (READ_FAILED), `lanes` e `resident-reading`, todos lendo
    capturas ODC pelo builder. Os quatro passam em `3e461d02`.
  - Placeholder em bloco ODC. `OdcJobTests` `delete-block` e `block-reuse` e `ExamplesOdcTests` `widget-placeholder-minimal` recusam com
    `ACTION_KIND_NODE: IPlaceholderWidget under a IContainer: Placeholder objects can't be children of CustomPlaceholderWidget objects`.
    Os três passam em `3e461d02`.
- **Ambiente (69 falhas):**
  - 52 linhas `*-ui-osui-*` de `ScreenCoverageTests`: faltam as fixtures `outsystems-ui.oml` e `outsystems-ui-web.oml`.
  - Catálogos `verify-messages-11.55.93`, `functions-11.55.93` e `odc/verify-messages-1.7.29.10953` ausentes (3).
  - FilterBar `HTML_INVALID` em screen generate, 6 no O11 e 2 no ODC.
  - `TraditionalHtmlControlsTests` com `'User'` (2).
  - `.mcp.json` e o ref `source-anvil/imported-head` do worktree (3).
  - Tempo do FarmaVirtual sob carga (1).
- **Preexistente (22 falhas):** as da lista do dono (GuideTests, CSharpDataEffects ColdQueryProjection, CurrentHintTests,
  logic-duplicate-action, B2 listing, discover-asked, discover-tools, english-only, profile-isolation-guard) e mais as que também falham
  em `3e461d02`:
  - `CheckJobStaticTests.CheckJobSaysWhetherTheApplyPathCanStillAddProblems`;
  - `ScreenRecreationTests` e `ScreenRecreationOdcTests` (`#PreviousScreen`, `BackofficeDefaults` ambíguo);
  - `TextRoundTripDataBackNativeTests.TheRequestOfTheTranscript...` (`DDL_NOT_CONVERGED` em `Schedule`);
  - `catalog-a-actions` lane differences, `catalog-b-ui`, `html-edits`, `pa3-fa-guidance`, `reading`, `ssam-integration` e `continuations`.
- **Instáveis (8, passaram a sós):**
  - O11: `FamDepsReferenceTests`, `Pa3Mb2DependenciesDialogTests`, `PacoteD1ReconcileTests`.
  - Fachada: `bench-frio` (Museus ODC), `call-deadline`, `debug-surface-proof` (2) e `warm-start`.

Comparação com o lote 2: seção 7.

## 3. O que a matriz mede

- Funcionalidades: as 26 linhas da lista do dono (telas e REST em linhas separadas por tipo).
- Plataformas: O11 e ODC. Operações: criar, ler, editar, refatorar (renomear, mover, duplicar, substituir), apagar, troubleshoot (recusas,
  diagnóstico, recuperação).
- Nível da prova mais forte da célula:
  - **nativo**: carrega as DLLs do Service Studio ou do ODC Studio e aplica ou lê um modelo real (`.oml`/fixture) headless, ou roda a CLI do kernel
    sobre ele. Os jobs canônicos de `kernel/tests/jobs` (JobTests), `jobs-negative` (NegativeJobTests), `jobs-odc` e `jobs-odc-negative` (OdcJobTests) são nativos.
  - **simulado**: a fachada dirige a ferramenta MCP contra bridge, Studio, Service Center ou Portal falsos (ou o kernel roda contra transporte falso).
  - **offline**: lógica pura, sem DLL de Studio nem modelo. Os jobs de `jobs-coverage*` só passam pelo preflight (Pa2F2RulesTests, Pa2F2OdcTests,
    SqlPreflightTests): contam como offline.
  - **vivo**: nenhum teste automatizado; só uma prova viva (ou nenhuma). Sempre com a lacuna nomeada.
- Uma célula com prova automatizada mas com parte só provável ao vivo leva `*` na visão geral e a lacuna escrita na tabela da funcionalidade.
- "Fora do portão": provas que existem mas nenhum runner do portão executa (seção 5).

## Matriz

<!-- matriz:inicio -->
### Visão geral

Nível da prova mais forte por célula: **N** nativo headless, **S** entrega simulada pelo servidor, **O** offline puro, **V** só viva (lacuna), **–** não se aplica. Lacuna parcial: **N\*** etc. (há prova automatizada, mas uma parte só se prova ao vivo).

| Funcionalidade | O11 criar | O11 ler | O11 editar | O11 refatorar | O11 apagar | O11 troubleshoot | ODC criar | ODC ler | ODC editar | ODC refatorar | ODC apagar | ODC troubleshoot |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| [Map e leituras (digest, ddl, flow, html, search, uses)](#map-e-leituras-digest-ddl-flow-html-search-uses) | – | N\* | – | – | – | S\* | – | N\* | – | – | – | S\* |
| [Visibilidade de ambientes (o11_environment, ssam_doctor, o11_studio, studio_status)](#visibilidade-de-ambientes-o11_environment-ssam_doctor-o11_studio-studio_status) | N\* | N\* | S\* | – | S\* | N | S\* | S\* | – | – | – | S\* |
| [Entidades](#entidades) | N | N | N | N | N | N | N | N | N | N | N | N |
| [Estruturas](#estruturas) | N | N | N | N | N | N | N | N | N | N | N | N |
| [Settings e site properties](#settings-e-site-properties) | N | N\* | S\* | O\* | O\* | S\* | N | N | N\* | N\* | O\* | S\* |
| [Local DB (client entities)](#local-db-client-entities) | N | N\* | O\* | O\* | N | V | N | N | O\* | O\* | N | V |
| [Actions (server, client, screen, service, data)](#actions-server-client-screen-service-data) | N | N | N | N | N | N\* | N | N | N | N\* | N | N |
| [Timers](#timers) | N | N | N\* | O\* | O\* | N\* | N\* | N | N\* | N | N\* | N\* |
| [REST: consumo](#rest-consumo) | N\* | N | N | O\* | N | N\* | N | N | N | N | N\* | N\* |
| [REST: exposição](#rest-exposição) | N | N\* | S\* | N | S\* | S\* | N\* | N | N | N | N\* | S\* |
| [SOAP](#soap) | N\* | N\* | N\* | O\* | N | N | O\* | – | – | – | N\* | V |
| [External DB](#external-db) | S\* | S\* | S\* | – | S | S\* | S\* | S | S | S\* | S | S\* |
| [Extensões XIF .NET (o11_extension)](#extensões-xif-net-o11_extension) | N\* | S | S | S | S | S | – | – | – | – | – | – |
| [Bibliotecas externas .NET (odc_external_library)](#bibliotecas-externas-net-odc_external_library) | – | – | – | – | – | – | S\* | S | S | S | S\* | S |
| [Service Center (o11_service_center_*)](#service-center-o11_service_center_) | S | S\* | S\* | S\* | S | S\* | – | – | – | – | – | – |
| [Portal ODC (odc_portal_*, odc_*)](#portal-odc-odc_portal_-odc_) | – | – | – | – | – | – | S\* | S\* | S\* | S\* | S | S\* |
| [CSS e temas](#css-e-temas) | N | N\* | N\* | N | N\* | N\* | N | N | N | N\* | N\* | N |
| [Blocks](#blocks) | N | N\* | N | N | N\* | N | N | N\* | N | N | N | N |
| [Telas Reactive](#telas-reactive) | N | N | N | N | N | N | N | N | N | N | N | N |
| [Telas Mobile](#telas-mobile) | N | N | N\* | N\* | O\* | N | N | N\* | N\* | O\* | N\* | N |
| [Telas Traditional](#telas-traditional) | N | N | N | N\* | O\* | N\* | – | – | – | – | – | – |
| [Debug (ssam_debug*)](#debug-ssam_debug) | – | S\* | – | – | – | S\* | – | S\* | – | – | – | S\* |
| [Preview (ssam_preview, studio_preview)](#preview-ssam_preview-studio_preview) | – | S\* | – | – | – | S\* | – | S\* | – | – | – | S\* |
| [Teste de query (ssam_query_test)](#teste-de-query-ssam_query_test) | – | S\* | – | – | – | S\* | – | S\* | – | – | – | S\* |
| [Protótipo (prototype)](#protótipo-prototype) | N\* | – | N | – | – | S\* | N\* | – | V | – | – | S\* |
| [Publicação](#publicação) | S\* | N | S\* | – | – | N | S\* | S\* | O\* | – | S\* | S\* |

### Map e leituras (digest, ddl, flow, html, search, uses)

Filtro do nível quick: O11: `ModelReadingTests`, `ModuleDigestTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `TextRoundTripDataTests`; ODC: `ModelReadingTests`, `ModuleDigestTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `TextRoundTripDataTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | n/a |  |  |  | n/a: ssam_map/o11_inspect só leem; gerar índice, digest ou rich numa falta de cache faz parte da leitura. |
| O11 | ler | nativo | `ModuleDigestTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `ModelReadingTests`, `TextRoundTripDataTests` | `module-map`, `module-digest`, `module-ddl`, `module-flow`, `module-html`, `module-rich`, `o11-inspect-module`, `resident-reading` |  | **Lacuna:** As vistas da fachada usam leitor do kernel simulado; nada prova de ponta a ponta a captura o11_inspect {module} do módulo aberto no Studio. |
| O11 | editar | n/a |  |  |  | n/a: Vistas só de leitura; edição é o11_deliver. |
| O11 | refatorar | n/a |  |  |  | n/a: Só leitura; a vista uses alimenta refactors mas não muda nada. |
| O11 | apagar | n/a |  |  |  | n/a: Vistas só de leitura. |
| O11 | troubleshoot | simulado | `ModelReadingTests`, `ModuleIndexTests` | `atritos-b-map-lock`, `module-map`, `module-html`, `module-rich`, `read-budget` |  | **Lacuna:** Índice velho/inválido, trava e recusas só contra bridge falsa e leitor simulado. |
| ODC | criar | n/a |  |  |  | n/a: Vistas só de leitura. |
| ODC | ler | nativo | `ModuleDigestTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `ModelReadingTests`, `TextRoundTripDataTests` | `reading`, `manifest-inspect`, `module-digest`, `module-ddl`, `module-flow`, `module-html` |  | **Lacuna:** As vistas search/uses quase não têm casos ODC na fachada (module-rich é sobretudo O11). manifest-inspect pula sem a CLI do kernel compilada. |
| ODC | editar | n/a |  |  |  | n/a: Vistas só de leitura. |
| ODC | refatorar | n/a |  |  |  | n/a: Vistas só de leitura. |
| ODC | apagar | n/a |  |  |  | n/a: Vistas só de leitura. |
| ODC | troubleshoot | simulado | `ModelReadingTests` | `atritos-b-map-lock`, `module-map`, `module-html`, `module-digest` |  | **Lacuna:** Falta, cache velho e recusas só contra servidor ODC falso e leitor simulado. |

### Visibilidade de ambientes (o11_environment, ssam_doctor, o11_studio, studio_status)

Filtro do nível quick: O11: `ConnectedEnvironmentTests`, `DialogPolicyTests`, `Pa2F7bReservationTests`, `Pa2F8AppFactoryTests`, `Pa3K1CacheTests`, `ServiceCenterBridgeTests`, `VelEntregaEnvironmentNetworkTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `Pa2F8AppFactoryTests` | `o11-environment`, `pa2-f8-environment`, `studio-create-app`, `pa3-mb-create-app` |  | **Lacuna:** create-app/create-module/add-modules contra um ambiente real só têm a prova viva kernel/docs/proofs/2026-09-25-o11-connected-environment.md; a fachada usa CLI falsa. |
| O11 | ler | nativo | `ConnectedEnvironmentTests`, `Pa3K1CacheTests` | `o11-environment`, `pa3-k1-environment`, `o11-studio`, `studio-connect`, `doctor-warm`, `pa2-f7b-doctor` |  | **Lacuna:** Inventário e download contra ambiente real só ao vivo (2026-09-25-o11-connected-environment.md). |
| O11 | editar | simulado |  | `o11-environment`, `atritos-a-refresh`, `pacote-laneD1-studio`, `publish-once` |  | **Lacuna:** update-app, refresh-refs e set-user-provider sem teste de kernel; só argv e portão contra CLI e bridge falsas. |
| O11 | refatorar | n/a |  |  |  | n/a: o11_environment/o11_studio não renomeiam nem movem apps ou módulos (mover módulo entre aplicações é Service Center). |
| O11 | apagar | simulado | `ServiceCenterBridgeTests` | `o11-environment`, `destructive-sc` |  | **Lacuna:** delete-app nunca contra Service Center real. |
| O11 | troubleshoot | nativo | `VelEntregaEnvironmentNetworkTests`, `DialogPolicyTests`, `Pa2F7bReservationTests` | `o11-environment`, `studio-recovery`, `discover-studio`, `pacote-laneD1-studio`, `pa3-mb-studio`, `ui-freeze` |  |  |
| ODC | criar | simulado |  | `studio-create-app`, `pa3-mb-create-app` |  | **Lacuna:** Criar app ODC (studio_create_app) só contra bridge falsa; ODC Studio vivo é a prova. |
| ODC | ler | simulado |  | `pacote-laneD2-status`, `pacote-laneC-connect`, `pa2-f7b-doctor`, `doctor-warm`, `odc/studio-locate` |  | **Lacuna:** studio_status/ssam_connect/ssam_doctor na faixa ODC só contra pipe/bridge falsos; sem teste de kernel nem prova viva. |
| ODC | editar | n/a |  |  |  | n/a: Não há escrita de ambiente ODC nesta funcionalidade (configurações são Portal). |
| ODC | refatorar | n/a |  |  |  | n/a: Sem renomear ou mover nas ferramentas de ambiente. |
| ODC | apagar | n/a |  |  |  | n/a: Apagar asset ODC é odc_asset_delete (Portal ODC). |
| ODC | troubleshoot | simulado |  | `pa2-f7b-doctor`, `pacote-laneC-connect`, `pacote-laneD2-status` |  | **Lacuna:** DOCTOR_LANE_UNUSABLE, pipe ocupado e sem Studio só com falsos. |

### Entidades

Filtro do nível quick: O11: `DataContractIdentityTests`, `DataContractTests`, `DatabaseUpgradeRulesTests`, `DdlConventionsTests`, `DdlMergeTests`, `DdlNotConvergedNamingTests`, `DdlRefusedDependencyTests`, `DdlStatementOrderTests`, `DdlTypeBraceNormalizationTests`, `EntityActionsExpanderTests`, `EntityDataTests`, `EntityIndexTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `NegativeJobTests`, `Pa3KlDeleteTests`, `SemanticDataTests`, `TextRoundTripDataBackTests`, `TextRoundTripDataTests`; ODC: `DdlConventionsTests`, `DdlMergeTests`, `DdlStatementOrderTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `OdcDataContractIdentityTests`, `OdcDatabaseUpgradeRulesTests`, `TextRoundTripDataTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `DdlConventionsNativeTests`, `EntityIndexTests`, `DataContractTests`, `EntityActionsCorpusTests`, `DdlConventionsTests`, `EntityActionsExpanderTests` | `entity-actions`, `ssam-code`, `bench-frio` | `jobs/spec-data`, `jobs/static-entity`, `jobs/entity-actions`, `jobs/data-contract-identity`, `jobs/hire-data-model` |  |
| O11 | ler | nativo | `TextRoundTripDataTests`, `ModuleIndexTests`, `ModuleRichIndexTests`, `EntityDataTests` | `module-ddl`, `module-digest`, `discovery-data` | `jobs/entity-lifecycle`, `jobs/static-entity-lifecycle` |  |
| O11 | editar | nativo | `TextRoundTripDataBackNativeTests`, `DdlMergeTests`, `TextRoundTripDataBackTests`, `EntityIndexTests` | `ssam-code` | `jobs/entity-lifecycle`, `jobs/static-entity-lifecycle` |  |
| O11 | refatorar | nativo | `DataContractIdentityTests`, `SemanticDataTests`, `DdlStatementOrderTests` | `catalog-a-refactor` | `jobs/entity-refactor`, `jobs/rename-indexed-attribute`, `jobs/rename-data-propagation`, `jobs/static-record-refactor` |  |
| O11 | apagar | nativo | `Pa3KlDeleteTests`, `TextRoundTripDataBackTests` |  | `jobs/entity-lifecycle`, `jobs/delete-data-consumers`, `jobs/delete-generated-companions` |  |
| O11 | troubleshoot | nativo | `DatabaseUpgradeRulesTests`, `DdlNotConvergedNamingTests`, `DdlRefusedDependencyTests`, `DdlTypeBraceNormalizationTests`, `NegativeJobTests` | `ssam-code` | `jobs-negative/delete-entity-in-use`, `jobs-negative/delete-entity-fk-in-use`, `jobs-negative/index-name-too-long`, `jobs-negative/duplicate-index`, `jobs-negative/data-cascade-multiple-paths`, `jobs-negative/fk-type-change-with-default` |  |
| ODC | criar | nativo | `DdlConventionsNativeTests`, `EntityActionsCorpusTests`, `DdlConventionsTests` | `entity-actions`, `ssam-code`, `bench-frio` | `jobs-odc/data-entity`, `jobs-odc/data-full-model`, `jobs-odc/static-entity`, `jobs-odc/entity-actions`, `jobs-odc/data-contract-identity` |  |
| ODC | ler | nativo | `TextRoundTripDataTests`, `ModuleIndexTests`, `ModuleRichIndexTests` | `module-ddl`, `module-digest`, `discovery-data` | `jobs-odc/data-full-model`, `jobs-odc/entity-lifecycle`, `jobs-odc/static-entity-lifecycle` |  |
| ODC | editar | nativo | `TextRoundTripDataBackNativeTests`, `DdlMergeTests` | `ssam-code` | `jobs-odc/entity-lifecycle`, `jobs-odc/edit-inherited-data`, `jobs-odc/static-entity-lifecycle` |  |
| ODC | refatorar | nativo | `OdcDataContractIdentityTests`, `DdlStatementOrderTests` | `catalog-a-refactor` | `jobs-odc/entity-refactor`, `jobs-odc/rename-data-propagation`, `jobs-odc/static-record-refactor` |  |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-entity-whole`, `jobs-odc/delete-attribute-no-consumers`, `jobs-odc/delete-data-consumers`, `jobs-odc/delete-generated-companions` |  |
| ODC | troubleshoot | nativo | `OdcDatabaseUpgradeRulesTests`, `Pa3KlOdcTests`, `OdcJobTests` |  | `jobs-odc-negative/delete-entity-in-use`, `jobs-odc-negative/delete-fk-attribute-autoindex`, `jobs-odc-negative/index-name-too-long`, `jobs-odc-negative/duplicate-index`, `jobs-odc-negative/delete-static-entity-in-use`, `jobs-odc-negative/replace-entity` |  |

### Estruturas

Filtro do nível quick: O11: `CurrentHintTests`, `DdlConventionsTests`, `DdlMergeTests`, `DdlTypeBraceNormalizationTests`, `JobTests`, `ModuleDigestTests`, `NegativeJobTests`, `TextRoundTripDataBackTests`, `TextRoundTripDataTests`; ODC: `DdlConventionsTests`, `TextRoundTripDataTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `TextRoundTripDataBackTests`, `DdlConventionsTests`, `JobTests` | `ssam-code` | `jobs/structure-lifecycle`, `jobs/spec-data`, `jobs/sql-input-output` |  |
| O11 | ler | nativo | `TextRoundTripDataTests`, `ModuleDigestTests` | `module-ddl` | `jobs/structure-lifecycle` |  |
| O11 | editar | nativo | `TextRoundTripDataBackTests`, `DdlMergeTests` |  | `jobs/structure-lifecycle` |  |
| O11 | refatorar | nativo | `JobTests` | `catalog-a-refactor` | `jobs/structure-refactor`, `jobs/rename-logic-propagation` |  |
| O11 | apagar | nativo | `TextRoundTripDataBackTests`, `JobTests` |  | `jobs/structure-refactor`, `jobs/delete-generated-companions` |  |
| O11 | troubleshoot | nativo | `NegativeJobTests`, `CurrentHintTests`, `DdlTypeBraceNormalizationTests` |  | `jobs-negative/delete-structure-in-use`, `jobs-negative/delete-structure-attribute-in-use`, `jobs-negative/rename-structure-clash`, `jobs-negative/structure-list-scope` |  |
| ODC | criar | nativo | `DdlConventionsTests`, `OdcJobTests` | `ssam-code` | `jobs-odc/structure-lifecycle`, `jobs-odc/structure-nested`, `jobs-odc/structure-list-type` |  |
| ODC | ler | nativo | `TextRoundTripDataTests` | `module-ddl` | `jobs-odc/structure-lifecycle`, `jobs-odc/structure-nested` |  |
| ODC | editar | nativo | `TextRoundTripDataBackNativeTests` |  | `jobs-odc/structure-lifecycle`, `jobs-odc/structure-list-type` |  |
| ODC | refatorar | nativo | `OdcJobTests` | `catalog-a-refactor` | `jobs-odc/structure-refactor` |  |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/structure-refactor`, `jobs-odc/delete-generated-companions` |  |
| ODC | troubleshoot | nativo | `OdcJobTests` |  | `jobs-odc-negative/delete-structure-in-use`, `jobs-odc-negative/delete-structure-attribute-in-use`, `jobs-odc-negative/rename-structure-clash`, `jobs-odc-negative/move-into-folder-branch` |  |

### Settings e site properties

Filtro do nível quick: O11: `DdlMergeTests`, `JobTests`, `ModuleRichIndexTests`, `Pa2F2RulesTests`, `ServiceCenterSecretRefsTests`, `TextRoundTripDataBackTests`, `TextRoundTripDataTests`; ODC: `Pa2F2OdcTests`, `TextRoundTripDataTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `TextRoundTripDataBackTests`, `JobTests` |  | `jobs/security-config-reactive`, `jobs/single-job-actions`, `jobs/tickets-01-data` |  |
| O11 | ler | nativo | `TextRoundTripDataTests`, `ModuleRichIndexTests` | `service-center-core`, `service-center-studio`, `service-center-modern` | `jobs/security-config-reactive` | **Lacuna:** Leitura de site property no Service Center real: prova viva docs/proofs/2026-10-18-service-center-private-form.md. |
| O11 | editar | simulado | `TextRoundTripDataBackTests`, `DdlMergeTests` | `sc-property-ajax`, `service-center-modern`, `service-center-core` | `jobs-coverage/o11/cov-data-siteproperty-life` | **Lacuna:** Nenhuma aplicação nativa muda uma site property existente (DefaultValue): só DDL→ops offline e Service Center com falsos; o job de cobertura só passa pelo preflight. |
| O11 | refatorar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-data-siteproperty-life`, `jobs-coverage-f2/o11/cov-data-siteproperty-mvin` | **Lacuna:** Renomear, duplicar e mover site property só em jobs de cobertura que o xunit apenas pré-confere; sem aplicação nativa. |
| O11 | apagar | offline | `TextRoundTripDataBackTests`, `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-data-siteproperty-del` | **Lacuna:** Apagar site property só como compilação DDL ('drop site property' vira op delete) e job de cobertura só pré-conferido; sem aplicação nativa nem recusa por uso. |
| O11 | troubleshoot | simulado | `ServiceCenterSecretRefsTests` | `service-center-modern`, `service-center-core`, `sc-property-ajax` |  | **Lacuna:** Nenhum teste de kernel ou job negativo cobre recusas de site property no modelo (nome repetido, tipo ou default inválido). |
| ODC | criar | nativo | `OdcJobTests` | `portal/settings-configuration-approval` | `jobs-odc/security-settings`, `jobs-odc/setting-lifecycle` |  |
| ODC | ler | nativo | `TextRoundTripDataTests` | `debug-odc-setting-reset`, `portal/configuration-comparison` | `jobs-odc/setting-lifecycle` |  |
| ODC | editar | nativo | `OdcJobTests` | `debug-odc-setting-reset`, `portal/settings-configuration-approval`, `portal/configuration-vault-plan` | `jobs-odc/setting-lifecycle` | **Lacuna:** Valor de configuração no Portal (odc_configurations) só com HTTP falso; sem prova viva. |
| ODC | refatorar | nativo | `OdcJobTests` |  | `jobs-odc/setting-lifecycle`, `jobs-coverage-f2/odc/cov-data-siteproperty-mvin` | **Lacuna:** Só renomear é aplicado nativo; mover e duplicar só em job de cobertura pré-conferido. |
| ODC | apagar | offline | `Pa2F2OdcTests` |  | `jobs-coverage/odc/cov-data-siteproperty-del` | **Lacuna:** Sem apagar Setting ODC nativo e sem job negativo de uso; só job de cobertura pré-conferido. |
| ODC | troubleshoot | simulado |  | `debug-odc-setting-reset`, `portal/settings-configuration-approval`, `portal/configuration-comparison` |  | **Lacuna:** Nenhum teste de kernel ou job negativo cobre recusas de Setting no modelo. |

### Local DB (client entities)

Filtro do nível quick: O11: `DdlConventionsTests`, `JobTests`, `Pa2F2RulesTests`; ODC: `DdlConventionsTests`, `Pa2F2OdcTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `DdlConventionsTests`, `JobTests` |  | `jobs/local-storage-mobile`, `jobs/local-storage-notes-mobile` |  |
| O11 | ler | nativo | `JobTests` | `catalog-a-data-types` | `jobs/local-storage-notes-mobile` | **Lacuna:** Nenhum get/dump direto de IClientEntity é afirmado; só a leitura implícita pelos fluxos que a usam e o Verify do JobTests. |
| O11 | editar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-data-cliententity-life` | **Lacuna:** Sem edição nativa de client entity existente: os jobs só criam; set/rename só em job de cobertura pré-conferido. |
| O11 | refatorar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-data-cliententity-life`, `jobs-coverage-f2/o11/cov-data-cliententity-mvin` | **Lacuna:** Renomear, duplicar e mover client entity só em jobs de cobertura pré-conferidos. |
| O11 | apagar | nativo | `JobTests` |  | `jobs/delete-generated-companions` |  |
| O11 | troubleshoot | vivo |  |  |  | **Lacuna:** Nenhuma prova, nem viva: sem job negativo ou recusa de kernel para client entity (tipo só de servidor, apagar em uso). |
| ODC | criar | nativo | `DdlConventionsTests`, `OdcJobTests` |  | `jobs-odc/client-storage` |  |
| ODC | ler | nativo | `OdcJobTests` | `catalog-a-data-types` | `jobs-odc/client-storage` |  |
| ODC | editar | offline | `Pa2F2OdcTests` |  | `jobs-coverage/odc/cov-data-cliententity-life` | **Lacuna:** Sem edição nativa de client entity existente; client-storage só cria. |
| ODC | refatorar | offline | `Pa2F2OdcTests` |  | `jobs-coverage-f2/odc/cov-data-cliententity-mvin` | **Lacuna:** Renomear, mover e duplicar client entity só em jobs de cobertura pré-conferidos. |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-generated-companions` |  |
| ODC | troubleshoot | vivo |  |  |  | **Lacuna:** Nenhuma prova, nem viva: sem job negativo ou recusa para client entity (jobs-odc-negative/session-variable-not-in-odc cobre só variáveis de cliente). |

### Actions (server, client, screen, service, data)

Filtro do nível quick: O11: `ActionNameCollisionTests`, `EntityActionsExpanderTests`, `FlowEditTests`, `FlowGeneralApplyTests`, `FlowMergeTests`, `FlowSyntaxCorpusTests`, `FlowTextLintTests`, `FlowTextNormalizeTests`, `FunctionCatalogTests`, `LogicReplaceTests`, `LogicSpecTests`, `ModuleSpecificationTests`, `NegativeJobTests`, `Pa3KlDeleteTests`, `PacoteBLogicTests`, `PacoteBReplaceTests`, `TextRoundTripTests`; ODC: `FlowEditTests`, `FlowGeneralApplyOdcTests`, `FlowMergeTests`, `OdcServiceActionReferenceTests`, `Pa2F2OdcTests`, `PacoteBOdcTests`, `PacoteD2RulesTests`, `PacoteEOdcRulesTests`, `TextRoundTripCorpusOdcTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `FlowApplyTests`, `FlowGeneralApplyTests`, `LogicSpecTests`, `ModuleSpecificationTests`, `EntityActionsExpanderTests` | `ssam-code`, `familias-fachada`, `entity-actions` | `jobs/logic-spec-services`, `jobs/service-action`, `jobs/data-action-reactive`, `jobs/single-job-actions`, `jobs/client-js-reactive` |  |
| O11 | ler | nativo | `TextRoundTripCorpusTests`, `FlowApplyTests`, `TextRoundTripTests` | `module-flow`, `ssam-code` | `jobs/rename-logic-propagation` |  |
| O11 | editar | nativo | `FlowBatteryCorpusTests`, `FlowEditTests`, `FlowMergeTests`, `FlowTextNormalizeTests` | `ssam-code`, `familias-fachada`, `job-patch` | `jobs/service-action-update`, `jobs/logic-spec-replace` |  |
| O11 | refatorar | nativo | `LogicReplaceTests`, `PacoteBReplaceTests` | `catalog-a-refactor` | `jobs/refactor-replace-action`, `jobs/rename-logic-propagation`, `jobs/refactor-duplicate`, `jobs/refactor-move`, `jobs/refactor-usages` |  |
| O11 | apagar | nativo | `Pa3KlDeleteTests` | `ssam-code` | `jobs/delete-logic-consumers`, `jobs/delete-generated-companions`, `jobs-negative/delete-action-in-use` |  |
| O11 | troubleshoot | nativo | `PacoteBLogicTests`, `FlowSyntaxCorpusTests`, `FlowTextLintTests`, `ActionNameCollisionTests`, `FunctionCatalogTests`, `NegativeJobTests` | `familias-fachada`, `ssam-code`, `correction-chain-server`, `job-patch-correction` | `jobs-negative/logic-duplicate-action`, `jobs-negative/logic-unknown-key`, `jobs-negative/unknown-function`, `jobs-negative/delete-role-exception-in-use`, `jobs-negative/dataaction-list-scope` | **Lacuna:** jobs-negative/logic-unused-input não é rodado por nenhum teste. |
| ODC | criar | nativo | `FlowApplyOdcTests`, `FlowGeneralApplyOdcTests`, `OdcServiceActionReferenceTests` | `ssam-code`, `entity-actions` | `jobs-odc/logic-action`, `jobs-odc/service-action`, `jobs-odc/data-action`, `jobs-odc/exception-lifecycle`, `jobs-odc/security-settings` |  |
| ODC | ler | nativo | `TextRoundTripCorpusOdcTests`, `FlowApplyOdcTests` | `module-flow`, `ssam-code` | `jobs-odc/action-edit-lifecycle` |  |
| ODC | editar | nativo | `FlowBatteryCorpusOdcTests`, `FlowEditTests`, `FlowMergeTests` | `ssam-code` | `jobs-odc/action-edit-lifecycle`, `jobs-odc/logic-steps`, `jobs-odc/switch-exception-handler` |  |
| ODC | refatorar | nativo | `OdcJobTests` | `catalog-a-refactor` | `jobs-odc/refactor-replace-action`, `jobs-odc/rename-logic-propagation`, `jobs-odc/refactor-duplicate`, `jobs-odc/refactor-move` | **Lacuna:** Sem contraparte ODC de LogicReplaceTests/PacoteBReplaceTests (replace mantém chaves, troca de assinatura recusa consumidores): só os jobs. |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-logic-consumers`, `jobs-odc/exception-lifecycle`, `jobs-odc/delete-generated-companions`, `jobs-odc-negative/delete-logic-in-use` |  |
| ODC | troubleshoot | nativo | `PacoteEOdcRulesTests`, `PacoteBOdcTests`, `Pa2F2OdcTests`, `PacoteD2RulesTests`, `OdcJobTests` | `catalog-a-exception` | `jobs-odc-negative/public-server-action-in-app`, `jobs-odc-negative/delete-role-exception-in-use`, `jobs-odc-negative/pa4-pc-isolated-action`, `jobs-odc-negative/delete-logic-in-use` |  |

### Timers

Filtro do nível quick: O11: `JobTests`, `ModuleDigestTests`, `Pa2F2RulesTests`, `TextRoundTripDataBackTests`, `TextRoundTripDataTests`, `TimerScheduleTests`; ODC: `TextRoundTripDataTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `TimerScheduleTests`, `JobTests` |  | `jobs/pacote-laneE-timer-schedule`, `jobs/tickets-06-sla` |  |
| O11 | ler | nativo | `TimerScheduleTests`, `TextRoundTripDataTests`, `ModuleDigestTests` | `service-center-modern`, `service-center-timer-live` | `jobs/pacote-laneE-timer-schedule` |  |
| O11 | editar | nativo | `TimerScheduleTests`, `TextRoundTripDataBackTests` | `pacote-laneF-timers`, `service-center-modern`, `service-center-timer-live` | `jobs/pacote-laneE-timer-schedule` | **Lacuna:** Agenda e ativação no Service Center real: prova viva docs/proofs/2026-10-14-service-center-auth-timers.md. |
| O11 | refatorar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-processes-timer-life` | **Lacuna:** Renomear e duplicar timer O11 só em job de cobertura pré-conferido; sem aplicação nativa. |
| O11 | apagar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-processes-timer-del` | **Lacuna:** Sem apagar timer O11 nativo; só job de cobertura pré-conferido. |
| O11 | troubleshoot | nativo | `TimerScheduleTests` | `service-center-timer-observation`, `service-center-timer-live`, `service-center-core`, `debug-o11-timer-wake`, `pacote-laneF-timers` |  | **Lacuna:** Run Now e observação da execução só com transporte falso; prova viva 2026-10-14-service-center-auth-timers.md. |
| ODC | criar | nativo | `OdcJobTests` |  | `jobs-odc/timer-action`, `jobs-odc/timer-time-of-day` | **Lacuna:** TimerScheduleTests só compila em Anvil.Tests: o ramo ODC (CronSchedule) nunca roda. |
| ODC | ler | nativo | `TextRoundTripDataTests` | `portal/timer-deployment-state`, `portal/timer-run-state` | `jobs-odc/timer-action`, `jobs-odc/timer-lifecycle` |  |
| ODC | editar | nativo | `OdcJobTests` | `portal/timer-activation`, `portal/timer-configuration-approval` | `jobs-odc/timer-lifecycle`, `jobs-odc/timer-time-of-day` | **Lacuna:** Ativação e agenda no Portal só com HTTP falso; sem prova viva de timer ODC. |
| ODC | refatorar | nativo | `OdcJobTests` |  | `jobs-odc/timer-lifecycle`, `jobs-odc/timer-time-of-day` |  |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/timer-lifecycle` | **Lacuna:** Sem job negativo ODC de apagar timer em uso. |
| ODC | troubleshoot | nativo | `OdcJobTests` | `portal/portal-timer`, `portal/timer-pending-state`, `portal/timer-run-state`, `portal/timer-configuration-approval` | `jobs-odc-negative/timeofday-interval-atoron` | **Lacuna:** Wake/execução de timer ODC só com HTTP falso. |

### REST: consumo

Filtro do nível quick: O11: `DeleteBreaksTests`, `IntegrationImportArgsTests`, `JobTests`, `NegativeJobTests`, `Pa2F2RulesTests`, `RestConsumeTests`, `RestSpecTests`; ODC: `RestConsumeOdcTests`, `RestOpenApiImportTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `RestConsumeTests`, `RestSpecTests`, `IntegrationImportArgsTests`, `JobTests` | `rest-consume-sampling`, `rest-consume-discover`, `integration-documents` | `jobs/rest-consume-get`, `jobs/rest-consume-post`, `jobs/rest-spec-consume`, `jobs/rest-consume-generate`, `jobs/rest-consume-auth` | **Lacuna:** Import OpenAPI no O11 só ao vivo (jobs-live/o11-rest-openapi-import: o importador precisa do workspace do Studio); IntegrationImportArgsTests só valida argumentos. |
| O11 | ler | nativo | `RestConsumeTests`, `RestSpecTests`, `JobTests` |  | `jobs/rest-consume-call`, `jobs/rest-query-nested` |  |
| O11 | editar | nativo | `RestSpecTests`, `RestConsumeTests`, `JobTests` |  | `jobs/rest-spec-edit-delete` |  |
| O11 | refatorar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-rest-restclient-life` | **Lacuna:** Nenhum rename aplicado de cliente ou método REST consumido em tests/jobs (o ODC tem rest-consume-lifecycle); o job de cobertura só é pré-conferido. |
| O11 | apagar | nativo | `DeleteBreaksTests`, `JobTests`, `NegativeJobTests` | `o11-cycle-integration-delete` | `jobs/rest-spec-edit-delete`, `jobs-negative/rest-delete-consumers`, `jobs/delete-generated-companions`, `jobs/delete-platform-consumers` |  |
| O11 | troubleshoot | nativo | `RestConsumeTests`, `NegativeJobTests` | `sc-integration-payload`, `rest-consume-sampling` | `jobs-negative/rest-spec-invalid-path` | **Lacuna:** Request/response do log de integração em runtime só simulado; prova viva docs/proofs/2026-10-14-o11-integration-payload.md. |
| ODC | criar | nativo | `RestConsumeOdcTests`, `RestOpenApiImportTests`, `OdcJobTests` | `rest-consume-sampling`, `rest-consume-discover`, `integration-documents` | `jobs-odc/rest-consume`, `jobs-odc/rest-consume-post`, `jobs-odc/rest-consume-auth`, `jobs-odc/rest-spec-consume`, `jobs-odc/rest-openapi-import` |  |
| ODC | ler | nativo | `RestConsumeOdcTests`, `OdcJobTests` |  | `jobs-odc/rest-consume-lifecycle` |  |
| ODC | editar | nativo | `RestConsumeOdcTests`, `OdcJobTests` |  | `jobs-odc/rest-consume-lifecycle` |  |
| ODC | refatorar | nativo | `OdcJobTests` |  | `jobs-odc/rest-consume-lifecycle` |  |
| ODC | apagar | nativo | `RestConsumeOdcTests`, `OdcJobTests` |  | `jobs-odc/delete-generated-companions`, `jobs-odc/delete-platform-consumers` | **Lacuna:** Nenhum job ODC remove método REST com consumidores (o O11 tem rest-delete-consumers); jobs-odc-negative não tem caso REST. |
| ODC | troubleshoot | nativo | `RestOpenApiImportTests`, `RestConsumeOdcTests` | `debug-wave3-integration` |  | **Lacuna:** Nenhum teste cobre logs ou traces de chamadas REST consumidas no Portal ODC. |

### REST: exposição

Filtro do nível quick: O11: `JobTests`, `Pa2F2RulesTests`, `RestExposeSpecTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `RestExposeSpecTests`, `JobTests` |  | `jobs/rest-expose`, `jobs/rest-spec-expose` |  |
| O11 | ler | nativo | `RestExposeSpecTests`, `JobTests` |  | `jobs/rest-spec-expose` | **Lacuna:** A única releitura é o get dentro dos jobs de criação. |
| O11 | editar | simulado |  | `o11-cycle-integration-delete` |  | **Lacuna:** Nenhum job headless edita método exposto existente no O11 (o ODC tem rest-expose-lifecycle); só o portão de palavras de troca de path. |
| O11 | refatorar | nativo | `JobTests` |  | `jobs/rename-logic-propagation` |  |
| O11 | apagar | simulado | `Pa2F2RulesTests` | `o11-cycle-integration-delete` | `jobs-coverage/o11/cov-restservice-restserviceaction-del` | **Lacuna:** Nenhum apagar aplicado de IRestService/IRestServiceAction em tests/jobs; o job de cobertura só é pré-conferido. |
| O11 | troubleshoot | simulado |  | `debug-native-endpoint`, `debug-o11-native-endpoint-run` |  | **Lacuna:** Chamada real ao endpoint publicado só ao vivo. |
| ODC | criar | nativo | `OdcJobTests` |  | `jobs-odc/rest-expose`, `jobs-odc/rest-spec-expose` | **Lacuna:** Sem classe de kernel ODC equivalente a RestExposeSpecTests; só os jobs. |
| ODC | ler | nativo | `OdcJobTests` |  | `jobs-odc/rest-expose-lifecycle` |  |
| ODC | editar | nativo | `OdcJobTests` |  | `jobs-odc/rest-expose-lifecycle` |  |
| ODC | refatorar | nativo | `OdcJobTests` |  | `jobs-odc/rest-expose-lifecycle` |  |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-platform-consumers`, `jobs-coverage/odc/cov-restservice-restserviceaction-del` | **Lacuna:** O job aplicado apaga só o callback OnRequest; apagar método ou serviço só em job de cobertura pré-conferido. |
| ODC | troubleshoot | simulado |  | `debug-odc-native-endpoint-run`, `debug-native-endpoint`, `debug-wave3-integration` |  | **Lacuna:** Chamada real ao endpoint publicado só ao vivo. |

### SOAP

Filtro do nível quick: O11: `DeleteBreaksTests`, `DeliveryIntegrationImportTests`, `IntegrationImportArgsTests`, `JobTests`, `NegativeJobTests`, `Pa2F2RulesTests`, `SoapContractTests`, `SoapPlanTests`; ODC: `RestOpenApiImportTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `SoapPlanTests`, `SoapContractTests`, `DeliveryIntegrationImportTests`, `IntegrationImportArgsTests` | `integration-documents`, `discovery-integrations`, `kernel-delivery` | `jobs-negative/soap-method-not-found` | **Lacuna:** Import real de WSDL pelo importador do Studio só ao vivo: jobs-live/soap-import-calculator. |
| O11 | ler | nativo | `SoapContractTests`, `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-soap-soapstructure-life` | **Lacuna:** Sem releitura dedicada de cliente SOAP importado; os jobs cov-soap-*-life só são pré-conferidos. |
| O11 | editar | nativo | `SoapContractTests`, `IntegrationImportArgsTests` |  |  | **Lacuna:** Acrescentar método a cliente já importado pelo importador só ao vivo (repetir jobs-live/soap-import-calculator). |
| O11 | refatorar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-soap-soapstructure-life`, `jobs-coverage-f2/o11/cov-soap-soapstructure-mvin` | **Lacuna:** Nenhum rename ou move aplicado de cliente, método ou estrutura SOAP; jobs de cobertura só pré-conferidos. |
| O11 | apagar | nativo | `DeleteBreaksTests`, `JobTests` | `o11-cycle-integration-delete` | `jobs/delete-generated-companions` |  |
| O11 | troubleshoot | nativo | `SoapContractTests`, `SoapPlanTests`, `NegativeJobTests` | `sc-integration-payload` | `jobs-negative/soap-method-not-found` |  |
| ODC | criar | offline | `RestOpenApiImportTests` | `discovery-integrations` |  | **Lacuna:** Consumo SOAP é lacuna declarada no ODC (SOAP_LANE_UNSUPPORTED); só a recusa é provada (RestOpenApiImportTests.SoapIsNotAnOdcOperation). |
| ODC | ler | n/a |  |  |  | n/a: Sem op soap na faixa ODC (SOAP_LANE_UNSUPPORTED). |
| ODC | editar | n/a |  |  |  | n/a: Sem op soap na faixa ODC (SOAP_LANE_UNSUPPORTED). |
| ODC | refatorar | n/a |  |  |  | n/a: Sem op soap na faixa ODC (SOAP_LANE_UNSUPPORTED). |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-generated-companions` | **Lacuna:** Só os companheiros gerados de um ISOAPClient de laboratório criado por verbos; nenhum cliente importado real. |
| ODC | troubleshoot | vivo |  |  |  | **Lacuna:** Sem teste automatizado. Depurar consumidor que chama SOAP só ao vivo: docs/DEBUGGER-HEADLESS-FALTA.md ('SOAP ODC com inspeção viva', 09/10). |

### External DB

Filtro do nível quick: O11: `ServiceCenterBridgeTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | simulado |  | `service-center-studio`, `service-center-modern`, `sc-db-approval` |  | **Lacuna:** Só a criação da conexão de BD no Service Center. Entidades externas pelo Integration Studio não são autoradas (XifSpec não tem entidades); investigação viva: kernel/docs/proofs/2026-09-05-integration-studio-investigacao.json. |
| O11 | ler | simulado | `ServiceCenterBridgeTests` | `service-center-studio` |  | **Lacuna:** Conexão contra um banco externo real nunca é testada. |
| O11 | editar | simulado |  | `service-center-studio` |  | **Lacuna:** Só com Service Center falso. |
| O11 | refatorar | n/a |  |  |  | n/a: Service Center não renomeia conexão e o SSAM não autora entidades externas do Integration Studio. |
| O11 | apagar | simulado |  | `service-center-studio`, `service-center-modern`, `sc-db-cleanup`, `destructive-sc` |  |  |
| O11 | troubleshoot | simulado |  | `service-center-modern`, `service-center-studio`, `sc-db-cleanup` |  | **Lacuna:** Teste de conexão contra banco real só ao vivo. |
| ODC | criar | simulado |  | `odc-access`, `portal/access`, `portal/db-connection-approval`, `portal/db-entities` |  | **Lacuna:** Entidades do Data Fabric sem prova nenhuma; nenhuma prova de kernel ou do ODC Studio de app consumindo entidades externas. |
| ODC | ler | simulado |  | `portal/portal-read`, `portal/connection-detail`, `portal/connection-v2-routes`, `portal/db-entities` |  |  |
| ODC | editar | simulado |  | `portal/connection-header-plan`, `portal/access`, `portal/db-entities`, `odc-access` |  |  |
| ODC | refatorar | simulado |  | `portal/db-entity-contract`, `portal/db-entities` |  | **Lacuna:** Só renomear entidade e atributo na importação (contratos próprios). |
| ODC | apagar | simulado |  | `destructive-odc`, `portal/access`, `portal/db-entities`, `portal/connection-delete-observation` |  |  |
| ODC | troubleshoot | simulado |  | `portal/connection-detail`, `portal/access` |  | **Lacuna:** Teste de conexão contra banco real só ao vivo. |

### Extensões XIF .NET (o11_extension)

Filtro do nível quick: O11: `ExtensionReferenceDeliveryTests`, `Pa3K1XifTests`, `ServiceCenterBridgeTests`, `XifCompilerTests`, `XifContractDiffTests`, `XifEngineProbeTests`, `XifInstalledEngineTests`, `XifPackageTests`, `XifSourceMergeTests`, `XifSpecTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `XifSpecTests`, `XifCompilerTests`, `XifInstalledEngineTests`, `Pa3K1XifTests` | `o11-extension`, `pa3-k1-extension`, `service-center-studio` |  | **Lacuna:** XifInstalledEngineTests e Pa3K1XifTests.TheCatalogRouteSpecBuildsOnTheInstalledEngine voltam cedo sem Integration Studio (aí o nível efetivo é offline+simulado). Publicar a extensão compilada no ambiente: prova viva docs/proofs/2026-10-14-xif-references-from.md. |
| O11 | ler | simulado | `XifPackageTests`, `ServiceCenterBridgeTests` | `o11-extension` |  |  |
| O11 | editar | simulado | `XifSourceMergeTests`, `XifContractDiffTests` | `o11-extension` |  |  |
| O11 | refatorar | simulado | `XifContractDiffTests`, `ExtensionReferenceDeliveryTests` | `o11-extension` |  |  |
| O11 | apagar | simulado |  | `o11-extension`, `service-center-delete`, `destructive-sc` |  |  |
| O11 | troubleshoot | simulado | `XifEngineProbeTests`, `XifCompilerTests`, `XifPackageTests` | `o11-extension` |  |  |
| ODC | criar | n/a |  |  |  | n/a: XIF é só O11; no ODC é a biblioteca externa .NET. |
| ODC | ler | n/a |  |  |  | n/a: XIF é só O11. |
| ODC | editar | n/a |  |  |  | n/a: XIF é só O11. |
| ODC | refatorar | n/a |  |  |  | n/a: XIF é só O11. |
| ODC | apagar | n/a |  |  |  | n/a: XIF é só O11. |
| ODC | troubleshoot | n/a |  |  |  | n/a: XIF é só O11. |

### Bibliotecas externas .NET (odc_external_library)

Filtro do nível quick: ODC: `OdcExternalLibraryTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | n/a |  |  |  | n/a: Só ODC; no O11 é a extensão XIF. |
| O11 | ler | n/a |  |  |  | n/a: Só ODC. |
| O11 | editar | n/a |  |  |  | n/a: Só ODC. |
| O11 | refatorar | n/a |  |  |  | n/a: Só ODC. |
| O11 | apagar | n/a |  |  |  | n/a: Só ODC. |
| O11 | troubleshoot | n/a |  |  |  | n/a: Só ODC. |
| ODC | criar | simulado | `OdcExternalLibraryTests` | `odc-external-library`, `portal/external-library-approval`, `portal/external-library`, `external-library-selection` |  | **Lacuna:** O lado do kernel é offline (dotnet falso, sem SDK nem NuGet); nenhuma prova automatizada roda um dotnet publish real nem o upload ao Portal. |
| ODC | ler | simulado |  | `odc-external-library`, `portal/external-library` |  |  |
| ODC | editar | simulado | `OdcExternalLibraryTests` | `odc-external-library`, `portal/external-library-approval`, `portal/library-release-approval` |  |  |
| ODC | refatorar | simulado | `OdcExternalLibraryTests` | `odc-external-library` |  |  |
| ODC | apagar | simulado |  | `destructive-odc`, `destructive-r3-odc-cleanup-approvals`, `odc-external-library` |  | **Lacuna:** Só descartar um job de geração aberto; apagar asset de External Library publicado sem prova dedicada. |
| ODC | troubleshoot | simulado | `OdcExternalLibraryTests` | `odc-external-library` |  |  |

### Service Center (o11_service_center_*)

Filtro do nível quick: O11: `Pa2F8ScTests`, `PacoteFScTests`, `ServiceCenterBridgeTests`, `ServiceCenterPrivateHttpTests`, `ServiceCenterSecretRefsTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | simulado | `ServiceCenterBridgeTests` | `service-center-studio`, `service-center-modern` |  | Fora do portão: kernel/tests/test_service_center*.py (python, sem runner) |
| O11 | ler | simulado | `ServiceCenterBridgeTests`, `ServiceCenterPrivateHttpTests` | `service-center-core`, `service-center-modern`, `service-center-studio`, `service-center-download`, `service-center-async`, `sc-read-queue` |  | **Lacuna:** Layouts reais do Service Center: prova viva docs/proofs/2026-10-18-service-center-private-form.md; sc-live-layouts confere capturas. |
| O11 | editar | simulado | `ServiceCenterSecretRefsTests` | `sc-property-ajax`, `service-center-modern`, `pacote-laneF-timers`, `service-center-timer-live`, `service-center-studio` |  | **Lacuna:** Prova viva: docs/proofs/2026-10-14-service-center-auth-timers.md e docs/proofs/2026-10-18-service-center-private-form.md. |
| O11 | refatorar | simulado |  | `service-center-studio` |  | **Lacuna:** Só mover/acrescentar módulo entre soluções e aplicações. |
| O11 | apagar | simulado | `ServiceCenterBridgeTests` | `service-center-delete`, `destructive-sc`, `destructive-r3-sc-cancel`, `destructive-r3-sc-interrupted`, `destructive-r3-sc-nobackup`, `destructive-r3-sc-window` |  | Fora do portão: kernel/tests/test_service_center_deletes.py (python, sem runner) |
| O11 | troubleshoot | simulado | `Pa2F8ScTests`, `PacoteFScTests` | `sc-integration-payload`, `service-center-performance-events`, `service-center-timer-observation`, `service-center-receipt-resolution`, `pacote-laneF-sc-session`, `sc-sso` |  | **Lacuna:** Autenticação SSO e payload de integração reais: provas vivas docs/proofs/2026-10-14-o11-integration-payload.md e 2026-10-14-service-center-auth-timers.md. |
| ODC | criar | n/a |  |  |  | n/a: Service Center é só O11; no ODC é o Portal. |
| ODC | ler | n/a |  |  |  | n/a: Service Center é só O11. |
| ODC | editar | n/a |  |  |  | n/a: Service Center é só O11. |
| ODC | refatorar | n/a |  |  |  | n/a: Service Center é só O11. |
| ODC | apagar | n/a |  |  |  | n/a: Service Center é só O11. |
| ODC | troubleshoot | n/a |  |  |  | n/a: Service Center é só O11. |

### Portal ODC (odc_portal_*, odc_*)

Filtro do nível quick: nenhum (só a fachada e o nível full).

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | n/a |  |  |  | n/a: O Portal ODC não existe no O11 (o equivalente é o Service Center). |
| O11 | ler | n/a |  |  |  | n/a: O Portal ODC não existe no O11. |
| O11 | editar | n/a |  |  |  | n/a: O Portal ODC não existe no O11. |
| O11 | refatorar | n/a |  |  |  | n/a: O Portal ODC não existe no O11. |
| O11 | apagar | n/a |  |  |  | n/a: O Portal ODC não existe no O11. |
| O11 | troubleshoot | n/a |  |  |  | n/a: O Portal ODC não existe no O11. |
| ODC | criar | simulado |  | `portal/asset-upload`, `portal/mcp-import`, `portal/access`, `portal/asset-creation-approval`, `portal/group-approval`, `portal/api-client-fixture`, `portal/a2a-connection-plan`, `odc-access` |  | **Lacuna:** Toda criação roda contra fetch ou bridge falsos, ou como lógica pura de aprovação; nenhuma criação automatizada contra tenant real. |
| ODC | ler | simulado |  | `portal/portal-read`, `portal/mcp`, `portal/studio-portal`, `portal/user-role-union`, `portal/portal-capabilities`, `portal/api-client-inventory`, `portal/cognito-login`, `portal/oauth-cookie-lifecycle` |  | **Lacuna:** Login (Cognito/OutSystems ID) e leituras contra o Portal real: provas vivas docs/proofs/2026-10-14-odc-community-auth.md e 2026-10-14-odc-credential-prompt.md. |
| ODC | editar | simulado |  | `debug-odc-setting-reset`, `destructive-r3-odc-removal`, `portal/application-role-assignment-approval`, `portal/timer-activation`, `portal/timer-configuration-approval`, `portal/settings-configuration-approval` |  | **Lacuna:** Ativação de timer, settings e papéis são lógica de aprovação offline; só o reset de odc_configurations e o PATCH de odc_write passam pela camada MCP, com falsos. |
| ODC | refatorar | simulado |  | `portal/access`, `portal/organization-rename`, `portal/stage-rename`, `portal/portfolio-rename` |  | **Lacuna:** Só renomear organização, stage e portfólio. |
| ODC | apagar | simulado |  | `destructive-odc`, `destructive-r3-odc-cleanup`, `portal/owned-consumer-deletion-approval`, `portal/dataset-delete-approval`, `portal/a2a-cleanup-metadata`, `portal/connection-delete-observation` |  |  |
| ODC | troubleshoot | simulado |  | `portal/log-screen-contract`, `portal/trace-screen-contract`, `portal/portal-log-native-pagination`, `portal/pa3-fa-portal`, `portal/screenservice-errors`, `portal/timer-run-state` |  | **Lacuna:** Consulta viva de log e erro só em docs/proofs/2026-10-22-odc-runtime-log-query.md. |

### CSS e temas

Filtro do nível quick: O11: `CssScopeTests`, `DemoLatamVisualTests`, `JobTests`, `NamedThemePartTests`, `Pa2F3CssTests`, `Pa3KhCssTests`, `PrototypeCssTests`, `ScreenVisualCheckTests`, `SharedStyleSafetyTests`, `SharedStyleTests`, `StyleSheetLossTests`; ODC: `HtmlCrossPlatformLifecycleTests`, `OdcAppFactoryTests`, `Pa3KhOdcTests`, `ScreenVisualOdcTests`, `ThemeCssTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `HtmlDeltaTests`, `NamedThemePartTests`, `SharedStyleTests`, `PrototypeCssTests`, `JobTests` | `css-shared-visual` | `jobs/cat-b-theme-resource`, `jobs/html-dashboard-reactive` |  |
| O11 | ler | nativo | `HtmlCrossPlatformLifecycleTests`, `ScreenHtmlEditJobTests`, `JobTests` |  | `jobs/cat-b-theme-resource` | **Lacuna:** Sem teste da fachada para ler a StyleSheet do tema; só os get dos jobs e a releitura HTML. |
| O11 | editar | nativo | `HtmlDeltaTests`, `NamedThemePartTests`, `ScreenHtmlEditJobTests`, `JobTests`, `TraditionalStyleTouchTests` | `pacote-laneD1-deliver` | `jobs/html-dashboard-update` | **Lacuna:** CSS publicado só ao vivo: docs/proofs/2026-10-19-live-probes.md. |
| O11 | refatorar | nativo | `SharedStyleTests`, `SharedStyleSafetyTests`, `CssScopeTests`, `JobTests` |  | `jobs/cat-b-theme-resource` |  |
| O11 | apagar | nativo | `JobTests`, `StyleSheetLossTests`, `SharedStyleSafetyTests` |  | `jobs/cat-b-theme-resource`, `jobs-coverage/o11/cov-ui-web-webtheme-del`, `jobs-coverage/o11/cov-ui-mobile-mobiletheme-del` | **Lacuna:** Só o Script do tema é apagado nativo; apagar Theme ou StyleSheet só em jobs de cobertura pré-conferidos. |
| O11 | troubleshoot | nativo | `ScreenVisualCheckTests`, `ScreenVisualFamilyTests`, `StyleSheetLossTests`, `Pa2F3CssTests`, `Pa3KhCssTests`, `DemoLatamVisualTests` | `screen-visual-demolatam`, `css-shared-visual` |  | **Lacuna:** Investigação viva de CSS e ESpace.Dump: docs/proofs/2026-10-19-dump-css.md. |
| ODC | criar | nativo | `ThemeCssTests`, `OdcAppFactoryTests`, `Pa3KhOdcTests`, `OdcJobTests` |  | `jobs-odc/theme-script-resource`, `jobs-odc/cat-b-link-style` |  |
| ODC | ler | nativo | `ThemeCssTests`, `HtmlCrossPlatformLifecycleTests`, `OdcJobTests` |  | `jobs-odc/theme-css-halves`, `jobs-odc/theme-css-reload` |  |
| ODC | editar | nativo | `ThemeCssTests`, `Pa3KhOdcTests`, `HtmlCrossPlatformLifecycleTests`, `OdcJobTests` |  | `jobs-odc/theme-css-halves`, `jobs-odc/theme-css-reload` |  |
| ODC | refatorar | nativo | `OdcJobTests`, `Pa3KhOdcTests` |  | `jobs-odc/resource-script-lifecycle` | **Lacuna:** Só renomear/substituir Script e Resource; sem refactor de estilo compartilhado ou tema no ODC (SharedStyleTests é só O11). |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/resource-script-lifecycle`, `jobs-coverage/odc/cov-ui-mobile-mobiletheme-del` | **Lacuna:** Só apagar Script é aplicado; apagar tema só em job de cobertura pré-conferido. |
| ODC | troubleshoot | nativo | `ScreenVisualOdcTests`, `Pa3KhOdcTests`, `ThemeCssTests` |  | `jobs-odc/theme-css-reload` |  |

### Blocks

Filtro do nível quick: O11: `BlockAcceptanceFamilyTests`, `HtmlComponentTests`, `JobTests`, `MergeFidelityTests`, `NativeUiMoveProbeTests`, `NegativeJobTests`, `Pa3KhHtmlTests`, `Pa3KlEventTests`, `ScreenHtmlTests`, `UiNativeImportsTests`; ODC: `OdcPlaceholderContentProofTests`, `Pa3KhOdcTests`, `ScreenHtmlCoverageOdcTests`, `ScreenHtmlFamilyOdcTests`, `ScreenHtmlTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `HtmlComponentTests`, `UiNativeImportsTests`, `Pa3KhHtmlTests`, `JobTests` | `catalog-b-ui` | `jobs/block-events-reactive`, `jobs/cat-b-block-placeholder`, `jobs/html-visual-block`, `jobs/cat-b-screen-lifecycle` |  |
| O11 | ler | nativo | `ScreenHtmlCoverageTests`, `ScreenHtmlTests` | `module-html`, `module-map` |  | **Lacuna:** ScreenHtmlCoverageTests pula sem as capturas do corpus (tests/contracts/screen-html/corpus.json). |
| O11 | editar | nativo | `JobTests`, `ScreenHtmlEditJobTests`, `TraditionalStyleTouchTests` | `pacote-laneD1-deliver` | `jobs/block-events-update`, `jobs/block-events-mandatory-reactive`, `jobs/block-events-types-reactive`, `jobs/block-events-nested-reactive` |  |
| O11 | refatorar | nativo | `JobTests`, `NativeUiMoveProbeTests`, `UiNativeImportsTests` |  | `jobs/cat-b-block-rename` |  |
| O11 | apagar | nativo | `JobTests`, `NegativeJobTests` |  | `jobs/block-events-delete-reactive`, `jobs-negative/delete-block-in-use`, `jobs-negative/delete-block-event-in-use`, `jobs-coverage/o11/cov-ui-block-del` | **Lacuna:** Nenhum job O11 aplicado apaga um bloco inteiro; só a recusa por uso; cov-ui-block-del só pré-conferido. |
| O11 | troubleshoot | nativo | `MergeFidelityTests`, `Pa3KlEventTests`, `NegativeJobTests`, `BlockAcceptanceFamilyTests` |  | `jobs/hidden-reference-block`, `jobs-negative/delete-block-in-use` |  |
| ODC | criar | nativo | `OdcJobTests`, `Pa3KhOdcTests` |  | `jobs-odc/block-events`, `jobs-odc/block-reuse`, `jobs-odc/html-visual-block` |  |
| ODC | ler | nativo | `ScreenHtmlCoverageOdcTests`, `ScreenHtmlTests` | `module-html` |  | **Lacuna:** ScreenHtmlCoverageOdcTests pula sem as capturas do corpus. |
| ODC | editar | nativo | `OdcJobTests`, `ScreenHtmlFamilyOdcTests` |  | `jobs-odc/screen-block-edit`, `jobs-odc/block-events-mandatory`, `jobs-odc/block-events-types`, `jobs-odc/block-events-two-instances` |  |
| ODC | refatorar | nativo | `OdcJobTests`, `OdcPlaceholderContentProofTests` |  | `jobs-odc/block-event-lifecycle` |  |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-block`, `jobs-odc/cat-b-block-event-delete`, `jobs-odc-negative/delete-block-event-in-use` |  |
| ODC | troubleshoot | nativo | `OdcPlaceholderContentProofTests`, `OdcJobTests` |  | `jobs-odc-negative/delete-block-event-in-use` |  |

### Telas Reactive

Filtro do nível quick: O11: `DemoLatamVisualTests`, `JobTests`, `NegativeJobTests`, `ScreenDocumentTests`, `ScreenGeneratorTests`, `ScreenHtmlTests`, `ScreenSpecTests`, `ScreenVisualCheckTests`; ODC: `HtmlCrossPlatformLifecycleTests`, `ScreenGeneratorOdcTests`, `ScreenHtmlCoverageOdcTests`, `ScreenHtmlFamilyOdcTests`, `ScreenHtmlTests`, `ScreenVisualOdcTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `ScreenGeneratorTests`, `HtmlCrossPlatformLifecycleTests`, `ScreenDocumentTests`, `ScreenSpecTests`, `JobTests` | `gen-screen-card`, `familias-fachada` | `jobs/screen-reactive`, `jobs/screen-generate-reactive`, `jobs/screen-spec-form-reactive`, `jobs/html-dashboard-reactive` |  |
| O11 | ler | nativo | `ScreenHtmlCoverageTests`, `ScreenHtmlTests`, `HtmlCrossPlatformLifecycleTests` | `module-html` |  |  |
| O11 | editar | nativo | `ScreenHtmlEditJobTests`, `HtmlElementEditJobTests`, `HtmlDeltaTests`, `ScreenHtmlFamilyTests` | `ssam-code-html-edits`, `html-edits`, `patch-por-nome` | `jobs/html-dashboard-update` |  |
| O11 | refatorar | nativo | `ScreenRecreationTests`, `JobTests` |  | `jobs/refactor-contact-reactive`, `jobs/cat-b-screen-replace-delete`, `jobs/duplicate-into-parent-reactive` |  |
| O11 | apagar | nativo | `JobTests`, `NegativeJobTests` |  | `jobs/cat-b-screen-replace-delete`, `jobs/delete-default-screen`, `jobs-negative/delete-widget-in-use` |  |
| O11 | troubleshoot | nativo | `ScreenVisualCheckTests`, `ScreenVisualFamilyTests`, `DemoLatamVisualTests`, `NegativeJobTests` | `ui-precheck`, `screen-visual-demolatam` | `jobs-negative/html-control-inside-link`, `jobs-negative/screen-unknown-kind`, `jobs-negative/destination-before-screen` |  |
| ODC | criar | nativo | `ScreenGeneratorOdcTests`, `HtmlCrossPlatformLifecycleTests`, `OdcJobTests` | `gen-screen-card` | `jobs-odc/screen-basic`, `jobs-odc/screen-form`, `jobs-odc/screen-list`, `jobs-odc/screen-generate` |  |
| ODC | ler | nativo | `ScreenHtmlCoverageOdcTests`, `ScreenHtmlTests` | `reading`, `module-html` |  |  |
| ODC | editar | nativo | `HtmlElementEditOdcTests`, `ScreenHtmlEditBatteryOdcTests`, `ScreenHtmlFamilyOdcTests`, `OdcJobTests` | `ssam-code-html-edits` | `jobs-odc/screen-block-edit` |  |
| ODC | refatorar | nativo | `ScreenRecreationOdcTests`, `OdcJobTests` |  | `jobs-odc/cat-b-screen-replace-delete`, `jobs-odc/duplicate-into-parent` |  |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/delete-screen`, `jobs-odc/cat-b-screen-replace-delete`, `jobs-odc-negative/delete-screen-in-use` |  |
| ODC | troubleshoot | nativo | `ScreenVisualOdcTests`, `OdcJobTests` | `ui-precheck` | `jobs-odc-negative/localized-image-reactive`, `jobs-odc-negative/create-button-group-item-outside-group` |  |

### Telas Mobile

Filtro do nível quick: O11: `JobTests`, `MergeFidelityTests`, `Pa2F2RulesTests`, `ScreenFormValidationTests`; ODC: `HtmlCrossPlatformLifecycleTests`, `OdcAppFactoryTests`, `OdcBlankModuleTests`, `Pa2F2OdcTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `HtmlCrossPlatformLifecycleTests`, `JobTests` | `discover-osui` | `jobs/screen-spec-cards-mobile`, `jobs/osui-patterns-mobile`, `jobs/local-storage-mobile` |  |
| O11 | ler | nativo | `HtmlCrossPlatformLifecycleTests`, `ScreenHtmlEditJobTests`, `ScreenHtmlFamilyTests` |  |  |  |
| O11 | editar | nativo | `ScreenHtmlEditJobTests`, `ScreenHtmlFamilyTests`, `HtmlCrossPlatformLifecycleTests`, `ScreenFormValidationTests` |  |  | **Lacuna:** Nenhum job canônico edita tela Mobile existente; só a bateria sintética de edição sobre mobile-ui.oml. |
| O11 | refatorar | nativo | `ScreenHtmlEditJobTests`, `Pa2F2RulesTests` |  | `jobs-coverage-f2/o11/cov-ui-mobile-screenaction-mvin` | **Lacuna:** Só mover e envolver dentro da bateria de edição; sem renomear, substituir ou duplicar tela Mobile; o job de cobertura só é pré-conferido. |
| O11 | apagar | offline | `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-ui-mobile-mobilescreen-del`, `jobs-coverage/o11/cov-ui-mobile-mobileblock-del` | **Lacuna:** Nenhum apagar aplicado de tela Mobile; os jobs cov-*-del só são pré-conferidos. |
| O11 | troubleshoot | nativo | `MergeFidelityTests`, `ScreenFormValidationTests`, `Pa2F2RulesTests` |  |  |  |
| ODC | criar | nativo | `OdcBlankModuleTests`, `OdcAppFactoryTests`, `HtmlCrossPlatformLifecycleTests`, `OdcJobTests` |  | `jobs-odc/mobile-sync-events` |  |
| ODC | ler | nativo | `HtmlCrossPlatformLifecycleTests` |  |  | **Lacuna:** Leitura provada só na fixture blank-mobile; não há corpus Mobile ODC. |
| ODC | editar | nativo | `HtmlCrossPlatformLifecycleTests` |  |  | **Lacuna:** Nenhum job de jobs-odc edita tela de app Mobile. |
| ODC | refatorar | offline | `Pa2F2OdcTests` |  | `jobs-coverage-f2/odc/cov-ui-mobile-screenaction-mvin` | **Lacuna:** Nenhum refactor aplicado em app Mobile; o job de cobertura só é pré-conferido. |
| ODC | apagar | nativo | `OdcJobTests` |  | `jobs-odc/mobile-sync-events`, `jobs-coverage/odc/cov-ui-mobile-mobilescreen-del` | **Lacuna:** Só o evento OnSyncComplete é apagado; apagar tela Mobile só pré-conferido. |
| ODC | troubleshoot | nativo | `OdcJobTests`, `OdcBlankModuleTests`, `Pa2F2OdcTests` |  | `jobs-odc-negative/session-variable-mobile` |  |

### Telas Traditional

Filtro do nível quick: O11: `JobTests`, `Pa2F2RulesTests`, `ScreenHtmlEditTests`, `TraditionalAjaxTests`, `TraditionalControlsParityTests`, `TraditionalEntryRecipeTests`, `TraditionalHtmlControlsTests`, `TraditionalHtmlFrontendTests`, `TraditionalHtmlRecordsTests`, `TraditionalHtmlRoundTripTests`, `TraditionalInputChangeTests`, `TraditionalLayoutDocumentTests`, `TraditionalPreparationFlowTests`, `TraditionalPreparationScopeTests`, `TraditionalRecreationTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `TraditionalHtmlFrontendTests`, `TraditionalEntryRecipeTests`, `HtmlCrossPlatformLifecycleTests`, `JobTests` | `traditional-compose`, `traditional-tasks`, `traditional-text` | `jobs/screen-crud-traditional`, `jobs/traditional-html-frontend`, `jobs/cat-b-traditional-gallery` |  |
| O11 | ler | nativo | `TraditionalHtmlRoundTripTests`, `TraditionalHtmlRecordsTests`, `TraditionalRecreationTests`, `HtmlCrossPlatformLifecycleTests` | `traditional-discovery` |  |  |
| O11 | editar | nativo | `TraditionalHtmlControlsTests`, `TraditionalControlsParityTests`, `TraditionalInputChangeTests`, `TraditionalPreparationFlowTests`, `TraditionalAjaxTests` | `traditional-tasks` | `jobs/traditional-ajax-navigation` |  |
| O11 | refatorar | nativo | `TraditionalRecreationTests`, `TraditionalLayoutDocumentTests`, `JobTests` |  | `jobs/duplicate-into-parent-traditional` | **Lacuna:** Sem renomear ou substituir tela ou web block Traditional. |
| O11 | apagar | offline | `ScreenHtmlEditTests`, `Pa2F2RulesTests` |  | `jobs-coverage/o11/cov-ui-web-webscreen-del`, `jobs-coverage/o11/cov-ui-web-webblock-del` | **Lacuna:** Nenhum apagar aplicado de Web screen ou web block; jobs de cobertura só pré-conferidos e ScreenHtmlEditTests usa modelo falso; remoção do Entry só ao vivo (docs/proofs/2026-10-19-live-probes.md). |
| O11 | troubleshoot | nativo | `TraditionalAjaxTests`, `TraditionalPreparationScopeTests`, `TraditionalHtmlFrontendTests` | `debug-o11-traditional`, `debug-o11-traditional-run`, `debug-o11-traditional-interactive` |  | **Lacuna:** Ajax e correções de runtime vivas em docs/proofs/2026-10-19-traditional-ajax.md. |
| ODC | criar | n/a |  |  |  | n/a: Traditional Web é só O11 (catalog-b-ui e traditional-text afirmam a recusa no ODC). |
| ODC | ler | n/a |  |  |  | n/a: Traditional Web é só O11. |
| ODC | editar | n/a |  |  |  | n/a: Traditional Web é só O11. |
| ODC | refatorar | n/a |  |  |  | n/a: Traditional Web é só O11. |
| ODC | apagar | n/a |  |  |  | n/a: Traditional Web é só O11. |
| ODC | troubleshoot | n/a |  |  |  | n/a: Traditional Web é só O11. |

### Debug (ssam_debug*)

Filtro do nível quick: O11: `JobTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | n/a |  |  |  | n/a: O depurador só observa e roda o app publicado; nunca muda o modelo. |
| O11 | ler | simulado | `JobTests` | `debug`, `debug-o11-run`, `debug-o11-native-run`, `debug-o11-bpt-run`, `debug-o11-timer-wake`, `debug-server-private-inspection` | `jobs/debugger-client-variable-all-types`, `jobs/debugger-session-variable-all-types`, `jobs/debugger-client-variable-compound-type`, `jobs-negative/debugger-client-variable-object-type`, `jobs/process-bpt` | **Lacuna:** O nível nativo só vem de kernel/debug/tests-o11 (carrega as DLLs do Service Studio), fora de qualquer runner; debug-o11-native-worker-golden pula sem SSAM_DEBUG_EVIDENCE_ROOT; as provas vivas citadas em docs/DEBUGGER-HEADLESS.md ficam em .local (fora do Git). Fora do portão: kernel/debug/tests-o11 (BreakpointOwnerTests, NativeInspectionTests, NativeVariableTests, TraceTests, BackgroundThreadEndTests) |
| O11 | editar | n/a |  |  |  | n/a: Breakpoints e sessão são estado de runtime, não edição do app. |
| O11 | refatorar | n/a |  |  |  | n/a: Não muda o modelo. |
| O11 | apagar | n/a |  |  |  | n/a: Não muda o modelo; limpeza de sessão e trava é ciclo de vida. |
| O11 | troubleshoot | simulado |  | `debug-start-diagnostic`, `debug-app-user-diagnostic`, `debug-o11-inspection-deadline`, `debug-o11-login-reconcile`, `debug-o11-republish-reconcile`, `debug-final-matrix` |  | **Lacuna:** Diagnóstico nativo de sessão e transporte fora de qualquer runner; debug-final-matrix pula o caso de evidência sem evidência local. Fora do portão: kernel/debug/tests-o11 (SessionDiagnosticTests, TransportPreflightTests, DebugRequestOwnershipIntegrationTests) |
| ODC | criar | n/a |  |  |  | n/a: Só observa e roda o app publicado. |
| ODC | ler | simulado | `OdcJobTests` | `debug-odc-native-run`, `debug-odc-native-live`, `debug-odc-native-mount-run`, `debug-odc-native-wake-run`, `debug-odc-workflow-run`, `debug-odc-bpt-absence` | `jobs-odc/debugger-client-variable-all-types`, `jobs-odc/debugger-client-variable-compound-type`, `jobs-odc-negative/debugger-client-variable-object-type` | **Lacuna:** Runner nativo ODC fora de qualquer runner; debug-odc-native-golden pula sem SSAM_DEBUG_EVIDENCE_ROOT; ciclo de papéis recusado e testes pulados porque facade/sc-portal-access.mjs não existe (debug-role-cycle-pending). Fora do portão: kernel/debug/tests-odc (mesmas fontes, DefineConstants ODC) |
| ODC | editar | n/a |  |  |  | n/a: Não muda o modelo. |
| ODC | refatorar | n/a |  |  |  | n/a: Não muda o modelo. |
| ODC | apagar | n/a |  |  |  | n/a: Não muda o modelo. |
| ODC | troubleshoot | simulado |  | `debug-odc-native-failure-diagnostic`, `debug-start-diagnostic`, `debug-odc-reconcile`, `debug-odc-exception-body`, `debug-role-cycle-pending`, `portal/active-credential-retention` |  | **Lacuna:** Sem prova viva ODC do depurador versionada. Fora do portão: kernel/debug/tests-odc (SessionDiagnosticTests, TransportPreflightTests) |

### Preview (ssam_preview, studio_preview)

Filtro do nível quick: O11: `DeliveryMergeOrderTests`; ODC: `OdcMergeOrderTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | n/a |  |  |  | n/a: ssam_preview (visual) e studio_preview (merge) só leem. |
| O11 | ler | simulado | `MergeCoverageTests` | `preview`, `preview-compare`, `preview-engine`, `preview-discover`, `migration-acceptance`, `merge-order-deferred` |  | **Lacuna:** ssam_preview nunca roda contra navegador ou host real nos testes (preview.test usa worker com provedor HTTP de fixture); evidência viva só em docs/PREVIEW-LOCAL.md e docs/proofs/2026-10-23-migration-p0-fixes.md (M06). MergeCoverageTests prova o studio_preview (merge), nativo. |
| O11 | editar | n/a |  |  |  | n/a: Só leitura. |
| O11 | refatorar | n/a |  |  |  | n/a: Só leitura. |
| O11 | apagar | n/a |  |  |  | n/a: Só leitura. |
| O11 | troubleshoot | simulado | `DeliveryMergeOrderTests` | `preview`, `preview-capture`, `preview-pipeline`, `preview-engine`, `merge-order-deferred` |  | **Lacuna:** Falhas de partida, parada e recibo incerto só contra fixtures ou hosts falsos; sem teste de falha em navegador real. |
| ODC | criar | n/a |  |  |  | n/a: Só leitura. |
| ODC | ler | simulado | `OdcMergeOrderTests` | `preview`, `preview-engine`, `preview-capture`, `preview-discover`, `preview-compare`, `migration-acceptance` |  | **Lacuna:** Watcher, build de release e render ODC nunca rodam de verdade nos testes; PREVIEW-LOCAL.md limita o escopo ao perfil Quotes. |
| ODC | editar | n/a |  |  |  | n/a: Só leitura. |
| ODC | refatorar | n/a |  |  |  | n/a: Só leitura. |
| ODC | apagar | n/a |  |  |  | n/a: Só leitura. |
| ODC | troubleshoot | simulado |  | `preview-engine`, `preview-capture`, `preview-pipeline`, `preview` |  | **Lacuna:** Só falsos ou fixtures; sem teste ODC de kernel ou de runtime real. |

### Teste de query (ssam_query_test)

Filtro do nível quick: nenhum (só a fachada e o nível full).

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | n/a |  |  |  | n/a: Teste de SELECT/Aggregate só leitura; efeitos recusados (QUERY_TEST_EFFECTS_UNSUPPORTED). |
| O11 | ler | simulado |  | `query-test`, `tool-routes` |  | **Lacuna:** Nenhuma execução automatizada contra modelo ou servidor real; prova viva docs/proofs/2026-10-07-native-query-test.md. Fora do portão: kernel/query-test/tests (QueryTest.Tests, offline; só pelo dotnet test manual de docs/TESTE-NATIVO-QUERY.md) |
| O11 | editar | n/a |  |  |  | n/a: Só leitura; efeitos recusados. |
| O11 | refatorar | n/a |  |  |  | n/a: Só leitura. |
| O11 | apagar | n/a |  |  |  | n/a: Só leitura; DELETE recusado. |
| O11 | troubleshoot | simulado |  | `query-test` |  | **Lacuna:** Erro nativo, timeout e cancelamento só com transportes falsos; prova viva 2026-10-07-native-query-test.md. Fora do portão: kernel/query-test/tests (PreparationFailure..., TimeoutAndCancel..., CorruptReceipt...) |
| ODC | criar | n/a |  |  |  | n/a: Só leitura. |
| ODC | ler | simulado |  | `query-test` |  | **Lacuna:** ODC só no caso 'ODC binds process once' da fachada e na descoberta; sem teste de kernel ODC; prova viva 2026-10-07-native-query-test.md. Fora do portão: kernel/query-test/tests (compartilhado, offline) |
| ODC | editar | n/a |  |  |  | n/a: Só leitura. |
| ODC | refatorar | n/a |  |  |  | n/a: Só leitura. |
| ODC | apagar | n/a |  |  |  | n/a: Só leitura. |
| ODC | troubleshoot | simulado |  | `query-test` |  | **Lacuna:** Resultado incerto e reconciliação com o pid ODC só com falsos. |

### Protótipo (prototype)

Filtro do nível quick: O11: `PrototypeBindTests`, `PrototypeBuilderTests`, `PrototypeCssTests`, `PrototypeExpanderTests`, `PrototypeFieldNamesTests`, `PrototypeRenderTests`, `PrototypeVisitaCertaTests`; ODC: `PrototypeExpanderOdcTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | nativo | `PrototypeBuilderTests`, `PrototypeRenderTests`, `PrototypeExpanderTests`, `PrototypeCssTests`, `PrototypeFieldNamesTests`, `PrototypeVisitaCertaTests` | `prototype-op`, `prototype-render-fixtures`, `prototype-render-farmavirtual`, `prototype-archive`, `prototype-seed`, `discovery-prototype` |  | **Lacuna:** Sem job canônico de protótipo; a captura da fachada usa jsdom num processo filho, não navegador; discovery-prototype pula as checagens de CLI sem a CLI compilada. |
| O11 | ler | n/a |  |  |  | n/a: Não há op de leitura própria: releitura e fidelidade (PrototypeRenderTests, prototype-fidelity-measure) são checagens dentro de criar. |
| O11 | editar | nativo | `PrototypeBuilderTests`, `PrototypeExpanderTests`, `PrototypeBindTests` | `prototype-bind`, `prototype-guards`, `prototype-op` |  |  |
| O11 | refatorar | n/a |  |  |  | n/a: A op prototype importa e reimporta uma captura; não tem refactor (renomear homônimos faz parte da reimportação). |
| O11 | apagar | n/a |  |  |  | n/a: A reimportação nunca apaga; elemento sumido só é listado (PrototypeExpanderTests). |
| O11 | troubleshoot | simulado | `PrototypeExpanderTests` | `prototype-guards`, `prototype-op`, `prototype-source-shapes`, `prototype-visitacerta` |  | **Lacuna:** Mapear o Verify à captura e a reconstrução única só com falsos (docs/proofs/2026-10-19-critical-pending.md também usa transportes simulados). |
| ODC | criar | nativo | `PrototypeExpanderOdcTests` | `prototype-op`, `prototype-seed`, `discovery-prototype` |  | **Lacuna:** PrototypeExpanderOdcTests volta sem afirmar nada sem ODC Studio; sem job ODC de protótipo. |
| ODC | ler | n/a |  |  |  | n/a: Não há op de leitura própria. |
| ODC | editar | vivo |  |  |  | **Lacuna:** Nenhuma prova automatizada de reimportação ou bind no ODC (PrototypeBindTests e prototype-bind são só O11; PrototypeExpanderOdcTests não reimporta) e nenhuma prova viva. |
| ODC | refatorar | n/a |  |  |  | n/a: Sem op de refactor. |
| ODC | apagar | n/a |  |  |  | n/a: A reimportação nunca apaga. |
| ODC | troubleshoot | simulado |  | `prototype-op`, `prototype-guards` |  | **Lacuna:** Só recusa e recibo do studio_deliver, com falsos; sem teste de kernel ODC do mapeamento do Verify. |

### Publicação

Filtro do nível quick: O11: `PublicationBatchTests`, `PublishConfirmationTests`, `PublishLogTests`, `PublishOmlProtocolTests`.

| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |
|---|---|---|---|---|---|---|
| O11 | criar | simulado | `PublishConfirmationTests`, `PublishOmlProtocolTests`, `PublicationBatchTests` | `o11-publish`, `publish-once`, `call-publish-summary`, `producer-publication` |  | **Lacuna:** Nenhum 1-Click Publish real automatizado: os testes do kernel são estado/protocolo e a fachada usa bridge falsa. |
| O11 | ler | nativo | `PublishLogTests` | `o11-publish`, `atritos-a-refresh` |  |  |
| O11 | editar | simulado |  | `publish-once`, `atritos-a-refresh`, `pacote-laneD1-studio` |  | **Lacuna:** Refresh e republicação em cascata dos consumidores só contra bridges falsas. |
| O11 | refatorar | n/a |  |  |  | n/a: Publicar não renomeia nem move. |
| O11 | apagar | n/a |  |  |  | n/a: o11_publish não despublica; remoção é delete-app (ambientes). |
| O11 | troubleshoot | nativo | `PublishLogTests`, `PublishOmlProtocolTests` | `o11-publish`, `publish-integrity`, `debug-o11-republish-reconcile`, `pacote-laneD1-studio` |  |  |
| ODC | criar | simulado |  | `atritos-a-publish`, `pacote-laneD2-delivery`, `pacote-laneD2-status`, `portal/access`, `portal/asset-deployment-approval`, `portal/operation-receipt` |  | **Lacuna:** Nenhuma prova de kernel ou nativa do Publish de studio_publish/odc_deploy: só bridge e fetch falsos. |
| ODC | ler | simulado |  | `studio-publish-log`, `portal/operation-log`, `portal/operation-receipt`, `portal/access` |  | **Lacuna:** O formato do log de publicação foi copiado da bridge v35, sem conferência viva. |
| ODC | editar | offline |  | `portal/settings-configuration-approval`, `portal/timer-configuration-approval` |  | **Lacuna:** ApplyConfigs do odc_deploy só como lógica pura de aprovação; nenhum teste dirige a ferramenta. |
| ODC | refatorar | n/a |  |  |  | n/a: Deploy não renomeia nem move. |
| ODC | apagar | simulado |  | `destructive-odc`, `portal/access`, `portal/asset-deployment-approval` |  | **Lacuna:** Undeploy só contra HTTP do Portal falso. |
| ODC | troubleshoot | simulado |  | `studio-publish-log`, `pacote-laneD2-delivery`, `atritos-a-publish`, `debug-odc-reconcile`, `portal/access`, `portal/operation-log` |  | **Lacuna:** PUBLISH_FAILED e FinishedWithError só com falsos. |
<!-- matriz:fim -->

## 4. Lacunas: o teste vivo mínimo antes de ativar

Funcionalidades sem prova offline ou nativa completa. Antes de ativar um lote que toque nelas, a integradora roda o teste vivo mínimo num ambiente
de teste (nunca corporativo sem instrução explícita), com as palavras de autorização do dono para escritas e publicação, e observa o que está listado.

| # | Funcionalidade | Teste vivo mínimo | Observa |
|---|---|---|---|
| L1 | Service Center (O11) | `o11_service_center_session` (SSO frio), `o11_service_center_read` da lista de módulos e de uma site property de um módulo de rascunho; `o11_service_center_write` muda o valor e lê de volta; agenda de timer válida e `timer-run`. | Autenticação em até 90 s sem prompt repetido; valor lido igual ao da tela do Service Center; `timer-run` com `outcome: execution-observed` e `executionCompleted`; recibo sem segredo. Referência: [auth e timers](proofs/2026-10-14-service-center-auth-timers.md), [formulário privado](proofs/2026-10-18-service-center-private-form.md). |
| L2 | Payload de integração (O11) | Chamar um REST consumido de um app de rascunho e ler `integration-log-detail` pela Request Key. | `payloadStatus: available` com Request/Response mascarados, ou `not-exposed` com `recordingStatus: unknown`; nenhuma repetição da chamada. Referência: [payload](proofs/2026-10-14-o11-integration-payload.md). |
| L3 | Portal ODC | `odc_portal_login {action:"status"}`; `odc_portal_read` de apps, assets e configurações; uma escrita reversível (valor de configuração de um app de teste ou ativação de timer) com `authorize`, e a leitura de volta. | Sessão válida sem janela nova quando já autenticado; leitura igual à do Portal; escrita com recibo `operation-receipt` e estado final lido; redação de segredos no recibo. Referência: [login comunidade](proofs/2026-10-14-odc-community-auth.md), [prompt](proofs/2026-10-14-odc-credential-prompt.md), [log runtime](proofs/2026-10-22-odc-runtime-log-query.md). |
| L4 | Publicação O11 | Entrega pequena num módulo de rascunho e `o11_publish` com `authorize`. | `settled`, log de publicação sem erro, versão nova no Service Center, URL da tela (`ssam_app_url`) responde 200 e mostra a mudança. |
| L5 | Publicação ODC | `studio_publish` do mesmo tipo de mudança e `odc_deploy` para o stage de teste. | Publish `Finished` (não `FinishedWithError`), operação do deploy concluída, revisão nova do asset, URL do app responde e mostra a mudança. |
| L6 | Preview no navegador | `ssam_preview` de uma tela Reactive (O11) e de uma tela ODC do perfil Quotes. | Captura não vazia, sem erro de console, `preview-compare` contra a captura anterior dentro da tolerância; host parado ao fim. Referência: [PREVIEW-LOCAL](PREVIEW-LOCAL.md). |
| L7 | XIF no Integration Studio | Numa máquina com Integration Studio: `o11_extension {action:"check"}` e build `model`/`final` de uma extensão de rascunho; `publish` com `authorize` e `referencesFrom`. | `XifInstalledEngineTests` deixa de voltar cedo; a extensão aparece no Service Center com a versão nova; um módulo consumidor faz refresh das referências e chama a action. Referência: [references-from](proofs/2026-10-14-xif-references-from.md). |
| L8 | External DB real | O11: criar a conexão de BD no Service Center contra um banco de rascunho e testar. ODC: criar conexão no Portal, testar e importar uma entidade. | Teste de conexão OK; entidades listadas; no ODC, a entidade importada aparece no app consumidor. Data Fabric não tem prova nenhuma. |
| L9 | Importadores O11 (OpenAPI, SOAP) | Aplicar `kernel/tests/jobs-live/o11-rest-openapi-import.json` e `soap-import-calculator.json` no Studio aberto. | Cliente REST/SOAP com métodos e estruturas esperados; Verify sem erro; segunda aplicação sem mudança. |
| L10 | Biblioteca .NET ODC | `odc_external_library` com `dotnet publish` real de uma biblioteca de rascunho e upload ao Portal com `authorize`. | Build sem erro, asset de biblioteca criado e revisão visível; action consumível num app de teste. |
| L11 | Debug | `ssam_debug*` num módulo O11 publicado e num app ODC publicado: breakpoint numa server action, chamada da tela, leitura de variáveis. | Breakpoint atingido, variáveis lidas com os tipos certos, sessão encerrada e trava liberada. Os runners nativos `kernel/debug/tests-o11` e `tests-odc` também rodam (fora do portão). |
| L12 | Teste de query | `ssam_query_test` de um Aggregate e de um SQL simples nas duas faixas. | Linhas e colunas iguais às do Studio; efeito (`DELETE`) recusado. Referência: [query nativa](proofs/2026-10-07-native-query-test.md). |
| L13 | Ambiente ODC e criação de app | Com o ODC Studio aberto: `ssam_connect`, `studio_status`, `ssam_doctor`; `studio_create_app` de um app de rascunho com `authorize`. | Faixa ODC utilizável, módulo novo aberto e lido por `ssam_map`. |
| L14 | Timers e settings ODC no Portal | Ativar e acordar um timer de um app de teste; mudar um setting de configuração e ler de volta. | Estado do timer e última execução observados no Portal; valor do setting lido igual. |
| L15 | Protótipo ODC (reimportação) | Reimportar a mesma captura sobre o módulo ODC que ela criou. | Nenhuma mudança na segunda vez; chaves preservadas (só o O11 tem essa prova automatizada). |

## 5. Provas fora do portão

Existem, mas nenhum runner do portão as executa. Ligá-las ao portão é trabalho de outra frente.

- `kernel/debug/tests-o11`, `kernel/debug/tests-odc`, `kernel/debug/tests-witness`: runners de console do depurador (carregam as DLLs do Studio). Fora de `Anvil.slnx` e do `package.json`.
- `kernel/query-test/tests` (QueryTest.Tests): offline; só pelo `dotnet test` manual de [TESTE-NATIVO-QUERY](TESTE-NATIVO-QUERY.md).
- `kernel/tests/*.py` (Service Center, laboratórios C#, um cliente): `python -m unittest` manual. `service-center-core`, `-modern` e `-studio` da fachada são portes dos três primeiros.
- `kernel/tests/Anvil.CSharp.Tests`, `SSAM.License.Tests`, `SSAM.Release.Tests`: projetos de teste fora das duas suítes do portão.
- `kernel/tests/jobs-coverage*`: só passam pelo preflight; foram aplicados uma vez por `docs/evidence/cobertura-testada/tools`.
- `kernel/tests/jobs-live`: só verificação estática (Pa2F2RulesTests, GuideTests, SurfaceTests); nunca aplicados.
- `tests/runtime-connect.integration.mjs`: integração manual com Studio vivo.
- Testes que pulam sem insumo local: `debug-*-golden` sem `SSAM_DEBUG_EVIDENCE_ROOT`; `ScreenHtmlCoverage*` sem as capturas do corpus;
  `manifest-inspect`, `discovery-prototype` e `root/css-key-native` sem a CLI compilada (o `build` do portão a compila);
  `ssam-code` aplica os exemplos da gramática só com `SSAM_CODE_CLI_O11`/`SSAM_CODE_CLI_ODC`.

## 6. Achados desta frente

- Regressões do lote 1: o builder ODC não compila e o Placeholder ODC é recusado (seção 2); o lote 2 corrige as duas. O lote 2 traz 6
  regressões na fachada, no discover (seção 7). Nenhuma suíte compila o builder. Só o `setup-dev` o compila, e por isso o portão começa por ele.
- A fachada depende dos selos de job que as suítes do kernel gravam: a ordem importa (seção 1).
- Os testes nativos voltam cedo como aprovados sem o Studio. O mesmo vale para `XifInstalledEngineTests` sem Integration Studio e para os testes
  de corpus sem as capturas. Por isso o portão recusa rodar o kernel sem o Studio da plataforma.
- `TimerScheduleTests` compila só em `Anvil.Tests`, então o ramo ODC (CronSchedule) nunca roda. `jobs-negative/logic-unused-input` não é rodado por
  nenhum teste. Quatro jobs negativos sem `expectError` são pulados pelo `NegativeJobTests` e rodados por outras classes.
- Lacunas mais largas da matriz: Data Fabric sem prova nenhuma; SOAP no ODC só com a recusa; recusas de client entity (local DB) sem prova nas
  duas faixas. Apagar tema, bloco O11, tela Traditional e tela Mobile só aparece em jobs de cobertura, que passam apenas pelo preflight.
  Publicação, Service Center, Portal ODC, preview e debug não têm prova automatizada além do simulado.

## 7. Lote 2 contra a linha de base

Rodada `full` de 24/10 20:02 a 25/10 00:26 sobre `d4cf05a6`: o merge de `integracao/primeira-certa` em `7b04def0` (lote 2) neste branch.
O `build` do portão recompilou as CLIs. Comparação feita com `node scripts/gate/compare-runs.mjs .local/gate/base-0388bd65 .local/gate/lote2-7b04def0-full`.

| Suíte | Total 0388bd65 | Total lote 2 | Falhou 0388bd65 | Falhou lote 2 | Instável 0388bd65 | Instável lote 2 | Tempo lote 2 |
|---|---|---|---|---|---|---|---|
| build | 7 | 7 | 1 | 0 | 0 | 0 | 38 s |
| kernel O11 | 4.260 | 4.282 | 69 | 69 | 3 | 3 | 2h37 (repetição: segundos) |
| kernel ODC | 1.404 | 1.422 | 7 | 4 | 0 | 1 | 1h34 |
| fachada | 6.297 | 6.333 | 23 | 27 | 5 | 10 | 8 min 46 s + 3 min de repetição |

Veredito do portão sobre o lote 2: **falha**, com 6 falhas fora da lista. Todas são regressões do lote 2 e todas estão na fachada.

**Apareceram (6, regressões do lote 2).** Passam em `0388bd65` e falham em `d4cf05a6` nas duas rodadas e também a sós, sem carga, em 25/10.
Ficam de propósito fora da lista, para o portão bloquear a ativação até a integradora decidir. Primeira linha do erro de cada uma:

| Teste (platforms/odc/facade/tests) | Primeira linha do erro |
|---|---|
| `catalog-a-actions` [o11] typed variables and their reset ... | `o11: {"minimalBytes":12148}` |
| `catalog-a-flow` [odc] English intents of the theme select logic.flow ... fit the budget | `odc insert an execute server action node in the middle of an existing flow` |
| `catalog-a-flow` [o11] (idem) | `o11 insert an execute server action node in the middle of an existing flow` |
| `catalog-a-lexicon` [odc] critical composed scenario (en2): within 12000 bytes ... | `insufficient: minimal 12005 ["logic.flow:match","logic.variable:match","logic.server-action:match"]` |
| `catalog-a-lexicon` [o11] (idem) | `insufficient: minimal 12042 [...]` |
| `catalog-a-refactor` [odc] refused cases answer with the declared status ... | `structure attributes are reordered by a proof of this lane` |

Cinco delas são a resposta mínima do discover passando do orçamento de 12.000 bytes por 5 a 148 bytes. A sexta é a prova ODC de reordenar
atributos de estrutura, que deixou de ser citada. As duas causas batem com o commit `7b04def0` (R4: "provas compactas e cortadas primeiro").

**Sumiram (6, regressões do lote 1 corrigidas).** `Build: builder ODC`; na fachada, `discovery` e `resident-reading`; no ODC, `delete-block`,
`block-reuse` e `widget-placeholder-minimal`. As entradas saíram da lista.

**Iguais (94).** O11 69 (52 ScreenCoverage, catálogos, FilterBar, `'User'` e as preexistentes), ODC 4 e fachada 21. Duas mudaram de
classificação depois que o builder voltou a compilar:
- `manifest-inspect` (2) agora falha por `ENOENT ... ssam-test-profile-*\andre\AppData\Local\Anvil\authority\bridge.key`: o perfil isolado
  não põe a chave onde a leitura a procura. Falha igual em `3e461d02`: **preexistente**. Antes ficava escondida pelo builder.
- `lanes` falhou nas duas rodadas do portão, inclusive na repetição a sós com outras suítes rodando, mas passa a sós sem carga: **ambiente (instável)**.

**Instáveis do lote 2 (14, passaram a sós).**
- O11: `DeliveryStallTests` (refresh_references), `AppBoundaryTests` (leaveThroughTool) e `FamDepsReferenceTests` (rollback).
- ODC: `OdcJobTests.TheWorkerSpareIsTheSameModelAsAFreshLoad`.
- Fachada: `call-deadline` (3), `call-deadline-default`, `call-publish-summary`, `context-budget-debug-spawns`, `debug-surface-proof` (3)
  e `warm-start`. São testes de prazo e processos filhos sob carga.

## 8. Confirmação pós-ativação (36af9c13, 25/10)

`prova/proto` e `integracao/primeira-certa` em `36af9c13`: lotes 1, 2 e 3 mais este portão. Rodada `full` das 02:59 às 06:58, CLIs
recompiladas pelo `build`, comparada com a rodada do lote 2 (`compare-runs.mjs .local/gate/lote2-7b04def0-full .local/gate/ativ-36af9c13-full`).

| Suíte | Total lote 2 | Total 36af9c13 | Falhou lote 2 | Falhou 36af9c13 | Instável lote 2 | Instável 36af9c13 | Tempo |
|---|---|---|---|---|---|---|---|
| build | 7 | 7 | 0 | 0 | 0 | 0 | 37 s |
| kernel O11 | 4.282 | 4.319 | 69 | 69 | 3 | 2 | 2h21 |
| kernel ODC | 1.422 | 1.447 | 4 | 4 | 1 | 0 | 1h30 |
| fachada | 6.333 | 6.355 | 27 | 21 | 10 | 6 | 5 min 45 s + 2 min de repetição |

Veredito: **passa**, sem falha fora da lista e sem regressão aberta (`--strict` também passa).

- **Apareceram:** nenhuma.
- **Sumiram (6):** as 6 regressões `catalog-a-*` do lote 2 (orçamento do discover e prova ODC de reordenar atributos).
- **Iguais (94):** as mesmas da seção 7, todas na lista: 70 de ambiente e 24 preexistentes.
- **Instáveis (8, passaram a sós):**
  - O11: `DeliveryStallTests` (pingMode malformed) e `HotModuleWarmTests`.
  - Fachada: `call-deadline` (2), `call-deadline-default`, `call-publish-summary` e `debug-surface-proof` (2).

O `full` não confirma duas falhas vistas no `quick` da integradora. Por isso elas não entram na lista:
- `debug-app-user-vault` e `service-center-download` passam (31 e 20 testes) com o `TEMP` privado padrão do portão, sob
  `%LOCALAPPDATA%\Temp\sg`. A falha por ACL depende da pasta passada em `--temp`. Use uma pasta sob `%LOCALAPPDATA%\Temp`, que herda as ACLs
  do usuário.
- Os `catalog-a-*` [odc] passam no `full`, porque `OdcJobTests` grava os selos antes da fachada. No `quick` eles leem selos de outro HEAD.
  É a condição da seção 1: rode um `full` no HEAD antes de usar o `quick` no mesmo worktree.
