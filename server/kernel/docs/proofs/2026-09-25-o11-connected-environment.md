# Ambiente O11 pelo Studio já logado (SSO) — prova de 2026-09-25

## Problema

O ambiente pessoal `personal-2qqw9srv.outsystemscloud.com` passou a exigir SSO. O caminho headless por usuário e senha
(`--credentials` ou cofre do Windows) foi recusado pelo servidor no handshake:

> FaultException: Server was unable to process request. ---> Invalid username or password. SSO login is mandatory.

Recibo: `.local/hanford-poc/create-app/inventory-before.json` da raiz operacional (leitura; nenhuma escrita foi enviada).
Com isso `inventory`, `download`, `create-app` e os demais comandos de ambiente do CLI O11 ficavam indisponíveis, embora
o Service Studio da faixa estivesse autenticado.

## Correção

Porte do caminho conectado que já existia no motor SS4 (`SSAM-Engine-SS4-maint`, commit `76243fd`, o mesmo código da
bridge instalada no SS4 em 2026-09-16, commit `9d111be`). Só as partes do login conectado; o resto daquele commit
(layout, HTML, frontend nativo, ACLs da bridge, fechamento de entregas) ficou de fora.

| Peça | Papel |
|---|---|
| `src/Anvil.Core/Adapters.SS11/ConnectedEnvironment.cs` | Cliente: pede um lease `environment_session` à bridge e encaminha cada operação. Sem replay de escrita com resposta perdida. |
| `src/Anvil.Core/Adapters.SS11/EnvironmentOperations.cs` | Lista fechada de operações executadas dentro do Studio (`Names`): listagens, templates, download, assinatura, salvar app, associar módulo, apagar, iniciar/acompanhar publicação. |
| `src/Anvil.Bridge/EnvironmentSessionHandler.cs` + `Dispatch.cs` + `Server.cs` + `ExportHandler.cs` | Lado do Studio: empresta a sessão do provider logado dentro do processo, revalida login/host/usuário a cada operação, registra no log só o tamanho da resposta. |
| `HeadlessSession.cs`, `Publisher.cs`, `TemplateModules.cs` | Desvios `Connected != null` antes de cada chamada ao servidor. Novo: `ConnectedOnlyClient` recusa com mensagem explícita qualquer chamada sem operação no Studio (em vez de NullReference). |
| `src/Anvil.Cli/Program.cs` `Session()` | Sem `--credentials`: sessão conectada na bridge da faixa (4516 SS4, 4536 SS5; `--bridge-port`/`ANVIL_BRIDGE_PORT`). Com `--credentials`: caminho antigo, sem mudança. |
| `scripts/anvil_cli.py` | `ensure`/`stop` do contrato da piscina (`worker_pool.py`), que só existiam no cliente ODC. Sem isso a piscina O11 não subia (`AttributeError: ensure`). |
| `platforms/odc/facade/lanes.mjs` | Entrada pública: `ssam create-app|add-modules|inventory|download --lane o11`. Na ODC os verbos recusam indicando o caminho próprio. |

A bridge instalada já tinha o lado do Studio: nenhuma DLL do Studio foi trocada (hash `8C177AC2FC84` preservado). O
código da bridge agora também está no repositório unificado para que builds futuros o mantenham.

## Aceite (fluxo completo, ambiente vivo)

CLI do checkout isolado `C:\Users\andre\SSAM-Hybrid-connected` (branch `claude/o11-connected-environment`), faixa SS4,
Studio já autenticado. Evidências em `.local/hanford-poc/sso-acceptance/` da raiz operacional.

| # | Etapa | Resultado | Evidência |
|---|---|---|---|
| 1 | Leitura conectada (`inventory --read-only`) | 141 apps, 378 módulos, 4,8 s, "no credential file" | `01-inventory-read` |
| 2 | `create-app` "HMIS JHA PoC" (`HMISJHA_CS` Service, `HMISJHA` Reactive) | App + 2 módulos preparados e publicados, sem erro; 56,7 s | `02-create-hmisjha` |
| 3 | `create-app` "Agent Operations" (`AgentOps_Model_CS`, `AgentOps_Core_CS`, `AgentOps_Sample_CS`, `AgentOps`) | 4 módulos publicados, sem erro; 74,4 s | `03-create-agentops` |
| 4 | Reconciliação | 2 apps e 6 módulos no servidor, versões 5526–5531, associados às apps | `04-inventory-after-create` |
| 5 | `download` conectado das bases | `HMISJHA_CS` v5526, `AgentOps_Model_CS` v5528 | `05-download-bases` |
| 6 | Candidatos independentes pela piscina O11 (portas próprias 15517/15617, CLI do checkout; worker operacional 14517 não usado) | 1ª rodada: os dois jobs caíram no mesmo worker (despacho sem trava, por projeto) — não contado. 2ª rodada com porta registrada: `HMISJHA_CS`→15517, `AgentOps_Model_CS`→15617, simultâneos, 3,6 s; `accepted=true`, `isValid=true`, 0 inesperadas, 0 esperadas faltando; piscina desligada | `06-pool-candidates`, `07-pool-candidates-distributed` |
| 7 | Entrega nativa (`deliver`: snapshot registrado, apply, Verify, um merge, delta) | `HMISJHA_CS` 13,2 s (task `b29c6e42…`), `AgentOps_Model_CS` 6,4 s (task `d1185626…`), `delivered=true`; `check-delivery` aceito nos dois | `08-…`, `09-…` |
| 8 | Publicação nativa do Studio (1-Click, verbo `publish` da bridge) sob a autorização registrada "Sim, publicar e validar" | `CompletedWithSuccess`, `isValid`, 6,9 s e 6,4 s; versões 5532 e 5533 | `10-publish` |
| 9 | Reconciliação do publicado | Inventário com as versões novas; download conectado; leitura: `JHAWorkflowState` com 5 registros; site properties `OpenAIApiKey` (sem valor), `OpenAIBaseUrl`, `ModelTimeoutSeconds` | `11-reconcile-published` |
| 10 | Binário final (com a guarda) | Leitura viva ok: 143 apps, 384 módulos | `12-final-binary-read` |
| 11 | Entrada pública | `ssam inventory --lane o11 --read-only` → mesma leitura, 3,5 s | `13-public-entry-inventory` |

Testes: `ConnectedEnvironmentTests` 11/11 (10 portados + a guarda). Teste da tabela de verbos do launcher aprovado. A
suíte completa O11 não foi rodada; a lane ODC não compila `Adapters.SS11` (não afetada).

## Operações que reutilizam o SSO do Studio

| Operação / comando | Situação |
|---|---|
| `inventory` (applications, modules, catalogs) | Provado ao vivo |
| `download` | Provado ao vivo |
| `create-app` (templates, template-download, application-save, module-associate, publish-start/check) | Provado ao vivo |
| `deliver` (snapshot, merge) e `publish` da bridge | Sempre usaram o Studio; provados de novo nesta sessão |
| `download-all`, `download-app`, `referenceable`, `templates`, `add-modules`, `create-module`, `update-app`, `set-user-provider`, `delete-app`, `refresh-refs`, `publish-smoke`, `edit-smoke` | Passam pelo mesmo `Session()`; toda chamada ao servidor encontrada no código (HeadlessSession, Publisher, TemplateModules) tem desvio. **Não exercitados ao vivo.** Chamada sem operação no Studio falha com `NotSupportedException` explícita |

## Lacunas restantes

1. **Dados publicados (`ssam data --lane o11` / MCP `o11_data`).** O `DataCommand` usa o cofre (usuário/senha) e não
   está neste branch: é alteração não commitada de outra sessão no checkout operacional. Pelo mesmo handshake recusado,
   deve falhar em ambientes com SSO obrigatório (inferência, não executado). Exige caminho conectado próprio para o
   cliente Edit Data.
2. **`CSharpRuntimeDelivery`** abre sessão por arquivo de credenciais. Não exercitado; mesma lacuna.
3. **Depurador headless** (`ssam debug`, trabalho não commitado de outra sessão) aceita `--credentials`. Não verificado.
4. ~~**`run_job.py`** só despacha para a piscina na faixa ODC.~~ Resolvido na versão isolada (`acefc0c`,
   `docs/VERSAO-O11-SSO.md`): com mais de um worker O11 de pé, `ssam job --lane o11` despacha para um worker livre e
   reservado. Validado pela entrada pública com dois jobs simultâneos em workers distintos.
5. **Política de publicação O11 na entrada pública:** `ssam publish --lane o11` continua recusando ("o humano publica").
   Esta prova publicou pelo verbo nativo da bridge sob autorização registrada; expor isso é decisão do usuário.
6. **Implantação operacional:** este branch não foi integrado ao checkout operacional (165 alterações não commitadas de
   outra sessão) nem ao CLI operacional (`kernel/.local/cli`, 2026-09-18), cujo build reinicia o worker 14517. As
   sessões que usam o checkout operacional só ganham o caminho após essa integração, com decisão do usuário.
   Até lá, novas sessões usam a versão isolada selecionável (`docs/VERSAO-O11-SSO.md`).

## Preservação

Checkout operacional, CLI operacional, worker 14517 (PID 24468) e instalação do SS4 (bridge `8C177AC2FC84`,
`Anvil.Core` do Studio `821359B9C858`) sem alteração. Nada executado nos checkouts do laboratório ou da avaliação.
