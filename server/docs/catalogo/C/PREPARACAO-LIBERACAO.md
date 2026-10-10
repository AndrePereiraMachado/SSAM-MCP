# Preparação da liberação (M4) — contribuição da Frente C

Estado: **documento preparatório.** Não é autorização de liberação, não descreve uma liberação feita e não substitui a
decisão da integradora, responsável pela liberação final e pela integração deste texto. Escrito em 24/09/2026
(~02:30Z) só com leitura de código, configuração e documentos, sem iniciar servidores, CLIs, MCP, Studio ou workers.

Fontes lidas:
- branch `claude/catalog-integration` em `dc479aa`;
- checkout C (`claude/catalog-c`, com a integração até `f0a1e3d`);
- raiz operacional `C:\Users\andre\SSAM-Hybrid` (OP): código, configuração e documentos, sem abrir segredos;
- pacote de coordenação (`PLANO.md`, `control/INTERFACE.md`, `control/reports/integrator.md`, `DECISOES.md`).

Nenhum valor de versão final aparece aqui: o candidato de M4 ainda não foi congelado (§6).

Documentos existentes que este texto reutiliza e não repete:
- guia da versão funcional: `OP\docs\USAR-VERSAO-FUNCIONAL.md`;
- histórico e procedimento da estabilização: `OP\.local\stabilization\20260919-stage1\candidate\docs\ESTABILIZACAO-LIBERACAO.md`;
- integração e ativação da descoberta: `docs/DESCOBERTA-CONTEXTUAL.md` §6;
- fricção: `docs/FRICCAO-AUTOMATICA.md`;
- protocolo de M3: `docs/evidence/catalogo-abrangente/eval/PROTOCOL-draft.md`.

## 0. Resumo

1. **Mecanismo de liberação existente = seleção explícita de pacote** (`ssam package select|run|mcp`). O seletor é
   `package-session.mjs` do pacote r3, e o apontador é `OP\.local\releases\active-readonly.json`. Foi com ele que a
   versão funcional saiu em 20/09 (pacote `readonly-2d8facfa2c136a73`, servidor MCP opt-in `ssam-functional`). O
   padrão r3 (`readonly-b8aa6086124b37f6`) ficou preservado e o retorno é "omitir a seleção". **Não há comando público
   de ativação nem de rollback do apontador.** Os scripts de ativação R4 existem só em laboratório e nunca rodaram.
2. **O mecanismo não carrega o candidato do catálogo tal como é.** O perfil é somente leitura: operações `help`,
   `version`, `doctor`, `inspect`, `diagnostics` e `delivery-status`, sem `discover`, sem jobs e sem entrega. O que o
   catálogo entrega (descoberta, contratos e condução nas falhas de job) está na fachada e nas CLIs. Por isso há uma
   decisão de rota pendente para a integradora (§2.3), e nenhuma das opções está provada para este candidato.
3. **Estado observado hoje:**
   - O servidor `ssam` do projeto roda a fonte operacional. OP está em `codex/unified-repository`, HEAD `ba83b0e`, com
     cerca de 160 entradas locais não commitadas, e não tem `ssam_discover`.
   - Os pacotes r3 e r5 fixam o hash de três DLLs do ODC Studio que mudaram com a atualização automática para
     1.7.25.10778. Pelo código do seletor, `package run` e `package mcp` recusam ("dependência externa mudou"). Isso é
     coerente com `ssam-functional` e `ssam-headless-selected` em `CONNECTION_CLOSED` nesta sessão, mas a causa não foi
     observada em execução.
   - A configuração MCP do usuário (fora do projeto) tem um `ssam` que aponta para um checkout antigo
     (`C:\Users\andre\SSAM-Hybrid-ODC`).
4. **Telemetria:** a fricção do lançador mede o tempo das chamadas da ferramenta por tarefa, quando há id de tarefa. O
   journal ODC não tem tarefa nem versão. O tempo total da sessão e as leituras fora da ferramenta só saem das
   transcrições (§4).
5. **M3 ainda não congelou:** não há `FREEZE.json`, não há protocolo final e nenhuma sessão rodou. Nada de "tarefa
   completa avaliada" nem "ganho de tempo medido" pode ser afirmado hoje (§5).

## 1. Mapa das entradas e das versões selecionadas

### 1.1 Entradas CLI

| Entrada | O que chama | Raiz e ambiente | Camada |
|---|---|---|---|
| `ssam.cmd` / `odc.cmd` (em qualquer checkout) | node do runtime Codex, ou `node` do PATH se ele faltar → `facade\ssam.mjs` ou `facade\odc.mjs` → `facade\launch.mjs` | A raiz é a pasta do `launch.mjs`, não o cwd (`launch.mjs:7`). O lançador **sobrescreve** `ANVIL_ROOT` (`<raiz>\kernel`), `SSAM_HYBRID_ODC_ROOT`/`ANVIL_ODC_ROOT`/`ODC3_ROOT` e as portas de worker a partir do `.ssam-workspace.json` da raiz; `ANVIL_LANE` vem do ambiente, senão de `o11Lane` (`launch.mjs:9-16`) | fonte no disco |
| `launch.mjs` → `friction` | `facade\friction-cli.mjs` (consulta à fricção) | — | fonte no disco |
| `launch.mjs` → `package run` com apontador ativo | `facade\package-route.mjs`: confere os hashes do módulo e da seleção do apontador e importa o `package-session.mjs` do pacote no mesmo processo (`package-route.mjs:10-45`) | `package run` limpa `ANVIL_*`, `SSAM_*` e `ODC3_*` e usa a raiz do pacote (`package-session.mjs:217-221`) | pacote selecionado |
| Os demais verbos | Processo filho `node platforms/odc/facade/<ssam|odc>.mjs` com `cwd = raiz` (`launch.mjs:48-52`) | Pelo lançador: faixa O11 = `ANVIL_LANE` ou `o11Lane` (ss4). Chamada direta a `lanes.mjs` fora do lançador cai em `ss5` na OP (`lanes.mjs:21`) | fonte no disco |
| `ssam discover` / `odc discover` | Só nos checkouts do catálogo (`platforms/odc/facade/discovery.mjs`); **ausente na OP** | Índice em `platforms/odc/.local/discovery/<faixa>/` do checkout | fonte no disco |
| `ssam job --lane <faixa>` | `python kernel/scripts/run_job.py [--lane odc]` (`lanes.mjs:81-83`) → CLI da faixa (`kernel/.local/cli/anvil.dll` ou `kernel/.local/lane-odc/cli/anvil-odc.dll`) | CLIs geradas, não versionadas; nos checkouts do catálogo, distribuídas pela integradora com hash conferido (D-M1-3) | binários lidos a cada chamada |
| `kernel/scripts/lanes.py [ss4|ss5] --json` | Portas, caminhos da CLI O11 e diretório do Studio da faixa | `.ssam-workspace.json`; a faixa vem do argumento, senão de `ANVIL_LANE`, senão ss4 | fonte no disco |

### 1.2 Servidores MCP configurados (lidos, não iniciados)

| Onde | Nome | Comando | Código servido |
|---|---|---|---|
| `.mcp.json` versionado (idêntico na OP e nos checkouts do catálogo, D-M0-8) | `ssam` | `node C:\Users\andre\SSAM-Hybrid\facade\ssam.mjs mcp`, com `ANVIL_LANE` e o tenant da sessão | **fonte da OP**, mesmo quando a sessão está numa worktree do catálogo |
| idem | `ssam-headless-selected` | `… facade\ssam.mjs package mcp` (seleção do apontador = r3) | pacote r3 |
| idem | `ssam-functional` | `… package mcp --selection …\sessions\stage1-functional-r5-r2\selection.json --sha256 <hash>` | pacote r5 (bootstrap r3) |
| Configuração do usuário (Claude Code, nível usuário) | `ssam` | `node C:\Users\andre\SSAM-Hybrid-ODC\facade\ssam.mjs mcp`, com `ANVIL_ROOT` e faixa `ss5` | **checkout antigo** |
| `.mcp.json` do candidato de estabilização | `ssam` | fonte do candidato de estabilização | candidato de estabilização |

Qual `ssam` responde numa sessão depende da precedência do cliente entre configuração de projeto e de usuário, que
**não foi verificada**. Nesta sessão, a lista de ferramentas trazia `ssam_friction` (injetada só pelo lançador raiz)
e não trazia `ssam_discover`: por inferência, respondeu o `ssam` do projeto, com a fonte da OP.

### 1.3 Três camadas: fonte no disco, pacote selecionado, processo já carregado

| Camada | O que é | Quando uma mudança passa a valer |
|---|---|---|
| **(a) Fonte no disco** | JS da fachada (`facade\`, `platforms\odc\facade\`), scripts Python do kernel, CLIs e DLLs chamadas uma vez por comando (cliente do bridge, builder, `anvil*.dll`) | CLI: na próxima invocação. MCP: só num processo novo (o módulo carregado fica em memória). O builder se recompila sozinho quando as fontes estão mais novas que a DLL (`lib.mjs`, `ensureBuilder`) |
| **(b) Pacote selecionado** | Diretório `OP\.local\releases\<pacote>` com descritor `ssam-package/1`: `files[path, sha256]`, `lanes`, `components`, `capabilities`, `dependencies` (hashes das DLLs do Studio instalado), e seleção `ssam-package-selection/1` | Pela seleção explícita (`--selection`/`--sha256`) ou pela troca do apontador. O seletor revalida descritor, arquivos e dependências antes e depois de cada operação; um processo já carregado recusa bytes diferentes (`package-route.mjs:42-44`) |
| **(c) Processo já carregado** | Servidor MCP (node) e proxy O11 `ssam_app.py`; workers O11 e ODC (prendem as DLLs de `kernel\.local\...\cli`); leitor residente (troca de geração por hash); bridge ODC dentro do Studio (versão esperada fixada no cliente) | Só com reinício ou reconexão: reconectar o MCP, reiniciar o worker, anexar outra versão do bridge. Sessões abertas conservam o que carregaram |

### 1.4 Seleção atual (fatos de hoje, OP)

- **Apontador** `active-readonly.json` (`ssam-readonly-activation/1`, `activatedAt` 2026-09-19T20:45Z): módulo
  `stage1-readonly-r3\scripts\package-session.mjs`, seleção `sessions\stage1-readonly-r3`, pacote
  `readonly-b8aa6086124b37f6`, escopo "headless-readonly; existing entries and sessions preserved".
- **Versão funcional:** a seleção `sessions\stage1-functional-r5-r2\selection.json` para o pacote
  `readonly-2d8facfa2c136a73` é opt-in, pelo servidor `ssam-functional` ou pela CLI (`USAR-VERSAO-FUNCIONAL.md:18`).
- **Dependências fixadas:** as três DLLs do ODC Studio (`OutSystems.Model`, `.Definition`, `.Implementation`) têm hash
  diferente do fixado no descritor r3; as duas do O11 batem. O ODC Studio instalado é 1.7.25.10778 e se atualiza
  sozinho.
- **Fricção da OP:** `package run --operation version` com `OPERATION_FAILED` em 22/09 e 23/09. A causa textual não é
  guardada; a última `version` MCP bem-sucedida foi em 20/09.

## 2. Procedimento proposto (para decisão da integradora)

Marcação usada: **[L]** = comando ou comportamento comprovado por leitura de código ou documento neste checkout ou na
OP; **[P]** = exige prova operacional ainda não feita; **[D]** = decisão da integradora ou do usuário. Nenhum passo
abaixo foi executado para este candidato.

### 2.1 Identificar o candidato avaliado, os artefatos e as dependências

1. **Congelar em M3** (§5.3) com a ferramenta existente [L]: `node docs/evidence/catalogo-abrangente/eval/freeze.mjs`
   no checkout de integração, que grava `eval/FREEZE.json`:
   - commit, branch e arquivos sujos;
   - sha256 das CLIs e dos kernels das duas faixas, de `discovery.mjs`, `catalog.mjs`, `job-guidance.mjs`,
     `platforms/odc/facade/ssam.mjs`, `mcp.mjs` e `launch.mjs`;
   - descritores, `ownership.json`, `DESCOBERTA-CONTEXTUAL.md`, os `AGENTS.md` e o `CLAUDE.md`;
   - cada fragmento A/B/C, as bases, o protocolo, o oráculo e as referências;
   - a versão do node e, por faixa, `ideVersion`, `kernelSha256`, jobs e `indexKey` do índice.

   **O candidato de M4 é o identificado por esse `FREEZE.json`**, e não um HEAD posterior.
2. **Artefatos do candidato** (a conferir contra o `FREEZE.json`):
   - **versionados:** fachada (`platforms/odc/facade/*.mjs`, `facade/*.mjs`), descritores e fragmentos, `ownership.json`,
     inventário reconciliado, guias;
   - **gerados, não versionados:** `kernel/.local/cli` e `kernel/.local/lane-odc/cli` (distribuídos com hash, D-M1-3),
     resultados carimbados `*/test-work/*.result.json` (ODC 76, O11 85 em `dc479aa`), builder compilado
     (`platforms/odc/studio/builder/bin`), cache do índice, leitores residentes;
   - **externos:**
     - ODC Studio instalado, hoje 1.7.25.10778; a identidade entra no índice e nos carimbos;
     - Service Studio da faixa O11, "Service Studio 11 - Anvil 4516" 11.55.87;
     - node v24.19.0 do runtime Codex e dotnet 10.0.401;
     - bridge ODC na versão esperada pelo cliente.
3. **Lacunas de cobertura do congelamento** [L; D]. O `freeze.mjs` **não** registra:
   - `lib.mjs`, `lanes.mjs`, `kernel-reading.mjs` e `reader-client.mjs`;
   - `kernel/scripts/run_job.py`, que é o caminho de `ssam job`;
   - `ODC3.Builder.dll`, o leitor de `inspect` ODC;
   - `.ssam-workspace.json`.

   Proposta à integradora: incluí-los, ou declarar que ficam fora da identidade do candidato.

### 2.2 Conferir compatibilidade

1. **Runtime** [L]: o bloco `identity` de `.\ssam discover "<intenção>" --lane odc` e `--lane o11` traz o Studio medido
   (`ideVersion`, assemblies comparados) e o resultado de jobs `current`/`historical`. Critério: todas as provas citadas
   atuais nas duas faixas com as CLIs do candidato. Uma atualização automática do ODC Studio torna as provas históricas
   e muda o hash da CLI compilada contra ele (histórico de 22 e 23/09): se isso acontecer entre o congelamento e a
   disponibilização, o candidato perde a identidade avaliada [P].
2. **Fonte operacional versus candidato** [L; P]. A OP tem cerca de 160 entradas locais sobre `ba83b0e`; o candidato
   descende de `7a10686`. Levantamento só de leitura, a fazer no momento da liberação:
   - `git -C C:\Users\andre\SSAM-Hybrid status --short`;
   - `git -C C:\Users\andre\SSAM-Hybrid diff --stat` e a comparação por hash dos arquivos da fachada contra o
     `FREEZE.json`.

   Na comparação por conteúdo feita nesta preparação, só `package-route.mjs`, `friction-boundary.mjs`,
   `.ssam-workspace.json` e `.mcp.json` coincidiram entre OP e integração. Trocar a fonte da OP sem esse inventário perde trabalho local do usuário.
3. **Contrato de uso** [L], mudanças de comportamento que o guia final deve declarar:
   - o validador de verbos recusa chave desconhecida antes de tocar o modelo (`DESCOBERTA-CONTEXTUAL.md` §2.1);
   - a resposta da descoberta é `ssam-discovery/4`;
   - falhas de job devolvem `discovery` (`ssam-job-guidance/1`, D-M2-1);
   - jobs privados fora do repositório devem ser provados na fixture antes de usar.
4. **Processos vivos** [P]:
   - versão do bridge anexado (`studio_doctor`: `bridge attached{expected, upToDate}`);
   - worker ODC na porta operacional;
   - leitor residente;
   - sessões MCP abertas.

   Nenhum deles muda sozinho.

### 2.3 Disponibilizar para uma sessão nova — opções (decisão [D], nenhuma provada para este candidato)

| Opção | Base existente [L] | Encaixe no candidato | Pendências |
|---|---|---|---|
| **A. Pacote por seleção explícita (opt-in)**, como a versão funcional | `ssam package select --package <descritor> --sha256 <hash> --session <diretório novo>`; `ssam package run --selection <s> --sha256 <h> --operation version\|help\|doctor\|inspect…`; `ssam package mcp --selection <s> --sha256 <h>` (`package-session.mjs:239-262`); retorno = omitir a seleção (`ESTABILIZACAO-LIBERACAO.md`, "Como usar agora") | O perfil do seletor é **somente leitura**, sem `discover`, jobs ou entrega: não serve a descoberta sem que a integradora amplie as capacidades do descritor. Os pacotes atuais estão inválidos pela mudança das DLLs do ODC Studio | Gerar o descritor do candidato: `distribute-readonly-package.mjs` do candidato de estabilização existe, mas **as flags não foram verificadas**. Decidir capacidades e dependências fixadas. Ensaio [P] |
| **B. Fonte operacional atualizada** (`DESCOBERTA-CONTEXTUAL.md` §6) | Fase 1: aplicar commits, compilar a CLI em `cli-<commit>`, testes focados e suíte. Fase 2: guardar `cli` em `cli-prev-<data>`, parar o worker ODC, copiar, reiniciar, smokes com `ssam discover` e MCP novo | Serve a descoberta e os jobs, mas muda o padrão de **todas** as sessões novas da OP e mexe na fonte com trabalho local | Inventário de §2.2.2; janela com worker parado e reconexão do MCP [P]; o retorno (restaurar `cli-prev`, `git revert`) **nunca foi ensaiado** e não confere hash automaticamente |
| **C. Checkout do candidato como raiz de uma sessão nova** (padrão do candidato de estabilização, que tinha `.mcp.json` próprio) | O lançador resolve a raiz pela própria pasta (`launch.mjs:7`), e cada checkout do catálogo tem CLIs, carimbos e portas próprios (`BASELINE.json`) | Isola o padrão da OP, e o retorno é voltar a usar a entrada anterior. Hoje o `.mcp.json` versionado aponta para a OP (D-M0-8): uma sessão nesse checkout ainda serve a OP pelo MCP | Entrada MCP própria para o candidato é **configuração de MCP** [D]; escrita externa, merge ou publicação a partir dessa raiz exigem decisão própria; ensaio [P] |

Proposta da C, sem autorizar nada: começar por uma forma **opt-in**, A ou C, com o padrão r3 e as sessões existentes
intocados, pelo precedente de 20/09. A troca do padrão (B, ou o apontador) fica para depois de um ensaio de ida e volta
com recibo.

### 2.4 Verificar a identidade e as capacidades carregadas numa sessão nova

- **Rota A** [L]: `version` pela CLI e `ssam_version` pelo MCP devolvem `packageId`, `packageSha256`, `selection`,
  `host{path, sha256, pid, loadedAt}`, `components{selected, onDisk, loaded, verified}` e `mcp{selected, loaded,
  verified, otherSessions}`. É a única saída hoje que prova o que o próprio processo carregou.
- **Rotas B e C** [L; lacunas]:
  - `ssam_doctor` e `studio_doctor` dão raízes, caminhos e bridge, mas **nenhum commit nem hash da fachada**;
  - o bloco `identity` de `discover` dá hash da CLI e do kernel, Studio, descritor, fragmentos e provas;
  - a lista de ferramentas deve conter `ssam_discover`;
  - a fricção registra `toolingSha256`, que cobre só 9 arquivos da fachada e, no MCP, é calculado no arranque.

  **Não existe** hoje uma saída que ligue o processo MCP carregado a um commit da fachada: registrar essa lacuna, sem
  prometer a verificação.
- **Capacidades** [L]: o MCP `ssam_discover` sem `intent` nem `expand`/`detail` lista as capacidades da faixa
  (`DESCOBERTA-CONTEXTUAL.md` §1). Comparar com o `FREEZE.json` (fragmentos e descritores).

### 2.5 Voltar à seleção anterior

- **Rota A** [L]: omitir `--selection`/`--sha256` nas próximas chamadas, ou voltar à seleção anterior, e reconectar o
  MCP. Foi provado em 20/09 para o r5, com o apontador observado antes e depois. O apontador só muda por script de
  laboratório (R4, nunca executado).
- **Rota B** [P]: restaurar `kernel/.local/lane-odc/cli` a partir de `cli-prev-<data>` com o worker parado, e
  `git revert` da fachada. Nunca ensaiado; sem conferência de hash embutida.
- **Rota C** [L]: deixar de usar a entrada do candidato; a OP não foi tocada.

Para todas: **sessões já abertas conservam a versão que carregaram**, e voltar não desfaz alterações feitas em apps.

## 3. Guia curto para trabalho real (a completar com os valores do congelamento)

1. **ODC:** o usuário abre o ODC Studio e o módulo. Confira com `.\odc doctor` ou `studio_doctor`: Studio em execução,
   bridge anexado com `upToDate`, catálogo de assets. Anexar o bridge (`studio_attach`) carrega uma DLL no Studio do
   usuário e só acontece por decisão dele.
2. **O11:** o Service Studio da faixa é o clone "Service Studio 11 - Anvil 4516" (`o11Lane` ss4 no
   `.ssam-workspace.json`). `.\ssam doctor` mostra as duas faixas lado a lado.
3. **Confirmar a versão em uso:**
   - na rota A, `ssam_version` ou `package run --operation version`, comparando com o `packageId` publicado;
   - nas rotas B e C, o bloco `identity` de `ssam discover` (`cli`, `kernel`, `studio.ideVersion`) comparado com o
     `FREEZE.json`, mais a presença de `ssam_discover`.

   Se o valor não confere, a sessão está noutra versão. Reconecte ou abra uma sessão nova; não há atualização automática
   de sessões abertas.
4. **Usar a descoberta**, onde existir:
   - `.\ssam discover "<intenção que nomeia elemento e operação>" --lane odc|o11 --budget 12000`;
   - depois `--expand <id>:operations+native+contract+example+evidence`;
   - `--app <captura.oml>` só com captura; o nome de um módulo fala com o Studio vivo;
   - leia `focus`, `operations.<op>.roles.<papel>.<faixa>` (estado e evidência) e `unavailable` antes de agir;
   - uma falha de `ssam job` devolve o contrato e o próximo passo (`discovery`).

   A OP de hoje **não** tem esse verbo.
5. **Entrega e publicação** seguem os gates existentes (`deliver.job`, `deliver.publish`, as palavras do usuário).
   Resultado incerto se reconcilia pelo recibo, nunca repetindo.

## 4. Telemetria existente

### 4.1 O que registra operações, falhas e versão

| Fonte | Onde | O que grava | Tarefa / operação | Versão |
|---|---|---|---|---|
| **Fricção do lançador** | `<raiz>\.local\friction\operations\<operationId>.start.json` / `.end.json` | Por chamada que passa pelo lançador raiz (CLI `ssam`/`odc` e os servidores MCP do `.mcp.json`): `operation`, `lane`, `interface`, `profile`, `startedAt/endedAt/durationMs`, `outcome`, `code`, `step`, `exitCode`; nunca argumentos, saídas ou bytes (`friction-store.mjs:84-114`) | `operationId` (UUID), `sessionId` por processo lançador, `taskRef` = hash do id de tarefa quando existe (`SSAM_TASK_ID`, `_meta["ssam/taskId"]` ou `task_id` no MCP), `correlation` | `toolingSha256` (9 arquivos da fachada), pacote selecionado; `versionScope` declara que a identidade dos binários nativos não é observada |
| **Journal ODC** | `platforms\odc\journal\operations.jsonl` | Bridge, builder e fachada (inspect, portal CLI, deliver-job, debug): `ts_start`, `ts_end`, `session`, `tool`, `command`, `module`, `module_key`, hashes de base/candidato, `studio_pid`, `outcome`, `gate`, `evidence_dir`, `note`, `feature`; na integração também `file`, `source_sha256`, `failed` (`Journal.cs:13-17`, `lib.mjs:31-39`) | Só `session` = `<ferramenta>-<pid>`; sem tarefa nem operationId | nenhuma |
| Recibos de entrega | `platforms\odc\lab\<NN>-<feature>\` (manifest, check-base, preview, merge-started, receipt, publish-*, last-error, deliver-result) | Por entrega | O diretório é o id; a fricção liga-se a ele por hash só na entrega por job | `kernel-result.provenance` só na rota de job |
| Leitura O11 | `<kernel>\.local\reading\operations.jsonl` | `at`, `command`, `outcome`, `file`, `sourceSha256`, `timings` | nenhuma | só o hash da captura |
| Depurador | `.local\debugger\<sessionId>\` (manifest, receipt, lock) e linha no journal ODC | Por start/status/stop | `sessionId` do depurador | nenhuma |
| Proveniência de job | Dentro do resultado de cada `apply` (`anvil-job-provenance/2`) | Job, base, fixture, `kernelSha256`, Studio e assemblies | nenhuma | **sim**: kernel e Studio |
| Entrega e dados O11 | `deliver\<taskId>\task.json|result.json`; recibos `DataReceipt` (`pending` → `completed`) | Por tarefa e por escrita | `taskId`, `operationId` | nenhuma |
| Invólucros de avaliação | `eval\attempts\<sessão>\journal.jsonl` (`lab.mjs`) | Por chamada pública: verbo, argumentos, `ms`, `bytes`, `exit` | Sessão = pasta | coberta pelo `FREEZE.json` |

### 4.2 Como correlacionar uma tarefa e onde consultar

- **Consulta** [L]: `ssam friction issues [--task-id <id>]`, `ssam friction task --task-id <id>`,
  `ssam friction state` (`friction-cli.mjs`), e pelo MCP `ssam_friction {view: issues|task, taskId}`. As consultas não
  são registradas.
- **Correlação só existe com id de tarefa explícito.** Na OP, entre 20/09 e 24/09, 1051 das 1052 operações MCP ficaram
  com `correlation: absent`. Sem id, as operações agrupam por processo (`sessionId`), que no MCP é o servidor inteiro,
  não a conversa.
- O journal ODC **não** se liga à tarefa: não tem id, e o pid gravado é o do processo filho, do Studio ou do builder,
  diferente do pid do lançador.

### 4.3 O que se pode medir e o que não

| Medida | Fonte | Limite |
|---|---|---|
| **Tempo das chamadas da ferramenta** por tarefa: `operationCount`, `toolDurationSumMs`, `toolCoveredWallMs` (união), `observedSpanMs`, `intervalOutsideCompletedToolsMs` | `ssam friction task` | Só com o mesmo id de tarefa e só pelo lançador raiz. **Não é tempo total** (a própria ferramenta o diz) |
| Duração por comando nativo | `ts_start`/`ts_end` do journal ODC | Sem ligação à tarefa; linhas antigas do leitor sem `ts_start` |
| **Tempo total da sessão** | Só transcrições do cliente (`measure-transcripts.mjs` da rodada r3) ou primeiro e último registro de um invólucro de avaliação | A fricção não mede |
| **Leituras fora da ferramenta** (Read/grep, docs, internals) | Só transcrições | Não passam por fricção, journal nem invólucro (o protocolo de M3 o reconhece) |
| Bytes por chamada | Só invólucros de avaliação e transcrições | **Não existe** na fricção nem no journal |

Não existe hoje, e não se promete:
- `discover` não tem journal próprio: cai como `other` na fricção, assim como `consumers`, `latest`, `wait`,
  `dismiss-dialog` e `command`;
- nenhum journal carrega versão, fora o `toolingSha256` parcial e a proveniência do kernel;
- `transportSucceeded` fica `false` em chamadas MCP;
- não há ligação entre journal e tarefa.

## 5. Critérios de liberação e de retorno, verificações rápidas e dependências de M3

### 5.1 Quatro eixos que não se somam

| Eixo | Evidência exigida | Estado hoje (sem valores finais) |
|---|---|---|
| **Contrato presente** | Capacidade, papel e operação na resposta pública, com rota; lacunas e recusas declaradas | Presente nos fragmentos integrados. `catalog-check --all` sem erros em `dc479aa` (pendências de A e B conforme o relatório da integradora) |
| **Prova atual** | Carimbo `anvil-job-provenance/2` igual à identidade corrente (CLI, kernel, Studio, base) | ODC 76/76 e O11 85/85 atuais na distribuição de 01:22Z. Muda com o Studio ou com o kernel |
| **Tarefa completa avaliada** | Sessões independentes de M3 sobre o candidato congelado; oráculo aprova o resultado final | **Não feito**: sem congelamento nem sessões |
| **Ganho de tempo medido** | Comparação válida (controle ou referência) com a mesma métrica | **Não medido**. Nem a versão funcional de 20/09 comprovou ganho (metas de desempenho reprovadas) |

Um eixo nunca substitui outro: contrato não é prova, prova não é tarefa completa, e tarefa completa não é ganho de
tempo.

### 5.2 Critérios propostos

**Para liberar por opt-in** [D]:
- `FREEZE.json` publicado;
- M3 e T3 concluídos conforme `TESTES-E-EVIDENCIAS.md`;
- `catalog-check --all` sem erros, sem aviso de dono e sem `requires` pendentes de A (D-M2-6);
- compatibilidade de §2.2 registrada;
- rota escolhida em §2.3 com retorno descrito e ensaiado uma vez com recibo;
- guia de §3 com os valores reais;
- autorização do usuário nas suas palavras. Hoje `QUADRO.json` tem `release.operationalActivationAuthorized: false`.

**Para trocar o padrão** (apontador ou fonte da OP), além disso:
- inventário das mudanças locais da OP e decisão sobre elas;
- ida e volta do padrão ensaiada;
- janela sem entregas em curso;
- nenhuma sessão migrada sem aviso.

**Para retornar:** qualquer uma destas dispara o retorno à seleção anterior, com recibo:
- identidade verificada diferente do `FREEZE.json`;
- provas que ficaram históricas (Studio atualizado);
- falha de dependência fixada;
- regressão num smoke combinado;
- resultado incerto de escrita sem recibo reconciliável.

### 5.3 Verificações rápidas propostas

Todas são comandos que existem; nenhuma foi executada para M4:

| Verificação | Comando | O que decide |
|---|---|---|
| Identidade do candidato | `git -C <checkout> rev-parse HEAD`; `Get-FileHash` das CLIs contra o `FREEZE.json` | É o candidato avaliado? |
| Consistência do catálogo | `node platforms/odc/facade/catalog-check.mjs --all` | 0 erros e contabilidade fechada |
| Provas atuais e Studio | `.\ssam discover "<intenção>" --lane odc` e `--lane o11` (bloco `identity.jobs`, `studio`) | Provas ainda atuais? |
| Contabilidade da C conforme as regras | `node docs/catalogo/C/contabilidade-c.mjs --check` (não escreve) | Sem deriva da C |
| Estado das faixas | `.\ssam doctor` | Raízes, CLIs e Studios |
| Pacote (rota A) | `.\ssam package run --selection <s> --sha256 <h> --operation version` | Identidade carregada e dependências |
| Registro da tarefa | `.\ssam friction task --task-id <id>` | Operações e tempo de ferramenta da tarefa |

### 5.4 Dependências de M3 (fatos em `dc479aa`)

- `PROTOCOL.md` final **ausente** (há só `PROTOCOL-draft.md`; os pedidos de S2 e S3 ainda são "esboço").
- `FREEZE.json` **ausente**; as bases não estão instaladas em nenhum checkout (`prove.mjs --install` só copia a base
  aceita para `kernel/.local/eval-bases/`).
- Nenhuma sessão de avaliação rodou (sem `eval/attempts/`).
- A condução (cenário C) não tem oráculo nem invólucro, e **não há script de medição de M3**: `measure-p3.mjs` reconhece
  só as sessões A e B do lote de dados.
- A "espera de fila registrada à parte" do protocolo não existe no invólucro.
- A cobertura do congelamento tem as lacunas de §2.1.3.

## 6. Pontos que só podem ser preenchidos depois do congelamento

- Commit do candidato, `dirty`, hashes das CLIs, dos kernels, da fachada e dos fragmentos, e a identidade do índice
  por faixa (do `FREEZE.json`).
- Versões efetivas do ODC Studio e do Service Studio no momento da disponibilização, e se as provas continuam atuais.
- Rota escolhida (§2.3). Se for a A: descritor, `packageId`, hash, capacidades, dependências fixadas, caminho da
  seleção e comando exato de `package mcp`. Se for a C: a entrada MCP da sessão nova.
- Resultados de M3: tarefas completas, métricas (tempo até candidato, tempo de ferramenta, chamadas, bytes, acessos a
  internals), limites de observabilidade e T3.
- Smoke combinado e recibo da ida e volta.
- Valores do guia de §3 e texto final para as sessões novas.
- Autorização do usuário e data da disponibilização.

## 7. Registro

Contribuição proposta à integradora no pedido `control/requests/C/C-011.json`. A integração do texto ao M4, a escolha
da rota, o congelamento e qualquer execução são da integradora e do usuário.
